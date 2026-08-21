#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASE_PAYLOAD_VALIDATOR="$SCRIPT_DIR/src/scripts/validate-release-payload.py"
RELEASE_CHANNEL_SH="$SCRIPT_DIR/src/scripts/release-channel.sh"

if [ ! -f "$RELEASE_CHANNEL_SH" ]; then
    printf 'Error: Missing release channel helper: %s\n' "$RELEASE_CHANNEL_SH" >&2
    exit 1
fi
# shellcheck source=/dev/null
. "$RELEASE_CHANNEL_SH"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

PAYLOAD_ZIP=""
CHANNEL=""
CHANNEL_PACKAGE_NAME=""
BUILD_ID=""
DRY_RUN=false
REPUBLISH=false
WAIT_FOR_SYNC=true
MARK_UPDATE_READY=true
ASSUME_YES=false
PAYLOAD_EXPLICIT=false
CHANNEL_EXPLICIT=false
PAYLOAD_AUTODETECTED=false
SKIP_UPLOAD=false

_PRESAVED_API_KEY="${CLOUDSMITH_API_KEY:-}"
_PRESAVED_ENTITLEMENT_TOKEN="${CLOUDSMITH_ENTITLEMENT_TOKEN:-}"
_PRESAVED_DL_BASE="${CLOUDSMITH_DL_BASE:-}"
if [ -f "$SCRIPT_DIR/cloudsmith.env" ]; then
    # shellcheck source=cloudsmith.env
    . "$SCRIPT_DIR/cloudsmith.env"
fi
if [ -n "$_PRESAVED_API_KEY" ]; then
    CLOUDSMITH_API_KEY="$_PRESAVED_API_KEY"
fi
if [ -n "$_PRESAVED_ENTITLEMENT_TOKEN" ]; then
    CLOUDSMITH_ENTITLEMENT_TOKEN="$_PRESAVED_ENTITLEMENT_TOKEN"
fi
if [ -n "$_PRESAVED_DL_BASE" ]; then
    CLOUDSMITH_DL_BASE="$_PRESAVED_DL_BASE"
fi

CLOUDSMITH_OWNER="${CLOUDSMITH_OWNER:-portico}"
CLOUDSMITH_REPO="${CLOUDSMITH_REPO:-portico}"
CLOUDSMITH_DL_BASE="${CLOUDSMITH_DL_BASE:-https://dl.artifacts.example.invalid}"
UPDATE_READY_TAG="portico-update-ready-v1"
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
    echo -e "${RED}[$(date '+%Y-%m-%d %H:%M:%S')] Error: $1${NC}" >&2
    exit 1
}

show_usage() {
    cat <<'EOF'
Usage: ./release_build.sh [payload-zip] [options]

Upload a release payload zip to Cloudsmith using a built-in or custom release channel.

Options:
  [payload-zip]                    Optional payload zip path. If omitted, the newest matching zip in release/ is used.
  --channel <name>              Validate/force stable, beta, dev, or a custom channel slug
  --beta                         Shortcut for --channel beta
  --stable                       Shortcut for --channel stable
  --dev                          Shortcut for --channel dev
  --replace                      Replace an existing raw package by deleting it first
  --republish                    Alias for --replace
  --wait-for-sync               Accepted for compatibility; synchronization is required
  --mark-update-ready           Accepted for compatibility; verified readiness is required
  --yes                          Accept inferred payload and channel without prompting
  --dry-run                      Print upload details without sending anything
  --help, -h                     Show this help text

The payload zip basename must match:
  <channel-package-name>-<build-id>.zip

Channel package names:
  stable -> portico
  beta   -> portico_beta
  dev    -> portico_dev
  <slug> -> portico_<slug>
EOF
}

channel_to_package_name() {
    release_channel_to_package_name "$1" \
        || die "Invalid release channel: $1. Use stable, beta, dev, or a 1-64 character lowercase slug containing letters, numbers, hyphens, or underscores."
}

package_name_to_channel() {
    release_package_name_to_channel "$1"
}

is_interactive_session() {
    [ -t 0 ] && [ -t 1 ]
}

require_interactive_prompt_capability() {
    is_interactive_session || die "Interactive confirmation is required; rerun with an explicit payload zip path and/or --channel"
}

confirm_yes_no() {
    local prompt="$1"
    local response

    read -r -p "$prompt [Y/n] " response
    response="${response:-Y}"
    case "$response" in
        Y|y|yes|YES) return 0 ;;
        N|n|no|NO) return 1 ;;
        *)
            warn "Unrecognized response: $response"
            return 1
            ;;
    esac
}

