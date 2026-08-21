"""Redis pub/sub subscriber for LLM debug events"""

import asyncio
import json
import logging
from typing import AsyncGenerator, Optional, Callable, Awaitable
import redis.asyncio as redis

logger = logging.getLogger(__name__)

REDIS_CHANNEL = "llm_debug:events"
STORED_EVENT_REQUEST_PREFIX = "llm_debug:event_request_payload"
STORED_EVENT_RESPONSE_PREFIX = "llm_debug:event_response_complete"


def _request_matches_transformed_model(request: dict, transformed_model: Optional[str]) -> bool:
    if not transformed_model:
        return True
    return (
        request.get("model") == transformed_model
        or request.get("base_model") == transformed_model
    )


def _extract_metadata_string(metadata: object, key: str) -> Optional[str]:
    if not isinstance(metadata, dict):
        return None
    value = metadata.get(key)
    if isinstance(value, str) and value.strip():
        return value
    return None


def _first_not_none(*values):
    for value in values:
        if value is not None:
            return value
    return None


def _event_data_field(event: dict, field: str) -> object:
    if not isinstance(event, dict):
        return None
    data = event.get("data")
    if not isinstance(data, dict):
        return None
    return data.get(field)


def _extract_payload_metadata_from_event(event: dict) -> Optional[dict]:
    payload = _event_data_field(event, "payload")
    if not isinstance(payload, dict):
        return None
    metadata = payload.get("metadata")
    return metadata if isinstance(metadata, dict) else None


def _extract_message_id_from_metadata(metadata: object) -> Optional[str]:
    return _extract_metadata_string(metadata, "message_id")


def _extract_debug_request_id_from_metadata(metadata: object) -> Optional[str]:
    return _extract_metadata_string(metadata, "debug_request_id")


def _extract_upstream_request_id_from_metadata(metadata: object) -> Optional[str]:
    return _extract_metadata_string(metadata, "upstream_request_id")


def _extract_task_name_from_metadata(metadata: object) -> Optional[str]:
    return _extract_metadata_string(metadata, "task")


def _extract_request_phase_from_metadata(metadata: object) -> Optional[str]:
    return _extract_metadata_string(metadata, "request_phase")


def _extract_outer_message_id_from_metadata(metadata: object) -> Optional[str]:
    return _extract_metadata_string(metadata, "outer_message_id")


def _extract_trigger_message_id_from_metadata(metadata: object) -> Optional[str]:
    return _extract_metadata_string(metadata, "trigger_message_id")


def _extract_transcript_anchor_kind_from_metadata(metadata: object) -> Optional[str]:
    value = _extract_metadata_string(metadata, "transcript_anchor_kind")
    if value in {"user_message", "assistant_tool_block", "background"}:
        return value
    return None


def _extract_transcript_anchor_message_id_from_metadata(
    metadata: object,
) -> Optional[str]:
    return _extract_metadata_string(metadata, "transcript_anchor_message_id")


def _extract_followup_index_from_metadata(metadata: object) -> Optional[int]:
    if not isinstance(metadata, dict):
        return None
    value = metadata.get("followup_index")
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


def _extract_transcript_anchor_tool_block_index_from_metadata(
    metadata: object,
) -> Optional[int]:
    if not isinstance(metadata, dict):
        return None
    value = metadata.get("transcript_anchor_tool_block_index")
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


def _extract_message_id_from_payload(payload: object) -> Optional[str]:
    if not isinstance(payload, dict):
        return None
    return _extract_message_id_from_metadata(payload.get("metadata"))


def _extract_message_id_from_event(event: dict) -> Optional[str]:
    return _first_not_none(
        _extract_metadata_string(event, "message_id"),
        _extract_message_id_from_metadata(event.get("data", {}).get("metadata")),
        _extract_message_id_from_metadata(_extract_payload_metadata_from_event(event)),
        _extract_message_id_from_payload(event.get("data", {}).get("raw_payload")),
    )


def _extract_debug_request_id_from_payload(payload: object) -> Optional[str]:
    if not isinstance(payload, dict):
        return None
    return _extract_debug_request_id_from_metadata(payload.get("metadata"))


def _extract_upstream_request_id_from_payload(payload: object) -> Optional[str]:
    if not isinstance(payload, dict):
        return None
    return _extract_upstream_request_id_from_metadata(payload.get("metadata"))


def _extract_task_name_from_payload(payload: object) -> Optional[str]:
    if not isinstance(payload, dict):
        return None
    return _extract_task_name_from_metadata(payload.get("metadata"))


def _extract_request_phase_from_payload(payload: object) -> Optional[str]:
    if not isinstance(payload, dict):
        return None
    return _extract_request_phase_from_metadata(payload.get("metadata"))


def _extract_outer_message_id_from_payload(payload: object) -> Optional[str]:
    if not isinstance(payload, dict):
        return None
    return _extract_outer_message_id_from_metadata(payload.get("metadata"))


def _extract_trigger_message_id_from_payload(payload: object) -> Optional[str]:
    if not isinstance(payload, dict):
        return None
    return _extract_trigger_message_id_from_metadata(payload.get("metadata"))


def _extract_transcript_anchor_kind_from_payload(payload: object) -> Optional[str]:
    if not isinstance(payload, dict):
        return None
    return _extract_transcript_anchor_kind_from_metadata(payload.get("metadata"))


def _extract_transcript_anchor_message_id_from_payload(
    payload: object,
) -> Optional[str]:
    if not isinstance(payload, dict):
        return None
    return _extract_transcript_anchor_message_id_from_metadata(
        payload.get("metadata")
    )


