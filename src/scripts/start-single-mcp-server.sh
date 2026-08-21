#!/bin/bash
# start-single-mcp-server.sh
# Starts a minimal Docker stack for a single MCP server during OAuth setup
# Used by the guided setup wizard to test individual servers

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
source "$SCRIPT_DIR/mcp-orc-backend.sh"
source "$SCRIPT_DIR/mcp-orc-cli.sh"
source "$SCRIPT_DIR/runtime-secrets.sh"
MCP_ORC_MODE_RESOLVED="$(resolve_mcp_orc_mode)"

# Resolve the user-scoped runtime-secrets cache dir that backs Docker Compose
# `secrets:` declarations for this standalone stack. Must stay in lockstep with
# src/scripts/docker-compose.sh::_default_runtime_secret_cache_dir so both
# orchestration paths read/write the same 0600 files.
_single_server_runtime_secret_cache_dir() {
    if [ -n "${PORTICO_RUNTIME_SECRET_CACHE_DIR:-}" ]; then
        printf '%s\n' "$PORTICO_RUNTIME_SECRET_CACHE_DIR"
        return 0
    fi
    case "$(uname -s 2>/dev/null)" in
        Darwin)
            printf '%s/Library/Caches/portico/runtime-secrets\n' "$HOME"
            ;;
        *)
            printf '%s/portico/runtime-secrets\n' "${XDG_STATE_HOME:-$HOME/.local/state}"
            ;;
    esac
}

# Usage information
usage() {
    echo "Usage: $0 <server-id> [--stop] [--status] [--logs] [--host-port PORT] [--callback-port PORT] [--build]"
    echo ""
    echo "Starts a minimal Docker stack for a single MCP server"
    echo ""
    echo "Arguments:"
    echo "  server-id    The MCP server ID (e.g., google_workspace, slack)"
    echo ""
    echo "Options:"
    echo "  --stop              Stop the single-server stack"
    echo "  --status            Check if the server is running"
    echo "  --logs              Show container logs"
    echo "  --host-port         Host port for single-server MCPO endpoint (default: 8770)"
    echo "  --callback-port     OAuth callback host port (supported: 3834 or 3836; default: 3836)"
    echo "  --build             Force rebuild of the single-server MCPO image"
    echo "  --oauth-bootstrap   Run without the OAuth access-token broker so a"
    echo "                      not-yet-authorized server can complete first-time"
    echo "                      OAuth (requires portico_OAUTH_BOOTSTRAP_EXPORT_TOKEN)"
    echo "  --help              Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0 google_workspace                      # Start on 8770 with callback on 3836"
    echo "  $0 google_workspace --build              # Force rebuild before starting"
    echo "  $0 google_workspace --host-port 8772 --callback-port 3836"
    echo "  $0 google_workspace --stop               # Stop the server"
    echo "  $0 google_workspace --status             # Check status"
    exit 1
}

# Configuration
SERVER_ID=""
ACTION="start"
COMPOSE_FILE="$PROJECT_ROOT/docker-compose.single-server.yml"
NGINX_CONF="$PROJECT_ROOT/src/mcpo-single-server-nginx.conf"
CALLBACK_HOST_PORT=3836  # Default for control plane (avoids collision with main stack)
HOST_PORT=8770
FORCE_BUILD=false
# OAuth bootstrap mode: run the single-server stack WITHOUT the OAuth
# access-token broker so a not-yet-authorized server can generate a
# container-local authorization URL and complete a first-time/interactive
# OAuth handshake. The captured record is exported to Electron afterwards.
OAUTH_BOOTSTRAP=false
OPTIMIZATION_FLAGS_FILE="$PROJECT_ROOT/optimization_flags.json"

optimization_flag_enabled() {
    local flag_name="$1"
    local default_value="${2:-true}"
    local env_name
    env_name="OWUI_OPT_$(echo "$flag_name" | tr '[:lower:]-' '[:upper:]_')"
    local env_value="${!env_name:-}"
    if [ -n "$env_value" ]; then
        case "$(echo "$env_value" | tr '[:upper:]' '[:lower:]')" in
            1|true|yes|on) return 0 ;;
            0|false|no|off) return 1 ;;
        esac
    fi
    if [ -f "$OPTIMIZATION_FLAGS_FILE" ] && jq -e ".\"$flag_name\"" "$OPTIMIZATION_FLAGS_FILE" >/dev/null 2>&1; then
        if [ "$(jq -r ".\"$flag_name\"" "$OPTIMIZATION_FLAGS_FILE")" = "true" ]; then
            return 0
        fi
        return 1
    fi
    [ "$default_value" = "true" ]
}

merge_default_disabled_tools() {
    local server_id="$1"
    local disabled_tools_json="$2"
    if [ "$server_id" = "glean" ] && optimization_flag_enabled "disable_glean_read_document_by_default" "true"; then
        jq -cn --argjson disabled "$disabled_tools_json" '$disabled + ["read_document"] | unique'
    elif [ "$server_id" = "google_workspace" ]; then
        # PORTICO-246: the embedded start_google_auth launcher derives
        # http://0.0.0.0:8080/oauth2callback from WORKSPACE_MCP_BASE_URI and
        # sends no PKCE, so Google rejects it; and this container publishes no
        # host port, so no redirect it can derive is reachable. Authorization
        # must use the app's own loopback callback instead. Mirrors the
        # generator default in mcp-orc so both paths agree.
        jq -cn --argjson disabled "$disabled_tools_json" '$disabled + ["start_google_auth"] | unique'
    else
        echo "$disabled_tools_json"
    fi
}

remove_single_server_config_path() {
    local config_path="$1"
    if [ -d "$config_path" ]; then
        rm -rf -- "$config_path"
    else
        rm -f -- "$config_path"
    fi
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --stop)
            ACTION="stop"
            shift
            ;;
        --status)
            ACTION="status"
            shift
            ;;
        --logs)
            ACTION="logs"
            shift
            ;;
        --callback-port)
            CALLBACK_HOST_PORT="$2"
            shift 2
            ;;
        --host-port)
            HOST_PORT="$2"
            shift 2
            ;;
        --build)
            FORCE_BUILD=true
            shift
            ;;
        --oauth-bootstrap)
            OAUTH_BOOTSTRAP=true
            shift
            ;;
        --help|-h)
            usage
            ;;
        *)
            if [ -z "$SERVER_ID" ]; then
                SERVER_ID="$1"
            fi
            shift
            ;;
    esac
done

# Validate server ID
if [ -z "$SERVER_ID" ]; then
    echo "Error: Server ID is required"
    usage
fi

case "$CALLBACK_HOST_PORT" in
    3834|3836)
        ;;
    *)
        echo "Error: --callback-port must be 3834 or 3836 (got $CALLBACK_HOST_PORT)"
        exit 1
        ;;
esac

# Source directories for server configs
MCP_CONFIGS_DIR="$PROJECT_ROOT/mcp-configs"
MCP_CONFIGS_USER_DIR="$PROJECT_ROOT/mcp-configs-user"

# Find server configuration
find_server_config() {
    local server_id="$1"

    # Check system configs first
    if [ -d "$MCP_CONFIGS_DIR/$server_id" ]; then
        echo "$MCP_CONFIGS_DIR/$server_id"
        return 0
    fi

    # Check user configs
    if [ -d "$MCP_CONFIGS_USER_DIR/$server_id" ]; then
        echo "$MCP_CONFIGS_USER_DIR/$server_id"
        return 0
    fi

    return 1
}

inspect_server_metadata() {
    local yaml_file="$1"
    run_mcp_orc_generator "$PROJECT_ROOT" inspect-server-metadata --yaml "$yaml_file"
}

extract_required_env_vars() {
    local yaml_file="$1"
    local metadata_json="${2:-}"
    [ -n "$metadata_json" ] || metadata_json="$(inspect_server_metadata "$yaml_file")"
    jq -r '.required_env_vars[].name' <<< "$metadata_json"
}

extract_required_env_vars_with_sensitivity() {
    local yaml_file="$1"
    local metadata_json="${2:-}"
    [ -n "$metadata_json" ] || metadata_json="$(inspect_server_metadata "$yaml_file")"
    jq -r '.required_env_vars[] | [.name, (.sensitive | tostring)] | @tsv' <<< "$metadata_json"
}

extract_sensitive_required_env_vars() {
    local yaml_file="$1"
    local metadata_json="${2:-}"
    extract_required_env_vars_with_sensitivity "$yaml_file" "$metadata_json" | awk -F '\t' '$2 == "true" { print $1 }'
}

