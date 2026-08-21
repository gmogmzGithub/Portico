#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
FIXTURE_ROOT="$TMP_DIR/project"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

# shellcheck source=src/scripts/mcp-orc-generator-test-lib.sh
source "$PROJECT_ROOT/src/scripts/mcp-orc-generator-test-lib.sh"

mcp_orc_test_prepare_project_root "$PROJECT_ROOT" "$FIXTURE_ROOT"
mcp_orc_test_copy_server_configs \
  "$PROJECT_ROOT" \
  "$FIXTURE_ROOT" \
  data-plat-mcp \
  google_workspace \
  subagents

cat >"$FIXTURE_ROOT/mcp_toggles.json" <<'JSON'
{
  "data-plat-mcp": true,
  "google_workspace": true
}
JSON

mcp_orc_test_run_generator "$PROJECT_ROOT" "$FIXTURE_ROOT" generate-docker-compose-override >"$TMP_DIR/test-mcpo-nginx-config.log" 2>&1

if grep -q 'proxy_set_header Connection "upgrade";' "$FIXTURE_ROOT/src/mcpo-nginx.conf"; then
  echo "Regular mcpo nginx config still contains unconditional Connection upgrade header"
  exit 1
fi

if grep -q 'proxy_set_header Upgrade \$http_upgrade;' "$FIXTURE_ROOT/src/mcpo-nginx.conf"; then
  echo "Regular mcpo nginx config still contains unconditional Upgrade header"
  exit 1
fi

if grep -q 'proxy_set_header Connection "upgrade";' "$FIXTURE_ROOT/src/mcpo-core-nginx.conf"; then
  echo "Core mcpo nginx config still contains unconditional Connection upgrade header"
  exit 1
fi

if grep -q 'proxy_set_header Upgrade \$http_upgrade;' "$FIXTURE_ROOT/src/mcpo-core-nginx.conf"; then
  echo "Core mcpo nginx config still contains unconditional Upgrade header"
  exit 1
fi

if ! grep -A6 'location /data-plat-mcp/' "$FIXTURE_ROOT/src/mcpo-nginx.conf" | grep -q 'proxy_read_timeout 660s;'; then
  echo "Regular mcpo nginx config should give /data-plat-mcp/ a 660s proxy_read_timeout"
  exit 1
fi

if ! grep -A6 'location /google_workspace/' "$FIXTURE_ROOT/src/mcpo-nginx.conf" | grep -q 'proxy_read_timeout 300s;'; then
  echo "Regular mcpo nginx config should keep ordinary routes at a 300s proxy_read_timeout"
  exit 1
fi

if ! grep -A6 'location /subagents/' "$FIXTURE_ROOT/src/mcpo-core-nginx.conf" | grep -q 'proxy_read_timeout 7800s;'; then
  echo "Core mcpo nginx config should give /subagents/ a 7800s proxy_read_timeout"
  exit 1
fi
