#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
UPLOAD_SCRIPT="$PROJECT_ROOT/src/scripts/ci/upload-portico-service-release.sh"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/portico-service-upload-test.XXXXXX")"

# GitLab injects the metadata job's dotenv report (RELEASE_BUILD_ID=<pipeline
# build id>) into later-stage jobs. The upload script defaults
# --expected-build-id from that variable, which would fail the fixture
# manifest's build-id gate before the behavior under test runs. Keep the
# harness hermetic, mirroring the explicit portico_SERVICE_* pins below.
unset RELEASE_BUILD_ID

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local expected="$2"
  local message="$3"
  grep -Fq -- "$expected" "$file" || fail "$message"
}

assert_not_contains() {
  local file="$1"
  local unexpected="$2"
  local message="$3"
  if grep -Fq -- "$unexpected" "$file"; then
    fail "$message"
  fi
}

assert_arg_pair() {
  local file="$1"
  local option="$2"
  local value="$3"
  local message="$4"
  awk -v option="$option" -v value="$value" '
    previous == option && $0 == value { found = 1 }
    { previous = $0 }
    END { exit(found ? 0 : 1) }
  ' "$file" || fail "$message"
}

make_payload_zip() {
  local zip_path="$1"
  local build_id="$2"

  python3 - "$zip_path" "$build_id" <<'PY'
import json
import sys
import zipfile

zip_path, build_id = sys.argv[1:3]
manifest = {
    "schemaVersion": 2,
    "buildNumber": build_id,
    "fullSha": "ebaf83faebaf83faebaf83faebaf83faebaf83fa",
    "channelPackageName": "portico_beta",
    "dmgs": {
        "darwin-arm64": "artifacts/dmg/darwin-arm64/Portico-arm64.dmg",
        "darwin-x64": "artifacts/dmg/darwin-x64/Portico-x64.dmg",
    },
}
with zipfile.ZipFile(zip_path, "w") as archive:
    archive.writestr("release-manifest.json", json.dumps(manifest))
    archive.writestr("artifacts/dmg/darwin-arm64/Portico-arm64.dmg", b"arm64-dmg")
    archive.writestr("artifacts/dmg/darwin-x64/Portico-x64.dmg", b"x64-dmg")
PY
}

write_fake_curl() {
  local fake_bin="$1"
  mkdir -p "$fake_bin"
  cat >"$fake_bin/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

mkdir -p "${FAKE_CURL_STATE:?}"
count_file="$FAKE_CURL_STATE/count"
count=0
if [ -f "$count_file" ]; then
  count="$(sed -n '1p' "$count_file")"
fi
count=$((count + 1))
printf '%s\n' "$count" >"$count_file"
printf '%s\n' "$@" >"$FAKE_CURL_STATE/call-${count}.args"

method="GET"
output_file=""
url=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      output_file="$2"
      shift 2
      ;;
    -w)
      shift 2
      ;;
    -X)
      method="$2"
      shift 2
      ;;
    -H)
      header_arg="$2"
      if [[ "$header_arg" == @* ]]; then
        header_file="${header_arg#@}"
        cp "$header_file" "$FAKE_CURL_STATE/call-${count}.headers"
        (stat -c '%a' "$header_file" 2>/dev/null || stat -f '%Lp' "$header_file") \
          >"$FAKE_CURL_STATE/call-${count}.header-mode"
      else
        printf '%s\n' "$header_arg" >"$FAKE_CURL_STATE/call-${count}.headers"
      fi
      shift 2
      ;;
    -F|--form-string)
      shift 2
      ;;
    --connect-timeout|--max-time|--retry|--retry-delay|--retry-max-time)
      shift 2
      ;;
    --retry-all-errors)
      shift
      ;;
    -s|-S|-sS)
      shift
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done

[ -n "$output_file" ] || exit 97
[ -n "$url" ] || exit 98

if [ "$method" = POST ] && [ "$url" = "https://portico.example.test/api/admin/releases" ]; then
  if [ "${FAKE_UPLOAD_SUCCESS:-true}" = true ]; then
    cat >"$output_file" <<JSON
{"success":true,"version":"${FAKE_RELEASE_BUILD_ID:?}","audience":"${FAKE_RELEASE_AUDIENCE:?}","channel":"${FAKE_RELEASE_CHANNEL:?}"}
JSON
  else
    printf '{"success":false,"error":"upload rejected"}\n' >"$output_file"
  fi
  printf '200'
  exit 0
fi

if [ "$method" = GET ] && [ "$url" = "https://portico.example.test/api/admin/releases" ]; then
  cat >"$output_file" <<JSON
{"versions":[{"version":"${FAKE_RELEASE_BUILD_ID:?}","audience":"${FAKE_RELEASE_AUDIENCE:?}","channel":"${FAKE_RELEASE_CHANNEL:?}","platforms":["darwin-arm64","darwin-x64"]}]}
JSON
  printf '200'
  exit 0
fi

printf '{"error":"unexpected fake curl request"}\n' >"$output_file"
printf '500'
SH
  chmod +x "$fake_bin/curl"
}