extract_preset_env_vars() {
    local yaml_file="$1"
    local metadata_json="${2:-}"
    [ -n "$metadata_json" ] || metadata_json="$(inspect_server_metadata "$yaml_file")"
    jq -r '.preset_env_vars[] | [.name, .value] | @tsv' <<< "$metadata_json"
}

is_yaml_required_env_var_sensitive() {
    local yaml_file="$1"
    local env_var_name="$2"
    local metadata_json="${3:-}"
    extract_required_env_vars_with_sensitivity "$yaml_file" "$metadata_json" | awk -F '\t' -v name="$env_var_name" '$1 == name && $2 == "true" { found = 1 } END { exit(found ? 0 : 1) }'
}

docker_secret_name_for_env_var() {
    printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/_/g; s/^_*//; s/_*$//'
}

STATIC_SECRET_TMPFS_DIR="/dev/shm/portico-runtime-secrets"
STATIC_SECRET_BROKER_DEFAULT_URL="http://host.docker.internal:8891/secrets/static-secret"
OAUTH_ACCESS_TOKEN_BROKER_DEFAULT_URL="http://host.docker.internal:8891/secrets/oauth/access-token"

static_secret_file_target() {
    local secret_name="$1"
    printf '%s/%s\n' "$STATIC_SECRET_TMPFS_DIR" "$secret_name"
}

static_secret_token_env_var() {
    local server_id="$1"
    local secret_name="$2"
    printf 'portico_STATIC_SECRET_TOKEN_%s_%s\n' \
        "$(runtime_file_slug "$server_id" "server" | tr '[:lower:]' '[:upper:]')" \
        "$(runtime_file_slug "$secret_name" "secret" | tr '[:lower:]' '[:upper:]')"
}

oauth_access_token_token_env_var() {
    local server_id="$1"
    printf 'portico_OAUTH_ACCESS_TOKEN_TOKEN_%s\n' \
        "$(runtime_file_slug "$server_id" "server" | tr '[:lower:]' '[:upper:]')"
}

fragment_uses_oauth() {
    local fragment_file="$1"
    [ -f "$fragment_file" ] || return 1
    jq -e 'has("oauth") and .oauth != null' "$fragment_file" >/dev/null 2>&1
}

# Keep this in sync with fragment_supports_native_oauth in the Rust generator.
# Remote transports can discover OAuth from an initialize challenge even when
# their fragment has no explicit oauth block (PORTICO-294).
fragment_supports_native_oauth() {
    local fragment_file="$1"
    [ -f "$fragment_file" ] || return 1
    jq -e '
        ((.type // "")
            | if type == "string" then gsub("^\\s+|\\s+$"; "") else "" end) as $raw_type
        | (if $raw_type == "streamable_http" or $raw_type == "streamablehttp"
            then "streamable-http"
            else $raw_type
            end) as $server_type
        | ($server_type == "streamable-http" or $server_type == "sse")
          or (has("http_subprocess") and .http_subprocess != null)
    ' "$fragment_file" >/dev/null 2>&1
}

yaml_uses_oauth() {
    local yaml_file="$1"
    [ -f "$yaml_file" ] || return 1
    grep -Eq '^oauth:[[:space:]]*($|#|[^[:space:]])' "$yaml_file"
}

get_single_server_runtime_variant() {
    local fragment_file="$1"
    local command=""

    if [ -f "$fragment_file" ]; then
        command=$(jq -r '.command // ""' "$fragment_file" 2>/dev/null)
    fi

    case "$command" in
        __portico_managed_node_package__|npx|node)
            echo "node"
            ;;
        docker)
            echo "docker"
            ;;
        *)
            echo "python"
            ;;
    esac
}

get_single_server_runtime_build_args() {
    local runtime_variant="$1"
    return 0
}

is_source_checkout() {
    if [ -d "$PROJECT_ROOT/.git" ]; then
        return 0
    fi

    if command -v git >/dev/null 2>&1; then
        local git_root=""
        git_root="$(git -C "$PROJECT_ROOT" rev-parse --show-toplevel 2>/dev/null || true)"
        if [ -n "$git_root" ] && [ "$git_root" = "$PROJECT_ROOT" ]; then
            return 0
        fi
    fi

    return 1
}

read_project_build_number() {
    local build_info_file="$PROJECT_ROOT/electron-app/build-info.json"
    if [ -f "$build_info_file" ] && command -v jq >/dev/null 2>&1; then
        jq -r '.buildNumber // empty' "$build_info_file" 2>/dev/null
    fi
}

is_managed_non_dev_runtime() {
    if is_source_checkout; then
        return 1
    fi

    local build_number=""
    build_number="$(read_project_build_number)"
    [ -n "$build_number" ] && [ "$build_number" != "dev-build" ]
}

resolve_shared_mcpo_image() {
    local runtime_variant="${1:-python}"
    local runtime_backend="${2:-python}"
    local shared_mcpo_image=""
    local build_info_file="$PROJECT_ROOT/electron-app/build-info.json"
    local expected_arch
    expected_arch=$(get_host_docker_arch)
    local local_image_candidates=(
        "$(mcp_orc_local_image_name "$runtime_variant" "$runtime_backend")"
        "$(mcp_orc_local_image_name full "$runtime_backend")"
    )

    if [ -f "$build_info_file" ] && command -v jq >/dev/null 2>&1; then
        # PORTICO-371: use the tag the images were pushed under. Beta builds tag ==
        # build number, but MR/broker builds tag mr-<iid>-<sha> (dockerImageTag).
        local image_tag
        image_tag=$(jq -r '.dockerImageTag // empty' "$build_info_file" 2>/dev/null)
        if [ -z "$image_tag" ] || [ "$image_tag" = "dev-build" ]; then
            image_tag=$(jq -r '.buildNumber // empty' "$build_info_file" 2>/dev/null)
        fi
        if [ -n "$image_tag" ] && [ "$image_tag" != "dev-build" ]; then
            local harbor_image_candidates=(
                "$(mcp_orc_harbor_image_name "$runtime_variant" "$image_tag" "$runtime_backend")"
                "$(mcp_orc_harbor_image_name full "$image_tag" "$runtime_backend")"
            )
            for harbor_image in "${harbor_image_candidates[@]}"; do
                if docker image inspect "$harbor_image" >/dev/null 2>&1 && image_matches_host_arch "$harbor_image" "$expected_arch"; then
                    shared_mcpo_image="$harbor_image"
                    break
                fi
            done
        fi
    fi

    if [ -z "$shared_mcpo_image" ] && ! is_managed_non_dev_runtime; then
        for local_image_name in "${local_image_candidates[@]}"; do
            if docker image inspect "$local_image_name" >/dev/null 2>&1 && image_matches_host_arch "$local_image_name" "$expected_arch"; then
                shared_mcpo_image="$local_image_name"
                break
            fi
        done
    fi

    echo "$shared_mcpo_image"
}

is_single_server_core() {
    local yaml_file="$1"
    [ -f "$yaml_file" ] && grep -Eiq '^[[:space:]]*is_core:[[:space:]]*true([[:space:]]|$)' "$yaml_file"
}

resolve_single_server_backend() {
    local yaml_file="$1"
    local scope="regular"

    if is_single_server_core "$yaml_file"; then
        scope="core"
    fi

    mcp_orc_backend_for_scope "$scope" "$MCP_ORC_MODE_RESOLVED"
}

get_host_docker_arch() {
    local host_os
    local host_arch

    host_os=$(uname -s 2>/dev/null || echo "")
    if [ "$host_os" = "Darwin" ] && command -v sysctl >/dev/null 2>&1; then
        local arm64_capability
        arm64_capability=$(sysctl -in hw.optional.arm64 2>/dev/null || echo "")
        if [ "$arm64_capability" = "1" ]; then
            echo "arm64"
            return 0
        fi
    fi

    host_arch=$(uname -m 2>/dev/null || echo "")

    case "$host_arch" in
        arm64|aarch64)
            echo "arm64"
            ;;
        x86_64|amd64)
            echo "amd64"
            ;;
        *)
            echo "$host_arch"
            ;;
    esac
}

image_matches_host_arch() {
    local image_ref="$1"
    local expected_arch="${2:-$(get_host_docker_arch)}"
    local image_arch=""

    image_arch=$(docker image inspect --format '{{.Architecture}}' "$image_ref" 2>/dev/null | head -n 1)
    if [ -z "$image_arch" ]; then
        return 1
    fi

    if [ "$image_arch" != "$expected_arch" ]; then
        echo "Skipping $image_ref due to architecture mismatch: image=$image_arch, host=$expected_arch" >&2
        return 1
    fi

    return 0
}

