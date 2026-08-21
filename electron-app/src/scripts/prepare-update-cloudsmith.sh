#!/bin/bash

# Prepare an update in an isolated staging directory.
# It stages the managed runtime tree plus the native macOS .app/.dmg artifacts.
# The only writes to the active managed installation are bounded backup snapshots
# and the update audit ledger; live runtime and user-data paths are never changed.

set -euo pipefail

STAGE_DIR="${1:-}"
PROJECT_ROOT="${2:-}"
DOWNLOAD_URL="${3:-}"
FILENAME="${4:-}"
FULL_SHA="${5:-}"
UPDATE_KEY="${6:-unknown}"
UPDATE_CHANNEL="${7:-portico}"
CHECKSUM_ALGO="${8:-}"
CHECKSUM_VALUE="${9:-}"
LAST_MODIFIED="${10:-unknown}"
EXPECTED_FILE_SIZE="${11:-0}"

if [ -z "$STAGE_DIR" ] || [ -z "$PROJECT_ROOT" ] || [ -z "$DOWNLOAD_URL" ] || [ -z "$FILENAME" ] || [ -z "$FULL_SHA" ] || [ -z "$CHECKSUM_ALGO" ] || [ -z "$CHECKSUM_VALUE" ]; then
  echo "Usage: $0 <stage_dir> <project_root> <download_url> <filename> <full_sha> [update_key] [update_channel] <checksum_algo> <checksum_value> [last_modified] [expected_file_size]" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASE_CHANNEL_SH=""
for candidate in \
  "$SCRIPT_DIR/release-channel.sh" \
  "$SCRIPT_DIR/../../../src/scripts/release-channel.sh"
do
  if [ -f "$candidate" ]; then
    RELEASE_CHANNEL_SH="$candidate"
    break
  fi
done
if [ -z "$RELEASE_CHANNEL_SH" ]; then
  echo "Release channel helper not found" >&2
  exit 1
fi
# shellcheck source=/dev/null
. "$RELEASE_CHANNEL_SH"

if ! UPDATE_CHANNEL="$(resolve_update_channel_package_name "$UPDATE_CHANNEL")"; then
  echo "Invalid update channel package name" >&2
  exit 1
fi
BUILD_IDENTITY="${FILENAME#${UPDATE_CHANNEL}-}"
BUILD_IDENTITY="${BUILD_IDENTITY%.zip}"
if [ "$FILENAME" != "${UPDATE_CHANNEL}-${BUILD_IDENTITY}.zip" ] || \
  ! [[ "$BUILD_IDENTITY" =~ ^[0-9]{8}-[a-f0-9]{8,40}$ ]]; then
  echo "Update filename does not match active release channel: $FILENAME" >&2
  exit 1
fi

MANAGED_DIR="$HOME/portico/portico-managed"
mkdir -p "$STAGE_DIR"

STAGE_DIR="$(cd "$STAGE_DIR" && pwd -P)"
if [ -d "$MANAGED_DIR" ]; then
  MANAGED_DIR="$(cd "$MANAGED_DIR" && pwd -P)"
fi

