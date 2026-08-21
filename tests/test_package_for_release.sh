#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PACKAGE_SCRIPT="$PROJECT_ROOT/package_for_release.sh"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

make_fake_required_host_mcp_binaries() {
  local root="$1"
  local target

  for target in \
    aarch64-apple-darwin \
    x86_64-apple-darwin \
    x86_64-unknown-linux-gnu \
    aarch64-unknown-linux-gnu
  do
    mkdir -p "$root/$target"
    printf '#!/bin/sh\nexit 0\n' > "$root/$target/mcp-orc"
    chmod +x "$root/$target/mcp-orc"
  done
}

make_minimal_stage_managed_root_source() {
  local source_root="$1"

  mkdir -p \
    "$source_root/electron-app/scripts" \
    "$source_root/electron-app/build-resources"
  cp "$PROJECT_ROOT/electron-app/scripts/prepare-cloudsmith-resource.js" \
    "$source_root/electron-app/scripts/prepare-cloudsmith-resource.js"
  printf '%s\n' \
    'CLOUDSMITH_OWNER="portico"' \
    'CLOUDSMITH_REPO="portico"' \
    'CLOUDSMITH_API_BASE="https://api.cloudsmith.io/v1"' \
    'CLOUDSMITH_DL_BASE="https://dl.artifacts.example.invalid"' \
    'CLOUDSMITH_ENTITLEMENT_TOKEN="test-read-token"' \
    'CLOUDSMITH_API_KEY="test-api-key"' \
    > "$source_root/electron-app/build-resources/cloudsmith.env"
}

make_runtime_image_attestation() {
  local output_path="$1"
  local source_revision="$2"
  local tag="${3:-$source_revision}"

  node - "$PROJECT_ROOT" "$output_path" "$source_revision" "$tag" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [projectRoot, outputPath, sourceRevision, tag] = process.argv.slice(2);
const { REQUIRED_IMAGE_NAMES, REQUIRED_PLATFORMS } = require(
  path.join(projectRoot, "src/scripts/validate-runtime-image-attestation.js"),
);
const digest = (character) => `sha256:${character.repeat(64)}`;
const images = REQUIRED_IMAGE_NAMES.map((name, index) => ({
  name,
  reference: `harbor.example.invalid/portico/${name}:${tag}`,
  indexDigest: digest(String((index % 9) + 1)),
  platforms: Object.fromEntries(
    REQUIRED_PLATFORMS.map((platform, platformIndex) => [
      platform,
      {
        digest: digest(platformIndex === 0 ? "a" : "b"),
        revision: sourceRevision,
        version: tag,
      },
    ]),
  ),
}));
fs.writeFileSync(
  outputPath,
  `${JSON.stringify({ schemaVersion: 1, sourceRevision, tag, images }, null, 2)}\n`,
);
NODE
}

make_fake_packaged_app_with_host_mcp() {
  local app_path="$1"

  mkdir -p "$app_path/Contents/MacOS"
  mkdir -p "$app_path/Contents/Resources/host-mcp-binaries/aarch64-apple-darwin"
  mkdir -p "$app_path/Contents/Resources/host-mcp-binaries/x86_64-apple-darwin"
  : > "$app_path/Contents/MacOS/Portico"
  : > "$app_path/Contents/Resources/host-mcp-binaries/aarch64-apple-darwin/mcp-orc"
  : > "$app_path/Contents/Resources/host-mcp-binaries/x86_64-apple-darwin/mcp-orc"
  chmod +x "$app_path/Contents/Resources/host-mcp-binaries/aarch64-apple-darwin/mcp-orc"
  chmod +x "$app_path/Contents/Resources/host-mcp-binaries/x86_64-apple-darwin/mcp-orc"
}

make_fake_packaged_app_with_release_resources() {
  local app_path="$1"
  local staged_build_info="$2"
  local staged_prereq_download="$3"
    local staged_reconcile_helper="$4"
    local staged_electron_dir

    staged_electron_dir="$(dirname "$staged_build_info")"
    mkdir -p \
      "$staged_electron_dir/build-resources" \
      "$staged_electron_dir/scripts" \
      "$staged_electron_dir/src/scripts"
    if [ ! -f "$staged_electron_dir/build-resources/cloudsmith.env" ]; then
      printf '%s\n' \
        'CLOUDSMITH_OWNER="portico"' \
        'CLOUDSMITH_REPO="portico"' \
        'CLOUDSMITH_API_BASE="https://api.cloudsmith.io/v1"' \
        'CLOUDSMITH_DL_BASE="https://dl.artifacts.example.invalid"' \
        'CLOUDSMITH_ENTITLEMENT_TOKEN="test-read-token"' \
        'CLOUDSMITH_API_KEY="test-api-key"' \
        > "$staged_electron_dir/build-resources/cloudsmith.env"
    fi
    if [ ! -f "$staged_electron_dir/scripts/prepare-cloudsmith-resource.js" ]; then
      cp "$PROJECT_ROOT/electron-app/scripts/prepare-cloudsmith-resource.js" \
        "$staged_electron_dir/scripts/prepare-cloudsmith-resource.js"
    fi
    if [ ! -f "$staged_electron_dir/src/scripts/prepare-update-cloudsmith.sh" ]; then
      cp "$PROJECT_ROOT/electron-app/src/scripts/prepare-update-cloudsmith.sh" \
        "$staged_electron_dir/src/scripts/prepare-update-cloudsmith.sh"
    fi

    make_fake_packaged_app_with_host_mcp "$app_path"
  mkdir -p "$app_path/Contents/Resources/prereq-scripts"
  cp "$staged_build_info" "$app_path/Contents/Resources/build-info.json"
  cp "$staged_prereq_download" "$app_path/Contents/Resources/prereq-scripts/prereq-download.sh"
    cp "$staged_reconcile_helper" "$app_path/Contents/Resources/prereq-scripts/managed-runtime-reconcile.sh"
    cp "$staged_electron_dir/src/scripts/prepare-update-cloudsmith.sh" \
      "$app_path/Contents/Resources/prereq-scripts/prepare-update-cloudsmith.sh"
    cp "$staged_electron_dir/build-resources/cloudsmith.env" \
      "$app_path/Contents/Resources/cloudsmith.env"
}

make_staged_release_resources() {
  local source_stage_dir="$1"
  local build_id="${2:-03122026-deadbeef}"
  local full_sha="${3:-deadbeefcafefeeddeadbeefcafefeeddeadbeef}"
  local timestamp="${4:-2026-03-12T00:00:00.000Z}"

  mkdir -p \
    "$source_stage_dir/electron-app/build-resources" \
    "$source_stage_dir/electron-app/scripts" \
    "$source_stage_dir/electron-app/src/scripts" \
    "$source_stage_dir/src/scripts"
  cat > "$source_stage_dir/electron-app/build-info.json" <<EOF
{
  "buildNumber": "${build_id}",
  "fullSha": "${full_sha}",
  "date": "03122026",
  "timestamp": "${timestamp}",
  "channel": "portico_dev"
}
EOF
  printf '%s\n' '#!/usr/bin/env bash' 'echo prereq' > "$source_stage_dir/src/scripts/prereq-download.sh"
  chmod +x "$source_stage_dir/src/scripts/prereq-download.sh"
  printf '%s\n' '#!/usr/bin/env bash' 'echo helper' > "$source_stage_dir/src/scripts/managed-runtime-reconcile.sh"
  chmod +x "$source_stage_dir/src/scripts/managed-runtime-reconcile.sh"
  cp "$PROJECT_ROOT/electron-app/src/scripts/prepare-update-cloudsmith.sh" \
    "$source_stage_dir/electron-app/src/scripts/prepare-update-cloudsmith.sh"
  cp "$PROJECT_ROOT/electron-app/scripts/prepare-cloudsmith-resource.js" \
    "$source_stage_dir/electron-app/scripts/prepare-cloudsmith-resource.js"
  printf '%s\n' \
    'CLOUDSMITH_OWNER="portico"' \
    'CLOUDSMITH_REPO="portico"' \
    'CLOUDSMITH_API_BASE="https://api.cloudsmith.io/v1"' \
    'CLOUDSMITH_DL_BASE="https://dl.artifacts.example.invalid"' \
    'CLOUDSMITH_ENTITLEMENT_TOKEN="test-read-token"' \
    'CLOUDSMITH_API_KEY="test-api-key"' \
    > "$source_stage_dir/electron-app/build-resources/cloudsmith.env"
}

test_dmg_is_notarized_before_dmg_staple() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir log_file app_path dmg_path
    tmp_dir="$(mktemp -d)"
    log_file="$tmp_dir/calls.log"
    app_path="$tmp_dir/Portico.app"
    dmg_path="$tmp_dir/Portico.dmg"

    make_fake_packaged_app_with_host_mcp "$app_path"
    : > "$dmg_path"

    export APPLE_ID="dev@example.com"
    export APPLE_APP_SPECIFIC_PASSWORD="app-password"
    export APPLE_TEAM_ID="TEAMID1234"

    codesign() {
      printf 'codesign %s\n' "$*" >> "$log_file"
    }

    spctl() {
      printf 'spctl %s\n' "$*" >> "$log_file"
    }

    xcrun() {
      printf 'xcrun %s\n' "$*" >> "$log_file"
    }

    verify_packaged_app_release_integrity() {
      :
    }

    file() {
      case "$2" in
        */aarch64-apple-darwin/mcp-orc)
          printf '%s\n' 'Mach-O 64-bit executable arm64'
          ;;
        */x86_64-apple-darwin/mcp-orc)
          printf '%s\n' 'Mach-O 64-bit executable x86_64'
          ;;
        *)
          return 1
          ;;
      esac
    }

    verify_and_staple_artifacts "$app_path" "$dmg_path"

    local notary_line dmg_staple_line codesign_count
    notary_line="$(awk '/notarytool submit/ {print NR; exit}' "$log_file")"
    dmg_staple_line="$(awk '/stapler staple .*Portico\.dmg/ {print NR; exit}' "$log_file")"

    [ -n "$notary_line" ] || fail "expected notarytool submit call for DMG"
    [ -n "$dmg_staple_line" ] || fail "expected stapler call for DMG"
    [ "$notary_line" -lt "$dmg_staple_line" ] || fail "DMG stapler ran before DMG notarization"
    codesign_count="$(grep -c '^codesign --verify ' "$log_file")"
    [ "$codesign_count" -eq 4 ] || fail "expected app and DMG signature verification before and after stapling"
    grep -q 'spctl --assess --type execute .*Portico\.app' "$log_file" \
      || fail "expected app Gatekeeper verification after stapling"
    grep -q 'spctl --assess --type open --context context:primary-signature .*Portico\.dmg' "$log_file" \
      || fail "expected DMG Gatekeeper verification after stapling"
    grep -q 'xcrun stapler validate .*Portico\.app' "$log_file" \
      || fail "expected app notarization ticket validation after stapling"
    grep -q 'xcrun stapler validate .*Portico\.dmg' "$log_file" \
      || fail "expected DMG notarization ticket validation after stapling"
  )
}

test_per_arch_output_rejects_unexpected_architecture() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir output status
    tmp_dir="$(mktemp -d)"

    make_fake_packaged_app_with_host_mcp "$tmp_dir/mac-arm64/Portico.app"
    make_fake_packaged_app_with_host_mcp "$tmp_dir/mac-x64/Portico.app"
    : > "$tmp_dir/Portico-1.0.0-arm64.dmg"
    : > "$tmp_dir/Portico-1.0.0.dmg"

    export APPLE_ID="dev@example.com"
    export APPLE_APP_SPECIFIC_PASSWORD="app-password"
    export APPLE_TEAM_ID="TEAMID1234"

    codesign() { :; }
    spctl() { :; }
    xcrun() { :; }
    verify_packaged_app_release_integrity() { :; }
    file() {
      case "$2" in
        */mac-arm64/Portico\ AI\ Chat.app/Contents/MacOS/Portico\ AI\ Chat)
          printf '%s\n' 'Mach-O 64-bit executable arm64'
          ;;
        */mac-x64/Portico\ AI\ Chat.app/Contents/MacOS/Portico\ AI\ Chat)
          printf '%s\n' 'Mach-O 64-bit executable x86_64'
          ;;
        */aarch64-apple-darwin/mcp-orc)
          printf '%s\n' 'Mach-O 64-bit executable arm64'
          ;;
        */x86_64-apple-darwin/mcp-orc)
          printf '%s\n' 'Mach-O 64-bit executable x86_64'
          ;;
        *)
          return 1
          ;;
      esac
    }

    set +e
    output="$(finalize_output_dir_macos_artifacts "$tmp_dir" arm64 2>&1)"
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "arm64 build directory containing x64 artifacts should be rejected"
    printf '%s' "$output" | grep -q 'unexpected x64 app' \
      || fail "unexpected architecture rejection did not identify the x64 app"

    rm -rf "$tmp_dir"
  )
}

test_per_arch_output_records_only_requested_architecture() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir
    tmp_dir="$(mktemp -d)"
    make_fake_packaged_app_with_host_mcp "$tmp_dir/mac-arm64/Portico.app"
    : > "$tmp_dir/Portico-1.0.0-arm64.dmg"

    export APPLE_ID="dev@example.com"
    export APPLE_APP_SPECIFIC_PASSWORD="app-password"
    export APPLE_TEAM_ID="TEAMID1234"

    codesign() { :; }
    spctl() { :; }
    xcrun() { :; }
    verify_packaged_app_release_integrity() { :; }
    file() {
      case "$2" in
        */Contents/MacOS/Portico\ AI\ Chat|*/aarch64-apple-darwin/mcp-orc)
          printf '%s\n' 'Mach-O 64-bit executable arm64'
          ;;
        */x86_64-apple-darwin/mcp-orc)
          printf '%s\n' 'Mach-O 64-bit executable x86_64'
          ;;
        *)
          return 1
          ;;
      esac
    }

    finalize_output_dir_macos_artifacts "$tmp_dir" arm64

    [ "$APP_ARM64" = "$tmp_dir/mac-arm64/Portico.app" ] || fail "arm64 app not captured"
    [ "$DMG_ARM64" = "$tmp_dir/Portico-1.0.0-arm64.dmg" ] || fail "arm64 dmg not captured"
    [ -z "$APP_X64" ] || fail "arm64 finalization populated the x64 app slot"
    [ -z "$DMG_X64" ] || fail "arm64 finalization populated the x64 DMG slot"

    rm -rf "$tmp_dir"
  )
}

test_detect_app_arch_prefers_binary_over_parent_dir_name() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir app_path
    tmp_dir="$(mktemp -d)"
    app_path="$tmp_dir/darwin-arm64/mac/Portico.app"

    mkdir -p "$app_path/Contents/MacOS"
    : > "$app_path/Contents/MacOS/Portico"

    file() {
      printf '%s\n' 'Mach-O 64-bit executable x86_64'
    }

    [ "$(detect_app_arch "$app_path")" = "x64" ] || fail "binary inspection did not override parent dir name"
  )
}

test_ensure_arch_artifacts_rejects_explicit_app_arch_mismatch() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir output status
    tmp_dir="$(mktemp -d)"

    APP_ARM64="$tmp_dir/explicit-arm64/Portico.app"
    DMG_ARM64="$tmp_dir/explicit-arm64/Portico-arm64.dmg"

    make_fake_packaged_app_with_host_mcp "$APP_ARM64"
    : > "$DMG_ARM64"

    file() {
      case "$2" in
        */Contents/MacOS/Portico\ AI\ Chat)
          printf '%s\n' 'Mach-O 64-bit executable x86_64'
          ;;
        *)
          printf '%s\n' 'Mach-O 64-bit executable x86_64'
          ;;
      esac
    }

    set +e
    output="$(ensure_arch_artifacts arm64 2>&1)"
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "expected explicit arm64 app input with x64 executable to be rejected"
    printf '%s' "$output" | grep -q "Packaged app architecture mismatch for arm64 slot" || fail "arch mismatch rejection did not explain the bad slot"

    rm -rf "$tmp_dir"
  )
}

test_preflight_marks_stale_auto_discovered_artifacts_for_rebuild_on_macos() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir app_path dmg_path stale_build_info output output_file
    tmp_dir="$(mktemp -d)"
    SOURCE_STAGE_DIR="$tmp_dir/source"
    ARTIFACT_SEARCH_ROOT="$tmp_dir/dist"
    BUILD_ID="03122026-deadbeef"
    FULL_SHA="deadbeefcafefeeddeadbeefcafefeeddeadbeef"
    app_path="$ARTIFACT_SEARCH_ROOT/mac-arm64/Portico.app"
    dmg_path="$ARTIFACT_SEARCH_ROOT/Portico-1.0.0-arm64.dmg"
    stale_build_info="$tmp_dir/stale-build-info.json"
    output_file="$tmp_dir/preflight-output.log"

    make_staged_release_resources "$SOURCE_STAGE_DIR" "$BUILD_ID" "$FULL_SHA"
    make_staged_release_resources "$tmp_dir/stale-source" "$BUILD_ID" "$FULL_SHA" "2026-03-11T00:00:00.000Z"
    cp "$tmp_dir/stale-source/electron-app/build-info.json" "$stale_build_info"
    make_fake_packaged_app_with_release_resources \
      "$app_path" \
      "$stale_build_info" \
      "$SOURCE_STAGE_DIR/src/scripts/prereq-download.sh" \
      "$SOURCE_STAGE_DIR/src/scripts/managed-runtime-reconcile.sh"
    : > "$dmg_path"

    uname() {
      printf '%s\n' 'Darwin'
    }

    file() {
      case "$2" in
        */Contents/MacOS/Portico\ AI\ Chat)
          printf '%s\n' 'Mach-O 64-bit executable arm64'
          ;;
        */aarch64-apple-darwin/mcp-orc)
          printf '%s\n' 'Mach-O 64-bit executable arm64'
          ;;
        */x86_64-apple-darwin/mcp-orc)
          printf '%s\n' 'Mach-O 64-bit executable x86_64'
          ;;
        *)
          return 1
          ;;
      esac
    }

    preflight_macos_artifacts_for_arch arm64 >"$output_file" 2>&1
    output="$(cat "$output_file")"

    [ "$ARM64_ARTIFACT_FORCE_REBUILD" = true ] || fail "stale auto-discovered arm64 app was not marked for rebuild"
    [ -z "$APP_ARM64" ] || fail "stale auto-discovered arm64 app should not be reused"
    [ -z "$DMG_ARM64" ] || fail "stale auto-discovered arm64 dmg should not be reused"
    printf '%s' "$output" | grep -q "Auto-discovered macOS arm64 artifacts are stale" || fail "preflight did not explain stale auto-discovered artifacts"
    printf '%s' "$output" | grep -q "will be rebuilt on macOS" || fail "preflight did not explain rebuild behavior"
    ! printf '%s' "$output" | grep -q 'Error:' || fail "expected stale auto-discovered artifacts should not be reported as nested errors"

    rm -rf "$tmp_dir"
  )
}

test_preflight_rejects_stale_explicit_artifacts() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir stale_build_info output status
    tmp_dir="$(mktemp -d)"
    SOURCE_STAGE_DIR="$tmp_dir/source"
    BUILD_ID="03122026-deadbeef"
    FULL_SHA="deadbeefcafefeeddeadbeefcafefeeddeadbeef"
    APP_ARM64="$tmp_dir/explicit-arm64/Portico.app"
    DMG_ARM64="$tmp_dir/explicit-arm64/Portico-1.0.0-arm64.dmg"
    APP_ARM64_EXPLICIT=true
    DMG_ARM64_EXPLICIT=true
    stale_build_info="$tmp_dir/stale-build-info.json"

    make_staged_release_resources "$SOURCE_STAGE_DIR" "$BUILD_ID" "$FULL_SHA"
    make_staged_release_resources "$tmp_dir/stale-source" "$BUILD_ID" "$FULL_SHA" "2026-03-11T00:00:00.000Z"
    cp "$tmp_dir/stale-source/electron-app/build-info.json" "$stale_build_info"
    make_fake_packaged_app_with_release_resources \
      "$APP_ARM64" \
      "$stale_build_info" \
      "$SOURCE_STAGE_DIR/src/scripts/prereq-download.sh" \
      "$SOURCE_STAGE_DIR/src/scripts/managed-runtime-reconcile.sh"
    : > "$DMG_ARM64"

    file() {
      case "$2" in
        */Contents/MacOS/Portico\ AI\ Chat)
          printf '%s\n' 'Mach-O 64-bit executable arm64'
          ;;
        */aarch64-apple-darwin/mcp-orc)
          printf '%s\n' 'Mach-O 64-bit executable arm64'
          ;;
        */x86_64-apple-darwin/mcp-orc)
          printf '%s\n' 'Mach-O 64-bit executable x86_64'
          ;;
        *)
          return 1
          ;;
      esac
    }

    set +e
    output="$(preflight_macos_artifacts_for_arch arm64 2>&1)"
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "stale explicit artifacts should fail preflight"
    printf '%s' "$output" | grep -q "Explicit macOS arm64 artifacts failed release validation" || fail "explicit artifact failure did not explain the bad input"
    printf '%s' "$output" | grep -q "build-info.json does not match staged source metadata" || fail "explicit artifact failure did not include the integrity reason"

    rm -rf "$tmp_dir"
  )
}

