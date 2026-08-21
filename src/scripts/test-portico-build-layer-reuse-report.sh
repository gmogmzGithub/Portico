#!/usr/bin/env bash

# Regression tests for portico-build-layer-reuse-report.sh (PORTICO-205 Phase 2) and
# its opt-in build_docker_images.sh hook (portico_BUILD_LAYER_REPORT=1):
#   - analyze: per-file vertex scoping, all BuildKit header forms (named /
#     unnamed stage, with / without platform), FROM classified as "base"
#     (never a miss), first-miss detection, sed image-name prefixes,
#     internal/auth/ERROR vertices, failed attempt + retry independence
#   - snapshot/diff: builder-scoped `buildx du` (summary AND --verbose),
#     end-anchored docker system df parsing, SI size parsing, exact host
#     data.img.raw byte deltas via portico_ORBSTACK_DATA_IMG
#   - usage errors exit 2; missing docker degrades gracefully
#   - hook: default OFF (zero docker df/du calls), opt-in produces
#     before/after snapshots + analysis + diff in a durable report dir,
#     builder name propagation, report survives build failure via the EXIT
#     trap, retag-only mode never snapshots, missing script warns non-fatally

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REPORT_SCRIPT="$PROJECT_ROOT/src/scripts/portico-build-layer-reuse-report.sh"
BUILD_SCRIPT="$PROJECT_ROOT/build_docker_images.sh"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

# --- analyze fixtures ---------------------------------------------------------

fixtures="$tmp_dir/fixtures"
mkdir -p "$fixtures"

# Warm multi-stage build: FROM resolves as DONE 0.0s (normal), everything else
# CACHED -> must report FULL cache reuse with zero misses.
cat > "$fixtures/warm.log" <<'EOF'
#1 [internal] load build definition from Dockerfile
#1 transferring dockerfile: 2.5kB done
#1 DONE 0.0s
#2 [auth] library/node:pull token for registry-1.docker.io
#3 [frontend-builder 1/4] FROM docker.io/library/node:20-slim@sha256:abc
#3 resolve docker.io/library/node:20-slim done
#3 DONE 0.0s
#4 [frontend-builder 2/4] COPY .npmrc /etc/npmrc
#4 CACHED
#5 [frontend-builder 3/4] RUN npm ci
#5 CACHED
#6 [frontend-builder 4/4] RUN npm run build
#6 CACHED
#7 [stage-1 1/2] FROM docker.io/library/python:3.11-slim
#7 DONE 0.0s
#8 [stage-1 2/2] COPY --from=frontend-builder /build/build /app/build
#8 CACHED
EOF

# Mid-stage miss after cached steps, with the build_docker_images.sh sed
# prefix on every line.
cat > "$fixtures/prefixed-miss.log" <<'EOF'
[open-webui-patched] #1 [internal] load build definition from Dockerfile
[open-webui-patched] #1 DONE 0.0s
[open-webui-patched] #3 [frontend-builder 1/5] FROM docker.io/library/node:20-slim
[open-webui-patched] #3 DONE 0.0s
[open-webui-patched] #4 [frontend-builder 2/5] COPY .npmrc /etc/npmrc
[open-webui-patched] #4 CACHED
[open-webui-patched] #5 [frontend-builder 3/5] RUN npm ci
[open-webui-patched] #5 CACHED
[open-webui-patched] #6 [frontend-builder 4/5] COPY src/patches/frontend/ /build/
[open-webui-patched] #6 DONE 1.5s
[open-webui-patched] #7 [frontend-builder 5/5] RUN npm run build
[open-webui-patched] #7 0.512 vite build output
[open-webui-patched] #7 DONE 240.5s
EOF

# Multi-arch with unnamed stages: platform-tagged vertices, no stage name.
cat > "$fixtures/multiarch-unnamed.log" <<'EOF'
#1 [internal] load build definition from Dockerfile
#1 DONE 0.0s
#3 [linux/arm64 1/3] FROM docker.io/library/alpine:3.19
#3 DONE 0.0s
#4 [linux/arm64 2/3] COPY a.txt /a.txt
#4 CACHED
#5 [linux/arm64 3/3] RUN echo hi
#5 CACHED
#6 [linux/amd64 1/3] FROM docker.io/library/alpine:3.19
#6 DONE 0.0s
#7 [linux/amd64 2/3] COPY a.txt /a.txt
#7 DONE 0.2s
#8 [linux/amd64 3/3] RUN echo hi
#8 DONE 0.4s
EOF

