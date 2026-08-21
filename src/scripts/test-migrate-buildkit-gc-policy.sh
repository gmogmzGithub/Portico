#!/usr/bin/env bash

# Regression tests for migrate-buildkit-gc-policy.sh (PORTICO-205):
#   - config-gated idempotency (written builder.gc policy is the done-marker)
#   - prune targets ONLY the default docker-driver builder of the active
#     orbstack context (wrong context / wrong driver / non-OrbStack abort)
#   - JSON merge preserves unrelated engine-config keys
#   - engine-unhealthy rollback restores the original config bytes
#   - keep-storage validation and dry-run make no changes

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIGRATE_SCRIPT="$PROJECT_ROOT/src/scripts/migrate-buildkit-gc-policy.sh"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

bin_docker_only="$tmp_dir/bin-docker-only"
bin_full="$tmp_dir/bin-full"
state_dir="$tmp_dir/state"
config_dir="$tmp_dir/orbstack-config"
mkdir -p "$bin_docker_only" "$bin_full" "$state_dir" "$config_dir"

fake_log="$tmp_dir/fake.log"

cat > "$bin_docker_only/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -eq 2 ] && [ "$1" = "context" ] && [ "$2" = "show" ]; then
  printf '%s\n' "${DOCKER_FAKE_CONTEXT:-orbstack}"
  exit 0
fi

if [ "$#" -ge 3 ] && [ "$1" = "context" ] && [ "$2" = "inspect" ]; then
  if [ "${DOCKER_FAKE_CONTEXT_INSPECT_FAIL:-0}" = "1" ]; then
    exit 1
  fi
  printf '%s\n' "${DOCKER_FAKE_CONTEXT_HOST:-unix://$HOME/.orbstack/run/docker.sock}"
  exit 0
fi

if [ "$#" -ge 2 ] && [ "$1" = "buildx" ] && [ "$2" = "version" ]; then
  if [ "${DOCKER_FAKE_NO_BUILDX:-0}" = "1" ]; then
    exit 1
  fi
  printf '%s\n' 'github.com/docker/buildx v0.30.0'
  exit 0
fi

if [ "$#" -ge 3 ] && [ "$1" = "buildx" ] && [ "$2" = "inspect" ]; then
  if [ "${DOCKER_FAKE_BUILDX_INSPECT_FAIL:-0}" = "1" ]; then
    echo "ERROR: no builder found" >&2
    exit 1
  fi
  printf 'Name: %s\n' "$3"
  printf 'Driver: %s\n' "${DOCKER_FAKE_BUILDER_DRIVER:-docker}"
  exit 0
fi

if [ "$#" -ge 2 ] && [ "$1" = "builder" ] && [ "$2" = "prune" ]; then
  printf 'prune args=%s BUILDX_BUILDER=%s\n' "$*" "${BUILDX_BUILDER:-<unset>}" >> "${MIGRATE_FAKE_LOG:?}"
  printf '%s\n' 'Total reclaimed space: 44.08GB'
  exit 0
fi

if [ "$#" -eq 2 ] && [ "$1" = "system" ] && [ "$2" = "df" ]; then
  printf '%s\n' 'TYPE  TOTAL  ACTIVE  SIZE  RECLAIMABLE'
  exit 0
fi

if [ "$#" -eq 1 ] && [ "$1" = "info" ]; then
  if [ "${DOCKER_FAKE_INFO_FAIL:-0}" = "1" ] && [ -f "${MIGRATE_FAKE_STATE:?}/restarted" ]; then
    exit 1
  fi
  exit 0
fi

echo "unexpected docker invocation: $*" >&2
exit 1
SH
chmod +x "$bin_docker_only/docker"

cp "$bin_docker_only/docker" "$bin_full/docker"
chmod +x "$bin_full/docker"

cat > "$bin_full/orbctl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'orbctl %s\n' "$*" >> "${MIGRATE_FAKE_LOG:?}"
if [ "$#" -ge 1 ] && [ "$1" = "restart" ]; then
  touch "${MIGRATE_FAKE_STATE:?}/restarted"
  exit 0
fi
exit 1
SH
chmod +x "$bin_full/orbctl"

config_file="$config_dir/docker.json"

