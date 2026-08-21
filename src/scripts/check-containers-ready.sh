#!/bin/bash
# ==============================================================================
# Simplified Container Readiness Check
# ==============================================================================
# This script checks:
#   1. If core containers are running (docker ps check)
#   2. If Open WebUI is actually ready to serve the UI (HTTP health + document check)
#
# It does NOT:
#   - Sync data to Open WebUI
#   - Install filters/agents
#   - Configure models/embeddings
#
# Used during loading screen to verify containers are up AND OWUI is serving.
# The full health check runs immediately after the main window opens.
# ==============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/mcp-orc-backend.sh"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color
PORTICO_INTERNAL_NO_PROXY_BASE_DEFAULT="localhost,127.0.0.1,::1,open-webui,portico-open-webui,llm-gateway,mcpo,mcpo-core,redis,portico-redis,mongodb,portico-mongodb,chat-state-api,open-webui-health-check,host.docker.internal"

append_internal_no_proxy_entry() {
  local current="$1"
  local entry="$2"
  [ -n "$entry" ] || {
    echo "$current"
    return
  }
  case ",$current," in
    *",$entry,"*) echo "$current" ;;
    *) echo "${current:+$current,}$entry" ;;
  esac
}

build_internal_no_proxy_default() {
  local result="$PORTICO_INTERNAL_NO_PROXY_BASE_DEFAULT"
  local routes_file="${PORTICO_SERVER_ROUTES_FILE:-mcpo-configs-generated/server-routing.json}"

  if [ -f "$routes_file" ] && command -v jq >/dev/null 2>&1; then
    local route_entry
    while IFS= read -r route_entry; do
      result="$(append_internal_no_proxy_entry "$result" "$route_entry")"
    done < <(
      jq -r 'to_entries[] | .value.compose_service?, .value.container_name?, .value.network_host? | select(type == "string" and length > 0)' "$routes_file" 2>/dev/null || true
    )
  fi

  echo "$result"
}

HEALTH_CHECK_IMAGE_FALLBACK="portico-health-check:latest"

