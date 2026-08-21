#!/bin/bash

# Cloudsmith update script that downloads binary and restarts the app
# This script is designed to be run detached from the parent process
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
NC='\033[0m' # No Color

# Function to log with timestamp
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

# Function to log error and exit
log_error() {
    echo -e "${RED}[ERROR] $(date '+%Y-%m-%d %H:%M:%S') $1${NC}" >&2
    exit ${2:-1}
}

# Function to log success
log_success() {
    echo -e "${GREEN}[SUCCESS] $(date '+%Y-%m-%d %H:%M:%S') $1${NC}"
}

# Function to log info
log_info() {
    echo -e "${BLUE}[INFO] $(date '+%Y-%m-%d %H:%M:%S') $1${NC}"
}

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
    local prefix="$1"
    shift
    "$@" 2>&1 | while IFS= read -r line; do
        log "[$prefix] $(redact_sensitive_text_for_log "$line")"
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

# Note: Log file is already created by wrapper, we'll append to it
# The wrapper redirects our output to the log file

echo "========================================"
echo "Portico Update Process (Cloudsmith)"
echo "Started: $(date)"
echo "Script: $0"
echo "Script Location: $(realpath "$0")"
echo "Initial PWD: $(pwd)"
echo "Project Root (arg): $PROJECT_ROOT"
echo "Managed Directory: $MANAGED_DIR"
echo "Download URL: $(redact_url_for_log "$DOWNLOAD_URL")"
echo "Filename: $FILENAME"
echo "========================================"
echo

# Show current version info
echo "Current version info:"
if [ -f "$MANAGED_DIR/electron-app/build-info.json" ]; then
    log_info "Checking: $MANAGED_DIR/electron-app/build-info.json"
    CURRENT_BUILD=$(grep buildNumber "$MANAGED_DIR/electron-app/build-info.json" | cut -d'"' -f4)
    echo "  Build: $CURRENT_BUILD"
else
    log_info "No build-info.json found at: $MANAGED_DIR/electron-app/build-info.json"
fi
echo

# Change to project directory
log_info "Changing to PROJECT_ROOT: $PROJECT_ROOT"
cd "$PROJECT_ROOT"
log_info "Current PWD after cd: $(pwd)"

log "================ STEP 1: DOWNLOAD ================"
log_info "Downloading latest binary from Cloudsmith..."

# Create temporary directory for download
TEMP_DIR=$(mktemp -d)
log_info "Created temporary directory: $TEMP_DIR"

# Download the binary
DOWNLOAD_FILE="$TEMP_DIR/$FILENAME"
log_info "Download target: $DOWNLOAD_FILE"
log_info "Download URL: $(redact_url_for_log "$DOWNLOAD_URL")"
log_info "Starting download of $FILENAME..."

if command -v curl &> /dev/null; then
    log_info "Using curl for download..."
    # Use curl with progress bar and detailed error reporting
    if run_download_with_redacted_output CURL curl -L -f --progress-bar -o "$DOWNLOAD_FILE" "$DOWNLOAD_URL"; then
        log_success "Successfully downloaded binary using curl"
        log_info "Downloaded file size: $(ls -lh "$DOWNLOAD_FILE" | awk '{print $5}')"
    else
        log_error "Failed to download using curl (HTTP error or network issue)" 1
        rm -rf "$TEMP_DIR"
        exit 1
    fi
elif command -v wget &> /dev/null; then
    log_info "Using wget for download..."
    if run_download_with_redacted_output WGET wget --progress=bar:force -O "$DOWNLOAD_FILE" "$DOWNLOAD_URL"; then
        log_success "Successfully downloaded binary using wget"
        log_info "Downloaded file size: $(ls -lh "$DOWNLOAD_FILE" | awk '{print $5}')"
    else
        log_error "Failed to download using wget" 1
        rm -rf "$TEMP_DIR"
        exit 1
    fi
else
    log_error "Neither curl nor wget available for download" 1
    rm -rf "$TEMP_DIR"
    exit 1
fi

# Verify the file was downloaded
if [ ! -f "$DOWNLOAD_FILE" ]; then
    log_error "Downloaded file not found: $DOWNLOAD_FILE" 1
    rm -rf "$TEMP_DIR"
    exit 1
fi

log_info "Download verification passed"
log_info "File details: $(file "$DOWNLOAD_FILE" 2>/dev/null || echo 'file command not available')"