# Failed attempt: an ERROR vertex must count as executed, not corrupt tables.
cat > "$fixtures/attempt-1-failed.log" <<'EOF'
#1 [internal] load build definition from Dockerfile
#1 DONE 0.0s
#3 [builder 1/3] FROM docker.io/library/node:20-slim
#3 DONE 0.0s
#4 [builder 2/3] COPY package.json /app/
#4 CACHED
#5 [builder 3/3] RUN npm ci
#5 ERROR: process "/bin/sh -c npm ci" did not complete successfully
EOF

# Retry attempt reusing the SAME vertex numbers: per-file scoping means the
# earlier failed attempt must not contaminate this one.
cat > "$fixtures/attempt-2-ok.log" <<'EOF'
#1 [internal] load build definition from Dockerfile
#1 DONE 0.0s
#3 [builder 1/3] FROM docker.io/library/node:20-slim
#3 DONE 0.0s
#4 [builder 2/3] COPY package.json /app/
#4 CACHED
#5 [builder 3/3] RUN npm ci
#5 DONE 60.0s
EOF

out="$(bash "$REPORT_SCRIPT" analyze "$fixtures/warm.log")"
echo "$out" | grep -q "cache reuse: FULL" \
  || fail "warm build must report FULL cache reuse (FROM DONE 0.0s is not a miss)"
echo "$out" | grep -q "stage frontend-builder: steps=3 cached=3 executed=0 base=1" \
  || fail "warm build frontend-builder counts wrong: $out"
echo "$out" | grep -q "internal/auth vertices: 2" \
  || fail "internal/auth vertices must be counted separately"
! echo "$out" | grep -q "FIRST MISS" \
  || fail "warm build must have no first-miss"

out="$(bash "$REPORT_SCRIPT" analyze "$fixtures/prefixed-miss.log")"
echo "$out" | grep -q "FIRST MISS at step 4 (DONE): COPY src/patches/frontend/ /build/" \
  || fail "prefixed log: first miss must be the patches COPY at step 4: $out"
echo "$out" | grep -q "steps=4 cached=2 executed=2" \
  || fail "prefixed log: counts wrong: $out"

out="$(bash "$REPORT_SCRIPT" analyze "$fixtures/multiarch-unnamed.log")"
echo "$out" | grep -q "stage (default) \[linux/arm64\]: steps=2 cached=2 executed=0 base=1" \
  || fail "multiarch arm64 unnamed-stage counts wrong: $out"
echo "$out" | grep -q "stage (default) \[linux/amd64\]: steps=2 cached=0 executed=2 base=1" \
  || fail "multiarch amd64 unnamed-stage counts wrong: $out"
echo "$out" | grep -q "FIRST MISS at step 2 (DONE): COPY a.txt /a.txt" \
  || fail "multiarch amd64 first miss wrong: $out"

# Both attempts analyzed together: vertex #5 exists in BOTH files with
# different outcomes; each file must be reported independently.
out="$(bash "$REPORT_SCRIPT" analyze "$fixtures/attempt-1-failed.log" "$fixtures/attempt-2-ok.log")"
echo "$out" | grep -q "FIRST MISS at step 3 (ERROR): RUN npm ci" \
  || fail "failed attempt must surface the ERROR vertex as its miss: $out"
echo "$out" | grep -q "FIRST MISS at step 3 (DONE): RUN npm ci" \
  || fail "retry attempt must be analyzed independently of the failed one: $out"

# analyze --out writes a durable copy.
bash "$REPORT_SCRIPT" analyze "$fixtures/warm.log" --out "$tmp_dir/report-out" >/dev/null
grep -q "cache reuse: FULL" "$tmp_dir/report-out/layer-reuse-analysis.txt" \
  || fail "analyze --out must write layer-reuse-analysis.txt"

# --- usage / error handling ---------------------------------------------------

rc=0; bash "$REPORT_SCRIPT" analyze >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 2 ] || fail "analyze without logs must exit 2 (got $rc)"
rc=0; bash "$REPORT_SCRIPT" analyze "$tmp_dir/does-not-exist.log" >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 2 ] || fail "analyze with unreadable log must exit 2 (got $rc)"
rc=0; bash "$REPORT_SCRIPT" bogus-command >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 2 ] || fail "unknown command must exit 2 (got $rc)"
rc=0; bash "$REPORT_SCRIPT" diff "$tmp_dir/nope-a" "$tmp_dir/nope-b" >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 2 ] || fail "diff with missing snapshot dirs must exit 2 (got $rc)"

