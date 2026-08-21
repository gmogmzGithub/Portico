#!/usr/bin/env bash

# Build and Publish Multi-Arch Docker Images to Harbor
# This script builds all necessary Docker images for Portico
# and publishes linux/amd64 + linux/arm64 manifests to Harbor
#
# Usage: ./build_docker_images.sh <build-number> [--electron-only] [--images name1,name2]
# Example: ./build_docker_images.sh 09172025-53f6ab6b
# Example: ./build_docker_images.sh 09172025-53f6ab6b --electron-only

set -eo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$PROJECT_ROOT/src/scripts/mcp-orc-backend.sh"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Configuration
HARBOR_REGISTRY="harbor.example.invalid"
HARBOR_PROJECT="portico"
ELECTRON_ONLY=false
RETAG_ONLY=false
DEBUG_MODE=false
SOURCE_TAG=""
TARGET_TAG=""
DOCKER_BUILD_PLATFORMS="${DOCKER_BUILD_PLATFORMS:-linux/amd64,linux/arm64}"
BUILDX_BUILDER="${BUILDX_BUILDER:-portico-multiarch-v030}"
BUILDKIT_IMAGE="${BUILDKIT_IMAGE:-moby/buildkit:v0.30.0}"
MAX_PARALLEL_BUILDS="${MAX_PARALLEL_BUILDS:-4}"
SERIALIZE_MCP_RUNTIME_IMAGES="${SERIALIZE_MCP_RUNTIME_IMAGES:-true}"
DOCKER_BUILD_MAX_ATTEMPTS="${DOCKER_BUILD_MAX_ATTEMPTS:-2}"
DOCKER_BUILD_RETRY_DELAY_SECONDS="${DOCKER_BUILD_RETRY_DELAY_SECONDS:-10}"
DOCKER_BUILD_MIN_FREE_GB="${DOCKER_BUILD_MIN_FREE_GB:-50}"
BUILD_LOG_PREFIX="portico-build-logs"
BUILD_LOG_MARKER=".portico-build-logs"
SELECTED_IMAGES=""
SOURCE_REVISION=""
BUILD_TEMP_DIR=""
BUILD_FAILED=false

# Check for --debug flag first (can be anywhere in args)
for arg in "$@"; do
    if [ "$arg" = "--debug" ]; then
        DEBUG_MODE=true
        set -x  # Enable verbose trace output
    fi
done

# Parse arguments
if [ -z "$1" ]; then
    echo -e "${RED}Error: Arguments required${NC}"
    echo "Usage: $0 <build-number> [--electron-only] [--images name1,name2] [--source-revision sha] [--debug]"
    echo "   OR: $0 --retag-only <source-tag> <target-tag> [--debug]"
    echo ""
    echo "Options:"
    echo "  --electron-only  Only build the electron-builder image"
    echo "  --images <list>  Build only the named comma-separated runtime images"
    echo "  --source-revision <sha>  Label images with the full source revision"
    echo "  --debug          Enable verbose shell tracing (set -x)"
    echo ""
    echo "Environment:"
    echo "  DOCKER_BUILD_MIN_FREE_GB  Positive integer local disk minimum (default: 50)"
    echo ""
    echo "Examples:"
    echo "  $0 09172025-53f6ab6b"
    echo "  $0 09172025-53f6ab6b --electron-only"
    echo "  $0 09172025-53f6ab6b --debug"
    echo "  $0 --retag-only 09172025-53f6ab6b 10212025-f31bff5c"
    exit 1
fi

# Check for --retag-only as first argument
if [ "$1" = "--retag-only" ]; then
    RETAG_ONLY=true
    shift

    # Require source and target tags
    if [ -z "$1" ] || [ -z "$2" ]; then
        echo -e "${RED}Error: --retag-only requires both source-tag and target-tag${NC}"
        echo "Usage: $0 --retag-only <source-tag> <target-tag>"
        echo "Example: $0 --retag-only 09172025-53f6ab6b 10212025-f31bff5c"
        exit 1
    fi

    SOURCE_TAG="$1"
    TARGET_TAG="$2"
    shift 2
else
    # Normal build mode
    BUILD_NUMBER="$1"
    shift

    # Check for optional flags
    while [[ $# -gt 0 ]]; do
        case $1 in
            --electron-only)
                ELECTRON_ONLY=true
                shift
                ;;
            --debug)
                # Already handled above, just skip
                shift
                ;;
            --images)
                if [ $# -lt 2 ] || [ -z "$2" ]; then
                    echo -e "${RED}Error: --images requires a comma-separated value${NC}"
                    exit 1
                fi
                SELECTED_IMAGES="$2"
                shift 2
                ;;
            --source-revision)
                if [ $# -lt 2 ] || [ -z "$2" ]; then
                    echo -e "${RED}Error: --source-revision requires a value${NC}"
                    exit 1
                fi
                SOURCE_REVISION="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"
                shift 2
                ;;
            *)
                echo -e "${RED}Unknown argument: $1${NC}"
                echo "Usage: ./build_docker_images.sh <build-number> [--electron-only] [--images name1,name2] [--source-revision sha] [--debug]"
                echo "   OR: ./build_docker_images.sh --retag-only <source-tag> <target-tag> [--debug]"
                exit 1
                ;;
        esac
    done
fi

log() {
    echo -e "${BLUE}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} $1"
}

error() {
    echo -e "${RED}[$(date '+%Y-%m-%d %H:%M:%S')] ❌ $1${NC}"
}

success() {
    echo -e "${GREEN}[$(date '+%Y-%m-%d %H:%M:%S')] ✅ $1${NC}"
}

warn() {
    echo -e "${YELLOW}[$(date '+%Y-%m-%d %H:%M:%S')] ⚠️  $1${NC}"
}

