#!/usr/bin/env bash
# Regression coverage for security-audit.sh. The test uses a fake docker
# binary and isolated temp project roots so it can validate posture decisions
# without reading live containers or real local secret caches.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
AUDIT_SCRIPT="$PROJECT_ROOT/security-audit.sh"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/portico-security-audit-test.XXXXXX")"
FAKE_DOCKER="$TMP_DIR/docker"
if [ -x /usr/bin/python3 ]; then
    TEST_PYTHON_BIN="${TEST_PYTHON_BIN:-/usr/bin/python3}"
else
    TEST_PYTHON_BIN="${TEST_PYTHON_BIN:-python3}"
fi

cleanup() {
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fail() {
    echo "FAIL: $1" >&2
    exit 1
}

assert_contains() {
    local file="$1"
    local needle="$2"
    local message="$3"
    if ! grep -Fq -- "$needle" "$file"; then
        echo "--- output ---" >&2
        sed -n '1,240p' "$file" >&2 || true
        echo "--------------" >&2
        fail "$message (expected substring '$needle')"
    fi
}

assert_not_contains() {
    local file="$1"
    local needle="$2"
    local message="$3"
    if grep -Fq -- "$needle" "$file"; then
        echo "--- output ---" >&2
        sed -n '1,240p' "$file" >&2 || true
        echo "--------------" >&2
        fail "$message (unexpected substring '$needle')"
    fi
}

resolve_path() {
    "$TEST_PYTHON_BIN" - "$1" <<'PY'
import sys
from pathlib import Path

print(Path(sys.argv[1]).expanduser().resolve())
PY
}

write_fake_docker() {
    cat >"$FAKE_DOCKER" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

scenario="${FAKE_DOCKER_SCENARIO:?FAKE_DOCKER_SCENARIO is required}"
cmd="${1:-}"
if [ "$#" -gt 0 ]; then
    shift
fi

case "$cmd" in
    ps)
        cat "$scenario/ps"
        ;;
    inspect)
        cat "$scenario/inspect.json"
        ;;
    exec)
        cid="${1:?container id is required}"
        shift
        joined="$*"
        if [[ "$joined" == *"command -v npm"* ]]; then
            if [ -f "$scenario/npm-missing-$cid" ]; then
                exit 1
            fi
            exit 0
        fi
        if [[ "$joined" == *"npm config get registry"* ]]; then
            if [ -f "$scenario/registry-$cid" ]; then
                cat "$scenario/registry-$cid"
            else
                echo "https://npm.artifacts.example.invalid/"
            fi
            exit 0
        fi
        if [[ "$joined" == *"npm install"* ]]; then
            touch "$scenario/install-attempt-$cid"
            printf "%s\\n" "$joined" >"$scenario/install-command-$cid"
            if [ -f "$scenario/install-public-$cid" ]; then
                exit 42
            fi
            if [ -f "$scenario/install-auth-denied-$cid" ]; then
                exit 43
            fi
            if [ -f "$scenario/install-fail-$cid" ]; then
                exit 41
            fi
            exit 40
        fi
        exit 0
        ;;
    *)
        echo "unexpected fake docker command: $cmd $*" >&2
        exit 127
        ;;
esac
SH
    chmod +x "$FAKE_DOCKER"
}

write_project_config() {
    local home_dir="$1"
    local project_root="$2"
    local config_dir="$home_dir/Library/Application Support/portico"
    mkdir -p "$config_dir"
    "$TEST_PYTHON_BIN" - "$config_dir/project-config.json" "$project_root" <<'PY'
import json
import sys

config_path, project_root = sys.argv[1:]
with open(config_path, "w", encoding="utf-8") as f:
    json.dump(
        {
            "projectRoot": project_root,
            "savedAt": "2026-01-01T00:00:00.000Z",
        },
        f,
        indent=2,
    )
    f.write("\n")
PY
}

setup_project() {
    local scenario="$1"
    local project="$scenario/project"
    mkdir -p \
        "$project/mcp-configs" \
        "$scenario/home" \
        "$scenario/managed" \
        "$scenario/runtime-secrets"
    chmod 700 "$scenario/runtime-secrets"
    write_project_config "$scenario/home" "$project"
    cp "$AUDIT_SCRIPT" "$project/security-audit.sh"
    printf '%s\n' "$project"
}

write_legacy_oauth_store() {
    local root="$1"
    mkdir -p "$root/server"
    chmod 700 "$root"
    printf '%s\n' '{"access_token":"legacy-token-do-not-print"}' \
        >"$root/server/demo_tokens.json"
    printf '%s\n' '{"client_secret":"legacy-client-do-not-print"}' \
        >"$root/server/demo_client.json"
    chmod 600 "$root/server/demo_tokens.json" "$root/server/demo_client.json"
}

run_audit() {
    local scenario="$1"
    local project="$2"
    local output="$3"
    set +e
    HOME="$scenario/home" \
    PORTICO_MANAGED_ROOT="$scenario/managed" \
    PORTICO_RUNTIME_SECRET_CACHE_DIR="$scenario/runtime-secrets" \
    PYTHON_BIN="$TEST_PYTHON_BIN" \
    portico_SECURITY_AUDIT_HTTP_PROBES="${portico_SECURITY_AUDIT_HTTP_PROBES:-0}" \
    portico_SECURITY_AUDIT_HTTP_PROBE_IDS="${portico_SECURITY_AUDIT_HTTP_PROBE_IDS:-}" \
    portico_SECURITY_AUDIT_HTTP_TIMEOUT_SECONDS="${portico_SECURITY_AUDIT_HTTP_TIMEOUT_SECONDS:-0.5}" \
    portico_SECURITY_AUDIT_SOCKET_BINDINGS="${portico_SECURITY_AUDIT_SOCKET_BINDINGS:-0}" \
    portico_SECURITY_AUDIT_DOCKER_BIN="$FAKE_DOCKER" \
    FAKE_DOCKER_SCENARIO="$scenario" \
    bash "$project/security-audit.sh" >"$output" 2>&1
    local status=$?
    set -e
    return "$status"
}

