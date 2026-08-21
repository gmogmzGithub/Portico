#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
source "$SCRIPT_DIR/mcp-orc-backend.sh"

PROJECT_NAME="portico-rust-dynamic-oauth-discovery-e2e"
SERVER_ID="dynamic_discovery"
HOST_PORT="${HOST_PORT:-8778}"
CALLBACK_HOST_PORT="${CALLBACK_HOST_PORT:-3846}"
MOCK_PORT="${MOCK_PORT:-8791}"
TEMP_DIR="$(mktemp -d)"
COMPOSE_FILE="$TEMP_DIR/docker-compose.yml"
NGINX_CONF="$TEMP_DIR/nginx.conf"
CONFIG_JSON="$TEMP_DIR/${SERVER_ID}.json"
ROUTES_JSON="$TEMP_DIR/server-routing.json"
SERVERS_JSON="$TEMP_DIR/servers.json"
OPENAPI_JSON="$TEMP_DIR/openapi.json"
STATUS_JSON="$TEMP_DIR/status.json"
OAUTH_JSON="$TEMP_DIR/oauth-status.json"
AUTH_HEADERS="$TEMP_DIR/authorization-headers.txt"
TOOL_JSON="$TEMP_DIR/tool.json"
RUNTIME_LOG="$TEMP_DIR/runtime.log"
MOCK_LOG="$TEMP_DIR/mock.log"
MOCK_PID=""

RUNTIME_IMAGE="$(mcp_orc_local_image_name full rust)"
CONTROL_PLANE_IMAGE="$(mcpo_control_plane_local_image_name rust)"

cleanup() {
    if [ -n "$MOCK_PID" ] && kill -0 "$MOCK_PID" >/dev/null 2>&1; then
        kill "$MOCK_PID" >/dev/null 2>&1 || true
        wait "$MOCK_PID" >/dev/null 2>&1 || true
    fi
    docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" down --volumes --remove-orphans >/dev/null 2>&1 || true
    if [ "${KEEP_TEMP_DIR:-0}" != "1" ]; then
        rm -rf "$TEMP_DIR"
    fi
}

trap cleanup EXIT

on_error() {
    local exit_code="$?"
    echo
    echo "Rust dynamic OAuth discovery e2e test failed. Capturing diagnostics..." >&2
    if [ -f "$MOCK_LOG" ]; then
        echo "--- mock server log ---" >&2
        tail -n 200 "$MOCK_LOG" >&2 || true
        echo >&2
    fi
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

require_command cargo
require_command curl
require_command docker
require_command jq
require_command python3
require_command rg

cd "$PROJECT_ROOT"

if [ "${FORCE_BUILD:-0}" = "1" ] || ! docker image inspect "$RUNTIME_IMAGE" >/dev/null 2>&1; then
    docker build -f Dockerfile.mcp-orc-rust -t "$RUNTIME_IMAGE" .
fi

if [ "${FORCE_BUILD:-0}" = "1" ] || ! docker image inspect "$CONTROL_PLANE_IMAGE" >/dev/null 2>&1; then
    docker build -f Dockerfile.mcpo-control-plane-rust -t "$CONTROL_PLANE_IMAGE" .
fi

MOCK_OAUTH_MCP_HOST=0.0.0.0 \
MOCK_OAUTH_MCP_PORT="$MOCK_PORT" \
MOCK_OAUTH_MCP_PUBLIC_BASE_URL="http://host.docker.internal:${MOCK_PORT}" \
RUST_LOG=info \
cargo run --quiet --manifest-path "$PROJECT_ROOT/src/mcp-orc-rust/Cargo.toml" -p mcp-orc --bin mock-oauth-mcp-server \
    >"$MOCK_LOG" 2>&1 &
MOCK_PID="$!"

for attempt in $(seq 1 180); do
    if curl -fsS --max-time 5 "http://127.0.0.1:${MOCK_PORT}/health" >/dev/null 2>&1; then
        break
    fi
    if ! kill -0 "$MOCK_PID" >/dev/null 2>&1; then
        echo "Mock OAuth MCP server exited before becoming healthy" >&2
        cat "$MOCK_LOG" >&2 || true
        exit 1
    fi
    sleep 1
done

curl -fsS --max-time 5 "http://127.0.0.1:${MOCK_PORT}/health" >/dev/null

jq -n \
    --arg id "$SERVER_ID" \
    --arg url "http://host.docker.internal:${MOCK_PORT}/mcp" \
    '{
      mcpServers: {
        ($id): {
          type: "streamable-http",
          url: $url
        }
      }
    }' > "$CONFIG_JSON"

