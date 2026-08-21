#!/bin/bash

# Health Check Script
# Monitors the health of Docker containers and services

set -e

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
# Script now lives in src/scripts - project root is two levels up
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Change to project root
cd "$PROJECT_ROOT"

LLM_GATEWAY_CONTAINER_NAME="llm-gateway"
LLM_GATEWAY_DISPLAY_NAME="LLM Gateway"

# Configuration
MAX_WAIT_TIME=120
CHECK_INTERVAL=2
LLM_GATEWAY_URL="http://localhost:4583/health"
OPENWEBUI_URL="http://localhost:3789"

# Function to check if URL is accessible
check_url() {
    local url="$1"
    local service="$2"
    
    if curl -s -f -L -o /dev/null --max-time 5 "$url" 2>/dev/null; then
        echo -e "${GREEN}✓ $service is healthy${NC}"
        return 0
    else
        echo -e "${RED}✗ $service is not responding${NC}"
        return 1
    fi
}

# Function to check container health
check_container() {
    local container="$1"
    
    # For open-webui, also check portico-open-webui
    if [ "$container" = "open-webui" ]; then
        if docker ps --format "{{.Names}}" | grep -q -E "^(open-webui|portico-open-webui)$"; then
            # Get the actual container name
            local actual_name=$(docker ps --format "{{.Names}}" | grep -E "^(open-webui|portico-open-webui)$" | head -1)
            local health=$(docker inspect --format='{{.State.Health.Status}}' "$actual_name" 2>/dev/null | tr -d '\n' || echo "none")
            if [ "$health" = "healthy" ] || [ "$health" = "none" ] || [ -z "$health" ]; then
                return 0
            fi
        fi
    else
        if docker ps --format "{{.Names}}" | grep -q "^${container}$"; then
            local health=$(docker inspect --format='{{.State.Health.Status}}' "$container" 2>/dev/null | tr -d '\n' || echo "none")
            if [ "$health" = "healthy" ] || [ "$health" = "none" ] || [ -z "$health" ]; then
                return 0
            fi
        fi
    fi
    return 1
}

# Function to wait for health check container to complete
wait_for_health_check_container() {
    local container="open-webui-health-check"
    local max_wait=120
    local elapsed=0
    
    echo "Waiting for health check container to complete..."
    
    while [ $elapsed -lt $max_wait ]; do
        # Check if container exists
        if ! docker ps -a --format "{{.Names}}" | grep -q "^${container}$"; then
            echo -e "${YELLOW}⚠ Health check container not found${NC}"
            return 1
        fi
        
        # Get container status
        local status=$(docker inspect --format='{{.State.Status}}' "$container" 2>/dev/null || echo "unknown")
        
        if [ "$status" = "exited" ]; then
            # Container has exited, check exit code
            local exit_code=$(docker inspect --format='{{.State.ExitCode}}' "$container" 2>/dev/null || echo "1")
            if [ "$exit_code" = "0" ]; then
                echo -e "${GREEN}✓ Health check container completed successfully${NC}"
                return 0
            else
                echo ""
                echo -e "${RED}✗ Health check container failed with exit code: $exit_code${NC}"
                # Show the last few lines of logs
                echo ""
                echo "Health check container logs:"
                docker logs --tail 20 "$container" 2>&1 | sed 's/^/  /'
                return 1
            fi
        elif [ "$status" = "running" ]; then
            # Container still running - just wait silently
            sleep 2
            elapsed=$((elapsed + 2))
        else
            echo -e "${YELLOW}⚠ Health check container in unexpected state: $status${NC}"
            return 1
        fi
    done
    
    echo ""
    echo -e "${RED}✗ Health check container did not complete within ${max_wait} seconds${NC}"
    return 1
}