list_layer_cleanup_helper_images() {
    local preferred_images=(
        "portico-health-check:latest"
        "harbor.example.invalid/portico/health-check:latest"
        "busybox:latest"
        "alpine:latest"
        "alpine:3.20"
    )

    for image in "${preferred_images[@]}"; do
        if docker image inspect "$image" >/dev/null 2>&1; then
            echo "$image"
        fi
    done

    docker image ls --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -v '<none>' | head -n 10
}

remove_layerdb_paths_with_helper() {
    local layer_paths="$1"
    local removal_script="set -e;"

    while IFS= read -r layer_path; do
        [ -z "$layer_path" ] && continue
        removal_script="$removal_script rm -rf '$layer_path';"
    done <<< "$layer_paths"

    local helper_image=""
    while IFS= read -r candidate; do
        [ -z "$candidate" ] && continue
        helper_image="$candidate"
        if docker run --rm --privileged -v /var/lib/docker:/var/lib/docker --entrypoint sh "$helper_image" -lc "$removal_script" >/dev/null 2>&1; then
            echo "Removed conflicting layerdb entries using helper image: $helper_image" >&2
            return 0
        fi
    done < <(list_layer_cleanup_helper_images)

    if [ -n "$helper_image" ]; then
        echo "Failed to remove layerdb entries using helper image: $helper_image" >&2
    else
        echo "No local helper image available for layerdb cleanup" >&2
    fi
    return 1
}

