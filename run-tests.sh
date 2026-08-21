#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

# shellcheck source=src/scripts/protected-repository-env.sh
source "$ROOT_DIR/src/scripts/protected-repository-env.sh"

RUN_RUST_WAS_SET="${RUN_RUST+x}"
RUN_NODE_WAS_SET="${RUN_NODE+x}"
RUN_PYTHON_WAS_SET="${RUN_PYTHON+x}"
RUN_SHELL_WAS_SET="${RUN_SHELL+x}"
RUN_SMALL_INTEGRATION_WAS_SET="${RUN_SMALL_INTEGRATION+x}"
RUN_HEADLESS_CHAT_INTEGRATION_WAS_SET="${RUN_HEADLESS_CHAT_INTEGRATION+x}"
RUN_PLAYWRIGHT_WAS_SET="${RUN_PLAYWRIGHT+x}"
RUN_FULL_STACK_INTEGRATION_WAS_SET="${RUN_FULL_STACK_INTEGRATION+x}"

RUN_RUST="${RUN_RUST:-1}"
RUN_NODE="${RUN_NODE:-1}"
RUN_PYTHON="${RUN_PYTHON:-1}"
RUN_SHELL="${RUN_SHELL:-1}"
RUN_SMALL_INTEGRATION="${RUN_SMALL_INTEGRATION:-1}"
RUN_HEADLESS_CHAT_INTEGRATION="${RUN_HEADLESS_CHAT_INTEGRATION:-0}"
RUN_PLAYWRIGHT="${RUN_PLAYWRIGHT:-0}"
RUN_FULL_STACK_INTEGRATION="${RUN_FULL_STACK_INTEGRATION:-0}"
RUN_FULL="${RUN_FULL:-0}"
LIST_ONLY="${LIST_ONLY:-0}"
NODE_TEST_BATCH_SIZE="${NODE_TEST_BATCH_SIZE:-12}"
NODE_TEST_CONCURRENCY="${NODE_TEST_CONCURRENCY:-}"
SMOKE_PARALLEL="${SMOKE_PARALLEL:-1}"
SHELL_TEST_CONCURRENCY="${SHELL_TEST_CONCURRENCY:-5}"
RUN_MODE="smoke"

SMALL_INTEGRATION_TESTS=(
  "src/scripts/test-single-server-callback-routing.sh"
  "src/scripts/test-rust-openapi-aggregator-e2e.sh"
  "src/scripts/test-rust-core-mcp-e2e.sh"
)

HEADLESS_CHAT_INTEGRATION_COMMANDS=(
  "uv run --with httpx src/scripts/run_google_workspace_chat_consistency.py --noninteractive --runs 1 --max-attempts 1"
  "uv run --with httpx src/scripts/run_code_execution_followup_chat_consistency.py --runs 1 --max-attempts 1"
  "uv run --with httpx src/scripts/run_calibration_skill_activation_chat_consistency.py --runs 1 --max-attempts 1"
  "uv run --with httpx src/scripts/run_atlassian_steer_chat_consistency.py --runs 1 --max-attempts 1"
  "uv run --with httpx src/scripts/run_marketplace_provenance_chat_consistency.py --runs 1 --max-attempts 1"
  "uv run --with httpx src/scripts/run_gpt_56_qualification.py --include-ultra"
  "uv run --with httpx src/scripts/run_opus_5_reasoning_chat_consistency.py --max-attempts-per-effort 1"
  "uv run --with httpx src/scripts/run_opus_48_reasoning_chat_consistency.py --efforts xhigh --max-attempts-per-effort 1"
  "uv run --with httpx src/scripts/run_opus_48_prompt_cache_chat_consistency.py --scenarios no-tools --models 'Claude Opus 4.8'"
  "uv run --with httpx src/scripts/run_gemini_vertex_chat_consistency.py --runs 1 --max-attempts 1"
)

SMOKE_RUST_COMMANDS=(
  "cargo test --manifest-path src/core-mcp-rust/Cargo.toml --workspace --test stdio_smoke"
  "cargo test --manifest-path src/core-mcp-rust/Cargo.toml -p agent-vm-server --lib"
  "cargo test --manifest-path src/mcp-orc-rust/Cargo.toml -p health-check"
)

SMOKE_PYTHON_TESTS=(
  "tests/test_run_tests_full_mode.py"
  "tests/tokenomics/test_report_schema.py"
  "tests/test_skills_and_context_regressions.py::test_data_platform_skill_requires_data_plat_mcp_and_documents_async_query_discipline"
  "tests/test_skills_and_context_regressions.py::test_skill_management_covers_git_install_and_environment"
  "tests/test_skills_and_context_regressions.py::test_base_prompt_inoculates_against_claude_code_cli"
  "tests/test_active_gpt_model_guidance.py"
  "tests/test_bifrost_prompt_caching_script.py"
  "tests/test_internal_gateway_config.py"
  "tests/test_chat_search_security.py"
  "tests/test_chat_model_id_persistence.py"
  "tests/test_chat_hydration.py"
  "tests/test_chat_state_api.py"
  "tests/test_delegated_event_mirroring.py"
  "tests/test_event_publisher_storage.py"
  "tests/test_gpt_56_qualification_runner.py"
  "tests/test_portico_auth_migration.py"
  "tests/test_portico_managed_functions.py"
  "tests/test_model_reconcile_lease.py"
  "tests/test_mcp_runtime_headers.py"
  "tests/test_oauth_tool_server_helpers.py"
  "tests/test_scheduled_tasks_router.py"
  "tests/test_snowflake_setup_script.py"
  "tests/test_sqlite_recovery.py"
  "tests/test_subagent_child_chat_access.py"
  "tests/test_tasks_router.py"
  "tests/test_ultra_multi_agent_signing.py"
  "tests/test_ultra_tool_executor.py"
  "tests/test_ultra_private_middleware.py"
)

