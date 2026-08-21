#!/bin/bash

# prereq-dependencies.sh - Prerequisites Phase 2: Install Dependencies
# Cherry-picked from install_v2.sh for Electron guided setup wizard
# This script handles:
#   - Homebrew installation (macOS)
#   - jq installation
#   - Node.js/npm/npx installation (power setup only)
#   - Node.js runtime installation for bundled HOST integrations
#   - uv/uvx installation (power setup only)
#
# Dependencies are required for guided setup; failures are logged and will
# mark the phase as failed so the UI can prompt a retry.
# The final HOST_MODE determination is done by prereq-host-mode.sh
#
# Progress markers emitted for Electron app:
#   [PREREQ:PHASE:2:START]
#   [PREREQ:STEP:<step>:START]
#   [PREREQ:STEP:<step>:COMPLETE]
#   [PREREQ:STEP:<step>:SKIPPED]
#   [PREREQ:STEP:<step>:FAILED]
#   [PREREQ:PHASE:2:COMPLETE]
#   [PREREQ:ERROR:<message>]
#   [PREREQ:WARNING:<message>]

set -e

# Minimum Node.js runtime required for host-mode tooling.
NODE_VERSION_REQUIRED="${NODE_VERSION_REQUIRED:-20.19.0}"
SYSTEM_COMMAND_LINE_TOOLS_DIR="/Library/Developer/CommandLineTools"
LAST_XCODE_SELECT_INSTALL_STATUS=0
LAST_XCODE_SELECT_INSTALL_OUTPUT=""
LAST_OSASCRIPT_CONTEXT_PROBE_STATUS=0
LAST_OSASCRIPT_CONTEXT_PROBE_OUTPUT=""
LAST_HOMEBREW_SUDO_STATUS=0
LAST_HOMEBREW_SUDO_OUTPUT=""
LAST_HOMEBREW_AUTH_ELAPSED_SECONDS=0

# ============================================================================
# LOGGING FUNCTIONS
# ============================================================================

emit_phase_start() {
    echo "[PREREQ:PHASE:2:START]"
}

emit_phase_complete() {
    echo "[PREREQ:PHASE:2:COMPLETE]"
}

emit_step_start() {
    echo "[PREREQ:STEP:$1:START]"
}

emit_step_complete() {
    echo "[PREREQ:STEP:$1:COMPLETE]"
}

emit_step_skipped() {
    echo "[PREREQ:STEP:$1:SKIPPED]"
}

emit_step_failed() {
    echo "[PREREQ:STEP:$1:FAILED]"
}

emit_error() {
    echo "[PREREQ:ERROR:$1]"
}

emit_warning() {
    echo "[PREREQ:WARNING:$1]"
}

emit_code() {
    echo "[PREREQ:CODE:$1]"
}

emit_detail() {
    echo "[PREREQ:DETAIL:$1]"
}

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

log_error() {
    echo "[ERROR] $(date '+%Y-%m-%d %H:%M:%S') $1" >&2
}

log_success() {
    echo "[SUCCESS] $(date '+%Y-%m-%d %H:%M:%S') $1"
}

log_info() {
    echo "[INFO] $(date '+%Y-%m-%d %H:%M:%S') $1"
}

log_warning() {
    echo "[WARNING] $(date '+%Y-%m-%d %H:%M:%S') $1"
}

command_exists() {
    command -v "$1" >/dev/null 2>&1
}

marker_safe_text() {
    local text="${1:-}"
    text="${text//$'\r'/ }"
    text="${text//$'\n'/ }"
    text="${text//[/\(}"
    text="${text//]/\)}"
    text="$(printf '%s' "$text" | tr -s ' ')"
    if [ "${#text}" -gt 240 ]; then
        text="${text:0:237}..."
    fi
    printf '%s\n' "$text"
}

normalize_semver() {
    local raw="$1"
    local version="${raw#v}"
    version="${version%%-*}"
    version="${version%%+*}"

    if [[ ! "$version" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]]; then
        return 1
    fi

    local major minor patch
    IFS='.' read -r major minor patch <<< "$version"
    minor="${minor:-0}"
    patch="${patch:-0}"
    echo "${major}.${minor}.${patch}"
}

semver_gte() {
    local left right
    left="$(normalize_semver "$1")" || return 1
    right="$(normalize_semver "$2")" || return 1

    local l_major l_minor l_patch r_major r_minor r_patch
    IFS='.' read -r l_major l_minor l_patch <<< "$left"
    IFS='.' read -r r_major r_minor r_patch <<< "$right"

    if (( l_major > r_major )); then return 0; fi
    if (( l_major < r_major )); then return 1; fi
    if (( l_minor > r_minor )); then return 0; fi
    if (( l_minor < r_minor )); then return 1; fi
    if (( l_patch >= r_patch )); then return 0; fi
    return 1
}

node_bin_dir_satisfies_requirement() {
    local node_bin_dir="$1"
    local node_raw node_version

    [ -x "${node_bin_dir}/node" ] || return 1
    [ -x "${node_bin_dir}/npm" ] || return 1
    [ -x "${node_bin_dir}/npx" ] || return 1

    node_raw="$("${node_bin_dir}/node" --version 2>/dev/null || true)"
    node_version="$(normalize_semver "$node_raw" 2>/dev/null || true)"
    if [ -z "$node_version" ]; then
        return 1
    fi

    semver_gte "$node_version" "$NODE_VERSION_REQUIRED"
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
        [ -n "$candidate_dir" ] || continue
        path_candidates="${path_candidates:+${path_candidates}:}${candidate_dir}"
    done

    nvm_root="${NVM_DIR:-$HOME/.nvm}"
    for candidate_dir in "$nvm_root"/versions/node/*/bin; do
        [ -d "$candidate_dir" ] || continue
        path_candidates="${path_candidates:+${path_candidates}:}${candidate_dir}"
    done

    IFS=':' read -r -a install_root_entries <<< "${portico_NODE_INSTALL_ROOTS:-$HOME/.local/lib/nodejs:/usr/local/lib/nodejs}"
    for install_root in "${install_root_entries[@]}"; do
        [ -n "$install_root" ] || continue
        for candidate_dir in "$install_root"/node-*/bin; do
            [ -d "$candidate_dir" ] || continue
            path_candidates="${path_candidates:+${path_candidates}:}${candidate_dir}"
        done
    done

    seen=":"
    IFS=':' read -r -a entries <<< "$path_candidates"
    for candidate_dir in "${entries[@]}"; do
        [ -n "$candidate_dir" ] || continue
        case "$seen" in
            *":${candidate_dir}:"*) continue ;;
            *) seen="${seen}${candidate_dir}:" ;;
        esac

        if node_bin_dir_satisfies_requirement "$candidate_dir"; then
            printf '%s\n' "$candidate_dir"
            return 0
        fi
    done

    return 1
}

node_runtime_satisfies_requirement() {
    local node_bin_dir
    node_bin_dir="$(resolve_node_runtime_bin_dir)" || return 1
    export PATH="${node_bin_dir}:${PATH:-}"
    return 0
}