# --- snapshot / diff with a fake docker ----------------------------------------

fake_bin="$tmp_dir/bin"
mkdir -p "$fake_bin"
cat > "$fake_bin/df" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
cat <<'DF'
Filesystem 1024-blocks Used Available Capacity Mounted on
fixture 104857600 0 104857600 0% /
DF
SH
chmod +x "$fake_bin/df"
cat > "$fake_bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
echo "docker $*" >> "${FAKE_DOCKER_LOG:?}"
if [ "${1:-}" = "system" ] && [ "${2:-}" = "df" ]; then
  cat <<'DF'
TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE
Images          79        12        97.31GB   57.48GB (59%)
Containers      15        15        86.47MB   0B (0%)
Local Volumes   14        5         1.813GB   1.214GB (66%)
Build Cache     406       0         44.08GB   23.13GB (52%)
DF
  exit 0
fi
if [ "${1:-}" = "buildx" ] && [ "${2:-}" = "du" ]; then
  cat <<'DU'
ID              RECLAIMABLE     SIZE    LAST ACCESSED
abc             true            1.2GB   2 days ago
Shared:         5.0GB
Private:        39.08GB
Reclaimable:    44.08GB
Total:          44.08GB
DU
  exit 0
fi
exit 1
SH
chmod +x "$fake_bin/docker"

export FAKE_DOCKER_LOG="$tmp_dir/docker-calls.log"
: > "$FAKE_DOCKER_LOG"

fake_img="$tmp_dir/fake-data.img"
dd if=/dev/zero of="$fake_img" bs=1024 count=2048 2>/dev/null

PATH="$fake_bin:$PATH" portico_ORBSTACK_DATA_IMG="$fake_img" \
  bash "$REPORT_SCRIPT" snapshot "$tmp_dir/snap-a" --builder test-builder >/dev/null

grep -q "docker buildx du --builder test-builder$" "$FAKE_DOCKER_LOG" \
  || fail "snapshot must pass --builder to the summary buildx du"
grep -q "docker buildx du --builder test-builder --verbose$" "$FAKE_DOCKER_LOG" \
  || fail "snapshot must pass --builder to the --verbose buildx du"
grep -q "allocated_kib: 2048" "$tmp_dir/snap-a/host-data-img.txt" \
  || fail "snapshot must record the fake data image allocated KiB"

# Recreate the fake data image at 4 MiB and snapshot again. Rewriting the
# existing file in place can retain extra copy-on-write allocation blocks on
# APFS, making the fixture's `du` delta larger than the logical 2 MiB growth.
rm -f "$fake_img"
dd if=/dev/zero of="$fake_img" bs=1024 count=4096 2>/dev/null
PATH="$fake_bin:$PATH" portico_ORBSTACK_DATA_IMG="$fake_img" \
  bash "$REPORT_SCRIPT" snapshot "$tmp_dir/snap-b" --builder test-builder >/dev/null

out="$(bash "$REPORT_SCRIPT" diff "$tmp_dir/snap-a" "$tmp_dir/snap-b")"
echo "$out" | grep -q "host data.img.raw allocated.*delta=2.10 MB (2097152 bytes)" \
  || fail "diff must report the exact 2 MiB host delta: $out"
echo "$out" | grep -q "docker images size.*delta=0.00 B (0 bytes)" \
  || fail "diff must parse the Images df row end-anchored: $out"
echo "$out" | grep -q "docker build cache (default).*delta=0.00 B (0 bytes)" \
  || fail "diff must parse the two-word Build Cache df row: $out"
echo "$out" | grep -q "buildx builder cache total.*delta=0.00 B (0 bytes)" \
  || fail "diff must parse the buildx du Total line: $out"

# Snapshot without docker degrades gracefully (still records host data).
# A fake `docker` that always fails simulates an absent/broken engine while
# keeping coreutils on PATH.
no_docker_bin="$tmp_dir/no-docker-bin"
mkdir -p "$no_docker_bin"
printf '#!/usr/bin/env bash\nexit 127\n' > "$no_docker_bin/docker"
chmod +x "$no_docker_bin/docker"
PATH="$no_docker_bin:$PATH" portico_ORBSTACK_DATA_IMG="$fake_img" \
  bash "$REPORT_SCRIPT" snapshot "$tmp_dir/snap-nodocker" >/dev/null 2>&1 \
  || fail "snapshot must succeed without docker"
