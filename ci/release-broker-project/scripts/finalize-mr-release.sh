#!/usr/bin/env bash

set -euo pipefail
umask 077

INPUT=""
ATTESTATION=""
TRUSTED_TOOLING=""
OUTPUT=""
IDENTITY="${APPLE_CODESIGN_IDENTITY:-Developer ID Application: Portico, Inc. (AJDA86F3YP)}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENTITLEMENTS="$SCRIPT_DIR/../assets/entitlements.mac.plist"
# PORTICO-399: DMG window decoration. Release DMGs are produced by electron-builder,
# which bakes its `build.dmg` settings (660x400 window, 128px icons, positioned
# app + Applications link, picture background) into the volume's .DS_Store. The
# broker builds its own DMG around the SIGNED app, so without these it inherits
# Finder's default geometry and MR previews open as an oversized, mostly-empty
# window. Both files must stay in step with electron-app `build.dmg` config:
# DS_Store encodes the icon coordinates AND the background reference by name.
DMG_DS_STORE="$SCRIPT_DIR/../assets/dmg/DS_Store"
DMG_BACKGROUND="$SCRIPT_DIR/../assets/dmg/background.tiff"

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --input) INPUT="${2:-}"; shift 2 ;;
    --attestation) ATTESTATION="${2:-}"; shift 2 ;;
    --trusted-tooling) TRUSTED_TOOLING="${2:-}"; shift 2 ;;
    --output) OUTPUT="${2:-}"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

for command in codesign ditto file hdiutil node python3 spctl xcrun; do
  command -v "$command" >/dev/null 2>&1 || die "missing required command: $command"
done
[ "$(uname -s)" = Darwin ] || die "signed MR finalization requires macOS"
[ -d "$INPUT" ] || die "MR release input directory is missing"
[ -f "$ATTESTATION" ] && [ ! -L "$ATTESTATION" ] || die "runtime attestation is missing"
[ -d "$TRUSTED_TOOLING" ] || die "trusted tooling checkout is missing"
[ -f "$ENTITLEMENTS" ] || die "broker-owned entitlements are missing"
# Fail loudly rather than silently shipping an unstyled DMG: a missing asset here
# is invisible in the build log but obvious to whoever opens the DMG.
[ -f "$DMG_DS_STORE" ] || die "broker-owned DMG .DS_Store is missing"
[ -f "$DMG_BACKGROUND" ] || die "broker-owned DMG background is missing"
for name in APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID CLOUDSMITH_API_KEY CLOUDSMITH_ENTITLEMENT_TOKEN; do
  [ -n "${!name:-}" ] || die "missing required environment variable: $name"
done
[[ "${portico_SOURCE_PROJECT_ID:-}" =~ ^[1-9][0-9]*$ ]] || die "invalid source project id"
[[ "${portico_MR_IID:-}" =~ ^[1-9][0-9]*$ ]] || die "invalid MR iid"
[[ "${portico_SOURCE_SHA:-}" =~ ^[a-f0-9]{40}$ ]] || die "invalid source SHA"
[[ "${portico_BUILD_NUMBER:-}" =~ ^[0-9]{8}-[a-f0-9]{8}$ ]] || die "invalid build number"
[ "${portico_CHANNEL:-}" = "mr-${portico_MR_IID}" ] || die "invalid MR channel"
[ "${portico_CHANNEL_PACKAGE:-}" = "portico_${portico_CHANNEL}" ] || die "invalid MR package"
[ "${portico_RUNTIME_IMAGE_TAG:-}" = "${portico_CHANNEL}-${portico_SOURCE_SHA}" ] \
  || die "invalid MR runtime image tag"
[ "$(basename "$OUTPUT")" = "${portico_CHANNEL_PACKAGE}-${portico_BUILD_NUMBER}.zip" ] \
  || die "output filename does not match MR release identity"

contract_helper="$TRUSTED_TOOLING/src/scripts/ci/mr-release-input.py"
attestation_validator="$TRUSTED_TOOLING/src/scripts/validate-runtime-image-attestation.js"
payload_validator="$TRUSTED_TOOLING/src/scripts/validate-release-payload.py"
[ -f "$contract_helper" ] || die "trusted MR contract helper is missing"
[ -f "$attestation_validator" ] || die "trusted attestation validator is missing"
[ -f "$payload_validator" ] || die "trusted payload validator is missing"

python3 "$contract_helper" --validate \
  --root "$INPUT" \
  --output "$INPUT/mr-release-input.json" \
  --project-id "$portico_SOURCE_PROJECT_ID" \
  --project-path "$portico_SOURCE_PROJECT_PATH" \
  --mr-iid "$portico_MR_IID" \
  --target-branch "$portico_TARGET_BRANCH" \
  --source-revision "$portico_SOURCE_SHA" \
  --build-number "$portico_BUILD_NUMBER" \
  --release-timestamp "$portico_RELEASE_TIMESTAMP"
node "$attestation_validator" \
  --attestation "$ATTESTATION" \
  --expected-source-revision "$portico_SOURCE_SHA" \
  --expected-tag "$portico_RUNTIME_IMAGE_TAG" \
  --quiet

