#!/bin/bash

# Docker Compose Management Script
# Handles start, stop, restart, status, and logs for Docker containers

set -e

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
# Script now lives in src/scripts - project root is two levels up
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
source "$SCRIPT_DIR/mcp-orc-backend.sh"
source "$SCRIPT_DIR/mcp-orc-cli.sh"
source "$SCRIPT_DIR/managed-runtime-integrity.sh"
source "$SCRIPT_DIR/runtime-secrets.sh"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Change to project root
cd "$PROJECT_ROOT"
export_mcp_orc_compose_env
export_mcp_orc_harbor_env "latest" "$MCP_ORC_MODE_RESOLVED"
echo -e "${BLUE}MCP mode selected: ${MCP_ORC_MODE_RESOLVED}${NC}" >&2

get_llm_gateway_container_name() {
    echo "llm-gateway"
}

resolve_container_name_for_service() {
    local service_name="$1"
    case "$service_name" in
        llm-gateway)
            get_llm_gateway_container_name
            ;;
        *)
            echo "$service_name"
            ;;
    esac
}

append_llm_gateway_compose_file() {
    local var_name="$1"
    printf -v "$var_name" '%s' "${!var_name}"
}

LLM_GATEWAY_MODE_RESOLVED="$(resolve_llm_gateway_mode)"
export LLM_GATEWAY_MODE="$LLM_GATEWAY_MODE_RESOLVED"
export BIFROST_BRIDGE_IMAGE="$(llm_gateway_local_image_name "$LLM_GATEWAY_MODE_RESOLVED")"
LLM_GATEWAY_CONTAINER_NAME="$(get_llm_gateway_container_name)"
echo -e "${BLUE}LLM gateway selected: ${LLM_GATEWAY_MODE_RESOLVED}${NC}" >&2
echo -e "${BLUE}Cost reporting host dir: ${PORTICO_COST_REPORTING_HOST_DIR:-$PROJECT_ROOT/open-webui-data/reporting}${NC}" >&2

# Function to validate if a timezone string is valid IANA timezone
validate_timezone() {
    local tz="$1"
    # Reject empty strings
    if [ -z "$tz" ]; then
        return 1
    fi
    # Reject common error words
    if [[ "$tz" =~ ^(administrator|error|denied|permission|sudo|root|you|need|must)$ ]]; then
        return 1
    fi
    # Valid IANA timezone should contain "/" (e.g., America/Los_Angeles) or be UTC/GMT
    if [[ "$tz" == "UTC" ]] || [[ "$tz" == "GMT" ]] || [[ "$tz" =~ ^[A-Z][a-zA-Z_]+/[A-Z][a-zA-Z_]+$ ]] || [[ "$tz" =~ ^[A-Z][a-zA-Z_]+/[A-Z][a-zA-Z_]+/[A-Z][a-zA-Z_]+$ ]]; then
        return 0
    fi
    return 1
}

# Function to get build info from build-info.json
get_build_info() {
    local build_info_file="$PROJECT_ROOT/electron-app/build-info.json"

    # Check if build-info.json exists
    if [ -f "$build_info_file" ]; then
        echo -e "${BLUE}Reading build info from build-info.json...${NC}" >&2

        # Extract buildNumber from JSON using grep and sed
        local build_number=$(grep -o '"buildNumber"[[:space:]]*:[[:space:]]*"[^"]*"' "$build_info_file" | sed 's/.*"\([^"]*\)".*/\1/')

        if [ -n "$build_number" ]; then
            echo -e "${GREEN}✓ Found build: $build_number${NC}" >&2
            echo "$build_number"
            return 0
        else
            echo -e "${YELLOW}⚠ Warning: Could not parse buildNumber from build-info.json${NC}" >&2
        fi
    else
        echo -e "${YELLOW}⚠ Warning: build-info.json not found at $build_info_file${NC}" >&2
    fi

    # Default to dev-build if not found or parsing failed
    echo -e "${YELLOW}⚠ Warning: Using default build identifier: dev-build${NC}" >&2
    echo "dev-build"
}

# Function to get the Harbor runtime image tag from build-info.json (PORTICO-371).
#
# Beta builds tag their images with the build number, so this equals
# get_build_info() for them. MR/broker builds tag images mr-<iid>-<sha> and
# record it as "dockerImageTag"; prefer that so runtime image resolution
# matches what was actually pushed. Falls back to the build number (which keeps
# the dev-build behavior) when the field is absent.
get_image_tag() {
    local build_info_file="$PROJECT_ROOT/electron-app/build-info.json"

    if [ -f "$build_info_file" ]; then
        local image_tag=$(grep -o '"dockerImageTag"[[:space:]]*:[[:space:]]*"[^"]*"' "$build_info_file" | sed 's/.*"\([^"]*\)".*/\1/')
        if [ -n "$image_tag" ] && [ "$image_tag" != "dev-build" ]; then
            echo "$image_tag"
            return 0
        fi
    fi

    get_build_info
}

# resolve_agent_vm_runtime_image() lives in a sourceable helper so tests can
# exercise it with stubbed docker/get_image_tag (PORTICO-231, PORTICO-371).
source "$SCRIPT_DIR/agent-vm-image-resolve.sh"

# Function to detect host timezone (works on macOS and Linux)
detect_timezone() {
    local detected_tz=""

    # Detect OS type
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        echo -e "${BLUE}Detecting timezone on macOS...${NC}" >&2

        # Method 1: Parse /etc/localtime symlink (most reliable on macOS)
        if [ -L /etc/localtime ]; then
            detected_tz=$(readlink /etc/localtime | sed 's|.*/zoneinfo/||')
            if validate_timezone "$detected_tz"; then
                echo -e "${GREEN}✓ Detected from /etc/localtime: $detected_tz${NC}" >&2
                echo "$detected_tz"
                return 0
            else
                echo -e "${YELLOW}✗ Invalid timezone from /etc/localtime: '$detected_tz'${NC}" >&2
            fi
        fi

        # Method 2: Try systemsetup (parse more carefully)
        if command -v systemsetup >/dev/null 2>&1; then
            local tz_output=$(systemsetup -gettimezone 2>/dev/null)
            # Parse "Time Zone: America/Los_Angeles" format
            if [[ "$tz_output" =~ Time\ Zone:\ (.+)$ ]]; then
                detected_tz="${BASH_REMATCH[1]}"
                detected_tz="${detected_tz// /}"  # Remove spaces
                if validate_timezone "$detected_tz"; then
                    echo -e "${GREEN}✓ Detected from systemsetup: $detected_tz${NC}" >&2
                    echo "$detected_tz"
                    return 0
                else
                    echo -e "${YELLOW}✗ Invalid timezone from systemsetup: '$detected_tz'${NC}" >&2
                fi
            fi
        fi

        # Method 3: Use ls to read /etc/localtime target (alternative to readlink)
        detected_tz=$(ls -l /etc/localtime 2>/dev/null | awk -F'/zoneinfo/' '{print $2}')
        if validate_timezone "$detected_tz"; then
            echo -e "${GREEN}✓ Detected from ls /etc/localtime: $detected_tz${NC}" >&2
            echo "$detected_tz"
            return 0
        fi

    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        # Linux
        echo -e "${BLUE}Detecting timezone on Linux...${NC}" >&2

        # Method 1: timedatectl (systemd-based systems) - most reliable
        if command -v timedatectl >/dev/null 2>&1; then
            detected_tz=$(timedatectl show -p Timezone --value 2>/dev/null || echo "")
            if validate_timezone "$detected_tz"; then
                echo -e "${GREEN}✓ Detected from timedatectl: $detected_tz${NC}" >&2
                echo "$detected_tz"
                return 0
            fi
        fi

        # Method 2: Read from /etc/timezone
        if [ -f /etc/timezone ]; then
            detected_tz=$(cat /etc/timezone 2>/dev/null | tr -d '[:space:]')
            if validate_timezone "$detected_tz"; then
                echo -e "${GREEN}✓ Detected from /etc/timezone: $detected_tz${NC}" >&2
                echo "$detected_tz"
                return 0
            fi
        fi

        # Method 3: Parse /etc/localtime symlink
        if [ -L /etc/localtime ]; then
            detected_tz=$(readlink /etc/localtime | sed 's|.*/zoneinfo/||')
            if validate_timezone "$detected_tz"; then
                echo -e "${GREEN}✓ Detected from /etc/localtime: $detected_tz${NC}" >&2
                echo "$detected_tz"
                return 0
            fi
        fi
    else
        # Fallback for other Unix-like systems
        echo -e "${YELLOW}Unknown OS type: $OSTYPE, attempting generic detection...${NC}" >&2
    fi

    # If all methods failed, default to UTC
    echo -e "${YELLOW}⚠ Warning: Could not detect valid timezone, defaulting to UTC${NC}" >&2
    echo "UTC"
}

# Remove runtime secret keys from .env file (defense in depth)
# Runtime keys are injected dynamically and should NEVER be stored on disk.
# Kept in sync with guided-setup RUNTIME_SECRET_STRIP_KEYS and
# runtime-secrets-config RUNTIME_SECRET_ENV_FILE_KEYS. Covers canonical keys,
# local-stack aliases, container-side keys, dev-only upload key and _FILE pointers.
discover_sensitive_required_env_vars() {
    local root dir yaml_file
    for root in "$PROJECT_ROOT/mcp-configs" "$PROJECT_ROOT/mcp-configs-user"; do
        [ -d "$root" ] || continue
        for dir in "$root"/*; do
            [ -d "$dir" ] || continue
            yaml_file="$dir/$(basename "$dir").yaml"
            [ -f "$yaml_file" ] || continue
            awk '
                function flush_entry() {
                    if (name != "" && sensitive == "true") print name
                    name = ""
                    sensitive = "false"
                }
                BEGIN { in_required = 0; name = ""; sensitive = "false" }
                /^[^[:space:]-][^:]*:/ {
                    if ($0 ~ /^required_env_vars:[[:space:]]*$/) {
                        in_required = 1
                        next
                    }
                    if (in_required) {
                        flush_entry()
                        in_required = 0
                    }
                }
                in_required && /^[[:space:]]*-[[:space:]]*name:[[:space:]]*/ {
                    flush_entry()
                    line = $0
                    sub(/^[[:space:]]*-[[:space:]]*name:[[:space:]]*/, "", line)
                    gsub(/"/, "", line)
                    gsub(/\047/, "", line)
                    sub(/[[:space:]]+$/, "", line)
                    name = line
                    next
                }
                in_required && /^[[:space:]]*sensitive:[[:space:]]*true[[:space:]]*$/ {
                    sensitive = "true"
                    next
                }
                END { if (in_required) flush_entry() }
            ' "$yaml_file"
        done
    done | sort -u
}

discover_sensitive_runtime_file_descriptors() {
    if declare -F discover_sensitive_runtime_files >/dev/null 2>&1; then
        discover_sensitive_runtime_files
    fi
}

discover_sensitive_required_env_descriptors() {
    if declare -F discover_sensitive_required_env_var_descriptors >/dev/null 2>&1; then
        discover_sensitive_required_env_var_descriptors
    fi
}

clean_env_file() {
    local env_file="$PROJECT_ROOT/.env"
    local secret_keys=(
        "PORTICO_LLM_API_KEY"
        "LOCAL_STACK_API_KEY"
        "INTERNAL_OPENAI_API_KEY"
        "OPENAI_API_KEY"
        "BIFROST_BRIDGE_LOCAL_API_KEY"
        "ULTRA_MULTI_AGENT_SIGNING_SECRET"
        "OWUI_AUTH_BRIDGE_SECRET"
        "WEBUI_SECRET_KEY"
        "CLOUDSMITH_ENTITLEMENT_TOKEN"
        "PORTICO_LLM_API_KEY_FILE"
        "BIFROST_BRIDGE_LOCAL_API_KEY_FILE"
        "ULTRA_MULTI_AGENT_SIGNING_SECRET_FILE"
        "OWUI_AUTH_BRIDGE_SECRET_FILE"
        "WEBUI_SECRET_KEY_FILE"
        "SLACK_OAUTH_CLIENT_ID"
        "SLACK_OAUTH_CLIENT_SECRET"
        "SLACK_OAUTH_CLIENT_ID_FILE"
        "SLACK_OAUTH_CLIENT_SECRET_FILE"
        "SLACK_MCP_XOXP_TOKEN"
        "SLACK_MCP_XOXP_TOKEN_FILE"
    )
    local sensitive_key
    while IFS= read -r sensitive_key; do
        [ -n "$sensitive_key" ] || continue
        secret_keys+=("$sensitive_key" "${sensitive_key}_FILE")
    done < <(discover_sensitive_required_env_vars)
    local sensitive_server sensitive_secret_name sensitive_available_env
    while IFS=$'\t' read -r sensitive_server sensitive_key sensitive_secret_name; do
        [ -n "$sensitive_server" ] || continue
        [ -n "$sensitive_secret_name" ] || continue
        sensitive_available_env="$(static_secret_availability_env_var "$sensitive_server" "$sensitive_secret_name")"
        secret_keys+=("$sensitive_available_env")
    done < <(discover_sensitive_required_env_descriptors)
    local runtime_file_secret runtime_file_server runtime_file_target runtime_file_source runtime_file_env runtime_file_available_env
    while IFS=$'\t' read -r runtime_file_secret runtime_file_server runtime_file_target runtime_file_source; do
        [ -n "$runtime_file_secret" ] || continue
        runtime_file_env="$(sensitive_runtime_file_secret_env_var "$runtime_file_secret")"
        runtime_file_available_env="$(static_secret_availability_env_var "$runtime_file_server" "$runtime_file_secret")"
        secret_keys+=("$runtime_file_env" "$runtime_file_available_env")
    done < <(discover_sensitive_runtime_file_descriptors)

    if [ ! -f "$env_file" ]; then
        return 0
    fi

    local has_plaintext_secret=0
    local key=""
    for key in "${secret_keys[@]}"; do
        if grep -q "^${key}=" "$env_file"; then
            has_plaintext_secret=1
            break
        fi
    done

    if [ "$has_plaintext_secret" -eq 1 ]; then
        echo -e "${YELLOW}⚠ Found runtime secret keys in .env file - removing for security${NC}" >&2
        cp "$env_file" "$env_file.bak"

        local temp_file
        temp_file="$(mktemp)"
        local line
        while IFS= read -r line || [ -n "$line" ]; do
            local keep_line=1
            for key in "${secret_keys[@]}"; do
                case "$line" in
                    "$key="*)
                        keep_line=0
                        break
                        ;;
                esac
            done
            if [ "$keep_line" -eq 1 ]; then
                printf '%s\n' "$line" >> "$temp_file"
            fi
            line=""
        done < "$env_file.bak"

        mv "$temp_file" "$env_file"
        rm -f "$env_file.bak"
        echo -e "${GREEN}✓ Removed runtime secret keys from .env file${NC}" >&2
    fi
}

