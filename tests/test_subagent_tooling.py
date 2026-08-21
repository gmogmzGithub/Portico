from pathlib import Path
import importlib.util


REPO_ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = (
    REPO_ROOT
    / "src"
    / "patches"
    / "backend"
    / "open_webui"
    / "utils"
    / "subagent_tooling.py"
)


spec = importlib.util.spec_from_file_location("subagent_tooling", MODULE_PATH)
subagent_tooling = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(subagent_tooling)

maybe_add_code_execution_to_subagent = (
    subagent_tooling.maybe_add_code_execution_to_subagent
)


def test_maybe_add_code_execution_to_subagent_adds_skill_and_agent_vm():
    skill_ids, tool_server_ids, changed = maybe_add_code_execution_to_subagent(
        skill_ids=["company-knowledge"],
        tool_server_ids=["server:glean"],
    )

    assert changed is True
    assert "code-execution" in skill_ids
    assert "server:agent-vm" in tool_server_ids


def test_maybe_add_code_execution_to_subagent_preserves_existing_entries():
    skill_ids, tool_server_ids, changed = maybe_add_code_execution_to_subagent(
        skill_ids=["company-knowledge", "code-execution"],
        tool_server_ids=["server:glean", "server:agent-vm"],
    )

    assert changed is False
    assert skill_ids == ["company-knowledge", "code-execution"]
    assert tool_server_ids == ["server:glean", "server:agent-vm"]


def test_maybe_add_code_execution_to_subagent_coerces_json_string_lists():
    skill_ids, tool_server_ids, changed = maybe_add_code_execution_to_subagent(
        skill_ids='["slack"]',
        tool_server_ids='["server:slack"]',
    )

    assert changed is True
    assert skill_ids == ["slack", "code-execution"]
    assert tool_server_ids == ["server:slack", "server:agent-vm"]


def test_maybe_add_code_execution_to_subagent_treats_scalar_strings_as_single_ids():
    skill_ids, tool_server_ids, changed = maybe_add_code_execution_to_subagent(
        skill_ids="company-knowledge",
        tool_server_ids="server:glean",
    )

    assert changed is True
    assert skill_ids == ["company-knowledge", "code-execution"]
    assert tool_server_ids == ["server:glean", "server:agent-vm"]


def test_active_runtime_and_skill_files_do_not_define_subagent_retrieval_budget_policy():
    forbidden_terms = [
        "delegated_subagent_" + "retrieval_budget_exceeded",
        "subagent_external_" + "retrieval_budget_guard",
        "subagent_external_" + "retrieval_limit",
    ]
    active_paths = [
        REPO_ROOT / "optimization_flags.json",
        REPO_ROOT / "skills",
        REPO_ROOT / "src" / "patches" / "backend" / "open_webui" / "utils",
    ]

    offenders: list[str] = []
    for active_path in active_paths:
        files = [active_path] if active_path.is_file() else active_path.rglob("*")
        for path in files:
            if not path.is_file():
                continue
            if path.suffix not in {".json", ".md", ".py"}:
                continue
            text = path.read_text(encoding="utf-8", errors="ignore")
            for term in forbidden_terms:
                if term in text:
                    offenders.append(str(path.relative_to(REPO_ROOT)))

    assert offenders == []
