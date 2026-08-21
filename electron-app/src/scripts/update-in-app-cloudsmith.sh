#!/bin/bash

# In-app Cloudsmith update script with visible output
# Designed to run within the Electron app's loading screen
#
# IMPORTANT: This script preserves explicit user-managed paths in the managed
# directory, while replacing shipped runtime content from the incoming payload.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANAGED_RUNTIME_RECONCILE_SH="$SCRIPT_DIR/../../../src/scripts/managed-runtime-reconcile.sh"
MANAGED_RUNTIME_INTEGRITY_SH="$SCRIPT_DIR/../../../src/scripts/managed-runtime-integrity.sh"
RELEASE_CHANNEL_SH="$SCRIPT_DIR/../../../src/scripts/release-channel.sh"

if [ ! -f "$MANAGED_RUNTIME_RECONCILE_SH" ]; then
    echo "Managed runtime reconcile helper not found: $MANAGED_RUNTIME_RECONCILE_SH" >&2
    exit 1
fi
if [ ! -f "$MANAGED_RUNTIME_INTEGRITY_SH" ]; then
    echo "Managed runtime integrity helper not found: $MANAGED_RUNTIME_INTEGRITY_SH" >&2
    exit 1
fi
if [ ! -f "$RELEASE_CHANNEL_SH" ]; then
    echo "Release channel helper not found: $RELEASE_CHANNEL_SH" >&2
    exit 1
fi
# shellcheck source=/dev/null
. "$MANAGED_RUNTIME_RECONCILE_SH"
# shellcheck source=/dev/null
. "$MANAGED_RUNTIME_INTEGRITY_SH"
# shellcheck source=/dev/null
. "$RELEASE_CHANNEL_SH"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

