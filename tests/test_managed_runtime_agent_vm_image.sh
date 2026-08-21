#!/usr/bin/env bash

# Regression tests for PORTICO-231 update-path provisioning of the Agent VM image.
#
# The Agent VM image is on-demand and never a docker-compose service, so it is
# absent from docker-compose.harbor.yml. The managed-runtime update self-heal
# must still provision it. These tests lock:
#   - managed_runtime_agent_vm_image_ref derives the build-tagged agent-vm ref.
#   - the required-image list (used for the update pull) includes agent-vm...
#   - ...while the compose-validation list stays free of agent-vm.
#   - the missing-image pull actually fetches a missing agent-vm image.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INTEGRITY="$PROJECT_ROOT/src/scripts/managed-runtime-integrity.sh"

fail() { echo "FAIL: $1" >&2; exit 1; }

# shellcheck source=/dev/null
source "$INTEGRITY" || fail "could not source managed-runtime-integrity.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Write a docker-compose.harbor.yml with compose services (never agent-vm).
# When $2 is non-empty, include the build-tag header the resolver keys on.
make_harbor_project() {
  local root="$1" tag="$2"
  mkdir -p "$root"
  {
    if [ -n "$tag" ]; then
      echo "# Image tag: $tag (from build-info.json)"
    fi
    echo "services:"
    echo "  mcpo:"
    echo "    image: harbor.example.invalid/portico/mcpo-control-plane-rust:${tag:-latest}"
    echo "  open-webui:"
    echo "    image: harbor.example.invalid/portico/open-webui-patched:${tag:-latest}"
  } >"$root/docker-compose.harbor.yml"
}

TAG="07262026-fbd7411e"
AGENT_REF="harbor.example.invalid/portico/agent-vm:$TAG"

# --- release build: agent-vm is provisioned via the required list ------------
R1="$TMP/release"
make_harbor_project "$R1" "$TAG"

[ "$(managed_runtime_agent_vm_image_ref "$R1")" = "$AGENT_REF" ] \
  || fail "agent_vm_image_ref did not derive the build-tagged agent-vm ref"

required="$(managed_runtime_list_required_image_refs "$R1")"
grep -qx "$AGENT_REF" <<<"$required" \
  || fail "required-image list is missing the agent-vm image (the PORTICO-231 gap)"
grep -q "mcpo-control-plane-rust:$TAG" <<<"$required" \
  || fail "required-image list dropped the compose service images"

# Container stays lazy: agent-vm is pulled proactively (above) but is NOT a
# docker-compose service, so `docker compose up` never starts an agent-vm
# container — the VM is created on demand by the agent-vm server only when the
# user needs it. The compose image list (what compose actually starts) must
# therefore never contain agent-vm.
if managed_runtime_list_harbor_image_refs "$R1" | grep -q "agent-vm"; then
  fail "agent-vm must not be a compose service (the VM container must stay lazy)"
fi

# --- dev/local build (no header tag): no agent-vm ref -------------------------
R2="$TMP/dev"
make_harbor_project "$R2" ""
[ -z "$(managed_runtime_agent_vm_image_ref "$R2")" ] \
  || fail "dev build (no build tag) must not emit an agent-vm Harbor ref"

# --- the missing-image pull actually fetches a missing agent-vm --------------
PULLS="$TMP/pulls"
: >"$PULLS"
docker() {
  if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
    case "$3" in
      *"/agent-vm:"*) return 1 ;;  # agent-vm missing locally
      *) return 0 ;;                # compose images present
    esac
  fi
  if [ "$1" = "pull" ]; then
    echo "$2" >>"$PULLS"
    return 0
  fi
  return 0
}
managed_runtime_pull_missing_harbor_images "$R1" >/dev/null 2>&1 || true
grep -qx "$AGENT_REF" "$PULLS" \
  || fail "managed-runtime update did not pull the missing agent-vm image"
unset -f docker

echo "PASS: managed-runtime agent-vm image provisioning (PORTICO-231)"
