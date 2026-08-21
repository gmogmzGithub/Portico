#!/usr/bin/env python3
"""
Run live headless Open WebUI chats against Gemini Vertex models through LLM Proxy.

Validation:
- each exposed Gemini model completes a real chat
- llm-debug-monitor records safe Gemini Vertex route/model evidence
- the Gemini 3.1 Pro custom-tools endpoint never appears
- Gemini 3.5 Flash completes at least one tool/function-calling chat
"""

from __future__ import annotations

import argparse
import json
import time
from typing import Any

from run_google_workspace_chat_consistency import (
    OWUIClient,
    _count_tool_call_batches,
    _detect_openwebui_base_url,
    _fetch_chat_request_summaries,
    _fetch_request_detail,
    _main_request_summaries,
    _merged_request_detail,
    _parse_tool_calls,
    _request_tool_names,
    _restart_counts,
    _wait_for_main_request_details,
    ensure_debug_monitor_token,
    ensure_debug_monitor_healthy,
)

EXPOSED_GEMINI_MODELS: tuple[tuple[str, str], ...] = (
    ("Gemini 3.6 Flash", "gemini-3.6-flash"),
    ("Gemini 3.5 Flash", "gemini-3.5-flash"),
    ("Gemini 3.1 Pro Preview", "gemini-3.1-pro-preview"),
    ("Gemini 3.5 Flash-Lite", "gemini-3.5-flash-lite"),
    ("Gemini 3.1 Flash-Lite", "gemini-3.1-flash-lite"),
)
CUSTOM_TOOLS_MODEL_ID = "gemini-3.1-pro-preview-customtools"
TOOL_MODEL_NAME = "Gemini 3.5 Flash"
TOOL_FUNCTION_NAME = "mcp_assistant_list_mcp_servers"
DEFAULT_TIMEOUT_SECONDS = 300
DEFAULT_PROMPT = "Reply with exactly GEMINI_OK and nothing else."
TOOL_PROMPT = (
    "Use the mcp_assistant_list_mcp_servers tool exactly once with filter='all' "
    "and include_disabled=true. After the tool returns, do not call any more "
    "tools. Answer exactly: GEMINI_TOOL_OK"
)


def _ensure_debug_monitor_token() -> None:
    ensure_debug_monitor_token()


def _json_text(value: Any) -> str:
    try:
        return json.dumps(value, sort_keys=True, separators=(",", ":"))
    except TypeError:
        return str(value)


def _usage_reasoning_tokens(usage: Any) -> int:
    if not isinstance(usage, dict):
        return 0

    completion_details = usage.get("completion_tokens_details")
    if not isinstance(completion_details, dict):
        completion_details = {}
    output_details = usage.get("output_tokens_details")
    if not isinstance(output_details, dict):
        output_details = {}

    for value in (
        usage.get("reasoning_tokens"),
        completion_details.get("reasoning_tokens"),
        output_details.get("reasoning_tokens"),
        usage.get("thoughtsTokenCount"),
        usage.get("thoughts_token_count"),
    ):
        try:
            tokens = int(value or 0)
        except (TypeError, ValueError):
            tokens = 0
        if tokens > 0:
            return tokens
    return 0


def _reasoning_details_stats(value: Any) -> dict[str, int]:
    stats = {
        "reasoning_details_text_chars": 0,
        "reasoning_details_encrypted_entries": 0,
    }

    def visit(node: Any) -> None:
        if isinstance(node, dict):
            if "reasoning_details" in node:
                visit_reasoning_details(node.get("reasoning_details"))
            for child_key, child_value in node.items():
                if child_key != "reasoning_details":
                    visit(child_value)
        elif isinstance(node, list):
            for item in node:
                visit(item)

    def visit_reasoning_details(reasoning_details: Any) -> None:
        details = reasoning_details
        if not isinstance(details, list):
            details = [details]
        for detail in details:
            if not isinstance(detail, dict):
                continue
            detail_type = detail.get("type")
            if detail_type == "reasoning.text":
                text = detail.get("text")
                if isinstance(text, str):
                    stats["reasoning_details_text_chars"] += len(text)
            elif detail_type == "reasoning.encrypted":
                stats["reasoning_details_encrypted_entries"] += 1

    visit(value)
    return stats


