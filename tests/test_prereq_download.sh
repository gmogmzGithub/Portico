#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PREREQ_SCRIPT="$PROJECT_ROOT/src/scripts/prereq-download.sh"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

array_has_exact_value() {
  local needle="$1"
  shift

  local item=""
  for item in "$@"; do
    if [ "$item" = "$needle" ]; then
      return 0
    fi
  done

  return 1
}

test_source_does_not_execute_main() {
  local output
  output="$(bash -c 'set -euo pipefail; source "$1"; echo sourced-ok' bash "$PREREQ_SCRIPT")"
  [ "$output" = "sourced-ok" ] || fail "sourcing prereq-download.sh executed main()"
}

test_refresh_managed_build_info_preserves_release_runtime_image_tag() {
  (
    source "$PREREQ_SCRIPT"

    exec 9>/dev/null
    LOG_FD=9

    local tmp_dir build_info release_manifest docker_image_tag full_sha
    tmp_dir="$(mktemp -d)"
    build_info="$tmp_dir/managed/electron-app/build-info.json"
    release_manifest="$tmp_dir/release-manifest.json"
    mkdir -p "$(dirname "$build_info")"

    cat > "$build_info" <<'EOF'
{
  "buildNumber": "08042026-5826cf66",
  "fullSha": "5826cf664d0f9241d10628330ac1d6a11d59b95a",
  "channel": "portico_mr-277"
}
EOF
    cat > "$release_manifest" <<'EOF'
{
  "buildNumber": "08042026-5826cf66",
  "dockerImageTag": "mr-277-5826cf664d0f9241d10628330ac1d6a11d59b95a"
}
EOF

    refresh_managed_build_info \
      "$build_info" \
      "$release_manifest" \
      "08042026-5826cf66" \
      "5826cf66" \
      "08042026" \
      "portico_mr-277" \
      "2026-08-04T10:00:00.000Z"

    docker_image_tag="$(json_get_string "$build_info" "dockerImageTag")"
    full_sha="$(json_get_string "$build_info" "fullSha")"
    [ "$docker_image_tag" = "mr-277-5826cf664d0f9241d10628330ac1d6a11d59b95a" ] \
      || fail "managed build info did not retain the runtime image tag from the release manifest"
    [ "$full_sha" = "5826cf664d0f9241d10628330ac1d6a11d59b95a" ] \
      || fail "managed build info did not retain the matching full source revision"

    cat > "$build_info" <<'EOF'
{
  "buildNumber": "08032026-996e3784",
  "fullSha": "996e3784e996df3f376458fae265938beefc99cd",
  "dockerImageTag": "08032026-996e3784"
}
EOF

    refresh_managed_build_info \
      "$build_info" \
      "$release_manifest" \
      "08042026-5826cf66" \
      "5826cf66" \
      "08042026" \
      "portico_mr-277" \
      "2026-08-04T10:00:00.000Z"

    docker_image_tag="$(json_get_string "$build_info" "dockerImageTag")"
    full_sha="$(json_get_string "$build_info" "fullSha")"
    [ "$docker_image_tag" = "mr-277-5826cf664d0f9241d10628330ac1d6a11d59b95a" ] \
      || fail "managed build info retained a runtime image tag from a different build"
    [ "$full_sha" = "5826cf66" ] \
      || fail "managed build info retained a full source revision from a different build"

    printf '{"buildNumber":"08042026-5826cf66"}\n' > "$release_manifest"
    if (
      refresh_managed_build_info \
        "$build_info" \
        "$release_manifest" \
        "08042026-5826cf66" \
        "5826cf66" \
        "08042026" \
        "portico_mr-277" \
        "2026-08-04T10:00:00.000Z"
    ) >/dev/null 2>&1; then
      fail "release manifests without a runtime image tag must fail closed"
    fi
  )
}

test_create_slim_backup_excludes_bulk_user_data_and_snapshots_webui_db() {
  (
    source "$PREREQ_SCRIPT"

    exec 9>/dev/null
    LOG_FD=9

    local tmp_dir zip_entries snapshot_path snapshot_count index
    tmp_dir="$(mktemp -d)"
    MANAGED_DIR="$tmp_dir/managed"

    mkdir -p \
      "$MANAGED_DIR/backup/db-snapshots" \
      "$MANAGED_DIR/open-webui-data/uploads" \
      "$MANAGED_DIR/workspaces" \
      "$MANAGED_DIR/artifact-snapshots" \
      "$MANAGED_DIR/skills" \
      "$MANAGED_DIR/mcp-configs-user" \
      "$MANAGED_DIR/mcpo-test-oauth-tokens"
    printf 'CONFIG=true\n' > "$MANAGED_DIR/.env"
    printf 'docker\n' > "$MANAGED_DIR/HOST_MODE"
    printf 'server: test\n' > "$MANAGED_DIR/mcp-configs-user/test.yml"
    printf '{"token":"secret"}\n' > "$MANAGED_DIR/mcpo-test-oauth-tokens/token.json"
    printf 'database bytes that must survive\n' > "$MANAGED_DIR/open-webui-data/webui.db"
    printf 'bulk upload\n' > "$MANAGED_DIR/open-webui-data/uploads/file.bin"
    printf 'workspace\n' > "$MANAGED_DIR/workspaces/data.txt"
    printf 'artifact\n' > "$MANAGED_DIR/artifact-snapshots/data.txt"
    printf 'skill\n' > "$MANAGED_DIR/skills/data.txt"
    printf 'do not recurse\n' > "$MANAGED_DIR/backup/old.zip"
    for index in 100 101 102 103 104 105; do
      printf 'old snapshot %s\n' "$index" \
        > "$MANAGED_DIR/backup/db-snapshots/webui.db.$index"
    done

    create_slim_backup \
      || fail "create_slim_backup failed"

    [ -f "$FULL_BACKUP_ZIP_PATH" ] \
      || fail "create_slim_backup did not create a backup archive"

    zip_entries="$(
      python3 - "$FULL_BACKUP_ZIP_PATH" <<'PY'
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as zf:
    for name in zf.namelist():
        print(name)
PY
    )"

    for expected in \
      .env \
      HOST_MODE \
      mcp-configs-user/test.yml \
      mcpo-test-oauth-tokens/token.json \
      slim-backup-manifest.txt; do
      printf '%s\n' "$zip_entries" | grep -Fxq "$expected" \
        || fail "expected slim backup to include $expected"
    done
    for excluded in open-webui-data workspaces artifact-snapshots skills backup; do
      if printf '%s\n' "$zip_entries" | grep -Eq "^${excluded}(/|$)"; then
        fail "slim backup should exclude bulk path: $excluded"
      fi
    done

    snapshot_count="$(find "$MANAGED_DIR/backup/db-snapshots" -maxdepth 1 -type f -name 'webui.db.*' | wc -l | tr -d '[:space:]')"
    [ "$snapshot_count" = "5" ] \
      || fail "expected database snapshot retention of five, saw $snapshot_count"
    snapshot_path="$(find "$MANAGED_DIR/backup/db-snapshots" -maxdepth 1 -type f -name 'webui.db.*' | LC_ALL=C sort -r | head -n 1)"
    cmp -s "$MANAGED_DIR/open-webui-data/webui.db" "$snapshot_path" \
      || fail "database snapshot did not preserve source bytes"
  )
}

