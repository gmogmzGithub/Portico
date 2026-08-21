#!/bin/bash

MCP_SENSITIVE_ENV_KEYCHAIN_MIGRATION="mcp-sensitive-env-keychain-v1"
RUNTIME_WRITABLE_SECRET_KEYS=(
    "PORTICO_LLM_API_KEY"
    "LOCAL_STACK_API_KEY"
    "BIFROST_BRIDGE_LOCAL_API_KEY"
    "ULTRA_MULTI_AGENT_SIGNING_SECRET"
    "OWUI_AUTH_BRIDGE_SECRET"
    "WEBUI_SECRET_KEY"
    "CLOUDSMITH_ENTITLEMENT_TOKEN"
)

discover_sensitive_required_env_vars() {
    local project_root="${PROJECT_ROOT:-$(pwd)}"
    local root dir yaml_file
    for root in "$project_root/mcp-configs" "$project_root/mcp-configs-user"; do
        [ -d "$root" ] || continue
        for dir in "$root"/*; do
            [ -d "$dir" ] || continue
            yaml_file="$dir/$(basename "$dir").yaml"
            [ -f "$yaml_file" ] || continue
            awk '
                function flush_entry() { if (name != "" && sensitive == "true") print name; name = ""; sensitive = "false" }
                BEGIN { in_required = 0; name = ""; sensitive = "false" }
                /^[^[:space:]-][^:]*:/ {
                    if ($0 ~ /^required_env_vars:[[:space:]]*$/) { in_required = 1; next }
                    if (in_required) { flush_entry(); in_required = 0 }
                }
                in_required && /^[[:space:]]*-[[:space:]]*name:[[:space:]]*/ {
                    flush_entry(); line = $0
                    sub(/^[[:space:]]*-[[:space:]]*name:[[:space:]]*/, "", line)
                    gsub(/"/, "", line); gsub(/\047/, "", line); sub(/[[:space:]]+$/, "", line)
                    name = line; next
                }
                in_required && /^[[:space:]]*sensitive:[[:space:]]*true[[:space:]]*$/ { sensitive = "true"; next }
                END { if (in_required) flush_entry() }
            ' "$yaml_file"
        done
    done | sort -u
}

discover_sensitive_required_env_var_descriptors() {
    local project_root="${PROJECT_ROOT:-$(pwd)}"
    local root dir yaml_file server_id
    for root in "$project_root/mcp-configs" "$project_root/mcp-configs-user"; do
        [ -d "$root" ] || continue
        for dir in "$root"/*; do
            [ -d "$dir" ] || continue
            server_id="$(basename "$dir")"
            yaml_file="$dir/$server_id.yaml"
            [ -f "$yaml_file" ] || continue
            awk -v server_id="$server_id" '
                function flush_entry() {
                    if (name != "" && sensitive == "true") {
                        printf "%s\t%s\n", server_id, name
                    }
                    name = ""
                    sensitive = "false"
                }
                BEGIN { in_required = 0; name = ""; sensitive = "false" }
                /^[^[:space:]-][^:]*:/ {
                    if ($0 ~ /^required_env_vars:[[:space:]]*$/) {
                        in_required = 1
                        next
                    }
                    if (in_required) {
                        flush_entry()
                        in_required = 0
                    }
                }
                in_required && /^[[:space:]]*-[[:space:]]*name:[[:space:]]*/ {
                    flush_entry()
                    line = $0
                    sub(/^[[:space:]]*-[[:space:]]*name:[[:space:]]*/, "", line)
                    gsub(/^["'\'']|["'\'']$/, "", line)
                    sub(/[[:space:]]+$/, "", line)
                    name = line
                    next
                }
                in_required && /^[[:space:]]*sensitive:[[:space:]]*true[[:space:]]*$/ {
                    sensitive = "true"
                    next
                }
                END { if (in_required) flush_entry() }
            ' "$yaml_file" | while IFS=$'\t' read -r parsed_server env_var_name; do
                [ -n "$parsed_server" ] || continue
                [ -n "$env_var_name" ] || continue
                printf '%s\t%s\t%s\n' \
                    "$parsed_server" \
                    "$env_var_name" \
                    "$(runtime_file_slug "$env_var_name" "secret")"
            done
        done
    done | sort -u
}

runtime_file_slug() {
    local value="$1"
    local fallback="${2:-file}"
    local slug
    slug="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/_/g; s/^_+//; s/_+$//')"
    if [ -n "$slug" ]; then
        printf '%s\n' "$slug"
    else
        printf '%s\n' "$fallback"
    fi
}

runtime_file_target_hash() {
    local server_id="$1"
    local target="$2"
    if command -v shasum >/dev/null 2>&1; then
        printf '%s\0%s' "$server_id" "$target" | shasum -a 256 | awk '{print substr($1, 1, 12)}'
    elif command -v sha256sum >/dev/null 2>&1; then
        printf '%s\0%s' "$server_id" "$target" | sha256sum | awk '{print substr($1, 1, 12)}'
    else
        printf '%s\0%s' "$server_id" "$target" | openssl dgst -sha256 -r | awk '{print substr($1, 1, 12)}'
    fi
}

sensitive_runtime_file_secret_name() {
    local server_id="$1"
    local target="$2"
    local basename
    basename="$(basename "$target")"
    printf 'portico_runtime_file_%s_%s_%s\n' \
        "$(runtime_file_slug "$server_id" "server")" \
        "$(runtime_file_slug "$basename" "file")" \
        "$(runtime_file_target_hash "$server_id" "$target")"
}

sensitive_runtime_file_secret_env_var() {
    local secret_name="$1"
    printf '%s_FILE\n' "$(printf '%s' "$secret_name" | tr '[:lower:]' '[:upper:]')"
}

static_secret_availability_env_var() {
    local server_id="$1"
    local secret_name="$2"
    printf 'portico_STATIC_SECRET_AVAILABLE_%s_%s\n' \
        "$(runtime_file_slug "$server_id" "server" | tr '[:lower:]' '[:upper:]')" \
        "$(runtime_file_slug "$secret_name" "secret" | tr '[:lower:]' '[:upper:]')"
}

sensitive_runtime_file_keychain_account() {
    local server_id="$1"
    local target="$2"
    printf 'MCP_RUNTIME_FILE::%s::%s\n' "$server_id" "$(runtime_file_target_hash "$server_id" "$target")"
}

# Older builds replaced imported source files with a stub headed by this
# marker. Sources are never overwritten anymore (PORTICO-374), but legacy stubs
# still exist on disk and must keep routing to the Keychain-read branch.
SENSITIVE_RUNTIME_FILE_STUB_MARKER="# Portico imported this sensitive runtime file into secure storage."

is_sensitive_runtime_file_stub() {
    local file_path="$1"
    local first_line=""
    [ -f "$file_path" ] || return 1
    IFS= read -r first_line < "$file_path" || true
    first_line="${first_line%$'\r'}"
    [ "$first_line" = "$SENSITIVE_RUNTIME_FILE_STUB_MARKER" ]
}

expand_runtime_file_source_path() {
    local source="$1"
    local project_root="${PROJECT_ROOT:-$(pwd)}"
    case "$source" in
        "~")
            printf '%s\n' "$HOME"
            ;;
        "~/"*)
            printf '%s/%s\n' "$HOME" "${source#~/}"
            ;;
        "~"*)
            return 1
            ;;
        /*)
            printf '%s\n' "$source"
            ;;
        *)
            printf '%s/%s\n' "$project_root" "$source"
            ;;
    esac
}

runtime_file_target_from_entry() {
    local source="$1"
    local filename="$2"
    local target="$3"
    if [ -n "$target" ]; then
        printf '%s\n' "$target"
        return 0
    fi
    if [ -n "$filename" ]; then
        printf '/app/runtime/%s\n' "$filename"
        return 0
    fi
    printf '/app/runtime/%s\n' "$(basename "$source")"
}

discover_sensitive_runtime_files() {
    local project_root="${PROJECT_ROOT:-$(pwd)}"
    local root dir yaml_file server_id
    for root in "$project_root/mcp-configs" "$project_root/mcp-configs-user"; do
        [ -d "$root" ] || continue
        for dir in "$root"/*; do
            [ -d "$dir" ] || continue
            server_id="$(basename "$dir")"
            yaml_file="$dir/$server_id.yaml"
            [ -f "$yaml_file" ] || continue
            awk -v server_id="$server_id" '
                function trim(v) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", v); gsub(/^["'\'']|["'\'']$/, "", v); return v }
                function field(v) { return v == "" ? "__portico_EMPTY__" : v }
                function flush_entry() {
                    if (source != "" && sensitive == "true") {
                        printf "%s\t%s\t%s\t%s\n", server_id, source, field(filename), field(target)
                    }
                    source = ""; filename = ""; target = ""; sensitive = "false"
                }
                BEGIN { in_runtime = 0; source = ""; filename = ""; target = ""; sensitive = "false"; saw = 0 }
                /^[^[:space:]-][^:]*:/ {
                    if ($0 ~ /^runtime_files:[[:space:]]*$/) { in_runtime = 1; next }
                    if (in_runtime) { flush_entry(); in_runtime = 0 }
                }
                in_runtime && /^[[:space:]]*-[[:space:]]*/ {
                    if (saw) flush_entry()
                    saw = 1
                    line = $0
                    sub(/^[[:space:]]*-[[:space:]]*/, "", line)
                    if (line ~ /^source:[[:space:]]*/) { sub(/^source:[[:space:]]*/, "", line); source = trim(line) }
                    else if (line ~ /^filename:[[:space:]]*/) { sub(/^filename:[[:space:]]*/, "", line); filename = trim(line) }
                    else if (line ~ /^target:[[:space:]]*/) { sub(/^target:[[:space:]]*/, "", line); target = trim(line) }
                    else if (line ~ /^sensitive:[[:space:]]*/) { sub(/^sensitive:[[:space:]]*/, "", line); sensitive = trim(line) }
                    next
                }
                in_runtime && saw && /^[[:space:]]*source:[[:space:]]*/ {
                    line = $0; sub(/^[[:space:]]*source:[[:space:]]*/, "", line); source = trim(line); next
                }
                in_runtime && saw && /^[[:space:]]*filename:[[:space:]]*/ {
                    line = $0; sub(/^[[:space:]]*filename:[[:space:]]*/, "", line); filename = trim(line); next
                }
                in_runtime && saw && /^[[:space:]]*target:[[:space:]]*/ {
                    line = $0; sub(/^[[:space:]]*target:[[:space:]]*/, "", line); target = trim(line); next
                }
                in_runtime && saw && /^[[:space:]]*sensitive:[[:space:]]*/ {
                    line = $0; sub(/^[[:space:]]*sensitive:[[:space:]]*/, "", line); sensitive = trim(line); next
                }
                END { if (in_runtime) flush_entry() }
            ' "$yaml_file" | while IFS=$'\t' read -r parsed_server source filename target; do
                [ -n "$parsed_server" ] || continue
                [ "$filename" = "__portico_EMPTY__" ] && filename=""
                [ "$target" = "__portico_EMPTY__" ] && target=""
                target="$(runtime_file_target_from_entry "$source" "$filename" "$target")" || continue
                secret_name="$(sensitive_runtime_file_secret_name "$parsed_server" "$target")"
                printf '%s\t%s\t%s\t%s\n' "$secret_name" "$parsed_server" "$target" "$source"
            done
        done
    done | sort -u
}

