#!/usr/bin/env bash

set -euo pipefail

if [[ "${BASH_SOURCE[0]:-$0}" == "$0" ]] \
    && [ "${PACKAGE_FOR_RELEASE_IMMUTABLE_RUNNER:-false}" != "true" ]; then
    _package_runner_prefix="portico-package-runner"
    _package_runner_marker=".portico-package-runner"
    _package_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
    _package_script_path="${_package_script_dir}/$(basename "${BASH_SOURCE[0]}")"
    _package_runner_dir=""
    _package_snapshot_path=""

    _cleanup_package_runner() {
        local runner_basename=""

        [ -n "${_package_runner_dir:-}" ] || return 0
        [ -d "$_package_runner_dir" ] || return 0
        runner_basename="$(basename "$_package_runner_dir")"
        case "$runner_basename" in
            "${_package_runner_prefix}."*)
                [ -f "$_package_runner_dir/$_package_runner_marker" ] || return 0
                rm -rf "$_package_runner_dir"
                ;;
        esac
    }

    _package_snapshot_hash() {
        if command -v shasum >/dev/null 2>&1; then
            shasum -a 256 "$1" | awk '{print $1}'
        elif command -v sha256sum >/dev/null 2>&1; then
            sha256sum "$1" | awk '{print $1}'
        else
            printf '%s\n' "Error: shasum or sha256sum is required to create an immutable packaging runner" >&2
            return 1
        fi
    }

    _package_runner_dir="$(mktemp -d "${TMPDIR:-/tmp}/${_package_runner_prefix}.XXXXXX")"
    : > "$_package_runner_dir/$_package_runner_marker"
    _package_snapshot_path="$_package_runner_dir/package_for_release.sh"
    trap _cleanup_package_runner EXIT

    _package_snapshot_ready=false
    _package_snapshot_attempt=1
    while [ "$_package_snapshot_attempt" -le 2 ]; do
        _package_source_hash_before="$(_package_snapshot_hash "$_package_script_path")"
        cp -p "$_package_script_path" "$_package_snapshot_path"

        if [ -n "${PACKAGE_FOR_RELEASE_TEST_SNAPSHOT_READY_FILE:-}" ]; then
            printf '%s\n' "$_package_snapshot_attempt" > "$PACKAGE_FOR_RELEASE_TEST_SNAPSHOT_READY_FILE"
            if [ -n "${PACKAGE_FOR_RELEASE_TEST_SNAPSHOT_CONTINUE_FILE:-}" ]; then
                while [ ! -e "${PACKAGE_FOR_RELEASE_TEST_SNAPSHOT_CONTINUE_FILE}.${_package_snapshot_attempt}" ]; do
                    sleep 0.05
                done
            fi
        fi

        _package_source_hash_after="$(_package_snapshot_hash "$_package_script_path")"
        _package_snapshot_hash_value="$(_package_snapshot_hash "$_package_snapshot_path")"
        if [ "$_package_source_hash_before" = "$_package_source_hash_after" ] \
            && [ "$_package_source_hash_after" = "$_package_snapshot_hash_value" ]; then
            if ! bash -n "$_package_snapshot_path"; then
                printf '%s\n' "Error: immutable package runner failed Bash syntax validation; the repository script was not executed" >&2
                exit 1
            fi
            _package_snapshot_hash_after_syntax="$(_package_snapshot_hash "$_package_snapshot_path")"
            if [ "$_package_snapshot_hash_after_syntax" != "$_package_snapshot_hash_value" ]; then
                printf '%s\n' "Error: immutable package runner changed during syntax validation; the repository script was not executed" >&2
                exit 1
            fi
            _package_snapshot_ready=true
            break
        fi

        printf '%s\n' "Warning: package_for_release.sh changed while its immutable runner was being copied; retrying snapshot creation" >&2
        _package_snapshot_attempt=$((_package_snapshot_attempt + 1))
    done

    if [ "$_package_snapshot_ready" != "true" ]; then
        printf '%s\n' "Error: package_for_release.sh remained unstable while creating its immutable runner; no packaging work was started" >&2
        exit 1
    fi

    if [ -n "${PACKAGE_FOR_RELEASE_TEST_RUNNER_READY_FILE:-}" ]; then
        : > "$PACKAGE_FOR_RELEASE_TEST_RUNNER_READY_FILE"
        if [ -n "${PACKAGE_FOR_RELEASE_TEST_RUNNER_CONTINUE_FILE:-}" ]; then
            while [ ! -e "$PACKAGE_FOR_RELEASE_TEST_RUNNER_CONTINUE_FILE" ]; do
                sleep 0.05
            done
        fi
    fi

    set +e
    PACKAGE_FOR_RELEASE_IMMUTABLE_RUNNER=true \
    PACKAGE_FOR_RELEASE_ORIGINAL_SCRIPT_DIR="$_package_script_dir" \
    PACKAGE_FOR_RELEASE_ORIGINAL_SCRIPT_PATH="$_package_script_path" \
        bash "$_package_snapshot_path" "$@"
    _package_child_status=$?
    set -e
    exit "$_package_child_status"
fi

SCRIPT_DIR="${PACKAGE_FOR_RELEASE_ORIGINAL_SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
DEFAULT_OUTPUT_DIR="$SCRIPT_DIR/release"
APP_PRODUCT_NAME="Portico"
APP_BUNDLE_NAME="${APP_PRODUCT_NAME}.app"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

CHANNEL="beta"
BUILD_ID=""
FULL_SHA=""
DOCKER_IMAGE_TAG=""
RELEASE_TIMESTAMP=""
MANAGED_ROOT_SOURCE="$SCRIPT_DIR"
ARTIFACT_SEARCH_ROOT=""
OUTPUT_ZIP=""
HOST_MCP_BINARIES_DIR=""
HOST_MCP_SOURCE_REVISION=""
RUNTIME_IMAGE_ATTESTATION=""
UNSIGNED_PREVIEW_ARCH=""
PREVIEW_OUTPUT_DIR=""
MR_STAGE_OUTPUT_DIR=""
MR_PROJECT_ID=""
MR_PROJECT_PATH=""
MR_IID=""
MR_TARGET_BRANCH=""
APP_ARM64=""
APP_X64=""
DMG_ARM64=""
DMG_X64=""
APP_ARM64_EXPLICIT=false
APP_X64_EXPLICIT=false
DMG_ARM64_EXPLICIT=false
DMG_X64_EXPLICIT=false
ARM64_ARTIFACT_FORCE_REBUILD=false
X64_ARTIFACT_FORCE_REBUILD=false
SKIP_DOCKER_IMAGES="${PACKAGE_FOR_RELEASE_SKIP_DOCKER_IMAGES:-false}"
FORCE_DOCKER_IMAGES=false
KEEP_TEMP_ON_FAILURE="${PACKAGE_FOR_RELEASE_KEEP_TEMP_ON_FAILURE:-true}"
PACKAGE_MIN_FREE_GB="${PACKAGE_FOR_RELEASE_MIN_FREE_GB:-10}"
PACKAGE_CACHE_DIR="${PACKAGE_FOR_RELEASE_CACHE_DIR:-$SCRIPT_DIR/release/.package-cache}"
PACKAGE_CACHE_MARKER=".portico-package-cache"
HOST_MCP_DOCKER_TIMEOUT_SECONDS="${HOST_MCP_DOCKER_TIMEOUT_SECONDS:-600}"
RELEASE_STAGING_PREFIX="portico-release-stage"
RELEASE_STAGING_MARKER=".portico-release-staging"
RELEASE_PAYLOAD_VALIDATOR_RELATIVE="src/scripts/validate-release-payload.py"
RUNTIME_IMAGE_ATTESTATION_VALIDATOR_RELATIVE="src/scripts/validate-runtime-image-attestation.js"
MR_RELEASE_INPUT_HELPER_RELATIVE="src/scripts/ci/mr-release-input.py"
MACOS_DITTO_BIN="${PACKAGE_FOR_RELEASE_DITTO_BIN:-/usr/bin/ditto}"
HOST_MCP_BINARY_POLICY_SH="$SCRIPT_DIR/src/scripts/host-mcp-binary-policy.sh"
RUNTIME_SECRETS_SH="$SCRIPT_DIR/src/scripts/runtime-secrets.sh"
RELEASE_CHANNEL_SH="$SCRIPT_DIR/src/scripts/release-channel.sh"

TEMP_DIR=""
SOURCE_STAGE_DIR=""
PAYLOAD_STAGE_DIR=""
PARTIAL_OUTPUT_ZIP=""
HOST_MCP_SOURCE_DIR=""
CHANNEL_PACKAGE_NAME=""
NPM_DEPS_READY=false
MAC_BUILD_ENV_READY=false
ACCEPT_SUGGESTED_BUILD_ID=false
BUILD_STARTED_AT_EPOCH="$(date +%s)"
DID_BUILD_DOCKER_IMAGES=false
DOCKER_IMAGES_BUILT=""
DOCKER_IMAGES_REUSED=""
PACKAGE_SOURCE_CLEAN=false
PACKAGE_CACHE_INITIALIZED=false
HOST_MCP_CACHE_ARTIFACTS_ROOT=""
HOST_MCP_CACHE_CARGO_TARGET_DIR=""
MACOS_ARTIFACT_CACHE_ROOT=""
PACKAGE_METADATA_CACHE_PATH=""
SOURCE_CHECKOUT_STATE_AFTER_STAGING=""
SOURCE_CHECKOUT_IS_GIT=false
PAYLOAD_CREATED=false
HOST_MCP_PROVENANCE="packaged from host-mcp-binaries payload input"
ARM64_ARTIFACT_PROVENANCE="reused existing arm64 macOS artifacts"
X64_ARTIFACT_PROVENANCE="reused existing x64 macOS artifacts"

if [ ! -f "$HOST_MCP_BINARY_POLICY_SH" ]; then
    echo "Error: Missing host MCP binary policy helper: $HOST_MCP_BINARY_POLICY_SH" >&2
    exit 1
fi
# shellcheck source=/dev/null
. "$HOST_MCP_BINARY_POLICY_SH"

if [ ! -f "$RUNTIME_SECRETS_SH" ]; then
    echo "Error: Missing runtime secrets helper: $RUNTIME_SECRETS_SH" >&2
    exit 1
fi
# shellcheck source=/dev/null
. "$RUNTIME_SECRETS_SH"

if [ ! -f "$RELEASE_CHANNEL_SH" ]; then
    echo "Error: Missing release channel helper: $RELEASE_CHANNEL_SH" >&2
    exit 1
fi
# shellcheck source=/dev/null
. "$RELEASE_CHANNEL_SH"

log() {
    echo -e "${BLUE}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} $1"
}

success() {
    echo -e "${GREEN}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} $1"
}

die() {
    case "${PACKAGE_FOR_RELEASE_PLAIN_ERRORS:-false}" in
        true|TRUE|1|yes|YES)
            printf '%s\n' "$1" >&2
            exit 1
            ;;
    esac
    echo -e "${RED}[$(date '+%Y-%m-%d %H:%M:%S')] Error: $1${NC}" >&2
    exit 1
}

resolve_cloudsmith_release_entitlement_token() {
    local source_env_path="$MANAGED_ROOT_SOURCE/cloudsmith.env"
    local resolved_token=""
    local resolution_status=0

    if resolved_token="$(resolve_packaged_cloudsmith_entitlement_token "$source_env_path")"; then
        export CLOUDSMITH_ENTITLEMENT_TOKEN="$resolved_token"
        log "Resolved Cloudsmith entitlement token for packaged build"
        return 0
    else
        resolution_status=$?
    fi

    if [ "$resolution_status" -eq 2 ]; then
        die "CLOUDSMITH_ENTITLEMENT_TOKEN could not be resolved because macOS Keychain access failed"
    fi
    die "CLOUDSMITH_ENTITLEMENT_TOKEN is required. Export it, configure it in $source_env_path, or store it in the release operator's macOS Keychain. CI and non-macOS builds must provide it explicitly."
}

resolve_cloudsmith_release_api_key() {
    local source_env_path="$MANAGED_ROOT_SOURCE/cloudsmith.env"
    local resolved_api_key=""

    resolved_api_key="$(printf '%s' "${CLOUDSMITH_API_KEY:-}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    if [ -z "$resolved_api_key" ]; then
        resolved_api_key="$(read_env_value_from_file "$source_env_path" "CLOUDSMITH_API_KEY" 2>/dev/null || true)"
        resolved_api_key="$(printf '%s' "$resolved_api_key" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    fi

    [ -n "$resolved_api_key" ] \
        || die "CLOUDSMITH_API_KEY is required for packaged update discovery. Export it or configure it in $source_env_path."

    export CLOUDSMITH_API_KEY="$resolved_api_key"
    log "Resolved Cloudsmith API key for packaged update discovery"
}

show_usage() {
    cat <<'EOF'
Usage: ./package_for_release.sh [build-id] [options]

Create a release payload zip with the signed macOS app artifacts, DMGs,
managed runtime tree, host-mcp-binaries, and release-manifest.json.

Options:
  --channel <name>               Release channel: stable, beta, dev, or a custom slug (default: beta)
  --beta                         Shortcut for --channel beta
  --stable                       Shortcut for --channel stable
  --dev                          Shortcut for --channel dev
  --full-sha <sha>               Full git SHA for release metadata
  --docker-image-tag <tag>       Docker image tag for release-manifest.json
  --release-timestamp <utc>      Fixed UTC build-info timestamp for reproducible CI jobs
  --managed-root-source <dir>    Source tree for managed-root/ (default: repo root)
  --artifact-search-root <dir>   Search here for already-built mac artifacts first
  --host-mcp-binaries-dir <dir>  Reuse an existing host-mcp-binaries tree
  --host-mcp-source-revision <sha>
                                 Require a complete revision-marked host tree and do not rebuild it
  --image-attestation <path>     Reuse the seven validated immutable runtime image indexes
  --unsigned-preview <arch>      Build an unsigned arm64 or x64 MR preview only
  --preview-output-dir <dir>     Output directory for the unsigned app ZIP and DMG
  --unsigned-mr-stage <dir>      Build both unsigned apps and credential-free MR inputs
  --mr-project-id <id>           GitLab source project numeric id for MR staging
  --mr-project-path <path>       GitLab source project namespace/path for MR staging
  --mr-iid <iid>                 GitLab project-scoped MR number for MR staging
  --mr-target-branch <name>      GitLab target branch for MR staging
  --app-arm64 <path>             Prebuilt arm64 .app bundle
  --app-x64 <path>               Prebuilt x64 .app bundle
  --dmg-arm64 <path>             Prebuilt arm64 DMG
  --dmg-x64 <path>               Prebuilt x64 DMG
  --output-zip <path>            Output zip path; basename must match channel package naming
  --force-docker-images          Rebuild every runtime image even when the exact tag is valid
  --yes                          Auto-accept the suggested build id when omitted
  --help, -h                     Show this help text

Notes:
  - The payload zip basename is always <channel-package-name>-<build-id>.zip.
  - Runtime/service Docker images are built and published for dockerImageTag unless
    valid exact-tag multi-arch images can be reused. Set --force-docker-images to
    rebuild all images, or PACKAGE_FOR_RELEASE_SKIP_DOCKER_IMAGES=true to validate
    existing images without publishing anything.
  - The newest release-owned staged temp tree is preserved by default on failure for
    debugging. Older marked staging trees are removed when a new one is created.
    Set PACKAGE_FOR_RELEASE_KEEP_TEMP_ON_FAILURE=false to clean the current tree too.
  - Packaging requires 10 GiB free by default. Override the positive integer threshold
    with PACKAGE_FOR_RELEASE_MIN_FREE_GB.
  - Reusable package artifacts are cached under release/.package-cache. Override that
    location with PACKAGE_FOR_RELEASE_CACHE_DIR.
  - Host MCP Docker extraction operations time out after 600 seconds by default. Override
    the positive integer timeout with HOST_MCP_DOCKER_TIMEOUT_SECONDS.
  - On macOS, missing app/DMG artifacts are built, signed, notarized, and stapled.
  - On non-macOS hosts, all four mac artifacts must be supplied explicitly.
  - CI-only reuse remains fail closed: --host-mcp-source-revision must match
    --full-sha, and --image-attestation must match both that SHA and the image tag.
  - --unsigned-preview never reads release credentials. It embeds deterministic,
    nonfunctional updater placeholders and disables signing identity discovery.
  - --unsigned-mr-stage has the same credential-free contract, builds both app
    architectures, and emits mr-release-input.json for the protected broker.
EOF
}

