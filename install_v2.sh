#!/bin/bash

# Portico Manager - Complete Installer
# Installs dependencies, builds and launches the management application

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Setup logging - use Application Support for consistent log location
LOG_DIR="$HOME/Library/Application Support/portico/logs"
LOG_FILE="${LOG_DIR}/install-$(date +%Y-%m-%d).log"
mkdir -p "$LOG_DIR"

# Function to log messages
log_message() {
    echo "$@" | tee -a "$LOG_FILE"
}

log_colored() {
    echo "$@" | sed 's/\x1b\[[0-9;]*m//g' >> "$LOG_FILE"
    echo -e "$@"
}

# Resolve a working python3 binary, bypassing asdf/mise shims that may fail
# when no Python version is configured for the project directory.
resolve_python3() {
    for candidate in /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
        if [ -x "$candidate" ] && "$candidate" --version >/dev/null 2>&1; then
            echo "$candidate"
            return 0
        fi
    done
    if command -v python3 >/dev/null 2>&1 && python3 --version >/dev/null 2>&1; then
        command -v python3
        return 0
    fi
    echo "python3"
}
PYTHON3="$(resolve_python3)"

# Redirect stderr to log file
exec 2> >(tee -a "$LOG_FILE" >&2)

# Log start
{
    echo "========================================"
    echo "Portico Installation"
    echo "Started: $(date)"
    echo "========================================"
    echo ""
} >> "$LOG_FILE"

# Resolve project root from this script's location to avoid relying on CWD.
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"
source "$PROJECT_ROOT/src/scripts/mcp-orc-backend.sh"
source "$PROJECT_ROOT/src/scripts/runtime-secrets.sh"

# Minimum Node.js runtime required for install and host MCP launch flows.
NODE_VERSION_REQUIRED="${NODE_VERSION_REQUIRED:-20.19.0}"

print_separator() {
    local color="${1:-$BLUE}"
    log_colored "${color}--------------------------------------------------------------------------------${NC}"
}

print_section() {
    local color="${1:-$BLUE}"
    local title="$2"
    echo | tee -a "$LOG_FILE"
    print_separator "$color"
    log_colored "${color}${BOLD}  $title${NC}"
    print_separator "$color"
    echo | tee -a "$LOG_FILE"
}

# Parse command line arguments
NO_LAUNCH=false
SKIP_DEPS=false
USE_NODE=false
SKIP_BUILD_INFO=false
ADVANCED_MODE=true  # Default to advanced mode
USE_CACHE=true  # Default to use cache (faster incremental builds)
FORCE_NO_HOST_MODE=false  # Force HOST_MODE to FALSE for testing
FORCE_LOCAL_BUILD=false  # Force local build, skip Harbor pull
OUTPUT_DIR=""  # Empty means use default ("dist")
FORCE_BUILD_INFO=false  # Force regeneration of build-info.json
DEV_MODE=false  # Enable Open WebUI dev mode with HMR for frontend/backend patches
MAC_ALL_ARCH=false  # Build both macOS architectures (x64 + arm64)
MCP_ORC_MODE_SELECTED="rust-full"
LLM_GATEWAY_MODE_SELECTED="bifrost"
MOCK_MARKETPLACE=false  # Point the app at the in-memory Solutions Marketplace mock
UNLINK_MOCK_ENTITIES=false  # Subcommand: purge mock-session artifacts, then exit

while [[ $# -gt 0 ]]; do
    case $1 in
        --no-launch)
            NO_LAUNCH=true
            echo -e "${YELLOW}📦 Build only mode - will not launch app${NC}"
            shift
            ;;
        --skip-deps)
            SKIP_DEPS=true
            echo -e "${YELLOW}⚠️  Skipping dependency checks${NC}"
            shift
            ;;
        --node)
            USE_NODE=true
            echo -e "${YELLOW}🟢 Node.js mode - will run local development build with npm${NC}"
            shift
            ;;
        --bifrost)
            LLM_GATEWAY_MODE_SELECTED="bifrost"
            echo -e "${YELLOW}🌉 Rust gateway mode enabled${NC}"
            shift
            ;;
        --rust)
            MCP_ORC_MODE_SELECTED="rust-full"
            echo -e "${YELLOW}🦀 Rust MCP mode enabled${NC}"
            shift
            ;;
        --rust-full)
            MCP_ORC_MODE_SELECTED="rust-full"
            echo -e "${YELLOW}🦀 Rust MCP mode enabled${NC}"
            shift
            ;;
        --basic)
            ADVANCED_MODE=false
            echo -e "${YELLOW}🔧 Basic mode enabled - streamlined setup${NC}"
            shift
            ;;
        --advanced)
            # Keep for backward compatibility, but it's now the default
            ADVANCED_MODE=true
            echo -e "${YELLOW}🚀 Advanced mode is now the default behavior${NC}"
            shift
            ;;
        --cache)
            USE_CACHE=true
            echo -e "${YELLOW}🔄 Cache mode enabled - Docker will use build cache${NC}"
            shift
            ;;
        --no-cache)
            USE_CACHE=false
            echo -e "${YELLOW}🚫 No-cache mode - Docker will rebuild all layers${NC}"
            shift
            ;;
        --skip-build-info)
            SKIP_BUILD_INFO=true
            echo -e "${YELLOW}📝 Skipping build info generation - using existing build-info.json${NC}"
            shift
            ;;
        --force-no-host)
            FORCE_NO_HOST_MODE=true
            echo -e "${YELLOW}🚫 Force NO HOST mode - will set HOST_MODE=FALSE for testing${NC}"
            shift
            ;;
        --output-dir)
            OUTPUT_DIR="$2"
            echo -e "${YELLOW}📂 Custom output directory: $OUTPUT_DIR${NC}"
            shift 2
            ;;
        --force-local-build)
            FORCE_LOCAL_BUILD=true
            echo -e "${YELLOW}🔨 Force local build - skipping Harbor pull${NC}"
            shift
            ;;
        --mac-all-arch)
            MAC_ALL_ARCH=true
            echo -e "${YELLOW}🍎 macOS dual-arch build enabled (x64 + arm64)${NC}"
            shift
            ;;
        --force-build-info)
            FORCE_BUILD_INFO=true
            echo -e "${YELLOW}📝 Forcing build-info.json regeneration${NC}"
            shift
            ;;
        --dev)
            DEV_MODE=true
            echo -e "${YELLOW}🔥 Dev mode enabled - HMR for frontend/backend patches${NC}"
            shift
            ;;
        --mock-marketplace)
            MOCK_MARKETPLACE=true
            echo -e "${YELLOW}🧪 Mock marketplace mode - the app will talk to the in-memory Solutions Marketplace${NC}"
            shift
            ;;
        --unlink-mock-marketplace-entities)
            UNLINK_MOCK_ENTITIES=true
            echo -e "${YELLOW}🧪 Unlink mode - purging mock-marketplace artifacts (no install/launch)${NC}"
            shift
            ;;
        --help)
            echo "Usage: $0 [options]"
            echo "Options:"
            echo "  --skip-deps           Skip Docker/dependency installation"
            echo "  --no-launch           Build but don't launch the app"
            echo "  --node                Run the local development build with npm"
            echo "  --bifrost             Force the Rust LLM gateway configuration"
            echo "  --rust                Compatibility alias for the Rust runtime"
            echo "  --rust-full           Force the Rust runtime configuration"
            echo "  --basic               Use basic configuration"
            echo "  --advanced            Use advanced configuration (default)"
            echo "  --cache               Enable Docker build cache (default: enabled)"
            echo "  --no-cache            Disable Docker build cache (clean rebuild)"
            echo "  --skip-build-info     Skip build-info.json generation (use existing)"
            echo "  --force-no-host       Force HOST_MODE=FALSE for testing (ignores actual component status)"
            echo "  --force-local-build   Skip Harbor pull, always build images locally"
            echo "  --mac-all-arch        Build both macOS archs (x64 + arm64) instead of host-only"
            echo "  --output-dir DIR      Build to custom output directory (default: dist)"
            echo "  --force-build-info    Regenerate electron-app/build-info.json even if one already exists"
            echo "  --dev                 Enable Open WebUI dev mode with HMR for frontend/backend patches"
            echo "  --mock-marketplace    Start/reuse the in-memory Solutions Marketplace mock (tests/agentic) and point the app at it (dev/testing)"
            echo "  --unlink-mock-marketplace-entities  Purge mock-session artifacts (unlink published, remove mock installs), then exit"
            echo "  --help                Show this help message"
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown argument: $1${NC}"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

set_runtime_env_var() {
    local key="$1"
    local value="$2"
    local runtime_file="$PROJECT_ROOT/.env.runtime"
    local tmp_file
    tmp_file="$(mktemp)"

    if [ -f "$runtime_file" ]; then
        grep -v "^${key}=" "$runtime_file" > "$tmp_file" || true
    fi

    printf '%s=%s\n' "$key" "$value" >> "$tmp_file"
    mv "$tmp_file" "$runtime_file"
}

export MCP_ORC_MODE="$MCP_ORC_MODE_SELECTED"
export MCP_ORC_BACKEND="$MCP_ORC_MODE_SELECTED"
export LLM_GATEWAY_MODE="$LLM_GATEWAY_MODE_SELECTED"
export_mcp_orc_compose_env
export_mcp_orc_harbor_env "latest" "$MCP_ORC_MODE"
export BIFROST_BRIDGE_IMAGE="$(llm_gateway_local_image_name "$LLM_GATEWAY_MODE")"
set_runtime_env_var "LLM_GATEWAY_MODE" "$LLM_GATEWAY_MODE"
set_runtime_env_var "MCP_ORC_MODE" "$MCP_ORC_MODE"
set_runtime_env_var "BIFROST_BRIDGE_IMAGE" "$BIFROST_BRIDGE_IMAGE"
echo -e "${CYAN}MCP mode selected for this install run: ${MCP_ORC_MODE}${NC}"
echo -e "${CYAN}LLM gateway selected for this install run: ${LLM_GATEWAY_MODE}${NC}"

# If building to custom output directory, automatically skip launch
# (the app won't be in the expected dist/ location)
if [ -n "$OUTPUT_DIR" ] && [ "$OUTPUT_DIR" != "dist" ]; then
    NO_LAUNCH=true
    echo -e "${YELLOW}📂 Custom output directory detected ($OUTPUT_DIR) - automatically skipping app launch${NC}"
fi

log() {
    echo -e "${BLUE}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} $1"
}

error() {
    echo -e "${RED}[$(date '+%Y-%m-%d %H:%M:%S')] ❌ $1${NC}"
}

success() {
    echo -e "${GREEN}[$(date '+%Y-%m-%d %H:%M:%S')] ✅ $1${NC}"
}

provision_runtime_secrets_for_install() {
    print_section "$BLUE" "🔐 Provisioning Runtime Secrets"

    # Keep runtime-secrets.sh candidate resolution deterministic in installer mode.
    export PROJECT_ROOT

    ensure_runtime_secret_env

    if [ -n "${PORTICO_LLM_API_KEY:-}" ]; then
        success "PORTICO_LLM_API_KEY resolved for install runtime"
    else
        error "PORTICO_LLM_API_KEY remains unavailable after installer provisioning"
        error "Installer bundle must include a valid upstream key source"
        exit 1
    fi

    if [[ "$OSTYPE" == "darwin"* ]] && command -v security >/dev/null 2>&1; then
        local keychain_service="${PORTICO_LLM_KEYCHAIN_SERVICE:-portico}"
        local portico_account="${PORTICO_LLM_KEYCHAIN_ACCOUNT:-PORTICO_LLM_API_KEY}"
        local local_stack_account="${LOCAL_STACK_KEYCHAIN_ACCOUNT:-LOCAL_STACK_API_KEY}"
        local bifrost_local_account="${BIFROST_LOCAL_KEYCHAIN_ACCOUNT:-BIFROST_BRIDGE_LOCAL_API_KEY}"
        local cloudsmith_entitlement_account="${CLOUDSMITH_ENTITLEMENT_KEYCHAIN_ACCOUNT:-CLOUDSMITH_ENTITLEMENT_TOKEN}"

        if security find-generic-password -s "$keychain_service" -a "$portico_account" -w >/dev/null 2>&1; then
            success "Stored upstream key in macOS Keychain (service=$keychain_service, account=$portico_account)"
        else
            error "Failed to persist upstream key in macOS Keychain"
            exit 1
        fi

        if security find-generic-password -s "$keychain_service" -a "$local_stack_account" -w >/dev/null 2>&1; then
            success "Stored local stack key in macOS Keychain (service=$keychain_service, account=$local_stack_account)"
        else
            log "⚠️  LOCAL_STACK_API_KEY is not persisted in macOS Keychain yet"
        fi

        if security find-generic-password -s "$keychain_service" -a "$bifrost_local_account" -w >/dev/null 2>&1; then
            success "Stored local bridge bearer key in macOS Keychain (service=$keychain_service, account=$bifrost_local_account)"
        else
            log "⚠️  BIFROST_BRIDGE_LOCAL_API_KEY is not persisted in macOS Keychain yet"
        fi

        if security find-generic-password -s "$keychain_service" -a "$cloudsmith_entitlement_account" -w >/dev/null 2>&1; then
            success "Stored Cloudsmith runtime read token in macOS Keychain (service=$keychain_service, account=$cloudsmith_entitlement_account)"
        else
            log "ℹ️  CLOUDSMITH_ENTITLEMENT_TOKEN is not persisted in macOS Keychain (update checks will continue non-blocking)"
        fi
    else
        log "ℹ️  macOS Keychain unavailable on this host; using runtime environment fallback"
    fi
}

