#!/bin/bash

host_mcp_platform_tag() {
  local os arch
  os="$(uname -s 2>/dev/null || echo unknown)"
  arch="$(uname -m 2>/dev/null || echo unknown)"

  os="$(printf '%s' "$os" | tr '[:upper:]' '[:lower:]')"
  arch="$(printf '%s' "$arch" | tr '[:upper:]' '[:lower:]')"

  echo "${os}-${arch}"
}

host_mcp_current_target_triple() {
  local os arch
  os="$(uname -s 2>/dev/null || echo unknown)"
  arch="$(uname -m 2>/dev/null || echo unknown)"

  case "$os:$arch" in
    Darwin:arm64) echo "aarch64-apple-darwin" ;;
    Darwin:x86_64) echo "x86_64-apple-darwin" ;;
    Linux:x86_64) echo "x86_64-unknown-linux-gnu" ;;
    Linux:aarch64|Linux:arm64) echo "aarch64-unknown-linux-gnu" ;;
    *)
      echo "${os,,}-${arch,,}"
      ;;
  esac
}

host_mcp_is_packaged_mac_resources_root() {
  local resources_root="${1:-${HOST_MCP_RESOURCES_ROOT:-}}"
  [ "$(uname -s 2>/dev/null || echo unknown)" = "Darwin" ] || return 1

  case "${HOST_MCP_IS_PACKAGED:-}" in
    1|true|TRUE|yes|YES)
      return 0
      ;;
    0|false|FALSE|no|NO)
      return 1
      ;;
  esac

  [ -n "$resources_root" ] || return 1

  case "$resources_root" in
    */node_modules/electron/dist/Electron.app/Contents/Resources|*/node_modules/electron/dist/Electron.app/Contents/Resources/*)
      return 1
      ;;
  esac

  case "$resources_root" in
    *.app/Contents/Resources|*.app/Contents/Resources/*)
      return 0
      ;;
  esac

  return 1
}

host_mcp_binary_is_current() {
  local project_root="$1"
  local binary_path="$2"

  [ -n "$project_root" ] || return 1
  [ -x "$binary_path" ] || return 1

  local rust_root="$project_root/src/mcp-orc-rust"
  local shared_root="$project_root/src/core-mcp-rust/crates/core-mcp-shared"
  local source_root
  [ -d "$rust_root" ] || return 1

  # mcp-orc consumes core-mcp-shared through a path dependency outside its
  # Cargo workspace. Both roots must be current or a changed shared catalog can
  # otherwise leave the host bridge running an older binary indefinitely. A
  # packaged update snapshot intentionally omits that source dependency, so an
  # absent shared root is not evidence that its bundled binary is stale.
  for source_root in "$rust_root" "$shared_root"; do
    [ -d "$source_root" ] || continue
    if find "$source_root" \
      \( -path "$source_root/target" -o -path "$source_root/target/*" \) -prune -o \
      -type f \
      \( -name '*.rs' -o -name 'Cargo.toml' -o -name 'Cargo.lock' \) \
      -newer "$binary_path" -print -quit | grep -q .; then
      return 1
    fi
  done

  return 0
}

host_mcp_binary_is_host_compatible() {
  local binary_path="$1"
  [ -x "$binary_path" ] || return 1

  if ! command -v file >/dev/null 2>&1; then
    return 0
  fi

  local description
  description="$(file -b "$binary_path" 2>/dev/null || true)"

  case "$(uname -s 2>/dev/null || echo unknown)" in
    Darwin)
      [[ "$description" == *Mach-O* ]]
      ;;
    Linux)
      [[ "$description" == *ELF* ]]
      ;;
    *)
      return 0
      ;;
  esac
}

host_mcp_can_extract_image_binary() {
  case "$(uname -s 2>/dev/null || echo unknown)" in
    Darwin)
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}

host_mcp_binary_cache_dir() {
  if [ -n "${HOST_MCP_BIN_ROOT:-}" ]; then
    echo "$HOST_MCP_BIN_ROOT"
    return 0
  fi

  case "$(uname -s 2>/dev/null || echo unknown)" in
    Darwin)
      echo "$HOME/Library/Application Support/portico/bin"
      ;;
    *)
      echo "${XDG_DATA_HOME:-$HOME/.local/share}/portico/bin"
      ;;
  esac
}

host_mcp_cached_binary_path() {
  local cache_dir
  cache_dir="$(host_mcp_binary_cache_dir)"
  echo "$cache_dir/mcp-orc-$(host_mcp_platform_tag)"
}

host_mcp_legacy_cached_binary_path() {
  local cache_dir
  cache_dir="$(host_mcp_binary_cache_dir)"
  echo "$cache_dir/mcp-orc"
}

host_mcp_artifact_binary_path() {
  local artifacts_root="$1"
  local target_triple="${2:-$(host_mcp_current_target_triple)}"

  [ -n "$artifacts_root" ] || return 1
  echo "$artifacts_root/$target_triple/mcp-orc"
}