case "$STAGE_DIR" in
  "$MANAGED_DIR"|"$MANAGED_DIR"/*)
    echo "Refusing to prepare update inside managed installation: $STAGE_DIR" >&2
    exit 1
    ;;
esac

PAYLOAD_DIR="$STAGE_DIR/payload"
DOWNLOAD_DIR="$STAGE_DIR/download"
EXTRACT_DIR="$DOWNLOAD_DIR/extract"
DOWNLOAD_FILE="$DOWNLOAD_DIR/$FILENAME"
MANIFEST_PATH="$STAGE_DIR/manifest.json"
BACKUP_DIR="$STAGE_DIR/backup"
PREP_BUILD_INFO=""
BACKUP_REQUIRED=false
PREP_FULL_BACKUP_NAME=""
PREP_FULL_BACKUP_PATH=""
PREP_DB_SNAPSHOT_PATH=""
PREP_LEDGER_STEP="initialization"

cleanup_stale_reconcile_strands() {
  local tmp_root="${TMPDIR:-/tmp}"
  local strand=""
  local removed_count=0
  local failed_count=0

  [ -d "$tmp_root" ] || return 0

  while IFS= read -r strand; do
    [ -n "$strand" ] || continue
    if rm -rf -- "$strand"; then
      removed_count=$((removed_count + 1))
      echo "Removed stale managed-runtime reconcile strand: $strand"
    else
      failed_count=$((failed_count + 1))
      echo "Warning: failed to remove stale managed-runtime reconcile strand: $strand" >&2
    fi
  done < <(
    find "$tmp_root" -mindepth 1 -maxdepth 1 -type d \
      -name 'managed-runtime-reconcile.*' -mtime +0 -print 2>/dev/null || true
  )

  if [ "$removed_count" -gt 0 ] || [ "$failed_count" -gt 0 ]; then
    echo "Stale reconcile strand sweep: removed=${removed_count} failed=${failed_count}"
  fi
  return 0
}

json_escape_for_ledger() {
  printf '%s' "${1:-}" \
    | sed 's/\\/\\\\/g; s/"/\\"/g' \
    | tr '\r\n' '  '
}

read_current_build_number() {
  local build_info="$MANAGED_DIR/electron-app/build-info.json"
  local value=""

  [ -f "$build_info" ] || {
    printf '%s\n' "unknown"
    return 0
  }

  value="$(sed -n 's/.*"buildNumber"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$build_info" | head -n 1)"
  printf '%s\n' "${value:-unknown}"
}

available_disk_kb_for_ledger() {
  local target="$MANAGED_DIR"
  [ -e "$target" ] || target="$(dirname "$MANAGED_DIR")"
  df -Pk "$target" 2>/dev/null | awk 'NR == 2 { print $4; exit }'
}

append_prepare_history() {
  local result="$1"
  local history_dir="$MANAGED_DIR/health-status"
  local history_file="$history_dir/update-history.jsonl"
  local history_tmp="${history_file}.tmp.$$"
  local timestamp=""
  local from_build=""
  local free_disk_kb=""

  [ -d "$MANAGED_DIR" ] || return 0

  timestamp="$(date -u +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date)"
  from_build="$(read_current_build_number)"
  free_disk_kb="$(available_disk_kb_for_ledger || true)"
  case "$free_disk_kb" in
    ''|*[!0-9]*) free_disk_kb=0 ;;
  esac

  if ! mkdir -p "$history_dir" 2>/dev/null; then
    return 0
  fi

  umask 077
  printf '{"ts":"%s","from":"%s","to":"%s","step":"%s","result":"%s","freeDiskKb":%s}\n' \
    "$(json_escape_for_ledger "$timestamp")" \
    "$(json_escape_for_ledger "$from_build")" \
    "$(json_escape_for_ledger "$BUILD_IDENTITY")" \
    "$(json_escape_for_ledger "$PREP_LEDGER_STEP")" \
    "$(json_escape_for_ledger "$result")" \
    "$free_disk_kb" \
    >> "$history_file" 2>/dev/null || return 0

  if [ "$(wc -l < "$history_file" 2>/dev/null | tr -d '[:space:]')" -gt 500 ] 2>/dev/null; then
    if tail -n 500 "$history_file" > "$history_tmp" 2>/dev/null; then
      mv "$history_tmp" "$history_file" 2>/dev/null || rm -f "$history_tmp"
    else
      rm -f "$history_tmp"
    fi
  fi
}

record_prepare_result() {
  local status=$?
  local result="fail"
  trap - EXIT
  [ "$status" -eq 0 ] && result="ok"
  append_prepare_history "$result" || true
  exit "$status"
}

prune_db_snapshots() {
  local snapshot_dir="$1"
  local retention_count="${DB_SNAPSHOT_RETENTION_COUNT:-5}"
  local snapshot=""
  local snapshot_count=0
  local pruned_count=0

  case "$retention_count" in
    ''|*[!0-9]*) retention_count=5 ;;
  esac
  [ "$retention_count" -gt 0 ] || retention_count=5

  while IFS= read -r snapshot; do
    [ -n "$snapshot" ] || continue
    snapshot_count=$((snapshot_count + 1))
    if [ "$snapshot_count" -gt "$retention_count" ]; then
      if rm -f -- "$snapshot"; then
        pruned_count=$((pruned_count + 1))
      else
        echo "Warning: failed to prune old database snapshot: $snapshot" >&2
      fi
    fi
  done < <(
    find "$snapshot_dir" -maxdepth 1 -type f -name 'webui.db.*' -print 2>/dev/null \
      | LC_ALL=C sort -r
  )

  if [ "$pruned_count" -gt 0 ]; then
    echo "Database snapshot retention: pruned ${pruned_count}; kept ${retention_count}"
  fi
}

create_webui_db_snapshot() {
  local source_db="$MANAGED_DIR/open-webui-data/webui.db"
  local snapshot_dir="$MANAGED_DIR/backup/db-snapshots"
  local timestamp="$1"
  local destination="$snapshot_dir/webui.db.${timestamp}"
  local temporary="$snapshot_dir/.webui.db.${timestamp}.tmp.$$"
  local temporary_name="$(basename "$temporary")"
  local snapshot_method=""

  PREP_DB_SNAPSHOT_PATH=""
  [ -s "$source_db" ] || return 0

  mkdir -p "$snapshot_dir"
  chmod 700 "$snapshot_dir" 2>/dev/null || true
  rm -f "$temporary"

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
      echo "Failed to create Open WebUI database snapshot" >&2
      return 1
    fi
  fi

  if [ ! -s "$temporary" ]; then
    rm -f "$temporary"
    echo "Open WebUI database snapshot is empty" >&2
    return 1
  fi
  if ! mv "$temporary" "$destination"; then
    rm -f "$temporary"
    echo "Failed to finalize Open WebUI database snapshot" >&2
    return 1
  fi
  chmod 600 "$destination" 2>/dev/null || true

  PREP_DB_SNAPSHOT_PATH="$destination"
  echo "Open WebUI database snapshot created with ${snapshot_method}: $destination"
  echo "[UPDATE_PREP:DB_SNAPSHOT:${destination}]"
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
  local timestamp="$1"
  local backup_manifest="$BACKUP_DIR/slim-backup-manifest.txt"
  local candidate=""
  local relative_path=""
  local env_matches=""
  local token_matches=""
  local config_entries=()

  PREP_FULL_BACKUP_NAME="portico_full_backup_${timestamp}.zip"
  PREP_FULL_BACKUP_PATH="$BACKUP_DIR/$PREP_FULL_BACKUP_NAME"

  create_webui_db_snapshot "$timestamp" || return 1

  if [ -d "$MANAGED_DIR" ]; then
    if ! env_matches="$(list_slim_backup_config_matches '.env*')" \
      || ! token_matches="$(list_slim_backup_config_matches 'mcpo-*oauth-tokens')"; then
      echo "Failed to enumerate slim backup configuration entries under $MANAGED_DIR" >&2
      return 1
    fi
  fi

  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    relative_path="${candidate#"$MANAGED_DIR"/}"
    config_entries+=("$relative_path")
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
    relative_path="${candidate#"$MANAGED_DIR"/}"
    config_entries+=("$relative_path")
  done <<<"$token_matches"

  rm -f "$PREP_FULL_BACKUP_PATH" "$backup_manifest"
  if [ "${#config_entries[@]}" -gt 0 ]; then
    if ! (
      cd "$MANAGED_DIR" &&
      zip -r --symlinks "$PREP_FULL_BACKUP_PATH" "${config_entries[@]}" >/dev/null
    ); then
      rm -f "$PREP_FULL_BACKUP_PATH"
      echo "Failed to create slim configuration backup archive" >&2
      return 1
    fi
  fi

  {
    echo "format=portico-slim-backup-v1"
    echo "created_at=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
    echo "database_snapshot=${PREP_DB_SNAPSHOT_PATH:-none}"
  } > "$backup_manifest"
  if ! zip -j "$PREP_FULL_BACKUP_PATH" "$backup_manifest" >/dev/null; then
    rm -f "$PREP_FULL_BACKUP_PATH" "$backup_manifest"
    echo "Failed to add metadata to slim configuration backup archive" >&2
    return 1
  fi
  rm -f "$backup_manifest"

  if [ ! -s "$PREP_FULL_BACKUP_PATH" ]; then
    echo "Prepared slim backup archive was not created: $PREP_FULL_BACKUP_PATH" >&2
    return 1
  fi
  chmod 600 "$PREP_FULL_BACKUP_PATH" 2>/dev/null || true
}

trap record_prepare_result EXIT

rm -rf "$PAYLOAD_DIR" "$DOWNLOAD_DIR" "$BACKUP_DIR" "$MANIFEST_PATH"
mkdir -p "$PAYLOAD_DIR" "$DOWNLOAD_DIR" "$BACKUP_DIR"

compute_checksum() {
  local algorithm="$1"
  local file="$2"

  case "$algorithm" in
    sha256)
      if command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$file" | awk '{print tolower($1)}'
      elif command -v openssl >/dev/null 2>&1; then
        openssl dgst -sha256 "$file" | awk '{print tolower($NF)}'
      else
        return 1
      fi
      ;;
    sha512)
      if command -v shasum >/dev/null 2>&1; then
        shasum -a 512 "$file" | awk '{print tolower($1)}'
      elif command -v openssl >/dev/null 2>&1; then
        openssl dgst -sha512 "$file" | awk '{print tolower($NF)}'
      else
        return 1
      fi
      ;;
    sha1)
      if command -v shasum >/dev/null 2>&1; then
        shasum -a 1 "$file" | awk '{print tolower($1)}'
      elif command -v openssl >/dev/null 2>&1; then
        openssl dgst -sha1 "$file" | awk '{print tolower($NF)}'
      else
        return 1
      fi
      ;;
    md5)
      if command -v md5 >/dev/null 2>&1; then
        md5 -q "$file" | tr '[:upper:]' '[:lower:]'
      elif command -v md5sum >/dev/null 2>&1; then
        md5sum "$file" | awk '{print tolower($1)}'
      elif command -v openssl >/dev/null 2>&1; then
        openssl dgst -md5 "$file" | awk '{print tolower($NF)}'
      else
        return 1
      fi
      ;;
    *)
      return 1
      ;;
  esac
}

json_get_string() {
  local file_path="$1"
  local key_path="$2"

  if [ ! -f "$file_path" ]; then
    return 0
  fi

  if command -v plutil >/dev/null 2>&1; then
    plutil -extract "$key_path" raw -o - "$file_path" 2>/dev/null || true
    return 0
  fi

  if command -v python3 >/dev/null 2>&1; then
    python3 - "$file_path" "$key_path" <<'PY' 2>/dev/null || true
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
  fi
}

native_darwin_arch() {
  local arm64_capability=""
  arm64_capability="$(sysctl -in hw.optional.arm64 2>/dev/null || true)"
  if [ "$arm64_capability" = "1" ]; then
    echo "darwin-arm64"
    return 0
  fi

  case "$(uname -m)" in
    arm64|aarch64)
      echo "darwin-arm64"
      ;;
    *)
      echo "darwin-x64"
      ;;
  esac
}

MACOS_ARTIFACT_VERIFICATION_ERROR=""

run_command_with_timeout() {
  local timeout_seconds="$1"
  local output_file="$2"
  shift 2

  : > "$output_file"
  "$@" > "$output_file" 2>&1 &
  local child_pid="$!"
  local started_at="$SECONDS"
  local elapsed_seconds=0
  local sleep_bin="/bin/sleep"
  local poll_interval="${PORTICO_TEST_UPDATE_COMMAND_POLL_INTERVAL_SECONDS:-1}"
  if [ ! -x "$sleep_bin" ]; then
    sleep_bin="sleep"
  fi

  while kill -0 "$child_pid" 2>/dev/null; do
    elapsed_seconds=$((SECONDS - started_at))
    if [ "$elapsed_seconds" -ge "$timeout_seconds" ]; then
      kill "$child_pid" 2>/dev/null || true
      wait "$child_pid" 2>/dev/null || true
      return 124
    fi
    "$sleep_bin" "$poll_interval"
  done

  wait "$child_pid"
}

is_transient_stapler_validation_error() {
  local tool_output="$1"

  case "$tool_output" in
    *"NSURLErrorDomain Code=-1001"*|*"The request timed out"*|*"api.apple-cloudkit.com/database/1/com.apple.gk.ticket-delivery"*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

probe_stapler_prerequisite() {
  local developer_dir=""
  local stapler_path=""
  local tool_output=""

  if ! command -v xcode-select >/dev/null 2>&1; then
    echo "xcode-select is unavailable on this macOS installation." >&2
    return 1
  fi
  if ! tool_output="$(xcode-select -p 2>&1)"; then
    redact_sensitive_text_for_log "$tool_output" >&2
    echo "Apple Command Line Tools are not installed. Run xcode-select --install, finish Apple's installer, then retry the update." >&2
    return 1
  fi
  developer_dir="$(printf '%s' "$tool_output" | head -n 1 | tr -d '\r')"
  if [ -z "$developer_dir" ]; then
    echo "xcode-select did not return a usable developer directory. Repair or reinstall Apple Command Line Tools, then retry the update." >&2
    return 1
  fi

  if ! command -v xcrun >/dev/null 2>&1; then
    echo "xcrun is unavailable even though xcode-select reports $developer_dir." >&2
    return 1
  fi
  if ! tool_output="$(xcrun --find stapler 2>&1)"; then
    redact_sensitive_text_for_log "$tool_output" >&2
    echo "The selected Apple developer tools at $developer_dir cannot resolve stapler. Repair or reinstall Command Line Tools, then retry the update." >&2
    return 1
  fi
  stapler_path="$(printf '%s' "$tool_output" | head -n 1 | tr -d '\r')"
  if [ -z "$stapler_path" ]; then
    echo "xcrun did not return a usable stapler path. Repair or reinstall Apple Command Line Tools, then retry the update." >&2
    return 1
  fi

  echo "Apple developer tools ready: selected=$developer_dir stapler=$stapler_path"
  return 0
}

run_stapler_validation() {
  local artifact_path="$1"
  local tool_output_file=""
  local tool_output=""
  local status=0
  local timeout_seconds="${UPDATE_STAPLER_VALIDATE_TIMEOUT_SECONDS:-75}"

  tool_output_file="$(mktemp)"
  set +e
  run_command_with_timeout "$timeout_seconds" "$tool_output_file" xcrun stapler validate "$artifact_path"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    rm -f "$tool_output_file"
    return 0
  fi

  tool_output="$(cat "$tool_output_file" 2>/dev/null || true)"
  rm -f "$tool_output_file"

  if [ "$status" = "124" ]; then
    echo "Stapler validation for app bundle timed out after ${timeout_seconds}s without a classified Apple notarization-service error."
    return "$status"
  fi

  if is_transient_stapler_validation_error "$tool_output"; then
    echo "Stapler validation for app bundle hit a transient Apple notarization service error; continuing because code-signature and Gatekeeper checks already passed."
    redact_sensitive_text_for_log "$tool_output"
    return 0
  fi

  printf '%s\n' "$tool_output"
  return "$status"
}

verify_macos_artifact_signature() {
  local artifact_path="$1"
  local tool_output=""

  MACOS_ARTIFACT_VERIFICATION_ERROR=""

  if [ "${SKIP_UPDATE_SIGNATURE_VERIFICATION:-0}" = "1" ]; then
    echo "Skipping app signature verification because SKIP_UPDATE_SIGNATURE_VERIFICATION=1"
    return 0
  fi

  if [ "$(uname -s)" != "Darwin" ]; then
    echo "Skipping app signature verification on non-macOS host"
    return 0
  fi

  if [ ! -e "$artifact_path" ]; then
    MACOS_ARTIFACT_VERIFICATION_ERROR="Artifact is missing before macOS verification"
    echo "${MACOS_ARTIFACT_VERIFICATION_ERROR}: $artifact_path" >&2
    return 1
  fi

  if ! command -v spctl >/dev/null 2>&1; then
    MACOS_ARTIFACT_VERIFICATION_ERROR="macOS system tool spctl is unavailable"
    echo "$MACOS_ARTIFACT_VERIFICATION_ERROR" >&2
    return 1
  fi

  if ! command -v codesign >/dev/null 2>&1; then
    MACOS_ARTIFACT_VERIFICATION_ERROR="macOS system tool codesign is unavailable"
    echo "$MACOS_ARTIFACT_VERIFICATION_ERROR" >&2
    return 1
  fi
  if ! tool_output="$(probe_stapler_prerequisite 2>&1)"; then
    MACOS_ARTIFACT_VERIFICATION_ERROR="Apple Command Line Tools are missing or incomplete. Run xcode-select --install, finish Apple's installer, then retry the update"
    redact_sensitive_text_for_log "$tool_output" >&2
    return 1
  fi
  [ -z "$tool_output" ] || printf '%s\n' "$tool_output"
  if ! tool_output="$(codesign --verify --deep --strict --verbose=2 "$artifact_path" 2>&1)"; then
    MACOS_ARTIFACT_VERIFICATION_ERROR="App bundle code-signature verification failed"
    redact_sensitive_text_for_log "$tool_output" >&2
    return 1
  fi
  if ! tool_output="$(spctl --assess --type execute --verbose=2 "$artifact_path" 2>&1)"; then
    MACOS_ARTIFACT_VERIFICATION_ERROR="App bundle Gatekeeper assessment failed"
    redact_sensitive_text_for_log "$tool_output" >&2
    return 1
  fi
  if ! tool_output="$(run_stapler_validation "$artifact_path" 2>&1)"; then
    MACOS_ARTIFACT_VERIFICATION_ERROR="App bundle notarization-ticket validation failed"
    redact_sensitive_text_for_log "$tool_output" >&2
    return 1
  fi
  [ -z "$tool_output" ] || printf '%s\n' "$tool_output"

  return 0
}

emit_download_marker() {
  local key="$1"
  local value="${2:-}"
  echo "[UPDATE_PREP:DOWNLOAD:${key}:${value}]"
}

emit_error_marker() {
  local value="${1:-Unknown error}"
  value="$(printf '%s' "$value" | tr '\r\n' '  ' | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//')"
  echo "[UPDATE_PREP:ERROR:${value:-Unknown error}]"
}

fail_update_prep() {
  local message="${1:-Update preparation failed}"
  emit_error_marker "$message"
  printf '%s\n' "$message" >&2
  exit 1
}

redact_sensitive_text_for_log() {
  local value="${1:-}"
  local secret=""
  for secret in \
    "${DOWNLOAD_URL:-}" \
    "${CLOUDSMITH_ENTITLEMENT_TOKEN:-}" \
    "${CLOUDSMITH_API_KEY:-}"
  do
    [ -n "$secret" ] || continue
    value="${value//$secret/[REDACTED]}"
  done
  printf '%s\n' "$value"
}

current_file_size() {
  local file_path="$1"
  if [ ! -f "$file_path" ]; then
    echo "0"
    return 0
  fi

  if stat -f%z "$file_path" >/dev/null 2>&1; then
    stat -f%z "$file_path" 2>/dev/null || echo "0"
    return 0
  fi

  wc -c < "$file_path" 2>/dev/null | tr -d '[:space:]' || echo "0"
}

summarize_download_stderr() {
  local stderr_file="$1"
  if [ ! -s "$stderr_file" ]; then
    return 0
  fi

  local summary=""
  summary="$(awk '
    NF {
      gsub(/\r/, "")
      gsub(/[[:space:]]+/, " ")
      sub(/^ /, "")
      sub(/ $/, "")
      print
      exit
    }
  ' "$stderr_file")"
  redact_sensitive_text_for_log "$summary"
}

# PORTICO-323 (#4): recover the HTTP status from downloader stderr. Once curl has
# followed the CDN redirect, a 4xx is reported behind transport exit code 56, so
# the status is the only reliable signal that the download was refused rather
# than dropped. Emitting it explicitly lets the app show actionable guidance
# instead of raw "curl: (56) ..." text, and makes the log self-explanatory.
extract_download_http_status() {
  local stderr_file="$1"
  [ -s "$stderr_file" ] || return 0
  sed -n -E \
    -e 's/.*[Rr]eturned[^0-9]{0,20}([1-5][0-9][0-9]).*/\1/p' \
    -e 's/.*ERROR ([1-5][0-9][0-9]):.*/\1/p' \
    "$stderr_file" | head -n 1
}