grep -q "unavailable" "$tmp_dir/snap-nodocker/docker-system-df.txt" \
  || fail "snapshot without docker must mark df unavailable"
grep -q "allocated_kib: 4096" "$tmp_dir/snap-nodocker/host-data-img.txt" \
  || fail "snapshot without docker must still record host data"

# --- build_docker_images.sh hook -----------------------------------------------

make_fake_build_docker() {
  cat > "$fake_bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
echo "docker $*" >> "${FAKE_DOCKER_LOG:?}"

case "${1:-}" in
  info) exit 0 ;;
  pull) exit 0 ;;
  system)
    [ "${2:-}" = "df" ] || exit 1
    printf 'TYPE   TOTAL  ACTIVE  SIZE   RECLAIMABLE\nImages 1 1 1.0GB 0B (0%%)\nBuild Cache 1 0 2.0GB 0B (0%%)\n'
    exit 0
    ;;
  buildx)
    case "${2:-}" in
      inspect) exit 0 ;;
      create|use) exit 0 ;;
      du)
        printf 'Total:  3.0GB\n'
        exit 0
        ;;
      build)
        if [ "${FAKE_BUILD_FAIL:-0}" = "1" ]; then
          printf '#1 [internal] load build definition from Dockerfile\n'
          printf '#1 DONE 0.0s\n'
          printf '#2 [1/2] FROM docker.io/library/python:3.12-slim\n'
          printf '#2 DONE 0.0s\n'
          printf 'ERROR: dockerfile parse error on line 3\n'
          exit 1
        fi
        printf '#1 [internal] load build definition from Dockerfile\n'
        printf '#1 DONE 0.0s\n'
        printf '#2 [1/2] FROM docker.io/library/python:3.12-slim\n'
        printf '#2 DONE 0.0s\n'
        printf '#3 [2/2] RUN pip install nothing\n'
        printf '#3 CACHED\n'
        exit 0
        ;;
      imagetools)
        if [ "${3:-}" = "inspect" ] && [ "${4:-}" = "--raw" ]; then
          exit 1
        fi
        if [ "${3:-}" = "inspect" ]; then
          printf 'linux/amd64\nlinux/arm64\n'
          exit 0
        fi
        if [ "${3:-}" = "create" ]; then
          exit 0
        fi
        exit 1
        ;;
    esac
    exit 1
    ;;
esac
exit 1
SH
  chmod +x "$fake_bin/docker"
}

run_build() {
  # $1 = extra env assignment string, remaining args appended to the command.
  local report_flag="$1"
  shift
  (
    cd "$PROJECT_ROOT"
    PATH="$fake_bin:$PATH" \
    TMPDIR="$hook_tmp" \
    portico_BUILD_LAYER_REPORT="$report_flag" \
    DOCKER_BUILD_MIN_FREE_GB=50 \
    DOCKER_BUILD_RETRY_DELAY_SECONDS=0 \
    bash "$BUILD_SCRIPT" "$@"
  )
}

REVISION="deadbeefcafefeeddeadbeefcafefeeddeadbeef"

# 1. Default OFF: no snapshots, no layer-report directory.
make_fake_build_docker
hook_tmp="$tmp_dir/hook-off"; mkdir -p "$hook_tmp"
: > "$FAKE_DOCKER_LOG"
run_build 0 03122026-deadbeef --images agent-vm --source-revision "$REVISION" \
  > "$hook_tmp/output.log" 2>&1 \
  || fail "default-off build should succeed: $(tail -5 "$hook_tmp/output.log")"
! grep -q "docker system df" "$FAKE_DOCKER_LOG" \
  || fail "default-off build must not take snapshots"
[ -z "$(find "$hook_tmp" -maxdepth 1 -name 'portico-layer-report.*' -print -quit)" ] \
  || fail "default-off build must not create a layer-report directory"

# 2. Opt-in: before/after snapshots, analysis, diff, durable report dir,
#    builder name propagated to buildx du.
hook_tmp="$tmp_dir/hook-on"; mkdir -p "$hook_tmp"
: > "$FAKE_DOCKER_LOG"
run_build 1 03122026-deadbeef --images agent-vm --source-revision "$REVISION" \
  > "$hook_tmp/output.log" 2>&1 \
  || fail "opt-in build should succeed: $(tail -5 "$hook_tmp/output.log")"
