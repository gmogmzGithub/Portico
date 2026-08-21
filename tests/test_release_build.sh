#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RELEASE_BUILD_SCRIPT="$PROJECT_ROOT/release_build.sh"
COMPATIBILITY_RELEASE_SCRIPT="$PROJECT_ROOT/release_beta_build.sh"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

test_autodetect_payload_zip_prefers_newest_matching_channel() {
  (
    source "$RELEASE_BUILD_SCRIPT"

    local tmp_dir release_dir
    tmp_dir="$(mktemp -d)"
    SCRIPT_DIR="$tmp_dir"
    release_dir="$SCRIPT_DIR/release"
    mkdir -p "$release_dir"

    : > "$release_dir/portico-03102026-aaaaaaaa.zip"
    : > "$release_dir/portico_dev-03102026-bbbbbbbb.zip"
    : > "$release_dir/portico_dev-03112026-cccccccc.zip"

    touch -t 202603110100 "$release_dir/portico-03102026-aaaaaaaa.zip"
    touch -t 202603110200 "$release_dir/portico_dev-03102026-bbbbbbbb.zip"
    touch -t 202603110300 "$release_dir/portico_dev-03112026-cccccccc.zip"

    CHANNEL="dev"
    CHANNEL_EXPLICIT=true

    autodetect_payload_zip

    [ "$PAYLOAD_ZIP" = "$release_dir/portico_dev-03112026-cccccccc.zip" ] || fail "autodetect_payload_zip did not choose the newest matching dev zip"

    rm -rf "$tmp_dir"
  )
}

test_custom_payload_name_inference_and_channel_mismatch_rejection() {
  (
    source "$RELEASE_BUILD_SCRIPT"

    local tmp_dir parsed output status
    tmp_dir="$(mktemp -d)"
    PAYLOAD_ZIP="$tmp_dir/portico_team-alpha-06232026-deadbeef.zip"
    : > "$PAYLOAD_ZIP"

    parsed="$(parse_payload_basename "$(basename "$PAYLOAD_ZIP")")"
    [ "$parsed" = $'portico_team-alpha\t06232026-deadbeef' ] \
      || fail "custom payload basename was not inferred"

    CHANNEL=""
    parse_payload_name
    validate_channel_match
    [ "$CHANNEL" = "team-alpha" ] || fail "custom logical channel was not inferred"

    CHANNEL="team-beta"
    set +e
    output="$(validate_channel_match 2>&1)"
    status=$?
    set -e
    [ "$status" -ne 0 ] || fail "custom channel mismatch was accepted"
    printf '%s' "$output" | grep -q 'does not match requested channel' \
      || fail "custom mismatch rejection was not explicit"

    ! parse_payload_basename "portico_-bad-06232026-deadbeef.zip" >/dev/null 2>&1 \
      || fail "unsafe custom package basename was accepted"
    rm -rf "$tmp_dir"
  )
}

test_compatibility_wrapper_forwards_custom_channel() {
  local tmp_dir build_id expected_zip
  tmp_dir="$(mktemp -d)"
  build_id="06232026-deadbeef"
  expected_zip="$tmp_dir/release/portico_team-alpha-${build_id}.zip"
  mkdir -p "$tmp_dir/src/scripts" "$tmp_dir/release"
  cp "$COMPATIBILITY_RELEASE_SCRIPT" "$tmp_dir/release_beta_build.sh"
  cp "$PROJECT_ROOT/src/scripts/release-channel.sh" "$tmp_dir/src/scripts/release-channel.sh"

  cat > "$tmp_dir/package_for_release.sh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" > "$SCRIPT_TEST_DIR/package-args"
SH
  cat > "$tmp_dir/release_build.sh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" > "$SCRIPT_TEST_DIR/release-args"
SH

  SCRIPT_TEST_DIR="$tmp_dir" bash "$tmp_dir/release_beta_build.sh" \
    "$build_id" --channel " Team-Alpha "

  grep -Fq "$build_id --channel team-alpha" "$tmp_dir/package-args" \
    || fail "compatibility wrapper did not forward the normalized custom channel to packaging"
  grep -Fq "$expected_zip --channel team-alpha" "$tmp_dir/release-args" \
    || fail "compatibility wrapper did not infer the canonical custom ZIP"
  rm -rf "$tmp_dir"
}