command_exists() {
    command -v "$1" >/dev/null 2>&1
}

prepend_path_once() {
    local entry="$1"
    if [ -z "$entry" ] || [ ! -d "$entry" ]; then
        return 0
    fi

    case ":$PATH:" in
        *":$entry:"*) ;;
        *)
            export PATH="${entry}:${PATH}"
            ;;
    esac
}

ORBSTACK_APP_PATH="/Applications/OrbStack.app"
ORBSTACK_BIN_PATH="${ORBSTACK_APP_PATH}/Contents/MacOS/bin"
ORBSTACK_XBIN_PATH="${ORBSTACK_APP_PATH}/Contents/MacOS/xbin"

ensure_orbstack_cli_on_path() {
    prepend_path_once "$ORBSTACK_XBIN_PATH"
    prepend_path_once "$ORBSTACK_BIN_PATH"
}

orbstack_appears_installed() {
    if [ -d "$ORBSTACK_APP_PATH" ]; then
        return 0
    fi

    if command_exists brew && brew list --cask orbstack >/dev/null 2>&1; then
        return 0
    fi

    return 1
}

resolve_brew_prefix() {
    if ! command_exists brew; then
        return 1
    fi

    brew --prefix 2>/dev/null
}

orbstack_homebrew_artifact_paths() {
    local brew_prefix="$1"

    if [ -z "$brew_prefix" ]; then
        return 1
    fi

    printf '%s\n' \
        "${brew_prefix}/bin/orb" \
        "${brew_prefix}/bin/orbctl" \
        "${brew_prefix}/etc/bash_completion.d/orbctl" \
        "${brew_prefix}/etc/bash_completion.d/orbctl.bash" \
        "${brew_prefix}/share/fish/vendor_completions.d/orbctl.fish" \
        "${brew_prefix}/share/zsh/site-functions/_orb" \
        "${brew_prefix}/share/zsh/site-functions/_orbctl"
}

find_orbstack_homebrew_conflict_path() {
    local output="$1"
    local brew_prefix=""
    local path=""

    brew_prefix=$(resolve_brew_prefix) || return 1

    while IFS= read -r path; do
        case "$output" in
            *"already a "*"$path"*|*"already an "*"$path"*)
                echo "$path"
                return 0
                ;;
        esac
    done < <(orbstack_homebrew_artifact_paths "$brew_prefix")

    return 1
}

cleanup_stale_orbstack_homebrew_artifacts() {
    local brew_prefix=""
    local path=""
    local removed_any=1

    brew_prefix=$(resolve_brew_prefix) || return 1

    while IFS= read -r path; do
        if [ -L "$path" ] || [ -e "$path" ]; then
            rm -f "$path"
            log "Removed stale OrbStack Homebrew artifact: $path"
            removed_any=0
        fi
    done < <(orbstack_homebrew_artifact_paths "$brew_prefix")

    if [ "$removed_any" -ne 0 ]; then
        log "No stale OrbStack Homebrew artifacts were present to remove."
    fi

    return 0
}

wait_for_orbstack_docker_ready() {
    local count=0
    while ! docker info >/dev/null 2>&1 && [ $count -lt 30 ]; do
        sleep 2
        ((count++))
    done

    docker info >/dev/null 2>&1
}

sync_open_webui_dev_mode_marker() {
    local dev_mode_marker="$PROJECT_ROOT/.dev-mode"

    if [ "$DEV_MODE" = true ]; then
        log "🔧 Open WebUI dev mode enabled - creating .dev-mode marker file"
        {
            echo "# Dev mode marker - created by install_v2.sh --dev"
            echo "# This file tells docker-compose.sh to include dev/docker-compose.dev.yml"
            echo "# Delete this file to disable dev mode"
            echo "created=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        } > "$dev_mode_marker"
        return 0
    fi

    if [ -f "$dev_mode_marker" ]; then
        log "🔧 Removing stale .dev-mode marker file from previous install_v2.sh --dev run"
        rm -f "$dev_mode_marker"
    fi
}

log_compose_images() {
    local compose_file="$1"
    local label="${2:-Images referenced}"

    if [ ! -f "$compose_file" ]; then
        return 0
    fi

    local images
    images="$(awk '/^[[:space:]]*image:[[:space:]]*/ { print $2 }' "$compose_file" | sort -u)"

    [ -n "$images" ] || return 0

    log "   ${label}:"
    while IFS= read -r image; do
        [ -n "$image" ] || continue
        log "     - ${image}"
    done <<EOF
$images
EOF
}

log_effective_compose_images() {
    local label="${1:-Images referenced}"
    shift || true
    local compose_files=("$@")
    local compose_cmd=()
    local images=""

    if [ "${#compose_files[@]}" -eq 0 ]; then
        return 0
    fi

    local compose_file
    for compose_file in "${compose_files[@]}"; do
        if [ -f "$compose_file" ]; then
            compose_cmd+=(-f "$compose_file")
        fi
    done

    [ "${#compose_cmd[@]}" -gt 0 ] || return 0

    images="$(docker compose "${compose_cmd[@]}" config --images 2>/dev/null | sort -u || true)"
    [ -n "$images" ] || return 0

    log "   ${label}:"
    while IFS= read -r image; do
        [ -n "$image" ] || continue
        log "     - ${image}"
    done <<EOF
$images
EOF
}

# Normalize semver-ish input into MAJOR.MINOR.PATCH (e.g., v20.19.0 -> 20.19.0)
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

# Return success when version A is greater than or equal to version B.
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

# Validate node+npx are present and Node.js meets NODE_VERSION_REQUIRED.
verify_node_and_npx_runtime() {
    local context="${1:-Node.js runtime check}"

    if ! command_exists node; then
        error "${context}: Node.js not found (required >= v${NODE_VERSION_REQUIRED})"
        return 1
    fi

    local node_raw node_version
    node_raw="$(node --version 2>/dev/null || true)"
    node_version="$(normalize_semver "$node_raw" 2>/dev/null || true)"
    if [ -z "$node_version" ]; then
        error "${context}: Unable to parse Node.js version from '${node_raw:-unknown}'"
        return 1
    fi

    if ! semver_gte "$node_version" "$NODE_VERSION_REQUIRED"; then
        error "${context}: Node.js ${node_raw} is below required v${NODE_VERSION_REQUIRED}"
        return 1
    fi

    if ! command_exists npx; then
        error "${context}: npx not found (required with Node.js >= v${NODE_VERSION_REQUIRED})"
        return 1
    fi

    return 0
}

# Function to check Docker
check_docker() {
    log "🐳 Checking for Docker installation..."

    if command_exists docker; then
        if docker info >/dev/null 2>&1; then
            success "Docker is installed and running"
            log "📦 Docker version: $(docker --version)"
            return 0
        else
            log "⚠️  Docker is installed but not running"
            return 1
        fi
    else
        log "🔍 Docker not found"
        return 1
    fi
}

# Function to install Homebrew (macOS only)
install_homebrew() {
    log "🍺 Checking for Homebrew installation..."

    if command_exists brew; then
        success "Homebrew is already installed at $(which brew)"
        log "📦 Current Homebrew version: $(brew --version | head -n 1)"
        return 0
    fi

    log "🔍 Homebrew not found. Installing Homebrew..."
    echo -e "${YELLOW}This will install Homebrew package manager${NC}"
    echo

    # Run the Homebrew installer
    if /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"; then
        # Add Homebrew to PATH for different shells
        if [[ "$OSTYPE" == "darwin"* ]]; then
            # macOS - check for Apple Silicon
            if [[ $(uname -m) == "arm64" ]]; then
                BREW_PREFIX="/opt/homebrew"
            else
                BREW_PREFIX="/usr/local"
            fi

            # Add to current session
            eval "$($BREW_PREFIX/bin/brew shellenv)"

            # Add to shell profiles
            log "📝 Adding Homebrew to shell profiles..."

            # For zsh (default on macOS)
            if [ -f "$HOME/.zshrc" ]; then
                echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> "$HOME/.zshrc"
            fi

            # For bash
            if [ -f "$HOME/.bash_profile" ]; then
                echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> "$HOME/.bash_profile"
            elif [ -f "$HOME/.bashrc" ]; then
                echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> "$HOME/.bashrc"
            fi
        fi

        success "Homebrew installed successfully!"
        log "📦 Installed version: $(brew --version | head -n 1)"
        return 0
    else
        error "Failed to install Homebrew"
        return 1
    fi
}

# Function to configure OrbStack resources
configure_orbstack_resources() {
    log "🔧 Configuring OrbStack resources..."

    # Check if orbctl is available
    if ! command_exists orbctl; then
        log "⚠️  orbctl command not found, skipping resource configuration"
        return 0
    fi

    # Calculate half of available memory in MiB
    local total_memory_bytes=$(sysctl -n hw.memsize)
    local half_memory_mib=$((total_memory_bytes / 1024 / 1024 / 2))
    local desired_cpu=10

    log "📊 System memory: $((total_memory_bytes / 1024 / 1024)) MiB"
    log "📊 Desired allocation to OrbStack: ${half_memory_mib} MiB (50% of system memory)"
    log "📊 Desired CPUs: ${desired_cpu}"
    echo

    # Get current configuration
    log "🔍 Checking current OrbStack configuration..."
    local config_output=$(orbctl config show 2>/dev/null)
    if [ $? -ne 0 ]; then
        log "⚠️  Failed to get current OrbStack configuration"
        return 1
    fi

    # Parse current values
    local current_memory=$(echo "$config_output" | grep "^memory_mib:" | awk '{print $2}')
    local current_cpu=$(echo "$config_output" | grep "^cpu:" | awk '{print $2}')

    log "📋 Current configuration:"
    log "   Memory: ${current_memory} MiB"
    log "   CPU: ${current_cpu} cores"
    echo

    # Track if any changes are made
    local changes_made=false

    # Check if memory needs to be updated
    if [[ -n "$current_memory" && "$current_memory" =~ ^[0-9]+$ ]]; then
        if [ "$half_memory_mib" -gt "$current_memory" ]; then
            log "🔧 Memory increasing (current: ${current_memory} MiB → desired: ${half_memory_mib} MiB)"
            if orbctl config set memory_mib ${half_memory_mib} 2>&1 | grep -v "Restart OrbStack"; then
                success "Memory configured: ${half_memory_mib} MiB"
                changes_made=true
            else
                error "Failed to configure memory"
            fi
        else
            success "✓ Memory already sufficient: ${current_memory} MiB (computed desired: ${half_memory_mib} MiB)"
        fi
    else
        log "⚠️  Could not parse current OrbStack memory_mib (got: '${current_memory}'); skipping memory configuration to avoid reducing it"
    fi

    # Check if CPU needs to be updated
    if [ "$current_cpu" != "$desired_cpu" ]; then
        log "🔧 CPU differs (current: ${current_cpu} cores → desired: ${desired_cpu} cores)"
        if orbctl config set cpu ${desired_cpu} 2>&1 | grep -v "Restart OrbStack"; then
            success "CPU configured: ${desired_cpu} cores"
            changes_made=true
        else
            error "Failed to configure CPU"
        fi
    else
        success "✓ CPU already optimal: ${current_cpu} cores"
    fi

    echo

    # Only restart if changes were made
    if [ "$changes_made" = true ]; then
        log "🔄 Changes detected - restarting OrbStack to apply new resource limits..."
        orbctl stop
        sleep 3
        orbctl start

        # Wait for Docker to be ready after restart
        log "⏳ Waiting for Docker to be ready..."
        local count=0
        while ! docker info >/dev/null 2>&1 && [ $count -lt 30 ]; do
            sleep 2
            ((count++))
        done

        if docker info >/dev/null 2>&1; then
            success "OrbStack restarted successfully with new configuration"
            echo

            # Display the final configuration
            log "📋 Final OrbStack configuration:"
            local final_config=$(orbctl config show 2>/dev/null)
            echo "$final_config" | grep "^memory_mib:" | while read line; do log "   $line"; done
            echo "$final_config" | grep "^cpu:" | while read line; do log "   $line"; done
        else
            error "OrbStack failed to restart after configuration"
            return 1
        fi
    else
        success "🎉 No configuration changes needed - OrbStack already optimally configured!"
        log "📋 Skipping restart since no changes were made"
    fi

    echo
    return 0
}

# Function to get build number for image tags
get_build_number() {
    local build_info_file="electron-app/build-info.json"

    if [ -f "$build_info_file" ] && command_exists jq; then
        local build_number=$(jq -r '.buildNumber' "$build_info_file" 2>/dev/null)
        if [ -n "$build_number" ] && [ "$build_number" != "null" ]; then
            echo "$build_number"
            return 0
        fi
    fi

    # No fallback - build-info.json MUST exist
    error "build-info.json not found or invalid"
    error "Cannot determine build number for Harbor image pull"
    return 1
}

# Function to update docker-compose.harbor.yml with specific build number
update_docker_compose_build_tags() {
    local build_number="$1"
    local harbor_compose_file="docker-compose.harbor.yml"

    # Verify harbor compose file exists
    if [ ! -f "$harbor_compose_file" ]; then
        error "docker-compose.harbor.yml not found in current directory: $(pwd)"
        return 1
    fi

    log "🔧 Updating docker-compose.harbor.yml with build number: $build_number"

    # Replace :latest with :build_number for all Harbor images
    # Pattern: harbor.example.invalid/portico/<image>:latest → harbor.example.invalid/portico/<image>:<build_number>
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS sed requires explicit backup extension with -i
        sed -i.tmp "s|harbor\.portico\.tech/portico/\([^:]*\):latest|harbor.example.invalid/portico/\1:${build_number}|g" "$harbor_compose_file"
        rm -f "${harbor_compose_file}.tmp"
    else
        # Linux sed
        sed -i "s|harbor\.portico\.tech/portico/\([^:]*\):latest|harbor.example.invalid/portico/\1:${build_number}|g" "$harbor_compose_file"
    fi

    success "Updated docker-compose.harbor.yml to use build: $build_number"
}

# Function to update docker-compose.harbor.yml for local builds
update_docker_compose_local_images() {
    local harbor_compose_file="docker-compose.harbor.yml"

    # Verify harbor compose file exists
    if [ ! -f "$harbor_compose_file" ]; then
        error "docker-compose.harbor.yml not found in current directory: $(pwd)"
        return 1
    fi

    log "🔧 Updating docker-compose.harbor.yml to use local image names"

    # Canonical local image names are intentionally collapsed. Legacy variant
    # aliases are still rewritten so older generated files keep working.
    $PYTHON3 - "$harbor_compose_file" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
replacements = [
    ("harbor.example.invalid/portico/mcpo-control-plane-rust:latest", "portico-mcpo-control-plane-rust:latest"),
    ("harbor.example.invalid/portico/mcpo-control-plane:latest", "portico-mcpo-control-plane:latest"),
    ("harbor.example.invalid/portico/mcpo:latest", "portico-mcpo:latest"),
    ("harbor.example.invalid/portico/mcp-orc-rust:latest", "portico-mcp-orc-rust:latest"),
    ("harbor.example.invalid/portico/mcp-orc-rust-node:latest", "portico-mcp-orc-rust:latest"),
    ("harbor.example.invalid/portico/mcp-orc-rust-docker:latest", "portico-mcp-orc-rust:latest"),
    ("harbor.example.invalid/portico/mcp-orc-rust-group-core:latest", "portico-mcp-orc-rust:latest"),
    ("harbor.example.invalid/portico/mcp-orc-rust-group:latest", "portico-mcp-orc-rust:latest"),
    ("harbor.example.invalid/portico/mcp-orc-rust-group-node:latest", "portico-mcp-orc-rust:latest"),
    ("harbor.example.invalid/portico/mcp-orc-rust-group-docker:latest", "portico-mcp-orc-rust:latest"),
    ("harbor.example.invalid/portico/open-webui-patched:latest", "portico-open-webui:latest"),
    ("harbor.example.invalid/portico/health-check:latest", "portico-health-check:latest"),
    ("harbor.example.invalid/portico/chat-state-api:latest", "portico-chat-state-api"),
    ("harbor.example.invalid/portico/bifrost-bridge:latest", "portico-bifrost-bridge:latest"),
    ("harbor.example.invalid/portico/agent-vm:latest", "agent-vm:latest"),
]

for source, target in replacements:
    text = text.replace(source, target)

path.write_text(text)
PY

    success "Updated docker-compose.harbor.yml to use local images"
    log_effective_compose_images \
        "Local images actually referenced by the active compose stack" \
        "docker-compose.yml" \
        "docker-compose.advanced.yml" \
        "docker-compose.override.yml" \
        "$harbor_compose_file"
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
        log "⚠️  Architecture mismatch for $image_ref: local image is $image_arch, host expects $expected_arch"
        return 1
    fi

    return 0
}

agent_vm_image_has_expected_label() {
    local image_ref="${1:-agent-vm:latest}"
    local label_value=""

    label_value=$(docker image inspect --format '{{ index .Config.Labels "com.portico.ai-chat.image-role" }}' "$image_ref" 2>/dev/null | head -n 1)
    [ "$label_value" = "agent-vm" ]
}

# Function to check if all required images exist locally
check_harbor_images_exist() {
    local build_number="$1"
    local compose_files="${2:-}"
    local expected_arch
    expected_arch=$(get_host_docker_arch)
    local compose_images=""

    log "🔍 Checking which images were pulled from Harbor..."

    if [ -n "$compose_files" ]; then
        # shellcheck disable=SC2086
        compose_images=$(docker-compose $compose_files config --images 2>/dev/null | grep '^harbor\.portico\.tech/portico/' | sort -u || true)
    fi

    if [ -z "$compose_images" ]; then
        log "⚠️  Unable to resolve Harbor-tagged compose images for verification"
        return 1
    fi

    while IFS= read -r image_tag; do
        [ -n "$image_tag" ] || continue
        local image_name="${image_tag##*/}"
        image_name="${image_name%%:*}"

        if docker image inspect "$image_tag" >/dev/null 2>&1; then
            if image_matches_host_arch "$image_tag" "$expected_arch"; then
                success "✓ $image_name (pulled from Harbor, arch=$expected_arch)"
            else
                log "✗ $image_name (wrong architecture, needs native rebuild/pull)"
                return 1
            fi
        else
            log "✗ $image_name (needs to be built)"
            return 1
        fi
    done <<< "$compose_images"

    return 0
}

# Ensure llm-debug-monitor frontend assets exist for local dev Docker builds.
run_npm_with_config() {
    local npm_userconfig="$1"
    shift

    if [ -n "$npm_userconfig" ] && [ -f "$npm_userconfig" ]; then
        npm --userconfig "$npm_userconfig" "$@"
    else
        npm "$@"
    fi
}

# Detects whether node_modules contains native binaries built for a different
# platform (e.g. @esbuild/linux-x64 present on darwin-arm64).  This happens
# when node_modules is copied across environments or when npm silently skips
# optional platform-specific packages (npm/cli#4828).
# Returns 0 (true) if a mismatch is found and node_modules should be rebuilt.
check_node_modules_platform_mismatch() {
    local dir="$1"
    local nm="${dir}/node_modules"

    [ -d "$nm" ] || return 1   # no node_modules → nothing to check

    local host_os host_cpu expected_platform
    host_os=$(uname -s | tr '[:upper:]' '[:lower:]')   # darwin / linux
    host_cpu=$(uname -m)                                 # arm64 / x86_64
    # Map uname values to npm platform naming convention
    case "$host_cpu" in
        x86_64)  host_cpu="x64" ;;
        aarch64) host_cpu="arm64" ;;
    esac
    expected_platform="${host_os}-${host_cpu}"   # e.g. darwin-arm64

    # Check common native packages for wrong-platform binaries.
    # We only care whether the correct platform binary is present.
    # If it is, the build will work regardless of other platform dirs.
    local pkg
    for pkg in "@esbuild" "@rollup" "@swc"; do
        if [ -d "${nm}/${pkg}" ]; then
            local has_correct=false has_any_platform=false
            for platform_dir in "${nm}/${pkg}/"*; do
                [ -d "$platform_dir" ] || continue
                local dirname
                dirname=$(basename "$platform_dir")
                # Platform dirs follow: <pkg>-<os>-<cpu> (e.g. esbuild-linux-x64)
                if echo "$dirname" | grep -qE '(linux|darwin|win32|freebsd)-(x64|arm64|ia32|arm)$'; then
                    has_any_platform=true
                    if echo "$dirname" | grep -q "${expected_platform}$"; then
                        has_correct=true
                    fi
                fi
            done
            if [ "$has_any_platform" = true ] && [ "$has_correct" = false ]; then
                log "⚠️  Platform mismatch in ${nm}/${pkg}: missing ${expected_platform} binary"
                return 0
            fi
        fi
    done

    return 1   # no mismatch detected
}

