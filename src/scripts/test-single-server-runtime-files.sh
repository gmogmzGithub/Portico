#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

DOCKER_LOG="$TMP_DIR/docker-compose-calls.log"
COMPOSE_FILE="$TMP_DIR/docker-compose.single-server.yml"
OUTPUT_FILE="$TMP_DIR/last-output.txt"
LAST_STATUS=0

mkdir -p \
  "$TMP_DIR/src/scripts" \
  "$TMP_DIR/electron-app" \
  "$TMP_DIR/mcp-configs" \
  "$TMP_DIR/runtime" \
  "$TMP_DIR/bin" \
  "$TMP_DIR/no-node-bin" \
  "$TMP_DIR/broken-node-bin"

cp "$PROJECT_ROOT/src/scripts/start-single-mcp-server.sh" "$TMP_DIR/src/scripts/start-single-mcp-server.sh"
cp "$PROJECT_ROOT/src/scripts/mcp-orc-backend.sh" "$TMP_DIR/src/scripts/mcp-orc-backend.sh"
cp "$PROJECT_ROOT/src/scripts/runtime-secrets.sh" "$TMP_DIR/src/scripts/runtime-secrets.sh"
cat >"$TMP_DIR/src/scripts/mcp-orc-cli.sh" <<'EOF'
#!/bin/bash
run_mcp_orc_generator() {
  if [ "${2:-}" = "prepare-managed-node-packages" ]; then
    return 0
  fi
  if [ "${2:-}" = "inspect-server-metadata" ]; then
    "$1/electron-app/node-real" - "$4" "$1/electron-app/node_modules/js-yaml" <<'NODE'
const fs = require('fs');
const yaml = require(process.argv[3]);
const value = yaml.load(fs.readFileSync(process.argv[2], 'utf8')) || {};
process.stdout.write(JSON.stringify({
  required_env_vars: (value.required_env_vars || []).map((entry) =>
    typeof entry === 'string' ? {name: entry, sensitive: false} : {...entry, sensitive: entry.sensitive === true}),
  preset_env_vars: value.preset_env_vars || [],
  tool_rename_mapping: value.tool_rename_mapping || null,
  image_platform: value.image_platform || null,
}));
NODE
    return 0
  fi
  echo "Unexpected mcp-orc generator call: $*" >&2
  return 99
}
EOF
ln -s "$PROJECT_ROOT/electron-app/node_modules" "$TMP_DIR/electron-app/node_modules"
ln -s "$(command -v node)" "$TMP_DIR/electron-app/node-real"

cat >"$TMP_DIR/bin/docker" <<EOF
#!/bin/bash
set -euo pipefail

case "\${1:-}" in
  ps)
    exit 0
    ;;
  rm)
    exit 0
    ;;
  network)
    exit 0
    ;;
  image)
    if [ "\${2:-}" = "inspect" ]; then
      exit 1
    fi
    exit 0
    ;;
  compose)
    if [ "\${2:-}" = "version" ]; then
      if [ "\${PLUGIN_MODE:-healthy}" = "healthy" ]; then
        echo "Docker Compose version v2.39.1"
        exit 0
      fi
      echo "docker: unknown command: docker compose" >&2
      exit 1
    fi
    if [ "\${PLUGIN_MODE:-healthy}" != "healthy" ]; then
      echo "unknown shorthand flag: 'f' in -f" >&2
      exit 125
    fi
    echo "\$*" >> "$DOCKER_LOG"
    exit 0
    ;;
esac

echo "Unexpected docker command: \$*" >&2
exit 99
EOF
chmod +x "$TMP_DIR/bin/docker"

cat >"$TMP_DIR/bin/docker-compose" <<EOF
#!/bin/bash
set -euo pipefail

if [ "\${1:-}" = "version" ]; then
  echo "Docker Compose version v5.1.2"
  exit 0
fi

echo "standalone \$*" >> "$DOCKER_LOG"
exit 0
EOF
chmod +x "$TMP_DIR/bin/docker-compose"

cat >"$TMP_DIR/bin/security" <<'EOF'
#!/bin/bash
set -euo pipefail
case "${1:-}" in
  add-generic-password)
    exit 0
    ;;
  find-generic-password)
    exit 44
    ;;
