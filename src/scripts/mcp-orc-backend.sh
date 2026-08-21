#!/bin/bash

# Rust/Bifrost is the only supported runtime. These helpers remain as a small
# compatibility surface for existing setup and packaging scripts, but they no
# longer inspect runtime mode env files or branch to deleted Python stacks.

resolve_mcp_orc_runtime_file() {
    local project_root="${PROJECT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
    if [ -f "$project_root/.env.runtime" ]; then
        echo "$project_root/.env.runtime"
        return 0
    fi
    if [ -f "$project_root/.env" ]; then
        echo "$project_root/.env"
        return 0
    fi
    return 1
}

resolve_llm_gateway_mode() {
    echo "bifrost"
}

llm_gateway_dockerfile() {
    echo "Dockerfile.bifrost-bridge"
}

llm_gateway_local_image_name() {
    echo "portico-bifrost-bridge:latest"
}

llm_gateway_harbor_image_name() {
    local tag="${1:-latest}"
    echo "harbor.example.invalid/portico/bifrost-bridge:$tag"
}

resolve_mcp_orc_mode() {
    echo "rust-full"
}

resolve_mcp_orc_backend() {
    resolve_mcp_orc_mode
}

normalize_mcp_orc_backend() {
    echo "rust"
}

mcp_orc_backend_for_scope() {
    local scope="${1:-regular}"
    case "$scope" in
        control-plane|core|regular|host)
            echo "rust"
            ;;
        *)
            echo "Unknown MCP orchestrator scope: $scope" >&2
            return 1
            ;;
    esac
}

mcp_orc_runtime_dockerfile() {
    echo "Dockerfile.mcp-orc-rust"
}

mcp_orc_local_image_name() {
    echo "portico-mcp-orc-rust:latest"
}

mcp_orc_harbor_image_name() {
    local _variant="${1:-full}"
    local tag="${2:-latest}"
    echo "harbor.example.invalid/portico/mcp-orc-rust:$tag"
}

openapi_aggregator_dockerfile() {
    echo "Dockerfile.openapi-aggregator-rust"
}

openapi_aggregator_local_image_name() {
    echo "portico-openapi-aggregator-rust:latest"
}

openapi_aggregator_harbor_image_name() {
    local tag="${1:-latest}"
    echo "harbor.example.invalid/portico/openapi-aggregator-rust:$tag"
}

mcpo_control_plane_dockerfile() {
    echo "Dockerfile.mcpo-control-plane-rust"
}

mcpo_control_plane_local_image_name() {
    echo "portico-mcpo-control-plane-rust:latest"
}

mcpo_control_plane_harbor_image_name() {
    local tag="${1:-latest}"
    echo "harbor.example.invalid/portico/mcpo-control-plane-rust:$tag"
}

export_mcp_orc_compose_env() {
    export MCP_ORC_MODE_RESOLVED="rust-full"
    export MCP_ORC_BACKEND_RESOLVED="rust-full"
    export MCP_ORC_CONTROL_PLANE_BACKEND_RESOLVED="rust"
    export MCP_ORC_CORE_BACKEND_RESOLVED="rust"
    export MCP_ORC_REGULAR_BACKEND_RESOLVED="rust"
    export MCP_ORC_HOST_BACKEND_RESOLVED="rust"
    export LLM_GATEWAY_MODE_RESOLVED="bifrost"

    export LLM_GATEWAY_DOCKERFILE="Dockerfile.bifrost-bridge"
    export LLM_GATEWAY_IMAGE="portico-bifrost-bridge:latest"
    export BIFROST_BRIDGE_IMAGE="$LLM_GATEWAY_IMAGE"

    export MCPO_DOCKERFILE="Dockerfile.mcp-orc-rust"
    export MCPO_IMAGE="portico-mcp-orc-rust:latest"
    export MCPO_CORE_DOCKERFILE="Dockerfile.mcp-orc-rust"
    export MCPO_CORE_IMAGE="portico-mcp-orc-rust:latest"
    export MCPO_CONTROL_PLANE_DOCKERFILE="Dockerfile.mcpo-control-plane-rust"
    export MCPO_CONTROL_PLANE_IMAGE="portico-mcpo-control-plane-rust:latest"
    export OPENAPI_AGGREGATOR_DOCKERFILE="Dockerfile.openapi-aggregator-rust"
    export OPENAPI_AGGREGATOR_IMAGE="portico-openapi-aggregator-rust:latest"
}

export_mcp_orc_harbor_env() {
    local tag="${1:-latest}"
    export LLM_GATEWAY_HARBOR_IMAGE="harbor.example.invalid/portico/bifrost-bridge:$tag"
    export BIFROST_BRIDGE_IMAGE="$LLM_GATEWAY_HARBOR_IMAGE"
    export MCPO_HARBOR_IMAGE="harbor.example.invalid/portico/mcp-orc-rust:$tag"
    export MCPO_CORE_HARBOR_IMAGE="harbor.example.invalid/portico/mcp-orc-rust:$tag"
    export MCPO_CONTROL_PLANE_HARBOR_IMAGE="harbor.example.invalid/portico/mcpo-control-plane-rust:$tag"
    export OPENAPI_AGGREGATOR_HARBOR_IMAGE="harbor.example.invalid/portico/openapi-aggregator-rust:$tag"
}