log_llm_debug_monitor_npm_context() {
    local monitor_dir="$1"
    local npm_userconfig="$2"
    local registry="unknown"
    local userconfig="unknown"
    local globalconfig="unknown"

    registry=$(cd "$monitor_dir" && run_npm_with_config "$npm_userconfig" config get registry 2>/dev/null || echo "unknown")
    userconfig=$(cd "$monitor_dir" && run_npm_with_config "$npm_userconfig" config get userconfig 2>/dev/null || echo "unknown")
    globalconfig=$(cd "$monitor_dir" && run_npm_with_config "$npm_userconfig" config get globalconfig 2>/dev/null || echo "unknown")

    log "🧾 npm registry diagnostics for llm-debug-monitor:"
    log "   • Effective registry: ${registry}"
    log "   • npm userconfig: ${userconfig}"
    log "   • npm globalconfig: ${globalconfig}"
    log "   • Project npm config: ${monitor_dir}/.npmrc $([ -f "${monitor_dir}/.npmrc" ] && echo '(present)' || echo '(missing)')"
    if [ -n "$npm_userconfig" ]; then
        log "   • Forced repo npm config: ${npm_userconfig} $([ -f "$npm_userconfig" ] && echo '(present)' || echo '(missing)')"
    fi
}

npm_log_has_auth_error() {
    local log_path="$1"
    [ -f "$log_path" ] || return 1
    grep -Eqi '(^npm error code E401|incorrect or missing password|npm login|authentication token|unauthorized|code E403)' "$log_path"
}

run_llm_debug_monitor_npm_install() {
    local monitor_dir="$1"
    local npm_userconfig="$2"
    local install_log="$3"

    if [ -f "${monitor_dir}/package-lock.json" ]; then
        if (cd "$monitor_dir" && run_npm_with_config "$npm_userconfig" ci --no-audit --no-fund >"$install_log" 2>&1); then
            cat "$install_log" >> "$LOG_FILE"
            return 0
        fi

        cat "$install_log"
        cat "$install_log" >> "$LOG_FILE"

        if npm_log_has_auth_error "$install_log"; then
            return 10
        fi

        log "⚠️  npm ci failed, retrying with npm install..."
    fi

    if (cd "$monitor_dir" && run_npm_with_config "$npm_userconfig" install --no-audit --no-fund >"$install_log" 2>&1); then
        cat "$install_log" >> "$LOG_FILE"
        return 0
    fi

    cat "$install_log"
    cat "$install_log" >> "$LOG_FILE"

    if npm_log_has_auth_error "$install_log"; then
        return 10
    fi

    # npm has a known bug with optional platform-specific dependencies
    # (e.g. @rollup/rollup-darwin-arm64) where they silently fail to install.
    # Clearing node_modules + package-lock.json and retrying fixes it.
    # See: https://github.com/npm/cli/issues/4828
    log "⚠️  npm install failed, retrying with clean node_modules..."
    rm -rf "${monitor_dir}/node_modules" "${monitor_dir}/package-lock.json"

    if (cd "$monitor_dir" && run_npm_with_config "$npm_userconfig" install --no-audit --no-fund >"$install_log" 2>&1); then
        cat "$install_log" >> "$LOG_FILE"
        return 0
    fi

    cat "$install_log"
    cat "$install_log" >> "$LOG_FILE"

    if npm_log_has_auth_error "$install_log"; then
        return 10
    fi

    return 1
}

prepare_llm_debug_monitor_frontend() {
    local monitor_dir="llm-debug-monitor"
    local package_json="${monitor_dir}/package.json"
    local dist_index="${monitor_dir}/dist/index.html"
    local repo_npmrc="${PROJECT_ROOT}/.npmrc"

    log "🧩 Checking llm-debug-monitor frontend build artifacts..."

    if [ ! -d "$monitor_dir" ] || [ ! -f "$package_json" ]; then
        error "llm-debug-monitor source files not found (${monitor_dir}/)."
        return 1
    fi

    if ! command_exists node || ! command_exists npm; then
        error "Node.js and npm are required to build llm-debug-monitor frontend assets."
        log "💡 Fix: install Node.js, then run: cd llm-debug-monitor && npm install && npm run build"
        return 1
    fi

    local needs_build=false
    local source_is_newer=false

    if [ ! -f "$dist_index" ]; then
        needs_build=true
    else
        local newer_source
        newer_source=$(find \
            "${monitor_dir}/src" \
            "${monitor_dir}/index.html" \
            "${monitor_dir}/vite.config.ts" \
            "${monitor_dir}/package.json" \
            "${monitor_dir}/package-lock.json" \
            -type f -newer "$dist_index" -print -quit 2>/dev/null || true)
        if [ -n "$newer_source" ]; then
            needs_build=true
            source_is_newer=true
        fi
    fi

    if [ "$needs_build" = false ]; then
        success "llm-debug-monitor frontend artifacts are up to date"
        return 0
    fi

    if [ "$source_is_newer" = true ]; then
        log "🔨 llm-debug-monitor sources changed; rebuilding frontend..."
    else
        log "🔨 llm-debug-monitor dist/ is missing; building frontend..."
    fi

    # Proactively clean node_modules if platform binaries are wrong (npm/cli#4828)
    if check_node_modules_platform_mismatch "$monitor_dir"; then
        log "📦 Cleaning llm-debug-monitor node_modules (wrong platform binaries detected)..."
        rm -rf "${monitor_dir}/node_modules" "${monitor_dir}/package-lock.json"
    fi

    log "🔐 Forcing llm-debug-monitor to use repo npm config: ${repo_npmrc}"
    local install_log="${LOG_DIR}/llm-debug-monitor-npm-$(date +%Y%m%d-%H%M%S).log"

    run_llm_debug_monitor_npm_install "$monitor_dir" "$repo_npmrc" "$install_log"
    local install_status=$?
    if [ "$install_status" -ne 0 ]; then
        if [ "$install_status" -eq 10 ]; then
            error "npm authentication failed while installing llm-debug-monitor dependencies"
            log_llm_debug_monitor_npm_context "$monitor_dir" "$repo_npmrc"
            log "💡 llm-debug-monitor runs npm from its own subdirectory, so we explicitly force ${repo_npmrc} now."
            log "💡 If this still fails, the token in ${repo_npmrc} likely needs rotation or the registry access needs to be restored."
        else
            error "Failed to install llm-debug-monitor frontend dependencies"
            log_llm_debug_monitor_npm_context "$monitor_dir" "$repo_npmrc"
        fi
        return 1
    fi

    local build_log="${LOG_DIR}/llm-debug-monitor-build-$(date +%Y%m%d-%H%M%S).log"
    if ! (cd "$monitor_dir" && npm run build >"$build_log" 2>&1); then
        cat "$build_log"
        cat "$build_log" >> "$LOG_FILE"
        error "Failed to build llm-debug-monitor frontend assets"
        return 1
    fi
    cat "$build_log" >> "$LOG_FILE"

    if [ ! -f "$dist_index" ]; then
        error "llm-debug-monitor build completed, but ${dist_index} was not generated."
        return 1
    fi

    success "llm-debug-monitor frontend assets built successfully"
    return 0
}