# Function to wait for services
wait_for_services() {
    local elapsed=0
    local all_healthy=false
    
    echo "Waiting for services to become healthy..."
    
    while [ $elapsed -lt $MAX_WAIT_TIME ]; do
        local llm_gateway_ok=false
        local openwebui_ok=false
        
        # Check LLM gateway (container only, no exposed port requirement)
        if check_container "$LLM_GATEWAY_CONTAINER_NAME"; then
            llm_gateway_ok=true
        fi
        
        # Check Open Web UI
        if check_container "open-webui"; then
            # Try simpler check for Open Web UI
            if curl -s -o /dev/null --max-time 3 "$OPENWEBUI_URL" 2>/dev/null; then
                openwebui_ok=true
            fi
        fi
        
        # Check if all services are healthy
        if $llm_gateway_ok && $openwebui_ok; then
            all_healthy=true
            break
        fi
        
        sleep $CHECK_INTERVAL
        elapsed=$((elapsed + CHECK_INTERVAL))
    done
    
    echo ""
    
    if $all_healthy; then
        return 0
    else
        return 1
    fi
}

# Function to check MCP server configuration
check_mcp_config() {
    local config_file="mcp_config_advanced.json"
    
    if [ ! -f "$config_file" ]; then
        echo -e "${YELLOW}⚠ MCP configuration file not found${NC}"
        return 1
    fi
}

# Main health check
main() {
    echo -e "${BLUE}═══════════════════════════════════════${NC}"
    echo -e "${BLUE}  Portico Health Check${NC}"
    echo -e "${BLUE}═══════════════════════════════════════${NC}"
    echo ""
    
    # Check Docker
    if ! docker info >/dev/null 2>&1; then
        echo -e "${RED}✗ Docker is not running${NC}"
        exit 1
    fi
    echo -e "${GREEN}✓ Docker is running${NC}"
    
    # Check containers
    echo ""
    echo "Checking containers..."
    
    local llm_gateway_running=false
    local openwebui_running=false
    
    if docker ps --format "{{.Names}}" | grep -q "^${LLM_GATEWAY_CONTAINER_NAME}$"; then
        echo -e "${GREEN}✓ ${LLM_GATEWAY_DISPLAY_NAME} container is running${NC}"
        llm_gateway_running=true
    else
        echo -e "${RED}✗ ${LLM_GATEWAY_DISPLAY_NAME} container is not running${NC}"
    fi
    
    if docker ps --format "{{.Names}}" | grep -q -E "^(open-webui|portico-open-webui)$"; then
        echo -e "${GREEN}✓ Open Web UI container is running${NC}"
        openwebui_running=true
    else
        echo -e "${RED}✗ Open Web UI container is not running${NC}"
    fi
    
    if ! $llm_gateway_running || ! $openwebui_running; then
        echo ""
        echo -e "${RED}Some containers are not running. Please start them first.${NC}"
        exit 1
    fi
    
    # Wait for services to be ready
    echo ""
    if wait_for_services; then
        echo ""
        echo "Checking service endpoints..."
        echo -e "${GREEN}✓ ${LLM_GATEWAY_DISPLAY_NAME} container is running${NC}"
        check_url "$OPENWEBUI_URL" "Open Web UI"
        
        # Check MCP configuration
        echo ""
        check_mcp_config
        
        # Wait for health check container to complete and verify its status
        echo ""
        if wait_for_health_check_container; then
            echo ""
            echo -e "${GREEN}═══════════════════════════════════════${NC}"
            echo -e "${GREEN}  All services are healthy!${NC}"
            echo -e "${GREEN}═══════════════════════════════════════${NC}"
            exit 0
        else
            echo ""
            echo -e "${RED}═══════════════════════════════════════${NC}"
            echo -e "${RED}  Health check failed!${NC}"
            echo -e "${RED}  MCP servers may not be properly configured${NC}"
            echo -e "${RED}═══════════════════════════════════════${NC}"
            exit 1
        fi
    else
        echo ""
        echo -e "${RED}Services failed to become healthy within ${MAX_WAIT_TIME} seconds${NC}"
        
        # Show current status
        echo ""
        echo "Current status:"
        check_url "$LLM_GATEWAY_URL" "${LLM_GATEWAY_DISPLAY_NAME} API" || true
        check_url "$OPENWEBUI_URL" "Open Web UI" || true
        
        exit 1
    fi
}

# Run main function
main