test_normalize_url_for_curl_unescapes_and_trims() {
  (
    source "$PREREQ_SCRIPT"

    exec 9>/dev/null
    LOG_FD=9

    local raw normalized
    raw=$'  https:\\/\\/dl.artifacts.example.invalid\\/TOKEN\\/portico/raw/names/test/versions/1/pkg.zip\r \n'
    normalized="$(normalize_url_for_curl "$raw")"

    [ "$normalized" = "https://dl.artifacts.example.invalid/TOKEN/portico/raw/names/test/versions/1/pkg.zip" ] \
      || fail "normalize_url_for_curl did not normalize the Cloudsmith URL"
  )
}

test_prepare_curl_checked_adds_dash_q_and_redacts_api_key_in_logs() {
  (
    source "$PREREQ_SCRIPT"

    exec 9>/dev/null
    LOG_FD=9

    local tmp_dir curl_wrapper rendered output
    tmp_dir="$(mktemp -d)"
    curl_wrapper="$tmp_dir/fake-curl"

    cat >"$curl_wrapper" <<'SH'
#!/usr/bin/env bash
printf 'curl-ok'
SH
    chmod +x "$curl_wrapper"

    CURL_BIN="$curl_wrapper"
    prepare_curl_checked "Cloudsmith API lookup" "https://dl.artifacts.example.invalid/TOKEN/portico/raw/names/test/versions/1/pkg.zip" -fsS -H "X-Api-Key: secret-value"
    output="$(run_prepared_curl)"
    rendered="$PREPARED_CURL_ARGV_LOG"

    [ "$output" = "curl-ok" ] || fail "run_curl_checked did not execute the fake curl"
    case "$rendered" in
      *" -q "*|"-q "* ) ;;
      * ) fail "run_curl_checked did not prepend -q" ;;
    esac
    case "$rendered" in
      *"X-Api-Key:\ \[REDACTED\]"* ) ;;
      * ) fail "curl command log did not redact X-Api-Key" ;;
    esac
    case "$rendered" in
      *"https://dl.artifacts.example.invalid/\[redacted\]"* ) ;;
      * ) fail "curl command log did not redact the entitlement-token URL" ;;
    esac
    case "$rendered" in
      *"/TOKEN/"* ) fail "curl command log leaked the entitlement token" ;;
    esac
  )
}

test_find_cloudsmith_package_metadata_reports_python_parser() {
  (
    local tmp_dir python3_path
    tmp_dir="$(mktemp -d)"
    python3_path="$(command -v python3 || true)"
    [ -n "$python3_path" ] || fail "python3 not available for parser test"

    ln -s "$python3_path" "$tmp_dir/python3"
    ln -s /usr/bin/sed "$tmp_dir/sed"
    ln -s /usr/bin/tr "$tmp_dir/tr"

    PATH="$tmp_dir:/bin:/usr/bin:/usr/sbin:/sbin"
    hash -r
    source "$PREREQ_SCRIPT"

    exec 9>/dev/null
    LOG_FD=9

    local payload result result_file
    result_file="$(/usr/bin/mktemp)"
    payload='[{"filename":"pkg.zip","version":"03162026-27c78cfb","cdn_url":"https://dl.artifacts.example.invalid/basic/portico/raw/names/portico_dev/versions/03162026-27c78cfb/pkg.zip","uploaded_at":"2026-03-16T18:35:54.992736Z","created_at":"2026-03-16T18:35:00.000000Z"}]'
    find_cloudsmith_package_metadata "$payload" "pkg.zip" > "$result_file"
    result="$(cat "$result_file")"

    [ "$PACKAGE_METADATA_PARSER" = "python3" ] || fail "expected python3 metadata parser in normal environment"
    [ -n "$result" ] || fail "python3 metadata parser did not return package metadata"
  )
}

test_find_cloudsmith_package_metadata_reports_perl_fallback_without_python3() {
  (
    local tmp_dir perl_path
    tmp_dir="$(mktemp -d)"
    perl_path="$(command -v perl || true)"
    [ -n "$perl_path" ] || fail "perl not available for fallback parser test"

    ln -s "$perl_path" "$tmp_dir/perl"
    ln -s /usr/bin/mktemp "$tmp_dir/mktemp"
    ln -s /usr/bin/sed "$tmp_dir/sed"
    ln -s /usr/bin/tr "$tmp_dir/tr"

    PATH="$tmp_dir:/bin:/usr/bin:/usr/sbin:/sbin"
    hash -r
    source "$PREREQ_SCRIPT"
    managed_runtime_resolve_python3() {
      return 1
    }

    exec 9>/dev/null
    LOG_FD=9

    local payload result result_file
    result_file="$(/usr/bin/mktemp)"
    payload='[{"filename":"pkg.zip","version":"03162026-27c78cfb","cdn_url":"https://dl.artifacts.example.invalid/basic/portico/raw/names/portico_dev/versions/03162026-27c78cfb/pkg.zip","uploaded_at":"2026-03-16T18:35:54.992736Z","created_at":"2026-03-16T18:35:00.000000Z"}]'
    find_cloudsmith_package_metadata "$payload" "pkg.zip" > "$result_file"
    result="$(cat "$result_file")"

    [ "$PACKAGE_METADATA_PARSER" = "perl" ] || fail "expected perl metadata parser when python3 is unavailable but perl is present"
    [ -n "$result" ] || fail "perl metadata parser did not return package metadata"
  )
}

test_find_cloudsmith_package_metadata_reports_sed_fallback() {
  (
    local tmp_dir
    tmp_dir="$(mktemp -d)"

    ln -s /usr/bin/sed "$tmp_dir/sed"
    ln -s /usr/bin/tr "$tmp_dir/tr"

    PATH="$tmp_dir:/bin:/usr/bin:/usr/sbin:/sbin"
    hash -r
    source "$PREREQ_SCRIPT"
    managed_runtime_resolve_python3() {
      return 1
    }
    perl() {
      return 127
    }

    exec 9>/dev/null
    LOG_FD=9

    local payload result result_file
    result_file="$(/usr/bin/mktemp)"
    payload='[{"filename":"pkg.zip","version":"03162026-27c78cfb","nested":{"version":"https://dl.artifacts.example.invalid/basic/portico/raw/names/portico_dev/versions/03162026-27c78cfb/pkg.zip"},"cdn_url":"https://dl.artifacts.example.invalid/basic/portico/raw/names/portico_dev/versions/03162026-27c78cfb/pkg.zip","uploaded_at":"2026-03-16T18:35:54.992736Z","created_at":"2026-03-16T18:35:00.000000Z"}]'
    find_cloudsmith_package_metadata "$payload" "pkg.zip" > "$result_file"
    result="$(cat "$result_file")"

    [ "$PACKAGE_METADATA_PARSER" = "sed" ] || fail "expected sed metadata parser when no working Python or Perl parser is available"
    [ -n "$result" ] || fail "sed metadata parser did not return package metadata"
    case "$result" in
      03162026-27c78cfb$'\t'* ) ;;
      * ) fail "sed metadata parser did not keep the top-level package version when nested version fields were present" ;;
    esac
    case "$result" in
      *"/versions/https://"* ) fail "sed metadata parser leaked a nested URL into the package version" ;;
    esac
  )
}

