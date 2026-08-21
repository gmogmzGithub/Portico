#!/bin/bash

# prereq-docker-setup.sh - Prerequisites Phase 3: Docker/OrbStack Setup
# Cherry-picked from install_v2.sh for Electron guided setup wizard
# This script handles:
#   - OrbStack installation (macOS Docker runtime)
#   - OrbStack resource configuration (memory, CPU)
#
# NOTE: This script does NOT include Docker image pulling - that's handled
# in JavaScript for GUI progress bars with per-layer detail. The pull plan is
# mode-aware and is derived after Phase 3 from the preserved runtime settings
# (for example, MCP_ORC_MODE=rust-full and LLM_GATEWAY_MODE=bifrost).
#
# Progress markers emitted for Electron app:
#   [PREREQ:PHASE:3:START]
#   [PREREQ:STEP:<step>:START]
#   [PREREQ:STEP:<step>:COMPLETE]
#   [PREREQ:STEP:<step>:SKIPPED]
#   [PREREQ:STEP:<step>:FAILED]
#   [PREREQ:PHASE:3:COMPLETE]
#   [PREREQ:ERROR:<message>]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/mcp-orc-backend.sh"

# ============================================================================
# LOGGING FUNCTIONS
# ============================================================================

emit_phase_start() {
    echo "[PREREQ:PHASE:3:START]"
}

emit_phase_complete() {
    echo "[PREREQ:PHASE:3:COMPLETE]"
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

emit_progress() {
    echo "[PREREQ:PROGRESS:$1:$2]"
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

is_homebrew_macos_unsupported_output() {
    # Matches the MacOSVersion::Error raised by a Homebrew install that
    # predates the host macOS release (PORTICO-229). The pattern deliberately
    # avoids quote characters so it matches every Ruby quoting variant.
    # Kept in sync with prereq-dependencies.sh (each prereq script is
    # deliberately self-contained).
    printf '%s' "${1:-}" | grep -qiE 'MacOSVersion::Error|unknown or unsupported macOS version'
}

is_homebrew_version_older_than() {
    local version_output="${1:-}"
    local minimum_version="$2"
    local current_major current_minor current_patch
    local minimum_major minimum_minor minimum_patch

    if [[ ! "$version_output" =~ Homebrew[[:space:]]+([0-9]+)\.([0-9]+)(\.([0-9]+))? ]]; then
        return 1
    fi
    current_major="${BASH_REMATCH[1]}"
    current_minor="${BASH_REMATCH[2]}"
    current_patch="${BASH_REMATCH[4]:-0}"
    IFS='.' read -r minimum_major minimum_minor minimum_patch <<< "$minimum_version"

    if (( current_major != minimum_major )); then
        (( current_major < minimum_major ))
        return
    fi
    if (( current_minor != minimum_minor )); then
        (( current_minor < minimum_minor ))
        return
    fi
    (( current_patch < minimum_patch ))
}

prepend_path_once() {
    local entry="$1"
    if [ -z "$entry" ] || [ ! -d "$entry" ]; then
        return 0
    fi

    case ":$PATH:" in
        *":$entry:"*) ;;
        *) PATH="$entry:$PATH" ;;
    esac
}

ORBSTACK_WAIT_TIMEOUT_SECONDS=600
ORBSTACK_FIRST_LAUNCH_TIMEOUT_SECONDS=120
ORBSTACK_FATAL_ERROR_MESSAGE=""
# OrbStack's cask uses postflight_steps with the run step; Homebrew 6.0.13 is
# the first release that can parse both when fetch falls back to cask source.
ORBSTACK_MINIMUM_HOMEBREW_VERSION="6.0.13"
ORBSTACK_SYSTEM_APP_PATH="/Applications/OrbStack.app"
ORBSTACK_USER_APP_PATH="${HOME}/Applications/OrbStack.app"
ORBSTACK_APP_PATH="$ORBSTACK_SYSTEM_APP_PATH"
ORBSTACK_BIN_PATH="${ORBSTACK_APP_PATH}/Contents/MacOS/bin"
ORBSTACK_XBIN_PATH="${ORBSTACK_APP_PATH}/Contents/MacOS/xbin"
ORBSTACK_EXPECTED_IDENTIFIER="dev.kdrag0n.MacVirt"
ORBSTACK_EXPECTED_TEAM_ID="HUAQ24HBR6"
ORBSTACK_INSTALL_TMP_DIR=""
ORBSTACK_INSTALL_MOUNT_POINT=""
ORBSTACK_INSTALL_STAGING_PATH=""
ORBSTACK_INSTALL_DMG_MOUNTED=0
ORBSTACK_VERIFICATION_CODE=""
ORBSTACK_VERIFICATION_DETAIL=""
ORBSTACK_PREPARATION_CODE=""
ORBSTACK_PREPARATION_DETAIL=""
ORBSTACK_PROCESS_LOCATION_CODE=""
ORBSTACK_PROCESS_LOCATION_DETAIL=""

set_orbstack_app_path() {
    local app_path="$1"
    ORBSTACK_APP_PATH="$app_path"
    ORBSTACK_BIN_PATH="${ORBSTACK_APP_PATH}/Contents/MacOS/bin"
    ORBSTACK_XBIN_PATH="${ORBSTACK_APP_PATH}/Contents/MacOS/xbin"
}

resolve_orbstack_app_path() {
    if [ -d "$ORBSTACK_SYSTEM_APP_PATH" ]; then
        set_orbstack_app_path "$ORBSTACK_SYSTEM_APP_PATH"
        return 0
    fi

    if [ -d "$ORBSTACK_USER_APP_PATH" ]; then
        set_orbstack_app_path "$ORBSTACK_USER_APP_PATH"
        return 0
    fi

    set_orbstack_app_path "$ORBSTACK_SYSTEM_APP_PATH"
    return 1
}

ensure_orbstack_cli_on_path() {
    prepend_path_once "$ORBSTACK_XBIN_PATH"
    prepend_path_once "$ORBSTACK_BIN_PATH"
}

