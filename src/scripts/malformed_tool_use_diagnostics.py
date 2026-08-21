#!/usr/bin/env python3
"""Privacy-safe helpers for malformed tool-use diagnostics."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable


MALFORMED_TOOL_USE_KIND = "malformed_tool_use"
BEDROCK_MALFORMED_TOOL_USE_CODE = "bedrock_malformed_tool_use"
TOOL_TERMINAL_REASONS = {"tool_calls", "tool_use"}


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def extract_bedrock_payload(request_detail: dict[str, Any]) -> dict[str, Any] | None:
    payload: dict[str, Any] | None = None
    for stage in _as_list(request_detail.get("transformed_payloads")):
        if not isinstance(stage, dict) or stage.get("api_path") != "bedrock-converse":
            continue
        candidate = stage.get("payload")
        if isinstance(candidate, dict):
            payload = candidate
    return payload


def summarize_bedrock_request_shape(payload: Any) -> dict[str, int]:
    payload = payload if isinstance(payload, dict) else {}
    messages = _as_list(payload.get("messages"))
    system_blocks = _as_list(payload.get("system"))
    tool_config = payload.get("toolConfig")
    tools = _as_list(tool_config.get("tools")) if isinstance(tool_config, dict) else []

    tool_use_blocks = 0
    tool_result_blocks = 0
    reasoning_blocks = 0
    reasoning_signatures = 0
    for message in messages:
        if not isinstance(message, dict):
            continue
        for block in _as_list(message.get("content")):
            if not isinstance(block, dict):
                continue
            tool_use_blocks += int("toolUse" in block)
            tool_result_blocks += int("toolResult" in block)
            reasoning = block.get("reasoningContent")
            if not isinstance(reasoning, dict):
                continue
            reasoning_blocks += 1
            reasoning_text = reasoning.get("reasoningText")
            signature = (
                reasoning_text.get("signature")
                if isinstance(reasoning_text, dict)
                else reasoning.get("signature")
            )
            if isinstance(signature, str) and signature.strip():
                reasoning_signatures += 1

    return {
        "message_count": len(messages),
        "system_block_count": len(system_blocks),
        "tool_spec_count": sum(
            1 for tool in tools if isinstance(tool, dict) and "toolSpec" in tool
        ),
        "tool_use_block_count": tool_use_blocks,
        "tool_result_block_count": tool_result_blocks,
        "reasoning_block_count": reasoning_blocks,
        "reasoning_signature_count": reasoning_signatures,
    }


def _timestamp_ms(value: Any) -> int | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        numeric = float(value)
        return int(numeric if numeric > 10_000_000_000 else numeric * 1000)
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip().replace("Z", "+00:00")
    try:
        return int(datetime.fromisoformat(text).timestamp() * 1000)
    except ValueError:
        return None


def summarize_debug_request(request_detail: dict[str, Any]) -> dict[str, Any]:
    response = request_detail.get("response")
    response = response if isinstance(response, dict) else {}
    tool_calls = _as_list(response.get("tool_calls"))
    finish_reason = str(response.get("finish_reason") or "").strip().lower()
    duration_ms = request_detail.get("duration_ms")
    duration_ms = int(duration_ms) if isinstance(duration_ms, (int, float)) else 0
    started_at_ms = _timestamp_ms(request_detail.get("timestamp"))
    ended_at_ms = (
        started_at_ms + max(0, duration_ms) if started_at_ms is not None else None
    )
    thinking = response.get("thinking")

    return {
        "request_id": request_detail.get("request_id"),
        "debug_request_id": request_detail.get("debug_request_id"),
        "upstream_request_id": request_detail.get("upstream_request_id"),
        "chat_id": request_detail.get("chat_id"),
        "session_id": request_detail.get("session_id"),
        "message_id": request_detail.get("message_id"),
        "request_phase": request_detail.get("request_phase"),
        "followup_index": request_detail.get("followup_index"),
        "status": request_detail.get("status"),
        "started_at_ms": started_at_ms,
        "ended_at_ms": ended_at_ms,
        "duration_ms": duration_ms,
        "finish_reason": finish_reason,
        "response_tool_call_count": len(tool_calls),
        "thinking_char_count": len(thinking) if isinstance(thinking, str) else 0,
        "request_shape": summarize_bedrock_request_shape(
            extract_bedrock_payload(request_detail)
        ),
        "malformed_tool_use": (
            finish_reason in TOOL_TERMINAL_REASONS and len(tool_calls) == 0
        ),
    }


def annotate_cross_chat_overlaps(
    requests: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    annotated: list[dict[str, Any]] = []
    for current in requests:
        overlap_ids: list[str] = []
        start = current.get("started_at_ms")
        end = current.get("ended_at_ms")
        if isinstance(start, int) and isinstance(end, int):
            for other in requests:
                if other is current or other.get("chat_id") == current.get("chat_id"):
                    continue
                other_start = other.get("started_at_ms")
                other_end = other.get("ended_at_ms")
                if not isinstance(other_start, int) or not isinstance(other_end, int):
                    continue
                if start <= other_end and other_start <= end:
                    overlap_ids.append(str(other.get("request_id") or "unknown"))
        item = dict(current)
        item["cross_chat_overlap_count"] = len(overlap_ids)
        item["cross_chat_overlap_request_ids"] = sorted(overlap_ids)
        annotated.append(item)
    return annotated


def identity_mismatches(
    requests: Iterable[dict[str, Any]],
    expected: dict[str, dict[str, str]],
) -> list[dict[str, Any]]:
    mismatches: list[dict[str, Any]] = []
    upstream_ids: dict[str, str] = {}
    for request in requests:
        request_id = str(request.get("request_id") or "unknown")
        chat_id = str(request.get("chat_id") or "")
        expected_identity = expected.get(chat_id)
        if expected_identity is None:
            mismatches.append(
                {"request_id": request_id, "kind": "unexpected_chat_id", "chat_id": chat_id}
            )
            continue
        for field in ("session_id", "message_id"):
            wanted = expected_identity.get(field)
            actual = request.get(field)
            if wanted and actual != wanted:
                mismatches.append(
                    {
                        "request_id": request_id,
                        "kind": f"{field}_mismatch",
                        "expected": wanted,
                        "actual": actual,
                    }
                )
        upstream_id = request.get("upstream_request_id")
        if isinstance(upstream_id, str) and upstream_id:
            previous = upstream_ids.get(upstream_id)
            if previous and previous != request_id:
                mismatches.append(
                    {
                        "request_id": request_id,
                        "kind": "duplicate_upstream_request_id",
                        "other_request_id": previous,
                    }
                )
            upstream_ids[upstream_id] = request_id
    return mismatches


def load_bridge_failure_events(
    reporting_errors_dir: Path,
    *,
    chat_ids: set[str] | None = None,
    not_before_ms: int | None = None,
) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    if not reporting_errors_dir.exists():
        return events
    for path in reporting_errors_dir.glob("*.json"):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(payload, dict) or payload.get("eventType") != "llm_stream_failure":
            continue
        chat_id = payload.get("chatId")
        if chat_ids is not None and chat_id not in chat_ids:
            continue
        timestamp = payload.get("timestamp")
        if not_before_ms is not None and isinstance(timestamp, (int, float)):
            if int(timestamp) < not_before_ms:
                continue
        failure = payload.get("failure")
        failure = failure if isinstance(failure, dict) else {}
        progress = payload.get("streamProgress")
        progress = progress if isinstance(progress, dict) else {}
        request_shape = payload.get("requestShape")
        request_shape = request_shape if isinstance(request_shape, dict) else {}
        events.append(
            {
                "event_id": payload.get("eventId"),
                "chat_id": chat_id,
                "session_id": payload.get("sessionId"),
                "message_id": payload.get("messageId"),
                "upstream_request_id": payload.get("upstreamRequestId"),
                "request_phase": payload.get("requestPhase"),
                "followup_index": payload.get("followupIndex"),
                "timestamp": timestamp,
                "failure_kind": failure.get("kind"),
                "failure_code": failure.get("code"),
                "failure_origin": failure.get("origin"),
                "raw_stop_reason": failure.get("rawStopReason")
                or progress.get("rawStopReason"),
                "message_stop_observed": progress.get("messageStopObserved"),
                "message_stop_emitted": progress.get("messageStopEmitted"),
                "raw_chunk_count": progress.get("rawChunkCount"),
                "tool_use_blocks": progress.get("toolUseBlocks"),
                "request_shape": request_shape,
            }
        )
    return sorted(events, key=lambda event: int(event.get("timestamp") or 0))


def classify_ab_results(results: Iterable[dict[str, Any]]) -> dict[str, Any]:
    counts = {"preserved": 0, "stripped": 0}
    totals = {"preserved": 0, "stripped": 0}
    for result in results:
        variant = result.get("variant")
        if variant not in totals:
            continue
        totals[variant] += 1
        if result.get("malformed_tool_use") is True:
            counts[variant] += 1

    if counts["stripped"] and not counts["preserved"]:
        conclusion = "reasoning_omission_supported"
    elif counts["stripped"] and counts["preserved"]:
        conclusion = "independent_of_reasoning_omission"
    elif counts["preserved"]:
        conclusion = "contradicts_reasoning_omission_hypothesis"
    else:
        conclusion = "inconclusive_no_reproduction"
    return {"conclusion": conclusion, "totals": totals, "malformed_counts": counts}


def sanitize_probe_outcome(outcome: dict[str, Any]) -> dict[str, Any]:
    blocks = _as_list(outcome.get("content_blocks"))
    return {
        "stop_reason": outcome.get("stop_reason"),
        "error_code": outcome.get("error_code"),
        "message_stop_seen": bool(outcome.get("message_stop_seen")),
        "tool_use_count": sum(
            1 for block in blocks if isinstance(block, dict) and block.get("type") == "tool_use"
        ),
        "thinking_block_count": sum(
            1 for block in blocks if isinstance(block, dict) and block.get("type") == "thinking"
        ),
        "reasoning_signature_count": sum(
            1
            for block in blocks
            if isinstance(block, dict)
            and block.get("type") == "thinking"
            and isinstance(block.get("signature"), str)
            and block["signature"].strip()
        ),
        "text_block_count": sum(
            1 for block in blocks if isinstance(block, dict) and block.get("type") == "text"
        ),
        "malformed_tool_use": bool(outcome.get("malformed_tool_use")),
    }
