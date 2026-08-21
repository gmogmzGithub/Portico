#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNNER="$PROJECT_ROOT/run_dev_release.sh"
SYSTEM_NODE_BIN="$(command -v node)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/portico-dev-release-runner.XXXXXX")"
# shellcheck source=tests/helpers/parallel-shell-tests.sh
source "$PROJECT_ROOT/tests/helpers/parallel-shell-tests.sh"

# Keep credential-path fixtures deterministic when the suite runs inside a
# protected CI job whose environment may already contain release variables.
unset \
    HARBOR_REGISTRY \
    HARBOR_USER \
    HARBOR_TOKEN \
    APPLE_CODESIGN_P12_BASE64 \
    APPLE_CODESIGN_P12_PASSWORD \
    APPLE_ID \
    APPLE_APP_SPECIFIC_PASSWORD \
    APPLE_TEAM_ID \
    CLOUDSMITH_API_KEY \
    CLOUDSMITH_ENTITLEMENT_TOKEN

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
    local needle="$2"
    local message="$3"
    grep -Fq -- "$needle" "$file" || fail "$message"
}

assert_not_contains() {
    local file="$1"
    local needle="$2"
    local message="$3"
    if grep -Fq -- "$needle" "$file"; then
        fail "$message"
    fi
}

write_fixture() {
    local fixture="$1"
    local fake_bin="$fixture/fake-bin"
    if [ -n "${DEV_RELEASE_SHARED_FIXTURE:-}" ]; then
        mkdir -p "$fixture"
        cp -R "$DEV_RELEASE_SHARED_FIXTURE/repo" "$fixture/repo"
        ln -s "$DEV_RELEASE_SHARED_FIXTURE/fake-bin" "$fake_bin"
        return
    fi
    mkdir -p \
        "$fixture/repo/.git" \
        "$fixture/repo/release" \
        "$fixture/repo/src/scripts/ci" \
        "$fixture/repo/src/scripts" \
        "$fake_bin"
    cp "$PROJECT_ROOT/src/scripts/release-channel.sh" \
        "$fixture/repo/src/scripts/release-channel.sh"
    cp "$PROJECT_ROOT/src/scripts/validate-runtime-image-attestation.js" \
        "$fixture/repo/src/scripts/validate-runtime-image-attestation.js"
    cp "$PROJECT_ROOT/src/scripts/ci/assert-release-branch-tip.sh" \
        "$fixture/repo/src/scripts/ci/assert-release-branch-tip.sh"

    cat >"$fake_bin/git" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "-C" ]; then
    shift 2
fi

case "$*" in
    "status --porcelain --untracked-files=no")
        printf '%s' "${FAKE_GIT_TRACKED_STATUS:-}"
        ;;
    "--no-pager diff --check")
        : >"${RELEASE_TEST_STATE:?}/git-no-pager-diff"
        ;;
    "rev-parse HEAD")
        printf '%s\n' "${FAKE_GIT_HEAD_SHA:?}"
        ;;
    "rev-parse @{upstream}")
        printf '%s\n' "${FAKE_GIT_UPSTREAM_SHA:-${FAKE_GIT_HEAD_SHA:?}}"
        ;;
    "rev-parse --short=8 HEAD")
        printf '%s\n' "${FAKE_GIT_HEAD_SHA:0:8}"
        ;;
    "check-ref-format --branch "*)
        exit 0
        ;;
    "ls-remote --exit-code origin refs/heads/"*)
        branch_ref="${!#}"
        printf '%s\t%s\n' "${FAKE_REMOTE_SHA:-${FAKE_GIT_HEAD_SHA:?}}" "$branch_ref"
        ;;
    *)
        printf 'unexpected fake git command: %s\n' "$*" >&2
        exit 127
        ;;
