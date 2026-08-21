#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
FAKE_BIN_DIR="$TMP_DIR/bin"
mkdir -p "$FAKE_BIN_DIR"
NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || true)}"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  for candidate in /usr/local/lib/nodejs/node-*/bin/node "$HOME/.nvm"/versions/node/*/bin/node /usr/local/bin/node /opt/homebrew/bin/node; do
    if [ -x "$candidate" ]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi
[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || {
  echo "FAIL: node is required for run-health-check tests" >&2
  exit 1
}

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fail() {
  echo "$*" >&2
  exit 1
}

assert_health_check_compose_up() {
  local log_file="$1"
  local failure_message="$2"

  if ! grep -q '^compose up -d --no-deps --no-build health-check$' "$log_file"; then
    echo "Unexpected Docker invocation log:" >&2
    sed 's/^/  /' "$log_file" >&2
    fail "$failure_message"
  fi
}

cat >"$FAKE_BIN_DIR/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

LOG_FILE="${LOG_FILE:?}"
CONTAINER_PRESENT="${CONTAINER_PRESENT:-1}"
RUNNING_STATE_VALUE="${RUNNING_STATE_VALUE:-false}"
EXPECT_HOST_MODE_EMPTY="${EXPECT_HOST_MODE_EMPTY:-0}"

printf '%s\n' "$*" >>"$LOG_FILE"

assert_host_mode_file_ready() {
  if [ ! -f HOST_MODE ]; then
    echo "HOST_MODE was not a file before docker $1" >&2
    exit 90
  fi

  if [ "$EXPECT_HOST_MODE_EMPTY" = "1" ] && [ -s HOST_MODE ]; then
    echo "HOST_MODE was not empty before docker $1" >&2
    exit 91
  fi
}

case "$1" in
  ps)
    if [ "$CONTAINER_PRESENT" = "1" ]; then
      echo "open-webui-health-check"
    fi
    ;;
  inspect)
    if [[ "$*" == *"{{.State.Running}}"* ]]; then
      echo "$RUNNING_STATE_VALUE"
    else
      echo "0"
    fi
    ;;
  compose)
    if [ "${2:-}" = "version" ]; then
      echo "Docker Compose version v2.39.1"
      exit 0
    fi
    assert_host_mode_file_ready "compose"
    ;;
  stop)
    exit 0
    ;;
  start)
    assert_host_mode_file_ready "start"
    ;;
  wait)
    echo "0"
    ;;
  *)
    echo "unexpected docker invocation: $*" >&2
    exit 98
    ;;
esac
EOF
chmod +x "$FAKE_BIN_DIR/docker"

make_case_project() {
  local project_dir="$1"
  mkdir -p "$project_dir/src/scripts"
  mkdir -p "$project_dir/electron-app/src/services"
  cp "$REPO_ROOT/src/scripts/run-health-check.sh" "$project_dir/src/scripts/run-health-check.sh"
  cp "$REPO_ROOT/src/scripts/normalize-mcp-toggles.js" "$project_dir/src/scripts/normalize-mcp-toggles.js"
  cp "$REPO_ROOT/src/scripts/mcp-orc-backend.sh" "$project_dir/src/scripts/mcp-orc-backend.sh"
  cp "$REPO_ROOT/electron-app/src/services/mcp-toggle-store.js" "$project_dir/electron-app/src/services/mcp-toggle-store.js"
  printf '{"slack":true,"snowflake":false}\n' > "$project_dir/mcp_toggles.json"
  cat > "$project_dir/src/scripts/docker-compose.sh" <<'EOF'
#!/usr/bin/env bash
export TZ="${TZ:-UTC}"
export PORTICO_BUILD_TRACK="${PORTICO_BUILD_TRACK:-dev-build}"
EOF
}

