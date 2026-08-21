from __future__ import annotations

from typing import Any, Optional


def _message_text_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        text_parts: list[str] = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                text_parts.append(item.get("text", ""))
        return "".join(text_parts)
    return ""


def merge_model_and_request_system_prompt(
    model_system_prompt: Optional[str], messages: list[dict] | None
) -> Optional[str]:
    if not model_system_prompt:
        return model_system_prompt

    existing_request_system = ""
    for message in messages or []:
        if message.get("role") == "system":
            existing_request_system = _message_text_content(
                message.get("content", "")
            ).strip()
            break

    if not existing_request_system:
        return model_system_prompt

    normalized_model_prompt = model_system_prompt.strip()
    if not normalized_model_prompt:
        return existing_request_system

    if existing_request_system == normalized_model_prompt:
        return model_system_prompt

    if existing_request_system in normalized_model_prompt:
        return model_system_prompt

    if normalized_model_prompt in existing_request_system:
        return existing_request_system

    return (
        f"{model_system_prompt}\n\n---\n\n"
        "## Request-Specific System Instructions\n\n"
        f"{existing_request_system}"
    )
