import json
import sys
from pathlib import Path

import httpx


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = REPO_ROOT / "src" / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from malformed_tool_use_diagnostics import (  # noqa: E402
    annotate_cross_chat_overlaps,
    classify_ab_results,
    identity_mismatches,
    load_bridge_failure_events,
    sanitize_probe_outcome,
    summarize_bedrock_request_shape,
    summarize_debug_request,
)
from run_malformed_tool_use_bridge_probe import (  # noqa: E402
    _base_payload,
    _eligible_initial,
    _followup_payload,
    _stream_anthropic,
)


def _bedrock_payload():
    return {
        "system": [{"text": "private-system"}],
        "messages": [
            {"role": "user", "content": [{"text": "private-prompt"}]},
            {
                "role": "assistant",
                "content": [
                    {
                        "reasoningContent": {
                            "reasoningText": {
                                "text": "private-reasoning",
                                "signature": "private-signature",
                            }
                        }
                    },
                    {
                        "toolUse": {
                            "toolUseId": "toolu_1",
                            "name": "lookup",
                            "input": {"private": "argument"},
                        }
                    },
                ],
            },
            {
                "role": "user",
                "content": [
                    {
                        "toolResult": {
                            "toolUseId": "toolu_1",
                            "content": [{"text": "private-result"}],
                        }
                    }
                ],
            },
        ],
        "toolConfig": {
            "tools": [
                {"toolSpec": {"name": "lookup"}},
                {"cachePoint": {"type": "default"}},
            ]
        },
    }


def test_request_shape_contains_only_structural_counts():
    shape = summarize_bedrock_request_shape(_bedrock_payload())

    assert shape == {
        "message_count": 3,
        "system_block_count": 1,
        "tool_spec_count": 1,
        "tool_use_block_count": 1,
        "tool_result_block_count": 1,
        "reasoning_block_count": 1,
        "reasoning_signature_count": 1,
    }
    rendered = json.dumps(shape)
    for secret in (
        "private-system",
        "private-prompt",
        "private-reasoning",
        "private-signature",
        "private-result",
        "argument",
    ):
        assert secret not in rendered


def test_debug_request_summary_classifies_empty_tool_terminal_without_payload_content():
    detail = {
        "request_id": "req-1",
        "chat_id": "chat-1",
        "session_id": "session-1",
        "message_id": "message-1",
        "timestamp": "2026-06-22T23:09:15Z",
        "duration_ms": 1000,
        "response": {
            "finish_reason": "tool_calls",
            "tool_calls": [],
            "thinking": "private-reasoning",
        },
        "transformed_payloads": [
            {"api_path": "bedrock-converse", "payload": _bedrock_payload()}
        ],
    }

    summary = summarize_debug_request(detail)

    assert summary["malformed_tool_use"] is True
    assert summary["thinking_char_count"] == len("private-reasoning")
    assert summary["request_shape"]["reasoning_signature_count"] == 1
    assert "private-reasoning" not in json.dumps(summary)


def test_cross_chat_overlap_and_identity_checks_are_request_scoped():
    requests = [
        {
            "request_id": "req-a",
            "chat_id": "chat-a",
            "session_id": "session-a",
            "message_id": "message-a",
            "upstream_request_id": "up-a",
            "started_at_ms": 1000,
            "ended_at_ms": 3000,
        },
        {
            "request_id": "req-b",
            "chat_id": "chat-b",
            "session_id": "session-b",
            "message_id": "message-b",
            "upstream_request_id": "up-b",
            "started_at_ms": 2000,
            "ended_at_ms": 4000,
        },
        {
            "request_id": "req-c",
            "chat_id": "chat-a",
            "session_id": "session-a",
            "message_id": "message-a",
            "upstream_request_id": "up-c",
            "started_at_ms": 5000,
            "ended_at_ms": 6000,
        },
    ]

    annotated = annotate_cross_chat_overlaps(requests)
    assert annotated[0]["cross_chat_overlap_request_ids"] == ["req-b"]
    assert annotated[1]["cross_chat_overlap_request_ids"] == ["req-a"]
    assert annotated[2]["cross_chat_overlap_count"] == 0
    assert identity_mismatches(
        annotated,
        {
            "chat-a": {"session_id": "session-a", "message_id": "message-a"},
            "chat-b": {"session_id": "session-b", "message_id": "message-b"},
        },
    ) == []


