#!/usr/bin/env bash
# One-shot workaround for the python-not-found readiness failure on the
# installed Portico app build.
#
# Background: the installed app's check-containers-ready.sh references the
# bare image name `portico-health-check` (resolves to :latest), but a
# local `docker build` from a post-Python-retirement source tree overwrote
# that tag with a Python-free image. This script re-points :latest at the
# build-pinned Harbor image (which still has Python).
#
# Safe to run multiple times.

set -euo pipefail

INSTALLED_BUILD_INFO="/Applications/Portico.app/Contents/Resources/build-info.json"
HARBOR_REPO="harbor.example.invalid/portico/health-check"
LOCAL_TAG="portico-health-check:latest"

if [ ! -f "$INSTALLED_BUILD_INFO" ]; then
  echo "ERROR: $INSTALLED_BUILD_INFO not found. Is Portico installed?" >&2
  exit 1
fi

BUILD_NUMBER=$(/usr/bin/python3 -c '
import json, sys
with open(sys.argv[1]) as f:
    print(json.load(f)["buildNumber"])
' "$INSTALLED_BUILD_INFO")

if [ -z "$BUILD_NUMBER" ]; then
  echo "ERROR: could not read buildNumber from $INSTALLED_BUILD_INFO" >&2
  exit 1
fi

HARBOR_IMAGE="${HARBOR_REPO}:${BUILD_NUMBER}"
echo "Installed build: $BUILD_NUMBER"
echo "Target Harbor image: $HARBOR_IMAGE"

if ! docker image inspect "$HARBOR_IMAGE" >/dev/null 2>&1; then
  echo "Harbor image not present locally. Pulling..."
  docker pull "$HARBOR_IMAGE"
fi

# Verify the Harbor image actually has python (sanity check; this is the whole
# point of using the Harbor build instead of the local rebuild).
if ! docker run --rm --entrypoint sh "$HARBOR_IMAGE" -c 'command -v python >/dev/null'; then
  echo "ERROR: Harbor image $HARBOR_IMAGE does not contain python." >&2
  echo "The installed app's readiness script needs python; this workaround can't help." >&2
  exit 1
fi

# Show what :latest currently points at (for the user's awareness).
CURRENT_LATEST_ID=$(docker image inspect --format '{{.Id}}' "$LOCAL_TAG" 2>/dev/null || echo "<none>")
HARBOR_ID=$(docker image inspect --format '{{.Id}}' "$HARBOR_IMAGE")
echo "Current $LOCAL_TAG id: $CURRENT_LATEST_ID"
echo "Harbor image id:        $HARBOR_ID"

if [ "$CURRENT_LATEST_ID" = "$HARBOR_ID" ]; then
  echo "Already pointing at the correct image. Nothing to do."
  exit 0
fi

docker tag "$HARBOR_IMAGE" "$LOCAL_TAG"
echo "Retagged: $HARBOR_IMAGE -> $LOCAL_TAG"
echo "Done. Click 'Retry Initialization' in the app."
echo
echo "NOTE: a future 'docker compose build' from this source tree will overwrite"
echo "      $LOCAL_TAG again. Re-run this script if that happens."
