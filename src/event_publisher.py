"""
Shared Event Publisher for LLM Debug Monitor

This module provides a simple interface for publishing events to the LLM Debug Monitor
via Redis pub/sub. It's used by OWUI filters and the Bifrost bridge.

Usage:
    from event_publisher import publish_debug_event

    await publish_debug_event({
        "event_type": "llm_request_start",
        "session_id": "...",
        "chat_id": "...",
        "data": {...}
    })
"""

import json
import uuid
import asyncio
import logging
from datetime import datetime
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

# Redis configuration
REDIS_HOST = "redis"
REDIS_PORT = 6379
REDIS_CHANNEL = "llm_debug:events"

# Global Redis client (lazy initialization)
_redis_client = None
_redis_async_client = None
_STORED_RAW_EVENT_PREFIXES = {
    "llm_request_payload": "llm_debug:event_request_payload",
    "llm_response_complete": "llm_debug:event_response_complete",
}
_STORED_EVENT_TTL_SECONDS = 300
MAX_DEBUG_PUBSUB_EVENT_BYTES = 256 * 1024
_MAX_PUBSUB_IDENTITY_CHARS = 1024
_COMPACT_PUBSUB_EVENT_TYPES = frozenset(
    {"llm_request_start", *_STORED_RAW_EVENT_PREFIXES.keys()}
)
_PUBSUB_IDENTITY_FIELDS = (
    "event_id",
    "timestamp",
    "event_type",
    "session_id",
    "chat_id",
    "message_id",
    "debug_request_id",
    "upstream_request_id",
    "task_name",
    "request_phase",
    "followup_index",
    "outer_message_id",
    "trigger_message_id",
    "transcript_anchor_kind",
    "transcript_anchor_message_id",
    "transcript_anchor_tool_block_index",
    "prompt_submitted_at_ms",
    "traceparent",
    "tracestate_present",
    "baggage_present",
)


def _metadata_string(metadata: Optional[Dict[str, Any]], key: str) -> Optional[str]:
    if not isinstance(metadata, dict):
        return None
    value = metadata.get(key)
    if isinstance(value, str) and value.strip():
        return value
    return None


def _metadata_int(metadata: Optional[Dict[str, Any]], key: str) -> Optional[int]:
    if not isinstance(metadata, dict):
        return None
    value = metadata.get(key)
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        value = value.strip()
        if not value:
            return None
        try:
            return int(value)
        except ValueError:
            return None
    return None


def _metadata_anchor_kind(metadata: Optional[Dict[str, Any]]) -> Optional[str]:
    value = _metadata_string(metadata, "transcript_anchor_kind")
    if value in {"user_message", "assistant_tool_block", "background"}:
        return value
    return None


def _request_identity_for(event: Dict[str, Any]) -> Optional[str]:
    return (
        event.get("upstream_request_id")
        or event.get("debug_request_id")
        or event.get("event_id")
    )


def _get_sync_redis():
    """Get or create synchronous Redis client"""
    global _redis_client
    if _redis_client is None:
        try:
            import redis
            _redis_client = redis.Redis(
                host=REDIS_HOST,
                port=REDIS_PORT,
                db=0,
                decode_responses=True,
                socket_connect_timeout=2,
                socket_timeout=2
            )
            _redis_client.ping()
            logger.debug(f"Connected to Redis at {REDIS_HOST}:{REDIS_PORT}")
        except Exception as e:
            logger.warning(f"Failed to connect to Redis: {e}")
            _redis_client = None
    return _redis_client


async def _get_async_redis():
    """Get or create async Redis client"""
    global _redis_async_client
    if _redis_async_client is None:
        try:
            import redis.asyncio as redis
            _redis_async_client = redis.Redis(
                host=REDIS_HOST,
                port=REDIS_PORT,
                db=0,
                decode_responses=True,
                socket_connect_timeout=2
            )
            await _redis_async_client.ping()
            logger.debug(f"Connected to async Redis at {REDIS_HOST}:{REDIS_PORT}")
        except Exception as e:
            logger.warning(f"Failed to connect to async Redis: {e}")
            _redis_async_client = None
    return _redis_async_client


def _stored_event_key_for(event: Dict[str, Any]) -> Optional[str]:
    event_type = event.get("event_type")
    prefix = _STORED_RAW_EVENT_PREFIXES.get(event_type)
    request_identity = _request_identity_for(event)
    if not prefix or not request_identity:
        return None
    return f"{prefix}:{request_identity}"


