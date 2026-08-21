from pathlib import Path
import importlib.util


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "src"
    / "patches"
    / "backend"
    / "open_webui"
    / "utils"
    / "system_prompt_merge.py"
)


spec = importlib.util.spec_from_file_location("system_prompt_merge", MODULE_PATH)
system_prompt_merge = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(system_prompt_merge)

merge_model_and_request_system_prompt = (
    system_prompt_merge.merge_model_and_request_system_prompt
)


def test_merge_model_and_request_system_prompt_preserves_request_specific_text():
    merged = merge_model_and_request_system_prompt(
        "Base system prompt",
        [{"role": "system", "content": "Delegated subagent instructions"}],
    )

    assert "Base system prompt" in merged
    assert "Request-Specific System Instructions" in merged
    assert "Delegated subagent instructions" in merged


def test_merge_model_and_request_system_prompt_avoids_duplicate_when_included():
    merged = merge_model_and_request_system_prompt(
        "Base system prompt\n\nDelegated subagent instructions",
        [{"role": "system", "content": "Delegated subagent instructions"}],
    )

    assert merged == "Base system prompt\n\nDelegated subagent instructions"


def test_merge_model_and_request_system_prompt_supports_text_part_lists():
    merged = merge_model_and_request_system_prompt(
        "Base system prompt",
        [
            {
                "role": "system",
                "content": [{"type": "text", "text": "List-based system content"}],
            }
        ],
    )

    assert "List-based system content" in merged


def test_merge_model_and_request_system_prompt_ignores_followup_placeholder_before_static_context():
    merged = merge_model_and_request_system_prompt(
        "Base system prompt",
        [
            {"role": "system", "content": ""},
            {
                "role": "system",
                "content": "<portico_context><static_context>static</static_context></portico_context>",
            },
            {
                "role": "system",
                "content": "<portico_context><dynamic_context>dynamic</dynamic_context></portico_context>",
            },
        ],
    )

    assert merged == "Base system prompt"