esac
SH

    cat >"$fake_bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
    info)
        exit 0
        ;;
    login)
        [ "$*" = "login --username release-user --password-stdin harbor.example.test" ] \
            || exit 91
        password=""
        IFS= read -r password || true
        [ "$password" = "test-harbor-token" ] || exit 92
        : >"${RELEASE_TEST_STATE:?}/docker-login"
        ;;
    *)
        exit 93
        ;;
esac
SH

    cat >"$fake_bin/xcrun" <<'SH'
#!/usr/bin/env bash
exit 0
SH

    cat >"$fake_bin/node" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "--version" ]; then
    printf 'v22.12.0\n'
    exit 0
fi
exec "${REAL_NODE_BIN:?}" "$@"
SH

    cat >"$fake_bin/npm" <<'SH'
#!/usr/bin/env bash
printf '10.9.0\n'
SH

cat >"$fixture/repo/package_for_release.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

is_preview=false
is_mr_stage=false
for argument in "$@"; do
    [ "$argument" = "--unsigned-preview" ] && is_preview=true
    [ "$argument" = "--unsigned-mr-stage" ] && is_mr_stage=true
done
if [ "$is_preview" != true ] && [ "$is_mr_stage" != true ]; then
    [ "${APPLE_ID:-}" = "release@example.test" ] || exit 81
    [ "${APPLE_APP_SPECIFIC_PASSWORD:-}" = "test-apple-password" ] || exit 82
    [ "${APPLE_TEAM_ID:-}" = "TEAM123456" ] || exit 83
    [ "${CLOUDSMITH_API_KEY:-}" = "test-cloudsmith-key" ] || exit 84
fi
node --version >"${RELEASE_TEST_STATE:?}/package-node-version"
printf '%s\n' "$*" >"${RELEASE_TEST_STATE:?}/package-args"

output_zip=""
preview_output_dir=""
mr_stage_output_dir=""
while [ "$#" -gt 0 ]; do
    if [ "$1" = "--output-zip" ]; then
        output_zip="$2"
        shift 2
        continue
    fi
    if [ "$1" = "--preview-output-dir" ]; then
        preview_output_dir="$2"
        shift 2
        continue
    fi
    if [ "$1" = "--unsigned-mr-stage" ]; then
        mr_stage_output_dir="$2"
        shift 2
        continue
    fi
    shift
done
if [ -n "$preview_output_dir" ]; then
    mkdir -p "$preview_output_dir"
    : >"$preview_output_dir/preview-manifest.json"
    exit 0
fi
if [ -n "$mr_stage_output_dir" ]; then
    mkdir -p "$mr_stage_output_dir"
    : >"$mr_stage_output_dir/mr-release-input.json"
    exit 0
fi
[ -n "$output_zip" ] || exit 85
: >"$output_zip"
SH

    cat >"$fixture/repo/release_build.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

[ "${CLOUDSMITH_API_KEY:-}" = "test-cloudsmith-key" ] || exit 86
printf '%s\n' "$*" >"${RELEASE_TEST_STATE:?}/publish-args"
SH

    chmod +x \
        "$fake_bin/git" \
        "$fake_bin/docker" \
        "$fake_bin/xcrun" \
        "$fake_bin/node" \
        "$fake_bin/npm" \
        "$fixture/repo/package_for_release.sh" \
        "$fixture/repo/release_build.sh"
}

write_release_env() {
    local fixture="$1"

    cat >"$fixture/repo/.env" <<'ENV'
HARBOR_REGISTRY=harbor.example.test
HARBOR_USER=release-user
HARBOR_TOKEN=test-harbor-token
APPLE_ID=release@example.test
APPLE_APP_SPECIFIC_PASSWORD=test-apple-password
APPLE_TEAM_ID=TEAM123456
PORTICO_USER_ID='release-user$(printf unsafe)'
PORTICO_USER_NAME='Release O\'Brien $HOME `printf unsafe`'
CLOUDSMITH_API_KEY=test-cloudsmith-key
CLOUDSMITH_ENTITLEMENT_TOKEN=test-entitlement-token
ENV
    chmod 600 "$fixture/repo/.env"
}

