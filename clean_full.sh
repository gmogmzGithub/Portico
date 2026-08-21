#!/bin/bash

# Full Environment Cleanup Script
# Resets Portico to a completely fresh state:
#   1. Kills running Electron app
#   2. Stops Docker containers and removes volumes
#   3. Removes Docker images (local builds + Harbor pulls)
#   4. Clears Electron app data, Chromium cache, webview partition cache,
#      and the runtime-secret cache dir that backs /run/secrets/* bind-mounts
#   5. Removes all PORTICO-owned macOS Keychain passwords, safeStorage keys,
#      and legacy localhost OAuth certificates
#   6. Removes project-level generated configs (MCP, OAuth,
#      runtime-secrets.env, legacy runtime-secret-files/, etc.)
#      while preserving the protected repository .env operator handoff
#   7. Clears Open WebUI data (open-webui-data/)
#   8. Removes managed instance directory
#   9. Cleans all gitignored build artifacts (node_modules, dist, .venv, __pycache__, etc.)
#      Preserves: .idea/, clean_full.sh
#   10. Restarts OrbStack ONLY if portico Docker state was actually
#       cleaned up (so repeated/idempotent runs don't disrupt unrelated work).
#
# Usage:
#   ./clean_full.sh              # interactive mode (prompts for confirmation)
#   ./clean_full.sh --yes        # skip confirmation prompt
#   ./clean_full.sh --dry-run    # show what would be removed without doing it
#   ./clean_full.sh --yes --keep-keychain
#                                # clean disk/Docker state, preserve Keychain residue

set -e

# ── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
DIM='\033[2m'
NC='\033[0m'

# ── Config ───────────────────────────────────────────────────────────────────
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
MANAGED_DIR="$HOME/portico/portico-managed"
ELECTRON_APP_SUPPORT="$HOME/Library/Application Support/portico"
ELECTRON_CACHE="$HOME/Library/Caches/portico"
# Runtime-secret cache dir that backs Docker Compose `secrets:` bind-mounts
# (see src/scripts/docker-compose.sh::_default_runtime_secret_cache_dir).
RUNTIME_SECRET_CACHE_DIRS=(
  "$HOME/Library/Caches/portico/runtime-secrets"
  "${XDG_STATE_HOME:-$HOME/.local/state}/portico/runtime-secrets"
)
if [ -n "${PORTICO_RUNTIME_SECRET_CACHE_DIR:-}" ]; then
  RUNTIME_SECRET_CACHE_DIRS+=("$PORTICO_RUNTIME_SECRET_CACHE_DIR")
fi

# Per-user OAuth access-token ingress cache (see
# src/mcp-orc-rust/crates/mcp-orc/src/session.rs::oauth_token_cache_dir).
# Populated only when an http_subprocess server is configured with
# `oauth_access_token_file_env`; HttpSubprocessSession::close() / Drop
# already wipes files on normal shutdown, but a crashed Electron shell may
# leave 0600 token files behind. Clean them up defensively.
OAUTH_TOKEN_CACHE_DIRS=(
  "$HOME/Library/Caches/portico/oauth-tokens"
  "${XDG_STATE_HOME:-$HOME/.local/state}/portico/oauth-tokens"
)
if [ -n "${PORTICO_OAUTH_TOKEN_CACHE_DIR:-}" ]; then
  OAUTH_TOKEN_CACHE_DIRS+=("$PORTICO_OAUTH_TOKEN_CACHE_DIR")
fi
if [ -n "${PORTICO_RUNTIME_SECRET_CACHE_DIR:-}" ]; then
  OAUTH_TOKEN_CACHE_DIRS+=("$PORTICO_RUNTIME_SECRET_CACHE_DIR/oauth-tokens")
fi

AUTO_YES=false
DRY_RUN=false
KEEP_KEYCHAIN=false

# Set to true whenever we touch any portico-related Docker state
# (containers, images, networks, or stale port listeners on project ports).
# The final OrbStack restart is gated on this flag so no-op cleanup runs
# don't disturb unrelated Docker/OrbStack workloads.
TOUCHED_PORTICO_DOCKER_STATE=false

for arg in "$@"; do
  case "$arg" in
    --yes|-y) AUTO_YES=true ;;
    --dry-run|-n) DRY_RUN=true ;;
    --keep-keychain) KEEP_KEYCHAIN=true ;;
  esac
done

cd "$SCRIPT_DIR"

KEYCHAIN_CLEANUP_HELPER="$SCRIPT_DIR/src/scripts/cleanup-portico-keychain.sh"
if [ ! -f "$KEYCHAIN_CLEANUP_HELPER" ]; then
  echo -e "${RED}Missing Keychain cleanup helper: $KEYCHAIN_CLEANUP_HELPER${NC}" >&2
  exit 1
