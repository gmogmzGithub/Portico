#!/usr/bin/env bash

# migrate-buildkit-gc-policy — one-time OrbStack BuildKit cache migration
# (PORTICO-205 Phase 1).
#
# Dev hosts accumulated a large legacy BuildKit cache because the Docker
# engine has no builder GC policy. This script performs the one-time
# migration: prune the existing build-cache backlog, then write a
# `builder.gc` keep-storage policy into the OrbStack Docker engine config.
#
# IDEMPOTENT BY DESIGN (binding PORTICO-205 requirement): the migration is gated
# on the ABSENCE of a `builder.gc` policy in the engine config. The written
# config is the done-marker — re-runs skip. There is no separate state file,
# so install/update flows can safely invoke this script on every run.
#
# This script touches ONLY the default (docker-driver) builder of the active
# OrbStack Docker engine. It never touches buildx container-driver builders
# (their cache lives in named volumes), containers, images, or volumes.
# The recurring portico-docker-cleanup tool conversely never touches build cache.

set -euo pipefail

CONFIG_DIR="${portico_ORBSTACK_CONFIG_DIR:-$HOME/.orbstack/config}"
CONFIG_FILE="$CONFIG_DIR/docker.json"
BACKUP_FILE="$CONFIG_FILE.portico205.bak"
KEEP_STORAGE_GB="${portico_BUILDKIT_KEEP_STORAGE_GB:-20}"
RESTART_TIMEOUT_SECONDS="${portico_DOCKER_RESTART_TIMEOUT_SECONDS:-60}"
RESTART_POLL_SECONDS="${portico_DOCKER_RESTART_POLL_SECONDS:-2}"
APP_PATHS="${portico_ORBSTACK_APP_PATHS:-/Applications/OrbStack.app:$HOME/Applications/OrbStack.app}"

usage() {
  cat <<'EOF'
Usage: migrate-buildkit-gc-policy.sh [--dry-run] [-h|--help]

One-time OrbStack BuildKit cache migration: prunes the legacy build-cache
backlog of the default Docker builder, then writes a `builder.gc`
keep-storage policy into the OrbStack engine config and restarts the engine.

Idempotent: if the engine config already contains a `builder.gc` policy the
script exits 0 without touching anything — the written config is the
done-marker, so this is safe to run repeatedly (including from install and
update flows).

Safety rules:
  - Only runs when the active Docker context is `orbstack`; never prunes a
    non-OrbStack engine (exit 1 without changes otherwise).
  - Only prunes the default docker-driver builder; buildx container-driver
    builders (named cache volumes) are never touched (verified, fail-closed).
  - The previous engine config is backed up first and restored if the engine
    does not come back healthy after the restart.
  - Never touches containers, images, or volumes.

Options:
  --dry-run   Print every decision without pruning, writing, or restarting.
  -h, --help  Show this help.

Environment:
  portico_BUILDKIT_KEEP_STORAGE_GB       Keep-storage GC budget in GB (default: 20)
  portico_ORBSTACK_CONFIG_DIR            Engine config directory
                                     (default: ~/.orbstack/config)
  portico_ORBSTACK_DATA_IMG              Override OrbStack data image path used
                                     for host-level disk reporting.
  portico_DOCKER_RESTART_TIMEOUT_SECONDS Engine health-wait budget (default: 60)

Exit codes:
  0  migrated, already migrated, or genuinely non-OrbStack host (skipped)
  1  migration failed or unsafe to proceed (nothing left half-done: the
     engine config is restored from backup on failure)
  2  usage error / invalid environment value
EOF
}