SMOKE_SHELL_TESTS=(
  # Source-script regressions.
  "src/scripts/host-mcp-binary-policy.test.sh"
  "src/scripts/test-host-mcp-runtime-resolution.sh"
  "src/scripts/test-run-health-check-container-control.sh"
  "src/scripts/test-docker-managed-node-preparer.sh"
  "src/scripts/test-install-host-mode-deps.sh"
  "src/scripts/test-prereq-payload-cache.sh"
  "src/scripts/test-portico-docker-cleanup.sh"
  "src/scripts/test-migrate-buildkit-gc-policy.sh"
  "src/scripts/test-portico-build-layer-reuse-report.sh"
  "src/scripts/test-portico-dockerfile-labels.sh"
  "src/scripts/test-openwebui-slim-split.sh"
  "src/scripts/test-setup-wizard-system-bash.sh"
  "src/scripts/test-single-server-runtime-files.sh"
  "src/scripts/test-single-server-disabled-tools-defaults.sh"
  "src/scripts/test-single-server-oauth-bootstrap.sh"
  "src/scripts/test-compose-frontend-resolution.sh"
  "src/scripts/test-docker-compose-stale-mcpo-cleanup.sh"
  "src/scripts/test-docker-compose-port-conflict-recovery.sh"
  "src/scripts/test-docker-compose-packaged-up-container-guard.sh"
  "src/scripts/test-check-containers-ready-compose-up-marker.sh"

  # Repository-level regressions.
  "tests/test_agent_vm_image_resolve.sh"
  "tests/test_managed_runtime_agent_vm_image.sh"
  "tests/test_managed_runtime_integrity.sh"
  "tests/test_mcp_orc_preparer_image_tag.sh"
  "tests/test_mcp_toggles_self_heal.sh"
  "tests/test_apply_prepared_update.sh"
  "tests/test_debug_log_collection.sh"
  "tests/test_prepare_update_cloudsmith.sh"
  "tests/test_prereq_download.sh"
  "tests/test_capture_single_server.sh"
  "tests/test_docker_socket_proxy_config.sh"
  "tests/test_docker_compose_runtime_secrets.sh"
  "tests/test_snapshot_image_repair.sh"
  "tests/test_snapshot_store_compose_recovery.sh"
  "tests/test_security_audit.sh"
  "tests/test_mark_cloudsmith_release_eol.sh"
  "tests/test_bootstrap.sh"
  "tests/test_release_build.sh"
  "tests/test_reset_portico_installation.sh"
  "tests/test_run_dev_release.sh"
  "tests/test_gitlab_release_ci.sh"
  "tests/test_portico_service_release_upload.sh"
  "tests/test_optimization_flags_runtime_mount.sh"
  "tests/test_parallel_shell_tests.sh"
)

SMOKE_EXCLUDED_TESTS=(
  "src/mcp-orc-rust/Cargo.toml (--workspace broader Rust suite)"
  "src/bifrost-bridge-rust/Cargo.toml (broader Rust crate suite)"
  "src/scripts/test-single-server-callback-routing.sh (Docker-backed small integration)"
  "src/scripts/test-rust-openapi-aggregator-e2e.sh (Docker-backed small integration)"
  "src/scripts/test-rust-core-mcp-e2e.sh (Docker-backed small integration)"
  "electron-app/package.json:test (Playwright/full app)"
  "tests/integration/* (full stack integration harness)"
)

EXTENDED_EXCLUDED_TESTS=(
  "electron-app/package.json:test (Playwright/full app)"
  "tests/integration/* (full stack integration harness)"
  "src/scripts/test-bifrost-prompt-caching.sh (requires live gateway service)"
  "src/scripts/test-rust-glean-oauth-e2e.sh (requires pre-existing OAuth tokens)"
  "src/scripts/test-rust-google-workspace-oauth-e2e.sh (requires pre-existing OAuth tokens)"
  "src/scripts/test-rust-dynamic-oauth-discovery-e2e.sh (OAuth e2e; excluded from extended suite)"
)

NODE_TEST_FILES=()
PYTEST_FILES=()
FAST_SHELL_TESTS=()

usage() {
  cat <<'EOF'
Usage: ./run-tests.sh [options]

Runs the canonical smoke close-out suite intended to finish quickly. Use
`--extended` for the broader validation suite that used to be the default, and
use `--full` for the heaviest validation suite.

Options:
  --extended              Run the broader validation suite
  --full                  Run the heaviest full-repo validation suite
  --list                  Print the selected test inventory and exit
  --no-rust               Skip Rust tests
  --no-node               Skip Node/Electron tests
  --no-python             Skip Python tests
  --no-shell              Skip shell-based tests
  --no-small-integration  Skip Docker-backed small integration tests
  -h, --help              Show this help text

Environment toggles:
  RUN_RUST=0
  RUN_NODE=0
  RUN_PYTHON=0
  RUN_SHELL=0
  RUN_SMALL_INTEGRATION=0
  RUN_HEADLESS_CHAT_INTEGRATION=0
  RUN_PLAYWRIGHT=1
  RUN_FULL_STACK_INTEGRATION=1
  RUN_FULL=1  # Legacy alias for full mode
  LIST_ONLY=1
  SMOKE_PARALLEL=0  # Debug the smoke categories serially
  SHELL_TEST_CONCURRENCY=5
EOF
}