fi
# shellcheck source=src/scripts/cleanup-portico-keychain.sh
source "$KEYCHAIN_CLEANUP_HELPER"

# Ensure docker CLI is on PATH (OrbStack, Homebrew, system locations)
export PATH="$HOME/.orbstack/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# ── Helpers ──────────────────────────────────────────────────────────────────
step()    { echo -e "\n${BLUE}[$1/$TOTAL_STEPS]${NC} $2"; }
ok()      { echo -e "  ${GREEN}✓${NC} $1"; }
skip()    { echo -e "  ${YELLOW}⏭${NC}  $1"; }
warn()    { echo -e "  ${YELLOW}⚠${NC}  $1"; }
fail()    { echo -e "  ${RED}✗${NC} $1"; }

run_or_dry() {
  if $DRY_RUN; then
    echo -e "  ${DIM}[dry-run] $1${NC}"
  else
    eval "$1"
  fi
}

get_ancestor_pids() {
  local current_pid="$$"
  local parent_pid="$PPID"
  local seen=""

  while true; do
    if [[ -n "$current_pid" && "$current_pid" =~ ^[0-9]+$ ]]; then
      seen="${seen}${current_pid}\n"
    fi
    if [[ -n "$parent_pid" && "$parent_pid" =~ ^[0-9]+$ ]]; then
      seen="${seen}${parent_pid}\n"
    fi

    if [[ -z "$parent_pid" || ! "$parent_pid" =~ ^[0-9]+$ || "$parent_pid" -le 1 ]]; then
      break
    fi

    current_pid="$parent_pid"
    parent_pid=$(ps -o ppid= -p "$current_pid" 2>/dev/null | tr -d ' ' || true)
    if [[ -z "$parent_pid" || "$parent_pid" -le 1 ]]; then
      [[ -n "$parent_pid" && "$parent_pid" =~ ^[0-9]+$ ]] && seen="${seen}${parent_pid}\n"
      break
    fi
  done

  printf "%b" "$seen" | grep -E '^[0-9]+$' | sort -u
}

is_ancestor_pid() {
  local pid="$1"
  local ancestors="$2"
  printf "%s\n" "$ancestors" | grep -Fx "$pid" >/dev/null 2>&1
}