start_http_probe_server() {
    local status_code="$1"
    local scenario="$2"
    local port_file="$scenario/http-probe-port-$status_code"
    local log_file="$scenario/http-probe-$status_code.log"
    "$TEST_PYTHON_BIN" - "$status_code" "$port_file" >"$log_file" 2>&1 <<'PY' &
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

status_code = int(sys.argv[1])
port_file = Path(sys.argv[2])

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.respond()

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
            if length:
                self.rfile.read(length)
        except Exception:
            pass
        self.respond()

    def respond(self):
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *_args):
        return

server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
port_file.write_text(str(server.server_port), encoding="utf-8")
server.serve_forever()
PY
    local pid=$!
    for _ in $(seq 1 50); do
        if [ -s "$port_file" ]; then
            printf '%s:%s\n' "$pid" "$(cat "$port_file")"
            return 0
        fi
        sleep 0.1
    done
    kill "$pid" 2>/dev/null || true
    fail "HTTP probe server did not start"
}

start_http_disconnect_server() {
    local scenario="$1"
    local port_file="$scenario/http-disconnect-port"
    local log_file="$scenario/http-disconnect.log"
    "$TEST_PYTHON_BIN" - "$port_file" >"$log_file" 2>&1 <<'PY' &
import socketserver
import sys
from pathlib import Path

port_file = Path(sys.argv[1])

class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            self.request.recv(4096)
        except Exception:
            pass
        try:
            self.request.close()
        except Exception:
            pass

class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True

server = Server(("127.0.0.1", 0), Handler)
port_file.write_text(str(server.server_address[1]), encoding="utf-8")
server.serve_forever()
PY
    local pid=$!
    for _ in $(seq 1 50); do
        if [ -s "$port_file" ]; then
            printf '%s:%s\n' "$pid" "$(cat "$port_file")"
            return 0
        fi
        sleep 0.1
    done
    kill "$pid" 2>/dev/null || true
    fail "HTTP disconnect server did not start"
}

write_green_fixture() {
    local scenario="$1"
    local project="$2"
    local runtime_secret="$scenario/runtime-secrets/owui_auth_bridge_secret"
    local managed_store="$project/open-webui-data/managed-node-mcp-packages"
    local managed_config="$scenario/managed-node-mcp-config.json"

    printf 'secret\n' >"$runtime_secret"
    chmod 600 "$runtime_secret"
    mkdir -p "$managed_store/demo-server/package/node_modules/demo-server"
    printf '%s\n' '{"name":"demo-server","version":"1.0.0","bin":{"demo-server":"bin/server.js"}}' \
        >"$managed_store/demo-server/package/node_modules/demo-server/package.json"
    printf '%s\n' '{"packages":{"node_modules/demo-server":{"resolved":"https://npm.artifacts.example.invalid/harbor/demo-server/-/demo-server-1.0.0.tgz","funding":{"url":"https://github.com/sponsors/example"}}}}' \
        >"$managed_store/demo-server/package/package-lock.json"
    printf '%s\n' '{"mcpServers":{"demo-server":{"command":"__portico_managed_node_package__","args":[],"managed_node_package":{"server_id":"demo-server","package_name":"demo-server","install_dir":"/app/open-webui-data/managed-node-mcp-packages/demo-server/package"}}}}' \
        >"$managed_config"
    printf 'c1\nc2\ncproxy\n' >"$scenario/ps"
    printf 'https://npm.artifacts.example.invalid/\n' >"$scenario/registry-c1"
    printf 'https://npm.artifacts.example.invalid/\n' >"$scenario/registry-c2"
    touch "$scenario/install-auth-denied-c1"
    touch "$scenario/install-auth-denied-c2"

    "$TEST_PYTHON_BIN" - "$scenario/inspect.json" "$runtime_secret" "$managed_store" "$managed_config" <<'PY'
import json
import sys

out, runtime_secret, managed_store, managed_config = sys.argv[1:]
container = {
    "Id": "c1",
    "Name": "/mcpo",
    "Config": {
        "Image": "portico-mcpo-control-plane-rust:latest",
        "Labels": {"com.docker.compose.project": "portico"},
        "Env": [
                "OWUI_AUTH_BRIDGE_SECRET_FILE=/run/secrets/owui_auth_bridge_secret",
                "WEBUI_AUTH=True",
                "ENABLE_PASSWORD_AUTH=False",
                "NPM_CONFIG_AUDIT=false",
                "NPM_CONFIG_CACHE=/tmp/.npm",
                "NPM_CONFIG_FUND=false",
                "NPM_CONFIG_REGISTRY=${NPM_CONFIG_REGISTRY:-https://registry.npmjs.org/}",
                "NPM_CONFIG_UPDATE_NOTIFIER=false",
                "NODE_ENV=production",
            ],
    },
    "Mounts": [
        {
            "Type": "bind",
            "Source": runtime_secret,
            "Destination": "/run/secrets/owui_auth_bridge_secret",
            "Mode": "ro",
            "RW": False,
        },
    ],
    "NetworkSettings": {
        "Ports": {"8765/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8765"}]}
    },
}
proxy = {
    "Id": "cproxy",
    "Name": "/docker-socket-proxy",
    "Config": {
        "Image": "tecnativa/docker-socket-proxy:latest",
        "Labels": {"com.docker.compose.project": "portico"},
        "Env": [
            "SECRETS=1",
            "AUTH=1",
            "CONTAINERS=1",
        ],
    },
    "Mounts": [
        {
            "Type": "bind",
            "Source": "/var/run/docker.sock",
            "Destination": "/var/run/docker.sock",
            "Mode": "ro",
            "RW": False,
        },
    ],
    "NetworkSettings": {"Ports": {"2375/tcp": None}},
}
probe = {
    "Id": "c2",
    "Name": "/mcpo-probe",
    "Config": {
        "Image": "portico-mcp-orc-rust:latest",
        "Labels": {"com.docker.compose.project": "portico"},
        "Env": [
            "NPM_CONFIG_REGISTRY=${NPM_CONFIG_REGISTRY:-https://registry.npmjs.org/}",
            "portico_OAUTH_ACCESS_TOKEN_BROKER_URL=http://host.docker.internal:8891/secrets/oauth/access-token",
            "portico_OAUTH_ACCESS_TOKEN_SERVER_ID=demo-server",
            "portico_OAUTH_ACCESS_TOKEN_BROKER_TOKEN=scoped-oauth-token",
            "portico_STATIC_SECRET_BROKER_URL=http://host.docker.internal:8891/secrets/static-secret",
            "portico_STATIC_SECRET_TARGETS=demo-server|sourcegraph_token|/dev/shm/portico-runtime-secrets/sourcegraph_token|portico_STATIC_SECRET_TOKEN_DEMO_SERVER_SOURCEGRAPH_TOKEN|",
            "portico_STATIC_SECRET_TOKEN_DEMO_SERVER_SOURCEGRAPH_TOKEN=scoped-static-token",
            "SOURCEGRAPH_TOKEN_FILE=/dev/shm/portico-runtime-secrets/sourcegraph_token",
            "NODE_ENV=production",
        ],
    },
    "Mounts": [
        {
            "Type": "bind",
            "Source": managed_config,
            "Destination": "/app/mcp_config.json",
            "Mode": "ro",
            "RW": False,
        },
        {
            "Type": "bind",
            "Source": managed_store,
            "Destination": "/app/open-webui-data/managed-node-mcp-packages",
            "Mode": "ro",
            "RW": False,
        },
    ],
    "NetworkSettings": {"Ports": {}},
}
with open(out, "w", encoding="utf-8") as f:
    json.dump([container, probe, proxy], f)