emit_orbstack_failure() {
    local code="$1"
    local message="$2"
    local detail="${3:-}"

    emit_code "$code"
    if [ -n "$detail" ]; then
        emit_detail "$(marker_safe_text "$detail")"
    fi
    emit_error "$message"
}

cleanup_orbstack_install_workspace() {
    if [ "$ORBSTACK_INSTALL_DMG_MOUNTED" -eq 1 ] && [ -n "$ORBSTACK_INSTALL_MOUNT_POINT" ]; then
        hdiutil detach "$ORBSTACK_INSTALL_MOUNT_POINT" >/dev/null 2>&1 || true
    fi
    ORBSTACK_INSTALL_DMG_MOUNTED=0

    if [ -n "$ORBSTACK_INSTALL_STAGING_PATH" ] && [ -e "$ORBSTACK_INSTALL_STAGING_PATH" ]; then
        rm -rf "$ORBSTACK_INSTALL_STAGING_PATH" || true
    fi
    if [ -n "$ORBSTACK_INSTALL_TMP_DIR" ] && [ -d "$ORBSTACK_INSTALL_TMP_DIR" ]; then
        rm -rf "$ORBSTACK_INSTALL_TMP_DIR" || true
    fi

    ORBSTACK_INSTALL_TMP_DIR=""
    ORBSTACK_INSTALL_MOUNT_POINT=""
    ORBSTACK_INSTALL_STAGING_PATH=""
}

verify_orbstack_app_bundle() {
    local app_path="$1"
    local verify_output=""
    local details_output=""
    local gatekeeper_output=""

    ORBSTACK_VERIFICATION_CODE=""
    ORBSTACK_VERIFICATION_DETAIL=""

    verify_output=$(codesign --verify --deep --strict --verbose=2 "$app_path" 2>&1) || {
        ORBSTACK_VERIFICATION_CODE="orbstack_signature_invalid"
        ORBSTACK_VERIFICATION_DETAIL="$verify_output"
        return 1
    }

    details_output=$(codesign -d --verbose=4 "$app_path" 2>&1) || {
        ORBSTACK_VERIFICATION_CODE="orbstack_signature_invalid"
        ORBSTACK_VERIFICATION_DETAIL="$details_output"
        return 1
    }

    if ! printf '%s\n' "$details_output" | grep -Fqx "Identifier=${ORBSTACK_EXPECTED_IDENTIFIER}" \
        || ! printf '%s\n' "$details_output" | grep -Fqx "TeamIdentifier=${ORBSTACK_EXPECTED_TEAM_ID}"; then
        ORBSTACK_VERIFICATION_CODE="orbstack_identity_mismatch"
        ORBSTACK_VERIFICATION_DETAIL="$details_output"
        return 1
    fi

    gatekeeper_output=$(spctl --assess --type execute --verbose=4 "$app_path" 2>&1) || {
        ORBSTACK_VERIFICATION_CODE="orbstack_gatekeeper_rejected"
        ORBSTACK_VERIFICATION_DETAIL="$gatekeeper_output"
        return 1
    }

    return 0
}

strip_orbstack_quarantine() {
    local app_path="$1"
    local clear_output=""
    local remaining_xattrs=""

    ORBSTACK_PREPARATION_CODE=""
    ORBSTACK_PREPARATION_DETAIL=""

    remaining_xattrs=$(xattr -r "$app_path" 2>&1) || {
        ORBSTACK_PREPARATION_CODE="orbstack_quarantine_cleanup_failed"
        ORBSTACK_PREPARATION_DETAIL="$remaining_xattrs"
        return 1
    }
    if ! printf '%s\n' "$remaining_xattrs" | grep -Fq ": com.apple.quarantine"; then
        return 0
    fi

    clear_output=$(xattr -dr com.apple.quarantine "$app_path" 2>&1) || {
        ORBSTACK_PREPARATION_CODE="orbstack_quarantine_cleanup_failed"
        ORBSTACK_PREPARATION_DETAIL="$clear_output"
        return 1
    }

    remaining_xattrs=$(xattr -r "$app_path" 2>&1) || {
        ORBSTACK_PREPARATION_CODE="orbstack_quarantine_cleanup_failed"
        ORBSTACK_PREPARATION_DETAIL="$remaining_xattrs"
        return 1
    }
    if printf '%s\n' "$remaining_xattrs" | grep -Fq ": com.apple.quarantine"; then
        ORBSTACK_PREPARATION_CODE="orbstack_quarantine_cleanup_failed"
        ORBSTACK_PREPARATION_DETAIL="The copied OrbStack application is still quarantined"
        return 1
    fi

    log_success "Removed download quarantine from the verified OrbStack application"
    return 0
}

prepare_orbstack_app_for_first_launch() {
    if ! verify_orbstack_app_bundle "$ORBSTACK_APP_PATH"; then
        ORBSTACK_PREPARATION_CODE="${ORBSTACK_VERIFICATION_CODE:-orbstack_signature_invalid}"
        ORBSTACK_PREPARATION_DETAIL="$ORBSTACK_VERIFICATION_DETAIL"
        return 1
    fi

    strip_orbstack_quarantine "$ORBSTACK_APP_PATH"
}

resolve_orbctl_path() {
    ensure_orbstack_cli_on_path

    if command_exists orbctl; then
        command -v orbctl
        return 0
    fi

    if [ -x "${ORBSTACK_BIN_PATH}/orbctl" ]; then
        echo "${ORBSTACK_BIN_PATH}/orbctl"
        return 0
    fi

    return 1
}

resolve_docker_path() {
    ensure_orbstack_cli_on_path

    if command_exists docker; then
        command -v docker
        return 0
    fi

    if [ -x "${ORBSTACK_XBIN_PATH}/docker" ]; then
        echo "${ORBSTACK_XBIN_PATH}/docker"
        return 0
    fi

    return 1
}

run_orbctl() {
    local orbctl_path
    orbctl_path=$(resolve_orbctl_path) || return 127
    "$orbctl_path" "$@"
}

