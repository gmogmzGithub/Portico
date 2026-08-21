import html
import importlib.util
import json
from pathlib import Path
import sys
import types


def _load_runner_module():
    source_path = (
        Path(__file__).resolve().parents[1]
        / "src"
        / "scripts"
        / "run_ejs_ejg_report_chat_consistency.py"
    )
    spec = importlib.util.spec_from_file_location(
        "run_ejs_ejg_report_chat_consistency", source_path
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None

    previous_runner = sys.modules.get("owui_runner_base")
    previous_pypdf = sys.modules.get("pypdf")
    previous_httpx = sys.modules.get("httpx")
    fake_runner = types.SimpleNamespace(
        OWUIClient=object,
        _detect_openwebui_base_url=lambda: "http://unused",
        _restart_counts=lambda: {},
    )
    fake_pypdf = types.SimpleNamespace(PdfReader=object)
    fake_httpx = types.SimpleNamespace(Client=object, Timeout=object)
    sys.modules["owui_runner_base"] = fake_runner
    sys.modules["pypdf"] = fake_pypdf
    sys.modules["httpx"] = fake_httpx
    try:
        spec.loader.exec_module(module)
    finally:
        if previous_runner is None:
            sys.modules.pop("owui_runner_base", None)
        else:
            sys.modules["owui_runner_base"] = previous_runner

        if previous_pypdf is None:
            sys.modules.pop("pypdf", None)
        else:
            sys.modules["pypdf"] = previous_pypdf
        if previous_httpx is None:
            sys.modules.pop("httpx", None)
        else:
            sys.modules["httpx"] = previous_httpx
    return module


def test_build_prompt_includes_requested_subagent_model():
    module = _load_runner_module()

    prompt = module._build_prompt("GPT-5.4")

    assert "Spawn (3) subagents in parallel." in prompt
    assert "Each subagent should use the GPT-5.4 model." in prompt


def test_tool_failure_detection_catches_success_false_and_error():
    module = _load_runner_module()

    assert module._is_tool_failure({"success": False}) is True
    assert module._is_tool_failure({"error": "boom"}) is True
    assert module._is_tool_failure({"success": True}) is False
    assert module._is_tool_failure("ok") is False


def test_delivery_confidence_analysis_detection_accepts_semantic_matches():
    module = _load_runner_module()

    assert (
        module._has_delivery_confidence_analysis(
            "overall team velocity suggests high confidence in delivery this quarter"
        )
        is True
    )
    assert (
        module._has_delivery_confidence_analysis(
            "velocity and likelihood of successful delivery remain strong"
        )
        is True
    )
    assert module._has_delivery_confidence_analysis("jira and slack updates only") is False


def test_parse_tool_calls_decodes_arguments_and_results():
    module = _load_runner_module()

    content = (
        '<details type="tool_calls" done="true" duration="12" '
        'id="tool1" name="subagents_run_subagent" '
        'arguments="&quot;{\\&quot;model\\&quot;: \\&quot;Atlas Opus 5\\&quot;}&quot;" '
        'result="&quot;{\\&quot;success\\&quot;: true, \\&quot;chat_id\\&quot;: \\&quot;child-1\\&quot;}&quot;">'
        "</details>"
    )

    tool_calls = module._parse_tool_calls(content)

    assert len(tool_calls) == 1
    assert tool_calls[0]["name"] == "subagents_run_subagent"
    assert tool_calls[0]["arguments"]["model"] == "Atlas Opus 5"
    assert tool_calls[0]["result"]["chat_id"] == "child-1"


def test_validate_child_chat_fails_when_token_usage_exceeds_reasonable_limit():
    module = _load_runner_module()

    assistant_content = (
        '<details type="tool_calls" done="true" duration="1" '
        'id="tool1" name="glean_search" '
        'arguments="&quot;{}&quot;" '
        'result="&quot;{\\&quot;success\\&quot;: true}&quot;">'
        "</details>"
        + ("A" * 500)
    )

    payload = {
        "chat": {
            "models": ["Atlas Opus 5"],
            "history": {
                "messages": {
                    "assistant-1": {
                        "role": "assistant",
                        "timestamp": 1,
                        "done": True,
                        "content": assistant_content,
                        "usage": {"total_tokens": 500_001},
                    }
                }
            },
        }
    }

    class _FakeClient:
        def get_chat(self, chat_id):
            return payload

    failures, summary = module._validate_child_chat(
        client=_FakeClient(),
        chat_id="child-1",
        expected_model="Atlas Opus 5",
        max_reasonable_child_tokens=500_000,
    )

    assert any("exceeding 500000" in failure for failure in failures)
    assert summary["usage"]["total_tokens"] == 500_001


def test_validate_parent_chat_fails_when_subagent_result_is_truncated(tmp_path):
    module = _load_runner_module()

    def encoded(value):
        return html.escape(json.dumps(json.dumps(value)), quote=True)

    def tool_call(index, result):
        return (
            '<details type="tool_calls" done="true" duration="1" '
            f'id="tool{index}" name="subagents_run_subagent" '
            f'arguments="{encoded({"model": "Atlas Opus 5"})}" '
            f'result="{encoded(result)}">'
            "</details>"
        )

    assistant_html = "".join(
        [
            tool_call(
                1,
                {
                    "success": True,
                    "chat_id": "child-1",
                    "response_truncated": True,
                    "response_char_count": 13_373,
                },
            ),
            tool_call(
                2,
                {
                    "success": True,
                    "chat_id": "child-2",
                    "response_truncated": False,
                    "response_char_count": 2_000,
                },
            ),
            tool_call(
                3,
                {
                    "success": True,
                    "chat_id": "child-3",
                    "response_truncated": False,
                    "response_char_count": 2_000,
                },
            ),
            "Final synthesis " * 30,
        ]
    )

    pdf_path = tmp_path / "report.pdf"
    pdf_path.write_bytes(b"%PDF minimal")
    pdf_text = (
        "AI Advanced Screening Basic Screening AI Job Management "
        "velocity slack jira delivery current quarter likelihood of successful delivery"
    )
    module._find_workspace_pdfs = lambda chat_id: [pdf_path]
    module._read_pdf_text = lambda path: (4, pdf_text)
    module._validate_child_chat = lambda **kwargs: (
        [],
        {"chat_id": kwargs["chat_id"], "tool_call_count": 1},
    )

    class _FakeClient:
        def get_chat(self, chat_id):
            return {
                "chat": {
                    "history": {
                        "messages": {
                            "assistant-1": {
                                "role": "assistant",
                                "timestamp": 1,
                                "usage": {"total_tokens": 10},
                            }
                        }
                    }
                }
            }

    verdict = module._validate_parent_chat(
        client=_FakeClient(),
        chat_id="parent-1",
        assistant_html=assistant_html,
        expected_subagent_model="Atlas Opus 5",
        max_reasonable_child_tokens=500_000,
        max_reasonable_parent_tokens=700_000,
    )

    assert any("subagent result was truncated" in failure for failure in verdict["failures"])
