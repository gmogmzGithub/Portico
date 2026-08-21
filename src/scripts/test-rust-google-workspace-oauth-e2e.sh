#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
source "$SCRIPT_DIR/mcp-orc-backend.sh"

PROJECT_NAME="portico-rust-google-workspace-oauth-e2e"
SERVER_ID="google_workspace"
SERVER_ALIAS="${SERVER_ID//_/-}"
HOST_PORT="${HOST_PORT:-8776}"
CALLBACK_HOST_PORT="${CALLBACK_HOST_PORT:-3844}"
TEMP_DIR="$(mktemp -d)"
COMPOSE_FILE="$TEMP_DIR/docker-compose.yml"
CONFIG_JSON="$TEMP_DIR/${SERVER_ID}.json"
ROUTES_JSON="$TEMP_DIR/server-routing.json"
OPENAPI_JSON="$TEMP_DIR/openapi.json"
STATUS_JSON="$TEMP_DIR/status.json"
OAUTH_JSON="$TEMP_DIR/oauth-status.json"
CALENDARS_JSON="$TEMP_DIR/calendars.json"
LABELS_JSON="$TEMP_DIR/labels.json"
LOGS_TXT="$TEMP_DIR/runtime.log"

RUNTIME_IMAGE="$(mcp_orc_local_image_name full rust)"
CONTROL_PLANE_IMAGE="$(mcpo_control_plane_local_image_name rust)"

cleanup() {
    docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" down --volumes --remove-orphans >/dev/null 2>&1 || true
    if [ "${KEEP_TEMP_DIR:-0}" != "1" ]; then
        rm -rf "$TEMP_DIR"
    fi
}

trap cleanup EXIT

on_error() {
    local exit_code="$?"
    echo
    echo "Rust Google Workspace OAuth e2e test failed. Capturing diagnostics..." >&2
    docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" ps >&2 || true
    echo >&2
    docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" logs --tail 200 >&2 || true
    echo >&2
    echo "Temporary files: $TEMP_DIR" >&2
    exit "$exit_code"
}

trap on_error ERR

require_command() {
    local command_name="$1"
    if ! command -v "$command_name" >/dev/null 2>&1; then
        echo "Missing required command: $command_name" >&2
        exit 1
    fi
}

require_command docker
require_command jq
require_command curl

cd "$PROJECT_ROOT"

OAUTH_BROKER_TOKEN_ENV="portico_OAUTH_ACCESS_TOKEN_TOKEN_GOOGLE_WORKSPACE"
if [ -z "${portico_OAUTH_ACCESS_TOKEN_TOKEN_GOOGLE_WORKSPACE:-}" ]; then
    BRIDGE_AUTH_REGISTRY="${HOST_MCP_BRIDGE_AUTH_REGISTRY:-$HOME/Library/Application Support/portico/host-mcp-bridge/auth-registry.json}"
    if [ ! -r "$BRIDGE_AUTH_REGISTRY" ]; then
        echo "Missing Host MCP Bridge auth registry for the credential-backed Google Workspace OAuth e2e test." >&2
        echo "Start Portico or set $OAUTH_BROKER_TOKEN_ENV explicitly." >&2
        exit 1
    fi

    OAUTH_BROKER_TOKEN_FILE="$(
        jq -r --arg scope "oauth:access-token:$SERVER_ID" '
            .tokens[]
            | select(.revoked != true and (.scopes | index($scope) != null))
            | .tokenFile
        ' "$BRIDGE_AUTH_REGISTRY" | head -n 1
    )"
    if [ -z "$OAUTH_BROKER_TOKEN_FILE" ] || [ ! -r "$OAUTH_BROKER_TOKEN_FILE" ]; then
        echo "Missing scoped Host MCP Bridge credential for Google Workspace." >&2
        echo "Start Portico once to provision it or set $OAUTH_BROKER_TOKEN_ENV explicitly." >&2
        exit 1
    fi
    portico_OAUTH_ACCESS_TOKEN_TOKEN_GOOGLE_WORKSPACE="$(tr -d '\r\n' < "$OAUTH_BROKER_TOKEN_FILE")"
    export portico_OAUTH_ACCESS_TOKEN_TOKEN_GOOGLE_WORKSPACE
    if [ -z "$portico_OAUTH_ACCESS_TOKEN_TOKEN_GOOGLE_WORKSPACE" ]; then
        echo "Scoped Host MCP Bridge credential for Google Workspace is empty." >&2
        exit 1
    fi
    if ! curl -fsS --max-time 5 "http://127.0.0.1:8891/health" >/dev/null 2>&1; then
        echo "Host MCP Bridge is not available for the credential-backed Google Workspace OAuth e2e test." >&2
        echo "Start Portico or provide a reachable portico_OAUTH_ACCESS_TOKEN_BROKER_URL." >&2
        exit 1
    fi
    if ! curl -fsS --max-time 20 \
        -X POST "http://127.0.0.1:8891/secrets/oauth/access-token" \
        -H "Authorization: Bearer $portico_OAUTH_ACCESS_TOKEN_TOKEN_GOOGLE_WORKSPACE" \
        -H 'Content-Type: application/json' \
        -d "{\"server_id\":\"$SERVER_ID\",\"force_refresh\":true}" \
        >/dev/null; then
        echo "Host MCP Bridge could not refresh the persisted Google Workspace access token." >&2
        exit 1
    fi
