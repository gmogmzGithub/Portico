#!/usr/bin/env bash

if [ -n "${MANAGED_RUNTIME_INTEGRITY_SH_LOADED:-}" ]; then
    return 0 2>/dev/null || exit 0
fi
MANAGED_RUNTIME_INTEGRITY_SH_LOADED=1

MANAGED_RUNTIME_GENERATED_COMPOSE_FILES=(
    "docker-compose.override.yml"
    "docker-compose.harbor.yml"
)

MANAGED_RUNTIME_REQUIRED_VOLUME_FILES=(
    ".env"
    "HOST_MODE"
    "mcp_toggles.json"
    "mcp_config.json"
    "mcp_config_advanced.json"
    "mcp_config_core.json"
    "mcp_config_host_sideload.json"
    "mcp_tools_config.json"
    "marketplaces.json"
)

if [[ "${BASH_SOURCE[0]}" == */* ]]; then
    MANAGED_RUNTIME_INTEGRITY_SCRIPT_DIR="$(cd "${BASH_SOURCE[0]%/*}" && pwd)"
else
    MANAGED_RUNTIME_INTEGRITY_SCRIPT_DIR="$(pwd)"
fi

# shellcheck source=/dev/null
. "$MANAGED_RUNTIME_INTEGRITY_SCRIPT_DIR/mcp-orc-cli.sh"

managed_runtime_integrity_log() {
    local level="$1"
    local message="$2"
    local logger="log_${level}"

    if declare -F "$logger" >/dev/null 2>&1; then
        "$logger" "$message"
        return 0
    fi

    if [ "$level" = "error" ]; then
        printf '[%s] %s\n' "$level" "$message" >&2
        return 0
    fi

    printf '[%s] %s\n' "$level" "$message"
}

managed_runtime_resolve_python3() {
    local candidate=""
    local resolved_path=""
    local system_name=""

    system_name="$(uname -s 2>/dev/null || printf '')"

    for candidate in /opt/homebrew/bin/python3 /usr/local/bin/python3; do
        if [ -x "$candidate" ] && "$candidate" --version >/dev/null 2>&1; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done

    if [ "$system_name" != "Darwin" ] && [ -x /usr/bin/python3 ] && /usr/bin/python3 --version >/dev/null 2>&1; then
        printf '%s\n' "/usr/bin/python3"
        return 0
    fi

    if command -v python3 >/dev/null 2>&1; then
        resolved_path="$(command -v python3)"
        if [ -n "$resolved_path" ] \
            && [ "$resolved_path" != "/usr/bin/python3" ] \
            && [ -x "$resolved_path" ] \
            && "$resolved_path" --version >/dev/null 2>&1; then
            printf '%s\n' "$resolved_path"
            return 0
        fi
    fi

    return 1
}

managed_runtime_read_build_number() {
    local project_root="$1"
    local build_info_file="$project_root/electron-app/build-info.json"
    local python3_bin=""

    [ -f "$build_info_file" ] || return 1

    python3_bin="$(managed_runtime_resolve_python3 || true)"
    if [ -n "$python3_bin" ]; then
        "$python3_bin" - "$build_info_file" <<'PY' 2>/dev/null || true
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as fh:
    data = json.load(fh)
value = data.get("buildNumber", "")
if isinstance(value, str) and value:
    print(value)
PY
        return 0
    fi

    grep -o '"buildNumber"[[:space:]]*:[[:space:]]*"[^"]*"' "$build_info_file" \
        | sed 's/.*"\([^"]*\)".*/\1/' \
        | head -n 1
}

# PORTICO-371: the Harbor runtime image tag. Beta builds tag images == build number,
# but MR/broker builds tag them mr-<iid>-<sha> and record it as dockerImageTag.
# Prefer that field; fall back to the build number. This must mirror the app's
# generator (get_image_tag) so validation expects the tag actually generated.
managed_runtime_read_image_tag() {
    local project_root="$1"
    local build_info_file="$project_root/electron-app/build-info.json"
    local python3_bin=""
    local tag=""

    [ -f "$build_info_file" ] || return 1

    python3_bin="$(managed_runtime_resolve_python3 || true)"
    if [ -n "$python3_bin" ]; then
        "$python3_bin" - "$build_info_file" <<'PY' 2>/dev/null || true
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as fh:
    data = json.load(fh)
tag = data.get("dockerImageTag", "")
if not (isinstance(tag, str) and tag and tag != "dev-build"):
    tag = data.get("buildNumber", "")
if isinstance(tag, str) and tag:
    print(tag)
PY
        return 0
    fi

    tag="$(grep -o '"dockerImageTag"[[:space:]]*:[[:space:]]*"[^"]*"' "$build_info_file" \
        | sed 's/.*"\([^"]*\)".*/\1/' | head -n 1)"
    if [ -z "$tag" ] || [ "$tag" = "dev-build" ]; then
        tag="$(grep -o '"buildNumber"[[:space:]]*:[[:space:]]*"[^"]*"' "$build_info_file" \
            | sed 's/.*"\([^"]*\)".*/\1/' | head -n 1)"
    fi
    printf '%s\n' "$tag"
}