is_portico_command() {
  local cmd="$1"
  case "$cmd" in
    *"/Portico.app/Contents/MacOS/Portico"*)
      return 0
      ;;
    *"/Portico.app/Contents/Frameworks/Portico Helper"*)
      return 0
      ;;
    *"Portico Helper ("*)
      return 0
      ;;
    *"$SCRIPT_DIR"/electron-app/src/services/main.js*)
      return 0
      ;;
    *"$SCRIPT_DIR"/electron-app/node_modules/.bin/electron" "*)
      return 0
      ;;
    *"$SCRIPT_DIR"/electron-app/node_modules/.bin/electron)
      return 0
      ;;
    *"$SCRIPT_DIR"/electron-app/node_modules/electron/*)
      return 0
      ;;
    *"$SCRIPT_DIR"/node_modules/electron/*)
      return 0
      ;;
    *"--user-data-dir=$ELECTRON_APP_SUPPORT"*)
      return 0
      ;;
    *"--app-path=$SCRIPT_DIR/electron-app"*)
      return 0
      ;;
    *"--app-path=$SCRIPT_DIR"*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

collect_portico_pids() {
  local ancestors
  local pid
  local cmd

  ancestors="$(get_ancestor_pids)"

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    read -r pid cmd <<<"$line"
    [[ -z "$pid" || -z "$cmd" ]] && continue

    if is_ancestor_pid "$pid" "$ancestors"; then
      continue
    fi

    if is_portico_command "$cmd"; then
      echo "$pid"
    fi
  done < <(ps -axo pid=,command=)
}

kill_pid_list() {
  local signal="$1"
  shift

  local pid
  for pid in "$@"; do
    [[ -z "$pid" ]] && continue
    kill "-$signal" "$pid" 2>/dev/null || true
  done
}

kill_pid_list_or_dry() {
  local signal="$1"
  shift

  if [ "$#" -eq 0 ]; then
    return
  fi

  if $DRY_RUN; then
    echo -e "  ${DIM}[dry-run] kill -$signal $*${NC}"
  else
    kill_pid_list "$signal" "$@"
  fi
}

TOTAL_STEPS=9

# ── Banner ───────────────────────────────────────────────────────────────────
echo -e "${BLUE}══════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Portico — Full Environment Cleanup${NC}"
echo -e "${BLUE}══════════════════════════════════════════════${NC}"
$DRY_RUN && echo -e "${YELLOW}  (DRY RUN — nothing will be modified)${NC}"
if $KEEP_KEYCHAIN; then
  echo -e "${YELLOW}  (DELIBERATELY DIRTY — Keychain entries and certificates are preserved)${NC}"
fi
echo ""
echo -e "${YELLOW}This will remove:${NC}"
echo "  - Running Electron app processes"
echo "  - All Docker containers, volumes, and images for this project"
echo "  - Electron app data & Chromium cache"
echo "  - Runtime-secret cache dir that backs /run/secrets/* bind-mounts"
if ! $KEEP_KEYCHAIN; then
  echo "  - All PORTICO-owned macOS Keychain passwords, safeStorage keys, and localhost OAuth certificates"
else
  echo "  - PORTICO Keychain entries and localhost OAuth certificates will be retained"
fi
echo "  - Slack OAuth setup debug log + persisted Slack OAuth tokens"
echo "  - Project-level generated configs (MCP, OAuth, etc.)"
echo "  - Repository .env is protected and will be preserved"
echo "  - Project-root runtime-secrets.env and legacy runtime-secret-files/"
echo "    (tracked cloudsmith.env is preserved)"
echo "  - Managed instance directory ($MANAGED_DIR)"
echo "  - All gitignored build artifacts (node_modules, dist, .venv, __pycache__)"
echo "  - Open WebUI data (open-webui-data/)"
echo "  - Restart OrbStack only if portico Docker state was cleaned"
echo ""

if ! $AUTO_YES && ! $DRY_RUN; then
  echo -e "${YELLOW}This action cannot be undone!${NC}"
  read -p "Continue? (yes/no): " -r
  echo ""
  if [[ ! $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
    echo -e "${RED}Cleanup cancelled.${NC}"
    exit 0
  fi
fi

# ── Step 1: Kill Electron app ───────────────────────────────────────────────
step 1 "Killing Electron app..."

KILLED=false
APP_PIDS=()
# macOS ships Bash 3.x, which does not provide mapfile/readarray.
while IFS= read -r pid; do
  [[ -n "$pid" ]] && APP_PIDS+=("$pid")
done < <(collect_portico_pids | sort -u)

if [ "${#APP_PIDS[@]}" -gt 0 ]; then
  kill_pid_list_or_dry TERM "${APP_PIDS[@]}"
  KILLED=true
fi

if $KILLED; then
  $DRY_RUN || sleep 2

  # Force-kill only explicit Portico app processes that remain after TERM.
  REMAINING_APP_PIDS=()
  while IFS= read -r pid; do
    [[ -n "$pid" ]] && REMAINING_APP_PIDS+=("$pid")
  done < <(collect_portico_pids | sort -u)
  if [ "${#REMAINING_APP_PIDS[@]}" -gt 0 ]; then
    kill_pid_list_or_dry KILL "${REMAINING_APP_PIDS[@]}"
    $DRY_RUN || sleep 1
  fi

  if ! $DRY_RUN; then
    FINAL_REMAINING_APP_PIDS=()
    while IFS= read -r pid; do
      [[ -n "$pid" ]] && FINAL_REMAINING_APP_PIDS+=("$pid")
    done < <(collect_portico_pids | sort -u)
    if [ "${#FINAL_REMAINING_APP_PIDS[@]}" -gt 0 ]; then
      fail "Electron app is still running after cleanup (PIDs: ${FINAL_REMAINING_APP_PIDS[*]})"
      exit 1
    fi
  fi

  ok "Electron app killed"
else
  skip "No Electron app running"
fi

# ── Step 2: Docker compose down -v ──────────────────────────────────────────
step 2 "Stopping Docker containers and removing volumes..."

docker_compose_down() {
  local dir="$1"
  local label="$2"

  if [ ! -d "$dir" ]; then
    skip "$label — directory not found"
    return
  fi

  # Only flip the "we touched portico Docker state" flag if the compose
  # project actually has something to remove; a bare `down` against an empty
  # stack is a no-op and shouldn't trigger an OrbStack restart.
  if docker ps -a --filter "label=com.docker.compose.project=portico" -q 2>/dev/null | grep -q . \
     || docker ps -a --filter "label=com.docker.compose.project=portico-managed" -q 2>/dev/null | grep -q .; then
    TOUCHED_PORTICO_DOCKER_STATE=true
  fi

  # docker-compose.yml requires .env as a file; handle it being missing or a directory
  local env_fixup="none"
  if [ -d "$dir/.env" ]; then
    # .env is a directory (broken state) — move aside so docker compose can work
    $DRY_RUN || mv "$dir/.env" "$dir/.env.dir.bak"
    $DRY_RUN || touch "$dir/.env"
    env_fixup="dir_moved"
  elif [ ! -f "$dir/.env" ]; then
    $DRY_RUN || touch "$dir/.env"
    env_fixup="created"
  fi

  if $DRY_RUN; then
    echo -e "  ${DIM}[dry-run] docker compose down -v --rmi all in $dir${NC}"
  else
    (cd "$dir" && docker compose down -v --rmi all 2>&1 | grep -v "level=warning" | grep -v "^$" || true)
  fi

  if [ "$env_fixup" = "dir_moved" ]; then
    $DRY_RUN || rm -f "$dir/.env"
    $DRY_RUN || rm -rf "$dir/.env.dir.bak"
  elif [ "$env_fixup" = "created" ]; then
    $DRY_RUN || rm -f "$dir/.env"
  fi

  ok "$label containers & volumes removed"
}

docker_compose_down "$SCRIPT_DIR" "Dev project"
docker_compose_down "$MANAGED_DIR" "Managed instance"

# Also tear down the debug-monitor compose file (separate from main docker-compose.yml)
if [ -f "$SCRIPT_DIR/dev/docker-compose.debug-monitor.yml" ]; then
  if $DRY_RUN; then
    echo -e "  ${DIM}[dry-run] docker compose -f dev/docker-compose.debug-monitor.yml down -v --rmi all${NC}"
  else
    (cd "$SCRIPT_DIR" && docker compose -f dev/docker-compose.debug-monitor.yml down -v --rmi all 2>&1 | grep -v "level=warning" | grep -v "^$" || true)
  fi
  ok "Debug monitor compose cleanup"
fi

# Tear down the single-server OAuth stack (auto-generated compose project "portico-single")
if [ -f "$SCRIPT_DIR/docker-compose.single-server.yml" ]; then
  if $DRY_RUN; then
    echo -e "  ${DIM}[dry-run] docker compose -f docker-compose.single-server.yml down -v --rmi all${NC}"
  else
    (cd "$SCRIPT_DIR" && docker compose -f docker-compose.single-server.yml down -v --rmi all 2>/dev/null || true)
  fi
  ok "Single-server OAuth stack compose cleanup"
fi

# Force-remove single-server images that compose-down may leave behind (dangling/untagged)
run_or_dry "docker rmi -f nginx:alpine 2>/dev/null || true"

# Fallback: remove single-server containers/networks by label and name prefix
# (catches orphans when the compose file was already deleted or regenerated for a different server)
SINGLE_CONTAINERS=$(docker ps -a --filter "label=com.docker.compose.project=portico-single" -q 2>/dev/null || true)
SINGLE_CONTAINERS="$SINGLE_CONTAINERS
$(docker ps -a --filter "name=mcpo-single-" -q 2>/dev/null || true)"
SINGLE_CONTAINERS=$(echo "$SINGLE_CONTAINERS" | grep -v '^$' | sort -u)
if [ -n "$SINGLE_CONTAINERS" ]; then
  run_or_dry "echo '$SINGLE_CONTAINERS' | xargs docker rm -f 2>/dev/null || true"
  ok "Removed orphaned single-server containers"
  TOUCHED_PORTICO_DOCKER_STATE=true
fi

SINGLE_NETWORKS=$(docker network ls --filter "label=com.docker.compose.project=portico-single" -q 2>/dev/null || true)
if [ -n "$SINGLE_NETWORKS" ]; then
  run_or_dry "echo '$SINGLE_NETWORKS' | xargs docker network rm 2>/dev/null || true"
  ok "Removed orphaned single-server networks"
  TOUCHED_PORTICO_DOCKER_STATE=true
fi

# Remove any remaining containers from the portico compose project
PROJ_CONTAINERS=$(docker ps -a --filter "label=com.docker.compose.project=portico" -q 2>/dev/null || true)
if [ -n "$PROJ_CONTAINERS" ]; then
  run_or_dry "echo '$PROJ_CONTAINERS' | xargs docker rm -f 2>/dev/null || true"
  ok "Removed orphaned portico compose containers"
  TOUCHED_PORTICO_DOCKER_STATE=true
fi

# Remove any remaining networks from the portico compose project
PROJ_NETWORKS=$(docker network ls --filter "label=com.docker.compose.project=portico" -q 2>/dev/null || true)
if [ -n "$PROJ_NETWORKS" ]; then
  run_or_dry "echo '$PROJ_NETWORKS' | xargs docker network rm 2>/dev/null || true"
  ok "Removed orphaned portico compose networks"
  TOUCHED_PORTICO_DOCKER_STATE=true
fi

# Agent VM containers (`agent-vm-<uuid>`) are created dynamically by the Rust
# core-mcp `agent-vm-server` crate (via bollard), NOT via docker-compose, so
# they carry no `com.docker.compose.project=portico` label and are not
# caught by the compose-based filters above. They're tagged with the app's
# `com.portico.ai-chat.image-role=agent-vm` label (see Dockerfile.agent-vm and
# AGENT_VM_IMAGE_LABEL_KEY in src/core-mcp-rust/.../agent_vm_core.rs). Also
# match by `name=agent-vm-` prefix as a belt-and-suspenders fallback in case
# a stale container survives an image rebuild that drops the label.
AGENT_VM_CONTAINERS=$(docker ps -a --filter "label=com.portico.ai-chat.image-role=agent-vm" -q 2>/dev/null || true)
AGENT_VM_CONTAINERS="$AGENT_VM_CONTAINERS
$(docker ps -a --filter "name=^agent-vm-" -q 2>/dev/null || true)"
AGENT_VM_CONTAINERS=$(echo "$AGENT_VM_CONTAINERS" | grep -v '^$' | sort -u)
if [ -n "$AGENT_VM_CONTAINERS" ]; then
  run_or_dry "echo '$AGENT_VM_CONTAINERS' | xargs docker rm -f 2>/dev/null || true"
  ok "Removed dynamically-created Agent VM containers"
  TOUCHED_PORTICO_DOCKER_STATE=true
fi

# ── Step 3: Remove Docker images ────────────────────────────────────────────
step 3 "Removing Docker images..."

# Match portico / harbor pulls / llm-debug-monitor by repo name, plus
# the agent-vm runtime image which is named `agent-vm:latest` and would not
# match the portico substring otherwise.
#
# Use `--format '{{.Repository}}:{{.Tag}}|{{.ID}}'` instead of parsing the
# default human-readable table, because OrbStack overrides `docker images`
# with a different column layout (IMAGE | ID | DISK USAGE | CONTENT SIZE),
# which made the previous `awk '{print $3}'` yank "192MB" / "DISK USAGE"
# instead of the image ID and silently fail to remove anything.
IMAGE_IDS=$(docker images --format '{{.Repository}}:{{.Tag}}|{{.ID}}' 2>/dev/null \
  | grep -E "portico|harbor\.portico\.tech/portico|llm-debug-monitor|^agent-vm:" \
  | awk -F'|' '{print $2}' | sort -u)

# Also catch any image carrying our app label (covers retagged or
# CORE_MCP_AGENT_VM_IMAGE-overridden agent-vm builds that don't match the
# repo regex above).
LABELED_IMAGE_IDS=$(docker images --filter "label=com.portico.ai-chat.image-role=agent-vm" -q 2>/dev/null | sort -u)
if [ -n "$LABELED_IMAGE_IDS" ]; then
  IMAGE_IDS=$(printf "%s\n%s\n" "$IMAGE_IDS" "$LABELED_IMAGE_IDS" | grep -v '^$' | sort -u)
fi

if [ -n "$IMAGE_IDS" ]; then
  COUNT=$(echo "$IMAGE_IDS" | wc -l | tr -d ' ')
  run_or_dry "echo '$IMAGE_IDS' | xargs docker rmi -f 2>/dev/null || true"
  ok "Removed $COUNT image(s)"
  TOUCHED_PORTICO_DOCKER_STATE=true
else
  skip "No portico images found"
fi

# Remove dangling images left behind by compose-down or partial builds
DANGLING=$(docker images -f "dangling=true" -q 2>/dev/null || true)
if [ -n "$DANGLING" ]; then
  COUNT=$(echo "$DANGLING" | wc -l | tr -d ' ')
  run_or_dry "docker image prune -f 2>/dev/null || true"
  ok "Pruned $COUNT dangling image(s)"
fi

# ── Step 4: Clear Electron app data & cache ─────────────────────────────────
step 4 "Clearing Electron app data & Chromium cache..."

# Remove Keychain trust before deleting the certificate cache that identifies
# the current single-server OAuth certificate. The shared helper also performs
# the existing broad orphaned-CN=localhost sweep and verifies the result.
if $KEEP_KEYCHAIN; then
  skip "Preserving localhost OAuth certificates (--keep-keychain)"
else
  portico_cleanup_legacy_oauth_certificates "$DRY_RUN" "$SCRIPT_DIR"
fi

# Clear the main Electron app data and cache directories
for dir in "$ELECTRON_APP_SUPPORT" "$ELECTRON_CACHE"; do
  if [ -d "$dir" ]; then
    SIZE=$(du -sh "$dir" 2>/dev/null | cut -f1)
    run_or_dry "rm -rf '$dir'"
    ok "Removed $dir ($SIZE)"
  else
    skip "Not found: $dir"
  fi
done

# Clear webview partition cache (Electron caches webview assets separately)
WEBVIEW_PARTITION="$ELECTRON_APP_SUPPORT/Partitions/openwebui"
if [ -d "$WEBVIEW_PARTITION" ]; then
  SIZE=$(du -sh "$WEBVIEW_PARTITION" 2>/dev/null | cut -f1)
  run_or_dry "rm -rf '$WEBVIEW_PARTITION/Cache' '$WEBVIEW_PARTITION/Code Cache' '$WEBVIEW_PARTITION/GPUCache' '$WEBVIEW_PARTITION/Local Storage' '$WEBVIEW_PARTITION/Session Storage' '$WEBVIEW_PARTITION/IndexedDB' '$WEBVIEW_PARTITION/WebStorage' '$WEBVIEW_PARTITION/blob_storage'"
  ok "Cleared webview partition cache ($SIZE)"
else
  skip "No webview partition cache found"
fi

# Clear the runtime-secret cache dir that backs /run/secrets/* bind-mounts.
# The top-level $ELECTRON_CACHE removal above would catch the darwin default
# transitively, but we clean each candidate dir explicitly so the Linux XDG
# path and user overrides are covered too, and the intent is self-documenting.
for secret_cache in "${RUNTIME_SECRET_CACHE_DIRS[@]}"; do
  if [ -d "$secret_cache" ]; then
    SIZE=$(du -sh "$secret_cache" 2>/dev/null | cut -f1)
    run_or_dry "rm -rf '$secret_cache'"
    ok "Removed runtime-secret cache dir $secret_cache ($SIZE)"
  fi
done

# --keep-keychain preserves only Keychain state. Certificate/key cache files
# remain part of the normal disk cleanup in every mode.
portico_remove_single_server_ssl_caches "$DRY_RUN" "$SCRIPT_DIR"

# OAuth access-token ingress cache (see
# src/mcp-orc-rust/crates/mcp-orc/src/session.rs). HttpSubprocessSession
# normally wipes its own file on close, but crashes / SIGKILL can leave
# 0600 token plaintext on disk. We overwrite any surviving files with zeros
# first so inode reuse cannot leak the token, then drop the whole tree.
for token_cache in "${OAUTH_TOKEN_CACHE_DIRS[@]}"; do
  if [ -d "$token_cache" ]; then
    SIZE=$(du -sh "$token_cache" 2>/dev/null | cut -f1)
    if ! $DRY_RUN; then
      while IFS= read -r -d '' token_file; do
        [ -f "$token_file" ] || continue
        token_size=$(stat -f '%z' "$token_file" 2>/dev/null || stat -c '%s' "$token_file" 2>/dev/null || echo 0)
        if [ "${token_size:-0}" -gt 0 ] && [ "${token_size:-0}" -lt 65536 ]; then
          dd if=/dev/zero of="$token_file" bs=1 count="$token_size" conv=notrunc >/dev/null 2>&1 || true
        fi
      done < <(find "$token_cache" -type f -print0 2>/dev/null)
    fi
    run_or_dry "rm -rf '$token_cache'"
    ok "Removed OAuth token ingress cache dir $token_cache ($SIZE)"
  fi
done

# Persisted OAuth token bundles for Slack-backed MCP runtimes. The whole
# `mcpo-oauth-tokens/` / `mcpo-core-oauth-tokens/` trees are gitignored and
# `git clean -fdX` in step 9 normally sweeps them, but we scrub the Slack
# subtrees first so access_token/refresh_token plaintext cannot survive a
# partial cleanup (e.g. when `git clean` fails mid-run on a locked inode).
# Paths mirror electron-app/src/services/oauth-token-storage.js::storageRootName.
SLACK_OAUTH_TOKEN_DIRS=(
  "$SCRIPT_DIR/mcpo-oauth-tokens/slack"
  "$SCRIPT_DIR/mcpo-core-oauth-tokens/slack"
)
for slack_token_dir in "${SLACK_OAUTH_TOKEN_DIRS[@]}"; do
  if [ -d "$slack_token_dir" ]; then
    SIZE=$(du -sh "$slack_token_dir" 2>/dev/null | cut -f1)
    run_or_dry "rm -rf '$slack_token_dir'"
    ok "Removed persisted Slack OAuth tokens $slack_token_dir ($SIZE)"
  fi
done

# ── Step 5: Remove all PORTICO-owned generic-password entries ──────────────────
step 5 "Removing PORTICO-owned Keychain passwords and safeStorage keys..."

if $KEEP_KEYCHAIN; then
  skip "Preserving PORTICO Keychain passwords and safeStorage keys (--keep-keychain)"
else
  portico_cleanup_generic_passwords "$DRY_RUN"
fi

# ── Step 6: Clear project-level configs (delegate to clean_dev.sh) ─────────
step 6 "Clearing project-level generated configs..."

if [ -x "$SCRIPT_DIR/clean_dev.sh" ]; then
  if $DRY_RUN; then
    if $KEEP_KEYCHAIN; then
      echo -e "  ${DIM}[dry-run] portico_KEYCHAIN_CLEANUP_ALREADY_DONE=1 $SCRIPT_DIR/clean_dev.sh --yes --keep-keychain${NC}"
    else
      echo -e "  ${DIM}[dry-run] portico_KEYCHAIN_CLEANUP_ALREADY_DONE=1 $SCRIPT_DIR/clean_dev.sh --yes${NC}"
    fi
  else
    if $KEEP_KEYCHAIN; then
      portico_KEYCHAIN_CLEANUP_ALREADY_DONE=1 "$SCRIPT_DIR/clean_dev.sh" --yes --keep-keychain
    else
      portico_KEYCHAIN_CLEANUP_ALREADY_DONE=1 "$SCRIPT_DIR/clean_dev.sh" --yes
    fi
  fi
  ok "Dev config cleanup complete (via clean_dev.sh)"
else
  warn "clean_dev.sh not found or not executable — skipping dev config cleanup"
fi

# Project-root plaintext twin of runtime secrets. Hardening already excludes
# this path from the resolver's candidate reads, but we still scrub it on full
# cleanup so a stale developer-created copy can't seed a fresh install.
# NOTE: `cloudsmith.env` is intentionally NOT removed here — it is a tracked
# config file with non-secret defaults that the repo depends on at install
# time. Removing it would dirty the working tree.
# `runtime-secret-files/` is a legacy directory from an earlier ingress design
# (pre-Docker-secrets) and should not exist on current installs — remove it
# defensively for users upgrading from an intermediate snapshot.
if [ -f "$SCRIPT_DIR/runtime-secrets.env" ]; then
  run_or_dry "rm -f '$SCRIPT_DIR/runtime-secrets.env'"
  ok "Removed project-root plaintext twin: runtime-secrets.env"
fi

if [ -d "$SCRIPT_DIR/runtime-secret-files" ]; then
  run_or_dry "rm -rf '$SCRIPT_DIR/runtime-secret-files'"
  ok "Removed legacy runtime-secret-files/ directory"
fi

# ── Step 7: Clear Open WebUI data ─────────────────────────────────────────
step 7 "Clearing Open WebUI data..."

OWUI_DATA="$SCRIPT_DIR/open-webui-data"
if [ -d "$OWUI_DATA" ]; then
  SIZE=$(du -sh "$OWUI_DATA" 2>/dev/null | cut -f1)
  run_or_dry "rm -rf '$OWUI_DATA'"
  ok "Removed open-webui-data/ ($SIZE)"
else
  skip "No open-webui-data/ found"
fi

# ── Step 8: Remove managed instance directory ───────────────────────────────
step 8 "Removing managed instance directory..."

if [ -d "$MANAGED_DIR" ]; then
  SIZE=$(du -sh "$MANAGED_DIR" 2>/dev/null | cut -f1)
  run_or_dry "rm -rf '$MANAGED_DIR'"
  ok "Removed $MANAGED_DIR ($SIZE)"
else
  skip "Not found: $MANAGED_DIR"
fi

# ── Step 9: Clean gitignored build artifacts ────────────────────────────────
step 9 "Cleaning gitignored build artifacts..."

# `git clean -X -e .env` still removes an ignored .env. Use an exclusion
# pathspec, which is honored after ignore selection, to protect the root
# release-operator file. The .idea directory uses its existing move/restore
# path because global ignore rules can vary by workstation.
GIT_CLEAN_EXCLUDES=(-e clean_full.sh)
GIT_CLEAN_PATHS=(-- . ':(exclude,top).env')

IDEA_SAVED=false
IDEA_BACKUP_DIR=""
if [ -d "$SCRIPT_DIR/.idea" ]; then
  IDEA_BACKUP_DIR=$(mktemp -d)
  run_or_dry "mv '$SCRIPT_DIR/.idea' '$IDEA_BACKUP_DIR/.idea'"
  IDEA_SAVED=true
fi

if $DRY_RUN; then
  echo -e "  ${DIM}[dry-run] git clean -fdXn ${GIT_CLEAN_EXCLUDES[*]} ${GIT_CLEAN_PATHS[*]}:${NC}"
  git clean -fdXn "${GIT_CLEAN_EXCLUDES[@]}" "${GIT_CLEAN_PATHS[@]}" 2>/dev/null | sed 's/^/    /'
else
  CLEANED=$(git clean -fdX "${GIT_CLEAN_EXCLUDES[@]}" "${GIT_CLEAN_PATHS[@]}" 2>/dev/null)
  if [ -n "$CLEANED" ]; then
    COUNT=$(echo "$CLEANED" | wc -l | tr -d ' ')
    ok "Removed $COUNT gitignored items (node_modules, dist, .venv, __pycache__, etc.)"
  else
    skip "No gitignored artifacts found"
  fi
fi

if $IDEA_SAVED; then
  run_or_dry "mv '$IDEA_BACKUP_DIR/.idea' '$SCRIPT_DIR/.idea'"
  rm -rf "$IDEA_BACKUP_DIR" 2>/dev/null || true
  ok "Preserved: .idea/"
fi

# ── Restart OrbStack (only if we actually cleaned portico state) ────
echo ""

# Collect all host ports from docker-compose.yml so we can check for stale
# listeners that lsof sees as still bound after container removal. This is the
# second trigger for a restart: if the project ports are still held by a Docker
# vmnet process, OrbStack needs to cycle for the next `up` to succeed.
PROJECT_PORTS=$(grep -E '^\s*-\s*"[0-9]+:[0-9]+"' "$SCRIPT_DIR/docker-compose.yml" 2>/dev/null \
  | sed 's/.*"\([0-9]*\):.*/\1/' | sort -u || true)