# Directory holding runtime secret files that Docker Compose bind-mounts into
# containers as /run/secrets/*. The lifetime must outlive the orchestration
# script itself because `docker compose up -d` detaches and the containers'
# bind-mount sources must remain on the host for the stack's lifetime — any
# restart of a container (OrbStack reboot, OOM kill, `docker restart`, health
# check recovery) re-materializes the mount and would fail with ENOENT if the
# source had been wiped under an EXIT trap.
#
# We therefore use a stable user-scoped cache directory (700 / 600
# permissions), and clean it up only on explicit stop/down (see
# cleanup_runtime_secret_tmpdir callers further down). The secret files are
# user-owned and never leave the user's home directory, so from a threat-model
# standpoint they are equivalent to the Keychain-backed plaintext twins we
# already allow under the managed root.
PORTICO_RUNTIME_SECRET_TMPDIR=""

_default_runtime_secret_cache_dir() {
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

cleanup_runtime_secret_tmpdir() {
    # Only called on explicit stop/down; see callers. `docker-compose.sh start`
    # (i.e. `up -d`) MUST NOT wipe the directory — containers bind-mount the
    # files inside and need them to persist for their lifetime.
    if [ -n "${PORTICO_RUNTIME_SECRET_TMPDIR:-}" ] && [ -d "$PORTICO_RUNTIME_SECRET_TMPDIR" ]; then
        rm -rf "$PORTICO_RUNTIME_SECRET_TMPDIR" 2>/dev/null || true
    fi
    PORTICO_RUNTIME_SECRET_TMPDIR=""
}

# Runtime secret files that back Docker Compose `secrets:` declarations.
# Containers consume them via read-only tmpfs at /run/secrets/<name>. Host
# source files live in the user-scoped cache dir defined by
# _default_runtime_secret_cache_dir and survive across invocations; they are
# removed only by cleanup_runtime_secret_tmpdir, which is invoked from the
# explicit `stop`/`down` command handlers below.
prepare_optional_file_secret_ingress() {
    if [ -z "${PORTICO_RUNTIME_SECRET_TMPDIR:-}" ] || [ ! -d "$PORTICO_RUNTIME_SECRET_TMPDIR" ]; then
        PORTICO_RUNTIME_SECRET_TMPDIR="$(_default_runtime_secret_cache_dir)"
        mkdir -p "$PORTICO_RUNTIME_SECRET_TMPDIR" 2>/dev/null || true
        chmod 700 "$PORTICO_RUNTIME_SECRET_TMPDIR" 2>/dev/null || true
    fi

    # Always create a file on disk (even empty) so Docker Compose
    # `secrets: { file: ... }` declarations resolve even when a particular
    # secret is not yet known. Downstream runtime validators enforce presence
    # of non-empty values separately.
    #
    # CONTENT-AWARE WRITE: Compare existing on-disk bytes to the desired value
    # and skip the rewrite if they match. Rewriting truncates+writes which on
    # macOS Docker Desktop / OrbStack can replace the inode underneath a
    # running container's bind-mount (the container then sees "?????????" /
    # ENOENT for the file). Preserving the inode keeps existing mounts valid
    # across re-runs of `install_v2.sh` with the same Keychain-resolved key.
    #
    write_runtime_secret_file() {
        local file_name="$1"
        local secret_value="$2"
        local target_path="$PORTICO_RUNTIME_SECRET_TMPDIR/$file_name"

        local existing_value=""
        if [ -f "$target_path" ]; then
            # Use cat (not $(<file)) so binary-safe and POSIX-compatible. The
            # trailing-newline stripping problem doesn't apply because we
            # write with `printf '%s'` (no newline) below.
            existing_value="$(cat "$target_path" 2>/dev/null || true)"
        fi

        if [ "$existing_value" = "$secret_value" ] && [ -f "$target_path" ]; then
            # Content matches: do not rewrite. This preserves the inode so
            # already-running containers' bind-mounts stay valid.
            chmod 600 "$target_path" 2>/dev/null || true
            printf '%s\n' "$target_path"
            return 0
        fi

        # Content differs (or file does not yet exist): rewrite atomically.
        if [ -z "$secret_value" ]; then
            : > "$target_path"
        else
            printf '%s' "$secret_value" > "$target_path"
        fi
        chmod 600 "$target_path" 2>/dev/null || true

        printf '%s\n' "$target_path"
    }

    export PORTICO_LLM_API_KEY_FILE="$(write_runtime_secret_file "portico_llm_api_key" "${PORTICO_LLM_API_KEY:-}")"
    export BIFROST_BRIDGE_LOCAL_API_KEY_FILE="$(write_runtime_secret_file "bifrost_bridge_local_api_key" "${BIFROST_BRIDGE_LOCAL_API_KEY:-}")"
    export ULTRA_MULTI_AGENT_SIGNING_SECRET_FILE="$(write_runtime_secret_file "ultra_multi_agent_signing_secret" "${ULTRA_MULTI_AGENT_SIGNING_SECRET:-}")"
    export OWUI_AUTH_BRIDGE_SECRET_FILE="$(write_runtime_secret_file "owui_auth_bridge_secret" "${OWUI_AUTH_BRIDGE_SECRET:-}")"
    export WEBUI_SECRET_KEY_FILE="$(write_runtime_secret_file "webui_secret_key" "${WEBUI_SECRET_KEY:-}")"
    rm -f "$PORTICO_RUNTIME_SECRET_TMPDIR/slack_oauth_client_id" \
          "$PORTICO_RUNTIME_SECRET_TMPDIR/slack_oauth_client_secret" 2>/dev/null || true
    unset SLACK_OAUTH_CLIENT_ID SLACK_OAUTH_CLIENT_SECRET
    unset SLACK_OAUTH_CLIENT_ID_FILE SLACK_OAUTH_CLIENT_SECRET_FILE

    local sensitive_key sensitive_status
    while IFS= read -r sensitive_key; do
        [ -n "$sensitive_key" ] || continue
        sensitive_status=0
        resolve_mcp_sensitive_env_secret "$sensitive_key" >/dev/null 2>&1 || sensitive_status=$?
        if [ "$sensitive_status" -gt 1 ]; then
            echo -e "${RED}❌ Failed to persist sensitive MCP env var $sensitive_key to secure storage${NC}" >&2
            return "$sensitive_status"
        fi
        unset "$sensitive_key" "${sensitive_key}_FILE"
    done < <(discover_sensitive_required_env_vars)

    local runtime_file_secret runtime_file_server runtime_file_target runtime_file_source runtime_file_env runtime_file_available_env runtime_file_status
    while IFS=$'\t' read -r runtime_file_secret runtime_file_server runtime_file_target runtime_file_source; do
        [ -n "$runtime_file_secret" ] || continue
        runtime_file_status=0
        import_sensitive_runtime_file_secret_to_keychain \
            "$runtime_file_server" \
            "$runtime_file_target" \
            "$runtime_file_source" || runtime_file_status=$?
        if [ "$runtime_file_status" -gt 1 ]; then
            echo -e "${RED}❌ Failed to import sensitive runtime file secret for $runtime_file_server at $runtime_file_target${NC}" >&2
            return "$runtime_file_status"
        fi
        runtime_file_env="$(sensitive_runtime_file_secret_env_var "$runtime_file_secret")"
        runtime_file_available_env="$(static_secret_availability_env_var "$runtime_file_server" "$runtime_file_secret")"
        unset "$runtime_file_env"
        if [ "$runtime_file_status" -eq 0 ] && sensitive_runtime_file_secret_available "$runtime_file_server" "$runtime_file_target"; then
            export "$runtime_file_available_env=1"
        else
            unset "$runtime_file_available_env"
        fi
    done < <(discover_sensitive_runtime_file_descriptors)
}

check_llm_gateway_runtime_secret_mounts() {
    local container_name="llm-gateway"
    local container_status
    container_status="$(docker inspect --format '{{.State.Status}}' "$container_name" 2>/dev/null || true)"

    # If the gateway is not running yet, let the existing container startup
    # verification report that state. This check is only about bad secret mounts.
    [ "$container_status" = "running" ] || return 0

    local output
    if output="$(docker exec "$container_name" sh -c '
failed=0
for secret_path in /run/secrets/portico_llm_api_key /run/secrets/bifrost_bridge_local_api_key /run/secrets/ultra_multi_agent_signing_secret; do
    if [ ! -s "$secret_path" ]; then
        echo "missing_or_empty:${secret_path}"
        failed=1
    fi
done
if grep -F " /run/secrets/portico_llm_api_key " /proc/self/mountinfo 2>/dev/null | grep -Fq "//deleted"; then
    echo "deleted_mount:/run/secrets/portico_llm_api_key"
    failed=1
fi
if grep -F " /run/secrets/bifrost_bridge_local_api_key " /proc/self/mountinfo 2>/dev/null | grep -Fq "//deleted"; then
    echo "deleted_mount:/run/secrets/bifrost_bridge_local_api_key"
    failed=1
fi
if grep -F " /run/secrets/ultra_multi_agent_signing_secret " /proc/self/mountinfo 2>/dev/null | grep -Fq "//deleted"; then
    echo "deleted_mount:/run/secrets/ultra_multi_agent_signing_secret"
    failed=1
fi
exit "$failed"
' 2>&1)"; then
        return 0
    fi

    printf '%s\n' "$output" | sed '/^$/d' >&2
    return 1
}

ensure_llm_gateway_runtime_secret_mounts() {
    local compose_files="$1"
    local diagnostics=""

    # Simple mode and some targeted compose operations do not include llm-gateway.
    # Skip the gateway-specific check unless this compose graph declares it.
    # shellcheck disable=SC2086 # compose files are assembled as a word-split flag list
    if ! run_docker_compose $compose_files config --services 2>/dev/null | grep -qx 'llm-gateway'; then
        return 0
    fi

    if diagnostics="$(check_llm_gateway_runtime_secret_mounts 2>&1)"; then
        return 0
    fi

    echo -e "${YELLOW}⚠ llm-gateway runtime secret mounts are invalid; force-recreating llm-gateway with fresh bind mounts${NC}" >&2
    if [ -n "$diagnostics" ]; then
        printf '%s\n' "$diagnostics" >&2
    fi

    prepare_compose_runtime_env
    # shellcheck disable=SC2086 # compose files are assembled as a word-split flag list
    if ! run_docker_compose $compose_files up -d --force-recreate --no-deps llm-gateway 2>&1; then
        echo -e "${RED}❌ Failed to force-recreate llm-gateway after invalid runtime secret mounts${NC}" >&2
        return 1
    fi

    if diagnostics="$(check_llm_gateway_runtime_secret_mounts 2>&1)"; then
        echo -e "${GREEN}✓ llm-gateway runtime secret mounts refreshed${NC}" >&2
        return 0
    fi

    echo -e "${RED}❌ llm-gateway runtime secret mounts are still invalid after force-recreate${NC}" >&2
    if [ -n "$diagnostics" ]; then
        printf '%s\n' "$diagnostics" >&2
    fi
    return 1
}

check_container_runtime_secret_mounts() {
    local container_name="$1"
    shift

    local container_status
    container_status="$(docker inspect --format '{{.State.Status}}' "$container_name" 2>/dev/null || true)"

    # Container state is validated separately. This guard only detects secret
    # bind mounts that became unreadable while Docker created services in
    # parallel (observed with OrbStack on macOS).
    [ "$container_status" = "running" ] || return 0

    local output
    if output="$(docker exec -u 0 "$container_name" sh -c '
failed=0
for secret_path do
    if [ ! -s "$secret_path" ]; then
        echo "missing_or_empty:${secret_path}"
        failed=1
    fi
    if grep -F " ${secret_path} " /proc/self/mountinfo 2>/dev/null | grep -Fq "//deleted"; then
        echo "deleted_mount:${secret_path}"
        failed=1
    fi
done
exit "$failed"
' sh "$@" 2>&1)"; then
        return 0
    fi

    printf '%s\n' "$output" | sed '/^$/d' >&2
    return 1
}

ensure_compose_service_runtime_secret_mounts() {
    local compose_files="$1"
    local service_name="$2"
    local container_name="$3"
    shift 3

    # Some compose modes omit optional services. Only validate services in the
    # active graph.
    # shellcheck disable=SC2086 # compose files are assembled as a word-split flag list
    if ! run_docker_compose $compose_files config --services 2>/dev/null | grep -qx "$service_name"; then
        return 0
    fi

    local diagnostics=""
    if diagnostics="$(check_container_runtime_secret_mounts "$container_name" "$@" 2>&1)"; then
        return 0
    fi

    echo -e "${YELLOW}⚠ ${service_name} runtime secret mounts are invalid; recreating ${service_name} with fresh bind mounts${NC}" >&2
    if [ -n "$diagnostics" ]; then
        printf '%s\n' "$diagnostics" >&2
    fi

    prepare_compose_runtime_env
    # Recreate one service at a time. Parallel container creation is the source
    # of this macOS bind-mount race.
    # shellcheck disable=SC2086 # compose files are assembled as a word-split flag list
    if ! run_docker_compose $compose_files up -d --force-recreate --no-deps "$service_name" 2>&1; then
        echo -e "${RED}❌ Failed to recreate ${service_name} after invalid runtime secret mounts${NC}" >&2
        return 1
    fi

    if diagnostics="$(check_container_runtime_secret_mounts "$container_name" "$@" 2>&1)"; then
        echo -e "${GREEN}✓ ${service_name} runtime secret mounts refreshed${NC}" >&2
        return 0
    fi

    echo -e "${RED}❌ ${service_name} runtime secret mounts are still invalid after recreation${NC}" >&2
    if [ -n "$diagnostics" ]; then
        printf '%s\n' "$diagnostics" >&2
    fi
    return 1
}

ensure_core_runtime_secret_mounts() {
    local compose_files="$1"

    ensure_compose_service_runtime_secret_mounts \
        "$compose_files" \
        "open-webui" \
        "portico-open-webui" \
        /run/secrets/owui_auth_bridge_secret \
        /run/secrets/bifrost_bridge_local_api_key \
        /run/secrets/ultra_multi_agent_signing_secret \
        /run/secrets/webui_secret_key \
        || return 1

    ensure_compose_service_runtime_secret_mounts \
        "$compose_files" \
        "mcpo-core" \
        "mcpo-core" \
        /run/secrets/owui_auth_bridge_secret \
        || return 1

    ensure_compose_service_runtime_secret_mounts \
        "$compose_files" \
        "mcpo-group-core" \
        "mcpo-group-core" \
        /run/secrets/owui_auth_bridge_secret \
        /run/secrets/portico_llm_api_key \
        || return 1
}

prepare_compose_runtime_env() {
    ensure_runtime_secret_env
    clean_env_file
    prepare_optional_file_secret_ingress
}

prepare_managed_node_mcp_packages() {
    local status_file="$PROJECT_ROOT/health-status/managed_node_package_preparation.json"
    local host_status_file="$PROJECT_ROOT/health-status/managed_node_package_preparation-host.json"
    mkdir -p "$PROJECT_ROOT/health-status"
    # Docker preparation is the first managed-Node phase of each startup.
    # Clear the prior host phase so a host MCP that is no longer selected
    # cannot leave a stale failure overlay behind.
    rm -f "$host_status_file" || return 1
    echo -e "${BLUE}Preparing Docker managed Node MCP packages in one-shot container${NC}" >&2
    if declare -F run_mcp_orc_docker_managed_node_preparer >/dev/null 2>&1; then
        run_mcp_orc_docker_managed_node_preparer \
            "$PROJECT_ROOT" \
            --enabled-only \
            --deployment-type docker \
            --best-effort \
            --status-file /work/health-status/managed_node_package_preparation.json
        return $?
    fi

    run_mcp_orc_generator \
        "$PROJECT_ROOT" \
        prepare-managed-node-packages \
        --enabled-only \
        --deployment-type docker \
        --best-effort \
        --status-file "$status_file"
}

validate_portico_llm_runtime_key() {
    local key="${PORTICO_LLM_API_KEY:-}"
    if [ -z "$key" ]; then
        echo -e "${RED}❌ PORTICO_LLM_API_KEY is missing. Configure installer/runtime secure sources (env, keychain), or use explicit plaintext fallback override if required.${NC}" >&2
        return 1
    fi

    if is_malformed_upstream_key "$key"; then
        echo -e "${RED}❌ PORTICO_LLM_API_KEY is malformed. Update installer/runtime secure sources with a valid upstream key.${NC}" >&2
        return 1
    fi

    return 0
}

# Ensure required volume files exist to prevent Docker from creating directories
# Self-healing: If any file exists as a directory, delete it and create as file
# PORTICO-364: a blank / whitespace-only JSON volume file is invalid. For
# mcp_toggles.json a 0-byte file (left by an interrupted non-atomic create)
# dead-ends every MCP toggle mutation and nothing else re-heals it.
json_file_is_blank() {
    local path="$1"
    [ -s "$path" ] || return 0
    [ -z "$(tr -d '[:space:]' <"$path" 2>/dev/null)" ]
}

# Write a valid empty JSON object atomically (tmp + mv) so an interrupted create
# can never leave a 0-byte file (PORTICO-364).
write_empty_json_object_atomic() {
    local path="$1"
    local tmp="${path}.$$.$RANDOM.tmp"
    printf '{}\n' >"$tmp"
    mv -f "$tmp" "$path"
}

ensure_volume_files() {
    echo -e "${BLUE}Ensuring required volume files exist...${NC}" >&2

    local files=(".env" "HOST_MODE" "mcp_toggles.json" "mcp_disable_modes.json" "mcp_config.json" "mcp_config_advanced.json" "mcp_config_core.json" "mcp_config_host_sideload.json" "mcp_tools_config.json" "marketplaces.json")

    for file in "${files[@]}"; do
        local filepath="$PROJECT_ROOT/$file"

        # Self-healing: If path exists as directory, remove it
        if [ -d "$filepath" ]; then
            echo -e "${YELLOW}⚠️  Found directory instead of file: $file - removing...${NC}" >&2
            rm -rf "$filepath"
            echo -e "${GREEN}✓ Removed directory: $file${NC}" >&2
        fi

        # Create file if it doesn't exist; also re-initialize an existing *.json
        # that is blank/whitespace-only (PORTICO-364: a 0-byte mcp_toggles.json left
        # by an interrupted non-atomic create dead-ends every toggle mutation).
        # JSON is written atomically so an interrupted create can't leave 0 bytes.
        if [ ! -f "$filepath" ]; then
            if [[ "$file" == *.json ]]; then
                write_empty_json_object_atomic "$filepath"
            else
                touch "$filepath"
            fi
            echo -e "${GREEN}✓ Created missing file: $file${NC}" >&2
        elif [[ "$file" == *.json ]] && json_file_is_blank "$filepath"; then
            write_empty_json_object_atomic "$filepath"
            echo -e "${GREEN}✓ Re-initialized blank JSON file: $file${NC}" >&2
        fi
    done

    # A directory bind keeps following atomic file replacements. Individual
    # file binds pin the old inode, which previously let the health-check
    # container read stale enablement state after mcp_toggles.json changed.
    mkdir -p "$PROJECT_ROOT/health-status"
    local toggle_snapshot="$PROJECT_ROOT/health-status/mcp_toggles_snapshot.json"
    local toggle_snapshot_tmp="$toggle_snapshot.$$.$RANDOM.tmp"
    cp "$PROJECT_ROOT/mcp_toggles.json" "$toggle_snapshot_tmp"
    mv "$toggle_snapshot_tmp" "$toggle_snapshot"

    # PORTICO-410: same rename-following guarantee for the hard-disable sidecar —
    # unified_context reads this snapshot first for prompt-time opacity.
    local disable_mode_snapshot="$PROJECT_ROOT/health-status/mcp_disable_modes_snapshot.json"
    local disable_mode_snapshot_tmp="$disable_mode_snapshot.$$.$RANDOM.tmp"
    cp "$PROJECT_ROOT/mcp_disable_modes.json" "$disable_mode_snapshot_tmp"
    mv "$disable_mode_snapshot_tmp" "$disable_mode_snapshot"
}

# Detect and export timezone for containers
export TZ=$(detect_timezone)
echo -e "${GREEN}Using timezone: $TZ${NC}" >&2

# Detect and export build tracking info for containers
export PORTICO_BUILD_TRACK=$(get_build_info)
echo -e "${GREEN}Using build: $PORTICO_BUILD_TRACK${NC}" >&2

# Export host project root for Docker-in-Docker volume mounts
# (agent-vm containers need host paths, not container paths)
export HOST_PROJECT_ROOT="$PROJECT_ROOT"
export CORE_MCP_AGENT_VM_IMAGE="$(resolve_agent_vm_runtime_image)"
echo -e "${GREEN}Using Agent VM image: ${CORE_MCP_AGENT_VM_IMAGE}${NC}" >&2

# Function to check if Docker is running
check_docker() {
    if ! docker info >/dev/null 2>&1; then
        echo "Docker is not running" >&2
        exit 1
    fi
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
        echo -e "${YELLOW}⚠ Harbor image arch mismatch: $image_ref is $image_arch, host expects $expected_arch${NC}" >&2
        return 1
    fi

    return 0
}

# Function to get container status
get_status() {
    # Core containers to check. mcpo is the shared control-plane container;
    # mcpo-core is just its network alias now, not a separate container.
    local containers=("llm-gateway" "mcpo" "portico-open-webui" "open-webui-health-check")
    local container_rows=""
    local status_json="{"
    local first=true

    # Take one daemon snapshot. Repeated `docker ps | grep` pipelines can pile
    # up when the Docker CLI wedges, especially under the Electron status poll.
    container_rows="$(docker ps -a --format $'{{.Names}}\t{{.State}}')"

    container_state_from_snapshot() {
        local target_name="$1"
        local row_name=""
        local row_state=""

        while IFS=$'\t' read -r row_name row_state; do
            if [ "$row_name" = "$target_name" ]; then
                printf '%s\n' "$row_state"
                return 0
            fi
        done <<< "$container_rows"
        return 1
    }

    for container in "${containers[@]}"; do
        local actual_container
        local container_state=""
        actual_container="$(resolve_container_name_for_service "$container")"
        container_state="$(container_state_from_snapshot "$actual_container" || true)"
        if [ "$first" = false ]; then
            status_json+=","
        fi
        first=false

        if [ "$container_state" = "running" ]; then
            status_json+="\"${container}\":\"running\""
        elif [ -n "$container_state" ]; then
            status_json+="\"${container}\":\"stopped\""
        else
            status_json+="\"${container}\":\"not_found\""
        fi
    done

    # Also check for per-server mcpo containers (mcpo-*)
    local row_name=""
    local row_state=""
    while IFS=$'\t' read -r row_name row_state; do
        if [[ "$row_name" == mcpo-* ]] && \
           [ "$row_name" != "mcpo-core" ] && \
           [ "$row_name" != "mcpo" ] && \
           [ "$row_state" = "running" ]; then
            status_json+=",\"${row_name}\":\"running\""
        fi
    done <<< "$container_rows"

    status_json+="}"
    echo "$status_json"
}

# Function to check if Harbor images exist locally
check_harbor_images_available() {
    local build_number="$1"
    local expected_arch
    expected_arch=$(get_host_docker_arch)
    local harbor_file="$PROJECT_ROOT/docker-compose.harbor.yml"
    local compose_images=""
    local compose_config_output=""
    local compose_config_exit_code=0
    local all_exist=true
    local compose_gateway_files=""
    local previous_bifrost_bridge_image="${BIFROST_BRIDGE_IMAGE-}"
    local previous_bifrost_bridge_image_was_set="${BIFROST_BRIDGE_IMAGE+x}"
    local previous_mcpo_harbor_image="${MCPO_HARBOR_IMAGE-}"
    local previous_mcpo_harbor_image_was_set="${MCPO_HARBOR_IMAGE+x}"
    local previous_mcpo_core_harbor_image="${MCPO_CORE_HARBOR_IMAGE-}"
    local previous_mcpo_core_harbor_image_was_set="${MCPO_CORE_HARBOR_IMAGE+x}"
    local previous_mcpo_control_plane_harbor_image="${MCPO_CONTROL_PLANE_HARBOR_IMAGE-}"
    local previous_mcpo_control_plane_harbor_image_was_set="${MCPO_CONTROL_PLANE_HARBOR_IMAGE+x}"
    local previous_openapi_aggregator_harbor_image="${OPENAPI_AGGREGATOR_HARBOR_IMAGE-}"
    local previous_openapi_aggregator_harbor_image_was_set="${OPENAPI_AGGREGATOR_HARBOR_IMAGE+x}"

    restore_harbor_probe_env() {
        if [ -n "$previous_bifrost_bridge_image_was_set" ]; then
            export BIFROST_BRIDGE_IMAGE="$previous_bifrost_bridge_image"
        else
            unset BIFROST_BRIDGE_IMAGE
        fi

        if [ -n "$previous_mcpo_harbor_image_was_set" ]; then
            export MCPO_HARBOR_IMAGE="$previous_mcpo_harbor_image"
        else
            unset MCPO_HARBOR_IMAGE
        fi

        if [ -n "$previous_mcpo_core_harbor_image_was_set" ]; then
            export MCPO_CORE_HARBOR_IMAGE="$previous_mcpo_core_harbor_image"
        else
            unset MCPO_CORE_HARBOR_IMAGE
        fi

        if [ -n "$previous_mcpo_control_plane_harbor_image_was_set" ]; then
            export MCPO_CONTROL_PLANE_HARBOR_IMAGE="$previous_mcpo_control_plane_harbor_image"
        else
            unset MCPO_CONTROL_PLANE_HARBOR_IMAGE
        fi

        if [ -n "$previous_openapi_aggregator_harbor_image_was_set" ]; then
            export OPENAPI_AGGREGATOR_HARBOR_IMAGE="$previous_openapi_aggregator_harbor_image"
        else
            unset OPENAPI_AGGREGATOR_HARBOR_IMAGE
        fi
    }

    if [ ! -f "$harbor_file" ]; then
        return 1
    fi

    export_mcp_orc_harbor_env "$build_number" "$MCP_ORC_MODE_RESOLVED"
    export BIFROST_BRIDGE_IMAGE="$(llm_gateway_harbor_image_name "$build_number" "$LLM_GATEWAY_MODE_RESOLVED")"

    if [ -f "$PROJECT_ROOT/docker-compose.override.yml" ]; then
        set +e
        compose_config_output=$(run_docker_compose \
            -f docker-compose.yml \
            -f docker-compose.advanced.yml \
            -f docker-compose.override.yml \
            -f docker-compose.harbor.yml \
            $compose_gateway_files \
            config --images 2>&1)
        compose_config_exit_code=$?
        set -e
    else
        set +e
        compose_config_output=$(run_docker_compose \
            -f docker-compose.yml \
            -f docker-compose.advanced.yml \
            -f docker-compose.harbor.yml \
            $compose_gateway_files \
            config --images 2>&1)
        compose_config_exit_code=$?
        set -e
    fi

    if [ "$compose_config_exit_code" -ne 0 ]; then
        if docker_compose_output_indicates_unavailable "$compose_config_output"; then
            echo "$compose_config_output" >&2
            restore_harbor_probe_env
            return 125
        fi
        echo -e "${RED}❌ Docker compose config failed while probing Harbor images${NC}" >&2
        echo "$compose_config_output" >&2
        restore_harbor_probe_env
        return 1
    fi

    compose_images=$(printf '%s\n' "$compose_config_output" | grep '^harbor\.portico\.tech/portico/' | sort -u || true)

    if [ -z "$compose_images" ]; then
        restore_harbor_probe_env
        return 1
    fi

    while IFS= read -r image_tag; do
        [ -n "$image_tag" ] || continue
        if ! docker image inspect "$image_tag" >/dev/null 2>&1; then
            all_exist=false
            break
        fi

        if ! image_matches_host_arch "$image_tag" "$expected_arch"; then
            all_exist=false
            break
        fi
    done <<< "$compose_images"

    restore_harbor_probe_env

    if [ "$all_exist" = true ]; then
        return 0
    else
        return 1
    fi
}

# Candidate helper images for privileged layerdb cleanup.
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

# Best-effort cleanup for transient Docker layer registration failures.
cleanup_failed_register_layer_images() {
    local compose_files="$1"
    local failure_output="$2"
    local attempted_cleanup=false

    echo -e "${YELLOW}⚠ Detected 'failed to register layer'. Cleaning up cached image state before retry...${NC}" >&2

    local matched_images=()
    while IFS= read -r image; do
        [ -z "$image" ] && continue
        local short_name="${image##*/}"
        short_name="${short_name%%:*}"
        if echo "$failure_output" | grep -qiF "$short_name"; then
            matched_images+=("$image")
        fi
    done < <(run_docker_compose $compose_files config --images 2>/dev/null || true)

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

container_name_for_compose_service() {
    local service_name="$1"

    case "$service_name" in
        open-webui)
            echo "portico-open-webui"
            ;;
        health-check)
            echo "open-webui-health-check"
            ;;
        redis)
            echo "portico-redis"
            ;;
        mongodb)
            echo "portico-mongodb"
            ;;
        llm-gateway)
            get_llm_gateway_container_name
            ;;
        *)
            echo "$service_name"
            ;;
    esac
}

