"""Private, no-retry Ultra tool-batch orchestration.

The opaque bridge token and tool payloads never enter content blocks or the
generic chat stream.  This module deliberately accepts callbacks for bridge
I/O and tool invocation so its state machine stays independently testable.
"""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass
from typing import Any, Awaitable, Callable
from urllib.parse import urlsplit

MAX_CONTINUATIONS = 32
MAX_CALLS_PER_BATCH = 64
MAX_ARGUMENT_BYTES = 256 * 1024
MAX_RESULT_BYTES = 256 * 1024
TOKEN_RE = re.compile(r"^[0-9a-f]{32}$")
DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")
MANAGED_MCP_HOST_RE = re.compile(r"^(?:mcpo|mcp-orc|mcpo-[a-z0-9][a-z0-9_-]{0,126})$")
MAX_AUDIT_TOOL_COUNT = 256
MAX_AUDIT_CONTINUATIONS = 32

_BANNED_TOOL_FRAGMENTS = (
    "run_subagent",
    "subagent",
    "agent_vm",
    "code_interpreter",
    "code_execution",
    "execute_code",
    "python",
    "shell",
    "terminal",
    "oauth",
    "authorize",
    "authenticate",
    "login",
    "guided_setup",
    "activate_integration",
    "toggle_integration",
    "ui_component",
    "render_ui",
    "browser",
    "computer_use",
)
_SIDE_EFFECT_FRAGMENTS = (
    "create",
    "update",
    "delete",
    "remove",
    "send",
    "post",
    "write",
    "edit",
    "set_",
    "cancel",
    "run_",
    "start",
    "stop",
    "trigger",
    "upload",
    "share",
)
_READ_FRAGMENTS = (
    "get",
    "list",
    "read",
    "search",
    "lookup",
    "find",
    "fetch",
    "query",
    "status",
    "health",
    "inspect",
    "describe",
    "view",
)
_PRESENTATION_WORDS = (
    "embedded ui",
    "html",
    "image",
    "screenshot",
    "video",
    "audio",
    "download",
    "attachment",
    "binary",
)
_PRESENTATION_KEYS = {
    "authorization_url",
    "login_url",
    "oauth_url",
    "embed",
    "embeds",
    "file",
    "files",
    "html",
    "image",
    "images",
    "screenshot",
    "ui_component",
}


class UltraToolExecutionError(RuntimeError):
    """Fail-closed error before or after private tool execution."""


class UltraAmbiguousDispatchError(UltraToolExecutionError):
    """A call may have executed; the caller must never retry it."""


class UltraToolDenied(UltraToolExecutionError):
    """Confirmation or eligibility denied before any dispatch marker."""


@dataclass(frozen=True)
class PrivateUltraCall:
    call_id: str
    name: str
    arguments: str
    payload_digest: str
    output_index: int


def private_batch_token(data: Any) -> str | None:
    if not isinstance(data, dict) or set(data) != {"__portico_ultra_private_batch"}:
        return None
    control = data.get("__portico_ultra_private_batch")
    if not isinstance(control, dict) or set(control) != {"token"}:
        raise UltraToolExecutionError("Malformed private Ultra batch control")
    token = control.get("token")
    if not isinstance(token, str) or not TOKEN_RE.fullmatch(token):
        raise UltraToolExecutionError("Malformed private Ultra batch token")
    return token


def _is_local_mcp_url(raw_url: Any) -> bool:
    try:
        parsed = urlsplit(str(raw_url or "").strip())
        if (
            parsed.scheme != "http"
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.fragment
        ):
            return False
        host = parsed.hostname.lower()
        if host in {"localhost", "127.0.0.1", "::1", "host.docker.internal"}:
            return True
        return MANAGED_MCP_HOST_RE.fullmatch(host) is not None
    except Exception:
        return False


def _is_managed_openapi_url(raw_url: Any) -> bool:
    try:
        parsed = urlsplit(str(raw_url or "").strip())
        return bool(
            parsed.scheme == "http"
            and parsed.hostname
            and parsed.username is None
            and parsed.password is None
            and not parsed.query
            and not parsed.fragment
            and MANAGED_MCP_HOST_RE.fullmatch(parsed.hostname.lower())
        )
    except Exception:
        return False