base64_encode_file_single_line() {
    base64 < "$1" | tr -d '\r\n'
}

base64_decode_to_file() {
    local value="$1"
    local output="$2"
    if printf '%s' "$value" | base64 --decode > "$output" 2>/dev/null; then
        return 0
    fi
    printf '%s' "$value" | base64 -D > "$output" 2>/dev/null
}

materialize_sensitive_runtime_file_secret() {
    local cache_dir="$1"
    local secret_name="$2"
    local server_id="$3"
    local target="$4"
    local source="$5"
    local target_path="$cache_dir/$secret_name"
    local source_path account encoded tmp status

    mkdir -p "$cache_dir" 2>/dev/null || true
    chmod 700 "$cache_dir" 2>/dev/null || true

    source_path="$(expand_runtime_file_source_path "$source" 2>/dev/null || true)"
    account="$(sensitive_runtime_file_keychain_account "$server_id" "$target")"
    tmp="$(mktemp "$cache_dir/.${secret_name}.XXXXXX")" || return 2
    status=0

    if [ -n "$source_path" ] && [ -f "$source_path" ] && ! is_sensitive_runtime_file_stub "$source_path"; then
        if is_keychain_supported && ! is_keychain_disabled; then
            encoded="$(base64_encode_file_single_line "$source_path")"
            if [ -n "$encoded" ]; then
                if ! upsert_secret_in_keychain "$account" "$encoded"; then
                    if is_keychain_only_mode; then
                        rm -f "$tmp"
                        return 2
                    fi
                fi
            fi
        fi
        cp "$source_path" "$tmp" || { rm -f "$tmp"; return 2; }
    elif encoded="$(read_secret_from_keychain "$account" 2>/dev/null)"; then
        if ! base64_decode_to_file "$encoded" "$tmp"; then
            rm -f "$tmp"
            return 2
        fi
    elif [ -f "$target_path" ] && [ -s "$target_path" ] && ! is_sensitive_runtime_file_stub "$target_path"; then
        rm -f "$tmp"
        chmod 600 "$target_path" 2>/dev/null || true
        printf '%s\n' "$target_path"
        return 0
    else
        : > "$tmp"
        status=1
    fi

    if [ -f "$target_path" ] && cmp -s "$tmp" "$target_path"; then
        rm -f "$tmp"
    else
        mv "$tmp" "$target_path" || { rm -f "$tmp"; return 2; }
    fi
    chmod 600 "$target_path" 2>/dev/null || true
    printf '%s\n' "$target_path"
    return "$status"
}

import_sensitive_runtime_file_secret_to_keychain() {
    local server_id="$1"
    local target="$2"
    local source="$3"
    local source_path account encoded existing

    source_path="$(expand_runtime_file_source_path "$source" 2>/dev/null || true)"
    account="$(sensitive_runtime_file_keychain_account "$server_id" "$target")"

    if [ -n "$source_path" ] && [ -f "$source_path" ] && ! is_sensitive_runtime_file_stub "$source_path"; then
        if is_keychain_supported && ! is_keychain_disabled; then
            encoded="$(base64_encode_file_single_line "$source_path")"
            if [ -n "$encoded" ]; then
                # The source stays on disk (it may be a shared, user-owned
                # config); refresh secure storage only when the content
                # changed so repeated compose ops stay write-quiet.
                if existing="$(read_secret_from_keychain "$account" 2>/dev/null)" \
                    && [ "$existing" = "$encoded" ]; then
                    return 0
                fi
                if upsert_secret_in_keychain "$account" "$encoded"; then
                    return 0
                fi
            fi
            if is_keychain_only_mode; then
                return 2
            fi
        fi
        return 0
    fi

    if read_secret_from_keychain "$account" >/dev/null 2>&1; then
        return 0
    fi

    return 1
}