PY
}

write_red_fixture() {
    local scenario="$1"
    local project="$2"
    local runtime_secret="$scenario/runtime-secrets/portico_llm_api_key"
    local legacy_cache="$project/open-webui-data/runtime-secrets"
    local token_root="$project/mcpo-oauth-tokens"
    local raw_mcp_config="$scenario/raw-mcp-config.json"

    printf 'secret\n' >"$runtime_secret"
    chmod 644 "$runtime_secret"
    mkdir -p "$legacy_cache"
    chmod 700 "$legacy_cache"
    printf 'stale-secret\n' >"$legacy_cache/stale_secret"
    chmod 644 "$legacy_cache/stale_secret"
    mkdir -p "$token_root/server"
    chmod 700 "$token_root"
    printf '%s\n' '{"access_token":"plaintext-token-do-not-print"}' >"$token_root/server/demo_tokens.json"
    printf '%s\n' '{"client_secret":"plaintext-client-do-not-print"}' >"$token_root/server/demo_client.json"
    chmod 600 "$token_root/server/demo_tokens.json" "$token_root/server/demo_client.json"
    printf 'PORTICO_LLM_API_KEY=env-file-secret-do-not-print\n' >"$project/.env.runtime"
    printf '%s\n' '{"mcpServers":{"raw-node":{"command":"npx","args":["-y","demo-server@1.0.0"]}}}' >"$raw_mcp_config"
    printf 'c1\n' >"$scenario/ps"
    printf 'https://registry.npmjs.org/\n' >"$scenario/registry-c1"

    "$TEST_PYTHON_BIN" - "$scenario/inspect.json" "$runtime_secret" "$token_root" "$raw_mcp_config" <<'PY'
import json
import sys

out, runtime_secret, token_root, raw_mcp_config = sys.argv[1:]
container = {
    "Id": "c1",
    "Name": "/mcpo",
    "Config": {
        "Image": "portico-mcpo-control-plane-rust:latest",
        "Labels": {"com.docker.compose.project": "portico"},
        "Env": [
            "PORTICO_LLM_API_KEY=raw-env-secret-do-not-print",
            "PORTICO_LLM_API_KEY_FILE=/run/secrets/portico_llm_api_key",
            "NPM_CONFIG_USERCONFIG=/tmp/runtime.npmrc",
            "SLACK_MCP_XOXP_TOKEN=slack-env-secret-do-not-print",
        ],
    },
    "Mounts": [
        {
            "Type": "bind",
            "Source": runtime_secret,
            "Destination": "/run/secrets/portico_llm_api_key",
            "Mode": "ro",
            "RW": False,
        },
        {
            "Type": "bind",
            "Source": token_root,
            "Destination": "/root/.mcpo",
            "Mode": "rw",
            "RW": True,
        },
        {
            "Type": "bind",
            "Source": "/tmp/managed-node-mcp-package-acquisition",
            "Destination": "/app/open-webui-data/managed-node-mcp-package-acquisition",
            "Mode": "rw",
            "RW": True,
        },
        {
            "Type": "bind",
            "Source": raw_mcp_config,
            "Destination": "/app/mcp_config.json",
            "Mode": "ro",
            "RW": False,
        },
    ],
    "NetworkSettings": {
        "Ports": {"8765/tcp": [{"HostIp": "0.0.0.0", "HostPort": "8765"}]}
    },
}
with open(out, "w", encoding="utf-8") as f:
    json.dump([container], f)
PY
}