report_dir="$(find "$hook_tmp" -maxdepth 1 -name 'portico-layer-report.*' -print -quit)"
[ -n "$report_dir" ] || fail "opt-in build must create a durable layer-report directory"
[ -f "$report_dir/before/docker-system-df.txt" ] || fail "opt-in build must take a before snapshot"
[ -f "$report_dir/after/docker-system-df.txt" ] || fail "opt-in build must take an after snapshot"
[ -f "$report_dir/layer-reuse-analysis.txt" ] || fail "opt-in build must write the analysis report"
grep -q "cache reuse: FULL" "$report_dir/layer-reuse-analysis.txt" \
  || fail "opt-in analysis must parse the fake buildx plain output"
[ -f "$report_dir/layer-reuse-diff.txt" ] || fail "opt-in build must write the diff report"
grep -q "docker buildx du --builder portico-multiarch-v030 --verbose" "$FAKE_DOCKER_LOG" \
  || fail "opt-in snapshots must be builder-scoped"
grep -q "Layer-cache reuse report preserved at:" "$hook_tmp/output.log" \
  || fail "opt-in build must print the report location"

# 3. Build failure: the EXIT trap must still finalize the report.
hook_tmp="$tmp_dir/hook-fail"; mkdir -p "$hook_tmp"
: > "$FAKE_DOCKER_LOG"
rc=0
FAKE_BUILD_FAIL=1 run_build 1 03122026-deadbeef --images agent-vm --source-revision "$REVISION" \
  > "$hook_tmp/output.log" 2>&1 || rc=$?
[ "$rc" -ne 0 ] || fail "failing build scenario should exit non-zero"
report_dir="$(find "$hook_tmp" -maxdepth 1 -name 'portico-layer-report.*' -print -quit)"
[ -n "$report_dir" ] || fail "failed build must still create the layer-report directory"
[ -f "$report_dir/after/docker-system-df.txt" ] \
  || fail "failed build must still take the after snapshot (EXIT trap)"
[ -f "$report_dir/layer-reuse-analysis.txt" ] \
  || fail "failed build must still analyze the preserved attempt logs"

# 4. Retag-only mode: opt-in flag set, but no snapshots are taken.
hook_tmp="$tmp_dir/hook-retag"; mkdir -p "$hook_tmp"
: > "$FAKE_DOCKER_LOG"
run_build 1 --retag-only 03122026-deadbeef 04122026-cafebabe \
  > "$hook_tmp/output.log" 2>&1 \
  || fail "retag-only build should succeed: $(tail -5 "$hook_tmp/output.log")"
! grep -q "docker system df" "$FAKE_DOCKER_LOG" \
  || fail "retag-only mode must not take snapshots"

# 5. Missing report script warns but does not fail the build.
hook_tmp="$tmp_dir/hook-missing"; mkdir -p "$hook_tmp"
staged="$tmp_dir/staged-project"
mkdir -p "$staged/src/scripts"
cp "$BUILD_SCRIPT" "$staged/build_docker_images.sh"
cp "$PROJECT_ROOT/src/scripts/mcp-orc-backend.sh" "$staged/src/scripts/mcp-orc-backend.sh"
mkdir -p "$staged/electron-app/assets"
cp "$PROJECT_ROOT/Dockerfile.agent-vm" "$staged/Dockerfile.agent-vm" 2>/dev/null || true
: > "$FAKE_DOCKER_LOG"
(
  cd "$staged"
  PATH="$fake_bin:$PATH" \
  TMPDIR="$hook_tmp" \
  portico_BUILD_LAYER_REPORT=1 \
  DOCKER_BUILD_MIN_FREE_GB=50 \
  DOCKER_BUILD_RETRY_DELAY_SECONDS=0 \
  bash ./build_docker_images.sh 03122026-deadbeef --images agent-vm --source-revision "$REVISION"
) > "$hook_tmp/output.log" 2>&1 \
  || fail "build with a missing report script should still succeed: $(tail -5 "$hook_tmp/output.log")"
grep -q "portico_BUILD_LAYER_REPORT=1 but .* is missing" "$hook_tmp/output.log" \
  || fail "missing report script must produce a warning"
! grep -q "docker system df" "$FAKE_DOCKER_LOG" \
  || fail "missing report script must skip snapshots"

echo "PASS: portico-build-layer-reuse-report regression tests"
