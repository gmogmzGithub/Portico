#!/usr/bin/env bash
# PORTICO-236: packaged runtime must never fall back to local Dockerfile builds
# when up_container/up_containers cannot use Harbor images (the background
# health check used to attempt `docker compose build` and fail on the missing
# Dockerfile.health-check in packaged installs).
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

cat >"$FAKE_BIN_DIR/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

LOG_FILE="${LOG_FILE:?}"
printf '%s\n' "$*" >>"$LOG_FILE"
args="$*"

if [[ "$1" == "info" ]]; then
  # No daemon ID output -> cross-context cleanup bails out harmlessly.
  exit 0
fi

if [[ "$1" == "context" ]]; then
  exit 0
fi

if [[ "$1" == "ps" ]]; then
  exit 0
fi

if [[ "$1" == "inspect" ]]; then
  printf 'running\n'
  exit 0
fi

if [[ "$1" == "compose" ]]; then
  if [[ "${2:-}" == "version" ]]; then
    printf 'Docker Compose version v2.39.1\n'
    exit 0
  fi
  if [[ "$args" == *"config --services"* ]]; then
    printf 'redis\nmongodb\nhealth-check\n'
    exit 0
  fi
  if [[ "$args" == *" up -d"* ]]; then
    exit 0
  fi
  exit 0
fi

exit 0
EOF
chmod +x "$FAKE_BIN_DIR/docker"

create_fixture() {
  mkdir -p "$FIXTURE_DIR/src/scripts" "$FIXTURE_DIR/electron-app"

  cp "$REPO_ROOT/src/scripts/docker-compose.sh" "$FIXTURE_DIR/src/scripts/docker-compose.sh"
  chmod +x "$FIXTURE_DIR/src/scripts/docker-compose.sh"
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

  # Packaged-ness is env-driven so both branches are testable.
  cat >"$FIXTURE_DIR/src/scripts/managed-runtime-integrity.sh" <<'EOF'
managed_runtime_is_packaged_runtime() {
  [ "${FAKE_PACKAGED_RUNTIME:-0}" = "1" ]
}
managed_runtime_self_heal_packaged_runtime() {
  return 0
}
EOF

  cat >"$FIXTURE_DIR/electron-app/build-info.json" <<'EOF'
{"buildNumber":"07072026-4d073bb9"}
EOF

  # NOTE: no docker-compose.harbor.yml on purpose — check_harbor_images_available
  # must fail, which is exactly the state the PORTICO-236 bundle captured (fresh
  # daemon without pulled Harbor images).
  touch \
    "$FIXTURE_DIR/.env" \
    "$FIXTURE_DIR/docker-compose.yml" \
    "$FIXTURE_DIR/docker-compose.advanced.yml" \
    "$FIXTURE_DIR/docker-compose.bifrost.yml"
}

create_fixture

run_compose_script() {
  local log_file="$1"
  local packaged="$2"
  shift 2
  : >"$log_file"
  (
    cd "$FIXTURE_DIR"
    env \
      PATH="$FAKE_BIN_DIR:$PATH" \
      LOG_FILE="$log_file" \
      LLM_GATEWAY_MODE=bifrost \
      MCP_ORC_MODE=rust-full \
      FAKE_PACKAGED_RUNTIME="$packaged" \
      bash src/scripts/docker-compose.sh "$@"
  )
}

echo "case 1: packaged runtime refuses up-container without Harbor images"
LOG1="$TMP_DIR/docker1.log"
STDERR1="$TMP_DIR/stderr1.log"
set +e
run_compose_script "$LOG1" 1 up-container health-check --no-deps 2>"$STDERR1"
rc=$?
set -e
if [ "$rc" -eq 0 ]; then
  echo "up-container must fail in packaged runtime when Harbor images are unavailable" >&2
  exit 1
fi
grep -q "Packaged runtime requires Harbor images for build 07072026-4d073bb9" "$STDERR1"
grep -q "refusing to start service 'health-check'" "$STDERR1"
if grep -q -- ' up -d' "$LOG1"; then
  echo "packaged refusal must happen before any docker compose up" >&2
  exit 1
fi

echo "case 2: packaged runtime refuses up-containers without Harbor images"
LOG2="$TMP_DIR/docker2.log"
STDERR2="$TMP_DIR/stderr2.log"
set +e
run_compose_script "$LOG2" 1 up-containers health-check mcpo --no-deps 2>"$STDERR2"
rc=$?
set -e
if [ "$rc" -eq 0 ]; then
  echo "up-containers must fail in packaged runtime when Harbor images are unavailable" >&2
  exit 1
fi
grep -q "Packaged runtime requires Harbor images for build 07072026-4d073bb9" "$STDERR2"
if grep -q -- ' up -d' "$LOG2"; then
  echo "packaged refusal must happen before any docker compose up" >&2
  exit 1
fi

echo "case 3: non-packaged (dev) up-container still proceeds without Harbor images"
LOG3="$TMP_DIR/docker3.log"
STDERR3="$TMP_DIR/stderr3.log"
run_compose_script "$LOG3" 0 up-container health-check --no-deps 2>"$STDERR3"
grep -q -- ' up -d.*--no-deps health-check' "$LOG3"

echo "test-docker-compose-packaged-up-container-guard.sh: all cases passed"
