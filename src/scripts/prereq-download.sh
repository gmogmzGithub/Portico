#!/bin/bash

# prereq-download.sh - Prerequisites Phase 1: Download and Setup
# Downloads the Cloudsmith payload, restores the managed runtime tree, and
# preserves user-managed files inside ~/portico/portico-managed.

set -euo pipefail

LOG_FD=1

if [[ "${BASH_SOURCE[0]}" == */* ]]; then
    PREREQ_SCRIPT_DIR="$(cd "${BASH_SOURCE[0]%/*}" && pwd)"
else
    PREREQ_SCRIPT_DIR="$(pwd)"
fi
PREREQ_SCRIPT_PATH="$PREREQ_SCRIPT_DIR/${BASH_SOURCE[0]##*/}"

MANAGED_DIR="$HOME/portico/portico-managed"
REPO_ROOT="$(cd "$PREREQ_SCRIPT_DIR/../.." && pwd)"
MANAGED_RUNTIME_RECONCILE_SH="$PREREQ_SCRIPT_DIR/managed-runtime-reconcile.sh"
MANAGED_RUNTIME_INTEGRITY_SH="$PREREQ_SCRIPT_DIR/managed-runtime-integrity.sh"
RELEASE_CHANNEL_SH="$PREREQ_SCRIPT_DIR/release-channel.sh"

if [ ! -f "$MANAGED_RUNTIME_RECONCILE_SH" ]; then
    printf '[ERROR] Missing managed runtime reconcile helper: %s\n' "$MANAGED_RUNTIME_RECONCILE_SH" >&2
    exit 1
fi
if [ ! -f "$MANAGED_RUNTIME_INTEGRITY_SH" ]; then
    printf '[ERROR] Missing managed runtime integrity helper: %s\n' "$MANAGED_RUNTIME_INTEGRITY_SH" >&2
    exit 1
fi
if [ ! -f "$RELEASE_CHANNEL_SH" ]; then
    printf '[ERROR] Missing release channel helper: %s\n' "$RELEASE_CHANNEL_SH" >&2
    exit 1
fi
# shellcheck source=/dev/null
. "$MANAGED_RUNTIME_RECONCILE_SH"
# shellcheck source=/dev/null
. "$MANAGED_RUNTIME_INTEGRITY_SH"
# shellcheck source=/dev/null
. "$RELEASE_CHANNEL_SH"

_CLOUDSMITH_ENV=""
for _candidate in "$PREREQ_SCRIPT_DIR/../cloudsmith.env" "$REPO_ROOT/cloudsmith.env"; do
    if [ -f "$_candidate" ]; then
        _CLOUDSMITH_ENV="$_candidate"
        break
    fi
done
if [ -n "$_CLOUDSMITH_ENV" ]; then
    # shellcheck source=/dev/null
    . "$_CLOUDSMITH_ENV"
fi
RUNTIME_SECRETS_SH="$PREREQ_SCRIPT_DIR/runtime-secrets.sh"
if [ -f "$RUNTIME_SECRETS_SH" ]; then
    # shellcheck source=/dev/null
    . "$RUNTIME_SECRETS_SH"
fi

CLOUDSMITH_OWNER="${CLOUDSMITH_OWNER:-portico}"
CLOUDSMITH_REPO="${CLOUDSMITH_REPO:-portico}"
CLOUDSMITH_API_BASE="${CLOUDSMITH_API_BASE:-https://api.cloudsmith.io/v1}"
CLOUDSMITH_DL_BASE="${CLOUDSMITH_DL_BASE:-https://dl.artifacts.example.invalid}"
CLOUDSMITH_API_KEY="${CLOUDSMITH_API_KEY:-}"
CLOUDSMITH_READ_TOKEN="${CLOUDSMITH_READ_TOKEN:-$CLOUDSMITH_API_KEY}"
CLOUDSMITH_ENTITLEMENT_TOKEN="${CLOUDSMITH_ENTITLEMENT_TOKEN:-}"
if command -v resolve_cloudsmith_entitlement_token >/dev/null 2>&1; then
    export PROJECT_ROOT="$REPO_ROOT"
    _resolved_cloudsmith_token="$(resolve_cloudsmith_entitlement_token || true)"
    if [ -n "$_resolved_cloudsmith_token" ]; then
        CLOUDSMITH_ENTITLEMENT_TOKEN="$_resolved_cloudsmith_token"
    fi
fi

PRESERVE_FILES=("${MANAGED_RUNTIME_DEFAULT_PRESERVE_PATHS[@]}")

BUILD_NUMBER=""
KEYWORD="portico"
BUILD_DATE=""
BUILD_SHA=""
SHORT_SHA=""
BUILD_LAST_MODIFIED=""
TEMP_DIR=""
FULL_BACKUP_TEMP=""
FULL_BACKUP_ZIP_NAME=""
FULL_BACKUP_ZIP_PATH=""
FULL_BACKUP_RETENTION_COUNT="${FULL_BACKUP_RETENTION_COUNT:-2}"
DB_SNAPSHOT_RETENTION_COUNT="${DB_SNAPSHOT_RETENTION_COUNT:-5}"
DB_SNAPSHOT_PATH=""
CS_TOKEN=""
CS_TOKEN_SOURCE="unset"
CURL_BIN=""
CURL_VERSION_LINE=""
PACKAGE_METADATA_PARSER="unknown"
CLOUDSMITH_DOWNLOAD_URL_SOURCE="unknown"
PREPARED_CURL_MODE="normal"
PREPARED_CURL_LABEL=""
PREPARED_CURL_URL=""
PREPARED_CURL_STDERR_FILE=""
PREPARED_CURL_ARGV_LOG=""
PREPARED_CURL_CMD=()
PREREQ_PAYLOAD_CACHE_DIR="${PREREQ_PAYLOAD_CACHE_DIR:-$HOME/Library/Caches/portico/prereq-payloads}"
# PORTICO-342: in-progress downloads live OUTSIDE the payload cache, deliberately.
# payload_cache_prune_old_entries() iterates "$PREREQ_PAYLOAD_CACHE_DIR"/* and treats
# every directory it finds as a completed cache entry, so a partials subdirectory in
# there would be a prune candidate -- it could delete the download currently in
# flight. A sibling directory keeps the two lifecycles apart.
PREREQ_PAYLOAD_PARTIAL_DIR="${PREREQ_PAYLOAD_PARTIAL_DIR:-$HOME/Library/Caches/portico/prereq-partials}"
# Abandon a transfer delivering less than this for this long. The floor sits far
# under the worst healthy throughput measured on the reported install (193 KB/s), so
# a genuinely slow link is never killed -- only a dead one.
PAYLOAD_STALL_BYTES_PER_SEC="${PAYLOAD_STALL_BYTES_PER_SEC:-1024}"
PAYLOAD_STALL_SECONDS="${PAYLOAD_STALL_SECONDS:-120}"
PREREQ_PAYLOAD_CACHE_KEEP_COUNT="${PREREQ_PAYLOAD_CACHE_KEEP_COUNT:-2}"
PAYLOAD_CACHE_USED="false"
PAYLOAD_CACHE_ENTRY_DIR=""

emit_phase_start() {
    echo "[PREREQ:PHASE:1:START]"
}

emit_phase_complete() {
    echo "[PREREQ:PHASE:1:COMPLETE]"
}

emit_step_start() {
    echo "[PREREQ:STEP:$1:START]"
}

emit_step_complete() {
    echo "[PREREQ:STEP:$1:COMPLETE]"
}

emit_error() {
    echo "[PREREQ:ERROR:$1]"
}

emit_progress() {
    echo "[PREREQ:PROGRESS:$1:$2]"
}

write_fd_line() {
    local fd="${1:-1}"
    local line="$2"

    case "$fd" in
        1)
            printf '%s\n' "$line"
            ;;
        2)
            printf '%s\n' "$line" >&2
            ;;
        *)
            eval "printf '%s\n' \"\$line\" >&$fd"
            ;;
    esac
}

log() {
    printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1"
}

log_to_fd() {
    local level="$1"
    local message="$2"
    local fd="${3:-1}"
    write_fd_line "$fd" "[$level] $(date '+%Y-%m-%d %H:%M:%S') $message"
}

log_error() {
    log_to_fd "ERROR" "$1" 2
    emit_error "$1"
    exit "${2:-1}"
}

log_success() {
    log_to_fd "SUCCESS" "$1" 1
}

log_info() {
    log_to_fd "INFO" "$1" 1
}

log_warning() {
    log_to_fd "WARNING" "$1" 1
}

log_diag_info() {
    log_to_fd "INFO" "$1" "$LOG_FD"
}

log_diag_warning() {
    log_to_fd "WARNING" "$1" "$LOG_FD"
}

cleanup() {
    if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
        rm -rf "$TEMP_DIR"
    fi
    if [ -n "$FULL_BACKUP_TEMP" ] && [ -d "$FULL_BACKUP_TEMP" ]; then
        rm -rf "$FULL_BACKUP_TEMP"
    fi
}

normalize_url_for_curl() {
    printf '%s' "${1:-}" | sed 's/\r//g; s#\\/#/#g; s/^[[:space:]]*//; s/[[:space:]]*$//'
}