list_expected_compose_container_names() {
    local compose_files="$1"

    run_docker_compose $compose_files config --services 2>/dev/null \
        | while IFS= read -r service_name; do
            [ -n "$service_name" ] || continue
            container_name_for_compose_service "$service_name"
        done \
        | sed '/^$/d' \
        | sort -u
}

is_expected_compose_container_name() {
    local compose_files="$1"
    local container_name="$2"

    [ -n "$container_name" ] || return 1
    list_expected_compose_container_names "$compose_files" | grep -Fxq "$container_name"
}

extract_compose_container_name_conflicts() {
    local failure_output="$1"

    echo "$failure_output" \
        | sed -nE 's/.*container name "\/?([^"]+)".*already in use.*/\1/p' \
        | sed '/^$/d' \
        | sort -u
}

cleanup_compose_container_name_conflicts() {
    local compose_files="$1"
    local failure_output="$2"
    local removed_any=false
    local conflict_name=""

    while IFS= read -r conflict_name; do
        [ -n "$conflict_name" ] || continue
        if is_expected_compose_container_name "$compose_files" "$conflict_name"; then
            echo -e "${YELLOW}⚠ Removing stale conflicting app container: ${conflict_name}${NC}" >&2
            docker rm -f "$conflict_name" >/dev/null 2>&1 || true
            removed_any=true
        else
            echo -e "${YELLOW}⚠ Docker reported a name conflict for non-app container '${conflict_name}'; leaving it untouched${NC}" >&2
        fi
    done < <(extract_compose_container_name_conflicts "$failure_output")

    [ "$removed_any" = true ]
}