DRY_RUN=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! [[ "$KEEP_STORAGE_GB" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid portico_BUILDKIT_KEEP_STORAGE_GB: '$KEEP_STORAGE_GB' (positive integer GB required)" >&2
  exit 2
fi
KEEP_STORAGE="${KEEP_STORAGE_GB}GB"

log() {
  echo "[migrate-buildkit-gc] $*"
}

fail() {
  echo "[migrate-buildkit-gc] ERROR: $*" >&2
  exit 1
}

# Resolve a working python3, bypassing asdf/mise shims (install_v2.sh pattern).
resolve_python3() {
  local candidate
  for candidate in /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
    if [ -x "$candidate" ] && "$candidate" --version >/dev/null 2>&1; then
      echo "$candidate"
      return 0
    fi
  done
  if command -v python3 >/dev/null 2>&1 && python3 --version >/dev/null 2>&1; then
    command -v python3
    return 0
  fi
  return 1
}

# Resolve orbctl from PATH or the OrbStack app bundle (hosts often have the
# app installed without shell PATH integration — prereq-docker-setup.sh
# resolves the same way).
resolve_orbctl() {
  if command -v orbctl >/dev/null 2>&1; then
    command -v orbctl
    return 0
  fi
  if command -v orb >/dev/null 2>&1; then
    command -v orb
    return 0
  fi
  local app_path sub IFS=':'
  for app_path in $APP_PATHS; do
    [ -n "$app_path" ] || continue
    for sub in Contents/MacOS/bin Contents/MacOS/xbin; do
      if [ -x "$app_path/$sub/orbctl" ]; then
        echo "$app_path/$sub/orbctl"
        return 0
      fi
    done
  done
  return 1
}

orbstack_app_bundle_present() {
  local app_path IFS=':'
  for app_path in $APP_PATHS; do
    if [ -n "$app_path" ] && [ -d "$app_path" ]; then
      return 0
    fi
  done
  return 1
}

resolve_orbstack_data_img() {
  if [ -n "${portico_ORBSTACK_DATA_IMG:-}" ]; then
    if [ -f "$portico_ORBSTACK_DATA_IMG" ]; then
      printf '%s\n' "$portico_ORBSTACK_DATA_IMG"
      return 0
    fi
    return 1
  fi
  local match
  for match in "$HOME/Library/Group Containers/"*orbstack*/data/data.img.raw; do
    if [ -f "$match" ]; then
      printf '%s\n' "$match"
      return 0
    fi
  done
  return 1
}

report_host_level_usage() {
  local label="$1"
  local data_img allocated_kib
  if data_img="$(resolve_orbstack_data_img)"; then
    allocated_kib="$(du -k "$data_img" 2>/dev/null | awk '{print $1; exit}' || true)"
    if [ -n "$allocated_kib" ]; then
      log "macOS host-level OrbStack data image ($label): $((allocated_kib / 1024)) MiB allocated"
      return 0
    fi
  fi
  log "macOS host-level OrbStack data image ($label): n/a"
}

wait_for_docker_healthy() {
  local elapsed=0
  while true; do
    if docker info >/dev/null 2>&1; then
      return 0
    fi
    if [ "$elapsed" -ge "$RESTART_TIMEOUT_SECONDS" ]; then
      return 1
    fi
    sleep "$RESTART_POLL_SECONDS"
    elapsed=$((elapsed + RESTART_POLL_SECONDS))
  done
}

restart_docker_engine() {
  local orbctl_bin="$1"
  if "$orbctl_bin" restart docker >/dev/null 2>&1; then
    return 0
  fi
  log "orbctl restart docker failed; falling back to restarting all OrbStack machines"
  "$orbctl_bin" restart -a >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# Gate 1: docker CLI present at all (hook-safe skip otherwise).
# ---------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  log "Docker CLI not found — skipping BuildKit GC migration."
  exit 0
fi

# ---------------------------------------------------------------------------
# Gate 2: OrbStack detection and active-engine verification.
# ---------------------------------------------------------------------------
orbstack_present=false
if [ -d "$CONFIG_DIR" ] || orbstack_app_bundle_present || resolve_orbctl >/dev/null 2>&1; then
  orbstack_present=true
fi

if [ "$orbstack_present" = false ]; then
  log "No OrbStack installation detected — skipping. Configure a builder.gc"
  log "keep-storage policy manually for your Docker engine if desired."
  exit 0
fi

ORBCTL_BIN="$(resolve_orbctl)" \
  || fail "OrbStack appears installed but the orbctl CLI could not be resolved (PATH or app bundle). Not proceeding."

# DOCKER_HOST overrides the active context for real commands (and forces
# `docker context show` to report 'default'), so the context gate below
# cannot vouch for the target engine while it is set. Refuse loudly.
if [ -n "${DOCKER_HOST:-}" ]; then
  fail "DOCKER_HOST is set ('$DOCKER_HOST'); docker commands would bypass the active context, so the orbstack gate cannot verify the target engine. Unset DOCKER_HOST and re-run. Nothing was changed."
fi

active_context="$(docker context show 2>/dev/null || true)"
if [ "$active_context" != "orbstack" ]; then
  fail "Active Docker context is '${active_context:-unknown}', not 'orbstack'. Pruning would target the wrong engine and the OrbStack config would not govern it. Switch context (docker context use orbstack) and re-run. Nothing was changed."
fi

context_host="$(docker context inspect "$active_context" \
  --format '{{ (index .Endpoints "docker").Host }}' 2>/dev/null || true)"
context_host="$(printf '%s\n' "$context_host" | sed -n '1p')"
case "$context_host" in
  unix://*/.orbstack/run/docker.sock)
    ;;
  *)
    fail "Docker context '$active_context' points at '${context_host:-unknown}', not the OrbStack local socket. Pruning would target an engine this migration cannot configure. Nothing was changed."
    ;;
esac

# ---------------------------------------------------------------------------
# Gate 3: idempotency — the written builder.gc policy is the done-marker.
# ---------------------------------------------------------------------------
PYTHON3="$(resolve_python3)" \
  || fail "No working python3 found; cannot safely merge the engine config. Nothing was changed."

marker_state="$(
  "$PYTHON3" - "$CONFIG_FILE" <<'PY' 2>/dev/null
import json, os, sys
path = sys.argv[1]
if not os.path.exists(path) or os.path.getsize(path) == 0:
    print("absent")
    sys.exit(0)
try:
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
except Exception:
    print("malformed")
    sys.exit(0)
if not isinstance(data, dict):
    print("malformed")
elif "builder" in data and not isinstance(data["builder"], dict):
    print("malformed")
elif isinstance(data.get("builder"), dict) and "gc" in data["builder"]:
    # A non-dict gc value is not a usable policy; refuse loudly rather than
    # skipping forever ("present") or clobbering it ("absent").
    print("present" if isinstance(data["builder"]["gc"], dict) else "malformed")
else:
    print("absent")
PY
)" || marker_state="error"

case "$marker_state" in
  present)
    log "builder.gc policy already present in $CONFIG_FILE — migration already done. Nothing to do."
    exit 0
    ;;
  absent)
    ;;
  malformed)
    fail "$CONFIG_FILE exists but is not valid JSON. Refusing to prune or overwrite a config that cannot be parsed. Fix it manually and re-run."
    ;;
  *)
    fail "Could not inspect $CONFIG_FILE. Nothing was changed."
    ;;
