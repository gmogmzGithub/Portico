#!/usr/bin/env python3
"""
Run a real headless Open WebUI chat repeatedly and verify the Google Workspace flow.

This script enforces the requested precondition before each run:
1. google_workspace is toggled off
2. its runtime container is not running
3. the readiness API reports disabled or the aggregator stops reporting the server

It then creates a fresh chat, sends the prompt, waits for completion, and validates:
- the first tool call is toggle_integration
- toggle_integration finishes within the response SLA and does not surface a raw disconnect
- no authorize_integration call is needed
- activate_integration happens in the same turn before the first Google tool call
- google-workspace skill auto-activates for the chat
- one or more google_workspace_get_events calls succeed in the same turn
- no synthetic tool-loop guard text is emitted
- no core MCP tool result overflows to a file
- agent_vm_bash does not repeat the exact same command in a loop
"""

from __future__ import annotations

import argparse
import html
import importlib.util
import json
import os
import re
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any

import httpx

REPO_ROOT = Path(__file__).resolve().parents[2]
API_CLIENT_PATH = REPO_ROOT / "tests" / "integration" / "framework" / "utils" / "api_client.py"
API_CLIENT_SPEC = importlib.util.spec_from_file_location(
    "owui_api_client", API_CLIENT_PATH
)
if API_CLIENT_SPEC is None or API_CLIENT_SPEC.loader is None:
    raise RuntimeError(f"Failed to load OWUI API client from {API_CLIENT_PATH}")
API_CLIENT_MODULE = importlib.util.module_from_spec(API_CLIENT_SPEC)
API_CLIENT_SPEC.loader.exec_module(API_CLIENT_MODULE)
OWUIClient = API_CLIENT_MODULE.OWUIClient


PROMPT = (
    "Check my Google Workspace calendar for my most important meetings this week. "
    "If Google Workspace is not active in this chat yet, first call "
    "mcp_assistant_toggle_integration for server_id='google_workspace' with enabled=true, "
    "then call mcp_assistant_activate_integration for server_id='google_workspace'. "
    "Do not call google_workspace_get_events until activation succeeds, and do not call "
    "mcp_assistant_authorize_integration unless a tool result explicitly says OAuth is required. "
    "After google_workspace_get_events succeeds, answer from that result without calling more tools."
)
NONINTERACTIVE_PROMPT = (
    "Call google_workspace_get_events once to check my most important meetings this week, "
    "then answer from that result without calling more tools."
)
NONINTERACTIVE_TOOL_IDS = ["server:google_workspace"]
INTEGRATION_LIFECYCLE_TOOL_NAMES = frozenset(
    {
        "mcp_assistant_toggle_integration",
        "mcp_assistant_activate_integration",
        "mcp_assistant_authorize_integration",
    }
)
MODEL = "Claude Sonnet 4.6"
SERVER_ID = "google_workspace"
TOGGLE_URL = os.getenv("ELECTRON_API_BASE", "http://127.0.0.1:9876")
READINESS_URL = f"{TOGGLE_URL}/api/server-readiness/{SERVER_ID}"
TOGGLE_API_URL = f"{TOGGLE_URL}/api/toggle-mcp-server"
SUMMARY_URL = os.getenv("MCPO_SUMMARY_BASE", "http://127.0.0.1:8765") + "/servers/summary"
DEBUG_MONITOR_BASE_URL = os.getenv(
    "LLM_DEBUG_MONITOR_BASE_URL", "http://127.0.0.1:8879"
).rstrip("/")
DEBUG_MONITOR_TOKEN = (
    os.getenv("DEBUG_MONITOR_TOKEN")
    or os.getenv("LLM_DEBUG_MONITOR_TOKEN")
    or os.getenv("BIFROST_BRIDGE_LOCAL_API_KEY")
    or os.getenv("LOCAL_STACK_API_KEY")
)
DEBUG_MONITOR_TOKEN_ENV_KEYS = (
    "DEBUG_MONITOR_TOKEN",
    "LLM_DEBUG_MONITOR_TOKEN",
    "BIFROST_BRIDGE_LOCAL_API_KEY",
    "LOCAL_STACK_API_KEY",
)
DEBUG_MONITOR_TOKEN_FILE_ENV_KEYS = (
    "DEBUG_MONITOR_TOKEN_FILE",
    "LLM_DEBUG_MONITOR_TOKEN_FILE",
    "BIFROST_BRIDGE_LOCAL_API_KEY_FILE",
    "LOCAL_STACK_API_KEY_FILE",
)
REDIS_CONTAINER = os.getenv("REDIS_CONTAINER_NAME", "portico-redis")
TARGET_STREAK = 10
PRECONDITION_TIMEOUT_SECONDS = 90
DEBUG_MONITOR_TIMEOUT_SECONDS = 45
DEBUG_MONITOR_SETTLE_POLLS = 2
CORE_TOOL_PREFIXES = (
    "agent_vm_",
    "artifacts_",
    "skills_",
    "mcp_assistant_",
    "subagents_",
)
CONTINUATION_SYSTEM_MESSAGE_FRAGMENT = (
    "Internal tool follow-up for the same assistant turn."
)