write_runtime_image_attestation() {
    local output_path="$1"
    local source_revision="$2"
    local image_tag="${3:-$source_revision}"

    "$SYSTEM_NODE_BIN" - "$PROJECT_ROOT" "$output_path" "$source_revision" "$image_tag" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [projectRoot, outputPath, sourceRevision, imageTag] = process.argv.slice(2);
const { REQUIRED_IMAGE_NAMES, REQUIRED_PLATFORMS } = require(
  path.join(projectRoot, "src/scripts/validate-runtime-image-attestation.js"),
);
const digest = (character) => `sha256:${character.repeat(64)}`;
const images = REQUIRED_IMAGE_NAMES.map((name, index) => ({
  name,
  reference: `harbor.example.invalid/portico/${name}:${imageTag}`,
  indexDigest: digest(String((index % 9) + 1)),
  platforms: Object.fromEntries(
    REQUIRED_PLATFORMS.map((platform, platformIndex) => [
      platform,
      {
        digest: digest(platformIndex === 0 ? "a" : "b"),
        revision: sourceRevision,
        version: imageTag,
      },
    ]),
  ),
}));
fs.writeFileSync(
  outputPath,
  `${JSON.stringify({ schemaVersion: 1, sourceRevision, tag: imageTag, images }, null, 2)}\n`,
);
NODE
}

run_with_release_env() {
    local fixture="$1"
    local release_extra_path="${portico_RELEASE_EXTRA_PATH_OVERRIDE:-$fixture/fake-bin}"
    shift
    env \
        portico_RELEASE_REPO_ROOT="$fixture/repo" \
        portico_RELEASE_EXTRA_PATH="$release_extra_path" \
        RELEASE_TEST_STATE="$fixture" \
        REAL_NODE_BIN="$SYSTEM_NODE_BIN" \
        FAKE_GIT_HEAD_SHA="1234567890abcdef1234567890abcdef12345678" \
        HARBOR_REGISTRY="harbor.example.test" \
        HARBOR_USER="release-user" \
        HARBOR_TOKEN="test-harbor-token" \
        APPLE_ID="release@example.test" \
        APPLE_APP_SPECIFIC_PASSWORD="test-apple-password" \
        APPLE_TEAM_ID="TEAM123456" \
        CLOUDSMITH_API_KEY="test-cloudsmith-key" \
        CLOUDSMITH_ENTITLEMENT_TOKEN="test-entitlement-token" \
        "$RUNNER" "$@"
}

test_package_and_publish_from_normal_shell() {
    local fixture="$TMP_DIR/success"
    local output="$fixture/output.txt"
    local build_id="01012026-12345678"
    local expected_zip="$fixture/repo/release/portico_dev-${build_id}.zip"
    local expected_publish_zip
    write_fixture "$fixture"

    run_with_release_env "$fixture" all "$build_id" >"$output" 2>&1 \
        || fail "normal-shell package and publish workflow failed"

    [ -f "$fixture/docker-login" ] || fail "runner did not authenticate to Harbor"
    [ -f "$fixture/git-no-pager-diff" ] \
        || fail "runner did not disable the Git pager during source validation"
    [ "$(cat "$fixture/package-node-version")" = "v22.12.0" ] \
        || fail "compatible Node runtime did not reach the packager"
    [ -f "$expected_zip" ] || fail "runner did not produce the deterministic ZIP path"
    expected_publish_zip="$(cd "$(dirname "$expected_zip")" && pwd -P)/$(basename "$expected_zip")"
    assert_contains "$fixture/package-args" \
        "$build_id --channel dev --full-sha 1234567890abcdef1234567890abcdef12345678 --docker-image-tag $build_id --output-zip $expected_zip --yes" \
        "runner did not package the exact pushed SHA and build id"
    assert_contains "$fixture/publish-args" \
        "$expected_publish_zip --channel dev --yes --wait-for-sync --mark-update-ready" \
        "runner did not publish the exact newly packaged ZIP"
    assert_not_contains "$output" "test-harbor-token" "runner printed the Harbor token"
    assert_not_contains "$output" "test-apple-password" "runner printed the Apple password"
    assert_not_contains "$output" "test-cloudsmith-key" "runner printed the Cloudsmith key"
    assert_not_contains "$output" "test-entitlement-token" "runner printed the Cloudsmith entitlement token"
}