build_download_error_message() {
  local download_tool="$1"
  local exit_code="$2"
  local attempt_count="$3"
  local stderr_file="$4"
  local summary=""
  local http_status=""
  local prefix="Failed to download update payload"

  summary="$(summarize_download_stderr "$stderr_file" || true)"
  http_status="$(extract_download_http_status "$stderr_file" || true)"
  if [ "$attempt_count" -gt 1 ]; then
    prefix="${prefix} after ${attempt_count} attempts"
  fi

  if [ -n "$http_status" ]; then
    if [ -n "$summary" ]; then
      printf '%s: HTTP %s (%s)\n' "$prefix" "$http_status" "$summary"
    else
      printf '%s: HTTP %s\n' "$prefix" "$http_status"
    fi
    return 0
  fi

  if [ -n "$summary" ]; then
    printf '%s: %s\n' "$prefix" "$summary"
    return 0
  fi

  if [ -n "$download_tool" ]; then
    printf '%s: %s exited with code %s\n' "$prefix" "$download_tool" "$exit_code"
    return 0
  fi

  printf '%s: downloader exited with code %s\n' "$prefix" "$exit_code"
}

is_retryable_download_exit_code() {
  local download_tool="$1"
  local exit_code="$2"

  case "${download_tool}:${exit_code}" in
    curl:5|curl:6|curl:7|curl:18|curl:28|curl:35|curl:52|curl:55|curl:56|wget:4)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