assert_toggle_snapshot() {
  local snapshot_file="$1"
  local expected_json="$2"
  "$NODE_BIN" - "$snapshot_file" "$expected_json" <<'NODE'
const fs = require("fs");
const snapshot = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const actual = snapshot.toggles || snapshot;
const expected = JSON.parse(process.argv[3]);
assertDeepEqual(actual, expected);
if (!snapshot.revision || !String(snapshot.revision).startsWith("sha256:")) {
  throw new Error(`snapshot is missing revision: ${JSON.stringify(snapshot)}`);
}

function assertDeepEqual(left, right) {
  const leftJson = JSON.stringify(Object.fromEntries(Object.entries(left).sort()));
  const rightJson = JSON.stringify(Object.fromEntries(Object.entries(right).sort()));
  if (leftJson !== rightJson) {
    throw new Error(`snapshot mismatch: actual=${leftJson} expected=${rightJson}`);
  }
}
NODE
}

run_case() {
  local case_name="$1"
  local container_present="$2"
  local running_state="$3"
  local expect_empty="$4"
  local setup_host_mode="$5"

  local case_dir="$TMP_DIR/$case_name"
  local project_dir="$case_dir/project"
  local log_file="$case_dir/docker.log"

  mkdir -p "$case_dir"
  make_case_project "$project_dir"

  case "$setup_host_mode" in
    missing)
      ;;
    directory)
      mkdir -p "$project_dir/HOST_MODE"
      printf 'stale\n' > "$project_dir/HOST_MODE/stale"
      ;;
    true-file)
      printf 'TRUE\n' > "$project_dir/HOST_MODE"
      ;;
    *)
      fail "unknown HOST_MODE setup: $setup_host_mode"
      ;;
  esac

  (
    cd "$project_dir"
    PATH="$FAKE_BIN_DIR:$PATH" \
      LOG_FILE="$log_file" \
      CONTAINER_PRESENT="$container_present" \
      RUNNING_STATE_VALUE="$running_state" \
      EXPECT_HOST_MODE_EMPTY="$expect_empty" \
      bash src/scripts/run-health-check.sh --mode light >/dev/null
  )

  printf '%s\n' "$project_dir"
}

run_metadata_case() {
  local case_name="$1"
  local with_metadata="$2"

  local case_dir="$TMP_DIR/$case_name"
  local project_dir="$case_dir/project"
  local log_file="$case_dir/docker.log"

  mkdir -p "$case_dir"
  make_case_project "$project_dir"
  printf 'TRUE\n' > "$project_dir/HOST_MODE"
  mkdir -p "$project_dir/health-status"
  printf 'stale-run\n' > "$project_dir/health-status/health_sync_run_id"
  printf 'stale-reason\n' > "$project_dir/health-status/health_sync_reason"
  printf '999\n' > "$project_dir/health-status/health_sync_timeout_budget_ms"
  printf 'stale-session\n' > "$project_dir/health-status/health_sync_session_id"

  (
    cd "$project_dir"
    if [[ "$with_metadata" = "1" ]]; then
      PATH="$FAKE_BIN_DIR:$PATH" \
        LOG_FILE="$log_file" \
        CONTAINER_PRESENT=1 \
        RUNNING_STATE_VALUE=false \
        EXPECT_HOST_MODE_EMPTY=0 \
        HEALTH_SYNC_RUN_ID=" run-1 " \
        HEALTH_SYNC_REASON=" scheduled " \
        HEALTH_SYNC_TIMEOUT_BUDGET_MS=" 180000 " \
        HEALTH_SYNC_SESSION_ID="session-1" \
        bash src/scripts/run-health-check.sh --mode full >/dev/null
    else
      PATH="$FAKE_BIN_DIR:$PATH" \
        LOG_FILE="$log_file" \
        CONTAINER_PRESENT=1 \
        RUNNING_STATE_VALUE=false \
        EXPECT_HOST_MODE_EMPTY=0 \
        bash src/scripts/run-health-check.sh --mode startup-core >/dev/null
    fi
  )

  printf '%s\n' "$project_dir"
}

missing_project="$(run_case missing-host-mode 0 false 1 missing)"
[ -f "$missing_project/HOST_MODE" ] || fail "missing HOST_MODE should be created as a file"
[ ! -s "$missing_project/HOST_MODE" ] || fail "missing HOST_MODE should be created empty"
assert_health_check_compose_up \
  "$TMP_DIR/missing-host-mode/docker.log" \
  "missing-container path should create the health-check service with compose"