test_find_cloudsmith_package_metadata_ignores_broken_python3() {
  (
    local tmp_dir stderr_file
    tmp_dir="$(mktemp -d)"

    cat >"$tmp_dir/python3" <<'SH'
#!/usr/bin/env bash
printf 'xcode-select: note: No developer tools were found, requesting install.\n' >&2
exit 1
SH
    chmod +x "$tmp_dir/python3"
    ln -s /usr/bin/sed "$tmp_dir/sed"
    ln -s /usr/bin/tr "$tmp_dir/tr"

    PATH="$tmp_dir:/bin:/usr/bin:/usr/sbin:/sbin"
    hash -r
    source "$PREREQ_SCRIPT"
    managed_runtime_resolve_python3() {
      printf '%s\n' "$tmp_dir/python3"
      return 0
    }

    exec 9>/dev/null
    LOG_FD=9

    local payload result result_file
    result_file="$(/usr/bin/mktemp)"
    stderr_file="$(/usr/bin/mktemp)"
    payload='[{"filename":"pkg.zip","version":"03162026-27c78cfb","cdn_url":"https://dl.artifacts.example.invalid/basic/portico/raw/names/portico_dev/versions/03162026-27c78cfb/pkg.zip","uploaded_at":"2026-03-16T18:35:54.992736Z","created_at":"2026-03-16T18:35:00.000000Z"}]'
    find_cloudsmith_package_metadata "$payload" "pkg.zip" > "$result_file" 2>"$stderr_file"
    result="$(cat "$result_file")"

    [ "$PACKAGE_METADATA_PARSER" = "perl" ] || fail "expected perl metadata parser when python3 probe fails but perl is available"
    [ -n "$result" ] || fail "fallback parser did not return package metadata when python3 was broken"
    [ ! -s "$stderr_file" ] || fail "broken python3 probe leaked stderr into the phase 1 parser path"
  )
}

test_build_cloudsmith_download_url_rejects_invalid_raw_fallback_version() {
  (
    source "$PREREQ_SCRIPT"

    exec 9>/dev/null
    LOG_FD=9

    local output
    if output="$(build_cloudsmith_download_url \
      "portico_dev" \
      "https://dl.artifacts.example.invalid/basic/portico/raw/names/portico_dev/versions/03242026-7d378dee/pkg.zip" \
      "pkg.zip" \
      "" 2>&1)"; then
      fail "build_cloudsmith_download_url unexpectedly accepted a URL-shaped version for raw fallback"
    fi
    [ -z "$output" ] || fail "build_cloudsmith_download_url should fail cleanly without printing a malformed URL"
  )
}

test_build_cloudsmith_download_url_resolves_exact_build_with_entitlement() {
  (
    source "$PREREQ_SCRIPT"

    exec 9>/dev/null
    LOG_FD=9
    CLOUDSMITH_DL_BASE="https://dl.artifacts.example.invalid"
    CLOUDSMITH_REPO="portico"
    CLOUDSMITH_ENTITLEMENT_TOKEN="read-token"

    local output
    output="$(build_cloudsmith_download_url \
      "portico_dev" \
      "06192026-05f90042" \
      "portico_dev-06192026-05f90042.zip" \
      "")"

    [ "$output" = "https://dl.artifacts.example.invalid/read-token/portico/raw/names/portico_dev/versions/06192026-05f90042/portico_dev-06192026-05f90042.zip" ] \
      || fail "exact build URL did not use the entitlement download path"
  )
}

test_detect_content_length_uses_entitlement_url_without_api_key_header() {
  (
    source "$PREREQ_SCRIPT"

    exec 9>/dev/null
    LOG_FD=9

    local tmp_dir curl_wrapper curl_log output
    tmp_dir="$(mktemp -d)"
    curl_wrapper="$tmp_dir/fake-curl"
    curl_log="$tmp_dir/curl.log"

    cat >"$curl_wrapper" <<SH
#!/usr/bin/env bash
printf '%s\n' "\$@" > "$curl_log"
printf 'HTTP/1.1 200 OK\r\nContent-Length: 758939212\r\n\r\n'
SH
    chmod +x "$curl_wrapper"

    TEMP_DIR="$tmp_dir"
    CURL_BIN="$curl_wrapper"
    CS_TOKEN="read-token"
    DOWNLOAD_URL="https://dl.artifacts.example.invalid/read-token/portico/raw/names/portico_dev/versions/06192026-5e5312ea/pkg.zip"

    output="$(detect_content_length)"

    [ "$output" = "758939212" ] \
      || fail "content-length probe did not parse the entitlement-authenticated response"
    if grep -q 'X-Api-Key' "$curl_log"; then
      fail "content-length probe sent an entitlement token as an API-key header"
    fi
  )
}

test_download_payload_with_retry_retries_exit_code_three_with_clean_env() {
  (
    source "$PREREQ_SCRIPT"

    exec 9>/dev/null
    LOG_FD=9

    local tmp_dir curl_wrapper curl_log output_file stderr_file attempts
    tmp_dir="$(mktemp -d)"
    curl_wrapper="$tmp_dir/fake-curl"
    curl_log="$tmp_dir/curl.log"
    output_file="$tmp_dir/payload.zip"
    stderr_file="$tmp_dir/download.stderr"

    cat >"$curl_wrapper" <<SH
#!/usr/bin/env bash
set -euo pipefail
log_file="$curl_log"
mode="clean"
if [ "\${CURL_TEST_ENV_DIRTY:-}" = "1" ]; then
  mode="dirty"
fi
printf 'mode=%s\n' "\$mode" >> "\$log_file"
printf 'argv=' >> "\$log_file"
printf '%q ' "\$@" >> "\$log_file"
printf '\n' >> "\$log_file"
output_path=""
while [ "\$#" -gt 0 ]; do
  case "\$1" in
    -o)
      output_path="\$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
if [ "\$mode" = "dirty" ]; then
  printf 'curl: (3) URL rejected: Bad hostname\n' >&2
  exit 3
fi
printf 'zip-bytes' > "\$output_path"
SH
    chmod +x "$curl_wrapper"

    CURL_BIN="$curl_wrapper"
    DOWNLOAD_URL="https://dl.artifacts.example.invalid/TOKEN/portico/raw/names/portico_dev/versions/03162026-27c78cfb/pkg.zip"
    export CURL_TEST_ENV_DIRTY=1

    if ! download_payload_with_retry 0 "$output_file" "$stderr_file"; then
      fail "download_payload_with_retry did not recover from curl exit code 3"
    fi

    [ -f "$output_file" ] || fail "download retry did not create the payload file"
    [ "$(cat "$output_file")" = "zip-bytes" ] || fail "payload retry wrote unexpected file contents"

    attempts="$(grep -c '^mode=' "$curl_log")"
    [ "$attempts" -eq 2 ] || fail "expected exactly two curl attempts, saw $attempts"
    grep -q '^mode=dirty$' "$curl_log" || fail "expected the first curl attempt to run in the inherited environment"
    grep -q '^mode=clean$' "$curl_log" || fail "expected the retry to run in the clean environment"
  )
}