fi

if [ "${FORCE_BUILD:-0}" = "1" ] || ! docker image inspect "$RUNTIME_IMAGE" >/dev/null 2>&1; then
    docker build -f Dockerfile.mcp-orc-rust -t "$RUNTIME_IMAGE" .
fi

if [ "${FORCE_BUILD:-0}" = "1" ] || ! docker image inspect "$CONTROL_PLANE_IMAGE" >/dev/null 2>&1; then
    docker build -f Dockerfile.mcpo-control-plane-rust -t "$CONTROL_PLANE_IMAGE" .
fi

jq -n \
    --arg id "$SERVER_ID" \
    --slurpfile fragment "$PROJECT_ROOT/mcp-configs/$SERVER_ID/$SERVER_ID.fragment" \
    '{
      mcpServers: {
        ($id): $fragment[0]
      }
    }' > "$CONFIG_JSON"

jq -n \
    --arg id "$SERVER_ID" \
    --arg alias "$SERVER_ALIAS" \
    '{
      ($id): {
        compose_service: "mcpo-google_workspace",
        container_name: "mcpo-google_workspace",
        deployment_scope: "docker",
        grouped: false,
        group_id: null,
        network_host: ("mcpo-" + $alias),
        port: 8000
      }
    }' > "$ROUTES_JSON"

cat > "$COMPOSE_FILE" <<COMPOSE_EOF
name: $PROJECT_NAME