file_mtime_epoch() {
    stat -f '%m' "$1" 2>/dev/null || stat -c '%Y' "$1" 2>/dev/null
}

parse_payload_basename() {
    local payload_basename="$1"
    local package_name
    local version

    if [[ "$payload_basename" =~ ^(.+)-([0-9]{8}-[a-f0-9]+)\.zip$ ]]; then
        package_name="${BASH_REMATCH[1]}"
        version="${BASH_REMATCH[2]}"
        if validate_release_channel_package_name "$package_name"; then
            printf '%s\t%s\n' "$package_name" "$version"
            return 0
        fi
    fi

    return 1
}

autodetect_payload_zip() {
    local release_dir="$SCRIPT_DIR/release"
    local expected_package_name=""
    local selected_path=""
    local line
    local package_name
    local version
    local path

    [ -d "$release_dir" ] || die "release/ directory not found: $release_dir"

    if [ -n "$CHANNEL" ]; then
        expected_package_name="$(channel_to_package_name "$CHANNEL")"
    fi

    while IFS=$'\t' read -r _mtime path; do
        [ -n "$path" ] || continue
        line="$(parse_payload_basename "$(basename "$path")" || true)"
        [ -n "$line" ] || continue
        IFS=$'\t' read -r package_name version <<< "$line"
        if [ -n "$expected_package_name" ] && [ "$package_name" != "$expected_package_name" ]; then
            continue
        fi
        selected_path="$path"
        break
    done < <(
        find "$release_dir" -maxdepth 1 -type f -name '*.zip' -print0 2>/dev/null |
            while IFS= read -r -d '' path; do
                printf '%s\t%s\n' "$(file_mtime_epoch "$path")" "$path"
            done |
            sort -nr
    )

    [ -n "$selected_path" ] || die "No release payload zip found in $release_dir${expected_package_name:+ for channel $CHANNEL}"

    PAYLOAD_ZIP="$selected_path"
    PAYLOAD_AUTODETECTED=true
}

parse_args() {
    local positional=()

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --channel)
                [ $# -ge 2 ] || die "--channel requires a value"
                CHANNEL="$(normalize_release_channel_name "$2")"
                CHANNEL_EXPLICIT=true
                shift 2
                ;;
            --beta|--stable|--dev)
                CHANNEL="${1#--}"
                CHANNEL_EXPLICIT=true
                shift
                ;;
            --replace|--republish)
                REPUBLISH=true
                shift
                ;;
            --wait-for-sync)
                WAIT_FOR_SYNC=true
                shift
                ;;
            --mark-update-ready)
                MARK_UPDATE_READY=true
                shift
                ;;
            --yes)
                ASSUME_YES=true
                shift
                ;;
            --dry-run)
                DRY_RUN=true
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
        die "At most one payload zip path may be provided"
    fi

    if [ "${#positional[@]}" -eq 1 ]; then
        PAYLOAD_ZIP="${positional[0]}"
        PAYLOAD_EXPLICIT=true
    fi
}

parse_payload_name() {
    local payload_basename
    local parsed

    [ -f "$PAYLOAD_ZIP" ] || die "Payload zip not found: $PAYLOAD_ZIP"

    PAYLOAD_ZIP="$(
        cd "$(dirname "$PAYLOAD_ZIP")" &&
        printf '%s/%s\n' "$(pwd -P)" "$(basename "$PAYLOAD_ZIP")"
    )"
    payload_basename="$(basename "$PAYLOAD_ZIP")"
    parsed="$(parse_payload_basename "$payload_basename" || true)"
    [ -n "$parsed" ] || die "Payload zip basename must match <channel-package-name>-<build-id>.zip"

    IFS=$'\t' read -r CHANNEL_PACKAGE_NAME BUILD_ID <<< "$parsed"
}

validate_channel_match() {
    local derived_channel
    derived_channel="$(package_name_to_channel "$CHANNEL_PACKAGE_NAME" || true)"
    [ -n "$derived_channel" ] || die "Unable to derive release channel from package name: $CHANNEL_PACKAGE_NAME"

    if [ -n "$CHANNEL" ]; then
        local expected_package_name
        expected_package_name="$(channel_to_package_name "$CHANNEL")"
        if [ "$expected_package_name" != "$CHANNEL_PACKAGE_NAME" ]; then
            die "Payload zip package name ${CHANNEL_PACKAGE_NAME} does not match requested channel ${CHANNEL}"
        fi
    else
        CHANNEL="$derived_channel"
    fi
}

