#!/bin/bash

# Migration script to add user_installed: false to all system-delivered YAML files
# This is a one-time migration script for the User-Installed MCP Servers feature

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
# Script now lives in src/scripts - project root is two levels up
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Change to project root
cd "$PROJECT_ROOT"

MCP_CONFIGS_DIR="mcp-configs"

echo -e "${BLUE}═══════════════════════════════════════${NC}"
echo -e "${BLUE}  Adding user_installed Flag${NC}"
echo -e "${BLUE}  to System-Delivered YAML Files${NC}"
echo -e "${BLUE}═══════════════════════════════════════${NC}"
echo ""

updated_count=0
skipped_count=0

# Process each YAML file in mcp-configs
for yaml_file in "$MCP_CONFIGS_DIR"/*/*.yaml; do
    if [ -f "$yaml_file" ]; then
        server_name=$(basename "$yaml_file" .yaml)

        # Check if user_installed flag already exists
        if grep -q "^user_installed:" "$yaml_file"; then
            echo -e "${YELLOW}  ⏭ Skipping $server_name (already has user_installed flag)${NC}"
            skipped_count=$((skipped_count + 1))
            continue
        fi

        # Find the best place to insert user_installed: false
        # Priority: after is_core, or after experimental, or after deployment_type

        if grep -q "^is_core:" "$yaml_file"; then
            # Insert after is_core line
            awk '/^is_core:/ {print; print "user_installed: false"; next} 1' "$yaml_file" > "$yaml_file.tmp" && mv "$yaml_file.tmp" "$yaml_file"
        elif grep -q "^experimental:" "$yaml_file"; then
            # Insert after experimental line
            awk '/^experimental:/ {print; print "user_installed: false"; next} 1' "$yaml_file" > "$yaml_file.tmp" && mv "$yaml_file.tmp" "$yaml_file"
        elif grep -q "^deployment_type:" "$yaml_file"; then
            # Insert after deployment_type line
            awk '/^deployment_type:/ {print; print "user_installed: false"; next} 1' "$yaml_file" > "$yaml_file.tmp" && mv "$yaml_file.tmp" "$yaml_file"
        else
            # Insert after name line as fallback
            awk '/^name:/ {print; print "user_installed: false"; next} 1' "$yaml_file" > "$yaml_file.tmp" && mv "$yaml_file.tmp" "$yaml_file"
        fi

        echo -e "${GREEN}  ✓ Updated $server_name${NC}"
        updated_count=$((updated_count + 1))
    fi
done

echo ""
echo -e "${BLUE}═══════════════════════════════════════${NC}"
echo -e "${BLUE}  Migration Summary${NC}"
echo -e "${BLUE}═══════════════════════════════════════${NC}"
echo -e "${GREEN}  Updated files: $updated_count${NC}"
echo -e "${YELLOW}  Skipped files: $skipped_count${NC}"
echo -e "${BLUE}═══════════════════════════════════════${NC}"
echo ""

if [ $updated_count -gt 0 ]; then
    echo -e "${GREEN}✓ Migration completed successfully!${NC}"
    echo ""
    echo "Next steps:"
    echo "  1. Review the changes: git diff mcp-configs/"
    echo "  2. Test config generation: bash src/scripts/mcp-orc-cli.sh generate-mcp-config"
    echo "  3. Commit the changes: git add mcp-configs/ && git commit -m 'Add user_installed flag to system YAML files'"
else
    echo -e "${YELLOW}No files needed updating.${NC}"
fi