run_migrate() {
  : > "$fake_log"
  rm -f "$state_dir/restarted"
  PATH="${TEST_PATH_BIN:-$bin_full}:/usr/bin:/bin" \
  portico_ORBSTACK_CONFIG_DIR="${TEST_CONFIG_DIR:-$config_dir}" \
  portico_ORBSTACK_APP_PATHS="$tmp_dir/no-app" \
  portico_DOCKER_RESTART_TIMEOUT_SECONDS=0 \
  portico_DOCKER_RESTART_POLL_SECONDS=0 \
  portico_ORBSTACK_DATA_IMG="$tmp_dir/data.img.raw" \
  MIGRATE_FAKE_LOG="$fake_log" \
  MIGRATE_FAKE_STATE="$state_dir" \
  bash "$MIGRATE_SCRIPT" "$@" > "$tmp_dir/out.txt" 2> "$tmp_dir/err.txt"
}

expect_no_prune() {
  if grep -q '^prune ' "$fake_log"; then
    fail "$1 (prune must not run)"
  fi
}

json_field() {
  /usr/bin/python3 - "$config_file" "$1" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as fh:
    data = json.load(fh)
node = data
for part in sys.argv[2].split("."):
    node = node[part]
print(node)
PY
}

printf 'sparse-image-bytes' > "$tmp_dir/data.img.raw"

# ---------------------------------------------------------------------------
# 1. Fresh migration: prune once (default builder pinned), policy written,
#    engine restarted, exit 0.
# ---------------------------------------------------------------------------
rm -f "$config_file"
run_migrate || fail "fresh migration should exit 0"
grep -q '^prune .*--all.*--force.* BUILDX_BUILDER=orbstack$' "$fake_log" \
  || fail "prune must run against the pinned orbstack docker-driver builder (log: $(cat "$fake_log"))"
prune_count="$(grep -c '^prune ' "$fake_log")"
[ "$prune_count" = "1" ] || fail "prune must run exactly once (ran $prune_count)"
grep -q '^orbctl restart docker$' "$fake_log" || fail "engine restart must be invoked"
[ -f "$config_file" ] || fail "engine config must be written"
[ "$(json_field builder.gc.enabled)" = "True" ] || fail "builder.gc.enabled must be true"
[ "$(json_field builder.gc.defaultKeepStorage)" = "20GB" ] || fail "default keep-storage must be 20GB"
grep -Fq "Migration complete" "$tmp_dir/out.txt" || fail "success message missing"

# ---------------------------------------------------------------------------
# 2. Idempotency: the written config is the done-marker — re-run skips.
# ---------------------------------------------------------------------------
run_migrate || fail "re-run after success should exit 0"
expect_no_prune "idempotent re-run"
grep -Fq "already present" "$tmp_dir/out.txt" || fail "idempotent skip message missing"
[ ! -f "$state_dir/restarted" ] || fail "idempotent re-run must not restart the engine"

# ---------------------------------------------------------------------------
# 3. Merge preserves unrelated engine-config keys.
# ---------------------------------------------------------------------------
printf '{"registry-mirrors": ["https://mirror.example"], "experimental": false}\n' > "$config_file"
run_migrate || fail "merge migration should exit 0"
[ "$(json_field builder.gc.defaultKeepStorage)" = "20GB" ] || fail "merged keep-storage missing"
[ "$(json_field registry-mirrors)" = "['https://mirror.example']" ] \
  || fail "unrelated registry-mirrors key must be preserved"
[ "$(json_field experimental)" = "False" ] || fail "unrelated experimental key must be preserved"
[ ! -f "$config_file.portico205.bak" ] || fail "backup must be removed after a successful migration"

# ---------------------------------------------------------------------------
# 4. Wrong active context: abort loudly before any prune.
# ---------------------------------------------------------------------------
rm -f "$config_file" "$config_file.portico205.bak"
rc=0
DOCKER_FAKE_CONTEXT="desktop-linux" run_migrate || rc=$?
[ "$rc" = "1" ] || fail "context mismatch must exit 1 (rc=$rc)"
expect_no_prune "context mismatch"
grep -Fq "not 'orbstack'" "$tmp_dir/err.txt" || fail "context mismatch must name the active context"
[ ! -f "$config_file" ] || fail "context mismatch must not write config"

