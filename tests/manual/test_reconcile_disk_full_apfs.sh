#!/usr/bin/env bash

# Manual macOS-only ENOSPC harness. It uses a disposable APFS sparse image so
# failures cannot consume or mutate the developer's real managed runtime.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RECONCILE_SH="${RECONCILE_SH:-$PROJECT_ROOT/src/scripts/managed-runtime-reconcile.sh}"
HARNESS_MODE="${HARNESS_MODE:-safe}"
IMAGE_SIZE_GB="${IMAGE_SIZE_GB:-2}"
DB_SIZE_MB="${DB_SIZE_MB:-300}"
PAYLOAD_SIZE_MB="${PAYLOAD_SIZE_MB:-384}"
FREE_SPACE_TARGET_MB="${FREE_SPACE_TARGET_MB:-192}"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

for command in hdiutil rsync shasum diff dd df; do
  command -v "$command" >/dev/null 2>&1 \
    || fail "required command is unavailable: $command"
done
REAL_RSYNC_BIN="$(command -v rsync)"

[ "$(uname -s)" = "Darwin" ] || fail "this harness requires macOS/APFS"
[ -f "$RECONCILE_SH" ] || fail "reconcile script not found: $RECONCILE_SH"
case "$HARNESS_MODE" in
  safe|legacy|measure) ;;
  *) fail "HARNESS_MODE must be safe, legacy, or measure" ;;
esac
case "$IMAGE_SIZE_GB" in
  ''|*[!0-9]*|0) fail "IMAGE_SIZE_GB must be a positive integer" ;;
esac

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/portico-reconcile-apfs.XXXXXX")"
IMAGE_BASE="$WORK_DIR/reconcile-harness"
IMAGE_PATH="$IMAGE_BASE.sparseimage"
MOUNT_POINT="$WORK_DIR/volume"
PAYLOAD_DIR="$WORK_DIR/payload"
SNAPSHOT_DIR="$WORK_DIR/preserved-before"
ATTACHED_DEVICE=""
RSYNC_COUNTER_FILE="$WORK_DIR/rsync-transferred-bytes.log"

# Record the logical bytes each reconcile rsync reports as transferred. This
# counts repeated staging/copy passes even when the APFS net-used delta later
# falls because a historical reconciler deleted data. It is a deterministic
# disk-churn proxy, not a claim about physical NAND writes.
rsync() {
  local output=""
  local status=0
  local transferred_bytes="0"

  if output="$(LC_ALL=C "$REAL_RSYNC_BIN" --stats "$@" 2>&1)"; then
    status=0
  else
    status=$?
  fi
  printf '%s\n' "$output"
  transferred_bytes="$(
    printf '%s\n' "$output" \
      | awk -F': ' '/^Total transferred file size:/ { value=$2; gsub(/[^0-9]/, "", value); print value; exit }'
  )"
  case "$transferred_bytes" in
    ''|*[!0-9]*) transferred_bytes=0 ;;
  esac
  printf '%s\n' "$transferred_bytes" >> "$RSYNC_COUNTER_FILE"
  return "$status"
}

cleanup() {
  if [ -n "$ATTACHED_DEVICE" ]; then
    hdiutil detach "$ATTACHED_DEVICE" -force >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT INT TERM

mkdir -p "$MOUNT_POINT" "$PAYLOAD_DIR" "$SNAPSHOT_DIR"
: > "$RSYNC_COUNTER_FILE"
hdiutil create \
  -size "${IMAGE_SIZE_GB}g" \
  -fs APFS \
  -type SPARSE \
  -volname porticoReconcileHarness \
  "$IMAGE_BASE" >/dev/null
hdiutil attach -nobrowse -mountpoint "$MOUNT_POINT" "$IMAGE_PATH" >/dev/null
ATTACHED_DEVICE="$(df "$MOUNT_POINT" | awk 'END { print $1 }')"

MANAGED_DIR="$MOUNT_POINT/managed"
HARNESS_TMPDIR="$MOUNT_POINT/tmp"
mkdir -p \
  "$MANAGED_DIR/open-webui-data" \
  "$MANAGED_DIR/workspaces/demo" \
  "$MANAGED_DIR/backup" \
  "$HARNESS_TMPDIR"

dd if=/dev/urandom \
  of="$MANAGED_DIR/open-webui-data/webui.db" \
  bs=1m count="$DB_SIZE_MB" 2>/dev/null
printf 'workspace sentinel\n' >"$MANAGED_DIR/workspaces/demo/state.txt"
printf 'backup sentinel\n' >"$MANAGED_DIR/backup/keep.txt"
printf 'USER_SETTING=preserve-me\n' >"$MANAGED_DIR/.env"

cp -a "$MANAGED_DIR/open-webui-data" "$SNAPSHOT_DIR/"
cp -a "$MANAGED_DIR/workspaces" "$SNAPSHOT_DIR/"
cp -a "$MANAGED_DIR/backup" "$SNAPSHOT_DIR/"
cp -a "$MANAGED_DIR/.env" "$SNAPSHOT_DIR/.env"
DB_CHECKSUM_BEFORE="$(shasum -a 256 "$MANAGED_DIR/open-webui-data/webui.db" | awk '{ print $1 }')"

mkdir -p "$PAYLOAD_DIR/open-webui-data"
printf 'payload must not replace this database\n' \
  >"$PAYLOAD_DIR/open-webui-data/webui.db"
printf 'new application file\n' >"$PAYLOAD_DIR/build-info.json"
dd if=/dev/zero \
  of="$PAYLOAD_DIR/app-owned-large.bin" \
  bs=1m count="$PAYLOAD_SIZE_MB" 2>/dev/null

FREE_MB="$(df -k "$MOUNT_POINT" | awk 'END { print int($4 / 1024) }')"
FILL_MB=$(( FREE_MB - FREE_SPACE_TARGET_MB ))
[ "$FILL_MB" -gt 0 ] \
  || fail "sparse image has only ${FREE_MB} MB free before filler creation"
dd if=/dev/zero \
  of="$MOUNT_POINT/disk-pressure.bin" \
  bs=1m count="$FILL_MB" 2>/dev/null

USED_KB_BEFORE="$(df -k "$MOUNT_POINT" | awk 'END { print $3 }')"
set +e
(
  export TMPDIR="$HARNESS_TMPDIR"
  # shellcheck disable=SC1090
  source "$RECONCILE_SH"
  managed_runtime_reconcile_payload "$PAYLOAD_DIR" "$MANAGED_DIR"
)
RECONCILE_STATUS=$?
set -e
USED_KB_AFTER="$(df -k "$MOUNT_POINT" | awk 'END { print $3 }')"
WRITTEN_KB=$(( USED_KB_AFTER - USED_KB_BEFORE ))
LOGICAL_RSYNC_TRANSFERRED_BYTES="$(
  awk '{ total += $1 } END { printf "%.0f", total + 0 }' "$RSYNC_COUNTER_FILE"
)"
if [ -f "$MANAGED_DIR/open-webui-data/webui.db" ]; then
  DB_CHECKSUM_AFTER="$(shasum -a 256 "$MANAGED_DIR/open-webui-data/webui.db" | awk '{ print $1 }')"