redact_url_for_log() {
    local value="${1:-}"
    if [[ "$value" =~ ^(https?://[^/]+) ]]; then
        printf '%s/[redacted]\n' "${BASH_REMATCH[1]}"
        return 0
    fi
    [ -n "$value" ] && printf '[redacted URL]\n' || printf '<empty>\n'
}

redact_sensitive_text_for_log() {
    local value="${1:-}"
    local secret=""
    for secret in \
        "${CLOUDSMITH_ENTITLEMENT_TOKEN:-}" \
        "${CS_TOKEN:-}" \
        "${CLOUDSMITH_API_KEY:-}" \
        "${CLOUDSMITH_READ_TOKEN:-}" \
        "${DOWNLOAD_URL:-}"
    do
        [ -n "$secret" ] || continue
        value="${value//$secret/[REDACTED]}"
    done
    printf '%s\n' "$value"
}

trim_surrounding_whitespace() {
    printf '%s' "${1:-}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
}

log_url_normalization_details() {
    local label="$1"
    local original="${2:-}"
    local normalized="${3:-}"
    local escaped_slashes="false"
    local stripped_cr="false"
    local trimmed_whitespace="false"
    local changed="false"

    case "$original" in
        *'\/'*)
            escaped_slashes="true"
            ;;
    esac

    if [ "${original//$'\r'/}" != "$original" ]; then
        stripped_cr="true"
    fi

    if [ "$(trim_surrounding_whitespace "$original")" != "$original" ]; then
        trimmed_whitespace="true"
    fi

    if [ "$original" != "$normalized" ]; then
        changed="true"
    fi

    log_diag_info "$label normalization: changed=$changed escaped_slashes=$escaped_slashes stripped_cr=$stripped_cr trimmed_whitespace=$trimmed_whitespace"
}

format_env_value_for_log() {
    local variable_name="$1"
    if [ "${!variable_name+x}" != "x" ]; then
        printf '<unset>\n'
        return 0
    fi

    if [ -z "${!variable_name}" ]; then
        printf '<empty>\n'
        return 0
    fi

    printf '%s\n' "${!variable_name}"
}

log_curl_runtime_environment() {
    local variable_name=""
    for variable_name in HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY CURL_HOME CURL_CA_BUNDLE SSL_CERT_FILE SSL_CERT_DIR; do
        log_diag_info "curl env $variable_name=$(format_env_value_for_log "$variable_name")"
    done
}

resolve_curl_bin() {
    if [ -n "$CURL_BIN" ] && [ -x "$CURL_BIN" ]; then
        printf '%s\n' "$CURL_BIN"
        return 0
    fi

    if [ -x /usr/bin/curl ]; then
        CURL_BIN="/usr/bin/curl"
        printf '%s\n' "$CURL_BIN"
        return 0
    fi

    if command -v curl >/dev/null 2>&1; then
        CURL_BIN="$(command -v curl)"
        printf '%s\n' "$CURL_BIN"
        return 0
    fi

    return 1
}

format_header_for_log() {
    local header="$1"

    case "$header" in
        [Xx]-[Aa][Pp][Ii]-[Kk]ey:*)
            printf 'X-Api-Key: [REDACTED]\n'
            ;;
        [Aa]uthorization:*)
            printf '%s\n' "${header%%:*}: [REDACTED]"
            ;;
        *)
            printf '%s\n' "$header"
            ;;
    esac
}

format_curl_command_for_log() {
    local rendered=()
    local arg=""
    local header=""

    while [ "$#" -gt 0 ]; do
        arg="$1"
        shift

        if [ "$arg" = "-H" ] || [ "$arg" = "--header" ]; then
            rendered+=("$(printf '%q' "$arg")")
            if [ "$#" -gt 0 ]; then
                header="$(format_header_for_log "$1")"
                shift
                rendered+=("$(printf '%q' "$header")")
            fi
            continue
        fi

        case "$arg" in
            http://*|https://*)
                arg="$(redact_url_for_log "$arg")"
                ;;
        esac
        rendered+=("$(printf '%q' "$arg")")
    done

    printf '%s\n' "${rendered[*]}"
}

prepare_curl_checked() {
    local mode="normal"
    local stderr_file=""
    local label=""
    local url=""
    local normalized_url=""
    local curl_bin=""

    if [ "${1:-}" = "--clean-env" ]; then
        mode="clean-env"
        shift
    fi

    if [ "${1:-}" = "--stderr-file" ]; then
        stderr_file="${2:-}"
        shift 2
    fi

    label="${1:-curl}"
    url="${2:-}"
    shift 2

    normalized_url="$(normalize_url_for_curl "$url")"
    log_url_normalization_details "$label URL" "$url" "$normalized_url"

    curl_bin="$(resolve_curl_bin)" || return 127

    PREPARED_CURL_MODE="$mode"
    PREPARED_CURL_LABEL="$label"
    PREPARED_CURL_URL="$normalized_url"
    PREPARED_CURL_STDERR_FILE="$stderr_file"
    PREPARED_CURL_CMD=("$curl_bin" -q "$@" "$normalized_url")
    PREPARED_CURL_ARGV_LOG="$(format_curl_command_for_log "${PREPARED_CURL_CMD[@]}")"

    log_diag_info "$label curl invocation (mode=$mode): $PREPARED_CURL_ARGV_LOG"
    return 0
}

run_prepared_curl() {
    if [ -n "$PREPARED_CURL_STDERR_FILE" ]; then
        : > "$PREPARED_CURL_STDERR_FILE"
    fi

    if [ "$PREPARED_CURL_MODE" = "clean-env" ]; then
        if [ -n "$PREPARED_CURL_STDERR_FILE" ]; then
            env -i HOME="${HOME:-}" PATH="${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}" TERM="${TERM:-xterm-256color}" \
                "${PREPARED_CURL_CMD[@]}" 2>"$PREPARED_CURL_STDERR_FILE"
        else
            env -i HOME="${HOME:-}" PATH="${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}" TERM="${TERM:-xterm-256color}" \
                "${PREPARED_CURL_CMD[@]}"
        fi
    else
        if [ -n "$PREPARED_CURL_STDERR_FILE" ]; then
            "${PREPARED_CURL_CMD[@]}" 2>"$PREPARED_CURL_STDERR_FILE"
        else
            "${PREPARED_CURL_CMD[@]}"
        fi
    fi
}

run_curl_checked() {
    prepare_curl_checked "$@"
    run_prepared_curl
}

summarize_stderr_file() {
    local file_path="$1"
    local summary=""
    if [ ! -f "$file_path" ]; then
        return 0
    fi

    summary="$(tr '\n' ' ' < "$file_path" | sed 's/  */ /g; s/^ //; s/ $//')"
    redact_sensitive_text_for_log "$summary"
}

file_size_bytes() {
    local file_path="$1"
    local size=""

    if [ ! -f "$file_path" ]; then
        printf '0\n'
        return 0
    fi

    size="$(stat -f%z "$file_path" 2>/dev/null || true)"
    if [[ "$size" =~ ^[0-9]+$ ]]; then
        printf '%s\n' "$size"
        return 0
    fi

    size="$(stat -c%s "$file_path" 2>/dev/null || true)"
    if [[ "$size" =~ ^[0-9]+$ ]]; then
        printf '%s\n' "$size"
        return 0
    fi

    wc -c < "$file_path" | tr -d '[:space:]'
}

normalize_cache_total_bytes() {
    local total_bytes="${1:-}"
    if [[ "$total_bytes" =~ ^[0-9]+$ ]] && [ "$total_bytes" -gt 0 ]; then
        printf '%s\n' "$total_bytes"
    else
        printf 'unknown\n'
    fi
}

hash_cache_value() {
    local value="${1:-}"

    if command -v shasum >/dev/null 2>&1; then
        printf '%s' "$value" | shasum -a 256 | awk '{print $1}'
        return 0
    fi

    if command -v openssl >/dev/null 2>&1; then
        printf '%s' "$value" | openssl dgst -sha256 -r | awk '{print $1}'
        return 0
    fi

    printf '%s' "$value" | cksum | awk '{print $1 "-" $2}'
}

payload_cache_url_hash() {
    hash_cache_value "$(normalize_url_for_curl "${1:-}")"
}

payload_cache_identity_hash() {
    local channel="$1"
    local build_number="$2"
    local package_version="$3"
    local filename="$4"
    local total_bytes="$5"
    local last_modified="$6"
    local url_hash="$7"
    local total_normalized=""

    total_normalized="$(normalize_cache_total_bytes "$total_bytes")"
    hash_cache_value "$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$channel" \
        "$build_number" \
        "$package_version" \
        "$filename" \
        "$total_normalized" \
        "$last_modified" \
        "$url_hash")"
}

payload_cache_current_package_version() {
    printf '%s\n' "${pkg_version:-$BUILD_NUMBER}"
}

payload_cache_current_url_hash() {
    payload_cache_url_hash "$DOWNLOAD_URL"
}

payload_cache_current_identity_hash() {
    local total_bytes="${1:-}"
    local package_version=""
    local url_hash=""

    package_version="$(payload_cache_current_package_version)"
    url_hash="$(payload_cache_current_url_hash)"
    payload_cache_identity_hash \
        "$KEYWORD" \
        "$BUILD_NUMBER" \
        "$package_version" \
        "$EXPECTED_FILENAME" \
        "$total_bytes" \
        "${BUILD_LAST_MODIFIED:-}" \
        "$url_hash"
}

payload_cache_entry_dir_for_target() {
    local total_bytes="${1:-}"
    local identity_hash=""

    identity_hash="$(payload_cache_current_identity_hash "$total_bytes")"
    printf '%s/%s\n' "$PREREQ_PAYLOAD_CACHE_DIR" "$identity_hash"
}

payload_cache_metadata_value() {
    local metadata_file="$1"
    local key="$2"

    awk -F '\t' -v key="$key" '
        $1 == key {
            value = $0
            sub("^[^\t]*\t", "", value)
            print value
            exit
        }
    ' "$metadata_file"
}

payload_cache_metadata_has_key() {
    local metadata_file="$1"
    local key="$2"

    awk -F '\t' -v key="$key" '
        $1 == key { found = 1; exit }
        END { exit found ? 0 : 1 }
    ' "$metadata_file"
}

