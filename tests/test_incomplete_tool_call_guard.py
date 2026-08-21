from pathlib import Path
import ast
import json
import os
import tempfile
from typing import Any, Optional
import sys


REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src/patches/backend"))

from open_webui.utils.tool_call_streaming import (  # noqa: E402
    get_missing_required_tool_arguments,
    normalize_blank_tool_call_arguments,
)


MIDDLEWARE_PATH = (
    REPO_ROOT / "src/patches/backend/open_webui/utils/middleware.py"
)


class _FakeLog:
    def debug(self, *args, **kwargs):
        return None

    def info(self, *args, **kwargs):
        return None

    def warning(self, *args, **kwargs):
        return None


def _load_tool_guard_helpers():
    source = MIDDLEWARE_PATH.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(MIDDLEWARE_PATH))
    wanted_names = {
        "_optimization_flags_path",
        "_load_optimization_flags",
        "_optimization_int_value",
        "_build_unavailable_tool_result",
        "_build_incomplete_tool_call_result",
        "_filter_subagent_locked_tool_registry",
        "_normalize_single_required_string_argument_alias",
        "_tool_spec_for_tool_name",
        "_normalize_tool_call_arguments_for_schema",
        "_parse_tool_call_arguments",
        "_missing_required_arguments_for_tool_call",
        "_should_defer_incomplete_tool_calls",
        "_tool_declares_current_chat_id",
        "_is_agent_vm_runtime_tool",
        "_normalize_current_chat_scoped_tool_arguments",
        "_force_subagent_parent_context",
    }
    selected_nodes = [
        node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name in wanted_names
    ]

    module = ast.Module(
        body=[
            ast.ImportFrom(
                module="__future__",
                names=[ast.alias(name="annotations")],
                level=0,
            ),
            *selected_nodes,
        ],
        type_ignores=[],
    )
    ast.fix_missing_locations(module)
    namespace = {
        "Any": Any,
        "Optional": Optional,
        "Path": Path,
        "ast": ast,
        "json": json,
        "log": _FakeLog(),
        "os": os,
        "_OPTIMIZATION_FLAG_ENV_PREFIX": "OWUI_OPT_",
        "_OPTIMIZATION_FLAGS_CACHE": {},
        "_OPTIMIZATION_FLAGS_MTIME": 0.0,
        "re": __import__("re"),
        "_SINGLE_STRING_ARGUMENT_ALIAS_KEYS": (
            "message",
            "query",
            "question",
            "prompt",
            "text",
        ),
        "_SUBAGENT_LOCKED_TOOL_NAMES": {
            "mcp_assistant_toggle_integration",
            "mcp_assistant_authorize_integration",
            "mcp_assistant_activate_integration",
            "mcp_assistant_trigger_guided_setup",
            "skills_activate_skill",
        },
        "get_missing_required_tool_arguments": get_missing_required_tool_arguments,
        "normalize_blank_tool_call_arguments": normalize_blank_tool_call_arguments,
    }
    exec(compile(module, str(MIDDLEWARE_PATH), "exec"), namespace)
    return namespace


HELPERS = _load_tool_guard_helpers()
_optimization_flags_path = HELPERS["_optimization_flags_path"]
_load_optimization_flags = HELPERS["_load_optimization_flags"]
_optimization_int_value = HELPERS["_optimization_int_value"]
_build_unavailable_tool_result = HELPERS["_build_unavailable_tool_result"]
_build_incomplete_tool_call_result = HELPERS["_build_incomplete_tool_call_result"]
_filter_subagent_locked_tool_registry = HELPERS[
    "_filter_subagent_locked_tool_registry"
]
_normalize_single_required_string_argument_alias = HELPERS[
    "_normalize_single_required_string_argument_alias"
]
_tool_spec_for_tool_name = HELPERS["_tool_spec_for_tool_name"]
_normalize_tool_call_arguments_for_schema = HELPERS[
    "_normalize_tool_call_arguments_for_schema"
]
_parse_tool_call_arguments = HELPERS["_parse_tool_call_arguments"]
_missing_required_arguments_for_tool_call = HELPERS[
    "_missing_required_arguments_for_tool_call"
]
_should_defer_incomplete_tool_calls = HELPERS["_should_defer_incomplete_tool_calls"]
_tool_declares_current_chat_id = HELPERS["_tool_declares_current_chat_id"]
_is_agent_vm_runtime_tool = HELPERS["_is_agent_vm_runtime_tool"]
_normalize_current_chat_scoped_tool_arguments = HELPERS[
    "_normalize_current_chat_scoped_tool_arguments"
]
_force_subagent_parent_context = HELPERS["_force_subagent_parent_context"]


