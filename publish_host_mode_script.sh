#!/usr/bin/env bash
#
# publish_host_mode_script.sh
#
# Uploads install-host-mode-deps.sh to Cloudsmith as a raw package so teammates
# can install HOST mode dependencies with a single curl | bash command.
#
# The package is always published under a stable name+version pair so the
# download URL never changes — existing versions are deleted first, then the
# new payload is pushed with --republish as a belt-and-suspenders safety net.
#
# Usage:
#   ./publish_host_mode_script.sh                      # push ./install-host-mode-deps.sh
#   ./publish_host_mode_script.sh --dry-run            # print plan only
#   ./publish_host_mode_script.sh --payload <path>     # push a different script
#   ./publish_host_mode_script.sh --version <version>  # override version tag

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# -------- Defaults (overridable via CLI) ---------------------------------

# NOTE: Cloudsmith rejects "latest" for raw packages — versions must be
# semver-shaped. We pin to a fixed semver and rely on --republish + pre-delete
# to keep the download URL stable across uploads.
PAYLOAD_PATH="${SCRIPT_DIR}/install-host-mode-deps.sh"
PACKAGE_NAME="install-host-mode-deps"
PACKAGE_VERSION="1.0.1"
DRY_RUN=false

# -------- Load Cloudsmith config -----------------------------------------

_PRESAVED_API_KEY="${CLOUDSMITH_API_KEY:-}"
if [ -f "$SCRIPT_DIR/cloudsmith.env" ]; then
    # shellcheck source=cloudsmith.env
    . "$SCRIPT_DIR/cloudsmith.env"
fi
if [ -n "$_PRESAVED_API_KEY" ]; then
    CLOUDSMITH_API_KEY="$_PRESAVED_API_KEY"
fi

CLOUDSMITH_OWNER="${CLOUDSMITH_OWNER:-portico}"
CLOUDSMITH_REPO="${CLOUDSMITH_REPO:-portico}"
CLOUDSMITH_DL_BASE="${CLOUDSMITH_DL_BASE:-https://dl.artifacts.example.invalid}"
CLOUDSMITH_ENTITLEMENT_TOKEN="${CLOUDSMITH_ENTITLEMENT_TOKEN:-}"

# -------- Logging --------------------------------------------------------

log()     { echo -e "${BLUE}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} $1"; }
warn()    { echo -e "${YELLOW}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} $1"; }
success() { echo -e "${GREEN}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} $1"; }
die()     { echo -e "${RED}[$(date '+%Y-%m-%d %H:%M:%S')] Error: $1${NC}" >&2; exit 1; }

show_usage() {
    cat <<'EOF'
Usage: ./publish_host_mode_script.sh [options]

Upload install-host-mode-deps.sh to Cloudsmith as a raw package under a stable
name+version, making it downloadable via a fixed entitlement-token URL.

Options:
  --payload <path>     Path to script to upload (default: ./install-host-mode-deps.sh)
  --version <version>  Override version tag   (default: 1.0.1)
  --name <name>        Override package name  (default: install-host-mode-deps)
  --dry-run            Print upload plan without sending anything
  --help, -h           Show this help

Download URL (printed on success) has the form:
  <CLOUDSMITH_DL_BASE>/<ENTITLEMENT_TOKEN>/<CLOUDSMITH_REPO>/raw/names/<name>/versions/<version>/<filename>

Credentials:
  CLOUDSMITH_API_KEY             Required for upload (read from cloudsmith.env or env)
  CLOUDSMITH_ENTITLEMENT_TOKEN   Embedded into the printed download URL
EOF
}

