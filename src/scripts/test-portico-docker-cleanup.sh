#!/usr/bin/env bash

# Regression tests for portico-docker-cleanup.sh (PORTICO-205):
#   - dry-run by default, --apply to delete
#   - repo/tag identity selection (never labels)
#   - current + previous + newer-than-current release retention (tag refs,
#     including retagged builds that share one image ID)
#   - fail-closed release detection (exit 3, nothing deleted)
#   - in-use / alias / unrelated-image protections
#   - host-level OrbStack data image reporting

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLEANUP_SCRIPT="$PROJECT_ROOT/src/scripts/portico-docker-cleanup.sh"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

managed_dir="$tmp_dir/managed"
mkdir -p "$managed_dir"
printf 'name: portico\n' > "$managed_dir/docker-compose.yml"

# Realistic-shaped image IDs (sha256 + 64 hex chars).
ID_FUTURE="sha256:f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0"
ID_SAME_DAY="sha256:dada0000dada0000dada0000dada0000dada0000dada0000dada0000dada0000"
ID_CURRENT="sha256:c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1"
ID_OLD_A="sha256:a1d1a1d1a1d1a1d1a1d1a1d1a1d1a1d1a1d1a1d1a1d1a1d1a1d1a1d1a1d1a1d1"
ID_OLD_B="sha256:b2d2b2d2b2d2b2d2b2d2b2d2b2d2b2d2b2d2b2d2b2d2b2d2b2d2b2d2b2d2b2d2"
ID_USED="sha256:eeeedeeeedeeeedeeeedeeeedeeeedeeeedeeeedeeeedeeeedeeeedeeeedabcd"
ID_LOCAL="sha256:10ca110ca110ca110ca110ca110ca110ca110ca110ca110ca110ca110ca110ca"
ID_AGENT="sha256:a9e07a9e07a9e07a9e07a9e07a9e07a9e07a9e07a9e07a9e07a9e07a9e07a9e0"
ID_NGINX="sha256:0091700917009170091700917009170091700917009170091700917009170091"
ID_REBOUND="sha256:feedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed"

cat > "$tmp_dir/docker" <<SH
#!/usr/bin/env bash
set -euo pipefail

last_arg=""
prev_arg=""
for arg in "\$@"; do
  prev_arg="\$last_arg"
  last_arg="\$arg"
done

if [ "\$#" -ge 3 ] && [ "\$1" = "compose" ] && [ "\$prev_arg" = "config" ] && [ "\$last_arg" = "--images" ]; then
  if [ "\${DOCKER_FAKE_COMPOSE_FAIL:-0}" = "1" ]; then
    exit 1
  fi
  if [ "\${DOCKER_FAKE_COMPOSE_EMPTY:-0}" = "1" ]; then
    exit 0
  fi
  if [ "\${DOCKER_FAKE_COMPOSE_LOCAL:-0}" = "1" ]; then
    printf '%s\n' 'portico-mcp-orc-rust:latest'
    exit 0
  fi
  printf '%s\n' 'harbor.example.invalid/portico/mcp-orc-rust:07012026-aaaaaaaa'
  printf '%s\n' "harbor.example.invalid/portico/bifrost-bridge:\${DOCKER_FAKE_COMPOSE_SECOND_TAG:-07012026-aaaaaaaa}"
  exit 0
fi

if [ "\$#" -eq 2 ] && [ "\$1" = "compose" ] && [ "\$2" = "version" ]; then
  printf '%s\n' 'Docker Compose version v2.39.1'
  exit 0
fi

if [ "\$#" -eq 2 ] && [ "\$1" = "context" ] && [ "\$2" = "show" ]; then
  printf '%s\n' "\${DOCKER_FAKE_CONTEXT:-orbstack}"
  exit 0
fi

if [ "\$#" -ge 3 ] && [ "\$1" = "context" ] && [ "\$2" = "inspect" ]; then
  if [ "\${DOCKER_FAKE_CONTEXT_INSPECT_FAIL:-0}" = "1" ]; then
    exit 1
  fi
  printf '%s\n' "\${DOCKER_FAKE_CONTEXT_HOST:-unix://\$HOME/.orbstack/run/docker.sock}"
  exit 0
fi