requested_mode=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --extended)
      if [[ -n "$requested_mode" && "$requested_mode" != "extended" ]]; then
        echo "Cannot combine --extended and --full" >&2
        exit 1
      fi
      requested_mode="extended"
      ;;
    --full)
      if [[ -n "$requested_mode" && "$requested_mode" != "full" ]]; then
        echo "Cannot combine --extended and --full" >&2
        exit 1
      fi
      requested_mode="full"
      ;;
    --list)
      LIST_ONLY=1
      ;;
    --no-rust)
      RUN_RUST=0
      ;;
    --no-node)
      RUN_NODE=0
      ;;
    --no-python)
      RUN_PYTHON=0
      ;;
    --no-shell)
      RUN_SHELL=0
      ;;
    --no-small-integration)
      RUN_SMALL_INTEGRATION=0
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 1
  fi
}

PYTEST_RUNNER=()
PYTHON_TEST_PATH=""
PYTHON_BIN=""

resolve_python3_bin() {
  local candidates=()
  local candidate=""

  if command -v python3 >/dev/null 2>&1; then
    candidates+=("$(command -v python3)")
  fi

  for candidate in /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
    if [[ -x "$candidate" ]]; then
      candidates+=("$candidate")
    fi
  done

  for candidate in "${candidates[@]}"; do
    if "$candidate" -c 'import sys; print(sys.executable)' >/dev/null 2>&1; then
      PYTHON_BIN="$candidate"
      return 0
    fi
  done

  return 1
}

set_if_unset() {
  local var_name="$1"
  local value="$2"
  local was_set="$3"

  if [[ -z "$was_set" ]]; then
    printf -v "$var_name" '%s' "$value"
  fi
}

select_run_mode() {
  if [[ -n "$requested_mode" ]]; then
    RUN_MODE="$requested_mode"
  elif [[ "$RUN_FULL" == "1" ]]; then
    RUN_MODE="full"
  else
    RUN_MODE="smoke"
  fi

  if [[ "$RUN_MODE" == "full" ]]; then
    RUN_FULL=1
  else
    RUN_FULL=0
  fi
}

apply_mode_defaults() {
  case "$RUN_MODE" in
    smoke)
      set_if_unset RUN_RUST 1 "$RUN_RUST_WAS_SET"
      set_if_unset RUN_NODE 1 "$RUN_NODE_WAS_SET"
      set_if_unset RUN_PYTHON 1 "$RUN_PYTHON_WAS_SET"
      set_if_unset RUN_SHELL 1 "$RUN_SHELL_WAS_SET"
      set_if_unset RUN_SMALL_INTEGRATION 0 "$RUN_SMALL_INTEGRATION_WAS_SET"
      set_if_unset RUN_HEADLESS_CHAT_INTEGRATION 0 "$RUN_HEADLESS_CHAT_INTEGRATION_WAS_SET"
      set_if_unset RUN_PLAYWRIGHT 0 "$RUN_PLAYWRIGHT_WAS_SET"
      set_if_unset RUN_FULL_STACK_INTEGRATION 0 "$RUN_FULL_STACK_INTEGRATION_WAS_SET"
      ;;
    extended)
      set_if_unset RUN_RUST 1 "$RUN_RUST_WAS_SET"
      set_if_unset RUN_NODE 1 "$RUN_NODE_WAS_SET"
      set_if_unset RUN_PYTHON 1 "$RUN_PYTHON_WAS_SET"
      set_if_unset RUN_SHELL 1 "$RUN_SHELL_WAS_SET"
      set_if_unset RUN_SMALL_INTEGRATION 1 "$RUN_SMALL_INTEGRATION_WAS_SET"
      set_if_unset RUN_HEADLESS_CHAT_INTEGRATION 1 "$RUN_HEADLESS_CHAT_INTEGRATION_WAS_SET"
      set_if_unset RUN_PLAYWRIGHT 0 "$RUN_PLAYWRIGHT_WAS_SET"
      set_if_unset RUN_FULL_STACK_INTEGRATION 0 "$RUN_FULL_STACK_INTEGRATION_WAS_SET"
      ;;
    full)
      set_if_unset RUN_RUST 1 "$RUN_RUST_WAS_SET"
      set_if_unset RUN_NODE 1 "$RUN_NODE_WAS_SET"
      set_if_unset RUN_PYTHON 1 "$RUN_PYTHON_WAS_SET"
      set_if_unset RUN_SHELL 1 "$RUN_SHELL_WAS_SET"
      set_if_unset RUN_SMALL_INTEGRATION 0 "$RUN_SMALL_INTEGRATION_WAS_SET"
      set_if_unset RUN_HEADLESS_CHAT_INTEGRATION 1 "$RUN_HEADLESS_CHAT_INTEGRATION_WAS_SET"
      set_if_unset RUN_PLAYWRIGHT 1 "$RUN_PLAYWRIGHT_WAS_SET"
      set_if_unset RUN_FULL_STACK_INTEGRATION 1 "$RUN_FULL_STACK_INTEGRATION_WAS_SET"
      ;;
    *)
      echo "Unknown run mode: $RUN_MODE" >&2
      exit 1
      ;;
  esac
}

discover_node_tests() {
  if [[ "$RUN_MODE" == "smoke" ]]; then
    NODE_TEST_FILES=()
    while IFS= read -r test_file; do
      NODE_TEST_FILES+=("$test_file")
    done < <(
      find \
        "$ROOT_DIR/electron-app/src" \
        "$ROOT_DIR/electron-app/tests" \
        "$ROOT_DIR/tests" \
        -type f \
        \( -name '*.unit.test.js' -o -name '*.unit.test.mjs' \) \
        -not -path '*/node_modules/*' \
        -not -path '*/.venv/*' \
        -not -path '*/release/*' \
        -not -path '*/workspaces/*' \
        | sed "s|^$ROOT_DIR/||" \
        | sort
    )
    return
  fi

  NODE_TEST_FILES=()
  while IFS= read -r test_file; do
    NODE_TEST_FILES+=("$test_file")
  done < <(
    find \
      "$ROOT_DIR/electron-app/src" \
      "$ROOT_DIR/electron-app/tests" \
      "$ROOT_DIR/tests" \
      -type f \
      \( \
        -name '*.test.js' -o \
        -name '*.test.mjs' -o \
        -name '*.unit.test.js' -o \
        -name '*.unit.test.mjs' -o \
        -name 'test_*.cjs' \
      \) \
      -not -path '*/node_modules/*' \
      -not -path '*/.venv/*' \
      -not -path '*/release/*' \
      -not -path '*/workspaces/*' \
      | sed "s|^$ROOT_DIR/||" \
      | sort
  )
}

