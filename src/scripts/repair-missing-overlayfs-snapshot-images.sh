#!/usr/bin/env bash

# Repair the narrow PORTICO-415 failure where Docker's overlayfs metadata refers to
# a missing parent snapshot directory. This helper deliberately performs only
# an image refresh through the Docker CLI. It never accesses Docker's backing
# store and never stops or removes containers, volumes, networks, or cache.

set -euo pipefail

readonly APPLY_FLAG="--apply-missing-overlayfs-parent-repair"
readonly portico_COMPOSE_PROJECT="portico"

log() {
    printf '[snapshot-image-repair] %s\n' "$*" >&2
}

fail() {
    log "REFUSED: $*"
    return 1
}

run_docker() {
    command docker "$@"
}

run_pinned_docker() {
    local endpoint="$1"
    shift

    [[ "$endpoint" == unix://* ]] || {
        fail "captured Docker endpoint is not a local Unix socket."
        return 1
    }
    run_docker --host "$endpoint" "$@"
}

is_allowed_image_ref() {
    local image_ref="$1"

    case "$image_ref" in
        redis:7-alpine|mongo:7|nginx:alpine) return 0 ;;
        harbor.example.invalid/portico/mcpo-control-plane-rust:*|\
        harbor.example.invalid/portico/mcp-orc-rust:*|\
        harbor.example.invalid/portico/bifrost-bridge:*|\
        harbor.example.invalid/portico/open-webui-patched:*|\
        harbor.example.invalid/portico/health-check:*|\
        harbor.example.invalid/portico/chat-state-api:*|\
        harbor.example.invalid/portico/agent-vm:*|\
        portico-mcpo-control-plane-rust:*|\
        portico-mcp-orc-rust:*|\
        portico-open-webui:*|\
        portico-health-check:*|\
        portico-bifrost-bridge:*|\
        portico-chat-state-api:*|\
        agent-vm:*) return 0 ;;
        *) return 1 ;;
    esac
}

is_allowed_image_repository() {
    local repository="$1"

    case "$repository" in
        redis|mongo|nginx|\
        harbor.example.invalid/portico/mcpo-control-plane-rust|\
        harbor.example.invalid/portico/mcp-orc-rust|\
        harbor.example.invalid/portico/bifrost-bridge|\
        harbor.example.invalid/portico/open-webui-patched|\
        harbor.example.invalid/portico/health-check|\
        harbor.example.invalid/portico/chat-state-api|\
        harbor.example.invalid/portico/agent-vm|\
        portico-mcpo-control-plane-rust|\
        portico-mcp-orc-rust|\
        portico-open-webui|\
        portico-health-check|\
        portico-bifrost-bridge|\
        portico-chat-state-api|\
        agent-vm) return 0 ;;
        *) return 1 ;;
    esac
}

is_valid_image_id() {
    [[ "$1" =~ ^sha256:[0-9a-f]{64}$ ]]
}

is_allowed_image_digest() {
    local digest_ref="$1"
    local repository="${digest_ref%@*}"
    local digest="${digest_ref#*@}"

    [ "$repository" != "$digest_ref" ] || return 1
    is_allowed_image_repository "$repository" || return 1
    [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]
}

collect_candidate_mappings() {
    local inventory="$1"
    local repository=""
    local tag=""
    local image_id=""

    while IFS=$'\t' read -r repository tag image_id; do
        [ -n "$repository" ] || continue
        [ -n "$tag" ] || return 1
        is_valid_image_id "$image_id" || return 1
        if [ "$repository" = "<none>" ] || [ "$tag" = "<none>" ]; then
            continue
        fi

        local image_ref="${repository}:${tag}"
        if is_allowed_image_ref "$image_ref"; then
            printf '%s\t%s\n' "$image_ref" "$image_id"
        fi
    done <<<"$inventory"
}

collect_inventory_without_candidate_ids() {
    local inventory="$1"
    local candidate_ids="$2"
    local repository=""
    local tag=""
    local image_id=""

    while IFS=$'\t' read -r repository tag image_id; do
        [ -n "$repository" ] || continue
        if printf '%s\n' "$candidate_ids" | grep -Fqx -- "$image_id"; then
            continue
        fi
        printf '%s\t%s\t%s\n' "$repository" "$tag" "$image_id"
    done <<<"$inventory"
}