assert_toggle_snapshot "$missing_project/health-status/mcp_toggles_snapshot.json" '{"slack":true,"snowflake":false}'

directory_project="$(run_case directory-host-mode 0 false 1 directory)"
[ -f "$directory_project/HOST_MODE" ] || fail "directory HOST_MODE should be recreated as a file"
[ ! -d "$directory_project/HOST_MODE" ] || fail "directory HOST_MODE should not remain a directory"
[ ! -s "$directory_project/HOST_MODE" ] || fail "directory HOST_MODE should be recreated empty"
assert_health_check_compose_up \
  "$TMP_DIR/directory-host-mode/docker.log" \
  "directory-repair path should create the health-check service with compose"

true_missing_project="$(run_case true-file-missing-container 0 false 0 true-file)"
[ "$(cat "$true_missing_project/HOST_MODE")" = "TRUE" ] \
  || fail "existing HOST_MODE=TRUE should be preserved before container creation"
assert_health_check_compose_up \
  "$TMP_DIR/true-file-missing-container/docker.log" \
  "existing-file missing-container path should create the health-check service with compose"

true_running_project="$(run_case true-file-running-container 1 true 0 true-file)"
[ "$(cat "$true_running_project/HOST_MODE")" = "TRUE" ] \
  || fail "existing HOST_MODE=TRUE should be preserved before container restart"
grep -q '^stop open-webui-health-check$' "$TMP_DIR/true-file-running-container/docker.log"
grep -q '^start open-webui-health-check$' "$TMP_DIR/true-file-running-container/docker.log"

if grep -q '^compose ' "$TMP_DIR/true-file-running-container/docker.log"; then
  fail "run-health-check.sh should not use docker compose start/stop for an existing health-check container"
fi

metadata_project="$(run_metadata_case writes-metadata-files 1)"
[ "$(cat "$metadata_project/health-status/health_check_mode")" = "full" ] \
  || fail "metadata case should preserve health-check mode writing"
[ "$(cat "$metadata_project/health-status/health_sync_session_id")" = "session-1" ] \
  || fail "metadata case should preserve health-sync session writing"
[ "$(cat "$metadata_project/health-status/health_sync_run_id")" = "run-1" ] \
  || fail "health-sync run id should be trimmed and written"
[ "$(cat "$metadata_project/health-status/health_sync_reason")" = "scheduled" ] \
  || fail "health-sync reason should be trimmed and written"
[ "$(cat "$metadata_project/health-status/health_sync_timeout_budget_ms")" = "180000" ] \
  || fail "health-sync timeout budget should be trimmed and written"

metadata_removed_project="$(run_metadata_case removes-stale-metadata-files 0)"
[ "$(cat "$metadata_removed_project/health-status/health_check_mode")" = "startup-core" ] \
  || fail "metadata removal case should preserve health-check mode writing"
[ "$(cat "$metadata_removed_project/health-status/health_sync_session_id")" = "stale-session" ] \
  || fail "metadata removal case should leave existing session behavior unchanged"
[ ! -e "$metadata_removed_project/health-status/health_sync_run_id" ] \
  || fail "stale health-sync run id should be removed when env is absent"
[ ! -e "$metadata_removed_project/health-status/health_sync_reason" ] \
  || fail "stale health-sync reason should be removed when env is absent"
[ ! -e "$metadata_removed_project/health-status/health_sync_timeout_budget_ms" ] \
  || fail "stale health-sync timeout budget should be removed when env is absent"

