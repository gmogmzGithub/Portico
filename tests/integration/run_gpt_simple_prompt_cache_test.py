#!/usr/bin/env python3
"""
Integration test for simple two-turn GPT prompt caching.

This reproduces the most basic expected cache-hit case:
1. User starts a GPT-5.6 Sol chat.
2. User sends a short follow-up in the same chat.
3. The second turn must report prompt-cache reads.
"""

import asyncio
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from framework.tools.assertions import (  # noqa: E402
    assert_condition,
    clear_assertions,
    get_all_assertions,
    get_assertion_summary,
)
from framework.utils.api_client import OWUIClient  # noqa: E402


DEFAULT_MODEL = os.getenv("GPT_SIMPLE_PROMPT_CACHE_MODEL", "GPT-5.6 Sol")
DEFAULT_BASE_URL = os.getenv("OPENWEBUI_BASE_URL", "http://localhost:3789")
REDIS_CONTAINER = os.getenv(
    "GPT_PROMPT_CACHE_REDIS_CONTAINER", "portico-redis"
)
FIRST_PROMPT = "It's my first time using Portico. What can you do?"
SECOND_PROMPT = "Thank you!"
DEBUG_VALUE_SEPARATOR = "__OWUI_LLM_DEBUG_EVENT_VALUE__"