def test_optimization_flags_path_searches_parents_without_fixed_depth_index():
    original_file = _optimization_flags_path.__globals__.get("__file__", str(MIDDLEWARE_PATH))
    original_host_project_root = os.environ.get("HOST_PROJECT_ROOT")

    try:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            flags_path = temp_root / "optimization_flags.json"
            flags_path.write_text('{"subagent_integration_activation_restriction": true}')

            fake_module_path = temp_root / "backend" / "open_webui" / "utils" / "middleware.py"
            fake_module_path.parent.mkdir(parents=True, exist_ok=True)
            fake_module_path.write_text("# fake middleware module\n")

            _optimization_flags_path.__globals__["__file__"] = str(fake_module_path)
            os.environ.pop("HOST_PROJECT_ROOT", None)

            assert _optimization_flags_path().resolve() == flags_path.resolve()
    finally:
        _optimization_flags_path.__globals__["__file__"] = original_file
        if original_host_project_root is None:
            os.environ.pop("HOST_PROJECT_ROOT", None)
        else:
            os.environ["HOST_PROJECT_ROOT"] = original_host_project_root


def test_optimization_int_value_reads_numeric_flags_from_json():
    original_file = _optimization_flags_path.__globals__.get("__file__", str(MIDDLEWARE_PATH))
    original_host_project_root = os.environ.get("HOST_PROJECT_ROOT")
    original_cache = _load_optimization_flags.__globals__.get("_OPTIMIZATION_FLAGS_CACHE", {}).copy()
    original_mtime = _load_optimization_flags.__globals__.get("_OPTIMIZATION_FLAGS_MTIME", 0.0)

    try:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            flags_path = temp_root / "optimization_flags.json"
            flags_path.write_text('{"example_numeric_flag": 12}')

            fake_module_path = temp_root / "backend" / "open_webui" / "utils" / "middleware.py"
            fake_module_path.parent.mkdir(parents=True, exist_ok=True)
            fake_module_path.write_text("# fake middleware module\n")

            _optimization_flags_path.__globals__["__file__"] = str(fake_module_path)
            _load_optimization_flags.__globals__["__file__"] = str(fake_module_path)
            _optimization_int_value.__globals__["__file__"] = str(fake_module_path)
            _load_optimization_flags.__globals__["_OPTIMIZATION_FLAGS_CACHE"] = {}
            _load_optimization_flags.__globals__["_OPTIMIZATION_FLAGS_MTIME"] = 0.0
            os.environ.pop("HOST_PROJECT_ROOT", None)

            assert _optimization_int_value("example_numeric_flag", 6) == 12
    finally:
        _optimization_flags_path.__globals__["__file__"] = original_file
        _load_optimization_flags.__globals__["__file__"] = original_file
        _optimization_int_value.__globals__["__file__"] = original_file
        _load_optimization_flags.__globals__["_OPTIMIZATION_FLAGS_CACHE"] = original_cache
        _load_optimization_flags.__globals__["_OPTIMIZATION_FLAGS_MTIME"] = original_mtime
        if original_host_project_root is None:
            os.environ.pop("HOST_PROJECT_ROOT", None)
        else:
            os.environ["HOST_PROJECT_ROOT"] = original_host_project_root


def test_parse_tool_call_arguments_accepts_json_and_python_object_strings():
    assert _parse_tool_call_arguments('{"vm_id":"vm-1","script":"print(1)"}') == (
        {"vm_id": "vm-1", "script": "print(1)"},
        True,
    )
    assert _parse_tool_call_arguments("{'vm_id': 'vm-1', 'script': 'print(1)'}") == (
        {"vm_id": "vm-1", "script": "print(1)"},
        True,
    )
    assert _parse_tool_call_arguments('{"vm_id":') == ({}, False)