string_toggle_project="$TMP_DIR/string-toggle-source/project"
string_toggle_log="$TMP_DIR/string-toggle-source/docker.log"
mkdir -p "$(dirname "$string_toggle_project")"
make_case_project "$string_toggle_project"
printf 'TRUE\n' > "$string_toggle_project/HOST_MODE"
printf '{"slack":"true","snowflake":"false"}\n' > "$string_toggle_project/mcp_toggles.json"
(
  cd "$string_toggle_project"
  PATH="$FAKE_BIN_DIR:$PATH" LOG_FILE="$string_toggle_log" \
    bash src/scripts/run-health-check.sh --mode light >/dev/null
)
assert_toggle_snapshot "$string_toggle_project/health-status/mcp_toggles_snapshot.json" '{"slack":true,"snowflake":false}'
"$NODE_BIN" -e 'const fs=require("fs"); const parsed=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if (parsed.slack !== true || parsed.snowflake !== false) process.exit(1)' "$string_toggle_project/mcp_toggles.json" \
  || fail "string toggle values should be normalized in mcp_toggles.json"

invalid_project="$TMP_DIR/invalid-toggle-source/project"
invalid_log="$TMP_DIR/invalid-toggle-source/docker.log"
mkdir -p "$(dirname "$invalid_project")"
make_case_project "$invalid_project"
printf 'TRUE\n' > "$invalid_project/HOST_MODE"
printf '{not-json\n' > "$invalid_project/mcp_toggles.json"
(
  cd "$invalid_project"
  PATH="$FAKE_BIN_DIR:$PATH" LOG_FILE="$invalid_log" \
    bash src/scripts/run-health-check.sh --mode light >/dev/null 2>&1
)
find "$invalid_project" -name 'mcp_toggles.json.invalid-backup-*' -type f | grep -q . \
  || fail "invalid MCP toggle source should be backed up before repair"
assert_toggle_snapshot "$invalid_project/health-status/mcp_toggles_snapshot.json" '{}'
"$NODE_BIN" -e 'const fs=require("fs"); const parsed=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if (Object.keys(parsed).length !== 0) process.exit(1)' "$invalid_project/mcp_toggles.json" \
  || fail "invalid MCP toggle source should be replaced with an empty toggle map"

POISON_BIN_DIR="$TMP_DIR/poison-bin"
POISON_NODE_LOG="$TMP_DIR/poison-node.log"
mkdir -p "$POISON_BIN_DIR"
cat >"$POISON_BIN_DIR/node" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${POISON_NODE_LOG:?}"
exit 99
EOF
chmod +x "$POISON_BIN_DIR/node"
POISON_NODE="$POISON_BIN_DIR/node"

run_with_poison_node() {
  local project_dir="$1"
  local log_file="$2"
  local stdout_file="$3"
  local stderr_file="$4"
  local marker_value="$5"

  (
    cd "$project_dir"
    export PATH="$POISON_BIN_DIR:$FAKE_BIN_DIR:/usr/bin:/bin"
    export NODE_BINARY="$POISON_NODE"
    export HOST_NODE_PATH="$POISON_NODE"
    export POISON_NODE_LOG
    export LOG_FILE="$log_file"
    export CONTAINER_PRESENT=1
    export RUNNING_STATE_VALUE=false
    export EXPECT_HOST_MODE_EMPTY=0
    export HEALTH_SYNC_SESSION_ID="prepared-session"
    export HEALTH_SYNC_RUN_ID="prepared-run"
    export HEALTH_SYNC_REASON="prepared-test"
    export HEALTH_SYNC_TIMEOUT_BUDGET_MS="180000"
    if [[ "$marker_value" == "__UNSET__" ]]; then
      unset HEALTH_SYNC_TOGGLE_SNAPSHOT_READY
    else
      export HEALTH_SYNC_TOGGLE_SNAPSHOT_READY="$marker_value"
    fi
    bash src/scripts/run-health-check.sh --mode full \
      >"$stdout_file" 2>"$stderr_file"
  )
}

prepared_case_dir="$TMP_DIR/prepared-snapshot"
prepared_project="$prepared_case_dir/project"
prepared_log="$prepared_case_dir/docker.log"
prepared_stdout="$prepared_case_dir/stdout.log"
prepared_stderr="$prepared_case_dir/stderr.log"
mkdir -p "$prepared_case_dir"
make_case_project "$prepared_project"
printf 'TRUE\n' >"$prepared_project/HOST_MODE"
"$NODE_BIN" "$prepared_project/src/scripts/normalize-mcp-toggles.js" \
  --project-root "$prepared_project" \
  --snapshot "$prepared_project/health-status/mcp_toggles_snapshot.json" \
  --reason "prepared-test" >/dev/null