STALE_PIDS=""
if [ -n "$PROJECT_PORTS" ]; then
  for port in $PROJECT_PORTS; do
    PIDS=$(lsof -i :"$port" -t 2>/dev/null || true)
    if [ -n "$PIDS" ]; then
      STALE_PIDS="$STALE_PIDS $PIDS"
    fi
  done
  STALE_PIDS=$(echo "$STALE_PIDS" | tr ' ' '\n' | sort -u | tr '\n' ' ' | xargs)
fi

if [ -n "$STALE_PIDS" ]; then
  TOUCHED_PORTICO_DOCKER_STATE=true
fi

if ! pgrep -x "OrbStack" >/dev/null 2>&1 && ! pgrep -x "com.orbstack.mac" >/dev/null 2>&1; then
  skip "OrbStack not running"
elif ! $TOUCHED_PORTICO_DOCKER_STATE; then
  # No portico compose projects, images, or stale project-port listeners
  # were touched — restarting OrbStack would only disrupt unrelated containers.
  skip "OrbStack restart not needed (no portico Docker state was cleaned)"
else
  if $AUTO_YES; then
    RESTART_ORBSTACK=true
  elif $DRY_RUN; then
    RESTART_ORBSTACK=true
  else
    read -p "$(echo -e "${YELLOW}Restart OrbStack to clear stale port forwarding for portico? (yes/no): ${NC}")" -r
    [[ $REPLY =~ ^[Yy]([Ee][Ss])?$ ]] && RESTART_ORBSTACK=true || RESTART_ORBSTACK=false
  fi

  if $RESTART_ORBSTACK; then
    run_or_dry "osascript -e 'quit app \"OrbStack\"' && sleep 5"

    if [ -n "$STALE_PIDS" ]; then
      run_or_dry "kill -9 $STALE_PIDS 2>/dev/null || true"
      ok "Killed stale port listeners on project ports (PIDs: $STALE_PIDS)"
      $DRY_RUN || sleep 2
    fi

    run_or_dry "open -a OrbStack && sleep 5"
    ok "OrbStack restarted (stale port forwarding cleared)"
  else
    skip "OrbStack restart skipped"
  fi
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}══════════════════════════════════════════════${NC}"
if $DRY_RUN; then
  echo -e "${GREEN}  Dry run complete — no changes were made${NC}"
else
  echo -e "${GREEN}  Full cleanup complete!${NC}"
fi
echo -e "${GREEN}══════════════════════════════════════════════${NC}"
echo ""
if $KEEP_KEYCHAIN; then
  echo "Disk and Docker state are clean; PORTICO Keychain residue was deliberately preserved."
else
  echo "Your environment is reset to a clean branch and Keychain state."
fi
echo "To reinstall, run:  ./install_v2.sh"
echo ""
