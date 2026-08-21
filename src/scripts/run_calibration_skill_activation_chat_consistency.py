#!/usr/bin/env python3
"""
Run a real headless Open WebUI chat for an explicitly activated calibration skill.

This scenario creates a temporary skills-user skill that requires both
`server:google_workspace` and `server:agent-vm`, then verifies:
- the chat explicitly calls `skills_activate_skill` once
- skill activation itself attaches the required integrations, so no extra
  `mcp_assistant_activate_integration` call is needed
- the first tool-followup request immediately reflects the activated skill,
  attached servers, request-local tool ids, and preserved assistant context
- the chat completes with Google Workspace plus Agent VM work in the same turn
"""

from __future__ import annotations

import argparse
import json
import os
import time
import uuid
from collections import Counter
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
    _get_chat_active_capabilities,
    _parse_tool_calls,
    _request_assistant_texts,
    _request_system_text,
    _request_tool_names,
    _restart_counts,
    _wait_for_main_request_details,
    ensure_debug_monitor_healthy,
    ensure_enabled_precondition,
)

PROMPT_TEMPLATE = (
    "Help me run a calibration. First activate the {skill_name} skill, then follow its "
    "instructions exactly. Do not do any separate integration activation after the skill is active."
)
TARGET_STREAK = 3
DEFAULT_TIMEOUT_SECONDS = 300
CORE_MCP_BASE_URL = os.getenv("MCPO_CORE_PROXY_BASE_URL", "http://127.0.0.1:8766").rstrip("/")
SKILL_SENTINEL = "CALIBRATION_HOST_LIVE_SENTINEL"


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


def _build_skill_content(skill_name: str) -> str:
    return "\n".join(
        [
            "---",
            f"name: {skill_name}",
            "description: Live calibration host integration test skill",
            "required_mcp_servers:",
            "  - server:google_workspace",
            "  - server:agent-vm",
            "---",
            f"# {skill_name}",
            "",
            f"{SKILL_SENTINEL}",
            "",
            "When this skill is activated:",
            "1. Do not call mcp_assistant_activate_integration. The required MCP servers are already attached by skill activation.",
            "2. Use google_workspace_get_events for the current week with max_results=300.",
            "3. Use agent_vm_bash or agent_vm_python to analyze the events and rank the most important meetings for calibration prep.",
            "4. Return a short prioritized calibration plan.",
            "",
        ]
    )


def _wait_for_skill_visibility(skill_name: str, timeout_seconds: int = 20) -> None:
    deadline = time.time() + timeout_seconds
    last_result: Any = None
    while time.time() < deadline:
        last_result = _call_core_tool("skills", "list_skills", {})
        if isinstance(last_result, dict):
            maybe_skills = last_result.get("skills")
            items = maybe_skills if isinstance(maybe_skills, list) else []
        elif isinstance(last_result, list):
            items = last_result
        else:
            items = []
        for item in items:
            if not isinstance(item, dict):
                continue
            if item.get("name") == skill_name:
                return
        time.sleep(1)
    raise RuntimeError(
        f"Temporary skill {skill_name} did not become visible via skills_list_skills: {last_result!r}"
    )


def _create_temporary_skill(skill_name: str) -> None:
    created = _call_core_tool(
        "skills",
        "create_skill",
        {"skill_name": skill_name, "skill_content": _build_skill_content(skill_name)},
    )
    if not isinstance(created, dict) or created.get("success") is not True:
        raise RuntimeError(f"Failed to create temporary skill {skill_name}: {created!r}")
    _wait_for_skill_visibility(skill_name)


def _delete_temporary_skill(skill_name: str) -> None:
    try:
        _call_core_tool(
            "skills",
            "delete_skill",
            {"skill_name": skill_name, "confirm": True},
        )
    except Exception:
        pass