test_confirm_inferred_inputs_prompts_for_autodetected_zip_and_derived_channel() {
  (
    source "$RELEASE_BUILD_SCRIPT"

    local log_file
    log_file="$(mktemp)"

    PAYLOAD_ZIP="/tmp/release/portico_dev-03112026-cccccccc.zip"
    BUILD_ID="03112026-cccccccc"
    CHANNEL="dev"
    PAYLOAD_EXPLICIT=false
    CHANNEL_EXPLICIT=false

    require_interactive_prompt_capability() { :; }
    confirm_yes_no() {
      printf '%s\n' "$1" >> "$log_file"
      return 0
    }

    confirm_inferred_inputs

    grep -q "Use autodetected payload zip" "$log_file" || fail "zip confirmation prompt was not issued"
    grep -q "Upload this payload to the dev channel" "$log_file" || fail "channel confirmation prompt was not issued"

    rm -f "$log_file"
  )
}

test_confirm_inferred_inputs_fails_without_interactive_prompt_capability() {
  (
    source "$RELEASE_BUILD_SCRIPT"

    PAYLOAD_ZIP="/tmp/release/portico_dev-03112026-cccccccc.zip"
    BUILD_ID="03112026-cccccccc"
    CHANNEL="dev"
    PAYLOAD_EXPLICIT=false
    CHANNEL_EXPLICIT=false

    require_interactive_prompt_capability() { return 1; }

    ! confirm_inferred_inputs || fail "confirm_inferred_inputs should fail when prompting is required without a TTY"
  )
}

test_yes_accepts_inferred_inputs_without_a_tty() {
  (
    source "$RELEASE_BUILD_SCRIPT"

    parse_args --channel dev --yes

    PAYLOAD_ZIP="/tmp/release/portico_dev-03112026-cccccccc.zip"
    BUILD_ID="03112026-cccccccc"
    CHANNEL="dev"
    PAYLOAD_EXPLICIT=false

    require_interactive_prompt_capability() {
      fail "--yes should not require an interactive terminal"
    }
    confirm_yes_no() {
      fail "--yes should not prompt"
    }

    confirm_inferred_inputs

    [ "$ASSUME_YES" = true ] || fail "--yes was not parsed"
    [ "$CHANNEL_EXPLICIT" = true ] || fail "--channel should remain explicit"
  )
}

test_macos_payload_validation_raises_open_file_limit() {
  (
    source "$RELEASE_BUILD_SCRIPT"

    local requested_limit=""
    uname() { printf '%s\n' Darwin; }
    ulimit() {
      [ "$1" = "-Sn" ] || fail "unexpected ulimit arguments: $*"
      requested_limit="${2:-}"
      return 0
    }

    ensure_macos_validation_open_file_limit

    [ "$requested_limit" = "unlimited" ] \
      || fail "macOS release validation did not raise its soft open-file limit"
  )
}

test_main_validates_payload_before_credentials_or_upload() {
  (
    source "$RELEASE_BUILD_SCRIPT"

    local tmp_dir log_file output status
    tmp_dir="$(mktemp -d)"
    log_file="$tmp_dir/order.log"
    PAYLOAD_ZIP="$tmp_dir/portico_dev-03112026-cccccccc.zip"
    : > "$PAYLOAD_ZIP"

    parse_args() { :; }
    parse_payload_name() {
      CHANNEL_PACKAGE_NAME="portico_dev"
      BUILD_ID="03112026-cccccccc"
    }
    validate_channel_match() { CHANNEL="dev"; }
    confirm_inferred_inputs() { :; }
    validate_payload_integrity() {
      printf '%s\n' validator >> "$log_file"
      return 23
    }
    validate_credentials() { printf '%s\n' credentials >> "$log_file"; }
    prepare_replace() { printf '%s\n' replace >> "$log_file"; }
    upload_to_cloudsmith() { printf '%s\n' upload >> "$log_file"; }

    set +e
    output="$(set -e; main 2>&1)"
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "main should reject an invalid payload"
    [ "$(cat "$log_file")" = "validator" ] \
      || fail "credentials or upload work ran before payload validation"

    rm -rf "$tmp_dir"
  )
}

