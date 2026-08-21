#!/bin/bash
# Run host MCP proxy with the Rust MCP orchestrator
# Bundled HOST prerequisites are provisioned during the setup wizard.

set -euo pipefail

NODE_VERSION_REQUIRED="${NODE_VERSION_REQUIRED:-20.19.0}"

log_info() {
  echo "[Host MCPO] $1"
}

log_error() {
  echo "[Host MCPO][ERROR] $1" >&2
}

quote_shell_command() {
  local quoted=()
  local arg
  for arg in "$@"; do
    quoted+=("$(printf '%q' "$arg")")
  done
  (IFS=' '; echo "${quoted[*]}")
}

exec_host_mcp_sandboxed() {
  local command_string
  command_string="$(quote_shell_command "$@")"

  if [ "${HOST_MCP_SANDBOX_ENABLED:-}" != "1" ]; then
    log_error "Host MCP sandbox is not prepared. Refusing to start unsandboxed host MCP runtime."
    exit 1
  fi
  if [ -z "${HOST_MCP_SRT_CLI_JS:-}" ] || [ ! -f "$HOST_MCP_SRT_CLI_JS" ]; then
    log_error "Host MCP sandbox runtime CLI is missing: ${HOST_MCP_SRT_CLI_JS:-<unset>}"
    exit 1
  fi
  if [ -z "${HOST_MCP_SRT_SETTINGS_PATH:-}" ] || [ ! -f "$HOST_MCP_SRT_SETTINGS_PATH" ]; then
    log_error "Host MCP sandbox settings file is missing: ${HOST_MCP_SRT_SETTINGS_PATH:-<unset>}"
    exit 1
  fi

  case "$(uname -s 2>/dev/null)" in
    Darwin)
      if [ ! -x /usr/bin/sandbox-exec ]; then
        log_error "macOS sandbox-exec is missing; refusing to start unsandboxed host MCP runtime."
        exit 1
      fi
      if [ -z "${HOST_MCP_SRT_RUNNER_JS:-}" ] || [ ! -f "$HOST_MCP_SRT_RUNNER_JS" ]; then
        log_error "Host MCP SRT profile hardening runner is missing: ${HOST_MCP_SRT_RUNNER_JS:-<unset>}"
        exit 1
      fi
      if [ -z "${HOST_MCP_NO_KEYCHAIN_PROFILE_PATH:-}" ] || [ ! -f "$HOST_MCP_NO_KEYCHAIN_PROFILE_PATH" ]; then
        log_error "Host MCP no-Keychain Seatbelt additions are missing: ${HOST_MCP_NO_KEYCHAIN_PROFILE_PATH:-<unset>}"
        exit 1
      fi
      log_info "Starting host MCP under SRT with no-Keychain Seatbelt additions"
      exec "$HOST_NODE_PATH" "$HOST_MCP_SRT_RUNNER_JS" \
        --settings "$HOST_MCP_SRT_SETTINGS_PATH" \
        --srt-cli-js "$HOST_MCP_SRT_CLI_JS" \
        --append-profile "$HOST_MCP_NO_KEYCHAIN_PROFILE_PATH" \
        -- "$@"
      ;;
    *)
      log_info "Starting host MCP under SRT"
      exec "$HOST_NODE_PATH" "$HOST_MCP_SRT_CLI_JS" \
        --settings "$HOST_MCP_SRT_SETTINGS_PATH" \
        -c "$command_string"
      ;;
  esac
}

normalize_semver() {
  local raw="$1"
  local version="${raw#v}"
  version="${version%%-*}"
  version="${version%%+*}"

  if [[ ! "$version" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]]; then
    return 1
  fi

  local major minor patch
  IFS='.' read -r major minor patch <<< "$version"
  minor="${minor:-0}"
  patch="${patch:-0}"
  echo "${major}.${minor}.${patch}"
}

semver_gte() {
  local left right
  left="$(normalize_semver "$1")" || return 1
  right="$(normalize_semver "$2")" || return 1

  local l_major l_minor l_patch r_major r_minor r_patch
  IFS='.' read -r l_major l_minor l_patch <<< "$left"
  IFS='.' read -r r_major r_minor r_patch <<< "$right"

  if (( l_major > r_major )); then
    return 0
  fi
  if (( l_major < r_major )); then
    return 1
  fi
  if (( l_minor > r_minor )); then
    return 0
  fi
  if (( l_minor < r_minor )); then
    return 1
  fi
  if (( l_patch >= r_patch )); then
    return 0
  fi

  return 1
}

