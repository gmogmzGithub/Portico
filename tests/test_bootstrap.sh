#!/usr/bin/env bash

set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd "$TEST_DIR/.." && pwd -P)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/test-bootstrap.XXXXXX")"

cleanup() {
    rm -rf -- "$TMP_ROOT"
}
trap cleanup EXIT

fail() {
    printf 'FAIL: %s\n' "$1" >&2
    exit 1
}

prepare_scenario() {
    local scenario="$1"
    local source_dir="$scenario/source"
    local fake_bin="$scenario/bin"
    local command_name command_path

    mkdir -p "$source_dir/src/scripts" "$fake_bin" "$scenario/home"
    cp "$PROJECT_ROOT/bootstrap.sh" "$source_dir/bootstrap.sh"
    cp "$PROJECT_ROOT/src/scripts/release-channel.sh" "$source_dir/src/scripts/release-channel.sh"

    for command_name in awk cat cut date dirname head mkdir mktemp rm sed sort tr; do
        command_path="$(command -v "$command_name")"
        ln -s "$command_path" "$fake_bin/$command_name"
    done

    cat >"$fake_bin/curl" <<'SH'
#!/bin/bash
printf '%s\n' "$*" >> "$BOOTSTRAP_TEST_CURL_LOG"
for argument in "$@"; do
    if [ "$previous_argument" = "-o" ]; then
        printf 'controlled payload failure\n' > "$argument"
        exit 22
    fi
    previous_argument="$argument"
done
cat "$BOOTSTRAP_TEST_PACKAGES"
SH
    chmod +x "$fake_bin/curl"
}

write_mixed_marker_packages() {
    local destination="$1"

    cat >"$destination" <<'JSON'
[
  {"filename":"portico-08112026-bbbbbbbb.zip","version":"08112026-bbbbbbbb","uploaded_at":"2026-08-11T12:00:00.000Z","cdn_url":"https://downloads.example.test/basic/portico/raw/names/portico/versions/08112026-bbbbbbbb/portico-08112026-bbbbbbbb.zip","tags":{"info":["portico-update-ready-v1"]},"tags_immutable":{"info":[]}},
  {"filename":"portico-08092026-cccccccc.zip","version":"08092026-cccccccc","uploaded_at":"2026-08-09T12:00:00.000Z","cdn_url":"https://downloads.example.test/basic/portico/raw/names/portico/versions/08092026-cccccccc/portico-08092026-cccccccc.zip","tags":{"info":[]},"tags_immutable":{"info":["portico-update-ready-v1"]}}
]
JSON
}

run_bootstrap() {
    local scenario="$1"
    local path_value="$2"
    shift 2

    (
        cd "$scenario/source"
        PATH="$path_value" \
        HOME="$scenario/home" \
        CLOUDSMITH_ENTITLEMENT_TOKEN="test-token" \
        CLOUDSMITH_API_BASE="https://api.example.test/v1" \
        CLOUDSMITH_DL_BASE="https://downloads.example.test" \
        BOOTSTRAP_TEST_CURL_LOG="$scenario/curl.log" \
        BOOTSTRAP_TEST_PACKAGES="$scenario/packages.json" \
            /bin/bash ./bootstrap.sh "$@" >"$scenario/output" 2>&1
    )
}

assert_automatic_selection_uses_immutable_marker() {
    local scenario="$1"

    grep -Fq "Available builds in Cloudsmith" "$scenario/output" \
        || fail "bootstrap did not parse the package response"
    grep -Fq "08092026-cccccccc" "$scenario/output" \
        || fail "bootstrap did not retain the immutable-ready package"
    if grep -Fq "08112026-bbbbbbbb" "$scenario/output"; then
        fail "bootstrap retained a newer package with only a mutable readiness tag"
    fi
    grep -Fq \
        "query=name%3Aportico%20format%3Araw%20tag%3A%5Eportico-update-ready-v1%24&page_size=100&sort=-date" \
        "$scenario/curl.log" \
        || fail "bootstrap did not send the encoded latest-build query"
}

test_latest_build_lookup_with_python3() {
    local scenario="$TMP_ROOT/python"

    prepare_scenario "$scenario"
    write_mixed_marker_packages "$scenario/packages.json"
    if ! run_bootstrap "$scenario" "$scenario/bin:$PATH" --list-builds; then
        cat "$scenario/output" >&2
        fail "bootstrap latest-build lookup failed with python3"
    fi
    assert_automatic_selection_uses_immutable_marker "$scenario"
}

test_latest_build_lookup_without_python3() {
    local scenario="$TMP_ROOT/no-python"

    prepare_scenario "$scenario"
    write_mixed_marker_packages "$scenario/packages.json"

    if ! run_bootstrap "$scenario" "$scenario/bin" --list-builds; then
        cat "$scenario/output" >&2
        fail "bootstrap latest-build lookup failed without python3"
    fi
    assert_automatic_selection_uses_immutable_marker "$scenario"
}

assert_build_override_remains_tag_agnostic() {
    local scenario="$1"
    local path_value="$2"

    prepare_scenario "$scenario"
    cat >"$scenario/packages.json" <<'JSON'
[{"filename":"portico-08112026-bbbbbbbb.zip","version":"08112026-bbbbbbbb","uploaded_at":"2026-08-11T12:00:00.000Z","cdn_url":"https://downloads.example.test/basic/portico/raw/names/portico/versions/08112026-bbbbbbbb/portico-08112026-bbbbbbbb.zip","tags":{"info":["portico-update-ready-v1"]},"tags_immutable":{"info":[]}}]
JSON

    if ! run_bootstrap "$scenario" "$path_value" --build-override 08112026-bbbbbbbb --list-builds; then
        cat "$scenario/output" >&2
        fail "bootstrap build override failed"
    fi
    grep -Fq "08112026-bbbbbbbb" "$scenario/output" \
        || fail "bootstrap build override rejected a package without an immutable readiness marker"
    if grep -Fq "portico-update-ready-v1" "$scenario/curl.log"; then
        fail "bootstrap build override added the automatic readiness query"
    fi
}

assert_automatic_download_selects_immutable_marker() {
    local scenario="$1"
    local path_value="$2"

    prepare_scenario "$scenario"
    write_mixed_marker_packages "$scenario/packages.json"
    if run_bootstrap "$scenario" "$path_value"; then
        fail "bootstrap unexpectedly completed the controlled failed download"
    fi
    grep -Fq "Found latest build: portico-08092026-cccccccc.zip" "$scenario/output" \
        || fail "bootstrap did not select the immutable-ready package"
    [ "$(grep -Fc '/versions/08092026-cccccccc/' "$scenario/curl.log")" -eq 1 ] \
        || fail "bootstrap did not request the immutable-ready package exactly once"
    if grep -Fq '/versions/08112026-bbbbbbbb/' "$scenario/curl.log"; then
        fail "bootstrap requested the newer package with only a mutable readiness tag"
    fi
}

test_latest_build_lookup_with_python3
test_latest_build_lookup_without_python3
assert_build_override_remains_tag_agnostic "$TMP_ROOT/python-build-override" "$TMP_ROOT/python-build-override/bin:$PATH"
assert_build_override_remains_tag_agnostic "$TMP_ROOT/no-python-build-override" "$TMP_ROOT/no-python-build-override/bin"
assert_automatic_download_selects_immutable_marker "$TMP_ROOT/python-automatic" "$TMP_ROOT/python-automatic/bin:$PATH"
assert_automatic_download_selects_immutable_marker "$TMP_ROOT/no-python-automatic" "$TMP_ROOT/no-python-automatic/bin"

printf 'PASS: bootstrap shell tests\n'