test_custom_channel_package_and_publish() {
    local fixture="$TMP_DIR/custom-channel"
    local output="$fixture/output.txt"
    local build_id="01032026-abcdef12"
    local expected_zip="$fixture/repo/release/portico_team-alpha-${build_id}.zip"
    local expected_publish_zip
    write_fixture "$fixture"

    run_with_release_env "$fixture" all "$build_id" --channel " Team-Alpha " \
        >"$output" 2>&1 \
        || fail "custom-channel package and publish workflow failed"

    [ -f "$expected_zip" ] || fail "custom channel did not use its canonical ZIP name"
    expected_publish_zip="$(cd "$(dirname "$expected_zip")" && pwd -P)/$(basename "$expected_zip")"
    assert_contains "$fixture/package-args" \
        "$build_id --channel team-alpha --full-sha 1234567890abcdef1234567890abcdef12345678 --docker-image-tag $build_id --output-zip $expected_zip --yes" \
        "runner did not pass the normalized custom channel to packaging"
    assert_contains "$fixture/publish-args" \
        "$expected_publish_zip --channel team-alpha --yes --wait-for-sync --mark-update-ready" \
        "runner did not publish the custom-channel ZIP with matching identity"
}

test_attested_ci_package_avoids_docker_and_forwards_fixed_inputs() {
    local fixture="$TMP_DIR/attested-ci"
    local output="$fixture/output.txt"
    local source_revision="1234567890abcdef1234567890abcdef12345678"
    local build_id="01042026-12345678"
    local attestation="$fixture/runtime-images.json"
    local host_binaries="$fixture/host-mcp-binaries"
    write_fixture "$fixture"
    mkdir -p "$host_binaries"
    write_runtime_image_attestation "$attestation" "$source_revision" "$build_id"

    env \
        portico_RELEASE_REPO_ROOT="$fixture/repo" \
        portico_RELEASE_EXTRA_PATH="$fixture/fake-bin" \
        RELEASE_TEST_STATE="$fixture" \
        REAL_NODE_BIN="$SYSTEM_NODE_BIN" \
        FAKE_GIT_HEAD_SHA="$source_revision" \
        APPLE_ID="release@example.test" \
        APPLE_APP_SPECIFIC_PASSWORD="test-apple-password" \
        APPLE_TEAM_ID="TEAM123456" \
        CLOUDSMITH_API_KEY="test-cloudsmith-key" \
        CLOUDSMITH_ENTITLEMENT_TOKEN="test-entitlement-token" \
        "$RUNNER" package "$build_id" \
            --channel dev \
            --source-revision "$source_revision" \
            --docker-image-tag "$build_id" \
            --release-timestamp "2026-01-04T12:34:56.000Z" \
            --host-mcp-binaries-dir "$host_binaries" \
            --image-attestation "$attestation" \
            >"$output" 2>&1 \
        || fail "attested CI packaging path failed"

    [ ! -f "$fixture/docker-login" ] \
        || fail "attested CI packaging contacted Harbor through the local Docker path"
    assert_contains "$fixture/package-args" \
        "--docker-image-tag $build_id" \
        "attested CI packaging did not use the local build-id image tag"
    assert_not_contains "$fixture/package-args" \
        "--docker-image-tag $source_revision" \
        "attested CI packaging regressed to a full-SHA image tag"
    assert_contains "$fixture/package-args" \
        "--release-timestamp 2026-01-04T12:34:56.000Z" \
        "attested CI packaging did not forward the fixed timestamp"
    assert_contains "$fixture/package-args" \
        "--host-mcp-binaries-dir $host_binaries --host-mcp-source-revision $source_revision" \
        "attested CI packaging did not require revision-marked host binaries"
    assert_contains "$fixture/package-args" \
        "--image-attestation $attestation" \
        "attested CI packaging did not forward the image attestation"
    assert_not_contains "$output" "test-entitlement-token" \
        "attested CI packaging printed the entitlement token"
}