test_download_payload_with_retry_does_not_retry_non_three_failures() {
  (
    source "$PREREQ_SCRIPT"

    exec 9>/dev/null
    LOG_FD=9

    local tmp_dir curl_wrapper curl_log output_file stderr_file attempts
    tmp_dir="$(mktemp -d)"
    curl_wrapper="$tmp_dir/fake-curl"
    curl_log="$tmp_dir/curl.log"
    output_file="$tmp_dir/payload.zip"
    stderr_file="$tmp_dir/download.stderr"

    cat >"$curl_wrapper" <<SH
#!/usr/bin/env bash
set -euo pipefail
log_file="$curl_log"
printf 'attempt\n' >> "\$log_file"
printf 'curl: (22) The requested URL returned error: 404\n' >&2
exit 22
SH
    chmod +x "$curl_wrapper"

    CURL_BIN="$curl_wrapper"
    DOWNLOAD_URL="https://dl.artifacts.example.invalid/TOKEN/portico/raw/names/portico_dev/versions/03162026-27c78cfb/pkg.zip"

    if download_payload_with_retry 0 "$output_file" "$stderr_file"; then
      fail "download_payload_with_retry unexpectedly succeeded for curl exit code 22"
    fi

    attempts="$(grep -c '^attempt$' "$curl_log")"
    [ "$attempts" -eq 1 ] || fail "expected exactly one curl attempt for non-retryable failure, saw $attempts"
  )
}

test_managed_runtime_default_preserve_paths_include_chat_history_and_exclude_shipped_content() {
  (
    source "$PREREQ_SCRIPT"

    exec 9>/dev/null
    LOG_FD=9

    array_has_exact_value "open-webui-data" "${PRESERVE_FILES[@]}" \
      || fail "open-webui-data should be preserved across upgrades"
    array_has_exact_value "health-status" "${PRESERVE_FILES[@]}" \
      || fail "health-status sentinels and update audit state should be preserved across upgrades"
    array_has_exact_value "mcp-configs-user" "${PRESERVE_FILES[@]}" \
      || fail "mcp-configs-user should be preserved across upgrades"
    array_has_exact_value "skills-user" "${PRESERVE_FILES[@]}" \
      || fail "skills-user should be preserved across upgrades"
    array_has_exact_value "skills-marketplace" "${PRESERVE_FILES[@]}" \
      || fail "skills-marketplace should be preserved across upgrades"
    array_has_exact_value "marketplaces.json" "${PRESERVE_FILES[@]}" \
      || fail "marketplaces.json should be preserved across upgrades"
    array_has_exact_value "HOST_MODE" "${PRESERVE_FILES[@]}" \
      || fail "HOST_MODE should be preserved across upgrades"

    ! array_has_exact_value "mcp_config_host_sideload.json" "${PRESERVE_FILES[@]}" \
      || fail "generated host config should be regenerated during upgrades"
    ! array_has_exact_value "mcp-configs" "${PRESERVE_FILES[@]}" \
      || fail "mcp-configs should be payload-managed during upgrades"
    ! array_has_exact_value "skills" "${PRESERVE_FILES[@]}" \
      || fail "skills should be payload-managed during upgrades"
    ! array_has_exact_value "guided-setup" "${PRESERVE_FILES[@]}" \
      || fail "legacy guided-setup app bundles should be payload-managed during upgrades"
  )
}

