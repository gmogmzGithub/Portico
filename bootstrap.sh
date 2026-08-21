#!/bin/bash

# Bootstrap script for Portico
# Downloads the latest version from Cloudsmith and sets up the managed directory
# This script is idempotent - safe to run on both new and existing installations
# Existing files in ~/portico/portico-managed are preserved
# Automatically migrates from old portico-managed directory if it exists
# Usage: ./bootstrap.sh

set -e

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

# Function to log warning
log_warning() {
    echo -e "${YELLOW}[WARNING] $(date '+%Y-%m-%d %H:%M:%S') $1${NC}"
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
    "$@" 2>&1 | while IFS= read -r line; do
        redact_sensitive_text_for_log "$line"
    done
    return "${PIPESTATUS[0]}"
}

# Parse command line arguments
OUTPUT_DIR=""  # Empty means use default (install_v2.sh will use "dist")
BUILD_OVERRIDE=""  # Empty means use latest build from Cloudsmith
LIST_BUILDS_ONLY=false  # Just list available builds and exit

while [[ $# -gt 0 ]]; do
    case $1 in
        --output-dir)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        --build-override)
            BUILD_OVERRIDE="$2"
            shift 2
            ;;
        --list-builds)
            LIST_BUILDS_ONLY=true
            shift
            ;;
        --help|-h)
            echo "Portico Bootstrap Installer"
            echo ""
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --output-dir DIR          Custom output directory for installation (default: dist)"
            echo "  --build-override BUILD    Install specific build instead of latest (e.g., 09172025-53f6ab6b)"
            echo "  --list-builds             List available builds from Cloudsmith and exit"
            echo "  --help, -h                Show this help message"
            echo ""
            echo "Examples:"
            echo "  $0                                    # Install latest build"
            echo "  $0 --list-builds                      # List available builds"
            echo "  $0 --build-override 09172025-53f6ab6b  # Install specific build"
            echo "  $0 --output-dir custom-dir            # Install to custom directory"
            exit 0
            ;;
        *)
            echo "Unknown argument: $1"
            echo "Use --help for usage information"
            shift
            ;;
    esac
done

echo "========================================"
echo "Portico Bootstrap Installer"
echo "Started: $(date)"
echo "========================================"
echo

# Validate build override format if provided
if [ -n "$BUILD_OVERRIDE" ]; then
    # Expected format: MMDDYYYY-SHA (e.g., 09172025-53f6ab6b)
    if ! [[ "$BUILD_OVERRIDE" =~ ^[0-9]{8}-[a-f0-9]+$ ]]; then
        log_error "Invalid build override format: $BUILD_OVERRIDE"
        log_info "Expected format: MMDDYYYY-SHA (e.g., 09172025-53f6ab6b)"
        log_info "  - MMDDYYYY: 8-digit date (e.g., 09172025)"
        log_info "  - SHA: git commit SHA (e.g., 53f6ab6b)"
        exit 1
    fi
    log_info "Build override validated: $BUILD_OVERRIDE"
fi

# Step 1: Check for latest version from Cloudsmith (or specific build if override provided)
log "================ STEP 1: DETERMINE BUILD VERSION ================"
if [ -n "$BUILD_OVERRIDE" ]; then
    log_info "Build override specified: $BUILD_OVERRIDE"
    log_info "Will search Cloudsmith for specific build instead of latest..."
else
    log_info "No build override - will search for latest version in Cloudsmith..."
fi

# Cloudsmith API configuration — source from cloudsmith.env (single source of truth)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_SECRETS_SH="$SCRIPT_DIR/src/scripts/runtime-secrets.sh"
RELEASE_CHANNEL_SH="$SCRIPT_DIR/src/scripts/release-channel.sh"
if [ -f "$RUNTIME_SECRETS_SH" ]; then
    # shellcheck source=/dev/null
    . "$RUNTIME_SECRETS_SH"
fi
if [ ! -f "$RELEASE_CHANNEL_SH" ]; then
    log_error "Release channel helper not found: $RELEASE_CHANNEL_SH"
fi
# shellcheck source=/dev/null
. "$RELEASE_CHANNEL_SH"
if [ -f "$SCRIPT_DIR/cloudsmith.env" ]; then
    # shellcheck source=cloudsmith.env
    . "$SCRIPT_DIR/cloudsmith.env"
fi
# Allow env var overrides
CLOUDSMITH_OWNER="${CLOUDSMITH_OWNER:-portico}"
CLOUDSMITH_REPO="${CLOUDSMITH_REPO:-portico}"
CLOUDSMITH_API_BASE="${CLOUDSMITH_API_BASE:-https://api.cloudsmith.io/v1}"
CLOUDSMITH_DL_BASE="${CLOUDSMITH_DL_BASE:-https://dl.artifacts.example.invalid}"
CLOUDSMITH_API_KEY="${CLOUDSMITH_API_KEY:-}"
CLOUDSMITH_ENTITLEMENT_TOKEN="${CLOUDSMITH_ENTITLEMENT_TOKEN:-}"
if command -v resolve_cloudsmith_entitlement_token >/dev/null 2>&1; then
    export PROJECT_ROOT="$SCRIPT_DIR"
    resolved_cloudsmith_token="$(resolve_cloudsmith_entitlement_token || true)"
    if [ -n "$resolved_cloudsmith_token" ]; then
        CLOUDSMITH_ENTITLEMENT_TOKEN="$resolved_cloudsmith_token"
    fi
fi
if [ -z "$CLOUDSMITH_ENTITLEMENT_TOKEN" ]; then
    log_error "CLOUDSMITH_ENTITLEMENT_TOKEN is not set. Ensure cloudsmith.env exists or set the env var manually."
fi

# Determine the update channel (release channel support)
# If UPDATE_CHANNEL file exists and is not empty, use it; otherwise default to "portico"
# Check in the managed directory first (for updates), then fall back to current directory (for initial install)
MANAGED_DIR="$HOME/portico/portico-managed"
if [ -f "$MANAGED_DIR/UPDATE_CHANNEL" ] && [ -s "$MANAGED_DIR/UPDATE_CHANNEL" ]; then
    UPDATE_CHANNEL_FILE="$MANAGED_DIR/UPDATE_CHANNEL"
    KEYWORD=$(cat "$UPDATE_CHANNEL_FILE" | tr -d '[:space:]')
    if [ -z "$KEYWORD" ]; then
        KEYWORD="portico"
        log_info "UPDATE_CHANNEL file is empty, using default channel: $KEYWORD"
    else
        log_info "Using custom update channel from $UPDATE_CHANNEL_FILE: $KEYWORD"
    fi
elif [ -f "$(pwd)/UPDATE_CHANNEL" ] && [ -s "$(pwd)/UPDATE_CHANNEL" ]; then
    UPDATE_CHANNEL_FILE="$(pwd)/UPDATE_CHANNEL"
    KEYWORD=$(cat "$UPDATE_CHANNEL_FILE" | tr -d '[:space:]')
    if [ -z "$KEYWORD" ]; then
        KEYWORD="portico"
        log_info "UPDATE_CHANNEL file is empty, using default channel: $KEYWORD"
    else
        log_info "Using custom update channel from $UPDATE_CHANNEL_FILE: $KEYWORD"
    fi
else
    KEYWORD="portico"
    log_info "No UPDATE_CHANNEL file found in managed directory ($MANAGED_DIR) or current directory, using default channel: $KEYWORD"
fi
if ! KEYWORD="$(resolve_update_channel_package_name "$KEYWORD")"; then
    log_warning "Ignoring malformed UPDATE_CHANNEL value and using Stable"
    KEYWORD="portico"
fi

# Fetch packages from Cloudsmith API
log_info "Fetching available versions from Cloudsmith..."
ENCODED_PACKAGE_QUERY="name%3A${KEYWORD}%20format%3Araw"
REQUIRE_READY_MARKER=false
if [ -z "$BUILD_OVERRIDE" ]; then
    ENCODED_PACKAGE_QUERY="${ENCODED_PACKAGE_QUERY}%20tag%3A%5Eportico-update-ready-v1%24"
    REQUIRE_READY_MARKER=true
fi
API_URL="${CLOUDSMITH_API_BASE}/packages/${CLOUDSMITH_OWNER}/${CLOUDSMITH_REPO}/?query=${ENCODED_PACKAGE_QUERY}&page_size=100&sort=-date"
log_info "API URL: $API_URL"

# Build auth header if token available
CURL_AUTH_HEADER=""
CS_TOKEN="${CLOUDSMITH_ENTITLEMENT_TOKEN:-}"
if [ -n "$CS_TOKEN" ]; then
    CURL_AUTH_HEADER="-H \"X-Api-Key: ${CS_TOKEN}\""