DOWNLOAD_TOOL=""

run_download_attempt() {
  local current_bytes=0
  local current_percent=0
  local download_pid=""
  local exit_code=0

  DOWNLOAD_TOOL=""
  rm -f "$DOWNLOAD_FILE" "$DOWNLOAD_STDERR"
  : > "$DOWNLOAD_STDERR"
  emit_download_marker "BYTES" "0"
  if [ "${EXPECTED_FILE_SIZE:-0}" -gt 0 ] 2>/dev/null; then
    emit_download_marker "PERCENT" "0"
  fi

  if command -v curl >/dev/null 2>&1; then
    DOWNLOAD_TOOL="curl"
    curl -sS -L -f \
      -H "Cache-Control: no-cache" \
      -H "Pragma: no-cache" \
      -o "$DOWNLOAD_FILE" "$DOWNLOAD_URL" 2>"$DOWNLOAD_STDERR" &
  elif command -v wget >/dev/null 2>&1; then
    DOWNLOAD_TOOL="wget"
    wget -q \
      --header="Cache-Control: no-cache" \
      --header="Pragma: no-cache" \
      -O "$DOWNLOAD_FILE" "$DOWNLOAD_URL" 2>"$DOWNLOAD_STDERR" &
  else
    DOWNLOAD_TOOL="downloader"
    printf '%s\n' "Neither curl nor wget is available" > "$DOWNLOAD_STDERR"
    return 127
  fi
  download_pid=$!

  while kill -0 "$download_pid" 2>/dev/null; do
    current_bytes="$(current_file_size "$DOWNLOAD_FILE")"
    emit_download_marker "BYTES" "$current_bytes"
    if [ "${EXPECTED_FILE_SIZE:-0}" -gt 0 ] 2>/dev/null; then
      current_percent=$((current_bytes * 100 / EXPECTED_FILE_SIZE))
      if [ "$current_percent" -gt 99 ]; then
        current_percent=99
      fi
      emit_download_marker "PERCENT" "$current_percent"
    fi
    sleep 1
  done

  set +e
  wait "$download_pid"
  exit_code=$?
  set -e
  if [ "$exit_code" -ne 0 ]; then
    return "$exit_code"
  fi

  current_bytes="$(current_file_size "$DOWNLOAD_FILE")"
  emit_download_marker "BYTES" "$current_bytes"
  if [ "${EXPECTED_FILE_SIZE:-0}" -gt 0 ] 2>/dev/null; then
    emit_download_marker "PERCENT" "100"
  fi
  return 0
}

