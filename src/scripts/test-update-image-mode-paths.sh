#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

grep -q 'PRESERVE_RUNTIME_ENV="\.env\.runtime"' "$PROJECT_ROOT/bootstrap.sh"
grep -q 'MANAGED_RUNTIME_DEFAULT_PRESERVE_PATHS' "$PROJECT_ROOT/src/scripts/prereq-download.sh"
grep -q '".env.runtime"' "$PROJECT_ROOT/src/scripts/managed-runtime-reconcile.sh"
! grep -q '"guided-setup"' "$PROJECT_ROOT/src/scripts/managed-runtime-reconcile.sh"
grep -q 'BIFROST_BRIDGE_IMAGE' "$PROJECT_ROOT/install_v2.sh"
grep -q 'log_effective_compose_images' "$PROJECT_ROOT/install_v2.sh"
grep -q 'Local images actually referenced by the active compose stack' "$PROJECT_ROOT/install_v2.sh"
grep -q 'loadReleaseManifest(' "$PROJECT_ROOT/electron-app/src/services/update-preparation.js"
grep -q 'runDockerPreparation(job, prepared.dockerImages)' "$PROJECT_ROOT/electron-app/src/services/update-preparation.js"
! grep -q 'getDockerImagesToPull(' "$PROJECT_ROOT/electron-app/src/services/update-preparation.js"

echo "update/install paths preserve runtime mode and use staged release manifests for bifrost/rust image planning"
