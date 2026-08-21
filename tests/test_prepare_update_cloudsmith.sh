#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PREPARE_UPDATE_SCRIPT="$PROJECT_ROOT/electron-app/src/scripts/prepare-update-cloudsmith.sh"
# shellcheck source=tests/helpers/parallel-shell-tests.sh
source "$PROJECT_ROOT/tests/helpers/parallel-shell-tests.sh"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

create_payload_zip() {
  local tmp_dir="$1"
  local zip_path="$2"
  local channel="${3:-portico_dev}"
  local payload_root="$tmp_dir/payload"

  if [ "$channel" = "portico_dev" ] && [ -n "${PREPARE_UPDATE_SHARED_FIXTURE:-}" ]; then
    cp -R "$PREPARE_UPDATE_SHARED_FIXTURE/payload" "$payload_root"
    cp "$PREPARE_UPDATE_SHARED_FIXTURE/payload.zip" "$zip_path"
    return
  fi

  mkdir -p "$payload_root/managed-root/electron-app"
  mkdir -p "$payload_root/artifacts/apps/darwin-arm64/Portico.app/Contents/MacOS"
  mkdir -p "$payload_root/artifacts/apps/darwin-x64/Portico.app/Contents/MacOS"
  mkdir -p "$payload_root/artifacts/dmg/darwin-arm64"
  mkdir -p "$payload_root/artifacts/dmg/darwin-x64"

  cat > "$payload_root/managed-root/electron-app/build-info.json" <<EOF
{
  "buildNumber": "03162026-deadbeef",
  "fullSha": "deadbeefcafefeed",
  "channel": "${channel}"
}
EOF

  : > "$payload_root/artifacts/apps/darwin-arm64/Portico.app/Contents/MacOS/Portico"
  : > "$payload_root/artifacts/apps/darwin-x64/Portico.app/Contents/MacOS/Portico"
  printf '%s\n' "arm64-dmg" > "$payload_root/artifacts/dmg/darwin-arm64/Portico-arm64.dmg"
  printf '%s\n' "x64-dmg" > "$payload_root/artifacts/dmg/darwin-x64/Portico-x64.dmg"

  cat > "$payload_root/release-manifest.json" <<EOF
{
  "schemaVersion": 2,
  "buildNumber": "03162026-deadbeef",
  "fullSha": "deadbeefcafefeed",
  "channelPackageName": "${channel}",
  "managedRootDir": "managed-root",
  "dockerImages": [],
  "appBundles": {
    "darwin-arm64": "artifacts/apps/darwin-arm64/Portico.app",
    "darwin-x64": "artifacts/apps/darwin-x64/Portico.app"
  },
  "dmgs": {
    "darwin-arm64": "artifacts/dmg/darwin-arm64/Portico-arm64.dmg",
    "darwin-x64": "artifacts/dmg/darwin-x64/Portico-x64.dmg"
  }
}
EOF

  (
    cd "$payload_root" &&
    zip -qr "$zip_path" .
  )
}

create_fake_curl() {
  local bin_dir="$1"

  cat > "$bin_dir/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

attempt_file="${FAKE_CURL_ATTEMPT_FILE:?}"
plan="${FAKE_CURL_PLAN:?}"
payload_zip="${FAKE_CURL_PAYLOAD_ZIP:?}"

attempt=0
if [ -f "$attempt_file" ]; then
  attempt="$(cat "$attempt_file")"
fi
attempt=$((attempt + 1))
printf '%s' "$attempt" > "$attempt_file"

output_path=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      output_path="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

IFS=',' read -r -a plan_codes <<< "$plan"
index=$((attempt - 1))
if [ "$index" -ge "${#plan_codes[@]}" ]; then
  index=$(( ${#plan_codes[@]} - 1 ))
fi
code="${plan_codes[$index]}"

if [ "$code" = "0" ]; then
  cp "$payload_zip" "$output_path"
  exit 0
fi

case "$code" in
  22)
    printf '%s\n' "curl: (22) The requested URL returned error: 404" >&2
    ;;
  56)
    printf '%s\n' "curl: (56) Recv failure: Connection reset by peer" >&2
    ;;
  http403)
    # PORTICO-323 (#4): the real-world shape -- once -L has followed the CDN
    # redirect curl reports an HTTP 403 behind transport exit code 56, and log
    # redaction can replace the word "error".
    printf '%s\n' "curl: (56) The requested URL returned <REDACTED>: 403" >&2
    exit 56
    ;;
  *)
    printf 'curl: (%s) simulated failure\n' "$code" >&2
    ;;
esac
exit "$code"
SH
  chmod +x "$bin_dir/curl"
}

create_fake_sleep() {
  local bin_dir="$1"

  cat > "$bin_dir/sleep" <<'SH'
#!/usr/bin/env bash
exit 0
SH
  chmod +x "$bin_dir/sleep"
}

create_fake_signature_tools() {
  local bin_dir="$1"

  cat > "$bin_dir/xcode-select" <<'SH'
#!/usr/bin/env bash
printf 'xcode-select %s\n' "$*" >> "${FAKE_SIGNATURE_LOG:?}"
printf '%s\n' "${FAKE_XCODE_SELECT_OUTPUT:-/Library/Developer/CommandLineTools}" >&2
exit "${FAKE_XCODE_SELECT_STATUS:-0}"
SH
  chmod +x "$bin_dir/xcode-select"

  cat > "$bin_dir/codesign" <<'SH'
#!/usr/bin/env bash
printf 'codesign %s\n' "$*" >> "${FAKE_SIGNATURE_LOG:?}"
case "$*" in
  *.dmg*) exit "${FAKE_DMG_CODESIGN_STATUS:-0}" ;;
  *) exit "${FAKE_CODESIGN_STATUS:-0}" ;;
esac
SH
  chmod +x "$bin_dir/codesign"

  cat > "$bin_dir/spctl" <<'SH'