test_preflight_reuses_matching_auto_discovered_artifacts() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir app_path dmg_path
    tmp_dir="$(mktemp -d)"
    SOURCE_STAGE_DIR="$tmp_dir/source"
    ARTIFACT_SEARCH_ROOT="$tmp_dir/dist"
    MACOS_ARTIFACT_CACHE_ROOT="$tmp_dir/package-cache/macos"
    PACKAGE_SOURCE_CLEAN=true
    PACKAGE_CACHE_INITIALIZED=true
    BUILD_ID="03122026-deadbeef"
    FULL_SHA="deadbeefcafefeeddeadbeefcafefeeddeadbeef"
    app_path="$MACOS_ARTIFACT_CACHE_ROOT/darwin-arm64/mac-arm64/Portico.app"
    dmg_path="$MACOS_ARTIFACT_CACHE_ROOT/darwin-arm64/Portico-1.0.0-arm64.dmg"

    make_staged_release_resources "$SOURCE_STAGE_DIR" "$BUILD_ID" "$FULL_SHA"
    make_fake_packaged_app_with_release_resources \
      "$app_path" \
      "$SOURCE_STAGE_DIR/electron-app/build-info.json" \
      "$SOURCE_STAGE_DIR/src/scripts/prereq-download.sh" \
      "$SOURCE_STAGE_DIR/src/scripts/managed-runtime-reconcile.sh"
    : > "$dmg_path"

    uname() {
      printf '%s\n' 'Darwin'
    }

    file() {
      case "$2" in
        */Contents/MacOS/Portico\ AI\ Chat)
          printf '%s\n' 'Mach-O 64-bit executable arm64'
          ;;
        */aarch64-apple-darwin/mcp-orc)
          printf '%s\n' 'Mach-O 64-bit executable arm64'
          ;;
        */x86_64-apple-darwin/mcp-orc)
          printf '%s\n' 'Mach-O 64-bit executable x86_64'
          ;;
        *)
          return 1
          ;;
      esac
    }

    codesign() { :; }
    spctl() { :; }
    xcrun() { :; }

    build_macos_artifacts_for_arch() {
      fail "matching auto-discovered artifacts should have been reused"
    }

    preflight_macos_artifacts_for_arch arm64
    ensure_arch_artifacts arm64

    [ "$ARM64_ARTIFACT_FORCE_REBUILD" = false ] || fail "matching auto-discovered artifacts should not force rebuild"
    [ "$APP_ARM64" = "$app_path" ] || fail "matching auto-discovered arm64 app was not selected"
    [ "$DMG_ARM64" = "$dmg_path" ] || fail "matching auto-discovered arm64 dmg was not selected"
    case "$ARM64_ARTIFACT_PROVENANCE" in
      reused\ existing\ arm64\ macOS\ app\ +\ DMG*) ;;
      *) fail "matching auto-discovered artifacts did not record reuse provenance" ;;
    esac

    rm -rf "$tmp_dir"
  )
}

test_dirty_source_bypasses_persistent_macos_artifact_cache() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir output output_file
    tmp_dir="$(mktemp -d)"
    output_file="$tmp_dir/preflight.log"
    SOURCE_STAGE_DIR="$tmp_dir/source"
    MACOS_ARTIFACT_CACHE_ROOT="$tmp_dir/package-cache/macos"
    PACKAGE_SOURCE_CLEAN=false
    PACKAGE_CACHE_INITIALIZED=true

    uname() {
      printf '%s\n' 'Darwin'
    }
    locate_existing_app_for_arch() {
      fail "dirty source should not inspect the persistent macOS app cache"
    }
    locate_existing_dmg_for_arch() {
      fail "dirty source should not inspect the persistent macOS DMG cache"
    }

    preflight_macos_artifacts_for_arch arm64 > "$output_file" 2>&1
    output="$(cat "$output_file")"

    [ "$ARM64_ARTIFACT_FORCE_REBUILD" = true ] \
      || fail "dirty source should force a fresh arm64 macOS build"
    printf '%s' "$output" | grep -q 'bypassing persistent macOS arm64 artifact reuse' \
      || fail "dirty source cache bypass did not explain its behavior"

    rm -rf "$tmp_dir"
  )
}

test_macos_build_replaces_only_affected_marked_cache_directory() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir output_log arm_output x64_sentinel
    tmp_dir="$(mktemp -d)"
    output_log="$tmp_dir/output-dir.log"
    PACKAGE_CACHE_DIR="$tmp_dir/package-cache"
    MACOS_ARTIFACT_CACHE_ROOT="$PACKAGE_CACHE_DIR/macos"
    PACKAGE_SOURCE_CLEAN=true
    SOURCE_STAGE_DIR="$tmp_dir/source"
    arm_output="$MACOS_ARTIFACT_CACHE_ROOT/darwin-arm64"
    x64_sentinel="$MACOS_ARTIFACT_CACHE_ROOT/darwin-x64/keep-me"

    mkdir -p "$PACKAGE_CACHE_DIR" "$(dirname "$x64_sentinel")"
    : > "$PACKAGE_CACHE_DIR/$PACKAGE_CACHE_MARKER"
    : > "$x64_sentinel"
    mkdir -p "$arm_output/stale"
    : > "$arm_output/stale/remove-me"

    ensure_macos_build_environment() { :; }
    ensure_electron_dependencies() { :; }
    run_electron_builder_with_retry() {
      local arch="$1"
      local output_dir="$2"
      printf '%s\n' "$output_dir" > "$output_log"
      mkdir -p "$output_dir/mac-${arch}/Portico.app"
      : > "$output_dir/Portico-${arch}.dmg"
    }
    finalize_output_dir_macos_artifacts() {
      local output_dir="$1"
      record_built_arch_artifacts \
        arm64 \
        "$output_dir/mac-arm64/Portico.app" \
        "$output_dir/Portico-arm64.dmg"
    }

    build_macos_artifacts_for_arch arm64

    [ "$(cat "$output_log")" = "$arm_output" ] \
      || fail "clean macOS arm64 build did not use its fixed package-cache directory"
    [ ! -e "$arm_output/stale/remove-me" ] \
      || fail "macOS arm64 rebuild did not replace its stale cache directory"
    [ -e "$x64_sentinel" ] \
      || fail "macOS arm64 rebuild modified the x64 cache directory"
    [ "$APP_ARM64" = "$arm_output/mac-arm64/Portico.app" ] \
      || fail "macOS arm64 cache build did not record its app artifact"
    [ "$DMG_ARM64" = "$arm_output/Portico-arm64.dmg" ] \
      || fail "macOS arm64 cache build did not record its DMG artifact"

    rm -rf "$tmp_dir"
  )
}

test_main_preflights_macos_artifacts_before_expensive_release_work() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir log_file status actual
    tmp_dir="$(mktemp -d)"
    log_file="$tmp_dir/order.log"
    BUILD_ID="03122026-deadbeef"
    FULL_SHA="deadbeefcafefeeddeadbeefcafefeeddeadbeef"

    parse_args() { :; }
    confirm_or_fill_build_id() { :; }
    validate_build_id() { :; }
    validate_configuration() { :; }
    validate_release_metadata_consistency() { :; }
    preflight_release_packaging_disk_space() { :; }
    initialize_package_cache() { :; }
    resolve_cloudsmith_release_api_key() { printf '%s\n' 'cloudsmith-api-key' >> "$log_file"; }
    resolve_cloudsmith_release_entitlement_token() { printf '%s\n' 'cloudsmith-token' >> "$log_file"; }
    stage_source_tree() { printf '%s\n' 'stage' >> "$log_file"; }
    write_release_metadata_files() { printf '%s\n' 'metadata' >> "$log_file"; }
    prepare_cloudsmith_release_resource() { printf '%s\n' 'cloudsmith' >> "$log_file"; }
    preflight_macos_artifacts() {
      printf '%s\n' 'preflight' >> "$log_file"
      return 23
    }
    prepare_release_docker_images() { printf '%s\n' 'docker' >> "$log_file"; }
    prepare_host_mcp_binaries() { printf '%s\n' 'host-mcp' >> "$log_file"; }
    ensure_arch_artifacts() { printf 'ensure-%s\n' "$1" >> "$log_file"; }
    stage_payload_contents() { printf '%s\n' 'payload' >> "$log_file"; }
    create_payload_zip() { printf '%s\n' 'zip' >> "$log_file"; }
    print_release_summary() { printf '%s\n' 'summary' >> "$log_file"; }

    set +e
    ( set -e; main --channel beta ) >/dev/null 2>&1
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "main should stop when mac artifact preflight fails"
    actual="$(tr '\n' ' ' < "$log_file" | sed 's/ $//')"
    [ "$actual" = "cloudsmith-api-key cloudsmith-token stage metadata cloudsmith preflight" ] || fail "Cloudsmith credential resolution and resource preparation did not run before expensive release work: $actual"

    rm -rf "$tmp_dir"
  )
}

test_resolve_cloudsmith_release_entitlement_token_exports_without_logging_secret() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir log_file expected_source_path
    tmp_dir="$(mktemp -d)"
    log_file="$tmp_dir/resolver.log"
    MANAGED_ROOT_SOURCE="$tmp_dir/source"
    expected_source_path="$MANAGED_ROOT_SOURCE/cloudsmith.env"
    mkdir -p "$MANAGED_ROOT_SOURCE"
    unset CLOUDSMITH_ENTITLEMENT_TOKEN

    resolve_packaged_cloudsmith_entitlement_token() {
      [ "$1" = "$expected_source_path" ] || fail "package resolver used the wrong source cloudsmith.env path"
      printf '%s\n' 'package-test-secret'
    }

    resolve_cloudsmith_release_entitlement_token > "$log_file"

    [ "$CLOUDSMITH_ENTITLEMENT_TOKEN" = "package-test-secret" ] \
      || fail "package resolver did not export the resolved entitlement token"
    if grep -q 'package-test-secret' "$log_file"; then
      fail "package resolver logged the entitlement token"
    fi

    rm -rf "$tmp_dir"
  )
}

test_resolve_cloudsmith_release_api_key_uses_environment_then_file_without_logging_secret() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir log_file
    tmp_dir="$(mktemp -d)"
    log_file="$tmp_dir/resolver.log"
    MANAGED_ROOT_SOURCE="$tmp_dir/source"
    mkdir -p "$MANAGED_ROOT_SOURCE"
    printf '%s\n' 'CLOUDSMITH_API_KEY="file-api-key"' > "$MANAGED_ROOT_SOURCE/cloudsmith.env"

    CLOUDSMITH_API_KEY=" environment-api-key "
    resolve_cloudsmith_release_api_key > "$log_file"
    [ "$CLOUDSMITH_API_KEY" = "environment-api-key" ] \
      || fail "package resolver did not prefer the environment API key"
    if grep -q 'environment-api-key' "$log_file"; then
      fail "package resolver logged the environment API key"
    fi

    unset CLOUDSMITH_API_KEY
    resolve_cloudsmith_release_api_key > "$log_file"
    [ "$CLOUDSMITH_API_KEY" = "file-api-key" ] \
      || fail "package resolver did not fall back to cloudsmith.env"
    if grep -q 'file-api-key' "$log_file"; then
      fail "package resolver logged the file API key"
    fi

    rm -rf "$tmp_dir"
  )
}

test_environment_cloudsmith_credentials_support_release_resolution_without_source_file() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir
    tmp_dir="$(mktemp -d)"
    MANAGED_ROOT_SOURCE="$tmp_dir/source"
    mkdir -p "$MANAGED_ROOT_SOURCE"
    [ ! -e "$MANAGED_ROOT_SOURCE/cloudsmith.env" ] \
      || fail "environment-only release fixture unexpectedly contains cloudsmith.env"

    export CLOUDSMITH_API_KEY=" environment-api-key "
    export CLOUDSMITH_ENTITLEMENT_TOKEN=" environment-entitlement-token "
    export PORTICO_RUNTIME_DISABLE_KEYCHAIN=1

    resolve_cloudsmith_release_api_key >/dev/null
    resolve_cloudsmith_release_entitlement_token >/dev/null

    [ "$CLOUDSMITH_API_KEY" = "environment-api-key" ] \
      || fail "release packaging did not resolve CLOUDSMITH_API_KEY from the environment"
    [ "$CLOUDSMITH_ENTITLEMENT_TOKEN" = "environment-entitlement-token" ] \
      || fail "release packaging did not resolve CLOUDSMITH_ENTITLEMENT_TOKEN from the environment"

    rm -rf "$tmp_dir"
  )
}

test_write_release_metadata_files_keeps_cloudsmith_helper_outside_json() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir build_info_path
    tmp_dir="$(mktemp -d)"
    SOURCE_STAGE_DIR="$tmp_dir/source"
    BUILD_ID="06172026-4fb5ce68"
    FULL_SHA="4fb5ce68160184b300e587afdffa3c8cdea22744"
    CHANNEL_PACKAGE_NAME="portico_dev"
    build_info_path="$SOURCE_STAGE_DIR/electron-app/build-info.json"

    mkdir -p "$(dirname "$build_info_path")"
    write_release_metadata_files

    [ -f "$build_info_path" ] || fail "write_release_metadata_files did not create build-info.json"
    grep -q '"buildNumber": "06172026-4fb5ce68"' "$build_info_path" \
      || fail "build-info.json did not contain the requested build number"
    if grep -q 'prepare_cloudsmith_release_resource' "$build_info_path"; then
      fail "Cloudsmith helper source leaked into build-info.json"
    fi
    declare -F prepare_cloudsmith_release_resource >/dev/null \
      || fail "prepare_cloudsmith_release_resource was not defined"

    rm -rf "$tmp_dir"
  )
}

test_custom_release_channel_mapping_and_metadata() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir build_info_path
    tmp_dir="$(mktemp -d)"
    SOURCE_STAGE_DIR="$tmp_dir/source"
    BUILD_ID="06232026-deadbeef"
    FULL_SHA="deadbeefcafefeeddeadbeefcafefeeddeadbeef"
    CHANNEL="$(normalize_release_channel_name "  Team-Alpha  ")"
    CHANNEL_PACKAGE_NAME="$(channel_to_package_name "$CHANNEL")"
    build_info_path="$SOURCE_STAGE_DIR/electron-app/build-info.json"

    [ "$CHANNEL" = "team-alpha" ] || fail "custom channel was not normalized"
    [ "$CHANNEL_PACKAGE_NAME" = "portico_team-alpha" ] \
      || fail "custom channel did not map to its canonical package name"
    ! validate_custom_release_channel_name "unsafe.channel" >/dev/null 2>&1 \
      || fail "unsafe custom channel was accepted"
    [ "$(resolve_update_channel_package_name "historicalTeam_7")" = "historicalTeam_7" ] \
      || fail "safe legacy package value was not preserved"
    ! resolve_update_channel_package_name "portico_stable" >/dev/null 2>&1 \
      || fail "reserved canonical custom package name was accepted"

    mkdir -p "$(dirname "$build_info_path")"
    write_release_metadata_files
    grep -Fq '"channel": "portico_team-alpha"' "$build_info_path" \
      || fail "custom package identity was not written to build-info.json"

    rm -rf "$tmp_dir"
  )
}

test_release_metadata_cache_preserves_same_release_timestamp_and_invalidates_new_revision() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir build_info_path cached_timestamp
    tmp_dir="$(mktemp -d)"
    SOURCE_STAGE_DIR="$tmp_dir/source"
    PACKAGE_CACHE_DIR="$tmp_dir/package-cache"
    PACKAGE_METADATA_CACHE_PATH="$PACKAGE_CACHE_DIR/release-metadata/build-info.json"
    PACKAGE_SOURCE_CLEAN=true
    BUILD_ID="06182026-deadbeef"
    FULL_SHA="deadbeefcafefeeddeadbeefcafefeeddeadbeef"
    CHANNEL_PACKAGE_NAME="portico_dev"
    build_info_path="$SOURCE_STAGE_DIR/electron-app/build-info.json"
    cached_timestamp="2026-06-18T12:34:56.000Z"

    mkdir -p "$(dirname "$build_info_path")" "$(dirname "$PACKAGE_METADATA_CACHE_PATH")"
    : > "$PACKAGE_CACHE_DIR/$PACKAGE_CACHE_MARKER"
    cat > "$PACKAGE_METADATA_CACHE_PATH" <<EOF
{
  "buildNumber": "${BUILD_ID}",
  "fullSha": "${FULL_SHA}",
  "date": "06182026",
  "timestamp": "${cached_timestamp}",
  "channel": "${CHANNEL_PACKAGE_NAME}"
}
EOF

    write_release_metadata_files >/dev/null

    cmp -s "$PACKAGE_METADATA_CACHE_PATH" "$build_info_path" \
      || fail "same-release metadata did not preserve its original cached timestamp"
    grep -Fq "\"timestamp\": \"${cached_timestamp}\"" "$build_info_path" \
      || fail "same-release metadata cache lost its original timestamp"

    BUILD_ID="06182026-feedface"
    FULL_SHA="feedfacecafefeeddeadbeefcafefeeddeadbeef"
    write_release_metadata_files >/dev/null

    grep -Fq '"buildNumber": "06182026-feedface"' "$PACKAGE_METADATA_CACHE_PATH" \
      || fail "new source revision did not replace cached release metadata"
    grep -Fq '"fullSha": "feedfacecafefeeddeadbeefcafefeeddeadbeef"' "$PACKAGE_METADATA_CACHE_PATH" \
      || fail "new source revision did not persist its full SHA in metadata cache"
    if grep -Fq "\"timestamp\": \"${cached_timestamp}\"" "$PACKAGE_METADATA_CACHE_PATH"; then
      fail "new source revision incorrectly reused the prior release timestamp"
    fi

    rm -rf "$tmp_dir"
  )
}

test_cleanup_preserves_temp_dir_on_failure_by_default() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir log_file
    tmp_dir="$(mktemp -d)"
    log_file="$(mktemp)"
    TEMP_DIR="$tmp_dir"
    KEEP_TEMP_ON_FAILURE=true

    set +e
    false
    cleanup >"$log_file" 2>&1
    set -e

    [ -d "$tmp_dir" ] || fail "cleanup removed temp dir after failure"
    grep -q "Packaging failed before payload creation" "$log_file" || fail "cleanup did not print failure message"
    grep -q "$tmp_dir" "$log_file" || fail "cleanup did not print preserved temp dir"

    rm -rf "$tmp_dir" "$log_file"
  )
}

test_cleanup_removes_temp_dir_on_success() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir
    tmp_dir="$(mktemp -d)"
    TEMP_DIR="$tmp_dir"
    KEEP_TEMP_ON_FAILURE=true

    true
    cleanup

    [ ! -d "$tmp_dir" ] || fail "cleanup preserved temp dir after success"
  )
}

test_cleanup_reports_failure_after_valid_payload_accurately() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir log_file
    tmp_dir="$(mktemp -d)"
    log_file="$(mktemp)"
    TEMP_DIR="$tmp_dir"
    OUTPUT_ZIP="$tmp_dir/portico_dev-03122026-deadbeef.zip"
    PAYLOAD_CREATED=true
    KEEP_TEMP_ON_FAILURE=true
    : > "$OUTPUT_ZIP"

    set +e
    false
    cleanup >"$log_file" 2>&1
    set -e

    grep -q "Packaging failed after creating a validated payload" "$log_file" \
      || fail "cleanup incorrectly reported a post-payload failure as pre-payload"
    grep -Fq "Valid payload remains available: $OUTPUT_ZIP" "$log_file" \
      || fail "cleanup did not report the valid payload path"
    ! grep -q "failed before payload creation" "$log_file" \
      || fail "cleanup emitted the obsolete pre-payload message"

    rm -rf "$tmp_dir" "$log_file"
  )
}