def _extract_followup_index_from_payload(payload: object) -> Optional[int]:
    if not isinstance(payload, dict):
        return None
    return _extract_followup_index_from_metadata(payload.get("metadata"))


def _extract_transcript_anchor_tool_block_index_from_payload(
    payload: object,
) -> Optional[int]:
    if not isinstance(payload, dict):
        return None
    return _extract_transcript_anchor_tool_block_index_from_metadata(
        payload.get("metadata")
    )


def _extract_debug_request_id_from_event(event: dict) -> Optional[str]:
    return _first_not_none(
        _extract_metadata_string(event, "debug_request_id"),
        _extract_debug_request_id_from_metadata(event.get("data", {}).get("metadata")),
        _extract_debug_request_id_from_metadata(_extract_payload_metadata_from_event(event)),
        _extract_debug_request_id_from_payload(event.get("data", {}).get("raw_payload")),
    )


def _extract_upstream_request_id_from_event(event: dict) -> Optional[str]:
    return _first_not_none(
        _extract_metadata_string(event, "upstream_request_id"),
        _extract_upstream_request_id_from_metadata(event.get("data", {}).get("metadata")),
        _extract_upstream_request_id_from_metadata(_extract_payload_metadata_from_event(event)),
        _extract_upstream_request_id_from_payload(event.get("data", {}).get("raw_payload")),
    )


def _extract_task_name_from_event(event: dict) -> Optional[str]:
    return _first_not_none(
        _extract_metadata_string(event, "task_name"),
        _extract_task_name_from_metadata(event.get("data", {}).get("metadata")),
        _extract_task_name_from_metadata(_extract_payload_metadata_from_event(event)),
        _extract_task_name_from_payload(event.get("data", {}).get("raw_payload")),
    )


def _extract_request_phase_from_event(event: dict) -> Optional[str]:
    return _first_not_none(
        _extract_metadata_string(event, "request_phase"),
        _extract_request_phase_from_metadata(event.get("data", {}).get("metadata")),
        _extract_request_phase_from_metadata(_extract_payload_metadata_from_event(event)),
        _extract_request_phase_from_payload(event.get("data", {}).get("raw_payload")),
    )


def _extract_outer_message_id_from_event(event: dict) -> Optional[str]:
    return _first_not_none(
        _extract_metadata_string(event, "outer_message_id"),
        _extract_outer_message_id_from_metadata(event.get("data", {}).get("metadata")),
        _extract_outer_message_id_from_metadata(_extract_payload_metadata_from_event(event)),
        _extract_outer_message_id_from_payload(event.get("data", {}).get("raw_payload")),
    )


def _extract_trigger_message_id_from_event(event: dict) -> Optional[str]:
    return _first_not_none(
        _extract_metadata_string(event, "trigger_message_id"),
        _extract_trigger_message_id_from_metadata(event.get("data", {}).get("metadata")),
        _extract_trigger_message_id_from_metadata(_extract_payload_metadata_from_event(event)),
        _extract_trigger_message_id_from_payload(event.get("data", {}).get("raw_payload")),
    )


def _extract_transcript_anchor_kind_from_event(event: dict) -> Optional[str]:
    return _first_not_none(
        _extract_metadata_string(event, "transcript_anchor_kind"),
        _extract_transcript_anchor_kind_from_metadata(
            event.get("data", {}).get("metadata")
        ),
        _extract_transcript_anchor_kind_from_metadata(
            _extract_payload_metadata_from_event(event)
        ),
        _extract_transcript_anchor_kind_from_payload(
            event.get("data", {}).get("raw_payload")
        ),
    )


def _extract_transcript_anchor_message_id_from_event(event: dict) -> Optional[str]:
    return _first_not_none(
        _extract_metadata_string(event, "transcript_anchor_message_id"),
        _extract_transcript_anchor_message_id_from_metadata(
            event.get("data", {}).get("metadata")
        ),
        _extract_transcript_anchor_message_id_from_metadata(
            _extract_payload_metadata_from_event(event)
        ),
        _extract_transcript_anchor_message_id_from_payload(
            event.get("data", {}).get("raw_payload")
        ),
    )


def _extract_followup_index_from_event(event: dict) -> Optional[int]:
    return _first_not_none(
        event.get("followup_index")
        if isinstance(event.get("followup_index"), int)
        else None,
        _extract_followup_index_from_metadata(event.get("data", {}).get("metadata")),
        _extract_followup_index_from_metadata(_extract_payload_metadata_from_event(event)),
        _extract_followup_index_from_payload(event.get("data", {}).get("raw_payload")),
    )


def _extract_transcript_anchor_tool_block_index_from_event(
    event: dict,
) -> Optional[int]:
    return _first_not_none(
        event.get("transcript_anchor_tool_block_index")
        if isinstance(event.get("transcript_anchor_tool_block_index"), int)
        else None,
        _extract_transcript_anchor_tool_block_index_from_metadata(
            event.get("data", {}).get("metadata")
        ),
        _extract_transcript_anchor_tool_block_index_from_metadata(
            _extract_payload_metadata_from_event(event)
        ),
        _extract_transcript_anchor_tool_block_index_from_payload(
            event.get("data", {}).get("raw_payload")
        ),
    )