discover_python_tests() {
  if [[ "$RUN_MODE" == "smoke" ]]; then
    PYTEST_FILES=("${SMOKE_PYTHON_TESTS[@]}")
    return
  fi

  local python_search_roots=(
    "$ROOT_DIR/tests"
    "$ROOT_DIR/src"
  )
  if [[ -d "$ROOT_DIR/spikes" ]]; then
    python_search_roots+=("$ROOT_DIR/spikes")
  fi

  PYTEST_FILES=()
  while IFS= read -r test_file; do
    PYTEST_FILES+=("$test_file")
  done < <(
    {
      find \
        "${python_search_roots[@]}" \
        -type f \
        \( -name 'test_*.py' -o -name '*_test.py' \) \
        -not -path '*/.venv/*' \
        -not -path '*/node_modules/*' \
        -not -path '*/__pycache__/*' \
        -not -path '*/release/*' \
        -not -path '*/workspaces/*' \
        -not -path "$ROOT_DIR/tests/integration/*"
      printf '%s\n' "$ROOT_DIR/skills-marketplace/anthropic-agent-skills/pdf/scripts/check_bounding_boxes_test.py"
      if [[ "$RUN_MODE" == "full" ]]; then
        printf '%s\n' "$ROOT_DIR/llm-debug-monitor/backend/tests/test_event_store.py"
      fi
    } \
      | sed "s|^$ROOT_DIR/||" \
      | sort -u
  )
}

discover_shell_tests() {
  if [[ "$RUN_MODE" == "smoke" ]]; then
    FAST_SHELL_TESTS=("${SMOKE_SHELL_TESTS[@]}")
    return
  fi

  if [[ "$RUN_MODE" == "full" ]]; then
    FAST_SHELL_TESTS=()
    while IFS= read -r test_file; do
      FAST_SHELL_TESTS+=("$test_file")
    done < <(
      {
        find "$ROOT_DIR/src/scripts" -type f \( -name 'test*.sh' -o -name 'test_*.sh' \)
        find "$ROOT_DIR/tests" -type f \( -name 'test*.sh' -o -name 'test_*.sh' \)
        find "$ROOT_DIR" -maxdepth 1 -type f \( -name 'test*.sh' -o -name 'test_*.sh' \)
      } | sed "s|^$ROOT_DIR/||" | sort -u
    )
    return
  fi

  FAST_SHELL_TESTS=()
  while IFS= read -r test_file; do
    FAST_SHELL_TESTS+=("$test_file")
  done < <(
    {
      find "$ROOT_DIR/src/scripts" -type f -name '*.sh'
      find "$ROOT_DIR/tests" -type f -name '*.sh'
      find "$ROOT_DIR" -maxdepth 1 -type f -name '*.sh'
    } | sed "s|^$ROOT_DIR/||" \
      | grep -E '^(test_orbstack_safety\.sh|tests/test_(package_for_release|prepare_update_cloudsmith|release_build|portico_service_release_upload|sync_ootb_marketplaces)\.sh|src/scripts/.*test.*\.sh)$' \
      | grep -v '^src/scripts/test-bifrost-prompt-caching.sh$' \
      | grep -v '^src/scripts/test-rust-glean-oauth-e2e.sh$' \
      | grep -v '^src/scripts/test-rust-google-workspace-oauth-e2e.sh$' \
      | grep -v '^src/scripts/test-rust-dynamic-oauth-discovery-e2e.sh$' \
      | grep -v '^src/scripts/test-single-server-callback-routing.sh$' \
      | grep -v '^src/scripts/test-rust-openapi-aggregator-e2e.sh$' \
      | grep -v '^src/scripts/test-rust-core-mcp-e2e.sh$' \
      | sort
  )
}

require_pytest() {
  if [[ -z "$PYTHON_BIN" ]]; then
    if ! resolve_python3_bin; then
      echo "pytest is required but no working python3 interpreter was found" >&2
      exit 1
    fi
  fi

  PYTHON_TEST_PATH="$ROOT_DIR/src/patches/backend:$ROOT_DIR/llm-debug-monitor"
  if [[ -n "${PYTHONPATH:-}" ]]; then
    PYTHON_TEST_PATH="$PYTHON_TEST_PATH:$PYTHONPATH"
  fi

  if command -v uv >/dev/null 2>&1; then
    PYTEST_RUNNER=(
      uv run
      --python "$PYTHON_BIN"
      --with pytest
      --with pytest-asyncio
      --with docker
      --with pypdf
      --with-requirements "$ROOT_DIR/requirements-open-webui-slim.txt"
      python -m pytest
      --rootdir "$ROOT_DIR"
    )
    return
  fi

  if "$PYTHON_BIN" -m pytest --version >/dev/null 2>&1; then
    PYTEST_RUNNER=("$PYTHON_BIN" -m pytest --rootdir "$ROOT_DIR")
    return
  fi

  echo "pytest is required but not available via uv or python3" >&2
  exit 1
}

run_step() {
  local label="$1"
  shift

  echo
  echo "==> $label"
  local start_ts
  start_ts="$(date +%s)"
  "$@"
  local end_ts
  end_ts="$(date +%s)"
  echo "<== $label ($((end_ts - start_ts))s)"
}

