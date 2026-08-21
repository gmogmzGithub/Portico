#!/usr/bin/env bash

set -euo pipefail
umask 077

REGISTRY="${portico_RUNTIME_IMAGE_REGISTRY:-harbor.example.invalid/portico}"
SOURCE_REVISION=""
TAG=""
OUTPUT=""
IMAGE_NAMES=(agent-vm bifrost-bridge chat-state-api health-check mcp-orc-rust mcpo-control-plane-rust open-webui-patched)

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --source-revision) SOURCE_REVISION="${2:-}"; shift 2 ;;
    --tag) TAG="${2:-}"; shift 2 ;;
    --output) OUTPUT="${2:-}"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ "$SOURCE_REVISION" =~ ^[a-f0-9]{40}$ ]] || die "source revision is invalid"
[[ "$TAG" =~ ^mr-[1-9][0-9]*-${SOURCE_REVISION}$ ]] || die "MR runtime tag is invalid"
[ -n "$OUTPUT" ] || die "output is required"
for command in jq krane; do command -v "$command" >/dev/null 2>&1 || die "missing $command"; done

mkdir -p "$(dirname "$OUTPUT")"
temporary="$(mktemp "$(dirname "$OUTPUT")/.$(basename "$OUTPUT").XXXXXX")"
trap 'rm -f "$temporary"' EXIT HUP INT TERM
images='[]'
for name in "${IMAGE_NAMES[@]}"; do
  repository="${REGISTRY}/${name}"
  reference="${repository}:${TAG}"
  index_digest="$(krane digest "$reference")" || die "unable to resolve $reference"
  [[ "$index_digest" =~ ^sha256:[a-f0-9]{64}$ ]] || die "invalid index digest for $reference"
  manifest="$(krane manifest "$reference")" || die "unable to inspect $reference"
  platforms='{}'
  for architecture in amd64 arm64; do
    platform="linux/${architecture}"
    digest="$(jq -er --arg arch "$architecture" \
      '[.manifests[] | select(.platform.os == "linux" and .platform.architecture == $arch) | .digest]
       | if length == 1 then .[0] else error("expected one platform") end' <<<"$manifest")" \
      || die "missing platform $platform for $reference"
    config="$(krane config "${repository}@${digest}")" || die "unable to inspect $platform config"
    revision="$(jq -er '.config.Labels["org.opencontainers.image.revision"] // empty' <<<"$config")"
    version="$(jq -er '.config.Labels["org.opencontainers.image.version"] // empty' <<<"$config")"
    [ "$revision" = "$SOURCE_REVISION" ] || die "revision label mismatch for $reference $platform"
    [ "$version" = "$TAG" ] || die "version label mismatch for $reference $platform"
    # PORTICO-205: shipped runtime images must carry the PORTICO ownership labels.
    artifact="$(jq -er '.config.Labels["com.portico.ai-chat.artifact"] // empty' <<<"$config")" \
      || die "missing com.portico.ai-chat.artifact label for $reference $platform"
    [ "$artifact" = "true" ] || die "com.portico.ai-chat.artifact label mismatch for $reference $platform"
    role="$(jq -er '.config.Labels["com.portico.ai-chat.image-role"] // empty' <<<"$config")" \
      || die "missing com.portico.ai-chat.image-role label for $reference $platform"
    [ "$role" = "$name" ] || die "com.portico.ai-chat.image-role label mismatch for $reference $platform (expected ${name}, got ${role})"
    platforms="$(jq -cn --argjson current "$platforms" --arg platform "$platform" \
      --arg digest "$digest" --arg revision "$revision" --arg version "$version" \
      '$current + {($platform): {digest: $digest, revision: $revision, version: $version}}')"
  done
  images="$(jq -cn --argjson current "$images" --arg name "$name" \
    --arg reference "$reference" --arg indexDigest "$index_digest" --argjson platforms "$platforms" \
    '$current + [{name: $name, reference: $reference, indexDigest: $indexDigest, platforms: $platforms}]')"
done
jq -n --arg sourceRevision "$SOURCE_REVISION" --arg tag "$TAG" --argjson images "$images" \
  '{schemaVersion: 1, sourceRevision: $sourceRevision, tag: $tag, images: $images}' >"$temporary"
[ "$(wc -c <"$temporary" | tr -d ' ')" -le 65536 ] || die "attestation exceeds size limit"
mv -f "$temporary" "$OUTPUT"
printf 'Wrote runtime image attestation: %s\n' "$OUTPUT"