# ==============================================================================
# Cross-runtime (Docker context) stale stack handling — PORTICO-236
# ==============================================================================
# A mid-setup Docker runtime switch (e.g. Docker Desktop -> OrbStack) can leave
# the app's compose stack running on the OLD local daemon, still holding the
# app's published host ports (chat-state-api publishes 3835). compose up on the
# new daemon then fails every attempt with "ports are not available ... bind:
# address already in use". These helpers detect app-labeled containers on OTHER
# local Docker daemons and remove them there (containers only — volumes and
# networks on the other daemon are left untouched).

PORTICO_COMPOSE_PROJECT_LABELS=(
    "portico"
    "portico-single"
)

docker_daemon_id() {
    local ctx="${1:-}"
    if [ -n "$ctx" ]; then
        docker --context "$ctx" info --format '{{.ID}}' 2>/dev/null || true
    else
        docker info --format '{{.ID}}' 2>/dev/null || true
    fi
}

compose_output_indicates_port_conflict() {
    local output="${1:-}"
    printf '%s\n' "$output" | grep -qiE 'ports are not available|bind: address already in use'
}

extract_conflicting_host_port() {
    local output="${1:-}"
    local port=""
    port=$(printf '%s\n' "$output" | sed -nE 's/.*listen tcp [0-9.]*:([0-9]+).*/\1/p' | head -n 1 || true)
    if [ -z "$port" ]; then
        port=$(printf '%s\n' "$output" | sed -nE 's/.*exposing port TCP [0-9.]*:([0-9]+).*/\1/p' | head -n 1 || true)
    fi
    printf '%s\n' "$port"
}

normalize_port_holder_name() {
    local raw="${1:-}"
    case "$raw" in
        "")
            echo "unknown"
            ;;
        com.docker*|com.docke*)
            # Docker Desktop helper processes (com.docker.backend / com.docker.vpnkit);
            # the second pattern covers lsof's default 9-char COMMAND truncation.
            echo "Docker Desktop"
            ;;
        OrbStack*|orbstack*|com.orbstack*)
            echo "OrbStack"
            ;;
        *)
            echo "$raw"
            ;;
    esac
}

# Emit a single greppable diagnostic line for a compose host-port conflict.
# The Electron classifier parses this line to name the conflicting runtime in
# the initialization error banner. Best-effort only — never fails the script.
report_compose_port_conflict() {
    local compose_output="${1:-}"
    local port=""
    local holder_raw=""
    local holder=""
    local active_context=""

    port="$(extract_conflicting_host_port "$compose_output")"
    active_context="$(docker context show 2>/dev/null || true)"
    [ -n "$active_context" ] || active_context="unknown"

    if [ -n "$port" ] && command -v lsof >/dev/null 2>&1; then
        # +c 0 disables lsof's 9-char COMMAND truncation so holder names like
        # com.docker.backend survive intact.
        holder_raw=$(lsof +c 0 -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1}' || true)
    fi
    holder="$(normalize_port_holder_name "$holder_raw")"

    echo -e "${RED}❌ PORT_CONFLICT: host port ${port:-unknown} is already in use (holder: ${holder}; active docker context: ${active_context})${NC}" >&2
    echo -e "${YELLOW}   Another Docker runtime may still be running the Portico stack (e.g. Docker Desktop after a switch to OrbStack).${NC}" >&2
}

