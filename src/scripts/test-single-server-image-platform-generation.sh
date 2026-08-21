#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p \
  "$TMP_DIR/src/scripts" \
  "$TMP_DIR/electron-app" \
  "$TMP_DIR/mcp-configs/test-docker" \
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

cat >"$TMP_DIR/mcp-configs/test-docker/test-docker.fragment" <<'JSON'
{
  "command": "docker",
  "args": [
    "run",
    "-i",
    "--rm",
    "example.com/test-docker:latest"
  ]
}
JSON

cat >"$TMP_DIR/mcp-configs/test-docker/test-docker.yaml" <<'YAML'
name: "Test Docker Server"
id: "test-docker"
deployment_type: "docker"
image_platform: "linux/amd64"
YAML

cat >"$TMP_DIR/bin/docker" <<'EOF'
#!/bin/bash
set -euo pipefail

case "${1:-}" in
  ps)
    exit 0
    ;;
  network)
    exit 0
    ;;
  image)
    if [ "${2:-}" = "inspect" ]; then
      exit 1
    fi
    ;;
  compose)
    if [ "${2:-}" = "version" ]; then
      echo "Docker Compose version v2.39.1"
    fi
    exit 0
    ;;
esac

echo "Unexpected docker command: $*" >&2
exit 99
EOF
chmod +x "$TMP_DIR/bin/docker"

PATH="$TMP_DIR/bin:$PATH" \
  bash "$TMP_DIR/src/scripts/start-single-mcp-server.sh" test-docker >/dev/null

generated_config="$TMP_DIR/mcpo-configs-generated/single-test-docker.json"

if ! jq -e '.mcpServers["test-docker"].args == ["run", "--platform", "linux/amd64", "-i", "--rm", "example.com/test-docker:latest"]' "$generated_config" >/dev/null; then
  echo "Expected single-server config generation to inject --platform from image_platform"
  cat "$generated_config"
  exit 1
fi

echo "Single-server config generation injects image_platform into Docker subprocess args."