redact_url_for_log() {
    local value="${1:-}"
    if [[ "$value" =~ ^(https?://[^/]+) ]]; then
        printf '%s/[redacted]\n' "${BASH_REMATCH[1]}"
        return 0
    fi
    printf '[redacted URL]\n'
}

redact_sensitive_text_for_log() {
    local value="${1:-}"
    local secret=""
    for secret in \
        "${DOWNLOAD_URL:-}" \
        "${CLOUDSMITH_ENTITLEMENT_TOKEN:-}" \
        "${CLOUDSMITH_API_KEY:-}"
    do
        [ -n "$secret" ] || continue
        value="${value//$secret/[REDACTED]}"
    done
    printf '%s\n' "$value"
}

run_download_with_redacted_output() {
    "$@" 2>&1 | while IFS= read -r line; do
        redact_sensitive_text_for_log "$line"
    done
    return "${PIPESTATUS[0]}"
}

detect_payload_darwin_arch() {
    local arm64_capability=""
    arm64_capability="$(sysctl -in hw.optional.arm64 2>/dev/null || true)"
    if [ "$arm64_capability" = "1" ]; then
        echo "darwin-arm64"
        return 0
    fi

    case "$(uname -m)" in
        arm64|aarch64)
            echo "darwin-arm64"
            ;;
        *)
            echo "darwin-x64"
            ;;
    esac
}

manifest_get_string() {
    local file_path="$1"
    local key_path="$2"

    if [ ! -f "$file_path" ] || ! command -v python3 >/dev/null 2>&1; then
        return 0
    fi

    python3 - "$file_path" "$key_path" <<'PY' 2>/dev/null || true
import json
import sys

file_path, key_path = sys.argv[1:3]
with open(file_path, "r", encoding="utf-8") as fh:
    data = json.load(fh)

value = data
for segment in key_path.split("."):
    if not isinstance(value, dict) or segment not in value:
        value = ""
        break
    value = value[segment]

if isinstance(value, str):
    print(value)
PY
}

# Get arguments
PROJECT_ROOT="$1"
DOWNLOAD_URL="$2"
FILENAME="$3"
FULL_SHA="$4"
MANAGED_DIR="$HOME/portico/portico-managed"
PAYLOAD_RESOURCES_ROOT=""
PRESERVE_FILES=("${MANAGED_RUNTIME_DEFAULT_PRESERVE_PATHS[@]}")

if [ -z "$PROJECT_ROOT" ] || [ -z "$DOWNLOAD_URL" ] || [ -z "$FILENAME" ] || [ -z "$FULL_SHA" ]; then
    echo -e "${RED}Error: Missing required arguments${NC}" >&2
    echo "Usage: $0 <project_root> <download_url> <filename> <full_sha>" >&2
    exit 1
fi

echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}Portico Update Process (Cloudsmith)${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""
echo -e "${YELLOW}Script: $0${NC}"
echo -e "${YELLOW}Script Location: $(realpath "$0")${NC}"
echo -e "${YELLOW}Initial PWD: $(pwd)${NC}"
echo -e "${YELLOW}Managed Directory: $MANAGED_DIR${NC}"
echo -e "${YELLOW}PROJECT_ROOT arg: $PROJECT_ROOT${NC}"
echo ""

# Show current version info
echo -e "${BLUE}Current version info:${NC}"
if [ -f "$MANAGED_DIR/electron-app/build-info.json" ]; then
    echo "  Checking: $MANAGED_DIR/electron-app/build-info.json"
    CURRENT_BUILD=$(grep buildNumber "$MANAGED_DIR/electron-app/build-info.json" | cut -d'"' -f4)
    echo "  Build: $CURRENT_BUILD"
else
    echo "  No build-info.json found at: $MANAGED_DIR/electron-app/build-info.json"
fi
echo ""

# Change to project directory
echo -e "${YELLOW}Changing to PROJECT_ROOT: $PROJECT_ROOT${NC}"
cd "$PROJECT_ROOT"
echo -e "${YELLOW}Current PWD after cd: $(pwd)${NC}"

echo ""
echo -e "${YELLOW}Step 1: Downloading update...${NC}"
echo "Downloading from: $(redact_url_for_log "$DOWNLOAD_URL")"
echo "Current PWD: $(pwd)"

# Create temporary directory for download
TEMP_DIR=$(mktemp -d)
echo "Created temporary directory: $TEMP_DIR"

# Download the binary
DOWNLOAD_FILE="$TEMP_DIR/$FILENAME"
echo "Downloading $FILENAME..."

if command -v curl &> /dev/null; then
    # Use curl with progress bar
    if run_download_with_redacted_output curl -L -f --progress-bar -o "$DOWNLOAD_FILE" "$DOWNLOAD_URL"; then
        echo -e "${GREEN}✅ Successfully downloaded binary${NC}"
        echo "Downloaded file size: $(ls -lh "$DOWNLOAD_FILE" | awk '{print $5}')"
    else
        echo -e "${RED}❌ Failed to download${NC}"
        rm -rf "$TEMP_DIR"
        exit 1
    fi
elif command -v wget &> /dev/null; then
    # Use wget
    if run_download_with_redacted_output wget --progress=bar:force -O "$DOWNLOAD_FILE" "$DOWNLOAD_URL"; then
        echo -e "${GREEN}✅ Successfully downloaded binary${NC}"
        echo "Downloaded file size: $(ls -lh "$DOWNLOAD_FILE" | awk '{print $5}')"
    else
        echo -e "${RED}❌ Failed to download${NC}"
        rm -rf "$TEMP_DIR"
        exit 1
    fi
else
    echo -e "${RED}❌ Neither curl nor wget available${NC}"
    rm -rf "$TEMP_DIR"
    exit 1
fi

# Verify the file was downloaded
if [ ! -f "$DOWNLOAD_FILE" ]; then
    echo -e "${RED}❌ Downloaded file not found${NC}"
    rm -rf "$TEMP_DIR"
    exit 1
fi

echo ""
echo -e "${YELLOW}Step 2: Extracting files...${NC}"
echo "Current PWD: $(pwd)"

echo "Target directory: $MANAGED_DIR"
echo "Verifying target exists: $([ -d "$MANAGED_DIR" ] && echo "YES" || echo "NO")"

# Create a temporary extraction directory
EXTRACT_TEMP="$TEMP_DIR/extract"
echo "Creating temp extraction dir: $EXTRACT_TEMP"
mkdir -p "$EXTRACT_TEMP"

# Extract the zip file to temp location first
if command -v unzip &> /dev/null; then
    echo "Extracting archive to temporary location..."
    # Extract quietly first to check structure
    if unzip -q "$DOWNLOAD_FILE" -d "$EXTRACT_TEMP"; then
        echo -e "${GREEN}✅ Archive extracted to temp location${NC}"
        
        # Check if there's an intermediate folder (like portico-main)
        EXTRACTED_ITEMS=$(ls -A "$EXTRACT_TEMP" | wc -l)
        FIRST_ITEM=$(ls -A "$EXTRACT_TEMP" | head -1)
        
        if [ "$EXTRACTED_ITEMS" -eq 1 ] && [ -d "$EXTRACT_TEMP/$FIRST_ITEM" ]; then
            SOURCE_DIR="$EXTRACT_TEMP/$FIRST_ITEM"
            echo "Found intermediate folder: $FIRST_ITEM"
            echo "Full path: $SOURCE_DIR"
        else
            SOURCE_DIR="$EXTRACT_TEMP"
            echo "No intermediate folder found, using extracted root directly..."
        fi

        RELEASE_MANIFEST="$SOURCE_DIR/release-manifest.json"
        MANAGED_ROOT_NAME="managed-root"
        MANAGED_SOURCE_DIR=""
        if [ -f "$RELEASE_MANIFEST" ]; then
            MANAGED_ROOT_NAME="$(manifest_get_string "$RELEASE_MANIFEST" "managedRootDir")"
            MANAGED_ROOT_NAME="${MANAGED_ROOT_NAME:-managed-root}"
            MANAGED_SOURCE_DIR="$SOURCE_DIR/$MANAGED_ROOT_NAME"
            echo "Detected packaged release payload with manifest: $RELEASE_MANIFEST"

            SELECTED_ARCH="$(detect_payload_darwin_arch)"
            APP_BUNDLE_RELATIVE_PATH="$(manifest_get_string "$RELEASE_MANIFEST" "appBundles.${SELECTED_ARCH}")"
            if [ -n "$APP_BUNDLE_RELATIVE_PATH" ] && [ -d "$SOURCE_DIR/$APP_BUNDLE_RELATIVE_PATH" ]; then
                PAYLOAD_RESOURCES_ROOT="$(managed_runtime_normalize_packaged_resources_root "$SOURCE_DIR/$APP_BUNDLE_RELATIVE_PATH" || true)"
                if [ -n "$PAYLOAD_RESOURCES_ROOT" ]; then
                    echo "Using payload app resources root for runtime compose regeneration: $PAYLOAD_RESOURCES_ROOT"
                fi
            fi
        else
            MANAGED_SOURCE_DIR="$SOURCE_DIR"
            echo "Detected legacy source payload without release manifest"
        fi

        if [ ! -d "$MANAGED_SOURCE_DIR" ]; then
            echo -e "${RED}❌ Managed runtime tree not found in payload: $MANAGED_SOURCE_DIR${NC}"
            rm -rf "$TEMP_DIR"
            exit 1
        fi

        managed_runtime_remove_generated_compose_files "$MANAGED_SOURCE_DIR"

        FILE_COUNT=$(find "$MANAGED_SOURCE_DIR" -type f | wc -l)
        echo "Reconciling $FILE_COUNT payload files into managed runtime tree..."
        managed_runtime_reconcile_payload "$MANAGED_SOURCE_DIR" "$MANAGED_DIR" "${PRESERVE_FILES[@]}"
        echo -e "${GREEN}✅ Managed runtime reconciled into $MANAGED_DIR${NC}"
    else
        echo -e "${RED}❌ Failed to extract files${NC}"
        rm -rf "$TEMP_DIR"
        exit 1
    fi
else
    echo -e "${RED}❌ unzip command not available${NC}"
    rm -rf "$TEMP_DIR"
    exit 1
fi

echo ""
echo -e "${YELLOW}Step 3: Building application...${NC}"
echo "Current PWD: $(pwd)"
echo "This may take a few minutes..."

# Parse filename to extract build info
echo "Parsing filename: $FILENAME"
BUILD_CHANNEL="portico"
if [ -f "$MANAGED_DIR/UPDATE_CHANNEL" ]; then
    CHANNEL_CONTENT="$(tr -d '[:space:]' < "$MANAGED_DIR/UPDATE_CHANNEL")"
    if [ -n "$CHANNEL_CONTENT" ]; then
        BUILD_CHANNEL="$CHANNEL_CONTENT"
    fi
fi
if ! BUILD_CHANNEL="$(resolve_update_channel_package_name "$BUILD_CHANNEL")"; then
    echo -e "${RED}❌ Invalid release channel package name in UPDATE_CHANNEL${NC}"
    exit 1
fi
BUILD_IDENTITY="${FILENAME#${BUILD_CHANNEL}-}"
BUILD_IDENTITY="${BUILD_IDENTITY%.zip}"
if [ "$FILENAME" != "${BUILD_CHANNEL}-${BUILD_IDENTITY}.zip" ]; then
    echo -e "${RED}❌ Update filename does not match active release channel: $FILENAME${NC}"
    exit 1
fi
if [[ "$BUILD_IDENTITY" =~ ^([0-9]{8})-([a-f0-9]{8,40})$ ]]; then
    BUILD_DATE="${BASH_REMATCH[1]}"
    SHA="${BASH_REMATCH[2]}"
    if [ ${#SHA} -gt 8 ]; then
        SHORT_SHA="${SHA:0:8}"
    else
        SHORT_SHA="${SHA}"
    fi
    BUILD_NUMBER="${BUILD_DATE}-${SHORT_SHA}"
    
    echo "Creating build-info.json at: $MANAGED_DIR/electron-app/build-info.json"
    # Create build-info.json in the managed directory
    cat > "$MANAGED_DIR/electron-app/build-info.json" <<EOF
{
  "buildNumber": "${BUILD_NUMBER}",
  "fullSha": "${FULL_SHA}",
  "date": "${BUILD_DATE}",
  "channel": "${BUILD_CHANNEL}",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
}
EOF
    
    echo -e "${GREEN}✅ Generated build-info.json${NC}"
    echo "  Build Number: $BUILD_NUMBER"
    echo "  Full SHA: $FULL_SHA"
else
    echo -e "${RED}❌ Could not parse update filename for active release channel: $FILENAME${NC}"
    exit 1
fi

echo "Regenerating managed runtime compose artifacts..."
if [ -n "$PAYLOAD_RESOURCES_ROOT" ]; then
    managed_runtime_require_packaged_generator_binary "$MANAGED_DIR" "$PAYLOAD_RESOURCES_ROOT" >/dev/null
    managed_runtime_regenerate_generated_compose "$MANAGED_DIR" "$SCRIPT_DIR" "$PAYLOAD_RESOURCES_ROOT"
else
    managed_runtime_regenerate_generated_compose "$MANAGED_DIR" "$SCRIPT_DIR"
fi
managed_runtime_validate_generated_compose "$MANAGED_DIR"

# Clean up downloaded file
rm -rf "$TEMP_DIR"
echo "Cleaned up temporary files"

# Build the updated app to dist-update folder
echo ""
echo -e "${YELLOW}Changing to build directory: $MANAGED_DIR/electron-app${NC}"
cd "$MANAGED_DIR/electron-app"
echo "Current PWD after cd: $(pwd)"
BUILD_SCRIPT="src/scripts/build-with-docker.sh"
if [ -f "$BUILD_SCRIPT" ]; then
    echo "Found build script at: $(pwd)/$BUILD_SCRIPT"
    echo ""
    echo -e "${CYAN}Building updated application...${NC}"
    echo "Executing: bash $BUILD_SCRIPT --update"
    echo "Build will output to: dist-update/"
    
    # Run the build script with update flag
    if bash "$BUILD_SCRIPT" --update; then
        echo ""
        echo -e "${GREEN}✅ Build completed successfully${NC}"
        echo "Built files should be in: $(pwd)/dist-update"
        echo "Checking dist-update exists: $([ -d "dist-update" ] && echo "YES" || echo "NO")"
    else
        echo -e "${RED}❌ Build failed${NC}"
        echo "Current PWD: $(pwd)"
        exit 1
    fi
else
    echo -e "${RED}❌ src/scripts/build-with-docker.sh not found${NC}"
    echo "Current PWD: $(pwd)"
    echo "Files in current directory:"
    ls -la | head -10
    exit 1
fi

echo ""
echo -e "${YELLOW}Step 4: Update complete!${NC}"
echo "Final PWD: $(pwd)"
echo "Managed directory contents:"
ls -la "$MANAGED_DIR/electron-app/" | grep -E "^d.*dist" || echo "No dist directories found"
echo ""
echo -e "${GREEN}The application will now restart with the new version.${NC}"
echo ""
echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}Update completed successfully${NC}"
echo -e "${CYAN}Final PWD: $(pwd)${NC}"
echo -e "${CYAN}Finished: $(date)${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""

# Signal that we're ready for restart
echo "READY_FOR_RESTART"

exit 0