test_unsigned_preview_does_not_require_release_credentials() {
    local fixture="$TMP_DIR/unsigned-preview"
    local output="$fixture/output.txt"
    local source_revision="1234567890abcdef1234567890abcdef12345678"
    local host_binaries="$fixture/host-mcp-binaries"
    local preview_output="$fixture/preview-output"
    write_fixture "$fixture"
    mkdir -p "$host_binaries"

    env \
        portico_RELEASE_REPO_ROOT="$fixture/repo" \
        portico_RELEASE_EXTRA_PATH="$fixture/fake-bin" \
        RELEASE_TEST_STATE="$fixture" \
        REAL_NODE_BIN="$SYSTEM_NODE_BIN" \
        FAKE_GIT_HEAD_SHA="$source_revision" \
        "$RUNNER" preview x64 \
            --channel dev \
            --source-revision "$source_revision" \
            --release-timestamp "2026-01-05T01:02:03.000Z" \
            --host-mcp-binaries-dir "$host_binaries" \
            --preview-output-dir "$preview_output" \
            >"$output" 2>&1 \
        || fail "unsigned preview path required protected release credentials"

    [ -f "$preview_output/preview-manifest.json" ] \
        || fail "unsigned preview did not produce its artifact directory"
    [ ! -f "$fixture/docker-login" ] || fail "unsigned preview contacted Harbor"
    assert_contains "$fixture/package-args" \
        "01052026-12345678 --channel dev --full-sha $source_revision" \
        "unsigned preview did not derive deterministic metadata"
    assert_contains "$fixture/package-args" \
        "--unsigned-preview x64 --preview-output-dir $preview_output" \
        "unsigned preview did not remain isolated to one architecture"
}

test_stage_mr_is_credential_free_and_uses_exact_identity() {
    local fixture="$TMP_DIR/stage-mr"
    local output="$fixture/output.txt"
    local source_revision="1234567890abcdef1234567890abcdef12345678"
    local host_binaries="$fixture/host-mcp-binaries"
    local stage_output="$fixture/mr-stage"
    write_fixture "$fixture"
    mkdir -p "$host_binaries"
    cat >"$fixture/repo/.env" <<'ENV'
CLOUDSMITH_API_KEY=must-not-be-loaded
ENV
    chmod 600 "$fixture/repo/.env"

    if ! env \
        -u HARBOR_TOKEN \
        -u APPLE_CODESIGN_P12_BASE64 \
        -u APPLE_CODESIGN_P12_PASSWORD \
        -u APPLE_ID \
        -u APPLE_APP_SPECIFIC_PASSWORD \
        -u CLOUDSMITH_API_KEY \
        -u CLOUDSMITH_ENTITLEMENT_TOKEN \
        portico_RELEASE_REPO_ROOT="$fixture/repo" \
        portico_RELEASE_EXTRA_PATH="$fixture/fake-bin" \
        RELEASE_TEST_STATE="$fixture" \
        REAL_NODE_BIN="$SYSTEM_NODE_BIN" \
        FAKE_GIT_HEAD_SHA="$source_revision" \
        "$RUNNER" stage-mr \
            --channel mr-42 \
            --source-revision "$source_revision" \
            --release-timestamp "2026-01-07T01:02:03.000Z" \
            --host-mcp-binaries-dir "$host_binaries" \
            --stage-output-dir "$stage_output" \
            --mr-project-id 77 \
            --mr-project-path portico/portico \
            --mr-iid 42 \
            --mr-target-branch feature/target \
            >"$output" 2>&1; then
        sed -n '1,120p' "$output" >&2
        fail "credential-free MR staging failed"
    fi

    [ -f "$stage_output/mr-release-input.json" ] \
        || fail "MR staging did not emit its contract"
    assert_not_contains "$output" "Loaded release environment" \
        "stage-mr loaded the protected repository .env"
    assert_contains "$fixture/package-args" \
        "01072026-12345678 --channel mr-42 --full-sha $source_revision --docker-image-tag mr-42-$source_revision" \
        "stage-mr did not derive deterministic MR release identity"
    assert_contains "$fixture/package-args" \
        "--unsigned-mr-stage $stage_output --mr-project-id 77 --mr-project-path portico/portico --mr-iid 42 --mr-target-branch feature/target" \
        "stage-mr did not forward the bounded broker contract"

    if CLOUDSMITH_API_KEY=unexpected-secret \
        run_with_release_env "$fixture" stage-mr \
            --channel mr-42 \
            --source-revision "$source_revision" \
            --release-timestamp "2026-01-07T01:02:03.000Z" \
            --host-mcp-binaries-dir "$host_binaries" \
            --stage-output-dir "$stage_output/second" \
            --mr-project-id 77 \
            --mr-project-path portico/portico \
            --mr-iid 42 \
            --mr-target-branch feature/target \
            >"$output" 2>&1; then
        fail "stage-mr accepted a credential-bearing environment"
    fi
    assert_contains "$output" "stage-mr refuses credential-bearing environment variable" \
        "stage-mr secret rejection was not actionable"
}

