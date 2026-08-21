import asyncio
import copy
import json
import logging
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

try:
    from managers.skill_manager import get_skill_manager
except ImportError:
    get_skill_manager = None

from open_webui.utils.llm_debug import (
    generate_debug_request_id,
    generate_upstream_request_id,
)


log = logging.getLogger(__name__)

PENDING_CHAT_WORK_KEY_PREFIX = "pending_chat_work:"
PENDING_CHAT_WORK_LOCK_KEY_PREFIX = "pending_chat_work_lock:"
PENDING_CHAT_WORK_DRAIN_LOCK_KEY_PREFIX = "pending_chat_work_drain_lock:"

DEFAULT_LOCK_TIMEOUT_SECONDS = 30
DEFAULT_LOCK_WAIT_SECONDS = 5
LOCK_POLL_INTERVAL_SECONDS = 0.05
PENDING_CHAT_WORK_ACTIVE_TURN_RETRY_DELAY_SECONDS = 0.1
EMPTY_PENDING_CHAT_WORK_TOMBSTONE_TTL_SECONDS = 60

_pending_chat_work_active_turn_retry_tasks: dict[str, asyncio.Task] = {}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def empty_pending_chat_work_state(chat_id: str) -> dict[str, Any]:
    return {
        "chat_id": chat_id,
        "version": 0,
        "updated_at": utc_now_iso(),
        "pending_steer": None,
        "queued_prompts": [],
    }


def clone_pending_chat_work_state(state: dict[str, Any]) -> dict[str, Any]:
    return copy.deepcopy(state)


def normalize_pending_chat_work_state(
    chat_id: str, state: dict[str, Any] | None
) -> dict[str, Any]:
    normalized = empty_pending_chat_work_state(chat_id)
    if isinstance(state, dict):
        normalized["version"] = int(state.get("version") or 0)
        normalized["updated_at"] = state.get("updated_at") or normalized["updated_at"]
        normalized["pending_steer"] = copy.deepcopy(state.get("pending_steer"))
        queued_prompts = state.get("queued_prompts") or []
        if isinstance(queued_prompts, list):
            normalized["queued_prompts"] = copy.deepcopy(queued_prompts)
    return normalized


def sanitize_pending_work_item_for_client(item: dict[str, Any] | None) -> dict[str, Any] | None:
    if not item:
        return None

    sanitized = {
        "id": item.get("id"),
        "status": item.get("status"),
        "prompt": item.get("prompt") or "",
        "files": copy.deepcopy(item.get("files") or []),
        "created_at": item.get("created_at"),
        "updated_at": item.get("updated_at"),
        "last_error": item.get("last_error"),
        "attempt_count": int(item.get("attempt_count") or 0),
    }
    if "sort_index" in item:
        sanitized["sort_index"] = item.get("sort_index")
    return sanitized


def sanitize_pending_chat_work_state_for_client(state: dict[str, Any]) -> dict[str, Any]:
    return {
        "chat_id": state.get("chat_id"),
        "version": int(state.get("version") or 0),
        "updated_at": state.get("updated_at"),
        "pending_steer": sanitize_pending_work_item_for_client(state.get("pending_steer")),
        "queued_prompts": [
            sanitize_pending_work_item_for_client(item)
            for item in (state.get("queued_prompts") or [])
        ],
    }


def build_pending_work_item(
    *,
    prompt: str,
    files: list[dict[str, Any]] | None,
    request_context: dict[str, Any] | None,
    status: str,
    item_id: str | None = None,
    sort_index: int | None = None,
) -> dict[str, Any]:
    now = utc_now_iso()
    item = {
        "id": item_id or str(uuid4()),
        "status": status,
        "prompt": prompt or "",
        "files": copy.deepcopy(files or []),
        "request_context": copy.deepcopy(request_context or {}),
        "created_at": now,
        "updated_at": now,
        "last_error": None,
        "attempt_count": 0,
    }
    if sort_index is not None:
        item["sort_index"] = int(sort_index)
    return item


def pending_work_prompt_preview(prompt: str | None, *, limit: int = 80) -> str:
    normalized = " ".join(str(prompt or "").split())
    if len(normalized) <= limit:
        return normalized
    return f"{normalized[: max(0, limit - 3)]}..."


def is_pending_chat_work_assistant_terminal(message: dict[str, Any] | None) -> bool:
    if not isinstance(message, dict) or message.get("role") != "assistant":
        return False

    if message.get("done") is True:
        return True

    if message.get("stop_reason"):
        return True

    error = message.get("error")
    if error is None:
        return False

    if isinstance(error, str):
        return error.strip() != ""

    return True


def _append_current_turn_assistant_id(
    *,
    messages_map: dict[str, Any] | None,
    assistant_message_ids: list[str],
    seen_message_ids: set[str],
    message_id: Any,
) -> None:
    if not isinstance(message_id, str) or message_id in seen_message_ids:
        return

    message = (messages_map or {}).get(message_id)
    if not isinstance(message, dict) or message.get("role") != "assistant":
        return

    seen_message_ids.add(message_id)
    assistant_message_ids.append(message_id)


def get_pending_chat_work_current_turn_assistant_ids(
    history: dict[str, Any] | None,
) -> list[str]:
    if not isinstance(history, dict):
        return []

    messages_map = history.get("messages")
    current_id = history.get("currentId")
    if not isinstance(messages_map, dict) or not isinstance(current_id, str):
        return []

    current_message = messages_map.get(current_id)
    if not isinstance(current_message, dict):
        return []

    assistant_message_ids: list[str] = []
    seen_message_ids: set[str] = set()

    if current_message.get("role") == "user":
        for child_id in current_message.get("childrenIds") or []:
            _append_current_turn_assistant_id(
                messages_map=messages_map,
                assistant_message_ids=assistant_message_ids,
                seen_message_ids=seen_message_ids,
                message_id=child_id,
            )
        return assistant_message_ids

    if current_message.get("role") != "assistant":
        return assistant_message_ids

    parent_id = current_message.get("parentId")
    parent_message = messages_map.get(parent_id) if isinstance(parent_id, str) else None
    if isinstance(parent_message, dict) and parent_message.get("role") == "user":
        for child_id in parent_message.get("childrenIds") or []:
            _append_current_turn_assistant_id(
                messages_map=messages_map,
                assistant_message_ids=assistant_message_ids,
                seen_message_ids=seen_message_ids,
                message_id=child_id,
            )

    if not assistant_message_ids:
        _append_current_turn_assistant_id(
            messages_map=messages_map,
            assistant_message_ids=assistant_message_ids,
            seen_message_ids=seen_message_ids,
            message_id=current_id,
        )

    return assistant_message_ids


def chat_payload_has_active_current_turn(chat_payload: dict[str, Any] | None) -> bool:
    if not isinstance(chat_payload, dict):
        return False

    history = chat_payload.get("history")
    if not isinstance(history, dict):
        return False

    messages_map = history.get("messages")
    if not isinstance(messages_map, dict):
        return False

    for message_id in get_pending_chat_work_current_turn_assistant_ids(history):
        message = messages_map.get(message_id)
        if not is_pending_chat_work_assistant_terminal(message):
            return True

    return False