def _validate_perfect_run(
    *,
    skill_name: str,
    chat_id: str,
    completion: dict[str, Any],
    request_details: list[dict[str, Any]],
    active_capabilities: dict[str, Any],
) -> dict[str, Any]:
    assistant_html = completion.get("content", "")
    tool_calls = _parse_tool_calls(assistant_html)
    tool_names = [call["name"] for call in tool_calls]
    tool_batch_count = _count_tool_call_batches(completion.get("content_blocks", []))
    skill_activation_calls = [
        call for call in tool_calls if call["name"] == "skills_activate_skill"
    ]
    activate_calls = [
        call for call in tool_calls if call["name"] == "mcp_assistant_activate_integration"
    ]
    google_calls = [
        call for call in tool_calls if call["name"].startswith("google_workspace_")
    ]
    agent_vm_calls = [
        call for call in tool_calls if call["name"].startswith("agent_vm_")
    ]
    repeated_bash_commands = sorted(
        command
        for command, count in Counter(
            arguments.get("command", "").strip()
            for call in agent_vm_calls
            for arguments in [call.get("arguments")]
            if call["name"] == "agent_vm_bash"
            and isinstance(arguments, dict)
            and arguments.get("command")
        ).items()
        if count > 1
    )
    expected_request_count = tool_batch_count + 1

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

    perfect = True
    failures: list[str] = []

    if not tool_names or tool_names[0] != "skills_activate_skill":
        perfect = False
        failures.append("the first tool call was not skills_activate_skill")
    if len(skill_activation_calls) != 1:
        perfect = False
        failures.append(f"expected exactly one skills_activate_skill call, saw {len(skill_activation_calls)}")
    if activate_calls:
        perfect = False
        failures.append(
            "mcp_assistant_activate_integration was called even though skills_activate_skill should have attached the required servers"
        )
    if "mcp_assistant_authorize_integration" in tool_names:
        perfect = False
        failures.append("authorize_integration was called even though the server started ready")
    if not google_calls:
        perfect = False
        failures.append("expected at least one Google Workspace tool call after skill activation")
    if not agent_vm_calls:
        perfect = False
        failures.append("expected at least one Agent VM tool call after skill activation")
    if any(
        not isinstance(call.get("result"), dict) or call["result"].get("error")
        for call in google_calls + agent_vm_calls
    ):
        perfect = False
        failures.append("one or more downstream Google Workspace / Agent VM tool calls surfaced an error")
    if repeated_bash_commands:
        perfect = False
        failures.append(
            "agent_vm_bash repeated the exact same command: "
            f"{repeated_bash_commands}"
        )

    skill_activation_result = skill_activation_calls[0]["result"] if skill_activation_calls else None
    if not isinstance(skill_activation_result, dict) or not skill_activation_result.get("success"):
        perfect = False
        failures.append("skills_activate_skill did not return a successful payload")
    else:
        enabled_servers = set(skill_activation_result.get("enabled_mcp_servers") or [])
        if {"server:google_workspace", "server:agent-vm"} - enabled_servers:
            perfect = False
            failures.append(
                "skills_activate_skill did not report both required MCP servers as enabled: "
                f"{sorted(enabled_servers)}"
            )

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

    followups = [
        request for request in request_details if request.get("request_phase") == "tool_followup"
    ]
    if not followups:
        perfect = False
        failures.append("expected at least one tool_followup request after skills_activate_skill")
    else:
        first_followup = followups[0]
        if skill_name not in _extract_activated_skill_names_from_request(first_followup):
            perfect = False
            failures.append("the first tool_followup request did not contain the activated temporary skill block")
        if SKILL_SENTINEL not in _request_system_text(first_followup):
            perfect = False
            failures.append("the first tool_followup request did not contain the temporary SKILL.md sentinel content")
        if not {"server:google_workspace", "server:agent-vm"}.issubset(
            set(_extract_enabled_servers_from_request(first_followup))
        ):
            perfect = False
            failures.append(
                "the first tool_followup request did not advertise both dependent integrations in <tool_servers><enabled>"
            )
        request_tool_names = _request_tool_names(first_followup)
        if "google_workspace_get_events" not in request_tool_names:
            perfect = False
            failures.append("the first tool_followup request did not expose google_workspace_get_events in its tool payload")
        if not any(tool_name.startswith("agent_vm_") for tool_name in request_tool_names):
            perfect = False
            failures.append("the first tool_followup request did not expose Agent VM tools in its tool payload")
    if skill_name not in capability_skills:
        perfect = False
        failures.append("active capabilities never surfaced the temporary skill for the chat")
    if "google_workspace" not in capability_servers:
        perfect = False
        failures.append("active capabilities never surfaced google_workspace for the chat")

    return {
        "perfect": perfect,
        "failures": failures,
        "tool_names": tool_names,
        "tool_calls": tool_calls,
        "tool_batch_count": tool_batch_count,
        "request_ids": [request.get("request_id") for request in request_details],
        "request_phases": [request.get("request_phase") for request in request_details],
        "repeated_agent_vm_bash_commands": repeated_bash_commands,
        "active_capabilities": active_capabilities,
    }


