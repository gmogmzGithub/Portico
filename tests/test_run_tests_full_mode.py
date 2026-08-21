from pathlib import Path
import subprocess


REPO_ROOT = Path(__file__).resolve().parents[1]
RUNNER = REPO_ROOT / "run-tests.sh"
PROTECTED_ENV_HELPER = REPO_ROOT / "src" / "scripts" / "protected-repository-env.sh"


def _run_list_command(*args: str) -> str:
    result = subprocess.run(
        ["bash", str(RUNNER), "--list", *args],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout


def test_run_tests_default_mode_advertises_subset_and_default_exclusions():
    output = _run_list_command()

    assert "Mode: SMOKE default gate" in output
    assert "Canonical close-out command: ./run-tests.sh" in output
    assert "Broader validation command: ./run-tests.sh --extended" in output
    assert "Heaviest validation command: ./run-tests.sh --full" in output
    assert "Rust smoke commands:" in output
    assert (
        "cargo test --manifest-path src/core-mcp-rust/Cargo.toml --workspace --test stdio_smoke"
        in output
    )
    assert (
        "cargo test --manifest-path src/core-mcp-rust/Cargo.toml -p agent-vm-server --lib"
        in output
    )
    assert "tests/test_agent_vm_image_resolve.sh" in output
    assert "Node/Electron unit tests:" in output
    assert "electron-app/src/services/screen-oauth.unit.test.js" in output
    for gpt_56_node_test in (
        "electron-app/src/services/agent-reasoning-options.unit.test.js",
        "tests/gpt-56-pricing-parity.unit.test.js",
        "tests/model-config-generator-drift.unit.test.js",
        "tests/subagent-model-catalog-references.unit.test.js",
    ):
        assert output.count(gpt_56_node_test) == 1
    assert "Python smoke tests:" in output
    assert "tests/test_internal_gateway_config.py" in output
    assert "tests/test_oauth_tool_server_helpers.py" in output
    assert "tests/test_tasks_router.py" in output
    data_platform_pacing_test = (
        "tests/test_skills_and_context_regressions.py::"
        "test_data_platform_skill_requires_data_plat_mcp_and_documents_async_query_discipline"
    )
    assert output.count(data_platform_pacing_test) == 1
    for gpt_56_python_test in (
        "tests/test_active_gpt_model_guidance.py",
        "tests/test_bifrost_prompt_caching_script.py",
        "tests/test_chat_state_api.py",
        "tests/test_event_publisher_storage.py",
        "tests/test_gpt_56_qualification_runner.py",
        "tests/test_mcp_runtime_headers.py",
        "tests/test_model_reconcile_lease.py",
        "tests/test_ultra_multi_agent_signing.py",
        "tests/test_ultra_tool_executor.py",
        "tests/test_ultra_private_middleware.py",
    ):
        assert output.count(gpt_56_python_test) == 1
    assert "Shell smoke tests:" in output
    assert "src/scripts/host-mcp-binary-policy.test.sh" in output
    assert "src/scripts/test-setup-wizard-system-bash.sh" in output
    for update_pipeline_test in (
        "tests/test_apply_prepared_update.sh",
        "tests/test_prepare_update_cloudsmith.sh",
        "tests/test_prereq_download.sh",
        "tests/test_reset_portico_installation.sh",
    ):
        assert output.count(update_pipeline_test) == 1
    for snapshot_repair_test in (
        "tests/test_snapshot_image_repair.sh",
        "tests/test_snapshot_store_compose_recovery.sh",
    ):
        assert output.count(snapshot_repair_test) == 1
    assert "Excluded by smoke default:" in output
    assert "src/scripts/test-single-server-callback-routing.sh" in output
    assert "electron-app/package.json:test (Playwright/full app)" in output
    assert "tests/integration/* (full stack integration harness)" in output


def test_run_tests_extended_mode_lists_broader_suite_and_extended_exclusions():
    output = _run_list_command("--extended")

    assert "Mode: EXTENDED broader validation" in output
    assert "Canonical close-out command: ./run-tests.sh" in output
    assert "Broader validation command: ./run-tests.sh --extended" in output
    assert "Heaviest validation command: ./run-tests.sh --full" in output
    assert "Rust manifests:" in output
    assert "src/mcp-orc-rust/Cargo.toml (--workspace)" in output
    assert "Small integration tests:" in output
    assert "src/scripts/test-single-server-callback-routing.sh" in output
    assert "Headless OWUI chat integration tests:" in output
    assert (
        "src/scripts/run_google_workspace_chat_consistency.py --noninteractive --runs 1 --max-attempts 1"
        in output
    )
    assert "src/scripts/run_code_execution_followup_chat_consistency.py --runs 1 --max-attempts 1" in output
    assert "src/scripts/run_calibration_skill_activation_chat_consistency.py --runs 1 --max-attempts 1" in output
    assert "src/scripts/run_atlassian_steer_chat_consistency.py --runs 1 --max-attempts 1" in output
    assert "src/scripts/run_marketplace_provenance_chat_consistency.py --runs 1 --max-attempts 1" in output
    assert "src/scripts/run_gpt_56_qualification.py --include-ultra" in output
    assert (
        "src/scripts/run_opus_48_reasoning_chat_consistency.py --efforts xhigh --max-attempts-per-effort 1"
        in output
    )
    assert (
        "src/scripts/run_opus_48_prompt_cache_chat_consistency.py --scenarios no-tools --models 'Claude Opus 4.8'"
        in output
    )
    assert "src/scripts/run_gemini_vertex_chat_consistency.py --runs 1 --max-attempts 1" in output
    assert "Excluded by extended default:" in output
    assert "electron-app/package.json:test (Playwright/full app)" in output
    assert "tests/integration/* (full stack integration harness)" in output


def test_run_tests_full_mode_lists_full_suite_and_no_default_exclusions():
    output = _run_list_command("--full")

    assert "Mode: FULL comprehensive validation" in output
    assert "Canonical close-out command: ./run-tests.sh" in output
    assert "Broader validation command: ./run-tests.sh --extended" in output
    assert "Heaviest validation command: ./run-tests.sh --full" in output
    assert "Playwright/full Electron app" in output
    assert "Full stack integration" in output
    assert "Headless OWUI chat integration" in output
    assert "Headless OWUI chat integration tests:" in output
    assert "electron-app/package.json:test" in output
    assert "tests/integration/run_tests.sh" in output
    assert "src/scripts/run_calibration_skill_activation_chat_consistency.py --runs 1 --max-attempts 1" in output
    assert "src/scripts/run_atlassian_steer_chat_consistency.py --runs 1 --max-attempts 1" in output
    assert "src/scripts/run_marketplace_provenance_chat_consistency.py --runs 1 --max-attempts 1" in output
    assert "src/scripts/run_gpt_56_qualification.py --include-ultra" in output
    assert (
        "src/scripts/run_opus_48_reasoning_chat_consistency.py --efforts xhigh --max-attempts-per-effort 1"
        in output
    )
    assert (
        "src/scripts/run_opus_48_prompt_cache_chat_consistency.py --scenarios no-tools --models 'Claude Opus 4.8'"
        in output
    )
    assert "src/scripts/run_gemini_vertex_chat_consistency.py --runs 1 --max-attempts 1" in output
    assert "llm-debug-monitor/backend/tests/test_event_store.py" in output
    assert "Excluded in full mode:" in output
    assert "  - none" in output


def test_run_tests_resolves_a_working_python3_instead_of_using_the_raw_shim():
    source = RUNNER.read_text()

    assert "resolve_python3_bin()" in source
    assert '--python "$PYTHON_BIN"' in source
    assert 'PYTEST_RUNNER=("$PYTHON_BIN" -m pytest --rootdir "$ROOT_DIR")' in source
    assert 'Missing required working command: python3' in source


def test_run_tests_smoke_shell_guard_preserves_generated_mcp_topology():
    source = RUNNER.read_text()

    assert "snapshot_generated_topology()" in source
    assert "run_shell_test_with_topology_guard" in source
    assert "docker-compose.override.yml" in source
    assert ".mcp-config-hash" in source
    assert "mcpo-configs-generated" in source
    assert "gitlab-mcp mcp-n8n sourcegraph" in source
    assert "Smoke shell test mutated generated MCP topology" in source


def test_run_tests_restores_and_fails_on_repository_dotenv_mutation():
    source = RUNNER.read_text()

    assert "protect_repository_env()" in source
    assert "restore_repository_env()" in source
    assert 'cp -p "$repo_env" "$REPO_ENV_GUARD_DIR/repo.env"' in source
    assert 'cp -p "$backup_env" "$repo_env"' in source
    assert "Test suite mutated repository .env; restored the original file byte-for-byte" in source
    assert "portico_repository_cloudsmith_assignment_changed" in source
    assert "preserving the current file and refusing to overwrite it" in source
    assert "trap finish_repository_env_guard EXIT" in source


def test_repository_dotenv_guard_never_rolls_back_a_cloudsmith_key_added_mid_run(tmp_path):
    snapshot = tmp_path / "snapshot.env"
    current = tmp_path / "current.env"
    work_dir = tmp_path / "guard"
    snapshot.write_text("HARBOR_TOKEN=harbor-test-token\n")
    current.write_text(
        "HARBOR_TOKEN=harbor-test-token\n"
        "CLOUDSMITH_API_KEY=protected-test-token\n"
    )

    result = subprocess.run(
        [
            "bash",
            "-c",
            'source "$1"; portico_repository_cloudsmith_assignment_changed "$2" "$3" "$4"',
            "_",
            str(PROTECTED_ENV_HELPER),
            str(current),
            str(snapshot),
            str(work_dir),
        ],
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0
    assert result.stdout == ""
    assert result.stderr == ""
    assert "CLOUDSMITH_API_KEY=protected-test-token" in current.read_text()


def test_repository_dotenv_guard_treats_commented_blank_cloudsmith_assignment_as_missing(tmp_path):
    snapshot = tmp_path / "snapshot.env"
    current = tmp_path / "current.env"
    work_dir = tmp_path / "guard"
    snapshot.write_text("CLOUDSMITH_API_KEY=existing-test-token\n")
    current.write_text(
        "CLOUDSMITH_API_KEY=existing-test-token\n"
        'CLOUDSMITH_API_KEY="" # blank wins\n'
    )

    result = subprocess.run(
        [
            "bash",
            "-c",
            'source "$1"; portico_repository_cloudsmith_assignment_changed "$2" "$3" "$4"',
            "_",
            str(PROTECTED_ENV_HELPER),
            str(current),
            str(snapshot),
            str(work_dir),
        ],
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert result.stdout == ""
    assert result.stderr == ""
