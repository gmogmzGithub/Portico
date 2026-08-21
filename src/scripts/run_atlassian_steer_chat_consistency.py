#!/usr/bin/env python3
"""
Run a real headless Open WebUI chat that uses pending steer to trigger Atlassian work.

This scenario validates:
- the steer-generated request sequence anchors to the inserted steer user turn
- no steer request falls back to a background anchor
- each request still follows the one-request-per-tool-batch contract
- Atlassian tools are only called once they are actually callable
- no Atlassian tool result surfaces the synthetic "tool not available in the current chat yet" error
"""

from __future__ import annotations

import argparse
import json
import os
import time
from typing import Any

import httpx

from run_google_workspace_chat_consistency import (
    CONTINUATION_SYSTEM_MESSAGE_FRAGMENT,
    DEBUG_MONITOR_BASE_URL,
    MODEL,
    OWUIClient,
    _count_tool_call_batches,
    _detect_openwebui_base_url,
    _extract_activated_skill_names_from_request,
    _extract_enabled_servers_from_request,
    _fetch_chat_request_summaries,
    _fetch_request_detail,
    _get_chat_active_capabilities,
    _main_request_summaries,
    _merged_request_detail,
    _parse_tool_calls,
    _request_system_text,
    _request_tool_names,
    _restart_counts,
    ensure_debug_monitor_healthy,
)

INITIAL_PROMPT = "Reply with exactly: ready for steer"
STEER_PROMPT = (
    "Use the atlassian-portico skill if needed, then inspect Jira issue AI4A-801. "
    "Return the issue summary and description."
)
SERVER_ID = "mcp-atlassian"
TOGGLE_URL = os.getenv("ELECTRON_API_BASE", "http://127.0.0.1:9876").rstrip("/")
TOGGLE_API_URL = f"{TOGGLE_URL}/api/toggle-mcp-server"
READINESS_URL = f"{TOGGLE_URL}/api/server-readiness/{SERVER_ID}"
TARGET_STREAK = 3
PRECONDITION_TIMEOUT_SECONDS = 90
DEBUG_MONITOR_TIMEOUT_SECONDS = 45
DEBUG_MONITOR_SETTLE_POLLS = 2


def _fetch_readiness() -> dict[str, Any]:
    response = httpx.get(READINESS_URL, timeout=10)
    response.raise_for_status()
    payload = response.json()
    return payload if isinstance(payload, dict) else {}


def ensure_enabled_precondition() -> None:
    response = httpx.post(
        TOGGLE_API_URL,
        json={"server_id": SERVER_ID, "enabled": True},
        timeout=90,
    )
    response.raise_for_status()
    deadline = time.time() + PRECONDITION_TIMEOUT_SECONDS
    last_phase = None
    while time.time() < deadline:
        readiness = _fetch_readiness()
        last_phase = readiness.get("readinessPhase") or readiness.get("readiness_phase")
        if last_phase == "tool_ready":
            return
        time.sleep(1)
    raise RuntimeError(
        f"{SERVER_ID} did not reach the enabled tool_ready precondition within "
        f"{PRECONDITION_TIMEOUT_SECONDS}s (last phase={last_phase!r})"
    )


def _put_pending_steer(client: OWUIClient, *, chat_id: str, model: str, prompt: str) -> dict[str, Any]:
    model_item = client.get_model_item(model)
    payload = {
        "prompt": prompt,
        "request_context": {
            "selected_model_ids": [model],
            "selected_model_items": {model: model_item},
            "tool_ids": client.get_tool_ids(),
            "params": {"function_calling": "native"},
            "features": {
                "image_generation": False,
                "code_interpreter": False,
                "web_search": False,
            },
            "background_tasks": {
                "title_generation": False,
                "tags_generation": False,
                "follow_up_generation": False,
            },
        },
    }
    response = client.client.put(
        f"/api/v1/chats/{chat_id}/pending-steer",
        json=payload,
        timeout=60.0,
    )
    response.raise_for_status()
    result = response.json()
    return result if isinstance(result, dict) else {}