#!/usr/bin/env bash
printf 'spctl %s\n' "$*" >> "${FAKE_SIGNATURE_LOG:?}"
case "$*" in
  *"--type execute"*) exit "${FAKE_APP_SPCTL_STATUS:-0}" ;;
  *"--type open"*) exit "${FAKE_DMG_SPCTL_STATUS:-0}" ;;
esac
exit 0
SH
  chmod +x "$bin_dir/spctl"

  cat > "$bin_dir/xcrun" <<'SH'
#!/usr/bin/env bash
printf 'xcrun %s\n' "$*" >> "${FAKE_SIGNATURE_LOG:?}"
case "$*" in
  "--find stapler")
    printf '%s\n' "${FAKE_XCRUN_FIND_STAPLER_OUTPUT:-/Library/Developer/CommandLineTools/usr/bin/stapler}" >&2
    exit "${FAKE_XCRUN_FIND_STAPLER_STATUS:-0}"
    ;;
  *.dmg*)
    if [ -n "${FAKE_DMG_STAPLER_SLEEP_SECONDS:-}" ]; then
      /bin/sleep "$FAKE_DMG_STAPLER_SLEEP_SECONDS"
    fi
    printf '%s\n' "${FAKE_DMG_STAPLER_OUTPUT:-}" >&2
    exit "${FAKE_DMG_STAPLER_STATUS:-0}"
    ;;
  *)
    if [ -n "${FAKE_APP_STAPLER_SLEEP_SECONDS:-}" ]; then
      /bin/sleep "$FAKE_APP_STAPLER_SLEEP_SECONDS"
    fi
    printf '%s\n' "${FAKE_APP_STAPLER_OUTPUT:-}" >&2
    exit "${FAKE_APP_STAPLER_STATUS:-0}"
    ;;
esac
SH
  chmod +x "$bin_dir/xcrun"
}

run_prepare_update() {
  local tmp_dir="$1"
  local curl_plan="$2"
  local payload_zip="$3"
  local checksum="$4"
  local file_size="$5"
  local update_channel="${6:-portico_dev}"
  local filename="${update_channel}-03162026-deadbeef.zip"
  local attempt_file="$tmp_dir/curl-attempts"
  local bin_dir="$tmp_dir/bin"
  local stage_dir="$tmp_dir/stage"
  local home_dir="${TEST_PREPARE_HOME_DIR:-$tmp_dir/home}"

  mkdir -p "$home_dir"
  if [ -n "${PREPARE_UPDATE_SHARED_FIXTURE:-}" ]; then
    mkdir -p "$bin_dir"
    local shared_tool=""
    for shared_tool in "$PREPARE_UPDATE_SHARED_FIXTURE/bin/"*; do
      [ -e "$bin_dir/$(basename "$shared_tool")" ] \
        || ln -s "$shared_tool" "$bin_dir/$(basename "$shared_tool")"
    done
  else
    mkdir -p "$bin_dir"
    create_fake_curl "$bin_dir"
    create_fake_sleep "$bin_dir"
    create_fake_signature_tools "$bin_dir"
  fi
  ln -sf "$(command -v zip)" "$bin_dir/zip"

  HOME="$home_dir" \
  PATH="$bin_dir:/usr/bin:/bin:/usr/sbin:/sbin" \
  FAKE_CURL_ATTEMPT_FILE="$attempt_file" \
  FAKE_CURL_PLAN="$curl_plan" \
  FAKE_CURL_PAYLOAD_ZIP="$payload_zip" \
  FAKE_SIGNATURE_LOG="$tmp_dir/signature.log" \
  FAKE_XCODE_SELECT_STATUS="${FAKE_XCODE_SELECT_STATUS:-0}" \
  FAKE_XCODE_SELECT_OUTPUT="${FAKE_XCODE_SELECT_OUTPUT:-/Library/Developer/CommandLineTools}" \
  FAKE_XCRUN_FIND_STAPLER_STATUS="${FAKE_XCRUN_FIND_STAPLER_STATUS:-0}" \
  FAKE_XCRUN_FIND_STAPLER_OUTPUT="${FAKE_XCRUN_FIND_STAPLER_OUTPUT:-/Library/Developer/CommandLineTools/usr/bin/stapler}" \
  FAKE_CODESIGN_STATUS="${FAKE_CODESIGN_STATUS:-0}" \
  FAKE_DMG_CODESIGN_STATUS="${FAKE_DMG_CODESIGN_STATUS:-0}" \
  FAKE_APP_SPCTL_STATUS="${FAKE_APP_SPCTL_STATUS:-0}" \
  FAKE_DMG_SPCTL_STATUS="${FAKE_DMG_SPCTL_STATUS:-0}" \
  FAKE_APP_STAPLER_STATUS="${FAKE_APP_STAPLER_STATUS:-0}" \
  FAKE_APP_STAPLER_OUTPUT="${FAKE_APP_STAPLER_OUTPUT:-}" \
  FAKE_APP_STAPLER_SLEEP_SECONDS="${FAKE_APP_STAPLER_SLEEP_SECONDS:-}" \
  FAKE_DMG_STAPLER_STATUS="${FAKE_DMG_STAPLER_STATUS:-0}" \
  FAKE_DMG_STAPLER_OUTPUT="${FAKE_DMG_STAPLER_OUTPUT:-}" \
  FAKE_DMG_STAPLER_SLEEP_SECONDS="${FAKE_DMG_STAPLER_SLEEP_SECONDS:-}" \
  UPDATE_STAPLER_VALIDATE_TIMEOUT_SECONDS="${UPDATE_STAPLER_VALIDATE_TIMEOUT_SECONDS:-75}" \
  PORTICO_TEST_UPDATE_COMMAND_POLL_INTERVAL_SECONDS="0.01" \
  SKIP_UPDATE_SIGNATURE_VERIFICATION="${TEST_SKIP_UPDATE_SIGNATURE_VERIFICATION:-1}" \
  bash "$PREPARE_UPDATE_SCRIPT" \
    "$stage_dir" \
    "$PROJECT_ROOT" \
    "https://dl.artifacts.example.invalid/TOKEN/portico/raw/names/${update_channel}/versions/03162026-deadbeef/${filename}" \
    "$filename" \
    "deadbeefcafefeed" \
    "03162026-deadbeef|sha256:${checksum}|${update_channel}" \
    "$update_channel" \
    "sha256" \
    "$checksum" \
    "2026-03-17T01:18:51Z" \
    "$file_size"
}

