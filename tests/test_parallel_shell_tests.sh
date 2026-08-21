#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/portico-parallel-shell-tests.XXXXXX")"

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

# shellcheck source=tests/helpers/parallel-shell-tests.sh
source "$PROJECT_ROOT/tests/helpers/parallel-shell-tests.sh"

slow_first_job() {
  local attempt=0
  while [ "$attempt" -lt 100 ]; do
    [ ! -f "$TEST_ROOT/third-started" ] || return 0
    sleep 0.02
    attempt=$((attempt + 1))
  done
  echo "third job never occupied the slot released by the fast job" >&2
  return 1
}

fast_second_job() {
  return 0
}

third_job() {
  : >"$TEST_ROOT/third-started"
}

run_shell_test_functions_parallel \
  2 \
  slow_first_job \
  fast_second_job \
  third_job

failing_job() {
  echo "intentional failure" >&2
  return 7
}

passing_job() {
  return 0
}

failure_output="$TEST_ROOT/failure.log"
if run_shell_test_functions_parallel 2 failing_job passing_job >"$failure_output" 2>&1; then
  echo "parallel helper did not aggregate a child failure" >&2
  exit 1
fi
grep -Fq "FAIL: failing_job" "$failure_output" \
  || {
    echo "parallel helper did not identify the failing child" >&2
    cat "$failure_output" >&2
    exit 1
  }

echo "PASS: completion-driven shell queue"