def _find_request_by_identity(
    requests: dict,
    upstream_request_id: Optional[str],
    debug_request_id: Optional[str],
) -> Optional[dict]:
    if upstream_request_id:
        request = requests.get(upstream_request_id)
        if request:
            return request
        match = next(
            (
                request
                for request in requests.values()
                if request.get("upstream_request_id") == upstream_request_id
            ),
            None,
        )
        if match:
            return match
        if debug_request_id:
            request = requests.get(debug_request_id)
            if request and not request.get("upstream_request_id"):
                return request
            return next(
                (
                    request
                    for request in requests.values()
                    if request.get("debug_request_id") == debug_request_id
                    and not request.get("upstream_request_id")
                ),
                None,
            )
        return None
    if not debug_request_id:
        return None
    request = requests.get(debug_request_id)
    if request:
        return request
    return next(
        (
            request
            for request in requests.values()
            if request.get("debug_request_id") == debug_request_id
        ),
        None,
    )


def _rekey_request(requests: dict, request: dict, request_id: str) -> None:
    current_request_id = request.get("request_id")
    if current_request_id == request_id:
        return
    if current_request_id in requests:
        del requests[current_request_id]
    request["request_id"] = request_id


def _update_request_identity(
    request: dict,
    *,
    message_id: Optional[str] = None,
    debug_request_id: Optional[str] = None,
    upstream_request_id: Optional[str] = None,
    task_name: Optional[str] = None,
    request_phase: Optional[str] = None,
    followup_index: Optional[int] = None,
    outer_message_id: Optional[str] = None,
    trigger_message_id: Optional[str] = None,
    transcript_anchor_kind: Optional[str] = None,
    transcript_anchor_message_id: Optional[str] = None,
    transcript_anchor_tool_block_index: Optional[int] = None,
) -> None:
    if message_id and not request.get("message_id"):
        request["message_id"] = message_id
    if debug_request_id and not request.get("debug_request_id"):
        request["debug_request_id"] = debug_request_id
    if upstream_request_id and not request.get("upstream_request_id"):
        request["upstream_request_id"] = upstream_request_id
    if task_name and not request.get("task_name"):
        request["task_name"] = task_name
    if request_phase and not request.get("request_phase"):
        request["request_phase"] = request_phase
    if followup_index is not None and request.get("followup_index") is None:
        request["followup_index"] = followup_index
    if outer_message_id and not request.get("outer_message_id"):
        request["outer_message_id"] = outer_message_id
    if trigger_message_id and not request.get("trigger_message_id"):
        request["trigger_message_id"] = trigger_message_id
    if transcript_anchor_kind and not request.get("transcript_anchor_kind"):
        request["transcript_anchor_kind"] = transcript_anchor_kind
    if transcript_anchor_message_id and not request.get("transcript_anchor_message_id"):
        request["transcript_anchor_message_id"] = transcript_anchor_message_id
    if (
        transcript_anchor_tool_block_index is not None
        and request.get("transcript_anchor_tool_block_index") is None
    ):
        request["transcript_anchor_tool_block_index"] = (
            transcript_anchor_tool_block_index
        )
    request["is_auxiliary"] = bool(request.get("task_name"))


def _create_request_shell(
    event: dict,
    model: Optional[str],
    *,
    base_model: Optional[str] = None,
    message_id: Optional[str] = None,
    debug_request_id: Optional[str] = None,
    upstream_request_id: Optional[str] = None,
    task_name: Optional[str] = None,
    request_phase: Optional[str] = None,
    followup_index: Optional[int] = None,
    outer_message_id: Optional[str] = None,
    trigger_message_id: Optional[str] = None,
    transcript_anchor_kind: Optional[str] = None,
    transcript_anchor_message_id: Optional[str] = None,
    transcript_anchor_tool_block_index: Optional[int] = None,
    raw_payload: Optional[dict] = None,
) -> dict:
    return {
        "request_id": upstream_request_id or debug_request_id or event.get("event_id"),
        "chat_id": event.get("chat_id"),
        "session_id": event.get("session_id"),
        "timestamp": event.get("timestamp"),
        "model": model or "unknown",
        "base_model": base_model,
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
        "is_auxiliary": bool(task_name),
        "status": "pending",
        "messages": [],
        "tools": [],
        "parameters": {},
        "raw_payload": raw_payload or {},
        "transformed_payloads": [],
    }


def _request_matches_transformed_event(
    request: dict,
    transformed_model: Optional[str],
    transformed_message_id: Optional[str],
    transformed_upstream_request_id: Optional[str],
    transformed_debug_request_id: Optional[str],
) -> bool:
    if request.get("upstream_request_id") and transformed_upstream_request_id:
        return request.get("upstream_request_id") == transformed_upstream_request_id
    if request.get("debug_request_id") and transformed_debug_request_id:
        return request.get("debug_request_id") == transformed_debug_request_id
    request_message_id = request.get("message_id")
    if request_message_id and transformed_message_id:
        return request_message_id == transformed_message_id
    return _request_matches_transformed_model(request, transformed_model)


def _upsert_transformed_stage(request: dict, stage: dict) -> None:
    stages = list(request.get("transformed_payloads") or [])
    replace_index = next(
        (
            index
            for index, existing in enumerate(stages)
            if existing.get("api_path") == stage.get("api_path")
            or existing.get("event_id") == stage.get("event_id")
        ),
        None,
    )
    if replace_index is None:
        stages.append(stage)
    else:
        stages[replace_index] = stage
    request["transformed_payloads"] = stages


