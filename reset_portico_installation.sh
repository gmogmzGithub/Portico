#!/usr/bin/env bash

set -euo pipefail

# Never allow an inherited `bash -x` to print Cloudsmith credentials or the
# credential-bearing raw download URL.
case "$-" in
    *x*) set +x ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
RELEASE_CHANNEL_SH="$SCRIPT_DIR/src/scripts/release-channel.sh"
RUNTIME_SECRETS_SH="$SCRIPT_DIR/src/scripts/runtime-secrets.sh"
KEYCHAIN_CLEANUP_SH="$SCRIPT_DIR/src/scripts/cleanup-portico-keychain.sh"
PAYLOAD_VALIDATOR="$SCRIPT_DIR/src/scripts/validate-release-payload.py"

TEST_MODE=false
if [ "${portico_RESET_TEST_MODE:-0}" = "1" ]; then
    TEST_MODE=true
fi

MANAGED_DIR="$HOME/portico/portico-managed"
APP_SUPPORT_DIR="$HOME/Library/Application Support/portico"
QUALIFICATION_DIR="$HOME/Library/Application Support/Portico Local Qualification"
APP_PATH="/Applications/Portico.app"
DOWNLOADS_DIR="$HOME/Downloads/Portico Install"
BASELINE_STORE="$HOME/Library/Application Support/Portico Baselines"
RELEASE_CACHE_DIR="$HOME/Library/Caches/Portico/Release Downloads"

if [ "$TEST_MODE" = true ]; then
    MANAGED_DIR="${portico_RESET_TEST_MANAGED_DIR:-$MANAGED_DIR}"
    APP_SUPPORT_DIR="${portico_RESET_TEST_APP_SUPPORT_DIR:-$APP_SUPPORT_DIR}"
    QUALIFICATION_DIR="${portico_RESET_TEST_QUALIFICATION_DIR:-$QUALIFICATION_DIR}"
    APP_PATH="${portico_RESET_TEST_APP_PATH:-$APP_PATH}"
    DOWNLOADS_DIR="${portico_RESET_TEST_DOWNLOADS_DIR:-$DOWNLOADS_DIR}"
    BASELINE_STORE="${portico_RESET_TEST_BASELINE_STORE:-$BASELINE_STORE}"
    RELEASE_CACHE_DIR="${portico_RESET_TEST_RELEASE_CACHE_DIR:-$RELEASE_CACHE_DIR}"
    PAYLOAD_VALIDATOR="${portico_RESET_TEST_PAYLOAD_VALIDATOR:-$PAYLOAD_VALIDATOR}"
fi

APP_SUPPORT_BASELINE="$HOME/Library/Application Support/portico-beta-baseline.zip"
MANAGED_BASELINE="$HOME/portico/portico-managed-beta-baseline.zip"
INSTALLED_CLOUDSMITH_ENV="$APP_PATH/Contents/Resources/cloudsmith.env"
MANAGED_CLOUDSMITH_ENV="$MANAGED_DIR/cloudsmith.env"
REPOSITORY_CLOUDSMITH_ENV="$SCRIPT_DIR/cloudsmith.env"
MANAGED_CAPTURE_EXCLUDED_RELATIVE_PATH="open-webui-data/managed-node-mcp-package-acquisition"

CLOUDSMITH_OWNER_DEFAULT="portico"
CLOUDSMITH_REPO_DEFAULT="portico"
CLOUDSMITH_API_BASE_DEFAULT="https://api.cloudsmith.io/v1"
CLOUDSMITH_DL_BASE_DEFAULT="https://dl.artifacts.example.invalid"

RESTORE_BASELINES=false
CLEAR_SECURE_STATE=false
RUN_MODE=""
BASELINE_RECORDS=()
BASELINE_MANAGED_FALLBACKS=()
SELECTED_BASELINE_KIND=""
SELECTED_BASELINE_ID=""
SELECTED_BASELINE_LABEL=""
SELECTED_BASELINE_CREATED_AT=""
SELECTED_BASELINE_BUILD=""
SELECTED_BASELINE_CHANNEL=""
SELECTED_BASELINE_DIR=""
SELECTED_BASELINE_MANIFEST_SHA256=""
SELECTED_MANAGED_PRESENT=false
SELECTED_APP_SUPPORT_PRESENT=false
SELECTED_QUALIFICATION_PRESENT=false
SELECTED_MANAGED_ARCHIVE=""
SELECTED_APP_SUPPORT_ARCHIVE=""
SELECTED_QUALIFICATION_ARCHIVE=""
SELECTED_MANAGED_SHA256=""
SELECTED_APP_SUPPORT_SHA256=""
SELECTED_QUALIFICATION_SHA256=""
CHANNEL_NAME=""
CHANNEL_PACKAGE=""
BUILD_ID=""
PACKAGE_VERSION=""
PACKAGE_FILENAME=""
PACKAGE_CHECKSUM_SHA256=""
PACKAGE_TIMESTAMP=""
DOWNLOAD_URL=""
DOWNLOAD_WORKSPACE=""
DOWNLOAD_FILE=""
RELEASE_CACHE_FILE=""
RELEASE_CACHE_TEMP_FILE=""
EXTRACT_DIR=""
DMG_PATH=""
TEMP_ROOT=""
STAGED_APP_SUPPORT=""
STAGED_MANAGED=""
STAGED_QUALIFICATION=""
CLEAN_DOWNLOAD_WORKSPACE=false
CAPTURE_LABEL=""
CAPTURE_SLUG=""
CAPTURE_ID=""
CAPTURE_CREATED_AT=""
CAPTURE_DESTINATION=""
CAPTURE_TEMP_ROOT=""
CAPTURE_TEMP_SET=""
CAPTURE_PUBLISHED_PATH=""
CAPTURE_MANAGED_PRESENT=false
CAPTURE_APP_SUPPORT_PRESENT=false
CAPTURE_QUALIFICATION_PRESENT=false
CAPTURE_MANAGED_SIZE=0
CAPTURE_MANAGED_EXCLUDED_SIZE=0
CAPTURE_MANAGED_EXCLUDED_PRESENT=false
CAPTURE_APP_SUPPORT_SIZE=0
CAPTURE_QUALIFICATION_SIZE=0
CAPTURE_TOTAL_SIZE=0
CAPTURE_REQUIRED_BYTES=0
CAPTURE_AVAILABLE_BYTES=0
CAPTURE_BUILD=""
CAPTURE_CHANNEL=""
CAPTURE_APP_WAS_RUNNING=false
CAPTURE_RUNNING_CONTAINERS=()
CAPTURE_RUNTIME_NEEDS_RESTORE=false

log() {
    printf '%s\n' "$*"
}

warn() {
    printf 'Warning: %s\n' "$*" >&2
}

die() {
    printf 'Error: %s\n' "$*" >&2
    exit 1
}