def test_normalize_tool_call_arguments_for_schema_accepts_blank_zero_arg_tools_only():
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

    assert _tool_spec_for_tool_name(
        "portico_proctor_proctor_overview",
        {
            "portico_proctor_proctor_overview": {
                "spec": zero_arg_spec,
            }
        },
    ) == zero_arg_spec

    assert _normalize_tool_call_arguments_for_schema(
        "",
        tool_name="portico_proctor_proctor_overview",
        tool_spec=zero_arg_spec,
    ) == ("{}", {}, True)
    assert _normalize_tool_call_arguments_for_schema(
        "",
        tool_name="glean_search",
        tool_spec=required_arg_spec,
    ) == ("", {}, False)


def test_normalize_single_required_string_argument_alias_recovers_query_to_message():
    normalized, changed = _normalize_single_required_string_argument_alias(
        "glean_chat",
        {
            "parameters": {
                "type": "object",
                "properties": {
                    "message": {"type": "string"},
                    "context": {"type": "array"},
                },
                "required": ["message"],
            }
        },
        {"query": "Summarize Q1 plans", "context": ["prior note"]},
    )

    assert changed is True
    assert normalized == {
        "message": "Summarize Q1 plans",
        "context": ["prior note"],
    }


def test_filter_subagent_locked_tool_registry_removes_integration_mutators_only():
    filtered, removed = _filter_subagent_locked_tool_registry(
        {
            "mcp_assistant_activate_integration": {"spec": {}},
            "mcp_assistant_authorize_integration": {"spec": {}},
            "mcp_assistant_toggle_integration": {"spec": {}},
            "mcp_assistant_trigger_guided_setup": {"spec": {}},
            "skills_activate_skill": {"spec": {}},
            "mcp_assistant_list_integrations": {"spec": {}},
            "glean_search": {"spec": {}},
        },
        lock_integrations=True,
    )

    assert removed == [
        "mcp_assistant_activate_integration",
        "mcp_assistant_authorize_integration",
        "mcp_assistant_toggle_integration",
        "mcp_assistant_trigger_guided_setup",
        "skills_activate_skill",
    ]
    assert set(filtered.keys()) == {
        "mcp_assistant_list_integrations",
        "glean_search",
    }


def test_build_unavailable_tool_result_blocks_locked_subagent_mutations_without_error():
    result = _build_unavailable_tool_result(
        "mcp_assistant_activate_integration",
        is_subagent_chat=True,
        lock_integrations=True,
    )

    assert isinstance(result, dict)
    assert result["status"] == "blocked_by_policy"
    assert result["code"] == "delegated_subagent_tool_locked"
    assert "delegated subagent chats" in result["message"]


def test_build_unavailable_tool_result_keeps_normal_error_for_regular_chats():
    result = _build_unavailable_tool_result(
        "mcp_assistant_activate_integration",
        is_subagent_chat=False,
        lock_integrations=True,
    )

    assert isinstance(result, str)
    assert result.startswith("Error: Tool 'mcp_assistant_activate_integration'")


def test_missing_required_arguments_for_tool_call_uses_tool_spec():
    tool_call = {
        "function": {
            "name": "agent_vm_python",
            "arguments": '{"vm_id":"vm-1"}',
        }
    }
    tools = {
        "agent_vm_python": {
            "spec": {
                "parameters": {
                    "type": "object",
                    "properties": {
                        "vm_id": {"type": "string"},
                        "script": {"type": "string"},
                    },
                    "required": ["vm_id", "script"],
                }
            }
        }
    }

    assert _missing_required_arguments_for_tool_call(tool_call, tools) == ["script"]


def test_missing_required_arguments_for_zero_arg_tool_allows_blank_arguments():
    tool_call = {
        "function": {
            "name": "portico_proctor_proctor_overview",
            "arguments": "",
        }
    }
    tools = {
        "portico_proctor_proctor_overview": {
            "spec": {
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "required": [],
                }
            }
        }
    }

    assert _missing_required_arguments_for_tool_call(tool_call, tools) == []