def _build_response_payload(data: Optional[dict], existing_usage: Optional[dict] = None) -> dict:
    if not isinstance(data, dict):
        data = {}
    usage = data.get("usage")
    if not isinstance(usage, dict):
        usage = existing_usage if isinstance(existing_usage, dict) else {}
    response = {
        "content": data.get("response_content") or "",
        "tool_calls": data.get("tool_calls") or [],
        "finish_reason": data.get("finish_reason") or "",
        "usage": usage,
        "thinking": data.get("thinking_content") or "",
    }
    ultra_audit = data.get("ultra_audit")
    if isinstance(ultra_audit, dict):
        response["ultra_audit"] = dict(ultra_audit)
    return response


def _request_has_response_payload(request: Optional[dict]) -> bool:
    if not isinstance(request, dict):
        return False
    response = request.get("response")
    if not isinstance(response, dict):
        return False
    return (
        bool(response.get("content"))
        or bool(response.get("thinking"))
        or bool(response.get("tool_calls"))
        or bool(response.get("finish_reason"))
        or bool(response.get("usage"))
    )


def _event_matches_request(event: dict, request: dict) -> bool:
    request_upstream_request_id = request.get("upstream_request_id")
    event_upstream_request_id = _extract_upstream_request_id_from_event(event)
    if request_upstream_request_id and event_upstream_request_id:
        return request_upstream_request_id == event_upstream_request_id

    request_debug_request_id = request.get("debug_request_id")
    event_debug_request_id = _extract_debug_request_id_from_event(event)
    if request_debug_request_id and event_debug_request_id:
        return request_debug_request_id == event_debug_request_id

    request_message_id = request.get("message_id")
    event_message_id = _extract_message_id_from_event(event)
    if request_message_id and event_message_id:
        return (
            request_message_id == event_message_id
            and request.get("chat_id") == event.get("chat_id")
        )

    return False


def _stored_event_key(event_type: str, request_id: Optional[str]) -> Optional[str]:
    if not request_id:
        return None
    if event_type == "llm_request_payload":
        return f"{STORED_EVENT_REQUEST_PREFIX}:{request_id}"
    if event_type == "llm_response_complete":
        return f"{STORED_EVENT_RESPONSE_PREFIX}:{request_id}"
    return None


class RedisSubscriber:
    """Handles Redis pub/sub subscription for debug events"""

    def __init__(self, redis_host: str = "redis", redis_port: int = 6379):
        self.redis_host = redis_host
        self.redis_port = redis_port
        self._client: Optional[redis.Redis] = None
        self._pubsub: Optional[redis.client.PubSub] = None
        self._running = False

    async def connect(self) -> None:
        """Connect to Redis"""
        if self._client is None:
            self._client = redis.Redis(
                host=self.redis_host,
                port=self.redis_port,
                decode_responses=True,
                socket_connect_timeout=5
            )
            # Test connection
            await self._client.ping()
            logger.info(f"Connected to Redis at {self.redis_host}:{self.redis_port}")

    async def disconnect(self) -> None:
        """Disconnect from Redis"""
        if self._pubsub:
            await self._pubsub.unsubscribe(REDIS_CHANNEL)
            await self._pubsub.close()
            self._pubsub = None
        if self._client:
            await self._client.close()
            self._client = None
        logger.info("Disconnected from Redis")

    async def subscribe(self) -> None:
        """Subscribe to the debug events channel"""
        if not self._client:
            await self.connect()

        self._pubsub = self._client.pubsub()
        await self._pubsub.subscribe(REDIS_CHANNEL)
        logger.info(f"Subscribed to channel: {REDIS_CHANNEL}")

    async def listen(self) -> AsyncGenerator[dict, None]:
        """
        Listen for events on the subscribed channel.
        Yields parsed event dictionaries.
        """
        if not self._pubsub:
            await self.subscribe()

        self._running = True
        while self._running:
            try:
                message = await self._pubsub.get_message(
                    ignore_subscribe_messages=True,
                    timeout=1.0
                )
                if message and message["type"] == "message":
                    try:
                        data = json.loads(message["data"])
                        yield data
                    except json.JSONDecodeError as e:
                        logger.error(f"Failed to parse event JSON: {e}")
            except redis.ConnectionError as e:
                logger.error(f"Redis connection error: {e}")
                self._running = False
                break
            except asyncio.CancelledError:
                self._running = False
                break

    async def stop(self) -> None:
        """Stop listening"""
        self._running = False


