#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASE_CHANNEL_SH="$SCRIPT_DIR/src/scripts/release-channel.sh"

ROUTING_TAG_VERSION="portico-routing-v1"
ROUTING_TAG_EOL="portico-eol-true"
ROUTING_TAG_FORCE_UPDATE="portico-force-update-true"
ROUTING_TAG_REDIRECT_PREFIX="portico-redirect-"

CHANNEL=""
CHANNEL_PACKAGE_NAME=""
REDIRECT_CHANNEL=""
REDIRECT_PACKAGE_NAME=""
BUILD_ID=""
USE_LATEST=false
CLEAR_TAGS=false
DRY_RUN=false
YES=false
REASON=""

_PRESAVED_API_KEY="${CLOUDSMITH_API_KEY:-}"
_PRESAVED_OWNER="${CLOUDSMITH_OWNER:-}"
_PRESAVED_REPO="${CLOUDSMITH_REPO:-}"
_PRESAVED_API_BASE="${CLOUDSMITH_API_BASE:-}"
if [ -f "$SCRIPT_DIR/cloudsmith.env" ]; then
    # shellcheck source=cloudsmith.env
    . "$SCRIPT_DIR/cloudsmith.env"
fi
if [ -n "$_PRESAVED_API_KEY" ]; then
    CLOUDSMITH_API_KEY="$_PRESAVED_API_KEY"
fi
if [ -n "$_PRESAVED_OWNER" ]; then
    CLOUDSMITH_OWNER="$_PRESAVED_OWNER"
fi
if [ -n "$_PRESAVED_REPO" ]; then
    CLOUDSMITH_REPO="$_PRESAVED_REPO"
fi
if [ -n "$_PRESAVED_API_BASE" ]; then
    CLOUDSMITH_API_BASE="$_PRESAVED_API_BASE"
fi

CLOUDSMITH_OWNER="${CLOUDSMITH_OWNER:-portico}"
CLOUDSMITH_REPO="${CLOUDSMITH_REPO:-portico}"
CLOUDSMITH_API_BASE="${CLOUDSMITH_API_BASE:-https://api.cloudsmith.io/v1}"

usage() {
    cat <<'EOF'
Usage: ./mark_cloudsmith_release_eol.sh --channel <name> (--latest|--build-id <id>) [options]

Marks or clears Cloudsmith package tags used by the app's EOL release-channel redirect.

Required:
  --channel <name>              stable, beta, dev, or custom release channel
  --latest                      Select the latest raw ZIP package for the channel
  --build-id <MMDDYYYY-sha>     Select an exact build id instead of latest

Marking options:
  --redirect-channel <name>     stable, beta, dev, or custom release channel to redirect to
  --reason <text>               Optional operator-facing reason; logged only, not stored

Mutation controls:
  --clear                       Remove EOL routing tags from the selected package
  --dry-run                     Print the resolved package and tag changes only
  --yes                         Required for real Cloudsmith mutations
  -h, --help                    Show this help text
EOF
}

die() {
    printf 'ERROR: %s\n' "$1" >&2
    exit 1
}

log() {
    printf '%s\n' "$1"
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

urlencode() {
    python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$1"
}

packages_api_base() {
    printf '%s\n' "${CLOUDSMITH_API_BASE%/}"
}

parse_args() {
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --channel)
                [ "$#" -ge 2 ] || die "--channel requires a value"
                CHANNEL="$2"
                shift 2
                ;;
            --redirect-channel)
                [ "$#" -ge 2 ] || die "--redirect-channel requires a value"
                REDIRECT_CHANNEL="$2"
                shift 2
                ;;
            --build-id)
                [ "$#" -ge 2 ] || die "--build-id requires a value"
                BUILD_ID="$2"
                shift 2
                ;;
            --latest)
                USE_LATEST=true
                shift
                ;;
            --clear)
                CLEAR_TAGS=true
                shift
                ;;
            --dry-run)
                DRY_RUN=true
                shift
                ;;
            --yes)
                YES=true
                shift
                ;;
            --reason)
                [ "$#" -ge 2 ] || die "--reason requires a value"
                REASON="$2"
                shift 2
                ;;
            -h|--help)
                usage
                exit 0
                ;;
            *)
                usage >&2
                die "Unknown argument: $1"
                ;;
        esac
    done
}

