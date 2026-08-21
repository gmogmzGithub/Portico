#!/bin/bash

# Build Electron app using Docker
# This allows building without Node.js installed on the host

set -e

# Ensure we run from the electron-app root regardless of invocation location
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RUNTIME_SECRETS_SH="$PROJECT_ROOT/src/scripts/runtime-secrets.sh"

if [ ! -f "$RUNTIME_SECRETS_SH" ]; then
    echo "Error: Missing runtime secrets helper: $RUNTIME_SECRETS_SH" >&2
    exit 1
fi
# shellcheck source=/dev/null
. "$RUNTIME_SECRETS_SH"

cd "$SCRIPT_DIR/../.."

# Parse arguments
USE_CACHE=false
UPDATE_MODE=false
OUTPUT_DIR="dist"  # Default output directory
OUTPUT_DIR_EXPLICIT=false  # Track if --output-dir was explicitly set
FORCE_LOCAL_BUILD=false  # Skip Harbor pull, build locally
MAC_ALL_ARCH=false  # Build both macOS architectures (x64 + arm64)

while [[ $# -gt 0 ]]; do
    case $1 in
        --cache)
            USE_CACHE=true
            shift
            ;;
        --update)
            UPDATE_MODE=true
            shift
            ;;
        --output-dir)
            OUTPUT_DIR="$2"
            OUTPUT_DIR_EXPLICIT=true
            shift 2
            ;;
        --force-local)
            FORCE_LOCAL_BUILD=true
            shift
            ;;
        --mac-all-arch)
            MAC_ALL_ARCH=true
            shift
            ;;
        *)
            echo "Unknown argument: $1"
            shift
            ;;
    esac
done

# Resolve Electron macOS architecture flag for this host.
# On Apple Silicon hardware running under Rosetta, uname can report x86_64.
# Prefer sysctl hardware capability when available.
resolve_macos_host_arch() {
    local arm_capable=""
    local host_arch=""

    if command -v sysctl >/dev/null 2>&1; then
        arm_capable="$(sysctl -in hw.optional.arm64 2>/dev/null || true)"
        if [ "$arm_capable" = "1" ]; then
            echo "arm64"
            return 0
        fi
    fi

    host_arch="$(uname -m 2>/dev/null || true)"
    case "$host_arch" in
        arm64|aarch64)
            echo "arm64"
            ;;
        x86_64|amd64)
            echo "x64"
            ;;
        *)
            return 1
            ;;
    esac
}

# If --update mode without explicit --output-dir, automatically use dist-update
# This ensures updates build to the correct location for the restart logic
if [ "$UPDATE_MODE" = true ] && [ "$OUTPUT_DIR_EXPLICIT" = false ]; then
    OUTPUT_DIR="dist-update"
    echo -e "\033[0;34m📦 Update mode: automatically using output directory 'dist-update'\033[0m"
fi

# If --update mode, delegate to bootstrap.sh for full reinstall from Cloudsmith
if [ "$UPDATE_MODE" = true ]; then
    echo -e "\033[1;33m🔄 Update mode detected - calling bootstrap.sh for full reinstall...\033[0m"
    echo

    # bootstrap.sh is one directory up from electron-app/
    BOOTSTRAP_SCRIPT="$(cd .. && pwd)/bootstrap.sh"

    if [ ! -f "$BOOTSTRAP_SCRIPT" ]; then
        echo -e "\033[0;31m❌ Error: bootstrap.sh not found at $BOOTSTRAP_SCRIPT\033[0m"
        exit 1
    fi

    # Setup logging for bootstrap execution
    LOG_DIR="$HOME/Library/Application Support/portico/logs"
    mkdir -p "$LOG_DIR"
    DATE_STR=$(date +%Y-%m-%d)
    BOOTSTRAP_LOG_FILE="$LOG_DIR/bootstrap-${DATE_STR}.log"

    echo -e "\033[0;34m📝 Bootstrap logs will be saved to:\033[0m"
    echo -e "\033[0;36m   $BOOTSTRAP_LOG_FILE\033[0m"
    echo

    # Change to home directory before executing bootstrap
    # This prevents "getcwd: No such file or directory" error when nuclear cleanup deletes current directory
    echo -e "\033[0;34m📦 Changing to home directory before bootstrap (prevents PWD deletion issue)...\033[0m"
    cd ~

    # Prepare bootstrap arguments
    BOOTSTRAP_ARGS=()
    if [ "$OUTPUT_DIR" != "dist" ]; then
        BOOTSTRAP_ARGS+=("--output-dir" "$OUTPUT_DIR")
        # Only show message if user explicitly set the output dir
        if [ "$OUTPUT_DIR_EXPLICIT" = true ]; then
            echo -e "\033[0;34m📦 Will build to custom output directory: $OUTPUT_DIR\033[0m"
        fi
    fi

    # Show user-facing message about upcoming bootstrap execution
    echo -e "\033[0;34m📦 Executing bootstrap.sh for full update...\033[0m"
    echo -e "\033[1;33m⏱️  This may take several minutes...\033[0m"
    echo -e "\033[0;36m📝 Progress is being logged to:\033[0m"
    echo -e "\033[0;36m   $BOOTSTRAP_LOG_FILE\033[0m"
    echo -e "\033[0;36m⏳ Please wait - the update will complete automatically\033[0m"
    echo

    # Write log header to file
    {
        echo "========================================"
        echo "Bootstrap Update Log"
        echo "Started: $(date)"
        echo "Script: $BOOTSTRAP_SCRIPT ${BOOTSTRAP_ARGS[*]}"
        echo "Output Directory: $OUTPUT_DIR"
        echo "========================================"
        echo
    } >> "$BOOTSTRAP_LOG_FILE"

    # Run bootstrap with all output redirected to log file only (not stdout)
    # This prevents UI lag from thousands of log lines streaming
    bash "$BOOTSTRAP_SCRIPT" "${BOOTSTRAP_ARGS[@]}" >> "$BOOTSTRAP_LOG_FILE" 2>&1
    BOOTSTRAP_EXIT_CODE=$?

    # Write log footer to file
    {
        echo
        echo "========================================"
        echo "Bootstrap Update Completed"
        echo "Finished: $(date)"
        echo "Exit Code: $BOOTSTRAP_EXIT_CODE"
        echo "========================================"
    } >> "$BOOTSTRAP_LOG_FILE"

    # Show completion message to user
    echo -e "\033[0;32m✅ Bootstrap execution completed\033[0m"
    echo

    exit $BOOTSTRAP_EXIT_CODE
