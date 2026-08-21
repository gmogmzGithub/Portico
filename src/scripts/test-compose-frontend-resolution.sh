#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
FAKE_BIN_DIR="$TMP_DIR/bin"
CALL_LOG="$TMP_DIR/calls.log"
mkdir -p "$FAKE_BIN_DIR" "$TMP_DIR/docker-config"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cat >"$FAKE_BIN_DIR/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf 'docker %s\n' "$*" >>"${CALL_LOG:?}"

if [[ "${1:-}" == "compose" && "${2:-}" == "version" ]]; then
  case "${PLUGIN_MODE:-missing}" in
    v2)
      printf 'Docker Compose version v2.39.1\n'
      exit 0
      ;;
    v1)
      printf 'docker-compose version 1.29.2\n'
      exit 0
      ;;
    *)
      printf 'docker: unknown command: docker compose\n' >&2
      exit 1
      ;;
  esac
fi

if [[ "${1:-}" == "compose" ]]; then
  if [[ "${PLUGIN_MODE:-missing}" == "v2" ]]; then
    printf 'plugin invocation: %s\n' "$*"
    exit 0
  fi
  printf "unknown shorthand flag: 'f' in -f\n\nUsage:  docker [OPTIONS] COMMAND [ARG...]\n" >&2
  exit 125
fi

exit 0
EOF
chmod +x "$FAKE_BIN_DIR/docker"

cat >"$FAKE_BIN_DIR/docker-compose" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf 'docker-compose %s\n' "$*" >>"${CALL_LOG:?}"

if [[ "${1:-}" == "version" ]]; then
  case "${STANDALONE_MODE:-missing}" in
    v2)
      printf 'Docker Compose version v5.1.2\n'
      exit 0
      ;;
    v1)
      printf 'docker-compose version 1.29.2, build deadbeef\n'
      exit 0
      ;;
    *)
      printf 'docker-compose: command not found\n' >&2
      exit 127
      ;;
  esac
fi

if [[ "${STANDALONE_MODE:-missing}" == "v2" ]]; then
  printf 'standalone invocation: %s\n' "$*"
  exit 0
fi

exit 127
EOF
chmod +x "$FAKE_BIN_DIR/docker-compose"

cat >"$FAKE_BIN_DIR/orbctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'orbctl %s\n' "$*" >>"${CALL_LOG:?}"
if [[ "${1:-}" == "status" ]]; then
  printf 'Running\n'
fi
exit 0
EOF
chmod +x "$FAKE_BIN_DIR/orbctl"

export PATH="$FAKE_BIN_DIR:$PATH"
export CALL_LOG
source "$REPO_ROOT/src/scripts/mcp-orc-backend.sh"

assert_equals() {
  local expected="$1"
  local actual="$2"
  local message="$3"
  if [[ "$actual" != "$expected" ]]; then
    printf 'FAIL: %s (expected=%s actual=%s)\n' "$message" "$expected" "$actual" >&2
    exit 1
  fi
}

PLUGIN_MODE=v2
STANDALONE_MODE=v2
export PLUGIN_MODE STANDALONE_MODE
reset_docker_compose_frontend_cache
resolve_docker_compose_frontend
assert_equals "docker-plugin" "$DOCKER_COMPOSE_FRONTEND_RESOLVED" "plugin should be preferred"
plugin_output="$(run_docker_compose -f compose.yml config)"
[[ "$plugin_output" == *"plugin invocation:"* ]]

PLUGIN_MODE=missing
STANDALONE_MODE=v2
DOCKER_CONFIG="$TMP_DIR/docker-config"
export PLUGIN_MODE STANDALONE_MODE DOCKER_CONFIG
reset_docker_compose_frontend_cache
resolve_docker_compose_frontend
assert_equals "standalone-v2" "$DOCKER_COMPOSE_FRONTEND_RESOLVED" "standalone v2 should recover a missing plugin"
standalone_output="$(run_docker_compose -f compose.yml config)"
[[ "$standalone_output" == *"standalone invocation:"* ]]

set +e
raw_failure="$(docker compose -f compose.yml config 2>&1)"
raw_status=$?
set -e
assert_equals "125" "$raw_status" "missing plugin reproduction should fail like OrbStack"
[[ "$raw_failure" == *"unknown shorthand flag: 'f' in -f"* ]]

PLUGIN_MODE=missing
STANDALONE_MODE=v1
export PLUGIN_MODE STANDALONE_MODE
reset_docker_compose_frontend_cache
set +e
resolve_docker_compose_frontend
v1_resolve_status=$?
set -e
assert_equals "1" "$v1_resolve_status" "standalone Compose v1 resolution must fail"
assert_equals "unavailable" "$DOCKER_COMPOSE_FRONTEND_RESOLVED" "v1 rejection should cache unavailable"
set +e
v1_failure="$(run_docker_compose -f compose.yml config 2>&1)"
v1_status=$?
set -e
assert_equals "125" "$v1_status" "standalone Compose v1 must be rejected"
[[ "$v1_failure" == *"DOCKER_COMPOSE_UNAVAILABLE"* ]]

PLUGIN_MODE=missing
STANDALONE_MODE=missing
export PLUGIN_MODE STANDALONE_MODE
reset_docker_compose_frontend_cache
set +e
missing_failure="$(run_docker_compose -p portico -f compose.yml up -d 2>&1)"
missing_status=$?
set -e
assert_equals "125" "$missing_status" "missing frontends should fail immediately"
[[ "$missing_failure" == *"DOCKER_COMPOSE_FRONTEND=unavailable"* ]]
[[ "$missing_failure" == *"DOCKER_COMPOSE_PLUGIN_PROBE="* ]]
[[ "$missing_failure" == *"DOCKER_COMPOSE_STANDALONE_PROBE="* ]]

source "$REPO_ROOT/src/scripts/prereq-docker-setup.sh"
ORBSTACK_APP_PATH="$TMP_DIR/OrbStack.app"
ORBSTACK_BIN_PATH="$FAKE_BIN_DIR"
ORBSTACK_XBIN_PATH="$FAKE_BIN_DIR"
OSTYPE="darwin-test"
mkdir -p "$ORBSTACK_APP_PATH"

: >"$CALL_LOG"
PLUGIN_MODE=missing
STANDALONE_MODE=v2
export PLUGIN_MODE STANDALONE_MODE
ensure_docker_compose_frontend >/dev/null
if grep -q '^orbctl restart -a$' "$CALL_LOG"; then
  printf 'FAIL: healthy standalone fallback must not restart OrbStack\n' >&2
  exit 1
fi

: >"$CALL_LOG"
PLUGIN_MODE=missing
STANDALONE_MODE=missing
export PLUGIN_MODE STANDALONE_MODE
set +e
prereq_failure="$(ensure_docker_compose_frontend 2>&1)"
prereq_status=$?
set -e
assert_equals "1" "$prereq_status" "prerequisites should fail closed without Compose"
assert_equals "1" "$(grep -c '^orbctl restart -a$' "$CALL_LOG")" "prerequisites should restart OrbStack at most once"
[[ "$prereq_failure" == *"[PREREQ:CODE:docker_compose_unavailable]"* ]]

printf 'Docker Compose frontend resolution tests passed\n'
