#!/usr/bin/env bash

set -euo pipefail

ATTESTATION=""
SOURCE_REVISION=""
TAG=""
REGISTRY="harbor.example.invalid/portico"
IMAGE_NAMES=(
  agent-vm
  bifrost-bridge
  chat-state-api
  health-check
  mcp-orc-rust
  mcpo-control-plane-rust
  open-webui-patched
)

usage() {
  cat <<'EOF'
Usage: promote-runtime-images.sh --attestation <path> --source-revision <sha> --tag <tag> [--registry <path>]

Promote the exact attested runtime image indexes to `latest`. No tag is moved
until all seven immutable source indexes have passed digest validation.
EOF
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --attestation)
      [ "$#" -ge 2 ] || die "--attestation requires a value"
      ATTESTATION="$2"
      shift 2
      ;;
    --source-revision)
      [ "$#" -ge 2 ] || die "--source-revision requires a value"
      SOURCE_REVISION="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"
      shift 2
      ;;
    --tag)
      [ "$#" -ge 2 ] || die "--tag requires a value"
      TAG="$2"
      shift 2
      ;;
    --registry)
      [ "$#" -ge 2 ] || die "--registry requires a value"
      REGISTRY="${2%/}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[ -f "$ATTESTATION" ] || die "runtime image attestation does not exist: ${ATTESTATION:-empty}"
[[ "$SOURCE_REVISION" =~ ^[a-f0-9]{40}$ ]] \
  || die "--source-revision must be a full lowercase git SHA"
[[ "$TAG" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] \
  || die "--tag is invalid"
require_command jq
require_command krane

[ "$(jq -r '.schemaVersion' "$ATTESTATION")" = "1" ] \
  || die "runtime image attestation schemaVersion must be 1"
[ "$(jq -r '.sourceRevision' "$ATTESTATION")" = "$SOURCE_REVISION" ] \
  || die "runtime image attestation source revision does not match"
[ "$(jq -r '.tag' "$ATTESTATION")" = "$TAG" ] \
  || die "runtime image attestation tag does not match"
[ "$(jq '.images | length' "$ATTESTATION")" -eq 7 ] \
  || die "runtime image attestation must contain exactly seven images"

declare -a source_references=()
declare -a source_digests=()
for image_name in "${IMAGE_NAMES[@]}"; do
  expected_reference="${REGISTRY}/${image_name}:${TAG}"
  match_count="$(jq --arg name "$image_name" '[.images[] | select(.name == $name)] | length' "$ATTESTATION")"
  [ "$match_count" -eq 1 ] || die "runtime image attestation must contain exactly one ${image_name} entry"
  reference="$(jq -r --arg name "$image_name" '.images[] | select(.name == $name) | .reference' "$ATTESTATION")"
  digest="$(jq -r --arg name "$image_name" '.images[] | select(.name == $name) | .indexDigest' "$ATTESTATION")"
  [ "$reference" = "$expected_reference" ] \
    || die "runtime image reference mismatch for ${image_name}"
  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] \
    || die "runtime image digest is invalid for ${image_name}"

  current_digest="$(krane digest "$reference")" \
    || die "unable to resolve immutable runtime image: $reference"
  [ "$current_digest" = "$digest" ] \
    || die "immutable runtime image digest changed for ${image_name}"
  source_references+=("$reference")
  source_digests+=("$digest")
done

for index in "${!IMAGE_NAMES[@]}"; do
  image_name="${IMAGE_NAMES[$index]}"
  source_reference="${source_references[$index]}"
  source_digest="${source_digests[$index]}"
  latest_reference="${REGISTRY}/${image_name}:latest"
  printf 'Promoting %s@%s to %s\n' "$source_reference" "$source_digest" "$latest_reference"
  krane copy "${source_reference}@${source_digest}" "$latest_reference" >/dev/null
  promoted_digest="$(krane digest "$latest_reference")"
  [ "$promoted_digest" = "$source_digest" ] \
    || die "latest digest verification failed for ${image_name}"
done

printf 'Promoted all seven attested runtime images to latest.\n'