payload_cache_metadata_matches() {
    local metadata_file="$1"
    local total_bytes="${2:-}"
    local package_version=""
    local url_hash=""
    local identity_hash=""
    local total_normalized=""
    local key=""

    [ -f "$metadata_file" ] || return 1

    for key in cache_version channel build_number package_version filename content_length last_modified url_hash identity_hash; do
        payload_cache_metadata_has_key "$metadata_file" "$key" || return 1
    done

    package_version="$(payload_cache_current_package_version)"
    url_hash="$(payload_cache_current_url_hash)"
    identity_hash="$(payload_cache_current_identity_hash "$total_bytes")"
    total_normalized="$(normalize_cache_total_bytes "$total_bytes")"

    [ "$(payload_cache_metadata_value "$metadata_file" "cache_version")" = "1" ] || return 1
    [ "$(payload_cache_metadata_value "$metadata_file" "channel")" = "$KEYWORD" ] || return 1
    [ "$(payload_cache_metadata_value "$metadata_file" "build_number")" = "$BUILD_NUMBER" ] || return 1
    [ "$(payload_cache_metadata_value "$metadata_file" "package_version")" = "$package_version" ] || return 1
    [ "$(payload_cache_metadata_value "$metadata_file" "filename")" = "$EXPECTED_FILENAME" ] || return 1
    [ "$(payload_cache_metadata_value "$metadata_file" "content_length")" = "$total_normalized" ] || return 1
    [ "$(payload_cache_metadata_value "$metadata_file" "last_modified")" = "${BUILD_LAST_MODIFIED:-}" ] || return 1
    [ "$(payload_cache_metadata_value "$metadata_file" "url_hash")" = "$url_hash" ] || return 1
    [ "$(payload_cache_metadata_value "$metadata_file" "identity_hash")" = "$identity_hash" ] || return 1
}

payload_cache_emit_complete_progress() {
    local payload_file="$1"
    local total_bytes="${2:-0}"
    local current_bytes=""

    current_bytes="$(file_size_bytes "$payload_file")"
    if [[ "$total_bytes" =~ ^[0-9]+$ ]] && [ "$total_bytes" -gt 0 ]; then
        emit_progress "download_total_bytes" "$total_bytes"
    fi
    emit_progress "download_bytes" "$current_bytes"
    emit_progress "download_percent" "100"
    emit_progress "download_complete" "true"
}

payload_cache_try_reuse() {
    local total_bytes="${1:-0}"
    local entry_dir=""
    local payload_file=""
    local metadata_file=""
    local current_bytes=""

    PAYLOAD_CACHE_USED="false"
    PAYLOAD_CACHE_ENTRY_DIR=""

    entry_dir="$(payload_cache_entry_dir_for_target "$total_bytes")"
    payload_file="$entry_dir/payload.zip"
    metadata_file="$entry_dir/metadata.tsv"

    [ -s "$payload_file" ] || return 1
    payload_cache_metadata_matches "$metadata_file" "$total_bytes" || return 1

    current_bytes="$(file_size_bytes "$payload_file")"
    if [[ "$total_bytes" =~ ^[0-9]+$ ]] && [ "$total_bytes" -gt 0 ] && [ "$current_bytes" != "$total_bytes" ]; then
        log_warning "Cached update payload size mismatch; downloading again"
        return 1
    fi

    PAYLOAD_CACHE_USED="true"
    PAYLOAD_CACHE_ENTRY_DIR="$entry_dir"
    DOWNLOAD_FILE="$payload_file"
    emit_progress "phase1_activity" "Using cached update payload..."
    payload_cache_emit_complete_progress "$payload_file" "$total_bytes"
    log_success "Using cached update payload: $EXPECTED_FILENAME"
    return 0
}

payload_cache_write_metadata() {
    local metadata_file="$1"
    local total_bytes="${2:-}"
    local package_version=""
    local url_hash=""
    local identity_hash=""
    local total_normalized=""

    package_version="$(payload_cache_current_package_version)"
    url_hash="$(payload_cache_current_url_hash)"
    identity_hash="$(payload_cache_current_identity_hash "$total_bytes")"
    total_normalized="$(normalize_cache_total_bytes "$total_bytes")"

    {
        printf 'cache_version\t1\n'
        printf 'channel\t%s\n' "$KEYWORD"
        printf 'build_number\t%s\n' "$BUILD_NUMBER"
        printf 'package_version\t%s\n' "$package_version"
        printf 'filename\t%s\n' "$EXPECTED_FILENAME"
        printf 'content_length\t%s\n' "$total_normalized"
        printf 'last_modified\t%s\n' "${BUILD_LAST_MODIFIED:-}"
        printf 'url_hash\t%s\n' "$url_hash"
        printf 'identity_hash\t%s\n' "$identity_hash"
    } > "$metadata_file"
}

payload_cache_entry_mtime_line() {
    local entry_dir="$1"
    local mtime=""

    mtime="$(stat -f%m "$entry_dir" 2>/dev/null || true)"
    if ! [[ "$mtime" =~ ^[0-9]+$ ]]; then
        mtime="$(stat -c%Y "$entry_dir" 2>/dev/null || true)"
    fi
    if ! [[ "$mtime" =~ ^[0-9]+$ ]]; then
        mtime="0"
    fi

    printf '%s\t%s\n' "$mtime" "$entry_dir"
}