cleanup() {
    local exit_code=$?

    if [ -n "$PARTIAL_OUTPUT_ZIP" ] && [ -f "$PARTIAL_OUTPUT_ZIP" ]; then
        rm -f "$PARTIAL_OUTPUT_ZIP"
    fi

    case "$KEEP_TEMP_ON_FAILURE" in
        true|TRUE|1|yes|YES)
            if [ "$exit_code" -ne 0 ] && [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
                if [ "$PAYLOAD_CREATED" = true ]; then
                    echo -e "${RED}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} Packaging failed after creating a validated payload." >&2
                    echo -e "${YELLOW}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} Valid payload remains available: $OUTPUT_ZIP" >&2
                else
                    echo -e "${RED}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} Packaging failed before payload creation." >&2
                fi
                echo -e "${YELLOW}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} Preserved temp staging directory: $TEMP_DIR" >&2
                return "$exit_code"
            fi
            ;;
    esac

    if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
        rm -rf "$TEMP_DIR"
    fi

    return "$exit_code"
}

trap cleanup EXIT

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

release_payload_validator_path() {
    if [ -n "$SOURCE_STAGE_DIR" ] && [ -f "$SOURCE_STAGE_DIR/$RELEASE_PAYLOAD_VALIDATOR_RELATIVE" ]; then
        printf '%s\n' "$SOURCE_STAGE_DIR/$RELEASE_PAYLOAD_VALIDATOR_RELATIVE"
    else
        printf '%s\n' "$SCRIPT_DIR/$RELEASE_PAYLOAD_VALIDATOR_RELATIVE"
    fi
}

runtime_image_attestation_validator_path() {
    if [ -n "$SOURCE_STAGE_DIR" ] \
        && [ -f "$SOURCE_STAGE_DIR/$RUNTIME_IMAGE_ATTESTATION_VALIDATOR_RELATIVE" ]; then
        printf '%s\n' "$SOURCE_STAGE_DIR/$RUNTIME_IMAGE_ATTESTATION_VALIDATOR_RELATIVE"
    else
        printf '%s\n' "$SCRIPT_DIR/$RUNTIME_IMAGE_ATTESTATION_VALIDATOR_RELATIVE"
    fi
}

validate_runtime_image_attestation_path() {
    local attestation_path="$1"
    local validator

    validator="$(runtime_image_attestation_validator_path)"
    [ -f "$validator" ] || die "Runtime image attestation validator not found: $validator"
    require_command node
    node "$validator" \
        --attestation "$attestation_path" \
        --expected-source-revision "$FULL_SHA" \
        --expected-tag "$DOCKER_IMAGE_TAG" \
        --quiet \
        || die "Runtime image attestation validation failed: $attestation_path"
}

validate_release_payload_path() {
    local payload_path="$1"
    local verify_macos="${2:-false}"
    local expected_filename="${3:-}"
    local validator_path=""
    local validator_args=()

    require_command python3
    validator_path="$(release_payload_validator_path)"
    [ -f "$validator_path" ] || die "Release payload validator not found: $validator_path"

    validator_args=(
        --payload "$payload_path"
        --expected-build-id "$BUILD_ID"
        --expected-channel-package "$CHANNEL_PACKAGE_NAME"
    )
    if [ -n "$expected_filename" ]; then
        validator_args+=(--expected-filename "$expected_filename")
    fi
    if [ "$verify_macos" = true ]; then
        validator_args+=(--verify-macos)
    fi

    python3 "$validator_path" "${validator_args[@]}"
}

validate_positive_integer() {
    local variable_name="$1"
    local value="$2"

    if ! [[ "$value" =~ ^[0-9]+$ ]] || [ "$value" -lt 1 ]; then
        die "${variable_name} must be a positive integer (got: ${value:-empty})"
    fi
}

validate_release_timestamp() {
    local timestamp="$1"

    [ -z "$timestamp" ] && return 0
    [[ "$timestamp" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$ ]] \
        || die "--release-timestamp must be a UTC RFC3339 timestamp ending in Z"
}

available_disk_kib() {
    local target_path="$1"

    df -Pk "$target_path" 2>/dev/null | awk 'NR == 2 { print $4; exit }'
}

require_packaging_disk_space() {
    local target_path="$1"
    local operation="$2"
    local available_kib=""
    local required_kib=$((PACKAGE_MIN_FREE_GB * 1024 * 1024))

    available_kib="$(available_disk_kib "$target_path" || true)"
    if ! [[ "$available_kib" =~ ^[0-9]+$ ]]; then
        die "Unable to determine free disk space for ${operation} at ${target_path}"
    fi

    if [ "$available_kib" -lt "$required_kib" ]; then
        die "Insufficient local disk space for ${operation}: $(format_bytes_human $((available_kib * 1024))) available at ${target_path}; $(format_bytes_human $((required_kib * 1024))) required. This is a local disk capacity failure, not a remote network failure. Remove old release outputs or release-owned staging trees before retrying."
    fi

    log "Disk preflight for ${operation}: $(format_bytes_human $((available_kib * 1024))) available (minimum $(format_bytes_human $((required_kib * 1024))))"
}

preflight_release_packaging_disk_space() {
    local temp_root="${TMPDIR:-/tmp}"
    local output_parent="$(dirname "$OUTPUT_ZIP")"

    require_packaging_disk_space "$temp_root" "release staging"
    if [ "$output_parent" != "$temp_root" ]; then
        require_packaging_disk_space "$output_parent" "release output"
    fi
}

prune_older_release_staging_dirs() {
    local current_dir="$1"
    local staging_root="$(dirname "$current_dir")"
    local candidate=""

    for candidate in "$staging_root"/${RELEASE_STAGING_PREFIX}.*; do
        [ -d "$candidate" ] || continue
        [ "$candidate" != "$current_dir" ] || continue
        [ -f "$candidate/$RELEASE_STAGING_MARKER" ] || continue
        warn "Removing older release-owned staging tree: $candidate"
        rm -rf "$candidate"
    done
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

path_size_bytes() {
    local target="$1"

    [ -e "$target" ] || return 1

    if [ -d "$target" ]; then
        du -sk "$target" | awk '{print $1 * 1024}'
        return 0
    fi

    if stat -f %z "$target" >/dev/null 2>&1; then
        stat -f %z "$target"
        return 0
    fi

    stat -c %s "$target"
}

path_size_human() {
    local target="$1"
    local bytes

    bytes="$(path_size_bytes "$target")" || return 1
    format_bytes_human "$bytes"
}

format_duration() {
    local total_seconds="$1"
    local hours=0
    local minutes=0
    local seconds=0

    hours=$((total_seconds / 3600))
    minutes=$(((total_seconds % 3600) / 60))
    seconds=$((total_seconds % 60))

    if [ "$hours" -gt 0 ]; then
        printf '%dh %dm %ds\n' "$hours" "$minutes" "$seconds"
    elif [ "$minutes" -gt 0 ]; then
        printf '%dm %ds\n' "$minutes" "$seconds"
    else
        printf '%ds\n' "$seconds"
    fi
}

sum_byte_values() {
    awk '{total += $1} END {printf "%.0f\n", total + 0}'
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

    printf '%s -> %s total' "$image_ref" "$(format_bytes_human "$total_bytes")"
    if [ -n "$detail_summary" ]; then
        printf ' (%s)' "$detail_summary"
    fi
    printf '\n'
}

release_image_names() {
    printf '%s\n' \
        "mcpo-control-plane-rust mcp-orc-rust bifrost-bridge open-webui-patched health-check chat-state-api agent-vm"
}

is_truthy() {
    case "${1:-}" in
        true|TRUE|1|yes|YES) return 0 ;;
        *) return 1 ;;
    esac
}

validate_docker_image_mode() {
    if is_truthy "$SKIP_DOCKER_IMAGES" && [ "$FORCE_DOCKER_IMAGES" = true ]; then
        die "--force-docker-images cannot be combined with PACKAGE_FOR_RELEASE_SKIP_DOCKER_IMAGES=true"
    fi
    if [ -n "$RUNTIME_IMAGE_ATTESTATION" ] && [ "$FORCE_DOCKER_IMAGES" = true ]; then
        die "--force-docker-images cannot be combined with --image-attestation"
    fi
}

append_image_name() {
    local current="$1"
    local image_name="$2"

    if [ -n "$current" ]; then
        printf '%s %s\n' "$current" "$image_name"
    else
        printf '%s\n' "$image_name"
    fi
}

image_names_to_csv() {
    printf '%s\n' "$1" | tr ' ' ','
}

release_image_ref() {
    printf 'harbor.example.invalid/portico/%s:%s\n' "$1" "$DOCKER_IMAGE_TAG"
}

release_source_tree_is_clean() {
    local head_sha=""

    git -C "$MANAGED_ROOT_SOURCE" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 1
    head_sha="$(git_head_full_sha "$MANAGED_ROOT_SOURCE" || true)"
    [ -n "$head_sha" ] && [ "$head_sha" = "$FULL_SHA" ] || return 1
    [ -z "$(
        git -C "$MANAGED_ROOT_SOURCE" status --porcelain --untracked-files=all \
            -- . ':(exclude).report-build' 2>/dev/null
    )" ]
}

validate_release_image_metadata_json() {
    local metadata_json="$1"
    local expected_revision="$2"
    local expected_tag="$3"

    printf '%s' "$metadata_json" | node -e '
const fs = require("fs");
const expectedRevision = String(process.argv[1] || "").toLowerCase();
const expectedTag = String(process.argv[2] || "");
let images;
try {
  images = JSON.parse(fs.readFileSync(0, "utf8"));
} catch (error) {
  console.error(`invalid image metadata JSON: ${error.message}`);
  process.exit(2);
}

const platformLabels = [];
for (const platform of ["linux/amd64", "linux/arm64"]) {
  const image = images && images[platform];
  if (!image) {
    console.error(`missing required platform ${platform}`);
    process.exit(3);
  }

  const labels = (image.config && image.config.Labels) || {};
  const revision = String(labels["org.opencontainers.image.revision"] || "").toLowerCase();
  const version = String(labels["org.opencontainers.image.version"] || "");
  platformLabels.push({ platform, revision, version });

  if (revision && revision !== expectedRevision) {
    console.error(`${platform} revision label ${revision} does not match ${expectedRevision}`);
    process.exit(4);
  }
  if (version && version !== expectedTag) {
    console.error(`${platform} version label ${version} does not match ${expectedTag}`);
    process.exit(5);
  }
}

const hasAnyReleaseLabel = platformLabels.some(({ revision, version }) => revision || version);
if (!hasAnyReleaseLabel) {
  process.stdout.write("legacy");
  process.exit(0);
}

for (const { platform, revision, version } of platformLabels) {
  if (!revision || !version) {
    console.error(`${platform} has incomplete release provenance labels`);
    process.exit(6);
  }
}

process.stdout.write("labeled");
' "$expected_revision" "$expected_tag"
}

validate_published_release_image_ref() {
    local image_name="$1"
    local image_ref="$2"
    local metadata_json=""
    local validation_result=""

    metadata_json="$(docker buildx imagetools inspect --format '{{json .Image}}' "$image_ref" 2>/dev/null)" || {
        warn "Published image is unavailable: $image_ref"
        return 1
    }

    if ! validation_result="$(validate_release_image_metadata_json "$metadata_json" "$FULL_SHA" "$DOCKER_IMAGE_TAG" 2>&1)"; then
        warn "Published image is invalid: $image_ref (${validation_result})"
        return 1
    fi

    if [ "$validation_result" = "legacy" ]; then
        warn "Published image has no complete release provenance labels; accepting legacy exact tag: $image_ref"
    fi

    return 0
}

validate_published_release_image() {
    local image_name="$1"

    validate_published_release_image_ref "$image_name" "$(release_image_ref "$image_name")"
}

release_image_manifest_digest() {
    local image_ref="$1"
    local manifest_json=""

    manifest_json="$(docker buildx imagetools inspect --raw "$image_ref" 2>/dev/null)" || return 1
    [ -n "$manifest_json" ] || return 1
    printf '%s' "$manifest_json" | node -e '
const crypto = require("crypto");
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  process.stdout.write(crypto.createHash("sha256").update(Buffer.concat(chunks)).digest("hex"));
});
'
}

sync_reused_release_image_latest_aliases() {
    local image_name=""
    local exact_ref=""
    local latest_ref=""
    local exact_digest=""
    local latest_digest=""

    [ -n "$DOCKER_IMAGES_REUSED" ] || return 0

    for image_name in $DOCKER_IMAGES_REUSED; do
        exact_ref="$(release_image_ref "$image_name")"
        latest_ref="harbor.example.invalid/portico/${image_name}:latest"
        exact_digest="$(release_image_manifest_digest "$exact_ref" || true)"
        latest_digest="$(release_image_manifest_digest "$latest_ref" || true)"
        if [ -n "$exact_digest" ] && [ "$exact_digest" = "$latest_digest" ]; then
            log "${image_name}:latest already matches verified release tag ${DOCKER_IMAGE_TAG}; skipping synchronization"
            continue
        fi
        log "Synchronizing ${image_name}:latest from verified release tag ${DOCKER_IMAGE_TAG}..."
        docker buildx imagetools create -t "$latest_ref" "$exact_ref" >/dev/null \
            || die "Unable to synchronize latest alias for $image_name"
        validate_published_release_image_ref "$image_name" "$latest_ref" \
            || die "Synchronized latest alias is invalid for $image_name"
    done
}

canonicalize_existing_path() {
    local target="$1"
    [ -e "$target" ] || die "Path does not exist: $target"
    (
        cd "$(dirname "$target")" &&
        printf '%s/%s\n' "$(pwd -P)" "$(basename "$target")"
    )
}

canonicalize_future_path() {
    local target="$1"
    local dir
    dir="$(dirname "$target")"
    (
        mkdir -p "$dir" &&
        cd "$dir" &&
        printf '%s/%s\n' "$(pwd -P)" "$(basename "$target")"
    )
}

initialize_package_cache() {
    PACKAGE_CACHE_DIR="$(canonicalize_future_path "$PACKAGE_CACHE_DIR")"
    mkdir -p "$PACKAGE_CACHE_DIR"
    : > "$PACKAGE_CACHE_DIR/$PACKAGE_CACHE_MARKER"

    HOST_MCP_CACHE_ARTIFACTS_ROOT="$PACKAGE_CACHE_DIR/host-mcp/artifacts"
    HOST_MCP_CACHE_CARGO_TARGET_DIR="$PACKAGE_CACHE_DIR/host-mcp/cargo-target"
    MACOS_ARTIFACT_CACHE_ROOT="$PACKAGE_CACHE_DIR/macos"
    PACKAGE_METADATA_CACHE_PATH="$PACKAGE_CACHE_DIR/release-metadata/build-info.json"
    mkdir -p \
        "$HOST_MCP_CACHE_ARTIFACTS_ROOT" \
        "$HOST_MCP_CACHE_CARGO_TARGET_DIR" \
        "$MACOS_ARTIFACT_CACHE_ROOT" \
        "$(dirname "$PACKAGE_METADATA_CACHE_PATH")"
    PACKAGE_CACHE_INITIALIZED=true

    if release_source_tree_is_clean; then
        PACKAGE_SOURCE_CLEAN=true
    else
        PACKAGE_SOURCE_CLEAN=false
        warn "Managed source tree is dirty; persistent package artifact reuse is disabled for this run"
    fi
}