test_prepare_update_accepts_matching_custom_channel_identity() {
  (
    local tmp_dir payload_zip checksum file_size custom_channel
    tmp_dir="$(mktemp -d)"
    payload_zip="$tmp_dir/payload.zip"
    custom_channel="portico_team-alpha"
    create_payload_zip "$tmp_dir" "$payload_zip" "$custom_channel"
    checksum="$(shasum -a 256 "$payload_zip" | awk '{print tolower($1)}')"
    file_size="$(wc -c < "$payload_zip" | tr -d '[:space:]')"

    run_prepare_update \
      "$tmp_dir" \
      "0" \
      "$payload_zip" \
      "$checksum" \
      "$file_size" \
      "$custom_channel" \
      >/dev/null \
      || fail "prepare-update-cloudsmith.sh rejected a matching custom channel"

    grep -Fq '"channel": "portico_team-alpha"' \
      "$tmp_dir/stage/payload/managed-root/electron-app/build-info.json" \
      || fail "custom channel identity was not preserved in staged build metadata"
  )
}

test_prepare_update_does_not_mask_codesign_failure() {
  [ "$(uname -s)" = "Darwin" ] || return 0

  (
    local tmp_dir payload_zip checksum file_size output
    tmp_dir="$(mktemp -d)"
    payload_zip="$tmp_dir/payload.zip"
    create_payload_zip "$tmp_dir" "$payload_zip"
    checksum="$(shasum -a 256 "$payload_zip" | awk '{print tolower($1)}')"
    file_size="$(wc -c < "$payload_zip" | tr -d '[:space:]')"

    TEST_SKIP_UPDATE_SIGNATURE_VERIFICATION=0
    FAKE_CODESIGN_STATUS=41
    if output="$(run_prepare_update "$tmp_dir" "0" "$payload_zip" "$checksum" "$file_size" 2>&1)"; then
      fail "prepare-update-cloudsmith.sh masked a failed app codesign check"
    fi

    case "$output" in
      *"[UPDATE_PREP:ERROR:App bundle code-signature verification failed]"* ) ;;
      * ) fail "codesign failure did not emit an actionable machine-readable error" ;;
    esac
    grep -q '^codesign --verify ' "$tmp_dir/signature.log" \
      || fail "codesign verification was not attempted"
    if grep -q '^spctl .*--type execute' "$tmp_dir/signature.log"; then
      fail "Gatekeeper assessment ran after codesign had already failed"
    fi
  )
}

test_prepare_update_accepts_artifacts_that_pass_all_client_trust_checks() {
  [ "$(uname -s)" = "Darwin" ] || return 0

  (
    local tmp_dir payload_zip checksum file_size
    tmp_dir="$(mktemp -d)"
    payload_zip="$tmp_dir/payload.zip"
    create_payload_zip "$tmp_dir" "$payload_zip"
    checksum="$(shasum -a 256 "$payload_zip" | awk '{print tolower($1)}')"
    file_size="$(wc -c < "$payload_zip" | tr -d '[:space:]')"

    TEST_SKIP_UPDATE_SIGNATURE_VERIFICATION=0
    run_prepare_update "$tmp_dir" "0" "$payload_zip" "$checksum" "$file_size" >/dev/null \
      || fail "artifacts passing all client trust checks were rejected"

    grep -q '^xcode-select -p$' "$tmp_dir/signature.log" \
      || fail "Command Line Tools selection was not verified"
    grep -q '^xcrun --find stapler$' "$tmp_dir/signature.log" \
      || fail "stapler availability was not verified through xcrun"
    grep -q '^codesign --verify --deep --strict .*\.app' "$tmp_dir/signature.log" \
      || fail "app codesign verification was not attempted"
    grep -q '^spctl --assess --type execute .*\.app' "$tmp_dir/signature.log" \
      || fail "app Gatekeeper assessment was not attempted"
    grep -q '^xcrun stapler validate .*\.app' "$tmp_dir/signature.log" \
      || fail "app stapler validation was not attempted"
    if grep -q '\.dmg' "$tmp_dir/signature.log"; then
      fail "client update preparation should not run trust-chain checks on the unused DMG"
    fi
  )
}

test_prepare_update_reports_missing_command_line_tools_before_trust_checks() {
  [ "$(uname -s)" = "Darwin" ] || return 0

  (
    local tmp_dir payload_zip checksum file_size output
    tmp_dir="$(mktemp -d)"
    payload_zip="$tmp_dir/payload.zip"
    create_payload_zip "$tmp_dir" "$payload_zip"
    checksum="$(shasum -a 256 "$payload_zip" | awk '{print tolower($1)}')"
    file_size="$(wc -c < "$payload_zip" | tr -d '[:space:]')"

    TEST_SKIP_UPDATE_SIGNATURE_VERIFICATION=0
    FAKE_XCODE_SELECT_STATUS=1
    FAKE_XCODE_SELECT_OUTPUT='xcode-select: error: No developer tools were found.'
    if output="$(run_prepare_update "$tmp_dir" "0" "$payload_zip" "$checksum" "$file_size" 2>&1)"; then
      fail "prepare-update-cloudsmith.sh accepted an update without Command Line Tools"
    fi

    case "$output" in
      *"[UPDATE_PREP:ERROR:Apple Command Line Tools are missing or incomplete. Run xcode-select --install, finish Apple's installer, then retry the update]"* ) ;;
      * ) fail "missing Command Line Tools did not emit the actionable update-preparation error" ;;
    esac
    case "$output" in
      *"Run xcode-select --install"* ) ;;
      * ) fail "missing Command Line Tools did not explain how to recover" ;;
    esac
    if grep -Eq '^(codesign|spctl|xcrun) ' "$tmp_dir/signature.log"; then
      fail "artifact trust checks ran after the Command Line Tools precondition failed"
    fi
  )
}

