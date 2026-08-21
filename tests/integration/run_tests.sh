#!/bin/bash
#
# Integration Test Runner
# Runs agentic integration tests using Atlas Agent SDK
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_REDIS_CONTAINER="${DEFAULT_REDIS_CONTAINER:-portico-redis}"

# Default configuration
REDIS_HOST="${REDIS_HOST:-}"
REDIS_PORT="${REDIS_PORT:-6379}"
OPENWEBUI_BASE_URL="${OPENWEBUI_BASE_URL:-http://localhost:3789}"
ATLAS_MODEL="${ATLAS_MODEL:-atlas-opus-4-5-20251101}"
VERBOSE=""
TEST_FILTER=""
MARKERS=""
LIST_ONLY=false

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

usage() {
    cat << EOF
Usage: $(basename "$0") [OPTIONS] [TEST_PATTERN]

Run integration tests for Open WebUI.

Options:
    -h, --help          Show this help message
    -v, --verbose       Verbose output (show test details)
    -l, --list          List available tests without running them
    -m, --marker MARK   Run tests with specific pytest marker
                        Available markers: smoke, critical, filters, agent_vm,
                                          skills, mcp, slow
    -s, --spec NAME     Run a specific spec file (e.g., 01_filter_chain_execution)
    --redis HOST        Redis host (default: auto-detect live Redis container IP)
    --url URL           Open WebUI base URL (default: $OPENWEBUI_BASE_URL)
    --model MODEL       Atlas model to use (default: opus)
                        Shorthand: opus, sonnet, haiku
                        Full IDs also accepted (e.g., atlas-opus-4-5-20251101)
    --direct            Run in direct mode (skip Atlas SDK, validation only)

Examples:
    $(basename "$0")                          # Run all tests
    $(basename "$0") -v                       # Run all tests with verbose output
    $(basename "$0") -m smoke                 # Run only smoke tests
    $(basename "$0") -m critical              # Run only critical tests
    $(basename "$0") -s 01_filter_chain       # Run filter chain test
    $(basename "$0") -l                       # List all available tests
    $(basename "$0") --direct                 # Quick validation mode
    $(basename "$0") --model sonnet              # Use Sonnet (faster/cheaper)

EOF
}

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[OK]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

resolve_redis_host_from_inspect() {
    local container_name="${1:-$DEFAULT_REDIS_CONTAINER}"
    if ! command -v docker >/dev/null 2>&1; then
        return 1
    fi

    docker inspect -f '{{range .NetworkSettings.Networks}}{{if .IPAddress}}{{.IPAddress}}{{"\n"}}{{end}}{{end}}' "$container_name" 2>/dev/null \
        | awk 'NF { print; exit }'
}

resolve_redis_port_from_docker_port() {
    local container_name="${1:-$DEFAULT_REDIS_CONTAINER}"
    if ! command -v docker >/dev/null 2>&1; then
        return 1
    fi

    docker port "$container_name" 6379/tcp 2>/dev/null \
        | head -n 1 \
        | awk -F: 'NF { print $NF; exit }'
}

resolve_redis_connection() {
    if [[ -n "${REDIS_HOST:-}" ]]; then
        REDIS_PORT="${REDIS_PORT:-6379}"
        return 0
    fi

    local inspected_host=""
    inspected_host="$(resolve_redis_host_from_inspect "$DEFAULT_REDIS_CONTAINER" || true)"
    if [[ -n "$inspected_host" ]]; then
        REDIS_HOST="$inspected_host"
        REDIS_PORT="${REDIS_PORT:-6379}"
        return 0
    fi

    local published_port=""
    published_port="$(resolve_redis_port_from_docker_port "$DEFAULT_REDIS_CONTAINER" || true)"
    if [[ -n "$published_port" ]]; then
        REDIS_HOST="127.0.0.1"
        REDIS_PORT="$published_port"
        return 0
    fi

    REDIS_HOST="localhost"
    REDIS_PORT="${REDIS_PORT:-6379}"
}