resolve_host_node_bin_dir() {
  local path_candidates=""
  if [ -n "${HOST_NODE_BIN_DIR:-}" ]; then
    path_candidates="${HOST_NODE_BIN_DIR}"
  fi

  if [ -n "${PATH:-}" ]; then
    if [ -n "$path_candidates" ]; then
      path_candidates="${path_candidates}:${PATH}"
    else
      path_candidates="$PATH"
    fi
  fi

  local nvm_root="${NVM_DIR:-$HOME/.nvm}"
  local install_dir
  for install_dir in "$nvm_root"/versions/node/*/bin; do
    [ -d "$install_dir" ] || continue
    if [ -n "$path_candidates" ]; then
      path_candidates="${path_candidates}:${install_dir}"
    else
      path_candidates="$install_dir"
    fi
  done

  local install_roots="${HOST_NODE_INSTALL_ROOTS:-$HOME/.local/lib/nodejs:/usr/local/lib/nodejs}"
  local install_root
  IFS=':' read -r -a install_root_entries <<< "$install_roots"
  for install_root in "${install_root_entries[@]}"; do
    [ -n "$install_root" ] || continue
    for install_dir in "$install_root"/node-*/bin; do
      [ -d "$install_dir" ] || continue
      if [ -n "$path_candidates" ]; then
        path_candidates="${path_candidates}:${install_dir}"
      else
        path_candidates="$install_dir"
      fi
    done
  done

  local seen=":"
  local candidate_dir node_path node_version_raw node_version_normalized
  IFS=':' read -r -a entries <<< "$path_candidates"
  for candidate_dir in "${entries[@]}"; do
    [ -n "$candidate_dir" ] || continue

    case "$seen" in
      *":${candidate_dir}:"*) continue ;;
      *) seen="${seen}${candidate_dir}:" ;;
    esac

    node_path="${candidate_dir}/node"
    [ -x "$node_path" ] || continue

    node_version_raw="$("$node_path" --version 2>/dev/null || true)"
    node_version_normalized="$(normalize_semver "$node_version_raw" || true)"
    [ -n "$node_version_normalized" ] || continue

    if semver_gte "$node_version_normalized" "$NODE_VERSION_REQUIRED"; then
      RESOLVED_NODE_VERSION_RAW="$node_version_raw"
      RESOLVED_NODE_VERSION_NORMALIZED="$node_version_normalized"
      echo "$candidate_dir"
      return 0
    fi
  done

  return 1
}

# Ensure uv/uvx is in PATH
export PATH="$HOME/.local/bin:${PATH:-}"

HOST_NODE_BIN_DIR="$(resolve_host_node_bin_dir || true)"
if [ -z "${HOST_NODE_BIN_DIR}" ]; then
  current_node_path="$(command -v node 2>/dev/null || true)"
  if [ -n "$current_node_path" ]; then
    current_node_version="$("$current_node_path" --version 2>/dev/null || true)"
    log_error "Detected Node.js ${current_node_version:-unknown} at ${current_node_path}, but no compatible Node.js runtime (>= v${NODE_VERSION_REQUIRED}) was found in PATH."
  else
    log_error "Node.js not found. Required >= v${NODE_VERSION_REQUIRED}. Install Node.js and retry."
  fi
  exit 1
fi

HOST_NODE_PATH="${HOST_NODE_BIN_DIR}/node"
HOST_NPM_PATH="${HOST_NODE_BIN_DIR}/npm"

if [ ! -x "$HOST_NODE_PATH" ]; then
  log_error "Resolved node path is not executable: $HOST_NODE_PATH"
  exit 1
fi

if [ ! -x "$HOST_NPM_PATH" ]; then
  HOST_NPM_PATH="$(command -v npm 2>/dev/null || true)"
fi
if [ -z "$HOST_NPM_PATH" ] || [ ! -x "$HOST_NPM_PATH" ]; then
  log_error "npm is required for managed Node MCP package preparation but was not found next to Node.js."
  exit 1
fi

NODE_VERSION_RAW="${RESOLVED_NODE_VERSION_RAW:-$("$HOST_NODE_PATH" --version 2>/dev/null || true)}"
NODE_VERSION_NORMALIZED="${RESOLVED_NODE_VERSION_NORMALIZED:-$(normalize_semver "$NODE_VERSION_RAW" || true)}"
if [ -z "$NODE_VERSION_NORMALIZED" ]; then
  log_error "Unable to parse Node.js version from '${NODE_VERSION_RAW:-unknown}' at $HOST_NODE_PATH"
  exit 1
fi

if ! semver_gte "$NODE_VERSION_NORMALIZED" "$NODE_VERSION_REQUIRED"; then
  log_error "Node.js ${NODE_VERSION_RAW} is too old for host MCP (required >= v${NODE_VERSION_REQUIRED})"
  log_error "Resolved node: $HOST_NODE_PATH"
  exit 1
