import hashlib
import json
import logging
import os
import re
import threading
import time
from typing import Any, Callable
from urllib.parse import urlencode
from uuid import uuid4

import requests  # type: ignore[reportMissingModuleSource]


log = logging.getLogger(__name__)
AUTHORIZATION_SCHEME_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9._~+\-/]*\s+.+$")

CHAT_ID_HEADER = "X-OpenWebUI-Chat-Id"
MESSAGE_ID_HEADER = "X-OpenWebUI-Message-Id"
SESSION_ID_HEADER = "X-OpenWebUI-Session-Id"
TOOL_CALL_ID_HEADER = "X-OpenWebUI-Tool-Call-Id"
METADATA_HEADER_VALUE_MAX_CHARS = 512
METADATA_HEADER_PREFIX_MAX_CHARS = 96
MCP_LOGREPO_TYPE = "porticoAiChatMcpUsage"
MCP_LOGREPO_URL = os.getenv(
    "portico_MCP_LOGREPO_URL",
    "https://logrepo-clip.sandbox.example.invalid/logrepo",
)
MCP_LOGREPO_TIMEOUT_SECONDS = 2

_HTTP_STATUS_RE = re.compile(r"\bhttp(?:\s+error)?\s+(\d{3})\b", re.IGNORECASE)
_WRAPPED_HTTP_ERROR_RE = re.compile(
    r"^\s*http\s+error\s+(\d{3})\s*:\s*(.+?)\s*$",
    re.IGNORECASE | re.DOTALL,
)
_OAUTH_RECOVERY_MESSAGE_FRAGMENTS = (
    "oauth re-authorization required",
    "oauth reauthorization required",
    "re-authenticate",
    "reauthenticate",
    "invalid token",
    "invalid_token",
    "expired token",
    "token expired",
    "token has expired",
    "oauth_recovery_required",
)
_TIMEOUT_MESSAGE_FRAGMENTS = (
    "gateway timeout",
    "tool call exceeded configured timeout",
    "timeout exceeded",
    "timed out",
)
_NORMALIZED_TIMEOUT_MESSAGE = (
    "Tool execution timed out before the upstream server returned a result."
)
_TIMEOUT_SUGGESTED_ACTION = (
    "Do not retry the same synchronous call. Consider narrowing the request scope "
    "or using the tool's non-blocking mode if available."
)


def _normalize_oauth_server_id(server_id: str) -> str:
    splits = server_id.split(":")
    return splits[-1] if len(splits) > 1 else server_id


def _build_session_auth_header(request: Any) -> str | None:
    token = getattr(getattr(request, "state", None), "token", None)
    if token is None:
        return None
    return f"Bearer {token.credentials}"


def _safe_json_loads(value: str) -> Any | None:
    try:
        return json.loads(value)
    except (TypeError, ValueError, json.JSONDecodeError):
        return None


def _coerce_status_code(value: Any) -> int | None:
    try:
        if value in (None, ""):
            return None
        return int(value)
    except (TypeError, ValueError):
        return None


def _extract_message(value: Any) -> str:
    if isinstance(value, dict):
        nested_error = value.get("error")
        if isinstance(nested_error, dict):
            for key in ("message", "detail", "error"):
                if nested_error.get(key):
                    return str(nested_error[key])
        if isinstance(nested_error, str) and nested_error:
            return nested_error
        for key in ("message", "detail"):
            if value.get(key):
                return str(value[key])
    if isinstance(value, str):
        return value
    return str(value)


def _extract_status_code(value: Any) -> int | None:
    if isinstance(value, dict):
        direct_status = _coerce_status_code(value.get("status_code"))
        if direct_status is not None:
            return direct_status

        nested_error = value.get("error")
        if isinstance(nested_error, dict):
            nested_status = _coerce_status_code(
                nested_error.get("status_code") or nested_error.get("code")
            )
            if nested_status is not None:
                return nested_status

    message = _extract_message(value).strip()
    if not message:
        return None

    match = _HTTP_STATUS_RE.search(message)
    if match:
        return _coerce_status_code(match.group(1))

    return None


