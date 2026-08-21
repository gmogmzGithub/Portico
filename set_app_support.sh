#!/usr/bin/env bash

# Set App Support Configuration
# Updates the project-config.json to point to either dev or managed directory
#
# Usage: ./set_app_support.sh --dev      # Points to current working directory
#        ./set_app_support.sh --managed  # Points to ~/portico/portico-managed

set -eo pipefail

CONFIG_DIR="$HOME/Library/Application Support/portico"
CONFIG_FILE="$CONFIG_DIR/project-config.json"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

show_usage() {
    echo "Usage: $0 <--dev|--managed>"
    echo ""
    echo "Options:"
    echo "  --dev      Set projectRoot to current working directory (for development)"
    echo "  --managed  Set projectRoot to ~/portico/portico-managed (for production)"
}

if [ -z "$1" ]; then
    echo -e "${RED}Error: Missing required argument${NC}"
    show_usage
    exit 1
fi

case "$1" in
    --dev)
        PROJECT_ROOT="$(pwd)"
        MODE="dev"
        ;;
    --managed)
        PROJECT_ROOT="$HOME/portico/portico-managed"
        MODE="managed"
        ;;
    -h|--help)
        show_usage
        exit 0
        ;;
    *)
        echo -e "${RED}Error: Unknown option: $1${NC}"
        show_usage
        exit 1
        ;;
esac

# Ensure config directory exists
mkdir -p "$CONFIG_DIR"

# Generate timestamp
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

# Write config file
cat > "$CONFIG_FILE" <<EOF
{
  "projectRoot": "$PROJECT_ROOT",
  "savedAt": "$TIMESTAMP"
}
EOF

echo -e "${GREEN}Updated project-config.json${NC}"
echo -e "  Mode: ${YELLOW}$MODE${NC}"
echo -e "  projectRoot: ${YELLOW}$PROJECT_ROOT${NC}"
echo -e "  savedAt: $TIMESTAMP"