def _docker_json(cmd: list[str]) -> Any:
    output = subprocess.check_output(cmd, text=True)
    return json.loads(output)


def _docker_text(cmd: list[str]) -> str:
    return subprocess.check_output(cmd, text=True).strip()


def _detect_openwebui_base_url() -> str:
    configured = os.getenv("OPENWEBUI_BASE_URL")
    if configured:
        return configured

    deadline = time.time() + PRECONDITION_TIMEOUT_SECONDS
    last_error: Exception | None = None

    while time.time() < deadline:
        try:
            ports = _docker_json(
                ["docker", "inspect", "portico-open-webui", "--format", "{{json .NetworkSettings.Ports}}"]
            )
            bindings = ports.get("8080/tcp") or []
            if bindings:
                host_port = bindings[0]["HostPort"]
                return f"http://127.0.0.1:{host_port}"
        except Exception as exc:
            last_error = exc

        time.sleep(2)

    raise RuntimeError(
        "Could not detect published Open WebUI port for portico-open-webui "
        f"within {PRECONDITION_TIMEOUT_SECONDS}s: {last_error}"
    )


def _container_running(name: str) -> bool:
    result = subprocess.check_output(
        ["docker", "ps", "--format", "{{.Names}}"], text=True
    ).splitlines()
    return name in result


def _restart_counts() -> dict[str, int]:
    counts = {}
    for name in ["portico-open-webui", "mcpo", "mcpo-group-core"]:
        counts[name] = int(
            _docker_text(["docker", "inspect", name, "--format", "{{.RestartCount}}"])
        )
    return counts


def _redis_json_get(key: str) -> Any:
    raw = _docker_text(
        ["docker", "exec", REDIS_CONTAINER, "redis-cli", "--raw", "GET", key]
    )
    if not raw or raw == "(nil)":
        return None
    return json.loads(raw)


def _decode_embedded_json(value: str | None) -> Any:
    if not value:
        return None
    text = html.unescape(value)
    try:
        decoded = json.loads(text)
    except json.JSONDecodeError:
        return text
    if isinstance(decoded, str):
        try:
            return json.loads(decoded)
        except json.JSONDecodeError:
            return decoded
    return decoded


def _parse_tool_calls(content: str) -> list[dict[str, Any]]:
    tool_calls: list[dict[str, Any]] = []
    for attrs_blob in re.findall(r'<details\s+type="tool_calls"\s+([^>]*)>', content or ""):
        attrs = {
            key: value
            for key, value in re.findall(r'([a-zA-Z_]+)="([^"]*)"', attrs_blob)
        }
        name = html.unescape(attrs.get("name", ""))
        duration_raw = attrs.get("duration", "0")
        try:
            duration = float(duration_raw)
        except ValueError:
            duration = 0.0
        tool_calls.append(
            {
                "name": name,
                "duration_seconds": duration,
                "arguments": _decode_embedded_json(attrs.get("arguments")),
                "result": _decode_embedded_json(attrs.get("result")),
            }
        )
    return tool_calls


def _fetch_readiness() -> dict[str, Any]:
    return httpx.get(READINESS_URL, timeout=10).json()


def _fetch_summary() -> list[dict[str, Any]]:
    response = httpx.get(SUMMARY_URL, timeout=10)
    response.raise_for_status()
    payload = response.json()
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        if isinstance(payload.get("servers"), list):
            return payload["servers"]
        if isinstance(payload.get("data"), list):
            return payload["data"]
    return []