trim() {
    printf '%s' "${1:-}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

usage() {
    cat <<'EOF'
Usage:
  ./reset_portico_installation.sh
  ./reset_portico_installation.sh --capture-baseline
  ./reset_portico_installation.sh --help

Without arguments, choose whether to reset the installation or capture a
three-folder baseline. All state-changing paths remain interactive.

Reset mode will:
  - optionally restore a selected saved baseline after resetting disk state
  - independently offer to clear PORTICO-owned Keychain passwords, legacy OAuth
    certificates, and associated SSL caches
  - choose Stable, Beta, Development, or a validated custom release channel
  - download and validate the latest release before deleting the current install
  - offer one explicit override only when the payload is missing the top-level
    OOTB marketplace bootstrap assets; every other validation error still aborts
  - stop, but not remove, Portico Docker containers
  - remove only these installation paths:
      ~/portico/portico-managed
      ~/Library/Application Support/Portico Local Qualification
      ~/Library/Application Support/portico
      /Applications/Portico.app
  - keep the downloaded ZIP and extracted payload under:
      ~/Downloads/Portico Install
  - reuse SHA-256-verified release ZIPs from the private persistent cache:
      ~/Library/Caches/Portico/Release Downloads
    Existing matching ZIPs in prior Downloads workspaces seed the cache, so the
    first run after this upgrade does not needlessly download them again.
  - mount the arm64 DMG read-only and open its volume in Finder

Capture mode will:
  - snapshot these three paths as one named baseline set:
      ~/portico/portico-managed
      ~/Library/Application Support/portico
      ~/Library/Application Support/Portico Local Qualification
  - record missing folders as intentionally absent
  - exclude generated managed-Node acquisition scratch/cache from managed.zip:
      open-webui-data/managed-node-mcp-package-acquisition
    Durable packages under managed-node-mcp-packages remain captured; excluded
    acquisition state is regenerated automatically when needed.
  - store private, checksummed baseline sets under:
      ~/Library/Application Support/Portico Baselines
  - stop PORTICO while archiving, then resume the prior app/container state
  - never capture or clear Keychain state, download a release, or delete data

When more than one baseline exists, reset mode offers a newest-first chooser.
The existing two beta-baseline ZIPs remain available as a legacy two-folder
choice; their missing qualification snapshot is reported explicitly.

Cloudsmith configuration is resolved without sourcing configuration files.
Environment values take precedence, followed by repository/installed config,
macOS Keychain, managed config, and selected/newest saved managed baselines.
Credential values and credential-bearing URLs are never printed.

There is deliberately no noninteractive confirmation bypass. A real reset
requires RESET, and a baseline capture requires CAPTURE, after reviewing the
resolved paths and operation summary.
EOF
}

cleanup() {
    local status=$?
    trap - EXIT INT TERM

    if [ "$CAPTURE_RUNTIME_NEEDS_RESTORE" = true ]; then
        if ! restore_capture_runtime; then
            warn "Failed to restore the runtime state that existed before baseline capture."
            status=1
        fi
    fi

    if [ -n "$CAPTURE_TEMP_ROOT" ] && [ -d "$CAPTURE_TEMP_ROOT" ]; then
        case "$CAPTURE_TEMP_ROOT" in
            "$BASELINE_STORE"/.capture.*)
                rm -rf -- "$CAPTURE_TEMP_ROOT"
                ;;
        esac
    fi

    if [ -n "$TEMP_ROOT" ] && [ -d "$TEMP_ROOT" ]; then
        case "$TEMP_ROOT" in
            "${TMPDIR:-/tmp}"/portico-reset.*|/tmp/portico-reset.*|/private/tmp/portico-reset.*)
                rm -rf -- "$TEMP_ROOT"
                ;;
        esac
    fi

    if [ "$CLEAN_DOWNLOAD_WORKSPACE" = true ] \
        && [ -n "$DOWNLOAD_WORKSPACE" ] \
        && [ -d "$DOWNLOAD_WORKSPACE" ]; then
        case "$DOWNLOAD_WORKSPACE" in
            "$DOWNLOADS_DIR"/*)
                rm -rf -- "$DOWNLOAD_WORKSPACE"
                ;;
        esac
    fi

    if [ -n "$RELEASE_CACHE_TEMP_FILE" ] && [ -f "$RELEASE_CACHE_TEMP_FILE" ]; then
        case "$RELEASE_CACHE_TEMP_FILE" in
            "$RELEASE_CACHE_DIR"/.download.*)
                rm -f -- "$RELEASE_CACHE_TEMP_FILE"
                ;;
        esac
    fi

    unset CLOUDSMITH_API_KEY CLOUDSMITH_ENTITLEMENT_TOKEN DOWNLOAD_URL
    exit "$status"
}

handle_interrupt() {
    exit 130
}

trap cleanup EXIT
trap handle_interrupt INT TERM

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

require_file() {
    [ -f "$1" ] || die "Required repository file not found: $1"
}

read_prompt() {
    local prompt="$1"
    local response=""
    printf '%s' "$prompt" >&2
    if ! IFS= read -r response; then
        printf '\n' >&2
        die "Input ended before the requested operation was confirmed"
    fi
    printf '%s\n' "$response"
}

prompt_yes_no() {
    local prompt="$1"
    local default_answer="$2"
    local response=""

    while true; do
        response="$(read_prompt "$prompt")"
        response="$(trim "$response" | tr '[:upper:]' '[:lower:]')"
        if [ -z "$response" ]; then
            response="$default_answer"
        fi
        case "$response" in
            y|yes) return 0 ;;
            n|no) return 1 ;;
            *) warn "Please answer yes or no." ;;
        esac
    done
}

validate_common_runtime() {
    [ -n "${HOME:-}" ] || die "HOME is not set"
    case "$HOME" in
        /|"") die "Refusing to run with an unsafe HOME value" ;;
    esac

    if [ "$TEST_MODE" != true ] && [ "$(uname -s)" != "Darwin" ]; then
        die "This utility is supported only on macOS"
    fi
    if [ "$TEST_MODE" != true ] && [ ! -t 0 ]; then
        die "This utility requires an interactive terminal"
    fi

    require_command ditto
    require_command open
    require_command osascript
    require_command pgrep
    require_command python3
    require_command shasum
}

validate_reset_runtime() {
    require_file "$RELEASE_CHANNEL_SH"
    require_file "$RUNTIME_SECRETS_SH"
    require_file "$KEYCHAIN_CLEANUP_SH"
    require_file "$PAYLOAD_VALIDATOR"

    require_command curl
    require_command hdiutil

    # shellcheck source=src/scripts/release-channel.sh
    . "$RELEASE_CHANNEL_SH"
    # shellcheck source=src/scripts/runtime-secrets.sh
    . "$RUNTIME_SECRETS_SH"
    # shellcheck source=src/scripts/cleanup-portico-keychain.sh
    . "$KEYCHAIN_CLEANUP_SH"
}

validate_capture_runtime() {
    require_command find
    require_command mkbom
}

choose_action() {
    local selection=""

    log "Portico installation utility"
    log "-----------------------------------"
    log ""
    log "Action:"
    log "  1) Reset installation"
    log "  2) Capture baseline"

    while true; do
        selection="$(trim "$(read_prompt "Choose an action [1]: ")")"
        [ -n "$selection" ] || selection="1"
        case "$selection" in
            1|reset|Reset)
                RUN_MODE="reset"
                return 0
                ;;
            2|capture|Capture)
                RUN_MODE="capture"
                return 0
                ;;
            *) warn "Choose 1 or 2." ;;
        esac
    done
}

baseline_catalog_records() {
    local specific_dir="${1:-}"

    python3 - "$BASELINE_STORE" "$specific_dir" <<'PY'
import hashlib
import json
import os
import re
import stat
import sys
from datetime import datetime
from pathlib import Path

store = Path(sys.argv[1])
specific = Path(sys.argv[2]) if sys.argv[2] else None
separator = "\x1f"
archive_names = {
    "managed": "managed.zip",
    "app_support": "application-support.zip",
    "qualification": "local-qualification.zip",
}
id_pattern = re.compile(r"^\d{8}-\d{6}-[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$")
sha_pattern = re.compile(r"^[a-f0-9]{64}$")


def regular_file(path):
    try:
        return stat.S_ISREG(path.lstat().st_mode)
    except OSError:
        return False


def safe_text(value, field, maximum, allow_empty=False):
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a string")
    if (not value and not allow_empty) or len(value) > maximum:
        raise ValueError(f"{field} has an invalid length")
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError(f"{field} contains control characters")
    return value


def optional_text(value, field):
    if value is None:
        return "-"
    return safe_text(value, field, 128) or "-"


def read_record(set_dir):
    if set_dir.is_symlink() or not set_dir.is_dir():
        raise ValueError("baseline path is not a real directory")
    manifest_path = set_dir / "manifest.json"
    if not regular_file(manifest_path):
        raise ValueError("manifest.json is missing or is not a regular file")
    if manifest_path.stat().st_size > 64 * 1024:
        raise ValueError("manifest.json exceeds 64 KiB")

    raw_manifest = manifest_path.read_bytes()
    data = json.loads(raw_manifest.decode("utf-8"))
    if not isinstance(data, dict) or set(data) != {
        "schema_version", "id", "label", "created_at", "source_build", "folders"
    }:
        raise ValueError("manifest has unexpected fields")
    if data["schema_version"] != 1:
        raise ValueError("unsupported manifest schema")

    baseline_id = safe_text(data["id"], "id", 96)
    if not id_pattern.fullmatch(baseline_id) or baseline_id != set_dir.name:
        raise ValueError("manifest id does not match its directory")
    label = safe_text(data["label"], "label", 80)
    if "/" in label or "\\" in label:
        raise ValueError("label contains a path separator")
    created_at = safe_text(data["created_at"], "created_at", 64)
    try:
        parsed_created_at = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("created_at is not ISO-8601") from exc
    if parsed_created_at.tzinfo is None:
        raise ValueError("created_at must include a timezone")

    source_build = data["source_build"]
    if not isinstance(source_build, dict) or set(source_build) != {"build_number", "channel"}:
        raise ValueError("source_build has unexpected fields")
    build_number = optional_text(source_build["build_number"], "source_build.build_number")
    channel = optional_text(source_build["channel"], "source_build.channel")

    folders = data["folders"]
    if not isinstance(folders, dict) or set(folders) != set(archive_names):
        raise ValueError("folders has unexpected fields")

    folder_values = []
    checksum_values = []
    for folder_id in ("managed", "app_support", "qualification"):
        record = folders[folder_id]
        if not isinstance(record, dict) or set(record) != {"present", "sha256"}:
            raise ValueError(f"folders.{folder_id} has unexpected fields")
        present = record["present"]
        checksum = record["sha256"]
        if not isinstance(present, bool):
            raise ValueError(f"folders.{folder_id}.present must be boolean")
        archive_path = set_dir / archive_names[folder_id]
        if present:
            if not isinstance(checksum, str) or not sha_pattern.fullmatch(checksum):
                raise ValueError(f"folders.{folder_id}.sha256 is invalid")
            if not regular_file(archive_path):
                raise ValueError(f"{archive_names[folder_id]} is missing or unsafe")
        else:
            if checksum is not None:
                raise ValueError(f"folders.{folder_id}.sha256 must be null when absent")
            if archive_path.exists() or archive_path.is_symlink():
                raise ValueError(f"unexpected archive for absent folder: {archive_names[folder_id]}")
        folder_values.append("true" if present else "false")
        checksum_values.append(checksum if present else "-")

    manifest_sha = hashlib.sha256(raw_manifest).hexdigest()
    return (
        parsed_created_at,
        separator.join((
            "set", baseline_id, label, created_at, build_number, channel,
            str(set_dir), *folder_values, *checksum_values, manifest_sha,
        )),
    )


if specific is not None:
    try:
        print(read_record(specific)[1])
    except Exception as exc:
        print(f"Error: invalid baseline set {specific}: {exc}", file=sys.stderr)
        raise SystemExit(1)
    raise SystemExit(0)

if not store.exists():
    raise SystemExit(0)
if store.is_symlink() or not store.is_dir():
    print(f"Warning: baseline store is not a real directory: {store}", file=sys.stderr)
    raise SystemExit(0)

records = []
for candidate in store.iterdir():
    if candidate.name.startswith(".capture."):
        continue
    try:
        records.append(read_record(candidate))
    except Exception as exc:
        print(f"Warning: ignoring invalid baseline set {candidate.name}: {exc}", file=sys.stderr)

for _, record in sorted(records, key=lambda item: (item[0], item[1]), reverse=True):
    print(record)
PY
}

discover_baselines() {
    local record=""
    local catalog_output=""
    local legacy_managed=false
    local legacy_app_support=false

    BASELINE_RECORDS=()
    if ! catalog_output="$(baseline_catalog_records)"; then
        die "Saved baseline catalog discovery failed"
    fi
    while IFS= read -r record; do
        [ -n "$record" ] && BASELINE_RECORDS+=("$record")
    done <<EOF
$catalog_output
EOF

    if [ -f "$MANAGED_BASELINE" ] && [ ! -L "$MANAGED_BASELINE" ]; then
        legacy_managed=true
    elif [ -e "$MANAGED_BASELINE" ] || [ -L "$MANAGED_BASELINE" ]; then
        warn "Ignoring unsafe legacy managed baseline: $MANAGED_BASELINE"
    fi
    if [ -f "$APP_SUPPORT_BASELINE" ] && [ ! -L "$APP_SUPPORT_BASELINE" ]; then
        legacy_app_support=true
    elif [ -e "$APP_SUPPORT_BASELINE" ] || [ -L "$APP_SUPPORT_BASELINE" ]; then
        warn "Ignoring unsafe legacy app-support baseline: $APP_SUPPORT_BASELINE"
    fi

    if [ "$legacy_managed" = true ] || [ "$legacy_app_support" = true ]; then
        BASELINE_RECORDS+=("legacy"$'\x1f'"legacy-beta"$'\x1f'"Legacy beta baseline"$'\x1f'"-"$'\x1f'"-"$'\x1f'"beta"$'\x1f'"-"$'\x1f'"$legacy_managed"$'\x1f'"$legacy_app_support"$'\x1f'"false"$'\x1f'"-"$'\x1f'"-"$'\x1f'"-"$'\x1f'"-")
    fi
}

add_managed_baseline_fallback() {
    local candidate="$1"
    local existing=""

    [ -n "$candidate" ] && [ "$candidate" != "-" ] || return 0
    if [ "${#BASELINE_MANAGED_FALLBACKS[@]}" -gt 0 ]; then
        for existing in "${BASELINE_MANAGED_FALLBACKS[@]}"; do
            [ "$existing" = "$candidate" ] && return 0
        done
    fi
    BASELINE_MANAGED_FALLBACKS+=("$candidate")
}

build_managed_baseline_fallbacks() {
    local record=""
    local kind="" id="" label="" created_at="" build="" channel="" set_dir=""
    local managed_present="" app_present="" qualification_present=""
    local managed_sha="" app_sha="" qualification_sha="" manifest_sha=""

    BASELINE_MANAGED_FALLBACKS=()
    if [ "$SELECTED_MANAGED_PRESENT" = true ]; then
        add_managed_baseline_fallback "$SELECTED_MANAGED_ARCHIVE"
    fi

    if [ "${#BASELINE_RECORDS[@]}" -gt 0 ]; then
        for record in "${BASELINE_RECORDS[@]}"; do
            IFS=$'\x1f' read -r kind id label created_at build channel set_dir \
                managed_present app_present qualification_present managed_sha app_sha \
                qualification_sha manifest_sha <<EOF
$record
EOF
            if [ "$kind" = "set" ] && [ "$managed_present" = true ]; then
                add_managed_baseline_fallback "$set_dir/managed.zip"
            fi
        done
    fi
    if [ -f "$MANAGED_BASELINE" ] && [ ! -L "$MANAGED_BASELINE" ]; then
        add_managed_baseline_fallback "$MANAGED_BASELINE"
    fi
}

load_selected_baseline_record() {
    local record="$1"
    local managed_present="" app_present="" qualification_present=""

    IFS=$'\x1f' read -r SELECTED_BASELINE_KIND SELECTED_BASELINE_ID \
        SELECTED_BASELINE_LABEL SELECTED_BASELINE_CREATED_AT SELECTED_BASELINE_BUILD \
        SELECTED_BASELINE_CHANNEL SELECTED_BASELINE_DIR managed_present app_present \
        qualification_present SELECTED_MANAGED_SHA256 SELECTED_APP_SUPPORT_SHA256 \
        SELECTED_QUALIFICATION_SHA256 SELECTED_BASELINE_MANIFEST_SHA256 <<EOF
$record
EOF

    SELECTED_MANAGED_PRESENT="$managed_present"
    SELECTED_APP_SUPPORT_PRESENT="$app_present"
    SELECTED_QUALIFICATION_PRESENT="$qualification_present"
    if [ "$SELECTED_BASELINE_KIND" = "legacy" ]; then
        SELECTED_MANAGED_ARCHIVE="$MANAGED_BASELINE"
        SELECTED_APP_SUPPORT_ARCHIVE="$APP_SUPPORT_BASELINE"
        SELECTED_QUALIFICATION_ARCHIVE=""
    else
        SELECTED_MANAGED_ARCHIVE="$SELECTED_BASELINE_DIR/managed.zip"
        SELECTED_APP_SUPPORT_ARCHIVE="$SELECTED_BASELINE_DIR/application-support.zip"
        SELECTED_QUALIFICATION_ARCHIVE="$SELECTED_BASELINE_DIR/local-qualification.zip"
    fi
}

baseline_folder_summary() {
    local managed_present="$1"
    local app_present="$2"
    local qualification_present="$3"
    local result=""

    [ "$managed_present" = true ] && result="managed" || result="managed absent"
    [ "$app_present" = true ] && result="$result, app data" || result="$result, app data absent"
    [ "$qualification_present" = true ] \
        && result="$result, qualification" \
        || result="$result, qualification absent"
    printf '%s\n' "$result"
}

choose_baseline_record() {
    local count="${#BASELINE_RECORDS[@]}"
    local index=0
    local selection=""
    local selection_number=0
    local record="" kind="" id="" label="" created_at="" build="" channel="" set_dir=""
    local managed_present="" app_present="" qualification_present=""
    local managed_sha="" app_sha="" qualification_sha="" manifest_sha=""
    local details=""
    local source_details=""

    if [ "$count" -eq 1 ]; then
        load_selected_baseline_record "${BASELINE_RECORDS[0]}"
        log "Selected baseline: $SELECTED_BASELINE_LABEL"
        return 0
    fi

    log ""
    log "Saved baselines (newest captured first):"
    for record in "${BASELINE_RECORDS[@]}"; do
        index=$((index + 1))
        IFS=$'\x1f' read -r kind id label created_at build channel set_dir \
            managed_present app_present qualification_present managed_sha app_sha \
            qualification_sha manifest_sha <<EOF
$record
EOF
        details="$(baseline_folder_summary "$managed_present" "$app_present" "$qualification_present")"
        if [ "$kind" = "legacy" ]; then
            log "  $index) $label [legacy; $details]"
        elif [ "$build" != "-" ] || [ "$channel" != "-" ]; then
            source_details=""
            [ "$build" != "-" ] && source_details="build $build"
            if [ "$channel" != "-" ]; then
                [ -n "$source_details" ] && source_details="$source_details; "
                source_details="${source_details}channel $channel"
            fi
            log "  $index) $label [$created_at; $source_details; $details]"
        else
            log "  $index) $label [$created_at; $details]"
        fi
    done

    while true; do
        selection="$(trim "$(read_prompt "Choose a baseline [1]: ")")"
        [ -n "$selection" ] || selection="1"
        case "$selection" in
            *[!0-9]*|'') warn "Choose a baseline number from 1 to $count." ;;
            *)
                selection_number=$((10#$selection))
                if [ "$selection_number" -ge 1 ] 2>/dev/null && [ "$selection_number" -le "$count" ] 2>/dev/null; then
                    load_selected_baseline_record "${BASELINE_RECORDS[$((selection_number - 1))]}"
                    return 0
                fi
                warn "Choose a baseline number from 1 to $count."
                ;;
        esac
    done
}

choose_restore_policy() {
    log ""
    discover_baselines
    if [ "${#BASELINE_RECORDS[@]}" -eq 0 ]; then
        log "No saved baselines were found; reset will use fresh disk state."
        RESTORE_BASELINES=false
    elif prompt_yes_no "Restore a saved baseline after reset? [Y/n]: " "yes"; then
        RESTORE_BASELINES=true
        choose_baseline_record
    else
        RESTORE_BASELINES=false
    fi

    if prompt_yes_no "Also clear PORTICO Keychain passwords, legacy OAuth certificates, and SSL caches? [y/N]: " "no"; then
        CLEAR_SECURE_STATE=true
    else
        CLEAR_SECURE_STATE=false
    fi

    build_managed_baseline_fallbacks
}

resolve_custom_channel() {
    local raw=""
    local normalized=""
    local resolved_channel=""
    local resolved_package=""

    while true; do
        raw="$(read_prompt "Custom channel slug or package name: ")"
        normalized="$(normalize_release_channel_name "$raw")"

        if resolved_channel="$(release_package_name_to_channel "$normalized" 2>/dev/null)"; then
            resolved_package="$normalized"
        elif resolved_package="$(release_channel_to_package_name "$normalized" 2>/dev/null)"; then
            resolved_channel="$normalized"
        else
            warn "Invalid custom channel. Use 1-64 lowercase letters, digits, hyphens, or underscores with an alphanumeric first and last character."
            continue
        fi

        CHANNEL_NAME="$resolved_channel"
        CHANNEL_PACKAGE="$resolved_package"
        return 0
    done
}

choose_channel() {
    local selection=""

    log ""
    log "Release channel:"
    log "  1) Stable"
    log "  2) Beta"
    log "  3) Development"
    log "  4) Custom"

    while true; do
        selection="$(read_prompt "Choose a channel [2]: ")"
        selection="$(trim "$selection")"
        [ -n "$selection" ] || selection="2"
        case "$selection" in
            1|stable|Stable)
                CHANNEL_NAME="stable"
                CHANNEL_PACKAGE="$(release_channel_to_package_name stable)"
                return 0
                ;;
            2|beta|Beta)
                CHANNEL_NAME="beta"
                CHANNEL_PACKAGE="$(release_channel_to_package_name beta)"
                return 0
                ;;
            3|dev|Dev|development|Development)
                CHANNEL_NAME="dev"
                CHANNEL_PACKAGE="$(release_channel_to_package_name dev)"
                return 0
                ;;
            4|custom|Custom)
                resolve_custom_channel
                return 0
                ;;
            *) warn "Choose 1, 2, 3, or 4." ;;
        esac
    done
}

configured_environment_value() {
    case "$1" in
        CLOUDSMITH_OWNER) printf '%s\n' "${CLOUDSMITH_OWNER:-}" ;;
        CLOUDSMITH_REPO) printf '%s\n' "${CLOUDSMITH_REPO:-}" ;;
        CLOUDSMITH_API_BASE) printf '%s\n' "${CLOUDSMITH_API_BASE:-}" ;;
        CLOUDSMITH_DL_BASE) printf '%s\n' "${CLOUDSMITH_DL_BASE:-}" ;;
        CLOUDSMITH_API_KEY) printf '%s\n' "${CLOUDSMITH_API_KEY:-}" ;;
        CLOUDSMITH_ENTITLEMENT_TOKEN) printf '%s\n' "${CLOUDSMITH_ENTITLEMENT_TOKEN:-}" ;;
        *) return 1 ;;
    esac
}

read_archive_env_value() {
    local archive="$1"
    local key="$2"

    [ -f "$archive" ] || return 1
    python3 - "$archive" "$key" <<'PY' 2>/dev/null
import sys
import zipfile

archive_path, key = sys.argv[1:3]
entry_name = "portico-managed/cloudsmith.env"
with zipfile.ZipFile(archive_path) as archive:
    info = archive.getinfo(entry_name)
    if info.file_size > 64 * 1024:
        raise ValueError("cloudsmith.env exceeds the bounded read size")
    contents = archive.read(info).decode("utf-8")

for line in contents.splitlines():
    if not line or line.startswith("#") or not line.startswith(key + "="):
        continue
    value = line.split("=", 1)[1].strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1]
    if value.strip():
        print(value.strip())
        raise SystemExit(0)
raise SystemExit(1)
PY
}

resolve_cloudsmith_value() {
    local key="$1"
    local default_value="${2:-}"
    local include_keychain="${3:-false}"
    local value=""
    local candidate=""

    value="$(trim "$(configured_environment_value "$key" 2>/dev/null || true)")"
    if [ -n "$value" ]; then
        printf '%s\n' "$value"
        return 0
    fi

    for candidate in "$REPOSITORY_CLOUDSMITH_ENV" "$INSTALLED_CLOUDSMITH_ENV"; do
        value="$(read_env_value_from_file "$candidate" "$key" 2>/dev/null || true)"
        value="$(trim "$value")"
        if [ -n "$value" ]; then
            printf '%s\n' "$value"
            return 0
        fi
    done

    if [ "$include_keychain" = true ]; then
        value="$(read_secret_from_keychain "$key" 2>/dev/null || true)"
        value="$(trim "$value")"
        if [ -n "$value" ]; then
            printf '%s\n' "$value"
            return 0
        fi
    fi

    value="$(read_env_value_from_file "$MANAGED_CLOUDSMITH_ENV" "$key" 2>/dev/null || true)"
    value="$(trim "$value")"
    if [ -n "$value" ]; then
        printf '%s\n' "$value"
        return 0
    fi

    if [ "${#BASELINE_MANAGED_FALLBACKS[@]}" -gt 0 ]; then
        for candidate in "${BASELINE_MANAGED_FALLBACKS[@]}"; do
            value="$(read_archive_env_value "$candidate" "$key" 2>/dev/null || true)"
            value="$(trim "$value")"
            if [ -n "$value" ]; then
                printf '%s\n' "$value"
                return 0
            fi
        done
    fi

    [ -n "$default_value" ] || return 1
    printf '%s\n' "$default_value"
}

resolve_cloudsmith_configuration() {
    CLOUDSMITH_OWNER="$(resolve_cloudsmith_value CLOUDSMITH_OWNER "$CLOUDSMITH_OWNER_DEFAULT")"
    CLOUDSMITH_REPO="$(resolve_cloudsmith_value CLOUDSMITH_REPO "$CLOUDSMITH_REPO_DEFAULT")"
    CLOUDSMITH_API_BASE="$(resolve_cloudsmith_value CLOUDSMITH_API_BASE "$CLOUDSMITH_API_BASE_DEFAULT")"
    CLOUDSMITH_DL_BASE="$(resolve_cloudsmith_value CLOUDSMITH_DL_BASE "$CLOUDSMITH_DL_BASE_DEFAULT")"
    CLOUDSMITH_API_KEY="$(resolve_cloudsmith_value CLOUDSMITH_API_KEY "" true 2>/dev/null || true)"
    CLOUDSMITH_ENTITLEMENT_TOKEN="$(resolve_cloudsmith_value CLOUDSMITH_ENTITLEMENT_TOKEN "" true 2>/dev/null || true)"

    CLOUDSMITH_API_BASE="${CLOUDSMITH_API_BASE%/}"
    CLOUDSMITH_DL_BASE="${CLOUDSMITH_DL_BASE%/}"

    [ -n "$CLOUDSMITH_API_KEY" ] \
        || die "CLOUDSMITH_API_KEY could not be resolved for private package discovery"
    [ -n "$CLOUDSMITH_ENTITLEMENT_TOKEN" ] \
        || die "CLOUDSMITH_ENTITLEMENT_TOKEN could not be resolved for the release download"
}

urlencode_query() {
    python3 - "$1" <<'PY'
import sys
import urllib.parse
print(urllib.parse.quote(sys.argv[1], safe=""))
PY
}

urlencode_path_segment() {
    printf '%s' "$1" | python3 -c '
import sys
import urllib.parse
print(urllib.parse.quote(sys.stdin.read(), safe=""))
'
}

select_latest_package() {
    local response_file="$1"
    local package_name="$2"

    python3 - "$response_file" "$package_name" "portico-update-ready-v1" <<'PY'
import json
import re
import sys
from datetime import datetime, timezone

response_path, package_name, ready_tag = sys.argv[1:4]
with open(response_path, "r", encoding="utf-8") as handle:
    payload = json.load(handle)

if isinstance(payload, list):
    packages = payload
elif isinstance(payload, dict):
    packages = payload.get("data") or payload.get("results") or []
else:
    packages = []

pattern = re.compile(
    rf"^{re.escape(package_name)}-(\d{{8}}-[a-f0-9]{{8,40}})\.zip$"
)

def timestamp_value(package):
    raw = package.get("uploaded_at") or package.get("created_at") or ""
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed
    except (TypeError, ValueError):
        return datetime.fromtimestamp(0, timezone.utc)

def flatten_tags(value):
    if isinstance(value, str):
        return {value.strip()} if value.strip() else set()
    if isinstance(value, list):
        tags = set()
        for item in value:
            tags.update(flatten_tags(item))
        return tags
    if isinstance(value, dict):
        tags = set()
        for item in value.values():
            tags.update(flatten_tags(item))
        return tags
    return set()

candidates = []
for package in packages:
    if not isinstance(package, dict):
        continue
    if package.get("name") not in (None, "", package_name):
        continue
    if ready_tag not in flatten_tags(package.get("tags_immutable")):
        continue
    version = str(package.get("version") or "").strip()
    filename = package.get("filename") or (
        f"{package_name}-{version}.zip" if version else ""
    )
    match = pattern.fullmatch(filename)
    if not match:
        continue
    build_id = match.group(1)
    if build_id.startswith("99999999-"):
        continue
    version = version or build_id
    if version != build_id:
        continue
    checksum = str(package.get("checksum_sha256") or "").strip().lower()
    if not re.fullmatch(r"[a-f0-9]{64}", checksum):
        continue
    uploaded = str(package.get("uploaded_at") or package.get("created_at") or "")
    candidates.append((
        timestamp_value(package),
        filename,
        build_id,
        version,
        checksum,
        uploaded,
    ))

if not candidates:
    raise SystemExit(1)

candidates.sort(reverse=True)
_, filename, build_id, version, checksum, uploaded = candidates[0]
print("\x1f".join((build_id, version, filename, checksum, uploaded)))
PY
}

discover_latest_release() {
    local query=""
    local encoded_query=""
    local api_url=""
    local response_file=""
    local stderr_file=""
    local http_status=""
    local selected=""

    query="name:^${CHANNEL_PACKAGE}$ format:raw tag:^portico-update-ready-v1$"
    encoded_query="$(urlencode_query "$query")"
    api_url="${CLOUDSMITH_API_BASE}/packages/${CLOUDSMITH_OWNER}/${CLOUDSMITH_REPO}/?query=${encoded_query}&page_size=100&sort=-date"
    response_file="$(mktemp "${TMPDIR:-/tmp}/portico-reset-packages.XXXXXX")"
    stderr_file="$(mktemp "${TMPDIR:-/tmp}/portico-reset-curl.XXXXXX")"

    log ""
    log "Looking up the latest ${CHANNEL_NAME} release in Cloudsmith..."
    if ! http_status="$(curl -sS -o "$response_file" -w '%{http_code}' \
        -H 'Accept: application/json' \
        -H "X-Api-Key: ${CLOUDSMITH_API_KEY}" \
        "$api_url" 2>"$stderr_file")"; then
        rm -f -- "$response_file" "$stderr_file"
        die "Cloudsmith package lookup failed"
    fi
    rm -f -- "$stderr_file"
    if [ "$http_status" != "200" ]; then
        rm -f -- "$response_file"
        die "Cloudsmith package lookup failed with HTTP $http_status"
    fi

    if ! selected="$(select_latest_package "$response_file" "$CHANNEL_PACKAGE" 2>/dev/null)"; then
        rm -f -- "$response_file"
        die "No valid downloadable release ZIP was found for $CHANNEL_PACKAGE"
    fi
    rm -f -- "$response_file"

    IFS=$'\x1f' read -r BUILD_ID PACKAGE_VERSION PACKAGE_FILENAME \
        PACKAGE_CHECKSUM_SHA256 PACKAGE_TIMESTAMP <<EOF
$selected
EOF

    [ -n "$BUILD_ID" ] && [ -n "$PACKAGE_FILENAME" ] \
        || die "Cloudsmith returned incomplete package metadata"

    DOWNLOAD_URL="${CLOUDSMITH_DL_BASE}/$(urlencode_path_segment "$CLOUDSMITH_ENTITLEMENT_TOKEN")/$(urlencode_path_segment "$CLOUDSMITH_REPO")/raw/names/$(urlencode_path_segment "$CHANNEL_PACKAGE")/versions/$(urlencode_path_segment "$PACKAGE_VERSION")/$(urlencode_path_segment "$PACKAGE_FILENAME")"
}

selected_baseline_folder_status() {
    local present="$1"
    local archive="$2"

    if [ "$present" = true ]; then
        printf 'captured: %s\n' "$archive"
    else
        printf 'absent in snapshot (will remain absent)\n'
    fi
}

confirm_reset() {
    local response=""

    log ""
    log "============================================================"
    log "Portico reset summary"
    log "============================================================"
    log "Managed runtime:        $MANAGED_DIR"
    log "Qualification data:     $QUALIFICATION_DIR"
    log "Application data:       $APP_SUPPORT_DIR"
    log "Installed application:  $APP_PATH"
    log "Restore baseline:       $RESTORE_BASELINES"
    if [ "$RESTORE_BASELINES" = true ]; then
        log "  Selected:              $SELECTED_BASELINE_LABEL ($SELECTED_BASELINE_ID)"
        [ "$SELECTED_BASELINE_CREATED_AT" != "-" ] \
            && log "  Captured:              $SELECTED_BASELINE_CREATED_AT"
        [ "$SELECTED_BASELINE_BUILD" != "-" ] \
            && log "  Source build:          $SELECTED_BASELINE_BUILD"
        [ "$SELECTED_BASELINE_CHANNEL" != "-" ] \
            && log "  Source channel:        $SELECTED_BASELINE_CHANNEL"
        log "  Managed runtime:       $(selected_baseline_folder_status "$SELECTED_MANAGED_PRESENT" "$SELECTED_MANAGED_ARCHIVE")"
        log "  Application data:      $(selected_baseline_folder_status "$SELECTED_APP_SUPPORT_PRESENT" "$SELECTED_APP_SUPPORT_ARCHIVE")"
        log "  Qualification data:    $(selected_baseline_folder_status "$SELECTED_QUALIFICATION_PRESENT" "$SELECTED_QUALIFICATION_ARCHIVE")"
    fi
    log "Clear secure state:     $CLEAR_SECURE_STATE"
    log "Release channel:        $CHANNEL_NAME ($CHANNEL_PACKAGE)"
    log "Selected build:         $BUILD_ID"
    [ -n "$PACKAGE_TIMESTAMP" ] && log "Uploaded:               $PACKAGE_TIMESTAMP"
    log "Downloads parent:       $DOWNLOADS_DIR"
    log "Verified release cache: $RELEASE_CACHE_DIR"
    log "Docker policy:          stop PORTICO containers; preserve containers/images/volumes"
    log ""
    log "The release will be obtained from the verified cache or downloaded, then fully"
    log "validated before any path above is deleted."
    log "============================================================"
    response="$(read_prompt "Type RESET to continue: ")"
    if [ "$response" != "RESET" ]; then
        log "Reset cancelled; no installation state was changed."
        exit 0
    fi
}

create_download_workspace() {
    local candidate=""
    local suffix=1

    mkdir -p -- "$DOWNLOADS_DIR"
    chmod 700 "$DOWNLOADS_DIR" 2>/dev/null || true

    candidate="$DOWNLOADS_DIR/${CHANNEL_PACKAGE}-${BUILD_ID}"
    while ! mkdir -m 700 "$candidate" 2>/dev/null; do
        suffix=$((suffix + 1))
        [ "$suffix" -le 1000 ] || die "Could not allocate a unique Downloads workspace"
        candidate="$DOWNLOADS_DIR/${CHANNEL_PACKAGE}-${BUILD_ID}-${suffix}"
    done

    DOWNLOAD_WORKSPACE="$candidate"
    DOWNLOAD_FILE="$DOWNLOAD_WORKSPACE/$PACKAGE_FILENAME"
    EXTRACT_DIR="$DOWNLOAD_WORKSPACE/release"
    CLEAN_DOWNLOAD_WORKSPACE=true
}

release_archive_matches_cloudsmith_checksum() {
    local archive="$1"
    local actual_checksum=""

    [ -f "$archive" ] && [ ! -L "$archive" ] || return 1
    actual_checksum="$(shasum -a 256 "$archive" 2>/dev/null | awk '{print tolower($1)}')" \
        || return 1
    [ "$actual_checksum" = "$PACKAGE_CHECKSUM_SHA256" ]
}

ensure_release_cache() {
    local expected_cache="$HOME/Library/Caches/Portico/Release Downloads"

    if [ "$TEST_MODE" = true ]; then
        expected_cache="${portico_RESET_TEST_RELEASE_CACHE_DIR:-$expected_cache}"
    fi
    [ "$RELEASE_CACHE_DIR" = "$expected_cache" ] \
        || die "Release-cache target changed unexpectedly"
    case "$RELEASE_CACHE_DIR" in
        "$HOME"/*) ;;
        *) die "Release cache is outside HOME" ;;
    esac
    python3 - "$HOME" "$RELEASE_CACHE_DIR" <<'PY' \
        || die "Release cache resolves outside HOME"
import os
import sys

home = os.path.realpath(sys.argv[1])
cache = os.path.realpath(sys.argv[2])
try:
    inside = os.path.commonpath((home, cache)) == home
except ValueError:
    inside = False
if not inside:
    raise SystemExit(1)
PY
    if [ -L "$RELEASE_CACHE_DIR" ] \
        || { [ -e "$RELEASE_CACHE_DIR" ] && [ ! -d "$RELEASE_CACHE_DIR" ]; }; then
        die "Release cache is not a safe directory: $RELEASE_CACHE_DIR"
    fi

    mkdir -p -- "$RELEASE_CACHE_DIR"
    chmod 700 "$RELEASE_CACHE_DIR"
    RELEASE_CACHE_FILE="$RELEASE_CACHE_DIR/$PACKAGE_CHECKSUM_SHA256.zip"
    if [ -L "$RELEASE_CACHE_FILE" ] \
        || { [ -e "$RELEASE_CACHE_FILE" ] && [ ! -f "$RELEASE_CACHE_FILE" ]; }; then
        die "Cached release path is not a safe regular file: $RELEASE_CACHE_FILE"
    fi
}

publish_release_cache_temp() {
    [ -n "$RELEASE_CACHE_TEMP_FILE" ] && [ -f "$RELEASE_CACHE_TEMP_FILE" ] \
        && [ ! -L "$RELEASE_CACHE_TEMP_FILE" ] \
        || die "Release-cache temporary file disappeared"
    release_archive_matches_cloudsmith_checksum "$RELEASE_CACHE_TEMP_FILE" \
        || die "Release-cache temporary file failed SHA-256 verification"

    if [ -e "$RELEASE_CACHE_FILE" ] || [ -L "$RELEASE_CACHE_FILE" ]; then
        if release_archive_matches_cloudsmith_checksum "$RELEASE_CACHE_FILE"; then
            rm -f -- "$RELEASE_CACHE_TEMP_FILE"
            RELEASE_CACHE_TEMP_FILE=""
            return 0
        fi
        if [ -L "$RELEASE_CACHE_FILE" ] || [ ! -f "$RELEASE_CACHE_FILE" ]; then
            die "Cached release path became unsafe: $RELEASE_CACHE_FILE"
        fi
        rm -f -- "$RELEASE_CACHE_FILE"
    fi

    if ln "$RELEASE_CACHE_TEMP_FILE" "$RELEASE_CACHE_FILE" 2>/dev/null; then
        rm -f -- "$RELEASE_CACHE_TEMP_FILE"
        RELEASE_CACHE_TEMP_FILE=""
    elif release_archive_matches_cloudsmith_checksum "$RELEASE_CACHE_FILE"; then
        # Another invocation published the same verified content first.
        rm -f -- "$RELEASE_CACHE_TEMP_FILE"
        RELEASE_CACHE_TEMP_FILE=""
    else
        die "Could not atomically publish the verified release cache entry"
    fi
    chmod 600 "$RELEASE_CACHE_FILE"
}

copy_release_into_cache() {
    local source_archive="$1"

    RELEASE_CACHE_TEMP_FILE="$(mktemp "$RELEASE_CACHE_DIR/.download.XXXXXX")"
    chmod 600 "$RELEASE_CACHE_TEMP_FILE"
    if ! cp "$source_archive" "$RELEASE_CACHE_TEMP_FILE"; then
        die "Could not copy the existing release into the verified cache"
    fi
    publish_release_cache_temp
}

seed_release_cache_from_downloads() {
    local candidate=""

    [ -d "$DOWNLOADS_DIR" ] && [ ! -L "$DOWNLOADS_DIR" ] || return 1
    # Do not use an empty array here: macOS Bash 3.2 treats expansion of a
    # declared-but-empty array as an unbound variable under `set -u`.
    for candidate in "$DOWNLOADS_DIR"/*/"$PACKAGE_FILENAME"; do
        if release_archive_matches_cloudsmith_checksum "$candidate"; then
            log "Found a verified copy of $PACKAGE_FILENAME in an existing Downloads workspace."
            copy_release_into_cache "$candidate"
            return 0
        fi
    done
    return 1
}