test_package_disk_preflight_rejects_insufficient_space() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir output_file status
    tmp_dir="$(mktemp -d)"
    output_file="$tmp_dir/preflight.log"
    OUTPUT_ZIP="$tmp_dir/portico_dev-03122026-deadbeef.zip"
    PACKAGE_MIN_FREE_GB=10

    df() {
      printf '%s\n' \
        'Filesystem 1024-blocks Used Available Capacity Mounted on' \
        '/dev/fake 209715200 208666624 1048576 99% /'
    }

    set +e
    ( preflight_release_packaging_disk_space ) >"$output_file" 2>&1
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "packaging preflight should reject insufficient free space"
    grep -Fq 'Insufficient local disk space for release staging' "$output_file" \
      || fail "packaging preflight did not report the failed operation"
    grep -Fq 'local disk capacity failure, not a remote network failure' "$output_file" \
      || fail "packaging preflight did not distinguish local disk exhaustion from networking"

    rm -rf "$tmp_dir"
  )
}

test_release_staging_retention_prunes_only_marked_older_trees() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir current_dir old_dir unmarked_dir unrelated_dir
    tmp_dir="$(mktemp -d)"
    current_dir="$tmp_dir/${RELEASE_STAGING_PREFIX}.current"
    old_dir="$tmp_dir/${RELEASE_STAGING_PREFIX}.old"
    unmarked_dir="$tmp_dir/${RELEASE_STAGING_PREFIX}.unmarked"
    unrelated_dir="$tmp_dir/tmp.unrelated"

    mkdir -p "$current_dir" "$old_dir" "$unmarked_dir" "$unrelated_dir"
    : > "$current_dir/$RELEASE_STAGING_MARKER"
    : > "$old_dir/$RELEASE_STAGING_MARKER"

    prune_older_release_staging_dirs "$current_dir" >/dev/null

    [ -d "$current_dir" ] || fail "staging retention removed the current staging tree"
    [ ! -e "$old_dir" ] || fail "staging retention kept an older marked staging tree"
    [ -d "$unmarked_dir" ] || fail "staging retention removed an unmarked lookalike directory"
    [ -d "$unrelated_dir" ] || fail "staging retention removed an unrelated generic temp directory"

    rm -rf "$tmp_dir"
  )
}

test_ensure_electron_dependencies_runs_packaged_build_preparation_after_install() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir log_file
    tmp_dir="$(mktemp -d)"
    log_file="$(mktemp)"
    SOURCE_STAGE_DIR="$tmp_dir"
    mkdir -p "$SOURCE_STAGE_DIR/electron-app"

    npm() {
      printf 'npm %s\n' "$*" >> "$log_file"
    }

    ensure_electron_dependencies

    grep -q '^npm ci --no-audit --no-fund$' "$log_file" || fail "ensure_electron_dependencies did not run npm ci"
    grep -q '^npm run prepare:packaged-build$' "$log_file" || fail "ensure_electron_dependencies did not run packaged-build preparation"

    rm -rf "$tmp_dir" "$log_file"
  )
}

test_run_electron_builder_retries_transient_dmg_detach_failure() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir count_file detach_log output_dir
    tmp_dir="$(mktemp -d)"
    count_file="$tmp_dir/count"
    detach_log="$tmp_dir/detach.log"
    output_dir="$tmp_dir/output"
    SOURCE_STAGE_DIR="$tmp_dir/source"

    mkdir -p "$SOURCE_STAGE_DIR/electron-app/node_modules/.bin"
    : > "$count_file"

    cat > "$SOURCE_STAGE_DIR/electron-app/node_modules/.bin/electron-builder" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
attempt=$(( $(cat "${ELECTRON_BUILDER_COUNT_FILE:?}") + 1 ))
printf '%s' "$attempt" > "$ELECTRON_BUILDER_COUNT_FILE"
if [ "$attempt" -eq 1 ]; then
  printf '%s\n' 'dmgbuild.core.DMGError: Unable to detach device cleanly: hdiutil: couldn'\''t unmount "disk8" - Resource busy'
  exit 1
fi
printf '%s\n' 'electron-builder completed successfully on retry'
SH
    chmod +x "$SOURCE_STAGE_DIR/electron-app/node_modules/.bin/electron-builder"
    export ELECTRON_BUILDER_COUNT_FILE="$count_file"

    npm() {
      [ "$*" = "run prepare:packaged-build" ] \
        || fail "unexpected npm command before electron-builder: $*"
      return 0
    }

    hdiutil() {
      printf 'hdiutil %s\n' "$*" >> "$detach_log"
      return 0
    }

    run_electron_builder_with_retry arm64 "$output_dir"

    [ "$(cat "$count_file")" = "2" ] || fail "expected electron-builder retry after transient DMG detach failure"
    grep -q 'detach disk8 -force' "$detach_log" || fail "expected busy DMG device to be force-detached before retry"

    rm -rf "$tmp_dir"
  )
}

test_verify_packaged_app_host_mcp_binaries_accepts_expected_darwin_binaries() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir app_path
    tmp_dir="$(mktemp -d)"
    app_path="$tmp_dir/Portico.app"

    mkdir -p "$app_path/Contents/Resources/host-mcp-binaries/aarch64-apple-darwin"
    mkdir -p "$app_path/Contents/Resources/host-mcp-binaries/x86_64-apple-darwin"
    : > "$app_path/Contents/Resources/host-mcp-binaries/aarch64-apple-darwin/mcp-orc"
    : > "$app_path/Contents/Resources/host-mcp-binaries/x86_64-apple-darwin/mcp-orc"
    chmod +x "$app_path/Contents/Resources/host-mcp-binaries/aarch64-apple-darwin/mcp-orc"
    chmod +x "$app_path/Contents/Resources/host-mcp-binaries/x86_64-apple-darwin/mcp-orc"

    file() {
      case "$2" in
        */aarch64-apple-darwin/mcp-orc)
          printf '%s\n' 'Mach-O 64-bit executable arm64'
          ;;
        */x86_64-apple-darwin/mcp-orc)
          printf '%s\n' 'Mach-O 64-bit executable x86_64'
          ;;
        *)
          return 1
          ;;
      esac
    }

    verify_packaged_app_host_mcp_binaries "$app_path"

    rm -rf "$tmp_dir"
  )
}

test_refresh_host_mcp_streams_live_output_and_preserves_failure_log() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir output_file status_file alive_file worker_pid waited
    tmp_dir="$(mktemp -d)"
    output_file="$tmp_dir/refresh.out"
    status_file="$tmp_dir/status"
    alive_file="$tmp_dir/child-alive"
    SOURCE_STAGE_DIR="$tmp_dir/source"
    TMPDIR="$tmp_dir/logs"
    PACKAGE_SOURCE_CLEAN=false
    FULL_SHA="deadbeefcafefeeddeadbeefcafefeeddeadbeef"
    DOCKER_IMAGE_TAG="03122026-deadbeef"

    mkdir -p "$SOURCE_STAGE_DIR/src/scripts" "$TMPDIR"
    cat > "$SOURCE_STAGE_DIR/src/scripts/build-host-mcp-binaries.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' 'building x86_64-apple-darwin (native)'
: > "$alive_file"
sleep 1
rm -f "$alive_file"
printf '%s\n' 'simulated host build failure' >&2
exit 37
EOF
    chmod +x "$SOURCE_STAGE_DIR/src/scripts/build-host-mcp-binaries.sh"

    (
      set +e
      refresh_staged_host_mcp_binaries > "$output_file" 2>&1
      printf '%s\n' "$?" > "$status_file"
    ) &
    worker_pid=$!

    waited=0
    while ! grep -q 'building x86_64-apple-darwin' "$output_file" 2>/dev/null; do
      if ! kill -0 "$worker_pid" 2>/dev/null || [ "$waited" -ge 100 ]; then
        wait "$worker_pid" || true
        fail "host build output was not streamed before the child exited"
      fi
      sleep 0.02
      waited=$((waited + 1))
    done

    [ -f "$alive_file" ] \
      || fail "host build progress only became visible after the child exited"
    wait "$worker_pid"

    [ "$(cat "$status_file")" = "37" ] \
      || fail "host build tee pipeline did not preserve the child exit status"
    [ "$(find "$TMPDIR" -maxdepth 1 -name 'portico-host-mcp-build.log.*' | wc -l | tr -d ' ')" = "1" ] \
      || fail "failed host build did not preserve exactly one identifiable log"
    grep -q 'simulated host build failure' "$TMPDIR"/portico-host-mcp-build.log.* \
      || fail "preserved host build log omitted child stderr"

    set +e
    refresh_staged_host_mcp_binaries >/dev/null 2>&1
    second_status=$?
    set -e
    [ "$second_status" = "37" ] \
      || fail "second failed host build did not preserve the child exit status"
    [ "$(find "$TMPDIR" -maxdepth 1 -name 'portico-host-mcp-build.log.*' | wc -l | tr -d ' ')" = "2" ] \
      || fail "repeated failed host builds did not preserve unique logs"

    rm -rf "$tmp_dir"
  )
}

test_refresh_host_mcp_uses_clean_revision_cache_and_removes_success_log() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir env_log target
    tmp_dir="$(mktemp -d)"
    env_log="$tmp_dir/env.log"
    SOURCE_STAGE_DIR="$tmp_dir/source"
    TMPDIR="$tmp_dir/logs"
    PACKAGE_SOURCE_CLEAN=true
    FULL_SHA="deadbeefcafefeeddeadbeefcafefeeddeadbeef"
    DOCKER_IMAGE_TAG="03122026-deadbeef"
    HOST_MCP_CACHE_ARTIFACTS_ROOT="$tmp_dir/package-cache/host-mcp/artifacts"
    HOST_MCP_CACHE_CARGO_TARGET_DIR="$tmp_dir/package-cache/host-mcp/cargo-target"

    mkdir -p "$SOURCE_STAGE_DIR/src/scripts" "$TMPDIR"
    cat > "$SOURCE_STAGE_DIR/src/scripts/build-host-mcp-binaries.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf 'artifacts=%s\ncache-revision=%s\nimage-revision=%s\ncargo=%s\nimage=%s\n' \
  "\$HOST_MCP_ARTIFACTS_ROOT" \
  "\$HOST_MCP_EXPECTED_SOURCE_REVISION" \
  "\$HOST_MCP_EXPECTED_IMAGE_REVISION" \
  "\$CARGO_TARGET_DIR" \
  "\$HOST_MCP_LINUX_SOURCE_IMAGE" > "$env_log"
for target in aarch64-apple-darwin x86_64-apple-darwin x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu; do
  mkdir -p "\$HOST_MCP_ARTIFACTS_ROOT/\$target"
  printf '#!/bin/sh\nexit 0\n' > "\$HOST_MCP_ARTIFACTS_ROOT/\$target/mcp-orc"
  chmod +x "\$HOST_MCP_ARTIFACTS_ROOT/\$target/mcp-orc"
  printf '%s\n' "\$HOST_MCP_EXPECTED_SOURCE_REVISION" > "\$HOST_MCP_ARTIFACTS_ROOT/\$target/.source-revision"
  printf 'built %s\n' "\$target"
done
EOF
    chmod +x "$SOURCE_STAGE_DIR/src/scripts/build-host-mcp-binaries.sh"

    refresh_staged_host_mcp_binaries >/dev/null

    grep -Fxq "artifacts=$HOST_MCP_CACHE_ARTIFACTS_ROOT" "$env_log" \
      || fail "clean host build did not use the persistent artifact cache"
    grep -Fxq "cache-revision=$FULL_SHA" "$env_log" \
      || fail "clean host build did not key artifacts by the clean source revision"
    grep -Fxq "image-revision=$FULL_SHA" "$env_log" \
      || fail "clean host build did not validate the exact image revision"
    grep -Fxq "cargo=$HOST_MCP_CACHE_CARGO_TARGET_DIR" "$env_log" \
      || fail "clean host build did not reuse the persistent Cargo target directory"
    grep -Fxq 'image=harbor.example.invalid/portico/mcp-orc-rust:03122026-deadbeef' "$env_log" \
      || fail "release packaging did not select the exact-tag mcp-orc image"

    for target in aarch64-apple-darwin x86_64-apple-darwin x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu; do
      [ -x "$SOURCE_STAGE_DIR/host-mcp-binaries/$target/mcp-orc" ] \
        || fail "clean host cache was not synchronized into staged payload: $target"
      [ ! -e "$SOURCE_STAGE_DIR/host-mcp-binaries/$target/.source-revision" ] \
        || fail "private host cache revision marker leaked into the release payload: $target"
    done
    if find "$TMPDIR" -maxdepth 1 -name 'portico-host-mcp-build.log.*' | grep -q .; then
      fail "successful host build left a temporary build log behind"
    fi

    rm -rf "$tmp_dir"
  )
}

test_refresh_host_mcp_dirty_source_isolates_persistent_artifact_and_cargo_caches() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir env_log
    tmp_dir="$(mktemp -d)"
    env_log="$tmp_dir/env.log"
    SOURCE_STAGE_DIR="$tmp_dir/source"
    TMPDIR="$tmp_dir/logs"
    PACKAGE_SOURCE_CLEAN=false
    FULL_SHA="deadbeefcafefeeddeadbeefcafefeeddeadbeef"
    DOCKER_IMAGE_TAG="03122026-deadbeef"
    HOST_MCP_CACHE_ARTIFACTS_ROOT="$tmp_dir/package-cache/host-mcp/artifacts"
    HOST_MCP_CACHE_CARGO_TARGET_DIR="$tmp_dir/package-cache/host-mcp/cargo-target"

    mkdir -p "$SOURCE_STAGE_DIR/src/scripts" "$TMPDIR"
    cat > "$SOURCE_STAGE_DIR/src/scripts/build-host-mcp-binaries.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf 'artifacts=%s\ncache-revision=%s\nimage-revision=%s\ncargo=%s\n' \
  "\$HOST_MCP_ARTIFACTS_ROOT" \
  "\$HOST_MCP_EXPECTED_SOURCE_REVISION" \
  "\$HOST_MCP_EXPECTED_IMAGE_REVISION" \
  "\$CARGO_TARGET_DIR" > "$env_log"
for target in aarch64-apple-darwin x86_64-apple-darwin x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu; do
  mkdir -p "\$HOST_MCP_ARTIFACTS_ROOT/\$target"
  printf '#!/bin/sh\nexit 0\n' > "\$HOST_MCP_ARTIFACTS_ROOT/\$target/mcp-orc"
  chmod +x "\$HOST_MCP_ARTIFACTS_ROOT/\$target/mcp-orc"
done
EOF
    chmod +x "$SOURCE_STAGE_DIR/src/scripts/build-host-mcp-binaries.sh"

    refresh_staged_host_mcp_binaries >/dev/null

    grep -Fxq "artifacts=$SOURCE_STAGE_DIR/host-mcp-binaries" "$env_log" \
      || fail "dirty host build did not isolate artifacts in disposable staging"
    grep -Fxq 'cache-revision=' "$env_log" \
      || fail "dirty host build should not stamp artifacts with a reusable clean revision"
    grep -Fxq "image-revision=$FULL_SHA" "$env_log" \
      || fail "dirty host build did not retain exact-image revision validation"
    grep -Fxq 'cargo=' "$env_log" \
      || fail "dirty host build should not use the persistent Cargo target cache"
    [ ! -e "$HOST_MCP_CACHE_ARTIFACTS_ROOT" ] \
      || fail "dirty host build mutated the persistent artifact cache"
    [ ! -e "$HOST_MCP_CACHE_CARGO_TARGET_DIR" ] \
      || fail "dirty host build mutated the persistent Cargo target cache"

    rm -rf "$tmp_dir"
  )
}

test_prepare_host_mcp_binaries_refreshes_stale_staged_darwin_targets_on_macos() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir build_args_log x64_marker
    tmp_dir="$(mktemp -d)"
    SOURCE_STAGE_DIR="$tmp_dir/source"
    build_args_log="$tmp_dir/build-args.log"
    x64_marker="$tmp_dir/x64-current"

    mkdir -p \
      "$SOURCE_STAGE_DIR/src/scripts" \
      "$SOURCE_STAGE_DIR/host-mcp-binaries/aarch64-apple-darwin" \
      "$SOURCE_STAGE_DIR/host-mcp-binaries/x86_64-apple-darwin"
    : > "$SOURCE_STAGE_DIR/host-mcp-binaries/aarch64-apple-darwin/mcp-orc"
    : > "$SOURCE_STAGE_DIR/host-mcp-binaries/x86_64-apple-darwin/mcp-orc"
    chmod +x "$SOURCE_STAGE_DIR/host-mcp-binaries/aarch64-apple-darwin/mcp-orc"
    chmod +x "$SOURCE_STAGE_DIR/host-mcp-binaries/x86_64-apple-darwin/mcp-orc"
    make_fake_required_host_mcp_binaries "$SOURCE_STAGE_DIR/host-mcp-binaries"

    cat > "$SOURCE_STAGE_DIR/src/scripts/build-host-mcp-binaries.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\$*" > "$build_args_log"
printf '%s\n' 'up-to-date aarch64-apple-darwin'
printf '%s\n' 'built x86_64-apple-darwin'
touch "$x64_marker"
EOF
    chmod +x "$SOURCE_STAGE_DIR/src/scripts/build-host-mcp-binaries.sh"

    uname() {
      printf '%s\n' 'Darwin'
    }

    host_mcp_binary_is_current() {
      case "$2" in
        */aarch64-apple-darwin/mcp-orc)
          return 0
          ;;
        */x86_64-apple-darwin/mcp-orc)
          [ -f "$x64_marker" ]
          return $?
          ;;
        *)
          return 1
          ;;
      esac
    }

    prepare_host_mcp_binaries

    grep -q -- '--all-supported' "$build_args_log" || fail "prepare_host_mcp_binaries did not refresh staged host binaries with --all-supported"
    [ "$HOST_MCP_SOURCE_DIR" = "$SOURCE_STAGE_DIR/host-mcp-binaries" ] || fail "prepare_host_mcp_binaries did not select the staged host-mcp-binaries directory"
    [ "$HOST_MCP_PROVENANCE" = "refreshed host-mcp-binaries in this run" ] || fail "prepare_host_mcp_binaries did not record refreshed staged host binary provenance"

    rm -rf "$tmp_dir"
  )
}

test_prepare_host_mcp_binaries_refreshes_explicit_seed_dir_on_macos() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir seed_dir build_args_log x64_marker
    tmp_dir="$(mktemp -d)"
    seed_dir="$tmp_dir/seed-host-mcp-binaries"
    SOURCE_STAGE_DIR="$tmp_dir/source"
    HOST_MCP_BINARIES_DIR="$seed_dir"
    build_args_log="$tmp_dir/build-args.log"
    x64_marker="$tmp_dir/x64-current"

    mkdir -p \
      "$SOURCE_STAGE_DIR/src/scripts" \
      "$seed_dir/aarch64-apple-darwin" \
      "$seed_dir/x86_64-apple-darwin"
    : > "$seed_dir/aarch64-apple-darwin/mcp-orc"
    : > "$seed_dir/x86_64-apple-darwin/mcp-orc"
    chmod +x "$seed_dir/aarch64-apple-darwin/mcp-orc"
    chmod +x "$seed_dir/x86_64-apple-darwin/mcp-orc"
    make_fake_required_host_mcp_binaries "$seed_dir"

    cat > "$SOURCE_STAGE_DIR/src/scripts/build-host-mcp-binaries.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\$*" > "$build_args_log"
printf '%s\n' 'up-to-date aarch64-apple-darwin'
printf '%s\n' 'built x86_64-apple-darwin'
touch "$x64_marker"
EOF
    chmod +x "$SOURCE_STAGE_DIR/src/scripts/build-host-mcp-binaries.sh"

    uname() {
      printf '%s\n' 'Darwin'
    }

    host_mcp_binary_is_current() {
      case "$2" in
        */aarch64-apple-darwin/mcp-orc)
          return 0
          ;;
        */x86_64-apple-darwin/mcp-orc)
          [ -f "$x64_marker" ]
          return $?
          ;;
        *)
          return 1
          ;;
      esac
    }

    prepare_host_mcp_binaries

    grep -q -- '--all-supported' "$build_args_log" || fail "prepare_host_mcp_binaries did not refresh seeded host binaries with --all-supported"
    [ -x "$SOURCE_STAGE_DIR/host-mcp-binaries/x86_64-apple-darwin/mcp-orc" ] || fail "prepare_host_mcp_binaries did not stage the explicit host-mcp-binaries seed"
    [ "$HOST_MCP_PROVENANCE" = "seeded from explicit host-mcp-binaries and refreshed in this run" ] || fail "prepare_host_mcp_binaries did not record explicit seed refresh provenance"

    rm -rf "$tmp_dir"
  )
}