validate_args() {
    [ -f "$RELEASE_CHANNEL_SH" ] || die "Missing release-channel helper: $RELEASE_CHANNEL_SH"
    # shellcheck source=src/scripts/release-channel.sh
    . "$RELEASE_CHANNEL_SH"

    CHANNEL="$(normalize_release_channel_name "$CHANNEL")"
    [ -n "$CHANNEL" ] || die "--channel is required"
    CHANNEL_PACKAGE_NAME="$(release_channel_to_package_name "$CHANNEL")" \
        || die "Invalid release channel: $CHANNEL"

    if [ "$USE_LATEST" = true ] && [ -n "$BUILD_ID" ]; then
        die "--latest and --build-id are mutually exclusive"
    fi
    if [ "$USE_LATEST" != true ] && [ -z "$BUILD_ID" ]; then
        die "Exactly one of --latest or --build-id is required"
    fi
    if [ -n "$BUILD_ID" ] && ! [[ "$BUILD_ID" =~ ^[0-9]{8}-[a-f0-9]+$ ]]; then
        die "Invalid build id: $BUILD_ID (expected MMDDYYYY-sha)"
    fi

    if [ "$CLEAR_TAGS" != true ]; then
        REDIRECT_CHANNEL="$(normalize_release_channel_name "$REDIRECT_CHANNEL")"
        [ -n "$REDIRECT_CHANNEL" ] || die "--redirect-channel is required unless --clear is used"
        REDIRECT_PACKAGE_NAME="$(release_channel_to_package_name "$REDIRECT_CHANNEL")" \
            || die "Invalid redirect channel: $REDIRECT_CHANNEL"
        [ "$REDIRECT_PACKAGE_NAME" != "$CHANNEL_PACKAGE_NAME" ] \
            || die "Redirect channel must differ from source channel"
    fi

    [ -n "${CLOUDSMITH_API_KEY:-}" ] || die "CLOUDSMITH_API_KEY is not set"
    if [ "$DRY_RUN" != true ]; then
        [ "$YES" = true ] || die "Real Cloudsmith mutations require --yes"
    fi
}

cloudsmith_request() {
    local method="$1"
    local url="$2"
    local body_file="${3:-}"
    local output_file="$4"
    local status

    if [ -n "$body_file" ]; then
        status="$(
            curl -sS -o "$output_file" -w '%{http_code}' \
                -X "$method" \
                -H "Accept: application/json" \
                -H "Content-Type: application/json" \
                -H "X-Api-Key: ${CLOUDSMITH_API_KEY}" \
                --data-binary "@$body_file" \
                "$url"
        )" || return 1
    else
        status="$(
            curl -sS -o "$output_file" -w '%{http_code}' \
                -X "$method" \
                -H "Accept: application/json" \
                -H "X-Api-Key: ${CLOUDSMITH_API_KEY}" \
                "$url"
        )" || return 1
    fi

    printf '%s\n' "$status"
}

query_packages() {
    local package_name="$1"
    local build_id="$2"
    local output_file="$3"
    local query
    local encoded_query
    local url
    local status
    local body_file

    query="name:^${package_name}$ format:raw"
    if [ -n "$build_id" ]; then
        query="name:^${package_name}$ version:^${build_id}$ format:raw"
    fi
    encoded_query="$(urlencode "$query")"
    url="$(packages_api_base)/packages/${CLOUDSMITH_OWNER}/${CLOUDSMITH_REPO}/?query=${encoded_query}&page_size=100&sort=-date"
    body_file="$(mktemp "${TMPDIR:-/tmp}/portico-cloudsmith-packages.XXXXXX")"
    status="$(cloudsmith_request GET "$url" "" "$body_file")" || {
        rm -f "$body_file"
        die "Cloudsmith package lookup failed"
    }
    if [ "$status" != "200" ]; then
        rm -f "$body_file"
        die "Cloudsmith package lookup failed with HTTP $status"
    fi
    mv "$body_file" "$output_file"
}