def _gemini_route_evidence(
    request_details: list[dict[str, Any]],
    *,
    model_id: str,
) -> dict[str, Any]:
    haystack = _json_text(request_details).lower()
    return {
        "route_found": "gemini-vertex" in haystack
        or "/gemini/v1beta1/publishers/google" in haystack,
        "model_found": model_id.lower() in haystack,
        "custom_tools_absent": CUSTOM_TOOLS_MODEL_ID not in haystack,
    }

def _gemini_reasoning_evidence(
    request_details: list[dict[str, Any]],
    completion: dict[str, Any],
) -> dict[str, Any]:
    request_reasoning_efforts: list[str] = []
    for detail in request_details:
        parameters = detail.get("parameters")
        if not isinstance(parameters, dict):
            continue
        effort = parameters.get("reasoning_effort")
        if isinstance(effort, str) and effort:
            request_reasoning_efforts.append(effort)

    response_thinking_chars = 0
    max_reasoning_tokens = 0
    reasoning_details_stats = _reasoning_details_stats(request_details)
    for detail in request_details:
        response = detail.get("response")
        if isinstance(response, dict):
            thinking = response.get("thinking")
            if isinstance(thinking, str):
                response_thinking_chars += len(thinking)
            max_reasoning_tokens = max(
                max_reasoning_tokens,
                _usage_reasoning_tokens(response.get("usage")),
            )
        max_reasoning_tokens = max(
            max_reasoning_tokens,
            _usage_reasoning_tokens(detail.get("usage")),
        )

    assistant_html = _completion_text(completion)
    content_blocks = completion.get("content_blocks")
    if not isinstance(content_blocks, list):
        content_blocks = []
    chat_reasoning_chars = sum(
        len(str(block.get("content") or ""))
        for block in content_blocks
        if isinstance(block, dict) and block.get("type") == "reasoning"
    )
    chat_has_reasoning_block = (
        chat_reasoning_chars > 0 or '<details type="reasoning"' in assistant_html
    )

    return {
        "request_reasoning_efforts": request_reasoning_efforts,
        "response_thinking_chars": response_thinking_chars,
        **reasoning_details_stats,
        "reasoning_tokens": max_reasoning_tokens,
        "chat_has_reasoning_block": chat_has_reasoning_block,
        "chat_reasoning_chars": chat_reasoning_chars,
    }

def _completion_text(completion: dict[str, Any]) -> str:
    text = completion.get("content")
    return text if isinstance(text, str) else ""


def _validate_basic_chat(
    *,
    model_name: str,
    model_id: str,
    completion: dict[str, Any],
    request_details: list[dict[str, Any]],
) -> dict[str, Any]:
    failures: list[str] = []
    assistant_text = _completion_text(completion)
    route_evidence = _gemini_route_evidence(request_details, model_id=model_id)
    reasoning_evidence = _gemini_reasoning_evidence(request_details, completion)

    if "GEMINI_OK" not in assistant_text:
        failures.append(f"{model_name} did not return GEMINI_OK")
    if not route_evidence["route_found"]:
        failures.append(
            f"llm-debug-monitor did not capture Gemini Vertex route evidence for {model_name}"
        )
    if not route_evidence["model_found"]:
        failures.append(f"llm-debug-monitor did not capture Gemini model id {model_id}")
    if not route_evidence["custom_tools_absent"]:
        failures.append(
            "debug evidence unexpectedly referenced the Gemini custom-tools endpoint"
        )
    if not reasoning_evidence["request_reasoning_efforts"]:
        failures.append(
            f"{model_name} request did not include safe reasoning-effort evidence"
        )
    if (
        reasoning_evidence["response_thinking_chars"] > 0
        or reasoning_evidence["reasoning_details_text_chars"] > 0
    ) and not reasoning_evidence["chat_has_reasoning_block"]:
        failures.append(
            f"{model_name} returned Gemini thought text but chat stored no reasoning block"
        )

    return {
        "model": model_name,
        "model_id": model_id,
        "perfect": not failures,
        "failures": failures,
        "route_evidence": route_evidence,
        "reasoning_evidence": reasoning_evidence,
        "request_ids": [detail.get("request_id") for detail in request_details],
    }