test_validate_payload_integrity_rejects_invalid_zip_before_upload() {
  (
    source "$RELEASE_BUILD_SCRIPT"

    local tmp_dir output status
    tmp_dir="$(mktemp -d)"
    PAYLOAD_ZIP="$tmp_dir/portico_dev-03112026-cccccccc.zip"
    CHANNEL_PACKAGE_NAME="portico_dev"
    BUILD_ID="03112026-cccccccc"
    printf '%s\n' 'not a zip' > "$PAYLOAD_ZIP"

    set +e
    output="$(validate_payload_integrity 2>&1)"
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "invalid ZIP should fail shared payload validation"
    printf '%s' "$output" | grep -q 'nothing was uploaded' \
      || fail "invalid ZIP rejection did not state that upload was skipped"

    rm -rf "$tmp_dir"
  )
}

test_cloudsmith_sync_wait_is_required() {
  (
    source "$RELEASE_BUILD_SCRIPT"

    local tmp_dir cloudsmith_log
    tmp_dir="$(mktemp -d)"
    cloudsmith_log="$tmp_dir/cloudsmith-args"
    PAYLOAD_ZIP="$tmp_dir/portico_dev-03112026-cccccccc.zip"
    CHANNEL_PACKAGE_NAME="portico_dev"
    BUILD_ID="03112026-cccccccc"
    CLOUDSMITH_API_KEY="test-cloudsmith-key"
    : > "$PAYLOAD_ZIP"

    ensure_cloudsmith_cli() { :; }
    cloudsmith() { printf '%s\n' "$*" > "$cloudsmith_log"; }

    [ "$WAIT_FOR_SYNC" = true ] || fail "publication does not wait for synchronization by default"
    [ "$MARK_UPDATE_READY" = true ] || fail "publication does not verify readiness by default"
    upload_to_cloudsmith "$(basename "$PAYLOAD_ZIP")"
    if grep -Fq -- "--no-wait-for-sync" "$cloudsmith_log"; then
      fail "publication disabled the required Cloudsmith synchronization wait"
    fi

    rm -rf "$tmp_dir"
  )
}

test_cloudsmith_sync_failure_stops_publication() {
  (
    source "$RELEASE_BUILD_SCRIPT"

    local tmp_dir output status
    tmp_dir="$(mktemp -d)"
    PAYLOAD_ZIP="$tmp_dir/portico_dev-03112026-cccccccc.zip"
    CHANNEL_PACKAGE_NAME="portico_dev"
    BUILD_ID="03112026-cccccccc"
    : > "$PAYLOAD_ZIP"

    ensure_cloudsmith_cli() { :; }
    cloudsmith() { return 1; }

    set +e
    output="$(upload_to_cloudsmith "$(basename "$PAYLOAD_ZIP")" 2>&1)"
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "publication continued after Cloudsmith synchronization failed"
    printf '%s' "$output" | grep -Fq "Cloudsmith upload failed" \
      || fail "synchronization failure did not stop publication"
    rm -rf "$tmp_dir"
  )
}