main() {
cd "$SCRIPT_DIR"

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help)
            usage
            exit 0
            ;;
        -v|--verbose)
            VERBOSE="-v -s"
            shift
            ;;
        -l|--list)
            LIST_ONLY=true
            shift
            ;;
        -m|--marker)
            MARKERS="-m $2"
            shift 2
            ;;
        -s|--spec)
            # Find matching spec file by partial name
            SPEC_PATTERN="$2"
            MATCHED_SPEC=""
            for spec in specs/*.md; do
                name=$(basename "$spec" .md)
                if [[ "$name" == *"$SPEC_PATTERN"* ]]; then
                    MATCHED_SPEC="$name"
                    break
                fi
            done
            if [[ -n "$MATCHED_SPEC" ]]; then
                TEST_FILTER="test_runner.py::test_spec[$MATCHED_SPEC]"
            else
                TEST_FILTER="test_runner.py::test_spec[$SPEC_PATTERN]"
            fi
            shift 2
            ;;
        --redis)
            REDIS_HOST="$2"
            shift 2
            ;;
        --url)
            OPENWEBUI_BASE_URL="$2"
            shift 2
            ;;
        --model)
            # Resolve shorthand model names to full model IDs (latest versions as of 2025)
            case "$2" in
                opus|Opus|OPUS)
                    ATLAS_MODEL="atlas-opus-4-5-20251101"
                    ;;
                sonnet|Sonnet|SONNET)
                    ATLAS_MODEL="atlas-sonnet-4-5-20250929"
                    ;;
                haiku|Haiku|HAIKU)
                    ATLAS_MODEL="atlas-haiku-4-5-20251001"
                    ;;
                *)
                    ATLAS_MODEL="$2"
                    ;;
            esac
            shift 2
            ;;
        --direct)
            export INTEGRATION_TEST_DIRECT_MODE=1
            shift
            ;;
        *)
            # Treat as test pattern
            TEST_FILTER="$1"
            shift
            ;;
    esac
done

resolve_redis_connection

# Check for virtual environment
if [[ ! -d ".venv" ]]; then
    log_info "Creating virtual environment..."
    uv venv
fi

# Install dependencies if needed
if [[ ! -f ".venv/pyvenv.cfg" ]] || [[ "pyproject.toml" -nt ".venv/pyvenv.cfg" ]]; then
    log_info "Installing dependencies..."
    uv pip install -e .
fi

# Export environment variables
export REDIS_HOST
export REDIS_PORT
export OPENWEBUI_BASE_URL
export ATLAS_MODEL

# List tests if requested
if [[ "$LIST_ONLY" == "true" ]]; then
    echo ""
    echo "Available Test Specifications:"
    echo "=============================="
    for spec in specs/*.md; do
        name=$(basename "$spec" .md)
        # Extract description from YAML frontmatter
        desc=$(sed -n '/^---$/,/^---$/p' "$spec" | grep "^description:" | sed 's/description: *//')
        echo -e "  ${GREEN}$name${NC}"
        if [[ -n "$desc" ]]; then
            echo -e "    $desc"
        fi
    done
    echo ""
    echo "Available Markers:"
    echo "=================="
    echo "  smoke     - Quick verification tests"
    echo "  critical  - Critical functionality tests"
    echo "  filters   - Filter chain tests"
    echo "  agent_vm  - Agent VM tests"
    echo "  skills    - Skills activation tests"
    echo "  mcp       - MCP server tests"
    echo "  slow      - Long-running tests"
    echo ""
    exit 0
fi

# Verify prerequisites
log_info "Checking prerequisites..."

# Check Redis connectivity (use uv run to ensure venv is used)
if ! uv run python -c "import redis; r = redis.Redis(host='$REDIS_HOST', port=$REDIS_PORT); r.ping()" 2>/dev/null; then
    log_error "Cannot connect to Redis at $REDIS_HOST:$REDIS_PORT"
    log_warn "Make sure Redis is running and accessible"
    exit 1
fi
log_success "Redis connection OK"

# Check Open WebUI connectivity
if ! curl -s --connect-timeout 5 "$OPENWEBUI_BASE_URL/health" > /dev/null 2>&1; then
    # Try alternate health endpoint
    if ! curl -s --connect-timeout 5 "$OPENWEBUI_BASE_URL" > /dev/null 2>&1; then
        log_warn "Open WebUI at $OPENWEBUI_BASE_URL may not be accessible"
        log_warn "Tests that require the API may fail"
    fi
fi
log_success "Open WebUI connection OK"

# Check Atlas CLI
if ! command -v atlas &> /dev/null; then
    log_error "Atlas CLI not found in PATH"
    log_warn "Install Atlas Code CLI: npm install -g @anthropic-ai/atlas-code"
    exit 1
fi
log_success "Atlas CLI found"

echo ""
log_info "Running integration tests..."
echo "=============================="
echo "  Redis Host: $REDIS_HOST"
echo "  Redis Port: $REDIS_PORT"
echo "  OpenWebUI URL: $OPENWEBUI_BASE_URL"
echo "  Atlas Model: $ATLAS_MODEL"
if [[ -n "$MARKERS" ]]; then
    echo "  Markers: $MARKERS"
fi
if [[ -n "$TEST_FILTER" ]]; then
    echo "  Filter: $TEST_FILTER"
fi
echo "=============================="
echo ""

# Build pytest command
PYTEST_CMD="uv run pytest"

if [[ -n "$VERBOSE" ]]; then
    PYTEST_CMD="$PYTEST_CMD $VERBOSE"
else
    PYTEST_CMD="$PYTEST_CMD -v"
fi

if [[ -n "$MARKERS" ]]; then
    PYTEST_CMD="$PYTEST_CMD $MARKERS"
fi

if [[ -n "$TEST_FILTER" ]]; then
    PYTEST_CMD="$PYTEST_CMD \"$TEST_FILTER\""
else
    PYTEST_CMD="$PYTEST_CMD test_runner.py"
fi

# Run tests
eval $PYTEST_CMD
EXIT_CODE=$?

echo ""
if [[ $EXIT_CODE -eq 0 ]]; then
    log_success "All tests passed!"
else
    log_error "Some tests failed (exit code: $EXIT_CODE)"
fi

exit $EXIT_CODE
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    main "$@"
fi