test_managed_runtime_reconcile_payload_replaces_shipped_paths_and_preserves_user_state() {
  (
    source "$PREREQ_SCRIPT"

    exec 9>/dev/null
    LOG_FD=9

    local tmp_dir payload_dir managed_dir
    tmp_dir="$(mktemp -d)"
    payload_dir="$tmp_dir/payload"
    managed_dir="$tmp_dir/managed"

    mkdir -p \
      "$payload_dir/mcp-configs/glean" \
      "$payload_dir/skills/new-skill" \
      "$payload_dir/open-webui-data" \
      "$payload_dir/health-status" \
      "$payload_dir/HOST_MODE" \
      "$payload_dir/electron-app"
    printf 'new-glean\n' > "$payload_dir/mcp-configs/glean/glean.yaml"
    printf 'new skill\n' > "$payload_dir/skills/new-skill/SKILL.md"
    printf 'replacement-file\n' > "$payload_dir/skills/conflict"
    printf 'payload placeholder\n' > "$payload_dir/open-webui-data/placeholder.txt"
    printf 'payload health placeholder\n' > "$payload_dir/health-status/placeholder.txt"
    printf 'payload workspace placeholder\n' > "$payload_dir/workspaces"
    printf '{"buildNumber":"new"}\n' > "$payload_dir/electron-app/build-info.json"

    mkdir -p \
      "$managed_dir/mcp-configs/browser-use" \
      "$managed_dir/mcp-configs/time" \
      "$managed_dir/skills/old-skill" \
      "$managed_dir/skills/conflict" \
      "$managed_dir/open-webui-data" \
      "$managed_dir/health-status" \
      "$managed_dir/mcp-configs-user/custom" \
      "$managed_dir/mcp_config_host_sideload.json" \
      "$managed_dir/skills-user/custom" \
      "$managed_dir/skills-marketplace/test-market/custom-skill" \
      "$managed_dir/workspaces/project-a" \
      "$managed_dir/backup" \
      "$managed_dir/guided-setup/dist/mac-arm64/Portico.app/Contents/Resources"
    printf 'old browser use\n' > "$managed_dir/mcp-configs/browser-use/browser-use.yaml"
    printf 'old time\n' > "$managed_dir/mcp-configs/time/time.yaml"
    printf 'old skill\n' > "$managed_dir/skills/old-skill/SKILL.md"
    printf 'old conflict dir\n' > "$managed_dir/skills/conflict/obsolete.txt"
    printf 'SLACK_TOKEN=keep-me\n' > "$managed_dir/.env"
    printf 'TRUE\n' > "$managed_dir/HOST_MODE"
    printf 'chat history\n' > "$managed_dir/open-webui-data/webui.db"
    printf '{"sizeBytes":331000000}\n' > "$managed_dir/health-status/owui-db-sentinel.json"
    printf 'apply audit\n' > "$managed_dir/health-status/update-apply-build-2026.log"
    printf '{"result":"ok"}\n' > "$managed_dir/health-status/update-history.jsonl"
    printf 'custom user config\n' > "$managed_dir/mcp-configs-user/custom/custom.yaml"
    printf 'stale host config\n' > "$managed_dir/mcp_config_host_sideload.json/obsolete.json"
    printf 'custom user skill\n' > "$managed_dir/skills-user/custom/SKILL.md"
    printf 'marketplace skill\n' > "$managed_dir/skills-marketplace/test-market/custom-skill/SKILL.md"
    printf '{"marketplaces":["keep"]}\n' > "$managed_dir/marketplaces.json"
    printf 'workspace state\n' > "$managed_dir/workspaces/project-a/state.txt"
    printf 'full backup\n' > "$managed_dir/backup/portico_full_backup_001.zip"
    printf 'stale app\n' > "$managed_dir/guided-setup/dist/mac-arm64/Portico.app/Contents/Resources/app.asar"

    managed_runtime_reconcile_payload "$payload_dir" "$managed_dir" "${PRESERVE_FILES[@]}"

    [ -f "$managed_dir/mcp-configs/glean/glean.yaml" ] \
      || fail "payload MCP configs should be copied into the managed runtime"
    [ ! -e "$managed_dir/mcp-configs/browser-use" ] \
      || fail "stale shipped browser-use config should be removed during reconcile"
    [ ! -e "$managed_dir/mcp-configs/time" ] \
      || fail "stale shipped time config should be removed during reconcile"
    [ ! -e "$managed_dir/skills/old-skill" ] \
      || fail "stale shipped skills should be removed during reconcile"
    [ -f "$managed_dir/skills/conflict" ] \
      || fail "payload file should replace stale managed directory on path conflicts"
    grep -q '^replacement-file$' "$managed_dir/skills/conflict" \
      || fail "path conflict replacement should keep the payload file contents"

    grep -q '^SLACK_TOKEN=keep-me$' "$managed_dir/.env" \
      || fail ".env should be preserved during reconcile"
    grep -q '^TRUE$' "$managed_dir/HOST_MODE" \
      || fail "HOST_MODE=TRUE should be preserved during reconcile"
    grep -q '^chat history$' "$managed_dir/open-webui-data/webui.db" \
      || fail "open-webui-data should be preserved during reconcile"
    [ ! -e "$managed_dir/open-webui-data/placeholder.txt" ] \
      || fail "payload placeholders must not overwrite preserved chat history data"
    grep -q '331000000' "$managed_dir/health-status/owui-db-sentinel.json" \
      || fail "database integrity sentinel should survive reconcile"
    grep -q '^apply audit$' "$managed_dir/health-status/update-apply-build-2026.log" \
      || fail "persistent update apply audit should survive reconcile"
    grep -q '"result":"ok"' "$managed_dir/health-status/update-history.jsonl" \
      || fail "update history ledger should survive reconcile"
    [ ! -e "$managed_dir/health-status/placeholder.txt" ] \
      || fail "payload health-status placeholders must not overwrite preserved audit state"
    [ ! -e "$managed_dir/mcp_config_host_sideload.json" ] \
      || fail "generated host config should be removed during reconcile"
    grep -q '^custom user config$' "$managed_dir/mcp-configs-user/custom/custom.yaml" \
      || fail "mcp-configs-user should be preserved during reconcile"
    grep -q '^custom user skill$' "$managed_dir/skills-user/custom/SKILL.md" \
      || fail "skills-user should be preserved during reconcile"
    grep -q '^marketplace skill$' "$managed_dir/skills-marketplace/test-market/custom-skill/SKILL.md" \
      || fail "skills-marketplace should be preserved during reconcile"
    grep -q '"keep"' "$managed_dir/marketplaces.json" \
      || fail "marketplaces.json should be preserved during reconcile"
    grep -q '^workspace state$' "$managed_dir/workspaces/project-a/state.txt" \
      || fail "workspace directories should be preserved in place during reconcile"
    grep -q '^full backup$' "$managed_dir/backup/portico_full_backup_001.zip" \
      || fail "managed backup archives should survive reconcile --delete"
    [ ! -e "$managed_dir/guided-setup" ] \
      || fail "legacy guided-setup app bundles should be removed during reconcile"

    rm -rf "$tmp_dir"
  )
}

test_managed_runtime_reconcile_rejects_unsafe_preserve_paths() {
  (
    source "$PROJECT_ROOT/src/scripts/managed-runtime-reconcile.sh"

    exec 9>/dev/null
    LOG_FD=9

    local tmp_dir payload_dir managed_dir unsafe_path
    tmp_dir="$(mktemp -d)"
    payload_dir="$tmp_dir/payload"
    managed_dir="$tmp_dir/managed"

    mkdir -p "$payload_dir" "$managed_dir"
    printf 'payload\n' > "$payload_dir/app-owned.txt"

    for unsafe_path in \
      "" \
      "/absolute" \
      "./foo" \
      "foo/./bar" \
      "foo/../bar" \
      "foo*" \
      "foo?" \
      "foo[bar]" \
      "foo/" \
      "foo//bar" \
      "foo/bar" \
      "../outside"; do
      printf 'managed\n' > "$managed_dir/app-owned.txt"

      if managed_runtime_reconcile_payload "$payload_dir" "$managed_dir" "$unsafe_path"; then
        fail "managed runtime reconcile should reject unsafe preserve path: ${unsafe_path:-<empty>}"
      fi

      grep -q '^managed$' "$managed_dir/app-owned.txt" \
        || fail "unsafe preserve path ${unsafe_path:-<empty>} should fail before mutating managed files"
    done

    rm -rf "$tmp_dir"
  )
}

test_managed_runtime_reconcile_filters_existing_preserve_paths_for_rsync() {
  (
    source "$PREREQ_SCRIPT"

    exec 9>/dev/null
    LOG_FD=9

    local tmp_dir payload_dir managed_dir fake_bin rsync_log output
    tmp_dir="$(mktemp -d)"
    payload_dir="$tmp_dir/payload"
    managed_dir="$tmp_dir/managed"
    fake_bin="$tmp_dir/bin"
    rsync_log="$tmp_dir/rsync-argv.log"

    mkdir -p \
      "$payload_dir/electron-app" \
      "$payload_dir/skills-marketplace/bundled-skill" \
      "$payload_dir/skills-user/payload-skill" \
      "$managed_dir/skills-marketplace/user-skill" \
      "$fake_bin"
    printf '{"buildNumber":"new"}\n' > "$payload_dir/electron-app/build-info.json"
    printf 'bundled marketplace\n' > "$payload_dir/skills-marketplace/bundled-skill/SKILL.md"
    printf 'payload user skill\n' > "$payload_dir/skills-user/payload-skill/SKILL.md"
    printf 'existing marketplace\n' > "$managed_dir/skills-marketplace/user-skill/SKILL.md"

    cat > "$fake_bin/rsync" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$RSYNC_ARGV_LOG"
case " $* " in
  *"--filter=H /skills-marketplace"*"--filter=P /skills-marketplace"*"--filter=H /skills-marketplace/***"*"--filter=P /skills-marketplace/***"*) ;;
  *) echo "missing skills-marketplace protection filters" >&2; exit 64 ;;
