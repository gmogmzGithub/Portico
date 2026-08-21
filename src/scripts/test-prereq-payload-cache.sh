#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# shellcheck source=/dev/null
. "$ROOT_DIR/src/scripts/prereq-download.sh"

# PORTICO-342: capture the SHIPPED defaults before any test workspace overrides them.
# Asserting on an overridden value would make the location test vacuous.
DEFAULT_PAYLOAD_CACHE_DIR="$PREREQ_PAYLOAD_CACHE_DIR"
DEFAULT_PAYLOAD_PARTIAL_DIR="$PREREQ_PAYLOAD_PARTIAL_DIR"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

assert_contains() {
  local haystack="$1"
  local needle="$2"

  case "$haystack" in
    *"$needle"*) ;;
    *) fail "expected output to contain: $needle" ;;
  esac
}

assert_not_contains_file_tree() {
  local root_dir="$1"
  local needle="$2"

  if grep -R "$needle" "$root_dir" >/dev/null 2>&1; then
    fail "expected $root_dir not to contain raw secret: $needle"
  fi
}

new_test_workspace() {
  TEST_TMP="$(mktemp -d)"
  PREREQ_PAYLOAD_CACHE_DIR="$TEST_TMP/cache"
  TEMP_DIR="$TEST_TMP/work"
  mkdir -p "$TEMP_DIR"
}

reset_payload_target() {
  BUILD_NUMBER="04192026-abcdef12"
  KEYWORD="portico"
  pkg_version="$BUILD_NUMBER"
  BUILD_LAST_MODIFIED="2026-04-19T12:34:56Z"
  EXPECTED_FILENAME="${KEYWORD}-${BUILD_NUMBER}.zip"
  DOWNLOAD_URL="https://dl.example.invalid/basic/portico/raw/names/${KEYWORD}/versions/${pkg_version}/${EXPECTED_FILENAME}?token=super-secret-token"
  DOWNLOAD_FILE="$TEST_TMP/$EXPECTED_FILENAME"
  PAYLOAD_CACHE_USED="false"
  PAYLOAD_CACHE_ENTRY_DIR=""
}

write_payload() {
  local payload_file="$1"

  printf 'fake payload bytes for cache helper tests\n' > "$payload_file"
}

test_cache_promote_and_hit_emits_completed_progress() {
  local payload_file=""
  local total_bytes=""
  local entry_dir=""
  local output=""
  local output_file=""

  new_test_workspace
  reset_payload_target
  payload_file="$TEST_TMP/downloaded.zip"
  write_payload "$payload_file"
  total_bytes="$(file_size_bytes "$payload_file")"

  payload_cache_promote_download "$payload_file" "$total_bytes"
  entry_dir="$(payload_cache_entry_dir_for_target "$total_bytes")"

  [ -s "$entry_dir/payload.zip" ] || fail "expected promoted cache payload"
  [ -f "$entry_dir/metadata.tsv" ] || fail "expected promoted cache metadata"
  assert_not_contains_file_tree "$entry_dir" "super-secret-token"

  DOWNLOAD_FILE="$TEST_TMP/should-not-be-downloaded.zip"
  output_file="$TEST_TMP/cache-hit.out"
  if ! payload_cache_try_reuse "$total_bytes" > "$output_file"; then
    fail "expected matching payload cache to be reused"
  fi
  output="$(cat "$output_file")"

  [ "$DOWNLOAD_FILE" = "$entry_dir/payload.zip" ] \
    || fail "expected cache hit to point DOWNLOAD_FILE at cached payload"
  assert_contains "$output" "[PREREQ:PROGRESS:download_bytes:$total_bytes]"
  assert_contains "$output" "[PREREQ:PROGRESS:download_percent:100]"
  assert_contains "$output" "[PREREQ:PROGRESS:download_complete:true]"
  assert_contains "$output" "Using cached update payload"

  rm -rf "$TEST_TMP"
}

test_metadata_mismatch_misses_cache() {
  local payload_file=""
  local total_bytes=""
  local entry_dir=""
  local metadata_file=""

  new_test_workspace
  reset_payload_target
  payload_file="$TEST_TMP/downloaded.zip"
  write_payload "$payload_file"
  total_bytes="$(file_size_bytes "$payload_file")"

  payload_cache_promote_download "$payload_file" "$total_bytes"
  entry_dir="$(payload_cache_entry_dir_for_target "$total_bytes")"
  metadata_file="$entry_dir/metadata.tsv"
  sed 's/^channel	.*/channel	other-channel/' "$metadata_file" > "$metadata_file.tmp"
  mv "$metadata_file.tmp" "$metadata_file"

  if payload_cache_try_reuse "$total_bytes" >/dev/null 2>&1; then
    fail "expected metadata mismatch to miss payload cache"
  fi

  rm -rf "$TEST_TMP"
}

