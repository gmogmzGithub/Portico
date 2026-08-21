#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUN_HOST_SCRIPT="$SCRIPT_DIR/run-host-mcp.sh"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

load_runtime_resolution_functions() {
  local source
  source="$(awk '/^# Ensure uv\/uvx is in PATH/{exit} {print}' "$RUN_HOST_SCRIPT")"
  eval "$source"
}

make_fake_node_runtime() {
  local bin_dir="$1"
  local version="$2"
  mkdir -p "$bin_dir"
  cat > "$bin_dir/node" <<SH
#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then
  printf '%s\n' "$version"
  exit 0
fi
exit 0
SH
  cat > "$bin_dir/npm" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = "--version" ]; then
  printf '10.9.0\n'
  exit 0
fi
exit 0
SH
  chmod +x "$bin_dir/node" "$bin_dir/npm"
}

test_discovers_aux_node_under_home_local_with_minimal_path() {
  local tmp_dir expected resolved
  tmp_dir="$(mktemp -d)"
  expected="$tmp_dir/home/.local/lib/nodejs/node-v999.0.0-darwin-arm64/bin"
  make_fake_node_runtime "$expected" "v999.0.0"

  resolved="$(
    HOME="$tmp_dir/home" \
    HOST_NODE_BIN_DIR="" \
    HOST_NODE_INSTALL_ROOTS="" \
    NVM_DIR="$tmp_dir/empty-nvm" \
    NODE_VERSION_REQUIRED="999.0.0" \
    PATH="/usr/bin:/bin" \
      resolve_host_node_bin_dir
  )" || fail "expected resolver to find ~/.local Node runtime"

  [ "$resolved" = "$expected" ] \
    || fail "expected ~/.local Node runtime, got $resolved"
  rm -rf "$tmp_dir"
}

test_discovers_usr_local_style_node_root_with_minimal_path() {
  local tmp_dir expected resolved
  tmp_dir="$(mktemp -d)"
  expected="$tmp_dir/usr-local/lib/nodejs/node-v999.0.0-darwin-arm64/bin"
  make_fake_node_runtime "$expected" "v999.0.0"

  resolved="$(
    HOME="$tmp_dir/home" \
    HOST_NODE_BIN_DIR="" \
    HOST_NODE_INSTALL_ROOTS="$tmp_dir/usr-local/lib/nodejs" \
    NVM_DIR="$tmp_dir/empty-nvm" \
    NODE_VERSION_REQUIRED="999.0.0" \
    PATH="/usr/bin:/bin" \
      resolve_host_node_bin_dir
  )" || fail "expected resolver to find /usr/local-style Node runtime"

  [ "$resolved" = "$expected" ] \
    || fail "expected /usr/local-style Node runtime, got $resolved"
  rm -rf "$tmp_dir"
}

test_discovers_nvm_node_with_minimal_path() {
  local tmp_dir expected resolved
  tmp_dir="$(mktemp -d)"
  expected="$tmp_dir/home/.nvm/versions/node/v999.0.0/bin"
  make_fake_node_runtime "$expected" "v999.0.0"

  resolved="$(
    HOME="$tmp_dir/home" \
    HOST_NODE_BIN_DIR="" \
    HOST_NODE_INSTALL_ROOTS="$tmp_dir/empty-managed" \
    NVM_DIR="$tmp_dir/home/.nvm" \
    NODE_VERSION_REQUIRED="999.0.0" \
    PATH="/usr/bin:/bin" \
      resolve_host_node_bin_dir
  )" || fail "expected resolver to find nvm Node runtime"

  [ "$resolved" = "$expected" ] \
    || fail "expected nvm Node runtime, got $resolved"
  rm -rf "$tmp_dir"
}