download_payload_with_retry() {
  local max_attempts=3
  local attempt=1
  local retry_delay=2
  local exit_code=0
  local error_message=""

  while [ "$attempt" -le "$max_attempts" ]; do
    set +e
    run_download_attempt
    exit_code=$?
    set -e
    if [ "$exit_code" -eq 0 ]; then
      return 0
    fi
    error_message="$(build_download_error_message "$DOWNLOAD_TOOL" "$exit_code" "$attempt" "$DOWNLOAD_STDERR")"

    if [ "$attempt" -ge "$max_attempts" ] || ! is_retryable_download_exit_code "$DOWNLOAD_TOOL" "$exit_code"; then
      emit_error_marker "$error_message"
      printf '%s\n' "$error_message" >&2
      return "$exit_code"
    fi

    printf '%s\n' "Retrying payload download after transient ${DOWNLOAD_TOOL} failure (attempt ${attempt}/${max_attempts}, retry in ${retry_delay}s): ${error_message}" >&1
    sleep "$retry_delay"
    attempt=$((attempt + 1))
    retry_delay=$((retry_delay * 2))
  done

  error_message="$(build_download_error_message "$DOWNLOAD_TOOL" "${exit_code:-1}" "$max_attempts" "$DOWNLOAD_STDERR")"
  emit_error_marker "$error_message"
  printf '%s\n' "$error_message" >&2
  return "${exit_code:-1}"
}