format_disk_kib() {
    local kib="$1"

    awk -v kib="$kib" 'BEGIN { printf "%.1f GiB", kib / 1048576 }'
}

docker_build_available_kib() {
    df -Pk "$PROJECT_ROOT" 2>/dev/null | awk 'NR == 2 { print $4; exit }'
}

check_docker_build_disk_space() {
    local operation="$1"
    local available_kib=""
    local required_kib=$((DOCKER_BUILD_MIN_FREE_GB * 1024 * 1024))

    available_kib="$(docker_build_available_kib || true)"
    if ! [[ "$available_kib" =~ ^[0-9]+$ ]]; then
        error "Unable to determine local free disk space before ${operation}"
        return 1
    fi

    if [ "$available_kib" -lt "$required_kib" ]; then
        error "Insufficient local disk space for ${operation}: $(format_disk_kib "$available_kib") available; $(format_disk_kib "$required_kib") required."
        error "This is a local disk capacity failure, not a remote network failure. Remove old release outputs or release-owned staging trees before retrying."
        return 1
    fi

    log "💾 Disk preflight for ${operation}: $(format_disk_kib "$available_kib") available (minimum $(format_disk_kib "$required_kib"))"
    return 0
}

cleanup_build_logs() {
    if [ -z "$BUILD_TEMP_DIR" ] || [ ! -d "$BUILD_TEMP_DIR" ]; then
        return 0
    fi

    if [ "$BUILD_FAILED" = true ]; then
        warn "Preserving build logs at: $BUILD_TEMP_DIR"
        return 0
    fi

    rm -rf "$BUILD_TEMP_DIR"
}

# --- Opt-in layer-cache reuse diagnostics (PORTICO-205 Phase 2) -------------------
# portico_BUILD_LAYER_REPORT=1 wraps the build in before/after snapshots and a
# per-attempt-log cache-reuse analysis via portico-build-layer-reuse-report.sh.
# Default OFF: with the flag unset these functions do nothing and the build
# behaves exactly as before. Every diagnostic call is non-fatal.
LAYER_REPORT_SCRIPT="$PROJECT_ROOT/src/scripts/portico-build-layer-reuse-report.sh"
LAYER_REPORT_DIR=""
LAYER_REPORT_FINALIZED=false

layer_report_enabled() {
    [ "${portico_BUILD_LAYER_REPORT:-0}" = "1" ]
}

layer_report_begin() {
    layer_report_enabled || return 0

    if [ ! -x "$LAYER_REPORT_SCRIPT" ]; then
        warn "portico_BUILD_LAYER_REPORT=1 but $LAYER_REPORT_SCRIPT is missing or not executable; skipping layer report"
        return 0
    fi

    LAYER_REPORT_DIR=$(mktemp -d "${TMPDIR:-/tmp}/portico-layer-report.XXXXXX") || {
        warn "Unable to create layer report directory; skipping layer report"
        LAYER_REPORT_DIR=""
        return 0
    }

    log "🔬 Layer-cache reuse report enabled: $LAYER_REPORT_DIR"
    "$LAYER_REPORT_SCRIPT" snapshot "$LAYER_REPORT_DIR/before" --builder "$BUILDX_BUILDER" \
        || warn "layer report pre-snapshot failed (non-fatal)"
}