write_yellow_fixture() {
    local scenario="$1"
    local project="$2"

    mkdir -p "$project/mcp-configs/sourcegraph" "$project/mcp-configs/slack"
    cat >"$project/mcp-configs/sourcegraph/sourcegraph.yaml" <<'YAML'
required_env_vars:
  - name: SOURCEGRAPH_TOKEN
    sensitive: true
YAML
    cat >"$project/mcp-configs/sourcegraph/sourcegraph.fragment" <<'JSON'
{
  "command": "docker",
  "args": [
    "run",
    "--rm",
    "-e",
    "SOURCEGRAPH_TOKEN",
    "registry.example.invalid/sourcegraph-mcp-server:latest"
  ]
}
JSON
    cat >"$project/mcp-configs/slack/slack.fragment" <<'JSON'
{
  "command": "/app/mcp-servers/slack-mcp-server",
  "args": [],
  "http_subprocess": {
    "enabled": true,
    "oauth_access_token_env": "SLACK_MCP_XOXP_TOKEN",
    "oauth_access_token_file_env": "SLACK_MCP_OAUTH_ACCESS_TOKEN_FILE"
  }
}
JSON
    printf 'runtime-secret\n' >"$scenario/runtime-secrets/placeholder"
    chmod 600 "$scenario/runtime-secrets/placeholder"
    printf 'c2\n' >"$scenario/ps"
    touch "$scenario/npm-missing-c2"

    "$TEST_PYTHON_BIN" - "$scenario/inspect.json" <<'PY'
import json
import sys

out = sys.argv[1]
container = {
    "Id": "c2",
    "Name": "/sourcegraph-mcp-child",
    "Config": {
        "Image": "registry.example.invalid/sourcegraph-mcp-server:latest",
        "Labels": {},
        "Env": [
            "SOURCEGRAPH_TOKEN=child-token-do-not-print",
            "NODE_ENV=production",
        ],
    },
    "Mounts": [],
    "NetworkSettings": {"Ports": {"8976/tcp": None}},
}
with open(out, "w", encoding="utf-8") as f:
    json.dump([container], f)
PY
}

write_sensitive_runtime_file_fixture() {
    local scenario="$1"
    local project="$2"
    local mount_mode="$3"
    local snowflake_source="$scenario/home/.snowflake/connections.toml"

    mkdir -p "$project/mcp-configs/snowflake" "$scenario/home/.snowflake"
    cat >"$project/mcp-configs/snowflake/snowflake.yaml" <<'YAML'
runtime_files:
  - source: ~/.snowflake/connections.toml
    target: /root/.snowflake/connections.toml
    sensitive: true
YAML
    printf 'token = "secret-token-do-not-print"\n' >"$snowflake_source"
    chmod 600 "$snowflake_source"

    local secret_name mount_source
    secret_name="$("$TEST_PYTHON_BIN" - <<'PY'
import hashlib
server_id = "snowflake"
target = "/root/.snowflake/connections.toml"
digest = hashlib.sha256((server_id + "\0" + target).encode()).hexdigest()[:12]
print(f"portico_runtime_file_snowflake_connections_toml_{digest}")
PY
)"
    case "$mount_mode" in
        cache)
            mount_source="$scenario/runtime-secrets/$secret_name"
            printf 'token = "secret-token-do-not-print"\n' >"$mount_source"
            chmod 600 "$mount_source"
            ;;
        direct)
            mount_source="$snowflake_source"
            ;;
        *)
            fail "unknown sensitive runtime-file fixture mode: $mount_mode"
            ;;
    esac

    printf 'csnow\n' >"$scenario/ps"
    printf 'https://npm.artifacts.example.invalid/\n' >"$scenario/registry-csnow"
    touch "$scenario/install-auth-denied-csnow"

    "$TEST_PYTHON_BIN" - "$scenario/inspect.json" "$mount_source" <<'PY'
import json
import sys

out, mount_source = sys.argv[1:]
container = {
    "Id": "csnow",
    "Name": "/mcpo-snowflake",
    "Config": {
        "Image": "portico-mcp-orc-rust:latest",
        "Labels": {"com.docker.compose.project": "portico"},
        "Env": [
            "NODE_ENV=production",
            "NPM_CONFIG_REGISTRY=${NPM_CONFIG_REGISTRY:-https://registry.npmjs.org/}",
        ],
    },
    "Mounts": [
        {
            "Type": "bind",
            "Source": mount_source,
            "Destination": "/root/.snowflake/connections.toml",
            "Mode": "ro",
            "RW": False,
        },
    ],
    "NetworkSettings": {"Ports": {}},
}
with open(out, "w", encoding="utf-8") as f:
    json.dump([container], f)
PY
}