CHECKSUM_ALGO="$(echo "$CHECKSUM_ALGO" | tr '[:upper:]' '[:lower:]')"
CHECKSUM_VALUE="$(echo "$CHECKSUM_VALUE" | tr '[:upper:]' '[:lower:]')"
if [ -z "$LAST_MODIFIED" ]; then
  LAST_MODIFIED="unknown"
fi

case "$CHECKSUM_ALGO" in
  sha256|sha512|sha1|md5)
    ;;
  *)
    echo "Unsupported checksum algorithm: $CHECKSUM_ALGO" >&2
    exit 1
    ;;
esac

PREP_LEDGER_STEP="strand_cleanup"
cleanup_stale_reconcile_strands

PREP_LEDGER_STEP="backup"
echo "[UPDATE_PREP:BACKUP_REQUIRED:false]"
echo "[UPDATE_PREP:STEP:BACKUP:START]"
if [ -d "$MANAGED_DIR" ]; then
  BACKUP_REQUIRED=true
  echo "[UPDATE_PREP:BACKUP_REQUIRED:true]"

  if ! command -v zip >/dev/null 2>&1; then
    echo "zip command not available; cannot prepare update backup safely" >&2
    exit 1
  fi

  BACKUP_TIMESTAMP="$(date +%s)"
  if ! create_slim_backup "$BACKUP_TIMESTAMP"; then
    echo "Failed to create prepared slim backup" >&2
    exit 1
  fi

  BACKUP_SIZE="$(ls -lh "$PREP_FULL_BACKUP_PATH" | awk '{print $5}')"
  echo "[UPDATE_PREP:BACKUP_FILE:${PREP_FULL_BACKUP_PATH}]"
  echo "[UPDATE_PREP:BACKUP_SIZE:${BACKUP_SIZE}]"