def test_should_defer_incomplete_tool_calls_for_length_stops():
    tool_calls = [
        {
            "id": "tool-1",
            "function": {
                "name": "agent_vm_python",
                "arguments": '{"vm_id":"vm-1"',
            },
        }
    ]
    tools = {
        "agent_vm_python": {
            "spec": {
                "parameters": {
                    "type": "object",
                    "properties": {
                        "vm_id": {"type": "string"},
                        "script": {"type": "string"},
                    },
                    "required": ["vm_id", "script"],
                }
            }
        }
    }

    should_defer, details = _should_defer_incomplete_tool_calls(
        response_tool_calls=tool_calls,
        tools=tools,
        finish_reason="length",
        stop_reason=None,
    )

    assert should_defer is True
    assert details == [
        {
            "id": "tool-1",
            "name": "agent_vm_python",
            "parse_ok": False,
            "missing_required_arguments": ["vm_id", "script"],
        }
    ]


def test_should_not_defer_incomplete_tool_calls_without_length_signal():
    tool_calls = [
        {
            "id": "tool-1",
            "function": {
                "name": "agent_vm_python",
                "arguments": "{}",
            },
        }
    ]
    tools = {
        "agent_vm_python": {
            "spec": {
                "parameters": {
                    "type": "object",
                    "properties": {
                        "vm_id": {"type": "string"},
                        "script": {"type": "string"},
                    },
                    "required": ["vm_id", "script"],
                }
            }
        }
    }

    should_defer, details = _should_defer_incomplete_tool_calls(
        response_tool_calls=tool_calls,
        tools=tools,
        finish_reason="tool_calls",
        stop_reason=None,
    )

    assert should_defer is False
    assert details == [
        {
            "id": "tool-1",
            "name": "agent_vm_python",
            "parse_ok": True,
            "missing_required_arguments": ["vm_id", "script"],
        }
    ]


def test_should_not_defer_blank_zero_arg_tool_calls_even_when_generation_stops_for_length():
    tool_calls = [
        {
            "id": "tool-1",
            "function": {
                "name": "portico_proctor_proctor_overview",
                "arguments": "",
            },
        }
    ]
    tools = {
        "portico_proctor_proctor_overview": {
            "spec": {
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "required": [],
                }
            }
        }
    }

    should_defer, details = _should_defer_incomplete_tool_calls(
        response_tool_calls=tool_calls,
        tools=tools,
        finish_reason="length",
        stop_reason=None,
    )

    assert should_defer is False
    assert details == []


def test_build_incomplete_tool_call_result_is_retryable_and_informative():
    result = _build_incomplete_tool_call_result(
        tool_function_name="agent_vm_python",
        raw_arguments="{}",
        parsed_arguments={},
        missing_required_arguments=["vm_id", "script"],
        completion_tokens=4096,
    )

    assert result["success"] is False
    assert result["retryable"] is True
    assert result["missing_required_arguments"] == ["vm_id", "script"]
    assert "4096 completion tokens" in result["error"]
    assert "empty or partial tool input" in result["error"]


def test_tool_declares_current_chat_id_detects_system_prompt_chat_fields():
    tool = {
        "spec": {
            "parameters": {
                "properties": {
                    "chat_id": {
                        "type": "string",
                        "description": "Chat ID (extract from system prompt: 'Chat ID: {id}')",
                    }
                }
            }
        }
    }

    assert _tool_declares_current_chat_id(tool) is True


def test_normalize_current_chat_scoped_tool_arguments_overrides_mismatched_chat_id():
    tool = {
        "spec": {
            "parameters": {
                "properties": {
                    "chat_id": {
                        "type": "string",
                        "description": "Attach enabled tool servers to the current chat session.",
                    }
                }
            }
        }
    }

    normalized = _normalize_current_chat_scoped_tool_arguments(
        tool_function_name="mcp_assistant_activate_integration",
        tool=tool,
        tool_function_params={
            "chat_id": "wrong-chat",
            "tool_server_ids": ["server:google_workspace"],
        },
        metadata={"chat_id": "correct-chat"},
    )

    assert normalized["chat_id"] == "correct-chat"
    assert normalized["tool_server_ids"] == ["server:google_workspace"]