hash_generated_topology_file() {
  local file="$1"

  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
    return 0
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
    return 0
  fi

  cksum "$file" | awk '{print $1 ":" $2}'
}

REPO_ENV_GUARD_DIR=""
REPO_ENV_GUARD_STATE="missing"

protect_repository_env() {
  local repo_env="$ROOT_DIR/.env"

  REPO_ENV_GUARD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/portico-run-tests-env.XXXXXX")"
  chmod 700 "$REPO_ENV_GUARD_DIR"

  if [[ -f "$repo_env" ]]; then
    cp -p "$repo_env" "$REPO_ENV_GUARD_DIR/repo.env"
    chmod 600 "$REPO_ENV_GUARD_DIR/repo.env"
    REPO_ENV_GUARD_STATE="file"
  elif [[ -e "$repo_env" ]]; then
    echo "Repository .env must be a regular file before running tests" >&2
    rm -rf "$REPO_ENV_GUARD_DIR"
    REPO_ENV_GUARD_DIR=""
    return 1
  fi
}

restore_repository_env() {
  local repo_env="$ROOT_DIR/.env"
  local backup_env="$REPO_ENV_GUARD_DIR/repo.env"
  local mutated=0
  local protected_assignment_changed=0

  [[ -n "$REPO_ENV_GUARD_DIR" ]] || return 0

  if portico_repository_cloudsmith_assignment_changed \
    "$repo_env" \
    "$backup_env" \
    "$REPO_ENV_GUARD_DIR/protected-key-check"; then
    protected_assignment_changed=1
    mutated=1
  elif [[ "$REPO_ENV_GUARD_STATE" == "file" ]]; then
    if [[ ! -f "$repo_env" ]] || ! cmp -s "$backup_env" "$repo_env"; then
      mutated=1
      cp -p "$backup_env" "$repo_env"
      chmod 600 "$repo_env"
    fi
  elif [[ -e "$repo_env" ]]; then
    mutated=1
    rm -f "$repo_env"
  fi

  rm -rf "$REPO_ENV_GUARD_DIR"
  REPO_ENV_GUARD_DIR=""

  if [[ "$protected_assignment_changed" -ne 0 ]]; then
    echo "Repository .env CLOUDSMITH_API_KEY changed while tests ran; preserving the current file and refusing to overwrite it" >&2
    return 1
  fi

  if [[ "$mutated" -ne 0 ]]; then
    echo "Test suite mutated repository .env; restored the original file byte-for-byte" >&2
    return 1
  fi
}

finish_repository_env_guard() {
  local test_status=$?
  local guard_status=0

  trap - EXIT
  restore_repository_env || guard_status=$?
  if [[ "$test_status" -ne 0 ]]; then
    exit "$test_status"
  fi
  exit "$guard_status"
}

snapshot_generated_topology() {
  local output_file="$1"
  local rel_path=""
  local abs_path=""

  : >"$output_file"

  for rel_path in \
    "docker-compose.override.yml" \
    ".mcp-config-hash"; do
    abs_path="$ROOT_DIR/$rel_path"
    if [[ -f "$abs_path" ]]; then
      printf 'file %s %s\n' "$rel_path" "$(hash_generated_topology_file "$abs_path")" >>"$output_file"
    elif [[ -e "$abs_path" ]]; then
      printf 'nonfile %s\n' "$rel_path" >>"$output_file"
    else
      printf 'missing %s\n' "$rel_path" >>"$output_file"
    fi
  done

  if [[ -d "$ROOT_DIR/mcpo-configs-generated" ]]; then
    while IFS= read -r abs_path; do
      rel_path="${abs_path#$ROOT_DIR/}"
      printf 'file %s %s\n' "$rel_path" "$(hash_generated_topology_file "$abs_path")" >>"$output_file"
    done < <(find "$ROOT_DIR/mcpo-configs-generated" -type f ! -name '.tmp.*' | LC_ALL=C sort)
  else
    printf 'missing mcpo-configs-generated\n' >>"$output_file"
  fi
}

generated_routes_have_server() {
  local server_id="$1"
  local routes_file="$ROOT_DIR/mcpo-configs-generated/server-routing.json"

  [[ -f "$routes_file" ]] || return 1
  grep -Fq "\"$server_id\"" "$routes_file"
}

sensitive_server_is_live_tool_ready() {
  local server_id="$1"
  local payload=""

  command -v curl >/dev/null 2>&1 || return 1
  payload="$(curl -fsS --max-time 1 "http://localhost:9876/api/server-readiness/$server_id" 2>/dev/null || true)"
  [[ "$payload" == *'"healthy":true'* ]] || return 1
  [[ "$payload" == *'"readiness_phase":"tool_ready"'* ]] || return 1
}

snapshot_live_sensitive_routes() {
  local output_file="$1"
  local server_id=""

  : >"$output_file"
  for server_id in gitlab-mcp mcp-n8n sourcegraph n8n-community-mcp; do
    if sensitive_server_is_live_tool_ready "$server_id" && generated_routes_have_server "$server_id"; then
      printf '%s\n' "$server_id" >>"$output_file"
    fi
  done
}

assert_live_sensitive_routes_still_present() {
  local before_file="$1"
  local server_id=""
  local missing=0

  while IFS= read -r server_id; do
    [[ -n "$server_id" ]] || continue
    if ! generated_routes_have_server "$server_id"; then
      echo "Smoke shell test dropped live sensitive MCP route from generated topology: $server_id" >&2
      missing=1
    fi
  done <"$before_file"

  return "$missing"
}

