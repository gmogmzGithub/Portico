#!/bin/bash

# Agent VM runtime image resolution.
#
# Sourced by docker-compose.sh (and by tests, which stub the dependencies).
# Requires from the caller: a get_image_tag() function and a docker CLI on
# PATH. Color variables (GREEN/YELLOW/RED/NC) are optional.
#
# Contract:
#   - stdout carries EXACTLY one line: the image ref to use.
#   - All diagnostics go to stderr.
#   - Always returns 0 (the call site is an `export VAR="$(...)"`).
#
# This resolver is a pure local-state decision — it must NEVER pull or touch
# the network. It runs at the top level of every docker-compose.sh invocation
# (start/stop/status/logs, including the Electron status poll), where a
# stalled network call would wedge the app. Network recovery (Harbor pull)
# lives in the agent-vm server at Agent VM creation time; see
# validate_agent_vm_image() in
# src/core-mcp-rust/crates/agent-vm-server/src/native/agent_vm_core.rs.

AGENT_VM_LEGACY_IMAGE="agent-vm:latest"

resolve_agent_vm_runtime_image() {
    local image_tag
    image_tag="$(get_image_tag)"

    # Dev builds have no published Harbor image; keep the historical local ref.
    if [ -z "$image_tag" ] || [ "$image_tag" = "dev-build" ]; then
        echo "$AGENT_VM_LEGACY_IMAGE"
        return 0
    fi

    local harbor_ref="harbor.example.invalid/portico/agent-vm:$image_tag"

    # Healthy fast path (identical to the historical behavior): the published
    # build image is present locally.
    if docker image inspect "$harbor_ref" >/dev/null 2>&1; then
        echo "$harbor_ref"
        return 0
    fi

    # Inspect failure can mean "engine not ready" just as well as "image
    # missing". If the engine is unreachable, keep the pullable Harbor ref —
    # the agent-vm server re-verifies (and can pull) at Agent VM creation.
    if ! docker info >/dev/null 2>&1; then
        echo -e "${YELLOW:-}⚠ Docker engine not ready while resolving Agent VM image; using $harbor_ref (verified again at Agent VM creation)${NC:-}" >&2
        echo "$harbor_ref"
        return 0
    fi

    # Engine is up, so the Harbor image is genuinely absent. Fall back to the
    # legacy local image ONLY if it verifiably exists.
    if docker image inspect "$AGENT_VM_LEGACY_IMAGE" >/dev/null 2>&1; then
        echo -e "${YELLOW:-}⚠ Agent VM image $harbor_ref not found locally; falling back to legacy local $AGENT_VM_LEGACY_IMAGE${NC:-}" >&2
        echo "$AGENT_VM_LEGACY_IMAGE"
        return 0
    fi

    # Nothing usable exists locally. Never emit a known-nonexistent
    # agent-vm:latest for release builds: keep the Harbor ref so the agent-vm
    # server can pull it at Agent VM creation and so every downstream error
    # names the correct, recoverable image.
    echo -e "${RED:-}✗ Agent VM image $harbor_ref not found locally and no legacy $AGENT_VM_LEGACY_IMAGE fallback exists. The agent-vm server will attempt to pull it when an Agent VM is created; manual recovery: docker pull $harbor_ref${NC:-}" >&2
    echo "$harbor_ref"
    return 0
}
