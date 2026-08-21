#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INTEGRITY_SCRIPT="$PROJECT_ROOT/src/scripts/managed-runtime-integrity.sh"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

write_packaged_runtime_fixture() {
  local project_root="$1"
  local build_number="$2"
  local harbor_tag="${3:-$build_number}"
  local llm_gateway_tag="${4:-$harbor_tag}"
  local docker_image_tag="${5:-}"
  local docker_image_tag_line=""

  mkdir -p "$project_root/electron-app"

  if [ -n "$docker_image_tag" ]; then
    docker_image_tag_line=$'\n  "dockerImageTag": "'"${docker_image_tag}"'",'
  fi

  cat > "$project_root/electron-app/build-info.json" <<EOF
{
  "buildNumber": "${build_number}",${docker_image_tag_line}
  "fullSha": "7694a7e1deadbeef"
}
EOF

  cat > "$project_root/docker-compose.override.yml" <<'EOF'
services:
  mcpo:
    environment:
      - EXAMPLE=1
EOF

  cat > "$project_root/docker-compose.harbor.yml" <<EOF
# Image tag: ${harbor_tag} (from build-info.json)
services:
  llm-gateway:
    image: harbor.example.invalid/portico/bifrost-bridge:${llm_gateway_tag}
  mcpo:
    image: harbor.example.invalid/portico/mcpo-control-plane-rust:${harbor_tag}
EOF
}

make_packaged_app_bundle() {
  local bundle_root="$1"
  mkdir -p "$bundle_root/Contents/Resources"
}

test_remove_generated_compose_files_prunes_legacy_payload_artifacts() {
  (
    source "$INTEGRITY_SCRIPT"

    local tmp_dir
    tmp_dir="$(mktemp -d)"

    cat > "$tmp_dir/docker-compose.yml" <<'EOF'
services: {}
EOF
    : > "$tmp_dir/docker-compose.override.yml"
    : > "$tmp_dir/docker-compose.harbor.yml"

    managed_runtime_remove_generated_compose_files "$tmp_dir"

    [ -f "$tmp_dir/docker-compose.yml" ] \
      || fail "docker-compose.yml should not be removed"
    [ ! -e "$tmp_dir/docker-compose.override.yml" ] \
      || fail "docker-compose.override.yml should be removed from staged payloads"
    [ ! -e "$tmp_dir/docker-compose.harbor.yml" ] \
      || fail "docker-compose.harbor.yml should be removed from staged payloads"
  )
}

test_validate_generated_compose_accepts_build_matched_generated_files() {
  (
    source "$INTEGRITY_SCRIPT"

    local tmp_dir
    tmp_dir="$(mktemp -d)"
    write_packaged_runtime_fixture "$tmp_dir" "03172026-7694a7e1"

    managed_runtime_validate_generated_compose "$tmp_dir" \
      || fail "validate_generated_compose rejected a build-matched generated runtime"
  )
}

test_validate_generated_compose_rejects_stale_harbor_tag() {
  (
    source "$INTEGRITY_SCRIPT"

    local tmp_dir output
    tmp_dir="$(mktemp -d)"
    write_packaged_runtime_fixture "$tmp_dir" "03172026-7694a7e1" "latest"

    if output="$(managed_runtime_validate_generated_compose "$tmp_dir" 2>&1)"; then
      fail "validate_generated_compose unexpectedly accepted a stale harbor tag"
    fi

    case "$output" in
      *"Generated Harbor compose override tag mismatch"* ) ;;
      * ) fail "expected stale harbor tag validation error, got: $output" ;;
    esac
  )
}

test_validate_generated_compose_rejects_stale_image_refs() {
  (
    source "$INTEGRITY_SCRIPT"

    local tmp_dir output
    tmp_dir="$(mktemp -d)"
    write_packaged_runtime_fixture "$tmp_dir" "03172026-7694a7e1" "03172026-7694a7e1" "latest"

    if output="$(managed_runtime_validate_generated_compose "$tmp_dir" 2>&1)"; then
      fail "validate_generated_compose unexpectedly accepted stale harbor image refs"
    fi

    case "$output" in
      *"Generated Harbor compose override references stale image"* ) ;;
      * ) fail "expected stale harbor image validation error, got: $output" ;;
    esac
  )
}

# PORTICO-371: MR/broker builds record dockerImageTag=mr-<iid>-<sha> and generate
# the compose with that tag (not the build number). Validation must accept it.
test_validate_generated_compose_accepts_mr_image_tag_from_build_info() {
  (
    source "$INTEGRITY_SCRIPT"

    local tmp_dir mr_tag
    tmp_dir="$(mktemp -d)"
    mr_tag="mr-247-cd3c713006149d26e2101428619154f51d2ce20b"
    # build number != image tag; generated compose is tagged with the mr tag.
    write_packaged_runtime_fixture "$tmp_dir" "07292026-cd3c7130" "$mr_tag" "$mr_tag" "$mr_tag"

    managed_runtime_validate_generated_compose "$tmp_dir" \
      || fail "validate_generated_compose rejected a valid MR-tagged generated runtime"
  )
}

# ...but an MR build whose compose is still tagged with the build number (i.e.
# the generator did NOT apply dockerImageTag) is stale and must be rejected.
test_validate_generated_compose_rejects_build_number_tag_when_image_tag_is_mr() {
  (
    source "$INTEGRITY_SCRIPT"

    local tmp_dir output mr_tag
    tmp_dir="$(mktemp -d)"
    mr_tag="mr-247-cd3c713006149d26e2101428619154f51d2ce20b"
    write_packaged_runtime_fixture "$tmp_dir" "07292026-cd3c7130" "07292026-cd3c7130" "07292026-cd3c7130" "$mr_tag"

    if output="$(managed_runtime_validate_generated_compose "$tmp_dir" 2>&1)"; then
      fail "validate_generated_compose accepted a build-number tag when dockerImageTag is the mr tag"
    fi

    case "$output" in
      *"Generated Harbor compose override tag mismatch"* ) ;;
      * ) fail "expected mr-tag mismatch validation error, got: $output" ;;
    esac
  )
}

