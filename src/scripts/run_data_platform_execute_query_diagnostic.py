#!/usr/bin/env python3
"""
Run a targeted headless Open WebUI diagnostic for data_plat_mcp_execute_query.

This submits exactly one chat turn that asks the model to call
data_plat_mcp_execute_query with caller-supplied JSON arguments, then reports
the observed first tool result class without attempting any recovery.
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
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
API_CLIENT_PATH = REPO_ROOT / "tests" / "integration" / "framework" / "utils" / "api_client.py"

MODEL = "Claude Sonnet 4.6"
COMPLETION_TIMEOUT_SECONDS = int(os.getenv("OWUI_DATA_PLATFORM_TIMEOUT_SECONDS", "1800"))


def _load_owui_client():
    api_client_spec = importlib.util.spec_from_file_location(
        "owui_api_client", API_CLIENT_PATH
    )
    if api_client_spec is None or api_client_spec.loader is None:
        raise RuntimeError(f"Failed to load OWUI API client from {API_CLIENT_PATH}")
    api_client_module = importlib.util.module_from_spec(api_client_spec)
    api_client_spec.loader.exec_module(api_client_module)
    return api_client_module.OWUIClient


def _detect_openwebui_base_url() -> str:
    configured = os.getenv("OPENWEBUI_BASE_URL")
    if configured:
        return configured

    output = subprocess.check_output(
        ["docker", "inspect", "portico-open-webui", "--format", "{{json .NetworkSettings.Ports}}"],
        text=True,
    )
    ports = json.loads(output)
    bindings = ports.get("8080/tcp") or []
    if not bindings:
        raise RuntimeError("Could not detect published Open WebUI port for portico-open-webui")
    return f"http://127.0.0.1:{bindings[0]['HostPort']}"


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


def _load_payload(args: argparse.Namespace) -> dict[str, Any]:
    if args.payload_file:
        return json.loads(Path(args.payload_file).read_text())
    assert args.payload_json is not None
    return json.loads(args.payload_json)


def _extract_execution_id(result: Any) -> str | None:
    if isinstance(result, dict):
        for key in ("executionId", "execution_id"):
            value = result.get(key)
            if isinstance(value, str) and value:
                return value
        for key in ("message", "content", "error"):
            value = result.get(key)
            if isinstance(value, str):
                match = re.search(r"Execution ID:\s*([a-f0-9-]+)", value, re.IGNORECASE)
                if match:
                    return match.group(1)
    return None


def _extract_error_text(result: Any) -> str | None:
    if isinstance(result, dict):
        for key in ("error", "message", "content"):
            value = result.get(key)
            if isinstance(value, str) and value.strip():
                return value
    return None


def classify_tool_result(result: Any) -> str:
    execution_id = _extract_execution_id(result)
    error_text = _extract_error_text(result)
    normalized_error = (error_text or "").lower()

    if error_text and (
        "transport send error" in normalized_error
        or ("504" in normalized_error and "gateway time-out" in normalized_error)
        or ("504" in normalized_error and "gateway timeout" in normalized_error)
    ):
        return "raw_transport_504"

    if execution_id and error_text and "timed out" in normalized_error:
        return "structured_timeout_with_execution_id"

    if isinstance(result, dict):
        if result.get("success") is True:
            return "success"
        if execution_id and result.get("status") in {"QUEUED", "IN_PROGRESS", "COMPLETED"}:
            return "execution_id_returned"
        if error_text:
            return "tool_error"

    return "other"


def _build_prompt(payload: dict[str, Any]) -> str:
    payload_json = json.dumps(payload, indent=2, sort_keys=True)
    return (
        "Run a data platform transport diagnostic.\n\n"
        "Call the tool `data_plat_mcp_execute_query` exactly once with the exact JSON "
        "arguments below.\n"
        "Rules:\n"
        "- Do not call any other tools.\n"
        "- Do not change keys or values.\n"
        "- Do not retry or recover.\n"
        "- After the tool result arrives, reply with only `DONE`.\n\n"
        "<tool_name>data_plat_mcp_execute_query</tool_name>\n"
        "<arguments>\n"
        f"{payload_json}\n"
        "</arguments>\n"
    )


def run_once(client: Any, *, payload: dict[str, Any], model: str, timeout_seconds: int) -> dict[str, Any]:
    prompt = _build_prompt(payload)
    chat = client.create_chat(model=model, prompt=prompt)
    chat_id = chat["chat_id"]
    started_at = time.time()

    completion = client.generate_completion(
        chat_id=chat_id,
        model=model,
        prompt=prompt,
        user_message_id=chat["user_message_id"],
    )
    poll_result = client.poll_for_completion(
        chat_id=chat_id,
        user_message_id=chat["user_message_id"],
        timeout_seconds=timeout_seconds,
    )
    elapsed_seconds = round(time.time() - started_at, 3)

    result: dict[str, Any] = {
        "chat_id": chat_id,
        "session_id": completion.get("session_id"),
        "request_message_id": completion.get("message_id"),
        "elapsed_seconds": elapsed_seconds,
        "complete": poll_result.get("complete", False),
    }

    if not poll_result.get("complete"):
        result["result_class"] = "completion_error"
        result["error"] = poll_result.get("error", "unknown completion failure")
        return result

    assistant_html = poll_result.get("content", "")
    tool_calls = _parse_tool_calls(assistant_html)
    tool_names = [call["name"] for call in tool_calls]
    result.update(
        {
            "assistant_message_id": poll_result.get("assistant_message_id"),
            "tool_call_count": len(tool_calls),
            "tool_names": tool_names,
        }
    )

    if not tool_calls:
        result["result_class"] = "no_tool_call"
        return result

    first_call = tool_calls[0]
    first_result = first_call.get("result")
    first_arguments = first_call.get("arguments")
    result.update(
        {
            "first_tool_name": first_call.get("name"),
            "first_tool_arguments": first_arguments,
            "first_tool_result": first_result,
            "execution_id": _extract_execution_id(first_result),
            "result_class": classify_tool_result(first_result),
            "exact_argument_match": first_arguments == payload,
        }
    )
    return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default=MODEL, help=f"Model to use (default: {MODEL})")
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=COMPLETION_TIMEOUT_SECONDS,
        help=f"Assistant completion wait budget (default: {COMPLETION_TIMEOUT_SECONDS})",
    )
    parser.add_argument(
        "--base-url",
        default=_detect_openwebui_base_url(),
        help="Open WebUI base URL (default: detect local container)",
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--payload-file", help="Path to JSON file containing execute_query args")
    group.add_argument("--payload-json", help="Inline JSON object containing execute_query args")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    payload = _load_payload(args)
    owui_client = _load_owui_client()

    with owui_client(base_url=args.base_url) as client:
        result = run_once(
            client,
            payload=payload,
            model=args.model,
            timeout_seconds=args.timeout_seconds,
        )

    print(json.dumps(result, indent=2, sort_keys=True))
    if result.get("result_class") in {"completion_error", "no_tool_call"}:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