def _presentation_free_contract(spec: Any) -> bool:
    if not isinstance(spec, dict):
        return False
    output_schema = spec.get("outputSchema", spec.get("output_schema"))
    if isinstance(output_schema, dict) and output_schema.get("type") in {
        "object",
        "array",
        "string",
        "number",
        "integer",
        "boolean",
    }:
        return True
    metadata = spec.get("_meta")
    if (
        isinstance(metadata, dict)
        and metadata.get("porticoPresentationFreeTextJson") is True
    ):
        return True
    description = str(spec.get("description") or "").strip().lower()
    return "return" in description and not any(
        word in description for word in _PRESENTATION_WORDS
    )


def require_eligible_local_mcp_tool(name: str, tool: Any) -> dict[str, Any]:
    normalized_name = str(name or "").strip().lower()
    if (
        not normalized_name
        or any(fragment in normalized_name for fragment in _BANNED_TOOL_FRAGMENTS)
        or any(fragment in normalized_name for fragment in _SIDE_EFFECT_FRAGMENTS)
        or not any(fragment in normalized_name for fragment in _READ_FRAGMENTS)
    ):
        raise UltraToolDenied("Ultra tool is not eligible for private local execution")
    if not isinstance(tool, dict) or tool.get("direct") is True:
        raise UltraToolDenied("Ultra accepts only non-direct app-local tools")
    if (
        not isinstance(tool.get("server_id"), str)
        or not tool.get("server_id", "").strip()
    ):
        raise UltraToolDenied("Ultra server identity is incomplete")

    operation_name = None
    tool_type = tool.get("type")
    if tool_type == "mcp":
        connection = tool.get("mcp_server_connection")
        if not isinstance(connection, dict) or not _is_local_mcp_url(
            connection.get("url")
        ):
            raise UltraToolDenied("Ultra MCP server is not app-local")
        operation_name = tool.get("original_name")
    elif tool_type == "external":
        server_data = tool.get("tool_server_data")
        connection = tool.get("tool_server_connection")
        tool_id = str(tool.get("tool_id") or "").split("|", 1)[0]
        server_id = tool["server_id"].strip()
        if (
            not isinstance(server_data, dict)
            or not _is_managed_openapi_url(server_data.get("url"))
            or not isinstance(connection, dict)
            or not _is_managed_openapi_url(connection.get("url"))
            or tool_id != f"server:{server_id}"
        ):
            raise UltraToolDenied("Ultra OpenAPI server is not app-local")
        operation_name = tool.get("server_operation_name")
    else:
        raise UltraToolDenied("Ultra accepts only local MCP or OpenAPI tools")

    if not isinstance(operation_name, str) or not operation_name.strip():
        raise UltraToolDenied("Ultra operation identity is incomplete")
    full_identity = " ".join(
        (
            normalized_name,
            tool["server_id"].strip().lower(),
            operation_name.strip().lower(),
        )
    )
    if any(fragment in full_identity for fragment in _BANNED_TOOL_FRAGMENTS) or any(
        fragment in full_identity for fragment in _SIDE_EFFECT_FRAGMENTS
    ):
        raise UltraToolDenied("Ultra operation identity is not read-only")
    if not _presentation_free_contract(tool.get("spec")):
        raise UltraToolDenied("Ultra tool lacks a presentation-free text/JSON contract")
    return tool


def _reject_presentation_payload(value: Any) -> None:
    if isinstance(value, dict):
        lowered_keys = {str(key).strip().lower() for key in value}
        if lowered_keys.intersection(_PRESENTATION_KEYS):
            raise UltraToolExecutionError(
                "Ultra tool returned presentation-dependent content"
            )
        content = value.get("content")
        if isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and str(
                    part.get("type") or ""
                ).lower() not in {
                    "",
                    "text",
                    "json",
                }:
                    raise UltraToolExecutionError(
                        "Ultra MCP result contains a non-text content part"
                    )
        for nested in value.values():
            _reject_presentation_payload(nested)
    elif isinstance(value, list):
        for nested in value:
            _reject_presentation_payload(nested)
    elif isinstance(value, (bytes, bytearray, memoryview)):
        raise UltraToolExecutionError("Ultra tool returned binary content")


def bounded_text_or_json_result(value: Any) -> Any:
    if hasattr(value, "status_code") or hasattr(value, "body"):
        raise UltraToolExecutionError("Ultra tool returned an HTTP/UI response")
    if isinstance(value, tuple):
        raise UltraToolExecutionError(
            "Ultra tool returned response headers or an attachment"
        )
    if not isinstance(value, (str, dict, list, int, float, bool)) and value is not None:
        raise UltraToolExecutionError("Ultra tool result is not text or JSON")
    _reject_presentation_payload(value)
    try:
        serialized = (
            value
            if isinstance(value, str)
            else json.dumps(
                value, separators=(",", ":"), ensure_ascii=False, allow_nan=False
            )
        )
    except (TypeError, ValueError) as exc:
        raise UltraToolExecutionError("Ultra tool result is not bounded JSON") from exc
    if len(serialized.encode("utf-8")) > MAX_RESULT_BYTES:
        raise UltraToolExecutionError(
            "Ultra tool result exceeds the private output limit"
        )
    return value


