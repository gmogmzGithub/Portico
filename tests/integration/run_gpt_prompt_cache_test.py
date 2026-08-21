#!/usr/bin/env python3
"""
Integration test for GPT multi-hop prompt caching.

This verifies that a GPT-5.6 Sol chat which performs tool-followup hops
records prompt-cache reads on at least one later hop.
"""

import asyncio
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from typing import Any

# Add framework to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from framework.tools.assertions import (  # noqa: E402
    assert_condition,
    clear_assertions,
    get_all_assertions,
    get_assertion_summary,
)
from framework.tools.chat_simulator import simulate_chat  # noqa: E402


DEFAULT_MODEL = os.getenv("GPT_PROMPT_CACHE_MODEL", "GPT-5.6 Sol")
DEFAULT_BASE_URL = os.getenv("OPENWEBUI_BASE_URL", "http://localhost:3789")
REDIS_CONTAINER = os.getenv("GPT_PROMPT_CACHE_REDIS_CONTAINER", "portico-redis")
PROMPT = (
    "Call the `list_skills` tool first. Then call the `get_chat` tool for this chat "
    "using the chat_id from the system prompt. Do not answer until both tool calls "
    "have completed. After that, report the number of skills and the enabled tool servers."
)
DEBUG_VALUE_SEPARATOR = "__OWUI_LLM_DEBUG_EVENT_VALUE__"


