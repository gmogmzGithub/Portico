#!/usr/bin/env bash
# PORTICO-236: the readiness wait budget must not tick while a live
# docker-compose.sh start run is still pulling images (before compose up).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
FAKE_BIN_DIR="$TMP_DIR/bin"
FIXTURE_DIR="$TMP_DIR/fixture"
RUNNING_FILE="$TMP_DIR/running-containers"
mkdir -p "$FAKE_BIN_DIR" "$FIXTURE_DIR/src/scripts" "$FIXTURE_DIR/health-status"

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

RUNNING_FILE="${RUNNING_FILE:?}"

if [[ "$1" == "info" ]]; then
  exit 0
fi

if [[ "$1" == "compose" ]]; then
  if [[ "$*" == *"version"* ]]; then
    echo "Docker Compose version v2.24.0"
    exit 0
  fi
  exit 0
fi

if [[ "$1" == "ps" ]]; then
  if [[ -f "$RUNNING_FILE" ]]; then
    cat "$RUNNING_FILE"
  fi
  exit 0
fi

if [[ "$1" == "image" && "${2:-}" == "inspect" ]]; then
  # Health-check image absent -> phase 2 is skipped ("Skipping UI check").
  exit 1
fi

exit 0
EOF
chmod +x "$FAKE_BIN_DIR/docker"

cp "$REPO_ROOT/src/scripts/check-containers-ready.sh" "$FIXTURE_DIR/src/scripts/check-containers-ready.sh"
cp "$REPO_ROOT/src/scripts/mcp-orc-backend.sh" "$FIXTURE_DIR/src/scripts/mcp-orc-backend.sh"

COMPOSE_UP_MARKER="$FIXTURE_DIR/health-status/compose_up_started"
DOCKER_START_MARKER="$FIXTURE_DIR/health-status/docker_start_in_progress"

ALL_CONTAINERS='chat-state-api
portico-mongodb
portico-redis
llm-gateway
mcpo
portico-open-webui'

PARTIAL_CONTAINERS='portico-mongodb
portico-redis'

run_readiness() {
  (
    cd "$FIXTURE_DIR"
    env \
      PATH="$FAKE_BIN_DIR:$PATH" \
      RUNNING_FILE="$RUNNING_FILE" \
      LLM_GATEWAY_MODE=bifrost \
      CONTAINER_READY_MAX_WAIT=6 \
      CONTAINER_READY_HARD_CAP=12 \
      bash src/scripts/check-containers-ready.sh
  )
}

echo "case 1: no markers + no containers -> paused until hard cap, existing timeout message"
rm -f "$COMPOSE_UP_MARKER" "$DOCKER_START_MARKER" "$RUNNING_FILE"
set +e
OUTPUT1="$(run_readiness 2>&1)"
rc=$?
set -e
[ "$rc" -ne 0 ] || { echo "expected timeout exit" >&2; exit 1; }
grep -q 'Waiting for Docker startup to reach compose up' <<<"$OUTPUT1"
grep -q 'Timeout waiting for containers after' <<<"$OUTPUT1"
if grep -q 'Waiting for containers (' <<<"$OUTPUT1"; then
  echo "budget must not tick before compose up begins" >&2
  exit 1
fi

echo "case 2: live start attempt + partial containers + no compose marker -> still paused"
printf '%s\n' "$PARTIAL_CONTAINERS" >"$RUNNING_FILE"
rm -f "$COMPOSE_UP_MARKER"
printf '%s\n' "$$" >"$DOCKER_START_MARKER"   # this test's PID is alive
set +e
OUTPUT2="$(run_readiness 2>&1)"
rc=$?
set -e
[ "$rc" -ne 0 ] || { echo "expected timeout exit" >&2; exit 1; }
grep -q 'Waiting for Docker startup to reach compose up' <<<"$OUTPUT2"
if grep -q 'Waiting for containers (' <<<"$OUTPUT2"; then
  echo "leftover infra containers must not start the budget while a live start attempt is pre-compose-up" >&2
  exit 1
fi

echo "case 3: dead-PID start attempt marker + partial containers -> budget ticks (crash degrade)"
printf '%s\n' "$PARTIAL_CONTAINERS" >"$RUNNING_FILE"
rm -f "$COMPOSE_UP_MARKER"
( true ) &
DEAD_PID=$!
wait "$DEAD_PID" 2>/dev/null || true
printf '%s\n' "$DEAD_PID" >"$DOCKER_START_MARKER"
set +e
OUTPUT3="$(run_readiness 2>&1)"
rc=$?
set -e
[ "$rc" -ne 0 ] || { echo "expected timeout exit" >&2; exit 1; }
grep -q 'Waiting for containers (' <<<"$OUTPUT3"

echo "case 4: compose marker present + partial containers -> budget ticks via marker"
printf '%s\n' "$PARTIAL_CONTAINERS" >"$RUNNING_FILE"
printf '%s\n' "$$" >"$DOCKER_START_MARKER"   # live attempt, but compose up has begun
printf '%s %s\n' "1234567890" "$$" >"$COMPOSE_UP_MARKER"
set +e
OUTPUT4="$(run_readiness 2>&1)"
rc=$?
set -e
[ "$rc" -ne 0 ] || { echo "expected timeout exit" >&2; exit 1; }
grep -q 'Waiting for containers (' <<<"$OUTPUT4"
grep -q 'Timeout waiting for containers after' <<<"$OUTPUT4"

echo "case 5: all containers running -> immediate success regardless of markers"
printf '%s\n' "$ALL_CONTAINERS" >"$RUNNING_FILE"
rm -f "$COMPOSE_UP_MARKER" "$DOCKER_START_MARKER"
OUTPUT5="$(run_readiness 2>&1)"
grep -q 'core containers are running' <<<"$OUTPUT5"
grep -q 'Skipping UI check' <<<"$OUTPUT5"

echo "test-check-containers-ready-compose-up-marker.sh: all cases passed"