run_docker() {
    local docker_path
    docker_path=$(resolve_docker_path) || return 127
    "$docker_path" "$@"
}

set_orbstack_config_option() {
    local key="$1"
    local value="$2"
    local output=""
    local status=0

    output=$(run_orbctl config set "$key" "$value" 2>&1) || status=$?
    if [ -n "$output" ]; then
        echo "$output" | grep -v "Restart OrbStack" || true
    fi

    return "$status"
}

docker_is_ready() {
    run_docker info >/dev/null 2>&1
}

orbstack_is_active_for_docker() {
    local active_context=""
    local docker_state=""
    local status_text=""

    active_context="$(get_active_docker_context)"
    docker_state="$(get_orbstack_docker_state | tr '[:upper:]' '[:lower:]')"
    status_text="$(get_orbstack_status_text | tr '[:upper:]' '[:lower:]')"

    [ "$active_context" = "orbstack" ] \
        || [[ "$docker_state" == *running* ]] \
        || [[ "$status_text" == *running* ]]
}

ensure_docker_compose_frontend() {
    ensure_orbstack_cli_on_path
    reset_docker_compose_frontend_cache

    if resolve_docker_compose_frontend; then
        log_success "Docker Compose frontend: $DOCKER_COMPOSE_FRONTEND_RESOLVED"
        return 0
    fi

    if [[ "$OSTYPE" == "darwin"* ]] \
        && [ -d "$ORBSTACK_APP_PATH" ] \
        && resolve_orbctl_path >/dev/null 2>&1 \
        && docker_is_ready \
        && orbstack_is_active_for_docker; then
        log_warning "Docker is running, but neither Docker Compose v2 frontend is available. Restarting OrbStack once before rechecking."
        if run_orbctl restart -a >/dev/null 2>&1; then
            local elapsed=0
            while [ "$elapsed" -lt 60 ]; do
                if docker_is_ready; then
                    break
                fi
                sleep 2
                elapsed=$((elapsed + 2))
            done
        fi

        reset_docker_compose_frontend_cache
        if resolve_docker_compose_frontend; then
            log_success "Docker Compose frontend recovered after OrbStack restart: $DOCKER_COMPOSE_FRONTEND_RESOLVED"
            return 0
        fi
    fi

    emit_docker_compose_unavailable
    emit_code "docker_compose_unavailable"
    emit_error "Docker is running, but no usable Docker Compose v2 frontend is available. Fully quit and reopen OrbStack, then retry."
    return 1
}

get_orbstack_status_text() {
    local status=""
    status=$(run_orbctl status 2>&1 || true)
    echo "$status" | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//'
}

get_orbstack_docker_state() {
    local info_output=""
    info_output=$(run_orbctl info docker 2>/dev/null || true)
    echo "$info_output" | awk -F': ' '/^State:/ {print $2; exit}'
}

get_active_docker_context() {
    run_docker context show 2>/dev/null || true
}

ensure_orbstack_docker_context() {
    if ! resolve_docker_path >/dev/null 2>&1; then
        return 1
    fi

    if ! run_docker context inspect orbstack >/dev/null 2>&1; then
        return 1
    fi

    local current_context
    current_context=$(get_active_docker_context)
    if [ "$current_context" = "orbstack" ]; then
        return 0
    fi

    log_info "Switching Docker context to orbstack..."
    if run_docker context use orbstack >/dev/null 2>&1; then
        log_success "Active Docker context set to orbstack"
        return 0
    fi

    log_warning "Failed to switch active Docker context to orbstack"
    return 1
}

log_orbstack_diagnostics() {
    if ! resolve_orbctl_path >/dev/null 2>&1; then
        return 0
    fi

    log_info "OrbStack diagnostics: orbctl status"
    run_orbctl status 2>&1 || true

    log_info "OrbStack diagnostics: orbctl info docker --format json"
    run_orbctl info docker --format json 2>&1 || true

    if resolve_docker_path >/dev/null 2>&1; then
        log_info "OrbStack diagnostics: docker context ls"
        run_docker context ls 2>&1 || true
    fi

    log_info "OrbStack diagnostics: orbctl doctor"
    run_orbctl doctor 2>&1 || true
}

seed_orbstack_onboarding_preferences() {
    local move_prompt_value=""

    if ! command_exists defaults; then
        log_warning "Unable to configure OrbStack first-launch preferences"
        return 1
    fi

    log_info "Seeding OrbStack onboarding preferences..."
    if defaults write dev.kdrag0n.MacVirt onboardingCompleted -bool true \
        && defaults write dev.kdrag0n.MacVirt selectedTab -string docker \
        && defaults write dev.kdrag0n.MacVirt onboarding_showMoveToApplicationsPopup -bool false; then
        move_prompt_value=$(defaults read dev.kdrag0n.MacVirt onboarding_showMoveToApplicationsPopup 2>/dev/null || true)
        if [ "$move_prompt_value" = "0" ]; then
            log_success "Seeded OrbStack onboarding preferences for Docker"
            return 0
        fi
    fi

    log_warning "Unable to configure OrbStack first-launch preferences"
    return 1
}

configure_orbstack_headless_defaults() {
    seed_orbstack_onboarding_preferences || true

    if ! resolve_orbctl_path >/dev/null 2>&1; then
        return 0
    fi

    log_info "Applying headless OrbStack defaults..."
    if set_orbstack_config_option "setup.use_admin" "false"; then
        log_success "Configured OrbStack to avoid admin prompts during headless startup"
    else
        log_warning "Unable to set OrbStack headless defaults; continuing"
    fi
}

check_virtualization_support() {
    if ! command_exists sysctl; then
        return 0
    fi

    local hv_support=""
    hv_support=$(sysctl -n kern.hv_support 2>/dev/null || true)
    if [ -z "$hv_support" ]; then
        return 0
    fi
    if [ "$hv_support" -eq 0 ]; then
        log_error "Hardware virtualization is not available. OrbStack cannot run inside a macOS VM."
        emit_error "Hardware virtualization unavailable. OrbStack cannot run inside a macOS VM (e.g., VirtualBuddy). Use a physical Mac or a remote Docker engine."
        return 1
    fi

    return 0
}