esac
echo "Unexpected security command: $*" >&2
exit 99
EOF
chmod +x "$TMP_DIR/bin/security"

resolve_test_python3() {
  local candidate=""
  for candidate in /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
    if [ -x "$candidate" ] && "$candidate" --version >/dev/null 2>&1; then
      echo "$candidate"
      return 0
    fi
  done
  if command -v python3 >/dev/null 2>&1 && python3 --version >/dev/null 2>&1; then
    command -v python3
    return 0
  fi
  return 1
}

TEST_PYTHON3="$(resolve_test_python3 || true)"
if [ -z "$TEST_PYTHON3" ]; then
  echo "python3 is required for single-server runtime_files tests"
  exit 1
fi

link_no_node_tool() {
  local tool_name="$1"
  local tool_path=""
  tool_path="$(type -P "$tool_name" || true)"
  if [ -z "$tool_path" ]; then
    echo "Required test tool is unavailable: $tool_name"
    exit 1
  fi
  ln -s "$tool_path" "$TMP_DIR/no-node-bin/$tool_name"
}

for tool_name in awk basename bash cat cut dirname find grep head jq mkdir mktemp rm sed sleep sort stat tail tr uname; do
  link_no_node_tool "$tool_name"
done
ln -s "$TMP_DIR/bin/docker" "$TMP_DIR/no-node-bin/docker"
ln -s "$TEST_PYTHON3" "$TMP_DIR/no-node-bin/python3"
NO_NODE_PATH="$TMP_DIR/no-node-bin"

cat >"$TMP_DIR/broken-node-bin/node" <<'EOF'
#!/bin/bash
echo "BROKEN_NODE_ERROR_SHOULD_BE_BUFFERED" >&2
exit 86
EOF
chmod +x "$TMP_DIR/broken-node-bin/node"
BROKEN_NODE_PATH="$TMP_DIR/broken-node-bin:$NO_NODE_PATH"

realpath_file() {
  "$TEST_PYTHON3" - "$1" <<'PY'
import sys
from pathlib import Path

print(Path(sys.argv[1]).resolve(strict=True))
PY
}

write_server() {
  local server_id="$1"
  mkdir -p "$TMP_DIR/mcp-configs/$server_id"
  cat >"$TMP_DIR/mcp-configs/$server_id/$server_id.fragment" <<'JSON'
{"command":"python","args":["server.py"]}
JSON
  cat >"$TMP_DIR/mcp-configs/$server_id/$server_id.yaml"
}

write_snowflake_server() {
  local server_id="$1"
  write_server "$server_id" <<YAML
name: Snowflake
id: $server_id
deployment_type: docker
runtime_files:
  - filename: mcp_config.yaml
    source: ~/.snowflake/mcp_config.yaml
  - source: ~/.snowflake/connections.toml
    target: /root/.snowflake/connections.toml
YAML
}

run_server() {
  local server_id="$1"
  local home_dir="${2:-$HOME}"
  local mcp_mode="${3:-rust-full}"
  local command_path="${4:-$TMP_DIR/bin:$PATH}"
  local plugin_mode="${5:-healthy}"

  : >"$DOCKER_LOG"
  rm -f "$COMPOSE_FILE" "$OUTPUT_FILE"

  set +e
  PATH="$command_path" \
    HOME="$home_dir" \
    MCP_ORC_MODE="$mcp_mode" \
    SENSITIVE_ONE="single-secret" \
    REQUIRED_ONE="required-public" \
    LEGACY_ONE="legacy-public" \
    PLUGIN_MODE="$plugin_mode" \
    bash "$TMP_DIR/src/scripts/start-single-mcp-server.sh" "$server_id" >"$OUTPUT_FILE" 2>&1
  LAST_STATUS=$?
  set -e
}

stop_server() {
  local server_id="$1"

  : >"$DOCKER_LOG"
  rm -f "$OUTPUT_FILE"

  set +e
  PATH="$TMP_DIR/bin:$PATH" \
    bash "$TMP_DIR/src/scripts/start-single-mcp-server.sh" "$server_id" --stop >"$OUTPUT_FILE" 2>&1
  LAST_STATUS=$?
  set -e
}