test_prepare_update_reports_unresolvable_stapler_as_incomplete_command_line_tools() {
  [ "$(uname -s)" = "Darwin" ] || return 0

  (
    local tmp_dir payload_zip checksum file_size output
    tmp_dir="$(mktemp -d)"
    payload_zip="$tmp_dir/payload.zip"
    create_payload_zip "$tmp_dir" "$payload_zip"
    checksum="$(shasum -a 256 "$payload_zip" | awk '{print tolower($1)}')"
    file_size="$(wc -c < "$payload_zip" | tr -d '[:space:]')"

    TEST_SKIP_UPDATE_SIGNATURE_VERIFICATION=0
    FAKE_XCRUN_FIND_STAPLER_STATUS=1
    FAKE_XCRUN_FIND_STAPLER_OUTPUT='xcrun: error: unable to find utility "stapler"'
    if output="$(run_prepare_update "$tmp_dir" "0" "$payload_zip" "$checksum" "$file_size" 2>&1)"; then
      fail "prepare-update-cloudsmith.sh accepted an update without a usable stapler"
    fi

    case "$output" in
      *"[UPDATE_PREP:ERROR:Apple Command Line Tools are missing or incomplete. Run xcode-select --install, finish Apple's installer, then retry the update]"* ) ;;
      * ) fail "unresolvable stapler did not emit the actionable Command Line Tools error" ;;
    esac
    grep -q '^xcode-select -p$' "$tmp_dir/signature.log" \
      || fail "xcode-select was not probed before stapler resolution"
    grep -q '^xcrun --find stapler$' "$tmp_dir/signature.log" \
      || fail "stapler resolution was not attempted"
    if grep -Eq '^(codesign|spctl|xcrun stapler) ' "$tmp_dir/signature.log"; then
      fail "artifact trust checks ran after stapler resolution failed"
    fi
  )
}

test_prepare_update_treats_transient_app_stapler_timeout_as_advisory() {
  [ "$(uname -s)" = "Darwin" ] || return 0

  (
    local tmp_dir payload_zip checksum file_size output
    tmp_dir="$(mktemp -d)"
    payload_zip="$tmp_dir/payload.zip"
    create_payload_zip "$tmp_dir" "$payload_zip"
    checksum="$(shasum -a 256 "$payload_zip" | awk '{print tolower($1)}')"
    file_size="$(wc -c < "$payload_zip" | tr -d '[:space:]')"

    TEST_SKIP_UPDATE_SIGNATURE_VERIFICATION=0
    FAKE_APP_STAPLER_STATUS=68
    FAKE_APP_STAPLER_OUTPUT='error is Error Domain=NSURLErrorDomain Code=-1001 "The request timed out." NSErrorFailingURLStringKey=https://api.apple-cloudkit.com/database/1/com.apple.gk.ticket-delivery/production/public/records/lookup'
    output="$(run_prepare_update "$tmp_dir" "0" "$payload_zip" "$checksum" "$file_size" 2>&1)" \
      || fail "prepare-update-cloudsmith.sh rejected an artifact after a transient Apple stapler timeout"

    case "$output" in
      *"Stapler validation for app bundle hit a transient Apple notarization service error"* ) ;;
      * ) fail "transient stapler timeout did not emit an advisory log" ;;
    esac
    grep -q '^xcrun stapler validate .*\.app' "$tmp_dir/signature.log" \
      || fail "app stapler validation was not attempted"
    if grep -q '\.dmg' "$tmp_dir/signature.log"; then
      fail "client update preparation should not validate the DMG after app stapler advisory"
    fi
  )
}

test_prepare_update_rejects_non_transient_app_stapler_failure() {
  [ "$(uname -s)" = "Darwin" ] || return 0

  (
    local tmp_dir payload_zip checksum file_size output
    tmp_dir="$(mktemp -d)"
    payload_zip="$tmp_dir/payload.zip"
    create_payload_zip "$tmp_dir" "$payload_zip"
    checksum="$(shasum -a 256 "$payload_zip" | awk '{print tolower($1)}')"
    file_size="$(wc -c < "$payload_zip" | tr -d '[:space:]')"

    TEST_SKIP_UPDATE_SIGNATURE_VERIFICATION=0
    FAKE_APP_STAPLER_STATUS=65
    FAKE_APP_STAPLER_OUTPUT='The validate action failed! Error 65.'
    if output="$(run_prepare_update "$tmp_dir" "0" "$payload_zip" "$checksum" "$file_size" 2>&1)"; then
      fail "prepare-update-cloudsmith.sh accepted a non-transient app stapler failure"
    fi

    case "$output" in
      *"[UPDATE_PREP:ERROR:App bundle notarization-ticket validation failed]"* ) ;;
      * ) fail "non-transient app stapler failure did not emit the expected error marker" ;;
    esac
    if grep -q '^codesign --verify --strict .*\.dmg' "$tmp_dir/signature.log"; then
      fail "disk image verification ran after app stapler validation failed"
    fi
  )
}