# Function to build Docker images
DOCKER_BUILD_MIN_FREE_GIB="${DOCKER_BUILD_MIN_FREE_GIB:-5}"
DOCKER_BUILD_COMPOSE_PARALLEL_LIMIT="${DOCKER_BUILD_COMPOSE_PARALLEL_LIMIT:-1}"

get_available_disk_kib() {
    local target_path="${1:-$PROJECT_ROOT}"
    df -Pk "$target_path" 2>/dev/null | awk 'NR==2 {print $4}'
}

get_disk_mount_point() {
    local target_path="${1:-$PROJECT_ROOT}"
    df -Pk "$target_path" 2>/dev/null | awk 'NR==2 {print $6}'
}

log_docker_build_disk_guidance() {
    log "💡 Free disk space and retry:"
    log "   • docker system df"
    log "   • docker buildx prune -af"
    log "   • docker builder prune -af"
    log "   • docker image prune -af"
    log "   • docker container prune -f"
    log "   • docker volume prune -f"
    log "   • remove unused local build artifacts or increase OrbStack disk space"
}

list_layer_cleanup_helper_images() {
    local preferred_images=(
        "portico-health-check:latest"
        "harbor.example.invalid/portico/health-check:latest"
        "busybox:latest"
        "alpine:latest"
        "alpine:3.20"
    )

    local image
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
            log "🧹 Removed conflicting layerdb entries using helper image: $helper_image"
            return 0
        fi
    done < <(list_layer_cleanup_helper_images)

    if [ -n "$helper_image" ]; then
        log "⚠️  Failed to remove layerdb entries using helper image: $helper_image"
    else
        log "⚠️  No local helper image available for layerdb cleanup"
    fi
    return 1
}

cleanup_failed_register_layer_images() {
    local compose_files="$1"
    local failure_output_file="$2"
    local attempted_cleanup=false

    log "⚠️  Detected 'failed to register layer'. Cleaning up cached Docker image state before retry..."

    local matched_images=()
    while IFS= read -r image; do
        [ -z "$image" ] && continue
        local short_name="${image##*/}"
        short_name="${short_name%%:*}"
        if grep -qiF "$short_name" "$failure_output_file"; then
            matched_images+=("$image")
        fi
    done < <(docker-compose ${compose_files} config --images 2>/dev/null || true)

    if [ ${#matched_images[@]} -gt 0 ]; then
        attempted_cleanup=true
        local image
        for image in "${matched_images[@]}"; do
            log "🧹 Removing potentially-corrupted image: $image"
            docker image rm -f "$image" >/dev/null 2>&1 || true
        done
    fi

    local layerdb_targets=""
    local layerdb_tmp_targets=""
    layerdb_targets="$(grep -oE '/var/lib/docker/image/overlay2/layerdb/sha256/[a-f0-9]{64}' "$failure_output_file" | sort -u || true)"
    layerdb_tmp_targets="$(grep -oE '/var/lib/docker/image/overlay2/layerdb/tmp/write-set-[0-9]+' "$failure_output_file" | sort -u || true)"
    local layerdb_paths
    layerdb_paths="$(printf '%s\n%s\n' "$layerdb_targets" "$layerdb_tmp_targets" | sed '/^$/d' | sort -u || true)"
    if [ -n "$layerdb_paths" ]; then
        attempted_cleanup=true
        log "🧹 Removing stale Docker layerdb entries from failed layer registration..."
        remove_layerdb_paths_with_helper "$layerdb_paths" || true
    fi

    local layer_refs
    layer_refs="$(grep -oE 'sha256:[a-f0-9]{64}' "$failure_output_file" | sort -u || true)"
    if [ -n "$layer_refs" ] && [ -z "$layerdb_paths" ]; then
        attempted_cleanup=true
        while IFS= read -r layer_ref; do
            [ -z "$layer_ref" ] && continue
            log "🧹 Removing corrupted layer reference: $layer_ref"
            docker image rm -f "$layer_ref" >/dev/null 2>&1 || true
        done <<< "$layer_refs"
    fi

    if [ "$attempted_cleanup" = false ]; then
        log "⚠️  Could not identify a specific corrupted image; pruning dangling Docker state."
    fi

    docker builder prune -f >/dev/null 2>&1 || true
    docker buildx prune -af >/dev/null 2>&1 || true
    docker image prune -f >/dev/null 2>&1 || true
}

run_docker_compose_build_with_retry() {
    local compose_files="$1"
    local build_flags="$2"
    local capture_output_file="$3"
    local max_attempts=2
    local attempt=1

    : > "$capture_output_file"

    if [[ "$DOCKER_BUILD_COMPOSE_PARALLEL_LIMIT" =~ ^[0-9]+$ ]] && [ "$DOCKER_BUILD_COMPOSE_PARALLEL_LIMIT" -gt 0 ]; then
        log "📦 Docker Compose build parallel limit: ${DOCKER_BUILD_COMPOSE_PARALLEL_LIMIT}"
    fi

    while [ "$attempt" -le "$max_attempts" ]; do
        local attempt_output_file
        attempt_output_file="$(mktemp)"

        if [ "$attempt" -gt 1 ]; then
            log "🔁 Retrying docker-compose build (attempt ${attempt}/${max_attempts})..."
        fi

        COMPOSE_PARALLEL_LIMIT="${DOCKER_BUILD_COMPOSE_PARALLEL_LIMIT}" \
            docker-compose ${compose_files} build ${build_flags} 2>&1 | tee -a "$LOG_FILE" "$capture_output_file" "$attempt_output_file"
        local build_status=${PIPESTATUS[0]}

        if [ "$build_status" -eq 0 ]; then
            rm -f "$attempt_output_file"
            return 0
        fi

        if grep -qi "failed to register layer" "$attempt_output_file"; then
            cleanup_failed_register_layer_images "$compose_files" "$attempt_output_file"
            if [ "$attempt" -lt "$max_attempts" ]; then
                rm -f "$attempt_output_file"
                sleep $((attempt * 5))
                attempt=$((attempt + 1))
                continue
            fi
        fi

        if grep -qi "file already closed" "$attempt_output_file"; then
            log "⚠️  BuildKit pipe error detected (transient) — cleaning build cache"
            docker builder prune -f >/dev/null 2>&1 || true
            if [ "$attempt" -lt "$max_attempts" ]; then
                rm -f "$attempt_output_file"
                sleep $((attempt * 5))
                attempt=$((attempt + 1))
                continue
            fi
        fi

        rm -f "$attempt_output_file"
        return "$build_status"
    done

    return 1
}

check_docker_build_disk_space() {
    local available_kib
    available_kib="$(get_available_disk_kib "$PROJECT_ROOT")"

    if ! [[ "$available_kib" =~ ^[0-9]+$ ]]; then
        log "⚠️  Unable to determine free disk space before Docker build"
        return 0
    fi

    local mount_point
    mount_point="$(get_disk_mount_point "$PROJECT_ROOT")"
    local available_gib=$((available_kib / 1024 / 1024))
    log "💽 Free disk space on ${mount_point:-/}: ${available_gib} GiB"

    if [ "$available_gib" -lt "$DOCKER_BUILD_MIN_FREE_GIB" ]; then
        error "Insufficient free disk space for Docker image builds (${available_gib} GiB available, ${DOCKER_BUILD_MIN_FREE_GIB} GiB required minimum)"
        log "💡 Docker/OrbStack image builds consume host disk space and will fail with 'no space left on device' when the host volume is nearly full."
        log_docker_build_disk_guidance
        return 1
    fi

    return 0
}

run_buildkit_policy_migration() {
    local migration_script="$PROJECT_ROOT/src/scripts/migrate-buildkit-gc-policy.sh"
    local command_status=0

    if ! docker info >/dev/null 2>&1; then
        log "⚠️  Docker is not ready; skipping automatic Docker storage maintenance"
        return 0
    fi

    print_section "$BLUE" "🧹 Maintaining Docker Storage"

    if [ -f "$migration_script" ]; then
        bash "$migration_script" 2>&1 | tee -a "$LOG_FILE"
        command_status=${PIPESTATUS[0]}
        if [ "$command_status" -ne 0 ]; then
            log "⚠️  BuildKit cache policy migration did not complete (exit $command_status); installation will continue to the existing disk checks"
        fi
    else
        log "⚠️  BuildKit cache policy migration script not found: $migration_script"
    fi

    # The migration may restart OrbStack. Require the selected engine to be
    # healthy before installation continues.
    if ! docker info >/dev/null 2>&1; then
        log "⚠️  Docker is not ready after cache policy migration"
        return 0
    fi

    return 0
}

build_docker_images() {
    log "🏗️  Preparing Docker images..."
    echo

    # Generate MCP configs first (creates docker-compose.override.yml for per-server containers)
    log "📋 Generating MCP server configurations..."
    if [ -f "src/scripts/mcp-orc-cli.sh" ]; then
        if bash src/scripts/mcp-orc-cli.sh generate-mcp-config 2>&1 | tee -a "$LOG_FILE"; then
            success "MCP configurations generated"
        else
            log "⚠️  MCP config generation had warnings (continuing...)"
        fi
    fi
    echo

    # Determine which compose files to use based on mode
    # IMPORTANT: Override file must come LAST to properly reset base config keys
    local COMPOSE_FILES="-f docker-compose.yml"

    if [ "$ADVANCED_MODE" = true ]; then
        COMPOSE_FILES="$COMPOSE_FILES -f docker-compose.advanced.yml"
    fi

    # Include override file for per-server MCPO containers if it exists
    if [ -f "docker-compose.override.yml" ]; then
        COMPOSE_FILES="$COMPOSE_FILES -f docker-compose.override.yml"
        log "✅ Using per-server MCPO architecture (docker-compose.override.yml found)"
    else
        log "ℹ️  Using fallback monolithic MCPO (no override file)"
    fi

    # Determine if we should use Harbor
    local use_harbor=true
    local need_to_build=true

    if [ "$FORCE_LOCAL_BUILD" = true ]; then
        log "🔨 --force-local-build enabled: Skipping Harbor, building locally"
        use_harbor=false
        export BIFROST_BRIDGE_IMAGE="$(llm_gateway_local_image_name "$LLM_GATEWAY_MODE")"
        set_runtime_env_var "BIFROST_BRIDGE_IMAGE" "$BIFROST_BRIDGE_IMAGE"

        # Update docker-compose.harbor.yml to use local image names
        update_docker_compose_local_images

        echo
    fi

    # Try to use Harbor if not forced to local build
    if [ "$use_harbor" = true ]; then
        local build_number=""

        if build_number="$(get_build_number)"; then
            log "🏷️  Build number: $build_number"
            export BIFROST_BRIDGE_IMAGE="$(llm_gateway_harbor_image_name "$build_number" "$LLM_GATEWAY_MODE")"
            set_runtime_env_var "BIFROST_BRIDGE_IMAGE" "$BIFROST_BRIDGE_IMAGE"

            # Update docker-compose.harbor.yml with specific build number
            update_docker_compose_build_tags "$build_number"

            # Add harbor compose file to the list
            COMPOSE_FILES="${COMPOSE_FILES} -f docker-compose.harbor.yml"
            log "📋 Using compose files: ${COMPOSE_FILES}"
            echo

            # Try to pull images from Harbor first
            log "📥 Attempting to pull pre-built images from Harbor..."
            docker-compose ${COMPOSE_FILES} pull --ignore-pull-failures 2>&1 | tee -a "$LOG_FILE"
            echo

            # Check if all images were successfully pulled
            if check_harbor_images_exist "$build_number" "$COMPOSE_FILES"; then
                success "✅ All images pulled from Harbor - skipping build!"
                need_to_build=false
            else
                log "⚠️  Some images missing from Harbor, will build them locally"
                # Rewrite harbor compose to use local image names and drop
                # the "build: !reset null" overrides so docker-compose build
                # can use the build contexts from docker-compose.yml.
                update_docker_compose_local_images
                COMPOSE_FILES="${COMPOSE_FILES// -f docker-compose.harbor.yml/}"
                export BIFROST_BRIDGE_IMAGE="$(llm_gateway_local_image_name "$LLM_GATEWAY_MODE")"
                set_runtime_env_var "BIFROST_BRIDGE_IMAGE" "$BIFROST_BRIDGE_IMAGE"
            fi
            echo
        else
            log "⚠️  Cannot determine build number from build-info.json"
            log "⚠️  Skipping Harbor pull, will build images locally"
            export BIFROST_BRIDGE_IMAGE="$(llm_gateway_local_image_name "$LLM_GATEWAY_MODE")"
            set_runtime_env_var "BIFROST_BRIDGE_IMAGE" "$BIFROST_BRIDGE_IMAGE"
            echo
        fi
    else
        log "📋 Using compose files (local build only): ${COMPOSE_FILES}"
        echo
    fi

    if ! docker image inspect "${BIFROST_BRIDGE_IMAGE:-$(llm_gateway_local_image_name "$LLM_GATEWAY_MODE")}" >/dev/null 2>&1; then
        if [ "$need_to_build" = false ]; then
            log "🌉 Harbor images are available, but the selected gateway image is missing and will be built now"
        fi
        need_to_build=true
    fi

    # Include debug monitor compose for any local build (node, force-local-build, or dev)
    if [ "$USE_NODE" = true ] || [ "$FORCE_LOCAL_BUILD" = true ] || [ "$DEV_MODE" = true ]; then
        if [ -f "dev/docker-compose.debug-monitor.yml" ]; then
            COMPOSE_FILES="$COMPOSE_FILES -f dev/docker-compose.debug-monitor.yml"
            log "🔍 Including LLM debug monitor for local build"
            need_to_build=true
        fi
    fi

    # Include dev compose file for HMR after gateway overrides (full dev mode only).
    if [ "$DEV_MODE" = true ]; then
        if [ -f "dev/docker-compose.dev.yml" ]; then
            COMPOSE_FILES="$COMPOSE_FILES -f dev/docker-compose.dev.yml"
            log "🔥 Dev mode: HMR enabled for frontend/backend patches"
            need_to_build=true
            log "🔥 Dev mode requires local image builds for dev-only services"
        else
            log "⚠️  Dev mode requested but dev/docker-compose.dev.yml not found"
        fi
    fi

    # Only build if we need to
    if [ "$need_to_build" = true ]; then
        if [ "$USE_NODE" = true ] || [ "$FORCE_LOCAL_BUILD" = true ] || [ "$DEV_MODE" = true ]; then
            if ! prepare_llm_debug_monitor_frontend; then
                error "Cannot continue local Docker build without llm-debug-monitor frontend assets."
                return 1
            fi
        fi

        if ! check_docker_build_disk_space; then
            return 1
        fi

        # Run docker-compose build
        local BUILD_FLAGS=""
        if [ "$USE_CACHE" = false ]; then
            BUILD_FLAGS="--no-cache"
            log "🚫 Building images without cache..."
        else
            log "🔄 Building images with cache enabled..."
        fi

        local build_output_file
        build_output_file="$(mktemp)"
        if run_docker_compose_build_with_retry "${COMPOSE_FILES}" "${BUILD_FLAGS}" "$build_output_file"; then
            rm -f "$build_output_file"
            success "Docker images built successfully!"
        else
            if grep -qi "no space left on device" "$build_output_file"; then
                error "Docker/OrbStack ran out of disk space during the image build"
                check_docker_build_disk_space || true
                docker system df >> "$LOG_FILE" 2>&1 || true
                log_docker_build_disk_guidance
            elif grep -qi "failed to register layer" "$build_output_file"; then
                error "Docker layer registration failed during the image build"
                log "💡 This usually means Docker/OrbStack has stale layer metadata from a prior failed or interrupted pull/build."
                log "💡 Retry after the automatic cleanup, or restart OrbStack/Docker if it keeps recurring."
            fi
            rm -f "$build_output_file"
            error "Failed to build Docker images"
            echo
            log "💡 Common build failures and fixes:"
            # Check for llm-debug-monitor dist directory in dev mode
            if { [ "$USE_NODE" = true ] || [ "$FORCE_LOCAL_BUILD" = true ] || [ "$DEV_MODE" = true ]; } && [ ! -d "llm-debug-monitor/dist" ]; then
                log "   • llm-debug-monitor/dist/ is missing (frontend not built)"
                log "     Fix: cd llm-debug-monitor && npm install && npm run build"
            fi
            return 1
        fi
    else
        success "Using pre-built images from Harbor!"
    fi

    # ALWAYS ensure agent-vm image exists (it's not in docker-compose)
    # This runs regardless of whether we built or pulled other images
    log "🔧 Ensuring agent-vm image exists for skill script execution..."
    local expected_arch
    expected_arch=$(get_host_docker_arch)

    # First check if it already exists locally
    if docker image inspect agent-vm:latest >/dev/null 2>&1 \
        && image_matches_host_arch "agent-vm:latest" "$expected_arch" \
        && agent_vm_image_has_expected_label "agent-vm:latest"; then
        success "agent-vm:latest already exists locally (arch=$expected_arch)"
    else
        if docker image inspect agent-vm:latest >/dev/null 2>&1; then
            log "⚠️  Removing invalid local agent-vm:latest image"
            docker image rm -f agent-vm:latest >/dev/null 2>&1 || true
        fi

        # Try to pull from Harbor first
        local build_number=$(get_build_number 2>/dev/null)
        local pulled_from_harbor=false

        if [ -n "$build_number" ] && [ "$build_number" != "dev-build" ]; then
            log "📥 Attempting to pull agent-vm from Harbor (tag: ${build_number})..."
            if docker pull "harbor.example.invalid/portico/agent-vm:${build_number}" 2>/dev/null; then
                # Tag it as latest for local use
                docker tag "harbor.example.invalid/portico/agent-vm:${build_number}" agent-vm:latest
                if image_matches_host_arch "agent-vm:latest" "$expected_arch" \
                    && agent_vm_image_has_expected_label "agent-vm:latest"; then
                    success "agent-vm pulled from Harbor and tagged as latest (arch=$expected_arch)"
                    pulled_from_harbor=true
                else
                    log "⚠️  Pulled agent-vm failed local validation; rebuilding locally"
                fi
            else
                log "⚠️  agent-vm not available in Harbor"
            fi
        fi

        # Build locally if not pulled from Harbor
        if [ "$pulled_from_harbor" = false ]; then
            log "🔨 Building agent-vm image locally..."
            if docker build -t agent-vm:latest -f Dockerfile.agent-vm .; then
                if image_matches_host_arch "agent-vm:latest" "$expected_arch" \
                    && agent_vm_image_has_expected_label "agent-vm:latest"; then
                    success "agent-vm image built successfully (arch=$expected_arch)"
                else
                    error "agent-vm image built but failed validation for this host"
                    return 1
                fi
            else
                error "Failed to build agent-vm image - skill scripts will not work!"
                log "💡 You can build it manually with: docker build -f Dockerfile.agent-vm -t agent-vm:latest ."
            fi
        fi
    fi

    # Verify MCPO image availability for single-server OAuth setup reuse.
    local build_number_for_verify
    build_number_for_verify=$(get_build_number 2>/dev/null)
    local single_server_backend
    single_server_backend="$(mcp_orc_backend_for_scope regular "$MCP_ORC_MODE")"
    local single_server_local_image
    single_server_local_image="$(mcp_orc_local_image_name full "$single_server_backend")"
    local mcpo_image_available=false

    if [ -n "$build_number_for_verify" ] && [ "$build_number_for_verify" != "dev-build" ]; then
        local harbor_mcpo
        harbor_mcpo="$(mcp_orc_harbor_image_name full "$build_number_for_verify" "$single_server_backend")"
        if docker image inspect "$harbor_mcpo" >/dev/null 2>&1 && image_matches_host_arch "$harbor_mcpo" "$expected_arch"; then
            success "MCPO image available for single-server: $harbor_mcpo"
            mcpo_image_available=true
        fi
    fi

    if [ "$mcpo_image_available" = false ] && docker image inspect "$single_server_local_image" >/dev/null 2>&1 && image_matches_host_arch "$single_server_local_image" "$expected_arch"; then
        success "MCPO image available for single-server: $single_server_local_image"
        mcpo_image_available=true
    fi

    if [ "$mcpo_image_available" = false ]; then
        log "⚠️  MCPO image not found - single-server OAuth will build on-demand"
        log "   First authorization may take 1-2 minutes"
    fi

    return 0
}

ensure_rust_toolchain() {
    if [ -f "$HOME/.cargo/env" ]; then
        . "$HOME/.cargo/env"
    fi

    if command_exists rustup || command_exists cargo; then
        return 0
    fi

    log "🦀 Rust toolchain not found — installing via rustup..."
    if curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path 2>&1 | tee -a "$LOG_FILE"; then
        . "$HOME/.cargo/env"
        export PATH="$HOME/.cargo/bin:$PATH"

        local cargo_line='. "$HOME/.cargo/env" 2>/dev/null'
        for rc_file in "$HOME/.zshrc" "$HOME/.bash_profile" "$HOME/.bashrc" "$HOME/.zprofile"; do
            if [ -f "$rc_file" ]; then
                if ! grep -qF '.cargo/env' "$rc_file" 2>/dev/null; then
                    echo "" >> "$rc_file"
                    echo "# Rust/Cargo (installed by Portico)" >> "$rc_file"
                    echo "$cargo_line" >> "$rc_file"
                fi
            fi
        done

        success "Rust toolchain installed successfully ($(rustc --version 2>/dev/null || echo 'unknown'))"
        return 0
    fi

    error "Failed to install Rust toolchain"
    return 1
}

build_host_mcp_binaries() {
    local scope="${1:-host-only}"
    if [ "$(mcp_orc_backend_for_scope host "$MCP_ORC_MODE")" != "rust" ]; then
        return 0
    fi

    if ! ensure_rust_toolchain; then
        error "Rust toolchain is required for building host MCP binaries"
        return 1
    fi

    case "$scope" in
        host-only|all-supported)
            ;;
        *)
            error "Unsupported host MCP binary build scope: $scope"
            return 1
            ;;
    esac

    local build_script="src/scripts/build-host-mcp-binaries.sh"
    if [ ! -x "$build_script" ]; then
        error "Host MCP binary build script is missing or not executable: $build_script"
        return 1
    fi

    log "🦀 Building native host MCP binaries (${scope})..."
    bash "$build_script" "--${scope}" 2>&1 | tee -a "$LOG_FILE"
    local build_exit="${PIPESTATUS[0]}"
    if [ "$build_exit" -eq 0 ]; then
        success "Host MCP binaries are ready (${scope})"
    else
        error "Failed to build native host MCP binaries (exit $build_exit)"
        return 1
    fi
}