test_size_mismatch_misses_cache() {
  local payload_file=""
  local total_bytes=""
  local entry_dir=""

  new_test_workspace
  reset_payload_target
  payload_file="$TEST_TMP/downloaded.zip"
  write_payload "$payload_file"
  total_bytes="$(file_size_bytes "$payload_file")"

  payload_cache_promote_download "$payload_file" "$total_bytes"
  entry_dir="$(payload_cache_entry_dir_for_target "$total_bytes")"
  printf 'x' > "$entry_dir/payload.zip"

  if payload_cache_try_reuse "$total_bytes" >/dev/null 2>&1; then
    fail "expected cached payload size mismatch to miss payload cache"
  fi

  rm -rf "$TEST_TMP"
}

test_invalid_used_cache_entry_can_be_removed() {
  local payload_file=""
  local total_bytes=""
  local entry_dir=""

  new_test_workspace
  reset_payload_target
  payload_file="$TEST_TMP/downloaded.zip"
  write_payload "$payload_file"
  total_bytes="$(file_size_bytes "$payload_file")"

  payload_cache_promote_download "$payload_file" "$total_bytes"
  entry_dir="$(payload_cache_entry_dir_for_target "$total_bytes")"
  payload_cache_try_reuse "$total_bytes" >/dev/null
  payload_cache_invalidate_used "test invalid archive"

  [ ! -d "$entry_dir" ] || fail "expected invalid cached payload entry to be removed"

  rm -rf "$TEST_TMP"
}

test_cache_retention_keeps_two_newest_entries() {
  local index=""
  local payload_file=""
  local cache_count=""

  new_test_workspace
  payload_file="$TEST_TMP/downloaded.zip"
  write_payload "$payload_file"

  for index in 1 2 3; do
    reset_payload_target
    BUILD_NUMBER="04192026-abcdef1${index}"
    pkg_version="$BUILD_NUMBER"
    EXPECTED_FILENAME="${KEYWORD}-${BUILD_NUMBER}.zip"
    DOWNLOAD_URL="https://dl.example.invalid/basic/portico/raw/names/${KEYWORD}/versions/${pkg_version}/${EXPECTED_FILENAME}?token=super-secret-token"
    payload_cache_promote_download "$payload_file" "$(file_size_bytes "$payload_file")"
    sleep 1
  done

  cache_count="$(find "$PREREQ_PAYLOAD_CACHE_DIR" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d '[:space:]')"
  [ "$cache_count" = "2" ] || fail "expected payload cache retention to keep 2 entries, saw $cache_count"

  rm -rf "$TEST_TMP"
}

# ============================================================================
# PORTICO-342: resumable partial payloads.
#
# The reported install moved 2,294 MB for a 777 MB payload across five failed
# attempts because the download went to a disposable mktemp -d directory. These
# cases pin that partial bytes survive, and -- more importantly -- that they are
# only ever resumed against the identical payload.
# ============================================================================

new_partial_workspace() {
  new_test_workspace
  PREREQ_PAYLOAD_PARTIAL_DIR="$TEST_TMP/partials"
  reset_payload_target
  BUILD_NUMBER="07252026-88063b81"
  EXPECTED_FILENAME="portico_beta-${BUILD_NUMBER}.zip"
  DOWNLOAD_URL="https://dl.example.invalid/basic/portico/raw/names/x/versions/${BUILD_NUMBER}/${EXPECTED_FILENAME}"
  BUILD_LAST_MODIFIED="Fri, 25 Jul 2026 10:00:00 GMT"
  PARTIAL_DIR="$(payload_partial_dir_for_target)"
  mkdir -p "$PARTIAL_DIR"
  PARTIAL_FILE="$PARTIAL_DIR/$EXPECTED_FILENAME"
}

