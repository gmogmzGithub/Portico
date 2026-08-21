#!/bin/bash

# Apply a prepared update by syncing the staged managed runtime tree into the
# managed installation. The staged macOS app bundle remains in the preparation
# directory and is installed into /Applications by restart-after-update.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANAGED_RUNTIME_RECONCILE_SH="$SCRIPT_DIR/../../../src/scripts/managed-runtime-reconcile.sh"
MANAGED_RUNTIME_INTEGRITY_SH="$SCRIPT_DIR/../../../src/scripts/managed-runtime-integrity.sh"

if [ ! -f "$MANAGED_RUNTIME_RECONCILE_SH" ]; then
  echo "Managed runtime reconcile helper not found: $MANAGED_RUNTIME_RECONCILE_SH" >&2
  exit 1
fi
if [ ! -f "$MANAGED_RUNTIME_INTEGRITY_SH" ]; then
  echo "Managed runtime integrity helper not found: $MANAGED_RUNTIME_INTEGRITY_SH" >&2
  exit 1
fi
# shellcheck source=/dev/null
. "$MANAGED_RUNTIME_RECONCILE_SH"
# shellcheck source=/dev/null
. "$MANAGED_RUNTIME_INTEGRITY_SH"

MANAGED_DIR=""
PREPARED_MANAGED_ROOT_DIR=""
PREPARED_APP_BUNDLE=""
PREPARED_DMG=""
PREPARED_BUILD_INFO=""
PREPARED_FULL_BACKUP_PATH="none"
UPDATE_KEY="unknown"
MANAGED_APP_DIR=""
PREPARED_RESOURCES_ROOT=""
FULL_BACKUP_RETENTION_COUNT="${FULL_BACKUP_RETENTION_COUNT:-2}"
PRESERVE_FILES=("${MANAGED_RUNTIME_DEFAULT_PRESERVE_PATHS[@]}")
OPEN_WEBUI_CONTAINER_CANDIDATES=("portico-open-webui" "open-webui")
APPLY_CURRENT_STEP="initialization"
APPLY_RESULT="fail"
APPLY_FROM_BUILD="unknown"
APPLY_TO_BUILD="unknown"

# PORTICO-215: free-disk-space preflight. The filter reconcile writes the payload
# directly into the managed tree and never stages preserved user data through
# TMPDIR, so only the payload, incoming backup artifact, and margin consume
# additional destination-volume space.
APPLY_PREFLIGHT_MARGIN_KB="${APPLY_PREFLIGHT_MARGIN_KB:-1048576}" # 1 GiB safety margin

update_apply_existing_ancestor() {
  local candidate="$1"
  while [ -n "$candidate" ] && [ ! -e "$candidate" ] && [ "$candidate" != "/" ]; do
    candidate="$(dirname "$candidate")"
  done
  if [ -z "$candidate" ] || [ ! -e "$candidate" ]; then
    candidate="/"
  fi
  printf '%s\n' "$candidate"
}

# Prints the size of a path in KB, "0" when the path does not exist, or
# nothing when the size cannot be measured (du missing/unusable).
update_apply_du_kb() {
  local target="$1"
  local kb=""
  if ! command -v du >/dev/null 2>&1; then
    return 0
  fi
  if [ ! -e "$target" ] && [ ! -L "$target" ]; then
    printf '0\n'
    return 0
  fi
  kb="$(du -sk "$target" 2>/dev/null | awk 'NR==1 {print $1}' || true)"
  case "$kb" in
    ''|*[!0-9]*) return 0 ;;
  esac
  printf '%s\n' "$kb"
}

# Prints the available KB on the volume holding the nearest existing
# ancestor of a path, or nothing when it cannot be measured.
update_apply_df_free_kb() {
  local target="$1"
  local probe="" free_kb=""
  if ! command -v df >/dev/null 2>&1; then
    return 0
  fi
  probe="$(update_apply_existing_ancestor "$target")"
  free_kb="$(df -Pk "$probe" 2>/dev/null | awk 'NR==2 {print $4}' || true)"
  case "$free_kb" in
    ''|*[!0-9]*) return 0 ;;
  esac
  printf '%s\n' "$free_kb"
}

