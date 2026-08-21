"""Shared normalization for automatically generated and persisted chat titles."""

from __future__ import annotations

import json
import re
from typing import Any

import emoji


_WHITESPACE_RE = re.compile(r"\s+")
_EMOJI_JOINER_RE = re.compile(r"[\u200d\ufe0e\ufe0f\u20e3]")
_EMOJI_MODIFIER_RE = re.compile(r"[\U0001f3fb-\U0001f3ff]")
_EMOJI_TAG_RE = re.compile(r"[\U000e0020-\U000e007f]")

NO_EMOJI_TITLE_INSTRUCTION = (
    "Return plain words only. Do not use emoji, pictographs, decorative symbols, "
    "or icons in the title."
)


def strip_emoji_characters(value: Any) -> str:
    """Remove complete emoji sequences and any orphaned emoji joiners/modifiers."""
    text = "" if value is None else str(value)
    text = emoji.replace_emoji(text, replace="")
    text = _EMOJI_JOINER_RE.sub("", text)
    text = _EMOJI_MODIFIER_RE.sub("", text)
    return _EMOJI_TAG_RE.sub("", text)


def normalize_chat_title(value: Any, fallback: Any = "New Chat") -> str:
    """Strip emoji and collapse whitespace, using a cleaned fallback when empty."""
    cleaned = _WHITESPACE_RE.sub(" ", strip_emoji_characters(value)).strip()
    if cleaned:
        return cleaned
    if fallback is None:
        return ""
    cleaned_fallback = _WHITESPACE_RE.sub(
        " ", strip_emoji_characters(fallback)
    ).strip()
    return cleaned_fallback or "New Chat"


def append_no_emoji_title_instruction(content: str) -> str:
    """Apply the hard no-emoji rule to default and administrator templates alike."""
    return f"{content.rstrip()}\n\n{NO_EMOJI_TITLE_INSTRUCTION}"


def sanitize_title_completion_text(content: Any) -> Any:
    """Normalize the title field in a task completion while preserving its envelope."""
    if not isinstance(content, str):
        return content

    stripped = strip_emoji_characters(content)
    start = stripped.find("{")
    end = stripped.rfind("}")
    if start < 0 or end < start:
        return stripped

    try:
        payload = json.loads(stripped[start : end + 1])
    except (TypeError, ValueError, json.JSONDecodeError):
        return stripped

    if not isinstance(payload, dict) or "title" not in payload:
        return stripped

    payload["title"] = normalize_chat_title(payload.get("title"), fallback=None)
    normalized_json = json.dumps(payload, ensure_ascii=False)
    return f"{stripped[:start]}{normalized_json}{stripped[end + 1:]}"


def sanitize_title_completion_response(response: Any) -> Any:
    """Sanitize OpenAI-compatible title completion choices in place."""
    if not isinstance(response, dict):
        return response
    for choice in response.get("choices", []):
        if not isinstance(choice, dict):
            continue
        message = choice.get("message")
        if not isinstance(message, dict):
            continue
        for field in ("content", "reasoning_content"):
            if field in message:
                message[field] = sanitize_title_completion_text(message[field])
    return response
