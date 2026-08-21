"""
Chat Simulator Tool

Simulates chat interactions with Open WebUI for integration testing.
"""

import os
import time
from typing import Any, Dict

import httpx

from ..utils.api_client import OWUIClient
from .assertions import assert_condition


# Global client instance for reuse
_client: OWUIClient = None


def get_client() -> OWUIClient:
    """Get or create the OWUI client."""
    global _client
    if _client is None:
        _client = OWUIClient()
    return _client


def reset_client() -> None:
    """Drop any cached client so the next attempt recreates auth and transports."""
    global _client
    if _client is not None:
        try:
            _client.close()
        except Exception:
            pass
    _client = None


def _is_retryable_startup_error(exc: Exception) -> bool:
    """Retry transient startup/network failures when local OWUI is coming back."""
    if isinstance(
        exc,
        (
            httpx.ConnectError,
            httpx.ConnectTimeout,
            httpx.ReadTimeout,
            httpx.RemoteProtocolError,
        ),
    ):
        return True

    message = str(exc).lower()
    return any(
        needle in message
        for needle in (
            "connection refused",
            "connect call failed",
            "server disconnected without sending a response",
            "all connection attempts failed",
        )
    )


def _wait_for_owui_ready(
    base_url: str | None = None,
    timeout_seconds: float = 60.0,
    poll_interval: float = 2.0,
) -> None:
    """Wait for the local Open WebUI endpoint to come back before retrying."""
    target_base_url = (base_url or os.getenv("OPENWEBUI_BASE_URL", "http://localhost:8080")).rstrip("/")
    deadline = time.time() + timeout_seconds
    last_error = "unknown"

    while time.time() < deadline:
        for url in (f"{target_base_url}/health", target_base_url):
            try:
                response = httpx.get(url, timeout=5.0)
                if response.status_code < 500:
                    return
                last_error = f"HTTP {response.status_code} from {url}"
            except httpx.HTTPError as exc:
                last_error = str(exc)
        time.sleep(poll_interval)

    raise RuntimeError(
        f"Timed out waiting for Open WebUI at {target_base_url} to become ready "
        f"(last error: {last_error})"
    )


async def simulate_chat(
    prompt: str,
    model: str = "Atlas Opus 5",
    wait_for_completion: bool = True,
    timeout_seconds: int = 300,
    folder_name: str = "Integration Tests",
    auto_assert: bool = True
) -> Dict[str, Any]:
    """
    Simulate a chat interaction with Open WebUI.

    Creates a new chat, sends the prompt, and optionally waits for completion.

    Args:
        prompt: User message to send
        model: Model ID to use (default: Atlas Opus 5)
        wait_for_completion: Wait for response (default: True)
        timeout_seconds: Max wait time for completion (default: 300)
        folder_name: Folder to create chat in (default: Integration Tests)

    Returns:
        Dict containing:
            - chat_id: The chat's UUID
            - user_message_id: UUID of the user message
            - assistant_message_id: UUID of assistant response (if waited)
            - response_content: Assistant's response text (if waited)
            - tool_calls: Any tool calls made (if waited)
            - success: Boolean indicating success
            - error: Error message if failed
    """
    max_start_attempts = 3
    last_error: Exception | None = None

    for attempt in range(1, max_start_attempts + 1):
        client = get_client()

        try:
            # Ensure folder exists
            folder_id = client.ensure_folder(folder_name)

            # Create the chat
            chat_result = client.create_chat(
                model=model,
                prompt=prompt,
                folder_id=folder_id
            )

            chat_id = chat_result["chat_id"]
            user_message_id = chat_result["user_message_id"]

            # Trigger completion
            completion_result = client.generate_completion(
                chat_id=chat_id,
                model=model,
                prompt=prompt,
                user_message_id=user_message_id
            )

            result = {
                "success": True,
                "chat_id": chat_id,
                "user_message_id": user_message_id,
                "task_id": completion_result.get("task_id"),
                "timestamp": chat_result["timestamp"]
            }

            # Wait for completion if requested
            if wait_for_completion:
                poll_result = client.poll_for_completion(
                    chat_id=chat_id,
                    user_message_id=user_message_id,
                    timeout_seconds=timeout_seconds
                )

                if poll_result.get("complete"):
                    result.update({
                        "assistant_message_id": poll_result.get("assistant_message_id"),
                        "response_content": poll_result.get("content"),
                        "tool_calls": poll_result.get("tool_calls", []),
                        "completed": True
                    })
                else:
                    result.update({
                        "completed": False,
                        "error": poll_result.get("error", "Unknown error")
                    })

            if auto_assert:
                await assert_condition(
                    condition=True,
                    message=f"Chat simulation completed successfully with ID: {chat_id}",
                    severity="critical"
                )

            return result

        except Exception as e:
            last_error = e
            if attempt < max_start_attempts and _is_retryable_startup_error(e):
                reset_client()
                _wait_for_owui_ready(
                    base_url=getattr(client, "base_url", None),
                    timeout_seconds=min(60.0, float(timeout_seconds)),
                )
                continue

            if auto_assert:
                await assert_condition(
                    condition=False,
                    message=f"Chat simulation failed: {str(e)}",
                    severity="critical"
                )
            return {
                "success": False,
                "error": str(e),
                "error_type": type(e).__name__
            }

    if auto_assert:
        await assert_condition(
            condition=False,
            message=f"Chat simulation failed: {str(last_error)}",
            severity="critical"
        )
    return {
        "success": False,
        "error": str(last_error or "Unknown error"),
        "error_type": type(last_error).__name__ if last_error else "RuntimeError"
    }


# Tool definition for Atlas Agent SDK
SIMULATE_CHAT_TOOL = {
    "name": "simulate_chat",
    "description": "Simulate a chat interaction with Open WebUI. Creates a new chat, sends a message, and waits for the AI response.",
    "input_schema": {
        "type": "object",
        "properties": {
            "prompt": {
                "type": "string",
                "description": "The user message to send"
            },
            "model": {
                "type": "string",
                "description": "Model ID to use (default: Atlas Opus 5)",
                "default": "Atlas Opus 5"
            },
            "wait_for_completion": {
                "type": "boolean",
                "description": "Whether to wait for the AI response (default: true)",
                "default": True
            },
            "timeout_seconds": {
                "type": "integer",
                "description": "Maximum seconds to wait for response (default: 300)",
                "default": 300
            }
        },
        "required": ["prompt"]
    }
}
