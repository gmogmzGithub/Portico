import importlib.util
from pathlib import Path
import sys
import types


def _load_runner_module():
    source_path = (
        Path(__file__).resolve().parents[1]
        / "src"
        / "scripts"
        / "run_subagents_parallel_chat_consistency.py"
    )
    spec = importlib.util.spec_from_file_location(
        "run_subagents_parallel_chat_consistency", source_path
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None

    previous_runner = sys.modules.get("run_google_workspace_chat_consistency")
    fake_runner = types.SimpleNamespace(
        MODEL="Atlas Sonnet 4.6",
        OWUIClient=object,
        _detect_openwebui_base_url=lambda: "http://unused",
        _restart_counts=lambda: {},
    )
    sys.modules["run_google_workspace_chat_consistency"] = fake_runner
    try:
        spec.loader.exec_module(module)
    finally:
        if previous_runner is None:
            sys.modules.pop("run_google_workspace_chat_consistency", None)
        else:
            sys.modules["run_google_workspace_chat_consistency"] = previous_runner
    return module


def test_continent_parser_accepts_assigned_wording():
    module = _load_runner_module()

    assert (
        module._continent_from_subagent_prompt(
            "You are assigned to AFRICA. Choose 5 countries and write poems."
        )
        == "AFRICA"
    )
    assert (
        module._continent_from_subagent_prompt(
            "You are assigned to OCEANIA. Choose 5 countries and write poems."
        )
        == "OCEANIA/AUSTRALIA"
    )


def test_continent_parser_accepts_existing_specialist_wording():
    module = _load_runner_module()

    assert (
        module._continent_from_subagent_prompt(
            "You are the Antarctica continent specialist. Choose 5 places and write poems."
        )
        == "ANTARCTICA"
    )


def test_continent_parser_accepts_poetry_specialist_and_agent_wording():
    module = _load_runner_module()

    assert (
        module._continent_from_subagent_prompt(
            "You are the Africa poetry specialist. Choose 5 countries and write poems."
        )
        == "AFRICA"
    )
    assert (
        module._continent_from_subagent_prompt(
            "You are the Antarctica poetry agent. Write poems about Antarctic features."
        )
        == "ANTARCTICA"
    )