test_green_posture() {
    local scenario="$TMP_DIR/green"
    local project output
    mkdir -p "$scenario"
    project="$(setup_project "$scenario")"
    output="$scenario/output.txt"
    write_green_fixture "$scenario" "$project"

    if ! run_audit "$scenario" "$project" "$output"; then
        fail "GREEN audit exited non-zero"
    fi
    assert_contains "$output" "SECURITY AUDIT RESULT: GREEN" "GREEN fixture must report GREEN"
    assert_contains "$output" "Container: mcpo [first-party]" "container header must be listed"
    assert_contains "$output" "+-" "tables must render with grid borders instead of markdown separators"
    assert_contains "$output" "Host port" "ports must render as a table"
    assert_contains "$output" "Container port" "ports must include container-port column"
    assert_contains "$output" "127.0.0.1" "loopback port host must be listed"
    assert_contains "$output" "8765/tcp" "loopback container port must be listed"
    assert_contains "$output" "loopback" "loopback exposure classification must be listed"
    assert_contains "$output" "Host source" "mounts must render as a table"
    assert_contains "$output" "Container target" "mounts must include container target column"
    assert_contains "$output" "Secret target" "secret mounts must render as a table"
    assert_contains "$output" "OWUI_AUTH_BRIDGE_SECRET_FILE" "env keys must render in the env-key table"
    assert_not_contains "$output" "| --- |" "tables should not use rough markdown separator rows"
    assert_contains "$output" "/run/secrets/owui_auth_bridge_secret" "secret mount target must be listed"
    assert_contains "$output" "Audit notes:" "non-container audit details must be separated from container tables"
    assert_contains "$output" "runtime install denied by Portico registry" "runtime npm install denial must be treated as expected no-credentials posture"
    assert_not_contains "$output" "raw sensitive env key WEBUI_AUTH" "WEBUI_AUTH must be treated as a non-secret control flag"
    assert_not_contains "$output" "raw sensitive env key ENABLE_PASSWORD_AUTH" "password-auth control flags must be treated as non-secret controls"
    assert_not_contains "$output" "raw sensitive env key portico_OAUTH_ACCESS_TOKEN_BROKER_TOKEN" "scoped OAuth broker token env must be allowed"
    assert_not_contains "$output" "raw sensitive env key portico_STATIC_SECRET_TOKEN_DEMO_SERVER_SOURCEGRAPH_TOKEN" "scoped static-secret broker token env must be allowed"
    assert_not_contains "$output" "raw sensitive env key portico_STATIC_SECRET_BROKER_URL" "static-secret broker URL must be treated as non-secret routing config"
    assert_not_contains "$output" "raw sensitive env key portico_STATIC_SECRET_TARGETS" "static-secret target manifest must be treated as non-secret routing config"
    assert_not_contains "$output" "sensitive file pointer SOURCEGRAPH_TOKEN_FILE does not use /run/secrets" "broker-materialized static secret tmpfs pointer must be GREEN"
    assert_contains "$output" "scoped broker token env key portico_OAUTH_ACCESS_TOKEN_BROKER_TOKEN" "scoped OAuth broker token should be noted without a finding"
    assert_contains "$output" "sensitive file pointer SOURCEGRAPH_TOKEN_FILE uses scoped broker materialization" "tmpfs static-secret pointer should be noted without a finding"
    assert_not_contains "$output" "raw sensitive env key NPM_CONFIG_AUDIT" "Agent VM npm behavior flags must be treated as non-secret controls"
    assert_not_contains "$output" "raw sensitive env key SECRETS" "docker-socket-proxy permission flags must be treated as non-secret controls"
    [ -f "$scenario/install-attempt-c1" ] || fail "GREEN fixture should attempt npm install probe"
    [ -f "$scenario/install-attempt-c2" ] || fail "GREEN fixture should attempt failing npm install probe"
    assert_contains "$scenario/install-command-c1" 'NPM_CONFIG_CACHE="$tmp/.npm"' "npm install probe must isolate its cache and logs"
    assert_not_contains "$scenario/install-command-c1" '${HOME:-/root}/.npm/_logs' "npm install probe must ignore pre-existing global npm logs"
}

test_sensitive_runtime_file_host_cache_bind_red() {
    local scenario="$TMP_DIR/sensitive-runtime-cache-red"
    local project output status
    mkdir -p "$scenario"
    project="$(setup_project "$scenario")"
    output="$scenario/output.txt"
    write_sensitive_runtime_file_fixture "$scenario" "$project" "cache"

    if run_audit "$scenario" "$project" "$output"; then
        status=0
    else
        status=$?
    fi
    [ "$status" -eq 2 ] || fail "host-cache sensitive runtime-file bind should exit 2, got $status"
    assert_contains "$output" "SECURITY AUDIT RESULT: RED" "host-cache sensitive runtime-file bind must report RED"
    assert_contains "$output" "/root/.snowflake/connections.toml" "sensitive runtime-file target must be listed as a secret mount"
    assert_not_contains "$output" "secret-token-do-not-print" "audit output must not print sensitive runtime-file contents"
    assert_not_contains "$output" "mounted directly from" "cache-backed sensitive runtime file must not be reported as direct source bind"
    assert_contains "$output" "sensitive runtime file /root/.snowflake/connections.toml is still mounted from the host runtime secret cache; use scoped broker materialization into container-internal tmpfs" "host-cache sensitive runtime file must be rejected after broker migration"
}

test_sensitive_runtime_file_direct_bind_red() {
    local scenario="$TMP_DIR/sensitive-runtime-red"
    local project output status
    mkdir -p "$scenario"
    project="$(setup_project "$scenario")"
    output="$scenario/output.txt"
    write_sensitive_runtime_file_fixture "$scenario" "$project" "direct"

    if run_audit "$scenario" "$project" "$output"; then
        status=0
    else
        status=$?
    fi
    [ "$status" -eq 2 ] || fail "direct sensitive runtime-file bind should exit 2, got $status"
    assert_contains "$output" "SECURITY AUDIT RESULT: RED" "direct sensitive runtime-file bind must report RED"
    assert_contains "$output" "sensitive runtime file /root/.snowflake/connections.toml is mounted directly from ~/.snowflake/connections.toml" "direct sensitive runtime-file source bind must be rejected"
    assert_not_contains "$output" "secret-token-do-not-print" "audit output must not print sensitive runtime-file contents"
}