select_package_from_response() {
    local response_file="$1"
    local package_name="$2"
    local build_id="$3"

    python3 - "$response_file" "$package_name" "$build_id" "$ROUTING_TAG_REDIRECT_PREFIX" <<'PY'
import json
import re
import sys
from datetime import datetime, timezone

response_file, package_name, build_id, redirect_prefix = sys.argv[1:5]

with open(response_file, "r", encoding="utf-8") as fh:
    payload = json.load(fh)

if isinstance(payload, list):
    packages = payload
elif isinstance(payload, dict):
    packages = payload.get("data") or payload.get("results") or []
else:
    packages = []

def package_timestamp(pkg):
    raw = pkg.get("uploaded_at") or pkg.get("created_at") or ""
    if not raw:
        return datetime.fromtimestamp(0, timezone.utc)
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except Exception:
        return datetime.fromtimestamp(0, timezone.utc)

def package_slug(pkg):
    for key in ("slug_perm", "slug", "identifier", "package_slug_perm"):
        value = pkg.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""

def flatten_tags(value, out):
    if isinstance(value, str):
        tag = value.strip()
        if tag:
            out.add(tag)
        return
    if isinstance(value, list):
        for item in value:
            flatten_tags(item, out)
        return
    if isinstance(value, dict):
        for item in value.values():
            flatten_tags(item, out)

def package_tags(pkg, include_immutable=False):
    tags = set()
    flatten_tags(pkg.get("tags"), tags)
    if include_immutable:
        flatten_tags(pkg.get("tags_immutable"), tags)
    return tags

build_re = re.compile(rf"^{re.escape(package_name)}-(\d{{8}}-[a-f0-9]{{8,40}})\.zip$")
candidates = []
for pkg in packages:
    if not isinstance(pkg, dict):
        continue
    if pkg.get("name") not in (None, "", package_name):
        continue
    filename = pkg.get("filename") or f"{package_name}-{pkg.get('version', '')}.zip"
    match = build_re.match(filename)
    if not match:
        continue
    resolved_build_id = pkg.get("version") or match.group(1)
    if build_id and resolved_build_id != build_id and match.group(1) != build_id:
        continue
    mutable_tags = package_tags(pkg)
    redirect_tags = sorted(tag for tag in mutable_tags if tag.startswith(redirect_prefix))
    candidates.append((
        package_timestamp(pkg),
        filename,
        resolved_build_id,
        package_slug(pkg),
        ",".join(redirect_tags),
    ))

if not candidates:
    sys.exit(1)

candidates.sort(reverse=True)
_, filename, resolved_build_id, slug, redirect_tags = candidates[0]
print("\x1f".join([filename, resolved_build_id, slug, redirect_tags]))
PY
}

find_package() {
    local package_name="$1"
    local build_id="$2"
    local response_file
    local selected

    response_file="$(mktemp "${TMPDIR:-/tmp}/portico-cloudsmith-package-response.XXXXXX")"
    query_packages "$package_name" "$build_id" "$response_file"
    if ! selected="$(select_package_from_response "$response_file" "$package_name" "$build_id")"; then
        rm -f "$response_file"
        return 1
    fi
    rm -f "$response_file"
    printf '%s\n' "$selected"
}

write_tag_payload() {
    local output_file="$1"
    local action="$2"
    shift 2

    python3 - "$output_file" "$action" "$@" <<'PY'
import json
import sys

output_file = sys.argv[1]
action = sys.argv[2]
tags = [tag for tag in sys.argv[3:] if tag]
payload = {
    "action": action,
    "tags": tags,
    "is_immutable": False,
}
with open(output_file, "w", encoding="utf-8") as fh:
    json.dump(payload, fh, indent=2, sort_keys=True)
    fh.write("\n")
PY
}

