#!/usr/bin/env python3
"""
Run a real headless Open WebUI chat and verify the first-turn Glean flow.

Precondition before each run:
1. glean is toggled on
2. its runtime container is running
3. the readiness API reports tool_ready

Validation:
- no toggle_integration call is needed
- no authorize_integration call is needed
- no activate_integration call is needed
- company-knowledge skill auto-activates for the chat
- the first tool call is already a Glean tool
- at least one glean_search call succeeds in the same turn
"""

from __future__ import annotations

import argparse
import html
import importlib.util
import json
import os
import re
import subprocess
import time
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


PROMPT = "What's going on at Portico this week?"
MODEL = "Atlas Sonnet 4.6"
SERVER_ID = "glean"
CONTAINER_NAME = "mcpo-glean"
TOGGLE_URL = os.getenv("ELECTRON_API_BASE", "http://127.0.0.1:9876")
READINESS_URL = f"{TOGGLE_URL}/api/server-readiness/{SERVER_ID}"
TOGGLE_API_URL = f"{TOGGLE_URL}/api/toggle-mcp-server"
SUMMARY_URL = os.getenv("MCPO_SUMMARY_BASE", "http://127.0.0.1:8765") + "/servers/summary"
REDIS_CONTAINER = os.getenv("REDIS_CONTAINER_NAME", "portico-redis")
TARGET_STREAK = 5
PRECONDITION_TIMEOUT_SECONDS = 90
COMPLETION_TIMEOUT_SECONDS = int(os.getenv("OWUI_COMPANY_KNOWLEDGE_TIMEOUT_SECONDS", "3600"))


def _docker_json(cmd: list[str]) -> Any:
    output = subprocess.check_output(cmd, text=True)
    return json.loads(output)


def _docker_text(cmd: list[str]) -> str:
    return subprocess.check_output(cmd, text=True).strip()


def _detect_openwebui_base_url() -> str:
    configured = os.getenv("OPENWEBUI_BASE_URL")
    if configured:
        return configured

    ports = _docker_json(
        ["docker", "inspect", "portico-open-webui", "--format", "{{json .NetworkSettings.Ports}}"]
    )
    bindings = ports.get("8080/tcp") or []
    if not bindings:
        raise RuntimeError("Could not detect published Open WebUI port for portico-open-webui")
    return f"http://127.0.0.1:{bindings[0]['HostPort']}"


def _container_running(name: str) -> bool:
    result = subprocess.check_output(
        ["docker", "ps", "--format", "{{.Names}}"], text=True
    ).splitlines()
    return name in result


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
        tool_calls.append(
            {
                "name": html.unescape(attrs.get("name", "")),
                "duration_seconds": float(attrs.get("duration", "0") or 0),
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
        if _container_running(CONTAINER_NAME) and _server_reported_tool_ready():
            return
        time.sleep(1)
    raise RuntimeError(
        f"{SERVER_ID} did not reach the enabled tool_ready precondition "
        f"within {PRECONDITION_TIMEOUT_SECONDS}s"
    )


def _validate_perfect_run(chat_id: str, assistant_html: str) -> dict[str, Any]:
    tool_calls = _parse_tool_calls(assistant_html)
    tool_names = [call["name"] for call in tool_calls]
    first_glean_index = next(
        (index for index, name in enumerate(tool_names) if name.startswith("glean_")),
        None,
    )
    glean_search_calls = [
        call for call in tool_calls if call["name"] == "glean_search"
    ]

    chat_skills = _redis_json_get(f"chat_skills:{chat_id}") or []
    chat_tools = _redis_json_get(f"chat_tools:{chat_id}") or []

    perfect = True
    failures: list[str] = []

    if "mcp_assistant_toggle_integration" in tool_names:
        perfect = False
        failures.append("toggle_integration was called even though the server started enabled")
    if "mcp_assistant_activate_integration" in tool_names:
        perfect = False
        failures.append("activate_integration was called even though the skill dependency should already be attached")
    if "mcp_assistant_authorize_integration" in tool_names:
        perfect = False
        failures.append("authorize_integration was called even though the server started ready")
    if "company-knowledge" not in chat_skills:
        perfect = False
        failures.append("company-knowledge skill was not auto-activated")
    if first_glean_index != 0:
        perfect = False
        failures.append("the first tool call was not already a Glean tool")
    if not glean_search_calls:
        perfect = False
        failures.append("expected at least one glean_search call")
    if "server:glean" not in chat_tools:
        perfect = False
        failures.append("server:glean was not activated for the chat")

    successful_searches = [
        call for call in glean_search_calls
        if isinstance(call.get("result"), dict) and not call["result"].get("error")
    ]
    if not successful_searches:
        perfect = False
        failures.append("no glean_search call returned a successful result payload")

    return {
        "perfect": perfect,
        "failures": failures,
        "tool_names": tool_names,
        "tool_calls": tool_calls,
        "chat_skills": chat_skills,
        "chat_tools": chat_tools,
    }


def run_once(
    client: OWUIClient, prompt: str, model: str, timeout_seconds: int
) -> dict[str, Any]:
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
        timeout_seconds=timeout_seconds,
        poll_interval=2,
    )
    if not completion.get("complete"):
        return {
            "chat_id": chat_id,
            "perfect": False,
            "failures": [completion.get("error", "chat did not complete")],
        }

    verdict = _validate_perfect_run(chat_id, completion.get("content", ""))
    verdict["chat_id"] = chat_id
    return verdict


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=int, default=TARGET_STREAK)
    parser.add_argument("--max-attempts", type=int, default=10)
    parser.add_argument("--prompt", default=PROMPT)
    parser.add_argument("--model", default=MODEL)
    parser.add_argument("--timeout-seconds", type=int, default=COMPLETION_TIMEOUT_SECONDS)
    args = parser.parse_args()

    streak = 0
    attempts = 0
    results = []
    with OWUIClient(base_url=_detect_openwebui_base_url()) as client:
        while streak < args.runs and attempts < args.max_attempts:
            attempts += 1
            started = time.time()
            run = run_once(client, args.prompt, args.model, timeout_seconds=args.timeout_seconds)
            run["attempt"] = attempts
            run["elapsed_seconds"] = round(time.time() - started, 1)
            results.append(run)
            print(json.dumps(run, indent=2, sort_keys=True))
            if run["perfect"]:
                streak += 1
            else:
                streak = 0
                break

    summary = {
        "requested_streak": args.runs,
        "achieved_streak": streak,
        "attempts": attempts,
        "success": streak >= args.runs,
        "chat_ids": [result["chat_id"] for result in results if result.get("chat_id")],
    }
    print(json.dumps({"summary": summary}, indent=2, sort_keys=True))
    return 0 if summary["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