fi
echo "[UPDATE_PREP:STEP:BACKUP:COMPLETE]"

PREP_LEDGER_STEP="download"
echo "[UPDATE_PREP:STEP:DOWNLOAD:START]"
if [ "${EXPECTED_FILE_SIZE:-0}" -gt 0 ] 2>/dev/null; then
  emit_download_marker "TOTAL_BYTES" "$EXPECTED_FILE_SIZE"
fi

DOWNLOAD_STDERR="$DOWNLOAD_DIR/download.stderr"
if ! download_payload_with_retry; then
  exit 1
fi

FINAL_BYTES="$(current_file_size "$DOWNLOAD_FILE")"
emit_download_marker "BYTES" "$FINAL_BYTES"
if [ "${EXPECTED_FILE_SIZE:-0}" -gt 0 ] 2>/dev/null; then
  emit_download_marker "PERCENT" "100"
fi
echo "[UPDATE_PREP:STEP:DOWNLOAD:COMPLETE]"

PREP_LEDGER_STEP="verify"
echo "[UPDATE_PREP:STEP:VERIFY:START]"
ACTUAL_CHECKSUM="$(compute_checksum "$CHECKSUM_ALGO" "$DOWNLOAD_FILE" || true)"
if [ -z "$ACTUAL_CHECKSUM" ]; then
  echo "Unable to compute checksum using algorithm: $CHECKSUM_ALGO" >&2
  exit 1
fi

if [ "$ACTUAL_CHECKSUM" != "$CHECKSUM_VALUE" ]; then
  echo "Checksum verification failed for downloaded update payload" >&2
  echo "Expected ($CHECKSUM_ALGO): $CHECKSUM_VALUE" >&2
  echo "Actual   ($CHECKSUM_ALGO): $ACTUAL_CHECKSUM" >&2
  exit 1
fi
echo "[UPDATE_PREP:CHECKSUM_VERIFIED:${CHECKSUM_ALGO}:${ACTUAL_CHECKSUM}]"
echo "[UPDATE_PREP:STEP:VERIFY:COMPLETE]"

PREP_LEDGER_STEP="extract"
echo "[UPDATE_PREP:STEP:EXTRACT:START]"
mkdir -p "$EXTRACT_DIR"
if [ "$(uname -s)" = "Darwin" ]; then
  [ -x /usr/bin/ditto ] \
    || fail_update_prep "/usr/bin/ditto is required to restore signed macOS application metadata"
  if ! /usr/bin/ditto -x -k "$DOWNLOAD_FILE" "$EXTRACT_DIR"; then
    fail_update_prep "Failed to extract the update payload with the macOS system archive tool"
  fi
else
  command -v unzip >/dev/null 2>&1 \
    || fail_update_prep "unzip is required to prepare updates on this platform"
  if ! unzip -q "$DOWNLOAD_FILE" -d "$EXTRACT_DIR"; then
    fail_update_prep "Failed to extract the update payload"
  fi
fi

EXTRACTED_ITEMS_COUNT="$(ls -A "$EXTRACT_DIR" | wc -l | tr -d ' ')"
FIRST_ITEM="$(ls -A "$EXTRACT_DIR" | head -1 || true)"
rm -rf "$PAYLOAD_DIR"
if [ "$EXTRACTED_ITEMS_COUNT" = "1" ] && [ -n "$FIRST_ITEM" ] && [ -d "$EXTRACT_DIR/$FIRST_ITEM" ]; then
  if ! mv "$EXTRACT_DIR/$FIRST_ITEM" "$PAYLOAD_DIR"; then
    fail_update_prep "Failed to finalize the extracted update payload"
  fi
  if ! rmdir "$EXTRACT_DIR"; then
    fail_update_prep "Extract directory was not empty after finalizing the update payload"
  fi
else
  if ! mv "$EXTRACT_DIR" "$PAYLOAD_DIR"; then
    fail_update_prep "Failed to finalize the extracted update payload"
  fi
fi
echo "[UPDATE_PREP:STEP:EXTRACT:COMPLETE]"

RELEASE_MANIFEST_PATH="$PAYLOAD_DIR/release-manifest.json"
if [ ! -f "$RELEASE_MANIFEST_PATH" ]; then
  echo "Prepared payload is missing release-manifest.json. Legacy source payloads are no longer supported for staged installs." >&2
  exit 1
fi

PREP_LEDGER_STEP="build"
echo "[UPDATE_PREP:STEP:BUILD:START]"
echo "Selecting macOS app bundle for native architecture..."