test_internal_upload_posts_both_dmgs_and_metadata() {
  local build_id="06252026-ebaf83fa"
  local payload="$TMP_DIR/internal.zip"
  local fake_bin="$TMP_DIR/fake-bin-internal"
  local state="$TMP_DIR/state-internal"
  local output="$TMP_DIR/internal-output.txt"
  make_payload_zip "$payload" "$build_id"
  write_fake_curl "$fake_bin"

  FAKE_CURL_STATE="$state" \
  FAKE_RELEASE_BUILD_ID="$build_id" \
  FAKE_RELEASE_AUDIENCE="internal" \
  FAKE_RELEASE_CHANNEL="development" \
  portico_SERVICE_ADMIN_TOKEN="test-admin-token" \
  portico_SERVICE_ALLOWED_BASE_URLS="https://portico.example.test" \
  PATH="$fake_bin:$PATH" \
    bash "$UPLOAD_SCRIPT" \
      --payload-zip "$payload" \
      --base-url "https://portico.example.test/" \
      --audience internal \
      --channel development \
      --release-name "Jupiter Dev Build" \
      --release-build-number 6 \
      --source-branch pre-beta-tmp \
      --expected-build-id "$build_id" \
      --replace \
      >"$output"

  assert_contains "$output" "Uploaded internal release ${build_id} to PORTICO-Service as development." \
    "internal upload did not report success"
  assert_contains "$state/call-1.args" "https://portico.example.test/api/admin/releases" \
    "internal upload did not post to the admin release API"
  assert_contains "$state/call-1.headers" "X-Admin-Token: test-admin-token" \
    "internal upload did not send the admin token header"
  assert_not_contains "$state/call-1.args" "test-admin-token" \
    "internal upload exposed the admin token in curl process arguments"
  assert_contains "$state/call-1.header-mode" "600" \
    "internal upload did not protect the temporary admin header"
  assert_contains "$state/call-1.args" "version=${build_id}" \
    "internal upload did not send the build id"
  assert_contains "$state/call-1.args" "audience=internal" \
    "internal upload did not send internal audience"
  assert_contains "$state/call-1.args" "channel=development" \
    "internal upload did not send development channel"
  assert_contains "$state/call-1.args" "releaseName=Jupiter Dev Build" \
    "internal upload did not preserve release name spaces"
  assert_contains "$state/call-1.args" "releaseBuildNumber=6" \
    "internal upload did not send release build number"
  assert_contains "$state/call-1.args" "sourceBranch=pre-beta-tmp" \
    "internal upload did not send source branch"
  assert_contains "$state/call-1.args" "replace=true" \
    "internal upload should use replace=true for CI idempotency"
  assert_contains "$state/call-1.args" "fileDarwinArm64=@" \
    "internal upload did not attach the arm64 DMG"
  assert_contains "$state/call-1.args" "fileDarwinX64=@" \
    "internal upload did not attach the x64 DMG"
  [ "$(grep -Fxc -- "-F" "$state/call-1.args")" -eq 2 ] \
    || fail "internal upload must reserve multipart file semantics for the two DMG files"
  [ "$(grep -Fxc -- "--form-string" "$state/call-1.args")" -eq 7 ] \
    || fail "internal upload must send every text field with --form-string"
  assert_arg_pair "$state/call-1.args" "--connect-timeout" "15" \
    "upload curl connect timeout drifted"
  assert_arg_pair "$state/call-1.args" "--max-time" "1800" \
    "upload curl maximum transfer time drifted"
  assert_arg_pair "$state/call-1.args" "--retry" "2" \
    "upload curl retry count drifted"
  assert_arg_pair "$state/call-1.args" "--retry-delay" "5" \
    "upload curl retry delay drifted"
  assert_arg_pair "$state/call-1.args" "--retry-max-time" "3600" \
    "upload curl retry budget drifted"
  assert_contains "$state/call-1.args" "--retry-all-errors" \
    "upload curl must retry transient transport failures"
  assert_arg_pair "$state/call-2.args" "--connect-timeout" "15" \
    "verification curl connect timeout drifted"
  assert_arg_pair "$state/call-2.args" "--max-time" "60" \
    "verification curl maximum transfer time drifted"
  assert_arg_pair "$state/call-2.args" "--retry" "2" \
    "verification curl retry count drifted"
  assert_arg_pair "$state/call-2.args" "--retry-delay" "5" \
    "verification curl retry delay drifted"
  assert_arg_pair "$state/call-2.args" "--retry-max-time" "180" \
    "verification curl retry budget drifted"
  assert_contains "$state/call-2.args" "--retry-all-errors" \
    "verification curl must retry transient transport failures"
}