def _parse_iso8601(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(
        timezone.utc
    )


def _run_command(args: list[str]) -> str:
    result = subprocess.run(
        args,
        capture_output=True,
        text=True,
        timeout=60,
        check=True,
    )
    return result.stdout.strip()


def _ensure_api_token() -> None:
    token = _run_command(
        [
            "docker",
            "exec",
            REDIS_CONTAINER,
            "redis-cli",
            "GET",
            "openwebui:api_token",
        ]
    ).strip()
    if not token:
        raise RuntimeError("Could not resolve OWUI_API_TOKEN from Redis")
    os.environ["OWUI_API_TOKEN"] = token


def _parse_debug_events(raw_values: str, chat_id: str) -> list[dict[str, Any]]:
    events = []
    for raw_event in raw_values.split(f"\n{DEBUG_VALUE_SEPARATOR}\n"):
        raw_event = raw_event.strip()
        if not raw_event:
            continue
        try:
            event = json.loads(raw_event)
        except json.JSONDecodeError:
            continue
        if event.get("chat_id") != chat_id:
            continue
        events.append(event)

    events.sort(key=lambda event: _parse_iso8601(event.get("timestamp", "")))
    return events


def _load_debug_events(chat_id: str, prefix: str) -> list[dict[str, Any]]:
    raw_values = _run_command(
        [
            "docker",
            "exec",
            REDIS_CONTAINER,
            "sh",
            "-lc",
            (
                f"for key in $(redis-cli --scan --pattern '{prefix}:*'); do "
                'redis-cli --raw GET "$key"; '
                f"printf '\\n{DEBUG_VALUE_SEPARATOR}\\n'; "
                "done"
            ),
        ]
    )
    return _parse_debug_events(raw_values, chat_id)


def _load_request_payload_events(chat_id: str) -> list[dict[str, Any]]:
    events = _load_debug_events(chat_id, "llm_debug:event_request_payload")
    if events:
        return events
    return _load_debug_events(chat_id, "llm_debug:request")


def _load_response_events(chat_id: str) -> list[dict[str, Any]]:
    events = _load_debug_events(chat_id, "llm_debug:event_response_complete")
    if events:
        return events
    return _load_debug_events(chat_id, "llm_debug:response")


def _cache_read_tokens(usage: dict[str, Any]) -> int:
    if not isinstance(usage, dict):
        return 0

    for key in ("cache_read_input_tokens", "cached_tokens"):
        value = usage.get(key)
        try:
            if value is not None:
                return int(value)
        except (TypeError, ValueError):
            pass

    prompt_details = usage.get("prompt_tokens_details")
    if isinstance(prompt_details, dict):
        for key in ("cached_read_tokens", "cached_tokens"):
            value = prompt_details.get(key)
            try:
                if value is not None:
                    return int(value)
            except (TypeError, ValueError):
                pass
    return 0


def _cache_write_tokens(usage: dict[str, Any]) -> int:
    if not isinstance(usage, dict):
        return 0

    for key in ("cache_write_input_tokens", "cache_creation_input_tokens"):
        value = usage.get(key)
        try:
            if value is not None:
                return int(value)
        except (TypeError, ValueError):
            pass

    prompt_details = usage.get("prompt_tokens_details")
    if isinstance(prompt_details, dict):
        for key in ("cached_write_tokens", "cache_creation_tokens", "cache_write_tokens"):
            value = prompt_details.get(key)
            try:
                if value is not None:
                    return int(value)
            except (TypeError, ValueError):
                pass
    return 0


def _extract_tool_names(event: dict[str, Any]) -> list[str]:
    tools = event.get("data", {}).get("tools", [])
    tool_names = []
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        function_payload = tool.get("function", {})
        if not isinstance(function_payload, dict):
            continue
        name = function_payload.get("name")
        if isinstance(name, str) and name:
            tool_names.append(name)
    return tool_names


def _events_for_session(
    events: list[dict[str, Any]], session_id: str | None
) -> list[dict[str, Any]]:
    return [
        event
        for event in events
        if session_id and event.get("session_id") == session_id
    ]


def _ordered_turn_events(
    events: list[dict[str, Any]],
    first_session_id: str | None,
    second_session_id: str | None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    first_session_events = _events_for_session(events, first_session_id)
    second_session_events = _events_for_session(events, second_session_id)

    if first_session_events and second_session_events:
        return first_session_events, second_session_events

    ordered_events = sorted(
        events, key=lambda event: _parse_iso8601(event.get("timestamp", ""))
    )
    if len(ordered_events) >= 2:
        return [ordered_events[0]], [ordered_events[-1]]

    if len(ordered_events) == 1:
        if first_session_events:
            return first_session_events, [ordered_events[0]]
        return [ordered_events[0]], []

    return first_session_events, second_session_events


async def _poll_for_events(
    loader,
    chat_id: str,
    minimum_count: int,
    timeout_seconds: int = 30,
    poll_interval_seconds: float = 2.0,
    quiet_period_seconds: float = 4.0,
) -> list[dict[str, Any]]:
    deadline = time.monotonic() + timeout_seconds
    best_events: list[dict[str, Any]] = []
    last_growth_at: float | None = None

    while time.monotonic() < deadline:
        events = loader(chat_id)
        if len(events) > len(best_events):
            best_events = events
            last_growth_at = time.monotonic()
        if len(best_events) >= minimum_count:
            if last_growth_at is None:
                last_growth_at = time.monotonic()
            if (time.monotonic() - last_growth_at) >= quiet_period_seconds:
                return best_events
        await asyncio.sleep(poll_interval_seconds)

    return best_events


async def run_gpt_simple_prompt_cache_test() -> int:
    print("=" * 70)
    print("TEST: GPT Simple Two-Turn Prompt Cache")
    print("=" * 70)

    clear_assertions()
    os.environ.setdefault("OPENWEBUI_BASE_URL", DEFAULT_BASE_URL)
    _ensure_api_token()

    client = OWUIClient(base_url=os.environ["OPENWEBUI_BASE_URL"])

    print(f"\n[Step 1] Starting chat against {os.environ['OPENWEBUI_BASE_URL']}...")
    print(f"  Model: {DEFAULT_MODEL}")
    print(f"  First prompt: {FIRST_PROMPT}")
    print(f"  Second prompt: {SECOND_PROMPT}")

    folder_id = client.ensure_folder("Integration Tests")
    created = client.create_chat(DEFAULT_MODEL, FIRST_PROMPT, folder_id=folder_id)
    chat_id = created["chat_id"]
    first_user_message_id = created["user_message_id"]
    first_completion = client.generate_completion(
        chat_id=chat_id,
        model=DEFAULT_MODEL,
        prompt=FIRST_PROMPT,
        user_message_id=first_user_message_id,
    )
    first_completion_result = client.poll_for_completion(
        chat_id=chat_id,
        user_message_id=first_user_message_id,
        timeout_seconds=120,
    )

    print(f"  Chat ID: {chat_id}")
    print(f"  First session: {first_completion.get('session_id')}")
    print(
        f"  First assistant message: {first_completion_result.get('assistant_message_id')}"
    )

    await assert_condition(chat_id is not None, "Created chat for GPT simple cache test", "critical")

    second_user = client.append_user_message(
        chat_id=chat_id,
        model=DEFAULT_MODEL,
        prompt=SECOND_PROMPT,
        parent_id=first_completion_result.get("assistant_message_id"),
    )
    second_completion = client.generate_completion(
        chat_id=chat_id,
        model=DEFAULT_MODEL,
        prompt=SECOND_PROMPT,
        user_message_id=second_user["user_message_id"],
    )
    second_completion_result = client.poll_for_completion(
        chat_id=chat_id,
        user_message_id=second_user["user_message_id"],
        timeout_seconds=120,
    )

    print(f"  Second session: {second_completion.get('session_id')}")
    print(
        f"  Second assistant message: {second_completion_result.get('assistant_message_id')}"
    )

    await assert_condition(
        bool(second_completion_result.get("assistant_message_id")),
        "Second GPT turn completed successfully",
        "critical",
    )

    print("\n[Step 2] Loading Redis-backed request/response debug events...")
    request_events = await _poll_for_events(_load_request_payload_events, chat_id, 2)
    response_events = await _poll_for_events(_load_response_events, chat_id, 2)

    first_request_events, second_request_events = _ordered_turn_events(
        request_events,
        first_completion.get("session_id"),
        second_completion.get("session_id"),
    )
    first_response_events, second_response_events = _ordered_turn_events(
        response_events,
        first_completion.get("session_id"),
        second_completion.get("session_id"),
    )

    print("  Request sessions:")
    print(
        f"    first={len(first_request_events)} event(s) tools={_extract_tool_names(first_request_events[-1]) if first_request_events else []}"
    )
    print(
        f"    second={len(second_request_events)} event(s) tools={_extract_tool_names(second_request_events[-1]) if second_request_events else []}"
    )

    await assert_condition(
        len(first_request_events) >= 1 and len(second_request_events) >= 1,
        "Captured request payload events for both GPT turns",
        "critical",
    )

    if first_request_events and second_request_events:
        await assert_condition(
            _extract_tool_names(first_request_events[-1])
            == _extract_tool_names(second_request_events[-1]),
            "GPT tool payload stayed stable across the two-turn cache repro",
            "critical",
            context={
                "chat_id": chat_id,
                "first_tools": _extract_tool_names(first_request_events[-1]),
                "second_tools": _extract_tool_names(second_request_events[-1]),
            },
        )

    first_usage = first_response_events[-1]["data"]["usage"] if first_response_events else {}
    second_usage = (
        second_response_events[-1]["data"]["usage"] if second_response_events else {}
    )

    print("  Usage snapshots:")
    print(
        f"    first: cache_read={_cache_read_tokens(first_usage)} cache_write={_cache_write_tokens(first_usage)} prompt_tokens={first_usage.get('prompt_tokens', 0)}"
    )
    print(
        f"    second: cache_read={_cache_read_tokens(second_usage)} cache_write={_cache_write_tokens(second_usage)} prompt_tokens={second_usage.get('prompt_tokens', 0)}"
    )

    await assert_condition(
        len(first_response_events) >= 1 and len(second_response_events) >= 1,
        "Captured usage events for both GPT turns",
        "critical",
    )
    await assert_condition(
        _cache_read_tokens(first_usage) == 0,
        "Initial GPT turn starts with zero cache reads",
        "info",
        context={"chat_id": chat_id, "usage": first_usage},
    )
    await assert_condition(
        _cache_read_tokens(second_usage) > 0,
        "Second GPT turn recorded prompt-cache reads",
        "critical",
        context={"chat_id": chat_id, "usage": second_usage},
    )

    print("\n" + "=" * 70)
    print("TEST SUMMARY")
    print("=" * 70)
    summary = get_assertion_summary()
    print(f"Total assertions: {summary['total']}")
    print(f"Passed: {summary['passed']}")
    print(f"Failed: {summary['failed']}")
    print(f"Critical failures: {summary['critical_failures']}")
    print("\nAssertion Details:")
    for assertion in get_all_assertions():
        status = "PASS" if assertion.passed else "FAIL"
        print(f"  [{status}] [{assertion.severity}] {assertion.message}")
        if assertion.context and not assertion.passed:
            print(f"    Context: {json.dumps(assertion.context, default=str)}")

    if summary["all_passed"]:
        print("\nPASS: GPT simple prompt-cache regression passed")
        return 0

    print("\nFAIL: GPT simple prompt-cache regression failed")
    return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(run_gpt_simple_prompt_cache_test()))
