#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

SERVER_ID="mcp-atlassian"
CALLBACK_HOST_PORT=3836
HOST_PORT=8996
SLACK_TEST_SECRET_DIR=""

cleanup_server() {
  local target_server_id="$1"
  MCP_ORC_MODE=rust-full \
    bash "$SCRIPT_DIR/start-single-mcp-server.sh" \
    "$target_server_id" \
    --stop >/dev/null 2>&1 || true
}

cleanup() {
  cleanup_server "$SERVER_ID"
  cleanup_server "slack"
  if [ -n "$SLACK_TEST_SECRET_DIR" ]; then
    rm -rf "$SLACK_TEST_SECRET_DIR"
  fi
}

trap cleanup EXIT

pushd "$PROJECT_ROOT" >/dev/null

single_server_script="$(cat "$SCRIPT_DIR/start-single-mcp-server.sh")"
slack_fragment="$(cat "$PROJECT_ROOT/mcp-configs/slack/slack.fragment")"

if grep -Fq "security add-trusted-cert" <<<"$single_server_script"; then
  echo "single-server OAuth setup must not modify macOS certificate trust settings"
  exit 1
fi

if grep -Eq 'oauth\.crt|oauth\.key|listen 3838|127\.0\.0\.1:3838:3838|https://localhost:3838/callback' <<<"$single_server_script"; then
  echo "single-server OAuth setup must not generate or expose the legacy HTTPS callback sidecar"
  exit 1
fi

if grep -Fq "https://localhost:3838/callback" <<<"$slack_fragment"; then
  echo "Slack OAuth must use HTTP loopback callbacks, not the legacy HTTPS localhost redirect"
  exit 1
fi

cleanup_server "$SERVER_ID"

MCP_ORC_MODE=rust-full \
  bash "$SCRIPT_DIR/start-single-mcp-server.sh" \
  "$SERVER_ID" \
  --host-port "$HOST_PORT" \
  --callback-port "$CALLBACK_HOST_PORT" >/dev/null

generated_nginx="$(cat "$PROJECT_ROOT/src/mcpo-single-server-nginx.conf")"
generated_compose="$(cat "$PROJECT_ROOT/docker-compose.single-server.yml")"

if ! grep -Fq "location /callback {" <<<"$generated_nginx"; then
  echo "Expected nginx callback listener on /callback"
  exit 1
fi

if ! grep -Fq "proxy_pass http://single_server/oauth/callback;" <<<"$generated_nginx"; then
  echo "Expected nginx callback listener to proxy into /oauth/callback on port 8000"
  exit 1
fi

if grep -Fq "server mcpo-single-${SERVER_ID}:${CALLBACK_HOST_PORT};" <<<"$generated_nginx"; then
  echo "Nginx callback routing incorrectly targets host callback port"
  exit 1
fi

if grep -Fq "server mcpo-single-${SERVER_ID}:3834;" <<<"$generated_nginx"; then
  echo "Nginx callback routing should not target a separate internal callback port"
  exit 1
fi

if ! grep -Fq "\"127.0.0.1:${CALLBACK_HOST_PORT}:3834\"" <<<"$generated_compose"; then
  echo "Expected compose file to publish host callback port to internal 3834 on loopback"
  exit 1
fi

if ! grep -Fq "MCPO_OAUTH_CALLBACK_PORT=${CALLBACK_HOST_PORT}" <<<"$generated_compose"; then
  echo "Expected compose file to pass host callback port to MCPO runtime"
  exit 1
fi

if ! grep -Fq "portico_OAUTH_ACCESS_TOKEN_BROKER_URL=\${portico_OAUTH_ACCESS_TOKEN_BROKER_URL:-http://host.docker.internal:8891/secrets/oauth/access-token}" <<<"$generated_compose"; then
  echo "Atlassian single-server compose must route OAuth access-token ingress through the host broker"
  exit 1
fi

if ! grep -Fq "portico_OAUTH_ACCESS_TOKEN_SERVER_ID=${SERVER_ID}" <<<"$generated_compose"; then
  echo "Atlassian single-server compose must use canonical server_id for OAuth broker scope"
  exit 1
fi

if ! grep -Fq "portico_OAUTH_ACCESS_TOKEN_BROKER_TOKEN=\${portico_OAUTH_ACCESS_TOKEN_TOKEN_MCP_ATLASSIAN:-}" <<<"$generated_compose"; then
  echo "Atlassian single-server compose must use a per-server OAuth broker token placeholder"
  exit 1
fi

if grep -Eq 'listen 3838|oauth\.crt|oauth\.key|127\.0\.0\.1:3838:3838' <<<"$generated_nginx$generated_compose"; then
  echo "Generated single-server config must not include the legacy HTTPS callback sidecar"
  exit 1