def _trim_request_payload_for_storage(raw_payload: Any) -> Dict[str, Any]:
    if not isinstance(raw_payload, dict):
        return {}

    # Keep the fields the monitor actually hydrates from while dropping bulky,
    # redundant request context like model_item and variables.
    allowed_keys = (
        "_tool_namespaces",
        "messages",
        "metadata",
        "model",
        "parallel_tool_calls",
        "reasoning",
        "reasoning_effort",
        "response_format",
        "stream",
        "temperature",
        "tool_choice",
        "tools",
        "user",
        "max_tokens",
        "max_completion_tokens",
        "max_output_tokens",
    )
    trimmed: Dict[str, Any] = {}
    for key in allowed_keys:
        value = raw_payload.get(key)
        if value is not None:
            trimmed[key] = value
    return trimmed


def _event_for_storage(event: Dict[str, Any]) -> Dict[str, Any]:
    event_type = event.get("event_type")
    if event_type != "llm_request_payload":
        return event

    stored_event = dict(event)
    data = event.get("data")
    if not isinstance(data, dict):
        stored_event["data"] = {}
        return stored_event

    trimmed_raw_payload = _trim_request_payload_for_storage(data.get("raw_payload"))
    stored_data = {
        "model": data.get("model"),
        "base_model": data.get("base_model"),
        "tool_ids": data.get("tool_ids") or [],
        "skills": data.get("skills") or [],
        "temperature": data.get("temperature"),
        "max_tokens": data.get("max_tokens"),
        "reasoning_effort": data.get("reasoning_effort"),
        "reasoning_config": data.get("reasoning_config"),
        "raw_payload": trimmed_raw_payload,
    }

    if not isinstance(trimmed_raw_payload.get("messages"), list):
        stored_data["messages"] = data.get("messages") or []
    if not isinstance(trimmed_raw_payload.get("tools"), list):
        stored_data["tools"] = data.get("tools") or []

    stored_event["data"] = stored_data
    return stored_event


def _compact_event_for_pubsub(event: Dict[str, Any]) -> Dict[str, Any]:
    event_type = event.get("event_type")
    if event_type not in _COMPACT_PUBSUB_EVENT_TYPES:
        return event

    compact_event = dict(event)
    data = event.get("data")
    if not isinstance(data, dict):
        compact_event["data"] = {}
        return compact_event

    if event_type == "llm_request_start":
        tool_ids = data.get("tool_ids") or []
        compact_event["data"] = {
            "model": data.get("model"),
            "base_model": data.get("base_model"),
            "message_count": data.get("message_count"),
            "tool_count": len(tool_ids) if isinstance(tool_ids, list) else 0,
            "tool_ids": tool_ids if isinstance(tool_ids, list) else [],
            "skills": data.get("skills") if isinstance(data.get("skills"), list) else [],
        }
        return compact_event

    if event_type == "llm_request_payload":
        compact_event["data"] = {
            "model": data.get("model"),
            "base_model": data.get("base_model"),
            "message_count": len(data.get("messages") or []),
            "tool_count": len(data.get("tools") or []),
            "tool_ids": data.get("tool_ids") or [],
            "skills": data.get("skills") or [],
            "temperature": data.get("temperature"),
            "max_tokens": data.get("max_tokens"),
            "reasoning_effort": data.get("reasoning_effort"),
            "reasoning_config": data.get("reasoning_config"),
            "raw_payload_stored": isinstance(data.get("raw_payload"), dict),
        }
        return compact_event

    ultra_audit = _sanitize_ultra_audit(data.get("ultra_audit"))
    compact_data = {
        "model": data.get("model"),
        "usage": data.get("usage"),
        "finish_reason": data.get("finish_reason"),
        "duration_ms": data.get("duration_ms"),
        "has_tool_calls": data.get("has_tool_calls"),
        "tool_call_count": len(data.get("tool_calls") or []),
        "response_stored": True,
    }
    if ultra_audit is not None:
        compact_data["ultra_audit"] = ultra_audit
    compact_event["data"] = compact_data
    return compact_event


def _json_payload(value: Dict[str, Any]) -> str:
    return json.dumps(
        value,
        default=str,
        ensure_ascii=False,
        separators=(",", ":"),
    )