fi

# Use curl to fetch the API response
if command -v curl &> /dev/null; then
    if [ -n "$CS_TOKEN" ]; then
        API_RESPONSE=$(curl -s -H "X-Api-Key: ${CS_TOKEN}" "$API_URL")
    else
        API_RESPONSE=$(curl -s "$API_URL")
    fi
    if [ $? -ne 0 ]; then
        log_error "Failed to fetch data from Cloudsmith API"
    fi
elif command -v wget &> /dev/null; then
    if [ -n "$CS_TOKEN" ]; then
        API_RESPONSE=$(wget -qO- --header="X-Api-Key: ${CS_TOKEN}" "$API_URL")
    else
        API_RESPONSE=$(wget -qO- "$API_URL")
    fi
    if [ $? -ne 0 ]; then
        log_error "Failed to fetch data from Cloudsmith API"
    fi
else
    log_error "Neither curl nor wget is available. Please install one of them."
fi

# Parse the Cloudsmith JSON response to find builds
# Cloudsmith returns package objects with: filename, version, uploaded_at/created_at, cdn_url
log_info "Parsing response to find builds..."

# Create a temporary file to store all builds with timestamps
TEMP_BUILDS=$(mktemp)

if command -v python3 >/dev/null 2>&1; then
    API_RESPONSE_JSON="$API_RESPONSE" python3 -c '
import json
import os
import sys

token, dl_base, repo, keyword, require_ready_marker = sys.argv[1:6]
packages = json.loads(os.environ["API_RESPONSE_JSON"])

def flatten_tags(value):
    tags = set()
    if isinstance(value, str):
        tags.add(value.strip())
    elif isinstance(value, list):
        for item in value:
            tags.update(flatten_tags(item))
    elif isinstance(value, dict):
        for item in value.values():
            tags.update(flatten_tags(item))
    return tags

for pkg in packages:
    if require_ready_marker == "true" and "portico-update-ready-v1" not in flatten_tags(pkg.get("tags_immutable")):
        continue

    filename = pkg.get("filename")
    timestamp = pkg.get("uploaded_at") or pkg.get("created_at")
    if not filename or not timestamp:
        continue

    cdn_url = pkg.get("cdn_url")
    if cdn_url:
        download_url = cdn_url.replace("/basic/", f"/{token}/") if token else cdn_url
    else:
        token_segment = token or "basic"
        download_url = f"{dl_base}/{token_segment}/{repo}/raw/names/{keyword}/versions/{pkg.get('version','')}/{filename}"

    print(f"{timestamp}|{download_url}|{filename}")
