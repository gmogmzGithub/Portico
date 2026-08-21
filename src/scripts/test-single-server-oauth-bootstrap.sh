#!/bin/bash
# Regression coverage for the OAuth bootstrap mode of
# src/scripts/start-single-mcp-server.sh.
#
# Background: first-time/interactive OAuth must run the single-server wizard
# stack WITHOUT the OAuth access-token broker, otherwise the container can never
# generate a container-local authorization URL (the broker only vends/refreshes
# already-authorized records). These tests pin the generated docker-compose env:
#
#   * default mode  -> inject the broker trio (URL / SERVER_ID / BROKER_TOKEN)
#   * --oauth-bootstrap -> omit the broker trio, inject the one-time export token
#   * --oauth-bootstrap without an export token -> fail before docker compose up
#   * native remote transports without oauth metadata -> same mode-specific env

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
  "$TMP_DIR/bin"

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
    node - "$4" "$1/electron-app/node_modules/js-yaml" <<'NODE'
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
      echo "Docker Compose version v2.39.1"
      exit 0
    fi
    echo "\$*" >> "$DOCKER_LOG"
    exit 0
    ;;
esac

echo "Unexpected docker command: \$*" >&2
exit 99
EOF
chmod +x "$TMP_DIR/bin/docker"

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

write_oauth_server() {
  local server_id="$1"
  mkdir -p "$TMP_DIR/mcp-configs/$server_id"
  cat >"$TMP_DIR/mcp-configs/$server_id/$server_id.fragment" <<'JSON'
{"command":"python","args":["server.py"],"oauth":{"type":"non-dcr"}}
JSON
  cat >"$TMP_DIR/mcp-configs/$server_id/$server_id.yaml" <<YAML
name: $server_id
id: $server_id
deployment_type: docker
YAML
}

write_fragment_server() {
  local server_id="$1"
  local fragment_json="$2"
  mkdir -p "$TMP_DIR/mcp-configs/$server_id"
  printf '%s\n' "$fragment_json" >"$TMP_DIR/mcp-configs/$server_id/$server_id.fragment"
  cat >"$TMP_DIR/mcp-configs/$server_id/$server_id.yaml" <<YAML
name: $server_id
id: $server_id
deployment_type: docker
YAML
}