fi

slack_redirects="$(jq -r '.oauth.client_metadata.redirect_uris // [] | .[]?' "$PROJECT_ROOT/mcp-configs/slack/slack.fragment")"
if [ -n "$slack_redirects" ]; then
  echo "Slack fragment should not pin redirect_uris; OAuthConfig should derive HTTP loopback redirects"
  exit 1
fi

cleanup_server "$SERVER_ID"

SLACK_TEST_SECRET_DIR="$(mktemp -d)"
SLACK_HOST_PORT=8997
SLACK_CALLBACK_HOST_PORT=3836

PORTICO_RUNTIME_DISABLE_KEYCHAIN=1 \
PORTICO_RUNTIME_SECRET_CACHE_DIR="$SLACK_TEST_SECRET_DIR" \
MCP_ORC_MODE=rust-full \
  bash "$SCRIPT_DIR/start-single-mcp-server.sh" \
  "slack" \
  --host-port "$SLACK_HOST_PORT" \
  --callback-port "$SLACK_CALLBACK_HOST_PORT" >/dev/null

generated_slack_nginx="$(cat "$PROJECT_ROOT/src/mcpo-single-server-nginx.conf")"
generated_slack_compose="$(cat "$PROJECT_ROOT/docker-compose.single-server.yml")"
generated_slack_config="$(cat "$PROJECT_ROOT/mcpo-configs-generated/single-slack.json")"

if ! docker compose -f "$PROJECT_ROOT/docker-compose.single-server.yml" config >/dev/null; then
  echo "Generated Slack single-server compose file is not valid YAML"
  exit 1
fi

if grep -Eq 'listen 3838|oauth\.crt|oauth\.key|127\.0\.0\.1:3838:3838|https://localhost:3838/callback' <<<"$generated_slack_nginx$generated_slack_compose$generated_slack_config"; then
  echo "Generated Slack single-server config must not include the legacy HTTPS callback sidecar"
  exit 1
fi

if ! jq -e --arg uri "http://localhost:${SLACK_CALLBACK_HOST_PORT}/callback" \
  '.mcpServers.slack.oauth.client_metadata.redirect_uris | index($uri) != null' \
  <<<"$generated_slack_config" >/dev/null; then
  echo "Expected Slack single-server config to use HTTP loopback callback on ${SLACK_CALLBACK_HOST_PORT}"
  exit 1
fi

if ! jq -e --arg uri "http://localhost:3834/callback" \
  '.mcpServers.slack.oauth.client_metadata.redirect_uris | index($uri) != null' \
  <<<"$generated_slack_config" >/dev/null; then
  echo "Expected Slack single-server config to retain the main-stack HTTP loopback callback"
  exit 1
fi

if grep -Eq 'SLACK_OAUTH_CLIENT_(ID|SECRET)(_FILE)?|slack_oauth_client_(id|secret)' <<<"$generated_slack_compose$generated_slack_config"; then
  echo "Slack PKCE config must not deliver legacy OAuth client credentials"
  exit 1
fi

if ! grep -Fq "portico_OAUTH_ACCESS_TOKEN_BROKER_URL=\${portico_OAUTH_ACCESS_TOKEN_BROKER_URL:-http://host.docker.internal:8891/secrets/oauth/access-token}" <<<"$generated_slack_compose"; then
  echo "Slack single-server compose must route OAuth access-token ingress through the host broker"
  exit 1
fi

if ! grep -Fq "portico_OAUTH_ACCESS_TOKEN_SERVER_ID=slack" <<<"$generated_slack_compose"; then
  echo "Slack single-server compose must use canonical server_id for OAuth broker scope"
  exit 1
fi

if ! grep -Fq "portico_OAUTH_ACCESS_TOKEN_BROKER_TOKEN=\${portico_OAUTH_ACCESS_TOKEN_TOKEN_SLACK:-}" <<<"$generated_slack_compose"; then
  echo "Slack single-server compose must use a per-server OAuth broker token placeholder"
  exit 1
fi

if ! jq -e '.mcpServers.slack.oauth.credentials_source.type == "inline"' \
  <<<"$generated_slack_config" >/dev/null; then
  echo "Expected Slack single-server config to use inline public client credentials"
  exit 1
fi

if ! jq -e '.mcpServers.slack.oauth.credentials_source.client_id == "2317524819.11152506261415"' \
  <<<"$generated_slack_config" >/dev/null; then
  echo "Expected Slack single-server config to use the public PKCE client id"
  exit 1
fi

cleanup_server "slack"

popd >/dev/null

echo "Single-server callback routing generation looks correct."