esac
case " $* " in
  *"--filter=H /skills-user"*) echo "unexpected skills-user filter" >&2; exit 65 ;;
esac
exit 0
SH
    chmod +x "$fake_bin/rsync"

    PATH="$fake_bin:$PATH"
    RSYNC_ARGV_LOG="$rsync_log"
    export PATH RSYNC_ARGV_LOG

    if ! output="$(managed_runtime_reconcile_payload "$payload_dir" "$managed_dir" "${PRESERVE_FILES[@]}")"; then
      fail "expected reconcile to pass preserved-path filters to rsync, saw: $output"
    fi

    grep -F -- '--filter=H /skills-marketplace' "$rsync_log" >/dev/null \
      || fail "expected existing skills-marketplace to be hidden from the payload sender"
    grep -F -- '--filter=P /skills-marketplace' "$rsync_log" >/dev/null \
      || fail "expected existing skills-marketplace to be protected on the receiver"
    if grep -F -- '--filter=H /skills-user' "$rsync_log" >/dev/null; then
      fail "preserved paths absent from the managed tree should be seeded from payload"
    fi

    rm -rf "$tmp_dir"
  )
}

test_managed_runtime_reconcile_propagates_rsync_failure_without_touching_webui_db() {
  (
    source "$PREREQ_SCRIPT"

    exec 9>/dev/null
    LOG_FD=9

    local tmp_dir payload_dir managed_dir fake_bin checksum_before checksum_after output sync_output rc
    local sentinel_before sentinel_after audit_before audit_after ledger_before ledger_after
    tmp_dir="$(mktemp -d)"
    payload_dir="$tmp_dir/payload"
    managed_dir="$tmp_dir/managed"
    fake_bin="$tmp_dir/fake-bin"
    mkdir -p \
      "$payload_dir/open-webui-data" \
      "$payload_dir/health-status" \
      "$managed_dir/open-webui-data" \
      "$managed_dir/health-status" \
      "$fake_bin"
    printf 'payload replacement\n' > "$payload_dir/app-owned.txt"
    printf 'payload placeholder\n' > "$payload_dir/open-webui-data/webui.db"
    printf 'payload sentinel\n' > "$payload_dir/health-status/owui-db-sentinel.json"
    printf 'irreplaceable chat history\n' > "$managed_dir/open-webui-data/webui.db"
    printf '{"sizeBytes":331000000}\n' > "$managed_dir/health-status/owui-db-sentinel.json"
    printf 'apply audit before failure\n' > "$managed_dir/health-status/update-apply-build-2026.log"
    printf '{"result":"ok"}\n' > "$managed_dir/health-status/update-history.jsonl"
    checksum_before="$(cksum "$managed_dir/open-webui-data/webui.db")"
    sentinel_before="$(cksum "$managed_dir/health-status/owui-db-sentinel.json")"
    audit_before="$(cksum "$managed_dir/health-status/update-apply-build-2026.log")"
    ledger_before="$(cksum "$managed_dir/health-status/update-history.jsonl")"

    cat > "$fake_bin/rsync" <<'SH'
#!/usr/bin/env bash
case " $* " in
  *"--filter=H /health-status"*"--filter=P /health-status"*"--filter=H /health-status/***"*"--filter=P /health-status/***"*) ;;
  *) echo "missing health-status protection filters" >&2; exit 66 ;;
esac
printf 'partial app payload\n' > "$RSYNC_FAILURE_MANAGED_DIR/app-owned.txt"
exit 11
SH
    chmod +x "$fake_bin/rsync"
    PATH="$fake_bin:$PATH"
    RSYNC_FAILURE_MANAGED_DIR="$managed_dir"
    export PATH RSYNC_FAILURE_MANAGED_DIR

    rc=0
    sync_output="$(managed_runtime_sync_payload_in_place "$payload_dir" "$managed_dir" "open-webui-data" "health-status" 2>&1)" || rc=$?
    [ "$rc" = "11" ] || fail "expected sync primitive to return rsync exit 11 exactly, saw $rc"
    printf '%s' "$sync_output" | grep -q 'rsync exited 11' \
      || fail "expected sync primitive to log the real rsync exit status"

    rc=0
    output="$(managed_runtime_reconcile_payload "$payload_dir" "$managed_dir" "open-webui-data" "health-status" 2>&1)" || rc=$?
    [ "$rc" -ne 0 ] || fail "expected rsync exit 11 to fail managed-runtime reconcile"
    printf '%s' "$output" | grep -q 'rsync exited 11' \
      || fail "expected reconcile log to expose the real rsync exit status"
    printf '%s' "$output" | grep -q 'Managed runtime reconcile failed' \
      || fail "expected reconcile failure diagnostic"
    checksum_after="$(cksum "$managed_dir/open-webui-data/webui.db")"
    [ "$checksum_before" = "$checksum_after" ] \
      || fail "rsync failure must leave pre-seeded webui.db byte-identical"
    sentinel_after="$(cksum "$managed_dir/health-status/owui-db-sentinel.json")"
    audit_after="$(cksum "$managed_dir/health-status/update-apply-build-2026.log")"
    ledger_after="$(cksum "$managed_dir/health-status/update-history.jsonl")"
    [ "$sentinel_before" = "$sentinel_after" ] \
      || fail "rsync failure must leave the database sentinel byte-identical"
    [ "$audit_before" = "$audit_after" ] \
      || fail "rsync failure must leave persistent apply audits byte-identical"
    [ "$ledger_before" = "$ledger_after" ] \
      || fail "rsync failure must leave the update history ledger byte-identical"
    grep -q '^partial app payload$' "$managed_dir/app-owned.txt" \
      || fail "fixture should demonstrate that partial app-owned payload files may land"
  )
}

test_managed_runtime_reconcile_seeds_absent_preserve_paths_from_payload() {
  (
    source "$PREREQ_SCRIPT"

    exec 9>/dev/null
    LOG_FD=9

    local tmp_dir payload_dir managed_dir
    tmp_dir="$(mktemp -d)"
    payload_dir="$tmp_dir/payload"
    managed_dir="$tmp_dir/managed"

    mkdir -p "$payload_dir/skills-marketplace/bundled-skill" "$payload_dir/electron-app"
    printf '{"buildNumber":"new"}\n' > "$payload_dir/electron-app/build-info.json"
    printf 'bundled marketplace\n' > "$payload_dir/skills-marketplace/bundled-skill/SKILL.md"

    managed_runtime_reconcile_payload "$payload_dir" "$managed_dir" "${PRESERVE_FILES[@]}"

    grep -q '^bundled marketplace$' "$managed_dir/skills-marketplace/bundled-skill/SKILL.md" \
      || fail "absent preserve paths should be seeded from the payload"

    rm -rf "$tmp_dir"
  )
}