else
  DB_CHECKSUM_AFTER="missing"
fi

PRESERVED_IDENTICAL=true
diff -r "$SNAPSHOT_DIR/open-webui-data" "$MANAGED_DIR/open-webui-data" >/dev/null \
  || PRESERVED_IDENTICAL=false
diff -r "$SNAPSHOT_DIR/workspaces" "$MANAGED_DIR/workspaces" >/dev/null \
  || PRESERVED_IDENTICAL=false
diff -r "$SNAPSHOT_DIR/backup" "$MANAGED_DIR/backup" >/dev/null \
  || PRESERVED_IDENTICAL=false
diff "$SNAPSHOT_DIR/.env" "$MANAGED_DIR/.env" >/dev/null \
  || PRESERVED_IDENTICAL=false

STRAND_COUNT="$(
  find "$HARNESS_TMPDIR" -maxdepth 1 -type d \
    -name 'managed-runtime-reconcile.*' -print | wc -l | tr -d ' '
)"

printf 'reconcile_status=%s\n' "$RECONCILE_STATUS"
printf 'preserved_identical=%s\n' "$PRESERVED_IDENTICAL"
printf 'db_checksum_unchanged=%s\n' \
  "$([ "$DB_CHECKSUM_BEFORE" = "$DB_CHECKSUM_AFTER" ] && printf true || printf false)"
printf 'strand_count=%s\n' "$STRAND_COUNT"
printf 'net_volume_usage_delta_kb=%s\n' "$WRITTEN_KB"
printf 'logical_rsync_transferred_bytes=%s\n' "$LOGICAL_RSYNC_TRANSFERRED_BYTES"
printf 'payload_size_kb=%s\n' "$(du -sk "$PAYLOAD_DIR" | awk '{ print $1 }')"

if [ "$HARNESS_MODE" = "legacy" ]; then
  printf 'Legacy comparison mode is observational; inspect the results above.\n'
  exit 0
fi

if [ "$HARNESS_MODE" = "measure" ]; then
  [ "$RECONCILE_STATUS" -eq 0 ] \
    || fail "measurement reconcile failed despite ample free space"
  [ "$PRESERVED_IDENTICAL" = true ] \
    || fail "measurement reconcile changed one or more preserved paths"
  [ "$DB_CHECKSUM_BEFORE" = "$DB_CHECKSUM_AFTER" ] \
    || fail "measurement reconcile changed the webui.db checksum"
  [ "$STRAND_COUNT" -eq 0 ] \
    || fail "measurement reconcile left temporary strand directories behind"
  printf 'PASS: ample-space cycle completed; compare logical rsync bytes across implementations.\n'
  exit 0
fi

[ "$RECONCILE_STATUS" -ne 0 ] \
  || fail "safe reconcile reported success despite ENOSPC"
[ "$PRESERVED_IDENTICAL" = true ] \
  || fail "one or more preserved paths changed after failed reconcile"
[ "$DB_CHECKSUM_BEFORE" = "$DB_CHECKSUM_AFTER" ] \
  || fail "webui.db checksum changed after failed reconcile"
[ "$STRAND_COUNT" -eq 0 ] \
  || fail "reconcile left temporary strand directories behind"

printf 'PASS: ENOSPC was propagated and every preserved path remained intact.\n'