payload_cache_prune_old_entries() {
    local keep_count="${PREREQ_PAYLOAD_CACHE_KEEP_COUNT:-2}"
    local list_file=""
    local entry_dir=""
    local index=0
    local pruned_count=0
    local tab=""

    [ -d "$PREREQ_PAYLOAD_CACHE_DIR" ] || return 0
    if ! [[ "$keep_count" =~ ^[0-9]+$ ]] || [ "$keep_count" -lt 1 ]; then
        keep_count=2
    fi

    list_file="${TEMP_DIR:-${TMPDIR:-/tmp}}/prereq-payload-cache-entries.$$"
    : > "$list_file" || return 0

    for entry_dir in "$PREREQ_PAYLOAD_CACHE_DIR"/*; do
        [ -d "$entry_dir" ] || continue
        payload_cache_entry_mtime_line "$entry_dir" >> "$list_file"
    done

    tab="$(printf '\t')"
    while IFS="$tab" read -r _mtime entry_dir; do
        [ -n "$entry_dir" ] || continue
        index=$((index + 1))
        if [ "$index" -gt "$keep_count" ]; then
            rm -rf "$entry_dir"
            pruned_count=$((pruned_count + 1))
        fi
    done < <(sort -rn "$list_file")

    rm -f "$list_file"
    if [ "$pruned_count" -gt 0 ]; then
        log_info "Payload cache retention: pruned $pruned_count old payload cache entr$( [ "$pruned_count" -eq 1 ] && printf 'y' || printf 'ies' )"
    fi
}

# PORTICO-342: the payload used to download into a disposable mktemp -d directory, so
# every interruption -- and there were five -- threw away everything transferred.
# 2,294 MB moved for one 777 MB payload. These keep the bytes somewhere durable and
# keyed to the exact payload identity.

payload_partial_dir_for_target() {
    printf '%s/%s\n' "$PREREQ_PAYLOAD_PARTIAL_DIR" "$(payload_cache_current_identity_hash)"
}

payload_partial_validator_file() {
    printf '%s/validator\n' "$(payload_partial_dir_for_target)"
}

# Record what the partial bytes belong to. Resume is only safe against the identical
# payload, and "identical" has to mean more than the same filename.
payload_partial_write_validator() {
    local total_bytes="${1:-0}"
    local dir=""
    dir="$(payload_partial_dir_for_target)"
    mkdir -p "$dir" 2>/dev/null || return 1
    {
        printf 'last_modified\t%s\n' "${BUILD_LAST_MODIFIED:-}"
        printf 'content_length\t%s\n' "$total_bytes"
        printf 'filename\t%s\n' "${EXPECTED_FILENAME:-}"
    } > "$(payload_partial_validator_file)" 2>/dev/null || return 1
    return 0
}

payload_partial_validator_value() {
    local key="$1"
    local file=""
    file="$(payload_partial_validator_file)"
    [ -f "$file" ] || return 1
    awk -F'\t' -v k="$key" '$1 == k { print $2; found = 1 } END { exit found ? 0 : 1 }' "$file"
}

# Is there a partial we may legitimately continue from?
#
# Note these checks are deliberately redundant: payload_cache_identity_hash already
# folds channel, build, filename, content length, Last-Modified and the URL hash into
# the directory name, so a changed payload lands in a DIFFERENT partial directory and
# these bytes are never even consulted. Keeping the explicit checks means the safety
# property survives someone later narrowing what the identity hash covers.
#
# Every condition here is a way a resume could silently corrupt the payload:
#   - a Last-Modified validator, or If-Range has nothing to compare and the server
#     would hand back 206 for a payload that may have changed underneath us
#   - the same validator, filename and content length as the bytes on disk
#   - a non-empty partial that is strictly SHORTER than the expected total; a partial
#     at or beyond full length is not a resume candidate, it is a corrupt or already
#     complete file and gets discarded
payload_partial_is_resumable() {
    local download_file="$1"
    local expected_total="${2:-0}"
    local current_bytes=""
    local recorded_total=""

    [ -n "${BUILD_LAST_MODIFIED:-}" ] || return 1
    [ -f "$download_file" ] || return 1
    [[ "$expected_total" =~ ^[0-9]+$ ]] || return 1
    [ "$expected_total" -gt 0 ] || return 1

    current_bytes="$(file_size_bytes "$download_file")"
    [[ "$current_bytes" =~ ^[0-9]+$ ]] || return 1
    [ "$current_bytes" -gt 0 ] || return 1

    [ "$(payload_partial_validator_value last_modified 2>/dev/null)" = "$BUILD_LAST_MODIFIED" ] || return 1
    [ "$(payload_partial_validator_value filename 2>/dev/null)" = "${EXPECTED_FILENAME:-}" ] || return 1

    # Compare the length recorded when these bytes were written against the length
    # the server is advertising NOW. Comparing the stored value only against the
    # partial's own size would accept a payload whose length changed underneath us.
    recorded_total="$(payload_partial_validator_value content_length 2>/dev/null)" || return 1
    [ "$recorded_total" = "$expected_total" ] || return 1
    [ "$current_bytes" -lt "$expected_total" ] || return 1

    return 0
}

# Drop partial bytes that cannot be resumed, so the next curl starts from a clean
# file rather than appending onto something unrelated.
payload_partial_discard() {
    local download_file="$1"
    local reason="${2:-}"
    if [ -f "$download_file" ]; then
        log_info "Discarding unusable partial payload${reason:+ ($reason)}"
        rm -f "$download_file"
    fi
    rm -f "$(payload_partial_validator_file)" 2>/dev/null || true
}

# Drop partials belonging to any OTHER payload identity.
#
# The partial directory name is the identity hash, so every build the user ever
# started and abandoned keeps its own directory -- ~777 MB each -- and nothing prunes
# them. payload_cache_prune_old_entries deliberately does not look here. A partial for
# a build we are not installing has no value, so the current identity is the only one
# worth keeping.
payload_partial_prune_other_identities() {
    local keep_dir="$1"
    local candidate=""

    [ -d "$PREREQ_PAYLOAD_PARTIAL_DIR" ] || return 0
    for candidate in "$PREREQ_PAYLOAD_PARTIAL_DIR"/*; do
        [ -d "$candidate" ] || continue
        [ "$candidate" != "$keep_dir" ] || continue
        rm -rf "$candidate" 2>/dev/null || true
    done
    return 0
}

# Once the payload is in the cache the partial is redundant; leaving it behind would
# strand ~777 MB per build in the user's Caches directory.
payload_partial_cleanup() {
    local dir=""
    dir="$(payload_partial_dir_for_target)"
    [ -n "$dir" ] || return 0
    case "$dir" in
        "$PREREQ_PAYLOAD_PARTIAL_DIR"/?*) rm -rf "$dir" 2>/dev/null || true ;;
    esac
}

payload_cache_promote_download() {
    local download_file="$1"
    local total_bytes="${2:-0}"
    local entry_dir=""
    local payload_file=""
    local metadata_file=""
    local tmp_payload=""
    local tmp_metadata=""
    local current_bytes=""

    [ -f "$download_file" ] || return 0

    current_bytes="$(file_size_bytes "$download_file")"
    if [ "$current_bytes" = "0" ]; then
        log_warning "Downloaded update payload is empty; skipping payload cache promotion"
        return 0
    fi

    if [[ "$total_bytes" =~ ^[0-9]+$ ]] && [ "$total_bytes" -gt 0 ] && [ "$current_bytes" != "$total_bytes" ]; then
        log_warning "Downloaded update payload size did not match content length; skipping payload cache promotion"
        return 0
    fi

    entry_dir="$(payload_cache_entry_dir_for_target "$total_bytes")"
    payload_file="$entry_dir/payload.zip"
    metadata_file="$entry_dir/metadata.tsv"
    tmp_payload="$entry_dir/payload.zip.tmp.$$"
    tmp_metadata="$entry_dir/metadata.tsv.tmp.$$"

    if ! mkdir -p "$entry_dir"; then
        log_warning "Unable to create payload cache directory; continuing without caching"
        return 0
    fi

    if ! cp "$download_file" "$tmp_payload"; then
        log_warning "Unable to copy update payload into cache; continuing without caching"
        rm -f "$tmp_payload"
        return 0
    fi

    if ! mv "$tmp_payload" "$payload_file"; then
        log_warning "Unable to finalize cached update payload; continuing without caching"
        rm -f "$tmp_payload"
        return 0
    fi

    if ! payload_cache_write_metadata "$tmp_metadata" "$total_bytes"; then
        log_warning "Unable to write update payload cache metadata; continuing without caching"
        rm -f "$tmp_metadata"
        return 0
    fi

    if ! mv "$tmp_metadata" "$metadata_file"; then
        log_warning "Unable to finalize update payload cache metadata; continuing without caching"
        rm -f "$tmp_metadata"
        return 0
    fi

    log_info "Cached update payload for future retries"
    payload_cache_prune_old_entries
    return 0
}

payload_cache_invalidate_used() {
    local reason="${1:-cached payload was invalid}"

    if [ "$PAYLOAD_CACHE_USED" = "true" ] && [ -n "$PAYLOAD_CACHE_ENTRY_DIR" ] && [ -d "$PAYLOAD_CACHE_ENTRY_DIR" ]; then
        rm -rf "$PAYLOAD_CACHE_ENTRY_DIR"
        log_warning "Removed cached update payload because $reason"
    fi
}

detect_content_length() {
    local stderr_file="$TEMP_DIR/content-length.stderr"
    local headers=""

    # Raw Cloudsmith download URLs carry their entitlement in the URL path.
    # Sending that entitlement as an X-Api-Key is both unnecessary and invalid.
    # Keep this probe's authentication behavior identical to the actual download.
    headers="$(run_curl_checked --stderr-file "$stderr_file" "Cloudsmith content-length probe" "$DOWNLOAD_URL" -fsSIL || true)"

    if [ -s "$stderr_file" ]; then
        log_diag_warning "Cloudsmith content-length probe stderr: $(summarize_stderr_file "$stderr_file")"
    fi

    echo "$headers" \
        | tr -d '\r' \
        | awk 'tolower($1) == "content-length:" { print $2 }' \
        | tail -1
}

cloudsmith_raw_download_url() {
    local channel_keyword="$1"
    local version="$2"
    local filename="$3"
    local token_seg="${CLOUDSMITH_ENTITLEMENT_TOKEN:-basic}"

    printf '%s/%s/%s/raw/names/%s/versions/%s/%s\n' \
        "$CLOUDSMITH_DL_BASE" \
        "$token_seg" \
        "$CLOUDSMITH_REPO" \
        "$channel_keyword" \
        "$version" \
        "$filename"
}

is_cloudsmith_raw_download_url() {
    local candidate="$1"

    case "$candidate" in
        *"/raw/names/"*"/versions/"*"/"*|*"/raw/names/"*"/files/"*)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

is_cloudsmith_safe_raw_version() {
    local candidate=""
    candidate="$(trim_surrounding_whitespace "${1:-}")"
    [ -n "$candidate" ] || return 1

    case "$candidate" in
        *[[:space:]]*|*:*|*/*|*\\*|*\"*)
            return 1
            ;;
        *)
            return 0
            ;;
    esac
}

cloudsmith_shell_extract_first_string_field() {
    local json_fragment="$1"
    local field_name="$2"

    printf '%s' "$json_fragment" \
        | sed 's/,"/\n"/g; s/{"/\n"/g' \
        | sed -n "/^[[:space:]]*\"$field_name\"[[:space:]]*:/ { s/^[[:space:]]*\"$field_name\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p; q; }"
}

build_cloudsmith_download_url() {
    local channel_keyword="$1"
    local version="$2"
    local filename="$3"
    local cdn_url="${4:-}"
    local normalized_cdn_url=""
    local resolved_cdn_url=""
    local fallback_url=""
    local normalized_fallback_url=""

    CLOUDSMITH_DOWNLOAD_URL_SOURCE="raw_fallback"

    if [ -n "$cdn_url" ]; then
        normalized_cdn_url="$(normalize_url_for_curl "$cdn_url")"
        log_diag_info "Cloudsmith package cdn_url: $(redact_url_for_log "$normalized_cdn_url")"
        log_url_normalization_details "Cloudsmith package cdn_url" "$cdn_url" "$normalized_cdn_url"
    fi

    if [ -n "$normalized_cdn_url" ] && is_cloudsmith_raw_download_url "$normalized_cdn_url"; then
        CLOUDSMITH_DOWNLOAD_URL_SOURCE="cdn_url"
        resolved_cdn_url="$normalized_cdn_url"
        if [ -n "$CLOUDSMITH_ENTITLEMENT_TOKEN" ]; then
            resolved_cdn_url="${resolved_cdn_url/\/basic\//\/${CLOUDSMITH_ENTITLEMENT_TOKEN}\/}"
        fi
        resolved_cdn_url="$(normalize_url_for_curl "$resolved_cdn_url")"
        log_diag_info "Cloudsmith final download URL: $(redact_url_for_log "$resolved_cdn_url")"
        printf '%s\n' "$resolved_cdn_url"
        return 0
    fi

    if [ -n "$normalized_cdn_url" ]; then
        log_diag_warning "Ignoring unexpected Cloudsmith cdn_url for $filename; falling back to a raw artifact URL"
    fi

    if ! is_cloudsmith_safe_raw_version "$version"; then
        log_diag_warning "Rejecting Cloudsmith raw fallback URL for $filename because parsed version is not a safe path segment: ${version:-<empty>}"
        return 1
    fi

    fallback_url="$(cloudsmith_raw_download_url "$channel_keyword" "$version" "$filename")"
    normalized_fallback_url="$(normalize_url_for_curl "$fallback_url")"
    log_url_normalization_details "Cloudsmith raw fallback URL" "$fallback_url" "$normalized_fallback_url"
    log_diag_info "Cloudsmith raw fallback URL: $(redact_url_for_log "$normalized_fallback_url")"
    printf '%s\n' "$normalized_fallback_url"
}