resolve_health_check_image_from_harbor_compose() {
  local harbor_compose_file="${PORTICO_HARBOR_COMPOSE_FILE:-docker-compose.harbor.yml}"
  [ -f "$harbor_compose_file" ] || return 0

  awk '
    /^[[:space:]]*health-check:[[:space:]]*$/ {
      in_health_check = 1
      next
    }
    in_health_check && /^[[:space:]]*[A-Za-z0-9_.-]+:[[:space:]]*$/ && $0 !~ /^[[:space:]]*image:/ {
      exit
    }
    in_health_check && /^[[:space:]]*image:[[:space:]]*/ {
      sub(/^[[:space:]]*image:[[:space:]]*/, "")
      sub(/[[:space:]]+#.*$/, "")
      gsub(/"/, "")
      gsub(/^[[:space:]]+|[[:space:]]+$/, "")
      print
      exit
    }
  ' "$harbor_compose_file"
}

resolve_health_check_image() {
  if [ -n "${PORTICO_HEALTH_CHECK_IMAGE:-}" ]; then
    echo "$PORTICO_HEALTH_CHECK_IMAGE"
    return
  fi

  local harbor_image
  harbor_image="$(resolve_health_check_image_from_harbor_compose)"
  if [ -n "$harbor_image" ]; then
    echo "$harbor_image"
    return
  fi

  echo "$HEALTH_CHECK_IMAGE_FALLBACK"
}

resolve_llm_gateway_container_name() {
  echo "llm-gateway"
}

# Critical infrastructure containers that MUST start first
# These are foundational services that other containers depend on
CRITICAL_INFRASTRUCTURE=(
  "portico-redis"
  "portico-mongodb"
)

# Core containers required for chat functionality
# These are the minimum set of containers needed to open the main window
CORE_CONTAINERS=()

# Open WebUI can have different container names
OWUI_CONTAINER_NAMES=("portico-open-webui" "open-webui")

# Configuration
# PORTICO-236: MAX_WAIT is the post-compose-up wait budget. It only starts ticking
# once docker-compose.sh has actually reached compose up (phase markers below);
# before that, image pulls (packaged preflight) may legitimately take minutes.
MAX_WAIT="${CONTAINER_READY_MAX_WAIT:-120}"    # Wait budget in seconds once compose up has begun
CHECK_INTERVAL=3 # Check every 3 seconds
# Hard wall-clock cap for this whole phase, pull-pause included. Must stay
# below the Electron readiness invocation timeout (540s in main.js).
READINESS_HARD_CAP="${CONTAINER_READY_HARD_CAP:-420}"

# Phase markers written by docker-compose.sh start_containers (PORTICO-236)
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_UP_MARKER="$PROJECT_ROOT/health-status/compose_up_started"
DOCKER_START_MARKER="$PROJECT_ROOT/health-status/docker_start_in_progress"

# True while a docker-compose.sh "start" run is in flight and owned by a LIVE
# process. A marker left behind by a crashed run (dead PID) is ignored so we
# degrade to the pre-PORTICO-236 behavior instead of pausing forever.
docker_start_attempt_active() {
  local marker_pid=""
  [ -f "$DOCKER_START_MARKER" ] || return 1
  marker_pid="$(head -n 1 "$DOCKER_START_MARKER" 2>/dev/null | tr -dc '0-9')"
  [ -n "$marker_pid" ] || return 1
  kill -0 "$marker_pid" 2>/dev/null
}
LLM_GATEWAY_CONTAINER_NAME="$(resolve_llm_gateway_container_name)"
COMPOSE_FILES="-f docker-compose.yml -f docker-compose.advanced.yml"
CORE_CONTAINERS=(
  "chat-state-api"
  "portico-mongodb"
  "portico-redis"
  "$LLM_GATEWAY_CONTAINER_NAME"
  "mcpo"
)

if [ -f "docker-compose.override.yml" ]; then
  COMPOSE_FILES="$COMPOSE_FILES -f docker-compose.override.yml"
fi

echo -e "${GREEN}==================================================${NC}"
echo -e "${GREEN}  Simplified Container Readiness Check${NC}"
echo -e "${GREEN}==================================================${NC}"
echo ""
echo -e "${GREEN}LLM gateway: Bifrost bridge${NC}"
echo ""

# Check if Docker is running
if ! docker info >/dev/null 2>&1; then
  echo -e "${RED}Docker is not running${NC}"
  exit 1
fi

require_docker_compose_frontend || exit $?

echo -e "${GREEN}Docker is running${NC}"
echo ""

if [ -f "docker-compose.override.yml" ]; then
  while IFS= read -r service_name; do
    [ -n "$service_name" ] || continue
    case "$service_name" in
      mcpo|mcpo-core|open-webui|health-check|redis|mongodb|chat-state-api|llm-gateway)
        ;;
      mcpo-*)
        CORE_CONTAINERS+=("$service_name")
        ;;
    esac
  done < <(run_docker_compose $COMPOSE_FILES config --services 2>/dev/null || true)
elif docker ps -a --format "{{.Names}}" 2>/dev/null | grep -q "^mcpo-core$"; then
  CORE_CONTAINERS+=("mcpo-core")
fi

# First, verify critical infrastructure is running.
# During app startup, docker-compose.sh is already bringing the stack up in the
# background. This readiness script must stay read-only here or it races that
# compose-up path and produces duplicate container create conflicts.
echo -e "${YELLOW}Checking critical infrastructure...${NC}"
INFRA_MISSING=false
for infra in "${CRITICAL_INFRASTRUCTURE[@]}"; do
  if ! docker ps --format "{{.Names}}" 2>/dev/null | grep -q "^${infra}$"; then
    INFRA_MISSING=true
    echo -e "${RED}Critical infrastructure missing: $infra${NC}"
  fi
done

if $INFRA_MISSING; then
  echo -e "${YELLOW}Waiting for critical infrastructure to initialize via docker-compose.sh...${NC}"
  sleep 5
fi
echo ""

ELAPSED=0
WALL_ELAPSED=0
# Latches true once compose up has begun (marker) or containers are already
# being managed outside an active docker-compose.sh start run.
COMPOSE_PHASE_REACHED=false

