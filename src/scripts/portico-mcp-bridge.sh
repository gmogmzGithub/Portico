#!/bin/bash
# Stdio compatibility wrapper for MCP clients that cannot connect to streamable HTTP.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export HOST_MCP_BRIDGE_REMOTE_URL="${portico_MCP_BRIDGE_REMOTE_URL:-${HOST_MCP_BRIDGE_REMOTE_URL:-http://127.0.0.1:8891/mcp}}"
exec bash "$SCRIPT_DIR/run-host-mcp-bridge.sh" --stdio-proxy