if [ "\$#" -ge 4 ] && [ "\$1" = "image" ] && [ "\$2" = "ls" ]; then
  [ "\${DOCKER_FAKE_IMAGE_LIST_FAIL:-0}" = "0" ] || exit 1
  cat <<'EOF'
harbor.example.invalid/portico/mcp-orc-rust:08012026-ffffffff
harbor.example.invalid/portico/mcp-orc-rust:07012026-eeeeeeee
harbor.example.invalid/portico/mcp-orc-rust:07012026-aaaaaaaa
harbor.example.invalid/portico/mcp-orc-rust:06012026-bbbbbbbb
harbor.example.invalid/portico/mcp-orc-rust:05012026-cccccccc
harbor.example.invalid/portico/bifrost-bridge:05012026-cccccccc
harbor.example.invalid/portico/bifrost-bridge:04012026-dddddddd
portico-open-webui:old-local
agent-vm:old
agent-vm:latest
nginx:old
<none>:<none>
EOF
  exit 0
fi

if [ "\$#" -ge 5 ] && [ "\$1" = "image" ] && [ "\$2" = "inspect" ]; then
  ref="\$last_arg"
  [ "\$4" = '{{.Id}}{{"\t"}}{{.Size}}{{"\t"}}{{.Created}}' ] || {
    echo "incorrect inspect format: \$4" >&2
    exit 1
  }
  [ "\${DOCKER_FAKE_IMAGE_INSPECT_FAIL_REF:-}" != "\$ref" ] || exit 1
  if [ "\${DOCKER_FAKE_REBOUND_REF:-}" = "\$ref" ]; then
    inspect_count_file="\${DOCKER_FAKE_INSPECT_COUNT_FILE:?}"
    inspect_count=0
    [ ! -f "\$inspect_count_file" ] || inspect_count="\$(wc -l < "\$inspect_count_file" | tr -d ' ')"
    printf '%s\n' inspected >> "\$inspect_count_file"
    if [ "\$inspect_count" -gt 0 ]; then
      printf '%s\t%s\t%s\n' "$ID_REBOUND" 1000 '2026-07-17T09:00:00.000000000Z'
      exit 0
    fi
  fi
  case "\$ref" in
    harbor.example.invalid/portico/mcp-orc-rust:08012026-ffffffff)
      printf '%s\t%s\t%s\n' "$ID_FUTURE" 1500 '2026-08-01T10:00:00.000000000Z'
      ;;
    harbor.example.invalid/portico/mcp-orc-rust:07012026-eeeeeeee)
      # Prepared same-day tag with an older Created timestamp must survive.
      printf '%s\t%s\t%s\n' "$ID_SAME_DAY" 1600 '2025-01-01T01:00:00.000000000Z'
      ;;
    harbor.example.invalid/portico/mcp-orc-rust:07012026-aaaaaaaa|harbor.example.invalid/portico/mcp-orc-rust:06012026-bbbbbbbb)
      # Retag flow: the current and previous release tags share one image ID.
      printf '%s\t%s\t%s\n' "$ID_CURRENT" 2000 '2026-06-01T09:00:00.000000000Z'
      ;;
    harbor.example.invalid/portico/mcp-orc-rust:05012026-cccccccc)
      printf '%s\t%s\t%s\n' "$ID_OLD_A" 1000 '2026-05-01T09:00:00.000000000Z'
      ;;
    harbor.example.invalid/portico/bifrost-bridge:05012026-cccccccc)
      printf '%s\t%s\t%s\n' "$ID_OLD_B" 500 '2026-05-01T09:00:00.000000000Z'
      ;;
    harbor.example.invalid/portico/bifrost-bridge:04012026-dddddddd)
      printf '%s\t%s\t%s\n' "$ID_USED" 3000 '2026-04-01T09:00:00.000000000Z'
      ;;
    portico-open-webui:old-local)
      printf '%s\t%s\t%s\n' "$ID_LOCAL" 4000 '2026-03-01T09:00:00.000000000Z'
      ;;
    agent-vm:old|agent-vm:latest)
      printf '%s\t%s\t%s\n' "$ID_AGENT" 5000 '2026-03-02T09:00:00.000000000Z'
      ;;
    nginx:old)
      printf '%s\t%s\t%s\n' "$ID_NGINX" 7000 '2026-01-01T09:00:00.000000000Z'
      ;;
    '<none>:<none>')
      printf '%s\t%s\t%s\n' "sha256:da4911da4911da4911da4911da4911da4911da4911da4911da4911da4911dada" 800 '2026-02-01T09:00:00.000000000Z'
      ;;
    *)
      exit 1
      ;;
  esac
  exit 0