esac

# ---------------------------------------------------------------------------
# Builder resolution — only the default docker-driver builder may be pruned.
# ---------------------------------------------------------------------------
target_builder="$active_context"
buildx_available=false
if docker buildx version >/dev/null 2>&1; then
  buildx_available=true
  # The `|| true` keeps a failing `buildx inspect` from aborting the script
  # under `set -euo pipefail` BEFORE the guard below can report it: an empty
  # driver falls through to the fail-closed branch.
  builder_driver="$(docker buildx inspect "$target_builder" 2>/dev/null | awk -F': *' '/^Driver:/ { print $2; exit }' || true)"
  if [ "$builder_driver" != "docker" ]; then
    fail "Builder '$target_builder' reports driver '${builder_driver:-unknown}', expected 'docker'. Refusing to prune (container-driver builder caches live in named volumes and are out of scope). Nothing was changed."
  fi
fi

if [ "$DRY_RUN" = true ]; then
  log "DRY RUN — migration IS needed (no builder.gc policy in $CONFIG_FILE). Would:"
  if [ "$buildx_available" = true ]; then
    log "  1. Prune the default builder's build cache: BUILDX_BUILDER=$target_builder docker builder prune --all --force"
  else
    log "  1. Prune the default builder's build cache: docker builder prune --all --force"
  fi
  log "  2. Back up $CONFIG_FILE (if present) to $BACKUP_FILE"
  log "  3. Merge into $CONFIG_FILE: {\"builder\": {\"gc\": {\"enabled\": true, \"defaultKeepStorage\": \"$KEEP_STORAGE\"}}} (other keys preserved)"
  log "  4. Restart the OrbStack Docker engine and wait for it to come back healthy (${RESTART_TIMEOUT_SECONDS}s budget; config restored from backup on failure)"
  log "No changes were made."
  exit 0
