#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/host-mcp-binary-policy.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

PROJECT_ROOT="$TMP_DIR/project"
RUST_ROOT="$PROJECT_ROOT/src/mcp-orc-rust"
SHARED_ROOT="$PROJECT_ROOT/src/core-mcp-rust/crates/core-mcp-shared"
mkdir -p "$RUST_ROOT/crates/mcp-orc/src" "$RUST_ROOT/target/debug" "$SHARED_ROOT/src"

SOURCE_FILE="$RUST_ROOT/crates/mcp-orc/src/main.rs"
MANIFEST_FILE="$RUST_ROOT/Cargo.toml"
LOCK_FILE="$RUST_ROOT/Cargo.lock"
SHARED_SOURCE_FILE="$SHARED_ROOT/src/lib.rs"
SHARED_MANIFEST_FILE="$SHARED_ROOT/Cargo.toml"
BINARY_FILE="$RUST_ROOT/target/debug/mcp-orc"
GENERATED_FILE="$RUST_ROOT/target/x86_64-apple-darwin/release/build/example/out/private.rs"

touch "$SOURCE_FILE" "$MANIFEST_FILE" "$LOCK_FILE" "$SHARED_SOURCE_FILE" "$SHARED_MANIFEST_FILE"
sleep 1
printf '#!/bin/sh\nexit 0\n' > "$BINARY_FILE"
chmod +x "$BINARY_FILE"

host_mcp_binary_is_current "$PROJECT_ROOT" "$BINARY_FILE"

sleep 1
mkdir -p "$(dirname "$GENERATED_FILE")"
touch "$GENERATED_FILE"

if ! host_mcp_binary_is_current "$PROJECT_ROOT" "$BINARY_FILE"; then
  echo "expected generated target files to be ignored for freshness checks"
  exit 1
fi

sleep 1
touch "$SOURCE_FILE"

if host_mcp_binary_is_current "$PROJECT_ROOT" "$BINARY_FILE"; then
  echo "expected stale binary when Rust source is newer"
  exit 1
fi

sleep 1
touch "$BINARY_FILE"

if ! host_mcp_binary_is_current "$PROJECT_ROOT" "$BINARY_FILE"; then
  echo "expected binary refreshed after mcp-orc source to be current"
  exit 1
fi

sleep 1
touch "$SHARED_SOURCE_FILE"

if host_mcp_binary_is_current "$PROJECT_ROOT" "$BINARY_FILE"; then
  echo "expected stale binary when core-mcp-shared source is newer"
  exit 1
fi

sleep 1
touch "$BINARY_FILE"
mv "$SHARED_ROOT" "$TMP_DIR/shared-root-away"

if ! host_mcp_binary_is_current "$PROJECT_ROOT" "$BINARY_FILE"; then
  echo "expected packaged-style source snapshots without core-mcp-shared to remain valid"
  exit 1
fi

mv "$TMP_DIR/shared-root-away" "$SHARED_ROOT"

if host_mcp_binary_is_current "$PROJECT_ROOT" "$RUST_ROOT/target/debug/missing"; then
  echo "expected missing binary to be treated as stale"
  exit 1
fi

HOST_MCP_BIN_ROOT="$TMP_DIR/custom-bin-root"
export HOST_MCP_BIN_ROOT
EXPECTED_CACHED_BINARY="$HOST_MCP_BIN_ROOT/mcp-orc-$(host_mcp_platform_tag)"
EXPECTED_ARTIFACT_BINARY="$HOST_MCP_BIN_ROOT/$(host_mcp_current_target_triple)/mcp-orc"

if [ "$(host_mcp_cached_binary_path)" != "$EXPECTED_CACHED_BINARY" ]; then
  echo "expected cached binary path to honor HOST_MCP_BIN_ROOT"
  exit 1
fi

if [ "$(host_mcp_artifact_binary_path "$HOST_MCP_BIN_ROOT")" != "$EXPECTED_ARTIFACT_BINARY" ]; then
  echo "expected artifact binary path to honor HOST_MCP_BIN_ROOT and platform tag"
  exit 1
fi

CURRENT_OS="$(uname -s 2>/dev/null || echo unknown)"
CURRENT_OS="$(printf '%s' "$CURRENT_OS" | tr '[:upper:]' '[:lower:]')"

if [ "$CURRENT_OS" = "darwin" ]; then
  if ! host_mcp_is_packaged_mac_resources_root "/Applications/Portico.app/Contents/Resources"; then
    echo "expected packaged app resources root to be detected on Darwin"
    exit 1
  fi
  if host_mcp_is_packaged_mac_resources_root "$TMP_DIR/node_modules/electron/dist/Electron.app/Contents/Resources"; then
    echo "expected Electron distribution resources root to be rejected in dev mode"
    exit 1
  fi
  HOST_MCP_IS_PACKAGED=1
  export HOST_MCP_IS_PACKAGED
  if ! host_mcp_is_packaged_mac_resources_root "$TMP_DIR/node_modules/electron/dist/Electron.app/Contents/Resources"; then
    echo "expected packaged env override to force packaged detection"
    exit 1
  fi
  HOST_MCP_IS_PACKAGED=0
  export HOST_MCP_IS_PACKAGED
  if host_mcp_is_packaged_mac_resources_root "/Applications/Portico.app/Contents/Resources"; then
    echo "expected explicit dev env override to bypass packaged detection"
    exit 1
  fi
  unset HOST_MCP_IS_PACKAGED
  if host_mcp_is_packaged_mac_resources_root "$TMP_DIR/not-an-app"; then
    echo "expected non-app path to be rejected as packaged resources root"
    exit 1
  fi
fi

if [ "$CURRENT_OS" = "darwin" ]; then
  if host_mcp_can_extract_image_binary; then
    echo "expected image binary extraction to be disabled on Darwin"
    exit 1
  fi
else
  if ! host_mcp_can_extract_image_binary; then
    echo "expected image binary extraction to be enabled off Darwin"
    exit 1
  fi
fi

if grep -q 'cargo run' "$SCRIPT_DIR/run-host-mcp.sh"; then
  echo "host runtime should not fall back to cargo run"
  exit 1
fi