log
log "================ STEP 1.5: WAIT FOR APP EXIT ================"
log_info "Waiting for app to close before applying update..."
WAIT_COUNT=0
MAX_WAIT=30
while [ $WAIT_COUNT -lt $MAX_WAIT ]; do
    if ! pgrep -f "Portico" > /dev/null 2>&1; then
        log_success "App closed — ready to apply update"
        break
    fi
    # Show progress every 5 seconds so user knows we're not stuck
    if [ $((WAIT_COUNT % 5)) -eq 0 ] && [ $WAIT_COUNT -gt 0 ]; then
        log_info "Still waiting for app to close... (${WAIT_COUNT}s/${MAX_WAIT}s)"
    fi
    sleep 1
    WAIT_COUNT=$((WAIT_COUNT + 1))
done
if [ $WAIT_COUNT -ge $MAX_WAIT ]; then
    log_info "App still running after ${MAX_WAIT}s — continuing with update anyway"
fi

log
log "================ STEP 2: EXTRACTION ================"
log_info "Extracting binary to managed directory..."
log_info "Current PWD: $(pwd)"

log_info "Target directory: $MANAGED_DIR"
log_info "Verifying target exists: $([ -d "$MANAGED_DIR" ] && echo "YES" || echo "NO")"

# Create a temporary extraction directory
EXTRACT_TEMP="$TEMP_DIR/extract"
log_info "Creating temp extraction dir: $EXTRACT_TEMP"
mkdir -p "$EXTRACT_TEMP"

# Extract the zip file to temp location first
if command -v unzip &> /dev/null; then
    log_info "Extracting archive to temporary location..."
    # Extract quietly first to check structure
    if unzip -q "$DOWNLOAD_FILE" -d "$EXTRACT_TEMP"; then
        log_success "Archive extracted to temp location"
        
        # Check if there's an intermediate folder (like portico-main)
        EXTRACTED_ITEMS=$(ls -A "$EXTRACT_TEMP" | wc -l)
        FIRST_ITEM=$(ls -A "$EXTRACT_TEMP" | head -1)
        
        if [ "$EXTRACTED_ITEMS" -eq 1 ] && [ -d "$EXTRACT_TEMP/$FIRST_ITEM" ]; then
            SOURCE_DIR="$EXTRACT_TEMP/$FIRST_ITEM"
            log_info "Found intermediate folder: $FIRST_ITEM"
            log_info "Full path: $SOURCE_DIR"
        else
            SOURCE_DIR="$EXTRACT_TEMP"
            log_info "No intermediate folder found, using extracted root directly"
        fi

        RELEASE_MANIFEST="$SOURCE_DIR/release-manifest.json"
        MANAGED_ROOT_NAME="managed-root"
        MANAGED_SOURCE_DIR=""
        if [ -f "$RELEASE_MANIFEST" ]; then
            MANAGED_ROOT_NAME="$(manifest_get_string "$RELEASE_MANIFEST" "managedRootDir")"
            MANAGED_ROOT_NAME="${MANAGED_ROOT_NAME:-managed-root}"
            MANAGED_SOURCE_DIR="$SOURCE_DIR/$MANAGED_ROOT_NAME"
            log_info "Detected packaged release payload with manifest: $RELEASE_MANIFEST"

            SELECTED_ARCH="$(detect_payload_darwin_arch)"
            APP_BUNDLE_RELATIVE_PATH="$(manifest_get_string "$RELEASE_MANIFEST" "appBundles.${SELECTED_ARCH}")"
            if [ -n "$APP_BUNDLE_RELATIVE_PATH" ] && [ -d "$SOURCE_DIR/$APP_BUNDLE_RELATIVE_PATH" ]; then
                PAYLOAD_RESOURCES_ROOT="$(managed_runtime_normalize_packaged_resources_root "$SOURCE_DIR/$APP_BUNDLE_RELATIVE_PATH" || true)"
                if [ -n "$PAYLOAD_RESOURCES_ROOT" ]; then
                    log_info "Using payload app resources root for runtime compose regeneration: $PAYLOAD_RESOURCES_ROOT"
                fi
            fi
        else
            MANAGED_SOURCE_DIR="$SOURCE_DIR"
            log_info "Detected legacy source payload without release manifest"
        fi

        if [ ! -d "$MANAGED_SOURCE_DIR" ]; then
            log_error "Managed runtime tree not found in payload: $MANAGED_SOURCE_DIR" 1
            rm -rf "$TEMP_DIR"
            exit 1
        fi

        managed_runtime_remove_generated_compose_files "$MANAGED_SOURCE_DIR"

        FILE_COUNT=$(find "$MANAGED_SOURCE_DIR" -type f | wc -l)
        log_info "Reconciling $FILE_COUNT payload files into managed runtime tree..."
        managed_runtime_reconcile_payload "$MANAGED_SOURCE_DIR" "$MANAGED_DIR" "${PRESERVE_FILES[@]}"
        log_success "Managed runtime reconciled into $MANAGED_DIR"
    else
        log_error "Failed to extract binary" 1
        rm -rf "$TEMP_DIR"
        exit 1
    fi