fi

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

cloudsmith_api_key="$(printf '%s' "${CLOUDSMITH_API_KEY:-}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
if [ -z "$cloudsmith_api_key" ]; then
    cloudsmith_api_key="$(read_env_value_from_file "$PROJECT_ROOT/cloudsmith.env" "CLOUDSMITH_API_KEY" 2>/dev/null || true)"
    cloudsmith_api_key="$(printf '%s' "$cloudsmith_api_key" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
fi
if [ -z "$cloudsmith_api_key" ]; then
    echo -e "${RED}❌ CLOUDSMITH_API_KEY is required for packaged update discovery. Export it or configure it in $PROJECT_ROOT/cloudsmith.env.${NC}"
    exit 1
fi
export CLOUDSMITH_API_KEY="$cloudsmith_api_key"
unset cloudsmith_api_key

cloudsmith_entitlement_token=""
if cloudsmith_entitlement_token="$(resolve_packaged_cloudsmith_entitlement_token "$PROJECT_ROOT/cloudsmith.env")"; then
    export CLOUDSMITH_ENTITLEMENT_TOKEN="$cloudsmith_entitlement_token"
else
    cloudsmith_resolution_status=$?
    if [ "$cloudsmith_resolution_status" -eq 2 ]; then
        echo -e "${RED}❌ CLOUDSMITH_ENTITLEMENT_TOKEN could not be resolved because macOS Keychain access failed${NC}"
    else
        echo -e "${RED}❌ CLOUDSMITH_ENTITLEMENT_TOKEN is required. Export it, configure it in $PROJECT_ROOT/cloudsmith.env, or store it in the release operator's macOS Keychain.${NC}"
    fi
    exit 1
fi
unset cloudsmith_entitlement_token

echo -e "${BLUE}==================================${NC}"
echo -e "${BLUE}  Building Portico ${NC}"
echo -e "${BLUE}==================================${NC}"
echo

# Show force local build message
if [ "$FORCE_LOCAL_BUILD" = true ]; then
    echo -e "${YELLOW}🔨 Force local build enabled - will build Docker image locally with Node 22${NC}"
    echo
fi

# Check if Docker is available
if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Docker is not installed or not in PATH${NC}"
    exit 1
fi

if ! docker info &> /dev/null; then
    echo -e "${RED}❌ Docker is not running${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Docker is available${NC}"
echo

# Build and run using Docker for dependencies
echo -e "${YELLOW}🔨 Preparing Electron builder environment...${NC}"
echo

# Try to get build number from build-info.json
BUILD_NUMBER=""
if [ -f "build-info.json" ] && command -v jq &> /dev/null; then
    BUILD_NUMBER=$(jq -r '.buildNumber' build-info.json 2>/dev/null)
fi

# Harbor configuration
HARBOR_REGISTRY="harbor.example.invalid"
HARBOR_PROJECT="portico"
BUILDER_IMAGE_LOCAL="portico-ai-manager-builder:latest"
NODE_MODULES_VOLUME="portico-electron-node-modules-$$"