assert_success() {
  local label="$1"
  if [ "$LAST_STATUS" -ne 0 ]; then
    echo "Expected success for $label"
    cat "$OUTPUT_FILE"
    exit 1
  fi
}

assert_failure_contains() {
  local label="$1"
  local expected="$2"

  if [ "$LAST_STATUS" -eq 0 ]; then
    echo "Expected failure for $label"
    cat "$OUTPUT_FILE"
    exit 1
  fi
  if ! grep -Fq "$expected" "$OUTPUT_FILE"; then
    echo "Expected failure for $label to include: $expected"
    cat "$OUTPUT_FILE"
    exit 1
  fi
  if [ -s "$DOCKER_LOG" ]; then
    echo "Expected $label to fail before docker compose up"
    cat "$DOCKER_LOG"
    exit 1
  fi
}

assert_contains() {
  local file="$1"
  local expected="$2"
  if ! grep -Fq "$expected" "$file"; then
    echo "Expected $file to contain: $expected"
    cat "$file"
    exit 1
  fi
}

assert_not_contains() {
  local file="$1"
  local unexpected="$2"
  if grep -Fq "$unexpected" "$file"; then
    echo "Expected $file not to contain: $unexpected"
    cat "$file"
    exit 1
  fi
}

assert_compose_was_started() {
  local label="$1"
  if ! grep -Fq "compose -p portico-single -f $COMPOSE_FILE up -d" "$DOCKER_LOG"; then
    echo "Expected docker compose up for $label"
    cat "$DOCKER_LOG"
    exit 1
  fi
}

assert_standalone_compose_was_started() {
  local label="$1"
  if ! grep -Fq "standalone -p portico-single -f $COMPOSE_FILE up -d" "$DOCKER_LOG"; then
    echo "Expected standalone docker-compose up for $label"
    cat "$DOCKER_LOG"
    exit 1
  fi
}

cat >"$TMP_DIR/runtime/mcp_config.yaml" <<'YAML'
services: []
YAML
cat >"$TMP_DIR/runtime/connections.toml" <<'TOML'
[default]
account = "test"
TOML
cat >"$TMP_DIR/runtime/other.yaml" <<'YAML'
ok: true
YAML

write_server "no-runtime-files" <<'YAML'
name: no-runtime-files
id: no-runtime-files
deployment_type: docker
YAML
run_server "no-runtime-files"
assert_success "server without runtime_files"
assert_compose_was_started "server without runtime_files"
assert_contains "$COMPOSE_FILE" "$TMP_DIR/mcpo-configs-generated/single-no-runtime-files.json:/app/mcp_config.json:ro"
assert_contains "$COMPOSE_FILE" "./open-webui-data/managed-node-mcp-packages:/app/open-webui-data/managed-node-mcp-packages:ro"
assert_contains "$COMPOSE_FILE" "      - portico_MANAGED_NODE_MCP_PACKAGES_DIR=/app/open-webui-data/managed-node-mcp-packages"
assert_not_contains "$COMPOSE_FILE" "./mcpo-oauth-tokens/no-runtime-files:/root/.mcpo:rw"
assert_not_contains "$COMPOSE_FILE" "/root/.mcpo"
assert_not_contains "$COMPOSE_FILE" "/app/runtime/"

for oauth_server_id in glean google_workspace; do
  write_server "$oauth_server_id" <<YAML
name: $oauth_server_id
id: $oauth_server_id
deployment_type: docker
YAML
  run_server "$oauth_server_id" "$HOME" "rust-full" "$TMP_DIR/bin:$PATH" "missing"
  assert_success "$oauth_server_id standalone Compose fallback"
  assert_standalone_compose_was_started "$oauth_server_id standalone Compose fallback"
done

write_server "directory-config-recovery" <<'YAML'
name: directory-config-recovery
id: directory-config-recovery
deployment_type: docker
YAML
directory_config="$TMP_DIR/mcpo-configs-generated/single-directory-config-recovery.json"
mkdir -p "$directory_config"
touch "$directory_config/docker-created-directory"
run_server "directory-config-recovery"
assert_success "directory at generated config path"
if [ ! -f "$directory_config" ]; then
  echo "Expected startup to replace the generated config directory with a regular file"
  ls -ld "$directory_config" 2>/dev/null || true
  exit 1
