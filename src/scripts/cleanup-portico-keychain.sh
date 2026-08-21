#!/bin/bash

# Shared macOS Keychain cleanup for clean_dev.sh and clean_full.sh.
# This file is sourced by both scripts. It inspects Keychain metadata only;
# password values are never requested or printed.

_portico_cleanup_log_ok() {
    if type ok >/dev/null 2>&1; then
        ok "$1"
    else
        printf '  ✓ %s\n' "$1"
    fi
}

_portico_cleanup_log_skip() {
    if type skip >/dev/null 2>&1; then
        skip "$1"
    else
        printf '  - %s\n' "$1"
    fi
}

_portico_cleanup_log_fail() {
    if type fail >/dev/null 2>&1; then
        fail "$1"
    else
        printf '  ✗ %s\n' "$1" >&2
    fi
}

_portico_cleanup_login_keychain() {
    printf '%s\n' "${portico_LOGIN_KEYCHAIN_PATH:-$HOME/Library/Keychains/login.keychain-db}"
}

_portico_cleanup_is_darwin() {
    [ "$(uname -s)" = "Darwin" ]
}

_portico_cleanup_service_is_owned() {
    local service="$1"
    local normalized
    normalized="$(printf '%s' "$service" | tr '[:upper:]' '[:lower:]')"

    case "$normalized" in
        portico*|portico\ ai\ chat*)
            return 0
            ;;
    esac

    [ -n "${PORTICO_LLM_KEYCHAIN_SERVICE:-}" ] \
        && [ "$service" = "$PORTICO_LLM_KEYCHAIN_SERVICE" ]
}