sensitive_runtime_file_secret_available() {
    local server_id="$1"
    local target="$2"
    local account
    account="$(sensitive_runtime_file_keychain_account "$server_id" "$target")"
    read_secret_from_keychain "$account" >/dev/null 2>&1
}

runtime_managed_root() {
    if [ -n "${PORTICO_MANAGED_ROOT:-}" ]; then
        echo "$PORTICO_MANAGED_ROOT"
    else
        echo "$HOME/portico/portico-managed"
    fi
}

runtime_secrets_file() {
    if [ -n "${PORTICO_RUNTIME_SECRETS_FILE:-}" ]; then
        echo "$PORTICO_RUNTIME_SECRETS_FILE"
    else
        echo "$(runtime_managed_root)/runtime-secrets.env"
    fi
}

is_truthy_flag() {
    local value
    value="$(echo "${1:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
    [ "$value" = "1" ] || [ "$value" = "true" ] || [ "$value" = "yes" ] || [ "$value" = "on" ]
}

is_falsey_flag() {
    local value
    value="$(echo "${1:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
    [ "$value" = "0" ] || [ "$value" = "false" ] || [ "$value" = "no" ] || [ "$value" = "off" ]
}

is_plaintext_fallback_allowed() {
    is_truthy_flag "${PORTICO_RUNTIME_ALLOW_PLAINTEXT_FALLBACK:-}"
}

is_runtime_writable_secret_key() {
    local key="$1"
    local allowed_key=""
    for allowed_key in "${RUNTIME_WRITABLE_SECRET_KEYS[@]}"; do
        if [ "$allowed_key" = "$key" ]; then
            return 0
        fi
    done
    while IFS= read -r allowed_key; do
        if [ "$allowed_key" = "$key" ]; then
            return 0
        fi
    done < <(discover_sensitive_required_env_vars)
    return 1
}

is_keychain_supported() {
    [ "$(uname -s)" = "Darwin" ] && command -v security >/dev/null 2>&1
}

is_keychain_disabled() {
    is_truthy_flag "${PORTICO_RUNTIME_DISABLE_KEYCHAIN:-}"
}

is_keychain_only_mode() {
    if ! is_keychain_supported || is_keychain_disabled; then
        return 1
    fi

    if is_truthy_flag "${PORTICO_RUNTIME_ALLOW_PLAINTEXT_FALLBACK:-}"; then
        return 1
    fi

    local explicit
    explicit="$(echo "${PORTICO_RUNTIME_KEYCHAIN_ONLY:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
    if [ -z "$explicit" ]; then
        return 0
    fi

    is_falsey_flag "$explicit" && return 1
    return 0
}

keychain_account_for_key() {
    local key="$1"
    case "$key" in
        PORTICO_LLM_API_KEY)
            if [ -n "${PORTICO_LLM_KEYCHAIN_ACCOUNT:-}" ]; then
                echo "$PORTICO_LLM_KEYCHAIN_ACCOUNT"
            else
                echo "PORTICO_LLM_API_KEY"
            fi
            ;;
        LOCAL_STACK_API_KEY)
            if [ -n "${LOCAL_STACK_KEYCHAIN_ACCOUNT:-}" ]; then
                echo "$LOCAL_STACK_KEYCHAIN_ACCOUNT"
            else
                echo "LOCAL_STACK_API_KEY"
            fi
            ;;
        BIFROST_BRIDGE_LOCAL_API_KEY)
            if [ -n "${BIFROST_LOCAL_KEYCHAIN_ACCOUNT:-}" ]; then
                echo "$BIFROST_LOCAL_KEYCHAIN_ACCOUNT"
            else
                echo "BIFROST_BRIDGE_LOCAL_API_KEY"
            fi
            ;;
        ULTRA_MULTI_AGENT_SIGNING_SECRET)
            echo "ULTRA_MULTI_AGENT_SIGNING_SECRET"
            ;;
        OWUI_AUTH_BRIDGE_SECRET)
            echo "OWUI_AUTH_BRIDGE_SECRET"
            ;;
        WEBUI_SECRET_KEY)
            echo "WEBUI_SECRET_KEY"
            ;;
        CLOUDSMITH_ENTITLEMENT_TOKEN)
            if [ -n "${CLOUDSMITH_ENTITLEMENT_KEYCHAIN_ACCOUNT:-}" ]; then
                echo "$CLOUDSMITH_ENTITLEMENT_KEYCHAIN_ACCOUNT"
            else
                echo "CLOUDSMITH_ENTITLEMENT_TOKEN"
            fi
            ;;
        *)
            echo "$key"
            ;;
    esac
}

read_secret_from_keychain() {
    local key="$1"
    if is_keychain_disabled || ! is_keychain_supported; then
        return 1
    fi

    local account
    account="$(keychain_account_for_key "$key")"
    local service="${PORTICO_LLM_KEYCHAIN_SERVICE:-portico}"
    local value
    if ! value="$(security find-generic-password -s "$service" -a "$account" -w 2>/dev/null)"; then
        return 1
    fi

    value="$(echo "$value" | tr -d '\r\n')"
    [ -n "$value" ] || return 1
    echo "$value"
}

upsert_secret_in_keychain() {
    local key="$1"
    local value="$2"
    [ -n "$value" ] || return 1
    if is_keychain_disabled || ! is_keychain_supported; then
        return 1
    fi

    local account
    account="$(keychain_account_for_key "$key")"
    local service="${PORTICO_LLM_KEYCHAIN_SERVICE:-portico}"

    security add-generic-password -U -s "$service" -a "$account" -w "$value" >/dev/null 2>&1
}

delete_secret_from_keychain() {
    local key="$1"
    if is_keychain_disabled || ! is_keychain_supported; then
        return 1
    fi

    local account
    account="$(keychain_account_for_key "$key")"
    local service="${PORTICO_LLM_KEYCHAIN_SERVICE:-portico}"

    security delete-generic-password -s "$service" -a "$account" >/dev/null 2>&1 || true
}

# Candidate plaintext read paths for runtime secrets. Project-level
# runtime-secrets.env and cloudsmith.env are intentionally excluded so
# secrets in a cloned repo never contribute to runtime resolution; only
# managed-root paths (and explicit PORTICO_RUNTIME_SECRETS_FILE override) apply.
list_runtime_secret_candidate_files() {
    local candidates=()
    [ -n "${PORTICO_RUNTIME_SECRETS_FILE:-}" ] && candidates+=("$PORTICO_RUNTIME_SECRETS_FILE")
    [ -n "${HOST_MCP_RESOURCES_ROOT:-}" ] && candidates+=("$HOST_MCP_RESOURCES_ROOT/runtime-secrets.env")
    candidates+=("$(runtime_secrets_file)")

    printf "%s\n" "${candidates[@]}" | awk 'NF && !seen[$0]++'
}

