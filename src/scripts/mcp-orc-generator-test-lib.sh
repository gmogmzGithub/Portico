#!/usr/bin/env bash

# Shared helpers for shell tests that need to exercise the mcp-orc generator
# without writing generated topology back into the real repository root.

mcp_orc_test_resolve_generator_binary() {
  local repo_root="$1"
  local binary=""

  # shellcheck source=src/scripts/mcp-orc-cli.sh
  source "$repo_root/src/scripts/mcp-orc-cli.sh"

  if ! binary="$(resolve_mcp_orc_generator_binary "$repo_root")"; then
    if ! bootstrap_mcp_orc_generator_binary "$repo_root"; then
      echo "Error: unable to resolve an up-to-date mcp-orc binary for fixture test" >&2
      echo "Run: bash \"$repo_root/src/scripts/build-host-mcp-binaries.sh\" --host-only" >&2
      return 127
    fi

    if ! binary="$(resolve_mcp_orc_generator_binary "$repo_root")"; then
      echo "Error: bootstrapped current-host mcp-orc binary but still could not resolve it" >&2
      return 127
    fi
  fi

  printf '%s\n' "$binary"
}

mcp_orc_test_prepare_project_root() {
  local repo_root="$1"
  local fixture_root="$2"

  mkdir -p \
    "$fixture_root/electron-app" \
    "$fixture_root/mcp-configs" \
    "$fixture_root/mcp-configs-user" \
    "$fixture_root/mcpo-configs-generated" \
    "$fixture_root/src"

  printf '{"buildNumber":"dev-build"}\n' >"$fixture_root/electron-app/build-info.json"
  printf '{}\n' >"$fixture_root/mcp_tools_config.json"
  : >"$fixture_root/HOST_MODE"
  : >"$fixture_root/.env"

  if [ -f "$repo_root/mcp-container-groups.json" ]; then
    cp "$repo_root/mcp-container-groups.json" "$fixture_root/mcp-container-groups.json"
  fi
}

mcp_orc_test_copy_server_configs() {
  local repo_root="$1"
  local fixture_root="$2"
  shift 2

  local server_id=""
  for server_id in "$@"; do
    [ -d "$repo_root/mcp-configs/$server_id" ] || {
      echo "Missing MCP config directory for fixture server: $server_id" >&2
      return 1
    }
    cp -R "$repo_root/mcp-configs/$server_id" "$fixture_root/mcp-configs/"
  done
}

mcp_orc_test_run_generator() {
  local repo_root="$1"
  local fixture_root="$2"
  shift 2

  local binary=""
  binary="$(mcp_orc_test_resolve_generator_binary "$repo_root")" || return $?
  "$binary" "$@" --project-root "$fixture_root"
}
