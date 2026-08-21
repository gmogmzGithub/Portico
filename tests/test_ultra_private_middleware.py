from __future__ import annotations

import ast
import importlib.util
import json
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from uuid import uuid4

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
MIDDLEWARE_PATH = (
    REPO_ROOT / "src" / "patches" / "backend" / "open_webui" / "utils" / "middleware.py"
)
EXECUTOR_PATH = (
    REPO_ROOT
    / "src"
    / "patches"
    / "backend"
    / "open_webui"
    / "utils"
    / "ultra_tool_executor.py"
)

SPEC = importlib.util.spec_from_file_location(
    "ultra_private_seam_executor", EXECUTOR_PATH
)
EXECUTOR = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = EXECUTOR
SPEC.loader.exec_module(EXECUTOR)

TOKEN = "a" * 32
DIGEST = "1" * 64


def _tool(name: str, original_name: str) -> dict[str, Any]:
    return {
        "type": "mcp",
        "direct": False,
        "server_id": "local-data",
        "original_name": original_name,
        "mcp_server_connection": {"url": "http://mcp-orc:8000/mcp"},
        "spec": {
            "name": name,
            "description": "Returns local JSON data.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
            "outputSchema": {"type": "object"},
        },
    }


def _openapi_tool() -> dict[str, Any]:
    managed_url = "http://" + "mcpo-core" + ":8081/web-tools"
    return {
        "type": "external",
        "server_id": "web-tools",
        "server_operation_name": "web_tools_web_search",
        "tool_id": "server:web-tools",
        "tool_server_data": {
            "id": "web-tools",
            "url": managed_url,
            "openapi": {
                "paths": {
                    "/web_tools_web_search": {
                        "post": {
                            "operationId": "web_tools_web_search",
                            "requestBody": {
                                "content": {"application/json": {}}
                            },
                        }
                    }
                }
            },
        },
        "tool_server_connection": {
            "url": managed_url,
            "type": "openapi",
            "auth_type": "none",
        },
        "spec": {
            "name": "web_tools_web_search",
            "description": "Returns local JSON search results.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        },
    }


def _load_private_seam(bridge_call, mcp_call, gate_calls, openapi_call=None):
    source = MIDDLEWARE_PATH.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(MIDDLEWARE_PATH))
    selected = next(
        node
        for node in tree.body
        if isinstance(node, ast.AsyncFunctionDef)
        and node.name == "_execute_ultra_private_control"
    )

    def normalize(arguments, **_kwargs):
        try:
            parsed = json.loads(arguments)
        except ValueError:
            return arguments, None, False
        return arguments, parsed, isinstance(parsed, dict)

    def normalize_alias(*, parsed_arguments, **_kwargs):
        return parsed_arguments, False

    def normalize_current(*, tool_function_params, **_kwargs):
        return tool_function_params

    def missing_required(spec, arguments):
        required = spec.get("parameters", {}).get("required", [])
        return [name for name in required if name not in arguments]

    class Registry:
        def classify(self, name):
            return (
                ("safe", "test-safe")
                if name in {"local_search", "web_tools_web_search"}
                else ("destructive", "test-write")
            )

    async def apply_gate(**kwargs):
        gate_calls.append(
            (kwargs["tool_function_name"], dict(kwargs["tool_function_params"]))
        )
        return kwargs["tool_function_params"], None

    namespace = {
        "Any": Any,
        "Request": object,
        "MCPClient": object,
        "UltraToolDenied": EXECUTOR.UltraToolDenied,
        "await_once_with_heartbeat": EXECUTOR.await_once_with_heartbeat,
        "call_mcp_tool_with_runtime_headers": mcp_call,
        "default_tool_confirmation_gate": lambda: SimpleNamespace(registry=Registry()),
        "get_missing_required_tool_arguments": missing_required,
        "json": json,
        "require_eligible_local_mcp_tool": EXECUTOR.require_eligible_local_mcp_tool,
        "run_private_ultra_batches": EXECUTOR.run_private_ultra_batches,
        "time": time,
        "uuid4": uuid4,
        "_apply_tool_confirmation_gate": apply_gate,
        "_load_server_metadata": lambda _server_id: {"is_core": True},
        "_normalize_current_chat_scoped_tool_arguments": normalize_current,
        "_normalize_single_required_string_argument_alias": normalize_alias,
        "_normalize_tool_call_arguments_for_schema": normalize,
        "_execute_private_ultra_openapi_tool": openapi_call,
        "_ultra_private_bridge_call": bridge_call,
    }
    module = ast.Module(body=[selected], type_ignores=[])
    exec(compile(module, str(MIDDLEWARE_PATH), "exec"), namespace)
    return namespace["_execute_ultra_private_control"]