_portico_cleanup_dump_keychain_services() {
    local login_keychain="$1"
    local dump_file
    dump_file="$(mktemp "${TMPDIR:-/tmp}/portico-keychain-services.XXXXXX")" || return 1

    if ! security dump-keychain "$login_keychain" >"$dump_file" 2>/dev/null; then
        rm -f "$dump_file"
        return 1
    fi

    awk '
        /"svce"<blob>=/ {
            value = $0
            sub(/^.*"svce"<blob>=/, "", value)
            if (value ~ /^"/) {
                sub(/^"/, "", value)
                sub(/"$/, "", value)
                print value
            }
        }
    ' "$dump_file"
    local status=$?
    rm -f "$dump_file"
    return "$status"
}

_portico_cleanup_list_owned_services() {
    local login_keychain="$1"
    local services
    if ! services="$(_portico_cleanup_dump_keychain_services "$login_keychain")"; then
        return 1
    fi

    while IFS= read -r service; do
        [ -n "$service" ] || continue
        if _portico_cleanup_service_is_owned "$service"; then
            printf '%s\n' "$service"
        fi
    done <<< "$services" | LC_ALL=C sort -u
}

portico_cleanup_generic_passwords() {
    local dry_run="${1:-false}"

    if ! _portico_cleanup_is_darwin; then
        _portico_cleanup_log_skip "macOS Keychain cleanup skipped on non-Darwin host"
        return 0
    fi
    if ! command -v security >/dev/null 2>&1; then
        _portico_cleanup_log_fail "security CLI is unavailable; cannot verify a clean Keychain"
        return 1
    fi

    local login_keychain
    local services
    login_keychain="$(_portico_cleanup_login_keychain)"
    if ! services="$(_portico_cleanup_list_owned_services "$login_keychain")"; then
        _portico_cleanup_log_fail "Could not enumerate Keychain service metadata from $login_keychain"
        return 1
    fi

    if [ -z "$services" ]; then
        _portico_cleanup_log_skip "No PORTICO-owned generic-password services found"
        return 0
    fi

    local service
    if [ "$dry_run" = "true" ]; then
        while IFS= read -r service; do
            [ -n "$service" ] || continue
            printf '  [dry-run] purge generic-password service=%s from %s\n' \
                "$service" "$login_keychain"
        done <<< "$services"
        return 0
    fi

    local delete_passes
    while IFS= read -r service; do
        [ -n "$service" ] || continue
        delete_passes=0
        while security delete-generic-password -s "$service" "$login_keychain" \
            >/dev/null 2>&1; do
            delete_passes=$((delete_passes + 1))
            if [ "$delete_passes" -ge 1024 ]; then
                _portico_cleanup_log_fail "Refusing an unbounded Keychain deletion loop for service=$service"
                return 1
            fi
        done
        _portico_cleanup_log_ok "Purged PORTICO Keychain service=$service"
    done <<< "$services"

    local remaining
    if ! remaining="$(_portico_cleanup_list_owned_services "$login_keychain")"; then
        _portico_cleanup_log_fail "Could not verify Keychain cleanup in $login_keychain"
        return 1
    fi
    if [ -n "$remaining" ]; then
        while IFS= read -r service; do
            [ -n "$service" ] || continue
            _portico_cleanup_log_fail "PORTICO Keychain service remains after cleanup: $service"
        done <<< "$remaining"
        return 1
    fi

    _portico_cleanup_log_ok "Verified no PORTICO-owned generic-password services remain"
}

_portico_cleanup_single_server_ssl_cache_dirs() {
    local project_root="$1"
    {
        printf '%s\n' "$HOME/Library/Caches/portico/single-server-ssl"
        printf '%s\n' "${XDG_STATE_HOME:-$HOME/.local/state}/portico/single-server-ssl"
        if [ -n "${PORTICO_SINGLE_SERVER_SSL_DIR:-}" ]; then
            printf '%s\n' "$PORTICO_SINGLE_SERVER_SSL_DIR"
        fi
        printf '%s\n' "$project_root/tmp/single-server-ssl"
    } | awk 'NF && !seen[$0]++'
}

_portico_cleanup_list_localhost_certificate_shas() {
    local login_keychain="$1"
    local cert_file
    cert_file="$(mktemp "${TMPDIR:-/tmp}/portico-keychain-certs.XXXXXX")" || return 1

    if ! security find-certificate -a -c localhost -Z "$login_keychain" \
        >"$cert_file" 2>/dev/null; then
        rm -f "$cert_file"
        return 1
    fi

    awk '/^SHA-1 hash:/ {print toupper($NF)}' "$cert_file" \
        | awk '/^[A-F0-9]{40}$/'
    local status=$?
    rm -f "$cert_file"
    return "$status"
}

_portico_cleanup_cached_certificate_shas() {
    local project_root="$1"
    local ssl_cache
    local sha

    while IFS= read -r ssl_cache; do
        [ -n "$ssl_cache" ] || continue
        sha=""
        if [ -s "$ssl_cache/.cert.sha1" ]; then
            sha="$(tr -d '[:space:]' < "$ssl_cache/.cert.sha1" | tr '[:lower:]' '[:upper:]')"
        elif [ -s "$ssl_cache/oauth.crt" ] && command -v openssl >/dev/null 2>&1; then
            sha="$(openssl x509 -in "$ssl_cache/oauth.crt" -noout -fingerprint -sha1 \
                2>/dev/null | awk -F= '{gsub(/:/, "", $2); print toupper($2)}')"
        fi
        if printf '%s\n' "$sha" | awk '/^[A-F0-9]{40}$/{found=1} END{exit !found}'; then
            printf '%s\n' "$sha"
        fi
    done < <(_portico_cleanup_single_server_ssl_cache_dirs "$project_root")
}

portico_cleanup_legacy_oauth_certificates() {
    local dry_run="${1:-false}"
    local project_root="$2"

    if ! _portico_cleanup_is_darwin; then
        _portico_cleanup_log_skip "macOS OAuth certificate cleanup skipped on non-Darwin host"
        return 0
    fi
    if ! command -v security >/dev/null 2>&1; then
        _portico_cleanup_log_fail "security CLI is unavailable; cannot verify OAuth certificate cleanup"
        return 1
    fi

    local login_keychain
    local cached_shas
    local keychain_shas
    local certificate_shas
    login_keychain="$(_portico_cleanup_login_keychain)"
    cached_shas="$(_portico_cleanup_cached_certificate_shas "$project_root")"
    if ! keychain_shas="$(_portico_cleanup_list_localhost_certificate_shas "$login_keychain")"; then
        _portico_cleanup_log_fail "Could not enumerate localhost certificates from $login_keychain"
        return 1
    fi
    certificate_shas="$(printf '%s\n%s\n' "$cached_shas" "$keychain_shas" \
        | awk '/^[A-F0-9]{40}$/' | LC_ALL=C sort -u)"

    if [ -z "$certificate_shas" ]; then
        _portico_cleanup_log_skip "No legacy localhost OAuth certificates found"
        return 0
    fi

    local sha
    if [ "$dry_run" = "true" ]; then
        while IFS= read -r sha; do
            [ -n "$sha" ] || continue
            printf '  [dry-run] security delete-certificate -Z %s %s\n' \
                "$sha" "$login_keychain"
        done <<< "$certificate_shas"
        return 0
    fi

    while IFS= read -r sha; do
        [ -n "$sha" ] || continue
        security delete-certificate -Z "$sha" "$login_keychain" >/dev/null 2>&1 || true
    done <<< "$certificate_shas"

    local remaining
    if ! remaining="$(_portico_cleanup_list_localhost_certificate_shas "$login_keychain")"; then
        _portico_cleanup_log_fail "Could not verify localhost certificate cleanup in $login_keychain"
        return 1
    fi
    if [ -n "$remaining" ]; then
        while IFS= read -r sha; do
            [ -n "$sha" ] || continue
            _portico_cleanup_log_fail "localhost certificate remains after cleanup: sha1=$sha"
        done <<< "$remaining"
        return 1
    fi

    _portico_cleanup_log_ok "Removed and verified legacy localhost OAuth certificates"
}

portico_remove_single_server_ssl_caches() {
    local dry_run="${1:-false}"
    local project_root="$2"
    local ssl_cache

    while IFS= read -r ssl_cache; do
        [ -n "$ssl_cache" ] || continue
        if [ ! -d "$ssl_cache" ]; then
            continue
        fi
        if [ "$dry_run" = "true" ]; then
            printf '  [dry-run] rm -rf %s\n' "$ssl_cache"
        else
            rm -rf "$ssl_cache"
        fi
        _portico_cleanup_log_ok "Removed single-server SSL cache dir $ssl_cache"
    done < <(_portico_cleanup_single_server_ssl_cache_dirs "$project_root")
}
