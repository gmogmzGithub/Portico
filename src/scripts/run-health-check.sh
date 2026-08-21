#!/bin/bash
# Health Check Runner - Re-runs only the health-check container

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
# Script now lives in src/scripts - project root is two levels up
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
source "$SCRIPT_DIR/mcp-orc-backend.sh"

cd "$PROJECT_ROOT"

# Import timezone and build detection functions from docker-compose.sh
# We extract and inline only what we need to avoid executing the full script

# Source only the function definitions, not the main execution
# We do this by setting a flag to prevent the main case statement from running
SKIP_MAIN_EXECUTION=1
source "$SCRIPT_DIR/docker-compose.sh" 2>/dev/null || {
  # Fallback: set defaults if sourcing fails
  export TZ=${TZ:-UTC}
  export PORTICO_BUILD_TRACK=${PORTICO_BUILD_TRACK:-dev-build}
}

MODE="full"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      MODE="$2"
      shift 2
      ;;
    --light)
      MODE="light"
      shift
      ;;
    --full)
      MODE="full"
      shift
      ;;
    --startup-core)
      MODE="startup-core"
      shift
      ;;
    *)
      shift
      ;;
  esac
done

if [[ "$MODE" != "light" && "$MODE" != "full" && "$MODE" != "startup-core" ]]; then
  echo "⚠️  Unknown health check mode '$MODE', defaulting to full"
  MODE="full"
fi

ensure_host_mode_mount_file() {
  local host_mode_file="$PROJECT_ROOT/HOST_MODE"

  if [[ -d "$host_mode_file" && ! -L "$host_mode_file" ]]; then
    echo "⚠️  Found directory at HOST_MODE bind source; replacing it with an empty file"
    rm -rf "$host_mode_file"
  fi

  if [[ ! -e "$host_mode_file" ]]; then
    : > "$host_mode_file"
    echo "✓ Created missing HOST_MODE bind source"
  elif [[ ! -f "$host_mode_file" ]]; then
    echo "❌ HOST_MODE bind source exists but is not a regular file: $host_mode_file" >&2
    exit 1
  fi
}

resolve_node_for_health_runner() {
  local candidate
  for candidate in \
    "${NODE_BINARY:-}" \
    "${HOST_NODE_PATH:-}" \
    "$(command -v node 2>/dev/null || true)" \
    /usr/local/bin/node \
    /opt/homebrew/bin/node \
    "$HOME/.local/bin/node"; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  local nvm_root="${NVM_DIR:-$HOME/.nvm}"
  for candidate in "$nvm_root"/versions/node/*/bin/node; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  local install_root install_dir
  for install_root in "$HOME/.local/lib/nodejs" /usr/local/lib/nodejs; do
    for install_dir in "$install_root"/node-*/bin; do
      candidate="$install_dir/node"
      if [[ -x "$candidate" ]]; then
        printf '%s\n' "$candidate"
        return 0
      fi
    done
  done

  return 1
}

sync_mcp_toggle_snapshot() {
  local source_file="$PROJECT_ROOT/mcp_toggles.json"
  local snapshot_dir="$PROJECT_ROOT/health-status"
  local snapshot_file="$snapshot_dir/mcp_toggles_snapshot.json"
  local node_bin

  mkdir -p "$snapshot_dir"

  # Electron normalizes and atomically writes this snapshot before launching
  # the runner. Basic installs intentionally omit host Node.js, so trust only
  # that exact handoff and keep every direct invocation on the existing path.
  if [[ "${HEALTH_SYNC_TOGGLE_SNAPSHOT_READY:-}" == "1" ]]; then
    if [[ -f "$snapshot_file" && -s "$snapshot_file" && ! -L "$snapshot_file" ]]; then
      echo "✓ Using MCP toggle snapshot normalized by the host app"
      return 0
    fi
    echo "❌ Host-prepared MCP toggle snapshot is missing or invalid: $snapshot_file" >&2
    return 1
  fi

  node_bin="$(resolve_node_for_health_runner || true)"
  if [[ -z "$node_bin" ]]; then
    echo "❌ Node.js is required to normalize MCP toggle state before health checks" >&2
    return 1
  fi

  if ! "$node_bin" "$SCRIPT_DIR/normalize-mcp-toggles.js" \
    --project-root "$PROJECT_ROOT" \
    --snapshot "$snapshot_file" \
    --reason "run-health-check" >/dev/null; then
    echo "❌ MCP toggle source could not be normalized; refusing to publish a health snapshot: $source_file" >&2
    return 1
  fi
}