else
    log_error "unzip command not available" 1
    rm -rf "$TEMP_DIR"
    exit 1
fi

log
log "================ STEP 3: BUILD INFO ================"
log_info "Regenerating build-info.json..."
BUILD_CHANNEL="portico"
if [ -f "$MANAGED_DIR/UPDATE_CHANNEL" ]; then
    CHANNEL_CONTENT="$(tr -d '[:space:]' < "$MANAGED_DIR/UPDATE_CHANNEL")"
    if [ -n "$CHANNEL_CONTENT" ]; then
        BUILD_CHANNEL="$CHANNEL_CONTENT"
    fi
fi
if ! BUILD_CHANNEL="$(resolve_update_channel_package_name "$BUILD_CHANNEL")"; then
    log_error "Invalid release channel package name in UPDATE_CHANNEL" 1
fi

# Parse filename to extract build info
# Format: {active-package-name}-{MMDDYYYY}-{8-to-40-char-sha}.zip
BUILD_IDENTITY="${FILENAME#${BUILD_CHANNEL}-}"
BUILD_IDENTITY="${BUILD_IDENTITY%.zip}"
if [ "$FILENAME" != "${BUILD_CHANNEL}-${BUILD_IDENTITY}.zip" ]; then
    log_error "Update filename does not match active release channel: $FILENAME" 1