def _unwrap_wrapped_http_error(message: str) -> tuple[int | None, dict[str, Any] | None]:
    match = _WRAPPED_HTTP_ERROR_RE.match(str(message or "").strip())
    if not match:
        return None, None

    status_code = _coerce_status_code(match.group(1))
    wrapped_payload = _safe_json_loads(match.group(2))
    if isinstance(wrapped_payload, dict):
        return status_code, wrapped_payload

    return status_code, None


def _collect_oauth_fields(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}

    collected: dict[str, Any] = {}
    for key in (
        "authorization_url",
        "oauth_recovery_required",
        "force_auth_recommended",
        "server_id",
    ):
        candidate = value.get(key)
        if key == "authorization_url":
            if isinstance(candidate, str) and candidate.strip():
                collected[key] = candidate
        elif key == "server_id":
            if isinstance(candidate, str) and candidate.strip():
                collected[key] = candidate
        elif candidate:
            collected[key] = candidate

    nested_error = value.get("error")
    if isinstance(nested_error, dict):
        nested_fields = _collect_oauth_fields(nested_error)
        for key, candidate in nested_fields.items():
            collected.setdefault(key, candidate)

    return collected


def _message_has_oauth_recovery_hint(message: str) -> bool:
    lowered = str(message or "").strip().lower()
    if not lowered:
        return False
    if any(fragment in lowered for fragment in _OAUTH_RECOVERY_MESSAGE_FRAGMENTS):
        return True
    return "authorization_url" in lowered and '"authorization_url":null' not in lowered