def test_private_bridge_timeout_leaves_results_to_the_server_wall_budget():
    source = MIDDLEWARE_PATH.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(MIDDLEWARE_PATH))
    timeout_node = next(
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef)
        and node.name == "_ultra_private_bridge_timeout_seconds"
    )
    namespace = {}
    exec(
        compile(
            ast.Module(body=[timeout_node], type_ignores=[]),
            str(MIDDLEWARE_PATH),
            "exec",
        ),
        namespace,
    )
    timeout_for = namespace["_ultra_private_bridge_timeout_seconds"]

    assert timeout_for("claim") == 60
    assert timeout_for("dispatch-start") == 60
    assert timeout_for("heartbeat") == 60
    assert timeout_for("results") == 31 * 60

    bridge_node = next(
        node
        for node in tree.body
        if isinstance(node, ast.AsyncFunctionDef)
        and node.name == "_ultra_private_bridge_call"
    )
    assert any(
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "_ultra_private_bridge_timeout_seconds"
        for node in ast.walk(bridge_node)
    )


@pytest.mark.asyncio
async def test_approved_safe_local_read_runs_once_end_to_end_through_private_seam():
    actions = []
    mcp_calls = []
    gate_calls = []

    async def bridge(token, action, payload):
        actions.append((token, action, payload))
        if action == "claim":
            return {
                "calls": [
                    {
                        "call_id": "call-safe",
                        "name": "local_search",
                        "arguments": '{"query":"approved"}',
                        "payload_digest": DIGEST,
                        "output_index": 0,
                    }
                ]
            }
        if action in {"dispatch-start", "heartbeat"}:
            return None
        return {
            "kind": "final",
            "content": "root-only final",
            "usage": {"prompt_tokens": 2, "completion_tokens": 1, "total_tokens": 3},
            "ultra_audit": {
                "child_agent_count": 1,
                "tool_call_count": 1,
                "child_tool_call_count": 0,
                "tool_result_count": 1,
                "continuation_count": 1,
                "arguments_logged": False,
                "results_logged": False,
            },
        }

    async def mcp_call(**kwargs):
        mcp_calls.append(kwargs)
        return {"rows": [{"private": "tool output"}]}

    execute = _load_private_seam(bridge, mcp_call, gate_calls)
    response = await execute(
        TOKEN,
        request=object(),
        user=SimpleNamespace(id="user-1"),
        metadata={
            "chat_id": "chat-1",
            "tools": {"local_search": _tool("local_search", "search")},
        },
        extra_params={},
        event_emitter=object(),
    )

    assert gate_calls == [("local_search", {"query": "approved"})]
    assert len(mcp_calls) == 1
    assert mcp_calls[0]["function_name"] == "search"
    assert mcp_calls[0]["function_args"] == {"query": "approved"}
    assert mcp_calls[0]["suppress_observability"] is True
    assert [action for _, action, _ in actions] == [
        "claim",
        "dispatch-start",
        "results",
    ]
    assert response["choices"][0]["delta"]["content"] == "root-only final"
    assert response["ultra_audit"]["child_tool_call_count"] == 0
    assert response["ultra_audit"]["arguments_logged"] is False
    assert response["ultra_audit"]["results_logged"] is False
    serialized = repr(response)
    for private in (TOKEN, "call-safe", DIGEST, "tool output", "local_search"):
        assert private not in serialized