test_publish_rejects_stale_branch_and_forwards_cloudsmith_options() {
    local fixture="$TMP_DIR/branch-tip"
    local output="$fixture/output.txt"
    local source_revision="1234567890abcdef1234567890abcdef12345678"
    local payload="$fixture/repo/release/portico_dev-01062026-12345678.zip"
    local canonical_payload=""
    write_fixture "$fixture"
    : > "$payload"
    canonical_payload="$(cd "$(dirname "$payload")" && pwd -P)/$(basename "$payload")"

    env \
        portico_RELEASE_REPO_ROOT="$fixture/repo" \
        portico_RELEASE_EXTRA_PATH="$fixture/fake-bin" \
        RELEASE_TEST_STATE="$fixture" \
        REAL_NODE_BIN="$SYSTEM_NODE_BIN" \
        FAKE_GIT_HEAD_SHA="$source_revision" \
        FAKE_REMOTE_SHA="$source_revision" \
        CLOUDSMITH_API_KEY="test-cloudsmith-key" \
        CLOUDSMITH_ENTITLEMENT_TOKEN="test-entitlement-token" \
        "$RUNNER" publish "$payload" \
            --channel dev \
            --source-revision "$source_revision" \
            --branch dev \
            --require-branch-tip \
            --republish \
            --wait-for-sync \
            --mark-update-ready \
            >"$output" 2>&1 \
        || fail "current branch-tip publication failed"

    assert_contains "$fixture/publish-args" \
        "$canonical_payload --channel dev --yes --republish --wait-for-sync --mark-update-ready" \
        "publish did not forward the idempotent republish and synchronization options"

    rm -f "$fixture/publish-args"
    local stale_status=0
    set +e
    env \
        portico_RELEASE_REPO_ROOT="$fixture/repo" \
        portico_RELEASE_EXTRA_PATH="$fixture/fake-bin" \
        RELEASE_TEST_STATE="$fixture" \
        REAL_NODE_BIN="$SYSTEM_NODE_BIN" \
        FAKE_GIT_HEAD_SHA="$source_revision" \
        FAKE_REMOTE_SHA="abcdefabcdefabcdefabcdefabcdefabcdefabcd" \
        CLOUDSMITH_API_KEY="test-cloudsmith-key" \
        CLOUDSMITH_ENTITLEMENT_TOKEN="test-entitlement-token" \
        "$RUNNER" publish "$payload" \
            --channel dev \
            --source-revision "$source_revision" \
            --branch dev \
            --require-branch-tip \
            >"$output" 2>&1
    stale_status=$?
    set -e
    [ "$stale_status" -eq 3 ] \
        || fail "stale release pipeline returned $stale_status instead of the distinguishable status 3"
    [ ! -f "$fixture/publish-args" ] \
        || fail "stale release pipeline reached Cloudsmith publication"
    assert_contains "$output" "stale release pipeline" \
        "stale branch-tip rejection was not actionable"
}