# ---------------------------------------------------------------------------
# 5. Wrong builder driver: abort loudly before any prune.
# ---------------------------------------------------------------------------
rc=0
DOCKER_FAKE_BUILDER_DRIVER="docker-container" run_migrate || rc=$?
[ "$rc" = "1" ] || fail "wrong builder driver must exit 1 (rc=$rc)"
expect_no_prune "wrong builder driver"
grep -Fq "expected 'docker'" "$tmp_dir/err.txt" || fail "wrong-driver message missing"
[ ! -f "$config_file" ] || fail "wrong driver must not write config"

# buildx inspect failing outright must reach the same loud fail-closed
# diagnostic (driver 'unknown'), not silently abort via set -e.
rc=0
DOCKER_FAKE_BUILDX_INSPECT_FAIL=1 run_migrate || rc=$?
[ "$rc" = "1" ] || fail "failing buildx inspect must exit 1 (rc=$rc)"
expect_no_prune "failing buildx inspect"
grep -Fq "driver 'unknown'" "$tmp_dir/err.txt" \
  || fail "failing buildx inspect must produce the refusing-to-prune diagnostic"
grep -Fq "Refusing to prune" "$tmp_dir/err.txt" \
  || fail "failing buildx inspect must state that pruning was refused"
[ ! -f "$config_file" ] || fail "failing buildx inspect must not write config"

# ANY set DOCKER_HOST bypasses the context gate (docker reports context
# 'default' while it is set), so the migration refuses loudly — even for a
# value that points at the OrbStack socket.
for docker_host_value in "tcp://127.0.0.1:2375" "unix://$HOME/.orbstack/run/docker.sock"; do
  rc=0
  DOCKER_HOST="$docker_host_value" run_migrate || rc=$?
  [ "$rc" = "1" ] || fail "set DOCKER_HOST ($docker_host_value) must exit 1 (rc=$rc)"
  expect_no_prune "set DOCKER_HOST ($docker_host_value)"
  grep -Fq "DOCKER_HOST is set" "$tmp_dir/err.txt" \
    || fail "DOCKER_HOST refusal message missing for $docker_host_value"
  grep -Fq "Unset DOCKER_HOST" "$tmp_dir/err.txt" \
    || fail "DOCKER_HOST remediation missing for $docker_host_value"
  [ ! -f "$config_file" ] || fail "set DOCKER_HOST must not write config ($docker_host_value)"
done

for remote_context_host in "tcp://remote-docker.example:2375" "ssh://builder.example"; do
  rc=0
  DOCKER_FAKE_CONTEXT_HOST="$remote_context_host" run_migrate || rc=$?
  [ "$rc" = "1" ] || fail "mispointed orbstack context must exit 1 ($remote_context_host, rc=$rc)"
  expect_no_prune "mispointed orbstack context ($remote_context_host)"
  grep -Fq "not the OrbStack local socket" "$tmp_dir/err.txt" \
    || fail "mispointed orbstack context diagnostic missing for $remote_context_host"
  [ ! -f "$config_file" ] || fail "mispointed orbstack context must not write config ($remote_context_host)"
done

# ---------------------------------------------------------------------------
# 6. Non-OrbStack host: graceful skip. OrbStack-without-CLI: loud failure.
# ---------------------------------------------------------------------------
rc=0
TEST_PATH_BIN="$bin_docker_only" TEST_CONFIG_DIR="$tmp_dir/absent-config" run_migrate || rc=$?
[ "$rc" = "0" ] || fail "non-OrbStack host must exit 0 (rc=$rc)"
expect_no_prune "non-OrbStack skip"
grep -Fq "No OrbStack installation detected" "$tmp_dir/out.txt" || fail "non-OrbStack skip message missing"

rc=0
TEST_PATH_BIN="$bin_docker_only" run_migrate || rc=$?
[ "$rc" = "1" ] || fail "OrbStack config without resolvable orbctl must exit 1 (rc=$rc)"
expect_no_prune "unresolvable orbctl"
grep -Fq "orbctl CLI could not be resolved" "$tmp_dir/err.txt" || fail "unresolvable-orbctl message missing"