# Function to install jq (JSON processor)
install_jq() {
    log "🔧 Checking for jq installation..."

    if command_exists jq; then
        success "jq is already installed"
        log "📦 jq version: $(jq --version)"
        return 0
    fi

    log "📦 Installing jq via Homebrew..."

    if brew install jq; then
        success "jq installed successfully!"
        log "📦 Installed version: $(jq --version)"
        return 0
    else
        error "Failed to install jq"
        return 1
    fi
}

# Function to install jq on Linux
install_jq_linux() {
    log "🔧 Checking for jq installation on Linux..."

    if command_exists jq; then
        success "jq is already installed"
        log "📦 jq version: $(jq --version)"
        return 0
    fi

    log "📦 Installing jq..."

    # Try apt-get first (Debian/Ubuntu)
    if command_exists apt-get; then
        log "📦 Using apt-get to install jq..."
        if sudo apt-get update && sudo apt-get install -y jq; then
            success "jq installed successfully via apt-get!"
            log "📦 Installed version: $(jq --version)"
            return 0
        fi
    fi

    # Try yum (RHEL/CentOS)
    if command_exists yum; then
        log "📦 Using yum to install jq..."
        if sudo yum install -y jq; then
            success "jq installed successfully via yum!"
            log "📦 Installed version: $(jq --version)"
            return 0
        fi
    fi

    # Try dnf (newer Fedora)
    if command_exists dnf; then
        log "📦 Using dnf to install jq..."
        if sudo dnf install -y jq; then
            success "jq installed successfully via dnf!"
            log "📦 Installed version: $(jq --version)"
            return 0
        fi
    fi

    # Try pacman (Arch)
    if command_exists pacman; then
        log "📦 Using pacman to install jq..."
        if sudo pacman -S --noconfirm jq; then
            success "jq installed successfully via pacman!"
            log "📦 Installed version: $(jq --version)"
            return 0
        fi
    fi

    error "Failed to install jq. Please install it manually:"
    error "  Debian/Ubuntu: sudo apt-get install jq"
    error "  RHEL/CentOS:   sudo yum install jq"
    error "  Fedora:        sudo dnf install jq"
    error "  Arch:          sudo pacman -S jq"
    return 1
}