def _parse_iso8601(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


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


def _load_request_payload_events(chat_id: str) -> list[dict[str, Any]]:
    raw_values = _run_command(
        [
            "docker",
            "exec",
            REDIS_CONTAINER,
            "sh",
            "-lc",
            (
                "for key in $(redis-cli --scan --pattern 'llm_debug:event_request_payload:*'); do "
                "redis-cli --raw GET \"$key\"; "
                f"printf '\\n{DEBUG_VALUE_SEPARATOR}\\n'; "
                "done"
            ),
        ]
    )
    events = _parse_debug_events(raw_values, chat_id)
    if events:
        return events

    raw_values = _run_command(
        [
            "docker",
            "exec",
            REDIS_CONTAINER,
            "sh",
            "-lc",
            (
                "for key in $(redis-cli --scan --pattern 'llm_debug:request:*'); do "
                "redis-cli --raw GET \"$key\"; "
                f"printf '\\n{DEBUG_VALUE_SEPARATOR}\\n'; "
                "done"
            ),
        ]
    )
    return _parse_debug_events(raw_values, chat_id)


def _load_response_events(chat_id: str) -> list[dict[str, Any]]:
    raw_values = _run_command(
        [
            "docker",
            "exec",
            REDIS_CONTAINER,
            "sh",
            "-lc",
            (
                "for key in $(redis-cli --scan --pattern 'llm_debug:event_response_complete:*'); do "
                "redis-cli --raw GET \"$key\"; "
                f"printf '\\n{DEBUG_VALUE_SEPARATOR}\\n'; "
                "done"
            ),
        ]
    )
    events = _parse_debug_events(raw_values, chat_id)
    if events:
        return events

    raw_values = _run_command(
        [
            "docker",
            "exec",
            REDIS_CONTAINER,
            "sh",
            "-lc",
            (
                "for key in $(redis-cli --scan --pattern 'llm_debug:response:*'); do "
                "redis-cli --raw GET \"$key\"; "
                f"printf '\\n{DEBUG_VALUE_SEPARATOR}\\n'; "
                "done"
            ),
        ]
    )
    return _parse_debug_events(raw_values, chat_id)


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


def _load_usage_entries(
    chat_id: str,
    request_events: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    request_session_ids = {
        event.get("session_id")
        for event in (request_events or [])
        if isinstance(event.get("session_id"), str) and event.get("session_id")
    }

    entries = []
    for event in _load_response_events(chat_id):
        if request_session_ids and event.get("session_id") not in request_session_ids:
            continue
        usage = event.get("data", {}).get("usage")
        if not isinstance(usage, dict) or not usage:
            continue
        entries.append(
            {
                "event_id": event.get("event_id"),
                "timestamp": event.get("timestamp"),
                "model": event.get("data", {}).get("model"),
                "usage": usage,
            }
        )
    return entries


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


def _print_request_diagnostics(events: list[dict[str, Any]]) -> None:
    print("  Request hops:")
    for index, event in enumerate(events, start=1):
        tool_names = _extract_tool_names(event)
        print(
            f"    {index}. {event.get('timestamp')} tools={len(tool_names)} "
            f"names={tool_names[:8]}"
        )


def _tool_names_are_stable(events: list[dict[str, Any]]) -> bool:
    if len(events) < 2:
        return True

    first_tool_names = _extract_tool_names(events[0])
    return all(_extract_tool_names(event) == first_tool_names for event in events[1:])


def _print_usage_diagnostics(entries: list[dict[str, Any]]) -> None:
    print("  Usage entries:")
    for index, entry in enumerate(entries, start=1):
        usage = entry.get("usage", {})
        print(
            f"    {index}. {entry.get('timestamp')} cache_read={_cache_read_tokens(usage)} "
            f"prompt_tokens={usage.get('prompt_tokens', 0)} "
            f"completion_tokens={usage.get('completion_tokens', 0)} "
            f"total_tokens={usage.get('total_tokens', 0)}"
        )


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


async def run_gpt_prompt_cache_test() -> int:
    print("=" * 70)
    print("TEST: GPT Multi-Hop Prompt Cache")
    print("=" * 70)

    clear_assertions()
    os.environ.setdefault("OPENWEBUI_BASE_URL", DEFAULT_BASE_URL)
    _ensure_api_token()

    print(f"\n[Step 1] Sending GPT prompt-cache repro chat to {os.environ['OPENWEBUI_BASE_URL']}...")
    print(f"  Model: {DEFAULT_MODEL}")
    print(f"  Prompt: {PROMPT}")

    chat_result = await simulate_chat(
        prompt=PROMPT,
        model=DEFAULT_MODEL,
        wait_for_completion=False,
        timeout_seconds=60,
        auto_assert=False,
    )

    chat_id = chat_result.get("chat_id")
    print(f"  Chat ID: {chat_id}")
    print(f"  Success: {chat_result.get('success')}")
    if chat_result.get("error"):
        print(f"  Error: {chat_result.get('error')}")

    await assert_condition(
        chat_id is not None,
        "Chat was created with a valid ID",
        "critical",
    )
    if not chat_id:
        print("\nFATAL: chat_id missing, cannot continue")
        return 1

    print("\n[Step 2] Loading per-hop LLM request payloads from Redis debug storage...")
    request_events = await _poll_for_events(_load_request_payload_events, chat_id, 3)
    _print_request_diagnostics(request_events)

    await assert_condition(
        len(request_events) >= 3,
        f"Chat produced follow-up LLM hops (found {len(request_events)})",
        "critical",
    )
    await assert_condition(
        _tool_names_are_stable(request_events),
        "GPT tool payload stayed stable across request hops",
        "critical",
        context={
            "chat_id": chat_id,
            "request_tool_names": [
                _extract_tool_names(event) for event in request_events
            ],
        },
    )

    print("\n[Step 3] Loading GPT usage snapshots from Redis response events...")
    usage_entries = await _poll_for_events(
        lambda current_chat_id: _load_usage_entries(current_chat_id, request_events),
        chat_id,
        3,
    )
    _print_usage_diagnostics(usage_entries)

    await assert_condition(
        len(usage_entries) >= 3,
        f"Found usage snapshots for initial request and follow-up hops (found {len(usage_entries)})",
        "critical",
    )

    later_entries = usage_entries[1:]
    cache_hit_entry = next(
        (
            entry
            for entry in later_entries
            if _cache_read_tokens(entry.get("usage", {})) > 0
        ),
        None,
    )

    await assert_condition(
        cache_hit_entry is not None,
        "At least one later GPT hop recorded prompt-cache reads",
        "critical",
        context={
            "chat_id": chat_id,
            "request_hops": len(request_events),
            "usage_entries": [
                {
                    "cache_read_tokens": _cache_read_tokens(entry.get("usage", {})),
                    "prompt_tokens": entry.get("usage", {}).get("prompt_tokens"),
                    "completion_tokens": entry.get("usage", {}).get(
                        "completion_tokens"
                    ),
                    "total_tokens": entry.get("usage", {}).get("total_tokens"),
                }
                for entry in usage_entries
            ],
            "request_tool_names": [
                _extract_tool_names(event) for event in request_events
            ],
        },
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
        print("\nPASS: GPT prompt-cache regression passed")
        return 0

    print("\nFAIL: GPT prompt-cache regression failed")
    return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(run_gpt_prompt_cache_test()))
