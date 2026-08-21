#!/bin/bash
# Run the PORTICO-managed Host MCP Bridge daemon.

set -euo pipefail

log_info() {
  echo "[Host MCP Bridge] $1" >&2
}

log_error() {
  echo "[Host MCP Bridge][ERROR] $1" >&2
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/../.."
source "$SCRIPT_DIR/mcp-orc-backend.sh"
source "$SCRIPT_DIR/host-mcp-binary-policy.sh"

ensure_host_mcp_cached_binary_from_image() {
  local image_ref="$1"
  local cache_bin
  cache_bin="$(host_mcp_cached_binary_path)"
  local cache_dir
  cache_dir="$(dirname "$cache_bin")"

  [ -n "$image_ref" ] || return 1

  if ! host_mcp_can_extract_image_binary; then
    return 1
  fi

  if [ -x "$cache_bin" ]; then
    return 0
  fi

  if ! command -v docker >/dev/null 2>&1; then
    return 1
  fi

  if ! docker image inspect "$image_ref" >/dev/null 2>&1; then
    return 1
  fi

  mkdir -p "$cache_dir"

  local container_id=""
  local temp_bin="${cache_bin}.tmp"
  trap "rm -f $(printf '%q' "$temp_bin")" RETURN

  container_id="$(docker create "$image_ref" true 2>/dev/null || true)"
  [ -n "$container_id" ] || return 1
  trap "rm -f $(printf '%q' "$temp_bin"); docker rm -f $(printf '%q' "$container_id") >/dev/null 2>&1 || true" RETURN

  if ! docker cp "${container_id}:/usr/local/bin/mcp-orc" "$temp_bin" >/dev/null 2>&1; then
    return 1
  fi

  chmod +x "$temp_bin"
  mv "$temp_bin" "$cache_bin"
  log_info "Using shipped Rust MCP orchestrator binary extracted from image ${image_ref}"
  return 0
}

resolve_host_mcp_artifact_binaries() {
  local project_root="$1"
  local resources_root="$2"
  local artifact_path

  if [ -n "$project_root" ]; then
    artifact_path="$(host_mcp_artifact_binary_path "$project_root/host-mcp-binaries")"
    if [ -x "$artifact_path" ]; then
      echo "$artifact_path"
    fi
  fi

  if [ -n "$resources_root" ]; then
    artifact_path="$(host_mcp_artifact_binary_path "$resources_root/host-mcp-binaries")"
    if [ -x "$artifact_path" ]; then
      echo "$artifact_path"
    fi
  fi
}

resolve_host_mcp_orc_bin() {
  local host_mcp_mode host_mcp_backend
  host_mcp_mode="$(resolve_mcp_orc_mode)"
  host_mcp_backend="$(mcp_orc_backend_for_scope host "$host_mcp_mode")"

  if [ "$host_mcp_backend" != "rust" ]; then
    log_error "Host MCP Bridge requires the Rust MCP backend; resolved host backend was ${host_mcp_backend}"
    return 1
  fi

  local debug_bin="$PROJECT_ROOT/src/mcp-orc-rust/target/debug/mcp-orc"
  local release_bin="$PROJECT_ROOT/src/mcp-orc-rust/target/release/mcp-orc"
  local cached_bin
  cached_bin="$(host_mcp_cached_binary_path)"
  local legacy_cached_bin
  legacy_cached_bin="$(host_mcp_legacy_cached_binary_path)"
  local runtime_image
  runtime_image="$(mcp_orc_local_image_name full rust)"
  local resources_root="${HOST_MCP_RESOURCES_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
  local candidate_bin=""

  if [ "$legacy_cached_bin" != "$cached_bin" ] && [ -e "$legacy_cached_bin" ]; then
    if ! host_mcp_binary_is_host_compatible "$legacy_cached_bin"; then
      rm -f "$legacy_cached_bin"
      log_info "Removed stale incompatible cached host MCP binary: $legacy_cached_bin"
    fi
  fi

  if host_mcp_is_packaged_mac_resources_root "$resources_root"; then
    candidate_bin="$(host_mcp_artifact_binary_path "$resources_root/host-mcp-binaries" "$(host_mcp_current_target_triple)" 2>/dev/null || true)"
    if [ -n "$candidate_bin" ] && [ -x "$candidate_bin" ] && host_mcp_binary_is_host_compatible "$candidate_bin"; then
      echo "$candidate_bin"
      return 0
    fi
    log_error "Packaged macOS app requires bundled signed Rust MCP orchestrator binary at $resources_root/host-mcp-binaries/$(host_mcp_current_target_triple)/mcp-orc"
    return 1
  fi

  if host_mcp_binary_is_current "$PROJECT_ROOT" "$debug_bin"; then
    echo "$debug_bin"
    return 0
  fi

  if host_mcp_binary_is_current "$PROJECT_ROOT" "$release_bin"; then
    echo "$release_bin"
    return 0
  fi

  while IFS= read -r candidate_bin; do
    [ -n "$candidate_bin" ] || continue
    if host_mcp_binary_is_current "$PROJECT_ROOT" "$candidate_bin" && host_mcp_binary_is_host_compatible "$candidate_bin"; then
      echo "$candidate_bin"
      return 0
    fi
  done < <(resolve_host_mcp_artifact_binaries "$PROJECT_ROOT" "$resources_root")

  if host_mcp_binary_is_current "$PROJECT_ROOT" "$cached_bin" && host_mcp_binary_is_host_compatible "$cached_bin"; then
    echo "$cached_bin"
    return 0
  fi

  if ensure_host_mcp_cached_binary_from_image "$runtime_image"; then
    echo "$cached_bin"
    return 0
  fi

  if command -v mcp-orc >/dev/null 2>&1; then
    command -v mcp-orc
    return 0
  fi

  log_error "No shipped or local mcp-orc binary is available."
  log_error "Expected local image for extraction: ${runtime_image}"
  return 1
}

cd "$PROJECT_ROOT"

HOST_MCP_ORC_BIN="$(resolve_host_mcp_orc_bin)"
export MCP_ORC_BACKEND="rust"

if [ "${1:-}" = "--stdio-proxy" ]; then
  HOST_MCP_BRIDGE_REMOTE_URL="${HOST_MCP_BRIDGE_REMOTE_URL:-http://127.0.0.1:8891/mcp}"
  log_info "Starting stdio proxy for ${HOST_MCP_BRIDGE_REMOTE_URL}"
  proxy_args=(bridge --stdio-proxy --remote-url "$HOST_MCP_BRIDGE_REMOTE_URL")
  if [ -n "${HOST_MCP_BRIDGE_REMOTE_AUTH_TOKEN_FILE:-}" ]; then
    proxy_args+=(--remote-auth-token-file "$HOST_MCP_BRIDGE_REMOTE_AUTH_TOKEN_FILE")
  fi
  exec "$HOST_MCP_ORC_BIN" "${proxy_args[@]}"
fi

HOST_MCP_BRIDGE_HOST="${HOST_MCP_BRIDGE_HOST:-127.0.0.1}"
HOST_MCP_BRIDGE_PORT="${HOST_MCP_BRIDGE_PORT:-8891}"
HOST_MCP_BRIDGE_MCP_PATH="${HOST_MCP_BRIDGE_MCP_PATH:-/mcp}"
HOST_MCP_BRIDGE_CORE_URL="${HOST_MCP_BRIDGE_CORE_URL:-http://127.0.0.1:8766}"
HOST_MCP_BRIDGE_REGULAR_URL="${HOST_MCP_BRIDGE_REGULAR_URL:-http://127.0.0.1:8765}"
HOST_MCP_BRIDGE_HOST_URL="${HOST_MCP_BRIDGE_HOST_URL:-http://127.0.0.1:8890}"
HOST_MCP_BRIDGE_AUTH_REGISTRY="${HOST_MCP_BRIDGE_AUTH_REGISTRY:-}"

log_info "Starting bridge daemon on ${HOST_MCP_BRIDGE_HOST}:${HOST_MCP_BRIDGE_PORT}${HOST_MCP_BRIDGE_MCP_PATH}"
log_info "Using Rust MCP orchestrator binary: $HOST_MCP_ORC_BIN"

exec "$HOST_MCP_ORC_BIN" bridge \
  --host "$HOST_MCP_BRIDGE_HOST" \
  --port "$HOST_MCP_BRIDGE_PORT" \
  --mcp-path "$HOST_MCP_BRIDGE_MCP_PATH" \
  --core-url "$HOST_MCP_BRIDGE_CORE_URL" \
  --regular-url "$HOST_MCP_BRIDGE_REGULAR_URL" \
  --host-url "$HOST_MCP_BRIDGE_HOST_URL" \
  --auth-registry "$HOST_MCP_BRIDGE_AUTH_REGISTRY"