test_package_lookup_uses_permanent_cloudsmith_identifier() {
  (
    source "$RELEASE_BUILD_SCRIPT"

    cloudsmith() {
      cat <<'JSON'
{"data":[{"filename":"portico_dev-03112026-cccccccc.zip","slug":"temporary-slug","slug_perm":"permanent-slug","identifier_perm":"permanent-identifier","uploader":"release-user","self_html_url":"https://example.test/package","cdn_url":"https://downloads.example.test/basic/portico/raw/names/portico_dev/versions/03112026-cccccccc/portico_dev-03112026-cccccccc.zip","tags":{"custom":["portico-update-ready-v1"]},"tags_immutable":{"custom":["portico-update-ready-v1"]},"checksum_sha256":"abcdef"}]}
JSON
    }

    local package_record package_slug package_ready package_checksum package_cdn_url
    package_record="$(find_existing_cloudsmith_package \
      "portico_dev" \
      "03112026-cccccccc" \
      "portico_dev-03112026-cccccccc.zip")"
    IFS=$'\x1f' read -r package_slug _ _ _ package_ready package_checksum package_cdn_url <<< "$package_record"

    [ "$package_slug" = "permanent-slug" ] \
      || fail "package lookup did not select Cloudsmith's permanent slug"
    [ "$package_ready" = true ] \
      || fail "package lookup did not recognize the update-ready marker"
    [ "$package_checksum" = abcdef ] \
      || fail "package lookup did not preserve the Cloudsmith SHA-256"
    [ "$package_cdn_url" = "https://downloads.example.test/basic/portico/raw/names/portico_dev/versions/03112026-cccccccc/portico_dev-03112026-cccccccc.zip" ] \
      || fail "package lookup did not preserve the client download URL"
  )
}

test_package_lookup_requires_immutable_ready_marker() {
  (
    source "$RELEASE_BUILD_SCRIPT"

    cloudsmith() {
      cat <<'JSON'
{"data":[{"filename":"portico_dev-03112026-cccccccc.zip","slug_perm":"permanent-slug","tags":{"custom":["portico-update-ready-v1"]},"tags_immutable":{"custom":[]}}]}
JSON
    }

    local package_record package_ready
    package_record="$(find_existing_cloudsmith_package \
      "portico_dev" \
      "03112026-cccccccc" \
      "portico_dev-03112026-cccccccc.zip")"
    IFS=$'\x1f' read -r _ _ _ _ package_ready _ _ <<< "$package_record"

    [ "$package_ready" = false ] \
      || fail "package lookup accepted a mutable update-ready marker"
  )
}

test_client_download_url_matches_updater_behavior() {
  (
    source "$RELEASE_BUILD_SCRIPT"

    CLOUDSMITH_ENTITLEMENT_TOKEN="entitlement-token"
    CLOUDSMITH_DL_BASE="https://downloads.example.test"
    CLOUDSMITH_OWNER="portico"
    CLOUDSMITH_REPO="portico"

    local cdn_url resolved_url
    cdn_url="https://cdn.example.test/basic/portico/raw/names/portico_dev/versions/03112026-cccccccc/payload.zip"
    resolved_url="$(build_client_download_url \
      "$cdn_url" \
      "portico_dev" \
      "03112026-cccccccc" \
      "payload.zip")"
    [ "$resolved_url" = "https://cdn.example.test/entitlement-token/portico/raw/names/portico_dev/versions/03112026-cccccccc/payload.zip" ] \
      || fail "release verification did not use the client CDN URL with entitlement substitution"

    resolved_url="$(build_client_download_url \
      "https://cdn.example.test/not-a-raw-package.zip" \
      "portico_dev" \
      "03112026-cccccccc" \
      "payload.zip")"
    [ "$resolved_url" = "https://downloads.example.test/entitlement-token/portico/raw/names/portico_dev/versions/03112026-cccccccc/payload.zip" ] \
      || fail "release verification did not fall back to the canonical client URL"
  )
}