update_apply_format_gb() {
  local kb="$1"
  awk -v kb="$kb" 'BEGIN { printf "%.1f", kb / 1048576 }'
}

update_apply_report_disk_shortfall() {
  local need_kb="$1"
  local free_kb="$2"
  local shortfall_kb=$((need_kb - free_kb))
  echo "Error: Not enough free disk space to install the update. About $(update_apply_format_gb "$need_kb") GB is needed, but only $(update_apply_format_gb "$free_kb") GB is free — free up at least $(update_apply_format_gb "$shortfall_kb") GB, then reopen Portico. The update will resume automatically." >&2
}

# Usage: preflight_disk_space_for_apply <managed_dir> <payload_dir> \
#          <prepared_full_backup_path|none> <tmp_dir> [preserve_path...]
# The final arguments remain accepted for compatibility with older callers;
# the in-place filter reconcile does not copy preserved paths or use TMPDIR.
# Returns 0 when there is enough space or measurement is unavailable
# (fail-open: a broken preflight must never block updates); returns 1 with a
# single actionable stderr line when free space is insufficient.
preflight_disk_space_for_apply() {
  local managed_dir="$1"
  local payload_dir="$2"
  local backup_zip_path="$3"
  local _tmp_dir="$4"
  shift 4

  local payload_kb="" backup_zip_kb=0 managed_free_kb=""
  local need_kb=0

  : "$_tmp_dir" "$@"

  payload_kb="$(update_apply_du_kb "$payload_dir")"
  if [ -z "$payload_kb" ]; then
    echo "Preflight: skipping free disk space check (df/du unavailable)"
    return 0
  fi

  if [ -n "$backup_zip_path" ] && [ "$backup_zip_path" != "none" ]; then
    backup_zip_kb="$(update_apply_du_kb "$backup_zip_path")"
    if [ -z "$backup_zip_kb" ]; then
      echo "Preflight: skipping free disk space check (df/du unavailable)"
      return 0
    fi
  fi

  managed_free_kb="$(update_apply_df_free_kb "$managed_dir")"
  if [ -z "$managed_free_kb" ]; then
    echo "Preflight: skipping free disk space check (df/du unavailable)"
    return 0
  fi

  need_kb=$((payload_kb + backup_zip_kb + APPLY_PREFLIGHT_MARGIN_KB))
  if [ "$managed_free_kb" -lt "$need_kb" ]; then
    update_apply_report_disk_shortfall "$need_kb" "$managed_free_kb"
    return 1
  fi
  echo "Preflight: disk space OK (need ~$(update_apply_format_gb "$need_kb") GB, $(update_apply_format_gb "$managed_free_kb") GB free)"
  return 0
}

cleanup_stale_reconcile_strands() {
  local tmp_root="${1:-${TMPDIR:-/tmp}}"
  local strand=""
  local removed_count=0
  local failed_count=0

  [ -d "$tmp_root" ] || return 0

  while IFS= read -r strand; do
    if rm -rf -- "$strand"; then
      removed_count=$((removed_count + 1))
    else
      failed_count=$((failed_count + 1))
    fi
  done < <(
    find "$tmp_root" -mindepth 1 -maxdepth 1 -type d -name 'managed-runtime-reconcile.*' -mtime +0 -print 2>/dev/null
  )

  if [ "$removed_count" -gt 0 ]; then
    echo "Removed $removed_count stale managed-runtime reconcile strand(s) from $tmp_root"
  fi
  if [ "$failed_count" -gt 0 ]; then
    echo "Warning: failed to remove $failed_count stale managed-runtime reconcile strand(s) from $tmp_root" >&2
  fi
  return 0
}