# ---------------------------------------------------------------------------
# 7. Unhealthy engine after restart: original config restored byte-for-byte.
# ---------------------------------------------------------------------------
printf '{"registry-mirrors": ["https://keep.example"]}\n' > "$config_file"
cp "$config_file" "$tmp_dir/original-config.json"
rc=0
DOCKER_FAKE_INFO_FAIL=1 run_migrate || rc=$?
[ "$rc" = "1" ] || fail "unhealthy engine must exit 1 (rc=$rc)"
cmp -s "$config_file" "$tmp_dir/original-config.json" \
  || fail "original config must be restored byte-for-byte after failed restart"
grep -Fq "previous config was restored" "$tmp_dir/err.txt" || fail "restore message missing"
[ -f "$config_file.portico205.bak" ] || fail "backup must be kept after failed migration"

rm -f "$config_file" "$config_file.portico205.bak"
rc=0
DOCKER_FAKE_INFO_FAIL=1 run_migrate || rc=$?
[ "$rc" = "1" ] || fail "unhealthy engine (no prior config) must exit 1 (rc=$rc)"
[ ! -f "$config_file" ] || fail "written config must be removed when no original existed"

# ---------------------------------------------------------------------------
# 8. Keep-storage override, validation, dry-run, malformed config.
# ---------------------------------------------------------------------------
rm -f "$config_file"
portico_BUILDKIT_KEEP_STORAGE_GB=50 run_migrate || fail "keep-storage override run should exit 0"
[ "$(json_field builder.gc.defaultKeepStorage)" = "50GB" ] || fail "keep-storage override must be honored"

rc=0
portico_BUILDKIT_KEEP_STORAGE_GB="20GB" run_migrate || rc=$?
[ "$rc" = "2" ] || fail "invalid keep-storage must exit 2 (rc=$rc)"
expect_no_prune "invalid keep-storage"

rm -f "$config_file"
run_migrate --dry-run || fail "dry-run should exit 0"
expect_no_prune "dry-run"
[ ! -f "$config_file" ] || fail "dry-run must not write config"
[ ! -f "$state_dir/restarted" ] || fail "dry-run must not restart the engine"
grep -Fq "DRY RUN" "$tmp_dir/out.txt" || fail "dry-run banner missing"

printf '{ not json' > "$config_file"
rc=0
run_migrate || rc=$?
[ "$rc" = "1" ] || fail "malformed config must exit 1 (rc=$rc)"
expect_no_prune "malformed config"
grep -Fq "not valid JSON" "$tmp_dir/err.txt" || fail "malformed-config message missing"
[ "$(cat "$config_file")" = "{ not json" ] || fail "malformed config must be left untouched"

# Degenerate-but-parseable configs must refuse BEFORE pruning (no
# prune-then-fail loop) and must never be treated as already-migrated.
printf '{"builder": "not-an-object"}\n' > "$config_file"
rc=0
run_migrate || rc=$?
[ "$rc" = "1" ] || fail "non-dict builder key must exit 1 (rc=$rc)"
expect_no_prune "non-dict builder key"
[ "$(cat "$config_file")" = '{"builder": "not-an-object"}' ] \
  || fail "non-dict builder config must be left untouched"

printf '{"builder": {"gc": "garbage"}}\n' > "$config_file"
rc=0
run_migrate || rc=$?
[ "$rc" = "1" ] || fail "non-dict builder.gc value must exit 1, not skip as done (rc=$rc)"
expect_no_prune "non-dict builder.gc value"

rc=0
run_migrate --nonsense || rc=$?
[ "$rc" = "2" ] || fail "unknown argument must exit 2 (rc=$rc)"

# ---------------------------------------------------------------------------
# 9. Legacy CLI without buildx: prune still targets the daemon builder.
# ---------------------------------------------------------------------------
rm -f "$config_file"
DOCKER_FAKE_NO_BUILDX=1 run_migrate || fail "no-buildx migration should exit 0"
grep -q '^prune .* BUILDX_BUILDER=<unset>$' "$fake_log" \
  || fail "no-buildx prune must run without a BUILDX_BUILDER pin"

echo "migrate-buildkit-gc-policy idempotency, gating, merge, and rollback behavior looks correct."