MANAGED_ROOT_NAME="$(json_get_string "$RELEASE_MANIFEST_PATH" "managedRootDir")"
MANAGED_ROOT_NAME="${MANAGED_ROOT_NAME:-managed-root}"
MANAGED_ROOT_DIR="$PAYLOAD_DIR/$MANAGED_ROOT_NAME"
if [ ! -d "$MANAGED_ROOT_DIR" ]; then
  echo "Managed runtime tree not found in payload: $MANAGED_ROOT_DIR" >&2
  exit 1
fi

SELECTED_ARCH="$(native_darwin_arch)"
SELECTED_APP_REL="$(json_get_string "$RELEASE_MANIFEST_PATH" "appBundles.${SELECTED_ARCH}")"
SELECTED_DMG_REL="$(json_get_string "$RELEASE_MANIFEST_PATH" "dmgs.${SELECTED_ARCH}")"

if [ -z "$SELECTED_APP_REL" ] || [ -z "$SELECTED_DMG_REL" ]; then
  echo "Release manifest is missing app or DMG entries for native architecture: $SELECTED_ARCH" >&2
  exit 1
fi

SELECTED_APP_BUNDLE="$PAYLOAD_DIR/$SELECTED_APP_REL"
SELECTED_DMG="$PAYLOAD_DIR/$SELECTED_DMG_REL"

if [ ! -d "$SELECTED_APP_BUNDLE" ]; then
  echo "Selected app bundle not found: $SELECTED_APP_BUNDLE" >&2
  exit 1
fi
if [ ! -f "$SELECTED_DMG" ]; then
  echo "Selected DMG not found: $SELECTED_DMG" >&2
  exit 1
fi
if [ ! -s "$SELECTED_DMG" ]; then
  echo "Selected DMG is empty: $SELECTED_DMG" >&2
  exit 1
fi

echo "[UPDATE_PREP:STEP:SIGNATURE:START]"
PREP_LEDGER_STEP="signature"
if ! verify_macos_artifact_signature "$SELECTED_APP_BUNDLE"; then
  fail_update_prep "${MACOS_ARTIFACT_VERIFICATION_ERROR:-App bundle verification failed}"
fi
echo "[UPDATE_PREP:STEP:SIGNATURE:COMPLETE]"
PREP_LEDGER_STEP="build"

PREP_BUILD_INFO="$MANAGED_ROOT_DIR/electron-app/build-info.json"
if [ ! -f "$PREP_BUILD_INFO" ]; then
  BUILD_NUMBER="$BUILD_IDENTITY"
  BUILD_DATE="$(date +%m%d%Y)"
  mkdir -p "$(dirname "$PREP_BUILD_INFO")"
  cat > "$PREP_BUILD_INFO" <<EOF
{
  "buildNumber": "${BUILD_NUMBER}",
  "fullSha": "${FULL_SHA}",
  "date": "${BUILD_DATE}",
  "channel": "${UPDATE_CHANNEL}",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
}
EOF
fi

echo "Staging managed runtime tree..."
echo "Staging application bundle..."

cat > "$MANIFEST_PATH" <<EOF
{
  "updateKey": "${UPDATE_KEY}",
  "stageDir": "${STAGE_DIR}",
  "sourceDir": "${PAYLOAD_DIR}",
  "managedRootDir": "${MANAGED_ROOT_DIR}",
  "selectedAppBundle": "${SELECTED_APP_BUNDLE}",
  "selectedDmg": "${SELECTED_DMG}",
  "buildInfoPath": "${PREP_BUILD_INFO}",
  "manifestPath": "${MANIFEST_PATH}",
  "releaseManifestPath": "${RELEASE_MANIFEST_PATH}",
  "selectedArch": "${SELECTED_ARCH}",
  "installMode": "applications",
  "backupRequired": ${BACKUP_REQUIRED},
  "fullBackupPath": "${PREP_FULL_BACKUP_PATH}",
  "fullBackupName": "${PREP_FULL_BACKUP_NAME}",
  "checksumAlgorithm": "${CHECKSUM_ALGO}",
  "checksumValue": "${ACTUAL_CHECKSUM}",
  "lastModified": "${LAST_MODIFIED}",
  "preparedAt": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
}
EOF

echo "Prepared payload manifest written"
echo "[UPDATE_PREP:MANIFEST:${MANIFEST_PATH}]"
echo "[UPDATE_PREP:RELEASE_MANIFEST:${RELEASE_MANIFEST_PATH}]"
echo "[UPDATE_PREP:MANAGED_ROOT_DIR:${MANAGED_ROOT_DIR}]"
echo "[UPDATE_PREP:SELECTED_ARCH:${SELECTED_ARCH}]"
echo "[UPDATE_PREP:APP_BUNDLE:${SELECTED_APP_BUNDLE}]"
echo "[UPDATE_PREP:DMG:${SELECTED_DMG}]"
echo "[UPDATE_PREP:BUILD_INFO:${PREP_BUILD_INFO}]"
echo "[UPDATE_PREP:INSTALL_MODE:applications]"
echo "[UPDATE_PREP:STEP:BUILD:COMPLETE]"
PREP_LEDGER_STEP="complete"