services:
  mcpo:
    image: $CONTROL_PLANE_IMAGE
    ports:
      - "${HOST_PORT}:80"
      - "${CALLBACK_HOST_PORT}:3834"
    volumes:
      - $PROJECT_ROOT/src/mcpo-nginx.conf:/etc/nginx/nginx.conf:ro
      - $PROJECT_ROOT/src/mcpo-core-nginx.conf:/etc/nginx/conf.d/mcpo-core.conf:ro
      - $ROUTES_JSON:/app/mcpo-configs-generated/server-routing.json:ro
    environment:
      - MCPO_SERVERS=$SERVER_ID
      - MCPO_CORE_SERVERS=
      - MCPO_REGULAR_AGGREGATOR_PORT=8080
      - MCPO_CORE_AGGREGATOR_PORT=8082
      - MCPO_SERVER_ROUTES_FILE=/app/mcpo-configs-generated/server-routing.json
    depends_on:
      - mcpo-google_workspace
    extra_hosts:
      - "host.docker.internal:host-gateway"
    networks:
      default:
        aliases:
          - mcpo

  mcpo-google_workspace:
    image: $RUNTIME_IMAGE
    volumes:
      - $CONFIG_JSON:/app/mcp_config.json:ro
    tmpfs:
      - /root/.mcpo:mode=700
    environment:
      - TZ=\${TZ:-UTC}
      - CONFIG_FILE=mcp_config.json
      - MCPO_OAUTH_CALLBACK_PORT=$CALLBACK_HOST_PORT
      - LOG_LEVEL=\${MCPO_LOG_LEVEL:-INFO}
      - DEBUG=\${MCP_DEBUG:-}
      - PYTHONUNBUFFERED=1
      - MCP_ORC_BACKEND=rust
      - MCP_ORC_NATIVE_MODE=native
      - portico_OAUTH_ACCESS_TOKEN_BROKER_URL=\${portico_OAUTH_ACCESS_TOKEN_BROKER_URL:-http://host.docker.internal:8891/secrets/oauth/access-token}
      - portico_OAUTH_ACCESS_TOKEN_SERVER_ID=$SERVER_ID
      - portico_OAUTH_ACCESS_TOKEN_BROKER_TOKEN=\${portico_OAUTH_ACCESS_TOKEN_TOKEN_GOOGLE_WORKSPACE:-}
    extra_hosts:
      - "host.docker.internal:host-gateway"
    networks:
      default:
        aliases:
          - mcpo-$SERVER_ID
          - mcpo-$SERVER_ALIAS

networks:
  default:
    driver: bridge
COMPOSE_EOF

echo "Starting Rust Google Workspace OAuth e2e stack on http://localhost:${HOST_PORT} ..."
docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" up -d

for attempt in $(seq 1 90); do
    if curl -fsS --max-time 5 "http://localhost:${HOST_PORT}/health" >/dev/null 2>&1; then
        break
    fi
    sleep 2
done

for attempt in $(seq 1 90); do
    curl -fsS --max-time 15 "http://localhost:${HOST_PORT}/oauth/status" > "$OAUTH_JSON"
    curl -fsS --max-time 15 "http://localhost:${HOST_PORT}/servers/${SERVER_ID}/status" > "$STATUS_JSON"
    if jq -e '
        .status == "healthy" and
        .healthy == true and
        .readiness_phase == "tool_ready" and
        .proxy_probe_ok == true and
        .oauth_state == "completed"
    ' "$STATUS_JSON" >/dev/null 2>&1; then
        break
    fi
    sleep 2
done

curl -fsS --max-time 20 "http://localhost:${HOST_PORT}/openapi.json" > "$OPENAPI_JSON"
curl -fsS --max-time 15 "http://localhost:${HOST_PORT}/oauth/status" > "$OAUTH_JSON"
curl -fsS --max-time 15 "http://localhost:${HOST_PORT}/servers/${SERVER_ID}/status" > "$STATUS_JSON"
docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" logs mcpo-google_workspace > "$LOGS_TXT" 2>&1 || true

jq -e '
    .status == "healthy" and
    .healthy == true and
    .readiness_phase == "tool_ready" and
    .proxy_probe_ok == true and
    .oauth_state == "completed"
' "$STATUS_JSON" >/dev/null
jq -e '
    .current == null and
    (.active | length == 0) and
    (.pending | length == 0) and
    (.waiting_callback | length == 0) and
    ((.completed | map(.server_name)) | index("google_workspace") != null)
' "$OAUTH_JSON" >/dev/null
jq -e '
    [
      .paths
      | to_entries[]
      | select(.key | startswith("/google_workspace/"))
      | select(.key != "/google_workspace/openapi.json" and .key != "/google_workspace/docs")
    ] | length > 50
' "$OPENAPI_JSON" >/dev/null

if rg -n "OAuth authorization required|authorization_url=" "$LOGS_TXT" >/dev/null 2>&1; then
    echo "Unexpected re-consent flow detected in runtime logs" >&2
    exit 1
fi

CALENDARS_STATUS="$(
    curl -sS \
        --max-time 60 \
        -o "$CALENDARS_JSON" \
        -w '%{http_code}' \
        -X POST \
        "http://localhost:${HOST_PORT}/google_workspace/google_workspace_list_calendars" \
        -H 'Content-Type: application/json' \
        -d '{}'
)"

LABELS_STATUS="$(
    curl -sS \
        --max-time 60 \
        -o "$LABELS_JSON" \
        -w '%{http_code}' \
        -X POST \
        "http://localhost:${HOST_PORT}/google_workspace/google_workspace_list_gmail_labels" \
        -H 'Content-Type: application/json' \
        -d '{}'
)"

if [ "$CALENDARS_STATUS" != "200" ]; then
    echo "Calendar tool call failed with HTTP ${CALENDARS_STATUS}" >&2
    cat "$CALENDARS_JSON" >&2
    exit 1
fi

if [ "$LABELS_STATUS" != "200" ]; then
    echo "Gmail label tool call failed with HTTP ${LABELS_STATUS}" >&2
    cat "$LABELS_JSON" >&2
    exit 1
fi

jq -e '.result | type == "string" and contains("Successfully listed")' "$CALENDARS_JSON" >/dev/null
jq -e '.result | type == "string" and contains("Found") and contains("labels")' "$LABELS_JSON" >/dev/null

echo
echo "OAuth status:"
jq '.' "$OAUTH_JSON"
echo
echo "Server status:"
jq '.' "$STATUS_JSON"
echo
echo "Calendar tool call:"
jq '.' "$CALENDARS_JSON"
echo
echo "Gmail labels tool call:"
jq '.' "$LABELS_JSON"
echo
echo "Rust Google Workspace OAuth e2e test passed."
