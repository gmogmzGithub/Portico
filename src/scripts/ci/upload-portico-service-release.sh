#!/usr/bin/env bash

set -euo pipefail

PAYLOAD_ZIP=""
BASE_URL="${portico_SERVICE_BASE_URL:-}"
ADMIN_TOKEN="${portico_SERVICE_ADMIN_TOKEN:-}"
ALLOWED_BASE_URLS="${portico_SERVICE_ALLOWED_BASE_URLS:-https://portico-service.sandbox.example.invalid}"
AUDIENCE="internal"
CHANNEL=""
RELEASE_NAME=""
RELEASE_BUILD_NUMBER=""
SOURCE_BRANCH=""
REPLACE="false"
EXPECTED_BUILD_ID="${RELEASE_BUILD_ID:-}"
CURL_CONNECT_TIMEOUT_SECONDS="15"
CURL_UPLOAD_MAX_TIME_SECONDS="1800"
CURL_UPLOAD_RETRY_MAX_TIME_SECONDS="3600"
CURL_VERIFY_MAX_TIME_SECONDS="60"
CURL_VERIFY_RETRY_MAX_TIME_SECONDS="180"
CURL_RETRY_COUNT="2"
CURL_RETRY_DELAY_SECONDS="5"

usage() {
  cat <<'EOF'
Usage: portico_SERVICE_ADMIN_TOKEN=<token> upload-portico-service-release.sh --payload-zip <zip> --base-url <url> [options]

Options:
  --audience <internal|general_availability>
  --channel <development|beta|production>
  --release-name <name>
  --release-build-number <number>
  --source-branch <branch>       Sent only for Internal releases.
  --replace                      Upload with replace=true for idempotent CI retries.
  --expected-build-id <id>       Fail if release-manifest.json buildNumber differs.
EOF
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  local command_name="$1"
  command -v "$command_name" >/dev/null 2>&1 || die "missing required command: $command_name"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --payload-zip)
      [ "$#" -ge 2 ] || die "--payload-zip requires a value"
      PAYLOAD_ZIP="$2"
      shift 2
      ;;
    --base-url)
      [ "$#" -ge 2 ] || die "--base-url requires a value"
      BASE_URL="$2"
      shift 2
      ;;
    --audience)
      [ "$#" -ge 2 ] || die "--audience requires a value"
      AUDIENCE="$2"
      shift 2
      ;;
    --channel)
      [ "$#" -ge 2 ] || die "--channel requires a value"
      CHANNEL="$2"
      shift 2
      ;;
    --release-name)
      [ "$#" -ge 2 ] || die "--release-name requires a value"
      RELEASE_NAME="$2"
      shift 2
      ;;
    --release-build-number)
      [ "$#" -ge 2 ] || die "--release-build-number requires a value"
      RELEASE_BUILD_NUMBER="$2"
      shift 2
      ;;
    --source-branch)
      [ "$#" -ge 2 ] || die "--source-branch requires a value"
      SOURCE_BRANCH="$2"
      shift 2
      ;;
    --replace)
      REPLACE="true"
      shift
      ;;
    --expected-build-id)
      [ "$#" -ge 2 ] || die "--expected-build-id requires a value"
      EXPECTED_BUILD_ID="$2"
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

[ -n "$PAYLOAD_ZIP" ] || die "--payload-zip is required"
[ -f "$PAYLOAD_ZIP" ] || die "payload zip not found: $PAYLOAD_ZIP"
[ -n "$BASE_URL" ] || die "--base-url or portico_SERVICE_BASE_URL is required"
[ -n "$ADMIN_TOKEN" ] || die "portico_SERVICE_ADMIN_TOKEN is required"
case "$ADMIN_TOKEN" in
  *$'\r'*|*$'\n'*) die "portico_SERVICE_ADMIN_TOKEN must not contain newlines" ;;
esac
BASE_URL="${BASE_URL%/}"

base_url_allowed=false
for allowed_base_url in $ALLOWED_BASE_URLS; do
  normalized_allowed_base_url="${allowed_base_url%/}"
  if [ -n "$normalized_allowed_base_url" ] && [ "$BASE_URL" = "$normalized_allowed_base_url" ]; then
    base_url_allowed=true
    break
  fi
