#!/usr/bin/env bash
# PORTICO-236: cross-runtime stale-stack cleanup + port-conflict surfacing tests
# for src/scripts/docker-compose.sh.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
FAKE_BIN_DIR="$TMP_DIR/bin"
FIXTURE_DIR="$TMP_DIR/fixture"
mkdir -p "$FAKE_BIN_DIR"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cat >"$FAKE_BIN_DIR/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$FAKE_BIN_DIR/sleep"

# Fake lsof: emits a listener row whose COMMAND comes from FAKE_LSOF_COMMAND;
# FAKE_LSOF_MODE=fail simulates an unusable lsof.
cat >"$FAKE_BIN_DIR/lsof" <<'EOF'
#!/usr/bin/env bash
if [ "${FAKE_LSOF_MODE:-ok}" = "fail" ]; then
  exit 1
fi
printf 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n'
printf '%s 4242 user 55u IPv4 0x0 0t0 TCP 127.0.0.1:3835 (LISTEN)\n' "${FAKE_LSOF_COMMAND:-com.docker.backend}"
EOF
chmod +x "$FAKE_BIN_DIR/lsof"

cat >"$FAKE_BIN_DIR/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

LOG_FILE="${LOG_FILE:?}"
printf '%s\n' "$*" >>"$LOG_FILE"

ctx=""
if [[ "${1:-}" == "--context" ]]; then
  ctx="$2"
  shift 2
fi
args="$*"

if [[ "$1" == "context" ]]; then
  case "${2:-}" in
    show)
      printf 'orbstack\n'
      exit 0
      ;;
    ls)
      printf 'orbstack|unix:///Users/tester/.orbstack/run/docker.sock\n'
      printf 'desktop-linux|unix:///Users/tester/.docker/run/docker.sock\n'
      printf 'remote-box|ssh://tester@remote-box\n'
      exit 0
      ;;
  esac
  exit 0
fi

if [[ "$1" == "info" ]]; then
  if [[ "$ctx" == "desktop-linux" ]]; then
    if [[ "${FAKE_DESKTOP_MODE:-other}" == "unreachable" ]]; then
      echo "Cannot connect to the Docker daemon" >&2
      exit 1
    fi
    if [[ "${FAKE_DESKTOP_MODE:-other}" == "alias" ]]; then
      printf 'CURRENT-DAEMON-ID\n'
      exit 0
    fi
    printf 'DESKTOP-DAEMON-ID\n'
    exit 0
  fi
  if [[ "$ctx" == "remote-box" ]]; then
    echo "should never probe non-unix contexts: $args" >&2
    exit 96
  fi
  # active daemon
  printf 'CURRENT-DAEMON-ID\n'
  exit 0
fi

if [[ "$1" == "ps" ]]; then
  if [[ "$ctx" == "desktop-linux" && "$args" == *"label=com.docker.compose.project=portico"* && "$args" != *"portico-single"* ]]; then
    printf 'stalecontainer1\nstalecontainer2\n'
    exit 0
  fi
  # portico-single project and everything else: empty
  exit 0
fi

if [[ "$1" == "rm" ]]; then
  exit 0
fi

if [[ "$1" == "compose" ]]; then
  if [[ "${2:-}" == "version" ]]; then
    printf 'Docker Compose version v2.39.1\n'
    exit 0
  fi
  if [[ "$args" == *"config --services"* ]]; then
    printf 'redis\nmongodb\nchat-state-api\n'
    exit 0
  fi
  if [[ "$args" == *" up -d"* ]]; then
    printf 'Container portico-redis Started\n'
    printf 'Error response from daemon: ports are not available: exposing port TCP 0.0.0.0:3835 -> 127.0.0.1:0: listen tcp 0.0.0.0:3835: bind: address already in use\n' >&2
    exit 1
  fi
  exit 0
fi

exit 0
EOF
chmod +x "$FAKE_BIN_DIR/docker"

create_fixture() {
  mkdir -p "$FIXTURE_DIR/src/scripts" "$FIXTURE_DIR/electron-app"

  cp "$REPO_ROOT/src/scripts/docker-compose.sh" "$FIXTURE_DIR/src/scripts/docker-compose.sh"
  cp "$REPO_ROOT/src/scripts/mcp-orc-backend.sh" "$FIXTURE_DIR/src/scripts/mcp-orc-backend.sh"
  # Some branches source additional helper libraries from docker-compose.sh.
  if [ -f "$REPO_ROOT/src/scripts/runtime-secrets.sh" ]; then
    cp "$REPO_ROOT/src/scripts/runtime-secrets.sh" "$FIXTURE_DIR/src/scripts/runtime-secrets.sh"
  fi

  cat >"$FIXTURE_DIR/src/scripts/mcp-orc-cli.sh" <<'EOF'
export_mcp_orc_compose_env() {
  export MCP_ORC_MODE_RESOLVED="${MCP_ORC_MODE:-rust-full}"
}
export_mcp_orc_harbor_env() {
  return 0
}
resolve_mcp_orc_generator_binary() {
  return 1
}
run_mcp_orc_generator() {
  return 1
}
EOF

  cat >"$FIXTURE_DIR/src/scripts/managed-runtime-integrity.sh" <<'EOF'
managed_runtime_is_packaged_runtime() {
  return 1
}
managed_runtime_self_heal_packaged_runtime() {
  return 0
}
EOF

  cat >"$FIXTURE_DIR/electron-app/build-info.json" <<'EOF'
{"buildNumber":"dev-build"}
EOF

  touch \
    "$FIXTURE_DIR/.env" \
    "$FIXTURE_DIR/docker-compose.yml" \
    "$FIXTURE_DIR/docker-compose.advanced.yml" \
    "$FIXTURE_DIR/docker-compose.bifrost.yml"
}