test_prepare_update_rejects_unclassified_app_stapler_timeout() {
  [ "$(uname -s)" = "Darwin" ] || return 0

  (
    local tmp_dir payload_zip checksum file_size output
    tmp_dir="$(mktemp -d)"
    payload_zip="$tmp_dir/payload.zip"
    create_payload_zip "$tmp_dir" "$payload_zip"
    checksum="$(shasum -a 256 "$payload_zip" | awk '{print tolower($1)}')"
    file_size="$(wc -c < "$payload_zip" | tr -d '[:space:]')"

    TEST_SKIP_UPDATE_SIGNATURE_VERIFICATION=0
    UPDATE_STAPLER_VALIDATE_TIMEOUT_SECONDS=1
    FAKE_APP_STAPLER_SLEEP_SECONDS=3
    if output="$(run_prepare_update "$tmp_dir" "0" "$payload_zip" "$checksum" "$file_size" 2>&1)"; then
      fail "prepare-update-cloudsmith.sh accepted an unclassified app stapler timeout"
    fi

    case "$output" in
      *"Stapler validation for app bundle timed out after 1s without a classified Apple notarization-service error."* ) ;;
      * ) fail "unclassified app stapler timeout did not emit the expected timeout diagnostic" ;;
    esac
    case "$output" in
      *"[UPDATE_PREP:ERROR:App bundle notarization-ticket validation failed]"* ) ;;
      * ) fail "unclassified app stapler timeout did not fail update preparation" ;;
    esac
  )
}

test_prepare_update_accepts_unsigned_dmg_for_client_prep() {
  [ "$(uname -s)" = "Darwin" ] || return 0

  (
    local tmp_dir payload_zip checksum file_size
    tmp_dir="$(mktemp -d)"
    payload_zip="$tmp_dir/payload.zip"
    create_payload_zip "$tmp_dir" "$payload_zip"
    checksum="$(shasum -a 256 "$payload_zip" | awk '{print tolower($1)}')"
    file_size="$(wc -c < "$payload_zip" | tr -d '[:space:]')"

    TEST_SKIP_UPDATE_SIGNATURE_VERIFICATION=0
    FAKE_DMG_CODESIGN_STATUS=43
    FAKE_DMG_SPCTL_STATUS=42
    FAKE_DMG_STAPLER_STATUS=68
    run_prepare_update "$tmp_dir" "0" "$payload_zip" "$checksum" "$file_size" >/dev/null \
      || fail "prepare-update-cloudsmith.sh rejected a payload because the unused DMG failed trust checks"

    grep -q '^codesign --verify --deep --strict .*\.app' "$tmp_dir/signature.log" \
      || fail "app codesign verification was not attempted"
    if grep -q '\.dmg' "$tmp_dir/signature.log"; then
      fail "client update preparation should not run DMG trust-chain commands"
    fi
  )
}

test_prepare_update_rejects_empty_dmg_placeholder() {
  [ "$(uname -s)" = "Darwin" ] || return 0

  (
    local tmp_dir payload_zip checksum file_size output
    tmp_dir="$(mktemp -d)"
    payload_zip="$tmp_dir/payload.zip"
    create_payload_zip "$tmp_dir" "$payload_zip"
    : > "$tmp_dir/payload/artifacts/dmg/darwin-arm64/Portico-arm64.dmg"
    (
      cd "$tmp_dir/payload" &&
      zip -qr "$payload_zip" .
    )
    checksum="$(shasum -a 256 "$payload_zip" | awk '{print tolower($1)}')"
    file_size="$(wc -c < "$payload_zip" | tr -d '[:space:]')"

    TEST_SKIP_UPDATE_SIGNATURE_VERIFICATION=0
    if output="$(run_prepare_update "$tmp_dir" "0" "$payload_zip" "$checksum" "$file_size" 2>&1)"; then
      fail "prepare-update-cloudsmith.sh accepted an empty DMG placeholder"
    fi

    case "$output" in
      *"Selected DMG is empty:"* ) ;;
      * ) fail "empty DMG placeholder did not emit the expected diagnostic" ;;
    esac
  )
}

test_prepare_update_retries_transient_download_failures() {
  (
    local tmp_dir payload_zip checksum file_size output attempt_count
    tmp_dir="$(mktemp -d)"
    payload_zip="$tmp_dir/payload.zip"
    create_payload_zip "$tmp_dir" "$payload_zip"

    checksum="$(shasum -a 256 "$payload_zip" | awk '{print tolower($1)}')"
    file_size="$(wc -c < "$payload_zip" | tr -d '[:space:]')"

    output="$(run_prepare_update "$tmp_dir" "56,0" "$payload_zip" "$checksum" "$file_size" 2>&1)" \
      || fail "prepare-update-cloudsmith.sh did not recover from a transient curl failure"

    attempt_count="$(cat "$tmp_dir/curl-attempts")"
    [ "$attempt_count" = "2" ] || fail "expected two curl attempts for transient failure recovery, saw $attempt_count"
    case "$output" in
      *"Retrying payload download after transient curl failure (attempt 1/3, retry in 2s)"* ) ;;
      * ) fail "retry log line was not emitted for transient curl failure" ;;
    esac
    case "$output" in
      *"[UPDATE_PREP:STEP:DOWNLOAD:COMPLETE]"* ) ;;
      * ) fail "download completion marker was not emitted after successful retry" ;;
    esac
  )
}

test_prepare_update_does_not_retry_non_retryable_download_failures() {
  (
    local tmp_dir payload_zip checksum file_size output attempt_count
    tmp_dir="$(mktemp -d)"
    payload_zip="$tmp_dir/payload.zip"
    create_payload_zip "$tmp_dir" "$payload_zip"

    checksum="$(shasum -a 256 "$payload_zip" | awk '{print tolower($1)}')"
    file_size="$(wc -c < "$payload_zip" | tr -d '[:space:]')"

    if output="$(run_prepare_update "$tmp_dir" "22" "$payload_zip" "$checksum" "$file_size" 2>&1)"; then
      fail "prepare-update-cloudsmith.sh unexpectedly succeeded for non-retryable curl failure"
    fi

    attempt_count="$(cat "$tmp_dir/curl-attempts")"
    [ "$attempt_count" = "1" ] || fail "expected one curl attempt for non-retryable failure, saw $attempt_count"
    case "$output" in
      *"Retrying payload download after transient curl failure"* )
        fail "non-retryable curl failure should not log a retry message"
        ;;
    esac
  )
}