# -------- Arg parsing ----------------------------------------------------

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --payload)
                [ $# -ge 2 ] || die "--payload requires a value"
                PAYLOAD_PATH="$2"
                shift 2
                ;;
            --version)
                [ $# -ge 2 ] || die "--version requires a value"
                PACKAGE_VERSION="$2"
                shift 2
                ;;
            --name)
                [ $# -ge 2 ] || die "--name requires a value"
                PACKAGE_NAME="$2"
                shift 2
                ;;
            --dry-run)
                DRY_RUN=true
                shift
                ;;
            --help|-h)
                show_usage
                exit 0
                ;;
            *)
                show_usage >&2
                die "Unknown argument: $1"
                ;;
        esac
    done

    [ -f "$PAYLOAD_PATH" ] || die "Payload script not found: $PAYLOAD_PATH"
    PAYLOAD_PATH="$(cd "$(dirname "$PAYLOAD_PATH")" && printf '%s/%s\n' "$(pwd -P)" "$(basename "$PAYLOAD_PATH")")"
}

# -------- Cloudsmith helpers ---------------------------------------------

validate_credentials() {
    if [ "$DRY_RUN" = true ]; then
        return 0
    fi
    [ -n "${CLOUDSMITH_API_KEY:-}" ] || die "CLOUDSMITH_API_KEY is not set (add it to cloudsmith.env or export it)"
}

ensure_cloudsmith_cli() {
    export PATH="$HOME/Library/Python/3.9/bin:$HOME/.local/bin:$PATH"

    if command -v cloudsmith >/dev/null 2>&1; then
        return 0
    fi

    log "Installing cloudsmith CLI..."
    /usr/bin/pip3 install --quiet cloudsmith-cli || die "Failed to install cloudsmith-cli"
}

find_existing_cloudsmith_package() {
    local package_name="$1"
    local version="$2"
    local filename="$3"
    local query="name:^${package_name}$ version:^${version}$ format:raw"
    local result

    result="$(cloudsmith list packages "${CLOUDSMITH_OWNER}/${CLOUDSMITH_REPO}" -q "$query" -F json 2>/dev/null)" || return 1

    python3 -c '
import json
import sys

filename = sys.argv[1]
payload = json.loads(sys.stdin.read())

for pkg in payload.get("data", []):
    if pkg.get("filename") == filename:
        print("\t".join([
            pkg.get("slug", ""),
            pkg.get("uploader", ""),
            str(pkg.get("is_deleteable", "")),
            pkg.get("self_html_url", ""),
        ]))
        break
' "$filename" <<< "$result"
}

delete_existing_if_present() {
    local filename="$1"
    local existing existing_slug existing_uploader existing_url

    if [ "$DRY_RUN" = true ]; then
        log "DRY RUN: would check for existing ${PACKAGE_NAME}@${PACKAGE_VERSION}"
        return 0
    fi

    ensure_cloudsmith_cli
    export CLOUDSMITH_API_KEY

    log "Checking Cloudsmith for existing ${PACKAGE_NAME}@${PACKAGE_VERSION}..."
    if ! existing="$(find_existing_cloudsmith_package "$PACKAGE_NAME" "$PACKAGE_VERSION" "$filename")"; then
        die "Cloudsmith package lookup failed"
    fi

    if [ -z "$existing" ]; then
        log "No existing package to replace"
        return 0
    fi

    IFS=$'\t' read -r existing_slug existing_uploader _ existing_url <<< "$existing"
    warn "Found existing package: ${existing_slug} (uploader: ${existing_uploader:-unknown})"

    if ! cloudsmith delete "${CLOUDSMITH_OWNER}/${CLOUDSMITH_REPO}/${existing_slug}" -y >/dev/null; then
        die "Cloudsmith denied deleting existing package; need a key with package-delete permission"
    fi

    success "Deleted ${existing_slug}"
    [ -n "$existing_url" ] && log "Was: ${existing_url}"
}

# Build the user-facing curl command. We embed $(date +%s) literally (not
# expanded here) so it gets expanded in the END USER's shell, giving CloudFront
# a unique cache key per invocation and guaranteeing they always hit origin
# instead of a 5-minute-stale CDN edge.
#
# Rationale: Cloudsmith's `resync` endpoint would purge the edge cache, but
# requires elevated repo permissions our service API key doesn't have (403).
# The cache-bust query-string trick sidesteps the permission issue entirely
# with no server-side changes.
build_install_command() {
    local url="$1"
    printf "curl -fsSL \"%s?t=\$(date +%%s)\" | bash" "$url"
}