while [ $ELAPSED -lt $MAX_WAIT ] && [ $WALL_ELAPSED -lt $READINESS_HARD_CAP ]; do
  ALL_RUNNING=true
  MISSING=""
  RUNNING_COUNT=0

  # Get list of running containers once
  RUNNING_CONTAINERS=$(docker ps --format "{{.Names}}" 2>/dev/null || echo "")

  # Check core containers
  for container in "${CORE_CONTAINERS[@]}"; do
    if echo "$RUNNING_CONTAINERS" | grep -q "^${container}$"; then
      ((RUNNING_COUNT++)) || true
    else
      ALL_RUNNING=false
      MISSING="$MISSING $container"
    fi
  done

  # Check Open WebUI (can have multiple names)
  OWUI_FOUND=false
  for owui_name in "${OWUI_CONTAINER_NAMES[@]}"; do
    if echo "$RUNNING_CONTAINERS" | grep -q "^${owui_name}$"; then
      OWUI_FOUND=true
      ((RUNNING_COUNT++)) || true
      break
    fi
  done

  if ! $OWUI_FOUND; then
    ALL_RUNNING=false
    MISSING="$MISSING open-webui"
  fi

  TOTAL_EXPECTED=$((${#CORE_CONTAINERS[@]} + 1)) # +1 for Open WebUI

  if $ALL_RUNNING; then
    echo ""
    echo -e "${GREEN}All $TOTAL_EXPECTED core containers are running${NC}"
    break
  fi

  # PORTICO-236: decide whether the wait budget should be ticking yet.
  if [ "$COMPOSE_PHASE_REACHED" = false ]; then
    if [ -f "$COMPOSE_UP_MARKER" ]; then
      COMPOSE_PHASE_REACHED=true
    elif [ "$RUNNING_COUNT" -gt 0 ] && ! docker_start_attempt_active; then
      # Containers exist and no live docker-compose.sh start run owns the
      # phase (standalone invocation / stack already up) — count normally.
      COMPOSE_PHASE_REACHED=true
    fi
  fi

  # Show progress
  if [ "$COMPOSE_PHASE_REACHED" = true ]; then
    echo -e "${YELLOW}Waiting for containers ($RUNNING_COUNT/$TOTAL_EXPECTED running, ${ELAPSED}s/${MAX_WAIT}s)...${NC}"
    if [ -n "$MISSING" ]; then
      echo -e "  Missing:$MISSING"
    fi
  else
    echo -e "${YELLOW}Waiting for Docker startup to reach compose up (images may still be downloading) (${WALL_ELAPSED}s/${READINESS_HARD_CAP}s)...${NC}"
  fi

  sleep $CHECK_INTERVAL
  WALL_ELAPSED=$((WALL_ELAPSED + CHECK_INTERVAL))
  if [ "$COMPOSE_PHASE_REACHED" = true ]; then
    ELAPSED=$((ELAPSED + CHECK_INTERVAL))
  fi
done

# Timeout reached - only gets here if loop didn't break
if ! $ALL_RUNNING; then
  echo ""
  echo -e "${RED}Timeout waiting for containers after ${WALL_ELAPSED} seconds (wait budget ${MAX_WAIT}s after compose up, wall cap ${READINESS_HARD_CAP}s)${NC}"
  echo -e "${RED}Missing containers:$MISSING${NC}"
  exit 1
fi

# ==============================================================================
# Phase 2: Check Open WebUI readiness over HTTP
# ==============================================================================
# Uses the configured health-check Docker image as a lightweight
# network probe. This verifies Open WebUI is healthy and serving its frontend
# document without relying on Playwright in the image or on the host.
# ==============================================================================

echo ""
echo -e "${GREEN}==================================================${NC}"
echo -e "${GREEN}  Checking Open WebUI Readiness${NC}"
echo -e "${GREEN}==================================================${NC}"
echo ""

HEALTH_CHECK_IMAGE="$(resolve_health_check_image)"
echo -e "${GREEN}Using health-check image: ${HEALTH_CHECK_IMAGE}${NC}"
echo ""

# Check if the health-check image exists
if ! docker image inspect "$HEALTH_CHECK_IMAGE" >/dev/null 2>&1; then
  echo -e "${YELLOW}Health check image not found: ${HEALTH_CHECK_IMAGE}${NC}"
  if [ "$HEALTH_CHECK_IMAGE" = "$HEALTH_CHECK_IMAGE_FALLBACK" ]; then
    echo -e "${YELLOW}Build it with: docker build -f Dockerfile.health-check -t portico-health-check .${NC}"
  fi
  echo -e "${YELLOW}Skipping UI check${NC}"
  exit 0
fi

# Detect if Open WebUI is bootstrapping (first run) by checking container logs.
# First-run setup (git clone + npm + pip) takes ~5 minutes; normal restarts are fast.
OWUI_BOOTSTRAPPING=false
OWUI_CONTAINER=""
for owui_name in "${OWUI_CONTAINER_NAMES[@]}"; do
  if docker ps --format "{{.Names}}" 2>/dev/null | grep -q "^${owui_name}$"; then
    OWUI_CONTAINER="$owui_name"
    break
  fi
done

if [ -n "$OWUI_CONTAINER" ]; then
  OWUI_RECENT_LOGS=$(docker logs --tail 30 "$OWUI_CONTAINER" 2>&1 || true)
  # These messages only appear during first-run bootstrap
  if echo "$OWUI_RECENT_LOGS" | grep -qE '(Cloning Open WebUI|Installing npm dependencies|Installing Python dependencies|Creating Python virtualenv|Installing build dependencies)'; then
    OWUI_BOOTSTRAPPING=true
  fi
fi

if $OWUI_BOOTSTRAPPING; then
  OWUI_MAX_ATTEMPTS=72   # 72 × 5s = 6 minutes
  echo -e "${YELLOW}⏳ First-run setup detected — Open WebUI is installing dependencies.${NC}"
  echo -e "${YELLOW}   This typically takes 3-5 minutes on first launch. Subsequent starts are fast.${NC}"
  echo ""
else
  OWUI_MAX_ATTEMPTS=20   # 20 × 5s = 100 seconds (normal restart)
fi

# Run the HTTP-based OWUI readiness check using the Rust health-check binary.
PORTICO_INTERNAL_NO_PROXY_DEFAULT="$(build_internal_no_proxy_default)"
if docker run --rm \
  --network portico-network \
  --name owui-ready-check \
  -e NO_PROXY="${NO_PROXY:-},${PORTICO_INTERNAL_NO_PROXY:-$PORTICO_INTERNAL_NO_PROXY_DEFAULT}" \
  -e no_proxy="${no_proxy:-},${PORTICO_INTERNAL_NO_PROXY:-$PORTICO_INTERNAL_NO_PROXY_DEFAULT}" \
  -e REQUIRE_BIFROST_READY=true \
  -e OWUI_MAX_ATTEMPTS="$OWUI_MAX_ATTEMPTS" \
  -e OWUI_BOOTSTRAPPING="$OWUI_BOOTSTRAPPING" \
  "$HEALTH_CHECK_IMAGE" \
  /usr/local/bin/health-check-rust startup-readiness
then
  OWUI_CHECK_RESULT=0
else
  OWUI_CHECK_RESULT=$?
fi

if [ $OWUI_CHECK_RESULT -eq 0 ]; then
  echo ""
  echo -e "${GREEN}✅ Open WebUI is ready${NC}"
  exit 0
else
  echo ""
  if $OWUI_BOOTSTRAPPING; then
    echo -e "${RED}❌ Open WebUI first-run setup did not complete in time${NC}"
    echo -e "${YELLOW}   This can happen on slow networks. Try restarting the app — cached deps will make it faster.${NC}"
    echo -e "${YELLOW}   To check progress: docker logs -f ${OWUI_CONTAINER:-portico-open-webui}${NC}"
  else
    echo -e "${RED}❌ Some containers failed to start.${NC}"
    echo -e "${RED}   Please check Docker logs for more details.${NC}"
  fi
  exit 1
fi