fi
if [[ "$BUILD_IDENTITY" =~ ^([0-9]{8})-([a-f0-9]{8,40})$ ]]; then
    BUILD_DATE="${BASH_REMATCH[1]}"
    SHA="${BASH_REMATCH[2]}"
    # Use first 8 chars if it's a long SHA, otherwise use what we have
    if [ ${#SHA} -gt 8 ]; then
        SHORT_SHA="${SHA:0:8}"
    else
        SHORT_SHA="${SHA}"
    fi
    BUILD_NUMBER="${BUILD_DATE}-${SHORT_SHA}"
    
    # Create build-info.json in managed directory
    cat > "$MANAGED_DIR/electron-app/build-info.json" <<EOF
{
  "buildNumber": "${BUILD_NUMBER}",
  "fullSha": "${FULL_SHA}",
  "date": "${BUILD_DATE}",
  "channel": "${BUILD_CHANNEL}",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
}
EOF
    
    log_success "Generated build-info.json:"
    log_info "  Build Number: $BUILD_NUMBER"
    log_info "  Full SHA: $FULL_SHA"
    log_info "  Date: $BUILD_DATE"
    log_info "Build info file content:"
    cat "$MANAGED_DIR/electron-app/build-info.json" | while IFS= read -r line; do
        log "  $line"
    done
else
    log_error "Could not parse update filename for active release channel: $FILENAME" 1
fi

log_info "Regenerating managed runtime compose artifacts..."
if [ -n "$PAYLOAD_RESOURCES_ROOT" ]; then
    managed_runtime_require_packaged_generator_binary "$MANAGED_DIR" "$PAYLOAD_RESOURCES_ROOT" >/dev/null
    managed_runtime_regenerate_generated_compose "$MANAGED_DIR" "$SCRIPT_DIR" "$PAYLOAD_RESOURCES_ROOT"
else
    managed_runtime_regenerate_generated_compose "$MANAGED_DIR" "$SCRIPT_DIR"
fi
managed_runtime_validate_generated_compose "$MANAGED_DIR"

# Clean up downloaded file
log_info "Cleaning up temporary files..."
rm -rf "$TEMP_DIR"
log_success "Cleaned up temporary directory: $TEMP_DIR"

log
log "================ STEP 4: APP TERMINATION ================"
log_info "Waiting for app to exit gracefully..."

# The Electron app will exit itself gracefully after launching this script
# Give it a moment to fully exit
log_info "Waiting 3 seconds for graceful exit..."
sleep 3

# Check if any processes are still running
log_info "Checking for running Portico processes..."
if pgrep -f "Portico" > /dev/null 2>&1; then
    log_info "App still running, listing processes:"
    ps aux | grep -i "Portico" | grep -v grep | while IFS= read -r line; do
        log "  $line"
    done
    log_info "Forcing termination..."
    pkill -9 -f "Portico" 2>/dev/null || true
    sleep 1
    log_success "Forced termination completed"
else
    log_success "App has already exited gracefully"
fi

# Double-check processes are gone
if pgrep -f "Portico" > /dev/null 2>&1; then
    log_error "Failed to terminate Portico processes" 1
else
    log_success "All Portico processes terminated"
fi

log
log "================ STEP 5: BUILD UPDATE ================"
log_info "Building updated application to dist-update folder..."
log_info "Current PWD: $(pwd)"

# Build the updated app to dist-update folder
log_info "Changing to build directory: $MANAGED_DIR/electron-app"
cd "$MANAGED_DIR/electron-app"
log_info "Current PWD after cd: $(pwd)"

BUILD_SCRIPT="src/scripts/build-with-docker.sh"

if [ -f "$BUILD_SCRIPT" ]; then
    log_info "Found build script at: $(pwd)/$BUILD_SCRIPT"
    log_info "Building updated app with Docker..."
    log_info "Executing: bash $BUILD_SCRIPT --update"
    log_info "Build will output to: dist-update/"
    
    # Build to dist-update folder
    if bash "$BUILD_SCRIPT" --update 2>&1 | while IFS= read -r line; do
        log "[BUILD] $line"
    done; then
        log_success "Build completed successfully"
        log_info "Updated app built in dist-update folder"
        log_info "Checking dist-update exists: $([ -d "dist-update" ] && echo "YES" || echo "NO")"
    else
        log_error "Build failed" 1
        log_info "Current PWD: $(pwd)"
        exit 1
    fi
else
    log_error "src/scripts/build-with-docker.sh not found" 1
    log_info "Current PWD: $(pwd)"
    log_info "Files in current directory:"
    ls -la | head -10
    exit 1
fi

log
log "================ STEP 6: REPLACE APPLICATION ================"
log_info "Replacing current application with updated version..."

# Remove old dist folder and replace with dist-update
if [ -d "$MANAGED_DIR/electron-app/dist" ]; then
    log_info "Backing up current dist folder to dist-backup..."
    rm -rf "$MANAGED_DIR/electron-app/dist-backup"
    mv "$MANAGED_DIR/electron-app/dist" "$MANAGED_DIR/electron-app/dist-backup"
fi

if [ -d "$MANAGED_DIR/electron-app/dist-update" ]; then
    log_info "Moving dist-update to dist..."
    mv "$MANAGED_DIR/electron-app/dist-update" "$MANAGED_DIR/electron-app/dist"
    log_success "Application files replaced successfully"
else
    log_error "dist-update folder not found" 1
    # Restore backup if exists
    if [ -d "$MANAGED_DIR/electron-app/dist-backup" ]; then
        log_info "Restoring backup..."
        mv "$MANAGED_DIR/electron-app/dist-backup" "$MANAGED_DIR/electron-app/dist"
    fi
    exit 1
fi

# Clean up backup
if [ -d "$MANAGED_DIR/electron-app/dist-backup" ]; then
    log_info "Cleaning up backup folder..."
    rm -rf "$MANAGED_DIR/electron-app/dist-backup"
fi

log
log "================ STEP 7: RESTART APPLICATION ================"
log_info "Restarting application..."
log_info "Current PWD: $(pwd)"

# Launch the app
log_info "Changing to app directory: $MANAGED_DIR/electron-app"
cd "$MANAGED_DIR/electron-app"
log_info "Current PWD after cd: $(pwd)"
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS - detect architecture and launch appropriate app
    if [[ $(uname -m) == "arm64" ]]; then
        APP_PATH="dist/mac-arm64/Portico.app"
    else
        APP_PATH="dist/mac/Portico.app"
    fi
    
    if [ -d "$APP_PATH" ]; then
        log_info "Launching macOS app: $APP_PATH"
        open "$APP_PATH"
        log_success "Application launched successfully"
    else
        log_error "Application not found at $APP_PATH" 1
    fi
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    # Linux
    APP_PATH="dist/linux-unpacked/portico"
    if [ -f "$APP_PATH" ]; then
        log_info "Launching Linux app: $APP_PATH"
        "$APP_PATH" &
        log_success "Application launched successfully"
    else
        log_error "Application not found at $APP_PATH" 1
    fi
elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]] || [[ "$OSTYPE" == "win32" ]]; then
    # Windows
    APP_PATH="dist/win-unpacked/Portico.exe"
    if [ -f "$APP_PATH" ]; then
        log_info "Launching Windows app: $APP_PATH"
        "$APP_PATH" &
        log_success "Application launched successfully"
    else
        log_error "Application not found at $APP_PATH" 1
    fi
else
    log_error "Unsupported OS type: $OSTYPE" 1
fi

echo
echo "========================================"
echo "Cloudsmith update completed: $(date)"
echo "========================================"

exit 0
