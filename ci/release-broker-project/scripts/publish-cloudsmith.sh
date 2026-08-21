#!/usr/bin/env bash

set -euo pipefail

PAYLOAD=""
CHANNEL=""
BUILD_NUMBER=""
RELEASE_SCRIPT=""

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --payload) PAYLOAD="${2:-}"; shift 2 ;;
    --channel) CHANNEL="${2:-}"; shift 2 ;;
    --build-number) BUILD_NUMBER="${2:-}"; shift 2 ;;
    --release-script) RELEASE_SCRIPT="${2:-}"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ "$CHANNEL" =~ ^mr-[1-9][0-9]*$ ]] || die "channel must be mr-<iid>"
[[ "$BUILD_NUMBER" =~ ^[0-9]{8}-[a-f0-9]{8}$ ]] || die "build number is invalid"
package_name="portico_${CHANNEL}"
[ -f "$PAYLOAD" ] && [ ! -L "$PAYLOAD" ] || die "payload is not a regular file"
[ "$(basename "$PAYLOAD")" = "${package_name}-${BUILD_NUMBER}.zip" ] \
  || die "payload filename does not match MR channel identity"
[ -n "${CLOUDSMITH_API_KEY:-}" ] || die "CLOUDSMITH_API_KEY is required"
[ -n "${CLOUDSMITH_ENTITLEMENT_TOKEN:-}" ] || die "CLOUDSMITH_ENTITLEMENT_TOKEN is required"
[ -f "$RELEASE_SCRIPT" ] && [ ! -L "$RELEASE_SCRIPT" ] \
  || die "trusted release script is required"

bash "$RELEASE_SCRIPT" "$PAYLOAD" \
  --channel "$CHANNEL" \
  --yes \
  --republish \
  --wait-for-sync \
  --mark-update-ready