def _validate_tool_chat(
    *,
    completion: dict[str, Any],
    request_details: list[dict[str, Any]],
) -> dict[str, Any]:
    failures: list[str] = []
    assistant_html = _completion_text(completion)
    tool_calls = _parse_tool_calls(assistant_html)
    tool_names = [call.get("name") for call in tool_calls if isinstance(call, dict)]
    request_tool_names = [
        tool_name
        for detail in request_details
        for tool_name in _request_tool_names(detail)
    ]
    route_evidence = _gemini_route_evidence(
        request_details,
        model_id="gemini-3.5-flash",
    )
    reasoning_evidence = _gemini_reasoning_evidence(request_details, completion)

    if not tool_calls:
        failures.append("Gemini 3.5 Flash did not execute any visible tool calls")
    if TOOL_FUNCTION_NAME not in tool_names:
        failures.append(f"expected {TOOL_FUNCTION_NAME} tool call, saw {tool_names}")
    if TOOL_FUNCTION_NAME not in request_tool_names:
        failures.append(
            f"debug monitor did not capture {TOOL_FUNCTION_NAME} definition"
        )
    if not route_evidence["route_found"]:
        failures.append("tool chat did not capture Gemini Vertex route evidence")
    if not route_evidence["model_found"]:
        failures.append("tool chat did not capture gemini-3.5-flash model evidence")
    if not route_evidence["custom_tools_absent"]:
        failures.append(
            "tool chat unexpectedly referenced the Gemini custom-tools endpoint"
        )
    if not reasoning_evidence["request_reasoning_efforts"]:
        failures.append(
            "tool chat request did not include safe reasoning-effort evidence"
        )
    if (
        reasoning_evidence["response_thinking_chars"] > 0
        or reasoning_evidence["reasoning_details_text_chars"] > 0
    ) and not reasoning_evidence["chat_has_reasoning_block"]:
        failures.append(
            "tool chat returned Gemini thought text but stored no reasoning block"
        )

    return {
        "model": TOOL_MODEL_NAME,
        "model_id": "gemini-3.5-flash",
        "perfect": not failures,
        "failures": failures,
        "tool_names": tool_names,
        "request_tool_names": (
            [TOOL_FUNCTION_NAME] if TOOL_FUNCTION_NAME in request_tool_names else []
        ),
        "route_evidence": route_evidence,
        "reasoning_evidence": reasoning_evidence,
        "request_ids": [detail.get("request_id") for detail in request_details],
    }

def _fetch_available_main_request_details(chat_id: str) -> list[dict[str, Any]]:
    request_details: list[dict[str, Any]] = []
    for summary in _main_request_summaries(_fetch_chat_request_summaries(chat_id)):
        request_id = summary.get("request_id")
        if not request_id:
            continue
        try:
            detail = _fetch_request_detail(str(request_id))
        except Exception:
            continue
        request_details.append(_merged_request_detail(summary, detail))
    return request_details