def run_once(
    client: OWUIClient,
    prompt: str,
    model: str,
    timeout_seconds: int,
) -> dict[str, Any]:
    ensure_enabled_precondition()

    skill_name = f"calibration-host-live-{uuid.uuid4().hex[:8]}"
    _create_temporary_skill(skill_name)
    try:
        created = client.create_chat(model=model, prompt=prompt.format(skill_name=skill_name))
        chat_id = created["chat_id"]
        user_message_id = created["user_message_id"]
        client.generate_completion(
            chat_id=chat_id,
            model=model,
            prompt=prompt.format(skill_name=skill_name),
            user_message_id=user_message_id,
            stream=True,
        )
        completion = client.poll_for_completion(
            chat_id=chat_id,
            user_message_id=user_message_id,
            timeout_seconds=timeout_seconds,
            poll_interval=2,
        )
        if not completion.get("complete"):
            return {
                "chat_id": chat_id,
                "perfect": False,
                "failures": [completion.get("error", "chat did not complete")],
            }

        request_details = _wait_for_main_request_details(
            chat_id,
            expected_main_request_count=_count_tool_call_batches(
                completion.get("content_blocks", [])
            )
            + 1,
        )
        active_capabilities = _get_chat_active_capabilities(client, chat_id)
        verdict = _validate_perfect_run(
            skill_name=skill_name,
            chat_id=chat_id,
            completion=completion,
            request_details=request_details,
            active_capabilities=active_capabilities,
        )
        verdict["chat_id"] = chat_id
        verdict["skill_name"] = skill_name
        return verdict
    finally:
        _delete_temporary_skill(skill_name)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=int, default=TARGET_STREAK)
    parser.add_argument("--max-attempts", type=int, default=10)
    parser.add_argument("--prompt", default=PROMPT_TEMPLATE)
    parser.add_argument("--model", default=MODEL)
    parser.add_argument("--timeout-seconds", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    args = parser.parse_args()

    restart_counts_before = _restart_counts()
    print(json.dumps({"restart_counts_before": restart_counts_before}, indent=2))
    ensure_debug_monitor_healthy()

    streak = 0
    attempts = 0
    results = []
    with OWUIClient(base_url=_detect_openwebui_base_url()) as client:
        while streak < args.runs and attempts < args.max_attempts:
            attempts += 1
            started = time.time()
            run = run_once(client, args.prompt, args.model, args.timeout_seconds)
            run["attempt"] = attempts
            run["elapsed_seconds"] = round(time.time() - started, 1)
            results.append(run)
            print(json.dumps(run, indent=2, sort_keys=True))
            if run["perfect"]:
                streak += 1
            else:
                streak = 0
                break

    restart_counts_after = _restart_counts()
    summary = {
        "requested_streak": args.runs,
        "achieved_streak": streak,
        "attempts": attempts,
        "restart_counts_before": restart_counts_before,
        "restart_counts_after": restart_counts_after,
        "success": streak >= args.runs,
        "chat_ids": [result["chat_id"] for result in results if result.get("chat_id")],
    }
    print(json.dumps({"summary": summary}, indent=2, sort_keys=True))
    return 0 if summary["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
