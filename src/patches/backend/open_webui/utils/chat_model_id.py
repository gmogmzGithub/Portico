"""Resolve the model shown for a chat without querying persisted history."""

from typing import Optional


def _normalize_model_id(value) -> Optional[str]:
    normalized = str(value if value is not None else "").strip()
    if not normalized or normalized in {"null", "undefined"}:
        return None
    return normalized


def resolve_chat_model_id(chat: dict) -> Optional[str]:
    """Return the latest assistant model on the active chat branch."""
    if not isinstance(chat, dict):
        return None

    history = chat.get("history")
    history = history if isinstance(history, dict) else {}
    messages = history.get("messages")
    messages = messages if isinstance(messages, dict) else {}
    message_id = history.get("currentId")
    visited = set()

    while message_id and message_id not in visited:
        visited.add(message_id)
        message = messages.get(message_id)
        if not isinstance(message, dict):
            break
        if message.get("role") == "assistant":
            model_id = _normalize_model_id(message.get("model"))
            if model_id:
                return model_id
        message_id = message.get("parentId")

    models = chat.get("models")
    primary_model = models[0] if isinstance(models, list) and models else None
    return _normalize_model_id(primary_model) or _normalize_model_id(chat.get("model"))