test_prepare_host_mcp_binaries_ignores_generated_target_outputs_when_refreshing_on_macos() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir generated_file
    tmp_dir="$(mktemp -d)"
    SOURCE_STAGE_DIR="$tmp_dir/source"
    generated_file="$SOURCE_STAGE_DIR/src/mcp-orc-rust/target/x86_64-apple-darwin/release/build/example/out/private.rs"

    mkdir -p \
      "$SOURCE_STAGE_DIR/src/scripts" \
      "$SOURCE_STAGE_DIR/src/mcp-orc-rust/crates/mcp-orc/src" \
      "$SOURCE_STAGE_DIR/host-mcp-binaries/aarch64-apple-darwin" \
      "$SOURCE_STAGE_DIR/host-mcp-binaries/x86_64-apple-darwin"

    printf '#!/bin/sh\nexit 0\n' > "$SOURCE_STAGE_DIR/host-mcp-binaries/x86_64-apple-darwin/mcp-orc"
    chmod +x "$SOURCE_STAGE_DIR/host-mcp-binaries/x86_64-apple-darwin/mcp-orc"
    sleep 1

    touch \
      "$SOURCE_STAGE_DIR/src/mcp-orc-rust/Cargo.toml" \
      "$SOURCE_STAGE_DIR/src/mcp-orc-rust/Cargo.lock" \
      "$SOURCE_STAGE_DIR/src/mcp-orc-rust/crates/mcp-orc/src/main.rs"
    sleep 1

    printf '#!/bin/sh\nexit 0\n' > "$SOURCE_STAGE_DIR/host-mcp-binaries/aarch64-apple-darwin/mcp-orc"
    chmod +x "$SOURCE_STAGE_DIR/host-mcp-binaries/aarch64-apple-darwin/mcp-orc"
    make_fake_required_host_mcp_binaries "$SOURCE_STAGE_DIR/host-mcp-binaries"

    cat > "$SOURCE_STAGE_DIR/src/scripts/build-host-mcp-binaries.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' 'up-to-date aarch64-apple-darwin'
mkdir -p "$(dirname "$generated_file")"
touch "$generated_file"
printf '#!/bin/sh\nexit 0\n' > "$SOURCE_STAGE_DIR/host-mcp-binaries/x86_64-apple-darwin/mcp-orc"
chmod +x "$SOURCE_STAGE_DIR/host-mcp-binaries/x86_64-apple-darwin/mcp-orc"
printf '%s\n' 'built x86_64-apple-darwin'
EOF
    chmod +x "$SOURCE_STAGE_DIR/src/scripts/build-host-mcp-binaries.sh"

    uname() {
      printf '%s\n' 'Darwin'
    }

    prepare_host_mcp_binaries

    [ "$HOST_MCP_SOURCE_DIR" = "$SOURCE_STAGE_DIR/host-mcp-binaries" ] || fail "prepare_host_mcp_binaries did not retain the staged host-mcp-binaries directory when generated target files appeared"
    [ "$HOST_MCP_PROVENANCE" = "refreshed host-mcp-binaries in this run" ] || fail "prepare_host_mcp_binaries did not record refreshed provenance after generated target files appeared"
    [ -f "$generated_file" ] || fail "regression test did not create the generated target output"
    host_mcp_binary_is_current "$SOURCE_STAGE_DIR" "$SOURCE_STAGE_DIR/host-mcp-binaries/aarch64-apple-darwin/mcp-orc" || fail "generated target outputs incorrectly marked the reused aarch64 binary stale"
    host_mcp_binary_is_current "$SOURCE_STAGE_DIR" "$SOURCE_STAGE_DIR/host-mcp-binaries/x86_64-apple-darwin/mcp-orc" || fail "rebuilt x86_64 binary should be current after refresh"

    rm -rf "$tmp_dir"
  )
}

test_prepare_host_mcp_binaries_rejects_stale_darwin_targets_on_non_macos() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir status output
    tmp_dir="$(mktemp -d)"
    SOURCE_STAGE_DIR="$tmp_dir/source"

    mkdir -p \
      "$SOURCE_STAGE_DIR/host-mcp-binaries/aarch64-apple-darwin" \
      "$SOURCE_STAGE_DIR/host-mcp-binaries/x86_64-apple-darwin"
    : > "$SOURCE_STAGE_DIR/host-mcp-binaries/aarch64-apple-darwin/mcp-orc"
    : > "$SOURCE_STAGE_DIR/host-mcp-binaries/x86_64-apple-darwin/mcp-orc"
    chmod +x "$SOURCE_STAGE_DIR/host-mcp-binaries/aarch64-apple-darwin/mcp-orc"
    chmod +x "$SOURCE_STAGE_DIR/host-mcp-binaries/x86_64-apple-darwin/mcp-orc"

    uname() {
      printf '%s\n' 'Linux'
    }

    host_mcp_binary_is_current() {
      case "$2" in
        */aarch64-apple-darwin/mcp-orc)
          return 0
          ;;
        */x86_64-apple-darwin/mcp-orc)
          return 1
          ;;
        *)
          return 1
          ;;
      esac
    }

    set +e
    output="$(prepare_host_mcp_binaries 2>&1)"
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "prepare_host_mcp_binaries accepted stale Darwin host binaries on non-macOS"
    printf '%s' "$output" | grep -q "stale: x86_64-apple-darwin" || fail "prepare_host_mcp_binaries did not explain the stale non-macOS Darwin binary failure"

    rm -rf "$tmp_dir"
  )
}

test_prepare_host_mcp_binaries_fails_during_refresh_when_host_lockfile_drifts() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir status output
    tmp_dir="$(mktemp -d)"
    SOURCE_STAGE_DIR="$tmp_dir/source"

    mkdir -p \
      "$SOURCE_STAGE_DIR/src/scripts" \
      "$SOURCE_STAGE_DIR/host-mcp-binaries/aarch64-apple-darwin" \
      "$SOURCE_STAGE_DIR/host-mcp-binaries/x86_64-apple-darwin"
    : > "$SOURCE_STAGE_DIR/host-mcp-binaries/aarch64-apple-darwin/mcp-orc"
    : > "$SOURCE_STAGE_DIR/host-mcp-binaries/x86_64-apple-darwin/mcp-orc"
    chmod +x "$SOURCE_STAGE_DIR/host-mcp-binaries/aarch64-apple-darwin/mcp-orc"
    chmod +x "$SOURCE_STAGE_DIR/host-mcp-binaries/x86_64-apple-darwin/mcp-orc"

    cat > "$SOURCE_STAGE_DIR/src/scripts/build-host-mcp-binaries.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' 'Host MCP Rust lockfile is out of date. Run: cargo generate-lockfile --manifest-path "/workspace/src/mcp-orc-rust/Cargo.toml" and commit src/mcp-orc-rust/Cargo.lock before building host MCP binaries.' >&2
exit 1
EOF
    chmod +x "$SOURCE_STAGE_DIR/src/scripts/build-host-mcp-binaries.sh"

    uname() {
      printf '%s\n' 'Darwin'
    }

    set +e
    output="$(prepare_host_mcp_binaries 2>&1)"
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "prepare_host_mcp_binaries accepted lock drift during staged refresh"
    printf '%s' "$output" | grep -q 'Host MCP Rust lockfile is out of date' || fail "prepare_host_mcp_binaries did not surface the lock drift guidance from the staged build"
    printf '%s' "$output" | grep -q 'Failed to refresh staged host-mcp-binaries' || fail "prepare_host_mcp_binaries did not fail during staged host binary refresh"
    if printf '%s' "$output" | grep -q 'Staged host-mcp-binaries are not current after refresh'; then
      fail "prepare_host_mcp_binaries reported a stale-post-refresh error instead of failing during the refresh"
    fi

    rm -rf "$tmp_dir"
  )
}

test_verify_packaged_app_release_integrity_accepts_matching_metadata_and_prereq_scripts() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir app_path staged_prereq staged_reconcile_helper
    tmp_dir="$(mktemp -d)"
    app_path="$tmp_dir/Portico.app"
    SOURCE_STAGE_DIR="$tmp_dir/source"
    BUILD_ID="03122026-deadbeef"
    FULL_SHA="deadbeefcafefeeddeadbeefcafefeeddeadbeef"
    staged_prereq="$SOURCE_STAGE_DIR/src/scripts/prereq-download.sh"
    staged_reconcile_helper="$SOURCE_STAGE_DIR/src/scripts/managed-runtime-reconcile.sh"

    mkdir -p "$SOURCE_STAGE_DIR/electron-app" "$SOURCE_STAGE_DIR/src/scripts"
    cat > "$SOURCE_STAGE_DIR/electron-app/build-info.json" <<EOF
{
  "buildNumber": "${BUILD_ID}",
  "fullSha": "${FULL_SHA}",
  "date": "03122026",
  "timestamp": "2026-03-12T00:00:00.000Z",
  "channel": "portico_dev"
}
EOF
    printf '%s\n' '#!/usr/bin/env bash' 'echo prereq' > "$staged_prereq"
    chmod +x "$staged_prereq"
    printf '%s\n' '#!/usr/bin/env bash' 'echo helper' > "$staged_reconcile_helper"
    chmod +x "$staged_reconcile_helper"

    make_fake_packaged_app_with_release_resources \
      "$app_path" \
      "$SOURCE_STAGE_DIR/electron-app/build-info.json" \
      "$staged_prereq" \
      "$staged_reconcile_helper"

    verify_packaged_app_release_integrity "$app_path"

    rm -rf "$tmp_dir"
  )
}

test_verify_packaged_app_release_integrity_rejects_cloudsmith_resource_drift() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir app_path status
    tmp_dir="$(mktemp -d)"
    app_path="$tmp_dir/Portico.app"
    SOURCE_STAGE_DIR="$tmp_dir/source"
    BUILD_ID="03122026-deadbeef"
    FULL_SHA="deadbeefcafefeeddeadbeefcafefeeddeadbeef"

    make_staged_release_resources "$SOURCE_STAGE_DIR" "$BUILD_ID" "$FULL_SHA"
    make_fake_packaged_app_with_release_resources \
      "$app_path" \
      "$SOURCE_STAGE_DIR/electron-app/build-info.json" \
      "$SOURCE_STAGE_DIR/src/scripts/prereq-download.sh" \
      "$SOURCE_STAGE_DIR/src/scripts/managed-runtime-reconcile.sh"
    sed -i.bak 's/test-read-token/different-read-token/' \
      "$app_path/Contents/Resources/cloudsmith.env"
    rm -f "$app_path/Contents/Resources/cloudsmith.env.bak"

    set +e
    ( verify_packaged_app_release_integrity "$app_path" ) >/dev/null 2>&1
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "expected release integrity verification to reject Cloudsmith resource drift"
    rm -rf "$tmp_dir"
  )
}

test_verify_packaged_app_release_integrity_rejects_internally_inconsistent_build_info() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir app_path staged_prereq staged_reconcile_helper status
    tmp_dir="$(mktemp -d)"
    app_path="$tmp_dir/Portico.app"
    SOURCE_STAGE_DIR="$tmp_dir/source"
    BUILD_ID="03122026-feedface"
    FULL_SHA="deadbeefcafefeeddeadbeefcafefeeddeadbeef"
    staged_prereq="$SOURCE_STAGE_DIR/src/scripts/prereq-download.sh"
    staged_reconcile_helper="$SOURCE_STAGE_DIR/src/scripts/managed-runtime-reconcile.sh"

    mkdir -p "$SOURCE_STAGE_DIR/electron-app" "$SOURCE_STAGE_DIR/src/scripts"
    cat > "$SOURCE_STAGE_DIR/electron-app/build-info.json" <<EOF
{
  "buildNumber": "${BUILD_ID}",
  "fullSha": "${FULL_SHA}",
  "date": "03122026",
  "timestamp": "2026-03-12T00:00:00.000Z",
  "channel": "portico_dev"
}
EOF
    printf '%s\n' '#!/usr/bin/env bash' 'echo prereq' > "$staged_prereq"
    chmod +x "$staged_prereq"
    printf '%s\n' '#!/usr/bin/env bash' 'echo helper' > "$staged_reconcile_helper"
    chmod +x "$staged_reconcile_helper"

    make_fake_packaged_app_with_release_resources \
      "$app_path" \
      "$SOURCE_STAGE_DIR/electron-app/build-info.json" \
      "$staged_prereq" \
      "$staged_reconcile_helper"

    set +e
    ( verify_packaged_app_release_integrity "$app_path" ) >/dev/null 2>&1
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "expected release integrity verification to reject mismatched buildNumber/fullSha"

    rm -rf "$tmp_dir"
  )
}

test_resolve_full_sha_prefers_git_head_over_stale_build_info() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir log_file expected_sha
    tmp_dir="$(mktemp -d)"
    log_file="$(mktemp)"

    mkdir -p "$tmp_dir/electron-app"
    git -C "$tmp_dir" init -q
    git -C "$tmp_dir" config user.name "Package Script Test"
    git -C "$tmp_dir" config user.email "package-script-test@example.com"
    printf '%s\n' 'release test fixture' > "$tmp_dir/README.md"
    git -C "$tmp_dir" add README.md
    git -C "$tmp_dir" commit -q -m "initial commit"

    expected_sha="$(git -C "$tmp_dir" rev-parse HEAD | tr '[:upper:]' '[:lower:]')"
    printf '%s\n' '{' \
      '  "buildNumber": "03162026-deadbeef",' \
      '  "fullSha": "deadbeefcafefeeddeadbeefcafefeeddeadbeef"' \
      '}' > "$tmp_dir/electron-app/build-info.json"

    MANAGED_ROOT_SOURCE="$tmp_dir"
    FULL_SHA=""
    resolve_full_sha >"$log_file"

    [ "$FULL_SHA" = "$expected_sha" ] || fail "resolve_full_sha did not prefer git HEAD over stale build-info.json"
    grep -q "Ignoring stale electron-app/build-info.json fullSha" "$log_file" || fail "resolve_full_sha did not warn about stale build-info.json"

    rm -rf "$tmp_dir" "$log_file"
  )
}

test_resolve_full_sha_falls_back_to_build_info_when_git_is_unavailable() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir expected_sha
    tmp_dir="$(mktemp -d)"
    expected_sha="feedfacecafebeefdeadbeeffeedfacecafebeef"

    mkdir -p "$tmp_dir/electron-app"
    printf '%s\n' '{' \
      '  "buildNumber": "03162026-feedface",' \
      "  \"fullSha\": \"${expected_sha}\"" \
      '}' > "$tmp_dir/electron-app/build-info.json"

    MANAGED_ROOT_SOURCE="$tmp_dir"
    FULL_SHA=""
    resolve_full_sha

    [ "$FULL_SHA" = "$expected_sha" ] || fail "resolve_full_sha did not fall back to build-info.json when git was unavailable"

    rm -rf "$tmp_dir"
  )
}

test_validate_release_metadata_consistency_fails_before_packaging() {
  (
    source "$PACKAGE_SCRIPT"

    local output status
    BUILD_ID="03162026-168a1664"
    FULL_SHA="4abfdda8a6d8d7e2552a8a8460f27bec1b1e7c22"

    set +e
    output="$(validate_release_metadata_consistency 2>&1)"
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "expected metadata consistency validation to reject mismatched build id and full SHA"
    printf '%s' "$output" | grep -q "Resolved release metadata is inconsistent before packaging" || fail "metadata consistency validation did not explain the mismatch"
  )
}

test_stage_payload_contents_verifies_copied_app_bundles() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir log_file
    tmp_dir="$(mktemp -d)"
    log_file="$(mktemp)"

    PAYLOAD_STAGE_DIR="$tmp_dir/payload"
    OUTPUT_ZIP="$tmp_dir/portico_dev-03122026-deadbeef.zip"
    HOST_MCP_SOURCE_DIR="$tmp_dir/host-mcp-binaries"
    APP_BUNDLE_NAME="Portico.app"
    APP_ARM64="$tmp_dir/input-arm64/Portico.app"
    APP_X64="$tmp_dir/input-x64/Portico.app"
    DMG_ARM64="$tmp_dir/input-arm64/Portico-arm64.dmg"
    DMG_X64="$tmp_dir/input-x64/Portico.dmg"

    mkdir -p "$APP_ARM64"
    mkdir -p "$APP_X64"
    mkdir -p "$HOST_MCP_SOURCE_DIR"
    : > "$DMG_ARM64"
    : > "$DMG_X64"

    stage_managed_root() { :; }
    verify_packaged_app_release_integrity() { :; }
    sync_directory_contents() {
      mkdir -p "$2"
    }
    docker_images_json_for_release_manifest() {
      printf '[]'
    }
    host_mcp_targets_json() {
      printf '[]'
    }
    write_release_manifest() {
      : > "$PAYLOAD_STAGE_DIR/release-manifest.json"
    }
    verify_packaged_app_host_mcp_binaries() {
      printf '%s\n' "$1" >> "$log_file"
    }
    validate_release_payload_path() {
      printf 'validator %s %s %s\n' "$1" "$2" "$3" >> "$log_file"
    }

    stage_payload_contents

    grep -q "$PAYLOAD_STAGE_DIR/artifacts/apps/darwin-arm64/$APP_BUNDLE_NAME" "$log_file" || fail "stage_payload_contents did not verify copied arm64 app bundle"
    grep -q "$PAYLOAD_STAGE_DIR/artifacts/apps/darwin-x64/$APP_BUNDLE_NAME" "$log_file" || fail "stage_payload_contents did not verify copied x64 app bundle"
    grep -q "validator $PAYLOAD_STAGE_DIR true portico_dev-03122026-deadbeef.zip" "$log_file" \
      || fail "stage_payload_contents did not run the shared validator with macOS verification"

    rm -rf "$tmp_dir" "$log_file"
  )
}

test_write_release_manifest_includes_schema_v2_and_docker_images() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir manifest_path
    tmp_dir="$(mktemp -d)"
    PAYLOAD_STAGE_DIR="$tmp_dir/payload"
    BUILD_ID="03122026-deadbeef"
    FULL_SHA="deadbeefcafefeed"
    CHANNEL_PACKAGE_NAME="portico_dev"
    DOCKER_IMAGE_TAG="03122026-deadbeef"
    DMG_ARM64="$tmp_dir/Portico-arm64.dmg"
    DMG_X64="$tmp_dir/Portico-x64.dmg"
    : > "$DMG_ARM64"
    : > "$DMG_X64"

    mkdir -p "$PAYLOAD_STAGE_DIR"
    write_release_manifest \
      '["darwin-arm64", "darwin-x64"]' \
      '[{"name":"redis","tag":"7-alpine","label":"Redis Cache"},{"name":"harbor.example.invalid/portico/mcp-orc-rust","tag":"03122026-deadbeef","label":"MCP Runtime"}]'

    manifest_path="$PAYLOAD_STAGE_DIR/release-manifest.json"

    grep -q '"schemaVersion": 2' "$manifest_path" || fail "release manifest should declare schemaVersion 2"
    grep -q '"dockerImages": \[{' "$manifest_path" || fail "release manifest should include dockerImages"
    grep -q '"name":"redis"' "$manifest_path" || fail "release manifest should include community image specs"
    grep -q '"name":"harbor.example.invalid/portico/mcp-orc-rust"' "$manifest_path" || fail "release manifest should include harbor image specs"

    rm -rf "$tmp_dir"
  )
}

test_prepare_release_docker_images_force_builds_all_images() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir log_file
    tmp_dir="$(mktemp -d)"
    log_file="$tmp_dir/build.log"
    SOURCE_STAGE_DIR="$tmp_dir/staged-source"
    mkdir -p "$SOURCE_STAGE_DIR"
    DOCKER_IMAGE_TAG="03122026-deadbeef"
    FULL_SHA="deadbeefcafefeeddeadbeefcafefeeddeadbeef"
    FORCE_DOCKER_IMAGES=true
    DID_BUILD_DOCKER_IMAGES=false

    docker() { :; }
    validate_published_release_image() { return 0; }

    cat > "$SOURCE_STAGE_DIR/build_docker_images.sh" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$log_file"