test_missing_secret_fails_closed() {
    local fixture="$TMP_DIR/missing-secret"
    local output="$fixture/output.txt"
    write_fixture "$fixture"

    if env \
        portico_RELEASE_REPO_ROOT="$fixture/repo" \
        portico_RELEASE_EXTRA_PATH="$fixture/fake-bin" \
        RELEASE_TEST_STATE="$fixture" \
        FAKE_GIT_HEAD_SHA="1234567890abcdef1234567890abcdef12345678" \
        HARBOR_REGISTRY="harbor.example.test" \
        HARBOR_USER="release-user" \
        HARBOR_TOKEN="test-harbor-token" \
        APPLE_ID="release@example.test" \
        APPLE_TEAM_ID="TEAM123456" \
        CLOUDSMITH_API_KEY="test-cloudsmith-key" \
        "$RUNNER" preflight >"$output" 2>&1; then
        fail "preflight accepted a missing Apple app-specific password"
    fi

    assert_contains "$output" \
        "missing required environment variable: APPLE_APP_SPECIFIC_PASSWORD" \
        "preflight did not name the missing credential"
    [ ! -f "$fixture/docker-login" ] || fail "failed preflight should not contact Harbor"
}

test_unpushed_source_fails_closed() {
    local fixture="$TMP_DIR/unpushed"
    local output="$fixture/output.txt"
    write_fixture "$fixture"

    if FAKE_GIT_UPSTREAM_SHA="abcdefabcdefabcdefabcdefabcdefabcdefabcd" \
        run_with_release_env "$fixture" preflight >"$output" 2>&1; then
        fail "preflight accepted source that was not pushed"
    fi

    assert_contains "$output" \
        "HEAD does not match its upstream" \
        "preflight did not reject an unpushed commit"
}

test_release_skips_stale_node_and_selects_compatible_runtime() {
    local fixture="$TMP_DIR/node-selection"
    local stale_bin="$fixture/stale-bin"
    local output="$fixture/output.txt"
    write_fixture "$fixture"
    mkdir -p "$stale_bin"

    cat >"$stale_bin/node" <<'SH'
#!/usr/bin/env bash
printf 'v20.9.0\n'
SH
    cat >"$stale_bin/npm" <<'SH'
#!/usr/bin/env bash
printf '10.1.0\n'
SH
    chmod +x "$stale_bin/node" "$stale_bin/npm"

    portico_RELEASE_EXTRA_PATH_OVERRIDE="$stale_bin:$fixture/fake-bin" \
        run_with_release_env "$fixture" preflight >"$output" 2>&1 \
        || fail "preflight did not select the compatible Node runtime"

    assert_contains "$output" \
        "Using Node.js v22.12.0 from $fixture/fake-bin/node for release packaging." \
        "preflight did not skip the stale Node runtime"
}