activate_orbstack_app() {
    if [ ! -d "$ORBSTACK_APP_PATH" ]; then
        return 1
    fi

    # Launch the exact bundle hidden and in the background so guided setup
    # stays frontmost. Any first-launch confirmation remains owned by macOS.
    open -gj "$ORBSTACK_APP_PATH" >/dev/null 2>&1
}

wait_for_orbstack_process() {
    local timeout_seconds="${1:-${ORBSTACK_FIRST_LAUNCH_TIMEOUT_SECONDS}}"
    local elapsed=0
    local interval=2

    while [ "$elapsed" -lt "$timeout_seconds" ]; do
        if pgrep -x OrbStack >/dev/null 2>&1; then
            return 0
        fi
        sleep "$interval"
        elapsed=$((elapsed + interval))
    done

    return 1
}

validate_orbstack_process_location() {
    local pids=""
    local pid=""
    local process_command=""
    local expected_system_command="${ORBSTACK_SYSTEM_APP_PATH}/Contents/MacOS/OrbStack"
    local expected_user_command="${ORBSTACK_USER_APP_PATH}/Contents/MacOS/OrbStack"

    ORBSTACK_PROCESS_LOCATION_CODE=""
    ORBSTACK_PROCESS_LOCATION_DETAIL=""

    pids=$(pgrep -x OrbStack 2>/dev/null || true)
    if [ -z "$pids" ]; then
        ORBSTACK_PROCESS_LOCATION_CODE="orbstack_launch_failed"
        ORBSTACK_PROCESS_LOCATION_DETAIL="OrbStack exited before its launch path could be verified"
        return 1
    fi

    for pid in $pids; do
        process_command=$(ps -ww -p "$pid" -o command= 2>/dev/null || true)
        if [ -z "$process_command" ]; then
            ORBSTACK_PROCESS_LOCATION_CODE="orbstack_launch_failed"
            ORBSTACK_PROCESS_LOCATION_DETAIL="Unable to inspect the running OrbStack process"
            return 1
        fi

        case "$process_command" in
            *"/AppTranslocation/"*)
                ORBSTACK_PROCESS_LOCATION_CODE="orbstack_translocated_launch"
                ORBSTACK_PROCESS_LOCATION_DETAIL="$process_command"
                return 1
                ;;
            "$expected_system_command"|"$expected_system_command "*|"$expected_user_command"|"$expected_user_command "*)
                ;;
            *)
                ORBSTACK_PROCESS_LOCATION_CODE="orbstack_unexpected_launch_path"
                ORBSTACK_PROCESS_LOCATION_DETAIL="$process_command"
                return 1
                ;;
        esac
    done

    log_success "OrbStack is running from a verified Applications path"
    return 0
}

ensure_running_orbstack_is_safe() {
    if ! pgrep -x OrbStack >/dev/null 2>&1; then
        return 0
    fi

    if ! seed_orbstack_onboarding_preferences; then
        ORBSTACK_PROCESS_LOCATION_CODE="orbstack_first_launch_preferences_failed"
        ORBSTACK_PROCESS_LOCATION_DETAIL="OrbStack relocation prompt suppression could not be confirmed"
        return 1
    fi

    validate_orbstack_process_location
}

launch_new_orbstack_app() {
    emit_step_start "orbstack_approval"
    if ! seed_orbstack_onboarding_preferences; then
        emit_step_failed "orbstack_approval"
        emit_orbstack_failure "orbstack_first_launch_preferences_failed" \
            "OrbStack first-launch safety settings could not be saved"
        return 1
    fi

    emit_progress "orbstack_launch_state" "awaiting_approval"
    log_info "Launching OrbStack in the background. macOS may ask the user to click Open once."

    if ! activate_orbstack_app; then
        emit_step_failed "orbstack_approval"
        emit_orbstack_failure "orbstack_launch_failed" \
            "OrbStack could not be opened after installation" \
            "open -gj failed for $ORBSTACK_APP_PATH"
        return 1
    fi

    if ! wait_for_orbstack_process "$ORBSTACK_FIRST_LAUNCH_TIMEOUT_SECONDS"; then
        emit_step_failed "orbstack_approval"
        emit_orbstack_failure "orbstack_launch_approval_timeout" \
            "macOS did not finish opening OrbStack" \
            "OrbStack did not launch within ${ORBSTACK_FIRST_LAUNCH_TIMEOUT_SECONDS} seconds"
        return 1
    fi

    if ! validate_orbstack_process_location; then
        emit_step_failed "orbstack_approval"
        emit_orbstack_failure \
            "${ORBSTACK_PROCESS_LOCATION_CODE:-orbstack_launch_failed}" \
            "OrbStack did not launch from its verified Applications folder" \
            "$ORBSTACK_PROCESS_LOCATION_DETAIL"
        return 1
    fi

    emit_progress "orbstack_launch_state" "approved"
    emit_step_complete "orbstack_approval"
    log_success "OrbStack first launch approved"
    return 0
}

wait_for_docker_ready() {
    local timeout_seconds="${1:-${ORBSTACK_WAIT_TIMEOUT_SECONDS}}"
    local elapsed=0
    local interval=5
    local context_attempted=0

    while [ "$elapsed" -lt "$timeout_seconds" ]; do
        if docker_is_ready; then
            return 0
        fi

        if [ "$context_attempted" -eq 0 ]; then
            if ensure_orbstack_docker_context; then
                context_attempted=1
                if docker_is_ready; then
                    return 0
                fi
            elif resolve_docker_path >/dev/null 2>&1 && run_docker context inspect orbstack >/dev/null 2>&1; then
                context_attempted=1
            fi
        fi

        if [ $((elapsed % 30)) -eq 0 ] && resolve_orbctl_path >/dev/null 2>&1; then
            local status
            local docker_state
            status=$(get_orbstack_status_text)
            docker_state=$(get_orbstack_docker_state)
            if [ -n "$status" ]; then
                if [ -n "$docker_state" ]; then
                    log_info "OrbStack status: ${status} (docker target: ${docker_state})"
                else
                    log_info "OrbStack status: ${status}"
                fi
            fi
        fi

        if [ $((elapsed % 60)) -eq 0 ]; then
            log_info "Waiting for Docker to be ready... (${elapsed}s elapsed)"
        fi

        sleep "$interval"
        elapsed=$((elapsed + interval))
    done

    return 1
}

