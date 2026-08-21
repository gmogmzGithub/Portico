#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SYSTEM_BASH="/bin/bash"
SYSTEM_BASH_PATH="/bin:/usr/bin:${PATH}"
# shellcheck source=tests/helpers/parallel-shell-tests.sh
source "$ROOT_DIR/tests/helpers/parallel-shell-tests.sh"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

run_under_system_bash() {
  env PATH="$SYSTEM_BASH_PATH" "$SYSTEM_BASH" "$@"
}

run_checked_system_bash_script() {
  local rel_path="$1"
  local output=""

  if ! output="$(run_under_system_bash "$ROOT_DIR/$rel_path" 2>&1)"; then
    printf '%s\n' "$output" >&2
    fail "$rel_path failed under $SYSTEM_BASH"
  fi
}

test_setup_wizard_scripts_parse_under_system_bash() {
  local rel_path=""
  local scripts=(
    "src/scripts/prereq-download.sh"
    "src/scripts/prereq-dependencies.sh"
    "src/scripts/prereq-docker-setup.sh"
    "src/scripts/prereq-host-mode.sh"
    "electron-app/src/scripts/apply-prepared-update.sh"
    "src/scripts/managed-runtime-reconcile.sh"
    "src/scripts/managed-runtime-integrity.sh"
    "src/scripts/mcp-orc-cli.sh"
  )

  for rel_path in "${scripts[@]}"; do
    run_under_system_bash -n "$ROOT_DIR/$rel_path" \
      || fail "expected $rel_path to parse under $SYSTEM_BASH"
  done
}

test_sourceable_setup_helpers_load_under_system_bash() {
  local output=""

  if ! output="$(
    env PATH="$SYSTEM_BASH_PATH" REPO_ROOT="$ROOT_DIR" "$SYSTEM_BASH" -c '
      set -euo pipefail
      source "$REPO_ROOT/src/scripts/managed-runtime-reconcile.sh"
      source "$REPO_ROOT/src/scripts/managed-runtime-integrity.sh"
      source "$REPO_ROOT/src/scripts/mcp-orc-cli.sh"
      declare -F managed_runtime_reconcile_payload >/dev/null
      declare -F managed_runtime_self_heal_packaged_runtime >/dev/null
      declare -F run_mcp_orc_generator >/dev/null
      echo helpers-ok
    ' 2>&1
  )"; then
    fail "expected setup wizard helpers to source under $SYSTEM_BASH, saw: $output"
  fi

  [ "$output" = "helpers-ok" ] \
    || fail "expected helper source smoke test to print helpers-ok, saw: $output"
}

test_prereq_host_mode_skips_checks_for_basic_setup_under_system_bash() {
  local tmp_dir output host_mode_file
  tmp_dir="$(mktemp -d)"
  mkdir -p "$tmp_dir/project" "$tmp_dir/home"
  host_mode_file="$tmp_dir/project/HOST_MODE"

  if ! output="$(
    env \
      HOME="$tmp_dir/home" \
      GUIDED_SETUP_SKIP_HOST_MODE_CHECK=true \
      PATH="$SYSTEM_BASH_PATH" \
      "$SYSTEM_BASH" "$ROOT_DIR/src/scripts/prereq-host-mode.sh" "$tmp_dir/project" 2>&1
  )"; then
    fail "expected prereq-host-mode basic setup path to succeed under $SYSTEM_BASH, saw: $output"
  fi

  [ -f "$host_mode_file" ] || fail "expected prereq-host-mode to write HOST_MODE for basic setup"
  [ "$(cat "$host_mode_file")" = "FALSE" ] \
    || fail "expected basic setup to force HOST_MODE=FALSE"
  printf '%s' "$output" | grep -q '\[PREREQ:STEP:check_nodejs:SKIPPED\]' \
    || fail "expected basic setup to skip the Node.js check"
  printf '%s' "$output" | grep -q '\[PREREQ:STEP:check_npm:SKIPPED\]' \
    || fail "expected basic setup to skip the npm check"
  printf '%s' "$output" | grep -q '\[PREREQ:HOST_MODE:FALSE\]' \
    || fail "expected basic setup to emit HOST_MODE FALSE"
}