@pytest.mark.asyncio
async def test_approved_safe_local_openapi_read_runs_once_through_private_seam():
    actions = []
    openapi_calls = []
    gate_calls = []

    async def bridge(token, action, payload):
        actions.append((token, action, payload))
        if action == "claim":
            return {
                "calls": [
                    {
                        "call_id": "call-openapi-safe",
                        "name": "web_tools_web_search",
                        "arguments": '{"query":"approved"}',
                        "payload_digest": DIGEST,
                        "output_index": 0,
                    }
                ]
            }
        if action in {"dispatch-start", "heartbeat"}:
            return None
        return {
            "kind": "final",
            "content": "root-only final",
            "usage": {"prompt_tokens": 2, "completion_tokens": 1, "total_tokens": 3},
            "ultra_audit": {
                "child_agent_count": 1,
                "tool_call_count": 1,
                "child_tool_call_count": 0,
                "tool_result_count": 1,
                "continuation_count": 1,
                "arguments_logged": False,
                "results_logged": False,
            },
        }

    async def fail_mcp_call(**_kwargs):
        raise AssertionError("OpenAPI execution must not use the MCP transport")

    async def openapi_call(request, tool, parsed_args, extra_params):
        openapi_calls.append((request, tool, parsed_args, extra_params))
        return {"rows": [{"private": "openapi tool output"}]}

    execute = _load_private_seam(
        bridge,
        fail_mcp_call,
        gate_calls,
        openapi_call=openapi_call,
    )
    request = object()
    response = await execute(
        TOKEN,
        request=request,
        user=SimpleNamespace(id="user-1"),
        metadata={
            "chat_id": "chat-1",
            "tools": {"web_tools_web_search": _openapi_tool()},
        },
        extra_params={},
        event_emitter=object(),
    )

    assert gate_calls == [("web_tools_web_search", {"query": "approved"})]
    assert len(openapi_calls) == 1
    assert openapi_calls[0][0] is request
    assert openapi_calls[0][1]["server_id"] == "web-tools"
    assert openapi_calls[0][2] == {"query": "approved"}
    assert [action for _, action, _ in actions] == [
        "claim",
        "dispatch-start",
        "results",
    ]
    assert response["choices"][0]["delta"]["content"] == "root-only final"
    assert response["ultra_audit"]["child_tool_call_count"] == 0
    serialized = repr(response)
    for private in (
        TOKEN,
        "call-openapi-safe",
        DIGEST,
        "approved",
        "openapi tool output",
    ):
        assert private not in serialized


@pytest.mark.asyncio
async def test_write_shaped_tool_is_rejected_before_gate_marker_or_dispatch():
    actions = []
    mcp_calls = []
    gate_calls = []

    async def bridge(token, action, payload):
        actions.append((token, action, payload))
        return {
            "calls": [
                {
                    "call_id": "call-write",
                    "name": "local_write_note",
                    "arguments": '{"query":"mutate"}',
                    "payload_digest": DIGEST,
                    "output_index": 0,
                }
            ]
        }

    async def mcp_call(**kwargs):
        mcp_calls.append(kwargs)
        return {"ok": True}

    execute = _load_private_seam(bridge, mcp_call, gate_calls)
    with pytest.raises(EXECUTOR.UltraToolDenied):
        await execute(
            TOKEN,
            request=object(),
            user=SimpleNamespace(id="user-1"),
            metadata={
                "chat_id": "chat-1",
                "tools": {"local_write_note": _tool("local_write_note", "write_note")},
            },
            extra_params={},
            event_emitter=object(),
        )

    assert [action for _, action, _ in actions] == ["claim"]
    assert gate_calls == []
    assert mcp_calls == []


def test_private_sentinel_is_intercepted_before_generic_filters_and_never_retried():
    source = MIDDLEWARE_PATH.read_text(encoding="utf-8")
    sentinel = source.index("token = private_batch_token(data)")
    audit_capture = source.index("candidate_ultra_audit =", sentinel)
    filter_call = source.index("process_filter_functions(", sentinel)
    assert sentinel < audit_capture < filter_call
    assert source[source.rfind("\n", 0, sentinel) + 1 : sentinel] == source[
        source.rfind("\n", 0, audit_capture) + 1 : audit_capture
    ]
    assert "sanitized_ultra_audit(candidate_ultra_audit)" in source[
        audit_capture:filter_call
    ]
    assert "ultra_requested = is_ultra_request(form_data)" in source
    ultra_error = source.index("except UltraToolExecutionError:", filter_call)
    generic_error = source.index("except Exception", ultra_error)
    assert filter_call < ultra_error < generic_error
    seam = source[
        source.index("async def _execute_ultra_private_control") : source.index(
            "\n\nasync def",
            source.index("async def _execute_ultra_private_control") + 10,
        )
    ]
    assert seam.index("_apply_tool_confirmation_gate(") < seam.index(
        "await mark_dispatch_started()"
    )
    assert seam.index("await mark_dispatch_started()") < seam.index(
        "call_mcp_tool_with_runtime_headers("
    )
    assert "process_tool_result" not in seam