find_cloudsmith_package_metadata() {
    local api_response="$1"
    local expected_filename="$2"
    local python3_bin=""
    local python_status=0
    local python_stderr_file=""
    local perl_status=0
    local perl_stderr_file=""

    python3_bin="$(managed_runtime_resolve_python3 || true)"
    if [ -n "$python3_bin" ]; then
        PACKAGE_METADATA_PARSER="python3"
        python_stderr_file="$(mktemp "${TMPDIR:-/tmp}/portico-cloudsmith-python.XXXXXX")"
        if printf '%s' "$api_response" | "$python3_bin" -c '
import json
import sys

expected_filename = sys.argv[1]

try:
    payload = json.load(sys.stdin)
except Exception:
    sys.exit(2)

if isinstance(payload, list):
    packages = payload
elif isinstance(payload, dict):
    packages = payload.get("data") or payload.get("results") or []
else:
    packages = []

for pkg in packages:
    if not isinstance(pkg, dict):
        continue
    filename = pkg.get("filename") or ""
    if filename != expected_filename:
        continue

    version = pkg.get("version") or ""
    cdn_url = pkg.get("cdn_url") or ""
    uploaded_at = pkg.get("uploaded_at") or ""
    created_at = pkg.get("created_at") or ""
    print("\t".join([version, cdn_url, uploaded_at, created_at]))
    sys.exit(0)

sys.exit(1)
' "$expected_filename" 2>"$python_stderr_file"; then
            rm -f "$python_stderr_file"
            return 0
        fi

        python_status=$?
        rm -f "$python_stderr_file"
        if [ "$python_status" -eq 2 ]; then
            return 2
        fi

        log_diag_info "Cloudsmith metadata python parser failed with exit $python_status; using sed fallback"
    fi

    if [ -z "$python3_bin" ] && command -v python3 >/dev/null 2>&1; then
        log_diag_info "No working python3 interpreter detected for Cloudsmith metadata parsing; using non-python fallback"
    fi

    if command -v perl >/dev/null 2>&1; then
        PACKAGE_METADATA_PARSER="perl"
        perl_stderr_file="$(mktemp "${TMPDIR:-/tmp}/portico-cloudsmith-perl.XXXXXX")"
        if printf '%s' "$api_response" | perl -e '
use strict;
use warnings;

eval {
    require JSON::PP;
    JSON::PP->import(qw(decode_json));
    1;
} or exit 3;

my $expected_filename = shift @ARGV;
local $/;
my $raw = <STDIN>;
my $payload = eval { decode_json($raw) };
exit 2 if $@;

my $packages;
if (ref($payload) eq "ARRAY") {
    $packages = $payload;
} elsif (ref($payload) eq "HASH") {
    $packages = $payload->{data} || $payload->{results} || [];
} else {
    $packages = [];
}

for my $pkg (@{$packages}) {
    next unless ref($pkg) eq "HASH";
    my $filename = $pkg->{filename} || "";
    next unless $filename eq $expected_filename;

    my $version = $pkg->{version} || "";
    my $cdn_url = $pkg->{cdn_url} || "";
    my $uploaded_at = $pkg->{uploaded_at} || "";
    my $created_at = $pkg->{created_at} || "";
    print join("\t", $version, $cdn_url, $uploaded_at, $created_at);
    exit 0;
}

exit 1;
' "$expected_filename" 2>"$perl_stderr_file"; then
            rm -f "$perl_stderr_file"
            return 0
        fi

        perl_status=$?
        rm -f "$perl_stderr_file"
        if [ "$perl_status" -eq 2 ]; then
            return 2
        fi

        if [ "$perl_status" -ne 1 ]; then
            log_diag_info "Cloudsmith metadata perl parser failed with exit $perl_status; using sed fallback"
        fi
    fi

    PACKAGE_METADATA_PARSER="sed"
    while IFS= read -r item; do
        local pkg_filename=""
        local pkg_version=""
        local pkg_cdn_url=""
        local pkg_uploaded_at=""
        local pkg_created_at=""

        pkg_filename="$(cloudsmith_shell_extract_first_string_field "$item" "filename")"
        pkg_version="$(cloudsmith_shell_extract_first_string_field "$item" "version")"
        pkg_cdn_url="$(cloudsmith_shell_extract_first_string_field "$item" "cdn_url")"
        pkg_uploaded_at="$(cloudsmith_shell_extract_first_string_field "$item" "uploaded_at")"
        pkg_created_at="$(cloudsmith_shell_extract_first_string_field "$item" "created_at")"

        if [ "$pkg_filename" = "$expected_filename" ]; then
            if [ -n "$pkg_cdn_url" ] || is_cloudsmith_safe_raw_version "$pkg_version"; then
                printf '%s\t%s\t%s\t%s\n' \
                    "$pkg_version" \
                    "$pkg_cdn_url" \
                    "$pkg_uploaded_at" \
                    "$pkg_created_at"
                return 0
            fi

            log_diag_warning "Rejecting malformed Cloudsmith metadata for $expected_filename from sed fallback: version=${pkg_version:-<empty>} cdn_url=$(redact_url_for_log "$pkg_cdn_url")"
            return 2
        fi
    done <<< "$(printf '%s' "$api_response" | tr '}' '\n')"

    return 1
}

json_get_string() {
    local file_path="$1"
    local key_path="$2"
    local python3_bin=""

    if [ ! -f "$file_path" ]; then
        return 0
    fi

    if command -v plutil >/dev/null 2>&1; then
        plutil -extract "$key_path" raw -o - "$file_path" 2>/dev/null || true
        return 0
    fi

    python3_bin="$(managed_runtime_resolve_python3 || true)"
    if [ -n "$python3_bin" ]; then
        "$python3_bin" - "$file_path" "$key_path" <<'PY' 2>/dev/null || true
import json
import sys

file_path, key_path = sys.argv[1:3]
with open(file_path, "r", encoding="utf-8") as fh:
    data = json.load(fh)

value = data
for segment in key_path.split("."):
    if not isinstance(value, dict) or segment not in value:
        value = ""
        break
    value = value[segment]

if isinstance(value, str):
    print(value)
PY
        return 0
    fi

    return 0
}

refresh_managed_build_info() {
    local build_info_path="$1"
    local release_manifest="$2"
    local build_number="$3"
    local build_sha="$4"
    local build_date="$5"
    local channel="$6"
    local timestamp="$7"
    local full_sha_value="$build_sha"
    local docker_image_tag_value=""
    local existing_build_number=""
    local existing_full_sha=""
    local existing_docker_image_tag=""

    if [ -f "$release_manifest" ]; then
        docker_image_tag_value="$(json_get_string "$release_manifest" "dockerImageTag")"
        if [ -z "$docker_image_tag_value" ]; then
            log_error "Release manifest is missing the runtime Docker image tag"
        fi
    fi

    if [ -f "$build_info_path" ]; then
        existing_build_number="$(json_get_string "$build_info_path" "buildNumber")"
        existing_full_sha="$(json_get_string "$build_info_path" "fullSha")"
        existing_docker_image_tag="$(json_get_string "$build_info_path" "dockerImageTag")"
        if [ "$existing_build_number" = "$build_number" ] \
            && [ -n "$existing_full_sha" ] \
            && [[ "$existing_full_sha" == "$build_sha"* ]]; then
            full_sha_value="$existing_full_sha"
            if [ -z "$docker_image_tag_value" ] && [ -n "$existing_docker_image_tag" ]; then
                docker_image_tag_value="$existing_docker_image_tag"
            fi
        fi
    fi

    docker_image_tag_value="${docker_image_tag_value:-$build_number}"
    mkdir -p "$(dirname "$build_info_path")"
    cat > "$build_info_path" <<EOF
{
  "buildNumber": "${build_number}",
  "fullSha": "${full_sha_value}",
  "date": "${build_date}",
  "timestamp": "${timestamp}",
  "channel": "${channel}",
  "dockerImageTag": "${docker_image_tag_value}"
}
EOF
}

prune_db_snapshots() {
    local snapshot_dir="$1"
    local retention_count="${DB_SNAPSHOT_RETENTION_COUNT:-5}"
    local snapshot=""
    local snapshot_count=0

    case "$retention_count" in
        ''|*[!0-9]*) retention_count=5 ;;
    esac
    [ "$retention_count" -gt 0 ] || retention_count=5

    while IFS= read -r snapshot; do
        [ -n "$snapshot" ] || continue
        snapshot_count=$((snapshot_count + 1))
        if [ "$snapshot_count" -gt "$retention_count" ]; then
            rm -f -- "$snapshot" \
                || log_warning "Failed to prune old database snapshot: $snapshot"
        fi
    done < <(
        find "$snapshot_dir" -maxdepth 1 -type f -name 'webui.db.*' -print 2>/dev/null \
            | LC_ALL=C sort -r
    )
}

create_webui_db_snapshot() {
    local source_db="$MANAGED_DIR/open-webui-data/webui.db"
    local snapshot_dir="$MANAGED_DIR/backup/db-snapshots"
    local timestamp="$1"
    local destination="$snapshot_dir/webui.db.${timestamp}"
    local temporary="$snapshot_dir/.webui.db.${timestamp}.tmp.$$"
    local temporary_name=""
    local snapshot_method=""

    DB_SNAPSHOT_PATH=""
    [ -s "$source_db" ] || return 0

    umask 077
    mkdir -p "$snapshot_dir" || return 1
    rm -f "$temporary"
    temporary_name="$(basename "$temporary")"

    if command -v sqlite3 >/dev/null 2>&1 \
        && (
            cd "$snapshot_dir" &&
            sqlite3 "$source_db" ".backup '${temporary_name}'" >/dev/null 2>&1
        ); then
        snapshot_method="sqlite3 .backup"
    else
        rm -f "$temporary"
        if cp -c "$source_db" "$temporary" 2>/dev/null; then
            snapshot_method="clone copy"
        elif cp "$source_db" "$temporary" 2>/dev/null; then
            snapshot_method="plain copy fallback"
        else
            rm -f "$temporary"
            log_warning "Failed to create Open WebUI database snapshot"
            return 1
        fi
    fi

    if [ ! -s "$temporary" ]; then
        rm -f "$temporary"
        log_warning "Open WebUI database snapshot is empty"
        return 1
    fi
    chmod 600 "$temporary" 2>/dev/null || true
    if ! mv "$temporary" "$destination"; then
        rm -f "$temporary"
        log_warning "Failed to finalize Open WebUI database snapshot"
        return 1
    fi

    DB_SNAPSHOT_PATH="$destination"
    log_success "Open WebUI database snapshot created with ${snapshot_method}: $destination"
    prune_db_snapshots "$snapshot_dir"
}