fi

if [ "\$#" -eq 3 ] && [ "\$1" = "image" ] && [ "\$2" = "rm" ]; then
  printf '%s\n' "\$3" >> "\${DOCKER_FAKE_DELETE_LOG:?}"
  for fail_ref in \${DOCKER_FAKE_RM_FAIL_REFS:-}; do
    if [ "\$3" = "\$fail_ref" ]; then
      echo "Error response from daemon: conflict" >&2
      exit 1
    fi
  done
  exit 0
fi

if [ "\$#" -eq 2 ] && [ "\$1" = "ps" ] && [ "\$2" = "-aq" ]; then
  [ "\${DOCKER_FAKE_CONTAINER_LIST_FAIL:-0}" = "0" ] || exit 1
  printf '%s\n' 'container-1'
  exit 0
fi

if [ "\$#" -eq 2 ] && [ "\$1" = "system" ] && [ "\$2" = "df" ]; then
  printf '%s\n' 'TYPE  TOTAL  ACTIVE  SIZE  RECLAIMABLE'
  exit 0
fi

if [ "\$#" -ge 4 ] && [ "\$1" = "inspect" ]; then
  [ "\${DOCKER_FAKE_CONTAINER_INSPECT_FAIL:-0}" = "0" ] || exit 1
  printf '%s\n' "$ID_USED"
  exit 0
fi

echo "unexpected docker invocation: \$*" >&2
exit 1
SH
chmod +x "$tmp_dir/docker"

delete_log="$tmp_dir/deleted.txt"
inspect_count_file="$tmp_dir/inspect-count.txt"

run_cleanup() {
  : > "$delete_log"
  rm -f "$inspect_count_file"
  PATH="$tmp_dir:$PATH" \
  DOCKER_HOST="${TEST_DOCKER_HOST:-}" \
  PORTICO_MANAGED_DIR="${TEST_MANAGED_DIR:-$managed_dir}" \
  DOCKER_FAKE_DELETE_LOG="$delete_log" \
  DOCKER_FAKE_INSPECT_COUNT_FILE="$inspect_count_file" \
  bash "$CLEANUP_SCRIPT" "$@" > "$tmp_dir/out.txt" 2> "$tmp_dir/err.txt"
}

expect_in_output() {
  grep -Fq "$1" "$tmp_dir/out.txt" || fail "$2 (missing output: $1)"
}

expect_not_deleted() {
  if grep -Fq "$1" "$delete_log"; then
    fail "$2 (unexpectedly deleted: $1)"
  fi
}

expect_deleted() {
  grep -Fxq "$1" "$delete_log" || fail "$2 (expected deletion of: $1)"
}

# ---------------------------------------------------------------------------
# 1. Dry run is the default: full report, nothing deleted.
# ---------------------------------------------------------------------------
run_cleanup || fail "dry run should exit 0 (rc=$?)"
expect_in_output "Mode: DRY RUN" "dry run banner"
expect_in_output "Release retention: current=07012026-aaaaaaaa previous=06012026-bbbbbbbb" \
  "current+previous release detection"
expect_in_output "Old unused Portico image tags found: 4" "candidate count"
expect_in_output "Image objects that can reclaim space: 3" "reclaimable object count"
expect_in_output "Tag-only aliases with no unique reclaimable bytes: 1" "tag-only count"
expect_in_output "Estimated reclaimable space: 5.37 KB (5500 bytes)" "reclaim estimate"
expect_in_output "Dry run complete. No Docker images were deleted." "dry-run completion line"
[ ! -s "$delete_log" ] || fail "dry run must not delete anything"

if awk '/Image tags selected for cleanup:/,0' "$tmp_dir/out.txt" | grep -Fq "08012026-ffffffff"; then
  fail "future release tag must not be a cleanup candidate"