# Function to install Node.js and npm/npx
install_node_and_npm() {
    log "🔧 Checking Node.js runtime (required >= v${NODE_VERSION_REQUIRED})..."

    local node_present=false
    local npx_present=false
    local node_raw=""
    local node_version=""

    if command_exists node; then
        node_present=true
        node_raw="$(node --version 2>/dev/null || true)"
        node_version="$(normalize_semver "$node_raw" 2>/dev/null || true)"
        log "📦 Detected Node.js version: ${node_raw:-unknown}"
    else
        log "🔍 Node.js not found"
    fi

    if command_exists npx; then
        npx_present=true
        log "📦 Detected npx at: $(which npx)"
    else
        log "🔍 npx not found"
    fi

    local needs_node_install=false
    local needs_node_upgrade=false
    local needs_npx_fix=false

    if [ "$node_present" = false ]; then
        needs_node_install=true
    elif [ -z "$node_version" ] || ! semver_gte "$node_version" "$NODE_VERSION_REQUIRED"; then
        needs_node_upgrade=true
    fi

    if [ "$npx_present" = false ]; then
        needs_npx_fix=true
    fi

    if [ "$needs_node_install" = false ] && [ "$needs_node_upgrade" = false ] && [ "$needs_npx_fix" = false ]; then
        success "Node.js runtime already satisfies requirement (>= v${NODE_VERSION_REQUIRED})"
        log "📦 Node.js version: $(node --version)"
        log "📦 npm version: $(npm --version)"
        log "📦 npx location: $(which npx)"
        return 0
    fi

    # Only attempt installation on macOS with Homebrew
    if [[ "$OSTYPE" != "darwin"* ]]; then
        error "Node.js >= v${NODE_VERSION_REQUIRED} and npx are required."
        error "Automatic installation is only supported on macOS."
        error "Please install/update Node.js manually from: https://nodejs.org/"
        return 1
    fi

    if ! command_exists brew; then
        error "Homebrew is required for automatic Node.js installation/upgrade."
        return 1
    fi

    local primary_action="install"
    if [ "$needs_node_install" = true ]; then
        log "📦 Installing Node.js via Homebrew..."
        primary_action="install"
    elif [ "$needs_node_upgrade" = true ]; then
        log "📦 Upgrading Node.js via Homebrew..."
        log "⚠️  Current Node.js (${node_raw:-unknown}) is below required v${NODE_VERSION_REQUIRED}"
        primary_action="upgrade"
    else
        log "📦 Repairing Node.js toolchain via Homebrew (npx missing)..."
        primary_action="reinstall"
    fi
    echo

    # Detect if running under Rosetta 2 emulation
    local is_rosetta=false
    if [[ $(sysctl -n sysctl.proc_translated 2>/dev/null) == "1" ]]; then
        is_rosetta=true
        log "⚠️  Terminal is running under Rosetta 2 emulation (x86_64 mode on ARM Mac)"
        log "🔧 Forcing native ARM architecture for Node.js installation..."
        log "💡 For best performance, consider running terminal in native ARM mode"
        echo
    fi

    run_brew_node_action() {
        local action="$1"
        if [ "$is_rosetta" = true ]; then
            log "📦 Running: arch -arm64 brew ${action} node"
            arch -arm64 brew "$action" node 2>&1 | tee -a "$LOG_FILE"
        else
            log "📦 Running: brew ${action} node"
            brew "$action" node 2>&1 | tee -a "$LOG_FILE"
        fi
    }

    local install_success=false
    if run_brew_node_action "$primary_action"; then
        install_success=true
    elif [ "$primary_action" = "upgrade" ] || [ "$primary_action" = "reinstall" ]; then
        log "⚠️  brew ${primary_action} node failed, retrying with brew install node..."
        if run_brew_node_action "install"; then
            install_success=true
        fi
    fi

    if [ "$install_success" != true ]; then
        error "Failed to install/upgrade Node.js via Homebrew."
        log "💡 Troubleshooting:"
        if [ "$is_rosetta" = true ]; then
            log "   • You're running under Rosetta 2 - try opening Terminal in native ARM mode"
            log "   • Right-click Terminal.app → Get Info → Uncheck 'Open using Rosetta'"
        fi
        log "   • Install Node.js manually from: https://nodejs.org/"
        return 1
    fi

    # Ensure this installer session prefers the Homebrew-managed Node.js runtime.
    local brew_node_prefix brew_node_bin
    brew_node_prefix="$(brew --prefix node 2>/dev/null || true)"
    brew_node_bin="${brew_node_prefix}/bin"
    if [ -x "${brew_node_bin}/node" ]; then
        case ":${PATH}:" in
            *":${brew_node_bin}:"*) ;;
            *)
                export PATH="${brew_node_bin}:${PATH}"
                log "📦 Prioritizing Homebrew Node.js path for this session: ${brew_node_bin}"
                ;;
        esac
    fi

    if ! verify_node_and_npx_runtime "Node.js install verification"; then
        error "Node.js runtime requirement not met after installation attempt."
        error "Required: Node.js >= v${NODE_VERSION_REQUIRED} with npx available on PATH."
        return 1
    fi

    success "Node.js runtime is ready"
    log "📦 Node.js version: $(node --version)"
    log "📦 npm version: $(npm --version)"
    log "📦 npx location: $(which npx)"
    return 0
}

# Function to install OrbStack (macOS only)
install_orbstack() {
    log "🌐 Checking for OrbStack installation..."
    ensure_orbstack_cli_on_path

    local brew_output=""
    local brew_status=0
    local conflict_path=""

    if [ -d "$ORBSTACK_APP_PATH" ]; then
        success "OrbStack is already installed"

        # Try to start OrbStack if Docker isn't running
        if ! docker info >/dev/null 2>&1; then
            log "🚀 Starting OrbStack using orbctl..."
            orbctl start

            # Wait for Docker to be ready
            if wait_for_orbstack_docker_ready; then
                success "OrbStack is ready"
            else
                error "OrbStack failed to start Docker. Please start it manually."
                return 1
            fi
        fi
        return 0
    fi

    log "📦 Installing OrbStack via Homebrew..."

    brew_status=0
    brew_output=$(brew install --cask orbstack 2>&1) || brew_status=$?
    if [ -n "$brew_output" ]; then
        if [ "$brew_status" -eq 0 ]; then
            printf '%s\n' "$brew_output"
        else
            printf '%s\n' "$brew_output" >&2
        fi
    fi

    if [ "$brew_status" -eq 0 ]; then
        success "OrbStack installed successfully!"
    else
        if orbstack_appears_installed; then
            log "⚠️  Homebrew reported an OrbStack install error, but OrbStack appears to be present. Attempting to continue with the existing installation."
        else
            conflict_path=$(find_orbstack_homebrew_conflict_path "$brew_output" || true)
            if [ -n "$conflict_path" ]; then
                log "⚠️  Homebrew reported a stale OrbStack artifact conflict at $conflict_path. Cleaning known OrbStack Homebrew artifacts and retrying once."
                cleanup_stale_orbstack_homebrew_artifacts
                log "🔁 Retrying OrbStack install after cleaning stale Homebrew artifacts..."

                brew_status=0
                brew_output=$(brew install --cask orbstack 2>&1) || brew_status=$?
                if [ -n "$brew_output" ]; then
                    if [ "$brew_status" -eq 0 ]; then
                        printf '%s\n' "$brew_output"
                    else
                        printf '%s\n' "$brew_output" >&2
                    fi
                fi

                if [ "$brew_status" -eq 0 ]; then
                    success "OrbStack installed successfully after cleaning stale Homebrew artifacts!"
                elif orbstack_appears_installed; then
                    log "⚠️  Homebrew reported an OrbStack install error, but OrbStack appears to be present. Attempting to continue with the existing installation."
                else
                    error "Failed to install OrbStack"
                    return 1
                fi
            else
                error "Failed to install OrbStack"
                return 1
            fi
        fi
    fi

    ensure_orbstack_cli_on_path

    log "🚀 Starting OrbStack using orbctl..."
    orbctl start

    log "⏳ Waiting for OrbStack to initialize Docker..."
    sleep 10

    if wait_for_orbstack_docker_ready; then
        success "OrbStack is ready"
    else
        log "⚠️  OrbStack needs more time to initialize"
        log "Please wait for OrbStack to fully start, then run this installer again"
        return 1
    fi

    return 0
}

# Function to check if HOST mode is supported
check_host_mode_support() {
    log "🔍 Checking HOST mode support..."

    local host_mode_file="${PROJECT_ROOT:-$(pwd)}/HOST_MODE"

    # Check if forced to NO HOST mode for testing
    if [ "$FORCE_NO_HOST_MODE" = true ]; then
        echo "FALSE" > "$host_mode_file"
        log "🚫 FORCED HOST_MODE=FALSE for testing purposes"
        log "📝 Written HOST_MODE=FALSE to $host_mode_file"
        log "💡 This is a testing mode - actual component status ignored"
        log "💡 HOST-based MCP servers will not be available"
        log "💡 Docker-based MCP servers will work normally"
        echo
        return 1
    fi

    log "📋 HOST mode requires: Node.js >= v${NODE_VERSION_REQUIRED} + npx"
    echo

    local all_requirements_met=true
    local missing_components=""

    # Check Node.js version requirement
    if command_exists node; then
        local host_node_raw host_node_version
        host_node_raw="$(node --version 2>/dev/null || true)"
        host_node_version="$(normalize_semver "$host_node_raw" 2>/dev/null || true)"
        if [ -n "$host_node_version" ] && semver_gte "$host_node_version" "$NODE_VERSION_REQUIRED"; then
            success "✓ Node.js is available (version ${host_node_raw})"
        else
            log "✗ Node.js is too old (${host_node_raw:-unknown}); requires >= v${NODE_VERSION_REQUIRED}"
            all_requirements_met=false
            missing_components="${missing_components}Node.js >= v${NODE_VERSION_REQUIRED}, "
        fi
    else
        log "✗ Node.js is NOT available"
        all_requirements_met=false
        missing_components="${missing_components}Node.js >= v${NODE_VERSION_REQUIRED}, "
    fi

    # Check npx
    if command_exists npx; then
        success "✓ npx is available"
    else
        log "✗ npx is NOT available"
        all_requirements_met=false
        missing_components="${missing_components}npx, "
    fi

    echo

    # Write HOST_MODE file - TRUE only if EVERYTHING installed properly
    if [ "$all_requirements_met" = true ]; then
        echo "TRUE" > "$host_mode_file"
        success "HOST mode is SUPPORTED - all requirements met"
        log "📝 Written HOST_MODE=TRUE to $host_mode_file"
        log "🚀 You can use HOST-based MCP servers (e.g., Chrome DevTools)"
        return 0
    else
        echo "FALSE" > "$host_mode_file"
        log "⚠️  HOST mode is NOT SUPPORTED - missing components"
        log "📝 Written HOST_MODE=FALSE to $host_mode_file"

        # Clean up trailing comma and space
        missing_components="${missing_components%, }"
        log "❌ Missing: ${missing_components}"
        log "💡 HOST-based MCP servers will not be available"
        log "💡 Docker-based MCP servers will work normally"
        return 1
    fi
}

# Ensure required volume files exist to prevent Docker from creating directories
# Self-healing: If any file exists as a directory, delete it and create as file
ensure_volume_files() {
    log "📁 Ensuring required volume files exist..."

    local files=(".env" "HOST_MODE" "mcp_toggles.json" "mcp_disable_modes.json" "mcp_config.json" "mcp_config_advanced.json" "mcp_config_core.json" "mcp_config_host_sideload.json" "mcp_tools_config.json" "marketplaces.json")

    for file in "${files[@]}"; do
        local filepath="$file"

        # Self-healing: If path exists as directory, remove it
        if [ -d "$filepath" ]; then
            log "⚠️  Found directory instead of file: $file - removing..."
            rm -rf "$filepath"
            success "Removed directory: $file"
        fi

        # Create file if it doesn't exist
        if [ ! -f "$filepath" ]; then
            # For JSON files, create valid empty JSON object instead of empty file
            if [[ "$file" == *.json ]]; then
                echo '{}' > "$filepath"
            else
                touch "$filepath"
            fi
            success "Created missing file: $file"
        fi
    done
}

# Ensure Electron builder cache directories exist
ensure_electron_cache_dirs() {
    log "📁 Ensuring Electron builder cache directories exist..."

    local cache_dirs=("$HOME/.cache/electron" "$HOME/.cache/electron-builder")

    for dir in "${cache_dirs[@]}"; do
        if [ ! -d "$dir" ]; then
            mkdir -p "$dir"
            success "Created cache directory: $dir"
        else
            log "✓ Cache directory exists: $dir"
        fi
    done

    echo
}

# Function to generate build info
generate_build_info() {
    log "📝 Generating build info..."

    # Get the latest commit SHA and date from main branch
    local git_sha=$(git log main -1 --format="%H" 2>/dev/null || echo "unknown")
    local git_date=$(git log main -1 --format="%cd" --date=format:"%m%d%Y" 2>/dev/null || date +%m%d%Y)

    # Use first 8 characters of SHA for uniqueness
    local short_sha=${git_sha:0:8}

    # Format: MMDDYYYY-SHA8, or "dev-build" for local builds
    local build_number
    if [ "$FORCE_LOCAL_BUILD" = true ]; then
        build_number="dev-build"
        log "📝 Using dev-build for local build (--force-local-build)"
    else
        build_number="${git_date}-${short_sha}"
    fi

    # Create build-info.json
    cat > electron-app/build-info.json <<EOF
{
  "buildNumber": "${build_number}",
  "fullSha": "${git_sha}",
  "date": "${git_date}",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
}
EOF

    success "Build info generated: ${build_number}"
}

# Start a process that survives the installer shell exiting.
# This keeps the Electron dev app alive after `install_v2.sh --node` returns.
start_detached_process() {
    local launch_log="$1"
    shift

    if [ -z "$launch_log" ] || [ "$#" -eq 0 ]; then
        return 1
    fi

    mkdir -p "$(dirname "$launch_log")"

    nohup "$@" >>"$launch_log" 2>&1 </dev/null &
    local pid=$!
    disown "$pid" 2>/dev/null || true
    echo "$pid"
}