test_prereq_host_mode_enables_host_mode_when_requirements_are_met_under_system_bash() {
  local tmp_dir fake_bin output host_mode_file
  tmp_dir="$(mktemp -d)"
  fake_bin="$tmp_dir/bin"
  mkdir -p "$tmp_dir/project" "$tmp_dir/home" "$fake_bin"
  host_mode_file="$tmp_dir/project/HOST_MODE"

  cat > "$fake_bin/node" <<'EOF'
#!/bin/sh
printf 'v20.19.1\n'
EOF
  cat > "$fake_bin/npm" <<'EOF'
#!/bin/sh
exit 0
EOF
  chmod +x "$fake_bin/node" "$fake_bin/npm"

  if ! output="$(
    env \
      HOME="$tmp_dir/home" \
      PATH="$fake_bin:$SYSTEM_BASH_PATH" \
      "$SYSTEM_BASH" "$ROOT_DIR/src/scripts/prereq-host-mode.sh" "$tmp_dir/project" 2>&1
  )"; then
    fail "expected prereq-host-mode success path to exit 0 under $SYSTEM_BASH, saw: $output"
  fi

  [ -f "$host_mode_file" ] || fail "expected prereq-host-mode to write HOST_MODE for supported host mode"
  [ "$(cat "$host_mode_file")" = "TRUE" ] \
    || fail "expected host mode support check to write HOST_MODE=TRUE"
  printf '%s' "$output" | grep -q '\[PREREQ:STEP:check_nodejs:COMPLETE\]' \
    || fail "expected supported host mode to complete the Node.js step"
  printf '%s' "$output" | grep -q '\[PREREQ:STEP:check_npm:COMPLETE\]' \
    || fail "expected supported host mode to complete the npm step"
  printf '%s' "$output" | grep -q '\[PREREQ:HOST_MODE:TRUE\]' \
	    || fail "expected supported host mode to emit HOST_MODE TRUE"
}

test_prereq_host_mode_prefers_nvm_over_legacy_managed_root_under_system_bash() {
  local tmp_dir nvm_bin managed_bin output host_mode_file
  tmp_dir="$(mktemp -d)"
  nvm_bin="$tmp_dir/home/.nvm/versions/node/v999.1.0/bin"
  managed_bin="$tmp_dir/usr-local/lib/nodejs/node-v999.0.0-darwin-arm64/bin"
  mkdir -p "$tmp_dir/project" "$nvm_bin" "$managed_bin"
  host_mode_file="$tmp_dir/project/HOST_MODE"

  cat > "$nvm_bin/node" <<'EOF'
#!/bin/sh
printf 'v999.1.0\n'
EOF
  cat > "$managed_bin/node" <<'EOF'
#!/bin/sh
printf 'v999.0.0\n'
EOF
  cat > "$nvm_bin/npm" <<'EOF'
#!/bin/sh
exit 0
EOF
  cat > "$managed_bin/npm" <<'EOF'
#!/bin/sh
exit 0
EOF
  chmod +x "$nvm_bin/node" "$managed_bin/node" "$nvm_bin/npm" "$managed_bin/npm"

  if ! output="$(
    env \
      HOME="$tmp_dir/home" \
      HOST_NODE_INSTALL_ROOTS="$tmp_dir/usr-local/lib/nodejs" \
      NVM_DIR="$tmp_dir/home/.nvm" \
      NODE_VERSION_REQUIRED=999.0.0 \
      PATH="$SYSTEM_BASH_PATH" \
      "$SYSTEM_BASH" "$ROOT_DIR/src/scripts/prereq-host-mode.sh" "$tmp_dir/project" 2>&1
  )"; then
    fail "expected prereq-host-mode nvm precedence path to exit 0 under $SYSTEM_BASH, saw: $output"
  fi

  [ -f "$host_mode_file" ] || fail "expected prereq-host-mode to write HOST_MODE for supported nvm host mode"
  [ "$(cat "$host_mode_file")" = "TRUE" ] \
    || fail "expected nvm host mode support check to write HOST_MODE=TRUE"
  printf '%s' "$output" | grep -Fq "Node.js location: $nvm_bin/node" \
    || fail "expected prereq-host-mode to prefer nvm Node over legacy managed root, saw: $output"
}

test_prereq_host_mode_disables_host_mode_for_old_node_under_system_bash() {
  local tmp_dir fake_bin output host_mode_file
  tmp_dir="$(mktemp -d)"
  fake_bin="$tmp_dir/bin"
  mkdir -p "$tmp_dir/project" "$tmp_dir/home" "$fake_bin"
  host_mode_file="$tmp_dir/project/HOST_MODE"
  cat > "$fake_bin/npm" <<'EOF'
#!/bin/sh
exit 0
EOF
  chmod +x "$fake_bin/npm"

  if ! output="$(
    env \
      HOME="$tmp_dir/home" \
      NODE_VERSION_REQUIRED=999.0.0 \
      PATH="$fake_bin:$SYSTEM_BASH_PATH" \
      "$SYSTEM_BASH" "$ROOT_DIR/src/scripts/prereq-host-mode.sh" "$tmp_dir/project" 2>&1
  )"; then
    fail "expected prereq-host-mode old-node path to still exit 0 under $SYSTEM_BASH, saw: $output"
  fi

  [ -f "$host_mode_file" ] || fail "expected prereq-host-mode to write HOST_MODE for unsupported host mode"
  [ "$(cat "$host_mode_file")" = "FALSE" ] \
    || fail "expected an unmet Node.js requirement to force HOST_MODE=FALSE"
  printf '%s' "$output" | grep -q '\[PREREQ:STEP:check_nodejs:FAILED\]' \
    || fail "expected an unmet Node.js requirement to fail the Node.js step"
  printf '%s' "$output" | grep -q '\[PREREQ:STEP:check_npm:COMPLETE\]' \
    || fail "expected the npm step to keep passing when only Node.js is unsupported"
  printf '%s' "$output" | grep -q '\[PREREQ:HOST_MODE:FALSE\]' \
    || fail "expected unsupported host mode to emit HOST_MODE FALSE"
}