# -------- Upload + URL reporting -----------------------------------------

build_download_url() {
    local token="${CLOUDSMITH_ENTITLEMENT_TOKEN:-basic}"
    local filename
    filename="$(basename "$PAYLOAD_PATH")"
    printf '%s/%s/%s/raw/names/%s/versions/%s/%s\n' \
        "$CLOUDSMITH_DL_BASE" \
        "$token" \
        "$CLOUDSMITH_REPO" \
        "$PACKAGE_NAME" \
        "$PACKAGE_VERSION" \
        "$filename"
}

upload_to_cloudsmith() {
    local filename size download_url
    filename="$(basename "$PAYLOAD_PATH")"
    size="$(du -h "$PAYLOAD_PATH" | awk '{print $1}')"
    download_url="$(build_download_url)"

    if [ "$DRY_RUN" = true ]; then
        echo
        echo -e "${CYAN}========================================${NC}"
        echo -e "${CYAN}  DRY RUN - No actual upload${NC}"
        echo -e "${CYAN}========================================${NC}"
        echo
        echo -e "${BOLD}Payload:${NC}  ${PAYLOAD_PATH} (${size})"
        echo -e "${BOLD}Package:${NC}  ${PACKAGE_NAME}"
        echo -e "${BOLD}Version:${NC}  ${PACKAGE_VERSION}"
        echo -e "${BOLD}Filename:${NC} ${filename}"
        echo
        echo -e "${BOLD}Equivalent cloudsmith command:${NC}"
        echo "  cloudsmith push raw ${CLOUDSMITH_OWNER}/${CLOUDSMITH_REPO} ${PAYLOAD_PATH} \\"
        echo "    --name ${PACKAGE_NAME} --version ${PACKAGE_VERSION} --republish --no-wait-for-sync"
        echo
        echo -e "${BOLD}Download URL (after upload):${NC}"
        echo "  ${download_url}"
        echo
        echo -e "${BOLD}One-shot install command (cache-busted):${NC}"
        echo "  $(build_install_command "$download_url")"
        echo
        return 0
    fi

    ensure_cloudsmith_cli
    export CLOUDSMITH_API_KEY

    log "Uploading to Cloudsmith..."
    log "  Payload:  ${PAYLOAD_PATH} (${size})"
    log "  Package:  ${PACKAGE_NAME}"
    log "  Version:  ${PACKAGE_VERSION}"

    cloudsmith push raw "${CLOUDSMITH_OWNER}/${CLOUDSMITH_REPO}" "$PAYLOAD_PATH" \
        --name "$PACKAGE_NAME" \
        --version "$PACKAGE_VERSION" \
        --republish \
        --no-wait-for-sync \
        || die "Cloudsmith upload failed"

    success "Upload successful"

    echo
    echo -e "${CYAN}Download URL:${NC}"
    echo -e "  ${YELLOW}${download_url}${NC}"
    echo
    echo -e "${CYAN}One-shot install command (cache-busted — always fetches fresh):${NC}"
    echo -e "  ${BOLD}$(build_install_command "$download_url")${NC}"
    echo
    echo -e "${CYAN}View in Cloudsmith:${NC}"
    echo -e "  https://app.cloudsmith.com/${CLOUDSMITH_OWNER}/${CLOUDSMITH_REPO}/packages/?q=name:${PACKAGE_NAME}"
    echo
}

# -------- Main -----------------------------------------------------------

main() {
    parse_args "$@"
    validate_credentials

    local filename
    filename="$(basename "$PAYLOAD_PATH")"

    delete_existing_if_present "$filename"
    upload_to_cloudsmith
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    main "$@"
fi