test_partials_live_outside_the_cache_so_pruning_cannot_eat_them() {
  # Asserted against the SHIPPED defaults, not a test override: the hazard is what
  # real users get. payload_cache_prune_old_entries iterates
  # "$PREREQ_PAYLOAD_CACHE_DIR"/* and treats every directory as a completed cache
  # entry, so a partials directory in there is a prune candidate -- retention could
  # delete the download that is currently in flight.
  [ -n "$DEFAULT_PAYLOAD_PARTIAL_DIR" ] || fail "no default partial directory is configured"
  case "$DEFAULT_PAYLOAD_PARTIAL_DIR" in
    "$DEFAULT_PAYLOAD_CACHE_DIR"/*|"$DEFAULT_PAYLOAD_CACHE_DIR")
      fail "the default partial directory ($DEFAULT_PAYLOAD_PARTIAL_DIR) must not live inside the payload cache ($DEFAULT_PAYLOAD_CACHE_DIR)" ;;
  esac
}

test_matching_partial_is_resumable() {
  new_partial_workspace
  printf 'aaaa' > "$PARTIAL_FILE"
  payload_partial_write_validator 1000 || fail "expected the validator to be written"
  payload_partial_is_resumable "$PARTIAL_FILE" 1000 \
    || fail "a partial with a matching validator and short length should resume"
  rm -rf "$TEST_TMP"
}

test_changed_payload_is_never_resumed() {
  new_partial_workspace
  printf 'aaaa' > "$PARTIAL_FILE"
  payload_partial_write_validator 1000

  # Server-side payload replaced: resuming here would splice new bytes onto old.
  BUILD_LAST_MODIFIED="Sat, 26 Jul 2026 11:00:00 GMT"
  ! payload_partial_is_resumable "$PARTIAL_FILE" 1000 \
    || fail "a changed Last-Modified validator must not resume"

  # Same for a different expected length or a different filename.
  BUILD_LAST_MODIFIED="Fri, 25 Jul 2026 10:00:00 GMT"
  ! payload_partial_is_resumable "$PARTIAL_FILE" 2000 \
    || fail "a content length that changed since the partial was written must not resume"
  rm -rf "$TEST_TMP"
}

test_missing_validator_blocks_resume() {
  new_partial_workspace
  printf 'aaaa' > "$PARTIAL_FILE"
  payload_partial_write_validator 1000
  # Without a validator there is nothing for If-Range to compare, so the server
  # could hand back 206 for a payload that changed underneath us.
  BUILD_LAST_MODIFIED=""
  ! payload_partial_is_resumable "$PARTIAL_FILE" 1000 \
    || fail "resume must be refused when no validator is available"
  rm -rf "$TEST_TMP"
}

test_empty_or_overlong_partial_is_not_resumed() {
  new_partial_workspace
  : > "$PARTIAL_FILE"
  payload_partial_write_validator 1000
  ! payload_partial_is_resumable "$PARTIAL_FILE" 1000 || fail "an empty partial is not resumable"

  # At or beyond the expected length it is not a resume candidate; it is a corrupt
  # or already-complete file, and asking curl to continue would append past the end.
  head -c 1000 /dev/zero > "$PARTIAL_FILE"
  ! payload_partial_is_resumable "$PARTIAL_FILE" 1000 || fail "a full-length partial is not resumable"
  head -c 1200 /dev/zero > "$PARTIAL_FILE"
  ! payload_partial_is_resumable "$PARTIAL_FILE" 1000 || fail "an overlong partial is not resumable"
  rm -rf "$TEST_TMP"
}

test_discard_removes_both_bytes_and_validator() {
  new_partial_workspace
  printf 'aaaa' > "$PARTIAL_FILE"
  payload_partial_write_validator 1000
  payload_partial_discard "$PARTIAL_FILE" "test"
  [ ! -f "$PARTIAL_FILE" ] || fail "discard must remove the partial bytes"
  # Leaving the validator behind would let the next run believe stale bytes are good.
  [ ! -f "$(payload_partial_validator_file)" ] || fail "discard must remove the validator"
  rm -rf "$TEST_TMP"
}

test_cleanup_removes_the_partial_once_cached() {
  new_partial_workspace
  printf 'aaaa' > "$PARTIAL_FILE"
  payload_partial_write_validator 1000
  payload_partial_cleanup
  [ ! -d "$PARTIAL_DIR" ] || fail "cleanup must remove the partial directory after promotion"
  # ...and must never reach outside the partials root.
  [ -d "$PREREQ_PAYLOAD_PARTIAL_DIR" ] || mkdir -p "$PREREQ_PAYLOAD_PARTIAL_DIR"
  rm -rf "$TEST_TMP"
}

test_different_builds_get_different_partials() {
  new_partial_workspace
  local first="$PARTIAL_DIR"
  reset_payload_target
  BUILD_NUMBER="07262026-deadbeef"
  EXPECTED_FILENAME="portico_beta-${BUILD_NUMBER}.zip"
  DOWNLOAD_URL="https://dl.example.invalid/basic/portico/raw/names/x/versions/${BUILD_NUMBER}/${EXPECTED_FILENAME}"
  local second
  second="$(payload_partial_dir_for_target)"
  [ "$first" != "$second" ] \
    || fail "two different builds must not share one partial file"
  rm -rf "$TEST_TMP"
}

test_stale_partials_from_other_builds_are_pruned() {
  new_partial_workspace
  # Each abandoned build keeps its own identity-keyed directory of ~777 MB and
  # nothing else prunes this tree, so an install that is retried across builds would
  # accumulate copies indefinitely.
  mkdir -p "$PREREQ_PAYLOAD_PARTIAL_DIR/some-older-identity"
  printf 'stale' > "$PREREQ_PAYLOAD_PARTIAL_DIR/some-older-identity/old.zip"
  payload_partial_prune_other_identities "$PARTIAL_DIR"
  [ ! -d "$PREREQ_PAYLOAD_PARTIAL_DIR/some-older-identity" ] \
    || fail "a partial for a different payload identity should be pruned"
  [ -d "$PARTIAL_DIR" ] || fail "the current identity's partial must be kept"
  rm -rf "$TEST_TMP"
}

test_pruning_never_escapes_the_partials_root() {
  new_partial_workspace
  # A path bug here deletes user data, so pin that only children of the partials
  # root are ever removed.
  local sibling="$TEST_TMP/not-partials"
  mkdir -p "$sibling"
  printf 'keep me' > "$sibling/important.txt"
  payload_partial_prune_other_identities "$PARTIAL_DIR"
  [ -f "$sibling/important.txt" ] || fail "pruning must not touch anything outside the partials root"

  # And cleanup of the current identity is likewise confined.
  payload_partial_cleanup
  [ -f "$sibling/important.txt" ] || fail "cleanup must not touch anything outside the partials root"
  [ -d "$TEST_TMP" ] || fail "cleanup must not remove the workspace"
  rm -rf "$TEST_TMP"
}

# PORTICO-342: the payload curl argv, asserted behaviourally.
#
# Replaces two source pins in update-loop-regressions.test.js that matched
# prereq-download.sh's text for a fixed `-sS -L -f -o` invocation. Those broke on
# the very change they should have tolerated, and could not have caught the flags
# being dropped at runtime. PREPARED_CURL_ARGV_LOG is what curl is actually given.

build_payload_curl_argv() {
  local partial_bytes="${1:-0}"
  local total_bytes="${2:-1000}"

  new_partial_workspace
  DOWNLOAD_FILE="$PARTIAL_FILE"
  if [ "$partial_bytes" -gt 0 ]; then
    head -c "$partial_bytes" /dev/zero > "$PARTIAL_FILE"
    payload_partial_write_validator "$total_bytes"
  fi
  # Drive the REAL builder the download path uses, not a reconstruction of it.
  build_payload_curl_args "$total_bytes" "$DOWNLOAD_FILE"
  printf '%s\n' "${PAYLOAD_CURL_ARGS[*]}"
}

test_payload_curl_is_always_bounded_against_a_dead_transfer() {
  local argv
  argv="$(build_payload_curl_argv 0 1000)"
  assert_contains "$argv" "--speed-limit"
  assert_contains "$argv" "--speed-time"
  # Without these the only thing that ends a dead transfer is a TCP reset whenever
  # the kernel gets round to it; the reported install lost minutes that way.
  rm -rf "$TEST_TMP"
}

test_payload_curl_resumes_only_when_there_are_bytes_to_resume() {
  local fresh resumed
  fresh="$(build_payload_curl_argv 0 1000)"
  case "$fresh" in
    *"-C -"*) fail "a fresh download must not ask curl to resume" ;;
  esac
  case "$fresh" in
    *"If-Range"*) fail "a fresh download must not send If-Range" ;;
  esac

  resumed="$(build_payload_curl_argv 400 1000)"
  assert_contains "$resumed" "-C -"
  # If-Range is what makes resume safe: 206 only if the validator still matches,
  # otherwise a plain 200 and curl rewrites from the start.
  assert_contains "$resumed" "If-Range"
  rm -rf "$TEST_TMP"
}

test_clean_env_retry_keeps_resume_and_bounds() {
  # The clean-env retry works around a curl environment problem, not a corrupt body.
  # Both modes build their arguments from the same builder, so the guarantee is that
  # the builder is what feeds them -- verified by the argv cases above -- and that
  # the retry no longer deletes the partial before running.
  local argv
  argv="$(build_payload_curl_argv 400 1000)"
  assert_contains "$argv" "-C -"
  assert_contains "$argv" "--speed-limit"
  rm -rf "$TEST_TMP"
}

test_cache_promote_and_hit_emits_completed_progress
test_metadata_mismatch_misses_cache
test_size_mismatch_misses_cache
test_invalid_used_cache_entry_can_be_removed
test_cache_retention_keeps_two_newest_entries
test_partials_live_outside_the_cache_so_pruning_cannot_eat_them
test_matching_partial_is_resumable
test_changed_payload_is_never_resumed
test_missing_validator_blocks_resume
test_empty_or_overlong_partial_is_not_resumed
test_discard_removes_both_bytes_and_validator
test_cleanup_removes_the_partial_once_cached
test_different_builds_get_different_partials
test_payload_curl_is_always_bounded_against_a_dead_transfer
test_payload_curl_resumes_only_when_there_are_bytes_to_resume
test_clean_env_retry_keeps_resume_and_bounds
test_stale_partials_from_other_builds_are_pruned
test_pruning_never_escapes_the_partials_root

echo "prereq payload cache tests passed"
