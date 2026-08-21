#!/usr/bin/env python3
"""
Run a real headless Open WebUI chat and verify the code-execution follow-up path.

Validation:
- the `code-execution` skill auto-activates before the first upstream request
- the initial request already exposes Agent VM tools and `server:agent-vm` in request-local tool ids
- each completed tool-call batch produces exactly one main upstream request
- follow-up requests preserve assistant text and never include the old continuation spam
- Agent VM tools succeed in the same turn
- active capabilities converge for the chat
"""

from __future__ import annotations

import argparse
import html
import httpx
import json
import re
import time
from collections import Counter
from pathlib import Path
from typing import Any

from run_google_workspace_chat_consistency import (
    CONTINUATION_SYSTEM_MESSAGE_FRAGMENT,
    MODEL,
    OWUIClient,
    _count_tool_call_batches,
    _detect_openwebui_base_url,
    _extract_activated_skill_names_from_request,
    _get_chat_active_capabilities,
    _parse_tool_calls,
    _redis_json_get,
    _request_assistant_texts,
    _request_system_text,
    _request_tool_names,
    _restart_counts,
    _wait_for_main_request_details,
    ensure_debug_monitor_healthy,
)

PROMPT = "Write a Python script to compute the first 50 prime numbers. Tell me the numbers."
MARKDOWN_FILE_NAME = "native-tool-call-regression.md"
MARKDOWN_FILE_MARKERS = (
    "# Native tool call regression",
    "| native tool calls | required |",
)
MARKDOWN_FILE_PROMPT = (
    "Use code execution in the Agent VM to create a Markdown file named "
    f"`{MARKDOWN_FILE_NAME}` in the current workspace. The file must contain "
    "a heading `# Native tool call regression` and a Markdown table with "
    "the row `| native tool calls | required |`. After the file is written, "
    "tell me the path."
)
SVG_FILE_NAME = "native-svg-display-regression.svg"
SVG_FILE_MARKERS = ("<svg", "native-svg-display-regression")
SVG_FILE_PROMPT = (
    "Use code execution in the Agent VM to create a valid SVG file named "
    f"`{SVG_FILE_NAME}` at `/work/{SVG_FILE_NAME}`. Give it width 120, height 80, "
    "and an element with id `native-svg-display-regression`. After creating it, "
    "you must call `agent_vm_display_files` with that exact file path so it is "
    "displayed inline. Then tell me the path."
)
SCENARIOS = ("primes", "markdown-file", "svg-display")
TARGET_STREAK = 5
DEFAULT_TIMEOUT_SECONDS = 300


def _default_prompt_for_scenario(scenario: str) -> str:
    if scenario == "markdown-file":
        return MARKDOWN_FILE_PROMPT
    if scenario == "svg-display":
        return SVG_FILE_PROMPT
    return PROMPT


def _default_model_for_scenario(scenario: str) -> str:
    return MODEL


def _strip_details_blocks(content: str) -> str:
    without_details = re.sub(r"<details\b.*?</details>", "", content or "", flags=re.DOTALL)
    without_tags = re.sub(r"<[^>]+>", "", without_details)
    return html.unescape(without_tags).strip()


def _detect_pseudo_tool_call_text(content: str) -> list[str]:
    visible_text = _strip_details_blocks(content)
    return sorted(
        set(
            match.group(1)
            for match in re.finditer(
                r"\b((?:skills_activate_skill|mcp_assistant_[A-Za-z0-9_]+|agent_vm_[A-Za-z0-9_]+))\s*\(",
                visible_text,
            )
        )
    )


def _find_workspace_files(chat_id: str, filename: str) -> list[Path]:
    root = Path(__file__).resolve().parents[2] / "workspaces" / chat_id
    if not root.exists():
        return []
    return sorted(root.rglob(filename))


def _coerce_json_value(value: Any) -> Any:
    current = value
    for _ in range(4):
        if not isinstance(current, str):
            return current
        try:
            current = json.loads(current)
        except (TypeError, ValueError):
            return current
    return current