def _collect_retry_policy_fields(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    collected: dict[str, Any] = {}
    for key in (
        "retry_policy_owner",
        "error_type",
        "retry_attempted",
        "recovery_state",
        "retry_after_seconds",
    ):
        if key in value and value[key] is not None:
            collected[key] = value[key]
    nested_error = value.get("error")
    if isinstance(nested_error, dict):
        for key, candidate in _collect_retry_policy_fields(nested_error).items():
            collected.setdefault(key, candidate)
    return collected


def _is_timeout_shaped_message(message: str) -> bool:
    lowered = str(message or "").strip().lower()
    if not lowered:
        return False
    return any(fragment in lowered for fragment in _TIMEOUT_MESSAGE_FRAGMENTS)


def normalize_tool_execution_error(error: Any) -> dict[str, Any]:
    if (
        isinstance(error, dict)
        and error.get("is_error") is True
        and isinstance(error.get("error"), dict)
    ):
        return dict(error)

    raw_message = _extract_message(error)
    wrapped_status_code, wrapped_payload = _unwrap_wrapped_http_error(raw_message)
    payload = wrapped_payload if isinstance(wrapped_payload, dict) else error

    oauth_fields = _collect_oauth_fields(payload)
    retry_policy_fields = _collect_retry_policy_fields(payload)
    message = _extract_message(payload).strip() if isinstance(payload, dict) else ""
    if not message:
        message = raw_message.strip() or "Tool execution failed."

    status_code = _extract_status_code(payload)
    if status_code is None:
        status_code = wrapped_status_code
    if status_code is None:
        status_code = _extract_status_code(raw_message)

    normalized_error: dict[str, Any] = {
        "message": message,
        "retry_recommended": False,
    }
    if status_code is not None:
        normalized_error["status_code"] = status_code

    normalized_payload: dict[str, Any] = {
        "is_error": True,
        "error": normalized_error,
    }
    normalized_payload.update(retry_policy_fields)

    oauth_recovery_required = bool(oauth_fields.get("oauth_recovery_required"))
    force_auth_recommended = bool(oauth_fields.get("force_auth_recommended"))
    if oauth_fields or _message_has_oauth_recovery_hint(message):
        normalized_error["error_type"] = "oauth_recovery"
        normalized_error["status_code"] = status_code or 401

        normalized_payload.update(oauth_fields)
        if oauth_recovery_required or _message_has_oauth_recovery_hint(message):
            normalized_payload["oauth_recovery_required"] = True
        if force_auth_recommended or normalized_payload.get("authorization_url"):
            normalized_payload["force_auth_recommended"] = True
        return normalized_payload

    if status_code == 504 or _is_timeout_shaped_message(message):
        normalized_error.update(
            {
                "message": _NORMALIZED_TIMEOUT_MESSAGE,
                "status_code": 504,
                "error_type": "tool_timeout",
                "suggested_action": _TIMEOUT_SUGGESTED_ACTION,
            }
        )

    return normalized_payload


def _normalize_authorization_header(
    headers: dict[str, str] | None,
) -> dict[str, str]:
    """Ensure raw Authorization token values are sent as Bearer tokens.

    Prompt-driven integration setup can persist `Authorization` header values that
    are just a raw token (without an auth scheme). Many providers reject those
    requests and require `Authorization: Bearer <token>`.
    """

    normalized = dict(headers or {})
    auth_key = next(
        (
            key
            for key in normalized
            if isinstance(key, str) and key.lower() == "authorization"
        ),
        None,
    )
    if not auth_key:
        return normalized

    auth_value = normalized.get(auth_key)
    if not isinstance(auth_value, str):
        return normalized

    auth_value = auth_value.strip()
    if not auth_value:
        return normalized

    # Do not rewrite malformed explicit schemes like "Bearer" (no token).
    # Preserve as-is so callers can surface the real upstream validation error.
    if auth_value.lower() in {"bearer", "basic"}:
        return normalized

    if AUTHORIZATION_SCHEME_PATTERN.match(auth_value):
        return normalized

    normalized[auth_key] = f"Bearer {auth_value}"
    return normalized


def _extract_access_token(oauth_token: Any) -> str | None:
    if not isinstance(oauth_token, dict):
        return None
    token = str(oauth_token.get("access_token", "") or "").strip()
    return token or None


def _is_malformed_authorization_override(value: Any) -> bool:
    if not isinstance(value, str):
        return True
    normalized = value.strip()
    if not normalized:
        return True
    return normalized.lower() in {"bearer", "basic"}


def _merge_connection_headers(
    base_headers: dict[str, str],
    connection_headers: dict[str, Any] | None,
) -> dict[str, str]:
    merged = dict(base_headers or {})
    if not isinstance(connection_headers, dict):
        return merged

    for key, value in connection_headers.items():
        if isinstance(key, str) and key.lower() == "authorization":
            if _is_malformed_authorization_override(value):
                continue
            merged["Authorization"] = str(value).strip()
            continue
        merged[key] = value
    return merged


def _metadata_value_to_string(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (str, int, float, bool)):
        return str(value)
    return json.dumps(value, sort_keys=True, default=str)


def _metadata_header_value_is_safe(value: str) -> bool:
    if len(value) > METADATA_HEADER_VALUE_MAX_CHARS:
        return False
    return all(32 <= ord(char) <= 126 for char in value)


def _metadata_header_prefix(value: str) -> str:
    chars = []
    for char in value[:METADATA_HEADER_PREFIX_MAX_CHARS]:
        if char.isascii() and (char.isalnum() or char in "._:-"):
            chars.append(char)
        else:
            chars.append("_")
    return "".join(chars).strip("._:-") or "tool-call"


def _bounded_tool_call_id_value(value: Any) -> str:
    rendered = _metadata_value_to_string(value)
    if not rendered.strip():
        return ""
    if _metadata_header_value_is_safe(rendered):
        return rendered

    digest = hashlib.sha256(rendered.encode("utf-8")).hexdigest()
    prefix = _metadata_header_prefix(rendered)
    max_prefix_chars = max(1, METADATA_HEADER_VALUE_MAX_CHARS - len(digest) - 1)
    if len(prefix) > max_prefix_chars:
        prefix = prefix[:max_prefix_chars].strip("._:-") or "tool-call"
    return f"{prefix}-{digest}"


def apply_openwebui_metadata_headers(
    headers: dict[str, str] | None,
    metadata: dict[str, Any] | None,
) -> dict[str, str]:
    merged_headers = dict(headers or {})
    metadata = metadata or {}

    if metadata.get("chat_id"):
        merged_headers[CHAT_ID_HEADER] = metadata.get("chat_id")
    if metadata.get("message_id"):
        merged_headers[MESSAGE_ID_HEADER] = metadata.get("message_id")
    if metadata.get("session_id"):
        merged_headers[SESSION_ID_HEADER] = metadata.get("session_id")
    if metadata.get("tool_call_id"):
        merged_headers[TOOL_CALL_ID_HEADER] = _bounded_tool_call_id_value(
            metadata.get("tool_call_id")
        )

    return merged_headers


def _prepare_runtime_metadata(metadata: dict[str, Any] | None) -> dict[str, Any]:
    runtime_metadata = dict(metadata or {})
    runtime_metadata.setdefault("tool_call_id", str(uuid4()))
    return runtime_metadata


def _stringify_logrepo_value(value: Any) -> str:
    return _metadata_value_to_string(value)


def _runtime_metadata_log_tool_call_id(runtime_metadata: dict[str, Any]) -> str:
    return _bounded_tool_call_id_value(runtime_metadata.get("tool_call_id"))


def _get_mapping_or_object_value(value: Any, field_name: str) -> Any:
    if isinstance(value, dict):
        return value.get(field_name)
    return getattr(value, field_name, None)


def _extract_user_ldap(user: Any, runtime_metadata: dict[str, Any]) -> str:
    for candidate in (
        os.getenv("PORTICO_USER_ID"),
        runtime_metadata.get("ldap"),
        _get_mapping_or_object_value(user, "ldap"),
    ):
        value = _stringify_logrepo_value(candidate).strip()
        if value:
            return value.split("@", 1)[0]

    email = _stringify_logrepo_value(
        _get_mapping_or_object_value(user, "email")
    ).strip()
    if email:
        return email.split("@", 1)[0]

    return ""


def _normalize_logrepo_identifier(value: Any) -> str:
    return str(value or "").strip().replace("-", "_").lower()


def _extract_logrepo_skill_name(
    *,
    server_id: str | None,
    function_name: str,
    function_args: dict[str, Any],
) -> str:
    normalized_tool_name = _normalize_logrepo_identifier(function_name)
    normalized_server_id = _normalize_logrepo_identifier(server_id).split(":")[-1]
    is_agent_vm_skill_script = normalized_tool_name == "agent_vm_execute_skill_script" or (
        normalized_server_id == "agent_vm" and normalized_tool_name == "execute_skill_script"
    )
    is_skills_server_skill_tool = normalized_server_id == "skills" and normalized_tool_name in {
        "skills_activate_skill",
        "skills_deactivate_skill",
        "skills_get_skill_reference",
        "skills_get_skill_assets",
    }
    if not (is_agent_vm_skill_script or is_skills_server_skill_tool):
        return ""

    return _stringify_logrepo_value(function_args.get("skill_name")).strip()


def _extract_logrepo_agent_name(runtime_metadata: dict[str, Any]) -> str:
    agent_name = _stringify_logrepo_value(runtime_metadata.get("agent_name")).strip()
    if agent_name:
        return agent_name

    model = runtime_metadata.get("model")
    if not model:
        return ""

    return _stringify_logrepo_value(
        _get_mapping_or_object_value(model, "name")
    ).strip()


def _emit_mcp_logrepo_event(
    *,
    user: Any,
    server_id: str | None,
    function_name: str,
    function_args: dict[str, Any],
    runtime_metadata: dict[str, Any],
    outcome: str,
    elapsed_ms: int,
) -> None:
    user_id = _get_mapping_or_object_value(user, "id") or runtime_metadata.get("user_id")
    ldap = _extract_user_ldap(user, runtime_metadata)
    agent_name = _extract_logrepo_agent_name(runtime_metadata)
    skill_name = _extract_logrepo_skill_name(
        server_id=server_id,
        function_name=function_name,
        function_args=function_args,
    )
    raw_payload = {
        "user_id": user_id,
        "ldap": ldap,
        "agent_name": agent_name,
        "skill_name": skill_name,
        "server_id": server_id,
        "tool_name": function_name,
        "outcome": outcome,
        "elapsed_ms": elapsed_ms,
        "tool_call_id": _runtime_metadata_log_tool_call_id(runtime_metadata),
        "chat_id": runtime_metadata.get("chat_id"),
        "message_id": runtime_metadata.get("message_id"),
        "session_id": runtime_metadata.get("session_id"),
        "ts": int(time.time() * 1000),
    }
    payload = {
        key: _stringify_logrepo_value(value) for key, value in raw_payload.items()
    }

    def post_to_clip() -> None:
        try:
            log_params = {
                "type": MCP_LOGREPO_TYPE,
                **payload,
            }
            body = urlencode(log_params) + "&&"
            requests.post(
                MCP_LOGREPO_URL,
                data=body.encode("utf-8"),
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                timeout=MCP_LOGREPO_TIMEOUT_SECONDS,
            )
        except Exception:
            pass

    try:
        threading.Thread(target=post_to_clip, daemon=True).start()
    except Exception:
        pass


def _log_tool_execution_start(
    label: str,
    *,
    server_id: str | None,
    function_name: str,
    runtime_metadata: dict[str, Any],
) -> None:
    log.info(
        "[%s] Executing tool server=%s tool=%s tool_call_id=%s chat_id=%s message_id=%s session_id=%s",
        label,
        server_id,
        function_name,
        _runtime_metadata_log_tool_call_id(runtime_metadata),
        runtime_metadata.get("chat_id"),
        runtime_metadata.get("message_id"),
        runtime_metadata.get("session_id"),
    )
    if not runtime_metadata.get("chat_id"):
        log.warning(
            "[%s] Missing chat_id when executing tool server=%s tool=%s tool_call_id=%s",
            label,
            server_id,
            function_name,
            _runtime_metadata_log_tool_call_id(runtime_metadata),
        )


def _log_tool_execution_finish(
    label: str,
    *,
    server_id: str | None,
    function_name: str,
    runtime_metadata: dict[str, Any],
    started_at: float,
    outcome: str,
) -> int:
    elapsed_ms = int((time.monotonic() - started_at) * 1000)
    log.info(
        "[%s] Tool %s server=%s tool=%s tool_call_id=%s chat_id=%s message_id=%s session_id=%s elapsed_ms=%s",
        label,
        outcome,
        server_id,
        function_name,
        _runtime_metadata_log_tool_call_id(runtime_metadata),
        runtime_metadata.get("chat_id"),
        runtime_metadata.get("message_id"),
        runtime_metadata.get("session_id"),
        elapsed_ms,
    )
    return elapsed_ms


async def build_mcp_request_headers(
    request: Any,
    user: Any,
    server_id: str,
    mcp_server_connection: dict[str, Any],
    extra_params: dict[str, Any] | None,
    metadata: dict[str, Any] | None,
    suppress_observability: bool = False,
) -> dict[str, str]:
    extra_params = extra_params or {}
    headers: dict[str, str] = {}

    auth_type = mcp_server_connection.get("auth_type", "")
    if auth_type == "bearer":
        token = str(mcp_server_connection.get("key", "") or "").strip()
        if token:
            headers["Authorization"] = f"Bearer {token}"
    elif auth_type == "none":
        pass
    elif auth_type == "session":
        auth_header = _build_session_auth_header(request)
        if auth_header:
            headers["Authorization"] = auth_header
    elif auth_type == "system_oauth":
        oauth_token = extra_params.get("__oauth_token__", None)
        oauth_access_token = _extract_access_token(oauth_token)
        if oauth_access_token:
            headers["Authorization"] = f"Bearer {oauth_access_token}"
    elif auth_type == "oauth_2.1":
        try:
            oauth_server_id = _normalize_oauth_server_id(server_id)
            oauth_token = await request.app.state.oauth_client_manager.get_oauth_token(
                user.id,
                f"mcp:{oauth_server_id}",
            )
            oauth_access_token = _extract_access_token(oauth_token)
            if oauth_access_token:
                headers["Authorization"] = f"Bearer {oauth_access_token}"
        except Exception as e:
            if not suppress_observability:
                log.error(f"Error getting OAuth token for MCP server {server_id}: {e}")

    headers = _merge_connection_headers(
        headers,
        mcp_server_connection.get("headers", None),
    )

    headers = _normalize_authorization_header(headers)
    return apply_openwebui_metadata_headers(headers, metadata)


async def build_openapi_request_headers(
    request: Any,
    user: Any,
    tool_server_connection: dict[str, Any],
    server_id: str | None,
    extra_params: dict[str, Any] | None,
    metadata: dict[str, Any] | None,
) -> tuple[dict[str, str], dict[str, str]]:
    extra_params = extra_params or {}
    headers: dict[str, str] = {"Content-Type": "application/json"}
    cookies: dict[str, str] = {}

    auth_type = tool_server_connection.get("auth_type", "bearer")
    if auth_type == "bearer":
        token = str(tool_server_connection.get("key", "") or "").strip()
        if token:
            headers["Authorization"] = f"Bearer {token}"
    elif auth_type == "none":
        pass
    elif auth_type == "session":
        cookies = getattr(request, "cookies", {}) or {}
        auth_header = _build_session_auth_header(request)
        if auth_header:
            headers["Authorization"] = auth_header
    elif auth_type == "system_oauth":
        cookies = getattr(request, "cookies", {}) or {}
        oauth_token = extra_params.get("__oauth_token__", None)
        oauth_access_token = _extract_access_token(oauth_token)
        if oauth_access_token:
            headers["Authorization"] = f"Bearer {oauth_access_token}"
    elif auth_type == "oauth_2.1":
        try:
            if user is not None and getattr(user, "id", None) and server_id:
                oauth_server_id = _normalize_oauth_server_id(server_id)
                oauth_token = await request.app.state.oauth_client_manager.get_oauth_token(
                    user.id,
                    f"mcp:{oauth_server_id}",
                )
                oauth_access_token = _extract_access_token(oauth_token)
                if oauth_access_token:
                    headers["Authorization"] = f"Bearer {oauth_access_token}"
        except Exception as e:
            log.error(
                f"Error getting OAuth token for OpenAPI server {server_id}: {e}"
            )

    headers = _merge_connection_headers(
        headers,
        tool_server_connection.get("headers", None),
    )

    headers = _normalize_authorization_header(headers)
    return apply_openwebui_metadata_headers(headers, metadata), cookies


async def call_mcp_tool_with_runtime_headers(
    *,
    client_factory: Callable[[], Any],
    request: Any,
    user: Any,
    server_id: str,
    mcp_server_connection: dict[str, Any],
    extra_params: dict[str, Any] | None,
    metadata: dict[str, Any] | None,
    function_name: str,
    function_args: dict[str, Any],
    suppress_observability: bool = False,
) -> Any:
    runtime_metadata = _prepare_runtime_metadata(metadata)
    if not suppress_observability:
        _log_tool_execution_start(
            "MCP_EXEC",
            server_id=server_id,
            function_name=function_name,
            runtime_metadata=runtime_metadata,
        )

    headers = await build_mcp_request_headers(
        request=request,
        user=user,
        server_id=server_id,
        mcp_server_connection=mcp_server_connection,
        extra_params=extra_params,
        metadata=runtime_metadata,
        suppress_observability=suppress_observability,
    )

    client = client_factory()
    started_at = time.monotonic()
    client_connected = False
    try:
        await client.connect(
            url=mcp_server_connection.get("url", ""),
            headers=headers if headers else None,
        )
        client_connected = True
        result = await client.call_tool(function_name, function_args=function_args)
        if not suppress_observability:
            elapsed_ms = _log_tool_execution_finish(
                "MCP_EXEC",
                server_id=server_id,
                function_name=function_name,
                runtime_metadata=runtime_metadata,
                started_at=started_at,
                outcome="completed",
            )
            _emit_mcp_logrepo_event(
                user=user,
                server_id=server_id,
                function_name=function_name,
                function_args=function_args,
                runtime_metadata=runtime_metadata,
                outcome="completed",
                elapsed_ms=elapsed_ms,
            )
        return result
    except Exception as exc:
        if not suppress_observability:
            elapsed_ms = _log_tool_execution_finish(
                "MCP_EXEC",
                server_id=server_id,
                function_name=function_name,
                runtime_metadata=runtime_metadata,
                started_at=started_at,
                outcome="failed",
            )
            _emit_mcp_logrepo_event(
                user=user,
                server_id=server_id,
                function_name=function_name,
                function_args=function_args,
                runtime_metadata=runtime_metadata,
                outcome="failed",
                elapsed_ms=elapsed_ms,
            )
            log.warning(
                "[MCP_EXEC] Normalizing tool failure server=%s tool=%s tool_call_id=%s raw_error=%s",
                server_id,
                function_name,
                _runtime_metadata_log_tool_call_id(runtime_metadata),
                exc,
            )
        return normalize_tool_execution_error(exc)
    finally:
        if client_connected:
            await client.disconnect()


async def call_openapi_tool_with_runtime_headers(
    *,
    execute_tool_server: Callable[..., Any],
    request: Any,
    user: Any,
    tool_server_connection: dict[str, Any],
    tool_server_data: dict[str, Any],
    extra_params: dict[str, Any] | None,
    metadata: dict[str, Any] | None,
    function_name: str,
    function_args: dict[str, Any],
) -> Any:
    runtime_metadata = _prepare_runtime_metadata(metadata)
    server_id = tool_server_data.get("id") or tool_server_connection.get(
        "info", {}
    ).get("id")
    _log_tool_execution_start(
        "OPENAPI_EXEC",
        server_id=server_id,
        function_name=function_name,
        runtime_metadata=runtime_metadata,
    )

    headers, cookies = await build_openapi_request_headers(
        request=request,
        user=user,
        tool_server_connection=tool_server_connection,
        server_id=server_id,
        extra_params=extra_params,
        metadata=runtime_metadata,
    )

    started_at = time.monotonic()
    try:
        response_data, _response_headers = await execute_tool_server(
            url=tool_server_data["url"],
            headers=headers,
            cookies=cookies,
            name=function_name,
            params=function_args,
            server_data=tool_server_data,
        )
    except Exception as exc:
        elapsed_ms = _log_tool_execution_finish(
            "OPENAPI_EXEC",
            server_id=server_id,
            function_name=function_name,
            runtime_metadata=runtime_metadata,
            started_at=started_at,
            outcome="failed",
        )
        _emit_mcp_logrepo_event(
            user=user,
            server_id=server_id,
            function_name=function_name,
            function_args=function_args,
            runtime_metadata=runtime_metadata,
            outcome="failed",
            elapsed_ms=elapsed_ms,
        )
        log.warning(
            "[OPENAPI_EXEC] Normalizing tool failure server=%s tool=%s tool_call_id=%s raw_error=%s",
            server_id,
            function_name,
            _runtime_metadata_log_tool_call_id(runtime_metadata),
            exc,
        )
        return normalize_tool_execution_error(exc)

    elapsed_ms = _log_tool_execution_finish(
        "OPENAPI_EXEC",
        server_id=server_id,
        function_name=function_name,
        runtime_metadata=runtime_metadata,
        started_at=started_at,
        outcome="completed",
    )
    _emit_mcp_logrepo_event(
        user=user,
        server_id=server_id,
        function_name=function_name,
        function_args=function_args,
        runtime_metadata=runtime_metadata,
        outcome="completed",
        elapsed_ms=elapsed_ms,
    )
    return response_data
