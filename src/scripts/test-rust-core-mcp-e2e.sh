#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
source "$SCRIPT_DIR/mcp-orc-backend.sh"

PROJECT_NAME="${PROJECT_NAME:-portico-rust-core-e2e}"
HOST_PORT="${HOST_PORT:-8772}"
CHAT_ID="${CHAT_ID:-rust-core-e2e}"
FORCE_BUILD="${FORCE_BUILD:-1}"
TEMP_DIR="$(mktemp -d)"
COMPOSE_FILE="$TEMP_DIR/docker-compose.yml"
NGINX_CONF="$TEMP_DIR/nginx.conf"
OWUI_MOCK="$PROJECT_ROOT/src/scripts/mock_openwebui_core_e2e.py"
WEB_PROXY_MOCK="$PROJECT_ROOT/src/scripts/mock_web_tools_proxy_core_e2e.py"
ELECTRON_MOCK="$PROJECT_ROOT/src/scripts/mock_electron_api_core_e2e.py"
E2E_DRIVER="$PROJECT_ROOT/src/scripts/rust_core_mcp_e2e_driver.py"
CONFIG_DIR="$TEMP_DIR/configs"
GROUP_TARGETS_FILE="$CONFIG_DIR/group-core-targets.json"
SERVER_ROUTES_FILE="$CONFIG_DIR/server-routing.json"
STATE_ROOT="$TEMP_DIR/state-host"
TOGGLES_FILE="$TEMP_DIR/mcp_toggles.json"
ELECTRON_LOG="$TEMP_DIR/electron-api.log"
ELECTRON_PID=""
ELECTRON_PORT="${ELECTRON_PORT:-9987}"

CORE_SERVERS=(
  "agent-vm"
  "artifacts"
  "mcp-assistant"
  "scheduling"
  "skills"
  "subagents"
  "web-tools"
)

cleanup() {
    if [ -n "${ELECTRON_PID:-}" ] && kill -0 "$ELECTRON_PID" >/dev/null 2>&1; then
        kill "$ELECTRON_PID" >/dev/null 2>&1 || true
        wait "$ELECTRON_PID" >/dev/null 2>&1 || true
    fi
    docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" down --volumes --remove-orphans >/dev/null 2>&1 || true
    if [ "${KEEP_TEMP_DIR:-0}" != "1" ]; then
        rm -rf "$TEMP_DIR"
    fi
}

on_error() {
    local exit_code="$?"
    echo
    echo "Rust core MCP e2e test failed. Capturing diagnostics..." >&2
    docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" ps >&2 || true
    echo >&2
    docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" logs --tail 300 >&2 || true
    echo >&2
    if [ -f "$ELECTRON_LOG" ]; then
        echo "Electron mock log:" >&2
        tail -n 100 "$ELECTRON_LOG" >&2 || true
        echo >&2
    fi
    echo "Temporary files: $TEMP_DIR" >&2
    exit "$exit_code"
}

trap cleanup EXIT
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
require_command python3

start_electron_mock() {
    MOCK_ELECTRON_PORT="$ELECTRON_PORT" MOCK_PROJECT_ROOT="$STATE_ROOT" \
        python3 "$ELECTRON_MOCK" >"$ELECTRON_LOG" 2>&1 &
    ELECTRON_PID="$!"
    for _ in $(seq 1 30); do
        if curl -fsS --max-time 2 "http://127.0.0.1:${ELECTRON_PORT}/health" >/dev/null 2>&1; then
            return
        fi
        sleep 1
    done
    echo "Electron mock failed to start" >&2
    exit 1
}

cd "$PROJECT_ROOT"

mkdir -p "$CONFIG_DIR" "$STATE_ROOT/workspaces" "$STATE_ROOT/artifact-snapshots" \
    "$STATE_ROOT/workspace-cfg" "$STATE_ROOT/app-support" \
    "$STATE_ROOT/skills-user" "$STATE_ROOT/skills-marketplace" "$STATE_ROOT/mcp-configs-user"

python3 - "$TOGGLES_FILE" <<'PY'
import json
import sys

toggles = {
    "agent-vm": True,
    "artifacts": True,
    "mcp-assistant": True,
    "scheduling": True,
    "skills": True,
    "subagents": True,
    "web-tools": True,
}
with open(sys.argv[1], "w", encoding="utf-8") as f:
    json.dump(toggles, f, indent=2)
    f.write("\n")
PY

for server_id in "${CORE_SERVERS[@]}"; do
    jq --arg id "$server_id" \
        '{mcpServers: {($id): .mcpServers[$id]}}' \
        "$PROJECT_ROOT/mcp_config_core.json" > "$CONFIG_DIR/$server_id.json"
    python3 - "$CONFIG_DIR/$server_id.json" "$server_id" <<'PY'
import json
import sys
from pathlib import Path