download_release_into_cache() {
    local stderr_file=""

    RELEASE_CACHE_TEMP_FILE="$(mktemp "$RELEASE_CACHE_DIR/.download.XXXXXX")"
    chmod 600 "$RELEASE_CACHE_TEMP_FILE"
    stderr_file="$(mktemp "${TMPDIR:-/tmp}/portico-reset-download.XXXXXX")"

    log "Downloading $PACKAGE_FILENAME into the verified release cache..."
    if ! curl -fL --retry 2 --retry-delay 1 --output "$RELEASE_CACHE_TEMP_FILE" \
        "$DOWNLOAD_URL" 2>"$stderr_file"; then
        rm -f -- "$stderr_file"
        die "Release download failed"
    fi
    rm -f -- "$stderr_file"

    if ! release_archive_matches_cloudsmith_checksum "$RELEASE_CACHE_TEMP_FILE"; then
        die "Downloaded release SHA-256 does not match Cloudsmith metadata"
    fi
    publish_release_cache_temp
}

prepare_verified_release_cache() {
    ensure_release_cache

    if release_archive_matches_cloudsmith_checksum "$RELEASE_CACHE_FILE"; then
        log "Using cached $PACKAGE_FILENAME (Cloudsmith SHA-256 verified)."
        return 0
    fi
    if [ -e "$RELEASE_CACHE_FILE" ]; then
        warn "Discarding a cached release whose SHA-256 no longer matches Cloudsmith metadata."
        rm -f -- "$RELEASE_CACHE_FILE"
    fi

    if seed_release_cache_from_downloads; then
        log "Added $PACKAGE_FILENAME to the verified release cache."
    else
        download_release_into_cache
    fi
    release_archive_matches_cloudsmith_checksum "$RELEASE_CACHE_FILE" \
        || die "Verified release cache entry is unavailable after preparation"
}