run_shell_test_with_topology_guard() {
  local test_script="$1"

  if [[ "$RUN_MODE" != "smoke" ]]; then
    bash "$ROOT_DIR/$test_script"
    return
  fi

  local before_snapshot after_snapshot before_sensitive_routes
  before_snapshot="$(mktemp)"
  after_snapshot="$(mktemp)"
  before_sensitive_routes="$(mktemp)"

  snapshot_generated_topology "$before_snapshot"
  snapshot_live_sensitive_routes "$before_sensitive_routes"

  local test_status=0
  bash "$ROOT_DIR/$test_script" || test_status=$?

  snapshot_generated_topology "$after_snapshot"

  if [[ "$test_status" -ne 0 ]]; then
    rm -f "$before_snapshot" "$after_snapshot" "$before_sensitive_routes"
    return "$test_status"
  fi

  if ! cmp -s "$before_snapshot" "$after_snapshot"; then
    echo "Smoke shell test mutated generated MCP topology: $test_script" >&2
    diff -u "$before_snapshot" "$after_snapshot" >&2 || true
    rm -f "$before_snapshot" "$after_snapshot" "$before_sensitive_routes"
    return 1
  fi

  if ! assert_live_sensitive_routes_still_present "$before_sensitive_routes"; then
    rm -f "$before_snapshot" "$after_snapshot" "$before_sensitive_routes"
    return 1
  fi

  rm -f "$before_snapshot" "$after_snapshot" "$before_sensitive_routes"
}

run_node_tests() {
  local total="${#NODE_TEST_FILES[@]}"
  if [[ "$total" -eq 0 ]]; then
    echo "No Node/Electron tests discovered."
    return
  fi

  if ! [[ "$NODE_TEST_BATCH_SIZE" =~ ^[0-9]+$ ]] || (( NODE_TEST_BATCH_SIZE < 1 )); then
    echo "NODE_TEST_BATCH_SIZE must be a positive integer, got: $NODE_TEST_BATCH_SIZE" >&2
    exit 1
  fi

  local total_batches=$(( (total + NODE_TEST_BATCH_SIZE - 1) / NODE_TEST_BATCH_SIZE ))
  local batch_index=0
  local start=0
  while (( start < total )); do
    local end=$(( start + NODE_TEST_BATCH_SIZE ))
    if (( end > total )); then
      end=$total
    fi
    local count=$(( end - start ))
    local batch=("${NODE_TEST_FILES[@]:start:count}")
    batch_index=$(( batch_index + 1 ))

    local node_cmd=()
    # Node 20.19's test-runner parent can wedge CPU-bound while ingesting a
    # huge failing-assertion diagnostic (a batch normally finishes in seconds;
    # job 219411331 sat SILENT in one batch until the 1h CI timeout). Cap each
    # batch so a wedge fails loudly in minutes with the output so far. SIGTERM
    # cannot be serviced while the runner spins in native code, so escalate to
    # SIGKILL. GNU timeout only (CI images have coreutils; stock macOS lacks
    # `timeout` and skips the guard).
    if command -v timeout >/dev/null 2>&1; then
      node_cmd+=(timeout --kill-after=30 900)
    fi
    node_cmd+=(node --test --test-force-exit)
    if [[ -n "$NODE_TEST_CONCURRENCY" ]]; then
      node_cmd+=("--test-concurrency=$NODE_TEST_CONCURRENCY")
    fi
    node_cmd+=("${batch[@]}")

    run_step \
      "Node/Electron tests batch ${batch_index}/${total_batches} (${start}..$((end - 1)))" \
      "${node_cmd[@]}"

    start=$end
  done
}

run_rust_tests() {
  if [[ "$RUN_MODE" == "smoke" ]]; then
    # Execute every recorded smoke command (the same list shown in list mode),
    # not just stdio_smoke — this is how agent-vm-server --lib runs in smoke.
    for rust_smoke_command in "${SMOKE_RUST_COMMANDS[@]}"; do
      # Entries are simple space-separated tokens; split them into argv.
      read -r -a rust_smoke_argv <<<"$rust_smoke_command"
      run_step "Rust smoke tests: $rust_smoke_command" "${rust_smoke_argv[@]}"
    done
  else
    run_step "Rust workspace tests: src/mcp-orc-rust" \
      cargo test --manifest-path src/mcp-orc-rust/Cargo.toml --workspace
    run_step "Rust workspace tests: src/core-mcp-rust" \
      cargo test --manifest-path src/core-mcp-rust/Cargo.toml --workspace
    run_step "Rust crate tests: src/bifrost-bridge-rust" \
      cargo test --manifest-path src/bifrost-bridge-rust/Cargo.toml
  fi
}

run_python_tests() {
  if [[ "$RUN_MODE" == "smoke" ]]; then
    run_step "Python smoke tests" \
      env PYTHONPATH="$PYTHON_TEST_PATH" "${PYTEST_RUNNER[@]}" "${PYTEST_FILES[@]}"
  else
    run_step "Python tests" \
      env PYTHONPATH="$PYTHON_TEST_PATH" "${PYTEST_RUNNER[@]}" "${PYTEST_FILES[@]}"
    run_step "Python tests: skills-marketplace PDF bounding boxes" \
      bash -c "cd \"\$1\" && PYTHONPATH=\"\$2\" \"\${@:3}\" check_bounding_boxes_test.py" _ \
        "$ROOT_DIR/skills-marketplace/anthropic-agent-skills/pdf/scripts" \
        "$PYTHON_TEST_PATH" \
        "${PYTEST_RUNNER[@]}"
  fi
}

run_shell_tests_serial() {
  local test_script=""
  for test_script in "${FAST_SHELL_TESTS[@]}"; do
    run_step "Shell test: $(basename "$test_script")" \
      run_shell_test_with_topology_guard "$test_script"
  done
}

