#!/usr/bin/env python3
"""
Run a live headless Open WebUI reasoning sweep against Claude Opus 4.7.

For each explicit effort level, this script verifies:
- the OWUI request preserves the selected `reasoning_effort`
- the transformed Bedrock payload requests adaptive thinking with summarized display
- the Bedrock payload forwards the exact effort value via `output_config.effort`
- the final assistant output contains a visible reasoning block
- llm-debug-monitor captured non-empty response thinking

Bedrock/Bifrost chat-completions usage currently does not expose a distinct
`reasoning_tokens` counter for Claude 4.6/4.7, so this runner records that value
when present but does not fail on its absence.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import time
from typing import Any

from run_google_workspace_chat_consistency import (
    OWUIClient,
    _detect_openwebui_base_url,
    _restart_counts,
    _wait_for_main_request_details,
    ensure_debug_monitor_healthy,
)

MODEL = "Claude Opus 4.7"
EFFORTS = ("low", "medium", "high", "xhigh", "max")
DEFAULT_TIMEOUT_SECONDS = 600
DEFAULT_MAX_ATTEMPTS_PER_EFFORT = 3
PROMPT = """Solve this carefully.

Four analysts A, B, C, D each handle one ticket slot 1-4.

Constraints:
1. A is not in slot 1.
2. B is after C.
3. D is not in slot 4.
4. C is not in slot 2.