materialize_cached_release() {
    if cp -c "$RELEASE_CACHE_FILE" "$DOWNLOAD_FILE" 2>/dev/null; then
        :
    elif ! cp "$RELEASE_CACHE_FILE" "$DOWNLOAD_FILE"; then
        die "Could not copy the cached release into the Downloads workspace"
    fi
    chmod 600 "$DOWNLOAD_FILE"
    release_archive_matches_cloudsmith_checksum "$DOWNLOAD_FILE" \
        || die "Release workspace copy failed SHA-256 verification"
}

run_release_payload_validator() {
    local output_file="$1"
    local status=0
    shift

    if python3 "$PAYLOAD_VALIDATOR" \
        --payload "$DOWNLOAD_FILE" \
        --expected-build-id "$BUILD_ID" \
        --expected-channel-package "$CHANNEL_PACKAGE" \
        "$@" >"$output_file" 2>&1; then
        status=0
    else
        status=$?
    fi
    cat "$output_file"
    return "$status"
}

is_missing_ootb_marketplace_only_failure() {
    local output_file="$1"

    awk '
        BEGIN { allowed = 0; other = 0 }
        /^Error: / {
            if ($0 == "Error: payload is missing the OOTB marketplace config: managed-root/marketplaces-ootb.json" ||
                $0 == "Error: payload is missing the OOTB marketplace skills: managed-root/skills-marketplace-ootb/") {
                allowed++
            } else {
                other++
            }
        }
        END { exit !(allowed == 1 && other == 0) }
    ' "$output_file"
}

