"""One-way event delivery for service-owned delegated chats.

Subagents authenticate as a service user, while detached viewers connect as
the human owner of the root chat. This wrapper preserves Open WebUI's normal
emitter and, only when Redis confirms the chat is delegated, mirrors the event
envelope to the owner's user room. Interactive ``event_call`` traffic remains
bound to the initiating session.
"""

from __future__ import annotations

import inspect
import json
import logging
from typing import Any, Callable


log = logging.getLogger(__name__)

_UNSET = object()


async def _await_if_needed(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


def _runtime_redis_client() -> Any:
    # Import lazily to avoid a cycle while open_webui.main is initializing.
    try:
        from open_webui.main import app

        return getattr(app.state, "redis", None)
    except Exception:
        return None


def _decode_reverse_metadata(raw: Any) -> dict[str, Any]:
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", errors="replace")
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str) or not raw.strip():
        return {}
    try:
        parsed = json.loads(raw)
    except Exception:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _chat_owner_id(chat: Any) -> str | None:
    value = chat.get("user_id") if isinstance(chat, dict) else getattr(chat, "user_id", None)
    normalized = str(value or "").strip()
    return normalized or None


async def resolve_delegated_chat_owner_id(
    request_info: dict[str, Any],
    *,
    redis_client: Any = _UNSET,
    chats_model: Any = _UNSET,
) -> str | None:
    """Return the human root-chat owner for a Redis-confirmed child chat."""
    chat_id = str(request_info.get("chat_id") or "").strip()
    if not chat_id or chat_id.startswith("local:"):
        return None

    if redis_client is _UNSET:
        redis_client = _runtime_redis_client()
    if redis_client is None:
        return None

    raw = await _await_if_needed(redis_client.get(f"subagent_chat:{chat_id}"))
    if not raw:
        return None
    metadata = _decode_reverse_metadata(raw)
    if not metadata:
        return None

    if chats_model is _UNSET:
        from open_webui.models.chats import Chats

        chats_model = Chats

    parent_ids: list[str] = []
    for key in ("root_parent_chat_id", "parent_chat_id"):
        parent_id = str(metadata.get(key) or "").strip()
        if parent_id and parent_id not in parent_ids:
            parent_ids.append(parent_id)

    for parent_id in parent_ids:
        owner_id = _chat_owner_id(chats_model.get_chat_by_id(parent_id))
        if owner_id:
            return owner_id
    return None


def get_event_emitter(
    request_info: dict[str, Any],
    update_db: bool = True,
    *,
    base_factory: Callable[..., Any] | None = None,
    redis_client: Any = _UNSET,
    chats_model: Any = _UNSET,
    sio_server: Any = _UNSET,
):
    """Wrap Open WebUI's emitter with best-effort delegated event mirroring."""
    if base_factory is None:
        from open_webui.socket.main import get_event_emitter as base_factory

    base_emitter = base_factory(request_info, update_db=update_db)
    if base_emitter is None:
        return None

    owner_resolution_complete = False
    delegated_owner_id: str | None = None

    async def __event_emitter__(event_data: dict[str, Any]):
        nonlocal owner_resolution_complete, delegated_owner_id, sio_server

        # Preserve normal/session delivery and persistence first.
        await base_emitter(event_data)

        if not owner_resolution_complete:
            try:
                delegated_owner_id = await resolve_delegated_chat_owner_id(
                    request_info,
                    redis_client=redis_client,
                    chats_model=chats_model,
                )
            except Exception as error:
                # Redis/ownership failures fall back to normal delivery and are
                # retried on a later event in case the failure was transient.
                log.debug(
                    "[DelegatedEvents] Owner lookup failed chat_id=%s: %s",
                    request_info.get("chat_id"),
                    error,
                )
                return
            owner_resolution_complete = True

        if not delegated_owner_id:
            return

        try:
            if sio_server is _UNSET:
                from open_webui.socket.main import sio

                sio_server = sio
            await sio_server.emit(
                "events",
                {
                    "chat_id": request_info.get("chat_id"),
                    "message_id": request_info.get("message_id"),
                    "data": event_data,
                },
                room=f"user:{delegated_owner_id}",
            )
        except Exception as error:
            log.debug(
                "[DelegatedEvents] Owner-room emit failed chat_id=%s owner_id=%s: %s",
                request_info.get("chat_id"),
                delegated_owner_id,
                error,
            )

    return __event_emitter__