fi
if awk '/Image tags selected for cleanup:/,0' "$tmp_dir/out.txt" | grep -Fq "04012026-dddddddd"; then
  fail "container-used image must not be a cleanup candidate"
fi

# ---------------------------------------------------------------------------
# 2. --apply deletes exactly the expected refs.
# ---------------------------------------------------------------------------
run_cleanup --apply || fail "--apply should exit 0"
expect_in_output "Mode: APPLY" "apply banner"
expect_deleted "harbor.example.invalid/portico/mcp-orc-rust:05012026-cccccccc" "old release (mcp-orc-rust)"
expect_deleted "harbor.example.invalid/portico/bifrost-bridge:05012026-cccccccc" "old release (bifrost-bridge)"
expect_deleted "portico-open-webui:old-local" "undated local image"
expect_deleted "agent-vm:old" "undated tag-only alias"
deleted_count="$(wc -l < "$delete_log" | tr -d ' ')"
[ "$deleted_count" = "4" ] || fail "expected exactly 4 deletions, got $deleted_count"
expect_in_output "Reclaimed (Docker-reported image bytes): 5.37 KB (5500 bytes)" "actual reclaim accounting"

# Retention: current, previous (shared image ID with current), and
# newer-than-current tags are never deleted; in-use and unrelated skipped.
expect_not_deleted "07012026-aaaaaaaa" "current release tag retained"
expect_not_deleted "06012026-bbbbbbbb" "previous release tag retained despite shared image ID"
expect_not_deleted "08012026-ffffffff" "newer-than-current tag retained"
expect_not_deleted "07012026-eeeeeeee" "same-day prepared tag retained regardless of Created time"
expect_not_deleted "04012026-dddddddd" "in-use image skipped"
expect_not_deleted "agent-vm:latest" "latest alias skipped"
expect_not_deleted "nginx:old" "unrelated image skipped"
expect_not_deleted "<none>" "dangling image skipped"

# Exact transition mode validates both managed sources and protects exactly
# the audited previous tag, while allowing an intermediate heuristic tag to
# be reclaimed.
mkdir -p "$managed_dir/electron-app"
printf '{"buildNumber":"07012026-aaaaaaaa"}\n' > "$managed_dir/electron-app/build-info.json"
run_cleanup --apply --expected-current-tag 07012026-aaaaaaaa \
  --expected-previous-tag 05012026-cccccccc \
  || fail "exact transition cleanup should exit 0"
expect_not_deleted "05012026-cccccccc" "exact previous release retained"
expect_deleted "harbor.example.invalid/portico/mcp-orc-rust:06012026-bbbbbbbb" \
  "intermediate heuristic tag is not treated as exact previous"

for args in \
  "--expected-current-tag 07012026-aaaaaaaa" \
  "--expected-current-tag invalid --expected-previous-tag 05012026-cccccccc" \
  "--expected-current-tag 07012026-aaaaaaaa --expected-previous-tag 07012026-aaaaaaaa"; do
  rc=0
  # shellcheck disable=SC2086
  run_cleanup --apply $args || rc=$?
  [ "$rc" = "2" ] || fail "invalid exact arguments must exit 2 (args=$args rc=$rc)"
  [ ! -s "$delete_log" ] || fail "invalid exact arguments must not delete"
done

printf '{"buildNumber":"06012026-bbbbbbbb"}\n' > "$managed_dir/electron-app/build-info.json"
rc=0
run_cleanup --apply --expected-current-tag 07012026-aaaaaaaa \
  --expected-previous-tag 05012026-cccccccc || rc=$?
[ "$rc" = "3" ] || fail "build-info mismatch must fail closed"
[ ! -s "$delete_log" ] || fail "build-info mismatch must not delete"
printf '{"buildNumber":"07012026-aaaaaaaa"}\n' > "$managed_dir/electron-app/build-info.json"
rc=0
DOCKER_FAKE_COMPOSE_SECOND_TAG=06012026-bbbbbbbb run_cleanup --apply \
  --expected-current-tag 07012026-aaaaaaaa --expected-previous-tag 05012026-cccccccc || rc=$?