def is_pending_chat_work_empty(state: dict[str, Any]) -> bool:
    return not state.get("pending_steer") and not state.get("queued_prompts")


def next_queued_prompt_sort_index(state: dict[str, Any]) -> int:
    queued_prompts = state.get("queued_prompts") or []
    if not queued_prompts:
        return 0
    return max(int(item.get("sort_index") or 0) for item in queued_prompts) + 1


def ensure_pending_steer_is_active(state: dict[str, Any]) -> dict[str, Any] | None:
    pending_steer = state.get("pending_steer")
    if pending_steer and pending_steer.get("status") == "active":
        return pending_steer
    return None


def get_next_dispatchable_queued_prompt(state: dict[str, Any]) -> dict[str, Any] | None:
    queued_prompts = sorted(
        state.get("queued_prompts") or [],
        key=lambda item: int(item.get("sort_index") or 0),
    )
    if not queued_prompts:
        return None
    head = queued_prompts[0]
    if head.get("status") != "queued":
        return None
    return head


def split_message_files(
    files: list[dict[str, Any]] | None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    image_files: list[dict[str, Any]] = []
    top_level_files: list[dict[str, Any]] = []

    for file_item in files or []:
        content_type = str(file_item.get("content_type") or "")
        if file_item.get("type") == "image" or content_type.startswith("image/"):
            image_files.append(copy.deepcopy(file_item))
        else:
            top_level_files.append(copy.deepcopy(file_item))

    return image_files, top_level_files


def pending_work_item_to_request_message(
    item: dict[str, Any]
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    prompt = item.get("prompt") or ""
    image_files, top_level_files = split_message_files(item.get("files") or [])
    if image_files:
        message = {
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                *[
                    {
                        "type": "image_url",
                        "image_url": {"url": image_file.get("url")},
                    }
                    for image_file in image_files
                    if image_file.get("url")
                ],
            ],
        }
    else:
        message = {"role": "user", "content": prompt}
    return message, top_level_files


def build_background_dispatch_request_metadata(
    *,
    user_id: str,
    chat_id: str,
    session_id: str | None,
    assistant_message_id: str,
    user_message: dict[str, Any],
    request_context: dict[str, Any],
    model: Any,
    request_phase: str = "initial",
) -> dict[str, Any]:
    user_message_id = user_message.get("id")
    parent_message_id = user_message_id if isinstance(user_message_id, str) else None
    return {
        "user_id": user_id,
        "chat_id": chat_id,
        "session_id": session_id,
        "message_id": assistant_message_id,
        "debug_request_id": generate_debug_request_id(),
        "upstream_request_id": generate_upstream_request_id(),
        "parent_message": copy.deepcopy(user_message),
        "parent_message_id": parent_message_id,
        "trigger_message_id": parent_message_id,
        "transcript_anchor_kind": (
            "user_message"
            if isinstance(parent_message_id, str) and parent_message_id.strip()
            else "background"
        ),
        "transcript_anchor_message_id": (
            parent_message_id
            if isinstance(parent_message_id, str) and parent_message_id.strip()
            else None
        ),
        "transcript_anchor_tool_block_index": None,
        "request_phase": request_phase,
        "followup_index": None,
        "outer_message_id": None,
        "filter_ids": copy.deepcopy(request_context.get("filter_ids") or []),
        "tool_ids": copy.deepcopy(request_context.get("tool_ids") or []),
        "tool_servers": copy.deepcopy(request_context.get("tool_servers") or []),
        "files": copy.deepcopy(request_context.get("files") or []),
        "features": copy.deepcopy(request_context.get("features") or {}),
        "variables": copy.deepcopy(request_context.get("variables") or {}),
        "model": model,
    }


def merge_top_level_files(
    existing_files: list[dict[str, Any]] | None,
    appended_files: list[dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()

    for file_item in [*(existing_files or []), *(appended_files or [])]:
        serialized = json.dumps(file_item, sort_keys=True, default=str)
        if serialized in seen:
            continue
        seen.add(serialized)
        merged.append(copy.deepcopy(file_item))

    return merged


def inject_pending_steer_into_followup_messages(
    *,
    base_messages: list[dict[str, Any]],
    steer_item: dict[str, Any] | None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if not steer_item:
        return copy.deepcopy(base_messages), []

    steer_message, steer_files = pending_work_item_to_request_message(steer_item)
    messages = copy.deepcopy(base_messages)
    messages.append(steer_message)
    return messages, steer_files


def inject_pending_steer_into_continue_messages(
    *,
    base_messages: list[dict[str, Any]],
    continue_prompt: str,
    steer_item: dict[str, Any] | None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if not steer_item:
        messages = copy.deepcopy(base_messages)
        messages.append({"role": "user", "content": continue_prompt})
        return messages, []

    steer_message, steer_files = pending_work_item_to_request_message(steer_item)
    messages = copy.deepcopy(base_messages)
    messages.append(steer_message)
    return messages, steer_files


def append_user_steer_content_block(
    content_blocks: list[dict[str, Any]], steer_item: dict[str, Any]
) -> list[dict[str, Any]]:
    next_blocks = list(content_blocks)
    next_blocks.append(
        {
            "type": "user_steer",
            "id": steer_item.get("id"),
            "content": steer_item.get("prompt") or "",
            "files": copy.deepcopy(steer_item.get("files") or []),
            "created_at": steer_item.get("created_at"),
        }
    )
    return next_blocks


@asynccontextmanager
async def acquire_pending_chat_work_lock(
    redis_client,
    chat_id: str,
    *,
    scope: str = "state",
    timeout_seconds: int = DEFAULT_LOCK_TIMEOUT_SECONDS,
    wait_seconds: int = DEFAULT_LOCK_WAIT_SECONDS,
):
    if redis_client is None:
        yield None
        return

    if scope == "drain":
        lock_key = f"{PENDING_CHAT_WORK_DRAIN_LOCK_KEY_PREFIX}{chat_id}"
    else:
        lock_key = f"{PENDING_CHAT_WORK_LOCK_KEY_PREFIX}{chat_id}"

    token = str(uuid4())
    deadline = time.monotonic() + max(wait_seconds, LOCK_POLL_INTERVAL_SECONDS)
    acquired = False

    while time.monotonic() < deadline:
        try:
            acquired = bool(
                await redis_client.set(lock_key, token, ex=timeout_seconds, nx=True)
            )
        except Exception as error:
            log.warning("[PendingChatWork] Failed to acquire lock %s: %s", lock_key, error)
            acquired = False

        if acquired:
            break
        await asyncio.sleep(LOCK_POLL_INTERVAL_SECONDS)

    if not acquired:
        raise TimeoutError(f"Timed out waiting for pending chat work lock for {chat_id}")

    try:
        yield token
    finally:
        try:
            current_value = await redis_client.get(lock_key)
            if current_value == token:
                await redis_client.delete(lock_key)
        except Exception as error:
            log.warning("[PendingChatWork] Failed to release lock %s: %s", lock_key, error)


async def load_pending_chat_work_state(redis_client, chat_id: str) -> dict[str, Any]:
    if redis_client is None:
        return empty_pending_chat_work_state(chat_id)

    key = f"{PENDING_CHAT_WORK_KEY_PREFIX}{chat_id}"
    raw_state = await redis_client.get(key)
    if not raw_state:
        return empty_pending_chat_work_state(chat_id)

    try:
        return normalize_pending_chat_work_state(chat_id, json.loads(raw_state))
    except Exception as error:
        log.warning(
            "[PendingChatWork] Failed to decode pending chat work for %s: %s",
            chat_id,
            error,
        )
        return empty_pending_chat_work_state(chat_id)


async def save_pending_chat_work_state(
    redis_client, chat_id: str, state: dict[str, Any]
) -> dict[str, Any]:
    normalized = normalize_pending_chat_work_state(chat_id, state)
    normalized["version"] = int(normalized.get("version") or 0) + 1
    normalized["updated_at"] = utc_now_iso()

    key = f"{PENDING_CHAT_WORK_KEY_PREFIX}{chat_id}"
    if redis_client is None:
        return normalized

    if is_pending_chat_work_empty(normalized):
        await redis_client.set(
            key,
            json.dumps(normalized),
            ex=EMPTY_PENDING_CHAT_WORK_TOMBSTONE_TTL_SECONDS,
        )
        return normalized

    await redis_client.set(key, json.dumps(normalized))
    return normalized


async def replace_pending_steer(
    redis_client,
    chat_id: str,
    *,
    prompt: str,
    files: list[dict[str, Any]] | None,
    request_context: dict[str, Any] | None,
    item_id: str | None = None,
    status: str = "active",
) -> dict[str, Any]:
    async with acquire_pending_chat_work_lock(redis_client, chat_id):
        state = await load_pending_chat_work_state(redis_client, chat_id)
        existing = state.get("pending_steer")
        item = build_pending_work_item(
            prompt=prompt,
            files=files,
            request_context=request_context,
            status=status,
            item_id=item_id or (existing or {}).get("id"),
        )
        if existing:
            item["created_at"] = existing.get("created_at") or item["created_at"]
            item["attempt_count"] = int(existing.get("attempt_count") or 0)
        state["pending_steer"] = item
        saved_state = await save_pending_chat_work_state(redis_client, chat_id, state)
        log.info(
            "[PendingChatWork] Stored pending steer chat_id=%s item_id=%s status=%s prompt=%r",
            chat_id,
            item.get("id"),
            item.get("status"),
            pending_work_prompt_preview(item.get("prompt")),
        )
        return saved_state


async def update_pending_steer(
    redis_client,
    chat_id: str,
    *,
    item_id: str,
    patch: dict[str, Any],
) -> dict[str, Any]:
    async with acquire_pending_chat_work_lock(redis_client, chat_id):
        state = await load_pending_chat_work_state(redis_client, chat_id)
        pending_steer = state.get("pending_steer")
        if not pending_steer or pending_steer.get("id") != item_id:
            return state

        updated = copy.deepcopy(pending_steer)
        updated.update(copy.deepcopy(patch))
        updated["updated_at"] = utc_now_iso()
        state["pending_steer"] = updated
        saved_state = await save_pending_chat_work_state(redis_client, chat_id, state)
        log.info(
            "[PendingChatWork] Updated pending steer chat_id=%s item_id=%s status=%s",
            chat_id,
            item_id,
            updated.get("status"),
        )
        return saved_state


async def delete_pending_steer(
    redis_client,
    chat_id: str,
    *,
    item_id: str | None = None,
) -> dict[str, Any]:
    async with acquire_pending_chat_work_lock(redis_client, chat_id):
        state = await load_pending_chat_work_state(redis_client, chat_id)
        pending_steer = state.get("pending_steer")
        if pending_steer and (item_id is None or pending_steer.get("id") == item_id):
            state["pending_steer"] = None
        saved_state = await save_pending_chat_work_state(redis_client, chat_id, state)
        if pending_steer and (item_id is None or pending_steer.get("id") == item_id):
            log.info(
                "[PendingChatWork] Deleted pending steer chat_id=%s item_id=%s",
                chat_id,
                pending_steer.get("id"),
            )
        return saved_state


async def consume_pending_steer(
    redis_client, chat_id: str
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    async with acquire_pending_chat_work_lock(redis_client, chat_id):
        state = await load_pending_chat_work_state(redis_client, chat_id)
        pending_steer = ensure_pending_steer_is_active(state)
        if not pending_steer:
            return None, state
        state["pending_steer"] = None
        saved_state = await save_pending_chat_work_state(redis_client, chat_id, state)
        log.info(
            "[PendingChatWork] Consumed pending steer chat_id=%s item_id=%s prompt=%r",
            chat_id,
            pending_steer.get("id"),
            pending_work_prompt_preview(pending_steer.get("prompt")),
        )
        return pending_steer, saved_state


async def append_queued_prompt(
    redis_client,
    chat_id: str,
    *,
    prompt: str,
    files: list[dict[str, Any]] | None,
    request_context: dict[str, Any] | None,
    item_id: str | None = None,
    status: str = "queued",
) -> dict[str, Any]:
    async with acquire_pending_chat_work_lock(redis_client, chat_id):
        state = await load_pending_chat_work_state(redis_client, chat_id)
        state.setdefault("queued_prompts", [])
        item = build_pending_work_item(
            prompt=prompt,
            files=files,
            request_context=request_context,
            status=status,
            item_id=item_id,
            sort_index=next_queued_prompt_sort_index(state),
        )
        state["queued_prompts"].append(item)
        saved_state = await save_pending_chat_work_state(redis_client, chat_id, state)
        log.info(
            "[PendingChatWork] Appended queued prompt chat_id=%s item_id=%s sort_index=%s prompt=%r",
            chat_id,
            item.get("id"),
            item.get("sort_index"),
            pending_work_prompt_preview(item.get("prompt")),
        )
        return saved_state


async def update_queued_prompt(
    redis_client,
    chat_id: str,
    *,
    item_id: str,
    patch: dict[str, Any],
) -> dict[str, Any]:
    async with acquire_pending_chat_work_lock(redis_client, chat_id):
        state = await load_pending_chat_work_state(redis_client, chat_id)
        updated_prompts: list[dict[str, Any]] = []
        for item in state.get("queued_prompts") or []:
            if item.get("id") != item_id:
                updated_prompts.append(item)
                continue
            next_item = copy.deepcopy(item)
            next_item.update(copy.deepcopy(patch))
            next_item["updated_at"] = utc_now_iso()
            next_item["sort_index"] = item.get("sort_index")
            updated_prompts.append(next_item)
        state["queued_prompts"] = updated_prompts
        saved_state = await save_pending_chat_work_state(redis_client, chat_id, state)
        log.info(
            "[PendingChatWork] Updated queued prompt chat_id=%s item_id=%s",
            chat_id,
            item_id,
        )
        return saved_state


async def delete_queued_prompt(
    redis_client,
    chat_id: str,
    *,
    item_id: str,
) -> dict[str, Any]:
    async with acquire_pending_chat_work_lock(redis_client, chat_id):
        state = await load_pending_chat_work_state(redis_client, chat_id)
        state["queued_prompts"] = [
            item
            for item in (state.get("queued_prompts") or [])
            if item.get("id") != item_id
        ]
        saved_state = await save_pending_chat_work_state(redis_client, chat_id, state)
        log.info(
            "[PendingChatWork] Deleted queued prompt chat_id=%s item_id=%s",
            chat_id,
            item_id,
        )
        return saved_state


async def pop_next_queued_prompt(
    redis_client, chat_id: str
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    async with acquire_pending_chat_work_lock(redis_client, chat_id):
        state = await load_pending_chat_work_state(redis_client, chat_id)
        next_item = get_next_dispatchable_queued_prompt(state)
        if not next_item:
            return None, state

        remaining_items = [
            item
            for item in (state.get("queued_prompts") or [])
            if item.get("id") != next_item.get("id")
        ]
        state["queued_prompts"] = remaining_items
        saved_state = await save_pending_chat_work_state(redis_client, chat_id, state)
        log.info(
            "[PendingChatWork] Popped queued prompt chat_id=%s item_id=%s sort_index=%s prompt=%r",
            chat_id,
            next_item.get("id"),
            next_item.get("sort_index"),
            pending_work_prompt_preview(next_item.get("prompt")),
        )
        return next_item, saved_state


async def restore_pending_chat_item_after_dispatch_failure(
    redis_client,
    chat_id: str,
    *,
    item: dict[str, Any],
    error: str,
) -> dict[str, Any]:
    async with acquire_pending_chat_work_lock(redis_client, chat_id):
        state = await load_pending_chat_work_state(redis_client, chat_id)
        restored_item = copy.deepcopy(item)
        restored_item["attempt_count"] = int(restored_item.get("attempt_count") or 0) + 1
        restored_item["last_error"] = error
        restored_item["updated_at"] = utc_now_iso()

        if "sort_index" in restored_item:
            replaced = False
            queued_prompts = []
            for queued_item in state.get("queued_prompts") or []:
                if queued_item.get("id") == restored_item.get("id"):
                    queued_prompts.append(restored_item)
                    replaced = True
                else:
                    queued_prompts.append(queued_item)
            if not replaced:
                queued_prompts.append(restored_item)
            state["queued_prompts"] = queued_prompts
        elif state.get("pending_steer") is None:
            restored_item["status"] = "active"
            state["pending_steer"] = restored_item
        else:
            restored_item["status"] = "queued"
            restored_item["sort_index"] = next_queued_prompt_sort_index(state)
            state.setdefault("queued_prompts", []).append(restored_item)
            log.warning(
                "[PendingChatWork] Restored failed steer as queued prompt chat_id=%s item_id=%s",
                chat_id,
                restored_item.get("id"),
            )

        saved_state = await save_pending_chat_work_state(redis_client, chat_id, state)
        log.warning(
            "[PendingChatWork] Restored pending item after dispatch failure chat_id=%s item_id=%s error=%s",
            chat_id,
            restored_item.get("id"),
            error,
        )
        return saved_state


async def emit_pending_chat_work_updated(
    *,
    sio,
    user_id: str,
    chat_id: str,
    state: dict[str, Any],
) -> None:
    event_data = {
        "chat_id": chat_id,
        "message_id": None,
        "data": {
            "type": "chat:pending-work:updated",
            "data": {
                "chat_id": chat_id,
                "pending_work": sanitize_pending_chat_work_state_for_client(state),
            },
        },
    }
    await sio.emit("events", event_data, room=f"user:{user_id}")


async def emit_multi_chat_pane_added(
    *,
    sio,
    user_id: str,
    root_chat_id: str,
    pane: dict[str, Any],
) -> None:
    """Notify the owner's open views that a start_chat pane joined the root
    chat's tile grid (frontend enters/extends multi-chat tiling live)."""
    event_data = {
        "chat_id": root_chat_id,
        "message_id": None,
        "data": {
            "type": "chat:multi-chat:pane-added",
            "data": {
                "root_chat_id": root_chat_id,
                "pane": copy.deepcopy(pane),
            },
        },
    }
    await sio.emit("events", event_data, room=f"user:{user_id}")


async def emit_background_turn_inserted(
    *,
    sio,
    user_id: str,
    chat_id: str,
    user_message: dict[str, Any],
    assistant_messages: list[dict[str, Any]],
    current_id: str | None,
    pending_work_state: dict[str, Any] | None,
    item_kind: str,
    item_id: str | None,
) -> None:
    user_message_id = user_message.get("id")
    assistant_message_ids = [
        assistant_message.get("id")
        for assistant_message in assistant_messages
        if isinstance(assistant_message, dict) and assistant_message.get("id")
    ]
    event_data = {
        "chat_id": chat_id,
        "message_id": assistant_message_ids[0] if assistant_message_ids else user_message_id,
        "data": {
            "type": "chat:background-turn:inserted",
            "data": {
                "chat_id": chat_id,
                "user_message_id": user_message_id,
                "assistant_message_ids": copy.deepcopy(assistant_message_ids),
                "user_message": copy.deepcopy(user_message),
                "assistant_messages": copy.deepcopy(assistant_messages),
                "current_id": current_id,
                "pending_work": sanitize_pending_chat_work_state_for_client(
                    pending_work_state or empty_pending_chat_work_state(chat_id)
                ),
                "item_kind": item_kind,
                "item_id": item_id,
            },
        },
    }
    await sio.emit("events", event_data, room=f"user:{user_id}")


def repair_missing_parent_message_in_chat_payload(
    *,
    chat_payload: dict[str, Any] | None,
    parent_message_id: str | None,
    parent_message: dict[str, Any] | None,
) -> bool:
    if (
        not isinstance(chat_payload, dict)
        or not isinstance(parent_message_id, str)
        or not isinstance(parent_message, dict)
    ):
        return False

    history = chat_payload.setdefault("history", {})
    messages_map = history.setdefault("messages", {})
    if not isinstance(messages_map, dict):
        return False

    if isinstance(messages_map.get(parent_message_id), dict):
        return False

    restored_parent_message = copy.deepcopy(parent_message)
    restored_parent_message["id"] = parent_message_id
    restored_parent_message.setdefault("childrenIds", [])
    messages_map[parent_message_id] = restored_parent_message

    grandparent_id = restored_parent_message.get("parentId")
    grandparent_message = (
        messages_map.get(grandparent_id) if isinstance(grandparent_id, str) else None
    )
    if isinstance(grandparent_message, dict):
        grandparent_children = list(grandparent_message.get("childrenIds") or [])
        if parent_message_id not in grandparent_children:
            grandparent_children.append(parent_message_id)
            grandparent_message["childrenIds"] = grandparent_children

    sync_flattened_message_with_history(chat_payload, parent_message_id)
    return True


def is_background_turn_branch_persisted(
    *,
    chat_payload: dict[str, Any] | None,
    parent_message_id: str | None,
    user_message: dict[str, Any] | None,
    assistant_messages: list[dict[str, Any]] | None,
    current_id: str | None = None,
) -> bool:
    if (
        not isinstance(chat_payload, dict)
        or not isinstance(user_message, dict)
        or not isinstance(assistant_messages, list)
    ):
        return False

    user_message_id = user_message.get("id")
    if not isinstance(user_message_id, str) or not user_message_id:
        return False

    assistant_message_ids = [
        assistant_message.get("id")
        for assistant_message in assistant_messages
        if isinstance(assistant_message, dict)
        and isinstance(assistant_message.get("id"), str)
        and assistant_message.get("id")
    ]
    if not assistant_message_ids:
        return False

    history = chat_payload.get("history")
    if not isinstance(history, dict):
        return False

    messages_map = history.get("messages")
    if not isinstance(messages_map, dict):
        return False

    persisted_user_message = messages_map.get(user_message_id)
    if not isinstance(persisted_user_message, dict):
        return False

    if isinstance(parent_message_id, str):
        if persisted_user_message.get("parentId") != parent_message_id:
            return False

        parent_message = messages_map.get(parent_message_id)
        if not isinstance(parent_message, dict):
            return False

        parent_children_ids = list(parent_message.get("childrenIds") or [])
        if user_message_id not in parent_children_ids:
            return False

    persisted_user_children_ids = set(persisted_user_message.get("childrenIds") or [])
    if not set(assistant_message_ids).issubset(persisted_user_children_ids):
        return False

    for assistant_message_id in assistant_message_ids:
        persisted_assistant_message = messages_map.get(assistant_message_id)
        if not isinstance(persisted_assistant_message, dict):
            return False
        if persisted_assistant_message.get("parentId") != user_message_id:
            return False

    expected_current_id = (
        current_id if isinstance(current_id, str) and current_id else assistant_message_ids[-1]
    )
    if history.get("currentId") != expected_current_id:
        return False

    flat_messages = chat_payload.get("messages")
    if flat_messages is None:
        return False
    if not isinstance(flat_messages, list):
        return False

    flat_message_ids = [
        message.get("id")
        for message in flat_messages
        if isinstance(message, dict) and isinstance(message.get("id"), str)
    ]
    if user_message_id not in flat_message_ids:
        return False
    user_message_index = flat_message_ids.index(user_message_id)
    for assistant_message_id in assistant_message_ids:
        if assistant_message_id not in flat_message_ids:
            return False
        if flat_message_ids.index(assistant_message_id) <= user_message_index:
            return False

    return True


def repair_missing_background_turn_branch_in_chat_payload(
    *,
    chat_payload: dict[str, Any] | None,
    parent_message_id: str | None,
    user_message: dict[str, Any] | None,
    assistant_messages: list[dict[str, Any]] | None,
    current_id: str | None = None,
) -> bool:
    if (
        not isinstance(chat_payload, dict)
        or not isinstance(user_message, dict)
        or not isinstance(assistant_messages, list)
    ):
        return False

    user_message_id = user_message.get("id")
    if not isinstance(user_message_id, str) or not user_message_id:
        return False

    normalized_assistant_messages = [
        copy.deepcopy(assistant_message)
        for assistant_message in assistant_messages
        if isinstance(assistant_message, dict)
        and isinstance(assistant_message.get("id"), str)
        and assistant_message.get("id")
    ]
    if not normalized_assistant_messages:
        return False

    history = chat_payload.setdefault("history", {})
    messages_map = history.setdefault("messages", {})
    if not isinstance(messages_map, dict):
        return False

    changed = False

    persisted_user_message = messages_map.get(user_message_id)
    if not isinstance(persisted_user_message, dict):
        persisted_user_message = copy.deepcopy(user_message)
        persisted_user_message["id"] = user_message_id
        messages_map[user_message_id] = persisted_user_message
        changed = True

    if isinstance(parent_message_id, str) and persisted_user_message.get("parentId") != parent_message_id:
        persisted_user_message["parentId"] = parent_message_id
        changed = True

    persisted_user_children_ids = list(persisted_user_message.get("childrenIds") or [])

    if isinstance(parent_message_id, str):
        parent_message = messages_map.get(parent_message_id)
        if isinstance(parent_message, dict):
            parent_children_ids = list(parent_message.get("childrenIds") or [])
            if user_message_id not in parent_children_ids:
                parent_children_ids.append(user_message_id)
                parent_message["childrenIds"] = parent_children_ids
                changed = True

    sync_flattened_message_with_history(chat_payload, user_message_id)

    for assistant_message in normalized_assistant_messages:
        assistant_message_id = assistant_message["id"]
        persisted_assistant_message = messages_map.get(assistant_message_id)
        if not isinstance(persisted_assistant_message, dict):
            persisted_assistant_message = assistant_message
            messages_map[assistant_message_id] = persisted_assistant_message
            changed = True

        if persisted_assistant_message.get("parentId") != user_message_id:
            persisted_assistant_message["parentId"] = user_message_id
            changed = True

        if assistant_message_id not in persisted_user_children_ids:
            persisted_user_children_ids.append(assistant_message_id)
            changed = True

        sync_flattened_message_with_history(chat_payload, assistant_message_id)

    if list(persisted_user_message.get("childrenIds") or []) != persisted_user_children_ids:
        persisted_user_message["childrenIds"] = persisted_user_children_ids
        changed = True

    sync_flattened_message_with_history(chat_payload, user_message_id)

    expected_current_id = (
        current_id
        if isinstance(current_id, str) and current_id
        else normalized_assistant_messages[-1]["id"]
    )
    if history.get("currentId") != expected_current_id:
        history["currentId"] = expected_current_id
        changed = True

    return changed


def build_background_task_request_context_defaults(
    request_context: dict[str, Any] | None,
) -> dict[str, Any]:
    context = copy.deepcopy(request_context or {})
    context.setdefault("selected_model_ids", [])
    context.setdefault("selected_model_items", {})
    context.setdefault("tool_ids", [])
    context.setdefault("tool_servers", [])
    context.setdefault("filter_ids", [])
    context.setdefault("features", {})
    context.setdefault("reasoning_effort_by_model", {})
    context.setdefault("params", {})
    context.setdefault("variables", {})
    context.setdefault("background_tasks", {"follow_up_generation": True})
    context.setdefault("session_id", None)
    return context


def _coerce_tool_ids(tool_ids: Any) -> list[str]:
    if not tool_ids:
        return []
    if isinstance(tool_ids, str):
        return [tool_ids]
    return [str(tool_id) for tool_id in tool_ids if tool_id]


def _normalize_server_tool_id(server_id: Any) -> str:
    normalized = str(server_id or "").strip()
    if not normalized:
        return ""
    if normalized.startswith("server:"):
        normalized = normalized.split("server:", 1)[1]
    return f"server:{normalized}" if normalized else ""


def _message_has_replayed_tool_history(message: dict[str, Any] | None) -> bool:
    if not isinstance(message, dict):
        return False

    if message.get("role") == "tool":
        return True

    if message.get("role") == "assistant" and message.get("tool_calls"):
        return True

    for block in message.get("contentBlocks") or []:
        if not isinstance(block, dict):
            continue
        if str(block.get("type") or "") == "tool_calls":
            return True

    content = message.get("content")
    if isinstance(content, list):
        for part in content:
            if not isinstance(part, dict):
                continue
            if str(part.get("type") or "") in {
                "toolUse",
                "toolResult",
                "tool_use",
                "tool_result",
            }:
                return True

    return False


def branch_has_replayed_tool_history(message_list: list[dict[str, Any]] | None) -> bool:
    return any(_message_has_replayed_tool_history(message) for message in (message_list or []))


async def load_pending_chat_tool_ids_from_redis(request, chat_id: str) -> list[str]:
    redis_client = getattr(getattr(request, "app", None), "state", None)
    redis_client = getattr(redis_client, "redis", None)
    if redis_client is None or not chat_id:
        return []

    try:
        chat_tools_json = await redis_client.get(f"chat_tools:{chat_id}")
        if not chat_tools_json:
            return []

        if isinstance(chat_tools_json, bytes):
            chat_tools_json = chat_tools_json.decode("utf-8")

        chat_tools = json.loads(chat_tools_json)
        if not isinstance(chat_tools, list):
            return []

        return [str(tool_id) for tool_id in chat_tools if tool_id]
    except Exception:
        log.exception(
            "[PendingChatWork] Failed to load Redis chat tools for replay fallback chat_id=%s",
            chat_id,
        )
        return []


async def load_pending_chat_skill_required_tool_ids_from_redis(
    request,
    chat_id: str,
) -> list[str]:
    redis_client = getattr(getattr(request, "app", None), "state", None)
    redis_client = getattr(redis_client, "redis", None)
    if redis_client is None or not chat_id or get_skill_manager is None:
        return []

    try:
        activated_skills_json = await redis_client.get(f"chat_skills:{chat_id}")
        if not activated_skills_json:
            return []

        if isinstance(activated_skills_json, bytes):
            activated_skills_json = activated_skills_json.decode("utf-8")

        activated_skills = json.loads(activated_skills_json)
        if not isinstance(activated_skills, list) or not activated_skills:
            return []

        skill_manager = get_skill_manager()
        if skill_manager is None:
            return []

        required_tool_ids: list[str] = []
        for skill_name in activated_skills:
            if not isinstance(skill_name, str) or not skill_name:
                continue
            metadata = skill_manager.get_skill_metadata(skill_name)
            if metadata is None:
                continue
            for server_id in metadata.required_mcp_servers or []:
                tool_id = _normalize_server_tool_id(server_id)
                if tool_id and tool_id not in required_tool_ids:
                    required_tool_ids.append(tool_id)

        return required_tool_ids
    except Exception:
        log.exception(
            "[PendingChatWork] Failed to load skill-derived replay tools for chat_id=%s",
            chat_id,
        )
        return []


async def maybe_backfill_pending_dispatch_tool_ids(
    *,
    request,
    chat_id: str,
    message_list: list[dict[str, Any]],
    request_context: dict[str, Any],
) -> list[str]:
    existing_tool_ids = _coerce_tool_ids(request_context.get("tool_ids"))
    if not branch_has_replayed_tool_history(message_list):
        return existing_tool_ids

    redis_tool_ids = await load_pending_chat_tool_ids_from_redis(request, chat_id)

    merged_tool_ids = list(existing_tool_ids)
    injected_tool_ids: list[str] = []
    redis_injected_tool_ids: list[str] = []
    for tool_id in redis_tool_ids:
        if tool_id in merged_tool_ids:
            continue
        merged_tool_ids.append(tool_id)
        injected_tool_ids.append(tool_id)
        redis_injected_tool_ids.append(tool_id)

    if injected_tool_ids:
        request_context["tool_ids"] = merged_tool_ids
        log.info(
            "[PendingChatWork] Resolved replay tool ids chat_id=%s redis_injected=%s existing=%s merged=%s",
            chat_id,
            redis_injected_tool_ids,
            existing_tool_ids,
            merged_tool_ids,
        )

    return merged_tool_ids


def build_chat_request_messages(
    *,
    message_list: list[dict[str, Any]],
    system_prompt: str | None,
) -> list[dict[str, Any]]:
    request_messages: list[dict[str, Any]] = []

    if system_prompt:
        request_messages.append({"role": "system", "content": system_prompt})

    for message in message_list:
        image_files, _ = split_message_files(message.get("files") or [])
        next_message: dict[str, Any] = {"role": message.get("role")}
        if message.get("contentBlocks"):
            next_message["contentBlocks"] = copy.deepcopy(message.get("contentBlocks"))

        if message.get("role") == "user" and image_files:
            next_message["content"] = [
                {
                    "type": "text",
                    "text": message.get("merged", {}).get("content")
                    or message.get("content")
                    or "",
                },
                *[
                    {
                        "type": "image_url",
                        "image_url": {"url": image_file.get("url")},
                    }
                    for image_file in image_files
                    if image_file.get("url")
                ],
            ]
        else:
            next_message["content"] = (
                message.get("merged", {}).get("content")
                or message.get("content")
                or ""
            )

        if next_message["role"] == "user":
            request_messages.append(next_message)
            continue

        content = next_message.get("content")
        if isinstance(content, str) and content.strip():
            request_messages.append(next_message)

    return request_messages


def build_background_user_message(
    *,
    parent_id: str | None,
    prompt: str,
    files: list[dict[str, Any]] | None,
    selected_model_ids: list[str],
) -> dict[str, Any]:
    return {
        "id": str(uuid4()),
        "parentId": parent_id,
        "childrenIds": [],
        "role": "user",
        "content": prompt or "",
        "files": copy.deepcopy(files or []) or None,
        "timestamp": int(time.time()),
        "models": copy.deepcopy(selected_model_ids),
    }


def build_background_assistant_message(
    *,
    parent_id: str,
    model_id: str,
    model_name: str,
    model_idx: int,
) -> dict[str, Any]:
    return {
        "parentId": parent_id,
        "id": str(uuid4()),
        "childrenIds": [],
        "role": "assistant",
        "content": "",
        "done": False,
        "model": model_id,
        "modelName": model_name,
        "modelIdx": model_idx,
        "timestamp": int(time.time()),
    }


def sync_flattened_message_with_history(chat_payload: dict, message_id: str) -> bool:
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


def mark_chat_payload_message_terminal(
    chat_payload: dict[str, Any],
    message_id: str,
    *,
    stop_reason: str | None = None,
) -> bool:
    if not isinstance(chat_payload, dict) or not message_id:
        return False

    history = chat_payload.get("history")
    if not isinstance(history, dict):
        return False

    history_messages = history.get("messages")
    if not isinstance(history_messages, dict):
        return False

    message = history_messages.get(message_id)
    if not isinstance(message, dict):
        return False

    changed = False
    if message.get("done") is not True:
        message["done"] = True
        changed = True

    normalized_stop_reason = str(stop_reason or "").strip()
    if normalized_stop_reason and message.get("stop_reason") != normalized_stop_reason:
        message["stop_reason"] = normalized_stop_reason
        changed = True

    flattened_changed = sync_flattened_message_with_history(chat_payload, message_id)
    return changed or flattened_changed


def resolve_background_dispatch_parent_id(
    history: dict[str, Any], messages_map: dict[str, Any], flat_messages: list[dict[str, Any]] | None
) -> str | None:
    current_id = history.get("currentId")
    if current_id and isinstance(messages_map.get(current_id), dict):
        return current_id

    if isinstance(flat_messages, list):
        for message in reversed(flat_messages):
            message_id = message.get("id") if isinstance(message, dict) else None
            if message_id and isinstance(messages_map.get(message_id), dict):
                return message_id

    leaf_candidates = [
        message
        for message in messages_map.values()
        if isinstance(message, dict) and not (message.get("childrenIds") or [])
    ]
    if not leaf_candidates:
        return None

    leaf_candidates.sort(
        key=lambda message: (
            int(message.get("timestamp") or 0),
            str(message.get("id") or ""),
        )
    )
    return leaf_candidates[-1].get("id")


def insert_background_dispatch_messages(
    *,
    chat_payload: dict[str, Any],
    prompt: str,
    files: list[dict[str, Any]] | None,
    selected_model_ids: list[str],
    selected_model_items: dict[str, Any] | None,
    app_models: dict[str, Any] | None,
    parent_id: str | None = None,
) -> tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
    next_chat_payload = copy.deepcopy(chat_payload)
    history = next_chat_payload.setdefault("history", {})
    messages_map = history.setdefault("messages", {})
    flat_messages = next_chat_payload.get("messages")
    resolved_parent_id = (
        parent_id
        if isinstance(parent_id, str) and isinstance(messages_map.get(parent_id), dict)
        else resolve_background_dispatch_parent_id(history, messages_map, flat_messages)
    )
    if history.get("currentId") != resolved_parent_id:
        history["currentId"] = resolved_parent_id

    user_message = build_background_user_message(
        parent_id=resolved_parent_id,
        prompt=prompt,
        files=files,
        selected_model_ids=selected_model_ids,
    )
    messages_map[user_message["id"]] = user_message

    if resolved_parent_id and messages_map.get(resolved_parent_id):
        parent = messages_map[resolved_parent_id]
        parent_children = list(parent.get("childrenIds") or [])
        if user_message["id"] not in parent_children:
            parent_children.append(user_message["id"])
        parent["childrenIds"] = parent_children

    sync_flattened_message_with_history(next_chat_payload, user_message["id"])

    assistant_messages: list[dict[str, Any]] = []
    selected_model_items = selected_model_items or {}
    app_models = app_models or {}

    for model_idx, model_id in enumerate(selected_model_ids):
        model_item = selected_model_items.get(model_id) or app_models.get(model_id) or {}
        assistant_message = build_background_assistant_message(
            parent_id=user_message["id"],
            model_id=model_id,
            model_name=model_item.get("name") or model_id,
            model_idx=model_idx,
        )
        assistant_messages.append(assistant_message)
        messages_map[assistant_message["id"]] = assistant_message
        if assistant_message["id"] not in user_message["childrenIds"]:
            user_message["childrenIds"].append(assistant_message["id"])
        history["currentId"] = assistant_message["id"]
        sync_flattened_message_with_history(next_chat_payload, assistant_message["id"])

    if not assistant_messages:
        history["currentId"] = user_message["id"]

    return next_chat_payload, user_message, assistant_messages


async def _update_chat_with_background_dispatch_messages(chat_id: str, next_chat_payload: dict[str, Any]):
    from open_webui.models.chats import Chats

    Chats.update_chat_by_id(chat_id, next_chat_payload)


async def dispatch_pending_chat_item(
    *,
    request,
    user,
    chat_id: str,
    item: dict[str, Any],
    item_kind: str,
    pending_state: dict[str, Any],
    sio=None,
    triggered_at: float | None = None,
) -> tuple[bool, bool]:
    from open_webui.main import chat_completion
    from open_webui.models.chats import Chats
    from open_webui.utils.misc import get_message_list

    chat = Chats.get_chat_by_id_and_user_id(chat_id, user.id)
    if chat is None:
        log.warning("[PendingChatWork] Cannot dispatch item for missing chat %s", chat_id)
        return False, False

    request_context = build_background_task_request_context_defaults(
        item.get("request_context")
    )
    selected_model_ids = request_context.get("selected_model_ids") or []
    if not selected_model_ids:
        log.warning(
            "[PendingChatWork] Skipping dispatch for %s because no selected models were captured",
            chat_id,
        )
        return False, False

    log.info(
        "[PendingChatWork] Starting background dispatch chat_id=%s item_id=%s models=%s prompt=%r",
        chat_id,
        item.get("id"),
        selected_model_ids,
        pending_work_prompt_preview(item.get("prompt")),
    )
    if triggered_at is not None:
        log.info(
            "[PendingChatWork] terminal_to_dispatch_ms chat_id=%s item_id=%s elapsed_ms=%.1f",
            chat_id,
            item.get("id"),
            max(0.0, (time.monotonic() - triggered_at) * 1000.0),
        )

    next_chat_payload, user_message, assistant_messages = insert_background_dispatch_messages(
        chat_payload=chat.chat,
        prompt=item.get("prompt") or "",
        files=item.get("files") or [],
        selected_model_ids=selected_model_ids,
        selected_model_items=request_context.get("selected_model_items") or {},
        app_models=getattr(request.app.state, "MODELS", {}) or {},
    )
    await _update_chat_with_background_dispatch_messages(chat_id, next_chat_payload)
    log.info(
        "[PendingChatWork] Inserted background turn chat_id=%s item_id=%s kind=%s user_message_id=%s assistant_message_ids=%s",
        chat_id,
        item.get("id"),
        item_kind,
        user_message.get("id"),
        [assistant_message.get("id") for assistant_message in assistant_messages],
    )
    if sio is not None:
        try:
            await emit_background_turn_inserted(
                sio=sio,
                user_id=user.id,
                chat_id=chat_id,
                user_message=user_message,
                assistant_messages=assistant_messages,
                current_id=next_chat_payload.get("history", {}).get("currentId"),
                pending_work_state=pending_state,
                item_kind=item_kind,
                item_id=item.get("id"),
            )
        except Exception as error:
            log.warning(
                "[PendingChatWork] Failed to emit background-turn insertion event for %s: %s",
                chat_id,
                error,
            )

    history = next_chat_payload.get("history", {})
    messages_map = history.get("messages", {}) or {}
    base_chat_files = next_chat_payload.get("files") or []

    dispatch_ok = True
    any_dispatch_started = False
    for assistant_message in assistant_messages:
        branch_messages = get_message_list(messages_map, assistant_message["id"])
        api_messages = build_chat_request_messages(
            message_list=branch_messages,
            system_prompt=(request_context.get("params") or {}).get("system"),
        )
        tool_ids = await maybe_backfill_pending_dispatch_tool_ids(
            request=request,
            chat_id=chat_id,
            message_list=branch_messages,
            request_context=request_context,
        )
        _, attached_non_image_files = split_message_files(user_message.get("files") or [])
        request_files = merge_top_level_files(base_chat_files, attached_non_image_files)
        model_id = assistant_message.get("model")
        model_idx = int(assistant_message.get("modelIdx") or 0)
        request_metadata = build_background_dispatch_request_metadata(
            user_id=user.id,
            chat_id=chat_id,
            session_id=request_context.get("session_id")
            or f"pending-work:{chat_id}",
            assistant_message_id=assistant_message["id"],
            user_message=user_message,
            request_context=request_context,
            model=model_id,
        )
        request_metadata["files"] = copy.deepcopy(request_files or [])

        form_data = {
            "stream": True,
            "model": model_id,
            "messages": api_messages,
            "params": copy.deepcopy(request_context.get("params") or {}),
            # Always a list: downstream folder-"Project" handling unpacks
            # form_data["files"] with *, and an explicit None defeats .get()
            # defaults (the key exists).
            "files": request_files or [],
            "filter_ids": copy.deepcopy(request_context.get("filter_ids") or []) or None,
            "tool_ids": copy.deepcopy(tool_ids) or None,
            "tool_servers": copy.deepcopy(request_context.get("tool_servers") or []),
            "features": copy.deepcopy(request_context.get("features") or {}),
            "variables": copy.deepcopy(request_context.get("variables") or {}),
            "chat_id": chat_id,
            "session_id": request_context.get("session_id")
            or f"pending-work:{chat_id}",
            "id": assistant_message["id"],
            "parent_id": user_message["id"],
            "parent_message": copy.deepcopy(user_message),
            "metadata": request_metadata,
            "background_tasks": copy.deepcopy(
                request_context.get("background_tasks") or {"follow_up_generation": True}
            ),
        }

        selected_model_items = request_context.get("selected_model_items") or {}
        if selected_model_items.get(model_id):
            form_data["model_item"] = copy.deepcopy(selected_model_items.get(model_id))

        reasoning_effort_by_model = request_context.get("reasoning_effort_by_model") or {}
        if reasoning_effort_by_model:
            reasoning_effort = reasoning_effort_by_model.get(str(model_idx))
            if reasoning_effort:
                form_data.setdefault("params", {})
                form_data["params"]["reasoning_effort"] = reasoning_effort

        try:
            result = await chat_completion(request, copy.deepcopy(form_data), user)
            if isinstance(result, dict) and result.get("status"):
                any_dispatch_started = True
            else:
                dispatch_ok = False
        except Exception as error:
            dispatch_ok = False
            log.exception(
                "[PendingChatWork] Failed to dispatch background chat item for %s", chat_id
            )
            Chats.upsert_message_to_chat_by_id_and_message_id(
                chat_id,
                assistant_message["id"],
                {
                    "done": True,
                    "stop_reason": "upstream_error",
                    "error": {"content": str(error)},
                },
            )

    log.info(
        "[PendingChatWork] Finished background dispatch chat_id=%s item_id=%s dispatch_ok=%s any_dispatch_started=%s",
        chat_id,
        item.get("id"),
        dispatch_ok,
        any_dispatch_started,
    )
    return dispatch_ok, any_dispatch_started


async def run_pending_chat_work_drain(
    *,
    request,
    user,
    chat_id: str,
    sio=None,
    ignore_task_ids: list[str] | None = None,
    triggered_at: float | None = None,
) -> bool:
    from open_webui.models.chats import Chats
    from open_webui.tasks import list_task_ids_by_item_id

    redis_client = getattr(request.app.state, "redis", None)
    if redis_client is None:
        return False
    async with acquire_pending_chat_work_lock(redis_client, chat_id, scope="drain"):
        ignored_task_ids = {
            str(task_id)
            for task_id in (ignore_task_ids or [])
            if task_id
        }
        active_task_ids = [
            str(task_id)
            for task_id in (await list_task_ids_by_item_id(redis_client, chat_id))
            if task_id and str(task_id) not in ignored_task_ids
        ]

        if active_task_ids:
            log.info(
                "[PendingChatWork] Drain blocked for chat %s because sibling tasks remain: %s",
                chat_id,
                active_task_ids,
            )
            return False

        chat_record = Chats.get_chat_by_id(chat_id)
        if chat_payload_has_active_current_turn(getattr(chat_record, "chat", None)):
            log.info(
                "[PendingChatWork] Drain blocked for chat %s because the persisted current turn is still active",
                chat_id,
            )
            schedule_pending_chat_work_active_turn_retry(
                request=request,
                user=user,
                chat_id=chat_id,
                sio=sio,
                triggered_at=triggered_at,
            )
            return False

        state = await load_pending_chat_work_state(redis_client, chat_id)
        item_to_dispatch = None
        item_kind = "queue"

        pending_steer = ensure_pending_steer_is_active(state)
        if pending_steer:
            item_kind = "steer"
            item_to_dispatch, state = await consume_pending_steer(redis_client, chat_id)
        else:
            item_to_dispatch, state = await pop_next_queued_prompt(redis_client, chat_id)

        if not item_to_dispatch:
            log.debug("[PendingChatWork] No pending work ready for dispatch in chat %s", chat_id)
            return False

        dispatch_ok, any_dispatch_started = await dispatch_pending_chat_item(
            request=request,
            user=user,
            chat_id=chat_id,
            item=item_to_dispatch,
            item_kind=item_kind,
            pending_state=state,
            sio=sio,
            triggered_at=triggered_at,
        )
        if not dispatch_ok and not any_dispatch_started:
            restored_state = await restore_pending_chat_item_after_dispatch_failure(
                redis_client,
                chat_id,
                item=item_to_dispatch,
                error="background_dispatch_failed_before_start",
            )
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
                        "[PendingChatWork] Failed to emit restored pending-work state for %s: %s",
                        chat_id,
                        error,
                    )
        return dispatch_ok


def schedule_pending_chat_work_active_turn_retry(
    *,
    request,
    user,
    chat_id: str,
    sio=None,
    triggered_at: float | None = None,
    delay_seconds: float = PENDING_CHAT_WORK_ACTIVE_TURN_RETRY_DELAY_SECONDS,
) -> None:
    existing_task = _pending_chat_work_active_turn_retry_tasks.get(chat_id)
    if existing_task is not None and not existing_task.done():
        return

    async def _runner():
        try:
            await asyncio.sleep(max(0.0, delay_seconds))
            await run_pending_chat_work_drain(
                request=request,
                user=user,
                chat_id=chat_id,
                sio=sio,
                ignore_task_ids=None,
                triggered_at=triggered_at,
            )
        except TimeoutError:
            log.debug(
                "[PendingChatWork] Active-turn retry drain already running for %s",
                chat_id,
            )
        except Exception:
            log.exception(
                "[PendingChatWork] Active-turn retry failed for chat %s",
                chat_id,
            )
        finally:
            current_task = _pending_chat_work_active_turn_retry_tasks.get(chat_id)
            if current_task is asyncio.current_task():
                _pending_chat_work_active_turn_retry_tasks.pop(chat_id, None)

    retry_task = asyncio.create_task(_runner())
    _pending_chat_work_active_turn_retry_tasks[chat_id] = retry_task


def schedule_pending_chat_work_drain(
    *,
    request,
    user,
    chat_id: str,
    sio=None,
    ignore_task_ids: list[str] | None = None,
    triggered_at: float | None = None,
) -> None:
    async def _runner():
        try:
            await run_pending_chat_work_drain(
                request=request,
                user=user,
                chat_id=chat_id,
                sio=sio,
                ignore_task_ids=ignore_task_ids,
                triggered_at=triggered_at,
            )
        except TimeoutError:
            log.debug("[PendingChatWork] Drain already running for %s", chat_id)
        except Exception:
            log.exception(
                "[PendingChatWork] Background drain failed for chat %s", chat_id
            )

    asyncio.create_task(_runner())