# Returns success only for Docker errors that prove a local Unix-socket daemon
# is unavailable. Other failures remain fail-closed so permission, TLS,
# context, and remote-endpoint problems cannot bypass the container guard.
update_apply_docker_daemon_unreachable() {
  local error_text="$1"
  local normalized=""

  normalized="$(printf '%s\n' "$error_text" | tr '[:upper:]' '[:lower:]')"

  case "$normalized" in
    *"permission denied"*|*"tls"*|*"certificate"*|*"timed out"*|*"timeout"*|*"context deadline exceeded"*)
      return 1
      ;;
  esac

  case "$normalized" in
    *"unix://"*) ;;
    *) return 1 ;;
  esac

  case "$normalized" in
    *"connect: no such file or directory"*|*"connect: connection refused"*)
      return 0
      ;;
    *"cannot connect to the docker daemon at unix://"*"is the docker daemon running"*)
      return 0
      ;;
  esac

  return 1
}

ensure_open_webui_stopped() {
  local running_names=""
  local candidate=""
  local running_name=""

  if [ "${APPLY_SKIP_CONTAINER_GUARD:-0}" = "1" ]; then
    echo "Open WebUI container guard skipped by APPLY_SKIP_CONTAINER_GUARD=1"
    return 0
  fi

  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is not installed; continuing apply for host-mode runtime"
    return 0
  fi

  if ! running_names="$(docker ps --format '{{.Names}}' 2>&1)"; then
    if update_apply_docker_daemon_unreachable "$running_names"; then
      printf '%s\n' "$running_names" >&2
      echo "Docker daemon is not running; continuing update apply because no Open WebUI container can be active"
      return 0
    fi
    if [ -n "$running_names" ]; then
      printf '%s\n' "$running_names" >&2
    fi
    echo "Error: Unable to inspect Docker containers. Make sure Docker is running and accessible, then retry the update." >&2
    return 1
  fi

  for candidate in "${OPEN_WEBUI_CONTAINER_CANDIDATES[@]}"; do
    while IFS= read -r running_name; do
      [ "$running_name" = "$candidate" ] || continue
      echo "Stopping Open WebUI container before update apply: $candidate"
      if ! docker stop -t 30 "$candidate"; then
        echo "Error: Failed to stop Open WebUI container '$candidate'. Stop it manually and retry the update." >&2
        return 1
      fi
    done <<< "$running_names"
  done

  return 0
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
  echo "Managed full backup retention: pruned $pruned_count archive(s); kept $kept_count of $total_count"
}

install_prepared_backup_archive() {
  local backup_source="$1"
  local backup_dir="$MANAGED_DIR/backup"
  local backup_name
  local target_backup_path
  local target_suffix
  local target_index=0
  local existing_inode_path=""
  local preinstall_keep_count=0

  mkdir -p "$backup_dir"

  existing_inode_path="$(find_installed_backup_archive_by_inode "$backup_source" "$backup_dir" || true)"
  if [ -n "$existing_inode_path" ]; then
    echo "Prepared backup already installed at $existing_inode_path"
    return 0
  fi

  backup_name="$(basename "$backup_source")"
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

  if ln "$backup_source" "$target_backup_path" 2>/dev/null; then
    echo "Prepared backup linked to $target_backup_path"
    return 0
  fi

  if cp "$backup_source" "$target_backup_path"; then
    echo "Prepared backup copied to $target_backup_path"
    return 0
  fi

  echo "Failed to place prepared backup archive into managed backup directory" >&2
  return 1
}

update_apply_json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  printf '%s' "$value"
}

