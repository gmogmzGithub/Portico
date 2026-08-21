# Reliability-First Docker Delivery + Slim OWUI Runtime

## Summary

- `src/scripts/prereq-docker-setup.sh` only ensures OrbStack/Docker readiness today; it does not pull images.
- `src/scripts/prereq-download.sh` only resolves and downloads the Cloudsmith source zip today; it has no retry, timeout, or resume logic, so it becomes relevant to Docker delivery only if we later download image bundles through Cloudsmith.
- The OWUI size problem is mostly upstream base image bloat, not our patch layer. In this workspace:
  - `ghcr.io/open-webui/open-webui:v0.6.43` is about `3.89GB`
  - `harbor.example.invalid/portico/open-webui-patched:latest` is about `4.08GB`
  - the upstream base contains `torch`, `torchvision`, `torchaudio`, `transformers`, `sentence_transformers`, `onnxruntime`, and `chromadb`
- Recommended sequence:
  1. Stop indefinite Harbor hangs with bounded, sequential pulls across install/update/guided setup
  2. Slim the OWUI image by replacing the upstream runtime base
  3. Add Cloudsmith image bundles only if phase 1 still shows field failures

## Key Changes

- Replace `docker-compose pull` in `install_v2.sh` with explicit per-image pulls in a fixed order, including `agent-vm` in the same acquisition pipeline.
- Add one reusable shell-side image acquisition helper for `docker pull` with:
  - streamed output
  - inactivity timeout
  - total timeout
  - bounded retries with backoff
  - explicit error classification
- Reuse that helper in `electron-app/src/scripts/build-with-docker.sh` for the `electron-builder` image pull.
- Reduce Electron-side Harbor pull concurrency to `1` in prerequisites/update preparation and align it to the same retry/timeout policy instead of its current parallel pull behavior.
- Keep `src/scripts/prereq-docker-setup.sh` focused on Docker readiness in phase 1; only add a disk-space preflight warning there if available space is below the estimated image footprint.
- Keep `src/scripts/prereq-download.sh` responsible for the source zip in phase 1, but harden its Cloudsmith calls with retries and timeouts now so it is safe to extend later.
- Replace `Dockerfile.open-webui-patched`'s final stage base image. Instead of inheriting `ghcr.io/open-webui/open-webui`, build a repo-owned runtime from a slim Python base and upstream source.
- Start that OWUI runtime from upstream `backend/requirements-min.txt`, then add back only packages required for current product behavior.
- Preserve current product-visible behavior:
  - patched chat UI/backend
  - current file handling flows
  - external-provider embeddings/audio flows that the health check configures
- Remove local-only ML/runtime dependencies unless a verified current path needs them:
  - `torch`, `torchvision`, `torchaudio`
  - `sentence-transformers`, `transformers`
  - `onnxruntime`, `faster-whisper`
  - unused OCR/vector DB dependencies
- If startup code still imports those packages eagerly, patch OWUI startup/config to lazy-load or gate those paths behind env flags rather than reinstalling the full stack.
- Phase 2 fallback only if phase 1 still fails in the field:
  - publish one combined per-architecture Cloudsmith bundle, not one tarball per image
  - bundle name pattern: `docker-bundle-<build>-<arch>.tar.gz`
  - install/update/guided setup use `docker load` when the bundle exists, else fall back to bounded Harbor pulls

## Test Plan

- Clean-install test with slow/interrupted Harbor connectivity: install must either recover by retrying or fail within a bounded time.
- Verify the same bounded acquisition behavior in:
  - shell install
  - guided prerequisites
  - update preparation
  - Electron builder setup
- Measure before/after per-image duration, retries, timeout reasons, and overall install completion rate.
- Build and boot the slim OWUI image; verify chat startup, model sync, patched backend routes, file flows, and health-check-driven embedding configuration still work.
- Validate disk-space handling before large pull/load operations on macOS/OrbStack.
- If phase 2 is enabled, validate Cloudsmith bundle resume, checksum verification, architecture selection, and `docker load`.

## Assumptions and Defaults

- Success for this work is "no indefinite client-side hangs and materially smaller OWUI image," not immediate literal Harbor removal everywhere.
- `src/scripts/prereq-docker-setup.sh` should not become another image-pull implementation.
- `src/scripts/prereq-download.sh` should only take on Docker bundle download logic if phase 2 is activated.
- OWUI slimming should keep current product behavior; feature removal needs a separate explicit decision.

## References

- [`docker image save`](https://docs.docker.com/reference/cli/docker/image/save/)
- [`docker image load`](https://docs.docker.com/reference/cli/docker/image/load/)
- [Open WebUI v0.6.43 Dockerfile](https://raw.githubusercontent.com/open-webui/open-webui/v0.6.43/Dockerfile)
- [Open WebUI v0.6.43 requirements-min.txt](https://raw.githubusercontent.com/open-webui/open-webui/v0.6.43/backend/requirements-min.txt)