test_prepare_update_emits_machine_readable_error_after_retry_exhaustion() {
  (
    local tmp_dir payload_zip checksum file_size output attempt_count
    tmp_dir="$(mktemp -d)"
    payload_zip="$tmp_dir/payload.zip"
    create_payload_zip "$tmp_dir" "$payload_zip"

    checksum="$(shasum -a 256 "$payload_zip" | awk '{print tolower($1)}')"
    file_size="$(wc -c < "$payload_zip" | tr -d '[:space:]')"

    if output="$(run_prepare_update "$tmp_dir" "56,56,56" "$payload_zip" "$checksum" "$file_size" 2>&1)"; then
      fail "prepare-update-cloudsmith.sh unexpectedly succeeded after retry exhaustion"
    fi

    attempt_count="$(cat "$tmp_dir/curl-attempts")"
    [ "$attempt_count" = "3" ] || fail "expected three curl attempts after retry exhaustion, saw $attempt_count"
    case "$output" in
      *"[UPDATE_PREP:ERROR:Failed to download update payload after 3 attempts: curl: (56) Recv failure: Connection reset by peer]"* ) ;;
      * ) fail "retry exhaustion did not emit the machine-readable error marker" ;;
    esac
  )
}

test_prepare_update_reports_http_status_for_refused_download() {
  (
    local tmp_dir payload_zip checksum file_size output
    tmp_dir="$(mktemp -d)"
    payload_zip="$tmp_dir/payload.zip"
    create_payload_zip "$tmp_dir" "$payload_zip"

    checksum="$(shasum -a 256 "$payload_zip" | awk '{print tolower($1)}')"
    file_size="$(wc -c < "$payload_zip" | tr -d '[:space:]')"

    if output="$(run_prepare_update "$tmp_dir" "http403,http403,http403" \
      "$payload_zip" "$checksum" "$file_size" 2>&1)"; then
      fail "prepare-update-cloudsmith.sh unexpectedly succeeded for a refused download"
    fi

    # PORTICO-323 (#4): the HTTP status must reach the app, otherwise the only
    # signal is transport exit code 56 and the user gets unactionable text.
    case "$output" in
      *"[UPDATE_PREP:ERROR:Failed to download update payload after 3 attempts: HTTP 403 "* ) ;;
      * ) fail "refused download did not surface the HTTP status in the error marker" ;;
    esac
  )
}