Return:
1. All valid assignments.
2. A short deduction that proves you did not miss any case.
"""

REASONING_DETAILS_RE = re.compile(
    r"<details\b[^>]*\btype=[\"']reasoning[\"'][^>]*>(?P<body>.*?)</details>",
    re.IGNORECASE | re.DOTALL,
)
SUMMARY_RE = re.compile(r"<summary\b[^>]*>.*?</summary>", re.IGNORECASE | re.DOTALL)
HTML_TAG_RE = re.compile(r"<[^>]+>")
WORD_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9'_-]*")


def _message_map(chat_payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    history = chat_payload.get("chat", chat_payload).get("history", {})
    messages = history.get("messages")
    return messages if isinstance(messages, dict) else {}


def _message_by_id(chat_payload: dict[str, Any], message_id: str | None) -> dict[str, Any] | None:
    if not message_id:
        return None
    message = _message_map(chat_payload).get(message_id)
    return message if isinstance(message, dict) else None


def _message_content_text(message: dict[str, Any] | None) -> str:
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
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
        for key in ("thinking", "text", "content", "input_text", "output_text"):
            value = item.get(key)
            if isinstance(value, str) and value.strip():
                parts.append(value)
                break
    return "\n".join(parts)


def _usage_for_message(message: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(message, dict):
        return {}
    info = message.get("info")
    if isinstance(info, dict) and isinstance(info.get("usage"), dict):
        return info["usage"]
    usage = message.get("usage")
    if isinstance(usage, dict):
        return usage
    return {}


def _reasoning_tokens_for_message(message: dict[str, Any] | None) -> int:
    usage = _usage_for_message(message)
    completion_details = usage.get("completion_tokens_details")
    if isinstance(completion_details, dict):
        value = completion_details.get("reasoning_tokens")
        if isinstance(value, int):
            return value
    output_details = usage.get("output_tokens_details")
    if isinstance(output_details, dict):
        value = output_details.get("reasoning_tokens")
        if isinstance(value, int):
            return value
    return 0


def _extract_bedrock_request_controls(request_detail: dict[str, Any]) -> dict[str, Any]:
    transformed_payloads = request_detail.get("transformed_payloads")
    if not isinstance(transformed_payloads, list):
        return {}

    bedrock_payload = None
    for stage in transformed_payloads:
        if not isinstance(stage, dict):
            continue
        if stage.get("api_path") != "bedrock-converse":
            continue
        payload = stage.get("payload")
        if isinstance(payload, dict):
            bedrock_payload = payload

    if not isinstance(bedrock_payload, dict):
        return {}

    additional_fields = bedrock_payload.get("additionalModelRequestFields")
    if not isinstance(additional_fields, dict):
        additional_fields = {}

    thinking = additional_fields.get("thinking")
    if not isinstance(thinking, dict):
        thinking = {}

    output_config = additional_fields.get("output_config")
    if not isinstance(output_config, dict):
        output_config = {}

    return {
        "payload": bedrock_payload,
        "thinking_type": thinking.get("type"),
        "thinking_display": thinking.get("display"),
        "output_config_effort": output_config.get("effort"),
    }


def _has_visible_reasoning_block(content: str) -> bool:
    return '<details type="reasoning"' in content and "</details>" in content


def _extract_reasoning_block_text(content: str) -> str:
    blocks: list[str] = []
    for match in REASONING_DETAILS_RE.finditer(content or ""):
        body = SUMMARY_RE.sub(" ", match.group("body"), count=1)
        body = HTML_TAG_RE.sub(" ", body)
        body = html.unescape(body)
        body = re.sub(r"\s+", " ", body).strip()
        if body:
            blocks.append(body)
    return "\n".join(blocks)


def _reasoning_duplicate_report(text: str) -> dict[str, Any]:
    normalized = html.unescape(HTML_TAG_RE.sub(" ", text or "")).lower()
    tokens = WORD_RE.findall(normalized)
    spans: list[dict[str, Any]] = []
    i = 0
    while i < len(tokens):
        max_window = min(12, (len(tokens) - i) // 2)
        found_window = 0
        for window in range(max_window, 0, -1):
            if tokens[i : i + window] == tokens[i + window : i + (2 * window)]:
                found_window = window
                break
        if found_window:
            spans.append(
                {
                    "index": i,
                    "tokens": found_window,
                    "sample": " ".join(tokens[i : i + found_window]),
                }
            )
            i += 2 * found_window
            continue
        i += 1

    duplicate_token_count = sum(span["tokens"] for span in spans)
    ratio = duplicate_token_count / max(len(tokens), 1)
    detected = (
        any(span["tokens"] >= 4 for span in spans)
        or sum(1 for span in spans if span["tokens"] >= 2) >= 3
        or (len(spans) >= 8 and ratio >= 0.025)
    )
    return {
        "detected": detected,
        "token_count": len(tokens),
        "duplicate_span_count": len(spans),
        "duplicate_token_ratio": round(ratio, 4),
        "max_duplicate_span_tokens": max((span["tokens"] for span in spans), default=0),
        "samples": [span["sample"] for span in spans[:8]],
    }


def run_once(
    client: OWUIClient,
    *,
    prompt: str,
    model: str,
    effort: str,
    timeout_seconds: int,
    require_clean_reasoning_stream: bool = False,
    require_debug_monitor_details: bool = True,
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
        reasoning_effort=effort,
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
            "effort": effort,
            "perfect": False,
            "failures": [completion.get("error", "chat did not complete")],
        }

    request_detail_error = ""
    try:
        request_details = _wait_for_main_request_details(
            chat_id,
            expected_main_request_count=1,
        )
    except Exception as exc:
        request_details = []
        request_detail_error = str(exc)
    request_detail = request_details[0] if request_details else {}
    request_controls = _extract_bedrock_request_controls(request_detail)
    chat_payload = client.get_chat(chat_id)
    assistant_message = _message_by_id(chat_payload, completion.get("assistant_message_id"))
    assistant_content = _message_content_text(assistant_message)
    assistant_reasoning_text = _extract_reasoning_block_text(assistant_content)
    reasoning_tokens = _reasoning_tokens_for_message(assistant_message)
    debug_response = request_detail.get("response")
    debug_thinking = (
        debug_response.get("thinking", "")
        if isinstance(debug_response, dict)
        else ""
    )
    assistant_duplicate_report = _reasoning_duplicate_report(assistant_reasoning_text)
    debug_duplicate_report = _reasoning_duplicate_report(debug_thinking)

    failures: list[str] = []

    parameters = request_detail.get("parameters")
    if request_detail_error and require_debug_monitor_details:
        failures.append(f"llm-debug-monitor request details were unavailable: {request_detail_error}")

    if not request_detail and not require_debug_monitor_details:
        parameters = {}
    elif not isinstance(parameters, dict):
        failures.append("llm-debug-monitor request detail did not include parameters")
        parameters = {}
    elif parameters.get("reasoning_effort") != effort:
        failures.append(
            "llm-debug-monitor did not preserve the requested reasoning_effort: "
            f"expected {effort!r}, saw {parameters.get('reasoning_effort')!r}"
        )

    if not request_controls and require_debug_monitor_details:
        failures.append("llm-debug-monitor did not capture a bedrock-converse transformed payload")
    elif request_controls:
        if request_controls.get("thinking_type") != "adaptive":
            failures.append(
                "bedrock-converse payload did not request adaptive thinking: "
                f"{request_controls.get('thinking_type')!r}"
            )
        if request_controls.get("thinking_display") != "summarized":
            failures.append(
                "bedrock-converse payload did not request summarized thinking display: "
                f"{request_controls.get('thinking_display')!r}"
            )
        if request_controls.get("output_config_effort") != effort:
            failures.append(
                "bedrock-converse payload did not forward the selected effort: "
                f"expected {effort!r}, saw {request_controls.get('output_config_effort')!r}"
            )

    if not _has_visible_reasoning_block(assistant_content):
        failures.append("assistant output did not contain a visible reasoning <details> block")
    if request_detail and (not isinstance(debug_thinking, str) or not debug_thinking.strip()):
        failures.append("llm-debug-monitor request detail response.thinking was empty")
    if require_clean_reasoning_stream and assistant_duplicate_report["detected"]:
        failures.append(
            "assistant reasoning block contained duplicated streamed text: "
            f"{assistant_duplicate_report}"
        )
    if require_clean_reasoning_stream and debug_duplicate_report["detected"]:
        failures.append(
            "llm-debug-monitor response.thinking contained duplicated streamed text: "
            f"{debug_duplicate_report}"
        )

    return {
        "chat_id": chat_id,
        "effort": effort,
        "perfect": not failures,
        "failures": failures,
        "assistant_message_id": completion.get("assistant_message_id"),
        "reasoning_tokens": reasoning_tokens,
        "reasoning_block_present": _has_visible_reasoning_block(assistant_content),
        "reasoning_tokens_available": reasoning_tokens > 0,
        "assistant_reasoning_chars": len(assistant_reasoning_text),
        "assistant_reasoning_duplicate_report": assistant_duplicate_report,
        "debug_monitor_required": require_debug_monitor_details,
        "debug_monitor_request_detail_available": bool(request_detail),
        "debug_monitor_request_detail_error": request_detail_error,
        "debug_response_thinking_chars": len(debug_thinking or ""),
        "debug_response_thinking_duplicate_report": debug_duplicate_report,
        "request_id": request_detail.get("request_id"),
        "thinking_type": request_controls.get("thinking_type"),
        "thinking_display": request_controls.get("thinking_display"),
        "output_config_effort": request_controls.get("output_config_effort"),
    }


def main(
    *,
    default_model: str = MODEL,
    default_require_clean_reasoning_stream: bool = False,
    default_require_debug_monitor_details: bool = True,
) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default=default_model)
    parser.add_argument("--prompt", default=PROMPT)
    parser.add_argument(
        "--efforts",
        nargs="+",
        default=list(EFFORTS),
        choices=list(EFFORTS),
    )
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=DEFAULT_TIMEOUT_SECONDS,
    )
    parser.add_argument(
        "--max-attempts-per-effort",
        type=int,
        default=DEFAULT_MAX_ATTEMPTS_PER_EFFORT,
    )
    parser.add_argument(
        "--require-clean-reasoning-stream",
        dest="require_clean_reasoning_stream",
        action="store_true",
        default=default_require_clean_reasoning_stream,
        help="Fail if the live assistant reasoning block or debug thinking contains duplicated stream text.",
    )
    parser.add_argument(
        "--allow-duplicate-reasoning-stream",
        dest="require_clean_reasoning_stream",
        action="store_false",
        help="Disable duplicate streamed reasoning detection.",
    )
    parser.add_argument(
        "--require-debug-monitor-details",
        dest="require_debug_monitor_details",
        action="store_true",
        default=default_require_debug_monitor_details,
        help="Fail if llm-debug-monitor request details are unavailable.",
    )
    parser.add_argument(
        "--allow-missing-debug-monitor-details",
        dest="require_debug_monitor_details",
        action="store_false",
        help="Validate the saved live OWUI chat even if debug-monitor request details are unavailable.",
    )
    args = parser.parse_args()

    restart_counts_before = _restart_counts()
    print(json.dumps({"restart_counts_before": restart_counts_before}, indent=2))
    ensure_debug_monitor_healthy()

    overall_results: list[dict[str, Any]] = []
    failures_by_effort: dict[str, list[str]] = {}

    with OWUIClient(base_url=_detect_openwebui_base_url()) as client:
        for effort in args.efforts:
            passed = False
            for attempt in range(1, args.max_attempts_per_effort + 1):
                started = time.time()
                result = run_once(
                    client,
                    prompt=args.prompt,
                    model=args.model,
                    effort=effort,
                    timeout_seconds=args.timeout_seconds,
                    require_clean_reasoning_stream=args.require_clean_reasoning_stream,
                    require_debug_monitor_details=args.require_debug_monitor_details,
                )
                result["attempt"] = attempt
                result["elapsed_seconds"] = round(time.time() - started, 1)
                overall_results.append(result)
                print(json.dumps(result, indent=2, sort_keys=True))
                if result["perfect"]:
                    passed = True
                    break
            if not passed:
                failures_by_effort[effort] = result.get("failures", [])
                break

    restart_counts_after = _restart_counts()
    summary = {
        "model": args.model,
        "efforts": args.efforts,
        "attempts": len(overall_results),
        "restart_counts_before": restart_counts_before,
        "restart_counts_after": restart_counts_after,
        "require_clean_reasoning_stream": args.require_clean_reasoning_stream,
        "require_debug_monitor_details": args.require_debug_monitor_details,
        "success": not failures_by_effort and len(
            {
                result["effort"]
                for result in overall_results
                if result.get("perfect")
            }
        )
        == len(args.efforts),
        "chat_ids": [result["chat_id"] for result in overall_results if result.get("chat_id")],
        "failures_by_effort": failures_by_effort,
    }
    print(json.dumps({"summary": summary}, indent=2, sort_keys=True))
    return 0 if summary["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