list_upstream_secret_candidate_files() {
    local candidates=()

    while IFS= read -r candidate; do
        [ -n "$candidate" ] && candidates+=("$candidate")
    done < <(list_runtime_secret_candidate_files)

    if is_truthy_flag "${HOST_MCP_IS_PACKAGED:-}" && [ -n "${HOST_MCP_RESOURCES_ROOT:-}" ]; then
        candidates+=("$HOST_MCP_RESOURCES_ROOT/cloudsmith.env")
    fi
    candidates+=("$(runtime_managed_root)/cloudsmith.env")

    printf "%s\n" "${candidates[@]}" | awk 'NF && !seen[$0]++'
}

list_cloudsmith_secret_candidate_files() {
    # First positional arg is kept for back-compat but ignored; project
    # root is no longer a candidate read path regardless of the flag value.
    local _legacy_include_project_root="${1:-1}"
    local candidates=()

    while IFS= read -r candidate; do
        [ -n "$candidate" ] && candidates+=("$candidate")
    done < <(list_runtime_secret_candidate_files)

    [ -n "${HOST_MCP_RESOURCES_ROOT:-}" ] && candidates+=("$HOST_MCP_RESOURCES_ROOT/cloudsmith.env")
    candidates+=("$(runtime_managed_root)/cloudsmith.env")

    printf "%s\n" "${candidates[@]}" | awk 'NF && !seen[$0]++'
}

list_cloudsmith_bootstrap_candidate_files() {
    local candidates=()

    # Only signed packaged resources and the app-owned managed runtime are
    # trusted to seed Keychain on first launch. Project-root files and arbitrary
    # plaintext overrides are intentionally excluded.
    [ -n "${HOST_MCP_RESOURCES_ROOT:-}" ] && candidates+=("$HOST_MCP_RESOURCES_ROOT/cloudsmith.env")
    candidates+=("$(runtime_managed_root)/cloudsmith.env")
    candidates+=("$(runtime_secrets_file)")

    printf "%s\n" "${candidates[@]}" | awk 'NF && !seen[$0]++'
}

list_mutable_cloudsmith_secret_files() {
    printf "%s\n" \
        "$(runtime_managed_root)/cloudsmith.env" \
        "$(runtime_secrets_file)" | awk 'NF && !seen[$0]++'
}

read_env_value_from_file() {
    local file_path="$1"
    local key="$2"

    [ -n "$file_path" ] || return 1
    [ -f "$file_path" ] || return 1

    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
            ""|\#*)
                ;;
            "$key="*)
                local value="${line#*=}"
                if [ "${#value}" -ge 2 ]; then
                    case "$value" in
                        \"*\")
                            value="${value#\"}"
                            value="${value%\"}"
                            ;;
                        \'*\')
                            value="${value#\'}"
                            value="${value%\'}"
                            ;;
                    esac
                fi
                printf '%s\n' "$value"
                return 0
                ;;
        esac
        line=""
    done < "$file_path"

    return 1
}

read_packaged_cloudsmith_entitlement_from_keychain() {
    if is_keychain_disabled || ! is_keychain_supported; then
        return 1
    fi

    local service="${PORTICO_LLM_KEYCHAIN_SERVICE:-portico}"
    local account
    local value=""
    local keychain_status=0
    account="$(keychain_account_for_key "CLOUDSMITH_ENTITLEMENT_TOKEN")"

    if value="$(security find-generic-password -s "$service" -a "$account" -w 2>/dev/null)"; then
        value="$(printf '%s' "$value" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
        [ -n "$value" ] || return 1
        printf '%s\n' "$value"
        return 0
    else
        keychain_status=$?
    fi

    # `security` uses status 44 when the item does not exist. That is an
    # ordinary absent-source case; all other failures need an actionable,
    # credential-free diagnostic instead of being mistaken for a missing item.
    if [ "$keychain_status" -eq 44 ]; then
        return 1
    fi

    printf '%s\n' \
        "Error: Failed to read CLOUDSMITH_ENTITLEMENT_TOKEN from macOS Keychain (service=$service, account=$account, status=$keychain_status). Set it explicitly or repair Keychain access." \
        >&2
    return 2
}

resolve_packaged_cloudsmith_entitlement_token() {
    local source_env_path="${1:-}"
    local value=""
    local resolution_status=0

    value="$(printf '%s' "${CLOUDSMITH_ENTITLEMENT_TOKEN:-}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    if [ -n "$value" ]; then
        printf '%s\n' "$value"
        return 0
    fi

    if value="$(read_env_value_from_file "$source_env_path" "CLOUDSMITH_ENTITLEMENT_TOKEN" 2>/dev/null)"; then
        value="$(printf '%s' "$value" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
        if [ -n "$value" ]; then
            printf '%s\n' "$value"
            return 0
        fi
    fi

    if value="$(read_packaged_cloudsmith_entitlement_from_keychain)"; then
        printf '%s\n' "$value"
        return 0
    else
        resolution_status=$?
    fi

    return "$resolution_status"
}

is_jwt_like_token() {
    local value="$1"
    [[ "$value" =~ ^[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$ ]]
}

is_placeholder_secret() {
    local lower
    lower="$(echo "${1:-}" | tr '[:upper:]' '[:lower:]')"
    [[ "$lower" == *"placeholder"* ]] || [[ "$lower" == *"example"* ]] || [[ "$lower" == *"your_"* ]] || [[ "$lower" == *"your-"* ]]
}

is_known_invalid_upstream_key() {
    local value="$1"
    [ "$value" = "sk-portico-0001" ]
}

is_malformed_upstream_key() {
    local value
    value="$(echo "${1:-}" | tr -d '[:space:]')"
    [ -z "$value" ] && return 0
    [ "${#value}" -lt 8 ] && return 0
    is_known_invalid_upstream_key "$value" && return 0
    is_jwt_like_token "$value" && return 0
    is_placeholder_secret "$value" && return 0
    return 1
}

ensure_runtime_secrets_storage() {
    local managed_root
    managed_root="$(runtime_managed_root)"
    mkdir -p "$managed_root"
    chmod 700 "$managed_root" 2>/dev/null || true

    local secrets_file
    secrets_file="$(runtime_secrets_file)"
    if [ ! -f "$secrets_file" ]; then
        : > "$secrets_file"
    fi
    chmod 600 "$secrets_file" 2>/dev/null || true
}

escape_env_value() {
    local value="$1"
    value="${value//\\/\\\\}"
    value="${value//\"/\\\"}"
    echo "$value"
}

persist_runtime_secret() {
    local key="$1"
    local value="$2"
    local secrets_file
    local temp_file

    ensure_runtime_secrets_storage
    secrets_file="$(runtime_secrets_file)"
    temp_file="$(mktemp)"

    if [ -f "$secrets_file" ]; then
        grep -v "^${key}=" "$secrets_file" > "$temp_file" || true
    fi
    printf '%s="%s"\n' "$key" "$(escape_env_value "$value")" >> "$temp_file"

    mv "$temp_file" "$secrets_file"
    chmod 600 "$secrets_file" 2>/dev/null || true
}

scrub_env_keys_from_file() {
    local file_path="$1"
    shift
    [ -n "$file_path" ] || return 1
    [ -f "$file_path" ] || return 1
    [ "$#" -gt 0 ] || return 1

    local tmp_file
    tmp_file="$(mktemp)" || return 1
    local changed=0
    local line
    local key=""
    while IFS= read -r line || [ -n "$line" ]; do
        local keep_line=1
        for key in "$@"; do
            case "$line" in
                "$key="*)
                    keep_line=0
                    changed=1
                    break
                    ;;
            esac
        done
        if [ "$keep_line" -eq 1 ]; then
            printf '%s\n' "$line" >> "$tmp_file"
        fi
        line=""
    done < "$file_path"

    if [ "$changed" -eq 1 ]; then
        mv "$tmp_file" "$file_path"
        chmod 600 "$file_path" 2>/dev/null || true
        return 0
    fi

    rm -f "$tmp_file"
    return 1
}