confirm_inferred_inputs() {
    local needs_prompt=false

    if [ "$PAYLOAD_EXPLICIT" != true ] || [ "$CHANNEL_EXPLICIT" != true ]; then
        needs_prompt=true
    fi

    if [ "$needs_prompt" != true ]; then
        return 0
    fi

    if [ "$ASSUME_YES" = true ]; then
        return 0
    fi

    require_interactive_prompt_capability || return 1

    if [ "$PAYLOAD_EXPLICIT" != true ]; then
        confirm_yes_no "Use autodetected payload zip $(basename "$PAYLOAD_ZIP") for build ${BUILD_ID}?" ||
            die "Upload cancelled; rerun with an explicit payload zip path"
    fi

    if [ "$CHANNEL_EXPLICIT" != true ]; then
        confirm_yes_no "Upload this payload to the ${CHANNEL} channel?" ||
            die "Upload cancelled; rerun with an explicit --channel"
    fi
}

validate_credentials() {
    if [ "$DRY_RUN" = true ]; then
        return 0
    fi

    [ -n "${CLOUDSMITH_API_KEY:-}" ] || die "CLOUDSMITH_API_KEY is not set"
    [ "$WAIT_FOR_SYNC" = true ] \
        || die "Cloudsmith publication must wait for synchronization"
    [ "$MARK_UPDATE_READY" = true ] \
        || die "Cloudsmith publication must verify update readiness"
    [ -n "${CLOUDSMITH_ENTITLEMENT_TOKEN:-}" ] \
        || die "CLOUDSMITH_ENTITLEMENT_TOKEN is required to verify the published update"
}

ensure_macos_validation_open_file_limit() {
    if [ "$(uname -s)" != "Darwin" ]; then
        return 0
    fi

    # Gatekeeper opens substantially more descriptors than the number of files
    # in the app bundle while assessing the copied release payload. Zed's
    # integrated terminal inherits a finite soft limit that causes spctl to
    # fail with misleading bundle-format or "Too many open files" errors.
    # Raising this shell's soft limit is inherited by the validator only and
    # does not alter the system-wide launchd limit.
    ulimit -Sn unlimited 2>/dev/null \
        || die "Unable to raise the open-file limit required for macOS release validation"
}

validate_payload_integrity() {
    command -v python3 >/dev/null 2>&1 || die "python3 is required to validate release payloads"
    [ -f "$RELEASE_PAYLOAD_VALIDATOR" ] \
        || die "Release payload validator not found: $RELEASE_PAYLOAD_VALIDATOR"

    ensure_macos_validation_open_file_limit
    log "Validating ZIP integrity, manifest identity, app signatures, and notarization tickets..."
    python3 "$RELEASE_PAYLOAD_VALIDATOR" \
        --payload "$PAYLOAD_ZIP" \
        --expected-build-id "$BUILD_ID" \
        --expected-channel-package "$CHANNEL_PACKAGE_NAME" \
        --verify-macos \
        || die "Release payload validation failed; nothing was uploaded"
    success "Release payload validation passed"
}

ensure_cloudsmith_cli() {
    export PATH="$HOME/Library/Python/3.9/bin:$HOME/.local/bin:$PATH"

    if command -v cloudsmith >/dev/null 2>&1; then
        return 0
    fi

    log "Installing cloudsmith CLI..."
    /usr/bin/pip3 install --quiet cloudsmith-cli || die "Failed to install cloudsmith-cli"
}

sha256_file() {
    if command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    elif command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    else
        die "shasum or sha256sum is required to verify the published update"
    fi
}

file_size_bytes() {
    wc -c < "$1" | tr -d '[:space:]'
}