fi
if ! jq -e '.mcpServers["directory-config-recovery"]' "$directory_config" >/dev/null; then
  echo "Expected recovered generated config to contain directory-config-recovery"
  cat "$directory_config"
  exit 1
fi

rm -f "$directory_config"
mkdir -p "$directory_config"
touch "$directory_config/docker-created-directory"
stop_server "directory-config-recovery"
assert_success "stop cleanup with directory at generated config path"
if [ -e "$directory_config" ]; then
  echo "Expected stop cleanup to remove the generated config directory"
  ls -ld "$directory_config"
  exit 1
fi

write_server "directory-nginx-recovery" <<'YAML'
name: directory-nginx-recovery
id: directory-nginx-recovery
deployment_type: docker
YAML
nginx_conf="$TMP_DIR/src/mcpo-single-server-nginx.conf"
rm -f "$nginx_conf"
mkdir -p "$nginx_conf"
touch "$nginx_conf/docker-created-directory"
run_server "directory-nginx-recovery"
assert_success "directory at nginx conf path"
assert_contains "$OUTPUT_FILE" "Removing invalid directory at single-server nginx conf path: $nginx_conf"
if [ ! -f "$nginx_conf" ]; then
  echo "Expected startup to replace the nginx conf directory with a regular file"
  ls -ld "$nginx_conf" 2>/dev/null || true
  exit 1
fi
assert_contains "$nginx_conf" "server mcpo-single-directory-nginx-recovery:8000;"

rm -f "$nginx_conf"
mkdir -p "$nginx_conf"
touch "$nginx_conf/docker-created-directory"
stop_server "directory-nginx-recovery"
assert_success "stop cleanup with directory at nginx conf path"
if [ -e "$nginx_conf" ]; then
  echo "Expected stop cleanup to remove the nginx conf directory"
  ls -ld "$nginx_conf"
  exit 1
fi

write_server "runtime-filename-target" <<'YAML'
name: runtime-filename-target
id: runtime-filename-target
deployment_type: docker
runtime_files:
- source: ./runtime/mcp_config.yaml
  filename: mcp_config.yaml
- source: ./runtime/connections.toml
  target: /root/.snowflake/connections.toml
YAML
run_server "runtime-filename-target"
assert_success "filename and target runtime_files"
assert_compose_was_started "filename and target runtime_files"
mcp_config_source="$(realpath_file "$TMP_DIR/runtime/mcp_config.yaml")"
connections_source="$(realpath_file "$TMP_DIR/runtime/connections.toml")"
assert_contains "$COMPOSE_FILE" "\"$mcp_config_source:/app/runtime/mcp_config.yaml:ro\""
assert_contains "$COMPOSE_FILE" "\"$connections_source:/root/.snowflake/connections.toml:ro\""

write_server "runtime-sensitive" <<'YAML'
name: runtime-sensitive
id: runtime-sensitive
deployment_type: docker
runtime_files:
- source: ./runtime/mcp_config.yaml
  filename: mcp_config.yaml
- source: ./runtime/connections.toml
  target: /root/.snowflake/connections.toml
  sensitive: true
YAML
run_server "runtime-sensitive"
assert_success "sensitive runtime_files"
assert_compose_was_started "sensitive runtime_files"
assert_contains "$COMPOSE_FILE" "\"$mcp_config_source:/app/runtime/mcp_config.yaml:ro\""
assert_not_contains "$COMPOSE_FILE" "\"$connections_source:/root/.snowflake/connections.toml:ro\""
sensitive_runtime_secret="$(grep -oE 'portico_runtime_file_runtime_sensitive_connections_toml_[a-f0-9]+' "$COMPOSE_FILE" | head -n 1)"
if [ -z "$sensitive_runtime_secret" ]; then
  echo "Expected sensitive runtime file broker target to be rendered"
  cat "$COMPOSE_FILE"
  exit 1