# Dev-only: run tests/agentic/mock-solutions-marketplace.js standalone so the
# app can be pointed at it via AI_MARKETPLACE_BASE_URL (re-read per request by
# electron-app/src/services/ai-marketplace-client.js — zero app-code changes).
# Default port 18808 (portico_MOCK_MARKETPLACE_PORT overrides) so it never
# collides with the agentic harness's fixed 18800, and NEVER 9876 (api.js
# kills whatever owns that port at startup). The mock runs KEYLESS on
# purpose: it skips auth checks without MOCK_MARKETPLACE_API_KEY, and
# exporting a fake AI_MARKETPLACE_API_KEY here would be persisted into the
# user's macOS Keychain by resolveAiMarketplaceApiKey, clobbering the real
# key.
launch_mock_marketplace_process() {
    local port="$1"
    local mock_log="$2"

    if ! command -v node >/dev/null 2>&1; then
        error "node is required for --mock-marketplace (install Node.js or run with --node)."
        return 1
    fi

    local pid
    pid="$(start_detached_process "$mock_log" env MOCK_MARKETPLACE_PORT="$port" node "$PROJECT_ROOT/tests/agentic/mock-solutions-marketplace.js")"
    if [ -z "$pid" ]; then
        error "Failed to start the mock Solutions Marketplace"
        return 1
    fi

    local tries=0
    while [ "$tries" -lt 25 ]; do
        if curl -sf --max-time 1 "http://127.0.0.1:${port}/__test/state" >/dev/null 2>&1; then
            log "🧪 Mock Solutions Marketplace ready on port ${port} (PID ${pid})"
            log "📝 Mock log: ${mock_log}"
            return 0
        fi
        sleep 0.2
        tries=$((tries + 1))
    done

    error "Mock Solutions Marketplace did not become ready within 5s"
    [ -f "$mock_log" ] && tail -20 "$mock_log"
    return 1
}

start_mock_marketplace() {
    local port="${portico_MOCK_MARKETPLACE_PORT:-18808}"
    local base_url="http://127.0.0.1:${port}"
    local mock_log="${LOG_DIR}/mock-marketplace-$(date +%Y-%m-%d).log"

    if curl -sf --max-time 2 "${base_url}/__test/state" >/dev/null 2>&1; then
        # Something on the port answers OUR state hook, so it is our mock.
        # Version-skew probe: the mock advertises its public-API shape via
        # GET /__test/contract (v2 = spec-parity envelopes: GET /:id never
        # inlines the bundle; v1/absent also predates the search `results`
        # key). Restart anything older so the renderer sees the real-backend
        # shapes.
        if curl -sf --max-time 2 "${base_url}/__test/contract" 2>/dev/null \
              | grep -q '"contract":2'; then
            log "🧪 Reusing running mock Solutions Marketplace at ${base_url}"
            log "   (state persists across sessions; POST ${base_url}/__test/reset for a clean slate)"
        else
            log "🧪 Mock on port ${port} serves a stale API shape - restarting it"
            local stale_pids
            stale_pids="$(lsof -ti "tcp:${port}" 2>/dev/null)"
            if [ -n "$stale_pids" ]; then
                kill $stale_pids 2>/dev/null
            fi
            local waited=0
            while lsof -ti "tcp:${port}" >/dev/null 2>&1 && [ "$waited" -lt 25 ]; do
                sleep 0.2
                waited=$((waited + 1))
            done
            if lsof -ti "tcp:${port}" >/dev/null 2>&1; then
                error "Could not free port ${port}; kill the process manually and retry."
                return 1
            fi
            launch_mock_marketplace_process "$port" "$mock_log" || return 1
        fi
    else
        local squatters
        squatters="$(lsof -ti "tcp:${port}" 2>/dev/null)"
        if [ -n "$squatters" ]; then
            error "Port ${port} is in use by PID(s): ${squatters} and does not answer the mock's /__test/state hook."
            lsof -nP -i "tcp:${port}" 2>/dev/null | tail -5
            error "Free the port or set portico_MOCK_MARKETPLACE_PORT to another value."
            return 1
        fi
        launch_mock_marketplace_process "$port" "$mock_log" || return 1
    fi

    export AI_MARKETPLACE_BASE_URL="$base_url"

    print_section "$YELLOW" "🧪 MOCK SOLUTIONS MARKETPLACE MODE"
    log_colored "${YELLOW}${BOLD}The app will talk to the IN-MEMORY mock at ${base_url}${NC}"
    log_colored "${YELLOW}⚠️  Installs/publishes in this session reference MOCK-ONLY solution ids.${NC}"
    log_colored "${YELLOW}⚠️  Before returning to the real marketplace, clean up with:${NC}"
    log_colored "${CYAN}      ./install_v2.sh --unlink-mock-marketplace-entities${NC}"
    echo
    log_colored "${CYAN}Test hooks (state is in-memory; seed recipes in tests/agentic/README.md):${NC}"
    log_colored "  curl -s ${base_url}/__test/state | ${PYTHON3} -m json.tool"
    log_colored "  curl -s -X POST ${base_url}/__test/reset"
    log_colored "${CYAN}Stop the mock later:${NC}  lsof -ti tcp:${port} | xargs kill"
    echo
    return 0
}

# Subcommand for --unlink-mock-marketplace-entities: shows the dry-run report
# from tests/agentic/purge-mock-artifacts.js, confirms on a tty, then applies.
# Published-to-mock entities are UNLINKED (they revert to plain unpublished
# local user entities; files/models untouched); installed-from-mock copies are
# removed. portico_PURGE_PROJECT_ROOT / portico_PURGE_USER_DATA env overrides exist as
# a test seam only.
run_unlink_mock_marketplace_entities() {
    print_section "$YELLOW" "🧪 Unlink mock-marketplace entities"

    if ! command -v node >/dev/null 2>&1; then
        error "node is required for --unlink-mock-marketplace-entities."
        return 1
    fi

    local engine="$PROJECT_ROOT/tests/agentic/purge-mock-artifacts.js"
    if [ ! -f "$engine" ]; then
        error "Missing $engine"
        return 1
    fi

    local extra_args=()
    if [ -n "${portico_PURGE_PROJECT_ROOT:-}" ]; then
        extra_args+=(--project-root "$portico_PURGE_PROJECT_ROOT")
    fi
    if [ -n "${portico_PURGE_USER_DATA:-}" ]; then
        extra_args+=(--user-data "$portico_PURGE_USER_DATA")
    fi
    if [ "${portico_PURGE_FORCE:-}" = "1" ]; then
        extra_args+=(--force)
    fi

    node "$engine" ${extra_args[@]+"${extra_args[@]}"}
    local dry_status=$?
    if [ "$dry_status" -ne 0 ]; then
        return "$dry_status"
    fi

    if [ ! -t 0 ]; then
        log "Non-interactive shell: dry run only. Re-run from a terminal to apply,"
        log "or run: node tests/agentic/purge-mock-artifacts.js --apply"
        return 0
    fi

    echo
    printf "Apply these changes? [y/N] "
    local reply
    read -r reply
    case "$reply" in
        y|Y|yes|YES)
            node "$engine" ${extra_args[@]+"${extra_args[@]}"} --apply
            return $?
            ;;
        *)
            log "Aborted - nothing changed."
            return 0
            ;;
    esac
}

# Function to build Electron app with Docker
build_electron_app() {
    log "🔨 Building Electron management app with Docker..."

    # FORCE_LOCAL_BUILD always requires dev-build in build-info.json
    # This takes precedence over all other build-info logic
    if [ "$FORCE_LOCAL_BUILD" = true ]; then
        log "📝 Force local build: regenerating build-info.json with dev-build"
        generate_build_info
    # If a build-info.json already exists (e.g., provided by bootstrap/update),
    # preserve it unless the user explicitly requested regeneration
    elif [ "$SKIP_BUILD_INFO" = false ] && [ -f "electron-app/build-info.json" ] && [ "$FORCE_BUILD_INFO" = false ]; then
        log "📝 Existing build-info.json found - preserving it (use --force-build-info to regenerate)"
        SKIP_BUILD_INFO=true
    elif [ "$FORCE_BUILD_INFO" = true ]; then
        log "📝 Forcing build-info.json regeneration as requested"
    fi

    # Generate build info first (unless skipped or already handled by FORCE_LOCAL_BUILD)
    if [ "$SKIP_BUILD_INFO" = false ] && [ "$FORCE_LOCAL_BUILD" != true ]; then
        generate_build_info
    elif [ "$FORCE_LOCAL_BUILD" != true ]; then
        log "📝 Skipping build info generation as requested"
    fi

    cd electron-app

    # Build using Docker with cache flag if enabled
    # Prepare build flags
    local BUILD_FLAGS=()
    if [ "$USE_CACHE" = true ]; then
        BUILD_FLAGS+=("--cache")
    fi
    if [ "$FORCE_LOCAL_BUILD" = true ]; then
        BUILD_FLAGS+=("--force-local")
    fi
    if [ "$MAC_ALL_ARCH" = true ]; then
        BUILD_FLAGS+=("--mac-all-arch")
    fi
    if [ -n "$OUTPUT_DIR" ]; then
        BUILD_FLAGS+=("--output-dir" "$OUTPUT_DIR")
        log "Building to custom output directory: $OUTPUT_DIR"
    fi

    if ./src/scripts/build-with-docker.sh "${BUILD_FLAGS[@]}"; then
        success "Electron app built successfully!"
        cd ..
        return 0
    else
        error "Failed to build Electron app"
        cd ..
        return 1
    fi
}

# Function to launch the packaged app
launch_packaged_app() {
    log "🚀 Launching packaged Portico Manager..."

    # Save current directory (project root)
    local project_root="$(pwd)"

    # Check if the built app exists
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # Determine architecture
        local arch="mac"
        if [[ "$(uname -m)" == "arm64" ]]; then
            arch="mac-arm64"
        fi

        # Look for the macOS app with proper quoting for spaces
        local app_path="${project_root}/electron-app/dist/${arch}/Portico.app"

        if [ -d "$app_path" ]; then
            log "📱 Found packaged app: $app_path"
            log "🏠 Running from project root: $project_root"

            # Launch the app binary directly to preserve working directory
            # On macOS, the actual executable is inside the .app bundle
            local app_binary="$app_path/Contents/MacOS/Portico"

            if [ -x "$app_binary" ]; then
                # Run the binary directly from the project root as a daemon
                nohup "$app_binary" > /dev/null 2>&1 &
                local app_pid=$!
                disown $app_pid
            else
                # Fallback to using open command as daemon
                log "⚠️  Direct binary not found, using open command"
                nohup open "$app_path" > /dev/null 2>&1 &
                local app_pid=$!
                disown $app_pid
            fi

            success "Portico launched successfully!"
            echo
            echo -e "${GREEN}========================================${NC}"
            echo -e "${GREEN}  Portico is running!${NC}"
            echo -e "${GREEN}========================================${NC}"
            echo
            echo -e "${CYAN}The packaged application should open shortly.${NC}"
            echo -e "${CYAN}Working directory: $project_root${NC}"
            echo

            return 0
        else
            # Check both architectures as fallback
            for arch_dir in "mac" "mac-arm64"; do
                app_path="${project_root}/electron-app/dist/${arch_dir}/Portico.app"
                if [ -d "$app_path" ]; then
                    log "📱 Found packaged app: $app_path"
                    log "🏠 Running from project root: $project_root"

                    # Launch the app binary directly to preserve working directory
                    local app_binary="$app_path/Contents/MacOS/Portico"

                    if [ -x "$app_binary" ]; then
                        # Run the binary directly from the project root as a daemon
                        nohup "$app_binary" > /dev/null 2>&1 &
                        local app_pid=$!
                        disown $app_pid
                    else
                        # Fallback to using open command as daemon
                        log "⚠️  Direct binary not found, using open command"
                        nohup open "$app_path" > /dev/null 2>&1 &
                        local app_pid=$!
                        disown $app_pid
                    fi

                    success "Portico Manager launched successfully!"
                    echo
                    echo -e "${GREEN}========================================${NC}"
                    echo -e "${GREEN}  Portico Manager is running!${NC}"
                    echo -e "${GREEN}========================================${NC}"
                    echo
                    echo -e "${CYAN}The packaged application should open shortly.${NC}"
                    echo -e "${CYAN}Working directory: $project_root${NC}"
                    echo

                    return 0
                fi
            done

            error "Packaged app not found in dist/ directory"
            error "Build may have failed or created unexpected output"
            log "Searched for: electron-app/dist/mac*/Portico.app"
            return 1
        fi
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        # Look for Linux AppImage
        local app_pattern="${project_root}/electron-app/dist/*.AppImage"
        local app_found=$(ls $app_pattern 2>/dev/null | head -1)

        if [ -n "$app_found" ]; then
            log "📱 Found packaged app: $app_found"
            log "🏠 Running from project root: $project_root"
            chmod +x "$app_found"

            # Run the AppImage from the project root directory
            "$app_found" &
            local app_pid=$!

            success "Portico launched successfully!"
            echo
            echo -e "${GREEN}========================================${NC}"
            echo -e "${GREEN}  Portico is running!${NC}"
            echo -e "${GREEN}========================================${NC}"
            echo
            echo -e "${CYAN}The packaged application should open shortly.${NC}"
            echo -e "${CYAN}Working directory: $project_root${NC}"
            echo

            return 0
        else
            error "AppImage not found in dist/ directory"
            return 1
        fi
    else
        error "Platform not supported for packaged app launch"
        return 1
    fi
}

