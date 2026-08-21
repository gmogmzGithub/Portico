#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
source "$SCRIPT_DIR/mcp-orc-backend.sh"

PROJECT_NAME="portico-rust-openapi-e2e"
HOST_PORT="${HOST_PORT:-8771}"
SERVER_ID="web-tools"
TOOL_ROUTE="web_tools_web_search"
SEARCH_QUERY="${SEARCH_QUERY:-Portico}"
TEMP_DIR="$(mktemp -d)"
COMPOSE_FILE="$TEMP_DIR/docker-compose.yml"
NGINX_CONF="$TEMP_DIR/nginx.conf"
CONFIG_JSON="$TEMP_DIR/${SERVER_ID}.json"

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
    echo "Rust OpenAPI aggregator e2e test failed. Capturing diagnostics..." >&2
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

cat > "$CONFIG_JSON" <<JSON_EOF
{
  "mcpServers": {
    "${SERVER_ID}": {
      "command": "web-tools-server",
      "args": []
    }
  }
}
JSON_EOF

cat > "$NGINX_CONF" <<'NGINX_EOF'
events {
    worker_connections 1024;
}

http {
    upstream openapi_aggregator {
        server mcpo-openapi-aggregator:8080;
    }

    upstream web_tools_server {
        server mcpo-web-tools:8000;
    }

    server {
        listen 80;

        location = /openapi.json {
            proxy_pass http://openapi_aggregator/openapi.json;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
        }

        location = /health {
            proxy_pass http://openapi_aggregator/health;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
        }

        location = /servers {
            proxy_pass http://openapi_aggregator/servers;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
        }

        location /servers/ {
            proxy_pass http://openapi_aggregator;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
        }

        location /oauth/ {
            proxy_pass http://openapi_aggregator;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
        }

        location /internal/ {
            proxy_pass http://openapi_aggregator;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
        }

        location /web-tools/ {
            proxy_pass http://web_tools_server;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_read_timeout 300s;
        }

        location / {
            return 404 'Server not found';
            add_header Content-Type text/plain;
        }
    }
}
NGINX_EOF

cat > "$COMPOSE_FILE" <<COMPOSE_EOF
name: $PROJECT_NAME

services:
  mcpo:
    image: nginx:alpine
    ports:
      - "${HOST_PORT}:80"
    volumes:
      - $NGINX_CONF:/etc/nginx/nginx.conf:ro
    depends_on:
      - mcpo-openapi-aggregator
      - mcpo-web-tools
    networks:
      - e2e

  mcpo-openapi-aggregator:
    build:
      context: $PROJECT_ROOT
      dockerfile: $(openapi_aggregator_dockerfile rust)
    image: $(openapi_aggregator_local_image_name rust)
    environment:
      - MCPO_SERVERS=$SERVER_ID
      - MCPO_USE_STATIC_SERVERS=true
    depends_on:
      - mcpo-web-tools
    networks:
      - e2e

  mcpo-web-tools:
    build:
      context: $PROJECT_ROOT
      dockerfile: $(mcp_orc_runtime_dockerfile rust)
      args:
        INCLUDE_NODE: "0"
        INCLUDE_DOCKER_CLI: "0"
    image: $(mcp_orc_local_image_name python rust)
    volumes:
      - $CONFIG_JSON:/app/mcp_config.json:ro
    environment:
      - TZ=\${TZ:-UTC}
      - CONFIG_FILE=mcp_config.json
      - LOG_LEVEL=\${MCPO_LOG_LEVEL:-INFO}
      - DEBUG=\${MCP_DEBUG:-}
      - PYTHONUNBUFFERED=1
    extra_hosts:
      - "host.docker.internal:host-gateway"
    networks:
      - e2e

networks:
  e2e:
    driver: bridge
COMPOSE_EOF

echo "Starting Rust OpenAPI aggregator e2e stack on http://localhost:${HOST_PORT} ..."
docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" up --build -d

for attempt in $(seq 1 45); do
    if curl -fsS --max-time 5 "http://localhost:${HOST_PORT}/health" >/dev/null 2>&1; then
        break
    fi
    sleep 2
done

OPENAPI_JSON="$TEMP_DIR/openapi.json"
SERVERS_JSON="$TEMP_DIR/servers.json"
STATUS_JSON="$TEMP_DIR/status.json"

curl -fsS --max-time 10 "http://localhost:${HOST_PORT}/openapi.json" > "$OPENAPI_JSON"
curl -fsS --max-time 10 "http://localhost:${HOST_PORT}/servers" > "$SERVERS_JSON"

for attempt in $(seq 1 30); do
    curl -fsS --max-time 10 "http://localhost:${HOST_PORT}/openapi.json" > "$OPENAPI_JSON"
    if jq -e --arg path "/${SERVER_ID}/${TOOL_ROUTE}" '.paths | has($path)' "$OPENAPI_JSON" >/dev/null; then
        break
    fi
    sleep 2
done

for attempt in $(seq 1 30); do
    curl -fsS --max-time 10 "http://localhost:${HOST_PORT}/servers/${SERVER_ID}/status" > "$STATUS_JSON"
    status="$(jq -r '.status' "$STATUS_JSON")"
    readiness_phase="$(jq -r '.readiness_phase' "$STATUS_JSON")"
    if [ "$status" = "healthy" ] && [ "$readiness_phase" = "tool_ready" ]; then
        break
    fi
    sleep 2
done

jq -e --arg server "$SERVER_ID" '.servers == [$server] and .count == 1' "$SERVERS_JSON" >/dev/null
jq -e --arg path "/${SERVER_ID}/${TOOL_ROUTE}" '.paths | has($path)' "$OPENAPI_JSON" >/dev/null
jq -e '.status == "healthy" and .readiness_phase == "tool_ready" and .healthy == true and .proxy_probe_ok == true' "$STATUS_JSON" >/dev/null

echo
echo "OpenAPI aggregator status:"
jq '{paths: (.paths | keys), components: (.components.schemas | keys)}' "$OPENAPI_JSON"
echo
echo "Server discovery:"
jq '.' "$SERVERS_JSON"
echo
echo "Server status:"
jq '.' "$STATUS_JSON"
echo
echo "Rust OpenAPI aggregator e2e test passed."