test_prefers_nvm_node_over_legacy_managed_root() {
  local tmp_dir expected managed resolved
  tmp_dir="$(mktemp -d)"
  expected="$tmp_dir/home/.nvm/versions/node/v999.1.0/bin"
  managed="$tmp_dir/usr-local/lib/nodejs/node-v999.0.0-darwin-arm64/bin"
  make_fake_node_runtime "$expected" "v999.1.0"
  make_fake_node_runtime "$managed" "v999.0.0"

  resolved="$(
    HOME="$tmp_dir/home" \
    HOST_NODE_BIN_DIR="" \
    HOST_NODE_INSTALL_ROOTS="$tmp_dir/usr-local/lib/nodejs" \
    NVM_DIR="$tmp_dir/home/.nvm" \
    NODE_VERSION_REQUIRED="999.0.0" \
    PATH="/usr/bin:/bin" \
      resolve_host_node_bin_dir
  )" || fail "expected resolver to find nvm Node runtime"

  [ "$resolved" = "$expected" ] \
    || fail "expected nvm Node runtime to win over legacy managed root, got $resolved"
  rm -rf "$tmp_dir"
}

test_runtime_scrubs_package_manager_credentials() {
  if grep -q 'NVM_NODEJS_ORG_MIRROR=https://token:' "$RUN_HOST_SCRIPT"; then
    fail "run-host-mcp.sh must not export token-bearing node mirror URLs"
  fi
  if grep -q 'NPM_CONFIG_GLOBALCONFIG=' "$RUN_HOST_SCRIPT"; then
    fail "run-host-mcp.sh must not export npm config into the host runtime"
  fi
  for credential_pattern in \
    'npm_config_\*' \
    'NPM_CONFIG_\*' \
    'YARN_NPM_\*' \
    'COREPACK_NPM_\*' \
    'BUN_CONFIG_\*' \
    'NODE_AUTH_TOKEN' \
    'NPM_AUTH_TOKEN' \
    'NPM_TOKEN' \
    'BUN_AUTH_TOKEN' \
    'NVM_NODEJS_ORG_MIRROR'; do
    grep -q "$credential_pattern" "$RUN_HOST_SCRIPT" \
      || fail "run-host-mcp.sh must scrub $credential_pattern from the host MCP runtime"
  done
  grep -q 'prepare-managed-node-packages' "$RUN_HOST_SCRIPT" \
    || fail "expected run-host-mcp.sh to prepare managed Node packages before sandboxed launch"
  grep -q 'prepare-managed-node-packages --enabled-only --deployment-type host' "$RUN_HOST_SCRIPT" \
    || fail "expected run-host-mcp.sh to prepare only enabled host managed Node packages"
  grep -q 'prepare-managed-node-packages --enabled-only --deployment-type host --best-effort' "$RUN_HOST_SCRIPT" \
    || fail "expected host startup package preparation to contain per-server failures"
  grep -q 'managed_node_package_preparation-host.json' "$RUN_HOST_SCRIPT" \
    || fail "expected host startup to publish deployment-scoped managed Node preparation status"
  grep -q 'HOST_MCP_SRT_RUNNER_JS' "$RUN_HOST_SCRIPT" \
    || fail "expected run-host-mcp.sh to use the SRT profile hardening runner"
  grep -q 'run_mcp_orc_docker_managed_node_preparer' "$REPO_ROOT/src/scripts/docker-compose.sh" \
    || fail "expected docker-compose.sh to prepare Docker managed Node packages inside a one-shot container"
  grep -q -- '--deployment-type docker' "$REPO_ROOT/src/scripts/docker-compose.sh" \
    || fail "expected docker-compose.sh to prepare only enabled Docker managed Node packages"
  grep -q -- '--best-effort' "$REPO_ROOT/src/scripts/docker-compose.sh" \
    || fail "expected docker-compose.sh startup preparation to be best-effort"
  grep -q 'managed_node_package_preparation.json' "$REPO_ROOT/src/scripts/docker-compose.sh" \
    || fail "expected docker-compose.sh to publish managed Node preparation status"
  grep -q 'rm -f "$host_status_file" || return 1' "$REPO_ROOT/src/scripts/docker-compose.sh" \
    || fail "expected Docker preparation to clear stale host managed Node status"
}

load_runtime_resolution_functions
test_discovers_aux_node_under_home_local_with_minimal_path
test_discovers_usr_local_style_node_root_with_minimal_path
test_discovers_nvm_node_with_minimal_path
test_prefers_nvm_node_over_legacy_managed_root
test_runtime_scrubs_package_manager_credentials

echo "PASS: host MCP runtime resolution tests"