fi
sensitive_runtime_env="portico_STATIC_SECRET_TOKEN_RUNTIME_SENSITIVE_$(printf '%s' "$sensitive_runtime_secret" | tr '[:lower:]' '[:upper:]')"
assert_contains "$COMPOSE_FILE" "runtime-sensitive|$sensitive_runtime_secret|/dev/shm/portico-runtime-secrets/$sensitive_runtime_secret|$sensitive_runtime_env|/root/.snowflake/connections.toml"
assert_contains "$COMPOSE_FILE" "      - $sensitive_runtime_env=\${$sensitive_runtime_env:-}"
assert_contains "$COMPOSE_FILE" "      - /dev/shm/portico-runtime-secrets:mode=0700"
assert_not_contains "$COMPOSE_FILE" "      - source: $sensitive_runtime_secret"
assert_not_contains "$COMPOSE_FILE" "  $sensitive_runtime_secret:"

snowflake_home="$TMP_DIR/snowflake-home"
mkdir -p "$snowflake_home/.snowflake"
cat >"$snowflake_home/.snowflake/mcp_config.yaml" <<'YAML'
services: []
YAML
cat >"$snowflake_home/.snowflake/connections.toml" <<'TOML'
[default]
account = "test"
TOML
snowflake_mcp_config_source="$(realpath_file "$snowflake_home/.snowflake/mcp_config.yaml")"
snowflake_connections_source="$(realpath_file "$snowflake_home/.snowflake/connections.toml")"

if PATH="$NO_NODE_PATH" "$TMP_DIR/no-node-bin/bash" -c 'command -v node >/dev/null 2>&1'; then
  echo "Expected isolated fallback PATH not to contain node"
  exit 1
fi
write_snowflake_server "snowflake-no-node"
run_server "snowflake-no-node" "$snowflake_home" "rust-full" "$NO_NODE_PATH"
assert_success "Snowflake runtime_files without node"
assert_compose_was_started "Snowflake runtime_files without node"
assert_contains "$COMPOSE_FILE" "\"$snowflake_mcp_config_source:/app/runtime/mcp_config.yaml:ro\""
assert_contains "$COMPOSE_FILE" "\"$snowflake_connections_source:/root/.snowflake/connections.toml:ro\""

write_snowflake_server "snowflake-broken-node"
run_server "snowflake-broken-node" "$snowflake_home" "rust-full" "$BROKEN_NODE_PATH"
assert_success "Snowflake runtime_files with broken node"
assert_compose_was_started "Snowflake runtime_files with broken node"
assert_contains "$COMPOSE_FILE" "\"$snowflake_mcp_config_source:/app/runtime/mcp_config.yaml:ro\""
assert_contains "$COMPOSE_FILE" "\"$snowflake_connections_source:/root/.snowflake/connections.toml:ro\""
assert_not_contains "$OUTPUT_FILE" "BROKEN_NODE_ERROR_SHOULD_BE_BUFFERED"

mkdir -p "$TMP_DIR/mcp-configs/runtime-coexist"
cat >"$TMP_DIR/mcp-configs/runtime-coexist/runtime-coexist.fragment" <<'JSON'
{
  "command": "docker",
  "args": ["run", "--rm", "example.com/runtime-coexist:latest"],
  "env": {
    "EXISTING_ENV": "value"
  }
}
JSON
cat >"$TMP_DIR/mcp-configs/runtime-coexist/runtime-coexist.yaml" <<'YAML'
name: runtime-coexist
id: runtime-coexist
deployment_type: docker
runtime_files:
  - source: ./runtime/mcp_config.yaml
    filename: mcp_config.yaml
  - source: ./runtime/connections.toml
    target: /root/.snowflake/connections.toml
required_env_vars:
  - name: REQUIRED_ONE
    sensitive: false
  - name: SENSITIVE_ONE
    sensitive: true
  - LEGACY_ONE
preset_env_vars:
  - name: PRESET_ONE
    value: preset-value
  - name: PRESET_WITH_SPACE
    value: "preset value"
tool_rename_mapping:
  old_tool: new_tool