fi

# Do not add the Node installation directory to PATH for the sandboxed runtime:
# it commonly contains npm/npx. Managed Node MCPs receive HOST_NODE_PATH and the
# Rust orchestrator execs the prepared package entrypoint directly.
PATH_ENTRIES=()
IFS=':' read -r -a RAW_PATH_ENTRIES <<< "${PATH:-}"
for entry in "${RAW_PATH_ENTRIES[@]}"; do
  [ -n "$entry" ] || continue
  if [ "$entry" != "$HOST_NODE_BIN_DIR" ]; then
    PATH_ENTRIES+=("$entry")
  fi
done

if [ "${#PATH_ENTRIES[@]}" -gt 0 ]; then
  export PATH="$(IFS=:; echo "${PATH_ENTRIES[*]}")"
else
  export PATH="/usr/bin:/bin:/usr/sbin:/sbin"
fi
export HOST_NODE_BIN_DIR
export HOST_NODE_PATH
export portico_MANAGED_NODE_NPM_BIN="$HOST_NPM_PATH"

log_info "Using Node.js ${NODE_VERSION_RAW} from ${HOST_NODE_PATH}"

# Force Python 3.13 for uvx-based host servers to avoid Python 3.14 compatibility issues
export UV_PYTHON=3.13

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
  trap 'rm -f "$temp_bin"; if [ -n "${container_id:-}" ]; then docker rm -f "$container_id" >/dev/null 2>&1 || true; fi' RETURN

  container_id="$(docker create "$image_ref" true 2>/dev/null || true)"
  [ -n "$container_id" ] || return 1

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

# Electron dev launches can leak npm registry credential variables from package
# manager wrappers. The long-running host MCP runtime must not inherit them.
while IFS='=' read -r var_name _; do
  case "$var_name" in
    npm_config_*|NPM_CONFIG_*|YARN_NPM_*|COREPACK_NPM_*|BUN_CONFIG_*|NODE_AUTH_TOKEN|NPM_AUTH_TOKEN|NPM_TOKEN|BUN_AUTH_TOKEN|NVM_NODEJS_ORG_MIRROR)
      unset "$var_name"
      ;;
  esac
done < <(env)

# Set PYTHONPATH to prioritize our patched MCPO modules over the installed ones
# We add src/patches to PYTHONPATH so that 'import mcpo' finds our patched mcpo package
# This allows us to override main.py and other modules with our enterprise patches
if [ -n "${PYTHONPATH:-}" ]; then
  export PYTHONPATH="$PROJECT_ROOT/src/patches:$PYTHONPATH"
else
  export PYTHONPATH="$PROJECT_ROOT/src/patches"
fi

cd "$PROJECT_ROOT"

HOST_MCP_MODE="$(resolve_mcp_orc_mode)"
HOST_MCP_BACKEND="$(mcp_orc_backend_for_scope host "$HOST_MCP_MODE")"