# Remove app-labeled containers that are running on a DIFFERENT local Docker
# daemon than the active one. Only unix:// endpoints are probed (a remote
# daemon cannot hold 127.0.0.1 ports), unreachable daemons are skipped fast,
# and contexts that alias the ACTIVE daemon are skipped via daemon-ID compare
# so the live stack is never touched. Returns 0 iff anything was removed.
cleanup_project_on_other_docker_contexts() {
    local removed_any=false
    local current_context=""
    local current_id=""
    local ctx_line=""
    local ctx_name=""
    local ctx_endpoint=""
    local other_id=""
    local project_label=""
    local stale_ids=""

    if [ "${PORTICO_SKIP_CROSS_CONTEXT_CLEANUP:-0}" = "1" ]; then
        echo -e "${YELLOW}⚠ Skipping cross-context stale stack check (PORTICO_SKIP_CROSS_CONTEXT_CLEANUP=1)${NC}" >&2
        return 1
    fi

    current_id="$(docker_daemon_id "")"
    if [ -z "$current_id" ]; then
        # Cannot identify the active daemon — never guess, never delete.
        return 1
    fi
    current_context="$(docker context show 2>/dev/null || true)"

    while IFS= read -r ctx_line; do
        [ -n "$ctx_line" ] || continue
        ctx_name="${ctx_line%%|*}"
        ctx_endpoint="${ctx_line#*|}"

        [ -n "$ctx_name" ] || continue
        if [ "$ctx_name" = "$current_context" ]; then
            continue
        fi
        case "$ctx_endpoint" in
            unix://*) ;;
            *) continue ;;
        esac

        other_id="$(docker_daemon_id "$ctx_name")"
        # Unreachable daemon (e.g. Docker Desktop quit) or alias of the active
        # daemon — skip either way.
        [ -n "$other_id" ] || continue
        if [ "$other_id" = "$current_id" ]; then
            continue
        fi

        for project_label in "${PORTICO_COMPOSE_PROJECT_LABELS[@]}"; do
            stale_ids="$(docker --context "$ctx_name" ps -aq --filter "label=com.docker.compose.project=${project_label}" 2>/dev/null || true)"
            [ -n "$stale_ids" ] || continue
            echo -e "${YELLOW}⚠ Portico containers (project ${project_label}) found on another Docker runtime (context '${ctx_name}'); removing them there to free the app's host ports${NC}" >&2
            if printf '%s\n' "$stale_ids" | xargs docker --context "$ctx_name" rm -f >/dev/null 2>&1; then
                removed_any=true
            fi
        done
    done < <(docker context ls --format '{{.Name}}|{{.DockerEndpoint}}' 2>/dev/null || true)

    if [ "$removed_any" = true ]; then
        echo -e "${GREEN}✓ Removed stale Portico containers from other Docker runtime(s)${NC}" >&2
    fi

    [ "$removed_any" = true ]
}

cleanup_stale_app_mcp_containers() {
    local compose_files="$1"
    local force_recreate="${2:-}"
    local expected_names=""
    local removed_any=false
    local container_name=""
    local service_name=""
    local canonical_name=""
    local stale_names=""

    expected_names="$(list_expected_compose_container_names "$compose_files")"
    [ -n "$expected_names" ] || return 0

    while IFS= read -r service_name; do
        [ -n "$service_name" ] || continue
        case "$service_name" in
            mcpo-*)
                canonical_name="$(container_name_for_compose_service "$service_name")"
                stale_names=$(docker ps -a \
                    --filter "label=com.docker.compose.project=portico" \
                    --filter "label=com.docker.compose.service=${service_name}" \
                    --format "{{.Names}}" 2>/dev/null | grep -vx "$canonical_name" || true)

                if [ -n "$stale_names" ]; then
                    echo -e "${YELLOW}Removing stale ${service_name} container(s): ${stale_names//$'\n'/, }${NC}" >&2
                    echo "$stale_names" | xargs -r docker rm -f >/dev/null 2>&1 || true
                    removed_any=true
                fi
                ;;
        esac
    done < <(run_docker_compose $compose_files config --services 2>/dev/null || true)

    if [ -n "$force_recreate" ]; then
        while IFS= read -r container_name; do
            [ -n "$container_name" ] || continue
            case "$container_name" in
                mcpo-*)
                    if docker ps -a --format "{{.Names}}" 2>/dev/null | grep -Fxq "$container_name"; then
                        echo -e "${YELLOW}Removing existing MCP runtime container before forced recreate: ${container_name}${NC}" >&2
                        docker rm -f "$container_name" >/dev/null 2>&1 || true
                        removed_any=true
                    fi
                    ;;
            esac
        done <<< "$expected_names"
    fi

    while IFS= read -r container_name; do
        [ -n "$container_name" ] || continue
        case "$container_name" in
            mcpo-*)
                if ! echo "$expected_names" | grep -Fxq "$container_name"; then
                    echo -e "${YELLOW}Removing orphaned app-owned MCP runtime container: ${container_name}${NC}" >&2
                    docker rm -f "$container_name" >/dev/null 2>&1 || true
                    removed_any=true
                fi
                ;;
        esac
    done < <(
        docker ps -a \
            --filter "label=com.docker.compose.project=portico" \
            --format "{{.Names}}" 2>/dev/null \
            | sort -u
    )

    if [ "$removed_any" = true ]; then
        echo -e "${GREEN}✓ Removed stale app-owned MCP runtime containers${NC}" >&2
    fi
}

extract_docker_run_image_from_args() {
    local args=("$@")
    local seen_run=false
    local skip_next=false
    local arg=""

    for arg in "${args[@]}"; do
        if [ "$seen_run" = false ]; then
            [ "$arg" = "run" ] && seen_run=true
            continue
        fi

        if [ "$skip_next" = true ]; then
            skip_next=false
            continue
        fi

        case "$arg" in
            --)
                skip_next=false
                continue
                ;;
            --add-host|--annotation|--attach|-a|--blkio-weight|--cap-add|--cap-drop|--cgroup-parent|--cidfile|--cpuset-cpus|--cpuset-mems|--dns|--dns-option|--dns-search|--entrypoint|--env|-e|--env-file|--expose|--gpus|--group-add|--health-cmd|--health-interval|--health-retries|--health-start-interval|--health-start-period|--health-timeout|--hostname|-h|--ip|--ip6|--label|-l|--label-file|--link|--log-driver|--log-opt|--mac-address|--memory|-m|--memory-reservation|--memory-swap|--memory-swappiness|--mount|--name|--network|--network-alias|--oom-score-adj|--pid|--platform|--publish|-p|--pull|--restart|--runtime|--security-opt|--shm-size|--stop-signal|--stop-timeout|--storage-opt|--sysctl|--ulimit|--user|-u|--userns|--volume|-v|--volumes-from|--workdir|-w)
                skip_next=true
                continue
                ;;
            --*=*)
                continue
                ;;
            -*)
                continue
                ;;
            *)
                echo "$arg"
                return 0
                ;;
        esac
    done

    return 1
}

list_declared_mcp_docker_run_images() {
    command -v jq >/dev/null 2>&1 || return 0

    local search_roots=(
        "$PROJECT_ROOT/mcpo-configs-generated"
        "$PROJECT_ROOT/mcp-configs"
        "$PROJECT_ROOT/mcp-configs-user"
    )
    local root=""
    local file_path=""
    local args_line=""

    for root in "${search_roots[@]}"; do
        [ -d "$root" ] || continue
        while IFS= read -r file_path; do
            [ -n "$file_path" ] || continue
            while IFS= read -r args_line; do
                [ -n "$args_line" ] || continue
                IFS=$'\t' read -r -a docker_args <<< "$args_line"
                extract_docker_run_image_from_args "${docker_args[@]}" || true
            done < <(
                jq -r '
                  .. | objects
                  | select(.command? == "docker" and (.args? | type == "array"))
                  | .args
                  | @tsv
                ' "$file_path" 2>/dev/null || true
            )
        done < <(find "$root" -type f \( -name '*.json' -o -name '*.fragment' \) 2>/dev/null)
    done | sed '/^$/d' | sort -u
}

cleanup_mcp_docker_run_child_containers() {
    local removed_any=false
    local image_ref=""
    local child_containers=""

    while IFS= read -r image_ref; do
        [ -n "$image_ref" ] || continue
        child_containers="$(docker ps -aq --filter "ancestor=${image_ref}" 2>/dev/null || true)"
        [ -n "$child_containers" ] || continue

        echo -e "${YELLOW}Removing Docker-backed MCP child container(s) for ${image_ref}${NC}" >&2
        echo "$child_containers" | xargs -r docker rm -f >/dev/null 2>&1 || true
        removed_any=true
    done < <(list_declared_mcp_docker_run_images)

    if [ "$removed_any" = true ]; then
        echo -e "${GREEN}✓ Removed stale Docker-backed MCP child containers${NC}" >&2
    fi
}

docker_output_indicates_missing_overlayfs_snapshot_parent() {
    local output="$1"
    printf '%s\n' "$output" \
        | tr -d '\r' \
        | awk '
            /^[[:space:]]*Container [A-Za-z0-9_.-]+ Error response from daemon: failed to stat parent: stat \/var\/lib\/docker\/containerd\/daemon\/io\.containerd\.snapshotter\.v1\.overlayfs\/snapshots\/[0-9]+\/fs: no such file or directory[[:space:]]*$/ ||
            /^[[:space:]]*Error response from daemon: failed to stat parent: stat \/var\/lib\/docker\/containerd\/daemon\/io\.containerd\.snapshotter\.v1\.overlayfs\/snapshots\/[0-9]+\/fs: no such file or directory[[:space:]]*$/ {
                exact_count += 1
                next
            }
            /^[[:space:]]*(Container|Network|Volume) [^[:space:]]+ (Creating|Created|Recreate|Recreated|Recreating|Starting|Started|Restarting|Restarted|Stopping|Stopped|Waiting|Healthy|Running)[[:space:]]*$/ {
                next
            }
            NF { unexpected_line = 1 }
            END { exit (exact_count > 0 && unexpected_line == 0) ? 0 : 1 }
        '
}

docker_output_contains_missing_overlayfs_snapshot_parent() {
    local output="$1"
    local normalized_output=""
    normalized_output="$(printf '%s\n' "$output" | tr -d '\r')"
    printf '%s\n' "$normalized_output" | grep -Eqi 'failed to stat parent' &&
        printf '%s\n' "$normalized_output" \
            | grep -Eqi '/var/lib/docker/containerd/daemon/io\.containerd\.snapshotter\.v1\.overlayfs/snapshots/[^[:space:]]+/fs'
}

repair_missing_overlayfs_snapshot_images() {
    "$SCRIPT_DIR/repair-missing-overlayfs-snapshot-images.sh" \
        --apply-missing-overlayfs-parent-repair
}

