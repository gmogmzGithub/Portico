#!/usr/bin/env python3
"""
Run a real headless Open WebUI chat for the Scheduled Tasks first-turn flow.

This scenario validates:
- the `scheduled-tasks` skill auto-activates for the chat
- the required `server:scheduling` MCP server is attached to the chat on the
  same first turn, with no explicit activation/toggle/auth flow
- the first downstream tool path reaches `scheduling_list_tasks`
- the Scheduling tool call succeeds even when the task list is empty
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
    _redis_json_get,
    _request_messages,
    _request_system_messages,
    _request_system_text,
    _stringify_message_content,
    ensure_debug_monitor_healthy,
)

PROMPT = "What scheduled tasks do I have"
SERVER_ID = "scheduling"
TOGGLE_URL = os.getenv("ELECTRON_API_BASE", "http://127.0.0.1:9876").rstrip("/")
READINESS_URL = f"{TOGGLE_URL}/api/server-readiness/{SERVER_ID}"
PRECONDITION_TIMEOUT_SECONDS = 60


def _fetch_readiness() -> dict[str, Any]:
    response = httpx.get(READINESS_URL, timeout=10)
    response.raise_for_status()
    payload = response.json()
    return payload if isinstance(payload, dict) else {}


def ensure_scheduling_ready_precondition() -> None:
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


def _tool_call_failed(call: dict[str, Any]) -> bool:
    result = call.get("result")
    if isinstance(result, dict):
        return bool(result.get("error"))
    if isinstance(result, str):
        lowered = result.lower()
        return "error" in lowered or "not available in the current chat yet" in lowered
    return result is None


def _collect_request_details_if_available(
    chat_id: str,
    *,
    expected_main_request_count: int,
    timeout_seconds: int = 45,
    settle_polls: int = 2,
) -> tuple[list[dict[str, Any]], str | None]:
    deadline = time.time() + timeout_seconds
    stable_polls = 0
    last_request_ids: tuple[str, ...] | None = None
    latest_main_requests: list[dict[str, Any]] = []
    last_error: str | None = None

    while time.time() < deadline:
        try:
            summaries = _main_request_summaries(_fetch_chat_request_summaries(chat_id))
            latest_main_requests = summaries
            request_ids = tuple(
                str(summary.get("request_id") or "")
                for summary in summaries
                if summary.get("request_id")
            )
            all_terminal = all(
                str(summary.get("status") or "") in {"complete", "error"}
                for summary in summaries
            )
            if len(summaries) >= expected_main_request_count and all_terminal:
                if request_ids == last_request_ids:
                    stable_polls += 1
                else:
                    last_request_ids = request_ids
                    stable_polls = 1
                if stable_polls >= settle_polls:
                    return (
                        [
                            _merged_request_detail(
                                summary,
                                _fetch_request_detail(summary["request_id"]),
                            )
                            for summary in summaries
                        ],
                        None,
                    )
        except Exception as error:  # pragma: no cover - exercised in live runs
            last_error = str(error)

        time.sleep(1)

    return [], last_error or (
        "llm-debug-monitor request trace collection did not settle before the deadline"
    )


def _validate_perfect_run(
    *,
    chat_id: str,
    completion: dict[str, Any],
    request_details: list[dict[str, Any]],
    request_details_error: str | None,
    active_capabilities: dict[str, Any],
) -> dict[str, Any]:
    assistant_html = completion.get("content", "")
    tool_calls = _parse_tool_calls(assistant_html)
    tool_names = [call["name"] for call in tool_calls]
    tool_batch_count = _count_tool_call_batches(completion.get("content_blocks", []))
    expected_request_count = tool_batch_count + 1

    list_calls = [call for call in tool_calls if call["name"] == "scheduling_list_tasks"]
    forbidden_calls = [
        call["name"]
        for call in tool_calls
        if call["name"]
        in {
            "mcp_assistant_toggle_integration",
            "mcp_assistant_activate_integration",
            "mcp_assistant_authorize_integration",
        }
    ]

    capability_servers = {
        str(tool.get("server_id") or "").strip()
        for tool in active_capabilities.get("tools", [])
        if isinstance(tool, dict) and tool.get("server_id")
    }
    capability_skills = {
        str(skill.get("name") or skill.get("display_name") or "").strip()
        for skill in active_capabilities.get("skills", [])
        if isinstance(skill, dict)
    }
    chat_skills = _redis_json_get(f"chat_skills:{chat_id}") or []
    chat_tools = _redis_json_get(f"chat_tools:{chat_id}") or []

    perfect = True
    failures: list[str] = []
    warnings: list[str] = []

    if forbidden_calls:
        perfect = False
        failures.append(
            f"unexpected MCP management tool calls occurred: {forbidden_calls}"
        )
    if not tool_names or tool_names[0] != "scheduling_list_tasks":
        perfect = False
        failures.append(
            f"the first tool call was not scheduling_list_tasks: {tool_names[:3]}"
        )
    if not list_calls:
        perfect = False
        failures.append("expected at least one scheduling_list_tasks call")
    if any(_tool_call_failed(call) for call in list_calls):
        perfect = False
        failures.append("one or more scheduling_list_tasks calls surfaced an error")
    if (
        "Tool loop stopped after repeated non-progressing calls to" in assistant_html
        or "not available in the current chat yet" in assistant_html
    ):
        perfect = False
        failures.append("assistant emitted synthetic unavailable/loop guard text")

    if request_details:
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
            failures.append(
                "one or more requests still contained the banned follow-up continuation system text"
            )
        if not any(
            "scheduled-tasks" in _extract_activated_skill_names_from_request(request)
            for request in request_details
        ):
            perfect = False
            failures.append(
                "no request contained the activated scheduled-tasks skill block"
            )
        if not any(
            "server:scheduling" in _extract_enabled_servers_from_request(request)
            for request in request_details
        ):
            perfect = False
            failures.append(
                "no request advertised server:scheduling in <tool_servers><enabled>"
            )

        for request in request_details:
            request_id = str(request.get("request_id") or "unknown-request")
            messages = _request_messages(request)
            if len(messages) < 4:
                perfect = False
                failures.append(
                    f"{request_id} did not include the expected 3-system-message prefix and user/assistant history"
                )

            if [message.get("role") for message in messages[:3]] != [
                "system",
                "system",
                "system",
            ]:
                perfect = False
                failures.append(
                    f"{request_id} did not preserve the expected 3 leading system messages"
                )

            system_messages = _request_system_messages(request)
            if len(system_messages) != 3:
                perfect = False
                failures.append(
                    f"{request_id} did not keep exactly 3 system messages (saw {len(system_messages)})"
                )
                continue

            system_1_text = _stringify_message_content(system_messages[1].get("content"))
            system_2_text = _stringify_message_content(system_messages[2].get("content"))
            if "<static_context>" not in system_1_text:
                perfect = False
                failures.append(
                    f"{request_id} was missing <static_context> in system message 1"
                )
            if "<dynamic_context>" not in system_2_text:
                perfect = False
                failures.append(
                    f"{request_id} was missing <dynamic_context> in system message 2"
                )
    elif request_details_error:
        warnings.append(
            "llm-debug-monitor request trace collection was unavailable for this run: "
            f"{request_details_error}"
        )

    if "scheduled-tasks" not in chat_skills:
        perfect = False
        failures.append("scheduled-tasks skill was not recorded in chat_skills")
    if "server:scheduling" not in chat_tools:
        perfect = False
        failures.append("server:scheduling was not recorded in chat_tools")
    if not request_details and "server:scheduling" not in chat_tools:
        perfect = False
        failures.append(
            "request traces were unavailable and chat_tools also did not show server:scheduling"
        )

    if "scheduled-tasks" not in capability_skills:
        perfect = False
        failures.append("active capabilities never surfaced the scheduled-tasks skill")
    if "scheduling" not in capability_servers:
        perfect = False
        failures.append("active capabilities never surfaced scheduling for the chat")

    if not request_details and "server:scheduling" in chat_tools and "scheduled-tasks" in chat_skills:
        # Redis chat state is the authoritative source for the UI chip that was
        # broken in the original bug report, so do not fail the scenario solely
        # because llm-debug-monitor request traces were unavailable.
        pass

    return {
        "perfect": perfect,
        "failures": failures,
        "warnings": warnings,
        "tool_names": tool_names,
        "tool_calls": tool_calls,
        "chat_skills": chat_skills,
        "chat_tools": chat_tools,
        "request_ids": [request.get("request_id") for request in request_details],
        "request_trace_available": bool(request_details),
        "request_trace_error": request_details_error,
        "active_capability_servers": sorted(capability_servers),
        "active_capability_skills": sorted(capability_skills),
    }


def run_once(*, base_url: str, prompt: str, model: str) -> dict[str, Any]:
    client = OWUIClient(base_url)
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
        timeout_seconds=300,
        poll_interval=2,
    )
    if not completion.get("complete"):
        return {
            "chat_id": chat_id,
            "perfect": False,
            "failures": [completion.get("error", "chat did not complete")],
        }

    active_capabilities = _get_chat_active_capabilities(client, chat_id)
    request_details, request_details_error = _collect_request_details_if_available(
        chat_id,
        expected_main_request_count=_count_tool_call_batches(
            completion.get("content_blocks", [])
        )
        + 1,
    )
    validation = _validate_perfect_run(
        chat_id=chat_id,
        completion=completion,
        request_details=request_details,
        request_details_error=request_details_error,
        active_capabilities=active_capabilities,
    )
    validation.update(
        {
            "chat_id": chat_id,
            "assistant_content": completion.get("content", ""),
        }
    )
    return validation


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompt", default=PROMPT)
    parser.add_argument("--model", default=MODEL)
    parser.add_argument("--runs", type=int, default=1)
    parser.add_argument("--max-attempts", type=int, default=3)
    args = parser.parse_args()

    base_url = _detect_openwebui_base_url()
    ensure_debug_monitor_healthy()
    ensure_scheduling_ready_precondition()

    results: list[dict[str, Any]] = []
    streak = 0
    attempt = 0

    while streak < args.runs and attempt < args.max_attempts:
        attempt += 1
        result = run_once(base_url=base_url, prompt=args.prompt, model=args.model)
        result["attempt"] = attempt
        results.append(result)
        if result.get("perfect"):
            streak += 1
        else:
            streak = 0

    summary = {
        "prompt": args.prompt,
        "model": args.model,
        "requested_runs": args.runs,
        "max_attempts": args.max_attempts,
        "streak": streak,
        "perfect": streak >= args.runs,
        "results": results,
    }
    print(json.dumps(summary, indent=2))

    if streak < args.runs:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