create_fixture

# Runs a snippet with docker-compose.sh sourced (SKIP_MAIN_EXECUTION) inside
# the fixture. Returns the snippet's exit code; fake docker calls go to $1.
run_sourced() {
  local log_file="$1"
  local snippet="$2"
  shift 2
  : >"$log_file"
  (
    cd "$FIXTURE_DIR"
    env \
      PATH="$FAKE_BIN_DIR:$PATH" \
      LOG_FILE="$log_file" \
      LLM_GATEWAY_MODE=bifrost \
      MCP_ORC_MODE=rust-full \
      SKIP_MAIN_EXECUTION=1 \
      "$@" \
      bash -c "source src/scripts/docker-compose.sh >/dev/null 2>&1 || true; ${snippet}"
  )
}

echo "case 1: stale stack on another daemon is removed (containers only, other context only)"
LOG1="$TMP_DIR/docker1.log"
run_sourced "$LOG1" 'cleanup_project_on_other_docker_contexts' FAKE_DESKTOP_MODE=other
grep -q -- '--context desktop-linux ps -aq --filter label=com.docker.compose.project=portico' "$LOG1"
grep -q -- '--context desktop-linux ps -aq --filter label=com.docker.compose.project=portico-single' "$LOG1"
grep -q -- '--context desktop-linux rm -f stalecontainer1 stalecontainer2' "$LOG1"
if grep -q -- '--context remote-box' "$LOG1"; then
  echo "non-unix (ssh) contexts must never be probed" >&2
  exit 1
fi
if grep -q -- '--context orbstack' "$LOG1"; then
  echo "the active context must never be probed via --context" >&2
  exit 1
fi
if grep -qE -- '(^| )rm -f' "$LOG1" && grep -vq -- '--context desktop-linux rm -f' <(grep -E -- 'rm -f' "$LOG1"); then
  echo "rm -f must only target the other context" >&2
  exit 1
fi

echo "case 2: alias context (same daemon ID) is left untouched"
LOG2="$TMP_DIR/docker2.log"
if run_sourced "$LOG2" 'cleanup_project_on_other_docker_contexts' FAKE_DESKTOP_MODE=alias; then
  echo "cleanup should report nothing removed for alias contexts" >&2
  exit 1
fi
if grep -q -- 'rm -f' "$LOG2"; then
  echo "alias context containers must never be removed" >&2
  exit 1
fi

echo "case 3: unreachable other daemon is skipped silently"
LOG3="$TMP_DIR/docker3.log"
if run_sourced "$LOG3" 'cleanup_project_on_other_docker_contexts' FAKE_DESKTOP_MODE=unreachable; then
  echo "cleanup should report nothing removed when the other daemon is down" >&2
  exit 1
fi
if grep -q -- '--context desktop-linux ps' "$LOG3"; then
  echo "unreachable daemons must not be queried for containers" >&2
  exit 1
fi

echo "case 4: escape hatch disables context enumeration"
LOG4="$TMP_DIR/docker4.log"
run_sourced "$LOG4" 'cleanup_project_on_other_docker_contexts || true' \
  FAKE_DESKTOP_MODE=other PORTICO_SKIP_CROSS_CONTEXT_CLEANUP=1
if grep -q -- 'context ls' "$LOG4"; then
  echo "escape hatch must skip docker context enumeration" >&2
  exit 1
fi

echo "case 5: compose port conflict emits PORT_CONFLICT diagnostic and self-heals once"
LOG5="$TMP_DIR/docker5.log"
STDERR5="$TMP_DIR/stderr5.log"
set +e
run_sourced "$LOG5" 'run_compose_up_with_retry "-f docker-compose.yml" ""' \
  FAKE_DESKTOP_MODE=other FAKE_LSOF_COMMAND=com.docker.backend 2>"$STDERR5"
rc=$?
set -e
if [ "$rc" -eq 0 ]; then
  echo "run_compose_up_with_retry must fail when every attempt hits the port conflict" >&2
  exit 1
fi
grep -q 'PORT_CONFLICT: host port 3835 is already in use (holder: Docker Desktop; active docker context: orbstack)' "$STDERR5"
[ "$(grep -c -- 'context ls' "$LOG5")" -eq 1 ] || {
  echo "cross-context cleanup must run exactly once across the retry loop" >&2
  exit 1
}
[ "$(grep -c -- ' up -d' "$LOG5")" -eq 3 ] || {
  echo "expected 3 compose up attempts" >&2
  exit 1
}
grep -q -- '--context desktop-linux rm -f stalecontainer1 stalecontainer2' "$LOG5"

echo "case 6: lsof COMMAND truncation still maps to Docker Desktop"
LOG6="$TMP_DIR/docker6.log"
STDERR6="$TMP_DIR/stderr6.log"
set +e
run_sourced "$LOG6" 'run_compose_up_with_retry "-f docker-compose.yml" ""' \
  FAKE_DESKTOP_MODE=other FAKE_LSOF_COMMAND=com.docke 2>"$STDERR6"
set -e
grep -q 'holder: Docker Desktop' "$STDERR6"

echo "case 7: unusable lsof degrades to holder: unknown without aborting"
LOG7="$TMP_DIR/docker7.log"
STDERR7="$TMP_DIR/stderr7.log"
set +e
run_sourced "$LOG7" 'run_compose_up_with_retry "-f docker-compose.yml" ""' \
  FAKE_DESKTOP_MODE=other FAKE_LSOF_MODE=fail 2>"$STDERR7"
set -e
grep -q 'PORT_CONFLICT: host port 3835 is already in use (holder: unknown' "$STDERR7"

echo "test-docker-compose-port-conflict-recovery.sh: all cases passed"
