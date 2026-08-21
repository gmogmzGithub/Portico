#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p \
  "$TMP_DIR/src/scripts" \
  "$TMP_DIR/electron-app" \
  "$TMP_DIR/mcp-configs/test-server" \
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
  echo "Unexpected mcp-orc generator call: $*" >&2
  return 99
}
EOF

cat >"$TMP_DIR/electron-app/build-info.json" <<'JSON'
{"buildNumber":"04032026-261faa30"}
JSON

cat >"$TMP_DIR/mcp-configs/test-server/test-server.fragment" <<'JSON'
{"command":"python","args":["server.py"]}
JSON

cat >"$TMP_DIR/mcp-configs/test-server/test-server.yaml" <<'YAML'
name: test-server
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
esac

echo "Unexpected docker command: $*" >&2
exit 99
EOF
chmod +x "$TMP_DIR/bin/docker"

set +e
output="$(
  PATH="$TMP_DIR/bin:$PATH" \
    bash "$TMP_DIR/src/scripts/start-single-mcp-server.sh" test-server 2>&1
)"
status=$?
set -e

if [ "$status" -eq 0 ]; then
  echo "Expected packaged managed runtime startup to fail when the Harbor image is missing"
  exit 1
fi

if ! grep -Fq "Required Harbor single-server image is missing" <<<"$output"; then
  echo "Expected explicit packaged-build Harbor image failure"
  echo "$output"
  exit 1
fi

if grep -Fq "Single-server image not found; building once..." <<<"$output"; then
  echo "Packaged managed runtime should not attempt a local single-server build"
  echo "$output"
  exit 1
fi

echo "Single-server packaged build policy fails closed when the Harbor image is missing."
