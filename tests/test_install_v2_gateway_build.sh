#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

TMP_DIR="$(mktemp -d)"
TEST_ROOT="$TMP_DIR/project"
CAPTURE_FILE="$TMP_DIR/capture.log"
GET_BUILD_NUMBER_FLAG_FILE="$TMP_DIR/get-build-number.failed"
HOME="$TMP_DIR/home"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$TEST_ROOT/src/scripts" "$HOME"

cp "$PROJECT_ROOT/install_v2.sh" "$TEST_ROOT/install_v2.sh"
cp "$PROJECT_ROOT/src/scripts/mcp-orc-backend.sh" "$TEST_ROOT/src/scripts/mcp-orc-backend.sh"
cp "$PROJECT_ROOT/src/scripts/runtime-secrets.sh" "$TEST_ROOT/src/scripts/runtime-secrets.sh"

cat > "$TEST_ROOT/src/scripts/mcp-orc-cli.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$TEST_ROOT/src/scripts/mcp-orc-cli.sh"

cat > "$TEST_ROOT/docker-compose.yml" <<'EOF'
services: {}
EOF
cat > "$TEST_ROOT/docker-compose.advanced.yml" <<'EOF'
services: {}
EOF

(
  export HOME
  export CAPTURE_FILE
  export GET_BUILD_NUMBER_FLAG_FILE
  source "$TEST_ROOT/install_v2.sh"

  LLM_GATEWAY_MODE="bifrost"
  LLM_GATEWAY_MODE_SELECTED="bifrost"
  MCP_ORC_MODE="rust-full"
  MCP_ORC_MODE_SELECTED="rust-full"
  ADVANCED_MODE=true
  USE_NODE=false
  FORCE_LOCAL_BUILD=false
  DEV_MODE=false
  USE_CACHE=true

  log() { :; }
  success() { :; }
  error() { :; }
  get_build_number() {
    if [ ! -f "$GET_BUILD_NUMBER_FLAG_FILE" ]; then
      : > "$GET_BUILD_NUMBER_FLAG_FILE"
      return 1
    fi
    printf ''
    return 0
  }
  check_docker_build_disk_space() { return 0; }
  check_harbor_images_exist() { return 1; }
  prepare_llm_debug_monitor_frontend() { return 0; }
  image_matches_host_arch() { return 0; }
  agent_vm_image_has_expected_label() { return 0; }
  run_docker_compose_build_with_retry() {
    printf 'compose=%s\n' "$1" >> "$CAPTURE_FILE"
    printf 'bridge=%s\n' "$BIFROST_BRIDGE_IMAGE" >> "$CAPTURE_FILE"
    return 0
  }
  docker() {
    if [ "${1:-}" = "image" ] && [ "${2:-}" = "inspect" ]; then
      if [ "${3:-}" = "agent-vm:latest" ]; then
        return 0
      fi
      return 1
    fi
    return 0
  }

  build_docker_images
)

! grep -q -- '-f .*bifrost' "$CAPTURE_FILE" \
  || fail "install_v2.sh should not include a removed gateway overlay"
! grep -q 'install_uv_and_playwright\|PLAYWRIGHT_SUCCESS' "$TEST_ROOT/install_v2.sh" \
  || fail "install_v2.sh should not retain the removed browser automation dependency setup"
grep -q '^compose=-f docker-compose.yml -f docker-compose.advanced.yml$' "$CAPTURE_FILE" \
  || fail "install_v2.sh should build the base Rust/Bifrost compose stack"
grep -q '^bridge=portico-bifrost-bridge:latest$' "$CAPTURE_FILE" \
  || fail "install_v2.sh should build the bifrost llm-gateway image name"

echo "PASS: install_v2 bifrost gateway build path"