read_local_docker_context_state() {
    if [ -n "${DOCKER_HOST:-}" ] && [[ "$DOCKER_HOST" != unix://* ]]; then
        fail "DOCKER_HOST is not a local Unix socket."
        return 1
    fi

    local current_context=""
    current_context="$(run_docker context show 2>/dev/null)" || {
        fail "Docker context could not be determined."
        return 1
    }
    [ -n "$current_context" ] || {
        fail "Docker returned an empty current context."
        return 1
    }
    if [ -n "${DOCKER_CONTEXT:-}" ] && [ "$DOCKER_CONTEXT" != "$current_context" ]; then
        fail "DOCKER_CONTEXT does not match Docker's current context."
        return 1
    fi

    local endpoint=""
    endpoint="$(run_docker context inspect "$current_context" --format '{{(index .Endpoints "docker").Host}}' 2>/dev/null)" || {
        fail "Docker context endpoint could not be inspected."
        return 1
    }
    if [[ "$endpoint" != unix://* ]]; then
        fail "Docker context '$current_context' is not a proven local Unix-socket context."
        return 1
    fi
    if [ -n "${DOCKER_HOST:-}" ] && [ "$DOCKER_HOST" != "$endpoint" ]; then
        fail "DOCKER_HOST does not match the inspected local context endpoint."
        return 1
    fi

    [ "$current_context" = "${current_context//$'\n'/}" ] && \
        [ "$current_context" = "${current_context//$'\t'/}" ] && \
        [ "$endpoint" = "${endpoint//$'\n'/}" ] && \
        [ "$endpoint" = "${endpoint//$'\t'/}" ] || {
        fail "Docker context identity was malformed."
        return 1
    }

    printf '%s\t%s\n' "$current_context" "$endpoint"
}

read_docker_daemon_id() {
    local endpoint="$1"
    local daemon_id=""
    daemon_id="$(run_pinned_docker "$endpoint" info --format '{{.ID}}' 2>/dev/null)" || {
        fail "Docker daemon identity is unavailable."
        return 1
    }
    if [[ ! "$daemon_id" =~ ^[A-Za-z0-9][A-Za-z0-9:._-]*$ ]]; then
        fail "Docker daemon returned an empty or malformed identity."
        return 1
    fi
    printf '%s\n' "$daemon_id"
}

inspect_image_identity() {
    local endpoint="$1"
    local target="$2"
    run_pinned_docker "$endpoint" image inspect "$target" --format '{{.Id}}{{"\n"}}{{range .RepoTags}}tag{{"\t"}}{{.}}{{"\n"}}{{end}}{{range .RepoDigests}}digest{{"\t"}}{{.}}{{"\n"}}{{end}}'
}

expected_tags_for_id() {
    local inventory="$1"
    local expected_id="$2"
    local repository=""
    local tag=""
    local image_id=""

    while IFS=$'\t' read -r repository tag image_id; do
        [ "$image_id" = "$expected_id" ] || continue
        [ "$repository" != "<none>" ] || continue
        [ "$tag" != "<none>" ] || continue
        printf '%s:%s\n' "$repository" "$tag"
    done <<<"$inventory" | LC_ALL=C sort -u
}

capture_validated_image_identity() {
    local endpoint="$1"
    local target="$2"
    local expected_id="$3"
    local expected_tags="$4"
    local identity=""
    identity="$(inspect_image_identity "$endpoint" "$target" 2>/dev/null)" || return 1

    local actual_id="${identity%%$'\n'*}"
    [ "$actual_id" = "$expected_id" ] && is_valid_image_id "$actual_id" || return 1

    local actual_tags=""
    local actual_digests=""
    local kind=""
    local image_ref=""
    local first_line=true
    while IFS=$'\t' read -r kind image_ref; do
        if [ "$first_line" = true ]; then
            first_line=false
            continue
        fi
        [ -n "$kind" ] || continue
        [ -n "$image_ref" ] || return 1
        case "$kind" in
            tag)
                is_allowed_image_ref "$image_ref" || return 1
                actual_tags="${actual_tags}${actual_tags:+$'\n'}${image_ref}"
                ;;
            digest)
                is_allowed_image_digest "$image_ref" || return 1
                actual_digests="${actual_digests}${actual_digests:+$'\n'}${image_ref}"
                ;;
            *) return 1 ;;
        esac
    done <<<"$identity"

    actual_tags="$(printf '%s\n' "$actual_tags" | sed '/^$/d' | LC_ALL=C sort -u)"
    actual_digests="$(printf '%s\n' "$actual_digests" | sed '/^$/d' | LC_ALL=C sort -u)"
    [ -n "$actual_tags" ] || return 1
    [ "$actual_tags" = "$expected_tags" ] || return 1

    printf 'image\t%s\n' "$actual_id"
    printf '%s\n' "$actual_tags" | sed 's/^/tag\t/'
    if [ -n "$actual_digests" ]; then
        printf '%s\n' "$actual_digests" | sed 's/^/digest\t/'
    fi
}

capture_candidate_identity_inventory() {
    local endpoint="$1"
    local candidate_ids="$2"
    local image_inventory="$3"
    local image_id=""

    while IFS= read -r image_id; do
        [ -n "$image_id" ] || continue
        local expected_tags=""
        expected_tags="$(expected_tags_for_id "$image_inventory" "$image_id")"
        [ -n "$expected_tags" ] || return 1
        capture_validated_image_identity "$endpoint" "$image_id" "$image_id" "$expected_tags" || return 1
    done <<<"$candidate_ids"
}

validate_candidate_ref_mappings() {
    local endpoint="$1"
    local candidate_mappings="$2"
    local image_inventory="$3"
    local image_ref=""
    local expected_id=""

    while IFS=$'\t' read -r image_ref expected_id; do
        [ -n "$image_ref" ] || continue
        local expected_tags=""
        expected_tags="$(expected_tags_for_id "$image_inventory" "$expected_id")"
        [ -n "$expected_tags" ] || return 1
        capture_validated_image_identity "$endpoint" "$image_ref" "$expected_id" "$expected_tags" >/dev/null || return 1
    done <<<"$candidate_mappings"
}

inspect_container_inventory() {
    local endpoint="$1"
    local container_ids="$2"
    local candidate_ids="$3"
    local container_id=""

    while IFS= read -r container_id; do
        [ -n "$container_id" ] || continue

        local image_id=""
        local compose_project=""
        local container_name=""
        image_id="$(run_pinned_docker "$endpoint" container inspect "$container_id" --format '{{.Image}}' 2>/dev/null)" || return 1
        compose_project="$(run_pinned_docker "$endpoint" container inspect "$container_id" --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null)" || return 1
        container_name="$(run_pinned_docker "$endpoint" container inspect "$container_id" --format '{{.Name}}' 2>/dev/null)" || return 1
        [ -n "$image_id" ] || return 1

        case "${container_name#/}" in
            portico-*|portico-open-webui|open-webui|open-webui-health-check|health-check|docker-socket-proxy|llm-gateway|mcpo|mcpo-*|chat-state-api|llm-debug-monitor|agent-vm|agent-vm-*)
                fail "an Portico container exists (${container_name:-$container_id})."
                return 1
                ;;
        esac
        case "$compose_project" in
            "$portico_COMPOSE_PROJECT"|"$portico_COMPOSE_PROJECT"-*)
                fail "an Portico container exists (${container_name:-$container_id})."
                return 1
                ;;
        esac

        if printf '%s\n' "$candidate_ids" | grep -Fqx -- "$image_id"; then
            fail "candidate image $image_id is referenced by container ${container_name:-$container_id}."
            return 1
        fi
    done <<<"$container_ids"
}

