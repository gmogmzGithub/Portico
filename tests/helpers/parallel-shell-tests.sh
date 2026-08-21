#!/usr/bin/env bash

# Run independent, zero-argument shell test functions with bounded concurrency.
# The caller keeps ownership of any EXIT cleanup trap and shared fixture root.
run_shell_test_functions_parallel() {
  local concurrency="$1"
  shift
  local test_functions=("$@")

  if ! [[ "$concurrency" =~ ^[0-9]+$ ]] || [ "$concurrency" -lt 1 ]; then
    printf 'Invalid shell test concurrency: %s\n' "$concurrency" >&2
    return 1
  fi

  local output_dir
  output_dir="$(mktemp -d "${TMPDIR:-/tmp}/portico-shell-test-functions.XXXXXX")"
  local pids=()
  local logs=()
  local durations=()
  local completion_files=()
  local statuses=()
  local active_indices=()
  local active_count=0
  local test_function=""
  local test_log=""
  local duration_file=""
  local completion_file=""
  local test_index=0
  local active_position=0
  local completed_index=0
  local completed_status=0
  local found_completion=0

  while [ "$test_index" -lt "${#test_functions[@]}" ] \
    || [ "$active_count" -gt 0 ]; do
    while [ "$test_index" -lt "${#test_functions[@]}" ] \
      && [ "$active_count" -lt "$concurrency" ]; do
      test_function="${test_functions[$test_index]}"
      test_log="$output_dir/$test_index.log"
      duration_file="$output_dir/$test_index.duration"
      completion_file="$output_dir/$test_index.status"
      (
        trap - EXIT
        set +e
        test_started_at="$SECONDS"
        "$test_function"
        test_status=$?
        if [ "${SHELL_TEST_TIMINGS:-0}" = "1" ]; then
          printf '%s\n' "$((SECONDS - test_started_at))" >"$duration_file"
        fi
        printf '%s\n' "$test_status" >"$completion_file"
        exit "$test_status"
      ) >"$test_log" 2>&1 &
      pids[$test_index]="$!"
      logs[$test_index]="$test_log"
      durations[$test_index]="$duration_file"
      completion_files[$test_index]="$completion_file"
      active_indices+=("$test_index")
      active_count=$((active_count + 1))
      test_index=$((test_index + 1))
    done

    [ "$active_count" -gt 0 ] || continue

    found_completion=0
    while [ "$found_completion" -eq 0 ]; do
      for active_position in "${!active_indices[@]}"; do
        completed_index="${active_indices[$active_position]}"
        [ -n "$completed_index" ] || continue
        if [ -f "${completion_files[$completed_index]}" ] \
          || ! kill -0 "${pids[$completed_index]}" 2>/dev/null; then
          if wait "${pids[$completed_index]}"; then
            completed_status=0
          else
            completed_status=$?
          fi
          statuses[$completed_index]="$completed_status"
          active_indices[$active_position]=""
          active_count=$((active_count - 1))
          found_completion=1
          break
        fi
      done
      [ "$found_completion" -eq 1 ] || sleep 0.02
    done
  done

  local status=0
  local index=0
  for index in "${!pids[@]}"; do
    if [ "${statuses[$index]}" -ne 0 ]; then
      printf 'FAIL: %s\n' "${test_functions[$index]}" >&2
      cat "${logs[$index]}" >&2
      status=1
    fi
    if [ "${SHELL_TEST_TIMINGS:-0}" = "1" ] && [ -f "${durations[$index]}" ]; then
      printf '%s: %ss\n' \
        "${test_functions[$index]}" \
        "$(cat "${durations[$index]}")"
    fi
  done

  rm -rf "$output_dir"
  return "$status"
}