YAML
run_server "runtime-coexist" "$HOME" "python"
assert_success "runtime_files with existing single-stack mounts"
assert_compose_was_started "runtime_files with existing single-stack mounts"
assert_contains "$COMPOSE_FILE" "$TMP_DIR/mcpo-configs-generated/single-runtime-coexist.json:/app/mcp_config.json:ro"
assert_contains "$COMPOSE_FILE" "\"$mcp_config_source:/app/runtime/mcp_config.yaml:ro\""
assert_contains "$COMPOSE_FILE" "\"$connections_source:/root/.snowflake/connections.toml:ro\""
assert_contains "$COMPOSE_FILE" "/var/run/docker.sock:/var/run/docker.sock"
assert_not_contains "$COMPOSE_FILE" "./mcpo-oauth-tokens/runtime-coexist:/root/.mcpo:rw"
assert_not_contains "$COMPOSE_FILE" "/root/.mcpo"
assert_contains "$COMPOSE_FILE" "      - EXISTING_ENV=value"
assert_contains "$COMPOSE_FILE" "      - REQUIRED_ONE=\${REQUIRED_ONE}"
assert_contains "$COMPOSE_FILE" "      - SENSITIVE_ONE_FILE=/dev/shm/portico-runtime-secrets/sensitive_one"
assert_contains "$COMPOSE_FILE" "      - LEGACY_ONE=\${LEGACY_ONE}"
assert_contains "$COMPOSE_FILE" "      - PRESET_ONE=preset-value"
assert_contains "$COMPOSE_FILE" "      - PRESET_WITH_SPACE=preset value"
assert_contains "$COMPOSE_FILE" "runtime-coexist|sensitive_one|/dev/shm/portico-runtime-secrets/sensitive_one|portico_STATIC_SECRET_TOKEN_RUNTIME_COEXIST_SENSITIVE_ONE|"
assert_contains "$COMPOSE_FILE" "      - portico_STATIC_SECRET_TOKEN_RUNTIME_COEXIST_SENSITIVE_ONE=\${portico_STATIC_SECRET_TOKEN_RUNTIME_COEXIST_SENSITIVE_ONE:-}"
assert_contains "$COMPOSE_FILE" "      - /dev/shm/portico-runtime-secrets:mode=0700"
assert_not_contains "$COMPOSE_FILE" "      - sensitive_one"
assert_not_contains "$COMPOSE_FILE" "  sensitive_one:"
assert_not_contains "$COMPOSE_FILE" "file: \${SENSITIVE_ONE_FILE:-/dev/null}"
assert_not_contains "$COMPOSE_FILE" "SENSITIVE_ONE=\${SENSITIVE_ONE}"
assert_contains "$TMP_DIR/mcpo-configs-generated/single-runtime-coexist.json" '"old_tool": "new_tool"'
assert_contains "$TMP_DIR/mcpo-configs-generated/single-runtime-coexist.json" '"sensitive_env_vars"'
assert_contains "$TMP_DIR/mcpo-configs-generated/single-runtime-coexist.json" '"SENSITIVE_ONE"'

mkdir -p "$TMP_DIR/home/single-runtime"
cat >"$TMP_DIR/home/single-runtime/home-config.yaml" <<'YAML'
home: true
YAML
write_server "runtime-home" <<'YAML'
name: runtime-home
id: runtime-home
deployment_type: docker
runtime_files:
  - source: ~/single-runtime/home-config.yaml
YAML
run_server "runtime-home" "$TMP_DIR/home"
assert_success "home-expanded runtime_files"
home_source="$(HOME="$TMP_DIR/home" realpath_file "$TMP_DIR/home/single-runtime/home-config.yaml")"
assert_contains "$COMPOSE_FILE" "\"$home_source:/app/runtime/home-config.yaml:ro\""

write_server "runtime-missing" <<'YAML'
name: runtime-missing
id: runtime-missing
deployment_type: docker
runtime_files:
  - source: ./runtime/missing.yaml
YAML
run_server "runtime-missing"
assert_failure_contains "missing runtime_files source" "runtime_files source './runtime/missing.yaml' does not resolve to an existing file"

write_server "runtime-directory" <<'YAML'
name: runtime-directory
id: runtime-directory
deployment_type: docker
runtime_files:
  - source: ./runtime
YAML
run_server "runtime-directory"
assert_failure_contains "directory runtime_files source" "runtime_files source './runtime' must be a regular file"

write_server "runtime-duplicate" <<'YAML'
name: runtime-duplicate
id: runtime-duplicate
deployment_type: docker
runtime_files:
  - source: ./runtime/mcp_config.yaml
    filename: duplicated.yaml
  - source: ./runtime/other.yaml
    filename: duplicated.yaml