class EventStore:
    """In-memory store for recent events with Redis backing"""

    def __init__(self, redis_host: str = "redis", redis_port: int = 6379):
        self.redis_host = redis_host
        self.redis_port = redis_port
        self._client: Optional[redis.Redis] = None
        # In-memory cache
        self._sessions: dict = {}  # session_id -> session data
        self._chats: dict = {}  # chat_id -> chat data
        self._requests: dict = {}  # request_id -> request data
        self._events: list = []  # Recent events (limited)
        self._max_events = 1000

    async def connect(self) -> None:
        """Connect to Redis"""
        if self._client is None:
            self._client = redis.Redis(
                host=self.redis_host,
                port=self.redis_port,
                decode_responses=True,
                socket_connect_timeout=5
            )
            await self._client.ping()

    async def _load_stored_event(
        self, event_type: str, request_id: Optional[str]
    ) -> Optional[dict]:
        storage_key = _stored_event_key(event_type, request_id)
        if not storage_key or not self._client:
            return None

        raw = await self._client.get(storage_key)
        if not raw:
            return None

        try:
            event = json.loads(raw)
        except json.JSONDecodeError:
            return None

        return event if isinstance(event, dict) else None

    async def _backfill_request_payload_from_storage(
        self, request: Optional[dict]
    ) -> Optional[dict]:
        if not isinstance(request, dict):
            return request
        if request.get("messages") and request.get("raw_payload"):
            return request

        request_id = (
            request.get("upstream_request_id")
            or request.get("debug_request_id")
            or request.get("request_id")
        )
        stored_event = await self._load_stored_event("llm_request_payload", request_id)
        if not stored_event:
            return request

        data = stored_event.get("data")
        if not isinstance(data, dict):
            return request

        if data.get("model"):
            request["model"] = data.get("model")
        if data.get("base_model"):
            request["base_model"] = data.get("base_model")

        raw_payload = data.get("raw_payload")
        if isinstance(raw_payload, dict):
            request["raw_payload"] = raw_payload
            if isinstance(raw_payload.get("messages"), list):
                request["messages"] = raw_payload.get("messages", [])
            if isinstance(raw_payload.get("tools"), list):
                request["tools"] = raw_payload.get("tools", [])
            _update_request_identity(
                request,
                message_id=_extract_message_id_from_payload(raw_payload),
                debug_request_id=_extract_debug_request_id_from_payload(raw_payload),
                upstream_request_id=_extract_upstream_request_id_from_payload(raw_payload),
                task_name=_extract_task_name_from_payload(raw_payload),
                request_phase=_extract_request_phase_from_payload(raw_payload),
                followup_index=_extract_followup_index_from_payload(raw_payload),
                outer_message_id=_extract_outer_message_id_from_payload(raw_payload),
                trigger_message_id=_extract_trigger_message_id_from_payload(raw_payload),
                transcript_anchor_kind=_extract_transcript_anchor_kind_from_payload(
                    raw_payload
                ),
                transcript_anchor_message_id=(
                    _extract_transcript_anchor_message_id_from_payload(raw_payload)
                ),
                transcript_anchor_tool_block_index=(
                    _extract_transcript_anchor_tool_block_index_from_payload(
                        raw_payload
                    )
                ),
            )

        if isinstance(data.get("messages"), list):
            request["messages"] = data.get("messages", [])
        if isinstance(data.get("tools"), list):
            request["tools"] = data.get("tools", [])
        if data.get("tool_ids"):
            request["tool_ids"] = data.get("tool_ids", [])
        if data.get("skills"):
            request["skills"] = data.get("skills", [])

        request["parameters"] = {
            "temperature": data.get("temperature"),
            "max_tokens": data.get("max_tokens"),
            "reasoning_effort": data.get("reasoning_effort"),
            "reasoning_config": data.get("reasoning_config"),
        }

        if request.get("status") == "pending":
            request["status"] = "streaming"

        return request

    async def _backfill_request_response_from_storage(
        self, request: Optional[dict]
    ) -> Optional[dict]:
        if not isinstance(request, dict) or _request_has_response_payload(request):
            return request

        request_id = (
            request.get("upstream_request_id")
            or request.get("debug_request_id")
            or request.get("request_id")
        )
        stored_event = await self._load_stored_event(
            "llm_response_complete", request_id
        )
        if not stored_event:
            return request

        data = stored_event.get("data")
        if not isinstance(data, dict):
            return request

        request["status"] = "complete"
        request["duration_ms"] = data.get("duration_ms")
        request["usage"] = data.get("usage", {})
        request["response"] = _build_response_payload(data, request.get("usage"))
        return request

    async def hydrate_request(self, request: Optional[dict]) -> Optional[dict]:
        request = await self._backfill_request_payload_from_storage(request)
        request = await self._backfill_request_response_from_storage(request)
        return request

    async def process_event(self, event: dict) -> None:
        """Process and store an incoming event"""
        event_type = event.get("event_type")
        session_id = event.get("session_id")
        chat_id = event.get("chat_id")
        event_id = event.get("event_id")
        timestamp = event.get("timestamp")
        debug_request_id = _extract_debug_request_id_from_event(event)
        upstream_request_id = _extract_upstream_request_id_from_event(event)
        task_name = _extract_task_name_from_event(event)
        request_phase = _extract_request_phase_from_event(event)
        followup_index = _extract_followup_index_from_event(event)
        outer_message_id = _extract_outer_message_id_from_event(event)
        trigger_message_id = _extract_trigger_message_id_from_event(event)
        transcript_anchor_kind = _extract_transcript_anchor_kind_from_event(event)
        transcript_anchor_message_id = _extract_transcript_anchor_message_id_from_event(
            event
        )
        transcript_anchor_tool_block_index = (
            _extract_transcript_anchor_tool_block_index_from_event(event)
        )

        # Add to recent events
        self._events.append(event)
        if len(self._events) > self._max_events:
            self._events = self._events[-self._max_events:]

        # Update session
        if session_id:
            if session_id not in self._sessions:
                self._sessions[session_id] = {
                    "session_id": session_id,
                    "started_at": timestamp,
                    "chat_ids": set()
                }
            self._sessions[session_id]["chat_ids"].add(chat_id)

        # Update chat
        if chat_id:
            if chat_id not in self._chats:
                self._chats[chat_id] = {
                    "chat_id": chat_id,
                    "session_id": session_id,
                    "created_at": timestamp,
                    "last_activity": timestamp,
                    "request_count": 0,
                    "model": None,
                    "base_model": None,  # Underlying model for custom agents
                    "capabilities": {"tools": [], "skills": []}
                }
            self._chats[chat_id]["last_activity"] = timestamp

        # Handle specific event types
        if event_type == "llm_request_start":
            data = event.get("data", {})
            if chat_id:
                if not task_name or not self._chats[chat_id].get("model"):
                    self._chats[chat_id]["model"] = data.get("model")
                    self._chats[chat_id]["base_model"] = data.get("base_model")
                self._chats[chat_id]["request_count"] += 1

            request_id = upstream_request_id or debug_request_id or event_id
            request = self._requests.get(request_id) or _find_request_by_identity(
                self._requests, upstream_request_id, debug_request_id
            )
            if request is None:
                request = {
                    "request_id": request_id,
                    "chat_id": chat_id,
                    "session_id": session_id,
                    "timestamp": timestamp,
                    "model": data.get("model"),
                    "base_model": data.get("base_model"),
                    "upstream_request_id": upstream_request_id,
                    "request_phase": request_phase,
                    "followup_index": followup_index,
                    "outer_message_id": outer_message_id,
                    "trigger_message_id": trigger_message_id,
                    "transcript_anchor_kind": transcript_anchor_kind,
                    "transcript_anchor_message_id": transcript_anchor_message_id,
                    "transcript_anchor_tool_block_index": transcript_anchor_tool_block_index,
                    "status": "pending",
                    "messages": [],
                    "tools": [],
                    "parameters": {},
                    "raw_payload": {},
                    "transformed_payloads": [],
                    "tool_ids": [],
                    "skills": [],
                }
            _rekey_request(self._requests, request, request_id)
            request.update(
                {
                    "chat_id": chat_id,
                    "session_id": session_id,
                    "timestamp": timestamp,
                    "model": data.get("model"),
                    "base_model": data.get("base_model"),
                    "tool_ids": data.get("tool_ids", []),
                    "skills": data.get("skills", []),
                }
            )
            if request.get("status") not in ("streaming", "complete"):
                request["status"] = "pending"
            _update_request_identity(
                request,
                message_id=_extract_message_id_from_event(event),
                debug_request_id=debug_request_id,
                upstream_request_id=upstream_request_id,
                task_name=task_name,
                request_phase=request_phase,
                followup_index=followup_index,
                outer_message_id=outer_message_id,
                trigger_message_id=trigger_message_id,
                transcript_anchor_kind=transcript_anchor_kind,
                transcript_anchor_message_id=transcript_anchor_message_id,
                transcript_anchor_tool_block_index=transcript_anchor_tool_block_index,
            )
            self._requests[request["request_id"]] = request

        elif event_type == "llm_request_payload":
            data = event.get("data", {})
            if not isinstance(data, dict):
                data = {}
            request = _find_request_by_identity(
                self._requests, upstream_request_id, debug_request_id
            )
            if request is None and not upstream_request_id and not debug_request_id:
                for req in reversed(list(self._requests.values())):
                    if chat_id == "unknown":
                        if req["status"] == "pending":
                            request = req
                            break
                    elif req["chat_id"] == chat_id and req["status"] == "pending":
                        request = req
                        break

            if request is None and chat_id != "unknown":
                if chat_id in self._chats:
                    if not task_name or not self._chats[chat_id].get("model"):
                        self._chats[chat_id]["model"] = data.get("model")
                        self._chats[chat_id]["base_model"] = data.get("base_model")
                    self._chats[chat_id]["request_count"] += 1
                request = _create_request_shell(
                    event,
                    data.get("model"),
                    base_model=data.get("base_model"),
                    message_id=_extract_message_id_from_payload(
                        data.get("raw_payload")
                    ),
                    debug_request_id=debug_request_id,
                    upstream_request_id=upstream_request_id,
                    task_name=task_name,
                    request_phase=request_phase,
                    followup_index=followup_index,
                    outer_message_id=outer_message_id,
                    trigger_message_id=trigger_message_id,
                    transcript_anchor_kind=transcript_anchor_kind,
                    transcript_anchor_message_id=transcript_anchor_message_id,
                    transcript_anchor_tool_block_index=transcript_anchor_tool_block_index,
                )

            if request is not None:
                if not isinstance(data.get("messages"), list) or not isinstance(
                    data.get("raw_payload"), dict
                ):
                    stored_event = await self._load_stored_event(
                        "llm_request_payload",
                        upstream_request_id or debug_request_id or request["request_id"],
                    )
                    stored_data = (
                        stored_event.get("data")
                        if isinstance(stored_event, dict)
                        and isinstance(stored_event.get("data"), dict)
                        else None
                    )
                    if stored_data is not None:
                        data = stored_data

                _rekey_request(
                    self._requests,
                    request,
                    request.get("upstream_request_id")
                    or upstream_request_id
                    or request.get("debug_request_id")
                    or debug_request_id
                    or request["request_id"],
                )
                request["chat_id"] = chat_id
                request["session_id"] = session_id
                if data.get("model"):
                    request["model"] = data.get("model")
                raw_payload = (
                    data.get("raw_payload")
                    if isinstance(data.get("raw_payload"), dict)
                    else {}
                )
                request["messages"] = (
                    data.get("messages")
                    if isinstance(data.get("messages"), list)
                    else raw_payload.get("messages", [])
                )
                request["tools"] = (
                    data.get("tools")
                    if isinstance(data.get("tools"), list)
                    else raw_payload.get("tools", [])
                )
                if data.get("tool_ids"):
                    request["tool_ids"] = data.get("tool_ids", [])
                if data.get("skills"):
                    request["skills"] = data.get("skills", [])
                request["parameters"] = {
                    "temperature": data.get("temperature"),
                    "max_tokens": data.get("max_tokens"),
                    "reasoning_effort": data.get("reasoning_effort"),
                    "reasoning_config": data.get("reasoning_config"),
                }
                request["raw_payload"] = raw_payload
                if data.get("base_model"):
                    request["base_model"] = data.get("base_model")
                _update_request_identity(
                    request,
                    message_id=_extract_message_id_from_payload(raw_payload),
                    debug_request_id=debug_request_id,
                    upstream_request_id=upstream_request_id,
                    task_name=task_name,
                    request_phase=request_phase,
                    followup_index=followup_index,
                    outer_message_id=outer_message_id,
                    trigger_message_id=trigger_message_id,
                    transcript_anchor_kind=transcript_anchor_kind,
                    transcript_anchor_message_id=transcript_anchor_message_id,
                    transcript_anchor_tool_block_index=transcript_anchor_tool_block_index,
                )
                request["status"] = "streaming"
                self._requests[request["request_id"]] = request

        elif event_type == "llm_response_complete":
            data = event.get("data", {})
            if not isinstance(data, dict):
                data = {}
            request = _find_request_by_identity(
                self._requests, upstream_request_id, debug_request_id
            )
            if request is None and not upstream_request_id and not debug_request_id:
                for req in reversed(list(self._requests.values())):
                    if chat_id == "unknown":
                        if req["status"] in ("pending", "streaming"):
                            request = req
                            break
                    elif req["chat_id"] == chat_id and req["status"] in ("pending", "streaming"):
                        request = req
                        break
            if request is None and (upstream_request_id or debug_request_id) and chat_id != "unknown":
                request = _create_request_shell(
                    event,
                    data.get("model"),
                    debug_request_id=debug_request_id,
                    upstream_request_id=upstream_request_id,
                    task_name=task_name,
                    request_phase=request_phase,
                    followup_index=followup_index,
                    outer_message_id=outer_message_id,
                    trigger_message_id=trigger_message_id,
                    transcript_anchor_kind=transcript_anchor_kind,
                    transcript_anchor_message_id=transcript_anchor_message_id,
                    transcript_anchor_tool_block_index=transcript_anchor_tool_block_index,
                )
                if chat_id in self._chats:
                    self._chats[chat_id]["request_count"] += 1
            if request is not None:
                if data.get("response_stored") or (
                    "response_content" not in data
                    and "thinking_content" not in data
                    and "tool_calls" not in data
                ):
                    stored_event = await self._load_stored_event(
                        "llm_response_complete",
                        upstream_request_id or debug_request_id or request["request_id"],
                    )
                    stored_data = (
                        stored_event.get("data")
                        if isinstance(stored_event, dict)
                        and isinstance(stored_event.get("data"), dict)
                        else None
                    )
                    if stored_data is not None:
                        data = stored_data

                _rekey_request(
                    self._requests,
                    request,
                    request.get("upstream_request_id")
                    or upstream_request_id
                    or request.get("debug_request_id")
                    or debug_request_id
                    or request["request_id"],
                )
                _update_request_identity(
                    request,
                    debug_request_id=debug_request_id,
                    upstream_request_id=upstream_request_id,
                    task_name=task_name,
                    request_phase=request_phase,
                    followup_index=followup_index,
                    outer_message_id=outer_message_id,
                    trigger_message_id=trigger_message_id,
                    transcript_anchor_kind=transcript_anchor_kind,
                    transcript_anchor_message_id=transcript_anchor_message_id,
                    transcript_anchor_tool_block_index=transcript_anchor_tool_block_index,
                )
                request["status"] = "complete"
                request["duration_ms"] = data.get("duration_ms")
                request["usage"] = data.get("usage", {})
                request["response"] = _build_response_payload(
                    data, request.get("usage")
                )
                self._requests[request["request_id"]] = request

        elif event_type == "llm_request_transformed":
            data = event.get("data", {})
            transformed_model = data.get("model")
            transformed_message_id = event.get("message_id")
            request = _find_request_by_identity(
                self._requests, upstream_request_id, debug_request_id
            )
            if request is None and not upstream_request_id and not debug_request_id:
                for req in reversed(list(self._requests.values())):
                    if (
                        req["chat_id"] == chat_id
                        and req["status"] in ("pending", "streaming", "complete")
                        and _request_matches_transformed_event(
                            req,
                            transformed_model,
                            transformed_message_id,
                            upstream_request_id,
                            debug_request_id,
                        )
                    ):
                        request = req
                        break
            if request is None and (upstream_request_id or debug_request_id) and chat_id != "unknown":
                request = _create_request_shell(
                    event,
                    transformed_model,
                    message_id=transformed_message_id
                    or _extract_message_id_from_payload(data.get("payload")),
                    debug_request_id=debug_request_id,
                    upstream_request_id=upstream_request_id,
                    task_name=task_name
                    or _extract_task_name_from_payload(data.get("payload")),
                    request_phase=request_phase,
                    followup_index=followup_index,
                    outer_message_id=outer_message_id,
                    trigger_message_id=trigger_message_id,
                    transcript_anchor_kind=transcript_anchor_kind,
                    transcript_anchor_message_id=transcript_anchor_message_id,
                    transcript_anchor_tool_block_index=transcript_anchor_tool_block_index,
                )
                if chat_id in self._chats:
                    self._chats[chat_id]["request_count"] += 1
            if request is not None:
                _rekey_request(
                    self._requests,
                    request,
                    request.get("upstream_request_id")
                    or upstream_request_id
                    or request.get("debug_request_id")
                    or debug_request_id
                    or request["request_id"],
                )
                _update_request_identity(
                    request,
                    debug_request_id=debug_request_id,
                    upstream_request_id=upstream_request_id,
                    request_phase=request_phase,
                    followup_index=followup_index,
                    outer_message_id=outer_message_id,
                    trigger_message_id=trigger_message_id,
                    transcript_anchor_kind=transcript_anchor_kind,
                    transcript_anchor_message_id=transcript_anchor_message_id,
                    transcript_anchor_tool_block_index=transcript_anchor_tool_block_index,
                )
                _upsert_transformed_stage(
                    request,
                    {
                        "event_id": event_id,
                        "api_path": data.get("api_path"),
                        "payload": data.get("payload", {}),
                        "provider_headers_redacted": data.get(
                            "provider_headers_redacted", {}
                        ),
                        "timestamp": timestamp,
                    },
                )
                await self.hydrate_request(request)
                self._requests[request["request_id"]] = request

        elif event_type == "capabilities_change":
            data = event.get("data", {})
            if chat_id and chat_id in self._chats:
                self._chats[chat_id]["capabilities"] = {
                    "tools": data.get("tools", []),
                    "skills": data.get("skills", [])
                }

        elif event_type == "error":
            request = _find_request_by_identity(
                self._requests, upstream_request_id, debug_request_id
            )
            if request is None and not upstream_request_id and not debug_request_id:
                for req in reversed(list(self._requests.values())):
                    if req["chat_id"] == chat_id and req["status"] in ("pending", "streaming"):
                        request = req
                        break
            if request is None and (upstream_request_id or debug_request_id) and chat_id != "unknown":
                request = _create_request_shell(
                    event,
                    None,
                    debug_request_id=debug_request_id,
                    upstream_request_id=upstream_request_id,
                    task_name=task_name,
                    request_phase=request_phase,
                    followup_index=followup_index,
                    outer_message_id=outer_message_id,
                    trigger_message_id=trigger_message_id,
                    transcript_anchor_kind=transcript_anchor_kind,
                    transcript_anchor_message_id=transcript_anchor_message_id,
                    transcript_anchor_tool_block_index=transcript_anchor_tool_block_index,
                )
                if chat_id in self._chats:
                    self._chats[chat_id]["request_count"] += 1
            if request is not None:
                _rekey_request(
                    self._requests,
                    request,
                    request.get("upstream_request_id")
                    or upstream_request_id
                    or request.get("debug_request_id")
                    or debug_request_id
                    or request["request_id"],
                )
                _update_request_identity(
                    request,
                    debug_request_id=debug_request_id,
                    upstream_request_id=upstream_request_id,
                    task_name=task_name,
                    request_phase=request_phase,
                    followup_index=followup_index,
                    outer_message_id=outer_message_id,
                    trigger_message_id=trigger_message_id,
                    transcript_anchor_kind=transcript_anchor_kind,
                    transcript_anchor_message_id=transcript_anchor_message_id,
                    transcript_anchor_tool_block_index=transcript_anchor_tool_block_index,
                )
                request["status"] = "error"
                self._requests[request["request_id"]] = request

    def get_sessions(self) -> list:
        """Get all sessions"""
        return [
            {
                **session,
                "chat_ids": list(session["chat_ids"])
            }
            for session in self._sessions.values()
        ]

    def get_session_chats(self, session_id: str) -> list:
        """Get chats for a session"""
        session = self._sessions.get(session_id)
        if not session:
            return []
        return [
            self._chats[chat_id]
            for chat_id in session["chat_ids"]
            if chat_id in self._chats
        ]

    def get_chat_requests(self, chat_id: str, limit: int = 50, offset: int = 0) -> tuple:
        """Get requests for a chat with pagination"""
        requests = [
            req for req in self._requests.values()
            if req["chat_id"] == chat_id
        ]
        requests.sort(key=lambda r: r["timestamp"])
        total = len(requests)
        return requests[offset:offset + limit], total

    def _backfill_request_response_from_events(self, request: Optional[dict]) -> Optional[dict]:
        if not isinstance(request, dict) or _request_has_response_payload(request):
            return request

        for event in reversed(self._events):
            if event.get("event_type") != "llm_response_complete":
                continue
            if not _event_matches_request(event, request):
                continue

            data = event.get("data", {})
            request["response"] = _build_response_payload(data, request.get("usage"))
            if request.get("status") != "error":
                request["status"] = "complete"
            if request.get("duration_ms") is None:
                request["duration_ms"] = data.get("duration_ms")
            if not isinstance(request.get("usage"), dict):
                request["usage"] = data.get("usage", {})
            return request

        return request

    async def get_request_detail(self, request_id: str) -> Optional[dict]:
        """Get full request details"""
        # Check in-memory first
        if request_id in self._requests:
            request = await self.hydrate_request(self._requests[request_id])
            return self._backfill_request_response_from_events(request)
        return None

    def get_chat_capabilities(self, chat_id: str) -> dict:
        """Get capabilities for a chat"""
        chat = self._chats.get(chat_id)
        if chat:
            return chat.get("capabilities", {"tools": [], "skills": []})
        return {"tools": [], "skills": []}

    def get_recent_events(self, limit: int = 100) -> list:
        """Get recent events"""
        return self._events[-limit:]