if [ "$HOST_MCP_BACKEND" = "rust" ]; then
  log_info "Starting Rust MCP orchestrator on port 8890 (mode=${HOST_MCP_MODE})..."

  HOST_MCP_DEBUG_BIN="$PROJECT_ROOT/src/mcp-orc-rust/target/debug/mcp-orc"
  HOST_MCP_RELEASE_BIN="$PROJECT_ROOT/src/mcp-orc-rust/target/release/mcp-orc"
  HOST_MCP_CACHED_BIN="$(host_mcp_cached_binary_path)"
  HOST_MCP_LEGACY_CACHED_BIN="$(host_mcp_legacy_cached_binary_path)"
  HOST_MCP_RUNTIME_IMAGE="$(mcp_orc_local_image_name full rust)"
  HOST_MCP_RESOURCES_ROOT="${HOST_MCP_RESOURCES_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
  HOST_MCP_ORC_BIN=""

  if [ "$HOST_MCP_LEGACY_CACHED_BIN" != "$HOST_MCP_CACHED_BIN" ] && [ -e "$HOST_MCP_LEGACY_CACHED_BIN" ]; then
    if ! host_mcp_binary_is_host_compatible "$HOST_MCP_LEGACY_CACHED_BIN"; then
      rm -f "$HOST_MCP_LEGACY_CACHED_BIN"
      log_info "Removed stale incompatible cached host MCP binary: $HOST_MCP_LEGACY_CACHED_BIN"
    fi
  fi

  if host_mcp_is_packaged_mac_resources_root "$HOST_MCP_RESOURCES_ROOT"; then
    HOST_MCP_ORC_BIN="$(host_mcp_artifact_binary_path "$HOST_MCP_RESOURCES_ROOT/host-mcp-binaries" "$(host_mcp_current_target_triple)" 2>/dev/null || true)"
    if [ -z "$HOST_MCP_ORC_BIN" ] || [ ! -x "$HOST_MCP_ORC_BIN" ] || ! host_mcp_binary_is_host_compatible "$HOST_MCP_ORC_BIN"; then
      log_error "Packaged macOS app requires bundled signed Rust MCP orchestrator binary at $HOST_MCP_RESOURCES_ROOT/host-mcp-binaries/$(host_mcp_current_target_triple)/mcp-orc"
      exit 1
    fi
  elif host_mcp_binary_is_current "$PROJECT_ROOT" "$HOST_MCP_DEBUG_BIN"; then
    HOST_MCP_ORC_BIN="$HOST_MCP_DEBUG_BIN"
  elif host_mcp_binary_is_current "$PROJECT_ROOT" "$HOST_MCP_RELEASE_BIN"; then
    HOST_MCP_ORC_BIN="$HOST_MCP_RELEASE_BIN"
  else
    while IFS= read -r candidate_bin; do
      [ -n "$candidate_bin" ] || continue
      if host_mcp_binary_is_current "$PROJECT_ROOT" "$candidate_bin" && host_mcp_binary_is_host_compatible "$candidate_bin"; then
        HOST_MCP_ORC_BIN="$candidate_bin"
        break
      fi
    done < <(resolve_host_mcp_artifact_binaries "$PROJECT_ROOT" "$HOST_MCP_RESOURCES_ROOT")
  fi

  if [ -z "$HOST_MCP_ORC_BIN" ] && host_mcp_binary_is_current "$PROJECT_ROOT" "$HOST_MCP_CACHED_BIN" && host_mcp_binary_is_host_compatible "$HOST_MCP_CACHED_BIN"; then
    HOST_MCP_ORC_BIN="$HOST_MCP_CACHED_BIN"
  elif [ -z "$HOST_MCP_ORC_BIN" ] && ensure_host_mcp_cached_binary_from_image "$HOST_MCP_RUNTIME_IMAGE"; then
    HOST_MCP_ORC_BIN="$HOST_MCP_CACHED_BIN"
  fi

  export MCP_ORC_MODE="$HOST_MCP_MODE"
  export MCP_ORC_BACKEND="rust"
  export portico_MANAGED_NODE_SRT_CLI_JS="${HOST_MCP_SRT_CLI_JS:-}"
  export portico_MANAGED_NODE_SRT_RUNNER_JS="${HOST_MCP_SRT_RUNNER_JS:-}"
  MANAGED_NODE_PREPARATION_STATUS="$PROJECT_ROOT/health-status/managed_node_package_preparation-host.json"
  mkdir -p "$PROJECT_ROOT/health-status"

  if [ -n "$HOST_MCP_ORC_BIN" ]; then
    log_info "Using up-to-date local Rust MCP orchestrator binary: $HOST_MCP_ORC_BIN"
    "$HOST_MCP_ORC_BIN" prepare-managed-node-packages --enabled-only --deployment-type host --best-effort --status-file "$MANAGED_NODE_PREPARATION_STATUS" --project-root "$PROJECT_ROOT"
    exec_host_mcp_sandboxed "$HOST_MCP_ORC_BIN" --port 8890 --config mcp_config_host_sideload.json
  fi

  if command -v mcp-orc >/dev/null 2>&1; then
    HOST_MCP_ORC_BIN="$(command -v mcp-orc)"
    log_info "Falling back to PATH Rust MCP orchestrator binary: $HOST_MCP_ORC_BIN"
    "$HOST_MCP_ORC_BIN" prepare-managed-node-packages --enabled-only --deployment-type host --best-effort --status-file "$MANAGED_NODE_PREPARATION_STATUS" --project-root "$PROJECT_ROOT"
    exec_host_mcp_sandboxed "$HOST_MCP_ORC_BIN" --port 8890 --config mcp_config_host_sideload.json
  fi

  log_error "Rust host MCP mode requested, but no shipped or local mcp-orc binary is available."
  log_error "Expected local image for extraction: ${HOST_MCP_RUNTIME_IMAGE}"
  exit 1
fi

# Start MCPO on port 8890 using our patched Python version
# Use uvx which sets up the proper environment with all dependencies
# PYTHONPATH ensures our patched main.py is used instead of the original
log_info "Starting patched MCPO on port 8890..."
exec_host_mcp_sandboxed uvx mcpo@0.0.19 --port 8890 --config mcp_config_host_sideload.json