assert_marked_package_cache_path() {
    local target_path="$1"

    [ -f "$PACKAGE_CACHE_DIR/$PACKAGE_CACHE_MARKER" ] \
        || die "Refusing package-cache mutation because the safety marker is missing: $PACKAGE_CACHE_DIR"
    case "$target_path" in
        "$PACKAGE_CACHE_DIR"/*)
            return 0
            ;;
        *)
            die "Refusing package-cache mutation outside the marked cache root: $target_path"
            ;;
    esac
}

channel_to_package_name() {
    release_channel_to_package_name "$1" \
        || die "Invalid release channel: $1. Use stable, beta, dev, or a 1-64 character lowercase slug containing letters, numbers, hyphens, or underscores."
}

validate_build_id() {
    if [[ ! "$BUILD_ID" =~ ^[0-9]{8}-[a-f0-9]+$ ]]; then
        die "Invalid build id: $BUILD_ID (expected MMDDYYYY-<lowercase-hex>)"
    fi
}

read_build_info_full_sha() {
    local build_info_path="$1"

    [ -f "$build_info_path" ] || return 1

    sed -n 's/.*"fullSha"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$build_info_path" |
        head -n 1 |
        tr '[:upper:]' '[:lower:]'
}

git_head_full_sha() {
    local source_root="$1"

    git -C "$source_root" rev-parse HEAD 2>/dev/null | tr '[:upper:]' '[:lower:]'
}

parse_args() {
    local positional=()

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --channel)
                [ $# -ge 2 ] || die "--channel requires a value"
                CHANNEL="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"
                shift 2
                ;;
            --beta|--stable|--dev)
                CHANNEL="${1#--}"
                shift
                ;;
            --full-sha)
                [ $# -ge 2 ] || die "--full-sha requires a value"
                FULL_SHA="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"
                shift 2
                ;;
            --docker-image-tag)
                [ $# -ge 2 ] || die "--docker-image-tag requires a value"
                DOCKER_IMAGE_TAG="$2"
                shift 2
                ;;
            --release-timestamp)
                [ $# -ge 2 ] || die "--release-timestamp requires a value"
                RELEASE_TIMESTAMP="$2"
                shift 2
                ;;
            --managed-root-source)
                [ $# -ge 2 ] || die "--managed-root-source requires a value"
                MANAGED_ROOT_SOURCE="$2"
                shift 2
                ;;
            --artifact-search-root)
                [ $# -ge 2 ] || die "--artifact-search-root requires a value"
                ARTIFACT_SEARCH_ROOT="$2"
                shift 2
                ;;
            --host-mcp-binaries-dir)
                [ $# -ge 2 ] || die "--host-mcp-binaries-dir requires a value"
                HOST_MCP_BINARIES_DIR="$2"
                shift 2
                ;;
            --host-mcp-source-revision)
                [ $# -ge 2 ] || die "--host-mcp-source-revision requires a value"
                HOST_MCP_SOURCE_REVISION="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"
                shift 2
                ;;
            --image-attestation)
                [ $# -ge 2 ] || die "--image-attestation requires a value"
                RUNTIME_IMAGE_ATTESTATION="$2"
                shift 2
                ;;
            --unsigned-preview)
                [ $# -ge 2 ] || die "--unsigned-preview requires arm64 or x64"
                UNSIGNED_PREVIEW_ARCH="$2"
                shift 2
                ;;
            --preview-output-dir)
                [ $# -ge 2 ] || die "--preview-output-dir requires a value"
                PREVIEW_OUTPUT_DIR="$2"
                shift 2
                ;;
            --unsigned-mr-stage)
                [ $# -ge 2 ] || die "--unsigned-mr-stage requires an output directory"
                MR_STAGE_OUTPUT_DIR="$2"
                shift 2
                ;;
            --mr-project-id)
                [ $# -ge 2 ] || die "--mr-project-id requires a value"
                MR_PROJECT_ID="$2"
                shift 2
                ;;
            --mr-project-path)
                [ $# -ge 2 ] || die "--mr-project-path requires a value"
                MR_PROJECT_PATH="$2"
                shift 2
                ;;
            --mr-iid)
                [ $# -ge 2 ] || die "--mr-iid requires a value"
                MR_IID="$2"
                shift 2
                ;;
            --mr-target-branch)
                [ $# -ge 2 ] || die "--mr-target-branch requires a value"
                MR_TARGET_BRANCH="$2"
                shift 2
                ;;
            --app-arm64)
                [ $# -ge 2 ] || die "--app-arm64 requires a value"
                APP_ARM64="$2"
                APP_ARM64_EXPLICIT=true
                shift 2
                ;;
            --app-x64)
                [ $# -ge 2 ] || die "--app-x64 requires a value"
                APP_X64="$2"
                APP_X64_EXPLICIT=true
                shift 2
                ;;
            --dmg-arm64)
                [ $# -ge 2 ] || die "--dmg-arm64 requires a value"
                DMG_ARM64="$2"
                DMG_ARM64_EXPLICIT=true
                shift 2
                ;;
            --dmg-x64)
                [ $# -ge 2 ] || die "--dmg-x64 requires a value"
                DMG_X64="$2"
                DMG_X64_EXPLICIT=true
                shift 2
                ;;
            --output-zip)
                [ $# -ge 2 ] || die "--output-zip requires a value"
                OUTPUT_ZIP="$2"
                shift 2
                ;;
            --force-docker-images)
                FORCE_DOCKER_IMAGES=true
                shift
                ;;
            --yes)
                ACCEPT_SUGGESTED_BUILD_ID=true
                shift
                ;;
            --help|-h)
                show_usage
                exit 0
                ;;
            --)
                shift
                while [[ $# -gt 0 ]]; do
                    positional+=("$1")
                    shift
                done
                ;;
            -*)
                die "Unknown argument: $1"
                ;;
            *)
                positional+=("$1")
                shift
                ;;
        esac
    done

    if [ "${#positional[@]}" -gt 1 ]; then
        show_usage >&2
        die "At most one build id argument may be provided"
    fi

    if [ "${#positional[@]}" -eq 1 ]; then
        BUILD_ID="$(printf '%s' "${positional[0]}" | tr '[:upper:]' '[:lower:]')"
    fi
}

suggest_build_id() {
    local source_root="${MANAGED_ROOT_SOURCE:-$SCRIPT_DIR}"
    local short_sha=""
    local build_date=""

    if ! git -C "$source_root" rev-parse --show-toplevel >/dev/null 2>&1; then
        die "No build id was provided and ${source_root} is not a git checkout. Pass an explicit build id."
    fi

    short_sha="$(git -C "$source_root" rev-parse --short=8 HEAD | tr '[:upper:]' '[:lower:]')"
    build_date="$(date +%m%d%Y)"
    printf '%s-%s\n' "$build_date" "$short_sha"
}

confirm_or_fill_build_id() {
    local suggested_build_id=""
    local response=""

    if [ -n "$BUILD_ID" ]; then
        return 0
    fi

    suggested_build_id="$(suggest_build_id)"

    if [ "$ACCEPT_SUGGESTED_BUILD_ID" = true ]; then
        BUILD_ID="$suggested_build_id"
        log "Using suggested build id: $BUILD_ID"
        return 0
    fi

    if [ ! -t 0 ]; then
        die "No build id was provided. Suggested build id: ${suggested_build_id}. Re-run with that value or pass --yes."
    fi

    printf 'No build id provided. Suggested build id: %s. Use it? [Y/n] ' "$suggested_build_id"
    read -r response
    case "${response:-y}" in
        y|Y|yes|YES)
            BUILD_ID="$suggested_build_id"
            log "Using suggested build id: $BUILD_ID"
            ;;
        *)
            die "Build id confirmation declined. Re-run with an explicit build id."
            ;;
    esac
}

resolve_full_sha() {
    local build_info_sha=""
    local git_sha=""

    if [ -n "$FULL_SHA" ]; then
        return 0
    fi

    build_info_sha="$(read_build_info_full_sha "$MANAGED_ROOT_SOURCE/electron-app/build-info.json" || true)"
    if [ "$build_info_sha" = "unknown" ]; then
        build_info_sha=""
    fi

    git_sha="$(git_head_full_sha "$MANAGED_ROOT_SOURCE" || true)"
    if [ -n "$git_sha" ]; then
        if [ -n "$build_info_sha" ] && [ "$build_info_sha" != "$git_sha" ]; then
            warn "Ignoring stale electron-app/build-info.json fullSha (${build_info_sha}) in favor of git HEAD (${git_sha})"
        fi
        FULL_SHA="$git_sha"
        return 0
    fi

    if [ -n "$build_info_sha" ]; then
        FULL_SHA="$build_info_sha"
        return 0
    fi

    FULL_SHA="${BUILD_ID#*-}"
}

validate_release_metadata_consistency() {
    local build_short_sha="${BUILD_ID#*-}"
    local expected_short_sha="$FULL_SHA"

    if [ -z "$expected_short_sha" ] || [ "$BUILD_ID" = "dev-build" ] || [ "$expected_short_sha" = "unknown" ]; then
        return 0
    fi

    if [ ${#expected_short_sha} -ge 8 ]; then
        expected_short_sha="${expected_short_sha:0:8}"
    fi

    [ "$build_short_sha" = "$expected_short_sha" ] && return 0

    die "Resolved release metadata is inconsistent before packaging: build id ${BUILD_ID} does not match full SHA ${FULL_SHA}. If you passed --full-sha, it does not match the build id. Otherwise electron-app/build-info.json may be stale."
}

validate_configuration() {
    validate_docker_image_mode
    validate_release_timestamp "$RELEASE_TIMESTAMP"
    validate_positive_integer "PACKAGE_FOR_RELEASE_MIN_FREE_GB" "$PACKAGE_MIN_FREE_GB"
    validate_positive_integer "HOST_MCP_DOCKER_TIMEOUT_SECONDS" "$HOST_MCP_DOCKER_TIMEOUT_SECONDS"

    MANAGED_ROOT_SOURCE="$(canonicalize_existing_path "$MANAGED_ROOT_SOURCE")"
    [ -d "$MANAGED_ROOT_SOURCE" ] || die "Managed root source must be a directory: $MANAGED_ROOT_SOURCE"
    [ -d "$MANAGED_ROOT_SOURCE/electron-app" ] || die "Managed root source is missing electron-app/: $MANAGED_ROOT_SOURCE"
    [ -f "$MANAGED_ROOT_SOURCE/$RELEASE_PAYLOAD_VALIDATOR_RELATIVE" ] \
        || die "Managed root source is missing the release payload validator: $MANAGED_ROOT_SOURCE/$RELEASE_PAYLOAD_VALIDATOR_RELATIVE"

    if [ -n "$ARTIFACT_SEARCH_ROOT" ]; then
        ARTIFACT_SEARCH_ROOT="$(canonicalize_existing_path "$ARTIFACT_SEARCH_ROOT")"
        [ -d "$ARTIFACT_SEARCH_ROOT" ] || die "Artifact search root must be a directory: $ARTIFACT_SEARCH_ROOT"
    else
        ARTIFACT_SEARCH_ROOT="$MANAGED_ROOT_SOURCE/electron-app/dist"
    fi

    if [ -n "$HOST_MCP_BINARIES_DIR" ]; then
        HOST_MCP_BINARIES_DIR="$(canonicalize_existing_path "$HOST_MCP_BINARIES_DIR")"
        [ -d "$HOST_MCP_BINARIES_DIR" ] || die "host-mcp-binaries path must be a directory: $HOST_MCP_BINARIES_DIR"
    fi
    if [ -n "$HOST_MCP_SOURCE_REVISION" ] && [ -z "$HOST_MCP_BINARIES_DIR" ]; then
        die "--host-mcp-source-revision requires --host-mcp-binaries-dir"
    fi

    if [ -n "$RUNTIME_IMAGE_ATTESTATION" ]; then
        RUNTIME_IMAGE_ATTESTATION="$(canonicalize_existing_path "$RUNTIME_IMAGE_ATTESTATION")"
        [ -f "$RUNTIME_IMAGE_ATTESTATION" ] \
            || die "--image-attestation must point to a regular file"
    fi

    if [ -n "$APP_ARM64" ]; then
        APP_ARM64="$(canonicalize_existing_path "$APP_ARM64")"
        [ -d "$APP_ARM64" ] || die "--app-arm64 must point to an .app directory"
    fi
    if [ -n "$APP_X64" ]; then
        APP_X64="$(canonicalize_existing_path "$APP_X64")"
        [ -d "$APP_X64" ] || die "--app-x64 must point to an .app directory"
    fi
    if [ -n "$DMG_ARM64" ]; then
        DMG_ARM64="$(canonicalize_existing_path "$DMG_ARM64")"
        [ -f "$DMG_ARM64" ] || die "--dmg-arm64 must point to a DMG file"
    fi
    if [ -n "$DMG_X64" ]; then
        DMG_X64="$(canonicalize_existing_path "$DMG_X64")"
        [ -f "$DMG_X64" ] || die "--dmg-x64 must point to a DMG file"
    fi

    CHANNEL="$(normalize_release_channel_name "$CHANNEL")"
    CHANNEL_PACKAGE_NAME="$(channel_to_package_name "$CHANNEL")"
    resolve_full_sha

    if [ -z "$DOCKER_IMAGE_TAG" ]; then
        DOCKER_IMAGE_TAG="$BUILD_ID"
    fi

    if [ -n "$HOST_MCP_SOURCE_REVISION" ]; then
        [[ "$HOST_MCP_SOURCE_REVISION" =~ ^[a-f0-9]{40}$ ]] \
            || die "--host-mcp-source-revision must be a full lowercase git SHA"
        [ "$HOST_MCP_SOURCE_REVISION" = "$FULL_SHA" ] \
            || die "--host-mcp-source-revision must match --full-sha"
    fi

    if [ -n "$UNSIGNED_PREVIEW_ARCH" ] && [ -n "$MR_STAGE_OUTPUT_DIR" ]; then
        die "--unsigned-preview cannot be combined with --unsigned-mr-stage"
    fi

    if [ -n "$UNSIGNED_PREVIEW_ARCH" ]; then
        case "$UNSIGNED_PREVIEW_ARCH" in
            arm64|x64) ;;
            *) die "--unsigned-preview requires arm64 or x64" ;;
        esac
        [ -n "$HOST_MCP_SOURCE_REVISION" ] \
            || die "--unsigned-preview requires a revision-marked --host-mcp-binaries-dir"
        [ -z "$RUNTIME_IMAGE_ATTESTATION" ] \
            || die "--unsigned-preview cannot be combined with --image-attestation"
        if [ -z "$RELEASE_TIMESTAMP" ]; then
            RELEASE_TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
        fi
        if [ -z "$PREVIEW_OUTPUT_DIR" ]; then
            PREVIEW_OUTPUT_DIR="$DEFAULT_OUTPUT_DIR/previews/${BUILD_ID}/${UNSIGNED_PREVIEW_ARCH}"
        fi
        PREVIEW_OUTPUT_DIR="$(canonicalize_future_path "$PREVIEW_OUTPUT_DIR")"
    elif [ -n "$PREVIEW_OUTPUT_DIR" ]; then
        die "--preview-output-dir requires --unsigned-preview"
    fi

    if [ -n "$MR_STAGE_OUTPUT_DIR" ]; then
        [ -n "$HOST_MCP_SOURCE_REVISION" ] \
            || die "--unsigned-mr-stage requires a revision-marked --host-mcp-binaries-dir"
        [ -z "$RUNTIME_IMAGE_ATTESTATION" ] \
            || die "--unsigned-mr-stage cannot be combined with --image-attestation"
        [ -z "$APP_ARM64$APP_X64$DMG_ARM64$DMG_X64" ] \
            || die "--unsigned-mr-stage cannot reuse signed app or DMG inputs"
        [[ "$MR_PROJECT_ID" =~ ^[1-9][0-9]*$ ]] \
            || die "--unsigned-mr-stage requires a positive --mr-project-id"
        [[ "$MR_PROJECT_PATH" =~ ^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)+$ ]] \
            || die "--unsigned-mr-stage requires a valid --mr-project-path"
        [[ "$MR_IID" =~ ^[1-9][0-9]*$ ]] \
            || die "--unsigned-mr-stage requires a positive --mr-iid"
        [ -n "$MR_TARGET_BRANCH" ] \
            || die "--unsigned-mr-stage requires --mr-target-branch"
        [ "$CHANNEL" = "mr-${MR_IID}" ] \
            || die "--unsigned-mr-stage channel must be mr-${MR_IID}"
        [ "$DOCKER_IMAGE_TAG" = "mr-${MR_IID}-${FULL_SHA}" ] \
            || die "--unsigned-mr-stage image tag must be mr-${MR_IID}-${FULL_SHA}"
        if [ -z "$RELEASE_TIMESTAMP" ]; then
            die "--unsigned-mr-stage requires --release-timestamp"
        fi
        MR_STAGE_OUTPUT_DIR="$(canonicalize_future_path "$MR_STAGE_OUTPUT_DIR")"
    elif [ -n "$MR_PROJECT_ID$MR_PROJECT_PATH$MR_IID$MR_TARGET_BRANCH" ]; then
        die "MR identity options require --unsigned-mr-stage"
    fi

    if [ -n "$RUNTIME_IMAGE_ATTESTATION" ]; then
        validate_runtime_image_attestation_path "$RUNTIME_IMAGE_ATTESTATION"
    fi

    if [ -n "$MR_STAGE_OUTPUT_DIR" ]; then
        return 0
    fi

    local expected_filename
    expected_filename="${CHANNEL_PACKAGE_NAME}-${BUILD_ID}.zip"
    if [ -z "$OUTPUT_ZIP" ]; then
        OUTPUT_ZIP="$DEFAULT_OUTPUT_DIR/$expected_filename"
    fi
    OUTPUT_ZIP="$(canonicalize_future_path "$OUTPUT_ZIP")"

    if [ "$(basename "$OUTPUT_ZIP")" != "$expected_filename" ]; then
        die "Output zip basename must be ${expected_filename}"
    fi
}

capture_source_checkout_state() {
    local source_root="$1"
    local head_sha=""
    local fingerprint=""
    local untracked_path=""
    local untracked_hash=""

    command -v git >/dev/null 2>&1 || return 1
    git -C "$source_root" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 1
    head_sha="$(git_head_full_sha "$source_root" || true)"
    [ -n "$head_sha" ] || return 1

    fingerprint="$({
        printf 'HEAD %s\n' "$head_sha"
        git -C "$source_root" diff --no-ext-diff --binary HEAD \
            -- . ':(exclude).report-build'
        while IFS= read -r -d '' untracked_path; do
            untracked_hash="$(git -C "$source_root" hash-object --no-filters -- "$untracked_path" 2>/dev/null || printf 'unreadable')"
            printf 'UNTRACKED %s %s\n' "$untracked_hash" "$untracked_path"
        done < <(
            git -C "$source_root" ls-files --others --exclude-standard -z \
                -- . ':(exclude).report-build'
        )
    } | cksum)"

    printf '%s\t%s\n' "$head_sha" "$fingerprint"
}

report_checkout_changes_after_staging() {
    local current_state=""

    [ "$SOURCE_CHECKOUT_IS_GIT" = true ] || return 0
    current_state="$(capture_source_checkout_state "$MANAGED_ROOT_SOURCE" || true)"
    if [ -z "$current_state" ] || [ "$current_state" != "$SOURCE_CHECKOUT_STATE_AFTER_STAGING" ]; then
        warn "The live checkout changed after source staging. The validated payload remains pinned to the staged source snapshot for ${FULL_SHA}; no live-checkout changes were included."
    fi
}

stage_source_tree() {
    require_command rsync

    local source_state_before=""
    local source_state_after=""
    local stage_drift=""

    if source_state_before="$(capture_source_checkout_state "$MANAGED_ROOT_SOURCE")"; then
        SOURCE_CHECKOUT_IS_GIT=true
    else
        SOURCE_CHECKOUT_IS_GIT=false
    fi

    TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/${RELEASE_STAGING_PREFIX}.XXXXXX")"
    : > "$TEMP_DIR/$RELEASE_STAGING_MARKER"
    prune_older_release_staging_dirs "$TEMP_DIR"
    SOURCE_STAGE_DIR="$TEMP_DIR/source-root"
    PAYLOAD_STAGE_DIR="$TEMP_DIR/payload"

    mkdir -p "$SOURCE_STAGE_DIR" "$PAYLOAD_STAGE_DIR"

    local excludes=(
        --exclude ".git"
        --exclude ".DS_Store"
        --exclude ".beads"
        --exclude ".atlas"
        --exclude ".report-build"
        --exclude ".ralph-tui"
        --exclude ".ruff_cache"
        --exclude ".env"
        --exclude ".env.runtime"
        --exclude "node_modules"
        --exclude ".venv"
        --exclude "target"
        --exclude "dev"
        --exclude "electron-app/dist"
        --exclude "electron-app/src/renderer/dist"
        --exclude "electron-app/dist-update"
        --exclude "electron-app/dist-backup"
        --exclude "electron-app/dist-update-prepared"
        --exclude "llm-debug-monitor"
        --exclude "release"
        --exclude "release-artifacts"
        --exclude "backup"
        --exclude "artifact-snapshots"
        --exclude "logs"
        --exclude "health-status"
        --exclude "open-webui-data"
        --exclude "workspaces"
        --exclude "__pycache__"
        --exclude ".pytest_cache"
        --exclude "mcpo-oauth-tokens"
        --exclude "mcpo-core-oauth-tokens"
        --exclude "mcp-configs-user"
        --exclude "skills-user"
    )

    log "Staging managed runtime source tree..."
    rsync -a --no-specials --no-devices "${excludes[@]}" "$MANAGED_ROOT_SOURCE"/ "$SOURCE_STAGE_DIR"/

    stage_drift="$(
        rsync -a --checksum --delete --dry-run --itemize-changes \
            --no-specials --no-devices \
            "${excludes[@]}" \
            "$MANAGED_ROOT_SOURCE"/ "$SOURCE_STAGE_DIR"/
    )"
    [ -z "$stage_drift" ] \
        || die "Managed source changed while the release snapshot was being staged; no Docker build or payload creation was started"

    if [ "$SOURCE_CHECKOUT_IS_GIT" = true ]; then
        source_state_after="$(capture_source_checkout_state "$MANAGED_ROOT_SOURCE" || true)"
        [ -n "$source_state_after" ] && [ "$source_state_after" = "$source_state_before" ] \
            || die "Git checkout changed while the release snapshot was being staged; no Docker build or payload creation was started"
        SOURCE_CHECKOUT_STATE_AFTER_STAGING="$source_state_after"
    fi
}

write_release_metadata_files() {
    local build_info_path="$SOURCE_STAGE_DIR/electron-app/build-info.json"
    local build_date="${BUILD_ID%%-*}"
    local cached_build_number=""
    local cached_full_sha=""
    local cached_channel=""
    local cached_timestamp=""
    local cached_docker_image_tag=""
    local metadata_timestamp=""
    local metadata_cache_tmp=""

    if [ "$PACKAGE_SOURCE_CLEAN" = true ] \
        && [ -n "$PACKAGE_METADATA_CACHE_PATH" ] \
        && [ -f "$PACKAGE_METADATA_CACHE_PATH" ]; then
        cached_build_number="$(json_string_field_from_file "$PACKAGE_METADATA_CACHE_PATH" "buildNumber")"
        cached_full_sha="$(json_string_field_from_file "$PACKAGE_METADATA_CACHE_PATH" "fullSha")"
        cached_channel="$(json_string_field_from_file "$PACKAGE_METADATA_CACHE_PATH" "channel")"
        cached_timestamp="$(json_string_field_from_file "$PACKAGE_METADATA_CACHE_PATH" "timestamp")"
        cached_docker_image_tag="$(json_string_field_from_file "$PACKAGE_METADATA_CACHE_PATH" "dockerImageTag")"
        if [ "$cached_build_number" = "$BUILD_ID" ] \
            && [ "$cached_full_sha" = "$FULL_SHA" ] \
            && [ "$cached_channel" = "$CHANNEL_PACKAGE_NAME" ] \
            && [ "$cached_docker_image_tag" = "$DOCKER_IMAGE_TAG" ] \
            && { [ -z "$RELEASE_TIMESTAMP" ] || [ "$cached_timestamp" = "$RELEASE_TIMESTAMP" ]; }; then
            cp -p "$PACKAGE_METADATA_CACHE_PATH" "$build_info_path"
            log "Reused package metadata timestamp for ${BUILD_ID}"
            return 0
        fi
    fi

    metadata_timestamp="${RELEASE_TIMESTAMP:-$(date -u +%Y-%m-%dT%H:%M:%S.000Z)}"

    cat > "$build_info_path" <<EOF
{
  "buildNumber": "${BUILD_ID}",
  "fullSha": "${FULL_SHA}",
  "date": "${build_date}",
  "timestamp": "${metadata_timestamp}",
  "channel": "${CHANNEL_PACKAGE_NAME}",
  "dockerImageTag": "${DOCKER_IMAGE_TAG}"
}
EOF

    if [ "$PACKAGE_SOURCE_CLEAN" = true ] && [ -n "$PACKAGE_METADATA_CACHE_PATH" ]; then
        assert_marked_package_cache_path "$PACKAGE_METADATA_CACHE_PATH"
        mkdir -p "$(dirname "$PACKAGE_METADATA_CACHE_PATH")"
        metadata_cache_tmp="${PACKAGE_METADATA_CACHE_PATH}.tmp.$$"
        cp -p "$build_info_path" "$metadata_cache_tmp"
        mv "$metadata_cache_tmp" "$PACKAGE_METADATA_CACHE_PATH"
    fi
}

prepare_cloudsmith_release_resource() {
    local electron_dir="$SOURCE_STAGE_DIR/electron-app"
    local prepare_script="$electron_dir/scripts/prepare-cloudsmith-resource.js"
    local resource_path="$electron_dir/build-resources/cloudsmith.env"

    require_command node
    [ -f "$prepare_script" ] || die "Missing Cloudsmith packaged-resource generator: $prepare_script"

    log "Preparing packaged Cloudsmith updater resource..."
    (
        cd "$electron_dir"
        node scripts/prepare-cloudsmith-resource.js
    )
    node "$prepare_script" --validate "$resource_path" >/dev/null \
        || die "Packaged Cloudsmith updater resource failed validation"
}

sync_directory_contents() {
    local from_dir="$1"
    local to_dir="$2"

    mkdir -p "$to_dir"
    rsync -a --no-specials --no-devices --delete "$from_dir"/ "$to_dir"/
}

json_string_field_from_file() {
    local file_path="$1"
    local field_name="$2"

    sed -n "s/.*\"${field_name}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$file_path" | head -n 1
}

host_mcp_dir_has_targets() {
    local dir="$1"
    [ -d "$dir" ] || return 1
    find "$dir" -mindepth 1 -maxdepth 1 -type d -print -quit | grep -q .
}

darwin_host_mcp_targets() {
    printf '%s\n' "aarch64-apple-darwin" "x86_64-apple-darwin"
}

required_host_mcp_targets() {
    printf '%s\n' \
        "aarch64-apple-darwin" \
        "x86_64-apple-darwin" \
        "x86_64-unknown-linux-gnu" \
        "aarch64-unknown-linux-gnu"
}

staged_darwin_host_mcp_binary_state() {
    local project_root="$1"
    local target="$2"
    local binary_path

    binary_path="$(host_mcp_artifact_binary_path "$project_root/host-mcp-binaries" "$target")"
    if [ ! -x "$binary_path" ]; then
        printf '%s\n' "missing"
        return 0
    fi

    if host_mcp_binary_is_current "$project_root" "$binary_path"; then
        printf '%s\n' "current"
    else
        printf '%s\n' "stale"
    fi
}

log_staged_darwin_host_mcp_statuses() {
    local project_root="$1"
    local label="${2:-Staged host MCP binary}"
    local target=""
    local state=""

    while IFS= read -r target; do
        [ -n "$target" ] || continue
        state="$(staged_darwin_host_mcp_binary_state "$project_root" "$target")"
        log "${label}: ${target} ${state}"
    done < <(darwin_host_mcp_targets)
}

staged_darwin_host_mcp_binary_issues() {
    local project_root="$1"
    local missing=()
    local stale=()
    local target=""
    local state=""
    local details=()

    while IFS= read -r target; do
        [ -n "$target" ] || continue
        state="$(staged_darwin_host_mcp_binary_state "$project_root" "$target")"
        case "$state" in
            missing)
                missing+=("$target")
                ;;
            stale)
                stale+=("$target")
                ;;
        esac
    done < <(darwin_host_mcp_targets)

    if [ "${#missing[@]}" -eq 0 ] && [ "${#stale[@]}" -eq 0 ]; then
        return 0
    fi

    if [ "${#missing[@]}" -gt 0 ]; then
        details+=("missing: ${missing[*]}")
    fi
    if [ "${#stale[@]}" -gt 0 ]; then
        details+=("stale: ${stale[*]}")
    fi

    printf '%s\n' "${details[*]}"
    return 1
}

seed_host_mcp_cache_from_staged() {
    local staged_dir="$1"
    local target=""
    local staged_binary=""
    local cached_binary=""
    local revision_marker=""

    [ "$PACKAGE_SOURCE_CLEAN" = true ] || return 0

    while IFS= read -r target; do
        [ -n "$target" ] || continue
        staged_binary="$(host_mcp_artifact_binary_path "$staged_dir" "$target")"
        cached_binary="$(host_mcp_artifact_binary_path "$HOST_MCP_CACHE_ARTIFACTS_ROOT" "$target")"
        revision_marker="$(dirname "$cached_binary")/.source-revision"

        if [ -x "$cached_binary" ] && [ -f "$revision_marker" ] \
            && [ "$(cat "$revision_marker")" = "$FULL_SHA" ]; then
            continue
        fi
        if [ -x "$staged_binary" ] && host_mcp_binary_is_current "$SOURCE_STAGE_DIR" "$staged_binary"; then
            mkdir -p "$(dirname "$cached_binary")"
            install -m 0755 "$staged_binary" "$cached_binary"
            printf '%s\n' "$FULL_SHA" > "$revision_marker"
            log "Seeded package cache with current host MCP binary: $target"
        fi
    done < <(darwin_host_mcp_targets)
}

sync_host_mcp_artifacts() {
    local from_dir="$1"
    local to_dir="$2"

    mkdir -p "$to_dir"
    rsync -a --no-specials --no-devices --delete \
        --delete-excluded \
        --exclude='.source-revision' \
        "$from_dir"/ "$to_dir"/
}

verify_required_host_mcp_binaries() {
    local artifacts_root="$1"
    local target=""
    local binary_path=""

    while IFS= read -r target; do
        [ -n "$target" ] || continue
        binary_path="$(host_mcp_artifact_binary_path "$artifacts_root" "$target")"
        [ -x "$binary_path" ] || die "Prepared host MCP binary is missing or not executable: $binary_path"
    done < <(required_host_mcp_targets)
}

verify_revision_marked_host_mcp_binaries() {
    local artifacts_root="$1"
    local expected_revision="$2"
    local target=""
    local binary_path=""
    local marker_path=""
    local description=""
    local actual_targets=""
    local expected_targets=""

    require_command file
    expected_targets="$(required_host_mcp_targets | sort)"
    actual_targets="$(
        find "$artifacts_root" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort
    )"
    [ "$actual_targets" = "$expected_targets" ] \
        || die "Revision-marked host-mcp-binaries must contain exactly the four required target directories"

    while IFS= read -r target; do
        [ -n "$target" ] || continue
        binary_path="$(host_mcp_artifact_binary_path "$artifacts_root" "$target")"
        marker_path="$(dirname "$binary_path")/.source-revision"
        [ -x "$binary_path" ] \
            || die "Revision-marked host MCP binary is missing or not executable: $binary_path"
        [ -f "$marker_path" ] \
            || die "Revision-marked host MCP binary is missing its source marker: $marker_path"
        [ "$(cat "$marker_path")" = "$expected_revision" ] \
            || die "Host MCP source revision mismatch for $target"

        description="$(file -b "$binary_path" 2>/dev/null || true)"
        case "$target" in
            aarch64-apple-darwin)
                [[ "$description" == *Mach-O*arm64* ]] \
                    || die "Host MCP binary has the wrong architecture for $target: ${description:-unknown}"
                ;;
            x86_64-apple-darwin)
                [[ "$description" == *Mach-O*x86_64* ]] \
                    || die "Host MCP binary has the wrong architecture for $target: ${description:-unknown}"
                ;;
            aarch64-unknown-linux-gnu)
                [[ "$description" == *ELF*ARM\ aarch64* ]] \
                    || die "Host MCP binary has the wrong architecture for $target: ${description:-unknown}"
                ;;
            x86_64-unknown-linux-gnu)
                [[ "$description" == *ELF*x86-64* ]] \
                    || die "Host MCP binary has the wrong architecture for $target: ${description:-unknown}"
                ;;
        esac
    done < <(required_host_mcp_targets)
}

refresh_staged_host_mcp_binaries() {
    local build_script="$SOURCE_STAGE_DIR/src/scripts/build-host-mcp-binaries.sh"
    local build_log=""
    local build_status=0
    local artifacts_root="$SOURCE_STAGE_DIR/host-mcp-binaries"
    local expected_revision=""
    local cargo_target_dir=""
    local linux_source_image="$(release_image_ref "mcp-orc-rust")"
    local restore_errexit=false

    [ -f "$build_script" ] || die "Missing build-host-mcp-binaries.sh in staged source tree: $build_script"

    if [ "$PACKAGE_SOURCE_CLEAN" = true ]; then
        artifacts_root="$HOST_MCP_CACHE_ARTIFACTS_ROOT"
        expected_revision="$FULL_SHA"
        cargo_target_dir="$HOST_MCP_CACHE_CARGO_TARGET_DIR"
        seed_host_mcp_cache_from_staged "$SOURCE_STAGE_DIR/host-mcp-binaries"
    fi

    # Keep the X run at the end of the template. BSD mktemp treats a suffix
    # after the Xs literally, so a failed build can otherwise poison every
    # later packaging attempt with the same non-unique log path.
    build_log="$(mktemp "${TMPDIR:-/tmp}/portico-host-mcp-build.log.XXXXXX")"
    case "$-" in
        *e*) restore_errexit=true ;;
    esac
    set +e
    (
        cd "$SOURCE_STAGE_DIR"
        HOST_MCP_ARTIFACTS_ROOT="$artifacts_root" \
        HOST_MCP_EXPECTED_SOURCE_REVISION="$expected_revision" \
        HOST_MCP_EXPECTED_IMAGE_REVISION="$FULL_SHA" \
        HOST_MCP_LINUX_SOURCE_IMAGE="$linux_source_image" \
        HOST_MCP_DOCKER_TIMEOUT_SECONDS="$HOST_MCP_DOCKER_TIMEOUT_SECONDS" \
        HOST_MCP_MIN_FREE_GB="$PACKAGE_MIN_FREE_GB" \
        CARGO_TARGET_DIR="$cargo_target_dir" \
            bash "$build_script" --all-supported
    ) 2>&1 | tee "$build_log"
    build_status=${PIPESTATUS[0]}
    if [ "$restore_errexit" = true ]; then
        set -e
    else
        set +e
    fi

    if [ "$build_status" -ne 0 ]; then
        warn "Host MCP binary preparation failed; preserved live build log: $build_log"
        return "$build_status"
    fi

    if [ "$PACKAGE_SOURCE_CLEAN" = true ]; then
        sync_host_mcp_artifacts "$artifacts_root" "$SOURCE_STAGE_DIR/host-mcp-binaries"
    fi
    rm -f "$build_log"
    return 0
}

prepare_host_mcp_binaries() {
    local staged_dir="$SOURCE_STAGE_DIR/host-mcp-binaries"
    local host_os=""
    local issues=""

    mkdir -p "$staged_dir"

    if [ -n "$HOST_MCP_BINARIES_DIR" ]; then
        log "Using explicit host-mcp-binaries tree: $HOST_MCP_BINARIES_DIR"
        sync_directory_contents "$HOST_MCP_BINARIES_DIR" "$staged_dir"
        HOST_MCP_PROVENANCE="reused existing host-mcp-binaries from ${HOST_MCP_BINARIES_DIR}"
    fi

    if [ -n "$HOST_MCP_SOURCE_REVISION" ]; then
        verify_revision_marked_host_mcp_binaries "$staged_dir" "$HOST_MCP_SOURCE_REVISION"
        HOST_MCP_PROVENANCE="reused complete revision-marked host-mcp-binaries for ${HOST_MCP_SOURCE_REVISION}"
        HOST_MCP_SOURCE_DIR="$staged_dir"
        log "Validated complete revision-marked host-mcp-binaries for ${HOST_MCP_SOURCE_REVISION}"
        return 0
    fi

    host_os="$(uname -s)"
    log_staged_darwin_host_mcp_statuses "$SOURCE_STAGE_DIR" "Pre-refresh host MCP binary"

    if [ "$host_os" = "Darwin" ]; then
        log "Refreshing host-mcp-binaries in staged source tree..."
        refresh_staged_host_mcp_binaries || die "Failed to refresh staged host-mcp-binaries"
        issues="$(staged_darwin_host_mcp_binary_issues "$SOURCE_STAGE_DIR" || true)"
        [ -z "$issues" ] || die "Staged host-mcp-binaries are not current after refresh (${issues})"
        if [ -n "$HOST_MCP_BINARIES_DIR" ]; then
            HOST_MCP_PROVENANCE="seeded from explicit host-mcp-binaries and refreshed in this run"
        else
            HOST_MCP_PROVENANCE="refreshed host-mcp-binaries in this run"
        fi
    else
        if ! host_mcp_dir_has_targets "$staged_dir"; then
            die "host-mcp-binaries are missing and cannot be built automatically on ${host_os}; pass --host-mcp-binaries-dir"
        fi
        issues="$(staged_darwin_host_mcp_binary_issues "$SOURCE_STAGE_DIR" || true)"
        [ -z "$issues" ] || die "Staged host-mcp-binaries are not current for macOS packaging on ${host_os} (${issues}). Rebuild them on macOS or pass a fresh --host-mcp-binaries-dir."
    fi

    host_mcp_dir_has_targets "$staged_dir" || die "host-mcp-binaries are missing after preparation"
    verify_required_host_mcp_binaries "$staged_dir"
    log_staged_darwin_host_mcp_statuses "$SOURCE_STAGE_DIR" "Prepared host MCP binary"
    HOST_MCP_SOURCE_DIR="$staged_dir"
}

prepare_release_docker_images() {
    local image_name=""
    local images_to_build=""
    local images_to_build_csv=""
    local skip_requested=false

    is_truthy "$SKIP_DOCKER_IMAGES" && skip_requested=true

    validate_docker_image_mode
    require_command node
    DOCKER_IMAGES_BUILT=""
    DOCKER_IMAGES_REUSED=""
    DID_BUILD_DOCKER_IMAGES=false

    if [ -n "$RUNTIME_IMAGE_ATTESTATION" ]; then
        validate_runtime_image_attestation_path "$RUNTIME_IMAGE_ATTESTATION"
        for image_name in $(release_image_names); do
            DOCKER_IMAGES_REUSED="$(append_image_name "$DOCKER_IMAGES_REUSED" "$image_name")"
        done
        log "Reusing all seven immutable runtime image indexes from the validated attestation"
        return 0
    fi

    require_command docker

    if [ "$skip_requested" = true ]; then
        log "Validating published runtime Docker images for tag ${DOCKER_IMAGE_TAG} without publishing..."
        for image_name in $(release_image_names); do
            validate_published_release_image "$image_name" \
                || die "Cannot skip Docker builds because ${image_name}:${DOCKER_IMAGE_TAG} is missing or invalid"
            DOCKER_IMAGES_REUSED="$(append_image_name "$DOCKER_IMAGES_REUSED" "$image_name")"
        done
        warn "Validated and reused published Docker images because PACKAGE_FOR_RELEASE_SKIP_DOCKER_IMAGES=${SKIP_DOCKER_IMAGES}"
        return 0
    fi

    if [ "$FORCE_DOCKER_IMAGES" = true ]; then
        images_to_build="$(release_image_names)"
        log "Forcing rebuild of every runtime Docker image for tag ${DOCKER_IMAGE_TAG}..."
    elif [ "$PACKAGE_SOURCE_CLEAN" != true ]; then
        images_to_build="$(release_image_names)"
        warn "Staged managed source was dirty or did not match ${FULL_SHA}; disabling published-image reuse"
    else
        log "Checking for reusable runtime Docker images with tag ${DOCKER_IMAGE_TAG}..."
        for image_name in $(release_image_names); do
            if validate_published_release_image "$image_name"; then
                DOCKER_IMAGES_REUSED="$(append_image_name "$DOCKER_IMAGES_REUSED" "$image_name")"
            else
                images_to_build="$(append_image_name "$images_to_build" "$image_name")"
            fi
        done
    fi

    if [ -n "$images_to_build" ]; then
        [ -x "$SOURCE_STAGE_DIR/build_docker_images.sh" ] || die "Missing staged build_docker_images.sh"
        images_to_build_csv="$(image_names_to_csv "$images_to_build")"
        log "Building and publishing runtime Docker images from the staged ${FULL_SHA} source snapshot for tag ${DOCKER_IMAGE_TAG}: ${images_to_build}"
        (
            cd "$SOURCE_STAGE_DIR"
            bash "./build_docker_images.sh" "$DOCKER_IMAGE_TAG" \
                --images "$images_to_build_csv" \
                --source-revision "$FULL_SHA"
        )
        DID_BUILD_DOCKER_IMAGES=true
        DOCKER_IMAGES_BUILT="$images_to_build"
    else
        log "All exact-tag runtime Docker images are valid; no image builds are needed"
    fi

    for image_name in $(release_image_names); do
        validate_published_release_image "$image_name" \
            || die "Runtime Docker image validation failed after build/reuse: ${image_name}:${DOCKER_IMAGE_TAG}"
    done

    sync_reused_release_image_latest_aliases
}

detect_app_arch() {
    local app_path="$1"
    local executable="$app_path/Contents/MacOS/$APP_PRODUCT_NAME"
    if [ -f "$executable" ] && command -v file >/dev/null 2>&1; then
        local description
        description="$(file -b "$executable" 2>/dev/null || true)"
        case "$description" in
            *arm64*|*aarch64*)
                echo "arm64"
                return 0
                ;;
            *x86_64*)
                echo "x64"
                return 0
                ;;
        esac
    fi

    local lowered
    lowered="$(printf '%s' "$app_path" | tr '[:upper:]' '[:lower:]')"

    case "$lowered" in
        *x64*|*amd64*)
            echo "x64"
            return 0
            ;;
        *arm64*|*aarch64*)
            echo "arm64"
            return 0
            ;;
    esac

    return 1
}

find_app_in_root_for_arch() {
    local root="$1"
    local arch="$2"
    local candidate

    [ -d "$root" ] || return 1

    while IFS= read -r candidate; do
        if [ "$(detect_app_arch "$candidate" || true)" = "$arch" ]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done < <(find "$root" -type d -name "$APP_BUNDLE_NAME" | sort)

    return 1
}

verify_packaged_app_matches_arch() {
    local app_path="$1"
    local expected_arch="$2"
    local detected_arch

    detected_arch="$(detect_app_arch "$app_path" || true)"
    [ -n "$detected_arch" ] || die "Unable to determine packaged app architecture for ${expected_arch} slot: $app_path"
    [ "$detected_arch" = "$expected_arch" ] || die "Packaged app architecture mismatch for ${expected_arch} slot: $app_path is ${detected_arch}"
}

find_dmg_in_root_for_arch() {
    local root="$1"
    local arch="$2"
    local candidate

    [ -d "$root" ] || return 1

    case "$arch" in
        arm64)
            while IFS= read -r candidate; do
                printf '%s\n' "$candidate"
                return 0
            done < <(find "$root" -type f \( -iname '*arm64*.dmg' -o -iname '*aarch64*.dmg' \) | sort)
            ;;
        x64)
            while IFS= read -r candidate; do
                printf '%s\n' "$candidate"
                return 0
            done < <(find "$root" -type f \( -iname '*x64*.dmg' -o -iname '*amd64*.dmg' \) | sort)

            while IFS= read -r candidate; do
                local base
                base="$(basename "$candidate" | tr '[:upper:]' '[:lower:]')"
                if [[ "$base" != *arm64* && "$base" != *aarch64* ]]; then
                    printf '%s\n' "$candidate"
                    return 0
                fi
            done < <(find "$root" -type f -iname '*.dmg' | sort)
            ;;
    esac

    return 1
}

locate_existing_app_for_arch() {
    local arch="$1"
    local root
    local cache_root=""

    if [ -n "$MACOS_ARTIFACT_CACHE_ROOT" ]; then
        cache_root="$MACOS_ARTIFACT_CACHE_ROOT/darwin-${arch}"
    fi

    for root in \
        "$cache_root" \
        "$ARTIFACT_SEARCH_ROOT/release-build/darwin-${arch}" \
        "$ARTIFACT_SEARCH_ROOT/release-build" \
        "$ARTIFACT_SEARCH_ROOT" \
        "$SOURCE_STAGE_DIR/electron-app/dist/release-build/darwin-${arch}" \
        "$SOURCE_STAGE_DIR/electron-app/dist/release-build" \
        "$SOURCE_STAGE_DIR/electron-app/dist"
    do
        if [ -n "$root" ] && [ -d "$root" ]; then
            local candidate
            candidate="$(find_app_in_root_for_arch "$root" "$arch" || true)"
            if [ -n "$candidate" ]; then
                printf '%s\n' "$candidate"
                return 0
            fi
        fi
    done

    return 1
}

locate_existing_dmg_for_arch() {
    local arch="$1"
    local root
    local cache_root=""

    if [ -n "$MACOS_ARTIFACT_CACHE_ROOT" ]; then
        cache_root="$MACOS_ARTIFACT_CACHE_ROOT/darwin-${arch}"
    fi

    for root in \
        "$cache_root" \
        "$ARTIFACT_SEARCH_ROOT/release-build/darwin-${arch}" \
        "$ARTIFACT_SEARCH_ROOT/release-build" \
        "$ARTIFACT_SEARCH_ROOT" \
        "$SOURCE_STAGE_DIR/electron-app/dist/release-build/darwin-${arch}" \
        "$SOURCE_STAGE_DIR/electron-app/dist/release-build" \
        "$SOURCE_STAGE_DIR/electron-app/dist"
    do
        if [ -n "$root" ] && [ -d "$root" ]; then
            local candidate
            candidate="$(find_dmg_in_root_for_arch "$root" "$arch" || true)"
            if [ -n "$candidate" ]; then
                printf '%s\n' "$candidate"
                return 0
            fi
        fi
    done

    return 1
}

ensure_macos_build_environment() {
    if [ "$MAC_BUILD_ENV_READY" = true ]; then
        return 0
    fi

    require_command npm
    require_command codesign
    require_command spctl
    require_command xcrun
    xcrun notarytool --version >/dev/null 2>&1 || die "xcrun notarytool is required for macOS release builds"

    local missing=()
    [ -n "${APPLE_ID:-}" ] || missing+=("APPLE_ID")
    [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] || missing+=("APPLE_APP_SPECIFIC_PASSWORD")
    [ -n "${APPLE_TEAM_ID:-}" ] || missing+=("APPLE_TEAM_ID")

    if [ "${#missing[@]}" -gt 0 ]; then
        die "Missing notarization environment variables for macOS release build: ${missing[*]}"
    fi

    MAC_BUILD_ENV_READY=true
}

ensure_electron_dependencies() {
    if [ "$NPM_DEPS_READY" = true ]; then
        return 0
    fi

    log "Installing Electron packaging dependencies in staged source tree..."
    (
        cd "$SOURCE_STAGE_DIR/electron-app"
        npm ci --no-audit --no-fund
        npm run prepare:packaged-build
    )

    NPM_DEPS_READY=true
}

is_retryable_dmg_detach_failure() {
    local log_path="$1"
    [ -f "$log_path" ] || return 1
    grep -q 'Unable to detach device cleanly:.*Resource busy' "$log_path" || \
        grep -q "couldn't unmount .*Resource busy" "$log_path"
}

force_detach_busy_dmg_devices_from_log() {
    local log_path="$1"
    local disk_id

    [ -f "$log_path" ] || return 0
    while IFS= read -r disk_id; do
        [ -n "$disk_id" ] || continue
        log "Force-detaching busy DMG device: $disk_id"
        hdiutil detach "$disk_id" -force >/dev/null 2>&1 || true
    done < <(grep -Eo 'disk[0-9]+' "$log_path" | sort -u)
}

run_electron_builder_with_retry() {
    local arch="$1"
    local output_dir="$2"
    local max_attempts=2
    local attempt=1
    local build_log
    local status
    local electron_builder="$SOURCE_STAGE_DIR/electron-app/node_modules/.bin/electron-builder"

    [ -x "$electron_builder" ] \
        || die "Staged Electron builder is missing or not executable: $electron_builder"

    while [ "$attempt" -le "$max_attempts" ]; do
        build_log="$(mktemp "${TMPDIR:-/tmp}/electron-builder-${arch}.XXXXXX.log")"
        log "Building signed macOS artifacts for ${arch} (attempt ${attempt}/${max_attempts})..."

        set +e
        (
            cd "$SOURCE_STAGE_DIR/electron-app"
            npm run prepare:packaged-build
            "$electron_builder" \
                --publish=never \
                --mac \
                "--${arch}" \
                "--config.directories.output=${output_dir}"
        ) 2>&1 | tee "$build_log"
        status=${PIPESTATUS[0]}
        set -e

        if [ "$status" -eq 0 ]; then
            rm -f "$build_log"
            return 0
        fi

        if [ "$attempt" -lt "$max_attempts" ] && is_retryable_dmg_detach_failure "$build_log"; then
            log "electron-builder hit a transient DMG detach race; cleaning up mounted devices and retrying..."
            force_detach_busy_dmg_devices_from_log "$build_log"
            rm -rf "$output_dir"
            mkdir -p "$output_dir"
            rm -f "$build_log"
            sleep 2
            attempt=$((attempt + 1))
            continue
        fi

        rm -f "$build_log"
        return "$status"
    done

    return 1
}

run_unsigned_preview_builder_with_retry() {
    local arch="$1"
    local output_dir="$2"
    local max_attempts=2
    local attempt=1
    local build_log=""
    local status=0
    local electron_builder="$SOURCE_STAGE_DIR/electron-app/node_modules/.bin/electron-builder"

    [ -x "$electron_builder" ] \
        || die "Staged Electron builder is missing or not executable: $electron_builder"

    while [ "$attempt" -le "$max_attempts" ]; do
        build_log="$(mktemp "${TMPDIR:-/tmp}/electron-builder-preview-${arch}.XXXXXX.log")"
        log "Building unsigned macOS preview for ${arch} (attempt ${attempt}/${max_attempts})..."

        set +e
        (
            cd "$SOURCE_STAGE_DIR/electron-app"
            env \
                CLOUDSMITH_API_KEY="mr-preview-disabled" \
                CLOUDSMITH_ENTITLEMENT_TOKEN="mr-preview-disabled" \
                PORTICO_RUNTIME_DISABLE_KEYCHAIN=1 \
                npm run prepare:packaged-build
            env \
                CLOUDSMITH_API_KEY="mr-preview-disabled" \
                CLOUDSMITH_ENTITLEMENT_TOKEN="mr-preview-disabled" \
                PORTICO_RUNTIME_DISABLE_KEYCHAIN=1 \
                CSC_IDENTITY_AUTO_DISCOVERY=false \
                "$electron_builder" \
                --publish=never \
                --mac \
                "--${arch}" \
                --config.mac.identity=null \
                --config.afterSign=scripts/noop.js \
                --config.dmg.sign=false \
                "--config.directories.output=${output_dir}"
        ) 2>&1 | tee "$build_log"
        status=${PIPESTATUS[0]}
        set -e

        if [ "$status" -eq 0 ]; then
            rm -f "$build_log"
            return 0
        fi

        if [ "$attempt" -lt "$max_attempts" ] && is_retryable_dmg_detach_failure "$build_log"; then
            log "electron-builder hit a transient DMG detach race; cleaning up mounted devices and retrying..."
            force_detach_busy_dmg_devices_from_log "$build_log"
            rm -rf "$output_dir"
            mkdir -p "$output_dir"
            rm -f "$build_log"
            sleep 2
            attempt=$((attempt + 1))
            continue
        fi

        rm -f "$build_log"
        return "$status"
    done

    return 1
}

prepare_unsigned_preview_cloudsmith_resource() {
    CLOUDSMITH_API_KEY="mr-preview-disabled" \
    CLOUDSMITH_ENTITLEMENT_TOKEN="mr-preview-disabled" \
    PORTICO_RUNTIME_DISABLE_KEYCHAIN=1 \
        prepare_cloudsmith_release_resource
}

build_unsigned_preview() {
    local arch="$UNSIGNED_PREVIEW_ARCH"
    local build_output_dir="$SOURCE_STAGE_DIR/electron-app/dist/ci-preview/darwin-${arch}"
    local app_path=""
    local dmg_path=""
    local unexpected_arch=""
    local developer_authority=""
    local app_zip_name="Portico-${BUILD_ID}-${arch}-unsigned.app.zip"
    local dmg_name="Portico-${BUILD_ID}-${arch}-unsigned.dmg"
    local app_zip_path="$PREVIEW_OUTPUT_DIR/$app_zip_name"
    local dmg_output_path="$PREVIEW_OUTPUT_DIR/$dmg_name"

    [ "$(uname -s)" = "Darwin" ] || die "--unsigned-preview requires a Darwin build host"
    require_command npm
    require_command codesign
    [ -x "$MACOS_DITTO_BIN" ] \
        || die "Required macOS system tool not found or not executable: $MACOS_DITTO_BIN"

    CLOUDSMITH_API_KEY="mr-preview-disabled" \
    CLOUDSMITH_ENTITLEMENT_TOKEN="mr-preview-disabled" \
    PORTICO_RUNTIME_DISABLE_KEYCHAIN=1 \
        ensure_electron_dependencies

    rm -rf "$build_output_dir"
    mkdir -p "$build_output_dir" "$PREVIEW_OUTPUT_DIR"
    run_unsigned_preview_builder_with_retry "$arch" "$build_output_dir" \
        || die "electron-builder failed while building unsigned macOS ${arch} preview artifacts"

    case "$arch" in
        arm64) unexpected_arch="x64" ;;
        x64) unexpected_arch="arm64" ;;
    esac
    [ -z "$(find_app_in_root_for_arch "$build_output_dir" "$unexpected_arch" || true)" ] \
        || die "Unsigned ${arch} preview output contains an unexpected ${unexpected_arch} app"
    [ -z "$(find_dmg_in_root_for_arch "$build_output_dir" "$unexpected_arch" || true)" ] \
        || die "Unsigned ${arch} preview output contains an unexpected ${unexpected_arch} DMG"

    app_path="$(find_app_in_root_for_arch "$build_output_dir" "$arch" || true)"
    dmg_path="$(find_dmg_in_root_for_arch "$build_output_dir" "$arch" || true)"
    [ -n "$app_path" ] || die "Failed to locate unsigned ${arch} preview app"
    [ -n "$dmg_path" ] || die "Failed to locate unsigned ${arch} preview DMG"
    verify_packaged_app_matches_arch "$app_path" "$arch"
    verify_packaged_app_release_integrity "$app_path"
    verify_packaged_app_host_mcp_binaries "$app_path"

    developer_authority="$(codesign -dv --verbose=4 "$app_path" 2>&1 | sed -n 's/^Authority=//p' || true)"
    [ -z "$developer_authority" ] \
        || die "Unsigned preview unexpectedly contains a signing authority: $developer_authority"

    rm -f "$app_zip_path" "$dmg_output_path"
    "$MACOS_DITTO_BIN" -c -k --sequesterRsrc --keepParent "$app_path" "$app_zip_path" \
        || die "Failed to create Apple-preserving unsigned preview app ZIP"
    cp -p "$dmg_path" "$dmg_output_path"

    cat > "$PREVIEW_OUTPUT_DIR/preview-manifest.json" <<EOF
{
  "schemaVersion": 1,
  "buildNumber": "${BUILD_ID}",
  "fullSha": "${FULL_SHA}",
  "timestamp": "${RELEASE_TIMESTAMP}",
  "architecture": "darwin-${arch}",
  "signed": false,
  "appArchive": "${app_zip_name}",
  "dmg": "${dmg_name}"
}
EOF

    success "Created unsigned ${arch} preview app ZIP: $app_zip_path"
    success "Created unsigned ${arch} preview DMG: $dmg_output_path"
}

assert_mr_stage_has_no_release_credentials() {
    local name
    for name in \
        HARBOR_TOKEN \
        APPLE_CODESIGN_P12_BASE64 \
        APPLE_CODESIGN_P12_PASSWORD \
        APPLE_ID \
        APPLE_APP_SPECIFIC_PASSWORD \
        CLOUDSMITH_API_KEY \
        CLOUDSMITH_ENTITLEMENT_TOKEN
    do
        [ -z "${!name:-}" ] \
            || die "--unsigned-mr-stage refuses credential-bearing environment variable: $name"
    done
}

stage_unsigned_mr_release_inputs() {
    local helper="$SOURCE_STAGE_DIR/$MR_RELEASE_INPUT_HELPER_RELATIVE"
    local arch=""
    local preview_dir=""
    local app_archive=""
    local app_count=""
    local target_archive=""

    [ "$(uname -s)" = "Darwin" ] || die "--unsigned-mr-stage requires a Darwin build host"
    require_command python3
    [ -f "$helper" ] || die "MR release input helper is missing: $helper"
    if [ -e "$MR_STAGE_OUTPUT_DIR" ] \
        && find "$MR_STAGE_OUTPUT_DIR" -mindepth 1 -print -quit 2>/dev/null | grep -q .; then
        die "MR stage output directory must be empty: $MR_STAGE_OUTPUT_DIR"
    fi
    mkdir -p "$MR_STAGE_OUTPUT_DIR/apps/darwin-arm64" \
        "$MR_STAGE_OUTPUT_DIR/apps/darwin-x64"

    for arch in arm64 x64; do
        preview_dir="$TEMP_DIR/mr-preview/$arch"
        UNSIGNED_PREVIEW_ARCH="$arch"
        PREVIEW_OUTPUT_DIR="$preview_dir"
        build_unsigned_preview
        app_count="$(find "$preview_dir" -maxdepth 1 -type f -name '*.app.zip' | wc -l | tr -d ' ')"
        [ "$app_count" = 1 ] \
            || die "Expected exactly one unsigned ${arch} app archive, found $app_count"
        app_archive="$(find "$preview_dir" -maxdepth 1 -type f -name '*.app.zip' -print -quit)"
        target_archive="$MR_STAGE_OUTPUT_DIR/apps/darwin-${arch}/Portico.app.zip"
        cp -p "$app_archive" "$target_archive"
    done

    stage_managed_root
    sync_directory_contents "$PAYLOAD_STAGE_DIR/managed-root" "$MR_STAGE_OUTPUT_DIR/managed-root"
    sync_directory_contents "$HOST_MCP_SOURCE_DIR" "$MR_STAGE_OUTPUT_DIR/host-mcp-binaries"

    python3 "$helper" \
        --root "$MR_STAGE_OUTPUT_DIR" \
        --output "$MR_STAGE_OUTPUT_DIR/mr-release-input.json" \
        --project-id "$MR_PROJECT_ID" \
        --project-path "$MR_PROJECT_PATH" \
        --mr-iid "$MR_IID" \
        --target-branch "$MR_TARGET_BRANCH" \
        --source-revision "$FULL_SHA" \
        --build-number "$BUILD_ID" \
        --release-timestamp "$RELEASE_TIMESTAMP"

    success "Created credential-free MR release inputs: $MR_STAGE_OUTPUT_DIR"
}

verify_packaged_app_host_mcp_binaries() {
    local app_path="$1"
    local host_binaries_dir="$app_path/Contents/Resources/host-mcp-binaries"
    local target_triple
    local binary_path
    local description

    [ -d "$host_binaries_dir" ] || die "Packaged app is missing host-mcp-binaries: $app_path"

    for target_triple in aarch64-apple-darwin x86_64-apple-darwin; do
        binary_path="$host_binaries_dir/$target_triple/mcp-orc"
        [ -x "$binary_path" ] || die "Packaged app is missing executable mcp-orc for ${target_triple}: $binary_path"

        if command -v file >/dev/null 2>&1; then
            description="$(file -b "$binary_path" 2>/dev/null || true)"
            case "$target_triple" in
                aarch64-apple-darwin)
                    [[ "$description" == *Mach-O*arm64* ]] || die "Bundled mcp-orc has the wrong architecture for ${target_triple}: ${description:-unknown}"
                    ;;
                x86_64-apple-darwin)
                    [[ "$description" == *Mach-O*x86_64* ]] || die "Bundled mcp-orc has the wrong architecture for ${target_triple}: ${description:-unknown}"
                    ;;
            esac
        fi
    done
}

verify_packaged_app_release_integrity() {
    local app_path="$1"
    local packaged_build_info="$app_path/Contents/Resources/build-info.json"
    local staged_build_info="$SOURCE_STAGE_DIR/electron-app/build-info.json"
    local packaged_prereq_download="$app_path/Contents/Resources/prereq-scripts/prereq-download.sh"
    local staged_prereq_download="$SOURCE_STAGE_DIR/src/scripts/prereq-download.sh"
    local packaged_reconcile_helper="$app_path/Contents/Resources/prereq-scripts/managed-runtime-reconcile.sh"
    local staged_reconcile_helper="$SOURCE_STAGE_DIR/src/scripts/managed-runtime-reconcile.sh"
    local packaged_update_preparer="$app_path/Contents/Resources/prereq-scripts/prepare-update-cloudsmith.sh"
    local staged_update_preparer="$SOURCE_STAGE_DIR/electron-app/src/scripts/prepare-update-cloudsmith.sh"
    local packaged_cloudsmith_resource="$app_path/Contents/Resources/cloudsmith.env"
    local staged_cloudsmith_resource="$SOURCE_STAGE_DIR/electron-app/build-resources/cloudsmith.env"
    local cloudsmith_resource_validator="$SOURCE_STAGE_DIR/electron-app/scripts/prepare-cloudsmith-resource.js"
    local packaged_build_number
    local packaged_full_sha
    local packaged_short_sha

    [ -f "$packaged_build_info" ] || die "Packaged app is missing build-info.json: $app_path"
    [ -f "$staged_build_info" ] || die "Staged source is missing electron-app/build-info.json: $staged_build_info"
    cmp -s "$packaged_build_info" "$staged_build_info" \
        || die "Packaged app build-info.json does not match staged source metadata: $app_path"

    [ -f "$packaged_prereq_download" ] || die "Packaged app is missing prereq-download.sh: $packaged_prereq_download"
    [ -f "$staged_prereq_download" ] || die "Staged source is missing prereq-download.sh: $staged_prereq_download"
    cmp -s "$packaged_prereq_download" "$staged_prereq_download" \
        || die "Packaged app prereq-download.sh does not match staged source: $app_path"
    [ -f "$packaged_reconcile_helper" ] || die "Packaged app is missing managed-runtime-reconcile.sh: $packaged_reconcile_helper"
    [ -f "$staged_reconcile_helper" ] || die "Staged source is missing managed-runtime-reconcile.sh: $staged_reconcile_helper"
    cmp -s "$packaged_reconcile_helper" "$staged_reconcile_helper" \
        || die "Packaged app managed-runtime-reconcile.sh does not match staged source: $app_path"
    [ -f "$packaged_update_preparer" ] || die "Packaged app is missing prepare-update-cloudsmith.sh: $packaged_update_preparer"
    [ -f "$staged_update_preparer" ] || die "Staged source is missing prepare-update-cloudsmith.sh: $staged_update_preparer"
    cmp -s "$packaged_update_preparer" "$staged_update_preparer" \
        || die "Packaged app prepare-update-cloudsmith.sh does not match staged source: $app_path"

    [ -f "$cloudsmith_resource_validator" ] || die "Staged source is missing the Cloudsmith resource validator: $cloudsmith_resource_validator"
    [ -f "$staged_cloudsmith_resource" ] || die "Staged source is missing the prepared Cloudsmith resource: $staged_cloudsmith_resource"
    [ -f "$packaged_cloudsmith_resource" ] || die "Packaged app is missing the prepared Cloudsmith resource: $packaged_cloudsmith_resource"
    node "$cloudsmith_resource_validator" \
        --validate "$packaged_cloudsmith_resource" \
        --expected "$staged_cloudsmith_resource" \
        >/dev/null \
        || die "Packaged app Cloudsmith resource does not match the sanitized release resource: $app_path"

    packaged_build_number="$(json_string_field_from_file "$packaged_build_info" "buildNumber")"
    packaged_full_sha="$(json_string_field_from_file "$packaged_build_info" "fullSha")"

    [ -n "$packaged_build_number" ] || die "Packaged app build-info.json is missing buildNumber: $packaged_build_info"
    [ -n "$packaged_full_sha" ] || die "Packaged app build-info.json is missing fullSha: $packaged_build_info"
    [ "$packaged_build_number" = "$BUILD_ID" ] \
        || die "Packaged app buildNumber mismatch: expected ${BUILD_ID}, found ${packaged_build_number}"
    [ "$packaged_full_sha" = "$FULL_SHA" ] \
        || die "Packaged app fullSha mismatch: expected ${FULL_SHA}, found ${packaged_full_sha}"

    if [ "$packaged_build_number" != "dev-build" ] && [ "$packaged_full_sha" != "unknown" ] && [ ${#packaged_full_sha} -ge 8 ]; then
        packaged_short_sha="${packaged_full_sha:0:8}"
        case "$packaged_build_number" in
            *-"$packaged_short_sha")
                ;;
            *)
                die "Packaged app build-info.json is internally inconsistent: buildNumber=${packaged_build_number} fullSha=${packaged_full_sha}"
                ;;
        esac
    fi
}

verify_macos_app_trust_for_release() {
    local app_path="$1"

    codesign --verify --deep --strict --verbose=2 "$app_path" >/dev/null
    spctl --assess --type execute --verbose=2 "$app_path" >/dev/null
    xcrun stapler validate "$app_path" >/dev/null
}

verify_macos_dmg_trust_for_release() {
    local dmg_path="$1"

    [ -f "$dmg_path" ] || die "macOS DMG is missing: $dmg_path"
    codesign --verify --strict --verbose=2 "$dmg_path" >/dev/null
    spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg_path" >/dev/null
    xcrun stapler validate "$dmg_path" >/dev/null
}

validate_macos_artifact_pair_for_release() {
    local app_path="$1"
    local dmg_path="$2"
    local arch="$3"

    verify_packaged_app_matches_arch "$app_path" "$arch"
    verify_packaged_app_release_integrity "$app_path"
    verify_packaged_app_host_mcp_binaries "$app_path"
    verify_macos_app_trust_for_release "$app_path"
    verify_macos_dmg_trust_for_release "$dmg_path"
}

set_arch_artifact_force_rebuild() {
    local arch="$1"
    local value="$2"

    case "$arch" in
        arm64)
            ARM64_ARTIFACT_FORCE_REBUILD="$value"
            ;;
        x64)
            X64_ARTIFACT_FORCE_REBUILD="$value"
            ;;
        *)
            die "Unsupported architecture: $arch"
            ;;
    esac
}

arch_artifact_force_rebuild() {
    local arch="$1"

    case "$arch" in
        arm64)
            [ "$ARM64_ARTIFACT_FORCE_REBUILD" = true ]
            ;;
        x64)
            [ "$X64_ARTIFACT_FORCE_REBUILD" = true ]
            ;;
        *)
            die "Unsupported architecture: $arch"
            ;;
    esac
}

preflight_macos_artifacts_for_arch() {
    local arch="$1"
    local app_var
    local dmg_var
    local app_explicit_var
    local dmg_explicit_var
    local app_value
    local dmg_value
    local app_explicit
    local dmg_explicit
    local validation_output
    local validation_status
    local validation_summary

    case "$arch" in
        arm64)
            app_var="APP_ARM64"
            dmg_var="DMG_ARM64"
            app_explicit_var="APP_ARM64_EXPLICIT"
            dmg_explicit_var="DMG_ARM64_EXPLICIT"
            ;;
        x64)
            app_var="APP_X64"
            dmg_var="DMG_X64"
            app_explicit_var="APP_X64_EXPLICIT"
            dmg_explicit_var="DMG_X64_EXPLICIT"
            ;;
        *)
            die "Unsupported architecture: $arch"
            ;;
    esac

    set_arch_artifact_force_rebuild "$arch" false

    app_value="${!app_var}"
    dmg_value="${!dmg_var}"
    app_explicit="${!app_explicit_var}"
    dmg_explicit="${!dmg_explicit_var}"

    if [ "$PACKAGE_CACHE_INITIALIZED" = true ] \
        && [ "$PACKAGE_SOURCE_CLEAN" != true ] \
        && [ "$app_explicit" != true ] \
        && [ "$dmg_explicit" != true ]; then
        if [ "$(uname -s)" != "Darwin" ]; then
            die "Dirty managed source requires explicit current macOS ${arch} artifacts on non-macOS hosts"
        fi
        warn "Managed source is dirty; bypassing persistent macOS ${arch} artifact reuse"
        printf -v "$app_var" '%s' ""
        printf -v "$dmg_var" '%s' ""
        set_arch_artifact_force_rebuild "$arch" true
        return 0
    fi

    if [ -z "$app_value" ]; then
        app_value="$(locate_existing_app_for_arch "$arch" || true)"
    fi
    if [ -z "$dmg_value" ]; then
        dmg_value="$(locate_existing_dmg_for_arch "$arch" || true)"
    fi

    if [ -z "$app_value" ] || [ -z "$dmg_value" ]; then
        if [ "$(uname -s)" != "Darwin" ]; then
            die "Missing macOS ${arch} artifacts on non-macOS host; pass --app-${arch} and --dmg-${arch}"
        fi
        return 0
    fi

    set +e
    validation_output="$(PACKAGE_FOR_RELEASE_PLAIN_ERRORS=true \
        validate_macos_artifact_pair_for_release "$app_value" "$dmg_value" "$arch" 2>&1)"
    validation_status=$?
    set -e

    if [ "$validation_status" -eq 0 ]; then
        printf -v "$app_var" '%s' "$app_value"
        printf -v "$dmg_var" '%s' "$dmg_value"
        return 0
    fi

    validation_summary="$(printf '%s' "$validation_output" | tr '\n' ' ' | sed 's/[[:space:]][[:space:]]*/ /g; s/^ //; s/ $//')"

    if [ "$app_explicit" = true ] || [ "$dmg_explicit" = true ]; then
        die "Explicit macOS ${arch} artifacts failed release validation: ${app_value}${validation_summary:+ (${validation_summary})}"
    fi

    if [ "$(uname -s)" != "Darwin" ]; then
        die "Auto-discovered macOS ${arch} artifacts are stale and cannot be rebuilt on this host: ${app_value}${validation_summary:+ (${validation_summary})}"
    fi

    warn "Auto-discovered macOS ${arch} artifacts are stale and will be rebuilt on macOS: ${app_value}${validation_summary:+ (${validation_summary})}"
    printf -v "$app_var" '%s' ""
    printf -v "$dmg_var" '%s' ""
    set_arch_artifact_force_rebuild "$arch" true
}