strip_local_stack_plaintext_fallbacks() {
    local candidate
    while IFS= read -r candidate; do
        [ -n "$candidate" ] || continue
        scrub_env_keys_from_file \
            "$candidate" \
            "LOCAL_STACK_API_KEY" \
            "INTERNAL_OPENAI_API_KEY" \
            "OPENAI_API_KEY" || true
    done < <(list_runtime_secret_candidate_files)
}

strip_upstream_plaintext_fallbacks() {
    local candidate
    while IFS= read -r candidate; do
        [ -n "$candidate" ] || continue
        scrub_env_keys_from_file "$candidate" "PORTICO_LLM_API_KEY" || true
    done < <(list_upstream_secret_candidate_files)
}

strip_bifrost_plaintext_fallbacks() {
    local candidate
    while IFS= read -r candidate; do
        [ -n "$candidate" ] || continue
        scrub_env_keys_from_file "$candidate" "BIFROST_BRIDGE_LOCAL_API_KEY" || true
    done < <(list_runtime_secret_candidate_files)
}

strip_generated_runtime_secret_plaintext_fallbacks() {
    local key="$1"
    local candidate
    while IFS= read -r candidate; do
        [ -n "$candidate" ] || continue
        scrub_env_keys_from_file "$candidate" "$key" || true
    done < <(list_runtime_secret_candidate_files)
}

strip_cloudsmith_plaintext_fallbacks() {
    local candidate
    while IFS= read -r candidate; do
        [ -n "$candidate" ] || continue
        scrub_env_keys_from_file "$candidate" "CLOUDSMITH_ENTITLEMENT_TOKEN" || true
    done < <(list_mutable_cloudsmith_secret_files)
}

generate_local_stack_api_key() {
    local random_value
    random_value="$(openssl rand -base64 36 | tr -d '\n=' | tr '/+' '_-' | cut -c1-48)"
    echo "sk-local-$random_value"
}

generate_bifrost_local_api_key() {
    local random_value
    random_value="$(openssl rand -base64 36 | tr -d '\n=' | tr '/+' '_-' | cut -c1-48)"
    echo "sk-bifrost-local-$random_value"
}

generate_ultra_multi_agent_signing_secret() {
    local random_value
    random_value="$(openssl rand -base64 48 | tr -d '\n=' | tr '/+' '_-' | cut -c1-64)"
    echo "ultra-sign-v1-$random_value"
}

generate_owui_auth_bridge_secret() {
    local random_value
    random_value="$(openssl rand -base64 48 | tr -d '\n=' | tr '/+' '_-' | cut -c1-64)"
    echo "owui-bridge-$random_value"
}

generate_webui_secret_key() {
    openssl rand -base64 64 | tr -d '\n=' | tr '/+' '_-' | cut -c1-86
}

resolve_generated_runtime_secret() {
    local key="$1"
    local generator="$2"
    local configured_value
    local keychain_only=0
    local can_read_plaintext_fallback=1
    if is_keychain_only_mode; then
        keychain_only=1
    fi
    if [ "$keychain_only" -eq 1 ] && ! is_plaintext_fallback_allowed; then
        can_read_plaintext_fallback=0
    fi

    configured_value="$(eval "printf '%s' \"\${$key:-}\"" | tr -d '[:space:]')"
    if [ -n "$configured_value" ]; then
        if ! upsert_secret_in_keychain "$key" "$configured_value" && [ "$keychain_only" -eq 1 ]; then
            echo "❌ Keychain-only mode requires persisting $key in macOS Keychain" >&2
            return 1
        fi
        echo "$configured_value"
        return 0
    fi

    if configured_value="$(read_secret_from_keychain "$key" 2>/dev/null)"; then
        [ -n "$configured_value" ] && { echo "$configured_value"; return 0; }
    fi

    if [ "$can_read_plaintext_fallback" -eq 1 ]; then
        while IFS= read -r candidate; do
            configured_value="$(read_env_value_from_file "$candidate" "$key" || true)"
            if [ -n "$configured_value" ]; then
                if ! upsert_secret_in_keychain "$key" "$configured_value" && [ "$keychain_only" -eq 1 ]; then
                    echo "❌ Keychain-only mode requires persisting $key in macOS Keychain" >&2
                    return 1
                fi
                if [ "$keychain_only" -eq 1 ]; then
                    strip_generated_runtime_secret_plaintext_fallbacks "$key"
                fi
                echo "$configured_value"
                return 0
            fi
        done < <(list_runtime_secret_candidate_files)
    fi

    configured_value="$($generator)"
    if upsert_secret_in_keychain "$key" "$configured_value"; then
        if [ "$keychain_only" -eq 1 ]; then
            strip_generated_runtime_secret_plaintext_fallbacks "$key"
        fi
        echo "$configured_value"
        return 0
    fi
    if [ "$keychain_only" -eq 1 ]; then
        echo "❌ Keychain-only mode requires persisting $key in macOS Keychain" >&2
        return 1
    fi

    persist_runtime_secret "$key" "$configured_value"
    echo "$configured_value"
}

resolve_local_stack_api_key() {
    local configured_value
    local keychain_only=0
    local can_read_plaintext_fallback=1
    if is_keychain_only_mode; then
        keychain_only=1
    fi
    if [ "$keychain_only" -eq 1 ] && ! is_plaintext_fallback_allowed; then
        can_read_plaintext_fallback=0
    fi

    configured_value="${LOCAL_STACK_API_KEY:-${INTERNAL_OPENAI_API_KEY:-${OPENAI_API_KEY:-}}}"
    if [ -n "$configured_value" ]; then
        if ! upsert_secret_in_keychain "LOCAL_STACK_API_KEY" "$configured_value" && [ "$keychain_only" -eq 1 ]; then
            echo "❌ Keychain-only mode requires persisting LOCAL_STACK_API_KEY in macOS Keychain" >&2
            return 1
        fi
        echo "$configured_value"
        return 0
    fi

    if configured_value="$(read_secret_from_keychain "LOCAL_STACK_API_KEY" 2>/dev/null)"; then
        [ -n "$configured_value" ] && { echo "$configured_value"; return 0; }
    fi

    if [ "$can_read_plaintext_fallback" -eq 1 ]; then
        while IFS= read -r candidate; do
            configured_value="$(read_env_value_from_file "$candidate" "LOCAL_STACK_API_KEY" || true)"
            [ -n "$configured_value" ] && break
            configured_value="$(read_env_value_from_file "$candidate" "INTERNAL_OPENAI_API_KEY" || true)"
            [ -n "$configured_value" ] && break
            configured_value="$(read_env_value_from_file "$candidate" "OPENAI_API_KEY" || true)"
            [ -n "$configured_value" ] && break
        done < <(list_runtime_secret_candidate_files)
    fi

    if [ -n "$configured_value" ]; then
        if ! upsert_secret_in_keychain "LOCAL_STACK_API_KEY" "$configured_value" && [ "$keychain_only" -eq 1 ]; then
            echo "❌ Keychain-only mode requires persisting LOCAL_STACK_API_KEY in macOS Keychain" >&2
            return 1
        fi
        if [ "$keychain_only" -eq 1 ]; then
            strip_local_stack_plaintext_fallbacks
        fi
        echo "$configured_value"
        return 0
    fi

    configured_value="$(generate_local_stack_api_key)"
    if upsert_secret_in_keychain "LOCAL_STACK_API_KEY" "$configured_value"; then
        if [ "$keychain_only" -eq 1 ]; then
            strip_local_stack_plaintext_fallbacks
        fi
        echo "$configured_value"
        return 0
    fi
    if [ "$keychain_only" -eq 1 ]; then
        echo "❌ Keychain-only mode requires persisting LOCAL_STACK_API_KEY in macOS Keychain" >&2
        return 1
    fi

    persist_runtime_secret "LOCAL_STACK_API_KEY" "$configured_value"
    echo "$configured_value"
}