MODE_FILE="$PROJECT_ROOT/health-status/health_check_mode"
SESSION_ID_FILE="$PROJECT_ROOT/health-status/health_sync_session_id"
RUN_ID_FILE="$PROJECT_ROOT/health-status/health_sync_run_id"
REASON_FILE="$PROJECT_ROOT/health-status/health_sync_reason"
TIMEOUT_BUDGET_FILE="$PROJECT_ROOT/health-status/health_sync_timeout_budget_ms"
mkdir -p "$(dirname "$MODE_FILE")"
sync_mcp_toggle_snapshot
echo "$MODE" > "$MODE_FILE"

if [[ -n "${HEALTH_SYNC_SESSION_ID:-}" ]]; then
  echo "$HEALTH_SYNC_SESSION_ID" > "$SESSION_ID_FILE"
fi

trim_health_sync_metadata_value() {
  printf '%s' "$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

write_health_sync_metadata_file() {
  local env_name="$1"
  local target_file="$2"
  local raw_value="${!env_name:-}"
  local trimmed_value
  trimmed_value="$(trim_health_sync_metadata_value "$raw_value")"

  if [[ -n "$trimmed_value" ]]; then
    printf '%s\n' "$trimmed_value" > "$target_file"
  else
    rm -f "$target_file"
  fi
}

write_health_sync_metadata_file "HEALTH_SYNC_RUN_ID" "$RUN_ID_FILE"
write_health_sync_metadata_file "HEALTH_SYNC_REASON" "$REASON_FILE"
write_health_sync_metadata_file "HEALTH_SYNC_TIMEOUT_BUDGET_MS" "$TIMEOUT_BUDGET_FILE"

echo "🏥 Running health check..."
echo "Environment: TZ=$TZ, PORTICO_BUILD_TRACK=$PORTICO_BUILD_TRACK"
echo "Health check mode: $MODE (mode file: $MODE_FILE)"
echo "Health check implementation: rust"
if [[ -n "${HEALTH_SYNC_SESSION_ID:-}" ]]; then
  echo "Health sync session: $HEALTH_SYNC_SESSION_ID"
fi

# Ensure the health-check container exists before starting it
CONTAINER_NAME="open-webui-health-check"
if ! docker ps -a --format "{{.Names}}" | grep -q "^${CONTAINER_NAME}$"; then
  echo "⚠️  Health check container not found, creating it..."
  ensure_host_mode_mount_file
  if declare -f up_container >/dev/null 2>&1; then
    up_container "health-check" "--no-deps"
  else
    # PORTICO-236: never let the raw fallback attempt a local Dockerfile build —
    # packaged builds do not ship Dockerfile.health-check.
    run_docker_compose up -d --no-deps --no-build health-check
  fi
fi

# If the container is already running (e.g., auto-started during docker startup),
# stop it first so this invocation can apply the requested mode/session deterministically.
RUNNING_STATE="$(docker inspect --format='{{.State.Running}}' "${CONTAINER_NAME}" 2>/dev/null || echo "false")"
if [[ "$RUNNING_STATE" == "true" ]]; then
  echo "ℹ️  Health check container already running; restarting to apply mode/session settings..."
  docker stop "${CONTAINER_NAME}" >/dev/null 2>&1 || true
fi

ensure_host_mode_mount_file

# Start health check container
# Note: docker start returns immediately - container runs asynchronously
docker start "${CONTAINER_NAME}" >/dev/null

if [ $? -ne 0 ]; then
  echo "❌ Failed to start health check container"
  exit 1
fi

# Wait for container to complete - this blocks until health check finishes
# This ensures we read the updated health_status.json file, not stale data
echo "⏳ Waiting for health check container to complete..."
docker wait open-webui-health-check

# Get the exit code from the container
EXIT_CODE=$(docker inspect --format='{{.State.ExitCode}}' open-webui-health-check 2>/dev/null || echo "1")

if [ "$EXIT_CODE" = "0" ]; then
  echo "✅ Health check passed"
else
  echo "❌ Health check failed with exit code $EXIT_CODE"
fi

exit $EXIT_CODE