run_compose_up_with_retry() {
    local compose_files="$1"
    local force_recreate="$2"
    local extra_args="${3:-}"
    local max_attempts=3
    local attempt=1
    local compose_output=""
    local compose_exit_code=1
    local conflict_cleanup_done=false
    local port_conflict_cleanup_done=false
    local snapshot_store_repair_attempted=false

    # Log the services that will be started (helpful for debugging)
    echo -e "${BLUE}Services to be started:${NC}" >&2
    run_docker_compose $compose_files config --services 2>/dev/null | head -30 | while read svc; do
        echo "  - $svc" >&2
    done

    while [ "$attempt" -le "$max_attempts" ]; do
        echo "Starting docker compose (attempt ${attempt}/${max_attempts})..."

        compose_output=""
        if compose_output=$(run_docker_compose $compose_files up -d $force_recreate $extra_args 2>&1); then
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

        # PORTICO-415: this exact daemon error is permanent across generic retries.
        # Refresh only the fixed PORTICO image allowlist once, then immediately
        # replay the complete Compose operation. The repair helper fails closed
        # before mutation when the local daemon cannot be proven safe.
        if docker_output_indicates_missing_overlayfs_snapshot_parent "$compose_output"; then
            if [ "$snapshot_store_repair_attempted" = true ]; then
                echo "Docker's missing overlayfs parent snapshot error repeated after image-only repair; refusing further retries." >&2
                return "$compose_exit_code"
            fi
            snapshot_store_repair_attempted=true

            echo "Docker's local image snapshot cache is inconsistent; attempting one scoped image-only repair..." >&2
            if ! repair_missing_overlayfs_snapshot_images; then
                echo "Scoped Docker image repair could not complete safely; refusing Compose retries." >&2
                return "$compose_exit_code"
            fi

            echo "Scoped Docker image repair completed; replaying Docker Compose once..." >&2
            compose_output=""
            if compose_output=$(run_docker_compose $compose_files up -d $force_recreate $extra_args 2>&1); then
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
            if docker_output_indicates_missing_overlayfs_snapshot_parent "$compose_output"; then
                echo "Docker's missing overlayfs parent snapshot error repeated after image-only repair; refusing further retries." >&2
                return "$compose_exit_code"
            fi
            echo "Docker Compose replay failed after scoped image repair; refusing unrelated cleanup or retries." >&2
            return "$compose_exit_code"
        fi

        if docker_output_contains_missing_overlayfs_snapshot_parent "$compose_output"; then
            echo "Docker's missing overlayfs parent snapshot signature was mixed with other output; refusing repair, cleanup, or retries." >&2
            return "$compose_exit_code"
        fi

        if docker_compose_output_indicates_unavailable "$compose_output"; then
            return "$compose_exit_code"
        fi

        if echo "$compose_output" | grep -qi "failed to register layer"; then
            cleanup_failed_register_layer_images "$compose_files" "$compose_output"
        fi

        # PORTICO-236: a host-port conflict usually means the app's stack is still
        # running on a different local Docker runtime (Docker Desktop vs
        # OrbStack). Surface a parseable diagnostic and self-heal once by
        # removing the app's containers on the other daemon, then retry.
        if compose_output_indicates_port_conflict "$compose_output"; then
            report_compose_port_conflict "$compose_output"
            if [ "$port_conflict_cleanup_done" = false ]; then
                port_conflict_cleanup_done=true
                cleanup_project_on_other_docker_contexts || true
            fi
        fi

        if [ "$conflict_cleanup_done" = false ] && cleanup_compose_container_name_conflicts "$compose_files" "$compose_output"; then
            conflict_cleanup_done=true
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

# Critical infrastructure services that MUST be running for the app to function
# These are verified after docker compose up to catch silent failures
CRITICAL_INFRASTRUCTURE_SERVICES=("redis" "mongodb")

# Verify compose configuration is valid before starting
validate_compose_config() {
    local compose_files="$1"
    echo -e "${BLUE}Validating compose configuration...${NC}" >&2

    local config_output
    local config_exit_code

    config_output=$(run_docker_compose $compose_files config 2>&1)
    config_exit_code=$?

    if [ $config_exit_code -ne 0 ]; then
        echo -e "${RED}❌ Compose configuration validation failed!${NC}" >&2
        echo "$config_output" >&2
        return 1
    fi

    # Verify critical services are defined in the merged config
    for service in "${CRITICAL_INFRASTRUCTURE_SERVICES[@]}"; do
        if ! echo "$config_output" | grep -q "^  ${service}:"; then
            echo -e "${RED}❌ Critical service '$service' not found in compose configuration!${NC}" >&2
            return 1
        fi
    done

    echo -e "${GREEN}✓ Compose configuration is valid${NC}" >&2
    return 0
}

# Verify critical infrastructure services are running after startup
verify_critical_services() {
    local max_wait=30
    local check_interval=2
    local elapsed=0

    echo -e "${BLUE}Verifying critical infrastructure services...${NC}" >&2

    while [ $elapsed -lt $max_wait ]; do
        local all_running=true
        local missing_services=""

        for service in "${CRITICAL_INFRASTRUCTURE_SERVICES[@]}"; do
            local container_name=""
            case "$service" in
                redis) container_name="portico-redis" ;;
                mongodb) container_name="portico-mongodb" ;;
                *) container_name="$service" ;;
            esac

            # Check if container exists and is running
            local container_status
            container_status=$(docker inspect --format '{{.State.Status}}' "$container_name" 2>/dev/null || echo "not_found")

            if [ "$container_status" != "running" ]; then
                all_running=false
                missing_services="$missing_services $service($container_status)"
            fi
        done

        if $all_running; then
            echo -e "${GREEN}✓ All critical infrastructure services are running${NC}" >&2
            return 0
        fi

        if [ $elapsed -eq 0 ]; then
            echo -e "${YELLOW}Waiting for critical services:$missing_services${NC}" >&2
        fi

        sleep $check_interval
        elapsed=$((elapsed + check_interval))
    done

    # Timeout - try to start missing services explicitly
    echo -e "${YELLOW}⚠ Some critical services not running after ${max_wait}s, attempting explicit start...${NC}" >&2

    local recovery_needed=false
    for service in "${CRITICAL_INFRASTRUCTURE_SERVICES[@]}"; do
        local container_name=""
        case "$service" in
            redis) container_name="portico-redis" ;;
            mongodb) container_name="portico-mongodb" ;;
            *) container_name="$service" ;;
        esac

        local container_status
        container_status=$(docker inspect --format '{{.State.Status}}' "$container_name" 2>/dev/null || echo "not_found")

        if [ "$container_status" != "running" ]; then
            echo -e "${YELLOW}Starting $service explicitly...${NC}" >&2
            # Use the compose files from the calling context (passed as $1)
            local compose_files="${1:-}"
            if [ -n "$compose_files" ]; then
                run_docker_compose $compose_files up -d "$service" 2>&1 || true
            else
                run_docker_compose up -d "$service" 2>&1 || true
            fi
            recovery_needed=true
        fi
    done

    if $recovery_needed; then
        # Wait a bit for services to start
        sleep 5

        # Final verification
        local final_check_passed=true
        for service in "${CRITICAL_INFRASTRUCTURE_SERVICES[@]}"; do
            local container_name=""
            case "$service" in
                redis) container_name="portico-redis" ;;
                mongodb) container_name="portico-mongodb" ;;
                *) container_name="$service" ;;
            esac

            local container_status
            container_status=$(docker inspect --format '{{.State.Status}}' "$container_name" 2>/dev/null || echo "not_found")

            if [ "$container_status" = "running" ]; then
                echo -e "${GREEN}✓ $service is now running${NC}" >&2
            else
                echo -e "${RED}❌ $service failed to start (status: $container_status)${NC}" >&2
                # Show container logs for debugging
                echo -e "${YELLOW}Last 10 lines of $container_name logs:${NC}" >&2
                docker logs --tail 10 "$container_name" 2>&1 || echo "No logs available" >&2
                final_check_passed=false
            fi
        done

        if ! $final_check_passed; then
            echo -e "${RED}❌ Critical infrastructure services failed to start. Check Docker logs.${NC}" >&2
            return 1
        fi
    fi

    return 0
}

cleanup_duplicate_project_service_containers() {
    local project_name="portico"
    local cleanup_targets=(
        "llm-gateway:${LLM_GATEWAY_CONTAINER_NAME}"
        "open-webui:portico-open-webui"
        "health-check:open-webui-health-check"
        "mcpo:mcpo"
        "chat-state-api:chat-state-api"
        "llm-debug-monitor:llm-debug-monitor"
        "redis:portico-redis"
        "mongodb:portico-mongodb"
    )

    local removed_any=false

    for target in "${cleanup_targets[@]}"; do
        local service_name="${target%%:*}"
        local canonical_name="${target##*:}"
        local stale_names=""

        stale_names=$(docker ps -a \
            --filter "label=com.docker.compose.project=${project_name}" \
            --filter "label=com.docker.compose.service=${service_name}" \
            --format "{{.Names}}" 2>/dev/null | grep -vx "$canonical_name" || true)

        if [ -n "$stale_names" ]; then
            removed_any=true
            echo -e "${YELLOW}Removing stale ${service_name} container(s): ${stale_names//$'\n'/, }${NC}" >&2
            echo "$stale_names" | xargs -r docker rm -f >/dev/null 2>&1 || true
        fi
    done

    if [ "$removed_any" = true ]; then
        echo -e "${GREEN}✓ Removed stale duplicate project service containers${NC}" >&2
    fi
}