resolve_portico_llm_api_key() {
    local configured_value
    local keychain_only=0
    local can_read_plaintext_fallback=1
    if is_keychain_only_mode; then
        keychain_only=1
    fi
    if [ "$keychain_only" -eq 1 ] && ! is_plaintext_fallback_allowed; then
        can_read_plaintext_fallback=0
    fi

    configured_value="$(echo "${PORTICO_LLM_API_KEY:-}" | tr -d '[:space:]')"
    if [ -n "$configured_value" ] && ! is_malformed_upstream_key "$configured_value"; then
        if ! upsert_secret_in_keychain "PORTICO_LLM_API_KEY" "$configured_value" && [ "$keychain_only" -eq 1 ]; then
            echo "❌ Keychain-only mode requires persisting PORTICO_LLM_API_KEY in macOS Keychain" >&2
            return 1
        fi
        echo "$configured_value"
        return 0
    fi

    if configured_value="$(read_secret_from_keychain "PORTICO_LLM_API_KEY" 2>/dev/null)"; then
        if [ -n "$configured_value" ] && ! is_malformed_upstream_key "$configured_value"; then
            echo "$configured_value"
            return 0
        fi
    fi

    if [ "$can_read_plaintext_fallback" -eq 1 ]; then
        while IFS= read -r candidate; do
            configured_value="$(read_env_value_from_file "$candidate" "PORTICO_LLM_API_KEY" || true)"
            if [ -n "$configured_value" ] && ! is_malformed_upstream_key "$configured_value"; then
                if ! upsert_secret_in_keychain "PORTICO_LLM_API_KEY" "$configured_value" && [ "$keychain_only" -eq 1 ]; then
                    echo "❌ Keychain-only mode requires persisting PORTICO_LLM_API_KEY in macOS Keychain" >&2
                    return 1
                fi
                if [ "$keychain_only" -eq 1 ]; then
                    strip_upstream_plaintext_fallbacks
                fi
                echo "$configured_value"
                return 0
            fi
        done < <(list_upstream_secret_candidate_files)
    fi

    return 1
}

resolve_bifrost_local_api_key() {
    local configured_value
    local keychain_only=0
    local can_read_plaintext_fallback=1
    if is_keychain_only_mode; then
        keychain_only=1
    fi
    if [ "$keychain_only" -eq 1 ] && ! is_plaintext_fallback_allowed; then
        can_read_plaintext_fallback=0
    fi

    configured_value="$(echo "${BIFROST_BRIDGE_LOCAL_API_KEY:-}" | tr -d '[:space:]')"
    if [ -n "$configured_value" ]; then
        if ! upsert_secret_in_keychain "BIFROST_BRIDGE_LOCAL_API_KEY" "$configured_value" && [ "$keychain_only" -eq 1 ]; then
            echo "❌ Keychain-only mode requires persisting BIFROST_BRIDGE_LOCAL_API_KEY in macOS Keychain" >&2
            return 1
        fi
        echo "$configured_value"
        return 0
    fi

    if configured_value="$(read_secret_from_keychain "BIFROST_BRIDGE_LOCAL_API_KEY" 2>/dev/null)"; then
        [ -n "$configured_value" ] && { echo "$configured_value"; return 0; }
    fi

    if [ "$can_read_plaintext_fallback" -eq 1 ]; then
        while IFS= read -r candidate; do
            configured_value="$(read_env_value_from_file "$candidate" "BIFROST_BRIDGE_LOCAL_API_KEY" || true)"
            if [ -n "$configured_value" ]; then
                if ! upsert_secret_in_keychain "BIFROST_BRIDGE_LOCAL_API_KEY" "$configured_value" && [ "$keychain_only" -eq 1 ]; then
                    echo "❌ Keychain-only mode requires persisting BIFROST_BRIDGE_LOCAL_API_KEY in macOS Keychain" >&2
                    return 1
                fi
                if [ "$keychain_only" -eq 1 ]; then
                    strip_bifrost_plaintext_fallbacks
                fi
                echo "$configured_value"
                return 0
            fi
        done < <(list_runtime_secret_candidate_files)
    fi

    configured_value="$(generate_bifrost_local_api_key)"
    if upsert_secret_in_keychain "BIFROST_BRIDGE_LOCAL_API_KEY" "$configured_value"; then
        if [ "$keychain_only" -eq 1 ]; then
            strip_bifrost_plaintext_fallbacks
        fi
        echo "$configured_value"
        return 0
    fi
    if [ "$keychain_only" -eq 1 ]; then
        echo "❌ Keychain-only mode requires persisting BIFROST_BRIDGE_LOCAL_API_KEY in macOS Keychain" >&2
        return 1
    fi

    persist_runtime_secret "BIFROST_BRIDGE_LOCAL_API_KEY" "$configured_value"
    echo "$configured_value"
}

validate_ultra_multi_agent_signing_secret() {
    local secret="$1"
    case "$secret" in
        ultra-sign-v1-*) ;;
        *)
            echo "❌ ULTRA_MULTI_AGENT_SIGNING_SECRET must use the ultra-sign-v1 key format" >&2
            return 1
            ;;
    esac
    if [ "${#secret}" -lt 70 ]; then
        echo "❌ ULTRA_MULTI_AGENT_SIGNING_SECRET is too short" >&2
        return 1
    fi
    local peer_secret
    for peer_secret in \
        "${LOCAL_STACK_API_KEY:-}" \
        "${INTERNAL_OPENAI_API_KEY:-}" \
        "${OPENAI_API_KEY:-}" \
        "${BIFROST_BRIDGE_LOCAL_API_KEY:-}" \
        "${OWUI_AUTH_BRIDGE_SECRET:-}" \
        "${WEBUI_SECRET_KEY:-}" \
        "${PORTICO_LLM_API_KEY:-}"; do
        [ -n "$peer_secret" ] || continue
        if [ "$secret" = "$peer_secret" ]; then
            echo "❌ ULTRA_MULTI_AGENT_SIGNING_SECRET must be distinct from bearer, upstream, and application secrets" >&2
            return 1
        fi
    done
}

resolve_ultra_multi_agent_signing_secret() {
    local secret
    secret="$(resolve_generated_runtime_secret "ULTRA_MULTI_AGENT_SIGNING_SECRET" "generate_ultra_multi_agent_signing_secret")" || return 1
    validate_ultra_multi_agent_signing_secret "$secret" || return 1
    echo "$secret"
}