test_red_posture() {
    local scenario="$TMP_DIR/red"
    local project output status
    mkdir -p "$scenario"
    project="$(setup_project "$scenario")"
    output="$scenario/output.txt"
    write_red_fixture "$scenario" "$project"

    if run_audit "$scenario" "$project" "$output"; then
        status=0
    else
        status=$?
    fi
    [ "$status" -eq 2 ] || fail "RED audit should exit 2, got $status"
    assert_contains "$output" "SECURITY AUDIT RESULT: RED" "RED fixture must report RED"
    assert_contains "$output" "0.0.0.0" "public port host must be shown in the ports table"
    assert_contains "$output" "public" "public exposure classification must be shown in the ports table"
    assert_contains "$output" "public host port binding 0.0.0.0:8765->8765/tcp" "public port binding must be RED"
    assert_contains "$output" "raw sensitive env key PORTICO_LLM_API_KEY" "raw first-party sensitive env must be RED"
    assert_contains "$output" "legacy Slack OAuth token env key SLACK_MCP_XOXP_TOKEN" "legacy Slack OAuth env must be RED"
    assert_contains "$output" "package-manager credential/config env key NPM_CONFIG_USERCONFIG" "runtime npm config env must be RED"
    assert_contains "$output" "managed Node acquisition scratch/cache is mounted" "runtime acquisition scratch mount must be RED"
    assert_contains "$output" "uses raw package-manager command npx" "raw runtime npx config must be RED"
    assert_contains "$output" "open-webui-data/runtime-secrets/stale_secret" "stale runtime secret cache files must be permission-audited"
    assert_contains "$output" "legacy OAuth token store mount at /root/.mcpo" "legacy OAuth mounts must be RED"
    assert_contains "$output" "legacy OAuth token/client file present; migrate OAuth state to Electron safeStorage" "legacy OAuth token files must be RED with migration guidance"
    assert_contains "$output" "npm registry is not an Portico registry" "public npm registry must be rejected"
    assert_contains "$output" ".env.runtime: sensitive key names present: PORTICO_LLM_API_KEY" ".env.runtime leak must be RED"
    assert_not_contains "$output" "raw-env-secret-do-not-print" "audit output must not print raw env values"
    assert_not_contains "$output" "env-file-secret-do-not-print" "audit output must not print .env values"
    assert_not_contains "$output" "slack-env-secret-do-not-print" "audit output must not print Slack token env values"
    assert_not_contains "$output" "plaintext-token-do-not-print" "audit output must not print OAuth values"
    [ ! -f "$scenario/install-attempt-c1" ] || fail "public npm registry must skip the install probe"
}

test_legacy_oauth_store_requires_migration() {
    local scenario="$TMP_DIR/legacy-oauth-store"
    local project output status
    mkdir -p "$scenario"
    project="$(setup_project "$scenario")"
    output="$scenario/output.txt"
    write_legacy_oauth_store "$project/mcpo-oauth-tokens"
    printf '' >"$scenario/ps"

    if run_audit "$scenario" "$project" "$output"; then
        status=0
    else
        status=$?
    fi
    [ "$status" -eq 2 ] || fail "legacy OAuth store should exit 2, got $status"
    assert_contains "$output" "SECURITY AUDIT RESULT: RED" "legacy OAuth store must report RED"
    assert_contains "$output" "legacy OAuth token store present; migrate OAuth state to Electron safeStorage" "legacy OAuth root must point to migration"
    assert_contains "$output" "legacy OAuth token/client file present; migrate OAuth state to Electron safeStorage" "legacy OAuth files must point to migration"
    assert_not_contains "$output" "legacy-token-do-not-print" "audit output must not print OAuth token payload contents"
    assert_not_contains "$output" "legacy-client-do-not-print" "audit output must not print OAuth client payload contents"
}

test_empty_legacy_oauth_store_remains_red() {
    local scenario="$TMP_DIR/empty-legacy-oauth-store"
    local project output status
    mkdir -p "$scenario"
    project="$(setup_project "$scenario")"
    output="$scenario/output.txt"
    mkdir -p "$project/mcpo-oauth-tokens"
    chmod 700 "$project/mcpo-oauth-tokens"
    printf '' >"$scenario/ps"

    if run_audit "$scenario" "$project" "$output"; then
        status=0
    else
        status=$?
    fi
    [ "$status" -eq 2 ] || fail "empty legacy OAuth store should exit 2, got $status"
    assert_contains "$output" "SECURITY AUDIT RESULT: RED" "empty legacy OAuth root must report RED"
    assert_contains "$output" "legacy OAuth token store present; migrate OAuth state to Electron safeStorage" "empty legacy OAuth root must still point to removal"
    assert_not_contains "$output" "legacy OAuth token/client file present" "empty legacy OAuth root must not invent token file findings"
}

test_yellow_mcp_child_posture() {
    local scenario="$TMP_DIR/yellow"
    local project output status
    mkdir -p "$scenario"
    project="$(setup_project "$scenario")"
    output="$scenario/output.txt"
    write_yellow_fixture "$scenario" "$project"

    if run_audit "$scenario" "$project" "$output"; then
        status=0
    else
        status=$?
    fi
    [ "$status" -eq 1 ] || fail "YELLOW audit should exit 1, got $status"
    assert_contains "$output" "SECURITY AUDIT RESULT: YELLOW" "YELLOW fixture must report YELLOW"
    assert_contains "$output" "Container: sourcegraph-mcp-child [mcp-child]" "MCP child container header must be listed"
    assert_contains "$output" "8976/tcp" "container-only exposed ports must be shown in the ports table"
    assert_contains "$output" "container-only" "container-only exposure classification must be shown in the ports table"
    assert_contains "$output" "SOURCEGRAPH_TOKEN" "MCP child env key name must appear in the env-key table"
    assert_contains "$output" "Audit notes:" "MCP child npm note must be separated from container tables"
    assert_contains "$output" "owning MCP child env key SOURCEGRAPH_TOKEN" "owning MCP child token env must be informational"
    assert_contains "$output" "OAuth access token compatibility path uses child env key SLACK_MCP_XOXP_TOKEN" "Slack oauth_access_token_env must be YELLOW"
    assert_not_contains "$output" "raw owning MCP child env key SOURCEGRAPH_TOKEN" "owning MCP child token env must not be a finding by itself"
    assert_contains "$output" "npm is not installed, skipping install probe" "MCP child npm absence should be reported without failing posture"
    assert_not_contains "$output" "[RED]" "YELLOW fixture must not contain RED findings"
    assert_not_contains "$output" "child-token-do-not-print" "audit output must not print child token values"
}