cleanup_node_modules_volume() {
    if command -v docker >/dev/null 2>&1; then
        docker volume rm -f "$NODE_MODULES_VOLUME" >/dev/null 2>&1 || true
    fi
}

trap cleanup_node_modules_volume EXIT

# Try to pull from Harbor if we have a build number and not forcing local build
if [ -n "$BUILD_NUMBER" ] && [ "$BUILD_NUMBER" != "null" ] && [ "$FORCE_LOCAL_BUILD" = false ]; then
    HARBOR_IMAGE="${HARBOR_REGISTRY}/${HARBOR_PROJECT}/electron-builder:${BUILD_NUMBER}"

    echo -e "${BLUE}📥 Attempting to pull Electron builder from Harbor...${NC}"
    echo -e "${BLUE}🏷️  Image: ${HARBOR_IMAGE}${NC}"

    if docker pull "$HARBOR_IMAGE" 2>/dev/null; then
        echo -e "${GREEN}✅ Pulled Electron builder from Harbor${NC}"
        # Tag as local name for use in build commands
        docker tag "$HARBOR_IMAGE" "$BUILDER_IMAGE_LOCAL"
        echo -e "${GREEN}✅ Using pre-built Electron builder image${NC}"
        echo
    else
        echo -e "${YELLOW}⚠️  Pull failed, building Electron builder locally...${NC}"
        echo
        # Build locally
        if [ "$USE_CACHE" = true ]; then
            echo -e "${YELLOW}🔨 Building Docker image with cache...${NC}"
            docker build --build-arg CACHEBUST=$(date +%s) -f Dockerfile.electron-build -t "$BUILDER_IMAGE_LOCAL" . || {
                echo -e "${RED}❌ Docker build failed${NC}"
                exit 1
            }
        else
            echo -e "${YELLOW}🔨 Building Docker image with --no-cache for fresh build...${NC}"
            docker build --no-cache --build-arg CACHEBUST=$(date +%s) -f Dockerfile.electron-build -t "$BUILDER_IMAGE_LOCAL" . || {
                echo -e "${RED}❌ Docker build failed${NC}"
                exit 1
            }
        fi
    fi
else
    if [ "$FORCE_LOCAL_BUILD" = true ]; then
        echo -e "${YELLOW}🔨 Skipping Harbor pull (--force-local), building Electron builder locally...${NC}"
    else
        echo -e "${YELLOW}⚠️  Build number not found, building Electron builder locally...${NC}"
    fi
    echo
    # Build locally
    if [ "$USE_CACHE" = true ]; then
        echo -e "${YELLOW}🔨 Building Docker image with cache...${NC}"
        docker build --build-arg CACHEBUST=$(date +%s) -f Dockerfile.electron-build -t "$BUILDER_IMAGE_LOCAL" . || {
            echo -e "${RED}❌ Docker build failed${NC}"
            exit 1
        }
    else
        echo -e "${YELLOW}🔨 Building Docker image with --no-cache for fresh build...${NC}"
        docker build --no-cache --build-arg CACHEBUST=$(date +%s) -f Dockerfile.electron-build -t "$BUILDER_IMAGE_LOCAL" . || {
            echo -e "${RED}❌ Docker build failed${NC}"
            exit 1
        }
    fi
fi

# Install dependencies using Docker
echo
echo -e "${BLUE}📦 Creating isolated container node_modules volume...${NC}"
docker volume create "$NODE_MODULES_VOLUME" >/dev/null || {
    echo -e "${RED}❌ Failed to create node_modules volume${NC}"
    exit 1
}

# Mask the host checkout's node_modules with a throwaway Docker volume so native
# dependencies such as esbuild are installed for the container platform, not the host.
echo
echo -e "${YELLOW}📦 Installing dependencies...${NC}"
docker run --rm \
    -v "$PWD:/app" \
    -v "$NODE_MODULES_VOLUME:/app/node_modules" \
    -v "$HOME/.cache/electron:/root/.cache/electron" \
    -v "$HOME/.cache/electron-builder:/root/.cache/electron-builder" \
    -w /app \
    "$BUILDER_IMAGE_LOCAL" \
    npm install || {
    echo -e "${RED}❌ Failed to install dependencies${NC}"
    exit 1
}