test_existing_setup_wizard_shell_coverage_passes_under_system_bash() {
  local rel_path=""
  local scripts=(
    "tests/test_apply_prepared_update.sh"
    "tests/test_prereq_download.sh"
    "tests/test_prereq_dependencies.sh"
    "tests/test_prereq_docker_setup.sh"
    "tests/test_managed_runtime_integrity.sh"
    "src/scripts/test-start-mcpo-docker-image-refresh.sh"
    "src/scripts/test-generate-docker-compose-stable-config-dir.sh"
    "src/scripts/test-generate-docker-compose-locking.sh"
    "src/scripts/test-docker-compose-config.sh"
    "src/scripts/test-mcpo-nginx-config.sh"
  )

  local compatibility_concurrency="${SYSTEM_BASH_TEST_CONCURRENCY:-}"
  if [ -z "$compatibility_concurrency" ]; then
    if [ -n "${CI:-}" ]; then
      compatibility_concurrency=1
    else
      compatibility_concurrency=5
    fi
  fi
  if ! [[ "$compatibility_concurrency" =~ ^[0-9]+$ ]] \
    || [ "$compatibility_concurrency" -lt 1 ]; then
    fail "SYSTEM_BASH_TEST_CONCURRENCY must be a positive integer"
  fi

  if [ "$compatibility_concurrency" -gt 1 ]; then
    local generator_bootstrap_output=""
    if ! generator_bootstrap_output="$(
      run_under_system_bash -c '
        set -euo pipefail
        repo_root="$1"
        source "$repo_root/src/scripts/mcp-orc-generator-test-lib.sh"
        mcp_orc_test_resolve_generator_binary "$repo_root" >/dev/null
      ' _ "$ROOT_DIR" 2>&1
    )"; then
      printf '%s\n' "$generator_bootstrap_output" >&2
      fail "expected the mcp-orc generator binary to bootstrap before parallel compatibility tests"
    fi
  fi

  local output_dir
  output_dir="$(mktemp -d "${TMPDIR:-/tmp}/portico-system-bash-coverage.XXXXXX")"
  local pids=()
  local logs=()
  local output_file=""
  local running_jobs=0

  for rel_path in "${scripts[@]}"; do
    while :; do
      running_jobs="$(jobs -pr | wc -l | tr -d '[:space:]')"
      [ "$running_jobs" -lt "$compatibility_concurrency" ] && break
      sleep 0.05
    done
    output_file="$output_dir/${#pids[@]}.log"
    run_checked_system_bash_script "$rel_path" >"$output_file" 2>&1 &
    pids+=("$!")
    logs+=("$output_file")
  done

  local status=0
  local index=0
  for index in "${!pids[@]}"; do
    if ! wait "${pids[$index]}"; then
      printf 'FAIL: system Bash coverage: %s\n' "${scripts[$index]}" >&2
      cat "${logs[$index]}" >&2
      status=1
    fi
  done
  rm -rf "$output_dir"
  [ "$status" -eq 0 ] || return "$status"
}

setup_wizard_test_functions=(
  test_setup_wizard_scripts_parse_under_system_bash
  test_sourceable_setup_helpers_load_under_system_bash
  test_prereq_host_mode_skips_checks_for_basic_setup_under_system_bash
  test_prereq_host_mode_enables_host_mode_when_requirements_are_met_under_system_bash
  test_prereq_host_mode_prefers_nvm_over_legacy_managed_root_under_system_bash
  test_prereq_host_mode_disables_host_mode_for_old_node_under_system_bash
  test_existing_setup_wizard_shell_coverage_passes_under_system_bash
)
run_shell_test_functions_parallel \
  "${SETUP_WIZARD_TEST_CONCURRENCY:-7}" \
  "${setup_wizard_test_functions[@]}"

echo "PASS: setup wizard system bash compatibility tests"