def _message_map(chat_payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    history = chat_payload.get("chat", chat_payload).get("history", {})
    messages = history.get("messages")
    return messages if isinstance(messages, dict) else {}


def _find_message_id_by_content(chat_payload: dict[str, Any], *, role: str, content: str) -> str | None:
    for message_id, message in _message_map(chat_payload).items():
        if not isinstance(message, dict):
            continue
        if message.get("role") != role:
            continue
        if message.get("content") == content:
            return message_id
    return None


def _message_is_complete(message: dict[str, Any]) -> bool:
    if not isinstance(message, dict) or message.get("role") != "assistant":
        return False
    if message.get("done") is True:
        return True
    stop_reason = message.get("stop_reason") or message.get("stopReason")
    finish_reason = message.get("finish_reason") or message.get("finishReason")
    return bool(stop_reason or finish_reason)


def _wait_for_steer_completion(
    client: OWUIClient,
    *,
    chat_id: str,
    steer_prompt: str,
    timeout_seconds: int = 300,
) -> tuple[str, dict[str, Any]]:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        chat = client.get_chat(chat_id)
        messages = _message_map(chat)
        steer_user_message_id = _find_message_id_by_content(
            chat, role="user", content=steer_prompt
        )
        if not steer_user_message_id:
            time.sleep(2)
            continue
        steer_user_message = messages.get(steer_user_message_id) or {}
        for child_id in steer_user_message.get("childrenIds") or []:
            candidate = messages.get(child_id)
            if _message_is_complete(candidate):
                return steer_user_message_id, candidate
        time.sleep(2)
    raise RuntimeError(
        f"Timed out waiting for steer completion in chat {chat_id} for prompt {steer_prompt!r}"
    )


def _wait_for_new_main_request_details(
    chat_id: str,
    *,
    existing_request_ids: set[str],
    expected_main_request_count: int,
    timeout_seconds: int = DEBUG_MONITOR_TIMEOUT_SECONDS,
    settle_polls: int = DEBUG_MONITOR_SETTLE_POLLS,
) -> list[dict[str, Any]]:
    deadline = time.time() + timeout_seconds
    stable_polls = 0
    last_request_ids: tuple[str, ...] | None = None
    latest_requests: list[dict[str, Any]] = []

    while time.time() < deadline:
        summaries = _main_request_summaries(_fetch_chat_request_summaries(chat_id))
        latest_requests = [
            summary
            for summary in summaries
            if str(summary.get("request_id") or "") not in existing_request_ids
        ]
        request_ids = tuple(
            str(summary.get("request_id") or "")
            for summary in latest_requests
            if summary.get("request_id")
        )
        all_terminal = all(
            str(summary.get("status") or "") in {"complete", "error"}
            for summary in latest_requests
        )
        if len(latest_requests) >= expected_main_request_count and all_terminal:
            if request_ids == last_request_ids:
                stable_polls += 1
            else:
                last_request_ids = request_ids
                stable_polls = 1
            if stable_polls >= settle_polls:
                return [
                    _merged_request_detail(summary, _fetch_request_detail(summary["request_id"]))
                    for summary in latest_requests
                ]
        time.sleep(1)

    raise RuntimeError(
        "Timed out waiting for steer request details to settle for "
        f"chat {chat_id}. Expected at least {expected_main_request_count}, "
        f"saw {len(latest_requests)}."
    )


def _validate_perfect_run(
    *,
    chat_id: str,
    steer_user_message_id: str,
    completion: dict[str, Any],
    request_details: list[dict[str, Any]],
    active_capabilities: dict[str, Any],
) -> dict[str, Any]:
    assistant_html = completion.get("content", "")
    tool_calls = _parse_tool_calls(assistant_html)
    tool_names = [call["name"] for call in tool_calls]
    tool_batch_count = _count_tool_call_batches(completion.get("content_blocks", []))
    expected_request_count = tool_batch_count + 1

    perfect = True
    failures: list[str] = []

    if len(request_details) != expected_request_count:
        perfect = False
        failures.append(
            "main request count did not match one-request-per-tool-batch contract: "
            f"expected {expected_request_count}, saw {len(request_details)}"
        )

    if any(
        CONTINUATION_SYSTEM_MESSAGE_FRAGMENT in _request_system_text(request)
        for request in request_details
    ):
        perfect = False
        failures.append("one or more requests still contained the banned follow-up continuation system text")

    if not request_details:
        perfect = False
        failures.append("no steer-generated requests were captured in llm-debug-monitor")
    else:
        first_request = request_details[0]
        if first_request.get("transcript_anchor_kind") != "user_message":
            perfect = False
            failures.append(
                "the initial steer request was not anchored to a user message"
            )
        if first_request.get("transcript_anchor_message_id") != steer_user_message_id:
            perfect = False
            failures.append(
                "the initial steer request did not anchor to the inserted steer user message"
            )
        if any(
            request.get("transcript_anchor_kind") == "background"
            for request in request_details
        ):
            perfect = False
            failures.append("one or more steer requests fell back to a background anchor")
        if any(
            request.get("trigger_message_id") != steer_user_message_id
            for request in request_details
        ):
            perfect = False
            failures.append(
                "one or more steer requests lost the inserted steer trigger_message_id"
            )

    if "mcp_atlassian_Get_JIRA_Issue" not in tool_names:
        perfect = False
        failures.append("expected a mcp_atlassian_Get_JIRA_Issue call after the steer")

    unavailable_results = [
        call["name"]
        for call in tool_calls
        if isinstance(call.get("result"), str)
        and "not available in the current chat yet" in call["result"]
    ]
    if unavailable_results:
        perfect = False
        failures.append(
            f"one or more steer tool calls surfaced the unavailable-tool guard: {unavailable_results}"
        )

    if any(
        request.get("request_phase") == "tool_followup"
        and "mcp_atlassian_Get_JIRA_Issue" not in _request_tool_names(request)
        and "mcp_assistant_activate_integration" not in _request_tool_names(request)
        for request in request_details
    ):
        perfect = False
        failures.append(
            "a steer tool_followup request exposed neither the Atlassian tool nor the activation tool"
        )

    followups = [
        request for request in request_details if request.get("request_phase") == "tool_followup"
    ]
    if not any(
        "server:mcp-atlassian" in _extract_enabled_servers_from_request(request)
        for request in request_details
    ):
        perfect = False
        failures.append("no steer request advertised server:mcp-atlassian in <tool_servers><enabled>")

    if not any(
        "atlassian-portico" in _extract_activated_skill_names_from_request(request)
        for request in request_details
    ):
        perfect = False
        failures.append("no steer request contained the activated atlassian-portico skill block")

    capability_servers = {
        str(tool.get("server_id") or "")
        for tool in active_capabilities.get("tools", [])
        if isinstance(tool, dict) and tool.get("server_id")
    }
    capability_skills = {
        str(skill.get("name") or skill.get("display_name") or "").strip()
        for skill in active_capabilities.get("skills", [])
        if isinstance(skill, dict)
    }
    if "mcp-atlassian" not in capability_servers:
        perfect = False
        failures.append("active capabilities never surfaced mcp-atlassian for the chat")
    if "atlassian-portico" not in capability_skills:
        perfect = False
        failures.append("active capabilities never surfaced the atlassian-portico skill for the chat")

    return {
        "perfect": perfect,
        "failures": failures,
        "tool_names": tool_names,
        "tool_calls": tool_calls,
        "tool_batch_count": tool_batch_count,
        "followup_request_ids": [request.get("request_id") for request in followups],
        "request_ids": [request.get("request_id") for request in request_details],
        "request_phases": [request.get("request_phase") for request in request_details],
    }


def run_once(client: OWUIClient, *, prompt: str, steer_prompt: str, model: str) -> dict[str, Any]:
    ensure_enabled_precondition()
    created = client.create_chat(model=model, prompt=prompt)
    chat_id = created["chat_id"]
    user_message_id = created["user_message_id"]
    client.generate_completion(
        chat_id=chat_id,
        model=model,
        prompt=prompt,
        user_message_id=user_message_id,
        stream=True,
    )
    completion = client.poll_for_completion(
        chat_id=chat_id,
        user_message_id=user_message_id,
        timeout_seconds=180,
        poll_interval=2,
    )
    if not completion.get("complete"):
        return {
            "chat_id": chat_id,
            "perfect": False,
            "failures": [completion.get("error", "initial chat did not complete")],
        }

    initial_main_request_ids = {
        str(request.get("request_id") or "")
        for request in _main_request_summaries(_fetch_chat_request_summaries(chat_id))
        if request.get("request_id")
    }

    _put_pending_steer(client, chat_id=chat_id, model=model, prompt=steer_prompt)
    steer_user_message_id, steer_completion = _wait_for_steer_completion(
        client,
        chat_id=chat_id,
        steer_prompt=steer_prompt,
    )
    request_details = _wait_for_new_main_request_details(
        chat_id,
        existing_request_ids=initial_main_request_ids,
        expected_main_request_count=_count_tool_call_batches(
            steer_completion.get("contentBlocks", [])
        )
        + 1,
    )
    active_capabilities = _get_chat_active_capabilities(client, chat_id)

    verdict = _validate_perfect_run(
        chat_id=chat_id,
        steer_user_message_id=steer_user_message_id,
        completion={
            "content": steer_completion.get("content", ""),
            "content_blocks": steer_completion.get("contentBlocks", []),
        },
        request_details=request_details,
        active_capabilities=active_capabilities,
    )
    verdict["chat_id"] = chat_id
    verdict["steer_user_message_id"] = steer_user_message_id
    verdict["active_capabilities"] = active_capabilities
    return verdict


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=int, default=TARGET_STREAK)
    parser.add_argument("--max-attempts", type=int, default=10)
    parser.add_argument("--prompt", default=INITIAL_PROMPT)
    parser.add_argument("--steer-prompt", default=STEER_PROMPT)
    parser.add_argument("--model", default=MODEL)
    args = parser.parse_args()

    restart_counts_before = _restart_counts()
    print(json.dumps({"restart_counts_before": restart_counts_before}, indent=2))

    ensure_debug_monitor_healthy()
    client = OWUIClient(base_url=_detect_openwebui_base_url())
    try:
        streak = 0
        attempts = 0
        while streak < args.runs and attempts < args.max_attempts:
            attempts += 1
            verdict = run_once(
                client,
                prompt=args.prompt,
                steer_prompt=args.steer_prompt,
                model=args.model,
            )
            print(json.dumps(verdict, indent=2))
            if verdict.get("perfect"):
                streak += 1
            else:
                streak = 0
                return 1
        return 0 if streak >= args.runs else 1
    finally:
        client.close()


if __name__ == "__main__":
    raise SystemExit(main())