# Bash expands a glob to "no matches" even when the underlying directory read
# fails transiently (opendir EMFILE/ENFILE/ENOMEM under load), which silently
# dropped .env from the update safety backup. find reports directory read
# failures through its exit status, so enumerate with find and retry briefly
# before failing the backup closed.
list_slim_backup_config_matches() {
    local pattern="$1"
    local attempt=1
    local listing=""

    while :; do
        if listing="$(find -H "$MANAGED_DIR" -mindepth 1 -maxdepth 1 -name "$pattern" -print)"; then
            LC_ALL=C sort <<<"$listing"
            return 0
        fi
        if [ "$attempt" -ge 3 ]; then
            return 1
        fi
        attempt=$((attempt + 1))
        sleep 0.2
    done
}

create_slim_backup() {
    local timestamp=""
    local backup_manifest=""
    local candidate=""
    local relative_path=""
    local env_matches=""
    local token_matches=""
    local -a config_entries=()

    if ! command -v zip >/dev/null 2>&1; then
        log_warning "zip command not available; cannot create update safety backup"
        return 1
    fi

    umask 077
    FULL_BACKUP_TEMP="$(mktemp -d)" || return 1
    timestamp="$(date +%s)"
    FULL_BACKUP_ZIP_NAME="portico_full_backup_${timestamp}.zip"
    FULL_BACKUP_ZIP_PATH="$FULL_BACKUP_TEMP/$FULL_BACKUP_ZIP_NAME"
    backup_manifest="$FULL_BACKUP_TEMP/slim-backup-manifest.txt"

    create_webui_db_snapshot "$timestamp" || return 1

    if [ -d "$MANAGED_DIR" ]; then
        if ! env_matches="$(list_slim_backup_config_matches '.env*')" \
            || ! token_matches="$(list_slim_backup_config_matches 'mcpo-*oauth-tokens')"; then
            log_warning "Failed to enumerate slim backup configuration entries under $MANAGED_DIR"
            return 1
        fi
    fi

    while IFS= read -r candidate; do
        [ -n "$candidate" ] || continue
        config_entries+=("${candidate#"$MANAGED_DIR"/}")
    done <<<"$env_matches"
    for relative_path in \
        HOST_MODE \
        UPDATE_CHANNEL \
        mcp-configs-user \
        mcp_toggles.json \
        mcp_tools_config.json \
        marketplaces.json
    do
        candidate="$MANAGED_DIR/$relative_path"
        [ -e "$candidate" ] || [ -L "$candidate" ] || continue
        config_entries+=("$relative_path")
    done
    while IFS= read -r candidate; do
        [ -n "$candidate" ] || continue
        config_entries+=("${candidate#"$MANAGED_DIR"/}")
    done <<<"$token_matches"

    if [ "${#config_entries[@]}" -gt 0 ]; then
        if ! (
            cd "$MANAGED_DIR" &&
            zip -r --symlinks "$FULL_BACKUP_ZIP_PATH" "${config_entries[@]}" >/dev/null
        ); then
            rm -f "$FULL_BACKUP_ZIP_PATH"
            log_warning "Failed to create slim configuration backup archive"
            return 1
        fi
    fi

    {
        echo "format=portico-slim-backup-v1"
        echo "created_at=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
        echo "database_snapshot=${DB_SNAPSHOT_PATH:-none}"
    } > "$backup_manifest"
    if ! zip -j "$FULL_BACKUP_ZIP_PATH" "$backup_manifest" >/dev/null; then
        rm -f "$FULL_BACKUP_ZIP_PATH"
        log_warning "Failed to add metadata to slim configuration backup archive"
        return 1
    fi
    rm -f "$backup_manifest"

    if [ ! -s "$FULL_BACKUP_ZIP_PATH" ]; then
        FULL_BACKUP_ZIP_PATH=""
        log_warning "Prepared slim backup archive is missing or empty"
        return 1
    fi

    log_success "Slim app-state backup created: $FULL_BACKUP_ZIP_NAME"
    return 0
}

prune_full_backup_archives() {
    local backup_dir="$1"
    local keep_count="${2:-$FULL_BACKUP_RETENTION_COUNT}"
    local -a backup_paths=()
    local backup_path=""
    local total_count=0
    local pruned_count=0
    local kept_count=0
    local index=0

    if [ ! -d "$backup_dir" ]; then
        return 0
    fi

    if ! [[ "$keep_count" =~ ^[0-9]+$ ]]; then
        keep_count=2
    fi

    # macOS packaged installs use /bin/bash 3.2, which does not provide mapfile.
    while IFS= read -r backup_path; do
        backup_paths+=("$backup_path")
    done < <(
        find "$backup_dir" -maxdepth 1 -type f -name 'portico_full_backup_*.zip' -print | sort -r
    )

    total_count="${#backup_paths[@]}"
    if [ "$total_count" -eq 0 ]; then
        return 0
    fi

    for (( index=keep_count; index<total_count; index++ )); do
        if rm -f "${backup_paths[$index]}"; then
            pruned_count=$((pruned_count + 1))
        fi
    done

    kept_count=$((total_count - pruned_count))
    log_info "Managed full backup retention: pruned $pruned_count archive(s); kept $kept_count of $total_count"
}

backup_archive_inode_identity() {
    local archive_path="$1"
    local identity=""

    # GNU stat interprets BSD's `-f FORMAT` as filesystem mode and can emit
    # partial output even while returning nonzero. Check status before accepting
    # output so Linux reliably falls through to `-c`.
    if stat -f '%d:%i' "$archive_path" >/dev/null 2>&1; then
        identity="$(stat -f '%d:%i' "$archive_path" 2>/dev/null)"
    elif stat -c '%d:%i' "$archive_path" >/dev/null 2>&1; then
        identity="$(stat -c '%d:%i' "$archive_path" 2>/dev/null)"
    fi
    printf '%s\n' "$identity"
}

find_installed_backup_archive_by_inode() {
    local backup_source="$1"
    local backup_dir="$2"
    local source_identity=""
    local existing_path=""
    local existing_identity=""

    source_identity="$(backup_archive_inode_identity "$backup_source")"
    [ -n "$source_identity" ] || return 1

    while IFS= read -r existing_path; do
        existing_identity="$(backup_archive_inode_identity "$existing_path")"
        if [ -n "$existing_identity" ] && [ "$existing_identity" = "$source_identity" ]; then
            printf '%s\n' "$existing_path"
            return 0
        fi
    done < <(
        find "$backup_dir" -maxdepth 1 -type f -name 'portico_full_backup_*.zip' -print 2>/dev/null
    )

    return 1
}

persist_full_backup_archive() {
    local backup_dir="$MANAGED_DIR/backup"
    local backup_name=""
    local target_backup_path=""
    local target_suffix=""
    local target_index=0
    local existing_inode_path=""
    local preinstall_keep_count=0

    mkdir -p "$backup_dir"
    if [ -z "$FULL_BACKUP_ZIP_PATH" ] || [ ! -f "$FULL_BACKUP_ZIP_PATH" ]; then
        return 0
    fi

    existing_inode_path="$(find_installed_backup_archive_by_inode "$FULL_BACKUP_ZIP_PATH" "$backup_dir" || true)"
    if [ -n "$existing_inode_path" ]; then
        log_success "Full backup archive already installed: backup/$(basename "$existing_inode_path")"
        return 0
    fi

    backup_name="${FULL_BACKUP_ZIP_NAME:-$(basename "$FULL_BACKUP_ZIP_PATH")}"
    target_backup_path="$backup_dir/$backup_name"
    target_suffix="$(date +%s)"
    while [ -e "$target_backup_path" ]; do
        if [ "$target_index" -gt 0 ]; then
            target_suffix="${target_suffix%%-*}-$target_index"
        fi
        case "$backup_name" in
            *.zip)
                target_backup_path="$backup_dir/${backup_name%.zip}-${target_suffix}.zip"
                ;;
            *)
                target_backup_path="$backup_dir/${backup_name}-${target_suffix}"
                ;;
        esac
        target_index=$((target_index + 1))
    done

    if ! [[ "$FULL_BACKUP_RETENTION_COUNT" =~ ^[1-9][0-9]*$ ]]; then
        FULL_BACKUP_RETENTION_COUNT=2
    fi
    preinstall_keep_count=$((FULL_BACKUP_RETENTION_COUNT - 1))
    prune_full_backup_archives "$backup_dir" "$preinstall_keep_count"

    if ln "$FULL_BACKUP_ZIP_PATH" "$target_backup_path" 2>/dev/null; then
        log_success "Full backup archive saved: backup/$(basename "$target_backup_path")"
        return 0
    fi

    if cp "$FULL_BACKUP_ZIP_PATH" "$target_backup_path"; then
        log_success "Full backup archive saved: backup/$(basename "$target_backup_path")"
        return 0
    fi

    log_error "Failed to place full backup archive into managed backup directory"
    return 1
}

usage() {
    echo "Usage: $0 --build-number BUILD_NUMBER [--channel CHANNEL]"
    echo ""
    echo "Arguments:"
    echo "  --build-number BUILD   Build number in MMDDYYYY-SHA format (required)"
    echo "  --channel CHANNEL      Update channel (default: portico)"
    echo ""
    echo "Example:"
    echo "  $0 --build-number 03102026-abc12345"
    exit 1
}