# Docker Compose can be exposed either as a Docker CLI plugin (`docker compose`)
# or as a standalone v2-compatible executable (`docker-compose`). Resolve the
# working frontend once per process without modifying the user's Docker config.
DOCKER_COMPOSE_FRONTEND_RESOLVED="${DOCKER_COMPOSE_FRONTEND_RESOLVED:-}"
DOCKER_COMPOSE_PLUGIN_PROBE_OUTPUT="${DOCKER_COMPOSE_PLUGIN_PROBE_OUTPUT:-}"
DOCKER_COMPOSE_STANDALONE_PROBE_OUTPUT="${DOCKER_COMPOSE_STANDALONE_PROBE_OUTPUT:-}"

docker_compose_version_major() {
    local version_output="${1:-}"

    printf '%s\n' "$version_output" | awk '
        {
            line = tolower($0)
            version_pos = index(line, "version")
            if (version_pos == 0) {
                next
            }

            remainder = substr($0, version_pos + 7)
            sub(/^[^0-9]*/, "", remainder)
            if (match(remainder, /^[0-9]+/)) {
                print substr(remainder, RSTART, RLENGTH)
                exit
            }
        }
    '
}

docker_compose_version_is_v2_or_newer() {
    local version_output="${1:-}"
    local major_version

    major_version="$(docker_compose_version_major "$version_output")"
    [ -n "$major_version" ] && [ "$major_version" -ge 2 ] 2>/dev/null
}

sanitize_docker_compose_probe_output() {
    local sanitized
    sanitized="$(
        printf '%s' "${1:-}" \
            | tr '\r\n\t' '   ' \
            | sed 's/[[:space:]][[:space:]]*/ /g; s/^ //; s/ $//' \
            | cut -c 1-500
    )"
    if [ -n "${HOME:-}" ]; then
        sanitized="${sanitized//$HOME/\~}"
    fi
    printf '%s\n' "$sanitized"
}

reset_docker_compose_frontend_cache() {
    DOCKER_COMPOSE_FRONTEND_RESOLVED=""
    DOCKER_COMPOSE_PLUGIN_PROBE_OUTPUT=""
    DOCKER_COMPOSE_STANDALONE_PROBE_OUTPUT=""
}

resolve_docker_compose_frontend() {
    local probe_output
    local probe_status

    if [ -n "${DOCKER_COMPOSE_FRONTEND_RESOLVED:-}" ]; then
        [ "$DOCKER_COMPOSE_FRONTEND_RESOLVED" != "unavailable" ]
        return
    fi

    if probe_output="$(docker compose version 2>&1)"; then
        probe_status=0
    else
        probe_status=$?
    fi
    DOCKER_COMPOSE_PLUGIN_PROBE_OUTPUT="$probe_output"
    if [ "$probe_status" -eq 0 ] && docker_compose_version_is_v2_or_newer "$probe_output"; then
        DOCKER_COMPOSE_FRONTEND_RESOLVED="docker-plugin"
        return 0
    fi

    if command -v docker-compose >/dev/null 2>&1; then
        if probe_output="$(docker-compose version 2>&1)"; then
            probe_status=0
        else
            probe_status=$?
        fi
    else
        probe_output="docker-compose: command not found"
        probe_status=127
    fi
    DOCKER_COMPOSE_STANDALONE_PROBE_OUTPUT="$probe_output"
    if [ "$probe_status" -eq 0 ] && docker_compose_version_is_v2_or_newer "$probe_output"; then
        DOCKER_COMPOSE_FRONTEND_RESOLVED="standalone-v2"
        return 0
    fi

    DOCKER_COMPOSE_FRONTEND_RESOLVED="unavailable"
    return 1
}

emit_docker_compose_unavailable() {
    resolve_docker_compose_frontend >/dev/null 2>&1 || true

    echo "DOCKER_COMPOSE_UNAVAILABLE: No usable Docker Compose v2 frontend was found." >&2
    echo "DOCKER_COMPOSE_FRONTEND=unavailable" >&2
    echo "DOCKER_COMPOSE_PLUGIN_PROBE=$(sanitize_docker_compose_probe_output "$DOCKER_COMPOSE_PLUGIN_PROBE_OUTPUT")" >&2
    echo "DOCKER_COMPOSE_STANDALONE_PROBE=$(sanitize_docker_compose_probe_output "$DOCKER_COMPOSE_STANDALONE_PROBE_OUTPUT")" >&2
}

docker_compose_output_indicates_unavailable() {
    local output="${1:-}"

    printf '%s\n' "$output" | grep -Eqi \
        'DOCKER_COMPOSE_UNAVAILABLE|unknown shorthand flag: .[fp]. in -[fp]|docker: unknown command: docker compose|docker: .compose. is not a docker command|Usage:[[:space:]]+docker \[OPTIONS\] COMMAND'
}

run_docker_compose() {
    if ! resolve_docker_compose_frontend; then
        emit_docker_compose_unavailable
        return 125
    fi

    case "$DOCKER_COMPOSE_FRONTEND_RESOLVED" in
        docker-plugin)
            docker compose "$@"
            ;;
        standalone-v2)
            docker-compose "$@"
            ;;
        *)
            emit_docker_compose_unavailable
            return 125
            ;;
    esac
}

require_docker_compose_frontend() {
    if resolve_docker_compose_frontend; then
        return 0
    fi

    emit_docker_compose_unavailable
    return 125
}

docker_compose_frontend_name() {
    if resolve_docker_compose_frontend; then
        printf '%s\n' "$DOCKER_COMPOSE_FRONTEND_RESOLVED"
        return 0
    fi

    printf '%s\n' "unavailable"
    return 1
}
