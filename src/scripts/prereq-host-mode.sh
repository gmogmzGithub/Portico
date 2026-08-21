#!/bin/bash

# prereq-host-mode.sh - Prerequisites Phase 4: HOST Mode Check
# Cherry-picked from install_v2.sh for Electron guided setup wizard
# This script handles:
#   - Checking HOST mode requirements for bundled host integrations
#   - Writing HOST_MODE file (TRUE/FALSE)
#
# HOST mode enables running MCP servers directly on the host machine
# instead of within Docker containers, providing better performance
# for bundled integrations like Chrome DevTools.
#
# Progress markers emitted for Electron app:
#   [PREREQ:PHASE:4:START]
#   [PREREQ:STEP:<step>:START]
#   [PREREQ:STEP:<step>:COMPLETE]
#   [PREREQ:STEP:<step>:SKIPPED]
#   [PREREQ:STEP:<step>:FAILED]
#   [PREREQ:PHASE:4:COMPLETE]
#   [PREREQ:HOST_MODE:<TRUE|FALSE>]

set -e

# ============================================================================
# CONFIGURATION
# ============================================================================

# Allow PROJECT_ROOT to be passed as argument or default to current directory
PROJECT_ROOT="${1:-$(pwd)}"
NODE_VERSION_REQUIRED="${NODE_VERSION_REQUIRED:-20.19.0}"

# ============================================================================
# LOGGING FUNCTIONS
# ============================================================================

emit_phase_start() {
    echo "[PREREQ:PHASE:4:START]"
}

emit_phase_complete() {
    echo "[PREREQ:PHASE:4:COMPLETE]"
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

emit_host_mode() {
    echo "[PREREQ:HOST_MODE:$1]"
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

node_bin_dir_satisfies_host_requirement() {
    local node_bin_dir="$1"
    local host_node_raw host_node_version

    [ -x "${node_bin_dir}/node" ] || return 1
    [ -x "${node_bin_dir}/npm" ] || return 1

    host_node_raw="$("${node_bin_dir}/node" --version 2>/dev/null || true)"
    host_node_version="$(normalize_semver "$host_node_raw" 2>/dev/null || true)"
    [ -n "$host_node_version" ] || return 1

    semver_gte "$host_node_version" "$NODE_VERSION_REQUIRED"
}

resolve_host_mode_node_bin_dir() {
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

    IFS=':' read -r -a install_root_entries <<< "${HOST_NODE_INSTALL_ROOTS:-$HOME/.local/lib/nodejs:/usr/local/lib/nodejs}"
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

        if node_bin_dir_satisfies_host_requirement "$candidate_dir"; then
            printf '%s\n' "$candidate_dir"
            return 0
        fi
    done

    return 1
}

check_host_mode_support() {
    log_info "Checking HOST mode support..."

    local host_mode_file="${PROJECT_ROOT}/HOST_MODE"

    # Check if forced to NO HOST mode for testing
    if [ "$FORCE_NO_HOST_MODE" = "true" ]; then
        echo "FALSE" > "$host_mode_file"
        log_warning "FORCED HOST_MODE=FALSE for testing purposes"
        log_info "Written HOST_MODE=FALSE to $host_mode_file"
        log_info "This is a testing mode - actual component status ignored"
        log_info "HOST-based MCP servers will not be available"
        log_info "Docker-based MCP servers will work normally"
        emit_host_mode "FALSE"
        return 1
    fi

    log_info "HOST mode requires: Node.js >= v${NODE_VERSION_REQUIRED} and npm for sandboxed package preparation"
    echo

    local all_requirements_met=true
    local missing_components=""
    local host_node_bin_dir=""

    # Check Node.js
    emit_step_start "check_nodejs"
    if host_node_bin_dir="$(resolve_host_mode_node_bin_dir)"; then
        export PATH="${host_node_bin_dir}:${PATH:-}"
        local host_node_raw
        host_node_raw="$("${host_node_bin_dir}/node" --version 2>/dev/null || true)"
        log_success "Node.js is available"
        log_info "Node.js version: ${host_node_raw:-unknown}"
        log_info "Node.js location: ${host_node_bin_dir}/node"
        emit_step_complete "check_nodejs"
    else
        log_warning "Node.js >= v${NODE_VERSION_REQUIRED} with npm is NOT available"
        all_requirements_met=false
        missing_components="${missing_components}Node.js >= v${NODE_VERSION_REQUIRED}, "
        emit_step_failed "check_nodejs"
    fi

    # Check npm. Runtime host MCPs do not execute npm/npx; npm is used only by
    # the one-shot managed package preparation sandbox.
    emit_step_start "check_npm"
    if command_exists npm; then
        log_success "npm is available"
        log_info "npm location: $(which npm)"
        emit_step_complete "check_npm"
    else
        log_warning "npm is NOT available"
        all_requirements_met=false
        missing_components="${missing_components}npm, "
        emit_step_failed "check_npm"
    fi

    # Write HOST_MODE file - TRUE only if EVERYTHING is available
    if [ "$all_requirements_met" = true ]; then
        echo "TRUE" > "$host_mode_file"
        log_success "HOST mode is SUPPORTED - all requirements met"
        log_info "Written HOST_MODE=TRUE to $host_mode_file"
        log_info "You can use bundled HOST-based MCP servers (e.g., Chrome DevTools)"
        emit_host_mode "TRUE"
        return 0
    else
        echo "FALSE" > "$host_mode_file"
        log_warning "HOST mode is NOT SUPPORTED - missing components"
        log_info "Written HOST_MODE=FALSE to $host_mode_file"

        # Clean up trailing comma and space
        missing_components="${missing_components%, }"
        log_warning "Missing: ${missing_components}"
        log_info "Bundled HOST-based MCP servers will not be available"
        log_info "Docker-based MCP servers will work normally"
        emit_host_mode "FALSE"
        return 1
    fi
}

# ============================================================================
# MAIN EXECUTION
# ============================================================================

main() {
    local skip_host_mode_check="${GUIDED_SETUP_SKIP_HOST_MODE_CHECK:-false}"
    local host_mode_file="${PROJECT_ROOT}/HOST_MODE"

    emit_phase_start
    log "========================================"
    log "Prerequisites Phase 4: HOST Mode Check"
    log "========================================"
    log_info "Project root: ${PROJECT_ROOT}"

    if [ "$skip_host_mode_check" = "true" ]; then
        echo "FALSE" > "$host_mode_file"
        log_info "Basic setup selected - skipping host mode validation"
        log_info "Written HOST_MODE=FALSE to $host_mode_file"
        emit_step_start "check_nodejs"
        emit_step_skipped "check_nodejs"
        emit_step_start "check_npm"
        emit_step_skipped "check_npm"
        emit_host_mode "FALSE"
        emit_phase_complete
        log "========================================"
        log "Phase 4 Complete: Docker-focused basic setup"
        log "Status: HOST mode intentionally skipped"
        log "========================================"
        exit 0
    fi

    # Run the host mode check
    # Note: check_host_mode_support returns 1 if HOST mode is disabled,
    # which is not an error condition - we need to capture the result
    # without triggering set -e
    local check_result=0
    check_host_mode_support || check_result=$?

    emit_phase_complete
    log "========================================"
    log "Phase 4 Complete: HOST Mode Check"
    if [ $check_result -eq 0 ]; then
        log "Status: HOST mode is enabled"
    else
        log "Status: HOST mode is disabled (missing components)"
    fi
    log "========================================"

    # Always exit 0 - HOST mode being disabled is not an error
    # The Electron app will read the HOST_MODE file to determine behavior
    exit 0
}

# Run main function
main "$@"