printf 'cwd=%s\n' "\$PWD" >> "$log_file"
EOF
    chmod +x "$SOURCE_STAGE_DIR/build_docker_images.sh"

    prepare_release_docker_images

    grep -q '^03122026-deadbeef --images mcpo-control-plane-rust,mcp-orc-rust,bifrost-bridge,open-webui-patched,health-check,chat-state-api,agent-vm --source-revision deadbeefcafefeeddeadbeefcafefeeddeadbeef$' "$log_file" \
      || fail "forced Docker preparation should invoke build_docker_images.sh for every image"
    grep -Fq "cwd=$SOURCE_STAGE_DIR" "$log_file" \
      || fail "Docker image build did not run from the staged source snapshot"
    [ "$DID_BUILD_DOCKER_IMAGES" = true ] || fail "prepare_release_docker_images should mark Docker images as built"
    [ "$DOCKER_IMAGES_BUILT" = "$(release_image_names)" ] || fail "forced Docker preparation should record every built image"

    rm -rf "$tmp_dir"
  )
}

test_prepare_release_docker_images_reuses_all_valid_images() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir sync_log
    tmp_dir="$(mktemp -d)"
    sync_log="$tmp_dir/sync.log"
    SOURCE_STAGE_DIR="$tmp_dir/staged-source"
    PACKAGE_SOURCE_CLEAN=true
    mkdir -p "$SOURCE_STAGE_DIR"
    DOCKER_IMAGE_TAG="03122026-deadbeef"
    FULL_SHA="deadbeefcafefeeddeadbeefcafefeeddeadbeef"

    docker() { :; }
    release_source_tree_is_clean() { return 0; }
    validate_published_release_image() { return 0; }
    sync_reused_release_image_latest_aliases() {
      printf '%s\n' "$DOCKER_IMAGES_REUSED" > "$sync_log"
    }

    prepare_release_docker_images

    [ "$DID_BUILD_DOCKER_IMAGES" = false ] || fail "valid exact-tag images should not be rebuilt"
    [ "$DOCKER_IMAGES_REUSED" = "$(release_image_names)" ] || fail "all valid images should be recorded as reused"
    [ ! -e "$SOURCE_STAGE_DIR/build_docker_images.sh" ] || fail "reuse test unexpectedly created a build script"
    grep -q '^mcpo-control-plane-rust mcp-orc-rust bifrost-bridge open-webui-patched health-check chat-state-api agent-vm$' "$sync_log" \
      || fail "reused images should have their latest aliases synchronized"

    rm -rf "$tmp_dir"
  )
}

test_prepare_release_docker_images_builds_only_invalid_images() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir log_file sync_log
    tmp_dir="$(mktemp -d)"
    log_file="$tmp_dir/build.log"
    sync_log="$tmp_dir/sync.log"
    SOURCE_STAGE_DIR="$tmp_dir/staged-source"
    PACKAGE_SOURCE_CLEAN=true
    mkdir -p "$SOURCE_STAGE_DIR"
    DOCKER_IMAGE_TAG="03122026-deadbeef"
    FULL_SHA="deadbeefcafefeeddeadbeefcafefeeddeadbeef"

    docker() { :; }
    release_source_tree_is_clean() { return 0; }
    validate_published_release_image() {
      if [ "$1" = "agent-vm" ] && [ "$DID_BUILD_DOCKER_IMAGES" = false ]; then
        return 1
      fi
      return 0
    }
    sync_reused_release_image_latest_aliases() {
      printf '%s\n' "$DOCKER_IMAGES_REUSED" > "$sync_log"
    }

    cat > "$SOURCE_STAGE_DIR/build_docker_images.sh" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$log_file"
EOF
    chmod +x "$SOURCE_STAGE_DIR/build_docker_images.sh"

    prepare_release_docker_images

    grep -q '^03122026-deadbeef --images agent-vm --source-revision deadbeefcafefeeddeadbeefcafefeeddeadbeef$' "$log_file" \
      || fail "partial Docker preparation should build only agent-vm"
    [ "$DOCKER_IMAGES_BUILT" = "agent-vm" ] || fail "partial Docker preparation should record only agent-vm as built"
    [ "$DOCKER_IMAGES_REUSED" = "mcpo-control-plane-rust mcp-orc-rust bifrost-bridge open-webui-patched health-check chat-state-api" ] \
      || fail "partial Docker preparation should record the remaining images as reused"
    grep -q '^mcpo-control-plane-rust mcp-orc-rust bifrost-bridge open-webui-patched health-check chat-state-api$' "$sync_log" \
      || fail "only reused image aliases should be synchronized"

    rm -rf "$tmp_dir"
  )
}

test_prepare_release_docker_images_dirty_tree_builds_all_images() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir log_file
    tmp_dir="$(mktemp -d)"
    log_file="$tmp_dir/build.log"
    SOURCE_STAGE_DIR="$tmp_dir/staged-source"
    PACKAGE_SOURCE_CLEAN=false
    mkdir -p "$SOURCE_STAGE_DIR"
    DOCKER_IMAGE_TAG="03122026-deadbeef"
    FULL_SHA="deadbeefcafefeeddeadbeefcafefeeddeadbeef"

    docker() { :; }
    release_source_tree_is_clean() { return 1; }
    validate_published_release_image() { return 0; }

    cat > "$SOURCE_STAGE_DIR/build_docker_images.sh" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$log_file"
EOF
    chmod +x "$SOURCE_STAGE_DIR/build_docker_images.sh"

    prepare_release_docker_images

    grep -q -- '--images mcpo-control-plane-rust,mcp-orc-rust,bifrost-bridge,open-webui-patched,health-check,chat-state-api,agent-vm' "$log_file" \
      || fail "dirty source trees should rebuild every runtime image"
    [ -z "$DOCKER_IMAGES_REUSED" ] || fail "dirty source trees should not reuse published images"

    rm -rf "$tmp_dir"
  )
}

test_prepare_release_docker_images_skip_validates_and_fails_closed() {
  if (
    source "$PACKAGE_SCRIPT"
    SKIP_DOCKER_IMAGES=true
    FORCE_DOCKER_IMAGES=false
    DOCKER_IMAGE_TAG="03122026-deadbeef"
    FULL_SHA="deadbeefcafefeeddeadbeefcafefeeddeadbeef"
    docker() { :; }
    validate_published_release_image() { [ "$1" != "agent-vm" ]; }
    prepare_release_docker_images
  ) >/dev/null 2>&1; then
    fail "explicit Docker skip should fail when a required image is invalid"
  fi
}

test_prepare_release_docker_images_rejects_force_and_skip() {
  local entrypoint

  for entrypoint in validate_configuration prepare_release_docker_images; do
    if (
      source "$PACKAGE_SCRIPT"
      SKIP_DOCKER_IMAGES=true
      FORCE_DOCKER_IMAGES=true
      "$entrypoint"
    ) >/dev/null 2>&1; then
      fail "force and skip Docker modes should be rejected by $entrypoint"
    fi
  done
}

test_release_image_metadata_validation() {
  (
    source "$PACKAGE_SCRIPT"

    local revision tag labeled legacy partial mismatched missing_platform
    revision="deadbeefcafefeeddeadbeefcafefeeddeadbeef"
    tag="03122026-deadbeef"
    labeled="{\"linux/amd64\":{\"config\":{\"Labels\":{\"org.opencontainers.image.revision\":\"$revision\",\"org.opencontainers.image.version\":\"$tag\"}}},\"linux/arm64\":{\"config\":{\"Labels\":{\"org.opencontainers.image.revision\":\"$revision\",\"org.opencontainers.image.version\":\"$tag\"}}}}"
    legacy='{"linux/amd64":{"config":{"Labels":{}}},"linux/arm64":{"config":{"Labels":{}}}}'
    partial="{\"linux/amd64\":{\"config\":{\"Labels\":{\"org.opencontainers.image.revision\":\"$revision\",\"org.opencontainers.image.version\":\"$tag\"}}},\"linux/arm64\":{\"config\":{\"Labels\":{}}}}"
    mismatched="{\"linux/amd64\":{\"config\":{\"Labels\":{\"org.opencontainers.image.revision\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}}},\"linux/arm64\":{\"config\":{\"Labels\":{}}}}"
    missing_platform='{"linux/amd64":{"config":{"Labels":{}}}}'

    [ "$(validate_release_image_metadata_json "$labeled" "$revision" "$tag")" = "labeled" ] \
      || fail "matching image metadata should validate as labeled"
    [ "$(validate_release_image_metadata_json "$legacy" "$revision" "$tag")" = "legacy" ] \
      || fail "legacy exact-tag metadata should remain compatible"
    if validate_release_image_metadata_json "$partial" "$revision" "$tag" >/dev/null 2>&1; then
      fail "partially labeled manifests should not be accepted as legacy"
    fi
    if validate_release_image_metadata_json "$mismatched" "$revision" "$tag" >/dev/null 2>&1; then
      fail "revision label mismatches should fail image validation"
    fi
    if validate_release_image_metadata_json "$missing_platform" "$revision" "$tag" >/dev/null 2>&1; then
      fail "missing architectures should fail image validation"
    fi
  )
}

test_sync_reused_release_images_updates_and_revalidates_latest() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir docker_log validation_log
    tmp_dir="$(mktemp -d)"
    docker_log="$tmp_dir/docker.log"
    validation_log="$tmp_dir/validation.log"
    DOCKER_IMAGE_TAG="03122026-deadbeef"
    DOCKER_IMAGES_REUSED="agent-vm"

    docker() {
      printf '%s\n' "$*" >> "$docker_log"
    }
    validate_published_release_image_ref() {
      printf '%s %s\n' "$1" "$2" >> "$validation_log"
    }

    sync_reused_release_image_latest_aliases

    grep -Fq 'buildx imagetools create -t harbor.example.invalid/portico/agent-vm:latest harbor.example.invalid/portico/agent-vm:03122026-deadbeef' "$docker_log" \
      || fail "reused exact tags should synchronize latest"
    grep -Fxq 'agent-vm harbor.example.invalid/portico/agent-vm:latest' "$validation_log" \
      || fail "synchronized latest aliases should be revalidated"

    rm -rf "$tmp_dir"
  )
}

test_sync_reused_release_images_skips_matching_latest_manifest_digest() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir docker_log
    tmp_dir="$(mktemp -d)"
    docker_log="$tmp_dir/docker.log"
    DOCKER_IMAGE_TAG="03122026-deadbeef"
    DOCKER_IMAGES_REUSED="agent-vm"

    docker() {
      printf '%s\n' "$*" >> "$docker_log"
      case "$*" in
        buildx\ imagetools\ inspect\ --raw\ *)
          printf '%s\n' '{"schemaVersion":2,"manifests":[{"digest":"sha256:shared"}]}'
          ;;
      esac
    }
    validate_published_release_image_ref() {
      fail "matching latest digest should not be republished or revalidated"
    }

    sync_reused_release_image_latest_aliases >/dev/null

    [ "$(grep -c 'buildx imagetools inspect --raw' "$docker_log")" = "2" ] \
      || fail "latest digest comparison did not inspect both exact and latest manifests"
    if grep -q 'buildx imagetools create' "$docker_log"; then
      fail "matching latest digest performed a no-op Harbor manifest push"
    fi

    rm -rf "$tmp_dir"
  )
}

test_agent_vm_dockerfile_has_resilient_apt_contract() {
  local dockerfile="$PROJECT_ROOT/Dockerfile.agent-vm"

  grep -Fq 'rm -f /etc/apt/apt.conf.d/docker-clean' "$dockerfile" \
    || fail "agent-vm should retain downloaded APT packages in the BuildKit cache"
  grep -Fq "s|http://deb.debian.org|https://deb.debian.org|g" "$dockerfile" \
    || fail "agent-vm should switch Debian sources to HTTPS"
  grep -Fq 'id=agent-vm-apt-lock,target=/var/lock/agent-vm-apt,sharing=locked' "$dockerfile" \
    || fail "agent-vm should serialize multi-arch APT transactions"
  grep -Fq 'id=agent-vm-apt-archives-${TARGETARCH},target=/var/cache/apt,sharing=locked' "$dockerfile" \
    || fail "agent-vm should persist per-architecture APT archives"
  grep -Fq 'id=agent-vm-apt-lists-${TARGETARCH},target=/var/lib/apt/lists,sharing=locked' "$dockerfile" \
    || fail "agent-vm should persist per-architecture APT indexes"
  ! grep -Fq 'rm -rf /usr/share/doc/* /usr/share/info/* /usr/share/man/* /var/lib/apt/lists/*' "$dockerfile" \
    || fail "agent-vm should not delete the mounted APT index cache"
}

make_fake_release_docker_cli() {
  local fake_path="$1"
  local fake_dir

  fake_dir="$(dirname "$fake_path")"

  cat > "$fake_path" <<'EOF'
#!/usr/bin/env bash
set -eu

printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"

if [ "${1:-}" = "info" ]; then
  if [ "${FAKE_DOCKER_SCENARIO:-success}" = "buildkit_rpc_daemon_down" ] \
    && [ -f "${FAKE_BUILD_COUNT:-/nonexistent}" ]; then
    exit 1
  fi
  exit 0
fi

if [ "${1:-}" = "pull" ]; then
  exit 0
fi

if [ "${1:-}" = "buildx" ] && [ "${2:-}" = "inspect" ]; then
  if [ "${FAKE_DOCKER_SCENARIO:-success}" = "buildkit_rpc_builder_down" ] \
    && [ -f "${FAKE_BUILD_COUNT:-/nonexistent}" ] \
    && [ "${4:-}" = "--bootstrap" ]; then
    exit 1
  fi
  if [ "${4:-}" = "--bootstrap" ] || [ -f "$FAKE_BUILDER_CREATED" ]; then
    exit 0
  fi
  exit 1
fi

if [ "${1:-}" = "buildx" ] && [ "${2:-}" = "create" ]; then
  : > "$FAKE_BUILDER_CREATED"
  printf '%s\n' "${FAKE_BUILDER_NAME:-fake-builder}"
  exit 0
fi

if [ "${1:-}" = "buildx" ] && [ "${2:-}" = "use" ]; then
  exit 0
fi

if [ "${1:-}" = "buildx" ] && [ "${2:-}" = "build" ]; then
  count=0
  if [ -f "$FAKE_BUILD_COUNT" ]; then
    count="$(cat "$FAKE_BUILD_COUNT")"
  fi
  count=$((count + 1))
  printf '%s\n' "$count" > "$FAKE_BUILD_COUNT"

  case "${FAKE_DOCKER_SCENARIO:-success}" in
    retry_once)
      if [ "$count" -eq 1 ]; then
        echo "Could not connect to deb.debian.org:443, connection timed out" >&2
        exit 1
      fi
      ;;
    cargo_http2_retry_once)
      if [ "$count" -eq 1 ]; then
        echo 'error: failed to get `ryu` as a dependency of package `redis v1.0.4`' >&2
        echo 'Caused by: download of 3/r/ryu failed' >&2
        echo 'Caused by: curl failed' >&2
        echo 'Caused by: [16] Error in the HTTP2 framing layer' >&2
        exit 1
      fi
      ;;
    cargo_http2_failure)
      echo 'error: failed to get `ryu` as a dependency of package `redis v1.0.4`' >&2
      echo 'Caused by: download of 3/r/ryu failed' >&2
      echo 'Caused by: curl failed' >&2
      echo 'Caused by: [16] Error in the HTTP2 framing layer' >&2
      exit 1
      ;;
    network_failure)
      echo "Unable to connect to deb.debian.org:https:" >&2
      exit 1
      ;;
    deterministic_failure)
      echo "error: could not compile application" >&2
      exit 1
      ;;
    compile_after_network_warning)
      echo "warning: Temporary failure resolving crates.io; retry recovered" >&2
      echo "error: could not compile application" >&2
      exit 1
      ;;
    compile_after_cargo_http2_failure)
      echo 'Caused by: download of 3/r/ryu failed' >&2
      echo 'Caused by: [16] Error in the HTTP2 framing layer' >&2
      echo 'error: could not compile application' >&2
      exit 1
      ;;
    cargo_lock_failure)
      echo 'warning: spurious network error (1 tries remaining)' >&2
      echo 'error: the lock file /build/Cargo.lock needs to be updated but --locked was passed' >&2
      exit 1
      ;;
    cargo_checksum_failure)
      echo 'Caused by: failed to download from https://static.crates.io/crates/ryu/1.0.20/download' >&2
      echo 'error: checksum failed for `ryu v1.0.20`' >&2
      exit 1
      ;;
    authentication_failure)
      echo "failed to do request: 401 Unauthorized" >&2
      exit 1
      ;;
    buildkit_rpc_recover|buildkit_rpc_daemon_down|buildkit_rpc_builder_down|buildkit_rpc_low_disk)
      if [ "$count" -eq 1 ]; then
        echo 'ERROR: failed to build: failed to receive status: rpc error: code = Unavailable desc = error reading from server: EOF' >&2
        exit 1
      fi
      ;;
  esac
  exit 0
fi

if [ "${1:-}" = "buildx" ] && [ "${2:-}" = "imagetools" ] && [ "${3:-}" = "inspect" ]; then
  for arg in "$@"; do
    if [ "$arg" = "--raw" ]; then
      printf '%s\n' '{}'
      exit 0
    fi
  done
  printf '%s\n' 'Platform: linux/amd64' 'Platform: linux/arm64'
  exit 0
fi

exit 0
EOF
  chmod +x "$fake_path"

  cat > "$fake_dir/df" <<'EOF'
#!/usr/bin/env bash
set -eu

available_kib=104857600
if [ "${FAKE_DOCKER_SCENARIO:-success}" = "low_disk_initial" ]; then
  available_kib=1048576
elif [ "${FAKE_DOCKER_SCENARIO:-success}" = "buildkit_rpc_low_disk" ] \
  && [ -f "${FAKE_BUILD_COUNT:-/nonexistent}" ]; then
  available_kib=1048576
fi

printf '%s\n' \
  'Filesystem 1024-blocks Used Available Capacity Mounted on' \
  "/dev/fake 209715200 104857600 ${available_kib} 50% /"
EOF
  chmod +x "$fake_dir/df"
}

test_build_docker_images_selects_retries_labels_and_pins_builder() {
  (
    local tmp_dir fake_bin output revision
    tmp_dir="$(mktemp -d)"
    fake_bin="$tmp_dir/bin"
    output="$tmp_dir/output.log"
    revision="deadbeefcafefeeddeadbeefcafefeeddeadbeef"
    mkdir -p "$fake_bin"
    make_fake_release_docker_cli "$fake_bin/docker"

    export FAKE_DOCKER_LOG="$tmp_dir/docker.log"
    export FAKE_BUILD_COUNT="$tmp_dir/build-count"
    export FAKE_BUILDER_CREATED="$tmp_dir/builder-created"
    export FAKE_BUILDER_NAME="portico-multiarch-v030"
    export FAKE_DOCKER_SCENARIO="retry_once"

    cd "$PROJECT_ROOT"
    PATH="$fake_bin:$PATH" \
      TMPDIR="$tmp_dir" \
      DOCKER_BUILD_RETRY_DELAY_SECONDS=0 \
      bash "$PROJECT_ROOT/build_docker_images.sh" 03122026-deadbeef \
        --images agent-vm \
        --source-revision "$revision" > "$output" 2>&1 \
      || fail "selective Docker build should recover from one network failure"

    [ "$(cat "$FAKE_BUILD_COUNT")" = "2" ] || fail "retryable network failures should receive exactly one retry"
    grep -Fq 'buildx create --name portico-multiarch-v030 --driver docker-container --driver-opt image=moby/buildkit:v0.30.0' "$FAKE_DOCKER_LOG" \
      || fail "Docker builds should create the pinned versioned BuildKit builder"
    grep -Fq -- '--label org.opencontainers.image.revision=deadbeefcafefeeddeadbeefcafefeeddeadbeef' "$FAKE_DOCKER_LOG" \
      || fail "Docker builds should label the source revision"
    grep -Fq -- '--label org.opencontainers.image.version=03122026-deadbeef' "$FAKE_DOCKER_LOG" \
      || fail "Docker builds should label the release version"
    grep -Fq -- '-f Dockerfile.agent-vm' "$FAKE_DOCKER_LOG" \
      || fail "selective Docker builds should include agent-vm"
    ! grep -Fq -- '-f Dockerfile.open-webui-patched' "$FAKE_DOCKER_LOG" \
      || fail "selective Docker builds should exclude unrequested images"
    rm -rf "$tmp_dir"
  )
}