run_server() {
  local server_id="$1"
  shift

  : >"$DOCKER_LOG"
  rm -f "$COMPOSE_FILE" "$OUTPUT_FILE"

  set +e
  PATH="$TMP_DIR/bin:$PATH" \
    HOME="$TMP_DIR/home" \
    MCP_ORC_MODE="rust-full" \
    bash "$TMP_DIR/src/scripts/start-single-mcp-server.sh" "$server_id" "$@" >"$OUTPUT_FILE" 2>&1
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

assert_contains() {
  local file="$1"
  local expected="$2"
  if ! grep -Fq -- "$expected" "$file"; then
    echo "Expected $file to contain: $expected"
    cat "$file"
    exit 1
  fi
}

assert_not_contains() {
  local file="$1"
  local unexpected="$2"
  if grep -Fq -- "$unexpected" "$file"; then
    echo "Expected $file not to contain: $unexpected"
    cat "$file"
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
  if ! grep -Fq -- "$expected" "$OUTPUT_FILE"; then
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

mkdir -p "$TMP_DIR/home"

# --- Default mode injects the broker trio (broker-mode runtime). -------------
write_oauth_server "oauthsrv"
run_server "oauthsrv"
assert_success "default OAuth server"
assert_contains "$COMPOSE_FILE" "portico_OAUTH_ACCESS_TOKEN_BROKER_URL="
assert_contains "$COMPOSE_FILE" "portico_OAUTH_ACCESS_TOKEN_SERVER_ID=oauthsrv"
assert_contains "$COMPOSE_FILE" "portico_OAUTH_ACCESS_TOKEN_BROKER_TOKEN="
assert_not_contains "$COMPOSE_FILE" "portico_OAUTH_BOOTSTRAP_EXPORT_TOKEN"
assert_contains "$TMP_DIR/src/mcpo-single-server-nginx.conf" "location /servers/"

# --- Bootstrap mode omits the broker trio, injects the export token. ---------
portico_OAUTH_BOOTSTRAP_EXPORT_TOKEN="export-bearer-123" \
  run_server "oauthsrv" --oauth-bootstrap
assert_success "bootstrap OAuth server"
assert_contains "$COMPOSE_FILE" 'portico_OAUTH_BOOTSTRAP_EXPORT_TOKEN=${portico_OAUTH_BOOTSTRAP_EXPORT_TOKEN}'
assert_not_contains "$COMPOSE_FILE" "export-bearer-123"
assert_not_contains "$COMPOSE_FILE" "portico_OAUTH_ACCESS_TOKEN_BROKER_URL"
assert_not_contains "$COMPOSE_FILE" "portico_OAUTH_ACCESS_TOKEN_SERVER_ID"
assert_not_contains "$COMPOSE_FILE" "portico_OAUTH_ACCESS_TOKEN_BROKER_TOKEN"

# --- Bootstrap mode without an export token fails before docker compose up. --
run_server "oauthsrv" --oauth-bootstrap
assert_failure_contains "bootstrap without export token" \
  "--oauth-bootstrap requires portico_OAUTH_BOOTSTRAP_EXPORT_TOKEN"

# --- PORTICO-294: initialize-challenge OAuth without explicit metadata. -----------
write_fragment_server "nativeoauth" \
  '{"type":"streamable-http","url":"https://example.invalid/mcp"}'
portico_OAUTH_BOOTSTRAP_EXPORT_TOKEN="native-bootstrap-secret" \
  run_server "nativeoauth" --oauth-bootstrap
assert_success "native OAuth bootstrap server"
assert_contains "$COMPOSE_FILE" 'portico_OAUTH_BOOTSTRAP_EXPORT_TOKEN=${portico_OAUTH_BOOTSTRAP_EXPORT_TOKEN}'
assert_not_contains "$COMPOSE_FILE" "native-bootstrap-secret"
assert_not_contains "$COMPOSE_FILE" "portico_OAUTH_ACCESS_TOKEN_BROKER_URL"
assert_not_contains "$COMPOSE_FILE" "portico_OAUTH_ACCESS_TOKEN_SERVER_ID"
assert_not_contains "$COMPOSE_FILE" "portico_OAUTH_ACCESS_TOKEN_BROKER_TOKEN"

portico_OAUTH_ACCESS_TOKEN_TOKEN_NATIVEOAUTH="native-broker-secret" \
  run_server "nativeoauth"
assert_success "native OAuth existing-record server"
assert_contains "$COMPOSE_FILE" "portico_OAUTH_ACCESS_TOKEN_BROKER_URL="
assert_contains "$COMPOSE_FILE" "portico_OAUTH_ACCESS_TOKEN_SERVER_ID=nativeoauth"
assert_contains "$COMPOSE_FILE" 'portico_OAUTH_ACCESS_TOKEN_BROKER_TOKEN=${portico_OAUTH_ACCESS_TOKEN_TOKEN_NATIVEOAUTH:-}'
assert_not_contains "$COMPOSE_FILE" "native-broker-secret"
assert_not_contains "$COMPOSE_FILE" "portico_OAUTH_BOOTSTRAP_EXPORT_TOKEN"

run_server "nativeoauth" --oauth-bootstrap
assert_failure_contains "native OAuth bootstrap without export token" \
  "--oauth-bootstrap requires portico_OAUTH_BOOTSTRAP_EXPORT_TOKEN"

assert_native_oauth_fragment() {
  local server_id="$1"
  local fragment_json="$2"
  write_fragment_server "$server_id" "$fragment_json"
  run_server "$server_id"
  assert_success "native OAuth form $server_id"
  assert_contains "$COMPOSE_FILE" "portico_OAUTH_ACCESS_TOKEN_BROKER_URL="
  assert_contains "$COMPOSE_FILE" "portico_OAUTH_ACCESS_TOKEN_SERVER_ID=$server_id"
}

assert_non_oauth_fragment() {
  local server_id="$1"
  local fragment_json="$2"
  write_fragment_server "$server_id" "$fragment_json"
  run_server "$server_id"
  assert_success "non-OAuth form $server_id"
  assert_not_contains "$COMPOSE_FILE" "portico_OAUTH_ACCESS_TOKEN_BROKER_URL"
  assert_not_contains "$COMPOSE_FILE" "portico_OAUTH_ACCESS_TOKEN_SERVER_ID"
  assert_not_contains "$COMPOSE_FILE" "portico_OAUTH_ACCESS_TOKEN_BROKER_TOKEN"
  assert_not_contains "$COMPOSE_FILE" "portico_OAUTH_BOOTSTRAP_EXPORT_TOKEN"
}

# Mirror every accepted Rust native-OAuth form, including trimming.
assert_native_oauth_fragment "nativeunderscore" \
  '{"type":"streamable_http","url":"https://example.invalid/mcp"}'
assert_native_oauth_fragment "nativenohyphen" \
  '{"type":"streamablehttp","url":"https://example.invalid/mcp"}'
assert_native_oauth_fragment "nativetrimmed" \
  '{"type":"  streamable-http  ","url":"https://example.invalid/mcp"}'
assert_native_oauth_fragment "nativesse" \
  '{"type":"sse","url":"https://example.invalid/sse"}'
assert_native_oauth_fragment "nativehttpsubprocess" \
  '{"http_subprocess":{"url":"https://example.invalid/mcp"}}'

# Preserve Rust's case-sensitive and non-null predicate boundaries.
assert_non_oauth_fragment "plainmissing" \
  '{"command":"python","args":["server.py"]}'
assert_non_oauth_fragment "plainnull" \
  '{"type":null,"http_subprocess":null}'
assert_non_oauth_fragment "plainnumber" \
  '{"type":42}'
assert_non_oauth_fragment "plaincase" \
  '{"type":"Streamable-HTTP","url":"https://example.invalid/mcp"}'
assert_non_oauth_fragment "plainunrelated" \
  '{"type":"stdio","command":"python","args":["server.py"]}'

# Bootstrap mode stays inert for a plain stdio server.
run_server "plainunrelated" --oauth-bootstrap
assert_success "plain stdio bootstrap mode"
assert_not_contains "$COMPOSE_FILE" "portico_OAUTH_BOOTSTRAP_EXPORT_TOKEN"
assert_not_contains "$COMPOSE_FILE" "portico_OAUTH_ACCESS_TOKEN_BROKER_URL"

# --- Server with sensitive env var + OAuth: bootstrap skips static secrets. ---
write_oauth_sensitive_env_server() {
  local server_id="$1"
  mkdir -p "$TMP_DIR/mcp-configs/$server_id"
  cat >"$TMP_DIR/mcp-configs/$server_id/$server_id.fragment" <<'JSON'
{"command":"python","args":["server.py"],"env":{"waldoapikey":"${waldoapikey}"},"oauth":{"type":"non-dcr"},"headers":{"waldoapikey":"${waldoapikey}"}}
JSON
  cat >"$TMP_DIR/mcp-configs/$server_id/$server_id.yaml" <<YAML
name: $server_id
id: $server_id
deployment_type: docker
oauth:
  requires_user_authorization: true
required_env_vars:
- description: Figma personal access token
  name: waldoapikey
  sensitive: true
YAML
}

write_oauth_sensitive_env_server "oauth-sensitive-srv"

# Bootstrap mode: sensitive env var static secret targets must be absent.
portico_OAUTH_BOOTSTRAP_EXPORT_TOKEN="export-bearer-456" \
  run_server "oauth-sensitive-srv" --oauth-bootstrap
assert_success "bootstrap OAuth+sensitive server"
assert_not_contains "$COMPOSE_FILE" "portico_STATIC_SECRET_TARGETS"
assert_not_contains "$COMPOSE_FILE" "portico_STATIC_SECRET_BROKER_URL"
assert_not_contains "$COMPOSE_FILE" "waldoapikey_FILE="
assert_not_contains "$COMPOSE_FILE" "waldoapikey="
assert_contains "$COMPOSE_FILE" "portico_OAUTH_BOOTSTRAP_EXPORT_TOKEN="

# Default (existing-record) mode: sensitive env var static secret targets present.
run_server "oauth-sensitive-srv"
assert_success "default OAuth+sensitive server"
assert_contains "$COMPOSE_FILE" "portico_STATIC_SECRET_TARGETS"
assert_contains "$COMPOSE_FILE" "portico_STATIC_SECRET_BROKER_URL"
assert_contains "$COMPOSE_FILE" "waldoapikey_FILE="
assert_not_contains "$COMPOSE_FILE" 'waldoapikey=${waldoapikey}'
assert_contains "$COMPOSE_FILE" "portico_OAUTH_ACCESS_TOKEN_BROKER_URL="
if ! jq -e '.mcpServers["oauth-sensitive-srv"].sensitive_env_vars == ["waldoapikey"]' \
  "$TMP_DIR/mcpo-configs-generated/single-oauth-sensitive-srv.json" >/dev/null; then
  echo "Expected serializer-shaped sensitive env metadata in single-server runtime config" >&2
  exit 1
fi

echo "PASS: single-server OAuth bootstrap env regression tests"