' "$CLOUDSMITH_ENTITLEMENT_TOKEN" "$CLOUDSMITH_DL_BASE" "$CLOUDSMITH_REPO" "$KEYWORD" "$REQUIRE_READY_MARKER" > "$TEMP_BUILDS"
else
    # Fallback parser for environments without python3.
    printf '%s\n' "$API_RESPONSE" | awk '
        BEGIN { depth = 0; in_string = 0; escaped = 0; object = "" }
        {
            for (i = 1; i <= length($0); i++) {
                char = substr($0, i, 1)
                if (depth > 0) {
                    object = object char
                }
                if (in_string) {
                    if (escaped) {
                        escaped = 0
                    } else if (char == "\\") {
                        escaped = 1
                    } else if (char == "\"") {
                        in_string = 0
                    }
                    continue
                }
                if (char == "\"") {
                    in_string = 1
                } else if (char == "{") {
                    if (depth == 0) {
                        object = "{"
                    }
                    depth++
                } else if (char == "}") {
                    depth--
                    if (depth == 0) {
                        print object
                        object = ""
                    }
                }
            }
        }
    ' | while IFS= read -r item; do
        if [ "$REQUIRE_READY_MARKER" = true ]; then
            immutable_tags=$(printf '%s\n' "$item" | sed -n 's/.*"tags_immutable"[[:space:]]*:[[:space:]]*{\([^}]*\)}.*/\1/p')
            case "$immutable_tags" in
                *'"portico-update-ready-v1"'*) ;;
                *) continue ;;
            esac
        fi

        pkg_filename=$(echo "$item" | sed -n 's/.*"filename" *: *"\([^"]*\)".*/\1/p')
        pkg_version=$(echo "$item" | sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p')
        pkg_created=$(echo "$item" | sed -n 's/.*"uploaded_at" *: *"\([^"]*\)".*/\1/p')
        if [ -z "$pkg_created" ]; then
            pkg_created=$(echo "$item" | sed -n 's/.*"created_at" *: *"\([^"]*\)".*/\1/p')
        fi
        pkg_cdn_url=$(echo "$item" | sed -n 's/.*"cdn_url" *: *"\([^"]*\)".*/\1/p')

        if [ -n "$pkg_filename" ] && [ -n "$pkg_created" ]; then
            if [ -n "$pkg_cdn_url" ] && [ -n "$CLOUDSMITH_ENTITLEMENT_TOKEN" ]; then
                dl_url=$(echo "$pkg_cdn_url" | sed "s|/basic/|/${CLOUDSMITH_ENTITLEMENT_TOKEN}/|")
            else
                dl_url="${CLOUDSMITH_DL_BASE}/${CLOUDSMITH_ENTITLEMENT_TOKEN:-basic}/${CLOUDSMITH_REPO}/raw/names/${KEYWORD}/versions/${pkg_version}/files/${pkg_filename}"
            fi
            echo "${pkg_created}|${dl_url}|${pkg_filename}" >> "$TEMP_BUILDS"
        fi
    done
fi

while IFS='|' read -r timestamp url filename; do
    [ -n "$filename" ] || continue
    log_info "Found build: $filename (uploaded: $timestamp)"
done < "$TEMP_BUILDS"

# Check if we found any builds
if [ ! -s "$TEMP_BUILDS" ]; then
    rm -f "$TEMP_BUILDS"
    log_error "No builds found for channel '$KEYWORD' in Cloudsmith repository"
fi

# If user just wants to list builds, show them and exit
if [ "$LIST_BUILDS_ONLY" = true ]; then
    echo
    log_success "Available builds in Cloudsmith (sorted by newest first):"
    echo
    echo "Build Number           Date        SHA          Modified"
    echo "─────────────────────  ──────────  ───────────  ────────────────────"

    # Sort by timestamp (newest first) and display
    sort -r "$TEMP_BUILDS" | while IFS='|' read -r timestamp url filename; do
        # Extract build info from filename (format: {channel}-{date}-{sha}.zip)
        if [[ "$filename" =~ ${KEYWORD}-([0-9]{8})-([a-f0-9]+)\.zip$ ]]; then
            build_date="${BASH_REMATCH[1]}"
            build_sha="${BASH_REMATCH[2]}"

            # Format the date for display (MMDDYYYY -> MM/DD/YYYY)
            display_date="${build_date:0:2}/${build_date:2:2}/${build_date:4:4}"

            # Short SHA
            if [ ${#build_sha} -gt 8 ]; then
                short_sha="${build_sha:0:8}"
            else
                short_sha="$build_sha"
            fi

            build_number="${build_date}-${short_sha}"

            # Format timestamp for display
            display_time=$(echo "$timestamp" | sed 's/T/ /' | sed 's/\.[0-9]*Z//')

            printf "%-22s %-11s %-12s %s\n" "$build_number" "$display_date" "$short_sha" "$display_time"
        fi
    done | head -20

    echo
    log_info "To install a specific build, use: $0 --build-override BUILD_NUMBER"
    log_info "Example: $0 --build-override $(sort -r "$TEMP_BUILDS" | head -1 | cut -d'|' -f3 | sed "s/${KEYWORD}-\\(.*\\)\\.zip/\\1/")"

    rm -f "$TEMP_BUILDS"
    exit 0
fi

# Determine which build to use based on override or latest
BUILD_LAST_MODIFIED=""
if [ -n "$BUILD_OVERRIDE" ]; then
    log_info "Searching for specific build: $BUILD_OVERRIDE"

    # Search for the override build in our collected builds
    # Build override format: MMDDYYYY-SHA (e.g., 09172025-53f6ab6b)
    OVERRIDE_INFO=$(grep "${KEYWORD}-${BUILD_OVERRIDE}\\.zip" "$TEMP_BUILDS" | head -1)

    if [ -z "$OVERRIDE_INFO" ]; then
        echo
        log_error "Build override '$BUILD_OVERRIDE' not found in Cloudsmith repository"
        echo
        log_info "Available builds (showing 10 most recent):"
        echo
        echo "Build Number           Date        SHA"
        echo "─────────────────────  ──────────  ───────────"

        # Show available builds in a nice format
        sort -r "$TEMP_BUILDS" | head -10 | while IFS='|' read -r timestamp url filename; do
            if [[ "$filename" =~ ${KEYWORD}-([0-9]{8})-([a-f0-9]+)\.zip$ ]]; then
                build_date="${BASH_REMATCH[1]}"
                build_sha="${BASH_REMATCH[2]}"
                display_date="${build_date:0:2}/${build_date:2:2}/${build_date:4:4}"

                if [ ${#build_sha} -gt 8 ]; then
                    short_sha="${build_sha:0:8}"
                else
                    short_sha="$build_sha"
                fi

                build_number="${build_date}-${short_sha}"
                printf "%-22s %-11s %s\n" "$build_number" "$display_date" "$short_sha"
            fi
        done

        echo
        log_info "Use --list-builds to see all available builds"
        log_info "Example: $0 --build-override $(sort -r "$TEMP_BUILDS" | head -1 | cut -d'|' -f3 | sed "s/${KEYWORD}-\\(.*\\)\\.zip/\\1/")"

        rm -f "$TEMP_BUILDS"
        exit 1
    fi

    BUILD_LAST_MODIFIED=$(echo "$OVERRIDE_INFO" | cut -d'|' -f1)
    DOWNLOAD_URL=$(echo "$OVERRIDE_INFO" | cut -d'|' -f2)
    FILENAME=$(echo "$OVERRIDE_INFO" | cut -d'|' -f3)
    log_success "Found specified build: $FILENAME"
else
    # Sort by timestamp (newest first) and get the first one
    log_info "Selecting latest build from Cloudsmith..."
    LATEST_INFO=$(sort -r "$TEMP_BUILDS" | head -1)
    BUILD_LAST_MODIFIED=$(echo "$LATEST_INFO" | cut -d'|' -f1)
    DOWNLOAD_URL=$(echo "$LATEST_INFO" | cut -d'|' -f2)
    FILENAME=$(echo "$LATEST_INFO" | cut -d'|' -f3)
    log_success "Found latest build: $FILENAME"
fi

# Clean up temp file
rm -f "$TEMP_BUILDS"

if [ -z "$DOWNLOAD_URL" ] || [ -z "$FILENAME" ]; then
    log_error "Failed to determine build from Cloudsmith repository"
fi

# Extract build information from filename (format: {channel}-{date}-{sha}.zip)
if [[ "$FILENAME" =~ ${KEYWORD}-([0-9]{8})-([a-f0-9]+)\.zip$ ]]; then
    BUILD_DATE="${BASH_REMATCH[1]}"
    BUILD_SHA="${BASH_REMATCH[2]}"
    
    # Use first 8 chars for short SHA
    if [ ${#BUILD_SHA} -gt 8 ]; then
        SHORT_SHA="${BUILD_SHA:0:8}"
    else
        SHORT_SHA="${BUILD_SHA}"
    fi
    BUILD_NUMBER="${BUILD_DATE}-${SHORT_SHA}"
else
    log_error "Unexpected filename format: $FILENAME"
fi

if [ -n "$BUILD_OVERRIDE" ]; then
    log_success "Using build override: $BUILD_NUMBER"
    log_info "Note: This is NOT the latest build - you specified this version"
else
    log_success "Found latest version: $BUILD_NUMBER"
fi
log_info "Download URL: $(redact_url_for_log "$DOWNLOAD_URL")"
log_info "Filename: $FILENAME"
if [ -n "$BUILD_LAST_MODIFIED" ]; then
    log_info "Cloudsmith uploaded_at: $BUILD_LAST_MODIFIED"
fi

# Step 2: Prepare managed directory (Nuclear cleanup preserving critical files)
log
log "================ STEP 2: PREPARE MANAGED DIRECTORY (NUCLEAR) ================"
# MANAGED_DIR already declared at top for UPDATE_CHANNEL check
log_info "Preparing managed directory: $MANAGED_DIR"

# Files/folders to preserve during nuclear cleanup
PRESERVE_ENV=".env"
PRESERVE_RUNTIME_ENV=".env.runtime"
PRESERVE_DATA="open-webui-data"
PRESERVE_USER_MCP="mcp-configs-user"
PRESERVE_OAUTH_TOKENS="mcpo-oauth-tokens"
PRESERVE_OAUTH_TOKENS_CORE="mcpo-core-oauth-tokens"
PRESERVE_UPDATE_CHANNEL="UPDATE_CHANNEL"
PRESERVE_ARTIFACT_SNAPSHOTS="artifact-snapshots"
PRESERVE_SKILLS_MARKETPLACE="skills-marketplace"
PRESERVE_SKILLS_USER="skills-user"
PRESERVE_MCP_TOGGLES="mcp_toggles.json"
PRESERVE_MCP_DISABLE_MODES="mcp_disable_modes.json"
PRESERVE_MCP_TOOLS_CONFIG="mcp_tools_config.json"
PRESERVE_MARKETPLACES="marketplaces.json"
PRESERVE_WORKSPACES="workspaces"

# Initialize backup temp directory variables (must be accessible later for restoration)
BACKUP_TEMP=""
FULL_BACKUP_TEMP=""
FULL_BACKUP_ZIP_NAME=""
FULL_BACKUP_ZIP_PATH=""

if [ -d "$MANAGED_DIR" ]; then
    log_warning "Existing installation detected - performing selective cleanup"
    log_info "Preserving critical files and backup folder: $PRESERVE_ENV, $PRESERVE_RUNTIME_ENV, $PRESERVE_DATA, $PRESERVE_USER_MCP, $PRESERVE_OAUTH_TOKENS, $PRESERVE_OAUTH_TOKENS_CORE, $PRESERVE_UPDATE_CHANNEL, $PRESERVE_ARTIFACT_SNAPSHOTS, $PRESERVE_SKILLS_MARKETPLACE, $PRESERVE_SKILLS_USER, $PRESERVE_MCP_TOGGLES, $PRESERVE_MCP_TOOLS_CONFIG, $PRESERVE_MARKETPLACES, $PRESERVE_WORKSPACES, backup/"
    log_info "Built-in skills directory (skills/) is update-managed and will be replaced by package contents."

    # STEP 1: Create full backup of entire app folder FIRST
    log
    log_warning "================ CREATING FULL APP BACKUP ================"
    FULL_BACKUP_TEMP=$(mktemp -d)
    FULL_BACKUP_TIMESTAMP=$(date +%s)
    FULL_BACKUP_ZIP_NAME="portico_full_backup_${FULL_BACKUP_TIMESTAMP}.zip"
    FULL_BACKUP_ZIP_PATH="$FULL_BACKUP_TEMP/$FULL_BACKUP_ZIP_NAME"

    log_info "Creating complete backup of entire app folder..."
    log_info "Source: $MANAGED_DIR"
    log_info "Backup location: $FULL_BACKUP_ZIP_PATH"
    log_info "Exclusions:"
    log_info "  - electron-app/node_modules (large dependencies, can be regenerated)"
    log_info "  - electron-app/dist (built application binaries, can be regenerated)"
    log_info "  - backup folder (prevents telescoping backup growth)"
    log_info "  - .venv directories (Python virtual environments, can be regenerated)"

    if command -v zip &> /dev/null; then
        # Count files being backed up (excluding node_modules, dist, backup folder, and .venv directories)
        TOTAL_FILES=$(find "$MANAGED_DIR" -type f \
            ! -path "$MANAGED_DIR/electron-app/node_modules/*" \
            ! -path "$MANAGED_DIR/electron-app/dist/*" \
            ! -path "$MANAGED_DIR/backup/*" \
            ! -path "*/.venv/*" \
            2>/dev/null | wc -l)
        log_info "Backing up $TOTAL_FILES files from app folder (excluding node_modules, dist, backup, and .venv)..."

        # Create zip of entire managed directory with exclusions
        # We cd to parent directory, so exclusions are relative to that
        # Exclude .venv directories by matching the directory itself (zip excludes recursively)
        MANAGED_DIR_BASENAME=$(basename "$MANAGED_DIR")
        (cd "$MANAGED_DIR/.." && zip -r --symlinks "$FULL_BACKUP_ZIP_PATH" "$MANAGED_DIR_BASENAME" \
            -x "$MANAGED_DIR_BASENAME/electron-app/node_modules/*" \
            -x "$MANAGED_DIR_BASENAME/electron-app/dist/*" \
            -x "$MANAGED_DIR_BASENAME/backup/*" \
            -x "$MANAGED_DIR_BASENAME/core-mcp/mcp-assistant/.venv/*" \
            -x "$MANAGED_DIR_BASENAME/core-mcp/subagents/.venv/*" \
            2>&1) | grep -v "^\s*adding:" | grep -v "zip warning: name not matched" || true

        if [ -f "$FULL_BACKUP_ZIP_PATH" ]; then
            FULL_BACKUP_SIZE=$(ls -lh "$FULL_BACKUP_ZIP_PATH" | awk '{print $5}')
            log_success "✓ Full app backup created: $FULL_BACKUP_ZIP_NAME ($FULL_BACKUP_SIZE)"
            log_info "  This archive contains your app folder (excluding node_modules, dist, .venv, and old backups)"
        else
            log_error "FAILED to create full backup - aborting for safety!"
        fi
    else
        log_error "zip command not available - cannot create full backup. Aborting for safety."
    fi

    log
    log_info "================ CREATING SELECTIVE BACKUP FOR RESTORE ================"

    # Create temporary backup directory for selective restore
    BACKUP_TEMP=$(mktemp -d)
    log_info "Created selective restore backup directory: $BACKUP_TEMP"

    # Backup critical files if they exist BEFORE nuclear wipeout
    if [ -f "$MANAGED_DIR/$PRESERVE_ENV" ]; then
        log_info "Backing up $PRESERVE_ENV..."
        cp "$MANAGED_DIR/$PRESERVE_ENV" "$BACKUP_TEMP/"
        if [ -f "$BACKUP_TEMP/$PRESERVE_ENV" ]; then
            log_success "✓ $PRESERVE_ENV backed up successfully ($(wc -l < "$BACKUP_TEMP/$PRESERVE_ENV") lines)"
        else
            log_error "FAILED to backup $PRESERVE_ENV - aborting!"
        fi
    else
        log_info "$PRESERVE_ENV not found - skipping backup"
    fi

    if [ -f "$MANAGED_DIR/$PRESERVE_RUNTIME_ENV" ]; then
        log_info "Backing up $PRESERVE_RUNTIME_ENV..."
        cp "$MANAGED_DIR/$PRESERVE_RUNTIME_ENV" "$BACKUP_TEMP/"
        if [ -f "$BACKUP_TEMP/$PRESERVE_RUNTIME_ENV" ]; then
            log_success "✓ $PRESERVE_RUNTIME_ENV backed up successfully ($(wc -l < "$BACKUP_TEMP/$PRESERVE_RUNTIME_ENV") lines)"
        else
            log_error "FAILED to backup $PRESERVE_RUNTIME_ENV - aborting!"
        fi
    else
        log_info "$PRESERVE_RUNTIME_ENV not found - skipping backup"
    fi

    if [ -d "$MANAGED_DIR/$PRESERVE_DATA" ]; then
        log_info "Backing up $PRESERVE_DATA directory..."
        cp -R "$MANAGED_DIR/$PRESERVE_DATA" "$BACKUP_TEMP/"
        if [ -d "$BACKUP_TEMP/$PRESERVE_DATA" ]; then
            log_success "✓ $PRESERVE_DATA directory backed up successfully"
        else
            log_error "FAILED to backup $PRESERVE_DATA - aborting!"
        fi
    else
        log_info "$PRESERVE_DATA directory not found - skipping backup"
    fi

    if [ -d "$MANAGED_DIR/$PRESERVE_USER_MCP" ]; then
        log_info "Backing up $PRESERVE_USER_MCP directory (user-installed MCP servers)..."
        cp -R "$MANAGED_DIR/$PRESERVE_USER_MCP" "$BACKUP_TEMP/"
        if [ -d "$BACKUP_TEMP/$PRESERVE_USER_MCP" ]; then
            log_success "✓ $PRESERVE_USER_MCP directory backed up successfully"
        else
            log_error "FAILED to backup $PRESERVE_USER_MCP - aborting!"
        fi
    else
        log_info "$PRESERVE_USER_MCP directory not found - skipping backup"
    fi

    if [ -d "$MANAGED_DIR/$PRESERVE_OAUTH_TOKENS" ]; then
        log_info "Backing up $PRESERVE_OAUTH_TOKENS directory (OAuth tokens)..."
        cp -R "$MANAGED_DIR/$PRESERVE_OAUTH_TOKENS" "$BACKUP_TEMP/"
        if [ -d "$BACKUP_TEMP/$PRESERVE_OAUTH_TOKENS" ]; then
            OAUTH_TOKEN_COUNT=$(find "$BACKUP_TEMP/$PRESERVE_OAUTH_TOKENS" -type f -name "*.json" | wc -l)
            log_success "✓ $PRESERVE_OAUTH_TOKENS directory backed up successfully ($OAUTH_TOKEN_COUNT token files)"
        else
            log_error "FAILED to backup $PRESERVE_OAUTH_TOKENS - aborting!"
        fi
    else
        log_info "$PRESERVE_OAUTH_TOKENS directory not found - skipping backup"
    fi

    if [ -d "$MANAGED_DIR/$PRESERVE_OAUTH_TOKENS_CORE" ]; then
        log_info "Backing up $PRESERVE_OAUTH_TOKENS_CORE directory (OAuth tokens for mcpo-core)..."
        cp -R "$MANAGED_DIR/$PRESERVE_OAUTH_TOKENS_CORE" "$BACKUP_TEMP/"
        if [ -d "$BACKUP_TEMP/$PRESERVE_OAUTH_TOKENS_CORE" ]; then
            OAUTH_TOKEN_CORE_COUNT=$(find "$BACKUP_TEMP/$PRESERVE_OAUTH_TOKENS_CORE" -type f -name "*.json" | wc -l)
            log_success "✓ $PRESERVE_OAUTH_TOKENS_CORE directory backed up successfully ($OAUTH_TOKEN_CORE_COUNT token files)"
        else
            log_error "FAILED to backup $PRESERVE_OAUTH_TOKENS_CORE - aborting!"
        fi
    else
        log_info "$PRESERVE_OAUTH_TOKENS_CORE directory not found - skipping backup"
    fi

    if [ -f "$MANAGED_DIR/$PRESERVE_UPDATE_CHANNEL" ]; then
        log_info "Backing up $PRESERVE_UPDATE_CHANNEL (update channel configuration)..."
        cp "$MANAGED_DIR/$PRESERVE_UPDATE_CHANNEL" "$BACKUP_TEMP/"
        if [ -f "$BACKUP_TEMP/$PRESERVE_UPDATE_CHANNEL" ]; then
            CHANNEL_CONTENT=$(cat "$BACKUP_TEMP/$PRESERVE_UPDATE_CHANNEL" | tr -d '[:space:]')
            log_success "✓ $PRESERVE_UPDATE_CHANNEL backed up successfully (channel: $CHANNEL_CONTENT)"
        else
            log_error "FAILED to backup $PRESERVE_UPDATE_CHANNEL - aborting!"
        fi
    else
        log_info "$PRESERVE_UPDATE_CHANNEL not found - skipping backup"
    fi

    if [ -d "$MANAGED_DIR/$PRESERVE_ARTIFACT_SNAPSHOTS" ]; then
        log_info "Backing up $PRESERVE_ARTIFACT_SNAPSHOTS directory (artifact version snapshots)..."
        cp -R "$MANAGED_DIR/$PRESERVE_ARTIFACT_SNAPSHOTS" "$BACKUP_TEMP/"
        if [ -d "$BACKUP_TEMP/$PRESERVE_ARTIFACT_SNAPSHOTS" ]; then
            ARTIFACT_COUNT=$(find "$BACKUP_TEMP/$PRESERVE_ARTIFACT_SNAPSHOTS" -type d -mindepth 1 -maxdepth 1 | wc -l)
            log_success "✓ $PRESERVE_ARTIFACT_SNAPSHOTS directory backed up successfully ($ARTIFACT_COUNT artifacts)"
        else
            log_error "FAILED to backup $PRESERVE_ARTIFACT_SNAPSHOTS - aborting!"
        fi
    else
        log_info "$PRESERVE_ARTIFACT_SNAPSHOTS directory not found - skipping backup"
    fi

    if [ -d "$MANAGED_DIR/$PRESERVE_SKILLS_MARKETPLACE" ]; then
        log_info "Backing up $PRESERVE_SKILLS_MARKETPLACE directory (marketplace skills)..."
        cp -R "$MANAGED_DIR/$PRESERVE_SKILLS_MARKETPLACE" "$BACKUP_TEMP/"
        if [ -d "$BACKUP_TEMP/$PRESERVE_SKILLS_MARKETPLACE" ]; then
            log_success "✓ $PRESERVE_SKILLS_MARKETPLACE directory backed up successfully"
        else
            log_error "FAILED to backup $PRESERVE_SKILLS_MARKETPLACE - aborting!"
        fi
    else
        log_info "$PRESERVE_SKILLS_MARKETPLACE directory not found - skipping backup"
    fi

    if [ -d "$MANAGED_DIR/$PRESERVE_SKILLS_USER" ]; then
        log_info "Backing up $PRESERVE_SKILLS_USER directory (user-created skills)..."
        cp -R "$MANAGED_DIR/$PRESERVE_SKILLS_USER" "$BACKUP_TEMP/"
        if [ -d "$BACKUP_TEMP/$PRESERVE_SKILLS_USER" ]; then
            USER_SKILLS_COUNT=$(find "$BACKUP_TEMP/$PRESERVE_SKILLS_USER" -type d -mindepth 1 -maxdepth 1 | wc -l)
            log_success "✓ $PRESERVE_SKILLS_USER directory backed up successfully ($USER_SKILLS_COUNT skills)"
        else
            log_error "FAILED to backup $PRESERVE_SKILLS_USER - aborting!"
        fi
    else
        log_info "$PRESERVE_SKILLS_USER directory not found - skipping backup"
    fi

    if [ -f "$MANAGED_DIR/$PRESERVE_MCP_TOGGLES" ]; then
        log_info "Backing up $PRESERVE_MCP_TOGGLES (MCP server toggles)..."
        cp "$MANAGED_DIR/$PRESERVE_MCP_TOGGLES" "$BACKUP_TEMP/"
        if [ -f "$BACKUP_TEMP/$PRESERVE_MCP_TOGGLES" ]; then
            log_success "✓ $PRESERVE_MCP_TOGGLES backed up successfully"
        else
            log_error "FAILED to backup $PRESERVE_MCP_TOGGLES - aborting!"
        fi
    else
        log_info "$PRESERVE_MCP_TOGGLES not found - skipping backup"
    fi

    if [ -f "$MANAGED_DIR/$PRESERVE_MCP_DISABLE_MODES" ]; then
        log_info "Backing up $PRESERVE_MCP_DISABLE_MODES (MCP disable modes)..."
        cp "$MANAGED_DIR/$PRESERVE_MCP_DISABLE_MODES" "$BACKUP_TEMP/"
        if [ -f "$BACKUP_TEMP/$PRESERVE_MCP_DISABLE_MODES" ]; then
            log_success "✓ $PRESERVE_MCP_DISABLE_MODES backed up successfully"
        else
            log_error "FAILED to backup $PRESERVE_MCP_DISABLE_MODES - aborting!"
        fi
    else
        log_info "$PRESERVE_MCP_DISABLE_MODES not found - skipping backup"
    fi

    if [ -f "$MANAGED_DIR/$PRESERVE_MCP_TOOLS_CONFIG" ]; then
        log_info "Backing up $PRESERVE_MCP_TOOLS_CONFIG (MCP tools configuration)..."
        cp "$MANAGED_DIR/$PRESERVE_MCP_TOOLS_CONFIG" "$BACKUP_TEMP/"
        if [ -f "$BACKUP_TEMP/$PRESERVE_MCP_TOOLS_CONFIG" ]; then
            log_success "✓ $PRESERVE_MCP_TOOLS_CONFIG backed up successfully"
        else
            log_error "FAILED to backup $PRESERVE_MCP_TOOLS_CONFIG - aborting!"
        fi
    else
        log_info "$PRESERVE_MCP_TOOLS_CONFIG not found - skipping backup"
    fi

    if [ -f "$MANAGED_DIR/$PRESERVE_MARKETPLACES" ]; then
        log_info "Backing up $PRESERVE_MARKETPLACES (marketplace configuration)..."
        cp "$MANAGED_DIR/$PRESERVE_MARKETPLACES" "$BACKUP_TEMP/"
        if [ -f "$BACKUP_TEMP/$PRESERVE_MARKETPLACES" ]; then
            log_success "✓ $PRESERVE_MARKETPLACES backed up successfully"
        else
            log_error "FAILED to backup $PRESERVE_MARKETPLACES - aborting!"
        fi
    else
        log_info "$PRESERVE_MARKETPLACES not found - skipping backup"
    fi

    if [ -d "$MANAGED_DIR/$PRESERVE_WORKSPACES" ]; then
        log_info "Backing up $PRESERVE_WORKSPACES directory (agent workspaces)..."
        cp -R "$MANAGED_DIR/$PRESERVE_WORKSPACES" "$BACKUP_TEMP/"
        if [ -d "$BACKUP_TEMP/$PRESERVE_WORKSPACES" ]; then
            WORKSPACES_COUNT=$(find "$BACKUP_TEMP/$PRESERVE_WORKSPACES" -type d -mindepth 1 -maxdepth 1 | wc -l)
            log_success "✓ $PRESERVE_WORKSPACES directory backed up successfully ($WORKSPACES_COUNT workspaces)"
        else
            log_error "FAILED to backup $PRESERVE_WORKSPACES - aborting!"
        fi
    else
        log_info "$PRESERVE_WORKSPACES directory not found - skipping backup"
    fi

    log_info "Selective backup directory contents:"
    ls -la "$BACKUP_TEMP"
    log_info "Note: Full app backup already created separately"

    # Explicit removal of large regenerable build artifacts (with logging and size reporting)
    log
    log_warning "================ REMOVING REGENERABLE BUILD ARTIFACTS ================"
    log_info "Removing large build artifacts that can be regenerated..."
    log_info "These are also excluded from backups to save space and time"

    # Remove electron-app/dist (large Electron build artifacts)
    if [ -d "$MANAGED_DIR/electron-app/dist" ]; then
        log_info "Checking electron-app/dist (Electron build artifacts)..."
        DIST_SIZE=$(du -sh "$MANAGED_DIR/electron-app/dist" 2>/dev/null | cut -f1 || echo "unknown")
        log_info "  Current size: $DIST_SIZE"

        if rm -rf "$MANAGED_DIR/electron-app/dist" 2>/dev/null; then
            log_success "✓ electron-app/dist removed successfully"
        else
            log_warning "⚠ Failed to remove electron-app/dist - may be in use or locked"
            log_info "  Will be cleaned by selective cleanup instead"
        fi
    else
        log_info "electron-app/dist not found - skipping"
    fi

    # Remove electron-app/node_modules (npm dependencies)
    if [ -d "$MANAGED_DIR/electron-app/node_modules" ]; then
        log_info "Checking electron-app/node_modules (npm dependencies)..."
        NODE_MODULES_SIZE=$(du -sh "$MANAGED_DIR/electron-app/node_modules" 2>/dev/null | cut -f1 || echo "unknown")
        log_info "  Current size: $NODE_MODULES_SIZE"

        if rm -rf "$MANAGED_DIR/electron-app/node_modules" 2>/dev/null; then
            log_success "✓ electron-app/node_modules removed successfully"
        else
            log_warning "⚠ Failed to remove electron-app/node_modules - may be in use or locked"
            log_info "  Will be cleaned by selective cleanup instead"
        fi
    else
        log_info "electron-app/node_modules not found - skipping"
    fi

    # Remove .venv directories (Python virtual environments)
    for venv_path in "$MANAGED_DIR/core-mcp/mcp-assistant/.venv" "$MANAGED_DIR/core-mcp/subagents/.venv"; do
        if [ -d "$venv_path" ]; then
            VENV_NAME=$(basename $(dirname "$venv_path"))"/.venv"
            log_info "Checking $venv_path (Python virtual environment)..."
            VENV_SIZE=$(du -sh "$venv_path" 2>/dev/null | cut -f1 || echo "unknown")
            log_info "  Current size: $VENV_SIZE"

            if rm -rf "$venv_path" 2>/dev/null; then
                log_success "✓ $VENV_NAME removed successfully"
            else
                log_warning "⚠ Failed to remove $VENV_NAME - may be in use or locked"
                log_info "  Will be cleaned by selective cleanup instead"
            fi
        fi
    done

    log_success "Build artifact cleanup completed"
    log_info "Note: Any remaining files will be cleaned by the selective cleanup below"

    # Always use selective cleanup to preserve directory structure and backup folder
    # This prevents "uv_cwd: ENOENT" error and protects backups from accidental deletion
    log_warning "🔄 SELECTIVE CLEANUP: Removing files while preserving directory structure and backups"
    log_info "Removing files but keeping directories and backup folder..."

    # Remove all files but keep directories and backup folder (OLD app's CWD stays valid)
    # Exclude backup folder to ensure existing backups are never touched
    find "$MANAGED_DIR" -type f ! -path "$MANAGED_DIR/backup/*" -delete 2>/dev/null || true

    log_success "Selective cleanup completed - directory structure and backups preserved"
fi

# Create/ensure managed directory exists
log_info "Ensuring managed directory exists: $MANAGED_DIR"
mkdir -p "$MANAGED_DIR"
if [ ! -d "$MANAGED_DIR" ]; then
    log_error "Failed to create managed directory: $MANAGED_DIR"
fi
log_success "Managed directory ready: $MANAGED_DIR"

# Step 3: Download the latest version
log
log "================ STEP 3: DOWNLOAD LATEST VERSION ================"
log_info "Downloading $FILENAME..."

# Create temporary directory for download
TEMP_DIR=$(mktemp -d)
DOWNLOAD_FILE="$TEMP_DIR/$FILENAME"
log_info "Temporary download location: $DOWNLOAD_FILE"

# Download with progress
if command -v curl &> /dev/null; then
    log_info "Using curl for download..."
    if run_download_with_redacted_output curl -L -f --progress-bar -o "$DOWNLOAD_FILE" "$DOWNLOAD_URL"; then
        log_success "Download completed successfully"
        log_info "Downloaded file size: $(ls -lh "$DOWNLOAD_FILE" | awk '{print $5}')"
    else
        rm -rf "$TEMP_DIR"
        log_error "Failed to download file from Cloudsmith"
    fi
elif command -v wget &> /dev/null; then
    log_info "Using wget for download..."
    if run_download_with_redacted_output wget --progress=bar:force -O "$DOWNLOAD_FILE" "$DOWNLOAD_URL"; then
        log_success "Download completed successfully"
        log_info "Downloaded file size: $(ls -lh "$DOWNLOAD_FILE" | awk '{print $5}')"
    else
        rm -rf "$TEMP_DIR"
        log_error "Failed to download file from Cloudsmith"
    fi
fi

# Verify download
if [ ! -f "$DOWNLOAD_FILE" ]; then
    rm -rf "$TEMP_DIR"
    log_error "Downloaded file not found: $DOWNLOAD_FILE"
fi

# Step 4: Extract to managed directory
log
log "================ STEP 4: EXTRACT AND INSTALL (FRESH) ================"
log_info "Extracting archive and installing fresh files..."
log_info "Note: Installing to clean directory after nuclear cleanup"

# Create temporary extraction directory
EXTRACT_TEMP="$TEMP_DIR/extract"
mkdir -p "$EXTRACT_TEMP"

# Extract the zip file
if command -v unzip &> /dev/null; then
    log_info "Extracting to temporary location..."
    if unzip -q "$DOWNLOAD_FILE" -d "$EXTRACT_TEMP"; then
        log_success "Archive extracted successfully"
        
        # Check for intermediate folder (like portico-main)
        EXTRACTED_ITEMS=$(ls -A "$EXTRACT_TEMP" | wc -l)
        FIRST_ITEM=$(ls -A "$EXTRACT_TEMP" | head -1)
        
        if [ "$EXTRACTED_ITEMS" -eq 1 ] && [ -d "$EXTRACT_TEMP/$FIRST_ITEM" ]; then
            log_info "Found intermediate folder: $FIRST_ITEM"
            log_info "Moving contents to managed directory..."
            
            # Count files being moved
            FILE_COUNT=$(find "$EXTRACT_TEMP/$FIRST_ITEM" -type f | wc -l)
            log_info "Installing $FILE_COUNT files..."
            
            # Extract files to fresh directory (nuclear approach - no preservation needed during extraction)
            log_info "Installing fresh files to managed directory..."
            if command -v rsync &> /dev/null; then
                if rsync -av "$EXTRACT_TEMP/$FIRST_ITEM/" "$MANAGED_DIR/"; then
                    log_success "Fresh files installed to $MANAGED_DIR"
                else
                    rm -rf "$TEMP_DIR"
                    log_error "Failed to install files"
                fi
            else
                # Fallback to cp if rsync not available
                if cp -R "$EXTRACT_TEMP/$FIRST_ITEM/"* "$MANAGED_DIR/" 2>/dev/null || \
                   cp -R "$EXTRACT_TEMP/$FIRST_ITEM/".[!.]* "$MANAGED_DIR/" 2>/dev/null; then
                    log_success "Fresh files installed to $MANAGED_DIR"
                else
                    # Some files were copied, which is expected if there are no hidden files
                    if [ "$(ls -A "$MANAGED_DIR")" ]; then
                        log_success "Fresh files installed to $MANAGED_DIR"
                    else
                        rm -rf "$TEMP_DIR"
                        log_error "Failed to install files"
                    fi
                fi
            fi
        else
            log_info "No intermediate folder found, copying directly..."
            FILE_COUNT=$(find "$EXTRACT_TEMP" -type f | wc -l)
            log_info "Installing $FILE_COUNT files..."
            
            # Extract files to fresh directory (nuclear approach - no preservation needed during extraction)
            log_info "Installing fresh files to managed directory..."
            if command -v rsync &> /dev/null; then
                if rsync -av "$EXTRACT_TEMP/" "$MANAGED_DIR/"; then
                    log_success "Fresh files installed to $MANAGED_DIR"
                else
                    rm -rf "$TEMP_DIR"
                    log_error "Failed to install files"
                fi
            else
                # Fallback to cp if rsync not available
                if cp -R "$EXTRACT_TEMP/"* "$MANAGED_DIR/" 2>/dev/null || \
                   cp -R "$EXTRACT_TEMP/".[!.]* "$MANAGED_DIR/" 2>/dev/null; then
                    log_success "Fresh files installed to $MANAGED_DIR"
                else
                    # Some files were copied, which is expected if there are no hidden files
                    if [ "$(ls -A "$MANAGED_DIR")" ]; then
                        log_success "Fresh files installed to $MANAGED_DIR"
                    else
                        rm -rf "$TEMP_DIR"
                        log_error "Failed to install files"
                    fi
                fi
            fi
        fi
        
        # Step 4.5: Restore preserved files after nuclear cleanup
        if [ -n "$BACKUP_TEMP" ] && [ -d "$BACKUP_TEMP" ]; then
            log
            log_warning "================ RESTORING PRESERVED FILES ================"
            log_info "Restoring from backup: $BACKUP_TEMP"
            log_info "Backup contents:"
            ls -la "$BACKUP_TEMP"
            
            # Restore .env file
            if [ -f "$BACKUP_TEMP/$PRESERVE_ENV" ]; then
                log_info "Restoring $PRESERVE_ENV..."
                cp "$BACKUP_TEMP/$PRESERVE_ENV" "$MANAGED_DIR/"
                if [ -f "$MANAGED_DIR/$PRESERVE_ENV" ]; then
                    log_success "✓ $PRESERVE_ENV restored ($(wc -l < "$MANAGED_DIR/$PRESERVE_ENV") lines)"
                else
                    log_error "FAILED to restore $PRESERVE_ENV!"
                fi
            fi

            if [ -f "$BACKUP_TEMP/$PRESERVE_RUNTIME_ENV" ]; then
                log_info "Restoring $PRESERVE_RUNTIME_ENV..."
                cp "$BACKUP_TEMP/$PRESERVE_RUNTIME_ENV" "$MANAGED_DIR/"
                if [ -f "$MANAGED_DIR/$PRESERVE_RUNTIME_ENV" ]; then
                    log_success "✓ $PRESERVE_RUNTIME_ENV restored ($(wc -l < "$MANAGED_DIR/$PRESERVE_RUNTIME_ENV") lines)"
                else
                    log_error "FAILED to restore $PRESERVE_RUNTIME_ENV!"
                fi
            fi
            
            # Restore open-webui-data directory
            if [ -d "$BACKUP_TEMP/$PRESERVE_DATA" ]; then
                log_info "Restoring $PRESERVE_DATA directory..."
                cp -R "$BACKUP_TEMP/$PRESERVE_DATA" "$MANAGED_DIR/"
                if [ -d "$MANAGED_DIR/$PRESERVE_DATA" ]; then
                    log_success "✓ $PRESERVE_DATA directory restored"
                else
                    log_error "FAILED to restore $PRESERVE_DATA directory!"
                fi
            fi
            
            # Restore mcp-configs-user directory (user-installed MCP servers)
            if [ -d "$BACKUP_TEMP/$PRESERVE_USER_MCP" ]; then
                log_info "Restoring $PRESERVE_USER_MCP directory (user-installed MCP servers)..."
                cp -R "$BACKUP_TEMP/$PRESERVE_USER_MCP" "$MANAGED_DIR/"
                if [ -d "$MANAGED_DIR/$PRESERVE_USER_MCP" ]; then
                    log_success "✓ $PRESERVE_USER_MCP directory restored"
                else
                    log_error "FAILED to restore $PRESERVE_USER_MCP directory!"
                fi
            fi

            # Ensure backup directory exists for the full backup zip archive
            # Note: We don't restore the backup directory since it's never deleted by selective cleanup
            log_info "Ensuring backup directory exists for backup archive..."
            mkdir -p "$MANAGED_DIR/backup"

            # Place the FULL backup zip archive in the backup directory
            if [ -f "$FULL_BACKUP_ZIP_PATH" ]; then
                log_info "Placing FULL app backup archive in backup directory..."
                cp "$FULL_BACKUP_ZIP_PATH" "$MANAGED_DIR/backup/"
                if [ -f "$MANAGED_DIR/backup/$FULL_BACKUP_ZIP_NAME" ]; then
                    log_success "✓ Full app backup archive saved: backup/$FULL_BACKUP_ZIP_NAME"
                    log_info "  This archive contains a COMPLETE snapshot of your entire app folder from before the update"
                else
                    log_warning "Failed to save full backup archive to backup directory"
                fi
            else
                log_warning "Full backup zip not found - skipping archive placement"
            fi

            # Restore OAuth tokens directory
            if [ -d "$BACKUP_TEMP/$PRESERVE_OAUTH_TOKENS" ]; then
                log_info "Restoring $PRESERVE_OAUTH_TOKENS directory (OAuth tokens)..."
                cp -R "$BACKUP_TEMP/$PRESERVE_OAUTH_TOKENS" "$MANAGED_DIR/"
                if [ -d "$MANAGED_DIR/$PRESERVE_OAUTH_TOKENS" ]; then
                    RESTORED_OAUTH_COUNT=$(find "$MANAGED_DIR/$PRESERVE_OAUTH_TOKENS" -type f -name "*.json" | wc -l)
                    log_success "✓ $PRESERVE_OAUTH_TOKENS directory restored ($RESTORED_OAUTH_COUNT token files)"
                else
                    log_error "FAILED to restore $PRESERVE_OAUTH_TOKENS directory!"
                fi
            fi

            # Restore OAuth tokens directory for mcpo-core
            if [ -d "$BACKUP_TEMP/$PRESERVE_OAUTH_TOKENS_CORE" ]; then
                log_info "Restoring $PRESERVE_OAUTH_TOKENS_CORE directory (OAuth tokens for mcpo-core)..."
                cp -R "$BACKUP_TEMP/$PRESERVE_OAUTH_TOKENS_CORE" "$MANAGED_DIR/"
                if [ -d "$MANAGED_DIR/$PRESERVE_OAUTH_TOKENS_CORE" ]; then
                    RESTORED_OAUTH_CORE_COUNT=$(find "$MANAGED_DIR/$PRESERVE_OAUTH_TOKENS_CORE" -type f -name "*.json" | wc -l)
                    log_success "✓ $PRESERVE_OAUTH_TOKENS_CORE directory restored ($RESTORED_OAUTH_CORE_COUNT token files)"
                else
                    log_error "FAILED to restore $PRESERVE_OAUTH_TOKENS_CORE directory!"
                fi
            fi

            # Restore UPDATE_CHANNEL file
            if [ -f "$BACKUP_TEMP/$PRESERVE_UPDATE_CHANNEL" ]; then
                log_info "Restoring $PRESERVE_UPDATE_CHANNEL (update channel configuration)..."
                cp "$BACKUP_TEMP/$PRESERVE_UPDATE_CHANNEL" "$MANAGED_DIR/"
                if [ -f "$MANAGED_DIR/$PRESERVE_UPDATE_CHANNEL" ]; then
                    RESTORED_CHANNEL=$(cat "$MANAGED_DIR/$PRESERVE_UPDATE_CHANNEL" | tr -d '[:space:]')
                    log_success "✓ $PRESERVE_UPDATE_CHANNEL restored (channel: $RESTORED_CHANNEL)"
                else
                    log_error "FAILED to restore $PRESERVE_UPDATE_CHANNEL!"
                fi
            fi

            # Restore artifact-snapshots directory
            if [ -d "$BACKUP_TEMP/$PRESERVE_ARTIFACT_SNAPSHOTS" ]; then
                log_info "Restoring $PRESERVE_ARTIFACT_SNAPSHOTS directory (artifact version snapshots)..."
                cp -R "$BACKUP_TEMP/$PRESERVE_ARTIFACT_SNAPSHOTS" "$MANAGED_DIR/"
                if [ -d "$MANAGED_DIR/$PRESERVE_ARTIFACT_SNAPSHOTS" ]; then
                    RESTORED_ARTIFACT_COUNT=$(find "$MANAGED_DIR/$PRESERVE_ARTIFACT_SNAPSHOTS" -type d -mindepth 1 -maxdepth 1 | wc -l)
                    log_success "✓ $PRESERVE_ARTIFACT_SNAPSHOTS directory restored ($RESTORED_ARTIFACT_COUNT artifacts)"
                else
                    log_error "FAILED to restore $PRESERVE_ARTIFACT_SNAPSHOTS directory!"
                fi
            fi

            # Restore skills-marketplace directory
            if [ -d "$BACKUP_TEMP/$PRESERVE_SKILLS_MARKETPLACE" ]; then
                log_info "Restoring $PRESERVE_SKILLS_MARKETPLACE directory (marketplace skills)..."
                cp -R "$BACKUP_TEMP/$PRESERVE_SKILLS_MARKETPLACE" "$MANAGED_DIR/"
                if [ -d "$MANAGED_DIR/$PRESERVE_SKILLS_MARKETPLACE" ]; then
                    log_success "✓ $PRESERVE_SKILLS_MARKETPLACE directory restored"
                else
                    log_error "FAILED to restore $PRESERVE_SKILLS_MARKETPLACE directory!"
                fi
            fi

            # Restore skills-user directory
            if [ -d "$BACKUP_TEMP/$PRESERVE_SKILLS_USER" ]; then
                log_info "Restoring $PRESERVE_SKILLS_USER directory (user-created skills)..."
                cp -R "$BACKUP_TEMP/$PRESERVE_SKILLS_USER" "$MANAGED_DIR/"
                if [ -d "$MANAGED_DIR/$PRESERVE_SKILLS_USER" ]; then
                    RESTORED_USER_SKILLS_COUNT=$(find "$MANAGED_DIR/$PRESERVE_SKILLS_USER" -type d -mindepth 1 -maxdepth 1 | wc -l)
                    log_success "✓ $PRESERVE_SKILLS_USER directory restored ($RESTORED_USER_SKILLS_COUNT skills)"
                else
                    log_error "FAILED to restore $PRESERVE_SKILLS_USER directory!"
                fi
            fi

            # Restore mcp_toggles.json
            if [ -f "$BACKUP_TEMP/$PRESERVE_MCP_TOGGLES" ]; then
                log_info "Restoring $PRESERVE_MCP_TOGGLES (MCP server toggles)..."
                cp "$BACKUP_TEMP/$PRESERVE_MCP_TOGGLES" "$MANAGED_DIR/"
                if [ -f "$MANAGED_DIR/$PRESERVE_MCP_TOGGLES" ]; then
                    log_success "✓ $PRESERVE_MCP_TOGGLES restored"
                else
                    log_error "FAILED to restore $PRESERVE_MCP_TOGGLES!"
                fi
            fi

            # Restore mcp_disable_modes.json
            if [ -f "$BACKUP_TEMP/$PRESERVE_MCP_DISABLE_MODES" ]; then
                log_info "Restoring $PRESERVE_MCP_DISABLE_MODES (MCP disable modes)..."
                cp "$BACKUP_TEMP/$PRESERVE_MCP_DISABLE_MODES" "$MANAGED_DIR/"
                if [ -f "$MANAGED_DIR/$PRESERVE_MCP_DISABLE_MODES" ]; then
                    log_success "✓ $PRESERVE_MCP_DISABLE_MODES restored"
                else
                    log_error "FAILED to restore $PRESERVE_MCP_DISABLE_MODES!"
                fi
            fi

            # Restore mcp_tools_config.json
            if [ -f "$BACKUP_TEMP/$PRESERVE_MCP_TOOLS_CONFIG" ]; then
                log_info "Restoring $PRESERVE_MCP_TOOLS_CONFIG (MCP tools configuration)..."
                cp "$BACKUP_TEMP/$PRESERVE_MCP_TOOLS_CONFIG" "$MANAGED_DIR/"
                if [ -f "$MANAGED_DIR/$PRESERVE_MCP_TOOLS_CONFIG" ]; then
                    log_success "✓ $PRESERVE_MCP_TOOLS_CONFIG restored"
                else
                    log_error "FAILED to restore $PRESERVE_MCP_TOOLS_CONFIG!"
                fi
            fi

            # Restore marketplaces.json
            if [ -f "$BACKUP_TEMP/$PRESERVE_MARKETPLACES" ]; then
                log_info "Restoring $PRESERVE_MARKETPLACES (marketplace configuration)..."
                cp "$BACKUP_TEMP/$PRESERVE_MARKETPLACES" "$MANAGED_DIR/"
                if [ -f "$MANAGED_DIR/$PRESERVE_MARKETPLACES" ]; then
                    log_success "✓ $PRESERVE_MARKETPLACES restored"
                else
                    log_error "FAILED to restore $PRESERVE_MARKETPLACES!"
                fi
            fi

            # Restore workspaces directory
            if [ -d "$BACKUP_TEMP/$PRESERVE_WORKSPACES" ]; then
                log_info "Restoring $PRESERVE_WORKSPACES directory (agent workspaces)..."
                cp -R "$BACKUP_TEMP/$PRESERVE_WORKSPACES" "$MANAGED_DIR/"
                if [ -d "$MANAGED_DIR/$PRESERVE_WORKSPACES" ]; then
                    RESTORED_WORKSPACES_COUNT=$(find "$MANAGED_DIR/$PRESERVE_WORKSPACES" -type d -mindepth 1 -maxdepth 1 | wc -l)
                    log_success "✓ $PRESERVE_WORKSPACES directory restored ($RESTORED_WORKSPACES_COUNT workspaces)"
                else
                    log_error "FAILED to restore $PRESERVE_WORKSPACES directory!"
                fi
            fi

            # Clean up backup directories
            log_info "Cleaning up temporary backup directories..."
            rm -rf "$BACKUP_TEMP"
            rm -rf "$FULL_BACKUP_TEMP"

            log_success "🎉 Selective cleanup restoration completed - your files are preserved!"
            if [ -f "$MANAGED_DIR/backup/$FULL_BACKUP_ZIP_NAME" ]; then
                FINAL_BACKUP_SIZE=$(ls -lh "$MANAGED_DIR/backup/$FULL_BACKUP_ZIP_NAME" | awk '{print $5}')
                log_info "📦 Full app backup archive created: backup/$FULL_BACKUP_ZIP_NAME"
                log_info "   Size: $FINAL_BACKUP_SIZE"
                log_info "   This archive contains a snapshot of your app folder from before the update"
                log_info "   Note: Excludes electron-app/node_modules, electron-app/dist, .venv directories, and old backups to save space"
            fi
            log_info "Final managed directory contents:"
            ls -la "$MANAGED_DIR"
        else
            log_info "No backup to restore (fresh installation)"
        fi
    else
        rm -rf "$TEMP_DIR"
        log_error "Failed to extract archive"
    fi
else
    rm -rf "$TEMP_DIR"
    log_error "unzip command not available. Please install unzip."
fi

# Clean up temporary files
log_info "Cleaning up temporary files..."
rm -rf "$TEMP_DIR"
log_success "Cleanup completed"

# ================ STEP 4.6: MIGRATION CLEANUP ================
# Handle migration from guided-setup/ to electron-app/
# Stale app bundles under guided-setup/dist can be launched by Dock/Spotlight
# shortcuts, so remove the legacy tree once a new electron-app tree is present.

if [ -d "$MANAGED_DIR/guided-setup" ] && [ -d "$MANAGED_DIR/electron-app" ]; then
    log
    log_warning "================ MIGRATION CLEANUP: removing guided-setup ================"
    log_info "Detected legacy guided-setup folder alongside electron-app; removing stale app bundles"

    if rm -rf "$MANAGED_DIR/guided-setup" 2>/dev/null; then
        log_success "Legacy guided-setup folder removed"
    else
        log_warning "Failed to remove legacy guided-setup folder; startup cleanup will retry"
    fi
fi

# Step 5: Create build-info.json
log
log "================ STEP 5: CREATE BUILD INFO ================"
log_info "Creating build-info.json..."

# Detect which folder structure was extracted (backwards compatibility)
# New builds have electron-app/, old builds have guided-setup/
if [ -d "$MANAGED_DIR/electron-app" ]; then
    BUILD_INFO_DIR="$MANAGED_DIR/electron-app"
    log_info "Detected new build structure (electron-app/)"
elif [ -d "$MANAGED_DIR/guided-setup" ]; then
    BUILD_INFO_DIR="$MANAGED_DIR/guided-setup"
    log_info "Detected old build structure (guided-setup/)"
else
    # Fallback - create electron-app for consistency
    BUILD_INFO_DIR="$MANAGED_DIR/electron-app"
    log_warning "No app folder detected, defaulting to electron-app/"
fi
mkdir -p "$BUILD_INFO_DIR"

cat > "$BUILD_INFO_DIR/build-info.json" <<EOF
{
  "buildNumber": "${BUILD_NUMBER}",
  "fullSha": "${BUILD_SHA}",
  "date": "${BUILD_DATE}",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)",
  "channel": "${KEYWORD}"
}
EOF

if [ -f "$BUILD_INFO_DIR/build-info.json" ]; then
    log_success "Created build-info.json"
    log_info "Build Number: $BUILD_NUMBER"
    log_info "Build SHA: $BUILD_SHA"
    log_info "Build Date: $BUILD_DATE"
    log_info "Build Channel: $KEYWORD"
else
    log_warning "Failed to create build-info.json"
fi

# Step 6: Run install script
log
log "================ STEP 6: RUN INSTALLATION ================"
log_info "Changing to managed directory: $MANAGED_DIR"
cd "$MANAGED_DIR"

# Export Node.js minimum runtime requirement used for HOST-mode tooling checks.
export NODE_VERSION_REQUIRED="${NODE_VERSION_REQUIRED:-20.19.0}"
log_info "Using Node.js minimum version for HOST tooling: >= v${NODE_VERSION_REQUIRED}"

# Check for install_v2.sh script
if [ -f "install_v2.sh" ]; then
    log_info "Found install_v2.sh, running installation..."
    echo
    echo "----------------------------------------"
    echo "Running install_v2.sh..."
    echo "----------------------------------------"
    echo

    # Prepare install script arguments
    INSTALL_ARGS=()
    if [ -n "$OUTPUT_DIR" ]; then
        INSTALL_ARGS+=("--output-dir" "$OUTPUT_DIR")
        log_info "Passing custom output directory to install_v2.sh: $OUTPUT_DIR"
    fi

    # Run the install script
    if bash install_v2.sh "${INSTALL_ARGS[@]}"; then
        log_success "Installation completed successfully!"
        if [ -n "$BUILD_LAST_MODIFIED" ]; then
            LAST_INSTALLED_BUILD_FILE="$HOME/Library/Application Support/portico/LAST_INSTALLED_BUILD"
            LAST_INSTALLED_BUILD_TEMP="${LAST_INSTALLED_BUILD_FILE}.$$"
            mkdir -p "$(dirname "$LAST_INSTALLED_BUILD_FILE")"
            if printf '{\n  "schemaVersion": 1,\n  "buildNumber": "%s",\n  "timestamp": "%s"\n}\n' \
                "$BUILD_NUMBER" "$BUILD_LAST_MODIFIED" > "$LAST_INSTALLED_BUILD_TEMP" \
                && mv -f "$LAST_INSTALLED_BUILD_TEMP" "$LAST_INSTALLED_BUILD_FILE"; then
                log_success "Updated LAST_INSTALLED_BUILD state for $BUILD_NUMBER"
            else
                rm -f "$LAST_INSTALLED_BUILD_TEMP"
                log_warning "Failed to update LAST_INSTALLED_BUILD state"
            fi
        fi
    else
        log_error "Installation failed. Please check the errors above."
    fi
else
    log_error "install_v2.sh not found in $MANAGED_DIR"
    log_info "Contents of managed directory:"
    ls -la "$MANAGED_DIR" | head -20
    exit 1
fi

echo
echo "========================================"
echo "Bootstrap completed: $(date)"
echo "Installation directory: $MANAGED_DIR"
echo "Build version: $BUILD_NUMBER"
if [ -n "$BUILD_OVERRIDE" ]; then
    echo "Build source: Override (user-specified)"
else
    echo "Build source: Latest from Cloudsmith"
fi
echo "========================================"
echo
log_success "Portico has been bootstrapped successfully!"
log_info "You can now run the application from: $MANAGED_DIR"
if [ -n "$BUILD_OVERRIDE" ]; then
    log_warning "Note: You installed a specific build ($BUILD_NUMBER) instead of the latest version"
fi

exit 0