is_orbstack_vmgr_error() {
    local output="$1"
    if [ -z "$output" ]; then
        return 1
    fi

    if echo "$output" | grep -qiE "vmgr|VM exited unexpectedly|panic:"; then
        return 0
    fi
    return 1
}

start_orbstack_headless() {
    local attempt=1
    local max_attempts=3
    ORBSTACK_FATAL_ERROR_MESSAGE=""

    ensure_orbstack_cli_on_path
    configure_orbstack_headless_defaults

    while [ "$attempt" -le "$max_attempts" ]; do
        log_info "Starting OrbStack headlessly (attempt ${attempt}/${max_attempts})..."

        local start_output=""
        local start_status=0
        start_output=$(run_orbctl start docker 2>&1) || start_status=$?
        if [ -n "$start_output" ]; then
            echo "$start_output"
        fi

        if is_orbstack_vmgr_error "$start_output"; then
            log_error "OrbStack VM manager reported a fatal error"
            ORBSTACK_FATAL_ERROR_MESSAGE="OrbStack failed to start its VM. This environment might not support OrbStack."
            return 1
        fi

        if [ "$start_status" -ne 0 ]; then
            log_warning "OrbStack reported a start error (attempt ${attempt}); will retry"
        fi

        log_info "Waiting for OrbStack to initialize Docker (up to $((ORBSTACK_WAIT_TIMEOUT_SECONDS / 60)) minutes)..."
        if wait_for_docker_ready "$ORBSTACK_WAIT_TIMEOUT_SECONDS"; then
            ensure_orbstack_docker_context >/dev/null 2>&1 || true
            if docker_is_ready; then
                log_success "OrbStack is ready"
                return 0
            fi
        fi

        log_warning "OrbStack headless startup did not make Docker ready on attempt ${attempt}"
        log_orbstack_diagnostics
        attempt=$((attempt + 1))
    done

    return 1
}

start_orbstack_hidden_fallback() {
    local attempt=1
    local max_attempts=3

    while [ "$attempt" -le "$max_attempts" ]; do
        log_info "Retrying OrbStack after a hidden app launch (attempt ${attempt}/${max_attempts})..."
        activate_orbstack_app || true

        local start_output=""
        local start_status=0
        start_output=$(run_orbctl start docker 2>&1) || start_status=$?
        if [ -n "$start_output" ]; then
            echo "$start_output"
        fi

        if is_orbstack_vmgr_error "$start_output"; then
            log_error "OrbStack VM manager reported a fatal error"
            ORBSTACK_FATAL_ERROR_MESSAGE="OrbStack failed to start its VM. This environment might not support OrbStack."
            return 1
        fi

        if [ "$start_status" -ne 0 ]; then
            log_warning "OrbStack reported a start error after hidden launch (attempt ${attempt}); will retry"
        fi

        log_info "Waiting for OrbStack to initialize Docker (up to $((ORBSTACK_WAIT_TIMEOUT_SECONDS / 60)) minutes)..."
        if wait_for_docker_ready "$ORBSTACK_WAIT_TIMEOUT_SECONDS"; then
            ensure_orbstack_docker_context >/dev/null 2>&1 || true
            if docker_is_ready; then
                log_success "OrbStack is ready"
                return 0
            fi
        fi

        log_warning "OrbStack hidden-launch retry did not make Docker ready on attempt ${attempt}"
        attempt=$((attempt + 1))
    done

    return 1
}

start_orbstack_vm() {
    if start_orbstack_headless; then
        return 0
    fi

    if [ -n "$ORBSTACK_FATAL_ERROR_MESSAGE" ]; then
        return 1
    fi

    log_warning "Headless OrbStack startup failed; retrying after a hidden app launch"
    start_orbstack_hidden_fallback
}

# ============================================================================
# DOCKER CHECK FUNCTION
# ============================================================================

check_docker() {
    log_info "Checking for Docker installation..."

    ensure_orbstack_cli_on_path

    if resolve_docker_path >/dev/null 2>&1; then
        if docker_is_ready; then
            log_success "Docker is installed and running"
            log_info "Docker version: $(run_docker --version)"
            return 0
        else
            log_info "Docker is installed but not running"
            return 1
        fi
    else
        log_info "Docker not found"
        return 1
    fi
}

# ============================================================================
# ORBSTACK INSTALLATION (macOS only)
# ============================================================================

fail_orbstack_install_step() {
    local code="$1"
    local message="$2"
    local detail="${3:-}"

    log_error "$message"
    cleanup_orbstack_install_workspace
    emit_orbstack_failure "$code" "$message" "$detail"
    emit_step_failed "orbstack"
}