def _validated_call(raw: Any, expected_position: int) -> PrivateUltraCall:
    if not isinstance(raw, dict) or set(raw) != {
        "call_id",
        "name",
        "arguments",
        "payload_digest",
        "output_index",
    }:
        raise UltraToolExecutionError("Malformed private Ultra call")
    call_id = raw.get("call_id")
    name = raw.get("name")
    arguments = raw.get("arguments")
    digest = raw.get("payload_digest")
    output_index = raw.get("output_index")
    if not all(
        isinstance(value, str) and value.strip() for value in (call_id, name, arguments)
    ):
        raise UltraToolExecutionError("Private Ultra call identity is incomplete")
    if not isinstance(digest, str) or not DIGEST_RE.fullmatch(digest):
        raise UltraToolExecutionError("Private Ultra call digest is invalid")
    if not isinstance(output_index, int) or output_index < 0:
        raise UltraToolExecutionError("Private Ultra output index is invalid")
    if len(arguments.encode("utf-8")) > MAX_ARGUMENT_BYTES:
        raise UltraToolExecutionError("Private Ultra arguments exceed the safe limit")
    # Calls are returned in the bridge's immutable terminal-output order. The
    # output index need not be contiguous because private reasoning items can
    # occupy indexes between calls.
    return PrivateUltraCall(call_id, name, arguments, digest, output_index)


def _validated_claim(value: Any) -> list[PrivateUltraCall]:
    if not isinstance(value, dict) or not isinstance(value.get("calls"), list):
        raise UltraToolExecutionError("Malformed private Ultra claim response")
    raw_calls = value["calls"]
    if not raw_calls or len(raw_calls) > MAX_CALLS_PER_BATCH:
        raise UltraToolExecutionError("Private Ultra batch has an invalid call count")
    calls = [_validated_call(raw, position) for position, raw in enumerate(raw_calls)]
    if len({call.call_id for call in calls}) != len(calls):
        raise UltraToolExecutionError("Private Ultra batch repeats a call ID")
    if len({call.payload_digest for call in calls}) != len(calls):
        raise UltraToolExecutionError("Private Ultra batch repeats a call payload")
    return calls


