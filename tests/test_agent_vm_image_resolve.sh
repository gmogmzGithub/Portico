#!/usr/bin/env bash

# Regression tests for resolve_agent_vm_runtime_image() (PORTICO-231).
#
# The resolver must never emit a known-nonexistent agent-vm:latest for
# release builds, must never touch the network, and must keep stdout pure
# (exactly one line: the ref).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RESOLVER_SCRIPT="$PROJECT_ROOT/src/scripts/agent-vm-image-resolve.sh"

BUILD_NUMBER="07072026-4d073bb9"
HARBOR_REF="harbor.example.invalid/portico/agent-vm:$BUILD_NUMBER"
LEGACY_REF="agent-vm:latest"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Stub docker: behavior driven by HARBOR_RC / INFO_RC / LEGACY_RC; every
# invocation is recorded in $CALLS_FILE.
docker() {
  printf 'docker %s\n' "$*" >>"$CALLS_FILE"
  case "$*" in
    "image inspect $HARBOR_REF") return "$HARBOR_RC" ;;
    "image inspect $LEGACY_REF") return "$LEGACY_RC" ;;
    "info") return "$INFO_RC" ;;
    *) echo "unexpected docker invocation: $*" >&2; return 64 ;;
  esac
}

run_resolver() {
  # Args: build_number harbor_rc info_rc legacy_rc
  STUB_BUILD_NUMBER="$1"
  HARBOR_RC="$2"
  INFO_RC="$3"
  LEGACY_RC="$4"
  CALLS_FILE="$(mktemp "$TMP_DIR/calls.XXXXXX")"
  STDERR_FILE="$(mktemp "$TMP_DIR/stderr.XXXXXX")"

  get_image_tag() { echo "$STUB_BUILD_NUMBER"; }

  # shellcheck source=/dev/null
  source "$RESOLVER_SCRIPT"
  RESOLVED="$(resolve_agent_vm_runtime_image 2>"$STDERR_FILE")"
}

assert_calls() {
  local expected="$1" label="$2"
  local actual
  actual="$(wc -l <"$CALLS_FILE" | tr -d '[:space:]')"
  [ "$actual" = "$expected" ] \
    || fail "$label: expected $expected docker call(s), got $actual: $(tr '\n' ';' <"$CALLS_FILE")"
}

test_dev_build_uses_legacy_image_without_docker_calls() {
  run_resolver "dev-build" 0 0 0
  [ "$RESOLVED" = "$LEGACY_REF" ] || fail "dev-build: expected $LEGACY_REF, got '$RESOLVED'"
  assert_calls 0 "dev-build"
}

test_release_with_local_harbor_image_is_unchanged_fast_path() {
  run_resolver "$BUILD_NUMBER" 0 0 0
  [ "$RESOLVED" = "$HARBOR_REF" ] || fail "healthy: expected $HARBOR_REF, got '$RESOLVED'"
  assert_calls 1 "healthy"
  grep -q "image inspect $HARBOR_REF" "$CALLS_FILE" || fail "healthy: expected a harbor inspect"
  [ ! -s "$STDERR_FILE" ] || fail "healthy: expected silent stderr, got: $(cat "$STDERR_FILE")"
}

test_engine_down_keeps_harbor_ref_and_defers() {
  run_resolver "$BUILD_NUMBER" 1 1 0
  [ "$RESOLVED" = "$HARBOR_REF" ] || fail "engine-down: expected $HARBOR_REF, got '$RESOLVED'"
  assert_calls 2 "engine-down"
  grep -q "engine not ready" "$STDERR_FILE" || fail "engine-down: expected 'engine not ready' warning"
  ! grep -q "image inspect $LEGACY_REF" "$CALLS_FILE" \
    || fail "engine-down: must not probe the legacy image with the engine down"
}

test_missing_harbor_image_falls_back_to_existing_legacy_image() {
  run_resolver "$BUILD_NUMBER" 1 0 0
  [ "$RESOLVED" = "$LEGACY_REF" ] || fail "legacy-fallback: expected $LEGACY_REF, got '$RESOLVED'"
  assert_calls 3 "legacy-fallback"
  grep -q "falling back to legacy local $LEGACY_REF" "$STDERR_FILE" \
    || fail "legacy-fallback: expected a fallback warning on stderr"
}

test_nothing_available_keeps_pullable_harbor_ref_with_loud_error() {
  run_resolver "$BUILD_NUMBER" 1 0 1
  [ "$RESOLVED" = "$HARBOR_REF" ] || fail "nothing-available: expected $HARBOR_REF, got '$RESOLVED'"
  assert_calls 3 "nothing-available"
  grep -q "docker pull $HARBOR_REF" "$STDERR_FILE" \
    || fail "nothing-available: stderr must name the manual recovery command"
  ! grep -q "^$LEGACY_REF$" <<<"$RESOLVED" || fail "nothing-available: must not emit agent-vm:latest"
}

test_stdout_is_exactly_one_line_in_every_scenario() {
  local scenario
  for scenario in "dev-build 0 0 0" "$BUILD_NUMBER 0 0 0" "$BUILD_NUMBER 1 1 0" \
    "$BUILD_NUMBER 1 0 0" "$BUILD_NUMBER 1 0 1"; do
    # shellcheck disable=SC2086
    run_resolver $scenario
    case "$RESOLVED" in
      *$'\n'*) fail "stdout purity: multi-line output for scenario '$scenario': '$RESOLVED'" ;;
    esac
    [ -n "$RESOLVED" ] || fail "stdout purity: empty output for scenario '$scenario'"
  done
}

test_dev_build_uses_legacy_image_without_docker_calls
test_release_with_local_harbor_image_is_unchanged_fast_path
test_engine_down_keeps_harbor_ref_and_defers
test_missing_harbor_image_falls_back_to_existing_legacy_image
test_nothing_available_keeps_pullable_harbor_ref_with_loud_error
test_stdout_is_exactly_one_line_in_every_scenario

echo "PASS: agent VM image resolution regressions"