fi

# ---------------------------------------------------------------------------
# Migration step (prune backlog + write policy, then restart + verify).
# ---------------------------------------------------------------------------
log "Migration needed: no builder.gc policy in $CONFIG_FILE."
report_host_level_usage "before"
log "Docker disk usage before:"
docker system df 2>/dev/null || true

log "Pruning the default builder's legacy build cache (one-time)..."
if [ "$buildx_available" = true ]; then
  BUILDX_BUILDER="$target_builder" docker builder prune --all --force \
    || fail "docker builder prune failed. The engine config was NOT modified; re-run after fixing the prune failure."
else
  docker builder prune --all --force \
    || fail "docker builder prune failed. The engine config was NOT modified; re-run after fixing the prune failure."
fi

mkdir -p "$CONFIG_DIR" \
  || fail "Could not create $CONFIG_DIR to write the engine config."

had_original=false
if [ -f "$CONFIG_FILE" ]; then
  had_original=true
  cp -f "$CONFIG_FILE" "$BACKUP_FILE" \
    || fail "Could not back up $CONFIG_FILE; refusing to modify it."
fi

log "Writing builder.gc keep-storage policy ($KEEP_STORAGE) to $CONFIG_FILE..."
if ! "$PYTHON3" - "$CONFIG_FILE" "$KEEP_STORAGE" <<'PY'
import json, os, sys, tempfile
path, keep_storage = sys.argv[1], sys.argv[2]
data = {}
if os.path.exists(path) and os.path.getsize(path) > 0:
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
if not isinstance(data, dict):
    raise SystemExit("engine config is not a JSON object")
builder = data.setdefault("builder", {})
if not isinstance(builder, dict):
    raise SystemExit("'builder' key is not a JSON object")
gc = builder.setdefault("gc", {})
if not isinstance(gc, dict):
    raise SystemExit("'builder.gc' key is not a JSON object")
gc["enabled"] = True
gc["defaultKeepStorage"] = keep_storage
tmp_fd, tmp_path = tempfile.mkstemp(dir=os.path.dirname(path) or ".", prefix=".docker.json.")
try:
    with os.fdopen(tmp_fd, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
        fh.write("\n")
    os.replace(tmp_path, path)
except Exception:
    try:
        os.unlink(tmp_path)
    except OSError:
        pass
    raise
PY
then
  if [ "$had_original" = true ]; then
    cp -f "$BACKUP_FILE" "$CONFIG_FILE" 2>/dev/null || true
  else
    rm -f "$CONFIG_FILE" 2>/dev/null || true
  fi
  fail "Failed to write the merged engine config. Original config restored; nothing else was changed."
fi

log "Restarting the OrbStack Docker engine to apply the GC policy..."
restart_ok=true
if ! restart_docker_engine "$ORBCTL_BIN"; then
  restart_ok=false
fi

if [ "$restart_ok" = true ] && wait_for_docker_healthy; then
  log "Docker engine healthy with builder.gc keep-storage=$KEEP_STORAGE."
  log "Docker disk usage after:"
  docker system df 2>/dev/null || true
  report_host_level_usage "after"
  log "Note: OrbStack compacts its data image asynchronously — host-level usage can lag by minutes."
  rm -f "$BACKUP_FILE" 2>/dev/null || true
  log "Migration complete. Re-runs will now skip (builder.gc present)."
  exit 0
fi

log "Docker engine did not come back healthy — restoring the previous engine config..." >&2
if [ "$had_original" = true ]; then
  cp -f "$BACKUP_FILE" "$CONFIG_FILE" 2>/dev/null || true
  restore_note="The previous config was restored (backup kept at $BACKUP_FILE)."
else
  rm -f "$CONFIG_FILE" 2>/dev/null || true
  restore_note="The newly written config was removed (no config existed before)."
fi
restart_docker_engine "$ORBCTL_BIN" || true
wait_for_docker_healthy || true
fail "Engine restart with the new builder.gc policy failed. $restore_note The build-cache prune already ran; re-running this script after fixing the engine is safe (it will retry the policy write)."