append_update_apply_ledger() {
  local result="$1"
  local step="$2"
  local ledger_dir="$MANAGED_DIR/health-status"
  local ledger_path="$ledger_dir/update-history.jsonl"
  local ledger_tmp="$ledger_path.tmp.$$"
  local timestamp=""
  local free_disk_kb=""

  [ -n "$MANAGED_DIR" ] || return 0
  mkdir -p "$ledger_dir" 2>/dev/null || return 0

  timestamp="$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date)"
  free_disk_kb="$(update_apply_df_free_kb "$MANAGED_DIR")"
  case "$free_disk_kb" in
    ''|*[!0-9]*) free_disk_kb=0 ;;
  esac

  umask 077
  if [ -f "$ledger_path" ]; then
    if ! tail -n 499 "$ledger_path" > "$ledger_tmp" 2>/dev/null; then
      rm -f "$ledger_tmp"
      return 0
    fi
  else
    : > "$ledger_tmp" || return 0
  fi

  printf '{"ts":"%s","from":"%s","to":"%s","step":"%s","result":"%s","freeDiskKb":%s,"source":"apply-prepared-update","transitionId":"%s"}\n' \
    "$(update_apply_json_escape "$timestamp")" \
    "$(update_apply_json_escape "$APPLY_FROM_BUILD")" \
    "$(update_apply_json_escape "$APPLY_TO_BUILD")" \
    "$(update_apply_json_escape "$step")" \
    "$(update_apply_json_escape "$result")" \
    "$free_disk_kb" \
    "$(update_apply_json_escape "$UPDATE_KEY")" >> "$ledger_tmp" || {
      rm -f "$ledger_tmp"
      return 0
    }

  mv -f "$ledger_tmp" "$ledger_path" 2>/dev/null || rm -f "$ledger_tmp"
  return 0
}

update_apply_on_exit() {
  local exit_status="${1:-1}"
  local result="fail"

  trap - EXIT
  set +e
  if [ "$exit_status" -eq 0 ] && [ "$APPLY_RESULT" = "ok" ]; then
    result="ok"
  fi
  echo "[UPDATE_APPLY:RESULT:$result:$APPLY_CURRENT_STEP]"
  append_update_apply_ledger "$result" "$APPLY_CURRENT_STEP"
}