test_managed_runtime_reconcile_preserves_host_mode_true_for_host_config_regeneration() {
  (
    source "$PREREQ_SCRIPT"

    exec 9>/dev/null
    LOG_FD=9

    local tmp_dir payload_dir managed_dir
    tmp_dir="$(mktemp -d)"
    payload_dir="$tmp_dir/payload"
    managed_dir="$tmp_dir/managed"

    mkdir -p "$payload_dir/electron-app" "$managed_dir"
    printf '{"buildNumber":"new"}\n' > "$payload_dir/electron-app/build-info.json"
    printf 'FALSE\n' > "$payload_dir/HOST_MODE"
    printf 'TRUE\n' > "$managed_dir/HOST_MODE"
    printf '{"chrome-devtools":true}\n' > "$managed_dir/mcp_toggles.json"

    managed_runtime_reconcile_payload "$payload_dir" "$managed_dir" "${PRESERVE_FILES[@]}"

    [ "$(cat "$managed_dir/HOST_MODE")" = "TRUE" ] \
      || fail "HOST_MODE=TRUE should survive managed runtime reconcile"

    resolve_mcp_orc_generator_binary() {
      return 0
    }

    run_mcp_orc_generator() {
      local project_root="$1"
      [ "$(cat "$project_root/HOST_MODE")" = "TRUE" ] \
        || return 31
      cat > "$project_root/mcp_config_host_sideload.json" <<'JSON'
{"mcpServers":{"chrome-devtools":{"command":"npx"}}}
JSON
      return 0
    }

    managed_runtime_regenerate_generated_compose "$managed_dir" \
      || fail "regeneration should see preserved HOST_MODE=TRUE"
    grep -q '"chrome-devtools"' "$managed_dir/mcp_config_host_sideload.json" \
      || fail "expected regenerated host config to include Chrome DevTools when HOST_MODE remains TRUE"

    rm -rf "$tmp_dir"
  )
}

test_prune_full_backup_archives_keeps_newest_five_matching_archives() {
  (
    source "$PREREQ_SCRIPT"

    exec 9>/dev/null
    LOG_FD=9

    local tmp_dir backup_dir output archive_count
    tmp_dir="$(mktemp -d)"
    backup_dir="$tmp_dir/managed/backup"
    mkdir -p "$backup_dir/manual-note-dir"

    printf 'keep note\n' > "$backup_dir/notes.txt"
    printf 'keep dir note\n' > "$backup_dir/manual-note-dir/keep.txt"

    local index=""
    for index in 001 002 003 004 005 006 007; do
      printf '%s\n' "$index" > "$backup_dir/portico_full_backup_${index}.zip"
    done

    output="$(prune_full_backup_archives "$backup_dir" 5 2>&1)"

    archive_count="$(find "$backup_dir" -maxdepth 1 -type f -name 'portico_full_backup_*.zip' | wc -l | tr -d '[:space:]')"
    [ "$archive_count" = "5" ] \
      || fail "expected backup retention to keep exactly five matching archives, saw $archive_count"
    [ -f "$backup_dir/portico_full_backup_007.zip" ] \
      || fail "expected the newest matching archive to be retained"
    [ -f "$backup_dir/portico_full_backup_003.zip" ] \
      || fail "expected the fifth newest matching archive to be retained"
    [ ! -e "$backup_dir/portico_full_backup_002.zip" ] \
      || fail "expected the sixth newest matching archive to be pruned"
    [ ! -e "$backup_dir/portico_full_backup_001.zip" ] \
      || fail "expected the oldest matching archive to be pruned"
    [ -f "$backup_dir/notes.txt" ] \
      || fail "backup retention should not remove unrelated files"
    [ -f "$backup_dir/manual-note-dir/keep.txt" ] \
      || fail "backup retention should not remove unrelated directories"
    printf '%s' "$output" | grep -q 'Managed full backup retention: pruned 2 archive(s); kept 5 of 7' \
      || fail "expected backup retention logs to describe how many archives were pruned"
  )
}

test_persist_full_backup_archive_prunes_before_saving_and_retains_two() {
  (
    source "$PREREQ_SCRIPT"

    exec 9>/dev/null
    LOG_FD=9

    local tmp_dir backup_dir output archive_count prune_line save_line
    tmp_dir="$(mktemp -d)"
    MANAGED_DIR="$tmp_dir/managed"
    backup_dir="$MANAGED_DIR/backup"
    mkdir -p "$backup_dir/manual-note-dir"

    printf 'keep note\n' > "$backup_dir/notes.txt"
    printf 'keep dir note\n' > "$backup_dir/manual-note-dir/keep.txt"

    local index=""
    for index in 004 005 006 007 008; do
      printf '%s\n' "$index" > "$backup_dir/portico_full_backup_${index}.zip"
    done

    FULL_BACKUP_ZIP_NAME="portico_full_backup_999.zip"
    FULL_BACKUP_ZIP_PATH="$tmp_dir/$FULL_BACKUP_ZIP_NAME"
    printf 'new archive\n' > "$FULL_BACKUP_ZIP_PATH"

    output="$(persist_full_backup_archive 2>&1)"

    archive_count="$(find "$backup_dir" -maxdepth 1 -type f -name 'portico_full_backup_*.zip' | wc -l | tr -d '[:space:]')"
    [ "$archive_count" = "2" ] \
      || fail "expected persist_full_backup_archive to retain two matching archives, saw $archive_count"
    [ -f "$backup_dir/$FULL_BACKUP_ZIP_NAME" ] \
      || fail "expected the newly saved full backup archive to be retained"
    [ -f "$backup_dir/portico_full_backup_008.zip" ] \
      || fail "expected the newest existing archive to be retained"
    [ ! -e "$backup_dir/portico_full_backup_007.zip" ] \
      || fail "expected older archives to be pruned before saving a new backup"
    [ -f "$backup_dir/notes.txt" ] \
      || fail "saving a new full backup archive should not remove unrelated files"
    [ -f "$backup_dir/manual-note-dir/keep.txt" ] \
      || fail "saving a new full backup archive should not remove unrelated directories"
    printf '%s' "$output" | grep -q 'Full backup archive saved: backup/portico_full_backup_999.zip' \
      || fail "expected persist_full_backup_archive to log the saved archive name"
    printf '%s' "$output" | grep -q 'Managed full backup retention: pruned 4 archive(s); kept 1 of 5' \
      || fail "expected persist_full_backup_archive to reserve a retention slot before save"
    prune_line="$(printf '%s\n' "$output" | grep -n 'Managed full backup retention' | cut -d: -f1)"
    save_line="$(printf '%s\n' "$output" | grep -n 'Full backup archive saved' | cut -d: -f1)"
    [ "$prune_line" -lt "$save_line" ] \
      || fail "expected prereq backup pruning before archive placement"
  )
}