test_project_config_dev_root_skips_managed_env_files() {
    local scenario="$TMP_DIR/workspace-dev"
    local project output resolved_managed resolved_project status
    mkdir -p "$scenario"
    project="$(setup_project "$scenario")"
    resolved_project="$(resolve_path "$project")"
    resolved_managed="$(resolve_path "$scenario/managed")"
    output="$scenario/output.txt"
    printf 'PORTICO_LLM_API_KEY=managed-secret-do-not-print\n' >"$scenario/managed/runtime-secrets.env"
    printf '' >"$scenario/ps"

    if run_audit "$scenario" "$project" "$output"; then
        status=0
    else
        status=$?
    fi
    [ "$status" -eq 1 ] || fail "dev-root audit without containers should exit 1, got $status"
    assert_contains "$output" "SECURITY AUDIT RESULT: YELLOW" "dev-root audit without containers should report YELLOW"
    assert_contains "$output" "Project root: $resolved_project (source: project-config)" "audit must report project-config dev root"
    assert_contains "$output" "no running Portico Docker containers were discovered" "empty fake docker ps should remain YELLOW"
    assert_not_contains "$output" "$scenario/managed/runtime-secrets.env" "dev-root audit must not scan managed-root env files"
    assert_not_contains "$output" "$resolved_managed/runtime-secrets.env" "dev-root audit must not scan resolved managed-root env files"
    assert_not_contains "$output" "managed-secret-do-not-print" "audit output must not print managed env values"
}

test_dev_checkout_allows_protected_cloudsmith_operator_key() {
    local scenario="$TMP_DIR/dev-cloudsmith-operator-input"
    local project output status
    mkdir -p "$scenario"
    project="$(setup_project "$scenario")"
    output="$scenario/output.txt"
    mkdir -p "$project/.git"
    printf 'CLOUDSMITH_API_KEY=protected-operator-secret-do-not-print\n' >"$project/.env"
    chmod 600 "$project/.env"
    printf '' >"$scenario/ps"

    if run_audit "$scenario" "$project" "$output"; then
        status=0
    else
        status=$?
    fi
    [ "$status" -eq 1 ] || fail "dev checkout operator input audit should exit 1 without containers, got $status"
    assert_contains "$output" "SECURITY AUDIT RESULT: YELLOW" "dev checkout operator input must not make the audit RED"
    assert_contains "$output" "protected repository operator input present:" "audit must identify the protected checkout boundary"
    assert_not_contains "$output" ".env: sensitive key names present: CLOUDSMITH_API_KEY" "protected checkout .env must not be treated as managed plaintext"
    assert_not_contains "$output" "protected-operator-secret-do-not-print" "audit output must not print the Cloudsmith value"
}

test_project_config_managed_root_scans_managed_env_files() {
    local scenario="$TMP_DIR/workspace-managed"
    local project output resolved_managed status
    mkdir -p "$scenario"
    project="$(setup_project "$scenario")"
    output="$scenario/output.txt"
    write_project_config "$scenario/home" "$scenario/managed"
    resolved_managed="$(resolve_path "$scenario/managed")"
    printf '%s\n' \
        'PORTICO_LLM_API_KEY=managed-secret-do-not-print' \
        'CLOUDSMITH_API_KEY=managed-cloudsmith-secret-do-not-print' \
        >"$scenario/managed/runtime-secrets.env"
    printf '' >"$scenario/ps"

    if run_audit "$scenario" "$project" "$output"; then
        status=0
    else
        status=$?
    fi
    [ "$status" -eq 2 ] || fail "managed-root env leak audit should exit 2, got $status"
    assert_contains "$output" "SECURITY AUDIT RESULT: RED" "managed-root env leak must report RED"
    assert_contains "$output" "Project root: $resolved_managed (source: project-config)" "audit must report project-config managed root"
    assert_contains "$output" "$resolved_managed/runtime-secrets.env: sensitive key names present: CLOUDSMITH_API_KEY, PORTICO_LLM_API_KEY" "managed-root env file must keep Cloudsmith in the plaintext audit"
    assert_not_contains "$output" "managed-secret-do-not-print" "audit output must not print managed env values"
    assert_not_contains "$output" "managed-cloudsmith-secret-do-not-print" "audit output must not print managed Cloudsmith values"
}

test_http_auth_probe_accepts_unauthenticated_rejection() {
    local scenario="$TMP_DIR/http-auth-reject"
    local project output server pid port status
    mkdir -p "$scenario"
    project="$(setup_project "$scenario")"
    output="$scenario/output.txt"
    printf '' >"$scenario/ps"
    server="$(start_http_probe_server 401 "$scenario")"
    pid="${server%%:*}"
    port="${server##*:}"

    if portico_SECURITY_AUDIT_HTTP_PROBES=1 \
        portico_SECURITY_AUDIT_HTTP_PROBE_IDS=host-mcp-bridge \
        portico_SECURITY_AUDIT_HOST_MCP_BRIDGE_URL="http://127.0.0.1:$port/mcp" \
        run_audit "$scenario" "$project" "$output"; then
        status=0
    else
        status=$?
    fi
    kill "$pid" 2>/dev/null || true
    [ "$status" -eq 1 ] || fail "401 auth probe with no containers should remain YELLOW, got $status"
    assert_contains "$output" "SECURITY AUDIT RESULT: YELLOW" "401 auth probe should not make fixture RED"
    assert_contains "$output" "Host MCP Bridge streamable HTTP: unauthenticated request rejected with HTTP 401" "401 auth probe should be recorded as an accepted auth rejection"
    assert_not_contains "$output" "unauthenticated HTTP probe reached" "401 auth probe must not be reported as reachable without auth"
}