configure_verification_fixture() {
  VERIFY_TMP="$(mktemp -d)"
  VERIFY_CURL_COUNT="$VERIFY_TMP/curl-count"
  VERIFY_CLOUDSMITH_LOG="$VERIFY_TMP/cloudsmith-args"
  VERIFY_HTTP_CODES="$VERIFY_TMP/http-codes"
  VERIFY_DOWNLOAD_SOURCE=""
  VERIFY_TAG_FAIL=false
  VERIFY_TAG_CONFIRMS=true
  VERIFY_PACKAGE_READY=false
  PAYLOAD_ZIP="$VERIFY_TMP/portico_dev-03112026-cccccccc.zip"
  CHANNEL_PACKAGE_NAME="portico_dev"
  CLOUDSMITH_OWNER="portico"
  CLOUDSMITH_REPO="portico"
  BUILD_ID="03112026-cccccccc"
  CLOUDSMITH_ENTITLEMENT_TOKEN="entitlement-token"
  CLOUDSMITH_DL_BASE="https://downloads.example.test"
  portico_CLOUDSMITH_READY_MAX_ATTEMPTS=3
  portico_CLOUDSMITH_READY_RETRY_DELAY_SECONDS=0
  printf 'signed release bytes\n' > "$PAYLOAD_ZIP"
  VERIFY_EXPECTED_CHECKSUM="$(sha256_file "$PAYLOAD_ZIP")"
  printf '0\n' > "$VERIFY_CURL_COUNT"

  find_existing_cloudsmith_package() {
    printf 'permanent-slug\x1frelease-user\x1ftrue\x1fhttps://example.test/package\x1f%s\x1f%s\n' \
      "$VERIFY_PACKAGE_READY" "$VERIFY_EXPECTED_CHECKSUM"
  }
  curl() {
    local output="" count status
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -o) output="$2"; shift 2 ;;
        -w|--connect-timeout|--max-time) shift 2 ;;
        -sS|-L) shift ;;
        *) shift ;;
      esac
    done
    count="$(cat "$VERIFY_CURL_COUNT")"
    count="$((count + 1))"
    printf '%s\n' "$count" > "$VERIFY_CURL_COUNT"
    status="$(sed -n "${count}p" "$VERIFY_HTTP_CODES")"
    [ -n "$status" ] || status="$(tail -1 "$VERIFY_HTTP_CODES")"
    if [ "$status" = 200 ] && [ -n "$VERIFY_DOWNLOAD_SOURCE" ]; then
      cp "$VERIFY_DOWNLOAD_SOURCE" "$output"
    else
      : > "$output"
    fi
    printf '%s' "$status"
  }
  cloudsmith() {
    printf '%s\n' "$*" > "$VERIFY_CLOUDSMITH_LOG"
    [ "$VERIFY_TAG_FAIL" != true ] || return 1
    if [ "$VERIFY_TAG_CONFIRMS" = true ]; then
      VERIFY_PACKAGE_READY=true
    fi
  }
  sleep() { :; }
}

test_verified_publication_retries_404_then_marks_exact_package() {
  (
    source "$RELEASE_BUILD_SCRIPT"
    configure_verification_fixture
    printf '404\n200\n' > "$VERIFY_HTTP_CODES"
    VERIFY_DOWNLOAD_SOURCE="$PAYLOAD_ZIP"

    verify_published_update "$(basename "$PAYLOAD_ZIP")"

    [ "$(cat "$VERIFY_CURL_COUNT")" = 2 ] || fail "publication did not retry the transient payload 404"
    grep -Fqx \
      "tags add portico/portico/permanent-slug portico-update-ready-v1 --immutable" \
      "$VERIFY_CLOUDSMITH_LOG" \
      || fail "publication did not add the immutable marker to the exact package slug"
    rm -rf "$VERIFY_TMP"
  )
}