[ "$rc" = "3" ] || fail "mixed-release compose must fail closed"
[ ! -s "$delete_log" ] || fail "mixed-release compose must not delete"
rm -rf "$managed_dir/electron-app"

# ---------------------------------------------------------------------------
# 3. Failed deletion: exit 1, failed object excluded from actual reclaim.
# ---------------------------------------------------------------------------
rc=0
DOCKER_FAKE_RM_FAIL_REFS="harbor.example.invalid/portico/mcp-orc-rust:05012026-cccccccc" \
  run_cleanup --apply || rc=$?
[ "$rc" = "1" ] || fail "failed deletion should exit 1 (rc=$rc)"
expect_in_output "Reclaimed (Docker-reported image bytes): 4.39 KB (4500 bytes)" \
  "failed deletions excluded from actual reclaim"
expect_in_output "Failed to delete image tags: 1" "failure count reported"

# ---------------------------------------------------------------------------
# 4. Fail closed: release detection failures delete nothing and exit 3.
# ---------------------------------------------------------------------------
rc=0
TEST_MANAGED_DIR="$tmp_dir/does-not-exist" run_cleanup --apply || rc=$?
[ "$rc" = "3" ] || fail "missing managed dir must exit 3 (rc=$rc)"
grep -Fq "FAIL-CLOSED" "$tmp_dir/err.txt" || fail "missing managed dir must report FAIL-CLOSED"
grep -Fq "managed runtime directory not found" "$tmp_dir/err.txt" \
  || fail "missing managed dir message must name the check"
[ ! -s "$delete_log" ] || fail "missing managed dir must not delete anything"

rc=0
DOCKER_FAKE_COMPOSE_FAIL=1 run_cleanup --apply || rc=$?
[ "$rc" = "3" ] || fail "compose config failure must exit 3 (rc=$rc)"
grep -Fq "could not resolve the managed compose image set" "$tmp_dir/err.txt" \
  || fail "compose failure message must name the check"
[ ! -s "$delete_log" ] || fail "compose config failure must not delete anything"

rc=0
DOCKER_FAKE_COMPOSE_EMPTY=1 run_cleanup --apply || rc=$?
[ "$rc" = "3" ] || fail "empty compose image set must exit 3 (rc=$rc)"
grep -Fq "compose image set is empty" "$tmp_dir/err.txt" \
  || fail "empty compose message must name the check"
[ ! -s "$delete_log" ] || fail "empty compose image set must not delete anything"

for failure in \
  "DOCKER_FAKE_IMAGE_LIST_FAIL=1" \
  "DOCKER_FAKE_IMAGE_INSPECT_FAIL_REF=nginx:old" \
  "DOCKER_FAKE_CONTAINER_LIST_FAIL=1" \
  "DOCKER_FAKE_CONTAINER_INSPECT_FAIL=1"; do
  rc=0
  case "$failure" in
    DOCKER_FAKE_IMAGE_LIST_FAIL=*) DOCKER_FAKE_IMAGE_LIST_FAIL=1 run_cleanup --apply || rc=$? ;;
    DOCKER_FAKE_IMAGE_INSPECT_FAIL_REF=*) DOCKER_FAKE_IMAGE_INSPECT_FAIL_REF=nginx:old run_cleanup --apply || rc=$? ;;
    DOCKER_FAKE_CONTAINER_LIST_FAIL=*) DOCKER_FAKE_CONTAINER_LIST_FAIL=1 run_cleanup --apply || rc=$? ;;
    DOCKER_FAKE_CONTAINER_INSPECT_FAIL=*) DOCKER_FAKE_CONTAINER_INSPECT_FAIL=1 run_cleanup --apply || rc=$? ;;
  esac
  [ "$rc" = "3" ] || fail "incomplete apply inventory must exit 3 ($failure rc=$rc)"
  [ ! -s "$delete_log" ] || fail "incomplete apply inventory must not delete ($failure)"
done

rc=0
DOCKER_FAKE_REBOUND_REF=harbor.example.invalid/portico/mcp-orc-rust:05012026-cccccccc \
  run_cleanup --apply || rc=$?
[ "$rc" = "3" ] || fail "a tag rebound after inventory must fail closed (rc=$rc)"
[ ! -s "$delete_log" ] || fail "a tag rebound after inventory must not delete anything"
grep -Fq "image ref was rebound before cleanup" "$tmp_dir/err.txt" \
  || fail "rebound tag failure must identify the safety check"

