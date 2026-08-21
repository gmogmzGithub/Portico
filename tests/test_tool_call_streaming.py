from pathlib import Path
import sys


REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src/patches/backend"))
MIDDLEWARE_PATH = REPO_ROOT / "src/patches/backend/open_webui/utils/middleware.py"

from open_webui.utils.tool_call_streaming import (
    build_tool_call_preview_content,
    get_missing_required_tool_arguments,
    get_required_tool_arguments,
    get_tool_call_summary_label,
    is_tool_call_only_delta,
    normalize_blank_tool_call_arguments,
    normalize_tool_calls_for_execution,
    split_concatenated_json_objects,
    tool_spec_accepts_empty_arguments,
    tool_calls_ready_for_preview,
)


def test_split_concatenated_json_objects_extracts_individual_payloads():
    result = split_concatenated_json_objects('{"a":1}{"b":2}')

    assert result == ['{"a":1}', '{"b":2}']


def test_split_concatenated_json_objects_rejects_incomplete_payloads():
    assert split_concatenated_json_objects('{"a":1') is None
    assert split_concatenated_json_objects('{"a":1} trailing') is None


def test_normalize_tool_calls_for_execution_splits_concatenated_args():
    tool_calls = [
        {
            "id": "call-1",
            "index": 0,
            "type": "function",
            "function": {
                "name": "agent_vm_create_files",
                "arguments": '{"a":1}{"b":2}',
            },
        }
    ]

    normalized = normalize_tool_calls_for_execution(tool_calls, "Atlas Opus 4.6")

    assert len(normalized) == 2
    assert normalized[0]["id"] == "call-1"
    assert normalized[0]["index"] == 0
    assert normalized[0]["function"]["arguments"] == '{"a":1}'
    assert normalized[1]["id"] == "call-1-part2"
    assert normalized[1]["index"] == 1
    assert normalized[1]["function"]["arguments"] == '{"b":2}'


def test_is_tool_call_only_delta_ignores_empty_fields_and_role():
    assert (
        is_tool_call_only_delta(
            {
                "role": "assistant",
                "tool_calls": [{"index": 0}],
                "content": "",
                "reasoning_content": None,
            }
        )
        is True
    )

    assert (
        is_tool_call_only_delta(
            {
                "tool_calls": [{"index": 0}],
                "content": "real text",
            }
        )
        is False
    )


def test_build_tool_call_preview_content_preserves_complete_arguments():
    preview = build_tool_call_preview_content(
        [
            {
                "id": "call-1",
                "index": 0,
                "type": "function",
                "function": {
                    "name": "agent_vm_create_files",
                    "arguments": '{"files":[{"path":"calculator.js","content":"very large"}]}',
                },
            }
        ]
    )

    assert preview == [
        {
            "id": "call-1",
            "index": 0,
            "type": "function",
            "function": {
                "name": "agent_vm_create_files",
                "arguments": '{"files":[{"path":"calculator.js","content":"very large"}]}',
            },
        }
    ]


def test_tool_calls_ready_for_preview_requires_parseable_arguments():
    assert (
        tool_calls_ready_for_preview(
            [
                {
                    "id": "call-1",
                    "index": 0,
                    "type": "function",
                    "function": {
                        "name": "subagents_run_subagent",
                        "arguments": "",
                    },
                }
            ]
        )
        is False
    )

    assert (
        tool_calls_ready_for_preview(
            [
                {
                    "id": "call-1",
                    "index": 0,
                    "type": "function",
                    "function": {
                        "name": "portico_proctor_proctor_overview",
                        "arguments": "",
                    },
                }
            ],
            {
                "portico_proctor_proctor_overview": {
                    "spec": {
                        "parameters": {
                            "type": "object",
                            "properties": {},
                            "required": [],
                        }
                    }
                }
            },
        )
        is True
    )

    assert (
        tool_calls_ready_for_preview(
            [
                {
                    "id": "call-1",
                    "index": 0,
                    "type": "function",
                    "function": {
                        "name": "subagents_run_subagent",
                        "arguments": '{"model":"Atlas Opus 4.6"',
                    },
                }
            ]
        )
        is False
    )

    assert (
        tool_calls_ready_for_preview(
            [
                {
                    "id": "call-1",
                    "index": 0,
                    "type": "function",
                    "function": {
                        "name": "subagents_run_subagent",
                        "arguments": '{"model":"Atlas Opus 4.6"}',
                    },
                }
            ]
        )
        is True
    )


def test_get_tool_call_summary_label_supports_preview_and_execution_states():
    assert get_tool_call_summary_label(True) == "Preparing..."
    assert get_tool_call_summary_label(False) == "Executing..."


def test_middleware_serializes_explicit_tool_call_phases_for_preview_and_execution():
    source = MIDDLEWARE_PATH.read_text(encoding="utf-8")

    assert 'tool_call_phase = (' in source
    assert 'phase="{tool_call_phase}"' in source


def test_normalize_blank_tool_call_arguments_only_for_zero_arg_object_schemas():
    zero_arg_spec = {
        "parameters": {
            "type": "object",
            "properties": {},
            "required": [],
        }
    }
    required_arg_spec = {
        "parameters": {
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
        }
    }

    assert tool_spec_accepts_empty_arguments(zero_arg_spec) is True
    assert tool_spec_accepts_empty_arguments(required_arg_spec) is False
    assert normalize_blank_tool_call_arguments("", zero_arg_spec) == ("{}", True)
    assert normalize_blank_tool_call_arguments("null", zero_arg_spec) == ("{}", True)
    assert normalize_blank_tool_call_arguments("", required_arg_spec) == ("", False)


def test_get_required_tool_arguments_prefers_openai_parameters_schema():
    tool_spec = {
        "parameters": {
            "type": "object",
            "properties": {
                "vm_id": {"type": "string"},
                "script": {"type": "string"},
            },
            "required": ["vm_id", "script"],
        }
    }

    assert get_required_tool_arguments(tool_spec) == ["vm_id", "script"]


def test_get_required_tool_arguments_falls_back_to_mcp_input_schema():
    tool_spec = {
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
            },
            "required": ["path"],
        }
    }

    assert get_required_tool_arguments(tool_spec) == ["path"]


def test_get_missing_required_tool_arguments_flags_absent_and_blank_values():
    tool_spec = {
        "parameters": {
            "type": "object",
            "properties": {
                "vm_id": {"type": "string"},
                "script": {"type": "string"},
                "timeout": {"type": "integer"},
            },
            "required": ["vm_id", "script"],
        }
    }

    assert get_missing_required_tool_arguments(tool_spec, {}) == ["vm_id", "script"]
    assert get_missing_required_tool_arguments(
        tool_spec, {"vm_id": "vm-1", "script": "  "}
    ) == ["script"]
    assert get_missing_required_tool_arguments(
        tool_spec, {"vm_id": "vm-1", "script": "print('ok')", "timeout": 30}
    ) == []