jq -n \
    --arg id "$SERVER_ID" \
    '{
      ($id): {
        compose_service: "mcpo-dynamic",
        container_name: "mcpo-dynamic",
        deployment_scope: "docker",
        grouped: false,
        group_id: null,
        network_host: "mcpo-dynamic",
        port: 8000
      }
    }' > "$ROUTES_JSON"

cat > "$NGINX_CONF" <<NGINX_EOF
events {
    worker_connections 1024;
}

http {
    server {
        listen 80;

        location = /openapi.json {
            proxy_pass http://127.0.0.1:8080/openapi.json;
            proxy_http_version 1.1;
            proxy_set_header Host \$host;
        }

        location = /health {
            return 200 'healthy';
            add_header Content-Type text/plain;
        }

        location = /servers {
            proxy_pass http://127.0.0.1:8080/servers;
            proxy_http_version 1.1;
            proxy_set_header Host \$host;
        }

        location /servers/ {
            proxy_pass http://127.0.0.1:8080;
            proxy_http_version 1.1;
            proxy_set_header Host \$host;
        }

        location /oauth/ {
            proxy_pass http://127.0.0.1:8080;
            proxy_http_version 1.1;
            proxy_set_header Host \$host;
            proxy_set_header X-Real-IP \$remote_addr;
        }

        location /internal/ {
            proxy_pass http://127.0.0.1:8080;
            proxy_http_version 1.1;
            proxy_set_header Host \$host;
        }

        location /dynamic_discovery/ {
            proxy_pass http://mcpo-dynamic:8000;
            proxy_http_version 1.1;
            proxy_set_header Upgrade \$http_upgrade;
            proxy_set_header Connection "upgrade";
            proxy_set_header Host \$host;
            proxy_set_header X-Real-IP \$remote_addr;
            proxy_read_timeout 300s;
        }

        location / {
            return 404 'Server not found';
            add_header Content-Type text/plain;
        }
    }

    server {
        listen 3834;

        location /callback {
            proxy_pass http://127.0.0.1:8080/oauth/callback;
            proxy_http_version 1.1;
            proxy_set_header Host \$host;
            proxy_set_header X-Real-IP \$remote_addr;
            proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        }

        location / {
            return 404 'OAuth callback only';
            add_header Content-Type text/plain;
        }
    }
}
NGINX_EOF

cat > "$COMPOSE_FILE" <<COMPOSE_EOF
name: $PROJECT_NAME

services:
  mcpo:
    image: $CONTROL_PLANE_IMAGE
    ports:
      - "${HOST_PORT}:80"
      - "${CALLBACK_HOST_PORT}:3834"
    volumes:
      - $NGINX_CONF:/etc/nginx/nginx.conf:ro
      - $PROJECT_ROOT/src/mcpo-core-nginx.conf:/etc/nginx/conf.d/mcpo-core.conf:ro
      - $ROUTES_JSON:/app/mcpo-configs-generated/server-routing.json:ro
    environment:
      - MCPO_SERVERS=$SERVER_ID
      - MCPO_CORE_SERVERS=
      - MCPO_REGULAR_AGGREGATOR_PORT=8080
      - MCPO_CORE_AGGREGATOR_PORT=8082
      - MCPO_SERVER_ROUTES_FILE=/app/mcpo-configs-generated/server-routing.json
    depends_on:
      - mcpo-dynamic
    extra_hosts:
      - "host.docker.internal:host-gateway"
    networks:
      default:
        aliases:
          - mcpo

  mcpo-dynamic:
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
    extra_hosts:
      - "host.docker.internal:host-gateway"
    networks:
      default:
        aliases:
          - mcpo-dynamic

networks:
  default:
    driver: bridge
COMPOSE_EOF

echo "Starting Rust dynamic OAuth discovery e2e stack on http://localhost:${HOST_PORT} ..."
docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" up -d

for attempt in $(seq 1 90); do
    if curl -fsS --max-time 5 "http://localhost:${HOST_PORT}/health" >/dev/null 2>&1; then
        break
    fi
    sleep 2