validate_downloaded_release_payload() {
    local output_file="$DOWNLOAD_WORKSPACE/.payload-validator-output"

    if run_release_payload_validator "$output_file"; then
        rm -f -- "$output_file"
        return 0
    fi

    if ! is_missing_ootb_marketplace_only_failure "$output_file"; then
        rm -f -- "$output_file"
        die "Release payload validation failed"
    fi

    log ""
    warn "This release is missing an OOTB marketplace bootstrap asset."
    warn "All non-marketplace payload checks remain mandatory."
    if ! prompt_yes_no \
        "Ignore this missing OOTB marketplace validation error and continue? [y/N]: " \
        "no"; then
        rm -f -- "$output_file"
        die "Release payload validation was not overridden"
    fi

    log "Re-running payload validation with the missing-OOTB exception only..."
    if ! run_release_payload_validator \
        "$output_file" \
        --allow-missing-ootb-marketplace-assets; then
        rm -f -- "$output_file"
        die "Release payload validation failed after the missing-OOTB exception"
    fi
    rm -f -- "$output_file"
}

download_and_validate_release() {
    local dmg_candidates=()

    prepare_verified_release_cache
    create_download_workspace
    materialize_cached_release

    log ""
    log "Validating release payload structure and CRCs..."
    validate_downloaded_release_payload

    mkdir -m 700 "$EXTRACT_DIR"
    ditto -x -k "$DOWNLOAD_FILE" "$EXTRACT_DIR"

    shopt -s nullglob
    dmg_candidates=("$EXTRACT_DIR"/artifacts/dmg/darwin-arm64/*.dmg)
    shopt -u nullglob
    if [ "${#dmg_candidates[@]}" -ne 1 ]; then
        die "Expected exactly one arm64 DMG in artifacts/dmg/darwin-arm64"
    fi
    DMG_PATH="${dmg_candidates[0]}"
    [ -f "$DMG_PATH" ] && [ ! -L "$DMG_PATH" ] \
        || die "The arm64 DMG is not a regular file"

    log "Verifying arm64 DMG integrity..."
    hdiutil verify "$DMG_PATH" >/dev/null
    CLEAN_DOWNLOAD_WORKSPACE=false
    log "Validated release workspace: $DOWNLOAD_WORKSPACE"
}

validate_baseline_archive() {
    local archive="$1"
    local expected_root="$2"

    python3 - "$archive" "$expected_root" <<'PY'
import os
import posixpath
import stat
import sys
import zipfile
from pathlib import PurePosixPath

archive_path, expected_root = sys.argv[1:3]

def safe_name(raw):
    if not raw or "\x00" in raw or "\\" in raw:
        raise ValueError(f"unsafe archive path: {raw!r}")
    if raw.startswith("/"):
        raise ValueError(f"absolute archive path: {raw!r}")
    trimmed = raw[:-1] if raw.endswith("/") else raw
    path = PurePosixPath(trimmed)
    if not path.parts or str(path) != trimmed or any(part in ("", ".", "..") for part in path.parts):
        raise ValueError(f"unsafe archive path: {raw!r}")
    return trimmed

with zipfile.ZipFile(archive_path) as archive:
    bad_crc = archive.testzip()
    if bad_crc:
        raise ValueError(f"CRC failure in {bad_crc!r}")

    seen = set()
    found_root = False
    for info in archive.infolist():
        name = safe_name(info.filename)
        folded = name.casefold()
        if folded in seen:
            raise ValueError(f"duplicate archive path: {name!r}")
        seen.add(folded)

        if name == "__MACOSX" or name.startswith("__MACOSX/"):
            continue
        if name != expected_root and not name.startswith(expected_root + "/"):
            raise ValueError(f"unexpected top-level archive path: {name!r}")
        found_root = True

        mode = (info.external_attr >> 16) & 0xFFFF
        kind = stat.S_IFMT(mode)
        if kind not in (0, stat.S_IFREG, stat.S_IFDIR, stat.S_IFLNK):
            raise ValueError(f"unsupported archive entry type: {name!r}")
        if kind == stat.S_IFLNK:
            target = archive.read(info).decode("utf-8")
            if not target or "\x00" in target or "\\" in target or target.startswith("/"):
                raise ValueError(f"unsafe symlink target: {name!r}")
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), target))
            if resolved != expected_root and not resolved.startswith(expected_root + "/"):
                raise ValueError(f"symlink escapes baseline root: {name!r}")

    if not found_root:
        raise ValueError(f"archive does not contain {expected_root!r}")
PY
}

stage_one_baseline() {
    local archive="$1"
    local expected_root="$2"
    local stage_dir="$3"
    local expected_checksum="${4:-}"
    local actual_checksum=""

    [ -f "$archive" ] && [ ! -L "$archive" ] || return 1
    log "Validating baseline archive: $archive"
    if [ -n "$expected_checksum" ] && [ "$expected_checksum" != "-" ]; then
        actual_checksum="$(shasum -a 256 "$archive" | awk '{print tolower($1)}')"
        [ "$actual_checksum" = "$expected_checksum" ] \
            || die "Baseline archive SHA-256 does not match its manifest: $archive"
    fi
    validate_baseline_archive "$archive" "$expected_root" \
        || die "Baseline archive is unsafe or corrupt: $archive"

    mkdir -m 700 "$stage_dir"
    # Baseline archives may contain Archive Utility's __MACOSX AppleDouble
    # entries. They are not part of the restored application state.
    ditto -x -k --norsrc "$archive" "$stage_dir"
    if [ -d "$stage_dir/__MACOSX" ]; then
        rm -rf -- "$stage_dir/__MACOSX"
    fi
    [ -d "$stage_dir/$expected_root" ] && [ ! -L "$stage_dir/$expected_root" ] \
        || die "Baseline archive did not extract the expected $expected_root directory"
}

stage_baselines() {
    local actual_manifest_sha=""

    [ "$RESTORE_BASELINES" = true ] || return 0

    TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/portico-reset.XXXXXX")"
    chmod 700 "$TEMP_ROOT"

    if [ "$SELECTED_BASELINE_KIND" = "set" ]; then
        [ -f "$SELECTED_BASELINE_DIR/manifest.json" ] \
            && [ ! -L "$SELECTED_BASELINE_DIR/manifest.json" ] \
            || die "Selected baseline manifest disappeared before staging"
        actual_manifest_sha="$(shasum -a 256 "$SELECTED_BASELINE_DIR/manifest.json" | awk '{print tolower($1)}')"
        [ "$actual_manifest_sha" = "$SELECTED_BASELINE_MANIFEST_SHA256" ] \
            || die "Selected baseline manifest changed after selection"
        baseline_catalog_records "$SELECTED_BASELINE_DIR" >/dev/null \
            || die "Selected baseline manifest is no longer valid"
    fi

    if [ "$SELECTED_APP_SUPPORT_PRESENT" = true ]; then
        stage_one_baseline \
            "$SELECTED_APP_SUPPORT_ARCHIVE" "portico" "$TEMP_ROOT/app-support" \
            "$SELECTED_APP_SUPPORT_SHA256" \
            || die "Selected application-data baseline is missing"
        STAGED_APP_SUPPORT="$TEMP_ROOT/app-support/portico"
    fi

    if [ "$SELECTED_MANAGED_PRESENT" = true ]; then
        stage_one_baseline \
            "$SELECTED_MANAGED_ARCHIVE" "portico-managed" "$TEMP_ROOT/managed" \
            "$SELECTED_MANAGED_SHA256" \
            || die "Selected managed-runtime baseline is missing"
        STAGED_MANAGED="$TEMP_ROOT/managed/portico-managed"
    fi

    if [ "$SELECTED_QUALIFICATION_PRESENT" = true ]; then
        stage_one_baseline \
            "$SELECTED_QUALIFICATION_ARCHIVE" "Portico Local Qualification" \
            "$TEMP_ROOT/qualification" "$SELECTED_QUALIFICATION_SHA256" \
            || die "Selected qualification-data baseline is missing"
        STAGED_QUALIFICATION="$TEMP_ROOT/qualification/Portico Local Qualification"
    fi
}

app_process_ids() {
    pgrep -f '/Portico\.app/Contents/(MacOS/Portico|Frameworks/Portico Helper)' \
        2>/dev/null || true
}

wait_for_app_exit() {
    local attempts=0
    while [ -n "$(app_process_ids)" ] && [ "$attempts" -lt 20 ]; do
        sleep 0.5
        attempts=$((attempts + 1))
    done
    [ -z "$(app_process_ids)" ]
}

stop_running_app() {
    local pids=()
    local pid=""

    while IFS= read -r pid; do
        [ -n "$pid" ] && pids+=("$pid")
    done < <(app_process_ids)
    if [ "${#pids[@]}" -eq 0 ]; then
        log "No running Portico application processes found."
        return 0
    fi

    log "Requesting Portico to quit..."
    osascript -e 'tell application id "com.portico.ai-chat" to quit' >/dev/null 2>&1 || true
    if wait_for_app_exit; then
        log "Portico quit cleanly."
        return 0
    fi

    while IFS= read -r pid; do
        [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null || true
    done < <(app_process_ids)
    if wait_for_app_exit; then
        log "Portico stopped after SIGTERM."
        return 0
    fi

    while IFS= read -r pid; do
        [ -n "$pid" ] && kill -KILL "$pid" 2>/dev/null || true
    done < <(app_process_ids)
    sleep 0.5
    [ -z "$(app_process_ids)" ] \
        || die "Portico processes are still running; no installation paths were deleted"
}

collect_running_portico_containers() {
    local filter=""
    for filter in \
        "label=com.docker.compose.project=portico" \
        "label=com.docker.compose.project=portico-managed" \
        "label=com.docker.compose.project=portico-single" \
        "label=com.portico.ai-chat.image-role=agent-vm" \
        "name=agent-vm-"
    do
        docker ps -q --filter "$filter" 2>/dev/null || true
    done | awk 'NF && !seen[$0]++'
}

stop_portico_containers() {
    local containers=()
    local container=""

    if ! command -v docker >/dev/null 2>&1; then
        log "Docker CLI is unavailable; no running PORTICO containers can be present through this CLI."
        return 0
    fi
    if ! docker info >/dev/null 2>&1; then
        log "Docker is not running; skipping container shutdown."
        return 0
    fi

    while IFS= read -r container; do
        [ -n "$container" ] && containers+=("$container")
    done < <(collect_running_portico_containers)
    if [ "${#containers[@]}" -eq 0 ]; then
        log "No running PORTICO Docker containers found."
        return 0
    fi

    log "Stopping ${#containers[@]} PORTICO Docker container(s) without removing them..."
    docker stop "${containers[@]}" >/dev/null \
        || die "Failed to stop all PORTICO Docker containers; no installation paths were deleted"

    while IFS= read -r container; do
        if [ -n "$container" ]; then
            die "An PORTICO Docker container is still running after the stop request: $container"
        fi
    done < <(collect_running_portico_containers)
}

stop_runtime() {
    stop_running_app
    stop_portico_containers
}

wait_for_app_start() {
    local attempts=0
    while [ -z "$(app_process_ids)" ] && [ "$attempts" -lt 20 ]; do
        sleep 0.5
        attempts=$((attempts + 1))
    done
    [ -n "$(app_process_ids)" ]
}

record_capture_runtime_state() {
    local container=""

    CAPTURE_APP_WAS_RUNNING=false
    CAPTURE_RUNNING_CONTAINERS=()
    if [ -n "$(app_process_ids)" ]; then
        CAPTURE_APP_WAS_RUNNING=true
        [ -d "$APP_PATH" ] && [ ! -L "$APP_PATH" ] \
            || die "The running application cannot be relaunched safely from $APP_PATH"
    fi

    if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
        while IFS= read -r container; do
            [ -n "$container" ] && CAPTURE_RUNNING_CONTAINERS+=("$container")
        done < <(collect_running_portico_containers)
    fi
}

restore_capture_runtime() {
    local container=""
    local running=""
    local found=false
    local failed=false

    [ "$CAPTURE_RUNTIME_NEEDS_RESTORE" = true ] || return 0
    log "Restoring the PORTICO runtime state from before baseline capture..."

    if [ "$CAPTURE_APP_WAS_RUNNING" = true ]; then
        if [ -z "$(app_process_ids)" ]; then
            if [ ! -d "$APP_PATH" ] || [ -L "$APP_PATH" ]; then
                warn "Cannot relaunch the previously running app from $APP_PATH"
                failed=true
            elif ! open "$APP_PATH" >/dev/null 2>&1; then
                warn "Failed to relaunch $APP_PATH"
                failed=true
            elif ! wait_for_app_start; then
                warn "The relaunched Portico app did not start in time"
                failed=true
            fi
        fi
    elif [ "${#CAPTURE_RUNNING_CONTAINERS[@]}" -gt 0 ]; then
        if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
            warn "Docker is unavailable; previously running PORTICO containers could not be restarted"
            failed=true
        elif ! docker start "${CAPTURE_RUNNING_CONTAINERS[@]}" >/dev/null; then
            warn "Docker failed to restart the previously running PORTICO containers"
            failed=true
        else
            running="$(collect_running_portico_containers)"
            for container in "${CAPTURE_RUNNING_CONTAINERS[@]}"; do
                found=false
                while IFS= read -r candidate; do
                    if [ "$candidate" = "$container" ]; then
                        found=true
                        break
                    fi
                done <<EOF
$running
EOF
                if [ "$found" != true ]; then
                    warn "Previously running PORTICO container did not restart: $container"
                    failed=true
                fi
            done
        fi
    fi

    [ "$failed" = false ] || return 1
    CAPTURE_RUNTIME_NEEDS_RESTORE=false
    log "Restored the prior PORTICO runtime state."
}

validate_capture_paths() {
    local expected_store="$HOME/Library/Application Support/Portico Baselines"

    if [ "$TEST_MODE" = true ]; then
        expected_store="${portico_RESET_TEST_BASELINE_STORE:-$expected_store}"
    fi
    [ "$BASELINE_STORE" = "$expected_store" ] || die "Baseline-store target changed unexpectedly"
    case "$BASELINE_STORE" in
        "$HOME"/*) ;;
        *) die "Baseline store is outside HOME" ;;
    esac
    python3 - "$HOME" "$BASELINE_STORE" "$MANAGED_DIR" "$APP_SUPPORT_DIR" "$QUALIFICATION_DIR" <<'PY' \
        || die "A baseline source or store resolves outside HOME"
import os
import sys

home = os.path.realpath(sys.argv[1])
for raw in sys.argv[2:]:
    resolved = os.path.realpath(raw)
    try:
        inside = os.path.commonpath((home, resolved)) == home
    except ValueError:
        inside = False
    if not inside:
        raise SystemExit(1)
PY
    if [ -L "$BASELINE_STORE" ] || { [ -e "$BASELINE_STORE" ] && [ ! -d "$BASELINE_STORE" ]; }; then
        die "Baseline store is not a safe directory: $BASELINE_STORE"
    fi

    validate_capture_source "$MANAGED_DIR" "Managed-runtime"
    validate_capture_source "$APP_SUPPORT_DIR" "Application-data"
    validate_capture_source "$QUALIFICATION_DIR" "Qualification-data"
}

validate_capture_source() {
    local path="$1"
    local label="$2"

    case "$path" in
        "$HOME"/*) ;;
        *) die "$label capture source is outside HOME" ;;
    esac
    if [ -L "$path" ]; then
        die "$label capture source must not be a symlink: $path"
    fi
    if [ -e "$path" ] && [ ! -d "$path" ]; then
        die "$label capture source is not a directory: $path"
    fi
}

validate_capture_tree_symlinks() {
    local root="$1"
    local excluded_relative_path="${2:-}"

    [ -d "$root" ] || return 0
    python3 - "$root" "$excluded_relative_path" <<'PY' \
        || die "Baseline capture source contains an unsafe symlink: $root"
import os
import posixpath
import sys

root, excluded = sys.argv[1:3]
excluded = excluded.strip("/")
expected_root = os.path.basename(os.path.normpath(root))


def normalized_relative(path):
    value = os.path.relpath(path, root)
    return "" if value == "." else value.replace(os.sep, "/")


def is_excluded(relative):
    return bool(excluded) and (
        relative == excluded or relative.startswith(excluded + "/")
    )


for directory, dirnames, filenames in os.walk(root, followlinks=False):
    for name in list(dirnames):
        relative = normalized_relative(os.path.join(directory, name))
        if is_excluded(relative):
            dirnames.remove(name)

    for name in list(dirnames) + filenames:
        path = os.path.join(directory, name)
        relative = normalized_relative(path)
        if is_excluded(relative) or not os.path.islink(path):
            continue
        try:
            target = os.readlink(path)
        except OSError as error:
            print(
                f"Unsafe baseline symlink {path!r}: target could not be read: {error}",
                file=sys.stderr,
            )
            raise SystemExit(1)

        reason = ""
        try:
            target.encode("utf-8")
        except UnicodeEncodeError:
            reason = "target is not valid UTF-8"
        if not reason and (
            not target
            or "\x00" in target
            or "\\" in target
            or target.startswith("/")
        ):
            reason = "target is empty, absolute, or not archive-safe"
        if not reason:
            archive_name = expected_root + "/" + relative
            resolved = posixpath.normpath(
                posixpath.join(posixpath.dirname(archive_name), target)
            )
            if resolved != expected_root and not resolved.startswith(expected_root + "/"):
                reason = "target escapes the captured folder"
        if reason:
            print(
                f"Unsafe baseline symlink {path!r} -> {target!r}: {reason}",
                file=sys.stderr,
            )
            raise SystemExit(1)
PY
}

directory_size_bytes() {
    python3 - "$1" "${2:-}" <<'PY'
import os
import stat
import sys

root, excluded = sys.argv[1:3]
excluded = excluded.strip("/")
if not os.path.exists(root) or os.path.islink(root):
    print(0)
    raise SystemExit(0)


def normalized_relative(path):
    value = os.path.relpath(path, root)
    return "" if value == "." else value.replace(os.sep, "/")


def is_excluded(relative):
    return bool(excluded) and (
        relative == excluded or relative.startswith(excluded + "/")
    )


total = 0
for directory, names, files in os.walk(root, followlinks=False):
    for name in list(names):
        if is_excluded(normalized_relative(os.path.join(directory, name))):
            names.remove(name)
    for name in names + files:
        path = os.path.join(directory, name)
        if is_excluded(normalized_relative(path)):
            continue
        try:
            info = os.lstat(path)
        except OSError:
            continue
        if stat.S_ISREG(info.st_mode):
            blocks = getattr(info, "st_blocks", 0)
            total += blocks * 512 if blocks else info.st_size
print(total)
PY
}

available_capture_bytes() {
    local probe="$HOME/Library/Application Support"

    if [ -n "${portico_RESET_TEST_AVAILABLE_BYTES:-}" ]; then
        printf '%s\n' "$portico_RESET_TEST_AVAILABLE_BYTES"
        return 0
    fi
    [ -d "$probe" ] || probe="$HOME"
    python3 - "$probe" <<'PY'
import shutil
import sys
print(shutil.disk_usage(sys.argv[1]).free)
PY
}

human_size() {
    python3 - "$1" <<'PY'
import sys
value = float(sys.argv[1])
units = ("B", "KiB", "MiB", "GiB", "TiB")
for unit in units:
    if value < 1024 or unit == units[-1]:
        print(f"{value:.1f} {unit}" if unit != "B" else f"{int(value)} B")
        break
    value /= 1024
PY
}

preflight_capture_sources() {
    validate_capture_paths

    [ -d "$MANAGED_DIR" ] && CAPTURE_MANAGED_PRESENT=true || CAPTURE_MANAGED_PRESENT=false
    [ -d "$APP_SUPPORT_DIR" ] && CAPTURE_APP_SUPPORT_PRESENT=true || CAPTURE_APP_SUPPORT_PRESENT=false
    [ -d "$QUALIFICATION_DIR" ] && CAPTURE_QUALIFICATION_PRESENT=true || CAPTURE_QUALIFICATION_PRESENT=false

    validate_capture_tree_symlinks "$MANAGED_DIR" "$MANAGED_CAPTURE_EXCLUDED_RELATIVE_PATH"
    validate_capture_tree_symlinks "$APP_SUPPORT_DIR"
    validate_capture_tree_symlinks "$QUALIFICATION_DIR"

    if [ -e "$MANAGED_DIR/$MANAGED_CAPTURE_EXCLUDED_RELATIVE_PATH" ] \
        || [ -L "$MANAGED_DIR/$MANAGED_CAPTURE_EXCLUDED_RELATIVE_PATH" ]; then
        CAPTURE_MANAGED_EXCLUDED_PRESENT=true
    else
        CAPTURE_MANAGED_EXCLUDED_PRESENT=false
    fi
    CAPTURE_MANAGED_EXCLUDED_SIZE="$(
        directory_size_bytes "$MANAGED_DIR/$MANAGED_CAPTURE_EXCLUDED_RELATIVE_PATH"
    )"
    CAPTURE_MANAGED_SIZE="$(
        directory_size_bytes "$MANAGED_DIR" "$MANAGED_CAPTURE_EXCLUDED_RELATIVE_PATH"
    )"
    CAPTURE_APP_SUPPORT_SIZE="$(directory_size_bytes "$APP_SUPPORT_DIR")"
    CAPTURE_QUALIFICATION_SIZE="$(directory_size_bytes "$QUALIFICATION_DIR")"
    CAPTURE_TOTAL_SIZE=$((CAPTURE_MANAGED_SIZE + CAPTURE_APP_SUPPORT_SIZE + CAPTURE_QUALIFICATION_SIZE))
    CAPTURE_REQUIRED_BYTES=$((CAPTURE_TOTAL_SIZE + CAPTURE_TOTAL_SIZE / 10 + 268435456))
    CAPTURE_AVAILABLE_BYTES="$(available_capture_bytes)"
    case "$CAPTURE_AVAILABLE_BYTES" in
        ''|*[!0-9]*) die "Could not determine available baseline-capture disk space" ;;
    esac
    [ "$CAPTURE_AVAILABLE_BYTES" -ge "$CAPTURE_REQUIRED_BYTES" ] \
        || die "Insufficient disk space for baseline capture: need $(human_size "$CAPTURE_REQUIRED_BYTES"), have $(human_size "$CAPTURE_AVAILABLE_BYTES")"
}

choose_capture_label() {
    local raw=""
    local normalized=""

    while true; do
        raw="$(read_prompt "Baseline name: ")"
        if normalized="$(python3 - "$raw" <<'PY'
import re
import sys
import unicodedata

label = sys.argv[1].strip()
if not 1 <= len(label) <= 80:
    raise SystemExit(1)
if "/" in label or "\\" in label or any(ord(char) < 32 or ord(char) == 127 for char in label):
    raise SystemExit(1)
ascii_label = unicodedata.normalize("NFKD", label).encode("ascii", "ignore").decode("ascii")
slug = re.sub(r"[^a-z0-9]+", "-", ascii_label.lower()).strip("-")[:48].rstrip("-")
if not slug:
    raise SystemExit(1)
print(label + "\x1f" + slug)
PY
)"; then
            IFS=$'\x1f' read -r CAPTURE_LABEL CAPTURE_SLUG <<EOF
$normalized
EOF
            return 0
        fi
        warn "Use a 1-80 character name with letters or digits and no path separators."
    done
}

allocate_capture_identity() {
    local timestamp="${portico_RESET_TEST_CAPTURE_TIMESTAMP:-}"
    local candidate=""
    local suffix=1

    [ -n "$timestamp" ] || timestamp="$(date '+%Y%m%d-%H%M%S')"
    case "$timestamp" in
        ????????-??????) ;;
        *) die "Capture timestamp is invalid" ;;
    esac
    case "${timestamp%-*}${timestamp#*-}" in
        *[!0-9]*) die "Capture timestamp is invalid" ;;
    esac
    CAPTURE_CREATED_AT="${portico_RESET_TEST_CAPTURE_CREATED_AT:-$(date -u '+%Y-%m-%dT%H:%M:%SZ')}"
    CAPTURE_ID="$timestamp-$CAPTURE_SLUG"
    candidate="$BASELINE_STORE/$CAPTURE_ID"
    while [ -e "$candidate" ] || [ -L "$candidate" ]; do
        suffix=$((suffix + 1))
        [ "$suffix" -le 1000 ] || die "Could not allocate a unique baseline name"
        CAPTURE_ID="$timestamp-$CAPTURE_SLUG-$suffix"
        candidate="$BASELINE_STORE/$CAPTURE_ID"
    done
    CAPTURE_DESTINATION="$candidate"
}

read_capture_build_metadata() {
    local metadata=""
    local build_info="$MANAGED_DIR/electron-app/build-info.json"

    CAPTURE_BUILD=""
    CAPTURE_CHANNEL=""
    [ -f "$build_info" ] && [ ! -L "$build_info" ] || return 0
    metadata="$(python3 - "$build_info" <<'PY' 2>/dev/null || true
import json
import os
import stat
import sys

path = sys.argv[1]
info = os.lstat(path)
if not stat.S_ISREG(info.st_mode) or info.st_size > 64 * 1024:
    raise SystemExit(1)
with open(path, encoding="utf-8") as handle:
    data = json.load(handle)
values = []
for key in ("buildNumber", "channel"):
    value = data.get(key)
    if not isinstance(value, str) or len(value) > 128 or any(ord(c) < 32 for c in value):
        value = ""
    values.append(value)
print("\x1f".join(values))
PY
)"
    IFS=$'\x1f' read -r CAPTURE_BUILD CAPTURE_CHANNEL <<EOF
$metadata
EOF
}

capture_source_status() {
    local present="$1"
    local size="$2"
    if [ "$present" = true ]; then
        printf 'present (%s)\n' "$(human_size "$size")"
    else
        printf 'absent (recorded as absent)\n'
    fi
}

capture_excluded_status() {
    if [ "$CAPTURE_MANAGED_EXCLUDED_PRESENT" = true ]; then
        printf 'excluded (%s; regenerated automatically)\n' \
            "$(human_size "$CAPTURE_MANAGED_EXCLUDED_SIZE")"
    else
        printf 'absent (nothing to exclude)\n'
    fi
}

confirm_capture() {
    local response=""

    log ""
    log "============================================================"
    log "Portico baseline capture summary"
    log "============================================================"
    log "Name:                   $CAPTURE_LABEL"
    log "Baseline ID:            $CAPTURE_ID"
    log "Destination:            $CAPTURE_DESTINATION"
    log "Managed runtime:        $MANAGED_DIR"
    log "  Status:                $(capture_source_status "$CAPTURE_MANAGED_PRESENT" "$CAPTURE_MANAGED_SIZE")"
    log "Generated scratch:      $MANAGED_DIR/$MANAGED_CAPTURE_EXCLUDED_RELATIVE_PATH"
    log "  Status:                $(capture_excluded_status)"
    log "Application data:       $APP_SUPPORT_DIR"
    log "  Status:                $(capture_source_status "$CAPTURE_APP_SUPPORT_PRESENT" "$CAPTURE_APP_SUPPORT_SIZE")"
    log "Qualification data:     $QUALIFICATION_DIR"
    log "  Status:                $(capture_source_status "$CAPTURE_QUALIFICATION_PRESENT" "$CAPTURE_QUALIFICATION_SIZE")"
    log "Estimated captured size: $(human_size "$CAPTURE_TOTAL_SIZE")"
    log "Runtime policy:         stop PORTICO, capture, then resume prior state"
    log "Keychain state:         excluded and unchanged"
    log "============================================================"
    response="$(read_prompt "Type CAPTURE to continue: ")"
    if [ "$response" != "CAPTURE" ]; then
        log "Baseline capture cancelled; no runtime or installation state was changed."
        exit 0
    fi
}

ensure_baseline_store() {
    validate_capture_paths
    mkdir -p -- "$BASELINE_STORE"
    [ -d "$BASELINE_STORE" ] && [ ! -L "$BASELINE_STORE" ] \
        || die "Could not create a safe baseline store"
    chmod 700 "$BASELINE_STORE"
}

create_capture_bom() {
    local source="$1"
    local excluded_relative_path="$2"
    local bom_path="$3"

    case "$excluded_relative_path" in
        ""|/*|*/../*|../*|*/..|*//*|*\\*)
            die "Unsafe managed baseline exclusion path: $excluded_relative_path"
            ;;
    esac
    if ! (
        cd "$source"
        find . \
            -path "./$excluded_relative_path" -prune \
            -o -print
    ) | mkbom -s -i /dev/stdin "$bom_path"; then
        die "Failed to create managed baseline inclusion BOM"
    fi
    [ -f "$bom_path" ] && [ ! -L "$bom_path" ] \
        || die "Managed baseline inclusion BOM was not created safely"
    chmod 600 "$bom_path"
}

capture_archive() {
    local source="$1"
    local archive="$2"
    local expected_root="$3"
    local excluded_relative_path="${4:-}"
    local bom_path=""

    log "Capturing $source" >&2
    if [ -n "$excluded_relative_path" ]; then
        bom_path="$CAPTURE_TEMP_ROOT/managed-baseline-inclusions.bom"
        create_capture_bom "$source" "$excluded_relative_path" "$bom_path"
        ditto -c -k --sequesterRsrc --keepParent --bom "$bom_path" \
            "$source" "$archive" \
            || die "Failed to create baseline archive for $source"
        rm -f -- "$bom_path"
    else
        ditto -c -k --sequesterRsrc --keepParent "$source" "$archive" \
            || die "Failed to create baseline archive for $source"
    fi
    chmod 600 "$archive"
    validate_baseline_archive "$archive" "$expected_root" \
        || die "Captured baseline archive failed validation: $archive"
    shasum -a 256 "$archive" | awk '{print tolower($1)}'
}

write_capture_manifest() {
    local managed_sha="$1"
    local app_sha="$2"
    local qualification_sha="$3"

    python3 - "$CAPTURE_TEMP_SET/manifest.json" "$CAPTURE_ID" "$CAPTURE_LABEL" \
        "$CAPTURE_CREATED_AT" "$CAPTURE_BUILD" "$CAPTURE_CHANNEL" \
        "$CAPTURE_MANAGED_PRESENT" "$managed_sha" \
        "$CAPTURE_APP_SUPPORT_PRESENT" "$app_sha" \
        "$CAPTURE_QUALIFICATION_PRESENT" "$qualification_sha" <<'PY'
import json
import sys

(
    path, baseline_id, label, created_at, build_number, channel,
    managed_present, managed_sha, app_present, app_sha,
    qualification_present, qualification_sha,
) = sys.argv[1:]


def folder_record(present, checksum):
    is_present = present == "true"
    return {"present": is_present, "sha256": checksum if is_present else None}


manifest = {
    "schema_version": 1,
    "id": baseline_id,
    "label": label,
    "created_at": created_at,
    "source_build": {
        "build_number": build_number or None,
        "channel": channel or None,
    },
    "folders": {
        "managed": folder_record(managed_present, managed_sha),
        "app_support": folder_record(app_present, app_sha),
        "qualification": folder_record(qualification_present, qualification_sha),
    },
}
with open(path, "x", encoding="utf-8") as handle:
    json.dump(manifest, handle, indent=2, sort_keys=True)
    handle.write("\n")
PY
    chmod 600 "$CAPTURE_TEMP_SET/manifest.json"
}

create_baseline_capture() {
    local managed_sha="-"
    local app_sha="-"
    local qualification_sha="-"

    ensure_baseline_store
    [ ! -e "$CAPTURE_DESTINATION" ] && [ ! -L "$CAPTURE_DESTINATION" ] \
        || die "Baseline destination appeared after confirmation: $CAPTURE_DESTINATION"

    record_capture_runtime_state
    CAPTURE_RUNTIME_NEEDS_RESTORE=true
    stop_runtime

    CAPTURE_TEMP_ROOT="$(mktemp -d "$BASELINE_STORE/.capture.XXXXXX")"
    chmod 700 "$CAPTURE_TEMP_ROOT"
    CAPTURE_TEMP_SET="$CAPTURE_TEMP_ROOT/$CAPTURE_ID"
    mkdir -m 700 "$CAPTURE_TEMP_SET"

    if [ "$CAPTURE_MANAGED_PRESENT" = true ]; then
        managed_sha="$(
            capture_archive \
                "$MANAGED_DIR" \
                "$CAPTURE_TEMP_SET/managed.zip" \
                "portico-managed" \
                "$MANAGED_CAPTURE_EXCLUDED_RELATIVE_PATH"
        )"
    fi
    if [ "$CAPTURE_APP_SUPPORT_PRESENT" = true ]; then
        app_sha="$(capture_archive "$APP_SUPPORT_DIR" "$CAPTURE_TEMP_SET/application-support.zip" "portico")"
    fi
    if [ "$CAPTURE_QUALIFICATION_PRESENT" = true ]; then
        qualification_sha="$(capture_archive "$QUALIFICATION_DIR" "$CAPTURE_TEMP_SET/local-qualification.zip" "Portico Local Qualification")"
    fi

    write_capture_manifest "$managed_sha" "$app_sha" "$qualification_sha"
    baseline_catalog_records "$CAPTURE_TEMP_SET" >/dev/null \
        || die "Captured baseline manifest failed validation"
    mv -- "$CAPTURE_TEMP_SET" "$CAPTURE_DESTINATION"
    CAPTURE_PUBLISHED_PATH="$CAPTURE_DESTINATION"
    rmdir "$CAPTURE_TEMP_ROOT"
    CAPTURE_TEMP_ROOT=""
    CAPTURE_TEMP_SET=""

    restore_capture_runtime || die "Baseline was captured, but the prior runtime state could not be restored"

    log ""
    log "Baseline capture complete."
    log "Baseline: $CAPTURE_PUBLISHED_PATH"
    log "Keychain state was not captured or changed."
}