def _bounded_identity_value(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if not isinstance(value, str):
        value = str(value)
    if len(value) <= _MAX_PUBSUB_IDENTITY_CHARS:
        return value
    omitted = len(value) - _MAX_PUBSUB_IDENTITY_CHARS
    return f"{value[:_MAX_PUBSUB_IDENTITY_CHARS]}...<{omitted} chars omitted>"


def _collection_count(
    data: Dict[str, Any], count_key: str, value_key: str
) -> Optional[int]:
    count = data.get(count_key)
    if isinstance(count, int) and not isinstance(count, bool):
        return count
    value = data.get(value_key)
    if isinstance(value, (dict, list, tuple, set)):
        return len(value)
    return None


def _oversized_event_summary(
    event: Dict[str, Any], original_size_bytes: int
) -> Dict[str, Any]:
    summary = {
        field: _bounded_identity_value(event.get(field))
        for field in _PUBSUB_IDENTITY_FIELDS
        if event.get(field) is not None
    }
    data = event.get("data")
    if not isinstance(data, dict):
        data = {}

    summary_data: Dict[str, Any] = {
        "pubsub_truncated": True,
        "pubsub_warning": (
            "Oversized fields were omitted from Redis pub/sub; use stored debug "
            "events or reporting files for full request/response evidence."
        ),
        "original_size_bytes": original_size_bytes,
        "data_field_count": len(data),
    }
    for field in (
        "model",
        "base_model",
        "finish_reason",
        "change_type",
    ):
        if data.get(field) is not None:
            summary_data[field] = _bounded_identity_value(data.get(field))
    for field in ("duration_ms", "has_tool_calls"):
        if data.get(field) is not None:
            summary_data[field] = data.get(field)

    for count_key, value_key in (
        ("message_count", "messages"),
        ("tool_count", "tools"),
        ("tool_call_count", "tool_calls"),
    ):
        count = _collection_count(data, count_key, value_key)
        if count is not None:
            summary_data[count_key] = count

    for value_key, count_key in (
        ("tool_ids", "tool_id_count"),
        ("skills", "skill_count"),
    ):
        value = data.get(value_key)
        if isinstance(value, (dict, list, tuple, set)):
            summary_data[count_key] = len(value)

    for value_key, count_key in (
        ("response_content", "response_content_chars"),
        ("thinking_content", "thinking_content_chars"),
        ("error", "error_chars"),
        ("stack", "stack_chars"),
    ):
        value = data.get(value_key)
        if isinstance(value, str):
            summary_data[count_key] = len(value)

    for value_key, count_key in (
        ("metadata", "metadata_field_count"),
        ("raw_payload", "raw_payload_field_count"),
    ):
        value = data.get(value_key)
        if isinstance(value, dict):
            summary_data[count_key] = len(value)

    summary["data"] = summary_data
    return summary


def _pubsub_payload(event: Dict[str, Any]) -> str:
    compact_event = _compact_event_for_pubsub(event)
    payload = _json_payload(compact_event)
    payload_size = len(payload.encode("utf-8"))
    if payload_size <= MAX_DEBUG_PUBSUB_EVENT_BYTES:
        return payload

    summary = _oversized_event_summary(event, payload_size)
    payload = _json_payload(summary)
    if len(payload.encode("utf-8")) > MAX_DEBUG_PUBSUB_EVENT_BYTES:
        # Bounded identity fields make this unreachable for normal events, but
        # keep a hard final guard so no caller can exceed the pub/sub contract.
        summary = {
            "event_id": _bounded_identity_value(event.get("event_id")),
            "event_type": _bounded_identity_value(event.get("event_type")),
            "chat_id": _bounded_identity_value(event.get("chat_id")),
            "data": {
                "pubsub_truncated": True,
                "pubsub_warning": "Event exceeded the Redis pub/sub size limit.",
                "original_size_bytes": payload_size,
            },
        }
        payload = _json_payload(summary)

    logger.warning(
        "Truncated oversized debug pub/sub event type=%s chat_id=%s bytes=%d limit=%d",
        event.get("event_type"),
        event.get("chat_id"),
        payload_size,
        MAX_DEBUG_PUBSUB_EVENT_BYTES,
    )
    return payload


def publish_debug_event_sync(event_data: Dict[str, Any]) -> bool:
    """
    Synchronously publish an event to the LLM debug monitor Redis channel.

    Args:
        event_data: Dict containing event_type, session_id, chat_id, and data

    Returns:
        True if published successfully, False otherwise
    """
    try:
        client = _get_sync_redis()
        if not client:
            return False

        # Add event metadata
        event = {
            "event_id": str(uuid.uuid4()),
            "timestamp": datetime.utcnow().isoformat() + "Z",
            **event_data
        }

        # Ensure required fields
        if "event_type" not in event:
            logger.warning("Event missing event_type")
            return False

        storage_key = _stored_event_key_for(event)
        if storage_key:
            client.setex(
                storage_key,
                _STORED_EVENT_TTL_SECONDS,
                json.dumps(_event_for_storage(event), default=str),
            )

        # Publish a compact event to pub/sub. Full payloads stay in Redis storage.
        client.publish(
            REDIS_CHANNEL,
            _pubsub_payload(event),
        )

        logger.debug(f"Published event: {event['event_type']} for chat {event.get('chat_id', 'unknown')}")
        return True

    except Exception as e:
        logger.warning(f"Failed to publish debug event: {e}")
        return False


async def publish_debug_event(event_data: Dict[str, Any]) -> bool:
    """
    Asynchronously publish an event to the LLM debug monitor Redis channel.

    Args:
        event_data: Dict containing event_type, session_id, chat_id, and data

    Returns:
        True if published successfully, False otherwise
    """
    try:
        client = await _get_async_redis()
        if not client:
            # Fall back to sync client in thread pool
            loop = asyncio.get_event_loop()
            return await loop.run_in_executor(
                None,
                publish_debug_event_sync,
                event_data
            )

        # Add event metadata
        event = {
            "event_id": str(uuid.uuid4()),
            "timestamp": datetime.utcnow().isoformat() + "Z",
            **event_data
        }

        # Ensure required fields
        if "event_type" not in event:
            logger.warning("Event missing event_type")
            return False

        storage_key = _stored_event_key_for(event)
        if storage_key:
            await client.setex(
                storage_key,
                _STORED_EVENT_TTL_SECONDS,
                json.dumps(_event_for_storage(event), default=str),
            )

        # Publish a compact event to pub/sub. Full payloads stay in Redis storage.
        await client.publish(
            REDIS_CHANNEL,
            _pubsub_payload(event),
        )

        logger.debug(f"Published event: {event['event_type']} for chat {event.get('chat_id', 'unknown')}")
        return True

    except Exception as e:
        logger.warning(f"Failed to publish debug event: {e}")
        return False


# Convenience functions for specific event types

async def publish_request_start(
    session_id: str,
    chat_id: str,
    model: str,
    message_count: int,
    tool_ids: list = None,
    skills: list = None,
    metadata: dict = None,
    base_model: str = None,
    debug_request_id: str = None,
    upstream_request_id: str = None,
    task_name: str = None,
    request_phase: str = None,
    followup_index: int = None,
    outer_message_id: str = None,
    trigger_message_id: str = None,
    transcript_anchor_kind: str = None,
    transcript_anchor_message_id: str = None,
    transcript_anchor_tool_block_index: int = None,
    prompt_submitted_at_ms: int = None,
    traceparent: str = None,
    tracestate_present: bool = None,
    baggage_present: bool = None,
) -> bool:
    """Publish llm_request_start event"""
    message_id = _metadata_string(metadata, "message_id")
    debug_request_id = debug_request_id or _metadata_string(metadata, "debug_request_id")
    upstream_request_id = upstream_request_id or _metadata_string(
        metadata, "upstream_request_id"
    )
    task_name = task_name or _metadata_string(metadata, "task")
    request_phase = request_phase or _metadata_string(metadata, "request_phase")
    followup_index = (
        followup_index
        if followup_index is not None
        else _metadata_int(metadata, "followup_index")
    )
    outer_message_id = outer_message_id or _metadata_string(
        metadata, "outer_message_id"
    )
    trigger_message_id = trigger_message_id or _metadata_string(
        metadata, "trigger_message_id"
    )
    transcript_anchor_kind = transcript_anchor_kind or _metadata_anchor_kind(metadata)
    transcript_anchor_message_id = transcript_anchor_message_id or _metadata_string(
        metadata, "transcript_anchor_message_id"
    )
    transcript_anchor_tool_block_index = (
        transcript_anchor_tool_block_index
        if transcript_anchor_tool_block_index is not None
        else _metadata_int(metadata, "transcript_anchor_tool_block_index")
    )
    prompt_submitted_at_ms = (
        prompt_submitted_at_ms
        if prompt_submitted_at_ms is not None
        else _metadata_int(metadata, "prompt_submitted_at_ms")
    )
    if tracestate_present is None:
        tracestate_present = bool(_metadata_string(metadata, "tracestate"))
    if baggage_present is None:
        baggage_present = bool(_metadata_string(metadata, "baggage"))
    traceparent = traceparent or _metadata_string(metadata, "traceparent")
    return await publish_debug_event({
        "event_type": "llm_request_start",
        "session_id": session_id or "unknown",
        "chat_id": chat_id or "unknown",
        "message_id": message_id,
        "debug_request_id": debug_request_id,
        "upstream_request_id": upstream_request_id,
        "task_name": task_name,
        "request_phase": request_phase,
        "followup_index": followup_index,
        "outer_message_id": outer_message_id,
        "trigger_message_id": trigger_message_id,
        "transcript_anchor_kind": transcript_anchor_kind,
        "transcript_anchor_message_id": transcript_anchor_message_id,
        "transcript_anchor_tool_block_index": transcript_anchor_tool_block_index,
        "prompt_submitted_at_ms": prompt_submitted_at_ms,
        "traceparent": traceparent,
        "tracestate_present": tracestate_present,
        "baggage_present": baggage_present,
        "data": {
            "model": model,
            "base_model": base_model,
            "message_count": message_count,
            "tool_ids": tool_ids or [],
            "skills": skills or [],
        }
    })


async def publish_request_payload(
    session_id: str,
    chat_id: str,
    model: str,
    messages: list,
    tools: list = None,
    tool_ids: list = None,
    skills: list = None,
    temperature: float = None,
    max_tokens: int = None,
    reasoning_effort: str = None,
    reasoning_config: dict = None,
    raw_payload: dict = None,
    base_model: str = None,
    debug_request_id: str = None,
    upstream_request_id: str = None,
    task_name: str = None,
    request_phase: str = None,
    followup_index: int = None,
    outer_message_id: str = None,
    trigger_message_id: str = None,
    transcript_anchor_kind: str = None,
    transcript_anchor_message_id: str = None,
    transcript_anchor_tool_block_index: int = None,
) -> bool:
    """Publish llm_request_payload event

    Args:
        reasoning_effort: Original UI effort (none/low/medium/high/xhigh/max/ultra) for backwards compat
        reasoning_config: Rich config with ui_effort, model_family, and api_config for debug monitor
        base_model: Underlying model for custom agents
    """
    payload_metadata = (
        raw_payload.get("metadata")
        if isinstance(raw_payload, dict) and isinstance(raw_payload.get("metadata"), dict)
        else None
    )
    debug_request_id = debug_request_id or _metadata_string(
        payload_metadata, "debug_request_id"
    )
    upstream_request_id = upstream_request_id or _metadata_string(
        payload_metadata, "upstream_request_id"
    )
    task_name = task_name or _metadata_string(payload_metadata, "task")
    request_phase = request_phase or _metadata_string(payload_metadata, "request_phase")
    followup_index = (
        followup_index
        if followup_index is not None
        else _metadata_int(payload_metadata, "followup_index")
    )
    outer_message_id = outer_message_id or _metadata_string(
        payload_metadata, "outer_message_id"
    )
    trigger_message_id = trigger_message_id or _metadata_string(
        payload_metadata, "trigger_message_id"
    )
    transcript_anchor_kind = transcript_anchor_kind or _metadata_anchor_kind(
        payload_metadata
    )
    transcript_anchor_message_id = transcript_anchor_message_id or _metadata_string(
        payload_metadata, "transcript_anchor_message_id"
    )
    transcript_anchor_tool_block_index = (
        transcript_anchor_tool_block_index
        if transcript_anchor_tool_block_index is not None
        else _metadata_int(payload_metadata, "transcript_anchor_tool_block_index")
    )
    return await publish_debug_event({
        "event_type": "llm_request_payload",
        "session_id": session_id or "unknown",
        "chat_id": chat_id or "unknown",
        "debug_request_id": debug_request_id,
        "upstream_request_id": upstream_request_id,
        "task_name": task_name,
        "request_phase": request_phase,
        "followup_index": followup_index,
        "outer_message_id": outer_message_id,
        "trigger_message_id": trigger_message_id,
        "transcript_anchor_kind": transcript_anchor_kind,
        "transcript_anchor_message_id": transcript_anchor_message_id,
        "transcript_anchor_tool_block_index": transcript_anchor_tool_block_index,
        "data": {
            "model": model,
            "base_model": base_model,
            "messages": messages,
            "tools": tools or [],
            "tool_ids": tool_ids or [],
            "skills": skills or [],
            "temperature": temperature,
            "max_tokens": max_tokens,
            "reasoning_effort": reasoning_effort,
            "reasoning_config": reasoning_config,
            "raw_payload": raw_payload or {}
        }
    })

def _sanitize_ultra_audit(value: Any) -> Optional[Dict[str, Any]]:
    """Keep only bounded counter/boolean Ultra diagnostics."""
    if not isinstance(value, dict):
        return None
    limits = {
        "child_agent_count": 256,
        "tool_call_count": 256,
        "child_tool_call_count": 256,
        "tool_result_count": 256,
        "continuation_count": 32,
    }
    if any(
        type(value.get(key)) is not int
        or value[key] < 0
        or value[key] > limit
        for key, limit in limits.items()
    ):
        return None
    if value.get("arguments_logged") is not False or value.get("results_logged") is not False:
        return None
    return {
        "child_agent_count": value["child_agent_count"],
        "tool_call_count": value["tool_call_count"],
        "child_tool_call_count": value["child_tool_call_count"],
        "tool_result_count": value["tool_result_count"],
        "continuation_count": value["continuation_count"],
        "arguments_logged": False,
        "results_logged": False,
    }


async def publish_response_complete(
    session_id: str,
    chat_id: str,
    model: str,
    usage: dict,
    finish_reason: str,
    duration_ms: int,
    has_tool_calls: bool = False,
    response_content: str = "",
    tool_calls: list = None,
    thinking_content: str = "",
    ultra_audit: dict = None,
    debug_request_id: str = None,
    upstream_request_id: str = None,
    task_name: str = None,
    request_phase: str = None,
    followup_index: int = None,
    outer_message_id: str = None,
    trigger_message_id: str = None,
    transcript_anchor_kind: str = None,
    transcript_anchor_message_id: str = None,
    transcript_anchor_tool_block_index: int = None,
) -> bool:
    """Publish llm_response_complete event"""
    return await publish_debug_event({
        "event_type": "llm_response_complete",
        "session_id": session_id or "unknown",
        "chat_id": chat_id or "unknown",
        "debug_request_id": debug_request_id,
        "upstream_request_id": upstream_request_id,
        "task_name": task_name,
        "request_phase": request_phase,
        "followup_index": followup_index,
        "outer_message_id": outer_message_id,
        "trigger_message_id": trigger_message_id,
        "transcript_anchor_kind": transcript_anchor_kind,
        "transcript_anchor_message_id": transcript_anchor_message_id,
        "transcript_anchor_tool_block_index": transcript_anchor_tool_block_index,
        "data": {
            "model": model,
            "usage": usage,
            "finish_reason": finish_reason,
            "duration_ms": duration_ms,
            "has_tool_calls": has_tool_calls,
            "response_content": response_content,
            "tool_calls": tool_calls or [],
            "thinking_content": thinking_content,
            "ultra_audit": _sanitize_ultra_audit(ultra_audit),
        }
    })


async def publish_capabilities_change(
    session_id: str,
    chat_id: str,
    tools: list,
    skills: list,
    change_type: str = "initial"
) -> bool:
    """Publish capabilities_change event"""
    return await publish_debug_event({
        "event_type": "capabilities_change",
        "session_id": session_id or "unknown",
        "chat_id": chat_id or "unknown",
        "data": {
            "tools": tools,
            "skills": skills,
            "change_type": change_type
        }
    })


async def publish_error(
    session_id: str,
    chat_id: str,
    error: str,
    stack: str = None,
    debug_request_id: str = None,
    upstream_request_id: str = None,
    task_name: str = None,
    request_phase: str = None,
    followup_index: int = None,
    outer_message_id: str = None,
    trigger_message_id: str = None,
    transcript_anchor_kind: str = None,
    transcript_anchor_message_id: str = None,
    transcript_anchor_tool_block_index: int = None,
) -> bool:
    """Publish error event"""
    return await publish_debug_event({
        "event_type": "error",
        "session_id": session_id or "unknown",
        "chat_id": chat_id or "unknown",
        "debug_request_id": debug_request_id,
        "upstream_request_id": upstream_request_id,
        "task_name": task_name,
        "request_phase": request_phase,
        "followup_index": followup_index,
        "outer_message_id": outer_message_id,
        "trigger_message_id": trigger_message_id,
        "transcript_anchor_kind": transcript_anchor_kind,
        "transcript_anchor_message_id": transcript_anchor_message_id,
        "transcript_anchor_tool_block_index": transcript_anchor_tool_block_index,
        "data": {
            "error": error,
            "stack": stack
        }
    })