config_path = Path(sys.argv[1])
server_id = sys.argv[2]
config = json.loads(config_path.read_text())
servers = config.get("mcpServers") or {}
server_cfg = servers.get(server_id) or {}
server_cfg["command"] = f"{server_id}-server"
server_cfg["args"] = []
config_path.write_text(json.dumps(config, indent=2) + "\n")
PY
done
python3 - "$GROUP_TARGETS_FILE" "$SERVER_ROUTES_FILE" "${CORE_SERVERS[@]}" <<'PY'
import json
import sys

targets_path = sys.argv[1]
routes_path = sys.argv[2]
server_ids = sys.argv[3:]
servers = []
routes = {}
for index, server_id in enumerate(server_ids):
    port = 8100 + index
    servers.append(
        {
            "id": server_id,
            "config_file": f"mcpo-configs-generated/{server_id}.json",
            "port": port,
            "oauth_storage_dir": f"/dev/shm/mcpo-core-oauth/{server_id}",
            "deployment_scope": "core",
        }
    )
    routes[server_id] = {
        "compose_service": "mcpo-group-core",
        "container_name": "mcpo-group-core",
        "network_host": "mcpo-group-core",
        "port": port,
        "deployment_scope": "core",
        "group_id": "core",
        "grouped": True,
    }

with open(targets_path, "w", encoding="utf-8") as handle:
    json.dump({"group_id": "core", "servers": servers}, handle, indent=2)
    handle.write("\n")
with open(routes_path, "w", encoding="utf-8") as handle:
    json.dump(routes, handle, indent=2, sort_keys=True)
    handle.write("\n")
PY
start_electron_mock

cat > "$NGINX_CONF" <<'NGINX_EOF'
events {
    worker_connections 1024;
}