test_build_docker_images_retries_cargo_http2_failures() {
  (
    local tmp_dir fake_bin revision
    tmp_dir="$(mktemp -d)"
    fake_bin="$tmp_dir/bin"
    revision="deadbeefcafefeeddeadbeefcafefeeddeadbeef"
    mkdir -p "$fake_bin"
    make_fake_release_docker_cli "$fake_bin/docker"

    export FAKE_DOCKER_LOG="$tmp_dir/docker.log"
    export FAKE_BUILD_COUNT="$tmp_dir/build-count"
    export FAKE_BUILDER_CREATED="$tmp_dir/builder-created"
    export FAKE_BUILDER_NAME="portico-multiarch-v030"
    export FAKE_DOCKER_SCENARIO="cargo_http2_retry_once"

    cd "$PROJECT_ROOT"
    PATH="$fake_bin:$PATH" \
      TMPDIR="$tmp_dir" \
      DOCKER_BUILD_RETRY_DELAY_SECONDS=0 \
      bash "$PROJECT_ROOT/build_docker_images.sh" 03122026-deadbeef \
        --images mcp-orc-rust \
        --source-revision "$revision" >/dev/null 2>&1 \
      || fail "Cargo HTTP/2 framing failures should receive a Docker build retry"

    [ "$(cat "$FAKE_BUILD_COUNT")" = "2" ] \
      || fail "Cargo HTTP/2 framing failure should retry exactly once by default"

    rm -rf "$tmp_dir"
  )
}

test_build_docker_images_rejects_insufficient_initial_disk_space() {
  (
    local tmp_dir fake_bin output revision
    tmp_dir="$(mktemp -d)"
    fake_bin="$tmp_dir/bin"
    output="$tmp_dir/output.log"
    revision="deadbeefcafefeeddeadbeefcafefeeddeadbeef"
    mkdir -p "$fake_bin"
    make_fake_release_docker_cli "$fake_bin/docker"

    export FAKE_DOCKER_LOG="$tmp_dir/docker.log"
    export FAKE_BUILD_COUNT="$tmp_dir/build-count"
    export FAKE_BUILDER_CREATED="$tmp_dir/builder-created"
    export FAKE_DOCKER_SCENARIO="low_disk_initial"

    cd "$PROJECT_ROOT"
    if PATH="$fake_bin:$PATH" TMPDIR="$tmp_dir" \
      bash "$PROJECT_ROOT/build_docker_images.sh" 03122026-deadbeef \
        --images agent-vm --source-revision "$revision" >"$output" 2>&1; then
      fail "Docker builds should fail before startup when local disk is below the minimum"
    fi

    [ ! -f "$FAKE_BUILD_COUNT" ] || fail "low-disk preflight should stop before invoking a build"
    grep -Fq 'Insufficient local disk space for Docker image builds' "$output" \
      || fail "low-disk preflight did not report the Docker build operation"
    grep -Fq 'local disk capacity failure, not a remote network failure' "$output" \
      || fail "low-disk preflight did not distinguish disk exhaustion from networking"

    rm -rf "$tmp_dir"
  )
}

test_build_docker_images_retries_recovered_buildkit_control_plane_failure() {
  (
    local tmp_dir fake_bin output revision
    tmp_dir="$(mktemp -d)"
    fake_bin="$tmp_dir/bin"
    output="$tmp_dir/output.log"
    revision="deadbeefcafefeeddeadbeefcafefeeddeadbeef"
    mkdir -p "$fake_bin"
    make_fake_release_docker_cli "$fake_bin/docker"

    export FAKE_DOCKER_LOG="$tmp_dir/docker.log"
    export FAKE_BUILD_COUNT="$tmp_dir/build-count"
    export FAKE_BUILDER_CREATED="$tmp_dir/builder-created"
    export FAKE_BUILDER_NAME="portico-multiarch-v030"
    export FAKE_DOCKER_SCENARIO="buildkit_rpc_recover"

    cd "$PROJECT_ROOT"
    PATH="$fake_bin:$PATH" TMPDIR="$tmp_dir" DOCKER_BUILD_RETRY_DELAY_SECONDS=0 \
      bash "$PROJECT_ROOT/build_docker_images.sh" 03122026-deadbeef \
        --images agent-vm --source-revision "$revision" >"$output" 2>&1 \
      || fail "a recovered BuildKit control-plane disconnect should receive one retry"

    [ "$(cat "$FAKE_BUILD_COUNT")" = "2" ] \
      || fail "recovered BuildKit control-plane failure should retry exactly once"
    [ "$(grep -c '^info$' "$FAKE_DOCKER_LOG")" -ge 2 ] \
      || fail "BuildKit RPC recovery did not recheck the local Docker daemon"
    [ "$(grep -c '^buildx inspect portico-multiarch-v030 --bootstrap$' "$FAKE_DOCKER_LOG")" -ge 2 ] \
      || fail "BuildKit RPC recovery did not re-bootstrap the configured builder"
    grep -Fq 'BuildKit control-plane disconnect detected' "$PROJECT_ROOT/build_docker_images.sh" \
      || fail "BuildKit RPC EOF classification diagnostic is missing"

    rm -rf "$tmp_dir"
  )
}

test_build_docker_images_does_not_retry_unavailable_local_runtime() {
  local scenario expected_message

  for scenario in buildkit_rpc_daemon_down buildkit_rpc_builder_down; do
    (
      local tmp_dir fake_bin output revision
      tmp_dir="$(mktemp -d)"
      fake_bin="$tmp_dir/bin"
      output="$tmp_dir/output.log"
      revision="deadbeefcafefeeddeadbeefcafefeeddeadbeef"
      mkdir -p "$fake_bin"
      make_fake_release_docker_cli "$fake_bin/docker"

      export FAKE_DOCKER_LOG="$tmp_dir/docker.log"
      export FAKE_BUILD_COUNT="$tmp_dir/build-count"
      export FAKE_BUILDER_CREATED="$tmp_dir/builder-created"
      export FAKE_BUILDER_NAME="portico-multiarch-v030"
      export FAKE_DOCKER_SCENARIO="$scenario"

      case "$scenario" in
        buildkit_rpc_daemon_down) expected_message='Local Docker/OrbStack is unavailable' ;;
        buildkit_rpc_builder_down) expected_message='BuildKit builder portico-multiarch-v030 is unavailable' ;;
      esac

      cd "$PROJECT_ROOT"
      if PATH="$fake_bin:$PATH" TMPDIR="$tmp_dir" DOCKER_BUILD_RETRY_DELAY_SECONDS=0 \
        bash "$PROJECT_ROOT/build_docker_images.sh" 03122026-deadbeef \
          --images agent-vm --source-revision "$revision" >"$output" 2>&1; then
        fail "$scenario should fail without retrying"
      fi

      [ "$(cat "$FAKE_BUILD_COUNT")" = "1" ] \
        || fail "$scenario should not retry while the local runtime is unavailable"
      grep -Fq "$expected_message" "$output" \
        || fail "$scenario did not report the unavailable local runtime component"
      find "$tmp_dir" -type f -name '.portico-build-logs' | grep -q . \
        || fail "failed BuildKit runs should preserve an identifiable build-log directory"

      rm -rf "$tmp_dir"
    )
  done
}

test_build_docker_images_blocks_rpc_retry_when_disk_fills() {
  (
    local tmp_dir fake_bin output revision
    tmp_dir="$(mktemp -d)"
    fake_bin="$tmp_dir/bin"
    output="$tmp_dir/output.log"
    revision="deadbeefcafefeeddeadbeefcafefeeddeadbeef"
    mkdir -p "$fake_bin"
    make_fake_release_docker_cli "$fake_bin/docker"

    export FAKE_DOCKER_LOG="$tmp_dir/docker.log"
    export FAKE_BUILD_COUNT="$tmp_dir/build-count"
    export FAKE_BUILDER_CREATED="$tmp_dir/builder-created"
    export FAKE_BUILDER_NAME="portico-multiarch-v030"
    export FAKE_DOCKER_SCENARIO="buildkit_rpc_low_disk"

    cd "$PROJECT_ROOT"
    if PATH="$fake_bin:$PATH" TMPDIR="$tmp_dir" DOCKER_BUILD_RETRY_DELAY_SECONDS=0 \
      bash "$PROJECT_ROOT/build_docker_images.sh" 03122026-deadbeef \
        --images agent-vm --source-revision "$revision" >"$output" 2>&1; then
      fail "BuildKit RPC failure should not retry after local disk drops below the minimum"
    fi

    [ "$(cat "$FAKE_BUILD_COUNT")" = "1" ] \
      || fail "low disk after a BuildKit RPC failure should block the retry"
    grep -Fq 'BuildKit retry blocked because local disk headroom is below the configured minimum' "$output" \
      || fail "BuildKit retry did not report insufficient local disk headroom"

    rm -rf "$tmp_dir"
  )
}

test_build_docker_images_does_not_retry_deterministic_failures() {
  (
    local tmp_dir fake_bin revision
    tmp_dir="$(mktemp -d)"
    fake_bin="$tmp_dir/bin"
    revision="deadbeefcafefeeddeadbeefcafefeeddeadbeef"
    mkdir -p "$fake_bin"
    make_fake_release_docker_cli "$fake_bin/docker"

    export FAKE_DOCKER_LOG="$tmp_dir/docker.log"
    export FAKE_BUILD_COUNT="$tmp_dir/build-count"
    export FAKE_BUILDER_CREATED="$tmp_dir/builder-created"
    export FAKE_BUILDER_NAME="portico-multiarch-v030"
    export FAKE_DOCKER_SCENARIO="deterministic_failure"

    cd "$PROJECT_ROOT"
    if PATH="$fake_bin:$PATH" TMPDIR="$tmp_dir" DOCKER_BUILD_RETRY_DELAY_SECONDS=0 \
      bash "$PROJECT_ROOT/build_docker_images.sh" 03122026-deadbeef \
        --images agent-vm --source-revision "$revision" >/dev/null 2>&1; then
      fail "deterministic Docker failures should fail the build"
    fi
    [ "$(cat "$FAKE_BUILD_COUNT")" = "1" ] || fail "deterministic Docker failures should not be retried"

    rm -rf "$tmp_dir"
  )
}

test_build_docker_images_does_not_retry_deterministic_or_auth_failures_with_network_text() {
  local scenario

  for scenario in \
    compile_after_network_warning \
    compile_after_cargo_http2_failure \
    cargo_lock_failure \
    cargo_checksum_failure \
    authentication_failure; do
    (
      local tmp_dir fake_bin revision
      tmp_dir="$(mktemp -d)"
      fake_bin="$tmp_dir/bin"
      revision="deadbeefcafefeeddeadbeefcafefeeddeadbeef"
      mkdir -p "$fake_bin"
      make_fake_release_docker_cli "$fake_bin/docker"

      export FAKE_DOCKER_LOG="$tmp_dir/docker.log"
      export FAKE_BUILD_COUNT="$tmp_dir/build-count"
      export FAKE_BUILDER_CREATED="$tmp_dir/builder-created"
      export FAKE_BUILDER_NAME="portico-multiarch-v030"
      export FAKE_DOCKER_SCENARIO="$scenario"

      cd "$PROJECT_ROOT"
      if PATH="$fake_bin:$PATH" TMPDIR="$tmp_dir" DOCKER_BUILD_RETRY_DELAY_SECONDS=0 \
        bash "$PROJECT_ROOT/build_docker_images.sh" 03122026-deadbeef \
          --images agent-vm --source-revision "$revision" >/dev/null 2>&1; then
        fail "$scenario should fail the build"
      fi
      [ "$(cat "$FAKE_BUILD_COUNT")" = "1" ] \
        || fail "$scenario should not be retried despite containing network-like text"

      rm -rf "$tmp_dir"
    )
  done
}

test_build_docker_images_honors_attempt_override_for_cargo_http2_exhaustion() {
  (
    local tmp_dir fake_bin revision
    tmp_dir="$(mktemp -d)"
    fake_bin="$tmp_dir/bin"
    revision="deadbeefcafefeeddeadbeefcafefeeddeadbeef"
    mkdir -p "$fake_bin"
    make_fake_release_docker_cli "$fake_bin/docker"

    export FAKE_DOCKER_LOG="$tmp_dir/docker.log"
    export FAKE_BUILD_COUNT="$tmp_dir/build-count"
    export FAKE_BUILDER_CREATED="$tmp_dir/builder-created"
    export FAKE_BUILDER_NAME="portico-multiarch-v030"
    export FAKE_DOCKER_SCENARIO="cargo_http2_failure"

    cd "$PROJECT_ROOT"
    if PATH="$fake_bin:$PATH" TMPDIR="$tmp_dir" \
      DOCKER_BUILD_MAX_ATTEMPTS=3 DOCKER_BUILD_RETRY_DELAY_SECONDS=0 \
      bash "$PROJECT_ROOT/build_docker_images.sh" 03122026-deadbeef \
        --images mcp-orc-rust --source-revision "$revision" >/dev/null 2>&1; then
      fail "exhausted Cargo HTTP/2 retries should fail the build"
    fi
    [ "$(cat "$FAKE_BUILD_COUNT")" = "3" ] \
      || fail "Cargo HTTP/2 retry exhaustion should honor DOCKER_BUILD_MAX_ATTEMPTS"
    [ "$(find "$tmp_dir" -type f -name 'mcp-orc-rust.log.attempt-*' | wc -l | tr -d ' ')" = "3" ] \
      || fail "Cargo HTTP/2 retry exhaustion should preserve every attempt log"

    rm -rf "$tmp_dir"
  )
}

test_build_docker_images_fails_after_network_retry_exhaustion() {
  (
    local tmp_dir fake_bin revision
    tmp_dir="$(mktemp -d)"
    fake_bin="$tmp_dir/bin"
    revision="deadbeefcafefeeddeadbeefcafefeeddeadbeef"
    mkdir -p "$fake_bin"
    make_fake_release_docker_cli "$fake_bin/docker"

    export FAKE_DOCKER_LOG="$tmp_dir/docker.log"
    export FAKE_BUILD_COUNT="$tmp_dir/build-count"
    export FAKE_BUILDER_CREATED="$tmp_dir/builder-created"
    export FAKE_BUILDER_NAME="portico-multiarch-v030"
    export FAKE_DOCKER_SCENARIO="network_failure"

    cd "$PROJECT_ROOT"
    if PATH="$fake_bin:$PATH" TMPDIR="$tmp_dir" DOCKER_BUILD_RETRY_DELAY_SECONDS=0 \
      bash "$PROJECT_ROOT/build_docker_images.sh" 03122026-deadbeef \
        --images agent-vm --source-revision "$revision" >/dev/null 2>&1; then
      fail "exhausted Docker network retries should fail the build"
    fi
    [ "$(cat "$FAKE_BUILD_COUNT")" = "2" ] || fail "network retry exhaustion should honor the default attempt limit"
    [ "$(find "$tmp_dir" -type f -name 'agent-vm.log.attempt-*' | wc -l | tr -d ' ')" = "2" ] \
      || fail "exhausted network retries should preserve every attempt log"

    rm -rf "$tmp_dir"
  )
}

test_build_docker_images_rejects_unknown_selection() {
  local revision="deadbeefcafefeeddeadbeefcafefeeddeadbeef"

  if bash "$PROJECT_ROOT/build_docker_images.sh" 03122026-deadbeef \
    --images not-a-release-image --source-revision "$revision" >/dev/null 2>&1; then
    fail "unknown selective Docker image names should fail before building"
  fi
}

test_stage_source_tree_keeps_runtime_base_files() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir
    tmp_dir="$(mktemp -d)"
    MANAGED_ROOT_SOURCE="$tmp_dir/source"
    SOURCE_STAGE_DIR="$tmp_dir/staged-source"

    mkdir -p \
      "$MANAGED_ROOT_SOURCE/electron-app/src/renderer/dist" \
      "$MANAGED_ROOT_SOURCE/marketplaces-ootb/skills-marketplace/test-market/test-skill"
    : > "$MANAGED_ROOT_SOURCE/docker-compose.yml"
    : > "$MANAGED_ROOT_SOURCE/model_catalog.yaml"
    : > "$MANAGED_ROOT_SOURCE/electron-app/src/renderer/dist/guided-setup.bundle.js"
    : > "$MANAGED_ROOT_SOURCE/release"
    printf '{"marketplaces":[{"id":"test-market"}]}\n' \
      > "$MANAGED_ROOT_SOURCE/marketplaces-ootb/marketplaces.json"
    printf '# Test Skill\n' \
      > "$MANAGED_ROOT_SOURCE/marketplaces-ootb/skills-marketplace/test-market/test-skill/SKILL.md"
    : > "$MANAGED_ROOT_SOURCE/marketplaces-ootb/skills-marketplace/.DS_Store"

    stage_source_tree

    [ -f "$SOURCE_STAGE_DIR/docker-compose.yml" ] || fail "stage_source_tree should keep docker-compose.yml"
    [ -f "$SOURCE_STAGE_DIR/model_catalog.yaml" ] || fail "stage_source_tree should keep model_catalog.yaml"
    [ -f "$SOURCE_STAGE_DIR/marketplaces-ootb/marketplaces.json" ] \
      || fail "stage_source_tree should keep the checked-in OOTB marketplace config"
    [ -f "$SOURCE_STAGE_DIR/marketplaces-ootb/skills-marketplace/test-market/test-skill/SKILL.md" ] \
      || fail "stage_source_tree should keep checked-in OOTB marketplace skills"
    [ ! -e "$SOURCE_STAGE_DIR/marketplaces-ootb/skills-marketplace/.DS_Store" ] \
      || fail "stage_source_tree should exclude OOTB macOS metadata"
    [ ! -e "$SOURCE_STAGE_DIR/electron-app/src/renderer/dist/guided-setup.bundle.js" ] || fail "stage_source_tree should still exclude renderer dist"
    [ ! -e "$SOURCE_STAGE_DIR/release" ] || fail "stage_source_tree should still exclude release artifacts"

    rm -rf "$tmp_dir"
  )
}

