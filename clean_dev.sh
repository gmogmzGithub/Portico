#!/bin/bash

# Development Environment Cleanup Script
# Resets Portico to a clean state by removing generated configuration files.
# The repository .env is protected release-operator input and is never removed.
# This is useful for testing fresh installations or troubleshooting
#
# Usage:
#   ./clean_dev.sh                         # interactive clean, including Keychain
#   ./clean_dev.sh --yes                   # skip confirmation
#   ./clean_dev.sh --yes --keep-keychain   # clean disk state, preserve Keychain residue

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Parse arguments
AUTO_YES=false
KEEP_KEYCHAIN=false
for arg in "$@"; do
    case "$arg" in
        --yes|-y) AUTO_YES=true ;;
        --keep-keychain) KEEP_KEYCHAIN=true ;;
    esac
done

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

KEYCHAIN_CLEANUP_HELPER="$SCRIPT_DIR/src/scripts/cleanup-portico-keychain.sh"
if [ ! -f "$KEYCHAIN_CLEANUP_HELPER" ]; then
    echo -e "${RED}❌ Missing Keychain cleanup helper: $KEYCHAIN_CLEANUP_HELPER${NC}" >&2
    exit 1
fi
# shellcheck source=src/scripts/cleanup-portico-keychain.sh
source "$KEYCHAIN_CLEANUP_HELPER"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Portico - Development Cleanup${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

if [ "$KEEP_KEYCHAIN" = true ]; then
    echo -e "${YELLOW}⚠️  Keychain entries and OAuth certificates will be deliberately preserved.${NC}"
    echo -e "${YELLOW}   Disk state will still be removed to simulate dirty Keychain residue.${NC}"
    echo ""
fi

if [ "$AUTO_YES" = false ]; then
    echo -e "${YELLOW}⚠️  WARNING: This will remove:${NC}"
    echo "  - Generated configuration files (mcp_config_*.json, mcp_toggles.json, HOST_MODE, MCPO_HOST.pid)"
    echo "  - Repository .env is protected and will be preserved"
    echo "  - All user-installed MCP servers (mcp-configs-user/*)"
    echo "  - All OAuth tokens (mcpo-core-oauth-tokens/*, mcpo-oauth-tokens/*)"
    echo "  - Encrypted OAuth records, migration status, and stored setup state"
    echo "  - Single-server OAuth certificate caches"
    if [ "$KEEP_KEYCHAIN" = false ]; then
        echo "  - All PORTICO-owned macOS Keychain passwords, safeStorage keys, and localhost OAuth certificates"
    fi
    echo ""
    echo -e "${YELLOW}This action cannot be undone!${NC}"
    echo ""
    read -p "Continue? (yes/no): " -r
    echo ""

    if [[ ! $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
        echo -e "${RED}❌ Cleanup cancelled${NC}"
        exit 0
    fi
fi

echo -e "${GREEN}🧹 Starting cleanup...${NC}"
echo ""

# Remove app-owned Keychain state before deleting certificate caches. Full
# cleanup invokes this script after its own Keychain pass and sets the private
# guard below so the destructive operation runs exactly once.
echo -e "${BLUE}Cleaning macOS Keychain state...${NC}"
if [ "${portico_KEYCHAIN_CLEANUP_ALREADY_DONE:-0}" = "1" ]; then
    echo -e "  ${YELLOW}⏭${NC}  Keychain cleanup already completed by parent cleanup"
elif [ "$KEEP_KEYCHAIN" = true ]; then
    echo -e "  ${YELLOW}⏭${NC}  Preserving PORTICO Keychain entries and localhost OAuth certificates (--keep-keychain)"
else
    portico_cleanup_legacy_oauth_certificates false "$SCRIPT_DIR"
    portico_cleanup_generic_passwords false
fi

# --keep-keychain intentionally preserves only Keychain state. Cached files
# remain part of the normal disk cleanup in every mode.
portico_remove_single_server_ssl_caches false "$SCRIPT_DIR"
echo ""

# Remove configuration files
echo -e "${BLUE}Removing configuration files...${NC}"

FILES_TO_REMOVE=(
    "HOST_MODE"
    "mcp_config_advanced.json"
    "mcp_config_core.json"
    "mcp_config_host_sideload.json"
    "mcp_toggles.json"
    "MCPO_HOST.pid"
)

if [ -f ".env" ]; then
    chmod 600 ".env" 2>/dev/null || true
    echo -e "  ${GREEN}✓${NC} Preserved protected release-operator input: .env"
fi

for file in "${FILES_TO_REMOVE[@]}"; do
    if [ -f "$file" ]; then
        rm -f "$file"
        echo -e "  ${GREEN}✓${NC} Removed: $file"
    else
        echo -e "  ${YELLOW}⏭${NC}  Not found: $file"
    fi
done

echo ""

# Remove stored setup and encrypted OAuth state from every supported Electron
# userData location. Removing safeStorage keys without removing these blobs
# would leave undecryptable records rather than a genuinely clean install.
echo -e "${BLUE}Removing stored setup and OAuth state...${NC}"

ELECTRON_USER_DATA_DIRS=(
    "$HOME/Library/Application Support/portico"
    "$HOME/Library/Application Support/Portico"
    "${XDG_CONFIG_HOME:-$HOME/.config}/portico"
    "${XDG_CONFIG_HOME:-$HOME/.config}/Portico"
)

FOUND_USER_DATA_STATE=false
for user_data_dir in "${ELECTRON_USER_DATA_DIRS[@]}"; do
    for state_path in \
        "$user_data_dir/setup-auth-session.bin" \
        "$user_data_dir/guided-setup-preferences.json" \
        "$user_data_dir/mcp-oauth-migration-status.json"; do
        if [ -f "$state_path" ]; then
            rm -f "$state_path"
            echo -e "  ${GREEN}✓${NC} Removed: $state_path"
            FOUND_USER_DATA_STATE=true
        fi
    done

    if [ -d "$user_data_dir/mcp-oauth-records" ]; then
        rm -rf "$user_data_dir/mcp-oauth-records"
        echo -e "  ${GREEN}✓${NC} Removed: $user_data_dir/mcp-oauth-records"
        FOUND_USER_DATA_STATE=true
    fi
done

if [ "$FOUND_USER_DATA_STATE" = false ]; then
    echo -e "  ${YELLOW}⏭${NC}  No stored setup or encrypted OAuth state found"
fi

echo ""

# Remove subdirectories in mcp-configs-user/
echo -e "${BLUE}Removing user-installed MCP servers...${NC}"

if [ -d "mcp-configs-user" ]; then
    # Count subdirectories before removal
    USER_SERVER_COUNT=$(find mcp-configs-user -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')

    if [ "$USER_SERVER_COUNT" -gt 0 ]; then
        # Remove all subdirectories but keep the parent directory
        find mcp-configs-user -mindepth 1 -maxdepth 1 -type d -exec rm -rf {} +
        echo -e "  ${GREEN}✓${NC} Removed $USER_SERVER_COUNT user-installed MCP server(s)"
    else
        echo -e "  ${YELLOW}⏭${NC}  No user-installed MCP servers found"
    fi
else
    echo -e "  ${YELLOW}⏭${NC}  Directory not found: mcp-configs-user/"
fi

echo ""

# Remove subdirectories in mcpo-core-oauth-tokens/
echo -e "${BLUE}Removing Core MCPO OAuth tokens...${NC}"

if [ -d "mcpo-core-oauth-tokens" ]; then
    # Count subdirectories before removal
    CORE_TOKEN_COUNT=$(find mcpo-core-oauth-tokens -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')

    if [ "$CORE_TOKEN_COUNT" -gt 0 ]; then
        find mcpo-core-oauth-tokens -mindepth 1 -maxdepth 1 -type d -exec rm -rf {} +
        echo -e "  ${GREEN}✓${NC} Removed $CORE_TOKEN_COUNT OAuth token folder(s)"
    else
        echo -e "  ${YELLOW}⏭${NC}  No OAuth tokens found"
    fi
else
    echo -e "  ${YELLOW}⏭${NC}  Directory not found: mcpo-core-oauth-tokens/"
fi

echo ""

# Remove subdirectories in mcpo-oauth-tokens/
echo -e "${BLUE}Removing regular MCPO OAuth tokens...${NC}"

if [ -d "mcpo-oauth-tokens" ]; then
    # Count subdirectories before removal
    OAUTH_TOKEN_COUNT=$(find mcpo-oauth-tokens -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')

    if [ "$OAUTH_TOKEN_COUNT" -gt 0 ]; then
        find mcpo-oauth-tokens -mindepth 1 -maxdepth 1 -type d -exec rm -rf {} +
        echo -e "  ${GREEN}✓${NC} Removed $OAUTH_TOKEN_COUNT OAuth token folder(s)"
    else
        echo -e "  ${YELLOW}⏭${NC}  No OAuth tokens found"
    fi
else
    echo -e "  ${YELLOW}⏭${NC}  Directory not found: mcpo-oauth-tokens/"
fi

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}✅ Cleanup Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
if [ "$KEEP_KEYCHAIN" = true ]; then
    echo "Disk state has been reset; PORTICO Keychain residue was deliberately preserved."
else
    echo "Your environment has been reset to a clean state, including PORTICO Keychain state."
fi
echo "You can now run the app to go through first-time setup."
echo ""
echo "Note: Docker containers and volumes were NOT removed."
echo "To also clean Docker, run: docker-compose down -v"
echo ""
