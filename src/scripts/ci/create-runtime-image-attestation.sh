#!/usr/bin/env bash

set -euo pipefail
umask 077

REGISTRY="harbor.example.invalid/portico"
SOURCE_REVISION=""
TAG=""
OUTPUT=""
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
Usage: create-runtime-image-attestation.sh --source-revision <sha> --tag <tag> --output <path> [--registry <path>]

Inspect the seven immutable runtime image indexes and emit a bounded provenance
attestation. The command requires authenticated `krane` and `jq` clients.
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
    --output)
      [ "$#" -ge 2 ] || die "--output requires a value"
      OUTPUT="$2"
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

[[ "$SOURCE_REVISION" =~ ^[a-f0-9]{40}$ ]] \
  || die "--source-revision must be a full lowercase git SHA"
[[ "$TAG" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] \
  || die "--tag is invalid"
[ -n "$OUTPUT" ] || die "--output is required"
[ -n "$REGISTRY" ] || die "--registry must not be empty"

require_command jq
require_command krane

output_dir="$(dirname "$OUTPUT")"
mkdir -p "$output_dir"
temp_output="$(mktemp "${output_dir}/.$(basename "$OUTPUT").XXXXXX")"
cleanup() {
  rm -f "$temp_output"
}
trap cleanup EXIT

images_json='[]'
for image_name in "${IMAGE_NAMES[@]}"; do
  image_repository="${REGISTRY}/${image_name}"
  image_reference="${image_repository}:${TAG}"
  printf 'Inspecting %s\n' "$image_reference" >&2

  index_digest="$(krane digest "$image_reference")" \
    || die "unable to resolve index digest for $image_reference"
  [[ "$index_digest" =~ ^sha256:[a-f0-9]{64}$ ]] \
    || die "invalid index digest for $image_reference: ${index_digest:-empty}"

  manifest_json="$(krane manifest "$image_reference")" \
    || die "unable to inspect image index for $image_reference"

  platform_json='{}'
  for architecture in amd64 arm64; do
    platform_name="linux/${architecture}"
    platform_digest="$(
      jq -er \
        --arg os linux \
        --arg arch "$architecture" \
        '[.manifests[] | select(.platform.os == $os and .platform.architecture == $arch) | .digest]
         | if length == 1 then .[0] else error("expected exactly one platform manifest") end' \
        <<<"$manifest_json"
    )" || die "missing or duplicate ${platform_name} manifest for $image_reference"
    [[ "$platform_digest" =~ ^sha256:[a-f0-9]{64}$ ]] \
      || die "invalid ${platform_name} digest for $image_reference"

    config_json="$(krane config "${image_repository}@${platform_digest}")" \
      || die "unable to inspect ${platform_name} config for $image_reference"
    revision_label="$(jq -er '.config.Labels["org.opencontainers.image.revision"] // empty' <<<"$config_json")" \
      || die "missing revision label for $image_reference ${platform_name}"
    version_label="$(jq -er '.config.Labels["org.opencontainers.image.version"] // empty' <<<"$config_json")" \
      || die "missing version label for $image_reference ${platform_name}"
    [ "$revision_label" = "$SOURCE_REVISION" ] \
      || die "revision label mismatch for $image_reference ${platform_name}"
    [ "$version_label" = "$TAG" ] \
      || die "version label mismatch for $image_reference ${platform_name}"

    # PORTICO-205: shipped runtime images must carry the PORTICO ownership labels so
    # cleanup tooling can select PORTICO-built artifacts by label.
    artifact_label="$(jq -er '.config.Labels["com.portico.ai-chat.artifact"] // empty' <<<"$config_json")" \
      || die "missing com.portico.ai-chat.artifact label for $image_reference ${platform_name}"
    [ "$artifact_label" = "true" ] \
      || die "com.portico.ai-chat.artifact label mismatch for $image_reference ${platform_name}"
    role_label="$(jq -er '.config.Labels["com.portico.ai-chat.image-role"] // empty' <<<"$config_json")" \
      || die "missing com.portico.ai-chat.image-role label for $image_reference ${platform_name}"
    [ "$role_label" = "$image_name" ] \
      || die "com.portico.ai-chat.image-role label mismatch for $image_reference ${platform_name} (expected ${image_name}, got ${role_label})"

    platform_entry="$(
      jq -cn \
        --arg digest "$platform_digest" \
        --arg revision "$revision_label" \
        --arg version "$version_label" \
        '{digest: $digest, revision: $revision, version: $version}'
    )"
    platform_json="$(
      jq -cn \
        --argjson existing "$platform_json" \
        --arg platform "$platform_name" \
        --argjson entry "$platform_entry" \
        '$existing + {($platform): $entry}'
    )"
  done

  image_json="$(
    jq -cn \
      --arg name "$image_name" \
      --arg reference "$image_reference" \
      --arg indexDigest "$index_digest" \
      --argjson platforms "$platform_json" \
      '{name: $name, reference: $reference, indexDigest: $indexDigest, platforms: $platforms}'
  )"
  images_json="$(
    jq -cn \
      --argjson existing "$images_json" \
      --argjson image "$image_json" \
      '$existing + [$image]'
  )"
done

jq -n \
  --arg sourceRevision "$SOURCE_REVISION" \
  --arg tag "$TAG" \
  --argjson images "$images_json" \
  '{schemaVersion: 1, sourceRevision: $sourceRevision, tag: $tag, images: $images}' \
  >"$temp_output"

attestation_size="$(wc -c <"$temp_output" | tr -d ' ')"
[ "$attestation_size" -le 65536 ] \
  || die "generated runtime image attestation exceeds 65536 bytes"
mv -f "$temp_output" "$OUTPUT"
printf 'Wrote runtime image attestation: %s\n' "$OUTPUT"