cp "$prepared_project/health-status/mcp_toggles_snapshot.json" \
  "$prepared_case_dir/snapshot-before.json"
: >"$POISON_NODE_LOG"
run_with_poison_node \
  "$prepared_project" "$prepared_log" "$prepared_stdout" "$prepared_stderr" "1"
[ ! -s "$POISON_NODE_LOG" ] \
  || fail "host-prepared snapshot path must not invoke Node.js"
cmp "$prepared_case_dir/snapshot-before.json" \
  "$prepared_project/health-status/mcp_toggles_snapshot.json" \
  || fail "host-prepared snapshot path must preserve snapshot bytes"
[ "$(cat "$prepared_project/health-status/health_check_mode")" = "full" ] \
  || fail "host-prepared snapshot path should write health-check mode"
[ "$(cat "$prepared_project/health-status/health_sync_session_id")" = "prepared-session" ] \
  || fail "host-prepared snapshot path should write health-sync session"
[ "$(cat "$prepared_project/health-status/health_sync_run_id")" = "prepared-run" ] \
  || fail "host-prepared snapshot path should write health-sync run id"
grep -q '^start open-webui-health-check$' "$prepared_log" \
  || fail "host-prepared snapshot path should start health-check container"
grep -q '^wait open-webui-health-check$' "$prepared_log" \
  || fail "host-prepared snapshot path should wait for health-check container"

# Fresh basic installs reach the runner with no snapshot on disk at all. Pin the
# full handoff from absence: normalization must create the snapshot even when the
# toggle source needs no repair, and the runner must then accept it without Node.
fresh_case_dir="$TMP_DIR/prepared-snapshot-fresh-install"
fresh_project="$fresh_case_dir/project"
fresh_log="$fresh_case_dir/docker.log"
fresh_stdout="$fresh_case_dir/stdout.log"
fresh_stderr="$fresh_case_dir/stderr.log"
fresh_snapshot="$fresh_project/health-status/mcp_toggles_snapshot.json"
mkdir -p "$fresh_case_dir"
make_case_project "$fresh_project"
printf 'TRUE\n' >"$fresh_project/HOST_MODE"
[ ! -e "$fresh_snapshot" ] \
  || fail "fresh-install case must start with no MCP toggle snapshot on disk"
cp "$fresh_project/mcp_toggles.json" "$fresh_case_dir/toggles-before.json"
"$NODE_BIN" "$fresh_project/src/scripts/normalize-mcp-toggles.js" \
  --project-root "$fresh_project" \
  --snapshot "$fresh_snapshot" \
  --reason "fresh-install-test" >/dev/null
[ -f "$fresh_snapshot" ] \
  || fail "normalization must create the snapshot for an already-canonical toggle source"
assert_toggle_snapshot "$fresh_snapshot" '{"slack":true,"snowflake":false}'
cmp "$fresh_case_dir/toggles-before.json" "$fresh_project/mcp_toggles.json" \
  || fail "normalization must leave an already-canonical toggle source untouched"
cp "$fresh_snapshot" "$fresh_case_dir/snapshot-before.json"
: >"$POISON_NODE_LOG"
run_with_poison_node \
  "$fresh_project" "$fresh_log" "$fresh_stdout" "$fresh_stderr" "1"
[ ! -s "$POISON_NODE_LOG" ] \
  || fail "fresh-install handoff must not invoke Node.js"
cmp "$fresh_case_dir/snapshot-before.json" "$fresh_snapshot" \
  || fail "fresh-install handoff must preserve snapshot bytes"
[ "$(cat "$fresh_project/health-status/health_check_mode")" = "full" ] \
  || fail "fresh-install handoff should write health-check mode"
[ "$(cat "$fresh_project/health-status/health_sync_run_id")" = "prepared-run" ] \
  || fail "fresh-install handoff should write health-sync run id"
grep -q '^start open-webui-health-check$' "$fresh_log" \
  || fail "fresh-install handoff should start health-check container"