def _server_reported_tool_ready() -> bool:
    readiness = _fetch_readiness()
    phase = readiness.get("readinessPhase") or readiness.get("readiness_phase")
    if phase != "tool_ready":
        return False
    summary = _fetch_summary()
    return any(
        isinstance(server, dict)
        and (
            server.get("server_id") == SERVER_ID or server.get("id") == SERVER_ID
        )
        for server in summary
    )


def ensure_enabled_precondition() -> None:
    response = httpx.post(
        TOGGLE_API_URL,
        json={"server_id": SERVER_ID, "enabled": True},
        timeout=90,
    )
    response.raise_for_status()
    deadline = time.time() + PRECONDITION_TIMEOUT_SECONDS
    while time.time() < deadline:
        readiness = _fetch_readiness()
        readiness_phase = readiness.get("readinessPhase") or readiness.get("readiness_phase")
        if (
            _container_running("mcpo-google_workspace")
            and readiness_phase == "tool_ready"
            and _server_reported_tool_ready()
        ):
            return
        time.sleep(1)
    raise RuntimeError(
        "google_workspace did not reach the enabled tool_ready precondition "
        f"within {PRECONDITION_TIMEOUT_SECONDS}s"
    )


def ensure_noninteractive_precondition() -> None:
    """Require an already-ready server without toggling or starting OAuth."""
    if _server_reported_tool_ready():
        return
    readiness = _fetch_readiness()
    phase = readiness.get("readinessPhase") or readiness.get("readiness_phase")
    raise RuntimeError(
        "google_workspace is not already tool_ready for the noninteractive live test "
        f"(readiness_phase={phase!r}); refusing to toggle or authorize it"
    )


def _server_reported_disabled_or_absent() -> bool:
    summary = _fetch_summary()
    matching = [
        server
        for server in summary
        if isinstance(server, dict)
        and (
            server.get("server_id") == SERVER_ID or server.get("id") == SERVER_ID
        )
    ]
    if not matching:
        return True

    for server in matching:
        phase = (
            server.get("readiness_phase")
            or server.get("readinessPhase")
            or server.get("status")
        )
        if phase == "disabled" or server.get("enabled") is False:
            return True
    return False


def ensure_disabled_precondition() -> None:
    response = httpx.post(
        TOGGLE_API_URL,
        json={"server_id": SERVER_ID, "enabled": False},
        timeout=90,
    )
    response.raise_for_status()
    deadline = time.time() + PRECONDITION_TIMEOUT_SECONDS
    while time.time() < deadline:
        readiness = _fetch_readiness()
        readiness_phase = readiness.get("readinessPhase") or readiness.get("readiness_phase")
        if (
            not _container_running("mcpo-google_workspace")
            and readiness_phase == "disabled"
            and _server_reported_disabled_or_absent()
        ):
            return
        time.sleep(1)
    raise RuntimeError(
        "google_workspace did not reach the disabled precondition "
        f"within {PRECONDITION_TIMEOUT_SECONDS}s"
    )


def ensure_debug_monitor_healthy(timeout_seconds: int = PRECONDITION_TIMEOUT_SECONDS) -> None:
    deadline = time.time() + timeout_seconds
    last_error: Exception | None = None
    while time.time() < deadline:
        try:
            response = httpx.get(
                f"{DEBUG_MONITOR_BASE_URL}/api/health", timeout=10
            )
            response.raise_for_status()
            payload = response.json()
            if payload.get("status") == "healthy":
                return
        except Exception as exc:  # pragma: no cover - exercised in live runs
            last_error = exc
        time.sleep(1)
    raise RuntimeError(
        f"llm-debug-monitor did not become healthy at {DEBUG_MONITOR_BASE_URL}: {last_error}"
    )


def _parse_env_assignment(line: str, key: str) -> str | None:
    prefix = f"{key}="
    if not line.startswith(prefix):
        return None
    value = line[len(prefix):].strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        value = value[1:-1]
    return value or None


def _read_debug_monitor_token_from_env_files() -> str | None:
    for env_path in (REPO_ROOT / ".env", REPO_ROOT / ".env.local"):
        if not env_path.exists():
            continue
        try:
            lines = env_path.read_text().splitlines()
        except OSError:
            continue
        for key in DEBUG_MONITOR_TOKEN_ENV_KEYS:
            for line in lines:
                token = _parse_env_assignment(line.strip(), key)
                if token:
                    return token
    return None