rc=0
TEST_DOCKER_HOST="tcp://127.0.0.1:2375" run_cleanup --apply || rc=$?
[ "$rc" = "1" ] || fail "set DOCKER_HOST must exit 1 before cleanup (rc=$rc)"
grep -Fq "DOCKER_HOST is set" "$tmp_dir/err.txt" || fail "DOCKER_HOST refusal missing"
[ ! -s "$delete_log" ] || fail "set DOCKER_HOST must not delete anything"

for remote_context_host in "tcp://remote-docker.example:2375" "ssh://builder.example"; do
  rc=0
  DOCKER_FAKE_CONTEXT_HOST="$remote_context_host" run_cleanup --apply || rc=$?
  [ "$rc" = "1" ] || fail "remote Docker context host must exit 1 ($remote_context_host, rc=$rc)"
  grep -Fq "not a local Unix socket" "$tmp_dir/err.txt" \
    || fail "remote Docker context host refusal missing for $remote_context_host"
  [ ! -s "$delete_log" ] || fail "remote Docker context host must not delete anything ($remote_context_host)"
done

# ---------------------------------------------------------------------------
# 5. Local ':latest' install without build metadata: two newest release tags
#    are retained (conservative fallback).
# ---------------------------------------------------------------------------
rc=0
DOCKER_FAKE_COMPOSE_LOCAL=1 run_cleanup --apply || rc=$?
[ "$rc" = "0" ] || fail "local-mode apply should exit 0 (rc=$rc)"
expect_in_output "Release retention fallback: keeping the two newest local release tags:" \
  "local-mode fallback banner"
expect_not_deleted "08012026-ffffffff" "local mode retains newest release tag"
expect_not_deleted "07012026-aaaaaaaa" "local mode retains second-newest release tag"
expect_deleted "harbor.example.invalid/portico/mcp-orc-rust:05012026-cccccccc" \
  "local mode still reclaims old releases"

# ---------------------------------------------------------------------------
# 6. Local ':latest' install WITH build-info.json: buildNumber resolves the
#    current release, previous release stays protected.
# ---------------------------------------------------------------------------
mkdir -p "$managed_dir/electron-app"
printf '{"buildNumber":"07012026-aaaaaaaa","channel":"portico_beta"}\n' \
  > "$managed_dir/electron-app/build-info.json"
rc=0
DOCKER_FAKE_COMPOSE_LOCAL=1 run_cleanup --apply || rc=$?
[ "$rc" = "0" ] || fail "build-info fallback apply should exit 0 (rc=$rc)"
expect_in_output "Release retention: current=07012026-aaaaaaaa previous=06012026-bbbbbbbb" \
  "build-info buildNumber resolves current release"
expect_not_deleted "06012026-bbbbbbbb" "previous release retained via build-info fallback"
rm -rf "$managed_dir/electron-app"

# ---------------------------------------------------------------------------
# 7. Usage errors and host-level reporting.
# ---------------------------------------------------------------------------
rc=0
run_cleanup --nonsense || rc=$?
[ "$rc" = "2" ] || fail "unknown argument must exit 2 (rc=$rc)"
[ ! -s "$delete_log" ] || fail "usage error must not delete anything"

printf 'sparse-image-bytes' > "$tmp_dir/data.img.raw"
rc=0
portico_ORBSTACK_DATA_IMG="$tmp_dir/data.img.raw" run_cleanup || rc=$?
[ "$rc" = "0" ] || fail "host-level report run should exit 0 (rc=$rc)"
grep -Eq "macOS host-level OrbStack data image \(before\): .*allocated" "$tmp_dir/out.txt" \
  || fail "host-level allocation line missing"

rc=0
portico_ORBSTACK_DATA_IMG="$tmp_dir/missing.img.raw" run_cleanup || rc=$?
[ "$rc" = "0" ] || fail "missing data image must not fail the run (rc=$rc)"
expect_in_output "macOS host-level OrbStack data image (before): n/a" "host-level n/a line"

echo "portico-docker-cleanup retention, fail-closed, and dry-run/apply behavior looks correct."