http {
    upstream core_openapi_aggregator {
        server mcpo-core-openapi-aggregator:8080;
    }

    upstream agent_vm_server {
        server mcpo-group-core:8100;
    }

    upstream artifacts_server {
        server mcpo-group-core:8101;
    }

    upstream mcp_assistant_server {
        server mcpo-group-core:8102;
    }

    upstream scheduling_server {
        server mcpo-group-core:8103;
    }

    upstream skills_server {
        server mcpo-group-core:8104;
    }

    upstream subagents_server {
        server mcpo-group-core:8105;
    }

    upstream web_tools_server {
        server mcpo-group-core:8106;
    }

    server {
        listen 80;
        listen 8081;

        location = /openapi.json {
            proxy_pass http://core_openapi_aggregator/openapi.json;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
        }

        location = /health {
            proxy_pass http://core_openapi_aggregator/health;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
        }

        location = /servers {
            proxy_pass http://core_openapi_aggregator/servers;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
        }

        location /servers/ {
            proxy_pass http://core_openapi_aggregator;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
        }

        location /oauth/ {
            proxy_pass http://core_openapi_aggregator;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
        }

        location /internal/ {
            proxy_pass http://core_openapi_aggregator;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
        }

        location /agent-vm/ {
            proxy_pass http://agent_vm_server;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_read_timeout 300s;
        }

        location /artifacts/ {
            proxy_pass http://artifacts_server;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_read_timeout 300s;
        }

        location /mcp-assistant/ {
            proxy_pass http://mcp_assistant_server;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_read_timeout 300s;
        }

        location /scheduling/ {
            proxy_pass http://scheduling_server;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_read_timeout 300s;
        }

        location /skills/ {
            proxy_pass http://skills_server;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_read_timeout 300s;
        }

        location /subagents/ {
            proxy_pass http://subagents_server;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_read_timeout 7800s;
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

if [ "$FORCE_BUILD" = "1" ] || ! docker image inspect portico-openapi-aggregator-rust:latest >/dev/null 2>&1; then
    docker build -f Dockerfile.openapi-aggregator-rust -t portico-openapi-aggregator-rust:latest .
fi

if [ "$FORCE_BUILD" = "1" ] || ! docker image inspect portico-mcp-orc-rust:latest >/dev/null 2>&1; then
    docker build --build-arg ENABLE_SUPERVISOR=1 --build-arg INCLUDE_NODE=1 --build-arg INCLUDE_DOCKER_CLI=1 \
      -f Dockerfile.mcp-orc-rust -t portico-mcp-orc-rust:latest .
fi

agent_vm_label=$(docker image inspect --format '{{ index .Config.Labels "com.portico.ai-chat.image-role" }}' agent-vm:latest 2>/dev/null || true)
if [ "$FORCE_BUILD" = "1" ] || ! docker image inspect agent-vm:latest >/dev/null 2>&1 || [ "$agent_vm_label" != "agent-vm" ]; then
    docker build -f Dockerfile.agent-vm -t agent-vm:latest .
fi

cat > "$COMPOSE_FILE" <<COMPOSE_EOF
name: $PROJECT_NAME

services:
  redis:
    image: redis:7-alpine
    command: redis-server --save "" --appendonly no
    networks:
      - e2e

  llm-gateway:
    image: python:3.11-slim
    command: ["python", "-m", "http.server", "4000"]
    expose:
      - "4000"
    networks:
      - e2e

  open-webui:
    image: python:3.11-slim
    command: ["python", "/mock/mock_openwebui.py"]
    volumes:
      - $OWUI_MOCK:/mock/mock_openwebui.py:ro
    expose:
      - "8080"
    networks:
      - e2e

  web-tools-proxy:
    image: python:3.11-slim
    command: ["python", "/mock/mock_web_tools_proxy.py"]
    volumes:
      - $WEB_PROXY_MOCK:/mock/mock_web_tools_proxy.py:ro
    expose:
      - "8081"
    networks:
      - e2e

  mcpo-core:
    image: nginx:alpine
    ports:
      - "${HOST_PORT}:80"
    volumes:
      - $NGINX_CONF:/etc/nginx/nginx.conf:ro
    depends_on:
      - mcpo-core-openapi-aggregator
      - mcpo-group-core
    networks:
      - e2e

  mcpo-core-openapi-aggregator:
    image: portico-openapi-aggregator-rust:latest
    environment:
      - MCPO_SERVERS=agent-vm,artifacts,mcp-assistant,scheduling,skills,subagents,web-tools
      - MCPO_CONTAINER_PREFIX=mcpo-core
      - MCPO_USE_STATIC_SERVERS=true
      - MCPO_SERVER_ROUTES_FILE=/app/mcpo-configs-generated/server-routing.json
    depends_on:
      - mcpo-group-core
    expose:
      - "8080"
    volumes:
      - $CONFIG_DIR:/app/mcpo-configs-generated:ro
    networks:
      - e2e

  mcpo-group-core:
    image: portico-mcp-orc-rust:latest
    entrypoint: ["/app/mcpo-core-rust-group-entrypoint.sh"]
    environment:
      - MCP_ORC_BACKEND=rust
      - TZ=\${TZ:-UTC}
      - LOG_LEVEL=\${MCPO_LOG_LEVEL:-INFO}
      - DEBUG=\${MCP_DEBUG:-}
      - HOST_PROJECT_ROOT=$STATE_ROOT
      - PORTICO_LLM_API_KEY=test-key
      - PORTICO_USER_ID=test-user
      - PORTICO_BUILD_TRACK=rust-core-e2e
      - WEB_TOOLS_PROXY_URL=http://web-tools-proxy:8081/openai/v1
      - WEB_TOOLS_OPENAI_MODEL=mock-web-search
      - ELECTRON_API_BASE=http://host.docker.internal:${ELECTRON_PORT}
      - PORTICO_WORKSPACE_CFG_DIR=/app/workspace-cfg
      - PORTICO_APP_SUPPORT_DIR=/app/app-support
      - CORE_MCP_AGENT_VM_NETWORK=${PROJECT_NAME}_e2e
      - MCPO_MULTI_TARGETS_FILE=/app/mcpo-configs-generated/group-core-targets.json
      - MCPO_MULTI_HOME_ROOT=/app/mcpo-runtime-homes/core
      - MCPO_DISABLE_LOCAL_CALLBACK_SERVER=1
    expose:
      - "8100"
      - "8101"
      - "8102"
      - "8103"
      - "8104"
      - "8105"
      - "8106"
    volumes:
      - $CONFIG_DIR:/app/mcpo-configs-generated:ro
      - $PROJECT_ROOT/src/managers:/app/managers:ro
      - $PROJECT_ROOT/skills:/app/skills:ro
      - $STATE_ROOT/skills-user:/app/skills-user:rw
      - $STATE_ROOT/skills-marketplace:/app/skills-marketplace:rw
      - $PROJECT_ROOT/mcp-configs:/app/mcp-configs:ro
      - $STATE_ROOT/mcp-configs-user:/app/mcp-configs-user:rw
      - $TOGGLES_FILE:/app/mcp_toggles.json:rw
      - /var/run/docker.sock:/var/run/docker.sock
      - $STATE_ROOT/workspaces:/app/workspaces:rw
      - $STATE_ROOT/artifact-snapshots:/app/artifact-snapshots:rw
      - $STATE_ROOT/workspace-cfg:/app/workspace-cfg:rw
      - $STATE_ROOT/app-support:/app/app-support:rw
    tmpfs:
      - /dev/shm/mcpo-core-oauth:mode=700
    extra_hosts:
      - "host.docker.internal:host-gateway"
    depends_on:
      - llm-gateway
      - redis
      - open-webui
      - web-tools-proxy
    networks:
      - e2e

networks:
  e2e:
    driver: bridge
COMPOSE_EOF

echo "Starting Rust core MCP e2e stack on http://localhost:${HOST_PORT} ..."
docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" up -d

for attempt in $(seq 1 60); do
    if docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" exec -T redis redis-cli ping >/dev/null 2>&1; then
        break
    fi
    sleep 1
done

docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" exec -T redis redis-cli set openwebui:api_token mock-token >/dev/null

for attempt in $(seq 1 90); do
    if curl -fsS --max-time 5 "http://localhost:${HOST_PORT}/health" >/dev/null 2>&1; then
        break
    fi
    sleep 2
done

python3 "$E2E_DRIVER" \
    --base-url "http://localhost:${HOST_PORT}" \
    --chat-id "$CHAT_ID" \
    --project-root "$PROJECT_ROOT"