preflight_macos_artifacts() {
    preflight_macos_artifacts_for_arch "arm64"
    preflight_macos_artifacts_for_arch "x64"
}

notarize_dmg_artifact() {
    local dmg_path="$1"

    log "Submitting DMG for notarization: $dmg_path"
    xcrun notarytool submit "$dmg_path" \
        --apple-id "$APPLE_ID" \
        --password "$APPLE_APP_SPECIFIC_PASSWORD" \
        --team-id "$APPLE_TEAM_ID" \
        --wait \
        --no-progress \
        >/dev/null
}

verify_and_staple_artifacts() {
    local app_path="$1"
    local dmg_path="$2"

    verify_packaged_app_release_integrity "$app_path"
    verify_packaged_app_host_mcp_binaries "$app_path"

    log "Verifying code signature: $app_path"
    codesign --verify --deep --strict --verbose=2 "$app_path" >/dev/null

    log "Stapling notarization ticket: $app_path"
    xcrun stapler staple "$app_path" >/dev/null
    log "Reverifying code signature after stapling: $app_path"
    verify_macos_app_trust_for_release "$app_path"

    log "Verifying DMG code signature before notarization: $dmg_path"
    codesign --verify --strict --verbose=2 "$dmg_path" >/dev/null

    notarize_dmg_artifact "$dmg_path"

    log "Stapling notarization ticket: $dmg_path"
    xcrun stapler staple "$dmg_path" >/dev/null
    log "Reverifying DMG signature, Gatekeeper status, and ticket after stapling: $dmg_path"
    verify_macos_dmg_trust_for_release "$dmg_path"
}