# Function to start containers
start_containers() {
    local mode="advanced"
    local dev_mode=""
    local build_number=""
    local runtime_preflight_refreshed=false

    require_docker_compose_frontend || return $?
    prepare_compose_runtime_env
    validate_portico_llm_runtime_key || return 1

    # Parse arguments - support both "start --dev" and "start advanced --dev"
    for arg in "$@"; do
        case "$arg" in
            --dev) dev_mode="--dev" ;;
            simple|advanced) mode="$arg" ;;
        esac
    done

    # Also check for .dev-mode marker file
    if [ -f "$PROJECT_ROOT/.dev-mode" ]; then
        dev_mode="--dev"
    fi

    echo "Starting Docker containers in $mode mode..."
    echo "Using MCP mode: ${MCP_ORC_MODE_RESOLVED:-rust-full}"

    # Ensure .env file exists
    if [ ! -f .env ]; then
        echo "Error: .env file not found" >&2
        exit 1
    fi

    # CRITICAL: Remove runtime-delivered secrets from .env (defense in depth).
    # CLOUDSMITH_API_KEY is protected release-operator input and is never
    # delivered to Compose services, so this sanitizer must preserve it.
    clean_env_file

    # CRITICAL: Ensure volume mount files exist to prevent Docker directory creation
    ensure_volume_files
    prepare_managed_node_mcp_packages

    cleanup_duplicate_project_service_containers
    build_number="$(get_image_tag)"

    # PORTICO-236: phase markers for check-containers-ready.sh. While a live
    # docker-compose.sh start run has not yet reached compose up (packaged
    # preflight may pull images for minutes), the readiness script must not
    # consume its wait budget. The EXIT trap covers every exit path.
    mkdir -p "$PROJECT_ROOT/health-status" 2>/dev/null || true
    rm -f "$PROJECT_ROOT/health-status/compose_up_started" 2>/dev/null || true
    echo "$$" > "$PROJECT_ROOT/health-status/docker_start_in_progress" 2>/dev/null || true
    trap 'rm -f "$PROJECT_ROOT/health-status/docker_start_in_progress"' EXIT

    # PORTICO-236: if the app's stack is still running on a DIFFERENT local Docker
    # runtime (e.g. Docker Desktop after a mid-setup switch to OrbStack), it
    # still holds the app's published host ports and compose up here would
    # fail with "ports are not available". Clean it up there first.
    cleanup_project_on_other_docker_contexts || true

    if [ "$mode" != "simple" ] && managed_runtime_is_packaged_runtime "$PROJECT_ROOT" "$build_number"; then
        echo -e "${BLUE}Running packaged runtime preflight for build $build_number${NC}"
        if ! managed_runtime_self_heal_packaged_runtime "$PROJECT_ROOT" "$SCRIPT_DIR"; then
            echo -e "${RED}❌ Packaged runtime repair failed before Docker startup${NC}" >&2
            return 1
        fi
        runtime_preflight_refreshed=true
    fi

    if [ "$mode" != "simple" ]; then
        if [ "$runtime_preflight_refreshed" = true ]; then
            echo -e "${BLUE}Skipping generated MCPO compose override refresh (already refreshed by packaged runtime preflight)${NC}"
        elif [ "${MCPO_SKIP_GENERATED_OVERRIDE_REFRESH:-0}" = "1" ]; then
            echo -e "${BLUE}Skipping generated MCPO compose override refresh (already refreshed by caller)${NC}"
        elif resolve_mcp_orc_generator_binary "$PROJECT_ROOT" >/dev/null 2>&1; then
            echo -e "${BLUE}Refreshing generated MCPO compose overrides for MCP_ORC_MODE=${MCP_ORC_MODE_RESOLVED}${NC}"
            run_mcp_orc_generator "$PROJECT_ROOT" generate-docker-compose-override
        else
            echo -e "${YELLOW}⚠ Unable to resolve mcp-orc generator binary - skipping generated MCPO compose override refresh${NC}"
        fi
    fi

    # Build compose files list
    local COMPOSE_FILES=""
    local FORCE_RECREATE=""

    # Start containers with appropriate compose files
    if [ "$mode" = "simple" ]; then
        COMPOSE_FILES="-f docker-compose.simple.yml"
    else
        # Include override file for per-server MCPO containers if it exists
        # IMPORTANT: Override file must come LAST to properly reset base config keys
        if [ -f "$PROJECT_ROOT/docker-compose.override.yml" ]; then
            COMPOSE_FILES="-f docker-compose.yml -f docker-compose.advanced.yml -f docker-compose.override.yml"
            echo -e "${GREEN}✓ Using per-server MCPO containers (docker-compose.override.yml)${NC}"
        else
            COMPOSE_FILES="-f docker-compose.yml -f docker-compose.advanced.yml"
            echo -e "${YELLOW}⚠ No docker-compose.override.yml found - run bash src/scripts/mcp-orc-cli.sh generate-mcp-config first${NC}"
        fi

        # Check if Harbor images are available locally
        if [ -n "$build_number" ] && check_harbor_images_available "$build_number"; then
            export_mcp_orc_harbor_env "$build_number" "$MCP_ORC_MODE_RESOLVED"
            export BIFROST_BRIDGE_IMAGE="$(llm_gateway_harbor_image_name "$build_number" "$LLM_GATEWAY_MODE_RESOLVED")"
            echo -e "${GREEN}✓ Using pre-built Harbor images (build: $build_number)${NC}"
            COMPOSE_FILES="${COMPOSE_FILES} -f docker-compose.harbor.yml"
            # Force recreation to ensure containers use the new image tags
            FORCE_RECREATE="--force-recreate"
            echo -e "${BLUE}🔄 Containers will be recreated to use Harbor images${NC}"
        elif managed_runtime_is_packaged_runtime "$PROJECT_ROOT" "$build_number"; then
            echo -e "${RED}❌ Packaged runtime requires Harbor images for build $build_number; aborting instead of falling back to local Dockerfile builds${NC}" >&2
            return 1
        else
            echo -e "${YELLOW}⚠ Harbor images not found locally, will use local images or build if needed${NC}"
        fi
    fi

    if [ "$mode" != "simple" ]; then
        append_llm_gateway_compose_file COMPOSE_FILES || return 1
    fi

    # DEBUG MONITOR: Include for local (non-packaged) dev builds
    if [ "$build_number" = "dev-build" ] && [ -f "$PROJECT_ROOT/dev/docker-compose.debug-monitor.yml" ]; then
        COMPOSE_FILES="${COMPOSE_FILES} -f dev/docker-compose.debug-monitor.yml"
    fi

    # DEV MODE: Include dev compose file for frontend hot-reload
    if [ "$dev_mode" = "--dev" ] && [ -f "$PROJECT_ROOT/dev/docker-compose.dev.yml" ]; then
        echo -e "${BLUE}🔧 DEV MODE: Using Vite hot-reload for frontend${NC}"
        COMPOSE_FILES="${COMPOSE_FILES} -f dev/docker-compose.dev.yml"
        FORCE_RECREATE="--force-recreate"
        echo -e "${YELLOW}   Frontend available at http://localhost:3790 (dev server)${NC}"
    fi

    # Validate compose configuration before starting
    if ! validate_compose_config "$COMPOSE_FILES"; then
        echo -e "${RED}❌ Aborting startup due to invalid compose configuration${NC}" >&2
        return 1
    fi

    cleanup_stale_app_mcp_containers "$COMPOSE_FILES" "$FORCE_RECREATE"
    cleanup_mcp_docker_run_child_containers

    echo "Starting with: $COMPOSE_FILES $FORCE_RECREATE"
    # PORTICO-236: compose up begins now — from here on the readiness script's
    # normal wait budget applies (see check-containers-ready.sh).
    printf '%s %s\n' "$(date +%s)" "$$" > "$PROJECT_ROOT/health-status/compose_up_started" 2>/dev/null || true
    if run_compose_up_with_retry "$COMPOSE_FILES" "$FORCE_RECREATE"; then
        echo "Docker compose up completed"

        if ! ensure_llm_gateway_runtime_secret_mounts "$COMPOSE_FILES"; then
            echo -e "${RED}❌ llm-gateway runtime secret mount verification failed${NC}" >&2
            return 1
        fi

        if ! ensure_core_runtime_secret_mounts "$COMPOSE_FILES"; then
            echo -e "${RED}❌ Core runtime secret mount verification failed${NC}" >&2
            return 1
        fi

        # CRITICAL: Verify critical infrastructure services are running
        # This catches silent failures where docker compose up succeeds but services don't start
        if ! verify_critical_services "$COMPOSE_FILES"; then
            echo -e "${RED}❌ Critical infrastructure verification failed${NC}" >&2
            return 1
        fi

        echo -e "${GREEN}✓ All containers started successfully${NC}"
    else
        echo -e "${RED}❌ Docker compose up failed${NC}" >&2
        return 1
    fi
}

# Function to stop containers
stop_containers() {
    require_docker_compose_frontend || return $?
    prepare_compose_runtime_env
    echo "Stopping Docker containers..."
    run_docker_compose -p portico down --remove-orphans
    local COMPOSE_FILES="-f docker-compose.yml -f docker-compose.advanced.yml"
    if [ -f "$PROJECT_ROOT/docker-compose.override.yml" ]; then
        COMPOSE_FILES="${COMPOSE_FILES} -f docker-compose.override.yml"
    fi
    append_llm_gateway_compose_file COMPOSE_FILES || return 1
    run_docker_compose $COMPOSE_FILES down --remove-orphans
    cleanup_duplicate_project_service_containers
    # Remove the runtime secret cache dir only after all containers have been
    # torn down; doing it earlier (e.g. via an EXIT trap on `start`) would wipe
    # the bind-mount sources while containers still hold them open.
    cleanup_runtime_secret_tmpdir
    echo "Containers stopped successfully"
}

# Function to restart containers
restart_containers() {
    echo "Restarting Docker containers..."
    stop_containers
    sleep 2
    # Pass all arguments through to start_containers (handles --dev, mode, etc.)
    start_containers "$@"
}

# Function to start/recreate a specific container with correct compose files
# Usage: up_container <container_name> [--no-deps] [--dev]
# This ensures Harbor images are used when available (same logic as start_containers)
# DEV MODE: Checks for .dev-mode marker file or --dev flag
up_container() {
    local container_name="$1"
    local no_deps=""
    local dev_mode=""

    require_docker_compose_frontend || return $?
    prepare_compose_runtime_env

    # Parse remaining arguments
    shift
    for arg in "$@"; do
        case "$arg" in
            --no-deps) no_deps="--no-deps" ;;
            --dev) dev_mode="--dev" ;;
        esac
    done

    # Map container names to service names (docker compose expects service names)
    local service_name="$container_name"
    case "$container_name" in
        portico-open-webui) service_name="open-webui" ;;
        portico-redis) service_name="redis" ;;
        portico-mongodb) service_name="mongodb" ;;
        open-webui-health-check|health-check) service_name="health-check" ;;
    esac

    echo "Starting container $container_name (service: $service_name)..."

    # Build compose files list (same logic as start_containers)
    local COMPOSE_FILES=""
    local FORCE_RECREATE=""

    if [ -f "$PROJECT_ROOT/docker-compose.override.yml" ]; then
        COMPOSE_FILES="-f docker-compose.yml -f docker-compose.advanced.yml -f docker-compose.override.yml"
        echo -e "${GREEN}✓ Using per-server MCPO containers (docker-compose.override.yml)${NC}"
    else
        COMPOSE_FILES="-f docker-compose.yml -f docker-compose.advanced.yml"
        echo -e "${YELLOW}⚠ No docker-compose.override.yml found${NC}"
    fi

    # Check if Harbor images are available locally
    local build_number=$(get_image_tag)
    if [ -n "$build_number" ] && check_harbor_images_available "$build_number"; then
        if [ "$LLM_GATEWAY_MODE_RESOLVED" = "bifrost" ]; then
            export BIFROST_BRIDGE_IMAGE="$(llm_gateway_harbor_image_name "$build_number" "$LLM_GATEWAY_MODE_RESOLVED")"
        fi
        echo -e "${GREEN}✓ Using pre-built Harbor images (build: $build_number)${NC}"
        COMPOSE_FILES="${COMPOSE_FILES} -f docker-compose.harbor.yml"
        FORCE_RECREATE="--force-recreate"
    elif managed_runtime_is_packaged_runtime "$PROJECT_ROOT" "$build_number"; then
        # PORTICO-236: without docker-compose.harbor.yml, docker compose would try
        # to BUILD services from Dockerfiles that packaged builds do not ship
        # (e.g. Dockerfile.health-check). Mirror the start_containers guard.
        echo -e "${RED}❌ Packaged runtime requires Harbor images for build ${build_number}; refusing to start service '${service_name}' without docker-compose.harbor.yml (packaged builds cannot fall back to local Dockerfile builds)${NC}" >&2
        return 1
    fi

    append_llm_gateway_compose_file COMPOSE_FILES || return 1

    # DEBUG MONITOR: Include for local (non-packaged) dev builds
    if [ "$build_number" = "dev-build" ] && [ -f "$PROJECT_ROOT/dev/docker-compose.debug-monitor.yml" ]; then
        COMPOSE_FILES="${COMPOSE_FILES} -f dev/docker-compose.debug-monitor.yml"
    fi

    # DEV MODE: Check for --dev flag OR .dev-mode marker file
    if [ "$dev_mode" = "--dev" ] || [ -f "$PROJECT_ROOT/.dev-mode" ]; then
        if [ -f "$PROJECT_ROOT/dev/docker-compose.dev.yml" ]; then
            echo -e "${BLUE}🔧 DEV MODE: Using Vite hot-reload for frontend${NC}"
            COMPOSE_FILES="${COMPOSE_FILES} -f dev/docker-compose.dev.yml"
            FORCE_RECREATE="--force-recreate"
            echo -e "${YELLOW}   Frontend available at http://localhost:3789 (dev server)${NC}"
        else
            echo -e "${YELLOW}⚠ Dev mode requested but dev/docker-compose.dev.yml not found${NC}"
        fi
    fi

    # Add --no-deps if requested
    local deps_flag=""
    if [ "$no_deps" = "--no-deps" ]; then
        deps_flag="--no-deps"
    else
        # If not using --no-deps, ensure critical infrastructure is running first
        # This prevents issues where a service depends on redis/mongodb but they're not running
        echo -e "${BLUE}Ensuring critical infrastructure is running...${NC}"
        for infra_service in "${CRITICAL_INFRASTRUCTURE_SERVICES[@]}"; do
            local infra_container=""
            case "$infra_service" in
                redis) infra_container="portico-redis" ;;
                mongodb) infra_container="portico-mongodb" ;;
                *) infra_container="$infra_service" ;;
            esac

            local status
            status=$(docker inspect --format '{{.State.Status}}' "$infra_container" 2>/dev/null || echo "not_found")

            if [ "$status" != "running" ]; then
                echo -e "${YELLOW}Starting $infra_service (dependency)...${NC}"
                run_docker_compose $COMPOSE_FILES up -d "$infra_service" 2>&1 || true
                # Brief wait for service to initialize
                sleep 2
            fi
        done
    fi

    echo "Starting with: docker compose $COMPOSE_FILES up -d $FORCE_RECREATE $deps_flag $service_name"
    run_docker_compose $COMPOSE_FILES up -d $FORCE_RECREATE $deps_flag "$service_name"
}

