import time
import logging
import sys
import os
import base64
import copy
import textwrap
from pathlib import Path

import asyncio
import aiohttp
from aiocache import cached
from typing import Any, Optional, Callable
import random
import json
import html
import inspect
import re
import ast
import hashlib
import urllib.error
import urllib.parse
import urllib.request

from uuid import uuid4
from concurrent.futures import ThreadPoolExecutor

try:
    import yaml
except ImportError:
    yaml = None

from fastapi import Request, HTTPException
from fastapi.responses import HTMLResponse
from starlette.responses import Response, StreamingResponse, JSONResponse


from open_webui.utils.misc import is_string_allowed
from open_webui.models.oauth_sessions import OAuthSessions
from open_webui.models.chats import Chats
from open_webui.models.folders import Folders
from open_webui.models.users import Users
from open_webui.socket.main import (
    get_event_call,
)
from open_webui.utils.delegated_events import get_event_emitter
from open_webui.routers.tasks import (
    generate_queries,
    generate_title,
    generate_follow_ups,
    generate_image_prompt,
    generate_chat_tags,
)
from open_webui.routers.images import (
    image_generations,
    CreateImageForm,
    image_edits,
    EditImageForm,
)
from open_webui.routers.pipelines import (
    process_pipeline_inlet_filter,
    process_pipeline_outlet_filter,
)
from open_webui.socket.main import sio
from open_webui.utils.pending_chat_work import (
    append_user_steer_content_block,
    branch_has_replayed_tool_history,
    consume_pending_steer,
    emit_background_turn_inserted,
    emit_pending_chat_work_updated,
    inject_pending_steer_into_continue_messages,
    inject_pending_steer_into_followup_messages,
    insert_background_dispatch_messages,
    is_background_turn_branch_persisted,
    merge_top_level_files,
    pending_work_item_to_request_message,
    repair_missing_background_turn_branch_in_chat_payload,
    repair_missing_parent_message_in_chat_payload,
    restore_pending_chat_item_after_dispatch_failure,
    run_pending_chat_work_drain,
    schedule_pending_chat_work_drain,
    load_pending_chat_tool_ids_from_redis,
    sync_flattened_message_with_history,
)
from open_webui.utils.llm_debug import ensure_upstream_request_id
from open_webui.utils.ultra_multi_agent import is_ultra_request
from open_webui.utils.chat_titles import normalize_chat_title

SCHEDULED_FINALIZER_TOOL_NAME = "scheduling_finalize_run"

# Dynamic tool loading support for mid-turn tool enabling
try:
    from redis import Redis as RedisClient

    DYNAMIC_TOOLS_REDIS_AVAILABLE = True
except ImportError:
    DYNAMIC_TOOLS_REDIS_AVAILABLE = False

try:
    from managers.skill_manager import get_skill_manager
except ImportError:
    get_skill_manager = None

_OPTIMIZATION_FLAG_ENV_PREFIX = "OWUI_OPT_"
_OPTIMIZATION_FLAGS_CACHE: dict[str, Any] = {}
_OPTIMIZATION_FLAGS_MTIME = 0.0
# Flips to True the first time ``_load_optimization_flags`` confirms the
# file is missing, so we log the diagnostic exactly once per process.
_OPTIMIZATION_FLAGS_MISSING_WARNED = False
_DEFAULT_OVERFLOW_AGENT_VM_TIMEOUT_HOURS = 1.0
_SUBAGENT_LOCKED_TOOL_NAMES = {
    "mcp_assistant_toggle_integration",
    "mcp_assistant_authorize_integration",
    "mcp_assistant_activate_integration",
    "mcp_assistant_trigger_guided_setup",
    "skills_activate_skill",
}
_SINGLE_STRING_ARGUMENT_ALIAS_KEYS = ("message", "query", "question", "prompt", "text")


def _refresh_upstream_request_metadata(
    metadata: Any, updates: Optional[dict[str, Any]] = None
) -> dict[str, Any]:
    next_metadata = ensure_upstream_request_id(
        metadata if isinstance(metadata, dict) else {},
        force_new=True,
    )
    if isinstance(updates, dict):
        next_metadata.update(updates)
    return next_metadata


def _debug_request_metadata_snapshot(metadata: Any) -> dict[str, Any]:
    if not isinstance(metadata, dict):
        return {}

    snapshot: dict[str, Any] = {}
    for key in (
        "user_id",
        "chat_id",
        "session_id",
        "message_id",
        "debug_request_id",
        "upstream_request_id",
        "task",
        "request_phase",
        "followup_index",
        "outer_message_id",
        "trigger_message_id",
        "transcript_anchor_kind",
        "transcript_anchor_message_id",
        "transcript_anchor_tool_block_index",
    ):
        value = metadata.get(key)
        if value is not None:
            snapshot[key] = value

    return snapshot


def _latest_tool_calls_block_index(content_blocks: Any) -> Optional[int]:
    if not isinstance(content_blocks, list):
        return None
    tool_block_count = 0
    for block in content_blocks:
        if isinstance(block, dict) and block.get("type") == "tool_calls":
            tool_block_count += 1
    if tool_block_count <= 0:
        return None
    return tool_block_count - 1


def _assistant_tool_block_anchor_updates(
    assistant_message_id: Any, content_blocks: Any
) -> dict[str, Any]:
    tool_block_index = _latest_tool_calls_block_index(content_blocks)
    if (
        isinstance(assistant_message_id, str)
        and assistant_message_id.strip()
        and tool_block_index is not None
    ):
        return {
            "transcript_anchor_kind": "assistant_tool_block",
            "transcript_anchor_message_id": assistant_message_id,
            "transcript_anchor_tool_block_index": tool_block_index,
        }
    return {
        "transcript_anchor_kind": "background",
        "transcript_anchor_message_id": None,
        "transcript_anchor_tool_block_index": None,
    }


def _user_message_anchor_updates(message_id: Any) -> dict[str, Any]:
    if isinstance(message_id, str) and message_id.strip():
        return {
            "trigger_message_id": message_id,
            "transcript_anchor_kind": "user_message",
            "transcript_anchor_message_id": message_id,
            "transcript_anchor_tool_block_index": None,
        }
    return {
        "transcript_anchor_kind": "background",
        "transcript_anchor_message_id": None,
        "transcript_anchor_tool_block_index": None,
    }


def _tool_payload_function_names(tool_payloads: Any) -> list[str]:
    tool_names: list[str] = []
    if not isinstance(tool_payloads, list):
        return tool_names
    for tool_payload in tool_payloads:
        if not isinstance(tool_payload, dict):
            continue
        function_payload = tool_payload.get("function")
        if not isinstance(function_payload, dict):
            continue
        tool_name = function_payload.get("name")
        if isinstance(tool_name, str) and tool_name:
            tool_names.append(tool_name)
    return tool_names


def _message_role_summary(messages: Any) -> dict[str, int]:
    summary = {
        "messages": 0,
        "system": 0,
        "user": 0,
        "assistant": 0,
        "tool": 0,
        "content_block_messages": 0,
        "assistant_tool_call_messages": 0,
    }
    if not isinstance(messages, list):
        return summary

    summary["messages"] = len(messages)
    for msg in messages:
        if not isinstance(msg, dict):
            continue

        role = msg.get("role")
        if role in ("system", "user", "assistant", "tool"):
            summary[role] += 1

        if "contentBlocks" in msg:
            summary["content_block_messages"] += 1

        if role == "assistant" and msg.get("tool_calls"):
            summary["assistant_tool_call_messages"] += 1

    return summary


def _message_content_part_is_empty(part: Any) -> bool:
    if part is None:
        return True
    if isinstance(part, str):
        return not part.strip()
    if not isinstance(part, dict):
        return False

    part_type = str(part.get("type") or "").strip().lower()
    if part_type in {"text", "input_text"}:
        text = part.get("text")
        if text is None:
            text = part.get("content")
        return not str(text or "").strip()
    if part_type == "reasoning":
        return not str(part.get("content") or part.get("thinking") or "").strip()
    if part_type in {
        "file",
        "image",
        "image_url",
        "input_file",
        "input_image",
        "document",
        "tool_use",
        "tooluse",
        "tool_result",
        "mcp_tool_result",
        "code_interpreter",
    }:
        return False

    return False


def _message_content_is_empty(content: Any) -> bool:
    if content is None:
        return True
    if isinstance(content, str):
        return not content.strip()
    if isinstance(content, list):
        return all(_message_content_part_is_empty(part) for part in content)
    return False


def _assistant_message_has_model_replay_payload(message: dict[str, Any]) -> bool:
    return bool(
        message.get("tool_calls")
        or message.get("function_call")
        or message.get("contentBlocks")
    )


def _user_message_has_attachment_payload(message: dict[str, Any]) -> bool:
    return bool(message.get("files") or message.get("contentBlocks"))


def _user_message_is_empty_for_provider(message: dict[str, Any]) -> bool:
    return _message_content_is_empty(message.get("content")) and not (
        _user_message_has_attachment_payload(message)
    )


def _sanitize_provider_request_messages(
    messages: Any,
) -> tuple[Any, dict[str, Any]]:
    metadata = {
        "dropped_empty_assistant_messages": 0,
        "dropped_historical_empty_user_messages": 0,
        "latest_empty_user_message_rejected": False,
        "latest_empty_user_message_index": None,
    }
    if not isinstance(messages, list):
        return messages, metadata

    sanitized_messages = []
    latest_user_message_index = None
    for index, message in enumerate(messages):
        if isinstance(message, dict) and message.get("role") == "user":
            latest_user_message_index = index

    for index, message in enumerate(messages):
        if not isinstance(message, dict):
            sanitized_messages.append(message)
            continue

        if (
            message.get("role") == "assistant"
            and _message_content_is_empty(message.get("content"))
            and not _assistant_message_has_model_replay_payload(message)
        ):
            metadata["dropped_empty_assistant_messages"] += 1
            continue

        if message.get("role") == "user" and _user_message_is_empty_for_provider(message):
            if index == latest_user_message_index:
                metadata["latest_empty_user_message_rejected"] = True
                metadata["latest_empty_user_message_index"] = index
            else:
                metadata["dropped_historical_empty_user_messages"] += 1
            continue

        sanitized_messages.append(message)

    return sanitized_messages, metadata


def _system_message_summary(messages: Any) -> dict[str, int]:
    summary = {
        "system_messages": 0,
        "system_chars": 0,
        "system_messages_with_portico_context": 0,
    }
    if not isinstance(messages, list):
        return summary

    for msg in messages:
        if not isinstance(msg, dict) or msg.get("role") != "system":
            continue

        summary["system_messages"] += 1
        content = msg.get("content")
        if isinstance(content, str):
            summary["system_chars"] += len(content)
            if "<portico_context>" in content:
                summary["system_messages_with_portico_context"] += 1

    return summary


def _optimization_flags_path() -> Path:
    candidates = []
    host_project_root = os.environ.get("HOST_PROJECT_ROOT", "").strip()
    if host_project_root:
        candidates.append(Path(host_project_root) / "optimization_flags.json")
    candidates.append(Path("/app/optimization_flags.json"))
    resolved_file = Path(__file__).resolve()
    for parent in resolved_file.parents:
        candidates.append(parent / "optimization_flags.json")

    deduped_candidates = []
    seen = set()
    for candidate in candidates:
        candidate_str = str(candidate)
        if candidate_str in seen:
            continue
        seen.add(candidate_str)
        deduped_candidates.append(candidate)

    for candidate in deduped_candidates:
        if candidate.exists():
            return candidate
    return (
        deduped_candidates[0]
        if deduped_candidates
        else Path("optimization_flags.json")
    )


def _load_optimization_flags() -> dict[str, Any]:
    global _OPTIMIZATION_FLAGS_CACHE
    global _OPTIMIZATION_FLAGS_MTIME
    global _OPTIMIZATION_FLAGS_MISSING_WARNED

    path = _optimization_flags_path()
    try:
        current_mtime = path.stat().st_mtime
    except FileNotFoundError:
        # Log the silent-defaults trap exactly once per process. We hit this
        # historically because ``optimization_flags.json`` was created on the
        # host but never mounted into the open-webui container, so every
        # ``_optimization_flag_enabled`` call quietly fell back to its
        # ``default=`` argument. Whenever the in-code default disagreed with
        # the file (e.g. the per-action confirmation gate kill-switch), the
        # toggle appeared to do nothing. The mount lives in
        # ``docker-compose.yml`` (``./optimization_flags.json:/app/...``);
        # if you see this warning in production, that mount is missing.
        if not _OPTIMIZATION_FLAGS_MISSING_WARNED:
            log.warning(
                "[OPT_FLAGS] optimization_flags.json not found at %s — "
                "every _optimization_flag_enabled() call will fall back to "
                "its in-code default. If this is the open-webui container, "
                "verify the ./optimization_flags.json bind mount is in place.",
                path,
            )
            _OPTIMIZATION_FLAGS_MISSING_WARNED = True
        _OPTIMIZATION_FLAGS_CACHE = {}
        _OPTIMIZATION_FLAGS_MTIME = 0.0
        return {}

    if _OPTIMIZATION_FLAGS_CACHE and current_mtime <= _OPTIMIZATION_FLAGS_MTIME:
        return _OPTIMIZATION_FLAGS_CACHE

    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        log.warning("[OPT_FLAGS] Failed to read %s: %s", path, exc)
        _OPTIMIZATION_FLAGS_CACHE = {}
        _OPTIMIZATION_FLAGS_MTIME = current_mtime
        return {}

    flags = {str(key): value for key, value in raw.items() if isinstance(key, str)} if isinstance(raw, dict) else {}
    _OPTIMIZATION_FLAGS_CACHE = flags
    _OPTIMIZATION_FLAGS_MTIME = current_mtime
    return flags


def _optimization_flag_enabled(flag_name: str, default: bool = True) -> bool:
    env_name = _OPTIMIZATION_FLAG_ENV_PREFIX + re.sub(r"[^A-Za-z0-9]+", "_", flag_name).upper()
    raw_env = os.getenv(env_name)
    if raw_env is not None:
        value = raw_env.strip().lower()
        if value in {"1", "true", "yes", "on"}:
            return True
        if value in {"0", "false", "no", "off"}:
            return False

    flags = _load_optimization_flags()
    return bool(flags.get(flag_name, default))


def _optimization_int_value(flag_name: str, default: int, minimum: int = 1) -> int:
    env_name = _OPTIMIZATION_FLAG_ENV_PREFIX + re.sub(r"[^A-Za-z0-9]+", "_", flag_name).upper()
    raw_env = os.getenv(env_name)
    candidates = []
    if raw_env is not None:
        candidates.append(raw_env)
    candidates.append(_load_optimization_flags().get(flag_name, default))

    for raw_value in candidates:
        try:
            value = int(raw_value)
        except (TypeError, ValueError):
            continue
        if value >= minimum:
            return value
    return default


def _float_env(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = float(raw.strip())
    except Exception:
        return default
    if not value or value <= 0:
        return default
    return value


def _overflow_agent_vm_timeout_hours() -> float:
    return _float_env(
        "OWUI_OVERFLOW_AGENT_VM_TIMEOUT_HOURS",
        _DEFAULT_OVERFLOW_AGENT_VM_TIMEOUT_HOURS,
    )

def _filter_subagent_locked_tool_registry(
    tools_dict: dict[str, dict],
    *,
    lock_integrations: bool,
) -> tuple[dict[str, dict], list[str]]:
    if not lock_integrations or not isinstance(tools_dict, dict):
        return tools_dict, []

    filtered_tools = {
        name: tool
        for name, tool in tools_dict.items()
        if name not in _SUBAGENT_LOCKED_TOOL_NAMES
    }
    removed = sorted(set(tools_dict.keys()) - set(filtered_tools.keys()))
    return filtered_tools, removed


def _build_unavailable_tool_result(
    tool_function_name: str,
    *,
    is_subagent_chat: bool,
    lock_integrations: bool,
) -> dict[str, Any] | str:
    if (
        is_subagent_chat
        and lock_integrations
        and tool_function_name in _SUBAGENT_LOCKED_TOOL_NAMES
    ):
        return {
            "status": "blocked_by_policy",
            "code": "delegated_subagent_tool_locked",
            "message": (
                f"{tool_function_name} is unavailable in delegated subagent chats. "
                "Do not activate skills or change integration state here. Continue "
                "with already attached tools and the current evidence."
            ),
        }

    return (
        f"Error: Tool '{tool_function_name}' is not available in the current chat yet. "
        "The integration may still be starting, may still need activation, or may have "
        "been disabled. Do NOT retry this tool call blindly. First verify the integration "
        "is enabled and only activate it after readiness_phase='tool_ready'. If "
        "readiness_phase='service_not_found', the server is not installed. Do NOT wait "
        "or retry activation; surface the missing integration error and continue "
        "without it."
    )


RETRIEVAL_DISABLED = (
    os.environ.get("BYPASS_EMBEDDING_AND_RETRIEVAL", "false").lower() == "true"
)
CODE_INTERPRETER_ENABLED = (
    os.environ.get("ENABLE_CODE_INTERPRETER", "true").lower() == "true"
)

from open_webui.utils.webhook import post_webhook
from open_webui.utils.files import (
    convert_markdown_base64_images,
    get_file_url_from_base64,
    get_image_base64_from_url,
    get_image_url_from_base64,
)


from open_webui.models.users import UserModel
from open_webui.models.functions import Functions
from open_webui.models.models import Models

from open_webui.utils.chat import generate_chat_completion
from open_webui.utils.task import (
    get_task_model_id,
    rag_template,
    tools_function_calling_generation_template,
)
from open_webui.utils.misc import (
    deep_update,
    extract_urls,
    get_message_list,
    add_or_update_system_message,
    add_or_update_user_message,
    get_last_user_message,
    get_last_user_message_item,
    get_last_assistant_message,
    get_system_message,
    prepend_to_first_user_message_content,
    convert_logit_bias_input_to_json,
    get_content_from_message,
)
from open_webui.utils.tools import (
    execute_tool_server,
    get_async_tool_function_and_apply_extra_params,
    get_tool_servers,
    get_tools,
    get_updated_tool_function,
)
try:
    from open_webui.utils.tools import refresh_tool_servers_for_ids
except Exception:
    refresh_tool_servers_for_ids = None
from open_webui.tasks import stop_task
from open_webui.utils.plugin import load_function_module_by_id
from open_webui.utils.filter import (
    get_sorted_filter_ids,
    process_filter_functions,
)
from open_webui.utils.tool_call_streaming import (
    build_tool_call_preview_content,
    get_missing_required_tool_arguments,
    get_tool_call_summary_label,
    is_tool_call_only_delta,
    normalize_blank_tool_call_arguments,
    normalize_tool_calls_for_execution,
    tool_calls_ready_for_preview,
)
from open_webui.utils.tool_confirmation_gate import (
    Card as ToolConfirmationCard,
    ToolCallDecision as ToolConfirmationDecision,
    compute_call_hash,
    default_gate as default_tool_confirmation_gate,
    inject_tool_action_policy as inject_tool_action_policy_into_form_data,
)
from open_webui.utils.payload import apply_system_prompt_to_body
from open_webui.utils.subagent_tooling import (
    maybe_add_code_execution_to_subagent,
)
from open_webui.utils.mcp.client import MCPClient
from open_webui.utils.mcp_runtime import (
    build_mcp_request_headers,
    call_openapi_tool_with_runtime_headers,
    call_mcp_tool_with_runtime_headers,
    normalize_tool_execution_error,
)
from open_webui.utils.ultra_tool_executor import (
    UltraToolDenied,
    UltraToolExecutionError,
    await_once_with_heartbeat,
    private_batch_token,
    require_eligible_local_mcp_tool,
    run_private_ultra_batches,
    sanitized_ultra_audit,
)


from open_webui.config import (
    CACHE_DIR,
    DEFAULT_VOICE_MODE_PROMPT_TEMPLATE,
    DEFAULT_TOOLS_FUNCTION_CALLING_PROMPT_TEMPLATE,
    DEFAULT_CODE_INTERPRETER_PROMPT,
    CODE_INTERPRETER_BLOCKED_MODULES,
)
from open_webui.env import (
    GLOBAL_LOG_LEVEL,
    ENABLE_CHAT_RESPONSE_BASE64_IMAGE_URL_CONVERSION,
    CHAT_RESPONSE_STREAM_DELTA_CHUNK_SIZE,
    CHAT_RESPONSE_MAX_TOOL_CALL_RETRIES,
    BYPASS_MODEL_ACCESS_CONTROL,
    ENABLE_REALTIME_CHAT_SAVE,
    ENABLE_QUERIES_CACHE,
)
from open_webui.constants import TASKS


CONTAINER_SRC_DIR = "/app/src"
if CONTAINER_SRC_DIR not in sys.path:
    sys.path.insert(0, CONTAINER_SRC_DIR)


try:
    from event_publisher import (
        publish_error as _publish_error_impl,
        publish_response_complete as _publish_response_complete_impl,
    )

    LLM_DEBUG_EVENT_PUBLISHER_AVAILABLE = True
except ImportError:
    LLM_DEBUG_EVENT_PUBLISHER_AVAILABLE = False
    _publish_error_impl = None
    _publish_response_complete_impl = None


def _ensure_llm_debug_event_publisher_available() -> bool:
    global LLM_DEBUG_EVENT_PUBLISHER_AVAILABLE
    global _publish_error_impl
    global _publish_response_complete_impl

    if _publish_error_impl and _publish_response_complete_impl:
        return True

    try:
        from event_publisher import (
            publish_error as publish_error_impl,
            publish_response_complete as publish_response_complete_impl,
        )

        _publish_error_impl = publish_error_impl
        _publish_response_complete_impl = publish_response_complete_impl
        LLM_DEBUG_EVENT_PUBLISHER_AVAILABLE = True
        return True
    except ImportError:
        LLM_DEBUG_EVENT_PUBLISHER_AVAILABLE = False
        return False


async def publish_error(*args, **kwargs):
    if not _ensure_llm_debug_event_publisher_available():
        return False
    return await _publish_error_impl(*args, **kwargs)


async def publish_response_complete(*args, **kwargs):
    if not _ensure_llm_debug_event_publisher_available():
        return False
    return await _publish_response_complete_impl(*args, **kwargs)


LLM_DEBUG_MONITOR_GATEWAY_EVENTS_ENABLED = True


def _positive_int_from_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


GLOBAL_TOOL_EXECUTION_CONCURRENCY_LIMIT = _positive_int_from_env(
    "OPENWEBUI_GLOBAL_TOOL_EXECUTION_CONCURRENCY_LIMIT", 100
)


def _ultra_private_gateway_config() -> tuple[str, str]:
    runtime_base_url = str(os.environ.get("OPENAI_API_BASE_URL") or "").strip().rstrip("/")
    parsed = urllib.parse.urlsplit(runtime_base_url)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path.rstrip("/") != "/v1"
    ):
        raise UltraToolExecutionError("Ultra private gateway configuration is invalid")
    key_file = str(os.environ.get("OPENAI_API_KEY_FILE") or "").strip()
    if key_file:
        try:
            api_key = Path(key_file).read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise UltraToolExecutionError(
                "Ultra private gateway credential file is unavailable"
            ) from exc
    else:
        api_key = str(os.environ.get("OPENAI_API_KEY") or "").strip()
    if not api_key:
        raise UltraToolExecutionError("Ultra private gateway credential is unavailable")
    origin = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))
    return origin, api_key


def _ultra_private_bridge_timeout_seconds(action: str) -> int:
    # The bridge owns the 30-minute Ultra wall budget. Give the blocking results
    # action one minute to return that authoritative outcome; control calls stay
    # short because they never wait on a provider.
    return 31 * 60 if action == "results" else 60


async def _ultra_private_bridge_call(token: str, action: str, payload: Any) -> Any:
    if action not in {"claim", "dispatch-start", "heartbeat", "results"}:
        raise UltraToolExecutionError("Ultra bridge action is invalid")
    origin, api_key = _ultra_private_gateway_config()
    url = f"{origin}/internal/ultra/batches/{token}/{action}"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    timeout = aiohttp.ClientTimeout(
        total=_ultra_private_bridge_timeout_seconds(action)
    )
    try:
        async with aiohttp.ClientSession(
            trust_env=False,
            timeout=timeout,
            cookies={},
            skip_auto_headers={"User-Agent", "Accept", "Accept-Encoding"},
        ) as session:
            async with session.post(
                url,
                headers=headers,
                json=payload if payload is not None else None,
                cookies={},
            ) as response:
                if response.status == 204:
                    return None
                if response.status < 200 or response.status >= 300:
                    raise UltraToolExecutionError("Ultra bridge rejected private state")
                if response.content_length is not None and response.content_length > 2 * 1024 * 1024:
                    raise UltraToolExecutionError("Ultra bridge response exceeded its safe limit")
                raw = await response.read()
                if len(raw) > 2 * 1024 * 1024:
                    raise UltraToolExecutionError("Ultra bridge response exceeded its safe limit")
                return json.loads(raw)
    except UltraToolExecutionError:
        raise
    except Exception as exc:
        raise UltraToolExecutionError("Ultra bridge request did not complete") from exc


async def _execute_private_ultra_openapi_tool(
    request: Request,
    tool: dict[str, Any],
    parsed_args: dict[str, Any],
    extra_params: dict[str, Any],
) -> Any:
    server_data = tool.get("tool_server_data")
    connection = tool.get("tool_server_connection")
    operation_name = tool.get("server_operation_name")
    if (
        not isinstance(server_data, dict)
        or not isinstance(connection, dict)
        or not isinstance(operation_name, str)
        or not operation_name
    ):
        raise UltraToolDenied("Ultra OpenAPI execution metadata is incomplete")

    openapi = server_data.get("openapi")
    paths = openapi.get("paths") if isinstance(openapi, dict) else None
    matches = []
    if isinstance(paths, dict):
        for route_path, methods in paths.items():
            if not isinstance(route_path, str) or not isinstance(methods, dict):
                continue
            for http_method, operation in methods.items():
                if (
                    isinstance(operation, dict)
                    and operation.get("operationId") == operation_name
                ):
                    matches.append((route_path, str(http_method).lower(), operation))
    if len(matches) != 1:
        raise UltraToolDenied("Ultra OpenAPI operation is absent or ambiguous")

    route_path, http_method, operation = matches[0]
    if (
        http_method not in {"get", "post"}
        or not route_path.startswith("/")
        or ".." in route_path.split("/")
        or "://" in route_path
    ):
        raise UltraToolDenied("Ultra OpenAPI route is not read-only and local")

    path_params: dict[str, Any] = {}
    query_params: dict[str, Any] = {}
    operation_parameters = operation.get("parameters")
    if not isinstance(operation_parameters, list):
        operation_parameters = []
    for parameter in operation_parameters:
        if not isinstance(parameter, dict):
            continue
        parameter_name = parameter.get("name")
        parameter_location = parameter.get("in")
        if not isinstance(parameter_name, str):
            continue
        if parameter.get("required") is True and parameter_name not in parsed_args:
            raise UltraToolDenied("Ultra OpenAPI route arguments are incomplete")
        if parameter_name not in parsed_args:
            continue
        if parameter_location == "path":
            path_params[parameter_name] = parsed_args[parameter_name]
        elif parameter_location == "query":
            query_params[parameter_name] = parsed_args[parameter_name]

    rendered_path = route_path
    for key, value in path_params.items():
        rendered_path = rendered_path.replace(
            f"{{{key}}}", urllib.parse.quote(str(value), safe="")
        )
    if "{" in rendered_path or "}" in rendered_path:
        raise UltraToolDenied("Ultra OpenAPI path arguments are incomplete")

    base_url = str(server_data.get("url") or "").rstrip("/")
    final_url = f"{base_url}/{rendered_path.lstrip('/')}"
    headers, cookies = _openapi_tool_headers_and_cookies(
        request,
        connection,
        extra_params or {},
    )
    request_body = operation.get("requestBody")
    has_request_body = isinstance(request_body, dict) and bool(
        request_body.get("content")
    )
    timeout = aiohttp.ClientTimeout(total=5 * 60)
    try:
        async with aiohttp.ClientSession(
            trust_env=False,
            timeout=timeout,
            cookies={},
            skip_auto_headers={"User-Agent", "Accept-Encoding"},
        ) as session:
            async with session.request(
                http_method,
                final_url,
                params=query_params,
                json=parsed_args if has_request_body else None,
                headers=headers or {},
                cookies=cookies or {},
                allow_redirects=False,
            ) as response:
                if response.status < 200 or response.status >= 300:
                    raise UltraToolExecutionError("Ultra local OpenAPI tool failed")
                max_bytes = 256 * 1024
                raw = bytearray()
                async for chunk in response.content.iter_chunked(64 * 1024):
                    raw.extend(chunk)
                    if len(raw) > max_bytes:
                        raise UltraToolExecutionError(
                            "Ultra local OpenAPI result exceeded its safe limit"
                        )
    except UltraToolExecutionError:
        raise
    except Exception as exc:
        raise UltraToolExecutionError(
            "Ultra local OpenAPI tool did not complete"
        ) from exc

    try:
        text = bytes(raw).decode("utf-8")
    except UnicodeDecodeError as exc:
        raise UltraToolExecutionError("Ultra local OpenAPI result was not text") from exc
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


async def _execute_ultra_private_control(
    token: str,
    *,
    request: Request,
    user: Any,
    metadata: dict[str, Any],
    extra_params: dict[str, Any],
    event_emitter: Any,
) -> dict[str, Any]:
    tools = metadata.get("tools")
    if not isinstance(tools, dict):
        raise UltraToolDenied("Ultra server-side tool snapshot is unavailable")

    async def execute_call(call, mark_dispatch_started, heartbeat):
        tool = require_eligible_local_mcp_tool(call.name, tools.get(call.name))
        spec = tool.get("spec")
        _, parsed_args, parse_ok = _normalize_tool_call_arguments_for_schema(
            call.arguments,
            tool_name=call.name,
            tool_spec=spec,
        )
        if not parse_ok or not isinstance(parsed_args, dict):
            raise UltraToolDenied("Ultra tool arguments are not a JSON object")
        parsed_args, _ = _normalize_single_required_string_argument_alias(
            tool_name=call.name,
            tool_spec=spec,
            parsed_arguments=parsed_args,
        )
        parameters = spec.get("parameters") if isinstance(spec, dict) else None
        properties = parameters.get("properties") if isinstance(parameters, dict) else None
        if not isinstance(properties, dict):
            raise UltraToolDenied("Ultra tool input schema is unavailable")
        if any(key not in properties for key in parsed_args):
            raise UltraToolDenied("Ultra tool arguments are outside the server schema")
        parsed_args = {key: value for key, value in parsed_args.items() if key in properties}
        parsed_args = _normalize_current_chat_scoped_tool_arguments(
            tool_function_name=call.name,
            tool=tool,
            tool_function_params=parsed_args,
            metadata=metadata,
        )
        if get_missing_required_tool_arguments(spec, parsed_args):
            raise UltraToolDenied("Ultra tool arguments are incomplete")

        gate = default_tool_confirmation_gate()
        if gate.registry.classify(call.name)[0] != "safe":
            raise UltraToolDenied("Ultra permits only classified read-only tools")
        parsed_args, blocking_result = await _apply_tool_confirmation_gate(
            chat_id=metadata.get("chat_id"),
            user_id=getattr(user, "id", None),
            tool_function_name=call.name,
            tool_function_params=parsed_args,
            event_emitter=event_emitter,
        )
        if blocking_result is not None:
            raise UltraToolDenied("Ultra tool confirmation did not authorize dispatch")

        await mark_dispatch_started()
        if tool.get("type") == "mcp":
            runtime_metadata = dict(metadata)
            runtime_metadata["tool_call_id"] = call.call_id
            server_id = tool["server_id"]
            runtime_metadata["server_id"] = server_id
            runtime_metadata["server_is_core"] = bool(
                _load_server_metadata(server_id).get("is_core", False)
            )
            invocation = call_mcp_tool_with_runtime_headers(
                client_factory=MCPClient,
                request=request,
                user=user,
                server_id=server_id,
                mcp_server_connection=tool["mcp_server_connection"],
                extra_params=extra_params,
                metadata=runtime_metadata,
                function_name=tool["original_name"],
                function_args=parsed_args,
                suppress_observability=True,
            )
        else:
            invocation = _execute_private_ultra_openapi_tool(
                request,
                tool,
                parsed_args,
                extra_params,
            )
        return await await_once_with_heartbeat(
            invocation,
            heartbeat,
        )

    final = await run_private_ultra_batches(
        token,
        bridge_call=_ultra_private_bridge_call,
        execute_call=execute_call,
    )
    return {
        "id": f"ultra-{uuid4().hex}",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": "gpt-5.6-sol",
        "choices": [
            {
                "index": 0,
                "delta": {"role": "assistant", "content": final["content"]},
                "finish_reason": "stop",
            }
        ],
        "usage": final["usage"],
        "ultra_audit": final["ultra_audit"],
    }

_TRANSIENT_CHAT_COMPLETION_RETRY_MAX_ATTEMPTS = 4
_BEDROCK_STREAM_INACTIVE_RETRY_MAX_ATTEMPTS = 8
_BEDROCK_MALFORMED_TOOL_USE_RETRY_MAX_ATTEMPTS = 2
_TRANSIENT_CHAT_COMPLETION_RETRY_BASE_DELAY_SECONDS = 1.0
_TRANSIENT_CHAT_COMPLETION_RETRY_MAX_DELAY_SECONDS = 8.0
_TRANSIENT_TOOL_EXECUTION_RETRY_MAX_ATTEMPTS = 3
_TRANSIENT_TOOL_EXECUTION_RETRY_BASE_DELAY_SECONDS = 0.5
_TRANSIENT_TOOL_EXECUTION_RETRY_MAX_DELAY_SECONDS = 2.0
_TRANSIENT_CHAT_COMPLETION_RETRYABLE_STATUS_CODES = frozenset(
    {408, 409, 425, 429, 500, 502, 503, 504}
)
_HTTP_ERROR_STATUS_RE = re.compile(
    r"\bhttp(?:\s+error)?\s+(\d{3})\b", re.IGNORECASE
)
_TRANSIENT_CHAT_COMPLETION_RETRYABLE_MESSAGE_FRAGMENTS = (
    "server disconnected",
    "service unavailable",
    "temporarily unavailable",
    "upstream model provider stream failed",
    "stream idle timeout",
    "connection reset",
    "connection aborted",
    "connection closed",
    "remote protocol error",
    "timed out",
    "timeout",
    "broken pipe",
    "transport closed",
    "try again",
)
_BEDROCK_UNEXPECTED_PROCESSING_ERROR_FRAGMENTS = (
    "unexpected error during processing",
    "try your request again",
)
UPSTREAM_RETRY_STATUS_ACTION = "upstream_retry"
UPSTREAM_RETRY_STATUS_KEY = "upstream_retry"
BEDROCK_MALFORMED_TOOL_USE_ERROR_KIND = "bedrock_malformed_tool_use"
MALFORMED_TOOL_USE_STOP_REASON = "malformed_tool_use"
MALFORMED_TOOL_USE_USER_MESSAGE = (
    "The model provider ended the response before producing its requested tool call. "
    "Please retry."
)
_REASONING_DELTA_KEYS = (
    "reasoning_content",
    "reasoning",
    "thinking",
    "reasoning_details",
    "reasoning_status",
    "reasoning_thinking_ms",
)


def _llm_debug_usage_to_int(value) -> int:
    try:
        if value is None:
            return 0
        return int(value)
    except (TypeError, ValueError):
        return 0


def _extract_reasoning_details_text(reasoning_details: Any) -> str:
    if not reasoning_details:
        return ""

    details = reasoning_details
    if not isinstance(details, list):
        details = [details]

    text_parts = []
    for detail in details:
        if not isinstance(detail, dict):
            continue
        if detail.get("type") != "reasoning.text":
            continue
        text = detail.get("text")
        if isinstance(text, str) and text:
            text_parts.append(text)

    return "".join(text_parts)


def _merge_reasoning_delta_text(
    reasoning_content: Any, reasoning_details_text: str
) -> Any:
    if not reasoning_details_text:
        return reasoning_content

    if isinstance(reasoning_content, str):
        if not reasoning_content:
            return reasoning_details_text
        if reasoning_content == reasoning_details_text:
            return reasoning_content
        return reasoning_content + reasoning_details_text

    return reasoning_details_text


def _strip_reasoning_delta_fields(delta: Any) -> bool:
    if not isinstance(delta, dict):
        return False

    had_reasoning_delta = any(key in delta for key in _REASONING_DELTA_KEYS)
    if had_reasoning_delta:
        for key in _REASONING_DELTA_KEYS:
            delta.pop(key, None)
    return had_reasoning_delta


def _append_reasoning_text_to_content_blocks(
    content_blocks: list[dict], reasoning_text: str | None, *, now: float | None = None
) -> dict | None:
    if reasoning_text is None:
        return None

    if not content_blocks or content_blocks[-1].get("type") != "reasoning":
        reasoning_block = {
            "type": "reasoning",
            "start_tag": CANONICAL_REASONING_START_TAG,
            "end_tag": CANONICAL_REASONING_END_TAG,
            "attributes": {"type": "reasoning_content"},
            "content": "",
            "started_at": time.time() if now is None else now,
        }
        content_blocks.append(reasoning_block)
    else:
        reasoning_block = content_blocks[-1]

    if reasoning_text:
        reasoning_block["content"] = (
            str(reasoning_block.get("content", "")) + reasoning_text
        )

    return reasoning_block


def _is_empty_open_reasoning_block(block: Any) -> bool:
    if not isinstance(block, dict) or block.get("type") != "reasoning":
        return False
    if block.get("attributes", {}).get("type") != "reasoning_content":
        return False
    if block.get("ended_at") is not None:
        return False
    return not str(block.get("content") or "").strip()


def _finalize_or_prune_trailing_reasoning_block(
    content_blocks: list, *, now: float | None = None
) -> str:
    """Close the trailing reasoning block, or prune it entirely when it never
    received any reasoning text (e.g. a live thinking-indicator block for a
    round that produced no summary). Pruning instead of closing keeps empty
    "Thought Ns" rows out of the transcript. Returns "none" | "pruned" |
    "closed"."""
    if not content_blocks:
        return "none"
    block = content_blocks[-1]
    if not isinstance(block, dict) or block.get("type") != "reasoning":
        return "none"
    if block.get("attributes", {}).get("type") != "reasoning_content":
        return "none"
    if not str(block.get("content") or "").strip():
        content_blocks.pop()
        return "pruned"
    if block.get("ended_at") is None:
        block["ended_at"] = time.time() if now is None else now
        block["duration"] = max(
            0, round(block["ended_at"] - block["started_at"])
        )
    return "closed"


def _normalize_llm_debug_usage(usage: Any) -> dict:
    if not isinstance(usage, dict):
        return {}

    prompt_tokens_details = usage.get("prompt_tokens_details")
    if not isinstance(prompt_tokens_details, dict):
        prompt_tokens_details = {}
    completion_tokens_details = usage.get("completion_tokens_details")
    if not isinstance(completion_tokens_details, dict):
        completion_tokens_details = {}
    output_tokens_details = usage.get("output_tokens_details")
    if not isinstance(output_tokens_details, dict):
        output_tokens_details = {}

    def detail_value(*keys):
        for key in keys:
            if key in prompt_tokens_details:
                return _llm_debug_usage_to_int(prompt_tokens_details.get(key))
        return 0

    normalized_usage = {
        "prompt_tokens": _llm_debug_usage_to_int(
            usage.get("prompt_tokens")
            or usage.get("input_tokens")
            or usage.get("inputTokens")
        ),
        "completion_tokens": _llm_debug_usage_to_int(
            usage.get("completion_tokens")
            or usage.get("output_tokens")
            or usage.get("outputTokens")
        ),
    }
    normalized_usage["total_tokens"] = _llm_debug_usage_to_int(
        usage.get("total_tokens")
        or usage.get("totalTokens")
        or normalized_usage["prompt_tokens"] + normalized_usage["completion_tokens"]
    )

    raw_cached_tokens = usage.get("cached_tokens")
    if raw_cached_tokens is None:
        raw_cached_tokens = usage.get("cachedContentTokenCount")
    if raw_cached_tokens is None:
        raw_cached_tokens = usage.get("cached_content_token_count")
    prompt_detail_cached_tokens = prompt_tokens_details.get("cached_tokens")
    if prompt_detail_cached_tokens is None:
        prompt_detail_cached_tokens = prompt_tokens_details.get("cachedContentTokenCount")
    if prompt_detail_cached_tokens is None:
        prompt_detail_cached_tokens = prompt_tokens_details.get("cached_content_token_count")
    has_explicit_cached_tokens = raw_cached_tokens is not None
    has_prompt_detail_cached_tokens = prompt_detail_cached_tokens is not None
    cached_tokens = _llm_debug_usage_to_int(
        raw_cached_tokens if has_explicit_cached_tokens else prompt_detail_cached_tokens
    )
    cached_read_tokens = detail_value("cached_read_tokens", "cache_read_tokens")
    if cached_read_tokens == 0:
        cached_read_tokens = _llm_debug_usage_to_int(
            usage.get("cachedContentTokenCount")
            or usage.get("cached_content_token_count")
            or prompt_tokens_details.get("cachedContentTokenCount")
            or prompt_tokens_details.get("cached_content_token_count")
        )

    cache_creation_input_tokens = _llm_debug_usage_to_int(
        usage.get("cache_creation_input_tokens")
        or usage.get("cacheCreationInputTokens")
    )
    if cache_creation_input_tokens == 0:
        cache_creation_input_tokens = _llm_debug_usage_to_int(
            usage.get("cache_write_input_tokens") or usage.get("cacheWriteInputTokens")
        )
    if cache_creation_input_tokens == 0:
        cache_creation_input_tokens = detail_value(
            "cache_creation_tokens",
            "cached_write_tokens",
            "cache_write_tokens",
        )

    cache_write_input_tokens = _llm_debug_usage_to_int(
        usage.get("cache_write_input_tokens") or usage.get("cacheWriteInputTokens")
    )
    if cache_write_input_tokens == 0:
        cache_write_input_tokens = detail_value(
            "cached_write_tokens",
            "cache_write_tokens",
            "cache_creation_tokens",
        )
    if cache_write_input_tokens == 0:
        cache_write_input_tokens = cache_creation_input_tokens
    if cache_creation_input_tokens == 0 and cache_write_input_tokens > 0:
        cache_creation_input_tokens = cache_write_input_tokens

    cache_read_input_tokens = _llm_debug_usage_to_int(
        usage.get("cache_read_input_tokens")
        or usage.get("cacheReadInputTokens")
        or usage.get("cachedContentTokenCount")
        or usage.get("cached_content_token_count")
    )
    if cache_read_input_tokens == 0:
        cache_read_input_tokens = cached_read_tokens
    if (
        cache_read_input_tokens == 0
        and not has_explicit_cached_tokens
        and has_prompt_detail_cached_tokens
        and cached_tokens > 0
        and cache_creation_input_tokens == 0
        and cache_write_input_tokens == 0
    ):
        cache_read_input_tokens = cached_tokens
    if not has_explicit_cached_tokens:
        if cached_read_tokens > 0:
            cached_tokens = cached_read_tokens
        elif has_prompt_detail_cached_tokens and (
            cache_creation_input_tokens > 0 or cache_write_input_tokens > 0
        ):
            cached_tokens = 0
        elif not has_prompt_detail_cached_tokens:
            cached_tokens = 0

    if cached_tokens == 0 and not has_explicit_cached_tokens and cached_read_tokens > 0:
        cached_tokens = cached_read_tokens

    if cached_tokens == 0 and (
        cache_creation_input_tokens > 0 or cache_write_input_tokens > 0
    ) and not has_explicit_cached_tokens:
        cached_tokens = 0

    if cached_tokens > 0:
        normalized_usage["cached_tokens"] = cached_tokens
    if cache_read_input_tokens > 0:
        normalized_usage["cache_read_input_tokens"] = cache_read_input_tokens
    if cache_creation_input_tokens > 0:
        normalized_usage["cache_creation_input_tokens"] = (
            cache_creation_input_tokens
        )
    if cache_write_input_tokens > 0:
        normalized_usage["cache_write_input_tokens"] = cache_write_input_tokens

    reasoning_tokens = _llm_debug_usage_to_int(
        usage.get("reasoning_tokens")
        or completion_tokens_details.get("reasoning_tokens")
        or output_tokens_details.get("reasoning_tokens")
        or usage.get("thoughtsTokenCount")
        or usage.get("thoughts_token_count")
    )
    if reasoning_tokens > 0:
        normalized_usage["reasoning_tokens"] = reasoning_tokens

    # ULTRA multi-agent flows report cumulative prompt_tokens for spend plus
    # a non-cumulative context_tokens for the last round's true occupancy.
    # Occupancy is a latest-value counter: pass it through unchanged so the
    # frontend's occupancy preference can act on persisted usage.
    context_tokens = _llm_debug_usage_to_int(
        usage.get("context_tokens") or usage.get("contextTokens")
    )
    if context_tokens > 0:
        normalized_usage["context_tokens"] = context_tokens

    try:
        cost = float(usage.get("cost") or 0)
    except (TypeError, ValueError):
        cost = 0.0
    if cost == cost and 0.0 < cost < float("inf"):
        normalized_usage["cost"] = cost

    return normalized_usage


def _should_publish_bifrost_debug_response(metadata: Optional[dict]) -> bool:
    return bool(
        LLM_DEBUG_MONITOR_GATEWAY_EVENTS_ENABLED
        and isinstance(metadata, dict)
        and metadata.get("session_id")
        and metadata.get("chat_id")
    )

logging.basicConfig(stream=sys.stdout, level=GLOBAL_LOG_LEVEL)
log = logging.getLogger(__name__)


DEFAULT_REASONING_TAGS = [
    ("<think>", "</think>"),
    ("<thinking>", "</thinking>"),
    ("<reason>", "</reason>"),
    ("<reasoning>", "</reasoning>"),
    ("<thought>", "</thought>"),
    ("<Thought>", "</Thought>"),
    ("<|begin_of_thought|>", "<|end_of_thought|>"),
    ("◁think▷", "◁/think▷"),
]
CANONICAL_REASONING_START_TAG = "<think>"
CANONICAL_REASONING_END_TAG = "</think>"
DEFAULT_SOLUTION_TAGS = [("<|begin_of_solution|>", "<|end_of_solution|>")]
DEFAULT_CODE_INTERPRETER_TAGS = [("<code_interpreter>", "</code_interpreter>")]


def _resolve_reasoning_tags(reasoning_tags=None):
    if isinstance(reasoning_tags, (list, tuple)):
        normalized_tags = []
        for tag_pair in reasoning_tags:
            if not isinstance(tag_pair, (list, tuple)) or len(tag_pair) != 2:
                continue
            normalized_tags.append((str(tag_pair[0]), str(tag_pair[1])))
        if normalized_tags:
            return normalized_tags
    return DEFAULT_REASONING_TAGS


def _should_detect_inline_reasoning_tags(reasoning_tags_param):
    return (
        isinstance(reasoning_tags_param, list)
        and len(reasoning_tags_param) == 2
        and all(isinstance(tag, str) and tag for tag in reasoning_tags_param)
    )


def _strip_reasoning_tag_markers(text, reasoning_tags=None):
    if not text or not isinstance(text, str):
        return text, False

    updated = text
    changed = False
    for start_tag, end_tag in _resolve_reasoning_tags(reasoning_tags):
        if start_tag in updated:
            updated = updated.replace(start_tag, "")
            changed = True
        if end_tag in updated:
            updated = updated.replace(end_tag, "")
            changed = True

    return updated, changed


def _split_inline_reasoning_sections(
    text,
    *,
    inline_reasoning_active=False,
    inline_reasoning_end_tag=None,
    reasoning_tags=None,
    allow_unmatched_start=False,
    require_line_start=False,
    allow_unmatched_start_at_line_start=False,
    delta_at_line_start=True,
):
    if not text or not isinstance(text, str):
        return text, "", False, False, False, inline_reasoning_active, inline_reasoning_end_tag

    remaining = text
    output_parts = []
    reasoning_parts = []
    changed = False
    opened_reasoning = False
    closed_reasoning = False
    next_inline_reasoning_active = inline_reasoning_active
    next_inline_reasoning_end_tag = inline_reasoning_end_tag
    tags = _resolve_reasoning_tags(reasoning_tags)
    # True until anything is consumed: index 0 of `remaining` is the true
    # start of this delta only on the first scan; afterwards `remaining`
    # always begins right after a consumed tag, which is never a line start.
    at_delta_start = True

    while remaining:
        if next_inline_reasoning_active:
            end_idx = remaining.find(next_inline_reasoning_end_tag)
            if end_idx == -1:
                changed = True
                reasoning_parts.append(remaining)
                remaining = ""
                break

            reasoning_parts.append(remaining[:end_idx])
            remaining = remaining[end_idx + len(next_inline_reasoning_end_tag) :]
            at_delta_start = False
            next_inline_reasoning_active = False
            next_inline_reasoning_end_tag = None
            changed = True
            closed_reasoning = True
            continue

        next_index = None
        next_start = None
        next_end = None
        for start_tag, end_tag in tags:
            search_from = 0
            idx = -1
            while True:
                idx = remaining.find(start_tag, search_from)
                if idx == -1:
                    break
                if (
                    not require_line_start
                    or idx == 0
                    or remaining[idx - 1] == "\n"
                ):
                    break
                search_from = idx + len(start_tag)
            if idx != -1 and (next_index is None or idx < next_index):
                next_index = idx
                next_start = start_tag
                next_end = end_tag

        if next_index is None:
            output_parts.append(remaining)
            break

        if next_index > 0:
            output_parts.append(remaining[:next_index])

        end_index = remaining.find(next_end, next_index + len(next_start))
        if end_index == -1 and not allow_unmatched_start:
            # A start tag whose close has not arrived yet may still open a
            # cross-delta capture, but only when anchored at a real line
            # start (models emit transport-style think blocks there; inline
            # literals mid-line stay visible text).
            if next_index > 0:
                open_at_line_start = remaining[next_index - 1] == "\n"
            else:
                open_at_line_start = at_delta_start and delta_at_line_start
            if not (allow_unmatched_start_at_line_start and open_at_line_start):
                output_parts.append(remaining[next_index:])
                break

        remaining = remaining[next_index + len(next_start) :]
        at_delta_start = False
        next_inline_reasoning_active = True
        next_inline_reasoning_end_tag = next_end
        changed = True
        opened_reasoning = True

    return (
        "".join(output_parts),
        "".join(reasoning_parts),
        changed,
        opened_reasoning,
        closed_reasoning,
        next_inline_reasoning_active,
        next_inline_reasoning_end_tag,
    )


def _extract_pending_reasoning_start_tag_prefix(
    text,
    *,
    reasoning_tags=None,
    inline_reasoning_active=False,
    require_line_start=False,
    at_line_start=True,
):
    if not text or not isinstance(text, str):
        return text, ""
    if inline_reasoning_active:
        return text, ""

    max_prefix = ""
    for start_tag, _ in _resolve_reasoning_tags(reasoning_tags):
        for length in range(len(start_tag) - 1, 0, -1):
            prefix = start_tag[:length]
            if text.endswith(prefix):
                if len(prefix) > len(max_prefix):
                    max_prefix = prefix
                break

    if max_prefix:
        if require_line_start:
            start = len(text) - len(max_prefix)
            anchored = (
                text[start - 1] == "\n" if start > 0 else at_line_start
            )
            if not anchored:
                return text, ""
        return text[: -len(max_prefix)], max_prefix
    return text, ""


def _extract_pending_reasoning_end_tag_suffix(
    text,
    *,
    reasoning_tags=None,
    inline_reasoning_end_tag=None,
):
    """Peel a partial reasoning END tag off a delta tail so a close tag split
    across SSE deltas (e.g. "</th" + "ink>") can still terminate a capture on
    the next delta instead of being swallowed into reasoning content."""
    if not text or not isinstance(text, str):
        return text, ""

    if inline_reasoning_end_tag:
        end_tags = [inline_reasoning_end_tag]
    else:
        end_tags = [end_tag for _, end_tag in _resolve_reasoning_tags(reasoning_tags)]

    max_prefix = ""
    for end_tag in end_tags:
        if not end_tag or end_tag in text:
            # A complete close tag is handled by the splitter itself.
            continue
        for length in range(min(len(end_tag) - 1, len(text)), 0, -1):
            prefix = end_tag[:length]
            if text.endswith(prefix):
                if len(prefix) > len(max_prefix):
                    max_prefix = prefix
                break

    if max_prefix:
        return text[: -len(max_prefix)], max_prefix
    return text, ""


def _text_tail_at_line_boundary(content_blocks):
    """True when the next appended character would land at a line start
    (empty stream, non-text tail block, or text tail ending in a newline)."""
    if not content_blocks:
        return True
    last_block = content_blocks[-1]
    if not isinstance(last_block, dict) or last_block.get("type") != "text":
        return True
    content = last_block.get("content")
    if not isinstance(content, str) or not content:
        return True
    return content.endswith("\n")


def _remove_complete_inline_reasoning_sections(text):
    """Drop complete, line-start-anchored inline reasoning sections (e.g. a
    literal ``<think>...</think>`` block a model wrote into visible text) from
    transcript content replayed to models. Incomplete or mid-line tag pairs
    are left untouched."""
    if not text or not isinstance(text, str):
        return text
    if "<" not in text and "◁" not in text:
        return text

    cleaned_text, _reasoning, changed, _opened, _closed, still_active, _tag = (
        _split_inline_reasoning_sections(
            text,
            allow_unmatched_start=False,
            require_line_start=True,
        )
    )
    if changed and not still_active:
        return cleaned_text
    return text

CONTEXT_WINDOW_ERROR_MESSAGE = (
    "Oops, looks like we exceeded our context window budget. Please start a new chat "
    "or switch to a model with a larger context window."
)
_CONTEXT_WINDOW_ERROR_FRAGMENTS = (
    "context window",
    "context length",
    "maximum context",
    "max context",
    "input is too long",
    "prompt is too long",
    "too long for requested model",
    "too many tokens",
    "exceeds the context",
    "exceeded the context",
    "input too long",
    "maximum input length",
    "context_size",
    "context size",
    "length limit exceeded",
    "payload too large",
)

MODEL_ACCESS_DENIED_MESSAGE = (
    "This model is temporarily not available for your account. "
    "Please switch to a different model (e.g. Claude Sonnet 5, Claude Haiku 4.5, or a GPT model) and retry. "
    "This is a known issue — see [CBO-745](https://portico.atlassian.net/browse/CBO-745) for details and updates."
)
_MODEL_ACCESS_DENIED_FRAGMENTS = (
    "accessdeniedexception",
    "aws-marketplace",
    "viewsubscriptions",
    "marketplace actions",
)

# The Jupiter security-stack LLM routing service rejects image/audio/video
# content in its current MVP with a raw provider error. Rewrite that
# deterministic rejection into clear, actionable guidance for the user.
MULTIMODAL_UNSUPPORTED_MESSAGE = (
    "Image, audio, and video attachments are not supported on this Portico build yet. "
    "Please remove the attachment and resend your message as text. "
    "This is a known limitation — see [PORTICO-156](https://portico.atlassian.net/browse/PORTICO-156) for updates."
)
_MULTIMODAL_UNSUPPORTED_FRAGMENTS = (
    "multimodal content (images, audio, video) is not supported",
    "multimodal content is not supported",
)

MCP_CONFIGS_DIR = Path("/app/mcp-configs")
MCP_CONFIGS_USER_DIR = Path("/app/mcp-configs-user")
_TOOL_RENAME_CACHE: dict[str, dict[str, Any]] = {}
_SERVER_METADATA_CACHE: dict[str, dict[str, Any]] = {}
_TOOL_NAME_SANITIZE_RE = re.compile(r"[^A-Za-z0-9_]+")
_DIRECT_TOOL_EVENT_CALL_TIMEOUT_ENV = "DIRECT_TOOL_EVENT_CALL_TIMEOUT_SECONDS"
_DEFAULT_DIRECT_TOOL_EVENT_CALL_TIMEOUT_SECONDS = 120.0
_DIRECT_TOOL_EVENT_NO_TIMEOUT_PATTERNS_ENV = "DIRECT_TOOL_EVENT_NO_TIMEOUT_PATTERNS"
_DEFAULT_DIRECT_TOOL_EVENT_NO_TIMEOUT_PATTERNS = ("run_subagent",)
_DYNAMIC_TOOL_READY_TIMEOUT_SECONDS = 30.0
_DYNAMIC_TOOL_READY_POLL_INTERVAL_SECONDS = 0.5
_DYNAMIC_TOOL_OPENAPI_TIMEOUT_SECONDS = 3.0
MCPO_REGULAR_PROXY_BASE_URL = os.environ.get(
    "MCPO_REGULAR_PROXY_BASE_URL",
    "http://mcpo",
).rstrip("/")
MCPO_CORE_PROXY_BASE_URL = os.environ.get(
    "MCPO_CORE_PROXY_BASE_URL",
    "http://mcpo-core:8081",
).rstrip("/")
MCPO_HOST_PROXY_BASE_URL = os.environ.get(
    "HOST_MCPO_BASE_URL",
    "http://host.docker.internal:8890",
).rstrip("/")

_LEGACY_TOOL_FOLLOWUP_CONTINUATION_SYSTEM_MESSAGE = (
    "Internal tool follow-up for the same assistant turn. "
    "No new user message was sent. Continue the current answer using the "
    "existing conversation and the tool results below."
)


def _strip_legacy_tool_followup_system_message(
    messages: list[dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    if not isinstance(messages, list):
        return messages or []

    cleaned_messages: list[dict[str, Any]] = []
    fragment_pattern = re.compile(
        rf"(?:\n\s*)?{re.escape(_LEGACY_TOOL_FOLLOWUP_CONTINUATION_SYSTEM_MESSAGE)}(?:\s*\n)?"
    )

    for message in messages:
        if not isinstance(message, dict):
            cleaned_messages.append(message)
            continue

        next_message = dict(message)
        content = next_message.get("content")
        if (
            next_message.get("role") == "system"
            and isinstance(content, str)
            and _LEGACY_TOOL_FOLLOWUP_CONTINUATION_SYSTEM_MESSAGE in content
        ):
            content = fragment_pattern.sub("\n", content)
            content = re.sub(r"\n{3,}", "\n\n", content).strip()
            next_message["content"] = content

        cleaned_messages.append(next_message)

    return cleaned_messages


def _strip_replayed_model_system_prompt(
    messages: list[dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    if not isinstance(messages, list):
        return messages or []

    cleaned_messages: list[dict[str, Any]] = []
    stripping_leading_system_messages = True

    for message in messages:
        if not isinstance(message, dict):
            cleaned_messages.append(message)
            stripping_leading_system_messages = False
            continue

        if not stripping_leading_system_messages:
            cleaned_messages.append(message)
            continue

        if message.get("role") != "system":
            cleaned_messages.append(message)
            stripping_leading_system_messages = False
            continue

        content = message.get("content")
        if isinstance(content, str) and "<portico_context>" in content:
            cleaned_messages.append(message)
            stripping_leading_system_messages = False
            continue

        log.info(
            "[FOLLOW-UP] Dropping replayed provider/system prompt before rebuilding request"
        )

    return cleaned_messages


def _ensure_internal_request_system_prompt_placeholder(
    messages: list[dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    if not isinstance(messages, list):
        return [{"role": "system", "content": ""}]

    copied_messages: list[dict[str, Any]] = []
    for message in messages:
        if isinstance(message, dict):
            copied_messages.append(dict(message))
        else:
            copied_messages.append(message)

    if copied_messages:
        first_message = copied_messages[0]
        if (
            isinstance(first_message, dict)
            and first_message.get("role") == "system"
            and isinstance(first_message.get("content"), str)
            and first_message.get("content", "").strip() == ""
        ):
            return copied_messages

    return [{"role": "system", "content": ""}, *copied_messages]


def _is_retrieval_enabled(request: Optional[Request] = None) -> bool:
    if request is not None:
        return not getattr(
            request.app.state.config,
            "BYPASS_EMBEDDING_AND_RETRIEVAL",
            RETRIEVAL_DISABLED,
        )
    return not RETRIEVAL_DISABLED


def _is_code_interpreter_enabled(request: Optional[Request] = None) -> bool:
    if request is not None:
        return getattr(
            request.app.state.config,
            "ENABLE_CODE_INTERPRETER",
            CODE_INTERPRETER_ENABLED,
        )
    return CODE_INTERPRETER_ENABLED


def _load_memory_helpers():
    from open_webui.routers.memories import query_memory, QueryMemoryForm

    return query_memory, QueryMemoryForm


def _load_retrieval_helpers():
    from open_webui.routers.retrieval import process_web_search, SearchForm
    from open_webui.retrieval.utils import get_sources_from_items

    return process_web_search, SearchForm, get_sources_from_items


def _load_execute_code_jupyter():
    from open_webui.utils.code_interpreter import execute_code_jupyter

    return execute_code_jupyter


def _normalize_server_id(server_id: str) -> str:
    if not server_id:
        return ""
    while server_id.startswith("server:"):
        server_id = server_id[len("server:") :]
    return server_id


def _canonicalize_tool_ids_for_loading(tool_ids: Any) -> list[Any]:
    canonical_tool_ids = []
    seen_server_tool_ids = set()
    for tool_id in _coerce_tool_ids(tool_ids):
        canonical_tool_id = (
            f"server:{_normalize_server_id(tool_id)}"
            if isinstance(tool_id, str) and tool_id.startswith("server:")
            else tool_id
        )
        if isinstance(canonical_tool_id, str) and canonical_tool_id.startswith("server:"):
            if canonical_tool_id in seen_server_tool_ids:
                continue
            seen_server_tool_ids.add(canonical_tool_id)
        canonical_tool_ids.append(canonical_tool_id)
    return canonical_tool_ids


def _find_mcp_yaml_path(server_id: str) -> Optional[Path]:
    server_id = _normalize_server_id(server_id)
    system_dir = MCP_CONFIGS_DIR / server_id
    system_yaml = system_dir / f"{server_id}.yaml"
    if system_dir.is_dir():
        return system_yaml if system_yaml.is_file() else None

    user_yaml = MCP_CONFIGS_USER_DIR / server_id / f"{server_id}.yaml"
    return user_yaml if user_yaml.is_file() else None


def _sanitize_tool_name(name: str) -> str:
    if not name:
        return ""
    sanitized = _TOOL_NAME_SANITIZE_RE.sub("_", name.strip())
    return re.sub(r"_+", "_", sanitized).strip("_")


def _load_tool_rename_mapping(server_id: str) -> dict[str, str]:
    normalized_id = _normalize_server_id(server_id)
    yaml_path = _find_mcp_yaml_path(normalized_id)
    if not yaml_path:
        return {}

    try:
        mtime = yaml_path.stat().st_mtime
    except OSError:
        return {}

    cached = _TOOL_RENAME_CACHE.get(normalized_id)
    if cached and cached.get("mtime") == mtime:
        return cached.get("mapping", {})

    if yaml is None:
        return {}

    try:
        with open(yaml_path, "r", encoding="utf-8") as handle:
            data = yaml.safe_load(handle) or {}
    except Exception as e:
        log.warning(f"[MCP_TOOLS] Failed reading YAML for {server_id}: {e}")
        return {}

    mapping = data.get("tool_rename_mapping", {})
    if not isinstance(mapping, dict):
        mapping = {}

    cleaned = {}
    for key, value in mapping.items():
        if not isinstance(key, str) or not isinstance(value, str):
            continue
        cleaned[key] = value
        lower_key = key.lower()
        if lower_key not in cleaned:
            cleaned[lower_key] = value
    _TOOL_RENAME_CACHE[normalized_id] = {"mtime": mtime, "mapping": cleaned}
    return cleaned


def _load_server_metadata(server_id: str) -> dict[str, Any]:
    normalized_id = _normalize_server_id(server_id)
    yaml_path = _find_mcp_yaml_path(normalized_id)
    if not yaml_path:
        return {
            "description": "",
            "display_name": "",
            "is_core": False,
            "deployment_type": "docker",
            "exists": False,
        }

    try:
        mtime = yaml_path.stat().st_mtime
    except OSError:
        return {
            "description": "",
            "display_name": "",
            "is_core": False,
            "deployment_type": "docker",
            "exists": False,
        }

    cached = _SERVER_METADATA_CACHE.get(normalized_id)
    if cached and cached.get("mtime") == mtime:
        return {
            "description": cached.get("description", ""),
            "display_name": cached.get("display_name", ""),
            "is_core": bool(cached.get("is_core", False)),
            "deployment_type": cached.get("deployment_type", "docker"),
            "exists": True,
        }

    if yaml is None:
        return {
            "description": "",
            "display_name": "",
            "is_core": False,
            "deployment_type": "docker",
            "exists": False,
        }

    try:
        with open(yaml_path, "r", encoding="utf-8") as handle:
            data = yaml.safe_load(handle) or {}
    except Exception as e:
        log.warning(f"[MCP_TOOLS] Failed reading YAML for {server_id}: {e}")
        return {
            "description": "",
            "display_name": "",
            "is_core": False,
            "deployment_type": "docker",
            "exists": False,
        }

    description = data.get("description", "")
    if not isinstance(description, str):
        description = ""
    description = " ".join(description.split()).strip()
    display_name = data.get(
        "display_name",
        normalized_id.replace("-", " ").replace("_", " ").title(),
    )
    if not isinstance(display_name, str):
        display_name = normalized_id.replace("-", " ").replace("_", " ").title()
    is_core = data.get("is_core", False)
    if not isinstance(is_core, bool):
        is_core = False
    deployment_type = data.get("deployment_type", "docker")
    if deployment_type not in {"docker", "host"}:
        deployment_type = "docker"
    _SERVER_METADATA_CACHE[normalized_id] = {
        "mtime": mtime,
        "description": description,
        "display_name": display_name,
        "is_core": is_core,
        "deployment_type": deployment_type,
    }
    return {
        "description": description,
        "display_name": display_name,
        "is_core": is_core,
        "deployment_type": deployment_type,
        "exists": True,
    }


def _proxy_base_url_for_server_metadata(server_meta: dict[str, Any]) -> str:
    if server_meta.get("is_core"):
        return MCPO_CORE_PROXY_BASE_URL
    if server_meta.get("deployment_type") == "host":
        return MCPO_HOST_PROXY_BASE_URL
    return MCPO_REGULAR_PROXY_BASE_URL


def _proxy_base_url_for_server_id(server_id: str) -> str:
    return _proxy_base_url_for_server_metadata(_load_server_metadata(server_id))


def _load_server_description(server_id: str) -> str:
    return _load_server_metadata(server_id).get("description", "")


def _resolve_tool_server_id(tool: Optional[dict[str, Any]]) -> Optional[str]:
    if not isinstance(tool, dict):
        return None

    candidates = [tool.get("server_id"), tool.get("tool_id")]

    server = tool.get("server")
    if isinstance(server, dict):
        candidates.append(server.get("id"))

    tool_server_data = tool.get("tool_server_data")
    if isinstance(tool_server_data, dict):
        candidates.append(tool_server_data.get("id"))

    tool_server_connection = tool.get("tool_server_connection")
    if isinstance(tool_server_connection, dict):
        info = tool_server_connection.get("info")
        if isinstance(info, dict):
            candidates.append(info.get("id"))

    for candidate in candidates:
        if not isinstance(candidate, str):
            continue
        normalized = _normalize_server_id(candidate)
        if normalized:
            return normalized

    return None


def _get_renamed_tool_name(rename_mapping: dict[str, str], original_name: str) -> str:
    if not rename_mapping:
        return original_name
    desired = rename_mapping.get(original_name) or rename_mapping.get(
        original_name.lower()
    )
    if not desired:
        return original_name
    sanitized = _sanitize_tool_name(desired)
    return sanitized or original_name


def _is_context_window_error(message: str) -> bool:
    if not message:
        return False
    lowered = message.lower()
    return any(fragment in lowered for fragment in _CONTEXT_WINDOW_ERROR_FRAGMENTS)


def _is_model_access_denied_error(message: str) -> bool:
    if not message:
        return False
    lowered = message.lower()
    return any(fragment in lowered for fragment in _MODEL_ACCESS_DENIED_FRAGMENTS)


def _is_multimodal_unsupported_error(message: str) -> bool:
    if not message:
        return False
    lowered = message.lower()
    return any(fragment in lowered for fragment in _MULTIMODAL_UNSUPPORTED_FRAGMENTS)


def _is_bedrock_malformed_tool_use_error(message: str) -> bool:
    if not message:
        return False
    lowered = message.strip().lower()
    return BEDROCK_MALFORMED_TOOL_USE_ERROR_KIND in lowered or (
        "stopreason=tool_use" in lowered
        and "without a tooluse content block" in lowered
    )


def _is_empty_tool_call_terminal(
    *,
    finish_reason: Any,
    stop_reason: Any,
    response_tool_calls: Any,
) -> bool:
    if response_tool_calls:
        return False
    terminal_reasons = {
        str(reason).strip().lower()
        for reason in (finish_reason, stop_reason)
        if reason is not None and str(reason).strip()
    }
    return bool(terminal_reasons & {"tool_calls", "tool_use"})


def _format_error_message(message: str) -> str:
    if _is_context_window_error(message):
        return CONTEXT_WINDOW_ERROR_MESSAGE
    if _is_model_access_denied_error(message):
        return MODEL_ACCESS_DENIED_MESSAGE
    if _is_multimodal_unsupported_error(message):
        return MULTIMODAL_UNSUPPORTED_MESSAGE
    if _is_bedrock_malformed_tool_use_error(message):
        return MALFORMED_TOOL_USE_USER_MESSAGE
    return message


def _extract_error_message(error_data: Any) -> str:
    if isinstance(error_data, JSONResponse):
        body = error_data.body
        if isinstance(body, (bytes, bytearray)):
            body_text = body.decode("utf-8", "replace")
        elif isinstance(body, str):
            body_text = body
        else:
            body_text = None

        if body_text:
            try:
                parsed = json.loads(body_text)
            except json.JSONDecodeError:
                return body_text
            return _extract_error_message(parsed)

        if isinstance(body, dict):
            return _extract_error_message(body)

    if isinstance(error_data, Response):
        body = getattr(error_data, "body", None)
        body_text = None
        if isinstance(body, (bytes, bytearray)):
            body_text = body.decode("utf-8", "replace")
        elif isinstance(body, str):
            body_text = body

        if body_text:
            try:
                parsed = json.loads(body_text)
            except json.JSONDecodeError:
                return body_text
            return _extract_error_message(parsed)

        status_code = getattr(error_data, "status_code", None)
        if status_code is not None:
            return f"HTTP {status_code}"

    if isinstance(error_data, dict):
        err = error_data.get("error")
        if isinstance(err, dict):
            if "message" in err:
                return str(err["message"])
            if "detail" in err:
                return str(err["detail"])
            if "error" in err:
                return str(err["error"])
        if isinstance(err, str):
            return err
        if "detail" in error_data:
            return str(error_data["detail"])
        if "message" in error_data:
            return str(error_data["message"])
    if isinstance(error_data, str):
        return error_data
    return str(error_data)


def _normalize_non_streaming_response_payload(response: Any) -> Any:
    if isinstance(response, JSONResponse) and isinstance(response.body, bytes):
        try:
            return json.loads(response.body.decode("utf-8", "replace"))
        except json.JSONDecodeError:
            return {"error": {"detail": "Invalid JSON response"}}

    return response


def _get_non_streaming_response_error_source(
    response: Any,
    response_data: Any | None = None,
) -> Any | None:
    if response_data is None:
        response_data = _normalize_non_streaming_response_payload(response)

    status_code = _get_response_status_code(response)
    if status_code is not None and status_code >= 400:
        return response_data if isinstance(response_data, dict) else response

    if isinstance(response_data, dict) and "error" in response_data:
        return response_data

    return None


def _sync_flattened_message_with_history(chat_payload: dict, message_id: str) -> bool:
    if not isinstance(chat_payload, dict) or not message_id:
        return False

    history = chat_payload.get("history")
    if not isinstance(history, dict):
        return False

    history_messages = history.get("messages")
    if not isinstance(history_messages, dict):
        return False

    canonical_message = history_messages.get(message_id)
    if not isinstance(canonical_message, dict):
        return False

    flattened_message = dict(canonical_message)
    flat_messages = chat_payload.get("messages")

    if flat_messages is None:
        chat_payload["messages"] = [flattened_message]
        return True

    if not isinstance(flat_messages, list):
        return False

    for index, message in enumerate(flat_messages):
        if isinstance(message, dict) and message.get("id") == message_id:
            if message != canonical_message:
                flat_messages[index] = flattened_message
                return True
            return False

    flat_messages.append(flattened_message)
    return True


def _coerce_status_code(value: Any) -> Optional[int]:
    try:
        if value in (None, ""):
            return None
        return int(value)
    except (TypeError, ValueError):
        return None


def _get_response_status_code(error_data: Any) -> Optional[int]:
    if isinstance(error_data, Response):
        return _coerce_status_code(getattr(error_data, "status_code", None))

    if isinstance(error_data, dict):
        direct_status = _coerce_status_code(error_data.get("status_code"))
        if direct_status is not None:
            return direct_status

        err = error_data.get("error")
        if isinstance(err, dict):
            nested_status = _coerce_status_code(
                err.get("status_code") or err.get("code")
            )
            if nested_status is not None:
                return nested_status

    message = _extract_error_message(error_data)
    if isinstance(message, str):
        match = _HTTP_ERROR_STATUS_RE.search(message)
        if match:
            return _coerce_status_code(match.group(1))

    return None


def _retryable_chat_completion_error_reason(error_data: Any) -> Optional[str]:
    message = _extract_error_message(error_data).strip().lower()

    if _is_model_access_denied_error(message):
        return None
    if _is_context_window_error(message):
        return None
    if _is_multimodal_unsupported_error(message):
        return None
    if _is_bedrock_malformed_tool_use_error(message):
        return BEDROCK_MALFORMED_TOOL_USE_ERROR_KIND
    if message and all(
        fragment in message
        for fragment in (
            "validationexception",
            "content field in the message object",
            "is empty",
            "contentblock",
        )
    ):
        return None
    if message and all(
        fragment in message
        for fragment in _BEDROCK_UNEXPECTED_PROCESSING_ERROR_FRAGMENTS
    ):
        return "bedrock_unexpected_processing_error"
    if _is_bedrock_stream_inactive_error(message):
        return "bedrock_stream_inactive"
    if (
        "incomplete_stream" in message
        and (
            "bedrock converse" in message
            or "converse stream" in message
            or "message_stop" in message
            or "terminal event" in message
        )
    ):
        return "bedrock_incomplete_stream"

    status_code = _get_response_status_code(error_data)
    if status_code in _TRANSIENT_CHAT_COMPLETION_RETRYABLE_STATUS_CODES:
        return f"http_status_{status_code}"

    if not message:
        return None

    for fragment in _TRANSIENT_CHAT_COMPLETION_RETRYABLE_MESSAGE_FRAGMENTS:
        if fragment in message:
            return f"message_fragment:{fragment}"
    return None


def _is_retryable_chat_completion_error(error_data: Any) -> bool:
    return _retryable_chat_completion_error_reason(error_data) is not None


def _terminal_stop_reason_for_chat_completion_error(error_data: Any) -> str:
    if _is_bedrock_malformed_tool_use_error(_extract_error_message(error_data)):
        return MALFORMED_TOOL_USE_STOP_REASON
    return "upstream_error"


def _should_retry_chat_completion_attempt(
    error_data: Any, *, attempt: int, max_attempts: int
) -> bool:
    return (
        _is_retryable_chat_completion_error(error_data)
        and attempt < max_attempts
    )


def _is_bedrock_stream_inactive_error(message: str) -> bool:
    if not message:
        return False
    message = message.strip().lower()
    return (
        "bedrock" in message
        and "stream" in message
        and re.search(
            r"\bstream\s+inactive\s+for\s+more\s+than\s+\d+\s*ms\b",
            message,
        )
        is not None
    )


def _coerce_non_negative_int(value: Any) -> Optional[int]:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 0 else None


def _build_stream_attempt_snapshot(
    *,
    content: Any,
    content_blocks: Any,
    last_finish_reason: Any,
    last_stop_reason: Any,
    last_completion_tokens: Any,
    continuation_seam_deltas: Any,
    streaming_tool_calls_block_index: Any,
    tool_calls_queue_len: Any,
) -> dict[str, Any]:
    return {
        "content": content,
        "content_blocks": copy.deepcopy(content_blocks),
        "last_finish_reason": last_finish_reason,
        "last_stop_reason": last_stop_reason,
        "last_completion_tokens": last_completion_tokens,
        "continuation_seam_deltas": list(continuation_seam_deltas or []),
        "streaming_tool_calls_block_index": streaming_tool_calls_block_index,
        "tool_calls_queue_len": _coerce_non_negative_int(tool_calls_queue_len) or 0,
    }


def _restore_stream_attempt_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
    return {
        "content": snapshot.get("content", ""),
        "content_blocks": copy.deepcopy(snapshot.get("content_blocks", [])),
        "last_finish_reason": snapshot.get("last_finish_reason"),
        "last_stop_reason": snapshot.get("last_stop_reason"),
        "last_completion_tokens": snapshot.get("last_completion_tokens"),
        "continuation_seam_deltas": list(
            snapshot.get("continuation_seam_deltas") or []
        ),
        "streaming_tool_calls_block_index": snapshot.get(
            "streaming_tool_calls_block_index"
        ),
        "tool_calls_queue_len": _coerce_non_negative_int(
            snapshot.get("tool_calls_queue_len")
        )
        or 0,
    }


def _should_retry_stream_error_event(
    error_data: Any,
    *,
    tool_calls_queued_at_attempt_start: Any,
    current_tool_calls_queued: Any,
) -> bool:
    if not _is_retryable_chat_completion_error(error_data):
        return False

    starting_queue_len = _coerce_non_negative_int(
        tool_calls_queued_at_attempt_start
    )
    current_queue_len = _coerce_non_negative_int(current_tool_calls_queued)
    if starting_queue_len is None or current_queue_len is None:
        return False

    return current_queue_len == starting_queue_len


def _status_event_observed_at() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _build_upstream_retry_status_data(
    *,
    description: str,
    done: bool,
    hidden: bool = False,
    error: bool = False,
    observed_at: Optional[str] = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "action": UPSTREAM_RETRY_STATUS_ACTION,
        "status_key": UPSTREAM_RETRY_STATUS_KEY,
        "description": description,
        "done": done,
        "observed_at": observed_at or _status_event_observed_at(),
    }
    if hidden:
        payload["hidden"] = True
    if error:
        payload["error"] = True
    return payload


async def _emit_upstream_retry_status(
    event_emitter: Optional[Callable],
    *,
    description: str,
    done: bool,
    hidden: bool = False,
    error: bool = False,
) -> None:
    if not event_emitter:
        return
    try:
        await event_emitter(
            {
                "type": "status",
                "data": _build_upstream_retry_status_data(
                    description=description,
                    done=done,
                    hidden=hidden,
                    error=error,
                ),
            }
        )
    except Exception as exc:
        log.debug("[STATUS] Failed to emit upstream retry status: %s", exc)


def _get_bedrock_stream_inactive_retry_max_attempts() -> int:
    return _positive_int_from_env(
        "OPENWEBUI_TRANSIENT_CHAT_COMPLETION_BEDROCK_STREAM_INACTIVE_RETRY_MAX_ATTEMPTS",
        _BEDROCK_STREAM_INACTIVE_RETRY_MAX_ATTEMPTS,
    )


def _get_transient_chat_completion_retry_max_attempts(
    error_data: Any = None,
) -> int:
    if error_data is not None and _is_bedrock_malformed_tool_use_error(
        _extract_error_message(error_data)
    ):
        return _BEDROCK_MALFORMED_TOOL_USE_RETRY_MAX_ATTEMPTS
    if error_data is not None and _is_bedrock_stream_inactive_error(
        _extract_error_message(error_data)
    ):
        return _get_bedrock_stream_inactive_retry_max_attempts()
    return _positive_int_from_env(
        "OPENWEBUI_TRANSIENT_CHAT_COMPLETION_RETRY_MAX_ATTEMPTS",
        _TRANSIENT_CHAT_COMPLETION_RETRY_MAX_ATTEMPTS,
    )


def _get_chat_completion_request_retry_max_attempts(
    error_data: Any,
    request_form_data: Any,
) -> int:
    # Ultra admission is single-use. Retrying the outer request after the
    # gateway has accepted it would replay an ambiguous multi-agent turn.
    if is_ultra_request(request_form_data):
        return 1
    return _get_transient_chat_completion_retry_max_attempts(error_data)


def _get_transient_chat_completion_retry_delay_seconds(attempt_number: int) -> float:
    base_delay = _float_env(
        "OPENWEBUI_TRANSIENT_CHAT_COMPLETION_RETRY_BASE_DELAY_SECONDS",
        _TRANSIENT_CHAT_COMPLETION_RETRY_BASE_DELAY_SECONDS,
    )
    max_delay = _float_env(
        "OPENWEBUI_TRANSIENT_CHAT_COMPLETION_RETRY_MAX_DELAY_SECONDS",
        _TRANSIENT_CHAT_COMPLETION_RETRY_MAX_DELAY_SECONDS,
    )
    return max(
        0.0,
        min(
            max_delay,
            base_delay * (2 ** max(0, int(attempt_number or 1) - 1)),
        ),
    )


def _is_retryable_tool_execution_error(error_data: Any) -> bool:
    normalized_error = normalize_tool_execution_error(error_data)
    if not isinstance(normalized_error, dict):
        return _is_retryable_chat_completion_error(error_data)

    normalized_payload = normalized_error
    if normalized_payload.get("retry_policy_owner") == "mcp-orc":
        return False
    status_code = _get_response_status_code(normalized_payload)
    if status_code == 401:
        return False

    authorization_url = normalized_payload.get("authorization_url")
    if isinstance(authorization_url, str) and authorization_url.strip():
        return False
    if normalized_payload.get("oauth_recovery_required") or normalized_payload.get(
        "force_auth_recommended"
    ):
        return False

    nested_error = normalized_payload.get("error")
    if isinstance(nested_error, dict):
        if nested_error.get("retry_policy_owner") == "mcp-orc":
            return False
        if nested_error.get("error_type") == "tool_timeout":
            return False
        nested_authorization_url = nested_error.get("authorization_url")
        if (
            isinstance(nested_authorization_url, str)
            and nested_authorization_url.strip()
        ):
            return False
        if nested_error.get("oauth_recovery_required") or nested_error.get(
            "force_auth_recommended"
        ):
            return False

    return _is_retryable_chat_completion_error(normalized_payload)


def _is_retryable_tool_execution_result(result_data: Any) -> bool:
    normalized_result = normalize_tool_execution_error(result_data)
    if not isinstance(normalized_result, dict):
        return _is_retryable_chat_completion_error(result_data)

    normalized_payload = normalized_result
    if normalized_payload.get("retry_policy_owner") == "mcp-orc":
        return False
    status_code = _get_response_status_code(normalized_payload)
    if status_code == 401:
        return False

    authorization_url = normalized_payload.get("authorization_url")
    if isinstance(authorization_url, str) and authorization_url.strip():
        return False
    if normalized_payload.get("oauth_recovery_required") or normalized_payload.get(
        "force_auth_recommended"
    ):
        return False

    nested_error = normalized_payload.get("error")
    if isinstance(nested_error, dict):
        if nested_error.get("retry_policy_owner") == "mcp-orc":
            return False
        if nested_error.get("error_type") == "tool_timeout":
            return False
        nested_authorization_url = nested_error.get("authorization_url")
        if (
            isinstance(nested_authorization_url, str)
            and nested_authorization_url.strip()
        ):
            return False
        if nested_error.get("oauth_recovery_required") or nested_error.get(
            "force_auth_recommended"
        ):
            return False

    return _is_retryable_chat_completion_error(normalized_payload)


def _get_transient_tool_execution_retry_max_attempts() -> int:
    if not _optimization_flag_enabled("retry_transient_tool_execution_failures", True):
        return 1
    return _positive_int_from_env(
        "OPENWEBUI_TRANSIENT_TOOL_EXECUTION_RETRY_MAX_ATTEMPTS",
        _TRANSIENT_TOOL_EXECUTION_RETRY_MAX_ATTEMPTS,
    )


def _get_transient_tool_execution_retry_delay_seconds(
    attempt_number: int,
) -> float:
    base_delay = _float_env(
        "OPENWEBUI_TRANSIENT_TOOL_EXECUTION_RETRY_BASE_DELAY_SECONDS",
        _TRANSIENT_TOOL_EXECUTION_RETRY_BASE_DELAY_SECONDS,
    )
    max_delay = _float_env(
        "OPENWEBUI_TRANSIENT_TOOL_EXECUTION_RETRY_MAX_DELAY_SECONDS",
        _TRANSIENT_TOOL_EXECUTION_RETRY_MAX_DELAY_SECONDS,
    )
    return max(
        0.0,
        min(
            max_delay,
            base_delay * (2 ** max(0, int(attempt_number or 1) - 1)),
        ),
    )


def _get_direct_tool_event_call_timeout_seconds() -> float:
    raw_value = os.getenv(
        _DIRECT_TOOL_EVENT_CALL_TIMEOUT_ENV,
        str(_DEFAULT_DIRECT_TOOL_EVENT_CALL_TIMEOUT_SECONDS),
    )
    try:
        timeout_seconds = float(raw_value)
    except (TypeError, ValueError):
        log.warning(
            "[TOOLS] Invalid %s=%s, using default %.1fs",
            _DIRECT_TOOL_EVENT_CALL_TIMEOUT_ENV,
            raw_value,
            _DEFAULT_DIRECT_TOOL_EVENT_CALL_TIMEOUT_SECONDS,
        )
        return _DEFAULT_DIRECT_TOOL_EVENT_CALL_TIMEOUT_SECONDS

    if timeout_seconds <= 0:
        log.warning(
            "[TOOLS] Non-positive %s=%s, using default %.1fs",
            _DIRECT_TOOL_EVENT_CALL_TIMEOUT_ENV,
            raw_value,
            _DEFAULT_DIRECT_TOOL_EVENT_CALL_TIMEOUT_SECONDS,
        )
        return _DEFAULT_DIRECT_TOOL_EVENT_CALL_TIMEOUT_SECONDS

    return timeout_seconds


async def _call_direct_tool_event(
    event_caller,
    payload: dict,
    tool_function_name: str,
):
    lowered_tool_name = (tool_function_name or "").lower()
    raw_patterns = os.getenv(
        _DIRECT_TOOL_EVENT_NO_TIMEOUT_PATTERNS_ENV,
        ",".join(_DEFAULT_DIRECT_TOOL_EVENT_NO_TIMEOUT_PATTERNS),
    )
    no_timeout_patterns = [
        pattern.strip().lower()
        for pattern in raw_patterns.split(",")
        if pattern and pattern.strip()
    ]
    if any(pattern in lowered_tool_name for pattern in no_timeout_patterns):
        log.info(
            "[TOOLS] Skipping direct tool callback timeout for '%s' (matched %s)",
            tool_function_name,
            _DIRECT_TOOL_EVENT_NO_TIMEOUT_PATTERNS_ENV,
        )
        return await event_caller(payload)

    timeout_seconds = _get_direct_tool_event_call_timeout_seconds()
    try:
        return await asyncio.wait_for(event_caller(payload), timeout=timeout_seconds)
    except asyncio.TimeoutError as e:
        raise TimeoutError(
            f"Timed out waiting {timeout_seconds:.1f}s for direct tool callback "
            f"({tool_function_name})"
        ) from e


def _coerce_tool_ids(tool_ids: Any) -> list[str]:
    if not tool_ids:
        return []
    if isinstance(tool_ids, str):
        return [tool_ids]
    return list(tool_ids)


def _extract_tool_server_id(tool_id: str) -> str:
    if not tool_id:
        return ""
    if tool_id.startswith("server:mcp:"):
        return tool_id[len("server:mcp:") :]
    if tool_id.startswith("server:"):
        return tool_id[len("server:") :]
    return tool_id


def _is_openai_prompt_cache_tool_model(model_name: Any) -> bool:
    model_lower = str(model_name or "").strip().lower()
    if not model_lower:
        return False
    if "gpt-5.4-pro" in model_lower or "gpt-5.4 pro" in model_lower:
        return False
    return model_lower.startswith("gpt-5") or model_lower.startswith("gpt-4.1")


def _canonicalize_openai_tool_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: _canonicalize_openai_tool_value(value[key])
            for key in sorted(value.keys())
        }
    if isinstance(value, list):
        return [_canonicalize_openai_tool_value(item) for item in value]
    return value


def _stable_tool_payload_dump(value: Any) -> str:
    try:
        return json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            default=str,
        )
    except Exception:
        return repr(value)


def _trim_openai_tool_description(
    value: Any,
    max_chars: int = 240,
) -> Optional[str]:
    if not isinstance(value, str):
        return None

    normalized = " ".join(value.split()).strip()
    if not normalized:
        return None
    if len(normalized) <= max_chars:
        return normalized
    return f"{normalized[: max_chars - 3].rstrip()}..."




def _compact_openai_parameter_schema(schema: Any) -> Any:
    # Keep a minimal but valid recursive schema shape for GPT tool calling.
    # We intentionally strip verbose fields, but must preserve enough
    # structure for strict providers to validate object/array arguments.
    if isinstance(schema, list):
        return [_compact_openai_parameter_schema(item) for item in schema]

    if not isinstance(schema, dict):
        return schema

    compact_schema: dict[str, Any] = {}

    schema_type = schema.get("type")
    if isinstance(schema_type, str):
        compact_schema["type"] = schema_type
    elif isinstance(schema_type, list) and all(
        isinstance(item, str) for item in schema_type
    ):
        compact_schema["type"] = list(schema_type)

    enum_values = schema.get("enum")
    if isinstance(enum_values, list) and enum_values:
        compact_schema["enum"] = list(enum_values)

    required = schema.get("required")
    if isinstance(required, list) and required:
        compact_schema["required"] = sorted(
            item for item in required if isinstance(item, str)
        )

    properties = schema.get("properties")
    if isinstance(properties, dict) and properties:
        compact_properties = {
            str(key): _compact_openai_parameter_schema(value)
            for key, value in properties.items()
            if isinstance(key, str)
        }
        if compact_properties:
            compact_schema["properties"] = compact_properties

    items = schema.get("items")
    if items is not None:
        compact_schema["items"] = _compact_openai_parameter_schema(items)

    additional_properties = schema.get("additionalProperties")
    if isinstance(additional_properties, bool):
        compact_schema["additionalProperties"] = additional_properties
    elif isinstance(additional_properties, dict):
        compact_schema["additionalProperties"] = _compact_openai_parameter_schema(
            additional_properties
        )

    for union_key in ("oneOf", "anyOf", "allOf"):
        union_value = schema.get(union_key)
        if isinstance(union_value, list) and union_value:
            compact_schema[union_key] = [
                _compact_openai_parameter_schema(item) for item in union_value
            ]

    if compact_schema.get("type") == "object" and "properties" not in compact_schema:
        compact_schema["properties"] = {}

    return compact_schema


def _compact_openai_function_tool(tool_payload: Any) -> dict:
    if not isinstance(tool_payload, dict):
        return {}

    if tool_payload.get("type") != "function":
        return _canonicalize_openai_tool_value(tool_payload)

    function_payload = tool_payload.get("function")
    if not isinstance(function_payload, dict):
        return _canonicalize_openai_tool_value(tool_payload)

    compact_function: dict[str, Any] = {}

    function_name = function_payload.get("name")
    if isinstance(function_name, str) and function_name.strip():
        compact_function["name"] = function_name.strip()

    compact_description = _trim_openai_tool_description(
        function_payload.get("description")
    )
    if compact_description:
        compact_function["description"] = compact_description

    parameters = function_payload.get("parameters")
    if isinstance(parameters, dict):
        compact_function["parameters"] = _compact_openai_parameter_schema(parameters)
    elif parameters is not None:
        compact_function["parameters"] = parameters

    strict_value = function_payload.get("strict")
    if isinstance(strict_value, bool):
        compact_function["strict"] = strict_value

    return _canonicalize_openai_tool_value(
        {"type": "function", "function": compact_function}
    )


_OPENAI_PROMPT_CACHE_CORE_SERVER_IDS = frozenset(
    {"mcp-assistant", "skills", "subagents"}
)
_GPT_OPENAI_ROUTE_MODE_ENV = "GPT_OPENAI_ROUTE_MODE"
_GPT_OPENAI_ROUTE_MODE_DIRECT = "direct"
_GPT_OPENAI_ROUTE_MODE_BIFROST = "bifrost"


def _is_gpt5_responses_api_model(model_name: Any) -> bool:
    model_lower = str(model_name or "").strip().lower()
    return model_lower.startswith("gpt-5")


def _get_gpt_openai_route_mode() -> str:
    raw_value = str(os.getenv(_GPT_OPENAI_ROUTE_MODE_ENV, "") or "").strip().lower()
    if raw_value in {"", _GPT_OPENAI_ROUTE_MODE_DIRECT}:
        return _GPT_OPENAI_ROUTE_MODE_DIRECT
    if raw_value == _GPT_OPENAI_ROUTE_MODE_BIFROST:
        return _GPT_OPENAI_ROUTE_MODE_BIFROST
    log.warning(
        "[GPT_ROUTE] Invalid %s=%s; falling back to %s",
        _GPT_OPENAI_ROUTE_MODE_ENV,
        raw_value,
        _GPT_OPENAI_ROUTE_MODE_DIRECT,
    )
    return _GPT_OPENAI_ROUTE_MODE_DIRECT


def _build_tool_namespace_metadata(
    tools_dict: Optional[dict],
    tool_ids: Optional[list] = None,
) -> dict[str, dict[str, Any]]:
    if not tools_dict:
        return {}

    # Collect server_ids from tool entries (MCP path sets server_id directly)
    server_ids: set[str] = set()
    for tool_entry in tools_dict.values():
        sid = tool_entry.get("server_id") if isinstance(tool_entry, dict) else None
        if isinstance(sid, str) and sid:
            server_ids.add(sid)

    # Fallback: infer server_ids from tool_ids list (e.g., "server:google_workspace")
    # when tool entries don't carry server_id (OWUI tool registry / OpenAPI path).
    if not server_ids and tool_ids:
        for tool_id in tool_ids:
            sid = _normalize_server_id(tool_id) if isinstance(tool_id, str) else None
            if sid:
                server_ids.add(sid)

    result: dict[str, dict[str, Any]] = {}
    for sid in sorted(server_ids):
        prefix = _sanitize_tool_name(sid)
        if not prefix:
            continue
        # Only include if at least one tool name matches this server prefix
        if not any(name.startswith(f"{prefix}_") for name in tools_dict):
            continue
        metadata = _load_server_metadata(sid)
        desc = metadata.get("description") or prefix.replace("_", " ").title()
        result[prefix] = {
            "description": desc,
            "server_id": sid,
            "is_core": bool(metadata.get("is_core", False)),
        }
    return result


def _load_openai_prompt_cache_server_allowlist(
    chat_id: Optional[str],
    *,
    default_to_core: bool = False,
) -> Optional[set[str]]:
    if not chat_id:
        return None
    if not DYNAMIC_TOOLS_REDIS_AVAILABLE:
        return None

    try:
        redis_client = RedisClient(
            host="redis",
            port=6379,
            db=0,
            decode_responses=True,
            socket_connect_timeout=1,
        )
        skills_json = redis_client.get(f"chat_skills:{chat_id}")
        activated_skills = json.loads(skills_json) if skills_json else []

        required_server_ids: set[str] = set()
        chat_tools_json = redis_client.get(f"chat_tools:{chat_id}")
        chat_tools = json.loads(chat_tools_json) if chat_tools_json else []
        if isinstance(chat_tools, list):
            for tool_id in chat_tools:
                normalized = _normalize_server_id(tool_id)
                if normalized:
                    required_server_ids.add(normalized)

        if isinstance(activated_skills, list) and activated_skills and get_skill_manager:
            skill_manager = get_skill_manager()
            for skill_name in activated_skills:
                if not isinstance(skill_name, str) or not skill_name:
                    continue
                metadata = skill_manager.get_skill_metadata(skill_name)
                if metadata is None:
                    continue
                for server_id in metadata.required_mcp_servers or []:
                    normalized = _normalize_server_id(server_id)
                    if normalized:
                        required_server_ids.add(normalized)

        if not required_server_ids:
            return None

        return set(_OPENAI_PROMPT_CACHE_CORE_SERVER_IDS) | required_server_ids
    except Exception as e:
        log.debug(
            "[OPENAI_PROMPT_CACHE] Failed to resolve skill-based tool allowlist "
            "for chat %s: %s",
            chat_id,
            e,
        )
        return None


def _tool_payload_matches_server_allowlist(
    tool_payload: Any,
    allowed_server_ids: set[str],
) -> bool:
    if not isinstance(tool_payload, dict) or not allowed_server_ids:
        return True

    function_payload = tool_payload.get("function")
    if not isinstance(function_payload, dict):
        return True

    function_name = function_payload.get("name")
    if not isinstance(function_name, str) or not function_name:
        return True

    normalized_name = _sanitize_tool_name(function_name)
    for server_id in sorted(allowed_server_ids, key=len, reverse=True):
        server_prefix = _sanitize_tool_name(server_id)
        if not server_prefix:
            continue
        if normalized_name == server_prefix or normalized_name.startswith(
            f"{server_prefix}_"
        ):
            return True

    return False


def _openai_tool_sort_key(tool_payload: Any) -> tuple[str, str, str]:
    if not isinstance(tool_payload, dict):
        return ("", "", "")

    function_payload = tool_payload.get("function")
    if not isinstance(function_payload, dict):
        return ("", "", _stable_tool_payload_dump(tool_payload))

    function_name = function_payload.get("name")
    if not isinstance(function_name, str):
        function_name = ""

    return (
        function_name.lower(),
        function_name,
        _stable_tool_payload_dump(tool_payload),
    )


def _canonicalize_openai_function_tools(tool_payloads: Any) -> list[dict]:
    if not isinstance(tool_payloads, list):
        return []

    canonical_tools = []
    for tool_payload in tool_payloads:
        if not isinstance(tool_payload, dict):
            continue
        canonical_tools.append(_canonicalize_openai_tool_value(tool_payload))

    canonical_tools.sort(key=_openai_tool_sort_key)
    return canonical_tools


def _normalize_openai_function_tools_payloads(
    tool_payloads: Any,
    chat_id: Optional[str] = None,
    *,
    prefer_core_tool_allowlist: bool = False,
) -> list[dict]:
    if not isinstance(tool_payloads, list):
        return []

    normalized_tools = [
        _compact_openai_function_tool(tool_payload)
        for tool_payload in tool_payloads
        if isinstance(tool_payload, dict)
    ]
    allowed_server_ids = _load_openai_prompt_cache_server_allowlist(
        chat_id,
        default_to_core=prefer_core_tool_allowlist,
    )
    if allowed_server_ids:
        filtered_tools = [
            tool_payload
            for tool_payload in normalized_tools
            if _tool_payload_matches_server_allowlist(
                tool_payload, allowed_server_ids
            )
        ]
        if filtered_tools:
            log.info(
                "[OPENAI_PROMPT_CACHE] Reduced GPT tool payload for chat %s "
                "using core+skill server allowlist %s (%d -> %d tools)",
                chat_id,
                sorted(allowed_server_ids),
                len(normalized_tools),
                len(filtered_tools),
            )
            normalized_tools = filtered_tools

    return _canonicalize_openai_function_tools(normalized_tools)


def _build_openai_function_tools_payload(
    tools_dict: Optional[dict],
    model_name: Any,
    chat_id: Optional[str] = None,
    *,
    prefer_core_tool_allowlist: bool = False,
) -> list[dict]:
    tool_payloads = [
        {"type": "function", "function": tool.get("spec", {})}
        for tool in (tools_dict or {}).values()
    ]
    if _is_openai_prompt_cache_tool_model(model_name):
        return _normalize_openai_function_tools_payloads(
            tool_payloads,
            chat_id=chat_id,
            prefer_core_tool_allowlist=prefer_core_tool_allowlist,
        )
    return tool_payloads


def _ensure_native_tool_payload_for_active_tools(
    form_data: dict,
    metadata: dict,
    tools_dict: Optional[dict],
) -> bool:
    if not tools_dict:
        return False

    metadata_params = metadata.setdefault("params", {})
    if not isinstance(metadata_params, dict):
        metadata_params = {}
        metadata["params"] = metadata_params

    already_native = (
        metadata_params.get("function_calling") == "native"
        and bool(form_data.get("tools"))
        and form_data.get("metadata") is metadata
    )
    metadata_params["function_calling"] = "native"
    metadata["tools"] = tools_dict
    form_data["metadata"] = metadata
    form_data["tools"] = _build_openai_function_tools_payload(
        tools_dict,
        form_data.get("model"),
        metadata.get("chat_id"),
    )
    return not already_native


def _rebuild_followup_function_tools_payload(
    *,
    existing_tool_payloads: Any,
    metadata_tools: Optional[dict],
    model_name: Any,
    chat_id: Optional[str] = None,
    prefer_core_tool_allowlist: bool = False,
) -> list[dict]:
    if isinstance(metadata_tools, dict) and metadata_tools:
        rebuilt_payloads = _build_openai_function_tools_payload(
            metadata_tools,
            model_name,
            chat_id=chat_id,
            prefer_core_tool_allowlist=prefer_core_tool_allowlist,
        )
        if prefer_core_tool_allowlist:
            return rebuilt_payloads
        allowed_tool_names: set[str] = set()
        for tool_payload in existing_tool_payloads or []:
            if not isinstance(tool_payload, dict):
                continue
            function_payload = tool_payload.get("function")
            if not isinstance(function_payload, dict):
                continue
            tool_name = function_payload.get("name")
            if isinstance(tool_name, str) and tool_name:
                allowed_tool_names.add(tool_name)

        if allowed_tool_names:
            filtered_payloads = []
            for tool_payload in rebuilt_payloads:
                if not isinstance(tool_payload, dict):
                    continue
                function_payload = tool_payload.get("function")
                if not isinstance(function_payload, dict):
                    continue
                tool_name = function_payload.get("name")
                if isinstance(tool_name, str) and tool_name in allowed_tool_names:
                    filtered_payloads.append(tool_payload)
            return filtered_payloads

        return rebuilt_payloads

    if _is_openai_prompt_cache_tool_model(model_name):
        return _normalize_openai_function_tools_payloads(
            existing_tool_payloads or [],
            chat_id=chat_id,
            prefer_core_tool_allowlist=prefer_core_tool_allowlist,
        )

    if isinstance(existing_tool_payloads, list):
        return existing_tool_payloads

    return []


def _sanitize_replayed_tool_history_messages(
    messages: Any,
) -> tuple[list[dict[str, Any]], list[str], list[str]]:
    if not isinstance(messages, list):
        return [], [], []

    sanitized_messages: list[dict[str, Any]] = []
    dropped_call_ids: list[str] = []
    dropped_tool_names: list[str] = []

    def track_tool_call(tool_call: Any) -> None:
        if not isinstance(tool_call, dict):
            return
        tool_call_id = tool_call.get("id")
        if isinstance(tool_call_id, str) and tool_call_id and tool_call_id not in dropped_call_ids:
            dropped_call_ids.append(tool_call_id)
        function_payload = tool_call.get("function")
        if not isinstance(function_payload, dict):
            return
        tool_name = function_payload.get("name")
        if isinstance(tool_name, str) and tool_name and tool_name not in dropped_tool_names:
            dropped_tool_names.append(tool_name)

    for message in messages:
        if not isinstance(message, dict):
            continue

        role = message.get("role")
        if role == "tool":
            tool_call_id = message.get("tool_call_id")
            if (
                isinstance(tool_call_id, str)
                and tool_call_id
                and tool_call_id not in dropped_call_ids
            ):
                dropped_call_ids.append(tool_call_id)
            continue

        next_message = copy.deepcopy(message)

        if role == "assistant":
            tool_calls = next_message.pop("tool_calls", None)
            if isinstance(tool_calls, list):
                for tool_call in tool_calls:
                    track_tool_call(tool_call)

            content = next_message.get("content")
            if isinstance(content, list):
                filtered_content = []
                for part in content:
                    if not isinstance(part, dict):
                        filtered_content.append(part)
                        continue
                    part_type = str(part.get("type") or "")
                    if part_type in {"toolUse", "toolResult", "tool_use", "tool_result"}:
                        continue
                    filtered_content.append(part)
                next_message["content"] = filtered_content

            content = next_message.get("content")
            if isinstance(content, str):
                if content.strip():
                    sanitized_messages.append(next_message)
                continue

            if isinstance(content, list) and len(content) > 0:
                sanitized_messages.append(next_message)
                continue

            continue

        sanitized_messages.append(next_message)

    return sanitized_messages, dropped_call_ids, dropped_tool_names


def _ensure_replay_safe_tool_payload(
    *,
    form_data: dict[str, Any],
    metadata: dict[str, Any],
) -> None:
    message_list = form_data.get("messages")
    if not branch_has_replayed_tool_history(message_list):
        return

    rebuilt_tools = _rebuild_followup_function_tools_payload(
        existing_tool_payloads=form_data.get("tools", []),
        metadata_tools=metadata.get("tools"),
        model_name=form_data.get("model"),
        chat_id=metadata.get("chat_id"),
    )
    if rebuilt_tools:
        form_data["tools"] = rebuilt_tools
        log.info(
            "[REPLAY_TOOLS] Attached rebuilt tool payload for replay request chat_id=%s model=%s tool_count=%d",
            metadata.get("chat_id"),
            form_data.get("model"),
            len(rebuilt_tools),
        )
        return

    sanitized_messages, dropped_call_ids, dropped_tool_names = (
        _sanitize_replayed_tool_history_messages(message_list)
    )
    form_data["messages"] = sanitized_messages
    form_data.pop("tools", None)
    form_data.pop("_tool_namespaces", None)
    log.warning(
        "[REPLAY_TOOLS] Stripped replayed tool history because no effective tool payload could be built chat_id=%s model=%s dropped_call_ids=%s dropped_tool_names=%s",
        metadata.get("chat_id"),
        form_data.get("model"),
        dropped_call_ids,
        dropped_tool_names,
    )


def _merge_tool_ids(existing_tool_ids: list[str], new_tool_ids: list[str]) -> list[str]:
    merged_ids = list(existing_tool_ids or [])
    seen = set(merged_ids)
    for tool_id in new_tool_ids or []:
        if tool_id in seen:
            continue
        merged_ids.append(tool_id)
        seen.add(tool_id)
    return merged_ids


def _build_tool_server_openapi_url(request, tool_id: str) -> Optional[str]:
    server_id = _extract_tool_server_id(tool_id)
    if not server_id:
        return None

    server_meta = _load_server_metadata(server_id)
    expected_connection = (
        _build_openapi_tool_server_connection(server_id)
        if server_meta.get("exists")
        else None
    )
    if server_meta.get("deployment_type") == "host" and expected_connection:
        base_url = (expected_connection.get("url") or "").rstrip("/")
        openapi_path = expected_connection.get("path", "openapi.json") or "openapi.json"
        if base_url and openapi_path:
            return f"{base_url}/{openapi_path.lstrip('/')}"
        if base_url:
            return base_url

    server_connections = request.app.state.config.TOOL_SERVER_CONNECTIONS or []
    if hasattr(server_connections, "value"):
        server_connections = server_connections.value

    for server_connection in server_connections:
        info = server_connection.get("info", {}) or {}
        if info.get("id") != server_id:
            continue

        base_url = (server_connection.get("url") or "").rstrip("/")
        openapi_path = server_connection.get("path", "openapi.json") or "openapi.json"

        if base_url and openapi_path:
            return f"{base_url}/{openapi_path.lstrip('/')}"
        if base_url:
            return base_url

    return f"{_proxy_base_url_for_server_id(server_id)}/{server_id}/openapi.json"


def _build_tool_server_status_url(request, tool_id: str) -> Optional[str]:
    server_id = _extract_tool_server_id(tool_id)
    if not server_id:
        return None

    server_meta = _load_server_metadata(server_id)
    if server_meta.get("deployment_type") == "host":
        return None

    server_connections = request.app.state.config.TOOL_SERVER_CONNECTIONS or []
    if hasattr(server_connections, "value"):
        server_connections = server_connections.value

    for server_connection in server_connections:
        info = server_connection.get("info", {}) or {}
        if info.get("id") != server_id:
            continue

        base_url = (server_connection.get("url") or "").rstrip("/")
        if "mcpo-core" in base_url:
            return f"{MCPO_CORE_PROXY_BASE_URL}/servers/{server_id}/status"
        if "mcpo" in base_url:
            return f"{MCPO_REGULAR_PROXY_BASE_URL}/servers/{server_id}/status"
        return None

    return f"{_proxy_base_url_for_server_metadata(server_meta)}/servers/{server_id}/status"


def _fetch_json_sync(url: str, timeout_seconds: float) -> Optional[dict]:
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            if response.status != 200:
                return None
            return json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError):
        return None
    except Exception:
        return None


def _fetch_openapi_spec_sync(url: str, timeout_seconds: float) -> Optional[dict]:
    return _fetch_json_sync(url, timeout_seconds)


def _openapi_has_callable_tool_paths(spec: Optional[dict]) -> bool:
    if not isinstance(spec, dict):
        return False

    paths = spec.get("paths", {})
    if not isinstance(paths, dict):
        return False

    for path in paths.keys():
        if isinstance(path, str) and "oauth" not in path.lower():
            return True

    return False


def _server_status_is_tool_ready(status: Optional[dict]) -> bool:
    if not isinstance(status, dict):
        return False

    if status.get("readiness_phase") == "tool_ready":
        return True

    return bool(status.get("healthy")) and int(status.get("tools_count", 0) or 0) > 0


def _build_dynamic_tool_starting_system_message(tool_ids: list[str]) -> str:
    tool_labels = ", ".join(
        f"server:{_extract_tool_server_id(tool_id)}" for tool_id in tool_ids
    )
    return (
        "<integration_starting>\n"
        "The following integrations were enabled for this chat, but their tool "
        f"specs are still starting and are not callable in this response: {tool_labels}.\n"
        "Do not call these tools in this response. If the user needs them now, "
        "explain that the integration is enabled but still starting and ask them "
        "to retry shortly.\n"
        "</integration_starting>"
    )


async def discover_pending_chat_tool_ids_from_redis(
    chat_id: str,
    existing_tool_ids: list,
) -> list[str]:
    """
    Check Redis for chat-specific tools and return tool IDs newly enabled mid-turn.
    """
    if not DYNAMIC_TOOLS_REDIS_AVAILABLE or not chat_id:
        return []

    try:
        # Quick Redis lookup with short timeout
        redis_client = RedisClient(
            host="redis",
            port=6379,
            db=0,
            decode_responses=True,
            socket_connect_timeout=1,
        )

        redis_key = f"chat_tools:{chat_id}"
        chat_tools_json = redis_client.get(redis_key)

        if not chat_tools_json:
            return []

        chat_tools = json.loads(chat_tools_json)
        new_tool_ids = [t for t in chat_tools if t not in existing_tool_ids]

        if not new_tool_ids:
            return []

        log.info(
            f"[DYNAMIC_TOOLS] Found {len(new_tool_ids)} NEW tools in Redis: {new_tool_ids}"
        )
        return new_tool_ids

    except Exception as e:
        log.warning(f"[DYNAMIC_TOOLS] Error reloading tools from Redis: {e}")
        return []


def _is_truthy_fragment_env(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return False


def _load_server_fragment_payload(server_id: str) -> Optional[dict]:
    normalized_id = _normalize_server_id(server_id)
    system_dir = MCP_CONFIGS_DIR / normalized_id
    base_dirs = (
        (MCP_CONFIGS_DIR,)
        if system_dir.is_dir()
        else (MCP_CONFIGS_USER_DIR,)
    )
    for base_dir in base_dirs:
        fragment_path = base_dir / normalized_id / f"{normalized_id}.fragment"
        if not fragment_path.is_file():
            continue
        try:
            with open(fragment_path, "r", encoding="utf-8") as handle:
                payload = json.load(handle) or {}
            return payload if isinstance(payload, dict) else None
        except Exception as e:
            log.warning(
                "[TOOLS] Failed to load fragment for %s from %s: %s",
                normalized_id,
                fragment_path,
                e,
            )
            return None
    return None


def _server_uses_external_oauth21(server_id: str) -> bool:
    fragment = _load_server_fragment_payload(server_id)
    if not isinstance(fragment, dict):
        return False

    env = fragment.get("env") or {}
    if not isinstance(env, dict):
        return False

    return _is_truthy_fragment_env(
        env.get("MCP_ENABLE_OAUTH21")
    ) and _is_truthy_fragment_env(env.get("EXTERNAL_OAUTH21_PROVIDER"))


def _build_openapi_tool_server_connection(server_id: str) -> Optional[dict]:
    normalized_id = _normalize_server_id(server_id)
    server_meta = _load_server_metadata(normalized_id)
    if not server_meta.get("exists"):
        return None

    display_name = server_meta.get("display_name") or normalized_id.replace(
        "-", " "
    ).replace("_", " ").title()
    description = server_meta.get("description", "")
    auth_type = (
        "oauth_2.1" if _server_uses_external_oauth21(normalized_id) else "bearer"
    )
    proxy_base_url = _proxy_base_url_for_server_metadata(server_meta)

    return {
        "url": f"{proxy_base_url}/{normalized_id}",
        "path": "openapi.json",
        "type": "openapi",
        "auth_type": auth_type,
        "headers": None,
        "key": "",
        "config": {"enable": True, "access_control": None},
        "info": {
            "id": normalized_id,
            "name": display_name,
            "description": description,
        },
    }


async def _invalidate_tool_servers_cache(request) -> None:
    app_state = getattr(getattr(request, "app", None), "state", None)
    if app_state is not None:
        try:
            app_state.TOOL_SERVERS = []
        except Exception:
            pass

    redis_client = getattr(app_state, "redis", None)
    if redis_client is None:
        return

    try:
        result = redis_client.delete("tool_servers")
        if inspect.isawaitable(result):
            await result
    except Exception as e:
        log.debug("[TOOLS] Could not invalidate tool_servers cache: %s", e)


async def _ensure_tool_server_connections_for_tool_ids(
    request,
    tool_ids: list[str],
    chat_id: Optional[str] = None,
    invalidate_cache: bool = True,
) -> list[str]:
    normalized_tool_ids = _coerce_tool_ids(tool_ids)
    if not normalized_tool_ids:
        return []

    current_connections = request.app.state.config.TOOL_SERVER_CONNECTIONS or []
    if hasattr(current_connections, "value"):
        current_connections = list(current_connections.value)
    else:
        current_connections = list(current_connections)

    existing_indices: dict[str, int] = {}
    for idx, connection in enumerate(current_connections):
        if not isinstance(connection, dict):
            continue
        server_id = _normalize_server_id(
            str((connection.get("info") or {}).get("id") or "").strip()
        )
        if server_id and server_id not in existing_indices:
            existing_indices[server_id] = idx

    added_server_ids: list[str] = []
    added_connection_urls: list[str] = []
    repaired_server_ids: list[str] = []

    for tool_id in normalized_tool_ids:
        if not isinstance(tool_id, str) or not tool_id.startswith("server:"):
            continue
        if tool_id.startswith("server:mcp:"):
            continue

        server_id = _extract_tool_server_id(tool_id)
        if not server_id:
            continue

        connection = _build_openapi_tool_server_connection(server_id)
        if not connection:
            continue

        existing_idx = existing_indices.get(server_id)
        if existing_idx is not None:
            existing_connection = current_connections[existing_idx]
            old_url = str(existing_connection.get("url") or "").rstrip("/")
            new_url = str(connection.get("url") or "").rstrip("/")
            old_path = str(
                existing_connection.get("path", "openapi.json") or "openapi.json"
            ).lstrip("/")
            new_path = str(
                connection.get("path", "openapi.json") or "openapi.json"
            ).lstrip("/")
            server_meta = _load_server_metadata(server_id)
            if server_meta.get("deployment_type") == "host" and (
                old_url != new_url or old_path != new_path
            ):
                current_connections[existing_idx] = connection
                repaired_server_ids.append(server_id)
                log.info(
                    "[TOOLS] Repaired stale host tool server connection chat_id=%s server_id=%s old_url=%s new_url=%s reason=host_deployment_route_mismatch",
                    chat_id,
                    server_id,
                    old_url,
                    new_url,
                )
            continue

        current_connections.append(connection)
        existing_indices[server_id] = len(current_connections) - 1
        added_server_ids.append(server_id)
        added_connection_urls.append(f"{server_id}={connection.get('url')}")

    if added_server_ids or repaired_server_ids:
        request.app.state.config.TOOL_SERVER_CONNECTIONS = current_connections
        if invalidate_cache:
            await _invalidate_tool_servers_cache(request)

    if added_server_ids:
        log.info(
            "[TOOLS] Registered missing tool server connections for current request: %s",
            added_connection_urls or added_server_ids,
        )

    return added_server_ids + repaired_server_ids


async def _merge_chat_attached_tool_ids_for_request(
    request,
    chat_id: Optional[str],
    existing_tool_ids: Any,
) -> list[str]:
    merged_tool_ids = _coerce_tool_ids(existing_tool_ids)
    if not chat_id:
        return merged_tool_ids

    redis_tool_ids = await load_pending_chat_tool_ids_from_redis(request, chat_id)
    next_tool_ids = _merge_tool_ids(merged_tool_ids, redis_tool_ids)

    if next_tool_ids != merged_tool_ids:
        log.info(
            "[TOOLS] Backfilled chat-attached tool ids for foreground request chat_id=%s existing=%s attached=%s merged=%s",
            chat_id,
            merged_tool_ids,
            redis_tool_ids,
            next_tool_ids,
        )

    return next_tool_ids


def _tool_server_connections_list(request) -> list[dict[str, Any]]:
    connections = request.app.state.config.TOOL_SERVER_CONNECTIONS or []
    if hasattr(connections, "value"):
        return list(connections.value)
    return list(connections)


def _load_mcp_toggles_for_prompt_path() -> dict[str, Any]:
    try:
        with open("/app/mcp_toggles.json", "r") as toggles_file:
            toggles = json.load(toggles_file)
        return toggles if isinstance(toggles, dict) else {}
    except Exception:
        return {}


def _filter_cached_tool_servers_by_toggle(
    tool_servers: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    toggles = _load_mcp_toggles_for_prompt_path()
    if not toggles:
        return tool_servers
    return [
        server
        for server in tool_servers
        if isinstance(server, dict) and toggles.get(server.get("id"), True)
    ]


async def _get_cached_tool_servers_for_prompt_path(request) -> list[dict[str, Any]]:
    """Read cached OpenAPI tool specs without refreshing MCPO/OpenAPI."""
    tool_servers: list[dict[str, Any]] = []
    app_state = getattr(getattr(request, "app", None), "state", None)

    in_memory_tool_servers = getattr(app_state, "TOOL_SERVERS", None)
    if isinstance(in_memory_tool_servers, list) and in_memory_tool_servers:
        tool_servers = [
            server for server in in_memory_tool_servers if isinstance(server, dict)
        ]

    redis_client = getattr(app_state, "redis", None)
    if not tool_servers and redis_client is not None:
        try:
            cached_tool_servers = redis_client.get("tool_servers")
            if inspect.isawaitable(cached_tool_servers):
                cached_tool_servers = await cached_tool_servers
            if cached_tool_servers:
                parsed = json.loads(cached_tool_servers)
                if isinstance(parsed, list):
                    tool_servers = [
                        server for server in parsed if isinstance(server, dict)
                    ]
                    try:
                        app_state.TOOL_SERVERS = tool_servers
                    except Exception:
                        pass
        except Exception as e:
            log.debug("[DYNAMIC_TOOLS] Failed reading cached tool_servers: %s", e)

    return _filter_cached_tool_servers_by_toggle(tool_servers)


def _connection_index_by_server_id(
    connections: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    index: dict[str, dict[str, Any]] = {}
    for connection in connections or []:
        if not isinstance(connection, dict):
            continue
        server_id = _normalize_server_id(
            str((connection.get("info") or {}).get("id") or "").strip()
        )
        if server_id:
            index[server_id] = connection
    return index


def _openapi_tool_headers_and_cookies(request, connection: dict, extra_params: dict):
    cookies = {}
    headers = {"Content-Type": "application/json"}
    auth_type = connection.get("auth_type", "bearer") if isinstance(connection, dict) else "bearer"

    if auth_type == "bearer":
        headers["Authorization"] = f"Bearer {connection.get('key', '')}"
    elif auth_type == "session":
        cookies = getattr(request, "cookies", {}) or {}
        token = getattr(getattr(request, "state", None), "token", None)
        credentials = getattr(token, "credentials", None)
        if credentials:
            headers["Authorization"] = f"Bearer {credentials}"
    elif auth_type == "system_oauth":
        cookies = getattr(request, "cookies", {}) or {}
        oauth_token = (extra_params or {}).get("__oauth_token__", None)
        if oauth_token:
            headers["Authorization"] = f"Bearer {oauth_token.get('access_token', '')}"

    connection_headers = connection.get("headers", None) if isinstance(connection, dict) else None
    if connection_headers and isinstance(connection_headers, dict):
        headers.update(connection_headers)

    return headers, cookies


async def load_cached_tool_specs_for_ids(
    request,
    tool_ids: list[str],
    user,
    extra_params: dict,
    model: dict,
    form_data: dict,
    metadata: dict,
) -> tuple[dict, list[str], list[dict], list[str]]:
    """Load OpenAPI tool specs from cached tool_servers only.

    This intentionally does not call get_tool_servers(), set_tool_servers(),
    readiness/status URLs, or OpenAPI endpoints. Health-check/control-plane
    refresh owns cache population; prompt processing fails open and proceeds.
    """
    del user, model, form_data

    cached_tool_servers = await _get_cached_tool_servers_for_prompt_path(request)
    server_index = {
        _normalize_server_id(str(server.get("id") or "").strip()): server
        for server in cached_tool_servers
        if isinstance(server, dict) and server.get("id")
    }
    connections = _tool_server_connections_list(request)
    connection_index = _connection_index_by_server_id(connections)

    loaded_tools_dict: dict[str, Any] = {}
    loaded_tool_ids: list[str] = []
    loaded_tool_specs: list[dict] = []
    failed_tool_ids: list[str] = []

    for tool_id in _canonicalize_tool_ids_for_loading(tool_ids):
        if not isinstance(tool_id, str) or not tool_id.startswith("server:"):
            continue
        if tool_id.startswith("server:mcp:"):
            continue

        server_token = tool_id[len("server:") :]
        server_id_parts = server_token.split("|", 1)
        server_id = _normalize_server_id(server_id_parts[0])
        function_names = (
            [name for name in server_id_parts[1].split(",") if name]
            if len(server_id_parts) == 2
            else []
        )

        tool_server_data = server_index.get(server_id)
        if not isinstance(tool_server_data, dict):
            failed_tool_ids.append(tool_id)
            continue

        tool_server_connection = connection_index.get(server_id)
        if not isinstance(tool_server_connection, dict):
            tool_server_idx = tool_server_data.get("idx")
            if isinstance(tool_server_idx, int) and 0 <= tool_server_idx < len(connections):
                tool_server_connection = connections[tool_server_idx]
        if not isinstance(tool_server_connection, dict):
            tool_server_connection = _build_openapi_tool_server_connection(server_id) or {}

        specs = tool_server_data.get("specs", [])
        if not isinstance(specs, list) or not specs:
            failed_tool_ids.append(tool_id)
            continue

        function_name_filter_list = tool_server_connection.get("config", {}).get(
            "function_name_filter_list", ""
        )
        if isinstance(function_name_filter_list, str):
            function_name_filter_list = [
                item for item in function_name_filter_list.split(",") if item
            ]

        headers, cookies = _openapi_tool_headers_and_cookies(
            request,
            tool_server_connection,
            extra_params or {},
        )

        server_loaded_count = 0
        for spec in specs:
            if not isinstance(spec, dict):
                continue
            original_function_name = spec.get("name")
            if not original_function_name:
                continue
            if function_names and original_function_name not in function_names:
                continue
            if function_name_filter_list and not is_string_allowed(
                original_function_name,
                function_name_filter_list,
            ):
                continue

            function_name = original_function_name
            spec_for_payload = dict(spec)
            while function_name in loaded_tools_dict:
                function_name = f"{server_id}_{function_name}"
                spec_for_payload = {**spec_for_payload, "name": function_name}

            def make_tool_function(
                function_name_for_call,
                server_data,
                request_headers,
                request_cookies,
            ):
                async def tool_function(**kwargs):
                    return await execute_tool_server(
                        url=server_data["url"],
                        headers=request_headers,
                        cookies=request_cookies,
                        name=function_name_for_call,
                        params=kwargs,
                        server_data=server_data,
                    )

                return get_async_tool_function_and_apply_extra_params(
                    tool_function,
                    {},
                )

            loaded_tools_dict[function_name] = {
                "tool_id": tool_id,
                "callable": make_tool_function(
                    original_function_name,
                    tool_server_data,
                    headers,
                    cookies,
                ),
                "spec": spec_for_payload,
                "type": "external",
                "server_id": server_id,
                "server_operation_name": original_function_name,
                "tool_server_data": tool_server_data,
                "tool_server_connection": tool_server_connection,
            }
            loaded_tool_specs.append({"type": "function", "function": spec_for_payload})
            server_loaded_count += 1

        if server_loaded_count:
            loaded_tool_ids.append(tool_id)
            log.info(
                "[DYNAMIC_TOOLS] Loaded %d cached tool functions for %s",
                server_loaded_count,
                tool_id,
            )
        else:
            failed_tool_ids.append(tool_id)

    return loaded_tools_dict, loaded_tool_ids, loaded_tool_specs, failed_tool_ids


async def _probe_tool_server_ready(request, tool_id: str) -> bool:
    status_url = _build_tool_server_status_url(request, tool_id)
    if status_url:
        status = await asyncio.to_thread(
            _fetch_json_sync,
            status_url,
            _DYNAMIC_TOOL_OPENAPI_TIMEOUT_SECONDS,
        )
        return _server_status_is_tool_ready(status)

    # Host-deployed servers do not sit behind the shared aggregator.
    openapi_url = _build_tool_server_openapi_url(request, tool_id)
    if not openapi_url:
        return False

    spec = await asyncio.to_thread(
        _fetch_openapi_spec_sync,
        openapi_url,
        _DYNAMIC_TOOL_OPENAPI_TIMEOUT_SECONDS,
    )
    return _openapi_has_callable_tool_paths(spec)


async def wait_for_tool_servers_ready(
    request,
    tool_ids: list[str],
    timeout_seconds: float = _DYNAMIC_TOOL_READY_TIMEOUT_SECONDS,
    poll_interval_seconds: float = _DYNAMIC_TOOL_READY_POLL_INTERVAL_SECONDS,
) -> tuple[list[str], list[str]]:
    if not tool_ids:
        return [], []

    unresolved_ids = list(tool_ids)
    ready_ids = []
    deadline = time.monotonic() + timeout_seconds

    log.info(
        "[DYNAMIC_TOOLS] Waiting up to %.1fs for tool server readiness via aggregator status: %s",
        timeout_seconds,
        unresolved_ids,
    )

    while unresolved_ids and time.monotonic() < deadline:
        results = await asyncio.gather(
            *[_probe_tool_server_ready(request, tool_id) for tool_id in unresolved_ids],
            return_exceptions=True,
        )

        next_unresolved = []
        newly_ready = []

        for tool_id, result in zip(unresolved_ids, results):
            if isinstance(result, Exception):
                log.debug(
                    "[DYNAMIC_TOOLS] Readiness probe failed for %s: %s",
                    tool_id,
                    result,
                )
                next_unresolved.append(tool_id)
                continue

            if result:
                newly_ready.append(tool_id)
            else:
                next_unresolved.append(tool_id)

        if newly_ready:
            ready_ids.extend(newly_ready)
            log.info(
                "[DYNAMIC_TOOLS] Tool-ready for %s",
                newly_ready,
            )

        unresolved_ids = next_unresolved
        if unresolved_ids and time.monotonic() < deadline:
            await asyncio.sleep(poll_interval_seconds)

    return ready_ids, unresolved_ids


async def load_tool_specs_for_ids(
    request,
    tool_ids: list[str],
    user,
    extra_params: dict,
    model: dict,
    form_data: dict,
    metadata: dict,
) -> tuple[dict, list[str], list[dict], list[str]]:
    loaded_tools_dict = {}
    loaded_tool_ids = []
    loaded_tool_specs = []
    failed_tool_ids = []

    for tool_id in tool_ids:
        try:
            tool_dict = await get_tools(
                request,
                [tool_id],
                user,
                {
                    **extra_params,
                    "__model__": model,
                    "__messages__": form_data.get("messages", []),
                    "__files__": metadata.get("files", []),
                },
            )

            if not tool_dict:
                failed_tool_ids.append(tool_id)
                log.warning(
                    "[DYNAMIC_TOOLS] No tool specs returned for %s after readiness check",
                    tool_id,
                )
                continue

            loaded_tools_dict.update(tool_dict)
            loaded_tool_ids.append(tool_id)
            loaded_tool_specs.extend(
                [
                    {"type": "function", "function": tool.get("spec", {})}
                    for tool in tool_dict.values()
                ]
            )
            log.info(
                "[DYNAMIC_TOOLS] Loaded %d tool functions for %s: %s",
                len(tool_dict),
                tool_id,
                list(tool_dict.keys()),
            )
        except Exception as e:
            failed_tool_ids.append(tool_id)
            log.warning(
                "[DYNAMIC_TOOLS] Failed to load tool specs for %s: %s",
                tool_id,
                e,
            )

    return loaded_tools_dict, loaded_tool_ids, loaded_tool_specs, failed_tool_ids


async def _refresh_cached_tool_specs_for_ids(
    request,
    tool_ids: list[str],
    chat_id: Optional[str] = None,
    reason: str = "activation",
) -> list[str]:
    normalized_tool_ids = _coerce_tool_ids(tool_ids)
    if not normalized_tool_ids:
        return []

    refresh_helper = globals().get("refresh_tool_servers_for_ids")
    if refresh_helper is None:
        log.warning(
            "[DYNAMIC_TOOLS] Targeted tool-server refresh helper unavailable chat_id=%s requested_tool_ids=%s",
            chat_id,
            normalized_tool_ids,
        )
        return []

    toggles = _load_mcp_toggles_for_prompt_path()
    server_ids: list[str] = []
    for tool_id in normalized_tool_ids:
        if not isinstance(tool_id, str) or not tool_id.startswith("server:"):
            continue
        if tool_id.startswith("server:mcp:"):
            continue
        server_id = _extract_tool_server_id(tool_id)
        if not server_id:
            continue
        if toggles and not toggles.get(server_id, True):
            log.info(
                "[DYNAMIC_TOOLS] Skipping targeted tool refresh for disabled server chat_id=%s server_id=%s",
                chat_id,
                server_id,
            )
            continue
        if server_id not in server_ids:
            server_ids.append(server_id)

    if not server_ids:
        return []

    try:
        await _ensure_tool_server_connections_for_tool_ids(
            request=request,
            tool_ids=[f"server:{server_id}" for server_id in server_ids],
            chat_id=chat_id,
            invalidate_cache=False,
        )
    except Exception as e:
        log.warning(
            "[DYNAMIC_TOOLS] Could not prepare targeted tool-server connections chat_id=%s server_ids=%s error=%s",
            chat_id,
            server_ids,
            e,
        )
        return []

    started = time.monotonic()
    try:
        maybe_refreshed_tool_servers = refresh_helper(request, server_ids)
        if inspect.isawaitable(maybe_refreshed_tool_servers):
            refreshed_tool_servers = await maybe_refreshed_tool_servers
        else:
            refreshed_tool_servers = maybe_refreshed_tool_servers
    except Exception as e:
        log.warning(
            "[DYNAMIC_TOOLS] Targeted tool-server refresh failed chat_id=%s server_ids=%s reason=%s error=%s",
            chat_id,
            server_ids,
            reason,
            e,
        )
        return []

    refreshed_ids: set[str] = set()
    if isinstance(refreshed_tool_servers, list):
        for server in refreshed_tool_servers:
            if not isinstance(server, dict):
                continue
            server_id = _normalize_server_id(str(server.get("id") or "").strip())
            if server_id:
                refreshed_ids.add(server_id)

    elapsed_ms = int((time.monotonic() - started) * 1000)
    log.info(
        "[DYNAMIC_TOOLS] Targeted tool-server refresh complete chat_id=%s requested_server_ids=%s refreshed_server_ids=%s reason=%s elapsed_ms=%d",
        chat_id,
        server_ids,
        sorted(refreshed_ids),
        reason,
        elapsed_ms,
    )

    return [
        tool_id
        for tool_id in normalized_tool_ids
        if _extract_tool_server_id(tool_id) in refreshed_ids
    ]


async def _load_pending_tool_specs_after_inlet(
    request,
    pending_tool_ids: list[str],
    user,
    extra_params: dict,
    model: dict,
    form_data: dict,
    metadata: dict,
    allow_targeted_refresh: bool = False,
    targeted_refresh_tool_ids: Optional[list[str]] = None,
    refresh_reason: str = "activation_followup",
) -> tuple[dict, list[str], list[dict], list[str]]:
    if not pending_tool_ids:
        return {}, [], [], []

    pending_tool_ids = _canonicalize_tool_ids_for_loading(pending_tool_ids)
    current_connections_for_log = _tool_server_connections_list(request)
    requested_server_ids = {
        _extract_tool_server_id(tool_id)
        for tool_id in pending_tool_ids
        if isinstance(tool_id, str) and tool_id.startswith("server:")
    }
    resolved_connection_urls = []
    for connection in current_connections_for_log:
        if not isinstance(connection, dict):
            continue
        server_id = _normalize_server_id(
            str((connection.get("info") or {}).get("id") or "").strip()
        )
        if server_id in requested_server_ids:
            resolved_connection_urls.append(f"{server_id}={connection.get('url')}")
    log.info(
        "[DYNAMIC_TOOLS] Loading pending tool specs chat_id=%s message_id=%s request_phase=%s requested_tool_ids=%s resolved_connections=%s",
        metadata.get("chat_id"),
        metadata.get("message_id"),
        metadata.get("request_phase"),
        pending_tool_ids,
        resolved_connection_urls,
    )

    (
        loaded_tools,
        loaded_tool_ids,
        loaded_tool_specs,
        unresolved_tool_ids,
    ) = await load_cached_tool_specs_for_ids(
        request=request,
        tool_ids=pending_tool_ids,
        user=user,
        extra_params=extra_params,
        model=model,
        form_data=form_data,
        metadata=metadata,
    )

    if unresolved_tool_ids and allow_targeted_refresh:
        scoped_refresh_ids = _canonicalize_tool_ids_for_loading(
            targeted_refresh_tool_ids or unresolved_tool_ids
        )
        scoped_refresh_set = set(scoped_refresh_ids)
        refresh_candidates = [
            tool_id
            for tool_id in unresolved_tool_ids
            if not scoped_refresh_set or tool_id in scoped_refresh_set
        ]
        if refresh_candidates:
            refreshed_tool_ids = await _refresh_cached_tool_specs_for_ids(
                request=request,
                tool_ids=refresh_candidates,
                chat_id=metadata.get("chat_id"),
                reason=refresh_reason,
            )
            if refreshed_tool_ids:
                (
                    retry_loaded_tools,
                    retry_loaded_tool_ids,
                    retry_loaded_tool_specs,
                    retry_unresolved_tool_ids,
                ) = await load_cached_tool_specs_for_ids(
                    request=request,
                    tool_ids=refresh_candidates,
                    user=user,
                    extra_params=extra_params,
                    model=model,
                    form_data=form_data,
                    metadata=metadata,
                )
                if retry_loaded_tools:
                    loaded_tools.update(retry_loaded_tools)
                loaded_tool_ids = _merge_tool_ids(
                    loaded_tool_ids,
                    retry_loaded_tool_ids,
                )
                loaded_tool_specs.extend(retry_loaded_tool_specs)

                retry_loaded_set = set(retry_loaded_tool_ids)
                retry_unresolved_set = set(retry_unresolved_tool_ids)
                unresolved_tool_ids = [
                    tool_id
                    for tool_id in unresolved_tool_ids
                    if tool_id not in retry_loaded_set
                    and (
                        tool_id not in refresh_candidates
                        or tool_id in retry_unresolved_set
                    )
                ]

    tool_servers = await _get_cached_tool_servers_for_prompt_path(request)
    current_connections_for_log = _tool_server_connections_list(request)
    loaded_tools = _enrich_loaded_external_tools_with_runtime_metadata(
        loaded_tools,
        tool_servers=tool_servers,
        tool_server_connections=current_connections_for_log,
    )

    return loaded_tools, loaded_tool_ids, loaded_tool_specs, unresolved_tool_ids


def _enrich_loaded_external_tools_with_runtime_metadata(
    loaded_tools: dict[str, Any] | None,
    *,
    tool_servers: list[dict[str, Any]] | None,
    tool_server_connections: list[dict[str, Any]] | None,
) -> dict[str, Any]:
    if not isinstance(loaded_tools, dict) or not loaded_tools:
        return {}

    server_index: dict[str, dict[str, Any]] = {}
    for server in tool_servers or []:
        if not isinstance(server, dict):
            continue
        server_id = _normalize_server_id(str(server.get("id") or "").strip())
        if server_id:
            server_index[server_id] = server

    connection_index: dict[str, dict[str, Any]] = {}
    for connection in tool_server_connections or []:
        if not isinstance(connection, dict):
            continue
        info = connection.get("info")
        if not isinstance(info, dict):
            continue
        server_id = _normalize_server_id(str(info.get("id") or "").strip())
        if server_id:
            connection_index[server_id] = connection

    enriched_tools: dict[str, Any] = {}
    for tool_name, tool in loaded_tools.items():
        if not isinstance(tool, dict) or tool.get("type") != "external":
            enriched_tools[tool_name] = tool
            continue

        server_id = _resolve_tool_server_id(tool)
        if not server_id:
            tool_id = tool.get("tool_id")
            if (
                isinstance(tool_id, str)
                and tool_id.startswith("server:")
                and not tool_id.startswith("server:mcp:")
            ):
                server_id = _extract_tool_server_id(tool_id)

        if not server_id:
            enriched_tools[tool_name] = tool
            continue

        enriched_tool = dict(tool)
        enriched_tool["server_id"] = server_id

        tool_server_data = enriched_tool.get("tool_server_data")
        if not isinstance(tool_server_data, dict):
            tool_server_data = server_index.get(server_id)
            if not isinstance(tool_server_data, dict):
                server_meta = _load_server_metadata(server_id)
                proxy_base = _proxy_base_url_for_server_metadata(server_meta)
                tool_server_data = {
                    "id": server_id,
                    "url": f"{proxy_base}/{server_id}",
                }
            enriched_tool["tool_server_data"] = tool_server_data

        tool_server_connection = enriched_tool.get("tool_server_connection")
        if not isinstance(tool_server_connection, dict):
            tool_server_connection = connection_index.get(server_id)
            if not isinstance(tool_server_connection, dict):
                tool_server_connection = _build_openapi_tool_server_connection(server_id)
            if isinstance(tool_server_connection, dict):
                enriched_tool["tool_server_connection"] = tool_server_connection

        spec = enriched_tool.get("spec")
        if not enriched_tool.get("server_operation_name") and isinstance(spec, dict):
            spec_name = spec.get("name")
            if isinstance(spec_name, str) and spec_name.strip():
                enriched_tool["server_operation_name"] = spec_name

        enriched_tools[tool_name] = enriched_tool

    return enriched_tools


def _inject_loaded_tool_specs_into_request(
    form_data: dict,
    metadata: dict,
    existing_tool_ids: list[str],
    loaded_tools: dict,
    loaded_tool_ids: list[str],
    loaded_tool_specs: list[dict],
    *,
    request_phase: str,
) -> dict:
    if not loaded_tools:
        return {}

    filtered_loaded_tools, removed_subagent_tools = _filter_subagent_locked_tool_registry(
        loaded_tools,
        lock_integrations=bool(metadata.get("__subagent_scope_locked")),
    )
    if removed_subagent_tools:
        log.info(
            "[DYNAMIC_TOOLS] Filtered delegated-subagent-locked tools during follow-up injection: %s",
            removed_subagent_tools,
        )

    if not filtered_loaded_tools:
        return {}

    log.info(
        "[DYNAMIC_TOOLS] Injecting loaded tool specs request_phase=%s chat_id=%s message_id=%s tool_ids=%s tool_names=%s existing_payload_count=%d",
        request_phase,
        metadata.get("chat_id"),
        metadata.get("message_id"),
        loaded_tool_ids,
        list(filtered_loaded_tools.keys()),
        len(form_data.get("tools") or []),
    )

    tools = metadata.get("tools", {})
    if not isinstance(tools, dict):
        tools = {}
    tools.update(filtered_loaded_tools)
    metadata["tools"] = tools

    metadata["tool_ids"] = _merge_tool_ids(existing_tool_ids, loaded_tool_ids)
    form_data["metadata"] = metadata

    filtered_tool_spec_names = set(filtered_loaded_tools.keys())
    existing_payloads = (
        list(form_data.get("tools")) if isinstance(form_data.get("tools"), list) else []
    )
    existing_payload_names = {
        (payload.get("function", {}) or {}).get("name")
        for payload in existing_payloads
        if isinstance(payload, dict)
    }
    merged_payloads = list(existing_payloads)
    for spec in loaded_tool_specs:
        if not isinstance(spec, dict):
            continue
        spec_name = (spec.get("function", {}) or {}).get("name")
        if spec_name not in filtered_tool_spec_names or spec_name in existing_payload_names:
            continue
        merged_payloads.append(spec)
        existing_payload_names.add(spec_name)

    form_data["tools"] = merged_payloads

    if _is_openai_prompt_cache_tool_model(form_data.get("model")):
        form_data["tools"] = _normalize_openai_function_tools_payloads(
            form_data.get("tools", []),
            chat_id=metadata.get("chat_id"),
        )

    payload = form_data.get("payload")
    if isinstance(payload, dict):
        payload["tools"] = form_data.get("tools", [])

    log.info(
        "[DYNAMIC_TOOLS] Injected loaded tool specs request_phase=%s chat_id=%s message_id=%s payload_count=%d registry_count=%d",
        request_phase,
        metadata.get("chat_id"),
        metadata.get("message_id"),
        len(form_data.get("tools") or []),
        len(metadata.get("tools") or {}),
    )

    return filtered_loaded_tools


def _inject_loaded_tool_specs_into_followup_request(
    new_form_data: dict,
    metadata: dict,
    existing_tool_ids: list[str],
    loaded_tools: dict,
    loaded_tool_ids: list[str],
    loaded_tool_specs: list[dict],
) -> None:
    _inject_loaded_tool_specs_into_request(
        form_data=new_form_data,
        metadata=metadata,
        existing_tool_ids=existing_tool_ids,
        loaded_tools=loaded_tools,
        loaded_tool_ids=loaded_tool_ids,
        loaded_tool_specs=loaded_tool_specs,
        request_phase="tool_followup",
    )


def _missing_tool_ids_from_registry(
    desired_tool_ids: list[str],
    metadata_tools: Any,
) -> list[str]:
    normalized_tool_ids = _coerce_tool_ids(desired_tool_ids)
    if not normalized_tool_ids:
        return []

    registry_server_ids: set[str] = set()
    if isinstance(metadata_tools, dict):
        for tool in metadata_tools.values():
            server_id = _resolve_tool_server_id(tool)
            if server_id:
                registry_server_ids.add(f"server:{server_id}")

    missing_tool_ids: list[str] = []
    for tool_id in normalized_tool_ids:
        if not isinstance(tool_id, str) or not tool_id.startswith("server:"):
            continue
        if tool_id.startswith("server:mcp:"):
            continue
        if tool_id not in registry_server_ids:
            missing_tool_ids.append(tool_id)

    return missing_tool_ids


def _missing_followup_tool_ids_from_registry(
    desired_tool_ids: list[str],
    metadata_tools: Any,
) -> list[str]:
    return _missing_tool_ids_from_registry(desired_tool_ids, metadata_tools)


# PORTICO PATCH: Helper function to fetch MCP tools for dynamically added servers
# Used when skills activate new MCP servers mid-turn
async def fetch_mcp_tools_for_servers(
    request,
    tool_ids: list,
    user,
    extra_params: dict = None,
) -> tuple[dict, list]:
    """
    Fetch MCP tool specs for a list of server IDs.

    Args:
        request: FastAPI request object with app.state.config
        tool_ids: List of tool IDs (e.g., ["server:glean", "server:agent-vm"])
        user: User object for auth
        extra_params: Extra parameters (for OAuth tokens, etc.)

    Returns:
        Tuple of (mcp_tools_dict, tool_specs_list) where:
        - mcp_tools_dict: Dict mapping tool names to tool info (for execution)
        - tool_specs_list: List of tool specs in OpenAI format (for API)
    """
    from open_webui.utils.tools import is_string_allowed
    from open_webui.utils.mcp.client import MCPClient

    mcp_tools_dict = {}
    mcp_clients = {}
    extra_params = extra_params or {}

    for tool_id in tool_ids:
        # Only handle MCP server tools
        if not tool_id.startswith("server:"):
            continue

        # Extract server ID (handle both "server:foo" and "server:mcp:foo" formats)
        if tool_id.startswith("server:mcp:"):
            server_id = tool_id[len("server:mcp:") :]
        else:
            server_id = tool_id[len("server:") :]

        try:
            # Find the MCP server connection config
            mcp_server_connection = None
            for server_connection in request.app.state.config.TOOL_SERVER_CONNECTIONS:
                if (
                    server_connection.get("type", "") == "mcp"
                    and server_connection.get("info", {}).get("id") == server_id
                ):
                    mcp_server_connection = server_connection
                    break

            if not mcp_server_connection:
                log.debug(
                    f"[MCP_FETCH] MCP server with id {server_id} not found in TOOL_SERVER_CONNECTIONS"
                )
                continue

            headers = await build_mcp_request_headers(
                request=request,
                user=user,
                server_id=server_id,
                mcp_server_connection=mcp_server_connection,
                extra_params=extra_params,
                metadata=extra_params.get("__metadata__", {}),
            )

            # Connect to MCP server
            log.info(f"[MCP_FETCH] Connecting to MCP server: {server_id}")
            mcp_clients[server_id] = MCPClient()
            await mcp_clients[server_id].connect(
                url=mcp_server_connection.get("url", ""),
                headers=headers if headers else None,
            )

            # Get function name filter if configured
            function_name_filter_list = mcp_server_connection.get("config", {}).get(
                "function_name_filter_list", ""
            )
            if isinstance(function_name_filter_list, str):
                function_name_filter_list = (
                    function_name_filter_list.split(",")
                    if function_name_filter_list
                    else []
                )

            # Fetch tool specs
            tool_specs = await mcp_clients[server_id].list_tool_specs()
            log.info(f"[MCP_FETCH] Fetched {len(tool_specs)} tools from {server_id}")
            rename_mapping = _load_tool_rename_mapping(server_id)

            for tool_spec in tool_specs:
                # Create callable for tool execution
                def make_tool_function(function_name):
                    async def tool_function(
                        __metadata__=None, __request__=None, __oauth_token__=None, **kwargs
                    ):
                        runtime_extra_params = dict(extra_params or {})
                        if __oauth_token__ is not None:
                            runtime_extra_params["__oauth_token__"] = __oauth_token__

                        return await call_mcp_tool_with_runtime_headers(
                            client_factory=MCPClient,
                            request=__request__ or request,
                            user=user,
                            server_id=server_id,
                            mcp_server_connection=mcp_server_connection,
                            extra_params=runtime_extra_params,
                            metadata=__metadata__ or extra_params.get("__metadata__", {}),
                            function_name=function_name,
                            function_args=kwargs,
                        )

                    return get_async_tool_function_and_apply_extra_params(
                        tool_function,
                        {
                            "__metadata__": extra_params.get("__metadata__", {}),
                            "__request__": request,
                            "__oauth_token__": extra_params.get("__oauth_token__", None),
                        },
                    )

                # Apply filter if configured
                if function_name_filter_list:
                    if not is_string_allowed(
                        tool_spec["name"], function_name_filter_list
                    ):
                        continue

                original_name = tool_spec.get("name", "")
                renamed_name = _get_renamed_tool_name(rename_mapping, original_name)
                full_name = _sanitize_tool_name(f"{server_id}_{renamed_name}")
                if full_name in mcp_tools_dict and renamed_name != original_name:
                    log.warning(
                        f"[MCP_FETCH] Renamed tool collision for {server_id}: {full_name}"
                    )
                    renamed_name = original_name
                    full_name = _sanitize_tool_name(f"{server_id}_{original_name}")

                tool_function = make_tool_function(original_name)

                mcp_tools_dict[full_name] = {
                    "spec": {
                        **tool_spec,
                        "name": full_name,
                    },
                    "callable": tool_function,
                    "type": "mcp",
                    "client": mcp_clients[server_id],
                    "server_id": server_id,
                    "original_name": original_name,
                    "mcp_server_connection": mcp_server_connection,
                    "direct": False,
                }

        except Exception as e:
            log.error(
                f"[MCP_FETCH] Failed to fetch tools from MCP server {server_id}: {e}"
            )
            continue

    # Convert to OpenAI tool format
    tool_specs_list = [
        {"type": "function", "function": tool.get("spec", {})}
        for tool in mcp_tools_dict.values()
    ]

    log.info(
        f"[MCP_FETCH] Total: {len(tool_specs_list)} tools fetched from {len(mcp_clients)} servers"
    )
    return mcp_tools_dict, tool_specs_list


async def enrich_openapi_server_tools(request, tools_dict: dict) -> dict:
    if not tools_dict:
        return tools_dict

    server_index = {}
    for server in await _get_cached_tool_servers_for_prompt_path(request):
        server_id = server.get("id")
        if server_id:
            server_index[server_id] = server

    for tool in tools_dict.values():
        if tool.get("type") != "external":
            continue

        tool_id = tool.get("tool_id", "")
        if not isinstance(tool_id, str) or not tool_id.startswith("server:"):
            continue

        splits = tool_id.split(":")
        if len(splits) == 2:
            server_type = "openapi"
            server_id = splits[1]
        elif len(splits) == 3:
            server_type = splits[1]
            server_id = splits[2]
        else:
            continue

        server_id = server_id.split("|")[0]
        if server_type != "openapi":
            continue

        tool_server_data = server_index.get(server_id)
        if not tool_server_data:
            continue

        tool_server_idx = tool_server_data.get("idx", 0)
        tool_server_connection = request.app.state.config.TOOL_SERVER_CONNECTIONS[
            tool_server_idx
        ]

        tool["tool_server_data"] = tool_server_data
        tool["tool_server_connection"] = tool_server_connection
        tool["server_operation_name"] = tool.get("spec", {}).get("name")

    return tools_dict


_SKILL_ASSET_MARKDOWN_DATA_IMAGE_RE = re.compile(
    r"!\[[^\]]{0,200}\]\(data:image/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=_-]+\)"
)
_SKILL_ASSET_DATA_IMAGE_RE = re.compile(
    r"data:image/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=_-]+"
)


def _is_get_skill_assets_tool_name(tool_function_name: Any) -> bool:
    normalized = str(tool_function_name or "").strip().lower()
    return normalized in {"get_skill_asset", "get_skill_assets"} or normalized.endswith(
        ("_get_skill_asset", "_get_skill_assets")
    )


def _sanitize_skill_asset_tool_result_for_model(value):
    if isinstance(value, str):
        sanitized = _SKILL_ASSET_MARKDOWN_DATA_IMAGE_RE.sub(
            "[skill asset image rendered separately]", value
        )
        return _SKILL_ASSET_DATA_IMAGE_RE.sub(
            "[removed inline base64 image data]", sanitized
        )
    if isinstance(value, list):
        return [_sanitize_skill_asset_tool_result_for_model(item) for item in value]
    if isinstance(value, dict):
        return {
            key: _sanitize_skill_asset_tool_result_for_model(item)
            for key, item in value.items()
        }
    return value


def _is_displayable_image_tool_file(file):
    if isinstance(file, str):
        return file.startswith("data:image/")
    if not isinstance(file, dict):
        return False
    if file.get("type") == "image" and file.get("url"):
        return True
    if file.get("type") == "data" and str(file.get("content") or "").startswith(
        "data:image/"
    ):
        return True
    if str(file.get("content_type") or "").startswith("image/"):
        return True
    return False


def _inline_image_file_count(files) -> int:
    if not isinstance(files, list):
        return 0
    return sum(1 for file in files if _is_displayable_image_tool_file(file))


def _is_chrome_devtools_screenshot_tool(
    tool_function_name: Any, server_id: Any = None
) -> bool:
    normalized_tool = str(tool_function_name or "").strip().lower()
    normalized_server = (
        _normalize_server_id(server_id) if isinstance(server_id, str) else ""
    )
    return normalized_tool.endswith("take_screenshot") and (
        "chrome_devtools" in normalized_tool
        or "chrome-devtools" in normalized_tool
        or normalized_server == "chrome-devtools"
    )


def _parse_tool_result_for_enrichment(tool_result):
    if isinstance(tool_result, str):
        try:
            parsed = json.loads(tool_result)
        except Exception:
            return None
        if isinstance(parsed, (dict, list)):
            return parsed
        return None
    if isinstance(tool_result, (dict, list)):
        return copy.deepcopy(tool_result)
    return None


def _render_tool_result_enrichment(value) -> str:
    if isinstance(value, str):
        return _sanitize_skill_asset_tool_result_for_model(value)
    return json.dumps(
        _sanitize_skill_asset_tool_result_for_model(value),
        indent=2,
        ensure_ascii=False,
    )


def _build_tool_result_inline_image_metadata(
    *, tool_function_name: Any, server_id: Any = None, image_count: int
) -> dict[str, Any]:
    is_screenshot = _is_chrome_devtools_screenshot_tool(tool_function_name, server_id)
    message = (
        "The screenshot image is attached for inline display in the chat."
        if is_screenshot
        else "The image is attached for inline display in the chat."
    )
    return {
        "inline_image_attached": True,
        "inline_image_count": image_count,
        "message": message,
        "inline_image_message": message,
    }


def _extract_saved_screenshot_host_path(tool_result) -> str:
    text = tool_result if isinstance(tool_result, str) else ""
    if not text:
        return ""
    match = re.search(r"Saved screenshot to\s+(.+?)(?:\.?$|\n)", text)
    if not match:
        return ""
    return match.group(1).strip().rstrip(".")


def _enrich_chrome_screenshot_file_path_result(
    tool_result, *, tool_function_name, server_id=None
):
    if not _is_chrome_devtools_screenshot_tool(tool_function_name, server_id):
        return tool_result
    host_file_path = _extract_saved_screenshot_host_path(tool_result)
    if not host_file_path:
        return tool_result
    return {
        "result": _sanitize_skill_asset_tool_result_for_model(tool_result),
        "host_file_saved": True,
        "host_file_path": host_file_path,
        "inline_image_attached": False,
        "message": (
            "The screenshot was saved to a host-local file, but this tool result "
            "did not attach an inline chat image. For inline chat display, call "
            "chrome_devtools_take_screenshot with empty arguments."
        ),
    }


def _enrich_tool_result_for_inline_image_files(
    tool_result,
    files,
    *,
    tool_function_name: Any = "",
    server_id: Any = None,
):
    image_count = _inline_image_file_count(files)
    if image_count <= 0:
        return _enrich_chrome_screenshot_file_path_result(
            tool_result,
            tool_function_name=tool_function_name,
            server_id=server_id,
        )

    metadata = _build_tool_result_inline_image_metadata(
        tool_function_name=tool_function_name,
        server_id=server_id,
        image_count=image_count,
    )

    parsed = _parse_tool_result_for_enrichment(tool_result)
    if isinstance(parsed, dict):
        if (
            parsed.get("inline_image_attached") is True
            or parsed.get("inline_image_rendered") is True
        ):
            return _sanitize_skill_asset_tool_result_for_model(parsed)
        enriched = parsed
    elif isinstance(parsed, list):
        enriched = {"results": parsed}
    else:
        enriched = {"result": tool_result}

    enriched = _sanitize_skill_asset_tool_result_for_model(enriched)
    enriched["inline_image_attached"] = metadata["inline_image_attached"]
    enriched["inline_image_count"] = metadata["inline_image_count"]
    enriched["inline_image_message"] = metadata["inline_image_message"]
    enriched.setdefault("message", metadata["message"])
    return enriched


def _tool_name_for_call_id(tool_calls, tool_call_id: Any) -> str:
    if not isinstance(tool_calls, list):
        return ""
    for tool_call in tool_calls:
        if not isinstance(tool_call, dict):
            continue
        if tool_call.get("id") != tool_call_id:
            continue
        function = tool_call.get("function")
        if isinstance(function, dict):
            return str(function.get("name") or "")
    return ""


def _is_agent_vm_workspace_file_tool_name(
    tool_function_name: Any,
    short_name: str,
    *,
    server_id: Any = None,
) -> bool:
    target = str(short_name or "").strip().lower().replace("-", "_")
    if not target:
        return False
    normalized_tool = re.sub(
        r"[^a-z0-9]+",
        "_",
        str(tool_function_name or "").strip().lower(),
    ).strip("_")
    normalized_server = (
        _normalize_server_id(server_id) if isinstance(server_id, str) else ""
    )
    normalized_server = normalized_server.strip().lower()
    if normalized_tool in {target, f"agent_vm_{target}"}:
        return True
    return normalized_server == "agent-vm" and normalized_tool.endswith(f"_{target}")


def _tool_result_payload(tool_result: Any) -> Any:
    parsed = _parse_tool_result_for_enrichment(tool_result)
    return parsed if parsed is not None else tool_result


def _agent_vm_display_file_attachment(record: Any) -> Optional[dict[str, Any]]:
    if not isinstance(record, dict):
        return None
    url = (
        record.get("browser_url")
        or record.get("download_url")
        or record.get("url")
    )
    if not isinstance(url, str) or not url.strip():
        return None
    content_type = (
        record.get("mime_type")
        or record.get("content_type")
        or "application/octet-stream"
    )
    is_image = bool(record.get("is_image")) or str(content_type).startswith("image/")
    attachment = {
        "type": "image" if is_image else "file",
        "url": url.strip(),
        "name": record.get("file_name") or record.get("name") or url.rsplit("/", 1)[-1],
        "content_type": content_type,
    }
    if record.get("file_size") is not None:
        attachment["size"] = record.get("file_size")
    return attachment


def _iter_agent_vm_display_file_payloads(payload: Any):
    if isinstance(payload, dict):
        if (
            payload.get("success") is True
            and payload.get("display_files") is True
            and isinstance(payload.get("files"), list)
        ):
            yield payload
        results = payload.get("results")
        if isinstance(results, list):
            for item in results:
                yield from _iter_agent_vm_display_file_payloads(item)
    elif isinstance(payload, list):
        for item in payload:
            yield from _iter_agent_vm_display_file_payloads(item)


def _extract_agent_vm_display_file_attachments(
    *,
    tool_function_name: Any,
    server_id: Any = None,
    tool_result: Any,
) -> list[dict[str, Any]]:
    if not _is_agent_vm_workspace_file_tool_name(
        tool_function_name,
        "display_files",
        server_id=server_id,
    ):
        return []
    payload = _tool_result_payload(tool_result)
    attachments: list[dict[str, Any]] = []
    for display_payload in _iter_agent_vm_display_file_payloads(payload):
        for record in display_payload.get("files") or []:
            attachment = _agent_vm_display_file_attachment(record)
            if attachment:
                attachments.append(attachment)
    return attachments


def _display_files_tool_result_files_for_serialization(
    *,
    tool_function_name: Any,
    server_id: Any = None,
    tool_result: Any,
    fallback_files: Any = None,
) -> Any:
    per_call_files = _extract_agent_vm_display_file_attachments(
        tool_function_name=tool_function_name,
        server_id=server_id,
        tool_result=tool_result,
    )
    if per_call_files:
        return per_call_files
    return fallback_files


def _iter_agent_vm_request_image_payloads(payload: Any):
    if isinstance(payload, dict):
        if (
            payload.get("success") is True
            and payload.get("request_images") is True
            and isinstance(payload.get("images"), list)
        ):
            yield payload
        for key in ("content", "result"):
            if key in payload:
                yield from _iter_agent_vm_request_image_payloads(
                    _tool_result_payload(payload.get(key))
                )
        results = payload.get("results")
        if isinstance(results, list):
            for item in results:
                yield from _iter_agent_vm_request_image_payloads(item)
    elif isinstance(payload, list):
        for item in payload:
            if isinstance(item, dict) and item.get("type") == "text":
                yield from _iter_agent_vm_request_image_payloads(
                    _tool_result_payload(item.get("text"))
                )
            else:
                yield from _iter_agent_vm_request_image_payloads(item)


def _extract_agent_vm_request_image_urls_from_result(
    result: Any,
    *,
    tool_function_name: Any,
    server_id: Any = None,
) -> list[str]:
    if not _is_agent_vm_workspace_file_tool_name(
        tool_function_name,
        "request_images",
        server_id=server_id,
    ):
        return []
    payload = _tool_result_payload(result)
    urls: list[str] = []
    seen: set[str] = set()
    for request_payload in _iter_agent_vm_request_image_payloads(payload):
        for image in request_payload.get("images") or []:
            if not isinstance(image, dict):
                continue
            url = (
                image.get("model_image_url")
                or image.get("image_url")
                or image.get("download_url")
                or image.get("url")
            )
            if not isinstance(url, str) or not url.strip():
                continue
            url = url.strip()
            if url in seen:
                continue
            seen.add(url)
            urls.append(url)
    return urls


def _collect_agent_vm_request_image_urls(tool_calls: Any, results: Any) -> list[str]:
    if not isinstance(results, list):
        return []
    urls: list[str] = []
    seen: set[str] = set()
    for result in results:
        if not isinstance(result, dict):
            continue
        tool_name = _tool_name_for_call_id(tool_calls, result.get("tool_call_id"))
        for url in _extract_agent_vm_request_image_urls_from_result(
            result,
            tool_function_name=tool_name,
            server_id=result.get("server_id"),
        ):
            if url in seen:
                continue
            seen.add(url)
            urls.append(url)
    return urls


def _summarize_agent_vm_request_image_url_hosts(image_urls: Any) -> str:
    if not isinstance(image_urls, list):
        return ""
    counts: dict[str, int] = {}
    for url in image_urls:
        if not isinstance(url, str) or not url.strip():
            continue
        try:
            parsed = urllib.parse.urlparse(url.strip())
            host = parsed.netloc or "unknown"
        except Exception:
            host = "invalid"
        counts[host] = counts.get(host, 0) + 1
    return ",".join(f"{host}:{count}" for host, count in sorted(counts.items()))


def _format_agent_vm_request_images_conversion_error(error: Exception) -> str:
    return (
        "The requested workspace image could not be attached to the model for "
        "visual inspection. The image URL could not be fetched or converted "
        "before dispatch, so this turn was stopped instead of sending the model "
        "an incomplete visual context."
    )


def _sanitize_workspace_image_conversion_log_error(error: Exception) -> str:
    message = normalize_terminal_error_message(error)
    return re.sub(
        r"https?://[^/\s]+/workspace/[^\s,\)\]]+",
        "<workspace_image_url>",
        message,
    )


def _build_agent_vm_request_images_followup_message(
    image_urls: Any,
) -> Optional[dict[str, Any]]:
    if not isinstance(image_urls, list) or not image_urls:
        return None
    content: list[dict[str, Any]] = [
        {
            "type": "text",
            "text": "Workspace images requested for visual inspection.",
        }
    ]
    for url in image_urls:
        if not isinstance(url, str) or not url.strip():
            continue
        content.append({"type": "image_url", "image_url": {"url": url.strip()}})
    if len(content) == 1:
        return None
    return {"role": "user", "content": content}


def _model_supports_vision(model: Any) -> bool:
    """Missing capability metadata means vision is assumed supported; only an
    explicit vision=False (e.g. the PORTICO-156 gateway multimodal override in
    routers/openai.py) disables it."""
    if not isinstance(model, dict):
        return True
    info = model.get("info")
    if not isinstance(info, dict):
        return True
    meta = info.get("meta")
    if not isinstance(meta, dict):
        return True
    capabilities = meta.get("capabilities")
    if not isinstance(capabilities, dict):
        return True
    vision = capabilities.get("vision")
    if vision is None:
        return True
    return bool(vision)


def _build_agent_vm_request_images_unavailable_message(
    image_urls: Any,
) -> Optional[dict[str, Any]]:
    if not isinstance(image_urls, list):
        return None
    count = sum(1 for url in image_urls if isinstance(url, str) and url.strip())
    if count == 0:
        return None
    return {
        "role": "user",
        "content": [
            {
                "type": "text",
                "text": (
                    f"{count} workspace image(s) were requested for visual "
                    "inspection, but the selected model cannot accept image "
                    "input on this deployment (the LLM gateway rejects "
                    "multimodal content — PORTICO-156). Continue without image "
                    "pixels: inspect the files with code in the Agent VM "
                    "(e.g. Python) or rely on their paths and text output "
                    "instead."
                ),
            }
        ],
    }


def _tool_result_content_for_model_replay(
    result: dict, *, tool_function_name: Any = ""
) -> str:
    if not isinstance(result, dict):
        return ""
    content = result.get("content", "") or ""
    enriched = _enrich_tool_result_for_inline_image_files(
        content,
        result.get("files") or [],
        tool_function_name=tool_function_name,
        server_id=result.get("server_id"),
    )
    return _render_tool_result_enrichment(enriched)


def _workspace_image_url_belongs_to_chat(url: Any, chat_id: Any) -> bool:
    if not isinstance(url, str) or not url.strip() or not chat_id:
        return False
    normalized_chat_id = str(chat_id).strip()
    return (
        f"/workspace/{normalized_chat_id}/" in url
        or f"/workspace/{urllib.parse.quote(normalized_chat_id, safe='')}/" in url
    )


def _collect_workspace_inline_image_urls(value: Any, chat_id: str, inline: bool = False) -> set[str]:
    urls: set[str] = set()
    if isinstance(value, dict):
        inline_here = (
            inline
            or value.get("inline_image_included") is True
            or value.get("inline_image_attached") is True
            or value.get("inline_image_rendered") is True
        )
        download_url = value.get("download_url")
        if inline_here and _workspace_image_url_belongs_to_chat(download_url, chat_id):
            urls.add(download_url)
        for child in value.values():
            urls.update(_collect_workspace_inline_image_urls(child, chat_id, inline_here))
    elif isinstance(value, list):
        for child in value:
            urls.update(_collect_workspace_inline_image_urls(child, chat_id, inline))
    return urls


def _inline_tool_workspace_image_urls(content_blocks: Any, chat_id: Any) -> set[str]:
    if not isinstance(content_blocks, list) or not chat_id:
        return set()
    urls: set[str] = set()
    for block in content_blocks:
        if not isinstance(block, dict) or block.get("type") != "tool_calls":
            continue
        for result in block.get("results") or []:
            if not isinstance(result, dict):
                continue
            has_inline_file = _inline_image_file_count(result.get("files") or []) > 0
            parsed = _parse_tool_result_for_enrichment(result.get("content"))
            if parsed is not None:
                urls.update(
                    _collect_workspace_inline_image_urls(
                        parsed,
                        str(chat_id),
                        inline=has_inline_file,
                    )
                )
    return urls


def _strip_markdown_images_for_urls(text: str, urls: set[str]) -> str:
    if not urls or not isinstance(text, str) or "![" not in text:
        return text
    updated = text
    for url in urls:
        escaped_url = re.escape(url)
        standalone_pattern = re.compile(
            rf"(?m)^[ \t]*!\[[^\]]*\]\(\s*<?{escaped_url}>?(?:\s+[\"'][^\"']*[\"'])?\s*\)[ \t]*(?:\n|$)"
        )
        updated = standalone_pattern.sub("", updated)
        inline_pattern = re.compile(
            rf"!\[[^\]]*\]\(\s*<?{escaped_url}>?(?:\s+[\"'][^\"']*[\"'])?\s*\)"
        )
        updated = inline_pattern.sub("", updated)
    return re.sub(r"\n{3,}", "\n\n", updated)


def _dedupe_inline_tool_image_markdown(content_blocks: Any, chat_id: Any) -> bool:
    urls = _inline_tool_workspace_image_urls(content_blocks, chat_id)
    if not urls or not isinstance(content_blocks, list):
        return False
    changed = False
    for block in content_blocks:
        if not isinstance(block, dict) or block.get("type") != "text":
            continue
        content = block.get("content")
        stripped = _strip_markdown_images_for_urls(content, urls)
        if stripped != content:
            block["content"] = stripped
            changed = True
    return changed


def _tool_file_identity(file: Any) -> str:
    if isinstance(file, str):
        return f"string:{file}"
    if not isinstance(file, dict):
        return ""
    url = file.get("url")
    if isinstance(url, str) and url.strip():
        return f"url:{url.strip()}"
    content = file.get("content")
    if isinstance(content, str) and content.strip():
        return f"content:{content.strip()}"
    try:
        return f"json:{json.dumps(file, sort_keys=True, default=str)}"
    except Exception:
        return ""


def _merge_distinct_tool_files(
    existing_files,
    appended_files,
) -> list[Any]:
    merged: list[Any] = []
    seen: set[str] = set()
    for file in [*(existing_files or []), *(appended_files or [])]:
        identity = _tool_file_identity(file)
        if not identity or identity in seen:
            continue
        seen.add(identity)
        merged.append(copy.deepcopy(file))
    return merged


def _collect_content_block_tool_result_files(content_blocks: Any) -> list[Any]:
    if not isinstance(content_blocks, list):
        return []
    files: list[Any] = []
    for block in content_blocks:
        if not isinstance(block, dict) or block.get("type") != "tool_calls":
            continue
        results = block.get("results")
        if not isinstance(results, list):
            continue
        for result in results:
            if not isinstance(result, dict):
                continue
            result_files = result.get("files")
            if isinstance(result_files, list):
                files = _merge_distinct_tool_files(files, result_files)
    return files


async def process_tool_result(
    request,
    tool_function_name,
    tool_result,
    tool_type,
    direct_tool=False,
    metadata=None,
    user=None,
    server_id=None,
):
    overflow_metadata = dict(metadata or {})
    normalized_server_id = (
        _normalize_server_id(server_id) if isinstance(server_id, str) else ""
    )
    if normalized_server_id:
        overflow_metadata["server_id"] = normalized_server_id
        if "server_is_core" not in overflow_metadata:
            overflow_metadata["server_is_core"] = bool(
                _load_server_metadata(normalized_server_id).get("is_core", False)
            )

    tool_result_embeds = []

    if isinstance(tool_result, HTMLResponse):
        content_disposition = tool_result.headers.get("Content-Disposition", "")
        if "inline" in content_disposition:
            content = tool_result.body.decode("utf-8", "replace")
            tool_result_embeds.append(content)

            if 200 <= tool_result.status_code < 300:
                tool_result = {
                    "status": "success",
                    "code": "ui_component",
                    "message": f"{tool_function_name}: Embedded UI result is active and visible to the user.",
                }
            elif 400 <= tool_result.status_code < 500:
                tool_result = {
                    "status": "error",
                    "code": "ui_component",
                    "message": f"{tool_function_name}: Client error {tool_result.status_code} from embedded UI result.",
                }
            elif 500 <= tool_result.status_code < 600:
                tool_result = {
                    "status": "error",
                    "code": "ui_component",
                    "message": f"{tool_function_name}: Server error {tool_result.status_code} from embedded UI result.",
                }
            else:
                tool_result = {
                    "status": "error",
                    "code": "ui_component",
                    "message": f"{tool_function_name}: Unexpected status code {tool_result.status_code} from embedded UI result.",
                }
        else:
            tool_result = tool_result.body.decode("utf-8", "replace")

    elif (tool_type == "external" and isinstance(tool_result, tuple)) or (
        direct_tool and isinstance(tool_result, list) and len(tool_result) == 2
    ):
        tool_result, tool_response_headers = tool_result

        try:
            if not isinstance(tool_response_headers, dict):
                tool_response_headers = dict(tool_response_headers)
        except Exception as e:
            tool_response_headers = {}
            log.debug(e)

        if tool_response_headers and isinstance(tool_response_headers, dict):
            content_disposition = tool_response_headers.get(
                "Content-Disposition",
                tool_response_headers.get("content-disposition", ""),
            )

            if "inline" in content_disposition:
                content_type = tool_response_headers.get(
                    "Content-Type",
                    tool_response_headers.get("content-type", ""),
                )
                location = tool_response_headers.get(
                    "Location",
                    tool_response_headers.get("location", ""),
                )

                if "text/html" in content_type:
                    # Display as iframe embed
                    tool_result_embeds.append(tool_result)
                    tool_result = {
                        "status": "success",
                        "code": "ui_component",
                        "message": f"{tool_function_name}: Embedded UI result is active and visible to the user.",
                    }
                elif location:
                    tool_result_embeds.append(location)
                    tool_result = {
                        "status": "success",
                        "code": "ui_component",
                        "message": f"{tool_function_name}: Embedded UI result is active and visible to the user.",
                    }

    tool_result_files = []

    if isinstance(tool_result, list):
        if tool_type == "mcp":  # MCP
            tool_response = []
            for item in tool_result:
                if isinstance(item, dict):
                    if item.get("type") == "text":
                        text = item.get("text", "")
                        if isinstance(text, str):
                            try:
                                text = json.loads(text)
                            except json.JSONDecodeError:
                                pass
                        tool_response.append(text)
                    elif item.get("type") in ["image", "audio"]:
                        file_url = get_file_url_from_base64(
                            request,
                            f"data:{item.get('mimeType')};base64,{item.get('data', item.get('blob', ''))}",
                            {
                                "chat_id": overflow_metadata.get("chat_id", None),
                                "message_id": overflow_metadata.get("message_id", None),
                                "session_id": overflow_metadata.get("session_id", None),
                                "result": item,
                            },
                            user,
                        )

                        tool_result_files.append(
                            {
                                "type": item.get("type", "data"),
                                "url": file_url,
                            }
                        )
            tool_result = tool_response[0] if len(tool_response) == 1 else tool_response
            if _is_get_skill_assets_tool_name(tool_function_name):
                tool_result = _sanitize_skill_asset_tool_result_for_model(tool_result)
        else:  # OpenAPI
            for item in tool_result:
                if isinstance(item, str) and item.startswith("data:"):
                    tool_result_files.append(
                        {
                            "type": "data",
                            "content": item,
                        }
                    )
                    tool_result.remove(item)

    if isinstance(tool_result, list):
        tool_result = {"results": tool_result}

    display_file_attachments = _extract_agent_vm_display_file_attachments(
        tool_function_name=tool_function_name,
        server_id=normalized_server_id,
        tool_result=tool_result,
    )
    if display_file_attachments:
        tool_result_files = _merge_distinct_tool_files(
            tool_result_files,
            display_file_attachments,
        )

    tool_result = _enrich_tool_result_for_inline_image_files(
        tool_result,
        tool_result_files,
        tool_function_name=tool_function_name,
        server_id=normalized_server_id,
    )

    tool_result = await _maybe_spill_large_tool_result(
        request=request,
        tool_function_name=tool_function_name,
        tool_result=tool_result,
        metadata=overflow_metadata,
    )

    if isinstance(tool_result, dict) or isinstance(tool_result, list):
        tool_result = json.dumps(tool_result, indent=2, ensure_ascii=False)

    return tool_result, tool_result_files, tool_result_embeds


def _tool_result_overflow_max_chars() -> int:
    raw = os.getenv("OWUI_TOOL_RESULT_OVERFLOW_MAX_CHARS", "4000")
    try:
        return max(0, int(raw))
    except (TypeError, ValueError):
        return 4000


def _tool_result_overflow_enabled() -> bool:
    raw = os.getenv("OWUI_TOOL_RESULT_OVERFLOW_ENABLED", "true").strip().lower()
    return raw not in {"0", "false", "no", "off"}


def _tool_result_overflow_chunk_chars() -> int:
    raw = os.getenv("OWUI_TOOL_RESULT_OVERFLOW_CHUNK_CHARS", "32000")
    try:
        return max(1, int(raw))
    except (TypeError, ValueError):
        return 32000


def _tool_result_overflow_core_base_url() -> str:
    return os.getenv("CORE_MCP_PROXY_BASE_URL", "http://mcpo-core:8081").rstrip("/")


def _render_tool_result_for_overflow(tool_result):
    if isinstance(tool_result, str):
        return tool_result
    if isinstance(tool_result, (dict, list)):
        return json.dumps(tool_result, indent=2, ensure_ascii=False)
    return None


def _compact_tool_result_for_internal_replay(tool_result) -> str:
    rendered = _render_tool_result_for_overflow(tool_result)
    if not rendered:
        return ""

    max_chars = _tool_result_overflow_max_chars()
    if max_chars <= 0 or len(rendered) <= max_chars:
        return rendered

    compact_payload = {
        "truncated_tool_result": True,
        "char_count": len(rendered),
        "preview": rendered[:max_chars],
    }
    return json.dumps(compact_payload, ensure_ascii=False)


def _tool_result_overflow_exempt_servers() -> set[str]:
    raw = os.getenv("OWUI_TOOL_RESULT_OVERFLOW_EXEMPT_SERVERS", "web-tools")
    return {part.strip() for part in raw.split(",") if part.strip()}


def _tool_result_overflow_exempt_for_metadata(metadata: Optional[dict]) -> bool:
    if not isinstance(metadata, dict):
        return False

    raw_server_id = metadata.get("server_id")
    if not isinstance(raw_server_id, str):
        return False

    normalized_server_id = raw_server_id.strip()
    if normalized_server_id.startswith("server:"):
        normalized_server_id = normalized_server_id.split("server:", 1)[1]

    if not normalized_server_id:
        return False

    # Servers listed in OWUI_TOOL_RESULT_OVERFLOW_EXEMPT_SERVERS keep their
    # full tool results on follow-up replay (default: web-tools — truncating
    # search results to a preview mid-loop makes the model re-run searches).
    # Setting the env to an empty string restores the pre-flag behavior.
    if normalized_server_id in _tool_result_overflow_exempt_servers():
        return True

    return normalized_server_id != "web-tools" and (
        metadata.get("server_is_core") is True
    )


def _normalize_followup_tool_refresh_id(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    if text.startswith("server:"):
        return text
    return f"server:{text}"


def _extract_followup_tool_refresh_ids(
    response_tool_calls: list[dict[str, Any]] | None,
    results: list[dict[str, Any]] | None,
) -> tuple[list[str], bool]:
    if not isinstance(response_tool_calls, list) or not isinstance(results, list):
        return [], False

    tool_calls_by_id = {}
    for tool_call in response_tool_calls:
        if not isinstance(tool_call, dict):
            continue
        tool_call_id = str(tool_call.get("id") or "").strip()
        if tool_call_id:
            tool_calls_by_id[tool_call_id] = tool_call

    refresh_ids: list[str] = []
    tooling_state_changed = False

    for result in results:
        if not isinstance(result, dict):
            continue

        tool_call_id = str(result.get("tool_call_id") or "").strip()
        if not tool_call_id:
            continue

        tool_call = tool_calls_by_id.get(tool_call_id)
        if not isinstance(tool_call, dict):
            continue

        function = tool_call.get("function")
        if not isinstance(function, dict):
            function = {}
        tool_name = str(function.get("name") or "").strip()
        if not tool_name:
            continue

        arguments = {}
        raw_arguments = function.get("arguments")
        if isinstance(raw_arguments, str) and raw_arguments.strip():
            try:
                parsed_arguments = json.loads(raw_arguments)
            except Exception:
                parsed_arguments = None
            if isinstance(parsed_arguments, dict):
                arguments = parsed_arguments

        parsed_result = None
        raw_result_content = result.get("content")
        if isinstance(raw_result_content, str) and raw_result_content.strip():
            try:
                parsed_result = json.loads(raw_result_content)
            except Exception:
                parsed_result = None

        if tool_name in {
            "mcp_assistant_toggle_integration",
            "mcp_assistant_activate_integration",
            "mcp_assistant_authorize_integration",
            "mcp_assistant_deactivate_integration",
            "skills_activate_skill",
            "skills_deactivate_skill",
        }:
            tooling_state_changed = True

        # Only load server tool specs mid-turn once the server is actually
        # attached to the current chat. toggle_integration changes global
        # server state but does not attach the integration to the chat, so
        # exposing those tools in the next follow-up leaks unavailable tools.
        #
        # authorize_integration is similar unless the tool result explicitly
        # says it auto-activated the chat attachment (Rust path). In that case
        # we do want the next follow-up request to see the newly attached tools.
        if tool_name == "mcp_assistant_authorize_integration":
            if not (isinstance(parsed_result, dict) and parsed_result.get("auto_activated") is True):
                continue
            raw_server_id = ""
            if isinstance(parsed_result, dict):
                raw_server_id = str(parsed_result.get("server_id") or "").strip()
            if not raw_server_id:
                raw_server_id = str(arguments.get("server_id") or "").strip()
            normalized_tool_id = _normalize_followup_tool_refresh_id(raw_server_id)
            if normalized_tool_id:
                refresh_ids.append(normalized_tool_id)
        elif tool_name == "mcp_assistant_activate_integration":
            if isinstance(parsed_result, dict) and parsed_result.get("success") is False:
                continue
            raw_tool_ids = []
            if isinstance(parsed_result, dict):
                if isinstance(parsed_result.get("ready_tool_server_ids"), list):
                    raw_tool_ids = parsed_result["ready_tool_server_ids"]
                elif isinstance(parsed_result.get("newly_added"), list):
                    raw_tool_ids = parsed_result["newly_added"]
            if not raw_tool_ids and isinstance(arguments.get("tool_server_ids"), list):
                raw_tool_ids = arguments["tool_server_ids"]
            if not raw_tool_ids and arguments.get("server_id"):
                raw_tool_ids = [arguments.get("server_id")]
            for raw_tool_id in raw_tool_ids:
                normalized_tool_id = _normalize_followup_tool_refresh_id(raw_tool_id)
                if normalized_tool_id:
                    refresh_ids.append(normalized_tool_id)

    return list(dict.fromkeys(refresh_ids)), tooling_state_changed


def _detect_tool_result_overflow_format(rendered: str) -> str:
    try:
        json.loads(rendered)
        return "json"
    except Exception:
        return "txt"


def _tool_result_overflow_read_hint(format_hint: str) -> str:
    base_hint = (
        "This tool result was too large to inline. Do not dump the raw overflow file. "
        "Inspect it with grep_file for targeted term lookups, read_fragment for exact "
        "slices, or very small jq slices, keep any single inline extract under 2,000 "
        "chars, and if you need more detail write a reduced artifact to disk before "
        "reading it back."
    )
    if format_hint == "json":
        return f"{base_hint} For JSON inspection, bash with jq is available in Agent VM."
    return base_hint


def _tool_result_overflow_path(tool_function_name: str, rendered: str, format_hint: str) -> str:
    timestamp = time.strftime("%Y-%m-%dT%H-%M-%SZ", time.gmtime())
    safe_tool = re.sub(r"[^A-Za-z0-9._-]+", "-", tool_function_name or "tool").strip("-")
    safe_tool = safe_tool or "tool"
    digest = hashlib.md5(rendered.encode("utf-8")).hexdigest()[:8]
    return f"/work/.mcp-overflow/{timestamp}-{safe_tool}-{digest}.{format_hint}"


def _core_post_json_sync(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    url = f"{_tool_result_overflow_core_base_url()}{path}"
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        body = response.read().decode("utf-8")
    return json.loads(body)


async def _core_post_json(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    return await asyncio.to_thread(_core_post_json_sync, path, payload)


def _overflow_redis_client():
    if not DYNAMIC_TOOLS_REDIS_AVAILABLE:
        return None
    try:
        return RedisClient(
            host="redis",
            port=6379,
            db=0,
            decode_responses=True,
            socket_connect_timeout=1,
        )
    except Exception:
        return None


def _iter_agent_vm_info_keys(redis_client) -> list[str]:
    if redis_client is None:
        return []

    try:
        keys = list(redis_client.scan_iter(match="agent_vm_info:*"))
    except Exception:
        try:
            keys = list(redis_client.keys("agent_vm_info:*"))
        except Exception:
            return []

    normalized = []
    for key in keys:
        if isinstance(key, bytes):
            try:
                key = key.decode("utf-8")
            except Exception:
                continue
        if isinstance(key, str) and key:
            normalized.append(key)

    normalized.sort()
    return normalized


def _decode_agent_vm_info_payload(raw_value: Any) -> Optional[dict[str, Any]]:
    if isinstance(raw_value, bytes):
        try:
            raw_value = raw_value.decode("utf-8")
        except Exception:
            return None
    if not isinstance(raw_value, str) or not raw_value.strip():
        return None
    try:
        payload = json.loads(raw_value)
    except Exception:
        return None
    return payload if isinstance(payload, dict) else None


def _agent_vm_container_status_is_active(status: Any) -> bool:
    return isinstance(status, str) and status.strip().lower() in {
        "created",
        "restarting",
        "running",
        "paused",
    }


def _agent_vm_is_inactivity_expired(
    vm_info: Any, now_timestamp: Optional[float] = None
) -> bool:
    if not isinstance(vm_info, dict):
        return True
    try:
        last_activity = float(vm_info.get("last_activity"))
        timeout_hours = float(vm_info.get("timeout_hours"))
    except (TypeError, ValueError):
        return True
    if not timeout_hours > 0:
        return True
    now_timestamp = time.time() if now_timestamp is None else now_timestamp
    return max(0.0, now_timestamp - last_activity) > (timeout_hours * 3600.0)


def _open_agent_vm_docker_client():
    try:
        import docker

        return docker.from_env(timeout=5)
    except Exception:
        return None


def _inspect_agent_vm_container_status(vm_info: Any, docker_client) -> tuple[bool, Optional[str]]:
    if docker_client is None:
        return False, None
    if not isinstance(vm_info, dict):
        return True, None

    container_id = vm_info.get("container_id")
    if not isinstance(container_id, str) or not container_id.strip():
        return True, None

    try:
        container = docker_client.containers.get(container_id)
        try:
            container.reload()
        except Exception:
            pass
        status = getattr(container, "status", None)
        if not status and isinstance(getattr(container, "attrs", None), dict):
            status = (
                container.attrs.get("State", {}) or {}
            ).get("Status")
        if isinstance(status, str) and status.strip():
            return True, status.strip().lower()
        return True, None
    except Exception as exc:
        if exc.__class__.__name__ == "NotFound":
            return True, None
        log.warning(
            "[AgentVMKeepalive] Failed to inspect VM container vm_id=%s container_id=%s: %s",
            vm_info.get("vm_id"),
            container_id,
            exc,
        )
        return True, None


def _list_active_chat_agent_vms_sync(chat_id: str) -> list[dict[str, Any]]:
    if (
        not isinstance(chat_id, str)
        or not chat_id.strip()
        or chat_id.startswith("local:")
    ):
        return []

    redis_client = _overflow_redis_client()
    if redis_client is None:
        return []

    now_timestamp = time.time()
    docker_client = _open_agent_vm_docker_client()
    active_vms = []

    try:
        for key in _iter_agent_vm_info_keys(redis_client):
            try:
                raw_value = redis_client.get(key)
            except Exception:
                continue

            vm_info = _decode_agent_vm_info_payload(raw_value)
            if not isinstance(vm_info, dict) or vm_info.get("chat_id") != chat_id:
                continue
            if _agent_vm_is_inactivity_expired(vm_info, now_timestamp):
                continue

            checked_runtime, runtime_status = _inspect_agent_vm_container_status(
                vm_info, docker_client
            )
            if checked_runtime:
                status = runtime_status
            else:
                status = vm_info.get("status")
                status = status.strip().lower() if isinstance(status, str) else None

            if not _agent_vm_container_status_is_active(status):
                continue

            vm_info["status"] = status
            active_vms.append(vm_info)
    finally:
        if docker_client is not None:
            try:
                docker_client.close()
            except Exception:
                pass

    active_vms.sort(
        key=lambda vm: (
            float(vm.get("last_activity", 0.0) or 0.0),
            str(vm.get("vm_id") or ""),
        ),
        reverse=True,
    )
    return active_vms


async def _list_active_chat_agent_vms(chat_id: str) -> list[dict[str, Any]]:
    return await asyncio.to_thread(_list_active_chat_agent_vms_sync, chat_id)


async def _refresh_active_chat_agent_vms(
    chat_id: Any, *, reason: str = "chat_activity"
) -> list[str]:
    if (
        not isinstance(chat_id, str)
        or not chat_id.strip()
        or chat_id.startswith("local:")
    ):
        return []

    redis_client = _overflow_redis_client()
    if redis_client is None:
        return []

    try:
        active_vms = await _list_active_chat_agent_vms(chat_id)
        if not active_vms:
            return []

        now_timestamp = time.time()
        active_vm_ids = {
            vm.get("vm_id") for vm in active_vms if isinstance(vm.get("vm_id"), str)
        }
        current_mapping = None
        try:
            current_mapping = redis_client.get(f"agent_vm:{chat_id}")
        except Exception:
            current_mapping = None

        for vm_info in active_vms:
            vm_id = vm_info.get("vm_id")
            if not isinstance(vm_id, str) or not vm_id:
                continue
            vm_info["last_activity"] = now_timestamp
            redis_client.set(
                f"agent_vm_info:{vm_id}",
                json.dumps(vm_info),
            )
            if current_mapping == vm_id:
                redis_client.set(f"agent_vm:{chat_id}", vm_id)

        if current_mapping not in active_vm_ids and active_vms:
            best_vm = active_vms[0]
            best_vm_id = best_vm.get("vm_id")
            if isinstance(best_vm_id, str) and best_vm_id:
                redis_client.set(f"agent_vm:{chat_id}", best_vm_id)

        refreshed_ids = [
            vm.get("vm_id") for vm in active_vms if isinstance(vm.get("vm_id"), str)
        ]
        log.info(
            "[AgentVMKeepalive] Refreshed %d active chat VM(s) chat_id=%s reason=%s vm_ids=%s",
            len(refreshed_ids),
            chat_id,
            reason,
            refreshed_ids,
        )
        return refreshed_ids
    except Exception as exc:
        log.warning(
            "[AgentVMKeepalive] Failed to refresh active chat VMs chat_id=%s reason=%s: %s",
            chat_id,
            reason,
            exc,
        )
        return []


async def _create_chat_agent_vm_for_overflow(chat_id: str) -> str:
    timeout_hours = _overflow_agent_vm_timeout_hours()
    response = await _core_post_json(
        "/agent-vm/agent_vm_create",
        {
            "chat_id": chat_id,
            "timeout_hours": timeout_hours,
        },
    )
    if not response.get("success") or not response.get("vm_id"):
        raise RuntimeError(
            response.get("error")
            or response.get("message")
            or "agent-vm create failed"
        )
    return response["vm_id"]


async def _ensure_chat_agent_vm_for_overflow(chat_id: str) -> str:
    redis_client = _overflow_redis_client()
    if redis_client is not None:
        try:
            active_vms = await _list_active_chat_agent_vms(chat_id)
            if active_vms:
                best_vm = active_vms[0]
                best_vm_id = best_vm.get("vm_id")
                if isinstance(best_vm_id, str) and best_vm_id:
                    redis_client.set(f"agent_vm:{chat_id}", best_vm_id)
                    return best_vm_id
        except Exception:
            pass
        lock_key = f"overflow_agent_vm_lock:{chat_id}"
        lock_token = f"{os.getpid()}-{time.time_ns()}"
        started = time.monotonic()
        while True:
            try:
                active_vms = await _list_active_chat_agent_vms(chat_id)
                if active_vms:
                    best_vm = active_vms[0]
                    best_vm_id = best_vm.get("vm_id")
                    if isinstance(best_vm_id, str) and best_vm_id:
                        redis_client.set(f"agent_vm:{chat_id}", best_vm_id)
                        return best_vm_id

                if redis_client.set(lock_key, lock_token, nx=True, ex=30):
                    try:
                        active_vms = await _list_active_chat_agent_vms(chat_id)
                        if active_vms:
                            best_vm = active_vms[0]
                            best_vm_id = best_vm.get("vm_id")
                            if isinstance(best_vm_id, str) and best_vm_id:
                                redis_client.set(f"agent_vm:{chat_id}", best_vm_id)
                                return best_vm_id

                        vm_id = await _create_chat_agent_vm_for_overflow(chat_id)
                        redis_client.set(f"agent_vm:{chat_id}", vm_id)
                        return vm_id
                    finally:
                        try:
                            if redis_client.get(lock_key) == lock_token:
                                redis_client.delete(lock_key)
                        except Exception:
                            pass

                if (time.monotonic() - started) >= 10.0:
                    break
            except Exception:
                break

            await asyncio.sleep(0.1)

    return await _create_chat_agent_vm_for_overflow(chat_id)


async def _write_overflow_file_for_tool_result(
    chat_id: str,
    tool_function_name: str,
    rendered: str,
) -> dict[str, Any]:
    vm_id = await _ensure_chat_agent_vm_for_overflow(chat_id)
    format_hint = _detect_tool_result_overflow_format(rendered)
    path = _tool_result_overflow_path(tool_function_name, rendered, format_hint)
    chunk_size = _tool_result_overflow_chunk_chars()
    effective_vm_id = vm_id
    effective_path = path

    for index, start in enumerate(range(0, len(rendered), chunk_size)):
        chunk = rendered[start : start + chunk_size]
        response = await _core_post_json(
            "/agent-vm/agent_vm_create_file",
            {
                "vm_id": effective_vm_id,
                "path": effective_path,
                "content": chunk,
                "append": index > 0,
            },
        )
        if response.get("success") is not True:
            raise RuntimeError(
                response.get("error")
                or response.get("message")
                or "agent-vm create_file failed"
            )
        response_vm_id = response.get("vm_id")
        if isinstance(response_vm_id, str) and response_vm_id:
            effective_vm_id = response_vm_id
        response_path = response.get("path")
        if isinstance(response_path, str) and response_path:
            effective_path = response_path

    return {
        "overflow_file": True,
        "tool_name": tool_function_name,
        "char_count": len(rendered),
        "vm_id": effective_vm_id,
        "path": effective_path,
        "format": format_hint,
        "read_hint": _tool_result_overflow_read_hint(format_hint),
    }


async def _maybe_spill_large_tool_result(
    request,
    tool_function_name: str,
    tool_result,
    metadata: Optional[dict],
):
    if not _tool_result_overflow_enabled():
        return tool_result

    if _tool_result_overflow_exempt_for_metadata(metadata):
        return tool_result

    rendered = _render_tool_result_for_overflow(tool_result)
    if not rendered:
        return tool_result

    if len(rendered) <= _tool_result_overflow_max_chars():
        return tool_result

    chat_id = (metadata or {}).get("chat_id")
    if not isinstance(chat_id, str) or not chat_id or chat_id.startswith("local:"):
        log.warning(
            "[TOOL-OVERFLOW] Oversized tool result for %s could not be spilled because chat_id was unavailable",
            tool_function_name,
        )
        return tool_result

    try:
        pointer = await _write_overflow_file_for_tool_result(
            chat_id=chat_id,
            tool_function_name=tool_function_name,
            rendered=rendered,
        )
        log.info(
            "[TOOL-OVERFLOW] Spilled oversized tool result for %s on chat %s to %s (%d chars)",
            tool_function_name,
            chat_id,
            pointer["path"],
            pointer["char_count"],
        )
        return pointer
    except Exception as exc:
        log.warning(
            "[TOOL-OVERFLOW] Failed to spill oversized tool result for %s on chat %s: %s",
            tool_function_name,
            chat_id,
            exc,
        )
        return tool_result


def _build_incomplete_tool_call_result(
    tool_function_name: str,
    raw_arguments: str,
    parsed_arguments: dict,
    missing_required_arguments: list[str],
    completion_tokens: Optional[int] = None,
) -> dict:
    required_list = (
        ", ".join(missing_required_arguments)
        if missing_required_arguments
        else "unknown"
    )
    provided_arguments = (
        sorted(parsed_arguments.keys()) if isinstance(parsed_arguments, dict) else []
    )
    stripped = raw_arguments.strip() if isinstance(raw_arguments, str) else ""
    message = (
        f"Incomplete tool call for '{tool_function_name}'. Missing required "
        f"arguments: {required_list}. Retry this tool with a complete JSON "
        f"arguments object."
    )

    if stripped in {"", "{}", "null"}:
        message += " The model emitted an empty or partial tool input."

    if completion_tokens is not None:
        message += (
            f" The previous generation ended after {completion_tokens} completion "
            f"tokens, so the tool call may have been truncated."
        )

    result = {
        "success": False,
        "error": message,
        "retryable": True,
        "missing_required_arguments": missing_required_arguments,
        "provided_arguments": provided_arguments,
    }

    if isinstance(raw_arguments, str) and raw_arguments:
        preview = raw_arguments[:500]
        if len(raw_arguments) > 500:
            preview += "..."
        result["raw_arguments_preview"] = preview

    return result


def _tool_spec_for_tool_name(tool_name: str, tools: Optional[dict]) -> Optional[dict]:
    if not tool_name or not isinstance(tools, dict):
        return None

    tool = tools.get(tool_name)
    if not isinstance(tool, dict):
        return None

    tool_spec = tool.get("spec", {})
    if not isinstance(tool_spec, dict):
        return None

    return tool_spec


def _normalize_tool_call_arguments_for_schema(
    raw_arguments: Any,
    *,
    tool_name: str = "",
    tool_spec: Optional[dict] = None,
) -> tuple[str, dict, bool]:
    normalized_arguments, normalized_blank = normalize_blank_tool_call_arguments(
        raw_arguments,
        tool_spec,
    )

    parsed_arguments, parse_ok = _parse_tool_call_arguments(normalized_arguments)
    if normalized_blank and parse_ok:
        log.info(
            "[TOOL-CALL] Normalized blank arguments to {} for zero-arg tool %s",
            tool_name or "unknown",
        )
    return normalized_arguments, parsed_arguments, parse_ok


def _parse_tool_call_arguments(raw_arguments: Any) -> tuple[dict, bool]:
    if raw_arguments is None:
        raw_arguments = ""
    if not isinstance(raw_arguments, str):
        raw_arguments = str(raw_arguments)

    parsed_arguments = {}
    try:
        parsed_arguments = ast.literal_eval(raw_arguments)
    except Exception:
        try:
            parsed_arguments = json.loads(raw_arguments)
        except Exception:
            return {}, False

    if not isinstance(parsed_arguments, dict):
        return {}, False

    return parsed_arguments, True


def _normalize_single_required_string_argument_alias(
    tool_name: str,
    tool_spec: Optional[dict],
    parsed_arguments: dict,
) -> tuple[dict, bool]:
    if not isinstance(tool_spec, dict) or not isinstance(parsed_arguments, dict):
        return parsed_arguments, False

    parameters = tool_spec.get("parameters", {})
    if not isinstance(parameters, dict):
        return parsed_arguments, False

    properties = parameters.get("properties", {})
    required = parameters.get("required", [])
    if not isinstance(properties, dict) or not isinstance(required, list) or len(required) != 1:
        return parsed_arguments, False

    required_name = required[0]
    if (
        not isinstance(required_name, str)
        or required_name in parsed_arguments
        or not isinstance(properties.get(required_name), dict)
        or properties.get(required_name, {}).get("type") != "string"
    ):
        return parsed_arguments, False

    alias_keys = [
        key
        for key in _SINGLE_STRING_ARGUMENT_ALIAS_KEYS
        if key != required_name
        and isinstance(parsed_arguments.get(key), str)
        and parsed_arguments.get(key, "").strip()
    ]
    if len(alias_keys) != 1:
        return parsed_arguments, False

    alias_key = alias_keys[0]
    normalized_arguments = dict(parsed_arguments)
    normalized_arguments[required_name] = normalized_arguments.pop(alias_key)
    log.info(
        "[TOOL-CALL] Recovered aliased single-string argument for %s: %s -> %s",
        tool_name,
        alias_key,
        required_name,
    )
    return normalized_arguments, True


def _missing_required_arguments_for_tool_call(
    tool_call: dict, tools: Optional[dict]
) -> list[str]:
    if not isinstance(tool_call, dict) or not isinstance(tools, dict):
        return []

    tool_name = tool_call.get("function", {}).get("name", "")
    tool_spec = _tool_spec_for_tool_name(tool_name, tools)
    if not isinstance(tool_spec, dict):
        return []

    _, parsed_arguments, _ = _normalize_tool_call_arguments_for_schema(
        tool_call.get("function", {}).get("arguments", ""),
        tool_name=tool_name,
        tool_spec=tool_spec,
    )
    return get_missing_required_tool_arguments(
        tool_spec, parsed_arguments
    )


def _should_defer_incomplete_tool_calls(
    response_tool_calls: list,
    tools: Optional[dict],
    finish_reason: Optional[str],
    stop_reason: Optional[str],
) -> tuple[bool, list[dict]]:
    incomplete_tool_calls = []
    for tool_call in response_tool_calls or []:
        tool_name = tool_call.get("function", {}).get("name", "")
        raw_arguments = tool_call.get("function", {}).get("arguments", "")
        tool_spec = _tool_spec_for_tool_name(tool_name, tools)
        _, _, parse_ok = _normalize_tool_call_arguments_for_schema(
            raw_arguments,
            tool_name=tool_name,
            tool_spec=tool_spec,
        )
        missing_required_arguments = _missing_required_arguments_for_tool_call(
            tool_call, tools
        )
        if not parse_ok or missing_required_arguments:
            incomplete_tool_calls.append(
                {
                    "id": tool_call.get("id"),
                    "name": tool_name,
                    "parse_ok": parse_ok,
                    "missing_required_arguments": missing_required_arguments,
                }
            )

    normalized_reasons = {
        str(reason).lower()
        for reason in (finish_reason, stop_reason)
        if reason not in (None, "")
    }
    length_like = bool(
        normalized_reasons.intersection({"length", "max_tokens", "max_output_tokens"})
    )

    return bool(incomplete_tool_calls and length_like), incomplete_tool_calls


def _has_completed_tool_results_block(content_blocks: Optional[list]) -> bool:
    if not isinstance(content_blocks, list):
        return False

    for block in content_blocks:
        if not isinstance(block, dict) or block.get("type") != "tool_calls":
            continue
        content = block.get("content")
        results = block.get("results")
        if not isinstance(content, list) or not isinstance(results, list):
            continue
        if len(content) == 0 or len(results) < len(content):
            continue
        if block.get("ended_at") is None:
            continue
        return True

    return False


def _tool_calls_block_has_complete_results(block: Optional[dict[str, Any]]) -> bool:
    if not isinstance(block, dict) or block.get("type") != "tool_calls":
        return False

    tool_call_entries = block.get("content")
    if not isinstance(tool_call_entries, list) or len(tool_call_entries) == 0:
        return False

    results = normalize_tool_results(block.get("results"))
    result_ids = {
        result.get("tool_call_id")
        for result in results
        if isinstance(result, dict) and result.get("tool_call_id")
    }
    if len(result_ids) < len(tool_call_entries):
        return False

    for tool_call in tool_call_entries:
        tool_call_id = tool_call.get("id", "")
        if not tool_call_id or tool_call_id not in result_ids:
            return False

    return True


def _should_synthesize_incomplete_stream_length(
    *,
    response_tool_calls: list,
    finish_reason: Optional[str],
    stop_reason: Optional[str],
    generated_text_chars: int,
    generated_reasoning_chars: int,
    had_completed_tool_results_before_stream: bool,
) -> bool:
    if finish_reason or stop_reason:
        return False

    meaningful_partial_tool_call = False
    for tool_call in response_tool_calls:
        if not isinstance(tool_call, dict):
            continue
        function = tool_call.get("function")
        if not isinstance(function, dict):
            function = {}
        if str(function.get("name") or "").strip():
            meaningful_partial_tool_call = True
            break
        if str(function.get("arguments") or "").strip():
            meaningful_partial_tool_call = True
            break
    if meaningful_partial_tool_call:
        return False

    total_generated_chars = max(0, int(generated_text_chars or 0)) + max(
        0, int(generated_reasoning_chars or 0)
    )
    if total_generated_chars >= 100:
        return True

    return had_completed_tool_results_before_stream and total_generated_chars > 0


def _should_finalize_reasoning_only_incomplete_stream(
    *,
    response_tool_calls: list,
    finish_reason: Optional[str],
    stop_reason: Optional[str],
    generated_text_chars: int,
    generated_reasoning_chars: int,
    had_completed_tool_results_before_stream: bool,
) -> bool:
    if finish_reason or stop_reason:
        return False
    if response_tool_calls:
        return False
    if had_completed_tool_results_before_stream:
        return False
    return (
        max(0, int(generated_text_chars or 0)) == 0
        and max(0, int(generated_reasoning_chars or 0)) > 0
    )


def _continuation_followup_index(
    *,
    length_continue_attempts: int,
    anomaly_retry_attempts: int,
) -> int:
    total_attempts = max(0, int(length_continue_attempts or 0)) + max(
        0, int(anomaly_retry_attempts or 0)
    )
    return max(0, total_attempts - 1)


def _tool_declares_current_chat_id(tool: Optional[dict]) -> bool:
    if not isinstance(tool, dict):
        return False

    spec = tool.get("spec", {})
    if not isinstance(spec, dict):
        return False

    properties = (
        spec.get("parameters", {}).get("properties", {})
        if isinstance(spec.get("parameters", {}), dict)
        else {}
    )
    if not isinstance(properties, dict):
        return False

    chat_id_schema = properties.get("chat_id")
    if not isinstance(chat_id_schema, dict):
        return False

    description = str(chat_id_schema.get("description", "")).lower()
    return any(
        marker in description
        for marker in (
            "extract from system prompt",
            "current chat",
            "chat session",
        )
    )


def _is_agent_vm_runtime_tool(tool_function_name: str) -> bool:
    normalized_name = str(tool_function_name or "").strip().lower()
    return normalized_name.startswith("agent_vm_")


def _normalize_current_chat_scoped_tool_arguments(
    tool_function_name: str,
    tool: Optional[dict],
    tool_function_params: Optional[dict],
    metadata: Optional[dict],
):
    if not isinstance(tool_function_params, dict):
        return tool_function_params
    if not isinstance(metadata, dict):
        metadata = {}

    is_agent_vm_tool = _is_agent_vm_runtime_tool(tool_function_name)
    raw_current_chat_id = metadata.get("chat_id")
    current_chat_id = (
        raw_current_chat_id.strip()
        if isinstance(raw_current_chat_id, str)
        else ""
    )
    if not current_chat_id:
        if is_agent_vm_tool:
            log.warning(
                "[TOOL-CALL] Blocking %s because runtime chat_id is unavailable",
                tool_function_name,
            )
            tool_function_params.pop("chat_id", None)
            tool_function_params.pop("requester_chat_id", None)
            tool_function_params.pop("vm_id", None)
        return tool_function_params

    if (
        is_agent_vm_tool
        and str(tool_function_name).strip().lower() == "agent_vm_destroy"
    ):
        provided_requester_chat_id = tool_function_params.get("requester_chat_id")
        if provided_requester_chat_id != current_chat_id:
            if provided_requester_chat_id:
                log.warning(
                    "[TOOL-CALL] Overriding mismatched requester_chat_id for %s: model=%s runtime=%s",
                    tool_function_name,
                    provided_requester_chat_id,
                    current_chat_id,
                )
            else:
                log.info(
                    "[TOOL-CALL] Injecting runtime requester_chat_id for %s: %s",
                    tool_function_name,
                    current_chat_id,
                )
            tool_function_params["requester_chat_id"] = current_chat_id
        return tool_function_params

    if not is_agent_vm_tool and not _tool_declares_current_chat_id(tool):
        return tool_function_params

    provided_chat_id = tool_function_params.get("chat_id")
    if provided_chat_id != current_chat_id:
        if provided_chat_id:
            log.warning(
                "[TOOL-CALL] Overriding mismatched chat_id for %s: model=%s runtime=%s",
                tool_function_name,
                provided_chat_id,
                current_chat_id,
            )
        else:
            log.info(
                "[TOOL-CALL] Injecting runtime chat_id for %s: %s",
                tool_function_name,
                current_chat_id,
            )
        tool_function_params["chat_id"] = current_chat_id

    return tool_function_params


def _force_subagent_parent_context(
    tool_function_name: str,
    tool_function_params: Optional[dict],
    tool_call_id: Optional[str],
    metadata: Optional[dict],
):
    if not isinstance(tool_function_params, dict):
        return tool_function_params
    if not tool_function_name or "run_subagent" not in tool_function_name:
        return tool_function_params

    previous_parent_tool_call_id = tool_function_params.get("parent_tool_call_id")
    if (
        previous_parent_tool_call_id
        and previous_parent_tool_call_id != tool_call_id
    ):
        log.debug(
            "[TOOL-CALL] Overriding parent_tool_call_id for %s from %s to %s",
            tool_function_name,
            previous_parent_tool_call_id,
            tool_call_id,
        )
    # Always force the true parent tool_call_id so subagent lookup endpoints and
    # UI polling use the same identifier.
    tool_function_params["parent_tool_call_id"] = tool_call_id

    runtime_parent_chat_id = (
        metadata.get("chat_id") if isinstance(metadata, dict) else None
    )
    previous_parent_chat_id = tool_function_params.get("parent_chat_id")
    if (
        isinstance(runtime_parent_chat_id, str)
        and runtime_parent_chat_id
        and not runtime_parent_chat_id.startswith("local:")
    ):
        if (
            previous_parent_chat_id
            and previous_parent_chat_id != runtime_parent_chat_id
        ):
            log.debug(
                "[TOOL-CALL] Overriding parent_chat_id for %s from %s to %s",
                tool_function_name,
                previous_parent_chat_id,
                runtime_parent_chat_id,
            )
        tool_function_params["parent_chat_id"] = runtime_parent_chat_id
    else:
        tool_function_params.pop("parent_chat_id", None)

    return tool_function_params


def _force_cross_chat_context(
    tool_function_name: str,
    tool_function_params: Optional[dict],
    metadata: Optional[dict],
    tool_spec: Optional[dict] = None,
):
    """Force-inject trusted source-chat context into the cross-chat tools.

    subagents_send_message_to_chat and subagents_start_chat prefix delivered
    prompts with the sending chat's identity, and subagents_list_chats scopes
    listing to the calling user; all are provenance values a model could
    spoof, so the runtime metadata always wins. Keys are only injected when
    the tool's spec declares them, so a third-party tool that merely shares
    the name suffix is left untouched.
    """
    if not isinstance(tool_function_params, dict) or not tool_function_name:
        return tool_function_params
    is_start = "start_chat" in tool_function_name
    is_send = "send_message_to_chat" in tool_function_name or is_start
    is_list = "list_chats" in tool_function_name
    if not is_send and not is_list:
        return tool_function_params

    declared_properties = None
    if isinstance(tool_spec, dict):
        parameters = tool_spec.get("parameters", {})
        properties = parameters.get("properties", {}) if isinstance(parameters, dict) else {}
        if isinstance(properties, dict):
            declared_properties = set(properties.keys())

    def _declares(key: str) -> bool:
        return declared_properties is None or key in declared_properties

    if not isinstance(metadata, dict):
        metadata = {}

    if is_send:
        runtime_chat_id = metadata.get("chat_id")
        if (
            _declares("source_chat_id")
            and isinstance(runtime_chat_id, str)
            and runtime_chat_id
            and not runtime_chat_id.startswith("local:")
        ):
            tool_function_params["source_chat_id"] = runtime_chat_id
        else:
            tool_function_params.pop("source_chat_id", None)

        model = metadata.get("model")
        model = model if isinstance(model, dict) else {}
        model_name = model.get("name") or model.get("id")
        if _declares("source_model_name") and isinstance(model_name, str) and model_name:
            tool_function_params["source_model_name"] = model_name
        else:
            tool_function_params.pop("source_model_name", None)

        if _declares("source_is_agent") and model:
            info = model.get("info")
            info = info if isinstance(info, dict) else {}
            tool_function_params["source_is_agent"] = bool(info.get("base_model_id"))
        else:
            tool_function_params.pop("source_is_agent", None)

        if _declares("source_display_name"):
            # Multi-chat tiling: start_chat children carry a pane display
            # name in chat meta; the root/orchestrator chat has none.
            display_name = None
            if (
                isinstance(runtime_chat_id, str)
                and runtime_chat_id
                and not runtime_chat_id.startswith("local:")
            ):
                try:
                    chat_row = Chats.get_chat_by_id(runtime_chat_id)
                    chat_meta = getattr(chat_row, "meta", None)
                    multi_chat = (
                        chat_meta.get("multi_chat")
                        if isinstance(chat_meta, dict)
                        else None
                    )
                    if isinstance(multi_chat, dict):
                        candidate = multi_chat.get("display_name")
                        if isinstance(candidate, str) and candidate.strip():
                            display_name = candidate.strip()
                except Exception:
                    display_name = None
            tool_function_params["source_display_name"] = (
                display_name or "Orchestrator"
            )
        else:
            tool_function_params.pop("source_display_name", None)

        model_id = model.get("id")
        if _declares("source_model_id") and isinstance(model_id, str) and model_id:
            tool_function_params["source_model_id"] = model_id
        else:
            tool_function_params.pop("source_model_id", None)

    if is_list:
        runtime_user_id = metadata.get("user_id")
        if (
            _declares("owner_user_id")
            and isinstance(runtime_user_id, str)
            and runtime_user_id
        ):
            tool_function_params["owner_user_id"] = runtime_user_id
        else:
            tool_function_params.pop("owner_user_id", None)

    return tool_function_params


def _safe_json_loads(value):
    try:
        return json.loads(value)
    except Exception:
        return None


def normalize_tool_results(results):
    if results is None:
        return []

    if isinstance(results, str):
        results = _safe_json_loads(results)

    if isinstance(results, dict):
        if isinstance(results.get("results"), list):
            results = results["results"]
        else:
            results = [results]

    if not isinstance(results, list):
        return []

    normalized = []
    for item in results:
        if isinstance(item, dict):
            normalized.append(item)
            continue
        if isinstance(item, str):
            parsed = _safe_json_loads(item)
            if isinstance(parsed, dict):
                normalized.append(parsed)
            elif isinstance(parsed, list):
                normalized.extend([entry for entry in parsed if isinstance(entry, dict)])

    return normalized


def _serialize_replay_text_blocks(blocks):
    text_content = ""
    for block in blocks:
        block_type = block.get("type", "text")
        block_content = str(block.get("content", "")).strip()
        if not block_content:
            continue
        if block_type == "reasoning":
            text_content += (
                f"{CANONICAL_REASONING_START_TAG}{block_content}"
                f"{CANONICAL_REASONING_END_TAG}\n"
            )
        else:
            # Text blocks may carry literal think-tag sections a model wrote
            # into visible output (or that older builds failed to capture);
            # replaying them teaches models to imitate the pattern. Genuine
            # reasoning stays canonically wrapped via the branch above.
            block_content = _remove_complete_inline_reasoning_sections(
                block_content
            ).strip()
            if not block_content:
                continue
            text_content += f"{block_content}\n"
    return text_content.strip()


def _partition_tool_call_block_for_replay(block):
    tool_calls = block.get("content", [])
    if not isinstance(tool_calls, list):
        tool_calls = []

    results = normalize_tool_results(block.get("results"))
    results_by_tool_call_id = {}
    for result in results:
        tool_call_id = result.get("tool_call_id", "")
        if not tool_call_id:
            continue
        results_by_tool_call_id.setdefault(tool_call_id, []).append(result)

    matched_tool_calls = []
    matched_results = []
    unmatched_tool_call_ids = []

    for tool_call in tool_calls:
        if not isinstance(tool_call, dict):
            continue

        tool_call_id = tool_call.get("id", "")
        matched_entries = results_by_tool_call_id.pop(tool_call_id, None)
        if matched_entries:
            matched_tool_calls.append(tool_call)
            matched_results.extend(matched_entries)
            continue

        unmatched_tool_call_ids.append(tool_call_id)

    orphaned_result_ids = list(results_by_tool_call_id.keys())

    return {
        "matched_tool_calls": matched_tool_calls,
        "matched_results": matched_results,
        "unmatched_tool_call_ids": unmatched_tool_call_ids,
        "orphaned_result_ids": orphaned_result_ids,
    }


def _followup_history_guard_mode() -> str:
    raw = (
        os.getenv("OWUI_FOLLOWUP_HISTORY_GUARD", "on").strip().lower() or "on"
    )
    if raw in {"off", "0", "false", "no"}:
        return "off"
    if raw in {"log_only", "log-only", "log"}:
        return "log_only"
    return "on"


def collect_followup_user_message_anchors(
    messages: list[dict[str, Any]] | None,
) -> list[str]:
    """Stable identities (sha256 of user-message content) for history-fidelity
    checks across follow-up rounds of one turn."""
    anchors: list[str] = []
    for message in messages or []:
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        content = message.get("content")
        text = content if isinstance(content, str) else json.dumps(
            content, sort_keys=True, default=str
        )
        anchors.append(hashlib.sha256((text or "").encode("utf-8")).hexdigest())
    return anchors


def verify_followup_history_fidelity(
    messages: list[dict[str, Any]] | None,
    required_user_anchors,
    minimum_message_count: int = 0,
) -> dict[str, Any]:
    """Check that an outgoing follow-up payload still carries every user
    message the turn has seen. A payload that drops a previously-sent user
    message is never valid (incident c0127a20: an entire turn plus the user's
    correction vanished mid-loop). Message-count regression is reported but is
    not by itself a violation — some appendix messages (e.g. one-round image
    inputs) are legitimately dropped between rounds."""
    present = set(collect_followup_user_message_anchors(messages))
    required = set(required_user_anchors or [])
    missing = sorted(required - present)
    message_count = len(messages or [])
    return {
        "ok": not missing,
        "missing_anchors": missing,
        "message_count": message_count,
        "count_regressed": message_count < int(minimum_message_count or 0),
    }


def fold_promoted_seam_into_replay(
    replay_seam_blocks: list[dict[str, Any]] | None,
    finalized_content_blocks: list[dict[str, Any]] | None,
    steer_item: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    """Accumulate the replay-only seam a mid-turn steer promotion creates.

    When a steer promotes the live loop onto a new outer assistant message,
    the previous outer's finalized content blocks and the consumed steer
    survive only in the persisted chat record — which no mid-loop path reads.
    Folding them into a replay-only seam keeps the model's context continuous:
    subsequent rounds replay [seam blocks..., user_steer, current blocks...].
    The seam never feeds UI serialization or persistence of the new message.
    """
    seam = [
        copy.deepcopy(block)
        for block in (replay_seam_blocks or [])
        if isinstance(block, dict)
    ]
    seam.extend(
        copy.deepcopy(block)
        for block in (finalized_content_blocks or [])
        if isinstance(block, dict)
    )
    if isinstance(steer_item, dict):
        seam = append_user_steer_content_block(seam, steer_item)
    return seam


def build_followup_replay_messages(
    base_messages: list[dict[str, Any]] | None,
    replay_seam_blocks: list[dict[str, Any]] | None,
    content_blocks: list[dict[str, Any]] | None,
    replay_mode: str,
    *,
    convert_content_blocks=None,
):
    """Compose a follow-up/continuation payload: frozen base + promoted seam
    segments + the current outer message's blocks, all through the standard
    replay serializer."""
    convert = convert_content_blocks
    if convert is None:
        convert = globals().get("convert_content_blocks_to_messages")
    if convert is None:
        raise RuntimeError(
            "convert_content_blocks_to_messages is not available; pass "
            "convert_content_blocks explicitly"
        )
    combined_blocks = [
        *(replay_seam_blocks or []),
        *(content_blocks or []),
    ]
    return [
        *(base_messages or []),
        *convert(combined_blocks, True, replay_mode=replay_mode),
    ]


_CHAT_ACTIVE_TURN_KEY_PREFIX = "chat_active_turn:"
_CHAT_ACTIVE_TURN_TTL_SECONDS = 6 * 60 * 60


async def _publish_chat_active_turn(redis_client, chat_id, message_id) -> None:
    if redis_client is None or not chat_id or not message_id:
        return
    try:
        await redis_client.setex(
            f"{_CHAT_ACTIVE_TURN_KEY_PREFIX}{chat_id}",
            _CHAT_ACTIVE_TURN_TTL_SECONDS,
            str(message_id),
        )
    except Exception as error:
        log.debug(
            "[FOLLOW-UP][HISTORY-GUARD] Failed to publish active turn for %s: %s",
            chat_id,
            error,
        )


async def _read_chat_active_turn(redis_client, chat_id):
    if redis_client is None or not chat_id:
        return None
    try:
        value = await redis_client.get(f"{_CHAT_ACTIVE_TURN_KEY_PREFIX}{chat_id}")
    except Exception as error:
        log.debug(
            "[FOLLOW-UP][HISTORY-GUARD] Failed to read active turn for %s: %s",
            chat_id,
            error,
        )
        return None
    if value is None:
        return None
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)


def _build_terminal_tool_result_message(
    *, stop_reason: str | None = None, error_message: str | None = None
) -> str:
    if error_message:
        return f"Interrupted: {error_message}"

    normalized_stop_reason = str(stop_reason or "").strip().lower()
    if normalized_stop_reason == "user_stop":
        return "Interrupted: response stopped before tool completed."
    if normalized_stop_reason == "client_disconnect":
        return "Interrupted: client disconnected before tool completed."
    if normalized_stop_reason:
        return f"Interrupted: {normalized_stop_reason.replace('_', ' ')}."

    return "Interrupted: tool execution ended before completion."


def _freeze_tool_calls_block_for_terminal_state(
    block,
    *,
    stop_reason: str | None = None,
    error_message: str | None = None,
    now: float | None = None,
):
    if not isinstance(block, dict) or block.get("type") != "tool_calls":
        return []

    if now is None:
        now = time.time()

    block_had_complete_results = _tool_calls_block_has_complete_results(block)

    started_at = (
        block.get("execution_started_at")
        or block.get("started_at")
        or now
    )
    ended_at = block.get("ended_at") or now
    block["ended_at"] = ended_at
    block["duration"] = int(max(0, ended_at - started_at))
    block["streaming_preview"] = False
    block["done"] = True
    if stop_reason and not block_had_complete_results:
        block["stop_reason"] = stop_reason

    tool_call_entries = block.get("content", [])
    if not isinstance(tool_call_entries, list):
        tool_call_entries = []
        block["content"] = tool_call_entries

    results = normalize_tool_results(block.get("results"))
    for result in results:
        if not isinstance(result, dict):
            continue
        result.setdefault("started_at", started_at)
        result.setdefault("ended_at", ended_at)
        if result.get("duration") is None:
            try:
                result_started_at = float(result.get("started_at", started_at))
                result_ended_at = float(result.get("ended_at", ended_at))
            except (TypeError, ValueError):
                result_started_at = float(started_at)
                result_ended_at = float(ended_at)
            result["duration"] = int(
                max(0, result_ended_at - result_started_at)
            )

    existing_tool_call_ids = {
        result.get("tool_call_id") for result in results if result.get("tool_call_id")
    }
    tool_result_message = _build_terminal_tool_result_message(
        stop_reason=stop_reason,
        error_message=error_message,
    )

    for tool_call in tool_call_entries:
        tool_call_id = tool_call.get("id", "")
        if not tool_call_id or tool_call_id in existing_tool_call_ids:
            continue

        synthetic_result = {
            "tool_call_id": tool_call_id,
            "content": tool_result_message,
            "started_at": started_at,
            "ended_at": ended_at,
            "duration": int(max(0, ended_at - started_at)),
        }
        if stop_reason:
            synthetic_result["stop_reason"] = stop_reason
        results.append(synthetic_result)
        existing_tool_call_ids.add(tool_call_id)

    if results:
        block["results"] = results

    return results


def _freeze_tool_calls_block_for_terminal_error(
    block, error_message: str, *, now: float | None = None
):
    return _freeze_tool_calls_block_for_terminal_state(
        block,
        error_message=error_message,
        now=now,
    )


def _freeze_content_blocks_for_terminal_state(
    content_blocks,
    *,
    stop_reason: str | None = None,
    error_message: str | None = None,
    now: float | None = None,
):
    if not isinstance(content_blocks, list):
        return content_blocks

    if now is None:
        now = time.time()

    # Drop live thinking-indicator blocks that never received any reasoning
    # text; freezing them would persist an empty "Thought Ns" row.
    content_blocks[:] = [
        block
        for block in content_blocks
        if not _is_empty_open_reasoning_block(block)
    ]

    for block in content_blocks:
        if not isinstance(block, dict):
            continue

        block_type = block.get("type")
        if block_type == "reasoning" and block.get("ended_at") is None:
            started_at = block.get("started_at") or now
            block["ended_at"] = now
            block["duration"] = round(max(0, now - started_at))
            if stop_reason:
                block["stop_reason"] = stop_reason
            continue

        if block_type != "tool_calls":
            continue

        _freeze_tool_calls_block_for_terminal_state(
            block,
            stop_reason=stop_reason,
            error_message=error_message,
            now=now,
        )

    return content_blocks


_CONFIRMATION_TOKEN_PARAM_KEYS = (
    "__confirmation_token__",
    "_portico_confirmation_token",
    "confirmation_token",
)


# ---------------------------------------------------------------------------
# Phase 1: scheduled-run scope binding
# ---------------------------------------------------------------------------
#
# Logic lives in ``open_webui.utils.scheduled_run_scope`` so it can be
# unit-tested without standing up the FastAPI/middleware stack. Here we
# only adapt the production ``Chats.get_chat_by_id`` to that module's
# callable seam and the gate's ``propose_clarification`` /
# ``_mark_approved`` / ``_audit`` machinery.
#
# Trust boundary: the daemon stamps ``chat.meta`` via the OWUI service
# token at ``/api/v1/chats/new``. The model inside the chat cannot
# touch ``chat.meta`` — no MCP tool exposes that write, and the
# chip-resolve REST endpoint also doesn't mutate it. If that boundary
# ever changes (e.g. ``chat:tags:update``-style API starts touching
# ``meta``), this code path MUST be re-audited.
from open_webui.utils.scheduled_run_scope import (
    format_out_of_scope_resolution_line as _format_out_of_scope_resolution_line,
    propose_auth_required_clarification as _propose_auth_required_clarification_impl,
    propose_out_of_scope_clarification as _propose_out_of_scope_clarification_impl,
    read_scheduled_run_metadata as _read_scheduled_run_metadata_impl,
    is_oauth_initiating_tool as _is_oauth_initiating_tool,
    tool_in_scheduled_scope as _tool_in_scheduled_scope,
    widen_scheduled_task_scope_via_mcpo as _widen_scheduled_task_scope_via_mcpo,
)
from open_webui.utils.tool_confirmation_gate import (
    OUT_OF_SCOPE_OPTION_WIDEN_SCOPE as _OUT_OF_SCOPE_OPTION_WIDEN_SCOPE,
)


def _read_scheduled_run_metadata(
    chat_id: Optional[str],
) -> Optional[dict[str, Any]]:
    return _read_scheduled_run_metadata_impl(
        chat_id, get_chat_by_id=Chats.get_chat_by_id
    )


def _propose_auth_required_clarification(
    *,
    gate,
    chat_id: str,
    user_id: Optional[str],
    task_id: str,
    tool_server_id: str,
    tool_name: str,
    reason: str,
):
    """Round 4 / Issue 5b — middleware-side wrapper around the helper
    in ``scheduled_run_scope`` so the call site stays close to the
    other Phase-1 / Phase-2 wrappers and the import line at the top
    of this module."""

    return _propose_auth_required_clarification_impl(
        gate=gate,
        chat_id=chat_id,
        user_id=user_id,
        task_id=task_id,
        tool_server_id=tool_server_id,
        tool_name=tool_name,
        reason=reason,
    )


def _propose_out_of_scope_clarification(
    *,
    gate,
    chat_id: str,
    user_id: Optional[str],
    task_id: str,
    tool_name: str,
    tool_mcp: str,
    tool_args: Any,
    tool_summary: str,
    original_hash: str,
):
    return _propose_out_of_scope_clarification_impl(
        gate=gate,
        chat_id=chat_id,
        user_id=user_id,
        task_id=task_id,
        tool_name=tool_name,
        tool_mcp=tool_mcp,
        tool_args=tool_args,
        tool_summary=tool_summary,
        original_hash=original_hash,
    )


async def _apply_tool_confirmation_gate(
    *,
    chat_id: Optional[str],
    user_id: Optional[str],
    tool_function_name: str,
    tool_function_params: dict[str, Any],
    event_emitter: Any,
) -> tuple[dict[str, Any], Optional[str]]:
    """Run the per-action confirmation gate before any external tool fires.

    Returns ``(updated_params, blocking_tool_result)``. When the gate decides
    the call is safe (read-only) or carries a valid approval token, the
    returned ``blocking_tool_result`` is ``None`` and the caller should
    proceed with normal dispatch using ``updated_params`` (which has the
    confirmation token stripped so it never leaks into the upstream MCP
    payload). When the gate decides to block or reject, the tool result is
    populated and the caller MUST use it instead of dispatching — the gate
    has already emitted the user-facing card or error event.

    Threat-model item N-012, see ``tool_confirmation_gate.py`` and
    ``docs/security-tool-confirmation.md``.
    """

    confirmation_token: Optional[str] = None
    if isinstance(tool_function_params, dict):
        params = dict(tool_function_params)
        for key in _CONFIRMATION_TOKEN_PARAM_KEYS:
            if key in params:
                value = params.pop(key)
                if isinstance(value, str) and value.strip():
                    confirmation_token = value.strip()
        tool_function_params = params

    # PORTICO PATCH: feature toggle. When ``tool_confirmation_gate`` is
    # disabled in ``optimization_flags.json``, short-circuit here with a
    # transparent pass-through so the caller dispatches as if the gate
    # never existed. The confirmation token (if any) is still stripped
    # above so it never leaks into the upstream MCP payload.
    if not _optimization_flag_enabled("tool_confirmation_gate", default=True):
        return tool_function_params, None

    gate = default_tool_confirmation_gate()

    # Round 4 / Issue 5b — sub-agent OAuth guardrail.
    #
    # Scheduled-run sub-agents execute unattended. A model trying to
    # call ``mcp_assistant_authorize_integration`` (or other auth-
    # initiating tools) inside one would launch an OAuth flow with no
    # human at the keyboard, which is at best useless and at worst a
    # CSRF / consent-confusion vector. We refuse those calls BEFORE
    # they reach the regular gate machinery and surface an
    # auth-required clarification chip so the user can authenticate
    # from the main app and then re-run the task.
    #
    # We deliberately check this BEFORE ``gate.evaluate_tool_call``
    # so the auth-initiating tool never enters the pending-action
    # table — it would just confuse the audit log otherwise.
    if _is_oauth_initiating_tool(tool_function_name):
        scheduled_meta = _read_scheduled_run_metadata(chat_id)
        if scheduled_meta is not None:
            tool_server_id = ""
            if isinstance(tool_function_params, dict):
                candidate = tool_function_params.get("server_id") or tool_function_params.get(
                    "skill_id"
                )
                if isinstance(candidate, str):
                    tool_server_id = candidate
            chip = _propose_auth_required_clarification(
                gate=gate,
                chat_id=chat_id or "",
                user_id=user_id,
                task_id=scheduled_meta["task_id"],
                tool_server_id=tool_server_id or "(unknown)",
                tool_name=tool_function_name,
                reason="subagent_oauth_initiation_blocked",
            )
            gate._audit(
                "subagent_oauth_initiation_blocked",
                chat_id=chat_id or "",
                tool_name=tool_function_name,
                mcp=tool_server_id or None,
                task_id=scheduled_meta["task_id"],
            )
            if event_emitter and chip is not None:
                try:
                    await event_emitter(
                        {
                            "type": "chat:tool_confirmation",
                            "data": {
                                "hash": chip.hash,
                                "tool_name": chip.tool_name,
                                "mcp": chip.mcp,
                                "summary": chip.summary,
                                "args_preview": chip.args_preview,
                                "kind": chip.kind,
                                "prompt": chip.prompt,
                                "options": [opt.to_dict() for opt in chip.options],
                                "allow_freeform": chip.allow_freeform,
                                "context": chip.context,
                            },
                        }
                    )
                except Exception:  # noqa: BLE001
                    log.exception(
                        "[tool-confirmation-gate] event_emitter failed for auth-required chip"
                    )
            return (
                tool_function_params,
                {
                    "is_error": True,
                    "error": {
                        "message": (
                            "Sub-agent runs cannot start an OAuth flow. "
                            "Authenticate from the main app and re-run the task."
                        ),
                        "error_type": "subagent_oauth_blocked",
                    },
                    "auth_required": True,
                    "task_id": scheduled_meta["task_id"],
                    "tool_server_id": tool_server_id or None,
                },
            )

    decision = gate.evaluate_tool_call(
        chat_id=chat_id or "",
        user_id=user_id,
        tool_name=tool_function_name,
        args=tool_function_params,
        confirmation_token=confirmation_token,
    )

    if decision.action == "dispatch":
        return tool_function_params, None

    # Phase 1: scheduled-run scope binding.
    #
    # If the gate decided to BLOCK (no approval token, destructive tool,
    # would normally surface a chip) AND we're inside a sub-agent chat
    # that was dispatched by the scheduling daemon, consult the chat's
    # ``meta.scheduled_approved_scope``:
    #
    #   * tool's mcp / tool_server_id IS in scope
    #     -> auto-dispatch + audit ``dispatched_scheduled_pre_approved``.
    #     The chip never surfaces to the user. Hash binding still
    #     applies via the gate's existing pending-action machinery, so
    #     this is per-action even though the user pre-approved a CLASS
    #     of actions at task creation.
    #
    #   * tool's mcp / tool_server_id is NOT in scope
    #     -> propose a CLARIFICATION chip with three options
    #     (block / approve_once / widen_scope). The original
    #     pending-action entry is dropped; the chip itself becomes the
    #     gating surface.
    #
    # Threat model: the metadata read is trusted because only the
    # daemon stamps it (see ``_read_scheduled_run_metadata`` doc).
    # Hash binding for in-scope dispatch survives because the gate
    # already wrote a pending entry on ``evaluate_tool_call``; we mark
    # that hash approved and let the gate's normal single-use machinery
    # consume it.
    if decision.action == "block" and decision.card is not None:
        scheduled_meta = _read_scheduled_run_metadata(chat_id)
        if scheduled_meta is None:
            # Round 4 hotfix: emit a diagnostic audit when we're about
            # to surface a regular chip in a chat that COULD have been
            # a scheduled run but turned out not to carry the daemon
            # stamp. This lets the operator distinguish:
            #   * "user-driven chat, expected chip" (scope helper
            #     wasn't called) — no event.
            #   * "scheduled-run chat without scope stamp" (e.g.
            #     daemon failed to propagate metadata, or upstream
            #     OWUI dropped chat["meta"]) — this event fires.
            # The chat folder lookup would be more authoritative but
            # adds I/O on the hot path; the audit-log surface for
            # ``proposed`` already records chat_id, so cross-
            # referencing is one query away.
            try:
                gate._audit(
                    "scheduled_run_meta_absent",
                    chat_id=chat_id or "",
                    tool_name=tool_function_name,
                    mcp=decision.card.mcp,
                )
            except Exception:  # noqa: BLE001 — audit must never break dispatch
                log.exception(
                    "[scheduled-run-scope] absent-meta audit emit failed"
                )
        if scheduled_meta is not None:
            in_scope = _tool_in_scheduled_scope(
                tool_name=tool_function_name,
                tool_mcp=decision.card.mcp,
                approved_scope=scheduled_meta["approved_scope"],
            )
            # Round 4 hotfix: emit a diagnostic audit so we can grep
            # logs to debug "why is the chip showing in a scheduled
            # run?". The event carries the actual scope set + the
            # tool's mcp + the in-scope verdict — which is everything
            # an operator needs to tell whether the task scope was
            # too narrow or the alias-normalization failed. Cheap;
            # only fires on the destructive-tool path.
            try:
                gate._audit(
                    "scheduled_run_scope_decision",
                    chat_id=chat_id or "",
                    tool_name=tool_function_name,
                    mcp=decision.card.mcp,
                    task_id=scheduled_meta["task_id"],
                    approved_scope=sorted(scheduled_meta["approved_scope"]),
                    in_scope=in_scope,
                )
            except Exception:  # noqa: BLE001 - audit must never break dispatch
                log.exception(
                    "[scheduled-run-scope] audit emit failed; continuing"
                )
            if in_scope:
                # Mark the pending hash as approved so the gate's normal
                # dispatch path consumes it. We DON'T directly bypass
                # the gate — going through the same approved-hash slot
                # keeps the audit log uniform (one ``proposed`` then
                # one ``dispatched_after_approval`` plus our scheduled
                # pre-approval annotation).
                gate._mark_approved(chat_id or "", decision.card.hash)
                gate._audit(
                    "dispatched_scheduled_pre_approved",
                    chat_id=chat_id or "",
                    tool_name=tool_function_name,
                    mcp=decision.card.mcp,
                    hash=decision.card.hash,
                    task_id=scheduled_meta["task_id"],
                )
                # Re-evaluate so the gate consumes the approval.
                second_pass = gate.evaluate_tool_call(
                    chat_id=chat_id or "",
                    user_id=user_id,
                    tool_name=tool_function_name,
                    args=tool_function_params,
                    confirmation_token=None,
                )
                if second_pass.action == "dispatch":
                    return tool_function_params, None
                # Defensive: if the re-evaluation didn't dispatch (only
                # possible if the registry classified the tool as
                # destructive but our scope match is bogus), fall back
                # to the regular chip path below.

            else:
                # Out-of-scope. Replace the standard chip with a
                # clarification chip so the user can pick how the run
                # should handle this surprise tool call.
                #
                # Drop the standard pending entry — its hash isn't
                # what we're going to ask the user about anyway. The
                # clarification chip carries the original tool call
                # in its context, and the batch-resolution path is
                # responsible for translating the user's option_id
                # into approved-hash + dispatch (or rejection).
                gate._drop_chat(chat_id or "", only=[decision.card.hash])
                clarification_card = _propose_out_of_scope_clarification(
                    gate=gate,
                    chat_id=chat_id or "",
                    user_id=user_id,
                    task_id=scheduled_meta["task_id"],
                    tool_name=tool_function_name,
                    tool_mcp=decision.card.mcp,
                    tool_args=tool_function_params,
                    tool_summary=decision.card.summary,
                    original_hash=decision.card.hash,
                )
                if event_emitter and clarification_card is not None:
                    try:
                        await event_emitter(
                            {
                                "type": "chat:tool_confirmation",
                                "data": {
                                    "hash": clarification_card.hash,
                                    "tool_name": clarification_card.tool_name,
                                    "mcp": clarification_card.mcp,
                                    "summary": clarification_card.summary,
                                    "args_preview": clarification_card.args_preview,
                                    "kind": clarification_card.kind,
                                    "prompt": clarification_card.prompt,
                                    "options": [
                                        opt.to_dict() for opt in clarification_card.options
                                    ],
                                    "allow_freeform": clarification_card.allow_freeform,
                                    "context": clarification_card.context,
                                },
                            }
                        )
                    except Exception:  # noqa: BLE001
                        log.exception(
                            "[tool-confirmation-gate] event_emitter failed for out-of-scope chip"
                        )
                return (
                    tool_function_params,
                    (
                        "This tool call is outside the scheduled task's "
                        "pre-approved scope. A clarification chip has been "
                        "shown to the user with three choices: block this "
                        "run, approve this single call, or widen the task's "
                        "scope permanently. Do not retry; wait for the "
                        "user's decision."
                    ),
                )

    if decision.action == "block" and decision.card is not None:
        if event_emitter:
            try:
                # Phase 3: emit the generic chip schema. Older renderers
                # (cached SPA bundles, mobile clients) only read the
                # historical fields (hash / tool_name / mcp / summary
                # / args_preview) and ignore the rest, so adding the
                # generic fields is backward-compatible.
                card = decision.card
                await event_emitter(
                    {
                        "type": "chat:tool_confirmation",
                        "data": {
                            "hash": card.hash,
                            "tool_name": card.tool_name,
                            "mcp": card.mcp,
                            "summary": card.summary,
                            "args_preview": card.args_preview,
                            # Generic chip fields (Phase 3). Renderers
                            # that understand them paint per-kind UI;
                            # legacy renderers fall back to the
                            # tool-confirmation defaults baked into the
                            # frontend component.
                            "kind": card.kind,
                            "prompt": card.prompt,
                            "options": [opt.to_dict() for opt in card.options],
                            "allow_freeform": card.allow_freeform,
                            "context": card.context,
                        },
                    }
                )
            except Exception:  # noqa: BLE001 - emitter must not break dispatch
                log.exception(
                    "[tool-confirmation-gate] event_emitter failed for chat:tool_confirmation"
                )

        return (
            tool_function_params,
            (
                "This tool call requires explicit user confirmation before "
                "it can be dispatched. A confirmation card has been shown "
                "to the user with the proposed action and arguments. Do "
                "not retry. Wait for the user's next message — only an "
                "explicit approval will authorize this exact action. If "
                "the user asks for changes or cancels, do not re-attempt "
                "the same call without showing a fresh confirmation."
            ),
        )

    if decision.action == "reject":
        reason = decision.reject_reason or "rejected"
        if event_emitter:
            try:
                # Include the call hash so the renderer can drop the EXACT
                # rejected chip out of ``pendingToolConfirmations`` instead
                # of filtering by ``tool_name`` and clobbering siblings that
                # share a name (e.g. two stacked ``slack_conversations_add_message``
                # chips with different payloads).
                rejected_hash = compute_call_hash(
                    tool_function_name, tool_function_params or {}
                )
                await event_emitter(
                    {
                        "type": "chat:tool_confirmation_rejected",
                        "data": {
                            "tool_name": tool_function_name,
                            "reason": reason,
                            "hash": rejected_hash,
                        },
                    }
                )
            except Exception:  # noqa: BLE001
                log.exception(
                    "[tool-confirmation-gate] event_emitter failed for chat:tool_confirmation_rejected"
                )

        if reason == "hash_mismatch":
            message = (
                "Tool call refused: the confirmation token does not match "
                "the current arguments. Re-emit the call without a token "
                "to surface a fresh confirmation card to the user."
            )
        else:
            message = (
                "Tool call refused: confirmation token is unknown or "
                "expired. Do not retry without a fresh user confirmation."
            )
        return tool_function_params, message

    # Defensive: unknown action shape -> proceed (gate must never crash chat).
    log.warning(
        "[tool-confirmation-gate] unknown decision shape action=%r — "
        "proceeding with dispatch as a defensive default",
        getattr(decision, "action", None),
    )
    return tool_function_params, None


async def chat_completion_tools_handler(
    request: Request, body: dict, extra_params: dict, user: UserModel, models, tools
) -> tuple[dict, dict]:
    async def get_content_from_response(response) -> Optional[str]:
        content = None
        if hasattr(response, "body_iterator"):
            async for chunk in response.body_iterator:
                data = json.loads(chunk.decode("utf-8", "replace"))
                content = data["choices"][0]["message"]["content"]

            # Cleanup any remaining background tasks if necessary
            if response.background is not None:
                await response.background()
        else:
            content = response["choices"][0]["message"]["content"]
        return content

    def get_tools_function_calling_payload(messages, task_model_id, content):
        user_message = get_last_user_message(messages)

        if user_message and messages and messages[-1]["role"] == "user":
            # Remove the last user message to avoid duplication
            messages = messages[:-1]

        recent_messages = messages[-4:] if len(messages) > 4 else messages
        chat_history = "\n".join(
            f"{message['role'].upper()}: \"\"\"{get_content_from_message(message)}\"\"\""
            for message in recent_messages
        )

        prompt = (
            f"History:\n{chat_history}\nQuery: {user_message}"
            if chat_history
            else f"Query: {user_message}"
        )

        return {
            "model": task_model_id,
            "messages": [
                {"role": "system", "content": content},
                {"role": "user", "content": prompt},
            ],
            "stream": False,
            "metadata": {"task": str(TASKS.FUNCTION_CALLING)},
        }

    event_caller = extra_params["__event_call__"]
    event_emitter = extra_params["__event_emitter__"]
    metadata = extra_params["__metadata__"]

    task_model_id = get_task_model_id(
        body["model"],
        request.app.state.config.TASK_MODEL,
        request.app.state.config.TASK_MODEL_EXTERNAL,
        models,
    )

    skip_files = False
    sources = []

    specs = [tool["spec"] for tool in tools.values()]
    tools_specs = json.dumps(specs, ensure_ascii=False)

    if request.app.state.config.TOOLS_FUNCTION_CALLING_PROMPT_TEMPLATE != "":
        template = request.app.state.config.TOOLS_FUNCTION_CALLING_PROMPT_TEMPLATE
    else:
        template = DEFAULT_TOOLS_FUNCTION_CALLING_PROMPT_TEMPLATE

    tools_function_calling_prompt = tools_function_calling_generation_template(
        template, tools_specs
    )
    payload = get_tools_function_calling_payload(
        body["messages"], task_model_id, tools_function_calling_prompt
    )

    try:
        response = await generate_chat_completion(request, form_data=payload, user=user)
        log.debug(
            "[TOOLS] Tool-calling model response received type=%s status=%s",
            type(response).__name__,
            getattr(response, "status_code", None),
        )
        content = await get_content_from_response(response)
        log.debug(
            "[TOOLS] Tool-calling model content extracted length=%d",
            len(content or ""),
        )

        if not content:
            return body, {}

        try:
            content = content[content.find("{") : content.rfind("}") + 1]
            if not content:
                raise Exception("No JSON object found in the response")

            result = json.loads(content)

            # Limit concurrent tool calls to avoid overwhelming tool servers
            tool_call_semaphore = asyncio.Semaphore(
                GLOBAL_TOOL_EXECUTION_CONCURRENCY_LIMIT
            )

            async def tool_call_handler(tool_call):
                async with tool_call_semaphore:
                    log.debug(
                        "[TOOLS] Handling tool_call id_present=%s name_present=%s has_parameters=%s",
                        bool(tool_call.get("id")),
                        bool(tool_call.get("name")),
                        bool(tool_call.get("parameters")),
                    )

                    tool_call_id = tool_call.get("id", "")
                    tool_function_name = tool_call.get("name", None)
                    if tool_function_name not in tools:
                        return None

                    tool_function_params = tool_call.get("parameters", {})
                    tool_runtime_metadata = dict(metadata or {})
                    if tool_call_id:
                        tool_runtime_metadata["tool_call_id"] = tool_call_id

                    tool = None
                    tool_type = ""
                    direct_tool = False
                    server_id = None

                    try:
                        tool = tools[tool_function_name]
                        tool_type = tool.get("type", "")
                        direct_tool = tool.get("direct", False)
                        server_id = _resolve_tool_server_id(tool)
                        tool_result_files = []
                        tool_result_embeds = []
                        if server_id:
                            tool_runtime_metadata["server_id"] = server_id
                            tool_runtime_metadata["server_is_core"] = bool(
                                _load_server_metadata(server_id).get("is_core", False)
                            )

                        spec = tool.get("spec", {})
                        allowed_params = (
                            spec.get("parameters", {}).get("properties", {}).keys()
                        )
                        tool_function_params = {
                            k: v
                            for k, v in tool_function_params.items()
                            if k in allowed_params
                        }
                        tool_function_params = (
                            _normalize_current_chat_scoped_tool_arguments(
                                tool_function_name=tool_function_name,
                                tool=tool,
                                tool_function_params=tool_function_params,
                                metadata=metadata,
                            )
                        )

                        missing_required_arguments = (
                            get_missing_required_tool_arguments(
                                spec, tool_function_params
                            )
                        )
                        if missing_required_arguments:
                            tool_result = _build_incomplete_tool_call_result(
                                tool_function_name=tool_function_name,
                                raw_arguments=json.dumps(
                                    tool_call.get("parameters", {}), ensure_ascii=False
                                ),
                                parsed_arguments=tool_function_params,
                                missing_required_arguments=missing_required_arguments,
                            )
                        elif True:
                            (
                                tool_function_params,
                                _gate_blocking_result,
                            ) = await _apply_tool_confirmation_gate(
                                chat_id=metadata.get("chat_id"),
                                user_id=getattr(user, "id", None) if user else None,
                                tool_function_name=tool_function_name,
                                tool_function_params=tool_function_params,
                                event_emitter=event_emitter,
                            )
                            if _gate_blocking_result is not None:
                                tool_result = _gate_blocking_result
                            elif tool.get("direct", False):
                                tool_result = await _call_direct_tool_event(
                                    event_caller=event_caller,
                                    payload={
                                        "type": "execute:tool",
                                        "data": {
                                            "id": str(uuid4()),
                                            "name": tool_function_name,
                                            "params": tool_function_params,
                                            "server": tool.get("server", {}),
                                            "session_id": metadata.get("session_id", None),
                                        },
                                    },
                                    tool_function_name=tool_function_name,
                                )

                            elif tool_type == "mcp":
                                tool_result = await call_mcp_tool_with_runtime_headers(
                                    client_factory=MCPClient,
                                    request=extra_params.get("__request__") or request,
                                    user=user,
                                    server_id=tool["server_id"],
                                    mcp_server_connection=tool["mcp_server_connection"],
                                    extra_params=extra_params,
                                    metadata=tool_runtime_metadata,
                                    function_name=tool["original_name"],
                                    function_args=tool_function_params,
                                )
                            elif tool_type == "external" and tool.get(
                                "tool_server_connection"
                            ):
                                tool_result = await call_openapi_tool_with_runtime_headers(
                                    execute_tool_server=execute_tool_server,
                                    request=extra_params.get("__request__") or request,
                                    user=user,
                                    tool_server_connection=tool["tool_server_connection"],
                                    tool_server_data=tool["tool_server_data"],
                                    extra_params=extra_params,
                                    metadata=tool_runtime_metadata,
                                    function_name=tool["server_operation_name"],
                                    function_args=tool_function_params,
                                )
                            else:
                                tool_function = get_updated_tool_function(
                                    function=tool["callable"],
                                    extra_params={
                                        "__metadata__": metadata,
                                        "__request__": extra_params.get("__request__"),
                                    },
                                )
                                tool_result = await tool_function(**tool_function_params)

                    except Exception as e:
                        tool_result = normalize_tool_execution_error(e)

                    tool_result, tool_result_files, tool_result_embeds = (
                        await process_tool_result(
                            request,
                            tool_function_name,
                            tool_result,
                            tool_type,
                            direct_tool,
                            tool_runtime_metadata,
                            user,
                            server_id=server_id,
                        )
                    )

                    if event_emitter:
                        if tool_result_files:
                            await event_emitter(
                                {
                                    "type": "files",
                                    "data": {
                                        "files": tool_result_files,
                                    },
                                }
                            )

                        if tool_result_embeds:
                            await event_emitter(
                                {
                                    "type": "embeds",
                                    "data": {
                                        "embeds": tool_result_embeds,
                                    },
                                }
                            )

                    if tool_result:
                        tool = tools[tool_function_name]
                        tool_id = tool.get("tool_id", "")

                        tool_name = (
                            f"{tool_id}/{tool_function_name}"
                            if tool_id
                            else f"{tool_function_name}"
                        )

                        return {
                            "tool_name": tool_name,
                            "tool_result": tool_result,
                            "tool_function_params": tool_function_params,
                            "is_file_handler": (
                                tools[tool_function_name]
                                .get("metadata", {})
                                .get("file_handler", False)
                            ),
                        }

                    return None

            tool_calls_to_execute = []
            if result.get("tool_calls"):
                tool_calls_to_execute = result.get("tool_calls")
            elif result:
                tool_calls_to_execute = [result]

            if tool_calls_to_execute:
                tool_results = await asyncio.gather(
                    *[tool_call_handler(tc) for tc in tool_calls_to_execute],
                    return_exceptions=True,
                )

                for tool_result_data in tool_results:
                    if isinstance(tool_result_data, Exception):
                        log.error(
                            f"[NON-NATIVE TOOL EXEC] Tool call failed: {tool_result_data}"
                        )
                        continue
                    if not tool_result_data:
                        continue

                    # Citation is enabled for this tool
                    sources.append(
                        {
                            "source": {
                                "name": tool_result_data["tool_name"],
                            },
                            "document": [str(tool_result_data["tool_result"])],
                            "metadata": [
                                {
                                    "source": tool_result_data["tool_name"],
                                    "parameters": tool_result_data[
                                        "tool_function_params"
                                    ],
                                }
                            ],
                            "tool_result": True,
                        }
                    )

                    if tool_result_data["is_file_handler"]:
                        skip_files = True

        except Exception as e:
            log.debug(f"Error: {e}")
            content = None
    except Exception as e:
        log.debug(f"Error: {e}")
        content = None

    log.debug(f"tool_contexts: {sources}")

    if skip_files and "files" in body.get("metadata", {}):
        del body["metadata"]["files"]

    return body, {"sources": sources}


async def chat_memory_handler(
    request: Request, form_data: dict, extra_params: dict, user
):
    if not _is_retrieval_enabled(request):
        return form_data

    query_memory, QueryMemoryForm = _load_memory_helpers()

    try:
        results = await query_memory(
            request,
            QueryMemoryForm(
                **{
                    "content": get_last_user_message(form_data["messages"]) or "",
                    "k": 3,
                }
            ),
            user,
        )
    except Exception as e:
        log.debug(e)
        results = None

    user_context = ""
    if results and hasattr(results, "documents"):
        if results.documents and len(results.documents) > 0:
            for doc_idx, doc in enumerate(results.documents[0]):
                created_at_date = "Unknown Date"

                if results.metadatas[0][doc_idx].get("created_at"):
                    created_at_timestamp = results.metadatas[0][doc_idx]["created_at"]
                    created_at_date = time.strftime(
                        "%Y-%m-%d", time.localtime(created_at_timestamp)
                    )

                user_context += f"{doc_idx + 1}. [{created_at_date}] {doc}\n"

    form_data["messages"] = add_or_update_system_message(
        f"User Context:\n{user_context}\n", form_data["messages"], append=True
    )

    return form_data


async def chat_web_search_handler(
    request: Request, form_data: dict, extra_params: dict, user
):
    if not _is_retrieval_enabled(request):
        log.info("[WEB_SEARCH] Retrieval bypass enabled - skipping web search handler")
        return form_data

    process_web_search, SearchForm, _ = _load_retrieval_helpers()

    event_emitter = extra_params["__event_emitter__"]
    await event_emitter(
        {
            "type": "status",
            "data": {
                "action": "web_search",
                "description": "Searching the web",
                "done": False,
            },
        }
    )

    messages = form_data["messages"]
    user_message = get_last_user_message(messages)

    queries = []
    try:
        res = await generate_queries(
            request,
            {
                "model": form_data["model"],
                "messages": messages,
                "prompt": user_message,
                "type": "web_search",
            },
            user,
        )

        response = res["choices"][0]["message"]["content"]

        try:
            bracket_start = response.find("{")
            bracket_end = response.rfind("}") + 1

            if bracket_start == -1 or bracket_end == -1:
                raise Exception("No JSON object found in the response")

            response = response[bracket_start:bracket_end]
            queries = json.loads(response)
            queries = queries.get("queries", [])
        except Exception as e:
            queries = [response]

        if ENABLE_QUERIES_CACHE:
            request.state.cached_queries = queries

    except Exception as e:
        log.exception(e)
        queries = [user_message]

    # Check if generated queries are empty
    if len(queries) == 1 and queries[0].strip() == "":
        queries = [user_message]

    # Check if queries are not found
    if len(queries) == 0:
        await event_emitter(
            {
                "type": "status",
                "data": {
                    "action": "web_search",
                    "description": "No search query generated",
                    "done": True,
                },
            }
        )
        return form_data

    await event_emitter(
        {
            "type": "status",
            "data": {
                "action": "web_search_queries_generated",
                "queries": queries,
                "done": False,
            },
        }
    )

    try:
        results = await process_web_search(
            request,
            SearchForm(queries=queries),
            user=user,
        )

        if results:
            files = form_data.get("files", [])

            if results.get("collection_names"):
                for col_idx, collection_name in enumerate(
                    results.get("collection_names")
                ):
                    files.append(
                        {
                            "collection_name": collection_name,
                            "name": ", ".join(queries),
                            "type": "web_search",
                            "urls": results["filenames"],
                            "queries": queries,
                        }
                    )
            elif results.get("docs"):
                # Invoked when bypass embedding and retrieval is set to True
                docs = results["docs"]
                files.append(
                    {
                        "docs": docs,
                        "name": ", ".join(queries),
                        "type": "web_search",
                        "urls": results["filenames"],
                        "queries": queries,
                    }
                )

            form_data["files"] = files

            await event_emitter(
                {
                    "type": "status",
                    "data": {
                        "action": "web_search",
                        "description": "Searched {{count}} sites",
                        "urls": results["filenames"],
                        "items": results.get("items", []),
                        "done": True,
                    },
                }
            )
        else:
            await event_emitter(
                {
                    "type": "status",
                    "data": {
                        "action": "web_search",
                        "description": "No search results found",
                        "done": True,
                        "error": True,
                    },
                }
            )

    except Exception as e:
        log.exception(e)
        await event_emitter(
            {
                "type": "status",
                "data": {
                    "action": "web_search",
                    "description": "An error occurred while searching the web",
                    "queries": queries,
                    "done": True,
                    "error": True,
                },
            }
        )

    return form_data


def get_images_from_messages(message_list):
    images = []

    for message in reversed(message_list):
        message_images = []
        for file in message.get("files", []):
            if file.get("type") == "image":
                message_images.append(file.get("url"))

        if message_images:
            images.append(message_images)

    return images


def get_image_urls(delta_images, request, metadata, user) -> list[str]:
    if not isinstance(delta_images, list):
        return []

    image_urls = []
    for img in delta_images:
        if not isinstance(img, dict) or img.get("type") != "image_url":
            continue

        url = img.get("image_url", {}).get("url")
        if not url:
            continue

        if url.startswith("data:image/png;base64"):
            url = get_image_url_from_base64(request, url, metadata, user)

        image_urls.append(url)

    return image_urls


async def chat_image_generation_handler(
    request: Request, form_data: dict, extra_params: dict, user
):
    metadata = extra_params.get("__metadata__", {})
    chat_id = metadata.get("chat_id", None)
    __event_emitter__ = extra_params.get("__event_emitter__", None)

    if not chat_id or not isinstance(chat_id, str) or not __event_emitter__:
        return form_data

    if chat_id.startswith("local:"):
        message_list = form_data.get("messages", [])
    else:
        chat = Chats.get_chat_by_id_and_user_id(chat_id, user.id)
        await __event_emitter__(
            {
                "type": "status",
                "data": {"description": "Creating image", "done": False},
            }
        )

        messages_map = chat.chat.get("history", {}).get("messages", {})
        message_id = chat.chat.get("history", {}).get("currentId")
        message_list = get_message_list(messages_map, message_id)

    user_message = get_last_user_message(message_list)

    prompt = user_message
    message_images = get_images_from_messages(message_list)

    # Limit to first 2 sets of images
    # We may want to change this in the future to allow more images
    input_images = []
    for idx, images in enumerate(message_images):
        if idx >= 2:
            break
        for image in images:
            input_images.append(image)

    system_message_content = ""

    if len(input_images) > 0 and request.app.state.config.ENABLE_IMAGE_EDIT:
        # Edit image(s)
        try:
            images = await image_edits(
                request=request,
                form_data=EditImageForm(**{"prompt": prompt, "image": input_images}),
                metadata={
                    "chat_id": metadata.get("chat_id", None),
                    "message_id": metadata.get("message_id", None),
                },
                user=user,
            )

            await __event_emitter__(
                {
                    "type": "status",
                    "data": {"description": "Image created", "done": True},
                }
            )

            await __event_emitter__(
                {
                    "type": "files",
                    "data": {
                        "files": [
                            {
                                "type": "image",
                                "url": image["url"],
                            }
                            for image in images
                        ]
                    },
                }
            )

            system_message_content = "<context>The requested image has been edited and created and is now being shown to the user. Let them know that it has been generated.</context>"
        except Exception as e:
            log.debug(e)

            error_message = ""
            if isinstance(e, HTTPException):
                if e.detail and isinstance(e.detail, dict):
                    error_message = e.detail.get("message", str(e.detail))
                else:
                    error_message = str(e.detail)

            await __event_emitter__(
                {
                    "type": "status",
                    "data": {
                        "description": f"An error occurred while generating an image",
                        "done": True,
                    },
                }
            )

            system_message_content = f"<context>Image generation was attempted but failed. The system is currently unable to generate the image. Tell the user that the following error occurred: {error_message}</context>"

    else:
        # Create image(s)
        if request.app.state.config.ENABLE_IMAGE_PROMPT_GENERATION:
            try:
                res = await generate_image_prompt(
                    request,
                    {
                        "model": form_data["model"],
                        "messages": form_data["messages"],
                    },
                    user,
                )

                response = res["choices"][0]["message"]["content"]

                try:
                    bracket_start = response.find("{")
                    bracket_end = response.rfind("}") + 1

                    if bracket_start == -1 or bracket_end == -1:
                        raise Exception("No JSON object found in the response")

                    response = response[bracket_start:bracket_end]
                    response = json.loads(response)
                    prompt = response.get("prompt", [])
                except Exception as e:
                    prompt = user_message

            except Exception as e:
                log.exception(e)
                prompt = user_message

        try:
            images = await image_generations(
                request=request,
                form_data=CreateImageForm(**{"prompt": prompt}),
                metadata={
                    "chat_id": metadata.get("chat_id", None),
                    "message_id": metadata.get("message_id", None),
                },
                user=user,
            )

            await __event_emitter__(
                {
                    "type": "status",
                    "data": {"description": "Image created", "done": True},
                }
            )

            await __event_emitter__(
                {
                    "type": "files",
                    "data": {
                        "files": [
                            {
                                "type": "image",
                                "url": image["url"],
                            }
                            for image in images
                        ]
                    },
                }
            )

            system_message_content = "<context>The requested image has been created by the system successfully and is now being shown to the user. Let the user know that the image they requested has been generated and is now shown in the chat.</context>"
        except Exception as e:
            log.debug(e)

            error_message = ""
            if isinstance(e, HTTPException):
                if e.detail and isinstance(e.detail, dict):
                    error_message = e.detail.get("message", str(e.detail))
                else:
                    error_message = str(e.detail)

            await __event_emitter__(
                {
                    "type": "status",
                    "data": {
                        "description": f"An error occurred while generating an image",
                        "done": True,
                    },
                }
            )

            system_message_content = f"<context>Image generation was attempted but failed because of an error. The system is currently unable to generate the image. Tell the user that the following error occurred: {error_message}</context>"

    if system_message_content:
        form_data["messages"] = add_or_update_system_message(
            system_message_content, form_data["messages"]
        )

    return form_data


async def chat_completion_files_handler(
    request: Request, body: dict, extra_params: dict, user: UserModel
) -> tuple[dict, dict[str, list]]:
    """
    Handle file attachments for chat completion requests.

    PORTICO PATCH: When BYPASS_EMBEDDING_AND_RETRIEVAL is enabled, this function
    skips all RAG processing and returns early with empty sources.
    Files are still accessible to the LLM via direct content (full context mode).
    """
    __event_emitter__ = extra_params["__event_emitter__"]
    sources = []

    # PORTICO PATCH: Skip RAG file context injection when BYPASS_EMBEDDING_AND_RETRIEVAL is enabled
    # This prevents the "Respond to the user query using the provided context" citation prompt
    # from being injected into the user's message when files are uploaded.
    if request.app.state.config.BYPASS_EMBEDDING_AND_RETRIEVAL:
        log.info("[RAG] BYPASS_EMBEDDING_AND_RETRIEVAL=True - skipping RAG processing")
        return body, {"sources": []}

    _, _, get_sources_from_items = _load_retrieval_helpers()

    if files := body.get("metadata", {}).get("files", None):
        # Check if all files are in full context mode
        all_full_context = all(item.get("context") == "full" for item in files)

        queries = []
        if not all_full_context:
            try:
                queries_response = await generate_queries(
                    request,
                    {
                        "model": body["model"],
                        "messages": body["messages"],
                        "type": "retrieval",
                    },
                    user,
                )
                queries_response = queries_response["choices"][0]["message"]["content"]

                try:
                    bracket_start = queries_response.find("{")
                    bracket_end = queries_response.rfind("}") + 1

                    if bracket_start == -1 or bracket_end == -1:
                        raise Exception("No JSON object found in the response")

                    queries_response = queries_response[bracket_start:bracket_end]
                    queries_response = json.loads(queries_response)
                except Exception as e:
                    queries_response = {"queries": [queries_response]}

                queries = queries_response.get("queries", [])
            except:
                pass

            await __event_emitter__(
                {
                    "type": "status",
                    "data": {
                        "action": "queries_generated",
                        "queries": queries,
                        "done": False,
                    },
                }
            )

        if len(queries) == 0:
            fallback_query = get_last_user_message(body["messages"])
            fallback_query = (
                fallback_query.strip()
                if isinstance(fallback_query, str)
                else ""
            )

            if fallback_query:
                queries = [fallback_query]
            else:
                file_name_queries = []
                for file_item in files:
                    if not isinstance(file_item, dict):
                        continue

                    file_name = (file_item.get("name") or "").strip()
                    if file_name:
                        file_name_queries.append(f'contents of "{file_name}"')

                queries = (
                    file_name_queries[:3]
                    if file_name_queries
                    else ["uploaded file context"]
                )

        try:
            # Directly await async get_sources_from_items (no thread needed - fully async now)
            sources = await get_sources_from_items(
                request=request,
                items=files,
                queries=queries,
                embedding_function=lambda query,
                prefix: request.app.state.EMBEDDING_FUNCTION(
                    query, prefix=prefix, user=user
                ),
                k=request.app.state.config.TOP_K,
                reranking_function=(
                    (
                        lambda query, documents: request.app.state.RERANKING_FUNCTION(
                            query, documents, user=user
                        )
                    )
                    if request.app.state.RERANKING_FUNCTION
                    else None
                ),
                k_reranker=request.app.state.config.TOP_K_RERANKER,
                r=request.app.state.config.RELEVANCE_THRESHOLD,
                hybrid_bm25_weight=request.app.state.config.HYBRID_BM25_WEIGHT,
                hybrid_search=request.app.state.config.ENABLE_RAG_HYBRID_SEARCH,
                full_context=all_full_context
                or request.app.state.config.RAG_FULL_CONTEXT,
                user=user,
            )
        except Exception as e:
            log.exception(e)

        log.debug(f"rag_contexts:sources: {sources}")

        unique_ids = set()
        for source in sources or []:
            if not source or len(source.keys()) == 0:
                continue

            documents = source.get("document") or []
            metadatas = source.get("metadata") or []
            src_info = source.get("source") or {}

            for index, _ in enumerate(documents):
                metadata = metadatas[index] if index < len(metadatas) else None
                _id = (
                    (metadata or {}).get("source")
                    or (src_info or {}).get("id")
                    or "N/A"
                )
                unique_ids.add(_id)

        sources_count = len(unique_ids)
        await __event_emitter__(
            {
                "type": "status",
                "data": {
                    "action": "sources_retrieved",
                    "count": sources_count,
                    "done": True,
                },
            }
        )

    return body, {"sources": sources}


def apply_params_to_form_data(form_data, model):
    params = form_data.pop("params", {})
    custom_params = params.pop("custom_params", {})

    open_webui_params = {
        "stream_response": bool,
        "stream_delta_chunk_size": int,
        "function_calling": str,
        "reasoning_tags": list,
        "system": str,
    }

    for key in list(params.keys()):
        if key in open_webui_params:
            del params[key]

    if custom_params:
        # Attempt to parse custom_params if they are strings
        for key, value in custom_params.items():
            if isinstance(value, str):
                try:
                    # Attempt to parse the string as JSON
                    custom_params[key] = json.loads(value)
                except json.JSONDecodeError:
                    # If it fails, keep the original string
                    pass

        # If custom_params are provided, merge them into params
        params = deep_update(params, custom_params)

    if model.get("owned_by") == "ollama":
        # Ollama specific parameters
        form_data["options"] = params
    else:
        if isinstance(params, dict):
            for key, value in params.items():
                if value is not None:
                    form_data[key] = value

        if "logit_bias" in params and params["logit_bias"] is not None:
            try:
                logit_bias = convert_logit_bias_input_to_json(params["logit_bias"])

                if logit_bias:
                    form_data["logit_bias"] = json.loads(logit_bias)
            except Exception as e:
                log.exception(f"Error parsing logit_bias: {e}")

    return form_data


def reconstruct_anthropic_format(messages, *, chat_id: str | None = None):
    """
    Reconstruct proper Anthropic/OpenAI message format from stored contentBlocks.

    Open WebUI stores messages with contentBlocks (structured) alongside serialized
    content (HTML for UI display). This function reconstructs the proper API format
    from contentBlocks when available.

    Args:
        messages: List of message dicts from frontend (may have contentBlocks field)

    Returns:
        List of properly formatted messages for LLM API (with tool_calls, tool results, etc.)
    """
    log.info(
        f"[DEBUGGING_TOOLS] ========== RECONSTRUCTION START: Processing {len(messages) if messages else 0} messages =========="
    )

    if not messages:
        log.warning(
            "[DEBUGGING_TOOLS] reconstruct_anthropic_format: No messages provided"
        )
        return messages

    reconstructed = []

    for idx, msg in enumerate(messages):
        role = msg.get("role", "unknown")
        has_content_blocks = "contentBlocks" in msg
        content_type = type(msg.get("content")).__name__

        log.info(
            f"[DEBUGGING_TOOLS] Message {idx}: role={role}, has_contentBlocks={has_content_blocks}, content_type={content_type}"
        )

        if has_content_blocks:
            log.info(
                f"[DEBUGGING_TOOLS]   → contentBlocks found: {len(msg['contentBlocks'])} blocks"
            )
            for block_idx, block in enumerate(msg["contentBlocks"]):
                log.info(
                    f"[DEBUGGING_TOOLS]     Block {block_idx}: type={block.get('type', 'unknown')}"
                )

        # Non-assistant messages pass through unchanged
        if role != "assistant":
            reconstructed.append(msg)
            log.debug(
                f"[DEBUGGING_TOOLS]   → Passing through unchanged (non-assistant)"
            )
            continue

        # If message has contentBlocks, use those to reconstruct proper format
        if "contentBlocks" in msg and msg["contentBlocks"]:
            log.info(
                f"[DEBUGGING_TOOLS]   → RECONSTRUCTING from {len(msg['contentBlocks'])} content blocks"
            )

            # Inline conversion logic (same as nested convert_content_blocks_to_messages)
            # This function isn't accessible from module level, so we implement it here
            converted_messages = []
            temp_text_parts = []

            for block_idx, block in enumerate(msg["contentBlocks"]):
                block_type = block.get("type", "unknown")

                if block_type == "tool_calls":
                    text_content = _serialize_replay_text_blocks(temp_text_parts)
                    replay_block = _partition_tool_call_block_for_replay(block)
                    matched_tool_calls = replay_block["matched_tool_calls"]
                    matched_results = replay_block["matched_results"]
                    unmatched_tool_call_ids = replay_block["unmatched_tool_call_ids"]
                    orphaned_result_ids = replay_block["orphaned_result_ids"]

                    if matched_tool_calls:
                        converted_messages.append(
                            {
                                "role": "assistant",
                                "content": text_content,
                                "tool_calls": matched_tool_calls,
                            }
                        )
                        log.info(
                            "[DEBUGGING_TOOLS]     Created assistant msg with %d replay-safe tool_calls (dropped %d unmatched)",
                            len(matched_tool_calls),
                            len(unmatched_tool_call_ids),
                        )
                        for result in matched_results:
                            tool_name = _tool_name_for_call_id(
                                matched_tool_calls,
                                result.get("tool_call_id", ""),
                            )
                            converted_messages.append(
                                {
                                    "role": "tool",
                                    "tool_call_id": result.get("tool_call_id", ""),
                                    "content": _tool_result_content_for_model_replay(
                                        result,
                                        tool_function_name=tool_name,
                                    ),
                                }
                            )
                            log.info(
                                f"[DEBUGGING_TOOLS]     Created tool result for call_id={result.get('tool_call_id', '')[:20]}..."
                            )
                    elif text_content:
                        converted_messages.append(
                            {
                                "role": "assistant",
                                "content": text_content,
                            }
                        )
                        log.info(
                            "[DEBUGGING_TOOLS]     Created assistant msg with %d chars before skipped tool block",
                            len(text_content),
                        )

                    dropped_tool_call_ids = [
                        tool_call_id
                        for tool_call_id in unmatched_tool_call_ids
                        if tool_call_id
                    ]
                    if dropped_tool_call_ids:
                        log.warning(
                            "[DEBUGGING_TOOLS]     Dropping %d unmatched tool_calls from replay chat_id=%s message_idx=%s block_idx=%s ids=%s",
                            len(dropped_tool_call_ids),
                            chat_id,
                            idx,
                            block_idx,
                            dropped_tool_call_ids,
                        )
                    if orphaned_result_ids:
                        log.warning(
                            "[DEBUGGING_TOOLS]     Ignoring %d orphaned tool results during replay chat_id=%s message_idx=%s block_idx=%s ids=%s",
                            len(orphaned_result_ids),
                            chat_id,
                            idx,
                            block_idx,
                            orphaned_result_ids,
                        )

                    temp_text_parts = []  # Reset for any trailing content
                else:
                    temp_text_parts.append(block)

            # Handle any remaining text blocks after the last tool_calls
            if temp_text_parts:
                text_content = _serialize_replay_text_blocks(temp_text_parts)
                if text_content:
                    converted_messages.append(
                        {
                            "role": "assistant",
                            "content": text_content,
                        }
                    )
                    log.info(
                        f"[DEBUGGING_TOOLS]     Created trailing assistant msg with {len(text_content)} chars"
                    )

            log.info(
                f"[DEBUGGING_TOOLS]   → Converted into {len(converted_messages)} messages:"
            )
            for conv_idx, conv_msg in enumerate(converted_messages):
                conv_role = conv_msg.get("role", "unknown")
                has_tool_calls = "tool_calls" in conv_msg
                log.info(
                    f"[DEBUGGING_TOOLS]     Result {conv_idx}: role={conv_role}, has_tool_calls={has_tool_calls}"
                )

            reconstructed.extend(converted_messages)
        else:
            # No contentBlocks available - use message as-is (backwards compatibility)
            log.warning(
                f"[DEBUGGING_TOOLS]   → NO contentBlocks found - using message as-is (may be flattened!)"
            )
            # Legacy/flattened assistant history can still carry literal
            # think-tag sections (e.g. chats stored before inline capture
            # worked); scrub them so models don't imitate the pattern.
            content = msg.get("content")
            if isinstance(content, str) and content:
                cleaned_content = _remove_complete_inline_reasoning_sections(content)
                if cleaned_content != content:
                    msg = {**msg, "content": cleaned_content}
            reconstructed.append(msg)

    log.info(
        f"[DEBUGGING_TOOLS] ========== RECONSTRUCTION COMPLETE: {len(messages)} input → {len(reconstructed)} output =========="
    )
    return reconstructed


def _build_file_only_user_prompt(files: list[dict]) -> str:
    """Create a provider-safe user prompt when files are uploaded without text."""
    file_names = []
    seen = set()

    for file_item in files or []:
        if not isinstance(file_item, dict):
            continue

        name = (file_item.get("name") or "").strip()
        if not name or name in seen:
            continue

        seen.add(name)
        file_names.append(name)

    if file_names:
        preview_names = file_names[:5]
        rendered_names = ", ".join(f'"{name}"' for name in preview_names)
        suffix = ", and additional files" if len(file_names) > len(preview_names) else ""
        return (
            "The user uploaded file(s) without additional text: "
            f"{rendered_names}{suffix}. "
            "The uploaded files are available in the chat workspace root. "
            "Acknowledge the upload and ask what the user wants to do with these files."
        )

    return (
        "The user uploaded file(s) without additional text. "
        "The uploaded files are available in the chat workspace root. "
        "Acknowledge the upload and ask what the user wants to do with these files."
    )


def _set_last_user_message_content(messages: list[dict], content: str) -> bool:
    """Replace the latest user message text while preserving non-text blocks."""
    for message in reversed(messages or []):
        if message.get("role") != "user":
            continue

        current_content = message.get("content")
        if isinstance(current_content, list):
            for block in current_content:
                if block.get("type") == "text":
                    block["text"] = content
                    return True

            current_content.insert(0, {"type": "text", "text": content})
            return True

        message["content"] = content
        return True

    return False


def _strict_string(
    value, field_name: str, max_len: int, required: bool = False
) -> str | None:
    """Strictly validate string fields - reject None, non-strings, and over-length values."""
    if value is None:
        if required:
            raise ValueError(f"{field_name} is required")
        return None
    if not isinstance(value, str):
        raise ValueError(f"{field_name} must be a string, got {type(value).__name__}")
    result = value.strip()
    if required and not result:
        raise ValueError(f"{field_name} is required and cannot be empty")
    if len(result) > max_len:
        raise ValueError(f"{field_name} exceeds max length of {max_len} characters")
    return result if result else None


def _strict_bool(value, field_name: str, default: bool) -> bool:
    """Strictly parse boolean - accept only bool, reject strings like 'false'."""
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    raise ValueError(f"{field_name} must be a boolean, got {type(value).__name__}")


def find_block_by_tool_call_id(
    content_blocks: list, tool_call_id: str
) -> tuple[int, dict | None]:
    """Find a content block by tool_call_id. Returns (index, block) or (-1, None)."""
    for i, block in enumerate(content_blocks):
        if block.get("tool_call_id") == tool_call_id:
            return i, block
    return -1, None


def _is_workspace_image_url(image_url: str) -> bool:
    return bool(re.match(r"^https?://[^/]+/workspace/", str(image_url or "")))


def _workspace_image_conversion_error(image_url: str, error: Exception) -> HTTPException:
    return HTTPException(
        status_code=400,
        detail=(
            "Unable to fetch workspace image URL for model input. "
            "Visual QA image_urls must be reachable and converted to base64 before dispatch. "
            f"URL: {image_url}. Error: {error}"
        ),
    )


def _sniff_image_media_type(image_bytes: bytes) -> str:
    if image_bytes.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if image_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if image_bytes.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if (
        len(image_bytes) >= 12
        and image_bytes.startswith(b"RIFF")
        and image_bytes[8:12] == b"WEBP"
    ):
        return "image/webp"
    raise ValueError("unsupported image bytes; expected JPEG, PNG, GIF, or WebP")


def _decode_base64_image_data(data: str, field_name: str) -> tuple[str, bytes]:
    compact = re.sub(r"\s+", "", data or "")
    if not compact:
        raise ValueError(f"{field_name} must be a non-empty base64 string")
    if not re.fullmatch(r"[A-Za-z0-9+/=_-]+", compact):
        raise ValueError(f"{field_name} contains invalid base64 data")
    try:
        return compact, base64.b64decode(compact, validate=True)
    except Exception:
        try:
            return compact, base64.urlsafe_b64decode(compact)
        except Exception as error:
            raise ValueError(f"{field_name} contains invalid base64 data") from error


def _normalize_image_data_url_mime(data_url: str) -> str:
    if not isinstance(data_url, str) or not data_url.startswith("data:image/"):
        raise ValueError("image URL conversion did not return a data:image URL")

    try:
        header, data = data_url.split(",", 1)
    except ValueError as error:
        raise ValueError("image data URL must contain base64 data") from error

    if not header.startswith("data:image/"):
        raise ValueError("image data URL must contain an image media type")
    if "base64" not in [part.strip().lower() for part in header.split(";")[1:]]:
        raise ValueError("image data URL must use base64 image data")

    compact, image_bytes = _decode_base64_image_data(data, "image data URL")
    if not image_bytes:
        raise ValueError("image data URL decoded to empty bytes")

    media_type = _sniff_image_media_type(image_bytes)
    return f"data:{media_type};base64,{compact}"


async def convert_url_images_to_base64(form_data):
    messages = form_data.get("messages", [])

    for message in messages:
        content = message.get("content")
        if not isinstance(content, list):
            continue

        new_content = []

        for item in content:
            if not isinstance(item, dict) or item.get("type") != "image_url":
                new_content.append(item)
                continue

            image_url = item.get("image_url", {}).get("url", "")
            if image_url.startswith("data:image/"):
                new_content.append(item)
                continue

            is_workspace_image = _is_workspace_image_url(image_url)
            try:
                base64_data = await asyncio.to_thread(
                    get_image_base64_from_url, image_url
                )
                if not isinstance(base64_data, str) or not base64_data.startswith(
                    "data:image/"
                ):
                    raise ValueError("image URL conversion did not return a data:image URL")
                base64_data = _normalize_image_data_url_mime(base64_data)
                new_content.append(
                    {
                        "type": "image_url",
                        "image_url": {"url": base64_data},
                    }
                )
            except Exception as e:
                if is_workspace_image:
                    # Workspace files are ephemeral — reviewer workflows
                    # replace renders between rounds, but the image_url rides
                    # persisted history (user-message files) forever. Aborting
                    # the turn here wedges the chat permanently (every future
                    # reconstruction replays the dead URL). Degrade to a text
                    # notice so the model knows the file is gone and can
                    # re-request the current renders.
                    log.warning(
                        "[VISUAL-QA] Workspace image no longer fetchable; replacing with text notice url=%s error=%s",
                        image_url,
                        e,
                    )
                    image_name = image_url.rsplit("/", 1)[-1].split("?")[0]
                    new_content.append(
                        {
                            "type": "text",
                            "text": (
                                f"[workspace image no longer available: {image_name} — "
                                "it was likely replaced by a newer render; request "
                                "current files via agent_vm_request_images if needed]"
                            ),
                        }
                    )
                    continue
                log.debug(f"Error converting image URL to base64: {e}")
                new_content.append(item)

        message["content"] = new_content

    return form_data


def _inject_batch_resolution_note(form_data: dict, gate, chat_id: str) -> None:
    """Build and inject a hidden system message describing the per-chip
    resolutions the user just submitted as a batch.

    The renderer fires ONE chat completion after the user has resolved all
    pending chips (approve / cancel / modify). The model needs to know the
    outcome of each chip so it can:

    * RE-EMIT the approved tool calls (gate's ``_approved`` cache will
      then dispatch them through ``evaluate_tool_call``),
    * STOP retrying the cancelled ones,
    * RE-ISSUE the modified ones with the user's free-text adjustments
      reflected in the new args (which produces a fresh chip if the new
      args still classify as destructive).

    The note is added as a ``system`` message at the END of the messages
    list, immediately before the model runs. We use ``system`` rather
    than ``user`` so the conversation history shows only the user's
    actual click (not a synthetic block of explanatory text).

    The note is also bracketed with a sentinel header so any future
    auditor or replay tool can find and elide these synthesized blocks
    when reconstructing the user's verbatim history.
    """

    records = gate.pop_resolutions_for_batch(chat_id)
    if not records:
        return

    def _format_args(args: Any) -> str:
        """Serialize args to a compact, deterministic JSON string so the
        model sees exactly what the gate hashed. ``sort_keys=True`` matches
        ``_call_hash``'s canonicalization, so a verbatim copy will collide
        with ``_approved`` hash on dispatch."""
        try:
            return json.dumps(args, sort_keys=True, separators=(", ", ": "))
        except (TypeError, ValueError):
            return repr(args)

    lines = [
        "[PORTICO-PORTICO-N-012-BATCH-RESOLUTION-START]",
        "User has just resolved the following pending tool confirmation(s).",
        "Treat this as the user's per-action consent: act on each line below "
        "and do not re-prompt for confirmation on already-resolved hashes.",
        "",
        "CRITICAL: For APPROVED entries, re-emit the tool call with arguments "
        "BYTE-FOR-BYTE identical to the JSON shown below — the approval is "
        "hash-bound, and any difference (key order, whitespace, default "
        "values, type coercions) produces a NEW hash and a fresh "
        "confirmation chip. Copy the JSON literally.",
        "",
    ]
    for idx, rec in enumerate(records, start=1):
        # Phase 1 / Phase 3: clarification chips that came from the
        # out-of-scope scheduled-run path carry option_ids prefixed
        # ``out_of_scope_*`` and need different post-resolution work
        # than the regular approve / cancel / modify flow.
        if rec.kind == "clarification" and rec.context.get("out_of_scope"):
            # Round 4 / Issue 3b — when the user picks WIDEN-SCOPE,
            # the middleware itself persists the wider scope via the
            # scheduling MCP HTTP surface. The model only needs to
            # re-emit the original tool call afterwards. Without this,
            # sub-agents whose registry doesn't include
            # ``scheduling_update_task`` would dead-end with a
            # confessional "I don't have that tool available" message
            # and the user's "approve + widen" choice would silently
            # collapse to "approve once".
            widen_actuation_result: Optional[dict[str, Any]] = None
            option_id = (
                rec.option_id or rec.effective_option_id or ""
            ).strip()
            if option_id == _OUT_OF_SCOPE_OPTION_WIDEN_SCOPE:
                ctx_for_widen = rec.context or {}
                task_id_for_widen = ctx_for_widen.get("task_id") or ""
                tool_server_id_to_add = (
                    ctx_for_widen.get("tool_server_id_guess")
                    or ctx_for_widen.get("tool_mcp")
                    or ""
                )
                if task_id_for_widen and tool_server_id_to_add:
                    try:
                        widen_actuation_result = (
                            _widen_scheduled_task_scope_via_mcpo(
                                task_id=task_id_for_widen,
                                tool_server_id_to_add=tool_server_id_to_add,
                                mcpo_base_url=MCPO_CORE_PROXY_BASE_URL,
                            )
                        )
                    except Exception:  # noqa: BLE001
                        log.exception(
                            "[scheduled-run-scope] widen actuation raised"
                        )
                        widen_actuation_result = None
            line = _format_out_of_scope_resolution_line(
                idx=idx,
                record=rec,
                gate=gate,
                chat_id=chat_id,
                widen_actuation_result=widen_actuation_result,
            )
            if line is not None:
                lines.append(line)
            continue

        if rec.decision == "approve":
            args_blob = _format_args(rec.args)
            lines.append(
                f"{idx}. APPROVED — re-emit `{rec.tool_name}` with EXACTLY "
                f"these arguments: {args_blob}"
            )
        elif rec.decision == "cancel":
            lines.append(
                f"{idx}. CANCELLED — do NOT re-emit `{rec.tool_name}`. "
                f"Acknowledge the cancellation in plain text and offer a "
                f"different next step if appropriate. Do not silently retry."
            )
        elif rec.decision == "modify":
            payload = (rec.modify_payload or "").strip() or "(no payload provided)"
            args_blob = _format_args(rec.args)
            lines.append(
                f"{idx}. MODIFY — the user wants `{rec.tool_name}` re-issued "
                f"with adjustments. Original args: {args_blob}. User's "
                f"requested changes: {payload!r}. Re-issue with the "
                f"adjustments incorporated; the new args will surface a "
                f"fresh chip for the user to approve."
            )
        else:
            # Defensive: unknown decision. Skip rather than block — the
            # resolver should never produce one of these.
            log.warning(
                "[tool-confirmation-gate] batch resolution record has "
                "unexpected decision=%r for hash=%s tool=%s",
                rec.decision,
                rec.call_hash,
                rec.tool_name,
            )
            continue
    lines.append("[PORTICO-PORTICO-N-012-BATCH-RESOLUTION-END]")

    note = "\n".join(lines)
    messages = form_data.get("messages")
    if not isinstance(messages, list):
        messages = []
        form_data["messages"] = messages
    messages.append({"role": "system", "content": note})


def _resolve_pending_tool_confirmations(form_data: dict, metadata: dict) -> None:
    """Bridge between the user's latest input and the tool-confirmation gate.
    Threat-model item N-012.

    Two input shapes can arrive on a chat-completion turn:

    1. **Batch-send turn** (``form_data.tool_confirmation_batch_send: true``).
       The renderer accumulated per-chip decisions through the REST
       endpoint ``POST /api/v1/utils/chip/resolve`` and is
       firing ONE chat completion to let the model react to the whole
       batch. We drain ``Gate.pop_resolutions_for_batch`` and inject a
       hidden ``system`` note describing each chip's outcome (approved
       hashes to re-emit, cancellations to acknowledge, modify payloads
       to re-issue with adjusted args). Approved hashes already live in
       ``_approved`` from the chip-click REST calls; the model's
       re-emit dispatches through ``evaluate_tool_call`` as usual. We
       intentionally skip ``consume_assistant_turn`` AND
       ``consume_user_turn`` on this path — wiping ``_approved`` would
       erase the approvals the user just made, and there are no
       pending entries left to TTL-drop.

    2. **Plain user message** (no batch flag). The gate's
       natural-language resolver runs against the user's text. A bare
       "yes" with multiple pendings is still ambiguous and drops
       everything (preserves the original Slack-incident invariant);
       the post-resolve ``consume_user_turn`` enforces TTL=1 so an old
       proposal can never authorize a future tool call. Stale
       approvals from the prior assistant turn are cleared via
       ``consume_assistant_turn`` BEFORE the resolver runs so a
       single-pending "yes" can register a fresh approval safely.

    No-op when there is nothing to do for this chat — but we still
    call ``consume_assistant_turn`` for stale-approval cleanup on the
    natural-language path.
    """

    chat_id = metadata.get("chat_id") or ""
    if not chat_id:
        return

    # PORTICO PATCH: feature toggle. When ``tool_confirmation_gate`` is
    # disabled, drop any stray ``tool_confirmation_batch_send`` flag the
    # frontend may have sent (so it never leaks into the upstream
    # payload) and bail without touching the gate.
    if not _optimization_flag_enabled("tool_confirmation_gate", default=True):
        form_data.pop("tool_confirmation_batch_send", None)
        return

    batch_send = bool(form_data.pop("tool_confirmation_batch_send", False))

    gate = default_tool_confirmation_gate()

    if batch_send:
        # Chip-click REST calls already registered ``_approved`` hashes
        # for this batch. Calling ``consume_assistant_turn`` here would
        # erase them (the bug that surfaced as "approved + expired in
        # the same millisecond"). Skip it and let the model's re-emit
        # consume the approvals on this turn.
        _inject_batch_resolution_note(form_data, gate, chat_id)
        log.info(
            "[tool-confirmation-gate] resolved user turn chat_id=%s decision=batch_send "
            "via=ui_click_batch pending_remaining=%d",
            chat_id,
            len(gate.pending_for_chat(chat_id)),
        )
        return

    # Natural-language path: stale-approval cleanup first so a fresh
    # "yes" can land a new approval without being wiped (ordering bug
    # we hit when these were swapped — chip approve audited
    # "approved" and "expired" at the same timestamp, and the model's
    # retry re-blocked).
    gate.consume_assistant_turn(chat_id)

    if not gate.has_pending(chat_id):
        return

    messages = form_data.get("messages") or []
    last_user_text = ""
    for message in reversed(messages):
        if isinstance(message, dict) and message.get("role") == "user":
            content = message.get("content")
            if isinstance(content, str):
                last_user_text = content
                break
            if isinstance(content, list):
                parts = []
                for piece in content:
                    if isinstance(piece, dict) and piece.get("type") == "text":
                        parts.append(str(piece.get("text", "")))
                last_user_text = "\n".join(parts)
                break

    try:
        outcome = gate.resolve_user_reply(
            chat_id=chat_id,
            user_text=last_user_text,
        )
    except Exception:  # noqa: BLE001 - resolver must never break chat
        log.exception("[tool-confirmation-gate] resolve_user_reply raised")
        outcome = None

    # Natural-language path: TTL=1 turn invariant — every pending entry
    # that did not turn into an explicit approval is dropped here.
    gate.consume_user_turn(chat_id)

    if outcome is not None:
        log.info(
            "[tool-confirmation-gate] resolved user turn chat_id=%s decision=%s "
            "via=natural_language pending_remaining=%d",
            chat_id,
            outcome.decision,
            len(gate.pending_for_chat(chat_id)),
        )


async def process_chat_payload(request, form_data, user, metadata, model):
    # Pipeline Inlet -> Filter Inlet -> Chat Memory -> Chat Web Search -> Chat Image Generation
    # -> Chat Code Interpreter (Form Data Update) -> (Default) Chat Tools Function Calling
    # -> Chat Files
    _resolve_pending_tool_confirmations(form_data, metadata)
    try:
        inject_tool_action_policy_into_form_data(form_data)
    except Exception:  # noqa: BLE001 - prompt injection must never break chat
        log.exception("[tool-confirmation-gate] inject_tool_action_policy failed")


    # CRITICAL: Reconstruct proper Anthropic format from contentBlocks FIRST
    # This preserves reasoning, tool calls, and tool results in proper structure
    # for Phoenix observability and LLM context
    function_calling_mode = metadata.get("params", {}).get(
        "function_calling", "default"
    )
    incoming_summary = _message_role_summary(form_data.get("messages", []))
    log.info(
        "[DEBUGGING_TOOLS] Incoming request messages=%d function_calling=%s user_msgs=%d system_msgs=%d assistant_msgs=%d tool_msgs=%d content_block_msgs=%d assistant_tool_call_msgs=%d",
        incoming_summary["messages"],
        function_calling_mode,
        incoming_summary["user"],
        incoming_summary["system"],
        incoming_summary["assistant"],
        incoming_summary["tool"],
        incoming_summary["content_block_messages"],
        incoming_summary["assistant_tool_call_messages"],
    )

    if "messages" in form_data and form_data["messages"]:
        try:
            original_message_count = len(form_data["messages"])
            log.info(
                f"[DEBUGGING_TOOLS] 🔄 CALLING reconstruct_anthropic_format with {original_message_count} messages"
            )

            form_data["messages"] = reconstruct_anthropic_format(
                form_data["messages"],
                chat_id=metadata.get("chat_id"),
            )
            new_message_count = len(form_data["messages"])

            if new_message_count != original_message_count:
                log.info(
                    f"[DEBUGGING_TOOLS] ✅ Message reconstruction: {original_message_count} messages → {new_message_count} messages (expanded {new_message_count - original_message_count} from contentBlocks)"
                )
            else:
                log.info(
                    f"[DEBUGGING_TOOLS] ⚠️ No reconstruction occurred - message count unchanged ({original_message_count})"
                )
                log.info(
                    f"[DEBUGGING_TOOLS]    This likely means NO contentBlocks were found in assistant messages!"
                )
        except Exception as e:
            log.error(
                f"[DEBUGGING_TOOLS] ❌ Error reconstructing Anthropic format from contentBlocks: {e}"
            )
            import traceback

            log.error(f"[DEBUGGING_TOOLS] {traceback.format_exc()}")
            # Continue with original messages if reconstruction fails

    form_data = apply_params_to_form_data(form_data, model)

    # PORTICO PATCH: Add stream_options to include usage data in streaming responses
    # This enables token counting in the frontend by requesting usage stats with each stream chunk
    if form_data.get("stream", False):
        if "stream_options" not in form_data:
            form_data["stream_options"] = {}
        form_data["stream_options"]["include_usage"] = True
        log.info(
            f"[TOKEN_COUNTER] Added stream_options.include_usage=true for token counting"
        )

    prepared_summary = _message_role_summary(form_data.get("messages", []))
    log.debug(
        "[DEBUGGING_TOOLS] Prepared request model=%s stream=%s messages=%d files=%d tools=%d metadata_keys=%d",
        form_data.get("model"),
        bool(form_data.get("stream", False)),
        prepared_summary["messages"],
        len(form_data.get("files") or []),
        len(form_data.get("tools") or []),
        len(metadata.keys()) if isinstance(metadata, dict) else 0,
    )

    system_message = get_system_message(form_data.get("messages", []))
    if system_message:  # Chat Controls/User Settings
        try:
            form_data = apply_system_prompt_to_body(
                system_message.get("content"), form_data, metadata, user, replace=True
            )  # Required to handle system prompt variables
        except:
            pass

    form_data = await convert_url_images_to_base64(form_data)

    event_emitter = get_event_emitter(metadata)
    event_caller = get_event_call(metadata)

    oauth_token = None
    try:
        if request.cookies.get("oauth_session_id", None):
            oauth_token = await request.app.state.oauth_manager.get_oauth_token(
                user.id,
                request.cookies.get("oauth_session_id", None),
            )
    except Exception as e:
        log.error(f"Error getting OAuth token: {e}")

    extra_params = {
        "__event_emitter__": event_emitter,
        "__event_call__": event_caller,
        "__user__": user.model_dump() if isinstance(user, UserModel) else {},
        "__metadata__": metadata,
        "__oauth_token__": oauth_token,
        "__request__": request,
        "__model__": model,
    }
    # Initialize events to store additional event to be sent to the client
    # Initialize contexts and citation
    if getattr(request.state, "direct", False) and hasattr(request.state, "model"):
        models = {
            request.state.model["id"]: request.state.model,
        }
    else:
        models = request.app.state.MODELS

    task_model_id = get_task_model_id(
        form_data["model"],
        request.app.state.config.TASK_MODEL,
        request.app.state.config.TASK_MODEL_EXTERNAL,
        models,
    )

    events = []
    sources = []

    # Folder "Project" handling
    # Check if the request has chat_id and is inside of a folder
    chat_id = metadata.get("chat_id", None)
    if chat_id and user:
        chat = Chats.get_chat_by_id_and_user_id(chat_id, user.id)
        if chat and chat.folder_id:
            folder = Folders.get_folder_by_id_and_user_id(chat.folder_id, user.id)

            if folder and folder.data:
                if "system_prompt" in folder.data:
                    form_data = apply_system_prompt_to_body(
                        folder.data["system_prompt"], form_data, metadata, user
                    )
                if "files" in folder.data:
                    form_data["files"] = [
                        *(folder.data.get("files") or []),
                        *(form_data.get("files") or []),
                    ]

    # Model "Knowledge" handling
    user_message = get_last_user_message(form_data["messages"])
    model_knowledge = model.get("info", {}).get("meta", {}).get("knowledge", False)

    if model_knowledge:
        await event_emitter(
            {
                "type": "status",
                "data": {
                    "action": "knowledge_search",
                    "query": user_message,
                    "done": False,
                },
            }
        )

        knowledge_files = []
        for item in model_knowledge:
            if item.get("collection_name"):
                knowledge_files.append(
                    {
                        "id": item.get("collection_name"),
                        "name": item.get("name"),
                        "legacy": True,
                    }
                )
            elif item.get("collection_names"):
                knowledge_files.append(
                    {
                        "name": item.get("name"),
                        "type": "collection",
                        "collection_names": item.get("collection_names"),
                        "legacy": True,
                    }
                )
            else:
                knowledge_files.append(item)

        files = form_data.get("files", [])
        files.extend(knowledge_files)
        form_data["files"] = files

    variables = form_data.pop("variables", None)

    # Process the form_data through the pipeline
    try:
        form_data = await process_pipeline_inlet_filter(
            request, form_data, user, models
        )
    except Exception as e:
        raise e

    try:
        filter_functions = [
            Functions.get_function_by_id(filter_id)
            for filter_id in get_sorted_filter_ids(
                request, model, metadata.get("filter_ids", [])
            )
        ]

        form_data, flags = await process_filter_functions(
            request=request,
            filter_functions=filter_functions,
            filter_type="inlet",
            form_data=form_data,
            extra_params=extra_params,
        )

        # PORTICO PATCH: Debug logging after inlet filters
        system_summary = _system_message_summary(form_data.get("messages", []))
        log.info(
            "[SYSTEM-PROMPT-DEBUG] After inlet filters model=%s system_msgs=%d total_chars=%d with_portico_context=%d",
            form_data.get("model"),
            system_summary["system_messages"],
            system_summary["system_chars"],
            system_summary["system_messages_with_portico_context"],
        )

    except Exception as e:
        raise Exception(f"{e}")

    features = form_data.pop("features", None)
    if features:
        if "voice" in features and features["voice"]:
            if request.app.state.config.VOICE_MODE_PROMPT_TEMPLATE != None:
                if request.app.state.config.VOICE_MODE_PROMPT_TEMPLATE != "":
                    template = request.app.state.config.VOICE_MODE_PROMPT_TEMPLATE
                else:
                    template = DEFAULT_VOICE_MODE_PROMPT_TEMPLATE

                form_data["messages"] = add_or_update_system_message(
                    template,
                    form_data["messages"],
                )

        if "memory" in features and features["memory"]:
            form_data = await chat_memory_handler(
                request, form_data, extra_params, user
            )

        if "web_search" in features and features["web_search"]:
            form_data = await chat_web_search_handler(
                request, form_data, extra_params, user
            )

        if "image_generation" in features and features["image_generation"]:
            form_data = await chat_image_generation_handler(
                request, form_data, extra_params, user
            )

        if "code_interpreter" in features and features["code_interpreter"]:
            form_data["messages"] = add_or_update_user_message(
                (
                    request.app.state.config.CODE_INTERPRETER_PROMPT_TEMPLATE
                    if request.app.state.config.CODE_INTERPRETER_PROMPT_TEMPLATE != ""
                    else DEFAULT_CODE_INTERPRETER_PROMPT
                ),
                form_data["messages"],
            )

    tool_ids = form_data.pop("tool_ids", None)
    files = form_data.pop("files", None)

    if files:
        if not files:
            files = []

        for file_item in files:
            if file_item.get("type", "file") == "folder":
                # Get folder files
                folder_id = file_item.get("id", None)
                if folder_id:
                    folder = Folders.get_folder_by_id_and_user_id(folder_id, user.id)
                    if folder and folder.data and "files" in folder.data:
                        files = [f for f in files if f.get("id", None) != folder_id]
                        files = [*files, *folder.data["files"]]

        # files = [*files, *[{"type": "url", "url": url, "name": url} for url in urls]]
        # Remove duplicate files based on their content
        files = list({json.dumps(f, sort_keys=True): f for f in files}.values())

    prompt = get_last_user_message(form_data["messages"])
    prompt_text = prompt.strip() if isinstance(prompt, str) else ""
    if files and not prompt_text:
        synthetic_prompt = _build_file_only_user_prompt(files)
        if not _set_last_user_message_content(form_data["messages"], synthetic_prompt):
            form_data["messages"].append({"role": "user", "content": synthetic_prompt})
        prompt = synthetic_prompt
        log.info(
            "[FILES] Injected synthetic user prompt for file-only submission to satisfy provider constraints"
        )

    # TODO: re-enable URL extraction from prompt
    # urls = []
    # if prompt and len(prompt or "") < 500 and (not files or len(files) == 0):
    #     urls = extract_urls(prompt)

    tool_ids = await _merge_chat_attached_tool_ids_for_request(
        request=request,
        chat_id=metadata.get("chat_id"),
        existing_tool_ids=tool_ids,
    )

    metadata = {
        **metadata,
        "tool_ids": tool_ids,
        "files": files,
    }
    socket_id = getattr(request, "sid", None)
    if socket_id:
        metadata["socket_id"] = socket_id
    form_data["metadata"] = metadata

    # Server side tools
    tool_ids = metadata.get("tool_ids", None)
    # Client side tools
    direct_tool_servers = metadata.get("tool_servers", None)

    log.debug(f"{tool_ids=}")
    log.debug(f"{direct_tool_servers=}")

    lock_subagent_integrations = False
    if _optimization_flag_enabled("subagent_integration_activation_restriction", True):
        try:
            redis = getattr(request.app.state, "redis", None)
            chat_id = metadata.get("chat_id")
            if redis and chat_id:
                lock_subagent_integrations = bool(
                    await redis.exists(f"subagent_chat:{chat_id}")
                )
        except Exception as exc:
            log.warning(
                "[TOOLS] Failed to resolve delegated subagent scope for tool filtering: %s",
                exc,
            )

    metadata["__subagent_scope_locked"] = lock_subagent_integrations

    tools_dict = {}

    mcp_clients = {}
    mcp_tools_dict = {}

    if tool_ids:
        for tool_id in tool_ids:
            if tool_id.startswith("server:mcp:"):
                try:
                    server_id = tool_id[len("server:mcp:") :]

                    mcp_server_connection = None
                    for (
                        server_connection
                    ) in request.app.state.config.TOOL_SERVER_CONNECTIONS:
                        if (
                            server_connection.get("type", "") == "mcp"
                            and server_connection.get("info", {}).get("id") == server_id
                        ):
                            mcp_server_connection = server_connection
                            break

                    if not mcp_server_connection:
                        log.error(f"MCP server with id {server_id} not found")
                        continue

                    headers = await build_mcp_request_headers(
                        request=request,
                        user=user,
                        server_id=server_id,
                        mcp_server_connection=mcp_server_connection,
                        extra_params=extra_params,
                        metadata=metadata,
                    )

                    mcp_clients[server_id] = MCPClient()
                    await mcp_clients[server_id].connect(
                        url=mcp_server_connection.get("url", ""),
                        headers=headers if headers else None,
                    )

                    function_name_filter_list = mcp_server_connection.get(
                        "config", {}
                    ).get("function_name_filter_list", "")

                    if isinstance(function_name_filter_list, str):
                        function_name_filter_list = function_name_filter_list.split(",")

                    tool_specs = await mcp_clients[server_id].list_tool_specs()
                    rename_mapping = _load_tool_rename_mapping(server_id)
                    for tool_spec in tool_specs:

                        def make_tool_function(function_name):
                            async def tool_function(
                                __metadata__=None,
                                __request__=None,
                                __oauth_token__=None,
                                **kwargs,
                            ):
                                runtime_extra_params = dict(extra_params or {})
                                if __oauth_token__ is not None:
                                    runtime_extra_params["__oauth_token__"] = (
                                        __oauth_token__
                                    )

                                return await call_mcp_tool_with_runtime_headers(
                                    client_factory=MCPClient,
                                    request=__request__ or request,
                                    user=user,
                                    server_id=server_id,
                                    mcp_server_connection=mcp_server_connection,
                                    extra_params=runtime_extra_params,
                                    metadata=__metadata__ or metadata,
                                    function_name=function_name,
                                    function_args=kwargs,
                                )

                            return get_async_tool_function_and_apply_extra_params(
                                tool_function,
                                {
                                    "__metadata__": metadata,
                                    "__request__": request,
                                    "__oauth_token__": extra_params.get(
                                        "__oauth_token__", None
                                    ),
                                },
                            )

                        if function_name_filter_list:
                            if not is_string_allowed(
                                tool_spec["name"], function_name_filter_list
                            ):
                                # Skip this function
                                continue

                        original_name = tool_spec.get("name", "")
                        renamed_name = _get_renamed_tool_name(
                            rename_mapping, original_name
                        )
                        full_name = f"{server_id}_{renamed_name}"
                        if (
                            full_name in mcp_tools_dict
                            and renamed_name != original_name
                        ):
                            log.warning(
                                f"[MCP_FETCH] Renamed tool collision for {server_id}: {full_name}"
                            )
                            renamed_name = original_name
                            full_name = f"{server_id}_{original_name}"

                        tool_function = make_tool_function(original_name)

                        mcp_tools_dict[full_name] = {
                            "spec": {
                                **tool_spec,
                                "name": full_name,
                            },
                            "callable": tool_function,
                            "type": "mcp",
                            "client": mcp_clients[server_id],
                            "server_id": server_id,
                            "original_name": original_name,
                            "mcp_server_connection": mcp_server_connection,
                            "direct": False,
                        }
                except Exception as e:
                    log.debug(e)
                    if event_emitter:
                        await event_emitter(
                            {
                                "type": "chat:message:error",
                                "data": {
                                    "error": {
                                        "content": f"Failed to connect to MCP server '{server_id}'"
                                    }
                                },
                            }
                        )
                    continue

        openapi_tool_ids = [
            tool_id
            for tool_id in _coerce_tool_ids(tool_ids)
            if isinstance(tool_id, str)
            and tool_id.startswith("server:")
            and not tool_id.startswith("server:mcp:")
        ]
        local_tool_ids = [
            tool_id
            for tool_id in _coerce_tool_ids(tool_ids)
            if not (isinstance(tool_id, str) and tool_id.startswith("server:"))
        ]

        if openapi_tool_ids:
            (
                cached_tools,
                _cached_tool_ids,
                _cached_tool_specs,
                unresolved_tool_ids,
            ) = await load_cached_tool_specs_for_ids(
                request=request,
                tool_ids=openapi_tool_ids,
                user=user,
                extra_params=extra_params,
                model=models[task_model_id],
                form_data=form_data,
                metadata=metadata,
            )
            if cached_tools:
                tools_dict.update(cached_tools)
            if unresolved_tool_ids:
                form_data["messages"] = add_or_update_system_message(
                    _build_dynamic_tool_starting_system_message(unresolved_tool_ids),
                    form_data.get("messages", []),
                    append=True,
                )
                log.warning(
                    "[DYNAMIC_TOOLS] Foreground request omitted missing cached tool specs chat_id=%s message_id=%s unresolved_tool_ids=%s",
                    metadata.get("chat_id"),
                    metadata.get("message_id"),
                    unresolved_tool_ids,
                )

        if local_tool_ids:
            local_tools_dict = await get_tools(
                request,
                local_tool_ids,
                user,
                {
                    **extra_params,
                    "__model__": models[task_model_id],
                    "__messages__": form_data["messages"],
                    "__files__": metadata.get("files", []),
                },
            )
            if local_tools_dict:
                tools_dict.update(local_tools_dict)

        tools_dict = await enrich_openapi_server_tools(request, tools_dict)

        if mcp_tools_dict:
            tools_dict = {**tools_dict, **mcp_tools_dict}

    if direct_tool_servers:
        for tool_server in direct_tool_servers:
            tool_specs = tool_server.get("specs", [])
            tool_server_config = {
                key: value for key, value in tool_server.items() if key != "specs"
            }

            for tool in tool_specs:
                tool_name = tool.get("name")
                if not tool_name:
                    continue

                existing_tool = tools_dict.get(tool_name)
                if existing_tool and not existing_tool.get("direct", False):
                    log.info(
                        "[TOOLS] Skipping direct tool '%s' because a non-direct tool is already registered",
                        tool_name,
                    )
                    continue

                if existing_tool and existing_tool.get("direct", False):
                    log.warning(
                        "[TOOLS] Duplicate direct tool '%s' detected; overriding previous entry",
                        tool_name,
                    )

                tools_dict[tool_name] = {
                    "spec": tool,
                    "direct": True,
                    "server": tool_server_config,
                }

    if tool_ids:
        missing_foreground_tool_ids = _missing_tool_ids_from_registry(
            _coerce_tool_ids(tool_ids),
            tools_dict,
        )
        if missing_foreground_tool_ids:
            log.info(
                "[DYNAMIC_TOOLS] Foreground request missing chat-attached tool specs chat_id=%s message_id=%s tool_ids=%s current_registry_count=%d",
                metadata.get("chat_id"),
                metadata.get("message_id"),
                missing_foreground_tool_ids,
                len(tools_dict or {}),
            )
            try:
                (
                    loaded_tools,
                    loaded_tool_ids,
                    loaded_tool_specs,
                    unresolved_tool_ids,
                ) = await _load_pending_tool_specs_after_inlet(
                    request=request,
                    pending_tool_ids=missing_foreground_tool_ids,
                    user=user,
                    extra_params=extra_params,
                    model=models[task_model_id],
                    form_data=form_data,
                    metadata=metadata,
                )

                if loaded_tools:
                    filtered_loaded_tools = _inject_loaded_tool_specs_into_request(
                        form_data=form_data,
                        metadata=metadata,
                        existing_tool_ids=_coerce_tool_ids(tool_ids),
                        loaded_tools=loaded_tools,
                        loaded_tool_ids=loaded_tool_ids,
                        loaded_tool_specs=loaded_tool_specs,
                        request_phase=metadata.get("request_phase") or "foreground",
                    )
                    if filtered_loaded_tools:
                        tools_dict = {**(tools_dict or {}), **filtered_loaded_tools}
                        tool_ids = metadata.get("tool_ids", tool_ids)

                if unresolved_tool_ids:
                    form_data["messages"] = add_or_update_system_message(
                        _build_dynamic_tool_starting_system_message(unresolved_tool_ids),
                        form_data.get("messages", []),
                        append=True,
                    )
                    log.warning(
                        "[DYNAMIC_TOOLS] Foreground request could not load chat-attached tool specs chat_id=%s message_id=%s unresolved_tool_ids=%s",
                        metadata.get("chat_id"),
                        metadata.get("message_id"),
                        unresolved_tool_ids,
                    )
            except Exception as e:
                log.warning(
                    "[DYNAMIC_TOOLS] Foreground request tool spec hydration failed chat_id=%s message_id=%s tool_ids=%s error=%s",
                    metadata.get("chat_id"),
                    metadata.get("message_id"),
                    missing_foreground_tool_ids,
                    e,
                )

    tools_dict, removed_subagent_tools = _filter_subagent_locked_tool_registry(
        tools_dict,
        lock_integrations=lock_subagent_integrations,
    )
    if removed_subagent_tools:
        log.info(
            "[TOOLS] Removed delegated-subagent-locked tools from chat %s: %s",
            metadata.get("chat_id"),
            removed_subagent_tools,
        )

    if mcp_clients:
        metadata["mcp_clients"] = mcp_clients
    if tools_dict:
        metadata["tools"] = tools_dict

    if _ensure_native_tool_payload_for_active_tools(
        form_data=form_data,
        metadata=metadata,
        tools_dict=tools_dict,
    ):
        log.warning(
            "[TOOLS] Forced native function calling for active tools chat_id=%s message_id=%s model=%s tool_count=%d",
            metadata.get("chat_id"),
            metadata.get("message_id"),
            form_data.get("model"),
            len(tools_dict or {}),
        )

    if tools_dict or metadata.get("params", {}).get("function_calling") == "native":
        if tools_dict and metadata.get("params", {}).get("function_calling") != "native":
            metadata.setdefault("params", {})["function_calling"] = "native"
            log.warning(
                "[TOOLS] Forcing native function calling for active tools chat_id=%s message_id=%s model=%s tool_count=%d",
                metadata.get("chat_id"),
                metadata.get("message_id"),
                form_data.get("model"),
                len(tools_dict),
            )
        if metadata.get("params", {}).get("function_calling") == "native":
            # If the function calling is native, then call the tools function calling handler
            tools_dict = tools_dict or {}
            metadata["tools"] = tools_dict
            form_data["tools"] = _build_openai_function_tools_payload(
                tools_dict,
                form_data.get("model"),
                metadata.get("chat_id"),
            )
            payload_tool_names = _tool_payload_function_names(form_data.get("tools", []))
            registry_tool_names = sorted((tools_dict or {}).keys())
            if payload_tool_names and sorted(payload_tool_names) != registry_tool_names:
                log.warning(
                    "[TOOLS] Provider payload / registry mismatch chat_id=%s message_id=%s payload_count=%d registry_count=%d",
                    metadata.get("chat_id"),
                    metadata.get("message_id"),
                    len(payload_tool_names),
                    len(registry_tool_names),
                )
        else:
            # If the function calling is not native, then call the tools function calling handler
            try:
                form_data, flags = await chat_completion_tools_handler(
                    request, form_data, extra_params, user, models, tools_dict
                )
                sources.extend(flags.get("sources", []))
            except Exception as e:
                log.exception(e)

        # GPT Responses mode consumes namespace metadata for deferred tool loading.
        if _is_gpt5_responses_api_model(form_data.get("model")):
            gpt_route_mode = _get_gpt_openai_route_mode()
            previous_namespace_meta = form_data.pop("_tool_namespaces", None)
            ns_tools = tools_dict or metadata.get("tools") or {}
            namespace_meta = _build_tool_namespace_metadata(
                ns_tools, tool_ids=tool_ids
            )
            if namespace_meta:
                form_data["_tool_namespaces"] = namespace_meta
                log.info(
                    "[GPT_ROUTE] Attached GPT namespace metadata route=%s model=%s chat_id=%s message_id=%s entries=%d",
                    gpt_route_mode,
                    form_data.get("model"),
                    metadata.get("chat_id"),
                    metadata.get("message_id"),
                    len(namespace_meta),
                )
            elif previous_namespace_meta is not None:
                log.info(
                    "[GPT_ROUTE] Cleared stale GPT namespace metadata route=%s model=%s chat_id=%s message_id=%s",
                    gpt_route_mode,
                    form_data.get("model"),
                    metadata.get("chat_id"),
                    metadata.get("message_id"),
                )

    _ensure_replay_safe_tool_payload(
        form_data=form_data,
        metadata=metadata,
    )

    try:
        form_data, flags = await chat_completion_files_handler(
            request, form_data, extra_params, user
        )
        sources.extend(flags.get("sources", []))
    except Exception as e:
        log.exception(e)

    # If context is not empty, insert it into the messages
    if len(sources) > 0:
        context_string = ""
        citation_idx_map = {}

        for source in sources:
            if "document" in source:
                for document_text, document_metadata in zip(
                    source["document"], source["metadata"]
                ):
                    source_name = source.get("source", {}).get("name", None)
                    source_id = (
                        document_metadata.get("source", None)
                        or source.get("source", {}).get("id", None)
                        or "N/A"
                    )

                    if source_id not in citation_idx_map:
                        citation_idx_map[source_id] = len(citation_idx_map) + 1

                    context_string += (
                        f'<source id="{citation_idx_map[source_id]}"'
                        + (f' name="{source_name}"' if source_name else "")
                        + f">{document_text}</source>\n"
                    )

        context_string = context_string.strip()
        prompt_text = prompt.strip() if isinstance(prompt, str) else ""

        if context_string != "":
            if prompt_text:
                form_data["messages"] = add_or_update_user_message(
                    rag_template(
                        request.app.state.config.RAG_TEMPLATE,
                        context_string,
                        prompt_text,
                    ),
                    form_data["messages"],
                    append=False,
                )
            else:
                log.info(
                    "[RAG] Skipping rag_template injection because the latest user message is empty text"
                )

    # If there are citations, add them to the data_items
    sources = [
        source
        for source in sources
        if source.get("source", {}).get("name", "")
        or source.get("source", {}).get("id", "")
    ]

    if len(sources) > 0:
        events.append({"sources": sources})

    form_data["messages"], message_sanitize_metadata = (
        _sanitize_provider_request_messages(form_data.get("messages", []))
    )
    dropped_empty_assistant_messages = int(
        message_sanitize_metadata.get("dropped_empty_assistant_messages") or 0
    )
    dropped_historical_empty_user_messages = int(
        message_sanitize_metadata.get("dropped_historical_empty_user_messages") or 0
    )
    latest_empty_user_message_rejected = bool(
        message_sanitize_metadata.get("latest_empty_user_message_rejected")
    )
    if (
        dropped_empty_assistant_messages
        or dropped_historical_empty_user_messages
        or latest_empty_user_message_rejected
    ):
        log.warning(
            "[MESSAGE_SANITIZE] Sanitized provider messages before request chat_id=%s message_id=%s dropped_empty_assistant=%d dropped_historical_empty_user=%d rejected_latest_empty_user=%s",
            metadata.get("chat_id"),
            metadata.get("message_id"),
            dropped_empty_assistant_messages,
            dropped_historical_empty_user_messages,
            latest_empty_user_message_rejected,
        )
    if latest_empty_user_message_rejected:
        log.warning(
            "[MESSAGE_SANITIZE] Rejected latest empty user message before provider request chat_id=%s message_id=%s",
            metadata.get("chat_id"),
            metadata.get("message_id"),
        )
        raise HTTPException(
            status_code=400,
            detail={"message": "Cannot send an empty message."},
        )

    if model_knowledge:
        await event_emitter(
            {
                "type": "status",
                "data": {
                    "action": "knowledge_search",
                    "query": user_message,
                    "done": True,
                    "hidden": True,
                },
            }
        )

    return form_data, metadata, events


async def process_chat_response(
    request, response, form_data, user, metadata, model, events, tasks
):
    response_started_monotonic = time.monotonic()

    def current_debug_request_metadata(
        source_metadata: Any = None,
    ) -> dict[str, Any]:
        if isinstance(source_metadata, dict):
            return _debug_request_metadata_snapshot(source_metadata)
        if isinstance(form_data.get("metadata"), dict):
            return _debug_request_metadata_snapshot(form_data.get("metadata"))
        return _debug_request_metadata_snapshot(metadata)

    async def background_tasks_handler():
        message = None
        messages = []

        if "chat_id" in metadata and not metadata["chat_id"].startswith("local:"):
            messages_map = Chats.get_messages_map_by_chat_id(metadata["chat_id"])
            message = messages_map.get(metadata["message_id"]) if messages_map else None

            message_list = get_message_list(messages_map, metadata["message_id"])

            # Remove details tags and files from the messages.
            # as get_message_list creates a new list, it does not affect
            # the original messages outside of this handler

            messages = []
            for message in message_list:
                content = message.get("content", "")
                if isinstance(content, list):
                    for item in content:
                        if item.get("type") == "text":
                            content = item["text"]
                            break

                if isinstance(content, str):
                    content = re.sub(
                        r"<details\b[^>]*>.*?<\/details>|!\[.*?\]\(.*?\)",
                        "",
                        content,
                        flags=re.S | re.I,
                    ).strip()

                messages.append(
                    {
                        **message,
                        "role": message.get(
                            "role", "assistant"
                        ),  # Safe fallback for missing role
                        "content": content,
                    }
                )
        else:
            # Local temp chat, get the model and message from the form_data
            message = get_last_user_message_item(form_data.get("messages", []))
            messages = form_data.get("messages", [])
            if message:
                message["model"] = form_data.get("model")

        if message and "model" in message:
            if tasks and messages:
                if (
                    TASKS.FOLLOW_UP_GENERATION in tasks
                    and tasks[TASKS.FOLLOW_UP_GENERATION]
                ):
                    res = await generate_follow_ups(
                        request,
                        {
                            "model": message["model"],
                            "messages": messages,
                            "message_id": metadata["message_id"],
                            "chat_id": metadata["chat_id"],
                        },
                        user,
                    )

                    if res and isinstance(res, dict):
                        if len(res.get("choices", [])) == 1:
                            response_message = res.get("choices", [])[0].get(
                                "message", {}
                            )

                            follow_ups_string = response_message.get(
                                "content"
                            ) or response_message.get("reasoning_content", "")
                        else:
                            follow_ups_string = ""

                        follow_ups_string = follow_ups_string[
                            follow_ups_string.find("{") : follow_ups_string.rfind("}")
                            + 1
                        ]

                        try:
                            follow_ups = json.loads(follow_ups_string).get(
                                "follow_ups", []
                            )
                            await event_emitter(
                                {
                                    "type": "chat:message:follow_ups",
                                    "data": {
                                        "follow_ups": follow_ups,
                                    },
                                }
                            )

                            if not metadata.get("chat_id", "").startswith("local:"):
                                Chats.upsert_message_to_chat_by_id_and_message_id(
                                    metadata["chat_id"],
                                    metadata["message_id"],
                                    {
                                        "followUps": follow_ups,
                                    },
                                )

                        except Exception as e:
                            pass

                if not metadata.get("chat_id", "").startswith(
                    "local:"
                ):  # Only update titles and tags for non-temp chats
                    if TASKS.TITLE_GENERATION in tasks:
                        user_message = get_last_user_message(messages)
                        if user_message and len(user_message) > 100:
                            user_message = user_message[:100] + "..."

                        title = None
                        if tasks[TASKS.TITLE_GENERATION]:
                            res = await generate_title(
                                request,
                                {
                                    "model": message["model"],
                                    "messages": messages,
                                    "chat_id": metadata["chat_id"],
                                },
                                user,
                            )

                            if res and isinstance(res, dict):
                                if len(res.get("choices", [])) == 1:
                                    response_message = res.get("choices", [])[0].get(
                                        "message", {}
                                    )

                                    title_string = (
                                        response_message.get("content")
                                        or response_message.get(
                                            "reasoning_content",
                                        )
                                        or message.get("content", user_message)
                                    )
                                else:
                                    title_string = ""

                                title_string = title_string[
                                    title_string.find("{") : title_string.rfind("}") + 1
                                ]

                                try:
                                    title = json.loads(title_string).get(
                                        "title", user_message
                                    )
                                except Exception as e:
                                    title = ""

                                if not title:
                                    log.warning(
                                        "[TITLE_GENERATION] Falling back to first prompt for chat %s because the generated title payload was unusable",
                                        metadata["chat_id"],
                                    )
                                    title = messages[0].get("content", user_message)

                                title = normalize_chat_title(
                                    title,
                                    fallback=messages[0].get("content", user_message),
                                )

                                Chats.update_chat_title_by_id(
                                    metadata["chat_id"], title
                                )

                                await event_emitter(
                                    {
                                        "type": "chat:title",
                                        "data": title,
                                    }
                                )

                        if title == None and len(messages) == 2:
                            log.warning(
                                "[TITLE_GENERATION] Falling back to first prompt for chat %s because title generation did not produce a usable title",
                                metadata["chat_id"],
                            )
                            title = messages[0].get("content", user_message)
                            title = normalize_chat_title(title)

                            Chats.update_chat_title_by_id(metadata["chat_id"], title)

                            await event_emitter(
                                {
                                    "type": "chat:title",
                                    "data": title,
                                }
                            )

                    if TASKS.TAGS_GENERATION in tasks and tasks[TASKS.TAGS_GENERATION]:
                        res = await generate_chat_tags(
                            request,
                            {
                                "model": message["model"],
                                "messages": messages,
                                "chat_id": metadata["chat_id"],
                            },
                            user,
                        )

                        if res and isinstance(res, dict):
                            if len(res.get("choices", [])) == 1:
                                response_message = res.get("choices", [])[0].get(
                                    "message", {}
                                )

                                tags_string = response_message.get(
                                    "content"
                                ) or response_message.get("reasoning_content", "")
                            else:
                                tags_string = ""

                            tags_string = tags_string[
                                tags_string.find("{") : tags_string.rfind("}") + 1
                            ]

                            try:
                                tags = json.loads(tags_string).get("tags", [])
                                Chats.update_chat_tags_by_id(
                                    metadata["chat_id"], tags, user
                                )

                                await event_emitter(
                                    {
                                        "type": "chat:tags",
                                        "data": tags,
                                    }
                                )
                            except Exception as e:
                                pass

    event_emitter = None
    event_caller = None
    if (
        "session_id" in metadata
        and metadata["session_id"]
        and "chat_id" in metadata
        and metadata["chat_id"]
        and "message_id" in metadata
        and metadata["message_id"]
    ):
        event_emitter = get_event_emitter(metadata)
        event_caller = get_event_call(metadata)

    terminal_error_notified = False
    terminal_debug_error_notified = False

    def normalize_terminal_error_message(error_source) -> str:
        error_message = _format_error_message(_extract_error_message(error_source))
        if not error_message:
            error_message = "Unknown error"
        return error_message

    async def persist_terminal_assistant_error(
        error_source,
        *,
        stop_reason: str = "upstream_error",
        content: str | None = None,
        content_blocks: list | None = None,
    ) -> str:
        nonlocal terminal_error_notified
        nonlocal terminal_debug_error_notified

        error_message = normalize_terminal_error_message(error_source)

        if metadata.get("chat_id") and metadata.get("message_id"):
            completion_update = {
                "error": {"content": error_message},
                "done": True,
                "stop_reason": stop_reason,
            }
            if content is not None:
                completion_update["content"] = content
            if content_blocks is not None:
                completion_update["contentBlocks"] = content_blocks

            try:
                if not metadata["chat_id"].startswith("local:"):
                    Chats.upsert_message_to_chat_by_id_and_message_id(
                        metadata["chat_id"],
                        metadata["message_id"],
                        completion_update,
                    )
                    chat_record = Chats.get_chat_by_id(metadata["chat_id"])
                    if chat_record and _sync_flattened_message_with_history(
                        chat_record.chat, metadata["message_id"]
                    ):
                        Chats.update_chat_by_id(
                            metadata["chat_id"], chat_record.chat
                        )
            except Exception as db_err:
                log.warning(
                    "[CHAT-ERROR] Failed to persist terminal error chat_id=%s message_id=%s: %s",
                    metadata.get("chat_id"),
                    metadata.get("message_id"),
                    db_err,
                )

        if stop_reason != "client_disconnect":
            await _refresh_active_chat_agent_vms(
                metadata.get("chat_id"),
                reason="terminal_error",
            )

        if (
            not terminal_debug_error_notified
            and _should_publish_bifrost_debug_response(
                current_debug_request_metadata()
            )
        ):
            try:
                debug_request_metadata = current_debug_request_metadata()
                published = await publish_error(
                    session_id=debug_request_metadata.get("session_id"),
                    chat_id=debug_request_metadata.get("chat_id"),
                    error=error_message,
                    debug_request_id=debug_request_metadata.get(
                        "debug_request_id"
                    ),
                    upstream_request_id=debug_request_metadata.get(
                        "upstream_request_id"
                    ),
                    task_name=debug_request_metadata.get("task"),
                    request_phase=debug_request_metadata.get("request_phase"),
                    followup_index=debug_request_metadata.get("followup_index"),
                    outer_message_id=debug_request_metadata.get(
                        "outer_message_id"
                    ),
                    trigger_message_id=debug_request_metadata.get(
                        "trigger_message_id"
                    ),
                    transcript_anchor_kind=debug_request_metadata.get(
                        "transcript_anchor_kind"
                    ),
                    transcript_anchor_message_id=debug_request_metadata.get(
                        "transcript_anchor_message_id"
                    ),
                    transcript_anchor_tool_block_index=debug_request_metadata.get(
                        "transcript_anchor_tool_block_index"
                    ),
                )
                if not published:
                    log.warning(
                        "[LLM_DEBUG_MONITOR] Terminal error publish returned false chat_id=%s upstream_request_id=%s",
                        debug_request_metadata.get("chat_id"),
                        debug_request_metadata.get("upstream_request_id"),
                    )
                terminal_debug_error_notified = True
            except Exception as exc:
                log.warning(
                    "[LLM_DEBUG_MONITOR] Failed to publish Bifrost terminal error: %s",
                    exc,
                )

        if event_emitter and not terminal_error_notified:
            terminal_error_notified = True
            await event_emitter(
                {
                    "type": "chat:message:error",
                    "data": {"error": {"content": error_message}},
                }
            )
            await event_emitter({"type": "chat:tasks:cancel"})

        return error_message

    def log_retryable_chat_completion_response(label: str, error_source) -> None:
        try:
            if hasattr(error_source, "body"):
                error_body = (
                    error_source.body.decode("utf-8")
                    if isinstance(error_source.body, bytes)
                    else str(error_source.body)
                )
                log.warning("%s retryable error body: %s", label, error_body[:2000])
            if hasattr(error_source, "status_code"):
                log.warning(
                    "%s retryable status_code: %s",
                    label,
                    getattr(error_source, "status_code", None),
                )
        except Exception as log_err:
            log.warning("%s could not log retryable response: %s", label, log_err)

    initial_retry_attempt = 1
    while (
        not isinstance(response, StreamingResponse)
        and _is_retryable_chat_completion_error(response)
    ):
        initial_retry_max_attempts = (
            _get_chat_completion_request_retry_max_attempts(
                response, form_data
            )
        )
        if initial_retry_attempt >= initial_retry_max_attempts:
            break
        error_message = normalize_terminal_error_message(response)
        delay_seconds = _get_transient_chat_completion_retry_delay_seconds(
            initial_retry_attempt
        )
        log.warning(
            "[INITIAL] Retryable model response attempt=%d/%d delay=%.1fs retry_reason=%s error=%s",
            initial_retry_attempt,
            initial_retry_max_attempts,
            delay_seconds,
            _retryable_chat_completion_error_reason(response),
            error_message,
        )
        log_retryable_chat_completion_response("[INITIAL]", response)
        if delay_seconds > 0:
            await asyncio.sleep(delay_seconds)
        form_data["metadata"] = _refresh_upstream_request_metadata(
            form_data.get("metadata")
        )
        response = await generate_chat_completion(request, form_data, user)
        initial_retry_attempt += 1

    async def schedule_terminal_pending_chat_work_drain(
        terminal_completed_at: float | None = None,
    ) -> None:
        if not metadata.get("chat_id"):
            return

        try:
            await run_pending_chat_work_drain(
                request=request,
                user=user,
                chat_id=metadata["chat_id"],
                sio=sio,
                ignore_task_ids=[metadata.get("task_id")],
                triggered_at=terminal_completed_at,
            )
        except TimeoutError:
            log.debug(
                "[PendingChatWork] Terminal drain already running for %s",
                metadata.get("chat_id"),
            )
        except Exception:
            log.exception(
                "[PendingChatWork] Terminal drain failed for chat %s",
                metadata.get("chat_id"),
            )

    # Non-streaming response
    if not isinstance(response, StreamingResponse):
        if event_emitter:
            try:
                if isinstance(response, list) and len(response) == 1:
                    # If the response is a single-item list, unwrap it #17213
                    response = response[0]

                response_data = _normalize_non_streaming_response_payload(response)
                error_source = _get_non_streaming_response_error_source(
                    response,
                    response_data,
                )
                if error_source is not None:
                    await persist_terminal_assistant_error(
                        error_source,
                        stop_reason="upstream_error",
                    )

                if isinstance(response_data, dict):
                    if error_source is None and "error" in response_data:
                        await persist_terminal_assistant_error(
                            response_data,
                            stop_reason="upstream_error",
                        )

                    if "selected_model_id" in response_data:
                        Chats.upsert_message_to_chat_by_id_and_message_id(
                            metadata["chat_id"],
                            metadata["message_id"],
                            {
                                "selectedModelId": response_data["selected_model_id"],
                            },
                        )

                    choices = response_data.get("choices", [])
                    if (
                        "error" not in response_data
                        and _should_publish_bifrost_debug_response(
                            current_debug_request_metadata()
                        )
                    ):
                        try:
                            choice_message = (
                                choices[0].get("message", {})
                                if choices and isinstance(choices[0], dict)
                                else {}
                            )
                            response_content = choice_message.get("content", "")
                            if response_content is None:
                                response_content = ""
                            if not isinstance(response_content, str):
                                response_content = json.dumps(
                                    response_content, default=str
                                )
                            thinking_content = choice_message.get(
                                "reasoning_content", ""
                            )
                            if thinking_content is None:
                                thinking_content = ""
                            if not isinstance(thinking_content, str):
                                thinking_content = json.dumps(
                                    thinking_content, default=str
                                )
                            tool_calls = choice_message.get("tool_calls", [])
                            if not isinstance(tool_calls, list):
                                tool_calls = []
                            debug_response_usage = response_data.get("usage", {}) or {}
                            if not debug_response_usage:
                                debug_response_usage = (
                                    response_data.get("metadata", {}).get("usage", {})
                                    or {}
                                )
                            if debug_response_usage:
                                debug_response_usage = _normalize_llm_debug_usage(
                                    debug_response_usage
                                )
                                response_cost = (
                                    response_data.get("hidden_params", {}).get(
                                        "response_cost"
                                    )
                                    or debug_response_usage.get("cost")
                                    or 0
                                )
                                if isinstance(response_cost, dict):
                                    response_cost = (
                                        response_cost.get("total_cost")
                                        or response_cost.get("value")
                                        or 0
                                    )
                                if response_cost:
                                    debug_response_usage["cost"] = response_cost
                            duration_ms = max(
                                0,
                                int(
                                    (time.monotonic() - response_started_monotonic)
                                    * 1000
                                ),
                            )
                            debug_request_metadata = current_debug_request_metadata()
                            published = await publish_response_complete(
                                session_id=debug_request_metadata.get("session_id"),
                                chat_id=debug_request_metadata.get("chat_id"),
                                model=form_data.get("model", "unknown"),
                                usage=debug_response_usage,
                                finish_reason=(
                                    choices[0].get("finish_reason")
                                    if choices and isinstance(choices[0], dict)
                                    else None
                                )
                                or response_data.get("finish_reason")
                                or response_data.get("stop_reason")
                                or "stop",
                                duration_ms=duration_ms,
                                has_tool_calls=len(tool_calls) > 0,
                                response_content=response_content,
                                tool_calls=tool_calls,
                                thinking_content=thinking_content,
                                debug_request_id=debug_request_metadata.get(
                                    "debug_request_id"
                                ),
                                upstream_request_id=debug_request_metadata.get(
                                    "upstream_request_id"
                                ),
                                task_name=debug_request_metadata.get("task"),
                                request_phase=debug_request_metadata.get(
                                    "request_phase"
                                ),
                                followup_index=debug_request_metadata.get(
                                    "followup_index"
                                ),
                                outer_message_id=debug_request_metadata.get(
                                    "outer_message_id"
                                ),
                                trigger_message_id=debug_request_metadata.get(
                                    "trigger_message_id"
                                ),
                                transcript_anchor_kind=debug_request_metadata.get(
                                    "transcript_anchor_kind"
                                ),
                                transcript_anchor_message_id=debug_request_metadata.get(
                                    "transcript_anchor_message_id"
                                ),
                                transcript_anchor_tool_block_index=debug_request_metadata.get(
                                    "transcript_anchor_tool_block_index"
                                ),
                            )
                            if not published:
                                log.warning(
                                    "[LLM_DEBUG_MONITOR] Non-streaming response publish returned false chat_id=%s upstream_request_id=%s",
                                    debug_request_metadata.get("chat_id"),
                                    debug_request_metadata.get("upstream_request_id"),
                                )
                        except Exception as exc:
                            log.warning(
                                "[LLM_DEBUG_MONITOR] Failed to publish Bifrost non-streaming response: %s",
                                exc,
                            )
                    if choices and choices[0].get("message", {}).get("content"):
                        content = response_data["choices"][0]["message"]["content"]

                        if content:
                            await event_emitter(
                                {
                                    "type": "chat:completion",
                                    "data": response_data,
                                }
                            )

                            title = Chats.get_chat_title_by_id(metadata["chat_id"])
                            terminal_reason = (
                                (
                                    choices[0].get("finish_reason")
                                    if choices and isinstance(choices[0], dict)
                                    else None
                                )
                                or response_data.get("finish_reason")
                                or response_data.get("stop_reason")
                                or "stop"
                            )

                            # Save the terminal assistant state before starting queued follow-up work.
                            Chats.upsert_message_to_chat_by_id_and_message_id(
                                metadata["chat_id"],
                                metadata["message_id"],
                                {
                                    "role": "assistant",
                                    "content": content,
                                    "done": True,
                                    "stop_reason": terminal_reason,
                                },
                            )

                            await event_emitter(
                                {
                                    "type": "chat:completion",
                                    "data": {
                                        "done": True,
                                        "content": content,
                                        "title": title,
                                        "stop_reason": terminal_reason,
                                    },
                                }
                            )

                            terminal_completed_at = time.monotonic()
                            await _refresh_active_chat_agent_vms(
                                metadata.get("chat_id"),
                                reason="assistant_terminal",
                            )
                            await schedule_terminal_pending_chat_work_drain(
                                terminal_completed_at
                            )

                            # Send a webhook notification if the user is not active
                            if not Users.is_user_active(user.id):
                                webhook_url = Users.get_user_webhook_url_by_id(user.id)
                                if webhook_url:
                                    await post_webhook(
                                        request.app.state.WEBUI_NAME,
                                        webhook_url,
                                        f"{title} - {request.app.state.config.WEBUI_URL}/c/{metadata['chat_id']}\n\n{content}",
                                        {
                                            "action": "chat",
                                            "message": content,
                                            "title": title,
                                            "url": f"{request.app.state.config.WEBUI_URL}/c/{metadata['chat_id']}",
                                        },
                                    )

                            await background_tasks_handler()

                    if events and isinstance(events, list):
                        extra_response = {}
                        for event in events:
                            if isinstance(event, dict):
                                extra_response.update(event)
                            else:
                                extra_response[event] = True

                        response_data = {
                            **extra_response,
                            **response_data,
                        }

                    if isinstance(response, dict):
                        response = response_data
                    if isinstance(response, JSONResponse):
                        response = JSONResponse(
                            content=response_data,
                            headers=response.headers,
                            status_code=response.status_code,
                        )

            except Exception as e:
                log.debug(f"Error occurred while processing request: {e}")
                pass

            return response
        else:
            if events and isinstance(events, list) and isinstance(response, dict):
                extra_response = {}
                for event in events:
                    if isinstance(event, dict):
                        extra_response.update(event)
                    else:
                        extra_response[event] = True

                response = {
                    **extra_response,
                    **response,
                }

            return response

    # Non standard response
    if not any(
        content_type in response.headers["Content-Type"]
        for content_type in ["text/event-stream", "application/x-ndjson"]
    ):
        return response

    oauth_token = None
    try:
        if request.cookies.get("oauth_session_id", None):
            oauth_token = await request.app.state.oauth_manager.get_oauth_token(
                user.id,
                request.cookies.get("oauth_session_id", None),
            )
    except Exception as e:
        log.error(f"Error getting OAuth token: {e}")

    extra_params = {
        "__event_emitter__": event_emitter,
        "__event_call__": event_caller,
        "__user__": user.model_dump() if isinstance(user, UserModel) else {},
        "__metadata__": metadata,
        "__oauth_token__": oauth_token,
        "__request__": request,
        "__model__": model,
    }
    filter_functions = [
        Functions.get_function_by_id(filter_id)
        for filter_id in get_sorted_filter_ids(
            request, model, metadata.get("filter_ids", [])
        )
    ]

    # Streaming response
    if event_emitter and event_caller:
        task_id = str(uuid4())  # Create a unique task ID.
        model_id = form_data.get("model", "")
        metadata["child_task_ids"] = set()  # Track child subagent task IDs for cleanup on cancel

        def split_content_and_whitespace(content):
            content_stripped = content.rstrip()
            original_whitespace = (
                content[len(content_stripped) :]
                if len(content) > len(content_stripped)
                else ""
            )
            return content_stripped, original_whitespace

        def is_opening_code_block(content):
            backtick_segments = content.split("```")
            # Even number of segments means the last backticks are opening a new block
            return len(backtick_segments) > 1 and len(backtick_segments) % 2 == 0

        # Handle as a background task
        async def response_handler(response, events):
            def resolve_tool_display_name(tool_name: str) -> str:
                return (tool_name or "").strip() or tool_name

            def is_scheduled_finalizer_tool_name(tool_name: Any) -> bool:
                return str(tool_name or "").strip() == SCHEDULED_FINALIZER_TOOL_NAME

            def serialize_content_blocks(content_blocks, raw=False):
                content = ""

                # PORTICO PATCH: Collect all tool results to detect duplicated content in text blocks
                # GPT models sometimes echo tool results in their response text, causing
                # the same content to appear in both tool results AND text blocks.
                all_tool_results = []
                for block in content_blocks:
                    if block["type"] == "tool_calls":
                        tool_calls = block.get("content", [])
                        for result in normalize_tool_results(block.get("results")):
                            if is_scheduled_finalizer_tool_name(
                                _tool_name_for_call_id(
                                    tool_calls, result.get("tool_call_id")
                                )
                            ):
                                continue
                            result_content = result.get("content", "") or ""
                            if result_content:
                                all_tool_results.append(result_content)

                for block in content_blocks:
                    if block["type"] == "text":
                        block_content = block.get("content", "")
                        if not isinstance(block_content, str):
                            block_content = str(block_content)
                        if block_content:
                            # PORTICO PATCH: Skip text blocks that duplicate tool results
                            # Check if this text block content matches a tool result
                            is_duplicate = False
                            normalized_block_content = block_content.strip()
                            for tool_result in all_tool_results:
                                result_fingerprint = (tool_result or "")[:150].strip()
                                if (
                                    result_fingerprint
                                    and len(result_fingerprint) > 20
                                    and normalized_block_content
                                    and result_fingerprint in normalized_block_content
                                ):
                                    log.debug(
                                        f"[TOOL-DUPLICATION] Skipping text block that duplicates tool result in UI serialization"
                                    )
                                    is_duplicate = True
                                    break
                            if not is_duplicate:
                                # Preserve exact streamed whitespace/newlines across block seams.
                                content = f"{content}{block_content}"
                    elif block["type"] == "tool_calls":
                        attributes = block.get("attributes", {})
                        streaming_preview = bool(block.get("streaming_preview"))
                        tool_call_summary = get_tool_call_summary_label(
                            streaming_preview
                        )
                        tool_call_phase = (
                            "preparing" if streaming_preview else "running"
                        )

                        tool_calls = block.get("content", [])
                        results = normalize_tool_results(block.get("results"))

                        if content and not content.endswith("\n"):
                            content += "\n"

                        if results:
                            tool_calls_display_content = ""
                            for tool_call in tool_calls:
                                tool_call_id = tool_call.get("id", "")
                                tool_name = resolve_tool_display_name(
                                    tool_call.get("function", {}).get("name", "")
                                )
                                if is_scheduled_finalizer_tool_name(tool_name):
                                    continue
                                tool_arguments = tool_call.get("function", {}).get(
                                    "arguments", ""
                                )

                                tool_result = None
                                tool_result_files = None
                                matched_result = None
                                for result in results:
                                    if tool_call_id == result.get("tool_call_id", ""):
                                        matched_result = result
                                        tool_result = result.get("content", None)
                                        tool_result_files = (
                                            _display_files_tool_result_files_for_serialization(
                                                tool_function_name=tool_name,
                                                server_id=result.get("server_id"),
                                                tool_result=tool_result,
                                                fallback_files=result.get("files", None),
                                            )
                                        )
                                        break

                                if tool_result is not None:
                                    tool_result_embeds = matched_result.get("embeds", "")
                                    tool_result_stop_reason = (
                                        matched_result.get("stop_reason")
                                        or block.get("stop_reason")
                                        or ""
                                    )
                                    stop_reason_attr = (
                                        f' stop_reason="{html.escape(str(tool_result_stop_reason))}"'
                                        if tool_result_stop_reason
                                        else ""
                                    )
                                    # Prefer per-tool-call duration when available, fallback to block duration.
                                    tool_result_duration = matched_result.get("duration", None)
                                    if tool_result_duration is None:
                                        result_started_at = matched_result.get("started_at")
                                        result_ended_at = matched_result.get("ended_at")
                                        if result_started_at and result_ended_at:
                                            tool_result_duration = int(
                                                result_ended_at - result_started_at
                                            )
                                    if tool_result_duration is None:
                                        block_duration = block.get("duration", None)
                                        block_started_at = (
                                            block.get("execution_started_at")
                                            or block.get("started_at", None)
                                        )
                                        tool_result_duration = (
                                            block_duration
                                            if block_duration is not None
                                            else (
                                                int(time.time() - block_started_at)
                                                if block_started_at
                                                else 0
                                            )
                                        )
                                    log.info(
                                        "[TOOL-CALL-UI] chat_id=%s message_id=%s tool_call_id=%s tool=%s started_at=%s ended_at=%s duration=%s serialized_done=true has_files=%s has_embeds=%s",
                                        metadata.get("chat_id"),
                                        metadata.get("message_id"),
                                        tool_call_id,
                                        tool_name,
                                        matched_result.get("started_at"),
                                        matched_result.get("ended_at"),
                                        tool_result_duration,
                                        bool(tool_result_files),
                                        bool(tool_result_embeds),
                                    )
                                    tool_calls_display_content = f'{tool_calls_display_content}<details type="tool_calls" done="true" duration="{tool_result_duration}"{stop_reason_attr} id="{tool_call_id}" name="{tool_name}" arguments="{html.escape(json.dumps(tool_arguments))}" result="{html.escape(json.dumps(tool_result, ensure_ascii=False))}" files="{html.escape(json.dumps(tool_result_files)) if tool_result_files else ""}" embeds="{html.escape(json.dumps(tool_result_embeds))}">\n<summary>Tool Executed</summary>\n</details>\n'
                                else:
                                    # Extract timing data for in-progress tool calls
                                    block_started_at = (
                                        block.get("started_at", None)
                                        if streaming_preview
                                        else (
                                            block.get("execution_started_at")
                                            or block.get("started_at", None)
                                        )
                                    )
                                    elapsed = (
                                        int(time.time() - block_started_at)
                                        if block_started_at
                                        else 0
                                    )
                                    started_at_attr = (
                                        f' started_at="{block_started_at}"'
                                        if block_started_at
                                        else ""
                                    )
                                    phase_attr = f' phase="{tool_call_phase}"'
                                    tool_calls_display_content = f'{tool_calls_display_content}<details type="tool_calls" done="false"{started_at_attr}{phase_attr} elapsed="{elapsed}" id="{tool_call_id}" name="{tool_name}" arguments="{html.escape(json.dumps(tool_arguments))}">\n<summary>{tool_call_summary}</summary>\n</details>\n'

                            if not raw:
                                content = f"{content}{tool_calls_display_content}"
                        else:
                            tool_calls_display_content = ""
                            # Extract timing data for in-progress tool calls (no results yet)
                            block_started_at = (
                                block.get("started_at", None)
                                if streaming_preview
                                else (
                                    block.get("execution_started_at")
                                    or block.get("started_at", None)
                                )
                            )
                            elapsed = (
                                int(time.time() - block_started_at)
                                if block_started_at
                                else 0
                            )
                            started_at_attr = (
                                f' started_at="{block_started_at}"'
                                if block_started_at
                                else ""
                            )
                            phase_attr = f' phase="{tool_call_phase}"'

                            for tool_call in tool_calls:
                                tool_call_id = tool_call.get("id", "")
                                tool_name = resolve_tool_display_name(
                                    tool_call.get("function", {}).get("name", "")
                                )
                                if is_scheduled_finalizer_tool_name(tool_name):
                                    continue
                                tool_arguments = tool_call.get("function", {}).get(
                                    "arguments", ""
                                )

                                tool_calls_display_content = f'{tool_calls_display_content}\n<details type="tool_calls" done="false"{started_at_attr}{phase_attr} elapsed="{elapsed}" id="{tool_call_id}" name="{tool_name}" arguments="{html.escape(json.dumps(tool_arguments))}">\n<summary>{tool_call_summary}</summary>\n</details>\n'

                            if not raw:
                                content = f"{content}{tool_calls_display_content}"

                    elif block["type"] == "reasoning":
                        reasoning_display_content = html.escape(
                            "\n".join(
                                (f"> {line}" if not line.startswith(">") else line)
                                for line in block["content"].splitlines()
                            )
                        )

                        reasoning_duration = block.get("duration", None)
                        reasoning_started_at = block.get("started_at", None)
                        reasoning_stop_reason = block.get("stop_reason", "")
                        started_at_attr = (
                            f' started_at="{reasoning_started_at}"'
                            if reasoning_started_at
                            else ""
                        )
                        stop_reason_attr = (
                            f' stop_reason="{html.escape(str(reasoning_stop_reason))}"'
                            if reasoning_stop_reason
                            else ""
                        )

                        if raw:
                            start_tag = CANONICAL_REASONING_START_TAG
                            end_tag = CANONICAL_REASONING_END_TAG
                        else:
                            start_tag = block.get("start_tag", "")
                            end_tag = block.get("end_tag", "")

                        if content and not content.endswith("\n"):
                            content += "\n"

                        if reasoning_duration is not None:
                            if raw:
                                content = (
                                    f'{content}{start_tag}{block["content"]}{end_tag}\n'
                                )
                            else:
                                content = f'{content}<details type="reasoning" done="true" duration="{reasoning_duration}"{started_at_attr}{stop_reason_attr}>\n<summary>Thought for {reasoning_duration} seconds</summary>\n{reasoning_display_content}\n</details>\n'
                        else:
                            if raw:
                                content = (
                                    f'{content}{start_tag}{block["content"]}{end_tag}\n'
                                )
                            else:
                                # Extract timing data for in-progress reasoning (matching tool_calls pattern)
                                reasoning_elapsed = (
                                    int(time.time() - reasoning_started_at)
                                    if reasoning_started_at
                                    else 0
                                )
                                content = f'{content}<details type="reasoning" done="false"{started_at_attr} elapsed="{reasoning_elapsed}">\n<summary>Thinking…</summary>\n{reasoning_display_content}\n</details>\n'

                    elif block["type"] == "code_interpreter":
                        attributes = block.get("attributes", {})
                        output = block.get("output", None)
                        lang = attributes.get("lang", "")

                        content_stripped, original_whitespace = (
                            split_content_and_whitespace(content)
                        )
                        if is_opening_code_block(content_stripped):
                            # Remove trailing backticks that would open a new block
                            content = (
                                content_stripped.rstrip("`").rstrip()
                                + original_whitespace
                            )
                        else:
                            # Keep content as is - either closing backticks or no backticks
                            content = content_stripped + original_whitespace

                        if content and not content.endswith("\n"):
                            content += "\n"

                        if output:
                            output = html.escape(json.dumps(output))

                            if raw:
                                content = f'{content}<code_interpreter type="code" lang="{lang}">\n{block["content"]}\n</code_interpreter>\n```output\n{output}\n```\n'
                            else:
                                content = f'{content}<details type="code_interpreter" done="true" output="{output}">\n<summary>Analyzed</summary>\n```{lang}\n{block["content"]}\n```\n</details>\n'
                        else:
                            if raw:
                                content = f'{content}<code_interpreter type="code" lang="{lang}">\n{block["content"]}\n</code_interpreter>\n'
                            else:
                                content = f'{content}<details type="code_interpreter" done="false">\n<summary>Analyzing...</summary>\n```{lang}\n{block["content"]}\n```\n</details>\n'

                    elif block["type"] == "user_steer":
                        continue

                    else:
                        block_content = str(block["content"])
                        if block_content:
                            content = f"{content}{block['type']}: {block_content}\n"

                # Do not trim assembled content; boundary whitespace is semantically relevant.
                return content

            def convert_content_blocks_to_messages(
                content_blocks, raw=False, replay_mode="default"
            ):
                messages = []
                # PORTICO PATCH: Track all tool results to detect duplication
                all_tool_results = []
                strip_reasoning_blocks = replay_mode in {
                    "tool_followup",
                    "stream_continue",
                    "anomaly_retry",
                }
                include_trailing_assistant_text = True
                compact_tool_results = replay_mode in {
                    "tool_followup",
                    "stream_continue",
                    "anomaly_retry",
                }

                def serialize_replay_blocks(blocks):
                    if not isinstance(blocks, list) or len(blocks) == 0:
                        return ""

                    replay_blocks = blocks
                    if strip_reasoning_blocks:
                        replay_blocks = [
                            block
                            for block in replay_blocks
                            if isinstance(block, dict)
                            and block.get("type") != "reasoning"
                        ]
                    if len(replay_blocks) == 0:
                        return ""

                    serialized = serialize_content_blocks(replay_blocks, raw)
                    if strip_reasoning_blocks and isinstance(serialized, str):
                        # Leaked literal think-tag sections inside text blocks
                        # must not ride tool follow-ups back to the model.
                        serialized = _remove_complete_inline_reasoning_sections(
                            serialized
                        )
                    return serialized

                temp_blocks = []
                for idx, block in enumerate(content_blocks):
                    if block["type"] == "tool_calls":
                        assistant_content = serialize_replay_blocks(temp_blocks)

                        # PORTICO PATCH: Check if assistant content duplicates a previous tool result
                        # GPT models sometimes echo tool results in their response text, causing
                        # the same content to appear as both an assistant message AND a tool result.
                        # This causes huge token usage spikes in follow-up requests.
                        is_duplicate = False
                        if assistant_content and all_tool_results:
                            for tool_result in all_tool_results:
                                # Check if significant portion of tool result appears in assistant content
                                # Use first 150 chars as a fingerprint to avoid false positives
                                result_fingerprint = (tool_result or "")[:150].strip()
                                if (
                                    result_fingerprint
                                    and len(result_fingerprint) > 20
                                    and result_fingerprint in assistant_content
                                ):
                                    log.warning(
                                        f"[TOOL-DUPLICATION] Detected assistant content duplicating tool result, clearing content to prevent token waste"
                                    )
                                    is_duplicate = True
                                    break

                        messages.append(
                            {
                                "role": "assistant",
                                "content": "" if is_duplicate else assistant_content,
                                "tool_calls": block.get("content"),
                            }
                        )

                        results = normalize_tool_results(block.get("results"))

                        for result in results:
                            result_content = _tool_result_content_for_model_replay(
                                result,
                                tool_function_name=_tool_name_for_call_id(
                                    block.get("content") or [],
                                    result.get("tool_call_id", ""),
                                ),
                            )
                            if compact_tool_results and not _tool_result_overflow_exempt_for_metadata(
                                result
                            ):
                                result_content = _compact_tool_result_for_internal_replay(
                                    result_content
                                )
                            messages.append(
                                {
                                    "role": "tool",
                                    "tool_call_id": result.get("tool_call_id", ""),
                                    "content": result_content,
                                }
                            )
                            # Track this result for future duplicate detection
                            all_tool_results.append(result_content)
                        temp_blocks = []
                    elif block["type"] == "user_steer":
                        assistant_content = serialize_replay_blocks(temp_blocks)
                        if assistant_content and include_trailing_assistant_text:
                            messages.append(
                                {
                                    "role": "assistant",
                                    "content": assistant_content,
                                }
                            )
                        temp_blocks = []

                        steer_message, _ = pending_work_item_to_request_message(
                            {
                                "prompt": block.get("content") or "",
                                "files": block.get("files") or [],
                            }
                        )
                        messages.append(steer_message)
                    else:
                        temp_blocks.append(block)

                if temp_blocks and include_trailing_assistant_text:
                    content = serialize_replay_blocks(temp_blocks)
                    # PORTICO PATCH: Also check trailing content for duplication
                    is_duplicate = False
                    if content and all_tool_results:
                        for tool_result in all_tool_results:
                            result_fingerprint = (tool_result or "")[:150].strip()
                            if (
                                result_fingerprint
                                and len(result_fingerprint) > 20
                                and result_fingerprint in content
                            ):
                                log.warning(
                                    f"[TOOL-DUPLICATION] Detected trailing assistant content duplicating tool result, skipping message"
                                )
                                is_duplicate = True
                                break

                    if content and not is_duplicate:
                        messages.append(
                            {
                                "role": "assistant",
                                "content": content,
                            }
                        )

                return messages

            def tag_content_handler(content_type, tags, content, content_blocks):
                end_flag = False

                def extract_attributes(tag_content):
                    """Extract attributes from a tag if they exist."""
                    attributes = {}
                    if not tag_content:  # Ensure tag_content is not None
                        return attributes
                    # Match attributes in the format: key="value" (ignores single quotes for simplicity)
                    matches = re.findall(r'(\w+)\s*=\s*"([^"]+)"', tag_content)
                    for key, value in matches:
                        attributes[key] = value
                    return attributes

                if content_blocks[-1]["type"] == "text":
                    for start_tag, end_tag in tags:
                        start_tag_pattern = rf"{re.escape(start_tag)}"
                        if start_tag.startswith("<") and start_tag.endswith(">"):
                            # Match start tag e.g., <tag> or <tag attr="value">
                            # remove both '<' and '>' from start_tag
                            # Match start tag with attributes
                            start_tag_pattern = (
                                rf"<{re.escape(start_tag[1:-1])}(\s.*?)?>"
                            )

                        match = re.search(start_tag_pattern, content)
                        if match:
                            try:
                                attr_content = (
                                    match.group(1) if match.group(1) else ""
                                )  # Ensure it's not None
                            except:
                                attr_content = ""

                            attributes = extract_attributes(
                                attr_content
                            )  # Extract attributes safely

                            # Capture everything before and after the matched tag
                            before_tag = content[
                                : match.start()
                            ]  # Content before opening tag
                            after_tag = content[
                                match.end() :
                            ]  # Content after opening tag

                            # Remove the start tag and after from the currently handling text block
                            content_blocks[-1]["content"] = content_blocks[-1][
                                "content"
                            ].replace(match.group(0) + after_tag, "")

                            if before_tag:
                                content_blocks[-1]["content"] = before_tag

                            if not content_blocks[-1]["content"]:
                                content_blocks.pop()

                            # Append the new block
                            content_blocks.append(
                                {
                                    "type": content_type,
                                    "start_tag": start_tag,
                                    "end_tag": end_tag,
                                    "attributes": attributes,
                                    "content": "",
                                    "started_at": time.time(),
                                }
                            )

                            if after_tag:
                                content_blocks[-1]["content"] = after_tag
                                tag_content_handler(
                                    content_type, tags, after_tag, content_blocks
                                )

                            break
                elif content_blocks[-1]["type"] == content_type:
                    start_tag = content_blocks[-1]["start_tag"]
                    end_tag = content_blocks[-1]["end_tag"]

                    if end_tag.startswith("<") and end_tag.endswith(">"):
                        # Match end tag e.g., </tag>
                        end_tag_pattern = rf"{re.escape(end_tag)}"
                    else:
                        # Handle cases where end_tag is just a tag name
                        end_tag_pattern = rf"{re.escape(end_tag)}"

                    # Check if the content has the end tag
                    if re.search(end_tag_pattern, content):
                        end_flag = True

                        block_content = content_blocks[-1]["content"]
                        # Strip start and end tags from the content
                        start_tag_pattern = rf"<{re.escape(start_tag)}(.*?)>"
                        block_content = re.sub(
                            start_tag_pattern, "", block_content
                        ).strip()

                        end_tag_regex = re.compile(end_tag_pattern, re.DOTALL)
                        split_content = end_tag_regex.split(block_content, maxsplit=1)

                        # Content inside the tag
                        block_content = (
                            split_content[0].strip() if split_content else ""
                        )

                        # Leftover content (everything after `</tag>`)
                        leftover_content = (
                            split_content[1].strip() if len(split_content) > 1 else ""
                        )

                        if block_content:
                            content_blocks[-1]["content"] = block_content
                            content_blocks[-1]["ended_at"] = time.time()
                            content_blocks[-1]["duration"] = int(
                                content_blocks[-1]["ended_at"]
                                - content_blocks[-1]["started_at"]
                            )

                            # Reset the content_blocks by appending a new text block
                            if content_type != "code_interpreter":
                                if leftover_content:
                                    content_blocks.append(
                                        {
                                            "type": "text",
                                            "content": leftover_content,
                                        }
                                    )
                                else:
                                    content_blocks.append(
                                        {
                                            "type": "text",
                                            "content": "",
                                        }
                                    )

                        else:
                            # Remove the block if content is empty
                            content_blocks.pop()

                            if leftover_content:
                                content_blocks.append(
                                    {
                                        "type": "text",
                                        "content": leftover_content,
                                    }
                                )
                            else:
                                content_blocks.append(
                                    {
                                        "type": "text",
                                        "content": "",
                                    }
                                )

                        # Clean processed content
                        start_tag_pattern = rf"{re.escape(start_tag)}"
                        if start_tag.startswith("<") and start_tag.endswith(">"):
                            # Match start tag e.g., <tag> or <tag attr="value">
                            # remove both '<' and '>' from start_tag
                            # Match start tag with attributes
                            start_tag_pattern = (
                                rf"<{re.escape(start_tag[1:-1])}(\s.*?)?>"
                            )

                        content = re.sub(
                            rf"{start_tag_pattern}(.|\n)*?{re.escape(end_tag)}",
                            "",
                            content,
                            flags=re.DOTALL,
                        )

                return content, content_blocks, end_flag

            message = Chats.get_message_by_id_and_message_id(
                metadata["chat_id"], metadata["message_id"]
            )

            tool_calls = []
            last_finish_reason = None
            last_stop_reason = None
            last_completion_tokens = None

            def _parse_positive_int(value):
                try:
                    parsed = int(value)
                    return parsed if parsed > 0 else None
                except (TypeError, ValueError):
                    return None

            def _parse_non_negative_float(value):
                try:
                    parsed = float(value)
                    return parsed if parsed >= 0 else None
                except (TypeError, ValueError):
                    return None

            requested_max_tokens = _parse_positive_int(
                metadata.get("params", {}).get("max_tokens")
                or form_data.get("max_tokens")
            )
            configured_max_length_continuations = _parse_positive_int(
                metadata.get("params", {}).get("max_length_continuations")
            )
            # Keep auto-continuation bounded but large enough to stitch together long replies
            # when per-request max_tokens is intentionally set low (e.g. truncation testing).
            auto_continue_output_budget = (
                _parse_positive_int(
                    metadata.get("params", {}).get("max_auto_continue_output_tokens")
                )
                or 1000000
            )
            auto_continue_hard_cap = (
                _parse_positive_int(
                    metadata.get("params", {}).get(
                        "max_length_continuations_hard_cap"
                    )
                )
                or 2048
            )

            if configured_max_length_continuations:
                max_length_continuations = configured_max_length_continuations
            elif requested_max_tokens:
                derived_continuations = (
                    auto_continue_output_budget + requested_max_tokens - 1
                ) // requested_max_tokens
                max_length_continuations = max(
                    3, min(auto_continue_hard_cap, derived_continuations)
                )
            else:
                max_length_continuations = 3

            continuation_context_chunk_count = (
                _parse_positive_int(
                    metadata.get("params", {}).get("continue_context_chunk_count")
                )
                or 24
            )
            continuation_context_char_budget = (
                _parse_positive_int(
                    metadata.get("params", {}).get("continue_context_char_budget")
                )
                or 512
            )
            continuation_suffix_chars = (
                _parse_positive_int(
                    metadata.get("params", {}).get("continue_suffix_chars")
                )
                or 160
            )
            empty_response_retry_max_attempts = (
                _parse_positive_int(
                    metadata.get("params", {}).get("empty_response_retry_max_attempts")
                )
                or 10
            )
            empty_response_retry_base_delay_ms = (
                _parse_positive_int(
                    metadata.get("params", {}).get(
                        "empty_response_retry_base_delay_ms"
                    )
                )
                or 200
            )
            empty_response_retry_max_delay_ms = (
                _parse_positive_int(
                    metadata.get("params", {}).get("empty_response_retry_max_delay_ms")
                )
                or 5000
            )
            empty_response_retry_jitter_ratio = _parse_non_negative_float(
                metadata.get("params", {}).get("empty_response_retry_jitter_ratio")
            )
            if empty_response_retry_jitter_ratio is None:
                empty_response_retry_jitter_ratio = 0.2
            empty_response_retry_jitter_ratio = max(
                0.0, min(1.0, empty_response_retry_jitter_ratio)
            )
            empty_response_retry_token_threshold = (
                _parse_positive_int(
                    metadata.get("params", {}).get(
                        "empty_response_retry_token_threshold"
                    )
                )
                or 2
            )
            continuation_seam_deltas = []

            if configured_max_length_continuations:
                log.info(
                    "[CONTINUE] Using explicit max_length_continuations=%s (model=%s)",
                    max_length_continuations,
                    model_id,
                )
            elif requested_max_tokens:
                log.info(
                    "[CONTINUE] Derived max_length_continuations=%s from max_tokens=%s, output_budget=%s, hard_cap=%s (model=%s)",
                    max_length_continuations,
                    requested_max_tokens,
                    auto_continue_output_budget,
                    auto_continue_hard_cap,
                    model_id,
                )

            base_continue_prompt = (
                metadata.get("params", {}).get("continue_prompt")
                or "Continue from where you left off. Do not repeat any text from the previous response. "
                "Your output will be appended directly to the prior message, so start with the very next character. "
                "Preserve boundary whitespace and punctuation exactly as intended. "
                "If the next character is a space, newline, or punctuation mark, output that exact character first. "
                "Do not collapse or omit spaces between words/numbers (for example, output 'to 140', not 'to140'). "
                "Do not add preambles or restate the last sentence."
            )
            length_finish_reasons = {
                "length",
                "max_tokens",
                "max_output_tokens",
                "content_length",
            }
            length_stop_reasons = {"length", "max_tokens", "max_output_tokens"}

            def should_continue_for_length(finish_reason, stop_reason):
                if not finish_reason and not stop_reason:
                    return False
                if finish_reason and str(finish_reason).lower() in length_finish_reasons:
                    return True
                if stop_reason and str(stop_reason).lower() in length_stop_reasons:
                    return True
                return False

            def get_text_content(blocks):
                return "".join(
                    b.get("content", "")
                    for b in blocks
                    if b.get("type") == "text" and isinstance(b.get("content"), str)
                )

            def get_anomaly_state():
                if should_continue_for_length(last_finish_reason, last_stop_reason):
                    return {
                        "should_retry": False,
                        "whitespace_only": False,
                        "ultra_short": False,
                        "content_len": 0,
                    }

                stop_reason_normalized = str(last_stop_reason or "").lower()
                finish_reason_normalized = str(last_finish_reason or "").lower()
                if (
                    stop_reason_normalized == "client_disconnect"
                    or stop_reason_normalized == "incomplete_stream"
                    or finish_reason_normalized == "tool_calls"
                ):
                    return {
                        "should_retry": False,
                        "whitespace_only": False,
                        "ultra_short": False,
                        "content_len": 0,
                    }

                if tool_calls:
                    return {
                        "should_retry": False,
                        "whitespace_only": False,
                        "ultra_short": False,
                        "content_len": 0,
                    }

                text_content = get_text_content(content_blocks)
                stripped_content = text_content.strip()
                whitespace_only = stripped_content == ""
                ultra_short = (
                    stripped_content != ""
                    and last_completion_tokens is not None
                    and last_completion_tokens <= empty_response_retry_token_threshold
                )

                return {
                    "should_retry": whitespace_only or ultra_short,
                    "whitespace_only": whitespace_only,
                    "ultra_short": ultra_short,
                    "content_len": len(text_content),
                }

            def get_anomaly_retry_backoff_ms(attempt_number):
                delay_ms = min(
                    empty_response_retry_max_delay_ms,
                    int(
                        empty_response_retry_base_delay_ms
                        * (2 ** max(0, attempt_number - 1))
                    ),
                )
                if delay_ms <= 0:
                    return 0
                if empty_response_retry_jitter_ratio <= 0:
                    return delay_ms
                jitter_factor = __import__("random").uniform(
                    -empty_response_retry_jitter_ratio,
                    empty_response_retry_jitter_ratio,
                )
                return max(0, int(delay_ms * (1 + jitter_factor)))

            last_assistant_message = None
            try:
                if form_data["messages"][-1]["role"] == "assistant":
                    last_assistant_message = get_last_assistant_message(
                        form_data["messages"]
                    )
            except Exception as e:
                pass

            content = (
                message.get("content", "")
                if message
                else last_assistant_message
                if last_assistant_message
                else ""
            )

            content_blocks = [
                {
                    "type": "text",
                    "content": content,
                }
            ]

            # Mid-turn steer promotions roll the loop onto a new outer message;
            # the previous outer's blocks + the consumed steer are folded here
            # (replay-only — never UI/persistence) so follow-up rounds keep the
            # model's context continuous. See fold_promoted_seam_into_replay.
            replay_seam_blocks: list[dict[str, Any]] = []
            followup_history_guard_mode = _followup_history_guard_mode()
            followup_required_user_anchors = set(
                collect_followup_user_message_anchors(form_data.get("messages", []))
            )
            followup_last_dispatched_count = 0
            if followup_history_guard_mode != "off":
                await _publish_chat_active_turn(
                    getattr(request.app.state, "redis", None),
                    metadata.get("chat_id"),
                    metadata.get("message_id"),
                )

            def get_continuation_seam_deltas() -> list[str]:
                if not continuation_seam_deltas:
                    return []

                selected_chunks = []
                remaining_chars = continuation_context_char_budget

                for chunk in reversed(continuation_seam_deltas):
                    if not isinstance(chunk, str) or chunk == "":
                        continue

                    if remaining_chars <= 0:
                        break

                    if len(chunk) > remaining_chars:
                        if selected_chunks:
                            break
                        chunk = chunk[-remaining_chars:]

                    selected_chunks.append(chunk)
                    remaining_chars -= len(chunk)

                return list(reversed(selected_chunks))

            def build_continue_prompt(current_content: str) -> str:
                prompt = base_continue_prompt
                if not isinstance(current_content, str) or current_content == "":
                    return prompt

                # Provide exact boundary suffix to reduce repetition/omission drift.
                suffix = current_content[-continuation_suffix_chars:]
                prompt += (
                    " The final exact suffix already emitted is: "
                    f"{json.dumps(suffix)}."
                    " Continue immediately after this suffix without repeating it."
                )

                seam_deltas = get_continuation_seam_deltas()
                if seam_deltas:
                    seam_context_text = "".join(seam_deltas)
                    seam_context_window = seam_context_text[
                        -continuation_context_char_budget:
                    ]
                    prompt += (
                        " The exact contiguous text immediately preceding truncation was: "
                        f"{json.dumps(seam_context_window)}."
                    )
                    prompt += (
                        " The immediately preceding non-reasoning streamed text deltas "
                        "(oldest to newest, exact strings) were: "
                        f"{json.dumps(seam_deltas)}."
                        " Continue with the very next characters after the final delta."
                    )

                # If the stream stopped right after opening a markdown code fence,
                # make continuation behavior explicit to avoid malformed fences.
                fence_match = re.search(r"(?:^|\\n)(```[A-Za-z0-9_-]*)\\s*$", current_content)
                if fence_match:
                    opener = fence_match.group(1)
                    prompt += (
                        " The previous output currently ends with a markdown code fence opener "
                        f"{json.dumps(opener)}."
                        " Continue inside this same code block by outputting a newline and code content next."
                        " Do not emit another code fence marker before code content."
                    )

                return prompt

            reasoning_tags_param = metadata.get("params", {}).get("reasoning_tags")
            DETECT_REASONING_TAGS = reasoning_tags_param is not False
            DETECT_INLINE_REASONING_TAGS = _should_detect_inline_reasoning_tags(
                reasoning_tags_param
            )
            DETECT_CODE_INTERPRETER = metadata.get("features", {}).get(
                "code_interpreter", False
            )

            reasoning_tags = []
            if DETECT_REASONING_TAGS:
                if (
                    isinstance(reasoning_tags_param, list)
                    and len(reasoning_tags_param) == 2
                ):
                    reasoning_tags = [
                        (reasoning_tags_param[0], reasoning_tags_param[1])
                    ]
                else:
                    reasoning_tags = DEFAULT_REASONING_TAGS

            def close_active_reasoning_block(
                reason: str, model: str | None = None
            ) -> bool:
                reasoning_block = content_blocks[-1] if content_blocks else None
                outcome = _finalize_or_prune_trailing_reasoning_block(content_blocks)
                if outcome == "none":
                    return False
                duration = (
                    reasoning_block.get("duration")
                    if outcome == "closed" and isinstance(reasoning_block, dict)
                    else None
                )
                if not content_blocks or content_blocks[-1].get("type") != "text":
                    content_blocks.append({"type": "text", "content": ""})

                model_id = model or form_data.get("model", "")
                log.info(
                    "[REASONING] model=%s %s reasoning block (%s) duration=%ss chat_id=%s message_id=%s",
                    model_id,
                    outcome,
                    reason,
                    duration,
                    metadata.get("chat_id"),
                    metadata.get("message_id"),
                )
                return True

            assistant_error_finalized = False

            def freeze_terminal_stream_content_blocks(
                *,
                stop_reason: str | None = None,
                error_message: str | None = None,
            ):
                nonlocal content

                now = time.time()
                close_active_reasoning_block(
                    stop_reason or "terminal",
                    form_data.get("model"),
                )
                _freeze_content_blocks_for_terminal_state(
                    content_blocks,
                    stop_reason=stop_reason,
                    error_message=error_message,
                    now=now,
                )

                if not content_blocks:
                    content_blocks.append({"type": "text", "content": ""})
                elif content_blocks[-1].get("type") != "text":
                    content_blocks.append({"type": "text", "content": ""})

                content = serialize_content_blocks(content_blocks)
                return content

            async def promote_consumed_steer_to_live_turn(
                *,
                steer_item: dict[str, Any],
                pending_state: dict[str, Any] | None,
                seam_reason: str,
            ) -> str | None:
                nonlocal content
                nonlocal content_blocks
                nonlocal last_finish_reason
                nonlocal last_stop_reason
                nonlocal last_completion_tokens
                nonlocal continuation_seam_deltas
                nonlocal streaming_tool_calls_block_index
                nonlocal replay_seam_blocks
                nonlocal followup_required_user_anchors

                chat_id = metadata.get("chat_id")
                current_assistant_message_id = metadata.get("message_id")
                if not chat_id or not current_assistant_message_id:
                    return None

                try:
                    chat_record = Chats.get_chat_by_id(chat_id)
                    if not chat_record or not isinstance(
                        getattr(chat_record, "chat", None), dict
                    ):
                        return None

                    selected_model_items = {}
                    current_model_id = model_id
                    current_model_name = (
                        model.get("name")
                        or (
                            metadata.get("model", {}).get("name")
                            if isinstance(metadata.get("model"), dict)
                            else None
                        )
                        or current_model_id
                    )
                    if current_model_id:
                        selected_model_items[current_model_id] = {
                            "name": current_model_name
                        }

                    finalized_content = freeze_terminal_stream_content_blocks(
                        stop_reason=seam_reason
                    )
                    finalized_content_blocks = copy.deepcopy(content_blocks)

                    next_chat_payload, inserted_user_message, inserted_assistant_messages = (
                        insert_background_dispatch_messages(
                            chat_payload=chat_record.chat,
                            prompt=steer_item.get("prompt") or "",
                            files=steer_item.get("files") or [],
                            selected_model_ids=[current_model_id],
                            selected_model_items=selected_model_items,
                            app_models=getattr(request.app.state, "MODELS", {}) or {},
                            parent_id=current_assistant_message_id,
                        )
                    )

                    inserted_assistant_message = (
                        inserted_assistant_messages[0]
                        if inserted_assistant_messages
                        and isinstance(inserted_assistant_messages[0], dict)
                        else None
                    )
                    if not inserted_user_message or not inserted_assistant_message:
                        return None

                    next_history = next_chat_payload.setdefault("history", {})
                    next_messages_map = next_history.setdefault("messages", {})
                    inserted_current_id = next_history.get("currentId")
                    current_assistant_message = next_messages_map.get(
                        current_assistant_message_id
                    )
                    if isinstance(current_assistant_message, dict):
                        current_assistant_message["content"] = finalized_content
                        current_assistant_message["contentBlocks"] = (
                            finalized_content_blocks
                        )
                        current_assistant_message["done"] = True
                        if seam_reason:
                            current_assistant_message["stop_reason"] = seam_reason
                        sync_flattened_message_with_history(
                            next_chat_payload, current_assistant_message_id
                        )

                    Chats.update_chat_by_id(chat_id, next_chat_payload)

                    persisted_chat_record = Chats.get_chat_by_id(chat_id)
                    persisted_chat_payload = (
                        getattr(persisted_chat_record, "chat", None)
                        if persisted_chat_record
                        else None
                    )
                    if not isinstance(persisted_chat_payload, dict):
                        log.warning(
                            "[PendingChatWork] Mid-turn steer promotion verification could not reload persisted chat payload chat_id=%s item_id=%s seam=%s",
                            chat_id,
                            steer_item.get("id"),
                            seam_reason,
                        )
                        return None

                    if not is_background_turn_branch_persisted(
                        chat_payload=persisted_chat_payload,
                        parent_message_id=current_assistant_message_id,
                        user_message=inserted_user_message,
                        assistant_messages=[inserted_assistant_message],
                        current_id=inserted_current_id,
                    ):
                        repaired_branch = (
                            repair_missing_background_turn_branch_in_chat_payload(
                                chat_payload=persisted_chat_payload,
                                parent_message_id=current_assistant_message_id,
                                user_message=inserted_user_message,
                                assistant_messages=[inserted_assistant_message],
                                current_id=inserted_current_id,
                            )
                        )
                        if repaired_branch:
                            Chats.update_chat_by_id(chat_id, persisted_chat_payload)
                            persisted_chat_record = Chats.get_chat_by_id(chat_id)
                            persisted_chat_payload = (
                                getattr(persisted_chat_record, "chat", None)
                                if persisted_chat_record
                                else None
                            )

                    if not is_background_turn_branch_persisted(
                        chat_payload=persisted_chat_payload,
                        parent_message_id=current_assistant_message_id,
                        user_message=inserted_user_message,
                        assistant_messages=[inserted_assistant_message],
                        current_id=inserted_current_id,
                    ):
                        log.warning(
                            "[PendingChatWork] Mid-turn steer promotion verification failed chat_id=%s item_id=%s parent_assistant_id=%s user_message_id=%s assistant_message_id=%s seam=%s",
                            chat_id,
                            steer_item.get("id"),
                            current_assistant_message_id,
                            inserted_user_message.get("id"),
                            inserted_assistant_message.get("id"),
                            seam_reason,
                        )
                        return None

                    await event_emitter(
                        {
                            "type": "chat:completion",
                            "data": {
                                "done": True,
                                "content": finalized_content,
                                "contentBlocks": finalized_content_blocks,
                                "stop_reason": seam_reason,
                            },
                        }
                    )

                    if sio is not None:
                        try:
                            await emit_background_turn_inserted(
                                sio=sio,
                                user_id=user.id,
                                chat_id=chat_id,
                                user_message=inserted_user_message,
                                assistant_messages=[inserted_assistant_message],
                                current_id=next_history.get("currentId"),
                                pending_work_state=pending_state,
                                item_kind="steer",
                                item_id=steer_item.get("id"),
                            )
                        except Exception as error:
                            log.warning(
                                "[PendingChatWork] Failed to emit mid-turn steer insertion event for chat_id=%s item_id=%s: %s",
                                chat_id,
                                steer_item.get("id"),
                                error,
                            )

                    metadata["parent_message"] = copy.deepcopy(inserted_user_message)
                    metadata["parent_message_id"] = inserted_user_message.get("id")
                    metadata.update(
                        _user_message_anchor_updates(inserted_user_message.get("id"))
                    )
                    metadata["message_id"] = inserted_assistant_message.get("id")

                    # Fold the finalized pre-steer turn + the consumed steer
                    # into the replay-only seam BEFORE resetting stream state:
                    # without this, both exist only in the persisted chat
                    # record (which no mid-loop path reads) and the next round
                    # replays a stale transcript (incident c0127a20, 224->106
                    # messages).
                    replay_seam_blocks = fold_promoted_seam_into_replay(
                        replay_seam_blocks,
                        finalized_content_blocks,
                        steer_item,
                    )
                    steer_request_message, _steer_files = (
                        pending_work_item_to_request_message(steer_item)
                    )
                    followup_required_user_anchors.update(
                        collect_followup_user_message_anchors(
                            [steer_request_message]
                        )
                    )
                    await _publish_chat_active_turn(
                        getattr(request.app.state, "redis", None),
                        chat_id,
                        metadata.get("message_id"),
                    )

                    content = ""
                    content_blocks = [{"type": "text", "content": ""}]
                    last_finish_reason = None
                    last_stop_reason = None
                    last_completion_tokens = 0
                    continuation_seam_deltas = []
                    streaming_tool_calls_block_index = None

                    log.info(
                        "[PendingChatWork] Promoted mid-turn steer into live history chat_id=%s item_id=%s parent_assistant_id=%s user_message_id=%s assistant_message_id=%s seam=%s",
                        chat_id,
                        steer_item.get("id"),
                        current_assistant_message_id,
                        inserted_user_message.get("id"),
                        inserted_assistant_message.get("id"),
                        seam_reason,
                    )
                    inserted_user_message_id = inserted_user_message.get("id")
                    return (
                        inserted_user_message_id
                        if isinstance(inserted_user_message_id, str)
                        and inserted_user_message_id.strip()
                        else None
                    )
                except Exception as error:
                    log.warning(
                        "[PendingChatWork] Failed to promote consumed steer into live turn chat_id=%s item_id=%s seam=%s: %s",
                        chat_id,
                        steer_item.get("id"),
                        seam_reason,
                        error,
                    )
                    return None

            async def restore_failed_mid_turn_steer(
                *,
                steer_item: dict[str, Any],
                error_reason: str,
            ) -> dict[str, Any] | None:
                chat_id = metadata.get("chat_id")
                if not chat_id:
                    return None

                redis_client = getattr(request.app.state, "redis", None)
                try:
                    restored_state = await restore_pending_chat_item_after_dispatch_failure(
                        redis_client,
                        chat_id,
                        item=steer_item,
                        error=error_reason,
                    )
                except Exception as error:
                    log.warning(
                        "[PendingChatWork] Failed to restore consumed mid-turn steer chat_id=%s item_id=%s error=%s restore_error=%s",
                        chat_id,
                        steer_item.get("id"),
                        error_reason,
                        error,
                    )
                    return None

                if sio is not None:
                    try:
                        await emit_pending_chat_work_updated(
                            sio=sio,
                            user_id=user.id,
                            chat_id=chat_id,
                            state=restored_state,
                        )
                    except Exception as error:
                        log.warning(
                            "[PendingChatWork] Failed to emit restored steer state chat_id=%s item_id=%s: %s",
                            chat_id,
                            steer_item.get("id"),
                            error,
                        )

                return restored_state

            async def finalize_stream_assistant_error(
                error_source,
                *,
                stop_reason: str = "upstream_error",
                emit_completion_error: bool = False,
            ) -> str:
                nonlocal assistant_error_finalized
                nonlocal last_stop_reason

                error_message = normalize_terminal_error_message(error_source)
                if assistant_error_finalized:
                    return error_message

                assistant_error_finalized = True
                last_stop_reason = stop_reason
                frozen_content = freeze_terminal_stream_content_blocks(
                    stop_reason=stop_reason,
                    error_message=error_message,
                )

                await event_emitter(
                    {
                        "type": "chat:completion",
                        "data": {
                            "done": True,
                            "content": frozen_content,
                            "contentBlocks": content_blocks,
                            "stop_reason": stop_reason,
                        },
                    }
                )

                if emit_completion_error:
                    await event_emitter(
                        {
                            "type": "chat:completion",
                            "data": {
                                "error": {"message": error_message},
                            },
                        }
                    )

                await persist_terminal_assistant_error(
                    error_message,
                    stop_reason=stop_reason,
                    content=frozen_content,
                    content_blocks=content_blocks,
                )

                return error_message

            try:
                for event in events:
                    await event_emitter(
                        {
                            "type": "chat:completion",
                            "data": event,
                        }
                    )

                    # Save message in the database
                    Chats.upsert_message_to_chat_by_id_and_message_id(
                        metadata["chat_id"],
                        metadata["message_id"],
                        {
                            **event,
                        },
                    )

                streaming_tool_calls_block_index = None

                async def stream_body_handler(
                    response,
                    form_data,
                    suppress_reasoning_output: bool = False,
                ):
                    response_debug_metadata = current_debug_request_metadata(
                        form_data.get("metadata")
                    )
                    nonlocal content
                    nonlocal content_blocks
                    nonlocal last_finish_reason
                    nonlocal last_stop_reason
                    nonlocal last_completion_tokens
                    nonlocal continuation_seam_deltas
                    nonlocal streaming_tool_calls_block_index

                    def ensure_background_parent_message_present() -> None:
                        chat_id = metadata.get("chat_id")
                        parent_message_id = metadata.get("parent_message_id")
                        parent_message = metadata.get("parent_message")
                        if not chat_id or not parent_message_id or not isinstance(parent_message, dict):
                            return

                        try:
                            chat_record = Chats.get_chat_by_id(chat_id)
                            if not chat_record or not isinstance(getattr(chat_record, "chat", None), dict):
                                return

                            if repair_missing_parent_message_in_chat_payload(
                                chat_payload=chat_record.chat,
                                parent_message_id=parent_message_id,
                                parent_message=parent_message,
                            ):
                                Chats.update_chat_by_id(chat_id, chat_record.chat)
                                log.warning(
                                    "[PendingChatWork] Repaired missing parent message during stream save chat_id=%s parent_message_id=%s assistant_message_id=%s",
                                    chat_id,
                                    parent_message_id,
                                    metadata.get("message_id"),
                                )
                        except Exception as error:
                            log.warning(
                                "[PendingChatWork] Failed to repair missing parent message during stream save chat_id=%s parent_message_id=%s: %s",
                                chat_id,
                                parent_message_id,
                                error,
                            )

                    if ENABLE_REALTIME_CHAT_SAVE:
                        if metadata.get("chat_id") and metadata.get("message_id"):
                            if not metadata["chat_id"].startswith("local:"):
                                try:
                                    ensure_background_parent_message_present()
                                    Chats.upsert_message_to_chat_by_id_and_message_id(
                                        metadata["chat_id"],
                                        metadata["message_id"],
                                        {"done": False},
                                    )
                                    log.info(
                                        "[CHAT-STREAM] Set done=false at stream start chat_id=%s message_id=%s",
                                        metadata.get("chat_id"),
                                        metadata.get("message_id"),
                                    )
                                except Exception as e:
                                    log.warning(
                                        "[CHAT-STREAM] Failed to set done=false at stream start: %s",
                                        e,
                                    )

                    response_tool_calls = []
                    stream_finish_reason = None
                    stream_stop_reason = None
                    stream_completion_tokens = None
                    saved_finish_reason = None
                    saved_stop_reason = None
                    stream_generated_text_chars = 0
                    stream_generated_reasoning_chars = 0
                    had_completed_tool_results_before_stream = (
                        _has_completed_tool_results_block(content_blocks)
                    )

                    # Throttle realtime DB writes to every 2 seconds instead of every delta
                    _REALTIME_SAVE_INTERVAL = 2.0  # seconds
                    _last_realtime_save_time = 0.0

                    delta_count = 0
                    delta_chunk_size = max(
                        CHAT_RESPONSE_STREAM_DELTA_CHUNK_SIZE,
                        int(
                            metadata.get("params", {}).get("stream_delta_chunk_size")
                            or 1
                        ),
                    )
                    last_delta_data = None
                    last_effective_delta_chunk_size = delta_chunk_size
                    use_content_snapshot_for_pending_flush = False
                    continuation_first_chunk_logged = False

                    def get_effective_delta_chunk_size() -> int:
                        # Keep low-latency deltas early, then increase batch size as content grows.
                        # This reduces frontend render pressure for very long responses.
                        content_len = len(content) if isinstance(content, str) else 0
                        if content_len >= 160000:
                            return max(delta_chunk_size, 24)
                        if content_len >= 80000:
                            return max(delta_chunk_size, 16)
                        if content_len >= 30000:
                            return max(delta_chunk_size, 8)
                        if content_len >= 10000:
                            return max(delta_chunk_size, 4)
                        return delta_chunk_size
                    current_model = form_data.get("model", "")
                    model_lower = (
                        current_model.lower()
                        if isinstance(current_model, str)
                        else ""
                    )
                    is_gpt5 = isinstance(current_model, str) and "gpt-5" in model_lower
                    stream_attempt_snapshot = _build_stream_attempt_snapshot(
                        content=content,
                        content_blocks=content_blocks,
                        last_finish_reason=last_finish_reason,
                        last_stop_reason=last_stop_reason,
                        last_completion_tokens=last_completion_tokens,
                        continuation_seam_deltas=continuation_seam_deltas,
                        streaming_tool_calls_block_index=streaming_tool_calls_block_index,
                        tool_calls_queue_len=len(tool_calls),
                    )
                    tool_call_delta_count = 0
                    last_tool_call_id_by_index = {}
                    saw_reasoning_content = False
                    inline_reasoning_active = False
                    inline_reasoning_end_tag = None
                    pending_reasoning_prefix = ""
                    last_emitted_usage_snapshot = None
                    debug_monitor_usage = {}
                    ultra_audit_for_debug = None
                    ultra_requested = is_ultra_request(form_data)
                    debug_monitor_response_parts = []
                    debug_monitor_reasoning_parts = []
                    STREAM_TPS_LOG_INTERVAL_SEC = 5.0
                    stream_started_monotonic = time.monotonic()
                    stream_last_tps_log_monotonic = stream_started_monotonic
                    stream_last_tps_content_len = (
                        len(content) if isinstance(content, str) else 0
                    )
                    stream_last_tps_completion_tokens = 0
                    stream_total_deltas = 0
                    stream_total_content_chars = 0
                    stream_total_completion_events = 0
                    stream_total_usage_updates = 0

                    async def rollback_stream_attempt_for_retry(error_source) -> None:
                        nonlocal content
                        nonlocal content_blocks
                        nonlocal last_finish_reason
                        nonlocal last_stop_reason
                        nonlocal last_completion_tokens
                        nonlocal continuation_seam_deltas
                        nonlocal streaming_tool_calls_block_index

                        restored = _restore_stream_attempt_snapshot(
                            stream_attempt_snapshot
                        )
                        content = restored["content"]
                        content_blocks = restored["content_blocks"]
                        last_finish_reason = restored["last_finish_reason"]
                        last_stop_reason = restored["last_stop_reason"]
                        last_completion_tokens = restored["last_completion_tokens"]
                        continuation_seam_deltas = restored[
                            "continuation_seam_deltas"
                        ]
                        streaming_tool_calls_block_index = restored[
                            "streaming_tool_calls_block_index"
                        ]

                        restored_content = serialize_content_blocks(content_blocks)
                        await event_emitter(
                            {
                                "type": "chat:completion",
                                "data": {
                                    "done": False,
                                    "content": restored_content,
                                    "contentBlocks": content_blocks,
                                    "finish_reason": last_finish_reason,
                                    "stop_reason": last_stop_reason,
                                },
                            }
                        )

                        chat_id = metadata.get("chat_id")
                        message_id = metadata.get("message_id")
                        if chat_id and message_id and not chat_id.startswith("local:"):
                            try:
                                Chats.upsert_message_to_chat_by_id_and_message_id(
                                    chat_id,
                                    message_id,
                                    {
                                        "content": restored_content,
                                        "contentBlocks": content_blocks,
                                        "done": False,
                                        "finish_reason": last_finish_reason,
                                        "stop_reason": last_stop_reason,
                                    },
                                )
                            except Exception as e:
                                log.warning(
                                    "[STREAM] Failed to persist rollback before provider retry chat_id=%s message_id=%s error=%s",
                                    chat_id,
                                    message_id,
                                    e,
                                )

                        log.warning(
                            "[STREAM] model=%s rolled back retryable provider stream failure before tool execution chat_id=%s message_id=%s retry_reason=%s error=%s",
                            current_model,
                            metadata.get("chat_id"),
                            metadata.get("message_id"),
                            _retryable_chat_completion_error_reason(error_source),
                            _extract_error_message(error_source),
                        )

                    def get_completion_tokens_from_snapshot(snapshot) -> int:
                        if not isinstance(snapshot, dict):
                            return 0
                        try:
                            return int(snapshot.get("completion_tokens") or 0)
                        except Exception:
                            return 0

                    def maybe_log_stream_tps(force: bool = False, reason: str = "periodic"):
                        nonlocal stream_last_tps_log_monotonic
                        nonlocal stream_last_tps_content_len
                        nonlocal stream_last_tps_completion_tokens

                        now = time.monotonic()
                        elapsed = now - stream_last_tps_log_monotonic
                        if not force and elapsed < STREAM_TPS_LOG_INTERVAL_SEC:
                            return
                        if elapsed <= 0:
                            return

                        current_content_len = (
                            len(content) if isinstance(content, str) else 0
                        )
                        delta_chars = max(
                            0, current_content_len - stream_last_tps_content_len
                        )

                        current_completion_tokens = get_completion_tokens_from_snapshot(
                            last_emitted_usage_snapshot
                        )
                        delta_completion_tokens = max(
                            0,
                            current_completion_tokens
                            - stream_last_tps_completion_tokens,
                        )

                        chars_per_sec = delta_chars / elapsed
                        approx_tps = (delta_chars / 4.0) / elapsed if delta_chars else 0.0
                        completion_tps = (
                            delta_completion_tokens / elapsed
                            if delta_completion_tokens
                            else 0.0
                        )
                        stream_elapsed = max(
                            0.0, now - stream_started_monotonic
                        )

                        log.info(
                            "[STREAM-TPS] reason=%s model=%s chat_id=%s message_id=%s elapsed=%.1fs d_chars=%d chars_per_s=%.1f approx_tps=%.1f d_completion_tokens=%d completion_tps=%.1f completion_tokens=%d total_deltas=%d total_chars=%d completion_events=%d usage_updates=%d",
                            reason,
                            current_model,
                            metadata.get("chat_id"),
                            metadata.get("message_id"),
                            stream_elapsed,
                            delta_chars,
                            chars_per_sec,
                            approx_tps,
                            delta_completion_tokens,
                            completion_tps,
                            current_completion_tokens,
                            stream_total_deltas,
                            stream_total_content_chars,
                            stream_total_completion_events,
                            stream_total_usage_updates,
                        )

                        stream_last_tps_log_monotonic = now
                        stream_last_tps_content_len = current_content_len
                        stream_last_tps_completion_tokens = current_completion_tokens

                    async def flush_pending_delta_data(threshold: int = 0):
                        nonlocal delta_count
                        nonlocal last_delta_data
                        nonlocal use_content_snapshot_for_pending_flush
                        nonlocal stream_total_completion_events

                        if delta_count >= threshold and last_delta_data:
                            payload = last_delta_data
                            if use_content_snapshot_for_pending_flush:
                                # In batched mode with realtime-save enabled, emit a coherent
                                # content snapshot instead of a lossy "last delta only" payload.
                                payload = {
                                    "content": serialize_content_blocks(content_blocks),
                                }
                                if content_blocks:
                                    payload["contentBlocks"] = content_blocks
                            await event_emitter(
                                {
                                    "type": "chat:completion",
                                    "data": payload,
                                }
                            )
                            stream_total_completion_events += 1
                            delta_count = 0
                            last_delta_data = None
                            use_content_snapshot_for_pending_flush = False

                    def strip_reasoning_tag_markers(text):
                        return _strip_reasoning_tag_markers(
                            text,
                            reasoning_tags=reasoning_tags,
                        )

                    def ensure_reasoning_block_open():
                        return _append_reasoning_text_to_content_blocks(
                            content_blocks, "", now=time.time()
                        )

                    def append_reasoning_block(reasoning_text):
                        _append_reasoning_text_to_content_blocks(
                            content_blocks, reasoning_text
                        )

                    def split_inline_reasoning_sections(text):
                        nonlocal inline_reasoning_active
                        nonlocal inline_reasoning_end_tag
                        (
                            cleaned_text,
                            reasoning_text,
                            changed,
                            opened_reasoning,
                            closed_reasoning,
                            next_inline_reasoning_active,
                            next_inline_reasoning_end_tag,
                        ) = _split_inline_reasoning_sections(
                            text,
                            inline_reasoning_active=inline_reasoning_active,
                            inline_reasoning_end_tag=inline_reasoning_end_tag,
                            reasoning_tags=reasoning_tags,
                            # Explicit model tags may span deltas. For the
                            # default tag set, line-start blocks are transport
                            # markup (they may span deltas too — e.g. Gemini's
                            # literal <think> sections); mid-line literals
                            # stay text.
                            allow_unmatched_start=DETECT_INLINE_REASONING_TAGS,
                            require_line_start=not DETECT_INLINE_REASONING_TAGS,
                            allow_unmatched_start_at_line_start=not DETECT_INLINE_REASONING_TAGS,
                            delta_at_line_start=_text_tail_at_line_boundary(
                                content_blocks
                            ),
                        )
                        inline_reasoning_active = next_inline_reasoning_active
                        inline_reasoning_end_tag = next_inline_reasoning_end_tag
                        return (
                            cleaned_text,
                            reasoning_text,
                            changed,
                            opened_reasoning,
                            closed_reasoning,
                        )

                    def extract_pending_start_tag_prefix(text):
                        return _extract_pending_reasoning_start_tag_prefix(
                            text,
                            reasoning_tags=reasoning_tags,
                            inline_reasoning_active=inline_reasoning_active,
                            # Default-tag mode only buffers line-start-anchored
                            # partial start tags; explicit tags keep buffering
                            # anywhere (pre-existing behavior).
                            require_line_start=not DETECT_INLINE_REASONING_TAGS,
                            at_line_start=_text_tail_at_line_boundary(
                                content_blocks
                            ),
                        )

                    def extract_pending_end_tag_suffix(text):
                        return _extract_pending_reasoning_end_tag_suffix(
                            text,
                            reasoning_tags=reasoning_tags,
                            inline_reasoning_end_tag=(
                                inline_reasoning_end_tag
                                if inline_reasoning_active
                                else None
                            ),
                        )

                    body_iterator_error = None
                    retryable_stream_error_event = None
                    try:
                        body_iterator = response.body_iterator.__aiter__()
                        while True:
                            try:
                                line = await body_iterator.__anext__()
                            except StopAsyncIteration:
                                break
                            line = (
                                line.decode("utf-8", "replace")
                                if isinstance(line, bytes)
                                else line
                            )
                            data = line

                            # Skip empty lines
                            if not data.strip():
                                continue

                            # "data:" is the prefix for each event
                            if not data.startswith("data:"):
                                continue

                            # Remove the prefix
                            data = data[len("data:") :].strip()

                            try:
                                data = json.loads(data)

                                token = private_batch_token(data)
                                if token is not None:
                                    if not ultra_requested:
                                        raise UltraToolExecutionError(
                                            "Private Ultra control appeared on a non-Ultra stream"
                                        )
                                    data = await _execute_ultra_private_control(
                                        token,
                                        request=request,
                                        user=user,
                                        metadata=metadata,
                                        extra_params=extra_params,
                                        event_emitter=event_emitter,
                                    )

                                candidate_ultra_audit = (
                                    data.get("ultra_audit")
                                    if isinstance(data, dict)
                                    else None
                                )
                                if candidate_ultra_audit is not None:
                                    if not ultra_requested:
                                        raise UltraToolExecutionError(
                                            "Ultra audit appeared on a non-Ultra stream"
                                        )
                                    ultra_audit_for_debug = dict(
                                        sanitized_ultra_audit(candidate_ultra_audit)
                                    )
                                    if metadata.get("chat_id") and metadata.get("message_id"):
                                        if not metadata["chat_id"].startswith("local:"):
                                            Chats.upsert_message_to_chat_by_id_and_message_id(
                                                metadata["chat_id"],
                                                metadata["message_id"],
                                                {"ultra_audit": ultra_audit_for_debug},
                                            )

                                data, _ = await process_filter_functions(
                                    request=request,
                                    filter_functions=filter_functions,
                                    filter_type="stream",
                                    form_data=data,
                                    extra_params={"__body__": form_data, **extra_params},
                                )

                                if data:
                                    if "event" in data and not getattr(
                                        request.state, "direct", False
                                    ):
                                        await event_emitter(data.get("event", {}))

                                    if "selected_model_id" in data:
                                        model_id = data["selected_model_id"]
                                        Chats.upsert_message_to_chat_by_id_and_message_id(
                                            metadata["chat_id"],
                                            metadata["message_id"],
                                            {
                                                "selectedModelId": model_id,
                                            },
                                        )
                                        await event_emitter(
                                            {
                                                "type": "chat:completion",
                                                "data": data,
                                            }
                                        )
                                    else:
                                        choices = data.get("choices", [])

                                        finish_reason = (
                                            data.get("finish_reason")
                                            or data.get("finishReason")
                                        )
                                        stop_reason = (
                                            data.get("stop_reason") or data.get("stopReason")
                                        )
                                        if choices:
                                            choice0 = choices[0]
                                            finish_reason = (
                                                choice0.get("finish_reason")
                                                or choice0.get("finishReason")
                                                or finish_reason
                                            )
                                            stop_reason = (
                                                choice0.get("stop_reason")
                                                or choice0.get("stopReason")
                                                or stop_reason
                                            )
                                        if finish_reason or stop_reason:
                                            if finish_reason is not None:
                                                stream_finish_reason = finish_reason
                                            if stop_reason is not None:
                                                stream_stop_reason = stop_reason
                                            if (
                                                finish_reason != saved_finish_reason
                                                or stop_reason != saved_stop_reason
                                            ):
                                                log.info(
                                                    "[FINISH-REASON] model=%s finish_reason=%s stop_reason=%s",
                                                    current_model,
                                                    finish_reason,
                                                    stop_reason,
                                                )
                                                saved_finish_reason = finish_reason
                                                saved_stop_reason = stop_reason
                                            if metadata.get("chat_id") and metadata.get(
                                                "message_id"
                                            ):
                                                if not metadata["chat_id"].startswith(
                                                    "local:"
                                                ):
                                                    try:
                                                        Chats.upsert_message_to_chat_by_id_and_message_id(
                                                            metadata["chat_id"],
                                                            metadata["message_id"],
                                                            {
                                                                "finish_reason": stream_finish_reason,
                                                                "stop_reason": stream_stop_reason,
                                                            },
                                                        )
                                                    except Exception as e:
                                                        log.warning(
                                                            f"[FINISH-REASON] Failed to save finish_reason: {e}"
                                                        )

                                    # 17421
                                    # PORTICO PATCH: Extract usage from multiple possible locations
                                    usage = data.get("usage", {}) or {}
                                    # Claude/Bedrock models nest usage inside metadata
                                    if not usage:
                                        usage = (
                                            data.get("metadata", {}).get("usage", {})
                                            or {}
                                        )

                                    # PORTICO DEBUG: Log raw usage data
                                    if usage:
                                        usage_completion_tokens = usage.get(
                                            "completion_tokens"
                                        )
                                        if isinstance(usage_completion_tokens, int):
                                            stream_completion_tokens = (
                                                usage_completion_tokens
                                            )
                                        log.info(
                                            "[TOKEN_COUNTER_DEBUG] Raw usage extracted chat_id=%s message_id=%s model=%s usage=%s",
                                            metadata.get("chat_id"),
                                            metadata.get("message_id"),
                                            current_model,
                                            usage,
                                        )

                                    # PORTICO PATCH: Normalize field names to standard OpenAI format
                                    # Claude/Bedrock uses: inputTokens, outputTokens, totalTokens
                                    # OpenAI Responses API uses: input_tokens, output_tokens, total_tokens
                                    # Standard OpenAI uses: prompt_tokens, completion_tokens, total_tokens
                                    if usage:
                                        usage = _normalize_llm_debug_usage(usage)
                                        log.info(
                                            "[TOKEN_COUNTER_DEBUG] Normalized usage chat_id=%s message_id=%s model=%s usage=%s",
                                            metadata.get("chat_id"),
                                            metadata.get("message_id"),
                                            current_model,
                                            usage,
                                        )

                                    # PORTICO PATCH: Extract response cost from gateway metadata.
                                    response_cost = (
                                        data.get("hidden_params", {}).get(
                                            "response_cost"
                                        )
                                        or usage.get("cost")
                                        or 0
                                    )
                                    if isinstance(response_cost, dict):
                                        response_cost = (
                                            response_cost.get("total_cost")
                                            or response_cost.get("value")
                                            or 0
                                        )
                                    if response_cost:
                                        usage["cost"] = response_cost
                                        log.info(
                                            "[TOKEN_COUNTER_DEBUG] Extracted response cost chat_id=%s message_id=%s model=%s cost=%s",
                                            metadata.get("chat_id"),
                                            metadata.get("message_id"),
                                            current_model,
                                            response_cost,
                                        )

                                    usage.update(data.get("timings", {}))  # llama.cpp

                                    def _safe_int(value):
                                        try:
                                            return int(value or 0)
                                        except Exception:
                                            return 0

                                    def _safe_float(value):
                                        try:
                                            return float(value or 0)
                                        except Exception:
                                            return 0.0

                                    usage_snapshot = {
                                        "prompt_tokens": _safe_int(
                                            usage.get("prompt_tokens")
                                        ),
                                        "completion_tokens": _safe_int(
                                            usage.get("completion_tokens")
                                        ),
                                        "total_tokens": _safe_int(
                                            usage.get("total_tokens")
                                        ),
                                        "cached_tokens": _safe_int(
                                            usage.get("cached_tokens")
                                        ),
                                        "cache_read_input_tokens": _safe_int(
                                            usage.get("cache_read_input_tokens")
                                        ),
                                        "cache_creation_input_tokens": _safe_int(
                                            usage.get("cache_creation_input_tokens")
                                        ),
                                        "cache_write_input_tokens": _safe_int(
                                            usage.get("cache_write_input_tokens")
                                        ),
                                        "reasoning_tokens": _safe_int(
                                            usage.get("reasoning_tokens")
                                        ),
                                        "cost": _safe_float(usage.get("cost")),
                                    }
                                    debug_monitor_usage = usage_snapshot

                                    has_usage_tokens = (
                                        usage_snapshot["prompt_tokens"] > 0
                                        or usage_snapshot["completion_tokens"] > 0
                                        or usage_snapshot["total_tokens"] > 0
                                    )

                                    if usage and has_usage_tokens:
                                        if usage_snapshot != last_emitted_usage_snapshot:
                                            last_emitted_usage_snapshot = usage_snapshot
                                            stream_total_usage_updates += 1
                                            log.info(
                                                "[TOKEN_COUNTER_DEBUG] Emitting usage event chat_id=%s message_id=%s model=%s usage=%s",
                                                metadata.get("chat_id"),
                                                metadata.get("message_id"),
                                                current_model,
                                                usage,
                                            )
                                            await event_emitter(
                                                {
                                                    "type": "chat:completion",
                                                    "data": {
                                                        "usage": usage,
                                                    },
                                                }
                                            )
                                            stream_total_completion_events += 1
                                            # PORTICO PATCH: Save usage directly to database
                                            # This ensures subagent/headless chats capture usage data
                                            # (normally frontend saves this after receiving websocket event)
                                            if metadata.get("chat_id") and metadata.get(
                                                "message_id"
                                            ):
                                                if not metadata["chat_id"].startswith(
                                                    "local:"
                                                ):
                                                    try:
                                                        Chats.upsert_message_to_chat_by_id_and_message_id(
                                                            metadata["chat_id"],
                                                            metadata["message_id"],
                                                            {"usage": usage},
                                                        )
                                                        log.info(
                                                            "[TOKEN_COUNTER_DEBUG] 💾 Saved usage to DB chat_id=%s message_id=%s prompt_tokens=%s completion_tokens=%s total_tokens=%s",
                                                            metadata.get("chat_id"),
                                                            metadata.get("message_id"),
                                                            usage.get(
                                                                "prompt_tokens"
                                                            ),
                                                            usage.get(
                                                                "completion_tokens"
                                                            ),
                                                            usage.get("total_tokens"),
                                                        )
                                                    except Exception as e:
                                                        log.warning(
                                                            f"[TOKEN_COUNTER_DEBUG] Failed to save usage to DB: {e}"
                                                        )
                                    elif usage:
                                        log.info(
                                            "[TOKEN_COUNTER_DEBUG] Usage exists but no token counts chat_id=%s message_id=%s model=%s usage=%s",
                                            metadata.get("chat_id"),
                                            metadata.get("message_id"),
                                            current_model,
                                            usage,
                                        )

                                    if not choices:
                                        error = data.get("error", {})
                                        if error:
                                            if _should_retry_stream_error_event(
                                                error,
                                                tool_calls_queued_at_attempt_start=stream_attempt_snapshot.get(
                                                    "tool_calls_queue_len"
                                                ),
                                                current_tool_calls_queued=len(
                                                    tool_calls
                                                ),
                                            ):
                                                retryable_stream_error_event = error
                                                log.warning(
                                                    "[STREAM] model=%s retryable provider stream error before tool execution; deferring terminal persistence for upstream retry chat_id=%s message_id=%s text_chars=%d reasoning_chars=%d tool_call_deltas=%d retry_reason=%s error=%s",
                                                    current_model,
                                                    metadata.get("chat_id"),
                                                    metadata.get("message_id"),
                                                    stream_generated_text_chars,
                                                    stream_generated_reasoning_chars,
                                                    tool_call_delta_count,
                                                    _retryable_chat_completion_error_reason(error),
                                                    _extract_error_message(error),
                                                )
                                                break
                                            await finalize_stream_assistant_error(
                                                error,
                                                emit_completion_error=True,
                                            )
                                            return
                                        continue

                                    delta = choices[0].get("delta", {})
                                    suppressed_reasoning_only_delta = False
                                    reasoning_closed_this_delta = False
                                    force_delta_flush = False
                                    if suppress_reasoning_output and isinstance(
                                        delta, dict
                                    ):
                                        had_reasoning_delta = (
                                            _strip_reasoning_delta_fields(delta)
                                        )
                                        if had_reasoning_delta:
                                            if not delta:
                                                suppressed_reasoning_only_delta = True
                                    reasoning_details = None
                                    reasoning_status_marker = None
                                    reasoning_thinking_ms = None
                                    if (
                                        not suppress_reasoning_output
                                        and isinstance(delta, dict)
                                    ):
                                        reasoning_status_marker = delta.pop(
                                            "reasoning_status", None
                                        )
                                        reasoning_thinking_ms = delta.pop(
                                            "reasoning_thinking_ms", None
                                        )
                                        reasoning_details = delta.pop(
                                            "reasoning_details", None
                                        )
                                        if reasoning_details is not None and not delta:
                                            suppressed_reasoning_only_delta = True
                                    delta_tool_calls = delta.get("tool_calls", None)
                                    tool_call_only_delta = is_tool_call_only_delta(
                                        delta
                                    )

                                    if delta_tool_calls is not None:
                                        if isinstance(delta_tool_calls, list):
                                            tool_call_delta_count += len(
                                                delta_tool_calls
                                            )
                                            if delta_tool_calls:
                                                tool_call_summaries = []
                                                for delta_tool_call in delta_tool_calls:
                                                    if not isinstance(
                                                        delta_tool_call, dict
                                                    ):
                                                        tool_call_summaries.append(
                                                            {
                                                                "index": None,
                                                                "id": None,
                                                                "name": None,
                                                                "args_len": None,
                                                                "type": type(
                                                                    delta_tool_call
                                                                ).__name__,
                                                            }
                                                        )
                                                        continue
                                                    delta_fn = (
                                                        delta_tool_call.get(
                                                            "function", {}
                                                        )
                                                        if isinstance(
                                                            delta_tool_call, dict
                                                        )
                                                        else {}
                                                    )
                                                    delta_args = delta_fn.get(
                                                        "arguments", ""
                                                    )
                                                    if delta_args is None:
                                                        delta_args = ""
                                                    if not isinstance(delta_args, str):
                                                        delta_args = str(delta_args)
                                                    tool_call_summaries.append(
                                                        {
                                                            "index": delta_tool_call.get(
                                                                "index"
                                                            ),
                                                            "id": delta_tool_call.get(
                                                                "id"
                                                            ),
                                                            "name": delta_fn.get(
                                                                "name"
                                                            ),
                                                            "args_len": len(
                                                                delta_args
                                                            ),
                                                        }
                                                    )
                                                log.info(
                                                    "[TOOL-CALL-DELTA] model=%s count=%d tool_calls=%s",
                                                    current_model,
                                                    len(delta_tool_calls),
                                                    tool_call_summaries,
                                                )
                                            elif is_gpt5:
                                                log.info(
                                                    "[TOOL-CALL-DELTA] model=%s empty tool_calls list in delta",
                                                    current_model,
                                                )
                                        elif is_gpt5:
                                            log.info(
                                                "[TOOL-CALL-DELTA] model=%s tool_calls_type=%s",
                                                current_model,
                                                type(delta_tool_calls).__name__,
                                            )

                                    if delta_tool_calls:
                                        log.debug(
                                            f"[TOOL-CALL-STREAM] Received {len(delta_tool_calls)} delta_tool_calls"
                                        )
                                        for delta_tool_call in delta_tool_calls:
                                            tool_call_index = delta_tool_call.get(
                                                "index"
                                            )
                                            tool_call_id = delta_tool_call.get("id")

                                            # Extract delta values for logging
                                            delta_name = delta_tool_call.get(
                                                "function", {}
                                            ).get("name")
                                            delta_args = delta_tool_call.get(
                                                "function", {}
                                            ).get("arguments", "")
                                            delta_args_len = (
                                                len(delta_args) if delta_args else 0
                                            )

                                            if tool_call_id and tool_call_index is not None:
                                                previous_id = (
                                                    last_tool_call_id_by_index.get(
                                                        tool_call_index
                                                    )
                                                )
                                                if (
                                                    previous_id
                                                    and previous_id != tool_call_id
                                                ):
                                                    log.warning(
                                                        "[TOOL-CALL-STREAM] model=%s index reused with different id: index=%s old_id=%s new_id=%s",
                                                        current_model,
                                                        tool_call_index,
                                                        previous_id,
                                                        tool_call_id,
                                                    )
                                                last_tool_call_id_by_index[
                                                    tool_call_index
                                                ] = tool_call_id

                                            effective_tool_call_id = tool_call_id
                                            if (
                                                not effective_tool_call_id
                                                and tool_call_index is not None
                                            ):
                                                effective_tool_call_id = (
                                                    last_tool_call_id_by_index.get(
                                                        tool_call_index
                                                    )
                                                )
                                                if effective_tool_call_id:
                                                    delta_tool_call["id"] = (
                                                        effective_tool_call_id
                                                    )

                                            # Check if the tool call already exists
                                            current_response_tool_call = None
                                            if effective_tool_call_id:
                                                for (
                                                    response_tool_call
                                                ) in response_tool_calls:
                                                    if (
                                                        response_tool_call.get("id")
                                                        == effective_tool_call_id
                                                    ):
                                                        current_response_tool_call = (
                                                            response_tool_call
                                                        )
                                                        break

                                            if (
                                                current_response_tool_call is None
                                                and tool_call_index is not None
                                                and not effective_tool_call_id
                                            ):
                                                for (
                                                    response_tool_call
                                                ) in response_tool_calls:
                                                    if (
                                                        response_tool_call.get("index")
                                                        == tool_call_index
                                                    ):
                                                        current_response_tool_call = (
                                                            response_tool_call
                                                        )
                                                        break

                                            if current_response_tool_call is None:
                                                # Add the new tool call
                                                delta_tool_call.setdefault(
                                                    "function", {}
                                                )
                                                delta_tool_call[
                                                    "function"
                                                ].setdefault("name", "")
                                                delta_tool_call[
                                                    "function"
                                                ].setdefault("arguments", "")
                                                response_tool_calls.append(
                                                    delta_tool_call
                                                )
                                                log.debug(
                                                    f"[TOOL-CALL-STREAM] NEW tool_call index={tool_call_index}, id={delta_tool_call.get('id')}, name='{delta_name}', args_len={delta_args_len}"
                                                )
                                            else:
                                                # Update the existing tool call
                                                existing_name = (
                                                    current_response_tool_call.get(
                                                        "function", {}
                                                    ).get("name", "")
                                                )
                                                delta_arguments = (
                                                    delta_tool_call.get(
                                                        "function", {}
                                                    ).get("arguments")
                                                )

                                                # PORTICO PATCH: Use assignment (=) instead of append (+=) for tool names
                                                # GPT's Responses API may send the tool name in multiple streaming chunks,
                                                # which was causing doubled tool names like "skills_activate_skillskills_activate_skill"
                                                # Tool names should be set once, not accumulated
                                                if delta_name:
                                                    log.debug(
                                                        f"[TOOL-CALL-STREAM] UPDATE tool_call index={tool_call_index}, existing_name='{existing_name}', delta_name='{delta_name}'"
                                                    )
                                                    current_response_tool_call[
                                                        "function"
                                                    ]["name"] = delta_name

                                                if delta_arguments:
                                                    current_response_tool_call[
                                                        "function"
                                                    ][
                                                        "arguments"
                                                    ] += delta_arguments

                                        if not suppress_reasoning_output:
                                            if close_active_reasoning_block(
                                                "tool_call_delta", current_model
                                            ):
                                                reasoning_closed_this_delta = True

                                        if (
                                            tool_calls_ready_for_preview(
                                                response_tool_calls,
                                                metadata.get("tools", {}),
                                            )
                                            and streaming_tool_calls_block_index is None
                                        ):
                                            preview_names = [
                                                tc.get("function", {}).get("name", "")
                                                for tc in response_tool_calls
                                                if tc.get("function", {}).get(
                                                    "name", ""
                                                )
                                            ]
                                            content_blocks.append(
                                                {
                                                    "type": "tool_calls",
                                                    "content": build_tool_call_preview_content(
                                                        response_tool_calls
                                                    ),
                                                    "started_at": time.time(),
                                                    "streaming_preview": True,
                                                }
                                            )
                                            streaming_tool_calls_block_index = (
                                                len(content_blocks) - 1
                                            )
                                            data = {
                                                "content": serialize_content_blocks(
                                                    content_blocks
                                                ),
                                                "contentBlocks": content_blocks,
                                            }
                                            force_delta_flush = True
                                            log.info(
                                                "[TOOL-CALL-STREAM] model=%s published preparing state for tool_calls=%s",
                                                current_model,
                                                preview_names,
                                            )

                                    image_urls = get_image_urls(
                                        delta.get("images", []), request, metadata, user
                                    )
                                    if image_urls:
                                        message_files = Chats.add_message_files_by_id_and_message_id(
                                            metadata["chat_id"],
                                            metadata["message_id"],
                                            [
                                                {"type": "image", "url": url}
                                                for url in image_urls
                                            ],
                                        )

                                        await event_emitter(
                                            {
                                                "type": "files",
                                                "data": {"files": message_files},
                                            }
                                        )

                                    raw_delta_content = delta.get("content")
                                    value = raw_delta_content
                                    if value and DETECT_REASONING_TAGS:
                                        if pending_reasoning_prefix:
                                            value = pending_reasoning_prefix + value
                                            pending_reasoning_prefix = ""
                                        # A close tag split across deltas must
                                        # not leak into reasoning content: peel
                                        # a partial end-tag suffix and re-join
                                        # it with the next delta.
                                        (
                                            value,
                                            pending_end_tag_suffix,
                                        ) = extract_pending_end_tag_suffix(value)
                                        if suppress_reasoning_output:
                                            (
                                                cleaned_value,
                                                _inline_reasoning_text,
                                                stripped,
                                                _opened_reasoning,
                                                _closed_reasoning,
                                            ) = split_inline_reasoning_sections(value)
                                        else:
                                            (
                                                cleaned_value,
                                                inline_reasoning_text,
                                                stripped,
                                                opened_reasoning,
                                                closed_reasoning,
                                            ) = split_inline_reasoning_sections(value)
                                        if pending_end_tag_suffix:
                                            if inline_reasoning_active:
                                                # Capture still open: withhold
                                                # the fragment so the next
                                                # delta can complete the tag.
                                                pending_reasoning_prefix = (
                                                    pending_end_tag_suffix
                                                )
                                            else:
                                                cleaned_value = (
                                                    cleaned_value
                                                    + pending_end_tag_suffix
                                                )
                                        if not inline_reasoning_active:
                                            (
                                                cleaned_value,
                                                pending_prefix,
                                            ) = extract_pending_start_tag_prefix(
                                                cleaned_value
                                            )
                                            if pending_prefix:
                                                pending_reasoning_prefix = pending_prefix
                                                log.info(
                                                    "[REASONING-STRIP] model=%s buffered partial reasoning start tag (len=%d)",
                                                    current_model,
                                                    len(pending_prefix),
                                                )
                                        if suppress_reasoning_output:
                                            if stripped:
                                                log.info(
                                                    "[REASONING-STRIP] model=%s suppressed inline reasoning content during continuation",
                                                    current_model,
                                                )
                                        else:
                                            if opened_reasoning:
                                                ensure_reasoning_block_open()
                                            if inline_reasoning_text:
                                                saw_reasoning_content = True
                                                debug_monitor_reasoning_parts.append(
                                                    inline_reasoning_text
                                                )
                                                append_reasoning_block(
                                                    inline_reasoning_text
                                                )
                                                # Cross-delta captures append on
                                                # every delta; only log the
                                                # open/close transitions.
                                                if opened_reasoning or closed_reasoning:
                                                    log.info(
                                                        "[REASONING-STRIP] model=%s extracted inline reasoning content (%d chars)",
                                                        current_model,
                                                        len(inline_reasoning_text),
                                                    )
                                            if closed_reasoning and close_active_reasoning_block(
                                                "inline_reasoning_delta", current_model
                                            ):
                                                reasoning_closed_this_delta = True
                                            if stripped and not inline_reasoning_text:
                                                log.info(
                                                    "[REASONING-STRIP] model=%s stripped inline reasoning tags from assistant text",
                                                    current_model,
                                                )
                                            if (
                                                opened_reasoning
                                                or inline_reasoning_text
                                                or reasoning_closed_this_delta
                                            ):
                                                data = {
                                                    "content": serialize_content_blocks(
                                                        content_blocks
                                                    ),
                                                    "contentBlocks": content_blocks,
                                                }
                                                if (
                                                    opened_reasoning
                                                    or reasoning_closed_this_delta
                                                ):
                                                    force_delta_flush = True
                                        value = cleaned_value

                                    if reasoning_status_marker == "started":
                                        # Upstream signalled that silent reasoning
                                        # began; open the live thinking indicator
                                        # immediately instead of waiting for the
                                        # post-thinking summary burst.
                                        ensure_reasoning_block_open()
                                        data = {
                                            "content": serialize_content_blocks(
                                                content_blocks
                                            ),
                                            "contentBlocks": content_blocks,
                                        }
                                        force_delta_flush = True

                                    reasoning_content = (
                                        delta.get("reasoning_content")
                                        or delta.get("reasoning")
                                        or delta.get("thinking")
                                    )
                                    reasoning_details_text = (
                                        _extract_reasoning_details_text(
                                            reasoning_details
                                        )
                                    )
                                    if reasoning_details_text:
                                        suppressed_reasoning_only_delta = False
                                        reasoning_content = _merge_reasoning_delta_text(
                                            reasoning_content,
                                            reasoning_details_text,
                                        )
                                    if reasoning_content and not suppress_reasoning_output:
                                        saw_reasoning_content = True
                                        if DETECT_REASONING_TAGS:
                                            cleaned_reasoning, stripped = (
                                                strip_reasoning_tag_markers(
                                                    reasoning_content
                                                )
                                            )
                                            if stripped:
                                                log.info(
                                                    "[REASONING-STRIP] model=%s removed reasoning tag markers from reasoning_content chunk",
                                                    current_model,
                                                )
                                            reasoning_content = cleaned_reasoning
                                        if reasoning_content:
                                            debug_monitor_reasoning_parts.append(
                                                reasoning_content
                                            )
                                            stream_generated_reasoning_chars += len(
                                                reasoning_content
                                            )
                                        if reasoning_thinking_ms:
                                            # The upstream stream was silent for the
                                            # whole thinking phase; back-date the
                                            # block start by the bridge-measured
                                            # interval so elapsed/duration reflect
                                            # real thinking time.
                                            try:
                                                thinking_seconds = (
                                                    max(
                                                        0.0,
                                                        float(reasoning_thinking_ms),
                                                    )
                                                    / 1000.0
                                                )
                                            except (TypeError, ValueError):
                                                thinking_seconds = None
                                            if thinking_seconds:
                                                backdated = (
                                                    time.time() - thinking_seconds
                                                )
                                                last_block = (
                                                    content_blocks[-1]
                                                    if content_blocks
                                                    else None
                                                )
                                                if (
                                                    isinstance(last_block, dict)
                                                    and last_block.get("type")
                                                    == "reasoning"
                                                    and last_block.get("ended_at")
                                                    is None
                                                ):
                                                    last_block["started_at"] = min(
                                                        last_block.get(
                                                            "started_at", backdated
                                                        ),
                                                        backdated,
                                                    )
                                                else:
                                                    _append_reasoning_text_to_content_blocks(
                                                        content_blocks,
                                                        "",
                                                        now=backdated,
                                                    )
                                        append_reasoning_block(reasoning_content)

                                        data = {
                                            "content": serialize_content_blocks(
                                                content_blocks
                                            ),
                                            "contentBlocks": content_blocks,
                                        }
                                    elif reasoning_content and suppress_reasoning_output:
                                        log.info(
                                            "[REASONING-STRIP] model=%s suppressed reasoning_content delta during continuation",
                                            current_model,
                                        )

                                    if value:
                                        if isinstance(value, str):
                                            debug_monitor_response_parts.append(value)
                                        if isinstance(value, str):
                                            stream_total_content_chars += len(value)
                                            stream_generated_text_chars += len(value)
                                            continuation_seam_deltas.append(value)
                                            if (
                                                len(continuation_seam_deltas)
                                                > continuation_context_chunk_count
                                            ):
                                                continuation_seam_deltas = (
                                                    continuation_seam_deltas[
                                                        -continuation_context_chunk_count:
                                                    ]
                                                )
                                        if (
                                            suppress_reasoning_output
                                            and not continuation_first_chunk_logged
                                            and isinstance(value, str)
                                        ):
                                            continuation_first_chunk_logged = True
                                            prev_tail = (
                                                content[-32:]
                                                if isinstance(content, str)
                                                else ""
                                            )
                                            raw_head = (
                                                raw_delta_content[:32]
                                                if isinstance(raw_delta_content, str)
                                                else raw_delta_content
                                            )
                                            cleaned_head = value[:32]
                                            warning_suffix = ""
                                            if (
                                                isinstance(prev_tail, str)
                                                and prev_tail
                                                and prev_tail[-1] in {",", ";", ":"}
                                                and value
                                                and not value[0].isspace()
                                                and value[0].isalnum()
                                            ):
                                                warning_suffix = " potential_missing_space_after_punctuation=true"
                                            log.info(
                                                "[CONTINUE-BOUNDARY] model=%s chat_id=%s message_id=%s prev_tail=%r raw_head=%r cleaned_head=%r%s",
                                                current_model,
                                                metadata.get("chat_id"),
                                                metadata.get("message_id"),
                                                prev_tail,
                                                raw_head,
                                                cleaned_head,
                                                warning_suffix,
                                            )
                                        if close_active_reasoning_block(
                                            "assistant_text_delta", current_model
                                        ):
                                            reasoning_closed_this_delta = True

                                        if ENABLE_CHAT_RESPONSE_BASE64_IMAGE_URL_CONVERSION:
                                            value = convert_markdown_base64_images(
                                                request,
                                                value,
                                                {
                                                    "chat_id": metadata.get(
                                                        "chat_id", None
                                                    ),
                                                    "message_id": metadata.get(
                                                        "message_id", None
                                                    ),
                                                },
                                                user,
                                            )

                                        content = f"{content}{value}"
                                        if not content_blocks:
                                            content_blocks.append(
                                                {
                                                    "type": "text",
                                                    "content": "",
                                                }
                                            )

                                        content_blocks[-1]["content"] = (
                                            content_blocks[-1]["content"] + value
                                        )

                                        if DETECT_REASONING_TAGS:
                                            content, content_blocks, _ = (
                                                tag_content_handler(
                                                    "solution",
                                                    DEFAULT_SOLUTION_TAGS,
                                                    content,
                                                    content_blocks,
                                                )
                                            )

                                        if DETECT_CODE_INTERPRETER:
                                            content, content_blocks, end = (
                                                tag_content_handler(
                                                    "code_interpreter",
                                                    DEFAULT_CODE_INTERPRETER_TAGS,
                                                    content,
                                                    content_blocks,
                                                )
                                            )

                                            if end:
                                                break

                                        if ENABLE_REALTIME_CHAT_SAVE:
                                            # Throttle DB writes to every _REALTIME_SAVE_INTERVAL seconds
                                            _now = time.time()
                                            if (_now - _last_realtime_save_time) >= _REALTIME_SAVE_INTERVAL:
                                                _last_realtime_save_time = _now
                                                log.info(
                                                    "[CHAT-SAVE-THROTTLED] 💾 SAVING MESSAGE chat_id=%s message_id=%s content_blocks=%d content_len=%d",
                                                    metadata.get("chat_id"),
                                                    metadata.get("message_id"),
                                                    len(content_blocks),
                                                    len(content) if isinstance(content, str) else 0,
                                                )

                                                Chats.upsert_message_to_chat_by_id_and_message_id(
                                                    metadata["chat_id"],
                                                    metadata["message_id"],
                                                    {
                                                        "content": serialize_content_blocks(
                                                            content_blocks
                                                        ),
                                                        "contentBlocks": content_blocks,  # Store structured data for proper reconstruction
                                                    },
                                                )
                                                log.info(
                                                    "[CHAT-SAVE-THROTTLED] 💾 SAVE COMPLETE chat_id=%s message_id=%s",
                                                    metadata.get("chat_id"),
                                                    metadata.get("message_id"),
                                                )
                                        else:
                                            data = {
                                                "content": serialize_content_blocks(
                                                    content_blocks
                                                ),
                                            }

                                        if reasoning_closed_this_delta:
                                            # Ensure frontend immediately receives reasoning
                                            # completion regardless of realtime-save mode.
                                            data = {
                                                "content": serialize_content_blocks(
                                                    content_blocks
                                                ),
                                                "contentBlocks": content_blocks,
                                            }
                                            force_delta_flush = True
                                            log.info(
                                                "[REASONING] model=%s forcing mid-stream content update for reasoning close chat_id=%s message_id=%s",
                                                current_model,
                                                metadata.get("chat_id"),
                                                metadata.get("message_id"),
                                            )

                                    if (
                                        reasoning_closed_this_delta
                                        and not force_delta_flush
                                    ):
                                        data = {
                                            "content": serialize_content_blocks(
                                                content_blocks
                                            ),
                                            "contentBlocks": content_blocks,
                                        }
                                        force_delta_flush = True
                                        log.info(
                                            "[REASONING] model=%s forcing mid-stream content update after non-text reasoning close chat_id=%s message_id=%s",
                                            current_model,
                                            metadata.get("chat_id"),
                                            metadata.get("message_id"),
                                        )

                                    if suppressed_reasoning_only_delta:
                                        continue
                                    if delta:
                                        if tool_call_only_delta and not force_delta_flush:
                                            maybe_log_stream_tps()
                                            continue

                                        delta_count += 1
                                        stream_total_deltas += 1
                                        effective_delta_chunk_size = (
                                            get_effective_delta_chunk_size()
                                        )
                                        use_content_snapshot_for_pending_flush = (
                                            ENABLE_REALTIME_CHAT_SAVE
                                            and effective_delta_chunk_size > 1
                                        )
                                        last_delta_data = data
                                        if (
                                            effective_delta_chunk_size
                                            != last_effective_delta_chunk_size
                                        ):
                                            log.info(
                                                "[STREAM] model=%s adaptive stream_delta_chunk_size=%d (base=%d content_len=%d)",
                                                current_model,
                                                effective_delta_chunk_size,
                                                delta_chunk_size,
                                                len(content)
                                                if isinstance(content, str)
                                                else 0,
                                            )
                                            last_effective_delta_chunk_size = (
                                                effective_delta_chunk_size
                                            )
                                        if force_delta_flush:
                                            await flush_pending_delta_data(1)
                                        elif (
                                            delta_count
                                            >= effective_delta_chunk_size
                                        ):
                                            await flush_pending_delta_data(
                                                effective_delta_chunk_size
                                            )
                                        maybe_log_stream_tps()
                                    else:
                                        await event_emitter(
                                            {
                                                "type": "chat:completion",
                                                "data": data,
                                            }
                                        )
                                        stream_total_completion_events += 1
                                        maybe_log_stream_tps()
                            except UltraToolExecutionError:
                                raise
                            except Exception as e:
                                done = "data: [DONE]" in line
                                if done:
                                    pass
                                else:
                                    log.debug(f"Error: {e}")
                                    continue
                    except asyncio.CancelledError:
                        raise
                    except Exception as e:
                        body_iterator_error = e
                        log.warning(
                            "[STREAM] model=%s chat_id=%s message_id=%s body iterator ended abnormally: %s",
                            current_model,
                            metadata.get("chat_id"),
                            metadata.get("message_id"),
                            e,
                        )
                    if retryable_stream_error_event is not None:
                        await rollback_stream_attempt_for_retry(
                            retryable_stream_error_event
                        )
                        raise RuntimeError(
                            _extract_error_message(retryable_stream_error_event)
                        )
                    if (
                        pending_reasoning_prefix
                        and not inline_reasoning_active
                        and not suppress_reasoning_output
                    ):
                        if not content_blocks:
                            content_blocks.append({"type": "text", "content": ""})
                        if content_blocks[-1]["type"] != "text":
                            content_blocks.append({"type": "text", "content": ""})
                        content_blocks[-1]["content"] = (
                            content_blocks[-1]["content"] + pending_reasoning_prefix
                        )
                        content = f"{content}{pending_reasoning_prefix}"
                        log.info(
                            "[REASONING-STRIP] model=%s flushed pending reasoning prefix at stream end",
                            current_model,
                        )
                    elif (
                        pending_reasoning_prefix
                        and inline_reasoning_active
                        and not suppress_reasoning_output
                    ):
                        # A withheld partial end-tag fragment belongs to the
                        # still-open capture; land it in the reasoning block so
                        # terminal freeze can close the block normally.
                        append_reasoning_block(pending_reasoning_prefix)
                        log.info(
                            "[REASONING-STRIP] model=%s flushed pending reasoning end-tag fragment into open reasoning block at stream end",
                            current_model,
                        )
                    elif pending_reasoning_prefix and suppress_reasoning_output:
                        log.info(
                            "[REASONING-STRIP] model=%s dropped pending reasoning prefix during continuation",
                            current_model,
                        )

                    await flush_pending_delta_data()
                    maybe_log_stream_tps(force=True, reason="final")

                    if body_iterator_error is not None and _should_synthesize_incomplete_stream_length(
                        response_tool_calls=response_tool_calls,
                        finish_reason=stream_finish_reason,
                        stop_reason=stream_stop_reason,
                        generated_text_chars=stream_generated_text_chars,
                        generated_reasoning_chars=stream_generated_reasoning_chars,
                        had_completed_tool_results_before_stream=had_completed_tool_results_before_stream,
                    ):
                        if _is_gpt5_responses_api_model(current_model):
                            stream_stop_reason = "incomplete_stream"
                            log.warning(
                                "[FINISH-REASON] model=%s interrupted stream ended without terminal reason; marking stop_reason='incomplete_stream' (text_chars=%d reasoning_chars=%d completed_tool_results=%s chat_id=%s message_id=%s)",
                                current_model,
                                stream_generated_text_chars,
                                stream_generated_reasoning_chars,
                                had_completed_tool_results_before_stream,
                                metadata.get("chat_id"),
                                metadata.get("message_id"),
                            )
                        else:
                            stream_finish_reason = "length"
                            log.warning(
                                "[FINISH-REASON] model=%s recovering interrupted stream with synthetic finish_reason='length' (text_chars=%d reasoning_chars=%d completed_tool_results=%s chat_id=%s message_id=%s)",
                                current_model,
                                stream_generated_text_chars,
                                stream_generated_reasoning_chars,
                                had_completed_tool_results_before_stream,
                                metadata.get("chat_id"),
                                metadata.get("message_id"),
                            )
                        body_iterator_error = None

                    if body_iterator_error is not None:
                        await finalize_stream_assistant_error(
                            body_iterator_error,
                            emit_completion_error=True,
                        )
                        return

                    if content_blocks:
                        # Clean up the last text block
                        if content_blocks[-1]["type"] == "text":
                            # Preserve exact text boundaries (including trailing spaces)
                            # to avoid continuation seam corruption across segments.
                            tail_text_content = content_blocks[-1].get("content", "")
                            if not isinstance(tail_text_content, str):
                                tail_text_content = str(tail_text_content)
                                content_blocks[-1]["content"] = tail_text_content

                            if tail_text_content == "":
                                content_blocks.pop()

                                if not content_blocks:
                                    content_blocks.append(
                                        {
                                            "type": "text",
                                            "content": "",
                                        }
                                    )

                        if content_blocks[-1]["type"] == "reasoning":
                            stream_end_reasoning_outcome = (
                                _finalize_or_prune_trailing_reasoning_block(
                                    content_blocks
                                )
                            )
                            if (
                                stream_end_reasoning_outcome == "pruned"
                                and not content_blocks
                            ):
                                content_blocks.append(
                                    {
                                        "type": "text",
                                        "content": "",
                                    }
                                )

                    if response_tool_calls:
                        # Log final accumulated tool calls from streaming (helps debug tool name issues)
                        tool_names = [
                            tc.get("function", {}).get("name", "unknown")
                            for tc in response_tool_calls
                        ]
                        log.info(
                            f"[TOOL-CALL-STREAM] Final accumulated tool_calls from stream: {tool_names}"
                        )
                        empty_args = []
                        for tool_call in response_tool_calls:
                            args = tool_call.get("function", {}).get("arguments", "")
                            if not args:
                                empty_args.append(
                                    {
                                        "index": tool_call.get("index"),
                                        "id": tool_call.get("id"),
                                        "name": tool_call.get("function", {}).get(
                                            "name"
                                        ),
                                    }
                                )
                        if empty_args:
                            log.warning(
                                "[TOOL-CALL-STREAM] model=%s tool_calls missing arguments after streaming: %s",
                                current_model,
                                empty_args,
                            )
                        (
                            should_defer_tool_calls,
                            incomplete_tool_calls,
                        ) = _should_defer_incomplete_tool_calls(
                            response_tool_calls=response_tool_calls,
                            tools=metadata.get("tools", {}),
                            finish_reason=stream_finish_reason,
                            stop_reason=stream_stop_reason,
                        )

                        if should_defer_tool_calls:
                            log.warning(
                                "[TOOL-CALL-STREAM] model=%s deferring incomplete tool_calls until continuation: %s",
                                current_model,
                                incomplete_tool_calls,
                            )
                        else:
                            tool_calls.append(response_tool_calls)
                    elif is_gpt5 and tool_call_delta_count == 0:
                        log.info(
                            "[TOOL-CALL-STREAM] model=%s no tool_calls observed in stream",
                            current_model,
                        )

                    if _is_empty_tool_call_terminal(
                        finish_reason=stream_finish_reason,
                        stop_reason=stream_stop_reason,
                        response_tool_calls=response_tool_calls,
                    ):
                        malformed_tool_use_error = {
                            "error": {
                                "type": "api_error",
                                "code": BEDROCK_MALFORMED_TOOL_USE_ERROR_KIND,
                                "message": (
                                    "Bedrock Converse bedrock_malformed_tool_use: "
                                    "stopReason=tool_use was emitted without a toolUse "
                                    "content block"
                                ),
                            }
                        }
                        log.warning(
                            "[TOOL-CALL-STREAM] model=%s rejected empty tool-call terminal "
                            "finish_reason=%s stop_reason=%s text_chars=%d "
                            "reasoning_chars=%d chat_id=%s message_id=%s",
                            current_model,
                            stream_finish_reason,
                            stream_stop_reason,
                            stream_generated_text_chars,
                            stream_generated_reasoning_chars,
                            metadata.get("chat_id"),
                            metadata.get("message_id"),
                        )
                        await rollback_stream_attempt_for_retry(
                            malformed_tool_use_error
                        )
                        raise RuntimeError(
                            _extract_error_message(malformed_tool_use_error)
                        )

                    # PORTICO PATCH: Synthesize finish_reason when stream ends without one
                    # When a stream dies (timeout, connection drop) without sending a
                    # finish_reason, auto-continue never triggers because
                    # should_continue_for_length() requires an explicit reason.
                    # If we received substantial content but no finish_reason, the
                    # model likely hit max_tokens or the connection was interrupted
                    # mid-generation. Synthesize 'length' so auto-continue can fire.
                    if not stream_finish_reason and not stream_stop_reason:
                        if _should_finalize_reasoning_only_incomplete_stream(
                            response_tool_calls=response_tool_calls,
                            finish_reason=stream_finish_reason,
                            stop_reason=stream_stop_reason,
                            generated_text_chars=stream_generated_text_chars,
                            generated_reasoning_chars=stream_generated_reasoning_chars,
                            had_completed_tool_results_before_stream=had_completed_tool_results_before_stream,
                        ):
                            log.warning(
                                "[FINISH-REASON] model=%s stream ended with reasoning-only output and no terminal event; finalizing as incomplete_stream (reasoning_chars=%d chat_id=%s message_id=%s)",
                                current_model,
                                stream_generated_reasoning_chars,
                                metadata.get("chat_id"),
                                metadata.get("message_id"),
                            )
                            await finalize_stream_assistant_error(
                                "Upstream model provider stream ended without a final response. Please retry.",
                                stop_reason="incomplete_stream",
                                emit_completion_error=True,
                            )
                            return
                        elif response_tool_calls:
                            # Tool call streams can end without finish_reason normally
                            log.debug(
                                "[FINISH-REASON] model=%s stream ended without finish_reason during tool calls (normal)",
                                current_model,
                            )
                        elif _is_gpt5_responses_api_model(current_model) and (
                            stream_generated_text_chars > 0
                            or stream_generated_reasoning_chars > 0
                            or had_completed_tool_results_before_stream
                        ):
                            stream_stop_reason = "incomplete_stream"
                            log.warning(
                                "[FINISH-REASON] model=%s stream ended without finish_reason after partial output; marking stop_reason='incomplete_stream' (text_chars=%d reasoning_chars=%d completed_tool_results=%s chat_id=%s message_id=%s)",
                                current_model,
                                stream_generated_text_chars,
                                stream_generated_reasoning_chars,
                                had_completed_tool_results_before_stream,
                                metadata.get("chat_id"),
                                metadata.get("message_id"),
                            )
                        elif _should_synthesize_incomplete_stream_length(
                            response_tool_calls=response_tool_calls,
                            finish_reason=stream_finish_reason,
                            stop_reason=stream_stop_reason,
                            generated_text_chars=stream_generated_text_chars,
                            generated_reasoning_chars=stream_generated_reasoning_chars,
                            had_completed_tool_results_before_stream=had_completed_tool_results_before_stream,
                        ):
                            generated_chars = (
                                stream_generated_text_chars
                                + stream_generated_reasoning_chars
                            )
                            stream_finish_reason = "length"
                            log.warning(
                                "[FINISH-REASON] model=%s stream ended without finish_reason after %d generated chars - synthesizing finish_reason='length' for auto-continue",
                                current_model,
                                generated_chars,
                            )
                        else:
                            log.warning(
                                "[FINISH-REASON] model=%s stream ended abnormally without finish_reason (text_chars=%d reasoning_chars=%d completed_tool_results=%s) - not triggering auto-continue",
                                current_model,
                                stream_generated_text_chars,
                                stream_generated_reasoning_chars,
                                had_completed_tool_results_before_stream,
                            )

                    last_finish_reason = stream_finish_reason
                    last_stop_reason = stream_stop_reason
                    if stream_completion_tokens is not None:
                        last_completion_tokens = stream_completion_tokens

                    if _should_publish_bifrost_debug_response(
                        response_debug_metadata
                    ):
                        try:
                            duration_ms = max(
                                0,
                                int(
                                    (time.monotonic() - stream_started_monotonic)
                                    * 1000
                                ),
                            )
                            published = await publish_response_complete(
                                session_id=response_debug_metadata.get(
                                    "session_id"
                                ),
                                chat_id=response_debug_metadata.get("chat_id"),
                                model=form_data.get("model", "unknown"),
                                usage=debug_monitor_usage,
                                finish_reason=(
                                    stream_finish_reason
                                    or stream_stop_reason
                                    or "stop"
                                ),
                                duration_ms=duration_ms,
                                has_tool_calls=len(response_tool_calls) > 0,
                                response_content="".join(debug_monitor_response_parts),
                                tool_calls=response_tool_calls,
                                thinking_content="".join(debug_monitor_reasoning_parts),
                                ultra_audit=ultra_audit_for_debug,
                                debug_request_id=response_debug_metadata.get(
                                    "debug_request_id"
                                ),
                                upstream_request_id=response_debug_metadata.get(
                                    "upstream_request_id"
                                ),
                                task_name=response_debug_metadata.get("task"),
                                request_phase=response_debug_metadata.get(
                                    "request_phase"
                                ),
                                followup_index=response_debug_metadata.get(
                                    "followup_index"
                                ),
                                outer_message_id=response_debug_metadata.get(
                                    "outer_message_id"
                                ),
                                trigger_message_id=response_debug_metadata.get(
                                    "trigger_message_id"
                                ),
                                transcript_anchor_kind=response_debug_metadata.get(
                                    "transcript_anchor_kind"
                                ),
                                transcript_anchor_message_id=response_debug_metadata.get(
                                    "transcript_anchor_message_id"
                                ),
                                transcript_anchor_tool_block_index=response_debug_metadata.get(
                                    "transcript_anchor_tool_block_index"
                                ),
                            )
                            if not published:
                                log.warning(
                                    "[LLM_DEBUG_MONITOR] Streaming response publish returned false chat_id=%s upstream_request_id=%s",
                                    response_debug_metadata.get("chat_id"),
                                    response_debug_metadata.get("upstream_request_id"),
                                )
                        except Exception as exc:
                            log.warning(
                                "[LLM_DEBUG_MONITOR] Failed to publish Bifrost streaming response: %s",
                                exc,
                            )

                    if response.background:
                        await response.background()

                async def run_chat_completion_with_transient_retries(
                    *,
                    label: str,
                    request_form_data: dict,
                    initial_response=None,
                    suppress_reasoning_output: bool = False,
                ):
                    attempt = 1
                    current_response = initial_response

                    while True:
                        if current_response is None:
                            if attempt > 1:
                                request_form_data["metadata"] = (
                                    _refresh_upstream_request_metadata(
                                        request_form_data.get("metadata")
                                    )
                                )
                            current_response = await generate_chat_completion(
                                request,
                                request_form_data,
                                user,
                            )
                            log.info(
                                "%s generate_chat_completion returned: %s",
                                label,
                                type(current_response).__name__,
                            )

                        if isinstance(current_response, StreamingResponse):
                            try:
                                await stream_body_handler(
                                    current_response,
                                    request_form_data,
                                    suppress_reasoning_output=suppress_reasoning_output,
                                )
                                if attempt > 1:
                                    await _emit_upstream_retry_status(
                                        event_emitter,
                                        description="Recovered after upstream retry",
                                        done=True,
                                        hidden=True,
                                    )
                                return True, None
                            except Exception as stream_err:
                                retry_reason = _retryable_chat_completion_error_reason(
                                    stream_err
                                )
                                retryable = retry_reason is not None
                                max_attempts = (
                                    _get_chat_completion_request_retry_max_attempts(
                                        stream_err,
                                        request_form_data,
                                    )
                                )
                                if _should_retry_chat_completion_attempt(
                                    stream_err,
                                    attempt=attempt,
                                    max_attempts=max_attempts,
                                ):
                                    delay_seconds = (
                                        _get_transient_chat_completion_retry_delay_seconds(
                                            attempt
                                        )
                                    )
                                    log.warning(
                                        "%s retryable streaming failure attempt=%d/%d delay=%.1fs retry_reason=%s error=%s",
                                        label,
                                        attempt,
                                        max_attempts,
                                        delay_seconds,
                                        retry_reason,
                                        normalize_terminal_error_message(stream_err),
                                    )
                                    await _emit_upstream_retry_status(
                                        event_emitter,
                                        description=f"Model provider stalled; retrying (attempt {attempt}/{max_attempts})",
                                        done=False,
                                    )
                                    if delay_seconds > 0:
                                        await asyncio.sleep(delay_seconds)
                                    attempt += 1
                                    current_response = None
                                    continue
                                if retryable:
                                    await _emit_upstream_retry_status(
                                        event_emitter,
                                        description="Model provider did not recover after retries",
                                        done=True,
                                        error=True,
                                    )
                                    return False, stream_err
                                raise

                        retry_reason = _retryable_chat_completion_error_reason(
                            current_response
                        )
                        if retry_reason is not None:
                            max_attempts = (
                                _get_chat_completion_request_retry_max_attempts(
                                    current_response,
                                    request_form_data,
                                )
                            )
                        else:
                            max_attempts = 0

                        if max_attempts and _should_retry_chat_completion_attempt(
                            current_response,
                            attempt=attempt,
                            max_attempts=max_attempts,
                        ):
                            delay_seconds = (
                                _get_transient_chat_completion_retry_delay_seconds(
                                    attempt
                                )
                            )
                            log.warning(
                                "%s retryable non-streaming response attempt=%d/%d delay=%.1fs retry_reason=%s error=%s",
                                label,
                                attempt,
                                max_attempts,
                                delay_seconds,
                                retry_reason,
                                normalize_terminal_error_message(current_response),
                            )
                            log_retryable_chat_completion_response(
                                label,
                                current_response,
                            )
                            await _emit_upstream_retry_status(
                                event_emitter,
                                description=f"Model provider stalled; retrying (attempt {attempt}/{max_attempts})",
                                done=False,
                            )
                            if delay_seconds > 0:
                                await asyncio.sleep(delay_seconds)
                            attempt += 1
                            current_response = None
                            continue

                        if max_attempts:
                            await _emit_upstream_retry_status(
                                event_emitter,
                                description="Model provider did not recover after retries",
                                done=True,
                                error=True,
                            )

                        return False, current_response

                async def process_tool_calls():
                    nonlocal streaming_tool_calls_block_index
                    nonlocal last_finish_reason, last_stop_reason
                    nonlocal followup_last_dispatched_count
                    tool_call_retries = 0

                    while (
                        len(tool_calls) > 0
                        and tool_call_retries < CHAT_RESPONSE_MAX_TOOL_CALL_RETRIES
                    ):
                        log.info(
                            f"[TOOL-CALL] Starting tool call iteration {tool_call_retries + 1}, tool_calls queue: {len(tool_calls)}"
                        )

                        tool_call_retries += 1

                        response_tool_calls = tool_calls.pop(0)
                        current_model = form_data.get("model", "")
                        response_tool_calls = normalize_tool_calls_for_execution(
                            response_tool_calls, current_model
                        )
                        log.info(
                            f"[TOOL-CALL] Processing {len(response_tool_calls)} tool calls: {[tc.get('function', {}).get('name') for tc in response_tool_calls]}"
                        )

                        close_active_reasoning_block("tool_call_execution_start", current_model)
                        tool_execution_start_time = time.time()
                        if (
                            streaming_tool_calls_block_index is not None
                            and 0 <= streaming_tool_calls_block_index < len(content_blocks)
                            and content_blocks[streaming_tool_calls_block_index].get("type")
                            == "tool_calls"
                            and content_blocks[streaming_tool_calls_block_index].get(
                                "streaming_preview"
                            )
                        ):
                            content_blocks[streaming_tool_calls_block_index].update(
                                {
                                    "content": response_tool_calls,
                                    "execution_started_at": tool_execution_start_time,
                                    "streaming_preview": False,
                                }
                            )
                            content_blocks[streaming_tool_calls_block_index].setdefault(
                                "started_at", tool_execution_start_time
                            )
                            tool_calls_block_index = streaming_tool_calls_block_index
                        else:
                            content_blocks.append(
                                {
                                    "type": "tool_calls",
                                    "content": response_tool_calls,
                                    "started_at": tool_execution_start_time,
                                    "execution_started_at": tool_execution_start_time,
                                    "streaming_preview": False,
                                }
                            )
                            tool_calls_block_index = len(content_blocks) - 1
                        streaming_tool_calls_block_index = None

                        tool_calls_content = serialize_content_blocks(content_blocks)
                        await event_emitter(
                            {
                                "type": "chat:completion",
                                "data": {
                                    "content": tool_calls_content,
                                },
                            }
                        )
                        if metadata.get("chat_id") and metadata.get("message_id"):
                            if not metadata["chat_id"].startswith("local:"):
                                try:
                                    Chats.upsert_message_to_chat_by_id_and_message_id(
                                        metadata["chat_id"],
                                        metadata["message_id"],
                                        {
                                            "content": tool_calls_content,
                                            "contentBlocks": content_blocks,
                                            "done": False,
                                        },
                                    )
                                    log.info(
                                        "[TOOL-CALL] Set done=false for chat_id=%s message_id=%s (tool call start)",
                                        metadata.get("chat_id"),
                                        metadata.get("message_id"),
                                    )
                                except Exception as e:
                                    log.warning(
                                        f"[TOOL-CALL] Failed to save in-progress tool_calls state: {e}"
                                    )

                        tools = metadata.get("tools", {})
                        is_subagent_chat = False
                        try:
                            redis = getattr(request.app.state, "redis", None)
                            chat_id = metadata.get("chat_id")
                            if redis and chat_id:
                                is_subagent_chat = bool(await redis.exists(f"subagent_chat:{chat_id}"))
                        except Exception as e:
                            log.warning(
                                "[TOOL-CALL] Failed to resolve delegated subagent state: %s",
                                e,
                            )

                        # Limit concurrent native tool calls to avoid overloading tool servers
                        native_tool_semaphore = asyncio.Semaphore(
                            GLOBAL_TOOL_EXECUTION_CONCURRENCY_LIMIT
                        )

                        async def execute_single_tool_call(tool_call):
                            tool_started_at = time.time()

                            async with native_tool_semaphore:
                                tool_call_id = tool_call.get("id", "")
                                tool_function_name = tool_call.get("function", {}).get(
                                    "name", ""
                                )
                                tool_args = tool_call.get("function", {}).get(
                                    "arguments", "{}"
                                )
                                tool_spec = _tool_spec_for_tool_name(
                                    tool_function_name,
                                    tools,
                                )
                                normalized_tool_args, tool_function_params, tool_args_parse_ok = (
                                    _normalize_tool_call_arguments_for_schema(
                                        tool_args,
                                        tool_name=tool_function_name,
                                        tool_spec=tool_spec,
                                    )
                                )
                                if normalized_tool_args != tool_args:
                                    tool_args = normalized_tool_args
                                    tool_call.setdefault("function", {})[
                                        "arguments"
                                    ] = normalized_tool_args
                                elif not tool_args or tool_args == "{}":
                                    log.warning(
                                        "[TOOL-CALL] Empty tool arguments before parsing: model=%s tool=%s id=%s",
                                        current_model,
                                        tool_function_name,
                                        tool_call_id,
                                    )

                                if not tool_args_parse_ok:
                                    log.error(
                                        f"Error parsing tool call arguments: {tool_args}"
                                    )

                                # Mutate the original tool call response params as they are passed back to the
                                # LLM via the content blocks, but only once we have a parseable object. If the
                                # stream was truncated mid-arguments, preserve the raw partial string instead of
                                # collapsing it to "{}" in chat history.
                                log.debug(
                                    f"Parsed args from {tool_args} to {tool_function_params}"
                                )
                                if tool_args_parse_ok:
                                    if (
                                        tool_function_name
                                        and "run_subagent" in tool_function_name
                                    ):
                                        if _optimization_flag_enabled(
                                            "subagent_auto_enable_code_execution",
                                            True,
                                        ):
                                            (
                                                skill_ids,
                                                tool_server_ids,
                                                augmented_subagent_tooling,
                                            ) = maybe_add_code_execution_to_subagent(
                                                skill_ids=tool_function_params.get(
                                                    "skill_ids"
                                                ),
                                                tool_server_ids=tool_function_params.get(
                                                    "tool_server_ids"
                                                ),
                                            )
                                            if augmented_subagent_tooling:
                                                tool_function_params["skill_ids"] = skill_ids
                                                tool_function_params["tool_server_ids"] = (
                                                    tool_server_ids
                                                )
                                                log.info(
                                                    "[TOOL-CALL] Auto-enabled code-execution/agent-vm for delegated subagent chat %s",
                                                    metadata.get("chat_id"),
                                                )
                                        tool_function_params = (
                                            _force_subagent_parent_context(
                                                tool_function_name,
                                                tool_function_params,
                                                tool_call_id,
                                                metadata,
                                            )
                                        )
                                        # Track subagent tool_call_ids for cleanup on parent cancel
                                        metadata.get("child_task_ids", set()).add(
                                            tool_call_id
                                        )
                                    tool_function_params = _force_cross_chat_context(
                                        tool_function_name,
                                        tool_function_params,
                                        metadata,
                                        tool_spec=tool_spec,
                                    )
                                    tool_call.setdefault("function", {})[
                                        "arguments"
                                    ] = json.dumps(tool_function_params)

                                tool_runtime_metadata = dict(metadata or {})
                                if tool_call_id:
                                    tool_runtime_metadata["tool_call_id"] = tool_call_id

                                tool_result = None
                                tool = None
                                tool_type = None
                                direct_tool = False
                                server_id = None

                                if tool_function_name not in tools:
                                    tool_result = _build_unavailable_tool_result(
                                        tool_function_name,
                                        is_subagent_chat=is_subagent_chat,
                                        lock_integrations=_optimization_flag_enabled(
                                            "subagent_integration_activation_restriction",
                                            True,
                                        ),
                                    )
                                    log.warning(
                                        "[TOOL-CALL] Tool %s not found in tools dict for chat %s",
                                        tool_function_name,
                                        metadata.get("chat_id"),
                                    )

                                if tool_function_name in tools:
                                    tool = tools[tool_function_name]
                                    spec = tool.get("spec", {})

                                    tool_type = tool.get("type", "")
                                    direct_tool = tool.get("direct", False)
                                    server_id = _resolve_tool_server_id(tool)
                                    if server_id:
                                        tool_runtime_metadata["server_id"] = server_id
                                        tool_runtime_metadata["server_is_core"] = bool(
                                            _load_server_metadata(server_id).get(
                                                "is_core", False
                                            )
                                        )
                                    try:
                                        tool_function_params, recovered_alias = (
                                            _normalize_single_required_string_argument_alias(
                                                tool_name=tool_function_name,
                                                tool_spec=spec,
                                                parsed_arguments=tool_function_params,
                                            )
                                        )
                                        if recovered_alias:
                                            tool_call.setdefault("function", {})[
                                                "arguments"
                                            ] = json.dumps(tool_function_params)

                                        allowed_params = (
                                            spec.get("parameters", {})
                                            .get("properties", {})
                                            .keys()
                                        )

                                        tool_function_params = {
                                            k: v
                                            for k, v in tool_function_params.items()
                                            if k in allowed_params
                                        }
                                        tool_function_params = (
                                            _normalize_current_chat_scoped_tool_arguments(
                                                tool_function_name=tool_function_name,
                                                tool=tool,
                                                tool_function_params=tool_function_params,
                                                metadata=metadata,
                                            )
                                        )
                                        tool_function_params = (
                                            _force_subagent_parent_context(
                                                tool_function_name,
                                                tool_function_params,
                                                tool_call_id,
                                                metadata,
                                            )
                                        )
                                        tool_function_params = (
                                            _force_cross_chat_context(
                                                tool_function_name,
                                                tool_function_params,
                                                metadata,
                                                tool_spec=spec,
                                            )
                                        )
                                        tool_call.setdefault("function", {})[
                                            "arguments"
                                        ] = json.dumps(tool_function_params)

                                        missing_required_arguments = (
                                            get_missing_required_tool_arguments(
                                                spec, tool_function_params
                                            )
                                        )

                                        if (
                                            not tool_args_parse_ok
                                            or missing_required_arguments
                                        ):
                                            log.warning(
                                                "[TOOL-CALL] Blocking incomplete tool call: model=%s tool=%s id=%s parse_ok=%s missing=%s completion_tokens=%s",
                                                current_model,
                                                tool_function_name,
                                                tool_call_id,
                                                tool_args_parse_ok,
                                                missing_required_arguments,
                                                last_completion_tokens,
                                            )
                                            tool_result = (
                                                _build_incomplete_tool_call_result(
                                                    tool_function_name=tool_function_name,
                                                    raw_arguments=tool_args,
                                                    parsed_arguments=tool_function_params,
                                                    missing_required_arguments=missing_required_arguments
                                                    or get_missing_required_tool_arguments(
                                                        spec, {}
                                                    ),
                                                    completion_tokens=last_completion_tokens,
                                                )
                                            )
                                        else:
                                            async def invoke_tool_once():
                                                if direct_tool:
                                                    return await _call_direct_tool_event(
                                                        event_caller=event_caller,
                                                        payload={
                                                            "type": "execute:tool",
                                                            "data": {
                                                                "id": str(uuid4()),
                                                                "name": tool_function_name,
                                                                "params": tool_function_params,
                                                                "server": tool.get(
                                                                    "server", {}
                                                                ),
                                                                "session_id": metadata.get(
                                                                    "session_id", None
                                                                ),
                                                            },
                                                        },
                                                        tool_function_name=tool_function_name,
                                                    )

                                                if tool_type == "mcp":
                                                    return await call_mcp_tool_with_runtime_headers(
                                                        client_factory=MCPClient,
                                                        request=request,
                                                        user=user,
                                                        server_id=tool["server_id"],
                                                        mcp_server_connection=tool[
                                                            "mcp_server_connection"
                                                        ],
                                                        extra_params=extra_params,
                                                        metadata=tool_runtime_metadata,
                                                        function_name=tool[
                                                            "original_name"
                                                        ],
                                                        function_args=tool_function_params,
                                                    )

                                                if tool_type == "external" and tool.get(
                                                    "tool_server_connection"
                                                ):
                                                    return await call_openapi_tool_with_runtime_headers(
                                                        execute_tool_server=execute_tool_server,
                                                        request=request,
                                                        user=user,
                                                        tool_server_connection=tool[
                                                            "tool_server_connection"
                                                        ],
                                                        tool_server_data=tool[
                                                            "tool_server_data"
                                                        ],
                                                        extra_params=extra_params,
                                                        metadata=tool_runtime_metadata,
                                                        function_name=tool[
                                                            "server_operation_name"
                                                        ],
                                                        function_args=tool_function_params,
                                                    )

                                                tool_function = get_updated_tool_function(
                                                    function=tool["callable"],
                                                    extra_params={
                                                        "__metadata__": metadata,
                                                        "__request__": request,
                                                        "__messages__": form_data.get(
                                                            "messages", []
                                                        ),
                                                        "__files__": metadata.get(
                                                            "files", []
                                                        ),
                                                    },
                                                )

                                                return await tool_function(
                                                    **tool_function_params
                                                )

                                            async def invoke_tool_with_transient_retries():
                                                # Native MCP retry ownership belongs to MCP ORC.
                                                # Other local/external tools keep the generic policy.
                                                max_attempts = (
                                                    1
                                                    if tool_type == "mcp"
                                                    else _get_transient_tool_execution_retry_max_attempts()
                                                )
                                                attempt = 1

                                                while True:
                                                    try:
                                                        result = await invoke_tool_once()
                                                        if (
                                                            _is_retryable_tool_execution_result(
                                                                result
                                                            )
                                                            and attempt < max_attempts
                                                        ):
                                                            delay_seconds = (
                                                                _get_transient_tool_execution_retry_delay_seconds(
                                                                    attempt
                                                                )
                                                            )
                                                            log.warning(
                                                                "[TOOL-CALL] Retryable tool execution result attempt=%d/%d tool=%s server=%s delay=%.1fs result=%s",
                                                                attempt,
                                                                max_attempts,
                                                                tool_function_name,
                                                                server_id,
                                                                delay_seconds,
                                                                _extract_error_message(
                                                                    result
                                                                ),
                                                            )
                                                            if delay_seconds > 0:
                                                                await asyncio.sleep(
                                                                    delay_seconds
                                                                )
                                                            attempt += 1
                                                            continue
                                                        return result
                                                    except Exception as invoke_err:
                                                        if (
                                                            not _is_retryable_tool_execution_error(
                                                                invoke_err
                                                            )
                                                            or attempt >= max_attempts
                                                        ):
                                                            raise
                                                        delay_seconds = (
                                                            _get_transient_tool_execution_retry_delay_seconds(
                                                                attempt
                                                            )
                                                        )
                                                        log.warning(
                                                            "[TOOL-CALL] Retryable tool execution failure attempt=%d/%d tool=%s server=%s delay=%.1fs error=%s",
                                                            attempt,
                                                            max_attempts,
                                                            tool_function_name,
                                                            server_id,
                                                            delay_seconds,
                                                            invoke_err,
                                                        )
                                                        if delay_seconds > 0:
                                                            await asyncio.sleep(
                                                                delay_seconds
                                                            )
                                                        attempt += 1

                                            if tool_result is None:
                                                # PORTICO PATCH (N-012):
                                                # per-action MCP write/action
                                                # confirmation gate at the
                                                # STREAMING dispatch site.
                                                #
                                                # Originally only the legacy
                                                # ``tool_call_handler`` path in
                                                # ``chat_completion_tools_handler``
                                                # went through
                                                # ``_apply_tool_confirmation_gate``.
                                                # The streaming hot path
                                                # (process_tool_calls ->
                                                # execute_single_tool_call ->
                                                # invoke_tool_with_transient_retries)
                                                # is what every modern MCP /
                                                # OpenAPI / direct / native
                                                # tool dispatch goes through,
                                                # and it was unprotected — a
                                                # Slack DM dispatched without a
                                                # confirmation chip in
                                                # production despite N-012.
                                                # See
                                                # ``tool_confirmation_gate.py``
                                                # and
                                                # ``docs/security-tool-confirmation.md``.
                                                #
                                                # Rebinding ``tool_function_params``
                                                # here propagates the gate's
                                                # arg-stripping (removal of
                                                # any ``confirmation_token``
                                                # leaked into params) into
                                                # ``invoke_tool_once`` via
                                                # closure name lookup.
                                                (
                                                    tool_function_params,
                                                    blocking_tool_result,
                                                ) = await _apply_tool_confirmation_gate(
                                                    chat_id=metadata.get("chat_id"),
                                                    user_id=user.id if user else None,
                                                    tool_function_name=tool_function_name,
                                                    tool_function_params=tool_function_params,
                                                    event_emitter=event_emitter,
                                                )
                                                if blocking_tool_result is not None:
                                                    tool_result = blocking_tool_result
                                                else:
                                                    tool_result = (
                                                        await invoke_tool_with_transient_retries()
                                                    )

                                    except Exception as e:
                                        tool_result = normalize_tool_execution_error(e)

                                tool_result, tool_result_files, tool_result_embeds = (
                                    await process_tool_result(
                                        request,
                                        tool_function_name,
                                        tool_result,
                                        tool_type,
                                        direct_tool,
                                        tool_runtime_metadata,
                                        user,
                                        server_id=server_id,
                                    )
                                )

                                tool_ended_at = time.time()
                                tool_duration = int(tool_ended_at - tool_started_at)
                                result_entry = {
                                    "tool_call_id": tool_call_id,
                                    "content": tool_result or "",
                                    "started_at": tool_started_at,
                                    "ended_at": tool_ended_at,
                                    "duration": tool_duration,
                                }
                                if server_id:
                                    result_entry["server_id"] = server_id
                                    result_entry["server_is_core"] = bool(
                                        tool_runtime_metadata.get("server_is_core", False)
                                    )
                                if tool_result_files:
                                    result_entry["files"] = tool_result_files
                                if tool_result_embeds:
                                    result_entry["embeds"] = tool_result_embeds

                                return result_entry

                        results = []

                        tasks = {
                            asyncio.create_task(execute_single_tool_call(tc)): tc
                            for tc in response_tool_calls
                        }

                        completed_count = 0
                        for completed_task in asyncio.as_completed(tasks.keys()):
                            try:
                                result_entry = await completed_task
                                completed_count += 1

                                if isinstance(result_entry, Exception):
                                    tool_call = tasks[completed_task]
                                    tool_ended_at = time.time()
                                    tool_duration = int(
                                        tool_ended_at - tool_execution_start_time
                                    )
                                    log.error(
                                        f"[TOOL-CALL] Tool call failed: {result_entry}"
                                    )
                                    result_entry = {
                                        "tool_call_id": tool_call.get("id", ""),
                                        "content": f"Error: {str(result_entry)}",
                                        "started_at": tool_execution_start_time,
                                        "ended_at": tool_ended_at,
                                        "duration": tool_duration,
                                    }

                                results.append(result_entry)

                                # PORTICO PATCH: Emit files event for inline image rendering
                                if result_entry.get("files"):
                                    await event_emitter(
                                        {
                                            "type": "files",
                                            "data": {
                                                "files": result_entry["files"],
                                            },
                                        }
                                    )

                                content_blocks[tool_calls_block_index]["results"] = results
                                merged_tool_result_files = (
                                    _collect_content_block_tool_result_files(content_blocks)
                                )

                                tool_calls_content = serialize_content_blocks(content_blocks)
                                await event_emitter(
                                    {
                                        "type": "chat:completion",
                                        "data": {
                                            "content": tool_calls_content,
                                        },
                                    }
                                )
                                if metadata.get("chat_id") and metadata.get("message_id"):
                                    if not metadata["chat_id"].startswith("local:"):
                                        try:
                                            tool_call_update = {
                                                "content": tool_calls_content,
                                                "contentBlocks": content_blocks,
                                                "done": False,
                                            }
                                            if merged_tool_result_files:
                                                tool_call_update["files"] = (
                                                    merged_tool_result_files
                                                )
                                            Chats.upsert_message_to_chat_by_id_and_message_id(
                                                metadata["chat_id"],
                                                metadata["message_id"],
                                                tool_call_update,
                                            )
                                            log.info(
                                                "[TOOL-CALL] Set done=false for chat_id=%s message_id=%s (tool call update %d/%d)",
                                                metadata.get("chat_id"),
                                                metadata.get("message_id"),
                                                completed_count,
                                                len(response_tool_calls),
                                            )
                                        except Exception as e:
                                            log.warning(
                                                f"[TOOL-CALL] Failed to save tool_call update: {e}"
                                            )

                                log.info(
                                    f"[TOOL-CALL] Emitting update ({completed_count}/{len(response_tool_calls)} tools completed)"
                                )
                                await asyncio.sleep(0)

                            except Exception as e:
                                completed_count += 1
                                tool_ended_at = time.time()
                                tool_duration = int(
                                    tool_ended_at - tool_execution_start_time
                                )
                                log.exception(f"[TOOL-CALL] Task failed: {e}")
                                try:
                                    tool_call = tasks[completed_task]
                                    results.append(
                                        {
                                            "tool_call_id": tool_call.get("id", ""),
                                            "content": f"Error: {str(e)}",
                                            "started_at": tool_execution_start_time,
                                            "ended_at": tool_ended_at,
                                            "duration": tool_duration,
                                        }
                                    )
                                except Exception as inner_e:
                                    log.error(
                                        f"[TOOL-CALL] Error handling task exception: {inner_e}"
                                    )
                                    results.append(
                                        {
                                            "tool_call_id": "unknown",
                                            "content": f"Error: {str(e)}",
                                            "started_at": tool_execution_start_time,
                                            "ended_at": tool_ended_at,
                                            "duration": tool_duration,
                                        }
                                    )

                        content_blocks[tool_calls_block_index]["ended_at"] = time.time()
                        tool_block_started_at = (
                            content_blocks[tool_calls_block_index].get(
                                "execution_started_at"
                            )
                            or content_blocks[tool_calls_block_index].get(
                                "started_at", time.time()
                            )
                        )
                        content_blocks[tool_calls_block_index]["duration"] = int(
                            content_blocks[tool_calls_block_index]["ended_at"]
                            - tool_block_started_at
                        )
                        log.info(
                            f"[TOOL-CALL] Tool execution completed. Results: {len(results)} results collected, duration: {content_blocks[tool_calls_block_index]['duration']}s"
                        )
                        for r in results:
                            log.info(
                                f"[TOOL-CALL]   - tool_call_id: {r.get('tool_call_id')}, content_length: {len(r.get('content', ''))}"
                            )

                        content_blocks.append(
                            {
                                "type": "text",
                                "content": "",
                            }
                        )

                        await event_emitter(
                            {
                                "type": "chat:completion",
                                "data": {
                                    "content": serialize_content_blocks(content_blocks),
                                },
                            }
                        )
                        log.info(
                            "[TOOL-CALL] Emitted chat:completion event with tool results"
                        )

                        # ========== DYNAMIC TOOL DISCOVERY ==========
                        # After tool execution, check Redis for newly-enabled tools.
                        # We only discover pending IDs here; actual spec loading happens
                        # after follow-up inlet filters rebuild TOOL_SERVER_CONNECTIONS.
                        dyn_chat_id = metadata.get("chat_id")
                        dyn_existing_ids = _coerce_tool_ids(metadata.get("tool_ids"))
                        dyn_pending_ids = []
                        followup_tool_refresh_ids = []
                        tooling_state_changed = False
                        try:
                            if dyn_chat_id:
                                dyn_pending_ids = await discover_pending_chat_tool_ids_from_redis(
                                    chat_id=dyn_chat_id,
                                    existing_tool_ids=dyn_existing_ids,
                                )

                                if dyn_pending_ids:
                                    log.info(
                                        "[DYNAMIC_TOOLS] Mid-turn pending tool activation: %s",
                                        dyn_pending_ids,
                                    )
                        except Exception as dyn_e:
                            log.warning(
                                f"[DYNAMIC_TOOLS] Error discovering pending tools: {dyn_e}"
                            )
                        try:
                            (
                                followup_tool_refresh_ids,
                                tooling_state_changed,
                            ) = _extract_followup_tool_refresh_ids(
                                response_tool_calls,
                                results,
                            )
                            if followup_tool_refresh_ids:
                                log.info(
                                    "[DYNAMIC_TOOLS] Follow-up tool refresh requested for: %s",
                                    followup_tool_refresh_ids,
                                )
                        except Exception as refresh_e:
                            log.warning(
                                "[DYNAMIC_TOOLS] Error extracting follow-up tool refresh ids: %s",
                                refresh_e,
                            )
                        followup_refresh_tool_ids = _merge_tool_ids(
                            dyn_pending_ids,
                            followup_tool_refresh_ids,
                        )
                        activation_scoped_refresh_ids = (
                            _coerce_tool_ids(followup_refresh_tool_ids)
                            if (tooling_state_changed or followup_tool_refresh_ids)
                            else []
                        )
                        # ========== END DYNAMIC TOOL DISCOVERY ==========

                        try:
                            log.info(
                                "[FOLLOW-UP] Creating new_form_data for follow-up request"
                            )
                            base_followup_messages = (
                                _ensure_internal_request_system_prompt_placeholder(
                                    _strip_replayed_model_system_prompt(
                                        _strip_legacy_tool_followup_system_message(
                                            form_data.get("messages", [])
                                        )
                                    )
                                )
                            )
                            followup_messages = build_followup_replay_messages(
                                base_followup_messages,
                                replay_seam_blocks,
                                content_blocks,
                                "tool_followup",
                                convert_content_blocks=convert_content_blocks_to_messages,
                            )
                            request_image_urls = _collect_agent_vm_request_image_urls(
                                response_tool_calls,
                                results,
                            )
                            if request_image_urls and not _model_supports_vision(
                                model
                            ):
                                # PORTICO-156: image pixels would be rejected by the
                                # upstream gateway; degrade to a text notice so
                                # the tool loop continues instead of the whole
                                # turn failing on dispatch.
                                log.info(
                                    "[FOLLOW-UP] Suppressing %d requested Agent VM image input(s): model does not accept image input hosts=%s",
                                    len(request_image_urls),
                                    _summarize_agent_vm_request_image_url_hosts(
                                        request_image_urls
                                    ),
                                )
                                request_images_followup_message = (
                                    _build_agent_vm_request_images_unavailable_message(
                                        request_image_urls
                                    )
                                )
                                request_image_urls = []
                            else:
                                request_images_followup_message = (
                                    _build_agent_vm_request_images_followup_message(
                                        request_image_urls
                                    )
                                )
                            followup_added_files = []
                            consumed_steer = None
                            promoted_steer_message_id = None
                            if metadata.get("chat_id"):
                                consumed_steer, pending_state = await consume_pending_steer(
                                    getattr(request.app.state, "redis", None),
                                    metadata["chat_id"],
                                )
                                if consumed_steer:
                                    promoted_steer_message_id = (
                                        await promote_consumed_steer_to_live_turn(
                                            steer_item=consumed_steer,
                                            pending_state=pending_state,
                                            seam_reason="tool_calls",
                                        )
                                    )
                                    if promoted_steer_message_id:
                                        followup_messages, followup_added_files = (
                                            inject_pending_steer_into_followup_messages(
                                                base_messages=followup_messages,
                                                steer_item=consumed_steer,
                                            )
                                        )
                                    else:
                                        await restore_failed_mid_turn_steer(
                                            steer_item=consumed_steer,
                                            error_reason="mid_turn_steer_promotion_failed",
                                        )
                            if request_images_followup_message:
                                followup_messages.append(request_images_followup_message)
                                log.info(
                                    "[FOLLOW-UP] Appended %d requested Agent VM image input(s) to follow-up request hosts=%s",
                                    max(
                                        0,
                                        len(
                                            request_images_followup_message.get(
                                                "content", []
                                            )
                                        )
                                        - 1,
                                    ),
                                    _summarize_agent_vm_request_image_url_hosts(
                                        request_image_urls
                                    ),
                                )
                            followup_replay_snapshot = [
                                dict(message) if isinstance(message, dict) else message
                                for message in followup_messages
                            ]
                            new_form_data = {**form_data}
                            followup_metadata = dict(
                                new_form_data.get("metadata")
                                if isinstance(new_form_data.get("metadata"), dict)
                                else {}
                            )
                            followup_metadata = _refresh_upstream_request_metadata(
                                followup_metadata,
                                {
                                    "request_phase": "tool_followup",
                                    "followup_index": tool_call_retries - 1,
                                    "message_id": metadata.get("message_id"),
                                    "outer_message_id": metadata.get("message_id"),
                                    **(
                                        _user_message_anchor_updates(
                                            promoted_steer_message_id
                                        )
                                        if promoted_steer_message_id
                                        else _assistant_tool_block_anchor_updates(
                                            metadata.get("message_id"),
                                            content_blocks,
                                        )
                                    ),
                                },
                            )
                            followup_metadata["tool_ids"] = (
                                await _merge_chat_attached_tool_ids_for_request(
                                    request=request,
                                    chat_id=followup_metadata.get("chat_id"),
                                    existing_tool_ids=followup_metadata.get(
                                        "tool_ids"
                                    ),
                                )
                            )
                            new_form_data.update(
                                {
                                    "model": model_id,
                                    "stream": True,
                                    "messages": followup_messages,
                                    "metadata": followup_metadata,
                                    "tool_ids": followup_metadata.get(
                                        "tool_ids", []
                                    ),
                                }
                            )
                            new_form_data["metadata"] = followup_metadata
                            if followup_added_files:
                                new_form_data["files"] = merge_top_level_files(
                                    form_data.get("files"),
                                    followup_added_files,
                                )
                                followup_metadata["files"] = new_form_data["files"]

                            followup_extra_params = {
                                **extra_params,
                                "__metadata__": followup_metadata,
                                "__is_followup_request__": True,
                                "__followup_phase__": "tool_followup",
                                "__preserve_dynamic_context__": False,
                            }
                            followup_models = (
                                {request.state.model["id"]: request.state.model}
                                if getattr(request.state, "direct", False)
                                and hasattr(request.state, "model")
                                else request.app.state.MODELS
                            )
                            new_form_data = await process_pipeline_inlet_filter(
                                request, new_form_data, user, followup_models
                            )
                            followup_filter_functions = [
                                Functions.get_function_by_id(filter_id)
                                for filter_id in get_sorted_filter_ids(
                                    request,
                                    model,
                                    followup_metadata.get("filter_ids", []),
                                )
                            ]
                            new_form_data, _ = await process_filter_functions(
                                request=request,
                                filter_functions=followup_filter_functions,
                                filter_type="inlet",
                                form_data=new_form_data,
                                extra_params=followup_extra_params,
                            )
                            if not isinstance(new_form_data.get("metadata"), dict):
                                new_form_data["metadata"] = {}
                            followup_runtime_metadata = dict(new_form_data["metadata"])
                            for key, value in followup_metadata.items():
                                followup_runtime_metadata.setdefault(key, value)
                            new_form_data["metadata"] = followup_runtime_metadata
                            followup_metadata = followup_runtime_metadata
                            new_form_data["messages"] = (
                                _strip_legacy_tool_followup_system_message(
                                    new_form_data.get("messages", [])
                                )
                            )
                            if followup_history_guard_mode != "off":
                                guard_redis = getattr(
                                    request.app.state, "redis", None
                                )
                                active_turn = await _read_chat_active_turn(
                                    guard_redis, metadata.get("chat_id")
                                )
                                if (
                                    active_turn
                                    and metadata.get("message_id")
                                    and active_turn != metadata.get("message_id")
                                ):
                                    log.warning(
                                        "[FOLLOW-UP][HISTORY-GUARD] Chat %s active turn moved to %s while %s is still looping; halting this loop (mode=%s)",
                                        metadata.get("chat_id"),
                                        active_turn,
                                        metadata.get("message_id"),
                                        followup_history_guard_mode,
                                    )
                                    if followup_history_guard_mode == "on":
                                        break
                                guard_verdict = verify_followup_history_fidelity(
                                    new_form_data.get("messages", []),
                                    followup_required_user_anchors,
                                    followup_last_dispatched_count,
                                )
                                if guard_verdict["count_regressed"]:
                                    log.warning(
                                        "[FOLLOW-UP][HISTORY-GUARD] Follow-up message count regressed %d -> %d chat_id=%s message_id=%s",
                                        followup_last_dispatched_count,
                                        guard_verdict["message_count"],
                                        metadata.get("chat_id"),
                                        metadata.get("message_id"),
                                    )
                                if not guard_verdict["ok"]:
                                    log.warning(
                                        "[FOLLOW-UP][HISTORY-GUARD] Outgoing follow-up lost %d previously-sent user message(s) chat_id=%s message_id=%s mode=%s",
                                        len(guard_verdict["missing_anchors"]),
                                        metadata.get("chat_id"),
                                        metadata.get("message_id"),
                                        followup_history_guard_mode,
                                    )
                                    if followup_history_guard_mode == "on":
                                        new_form_data["messages"] = (
                                            followup_replay_snapshot
                                        )
                                        log.warning(
                                            "[FOLLOW-UP][HISTORY-GUARD] Restored follow-up payload from pre-filter snapshot (%d messages)",
                                            len(followup_replay_snapshot),
                                        )
                            followup_last_dispatched_count = len(
                                new_form_data.get("messages", [])
                            )
                            try:
                                followup_messages = new_form_data.get("messages", [])
                                user_msg_count = sum(
                                    1
                                    for msg in followup_messages
                                    if msg.get("role") == "user"
                                )
                                system_msg_count = sum(
                                    1
                                    for msg in followup_messages
                                    if msg.get("role") == "system"
                                )
                                tool_msg_count = sum(
                                    1
                                    for msg in followup_messages
                                    if msg.get("role") == "tool"
                                )
                                assistant_tool_call_count = sum(
                                    1
                                    for msg in followup_messages
                                    if msg.get("role") == "assistant"
                                    and msg.get("tool_calls")
                                )
                                log.info(
                                    "[FOLLOW-UP] model=%s messages=%d system_msgs=%d user_msgs=%d tool_msgs=%d assistant_tool_calls=%d context_refresh=%s",
                                    new_form_data.get("model"),
                                    len(followup_messages),
                                    system_msg_count,
                                    user_msg_count,
                                    tool_msg_count,
                                    assistant_tool_call_count,
                                    True,
                                )
                            except Exception as e:
                                log.warning(
                                    "[FOLLOW-UP] Failed to summarize follow-up messages: %s",
                                    e,
                                )

                            # PORTICO PATCH: Load newly enabled tool specs directly into the
                            # follow-up request after follow-up filters rebuild
                            # chat-attached tool_ids and current system context.
                            followup_refresh_tool_ids = _merge_tool_ids(
                                followup_refresh_tool_ids,
                                _missing_followup_tool_ids_from_registry(
                                    _coerce_tool_ids(
                                        followup_metadata.get("tool_ids")
                                    ),
                                    followup_metadata.get("tools"),
                                ),
                            )
                            followup_chat_id = followup_metadata.get("chat_id")
                            if followup_refresh_tool_ids and followup_chat_id:
                                try:
                                    (
                                        loaded_tools,
                                        loaded_tool_ids,
                                        loaded_tool_specs,
                                        unresolved_tool_ids,
                                    ) = await _load_pending_tool_specs_after_inlet(
                                        request=request,
                                        pending_tool_ids=followup_refresh_tool_ids,
                                        user=user,
                                        extra_params=extra_params,
                                        model=model,
                                        form_data=new_form_data,
                                        metadata=followup_metadata,
                                        allow_targeted_refresh=bool(
                                            activation_scoped_refresh_ids
                                        ),
                                        targeted_refresh_tool_ids=activation_scoped_refresh_ids,
                                        refresh_reason="activation_followup",
                                    )

                                    if loaded_tools:
                                        _inject_loaded_tool_specs_into_followup_request(
                                            new_form_data=new_form_data,
                                            metadata=followup_metadata,
                                            existing_tool_ids=_coerce_tool_ids(
                                                followup_metadata.get("tool_ids")
                                            ),
                                            loaded_tools=loaded_tools,
                                            loaded_tool_ids=loaded_tool_ids,
                                            loaded_tool_specs=loaded_tool_specs,
                                        )
                                        log.info(
                                            "[DYNAMIC_TOOLS] Loaded pending tool servers mid-turn: %s",
                                            loaded_tool_ids,
                                        )

                                    if unresolved_tool_ids:
                                        new_form_data["messages"] = (
                                            add_or_update_system_message(
                                                _build_dynamic_tool_starting_system_message(
                                                    unresolved_tool_ids
                                                ),
                                                new_form_data.get("messages", []),
                                                append=True,
                                            )
                                        )
                                        log.warning(
                                            "[DYNAMIC_TOOLS] Could not load tool specs in current follow-up for %s",
                                            unresolved_tool_ids,
                                        )
                                except Exception as retry_e:
                                    log.warning(
                                        f"[DYNAMIC_TOOLS] Post-inlet tool loading error: {retry_e}"
                                    )

                            # PORTICO PATCH: Remove Open WebUI internal fields that shouldn't go to LLM API
                            # These fields are used by Open WebUI but cause errors when passed to the LLM API
                            owui_internal_fields = [
                                "tool_ids",
                                "files",
                                "tool_servers",
                                "features",
                                "variables",
                            ]
                            for field in owui_internal_fields:
                                new_form_data.pop(field, None)
                            log.debug(
                                f"[FOLLOW-UP] Removed internal fields from form_data: {owui_internal_fields}"
                            )
                            if "tools" in new_form_data or followup_metadata.get(
                                "tools"
                            ):
                                rebuilt_tools = _rebuild_followup_function_tools_payload(
                                    existing_tool_payloads=new_form_data.get(
                                        "tools", []
                                    ),
                                    metadata_tools=followup_metadata.get("tools"),
                                    model_name=new_form_data.get("model"),
                                    chat_id=followup_metadata.get("chat_id"),
                                )
                                if rebuilt_tools:
                                    new_form_data["tools"] = rebuilt_tools
                                    payload_tool_names = _tool_payload_function_names(
                                        rebuilt_tools
                                    )
                                    registry_tool_names = sorted(
                                        (followup_metadata.get("tools") or {}).keys()
                                    )
                                    if (
                                        payload_tool_names
                                        and sorted(payload_tool_names)
                                        != registry_tool_names
                                    ):
                                        log.warning(
                                            "[FOLLOW-UP] Provider payload / registry mismatch chat_id=%s message_id=%s payload_count=%d registry_count=%d",
                                            followup_metadata.get("chat_id"),
                                            followup_metadata.get("message_id"),
                                            len(payload_tool_names),
                                            len(registry_tool_names),
                                        )
                                if _is_gpt5_responses_api_model(
                                    new_form_data.get("model")
                                ):
                                    gpt_route_mode = _get_gpt_openai_route_mode()
                                    previous_namespace_meta = new_form_data.pop(
                                        "_tool_namespaces", None
                                    )
                                    ns_meta = _build_tool_namespace_metadata(
                                        followup_metadata.get("tools"),
                                        tool_ids=followup_metadata.get("tool_ids"),
                                    )
                                    if ns_meta:
                                        new_form_data["_tool_namespaces"] = (
                                            ns_meta
                                        )
                                        log.info(
                                            "[GPT_ROUTE] Attached GPT follow-up namespace metadata route=%s model=%s chat_id=%s message_id=%s entries=%d",
                                            gpt_route_mode,
                                            new_form_data.get("model"),
                                            followup_metadata.get("chat_id"),
                                            followup_metadata.get("message_id"),
                                            len(ns_meta),
                                        )
                                    elif previous_namespace_meta is not None:
                                        log.info(
                                            "[GPT_ROUTE] Cleared stale GPT follow-up namespace metadata route=%s model=%s chat_id=%s message_id=%s",
                                            gpt_route_mode,
                                            new_form_data.get("model"),
                                            followup_metadata.get("chat_id"),
                                            followup_metadata.get("message_id"),
                                        )

                            new_form_data["messages"] = (
                                _strip_legacy_tool_followup_system_message(
                                    new_form_data.get("messages", [])
                                )
                            )
                            try:
                                new_form_data = await convert_url_images_to_base64(
                                    new_form_data
                                )
                            except Exception as conversion_error:
                                image_input_count = 0
                                for message in new_form_data.get("messages", []):
                                    if not isinstance(message, dict):
                                        continue
                                    content = message.get("content")
                                    if not isinstance(content, list):
                                        continue
                                    image_input_count += sum(
                                        1
                                        for item in content
                                        if isinstance(item, dict)
                                        and item.get("type") == "image_url"
                                    )
                                log.warning(
                                    "[FOLLOW-UP] Failed to convert follow-up image inputs before dispatch chat_id=%s message_id=%s image_inputs=%d request_image_hosts=%s error=%s",
                                    followup_metadata.get("chat_id"),
                                    followup_metadata.get("message_id"),
                                    image_input_count,
                                    _summarize_agent_vm_request_image_url_hosts(
                                        request_image_urls
                                    ),
                                    _sanitize_workspace_image_conversion_log_error(
                                        conversion_error
                                    ),
                                )
                                await finalize_stream_assistant_error(
                                    _format_agent_vm_request_images_conversion_error(
                                        conversion_error
                                    ),
                                    stop_reason="tool_followup_image_error",
                                    emit_completion_error=True,
                                )
                                break

                            # Log details about the follow-up request
                            log.info(
                                f"[FOLLOW-UP] Calling generate_chat_completion for follow-up request (iteration {tool_call_retries})"
                            )
                            log.info(
                                f"[FOLLOW-UP] new_form_data model: {new_form_data.get('model')}"
                            )
                            log.info(
                                f"[FOLLOW-UP] new_form_data stream: {new_form_data.get('stream')}"
                            )
                            log.info(
                                f"[FOLLOW-UP] new_form_data messages count: {len(new_form_data.get('messages', []))}"
                            )
                            retry_ok, retry_response = (
                                await run_chat_completion_with_transient_retries(
                                    label="[FOLLOW-UP]",
                                    request_form_data=new_form_data,
                                )
                            )
                            if retry_ok:
                                log.info("[FOLLOW-UP] stream handling completed")
                            else:
                                terminal_stop_reason = (
                                    _terminal_stop_reason_for_chat_completion_error(
                                        retry_response
                                    )
                                )
                                error_message = _format_error_message(
                                    _extract_error_message(retry_response)
                                )
                                log_retryable_chat_completion_response(
                                    "[FOLLOW-UP]",
                                    retry_response,
                                )
                                if error_message:
                                    await finalize_stream_assistant_error(
                                        error_message,
                                        stop_reason=terminal_stop_reason,
                                        emit_completion_error=True,
                                    )
                                log.info(
                                    "[FOLLOW-UP] Non-streaming response received, breaking loop"
                                )
                                break
                        except Exception as e:
                            log.error(
                                f"[FOLLOW-UP] Exception in follow-up request handling: {e}"
                            )
                            log.debug(e)
                            break

                    if (
                        len(tool_calls) > 0
                        and tool_call_retries >= CHAT_RESPONSE_MAX_TOOL_CALL_RETRIES
                    ):
                        log.warning(
                            "[FOLLOW-UP] Exhausted ordinary chat tool-followup budget (%d) chat_id=%s message_id=%s",
                            CHAT_RESPONSE_MAX_TOOL_CALL_RETRIES,
                            metadata.get("chat_id"),
                            metadata.get("message_id"),
                        )

                initial_stream_ok, initial_stream_response = (
                    await run_chat_completion_with_transient_retries(
                        label="[INITIAL]",
                        request_form_data=form_data,
                        initial_response=response,
                    )
                )
                if not initial_stream_ok:
                    terminal_stop_reason = (
                        _terminal_stop_reason_for_chat_completion_error(
                            initial_stream_response
                        )
                    )
                    error_message = normalize_terminal_error_message(
                        initial_stream_response
                    )
                    if error_message:
                        await finalize_stream_assistant_error(
                            error_message,
                            stop_reason=terminal_stop_reason,
                            emit_completion_error=True,
                        )
                    return
                if assistant_error_finalized:
                    return
                log.info(
                    f"[TOOL-CALL] Initial stream_body_handler completed. tool_calls queue: {len(tool_calls)} items"
                )
                await process_tool_calls()
                if assistant_error_finalized:
                    return

                if DETECT_CODE_INTERPRETER:
                    MAX_RETRIES = 5
                    retries = 0

                    while (
                        content_blocks[-1]["type"] == "code_interpreter"
                        and retries < MAX_RETRIES
                    ):
                        await event_emitter(
                            {
                                "type": "chat:completion",
                                "data": {
                                    "content": serialize_content_blocks(content_blocks),
                                },
                            }
                        )

                        retries += 1
                        log.debug(f"Attempt count: {retries}")

                        output = ""
                        try:
                            if content_blocks[-1]["attributes"].get("type") == "code":
                                code = content_blocks[-1]["content"]
                                if CODE_INTERPRETER_BLOCKED_MODULES:
                                    blocking_code = textwrap.dedent(
                                        f"""
                                        import builtins

                                        BLOCKED_MODULES = {CODE_INTERPRETER_BLOCKED_MODULES}

                                        _real_import = builtins.__import__
                                        def restricted_import(name, globals=None, locals=None, fromlist=(), level=0):
                                            if name.split('.')[0] in BLOCKED_MODULES:
                                                importer_name = globals.get('__name__') if globals else None
                                                if importer_name == '__main__':
                                                    raise ImportError(
                                                        f"Direct import of module {{name}} is restricted."
                                                    )
                                            return _real_import(name, globals, locals, fromlist, level)

                                        builtins.__import__ = restricted_import
                                    """
                                    )
                                    code = blocking_code + "\n" + code

                                if (
                                    request.app.state.config.CODE_INTERPRETER_ENGINE
                                    == "pyodide"
                                ):
                                    output = await event_caller(
                                        {
                                            "type": "execute:python",
                                            "data": {
                                                "id": str(uuid4()),
                                                "code": code,
                                                "session_id": metadata.get(
                                                    "session_id", None
                                                ),
                                            },
                                        }
                                    )
                                elif (
                                    request.app.state.config.CODE_INTERPRETER_ENGINE
                                    == "jupyter"
                                ):
                                    execute_code_jupyter = (
                                        _load_execute_code_jupyter()
                                    )
                                    output = await execute_code_jupyter(
                                        request.app.state.config.CODE_INTERPRETER_JUPYTER_URL,
                                        code,
                                        (
                                            request.app.state.config.CODE_INTERPRETER_JUPYTER_AUTH_TOKEN
                                            if request.app.state.config.CODE_INTERPRETER_JUPYTER_AUTH
                                            == "token"
                                            else None
                                        ),
                                        (
                                            request.app.state.config.CODE_INTERPRETER_JUPYTER_AUTH_PASSWORD
                                            if request.app.state.config.CODE_INTERPRETER_JUPYTER_AUTH
                                            == "password"
                                            else None
                                        ),
                                        request.app.state.config.CODE_INTERPRETER_JUPYTER_TIMEOUT,
                                    )
                                else:
                                    output = {
                                        "stdout": "Code interpreter engine not configured."
                                    }

                                log.debug(f"Code interpreter output: {output}")

                                if isinstance(output, dict):
                                    stdout = output.get("stdout", "")

                                    if isinstance(stdout, str):
                                        stdoutLines = stdout.split("\n")
                                        for idx, line in enumerate(stdoutLines):
                                            if "data:image/png;base64" in line:
                                                image_url = get_image_url_from_base64(
                                                    request,
                                                    line,
                                                    metadata,
                                                    user,
                                                )
                                                if image_url:
                                                    stdoutLines[idx] = (
                                                        f"![Output Image]({image_url})"
                                                    )

                                        output["stdout"] = "\n".join(stdoutLines)

                                    result = output.get("result", "")

                                    if isinstance(result, str):
                                        resultLines = result.split("\n")
                                        for idx, line in enumerate(resultLines):
                                            if "data:image/png;base64" in line:
                                                image_url = get_image_url_from_base64(
                                                    request,
                                                    line,
                                                    metadata,
                                                    user,
                                                )
                                                resultLines[idx] = (
                                                    f"![Output Image]({image_url})"
                                                )
                                        output["result"] = "\n".join(resultLines)
                        except Exception as e:
                            output = str(e)

                        content_blocks[-1]["output"] = output

                        content_blocks.append(
                            {
                                "type": "text",
                                "content": "",
                            }
                        )

                        await event_emitter(
                            {
                                "type": "chat:completion",
                                "data": {
                                    "content": serialize_content_blocks(content_blocks),
                                },
                            }
                        )

                        try:
                            new_form_data = {
                                **form_data,
                                "model": model_id,
                                "stream": True,
                                "messages": [
                                    *form_data["messages"],
                                    {
                                        "role": "assistant",
                                        "content": serialize_content_blocks(
                                            content_blocks, raw=True
                                        ),
                                    },
                                ],
                            }
                            new_form_data["metadata"] = _refresh_upstream_request_metadata(
                                new_form_data.get("metadata"),
                                {
                                    "request_phase": "code_interpreter_followup",
                                    "outer_message_id": metadata.get("message_id"),
                                    **_assistant_tool_block_anchor_updates(
                                        metadata.get("message_id"),
                                        content_blocks,
                                    ),
                                },
                            )

                            retry_ok, retry_response = (
                                await run_chat_completion_with_transient_retries(
                                    label="[CODE-INTERPRETER]",
                                    request_form_data=new_form_data,
                                )
                            )
                            if retry_ok:
                                if assistant_error_finalized:
                                    return
                            else:
                                terminal_stop_reason = (
                                    _terminal_stop_reason_for_chat_completion_error(
                                        retry_response
                                    )
                                )
                                error_message = normalize_terminal_error_message(
                                    retry_response
                                )
                                if error_message:
                                    await finalize_stream_assistant_error(
                                        error_message,
                                        stop_reason=terminal_stop_reason,
                                        emit_completion_error=True,
                                    )
                                break
                        except Exception as e:
                            log.debug(e)
                            break

                    if assistant_error_finalized:
                        return

                length_continue_attempts = 0
                anomaly_retry_attempts = 0
                while True:
                    continue_reason = None

                    if (
                        should_continue_for_length(last_finish_reason, last_stop_reason)
                        and length_continue_attempts < max_length_continuations
                    ):
                        length_continue_attempts += 1
                        continue_reason = "length"
                        log.info(
                            "[CONTINUE] model=%s finish_reason=%s stop_reason=%s attempt=%d/%d",
                            model_id,
                            last_finish_reason,
                            last_stop_reason,
                            length_continue_attempts,
                            max_length_continuations,
                        )
                    else:
                        anomaly_state = get_anomaly_state()
                        if (
                            anomaly_state["should_retry"]
                            and anomaly_retry_attempts
                            < empty_response_retry_max_attempts
                        ):
                            anomaly_retry_attempts += 1
                            continue_reason = "anomaly"
                            delay_ms = get_anomaly_retry_backoff_ms(
                                anomaly_retry_attempts
                            )
                            log.warning(
                                "[ANOMALY-RETRY] model=%s chat_id=%s message_id=%s whitespace_only=%s ultra_short=%s completion_tokens=%s content_len=%s attempt=%d/%d delay_ms=%d",
                                model_id,
                                metadata.get("chat_id"),
                                metadata.get("message_id"),
                                anomaly_state.get("whitespace_only"),
                                anomaly_state.get("ultra_short"),
                                last_completion_tokens,
                                anomaly_state.get("content_len"),
                                anomaly_retry_attempts,
                                empty_response_retry_max_attempts,
                                delay_ms,
                            )
                            if delay_ms > 0:
                                await asyncio.sleep(delay_ms / 1000)
                        elif anomaly_state["should_retry"]:
                            log.warning(
                                "[ANOMALY-RETRY] model=%s chat_id=%s message_id=%s exhausted attempts=%d/%d whitespace_only=%s ultra_short=%s completion_tokens=%s content_len=%s",
                                model_id,
                                metadata.get("chat_id"),
                                metadata.get("message_id"),
                                anomaly_retry_attempts,
                                empty_response_retry_max_attempts,
                                anomaly_state.get("whitespace_only"),
                                anomaly_state.get("ultra_short"),
                                last_completion_tokens,
                                anomaly_state.get("content_len"),
                            )

                    if not continue_reason:
                        break

                    seam_deltas = get_continuation_seam_deltas()
                    if seam_deltas:
                        log.info(
                            "[CONTINUE] Seam delta context count=%d last_delta=%r",
                            len(seam_deltas),
                            seam_deltas[-1],
                        )

                    effective_continue_prompt = build_continue_prompt(content)
                    continue_messages = build_followup_replay_messages(
                        _ensure_internal_request_system_prompt_placeholder(
                            _strip_replayed_model_system_prompt(form_data["messages"])
                        ),
                        replay_seam_blocks,
                        content_blocks,
                        "stream_continue",
                        convert_content_blocks=convert_content_blocks_to_messages,
                    )
                    continue_added_files = []
                    promoted_steer_message_id = None
                    if metadata.get("chat_id"):
                        consumed_steer, pending_state = await consume_pending_steer(
                            getattr(request.app.state, "redis", None),
                            metadata["chat_id"],
                        )
                        if consumed_steer:
                            promoted_steer_message_id = await promote_consumed_steer_to_live_turn(
                                steer_item=consumed_steer,
                                pending_state=pending_state,
                                seam_reason=continue_reason,
                            )
                            if promoted_steer_message_id:
                                continue_messages, continue_added_files = (
                                    inject_pending_steer_into_continue_messages(
                                        base_messages=continue_messages,
                                        continue_prompt=effective_continue_prompt,
                                        steer_item=consumed_steer,
                                    )
                                )
                            else:
                                await restore_failed_mid_turn_steer(
                                    steer_item=consumed_steer,
                                    error_reason="mid_turn_steer_promotion_failed",
                                )
                        else:
                            continue_messages.append(
                                {"role": "user", "content": effective_continue_prompt}
                            )
                    else:
                        continue_messages.append(
                            {"role": "user", "content": effective_continue_prompt}
                        )
                    continue_form_data = {
                        **form_data,
                        "model": model_id,
                        "stream": True,
                        "messages": continue_messages,
                    }
                    continue_metadata = dict(
                        continue_form_data.get("metadata")
                        if isinstance(continue_form_data.get("metadata"), dict)
                        else {}
                    )
                    continue_metadata = _refresh_upstream_request_metadata(
                        continue_metadata,
                        {
                            "request_phase": continue_reason,
                            "followup_index": _continuation_followup_index(
                                length_continue_attempts=length_continue_attempts,
                                anomaly_retry_attempts=anomaly_retry_attempts,
                            ),
                            "message_id": metadata.get("message_id"),
                            "outer_message_id": metadata.get("message_id"),
                            **(
                                _user_message_anchor_updates(
                                    promoted_steer_message_id
                                )
                                if promoted_steer_message_id
                                else {}
                            ),
                        },
                    )
                    continue_form_data["metadata"] = continue_metadata
                    if continue_added_files:
                        continue_form_data["files"] = merge_top_level_files(
                            form_data.get("files"),
                            continue_added_files,
                        )

                    owui_internal_fields = [
                        "tool_ids",
                        "files",
                        "tool_servers",
                        "features",
                        "variables",
                    ]
                    for field in owui_internal_fields:
                        continue_form_data.pop(field, None)
                    log.debug(
                        f"[CONTINUE] Removed internal fields from form_data: {owui_internal_fields}"
                    )

                    if followup_history_guard_mode != "off":
                        continue_guard_verdict = verify_followup_history_fidelity(
                            continue_form_data.get("messages", []),
                            followup_required_user_anchors,
                            followup_last_dispatched_count,
                        )
                        if not continue_guard_verdict["ok"]:
                            log.warning(
                                "[CONTINUE][HISTORY-GUARD] Continuation payload lost %d previously-sent user message(s) chat_id=%s message_id=%s mode=%s",
                                len(continue_guard_verdict["missing_anchors"]),
                                metadata.get("chat_id"),
                                metadata.get("message_id"),
                                followup_history_guard_mode,
                            )
                    followup_last_dispatched_count = len(
                        continue_form_data.get("messages", [])
                    )

                    retry_ok, retry_response = (
                        await run_chat_completion_with_transient_retries(
                            label="[CONTINUE]",
                            request_form_data=continue_form_data,
                            suppress_reasoning_output=True,
                        )
                    )
                    if retry_ok:
                        if assistant_error_finalized:
                            return
                        log.info("[CONTINUE] stream handling completed")
                        await process_tool_calls()
                        if assistant_error_finalized:
                            return
                    else:
                        terminal_stop_reason = (
                            _terminal_stop_reason_for_chat_completion_error(
                                retry_response
                            )
                        )
                        error_message = normalize_terminal_error_message(
                            retry_response
                        )
                        log_retryable_chat_completion_response(
                            "[CONTINUE]",
                            retry_response,
                        )
                        if error_message:
                            await finalize_stream_assistant_error(
                                error_message,
                                stop_reason=terminal_stop_reason,
                                emit_completion_error=True,
                            )
                        break

                if assistant_error_finalized:
                    return

                if (
                    length_continue_attempts >= max_length_continuations
                    and should_continue_for_length(last_finish_reason, last_stop_reason)
                ):
                    log.warning(
                        "[CONTINUE] Max continuations reached. finish_reason=%s stop_reason=%s",
                        last_finish_reason,
                        last_stop_reason,
                    )

                anomaly_state = get_anomaly_state()
                if (
                    anomaly_state["should_retry"]
                    and anomaly_retry_attempts >= empty_response_retry_max_attempts
                ):
                    friendly_error_message = (
                        metadata.get("params", {}).get(
                            "empty_response_retry_error_message"
                        )
                        or "We couldn’t complete the response this time. Please try again."
                    )
                    await finalize_stream_assistant_error(
                        friendly_error_message,
                        stop_reason="empty_response_retry_exhausted",
                        emit_completion_error=True,
                    )
                    return

                title = Chats.get_chat_title_by_id(metadata["chat_id"])
                _dedupe_inline_tool_image_markdown(
                    content_blocks,
                    metadata.get("chat_id"),
                )
                merged_tool_result_files = _collect_content_block_tool_result_files(
                    content_blocks
                )
                final_content = serialize_content_blocks(content_blocks)
                content = final_content
                data = {
                    "done": True,
                    "content": final_content,
                    "contentBlocks": content_blocks,  # Send contentBlocks to frontend for proper history storage
                    "title": title,
                }
                if merged_tool_result_files:
                    data["files"] = merged_tool_result_files
                if last_finish_reason:
                    data["finish_reason"] = last_finish_reason
                if last_stop_reason:
                    data["stop_reason"] = last_stop_reason
                log.info(
                    "[CHAT-DONE] Setting done=true chat_id=%s message_id=%s finish_reason=%s stop_reason=%s",
                    metadata.get("chat_id"),
                    metadata.get("message_id"),
                    last_finish_reason,
                    last_stop_reason,
                )

                if not ENABLE_REALTIME_CHAT_SAVE:
                    # Save message in the database
                    block_type_counts = {}
                    for cb in content_blocks:
                        block_type = (
                            cb.get("type", "unknown")
                            if isinstance(cb, dict)
                            else type(cb).__name__
                        )
                        block_type_counts[block_type] = (
                            block_type_counts.get(block_type, 0) + 1
                        )
                    log.info(
                        "[DEBUGGING_TOOLS] Saving non-realtime completion message_id=%s content_blocks=%d block_types=%s",
                        metadata.get("message_id"),
                        len(content_blocks),
                        block_type_counts,
                    )

                    completion_update = {
                        "content": final_content,
                        "contentBlocks": content_blocks,  # Store structured data for proper reconstruction
                        "done": True,
                    }
                    if merged_tool_result_files:
                        completion_update["files"] = merged_tool_result_files
                    if last_finish_reason:
                        completion_update["finish_reason"] = last_finish_reason
                    if last_stop_reason:
                        completion_update["stop_reason"] = last_stop_reason
                    Chats.upsert_message_to_chat_by_id_and_message_id(
                        metadata["chat_id"],
                        metadata["message_id"],
                        completion_update,
                    )
                    log.info(
                        f"[DEBUGGING_TOOLS] 💾 SAVE COMPLETE (non-realtime completion) for message {metadata['message_id']}"
                    )
                else:
                    # Final flush: persist complete content + done flag (throttled saves may have missed recent deltas)
                    try:
                        completion_update = {
                            "done": True,
                            "content": final_content,
                            "contentBlocks": content_blocks,
                        }
                        if merged_tool_result_files:
                            completion_update["files"] = merged_tool_result_files
                        if last_finish_reason:
                            completion_update["finish_reason"] = last_finish_reason
                        if last_stop_reason:
                            completion_update["stop_reason"] = last_stop_reason
                        Chats.upsert_message_to_chat_by_id_and_message_id(
                            metadata["chat_id"],
                            metadata["message_id"],
                            completion_update,
                        )
                        log.info(
                            "[CHAT-SAVE-THROTTLED] 💾 FINAL FLUSH chat_id=%s message_id=%s content_blocks=%d",
                            metadata.get("chat_id"),
                            metadata.get("message_id"),
                            len(content_blocks),
                        )
                    except Exception as e:
                        log.warning(f"[DEBUGGING_TOOLS] Failed to set done flag: {e}")

                await event_emitter(
                    {
                        "type": "chat:completion",
                        "data": data,
                    }
                )

                terminal_completed_at = time.monotonic()
                await _refresh_active_chat_agent_vms(
                    metadata.get("chat_id"),
                    reason="assistant_terminal",
                )
                await schedule_terminal_pending_chat_work_drain(terminal_completed_at)

                # Send a webhook notification if the user is not active
                if not Users.is_user_active(user.id):
                    webhook_url = Users.get_user_webhook_url_by_id(user.id)
                    if webhook_url:
                        await post_webhook(
                            request.app.state.WEBUI_NAME,
                            webhook_url,
                            f"{title} - {request.app.state.config.WEBUI_URL}/c/{metadata['chat_id']}\n\n{content}",
                            {
                                "action": "chat",
                                "message": content,
                                "title": title,
                                "url": f"{request.app.state.config.WEBUI_URL}/c/{metadata['chat_id']}",
                            },
                        )

                await background_tasks_handler()
            except asyncio.CancelledError as cancel_error:
                cancel_stop_reason = str(
                    cancel_error.args[0] if cancel_error.args else "client_disconnect"
                ).strip() or "client_disconnect"
                log.warning(
                    "Task was cancelled (stop_reason=%s)",
                    cancel_stop_reason,
                )
                await event_emitter(
                    {
                        "type": "chat:tasks:cancel",
                        "data": {"stop_reason": cancel_stop_reason},
                    }
                )

                # Cancel child subagent tasks via Redis tool_call_id -> chat_id lookup
                child_tool_call_ids = metadata.get("child_task_ids", set())
                if child_tool_call_ids:
                    redis = getattr(request.app.state, "redis", None) if request else None
                    if redis:
                        for tool_call_id in child_tool_call_ids:
                            try:
                                mapping_key = f"subagent_tool_call:{tool_call_id}"
                                mapping_json = await redis.get(mapping_key)
                                if mapping_json:
                                    mapping = json.loads(mapping_json)
                                    child_chat_id = mapping.get("chat_id")
                                    if child_chat_id:
                                        # Set cancellation signal for subagent polling loop
                                        await redis.setex(
                                            f"subagent_cancel:{child_chat_id}",
                                            300,  # 5 min TTL
                                            "1",
                                        )
                                        # Also stop any active tasks for this child chat
                                        from open_webui.tasks import list_task_ids_by_item_id
                                        child_task_ids = await list_task_ids_by_item_id(redis, child_chat_id)
                                        for child_tid in child_task_ids:
                                            await stop_task(redis, child_tid)
                                            log.info(f"Cancelled child subagent task {child_tid} (chat {child_chat_id})")
                            except Exception as e:
                                log.warning(f"Failed to cancel child subagent for tool_call {tool_call_id}: {e}")

                # Structured observability logging
                log.info(json.dumps({
                    "event": "task_cancelled",
                    "reason": cancel_stop_reason,
                    "chat_id": metadata.get("chat_id"),
                    "message_id": metadata.get("message_id"),
                    "child_tool_call_ids": list(child_tool_call_ids),
                    "content_blocks_count": len(content_blocks),
                }))

                frozen_content = freeze_terminal_stream_content_blocks(
                    stop_reason=cancel_stop_reason,
                )

                # Save with done=True and stop_reason so the message is in a clean terminal state
                Chats.upsert_message_to_chat_by_id_and_message_id(
                    metadata["chat_id"],
                    metadata["message_id"],
                    {
                        "content": frozen_content,
                        "contentBlocks": content_blocks,
                        "done": True,
                        "stop_reason": cancel_stop_reason,
                    },
                )
                chat_record = Chats.get_chat_by_id(metadata["chat_id"])
                if chat_record and _sync_flattened_message_with_history(
                    chat_record.chat, metadata["message_id"]
                ):
                    Chats.update_chat_by_id(metadata["chat_id"], chat_record.chat)
                log.info(
                    f"Saved cancelled message {metadata['message_id']} with done=True, stop_reason={cancel_stop_reason}"
                )
                if metadata.get("chat_id"):
                    schedule_pending_chat_work_drain(
                        request=request,
                        user=user,
                        chat_id=metadata["chat_id"],
                        sio=sio,
                        ignore_task_ids=[metadata.get("task_id")],
                        triggered_at=time.monotonic(),
                    )

            if response.background is not None:
                await response.background()

        return await response_handler(response, events)

    else:
        # Fallback to the original response
        async def stream_wrapper(original_generator, events):
            def wrap_item(item):
                return f"data: {item}\n\n"

            for event in events:
                event, _ = await process_filter_functions(
                    request=request,
                    filter_functions=filter_functions,
                    filter_type="stream",
                    form_data=event,
                    extra_params=extra_params,
                )

                if event:
                    yield wrap_item(json.dumps(event))

            async for data in original_generator:
                data, _ = await process_filter_functions(
                    request=request,
                    filter_functions=filter_functions,
                    filter_type="stream",
                    form_data=data,
                    extra_params=extra_params,
                )

                if data:
                    yield data

        return StreamingResponse(
            stream_wrapper(response.body_iterator, events),
            headers=dict(response.headers),
            background=response.background,
        )