record_built_arch_artifacts() {
    local arch="$1"
    local app_path="$2"
    local dmg_path="$3"

    case "$arch" in
        arm64)
            APP_ARM64="$app_path"
            DMG_ARM64="$dmg_path"
            ARM64_ARTIFACT_PROVENANCE="built signed/notarized arm64 macOS app + DMG in this run"
            ;;
        x64)
            APP_X64="$app_path"
            DMG_X64="$dmg_path"
            X64_ARTIFACT_PROVENANCE="built signed/notarized x64 macOS app + DMG in this run"
            ;;
        *)
            die "Unsupported macOS architecture: $arch"
            ;;
    esac
}

finalize_output_dir_macos_artifacts() {
    local output_dir="$1"
    local expected_arch="$2"
    local unexpected_arch=""
    local app_path=""
    local dmg_path=""
    local unexpected_app=""
    local unexpected_dmg=""

    case "$expected_arch" in
        arm64) unexpected_arch="x64" ;;
        x64) unexpected_arch="arm64" ;;
        *) die "Unsupported macOS architecture: $expected_arch" ;;
    esac

    unexpected_app="$(find_app_in_root_for_arch "$output_dir" "$unexpected_arch" || true)"
    unexpected_dmg="$(find_dmg_in_root_for_arch "$output_dir" "$unexpected_arch" || true)"
    [ -z "$unexpected_app" ] \
        || die "macOS ${expected_arch} build directory contains an unexpected ${unexpected_arch} app: $unexpected_app"
    [ -z "$unexpected_dmg" ] \
        || die "macOS ${expected_arch} build directory contains an unexpected ${unexpected_arch} DMG: $unexpected_dmg"

    app_path="$(find_app_in_root_for_arch "$output_dir" "$expected_arch" || true)"
    dmg_path="$(find_dmg_in_root_for_arch "$output_dir" "$expected_arch" || true)"
    [ -n "$app_path" ] || die "Failed to locate ${expected_arch} macOS app in ${output_dir}"
    [ -n "$dmg_path" ] || die "Failed to locate ${expected_arch} macOS DMG in ${output_dir}"

    verify_and_staple_artifacts "$app_path" "$dmg_path"
    record_built_arch_artifacts "$expected_arch" "$app_path" "$dmg_path"
}

