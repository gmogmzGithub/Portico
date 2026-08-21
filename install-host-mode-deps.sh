#!/usr/bin/env bash
#
# install-host-mode-deps.sh
#
# Idempotent installer for Portico HOST mode dependencies on macOS.
#
#   1. Installs Node.js (>= v20.19.0) + npx to ~/.local/lib/nodejs/
#      (matches the path the Electron app's prereq-host-mode.sh auto-probes,
#      so no extra PATH wiring is required for the app to see it).
#   2. Writes HOST_MODE=TRUE to ~/portico/portico-managed/HOST_MODE
#      so bundled host-mode MCP servers (e.g. Chrome DevTools) are marked
#      available after MCP services are restarted.
#
# Safe to re-run. Existing satisfactory tools are reused, partial installs
# are cleaned up, and Portico's managed Node stays private to the app.
#
# Usage:
#   bash install-host-mode-deps.sh
#
# Overrides (env vars):
#   NODE_VERSION   Node.js version tag  (default: v20.19.0)
#   MANAGED_DIR    Managed install dir  (default: ~/portico/portico-managed)

set -euo pipefail

# -------- Configuration ---------------------------------------------------

NODE_VERSION="${NODE_VERSION:-v20.19.0}"
NODE_VERSION_MIN="${NODE_VERSION#v}"
NODEJS_INSTALL_ROOT="$HOME/.local/lib/nodejs"
portico_USR_LOCAL_BIN_DIR="${portico_USR_LOCAL_BIN_DIR:-/usr/local/bin}"
MANAGED_DIR="${MANAGED_DIR:-$HOME/portico/portico-managed}"
HOST_MODE_FILE="$MANAGED_DIR/HOST_MODE"

# -------- Logging ---------------------------------------------------------

if [[ -t 1 ]]; then
  C_R=$'\033[0;31m'; C_G=$'\033[0;32m'; C_Y=$'\033[0;33m'
  C_B=$'\033[0;34m'; C_N=$'\033[0m'
else
  C_R=''; C_G=''; C_Y=''; C_B=''; C_N=''
fi

log_info()    { printf '%s[INFO]%s %s\n' "$C_B" "$C_N" "$*"; }
log_ok()      { printf '%s[ OK ]%s %s\n' "$C_G" "$C_N" "$*"; }
log_warn()    { printf '%s[WARN]%s %s\n' "$C_Y" "$C_N" "$*"; }
log_err()     { printf '%s[FAIL]%s %s\n' "$C_R" "$C_N" "$*" >&2; }
fatal()       { log_err "$*"; exit 1; }

# -------- Cleanup trap ----------------------------------------------------

TMPDIR_GLOBAL=""
cleanup() {
  [[ -n "$TMPDIR_GLOBAL" && -d "$TMPDIR_GLOBAL" ]] && rm -rf "$TMPDIR_GLOBAL"
  return 0
}
trap cleanup EXIT

# -------- Preflight -------------------------------------------------------

[[ "$(uname -s)" == "Darwin" ]] \
  || fatal "This script supports macOS only (detected $(uname -s))"

case "$(uname -m)" in
  arm64)  NODE_ARCH="arm64" ;;
  x86_64) NODE_ARCH="x64"   ;;
  *)      fatal "Unsupported macOS architecture: $(uname -m)" ;;
esac

TARBALL="node-${NODE_VERSION}-darwin-${NODE_ARCH}.tar.gz"
DOWNLOAD_URL="https://nodejs.org/dist/${NODE_VERSION}/${TARBALL}"
INSTALL_DIR="$NODEJS_INSTALL_ROOT/node-${NODE_VERSION}-darwin-${NODE_ARCH}"

# -------- semver helpers --------------------------------------------------