run_capture_mode() {
    log "Portico baseline capture"
    log "-------------------------------"
    choose_capture_label
    preflight_capture_sources
    read_capture_build_metadata
    allocate_capture_identity
    confirm_capture
    create_baseline_capture
}

purge_secure_state_if_requested() {
    [ "$CLEAR_SECURE_STATE" = true ] || return 0

    log "Purging PORTICO-owned Keychain and legacy OAuth certificate state..."
    if [ "$TEST_MODE" = true ] && [ -n "${portico_RESET_TEST_KEYCHAIN_LOG:-}" ]; then
        printf '%s\n' \
            "portico_cleanup_legacy_oauth_certificates" \
            "portico_cleanup_generic_passwords" \
            "portico_remove_single_server_ssl_caches" \
            >>"$portico_RESET_TEST_KEYCHAIN_LOG"
        return 0
    fi

    portico_cleanup_legacy_oauth_certificates false "$SCRIPT_DIR"
    portico_cleanup_generic_passwords false
    portico_remove_single_server_ssl_caches false "$SCRIPT_DIR"
}

validate_destructive_targets() {
    local expected_managed="$HOME/portico/portico-managed"
    local expected_app_support="$HOME/Library/Application Support/portico"
    local expected_qualification="$HOME/Library/Application Support/Portico Local Qualification"
    local expected_app="/Applications/Portico.app"

    if [ "$TEST_MODE" = true ]; then
        expected_managed="${portico_RESET_TEST_MANAGED_DIR:-$expected_managed}"
        expected_app_support="${portico_RESET_TEST_APP_SUPPORT_DIR:-$expected_app_support}"
        expected_qualification="${portico_RESET_TEST_QUALIFICATION_DIR:-$expected_qualification}"
        expected_app="${portico_RESET_TEST_APP_PATH:-$expected_app}"
    fi

    [ "$MANAGED_DIR" = "$expected_managed" ] || die "Managed-runtime target changed unexpectedly"
    [ "$APP_SUPPORT_DIR" = "$expected_app_support" ] || die "Application-data target changed unexpectedly"
    [ "$QUALIFICATION_DIR" = "$expected_qualification" ] || die "Qualification-data target changed unexpectedly"
    [ "$APP_PATH" = "$expected_app" ] || die "Application target changed unexpectedly"

    case "$MANAGED_DIR" in "$HOME"/*) ;; *) die "Managed-runtime target is outside HOME" ;; esac
    case "$APP_SUPPORT_DIR" in "$HOME"/*) ;; *) die "Application-data target is outside HOME" ;; esac
    case "$QUALIFICATION_DIR" in "$HOME"/*) ;; *) die "Qualification-data target is outside HOME" ;; esac
    case "$APP_PATH" in /|"") die "Unsafe application target" ;; esac
}

remove_target() {
    local target="$1"
    local label="$2"

    if [ -e "$target" ] || [ -L "$target" ]; then
        rm -rf -- "$target"
        log "Removed $label: $target"
    else
        log "Skipped missing $label: $target"
    fi
}

restore_staged_directory() {
    local staged="$1"
    local destination="$2"
    local label="$3"

    [ -n "$staged" ] || return 0
    [ -d "$staged" ] && [ ! -L "$staged" ] \
        || die "Staged $label baseline disappeared before restore"
    mkdir -p -- "$(dirname "$destination")"
    mv -- "$staged" "$destination"
    log "Restored $label baseline: $destination"
}

reset_installation_state() {
    validate_destructive_targets
    purge_secure_state_if_requested

    remove_target "$MANAGED_DIR" "managed runtime"
    remove_target "$QUALIFICATION_DIR" "local qualification data"
    remove_target "$APP_SUPPORT_DIR" "application data"

    if [ "$RESTORE_BASELINES" = true ]; then
        restore_staged_directory "$STAGED_APP_SUPPORT" "$APP_SUPPORT_DIR" "application data"
        restore_staged_directory "$STAGED_MANAGED" "$MANAGED_DIR" "managed runtime"
        restore_staged_directory "$STAGED_QUALIFICATION" "$QUALIFICATION_DIR" "local qualification data"
    fi

    remove_target "$APP_PATH" "installed application"
}

mount_and_open_dmg() {
    local attach_plist=""
    local mount_point=""

    attach_plist="$(mktemp "${TMPDIR:-/tmp}/portico-reset-hdiutil.XXXXXX")"
    log "Mounting arm64 DMG read-only..."
    if ! hdiutil attach -readonly -nobrowse -plist "$DMG_PATH" >"$attach_plist"; then
        rm -f -- "$attach_plist"
        die "The validated arm64 DMG could not be mounted"
    fi

    mount_point="$(python3 - "$attach_plist" <<'PY'
import plistlib
import sys

with open(sys.argv[1], "rb") as handle:
    payload = plistlib.load(handle)

for entity in payload.get("system-entities", []):
    mount_point = entity.get("mount-point")
    if isinstance(mount_point, str) and mount_point:
        print(mount_point)
        break
PY
)"
    rm -f -- "$attach_plist"
    [ -n "$mount_point" ] || die "Mounted DMG did not report a Finder volume path"

    open "$mount_point"
    log ""
    log "Reset complete."
    log "Release ZIP:        $DOWNLOAD_FILE"
    log "Verified cache:     $RELEASE_CACHE_FILE"
    log "Extracted payload:   $EXTRACT_DIR"
    log "Mounted volume:      $mount_point"
    log "Drag Portico.app from the opened DMG window into Applications."
}

main() {
    if [ "$#" -gt 0 ]; then
        case "$1" in
            -h|--help)
                [ "$#" -eq 1 ] || die "--help cannot be combined with other arguments"
                usage
                return 0
                ;;
            --capture-baseline)
                [ "$#" -eq 1 ] || die "--capture-baseline cannot be combined with other arguments"
                RUN_MODE="capture"
                ;;
            *)
                usage >&2
                die "Unknown argument: $1"
                ;;
        esac
    fi

    validate_common_runtime
    if [ -z "$RUN_MODE" ]; then
        choose_action
    fi
    if [ "$RUN_MODE" = "capture" ]; then
        validate_capture_runtime
        run_capture_mode
        return 0
    fi

    validate_reset_runtime
    log "Portico installation reset"
    log "---------------------------------"
    choose_restore_policy
    choose_channel
    resolve_cloudsmith_configuration
    discover_latest_release
    confirm_reset

    # All external inputs are staged and validated before shutdown or deletion.
    download_and_validate_release
    stage_baselines
    stop_runtime
    reset_installation_state
    mount_and_open_dmg
}

main "$@"