YAML
run_server "runtime-duplicate"
assert_failure_contains "duplicate runtime_files targets" "duplicate runtime_files target '/app/runtime/duplicated.yaml'"

write_server "runtime-target-and-filename" <<'YAML'
name: runtime-target-and-filename
id: runtime-target-and-filename
deployment_type: docker
runtime_files:
  - source: ./runtime/mcp_config.yaml
    filename: mcp_config.yaml
    target: /app/runtime/mcp_config.yaml
YAML
run_server "runtime-target-and-filename"
assert_failure_contains "target plus filename" "runtime_files entries cannot specify both target and filename"

write_server "runtime-target-relative" <<'YAML'
name: runtime-target-relative
id: runtime-target-relative
deployment_type: docker
runtime_files:
  - source: ./runtime/mcp_config.yaml
    target: app/runtime/mcp_config.yaml
YAML
run_server "runtime-target-relative"
assert_failure_contains "relative runtime_files target" "runtime_files target 'app/runtime/mcp_config.yaml' must be an absolute container path"

write_server "runtime-target-parent" <<'YAML'
name: runtime-target-parent
id: runtime-target-parent
deployment_type: docker
runtime_files:
  - source: ./runtime/mcp_config.yaml
    target: /app/../runtime/mcp_config.yaml
YAML
run_server "runtime-target-parent"
assert_failure_contains "parent runtime_files target" "invalid runtime_files target '/app/../runtime/mcp_config.yaml'"

write_server "runtime-target-backslash" <<'YAML'
name: runtime-target-backslash
id: runtime-target-backslash
deployment_type: docker
runtime_files:
  - source: ./runtime/mcp_config.yaml
    target: '/app/runtime\mcp_config.yaml'
YAML
run_server "runtime-target-backslash"
assert_failure_contains "backslash runtime_files target" "invalid runtime_files target '/app/runtime\\mcp_config.yaml'"

write_server "runtime-target-colon" <<'YAML'
name: runtime-target-colon
id: runtime-target-colon
deployment_type: docker
runtime_files:
  - source: ./runtime/mcp_config.yaml
    target: /app/runtime/mcp:config.yaml
YAML
run_server "runtime-target-colon"
assert_failure_contains "colon runtime_files target" "invalid runtime_files target '/app/runtime/mcp:config.yaml'"

write_server "runtime-target-empty-basename" <<'YAML'
name: runtime-target-empty-basename
id: runtime-target-empty-basename
deployment_type: docker
runtime_files:
  - source: ./runtime/mcp_config.yaml
    target: /app/runtime/
YAML
run_server "runtime-target-empty-basename"
assert_failure_contains "empty basename runtime_files target" "runtime_files target '/app/runtime/' must include a filename"

write_server "runtime-filename-path" <<'YAML'
name: runtime-filename-path
id: runtime-filename-path
deployment_type: docker
runtime_files:
  - source: ./runtime/mcp_config.yaml
    filename: ../mcp_config.yaml
YAML
run_server "runtime-filename-path"
assert_failure_contains "invalid runtime_files filename" "invalid runtime_files filename '../mcp_config.yaml'"

write_server "runtime-not-list" <<'YAML'
name: runtime-not-list
id: runtime-not-list
deployment_type: docker
runtime_files:
  source: ./runtime/mcp_config.yaml
YAML
run_server "runtime-not-list"
assert_failure_contains "non-list runtime_files" "runtime_files must be a list"

write_server "runtime-entry-scalar" <<'YAML'
name: runtime-entry-scalar
id: runtime-entry-scalar
deployment_type: docker
runtime_files:
  - ./runtime/mcp_config.yaml
YAML
run_server "runtime-entry-scalar"
assert_failure_contains "scalar runtime_files entry" "runtime_files entry 1 must be a mapping"

write_server "runtime-sensitive-non-bool" <<'YAML'
name: runtime-sensitive-non-bool
id: runtime-sensitive-non-bool
deployment_type: docker
runtime_files:
  - source: ./runtime/mcp_config.yaml
    sensitive: yes
YAML
run_server "runtime-sensitive-non-bool"
assert_failure_contains "non-boolean runtime_files sensitive" "runtime_files sensitive must be true or false"

echo "Single-server runtime_files compose generation and validation looks correct."
