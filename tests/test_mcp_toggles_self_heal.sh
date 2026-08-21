#!/usr/bin/env bash

# PORTICO-364: a blank / 0-byte mcp_toggles.json (left by an interrupted non-atomic
# create) dead-ended every MCP toggle mutation and was never re-healed. The
# volume-file ensurers must (a) create/re-write required JSON atomically so an
# interrupted create can never leave a 0-byte file, and (b) re-initialize an
# existing blank/whitespace-only JSON file to a valid empty object.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

fail() { echo "FAIL: $1" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- docker-compose.sh helpers -------------------------------------------------
(
  export SKIP_MAIN_EXECUTION=1
  # shellcheck source=/dev/null
  source "$PROJECT_ROOT/src/scripts/docker-compose.sh" >/dev/null 2>&1

  write_empty_json_object_atomic "$TMP/dc.json"
  [ "$(cat "$TMP/dc.json")" = "{}" ] || fail "docker-compose write_empty_json_object_atomic did not write {}"

  printf '' > "$TMP/blank.json"
  json_file_is_blank "$TMP/blank.json" || fail "0-byte file should be blank"
  printf '  \n\t' > "$TMP/ws.json"
  json_file_is_blank "$TMP/ws.json" || fail "whitespace-only file should be blank"
  printf '{}\n' > "$TMP/ok.json"
  ! json_file_is_blank "$TMP/ok.json" || fail "valid {} must not be considered blank"
) || exit 1

# --- managed-runtime-integrity.sh helpers -------------------------------------
(
  # shellcheck source=/dev/null
  source "$PROJECT_ROOT/src/scripts/managed-runtime-integrity.sh" >/dev/null 2>&1

  printf '' > "$TMP/mri-blank.json"
  managed_runtime_json_file_is_blank "$TMP/mri-blank.json" \
    || fail "managed-runtime: 0-byte file should be blank"

  managed_runtime_write_required_volume_file "mcp_toggles.json" "$TMP/mri.json"
  [ "$(cat "$TMP/mri.json")" = "{}" ] \
    || fail "managed-runtime write_required_volume_file did not write {} for *.json"
) || exit 1

# --- wiring: the ensurers re-heal an existing blank JSON, atomically ----------
grep -q 'json_file_is_blank "\$filepath"' "$PROJECT_ROOT/src/scripts/docker-compose.sh" \
  || fail "ensure_volume_files must re-heal an existing blank JSON file"
grep -q 'write_empty_json_object_atomic "\$filepath"' "$PROJECT_ROOT/src/scripts/docker-compose.sh" \
  || fail "ensure_volume_files must write JSON atomically"
grep -q 'managed_runtime_json_file_is_blank "\$target_path"' "$PROJECT_ROOT/src/scripts/managed-runtime-integrity.sh" \
  || fail "managed_runtime_ensure_required_volume_files must re-heal an existing blank JSON file"
grep -q 'mv -f "\$_mcp_toggles_tmp" "\$project_root/mcp_toggles.json"' "$PROJECT_ROOT/src/scripts/mcp-orc-cli.sh" \
  || fail "mcp-orc-cli.sh must create mcp_toggles.json atomically"

echo "PASS: mcp_toggles.json blank-file self-heal (PORTICO-364)"
