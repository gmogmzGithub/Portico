#!/usr/bin/env python3
"""
Run a real headless Open WebUI chat and verify Chrome DevTools cross-turn routing.

Validation:
- Chrome DevTools is already healthy and tool_ready before the browser action turn
- server:chrome-devtools is attached to the chat before the browser action turn
- the first browser-action tool call is chrome_devtools_navigate_page
- no repeated activate/get_chat_tools/restart recovery calls happen before navigation
"""

from __future__ import annotations

import argparse
import json
import os
import time
from typing import Any

import httpx

from run_google_workspace_chat_consistency import (
    MODEL,
    OWUIClient,
    _count_tool_call_batches,
    _detect_openwebui_base_url,
    _get_chat_active_capabilities,
    _parse_tool_calls,
    _redis_json_get,
    _request_tool_names,
    _wait_for_main_request_details,
    ensure_debug_monitor_healthy,
)


SERVER_ID = "chrome-devtools"
TOOL_SERVER_ID = "server:chrome-devtools"
PROMPT = "Use browser automation to open https://example.com and take a screenshot."
INITIAL_PROMPT = "I will ask you to use browser automation next."
TARGET_STREAK = 3
DEFAULT_TIMEOUT_SECONDS = int(os.getenv("OWUI_BROWSER_AUTOMATION_TIMEOUT_SECONDS", "300"))
ELECTRON_API_BASE = os.getenv("ELECTRON_API_BASE", "http://127.0.0.1:9876").rstrip("/")
READINESS_URL = f"{ELECTRON_API_BASE}/api/server-readiness/{SERVER_ID}"
CORE_MCP_BASE_URL = os.getenv("MCPO_CORE_PROXY_BASE_URL", "http://127.0.0.1:8766").rstrip("/")
PRECONDITION_TIMEOUT_SECONDS = 60
FORBIDDEN_RECOVERY_TOOLS = {
    "mcp_assistant_activate_integration",
    "mcp_assistant_get_chat_tools",
    "mcp_assistant_restart_mcp_server",
}


def _unwrap_tool_output(payload: Any) -> Any:
    if not isinstance(payload, dict):
        return payload
    content = payload.get("content")
    if (
        not isinstance(content, list)
        or not content
        or not isinstance(content[0], dict)
        or "text" not in content[0]
    ):
        return payload
    return json.loads(content[0]["text"])


def _call_core_tool(server_id: str, tool_name: str, payload: dict[str, Any]) -> Any:
    prefix = server_id.replace("-", "_")
    url = f"{CORE_MCP_BASE_URL}/{server_id}/{prefix}_{tool_name}"
    response = httpx.post(url, json=payload, timeout=300.0)
    response.raise_for_status()
    return _unwrap_tool_output(response.json())


def _fetch_readiness() -> dict[str, Any]:
    response = httpx.get(READINESS_URL, timeout=10)
    response.raise_for_status()
    payload = response.json()
    return payload if isinstance(payload, dict) else {}


def ensure_chrome_ready_precondition() -> None:
    deadline = time.time() + PRECONDITION_TIMEOUT_SECONDS
    last_readiness: dict[str, Any] | None = None

    while time.time() < deadline:
        last_readiness = _fetch_readiness()
        phase = last_readiness.get("readinessPhase") or last_readiness.get(
            "readiness_phase"
        )
        if last_readiness.get("healthy") is True and phase == "tool_ready":
            return
        time.sleep(1)

    raise RuntimeError(
        f"{SERVER_ID} did not reach healthy tool_ready within "
        f"{PRECONDITION_TIMEOUT_SECONDS}s: {last_readiness!r}"
    )


def activate_chrome_for_chat(chat_id: str) -> dict[str, Any]:
    result = _call_core_tool(
        "mcp-assistant",
        "activate_integration",
        {"chat_id": chat_id, "tool_server_ids": [TOOL_SERVER_ID]},
    )
    if not isinstance(result, dict) or result.get("success") is not True:
        raise RuntimeError(f"Failed to attach {TOOL_SERVER_ID} to {chat_id}: {result!r}")
    return result


def _tool_call_failed(call: dict[str, Any]) -> bool:
    result = call.get("result")
    if isinstance(result, dict):
        return bool(result.get("error") or result.get("is_error"))
    if isinstance(result, str):
        lowered = result.lower()
        return "error" in lowered or "not available in the current chat yet" in lowered
    return result is None