test_regenerate_generated_compose_normalizes_host_mode_directory_to_false_file() {
  (
    source "$INTEGRITY_SCRIPT"

    local tmp_dir output observed_args
    tmp_dir="$(mktemp -d)"
    observed_args="$tmp_dir/observed-args"

    mkdir -p "$tmp_dir/HOST_MODE"

    resolve_mcp_orc_generator_binary() {
      return 0
    }

    run_mcp_orc_generator() {
      local project_root="$1"
      shift
      printf '%s\n' "$*" > "$observed_args"
      [ -f "$project_root/HOST_MODE" ] || return 11
      [ ! -d "$project_root/HOST_MODE" ] || return 12
      [ "$(cat "$project_root/HOST_MODE")" = "FALSE" ] || return 13
      return 0
    }

    output="$(managed_runtime_regenerate_generated_compose "$tmp_dir" 2>&1)" \
      || fail "expected regenerate_generated_compose to recover from a HOST_MODE directory, saw: $output"

    [ -f "$tmp_dir/HOST_MODE" ] \
      || fail "expected HOST_MODE to be recreated as a file"
    [ "$(cat "$tmp_dir/HOST_MODE")" = "FALSE" ] \
      || fail "expected HOST_MODE to be recreated with FALSE"
    [ -f "$observed_args" ] \
      || fail "expected run_mcp_orc_generator to be invoked after normalizing HOST_MODE"
    [ "$(cat "$observed_args")" = "generate-docker-compose-override --force" ] \
      || fail "expected regenerate_generated_compose to invoke the forced docker compose override generator"
    case "$output" in
      *"Normalized required volume file path(s) into files: HOST_MODE"* ) ;;
      * ) fail "expected regenerate_generated_compose to log HOST_MODE normalization, got: $output" ;;
    esac
  )
}

test_prepare_packaged_env_explicit_resources_root_overrides_inherited_value() {
  (
    source "$INTEGRITY_SCRIPT"

    local tmp_dir old_bundle new_bundle new_resources_root
    tmp_dir="$(mktemp -d)"
    old_bundle="$tmp_dir/Portico Old.app"
    new_bundle="$tmp_dir/Portico New.app"
    make_packaged_app_bundle "$old_bundle"
    make_packaged_app_bundle "$new_bundle"
    new_resources_root="$new_bundle/Contents/Resources"

    HOST_MCP_IS_PACKAGED=1
    HOST_MCP_RESOURCES_ROOT="$old_bundle/Contents/Resources"

    uname() {
      if [ "${1:-}" = "-s" ]; then
        printf 'Darwin\n'
        return 0
      fi
      command uname "$@"
    }

    managed_runtime_prepare_packaged_env "$tmp_dir" "$new_bundle" \
      || fail "managed_runtime_prepare_packaged_env rejected an explicit packaged app bundle"

    [ "$HOST_MCP_RESOURCES_ROOT" = "$new_resources_root" ] \
      || fail "explicit packaged resources root did not override the inherited value"
  )
}

test_require_packaged_generator_binary_prefers_explicit_resources_root_over_inherited_env() {
  (
    source "$INTEGRITY_SCRIPT"

    local tmp_dir project_root old_bundle new_bundle expected_root observed_root_file
    tmp_dir="$(mktemp -d)"
    project_root="$tmp_dir/project"
    old_bundle="$tmp_dir/Portico Old.app"
    new_bundle="$tmp_dir/Portico New.app"
    expected_root="$new_bundle/Contents/Resources"
    observed_root_file="$tmp_dir/observed-root"

    mkdir -p "$project_root"
    make_packaged_app_bundle "$old_bundle"
    make_packaged_app_bundle "$new_bundle"

    HOST_MCP_IS_PACKAGED=1
    HOST_MCP_RESOURCES_ROOT="$old_bundle/Contents/Resources"

    uname() {
      if [ "${1:-}" = "-s" ]; then
        printf 'Darwin\n'
        return 0
      fi
      command uname "$@"
    }

    resolve_mcp_orc_generator_binary() {
      local _project_root="$1"
      local resources_root="$2"
      printf '%s' "$resources_root" > "$observed_root_file"
      return 0
    }

    managed_runtime_require_packaged_generator_binary "$project_root" "$new_bundle" >/dev/null \
      || fail "managed_runtime_require_packaged_generator_binary failed with an explicit resources root"

    [ -f "$observed_root_file" ] || fail "resolve_mcp_orc_generator_binary was not invoked"
    observed_root="$(cat "$observed_root_file")"
    [ "$observed_root" = "$expected_root" ] \
      || fail "generator resolution did not use the explicit packaged resources root"
  )
}

test_remove_generated_compose_files_prunes_legacy_payload_artifacts
test_validate_generated_compose_accepts_build_matched_generated_files
test_validate_generated_compose_rejects_stale_harbor_tag
test_validate_generated_compose_rejects_stale_image_refs
test_validate_generated_compose_accepts_mr_image_tag_from_build_info
test_validate_generated_compose_rejects_build_number_tag_when_image_tag_is_mr
test_regenerate_generated_compose_normalizes_host_mode_directory_to_false_file
test_prepare_packaged_env_explicit_resources_root_overrides_inherited_value
test_require_packaged_generator_binary_prefers_explicit_resources_root_over_inherited_env

echo "PASS: managed runtime integrity shell tests"