def sanitized_ultra_audit(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise UltraToolExecutionError("Ultra audit counters are unavailable")
    allowed = {
        "child_agent_count",
        "tool_call_count",
        "child_tool_call_count",
        "tool_result_count",
        "continuation_count",
        "arguments_logged",
        "results_logged",
    }
    if set(value) != allowed:
        raise UltraToolExecutionError("Ultra audit payload is not sanitized")
    for key in (
        "child_agent_count",
        "tool_call_count",
        "child_tool_call_count",
        "tool_result_count",
        "continuation_count",
    ):
        limit = (
            MAX_AUDIT_CONTINUATIONS
            if key == "continuation_count"
            else MAX_AUDIT_TOOL_COUNT
        )
        if type(value.get(key)) is not int or value[key] < 0 or value[key] > limit:
            raise UltraToolExecutionError("Ultra audit counter is invalid")
    if (
        value.get("arguments_logged") is not False
        or value.get("results_logged") is not False
    ):
        raise UltraToolExecutionError("Ultra audit privacy flags are invalid")
    return {key: value[key] for key in sorted(allowed)}


BridgeCall = Callable[[str, str, Any], Awaitable[Any]]
ExecuteCall = Callable[
    [
        PrivateUltraCall,
        Callable[[], Awaitable[None]],
        Callable[[], Awaitable[None]],
    ],
    Awaitable[Any],
]


async def run_private_ultra_batches(
    initial_token: str,
    *,
    bridge_call: BridgeCall,
    execute_call: ExecuteCall,
) -> dict[str, Any]:
    if not TOKEN_RE.fullmatch(str(initial_token or "")):
        raise UltraToolExecutionError("Private Ultra token is invalid")
    token = initial_token
    any_dispatch_started = False

    for _ in range(MAX_CONTINUATIONS):
        try:
            calls = _validated_claim(await bridge_call(token, "claim", None))
        except UltraToolExecutionError as exc:
            if any_dispatch_started:
                raise UltraAmbiguousDispatchError(
                    "Ultra bridge state is unavailable after dispatch; retry is forbidden"
                ) from exc
            raise
        except Exception as exc:
            if any_dispatch_started:
                raise UltraAmbiguousDispatchError(
                    "Ultra bridge state is unavailable after dispatch; retry is forbidden"
                ) from exc
            raise UltraToolExecutionError("Ultra batch claim failed") from exc

        results = []
        for call in calls:
            call_started = False
            dispatch_attempted = False

            async def mark_dispatch_started() -> None:
                nonlocal call_started, dispatch_attempted, any_dispatch_started
                if dispatch_attempted:
                    raise UltraAmbiguousDispatchError(
                        "Ultra call dispatch was already marked"
                    )
                dispatch_attempted = True
                any_dispatch_started = True
                await bridge_call(
                    token,
                    "dispatch-start",
                    {"call_id": call.call_id, "payload_digest": call.payload_digest},
                )
                call_started = True

            async def heartbeat() -> None:
                if not call_started:
                    raise UltraToolExecutionError("Ultra heartbeat preceded dispatch")
                await bridge_call(
                    token,
                    "heartbeat",
                    {"call_id": call.call_id, "payload_digest": call.payload_digest},
                )

            try:
                result = await execute_call(call, mark_dispatch_started, heartbeat)
                if not call_started:
                    raise UltraToolExecutionError(
                        "Ultra executor returned without a dispatch marker"
                    )
                result = bounded_text_or_json_result(result)
            except UltraToolDenied as exc:
                if any_dispatch_started:
                    raise UltraAmbiguousDispatchError(
                        "Ultra batch stopped after a prior dispatch; retry is forbidden"
                    ) from exc
                raise
            except Exception as exc:
                if dispatch_attempted:
                    raise UltraAmbiguousDispatchError(
                        "Ultra tool outcome is ambiguous; automatic retry is forbidden"
                    ) from exc
                if isinstance(exc, UltraToolExecutionError):
                    raise
                raise UltraToolExecutionError("Ultra tool preparation failed") from exc
            results.append(
                {
                    "call_id": call.call_id,
                    "payload_digest": call.payload_digest,
                    "output": result,
                }
            )

        try:
            continuation = await bridge_call(token, "results", {"results": results})
        except Exception as exc:
            raise UltraAmbiguousDispatchError(
                "Ultra continuation failed after dispatch; automatic retry is forbidden"
            ) from exc
        if not isinstance(continuation, dict):
            raise UltraAmbiguousDispatchError("Malformed Ultra continuation response")
        if continuation.get("kind") == "batch":
            next_token = continuation.get("token")
            if (
                not isinstance(next_token, str)
                or not TOKEN_RE.fullmatch(next_token)
                or next_token == token
            ):
                raise UltraAmbiguousDispatchError(
                    "Ultra continuation token rotation failed"
                )
            token = next_token
            continue
        if continuation.get("kind") == "final":
            content = continuation.get("content")
            usage = continuation.get("usage")
            if (
                not isinstance(content, str)
                or not content.strip()
                or not isinstance(usage, dict)
            ):
                raise UltraAmbiguousDispatchError("Malformed Ultra terminal response")
            return {
                "content": content,
                "usage": usage,
                "ultra_audit": sanitized_ultra_audit(continuation.get("ultra_audit")),
            }
        raise UltraAmbiguousDispatchError("Unknown Ultra continuation response")

    raise UltraAmbiguousDispatchError("Ultra exceeded the continuation safety limit")


async def await_once_with_heartbeat(
    invocation: Awaitable[Any],
    heartbeat: Callable[[], Awaitable[None]],
    *,
    interval_seconds: float = 15.0,
) -> Any:
    task = asyncio.create_task(invocation)
    try:
        while True:
            done, _ = await asyncio.wait({task}, timeout=interval_seconds)
            if done:
                return await task
            await heartbeat()
    except BaseException:
        if not task.done():
            task.cancel()
        raise


__all__ = [
    "PrivateUltraCall",
    "UltraAmbiguousDispatchError",
    "UltraToolDenied",
    "UltraToolExecutionError",
    "await_once_with_heartbeat",
    "bounded_text_or_json_result",
    "private_batch_token",
    "require_eligible_local_mcp_tool",
    "run_private_ultra_batches",
    "sanitized_ultra_audit",
]