# PORTICO-342: build the payload curl arguments. Extracted so the argv can be asserted
# without running a transfer -- the previous coverage for these flags was a regex
# matched against this file's source text, which broke on this very change and could
# never have caught the flags being dropped at runtime. Result lands in
# PAYLOAD_CURL_ARGS because bash cannot return an array.
PAYLOAD_CURL_ARGS=()
build_payload_curl_args() {
    local total_bytes="${1:-0}"
    local download_file="$2"
    local current_bytes=""

    PAYLOAD_CURL_ARGS=()

    # Abandon a transfer that has gone dead instead of sitting on it. Measured on the
    # reported install: ~4 minutes across the session were spent on a live process
    # watching a socket delivering nothing. Small beside the 61 minutes lost to
    # sleep, but without these the only thing that ends a dead transfer is a TCP
    # reset whenever the kernel gets round to it. The floor sits far below the worst
    # healthy throughput observed (193 KB/s) so a merely slow link is never killed.
    PAYLOAD_CURL_ARGS+=(--speed-limit "$PAYLOAD_STALL_BYTES_PER_SEC" --speed-time "$PAYLOAD_STALL_SECONDS")

    # Resume rather than restart. `If-Range` makes this safe: the server returns 206
    # only if the validator still matches, and a plain 200 means curl rewrites the
    # file from the start, so a changed payload cannot be spliced onto stale bytes.
    # Without a validator we do not attempt resume at all.
    if payload_partial_is_resumable "$download_file" "$total_bytes"; then
        current_bytes="$(file_size_bytes "$download_file")"
        log_info "Resuming payload download from ${current_bytes} bytes"
        PAYLOAD_CURL_ARGS+=(-C - -H "If-Range: $BUILD_LAST_MODIFIED")
    fi
}

run_curl_download_with_progress() {
    local mode="$1"
    local total_bytes="${2:-0}"
    local download_file="$3"
    local stderr_file="$4"
    local curl_pid=0
    local current_bytes=0
    local current_percent=0
    build_payload_curl_args "$total_bytes" "$download_file"

    if [ "$mode" = "clean-env" ]; then
        prepare_curl_checked --clean-env --stderr-file "$stderr_file" "Cloudsmith payload download" "$DOWNLOAD_URL" -sS -L -f "${PAYLOAD_CURL_ARGS[@]}" -o "$download_file"
    else
        prepare_curl_checked --stderr-file "$stderr_file" "Cloudsmith payload download" "$DOWNLOAD_URL" -sS -L -f "${PAYLOAD_CURL_ARGS[@]}" -o "$download_file"
    fi

    log_diag_info "Payload download retry mode: $PREPARED_CURL_MODE"

    run_prepared_curl &
    curl_pid=$!

    while kill -0 "$curl_pid" 2>/dev/null; do
        current_bytes="$(stat -f%z "$download_file" 2>/dev/null || echo 0)"
        emit_progress "download_bytes" "$current_bytes"
        if [[ "$total_bytes" =~ ^[0-9]+$ ]] && [ "$total_bytes" -gt 0 ]; then
            current_percent=$(( current_bytes * 100 / total_bytes ))
            if [ "$current_percent" -gt 99 ]; then
                current_percent=99
            fi
            emit_progress "download_percent" "$current_percent"
        fi
        sleep 1
    done

    wait "$curl_pid"
    local curl_status=$?
    if [ "$curl_status" -eq 0 ]; then
        current_bytes="$(stat -f%z "$download_file" 2>/dev/null || echo 0)"
        emit_progress "download_bytes" "$current_bytes"
        emit_progress "download_percent" "100"
        emit_progress "download_complete" "true"
        DOWNLOAD_SIZE="$(ls -lh "$download_file" | awk '{print $5}')"
        log_success "Download completed: $DOWNLOAD_SIZE"
        return 0
    fi

    return "$curl_status"
}

download_payload_with_retry() {
    local total_bytes="${1:-0}"
    local download_file="$2"
    local stderr_file="$3"
    local exit_code=0
    local curl_error=""

    run_curl_download_with_progress "normal" "$total_bytes" "$download_file" "$stderr_file"
    exit_code=$?
    if [ "$exit_code" -eq 0 ]; then
        return 0
    fi

    if [ "$exit_code" -ne 3 ]; then
        return "$exit_code"
    fi

    curl_error="$(summarize_stderr_file "$stderr_file")"
    log_warning "curl exited with code 3 during payload download"
    log_warning "Payload download curl binary: $(resolve_curl_bin)"
    log_warning "Payload download URL: $(redact_url_for_log "$DOWNLOAD_URL")"
    log_warning "Payload download argv: $PREPARED_CURL_ARGV_LOG"
    log_warning "Payload download stderr: ${curl_error:-<empty>}"
    log_warning "Retrying payload download with clean environment"

    # PORTICO-342: deliberately NOT removing the partial here. The clean-env retry exists
    # to work around a curl environment problem, not a corrupt body, so the bytes
    # already on disk are still good and run_curl_download_with_progress will resume
    # from them. Deleting was free when the file was disposable; now it costs the
    # whole transfer.
    : > "$stderr_file"

    run_curl_download_with_progress "clean-env" "$total_bytes" "$download_file" "$stderr_file"
    exit_code=$?
    if [ "$exit_code" -eq 0 ]; then
        return 0
    fi

    return "$exit_code"
}