mutate_package_tags() {
    local package_slug="$1"
    local action="$2"
    shift 2
    local output_file
    local body_file
    local url
    local status

    [ "$#" -gt 0 ] || return 0
    output_file="$(mktemp "${TMPDIR:-/tmp}/portico-cloudsmith-tag-response.XXXXXX")"
    body_file="$(mktemp "${TMPDIR:-/tmp}/portico-cloudsmith-tag-payload.XXXXXX")"
    write_tag_payload "$body_file" "$action" "$@"
    url="$(packages_api_base)/packages/${CLOUDSMITH_OWNER}/${CLOUDSMITH_REPO}/${package_slug}/tag/"

    status="$(cloudsmith_request POST "$url" "$body_file" "$output_file")" || {
        rm -f "$output_file" "$body_file"
        die "Cloudsmith package tag mutation failed"
    }
    rm -f "$output_file" "$body_file"

    case "$status" in
        200|201|202|204) return 0 ;;
        *) die "Cloudsmith package tag mutation failed with HTTP $status" ;;
    esac
}

print_tag_list() {
    local indent="$1"
    shift

    for tag in "$@"; do
        log "${indent}${tag}"
    done
}

main() {
    local selected
    local source_filename
    local source_build_id
    local source_slug
    local source_redirect_tags_csv
    local target_selected
    local target_filename
    local redirect_tag
    local add_tags
    local remove_tags

    parse_args "$@"
    require_command curl
    require_command python3
    validate_args

    if ! selected="$(find_package "$CHANNEL_PACKAGE_NAME" "$BUILD_ID")"; then
        die "No matching source package found for ${CHANNEL_PACKAGE_NAME}${BUILD_ID:+@$BUILD_ID}"
    fi
    IFS=$'\x1f' read -r source_filename source_build_id source_slug source_redirect_tags_csv <<< "$selected"
    [ -n "$source_slug" ] || die "Cloudsmith package identifier is missing for $source_filename"

    log "Source package: ${source_filename}"
    log "Source build: ${source_build_id}"
    log "Source package slug: ${source_slug}"

    if [ "$CLEAR_TAGS" != true ]; then
        if ! target_selected="$(find_package "$REDIRECT_PACKAGE_NAME" "")"; then
            die "No downloadable target package found for redirect channel ${REDIRECT_PACKAGE_NAME}"
        fi
        log "Redirect target channel: ${REDIRECT_PACKAGE_NAME}"
        IFS=$'\x1f' read -r target_filename _ <<< "$target_selected"
        log "Redirect target package: ${target_filename}"
        if [ -n "$REASON" ]; then
            log "Reason: ${REASON}"
        fi
    fi

    redirect_tag="${ROUTING_TAG_REDIRECT_PREFIX}${REDIRECT_PACKAGE_NAME}"
    add_tags=(
        "$ROUTING_TAG_VERSION"
        "$ROUTING_TAG_EOL"
        "$ROUTING_TAG_FORCE_UPDATE"
        "$redirect_tag"
    )

    remove_tags=(
        "$ROUTING_TAG_VERSION"
        "$ROUTING_TAG_EOL"
        "$ROUTING_TAG_FORCE_UPDATE"
    )
    if [ -n "${source_redirect_tags_csv:-}" ]; then
        local old_ifs="$IFS"
        IFS=','
        read -r -a redirect_tags <<< "$source_redirect_tags_csv"
        IFS="$old_ifs"
        for tag in "${redirect_tags[@]}"; do
            [ -n "$tag" ] && remove_tags+=("$tag")
        done
    fi

    if [ "$DRY_RUN" = true ]; then
        log "Dry run: no Cloudsmith tag changes will be made."
        if [ "$CLEAR_TAGS" = true ]; then
            log "Would remove mutable tags from package ${source_slug}:"
            print_tag_list "  " "${remove_tags[@]}"
        else
            log "Would add mutable tags to package ${source_slug}:"
            print_tag_list "  " "${add_tags[@]}"
        fi
        return 0
    fi

    if [ "$CLEAR_TAGS" = true ]; then
        mutate_package_tags "$source_slug" "Remove" "${remove_tags[@]}"
        log "Removed EOL routing tags from ${source_filename}"
        return 0
    fi

    mutate_package_tags "$source_slug" "Add" "${add_tags[@]}"
    log "Added EOL routing tags to ${source_filename}"
}

main "$@"
