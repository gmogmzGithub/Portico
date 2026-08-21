import time
from typing import Any, Mapping, Optional
from uuid import uuid4

_AUXILIARY_TASK_NAMES = frozenset(
    {
        "title_generation",
        "follow_up_generation",
        "tags_generation",
        "emoji_generation",
        "query_generation",
        "image_prompt_generation",
        "autocomplete_generation",
        "moa_response_generation",
    }
)

AUXILIARY_REQUEST_PHASE = "auxiliary_task"
FOREGROUND_REQUEST_PHASE = "initial"


def generate_debug_request_id() -> str:
    return str(uuid4())


def generate_upstream_request_id() -> str:
    return str(uuid4())


def generate_debug_message_id() -> str:
    return str(uuid4())


def generate_prompt_submitted_at_ms() -> int:
    return int(time.time() * 1000)


def _normalize_nonnegative_int(value: Any) -> Optional[int]:
    try:
        normalized = int(value)
    except (TypeError, ValueError):
        return None
    if normalized < 0:
        return None
    return normalized


def normalize_task_name(task_name: Any) -> Optional[str]:
    if task_name is None:
        return None
    if not isinstance(task_name, str):
        task_name = str(task_name)
    normalized = task_name.strip()
    return normalized or None


def is_auxiliary_task_name(task_name: Any) -> bool:
    normalized = normalize_task_name(task_name)
    return normalized in _AUXILIARY_TASK_NAMES


def ensure_debug_request_id(
    metadata: Optional[Mapping[str, Any]], *, force_new: bool = False
) -> dict[str, Any]:
    next_metadata = dict(metadata or {})
    debug_request_id = next_metadata.get("debug_request_id")
    if (
        force_new
        or not isinstance(debug_request_id, str)
        or not debug_request_id.strip()
    ):
        next_metadata["debug_request_id"] = generate_debug_request_id()
    return next_metadata


def ensure_upstream_request_id(
    metadata: Optional[Mapping[str, Any]], *, force_new: bool = False
) -> dict[str, Any]:
    next_metadata = dict(metadata or {})
    upstream_request_id = next_metadata.get("upstream_request_id")
    if (
        force_new
        or not isinstance(upstream_request_id, str)
        or not upstream_request_id.strip()
    ):
        next_metadata["upstream_request_id"] = generate_upstream_request_id()
    return next_metadata


def ensure_debug_request_metadata(
    metadata: Optional[Mapping[str, Any]],
    *,
    force_new_debug_request_id: bool = False,
    force_new_upstream_request_id: bool = False,
    force_new_prompt_submitted_at_ms: bool = False,
    default_request_phase: Optional[str] = None,
) -> dict[str, Any]:
    next_metadata = ensure_debug_request_id(
        metadata, force_new=force_new_debug_request_id
    )
    next_metadata = ensure_upstream_request_id(
        next_metadata, force_new=force_new_upstream_request_id
    )
    normalized_prompt_submitted_at_ms = _normalize_nonnegative_int(
        next_metadata.get("prompt_submitted_at_ms")
    )
    if force_new_prompt_submitted_at_ms or normalized_prompt_submitted_at_ms is None:
        next_metadata["prompt_submitted_at_ms"] = generate_prompt_submitted_at_ms()
    else:
        next_metadata["prompt_submitted_at_ms"] = normalized_prompt_submitted_at_ms
    if default_request_phase is not None:
        request_phase = next_metadata.get("request_phase")
        if not isinstance(request_phase, str) or not request_phase.strip():
            next_metadata["request_phase"] = default_request_phase
    return next_metadata


def build_auxiliary_task_metadata(
    metadata: Optional[Mapping[str, Any]],
    *,
    task_name: Any,
    task_body: Any,
    chat_id: Optional[str],
) -> dict[str, Any]:
    source_metadata = dict(metadata or {})
    origin_prompt_submitted_at_ms = _normalize_nonnegative_int(
        source_metadata.get("origin_prompt_submitted_at_ms")
    )
    if origin_prompt_submitted_at_ms is None:
        origin_prompt_submitted_at_ms = _normalize_nonnegative_int(
            source_metadata.get("prompt_submitted_at_ms")
        )
    next_metadata = ensure_debug_request_metadata(
        source_metadata,
        force_new_debug_request_id=True,
        force_new_upstream_request_id=True,
        force_new_prompt_submitted_at_ms=True,
    )
    if origin_prompt_submitted_at_ms is not None:
        next_metadata["origin_prompt_submitted_at_ms"] = origin_prompt_submitted_at_ms
    else:
        next_metadata.pop("origin_prompt_submitted_at_ms", None)
    next_metadata["message_id"] = generate_debug_message_id()
    next_metadata["request_phase"] = AUXILIARY_REQUEST_PHASE
    next_metadata["task"] = str(task_name)
    next_metadata["task_body"] = task_body
    next_metadata["chat_id"] = chat_id
    next_metadata.pop("trigger_message_id", None)
    next_metadata["transcript_anchor_kind"] = "background"
    next_metadata.pop("transcript_anchor_message_id", None)
    next_metadata.pop("transcript_anchor_tool_block_index", None)
    return next_metadata


def restore_auxiliary_task_metadata(
    metadata: Optional[Mapping[str, Any]],
    auxiliary_metadata: Mapping[str, Any],
    *,
    task_name: Any,
    task_body: Any,
    chat_id: Optional[str],
) -> dict[str, Any]:
    next_metadata = dict(metadata or {})
    for key in (
        "user_id",
        "session_id",
        "message_id",
        "debug_request_id",
        "upstream_request_id",
        "prompt_submitted_at_ms",
        "origin_prompt_submitted_at_ms",
        "request_phase",
        "task",
        "task_body",
        "chat_id",
        "transcript_anchor_kind",
        "transcript_anchor_message_id",
        "transcript_anchor_tool_block_index",
    ):
        value = auxiliary_metadata.get(key)
        if value is not None:
            next_metadata[key] = value
    next_metadata["task"] = str(task_name)
    next_metadata["task_body"] = task_body
    next_metadata["chat_id"] = chat_id
    return next_metadata
