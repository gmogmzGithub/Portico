#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
FAKE_BIN_DIR="$TMP_DIR/bin"
LOG_FILE="$TMP_DIR/docker.log"
PS_COUNTER_FILE="$TMP_DIR/ps-counter"
HARBOR_COMPOSE_FILE="$TMP_DIR/docker-compose.harbor.yml"
mkdir -p "$FAKE_BIN_DIR"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cat >"$FAKE_BIN_DIR/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

LOG_FILE="${LOG_FILE:?}"
PS_COUNTER_FILE="${PS_COUNTER_FILE:?}"
printf '%s\n' "$*" >>"$LOG_FILE"

if [[ "$1" == "info" ]]; then
  exit 0
fi

if [[ "$1" == "compose" ]]; then
  if [[ "$*" == *"config --services"* ]]; then
    cat <<'SERVICES'
mcpo
mcpo-glean
mcpo-google_workspace
health-check
redis
mongodb
chat-state-api
llm-gateway
open-webui
SERVICES
    exit 0
  fi
  echo "unexpected docker compose invocation: $*" >&2
  exit 97
fi

if [[ "$1" == "ps" ]]; then
  count=0
  if [[ -f "$PS_COUNTER_FILE" ]]; then
    count="$(cat "$PS_COUNTER_FILE")"
  fi
  count=$((count + 1))
  printf '%s' "$count" >"$PS_COUNTER_FILE"

  if [[ "$count" -le 2 ]]; then
    exit 0
  fi

  cat <<'CONTAINERS'
chat-state-api
portico-mongodb
portico-redis
llm-gateway
mcpo
mcpo-glean
mcpo-google_workspace
portico-open-webui
CONTAINERS
  exit 0
fi

if [[ "$1" == "image" && "${2:-}" == "inspect" ]]; then
  exit 0
fi

if [[ "$1" == "run" ]]; then
  exit 0
fi

echo "unexpected docker invocation: $*" >&2
exit 98
EOF
chmod +x "$FAKE_BIN_DIR/docker"

cat >"$HARBOR_COMPOSE_FILE" <<'EOF'
services:
  health-check:
    image: harbor.example.invalid/portico/health-check:05122026-a2afc304
EOF

OUTPUT="$(
  cd "$REPO_ROOT"
  PATH="$FAKE_BIN_DIR:$PATH" LOG_FILE="$LOG_FILE" PS_COUNTER_FILE="$PS_COUNTER_FILE" \
    DOCKER_COMPOSE_FRONTEND_RESOLVED=docker-plugin \
    PORTICO_HARBOR_COMPOSE_FILE="$HARBOR_COMPOSE_FILE" \
    LLM_GATEWAY_MODE=bifrost \
    bash src/scripts/check-containers-ready.sh
)"

if grep -q 'compose .* up -d .*redis' "$LOG_FILE"; then
  echo "check-containers-ready.sh should not start redis itself during startup readiness" >&2
  exit 1
fi

if grep -q 'compose .* up -d .*mongodb' "$LOG_FILE"; then
  echo "check-containers-ready.sh should not start mongodb itself during startup readiness" >&2
  exit 1
fi

if grep -q 'python -c' "$LOG_FILE"; then
  echo "check-containers-ready.sh should not run a Python readiness probe" >&2
  exit 1
fi

if ! grep -q 'image inspect harbor.example.invalid/portico/health-check:05122026-a2afc304' "$LOG_FILE"; then
  echo "check-containers-ready.sh should inspect the build-pinned health-check image" >&2
  exit 1
fi

if ! grep -q 'run .*harbor.example.invalid/portico/health-check:05122026-a2afc304 /usr/local/bin/health-check-rust startup-readiness' "$LOG_FILE"; then
  echo "check-containers-ready.sh should run the Rust startup-readiness probe from the build-pinned image" >&2
  exit 1
fi

grep -q 'Waiting for critical infrastructure to initialize via docker-compose.sh' <<<"$OUTPUT"

echo "check-containers-ready.sh waits for infrastructure instead of racing docker-compose startup"