build_client_download_url() {
    local cdn_url="$1"
    local package_name="$2"
    local version="$3"
    local filename="$4"

    python3 - "$cdn_url" "$CLOUDSMITH_ENTITLEMENT_TOKEN" "$CLOUDSMITH_DL_BASE" \
        "$CLOUDSMITH_REPO" "$package_name" "$version" "$filename" <<'PY'
import re
import sys
from urllib.parse import quote

cdn_url, token, download_base, repository, package_name, version, filename = sys.argv[1:]
raw_url = re.compile(r"/raw/names/.+(?:/versions/.+/.+|/files/.+)$")
token_segment = quote(token, safe="")

if cdn_url and raw_url.search(cdn_url):
    print(cdn_url.replace("/basic/", f"/{token_segment}/"))
else:
    parts = (token, repository, package_name, version, filename)
    encoded = [quote(part, safe="") for part in parts]
    print(
        f"{download_base.rstrip('/')}/{encoded[0]}/{encoded[1]}/raw/names/"
        f"{encoded[2]}/versions/{encoded[3]}/{encoded[4]}"
    )
PY
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
        tags = set()
        def flatten(value):
            if isinstance(value, str):
                if value.strip():
                    tags.add(value.strip())
            elif isinstance(value, list):
                for item in value:
                    flatten(item)
            elif isinstance(value, dict):
                for item in value.values():
                    flatten(item)
        flatten(pkg.get("tags_immutable"))
        print("\x1f".join([
            str(pkg.get("slug_perm") or pkg.get("identifier_perm") or pkg.get("slug") or ""),
            str(pkg.get("uploader") or ""),
            str(pkg.get("is_deleteable", "")),
            str(pkg.get("self_html_url") or ""),
            str("portico-update-ready-v1" in tags).lower(),
            str(pkg.get("checksum_sha256") or "").strip().lower(),
            str(pkg.get("cdn_url") or ""),
        ]))
        break
' "$filename" <<< "$result"
}

prepare_replace() {
    local filename="$1"
    local existing
    local existing_slug
    local existing_uploader
    local existing_url
    local existing_ready
    local existing_checksum
    local local_checksum

    if [ "$DRY_RUN" = true ] && [ -z "${CLOUDSMITH_API_KEY:-}" ]; then
        log "Skipping Cloudsmith package check in dry-run mode (no CLOUDSMITH_API_KEY set)"
        return 0
    fi

    ensure_cloudsmith_cli
    export CLOUDSMITH_API_KEY

    log "Checking Cloudsmith for an existing package..."
    if ! existing="$(find_existing_cloudsmith_package "$CHANNEL_PACKAGE_NAME" "$BUILD_ID" "$filename")"; then
        die "Cloudsmith package lookup failed while preparing replace"
    fi

    if [ -z "$existing" ]; then
        log "No existing package found for ${CHANNEL_PACKAGE_NAME}@${BUILD_ID}"
        return 0
    fi

    IFS=$'\x1f' read -r existing_slug existing_uploader _ existing_url existing_ready existing_checksum _ <<< "$existing"
    warn "Existing package found: ${existing_slug}"
    warn "Existing uploader: ${existing_uploader:-unknown}"

    if [ "$existing_ready" = true ]; then
        local_checksum="$(sha256_file "$PAYLOAD_ZIP")"
        [ -n "$existing_checksum" ] && [ "$existing_checksum" = "$local_checksum" ] \
            || die "Ready package ${CHANNEL_PACKAGE_NAME}@${BUILD_ID} cannot be replaced; publish changed bytes with a new build id"
        SKIP_UPLOAD=true
        success "Ready package already contains the exact release payload; skipping replacement"
        return 0
    fi

    local_checksum="$(sha256_file "$PAYLOAD_ZIP")"
    if [ -n "$existing_checksum" ] && [ "$existing_checksum" = "$local_checksum" ]; then
        SKIP_UPLOAD=true
        success "Unverified package already contains the exact release payload; resuming readiness verification"
        return 0
    fi

    [ "$REPUBLISH" = true ] \
        || die "An unverified package already exists for ${CHANNEL_PACKAGE_NAME}@${BUILD_ID}; use --republish to replace it or publish with a new build id"

    if ! cloudsmith delete "${CLOUDSMITH_OWNER}/${CLOUDSMITH_REPO}/${existing_slug}" -y >/dev/null; then
        die "Cloudsmith denied deleting the existing raw package; use a key with package delete permission"
    fi

    success "Deleted existing package: ${existing_slug}"
    if [ -n "$existing_url" ]; then
        log "Deleted package URL: ${existing_url}"
    fi
}