def _display_file_records(tool_calls: list[dict[str, Any]]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []

    def collect(value: Any) -> None:
        value = _coerce_json_value(value)
        if isinstance(value, list):
            for item in value:
                collect(item)
            return
        if not isinstance(value, dict):
            return
        files = value.get("files")
        if value.get("display_files") is True and isinstance(files, list):
            records.extend(file for file in files if isinstance(file, dict))
        if isinstance(value.get("results"), list):
            collect(value["results"])
        if isinstance(value.get("content"), (dict, list, str)):
            collect(value["content"])
        if isinstance(value.get("text"), str):
            collect(value["text"])
        if isinstance(value.get("result"), (dict, list, str)):
            collect(value["result"])

    for call in tool_calls:
        if call.get("name") == "agent_vm_display_files":
            collect(call.get("result"))
    return records


def _validate_inline_display_file(
    tool_calls: list[dict[str, Any]],
    expected_file_name: str,
    *,
    expected_content_markers: tuple[str, ...] = (),
    http_get=httpx.get,
) -> tuple[list[str], list[dict[str, Any]], dict[str, Any]]:
    failures: list[str] = []
    records = _display_file_records(tool_calls)
    matching = [
        record
        for record in records
        if record.get("file_name") == expected_file_name
        or str(record.get("file_path") or "").endswith(f"/{expected_file_name}")
        or record.get("file_path") == expected_file_name
    ]
    if not matching:
        return (
            [f"agent_vm_display_files did not return {expected_file_name!r}"],
            records,
            {},
        )

    record = matching[0]
    if record.get("mime_type") != "image/svg+xml":
        failures.append("displayed SVG did not report image/svg+xml")
    if record.get("is_image") is not True:
        failures.append("displayed SVG was not classified as an image")

    browser_url = str(record.get("browser_url") or "")
    compatibility_url = str(record.get("url") or "")
    download_url = str(record.get("download_url") or "")
    if not browser_url.endswith("?inline=1"):
        failures.append("displayed SVG browser_url was not marked for inline delivery")
    if compatibility_url != browser_url:
        failures.append("displayed SVG compatibility url did not match browser_url")
    if not download_url or "inline=1" in download_url:
        failures.append("displayed SVG download_url did not retain attachment semantics")
    if browser_url == download_url:
        failures.append("displayed SVG browser and download URLs were not distinct")

    response_summary: dict[str, Any] = {}
    if browser_url:
        try:
            response = http_get(browser_url, timeout=10)
            headers = {str(key).lower(): str(value) for key, value in response.headers.items()}
            response_summary = {
                "status_code": response.status_code,
                "content_type": headers.get("content-type"),
                "content_disposition": headers.get("content-disposition"),
                "content_security_policy": headers.get("content-security-policy"),
                "x_content_type_options": headers.get("x-content-type-options"),
            }
            if response.status_code != 200:
                failures.append(
                    f"displayed SVG browser URL returned HTTP {response.status_code}"
                )
            if not headers.get("content-type", "").startswith("image/svg+xml"):
                failures.append("displayed SVG browser response had the wrong Content-Type")
            if not headers.get("content-disposition", "").startswith("inline;"):
                failures.append("displayed SVG browser response was not inline")
            if headers.get("x-content-type-options") != "nosniff":
                failures.append("displayed SVG browser response omitted nosniff")
            csp = headers.get("content-security-policy", "")
            if "script-src 'none'" not in csp or "img-src data:" not in csp:
                failures.append("displayed SVG browser response omitted the restrictive CSP")
            response_text = response.text
            missing_markers = [
                marker for marker in expected_content_markers if marker not in response_text
            ]
            if missing_markers:
                failures.append(
                    "displayed SVG browser response was missing expected marker(s): "
                    f"{missing_markers}"
                )
        except Exception as error:
            failures.append(f"displayed SVG browser URL could not be fetched: {error}")

    return failures, records, response_summary


def _validate_perfect_run(
    *,
    chat_id: str,
    completion: dict[str, Any],
    request_details: list[dict[str, Any]],
    active_capabilities: dict[str, Any],
    expected_workspace_file: str | None = None,
    expected_file_markers: tuple[str, ...] = (),
    expected_inline_display_file: str | None = None,
    expected_inline_display_markers: tuple[str, ...] = (),
    workspace_file_http_get=httpx.get,
    require_code_execution_skill: bool = True,
) -> dict[str, Any]:
    assistant_html = completion.get("content", "")
    tool_calls = _parse_tool_calls(assistant_html)
    tool_names = [call["name"] for call in tool_calls]
    pseudo_tool_call_text = _detect_pseudo_tool_call_text(assistant_html)
    tool_batch_count = _count_tool_call_batches(completion.get("content_blocks", []))
    agent_vm_calls = [
        call for call in tool_calls if isinstance(call.get("name"), str) and call["name"].startswith("agent_vm_")
    ]
    agent_vm_bash_command_counts = Counter(
        arguments.get("command", "").strip()
        for call in agent_vm_calls
        for arguments in [call.get("arguments")]
        if call.get("name") == "agent_vm_bash"
        and isinstance(arguments, dict)
        and arguments.get("command")
    )
    repeated_bash_commands = sorted(
        command
        for command, count in agent_vm_bash_command_counts.items()
        if count > 1
    )

    chat_skills = _redis_json_get(f"chat_skills:{chat_id}") or []
    capability_skills = {
        str(skill.get("name") or skill.get("display_name") or "").strip()
        for skill in active_capabilities.get("skills", [])
        if isinstance(skill, dict)
    }

    perfect = True
    failures: list[str] = []
    expected_request_count = tool_batch_count + 1

    if require_code_execution_skill and "skills_activate_skill" in tool_names:
        perfect = False
        failures.append("skills_activate_skill was called even though code-execution should auto-activate before the first request")
    if require_code_execution_skill and "code-execution" not in chat_skills:
        perfect = False
        failures.append("code-execution was not activated for the chat")
    if not agent_vm_calls:
        perfect = False
        failures.append("expected at least one Agent VM tool call")
    if pseudo_tool_call_text and not tool_calls:
        perfect = False
        failures.append(
            "assistant emitted pseudo tool-call text without native tool_calls: "
            f"{pseudo_tool_call_text}"
        )
    if any(
        not isinstance(call.get("result"), dict) or call["result"].get("error")
        for call in agent_vm_calls
    ):
        perfect = False
        failures.append("one or more Agent VM tool calls surfaced an error")
    if repeated_bash_commands:
        perfect = False
        failures.append(
            "agent_vm_bash repeated the exact same command: "
            f"{repeated_bash_commands}"
        )

    if len(request_details) != expected_request_count:
        perfect = False
        failures.append(
            "main request count did not match one-request-per-tool-batch contract: "
            f"expected {expected_request_count}, saw {len(request_details)}"
        )

    if not request_details:
        perfect = False
        failures.append("llm-debug-monitor did not capture any main requests for the chat")
    else:
        initial_request = request_details[0]
        if initial_request.get("request_phase") not in (None, "initial"):
            perfect = False
            failures.append(
                f"expected the first main request to be initial, saw {initial_request.get('request_phase')}"
            )
        if CONTINUATION_SYSTEM_MESSAGE_FRAGMENT in _request_system_text(initial_request):
            perfect = False
            failures.append("the initial request still contained the banned continuation system text")
        if not any(
            tool_name.startswith("agent_vm_")
            for tool_name in _request_tool_names(initial_request)
        ):
            perfect = False
            failures.append("the initial request did not expose Agent VM tools")
        if "server:agent-vm" not in (initial_request.get("tool_ids") or []):
            perfect = False
            failures.append("the initial request did not include server:agent-vm in tool_ids")
        if (
            require_code_execution_skill
            and "code-execution" not in _extract_activated_skill_names_from_request(initial_request)
        ):
            perfect = False
            failures.append("the initial request did not include the activated code-execution skill instructions")

    followups = [
        request for request in request_details if request.get("request_phase") == "tool_followup"
    ]
    if tool_batch_count > 0 and not followups:
        perfect = False
        failures.append("expected tool_followup requests after Agent VM tool batches")
    if any(
        CONTINUATION_SYSTEM_MESSAGE_FRAGMENT in _request_system_text(request)
        for request in request_details
    ):
        perfect = False
        failures.append("one or more requests still contained the banned continuation system text")
    if require_code_execution_skill and followups and any(
        "code-execution" not in _extract_activated_skill_names_from_request(request)
        for request in followups
    ):
        perfect = False
        failures.append("one or more tool_followup requests were missing the activated code-execution skill block")

    if require_code_execution_skill and "code-execution" not in capability_skills:
        perfect = False
        failures.append("active capabilities never surfaced the code-execution skill for the chat")

    workspace_files: list[str] = []
    if expected_workspace_file:
        matching_files = _find_workspace_files(chat_id, expected_workspace_file)
        workspace_files = [str(path) for path in matching_files]
        if not matching_files:
            perfect = False
            failures.append(
                f"expected workspace file {expected_workspace_file!r} was not created"
            )
        else:
            file_text = matching_files[0].read_text(errors="replace")
            missing_markers = [
                marker for marker in expected_file_markers if marker not in file_text
            ]
            if missing_markers:
                perfect = False
                failures.append(
                    "workspace file was missing expected marker(s): "
                    f"{missing_markers}"
                )

    display_file_records: list[dict[str, Any]] = []
    display_file_response: dict[str, Any] = {}
    if expected_inline_display_file:
        display_failures, display_file_records, display_file_response = (
            _validate_inline_display_file(
                tool_calls,
                expected_inline_display_file,
                expected_content_markers=expected_inline_display_markers,
                http_get=workspace_file_http_get,
            )
        )
        if display_failures:
            perfect = False
            failures.extend(display_failures)

    return {
        "perfect": perfect,
        "failures": failures,
        "tool_names": tool_names,
        "tool_calls": tool_calls,
        "pseudo_tool_call_text": pseudo_tool_call_text,
        "tool_batch_count": tool_batch_count,
        "chat_skills": chat_skills,
        "request_ids": [request.get("request_id") for request in request_details],
        "request_phases": [request.get("request_phase") for request in request_details],
        "repeated_agent_vm_bash_commands": repeated_bash_commands,
        "workspace_files": workspace_files,
        "display_file_records": display_file_records,
        "display_file_response": display_file_response,
        "active_capabilities": active_capabilities,
    }


def run_once(
    client: OWUIClient,
    prompt: str,
    model: str,
    timeout_seconds: int,
    expected_workspace_file: str | None = None,
    expected_file_markers: tuple[str, ...] = (),
    expected_inline_display_file: str | None = None,
    expected_inline_display_markers: tuple[str, ...] = (),
    require_code_execution_skill: bool = True,
) -> dict[str, Any]:
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
        chat_id=chat_id,
        completion=completion,
        request_details=request_details,
        active_capabilities=active_capabilities,
        expected_workspace_file=expected_workspace_file,
        expected_file_markers=expected_file_markers,
        expected_inline_display_file=expected_inline_display_file,
        expected_inline_display_markers=expected_inline_display_markers,
        require_code_execution_skill=require_code_execution_skill,
    )
    verdict["chat_id"] = chat_id
    return verdict


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scenario", choices=SCENARIOS, default="primes")
    parser.add_argument("--runs", type=int, default=TARGET_STREAK)
    parser.add_argument("--max-attempts", type=int, default=10)
    parser.add_argument("--prompt", default=None)
    parser.add_argument("--model", default=None)
    parser.add_argument("--timeout-seconds", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    args = parser.parse_args()
    prompt = args.prompt or _default_prompt_for_scenario(args.scenario)
    model = args.model or _default_model_for_scenario(args.scenario)
    expected_workspace_file = (
        MARKDOWN_FILE_NAME
        if args.scenario == "markdown-file"
        else None
    )
    expected_file_markers = (
        MARKDOWN_FILE_MARKERS
        if args.scenario == "markdown-file"
        else SVG_FILE_MARKERS if args.scenario == "svg-display" else ()
    )
    expected_inline_display_file = (
        SVG_FILE_NAME if args.scenario == "svg-display" else None
    )
    expected_inline_display_markers = (
        SVG_FILE_MARKERS if args.scenario == "svg-display" else ()
    )
    require_code_execution_skill = args.scenario not in {"markdown-file", "svg-display"}

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
            run = run_once(
                client,
                prompt,
                model,
                args.timeout_seconds,
                expected_workspace_file=expected_workspace_file,
                expected_file_markers=expected_file_markers,
                expected_inline_display_file=expected_inline_display_file,
                expected_inline_display_markers=expected_inline_display_markers,
                require_code_execution_skill=require_code_execution_skill,
            )
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