build_macos_artifacts_for_arch() {
    local arch="$1"
    local output_dir="$SOURCE_STAGE_DIR/electron-app/dist/release-build/darwin-${arch}"
    local app_var
    local dmg_var

    ensure_macos_build_environment
    ensure_electron_dependencies

    if [ "$PACKAGE_SOURCE_CLEAN" = true ] && [ -n "$MACOS_ARTIFACT_CACHE_ROOT" ]; then
        output_dir="$MACOS_ARTIFACT_CACHE_ROOT/darwin-${arch}"
        assert_marked_package_cache_path "$output_dir"
    fi

    rm -rf "$output_dir"
    mkdir -p "$output_dir"

    run_electron_builder_with_retry "$arch" "$output_dir" || die "electron-builder failed while building macOS ${arch} artifacts"

    finalize_output_dir_macos_artifacts "$output_dir" "$arch"

    case "$arch" in
        arm64)
            app_var="APP_ARM64"
            dmg_var="DMG_ARM64"
            ;;
        x64)
            app_var="APP_X64"
            dmg_var="DMG_X64"
            ;;
        *)
            die "Unsupported macOS architecture: $arch"
            ;;
    esac

    [ -n "${!app_var}" ] || die "Failed to locate ${arch} .app bundle in ${output_dir}"
    [ -n "${!dmg_var}" ] || die "Failed to locate ${arch} DMG in ${output_dir}"
}

