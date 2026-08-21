"""
Transcript Verifier Tool

Verifies chat transcripts and system messages for integration testing.
"""

import re
from typing import Any, Dict, List, Optional

from ..utils.api_client import OWUIClient
from .assertions import assert_condition


# Global client instance
_client: OWUIClient = None


def get_client() -> OWUIClient:
    """Get or create the OWUI client."""
    global _client
    if _client is None:
        _client = OWUIClient()
    return _client


async def get_chat_transcript(
    chat_id: str
) -> Dict[str, Any]:
    """
    Fetch complete chat data including messages, history, and metadata.

    Args:
        chat_id: Chat ID to fetch

    Returns:
        Dict containing:
            - success: Boolean indicating success
            - chat: Full chat object
            - messages: List of messages
            - system_messages: Extracted system message content
            - user_messages: List of user messages
            - assistant_messages: List of assistant messages
            - error: Error message if failed
    """
    client = get_client()

    try:
        chat_data = client.get_chat(chat_id)
        chat = chat_data.get("chat", {})
        messages = chat.get("messages", [])

        # Categorize messages
        system_messages = []
        user_messages = []
        assistant_messages = []

        for msg in messages:
            role = msg.get("role", "")
            content = msg.get("content", "")

            if role == "system":
                system_messages.append({
                    "id": msg.get("id"),
                    "content": content
                })
            elif role == "user":
                user_messages.append({
                    "id": msg.get("id"),
                    "content": content[:500] if len(content) > 500 else content
                })
            elif role == "assistant":
                assistant_messages.append({
                    "id": msg.get("id"),
                    "content": content[:500] if len(content) > 500 else content,
                    "tool_calls": msg.get("tool_calls", [])
                })

        # Also extract system content from history if present
        history = chat.get("history", {})
        history_messages = history.get("messages", {})

        for msg_id, msg in history_messages.items():
            if msg.get("role") == "system":
                content = msg.get("content", "")
                if not any(sm["content"] == content for sm in system_messages):
                    system_messages.append({
                        "id": msg_id,
                        "content": content
                    })

        return {
            "success": True,
            "chat_id": chat_id,
            "chat": chat_data,
            "messages": messages,
            "system_messages": system_messages,
            "user_messages": user_messages,
            "assistant_messages": assistant_messages,
            "message_count": len(messages),
            "title": chat.get("title", ""),
            "models": chat.get("models", [])
        }

    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "chat_id": chat_id
        }


async def verify_system_messages(
    chat_id: str,
    expected_patterns: List[str],
    check_order: bool = False,
    auto_assert: bool = True
) -> Dict[str, Any]:
    """
    Verify that expected patterns are present in system messages.

    Args:
        chat_id: Chat ID to check
        expected_patterns: List of regex patterns to find in system messages
        check_order: Verify patterns appear in the specified order
        auto_assert: Automatically record assertion (default True)

    Returns:
        Dict containing:
            - success: Boolean indicating if all patterns were found
            - found: List of patterns that were found
            - missing: List of patterns not found
            - system_messages: The actual system message content
            - order_correct: Boolean if order was verified and correct
    """
    # Get transcript
    transcript = await get_chat_transcript(chat_id)

    if not transcript.get("success"):
        response = {
            "success": False,
            "error": transcript.get("error", "Failed to get transcript"),
            "found": [],
            "missing": expected_patterns
        }
        if auto_assert:
            await assert_condition(
                condition=False,
                message=f"Failed to get transcript: {transcript.get('error')}",
                severity="critical"
            )
        return response

    # Combine all system message content
    system_messages = transcript.get("system_messages", [])
    combined_content = "\n".join(sm.get("content", "") for sm in system_messages)

    # Also check assistant messages for injected content (filters sometimes inject there)
    for msg in transcript.get("messages", []):
        if msg.get("role") == "assistant":
            content = msg.get("content", "")
            # Look for system-like prefixes
            if any(prefix in content for prefix in ["Time context:", "Chat ID:", "User Context:", "Agent VM Ready"]):
                combined_content += "\n" + content

    found = []
    missing = []
    pattern_positions = {}

    for pattern in expected_patterns:
        try:
            regex = re.compile(pattern, re.IGNORECASE | re.DOTALL)
            match = regex.search(combined_content)
            if match:
                found.append(pattern)
                pattern_positions[pattern] = match.start()
            else:
                missing.append(pattern)
        except re.error as e:
            missing.append(f"{pattern} (invalid regex: {e})")

    # Check order if requested
    order_correct = True
    order_details = None

    if check_order and len(found) > 1:
        found_patterns = [p for p in expected_patterns if p in found]
        positions = [(p, pattern_positions.get(p, float('inf'))) for p in found_patterns]
        sorted_by_position = sorted(positions, key=lambda x: x[1])
        actual_order = [p for p, _ in sorted_by_position]

        if found_patterns != actual_order:
            order_correct = False
            order_details = {
                "expected": found_patterns,
                "actual": actual_order
            }

    success = len(missing) == 0 and (not check_order or order_correct)
    response = {
        "success": success,
        "found": found,
        "missing": missing,
        "system_messages": [sm.get("content", "")[:1000] for sm in system_messages],
        "system_message_count": len(system_messages),
        "order_correct": order_correct if check_order else None,
        "order_details": order_details,
        "chat_id": chat_id
    }

    if auto_assert:
        if success:
            await assert_condition(
                condition=True,
                message=f"All {len(found)} system message patterns found",
                severity="critical"
            )
        else:
            await assert_condition(
                condition=False,
                message=f"Missing system message patterns: {missing}",
                severity="critical"
            )

    return response


# Tool definitions for Claude Agent SDK
GET_CHAT_TRANSCRIPT_TOOL = {
    "name": "get_chat_transcript",
    "description": "Fetch complete chat data including messages, history, and metadata.",
    "input_schema": {
        "type": "object",
        "properties": {
            "chat_id": {
                "type": "string",
                "description": "The chat ID to fetch"
            }
        },
        "required": ["chat_id"]
    }
}

VERIFY_SYSTEM_MESSAGES_TOOL = {
    "name": "verify_system_messages",
    "description": "Verify that expected patterns are present in the chat's system messages. Use to check filter injections.",
    "input_schema": {
        "type": "object",
        "properties": {
            "chat_id": {
                "type": "string",
                "description": "The chat ID to check"
            },
            "expected_patterns": {
                "type": "array",
                "items": {"type": "string"},
                "description": "List of regex patterns to find in system messages"
            },
            "check_order": {
                "type": "boolean",
                "description": "Verify patterns appear in the specified order (default: false)",
                "default": False
            }
        },
        "required": ["chat_id", "expected_patterns"]
    }
}