download_and_install_orbstack() {
    local brew_output=""
    local brew_version_output=""
    local brew_update_output=""
    local brew_update_status=0
    local dmg_path=""
    local mount_output=""
    local source_app=""
    local target_dir=""
    local copy_output=""
    local move_output=""

    log_info "Downloading the verified OrbStack application with Homebrew..."
    brew_output=$(brew fetch --cask --retry orbstack 2>&1) || {
        brew_version_output=$(brew --version 2>&1) || true
        if is_homebrew_version_older_than "$brew_version_output" "$ORBSTACK_MINIMUM_HOMEBREW_VERSION"; then
            log_warning "Homebrew is older than ${ORBSTACK_MINIMUM_HOMEBREW_VERSION} and could not fetch OrbStack; updating Homebrew before retrying..."
            brew_update_output=$(NONINTERACTIVE=1 brew update 2>&1) || brew_update_status=$?
            if [ -n "$brew_update_output" ]; then
                printf '%s\n' "$brew_update_output"
            fi
            if [ "$brew_update_status" -ne 0 ]; then
                log_warning "Homebrew update exited nonzero; checking whether it updated enough to fetch OrbStack"
            fi

            log_info "Retrying the verified OrbStack download after the Homebrew update..."
            brew_output=$(brew fetch --cask --retry orbstack 2>&1) || {
                brew_version_output=$(brew --version 2>&1) || true
                if is_homebrew_version_older_than "$brew_version_output" "$ORBSTACK_MINIMUM_HOMEBREW_VERSION" \
                    || is_homebrew_macos_unsupported_output "$brew_output"; then
                    fail_orbstack_install_step "homebrew_outdated" \
                        "Homebrew is too old to download OrbStack" "$brew_output"
                else
                    fail_orbstack_install_step "orbstack_download_failed" \
                        "Failed to download OrbStack after updating Homebrew" "$brew_output"
                fi
                return 1
            }
            log_success "Homebrew updated and can now download OrbStack"
        elif is_homebrew_macos_unsupported_output "$brew_output"; then
            # Not a download problem: Homebrew itself predates this macOS
            # release and crashes before fetching anything (PORTICO-229).
            fail_orbstack_install_step "homebrew_outdated" \
                "Homebrew is too old for this version of macOS" "$brew_output"
            return 1
        else
            fail_orbstack_install_step "orbstack_download_failed" \
                "Failed to download OrbStack" "$brew_output"
            return 1
        fi
    }
    if [ -n "$brew_output" ]; then
        printf '%s\n' "$brew_output"
    fi

    dmg_path=$(brew --cache --cask orbstack 2>&1) || {
        fail_orbstack_install_step "orbstack_cache_resolution_failed" \
            "Failed to locate the verified OrbStack download" "$dmg_path"
        return 1
    }
    if [ ! -f "$dmg_path" ]; then
        fail_orbstack_install_step "orbstack_cache_resolution_failed" \
            "The verified OrbStack download was not found" "$dmg_path"
        return 1
    fi

    ORBSTACK_INSTALL_TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/portico-orbstack-install.XXXXXX") || {
        fail_orbstack_install_step "orbstack_mount_failed" \
            "Failed to prepare the OrbStack installation workspace"
        return 1
    }
    ORBSTACK_INSTALL_MOUNT_POINT="${ORBSTACK_INSTALL_TMP_DIR}/mount"
    if ! mkdir -p "$ORBSTACK_INSTALL_MOUNT_POINT"; then
        fail_orbstack_install_step "orbstack_mount_failed" \
            "Failed to prepare the OrbStack disk image mount point" \
            "$ORBSTACK_INSTALL_MOUNT_POINT"
        return 1
    fi

    mount_output=$(hdiutil attach -readonly -nobrowse \
        -mountpoint "$ORBSTACK_INSTALL_MOUNT_POINT" "$dmg_path" 2>&1) || {
        fail_orbstack_install_step "orbstack_mount_failed" \
            "Failed to open the verified OrbStack disk image" "$mount_output"
        return 1
    }
    ORBSTACK_INSTALL_DMG_MOUNTED=1
    source_app="${ORBSTACK_INSTALL_MOUNT_POINT}/OrbStack.app"
    if [ ! -d "$source_app" ]; then
        fail_orbstack_install_step "orbstack_mount_failed" \
            "The OrbStack disk image did not contain OrbStack.app" "$mount_output"
        return 1
    fi

    if ! verify_orbstack_app_bundle "$source_app"; then
        fail_orbstack_install_step \
            "${ORBSTACK_VERIFICATION_CODE:-orbstack_signature_invalid}" \
            "OrbStack failed security verification before installation" \
            "$ORBSTACK_VERIFICATION_DETAIL"
        return 1
    fi

    target_dir=$(dirname "$ORBSTACK_USER_APP_PATH")
    if ! mkdir -p "$target_dir"; then
        fail_orbstack_install_step "orbstack_copy_failed" \
            "Failed to create the user Applications folder" "$target_dir"
        return 1
    fi

    if [ -d "$ORBSTACK_USER_APP_PATH" ]; then
        set_orbstack_app_path "$ORBSTACK_USER_APP_PATH"
        cleanup_orbstack_install_workspace
        log_success "OrbStack was installed by another process while setup was downloading it"
        return 0
    fi

    ORBSTACK_INSTALL_STAGING_PATH="${target_dir}/.OrbStack.app.installing-${$}"
    if ! rm -rf "$ORBSTACK_INSTALL_STAGING_PATH"; then
        fail_orbstack_install_step "orbstack_copy_failed" \
            "Failed to prepare the OrbStack staging path" \
            "$ORBSTACK_INSTALL_STAGING_PATH"
        return 1
    fi
    copy_output=$(ditto "$source_app" "$ORBSTACK_INSTALL_STAGING_PATH" 2>&1) || {
        fail_orbstack_install_step "orbstack_copy_failed" \
            "Failed to copy OrbStack into the user Applications folder" "$copy_output"
        return 1
    }

    if ! verify_orbstack_app_bundle "$ORBSTACK_INSTALL_STAGING_PATH"; then
        fail_orbstack_install_step \
            "${ORBSTACK_VERIFICATION_CODE:-orbstack_signature_invalid}" \
            "The installed OrbStack copy failed security verification" \
            "$ORBSTACK_VERIFICATION_DETAIL"
        return 1
    fi

    if ! strip_orbstack_quarantine "$ORBSTACK_INSTALL_STAGING_PATH"; then
        fail_orbstack_install_step \
            "${ORBSTACK_PREPARATION_CODE:-orbstack_quarantine_cleanup_failed}" \
            "The verified OrbStack copy could not be prepared for a stable first launch" \
            "$ORBSTACK_PREPARATION_DETAIL"
        return 1
    fi

    if [ -d "$ORBSTACK_USER_APP_PATH" ]; then
        cleanup_orbstack_install_workspace
        set_orbstack_app_path "$ORBSTACK_USER_APP_PATH"
        log_success "OrbStack was installed by another process while setup was verifying it"
        return 0
    fi

    move_output=$(mv -n "$ORBSTACK_INSTALL_STAGING_PATH" "$ORBSTACK_USER_APP_PATH" 2>&1) || {
        fail_orbstack_install_step "orbstack_copy_failed" \
            "Failed to finish the OrbStack installation" "$move_output"
        return 1
    }
    if [ ! -d "$ORBSTACK_USER_APP_PATH" ]; then
        fail_orbstack_install_step "orbstack_copy_failed" \
            "OrbStack was not installed in the user Applications folder" "$move_output"
        return 1
    fi
    ORBSTACK_INSTALL_STAGING_PATH=""
    set_orbstack_app_path "$ORBSTACK_USER_APP_PATH"
    cleanup_orbstack_install_workspace
    log_success "OrbStack installed securely at $ORBSTACK_APP_PATH"
    return 0
}