ensure_arch_artifacts() {
    local arch="$1"
    local app_var
    local dmg_var
    local app_value
    local dmg_value

    case "$arch" in
        arm64)
            app_var="APP_ARM64"
            dmg_var="DMG_ARM64"
            ;;
        x64)
            app_var="APP_X64"
            dmg_var="DMG_X64"
            ;;
        *)
            die "Unsupported architecture: $arch"
            ;;
    esac

    if arch_artifact_force_rebuild "$arch"; then
        if [ "$(uname -s)" != "Darwin" ]; then
            die "Missing current macOS ${arch} artifacts on non-macOS host; pass fresh --app-${arch} and --dmg-${arch}"
        fi
        build_macos_artifacts_for_arch "$arch"
        return 0
    fi

    app_value="${!app_var}"
    dmg_value="${!dmg_var}"

    if [ -z "$app_value" ]; then
        app_value="$(locate_existing_app_for_arch "$arch" || true)"
    fi
    if [ -z "$dmg_value" ]; then
        dmg_value="$(locate_existing_dmg_for_arch "$arch" || true)"
    fi

    if [ -n "$app_value" ] && [ -n "$dmg_value" ]; then
        verify_packaged_app_matches_arch "$app_value" "$arch"
        verify_packaged_app_release_integrity "$app_value"
        verify_packaged_app_host_mcp_binaries "$app_value"
        printf -v "$app_var" '%s' "$app_value"
        printf -v "$dmg_var" '%s' "$dmg_value"
        case "$arch" in
            arm64)
                ARM64_ARTIFACT_PROVENANCE="reused existing arm64 macOS app + DMG from ${app_value} and ${dmg_value}"
                ;;
            x64)
                X64_ARTIFACT_PROVENANCE="reused existing x64 macOS app + DMG from ${app_value} and ${dmg_value}"
                ;;
        esac
        log "Reusing existing macOS ${arch} artifacts"
        return 0
    fi

    if [ "$(uname -s)" != "Darwin" ]; then
        die "Missing macOS ${arch} artifacts on non-macOS host; pass --app-${arch} and --dmg-${arch}"
    fi

    build_macos_artifacts_for_arch "$arch"
}

stage_managed_root() {
    local managed_root_dir="$PAYLOAD_STAGE_DIR/managed-root"
    local ootb_config_source="$SOURCE_STAGE_DIR/marketplaces-ootb/marketplaces.json"
    local ootb_skills_source="$SOURCE_STAGE_DIR/marketplaces-ootb/skills-marketplace"
    local include_dirs=(
        "agents"
        "docker"
        "electron-app"
        "mcp-configs"
        "skills"
        "src"
    )
    local include_files=(
        "bootstrap.sh"
        "Dockerfile.bifrost-bridge"
        "docker-compose.advanced.yml"
        "docker-compose.yml"
        "install_v2.sh"
        "model_catalog.yaml"
        "mcp-container-groups.json"
        "optimization_flags.json"
        "system-env-presets.yaml"
    )
    local rel_path
    local source_path
    local dest_path

    mkdir -p "$managed_root_dir"

    for rel_path in "${include_dirs[@]}"; do
        source_path="$SOURCE_STAGE_DIR/$rel_path"
        dest_path="$managed_root_dir/$rel_path"
        [ -d "$source_path" ] || continue
        mkdir -p "$dest_path"
        case "$rel_path" in
            electron-app)
                rsync -a --no-specials --no-devices \
                    --exclude ".atlas-flow" \
                    --exclude ".swarm" \
                    --exclude "node_modules" \
                    --exclude "dist" \
                    --exclude "dist-update" \
                    --exclude "dist-backup" \
                    --exclude "dist-update-prepared" \
                    --exclude "tests" \
                    --exclude "playwright.config.js" \
                    --exclude "docker-compose.dev.yml" \
                    --exclude "docker-compose.build.yml" \
                    --exclude "Dockerfile.electron-build" \
                    --exclude "README.md" \
                    --exclude "scripts/notarize.js" \
                    --exclude "assets/*.psd" \
                    --exclude "assets/Icon Exports" \
                    --exclude "assets/icon-composer.icon" \
                    --exclude "assets/icon-composer-prj.icon" \
                    "$source_path"/ "$dest_path"/
                ;;
            *)
                rsync -a --no-specials --no-devices \
                    --exclude "__pycache__" \
                    --exclude ".pytest_cache" \
                    --exclude "target" \
                    "$source_path"/ "$dest_path"/
                ;;
        esac
    done

    # Loud seed accounting: seedless releases are legal (the seed job is
    # allow_failure), but a payload staged WITHOUT seeds must say so in the
    # job log - a silent omission cost beta-staging its instant cold boots
    # (08042026-1ccf6df6: repackaging job lacked the seed artifacts edge).
    # built_at accounting: clients invalidate seeds for DIET use at 14 days
    # (full crawls resume fleet-wide), so packaging warns at 7 to nudge the
    # release cadence. Decompression and date math live inside node on
    # purpose: a `gunzip -c | head` pipe dies of SIGPIPE under pipefail,
    # and BSD vs GNU `date` cannot both parse RFC3339.
    local seed_file seed_age_status
    for seed_file in users_seed_v1.json.gz channels_seed_v1.json.gz; do
        if [ -f "$managed_root_dir/mcp-configs/slack/$seed_file" ]; then
            seed_age_status="$(node -e '
                const zlib = require("zlib"), fs = require("fs");
                try {
                    const raw = fs.readFileSync(process.argv[1]);
                    const data = raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw;
                    const head = data.subarray(0, 4096).toString("utf8").trimStart();
                    const m = head.startsWith("{") && head.match(/"built_at"\s*:\s*"([^"]+)"/);
                    const ageDays = m ? (Date.now() - Date.parse(m[1])) / 86400000 : NaN;
                    if (!Number.isFinite(ageDays)) { console.log("legacy"); process.exit(0); }
                    console.log((ageDays > 7 ? "old " : "ok ") + ageDays.toFixed(1));
                } catch (e) { console.log("unreadable"); }
            ' "$managed_root_dir/mcp-configs/slack/$seed_file" 2>/dev/null || echo unreadable)"
            case "$seed_age_status" in
                ok\ *)
                    log "Slack seed staged into payload: $seed_file (built_at ${seed_age_status#ok } days old)"
                    ;;
                old\ *)
                    warn "Slack seed staged into payload but AGING: $seed_file is ${seed_age_status#old } days old (clients invalidate diets at 14d - cut releases at least every 2 weeks)"
                    ;;
                legacy)
                    warn "Slack seed staged into payload without built_at (legacy bare format): $seed_file (diet-ineligible on clients)"
                    ;;
                *)
                    warn "Slack seed staged into payload but unreadable for built_at accounting: $seed_file"
                    ;;
            esac
        else
            warn "Slack seed ABSENT from payload: $seed_file (clients will fall back to the live crawl)"
        fi
    done

    local sanitized_cloudsmith_resource="$SOURCE_STAGE_DIR/electron-app/build-resources/cloudsmith.env"
    local staged_cloudsmith_resource="$managed_root_dir/cloudsmith.env"
    local cloudsmith_resource_validator="$SOURCE_STAGE_DIR/electron-app/scripts/prepare-cloudsmith-resource.js"
    [ -f "$sanitized_cloudsmith_resource" ] \
        || die "Sanitized Cloudsmith resource is missing from staged source: $sanitized_cloudsmith_resource"
    cp -p "$sanitized_cloudsmith_resource" "$staged_cloudsmith_resource"
    node "$cloudsmith_resource_validator" \
        --validate "$staged_cloudsmith_resource" \
        --expected "$sanitized_cloudsmith_resource" \
        >/dev/null \
        || die "Managed runtime Cloudsmith resource does not match the sanitized app resource"

    for rel_path in "${include_files[@]}"; do
        source_path="$SOURCE_STAGE_DIR/$rel_path"
        dest_path="$managed_root_dir/$rel_path"
        [ -f "$source_path" ] || continue
        mkdir -p "$(dirname "$dest_path")"
        cp -p "$source_path" "$dest_path"
    done

    [ -f "$ootb_config_source" ] \
        || die "Checked-in OOTB marketplace config is missing: $ootb_config_source"
    [ -d "$ootb_skills_source" ] \
        || die "Checked-in OOTB marketplace skills are missing: $ootb_skills_source"

    cp -p "$ootb_config_source" "$managed_root_dir/marketplaces-ootb.json"
    rm -rf "$managed_root_dir/skills-marketplace-ootb"
    mkdir -p "$managed_root_dir/skills-marketplace-ootb"
    rsync -a --no-specials --no-devices \
        --exclude ".DS_Store" \
        "$ootb_skills_source"/ \
        "$managed_root_dir/skills-marketplace-ootb"/
}

