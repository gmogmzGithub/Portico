#!/bin/bash

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Simple section separator
print_separator() {
    local color="${1:-$BLUE}"
    echo -e "${color}--------------------------------------------------------------------------------${NC}"
}

# Function to print a section header
print_section() {
    local color="${1:-$BLUE}"
    local title="$2"
    echo
    print_separator "$color"
    echo -e "${color}${BOLD}  $title${NC}"
    print_separator "$color"
    echo
}

# Function to print an indented message block
print_message_block() {
    local indent="    "
    local lines=("$@")
    
    for line in "${lines[@]}"; do
        echo -e "${indent}$line"
    done
}

# Function to print timestamped log messages
log() {
    echo -e "${BLUE}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} $1"
}

# Function to print error messages
error() {
    echo -e "${RED}[$(date '+%Y-%m-%d %H:%M:%S')] ❌ $1${NC}"
}

# Function to print success messages
success() {
    echo -e "${GREEN}[$(date '+%Y-%m-%d %H:%M:%S')] ✅ $1${NC}"
}

# Function to print warning messages
warning() {
    echo -e "${YELLOW}[$(date '+%Y-%m-%d %H:%M:%S')] ⚠️  $1${NC}"
}

# Function to show help
show_help() {
    print_section "$GREEN" "🔄 Portico Update Script"
    
    print_message_block \
        "${BOLD}Purpose:${NC} Updates Open WebUI to the latest version" \
        "" \
        "${BOLD}Usage:${NC} $0 [--help]" \
        "" \
        "${BOLD}What this does:${NC}" \
        "• Checks Docker Hub for the latest Open WebUI image" \
        "• Downloads and updates the container if a new version is available" \
        "• Preserves all your data and settings" \
        "• Automatically restarts the container with the new version" \
        "" \
        "${BOLD}Note:${NC} This only updates Open WebUI, not other components"
}

# Parse command line arguments
for arg in "$@"; do
    case $arg in
        --help|-h)
            show_help
            exit 0
            ;;
        *)
            error "Unknown argument: $arg"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Function to check if Open WebUI is running
check_container_status() {
    if docker ps --format "{{.Names}}" | grep -q "^portico-open-webui$"; then
        return 0
    else
        return 1
    fi
}

# Function to get current image version
get_current_version() {
    local version=$(docker inspect portico-open-webui --format='{{.Config.Image}}' 2>/dev/null)
    echo "$version"
}

# Main function
main() {
    print_section "$GREEN" "🔄 Portico Update Script"
    
    # Check if Docker is running
    if ! docker info >/dev/null 2>&1; then
        error "Docker is not running! Please start Docker first."
        exit 1
    fi
    
    # Check if Open WebUI container exists
    if ! docker ps -a --format "{{.Names}}" | grep -q "^portico-open-webui$"; then
        error "Open WebUI container not found!"
        echo
        print_message_block \
            "Please run ${GREEN}./src/scripts/docker-compose.sh start${NC} first to create the container."
        exit 1
    fi
    
    # Get current version
    local current_version=$(get_current_version)
    if [ -n "$current_version" ]; then
        log "Current Open WebUI version: ${CYAN}$current_version${NC}"
    fi
    
    # Check if container is running
    local was_running=false
    if check_container_status; then
        was_running=true
        log "Open WebUI is currently running"
    else
        log "Open WebUI is not currently running"
    fi
    
    echo
    print_message_block \
        "${BOLD}This will:${NC}" \
        "• Check for Open WebUI updates" \
        "• Download the latest version if available" \
        "• Update the container while preserving your data" \
        "• Restart the container automatically"
    
    echo
    read -p "Do you want to check for updates? (Y/n): " -n 1 -r
    echo
    
    if [[ ! $REPLY =~ ^[Yy]$ ]] && [ -n "$REPLY" ]; then
        log "Update cancelled"
        exit 0
    fi
    
    echo
    log "🔍 Checking for Open WebUI updates..."
    echo
    
    # Run watchtower to update the container
    # Note: Watchtower will only update if a new version is available
    if docker run --rm \
        --volume /var/run/docker.sock:/var/run/docker.sock \
        containrrr/watchtower \
        --run-once \
        --cleanup \
        --include-stopped \
        portico-open-webui 2>&1 | while IFS= read -r line; do
            # Filter and format watchtower output
            if echo "$line" | grep -q "Pulling image"; then
                log "📥 Downloading new version..."
            elif echo "$line" | grep -q "Creating"; then
                log "🔄 Updating container..."
            elif echo "$line" | grep -q "Removing image"; then
                log "🗑️  Cleaning up old image..."
            elif echo "$line" | grep -q "Session done"; then
                continue
            elif echo "$line" | grep -q "With watchtower you can update"; then
                continue
            elif echo "$line" | grep -q "Watchtower"; then
                continue
            elif echo "$line" | grep -E "time=|level=debug"; then
                continue
            elif [ -n "$line" ]; then
                echo -e "${CYAN}[UPDATE]${NC} $line"
            fi
        done; then
        echo
        
        # Check if container was actually updated
        local new_version=$(get_current_version)
        if [ "$current_version" != "$new_version" ] && [ -n "$new_version" ]; then
            success "Open WebUI updated successfully!"
            log "New version: ${CYAN}$new_version${NC}"
            
            # If it was running before, ensure it's running now
            if [ "$was_running" = true ]; then
                if check_container_status; then
                    success "Container is running with the new version"
                else
                    warning "Container was updated but is not running"
                    echo
                    print_message_block \
                        "Start it with: ${GREEN}./src/scripts/docker-compose.sh start${NC}"
                fi
            fi
        else
            log "✨ Open WebUI is already up to date!"
        fi
        
        echo
        print_message_block \
            "${BOLD}Next steps:${NC}" \
            "• Access Open WebUI at: ${GREEN}http://localhost:3789${NC}" \
            "• View logs: ${YELLOW}docker logs portico-open-webui${NC}" \
            "• Check status: ${YELLOW}docker ps${NC}"
        
    else
        error "Update check failed!"
        echo
        print_message_block \
            "Please check your internet connection and try again."
        exit 1
    fi
    
    echo
    success "Update check completed!"
    echo
}

# Run main function
main