main() {
  APPLY_CURRENT_STEP="validation"
  APPLY_RESULT="fail"
  MANAGED_DIR="${1:-}"
  PREPARED_MANAGED_ROOT_DIR="${2:-}"
  PREPARED_APP_BUNDLE="${3:-}"
  PREPARED_DMG="${4:-}"
  PREPARED_BUILD_INFO="${5:-}"
  PREPARED_FULL_BACKUP_PATH="${6:-none}"
  UPDATE_KEY="${7:-unknown}"
  MANAGED_APP_DIR="$MANAGED_DIR/electron-app"

  if [ -z "$MANAGED_DIR" ] || [ -z "$PREPARED_MANAGED_ROOT_DIR" ] || [ -z "$PREPARED_APP_BUNDLE" ] || [ -z "$PREPARED_DMG" ] || [ -z "$PREPARED_BUILD_INFO" ]; then
    echo "Usage: $0 <managed_dir> <prepared_managed_root_dir> <prepared_app_bundle> <prepared_dmg> <prepared_build_info> <prepared_full_backup_path|none> [update_key]" >&2
    exit 1
  fi

  APPLY_FROM_BUILD="$(managed_runtime_read_build_number "$MANAGED_DIR" 2>/dev/null || true)"
  APPLY_TO_BUILD="$(managed_runtime_read_build_number "$PREPARED_MANAGED_ROOT_DIR" 2>/dev/null || true)"
  APPLY_FROM_BUILD="${APPLY_FROM_BUILD:-unknown}"
  APPLY_TO_BUILD="${APPLY_TO_BUILD:-$UPDATE_KEY}"

  if [ ! -d "$PREPARED_MANAGED_ROOT_DIR" ]; then
    echo "Prepared managed runtime directory not found: $PREPARED_MANAGED_ROOT_DIR" >&2
    exit 1
  fi

  if [ ! -d "$PREPARED_APP_BUNDLE" ]; then
    echo "Prepared app bundle not found: $PREPARED_APP_BUNDLE" >&2
    exit 1
  fi

  if [ ! -f "$PREPARED_DMG" ]; then
    echo "Prepared DMG not found: $PREPARED_DMG" >&2
    exit 1
  fi

  if [ ! -f "$PREPARED_BUILD_INFO" ]; then
    echo "Prepared build-info.json not found: $PREPARED_BUILD_INFO" >&2
    exit 1
  fi

  if [ "$PREPARED_FULL_BACKUP_PATH" != "none" ] && [ ! -f "$PREPARED_FULL_BACKUP_PATH" ]; then
    echo "Prepared full backup archive not found: $PREPARED_FULL_BACKUP_PATH" >&2
    exit 1
  fi

  echo "Step 1: Validating prepared update..."
  echo "Update key: $UPDATE_KEY"
  echo "Prepared managed runtime tree: $PREPARED_MANAGED_ROOT_DIR"
  echo "Prepared app bundle: $PREPARED_APP_BUNDLE"
  echo "Prepared DMG: $PREPARED_DMG"

  PREPARED_RESOURCES_ROOT="$(managed_runtime_normalize_packaged_resources_root "$PREPARED_APP_BUNDLE" || true)"
  if [ -z "$PREPARED_RESOURCES_ROOT" ]; then
    echo "Prepared app bundle is missing a valid Contents/Resources root: $PREPARED_APP_BUNDLE" >&2
    exit 1
  fi

  echo "Prepared resources root: $PREPARED_RESOURCES_ROOT"

  if [ ! -f "$PREPARED_RESOURCES_ROOT/build-info.json" ]; then
    echo "Prepared app bundle is missing build-info.json: $PREPARED_RESOURCES_ROOT/build-info.json" >&2
    exit 1
  fi

  if ! cmp -s "$PREPARED_RESOURCES_ROOT/build-info.json" "$PREPARED_BUILD_INFO"; then
    echo "Prepared app bundle build-info.json does not match the staged prepared build metadata" >&2
    exit 1
  fi

  managed_runtime_require_packaged_generator_binary "$PREPARED_MANAGED_ROOT_DIR" "$PREPARED_RESOURCES_ROOT" >/dev/null

  managed_runtime_remove_generated_compose_files "$PREPARED_MANAGED_ROOT_DIR"

  APPLY_CURRENT_STEP="strand_cleanup"
  cleanup_stale_reconcile_strands "${TMPDIR:-/tmp}"

  # PORTICO-215: fail up front, before any managed-tree mutation, when the disk
  # cannot hold the payload, incoming backup artifact, and safety margin.
  APPLY_CURRENT_STEP="disk_preflight"
  echo "Preflight: checking free disk space for update apply..."
  preflight_disk_space_for_apply "$MANAGED_DIR" "$PREPARED_MANAGED_ROOT_DIR" "$PREPARED_FULL_BACKUP_PATH" "${TMPDIR:-/tmp}" "${PRESERVE_FILES[@]}"

  APPLY_CURRENT_STEP="container_guard"
  echo "Container guard: ensuring Open WebUI is stopped before update apply..."
  ensure_open_webui_stopped

  APPLY_CURRENT_STEP="backup_install"
  echo "Step 2: Installing prepared backup artifacts..."
  if [ "$PREPARED_FULL_BACKUP_PATH" = "none" ]; then
    echo "No prepared full backup archive provided; skipping backup placement"
  else
    install_prepared_backup_archive "$PREPARED_FULL_BACKUP_PATH"
  fi

  APPLY_CURRENT_STEP="payload_reconcile"
  echo "Step 3: Syncing prepared source payload into managed installation..."
  mkdir -p "$MANAGED_DIR" "$MANAGED_APP_DIR"
  managed_runtime_reconcile_payload "$PREPARED_MANAGED_ROOT_DIR" "$MANAGED_DIR" "${PRESERVE_FILES[@]}"

  APPLY_CURRENT_STEP="artifact_install"
  echo "Step 4: Installing prepared artifacts..."
  cp "$PREPARED_BUILD_INFO" "$MANAGED_APP_DIR/build-info.json"

  APPLY_CURRENT_STEP="compose_regeneration"
  echo "Step 4b: Regenerating runtime compose artifacts..."
  managed_runtime_regenerate_generated_compose "$MANAGED_DIR" "$SCRIPT_DIR" "$PREPARED_RESOURCES_ROOT"
  managed_runtime_validate_generated_compose "$MANAGED_DIR"

  APPLY_CURRENT_STEP="complete"
  APPLY_RESULT="ok"
  echo "Step 5: Prepared update installed to managed runtime tree"
  echo "READY_FOR_RESTART"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  trap 'update_apply_on_exit $?' EXIT
  main "$@"
fi