test_persist_full_backup_archive_prunes_before_saving_under_bin_bash() {
  (
    local tmp_dir backup_dir output archive_count
    tmp_dir="$(mktemp -d)"
    backup_dir="$tmp_dir/managed/backup"
    mkdir -p "$backup_dir/manual-note-dir"

    printf 'keep note\n' > "$backup_dir/notes.txt"
    printf 'keep dir note\n' > "$backup_dir/manual-note-dir/keep.txt"

    local index=""
    for index in 004 005 006 007 008; do
      printf '%s\n' "$index" > "$backup_dir/portico_full_backup_${index}.zip"
    done

    printf 'new archive\n' > "$tmp_dir/portico_full_backup_999.zip"

    if ! output="$(
      env \
        PREREQ_SCRIPT="$PREREQ_SCRIPT" \
        TMP_DIR="$tmp_dir" \
        FULL_BACKUP_TEST_NAME="portico_full_backup_999.zip" \
        FULL_BACKUP_TEST_PATH="$tmp_dir/portico_full_backup_999.zip" \
        /bin/bash -c '
          set -euo pipefail
          source "$PREREQ_SCRIPT"
          exec 9>/dev/null
          LOG_FD=9
          MANAGED_DIR="$TMP_DIR/managed"
          FULL_BACKUP_ZIP_NAME="$FULL_BACKUP_TEST_NAME"
          FULL_BACKUP_ZIP_PATH="$FULL_BACKUP_TEST_PATH"
          persist_full_backup_archive
        ' 2>&1
    )"; then
      fail "expected persist_full_backup_archive to succeed under /bin/bash, saw: $output"
    fi

    archive_count="$(find "$backup_dir" -maxdepth 1 -type f -name 'portico_full_backup_*.zip' | wc -l | tr -d '[:space:]')"
    [ "$archive_count" = "2" ] \
      || fail "expected /bin/bash persist_full_backup_archive to retain two matching archives, saw $archive_count"
    [ -f "$backup_dir/portico_full_backup_999.zip" ] \
      || fail "expected /bin/bash retain the newly saved full backup archive"
    [ -f "$backup_dir/portico_full_backup_008.zip" ] \
      || fail "expected /bin/bash to retain the newest existing archive"
    [ ! -e "$backup_dir/portico_full_backup_007.zip" ] \
      || fail "expected /bin/bash to prune older matching archives before saving a new backup"
    [ -f "$backup_dir/notes.txt" ] \
      || fail "expected /bin/bash backup retention to preserve unrelated files"
    [ -f "$backup_dir/manual-note-dir/keep.txt" ] \
      || fail "expected /bin/bash backup retention to preserve unrelated directories"
    printf '%s' "$output" | grep -q 'Full backup archive saved: backup/portico_full_backup_999.zip' \
      || fail "expected /bin/bash persist_full_backup_archive to log the saved archive name"
    printf '%s' "$output" | grep -q 'Managed full backup retention: pruned 4 archive(s); kept 1 of 5' \
      || fail "expected /bin/bash persist_full_backup_archive to log pre-save retention pruning"
  )
}

test_persist_full_backup_archive_dedupes_same_inode_on_retry() {
  (
    source "$PREREQ_SCRIPT"

    exec 9>/dev/null
    LOG_FD=9

    local tmp_dir backup_dir output archive_count source_identity installed_identity
    tmp_dir="$(mktemp -d)"
    MANAGED_DIR="$tmp_dir/managed"
    backup_dir="$MANAGED_DIR/backup"
    FULL_BACKUP_ZIP_NAME="portico_full_backup_999.zip"
    FULL_BACKUP_ZIP_PATH="$tmp_dir/$FULL_BACKUP_ZIP_NAME"
    printf 'new archive\n' > "$FULL_BACKUP_ZIP_PATH"

    persist_full_backup_archive >/dev/null
    output="$(persist_full_backup_archive 2>&1)"

    archive_count="$(find "$backup_dir" -maxdepth 1 -type f -name 'portico_full_backup_*.zip' | wc -l | tr -d '[:space:]')"
    [ "$archive_count" = "1" ] \
      || fail "expected prereq retry dedupe to avoid a second hardlink name, saw $archive_count archives"
    printf '%s' "$output" | grep -q 'Full backup archive already installed: backup/' \
      || fail "expected prereq retry dedupe to log already-installed archive"
    source_identity="$(backup_archive_inode_identity "$FULL_BACKUP_ZIP_PATH")"
    installed_identity="$(backup_archive_inode_identity "$backup_dir/$FULL_BACKUP_ZIP_NAME")"
    [ "$source_identity" = "$installed_identity" ] \
      || fail "expected prereq archive placement to hardlink the source inode"
  )
}

test_backup_inode_identity_ignores_failed_bsd_stat_output() {
  (
    source "$PREREQ_SCRIPT"

    exec 9>/dev/null
    LOG_FD=9
    stat() {
      if [ "$1" = "-f" ]; then
        printf 'partial GNU filesystem output\n'
        return 1
      fi
      if [ "$1" = "-c" ]; then
        printf '42:99\n'
        return 0
      fi
      return 1
    }

    [ "$(backup_archive_inode_identity /fixture/archive.zip)" = "42:99" ] \
      || fail "prereq inode identity should discard output from a failed BSD stat probe"
  )
}

test_source_does_not_execute_main
test_refresh_managed_build_info_preserves_release_runtime_image_tag
test_create_slim_backup_excludes_bulk_user_data_and_snapshots_webui_db
test_normalize_url_for_curl_unescapes_and_trims
test_prepare_curl_checked_adds_dash_q_and_redacts_api_key_in_logs
test_find_cloudsmith_package_metadata_reports_python_parser
test_find_cloudsmith_package_metadata_reports_perl_fallback_without_python3
test_find_cloudsmith_package_metadata_reports_sed_fallback
test_find_cloudsmith_package_metadata_ignores_broken_python3
test_build_cloudsmith_download_url_rejects_invalid_raw_fallback_version
test_build_cloudsmith_download_url_resolves_exact_build_with_entitlement
test_detect_content_length_uses_entitlement_url_without_api_key_header
test_download_payload_with_retry_retries_exit_code_three_with_clean_env
test_download_payload_with_retry_does_not_retry_non_three_failures
test_managed_runtime_default_preserve_paths_include_chat_history_and_exclude_shipped_content
test_managed_runtime_reconcile_payload_replaces_shipped_paths_and_preserves_user_state
test_managed_runtime_reconcile_rejects_unsafe_preserve_paths
test_managed_runtime_reconcile_filters_existing_preserve_paths_for_rsync
test_managed_runtime_reconcile_propagates_rsync_failure_without_touching_webui_db
test_managed_runtime_reconcile_seeds_absent_preserve_paths_from_payload
test_managed_runtime_reconcile_preserves_host_mode_true_for_host_config_regeneration
test_prune_full_backup_archives_keeps_newest_five_matching_archives
test_persist_full_backup_archive_prunes_before_saving_and_retains_two
test_persist_full_backup_archive_prunes_before_saving_under_bin_bash
test_persist_full_backup_archive_dedupes_same_inode_on_retry
test_backup_inode_identity_ignores_failed_bsd_stat_output

echo "PASS: prereq-download shell tests"