def test_identity_checks_detect_cross_chat_metadata_and_reused_upstream_ids():
    mismatches = identity_mismatches(
        [
            {
                "request_id": "req-a",
                "chat_id": "chat-a",
                "session_id": "wrong-session",
                "message_id": "message-a",
                "upstream_request_id": "up-shared",
            },
            {
                "request_id": "req-b",
                "chat_id": "chat-b",
                "session_id": "session-b",
                "message_id": "message-b",
                "upstream_request_id": "up-shared",
            },
        ],
        {
            "chat-a": {"session_id": "session-a", "message_id": "message-a"},
            "chat-b": {"session_id": "session-b", "message_id": "message-b"},
        },
    )

    assert {item["kind"] for item in mismatches} == {
        "session_id_mismatch",
        "duplicate_upstream_request_id",
    }


def test_ab_classification_covers_each_decision_rule():
    assert classify_ab_results(
        [
            {"variant": "preserved", "malformed_tool_use": False},
            {"variant": "stripped", "malformed_tool_use": True},
        ]
    )["conclusion"] == "reasoning_omission_supported"
    assert classify_ab_results(
        [
            {"variant": "preserved", "malformed_tool_use": True},
            {"variant": "stripped", "malformed_tool_use": True},
        ]
    )["conclusion"] == "independent_of_reasoning_omission"
    assert classify_ab_results(
        [
            {"variant": "preserved", "malformed_tool_use": True},
            {"variant": "stripped", "malformed_tool_use": False},
        ]
    )["conclusion"] == "contradicts_reasoning_omission_hypothesis"
    assert classify_ab_results(
        [
            {"variant": "preserved", "malformed_tool_use": False},
            {"variant": "stripped", "malformed_tool_use": False},
        ]
    )["conclusion"] == "inconclusive_no_reproduction"


def test_probe_sanitizer_drops_reasoning_signature_and_tool_arguments():
    sanitized = sanitize_probe_outcome(
        {
            "stop_reason": "tool_use",
            "error_code": "",
            "message_stop_seen": True,
            "malformed_tool_use": False,
            "content_blocks": [
                {
                    "type": "thinking",
                    "thinking": "private-reasoning",
                    "signature": "private-signature",
                },
                {
                    "type": "tool_use",
                    "id": "toolu_1",
                    "name": "diagnostic_step",
                    "input": {"private": "argument"},
                },
            ],
        }
    )

    assert sanitized["tool_use_count"] == 1
    assert sanitized["reasoning_signature_count"] == 1
    rendered = json.dumps(sanitized)
    assert "private-reasoning" not in rendered
    assert "private-signature" not in rendered
    assert "argument" not in rendered


def test_direct_probe_parses_signed_tool_stream_and_changes_only_reasoning_replay():
    body = "\n".join(
        [
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"private-reasoning"}}\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"private-signature"}}\n',
            'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n',
            'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"diagnostic_step","input":{}}}\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"step\\":1}"}}\n',
            'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n',
        ]
    )

    def handler(_request):
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            text=body,
        )

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        outcome = _stream_anthropic(
            client,
            url="http://bridge.test/internal/anthropic/v1/messages",
            token="private-token",
            payload=_base_payload("Claude Opus 4.8"),
        )

    assert _eligible_initial(outcome)
    assert outcome["content_blocks"][0]["signature"] == "private-signature"
    assert outcome["content_blocks"][1]["input"] == {"step": 1}

    base = _base_payload("Claude Opus 4.8")
    preserved = _followup_payload(base, outcome, preserve_reasoning=True)
    stripped = _followup_payload(base, outcome, preserve_reasoning=False)
    preserved_assistant = preserved["messages"][-2]["content"]
    stripped_assistant = stripped["messages"][-2]["content"]
    assert [block["type"] for block in preserved_assistant] == ["thinking", "tool_use"]
    assert [block["type"] for block in stripped_assistant] == ["tool_use"]
    assert [
        block for block in preserved_assistant if block.get("type") != "thinking"
    ] == stripped_assistant
    assert preserved["messages"][-1] == stripped["messages"][-1]


def test_bridge_failure_loader_excludes_failure_message_and_raw_content(tmp_path):
    event = {
        "eventType": "llm_stream_failure",
        "eventId": "event-1",
        "chatId": "chat-1",
        "timestamp": 2000,
        "failure": {
            "kind": "malformed_tool_use",
            "code": "bedrock_malformed_tool_use",
            "origin": "upstream_event_sequence",
            "message": "private-message",
        },
        "requestShape": {"messageCount": 3},
        "streamProgress": {
            "rawStopReason": "tool_use",
            "messageStopObserved": True,
            "messageStopEmitted": False,
        },
    }
    (tmp_path / "event.json").write_text(json.dumps(event), encoding="utf-8")

    loaded = load_bridge_failure_events(
        tmp_path, chat_ids={"chat-1"}, not_before_ms=1000
    )

    assert loaded[0]["failure_kind"] == "malformed_tool_use"
    assert loaded[0]["message_stop_observed"] is True
    assert "private-message" not in json.dumps(loaded)
