#!/bin/bash

# Wait for the current Electron process to exit, replace the canonical app
# bundle in /Applications with the staged bundle, then relaunch it.

set -euo pipefail

PARENT_PID="${1:-}"
STAGED_APP_BUNDLE="${2:-}"
TARGET_APP_BUNDLE="${3:-/Applications/Portico.app}"
INSTALLED_BUILD_NUMBER="${4:-}"
INSTALLED_BUILD_TIMESTAMP="${5:-}"

if [ -z "$PARENT_PID" ] || [ -z "$STAGED_APP_BUNDLE" ] || [ -z "$TARGET_APP_BUNDLE" ]; then
  echo "Usage: $0 <parent_pid> <staged_app_bundle> <target_app_bundle>" >&2
  exit 1
fi

if [ ! -d "$STAGED_APP_BUNDLE" ]; then
  echo "Staged app bundle not found: $STAGED_APP_BUNDLE" >&2
  exit 1
fi

TARGET_PARENT_DIR="$(dirname "$TARGET_APP_BUNDLE")"
TARGET_APP_NAME="$(basename "$TARGET_APP_BUNDLE")"
TMP_APP_BUNDLE="$TARGET_PARENT_DIR/.${TARGET_APP_NAME}.incoming-$$"
BACKUP_APP_BUNDLE="$TARGET_PARENT_DIR/.${TARGET_APP_NAME}.backup-$$"
PARENT_GRACE_SECONDS="${portico_INSTALL_PARENT_GRACE_SECONDS:-8}"
PARENT_TERM_WAIT_SECONDS="${portico_INSTALL_PARENT_TERM_WAIT_SECONDS:-8}"
PARENT_KILL_WAIT_SECONDS="${portico_INSTALL_PARENT_KILL_WAIT_SECONDS:-5}"

LOG_DIR="$HOME/Library/Application Support/portico/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/update-app-install-$(date +%Y-%m-%d).log"
LOCK_DIR="$HOME/Library/Application Support/portico/update-app-install.lock"
LOCK_PID_FILE="$LOCK_DIR/pid"
LOCK_ACQUIRED=0

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

is_pid_running() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

acquire_install_lock() {
  local owner_pid=""

  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    owner_pid=""
    if [ -f "$LOCK_PID_FILE" ]; then
      owner_pid="$(cat "$LOCK_PID_FILE" 2>/dev/null || true)"
    fi

    if is_pid_running "$owner_pid"; then
      log "Another staged app install is already active with PID $owner_pid; exiting duplicate helper"
      exit 0
    fi

    log "Removing stale staged app installer lock"
    rm -rf "$LOCK_DIR" 2>/dev/null || true
    if [ -d "$LOCK_DIR" ]; then
      log "Failed to remove stale staged app installer lock: $LOCK_DIR"
      exit 1
    fi
  done

  LOCK_ACQUIRED=1
  printf '%s\n' "$$" > "$LOCK_PID_FILE"
}

release_install_lock() {
  if [ "$LOCK_ACQUIRED" -eq 1 ]; then
    rm -rf "$LOCK_DIR" 2>/dev/null || true
    LOCK_ACQUIRED=0
  fi
}

read_json_field() {
  local json_path="$1"
  local field_name="$2"

  if [ ! -f "$json_path" ]; then
    return 1
  fi

  /usr/bin/plutil -extract "$field_name" raw "$json_path" 2>/dev/null || return 1
}