upload_to_cloudsmith() {
    local filename="$1"
    local size

    size="$(du -h "$PAYLOAD_ZIP" | awk '{print $1}')"

    if [ "$DRY_RUN" = true ]; then
        echo
        echo -e "${CYAN}========================================${NC}"
        echo -e "${CYAN}  DRY RUN - No actual upload${NC}"
        echo -e "${CYAN}========================================${NC}"
        echo
        echo -e "${BOLD}Payload:${NC} ${PAYLOAD_ZIP} (${size})"
        echo -e "${BOLD}Package name:${NC} ${CHANNEL_PACKAGE_NAME}"
        echo -e "${BOLD}Version:${NC} ${BUILD_ID}"
        echo -e "${BOLD}Channel:${NC} ${CHANNEL}"
        echo -e "${BOLD}Replace existing:${NC} ${REPUBLISH}"
        echo
        echo -e "${BOLD}Equivalent cloudsmith command:${NC}"
        local wait_arg="--no-wait-for-sync"
        if [ "$WAIT_FOR_SYNC" = true ]; then
            wait_arg=""
        fi
        echo "  cloudsmith push raw ${CLOUDSMITH_OWNER}/${CLOUDSMITH_REPO} ${PAYLOAD_ZIP} --name ${CHANNEL_PACKAGE_NAME} --version ${BUILD_ID}${wait_arg:+ ${wait_arg}}"
        echo
        return 0
    fi

    ensure_cloudsmith_cli
    export CLOUDSMITH_API_KEY

    log "Uploading payload to Cloudsmith..."
    log "  Payload: ${PAYLOAD_ZIP} (${size})"
    log "  Package: ${CHANNEL_PACKAGE_NAME}"
    log "  Version: ${BUILD_ID}"
    log "  Channel: ${CHANNEL}"

    local cloudsmith_args=(
        push raw "${CLOUDSMITH_OWNER}/${CLOUDSMITH_REPO}" "$PAYLOAD_ZIP"
        --name "$CHANNEL_PACKAGE_NAME"
        --version "$BUILD_ID"
    )
    if [ "$WAIT_FOR_SYNC" != true ]; then
        cloudsmith_args+=(--no-wait-for-sync)
    fi
    if [ "$REPUBLISH" = true ]; then
        cloudsmith_args+=(--republish)
    fi

    cloudsmith "${cloudsmith_args[@]}" || die "Cloudsmith upload failed"
    success "Upload successful"
}

