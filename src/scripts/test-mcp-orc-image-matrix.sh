#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$PROJECT_ROOT/src/scripts/mcp-orc-backend.sh"

assert_eq() {
  local actual="$1"
  local expected="$2"
  local message="$3"

  if [ "$actual" != "$expected" ]; then
    echo "Assertion failed: $message" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    exit 1
  fi
}

for variant in full python node docker group group-core group-python group-node group-docker; do
  assert_eq \
    "$(mcp_orc_local_image_name "$variant" python)" \
    "portico-mcp-orc-rust:latest" \
    "variant '$variant' should use the canonical Rust runtime image"
  assert_eq \
    "$(mcp_orc_local_image_name "$variant" rust)" \
    "portico-mcp-orc-rust:latest" \
    "rust backend variant '$variant' should use the canonical runtime image"
done

assert_eq \
  "$(mcp_orc_harbor_image_name group-core latest python)" \
  "harbor.example.invalid/portico/mcp-orc-rust:latest" \
  "grouped/core Harbor images should collapse onto the canonical Rust runtime image"
assert_eq \
  "$(mcp_orc_harbor_image_name group-core latest rust)" \
  "harbor.example.invalid/portico/mcp-orc-rust:latest" \
  "rust grouped/core Harbor images should collapse onto the canonical runtime image"

assert_eq \
  "$(llm_gateway_local_image_name bifrost)" \
  "portico-bifrost-bridge:latest" \
  "bifrost mode should use the canonical local Rust bridge image"
assert_eq \
  "$(llm_gateway_harbor_image_name latest bifrost)" \
  "harbor.example.invalid/portico/bifrost-bridge:latest" \
  "bifrost mode should use the canonical Harbor Rust bridge image"

grep -q '^ARG ENABLE_SUPERVISOR=1$' "$PROJECT_ROOT/Dockerfile.mcp-orc-rust"
grep -q '^COPY docker/mcpo-core-rust-group-entrypoint.sh ./mcpo-core-rust-group-entrypoint.sh$' "$PROJECT_ROOT/Dockerfile.mcp-orc-rust"

for dockerfile in \
  Dockerfile.bifrost-bridge \
  Dockerfile.health-check \
  Dockerfile.mcp-orc-rust \
  Dockerfile.mcp-orc-rust-core-group \
  Dockerfile.mcpo-control-plane-rust \
  Dockerfile.openapi-aggregator-rust; do
  grep -q '^# syntax=docker/dockerfile:1.7$' "$PROJECT_ROOT/$dockerfile"
  grep -q '^ARG RUST_VERSION=' "$PROJECT_ROOT/$dockerfile"
  grep -q '^FROM rust:${RUST_VERSION}-' "$PROJECT_ROOT/$dockerfile"
  grep -q '^ARG TARGETARCH$' "$PROJECT_ROOT/$dockerfile"
  grep -q 'CARGO_NET_RETRY=5' "$PROJECT_ROOT/$dockerfile"
  grep -q 'CARGO_HTTP_MULTIPLEXING=false' "$PROJECT_ROOT/$dockerfile"
  grep -q 'CARGO_HTTP_TIMEOUT=120' "$PROJECT_ROOT/$dockerfile"
  grep -q 'CARGO_HTTP_LOW_SPEED_LIMIT=1' "$PROJECT_ROOT/$dockerfile"
  grep -q 'id=portico-cargo-registry-rust-${RUST_VERSION}-.*-${TARGETARCH},target=/usr/local/cargo/registry,sharing=locked' "$PROJECT_ROOT/$dockerfile"
  grep -q 'id=portico-cargo-git-rust-${RUST_VERSION}-.*-${TARGETARCH},target=/usr/local/cargo/git,sharing=locked' "$PROJECT_ROOT/$dockerfile"
  grep -q 'target-rust-${RUST_VERSION}-.*-${TARGETARCH}.*sharing=locked' "$PROJECT_ROOT/$dockerfile"
  grep -q 'COPY --from=.* /out/' "$PROJECT_ROOT/$dockerfile"

  cargo_build_count="$(grep -c 'cargo build ' "$PROJECT_ROOT/$dockerfile")"
  locked_build_count="$(grep -c 'cargo build .*--locked' "$PROJECT_ROOT/$dockerfile")"
  offline_build_count="$(grep -c 'cargo build .*--locked.*--offline' "$PROJECT_ROOT/$dockerfile")"
  locked_fetch_count="$(grep -c 'cargo fetch --locked --target' "$PROJECT_ROOT/$dockerfile")"
  assert_eq \
    "$locked_build_count" \
    "$cargo_build_count" \
    "$dockerfile should use the committed lockfile for every Cargo build"
  assert_eq \
    "$offline_build_count" \
    "$cargo_build_count" \
    "$dockerfile should compile offline after fetching dependencies"
  assert_eq \
    "$locked_fetch_count" \
    "$cargo_build_count" \
    "$dockerfile should perform one locked host-target fetch in every Cargo build step"