grep -q '^wait open-webui-health-check$' "$fresh_log" \
  || fail "fresh-install handoff should wait for health-check container"

assert_invalid_prepared_snapshot_fails() {
  local snapshot_kind="$1"
  local case_dir="$TMP_DIR/prepared-snapshot-$snapshot_kind"
  local project_dir="$case_dir/project"
  local log_file="$case_dir/docker.log"
  local stdout_file="$case_dir/stdout.log"
  local stderr_file="$case_dir/stderr.log"
  local snapshot_file="$project_dir/health-status/mcp_toggles_snapshot.json"

  mkdir -p "$case_dir"
  make_case_project "$project_dir"
  printf 'TRUE\n' >"$project_dir/HOST_MODE"
  mkdir -p "$project_dir/health-status"
  case "$snapshot_kind" in
    missing)
      ;;
    empty)
      : >"$snapshot_file"
      ;;
    directory)
      mkdir -p "$snapshot_file"
      ;;
    symlink)
      printf '{"toggles":{}}\n' >"$case_dir/snapshot-target.json"
      ln -s "$case_dir/snapshot-target.json" "$snapshot_file"
      ;;
    *)
      fail "unknown prepared snapshot kind: $snapshot_kind"
      ;;
  esac

  : >"$POISON_NODE_LOG"
  if run_with_poison_node \
    "$project_dir" "$log_file" "$stdout_file" "$stderr_file" "1"; then
    fail "prepared snapshot kind $snapshot_kind should fail closed"
  fi
  grep -q 'Host-prepared MCP toggle snapshot is missing or invalid' "$stderr_file" \
    || fail "prepared snapshot kind $snapshot_kind should emit the marker-specific error"
  [ ! -s "$POISON_NODE_LOG" ] \
    || fail "prepared snapshot kind $snapshot_kind must fail before invoking Node.js"
  [ ! -e "$project_dir/health-status/health_check_mode" ] \
    || fail "prepared snapshot kind $snapshot_kind must fail before writing mode"
  [ ! -e "$project_dir/health-status/health_sync_session_id" ] \
    || fail "prepared snapshot kind $snapshot_kind must fail before writing session"
  [ ! -s "$log_file" ] \
    || fail "prepared snapshot kind $snapshot_kind must fail before Docker"
}

for snapshot_kind in missing empty directory symlink; do
  assert_invalid_prepared_snapshot_fails "$snapshot_kind"
done

assert_untrusted_marker_uses_node() {
  local marker_value="$1"
  local case_label="$2"
  local case_dir="$TMP_DIR/untrusted-marker-$case_label"
  local project_dir="$case_dir/project"
  local log_file="$case_dir/docker.log"
  local stdout_file="$case_dir/stdout.log"
  local stderr_file="$case_dir/stderr.log"

  mkdir -p "$case_dir"
  make_case_project "$project_dir"
  printf 'TRUE\n' >"$project_dir/HOST_MODE"
  : >"$POISON_NODE_LOG"
  if run_with_poison_node \
    "$project_dir" "$log_file" "$stdout_file" "$stderr_file" "$marker_value"; then
    fail "untrusted marker '$marker_value' should keep Node normalization enforced"
  fi
  [ -s "$POISON_NODE_LOG" ] \
    || fail "untrusted marker '$marker_value' should invoke the Node normalizer path"
  if grep -q 'Host-prepared MCP toggle snapshot is missing or invalid' "$stderr_file"; then
    fail "untrusted marker '$marker_value' must not enter the prepared-snapshot path"
  fi
  [ ! -s "$log_file" ] \
    || fail "untrusted marker '$marker_value' must fail before Docker"
}

assert_untrusted_marker_uses_node "__UNSET__" "unset"
assert_untrusted_marker_uses_node "" "empty"
assert_untrusted_marker_uses_node "0" "zero"
assert_untrusted_marker_uses_node "false" "false"
assert_untrusted_marker_uses_node "true" "true"

echo "run-health-check.sh hardens HOST_MODE, accepts only host-prepared snapshots, and uses direct docker control"