find_stage_manifest() {
  local current_path="$STAGED_APP_BUNDLE"
  local candidate=""

  while [ -n "$current_path" ] && [ "$current_path" != "/" ]; do
    candidate="$current_path/manifest.json"
    if [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
    current_path="$(dirname "$current_path")"
  done

  return 1
}

derive_installed_build_metadata() {
  local build_info_path="$STAGED_APP_BUNDLE/Contents/Resources/build-info.json"
  local stage_manifest=""
  local derived_value=""

  if [ -z "$INSTALLED_BUILD_NUMBER" ]; then
    derived_value="$(read_json_field "$build_info_path" "buildNumber" || true)"
    if [ -n "$derived_value" ] && [ "$derived_value" != "unknown" ]; then
      INSTALLED_BUILD_NUMBER="$derived_value"
      log "Derived installed build number from staged app bundle: $INSTALLED_BUILD_NUMBER"
    fi
  fi

  if [ -z "$INSTALLED_BUILD_TIMESTAMP" ]; then
    stage_manifest="$(find_stage_manifest || true)"
    if [ -n "$stage_manifest" ]; then
      derived_value="$(read_json_field "$stage_manifest" "lastModified" || true)"
      if [ -n "$derived_value" ] && [ "$derived_value" != "unknown" ]; then
        INSTALLED_BUILD_TIMESTAMP="$derived_value"
        log "Derived installed build timestamp from prepared manifest: $INSTALLED_BUILD_TIMESTAMP"
      fi
    fi
  fi

  if [ -z "$INSTALLED_BUILD_TIMESTAMP" ]; then
    derived_value="$(read_json_field "$build_info_path" "timestamp" || true)"
    if [ -n "$derived_value" ] && [ "$derived_value" != "unknown" ]; then
      INSTALLED_BUILD_TIMESTAMP="$derived_value"
      log "Derived installed build timestamp from staged app build-info: $INSTALLED_BUILD_TIMESTAMP"
    fi
  fi
}

persist_installed_build_state() {
  derive_installed_build_metadata

  if [ -z "$INSTALLED_BUILD_NUMBER" ] || [ -z "$INSTALLED_BUILD_TIMESTAMP" ]; then
    log "Installed build metadata unavailable; LAST_INSTALLED_BUILD was not updated"
    return 0
  fi

  local support_dir="$HOME/Library/Application Support/portico"
  local state_path="$support_dir/LAST_INSTALLED_BUILD"
  local temp_path="${state_path}.$$"
  mkdir -p "$support_dir"
  if printf '{\n  "schemaVersion": 1,\n  "buildNumber": "%s",\n  "timestamp": "%s"\n}\n' \
    "$INSTALLED_BUILD_NUMBER" "$INSTALLED_BUILD_TIMESTAMP" > "$temp_path" \
    && mv -f "$temp_path" "$state_path"; then
    log "Persisted installed build state for $INSTALLED_BUILD_NUMBER"
    return 0
  fi

  rm -f "$temp_path"
  log "Failed to persist installed build state for $INSTALLED_BUILD_NUMBER"
  return 0
}

remove_path_best_effort() {
  local target_path="$1"
  if [ ! -e "$target_path" ]; then
    return 0
  fi

  rm -rf "$target_path" 2>/dev/null || true
  if [ -e "$target_path" ]; then
    return 1
  fi

  return 0
}

restore_backup_if_needed() {
  if [ -d "$BACKUP_APP_BUNDLE" ] && [ ! -e "$TARGET_APP_BUNDLE" ]; then
    mv "$BACKUP_APP_BUNDLE" "$TARGET_APP_BUNDLE"
    log "Restored previous application bundle from backup"
  fi
}

on_error() {
  restore_backup_if_needed
}

trap 'on_error' ERR
trap 'release_install_lock' EXIT

wait_for_parent_exit() {
  local wait_seconds="$1"
  local reason="$2"
  local attempt=0

  if ! [[ "$wait_seconds" =~ ^[0-9]+$ ]]; then
    wait_seconds=0
  fi

  while [ "$attempt" -lt "$wait_seconds" ]; do
    if ! is_pid_running "$PARENT_PID"; then
      log "Parent process $PARENT_PID exited during $reason wait"
      return 0
    fi
    sleep 1
    attempt=$((attempt + 1))
  done

  ! is_pid_running "$PARENT_PID"
}

ensure_parent_exited() {
  if wait_for_parent_exit "$PARENT_GRACE_SECONDS" "normal quit"; then
    return 0
  fi

  log "Parent process $PARENT_PID still running after ${PARENT_GRACE_SECONDS}s; sending TERM"
  kill -TERM "$PARENT_PID" 2>/dev/null || true
  if wait_for_parent_exit "$PARENT_TERM_WAIT_SECONDS" "TERM"; then
    return 0
  fi

  log "Parent process $PARENT_PID still running after TERM; sending KILL"
  kill -KILL "$PARENT_PID" 2>/dev/null || true
  if wait_for_parent_exit "$PARENT_KILL_WAIT_SECONDS" "KILL"; then
    return 0
  fi

  log "Parent process $PARENT_PID did not exit after KILL"
  return 1
}

case "$PARENT_PID" in
  ""|*[!0-9]*)
    log "Invalid parent PID: $PARENT_PID"
    exit 1
    ;;
  "0"|"1")
    log "Refusing to manage unsafe parent PID: $PARENT_PID"
    exit 1
    ;;
esac

acquire_install_lock

log "Starting staged app install"
log "Parent PID: $PARENT_PID"
log "Staged app bundle: $STAGED_APP_BUNDLE"
log "Target app bundle: $TARGET_APP_BUNDLE"

if ! ensure_parent_exited; then
  exit 1
fi

mkdir -p "$TARGET_PARENT_DIR"
remove_path_best_effort "$TMP_APP_BUNDLE"
remove_path_best_effort "$BACKUP_APP_BUNDLE"

log "Copying staged app bundle into temporary location"
ditto "$STAGED_APP_BUNDLE" "$TMP_APP_BUNDLE"

if [ -d "$TARGET_APP_BUNDLE" ]; then
  log "Moving existing app bundle to backup"
  mv "$TARGET_APP_BUNDLE" "$BACKUP_APP_BUNDLE"
fi

log "Promoting staged app bundle into /Applications"
mv "$TMP_APP_BUNDLE" "$TARGET_APP_BUNDLE"
remove_path_best_effort "$BACKUP_APP_BUNDLE" || true
persist_installed_build_state

log "Relaunching $TARGET_APP_BUNDLE"
open -n "$TARGET_APP_BUNDLE"
log "Staged app install completed"