done

for dockerfile in \
  Dockerfile.health-check \
  Dockerfile.mcp-orc-rust \
  Dockerfile.mcp-orc-rust-core-group \
  Dockerfile.mcpo-control-plane-rust \
  Dockerfile.openapi-aggregator-rust; do
  grep -q '^ARG RUST_VERSION=1.96.0$' "$PROJECT_ROOT/$dockerfile"
  grep -q '^FROM rust:${RUST_VERSION}-slim-trixie AS mcp-workspace-builder$' "$PROJECT_ROOT/$dockerfile"
  grep -q 'id=portico-rust-target-rust-${RUST_VERSION}-glibc-${TARGETARCH},target=/build/src/mcp-orc-rust/target,sharing=locked' "$PROJECT_ROOT/$dockerfile"
  grep -q 'cargo fetch --locked --target "$(rustc -vV' "$PROJECT_ROOT/$dockerfile"
  grep -q 'cargo build --release --locked --offline --workspace' "$PROJECT_ROOT/$dockerfile"
  grep -q 'for binary in mcp-orc openapi-aggregator health-check; do' "$PROJECT_ROOT/$dockerfile"
done

grep -q '^FROM debian:trixie-slim$' "$PROJECT_ROOT/Dockerfile.health-check"
grep -q '^FROM python:3.11-slim-trixie$' "$PROJECT_ROOT/Dockerfile.mcp-orc-rust"

for dockerfile in Dockerfile.mcp-orc-rust Dockerfile.mcp-orc-rust-core-group; do
  grep -q 'id=portico-rust-target-rust-${RUST_VERSION}-glibc-${TARGETARCH},target=/build/src/core-mcp-rust/target,sharing=locked' "$PROJECT_ROOT/$dockerfile"
done

# Keep the complete MCP workspace compiler stage byte-identical so BuildKit can
# reuse it across the control-plane, runtime, health-check, and legacy images.
reference_mcp_builder_stage="$(
  awk 'BEGIN { count = 0 } /^FROM / { count++; if (count == 2) exit } { print }' \
    "$PROJECT_ROOT/Dockerfile.mcpo-control-plane-rust"
)"
for dockerfile in \
  Dockerfile.health-check \
  Dockerfile.mcp-orc-rust \
  Dockerfile.mcp-orc-rust-core-group \
  Dockerfile.openapi-aggregator-rust; do
  candidate_mcp_builder_stage="$(
    awk 'BEGIN { count = 0 } /^FROM / { count++; if (count == 2) exit } { print }' \
      "$PROJECT_ROOT/$dockerfile"
  )"
  assert_eq \
    "$candidate_mcp_builder_stage" \
    "$reference_mcp_builder_stage" \
    "$dockerfile should share the canonical MCP Rust compiler stage"
done

grep -q '^ARG RUST_VERSION=1.86.0$' "$PROJECT_ROOT/Dockerfile.bifrost-bridge"
grep -q 'id=portico-bifrost-target-rust-${RUST_VERSION}-musl-${TARGETARCH},target=/build/target,sharing=locked' "$PROJECT_ROOT/Dockerfile.bifrost-bridge"

grep -q 'https://codeload.github.com/maximhq/bifrost/tar.gz/${BIFROST_SOURCE_REF}' "$PROJECT_ROOT/Dockerfile.bifrost-bridge"
grep -q 'curl --fail --location --retry 5 --retry-all-errors --connect-timeout 20 --max-time 300' "$PROJECT_ROOT/Dockerfile.bifrost-bridge"
grep -q 'for attempt in 1 2 3 4 5; do' "$PROJECT_ROOT/Dockerfile.bifrost-bridge"
! grep -q 'openapi-aggregator:' "$PROJECT_ROOT/build_docker_images.sh"
! grep -q 'mcpo-control-plane:' "$PROJECT_ROOT/build_docker_images.sh"
grep -q 'bifrost-bridge:Dockerfile.bifrost-bridge' "$PROJECT_ROOT/build_docker_images.sh"

assert_eq \
  "$(resolve_mcp_orc_mode)" \
  "rust-full" \
  "default MCP mode should be rust-full"
assert_eq \
  "$(resolve_llm_gateway_mode)" \
  "bifrost" \
  "default LLM gateway mode should be bifrost"

echo "mcp-orc helper defaults to Rust/Bifrost only"
