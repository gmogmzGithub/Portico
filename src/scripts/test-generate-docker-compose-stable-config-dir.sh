#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
FIXTURE_ROOT="$TMP_DIR/project"
CONFIG_DIR="$FIXTURE_ROOT/mcpo-configs-generated"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

# shellcheck source=src/scripts/mcp-orc-generator-test-lib.sh
source "$ROOT_DIR/src/scripts/mcp-orc-generator-test-lib.sh"

portable_inode() {
  local target="$1"
  stat -c %i "$target" 2>/dev/null || stat -f %i "$target" 2>/dev/null
}

mcp_orc_test_prepare_project_root "$ROOT_DIR" "$FIXTURE_ROOT"
mcp_orc_test_copy_server_configs "$ROOT_DIR" "$FIXTURE_ROOT" glean
printf '{"glean":true}\n' >"$FIXTURE_ROOT/mcp_toggles.json"

before_inode="$(portable_inode "$CONFIG_DIR")"

mcp_orc_test_run_generator "$ROOT_DIR" "$FIXTURE_ROOT" generate-docker-compose-override >/dev/null

after_inode="$(portable_inode "$CONFIG_DIR")"

if [[ "$before_inode" != "$after_inode" ]]; then
  echo "mcpo-configs-generated inode changed across regeneration" >&2
  echo "before=$before_inode after=$after_inode" >&2
  exit 1
fi

if [[ ! -f "$CONFIG_DIR/server-routing.json" ]]; then
  echo "Expected $CONFIG_DIR/server-routing.json to exist after regeneration" >&2
  exit 1
fi

echo "Stable config directory test passed"