done
[ "$base_url_allowed" = true ] || die "base URL is not allowed: $BASE_URL"

case "$AUDIENCE" in
  internal)
    [ -n "$CHANNEL" ] || CHANNEL="development"
    case "$CHANNEL" in
      development|beta) ;;
      *) die "internal releases may only use development or beta channel" ;;
    esac
    ;;
  general_availability)
    [ -n "$CHANNEL" ] || CHANNEL="beta"
    case "$CHANNEL" in
      beta|production) ;;
      *) die "general_availability releases may only use beta or production channel" ;;
    esac
    SOURCE_BRANCH=""
    ;;
  *)
    die "audience must be internal or general_availability"
    ;;
esac

if [ -n "$RELEASE_BUILD_NUMBER" ] && [ -z "$RELEASE_NAME" ]; then
  die "--release-build-number requires --release-name"
fi

require_command python3
require_command curl

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/portico-service-upload.XXXXXX")"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT
umask 077
ADMIN_HEADER="$TMP_DIR/admin-header"
printf 'X-Admin-Token: %s\n' "$ADMIN_TOKEN" >"$ADMIN_HEADER"

python3 - "$PAYLOAD_ZIP" "$TMP_DIR" "$EXPECTED_BUILD_ID" <<'PY'
import json
import pathlib
import shutil
import sys
import zipfile
from pathlib import PurePosixPath

payload_zip, output_dir, expected_build_id = sys.argv[1:4]
output = pathlib.Path(output_dir)

def fail(message: str) -> None:
    raise SystemExit(f"ERROR: {message}")

def safe_member_path(member: str) -> str:
    if not member or member.startswith("/"):
        fail(f"unsafe zip member path in release manifest: {member!r}")
    parts = PurePosixPath(member).parts
    if ".." in parts:
        fail(f"unsafe zip member path in release manifest: {member!r}")
    return member

with zipfile.ZipFile(payload_zip) as archive:
    try:
        with archive.open("release-manifest.json") as manifest_file:
            manifest = json.load(manifest_file)
    except KeyError as exc:
        fail("payload zip is missing release-manifest.json")

    build_id = str(manifest.get("buildNumber") or "").strip()
    if not build_id:
        fail("release-manifest.json is missing buildNumber")
    if expected_build_id and build_id != expected_build_id:
        fail(f"release-manifest.json buildNumber {build_id} did not match expected {expected_build_id}")

    dmgs = manifest.get("dmgs") or {}
    required = {
        "darwin-arm64": output / "darwin-arm64.dmg",
        "darwin-x64": output / "darwin-x64.dmg",
    }
    for platform, target in required.items():
        member = safe_member_path(str(dmgs.get(platform) or ""))
        try:
            with archive.open(member) as source, target.open("wb") as destination:
                shutil.copyfileobj(source, destination)
        except KeyError as exc:
            fail(f"payload zip is missing {platform} DMG declared by release-manifest.json: {member}")

(output / "build-id").write_text(build_id, encoding="utf-8")
PY

BUILD_ID="$(sed -n '1p' "$TMP_DIR/build-id")"
ARM64_DMG="$TMP_DIR/darwin-arm64.dmg"
X64_DMG="$TMP_DIR/darwin-x64.dmg"

UPLOAD_RESPONSE="$TMP_DIR/upload-response.json"
UPLOAD_ARGS=(
  -sS -o "$UPLOAD_RESPONSE" -w '%{http_code}'
  --connect-timeout "$CURL_CONNECT_TIMEOUT_SECONDS"
  --max-time "$CURL_UPLOAD_MAX_TIME_SECONDS"
  --retry "$CURL_RETRY_COUNT"
  --retry-delay "$CURL_RETRY_DELAY_SECONDS"
  --retry-max-time "$CURL_UPLOAD_RETRY_MAX_TIME_SECONDS"
  --retry-all-errors
  -X POST "${BASE_URL}/api/admin/releases"
  -H "@${ADMIN_HEADER}"
  --form-string "version=${BUILD_ID}"
  --form-string "audience=${AUDIENCE}"
  --form-string "channel=${CHANNEL}"
  -F "fileDarwinArm64=@${ARM64_DMG};type=application/x-apple-diskimage"
  -F "fileDarwinX64=@${X64_DMG};type=application/x-apple-diskimage"
  --form-string "replace=${REPLACE}"
)
if [ -n "$RELEASE_NAME" ]; then
  UPLOAD_ARGS+=(--form-string "releaseName=${RELEASE_NAME}")