def _read_debug_monitor_token_from_container() -> str | None:
    try:
        result = subprocess.run(
            [
                "docker",
                "inspect",
                "llm-debug-monitor",
                "--format",
                "{{range .Config.Env}}{{println .}}{{end}}",
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except Exception:
        return None
    lines = result.stdout.splitlines()
    for key in DEBUG_MONITOR_TOKEN_ENV_KEYS:
        for line in lines:
            token = _parse_env_assignment(line.strip(), key)
            if token:
                return token
    for key in DEBUG_MONITOR_TOKEN_FILE_ENV_KEYS:
        for line in lines:
            token_file = _parse_env_assignment(line.strip(), key)
            if not token_file:
                continue
            try:
                file_result = subprocess.run(
                    [
                        "docker",
                        "exec",
                        "llm-debug-monitor",
                        "sh",
                        "-lc",
                        'cat "$1"',
                        "sh",
                        token_file,
                    ],
                    check=True,
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
            except Exception:
                continue
            token = file_result.stdout.strip()
            if token:
                return token
    return None


def ensure_debug_monitor_token() -> str | None:
    global DEBUG_MONITOR_TOKEN
    if DEBUG_MONITOR_TOKEN:
        return DEBUG_MONITOR_TOKEN

    for resolver in (
        _read_debug_monitor_token_from_container,
        _read_debug_monitor_token_from_env_files,
    ):
        token = resolver()
        if token:
            DEBUG_MONITOR_TOKEN = token
            return token
    return None


def _debug_monitor_headers() -> dict[str, str]:
    token = ensure_debug_monitor_token()
    if not token:
        return {}
    return {"X-Debug-Monitor-Token": token}


def _get_chat_active_capabilities(client: OWUIClient, chat_id: str) -> dict[str, Any]:
    response = client.client.get(f"/api/v1/chats/{chat_id}/active-capabilities")
    response.raise_for_status()
    payload = response.json()
    return payload if isinstance(payload, dict) else {"tools": [], "skills": []}


def _fetch_chat_request_summaries(chat_id: str) -> list[dict[str, Any]]:
    response = httpx.get(
        f"{DEBUG_MONITOR_BASE_URL}/api/chats/{chat_id}/requests",
        params={"limit": 200, "offset": 0},
        headers=_debug_monitor_headers(),
        timeout=15,
    )
    response.raise_for_status()
    payload = response.json()
    requests = payload.get("requests")
    return requests if isinstance(requests, list) else []


def _fetch_request_detail(request_id: str) -> dict[str, Any]:
    response = httpx.get(
        f"{DEBUG_MONITOR_BASE_URL}/api/requests/{request_id}",
        headers=_debug_monitor_headers(),
        timeout=15,
    )
    response.raise_for_status()
    payload = response.json()
    request = payload.get("request")
    if not isinstance(request, dict):
        raise RuntimeError(f"Debug monitor request {request_id} did not return a request payload")
    return request


def _main_request_summaries(
    requests: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    return [
        request
        for request in requests
        if isinstance(request, dict) and not request.get("is_auxiliary")
    ]


def _merged_request_detail(
    summary: dict[str, Any], detail: dict[str, Any]
) -> dict[str, Any]:
    merged = dict(detail)
    for key, value in summary.items():
        if key not in merged or merged.get(key) in (None, [], "", {}):
            merged[key] = value
    return merged


def _wait_for_main_request_details(
    chat_id: str,
    expected_main_request_count: int,
    timeout_seconds: int = DEBUG_MONITOR_TIMEOUT_SECONDS,
    settle_polls: int = DEBUG_MONITOR_SETTLE_POLLS,
) -> list[dict[str, Any]]:
    deadline = time.time() + timeout_seconds
    stable_polls = 0
    last_request_ids: tuple[str, ...] | None = None
    latest_main_requests: list[dict[str, Any]] = []

    while time.time() < deadline:
        summaries = _main_request_summaries(_fetch_chat_request_summaries(chat_id))
        latest_main_requests = summaries
        request_ids = tuple(
            str(summary.get("request_id") or "")
            for summary in summaries
            if summary.get("request_id")
        )
        all_terminal = all(
            str(summary.get("status") or "") in {"complete", "error"} for summary in summaries
        )
        if len(summaries) >= expected_main_request_count and all_terminal:
            if request_ids == last_request_ids:
                stable_polls += 1
            else:
                last_request_ids = request_ids
                stable_polls = 1
            if stable_polls >= settle_polls:
                return [
                    _merged_request_detail(summary, _fetch_request_detail(summary["request_id"]))
                    for summary in summaries
                ]
        time.sleep(1)

    raise RuntimeError(
        "Timed out waiting for llm-debug-monitor main requests to settle for "
        f"chat {chat_id}. Expected at least {expected_main_request_count}, "
        f"saw {len(latest_main_requests)}."
    )


def _stringify_message_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""

    parts: list[str] = []
    for item in content:
        if isinstance(item, str):
            parts.append(item)
            continue
        if not isinstance(item, dict):
            continue
        for key in ("text", "content", "input_text", "output_text"):
            value = item.get(key)
            if isinstance(value, str) and value.strip():
                parts.append(value)
                break
    return "\n".join(parts)


def _request_messages(request_detail: dict[str, Any]) -> list[dict[str, Any]]:
    messages = request_detail.get("messages")
    if isinstance(messages, list):
        return [message for message in messages if isinstance(message, dict)]
    return []


def _request_system_text(request_detail: dict[str, Any]) -> str:
    return "\n".join(
        _stringify_message_content(message.get("content"))
        for message in _request_messages(request_detail)
        if message.get("role") == "system"
    )


def _request_system_messages(request_detail: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        message
        for message in _request_messages(request_detail)
        if message.get("role") == "system"
    ]


def _request_assistant_texts(request_detail: dict[str, Any]) -> list[str]:
    return [
        _stringify_message_content(message.get("content"))
        for message in _request_messages(request_detail)
        if message.get("role") == "assistant"
    ]


def _request_tool_names(request_detail: dict[str, Any]) -> list[str]:
    names: list[str] = []
    for tool in request_detail.get("tools") or []:
        if not isinstance(tool, dict):
            continue
        function = tool.get("function")
        if isinstance(function, dict):
            name = function.get("name")
            if isinstance(name, str) and name:
                names.append(name)
    return names


def _extract_enabled_servers_from_request(request_detail: dict[str, Any]) -> list[str]:
    system_text = _request_system_text(request_detail)
    if not system_text:
        return []
    matches = re.findall(
        r"<tool_servers>.*?<enabled>(.*?)</enabled>.*?</tool_servers>",
        system_text,
        flags=re.DOTALL,
    )
    servers: list[str] = []
    for block in matches:
        servers.extend(
            server.strip()
            for server in re.findall(r"<server>\s*([^<]+?)\s*</server>", block)
            if server.strip()
        )
    return servers


def _extract_activated_skill_names_from_request(
    request_detail: dict[str, Any]
) -> list[str]:
    system_text = _request_system_text(request_detail)
    if not system_text:
        return []
    return [
        match.strip()
        for match in re.findall(
            r'<activated_skill name="([^"]+)"',
            system_text,
        )
        if match.strip()
    ]


def _count_tool_call_batches(content_blocks: Any) -> int:
    if not isinstance(content_blocks, list):
        return 0
    return sum(
        1
        for block in content_blocks
        if isinstance(block, dict) and block.get("type") == "tool_calls"
    )


def _validate_google_workspace_request_fidelity(
    *,
    tool_batch_count: int,
    request_details: list[dict[str, Any]],
    active_capabilities: dict[str, Any],
) -> list[str]:
    failures: list[str] = []
    expected_request_count = tool_batch_count + 1
    if len(request_details) != expected_request_count:
        failures.append(
            "main request count did not match one-request-per-tool-batch contract: "
            f"expected {expected_request_count}, saw {len(request_details)}"
        )

    if any(
        CONTINUATION_SYSTEM_MESSAGE_FRAGMENT in _request_system_text(request)
        for request in request_details
    ):
        failures.append("one or more requests still contained the banned follow-up continuation system text")

    followups = [
        request
        for request in request_details
        if request.get("request_phase") == "tool_followup"
    ]
    if not followups:
        failures.append("expected at least one tool_followup request in llm-debug-monitor")

    if not any(
        "google_workspace_get_events" in _request_tool_names(request)
        for request in followups
    ):
        failures.append("no tool_followup request exposed google_workspace_get_events in its tool payload")

    if not any(
        "server:google_workspace" in _extract_enabled_servers_from_request(request)
        for request in followups
    ):
        failures.append("no tool_followup request advertised server:google_workspace in <tool_servers><enabled>")

    if not any(
        "google-workspace" in _extract_activated_skill_names_from_request(request)
        for request in request_details
    ):
        failures.append("no request contained the activated google-workspace skill block")

    for request in request_details:
        request_id = str(request.get("request_id") or "unknown-request")
        messages = _request_messages(request)
        if len(messages) < 4:
            failures.append(
                f"{request_id} did not include the expected 3-system-message prefix and user/assistant history"
            )

        if [message.get("role") for message in messages[:3]] != [
            "system",
            "system",
            "system",
        ]:
            failures.append(
                f"{request_id} did not preserve the expected 3 leading system messages"
            )

        system_messages = _request_system_messages(request)
        if any(
            message.get("role") == "user"
            and "<dynamic_context>" in _stringify_message_content(message.get("content"))
            for message in messages
        ):
            failures.append(
                f"{request_id} still carried <dynamic_context> as a user message"
            )

        if system_messages:
            leading_system_text = _stringify_message_content(system_messages[0].get("content"))
            if "<static_context>" in leading_system_text and "<dynamic_context>" in leading_system_text:
                failures.append(
                    f"{request_id} merged static and dynamic context into a single leading system message"
                )

        if len(system_messages) != 3:
            failures.append(
                f"{request_id} did not keep exactly 3 system messages (saw {len(system_messages)})"
            )
            continue

        system_0_text = _stringify_message_content(system_messages[0].get("content"))
        system_1_text = _stringify_message_content(system_messages[1].get("content"))
        system_2_text = _stringify_message_content(system_messages[2].get("content"))

        if "<static_context>" in system_0_text or "<dynamic_context>" in system_0_text:
            failures.append(
                f"{request_id} merged static/dynamic context into system message 0"
            )
        if "<static_context>" not in system_1_text:
            failures.append(f"{request_id} was missing <static_context> in system message 1")
        if "<dynamic_context>" in system_1_text:
            failures.append(
                f"{request_id} incorrectly merged <dynamic_context> into system message 1"
            )
        if "<dynamic_context>" not in system_2_text:
            failures.append(f"{request_id} was missing <dynamic_context> in system message 2")

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
    if "google_workspace" not in capability_servers:
        failures.append("active capabilities never surfaced google_workspace for the chat")
    if "google-workspace" not in capability_skills:
        failures.append("active capabilities never surfaced the google-workspace skill for the chat")

    return failures


def _validate_perfect_run(
    chat_id: str,
    assistant_html: str,
    *,
    content_blocks: list[dict[str, Any]] | None = None,
    request_details: list[dict[str, Any]] | None = None,
    active_capabilities: dict[str, Any] | None = None,
) -> dict[str, Any]:
    tool_calls = _parse_tool_calls(assistant_html)
    tool_names = [call["name"] for call in tool_calls]
    tool_durations = [call["duration_seconds"] for call in tool_calls]

    first_google_index = next(
        (index for index, name in enumerate(tool_names) if name.startswith("google_workspace_")),
        None,
    )
    get_events_calls = [
        call for call in tool_calls if call["name"] == "google_workspace_get_events"
    ]
    toggle_calls = [
        call for call in tool_calls if call["name"] == "mcp_assistant_toggle_integration"
    ]
    activate_calls = [
        call for call in tool_calls if call["name"] == "mcp_assistant_activate_integration"
    ]

    chat_skills = _redis_json_get(f"chat_skills:{chat_id}") or []
    chat_tools = _redis_json_get(f"chat_tools:{chat_id}") or []

    get_events_result = get_events_calls[0]["result"] if get_events_calls else None
    toggle_result = toggle_calls[0]["result"] if toggle_calls else None
    activate_result = activate_calls[0]["result"] if activate_calls else None
    core_tool_overflow_calls = [
        call["name"]
        for call in tool_calls
        if call["name"].startswith(CORE_TOOL_PREFIXES)
        and isinstance(call.get("result"), dict)
        and call["result"].get("overflow_file") is True
    ]
    agent_vm_bash_command_counts = Counter(
        arguments.get("command", "").strip()
        for call in tool_calls
        if call["name"] == "agent_vm_bash"
        for arguments in [call.get("arguments")]
        if isinstance(arguments, dict) and arguments.get("command")
    )
    repeated_agent_vm_bash_commands = sorted(
        command
        for command, count in agent_vm_bash_command_counts.items()
        if count > 1
    )

    perfect = True
    failures: list[str] = []

    if not tool_names or tool_names[0] != "mcp_assistant_toggle_integration":
        perfect = False
        failures.append("the first tool call was not toggle_integration")
    if len(toggle_calls) != 1:
        perfect = False
        failures.append(f"expected exactly one toggle_integration call, saw {len(toggle_calls)}")
    if toggle_calls and toggle_calls[0]["duration_seconds"] >= 15:
        perfect = False
        failures.append(
            f"toggle_integration took {toggle_calls[0]['duration_seconds']:.1f}s (expected < 15s)"
        )
    if not isinstance(toggle_result, dict) or toggle_result.get("error"):
        perfect = False
        failures.append("toggle_integration surfaced a raw error instead of a success payload")
    if "mcp_assistant_authorize_integration" in tool_names:
        perfect = False
        failures.append("authorize_integration was called even though tokens already exist")
    if len(activate_calls) != 1:
        perfect = False
        failures.append(
            f"expected exactly one activate_integration call, saw {len(activate_calls)}"
        )
    if tool_names[:3] != [
        "mcp_assistant_toggle_integration",
        "mcp_assistant_activate_integration",
        "google_workspace_get_events",
    ]:
        perfect = False
        failures.append(
            f"unexpected initial tool sequence: {tool_names[:3]}"
        )
    if "google-workspace" not in chat_skills:
        perfect = False
        failures.append("google-workspace skill was not auto-activated")
    if first_google_index != 2:
        perfect = False
        failures.append("google_workspace_get_events was not the third tool call")
    if not get_events_calls:
        perfect = False
        failures.append(
            "expected at least one google_workspace_get_events call"
        )
    if "server:google_workspace" not in chat_tools:
        perfect = False
        failures.append("server:google_workspace was not activated for the chat")
    if not isinstance(activate_result, dict) or not activate_result.get("success"):
        perfect = False
        failures.append("activate_integration did not succeed")
    if not isinstance(get_events_result, dict) or get_events_result.get("error"):
        perfect = False
        failures.append("the first google_workspace_get_events call did not succeed")
    if any(
        not isinstance(call.get("result"), dict) or call["result"].get("error")
        for call in get_events_calls
    ):
        perfect = False
        failures.append("one or more google_workspace_get_events calls surfaced an error")
    if "Tool loop stopped after repeated non-progressing calls to" in assistant_html:
        perfect = False
        failures.append("assistant emitted synthetic tool loop guard text")
    if (
        "The user sent a follow-up message" in assistant_html
        and "system context" in assistant_html
    ):
        perfect = False
        failures.append("assistant inferred a bogus follow-up/system-context reinjection")
    if core_tool_overflow_calls:
        perfect = False
        failures.append(
            f"core MCP tool results overflowed to files: {core_tool_overflow_calls}"
        )
    if repeated_agent_vm_bash_commands:
        perfect = False
        failures.append(
            "agent_vm_bash repeated the exact same command: "
            f"{repeated_agent_vm_bash_commands}"
        )
    tool_batch_count = _count_tool_call_batches(content_blocks)
    if request_details is not None and active_capabilities is not None:
        request_failures = _validate_google_workspace_request_fidelity(
            tool_batch_count=tool_batch_count,
            request_details=request_details,
            active_capabilities=active_capabilities,
        )
        if request_failures:
            perfect = False
            failures.extend(request_failures)

    return {
        "perfect": perfect,
        "failures": failures,
        "tool_names": tool_names,
        "tool_durations": tool_durations,
        "tool_calls": tool_calls,
        "tool_batch_count": tool_batch_count,
        "chat_skills": chat_skills,
        "chat_tools": chat_tools,
        "request_ids": [request.get("request_id") for request in request_details or []],
        "request_phases": [request.get("request_phase") for request in request_details or []],
        "core_tool_overflow_calls": core_tool_overflow_calls,
        "repeated_agent_vm_bash_commands": repeated_agent_vm_bash_commands,
    }


def _validate_noninteractive_run(
    chat_id: str,
    assistant_html: str,
    *,
    content_blocks: list[dict[str, Any]] | None = None,
    request_details: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    tool_calls = _parse_tool_calls(assistant_html)
    tool_names = [call["name"] for call in tool_calls]
    get_events_calls = [
        call for call in tool_calls if call["name"] == "google_workspace_get_events"
    ]
    failures: list[str] = []

    if not tool_names or tool_names[0] != "google_workspace_get_events":
        failures.append("the first tool call was not google_workspace_get_events")
    if len(get_events_calls) != 1:
        failures.append(
            f"expected exactly one google_workspace_get_events call, saw {len(get_events_calls)}"
        )
    if any(name in INTEGRATION_LIFECYCLE_TOOL_NAMES for name in tool_names):
        failures.append("the noninteractive run called an integration lifecycle tool")
    if any(
        not isinstance(call.get("result"), dict) or call["result"].get("error")
        for call in get_events_calls
    ):
        failures.append("google_workspace_get_events surfaced an error")
    if "Tool loop stopped after repeated non-progressing calls to" in assistant_html:
        failures.append("assistant emitted synthetic tool loop guard text")

    tool_batch_count = _count_tool_call_batches(content_blocks)
    if request_details is not None:
        expected_request_count = tool_batch_count + 1
        if len(request_details) != expected_request_count:
            failures.append(
                "main request count did not match one-request-per-tool-batch contract: "
                f"expected {expected_request_count}, saw {len(request_details)}"
            )
        advertised_tool_names = {
            name
            for request in request_details
            for name in _request_tool_names(request)
        }
        if "google_workspace_get_events" not in advertised_tool_names:
            failures.append("no request advertised google_workspace_get_events")
        if "mcp_assistant_authorize_integration" in advertised_tool_names:
            failures.append("authorize_integration was available in the noninteractive payload")
        if not any(
            "server:google_workspace" in _extract_enabled_servers_from_request(request)
            for request in request_details
        ):
            failures.append(
                "no request advertised server:google_workspace in <tool_servers><enabled>"
            )

    return {
        "perfect": not failures,
        "failures": failures,
        "tool_names": tool_names,
        "tool_durations": [call["duration_seconds"] for call in tool_calls],
        "tool_calls": tool_calls,
        "tool_batch_count": tool_batch_count,
        "chat_id": chat_id,
        "request_ids": [request.get("request_id") for request in request_details or []],
        "noninteractive": True,
    }


def run_once(
    client: OWUIClient,
    prompt: str,
    model: str,
    *,
    noninteractive: bool = False,
) -> dict[str, Any]:
    if noninteractive:
        ensure_noninteractive_precondition()
    else:
        ensure_disabled_precondition()

    created = client.create_chat(model=model, prompt=prompt)
    chat_id = created["chat_id"]
    user_message_id = created["user_message_id"]
    client.generate_completion(
        chat_id=chat_id,
        model=model,
        prompt=prompt,
        user_message_id=user_message_id,
        stream=True,
        tool_ids=NONINTERACTIVE_TOOL_IDS if noninteractive else None,
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

    request_details = _wait_for_main_request_details(
        chat_id,
        expected_main_request_count=_count_tool_call_batches(
            completion.get("content_blocks", [])
        )
        + 1,
    )
    active_capabilities = _get_chat_active_capabilities(client, chat_id)

    if noninteractive:
        verdict = _validate_noninteractive_run(
            chat_id,
            completion.get("content", ""),
            content_blocks=completion.get("content_blocks", []),
            request_details=request_details,
        )
    else:
        verdict = _validate_perfect_run(
            chat_id,
            completion.get("content", ""),
            content_blocks=completion.get("content_blocks", []),
            request_details=request_details,
            active_capabilities=active_capabilities,
        )
    verdict["chat_id"] = chat_id
    verdict["active_capabilities"] = active_capabilities
    return verdict


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=int, default=TARGET_STREAK)
    parser.add_argument("--max-attempts", type=int, default=20)
    parser.add_argument("--prompt")
    parser.add_argument("--model", default=MODEL)
    parser.add_argument(
        "--noninteractive",
        action="store_true",
        help=(
            "Require Google Workspace to be tool-ready and expose only its tool server; "
            "never toggle, activate, or authorize the integration"
        ),
    )
    args = parser.parse_args()
    prompt = args.prompt or (NONINTERACTIVE_PROMPT if args.noninteractive else PROMPT)

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
                args.model,
                noninteractive=args.noninteractive,
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
