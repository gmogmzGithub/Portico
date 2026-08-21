#!/usr/bin/env bash

if [ -n "${MANAGED_RUNTIME_RECONCILE_SH_LOADED:-}" ]; then
    return 0 2>/dev/null || exit 0
fi
MANAGED_RUNTIME_RECONCILE_SH_LOADED=1

MANAGED_RUNTIME_DEFAULT_PRESERVE_PATHS=(
    ".env"
    ".env.runtime"
    "HOST_MODE"
    "open-webui-data"
    "health-status"
    "mcp-configs-user"
    "mcpo-oauth-tokens"
    "mcpo-core-oauth-tokens"
    "UPDATE_CHANNEL"
    "artifact-snapshots"
    "skills-marketplace"
    "skills-user"
    "mcp_toggles.json"
    "mcp_disable_modes.json"
    "mcp_tools_config.json"
    "marketplaces.json"
    "workspaces"
    "backup"
)

# Generated MCP config outputs are recreated during runtime compose regeneration.

MANAGED_RUNTIME_LAST_PROTECTED_PATHS=()

managed_runtime_log() {
    local level="$1"
    local message="$2"
    local logger="log_${level}"

    if declare -F "$logger" >/dev/null 2>&1; then
        "$logger" "$message"
        return 0
    fi

    printf '[%s] %s\n' "$level" "$message"
}

managed_runtime_validate_preserve_path() {
    local rel_path="$1"

    case "$rel_path" in
        ""|/*|*/*|*"*"*|*"?"*|*"["*|*"]"*)
            managed_runtime_log error "Invalid managed-runtime preserve path: $rel_path"
            return 1
            ;;
    esac

    case "/$rel_path/" in
        *"/../"*|*"/./"*)
            managed_runtime_log error "Invalid managed-runtime preserve path: $rel_path"
            return 1
            ;;
    esac

    return 0
}

# Failure contract: rsync may leave partial app-owned payload files behind when
# it fails, but the hide/protect filters below ensure that existing preserved
# paths are never read, overwritten, or deleted by the reconcile.
managed_runtime_sync_payload_in_place() {
    local payload_dir="$1"
    local managed_dir="$2"
    shift 2

    local -a preserve_paths=("$@")
    local -a rsync_args=(-a --delete --force)
    local item=""
    local status=0

    if [ ! -d "$payload_dir" ]; then
        managed_runtime_log error "Managed runtime payload root not found: $payload_dir"
        return 1
    fi

    if [ "${#preserve_paths[@]}" -eq 0 ]; then
        preserve_paths=("${MANAGED_RUNTIME_DEFAULT_PRESERVE_PATHS[@]}")
    fi

    MANAGED_RUNTIME_LAST_PROTECTED_PATHS=()
    for item in "${preserve_paths[@]}"; do
        managed_runtime_validate_preserve_path "$item" || return 1
        if [ ! -e "$managed_dir/$item" ] && [ ! -L "$managed_dir/$item" ]; then
            continue
        fi

        rsync_args+=(--filter="H /$item" --filter="P /$item")
        rsync_args+=(--filter="H /$item/***" --filter="P /$item/***")
        MANAGED_RUNTIME_LAST_PROTECTED_PATHS+=("$item")
    done

    if ! command -v rsync >/dev/null 2>&1; then
        managed_runtime_log error "rsync is required for safe in-place managed-runtime updates"
        return 1
    fi

    mkdir -p "$managed_dir" || return 1
    rsync "${rsync_args[@]}" "$payload_dir"/ "$managed_dir"/ || status=$?
    if [ "$status" -ne 0 ]; then
        # Some legacy callers define log_error as an exit helper. Isolate the
        # logger so this copy primitive still returns rsync's real status.
        ( managed_runtime_log error "rsync exited $status" ) || true
    fi
    return "$status"
}

managed_runtime_reconcile_payload() {
    local payload_dir="$1"
    local managed_dir="$2"
    shift 2

    local -a preserve_paths=("$@")
    local protected_count=0

    if [ ! -d "$payload_dir" ]; then
        managed_runtime_log error "Managed runtime payload root not found: $payload_dir"
        return 1
    fi

    if [ "${#preserve_paths[@]}" -eq 0 ]; then
        preserve_paths=("${MANAGED_RUNTIME_DEFAULT_PRESERVE_PATHS[@]}")
    fi

    managed_runtime_log info "Reconciling managed runtime tree from payload: $payload_dir"
    if ! managed_runtime_sync_payload_in_place "$payload_dir" "$managed_dir" "${preserve_paths[@]}"; then
        managed_runtime_log error "Managed runtime reconcile failed"
        return 1
    fi

    protected_count="${#MANAGED_RUNTIME_LAST_PROTECTED_PATHS[@]}"
    managed_runtime_log info "Protected $protected_count existing managed-runtime path(s)"
    if [ "$protected_count" -gt 0 ]; then
        managed_runtime_log info "Protected paths: ${MANAGED_RUNTIME_LAST_PROTECTED_PATHS[*]}"
    fi

    managed_runtime_log success "Managed runtime reconciled successfully"
    return 0
}
