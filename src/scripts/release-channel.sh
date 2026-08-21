#!/usr/bin/env bash

if [ -n "${portico_RELEASE_CHANNEL_SH_LOADED:-}" ]; then
    return 0 2>/dev/null || exit 0
fi
portico_RELEASE_CHANNEL_SH_LOADED=1

portico_RELEASE_CHANNEL_CUSTOM_PREFIX="portico_"
portico_RELEASE_CHANNEL_CUSTOM_MAX_LENGTH=64
portico_RELEASE_CHANNEL_LEGACY_PACKAGE_MAX_LENGTH=128

normalize_release_channel_name() {
    printf '%s' "${1:-}" \
        | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
        | tr '[:upper:]' '[:lower:]'
}

validate_custom_release_channel_name() {
    local channel_name
    local LC_ALL=C
    channel_name="$(normalize_release_channel_name "${1:-}")"

    [ -n "$channel_name" ] || return 1
    [ "${#channel_name}" -le "$portico_RELEASE_CHANNEL_CUSTOM_MAX_LENGTH" ] || return 1
    case "$channel_name" in
        stable|beta|dev) return 1 ;;
    esac
    [[ "$channel_name" =~ ^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$ ]]
}

release_channel_to_package_name() {
    local channel_name
    channel_name="$(normalize_release_channel_name "${1:-}")"

    case "$channel_name" in
        stable) printf '%s\n' "portico" ;;
        beta) printf '%s\n' "portico_beta" ;;
        dev) printf '%s\n' "portico_dev" ;;
        *)
            validate_custom_release_channel_name "$channel_name" || return 1
            printf '%s%s\n' "$portico_RELEASE_CHANNEL_CUSTOM_PREFIX" "$channel_name"
            ;;
    esac
}

release_package_name_to_channel() {
    local package_name="${1:-}"
    local channel_name=""

    case "$package_name" in
        portico) printf '%s\n' "stable" ;;
        portico_beta) printf '%s\n' "beta" ;;
        portico_dev) printf '%s\n' "dev" ;;
        "${portico_RELEASE_CHANNEL_CUSTOM_PREFIX}"*)
            channel_name="${package_name#${portico_RELEASE_CHANNEL_CUSTOM_PREFIX}}"
            validate_custom_release_channel_name "$channel_name" || return 1
            printf '%s\n' "$channel_name"
            ;;
        *) return 1 ;;
    esac
}

validate_release_channel_package_name() {
    release_package_name_to_channel "${1:-}" >/dev/null
}

normalize_release_package_name() {
    printf '%s' "${1:-}" \
        | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

validate_legacy_release_package_name() {
    local package_name
    local LC_ALL=C
    package_name="$(normalize_release_package_name "${1:-}")"

    [ -n "$package_name" ] || return 1
    [ "${#package_name}" -le "$portico_RELEASE_CHANNEL_LEGACY_PACKAGE_MAX_LENGTH" ] || return 1
    [[ "$package_name" =~ ^[A-Za-z0-9]([A-Za-z0-9_-]*[A-Za-z0-9])?$ ]]
}

resolve_update_channel_package_name() {
    local package_name
    package_name="$(normalize_release_package_name "${1:-}")"

    if validate_release_channel_package_name "$package_name"; then
        printf '%s\n' "$package_name"
        return 0
    fi
    case "$package_name" in
        "${portico_RELEASE_CHANNEL_CUSTOM_PREFIX}"*) return 1 ;;
    esac
    if validate_legacy_release_package_name "$package_name"; then
        printf '%s\n' "$package_name"
        return 0
    fi
    return 1
}