test_stage_managed_root_curates_runtime_payload() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir
    tmp_dir="$(mktemp -d)"
    SOURCE_STAGE_DIR="$tmp_dir/source"
    PAYLOAD_STAGE_DIR="$tmp_dir/payload"

    mkdir -p "$SOURCE_STAGE_DIR"/{agents,docker,electron-app,mcp-configs,skills,skills-marketplace,src,docs,plans,tests,spikes,mcpo-configs-generated}
    mkdir -p \
      "$SOURCE_STAGE_DIR/electron-app/tests" \
      "$SOURCE_STAGE_DIR/electron-app/.swarm" \
      "$SOURCE_STAGE_DIR/electron-app/.atlas-flow" \
      "$SOURCE_STAGE_DIR/electron-app/scripts" \
      "$SOURCE_STAGE_DIR/electron-app/build-resources" \
      "$SOURCE_STAGE_DIR/marketplaces-ootb/skills-marketplace/test-market/test-skill" \
      "$SOURCE_STAGE_DIR/skills-marketplace/live-market/live-skill"

    : > "$SOURCE_STAGE_DIR/bootstrap.sh"
    printf '%s\n' \
      'CLOUDSMITH_ENTITLEMENT_TOKEN="unsafe-source-token"' \
      'CLOUDSMITH_API_KEY="must-not-ship"' \
      > "$SOURCE_STAGE_DIR/cloudsmith.env"
    cp "$PROJECT_ROOT/electron-app/scripts/prepare-cloudsmith-resource.js" \
      "$SOURCE_STAGE_DIR/electron-app/scripts/prepare-cloudsmith-resource.js"
    printf '%s\n' \
      'CLOUDSMITH_OWNER="portico"' \
      'CLOUDSMITH_REPO="portico"' \
      'CLOUDSMITH_API_BASE="https://api.cloudsmith.io/v1"' \
      'CLOUDSMITH_DL_BASE="https://dl.artifacts.example.invalid"' \
      'CLOUDSMITH_ENTITLEMENT_TOKEN="test-read-token"' \
      'CLOUDSMITH_API_KEY="test-api-key"' \
      > "$SOURCE_STAGE_DIR/electron-app/build-resources/cloudsmith.env"
    : > "$SOURCE_STAGE_DIR/Dockerfile.bifrost-bridge"
    : > "$SOURCE_STAGE_DIR/docker-compose.advanced.yml"
    : > "$SOURCE_STAGE_DIR/docker-compose.harbor.yml"
    : > "$SOURCE_STAGE_DIR/docker-compose.override.yml"
    : > "$SOURCE_STAGE_DIR/docker-compose.yml"
    : > "$SOURCE_STAGE_DIR/install_v2.sh"
    : > "$SOURCE_STAGE_DIR/model_catalog.yaml"
    : > "$SOURCE_STAGE_DIR/mcp-container-groups.json"
    : > "$SOURCE_STAGE_DIR/system-env-presets.yaml"
    printf '{"marketplaces":[{"id":"live-builder-state"}]}\n' > "$SOURCE_STAGE_DIR/marketplaces.json"
    printf 'live builder skill\n' > "$SOURCE_STAGE_DIR/skills-marketplace/live-market/live-skill/SKILL.md"
    printf '{"marketplaces":[{"id":"test-market"}],"installedSkills":[{"marketplaceId":"test-market","skillId":"test-skill","localPath":"skills-marketplace/test-market/test-skill"}]}\n' \
      > "$SOURCE_STAGE_DIR/marketplaces-ootb/marketplaces.json"
    printf 'checked-in ootb skill\n' \
      > "$SOURCE_STAGE_DIR/marketplaces-ootb/skills-marketplace/test-market/test-skill/SKILL.md"

    : > "$SOURCE_STAGE_DIR/UPDATE_CHANNEL"
    : > "$SOURCE_STAGE_DIR/HOST_MODE"
    : > "$SOURCE_STAGE_DIR/mcp_config_advanced.json.tmp.abc123"
    : > "$SOURCE_STAGE_DIR/.mcp-config-hash"
    : > "$SOURCE_STAGE_DIR/.startup-hash.json"
    : > "$SOURCE_STAGE_DIR/Dockerfile.mcp-orc-rust"
    : > "$SOURCE_STAGE_DIR/release_build.sh"
    : > "$SOURCE_STAGE_DIR/package_for_release.sh"
    : > "$SOURCE_STAGE_DIR/docs/ignore.md"
    : > "$SOURCE_STAGE_DIR/plans/ignore.md"
    : > "$SOURCE_STAGE_DIR/tests/ignore.sh"
    : > "$SOURCE_STAGE_DIR/spikes/ignore.md"
    : > "$SOURCE_STAGE_DIR/mcpo-configs-generated/generated.json"
    : > "$SOURCE_STAGE_DIR/electron-app/tests/ignore.test.js"
    : > "$SOURCE_STAGE_DIR/electron-app/.swarm/ignore.db"
    : > "$SOURCE_STAGE_DIR/electron-app/.atlas-flow/ignore.json"
    : > "$SOURCE_STAGE_DIR/electron-app/playwright.config.js"
    : > "$SOURCE_STAGE_DIR/electron-app/README.md"
    : > "$SOURCE_STAGE_DIR/electron-app/Dockerfile.electron-build"
    : > "$SOURCE_STAGE_DIR/electron-app/docker-compose.dev.yml"
    : > "$SOURCE_STAGE_DIR/electron-app/docker-compose.build.yml"
    : > "$SOURCE_STAGE_DIR/electron-app/scripts/notarize.js"
    printf '%s\n' \
      'registry=https://npm.artifacts.example.invalid/harbor/' \
      '//npm.artifacts.example.invalid/harbor/:_authToken=packaged-test-token' \
      > "$SOURCE_STAGE_DIR/electron-app/.npmrc"
    printf '%s\n' \
      'registry=https://npm.artifacts.example.invalid/harbor/' \
      '//npm.artifacts.example.invalid/harbor/:_authToken=root-test-token' \
      > "$SOURCE_STAGE_DIR/.npmrc"

    stage_managed_root

    [ -f "$PAYLOAD_STAGE_DIR/managed-root/cloudsmith.env" ] || fail "cloudsmith.env should remain bundled"
    grep -q 'CLOUDSMITH_ENTITLEMENT_TOKEN="test-read-token"' "$PAYLOAD_STAGE_DIR/managed-root/cloudsmith.env" \
      || fail "managed-root should use the packaged Cloudsmith resource"
    grep -q 'CLOUDSMITH_API_KEY="test-api-key"' "$PAYLOAD_STAGE_DIR/managed-root/cloudsmith.env" \
      || fail "managed-root should preserve the packaged updater API key"
    if grep -q 'CLOUDSMITH_API_KEY="must-not-ship"' "$PAYLOAD_STAGE_DIR/managed-root/cloudsmith.env"; then
      fail "managed-root copied the unprepared source API key"
    fi
    [ -f "$PAYLOAD_STAGE_DIR/managed-root/Dockerfile.bifrost-bridge" ] || fail "Dockerfile.bifrost-bridge should be staged for packaged llm-gateway builds"
    [ -d "$PAYLOAD_STAGE_DIR/managed-root/electron-app" ] || fail "electron-app should remain bundled"
    [ -f "$PAYLOAD_STAGE_DIR/managed-root/electron-app/.npmrc" ] || fail "packaged npm config should remain bundled under electron-app"
    grep -q 'packaged-test-token' "$PAYLOAD_STAGE_DIR/managed-root/electron-app/.npmrc" \
      || fail "managed-root should preserve the packaged npm config"
    [ ! -e "$PAYLOAD_STAGE_DIR/managed-root/.npmrc" ] || fail "managed-root must not duplicate the packaged npm credentials at its root"
    [ -f "$PAYLOAD_STAGE_DIR/managed-root/marketplaces-ootb.json" ] || fail "marketplaces-ootb.json should be staged"
    [ -d "$PAYLOAD_STAGE_DIR/managed-root/skills-marketplace-ootb" ] || fail "skills-marketplace-ootb should be staged"
    cmp -s \
      "$SOURCE_STAGE_DIR/marketplaces-ootb/marketplaces.json" \
      "$PAYLOAD_STAGE_DIR/managed-root/marketplaces-ootb.json" \
      || fail "managed-root should use the checked-in OOTB marketplace config"
    grep -q '^checked-in ootb skill$' \
      "$PAYLOAD_STAGE_DIR/managed-root/skills-marketplace-ootb/test-market/test-skill/SKILL.md" \
      || fail "managed-root should use the checked-in OOTB marketplace skill"
    [ ! -e "$PAYLOAD_STAGE_DIR/managed-root/skills-marketplace-ootb/live-market" ] \
      || fail "managed-root copied live builder marketplace skills"
    [ ! -e "$PAYLOAD_STAGE_DIR/managed-root/docker-compose.harbor.yml" ] || fail "generated Harbor compose should not be staged"
    [ ! -e "$PAYLOAD_STAGE_DIR/managed-root/docker-compose.override.yml" ] || fail "generated compose override should not be staged"

    [ ! -e "$PAYLOAD_STAGE_DIR/managed-root/marketplaces.json" ] || fail "live marketplaces.json should not be staged"
    [ ! -e "$PAYLOAD_STAGE_DIR/managed-root/skills-marketplace" ] || fail "live skills-marketplace should not be staged"
    [ ! -e "$PAYLOAD_STAGE_DIR/managed-root/UPDATE_CHANNEL" ] || fail "UPDATE_CHANNEL should not be staged"
    [ ! -e "$PAYLOAD_STAGE_DIR/managed-root/HOST_MODE" ] || fail "HOST_MODE should not be staged"
    [ ! -e "$PAYLOAD_STAGE_DIR/managed-root/mcp_config_advanced.json.tmp.abc123" ] || fail "tmp MCP config should not be staged"
    [ ! -e "$PAYLOAD_STAGE_DIR/managed-root/.mcp-config-hash" ] || fail ".mcp-config-hash should not be staged"
    [ ! -e "$PAYLOAD_STAGE_DIR/managed-root/.startup-hash.json" ] || fail ".startup-hash.json should not be staged"
    [ ! -e "$PAYLOAD_STAGE_DIR/managed-root/Dockerfile.mcp-orc-rust" ] || fail "Dockerfiles should not be staged"
    [ ! -e "$PAYLOAD_STAGE_DIR/managed-root/release_build.sh" ] || fail "release_build.sh should not be staged"
    [ ! -e "$PAYLOAD_STAGE_DIR/managed-root/package_for_release.sh" ] || fail "package_for_release.sh should not be staged"
    [ ! -e "$PAYLOAD_STAGE_DIR/managed-root/docs" ] || fail "docs should not be staged"
    [ ! -e "$PAYLOAD_STAGE_DIR/managed-root/plans" ] || fail "plans should not be staged"
    [ ! -e "$PAYLOAD_STAGE_DIR/managed-root/tests" ] || fail "tests should not be staged"
    [ ! -e "$PAYLOAD_STAGE_DIR/managed-root/spikes" ] || fail "spikes should not be staged"
    [ ! -e "$PAYLOAD_STAGE_DIR/managed-root/mcpo-configs-generated" ] || fail "generated configs should not be staged"
    [ ! -e "$PAYLOAD_STAGE_DIR/managed-root/electron-app/tests" ] || fail "electron-app tests should not be staged"
    [ ! -e "$PAYLOAD_STAGE_DIR/managed-root/electron-app/.swarm" ] || fail "electron-app .swarm should not be staged"
    [ ! -e "$PAYLOAD_STAGE_DIR/managed-root/electron-app/.atlas-flow" ] || fail "electron-app .atlas-flow should not be staged"
    [ ! -e "$PAYLOAD_STAGE_DIR/managed-root/electron-app/playwright.config.js" ] || fail "electron-app playwright config should not be staged"
    [ ! -e "$PAYLOAD_STAGE_DIR/managed-root/electron-app/README.md" ] || fail "electron-app README should not be staged"
    [ ! -e "$PAYLOAD_STAGE_DIR/managed-root/electron-app/Dockerfile.electron-build" ] || fail "electron-app Dockerfile should not be staged"
    [ ! -e "$PAYLOAD_STAGE_DIR/managed-root/electron-app/docker-compose.dev.yml" ] || fail "electron-app dev compose should not be staged"
    [ ! -e "$PAYLOAD_STAGE_DIR/managed-root/electron-app/docker-compose.build.yml" ] || fail "electron-app build compose should not be staged"
    [ ! -e "$PAYLOAD_STAGE_DIR/managed-root/electron-app/scripts/notarize.js" ] || fail "electron-app notarize script should not be staged"

    rm -rf "$tmp_dir"
  )
}

test_stage_managed_root_requires_checked_in_ootb_sources() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir output status
    tmp_dir="$(mktemp -d)"
    SOURCE_STAGE_DIR="$tmp_dir/source"
    PAYLOAD_STAGE_DIR="$tmp_dir/payload"
    make_minimal_stage_managed_root_source "$SOURCE_STAGE_DIR"

    set +e
    output="$(PACKAGE_FOR_RELEASE_PLAIN_ERRORS=true stage_managed_root 2>&1)"
    status=$?
    set -e
    [ "$status" -ne 0 ] || fail "stage_managed_root should reject a missing OOTB config"
    printf '%s\n' "$output" | grep -q 'Checked-in OOTB marketplace config is missing' \
      || fail "missing OOTB config failure was not explained"

    mkdir -p "$SOURCE_STAGE_DIR/marketplaces-ootb"
    printf '{"marketplaces":[],"installedSkills":[]}\n' \
      > "$SOURCE_STAGE_DIR/marketplaces-ootb/marketplaces.json"
    set +e
    output="$(PACKAGE_FOR_RELEASE_PLAIN_ERRORS=true stage_managed_root 2>&1)"
    status=$?
    set -e
    [ "$status" -ne 0 ] || fail "stage_managed_root should reject missing OOTB skills"
    printf '%s\n' "$output" | grep -q 'Checked-in OOTB marketplace skills are missing' \
      || fail "missing OOTB skills failure was not explained"

    rm -rf "$tmp_dir"
  )
}

test_stage_managed_root_excludes_generated_rust_target_outputs() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir generated_file
    tmp_dir="$(mktemp -d)"
    SOURCE_STAGE_DIR="$tmp_dir/source"
    PAYLOAD_STAGE_DIR="$tmp_dir/payload"
    generated_file="$SOURCE_STAGE_DIR/src/mcp-orc-rust/target/x86_64-apple-darwin/release/build/example/out/private.rs"

    mkdir -p \
      "$(dirname "$generated_file")" \
      "$SOURCE_STAGE_DIR/src/scripts" \
      "$SOURCE_STAGE_DIR/marketplaces-ootb/skills-marketplace/test-market/test-skill"

    : > "$generated_file"
    printf '#!/usr/bin/env bash\nexit 0\n' > "$SOURCE_STAGE_DIR/src/scripts/keep.sh"
    make_minimal_stage_managed_root_source "$SOURCE_STAGE_DIR"
    printf '{"marketplaces":[{"id":"test-market"}],"installedSkills":[{"marketplaceId":"test-market","skillId":"test-skill","localPath":"skills-marketplace/test-market/test-skill"}]}\n' \
      > "$SOURCE_STAGE_DIR/marketplaces-ootb/marketplaces.json"
    printf '# Test Skill\n' \
      > "$SOURCE_STAGE_DIR/marketplaces-ootb/skills-marketplace/test-market/test-skill/SKILL.md"

    stage_managed_root

    [ -f "$PAYLOAD_STAGE_DIR/managed-root/src/scripts/keep.sh" ] || fail "regular src content should remain bundled"
    [ ! -e "$PAYLOAD_STAGE_DIR/managed-root/src/mcp-orc-rust/target" ] || fail "generated Rust target outputs should not be staged"

    rm -rf "$tmp_dir"
  )
}

make_package_runner_fixture() {
  local fixture_root="$1"

  mkdir -p "$fixture_root/src/scripts"
  cp "$PACKAGE_SCRIPT" "$fixture_root/package_for_release.sh"
  cp "$PROJECT_ROOT/src/scripts/host-mcp-binary-policy.sh" "$fixture_root/src/scripts/host-mcp-binary-policy.sh"
  cp "$PROJECT_ROOT/src/scripts/runtime-secrets.sh" "$fixture_root/src/scripts/runtime-secrets.sh"
  cp "$PROJECT_ROOT/src/scripts/release-channel.sh" "$fixture_root/src/scripts/release-channel.sh"
  chmod +x "$fixture_root/package_for_release.sh"
}

wait_for_file_content() {
  local file_path="$1"
  local expected="$2"
  local attempt

  for attempt in {1..200}; do
    if [ -f "$file_path" ] && [ "$(cat "$file_path")" = "$expected" ]; then
      return 0
    fi
    sleep 0.05
  done
  fail "timed out waiting for $file_path to contain $expected"
}

test_immutable_runner_survives_original_script_replacement_and_cleans_marked_dir() {
  (
    local tmp_dir fixture runner_root ready_file continue_file output_file error_file pid status
    tmp_dir="$(mktemp -d)"
    fixture="$tmp_dir/fixture"
    runner_root="$tmp_dir/runners"
    ready_file="$tmp_dir/runner-ready"
    continue_file="$tmp_dir/runner-continue"
    output_file="$tmp_dir/output.log"
    error_file="$tmp_dir/error.log"
    mkdir -p "$runner_root/portico-package-runner.unmarked"
    make_package_runner_fixture "$fixture"

    TMPDIR="$runner_root" \
    PACKAGE_FOR_RELEASE_TEST_RUNNER_READY_FILE="$ready_file" \
    PACKAGE_FOR_RELEASE_TEST_RUNNER_CONTINUE_FILE="$continue_file" \
      bash "$fixture/package_for_release.sh" --help >"$output_file" 2>"$error_file" &
    pid=$!

    wait_for_file_content "$ready_file" ""
    printf '\n)\n' >> "$fixture/package_for_release.sh"
    : > "$continue_file"

    set +e
    wait "$pid"
    status=$?
    set -e

    [ "$status" -eq 0 ] || fail "immutable runner failed after the original script was enlarged: $(cat "$error_file")"
    grep -q '^Usage: ./package_for_release.sh' "$output_file" \
      || fail "immutable runner did not execute the verified snapshot"
    ! grep -q 'syntax error' "$error_file" \
      || fail "immutable runner parsed trailing content from the modified original"
    [ -d "$runner_root/portico-package-runner.unmarked" ] \
      || fail "runner cleanup removed an unmarked directory"
    [ "$(find "$runner_root" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" -eq 1 ] \
      || fail "marked immutable runner directory was not cleaned"

    rm -rf "$tmp_dir"
  )
}

test_immutable_runner_retries_unstable_copy_and_rejects_invalid_snapshot() {
  (
    local tmp_dir fixture runner_root ready_file continue_base output_file error_file pid status
    tmp_dir="$(mktemp -d)"
    fixture="$tmp_dir/fixture"
    runner_root="$tmp_dir/runners"
    ready_file="$tmp_dir/copy-ready"
    continue_base="$tmp_dir/copy-continue"
    output_file="$tmp_dir/output.log"
    error_file="$tmp_dir/error.log"
    mkdir -p "$runner_root"
    make_package_runner_fixture "$fixture"

    TMPDIR="$runner_root" \
    PACKAGE_FOR_RELEASE_TEST_SNAPSHOT_READY_FILE="$ready_file" \
    PACKAGE_FOR_RELEASE_TEST_SNAPSHOT_CONTINUE_FILE="$continue_base" \
      bash "$fixture/package_for_release.sh" --help >"$output_file" 2>"$error_file" &
    pid=$!

    wait_for_file_content "$ready_file" "1"
    printf '\n# changed during first snapshot copy\n' >> "$fixture/package_for_release.sh"
    : > "${continue_base}.1"
    wait_for_file_content "$ready_file" "2"
    : > "${continue_base}.2"

    wait "$pid" || fail "immutable runner did not recover from a single unstable copy"
    grep -q 'changed while its immutable runner was being copied' "$error_file" \
      || fail "unstable snapshot retry was not reported"

    rm -rf "$fixture"
    rm -f "$ready_file" "${continue_base}.1" "${continue_base}.2"
    make_package_runner_fixture "$fixture"
    TMPDIR="$runner_root" \
    PACKAGE_FOR_RELEASE_TEST_SNAPSHOT_READY_FILE="$ready_file" \
    PACKAGE_FOR_RELEASE_TEST_SNAPSHOT_CONTINUE_FILE="$continue_base" \
      bash "$fixture/package_for_release.sh" --help >"$output_file" 2>"$error_file" &
    pid=$!

    wait_for_file_content "$ready_file" "1"
    printf '\n# first unstable copy\n' >> "$fixture/package_for_release.sh"
    : > "${continue_base}.1"
    wait_for_file_content "$ready_file" "2"
    printf '\n# second unstable copy\n' >> "$fixture/package_for_release.sh"
    : > "${continue_base}.2"
    set +e
    wait "$pid"
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "runner should fail when both snapshot attempts are unstable"
    grep -q 'remained unstable while creating its immutable runner' "$error_file" \
      || fail "snapshot retry exhaustion was not explained"

    rm -rf "$fixture"
    make_package_runner_fixture "$fixture"
    printf '\n)\n' >> "$fixture/package_for_release.sh"
    set +e
    TMPDIR="$runner_root" bash "$fixture/package_for_release.sh" --help >"$output_file" 2>"$error_file"
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "syntax-invalid immutable snapshot should fail closed"
    grep -q 'failed Bash syntax validation' "$error_file" \
      || fail "syntax-invalid snapshot failure was not explained"
    [ -z "$(find "$runner_root" -mindepth 1 -maxdepth 1 -type d -name 'portico-package-runner.*' -print -quit)" ] \
      || fail "failed immutable runner left a marked temp directory"

    rm -rf "$tmp_dir"
  )
}

test_stage_source_tree_rejects_source_changes_during_copy() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir source_root call_count output status
    tmp_dir="$(mktemp -d)"
    source_root="$tmp_dir/source"
    call_count="$tmp_dir/rsync-count"
    mkdir -p "$source_root/electron-app" "$tmp_dir/staging-root"
    printf '%s\n' 'original' > "$source_root/runtime.txt"
    git -C "$source_root" init -q
    git -C "$source_root" config user.name "Package Test"
    git -C "$source_root" config user.email "package-test@example.com"
    git -C "$source_root" add .
    git -C "$source_root" commit -q -m initial

    MANAGED_ROOT_SOURCE="$source_root"
    TMPDIR="$tmp_dir/staging-root"
    KEEP_TEMP_ON_FAILURE=false
    printf '0\n' > "$call_count"
    rsync() {
      local count
      count="$(cat "$call_count")"
      count=$((count + 1))
      printf '%s\n' "$count" > "$call_count"
      command rsync "$@"
      if [ "$count" -eq 1 ]; then
        printf '%s\n' 'changed during copy' >> "$source_root/runtime.txt"
      fi
    }

    set +e
    output="$(stage_source_tree 2>&1)"
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "source mutation during staging should fail closed"
    printf '%s' "$output" | grep -Eq 'source changed|checkout changed' \
      || fail "source mutation failure did not explain staging instability"

    rm -rf "$tmp_dir"
  )
}