done

AUTHORIZATION_URL=""
for attempt in $(seq 1 90); do
    curl -fsS --max-time 15 "http://localhost:${HOST_PORT}/oauth/status" > "$OAUTH_JSON"
    AUTHORIZATION_URL="$(jq -r '.current.authorization_url // empty' "$OAUTH_JSON")"
    if [ -n "$AUTHORIZATION_URL" ]; then
        break
    fi
    sleep 2
done

if [ -z "$AUTHORIZATION_URL" ]; then
    echo "Dynamic discovery did not expose an OAuth authorization URL" >&2
    exit 1
fi

# The mock advertises host.docker.internal so the container can reach it. Drive
# that same authorization request from the host, then route the canonical 3834
# callback through this test's collision-free published port.
AUTHORIZATION_REQUEST_URL="${AUTHORIZATION_URL/host.docker.internal/127.0.0.1}"
curl -fsS --max-time 15 -D "$AUTH_HEADERS" -o /dev/null "$AUTHORIZATION_REQUEST_URL"
CALLBACK_URL="$(
    awk '
        tolower($1) == "location:" {
            sub(/^[^:]*:[[:space:]]*/, "")
            sub(/\r$/, "")
            print
        }
    ' "$AUTH_HEADERS" | tail -n 1
)"

if [ -z "$CALLBACK_URL" ]; then
    echo "Mock authorization endpoint did not return a callback redirect" >&2
    exit 1
fi

CALLBACK_REQUEST_URL="${CALLBACK_URL/localhost:3834/localhost:${CALLBACK_HOST_PORT}}"
curl -fsS --max-time 30 "$CALLBACK_REQUEST_URL" >/dev/null

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

curl -fsS --max-time 20 "http://localhost:${HOST_PORT}/servers" > "$SERVERS_JSON"
curl -fsS --max-time 20 "http://localhost:${HOST_PORT}/openapi.json" > "$OPENAPI_JSON"
curl -fsS --max-time 15 "http://localhost:${HOST_PORT}/oauth/status" > "$OAUTH_JSON"
curl -fsS --max-time 15 "http://localhost:${HOST_PORT}/servers/${SERVER_ID}/status" > "$STATUS_JSON"
docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" logs mcpo-dynamic > "$RUNTIME_LOG" 2>&1 || true

jq -e --arg server "$SERVER_ID" '.servers == [$server] and .count == 1' "$SERVERS_JSON" >/dev/null
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
    ((.completed | map(.server_name)) | index("dynamic_discovery") != null)
' "$OAUTH_JSON" >/dev/null
jq -e '
    .paths | has("/dynamic_discovery/dynamic_discovery_get_current_time")
' "$OPENAPI_JSON" >/dev/null

rg -n "probing MCP server for OAuth requirements" "$RUNTIME_LOG" >/dev/null
rg -n "transport connected successfully with usable OAuth state" "$RUNTIME_LOG" >/dev/null
rg -n "OAuth authorization URL generated" "$RUNTIME_LOG" >/dev/null

TOOL_STATUS="$(
    curl -sS \
        --max-time 60 \
        -o "$TOOL_JSON" \
        -w '%{http_code}' \
        -X POST \
        "http://localhost:${HOST_PORT}/dynamic_discovery/dynamic_discovery_get_current_time" \
        -H 'Content-Type: application/json' \
        -d '{}'
)"

if [ "$TOOL_STATUS" != "200" ]; then
    echo "Dynamic discovery tool call failed with HTTP ${TOOL_STATUS}" >&2
    cat "$TOOL_JSON" >&2
    exit 1
fi

jq -e '
    .mock_time | type == "string"
' "$TOOL_JSON" >/dev/null
jq -e '
    .source == "mock_oauth_mcp_server" and .timezone == "UTC"
' "$TOOL_JSON" >/dev/null

rg -n "grant_type=authorization_code" "$MOCK_LOG" >/dev/null

echo
echo "OAuth status:"
jq '.' "$OAUTH_JSON"
echo
echo "Server status:"
jq '.' "$STATUS_JSON"
echo
echo "Tool call:"
jq '.' "$TOOL_JSON"
echo
echo "Rust dynamic OAuth discovery e2e test passed."