# Bundle renderer scripts (MUST run after volume mount, not just during image build)
# The bundle step in Dockerfile.electron-build creates files in the IMAGE, but they get
# shadowed by the -v "$PWD:/app" volume mount. Re-run the complete packaged-build
# preparation with the mount active so the packaged Cloudsmith resource is mandatory.
echo
echo -e "${YELLOW}📦 Preparing packaged build resources...${NC}"
docker run --rm \
    -v "$PWD:/app" \
    -v "$NODE_MODULES_VOLUME:/app/node_modules" \
    -v "$PWD/../cloudsmith.env:/cloudsmith.env:ro" \
    -e CLOUDSMITH_API_KEY \
    -e CLOUDSMITH_ENTITLEMENT_TOKEN \
    -w /app \
    "$BUILDER_IMAGE_LOCAL" \
    npm run prepare:packaged-build || {
    echo -e "${RED}❌ Failed to prepare packaged build resources${NC}"
    exit 1
}

# Build the Electron app (creates packaged executable)
echo
echo -e "${YELLOW}📦 Building packaged Electron application...${NC}"

# Use dir-only output for macOS builds to avoid DMG dependencies in the builder image.
MAC_DIR_ARGS=""
if [[ "$OSTYPE" == "darwin"* ]]; then
    local_mac_target_args="-c.mac.target=dir -c.mac.identity=null -c.afterSign=scripts/noop.js"
    if [ "$MAC_ALL_ARCH" = true ]; then
        MAC_DIR_ARGS="--x64 --arm64 ${local_mac_target_args}"
        echo -e "${YELLOW}🍎 Building both macOS architectures (--mac-all-arch enabled)${NC}"
    else
        MAC_HOST_ARCH="$(resolve_macos_host_arch || true)"
        if [ -z "$MAC_HOST_ARCH" ]; then
            echo -e "${RED}❌ Unable to detect macOS host architecture${NC}"
            echo -e "${RED}   Re-run with --mac-all-arch to build both architectures${NC}"
            exit 1
        fi
        MAC_DIR_ARGS="--${MAC_HOST_ARCH} ${local_mac_target_args}"
        echo -e "${BLUE}🍎 Building macOS host architecture only: ${MAC_HOST_ARCH}${NC}"
    fi
fi

# Detect the OS to build for the right platform
# Use custom output directory if specified (not default "dist")
if [ "$OUTPUT_DIR" != "dist" ]; then
    echo -e "${BLUE}Building with custom output directory: $OUTPUT_DIR${NC}"
    if [[ "$OSTYPE" == "darwin"* ]]; then
        BUILD_CMD="npx electron-builder --mac $MAC_DIR_ARGS --config.directories.output=$OUTPUT_DIR"
        echo -e "${BLUE}Building for macOS (unsigned .app only)${NC}"
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        BUILD_CMD="npx electron-builder --linux --config.directories.output=$OUTPUT_DIR"
        echo -e "${BLUE}Building for Linux${NC}"
    elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]] || [[ "$OSTYPE" == "win32" ]]; then
        BUILD_CMD="npx electron-builder --win --config.directories.output=$OUTPUT_DIR"
        echo -e "${BLUE}Building for Windows${NC}"
    else
        BUILD_CMD="npx electron-builder --config.directories.output=$OUTPUT_DIR"
        echo -e "${YELLOW}Building for all platforms${NC}"
    fi
else
    # Use standard npm scripts for default output directory
    if [[ "$OSTYPE" == "darwin"* ]]; then
        BUILD_CMD="npx electron-builder --mac $MAC_DIR_ARGS"
        echo -e "${BLUE}Building for macOS (unsigned .app only)${NC}"
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        BUILD_CMD="npm run build:linux"
        echo -e "${BLUE}Building for Linux${NC}"
    elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]] || [[ "$OSTYPE" == "win32" ]]; then
        BUILD_CMD="npm run build:win"
        echo -e "${BLUE}Building for Windows${NC}"
    else
        BUILD_CMD="npm run build"
        echo -e "${YELLOW}Building for all platforms${NC}"
    fi
fi

docker run --rm \
    -v "$PWD:/app" \
    -v "$NODE_MODULES_VOLUME:/app/node_modules" \
    -v "$HOME/.cache/electron:/root/.cache/electron" \
    -v "$HOME/.cache/electron-builder:/root/.cache/electron-builder" \
    -v "$PWD/../cloudsmith.env:/cloudsmith.env:ro" \
    -e CLOUDSMITH_API_KEY \
    -e CLOUDSMITH_ENTITLEMENT_TOKEN \
    -v "$PWD/../src:/src:ro" \
    -w /app \
    "$BUILDER_IMAGE_LOCAL" \
    $BUILD_CMD || {
    echo -e "${RED}❌ Failed to build Electron app${NC}"
    exit 1
}

echo
echo -e "${GREEN}✅ Build completed successfully!${NC}"
echo -e "${GREEN}✅ Dependencies installed${NC}"
echo -e "${GREEN}✅ Packaged app created in $OUTPUT_DIR/ directory${NC}"
echo -e "${BLUE}Portico is ready to launch!${NC}"
echo

exit 0