test_ga_upload_strips_source_branch() {
  local build_id="06252026-ebaf83fa"
  local payload="$TMP_DIR/ga.zip"
  local fake_bin="$TMP_DIR/fake-bin-ga"
  local state="$TMP_DIR/state-ga"
  make_payload_zip "$payload" "$build_id"
  write_fake_curl "$fake_bin"

  FAKE_CURL_STATE="$state" \
  FAKE_RELEASE_BUILD_ID="$build_id" \
  FAKE_RELEASE_AUDIENCE="general_availability" \
  FAKE_RELEASE_CHANNEL="beta" \
  portico_SERVICE_ADMIN_TOKEN="test-admin-token" \
  portico_SERVICE_ALLOWED_BASE_URLS="https://portico.example.test" \
  PATH="$fake_bin:$PATH" \
    bash "$UPLOAD_SCRIPT" \
      --payload-zip "$payload" \
      --base-url "https://portico.example.test" \
      --audience general_availability \
      --channel beta \
      --source-branch should-not-be-sent \
      --expected-build-id "$build_id" \
      --replace \
      >/dev/null

  assert_contains "$state/call-1.args" "audience=general_availability" \
    "GA upload did not send GA audience"
  assert_contains "$state/call-1.args" "channel=beta" \
    "GA upload did not send beta channel"
  assert_not_contains "$state/call-1.args" "sourceBranch=" \
    "GA upload must not send source branch provenance"
}

test_invalid_audience_channel_pair_fails_before_curl() {
  local build_id="06252026-ebaf83fa"
  local payload="$TMP_DIR/invalid.zip"
  local state="$TMP_DIR/state-invalid"
  local err="$TMP_DIR/invalid.err"
  make_payload_zip "$payload" "$build_id"

  if FAKE_CURL_STATE="$state" \
    portico_SERVICE_ADMIN_TOKEN="test-admin-token" \
    portico_SERVICE_ALLOWED_BASE_URLS="https://portico.example.test" \
    bash "$UPLOAD_SCRIPT" \
      --payload-zip "$payload" \
      --base-url "https://portico.example.test" \
      --audience general_availability \
      --channel development \
      >"$TMP_DIR/invalid.out" 2>"$err"; then
    fail "invalid GA development pair was accepted"
  fi

  assert_contains "$err" "general_availability releases may only use beta or production channel" \
    "invalid pair failure did not explain the channel rule"
  [ ! -e "$state/call-1.args" ] || fail "invalid pair should fail before calling curl"
}

test_disallowed_base_url_fails_before_curl() {
  local build_id="06252026-ebaf83fa"
  local payload="$TMP_DIR/disallowed-base.zip"
  local fake_bin="$TMP_DIR/fake-bin-disallowed-base"
  local state="$TMP_DIR/state-disallowed-base"
  local err="$TMP_DIR/disallowed-base.err"
  make_payload_zip "$payload" "$build_id"
  write_fake_curl "$fake_bin"

  if FAKE_CURL_STATE="$state" \
    portico_SERVICE_ADMIN_TOKEN="test-admin-token" \
    portico_SERVICE_ALLOWED_BASE_URLS="https://portico-service.sandbox.example.invalid" \
    PATH="$fake_bin:$PATH" \
    bash "$UPLOAD_SCRIPT" \
      --payload-zip "$payload" \
      --base-url "https://portico.example.test" \
      --audience internal \
      --channel development \
      >"$TMP_DIR/disallowed-base.out" 2>"$err"; then
    fail "disallowed PORTICO-Service base URL was accepted"
  fi

  assert_contains "$err" "base URL is not allowed: https://portico.example.test" \
    "disallowed base URL failure did not explain the allowlist rule"
  [ ! -e "$state/call-1.args" ] || fail "disallowed base URL should fail before calling curl"
}

test_failed_upload_response_is_rejected() {
  local build_id="06252026-ebaf83fa"
  local payload="$TMP_DIR/failed-upload.zip"
  local fake_bin="$TMP_DIR/fake-bin-failed-upload"
  local state="$TMP_DIR/state-failed-upload"
  local err="$TMP_DIR/failed-upload.err"
  make_payload_zip "$payload" "$build_id"
  write_fake_curl "$fake_bin"

  if FAKE_CURL_STATE="$state" \
    FAKE_RELEASE_BUILD_ID="$build_id" \
    FAKE_RELEASE_AUDIENCE="internal" \
    FAKE_RELEASE_CHANNEL="development" \
    FAKE_UPLOAD_SUCCESS=false \
    portico_SERVICE_ADMIN_TOKEN="test-admin-token" \
    portico_SERVICE_ALLOWED_BASE_URLS="https://portico.example.test" \
    PATH="$fake_bin:$PATH" \
    bash "$UPLOAD_SCRIPT" \
      --payload-zip "$payload" \
      --base-url "https://portico.example.test" \
      --audience internal \
      --channel development \
      >"$TMP_DIR/failed-upload.out" 2>"$err"; then
    fail "failed PORTICO-Service upload response was accepted"
  fi

  assert_contains "$err" "PORTICO-Service upload response did not report success" \
    "failed upload response was not validated"
}

test_internal_upload_posts_both_dmgs_and_metadata
test_ga_upload_strips_source_branch
test_invalid_audience_channel_pair_fails_before_curl
test_disallowed_base_url_fails_before_curl
test_failed_upload_response_is_rejected

printf 'PASS: PORTICO-Service release upload helper\n'
