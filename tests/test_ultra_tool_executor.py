import importlib.util
import sys
from pathlib import Path

import pytest

MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "src"
    / "patches"
    / "backend"
    / "open_webui"
    / "utils"
    / "ultra_tool_executor.py"
)
SPEC = importlib.util.spec_from_file_location(
    "test_ultra_tool_executor_module", MODULE_PATH
)
EXECUTOR = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = EXECUTOR
SPEC.loader.exec_module(EXECUTOR)

TOKEN_A = "a" * 32
TOKEN_B = "b" * 32
DIGEST_A = "1" * 64
DIGEST_B = "2" * 64


def call_payload(call_id="call-a", name="local_search", digest=DIGEST_A, index=0):
    return {
        "call_id": call_id,
        "name": name,
        "arguments": '{"query":"safe"}',
        "payload_digest": digest,
        "output_index": index,
    }


def audit(calls=1, results=1, continuations=1, children=1, child_calls=1):
    return {
        "child_agent_count": children,
        "tool_call_count": calls,
        "child_tool_call_count": child_calls,
        "tool_result_count": results,
        "continuation_count": continuations,
        "arguments_logged": False,
        "results_logged": False,
    }


def local_read_tool(**overrides):
    tool = {
        "type": "mcp",
        "direct": False,
        "server_id": "local-search",
        "original_name": "search",
        "mcp_server_connection": {"url": "http://mcp-orc:8000/mcp"},
        "spec": {
            "name": "local_search",
            "description": "Returns local JSON search results.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
            "outputSchema": {"type": "object"},
        },
    }
    tool.update(overrides)
    return tool


def local_openapi_read_tool(**overrides):
    managed_url = "http://" + "mcpo-core" + ":8081/web-tools"
    tool = {
        "type": "external",
        "server_id": "web-tools",
        "server_operation_name": "web_search",
        "tool_id": "server:web-tools",
        "tool_server_data": {
            "url": managed_url,
            "openapi": {"paths": {}},
        },
        "tool_server_connection": {
            "url": managed_url,
            "type": "openapi",
        },
        "spec": {
            "name": "web_tools_web_search",
            "description": "Returns local JSON search results.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
            "outputSchema": {"type": "object"},
        },
    }
    tool.update(overrides)
    return tool


def test_private_control_and_eligibility_are_strict():
    assert (
        EXECUTOR.private_batch_token({"__portico_ultra_private_batch": {"token": TOKEN_A}})
        == TOKEN_A
    )
    assert EXECUTOR.private_batch_token({"choices": []}) is None
    with pytest.raises(EXECUTOR.UltraToolExecutionError):
        EXECUTOR.private_batch_token(
            {"__portico_ultra_private_batch": {"token": TOKEN_A, "leak": "x"}}
        )

    assert (
        EXECUTOR.require_eligible_local_mcp_tool("local_search", local_read_tool())[
            "server_id"
        ]
        == "local-search"
    )
    for managed_url in (
        "http://mcpo-core:8081/mcp",
        "http://mcpo-glean:8000/mcp",
        "http://host.docker.internal:8890/mcp",
        "http://127.0.0.1:8890/mcp",
    ):
        tool = local_read_tool(mcp_server_connection={"url": managed_url})
        assert EXECUTOR.require_eligible_local_mcp_tool("local_search", tool)
    assert (
        EXECUTOR.require_eligible_local_mcp_tool(
            "web_tools_web_search", local_openapi_read_tool()
        )["server_id"]
        == "web-tools"
    )
    denied = [
        ("run_subagent", local_read_tool()),
        ("execute_code", local_read_tool()),
        ("oauth_authorize", local_read_tool()),
        ("local_post_message", local_read_tool()),
        ("unknown_operation", local_read_tool()),
        ("local_search", local_read_tool(direct=True)),
        ("local_search", local_read_tool(type="external")),
        ("web_tools_web_search", local_openapi_read_tool(direct=True)),
        (
            "web_tools_web_search",
            local_openapi_read_tool(tool_id="server:other"),
        ),
        (
            "web_tools_web_search",
            local_openapi_read_tool(
                tool_server_data={
                    "url": "https://public.example/tools",
                    "openapi": {"paths": {}},
                }
            ),
        ),
        (
            "web_tools_web_search",
            local_openapi_read_tool(
                tool_server_connection={
                    "url": "http://host.docker.internal:8890/web-tools",
                    "type": "openapi",
                }
            ),
        ),
        (
            "local_search",
            local_read_tool(
                mcp_server_connection={"url": "https://public.example/mcp"}
            ),
        ),
        (
            "local_search",
            local_read_tool(
                mcp_server_connection={"url": "http://169.254.169.254/latest/meta-data"}
            ),
        ),
        (
            "local_search",
            local_read_tool(mcp_server_connection={"url": "http://10.2.3.4/mcp"}),
        ),
        (
            "local_search",
            local_read_tool(mcp_server_connection={"url": "http://evil:8000/mcp"}),
        ),
        (
            "local_search",
            local_read_tool(mcp_server_connection={"url": "http://corp.internal/mcp"}),
        ),
        (
            "local_search",
            local_read_tool(original_name="write_note"),
        ),
        (
            "local_search",
            local_read_tool(server_id="agent_vm", original_name="read"),
        ),
        (
            "local_search",
            local_read_tool(
                spec={
                    "description": "Displays an embedded UI image.",
                    "parameters": {"type": "object", "properties": {}},
                }
            ),
        ),
    ]
    for name, tool in denied:
        with pytest.raises(EXECUTOR.UltraToolDenied):
            EXECUTOR.require_eligible_local_mcp_tool(name, tool)