def _validate_perfect_run(
    *,
    chat_id: str,
    completion: dict[str, Any],
    request_details: list[dict[str, Any]],
    active_capabilities: dict[str, Any],
) -> dict[str, Any]:
    assistant_html = completion.get("content", "")
    tool_calls = _parse_tool_calls(assistant_html)
    tool_names = [call["name"] for call in tool_calls]
    navigate_index = next(
        (
            index
            for index, name in enumerate(tool_names)
            if name == "chrome_devtools_navigate_page"
        ),
        None,
    )
    recovery_before_navigation = [
        name
        for index, name in enumerate(tool_names)
        if name in FORBIDDEN_RECOVERY_TOOLS
        and (navigate_index is None or index < navigate_index)
    ]
    chrome_calls = [
        call
        for call in tool_calls
        if isinstance(call.get("name"), str)
        and call["name"].startswith("chrome_devtools_")
    ]
    chat_tools = _redis_json_get(f"chat_tools:{chat_id}") or []
    capability_servers = {
        str(tool.get("server_id") or "").strip()
        for tool in active_capabilities.get("tools", [])
        if isinstance(tool, dict) and tool.get("server_id")
    }

    perfect = True
    failures: list[str] = []

    if TOOL_SERVER_ID not in chat_tools:
        perfect = False
        failures.append(f"{TOOL_SERVER_ID} was not attached to the chat")
    if SERVER_ID not in capability_servers:
        perfect = False
        failures.append(f"active capabilities never surfaced {SERVER_ID}")
    if navigate_index is None:
        perfect = False
        failures.append("expected chrome_devtools_navigate_page to be called")
    elif navigate_index != 0:
        perfect = False
        failures.append(
            f"chrome_devtools_navigate_page was not the first tool call: {tool_names[:4]}"
        )
    if recovery_before_navigation:
        perfect = False
        failures.append(
            "management/recovery tools were called before Chrome navigation: "
            f"{recovery_before_navigation}"
        )
    if any(_tool_call_failed(call) for call in chrome_calls):
        perfect = False
        failures.append("one or more Chrome DevTools calls surfaced an error")

    if request_details:
        initial_request = request_details[0]
        request_tools = _request_tool_names(initial_request)
        if "chrome_devtools_navigate_page" not in request_tools:
            perfect = False
            failures.append(
                "the browser action request did not expose chrome_devtools_navigate_page"
            )
        if TOOL_SERVER_ID not in (initial_request.get("tool_ids") or []):
            perfect = False
            failures.append(
                f"the browser action request did not include {TOOL_SERVER_ID} in tool_ids"
            )
    else:
        perfect = False
        failures.append("llm-debug-monitor did not capture browser action requests")

    return {
        "perfect": perfect,
        "failures": failures,
        "tool_names": tool_names,
        "tool_calls": tool_calls,
        "chat_tools": chat_tools,
        "request_ids": [request.get("request_id") for request in request_details],
        "request_tool_names": [
            _request_tool_names(request) for request in request_details
        ],
        "active_capabilities": active_capabilities,
    }


def run_once(
    client: OWUIClient,
    *,
    model: str,
    prompt: str,
    timeout_seconds: int,
) -> dict[str, Any]:
    created = client.create_chat(model=model, prompt=INITIAL_PROMPT)
    chat_id = created["chat_id"]
    activate_result = activate_chrome_for_chat(chat_id)

    followup = client.append_user_message(chat_id=chat_id, model=model, prompt=prompt)
    client.generate_completion(
        chat_id=chat_id,
        model=model,
        prompt=prompt,
        user_message_id=followup["user_message_id"],
        stream=True,
    )
    completion = client.poll_for_completion(
        chat_id=chat_id,
        user_message_id=followup["user_message_id"],
        timeout_seconds=timeout_seconds,
        poll_interval=2,
    )
    if not completion.get("complete"):
        return {
            "chat_id": chat_id,
            "perfect": False,
            "failures": [completion.get("error", "chat did not complete")],
            "activate_result": activate_result,
        }

    expected_request_count = _count_tool_call_batches(completion.get("content_blocks", [])) + 1
    request_details = _wait_for_main_request_details(
        chat_id,
        expected_main_request_count=expected_request_count,
    )
    active_capabilities = _get_chat_active_capabilities(client, chat_id)
    verdict = _validate_perfect_run(
        chat_id=chat_id,
        completion=completion,
        request_details=request_details,
        active_capabilities=active_capabilities,
    )
    verdict["chat_id"] = chat_id
    verdict["activate_result"] = activate_result
    return verdict


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=int, default=TARGET_STREAK)
    parser.add_argument("--max-attempts", type=int, default=TARGET_STREAK)
    parser.add_argument("--model", default=MODEL)
    parser.add_argument("--prompt", default=PROMPT)
    parser.add_argument("--timeout-seconds", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    args = parser.parse_args()

    ensure_chrome_ready_precondition()
    ensure_debug_monitor_healthy()

    base_url = _detect_openwebui_base_url()
    perfect_runs = 0
    attempts = 0
    results: list[dict[str, Any]] = []

    with OWUIClient(base_url=base_url, timeout=60.0) as client:
        while perfect_runs < args.runs and attempts < args.max_attempts:
            attempts += 1
            result = run_once(
                client,
                model=args.model,
                prompt=args.prompt,
                timeout_seconds=args.timeout_seconds,
            )
            results.append(result)
            print(json.dumps({"attempt": attempts, **result}, indent=2))
            if result.get("perfect") is True:
                perfect_runs += 1
            else:
                perfect_runs = 0

    summary = {
        "perfect": perfect_runs >= args.runs,
        "perfect_runs": perfect_runs,
        "attempts": attempts,
        "target_runs": args.runs,
        "results": results,
    }
    print(json.dumps(summary, indent=2))
    return 0 if summary["perfect"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