test_verified_publication_exhausts_404_without_marker() {
  (
    source "$RELEASE_BUILD_SCRIPT"
    configure_verification_fixture
    printf '404\n404\n' > "$VERIFY_HTTP_CODES"
    portico_CLOUDSMITH_READY_MAX_ATTEMPTS=2

    local output status
    set +e
    output="$(verify_published_update "$(basename "$PAYLOAD_ZIP")" 2>&1)"
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "publication marked a payload that remained unavailable"
    [ "$(cat "$VERIFY_CURL_COUNT")" = 2 ] || fail "publication did not stop at the configured verification bound"
    printf '%s' "$output" | grep -Fq "did not become downloadable within" \
      || fail "publication exhaustion did not explain the readiness failure"
    [ ! -e "$VERIFY_CLOUDSMITH_LOG" ] || fail "publication added the marker after readiness exhaustion"
    rm -rf "$VERIFY_TMP"
  )
}

test_verified_publication_fails_fast_for_permanent_4xx() {
  (
    source "$RELEASE_BUILD_SCRIPT"
    configure_verification_fixture
    printf '400\n' > "$VERIFY_HTTP_CODES"

    local output status
    set +e
    output="$(verify_published_update "$(basename "$PAYLOAD_ZIP")" 2>&1)"
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "publication accepted a permanent payload HTTP failure"
    [ "$(cat "$VERIFY_CURL_COUNT")" = 1 ] || fail "publication retried a permanent payload HTTP failure"
    printf '%s' "$output" | grep -Fq "permanent HTTP 400" \
      || fail "publication did not classify a permanent 4xx failure"
    [ ! -e "$VERIFY_CLOUDSMITH_LOG" ] || fail "publication added the marker after a permanent HTTP failure"
    rm -rf "$VERIFY_TMP"
  )
}

test_verified_publication_rejects_downloaded_byte_mismatch() {
  (
    source "$RELEASE_BUILD_SCRIPT"
    configure_verification_fixture
    printf 'different bytes\n' > "$VERIFY_TMP/different.zip"
    printf '200\n' > "$VERIFY_HTTP_CODES"
    VERIFY_DOWNLOAD_SOURCE="$VERIFY_TMP/different.zip"

    local output status
    set +e
    output="$(verify_published_update "$(basename "$PAYLOAD_ZIP")" 2>&1)"
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "publication accepted downloaded bytes that differ from the signed ZIP"
    printf '%s' "$output" | grep -Eq "size does not match|SHA-256 does not match" \
      || fail "publication byte mismatch did not identify the integrity failure"
    [ ! -e "$VERIFY_CLOUDSMITH_LOG" ] || fail "publication added the marker after an integrity failure"
    rm -rf "$VERIFY_TMP"
  )
}

test_verified_publication_requires_marker_confirmation() {
  (
    source "$RELEASE_BUILD_SCRIPT"
    configure_verification_fixture
    printf '200\n' > "$VERIFY_HTTP_CODES"
    VERIFY_DOWNLOAD_SOURCE="$PAYLOAD_ZIP"
    VERIFY_TAG_CONFIRMS=false

    local output status
    set +e
    output="$(verify_published_update "$(basename "$PAYLOAD_ZIP")" 2>&1)"
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "publication succeeded without observing its readiness marker"
    printf '%s' "$output" | grep -Fq "did not confirm the update-ready marker" \
      || fail "publication did not explain marker confirmation failure"
    rm -rf "$VERIFY_TMP"
  )
}

test_verified_publication_stops_when_marker_mutation_fails() {
  (
    source "$RELEASE_BUILD_SCRIPT"
    configure_verification_fixture
    printf '200\n' > "$VERIFY_HTTP_CODES"
    VERIFY_DOWNLOAD_SOURCE="$PAYLOAD_ZIP"
    VERIFY_TAG_FAIL=true

    local output status
    set +e
    output="$(verify_published_update "$(basename "$PAYLOAD_ZIP")" 2>&1)"
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "publication succeeded after marker mutation failed"
    printf '%s' "$output" | grep -Fq "Failed to mark the verified Cloudsmith package" \
      || fail "marker mutation failure was not reported"
    rm -rf "$VERIFY_TMP"
  )
}