resolve_owui_auth_bridge_secret() {
    resolve_generated_runtime_secret "OWUI_AUTH_BRIDGE_SECRET" "generate_owui_auth_bridge_secret"
}

resolve_webui_secret_key() {
    resolve_generated_runtime_secret "WEBUI_SECRET_KEY" "generate_webui_secret_key"
}

resolve_cloudsmith_entitlement_token() {
    local configured_value
    local verified_value
    local keychain_only=0
    local can_read_plaintext_fallback=1
    if is_keychain_only_mode; then
        keychain_only=1
    fi
    if [ "$keychain_only" -eq 1 ] && ! is_plaintext_fallback_allowed; then
        can_read_plaintext_fallback=0
    fi

    configured_value="$(echo "${CLOUDSMITH_ENTITLEMENT_TOKEN:-}" | tr -d '[:space:]')"
    if [ -n "$configured_value" ]; then
        if [ "$keychain_only" -eq 1 ]; then
            if ! upsert_secret_in_keychain "CLOUDSMITH_ENTITLEMENT_TOKEN" "$configured_value"; then
                echo "Cloudsmith entitlement token could not be secured in macOS Keychain. The Keychain write did not succeed. Reinstall the signed app or repair Keychain access, then retry." >&2
                return 1
            fi
            verified_value="$(read_secret_from_keychain "CLOUDSMITH_ENTITLEMENT_TOKEN" 2>/dev/null || true)"
            if [ "$verified_value" != "$configured_value" ]; then
                echo "Cloudsmith entitlement token could not be secured in macOS Keychain. The Keychain readback verification failed. Reinstall the signed app or repair Keychain access, then retry." >&2
                return 1
            fi
            strip_cloudsmith_plaintext_fallbacks
            echo "$verified_value"
            return 0
        fi
        upsert_secret_in_keychain "CLOUDSMITH_ENTITLEMENT_TOKEN" "$configured_value" || true
        echo "$configured_value"
        return 0
    fi

    if configured_value="$(read_secret_from_keychain "CLOUDSMITH_ENTITLEMENT_TOKEN" 2>/dev/null)"; then
        [ -n "$configured_value" ] && { echo "$configured_value"; return 0; }
    fi

    if [ "$keychain_only" -eq 1 ]; then
        while IFS= read -r candidate; do
            configured_value="$(read_env_value_from_file "$candidate" "CLOUDSMITH_ENTITLEMENT_TOKEN" || true)"
            [ -n "$configured_value" ] || continue
            if ! upsert_secret_in_keychain "CLOUDSMITH_ENTITLEMENT_TOKEN" "$configured_value"; then
                echo "Cloudsmith entitlement token could not be secured in macOS Keychain. The Keychain write did not succeed. Reinstall the signed app or repair Keychain access, then retry." >&2
                return 1
            fi
            verified_value="$(read_secret_from_keychain "CLOUDSMITH_ENTITLEMENT_TOKEN" 2>/dev/null || true)"
            if [ "$verified_value" != "$configured_value" ]; then
                echo "Cloudsmith entitlement token could not be secured in macOS Keychain. The Keychain readback verification failed. Reinstall the signed app or repair Keychain access, then retry." >&2
                return 1
            fi
            strip_cloudsmith_plaintext_fallbacks
            echo "$verified_value"
            return 0
        done < <(list_cloudsmith_bootstrap_candidate_files)
        return 1
    fi

    if [ "$can_read_plaintext_fallback" -eq 0 ]; then
        return 1
    fi

    while IFS= read -r candidate; do
        configured_value="$(read_env_value_from_file "$candidate" "CLOUDSMITH_ENTITLEMENT_TOKEN" || true)"
        if [ -n "$configured_value" ]; then
            upsert_secret_in_keychain "CLOUDSMITH_ENTITLEMENT_TOKEN" "$configured_value" || true
            echo "$configured_value"
            return 0
        fi
    done < <(list_cloudsmith_secret_candidate_files "1")

    return 1
}

resolve_mcp_sensitive_env_secret() {
    local env_var_name="$1"
    local current_value configured_value verified_value
    local marker
    marker="$(mcp_sensitive_env_migration_marker)"

    current_value="${!env_var_name-}"
    if [ -n "$current_value" ]; then
        upsert_secret_in_keychain "$env_var_name" "$current_value" || return 2
        verified_value="$(read_secret_from_keychain "$env_var_name" 2>/dev/null || true)"
        [ "$verified_value" = "$current_value" ] || return 2
        printf '%s\n' "$verified_value"
        return 0
    fi

    if configured_value="$(read_secret_from_keychain "$env_var_name" 2>/dev/null)"; then
        [ -n "$configured_value" ] && { printf '%s\n' "$configured_value"; return 0; }
    fi

    if [ -n "${PROJECT_ROOT:-}" ] && [ ! -f "$marker" ]; then
        local candidate
        for candidate in "$PROJECT_ROOT/.env" "$PROJECT_ROOT/.env.runtime"; do
            configured_value="$(read_env_value_from_file "$candidate" "$env_var_name" || true)"
            [ -n "$configured_value" ] || continue
            upsert_secret_in_keychain "$env_var_name" "$configured_value" || return 2
            verified_value="$(read_secret_from_keychain "$env_var_name" 2>/dev/null || true)"
            [ "$verified_value" = "$configured_value" ] || return 2
            printf '%s\n' "$verified_value"
            return 0
        done
    fi

    return 1
}

mcp_sensitive_env_migration_marker() {
    [ -n "${PROJECT_ROOT:-}" ] || return 0
    printf '%s/open-webui-data/runtime-migrations/%s\n' \
        "$PROJECT_ROOT" \
        "$MCP_SENSITIVE_ENV_KEYCHAIN_MIGRATION"
}

complete_mcp_sensitive_env_keychain_migration() {
    [ -n "${PROJECT_ROOT:-}" ] || return 0

    local marker marker_dir temp_marker
    marker="$(mcp_sensitive_env_migration_marker)"
    [ -n "$marker" ] || return 0
    [ -f "$marker" ] && return 0

    marker_dir="$(dirname "$marker")"
    mkdir -p "$marker_dir" || return 1
    chmod 700 "$marker_dir" 2>/dev/null || true
    temp_marker="$(mktemp "$marker_dir/.${MCP_SENSITIVE_ENV_KEYCHAIN_MIGRATION}.XXXXXX")" || return 1
    if ! printf '{"migration":"%s","completed_at":"%s"}\n' \
        "$MCP_SENSITIVE_ENV_KEYCHAIN_MIGRATION" \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$temp_marker"; then
        rm -f "$temp_marker"
        return 1
    fi
    chmod 600 "$temp_marker" 2>/dev/null || true
    if ! mv "$temp_marker" "$marker"; then
        rm -f "$temp_marker"
        return 1
    fi
}

scrub_mcp_sensitive_env_legacy_sources() {
    [ -n "${PROJECT_ROOT:-}" ] || return 0

    local sensitive_key candidate
    while IFS= read -r sensitive_key; do
        [ -n "$sensitive_key" ] || continue
        for candidate in "$PROJECT_ROOT/.env" "$PROJECT_ROOT/.env.runtime"; do
            [ -f "$candidate" ] || continue
            if grep -qE "^(${sensitive_key}|${sensitive_key}_FILE)=" "$candidate"; then
                scrub_env_keys_from_file \
                    "$candidate" \
                    "$sensitive_key" \
                    "${sensitive_key}_FILE" || return 1
            fi
        done
    done < <(discover_sensitive_required_env_vars)
}