cleanup_portico_node_profile_entries() {
    local rc_file tmp_file awk_status

    for rc_file in "$HOME/.zshrc" "$HOME/.zprofile" "$HOME/.bash_profile" "$HOME/.bashrc"; do
        [ -f "$rc_file" ] || continue

        tmp_file="$(mktemp "${rc_file}.XXXXXX")" || continue
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
        ' "$rc_file" > "$tmp_file"
        awk_status=$?
        set -e

        if [ "$awk_status" -eq 42 ]; then
            mv "$tmp_file" "$rc_file"
            log_info "Removed Portico Node.js PATH entries from ${rc_file}"
        else
            rm -f "$tmp_file"
        fi
    done
}

cleanup_portico_node_usr_local_symlinks() {
    local bin_dir="${portico_USR_LOCAL_BIN_DIR:-/usr/local/bin}"
    local bin_name link_path target

    [ -d "$bin_dir" ] || return 0

    for bin_name in node npm npx; do
        link_path="${bin_dir}/${bin_name}"
        [ -L "$link_path" ] || continue
        target="$(readlink "$link_path" 2>/dev/null || true)"
        case "$target" in
            /usr/local/lib/nodejs/node-*/bin/*|"$HOME"/.local/lib/nodejs/node-*/bin/*)
                rm -f "$link_path" 2>/dev/null || true
                log_info "Removed Portico managed Node.js symlink: ${link_path}"
                ;;
        esac
    done
}

cleanup_portico_node_shell_integration() {
    cleanup_portico_node_profile_entries
    cleanup_portico_node_usr_local_symlinks
}

# PORTICO-436: publishes the background worker's pid in HEARTBEAT_PID rather than on
# stdout, and callers must read that variable.
#
# The previous version ended with `echo $!` and callers captured it through
# command substitution. That deadlocks every time: command substitution reads the
# subshell's stdout until EVERY holder closes it, and the backgrounded
# `while true` loop inherits that pipe and holds it open forever, so the
# assignment never returns. Guided setup froze on the line AFTER the
# "attempt 1/2" log, which is why the brew command it was about to run looked
# like the thing that hung.
#
# Keeping the pid off stdout also lets the loop write to the script's real stdout,
# so the heartbeat actually reaches the setup log. Under the old pattern its
# output went into the command-substitution pipe and was never seen.
HEARTBEAT_PID=""
# Overridable so tests can exercise the real function instead of stubbing it. The
# stub is how the deadlock above survived: every existing test replaced this
# function, so its actual behaviour was never executed.
HEARTBEAT_INTERVAL_SECONDS="${HEARTBEAT_INTERVAL_SECONDS:-60}"
start_heartbeat() {
    local label="$1"
    local interval="${HEARTBEAT_INTERVAL_SECONDS}"
    (
        local elapsed=0
        while true; do
            sleep "$interval"
            elapsed=$((elapsed + interval))
            log_info "${label} still running... (${elapsed}s elapsed)"
        done
    ) &
    HEARTBEAT_PID=$!
}

stop_heartbeat() {
    local pid="$1"
    if [ -n "$pid" ]; then
        kill "$pid" >/dev/null 2>&1 || true
    fi
}

brew_with_verbose_logs() {
    if ! command_exists brew; then
        return 127
    fi
    NONINTERACTIVE=1 HOMEBREW_VERBOSE=1 HOMEBREW_DEBUG=1 brew "$@" 2>&1
}

# PORTICO-436: bound a command that has no business running forever. macOS ships no
# GNU `timeout`, so poll the child rather than depend on coreutils. Returns 124 on
# expiry, mirroring `timeout`.
#
# The child keeps this shell's stdout, so its output still streams into the setup
# log. Grandchildren (brew's git/curl) are TERMed via pkill -P where available,
# because killing only brew can leave a git fetch holding the network.
run_with_timeout() {
    local timeout_seconds="$1"
    shift

    "$@" &
    local cmd_pid=$!
    local waited=0

    while kill -0 "$cmd_pid" 2>/dev/null; do
        if [ "$waited" -ge "$timeout_seconds" ]; then
            log_warning "Command exceeded ${timeout_seconds}s; terminating: $*"
            if command_exists pkill; then
                pkill -TERM -P "$cmd_pid" 2>/dev/null || true
            fi
            kill -TERM "$cmd_pid" 2>/dev/null || true
            sleep 2
            if command_exists pkill; then
                pkill -KILL -P "$cmd_pid" 2>/dev/null || true
            fi
            kill -KILL "$cmd_pid" 2>/dev/null || true
            wait "$cmd_pid" 2>/dev/null || true
            return 124
        fi
        sleep 1
        waited=$((waited + 1))
    done

    wait "$cmd_pid"
}

# Each self-heal brew invocation gets its own budget. Worst case here is two
# updates plus one update-reset, so keep the total comfortably inside the
# 40-minute Phase 2 cap in prerequisites-service.js -- otherwise the phase dies
# with a generic "Timeout after 2400s" and the actionable homebrew_outdated
# guidance below is never emitted.
HOMEBREW_SELF_HEAL_TIMEOUT_SECONDS="${HOMEBREW_SELF_HEAL_TIMEOUT_SECONDS:-300}"

is_homebrew_macos_unsupported_output() {
    # Matches the MacOSVersion::Error raised by a Homebrew install that
    # predates the host macOS release (PORTICO-229). The pattern deliberately
    # avoids quote characters so it matches every Ruby quoting variant.
    printf '%s' "${1:-}" | grep -qiE 'MacOSVersion::Error|unknown or unsupported macOS version'
}

# PORTICO-436 follow-up: does brew report its OWN git checkout as unusable?
#
# `brew --version` prints "Homebrew >=4.1.0 (shallow or no git repository)" -- and
# "Homebrew/homebrew-core (no git repository)" for taps -- when it cannot read a
# version out of git. That is exactly the state `brew update-reset` exists to
# repair and the one a plain `brew update` cannot advance from, so it decides the
# recovery ORDER below rather than being discovered after two futile updates.
#
# `--version` is the right probe because, unlike `brew config`, it does not
# resolve the host macOS version, so it still answers on the very brews this
# function exists to fix.
is_homebrew_git_state_wedged() {
    if ! command_exists brew; then
        return 1
    fi
    local version_output=""
    version_output=$(NONINTERACTIVE=1 brew --version 2>&1 || true)
    printf '%s' "$version_output" | grep -qiE 'no git repository|shallow clone'
}

# Verify that the resolved brew can actually operate on this macOS release.
# `brew --version` succeeds even when Homebrew predates the host macOS, so we
# probe with `brew config`, which forces host macOS version resolution and is
# fast and offline.
#
# Returns 0 when brew works (or when we cannot tell -> fail open so machines
# that passed the old presence check keep passing). Returns 1 only when brew
# provably cannot resolve the host macOS version AND the bounded recovery plan
# below (two `brew update` attempts plus one `brew update-reset`, ordered by what
# brew reports about its own git checkout) did not heal it; failure markers are
# emitted here, and the caller emits the step failure.
ensure_homebrew_supports_host_macos() {
    if [[ "$OSTYPE" != "darwin"* ]]; then
        return 0
    fi

    local probe_output=""
    local hb_pid

    if probe_output=$(NONINTERACTIVE=1 brew config 2>&1); then
        return 0
    fi

    if ! is_homebrew_macos_unsupported_output "$probe_output"; then
        log_warning "brew config failed with an unrelated error; continuing: $(marker_safe_text "$probe_output")"
        return 0
    fi

    log_warning "Homebrew cannot resolve this macOS version: $(marker_safe_text "$probe_output")"

    # PORTICO-229 follow-up: a Homebrew old enough to crash on host-macOS resolution
    # can be too stale for a plain `brew update` to advance (e.g. wedged or
    # detached tap git state). `brew update-reset` hard-resets the Homebrew git
    # repositories to their remotes and is the documented recovery for that case,
    # so the recovery plan always contains it.
    #
    # PORTICO-436 follow-up: which end of the plan it belongs on is not fixed. When
    # brew already reports a shallow or missing checkout, the comment above says
    # plainly that `brew update` cannot get anywhere, so leading with two of them
    # burns up to 2 x HOMEBREW_SELF_HEAL_TIMEOUT_SECONDS of the 40-minute Phase 2
    # budget before we reach the only step that can work -- and it is the reported
    # PORTICO-436 machine that is in exactly that state. So reset first when brew says
    # its checkout is wedged, and keep update-first (the more conservative order,
    # since update-reset discards local Homebrew git state) for everything else.
    local -a recovery_steps
    if is_homebrew_git_state_wedged; then
        log_info "Homebrew reports a shallow or missing git checkout, which a plain update cannot advance; resetting its repositories first"
        recovery_steps=(update-reset update update)
    else
        recovery_steps=(update update update-reset)
    fi

    # Only used to label the update attempts honestly if the plan ever changes;
    # both orders run two of them today.
    local update_total=0
    local update_attempt=0
    local step
    for step in "${recovery_steps[@]}"; do
        if [ "$step" = "update" ]; then
            update_total=$((update_total + 1))
        fi
    done

    local steps_taken=""
    for step in "${recovery_steps[@]}"; do
        if [ "$step" = "update-reset" ]; then
            # Reset only while we are still hitting the macOS-version crash; an
            # unrelated error falls through to the fail-open check below.
            if ! is_homebrew_macos_unsupported_output "$probe_output"; then
                continue
            fi
            log_info "Resetting Homebrew's repositories (brew update-reset)..."
        else
            update_attempt=$((update_attempt + 1))
            log_info "Updating Homebrew to add support for this macOS version (attempt ${update_attempt}/${update_total})..."
        fi

        start_heartbeat "Homebrew (brew ${step})"; hb_pid="$HEARTBEAT_PID"
        run_with_timeout "$HOMEBREW_SELF_HEAL_TIMEOUT_SECONDS" brew_with_verbose_logs "$step" \
            || log_warning "brew ${step} did not succeed (exit $?)"
        stop_heartbeat "$hb_pid"
        steps_taken="${steps_taken:+${steps_taken}, }brew ${step}"

        if probe_output=$(NONINTERACTIVE=1 brew config 2>&1); then
            if [ "$step" = "update-reset" ]; then
                log_success "Homebrew reset and now supports this macOS version"
            else
                log_success "Homebrew updated and now supports this macOS version"
            fi
            return 0
        fi
    done

    if ! is_homebrew_macos_unsupported_output "$probe_output"; then
        log_warning "brew config still failing after update with a different error; continuing: $(marker_safe_text "$probe_output")"
        return 0
    fi

    log_error "Homebrew is too old for this version of macOS and automatic update did not resolve it"
    emit_code "homebrew_outdated"
    emit_detail "brew config output: $(marker_safe_text "$probe_output")"
    emit_detail "brew recovery attempts: ${steps_taken:-none}"
    emit_warning "The package manager on this Mac predates this macOS version and automatic update could not repair it. Use the manual step to update it in Terminal, then click Retry."
    return 1
}

get_current_user() {
    if [ -n "${USER:-}" ]; then
        echo "$USER"
        return
    fi
    id -un 2>/dev/null || true
}

is_admin_user() {
    local current_user
    current_user="$(get_current_user)"
    if [ -z "$current_user" ]; then
        return 1
    fi
    if command_exists dseditgroup; then
        dseditgroup -o checkmember -m "$current_user" admin >/dev/null 2>&1
        return $?
    fi
    id -Gn "$current_user" | tr ' ' '\n' | grep -q '^admin$'
}

detect_brew_prefix() {
    if [ -x "/opt/homebrew/bin/brew" ]; then
        echo "/opt/homebrew"
        return 0
    fi

    if [ -x "/usr/local/bin/brew" ]; then
        echo "/usr/local"
        return 0
    fi

    return 1
}

get_homebrew_target_prefix() {
    if [[ $(sysctl -n hw.optional.arm64 2>/dev/null) == "1" ]]; then
        echo "/opt/homebrew"
        return 0
    fi

    if [[ $(uname -m) == "arm64" ]]; then
        echo "/opt/homebrew"
        return 0
    fi

    echo "/usr/local"
    return 0
}

prepare_homebrew_prefix_with_prompt() {
    local brew_prefix="$1"
    local target_user
    target_user="$(get_current_user)"
    local target_group="admin"
    local prep_script
    local status=0

    prep_script=$(mktemp /tmp/portico-brew-prepare.XXXXXX)
    trap 'rm -f "$prep_script"' RETURN
    cat <<EOF > "$prep_script"
#!/bin/bash
set -e
prefix="${brew_prefix}"
user="${target_user}"
group="${target_group}"
mkdir -p "\$prefix" "\$prefix"/{bin,etc,include,lib,sbin,share,var,opt} "\$prefix"/{Homebrew,Caskroom,Cellar}
chown "\$user":"\$group" "\$prefix" "\$prefix"/{bin,etc,include,lib,sbin,share,var,opt}
chown -R "\$user":"\$group" "\$prefix"/{Homebrew,Caskroom,Cellar}
EOF
    chmod +x "$prep_script"

    if /usr/bin/osascript -e "do shell script \"/bin/bash $prep_script\" with administrator privileges"; then
        status=0
    else
        status=$?
    fi
    return $status
}

create_sudo_askpass() {
    local askpass_script
    local cache_file
    askpass_script=$(mktemp /tmp/portico-askpass.XXXXXX)
    cache_file=$(mktemp /tmp/portico-askpass-cache.XXXXXX)
    rm -f "$cache_file"
    ASKPASS_CACHE_FILE="$cache_file"
    cat <<EOF > "$askpass_script"
#!/bin/bash
set -e
cache_file="${cache_file}"
if [ -f "\$cache_file" ]; then
  cat "\$cache_file"
  exit 0
fi
set +e
output=\$(/usr/bin/osascript 2>&1 <<'OSA'
try
  display dialog "Portico needs your computer password to continue installation." default answer "" with hidden answer buttons {"Cancel", "OK"} default button "OK"
  return text returned of result
on error number -128
  error number -128
end try
OSA
)
askpass_status=\$?
set -e
if [ "\$askpass_status" -ne 0 ]; then
  case "\$output" in
    *"-128"*|*"User canceled"*)
      marker="ASKPASS_DIALOG_CANCELLED"
      ;;
    *)
      marker="ASKPASS_OSASCRIPT_FAILURE"
      ;;
  esac
  detail=\$(printf '%s' "\$output" | tr '\r\n' ' ' | tr -s ' ')
  printf '%s status=%s detail=%s\n' "\$marker" "\$askpass_status" "\$detail" >&2
  exit "\$askpass_status"
fi
password="\$output"
umask 077
printf '%s' "\$password" > "\$cache_file"
cat "\$cache_file"
EOF
    chmod 700 "$askpass_script"
    echo "$askpass_script"
}

probe_osascript_context() {
    local output=""
    local status=0

    set +e
    output=$(/usr/bin/osascript -e 'return "ok"' 2>&1)
    status=$?
    set -e

    LAST_OSASCRIPT_CONTEXT_PROBE_STATUS=$status
    LAST_OSASCRIPT_CONTEXT_PROBE_OUTPUT="$output"

    log_info "osascript context probe exit code: ${status}"
    if [ -n "$output" ]; then
        log_info "osascript context probe output: $(marker_safe_text "$output")"
    fi

    [ "$status" -eq 0 ] && [ "$(printf '%s' "$output" | tr -d '\r\n')" = "ok" ]
}

verify_homebrew_sudo_access() {
    local output=""
    local status=0
    local started_at=0
    local ended_at=0

    started_at=$(date +%s)
    set +e
    output="$(sudo -A -v 2>&1)"
    status=$?
    set -e
    ended_at=$(date +%s)

    LAST_HOMEBREW_SUDO_STATUS=$status
    LAST_HOMEBREW_SUDO_OUTPUT="$output"
    LAST_HOMEBREW_AUTH_ELAPSED_SECONDS=$((ended_at - started_at))

    log_info "sudo -A -v exit code: ${status}"
    log_info "sudo -A -v elapsed: ${LAST_HOMEBREW_AUTH_ELAPSED_SECONDS}s"
    if [ -n "$output" ]; then
        while IFS= read -r line || [ -n "$line" ]; do
            [ -n "$line" ] || continue
            log_info "sudo -A -v: $line"
        done <<< "$output"
    else
        log_info "sudo -A -v produced no output"
    fi

    return "$status"
}

classify_homebrew_auth_failure_code() {
    if ! is_admin_user; then
        printf '%s\n' "homebrew_admin_required"
        return 0
    fi

    if [ "${LAST_OSASCRIPT_CONTEXT_PROBE_STATUS:-0}" -ne 0 ]; then
        printf '%s\n' "homebrew_osascript_probe_failed"
        return 0
    fi

    case "${LAST_HOMEBREW_SUDO_OUTPUT:-}" in
        *"ASKPASS_DIALOG_CANCELLED"*)
            printf '%s\n' "homebrew_auth_dialog_cancelled"
            ;;
        *"ASKPASS_OSASCRIPT_FAILURE"*)
            printf '%s\n' "homebrew_osascript_probe_failed"
            ;;
        *)
            printf '%s\n' "homebrew_sudo_validation_failed"
            ;;
    esac
}

homebrew_auth_failure_warning() {
    local code="$1"
    case "$code" in
        homebrew_admin_required)
            printf '%s\n' "Homebrew installation requires administrator access. Please install Homebrew manually or switch to an admin user, then click Retry."
            ;;
        homebrew_osascript_probe_failed)
            printf '%s\n' "Portico could not reopen the macOS authorization helper in this session. Run the Terminal workaround below, then click Retry."
            ;;
        homebrew_auth_dialog_cancelled)
            printf '%s\n' "The macOS authorization dialog was cancelled or closed before setup could continue. Run the Terminal workaround below, then click Retry."
            ;;
        *)
            printf '%s\n' "Administrator authorization failed. Run the Terminal workaround below, then click Retry."
            ;;
    esac
}

emit_homebrew_failure_details() {
    local code="$1"

    emit_code "$code"
    emit_detail "sudo -A -v exit code: ${LAST_HOMEBREW_SUDO_STATUS:-0}"
    emit_detail "sudo -A -v elapsed: ${LAST_HOMEBREW_AUTH_ELAPSED_SECONDS:-0}s"
    if [ -n "${LAST_HOMEBREW_SUDO_OUTPUT:-}" ]; then
        emit_detail "sudo -A -v output: $(marker_safe_text "$LAST_HOMEBREW_SUDO_OUTPUT")"
    fi
    emit_detail "osascript probe exit code: ${LAST_OSASCRIPT_CONTEXT_PROBE_STATUS:-0}"
    if [ -n "${LAST_OSASCRIPT_CONTEXT_PROBE_OUTPUT:-}" ]; then
        emit_detail "osascript probe output: $(marker_safe_text "$LAST_OSASCRIPT_CONTEXT_PROBE_OUTPUT")"
    fi
}

homebrew_skip_auth_retry_requested() {
    [ "${GUIDED_SETUP_SKIP_HOMEBREW_AUTH:-false}" = "true" ]
}

homebrew_skip_auth_retry_code() {
    if [ -n "${GUIDED_SETUP_HOMEBREW_FAILURE_CODE:-}" ]; then
        printf '%s\n' "${GUIDED_SETUP_HOMEBREW_FAILURE_CODE}"
        return 0
    fi

    printf '%s\n' "homebrew_sudo_validation_failed"
}

activate_homebrew_shellenv() {
    local brew_prefix="$1"
    if [ -z "$brew_prefix" ] || [ ! -x "${brew_prefix}/bin/brew" ]; then
        return 1
    fi

    eval "$(${brew_prefix}/bin/brew shellenv)"
    return 0
}

# ============================================================================
# COMMAND LINE DEVELOPER TOOLS (macOS only)
# ============================================================================

command_line_tools_selected_path() {
    xcode-select -p 2>/dev/null || true
}

command_line_tools_receipt_present() {
    pkgutil --pkg-info=com.apple.pkg.CLTools_Executables >/dev/null 2>&1
}

command_line_tools_probe_binary() {
    local developer_dir="$1"
    local candidate

    for candidate in \
        "${developer_dir}/usr/bin/clang" \
        "${developer_dir}/usr/bin/xcodebuild" \
        "${developer_dir}/usr/bin/xcrun" \
        "${developer_dir}/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang"
    do
        if [ -x "$candidate" ]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done

    return 1
}

xcode_select_install_reported_already_installed() {
    printf '%s' "${LAST_XCODE_SELECT_INSTALL_OUTPUT:-}" | grep -Fq "Command line tools are already installed"
}

stale_system_command_line_tools_detected() {
    local selected_path
    selected_path="${1:-$(command_line_tools_selected_path)}"

    [ "$selected_path" = "$SYSTEM_COMMAND_LINE_TOOLS_DIR" ] || return 1
    [ -d "$selected_path" ] || return 1
    [ "${LAST_XCODE_SELECT_INSTALL_STATUS:-0}" -ne 0 ] || return 1
    xcode_select_install_reported_already_installed || return 1
    command_line_tools_receipt_present && return 1
    command_line_tools_probe_binary "$selected_path" >/dev/null 2>&1 && return 1
    return 0
}

remove_system_command_line_tools_directory() {
    /usr/bin/osascript \
        -e 'do shell script "/bin/rm -rf /Library/Developer/CommandLineTools" with administrator privileges' \
        2>/dev/null
}

fail_command_line_tools_step() {
    local message="$1"

    log_warning "$message"
    emit_warning "$message"
    emit_step_failed "command_line_tools"
    emit_error "$message"
    printf '%s\n' "$message" >&2
    return 1
}

command_line_tools_manual_recovery_message() {
    local selected_path
    selected_path="${1:-$(command_line_tools_selected_path)}"

    if stale_system_command_line_tools_detected "$selected_path"; then
        printf '%s\n' \
            "Command Line Developer Tools look partially installed. Open Terminal and run \`sudo rm -rf /Library/Developer/CommandLineTools && xcode-select --install\`, finish Apple's installer, then click Retry."
        return 0
    fi

    if [ -n "$selected_path" ] && ! command_line_tools_probe_binary "$selected_path" >/dev/null 2>&1; then
        printf '%s\n' \
            "The selected Apple developer directory (${selected_path}) is not usable. Repair or reinstall Xcode/Command Line Developer Tools, then click Retry."
        return 0
    fi

    printf '%s\n' \
        "Command Line Developer Tools installation did not start correctly. Run \`xcode-select --install\`, finish Apple's installer, then click Retry."
}

command_line_tools_installed() {
    local verbose="${1:-false}"
    local selected_path
    local probe_path
    selected_path=$(command_line_tools_selected_path)

    if [ -z "$selected_path" ]; then
        if [ "$verbose" = "true" ]; then
            log_info "xcode-select -p returned no developer directory"
        fi
        return 1
    fi

    if [ "$verbose" = "true" ]; then
        log_info "xcode-select -p resolved to: $selected_path"
    fi

    if [ "$selected_path" = "$SYSTEM_COMMAND_LINE_TOOLS_DIR" ]; then
        if command_line_tools_receipt_present; then
            if [ "$verbose" = "true" ]; then
                log_info "Command Line Tools probe passed via CLTools_Executables package"
            fi
            return 0
        fi
        probe_path="$(command_line_tools_probe_binary "$selected_path" || true)"
        if [ -n "$probe_path" ]; then
            if [ "$verbose" = "true" ]; then
                log_info "Command Line Tools probe passed via ${probe_path} without CLTools_Executables receipt"
            fi
            return 0
        fi
        if [ "$verbose" = "true" ]; then
            log_info "Command Line Tools probe failed: CLTools_Executables package not found for $selected_path"
        fi
        return 1
    fi

    probe_path="$(command_line_tools_probe_binary "$selected_path" || true)"
    if [ -n "$probe_path" ]; then
        if [ "$verbose" = "true" ]; then
            log_info "Command Line Tools probe passed via ${probe_path}"
        fi
        return 0
    fi

    if [ "$verbose" = "true" ]; then
        log_info "Command Line Tools probe failed: no supported toolchain binaries found under $selected_path"
    fi

    return 1
}

activate_command_line_tools_dialog() {
    local clt_app="/System/Library/CoreServices/Install Command Line Developer Tools.app"
    if [ -d "$clt_app" ]; then
        open -a "$clt_app" >/dev/null 2>&1 || true
    fi

    local process_name
    process_name="$(command_line_tools_dialog_process_name)"
    if [ -z "$process_name" ]; then
        return 1
    fi

    /usr/bin/osascript <<EOF >/dev/null 2>&1 || true
tell application "System Events"
  if exists (process "$process_name") then
    set frontmost of process "$process_name" to true
  end if
end tell
EOF
    return 0
}

command_line_tools_dialog_process_name() {
    /usr/bin/osascript <<'EOF' 2>/dev/null || true
tell application "System Events"
  if exists (process "Install Command Line Developer Tools") then
    return "Install Command Line Developer Tools"
  end if
  if exists (process "Software Update") then
    return "Software Update"
  end if
end tell
return ""
EOF
}

wait_for_command_line_tools_dialog() {
    local timeout_seconds="${1:-12}"
    local interval_seconds=2
    local elapsed=0

    while [ "$elapsed" -lt "$timeout_seconds" ]; do
        if activate_command_line_tools_dialog; then
            return 0
        fi
        sleep "$interval_seconds"
        elapsed=$((elapsed + interval_seconds))
    done

    return 1
}

request_command_line_tools_install() {
    local output line

    set +e
    output="$(xcode-select --install 2>&1)"
    LAST_XCODE_SELECT_INSTALL_STATUS=$?
    set -e
    LAST_XCODE_SELECT_INSTALL_OUTPUT="$output"

    if [ -n "$output" ]; then
        while IFS= read -r line || [ -n "$line" ]; do
            [ -n "$line" ] || continue
            log_info "xcode-select --install: $line"
        done <<< "$output"
    else
        log_info "xcode-select --install produced no output"
    fi

    log_info "xcode-select --install exit code: ${LAST_XCODE_SELECT_INSTALL_STATUS}"
    return 0
}

repair_stale_command_line_tools() {
    local selected_path
    selected_path=$(command_line_tools_selected_path)

    if ! stale_system_command_line_tools_detected "$selected_path"; then
        return 1
    fi

    log_warning "Stale Command Line Tools installation detected at $selected_path"
    log_info "The directory exists but the package receipt is missing — removing to allow a fresh install..."

    if remove_system_command_line_tools_directory; then
        log_success "Removed stale Command Line Tools directory"
        return 0
    else
        log_warning "Could not remove stale directory (administrator authorization failed or was cancelled)"
        return 1
    fi
}

wait_for_command_line_tools() {
    local timeout_seconds=1800
    local interval_seconds=3
    local elapsed=0

    while ! command_line_tools_installed; do
        if [ "$elapsed" -ge "$timeout_seconds" ]; then
            return 1
        fi
        sleep "$interval_seconds"
        elapsed=$((elapsed + interval_seconds))
        if [ $((elapsed % 15)) -eq 0 ]; then
            activate_command_line_tools_dialog
        fi
    done

    return 0
}

ensure_command_line_tools() {
    local install_requested=false
    local selected_path=""
    local repair_notice=""
    local recovery_message=""

    emit_step_start "command_line_tools"
    log_info "Checking for Command Line Developer Tools..."

    if command_line_tools_installed true; then
        log_success "Command Line Developer Tools are already installed"
        emit_step_complete "command_line_tools"
        return 0
    fi

    log_warning "Command Line Developer Tools not found. Requesting installation..."
    request_command_line_tools_install

    if [ "${LAST_XCODE_SELECT_INSTALL_STATUS:-0}" -eq 0 ]; then
        install_requested=true
    elif stale_system_command_line_tools_detected; then
        repair_notice="Command Line Developer Tools look partially installed. Portico will request administrator access once to repair them and retry Apple's installer."
        log_warning "$repair_notice"
        emit_warning "$repair_notice"

        if ! repair_stale_command_line_tools; then
            recovery_message="$(command_line_tools_manual_recovery_message)"
            fail_command_line_tools_step "$recovery_message"
            return 1
        fi

        log_info "Retrying Command Line Developer Tools installation after repair..."
        request_command_line_tools_install
        if [ "${LAST_XCODE_SELECT_INSTALL_STATUS:-0}" -eq 0 ]; then
            install_requested=true
        else
            recovery_message="$(command_line_tools_manual_recovery_message)"
            fail_command_line_tools_step "$recovery_message"
            return 1
        fi
    else
        selected_path="$(command_line_tools_selected_path)"
        recovery_message="$(command_line_tools_manual_recovery_message "$selected_path")"
        fail_command_line_tools_step "$recovery_message"
        return 1
    fi

    if [ "$install_requested" != "true" ]; then
        recovery_message="$(command_line_tools_manual_recovery_message)"
        fail_command_line_tools_step "$recovery_message"
        return 1
    fi

    if wait_for_command_line_tools_dialog; then
        log_info "Apple Command Line Developer Tools / Software Update window detected"
    else
        local clt_window_warning="Apple Command Line Developer Tools / Software Update window did not appear yet. If it is hidden behind other windows, bring it forward and finish the install."
        log_warning "$clt_window_warning"
        emit_warning "$clt_window_warning"
    fi

    log_info "Waiting for Command Line Developer Tools to finish installing (up to 30 minutes)..."

    if wait_for_command_line_tools; then
        log_success "Command Line Developer Tools installed successfully"
        emit_step_complete "command_line_tools"
        return 0
    fi

    log_warning "Command Line Developer Tools installation timed out"
    emit_step_failed "command_line_tools"
    emit_warning "Command Line Developer Tools installation timed out after 30 minutes. Please complete the Apple Command Line Developer Tools / Software Update window, then click Retry."
    return 1
}

# ============================================================================
# HOMEBREW INSTALLATION (macOS only)
# Cherry-picked from install_v2.sh lines 207-258
# ============================================================================

install_homebrew() {
    emit_step_start "homebrew"
    log_info "Checking for Homebrew installation..."

    if command_exists brew; then
        log_success "Homebrew is already installed at $(which brew)"
        log_info "Current Homebrew version: $(brew --version | head -n 1)"
        if ! ensure_homebrew_supports_host_macos; then
            emit_step_failed "homebrew"
            return 1
        fi
        emit_step_complete "homebrew"
        return 0
    fi

    local existing_brew_prefix
    existing_brew_prefix=$(detect_brew_prefix)
    if [ -n "$existing_brew_prefix" ]; then
        activate_homebrew_shellenv "$existing_brew_prefix"
        log_success "Homebrew is already installed at ${existing_brew_prefix}/bin/brew"
        log_info "Current Homebrew version: $(brew --version | head -n 1)"
        if ! ensure_homebrew_supports_host_macos; then
            emit_step_failed "homebrew"
            return 1
        fi
        emit_step_complete "homebrew"
        return 0
    fi

    log_info "Homebrew not found. Installing Homebrew..."
    log_info "This will install Homebrew package manager"

    local askpass_script=""
    cleanup_askpass() {
        if [ -n "$askpass_script" ]; then
            rm -f "$askpass_script"
        fi
        if [ -n "${ASKPASS_CACHE_FILE:-}" ]; then
            rm -f "$ASKPASS_CACHE_FILE"
        fi
        unset SUDO_ASKPASS
        unset SUDO_ASKPASS_REQUIRE
    }
    trap cleanup_askpass RETURN

    if homebrew_skip_auth_retry_requested; then
        local retry_code
        retry_code="$(homebrew_skip_auth_retry_code)"
        log_warning "Skipping repeated in-app Homebrew authorization attempt for this retry"
        emit_homebrew_failure_details "$retry_code"
        emit_warning "$(homebrew_auth_failure_warning "$retry_code")"
        emit_step_failed "homebrew"
        return 1
    fi

    askpass_script=$(create_sudo_askpass)
    if [ -n "$askpass_script" ]; then
        export SUDO_ASKPASS="$askpass_script"
        export SUDO_ASKPASS_REQUIRE=force
        log_info "An administrator password prompt will appear to continue Homebrew installation."
        if ! verify_homebrew_sudo_access; then
            local failure_code
            probe_osascript_context || true
            failure_code="$(classify_homebrew_auth_failure_code)"
            if [ "$failure_code" = "homebrew_admin_required" ]; then
                log_error "Homebrew installation requires an Administrator account"
            else
                log_error "Administrator authorization failed or was cancelled"
            fi
            emit_homebrew_failure_details "$failure_code"
            emit_warning "$(homebrew_auth_failure_warning "$failure_code")"
            emit_step_failed "homebrew"
            return 1
        fi
    else
        local target_prefix
        target_prefix=$(get_homebrew_target_prefix)

        log_info "Requesting administrator authorization to prepare Homebrew install location..."
        if ! prepare_homebrew_prefix_with_prompt "$target_prefix"; then
            local failure_code
            probe_osascript_context || true
            failure_code="$(classify_homebrew_auth_failure_code)"
            if [ "$failure_code" = "homebrew_admin_required" ]; then
                log_error "Homebrew installation requires an Administrator account"
            else
                log_error "Administrator authorization failed or was cancelled"
            fi
            emit_homebrew_failure_details "$failure_code"
            emit_warning "$(homebrew_auth_failure_warning "$failure_code")"
            emit_step_failed "homebrew"
            return 1
        fi
    fi

    # Run the Homebrew installer
    local install_status=0
    if [[ $(sysctl -n hw.optional.arm64 2>/dev/null) == "1" ]] && [[ $(sysctl -n sysctl.proc_translated 2>/dev/null) == "1" ]]; then
        log_warning "Terminal is running under Rosetta 2 emulation (x86_64 mode on ARM Mac)"
        log_info "Running Homebrew installer under native ARM architecture..."
        if ! HOMEBREW_VERBOSE=1 HOMEBREW_DEBUG=1 NONINTERACTIVE=1 arch -arm64 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"; then
            install_status=1
        fi
    else
        if ! HOMEBREW_VERBOSE=1 HOMEBREW_DEBUG=1 NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"; then
            install_status=1
        fi
    fi

    local installed_brew_prefix=""
    installed_brew_prefix="$(detect_brew_prefix || true)"
    if [ "$install_status" -eq 0 ] || [ -n "$installed_brew_prefix" ]; then
        # Add Homebrew to PATH for different shells
        if [[ "$OSTYPE" == "darwin"* ]]; then
            BREW_PREFIX="${installed_brew_prefix}"
            if [ -z "$BREW_PREFIX" ]; then
                BREW_PREFIX="$(get_homebrew_target_prefix)"
            fi

            # Add to current session
            activate_homebrew_shellenv "$BREW_PREFIX"

            # Add to shell profiles
            log_info "Adding Homebrew to shell profiles..."

            # For zsh (default on macOS)
            if [ -f "$HOME/.zshrc" ]; then
                if ! grep -q 'brew shellenv' "$HOME/.zshrc"; then
                    echo "eval \"${BREW_PREFIX}/bin/brew shellenv\"" >> "$HOME/.zshrc"
                fi
            fi

            # For bash
            if [ -f "$HOME/.bash_profile" ]; then
                if ! grep -q 'brew shellenv' "$HOME/.bash_profile"; then
                    echo "eval \"${BREW_PREFIX}/bin/brew shellenv\"" >> "$HOME/.bash_profile"
                fi
            elif [ -f "$HOME/.bashrc" ]; then
                if ! grep -q 'brew shellenv' "$HOME/.bashrc"; then
                    echo "eval \"${BREW_PREFIX}/bin/brew shellenv\"" >> "$HOME/.bashrc"
                fi
            fi
        fi

        if [ "$install_status" -ne 0 ]; then
            log_warning "Homebrew installer exited non-zero, but Homebrew is now present. Continuing with the detected installation."
        fi
        log_success "Homebrew installed successfully!"
        log_info "Installed version: $(brew --version | head -n 1)"
        if ! ensure_homebrew_supports_host_macos; then
            emit_step_failed "homebrew"
            return 1
        fi
        emit_step_complete "homebrew"
        return 0
    else
        log_error "Failed to install Homebrew"
        emit_step_failed "homebrew"
        return 1
    fi
}

# ============================================================================
# JQ INSTALLATION
# Cherry-picked from install_v2.sh lines 632-712
# ============================================================================

install_jq() {
    emit_step_start "jq"
    log_info "Checking for jq installation..."

    if command_exists jq; then
        log_success "jq is already installed"
        log_info "jq version: $(jq --version)"
        emit_step_complete "jq"
        return 0
    fi

    if [[ "$OSTYPE" == "darwin"* ]]; then
        log_info "Installing jq via Homebrew..."
        local hb_pid
        start_heartbeat "Homebrew (jq install)"; hb_pid="$HEARTBEAT_PID"
        if brew_with_verbose_logs install jq --verbose; then
            stop_heartbeat "$hb_pid"
            log_success "jq installed successfully!"
            log_info "Installed version: $(jq --version)"
            emit_step_complete "jq"
            return 0
        else
            stop_heartbeat "$hb_pid"
            log_error "Failed to install jq"
            emit_step_failed "jq"
            return 1
        fi
    else
        # Linux installation
        log_info "Installing jq on Linux..."

        # Try apt-get first (Debian/Ubuntu)
        if command_exists apt-get; then
            log_info "Using apt-get to install jq..."
            if sudo apt-get update && sudo apt-get install -y jq; then
                log_success "jq installed successfully via apt-get!"
                log_info "Installed version: $(jq --version)"
                emit_step_complete "jq"
                return 0
            fi
        fi

        # Try yum (RHEL/CentOS)
        if command_exists yum; then
            log_info "Using yum to install jq..."
            if sudo yum install -y jq; then
                log_success "jq installed successfully via yum!"
                log_info "Installed version: $(jq --version)"
                emit_step_complete "jq"
                return 0
            fi
        fi

        # Try dnf (newer Fedora)
        if command_exists dnf; then
            log_info "Using dnf to install jq..."
            if sudo dnf install -y jq; then
                log_success "jq installed successfully via dnf!"
                log_info "Installed version: $(jq --version)"
                emit_step_complete "jq"
                return 0
            fi
        fi

        # Try pacman (Arch)
        if command_exists pacman; then
            log_info "Using pacman to install jq..."
            if sudo pacman -S --noconfirm jq; then
                log_success "jq installed successfully via pacman!"
                log_info "Installed version: $(jq --version)"
                emit_step_complete "jq"
                return 0
            fi
        fi

        log_error "Failed to install jq. Please install it manually."
        emit_step_failed "jq"
        return 1
    fi
}

# ============================================================================
# NODE.JS INSTALLATION
# Cherry-picked from install_v2.sh lines 828-902
# ============================================================================

install_node_and_npm() {
    emit_step_start "nodejs"
    log_info "Checking Node.js runtime (required for HOST mode: >= v${NODE_VERSION_REQUIRED})..."
    cleanup_portico_node_shell_integration

    local node_raw=""
    local node_version=""
    local node_bin_dir=""

    if command_exists node; then
        node_raw="$(node --version 2>/dev/null || true)"
        node_version="$(normalize_semver "$node_raw" 2>/dev/null || true)"
        log_info "Detected Node.js version: ${node_raw:-unknown}"
    else
        log_warning "Node.js not found"
    fi

    if command_exists npx; then
        log_info "Detected npx at: $(which npx)"
    else
        log_warning "npx not found"
    fi

    if node_bin_dir="$(resolve_node_runtime_bin_dir)"; then
        export PATH="${node_bin_dir}:${PATH:-}"
        log_success "Node.js runtime satisfies HOST mode requirement"
        log_info "Node.js version: $(node --version)"
        log_info "npm version: $(npm --version)"
        log_info "npx location: $(which npx)"
        log_info "Node.js runtime location: ${node_bin_dir}/node"
        emit_step_complete "nodejs"
        return 0
    fi

    if [ -n "$node_version" ] && ! semver_gte "$node_version" "$NODE_VERSION_REQUIRED"; then
        log_warning "Node.js ${node_raw} is below required v${NODE_VERSION_REQUIRED} for HOST mode"
    fi

    # Install Node.js via direct binary download (works on any macOS/Linux version)
    if [[ "$OSTYPE" == "darwin"* ]] || [[ "$OSTYPE" == "linux-gnu"* ]]; then
        log_info "Installing Node.js v${NODE_VERSION_REQUIRED} via direct binary download from nodejs.org..."

        # Determine platform and architecture
        local node_os="linux"
        local node_arch="x64"
        if [[ "$OSTYPE" == "darwin"* ]]; then
            node_os="darwin"
        fi
        local hw_arch
        hw_arch="$(uname -m)"
        if [[ "$hw_arch" == "arm64" ]] || [[ "$hw_arch" == "aarch64" ]]; then
            node_arch="arm64"
        fi

        local node_ver="v${NODE_VERSION_REQUIRED}"
        local node_tarball="node-${node_ver}-${node_os}-${node_arch}.tar.gz"
        local node_url="https://nodejs.org/dist/${node_ver}/${node_tarball}"
        local node_install_dir="$HOME/.local/lib/nodejs"
        local node_extract_dir="${node_install_dir}/node-${node_ver}-${node_os}-${node_arch}"

        log_info "Download URL: ${node_url}"
        log_info "Install dir: ${node_install_dir}"

        # Create install directory
        if [ ! -d "$node_install_dir" ]; then
            log_info "Creating ${node_install_dir}..."
            mkdir -p "$node_install_dir" 2>/dev/null || true
        fi

        if [ ! -d "$node_install_dir" ] || [ ! -w "$node_install_dir" ]; then
            log_error "Cannot write to ${node_install_dir}"
            node_install_dir="/usr/local/lib/nodejs"
            node_extract_dir="${node_install_dir}/node-${node_ver}-${node_os}-${node_arch}"
            if [ ! -d "$node_install_dir" ]; then
                log_info "Creating ${node_install_dir} (may require admin password)..."
                if ! mkdir -p "$node_install_dir" 2>/dev/null; then
                    /usr/bin/osascript -e "do shell script \"mkdir -p ${node_install_dir} && chown $(whoami) ${node_install_dir}\" with administrator privileges" 2>/dev/null || true
                fi
            fi
        fi

        # Download and extract
        local tmp_tarball
        tmp_tarball=$(mktemp /tmp/portico-node-XXXXXX.tar.gz)
        trap 'rm -f "$tmp_tarball"' RETURN

        local download_ok=false
        if curl -fSL --progress-bar -o "$tmp_tarball" "$node_url" 2>&1; then
            download_ok=true
            log_info "Download complete: ${tmp_tarball}"
        else
            log_error "Failed to download Node.js from ${node_url}"
        fi

        local install_success=false
        if [ "$download_ok" = true ]; then
            # Remove old extraction if present
            rm -rf "$node_extract_dir" 2>/dev/null || true

            if tar -xzf "$tmp_tarball" -C "$node_install_dir" 2>&1; then
                log_info "Extracted to ${node_extract_dir}"

                # Add to PATH for current session
                export PATH="${node_extract_dir}/bin:${PATH:-}"

                install_success=true
            else
                log_error "Failed to extract Node.js tarball"
            fi
        fi

        rm -f "$tmp_tarball" 2>/dev/null || true

        if [ "$install_success" = true ] && node_bin_dir_satisfies_requirement "${node_extract_dir}/bin"; then
            log_success "Node.js runtime is ready for HOST mode"
            log_info "Node.js version: $("${node_extract_dir}/bin/node" --version)"
            log_info "npm version: $("${node_extract_dir}/bin/npm" --version)"
            log_info "npx location: ${node_extract_dir}/bin/npx"
            emit_step_complete "nodejs"
            return 0
        fi

        log_warning "Node.js requirement for HOST mode was not satisfied (required >= v${NODE_VERSION_REQUIRED})"
        log_warning "Continuing setup because HOST mode is optional."
        log_info "Manual fix: install/update Node.js from https://nodejs.org/"
        emit_step_skipped "nodejs"
        return 0
    fi

    log_warning "Automatic Node.js installation only supported on macOS and Linux"
    log_info "Please install/update Node.js manually to >= v${NODE_VERSION_REQUIRED} from https://nodejs.org/"
    log_warning "Continuing setup because HOST mode is optional."
    emit_step_skipped "nodejs"
    return 0
}

install_uv() {
    emit_step_start "uv"
    log_info "Checking for uv installation..."
    export PATH="$HOME/.local/bin:${PATH:-}"

    if command_exists uvx; then
        log_success "uv/uvx is already installed"
        log_info "uvx location: $(which uvx)"
        emit_step_complete "uv"
        return 0
    fi

    log_info "Installing uv/uvx..."
    if curl -LsSf https://astral.sh/uv/install.sh | env UV_UNMANAGED_INSTALL="$HOME/.local/bin" sh; then
        export PATH="$HOME/.local/bin:${PATH:-}"
        log_success "uv/uvx installed successfully!"
        log_info "Installed location: $HOME/.local/bin/uv"
        emit_step_complete "uv"
        return 0
    fi

    log_error "Failed to install uv/uvx"
    emit_step_failed "uv"
    return 1
}

main() {
    emit_phase_start
    log "========================================"
    log "Prerequisites Phase 2: Install Dependencies"
    log "========================================"

    # Track overall success
    local all_success=true
    local stop_remaining=false
    local skip_host_deps="${GUIDED_SETUP_SKIP_HOST_DEPS:-false}"

    # Detect OS
    if [[ "$OSTYPE" == "darwin"* ]]; then
        log_info "Detected macOS"

        # Ensure Command Line Developer Tools are installed before continuing
        if ! ensure_command_line_tools; then
            log_warning "Command Line Developer Tools are required before installing dependencies"
            all_success=false
            stop_remaining=true
        fi

        if [ "$stop_remaining" = false ]; then
            # Install Homebrew first (required for other dependencies on macOS)
            if ! install_homebrew; then
                log_warning "Homebrew installation failed - stopping phase"
                all_success=false
                stop_remaining=true
            fi
        fi

        if [ "$stop_remaining" = false ]; then
            # Install jq
            if ! install_jq; then
                log_warning "jq installation failed - stopping phase"
                all_success=false
                stop_remaining=true
            fi
        fi

        if [ "$stop_remaining" = false ]; then
            # Install Node.js for host-capable power-user setup only
            if [ "$skip_host_deps" = "true" ]; then
                emit_step_start "nodejs"
                cleanup_portico_node_shell_integration
                emit_step_skipped "nodejs"
                log_info "Skipping Node.js installation for basic setup"
            elif ! install_node_and_npm; then
                log_warning "Node.js checks encountered issues - continuing (HOST mode is optional)"
            fi
        fi

        if [ "$stop_remaining" = false ]; then
            # Install uv/uvx only for power-user setup
            if [ "$skip_host_deps" = "true" ]; then
                emit_step_start "uv"
                emit_step_skipped "uv"
                log_info "Skipping uv/uvx installation for basic setup"
            elif ! install_uv; then
                log_warning "uv/uvx installation failed - stopping phase"
                all_success=false
                stop_remaining=true
            fi
        fi

        if [ "$stop_remaining" = true ]; then
            log_warning "Skipping remaining dependency installs due to previous failure"
        fi

    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        log_info "Detected Linux"

        # Install jq
        if ! install_jq; then
            log_warning "jq installation failed - stopping phase"
            all_success=false
            stop_remaining=true
        fi

        if [ "$stop_remaining" = false ]; then
            # Node.js is needed only for host-capable power-user setup.
            if [ "$skip_host_deps" = "true" ]; then
                emit_step_start "nodejs"
                cleanup_portico_node_shell_integration
                emit_step_skipped "nodejs"
                log_info "Skipping Node.js installation for basic setup"
            elif ! install_node_and_npm; then
                log_warning "Node.js checks encountered issues - continuing (HOST mode is optional)"
            fi
        fi

        if [ "$stop_remaining" = false ]; then
            # Install uv/uvx only for power-user setup
            if [ "$skip_host_deps" = "true" ]; then
                emit_step_start "uv"
                emit_step_skipped "uv"
                log_info "Skipping uv/uvx installation for basic setup"
            elif ! install_uv; then
                log_warning "uv/uvx installation failed - stopping phase"
                all_success=false
                stop_remaining=true
            fi
        fi

        if [ "$stop_remaining" = true ]; then
            log_warning "Skipping remaining dependency installs due to previous failure"
        fi
    else
        log_warning "Unsupported operating system: $OSTYPE"
        log_info "Skipping automatic dependency installation"
    fi

    emit_phase_complete
    log "========================================"
    log "Phase 2 Complete: Install Dependencies"
    if [ "$all_success" = true ]; then
        log "Status: All dependencies installed successfully"
    else
        log "Status: Some dependencies had issues (see above)"
    fi
    log "========================================"

    if [ "$all_success" = true ]; then
        exit 0
    fi
    exit 1
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    main "$@"
fi