test_prepare_update_creates_slim_backup_db_snapshot_and_ledger() {
  (
    local tmp_dir payload_zip checksum file_size managed_dir backup_zip zip_entries
    local snapshot_dir snapshot_path snapshot_count history_file history_count output
    tmp_dir="$(mktemp -d)"
    payload_zip="$tmp_dir/payload.zip"
    TEST_PREPARE_HOME_DIR="$tmp_dir/home-o'connor"
    export TEST_PREPARE_HOME_DIR
    managed_dir="$TEST_PREPARE_HOME_DIR/portico/portico-managed"
    snapshot_dir="$managed_dir/backup/db-snapshots"
    history_file="$managed_dir/health-status/update-history.jsonl"
    mkdir -p \
      "$managed_dir/electron-app" \
      "$managed_dir/open-webui-data/uploads" \
      "$managed_dir/workspaces" \
      "$managed_dir/artifact-snapshots" \
      "$managed_dir/skills" \
      "$managed_dir/mcp-configs-user" \
      "$managed_dir/mcpo-google-oauth-tokens" \
      "$snapshot_dir" \
      "$(dirname "$history_file")"

    printf 'API_KEY=secret\n' > "$managed_dir/.env"
    printf 'LOCAL_ONLY=true\n' > "$managed_dir/.env.local"
    printf 'docker\n' > "$managed_dir/HOST_MODE"
    printf 'portico_dev\n' > "$managed_dir/UPDATE_CHANNEL"
    printf 'server: test\n' > "$managed_dir/mcp-configs-user/test.yml"
    printf '{"token":"secret"}\n' > "$managed_dir/mcpo-google-oauth-tokens/token.json"
    printf '{}\n' > "$managed_dir/mcp_toggles.json"
    printf '{}\n' > "$managed_dir/mcp_tools_config.json"
    printf '{}\n' > "$managed_dir/marketplaces.json"
    printf 'bulk upload\n' > "$managed_dir/open-webui-data/uploads/file.bin"
    printf 'workspace\n' > "$managed_dir/workspaces/data.txt"
    printf 'artifact\n' > "$managed_dir/artifact-snapshots/data.txt"
    printf 'skill\n' > "$managed_dir/skills/data.txt"
    printf '{"buildNumber":"old-build"}\n' > "$managed_dir/electron-app/build-info.json"

    if command -v sqlite3 >/dev/null 2>&1; then
      sqlite3 "$managed_dir/open-webui-data/webui.db" \
        "CREATE TABLE messages (body TEXT); INSERT INTO messages VALUES ('preserved chat');"
    else
      printf 'sqlite fallback fixture\n' > "$managed_dir/open-webui-data/webui.db"
    fi

    local index
    for index in 100 101 102 103 104 105; do
      printf 'old snapshot %s\n' "$index" > "$snapshot_dir/webui.db.$index"
    done
    for index in $(seq 1 501); do
      printf '{"old":%s}\n' "$index" >> "$history_file"
    done

    mkdir -p \
      "$tmp_dir/reconcile-tmp/managed-runtime-reconcile.old" \
      "$tmp_dir/reconcile-tmp/managed-runtime-reconcile.recent" \
      "$tmp_dir/reconcile-tmp/unrelated.old" \
      "$tmp_dir/reconcile-tmp/nested/managed-runtime-reconcile.nested"
    touch -t 202001010000 \
      "$tmp_dir/reconcile-tmp/managed-runtime-reconcile.old" \
      "$tmp_dir/reconcile-tmp/unrelated.old" \
      "$tmp_dir/reconcile-tmp/nested/managed-runtime-reconcile.nested"
    TMPDIR="$tmp_dir/reconcile-tmp"
    export TMPDIR

    create_payload_zip "$tmp_dir" "$payload_zip"
    checksum="$(shasum -a 256 "$payload_zip" | awk '{print tolower($1)}')"
    file_size="$(wc -c < "$payload_zip" | tr -d '[:space:]')"
    output="$(run_prepare_update "$tmp_dir" "0" "$payload_zip" "$checksum" "$file_size" 2>&1)" \
      || fail "prepare-update-cloudsmith.sh failed to create a slim backup"

    [ ! -e "$tmp_dir/stage/download/extract" ] \
      || fail "extracted payload should be renamed into place instead of retained as a second full tree"
    [ -f "$tmp_dir/stage/payload/release-manifest.json" ] \
      || fail "renamed payload should retain the staged release manifest"

    backup_zip="$(find "$(cd "$tmp_dir/stage/backup" && pwd -P)" -maxdepth 1 -type f -name 'portico_full_backup_*.zip' -print | head -n 1)"
    [ -s "$backup_zip" ] || fail "expected a nonempty slim configuration backup"
    zip_entries="$(unzip -Z1 "$backup_zip")"
    for expected in \
      .env \
      .env.local \
      HOST_MODE \
      UPDATE_CHANNEL \
      mcp-configs-user/test.yml \
      mcpo-google-oauth-tokens/token.json \
      mcp_toggles.json \
      mcp_tools_config.json \
      marketplaces.json \
      slim-backup-manifest.txt; do
      printf '%s\n' "$zip_entries" | grep -Fxq "$expected" \
        || fail "expected slim backup to include $expected"
    done
    for excluded in open-webui-data workspaces artifact-snapshots skills backup; do
      if printf '%s\n' "$zip_entries" | grep -Eq "^${excluded}(/|$)"; then
        fail "slim backup should exclude bulk path: $excluded"
      fi
    done

    case "$output" in
      *"[UPDATE_PREP:BACKUP_FILE:${backup_zip}]"* ) ;;
      * ) fail "slim backup did not preserve the BACKUP_FILE marker contract" ;;
    esac
    case "$output" in
      *"[UPDATE_PREP:BACKUP_SIZE:"* ) ;;
      * ) fail "slim backup did not preserve the BACKUP_SIZE marker contract" ;;
    esac
    grep -Fq "\"fullBackupPath\": \"${backup_zip}\"" "$tmp_dir/stage/manifest.json" \
      || fail "prepared manifest did not retain the fullBackupPath compatibility field"

    snapshot_count="$(find "$snapshot_dir" -maxdepth 1 -type f -name 'webui.db.*' | wc -l | tr -d '[:space:]')"
    [ "$snapshot_count" = "5" ] \
      || fail "expected independent database snapshot retention of five, saw $snapshot_count"
    snapshot_path="$(find "$snapshot_dir" -maxdepth 1 -type f -name 'webui.db.*' | LC_ALL=C sort -r | head -n 1)"
    [ -s "$snapshot_path" ] || fail "expected a nonempty database snapshot"
    if command -v sqlite3 >/dev/null 2>&1; then
      [ "$(sqlite3 "$snapshot_path" 'SELECT body FROM messages;')" = "preserved chat" ] \
        || fail "sqlite snapshot did not preserve database contents"
      [ "$(sqlite3 "$snapshot_path" 'PRAGMA integrity_check;')" = "ok" ] \
        || fail "sqlite snapshot failed integrity_check"
    else
      cmp -s "$managed_dir/open-webui-data/webui.db" "$snapshot_path" \
        || fail "fallback database snapshot did not preserve database bytes"
    fi

    [ ! -e "$tmp_dir/reconcile-tmp/managed-runtime-reconcile.old" ] \
      || fail "stale direct reconcile strand should be removed before preparation"
    [ -d "$tmp_dir/reconcile-tmp/managed-runtime-reconcile.recent" ] \
      || fail "recent reconcile strand should be retained"
    [ -d "$tmp_dir/reconcile-tmp/unrelated.old" ] \
      || fail "stale sweep should preserve unrelated directories"
    [ -d "$tmp_dir/reconcile-tmp/nested/managed-runtime-reconcile.nested" ] \
      || fail "stale sweep must not recurse below TMPDIR"

    history_count="$(wc -l < "$history_file" | tr -d '[:space:]')"
    [ "$history_count" = "500" ] \
      || fail "expected prepare history retention to cap at 500 lines, saw $history_count"
    tail -n 1 "$history_file" | grep -Eq \
      '^\{"ts":"[^"]+","from":"old-build","to":"03162026-deadbeef","step":"complete","result":"ok","freeDiskKb":[0-9]+\}$' \
      || fail "expected a successful, bounded prepare ledger record"
  )
}