finalize_orbstack_install() {
    ensure_orbstack_cli_on_path

    if ! docker_is_ready; then
        if ! start_orbstack_vm; then
            log_error "OrbStack failed to start Docker. Please start it manually."
            emit_step_failed "orbstack"
            if [ -n "$ORBSTACK_FATAL_ERROR_MESSAGE" ]; then
                emit_warning "OrbStack couldn't start its VM. This environment may not support OrbStack. Try Docker Desktop or a physical Mac, then click Retry."
                emit_orbstack_failure "orbstack_launch_failed" \
                    "OrbStack could not start its virtual machine" \
                    "$ORBSTACK_FATAL_ERROR_MESSAGE"
            else
                emit_orbstack_failure "orbstack_onboarding_blocked" \
                    "OrbStack did not finish preparing Docker" \
                    "Docker was not ready after automatic OrbStack configuration"
            fi
            return 1
        fi
    fi

    emit_step_complete "orbstack"
    return 0
}

install_orbstack() {
    emit_step_start "orbstack"
    log_info "Checking for OrbStack installation..."
    ensure_orbstack_cli_on_path

    if resolve_orbstack_app_path; then
        log_success "OrbStack is already installed at $ORBSTACK_APP_PATH"
        if ! pgrep -x OrbStack >/dev/null 2>&1; then
            if ! prepare_orbstack_app_for_first_launch; then
                emit_orbstack_failure \
                    "${ORBSTACK_PREPARATION_CODE:-orbstack_quarantine_cleanup_failed}" \
                    "OrbStack could not be verified and prepared for first launch" \
                    "$ORBSTACK_PREPARATION_DETAIL"
                emit_step_failed "orbstack"
                return 1
            fi
            if ! launch_new_orbstack_app; then
                emit_step_failed "orbstack"
                return 1
            fi
        fi
        finalize_orbstack_install
        return $?
    fi

    if ! command_exists brew; then
        log_error "Homebrew is required to install OrbStack"
        log_info "Please run prereq-dependencies.sh first to install Homebrew"
        emit_orbstack_failure "orbstack_download_failed" \
            "Homebrew is required to download OrbStack"
        emit_step_failed "orbstack"
        return 1
    fi

    if ! download_and_install_orbstack; then
        return 1
    fi

    if ! prepare_orbstack_app_for_first_launch; then
        emit_orbstack_failure \
            "${ORBSTACK_PREPARATION_CODE:-orbstack_quarantine_cleanup_failed}" \
            "OrbStack could not be verified and prepared for first launch" \
            "$ORBSTACK_PREPARATION_DETAIL"
        emit_step_failed "orbstack"
        return 1
    fi

    if ! launch_new_orbstack_app; then
        emit_step_failed "orbstack"
        return 1
    fi

    finalize_orbstack_install
}

# ============================================================================
# ORBSTACK RESOURCE CONFIGURATION
# Cherry-picked from install_v2.sh lines 261-363
# ============================================================================

configure_orbstack_resources() {
    emit_step_start "orbstack_config"
    log_info "Configuring OrbStack resources..."
    ensure_orbstack_cli_on_path

    # Check if orbctl is available
    if ! resolve_orbctl_path >/dev/null 2>&1; then
        log_warning "orbctl command not found, skipping resource configuration"
        emit_step_skipped "orbstack_config"
        return 0
    fi

    # Calculate half of available memory in MiB
    local total_memory_bytes=$(sysctl -n hw.memsize)
    local half_memory_mib=$((total_memory_bytes / 1024 / 1024 / 2))
    local desired_cpu=10

    log_info "System memory: $((total_memory_bytes / 1024 / 1024)) MiB"
    log_info "Desired allocation to OrbStack: ${half_memory_mib} MiB (50% of system memory)"
    log_info "Desired CPUs: ${desired_cpu}"

    # Get current configuration
    log_info "Checking current OrbStack configuration..."
    local config_output
    if ! config_output=$(run_orbctl config show 2>/dev/null); then
        log_warning "Failed to get current OrbStack configuration"
        emit_step_failed "orbstack_config"
        return 1
    fi

    # Parse current values
    local current_memory=$(echo "$config_output" | grep "^memory_mib:" | awk '{print $2}')
    local current_cpu=$(echo "$config_output" | grep "^cpu:" | awk '{print $2}')

    log_info "Current configuration:"
    log_info "  Memory: ${current_memory} MiB"
    log_info "  CPU: ${current_cpu} cores"

    # Track if any changes are made
    local changes_made=false

    # Check if memory needs to be updated
    if [ "$current_memory" != "$half_memory_mib" ]; then
        log_info "Memory differs (current: ${current_memory} MiB -> desired: ${half_memory_mib} MiB)"
        if set_orbstack_config_option "memory_mib" "${half_memory_mib}"; then
            log_success "Memory configured: ${half_memory_mib} MiB"
            changes_made=true
        else
            log_error "Failed to configure memory"
        fi
    else
        log_success "Memory already optimal: ${current_memory} MiB"
    fi

    # Check if CPU needs to be updated
    if [ "$current_cpu" != "$desired_cpu" ]; then
        log_info "CPU differs (current: ${current_cpu} cores -> desired: ${desired_cpu} cores)"
        if set_orbstack_config_option "cpu" "${desired_cpu}"; then
            log_success "CPU configured: ${desired_cpu} cores"
            changes_made=true
        else
            log_error "Failed to configure CPU"
        fi
    else
        log_success "CPU already optimal: ${current_cpu} cores"
    fi

    # Only restart if changes were made
    if [ "$changes_made" = true ]; then
        log_info "Changes detected - restarting OrbStack to apply new resource limits..."
        run_orbctl stop
        sleep 3
        if ! start_orbstack_headless; then
            log_error "OrbStack failed to restart after configuration"
            emit_step_failed "orbstack_config"
            return 1
        fi

        # Wait for Docker to be ready after restart
        log_info "Waiting for Docker to be ready..."
        local count=0
        while ! docker_is_ready && [ $count -lt 30 ]; do
            sleep 2
            ((count++))
        done

        if docker_is_ready; then
            log_success "OrbStack restarted successfully with new configuration"

            # Display the final configuration
            log_info "Final OrbStack configuration:"
            local final_config
            final_config=$(run_orbctl config show 2>/dev/null)
            echo "$final_config" | grep "^memory_mib:" | while read line; do log_info "  $line"; done
            echo "$final_config" | grep "^cpu:" | while read line; do log_info "  $line"; done
        else
            log_error "OrbStack failed to restart after configuration"
            emit_step_failed "orbstack_config"
            return 1
        fi
    else
        log_success "No configuration changes needed - OrbStack already optimally configured!"
        log_info "Skipping restart since no changes were made"
    fi

    emit_step_complete "orbstack_config"
    return 0
}