fi
if [ -n "$RELEASE_BUILD_NUMBER" ]; then
  UPLOAD_ARGS+=(--form-string "releaseBuildNumber=${RELEASE_BUILD_NUMBER}")
fi
if [ -n "$SOURCE_BRANCH" ]; then
  UPLOAD_ARGS+=(--form-string "sourceBranch=${SOURCE_BRANCH}")
fi
UPLOAD_CODE="$(
  curl "${UPLOAD_ARGS[@]}"
)"

case "$UPLOAD_CODE" in
  200|201) ;;
  *)
    printf 'PORTICO-Service upload failed with HTTP %s\n' "$UPLOAD_CODE" >&2
    sed -n '1,120p' "$UPLOAD_RESPONSE" >&2 || true
    exit 1
    ;;
esac

python3 - "$UPLOAD_RESPONSE" "$BUILD_ID" "$AUDIENCE" "$CHANNEL" <<'PY'
import json
import sys

response_path, build_id, audience, channel = sys.argv[1:5]

def fail(message: str) -> None:
    raise SystemExit(f"ERROR: {message}")

with open(response_path, "r", encoding="utf-8") as fh:
    try:
        payload = json.load(fh)
    except json.JSONDecodeError as exc:
        fail(f"PORTICO-Service upload response was not valid JSON: {exc}")

if payload.get("success") is not True:
    fail("PORTICO-Service upload response did not report success")

for key, expected in (("version", build_id), ("audience", audience), ("channel", channel)):
    if key in payload and payload.get(key) != expected:
        fail(f"PORTICO-Service upload response {key}={payload.get(key)!r}, expected {expected!r}")
PY

LIST_RESPONSE="$TMP_DIR/releases-response.json"
LIST_CODE="$(
  curl -sS -o "$LIST_RESPONSE" -w '%{http_code}' \
    --connect-timeout "$CURL_CONNECT_TIMEOUT_SECONDS" \
    --max-time "$CURL_VERIFY_MAX_TIME_SECONDS" \
    --retry "$CURL_RETRY_COUNT" \
    --retry-delay "$CURL_RETRY_DELAY_SECONDS" \
    --retry-max-time "$CURL_VERIFY_RETRY_MAX_TIME_SECONDS" \
    --retry-all-errors \
    -H "@${ADMIN_HEADER}" \
    "${BASE_URL}/api/admin/releases"
)"

case "$LIST_CODE" in
  200) ;;
  *)
    printf 'PORTICO-Service release validation failed with HTTP %s\n' "$LIST_CODE" >&2
    sed -n '1,120p' "$LIST_RESPONSE" >&2 || true
    exit 1
    ;;
esac

python3 - "$LIST_RESPONSE" "$BUILD_ID" "$AUDIENCE" "$CHANNEL" <<'PY'
import json
import sys

response_path, build_id, audience, channel = sys.argv[1:5]
with open(response_path, "r", encoding="utf-8") as fh:
    payload = json.load(fh)

matches = [
    release
    for release in payload.get("versions", [])
    if release.get("version") == build_id and release.get("audience") == audience
]
if len(matches) != 1:
    raise SystemExit(f"ERROR: expected exactly one {audience} release {build_id}, found {len(matches)}")

release = matches[0]
if release.get("channel") != channel:
    raise SystemExit(
        f"ERROR: release {build_id} has channel {release.get('channel')!r}, expected {channel!r}"
    )
platforms = set(release.get("platforms") or [])
missing = {"darwin-arm64", "darwin-x64"} - platforms
if missing:
    raise SystemExit(f"ERROR: release {build_id} is missing platforms: {', '.join(sorted(missing))}")
PY

printf 'Uploaded %s release %s to PORTICO-Service as %s.\n' "$AUDIENCE" "$BUILD_ID" "$CHANNEL"