test_ready_package_cannot_be_replaced_with_different_bytes() {
  (
    source "$RELEASE_BUILD_SCRIPT"

    local tmp_dir cloudsmith_log output status
    tmp_dir="$(mktemp -d)"
    cloudsmith_log="$tmp_dir/cloudsmith-args"
    PAYLOAD_ZIP="$tmp_dir/portico_dev-03112026-cccccccc.zip"
    CHANNEL_PACKAGE_NAME="portico_dev"
    BUILD_ID="03112026-cccccccc"
    REPUBLISH=true
    printf 'new signed release bytes\n' > "$PAYLOAD_ZIP"

    ensure_cloudsmith_cli() { :; }
    find_existing_cloudsmith_package() {
      printf 'permanent-slug\x1frelease-user\x1ftrue\x1furl\x1ftrue\x1f%s\n' \
        "$(printf '0%.0s' {1..64})"
    }
    cloudsmith() { printf '%s\n' "$*" > "$cloudsmith_log"; }

    set +e
    output="$(prepare_replace "$(basename "$PAYLOAD_ZIP")" 2>&1)"
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "ready package was replaceable under the same build id"
    printf '%s' "$output" | grep -Fq "cannot be replaced" \
      || fail "ready package replacement failure did not require a new build id"
    [ ! -e "$cloudsmith_log" ] || fail "ready package replacement reached Cloudsmith mutation"
    rm -rf "$tmp_dir"
  )
}

test_existing_exact_payload_resumes_without_reupload() {
  (
    source "$RELEASE_BUILD_SCRIPT"

    local tmp_dir cloudsmith_log
    tmp_dir="$(mktemp -d)"
    cloudsmith_log="$tmp_dir/cloudsmith-args"
    PAYLOAD_ZIP="$tmp_dir/portico_dev-03112026-cccccccc.zip"
    CHANNEL_PACKAGE_NAME="portico_dev"
    BUILD_ID="03112026-cccccccc"
    printf 'signed release bytes\n' > "$PAYLOAD_ZIP"

    ensure_cloudsmith_cli() { :; }
    find_existing_cloudsmith_package() {
      printf 'permanent-slug\x1frelease-user\x1ftrue\x1furl\x1ffalse\x1f%s\x1fcdn\n' \
        "$(sha256_file "$PAYLOAD_ZIP")"
    }
    cloudsmith() { printf '%s\n' "$*" > "$cloudsmith_log"; }

    prepare_replace "$(basename "$PAYLOAD_ZIP")"

    [ "$SKIP_UPLOAD" = true ] \
      || fail "matching unverified payload did not resume readiness verification"
    [ ! -e "$cloudsmith_log" ] \
      || fail "matching unverified payload was deleted or reuploaded"
    rm -rf "$tmp_dir"
  )
}

test_autodetect_payload_zip_prefers_newest_matching_channel
test_custom_payload_name_inference_and_channel_mismatch_rejection
test_compatibility_wrapper_forwards_custom_channel
test_confirm_inferred_inputs_prompts_for_autodetected_zip_and_derived_channel
test_confirm_inferred_inputs_fails_without_interactive_prompt_capability
test_yes_accepts_inferred_inputs_without_a_tty
test_macos_payload_validation_raises_open_file_limit
test_main_validates_payload_before_credentials_or_upload
test_validate_payload_integrity_rejects_invalid_zip_before_upload
test_cloudsmith_sync_wait_is_required
test_cloudsmith_sync_failure_stops_publication
test_package_lookup_uses_permanent_cloudsmith_identifier
test_package_lookup_requires_immutable_ready_marker
test_client_download_url_matches_updater_behavior
test_verified_publication_retries_404_then_marks_exact_package
test_verified_publication_exhausts_404_without_marker
test_verified_publication_fails_fast_for_permanent_4xx
test_verified_publication_rejects_downloaded_byte_mismatch
test_verified_publication_requires_marker_confirmation
test_verified_publication_stops_when_marker_mutation_fails
test_ready_package_cannot_be_replaced_with_different_bytes
test_existing_exact_payload_resumes_without_reupload

echo "PASS: release_build shell tests"