temporary="$(mktemp -d "${TMPDIR:-/tmp}/portico-mr-finalize.XXXXXX")"
cleanup() { rm -rf "$temporary"; }
trap cleanup EXIT HUP INT TERM
working="$temporary/input"
payload="$temporary/payload"
mkdir -p "$working" "$payload"
ditto "$INPUT" "$working"
python3 "$SCRIPT_DIR/validate-app-archive.py" --tree "$working"

write_cloudsmith_resource() {
  local path="$1"
  [ -f "$path" ] && [ ! -L "$path" ] || die "Cloudsmith placeholder is missing: $path"
  grep -Fq 'mr-preview-disabled' "$path" \
    || die "Cloudsmith resource does not contain the deterministic MR placeholder: $path"
  CLOUDSMITH_RESOURCE_PATH="$path" python3 - <<'PY'
import json
import os
from pathlib import Path

path = Path(os.environ["CLOUDSMITH_RESOURCE_PATH"])
values = {
    "CLOUDSMITH_OWNER": os.environ.get("CLOUDSMITH_OWNER", "portico"),
    "CLOUDSMITH_REPO": os.environ.get("CLOUDSMITH_REPO", "portico"),
    "CLOUDSMITH_API_BASE": os.environ.get("CLOUDSMITH_API_BASE", "https://api.cloudsmith.io/v1"),
    "CLOUDSMITH_DL_BASE": os.environ.get("CLOUDSMITH_DL_BASE", "https://dl.artifacts.example.invalid"),
    "CLOUDSMITH_ENTITLEMENT_TOKEN": os.environ["CLOUDSMITH_ENTITLEMENT_TOKEN"],
    "CLOUDSMITH_API_KEY": os.environ["CLOUDSMITH_API_KEY"],
}
temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
temporary.write_text(
    "# Generated by the protected MR release broker.\n" +
    "# API key is used for package discovery; entitlement token is used for downloads.\n" +
    "".join(f"{key}={json.dumps(value)}\n" for key, value in values.items()),
    encoding="utf-8",
)
os.chmod(temporary, 0o600)
temporary.replace(path)
PY
}

sign_path() {
  local path="$1"
  codesign --force --timestamp --options runtime \
    --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$path" >/dev/null
}

deepest_first() {
  python3 -c 'import sys
paths = [path for path in sys.stdin.buffer.read().split(b"\0") if path]
paths.sort(key=lambda path: path.count(b"/"), reverse=True)
sys.stdout.buffer.write(b"\0".join(paths) + (b"\0" if paths else b""))'
}