test_stage_source_tree_ignores_report_build_churn() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir source_root call_count state_before state_after
    tmp_dir="$(mktemp -d)"
    source_root="$tmp_dir/source"
    call_count="$tmp_dir/rsync-count"
    mkdir -p "$source_root/.report-build/findings" "$tmp_dir/staging-root"
    printf '%s\n' 'runtime source' > "$source_root/runtime.txt"
    printf '%s\n' 'initial report' > "$source_root/.report-build/findings/live.json"
    git -C "$source_root" init -q
    git -C "$source_root" config user.name "Package Test"
    git -C "$source_root" config user.email "package-test@example.com"
    git -C "$source_root" add runtime.txt
    git -C "$source_root" commit -q -m initial

    MANAGED_ROOT_SOURCE="$source_root"
    FULL_SHA="$(git -C "$source_root" rev-parse HEAD)"
    TMPDIR="$tmp_dir/staging-root"
    KEEP_TEMP_ON_FAILURE=false

    release_source_tree_is_clean \
      || fail ".report-build alone should not disable package artifact reuse"
    state_before="$(capture_source_checkout_state "$source_root")"
    printf '%s\n' 'updated report' > "$source_root/.report-build/findings/live.json"
    state_after="$(capture_source_checkout_state "$source_root")"
    [ "$state_before" = "$state_after" ] \
      || fail ".report-build changes should not alter the checkout snapshot fingerprint"

    printf '0\n' > "$call_count"
    rsync() {
      local count
      count="$(cat "$call_count")"
      count=$((count + 1))
      printf '%s\n' "$count" > "$call_count"
      command rsync "$@"
      if [ "$count" -eq 1 ]; then
        printf '%s\n' 'changed during copy' > "$source_root/.report-build/findings/live.json"
      fi
    }

    stage_source_tree

    [ ! -e "$SOURCE_STAGE_DIR/.report-build" ] \
      || fail ".report-build should not be included in the staged release source"
    printf '%s\n' 'tracked mutation' >> "$source_root/runtime.txt"
    ! release_source_tree_is_clean \
      || fail "real tracked source changes must still disable artifact reuse"

    rm -rf "$tmp_dir"
  )
}

test_checkout_change_after_staging_warns_without_invalidating_snapshot() {
  (
    source "$PACKAGE_SCRIPT"

    local output
    SOURCE_CHECKOUT_IS_GIT=true
    SOURCE_CHECKOUT_STATE_AFTER_STAGING="old-state"
    MANAGED_ROOT_SOURCE="/unused"
    FULL_SHA="deadbeefcafefeeddeadbeefcafefeeddeadbeef"
    capture_source_checkout_state() { printf '%s\n' 'new-state'; }

    output="$(report_checkout_changes_after_staging 2>&1)"
    printf '%s' "$output" | grep -q 'payload remains pinned to the staged source snapshot' \
      || fail "post-staging checkout change did not report immutable payload behavior"
  )
}

test_create_payload_zip_is_atomic_and_preserves_existing_final_on_failure() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir status output ditto_log
    tmp_dir="$(mktemp -d)"
    ditto_log="$tmp_dir/ditto.log"
    PAYLOAD_STAGE_DIR="$tmp_dir/payload"
    OUTPUT_ZIP="$tmp_dir/portico_dev-03122026-deadbeef.zip"
    MACOS_DITTO_BIN="$tmp_dir/ditto"
    mkdir -p \
      "$PAYLOAD_STAGE_DIR/managed-root" \
      "$PAYLOAD_STAGE_DIR/artifacts" \
      "$PAYLOAD_STAGE_DIR/host-mcp-binaries"
    printf '{}\n' > "$PAYLOAD_STAGE_DIR/release-manifest.json"
    printf '%s\n' 'old-valid-payload' > "$OUTPUT_ZIP"
    cat > "$MACOS_DITTO_BIN" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${FAKE_DITTO_LOG:?}"
source_dir="${@: -2:1}"
output_zip="${@: -1}"
(
  cd "$source_dir"
  zip -qry --symlinks "$output_zip" .
)
SH
    chmod +x "$MACOS_DITTO_BIN"
    export FAKE_DITTO_LOG="$ditto_log"
    require_packaging_disk_space() { :; }
    validate_release_payload_path() { return 19; }

    set +e
    output="$(create_payload_zip 2>&1)"
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "invalid partial payload should fail ZIP creation"
    [ "$(cat "$OUTPUT_ZIP")" = "old-valid-payload" ] \
      || fail "failed partial validation replaced the existing final payload"
    [ -z "$(find "$tmp_dir" -maxdepth 1 -name '*.partial.*' -print -quit)" ] \
      || fail "failed partial payload was not removed"
    printf '%s' "$output" | grep -q 'existing final payload was not replaced' \
      || fail "atomic payload failure did not describe preservation behavior"

    validate_release_payload_path() {
      [ -f "$1" ] || fail "validator did not receive the partial ZIP"
      [ "$2" = true ] || fail "archive validation did not re-check macOS signatures"
      [ "$3" = "$(basename "$OUTPUT_ZIP")" ] || fail "partial ZIP validation lost logical filename identity"
    }
    create_payload_zip >/dev/null

    [ "$PAYLOAD_CREATED" = true ] || fail "successful atomic ZIP publication did not mark payload completion"
    unzip -tq "$OUTPUT_ZIP" >/dev/null || fail "published atomic ZIP is corrupt"
    grep -q -- '-c -k --sequesterRsrc' "$ditto_log" \
      || fail "release archive was not created with Apple metadata preservation"
    [ -z "$(find "$tmp_dir" -maxdepth 1 -name '*.partial.*' -print -quit)" ] \
      || fail "successful atomic ZIP publication left a partial file"

    rm -rf "$tmp_dir"
  )
}

test_create_payload_zip_preserves_extended_attributes_on_macos() {
  [ "$(uname -s)" = "Darwin" ] || return 0

  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir extracted attribute_value
    tmp_dir="$(mktemp -d)"
    PAYLOAD_STAGE_DIR="$tmp_dir/payload"
    OUTPUT_ZIP="$tmp_dir/portico_dev-03122026-deadbeef.zip"
    mkdir -p \
      "$PAYLOAD_STAGE_DIR/managed-root" \
      "$PAYLOAD_STAGE_DIR/artifacts" \
      "$PAYLOAD_STAGE_DIR/host-mcp-binaries"
    printf '{}\n' > "$PAYLOAD_STAGE_DIR/release-manifest.json"
    printf '%s\n' 'signed metadata fixture' > "$PAYLOAD_STAGE_DIR/artifacts/metadata-fixture"
    xattr -w com.portico.ai-chat.release-test preserved \
      "$PAYLOAD_STAGE_DIR/artifacts/metadata-fixture"

    require_packaging_disk_space() { :; }
    validate_release_payload_path() {
      [ "$2" = true ] || fail "archive metadata fixture skipped macOS verification"
    }

    create_payload_zip >/dev/null
    extracted="$tmp_dir/extracted"
    mkdir -p "$extracted"
    /usr/bin/ditto -x -k "$OUTPUT_ZIP" "$extracted"
    attribute_value="$(xattr -p com.portico.ai-chat.release-test \
      "$extracted/artifacts/metadata-fixture")"
    [ "$attribute_value" = preserved ] \
      || fail "Apple-preserving release ZIP lost extended attributes"

    rm -rf "$tmp_dir"
  )
}

test_release_summary_prints_each_docker_image_on_its_own_line() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir output
    tmp_dir="$(mktemp -d)"
    PAYLOAD_STAGE_DIR="$tmp_dir/payload"
    OUTPUT_ZIP="$tmp_dir/payload.zip"
    DMG_ARM64="$tmp_dir/arm64.dmg"
    DMG_X64="$tmp_dir/x64.dmg"
    DOCKER_IMAGE_TAG="03122026-deadbeef"
    BUILD_ID="03122026-deadbeef"
    FULL_SHA="deadbeefcafefeeddeadbeefcafefeeddeadbeef"
    CHANNEL="dev"
    CHANNEL_PACKAGE_NAME="portico_dev"
    BUILD_STARTED_AT_EPOCH="$(date +%s)"
    path_size_bytes() { printf '%s\n' '1'; }
    path_size_human() { printf '%s\n' '1 B'; }
    release_image_names() { printf '%s\n' 'first second'; }
    get_multiarch_image_size_report() { printf '3\namd64:1\narm64:2\n'; }

    output="$(print_release_summary)"
    [ "$(printf '%s\n' "$output" | grep -c '^  - harbor.example.invalid/portico/')" -eq 2 ] \
      || fail "Docker image summaries were concatenated instead of line-separated"

    rm -rf "$tmp_dir"
  )
}

test_fixed_release_timestamp_overrides_metadata_cache_time() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir
    tmp_dir="$(mktemp -d)"
    SOURCE_STAGE_DIR="$tmp_dir/source"
    PACKAGE_SOURCE_CLEAN=false
    BUILD_ID="03122026-deadbeef"
    FULL_SHA="deadbeefcafefeeddeadbeefcafefeeddeadbeef"
    CHANNEL_PACKAGE_NAME="portico_dev"
    RELEASE_TIMESTAMP="2026-03-12T15:16:17.000Z"
    mkdir -p "$SOURCE_STAGE_DIR/electron-app"

    write_release_metadata_files
    grep -Fq '"timestamp": "2026-03-12T15:16:17.000Z"' \
      "$SOURCE_STAGE_DIR/electron-app/build-info.json" \
      || fail "fixed release timestamp was not written verbatim"
    rm -rf "$tmp_dir"
  )
}

test_attested_runtime_images_skip_local_docker_entirely() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir
    tmp_dir="$(mktemp -d)"
    FULL_SHA="deadbeefcafefeeddeadbeefcafefeeddeadbeef"
    DOCKER_IMAGE_TAG="$FULL_SHA"
    RUNTIME_IMAGE_ATTESTATION="$tmp_dir/runtime-images.json"
    make_runtime_image_attestation \
      "$RUNTIME_IMAGE_ATTESTATION" \
      "$FULL_SHA" \
      "$DOCKER_IMAGE_TAG"

    docker() { fail "attested runtime image reuse invoked local Docker"; }
    prepare_release_docker_images

    [ "$DID_BUILD_DOCKER_IMAGES" = false ] \
      || fail "attested runtime image reuse recorded a local image build"
    [ "$(wc -w <<<"$DOCKER_IMAGES_REUSED" | tr -d ' ')" -eq 7 ] \
      || fail "attested runtime image reuse did not record all seven images"
    rm -rf "$tmp_dir"
  )
}

test_revision_marked_host_tree_is_validated_without_rebuild() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir target
    tmp_dir="$(mktemp -d)"
    SOURCE_STAGE_DIR="$tmp_dir/source"
    HOST_MCP_BINARIES_DIR="$tmp_dir/input"
    HOST_MCP_SOURCE_REVISION="deadbeefcafefeeddeadbeefcafefeeddeadbeef"
    mkdir -p "$SOURCE_STAGE_DIR"
    make_fake_required_host_mcp_binaries "$HOST_MCP_BINARIES_DIR"
    for target in \
      aarch64-apple-darwin \
      x86_64-apple-darwin \
      x86_64-unknown-linux-gnu \
      aarch64-unknown-linux-gnu
    do
      printf '%s\n' "$HOST_MCP_SOURCE_REVISION" \
        > "$HOST_MCP_BINARIES_DIR/$target/.source-revision"
    done

    file() {
      case "$2" in
        */aarch64-apple-darwin/mcp-orc) printf '%s\n' 'Mach-O 64-bit executable arm64' ;;
        */x86_64-apple-darwin/mcp-orc) printf '%s\n' 'Mach-O 64-bit executable x86_64' ;;
        */aarch64-unknown-linux-gnu/mcp-orc) printf '%s\n' 'ELF 64-bit LSB executable, ARM aarch64' ;;
        */x86_64-unknown-linux-gnu/mcp-orc) printf '%s\n' 'ELF 64-bit LSB executable, x86-64' ;;
        *) return 1 ;;
      esac
    }
    refresh_staged_host_mcp_binaries() {
      fail "revision-marked CI host binaries were rebuilt"
    }

    prepare_host_mcp_binaries
    [ "$HOST_MCP_SOURCE_DIR" = "$SOURCE_STAGE_DIR/host-mcp-binaries" ] \
      || fail "validated revision-marked host tree was not selected"
    rm -rf "$tmp_dir"
  )
}

test_unsigned_preview_configuration_is_credential_free_and_unsigned() {
  grep -Fq 'CLOUDSMITH_API_KEY="mr-preview-disabled"' "$PACKAGE_SCRIPT" \
    || fail "unsigned preview does not use the deterministic API placeholder"
  grep -Fq 'CLOUDSMITH_ENTITLEMENT_TOKEN="mr-preview-disabled"' "$PACKAGE_SCRIPT" \
    || fail "unsigned preview does not use the deterministic entitlement placeholder"
  grep -Fq 'CSC_IDENTITY_AUTO_DISCOVERY=false' "$PACKAGE_SCRIPT" \
    || fail "unsigned preview does not disable signing identity discovery"
  grep -Fq -- '--config.mac.identity=null' "$PACKAGE_SCRIPT" \
    || fail "unsigned preview does not force a null macOS signing identity"
  grep -Fq -- '--config.afterSign=scripts/noop.js' "$PACKAGE_SCRIPT" \
    || fail "unsigned preview does not disable the notarization hook"
  grep -Fq -- '--config.dmg.sign=false' "$PACKAGE_SCRIPT" \
    || fail "unsigned preview does not disable DMG signing"
}

test_macos_target_configuration_preserves_cli_arch_selection() {
  node - "$PROJECT_ROOT/electron-app/package.json" <<'NODE' || fail "macOS target configuration overrides CLI architecture selection"
const fs = require('fs');
const packageJson = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const targets = packageJson.build.mac.target;
if (!Array.isArray(targets) || targets.some((target) => Object.prototype.hasOwnProperty.call(target, 'arch'))) {
  process.exit(1);
}
if (packageJson.build.dmg.sign !== true) {
  process.exit(1);
}
const command = packageJson.scripts['build:mac'];
if (!command.includes('--x64') || !command.includes('--arm64')) {
  process.exit(1);
}
NODE
}

test_unsigned_dmg_fails_release_validation() {
  (
    source "$PACKAGE_SCRIPT"

    local tmp_dir dmg_path output status
    tmp_dir="$(mktemp -d)"
    dmg_path="$tmp_dir/Portico.dmg"
    : > "$dmg_path"

    codesign() {
      printf '%s\n' "code object is not signed at all" >&2
      return 1
    }
    spctl() { fail "Gatekeeper must not run after DMG codesign fails"; }
    xcrun() { fail "stapler must not run after DMG codesign fails"; }

    set +e
    output="$(verify_macos_dmg_trust_for_release "$dmg_path" 2>&1)"
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "unsigned DMG passed release validation"
    printf '%s' "$output" | grep -q 'code object is not signed at all' \
      || fail "unsigned DMG failure did not preserve codesign diagnostics"
    rm -rf "$tmp_dir"
  )
}

test_dmg_is_notarized_before_dmg_staple
test_per_arch_output_rejects_unexpected_architecture
test_per_arch_output_records_only_requested_architecture
test_detect_app_arch_prefers_binary_over_parent_dir_name
test_ensure_arch_artifacts_rejects_explicit_app_arch_mismatch
test_preflight_marks_stale_auto_discovered_artifacts_for_rebuild_on_macos
test_preflight_rejects_stale_explicit_artifacts
test_preflight_reuses_matching_auto_discovered_artifacts
test_dirty_source_bypasses_persistent_macos_artifact_cache
test_macos_build_replaces_only_affected_marked_cache_directory
test_main_preflights_macos_artifacts_before_expensive_release_work
test_resolve_cloudsmith_release_entitlement_token_exports_without_logging_secret
test_resolve_cloudsmith_release_api_key_uses_environment_then_file_without_logging_secret
test_environment_cloudsmith_credentials_support_release_resolution_without_source_file
test_write_release_metadata_files_keeps_cloudsmith_helper_outside_json
test_custom_release_channel_mapping_and_metadata
test_release_metadata_cache_preserves_same_release_timestamp_and_invalidates_new_revision
test_cleanup_preserves_temp_dir_on_failure_by_default
test_cleanup_removes_temp_dir_on_success
test_cleanup_reports_failure_after_valid_payload_accurately
test_package_disk_preflight_rejects_insufficient_space
test_release_staging_retention_prunes_only_marked_older_trees
test_ensure_electron_dependencies_runs_packaged_build_preparation_after_install
test_run_electron_builder_retries_transient_dmg_detach_failure
test_verify_packaged_app_host_mcp_binaries_accepts_expected_darwin_binaries
test_refresh_host_mcp_streams_live_output_and_preserves_failure_log
test_refresh_host_mcp_uses_clean_revision_cache_and_removes_success_log
test_refresh_host_mcp_dirty_source_isolates_persistent_artifact_and_cargo_caches
test_prepare_host_mcp_binaries_refreshes_stale_staged_darwin_targets_on_macos
test_prepare_host_mcp_binaries_refreshes_explicit_seed_dir_on_macos
test_prepare_host_mcp_binaries_ignores_generated_target_outputs_when_refreshing_on_macos
test_prepare_host_mcp_binaries_rejects_stale_darwin_targets_on_non_macos
test_prepare_host_mcp_binaries_fails_during_refresh_when_host_lockfile_drifts
test_verify_packaged_app_release_integrity_accepts_matching_metadata_and_prereq_scripts
test_verify_packaged_app_release_integrity_rejects_cloudsmith_resource_drift
test_verify_packaged_app_release_integrity_rejects_internally_inconsistent_build_info
test_resolve_full_sha_prefers_git_head_over_stale_build_info
test_resolve_full_sha_falls_back_to_build_info_when_git_is_unavailable
test_validate_release_metadata_consistency_fails_before_packaging
test_stage_payload_contents_verifies_copied_app_bundles
test_write_release_manifest_includes_schema_v2_and_docker_images
test_prepare_release_docker_images_force_builds_all_images
test_prepare_release_docker_images_reuses_all_valid_images
test_prepare_release_docker_images_builds_only_invalid_images
test_prepare_release_docker_images_dirty_tree_builds_all_images
test_prepare_release_docker_images_skip_validates_and_fails_closed
test_prepare_release_docker_images_rejects_force_and_skip
test_release_image_metadata_validation
test_sync_reused_release_images_updates_and_revalidates_latest
test_sync_reused_release_images_skips_matching_latest_manifest_digest
test_agent_vm_dockerfile_has_resilient_apt_contract
test_build_docker_images_selects_retries_labels_and_pins_builder
test_build_docker_images_retries_cargo_http2_failures
test_build_docker_images_rejects_insufficient_initial_disk_space
test_build_docker_images_retries_recovered_buildkit_control_plane_failure
test_build_docker_images_does_not_retry_unavailable_local_runtime
test_build_docker_images_blocks_rpc_retry_when_disk_fills
test_build_docker_images_does_not_retry_deterministic_failures
test_build_docker_images_does_not_retry_deterministic_or_auth_failures_with_network_text
test_build_docker_images_fails_after_network_retry_exhaustion
test_build_docker_images_honors_attempt_override_for_cargo_http2_exhaustion
test_build_docker_images_rejects_unknown_selection
test_stage_source_tree_keeps_runtime_base_files
test_stage_managed_root_curates_runtime_payload
test_stage_managed_root_requires_checked_in_ootb_sources
test_stage_managed_root_excludes_generated_rust_target_outputs
test_immutable_runner_survives_original_script_replacement_and_cleans_marked_dir
test_immutable_runner_retries_unstable_copy_and_rejects_invalid_snapshot
test_stage_source_tree_rejects_source_changes_during_copy
test_stage_source_tree_ignores_report_build_churn
test_checkout_change_after_staging_warns_without_invalidating_snapshot
test_create_payload_zip_is_atomic_and_preserves_existing_final_on_failure
test_create_payload_zip_preserves_extended_attributes_on_macos
test_release_summary_prints_each_docker_image_on_its_own_line
test_fixed_release_timestamp_overrides_metadata_cache_time
test_attested_runtime_images_skip_local_docker_entirely
test_revision_marked_host_tree_is_validated_without_rebuild
test_unsigned_preview_configuration_is_credential_free_and_unsigned
test_macos_target_configuration_preserves_cli_arch_selection
test_unsigned_dmg_fails_release_validation

echo "PASS: package_for_release shell tests"