main() {
    if [ "${1:-}" != "$APPLY_FLAG" ] || [ "$#" -ne 1 ]; then
        fail "explicit $APPLY_FLAG flag is required."
        return 2
    fi

    local context_state=""
    context_state="$(read_local_docker_context_state)" || return 1
    local captured_endpoint="${context_state#*$'\t'}"
    [ "$captured_endpoint" != "$context_state" ] && [[ "$captured_endpoint" == unix://* ]] || {
        fail "Docker context did not yield a usable local endpoint."
        return 1
    }

    local daemon_id=""
    daemon_id="$(read_docker_daemon_id "$captured_endpoint")" || return 1

    local image_inventory=""
    image_inventory="$(run_pinned_docker "$captured_endpoint" image ls --all --no-trunc --format '{{.Repository}}\t{{.Tag}}\t{{.ID}}' | LC_ALL=C sort)" || {
        fail "Docker image inventory failed."
        return 1
    }

    local candidate_mappings=""
    candidate_mappings="$(collect_candidate_mappings "$image_inventory" | LC_ALL=C sort -u)" || {
        fail "Docker image inventory was incomplete."
        return 1
    }
    [ -n "$candidate_mappings" ] || {
        fail "no images from the fixed repair allowlist were found."
        return 1
    }

    local candidate_ids=""
    candidate_ids="$(printf '%s\n' "$candidate_mappings" | cut -f2 | LC_ALL=C sort -u)"
    [ -n "$candidate_ids" ] || {
        fail "candidate image identities were empty."
        return 1
    }

    validate_candidate_ref_mappings "$captured_endpoint" "$candidate_mappings" "$image_inventory" || {
        fail "candidate image references did not resolve to their inventoried immutable IDs."
        return 1
    }

    local candidate_identity_inventory=""
    candidate_identity_inventory="$(capture_candidate_identity_inventory "$captured_endpoint" "$candidate_ids" "$image_inventory")" || {
        fail "candidate RepoTags, RepoDigests, or immutable IDs were incomplete or outside the fixed allowlist."
        return 1
    }

    local container_ids=""
    container_ids="$(run_pinned_docker "$captured_endpoint" container ls -aq --no-trunc | LC_ALL=C sort)" || {
        fail "Docker container inventory failed."
        return 1
    }
    inspect_container_inventory "$captured_endpoint" "$container_ids" "$candidate_ids" || {
        fail "Docker container inventory could not prove the repair safe."
        return 1
    }

    # Re-read every safety boundary before mutation. The mutating command uses
    # only revalidated immutable IDs against the captured local endpoint,
    # disables parent pruning, and omits --force so raced-in references remain
    # Docker-enforced refusals.
    local confirmed_context_state=""
    confirmed_context_state="$(read_local_docker_context_state)" || return 1
    [ "$confirmed_context_state" = "$context_state" ] || {
        fail "Docker context changed during validation."
        return 1
    }

    local confirmed_daemon_id=""
    confirmed_daemon_id="$(read_docker_daemon_id "$captured_endpoint")" || return 1
    [ "$confirmed_daemon_id" = "$daemon_id" ] || {
        fail "Docker daemon identity changed during validation."
        return 1
    }

    local confirmed_container_ids=""
    confirmed_container_ids="$(run_pinned_docker "$captured_endpoint" container ls -aq --no-trunc | LC_ALL=C sort)" || {
        fail "Docker container inventory readback failed."
        return 1
    }
    [ "$confirmed_container_ids" = "$container_ids" ] || {
        fail "Docker container inventory changed during validation."
        return 1
    }
    inspect_container_inventory "$captured_endpoint" "$confirmed_container_ids" "$candidate_ids" || {
        fail "Docker container inventory readback could not prove the repair safe."
        return 1
    }

    local confirmed_image_inventory=""
    confirmed_image_inventory="$(run_pinned_docker "$captured_endpoint" image ls --all --no-trunc --format '{{.Repository}}\t{{.Tag}}\t{{.ID}}' | LC_ALL=C sort)" || {
        fail "Docker image inventory readback failed."
        return 1
    }
    [ "$confirmed_image_inventory" = "$image_inventory" ] || {
        fail "Docker image inventory changed during validation."
        return 1
    }

    local confirmed_candidate_mappings=""
    confirmed_candidate_mappings="$(collect_candidate_mappings "$confirmed_image_inventory" | LC_ALL=C sort -u)" || {
        fail "Docker image inventory readback was incomplete."
        return 1
    }
    [ "$confirmed_candidate_mappings" = "$candidate_mappings" ] || {
        fail "candidate image references changed during validation."
        return 1
    }
    validate_candidate_ref_mappings "$captured_endpoint" "$confirmed_candidate_mappings" "$confirmed_image_inventory" || {
        fail "candidate image references were retargeted during validation."
        return 1
    }

    local confirmed_identity_inventory=""
    confirmed_identity_inventory="$(capture_candidate_identity_inventory "$captured_endpoint" "$candidate_ids" "$confirmed_image_inventory")" || {
        fail "candidate image identity readback was incomplete or unsafe."
        return 1
    }
    [ "$confirmed_identity_inventory" = "$candidate_identity_inventory" ] || {
        fail "candidate RepoTags or RepoDigests changed during validation."
        return 1
    }

    [ "$(read_local_docker_context_state)" = "$context_state" ] || {
        fail "Docker context changed immediately before image removal."
        return 1
    }

    local final_container_ids=""
    final_container_ids="$(run_pinned_docker "$captured_endpoint" container ls -aq --no-trunc | LC_ALL=C sort)" || {
        fail "Docker container inventory failed immediately before image removal."
        return 1
    }
    [ "$final_container_ids" = "$container_ids" ] || {
        fail "Docker container inventory changed immediately before image removal."
        return 1
    }
    inspect_container_inventory "$captured_endpoint" "$final_container_ids" "$candidate_ids" || {
        fail "Docker container metadata changed immediately before image removal."
        return 1
    }

    local final_image_inventory=""
    final_image_inventory="$(run_pinned_docker "$captured_endpoint" image ls --all --no-trunc --format '{{.Repository}}\t{{.Tag}}\t{{.ID}}' | LC_ALL=C sort)" || {
        fail "Docker image inventory failed immediately before image removal."
        return 1
    }
    [ "$final_image_inventory" = "$confirmed_image_inventory" ] || {
        fail "Docker image inventory changed immediately before image removal."
        return 1
    }

    local final_candidate_mappings=""
    final_candidate_mappings="$(collect_candidate_mappings "$final_image_inventory" | LC_ALL=C sort -u)" || {
        fail "candidate image mappings were incomplete immediately before image removal."
        return 1
    }
    [ "$final_candidate_mappings" = "$confirmed_candidate_mappings" ] || {
        fail "candidate image mappings changed immediately before image removal."
        return 1
    }
    validate_candidate_ref_mappings "$captured_endpoint" "$final_candidate_mappings" "$final_image_inventory" || {
        fail "candidate image references were retargeted immediately before image removal."
        return 1
    }

    local final_candidate_ids=""
    final_candidate_ids="$(printf '%s\n' "$final_candidate_mappings" | cut -f2 | LC_ALL=C sort -u)"
    [ "$final_candidate_ids" = "$candidate_ids" ] || {
        fail "candidate immutable image IDs changed immediately before image removal."
        return 1
    }

    local final_identity_inventory=""
    final_identity_inventory="$(capture_candidate_identity_inventory "$captured_endpoint" "$final_candidate_ids" "$final_image_inventory")" || {
        fail "candidate image identities were incomplete immediately before image removal."
        return 1
    }
    [ "$final_identity_inventory" = "$confirmed_identity_inventory" ] || {
        fail "candidate RepoTags or RepoDigests changed immediately before image removal."
        return 1
    }

    local -a candidate_id_args=()
    local image_id=""
    while IFS= read -r image_id; do
        [ -n "$image_id" ] || continue
        candidate_id_args+=("$image_id")
    done <<<"$final_candidate_ids"
    [ "${#candidate_id_args[@]}" -gt 0 ] || {
        fail "candidate immutable image ID list was empty."
        return 1
    }

    log "removing ${#candidate_id_args[@]} allowed immutable image ID(s) without parent pruning"
    [ "$(read_docker_daemon_id "$captured_endpoint")" = "$daemon_id" ] || {
        fail "Docker daemon identity changed immediately before image removal."
        return 1
    }
    run_pinned_docker "$captured_endpoint" image rm --no-prune "${candidate_id_args[@]}" >/dev/null || {
        fail "Docker refused non-force removal of the revalidated immutable image IDs."
        return 1
    }

    local post_image_inventory=""
    post_image_inventory="$(run_pinned_docker "$captured_endpoint" image ls --all --no-trunc --format '{{.Repository}}\t{{.Tag}}\t{{.ID}}' | LC_ALL=C sort)" || {
        fail "Docker image removal readback failed."
        return 1
    }
    local expected_post_image_inventory=""
    expected_post_image_inventory="$(collect_inventory_without_candidate_ids "$image_inventory" "$candidate_ids" | LC_ALL=C sort)" || {
        fail "expected Docker image readback could not be constructed."
        return 1
    }
    [ "$post_image_inventory" = "$expected_post_image_inventory" ] || {
        fail "Docker image inventory changed outside the exact candidate removals."
        return 1
    }

    local post_container_ids=""
    post_container_ids="$(run_pinned_docker "$captured_endpoint" container ls -aq --no-trunc | LC_ALL=C sort)" || {
        fail "Docker container inventory readback failed after removal."
        return 1
    }
    [ "$post_container_ids" = "$container_ids" ] || {
        fail "Docker container inventory changed during image removal."
        return 1
    }
    [ "$(read_local_docker_context_state)" = "$context_state" ] || {
        fail "Docker context changed during image removal."
        return 1
    }
    [ "$(read_docker_daemon_id "$captured_endpoint")" = "$daemon_id" ] || {
        fail "Docker daemon identity changed during image removal."
        return 1
    }

    log "completed image-only refresh for ${#candidate_id_args[@]} immutable allowed image ID(s); images will be repulled by the owning operation."
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    main "$@"
fi