def _run_chat(
    client: OWUIClient,
    *,
    model: str,
    prompt: str,
    timeout_seconds: int,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    created = client.create_chat(model=model, prompt=prompt)
    chat_id = created["chat_id"]
    user_message_id = created["user_message_id"]

    client.generate_completion(
        chat_id=chat_id,
        model=model,
        prompt=prompt,
        user_message_id=user_message_id,
        stream=True,
        reasoning_effort="medium",
    )
    completion = client.poll_for_completion(
        chat_id=chat_id,
        user_message_id=user_message_id,
        timeout_seconds=timeout_seconds,
        poll_interval=2,
    )
    completion["chat_id"] = chat_id

    if not completion.get("complete"):
        return completion, []

    expected_request_count = max(
        1,
        _count_tool_call_batches(completion.get("content_blocks", [])) + 1,
    )
    try:
        request_details = _wait_for_main_request_details(
            chat_id,
            expected_main_request_count=expected_request_count,
        )
    except RuntimeError:
        request_details = _fetch_available_main_request_details(chat_id)
        if len(request_details) < expected_request_count:
            raise
    return completion, request_details


def run_suite(
    client: OWUIClient,
    *,
    prompt: str,
    tool_prompt: str,
    timeout_seconds: int,
) -> dict[str, Any]:
    results: list[dict[str, Any]] = []

    for model_name, model_id in EXPOSED_GEMINI_MODELS:
        completion, request_details = _run_chat(
            client,
            model=model_name,
            prompt=prompt,
            timeout_seconds=timeout_seconds,
        )
        if not completion.get("complete"):
            results.append(
                {
                    "model": model_name,
                    "model_id": model_id,
                    "chat_id": completion.get("chat_id"),
                    "perfect": False,
                    "failures": [completion.get("error", "chat did not complete")],
                }
            )
            continue

        verdict = _validate_basic_chat(
            model_name=model_name,
            model_id=model_id,
            completion=completion,
            request_details=request_details,
        )
        verdict["chat_id"] = completion.get("chat_id")
        results.append(verdict)

    completion, request_details = _run_chat(
        client,
        model=TOOL_MODEL_NAME,
        prompt=tool_prompt,
        timeout_seconds=timeout_seconds,
    )
    if not completion.get("complete"):
        results.append(
            {
                "model": TOOL_MODEL_NAME,
                "model_id": "gemini-3.5-flash",
                "chat_id": completion.get("chat_id"),
                "scenario": "tool_chat",
                "perfect": False,
                "failures": [completion.get("error", "tool chat did not complete")],
            }
        )
    else:
        verdict = _validate_tool_chat(
            completion=completion,
            request_details=request_details,
        )
        verdict["chat_id"] = completion.get("chat_id")
        verdict["scenario"] = "tool_chat"
        results.append(verdict)

    failures = [
        failure
        for result in results
        for failure in result.get("failures", [])
    ]
    return {
        "perfect": not failures,
        "failures": failures,
        "results": results,
        "chat_ids": [result["chat_id"] for result in results if result.get("chat_id")],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=int, default=1)
    parser.add_argument("--max-attempts", type=int, default=3)
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    parser.add_argument("--tool-prompt", default=TOOL_PROMPT)
    parser.add_argument("--timeout-seconds", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    args = parser.parse_args()

    restart_counts_before = _restart_counts()
    print(json.dumps({"restart_counts_before": restart_counts_before}, indent=2))
    _ensure_debug_monitor_token()
    ensure_debug_monitor_healthy()

    streak = 0
    attempts = 0
    results = []
    with OWUIClient(base_url=_detect_openwebui_base_url()) as client:
        while streak < args.runs and attempts < args.max_attempts:
            attempts += 1
            started = time.time()
            run = run_suite(
                client,
                prompt=args.prompt,
                tool_prompt=args.tool_prompt,
                timeout_seconds=args.timeout_seconds,
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
        "chat_ids": [
            chat_id
            for result in results
            for chat_id in result.get("chat_ids", [])
        ],
        "models": [model_name for model_name, _ in EXPOSED_GEMINI_MODELS],
    }
    print(json.dumps(summary, indent=2, sort_keys=True))

    return 0 if summary["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
