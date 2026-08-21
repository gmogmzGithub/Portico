#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
FIXTURE_ROOT="$TMP_DIR/project"
export TMPDIR="$TMP_DIR"
LOCK_DIR="$TMP_DIR/open-webui-mcp-generate-docker-compose.lock"
FIRST_LOG="$TMP_DIR/first-generator.log"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

# shellcheck source=src/scripts/mcp-orc-generator-test-lib.sh
source "$ROOT_DIR/src/scripts/mcp-orc-generator-test-lib.sh"

mcp_orc_test_prepare_project_root "$ROOT_DIR" "$FIXTURE_ROOT"
mcp_orc_test_copy_server_configs "$ROOT_DIR" "$FIXTURE_ROOT" glean
printf '{"glean":true}\n' >"$FIXTURE_ROOT/mcp_toggles.json"

rm -rf "$LOCK_DIR"

MCPO_GENERATOR_TEST_HOLD_LOCK_SEC=5 \
MCPO_GENERATOR_TEST_EXIT_AFTER_LOCK=1 \
mcp_orc_test_run_generator "$ROOT_DIR" "$FIXTURE_ROOT" generate-docker-compose-override >"$FIRST_LOG" 2>&1 &
first_pid=$!

for _ in $(seq 1 300); do
  if [[ -d "$LOCK_DIR" ]]; then
    break
  fi
  if ! kill -0 "$first_pid" 2>/dev/null; then
    echo "Generator exited before creating the lock" >&2
    cat "$FIRST_LOG" >&2
    wait "$first_pid" 2>/dev/null || true
    rm -f "$FIRST_LOG"
    exit 1
  fi
  sleep 0.1
done

if [[ ! -d "$LOCK_DIR" ]]; then
  echo "Generator lock was not created" >&2
  cat "$FIRST_LOG" >&2
  kill "$first_pid" 2>/dev/null || true
  wait "$first_pid" 2>/dev/null || true
  rm -f "$FIRST_LOG"
  exit 1
fi

start_time="$(python3 - <<'PY'
import time
print(time.time())
PY
)"

MCPO_GENERATOR_TEST_EXIT_AFTER_LOCK=1 \
  mcp_orc_test_run_generator "$ROOT_DIR" "$FIXTURE_ROOT" generate-docker-compose-override >/dev/null 2>&1

end_time="$(python3 - <<'PY'
import time
print(time.time())
PY
)"

wait "$first_pid"

elapsed="$(python3 - <<PY
start = float("$start_time")
end = float("$end_time")
print(end - start)
PY
)"

python3 - <<PY
elapsed = float("$elapsed")
if elapsed < 1.0:
    raise SystemExit(f"Expected second generator invocation to wait on the lock, elapsed={elapsed:.3f}s")
PY

echo "Generator locking test passed"