copy_directory_artifact() {
    local source_dir="$1"
    local dest_dir="$2"

    mkdir -p "$(dirname "$dest_dir")"
    rm -rf "$dest_dir"

    if command -v ditto >/dev/null 2>&1; then
        ditto "$source_dir" "$dest_dir"
    else
        cp -R "$source_dir" "$dest_dir"
    fi
}

copy_file_artifact() {
    local source_file="$1"
    local dest_file="$2"

    mkdir -p "$(dirname "$dest_file")"
    cp -p "$source_file" "$dest_file"
}

host_mcp_targets_json() {
    local host_dir="$1"
    local first=true
    local target

    printf '['
    while IFS= read -r target; do
        if [ "$first" = true ]; then
            first=false
        else
            printf ', '
        fi
        printf '"%s"' "$target"
    done < <(find "$host_dir" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort)
    printf ']'
}

docker_images_json_for_release_manifest() {
    local managed_root_dir="$1"
    local planner_module="$SOURCE_STAGE_DIR/electron-app/src/services/docker-image-plan.js"

    require_command node
    [ -d "$managed_root_dir" ] || die "Managed runtime tree not found while building release manifest: $managed_root_dir"
    [ -f "$planner_module" ] || die "Docker image planner not found: $planner_module"

    node - "$planner_module" "$managed_root_dir" "$DOCKER_IMAGE_TAG" <<'NODE'
const [plannerModulePath, projectRoot, tag] = process.argv.slice(2);
const { buildDockerImagesToPull } = require(plannerModulePath);

const images = buildDockerImagesToPull({
  projectRoot,
  tag,
});

process.stdout.write(JSON.stringify(images, null, 2));
NODE
}

write_release_manifest() {
    local host_targets="$1"
    local docker_images="$2"
    local dmg_arm64_name
    local dmg_x64_name

    dmg_arm64_name="$(basename "$DMG_ARM64")"
    dmg_x64_name="$(basename "$DMG_X64")"

    cat > "$PAYLOAD_STAGE_DIR/release-manifest.json" <<EOF
{
  "schemaVersion": 2,
  "buildNumber": "${BUILD_ID}",
  "fullSha": "${FULL_SHA}",
  "channelPackageName": "${CHANNEL_PACKAGE_NAME}",
  "managedRootDir": "managed-root",
  "dockerImageTag": "${DOCKER_IMAGE_TAG}",
  "dockerImages": ${docker_images},
  "appBundles": {
    "darwin-arm64": "artifacts/apps/darwin-arm64/${APP_BUNDLE_NAME}",
    "darwin-x64": "artifacts/apps/darwin-x64/${APP_BUNDLE_NAME}"
  },
  "dmgs": {
    "darwin-arm64": "artifacts/dmg/darwin-arm64/${dmg_arm64_name}",
    "darwin-x64": "artifacts/dmg/darwin-x64/${dmg_x64_name}"
  },
  "hostMcpTargets": ${host_targets}
EOF
    if [ -n "$RUNTIME_IMAGE_ATTESTATION" ]; then
        printf ',\n  "runtimeImageAttestation": "runtime-image-attestation.json"' \
            >> "$PAYLOAD_STAGE_DIR/release-manifest.json"
    fi
    printf '\n}\n' >> "$PAYLOAD_STAGE_DIR/release-manifest.json"
}

stage_payload_contents() {
    local artifacts_root="$PAYLOAD_STAGE_DIR/artifacts"
    local host_targets
    local docker_images

    stage_managed_root

    sync_directory_contents "$HOST_MCP_SOURCE_DIR" "$PAYLOAD_STAGE_DIR/host-mcp-binaries"

    copy_directory_artifact "$APP_ARM64" "$artifacts_root/apps/darwin-arm64/$APP_BUNDLE_NAME"
    copy_directory_artifact "$APP_X64" "$artifacts_root/apps/darwin-x64/$APP_BUNDLE_NAME"
    verify_packaged_app_matches_arch "$artifacts_root/apps/darwin-arm64/$APP_BUNDLE_NAME" arm64
    verify_packaged_app_matches_arch "$artifacts_root/apps/darwin-x64/$APP_BUNDLE_NAME" x64
    verify_packaged_app_release_integrity "$artifacts_root/apps/darwin-arm64/$APP_BUNDLE_NAME"
    verify_packaged_app_release_integrity "$artifacts_root/apps/darwin-x64/$APP_BUNDLE_NAME"
    verify_packaged_app_host_mcp_binaries "$artifacts_root/apps/darwin-arm64/$APP_BUNDLE_NAME"
    verify_packaged_app_host_mcp_binaries "$artifacts_root/apps/darwin-x64/$APP_BUNDLE_NAME"
    copy_file_artifact "$DMG_ARM64" "$artifacts_root/dmg/darwin-arm64/$(basename "$DMG_ARM64")"
    copy_file_artifact "$DMG_X64" "$artifacts_root/dmg/darwin-x64/$(basename "$DMG_X64")"

    if [ -n "$RUNTIME_IMAGE_ATTESTATION" ]; then
        copy_file_artifact \
            "$RUNTIME_IMAGE_ATTESTATION" \
            "$PAYLOAD_STAGE_DIR/runtime-image-attestation.json"
        validate_runtime_image_attestation_path \
            "$PAYLOAD_STAGE_DIR/runtime-image-attestation.json"
    fi

    host_targets="$(host_mcp_targets_json "$PAYLOAD_STAGE_DIR/host-mcp-binaries")"
    docker_images="$(docker_images_json_for_release_manifest "$PAYLOAD_STAGE_DIR/managed-root")"
    write_release_manifest "$host_targets" "$docker_images"

    log "Validating copied payload artifacts, signatures, and notarization tickets..."
    validate_release_payload_path "$PAYLOAD_STAGE_DIR" true "$(basename "$OUTPUT_ZIP")" \
        || die "Staged release payload validation failed"
}

create_payload_zip() {
    [ -x "$MACOS_DITTO_BIN" ] \
        || die "Required macOS system tool not found or not executable: $MACOS_DITTO_BIN"

    mkdir -p "$(dirname "$OUTPUT_ZIP")"
    require_packaging_disk_space "$(dirname "$OUTPUT_ZIP")" "release ZIP creation"
    PARTIAL_OUTPUT_ZIP="${OUTPUT_ZIP}.partial.$$"
    rm -f "$PARTIAL_OUTPUT_ZIP"

    log "Creating release payload zip..."
    if ! "$MACOS_DITTO_BIN" -c -k --sequesterRsrc \
        "$PAYLOAD_STAGE_DIR" "$PARTIAL_OUTPUT_ZIP"; then
        rm -f "$PARTIAL_OUTPUT_ZIP"
        PARTIAL_OUTPUT_ZIP=""
        die "Failed to create release payload ZIP"
    fi

    log "Validating release payload archive, signatures, and notarization tickets before publication..."
    if ! validate_release_payload_path "$PARTIAL_OUTPUT_ZIP" true "$(basename "$OUTPUT_ZIP")"; then
        rm -f "$PARTIAL_OUTPUT_ZIP"
        PARTIAL_OUTPUT_ZIP=""
        die "Release payload archive validation failed; existing final payload was not replaced"
    fi

    mv -f "$PARTIAL_OUTPUT_ZIP" "$OUTPUT_ZIP"
    PARTIAL_OUTPUT_ZIP=""
    PAYLOAD_CREATED=true

    local size
    size="$(du -h "$OUTPUT_ZIP" | awk '{print $1}')"
    success "Created release payload: $OUTPUT_ZIP ($size)"
}

print_release_summary() {
    local elapsed_seconds
    local zip_bytes
    local manifest_path="$PAYLOAD_STAGE_DIR/release-manifest.json"
    local managed_root_path="$PAYLOAD_STAGE_DIR/managed-root"
    local host_mcp_payload_path="$PAYLOAD_STAGE_DIR/host-mcp-binaries"
    local arm64_app_payload_path="$PAYLOAD_STAGE_DIR/artifacts/apps/darwin-arm64/$APP_BUNDLE_NAME"
    local x64_app_payload_path="$PAYLOAD_STAGE_DIR/artifacts/apps/darwin-x64/$APP_BUNDLE_NAME"
    local arm64_dmg_payload_path="$PAYLOAD_STAGE_DIR/artifacts/dmg/darwin-arm64/$(basename "$DMG_ARM64")"
    local x64_dmg_payload_path="$PAYLOAD_STAGE_DIR/artifacts/dmg/darwin-x64/$(basename "$DMG_X64")"
    local payload_content_total=0
    local docker_images_total=0
    local docker_image_lines=""
    local image_name=""
    local image_ref=""
    local report=""
    local total_bytes=""
    local next_command=""

    elapsed_seconds=$(( $(date +%s) - BUILD_STARTED_AT_EPOCH ))
    zip_bytes="$(path_size_bytes "$OUTPUT_ZIP")"
    payload_content_total="$(
        printf '%s\n' \
            "$(path_size_bytes "$manifest_path")" \
            "$(path_size_bytes "$managed_root_path")" \
            "$(path_size_bytes "$host_mcp_payload_path")" \
            "$(path_size_bytes "$arm64_app_payload_path")" \
            "$(path_size_bytes "$x64_app_payload_path")" \
            "$(path_size_bytes "$arm64_dmg_payload_path")" \
            "$(path_size_bytes "$x64_dmg_payload_path")" | sum_byte_values
    )"

    for image_name in $(release_image_names); do
        image_ref="harbor.example.invalid/portico/${image_name}:${DOCKER_IMAGE_TAG}"
        if report="$(get_multiarch_image_size_report "$image_ref" 2>/dev/null)"; then
            total_bytes="$(printf '%s\n' "$report" | sed -n '1p')"
            docker_images_total=$((docker_images_total + total_bytes))
            docker_image_lines="${docker_image_lines}  - $(format_image_size_summary "$image_ref" "$report")\n"
        else
            docker_image_lines="${docker_image_lines}  - ${image_ref} -> size unavailable\n"
        fi
    done

    next_command="./release_build.sh \"$OUTPUT_ZIP\" --channel $CHANNEL"

    echo
    echo "Release Summary"
    echo "- Build id: $BUILD_ID"
    echo "- Channel: $CHANNEL (${CHANNEL_PACKAGE_NAME})"
    echo "- Full SHA: $FULL_SHA"
    echo "- Docker image tag: $DOCKER_IMAGE_TAG"
    echo "- Duration: $(format_duration "$elapsed_seconds")"
    echo
    echo "Created artifacts"
    echo "- Release payload zip: $OUTPUT_ZIP ($(format_bytes_human "$zip_bytes"))"
    echo "- Payload contents total before compression: $(format_bytes_human "$payload_content_total")"
    echo "- Included at release-manifest.json -> inside zip ($(path_size_human "$manifest_path"))"
    echo "- Included at managed-root/ -> inside zip ($(path_size_human "$managed_root_path"))"
    echo "- Included at host-mcp-binaries/ -> inside zip ($(path_size_human "$host_mcp_payload_path")); $HOST_MCP_PROVENANCE"
    echo "- Included at artifacts/apps/darwin-arm64/${APP_BUNDLE_NAME} -> inside zip ($(path_size_human "$arm64_app_payload_path")); $ARM64_ARTIFACT_PROVENANCE"
    echo "- Included at artifacts/apps/darwin-x64/${APP_BUNDLE_NAME} -> inside zip ($(path_size_human "$x64_app_payload_path")); $X64_ARTIFACT_PROVENANCE"
    echo "- Included at artifacts/dmg/darwin-arm64/$(basename "$DMG_ARM64") -> inside zip ($(path_size_human "$arm64_dmg_payload_path"))"
    echo "- Included at artifacts/dmg/darwin-x64/$(basename "$DMG_X64") -> inside zip ($(path_size_human "$x64_dmg_payload_path"))"
    echo
    echo "Docker images"
    if [ -n "$DOCKER_IMAGES_BUILT" ]; then
        echo "- Built and published in this run: $DOCKER_IMAGES_BUILT"
    fi
    if [ -n "$DOCKER_IMAGES_REUSED" ]; then
        echo "- Reused after exact-tag validation: $DOCKER_IMAGES_REUSED"
    fi
    if [ -z "$DOCKER_IMAGES_BUILT" ] && [ -z "$DOCKER_IMAGES_REUSED" ]; then
        echo "- No image build or reuse information was recorded for tag $DOCKER_IMAGE_TAG"
    fi
    printf '%b' "$docker_image_lines"
    echo "- Total published Docker image size: $(format_bytes_human "$docker_images_total")"
    echo
    echo "Next command"
    echo "- $next_command"
}

main() {
    parse_args "$@"
    confirm_or_fill_build_id
    validate_build_id
    validate_configuration
    validate_release_metadata_consistency

    if [ -n "$MR_STAGE_OUTPUT_DIR" ]; then
        assert_mr_stage_has_no_release_credentials
        preflight_release_packaging_disk_space
        log "Staging unsigned merge-request release inputs (${BUILD_ID})"
        stage_source_tree
        write_release_metadata_files
        prepare_unsigned_preview_cloudsmith_resource
        prepare_host_mcp_binaries
        stage_unsigned_mr_release_inputs
        report_checkout_changes_after_staging
        return 0
    fi

    if [ -n "$UNSIGNED_PREVIEW_ARCH" ]; then
        preflight_release_packaging_disk_space
        log "Packaging unsigned macOS ${UNSIGNED_PREVIEW_ARCH} preview (${BUILD_ID})"
        stage_source_tree
        write_release_metadata_files
        prepare_unsigned_preview_cloudsmith_resource
        prepare_host_mcp_binaries
        build_unsigned_preview
        report_checkout_changes_after_staging
        return 0
    fi

    preflight_release_packaging_disk_space
    initialize_package_cache
    resolve_cloudsmith_release_api_key
    resolve_cloudsmith_release_entitlement_token

    log "Packaging release payload for ${CHANNEL_PACKAGE_NAME} (${BUILD_ID})"
    stage_source_tree
    write_release_metadata_files
    prepare_cloudsmith_release_resource
    preflight_macos_artifacts
    prepare_release_docker_images
    prepare_host_mcp_binaries
    ensure_arch_artifacts "arm64"
    ensure_arch_artifacts "x64"
    stage_payload_contents
    create_payload_zip
    report_checkout_changes_after_staging
    if ! print_release_summary; then
        warn "Release summary generation failed after payload validation; the payload remains valid at $OUTPUT_ZIP"
        warn "Continue with: ./release_build.sh \"$OUTPUT_ZIP\" --channel $CHANNEL"
    fi
}

if [[ "${BASH_SOURCE[0]:-$0}" == "$0" ]]; then
    main "$@"
fi