test_oauth_token_broker_probe_accepts_unauthenticated_rejection() {
    local scenario="$TMP_DIR/http-oauth-broker-auth-reject"
    local project output server pid port status
    mkdir -p "$scenario"
    project="$(setup_project "$scenario")"
    output="$scenario/output.txt"
    printf '' >"$scenario/ps"
    server="$(start_http_probe_server 401 "$scenario")"
    pid="${server%%:*}"
    port="${server##*:}"

    if portico_SECURITY_AUDIT_HTTP_PROBES=1 \
        portico_SECURITY_AUDIT_HTTP_PROBE_IDS=host-mcp-oauth-token-broker \
        portico_SECURITY_AUDIT_HOST_MCP_OAUTH_TOKEN_BROKER_URL="http://127.0.0.1:$port/secrets/oauth/access-token" \
        run_audit "$scenario" "$project" "$output"; then
        status=0
    else
        status=$?
    fi
    kill "$pid" 2>/dev/null || true
    [ "$status" -eq 1 ] || fail "401 OAuth broker probe with no containers should remain YELLOW, got $status"
    assert_contains "$output" "SECURITY AUDIT RESULT: YELLOW" "401 OAuth broker probe should not make fixture RED"
    assert_contains "$output" "Host MCP Bridge OAuth token broker: unauthenticated request rejected with HTTP 401" "OAuth broker 401 probe should be recorded as an accepted auth rejection"
    assert_not_contains "$output" "unauthenticated HTTP probe reached" "OAuth broker 401 probe must not be reported as reachable without auth"
}

test_loopback_metadata_probe_accepts_unauthenticated_success() {
    local scenario="$TMP_DIR/http-loopback-metadata"
    local project output server pid port status
    mkdir -p "$scenario"
    project="$(setup_project "$scenario")"
    output="$scenario/output.txt"
    printf '' >"$scenario/ps"
    server="$(start_http_probe_server 200 "$scenario")"
    pid="${server%%:*}"
    port="${server##*:}"

    if portico_SECURITY_AUDIT_HTTP_PROBES=1 \
        portico_SECURITY_AUDIT_HTTP_PROBE_IDS=mcpo \
        portico_SECURITY_AUDIT_MCPO_URL="http://127.0.0.1:$port/openapi.json" \
        run_audit "$scenario" "$project" "$output"; then
        status=0
    else
        status=$?
    fi
    kill "$pid" 2>/dev/null || true
    [ "$status" -eq 1 ] || fail "200 loopback metadata probe with no containers should remain YELLOW, got $status"
    assert_contains "$output" "SECURITY AUDIT RESULT: YELLOW" "loopback metadata probe should not make fixture RED"
    assert_contains "$output" "MCPO OpenAPI metadata: loopback metadata endpoint reachable with HTTP 200" "loopback metadata probe should be recorded as informational"
    assert_not_contains "$output" "MCPO OpenAPI metadata: unauthenticated HTTP probe reached" "loopback metadata probe must not use bearer-auth failure wording"
}

test_http_auth_probe_flags_unauthenticated_success() {
    local scenario="$TMP_DIR/http-auth-open"
    local project output server pid port status
    mkdir -p "$scenario"
    project="$(setup_project "$scenario")"
    output="$scenario/output.txt"
    printf '' >"$scenario/ps"
    server="$(start_http_probe_server 200 "$scenario")"
    pid="${server%%:*}"
    port="${server##*:}"

    if portico_SECURITY_AUDIT_HTTP_PROBES=1 \
        portico_SECURITY_AUDIT_HTTP_PROBE_IDS=host-mcp-bridge \
        portico_SECURITY_AUDIT_HOST_MCP_BRIDGE_URL="http://127.0.0.1:$port/mcp" \
        run_audit "$scenario" "$project" "$output"; then
        status=0
    else
        status=$?
    fi
    kill "$pid" 2>/dev/null || true
    [ "$status" -eq 2 ] || fail "200 auth probe should exit 2, got $status"
    assert_contains "$output" "SECURITY AUDIT RESULT: RED" "200 auth probe must report RED"
    assert_contains "$output" "Host MCP Bridge streamable HTTP: unauthenticated HTTP probe reached" "200 auth probe must be rejected as reachable without auth"
    assert_contains "$output" "service must reject requests without an auth token" "200 auth probe finding must describe the auth-token requirement"
}

test_http_auth_probe_disconnect_is_informational() {
    local scenario="$TMP_DIR/http-auth-disconnect"
    local project output server pid port status
    mkdir -p "$scenario"
    project="$(setup_project "$scenario")"
    output="$scenario/output.txt"
    printf '' >"$scenario/ps"
    server="$(start_http_disconnect_server "$scenario")"
    pid="${server%%:*}"
    port="${server##*:}"

    if portico_SECURITY_AUDIT_HTTP_PROBES=1 \
        portico_SECURITY_AUDIT_HTTP_PROBE_IDS=llm-debug-monitor \
        portico_SECURITY_AUDIT_DEBUG_MONITOR_URL="http://127.0.0.1:$port/api/sessions" \
        run_audit "$scenario" "$project" "$output"; then
        status=0
    else
        status=$?
    fi
    kill "$pid" 2>/dev/null || true
    [ "$status" -eq 1 ] || fail "disconnect probe with no containers should remain YELLOW, got $status"
    assert_contains "$output" "SECURITY AUDIT RESULT: YELLOW" "disconnect probe should not make fixture RED"
    assert_contains "$output" "LLM Debug Monitor: connection closed without an unauthenticated HTTP response" "disconnect probe should be recorded as informational"
    assert_not_contains "$output" "LLM Debug Monitor: HTTP auth probe failed" "disconnect probe must not be a YELLOW probe failure"
}

write_fake_docker
bash -n "$AUDIT_SCRIPT"
test_green_posture
test_sensitive_runtime_file_host_cache_bind_red
test_sensitive_runtime_file_direct_bind_red
test_red_posture
test_legacy_oauth_store_requires_migration
test_empty_legacy_oauth_store_remains_red
test_yellow_mcp_child_posture
test_project_config_dev_root_skips_managed_env_files
test_dev_checkout_allows_protected_cloudsmith_operator_key
test_project_config_managed_root_scans_managed_env_files
test_http_auth_probe_accepts_unauthenticated_rejection
test_oauth_token_broker_probe_accepts_unauthenticated_rejection
test_loopback_metadata_probe_accepts_unauthenticated_success
test_http_auth_probe_flags_unauthenticated_success
test_http_auth_probe_disconnect_is_informational

echo "PASS: security-audit.sh posture fixtures"