sign_app() {
  local app="$1"
  local item=""
  local description=""

  # An unsigned outer executable cannot be signed before its nested code. Each
  # Contents/MacOS executable is signed with its enclosing bundle below.
  while IFS= read -r -d '' item; do
    [ -L "$item" ] && continue
    case "$item" in
      */Contents/MacOS/*) continue ;;
    esac
    description="$(file -b "$item" 2>/dev/null || true)"
    case "$description" in
      *Mach-O*) sign_path "$item" ;;
    esac
  done < <(find "$app/Contents" -type f -print0 | deepest_first)

  while IFS= read -r -d '' item; do
    [ "$item" = "$app" ] && continue
    sign_path "$item"
  done < <(find "$app/Contents" -type d \
    \( -name '*.framework' -o -name '*.xpc' -o -name '*.app' \) -print0 | deepest_first)

  sign_path "$app"
  codesign --verify --deep --strict --verbose=2 "$app" >/dev/null
}

notarize_and_staple_app() {
  local app="$1"
  local archive=""
  archive="$temporary/notary-$(basename "$app" .app).zip"
  ditto -c -k --sequesterRsrc --keepParent "$app" "$archive"
  xcrun notarytool submit "$archive" --wait \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_APP_SPECIFIC_PASSWORD" \
    --team-id "$APPLE_TEAM_ID"
  xcrun stapler staple "$app"
  xcrun stapler validate "$app"
  spctl --assess --type execute --verbose=2 "$app"
  rm -f "$archive"
}

create_dmg() {
  local app="$1"
  local output="$2"
  local root=""
  root="$temporary/dmg-root-$(basename "$output" .dmg)"
  rm -rf "$root"
  mkdir -p "$root"
  ditto "$app" "$root/Portico.app"
  ln -s /Applications "$root/Applications"
  # Names and volname below are load-bearing: .DS_Store keys icon positions and
  # the background reference to "Portico.app", "Applications",
  # ".background.tiff" and volume "Portico". Renaming any of them
  # silently drops the layout back to Finder's default.
  cp "$DMG_BACKGROUND" "$root/.background.tiff"
  cp "$DMG_DS_STORE" "$root/.DS_Store"
  hdiutil create -volname "Portico" -srcfolder "$root" -ov -format UDZO "$output" >/dev/null
  codesign --force --timestamp --sign "$IDENTITY" "$output" >/dev/null
  codesign --verify --strict --verbose=2 "$output" >/dev/null
  xcrun notarytool submit "$output" --wait \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_APP_SPECIFIC_PASSWORD" \
    --team-id "$APPLE_TEAM_ID"
  xcrun stapler staple "$output"
  xcrun stapler validate "$output"
}

mkdir -p "$payload/artifacts/apps/darwin-arm64" "$payload/artifacts/apps/darwin-x64" \
  "$payload/artifacts/dmg/darwin-arm64" "$payload/artifacts/dmg/darwin-x64"

for arch in arm64 x64; do
  archive="$working/apps/darwin-${arch}/Portico.app.zip"
  extract_root="$temporary/app-${arch}"
  python3 "$SCRIPT_DIR/validate-app-archive.py" --archive "$archive"
  mkdir -p "$extract_root"
  ditto -x -k "$archive" "$extract_root"
  python3 "$SCRIPT_DIR/validate-app-archive.py" --tree "$extract_root"
  app_count="$(find "$extract_root" -type d -name 'Portico.app' | wc -l | tr -d ' ')"
  [ "$app_count" = 1 ] || die "expected exactly one ${arch} app bundle"
  app="$(find "$extract_root" -type d -name 'Portico.app' -print -quit)"
  write_cloudsmith_resource "$app/Contents/Resources/cloudsmith.env"
  sign_app "$app"
  notarize_and_staple_app "$app"
  destination="$payload/artifacts/apps/darwin-${arch}/Portico.app"
  ditto "$app" "$destination"
  dmg="$payload/artifacts/dmg/darwin-${arch}/Portico-${portico_BUILD_NUMBER}-${arch}.dmg"
  create_dmg "$app" "$dmg"
done

ditto "$working/managed-root" "$payload/managed-root"
ditto "$working/host-mcp-binaries" "$payload/host-mcp-binaries"
for resource in \
  "$payload/managed-root/cloudsmith.env" \
  "$payload/managed-root/electron-app/build-resources/cloudsmith.env"
do
  write_cloudsmith_resource "$resource"
done
cp -p "$ATTESTATION" "$payload/runtime-image-attestation.json"

PAYLOAD_DIR="$payload" ATTESTATION_PATH="$ATTESTATION" python3 - <<'PY'
import json
import os
from pathlib import Path

payload = Path(os.environ["PAYLOAD_DIR"])
attestation = json.loads(Path(os.environ["ATTESTATION_PATH"]).read_text(encoding="utf-8"))
tag = os.environ["portico_RUNTIME_IMAGE_TAG"]
harbor_labels = {
    "mcpo-control-plane-rust": "MCP Control Plane",
    "mcp-orc-rust": "MCP Runtime",
    "open-webui-patched": "Open WebUI",
    "health-check": "Health Check",
    "bifrost-bridge": "LLM Gateway",
    "chat-state-api": "Chat State API",
    "agent-vm": "Agent VM",
}
docker_images = [
    {"name": "redis", "tag": "7-alpine", "label": "Redis Cache"},
    {"name": "mongo", "tag": "7", "label": "MongoDB"},
    {"name": "nginx", "tag": "alpine", "label": "Nginx"},
]
for image in attestation["images"]:
    docker_images.append({
        "name": f"harbor.example.invalid/portico/{image['name']}",
        "tag": tag,
        "label": harbor_labels[image["name"]],
    })
manifest = {
    "schemaVersion": 2,
    "buildNumber": os.environ["portico_BUILD_NUMBER"],
    "fullSha": os.environ["portico_SOURCE_SHA"],
    "channelPackageName": os.environ["portico_CHANNEL_PACKAGE"],
    "managedRootDir": "managed-root",
    "dockerImageTag": tag,
    "dockerImages": docker_images,
    "appBundles": {
        "darwin-arm64": "artifacts/apps/darwin-arm64/Portico.app",
        "darwin-x64": "artifacts/apps/darwin-x64/Portico.app",
    },
    "dmgs": {
        "darwin-arm64": f"artifacts/dmg/darwin-arm64/Portico-{os.environ['portico_BUILD_NUMBER']}-arm64.dmg",
        "darwin-x64": f"artifacts/dmg/darwin-x64/Portico-{os.environ['portico_BUILD_NUMBER']}-x64.dmg",
    },
    "hostMcpTargets": [
        "aarch64-apple-darwin", "aarch64-unknown-linux-gnu",
        "x86_64-apple-darwin", "x86_64-unknown-linux-gnu",
    ],
    "runtimeImageAttestation": "runtime-image-attestation.json",
}
(payload / "release-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
PY

mkdir -p "$(dirname "$OUTPUT")"
partial="${OUTPUT}.partial.$$"
rm -f "$partial"
ditto -c -k --sequesterRsrc "$payload" "$partial"
python3 "$payload_validator" \
  --payload "$partial" \
  --expected-build-id "$portico_BUILD_NUMBER" \
  --expected-channel-package "$portico_CHANNEL_PACKAGE" \
  --expected-filename "$(basename "$OUTPUT")" \
  --verify-macos
mv -f "$partial" "$OUTPUT"
printf 'Created signed MR release payload: %s\n' "$OUTPUT"