def test_normalize_current_chat_scoped_tool_arguments_leaves_non_chat_scoped_tools_alone():
    tool = {
        "spec": {
            "parameters": {
                "properties": {
                    "chat_id": {
                        "type": "string",
                        "description": "Arbitrary vendor chat identifier.",
                    }
                }
            }
        }
    }

    normalized = _normalize_current_chat_scoped_tool_arguments(
        tool_function_name="vendor_tool",
        tool=tool,
        tool_function_params={"chat_id": "vendor-chat"},
        metadata={"chat_id": "current-owui-chat"},
    )

    assert normalized["chat_id"] == "vendor-chat"


def test_normalize_current_chat_scoped_tool_arguments_injects_agent_vm_chat_id_without_schema_field():
    tool = {
        "spec": {
            "parameters": {
                "properties": {
                    "vm_id": {"type": "string"},
                    "command": {"type": "string"},
                }
            }
        }
    }

    normalized = _normalize_current_chat_scoped_tool_arguments(
        tool_function_name="agent_vm_bash",
        tool=tool,
        tool_function_params={"vm_id": "vm-from-cloned-history", "command": "pwd"},
        metadata={"chat_id": "cloned-chat"},
    )

    assert _is_agent_vm_runtime_tool("agent_vm_bash") is True
    assert normalized == {
        "vm_id": "vm-from-cloned-history",
        "command": "pwd",
        "chat_id": "cloned-chat",
    }


def test_normalize_current_chat_scoped_tool_arguments_overrides_agent_vm_destroy_requester():
    normalized = _normalize_current_chat_scoped_tool_arguments(
        tool_function_name="agent_vm_destroy",
        tool={"spec": {"parameters": {"properties": {}}}},
        tool_function_params={
            "vm_id": "vm-from-original-chat",
            "requester_chat_id": "original-chat",
        },
        metadata={"chat_id": "cloned-chat"},
    )

    assert normalized == {
        "vm_id": "vm-from-original-chat",
        "requester_chat_id": "cloned-chat",
    }


def test_normalize_current_chat_scoped_tool_arguments_blocks_agent_vm_without_runtime_chat_id():
    normalized = _normalize_current_chat_scoped_tool_arguments(
        tool_function_name="agent_vm_bash",
        tool={"spec": {"parameters": {"properties": {}}}},
        tool_function_params={
            "vm_id": "vm-from-original-chat",
            "chat_id": "model-supplied-chat",
            "command": "pwd",
        },
        metadata={"chat_id": "   "},
    )

    assert normalized == {"command": "pwd"}


def test_force_subagent_parent_context_overrides_model_supplied_parent_ids():
    normalized = _force_subagent_parent_context(
        tool_function_name="subagents_run_subagent",
        tool_function_params={
            "prompt": "Investigate",
            "parent_tool_call_id": "model-call",
            "parent_chat_id": "model-chat",
        },
        tool_call_id="runtime-call",
        metadata={"chat_id": "runtime-chat"},
    )

    assert normalized["prompt"] == "Investigate"
    assert normalized["parent_tool_call_id"] == "runtime-call"
    assert normalized["parent_chat_id"] == "runtime-chat"


def test_force_subagent_parent_context_restores_ids_after_schema_filtering():
    filtered_params = {"prompt": "Investigate"}

    normalized = _force_subagent_parent_context(
        tool_function_name="subagents_run_subagent",
        tool_function_params=filtered_params,
        tool_call_id="runtime-call",
        metadata={"chat_id": "runtime-chat"},
    )

    assert normalized["prompt"] == "Investigate"
    assert normalized["parent_tool_call_id"] == "runtime-call"
    assert normalized["parent_chat_id"] == "runtime-chat"


def test_force_subagent_parent_context_removes_model_parent_chat_without_runtime_chat():
    normalized = _force_subagent_parent_context(
        tool_function_name="subagents_run_subagent",
        tool_function_params={
            "prompt": "Investigate",
            "parent_chat_id": "model-chat",
        },
        tool_call_id="runtime-call",
        metadata={"chat_id": "local:pending"},
    )

    assert normalized["parent_tool_call_id"] == "runtime-call"
    assert "parent_chat_id" not in normalized