cleanup_failed_register_layer_images() {
    local compose_file="$1"
    local project_name="$2"
    local failure_output="$3"
    local attempted_cleanup=false

    echo "Detected 'failed to register layer'. Cleaning up cached image state before retry..." >&2

    local matched_images=()
    while IFS= read -r image; do
        [ -z "$image" ] && continue
        local short_name="${image##*/}"
        short_name="${short_name%%:*}"
        if echo "$failure_output" | grep -qiF "$short_name"; then
            matched_images+=("$image")
        fi
    done < <(run_docker_compose -p "$project_name" -f "$compose_file" config --images 2>/dev/null || true)

    if [ ${#matched_images[@]} -gt 0 ]; then
        attempted_cleanup=true
        for image in "${matched_images[@]}"; do
            echo "Removing potentially-corrupted image: $image" >&2
            docker image rm -f "$image" >/dev/null 2>&1 || true
        done
    fi

    local layerdb_targets=""
    local layerdb_tmp_targets=""
    layerdb_targets=$(echo "$failure_output" | grep -oE '/var/lib/docker/image/overlay2/layerdb/sha256/[a-f0-9]{64}' | sort -u || true)
    layerdb_tmp_targets=$(echo "$failure_output" | grep -oE '/var/lib/docker/image/overlay2/layerdb/tmp/write-set-[0-9]+' | sort -u || true)
    local layerdb_paths
    layerdb_paths=$(printf '%s\n%s\n' "$layerdb_targets" "$layerdb_tmp_targets" | sed '/^$/d' | sort -u || true)
    if [ -n "$layerdb_paths" ]; then
        attempted_cleanup=true
        echo "Removing stale layerdb entries from failed layer registration..." >&2
        remove_layerdb_paths_with_helper "$layerdb_paths" || true
    fi

    local layer_refs
    layer_refs=$(echo "$failure_output" | grep -oE 'sha256:[a-f0-9]{64}' | sort -u || true)
    if [ -n "$layer_refs" ] && [ -z "$layerdb_paths" ]; then
        attempted_cleanup=true
        while IFS= read -r layer_ref; do
            [ -z "$layer_ref" ] && continue
            echo "Removing corrupted layer reference: $layer_ref" >&2
            docker image rm -f "$layer_ref" >/dev/null 2>&1 || true
        done <<< "$layer_refs"
    fi

    if [ "$attempted_cleanup" = false ]; then
        echo "Could not identify a specific image from output; pruning dangling images." >&2
    fi

    docker builder prune -f >/dev/null 2>&1 || true
    docker image prune -f >/dev/null 2>&1 || true
}

run_single_compose_up_with_retry() {
    local project_name="$1"
    local compose_file="$2"
    local build_args="$3"
    local max_attempts=3
    local attempt=1
    local compose_output=""
    local compose_exit_code=1

    while [ "$attempt" -le "$max_attempts" ]; do
        echo "Starting docker compose (attempt ${attempt}/${max_attempts})..."

        compose_output=""
        if compose_output=$(run_docker_compose -p "$project_name" -f "$compose_file" up -d $build_args 2>&1); then
            if [ -n "$compose_output" ]; then
                echo "$compose_output"
            fi
            return 0
        else
            compose_exit_code=$?
        fi

        if [ -n "$compose_output" ]; then
            echo "$compose_output" >&2
        fi

        if docker_compose_output_indicates_unavailable "$compose_output"; then
            return "$compose_exit_code"
        fi

        if echo "$compose_output" | grep -qi "failed to register layer"; then
            cleanup_failed_register_layer_images "$compose_file" "$project_name" "$compose_output"
        fi

        if [ "$attempt" -ge "$max_attempts" ]; then
            echo "Docker compose failed after ${max_attempts} attempts (exit code: ${compose_exit_code})" >&2
            return "$compose_exit_code"
        fi

        local wait_time=$((attempt * 5))
        echo "Attempt ${attempt} failed, retrying in ${wait_time}s..."
        sleep "$wait_time"
        attempt=$((attempt + 1))
    done

    return 1
}

get_tool_rename_mapping() {
    local yaml_file="$1"
    local metadata_json="${2:-}"
    if [ ! -f "$yaml_file" ]; then
        return 0
    fi
    [ -n "$metadata_json" ] || metadata_json="$(inspect_server_metadata "$yaml_file")"
    jq -c '.tool_rename_mapping // empty' <<< "$metadata_json"
}

get_image_platform() {
    local yaml_file="$1"
    local metadata_json="${2:-}"
    if [ ! -f "$yaml_file" ]; then
        return 0
    fi

    [ -n "$metadata_json" ] || metadata_json="$(inspect_server_metadata "$yaml_file")"
    jq -r '.image_platform // empty' <<< "$metadata_json"
}

resolve_python3() {
    local candidate=""
    local resolved_path=""

    for candidate in /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
        if [ -x "$candidate" ] && "$candidate" --version >/dev/null 2>&1; then
            echo "$candidate"
            return 0
        fi
    done

    if command -v python3 >/dev/null 2>&1; then
        resolved_path="$(command -v python3)"
        if [ -n "$resolved_path" ] \
            && [ -x "$resolved_path" ] \
            && "$resolved_path" --version >/dev/null 2>&1; then
            echo "$resolved_path"
            return 0
        fi
    fi

    return 1
}

render_runtime_file_mounts_with_node() {
    local yaml_file="$1"

    YAML_FILE="$yaml_file" PROJECT_ROOT="$PROJECT_ROOT" node <<'NODE'
const fs = require("fs");
const os = require("os");
const path = require("path");

const yamlFile = process.env.YAML_FILE;
const projectRoot = process.env.PROJECT_ROOT || process.cwd();

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quote) {
      if (char === quote && line[i - 1] !== "\\") {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseScalar(value) {
  const trimmed = stripComment(value).trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function splitKeyValue(value) {
  const match = value.match(/^([^:]+):(?:\s*(.*))?$/);
  if (!match) {
    return null;
  }
  return [parseScalar(match[1]), parseScalar(match[2] || "")];
}

function parseRuntimeFiles(raw) {
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = stripComment(lines[i]).replace(/\s+$/, "");
    if (!line.trim()) {
      continue;
    }
    const rootMatch = line.match(/^runtime_files:(?:\s*(.*))?$/);
    if (!rootMatch) {
      continue;
    }

    const inlineValue = parseScalar(rootMatch[1] || "");
    if (!inlineValue || inlineValue === "null" || inlineValue === "~" || inlineValue === "[]") {
      if (inlineValue === "[]") {
        return [];
      }
    } else {
      fail("runtime_files must be a list");
    }

    const entries = [];
    let current = null;
    let sawIndentedContent = false;
    for (i += 1; i < lines.length; i += 1) {
      const child = stripComment(lines[i]).replace(/\s+$/, "");
      if (!child.trim()) {
        continue;
      }
      if (/^\S/.test(child) && !child.trim().startsWith("-")) {
        i -= 1;
        break;
      }

      sawIndentedContent = true;
      const trimmed = child.trim();
      if (trimmed.startsWith("-")) {
        const item = trimmed.slice(1).trim();
        if (!item) {
          current = {};
          entries.push(current);
          continue;
        }
        const pair = splitKeyValue(item);
        if (!pair) {
          entries.push(null);
          current = null;
          continue;
        }
        current = {};
        current[pair[0]] = pair[1];
        entries.push(current);
        continue;
      }

      if (current == null) {
        fail("runtime_files must be a list");
      }
      const pair = splitKeyValue(trimmed);
      if (pair) {
        current[pair[0]] = pair[1];
      }
    }

    if (sawIndentedContent) {
      return entries;
    }
    return [];
  }
  return null;
}

let runtimeFiles;
try {
  runtimeFiles = parseRuntimeFiles(fs.readFileSync(yamlFile, "utf8"));
} catch (error) {
  if (error && error.message && error.message.startsWith("runtime_files ")) {
    fail(error.message);
  }
  fail(`failed to parse ${yamlFile}: ${error.message}`);
}

if (runtimeFiles == null) {
  process.exit(0);
}

function expandSource(source) {
  if (typeof source !== "string" || source.trim() === "") {
    fail("runtime_files entries must include a non-empty source");
  }

  const raw = source.trim();
  if (raw === "~") {
    return os.homedir();
  }
  if (raw.startsWith("~/")) {
    return path.join(os.homedir(), raw.slice(2));
  }
  if (raw.startsWith("~")) {
    fail(`runtime_files source '${source}' uses unsupported '~user' expansion`);
  }
  if (path.isAbsolute(raw)) {
    return raw;
  }
  return path.resolve(projectRoot, raw);
}

function assertSimpleFilename(filename) {
  if (
    typeof filename !== "string" ||
    filename.trim() === "" ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename === "." ||
    filename === ".."
  ) {
    fail(`invalid runtime_files filename '${filename}'`);
  }
}

function validateTarget(target) {
  if (typeof target !== "string" || target.trim() === "") {
    fail("runtime_files target must be a non-empty absolute container path");
  }
  const normalized = target.trim();
  if (!normalized.startsWith("/")) {
    fail(`runtime_files target '${target}' must be an absolute container path`);
  }
  if (normalized.includes("\\") || normalized.includes(":")) {
    fail(`invalid runtime_files target '${target}'`);
  }
  if (normalized.endsWith("/")) {
    fail(`runtime_files target '${target}' must include a filename`);
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0 || parts.includes("..")) {
    fail(`invalid runtime_files target '${target}'`);
  }
  const basename = parts[parts.length - 1];
  if (!basename || basename === "." || basename === "..") {
    fail(`runtime_files target '${target}' must include a filename`);
  }
  return normalized;
}

const seenTargets = new Set();
const mountLines = [];

for (const [index, entry] of runtimeFiles.entries()) {
  if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
    fail(`runtime_files entry ${index + 1} must be a mapping`);
  }

  const source = entry.source;
  const sourcePath = expandSource(source);

  const hasTarget = Object.prototype.hasOwnProperty.call(entry, "target") && entry.target != null && `${entry.target}`.trim() !== "";
  const hasFilename = Object.prototype.hasOwnProperty.call(entry, "filename") && entry.filename != null && `${entry.filename}`.trim() !== "";
  const hasSensitive = Object.prototype.hasOwnProperty.call(entry, "sensitive") && entry.sensitive != null && `${entry.sensitive}`.trim() !== "";
  let sensitive = false;
  if (hasSensitive) {
    const normalizedSensitive = `${entry.sensitive}`.trim().toLowerCase();
    if (normalizedSensitive !== "true" && normalizedSensitive !== "false") {
      fail("runtime_files sensitive must be true or false");
    }
    sensitive = normalizedSensitive === "true";
  }
  if (hasTarget && hasFilename) {
    fail("runtime_files entries cannot specify both target and filename");
  }

  let target;
  if (hasTarget) {
    target = validateTarget(`${entry.target}`);
  } else {
    const filename = hasFilename ? `${entry.filename}`.trim() : path.basename(sourcePath);
    assertSimpleFilename(filename);
    target = `/app/runtime/${filename}`;
  }

  if (seenTargets.has(target)) {
    fail(`duplicate runtime_files target '${target}'`);
  }
  seenTargets.add(target);

  if (sensitive) {
    continue;
  }

  let canonicalSource;
  try {
    canonicalSource = fs.realpathSync(sourcePath);
  } catch (error) {
    fail(`runtime_files source '${source}' does not resolve to an existing file: ${error.message}`);
  }

  let stat;
  try {
    stat = fs.statSync(canonicalSource);
  } catch (error) {
    fail(`runtime_files source '${source}' does not resolve to an existing file: ${error.message}`);
  }
  if (!stat.isFile()) {
    fail(`runtime_files source '${source}' must be a regular file`);
  }

  mountLines.push(`      - ${JSON.stringify(`${canonicalSource}:${target}:ro`)}`);
}

process.stdout.write(mountLines.join("\n"));
NODE
}

render_runtime_file_mounts_with_python() {
    local python3_bin="$1"
    local yaml_file="$2"

    "$python3_bin" - "$PROJECT_ROOT" "$yaml_file" <<'PY'
import json
import sys
from pathlib import Path

project_root = Path(sys.argv[1])
yaml_path = Path(sys.argv[2])


def fail(message):
    print(f"Error: {message}", file=sys.stderr)
    raise SystemExit(1)


def strip_comment(line):
    quote = None
    for index, char in enumerate(line):
        if quote:
            if char == quote and line[index - 1] != "\\":
                quote = None
            continue
        if char in ("'", '"'):
            quote = char
            continue
        if char == "#" and (index == 0 or line[index - 1].isspace()):
            return line[:index]
    return line


def parse_scalar(value):
    trimmed = strip_comment(value).strip()
    if (
        (trimmed.startswith('"') and trimmed.endswith('"'))
        or (trimmed.startswith("'") and trimmed.endswith("'"))
    ):
        return trimmed[1:-1]
    return trimmed


def split_key_value(value):
    if ":" not in value:
        return None
    key, _, rest = value.partition(":")
    return parse_scalar(key), parse_scalar(rest)


def parse_runtime_files(raw):
    lines = raw.splitlines()
    for index, raw_line in enumerate(lines):
        line = strip_comment(raw_line).rstrip()
        if not line.strip():
            continue
        if not line.startswith("runtime_files:"):
            continue

        inline_value = parse_scalar(line[len("runtime_files:"):])
        if inline_value and inline_value not in ("null", "~", "[]"):
            fail("runtime_files must be a list")
        if inline_value == "[]":
            return []

        entries = []
        current = None
        saw_indented_content = False
        for child_raw in lines[index + 1:]:
            child = strip_comment(child_raw).rstrip()
            if not child.strip():
                continue
            if child[:1] not in (" ", "\t") and not child.lstrip().startswith("-"):
                break

            saw_indented_content = True
            trimmed = child.strip()
            if trimmed.startswith("-"):
                item = trimmed[1:].strip()
                if not item:
                    current = {}
                    entries.append(current)
                    continue
                pair = split_key_value(item)
                if not pair:
                    entries.append(None)
                    current = None
                    continue
                current = {pair[0]: pair[1]}
                entries.append(current)
                continue

            if current is None:
                fail("runtime_files must be a list")
            pair = split_key_value(trimmed)
            if pair:
                current[pair[0]] = pair[1]

        return entries if saw_indented_content else []
    return None


try:
    runtime_files = parse_runtime_files(yaml_path.read_text(encoding="utf-8"))
except (OSError, UnicodeError) as error:
    fail(f"failed to parse {yaml_path}: {error}")

if runtime_files is None:
    raise SystemExit(0)


def expand_source(source):
    if not isinstance(source, str) or not source.strip():
        fail("runtime_files entries must include a non-empty source")

    raw = source.strip()
    if raw == "~":
        return Path.home()
    if raw.startswith("~/"):
        return Path.home() / raw[2:]
    if raw.startswith("~"):
        fail(f"runtime_files source '{source}' uses unsupported '~user' expansion")
    source_path = Path(raw)
    if source_path.is_absolute():
        return source_path
    return (project_root / source_path).resolve()


def assert_simple_filename(filename):
    if (
        not isinstance(filename, str)
        or not filename.strip()
        or "/" in filename
        or "\\" in filename
        or filename in (".", "..")
    ):
        fail(f"invalid runtime_files filename '{filename}'")


def validate_target(target):
    if not isinstance(target, str) or not target.strip():
        fail("runtime_files target must be a non-empty absolute container path")
    normalized = target.strip()
    if not normalized.startswith("/"):
        fail(f"runtime_files target '{target}' must be an absolute container path")
    if "\\" in normalized or ":" in normalized:
        fail(f"invalid runtime_files target '{target}'")
    if normalized.endswith("/"):
        fail(f"runtime_files target '{target}' must include a filename")
    parts = [part for part in normalized.split("/") if part]
    if not parts or ".." in parts:
        fail(f"invalid runtime_files target '{target}'")
    basename = parts[-1]
    if not basename or basename in (".", ".."):
        fail(f"runtime_files target '{target}' must include a filename")
    return normalized


seen_targets = set()
mount_lines = []

for index, entry in enumerate(runtime_files):
    if entry is None or not isinstance(entry, dict):
        fail(f"runtime_files entry {index + 1} must be a mapping")

    source = entry.get("source")
    source_path = expand_source(source)

    has_target = (
        "target" in entry
        and entry["target"] is not None
        and str(entry["target"]).strip()
    )
    has_filename = (
        "filename" in entry
        and entry["filename"] is not None
        and str(entry["filename"]).strip()
    )
    has_sensitive = (
        "sensitive" in entry
        and entry["sensitive"] is not None
        and str(entry["sensitive"]).strip()
    )
    sensitive = False
    if has_sensitive:
        normalized_sensitive = str(entry["sensitive"]).strip().lower()
        if normalized_sensitive not in ("true", "false"):
            fail("runtime_files sensitive must be true or false")
        sensitive = normalized_sensitive == "true"
    if has_target and has_filename:
        fail("runtime_files entries cannot specify both target and filename")

    if has_target:
        target = validate_target(str(entry["target"]))
    else:
        filename = str(entry["filename"]).strip() if has_filename else source_path.name
        assert_simple_filename(filename)
        target = f"/app/runtime/{filename}"

    if target in seen_targets:
        fail(f"duplicate runtime_files target '{target}'")
    seen_targets.add(target)

    if sensitive:
        continue

    try:
        canonical_source = source_path.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        fail(
            f"runtime_files source '{source}' does not resolve to an existing file: {error}"
        )

    if not canonical_source.is_file():
        fail(f"runtime_files source '{source}' must be a regular file")

    mount = f"{canonical_source}:{target}:ro"
    mount_lines.append(f"      - {json.dumps(mount, ensure_ascii=False)}")

sys.stdout.write("\n".join(mount_lines))
PY
}

render_runtime_file_mounts() {
    local yaml_file="$1"
    if [ ! -f "$yaml_file" ]; then
        return 0
    fi
    if ! grep -q '^[[:space:]]*runtime_files[[:space:]]*:' "$yaml_file" 2>/dev/null; then
        return 0
    fi

    local node_available="false"
    local node_error_file=""
    local node_output=""
    local node_status=127
    if command -v node >/dev/null 2>&1; then
        node_available="true"
        node_error_file="$(mktemp "${TMPDIR:-/tmp}/portico-runtime-files-node.XXXXXX")"
        if node_output="$(render_runtime_file_mounts_with_node "$yaml_file" 2>"$node_error_file")"; then
            printf '%s' "$node_output"
            rm -f "$node_error_file"
            return 0
        else
            node_status=$?
        fi
    fi

    local python3_bin=""
    python3_bin="$(resolve_python3 || true)"
    if [ -n "$python3_bin" ]; then
        local python_error_file=""
        local python_output=""
        local python_status=1
        python_error_file="$(mktemp "${TMPDIR:-/tmp}/portico-runtime-files-python.XXXXXX")"
        if python_output="$(render_runtime_file_mounts_with_python "$python3_bin" "$yaml_file" 2>"$python_error_file")"; then
            printf '%s' "$python_output"
            rm -f "$node_error_file" "$python_error_file"
            return 0
        else
            python_status=$?
        fi

        cat "$python_error_file" >&2
        rm -f "$node_error_file" "$python_error_file"
        return "$python_status"
    fi

    if [ "$node_available" = "true" ]; then
        if [ -s "$node_error_file" ]; then
            cat "$node_error_file" >&2
        else
            echo "Error: runtime_files Node parser failed with exit code $node_status and python3 is unavailable" >&2
        fi
    else
        echo "Error: cannot parse runtime_files because node and python3 are unavailable" >&2
    fi
    rm -f "$node_error_file"
    return 1
}

# Generate minimal compose file for single server
generate_compose_file() {
    local server_id="$1"
    local server_dir="$2"
    local shared_mcpo_image="$3"
    local runtime_variant="$4"
    local runtime_backend="$5"
    local fragment_file="$server_dir/$server_id.fragment"
    local yaml_file="$server_dir/$server_id.yaml"
    local container_name="mcpo-single-$server_id"

    # NOTE: We don't expose the MCP server's internal port (e.g., WORKSPACE_MCP_PORT=8080)
    # to the host. MCPO communicates with the MCP server over the internal Docker network.
    # Exposing it caused port conflicts (e.g., OrbStack uses 8080).
    local oauth_ports=""
    # Generate config file for the server
    local config_output="$PROJECT_ROOT/mcpo-configs-generated/single-$server_id.json"
    mkdir -p "$PROJECT_ROOT/mcpo-configs-generated"
    if [ -d "$config_output" ]; then
        echo "Removing invalid directory at single-server config path: $config_output"
        remove_single_server_config_path "$config_output"
    fi

    # Get disabled_tools if any
    local tools_config="$PROJECT_ROOT/mcp_tools_config.json"
    local disabled_tools="[]"
    if [ -f "$tools_config" ] && jq -e ".\"$server_id\".disabled_tools" "$tools_config" >/dev/null 2>&1; then
        disabled_tools=$(jq -c ".\"$server_id\".disabled_tools" "$tools_config")
    fi
    disabled_tools="$(merge_default_disabled_tools "$server_id" "$disabled_tools")"
    local server_metadata_json="{}"
    if [ -f "$yaml_file" ]; then
        server_metadata_json="$(inspect_server_metadata "$yaml_file")"
    fi
    local tool_rename_mapping=""
    tool_rename_mapping=$(get_tool_rename_mapping "$yaml_file" "$server_metadata_json")
    local image_platform=""
    image_platform=$(get_image_platform "$yaml_file" "$server_metadata_json")
    local runtime_file_mounts=""
    runtime_file_mounts=$(render_runtime_file_mounts "$yaml_file")
    local fragment_expr='$fragment[0]'
    local jq_args=()
    if [ -n "$image_platform" ]; then
        fragment_expr="(${fragment_expr} | if .command == \"docker\" and (.args | type == \"array\") and (.args[0] == \"run\") and ((.args | index(\"--platform\")) == null) and (((.args | map(select(type == \"string\" and startswith(\"--platform=\")))) | length) == 0) then .args = ([.args[0], \"--platform\", \$image_platform] + .args[1:]) else . end)"
        jq_args+=(--arg image_platform "$image_platform")
    fi

    # Generate config JSON
    local extras="{}"
    local sensitive_env_json="[]"
    if [ -f "$yaml_file" ]; then
        sensitive_env_json="$(extract_sensitive_required_env_vars "$yaml_file" "$server_metadata_json" | jq -R -s -c 'split("\n") | map(select(length > 0))')"
    fi
    if [ "$disabled_tools" != "[]" ]; then
        extras=$(jq -n --argjson disabled "$disabled_tools" '{disabled_tools: $disabled}')
    fi
    if [ -n "$tool_rename_mapping" ]; then
        extras=$(jq -n --argjson extras "$extras" --argjson tool_rename_mapping "$tool_rename_mapping" \
            '$extras + {tool_rename_mapping: $tool_rename_mapping}')
    fi
    if [ "$sensitive_env_json" != "[]" ]; then
        extras=$(jq -n --argjson extras "$extras" --argjson sensitive_env_vars "$sensitive_env_json" \
            '$extras + {sensitive_env_vars: $sensitive_env_vars}')
    fi

    jq -n \
        --arg id "$server_id" \
        --argjson callback_port "$CALLBACK_HOST_PORT" \
        --slurpfile fragment "$fragment_file" \
        "${jq_args[@]}" \
        --argjson extras "$extras" \
        "{
          mcpServers: {
            (\$id): (
              ((${fragment_expr}) + \$extras)
              | if has(\"oauth\") and (.oauth | type == \"object\")
                then .oauth = (
                  (.oauth + {callback_port: \$callback_port})
                  | .client_metadata = (
                      (.client_metadata // {})
                      + {
                          # Preserve explicit redirect_uris when a provider
                          # requires them. Otherwise use native-app HTTP
                          # loopback callbacks for the single-stack and
                          # main-stack ports.
                          redirect_uris: (
                            if (.client_metadata.redirect_uris // [] | length) > 0
                            then .client_metadata.redirect_uris
                            else
                              ([\"http://localhost:\(\$callback_port)/callback\", \"http://localhost:3834/callback\"]
                                | reduce .[] as \$uri ([]; if index(\$uri) == null then . + [\$uri] else . end))
                            end
                          )
                        }
                    )
                )
                else .
                end
            )
          }
        }" > "$config_output"

    # Get environment variables from fragment
    local env_vars=""
    if [ -f "$fragment_file" ]; then
        local fragment_env_pairs=$(jq -r '.env // {} | to_entries[] | "\(.key)=\(.value)"' "$fragment_file" 2>/dev/null)
        while IFS= read -r env_pair; do
            if [ -n "$env_pair" ]; then
                local env_name="${env_pair%%=*}"
                if jq -e --arg env_name "$env_name" 'index($env_name) != null' <<< "$sensitive_env_json" >/dev/null; then
                    continue
                fi
                env_vars="$env_vars      - $env_pair\n"
            fi
        done <<< "$fragment_env_pairs"
    fi

    # Get required_env_vars from YAML and add them as shell variable references
    # These will be expanded when docker compose runs (after sourcing .env)
    if [ -f "$yaml_file" ]; then
        # Extract variable names from required_env_vars section only.
        local required_vars=$(extract_required_env_vars "$yaml_file" "$server_metadata_json" | head -20)
        while IFS= read -r var_name; do
            var_name=$(echo "$var_name" | tr -d '[:space:]')
            if [ -n "$var_name" ]; then
                if is_yaml_required_env_var_sensitive "$yaml_file" "$var_name" "$server_metadata_json"; then
                    if [ "$OAUTH_BOOTSTRAP" = "true" ]; then
                        # Bootstrap mode: the user has not yet entered this
                        # credential (that wizard step comes after OAuth).
                        # Omit the var entirely so no stale host-side value
                        # leaks into the container as plaintext. envsubst
                        # inside the container resolves the missing var to
                        # empty, which is fine for the OAuth handshake.
                        :
                    else
                        local secret_name
                        secret_name="$(docker_secret_name_for_env_var "$var_name")"
                        env_vars="$env_vars      - ${var_name}_FILE=$(static_secret_file_target "$secret_name")\n"
                    fi
                else
                    # Add as shell variable reference (will be expanded when docker compose runs)
                    env_vars="$env_vars      - $var_name=\${$var_name}\n"
                fi
            fi
        done <<< "$required_vars"

        local preset_name preset_value
        while IFS=$'\t' read -r preset_name preset_value; do
            [ -n "$preset_name" ] || continue
            if ! echo "$env_vars" | grep -q -- "- $preset_name="; then
                env_vars="$env_vars      - $preset_name=$preset_value\n"
            fi
        done < <(extract_preset_env_vars "$yaml_file" "$server_metadata_json" | head -20)
    fi

    # Check if server needs Docker socket
    local docker_volume=""
    if grep -q '"command":\s*"docker"' "$fragment_file" 2>/dev/null; then
        docker_volume="      - /var/run/docker.sock:/var/run/docker.sock"
    fi

    local mcpo_patch_mounts=""

    local mcpo_image_or_build=""
    if [ -n "$shared_mcpo_image" ]; then
        mcpo_image_or_build="    image: $shared_mcpo_image"
    else
        local runtime_build_args=""
        runtime_build_args="$(get_single_server_runtime_build_args "$runtime_variant")"
        mcpo_image_or_build="    build:
      context: .
      dockerfile: $(mcp_orc_runtime_dockerfile "$runtime_backend")"
        if [ -n "$runtime_build_args" ]; then
            mcpo_image_or_build="$mcpo_image_or_build
$runtime_build_args"
        fi
    fi

    local single_server_read_timeout="300s"
    case "$server_id" in
        # data-plat-mcp sync queries commonly use maxWait=600; keep 10% headroom.
        # The longer read hold is acceptable here because data-plat-mcp is low-volume.
        data-plat-mcp)
            single_server_read_timeout="660s"
            ;;
    esac

    # Generate nginx config. Self-heal first: a Docker bind-mount race can
    # leave a directory at the bind-mounted $NGINX_CONF path (PORTICO-202).
    if [ -d "$NGINX_CONF" ]; then
        echo "Removing invalid directory at single-server nginx conf path: $NGINX_CONF"
        remove_single_server_config_path "$NGINX_CONF"
    fi
    cat > "$NGINX_CONF" << NGINX_EOF
events {
    worker_connections 1024;
}

http {
    upstream single_server {
        server $container_name:8000;
    }

    server {
        listen 80;

        location /openapi.json {
            proxy_pass http://single_server/$server_id/openapi.json;
            proxy_http_version 1.1;
            proxy_set_header Host \$host;
        }

        location /health {
            return 200 'healthy';
            add_header Content-Type text/plain;
        }

        location /servers/ {
            proxy_pass http://single_server/servers/;
            proxy_http_version 1.1;
            proxy_set_header Host \$host;
            proxy_set_header X-Real-IP \$remote_addr;
        }

        # OAuth endpoints (at root level in MCPO)
        location /oauth/ {
            proxy_pass http://single_server/oauth/;
            proxy_http_version 1.1;
            proxy_set_header Host \$host;
            proxy_set_header X-Real-IP \$remote_addr;
            proxy_read_timeout 300s;
        }

        location /$server_id/ {
            proxy_pass http://single_server/$server_id/;
            proxy_http_version 1.1;
            proxy_set_header Host \$host;
            proxy_set_header X-Real-IP \$remote_addr;
            proxy_read_timeout $single_server_read_timeout;
        }

        location / {
            return 404 'Server not found';
            add_header Content-Type text/plain;
        }
    }

    # OAuth callback server (HTTP)
    # Nginx owns the public callback listener and forwards into the runtime's
    # /oauth/callback handler on port 8000.
    server {
        listen 3834;

        location /callback {
            proxy_pass http://single_server/oauth/callback;
            proxy_http_version 1.1;
            proxy_set_header Host \$host;
            proxy_set_header X-Real-IP \$remote_addr;
            proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto \$scheme;
            proxy_connect_timeout 10s;
            proxy_read_timeout 30s;
        }

        location / {
            return 404 'OAuth callback only';
            add_header Content-Type text/plain;
        }
    }

}
NGINX_EOF

    local static_secret_targets=""
    local static_secret_env_lines=""
    local static_secret_separator=""
    local static_secret_tmpfs_block=""
    if [ -f "$yaml_file" ]; then
        local sensitive_required_var secret_name token_env target_path
        # In OAuth bootstrap mode the user has not yet had a chance to enter
        # sensitive env var credentials (that wizard step comes *after* OAuth),
        # and the OAuth handshake itself does not need them. Skip injection so
        # the container entrypoint does not FATAL on an unavailable secret.
        if [ "$OAUTH_BOOTSTRAP" != "true" ]; then
            while IFS= read -r sensitive_required_var; do
                sensitive_required_var="$(printf '%s' "$sensitive_required_var" | tr -d '[:space:]')"
                [ -n "$sensitive_required_var" ] || continue
                secret_name="$(docker_secret_name_for_env_var "$sensitive_required_var")"
                token_env="$(static_secret_token_env_var "$server_id" "$secret_name")"
                target_path="$(static_secret_file_target "$secret_name")"
                static_secret_targets="${static_secret_targets}${static_secret_separator}${server_id}|${secret_name}|${target_path}|${token_env}|"
                static_secret_separator=";"
                static_secret_env_lines="${static_secret_env_lines}      - ${token_env}=\${${token_env}:-}
"
            done < <(extract_sensitive_required_env_vars "$yaml_file" "$server_metadata_json" | head -20)
        fi

        local runtime_file_secret runtime_file_server runtime_file_target runtime_file_source runtime_file_env
        while IFS=$'\t' read -r runtime_file_secret runtime_file_server runtime_file_target runtime_file_source; do
            [ -n "$runtime_file_secret" ] || continue
            [ "$runtime_file_server" = "$server_id" ] || continue
            token_env="$(static_secret_token_env_var "$server_id" "$runtime_file_secret")"
            target_path="$(static_secret_file_target "$runtime_file_secret")"
            runtime_file_env="$(sensitive_runtime_file_secret_env_var "$runtime_file_secret")"
            export "$runtime_file_env=$target_path"
            static_secret_targets="${static_secret_targets}${static_secret_separator}${server_id}|${runtime_file_secret}|${target_path}|${token_env}|${runtime_file_target}"
            static_secret_separator=";"
            static_secret_env_lines="${static_secret_env_lines}      - ${token_env}=\${${token_env}:-}
"
        done < <(discover_sensitive_runtime_files)
    fi

    if [ -n "$static_secret_targets" ]; then
        env_vars="$env_vars      - portico_STATIC_SECRET_BROKER_URL=\${portico_STATIC_SECRET_BROKER_URL:-$STATIC_SECRET_BROKER_DEFAULT_URL}
      - portico_STATIC_SECRET_TARGETS=$static_secret_targets
$static_secret_env_lines"
        static_secret_tmpfs_block="    tmpfs:
      - $STATIC_SECRET_TMPFS_DIR:mode=0700
"
    fi

    if fragment_uses_oauth "$fragment_file" \
        || yaml_uses_oauth "$yaml_file" \
        || fragment_supports_native_oauth "$fragment_file"; then
        if [ "$OAUTH_BOOTSTRAP" = "true" ]; then
            # First-time/interactive OAuth: do NOT inject the access-token broker
            # trio. With broker mode off, the container generates a container-local
            # authorization URL and runs the full handshake itself. Electron then
            # exports the captured record via /oauth/bootstrap-record, guarded by
            # this one-time export bearer.
            if [ -z "${portico_OAUTH_BOOTSTRAP_EXPORT_TOKEN:-}" ]; then
                echo "ERROR: --oauth-bootstrap requires portico_OAUTH_BOOTSTRAP_EXPORT_TOKEN to be set" >&2
                exit 1
            fi
            env_vars="$env_vars      - portico_OAUTH_BOOTSTRAP_EXPORT_TOKEN=\${portico_OAUTH_BOOTSTRAP_EXPORT_TOKEN}
"
        else
            local oauth_token_env
            oauth_token_env="$(oauth_access_token_token_env_var "$server_id")"
            env_vars="$env_vars      - portico_OAUTH_ACCESS_TOKEN_BROKER_URL=\${portico_OAUTH_ACCESS_TOKEN_BROKER_URL:-$OAUTH_ACCESS_TOKEN_BROKER_DEFAULT_URL}
      - portico_OAUTH_ACCESS_TOKEN_SERVER_ID=$server_id
      - portico_OAUTH_ACCESS_TOKEN_BROKER_TOKEN=\${$oauth_token_env:-}
"
        fi
    fi

    # Generate docker-compose file
    # For OAuth-only mode (setup wizard), we don't need the main gateway/Redis.
    # Just nginx + the single MCP server
    cat > "$COMPOSE_FILE" << COMPOSE_EOF
# Auto-generated for single-server OAuth testing
# Server: $server_id

name: portico-single

services:
  # Nginx aggregator for this single-server stack
  mcpo-single-nginx:
    image: nginx:alpine
    container_name: mcpo-single-nginx
    # PORTICO-68 / F6: bind every host-facing port for the single-server
    # OAuth setup wizard to 127.0.0.1 only. The nginx container proxies
    # into the MCP server and brokers the OAuth callback; none of those
    # endpoints should be reachable from off-host interfaces.
    ports:
      - "127.0.0.1:${HOST_PORT}:80"
      - "127.0.0.1:${CALLBACK_HOST_PORT}:3834"
    volumes:
      - $NGINX_CONF:/etc/nginx/nginx.conf:ro
    depends_on:
      - $container_name
    networks:
      - single-server
    restart: unless-stopped

  # Single MCP server container
  $container_name:
$mcpo_image_or_build
    container_name: $container_name
    expose:
      - "8000"
$([ -n "$oauth_ports" ] && echo "    ports:
$oauth_ports")
    volumes:
      - $config_output:/app/mcp_config.json:ro
      - ./open-webui-data/managed-node-mcp-packages:/app/open-webui-data/managed-node-mcp-packages:ro
$runtime_file_mounts
$mcpo_patch_mounts
$([ -n "$docker_volume" ] && echo "$docker_volume")
    environment:
      - TZ=\${TZ:-UTC}
      - CONFIG_FILE=mcp_config.json
      - MCPO_OAUTH_CALLBACK_PORT=${CALLBACK_HOST_PORT}
      - LOG_LEVEL=\${MCPO_LOG_LEVEL:-\${LOG_LEVEL:-INFO}}
      - DEBUG=\${MCP_DEBUG:-}
      - PYTHONUNBUFFERED=1
      - portico_MANAGED_NODE_MCP_PACKAGES_DIR=/app/open-webui-data/managed-node-mcp-packages
$([ -n "$env_vars" ] && echo -e "$env_vars")
$static_secret_tmpfs_block
    extra_hosts:
      - "host.docker.internal:host-gateway"
    networks:
      - single-server
    restart: unless-stopped

networks:
  single-server:
    driver: bridge
COMPOSE_EOF

    echo "Generated $COMPOSE_FILE"
}

# Start the single-server stack
start_server() {
    local server_id="$1"
    require_docker_compose_frontend || exit $?
    local container_name="mcpo-single-$server_id"
    local project_name="portico-single"
    local default_image_name="${project_name}-${container_name}"
    local shared_mcpo_image=""
    local build_args=""
    local strict_managed_runtime=false

    if is_managed_non_dev_runtime; then
        strict_managed_runtime=true
    fi

    echo "Starting minimal Docker stack for: $server_id"

    # Clean up any orphaned containers from previous runs first
    echo "Cleaning up any orphaned single-server containers..."
    for container in "$container_name" "mcpo-single-nginx"; do
        if docker ps -a --format '{{.Names}}' | grep -q "^${container}$"; then
            echo "  Removing orphaned container: $container"
            docker rm -f "$container" 2>/dev/null || true
        fi
    done
    # Also clean up by project label
    docker ps -aq --filter "label=com.docker.compose.project=$project_name" 2>/dev/null | xargs -r docker rm -f 2>/dev/null || true
    # Clean up orphaned network
    docker network rm "${project_name}_single-server" 2>/dev/null || true

    # Find server config
    local server_dir=$(find_server_config "$server_id")
    if [ -z "$server_dir" ]; then
        echo "Error: Server '$server_id' not found in mcp-configs/ or mcp-configs-user/"
        exit 1
    fi

    local fragment_file="$server_dir/$server_id.fragment"
    local yaml_file="$server_dir/$server_id.yaml"
    if [ ! -f "$fragment_file" ]; then
        echo "Error: Fragment file not found: $fragment_file"
        exit 1
    fi
    if declare -F run_mcp_orc_docker_managed_node_preparer >/dev/null 2>&1; then
        if run_mcp_orc_docker_managed_node_preparer "$PROJECT_ROOT" --server-id "$server_id"; then
            prepare_status=0
        else
            prepare_status=$?
        fi
    else
        if run_mcp_orc_generator "$PROJECT_ROOT" prepare-managed-node-packages --server-id "$server_id"; then
            prepare_status=0
        else
            prepare_status=$?
        fi
    fi
    if [ "$prepare_status" -ne 0 ]; then
        echo "Error: managed Node MCP package preparation failed for '$server_id'; refusing runtime package-manager fallback"
        exit 1
    fi

    local runtime_variant
    runtime_variant="$(get_single_server_runtime_variant "$fragment_file")"
    local runtime_backend
    runtime_backend="$(resolve_single_server_backend "$yaml_file")"

    echo "Using config from: $server_dir"
    echo "Resolved MCP runtime backend for $server_id: $runtime_backend (mode=$MCP_ORC_MODE_RESOLVED)"

    if [ "$FORCE_BUILD" = true ] && [ "$strict_managed_runtime" = true ]; then
        echo "Error: --build is not supported for packaged managed runtimes."
        exit 1
    fi

    shared_mcpo_image=$(resolve_shared_mcpo_image "$runtime_variant" "$runtime_backend")
    if [ "$FORCE_BUILD" = true ]; then
        shared_mcpo_image=""
        echo "Ignoring cached shared MCPO image because --build was requested"
    elif [ -n "$shared_mcpo_image" ]; then
        echo "Using shared MCPO image ($runtime_variant): $shared_mcpo_image"
    elif [ "$strict_managed_runtime" = true ]; then
        echo "Error: Required Harbor single-server image is missing for packaged managed runtime variant '$runtime_variant'. Packaged builds cannot fall back to local single-server builds."
        exit 1
    else
        echo "No shared MCPO image found for runtime variant '$runtime_variant'; single-server stack will use local cache/build fallback"
    fi

    # Generate compose file
    generate_compose_file "$server_id" "$server_dir" "$shared_mcpo_image" "$runtime_variant" "$runtime_backend"

    # Start the stack
    echo "Starting Docker containers..."
    cd "$PROJECT_ROOT"

    # Load .env file to make user-configured env vars available
    # These are referenced in the generated compose file as ${VAR_NAME}
    # Use a safer method that handles values with spaces
    if [ -f "$PROJECT_ROOT/.env" ]; then
        echo "Loading environment from .env..."
        while IFS='=' read -r key value || [ -n "$key" ]; do
            # Skip comments and empty lines
            [[ "$key" =~ ^[[:space:]]*# ]] && continue
            [[ -z "$key" ]] && continue
            # Remove leading/trailing whitespace from key
            key=$(echo "$key" | tr -d '[:space:]')
            # Export the variable (value may contain spaces)
            if [ -n "$key" ] && [ -n "$value" ]; then
                export "$key=$value"
            fi
        done < "$PROJECT_ROOT/.env"
    fi

    # Use docker compose directly with the single-server compose file
    # Note: We don't use docker-compose.sh here as it's meant for the main stack
    # The single-server stack uses its own compose file
    # Use explicit project name for consistent tracking
    if [ "$FORCE_BUILD" = true ]; then
        echo "Forcing rebuild of single-server image..."
        build_args="--build"
    elif [ -n "$shared_mcpo_image" ]; then
        echo "Using shared MCPO image (skip rebuild)"
        build_args="--no-build"
    elif [ "$strict_managed_runtime" = true ]; then
        echo "Error: Missing required Harbor single-server image for packaged managed runtime; refusing local build fallback."
        exit 1
    elif docker image inspect "$default_image_name" >/dev/null 2>&1; then
        echo "Using cached single-server image (skip rebuild)"
        build_args="--no-build"
    else
        echo "Single-server image not found; building once..."
        build_args="--build"
    fi

    if ! run_single_compose_up_with_retry "$project_name" "$COMPOSE_FILE" "$build_args"; then
        exit 1
    fi

    echo ""
    echo "Single-server stack started for: $server_id"
    echo "  MCPO endpoint: http://localhost:${HOST_PORT}/$server_id"
    echo "  OAuth callback: http://localhost:${CALLBACK_HOST_PORT}/callback"
    echo ""
    echo "Use --status to check health, --logs to view logs, --stop to shut down"
}

# Persist single-server stack diagnostics to the app logs dir BEFORE teardown.
# The single-server stack is short-lived and removed on every stop (it backs
# both OAuth re-auth and "test this server" config flows), so its
# container/nginx logs would otherwise never reach a debug bundle. We name the
# file with the "single-server-" prefix, which debug.sh's app-log harvest
# recognizes. Best-effort: never blocks or fails teardown.
persist_single_server_logs() {
    local server_id="$1"

    # Only bother if a single-server stack is actually present.
    if ! docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^mcpo-single-'; then
        return 0
    fi

    local app_support_dir="${PORTICO_APP_SUPPORT_DIR:-$HOME/Library/Application Support/portico}"
    local logs_dir="$app_support_dir/logs"
    local capture_script="$SCRIPT_DIR/capture-single-server.sh"

    [ -f "$capture_script" ] || return 0
    mkdir -p "$logs_dir" 2>/dev/null || return 0

    local ts logfile
    ts="$(date -u +%Y%m%dT%H%M%SZ)"
    logfile="$logs_dir/single-server-${server_id}-${ts}.log"

    bash "$capture_script" --server "$server_id" --out "$logfile" >/dev/null 2>&1 || true

    # Retention: keep only the 20 most recent single-server captures.
    ls -1t "$logs_dir"/single-server-*.log 2>/dev/null | tail -n +21 | while read -r old; do
        rm -f "$old" 2>/dev/null || true
    done

    [ -f "$logfile" ] && echo "  Saved single-server diagnostics: $logfile"
    return 0
}

# Stop the single-server stack
stop_server() {
    local server_id="$1"
    local container_name="mcpo-single-$server_id"
    local project_name="portico-single"

    echo "Stopping single-server stack for: $server_id"

    # Capture diagnostics while containers still exist (before compose down).
    persist_single_server_logs "$server_id" || true

    cd "$PROJECT_ROOT"

    # Method 1: Use docker compose down with explicit project name
    if [ -f "$COMPOSE_FILE" ]; then
        echo "Running docker compose down..."
        run_docker_compose -p "$project_name" -f "$COMPOSE_FILE" down --volumes --remove-orphans --timeout 1 2>&1 || true
    fi

    # Method 2: Explicitly stop and remove containers by name (fallback)
    echo "Cleaning up containers by name..."
    for container in "$container_name" "mcpo-single-nginx"; do
        if docker ps -a --format '{{.Names}}' | grep -q "^${container}$"; then
            echo "  Stopping and removing: $container"
            docker stop -t 1 "$container" 2>/dev/null || true
            docker rm -f "$container" 2>/dev/null || true
        fi
    done

    # Method 3: Clean up any containers with the single-server project label
    echo "Cleaning up by project label..."
    docker ps -aq --filter "label=com.docker.compose.project=$project_name" 2>/dev/null | xargs -r docker rm -f 2>/dev/null || true

    # Method 4: Clean up orphaned networks
    docker network rm "${project_name}_single-server" 2>/dev/null || true

    # Method 5: Clean up MCP server's spawned Docker containers
    # Some MCP servers (like n8n) use "docker run" to spawn their own containers
    # These containers are NOT managed by docker compose and need explicit cleanup
    echo "Cleaning up MCP-spawned Docker containers..."
    local server_dir=$(find_server_config "$server_id")
    if [ -n "$server_dir" ]; then
        local fragment_file="$server_dir/$server_id.fragment"
        if [ -f "$fragment_file" ]; then
            # Check if the MCP server uses Docker
            local mcp_command=$(jq -r '.command // empty' "$fragment_file" 2>/dev/null)
            if [ "$mcp_command" = "docker" ]; then
                # Extract the Docker image from the args
                local docker_image=$(jq -r '.args[-1] // empty' "$fragment_file" 2>/dev/null)
                if [ -n "$docker_image" ]; then
                    echo "  Looking for containers using image: $docker_image"
                    # Find and stop any containers using this image
                    local spawned_containers=$(docker ps -q --filter "ancestor=$docker_image" 2>/dev/null)
                    if [ -n "$spawned_containers" ]; then
                        echo "  Stopping spawned containers: $spawned_containers"
                        echo "$spawned_containers" | xargs -r docker stop -t 1 2>/dev/null || true
                        echo "$spawned_containers" | xargs -r docker rm -f 2>/dev/null || true
                    fi
                fi
            fi
        fi
    fi

    # Clean up generated files (directory-safe; PORTICO-202)
    remove_single_server_config_path "$COMPOSE_FILE"
    remove_single_server_config_path "$NGINX_CONF"
    remove_single_server_config_path "$PROJECT_ROOT/mcpo-configs-generated/single-$server_id.json"

    echo "Single-server stack stopped"
}

# Check status of single-server stack
check_status() {
    local server_id="$1"
    local container_name="mcpo-single-$server_id"

    echo "Checking status for: $server_id"
    echo ""

    # Check if compose file exists
    if [ ! -f "$COMPOSE_FILE" ]; then
        echo "Status: NOT RUNNING (no compose file found)"
        exit 1
    fi

    # Check container status
    if docker ps --format '{{.Names}}' | grep -q "^$container_name$"; then
        echo "Container: RUNNING"

        # Check health endpoint
        if curl -s --max-time 5 "http://localhost:${HOST_PORT}/health" >/dev/null 2>&1; then
            echo "Health: OK"
        else
            echo "Health: UNHEALTHY (endpoint not responding)"
        fi

        # Check OpenAPI endpoint
        local openapi_response=$(curl -s --max-time 10 "http://localhost:${HOST_PORT}/$server_id/openapi.json" 2>/dev/null)
        if [ -n "$openapi_response" ] && echo "$openapi_response" | jq -e '.paths' >/dev/null 2>&1; then
            local tool_count=$(echo "$openapi_response" | jq '.paths | keys | length')
            echo "OpenAPI: OK ($tool_count tools)"
        else
            echo "OpenAPI: NOT READY"
        fi

        exit 0
    else
        echo "Container: NOT RUNNING"
        exit 1
    fi
}

# Show logs
show_logs() {
    local server_id="$1"

    require_docker_compose_frontend || exit $?

    if [ ! -f "$COMPOSE_FILE" ]; then
        echo "No single-server stack is running"
        exit 1
    fi

    cd "$PROJECT_ROOT"
    run_docker_compose -f "$COMPOSE_FILE" logs --tail=50 -f
}

# Main execution
case "$ACTION" in
    start)
        start_server "$SERVER_ID"
        ;;
    stop)
        stop_server "$SERVER_ID"
        ;;
    status)
        check_status "$SERVER_ID"
        ;;
    logs)
        show_logs "$SERVER_ID"
        ;;
esac