semver_gte() {
  local IFS=.
  local -a a=($1) b=($2)
  local i x y
  for i in 0 1 2; do
    x="${a[i]:-0}"; y="${b[i]:-0}"
    x="${x%%[!0-9]*}"; y="${y%%[!0-9]*}"
    if (( 10#${x:-0} > 10#${y:-0} )); then return 0; fi
    if (( 10#${x:-0} < 10#${y:-0} )); then return 1; fi
  done
  return 0
}

node_version_ok() {
  local bin="$1" raw
  [[ -x "$bin" ]] || return 1
  raw="$("$bin" --version 2>/dev/null || true)"
  raw="${raw#v}"; raw="${raw%%-*}"; raw="${raw%%+*}"
  [[ "$raw" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  semver_gte "$raw" "$NODE_VERSION_MIN"
}

node_toolchain_ok() {
  local bin_dir="$1"
  node_version_ok "$bin_dir/node" || return 1
  [[ -x "$bin_dir/npm" ]] || return 1
  [[ -x "$bin_dir/npx" ]] || return 1
}

resolve_node_runtime_bin_dir() {
  local path_candidates=""
  local candidate_dir install_root
  local path_entries install_root_entries nvm_root entries seen

  if [ -n "${HOST_NODE_BIN_DIR:-}" ]; then
    path_candidates="$HOST_NODE_BIN_DIR"
  fi

  IFS=':' read -r -a path_entries <<< "${PATH:-}"
  for candidate_dir in "${path_entries[@]}"; do
    [[ -n "$candidate_dir" ]] || continue
    path_candidates="${path_candidates:+${path_candidates}:}${candidate_dir}"
  done

  nvm_root="${NVM_DIR:-$HOME/.nvm}"
  for candidate_dir in "$nvm_root"/versions/node/*/bin; do
    [[ -d "$candidate_dir" ]] || continue
    path_candidates="${path_candidates:+${path_candidates}:}${candidate_dir}"
  done

  IFS=':' read -r -a install_root_entries <<< "${HOST_NODE_INSTALL_ROOTS:-$NODEJS_INSTALL_ROOT:/usr/local/lib/nodejs}"
  for install_root in "${install_root_entries[@]}"; do
    [[ -n "$install_root" ]] || continue
    for candidate_dir in "$install_root"/node-*/bin; do
      [[ -d "$candidate_dir" ]] || continue
      path_candidates="${path_candidates:+${path_candidates}:}${candidate_dir}"
    done
  done

  seen=":"
  IFS=':' read -r -a entries <<< "$path_candidates"
  for candidate_dir in "${entries[@]}"; do
    [[ -n "$candidate_dir" ]] || continue
    case "$seen" in
      *":${candidate_dir}:"*) continue ;;
      *) seen="${seen}${candidate_dir}:" ;;
    esac

    if node_toolchain_ok "$candidate_dir"; then
      printf '%s\n' "$candidate_dir"
      return 0
    fi
  done

  return 1
}

cleanup_portico_node_profile_entries() {
  local profile tmp_file awk_status

  for profile in "$HOME/.zshrc" "$HOME/.zprofile" "$HOME/.bash_profile" "$HOME/.bashrc"; do
    [[ -f "$profile" ]] || continue

    tmp_file="$(mktemp "${profile}.XXXXXX")" || continue
    set +e
    awk -v home="$HOME" '
      BEGIN {
        changed = 0
        skip_portico_path = 0
        usr_local = "/usr/local/lib/nodejs/node-"
        home_local = home "/.local/lib/nodejs/node-"
      }
      function is_portico_node_path(line) {
        return index(line, usr_local) > 0 || index(line, home_local) > 0
      }
      {
        if ($0 == "# Node.js (installed by Portico)") {
          skip_portico_path = 1
          changed = 1
          next
        }
        if (skip_portico_path) {
          if ($0 ~ /^[[:space:]]*export[[:space:]]+PATH=/ && is_portico_node_path($0)) {
            skip_portico_path = 0
            changed = 1
            next
          }
          skip_portico_path = 0
        }
        if (index($0, "portico HOST mode PATH") > 0 && is_portico_node_path($0)) {
          changed = 1
          next
        }
        print
      }
      END {
        if (changed) {
          exit 42
        }
      }
    ' "$profile" > "$tmp_file"
    awk_status=$?
    set -e

    if [[ "$awk_status" -eq 42 ]]; then
      mv "$tmp_file" "$profile"
      log_info "Removed Portico Node.js PATH entries from $profile"
    else
      rm -f "$tmp_file"
    fi
  done
}

cleanup_portico_node_usr_local_symlinks() {
  local bin_name link_path target

  [[ -d "$portico_USR_LOCAL_BIN_DIR" ]] || return 0

  for bin_name in node npm npx; do
    link_path="$portico_USR_LOCAL_BIN_DIR/$bin_name"
    [[ -L "$link_path" ]] || continue
    target="$(readlink "$link_path" 2>/dev/null || true)"
    case "$target" in
      /usr/local/lib/nodejs/node-*/bin/*|"$HOME"/.local/lib/nodejs/node-*/bin/*)
        rm -f "$link_path" 2>/dev/null || true
        log_info "Removed Portico managed Node.js symlink: $link_path"
        ;;
    esac
  done
}

cleanup_portico_node_shell_integration() {
  cleanup_portico_node_profile_entries
  cleanup_portico_node_usr_local_symlinks
}

# -------- Node.js install -------------------------------------------------

download_and_extract_node() {
  mkdir -p "$NODEJS_INSTALL_ROOT"

  if [[ -d "$INSTALL_DIR" ]] && ! [[ -x "$INSTALL_DIR/bin/node" ]]; then
    log_warn "Removing incomplete install at $INSTALL_DIR"
    rm -rf "$INSTALL_DIR"
  fi

  TMPDIR_GLOBAL="$(mktemp -d -t portico-node-XXXXXX)"
  local tarball_path="$TMPDIR_GLOBAL/$TARBALL"

  log_info "Downloading $DOWNLOAD_URL"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 --retry-delay 2 --connect-timeout 30 \
         -o "$tarball_path" "$DOWNLOAD_URL" \
      || fatal "curl download failed"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --tries=3 -O "$tarball_path" "$DOWNLOAD_URL" \
      || fatal "wget download failed"
  else
    fatal "Neither curl nor wget is available — cannot download Node.js"
  fi

  log_info "Extracting into $NODEJS_INSTALL_ROOT"
  tar -xzf "$tarball_path" -C "$NODEJS_INSTALL_ROOT" \
    || fatal "Failed to extract $tarball_path"

  [[ -x "$INSTALL_DIR/bin/node" ]] \
    || fatal "Extracted tarball but $INSTALL_DIR/bin/node is not executable"

  rm -rf "$TMPDIR_GLOBAL"; TMPDIR_GLOBAL=""
}

ensure_node_installed() {
  local node_bin_dir

  if node_bin_dir="$(resolve_node_runtime_bin_dir)"; then
    export PATH="$node_bin_dir:${PATH:-}"
    log_ok "Node.js $(node --version) already available at $node_bin_dir/node"
    return 0
  fi

  if node_toolchain_ok "$INSTALL_DIR/bin"; then
    log_ok "Reusing existing install at $INSTALL_DIR"
  else
    download_and_extract_node
    log_ok "Installed Node.js $NODE_VERSION to $INSTALL_DIR"
  fi

  export PATH="$INSTALL_DIR/bin:$PATH"
}

# -------- npx sanity check ------------------------------------------------

ensure_npx_available() {
  command -v npx >/dev/null 2>&1 \
    || fatal "npx is not on PATH after Node.js install — refusing to set HOST_MODE"
  npx --version >/dev/null 2>&1 \
    || fatal "npx --version failed — Node.js install looks broken"
  log_ok "npx available at $(command -v npx) ($(npx --version))"
}

# -------- HOST_MODE file --------------------------------------------------

write_host_mode_file() {
  mkdir -p "$MANAGED_DIR"
  if [[ -d "$HOST_MODE_FILE" && ! -L "$HOST_MODE_FILE" ]]; then
    log_warn "Found directory at $HOST_MODE_FILE; removing invalid HOST_MODE sentinel"
    rm -rf "$HOST_MODE_FILE"
  fi
  if [[ -f "$HOST_MODE_FILE" ]] \
     && [[ "$(tr -d '[:space:]' < "$HOST_MODE_FILE")" == "TRUE" ]]; then
    log_ok "HOST_MODE=TRUE already set at $HOST_MODE_FILE"
    return 0
  fi
  printf 'TRUE\n' > "$HOST_MODE_FILE"
  log_ok "Wrote HOST_MODE=TRUE to $HOST_MODE_FILE"
}

# -------- Main ------------------------------------------------------------

main() {
  log_info "macOS $(sw_vers -productVersion 2>/dev/null || echo unknown) / $NODE_ARCH"
  log_info "Preparing Portico host integrations..."

  cleanup_portico_node_shell_integration
  ensure_node_installed
  ensure_npx_available
  write_host_mode_file

  echo
  printf '%s==========================================================%s\n' "$C_G" "$C_N"
  printf '%s  Setup complete%s\n' "$C_G" "$C_N"
  printf '%s==========================================================%s\n' "$C_G" "$C_N"
  echo
  printf '  One last step in Portico:\n'
  echo
  printf '    %s•%s Click the bug icon (top-right) and choose\n' "$C_B" "$C_N"
  printf '      "Restart Services"\n'
  printf '    %s•%s If you are using the Host Mode Setup skill, return to chat\n' "$C_B" "$C_N"
  printf '      and say "Setup complete".\n'
  echo
}

main "$@"
