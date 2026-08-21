#!/usr/bin/env bash

# PORTICO-371: the managed-node preparer image (resolve_mcp_orc_docker_preparer_image)
# must use the tag the runtime images were pushed under — dockerImageTag
# (mr-<iid>-<sha>) for MR/broker builds — not the build number. Beta builds tag
# == build number, so they are unchanged; older builds without the field fall
# back to the build number; dev builds use the local image.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

fail() { echo "FAIL: $1" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# shellcheck source=/dev/null
source "$PROJECT_ROOT/src/scripts/mcp-orc-backend.sh"
# shellcheck source=/dev/null
source "$PROJECT_ROOT/src/scripts/mcp-orc-cli.sh"

write_build_info() {
  mkdir -p "$TMP/electron-app"
  printf '%s\n' "$1" > "$TMP/electron-app/build-info.json"
}

# MR/broker build: dockerImageTag differs from buildNumber -> use the mr tag.
write_build_info '{"buildNumber":"07292026-46bac6de","dockerImageTag":"mr-247-46bac6deabcdef"}'
got="$(resolve_mcp_orc_docker_preparer_image "$TMP")"
[ "$got" = "harbor.example.invalid/portico/mcp-orc-rust:mr-247-46bac6deabcdef" ] \
  || fail "mr build: expected mr-tagged preparer image, got '$got'"

# Beta build: dockerImageTag == buildNumber -> unchanged behavior.
write_build_info '{"buildNumber":"07292026-abc","dockerImageTag":"07292026-abc"}'
got="$(resolve_mcp_orc_docker_preparer_image "$TMP")"
[ "$got" = "harbor.example.invalid/portico/mcp-orc-rust:07292026-abc" ] \
  || fail "beta build: expected build-number-tagged image, got '$got'"

# Older build without dockerImageTag: fall back to the build number.
write_build_info '{"buildNumber":"07292026-xyz"}'
got="$(resolve_mcp_orc_docker_preparer_image "$TMP")"
[ "$got" = "harbor.example.invalid/portico/mcp-orc-rust:07292026-xyz" ] \
  || fail "older build: expected build-number fallback, got '$got'"

# dev-build: no published Harbor image -> local image.
write_build_info '{"buildNumber":"dev-build"}'
got="$(resolve_mcp_orc_docker_preparer_image "$TMP")"
[ "$got" = "portico-mcp-orc-rust:latest" ] \
  || fail "dev-build: expected local image, got '$got'"

echo "PASS: mcp-orc preparer image uses the pushed image tag (PORTICO-371)"