test_repo_dotenv_is_loaded_exported_and_not_traced() {
    local fixture="$TMP_DIR/repo-dotenv"
    local output="$fixture/output.txt"
    local build_id="01022026-12345678"
    local expected_zip="$fixture/repo/release/portico_dev-${build_id}.zip"
    write_fixture "$fixture"
    write_release_env "$fixture"

    env \
        portico_RELEASE_REPO_ROOT="$fixture/repo" \
        portico_RELEASE_EXTRA_PATH="$fixture/fake-bin" \
        RELEASE_TEST_STATE="$fixture" \
        FAKE_GIT_HEAD_SHA="1234567890abcdef1234567890abcdef12345678" \
        HARBOR_TOKEN="wrong-inherited-harbor-token" \
        APPLE_ID="wrong-inherited@example.test" \
        APPLE_APP_SPECIFIC_PASSWORD="wrong-inherited-apple-password" \
        APPLE_TEAM_ID="WRONGTEAM" \
        CLOUDSMITH_API_KEY="wrong-inherited-cloudsmith-key" \
        bash -x "$RUNNER" all "$build_id" >"$output" 2>&1 \
        || fail "runner did not load the protected repository .env"

    [ -f "$fixture/docker-login" ] || fail "dotenv credentials did not reach Docker login"
    [ -f "$expected_zip" ] || fail "dotenv credentials did not reach the packager"
    assert_contains "$output" \
        "Loaded release environment from protected repository .env." \
        "runner did not report the protected dotenv handoff"
    assert_not_contains "$output" "test-harbor-token" "runner traced the Harbor token"
    assert_not_contains "$output" "test-apple-password" "runner traced the Apple password"
    assert_not_contains "$output" "test-cloudsmith-key" "runner traced the Cloudsmith key"
}

test_repo_dotenv_requires_private_permissions() {
    local fixture="$TMP_DIR/repo-dotenv-mode"
    local output="$fixture/output.txt"
    write_fixture "$fixture"
    write_release_env "$fixture"
    chmod 644 "$fixture/repo/.env"

    if env \
        portico_RELEASE_REPO_ROOT="$fixture/repo" \
        portico_RELEASE_EXTRA_PATH="$fixture/fake-bin" \
        RELEASE_TEST_STATE="$fixture" \
        FAKE_GIT_HEAD_SHA="1234567890abcdef1234567890abcdef12345678" \
        "$RUNNER" preflight >"$output" 2>&1; then
        fail "runner accepted a repository .env with unsafe permissions"
    fi

    assert_contains "$output" \
        "release environment must have mode 0600" \
        "runner did not explain the protected dotenv permission failure"
    assert_not_contains "$output" "test-harbor-token" "permission failure printed the Harbor token"
    [ ! -f "$fixture/docker-login" ] || fail "unsafe dotenv should fail before Harbor login"
}

test_packaging_executes_the_staged_builder_directly() {
    local packager="$PROJECT_ROOT/package_for_release.sh"

    assert_contains "$packager" \
        'local electron_builder="$SOURCE_STAGE_DIR/electron-app/node_modules/.bin/electron-builder"' \
        "packager does not bind Electron builds to the staged dependency"
    assert_contains "$packager" \
        '"$electron_builder" \' \
        "packager does not execute the staged Electron builder directly"
    assert_not_contains "$packager" \
        "npx electron-builder" \
        "packager still routes Electron builds through the npm exec wrapper"
}

dev_release_test_functions=(
  test_package_and_publish_from_normal_shell
  test_custom_channel_package_and_publish
  test_attested_ci_package_avoids_docker_and_forwards_fixed_inputs
  test_unsigned_preview_does_not_require_release_credentials
  test_stage_mr_is_credential_free_and_uses_exact_identity
  test_publish_rejects_stale_branch_and_forwards_cloudsmith_options
  test_missing_secret_fails_closed
  test_unpushed_source_fails_closed
  test_release_skips_stale_node_and_selects_compatible_runtime
  test_repo_dotenv_is_loaded_exported_and_not_traced
  test_repo_dotenv_requires_private_permissions
  test_packaging_executes_the_staged_builder_directly
)
dev_release_shared_fixture_path="$TMP_DIR/shared-fixture"
write_fixture "$dev_release_shared_fixture_path"
DEV_RELEASE_SHARED_FIXTURE="$dev_release_shared_fixture_path"
run_shell_test_functions_parallel \
  "${DEV_RELEASE_TEST_CONCURRENCY:-8}" \
  "${dev_release_test_functions[@]}"

printf 'PASS: non-Zed dev release runner\n'
