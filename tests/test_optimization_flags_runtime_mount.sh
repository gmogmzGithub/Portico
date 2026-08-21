#!/usr/bin/env bash
# Regression guard for the optimization_flags.json runtime mount.
#
# Background: optimization_flags.json was historically read by host-side
# shell scripts at compose-generation time AND by middleware.py at
# runtime, but only the host path was actually wired up — the file was
# never mounted into the open-webui container, so every runtime
# _optimization_flag_enabled() call silently fell back to the in-code
# default. The trap surfaced when the per-action confirmation gate
# kill-switch landed: the JSON said "off", the in-code default said
# "on", and the gate stayed on.
#
# This static test pins three invariants so the trap can't recur:
#   1. ``optimization_flags.json`` exists at the project root and is
#      valid JSON.
#   2. ``docker-compose.yml`` bind-mounts it into the open-webui
#      container at ``/app/optimization_flags.json`` (read-only).
#   3. ``middleware.py``'s path resolver checks that mount path.
#   4. ``middleware.py`` logs a one-shot warning when the file is
#      missing, so operators can spot a broken mount instead of
#      chasing silent-default bugs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

FLAGS_FILE="$PROJECT_ROOT/optimization_flags.json"
COMPOSE_FILE="$PROJECT_ROOT/docker-compose.yml"
DEV_COMPOSE_FILE="$PROJECT_ROOT/dev/docker-compose.dev.yml"
MIDDLEWARE_FILE="$PROJECT_ROOT/src/patches/backend/open_webui/utils/middleware.py"
PACKAGE_SCRIPT="$PROJECT_ROOT/package_for_release.sh"
RECONCILE_SCRIPT="$PROJECT_ROOT/src/scripts/managed-runtime-reconcile.sh"

fail() {
    echo "FAIL: $1" >&2
    exit 1
}

# 1. File exists and is valid JSON.
[ -f "$FLAGS_FILE" ] || fail "optimization_flags.json is missing at $FLAGS_FILE"
python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$FLAGS_FILE" \
    >/dev/null 2>&1 \
    || fail "optimization_flags.json is not valid JSON"

# 2. docker-compose.yml mounts it into the open-webui container at the
#    runtime path the middleware path resolver checks first
#    (see _optimization_flags_path() in middleware.py).
grep -Fq "./optimization_flags.json:/app/optimization_flags.json:ro" \
    "$COMPOSE_FILE" \
    || fail "docker-compose.yml is missing the optimization_flags.json mount"
grep -Fq "./optimization_flags.json:/app/optimization_flags.json:ro" \
    "$DEV_COMPOSE_FILE" \
    || fail "dev/docker-compose.dev.yml is missing the optimization_flags.json mount"

# 3. middleware.py's path resolver still references the canonical
#    in-container path. If somebody renames or moves the mount target,
#    this fires before the silent-defaults trap re-opens.
grep -Fq '/app/optimization_flags.json' "$MIDDLEWARE_FILE" \
    || fail "middleware.py path resolver no longer references /app/optimization_flags.json"

# 4. The missing-file warning path exists so a broken mount is loud.
grep -Fq "_OPTIMIZATION_FLAGS_MISSING_WARNED" "$MIDDLEWARE_FILE" \
    || fail "middleware.py missing-file warning guard is gone"
grep -Fq "optimization_flags.json not found" "$MIDDLEWARE_FILE" \
    || fail "middleware.py missing-file warning message is gone"

# 5. The cloudsmith release packager bundles the flag file into
#    managed-root. Without this, neither a DMG reinstall nor a
#    cloudsmith update can deliver a flag flip to existing users:
#    the file would never appear in ~/portico/portico-managed/
#    and the open-webui mount would have nothing to bind. (Same
#    silent-defaults trap as the missing runtime mount, one layer up.)
grep -Fq '"optimization_flags.json"' "$PACKAGE_SCRIPT" \
    || fail "package_for_release.sh include_files no longer ships optimization_flags.json"

# 6. The managed-runtime preserve list MUST NOT contain
#    optimization_flags.json — if it did, updates would skip it and
#    keep the user's stale copy, defeating the point of shipping a
#    flag flip via cloudsmith.
if grep -E '^\s*"optimization_flags\.json"' "$RECONCILE_SCRIPT" >/dev/null; then
    fail "managed-runtime-reconcile.sh preserve list contains optimization_flags.json — updates would not overwrite the user's copy"
fi

echo "PASS: optimization_flags.json runtime mount invariants"