verify_published_update() (
    local filename="$1"
    local package_record
    local package_slug
    local package_ready
    local package_checksum
    local package_cdn_url
    local expected_checksum
    local expected_size
    local download_url
    local download_file
    local downloaded_checksum
    local downloaded_size
    local http_status
    local curl_status
    local attempt
    local max_attempts="${portico_CLOUDSMITH_READY_MAX_ATTEMPTS:-60}"
    local retry_delay="${portico_CLOUDSMITH_READY_RETRY_DELAY_SECONDS:-15}"
    local timeout_seconds="${portico_CLOUDSMITH_READY_TIMEOUT_SECONDS:-900}"
    local deadline
    local remaining
    local now

    if [ "$DRY_RUN" = true ]; then
        log "Would download the exact published ZIP, verify SHA-256, and add ${UPDATE_READY_TAG}"
        return 0
    fi

    case "$max_attempts" in
        ''|*[!0-9]*) die "portico_CLOUDSMITH_READY_MAX_ATTEMPTS must be a positive integer" ;;
    esac
    case "$retry_delay" in
        ''|*[!0-9]*) die "portico_CLOUDSMITH_READY_RETRY_DELAY_SECONDS must be a non-negative integer" ;;
    esac
    case "$timeout_seconds" in
        ''|*[!0-9]*) die "portico_CLOUDSMITH_READY_TIMEOUT_SECONDS must be a positive integer" ;;
    esac
    [ "$max_attempts" -gt 0 ] || die "portico_CLOUDSMITH_READY_MAX_ATTEMPTS must be greater than zero"
    [ "$timeout_seconds" -gt 0 ] || die "portico_CLOUDSMITH_READY_TIMEOUT_SECONDS must be greater than zero"

    package_record="$(find_existing_cloudsmith_package "$CHANNEL_PACKAGE_NAME" "$BUILD_ID" "$filename")" \
        || die "Cloudsmith package lookup failed after upload"
    [ -n "$package_record" ] || die "Uploaded Cloudsmith package was not found after synchronization"
    IFS=$'\x1f' read -r package_slug _ _ _ package_ready package_checksum package_cdn_url <<< "$package_record"
    [ -n "$package_slug" ] || die "Uploaded Cloudsmith package has no permanent identifier"

    expected_checksum="$(sha256_file "$PAYLOAD_ZIP")"
    expected_size="$(file_size_bytes "$PAYLOAD_ZIP")"
    [ "$package_checksum" = "$expected_checksum" ] \
        || die "Cloudsmith package checksum does not match the signed release payload"

    download_url="$(build_client_download_url \
        "$package_cdn_url" \
        "$CHANNEL_PACKAGE_NAME" \
        "$BUILD_ID" \
        "$filename")"
    download_file="$(mktemp "${TMPDIR:-/tmp}/portico-cloudsmith-ready.XXXXXX")"
    trap 'rm -f -- "$download_file"' EXIT HUP INT TERM
    deadline="$(($(date +%s) + timeout_seconds))"

    for ((attempt = 1; attempt <= max_attempts; attempt++)); do
        now="$(date +%s)"
        remaining="$((deadline - now))"
        [ "$remaining" -gt 0 ] \
            || die "Published update did not become downloadable within ${timeout_seconds} seconds"
        rm -f "$download_file"
        set +e
        http_status="$(curl -sS -L -o "$download_file" -w '%{http_code}' \
            --connect-timeout 15 \
            --max-time "$remaining" \
            "$download_url")"
        curl_status=$?
        set -e

        if [ "$curl_status" -eq 0 ] && [ "$http_status" = 200 ]; then
            break
        fi

        case "$http_status" in
            401|403)
                rm -f "$download_file"
                die "Cloudsmith rejected the release entitlement while verifying the published update (HTTP $http_status)"
                ;;
            4??)
                if [ "$http_status" != 404 ] && [ "$http_status" != 408 ] && [ "$http_status" != 425 ] && [ "$http_status" != 429 ]; then
                    rm -f "$download_file"
                    die "Cloudsmith returned permanent HTTP $http_status while verifying the published update"
                fi
                ;;
        esac

        now="$(date +%s)"
        if [ "$attempt" -eq "$max_attempts" ] || [ "$((now + retry_delay))" -ge "$deadline" ]; then
            die "Published update did not become downloadable within ${timeout_seconds} seconds (last HTTP ${http_status:-000})"
        fi
        warn "Published update is not downloadable yet (HTTP ${http_status:-000}); verification attempt ${attempt} of ${max_attempts}"
        sleep "$retry_delay"
    done

    downloaded_size="$(file_size_bytes "$download_file")"
    downloaded_checksum="$(sha256_file "$download_file")"
    [ "$downloaded_size" = "$expected_size" ] \
        || die "Published update size does not match the signed release payload"
    [ "$downloaded_checksum" = "$expected_checksum" ] \
        || die "Published update SHA-256 does not match the signed release payload"
    success "Verified the exact published update payload"

    if [ "$package_ready" != true ]; then
        cloudsmith tags add \
            "${CLOUDSMITH_OWNER}/${CLOUDSMITH_REPO}/${package_slug}" \
            "$UPDATE_READY_TAG" \
            --immutable >/dev/null \
            || die "Failed to mark the verified Cloudsmith package as update-ready"
    fi

    package_record="$(find_existing_cloudsmith_package "$CHANNEL_PACKAGE_NAME" "$BUILD_ID" "$filename")" \
        || die "Cloudsmith package lookup failed after readiness marking"
    IFS=$'\x1f' read -r _ _ _ _ package_ready package_checksum _ <<< "$package_record"
    [ "$package_ready" = true ] && [ "$package_checksum" = "$expected_checksum" ] \
        || die "Cloudsmith did not confirm the update-ready marker on the verified package"
    success "Marked ${CHANNEL_PACKAGE_NAME}@${BUILD_ID} with ${UPDATE_READY_TAG}"
)

main() {
    parse_args "$@"
    if [ -z "$PAYLOAD_ZIP" ]; then
        autodetect_payload_zip
    fi
    parse_payload_name
    validate_channel_match
    confirm_inferred_inputs
    validate_payload_integrity
    validate_credentials

    local filename
    filename="$(basename "$PAYLOAD_ZIP")"

    prepare_replace "$filename"
    if [ "$SKIP_UPLOAD" != true ]; then
        upload_to_cloudsmith "$filename"
    fi
    verify_published_update "$filename"

    if [ "$DRY_RUN" = false ]; then
        echo
        echo -e "${CYAN}View in Cloudsmith:${NC}"
        echo -e "  ${YELLOW}https://app.cloudsmith.com/${CLOUDSMITH_OWNER}/${CLOUDSMITH_REPO}/packages/?q=name:${CHANNEL_PACKAGE_NAME}${NC}"
        echo
    fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    main "$@"
fi