def test_ultra_audit_counters_are_bounded_and_boolean_counts_are_rejected():
    assert (
        EXECUTOR.sanitized_ultra_audit(audit(256, 256, 32))["continuation_count"] == 32
    )
    for invalid in (
        audit(257, 1, 1),
        audit(1, 1, 1, 257),
        audit(1, 1, 1, 1, 257),
        audit(1, 257, 1),
        audit(1, 1, 33),
        {
            **audit(),
            "tool_call_count": True,
        },
        {
            **audit(),
            "child_tool_call_count": True,
        },
    ):
        with pytest.raises(EXECUTOR.UltraToolExecutionError):
            EXECUTOR.sanitized_ultra_audit(invalid)


def test_tool_results_are_bounded_text_or_json_without_presentation_payloads():
    assert EXECUTOR.bounded_text_or_json_result(
        {"content": [{"type": "text", "text": "ok"}]}
    )
    for value in (
        b"binary",
        ("body", {"Content-Disposition": "attachment"}),
        {"files": [{"url": "private"}]},
        {"content": [{"type": "image", "data": "private"}]},
        {"authorization_url": "http://private-oauth/authorize"},
        "x" * (EXECUTOR.MAX_RESULT_BYTES + 1),
    ):
        with pytest.raises(EXECUTOR.UltraToolExecutionError):
            EXECUTOR.bounded_text_or_json_result(value)


@pytest.mark.asyncio
async def test_private_batch_executes_once_in_order_and_returns_only_sanitized_terminal_data():
    actions = []

    async def bridge(token, action, payload):
        actions.append((token, action, payload))
        if action == "claim":
            return {"calls": [call_payload()]}
        if action in {"dispatch-start", "heartbeat"}:
            return None
        return {
            "kind": "final",
            "content": "safe final",
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 2,
                "total_tokens": 12,
                "prompt_tokens_details": {"cached_read_tokens": 4},
                "cost": 0.001,
            },
            "ultra_audit": audit(),
        }

    invocations = 0

    async def execute(call, mark, heartbeat):
        nonlocal invocations
        await mark()
        await heartbeat()
        invocations += 1
        return {"content": [{"type": "text", "text": "private result"}]}

    final = await EXECUTOR.run_private_ultra_batches(
        TOKEN_A, bridge_call=bridge, execute_call=execute
    )
    assert invocations == 1
    assert [action for _, action, _ in actions] == [
        "claim",
        "dispatch-start",
        "heartbeat",
        "results",
    ]
    assert final == {
        "content": "safe final",
        "usage": {
            "prompt_tokens": 10,
            "completion_tokens": 2,
            "total_tokens": 12,
            "prompt_tokens_details": {"cached_read_tokens": 4},
            "cost": 0.001,
        },
        "ultra_audit": audit(),
    }
    terminal_dump = repr(final)
    for private in (TOKEN_A, "call-a", DIGEST_A, "private result", "local_search"):
        assert private not in terminal_dump


@pytest.mark.asyncio
async def test_token_rotation_and_restart_after_dispatch_are_never_retried():
    actions = []
    claims = 0

    async def rotating_bridge(token, action, payload):
        nonlocal claims
        actions.append((token, action))
        if action == "claim":
            claims += 1
            return {
                "calls": [
                    call_payload(
                        call_id=f"call-{claims}",
                        digest=DIGEST_A if claims == 1 else DIGEST_B,
                    )
                ]
            }
        if action == "dispatch-start":
            return None
        if action == "results" and token == TOKEN_A:
            return {"kind": "batch", "token": TOKEN_B}
        if action == "results":
            return {
                "kind": "final",
                "content": "done",
                "usage": {},
                "ultra_audit": audit(2, 2, 2),
            }
        return None

    async def execute(call, mark, heartbeat):
        await mark()
        return "ok"

    final = await EXECUTOR.run_private_ultra_batches(
        TOKEN_A, bridge_call=rotating_bridge, execute_call=execute
    )
    assert final["content"] == "done"
    assert claims == 2
    assert actions.count((TOKEN_A, "dispatch-start")) == 1
    assert actions.count((TOKEN_B, "dispatch-start")) == 1

    failed_actions = []

    async def lost_results(token, action, payload):
        failed_actions.append(action)
        if action == "claim":
            return {"calls": [call_payload()]}
        if action == "dispatch-start":
            return None
        if action == "results":
            raise ConnectionError("restart")
        return None

    with pytest.raises(EXECUTOR.UltraAmbiguousDispatchError):
        await EXECUTOR.run_private_ultra_batches(
            TOKEN_A, bridge_call=lost_results, execute_call=execute
        )
    assert failed_actions.count("results") == 1
    assert failed_actions.count("dispatch-start") == 1


@pytest.mark.asyncio
async def test_denial_before_dispatch_never_marks_or_invokes():
    actions = []

    async def bridge(token, action, payload):
        actions.append(action)
        return {"calls": [call_payload()]}

    async def deny(call, mark, heartbeat):
        raise EXECUTOR.UltraToolDenied("confirmation required")

    with pytest.raises(EXECUTOR.UltraToolDenied):
        await EXECUTOR.run_private_ultra_batches(
            TOKEN_A, bridge_call=bridge, execute_call=deny
        )
    assert actions == ["claim"]