run_shell_tests_parallel() {
  if ! [[ "$SHELL_TEST_CONCURRENCY" =~ ^[0-9]+$ ]] || (( SHELL_TEST_CONCURRENCY < 1 )); then
    echo "SHELL_TEST_CONCURRENCY must be a positive integer, got: $SHELL_TEST_CONCURRENCY" >&2
    return 1
  fi

  local output_dir
  output_dir="$(mktemp -d "${TMPDIR:-/tmp}/portico-run-tests-shell.XXXXXX")"
  local pids=()
  local logs=()
  local completion_files=()
  local statuses=()
  local active_indices=()
  local active_count=0
  local test_script=""
  local output_file=""
  local completion_file=""
  local test_index=0
  local active_position=0
  local completed_index=0
  local completed_status=0
  local found_completion=0

  while (( test_index < ${#FAST_SHELL_TESTS[@]} || active_count > 0 )); do
    while (( test_index < ${#FAST_SHELL_TESTS[@]} \
      && active_count < SHELL_TEST_CONCURRENCY )); do
      test_script="${FAST_SHELL_TESTS[$test_index]}"
      output_file="$output_dir/$test_index.log"
      completion_file="$output_dir/$test_index.status"
      (
        trap - EXIT
        set +e
        run_step "Shell test: $(basename "$test_script")" \
          run_shell_test_with_topology_guard "$test_script"
        test_status=$?
        printf '%s\n' "$test_status" >"$completion_file"
        exit "$test_status"
      ) >"$output_file" 2>&1 &
      pids[$test_index]="$!"
      logs[$test_index]="$output_file"
      completion_files[$test_index]="$completion_file"
      active_indices+=("$test_index")
      active_count=$((active_count + 1))
      test_index=$((test_index + 1))
    done

    (( active_count > 0 )) || continue

    found_completion=0
    while (( found_completion == 0 )); do
      for active_position in "${!active_indices[@]}"; do
        completed_index="${active_indices[$active_position]}"
        [[ -n "$completed_index" ]] || continue
        if [[ -f "${completion_files[$completed_index]}" ]] \
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
      (( found_completion == 1 )) || sleep 0.02
    done
  done

  local status=0
  local index=0
  for index in "${!pids[@]}"; do
    if (( statuses[index] != 0 )); then
      status=1
    fi
    cat "${logs[$index]}"
  done
  rm -rf "$output_dir"
  return "$status"
}

run_shell_tests() {
  if [[ "$RUN_MODE" == "smoke" && "$SHELL_TEST_CONCURRENCY" != "1" ]]; then
    run_shell_tests_parallel
  else
    run_shell_tests_serial
  fi
}

run_primary_categories_serial() {
  [[ "$RUN_RUST" != "1" ]] || run_rust_tests
  [[ "$RUN_NODE" != "1" ]] || run_node_tests
  [[ "$RUN_PYTHON" != "1" ]] || run_python_tests
  [[ "$RUN_SHELL" != "1" ]] || run_shell_tests
}

run_primary_categories_parallel() {
  local output_dir
  output_dir="$(mktemp -d "${TMPDIR:-/tmp}/portico-run-tests-categories.XXXXXX")"
  local pids=()
  local labels=()
  local logs=()
  local output_file=""

  if [[ "$RUN_RUST" == "1" ]]; then
    output_file="$output_dir/rust.log"
    (trap - EXIT; run_rust_tests) >"$output_file" 2>&1 &
    pids+=("$!")
    labels+=("Rust")
    logs+=("$output_file")
  fi
  if [[ "$RUN_NODE" == "1" ]]; then
    output_file="$output_dir/node.log"
    (trap - EXIT; run_node_tests) >"$output_file" 2>&1 &
    pids+=("$!")
    labels+=("Node/Electron")
    logs+=("$output_file")
  fi
  if [[ "$RUN_PYTHON" == "1" ]]; then
    output_file="$output_dir/python.log"
    (trap - EXIT; run_python_tests) >"$output_file" 2>&1 &
    pids+=("$!")
    labels+=("Python")
    logs+=("$output_file")
  fi
  if [[ "$RUN_SHELL" == "1" ]]; then
    output_file="$output_dir/shell.log"
    (trap - EXIT; run_shell_tests) >"$output_file" 2>&1 &
    pids+=("$!")
    labels+=("Shell")
    logs+=("$output_file")
  fi

  local status=0
  local index=0
  for index in "${!pids[@]}"; do
    if ! wait "${pids[$index]}"; then
      status=1
    fi
    echo
    echo "---- ${labels[$index]} results ----"
    cat "${logs[$index]}"
  done
  rm -rf "$output_dir"
  return "$status"
}

print_test_list() {
  local heading="$1"
  shift
  local entries=("$@")

  echo "$heading:"
  if [[ "${#entries[@]}" -eq 0 ]]; then
    echo "  - none"
    return
  fi

  local entry
  for entry in "${entries[@]}"; do
    echo "  - $entry"
  done
}

print_banner() {
  discover_node_tests
  discover_python_tests
  discover_shell_tests

  echo "========================================"
  echo "Portico Test Runner"
  echo "Repo: $ROOT_DIR"
  echo "========================================"
  case "$RUN_MODE" in
    smoke)
      echo "Mode: SMOKE default gate"
      ;;
    extended)
      echo "Mode: EXTENDED broader validation"
      ;;
    full)
      echo "Mode: FULL comprehensive validation"
      ;;
  esac
  echo "Canonical close-out command: ./run-tests.sh"
  echo "Broader validation command: ./run-tests.sh --extended"
  echo "Heaviest validation command: ./run-tests.sh --full"
  echo
  echo "Selected categories:"
  [[ "$RUN_RUST" == "1" ]] && echo "  - Rust"
  [[ "$RUN_NODE" == "1" ]] && echo "  - Node/Electron"
  [[ "$RUN_PYTHON" == "1" ]] && echo "  - Python"
  [[ "$RUN_SHELL" == "1" ]] && echo "  - Shell"
  [[ "$RUN_PLAYWRIGHT" == "1" ]] && echo "  - Playwright/full Electron app"
  [[ "$RUN_FULL_STACK_INTEGRATION" == "1" ]] && echo "  - Full stack integration"
  [[ "$RUN_SMALL_INTEGRATION" == "1" ]] && echo "  - Small integration"
  [[ "$RUN_HEADLESS_CHAT_INTEGRATION" == "1" ]] && echo "  - Headless OWUI chat integration"
  echo

  if [[ "$RUN_RUST" == "1" ]]; then
    if [[ "$RUN_MODE" == "smoke" ]]; then
      print_test_list "Rust smoke commands" "${SMOKE_RUST_COMMANDS[@]}"
    else
      print_test_list "Rust manifests" \
        "src/mcp-orc-rust/Cargo.toml (--workspace)" \
        "src/core-mcp-rust/Cargo.toml (--workspace)" \
        "src/bifrost-bridge-rust/Cargo.toml"
    fi
    echo
  fi

  if [[ "$RUN_NODE" == "1" ]]; then
    if [[ "$RUN_MODE" == "smoke" ]]; then
      print_test_list "Node/Electron unit tests" "${NODE_TEST_FILES[@]}"
    else
      print_test_list "Node/Electron tests" "${NODE_TEST_FILES[@]}"
    fi
    echo
  fi

  if [[ "$RUN_PYTHON" == "1" ]]; then
    if [[ "$RUN_MODE" == "smoke" ]]; then
      print_test_list "Python smoke tests" "${PYTEST_FILES[@]}"
    else
      print_test_list "Python tests" "${PYTEST_FILES[@]}"
    fi
    echo
  fi

  if [[ "$RUN_SHELL" == "1" ]]; then
    if [[ "$RUN_MODE" == "smoke" ]]; then
      print_test_list "Shell smoke tests" "${FAST_SHELL_TESTS[@]}"
    else
      print_test_list "Shell tests" "${FAST_SHELL_TESTS[@]}"
    fi
    echo
  fi

  if [[ "$RUN_SMALL_INTEGRATION" == "1" ]]; then
    print_test_list "Small integration tests" "${SMALL_INTEGRATION_TESTS[@]}"
    echo
  fi

  if [[ "$RUN_HEADLESS_CHAT_INTEGRATION" == "1" ]]; then
    print_test_list "Headless OWUI chat integration tests" "${HEADLESS_CHAT_INTEGRATION_COMMANDS[@]}"
    echo
  fi

  if [[ "$RUN_PLAYWRIGHT" == "1" ]]; then
    print_test_list "Playwright/full Electron app suite" \
      "electron-app/package.json:test"
    echo
  fi

  if [[ "$RUN_FULL_STACK_INTEGRATION" == "1" ]]; then
    print_test_list "Full stack integration suite" \
      "tests/integration/run_tests.sh"
    echo
  fi

  if [[ "$RUN_MODE" == "full" ]]; then
    print_test_list "Excluded in full mode" "none"
  elif [[ "$RUN_MODE" == "extended" ]]; then
    print_test_list "Excluded by extended default" "${EXTENDED_EXCLUDED_TESTS[@]}"
  else
    print_test_list "Excluded by smoke default" "${SMOKE_EXCLUDED_TESTS[@]}"
  fi
}

select_run_mode
apply_mode_defaults
print_banner

if [[ "$LIST_ONLY" == "1" ]]; then
  exit 0
fi

protect_repository_env
trap finish_repository_env_guard EXIT

if [[ "$RUN_RUST" == "1" ]]; then
  require_command cargo
fi

if [[ "$RUN_NODE" == "1" ]]; then
  require_command node
fi

if [[ "$RUN_PYTHON" == "1" ]]; then
  if ! resolve_python3_bin; then
    echo "Missing required working command: python3" >&2
    exit 1
  fi
  require_pytest
fi

if [[ "$RUN_SHELL" == "1" ]]; then
  require_command bash
fi

if [[ "$RUN_MODE" == "smoke" && "$SMOKE_PARALLEL" == "1" ]]; then
  run_primary_categories_parallel
else
  run_primary_categories_serial
fi

if [[ "$RUN_SMALL_INTEGRATION" == "1" ]]; then
  require_command docker
  require_command curl
  require_command jq
  docker info >/dev/null 2>&1

  for test_script in "${SMALL_INTEGRATION_TESTS[@]}"; do
    run_step "Small integration: $(basename "$test_script")" \
      bash "$ROOT_DIR/$test_script"
  done
fi

if [[ "$RUN_HEADLESS_CHAT_INTEGRATION" == "1" ]]; then
  require_command uv
  require_command python3
  require_command docker
  require_command curl
  docker info >/dev/null 2>&1

  for runner_cmd in "${HEADLESS_CHAT_INTEGRATION_COMMANDS[@]}"; do
    run_step "Headless OWUI chat integration: ${runner_cmd#uv run --with httpx src/scripts/}" \
      bash -lc "cd \"$ROOT_DIR\" && $runner_cmd"
  done
fi

if [[ "$RUN_PLAYWRIGHT" == "1" ]]; then
  require_command npm
  run_step "Playwright/full Electron app tests" \
    bash -lc "cd \"$ROOT_DIR/electron-app\" && npm test"
fi

if [[ "$RUN_FULL_STACK_INTEGRATION" == "1" ]]; then
  require_command bash
  require_command uv
  require_command curl
  require_command claude
  run_step "Full stack integration suite" \
    bash "$ROOT_DIR/tests/integration/run_tests.sh"
fi

echo
echo "All selected tests passed."