# ============================================================================
# MAIN EXECUTION
# ============================================================================

main() {
    emit_phase_start
    log "========================================"
    log "Prerequisites Phase 3: Docker/OrbStack Setup"
    log "========================================"

    # Track overall success
    local all_success=true
    local should_check_compose=false

    # Detect OS
    if [[ "$OSTYPE" == "darwin"* ]]; then
        should_check_compose=true
        log_info "Detected macOS"
        resolve_orbstack_app_path >/dev/null 2>&1 || true
        ensure_orbstack_cli_on_path

        if ! check_virtualization_support; then
            log_error "Virtualization support missing; skipping OrbStack setup."
            emit_step_failed "orbstack"
            all_success=false
            exit 1
        fi

        # First check if Docker is already available
        if check_docker; then
            log_success "Docker is already available"

            # Configure OrbStack resources if OrbStack is installed
            if resolve_orbstack_app_path; then
                if ! configure_orbstack_resources; then
                    log_warning "OrbStack resource configuration had issues"
                    all_success=false
                fi
            else
                log_info "OrbStack not installed - skipping resource configuration"
                emit_step_skipped "orbstack"
                emit_step_skipped "orbstack_config"
            fi
        else
            # Docker not available - try to install OrbStack
            if ! install_orbstack; then
                log_error "OrbStack installation failed"
                log_info "Please install Docker Desktop or OrbStack manually"
                emit_error "Docker not available and OrbStack installation failed"
                all_success=false
            else
                # Configure OrbStack resources after successful installation
                if ! configure_orbstack_resources; then
                    log_warning "OrbStack resource configuration had issues"
                    all_success=false
                fi
            fi
        fi

    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        should_check_compose=true
        log_info "Detected Linux"

        # On Linux, just check if Docker is available
        if check_docker; then
            log_success "Docker is already available"
            emit_step_skipped "orbstack"
            emit_step_skipped "orbstack_config"
        else
            log_error "Docker is required but not available"
            log_info "Please install Docker: https://docs.docker.com/get-docker/"
            emit_error "Docker not available on Linux"
            emit_step_skipped "orbstack"
            emit_step_skipped "orbstack_config"
            all_success=false
        fi
    else
        log_warning "Unsupported operating system: $OSTYPE"
        log_info "Skipping Docker/OrbStack setup"
        emit_step_skipped "orbstack"
        emit_step_skipped "orbstack_config"
    fi

    if [ "$all_success" = true ] && [[ "$OSTYPE" == "darwin"* ]]; then
        if ! ensure_running_orbstack_is_safe; then
            log_error "OrbStack is not running from a stable Applications path"
            emit_orbstack_failure \
                "${ORBSTACK_PROCESS_LOCATION_CODE:-orbstack_launch_failed}" \
                "OrbStack is not ready for stable Docker image downloads" \
                "$ORBSTACK_PROCESS_LOCATION_DETAIL"
            emit_step_failed "orbstack"
            all_success=false
        fi
    fi

    if [ "$all_success" = true ] && [ "$should_check_compose" = true ]; then
        if ! ensure_docker_compose_frontend; then
            emit_step_failed "orbstack"
            all_success=false
        fi
    fi

    # Compose recovery may restart OrbStack. Recheck the live GUI path after
    # that last runtime mutation and before Phase 3 allows image downloads.
    if [ "$all_success" = true ] && [[ "$OSTYPE" == "darwin"* ]]; then
        if ! ensure_running_orbstack_is_safe; then
            log_error "OrbStack became unsafe while validating Docker Compose"
            emit_orbstack_failure \
                "${ORBSTACK_PROCESS_LOCATION_CODE:-orbstack_launch_failed}" \
                "OrbStack is not ready for stable Docker image downloads" \
                "$ORBSTACK_PROCESS_LOCATION_DETAIL"
            emit_step_failed "orbstack"
            all_success=false
        fi
    fi

    emit_phase_complete
    log "========================================"
    log "Phase 3 Complete: Docker/OrbStack Setup"
    if [ "$all_success" = true ]; then
        log "Status: Docker/OrbStack setup completed successfully"
    else
        log "Status: Docker/OrbStack setup had issues (see above)"
    fi
    log "========================================"

    if [ "$all_success" = true ]; then
        exit 0
    fi
    exit 1
}

# Run main function
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    trap cleanup_orbstack_install_workspace EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    main "$@"
fi