ensure_mcp_sensitive_env_secret_presence() {
    local server_id sensitive_key secret_name availability_env sensitive_status
    while IFS=$'\t' read -r server_id sensitive_key secret_name; do
        [ -n "$server_id" ] || continue
        [ -n "$sensitive_key" ] || continue
        availability_env="$(static_secret_availability_env_var "$server_id" "$secret_name")"
        sensitive_status=0
        resolve_mcp_sensitive_env_secret "$sensitive_key" >/dev/null || sensitive_status=$?
        if [ "$sensitive_status" -eq 0 ]; then
            export "$availability_env=1"
        elif [ "$sensitive_status" -eq 1 ]; then
            unset "$availability_env"
        else
            echo "✗ Failed to persist sensitive MCP env var $sensitive_key to Keychain" >&2
            return "$sensitive_status"
        fi
    done < <(discover_sensitive_required_env_var_descriptors)

    scrub_mcp_sensitive_env_legacy_sources || return 1
    complete_mcp_sensitive_env_keychain_migration || return 1

    while IFS= read -r sensitive_key; do
        [ -n "$sensitive_key" ] || continue
        unset "$sensitive_key" "${sensitive_key}_FILE"
    done < <(discover_sensitive_required_env_vars)
}

prune_empty_legacy_slack_oauth_dirs() {
    [ -n "${PROJECT_ROOT:-}" ] || return 0

    local root_dir server_dir token_dir
    for root_dir in \
        "$PROJECT_ROOT/mcpo-oauth-tokens" \
        "$PROJECT_ROOT/mcpo-core-oauth-tokens"; do
        server_dir="$root_dir/slack"
        token_dir="$server_dir/tokens"
        [ -d "$token_dir" ] && rmdir "$token_dir" 2>/dev/null || true
        [ -d "$server_dir" ] && rmdir "$server_dir" 2>/dev/null || true
        [ -d "$root_dir" ] && rmdir "$root_dir" 2>/dev/null || true
    done
}

clear_legacy_slack_pkce_oauth_artifacts_once() {
    [ -n "${PROJECT_ROOT:-}" ] || return 0

    local marker_dir="$PROJECT_ROOT/open-webui-data/runtime-migrations"
    local marker="$marker_dir/slack-pkce-public-client-artifacts-cleared-v2"
    if [ -f "$marker" ]; then
        prune_empty_legacy_slack_oauth_dirs
        return 0
    fi

    local token_dir artifact
    for token_dir in \
        "$PROJECT_ROOT/mcpo-oauth-tokens/slack/tokens" \
        "$PROJECT_ROOT/mcpo-core-oauth-tokens/slack/tokens"; do
        [ -d "$token_dir" ] || continue
        while IFS= read -r -d '' artifact; do
            rm -f "$artifact" || return 1
        done < <(find "$token_dir" -type f \( -name '*_tokens.json' -o -name '*_client.json' \) -print0 2>/dev/null)
    done
    prune_empty_legacy_slack_oauth_dirs

    mkdir -p "$marker_dir" || return 1
    chmod 700 "$marker_dir" 2>/dev/null || true
    printf '%s\n' '{"migration":"slack-pkce-public-client-artifacts-cleared","marker_version":2}' > "$marker" || return 1
    chmod 600 "$marker" 2>/dev/null || true
}

cleanup_legacy_bundled_slack_keychain_credentials() {
    local metadata compacted
    metadata="$(read_secret_from_keychain "SLACK_OAUTH_CREDENTIALS_METADATA" 2>/dev/null || true)"
    [ -n "$metadata" ] || return 0

    compacted="$(printf '%s' "$metadata" | tr -d '[:space:]')"
    case "$compacted" in
        *'"owner":"bundled"'*)
            delete_secret_from_keychain "SLACK_OAUTH_CLIENT_ID" || true
            delete_secret_from_keychain "SLACK_OAUTH_CLIENT_SECRET" || true
            delete_secret_from_keychain "SLACK_OAUTH_CREDENTIALS_METADATA" || true
            ;;
    esac
}

ensure_runtime_secret_env() {
    local local_stack_key
    local upstream_key
    local bifrost_local_key
    local ultra_multi_agent_signing_secret
    local owui_auth_bridge_secret
    local webui_secret_key
    local cloudsmith_entitlement_token

    local_stack_key="$(resolve_local_stack_api_key)" || return 1
    export LOCAL_STACK_API_KEY="$local_stack_key"
    export INTERNAL_OPENAI_API_KEY="$local_stack_key"
    export OPENAI_API_KEY="$local_stack_key"

    bifrost_local_key="$(resolve_bifrost_local_api_key)" || return 1
    export BIFROST_BRIDGE_LOCAL_API_KEY="$bifrost_local_key"


    owui_auth_bridge_secret="$(resolve_owui_auth_bridge_secret)" || return 1
    export OWUI_AUTH_BRIDGE_SECRET="$owui_auth_bridge_secret"

    webui_secret_key="$(resolve_webui_secret_key)" || return 1
    export WEBUI_SECRET_KEY="$webui_secret_key"

    if upstream_key="$(resolve_portico_llm_api_key)"; then
        export PORTICO_LLM_API_KEY="$upstream_key"
    elif [ -z "${PORTICO_LLM_API_KEY:-}" ]; then
        echo "⚠ PORTICO_LLM_API_KEY is not configured via env/keychain (or explicit plaintext fallback override)." >&2
    fi

    ultra_multi_agent_signing_secret="$(resolve_ultra_multi_agent_signing_secret)" || return 1
    export ULTRA_MULTI_AGENT_SIGNING_SECRET="$ultra_multi_agent_signing_secret"

    if cloudsmith_entitlement_token="$(resolve_cloudsmith_entitlement_token)"; then
        export CLOUDSMITH_ENTITLEMENT_TOKEN="$cloudsmith_entitlement_token"
    fi

    cleanup_legacy_bundled_slack_keychain_credentials || return 1
    clear_legacy_slack_pkce_oauth_artifacts_once || return 1
    unset SLACK_OAUTH_CLIENT_ID SLACK_OAUTH_CLIENT_SECRET
    unset SLACK_OAUTH_CLIENT_ID_FILE SLACK_OAUTH_CLIENT_SECRET_FILE

    ensure_mcp_sensitive_env_secret_presence || return $?

    local scrub_key
    while IFS= read -r scrub_key; do
        [ -n "$scrub_key" ] || continue
        local candidate
        while IFS= read -r candidate; do
            scrub_env_keys_from_file "$candidate" "$scrub_key" "${scrub_key}_FILE" || true
        done < <(list_runtime_secret_candidate_files; [ -n "${PROJECT_ROOT:-}" ] && printf '%s\n' "$PROJECT_ROOT/.env" "$PROJECT_ROOT/.env.runtime")
    done < <(
        discover_sensitive_required_env_vars
        printf '%s\n' \
            SLACK_OAUTH_CLIENT_ID \
            SLACK_OAUTH_CLIENT_SECRET \
            SLACK_MCP_XOXP_TOKEN
    )

    if is_keychain_only_mode; then
        strip_upstream_plaintext_fallbacks
        strip_local_stack_plaintext_fallbacks
        strip_bifrost_plaintext_fallbacks
        strip_cloudsmith_plaintext_fallbacks
    fi
}