test_prepare_update_db_snapshot_falls_back_when_sqlite_backup_fails() {
  (
    local tmp_dir payload_zip checksum file_size managed_dir snapshot_path
    tmp_dir="$(mktemp -d)"
    payload_zip="$tmp_dir/payload.zip"
    managed_dir="$tmp_dir/home/portico/portico-managed"
    mkdir -p "$managed_dir/open-webui-data" "$tmp_dir/bin"
    printf 'CONFIG=true\n' > "$managed_dir/.env"
    printf 'database bytes that must survive\n' > "$managed_dir/open-webui-data/webui.db"
    cat > "$tmp_dir/bin/sqlite3" <<'SH'
#!/usr/bin/env bash
exit 1
SH
    chmod +x "$tmp_dir/bin/sqlite3"

    create_payload_zip "$tmp_dir" "$payload_zip"
    checksum="$(shasum -a 256 "$payload_zip" | awk '{print tolower($1)}')"
    file_size="$(wc -c < "$payload_zip" | tr -d '[:space:]')"
    run_prepare_update "$tmp_dir" "0" "$payload_zip" "$checksum" "$file_size" >/dev/null \
      || fail "prepare update did not fall back after sqlite3 snapshot failure"

    snapshot_path="$(find "$managed_dir/backup/db-snapshots" -maxdepth 1 -type f -name 'webui.db.*' -print | head -n 1)"
    [ -s "$snapshot_path" ] || fail "fallback snapshot was not created"
    cmp -s "$managed_dir/open-webui-data/webui.db" "$snapshot_path" \
      || fail "fallback snapshot did not preserve source bytes"
  )
}

test_prepare_update_records_failed_attempt_in_ledger() {
  (
    local tmp_dir payload_zip checksum file_size managed_dir history_file
    tmp_dir="$(mktemp -d)"
    payload_zip="$tmp_dir/payload.zip"
    managed_dir="$tmp_dir/home/portico/portico-managed"
    history_file="$managed_dir/health-status/update-history.jsonl"
    mkdir -p "$managed_dir/electron-app"
    printf 'CONFIG=true\n' > "$managed_dir/.env"
    printf '{"buildNumber":"old-build"}\n' > "$managed_dir/electron-app/build-info.json"

    create_payload_zip "$tmp_dir" "$payload_zip"
    checksum="$(shasum -a 256 "$payload_zip" | awk '{print tolower($1)}')"
    file_size="$(wc -c < "$payload_zip" | tr -d '[:space:]')"
    if run_prepare_update "$tmp_dir" "22" "$payload_zip" "$checksum" "$file_size" >/dev/null 2>&1; then
      fail "expected simulated download failure while testing prepare ledger"
    fi

    [ "$(wc -l < "$history_file" | tr -d '[:space:]')" = "1" ] \
      || fail "failed prepare attempt should append exactly one ledger record"
    grep -Eq \
      '^\{"ts":"[^"]+","from":"old-build","to":"03162026-deadbeef","step":"download","result":"fail","freeDiskKb":[0-9]+\}$' \
      "$history_file" \
      || fail "failed prepare attempt should record its failing step and result"
  )
}

test_prepare_update_renames_single_extracted_root_without_leaving_copy() {
  (
    local tmp_dir payload_zip wrapped_dir checksum file_size
    tmp_dir="$(mktemp -d)"
    payload_zip="$tmp_dir/payload.zip"
    wrapped_dir="$tmp_dir/wrapped"
    create_payload_zip "$tmp_dir" "$payload_zip"
    mkdir -p "$wrapped_dir/release-root"
    (
      cd "$wrapped_dir/release-root" &&
      unzip -q "$payload_zip"
    )
    rm -f "$payload_zip"
    (
      cd "$wrapped_dir" &&
      zip -qr "$payload_zip" release-root
    )

    checksum="$(shasum -a 256 "$payload_zip" | awk '{print tolower($1)}')"
    file_size="$(wc -c < "$payload_zip" | tr -d '[:space:]')"
    run_prepare_update "$tmp_dir" "0" "$payload_zip" "$checksum" "$file_size" >/dev/null \
      || fail "prepare update rejected a payload with one extracted root"

    [ -f "$tmp_dir/stage/payload/release-manifest.json" ] \
      || fail "single extracted root should be renamed to the payload directory"
    [ ! -e "$tmp_dir/stage/download/extract" ] \
      || fail "single-root finalization should remove the empty extraction directory"
  )
}

prepare_update_test_functions=(
  test_prepare_update_retries_transient_download_failures
  test_prepare_update_accepts_matching_custom_channel_identity
  test_prepare_update_does_not_retry_non_retryable_download_failures
  test_prepare_update_emits_machine_readable_error_after_retry_exhaustion
  test_prepare_update_reports_http_status_for_refused_download
  test_prepare_update_accepts_artifacts_that_pass_all_client_trust_checks
  test_prepare_update_reports_missing_command_line_tools_before_trust_checks
  test_prepare_update_reports_unresolvable_stapler_as_incomplete_command_line_tools
  test_prepare_update_does_not_mask_codesign_failure
  test_prepare_update_accepts_unsigned_dmg_for_client_prep
  test_prepare_update_rejects_empty_dmg_placeholder
  test_prepare_update_treats_transient_app_stapler_timeout_as_advisory
  test_prepare_update_rejects_non_transient_app_stapler_failure
  test_prepare_update_rejects_unclassified_app_stapler_timeout
  test_prepare_update_creates_slim_backup_db_snapshot_and_ledger
  test_prepare_update_db_snapshot_falls_back_when_sqlite_backup_fails
  test_prepare_update_records_failed_attempt_in_ledger
  test_prepare_update_renames_single_extracted_root_without_leaving_copy
)
prepare_update_shared_fixture_path="$(mktemp -d)"
create_payload_zip \
  "$prepare_update_shared_fixture_path" \
  "$prepare_update_shared_fixture_path/payload.zip"
mkdir -p "$prepare_update_shared_fixture_path/bin"
create_fake_curl "$prepare_update_shared_fixture_path/bin"
create_fake_sleep "$prepare_update_shared_fixture_path/bin"
create_fake_signature_tools "$prepare_update_shared_fixture_path/bin"
PREPARE_UPDATE_SHARED_FIXTURE="$prepare_update_shared_fixture_path"
trap 'rm -rf "$prepare_update_shared_fixture_path"' EXIT
run_shell_test_functions_parallel \
  "${PREPARE_UPDATE_TEST_CONCURRENCY:-8}" \
  "${prepare_update_test_functions[@]}"

echo "PASS: prepare-update-cloudsmith shell tests"