managed_runtime_infer_packaged_resources_root() {
    local script_dir="${1:-$MANAGED_RUNTIME_INTEGRITY_SCRIPT_DIR}"
    local normalized_dir

    normalized_dir="$(cd "$script_dir" && pwd)"
    case "$normalized_dir" in
        *.app/Contents/Resources|*.app/Contents/Resources/*)
            printf '%s\n' "${normalized_dir%%/Contents/Resources*}/Contents/Resources"
            return 0
            ;;
    esac

    return 1
}

managed_runtime_normalize_packaged_resources_root() {
    local candidate="$1"
    local normalized_candidate=""

    [ -n "$candidate" ] || return 1

    if [ -d "$candidate/Contents/Resources" ]; then
        candidate="$candidate/Contents/Resources"
    fi

    [ -d "$candidate" ] || return 1

    normalized_candidate="$(cd "$candidate" && pwd)"
    case "$normalized_candidate" in
        *.app/Contents/Resources|*.app/Contents/Resources/*)
            printf '%s\n' "${normalized_candidate%%/Contents/Resources*}/Contents/Resources"
            return 0
            ;;
    esac

    return 1
}

managed_runtime_prepare_packaged_env() {
    local script_dir="${1:-$MANAGED_RUNTIME_INTEGRITY_SCRIPT_DIR}"
    local requested_resources_root="${2:-}"
    local inferred_resources_root=""
    local normalized_requested_resources_root=""

    if [ -n "$requested_resources_root" ]; then
        normalized_requested_resources_root="$(managed_runtime_normalize_packaged_resources_root "$requested_resources_root" || true)"
        if [ -z "$normalized_requested_resources_root" ]; then
            managed_runtime_integrity_log error "Packaged resources root is invalid or missing: $requested_resources_root"
            return 1
        fi
        export HOST_MCP_RESOURCES_ROOT="$normalized_requested_resources_root"
    fi

    if [ -z "${HOST_MCP_RESOURCES_ROOT:-}" ]; then
        inferred_resources_root="$(managed_runtime_infer_packaged_resources_root "$script_dir" || true)"
        if [ -n "$inferred_resources_root" ]; then
            export HOST_MCP_RESOURCES_ROOT="$inferred_resources_root"
        fi
    fi

    if host_mcp_is_packaged_mac_resources_root "${HOST_MCP_RESOURCES_ROOT:-}"; then
        export HOST_MCP_IS_PACKAGED=1
        return 0
    fi

    return 1
}

managed_runtime_require_packaged_generator_binary() {
    local project_root="$1"
    local resources_root="$2"
    local normalized_resources_root=""

    normalized_resources_root="$(managed_runtime_normalize_packaged_resources_root "$resources_root" || true)"
    if [ -z "$normalized_resources_root" ]; then
        managed_runtime_integrity_log error "Packaged resources root is invalid or missing: $resources_root"
        return 1
    fi

    managed_runtime_prepare_packaged_env "$MANAGED_RUNTIME_INTEGRITY_SCRIPT_DIR" "$normalized_resources_root" >/dev/null 2>&1 || true

    if ! resolve_mcp_orc_generator_binary "$project_root" "$normalized_resources_root" >/dev/null 2>&1; then
        managed_runtime_integrity_log error "Unable to resolve the packaged mcp-orc generator binary for $project_root using resources root $normalized_resources_root"
        return 1
    fi

    printf '%s\n' "$normalized_resources_root"
}

managed_runtime_is_packaged_runtime() {
    local project_root="$1"
    local build_number="${2:-}"

    if [ -z "$build_number" ]; then
        build_number="$(managed_runtime_read_build_number "$project_root" || true)"
    fi

    [ -n "$build_number" ] || return 1
    [ "$build_number" != "dev-build" ] || return 1
    host_mcp_is_packaged_mac_resources_root "${HOST_MCP_RESOURCES_ROOT:-}"
}

managed_runtime_remove_generated_compose_files() {
    local root_dir="$1"
    local removed=()
    local rel_path=""

    for rel_path in "${MANAGED_RUNTIME_GENERATED_COMPOSE_FILES[@]}"; do
        local target_path="$root_dir/$rel_path"
        if [ ! -e "$target_path" ] && [ ! -L "$target_path" ]; then
            continue
        fi

        rm -rf "$target_path"
        removed+=("$rel_path")
    done

    if [ "${#removed[@]}" -gt 0 ]; then
        managed_runtime_integrity_log warning "Removed generated compose artifact(s) from runtime payload: ${removed[*]}"
    fi
}

managed_runtime_write_required_volume_file() {
    local rel_path="$1"
    local target_path="$2"

    mkdir -p "$(dirname "$target_path")"

    case "$rel_path" in
        HOST_MODE)
            printf 'FALSE\n' > "$target_path"
            ;;
        *.json)
            # PORTICO-364: atomic (tmp + mv) so an interrupted write can never leave
            # a 0-byte JSON file (e.g. mcp_toggles.json) that dead-ends toggles.
            local json_tmp="${target_path}.$$.tmp"
            printf '{}\n' > "$json_tmp"
            mv -f "$json_tmp" "$target_path"
            ;;
        *)
            : > "$target_path"
            ;;
    esac
}

# PORTICO-364: blank / whitespace-only JSON is invalid; detect it so the volume-file
# ensurer re-initializes an existing 0-byte file instead of leaving it fatal.
managed_runtime_json_file_is_blank() {
    local path="$1"
    [ -s "$path" ] || return 0
    [ -z "$(tr -d '[:space:]' <"$path" 2>/dev/null)" ]
}

managed_runtime_ensure_required_volume_files() {
    local project_root="$1"
    local rel_path=""
    local normalized_paths=()
    local created_paths=()

    for rel_path in "${MANAGED_RUNTIME_REQUIRED_VOLUME_FILES[@]}"; do
        local target_path="$project_root/$rel_path"

        if [ -d "$target_path" ]; then
            rm -rf "$target_path"
            normalized_paths+=("$rel_path")
        fi

        if [ ! -f "$target_path" ]; then
            managed_runtime_write_required_volume_file "$rel_path" "$target_path"
            created_paths+=("$rel_path")
        elif [ "${rel_path##*.}" = "json" ] && managed_runtime_json_file_is_blank "$target_path"; then
            # PORTICO-364: re-initialize an existing blank/whitespace-only JSON file
            # (e.g. a 0-byte mcp_toggles.json) so it is never left fatal.
            managed_runtime_write_required_volume_file "$rel_path" "$target_path"
            normalized_paths+=("$rel_path")
        fi
    done

    if [ "${#normalized_paths[@]}" -gt 0 ]; then
        managed_runtime_integrity_log warning "Normalized required volume file path(s) into files: ${normalized_paths[*]}"
    fi

    if [ "${#created_paths[@]}" -gt 0 ]; then
        managed_runtime_integrity_log info "Ensured required volume file(s) exist: ${created_paths[*]}"
    fi
}

managed_runtime_harbor_header_tag() {
    local harbor_file="$1"
    [ -f "$harbor_file" ] || return 1

    sed -n 's/^# Image tag: \(.*\) (from build-info\.json)$/\1/p' "$harbor_file" | head -n 1
}

managed_runtime_list_harbor_image_refs() {
    local project_root="$1"
    local harbor_file="$project_root/docker-compose.harbor.yml"

    [ -f "$harbor_file" ] || return 1

    sed -n 's/^[[:space:]]*image:[[:space:]]*\([^[:space:]]*\/portico\/[^[:space:]]*\)$/\1/p' "$harbor_file" | sort -u
}

managed_runtime_validate_generated_compose() {
    local project_root="$1"
    local build_number="${2:-}"
    local harbor_file="$project_root/docker-compose.harbor.yml"
    local override_file="$project_root/docker-compose.override.yml"
    local image_tag=""
    local image_ref=""
    local image_ref_tag=""
    local expected_tag=""

    if [ -z "$build_number" ]; then
        build_number="$(managed_runtime_read_build_number "$project_root" || true)"
    fi

    if [ -z "$build_number" ] || [ "$build_number" = "dev-build" ]; then
        managed_runtime_integrity_log error "Managed runtime is missing a packaged build number at $project_root/electron-app/build-info.json"
        return 1
    fi

    # PORTICO-371: the generated compose is tagged with the Harbor image tag, which
    # equals the build number for beta builds but is mr-<iid>-<sha> for
    # MR/broker builds (dockerImageTag). Validate against that, not the build
    # number, or MR-preview installs fail the compose-regeneration integrity gate.
    expected_tag="$(managed_runtime_read_image_tag "$project_root" || true)"
    [ -n "$expected_tag" ] || expected_tag="$build_number"

    if [ ! -f "$override_file" ]; then
        managed_runtime_integrity_log error "Generated runtime compose override is missing: $override_file"
        return 1
    fi

    if [ ! -f "$harbor_file" ]; then
        managed_runtime_integrity_log error "Generated Harbor compose override is missing: $harbor_file"
        return 1
    fi

    image_tag="$(managed_runtime_harbor_header_tag "$harbor_file" || true)"
    if [ -z "$image_tag" ]; then
        managed_runtime_integrity_log error "Generated Harbor compose override is missing the build tag header: $harbor_file"
        return 1
    fi

    if [ "$image_tag" != "$expected_tag" ]; then
        managed_runtime_integrity_log error "Generated Harbor compose override tag mismatch: expected $expected_tag, found $image_tag"
        return 1
    fi

    while IFS= read -r image_ref; do
        [ -n "$image_ref" ] || continue
        image_ref_tag="${image_ref##*:}"
        if [ "$image_ref_tag" != "$expected_tag" ]; then
            managed_runtime_integrity_log error "Generated Harbor compose override references stale image $image_ref (expected tag $expected_tag)"
            return 1
        fi
    done < <(managed_runtime_list_harbor_image_refs "$project_root" || true)

    return 0
}

managed_runtime_regenerate_generated_compose() {
    local project_root="$1"
    local script_dir="${2:-$MANAGED_RUNTIME_INTEGRITY_SCRIPT_DIR}"
    local resources_root="${3:-}"
    local active_resources_root=""

    if [ -n "$resources_root" ]; then
        active_resources_root="$(managed_runtime_require_packaged_generator_binary "$project_root" "$resources_root" || true)"
        if [ -z "$active_resources_root" ]; then
            return 1
        fi
    else
        managed_runtime_prepare_packaged_env "$script_dir" >/dev/null 2>&1 || true
        active_resources_root="${HOST_MCP_RESOURCES_ROOT:-}"

        if ! resolve_mcp_orc_generator_binary "$project_root" "$active_resources_root" >/dev/null 2>&1; then
            if [ -n "$active_resources_root" ]; then
                managed_runtime_integrity_log error "Unable to resolve the packaged mcp-orc generator binary for $project_root using resources root $active_resources_root"
            else
                managed_runtime_integrity_log error "Unable to resolve the packaged mcp-orc generator binary for $project_root"
            fi
            return 1
        fi
    fi

    managed_runtime_ensure_required_volume_files "$project_root"
    managed_runtime_integrity_log info "Regenerating generated runtime compose artifacts..."
    HOST_MCP_RESOURCES_ROOT="$active_resources_root" run_mcp_orc_generator "$project_root" generate-docker-compose-override --force
}

# The Agent VM image is created on demand by the agent-vm server and is NOT a
# docker-compose service, so it never appears in docker-compose.harbor.yml. The
# compose-derived Harbor list therefore misses it, which meant a managed-runtime
# update never pulled the new build's agent-vm image — the PORTICO-231 root cause on
# the update path (VM creation later hard-failed on the missing image). Provision
# it explicitly, at the same build tag the compose services use. Empty for dev/
# local builds (no header tag), which use a locally built agent-vm:latest.
managed_runtime_agent_vm_image_ref() {
    local project_root="$1"
    local harbor_file="$project_root/docker-compose.harbor.yml"
    local tag=""

    tag="$(managed_runtime_harbor_header_tag "$harbor_file" 2>/dev/null || true)"
    [ -n "$tag" ] || return 0
    printf 'harbor.example.invalid/portico/agent-vm:%s\n' "$tag"
}

# Images the managed runtime must have present locally after an update: the
# compose service images plus the on-demand agent-vm image. Kept separate from
# managed_runtime_list_harbor_image_refs(), which also VALIDATES the generated
# compose and must stay limited to compose-referenced refs.
managed_runtime_list_required_image_refs() {
    local project_root="$1"
    managed_runtime_list_harbor_image_refs "$project_root" || true
    managed_runtime_agent_vm_image_ref "$project_root" || true
}

managed_runtime_pull_missing_harbor_images() {
    local project_root="$1"
    local missing_images=()
    local image_ref=""

    while IFS= read -r image_ref; do
        [ -n "$image_ref" ] || continue
        if ! docker image inspect "$image_ref" >/dev/null 2>&1; then
            missing_images+=("$image_ref")
        fi
    done < <(managed_runtime_list_required_image_refs "$project_root" || true)

    if [ "${#missing_images[@]}" -eq 0 ]; then
        return 0
    fi

    managed_runtime_integrity_log warning "Pulling ${#missing_images[@]} missing Harbor image(s) for packaged runtime update"
    for image_ref in "${missing_images[@]}"; do
        managed_runtime_integrity_log info "Pulling Harbor image: $image_ref"
        docker pull "$image_ref"
    done
}

managed_runtime_self_heal_packaged_runtime() {
    local project_root="$1"
    local script_dir="${2:-$MANAGED_RUNTIME_INTEGRITY_SCRIPT_DIR}"
    local resources_root="${3:-}"
    local build_number=""

    managed_runtime_prepare_packaged_env "$script_dir" "$resources_root" >/dev/null 2>&1 || true
    build_number="$(managed_runtime_read_build_number "$project_root" || true)"

    if ! managed_runtime_is_packaged_runtime "$project_root" "$build_number"; then
        return 0
    fi

    managed_runtime_regenerate_generated_compose "$project_root" "$script_dir" "$resources_root" || return 1
    managed_runtime_validate_generated_compose "$project_root" "$build_number" || return 1
    managed_runtime_pull_missing_harbor_images "$project_root" || return 1
    managed_runtime_validate_generated_compose "$project_root" "$build_number" || return 1
    return 0
}