# Runs from the EXIT trap so diagnostics survive every failure path (including
# mid-batch disk-preflight exits), BEFORE cleanup_build_logs removes the
# attempt logs. Never changes the script's exit status.
layer_report_finalize() {
    [ "$LAYER_REPORT_FINALIZED" = false ] || return 0
    LAYER_REPORT_FINALIZED=true

    layer_report_enabled || return 0
    [ -n "$LAYER_REPORT_DIR" ] || return 0
    [ -d "$LAYER_REPORT_DIR/before" ] || return 0
    [ -x "$LAYER_REPORT_SCRIPT" ] || return 0

    "$LAYER_REPORT_SCRIPT" snapshot "$LAYER_REPORT_DIR/after" --builder "$BUILDX_BUILDER" \
        || warn "layer report post-snapshot failed (non-fatal)"

    local attempt_logs=("$BUILD_TEMP_DIR"/*.attempt-*)
    if [ -n "$BUILD_TEMP_DIR" ] && [ -e "${attempt_logs[0]}" ]; then
        "$LAYER_REPORT_SCRIPT" analyze "${attempt_logs[@]}" --out "$LAYER_REPORT_DIR" \
            || warn "layer report analysis failed (non-fatal)"
    else
        warn "layer report: no build attempt logs found to analyze"
    fi

    if [ -d "$LAYER_REPORT_DIR/after" ]; then
        "$LAYER_REPORT_SCRIPT" diff "$LAYER_REPORT_DIR/before" "$LAYER_REPORT_DIR/after" --out "$LAYER_REPORT_DIR" \
            || warn "layer report diff failed (non-fatal)"
    fi

    log "🔬 Layer-cache reuse report preserved at: $LAYER_REPORT_DIR"
    return 0
}

setup_buildx_builder() {
    local builder="$BUILDX_BUILDER"

    if ! docker buildx inspect "$builder" >/dev/null 2>&1; then
        log "🧱 Creating buildx builder: $builder (${BUILDKIT_IMAGE})"
        docker buildx create \
            --name "$builder" \
            --driver docker-container \
            --driver-opt "image=${BUILDKIT_IMAGE}" >/dev/null
    fi

    docker buildx use "$builder" >/dev/null
    docker buildx inspect "$builder" --bootstrap >/dev/null
    success "Buildx builder ready: $builder (requested BuildKit image: ${BUILDKIT_IMAGE})"
}

verify_multiarch_manifest() {
    local image_ref="$1"
    local image_name="${2:-image}"
    local inspect_output=""

    inspect_output=$(docker buildx imagetools inspect "$image_ref" 2>/dev/null || true)
    if [ -z "$inspect_output" ]; then
        error "[$image_name] Unable to inspect manifest for $image_ref"
        return 1
    fi

    if ! echo "$inspect_output" | grep -q "linux/amd64"; then
        error "[$image_name] Missing linux/amd64 in manifest: $image_ref"
        return 1
    fi

    if ! echo "$inspect_output" | grep -q "linux/arm64"; then
        error "[$image_name] Missing linux/arm64 in manifest: $image_ref"
        return 1
    fi

    success "[$image_name] Manifest verified: $image_ref (linux/amd64 + linux/arm64)"
    return 0
}

format_bytes_human() {
    local bytes="$1"

    awk -v bytes="$bytes" '
        function human(x,    units, unit_count, i) {
            split("B KB MB GB TB PB", units, " ")
            unit_count = length(units)
            i = 1
            while (x >= 1024 && i < unit_count) {
                x /= 1024
                i++
            }
            if (x >= 100 || i == 1) {
                printf "%.0f %s", x, units[i]
            } else {
                printf "%.1f %s", x, units[i]
            }
        }
        BEGIN {
            human(bytes + 0)
        }
    '
}

get_multiarch_image_size_report() {
    local image_ref="$1"
    local raw_json=""

    command -v python3 >/dev/null 2>&1 || return 1

    raw_json="$(docker buildx imagetools inspect --raw "$image_ref" 2>/dev/null)" || return 1

    python3 -c '
import json
import subprocess
import sys

image_ref = sys.argv[1]
raw = sys.argv[2].strip()
if not raw:
    raise SystemExit(1)

data = json.loads(raw)


def repository_for_digest(ref: str) -> str:
    ref = ref.split("@", 1)[0]
    last_slash = ref.rfind("/")
    last_colon = ref.rfind(":")
    if last_colon > last_slash:
        return ref[:last_colon]
    return ref


def inspect_raw(ref: str) -> dict:
    child_raw = subprocess.check_output(
        ["docker", "buildx", "imagetools", "inspect", "--raw", ref],
        stderr=subprocess.DEVNULL,
        text=True,
    ).strip()
    return json.loads(child_raw)


def manifest_size(manifest: dict) -> int:
    total = 0
    config = manifest.get("config") or {}
    total += int(config.get("size") or 0)
    for layer in manifest.get("layers") or []:
        total += int(layer.get("size") or 0)
    return total


repository = repository_for_digest(image_ref)
entries = []
manifests = data.get("manifests") or [data]

for entry in manifests:
    platform = entry.get("platform") or {}
    os_name = platform.get("os")
    architecture = platform.get("architecture")
    digest = entry.get("digest")

    if os_name not in ("", None, "linux"):
        continue
    if architecture in (None, "", "unknown"):
        continue

    manifest = data
    if digest:
        manifest = inspect_raw(f"{repository}@{digest}")

    total_size = manifest_size(manifest)
    if total_size <= 0:
        continue

    entries.append((architecture, total_size))

if not entries:
    raise SystemExit(1)

entries.sort()
overall = sum(size for _, size in entries)
print(overall)
for arch, size in entries:
    print(f"{arch}:{size}")
' "$image_ref" "$raw_json"
}

format_image_size_summary() {
    local image_ref="$1"
    local report="$2"
    local total_bytes=""
    local detail_lines=""
    local arch=""
    local bytes=""
    local detail_summary=""

    total_bytes="$(printf '%s\n' "$report" | sed -n '1p')"
    detail_lines="$(printf '%s\n' "$report" | sed -n '2,$p')"

    while IFS=: read -r arch bytes; do
        [ -n "$arch" ] || continue
        if [ -n "$detail_summary" ]; then
            detail_summary="${detail_summary}, "
        fi
        detail_summary="${detail_summary}${arch} $(format_bytes_human "$bytes")"
    done <<EOF
$detail_lines
EOF

    printf '  • %s -> %s total' "$image_ref" "$(format_bytes_human "$total_bytes")"
    if [ -n "$detail_summary" ]; then
        printf ' (%s)' "$detail_summary"
    fi
    printf '\n'
}

validate_mcpo_slack_binaries() {
    if [ "$RETAG_ONLY" = true ]; then
        return 0
    fi

    if ! echo " $IMAGES " | grep -Eq " mcp-orc-rust:Dockerfile\\.mcp-orc-rust "; then
        return 0
    fi

    local required_binaries="mcp-configs/slack/slack-mcp-server-linux-arm64 mcp-configs/slack/slack-mcp-server-linux-amd64"
    local missing=false

    for binary in $required_binaries; do
        if [ ! -f "$binary" ]; then
            error "Required Slack binary missing: $binary"
            missing=true
        fi
    done

    if [ "$missing" = true ]; then
        error "Cannot build multi-arch MCPO image without both Slack binaries"
        exit 1
    fi
}

filter_image_pairs() {
    local image_pairs="$1"
    local selected_names="$2"
    local filtered=""
    local image_pair=""
    local image_name=""

    for image_pair in $image_pairs; do
        image_name="${image_pair%%:*}"
        case " $selected_names " in
            *" $image_name "*) filtered="$filtered $image_pair" ;;
        esac
    done

    printf '%s\n' "${filtered# }"
}

normalize_and_validate_selected_images() {
    local canonical_pairs="$1"
    local requested=""
    local normalized=""
    local image_name=""
    local image_pair=""
    local found=false

    [ -n "$SELECTED_IMAGES" ] || return 0

    requested="$(printf '%s' "$SELECTED_IMAGES" | tr ',' ' ')"
    for image_name in $requested; do
        found=false
        for image_pair in $canonical_pairs; do
            if [ "${image_pair%%:*}" = "$image_name" ]; then
                found=true
                break
            fi
        done

        if [ "$found" != true ]; then
            error "Unknown image requested by --images: $image_name"
            exit 1
        fi

        case " $normalized " in
            *" $image_name "*) ;;
            *) normalized="$normalized $image_name" ;;
        esac
    done

    SELECTED_IMAGES="${normalized# }"
    [ -n "$SELECTED_IMAGES" ] || {
        error "--images must contain at least one runtime image"
        exit 1
    }
}

# Define images to build (compatible with bash 3.2).
MCP_RUNTIME_IMAGES="mcpo-control-plane-rust:Dockerfile.mcpo-control-plane-rust mcp-orc-rust:Dockerfile.mcp-orc-rust"
LLM_GATEWAY_IMAGES="bifrost-bridge:Dockerfile.bifrost-bridge"
APP_SERVICE_IMAGES="open-webui-patched:Dockerfile.open-webui-patched health-check:Dockerfile.health-check chat-state-api:Dockerfile.chat-state-api agent-vm:Dockerfile.agent-vm"
ALL_RUNTIME_IMAGES="$MCP_RUNTIME_IMAGES $LLM_GATEWAY_IMAGES $APP_SERVICE_IMAGES"

if [ "$ELECTRON_ONLY" = true ]; then
    if [ -n "$SELECTED_IMAGES" ]; then
        error "--images cannot be combined with --electron-only"
        exit 1
    fi
    IMAGES="electron-builder:electron-app/Dockerfile.electron-build"
else
    normalize_and_validate_selected_images "$ALL_RUNTIME_IMAGES"
    if [ -n "$SELECTED_IMAGES" ]; then
        MCP_RUNTIME_IMAGES="$(filter_image_pairs "$MCP_RUNTIME_IMAGES" "$SELECTED_IMAGES")"
        LLM_GATEWAY_IMAGES="$(filter_image_pairs "$LLM_GATEWAY_IMAGES" "$SELECTED_IMAGES")"
        APP_SERVICE_IMAGES="$(filter_image_pairs "$APP_SERVICE_IMAGES" "$SELECTED_IMAGES")"
    fi
    IMAGES="$MCP_RUNTIME_IMAGES $LLM_GATEWAY_IMAGES $APP_SERVICE_IMAGES"
fi

if [ "$RETAG_ONLY" = false ]; then
    if [ -z "$SOURCE_REVISION" ]; then
        SOURCE_REVISION="$(git -C "$PROJECT_ROOT" rev-parse HEAD 2>/dev/null || true)"
    fi
    SOURCE_REVISION="$(printf '%s' "$SOURCE_REVISION" | tr '[:upper:]' '[:lower:]')"
    if ! [[ "$SOURCE_REVISION" =~ ^[a-f0-9]{40}$ ]]; then
        error "A full 40-character source revision is required (got: ${SOURCE_REVISION:-empty})"
        exit 1
    fi
fi

if ! [[ "$MAX_PARALLEL_BUILDS" =~ ^[0-9]+$ ]] || [ "$MAX_PARALLEL_BUILDS" -lt 1 ]; then
    error "MAX_PARALLEL_BUILDS must be a positive integer (got: $MAX_PARALLEL_BUILDS)"
    exit 1
fi
if ! [[ "$DOCKER_BUILD_MAX_ATTEMPTS" =~ ^[0-9]+$ ]] || [ "$DOCKER_BUILD_MAX_ATTEMPTS" -lt 1 ]; then
    error "DOCKER_BUILD_MAX_ATTEMPTS must be a positive integer (got: $DOCKER_BUILD_MAX_ATTEMPTS)"
    exit 1
fi
if ! [[ "$DOCKER_BUILD_RETRY_DELAY_SECONDS" =~ ^[0-9]+$ ]]; then
    error "DOCKER_BUILD_RETRY_DELAY_SECONDS must be a non-negative integer (got: $DOCKER_BUILD_RETRY_DELAY_SECONDS)"
    exit 1
fi
if ! [[ "$DOCKER_BUILD_MIN_FREE_GB" =~ ^[0-9]+$ ]] || [ "$DOCKER_BUILD_MIN_FREE_GB" -lt 1 ]; then
    error "DOCKER_BUILD_MIN_FREE_GB must be a positive integer (got: ${DOCKER_BUILD_MIN_FREE_GB:-empty})"
    exit 1
fi

if [ "$RETAG_ONLY" = false ] && ! check_docker_build_disk_space "Docker image builds"; then
    exit 1
fi

# Check if Docker is running
if ! docker info >/dev/null 2>&1; then
    error "Docker is not running. Please start Docker and try again."
    exit 1
fi

# Check if logged into Harbor by attempting a simple operation
log "🔐 Checking Harbor authentication..."
if docker pull ${HARBOR_REGISTRY}/library/hello-world:latest >/dev/null 2>&1 || \
   grep -q "$HARBOR_REGISTRY" ~/.docker/config.json 2>/dev/null; then
    success "Authenticated with Harbor registry"
else
    error "Not logged into Harbor. Please run:"
    echo
    echo -e "${YELLOW}  export HARBOR_TOKEN=<your CLI secret from Harbor user profile>${NC}"
    echo -e "${YELLOW}  echo \$HARBOR_TOKEN | docker login -u $USER --password-stdin $HARBOR_REGISTRY${NC}"
    echo
    echo "Get your CLI secret from: https://harbor.example.invalid/ → User Profile → CLI Secret"
    exit 1
fi

# Ensure buildx is configured for multi-arch build/publish and retag workflows
setup_buildx_builder

echo
echo -e "${CYAN}========================================${NC}"
if [ "$RETAG_ONLY" = true ]; then
    echo -e "${CYAN}  Retag-Only Mode (No Building)${NC}"
    echo -e "${CYAN}  Source Tag: ${SOURCE_TAG}${NC}"
    echo -e "${CYAN}  Target Tag: ${TARGET_TAG}${NC}"
elif [ "$ELECTRON_ONLY" = true ]; then
    echo -e "${CYAN}  Building Electron Builder Image Only${NC}"
    echo -e "${CYAN}  Build Number: ${BUILD_NUMBER}${NC}"
else
    echo -e "${CYAN}  Building Docker Images${NC}"
    echo -e "${CYAN}  Build Number: ${BUILD_NUMBER}${NC}"
fi
echo -e "${CYAN}  Registry: ${HARBOR_REGISTRY}${NC}"
echo -e "${CYAN}  Project: ${HARBOR_PROJECT}${NC}"
echo -e "${CYAN}  Platforms: ${DOCKER_BUILD_PLATFORMS}${NC}"
if [ -n "$SELECTED_IMAGES" ]; then
    echo -e "${CYAN}  Selected images: ${SELECTED_IMAGES}${NC}"
fi
if [ "$RETAG_ONLY" = false ]; then
    echo -e "${CYAN}  Source revision: ${SOURCE_REVISION}${NC}"
    echo -e "${CYAN}  BuildKit image: ${BUILDKIT_IMAGE}${NC}"
fi
echo -e "${CYAN}========================================${NC}"
echo

validate_mcpo_slack_binaries

# Track published images for summary
PUSHED_IMAGES=""

# Create an identifiable temp directory for compact build logs.
BUILD_TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/${BUILD_LOG_PREFIX}.XXXXXX")
: > "$BUILD_TEMP_DIR/$BUILD_LOG_MARKER"
# The chained trap is installed BEFORE the layer-report pre-snapshot so any
# later exit path still finalizes the diagnostics (finalize runs before the
# attempt logs are cleaned up and never alters the exit status).
trap 'layer_report_finalize; cleanup_build_logs' EXIT

if [ "$RETAG_ONLY" = false ]; then
    layer_report_begin
fi

# RETAG-ONLY MODE: Skip building, just retag existing images
if [ "$RETAG_ONLY" = true ]; then
    log "🏷️  Retag-only mode: Skipping build, retagging existing images..."
    echo

    # Extract just image names (strip Dockerfile paths)
    IMAGE_NAMES=""
    for IMAGE_PAIR in $IMAGES; do
        IMAGE_NAME="${IMAGE_PAIR%%:*}"
        IMAGE_NAMES="$IMAGE_NAMES $IMAGE_NAME"
    done

    # Retag all images
    BUILD_NAMES_ARRAY=($IMAGE_NAMES)
    BUILD_TAGS_ARRAY=()
    BUILD_LATEST_ARRAY=()
    BUILD_COUNT=${#BUILD_NAMES_ARRAY[@]}

    log "📋 Retagging ${BUILD_COUNT} images from ${SOURCE_TAG} → ${TARGET_TAG}..."
    echo

    for IMAGE_NAME in $IMAGE_NAMES; do
        SOURCE_IMAGE="${HARBOR_REGISTRY}/${HARBOR_PROJECT}/${IMAGE_NAME}:${SOURCE_TAG}"
        TARGET_IMAGE="${HARBOR_REGISTRY}/${HARBOR_PROJECT}/${IMAGE_NAME}:${TARGET_TAG}"
        LATEST_IMAGE="${HARBOR_REGISTRY}/${HARBOR_PROJECT}/${IMAGE_NAME}:latest"

        log "🏷️  Retagging $IMAGE_NAME..."
        log "   Source: $SOURCE_IMAGE"
        log "   Target: $TARGET_IMAGE"

        # Retag multi-arch manifest from source to target
        if docker buildx imagetools create -t "$TARGET_IMAGE" "$SOURCE_IMAGE" >/dev/null; then
            success "  ✅ Retagged $IMAGE_NAME:${SOURCE_TAG} → ${TARGET_TAG}"
        else
            error "  ❌ Failed to retag manifest $IMAGE_NAME:${SOURCE_TAG} → ${TARGET_TAG}"
            exit 1
        fi

        # Also retag as latest
        if docker buildx imagetools create -t "$LATEST_IMAGE" "$SOURCE_IMAGE" >/dev/null; then
            success "  ✅ Retagged $IMAGE_NAME:${SOURCE_TAG} → latest"
        else
            error "  ❌ Failed to retag manifest $IMAGE_NAME as latest"
            exit 1
        fi

        if ! verify_multiarch_manifest "$TARGET_IMAGE" "$IMAGE_NAME"; then
            exit 1
        fi
        if ! verify_multiarch_manifest "$LATEST_IMAGE" "$IMAGE_NAME"; then
            exit 1
        fi

        # Populate arrays for summary section
        BUILD_TAGS_ARRAY+=("$TARGET_IMAGE")
        BUILD_LATEST_ARRAY+=("$LATEST_IMAGE")

        echo
    done

    success "🎉 All images retagged successfully!"
    echo

    # Retag-only path skips local builds and uses manifest publication directly.
else
    # NORMAL BUILD MODE
    log "🚀 Starting Docker builds..."
    log "   Max parallel non-runtime builds: ${MAX_PARALLEL_BUILDS}"
    log "   Serialize MCP runtime images: ${SERIALIZE_MCP_RUNTIME_IMAGES}"
    log "   Max attempts per image: ${DOCKER_BUILD_MAX_ATTEMPTS}"
    log "   Minimum local free disk: ${DOCKER_BUILD_MIN_FREE_GB} GiB"
    echo
fi

# Only run build section if NOT in retag-only mode
if [ "$RETAG_ONLY" = false ]; then

ALL_BUILD_NAMES=""
ALL_BUILD_TAGS=""
ALL_BUILD_LATEST=""
FAILED_BUILDS=""

is_non_retryable_build_failure() {
    local attempt_log="$1"

    [ -f "$attempt_log" ] || return 1

    grep -Eiq '(^|[^[:alpha:]])(401 Unauthorized|403 Forbidden|404 Not Found|authentication required|requested access .* denied)|dockerfile parse error|failed to (read|parse) dockerfile|unknown instruction|circular dependency detected|target stage .* could not be found|failed to compute cache key:.*not found|error\[[A-Z][0-9]+\]|error: could not compile|compilation terminated|undefined reference|test result: FAILED|[1-9][0-9]* tests? failed|No matching distribution found|Could not find a version that satisfies the requirement|checksum failed|failed to verify checksum|lock file .* needs to be updated|failed to select a version|no matching package named' "$attempt_log"
}

is_local_disk_build_failure() {
    local attempt_log="$1"

    [ -f "$attempt_log" ] || return 1
    grep -Eiq 'no space left on device|disk quota exceeded|ENOSPC' "$attempt_log"
}

is_buildkit_control_plane_failure() {
    local attempt_log="$1"

    [ -f "$attempt_log" ] || return 1
    is_non_retryable_build_failure "$attempt_log" && return 1

    grep -Eiq 'failed to receive status: rpc error: code = Unavailable|rpc error: code = Unavailable.*error reading from server: EOF|error reading from server: EOF|failed to dial (gRPC|grpc)|cannot connect to the Docker daemon|failed to connect to docker API' "$attempt_log"
}

is_retryable_network_build_failure() {
    local attempt_log="$1"

    [ -f "$attempt_log" ] || return 1
    is_non_retryable_build_failure "$attempt_log" && return 1
    is_local_disk_build_failure "$attempt_log" && return 1
    is_buildkit_control_plane_failure "$attempt_log" && return 1

    # A transient warning earlier in the log must not turn a deterministic
    # compiler, test, source-context, or Dockerfile error into a full retry.
    grep -Eiq 'Unable to connect|Could not connect|connection timed out|TLS handshake timeout|Temporary failure (resolving|in name resolution)|network is unreachable|connection reset by peer|i/o timeout|unexpected EOF|failed to do request|no such host|Error in the HTTP2 framing layer|HTTP/2 stream .* was not closed cleanly|spurious network error|download of .* failed|failed to download from|failed to get successful HTTP response|operation too slow|curl failed' "$attempt_log"
}

docker_build_runtime_is_healthy() {
    if ! check_docker_build_disk_space "BuildKit retry"; then
        error "BuildKit retry blocked because local disk headroom is below the configured minimum."
        return 1
    fi

    if ! docker info >/dev/null 2>&1; then
        error "Local Docker/OrbStack is unavailable after the BuildKit control-plane disconnect; not retrying."
        return 1
    fi

    if ! docker buildx inspect "$BUILDX_BUILDER" --bootstrap >/dev/null 2>&1; then
        error "BuildKit builder ${BUILDX_BUILDER} is unavailable after the control-plane disconnect; not retrying."
        return 1
    fi

    return 0
}

# Function to build a single image - output goes to log file, tail -f displays it
build_image() {
    local IMAGE_NAME=$1
    local DOCKERFILE=$2
    local IMAGE_TAG=$3
    local IMAGE_LATEST=$4
    local BUILD_CONTEXT=$5
    local LOG_FILE=$6
    local BUILD_ARGS=""
    local EXIT_CODE=1
    local ATTEMPT=1
    local ATTEMPT_LOG=""

    {
        echo "══════════════════════════════════════════════════════════════"
        echo "[$IMAGE_NAME] Starting build at $(date '+%H:%M:%S')"
        echo "══════════════════════════════════════════════════════════════"

        case "$IMAGE_NAME" in
            mcpo)
                BUILD_ARGS="--build-arg ENABLE_SUPERVISOR=1 --build-arg INCLUDE_NODE=1 --build-arg INCLUDE_DOCKER_CLI=1"
                ;;
            open-webui-patched)
                BUILD_ARGS="--build-arg OPENWEBUI_VERSION=v0.6.43"
                ;;
            mcp-orc-rust)
                BUILD_ARGS="--build-arg ENABLE_SUPERVISOR=1 --build-arg INCLUDE_NODE=1 --build-arg INCLUDE_DOCKER_CLI=1"
                ;;
        esac

        while [ "$ATTEMPT" -le "$DOCKER_BUILD_MAX_ATTEMPTS" ]; do
            ATTEMPT_LOG="${LOG_FILE}.attempt-${ATTEMPT}"
            : > "$ATTEMPT_LOG"
            echo "[$IMAGE_NAME] Build attempt ${ATTEMPT}/${DOCKER_BUILD_MAX_ATTEMPTS}"

            set +e
            docker buildx build --builder "$BUILDX_BUILDER" --progress=plain --platform "$DOCKER_BUILD_PLATFORMS" \
                -f "$DOCKERFILE" \
                $BUILD_ARGS \
                --label "org.opencontainers.image.revision=${SOURCE_REVISION}" \
                --label "org.opencontainers.image.version=${BUILD_NUMBER}" \
                -t "$IMAGE_TAG" \
                -t "$IMAGE_LATEST" \
                --push \
                "$BUILD_CONTEXT" 2>&1 | sed -u "s/^/[$IMAGE_NAME] /" | tee "$ATTEMPT_LOG"
            EXIT_CODE=${PIPESTATUS[0]}
            set -e

            if [ "$EXIT_CODE" -eq 0 ]; then
                break
            fi

            if is_local_disk_build_failure "$ATTEMPT_LOG"; then
                echo "[$IMAGE_NAME] Local disk exhaustion detected; this is not a remote network failure."
                check_docker_build_disk_space "BuildKit retry" || true
                break
            fi

            if is_non_retryable_build_failure "$ATTEMPT_LOG"; then
                break
            fi

            if is_buildkit_control_plane_failure "$ATTEMPT_LOG"; then
                echo "[$IMAGE_NAME] BuildKit control-plane disconnect detected; checking local disk, Docker, and builder health..."
                if [ "$ATTEMPT" -ge "$DOCKER_BUILD_MAX_ATTEMPTS" ]; then
                    echo "[$IMAGE_NAME] Build attempt budget exhausted; not retrying the recovered control plane."
                    break
                fi
                if ! docker_build_runtime_is_healthy; then
                    echo "[$IMAGE_NAME] Local build runtime did not recover; not retrying."
                    break
                fi
                echo "[$IMAGE_NAME] Local BuildKit control plane recovered; retrying in ${DOCKER_BUILD_RETRY_DELAY_SECONDS}s without clearing caches..."
            elif is_retryable_network_build_failure "$ATTEMPT_LOG"; then
                if [ "$ATTEMPT" -ge "$DOCKER_BUILD_MAX_ATTEMPTS" ]; then
                    break
                fi
                if ! check_docker_build_disk_space "network build retry"; then
                    echo "[$IMAGE_NAME] Network retry blocked by insufficient local disk headroom."
                    break
                fi
                echo "[$IMAGE_NAME] Transient network failure detected; retrying in ${DOCKER_BUILD_RETRY_DELAY_SECONDS}s without clearing BuildKit caches..."
            else
                break
            fi

            sleep "$DOCKER_BUILD_RETRY_DELAY_SECONDS"
            ATTEMPT=$((ATTEMPT + 1))
        done

        if [ "$EXIT_CODE" -eq 0 ]; then
            if ! verify_multiarch_manifest "$IMAGE_TAG" "$IMAGE_NAME"; then
                EXIT_CODE=1
            fi
            if ! verify_multiarch_manifest "$IMAGE_LATEST" "$IMAGE_NAME"; then
                EXIT_CODE=1
            fi
        fi

        echo ""
        if [ "$EXIT_CODE" -eq 0 ]; then
            echo "[$IMAGE_NAME] ✅ BUILD COMPLETED SUCCESSFULLY at $(date '+%H:%M:%S')"
        else
            echo "[$IMAGE_NAME] ❌ BUILD FAILED with exit code $EXIT_CODE at $(date '+%H:%M:%S')"
        fi
        echo "══════════════════════════════════════════════════════════════"
        exit "$EXIT_CODE"
    } >> "$LOG_FILE" 2>&1
}

get_build_context() {
    local dockerfile="$1"

    if [[ "$dockerfile" == electron-app/* ]]; then
        printf 'electron-app\n'
    else
        printf '.\n'
    fi
}

append_build_metadata() {
    local image_name="$1"
    local image_tag="$2"
    local image_latest="$3"

    ALL_BUILD_NAMES="$ALL_BUILD_NAMES $image_name"
    ALL_BUILD_TAGS="$ALL_BUILD_TAGS $image_tag"
    ALL_BUILD_LATEST="$ALL_BUILD_LATEST $image_latest"
}

run_build_batch() {
    local image_pairs="$1"
    local batch_names=()
    local batch_dockerfiles=()
    local batch_tags=()
    local batch_latest=()
    local batch_contexts=()
    local batch_logs=()
    local batch_pids=()
    local batch_count=0
    local tail_pid=""
    local batch_failed=false
    local image_pair=""
    local image_name=""
    local dockerfile=""
    local image_tag=""
    local image_latest=""
    local build_context=""
    local log_file=""
    local exit_code=0

    [ -n "${image_pairs// }" ] || return 0

    if ! check_docker_build_disk_space "Docker build batch"; then
        exit 1
    fi

    for image_pair in $image_pairs; do
        image_name="${image_pair%%:*}"
        dockerfile="${image_pair##*:}"
        image_tag="${HARBOR_REGISTRY}/${HARBOR_PROJECT}/${image_name}:${BUILD_NUMBER}"
        image_latest="${HARBOR_REGISTRY}/${HARBOR_PROJECT}/${image_name}:latest"
        build_context="$(get_build_context "$dockerfile")"
        log_file="$BUILD_TEMP_DIR/${image_name}.log"

        : > "$log_file"

        batch_names+=("$image_name")
        batch_dockerfiles+=("$dockerfile")
        batch_tags+=("$image_tag")
        batch_latest+=("$image_latest")
        batch_contexts+=("$build_context")
        batch_logs+=("$log_file")

        append_build_metadata "$image_name" "$image_tag" "$image_latest"
    done

    batch_count=${#batch_names[@]}
    [ "$batch_count" -gt 0 ] || return 0

    echo
    log "⏳ Running build batch (${batch_count} image(s)) with live output..."
    echo

    tail -n +1 -f "${batch_logs[@]}" 2>/dev/null &
    tail_pid=$!

    for i in $(seq 0 $((batch_count - 1))); do
        log "🔨 Starting build: ${batch_names[$i]} (background)"
        log "   📄 Dockerfile: ${batch_dockerfiles[$i]}"
        log "   📁 Context: ${batch_contexts[$i]}"
        log "   📝 Log: ${batch_logs[$i]}"

        build_image \
            "${batch_names[$i]}" \
            "${batch_dockerfiles[$i]}" \
            "${batch_tags[$i]}" \
            "${batch_latest[$i]}" \
            "${batch_contexts[$i]}" \
            "${batch_logs[$i]}" &
        batch_pids+=("$!")
    done

    for i in $(seq 0 $((batch_count - 1))); do
        exit_code=0
        wait "${batch_pids[$i]}" || exit_code=$?

        if [ "$exit_code" -eq 0 ]; then
            success "✅ ${batch_names[$i]} build completed"
        else
            error "❌ ${batch_names[$i]} build failed (exit code: $exit_code)"
            FAILED_BUILDS="$FAILED_BUILDS ${batch_names[$i]}"
            BUILD_FAILED=true
            batch_failed=true

            if [ -f "${batch_logs[$i]}" ]; then
                echo
                error "Last 20 lines of ${batch_names[$i]} build log:"
                tail -20 "${batch_logs[$i]}"
                echo
            fi
        fi
    done

    kill "$tail_pid" 2>/dev/null || true
    wait "$tail_pid" 2>/dev/null || true

    if [ "$batch_failed" = true ]; then
        return 1
    fi

    return 0
}

run_build_batches() {
    local image_pairs="$1"
    local batch_size="$2"
    local current_batch=""
    local current_count=0
    local image_pair=""

    [ -n "${image_pairs// }" ] || return 0

    for image_pair in $image_pairs; do
        current_batch="$current_batch $image_pair"
        current_count=$((current_count + 1))

        if [ "$current_count" -ge "$batch_size" ]; then
            run_build_batch "$current_batch" || return 1
            current_batch=""
            current_count=0
        fi
    done

    if [ -n "${current_batch// }" ]; then
        run_build_batch "$current_batch" || return 1
    fi

    return 0
}

if [ "$ELECTRON_ONLY" = true ]; then
    run_build_batches "$IMAGES" "$MAX_PARALLEL_BUILDS" || true
else
    if [ "$SERIALIZE_MCP_RUNTIME_IMAGES" = "true" ]; then
        log "🚦 Building MCP runtime images serially to reduce buildx resource pressure..."
        run_build_batches "$MCP_RUNTIME_IMAGES" 1 || true
    else
        run_build_batches "$MCP_RUNTIME_IMAGES" "$MAX_PARALLEL_BUILDS" || true
    fi

    if [ -z "$FAILED_BUILDS" ]; then
        run_build_batches "$LLM_GATEWAY_IMAGES $APP_SERVICE_IMAGES" "$MAX_PARALLEL_BUILDS" || true
    fi
fi

if [ -n "$FAILED_BUILDS" ]; then
    echo
    error "Failed builds:$FAILED_BUILDS"
    error "Build logs preserved at: $BUILD_TEMP_DIR/"
    exit 1
fi

BUILD_NAMES_ARRAY=($ALL_BUILD_NAMES)
BUILD_TAGS_ARRAY=($ALL_BUILD_TAGS)
BUILD_LATEST_ARRAY=($ALL_BUILD_LATEST)
BUILD_COUNT=${#BUILD_NAMES_ARRAY[@]}

echo
success "🎉 All builds completed successfully!"
echo

fi  # End of build section (if RETAG_ONLY = false)

# Buildx --push / imagetools create already published images.
IMAGE_SIZE_SUMMARY=""
for i in $(seq 0 $((BUILD_COUNT - 1))); do
    NAME=${BUILD_NAMES_ARRAY[$i]}
    TAG=${BUILD_TAGS_ARRAY[$i]}
    LATEST=${BUILD_LATEST_ARRAY[$i]}
    PUSHED_IMAGES="${PUSHED_IMAGES}  • ${TAG}\n  • ${LATEST}\n"

    if REPORT="$(get_multiarch_image_size_report "$TAG")"; then
        IMAGE_SIZE_SUMMARY="${IMAGE_SIZE_SUMMARY}$(format_image_size_summary "$TAG" "$REPORT")"
        IMAGE_SIZE_SUMMARY="${IMAGE_SIZE_SUMMARY}    ${LATEST} -> same manifest\n"
    else
        warn "[$NAME] Unable to determine pushed image size for $TAG"
        IMAGE_SIZE_SUMMARY="${IMAGE_SIZE_SUMMARY}  • ${TAG} -> size unavailable\n"
        IMAGE_SIZE_SUMMARY="${IMAGE_SIZE_SUMMARY}    ${LATEST} -> size unavailable\n"
    fi
done

echo
echo -e "${GREEN}========================================${NC}"
if [ "$RETAG_ONLY" = true ]; then
    echo -e "${GREEN}  ✅ All images retagged and published!${NC}"
    echo -e "${GREEN}  Source: ${SOURCE_TAG}${NC}"
    echo -e "${GREEN}  Target: ${TARGET_TAG}${NC}"
elif [ "$ELECTRON_ONLY" = true ]; then
    echo -e "${GREEN}  ✅ Electron builder image built and published!${NC}"
else
    echo -e "${GREEN}  ✅ All images built and published!${NC}"
fi
echo -e "${GREEN}========================================${NC}"
echo
echo -e "${CYAN}Images published:${NC}"
echo -e "${PUSHED_IMAGES}"
echo -e "${CYAN}Published image sizes:${NC}"
echo -e "${IMAGE_SIZE_SUMMARY}"
if [ "$RETAG_ONLY" = true ]; then
    echo -e "${CYAN}Retagged images are now available in Harbor${NC}"
    echo -e "${CYAN}Users can now pull these images with:${NC}"
    echo -e "  ${YELLOW}./install_v2.sh${NC}"
elif [ "$ELECTRON_ONLY" = true ]; then
    echo -e "${CYAN}Electron builder is now available in Harbor${NC}"
    echo -e "${CYAN}src/scripts/build-with-docker.sh will automatically use it${NC}"
else
    echo -e "${CYAN}Users can now pull these images with:${NC}"
    echo -e "  ${YELLOW}./install_v2.sh${NC}"
fi
echo