up_containers() {
    require_docker_compose_frontend || return $?
    if [ "$#" -lt 1 ]; then
        echo "Error: At least one container name is required"
        echo "Usage: $0 up-containers <container-name> [container-name ...] [--no-deps]"
        exit 1
    fi

    prepare_compose_runtime_env

    local no_deps=""
    local dev_mode=""
    local service_names=()

    for arg in "$@"; do
        case "$arg" in
            --no-deps) no_deps="--no-deps" ;;
            --dev) dev_mode="--dev" ;;
            *)
                case "$arg" in
                    portico-open-webui) service_names+=("open-webui") ;;
                    portico-redis) service_names+=("redis") ;;
                    portico-mongodb) service_names+=("mongodb") ;;
                    open-webui-health-check|health-check) service_names+=("health-check") ;;
                    *) service_names+=("$arg") ;;
                esac
                ;;
        esac
    done

    if [ "${#service_names[@]}" -eq 0 ]; then
        echo "Error: At least one container name is required"
        echo "Usage: $0 up-containers <container-name> [container-name ...] [--no-deps]"
        exit 1
    fi

    echo "Starting containers ${service_names[*]}..."

    local COMPOSE_FILES=""
    local FORCE_RECREATE=""

    if [ -f "$PROJECT_ROOT/docker-compose.override.yml" ]; then
        COMPOSE_FILES="-f docker-compose.yml -f docker-compose.advanced.yml -f docker-compose.override.yml"
        echo -e "${GREEN}✓ Using per-server MCPO containers (docker-compose.override.yml)${NC}"
    else
        COMPOSE_FILES="-f docker-compose.yml -f docker-compose.advanced.yml"
        echo -e "${YELLOW}⚠ No docker-compose.override.yml found${NC}"
    fi

    local build_number
    build_number=$(get_image_tag)
    if [ -n "$build_number" ] && check_harbor_images_available "$build_number"; then
        if [ "$LLM_GATEWAY_MODE_RESOLVED" = "bifrost" ]; then
            export BIFROST_BRIDGE_IMAGE="$(llm_gateway_harbor_image_name "$build_number" "$LLM_GATEWAY_MODE_RESOLVED")"
        fi
        echo -e "${GREEN}✓ Using pre-built Harbor images (build: $build_number)${NC}"
        COMPOSE_FILES="${COMPOSE_FILES} -f docker-compose.harbor.yml"
        FORCE_RECREATE="--force-recreate"
    elif managed_runtime_is_packaged_runtime "$PROJECT_ROOT" "$build_number"; then
        # PORTICO-236: same guard as up_container — packaged builds must never
        # fall back to local Dockerfile builds.
        echo -e "${RED}❌ Packaged runtime requires Harbor images for build ${build_number}; refusing to start service(s) '${service_names[*]}' without docker-compose.harbor.yml (packaged builds cannot fall back to local Dockerfile builds)${NC}" >&2
        return 1
    fi

    append_llm_gateway_compose_file COMPOSE_FILES || return 1

    # DEBUG MONITOR: Include for local (non-packaged) dev builds
    if [ "$build_number" = "dev-build" ] && [ -f "$PROJECT_ROOT/dev/docker-compose.debug-monitor.yml" ]; then
        COMPOSE_FILES="${COMPOSE_FILES} -f dev/docker-compose.debug-monitor.yml"
    fi

    if [ "$dev_mode" = "--dev" ] || [ -f "$PROJECT_ROOT/.dev-mode" ]; then
        if [ -f "$PROJECT_ROOT/dev/docker-compose.dev.yml" ]; then
            echo -e "${BLUE}🔧 DEV MODE: Using Vite hot-reload for frontend${NC}"
            COMPOSE_FILES="${COMPOSE_FILES} -f dev/docker-compose.dev.yml"
            FORCE_RECREATE="--force-recreate"
            echo -e "${YELLOW}   Frontend available at http://localhost:3789 (dev server)${NC}"
        else
            echo -e "${YELLOW}⚠ Dev mode requested but dev/docker-compose.dev.yml not found${NC}"
        fi
    fi

    local deps_flag=""
    if [ "$no_deps" = "--no-deps" ]; then
        deps_flag="--no-deps"
    else
        echo -e "${BLUE}Ensuring critical infrastructure is running...${NC}"
        for infra_service in "${CRITICAL_INFRASTRUCTURE_SERVICES[@]}"; do
            local infra_container=""
            case "$infra_service" in
                redis) infra_container="portico-redis" ;;
                mongodb) infra_container="portico-mongodb" ;;
                *) infra_container="$infra_service" ;;
            esac

            local status
            status=$(docker inspect --format '{{.State.Status}}' "$infra_container" 2>/dev/null || echo "not_found")

            if [ "$status" != "running" ]; then
                echo -e "${YELLOW}Starting $infra_service (dependency)...${NC}"
                run_docker_compose $COMPOSE_FILES up -d "$infra_service" 2>&1 || true
                sleep 2
            fi
        done
    fi

    echo "Starting with: docker compose $COMPOSE_FILES up -d $FORCE_RECREATE $deps_flag ${service_names[*]}"
    run_docker_compose $COMPOSE_FILES up -d $FORCE_RECREATE $deps_flag "${service_names[@]}"
}

# Function to get logs
get_logs() {
    local container="$1"
    local lines="${2:-100}"

    require_docker_compose_frontend || return $?
    prepare_compose_runtime_env

    # Build compose files list (include override and harbor if they exist)
    local COMPOSE_FILES="-f docker-compose.yml -f docker-compose.advanced.yml"
    if [ -f "$PROJECT_ROOT/docker-compose.override.yml" ]; then
        COMPOSE_FILES="${COMPOSE_FILES} -f docker-compose.override.yml"
    fi

    local build_number=$(get_image_tag)
    if [ -n "$build_number" ] && check_harbor_images_available "$build_number"; then
        if [ "$LLM_GATEWAY_MODE_RESOLVED" = "bifrost" ]; then
            export BIFROST_BRIDGE_IMAGE="$(llm_gateway_harbor_image_name "$build_number" "$LLM_GATEWAY_MODE_RESOLVED")"
        fi
        COMPOSE_FILES="${COMPOSE_FILES} -f docker-compose.harbor.yml"
    fi

    append_llm_gateway_compose_file COMPOSE_FILES || return 1

    # DEBUG MONITOR: Include for local (non-packaged) dev builds
    if [ "$build_number" = "dev-build" ] && [ -f "$PROJECT_ROOT/dev/docker-compose.debug-monitor.yml" ]; then
        COMPOSE_FILES="${COMPOSE_FILES} -f dev/docker-compose.debug-monitor.yml"
    fi

    if [ -z "$container" ]; then
        run_docker_compose $COMPOSE_FILES logs --tail="$lines"
    else
        run_docker_compose $COMPOSE_FILES logs "$container" --tail="$lines"
    fi
}

compose_config() {
    require_docker_compose_frontend || return $?
    prepare_compose_runtime_env
    local COMPOSE_FILES="-f docker-compose.yml -f docker-compose.advanced.yml"
    if [ -f "$PROJECT_ROOT/docker-compose.override.yml" ]; then
        COMPOSE_FILES="${COMPOSE_FILES} -f docker-compose.override.yml"
    fi

    local build_number
    build_number=$(get_image_tag)
    if [ -n "$build_number" ] && check_harbor_images_available "$build_number"; then
        if [ "$LLM_GATEWAY_MODE_RESOLVED" = "bifrost" ]; then
            export BIFROST_BRIDGE_IMAGE="$(llm_gateway_harbor_image_name "$build_number" "$LLM_GATEWAY_MODE_RESOLVED")"
        fi
        COMPOSE_FILES="${COMPOSE_FILES} -f docker-compose.harbor.yml"
    fi

    append_llm_gateway_compose_file COMPOSE_FILES || return 1

    # DEBUG MONITOR: Include for local (non-packaged) dev builds
    if [ "$build_number" = "dev-build" ] && [ -f "$PROJECT_ROOT/dev/docker-compose.debug-monitor.yml" ]; then
        COMPOSE_FILES="${COMPOSE_FILES} -f dev/docker-compose.debug-monitor.yml"
    fi

    run_docker_compose $COMPOSE_FILES config "$@"
}

# Function to check container versions for smart startup
# Returns JSON with container status and image tags
check_versions() {
    prepare_compose_runtime_env
    echo -e "${BLUE}[Smart Startup] Checking container versions...${NC}" >&2

    local build_number=$(get_build_info)
    echo -e "${BLUE}[Smart Startup] Expected build: $build_number${NC}" >&2

    # Dynamically discover ALL running containers matching our patterns
    # This includes: mcpo-*, portico-*, llm-gateway, health-check
    local all_containers=()

    # Get all running container names and filter for ours
    while IFS= read -r container; do
        # Match our container naming patterns
        if [[ "$container" == mcpo-* ]] || \
           [[ "$container" == portico-* ]] || \
           [[ "$container" == "llm-gateway" ]] || \
           [[ "$container" == "health-check" ]] || \
           [[ "$container" == "open-webui-health-check" ]]; then
            all_containers+=("$container")
        fi
    done < <(docker ps --format "{{.Names}}" 2>/dev/null)

    # Also check for expected containers that might be stopped
    local expected_containers=("llm-gateway" "mcpo" "portico-open-webui" "portico-redis" "health-check")
    for expected in "${expected_containers[@]}"; do
        # Add if not already in list
        local found=false
        for existing in "${all_containers[@]}"; do
            if [[ "$existing" == "$expected" ]]; then
                found=true
                break
            fi
        done
        if [[ "$found" == false ]]; then
            all_containers+=("$expected")
        fi
    done

    echo -e "${BLUE}[Smart Startup] Discovered ${#all_containers[@]} containers to check${NC}" >&2

    local result='{"build":"'"$build_number"'","containers":{'
    local first=true

    for container in "${all_containers[@]}"; do
        [ "$first" = false ] && result+=","
        first=false

        local actual_container
        actual_container="$(resolve_container_name_for_service "$container")"

        if docker ps --format "{{.Names}}" | grep -q "^${actual_container}$"; then
            # Get the image tag of running container
            local image=$(docker inspect --format='{{.Config.Image}}' "$actual_container" 2>/dev/null || echo "")
            echo -e "${GREEN}[Smart Startup] ✓ $container: running (image: $image)${NC}" >&2
            result+='"'"$container"'":{"status":"running","image":"'"$image"'"}'
        elif docker ps -a --format "{{.Names}}" | grep -q "^${actual_container}$"; then
            echo -e "${YELLOW}[Smart Startup] ⚠ $container: stopped${NC}" >&2
            result+='"'"$container"'":{"status":"stopped","image":""}'
        else
            echo -e "${RED}[Smart Startup] ✗ $container: not found${NC}" >&2
            result+='"'"$container"'":{"status":"not_found","image":""}'
        fi
    done

    result+='}}'
    echo -e "${BLUE}[Smart Startup] Version check complete${NC}" >&2
    echo "$result"
}

# Main execution - skip if SKIP_MAIN_EXECUTION is set (for sourcing)
if [ -z "$SKIP_MAIN_EXECUTION" ]; then
  check_docker

  case "$1" in
      start)
          start_containers "$2" "$3"
          ;;
      stop)
          stop_containers
          ;;
      restart)
          restart_containers "$2" "$3"
          ;;
      status)
          get_status
          ;;
      check-versions)
          check_versions
          ;;
      logs)
          get_logs "$2" "$3"
          ;;
      config)
          shift
          compose_config "$@"
          ;;
      up-container)
          if [ -z "$2" ]; then
              echo "Error: Container name required"
              echo "Usage: $0 up-container <container-name> [--no-deps]"
              exit 1
          fi
          up_container "$2" "$3"
          ;;
      up-containers)
          shift
          up_containers "$@"
          ;;
      *)
          echo "Usage: $0 {start|stop|restart|status|check-versions|logs|config|up-container|up-containers} [mode|container] [lines]"
          echo "  start [mode] [--dev] - Start containers (mode: simple or advanced, default: advanced)"
          echo "                         --dev enables frontend hot-reload (http://localhost:3790)"
          echo "  stop                 - Stop all containers"
          echo "  restart [mode]       - Restart containers"
          echo "  status               - Get container status as JSON"
          echo "  check-versions       - Check container versions for smart startup"
          echo "  logs [container] [lines] - Get logs (default: all containers, 100 lines)"
          echo "  config [docker-compose args] - Run docker compose config with the resolved compose file set"
          echo "  up-container <name> [--no-deps] - Start/recreate a specific container with Harbor images"
          echo "  up-containers <name...> [--no-deps] - Start/recreate multiple specific containers with Harbor images"
          exit 1
          ;;
  esac
fi