main() {
    exec 3>&1
    LOG_FD=3
    trap cleanup EXIT

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --build-number)
                BUILD_NUMBER="$2"
                shift 2
                ;;
            --channel)
                KEYWORD="$2"
                shift 2
                ;;
            --help|-h)
                usage
                ;;
            *)
                echo "Unknown argument: $1"
                usage
                ;;
        esac
    done

    if [ -z "$CLOUDSMITH_ENTITLEMENT_TOKEN" ]; then
        log_error "CLOUDSMITH_ENTITLEMENT_TOKEN is not set. Ensure cloudsmith.env exists or set the env var manually."
    fi

    if [ -z "$BUILD_NUMBER" ]; then
        log_error "Build number is required. Use --build-number BUILD_NUMBER"
    fi

    if ! [[ "$BUILD_NUMBER" =~ ^[0-9]{8}-[a-f0-9]+$ ]]; then
        log_error "Invalid build number format: $BUILD_NUMBER (expected: MMDDYYYY-SHA)"
    fi

    BUILD_DATE="${BUILD_NUMBER:0:8}"
    BUILD_SHA="${BUILD_NUMBER:9}"
    if [ ${#BUILD_SHA} -gt 8 ]; then
        SHORT_SHA="${BUILD_SHA:0:8}"
    else
        SHORT_SHA="$BUILD_SHA"
    fi

    CS_TOKEN="$CLOUDSMITH_READ_TOKEN"
    CS_TOKEN_SOURCE="api_key"

    TEMP_DIR="$(mktemp -d)"

    CURL_BIN="$(resolve_curl_bin)" || log_error "curl command not found"
    CURL_VERSION_LINE="$("$CURL_BIN" --version | head -n 1)"

    log_diag_info "Prereq download script path: $PREREQ_SCRIPT_PATH"
    log_diag_info "Cloudsmith env file: ${_CLOUDSMITH_ENV:-<unset>}"
    log_diag_info "Cloudsmith owner/repo: ${CLOUDSMITH_OWNER}/${CLOUDSMITH_REPO}"
    log_diag_info "Cloudsmith API base: $CLOUDSMITH_API_BASE"
    log_diag_info "Cloudsmith download base: $CLOUDSMITH_DL_BASE"
    log_diag_info "Cloudsmith auth token source: $CS_TOKEN_SOURCE"
    log_diag_info "curl binary: $CURL_BIN"
    log_diag_info "curl version: $CURL_VERSION_LINE"
    log_curl_runtime_environment

    emit_phase_start
    log "========================================"
    log "Prerequisites Phase 1: Download & Setup"
    log "Build Number: $BUILD_NUMBER"
    log "Channel: $KEYWORD"
    log "========================================"

    emit_step_start "cloudsmith-lookup"
    emit_progress "phase1_step" "cloudsmith-lookup"
    emit_progress "phase1_activity" "Looking up the latest payload..."
    log_info "Looking up build in Cloudsmith repository..."

    if [ "$KEYWORD" = "portico" ] && [ -f "$MANAGED_DIR/UPDATE_CHANNEL" ] && [ -s "$MANAGED_DIR/UPDATE_CHANNEL" ]; then
        _uc="$(tr -d '[:space:]' < "$MANAGED_DIR/UPDATE_CHANNEL")"
        if [ -n "$_uc" ]; then
            KEYWORD="$_uc"
            log_info "Using update channel from existing installation: $KEYWORD"
        fi
    fi

    if ! KEYWORD="$(resolve_update_channel_package_name "$KEYWORD")"; then
        log_warning "Ignoring malformed update channel and falling back to Stable"
        KEYWORD="portico"
    fi

    EXPECTED_FILENAME="${KEYWORD}-${BUILD_NUMBER}.zip"
    DOWNLOAD_URL="$(build_cloudsmith_download_url "$KEYWORD" "$BUILD_NUMBER" "$EXPECTED_FILENAME" "" || true)"

    if [ -z "$DOWNLOAD_URL" ]; then
        log_error "Could not construct the exact Cloudsmith download URL for build $BUILD_NUMBER on channel $KEYWORD"
    fi

    log_diag_info "Cloudsmith download URL source: $CLOUDSMITH_DOWNLOAD_URL_SOURCE"
    log_success "Found download URL: $(redact_url_for_log "$DOWNLOAD_URL")"
    emit_step_complete "cloudsmith-lookup"

    emit_step_start "prepare-directory"
    emit_progress "phase1_step" "prepare-directory"
    emit_progress "phase1_activity" "Preparing local workspace..."
    log_info "Preparing managed directory: $MANAGED_DIR"

    if [ -d "$MANAGED_DIR" ]; then
        log_warning "Existing installation detected - shipped runtime content will be reconciled from the new payload"
        log_info "Built-in MCP configs and skills are payload-managed and will be replaced by package contents."

        if ! create_slim_backup; then
            log_error "Failed to create slim app-state backup before runtime reconciliation"
        fi
    fi

    mkdir -p "$MANAGED_DIR"
    log_success "Managed directory ready: $MANAGED_DIR"
    emit_step_complete "prepare-directory"

    emit_step_start "download"
    emit_progress "phase1_step" "download"
    emit_progress "phase1_activity" "Downloading update payload..."
    log_info "Downloading $EXPECTED_FILENAME..."

    DOWNLOAD_STDERR="$TEMP_DIR/download.stderr"
    TOTAL_BYTES="$(detect_content_length)"
    if [[ "$TOTAL_BYTES" =~ ^[0-9]+$ ]] && [ "$TOTAL_BYTES" -gt 0 ]; then
        emit_progress "download_total_bytes" "$TOTAL_BYTES"
    fi

    if payload_cache_try_reuse "${TOTAL_BYTES:-0}"; then
        log_info "Skipping Cloudsmith payload download because the same payload is already cached"
    else
        # PORTICO-342: download into a durable, identity-keyed location instead of the
        # disposable TEMP_DIR, so an interruption leaves bytes we can resume from.
        # If that location cannot be prepared we fall back to the old temp path --
        # a non-resumable download is still a download.
        PAYLOAD_PARTIAL_DIR="$(payload_partial_dir_for_target)"
        if mkdir -p "$PAYLOAD_PARTIAL_DIR" 2>/dev/null; then
            payload_partial_prune_other_identities "$PAYLOAD_PARTIAL_DIR"
            DOWNLOAD_FILE="$PAYLOAD_PARTIAL_DIR/$EXPECTED_FILENAME"
            if ! payload_partial_is_resumable "$DOWNLOAD_FILE" "${TOTAL_BYTES:-0}"; then
                payload_partial_discard "$DOWNLOAD_FILE" "no matching validator"
            fi
            payload_partial_write_validator "${TOTAL_BYTES:-0}" || true
        else
            log_warning "Could not prepare the resumable payload directory; this download cannot be resumed"
            DOWNLOAD_FILE="$TEMP_DIR/$EXPECTED_FILENAME"
        fi

        if ! download_payload_with_retry "${TOTAL_BYTES:-0}" "$DOWNLOAD_FILE" "$DOWNLOAD_STDERR"; then
            CURL_ERROR="$(summarize_stderr_file "$DOWNLOAD_STDERR")"
            log_error "${CURL_ERROR:-Failed to download file from Cloudsmith}"
        fi
    fi

    emit_step_complete "download"

    emit_step_start "extract"
    emit_progress "phase1_step" "extract"
    emit_progress "phase1_activity" "Unpacking the downloaded payload..."
    log_info "Extracting archive..."

    EXTRACT_TEMP="$TEMP_DIR/extract"
    mkdir -p "$EXTRACT_TEMP"

    # PORTICO-342: verify length before unpacking. Resuming with Range means the file on
    # disk is now assembled from more than one response, so "the bytes are whatever
    # this one curl wrote" no longer holds. If-Range plus the validator check should
    # make a mismatch impossible; this is the assertion that it was. On failure the
    # partial is discarded so the retry starts from a clean file rather than
    # resuming onto the same bad bytes forever.
    if [[ "${TOTAL_BYTES:-0}" =~ ^[0-9]+$ ]] && [ "${TOTAL_BYTES:-0}" -gt 0 ]; then
        DOWNLOADED_BYTES="$(file_size_bytes "$DOWNLOAD_FILE")"
        if [ "$DOWNLOADED_BYTES" != "$TOTAL_BYTES" ]; then
            payload_partial_discard "$DOWNLOAD_FILE" "size ${DOWNLOADED_BYTES} did not match the expected ${TOTAL_BYTES}"
            log_error "Downloaded payload is ${DOWNLOADED_BYTES} bytes but ${TOTAL_BYTES} were expected; discarded it so the next attempt restarts cleanly"
        fi
    fi

    if ! command -v unzip >/dev/null 2>&1; then
        log_error "unzip command not available"
    fi

    if ! unzip -q "$DOWNLOAD_FILE" -d "$EXTRACT_TEMP"; then
        payload_cache_invalidate_used "archive extraction failed"
        log_error "Failed to extract archive"
    fi

    log_success "Archive extracted successfully"

    EXTRACTED_ITEMS="$(ls -A "$EXTRACT_TEMP" | wc -l | tr -d ' ')"
    FIRST_ITEM="$(ls -A "$EXTRACT_TEMP" | head -1 || true)"
    if [ "$EXTRACTED_ITEMS" = "1" ] && [ -n "$FIRST_ITEM" ] && [ -d "$EXTRACT_TEMP/$FIRST_ITEM" ]; then
        SOURCE_DIR="$EXTRACT_TEMP/$FIRST_ITEM"
    else
        SOURCE_DIR="$EXTRACT_TEMP"
    fi

    RELEASE_MANIFEST="$SOURCE_DIR/release-manifest.json"
    MANAGED_ROOT_NAME="managed-root"
    MANAGED_SOURCE_DIR=""

    if [ -f "$RELEASE_MANIFEST" ]; then
        MANAGED_ROOT_NAME="$(json_get_string "$RELEASE_MANIFEST" "managedRootDir")"
        MANAGED_ROOT_NAME="${MANAGED_ROOT_NAME:-managed-root}"
        MANAGED_SOURCE_DIR="$SOURCE_DIR/$MANAGED_ROOT_NAME"
        log_info "Detected packaged release payload with manifest: $RELEASE_MANIFEST"
    else
        MANAGED_SOURCE_DIR="$SOURCE_DIR"
        log_info "Detected legacy source payload without release manifest"
    fi

    if [ ! -d "$MANAGED_SOURCE_DIR" ]; then
        payload_cache_invalidate_used "the managed runtime tree was not found"
        log_error "Managed runtime tree not found in payload: $MANAGED_SOURCE_DIR"
    fi

    if [ "$PAYLOAD_CACHE_USED" != "true" ]; then
        payload_cache_promote_download "$DOWNLOAD_FILE" "${TOTAL_BYTES:-0}"
        # PORTICO-342: the payload is now in the cache, so the partial is redundant.
        # Leaving it would strand a second full copy (~777 MB per build) in the
        # user's Caches directory, and nothing else prunes this directory.
        payload_partial_cleanup
    fi

    managed_runtime_remove_generated_compose_files "$MANAGED_SOURCE_DIR"

    FILE_COUNT="$(find "$MANAGED_SOURCE_DIR" -type f | wc -l | tr -d ' ')"
    log_info "Prepared $FILE_COUNT payload files for managed runtime reconcile"
    emit_step_complete "extract"

    emit_step_start "restore"
    emit_progress "phase1_step" "restore"
    emit_progress "phase1_activity" "Restoring your local settings..."
    managed_runtime_reconcile_payload "$MANAGED_SOURCE_DIR" "$MANAGED_DIR" "${PRESERVE_FILES[@]}"

    persist_full_backup_archive

    if [ -n "$FULL_BACKUP_TEMP" ] && [ -d "$FULL_BACKUP_TEMP" ]; then
        rm -rf "$FULL_BACKUP_TEMP"
    fi
    emit_step_complete "restore"

    emit_step_start "build-info"
    emit_progress "phase1_step" "build-info"
    emit_progress "phase1_activity" "Finalizing the downloaded payload..."
    log_info "Refreshing build-info.json..."

    BUILD_INFO_DIR="$MANAGED_DIR/electron-app"
    EXISTING_BUILD_INFO="$BUILD_INFO_DIR/build-info.json"
    TIMESTAMP_VALUE="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"

    refresh_managed_build_info \
        "$EXISTING_BUILD_INFO" \
        "$RELEASE_MANIFEST" \
        "$BUILD_NUMBER" \
        "$BUILD_SHA" \
        "$BUILD_DATE" \
        "$KEYWORD" \
        "$TIMESTAMP_VALUE"

    if [ -f "$BUILD_INFO_DIR/build-info.json" ]; then
        log_success "Created build-info.json in $BUILD_INFO_DIR"
    else
        log_error "Failed to create build-info.json"
    fi

    log_info "Regenerating managed runtime compose artifacts..."
    managed_runtime_regenerate_generated_compose "$MANAGED_DIR" "$PREREQ_SCRIPT_DIR"
    managed_runtime_validate_generated_compose "$MANAGED_DIR"

    if [ -n "$BUILD_LAST_MODIFIED" ]; then
        LAST_INSTALLED_BUILD_FILE="$HOME/Library/Application Support/portico/LAST_INSTALLED_BUILD"
        LAST_INSTALLED_BUILD_TEMP="${LAST_INSTALLED_BUILD_FILE}.$$"
        mkdir -p "$(dirname "$LAST_INSTALLED_BUILD_FILE")"
        if printf '{\n  "schemaVersion": 1,\n  "buildNumber": "%s",\n  "timestamp": "%s"\n}\n' \
            "$BUILD_NUMBER" "$BUILD_LAST_MODIFIED" > "$LAST_INSTALLED_BUILD_TEMP" \
            && mv -f "$LAST_INSTALLED_BUILD_TEMP" "$LAST_INSTALLED_BUILD_FILE"; then
            log_success "Updated LAST_INSTALLED_BUILD state for $BUILD_NUMBER"
        else
            rm -f "$LAST_INSTALLED_BUILD_TEMP"
            log_warning "Failed to update LAST_INSTALLED_BUILD state"
        fi
    else
        log_warning "Cloudsmith package timestamp missing; LAST_INSTALLED_BUILD was not updated"
    fi

    emit_step_complete "build-info"
    emit_progress "phase1_step" "complete"
    emit_progress "phase1_activity" "Download complete."
    emit_progress "download_complete" "true"

    emit_phase_complete
    log "========================================"
    log "Phase 1 Complete: Download & Setup"
    log "Managed directory: $MANAGED_DIR"
    log "Build: $BUILD_NUMBER"
    log "========================================"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    main "$@"
fi