# Function to install Node.js and launch natively
ensure_node_and_launch() {
    log "🔍 Checking Node.js runtime for --node launch (required >= v${NODE_VERSION_REQUIRED})..."

    if ! install_node_and_npm; then
        error "Cannot launch in --node mode without Node.js >= v${NODE_VERSION_REQUIRED} and npx."
        return 1
    fi

    if ! verify_node_and_npx_runtime "Node.js launch preflight"; then
        error "Node.js runtime validation failed for --node launch."
        return 1
    fi

    # Launch with Node
    cd electron-app

    # Ensure dependencies are installed and platform-correct
    if [ ! -d "node_modules" ]; then
        log "📦 Installing dependencies..."
        npm install
    elif check_node_modules_platform_mismatch "."; then
        log "📦 Reinstalling dependencies (wrong platform binaries detected)..."
        rm -rf node_modules package-lock.json
        npm install
    fi

    # Always run bundle to ensure latest code is bundled
    log "📦 Running npm run bundle (always fresh)..."
    npm run bundle

    log "🚀 Starting Portico (development mode)..."
    local app_pid
    local runtime_log=""
    local npm_start_command="start"

    if [ "$DEV_MODE" = true ]; then
        npm_start_command="start:dev"
    fi

    if [ -t 1 ]; then
        npm run "$npm_start_command" &
        app_pid=$!
        disown "$app_pid" 2>/dev/null || true
    else
        runtime_log="${LOG_DIR}/node-launch-$(date +%Y-%m-%d).log"
        app_pid="$(start_detached_process "$runtime_log" npm run "$npm_start_command")"

        if [ -z "$app_pid" ]; then
            error "Failed to launch Portico in detached mode"
            cd ..
            return 1
        fi
    fi

    sleep 2
    if ! kill -0 "$app_pid" 2>/dev/null; then
        error "Portico exited immediately after launch"
        if [ -n "$runtime_log" ] && [ -f "$runtime_log" ]; then
            echo
            echo -e "${YELLOW}Recent detached launcher output:${NC}"
            tail -50 "$runtime_log"
        fi
        cd ..
        return 1
    fi

    success "Portico launched successfully! (PID: $app_pid)"
    if [ -n "$runtime_log" ]; then
        log "📝 Detached launcher log: $runtime_log"
    fi
    echo
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}  Portico is running!${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo
    echo -e "${CYAN}The manager window should open shortly.${NC}"
    echo -e "${CYAN}If it doesn't appear, check the logs above.${NC}"
    echo

    cd ..
    return 0
}

# Main execution
main() {
    # Subcommand: purge mock-marketplace artifacts, then exit. Runs before any
    # install/build work — it is a pure profile-cleanup action.
    if [ "$UNLINK_MOCK_ENTITIES" = true ]; then
        run_unlink_mock_marketplace_entities
        exit $?
    fi

    print_section "$GREEN" "🚀 Portico Installer"
    log "🧭 Node.js requirement: >= v${NODE_VERSION_REQUIRED}"
    log "🦀 MCP mode: ${MCP_ORC_MODE}"

    mkdir -p open-webui-data/

    # CRITICAL: Ensure volume mount files exist to prevent Docker directory creation
    ensure_volume_files

    # Prime runtime secrets and seed macOS Keychain before Docker/bootstrap steps.
    provision_runtime_secrets_for_install

    # Keep the Open WebUI HMR marker in sync with the explicit --dev flag.
    sync_open_webui_dev_mode_marker

    # Check OS
    if [[ "$OSTYPE" == "darwin"* ]]; then
        log "🖥️  Detected macOS"
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        log "🐧 Detected Linux"
    else
        error "Unsupported operating system: $OSTYPE"
        exit 1
    fi

    # Ensure dependencies are available
    if [ "$SKIP_DEPS" = false ]; then
        # On macOS, always check for Homebrew first
        if [[ "$OSTYPE" == "darwin"* ]]; then
            # Install Homebrew if needed
            if ! install_homebrew; then
                error "Failed to install or find Homebrew. Cannot continue."
                exit 1
            fi

            # Install jq (JSON processor) if needed
            if ! install_jq; then
                log "⚠️  jq installation failed, but continuing..."
            fi

            # Install/upgrade Node.js and npm/npx for host MCP tooling.
            if ! install_node_and_npm; then
                if [ "$USE_NODE" = true ]; then
                    error "Node.js runtime requirement not met (requires >= v${NODE_VERSION_REQUIRED})."
                    error "Cannot continue because --node mode requires Node.js."
                    exit 1
                fi
                log "⚠️  Node.js runtime requirement not met (requires >= v${NODE_VERSION_REQUIRED})."
                log "⚠️  Continuing installation because HOST mode is optional."
                log "💡 HOST_MODE will be set to FALSE unless compatible Node.js+npx are available."
            fi

        elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
            # Install jq on Linux (required for MCP config generation)
            if ! install_jq_linux; then
                log "⚠️  jq installation failed, but continuing..."
                log "Note: MCP configuration generation may fail without jq"
            fi
        fi

        # Now check Docker
        if ! check_docker; then
            if [[ "$OSTYPE" == "darwin"* ]]; then
                # Install OrbStack
                if ! install_orbstack; then
                    error "Cannot proceed without Docker"
                    error "Please install Docker Desktop or OrbStack manually"
                    exit 1
                fi
            else
                error "Docker is required but not available"
                error "Please install Docker: https://docs.docker.com/get-docker/"
                exit 1
            fi
        fi
    fi

    # Configure OrbStack resources if OrbStack is installed and Docker is available
    if [[ "$OSTYPE" == "darwin"* ]] && [ -d "/Applications/OrbStack.app" ] && docker info >/dev/null 2>&1; then
        print_section "$BLUE" "🔧 Configuring OrbStack Resources"
        configure_orbstack_resources
    fi

    # Every install mode may need the one-time cache-policy migration. Image
    # deletion is deliberately excluded because this path has no audited
    # release transition or post-update health proof.
    run_buildkit_policy_migration

    # Check HOST mode support before any config generation so HOST servers are
    # included in generated configs on the same install run.
    print_section "$BLUE" "🔍 Checking HOST Mode Support"
    check_host_mode_support

    if [ "$(mcp_orc_backend_for_scope host "$MCP_ORC_MODE")" = "rust" ]; then
        print_section "$BLUE" "🦀 Bootstrapping Host MCP Binary"
        if ! build_host_mcp_binaries "host-only"; then
            error "A current host mcp-orc binary is required before generating MCP configs in Rust host mode"
            exit 1
        fi
    fi

    # Build Docker images if Docker is available
    # We already checked Docker status above, so just verify it's running
    if docker info >/dev/null 2>&1; then
        print_section "$BLUE" "🏗️  Building Docker Images"

        if build_docker_images; then
            success "Docker images built successfully!"
        else
            error "Failed to build Docker images"
            error "Docker image build is required for the application to function properly"
            exit 1
        fi
    else
        log "⚠️  Docker not available, skipping Docker image build"
    fi

    if [ "$(mcp_orc_backend_for_scope host "$MCP_ORC_MODE")" = "rust" ] && [ "$USE_NODE" != true ]; then
        local_host_mcp_scope="host-only"
        if [ "$MAC_ALL_ARCH" = true ]; then
            local_host_mcp_scope="all-supported"
        fi
        print_section "$BLUE" "🦀 Building Host MCP Binaries"
        if ! build_host_mcp_binaries "$local_host_mcp_scope"; then
            error "Native host MCP binaries are required for Rust host mode"
            exit 1
        fi
    fi

    # Build the Electron app (skip packaging in --node mode since we use npm start)
    print_section "$BLUE" "🔨 Building Management Application"

    # Ensure cache directories exist before building
    ensure_electron_cache_dirs

    if [ "$USE_NODE" = true ]; then
        # Node mode still needs runtime build metadata even when --no-launch
        # skips ensure_node_and_launch (for example, foreground worktree QA).
        if [ "$SKIP_BUILD_INFO" = false ]; then
            generate_build_info
        else
            log "📝 Skipping build info generation as requested"
        fi
        log "📦 Skipping Electron packaging (--node mode uses npm start directly)"
        log "💡 Use without --node flag to build the packaged .app"
    else
        if ! build_electron_app; then
            error "Build failed"
            exit 1
        fi
    fi

    # ================ MIGRATION FINALIZATION ================
    # Remove stale guided-setup app bundles after the guided-setup → electron-app rename.

    MANAGED_DIR="$HOME/portico/portico-managed"

    if [ -d "$MANAGED_DIR/guided-setup" ]; then
        log "🔄 [MIGRATION] Removing legacy guided-setup tree"
        if rm -rf "$MANAGED_DIR/guided-setup" 2>/dev/null; then
            success "[MIGRATION] ✅ Legacy guided-setup tree removed"
        else
            log "⚠️  [MIGRATION] Failed to remove legacy guided-setup tree; startup cleanup will retry"
        fi
    fi

    # Point the app at the in-memory mock Solutions Marketplace (dev/testing).
    # Runs after builds (cannot affect them) and before both launch paths so
    # the exported AI_MARKETPLACE_BASE_URL reaches whichever one runs.
    if [ "$MOCK_MARKETPLACE" = true ]; then
        if ! start_mock_marketplace; then
            error "Failed to prepare the mock Solutions Marketplace"
            exit 1
        fi
        if [ "$USE_NODE" != true ] && [ "$NO_LAUNCH" = false ]; then
            log "⚠️  --mock-marketplace is designed for --node launches: the packaged app inherits AI_MARKETPLACE_BASE_URL only via the direct-binary launch (not the 'open' fallback) and exposes no CDP."
        fi
    fi

    # Launch the app unless --no-launch was specified
    if [ "$NO_LAUNCH" = false ]; then
        print_section "$GREEN" "🚀 Launching Application"

        # Choose launch method based on USE_NODE flag
        if [ "$USE_NODE" = true ]; then
            # Launch with Node.js (development mode)
            if ensure_node_and_launch; then
                echo -e "${GREEN}✨ Installation complete!${NC}"
                echo
                if [ "$DEV_MODE" = true ]; then
                    echo -e "${CYAN}Running in ${YELLOW}DEV MODE${CYAN} with Node.js + HMR${NC}"
                    echo
                    echo -e "${CYAN}Hot Module Reload enabled:${NC}"
                    echo -e "  • ${GREEN}Frontend patches${NC} (src/patches/frontend/) - auto-reload in ~3s"
                    echo -e "  • ${GREEN}Backend patches${NC} (src/patches/backend/) - auto-reload via uvicorn"
                    echo
                else
                    echo -e "${CYAN}Running in development mode with Node.js${NC}"
                    echo
                fi
                echo -e "${CYAN}Portico will:${NC}"
                echo -e "  • Guide you through initial configuration"
                echo -e "  • Manage Docker containers for all services"
                echo -e "  • Provide an embedded chat interface"
                echo -e "  • Allow you to reconfigure MCP servers on the fly"
                echo -e "  • Monitor service health and status"
                echo
            else
                error "Failed to launch the application with Node.js"
                echo
                echo -e "${YELLOW}To launch manually:${NC}"
                echo -e "  cd electron-app"
                echo -e "  npm start"
                exit 1
            fi
        else
            # Launch the packaged app
            if launch_packaged_app; then
                echo -e "${GREEN}✨ Installation complete!${NC}"
                echo
                echo -e "${CYAN}Running packaged application${NC}"
                echo
                echo -e "${CYAN}Portico will:${NC}"
                echo -e "  • Guide you through initial configuration"
                echo -e "  • Manage Docker containers for all services"
                echo -e "  • Provide an embedded chat interface"
                echo -e "  • Allow you to reconfigure MCP servers on the fly"
                echo -e "  • Monitor service health and status"
                echo
            else
                error "Failed to launch the packaged application"
                echo
                echo -e "${YELLOW}To launch the packaged app manually:${NC}"
                echo -e "  cd electron-app"
                if [[ "$(uname -m)" == "arm64" ]]; then
                    echo -e "  open 'dist/mac-arm64/Portico Manager.app' # macOS Apple Silicon"
                else
                    echo -e "  open 'dist/mac/Portico Manager.app' # macOS Intel"
                fi
                echo -e "  # or for Linux:"
                echo -e "  ./dist/*.AppImage"
                echo
                echo -e "${YELLOW}To run in development mode with Node.js:${NC}"
                echo -e "  cd electron-app"
                echo -e "  npm start"
                exit 1
            fi
        fi
    else
        print_section "$GREEN" "✨ Build Complete"

        echo -e "${GREEN}Portico has been built successfully!${NC}"
        echo
        if [ "$MOCK_MARKETPLACE" = true ]; then
            echo -e "${YELLOW}Mock Solutions Marketplace is running. Point a manual launch at it:${NC}"
            echo -e "  export AI_MARKETPLACE_BASE_URL=${AI_MARKETPLACE_BASE_URL}"
            echo
        fi
        if [ "$USE_NODE" = true ]; then
            echo -e "${CYAN}To launch the application in development mode:${NC}"
            echo -e "  cd electron-app"
            echo -e "  npm start"
        else
            echo -e "${CYAN}To launch the packaged application:${NC}"
            echo -e "  cd electron-app"
            if [[ "$(uname -m)" == "arm64" ]]; then
                echo -e "  open 'dist/mac-arm64/Portico.app' # macOS Apple Silicon"
            else
                echo -e "  open 'dist/mac/Portico.app' # macOS Intel"
            fi
            echo -e "  # or for Linux:"
            echo -e "  ./dist/*.AppImage"
        fi
        echo
    fi
}

# Run main function
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    main "$@"

    # Log completion
    {
        echo ""
        echo "========================================"
        echo "Installation completed: $(date)"
        echo "========================================"
    } >> "$LOG_FILE"

    log_colored "${GREEN}📝 Installation log saved to: ${LOG_FILE}${NC}"
fi
