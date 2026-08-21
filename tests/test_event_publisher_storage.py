import json
import sys
import asyncio
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import event_publisher


class _FakeRedisClient:
    def __init__(self):
        self.publish_calls = []
        self.publish_payloads = []
        self.setex_calls = []

    def publish(self, channel, payload):
        self.publish_payloads.append(payload)
        self.publish_calls.append((channel, json.loads(payload)))

    def setex(self, key, ttl, payload):
        self.setex_calls.append((key, ttl, json.loads(payload)))


def test_publish_debug_event_sync_stores_request_and_response_payloads(monkeypatch):
    client = _FakeRedisClient()
    monkeypatch.setattr(event_publisher, "_get_sync_redis", lambda: client)

    assert event_publisher.publish_debug_event_sync(
        {
            "event_id": "req_1",
            "event_type": "llm_request_payload",
            "session_id": "session-1",
            "chat_id": "chat-1",
            "data": {"model": "GPT-5.4"},
        }
    )
    assert client.setex_calls[0][0] == "llm_debug:event_request_payload:req_1"
    assert client.setex_calls[0][1] == 300

    client.setex_calls.clear()

    assert event_publisher.publish_debug_event_sync(
        {
            "event_id": "resp_1",
            "event_type": "llm_response_complete",
            "session_id": "session-1",
            "chat_id": "chat-1",
            "data": {
                "model": "GPT-5.6 Sol",
                "usage": {"prompt_tokens": 10},
                "ultra_audit": {
                    "child_agent_count": 2,
                    "tool_call_count": 1,
                    "child_tool_call_count": 1,
                    "tool_result_count": 1,
                    "continuation_count": 1,
                    "arguments_logged": False,
                    "results_logged": False,
                },
            },
        }
    )
    assert client.setex_calls[0][0] == "llm_debug:event_response_complete:resp_1"
    assert client.setex_calls[0][1] == 300
    assert client.publish_calls[-1][1]["data"]["ultra_audit"] == {
        "child_agent_count": 2,
        "tool_call_count": 1,
        "child_tool_call_count": 1,
        "tool_result_count": 1,
        "continuation_count": 1,
        "arguments_logged": False,
        "results_logged": False,
    }



def test_publish_debug_event_sync_publishes_compact_request_payload_event(monkeypatch):
    client = _FakeRedisClient()
    monkeypatch.setattr(event_publisher, "_get_sync_redis", lambda: client)

    assert event_publisher.publish_debug_event_sync(
        {
            "event_id": "req_compact",
            "event_type": "llm_request_payload",
            "session_id": "session-1",
            "chat_id": "chat-1",
            "upstream_request_id": "upstream-compact",
            "data": {
                "model": "cluck",
                "base_model": "Claude Haiku 4.5",
                "messages": [{"role": "user", "content": "hello"}],
                "tools": [{"type": "function", "function": {"name": "foo"}}],
                "tool_ids": ["tool-1"],
                "skills": ["skill-1"],
                "raw_payload": {
                    "messages": [{"role": "user", "content": "hello"}],
                    "tools": [{"type": "function", "function": {"name": "foo"}}],
                    "model_item": {"id": "huge"},
                    "variables": {"A": "B"},
                },
            },
        }
    )

    assert client.setex_calls[0][2]["data"]["raw_payload"]["messages"] == [
        {"role": "user", "content": "hello"}
    ]
    assert client.setex_calls[0][2]["data"]["raw_payload"]["tools"] == [
        {"type": "function", "function": {"name": "foo"}}
    ]
    assert "messages" not in client.setex_calls[0][2]["data"]
    assert "tools" not in client.setex_calls[0][2]["data"]
    assert "model_item" not in client.setex_calls[0][2]["data"]["raw_payload"]
    assert "variables" not in client.setex_calls[0][2]["data"]["raw_payload"]
    assert client.publish_calls[0][1]["data"] == {
        "model": "cluck",
        "base_model": "Claude Haiku 4.5",
        "message_count": 1,
        "tool_count": 1,
        "tool_ids": ["tool-1"],
        "skills": ["skill-1"],
        "temperature": None,
        "max_tokens": None,
        "reasoning_effort": None,
        "reasoning_config": None,
        "raw_payload_stored": True,
    }


def test_ultra_audit_sanitizer_never_carries_tool_or_transcript_payloads():
    sanitized = event_publisher._sanitize_ultra_audit(
        {
            "child_agent_count": 2,
            "tool_call_count": 2,
            "child_tool_call_count": 1,
            "tool_result_count": 2,
            "continuation_count": 1,
            "arguments_logged": False,
            "results_logged": False,
            "tool_name": "private_read",
            "call_id": "private-call",
            "arguments": {"secret": True},
            "result": "private-result",
            "transcript": ["private"],
        }
    )

    assert sanitized == {
        "child_agent_count": 2,
        "tool_call_count": 2,
        "child_tool_call_count": 1,
        "tool_result_count": 2,
        "continuation_count": 1,
        "arguments_logged": False,
        "results_logged": False,
    }
    assert "private" not in repr(sanitized)
    assert event_publisher._sanitize_ultra_audit(
        {
            "child_agent_count": 1,
            "tool_call_count": 1,
            "child_tool_call_count": 1,
            "tool_result_count": 1,
            "continuation_count": 1,
            "arguments_logged": True,
            "results_logged": False,
        }
    ) is None
    for oversized in (
        {
            "child_agent_count": 1,
            "tool_call_count": 257,
            "child_tool_call_count": 1,
            "tool_result_count": 1,
            "continuation_count": 1,
            "arguments_logged": False,
            "results_logged": False,
        },
        {
            "child_agent_count": 1,
            "tool_call_count": 1,
            "child_tool_call_count": 1,
            "tool_result_count": 257,
            "continuation_count": 1,
            "arguments_logged": False,
            "results_logged": False,
        },
        {
            "child_agent_count": 1,
            "tool_call_count": 1,
            "child_tool_call_count": 1,
            "tool_result_count": 1,
            "continuation_count": 33,
            "arguments_logged": False,
            "results_logged": False,
        },
        {
            "child_agent_count": 257,
            "tool_call_count": 1,
            "child_tool_call_count": 1,
            "tool_result_count": 1,
            "continuation_count": 1,
            "arguments_logged": False,
            "results_logged": False,
        },
        {
            "child_agent_count": 1,
            "tool_call_count": 1,
            "child_tool_call_count": 257,
            "tool_result_count": 1,
            "continuation_count": 1,
            "arguments_logged": False,
            "results_logged": False,
        },
    ):
        assert event_publisher._sanitize_ultra_audit(oversized) is None



def test_publish_debug_event_sync_skips_storage_for_other_event_types(monkeypatch):
    client = _FakeRedisClient()
    monkeypatch.setattr(event_publisher, "_get_sync_redis", lambda: client)

    assert event_publisher.publish_debug_event_sync(
        {
            "event_type": "llm_request_start",
            "session_id": "session-1",
            "chat_id": "chat-1",
            "data": {"model": "GPT-5.4"},
        }
    )

    assert client.publish_calls
    assert client.setex_calls == []


def test_publish_debug_event_sync_bounds_request_start_with_multimegabyte_metadata(monkeypatch):
    client = _FakeRedisClient()
    monkeypatch.setattr(event_publisher, "_get_sync_redis", lambda: client)

    assert event_publisher.publish_debug_event_sync(
        {
            "event_id": "request-start-large",
            "event_type": "llm_request_start",
            "session_id": "session-1",
            "chat_id": "chat-1",
            "message_id": "message-1",
            "debug_request_id": "debug-1",
            "data": {
                "model": "Claude Opus 4.8",
                "message_count": 4,
                "tool_ids": ["server:agent-vm"],
                "skills": ["code-execution"],
                "metadata": {
                    "tools": [{"schema": "x" * (2 * 1024 * 1024)}],
                    "mcp_clients": {"agent-vm": "y" * (2 * 1024 * 1024)},
                    "messages": [{"content": "z" * (2 * 1024 * 1024)}],
                },
            },
        }
    )

    payload = client.publish_payloads[0]
    published = client.publish_calls[0][1]
    assert len(payload.encode("utf-8")) <= event_publisher.MAX_DEBUG_PUBSUB_EVENT_BYTES
    assert published["message_id"] == "message-1"
    assert published["debug_request_id"] == "debug-1"
    assert published["data"]["message_count"] == 4
    assert published["data"]["tool_ids"] == ["server:agent-vm"]
    assert published["data"]["skills"] == ["code-execution"]
    assert "metadata" not in published["data"]


def test_publish_debug_event_sync_summarizes_any_oversized_pubsub_event(monkeypatch):
    client = _FakeRedisClient()
    monkeypatch.setattr(event_publisher, "_get_sync_redis", lambda: client)

    assert event_publisher.publish_debug_event_sync(
        {
            "event_id": "large-capabilities",
            "event_type": "capabilities_change",
            "session_id": "session-1",
            "chat_id": "chat-1",
            "message_id": "message-1",
            "data": {
                "tools": [{"schema": "x" * (2 * 1024 * 1024)}],
                "skills": [f"skill-{index}" for index in range(1000)],
            },
        }
    )

    payload = client.publish_payloads[0]
    published = client.publish_calls[0][1]
    assert len(payload.encode("utf-8")) <= event_publisher.MAX_DEBUG_PUBSUB_EVENT_BYTES
    assert published["event_id"] == "large-capabilities"
    assert published["chat_id"] == "chat-1"
    assert published["message_id"] == "message-1"
    assert published["data"]["pubsub_truncated"] is True
    assert published["data"]["tool_count"] == 1
    assert published["data"]["skill_count"] == 1000
    assert "Oversized fields" in published["data"]["pubsub_warning"]


def test_publish_debug_event_sync_prefers_upstream_request_identity_for_storage(monkeypatch):
    client = _FakeRedisClient()
    monkeypatch.setattr(event_publisher, "_get_sync_redis", lambda: client)

    assert event_publisher.publish_debug_event_sync(
        {
            "event_id": "payload_1",
            "event_type": "llm_request_payload",
            "session_id": "session-1",
            "chat_id": "chat-1",
            "debug_request_id": "dbg-1",
            "upstream_request_id": "upstream-1",
            "trigger_message_id": "user-1",
            "transcript_anchor_kind": "assistant_tool_block",
            "transcript_anchor_message_id": "assistant-1",
            "transcript_anchor_tool_block_index": 2,
            "data": {"model": "GPT-5.4"},
        }
    )

    assert client.setex_calls[0][0] == "llm_debug:event_request_payload:upstream-1"
    assert client.setex_calls[0][2]["upstream_request_id"] == "upstream-1"
    assert client.setex_calls[0][2]["debug_request_id"] == "dbg-1"
    assert client.setex_calls[0][2]["trigger_message_id"] == "user-1"
    assert client.setex_calls[0][2]["transcript_anchor_kind"] == "assistant_tool_block"
    assert client.setex_calls[0][2]["transcript_anchor_message_id"] == "assistant-1"
    assert client.setex_calls[0][2]["transcript_anchor_tool_block_index"] == 2


def test_publish_debug_event_sync_falls_back_to_debug_request_id_when_upstream_is_missing(
    monkeypatch,
):
    client = _FakeRedisClient()
    monkeypatch.setattr(event_publisher, "_get_sync_redis", lambda: client)

    assert event_publisher.publish_debug_event_sync(
        {
            "event_id": "payload_2",
            "event_type": "llm_request_payload",
            "session_id": "session-1",
            "chat_id": "chat-1",
            "debug_request_id": "dbg-legacy",
            "data": {"model": "GPT-5.4"},
        }
    )

    assert client.setex_calls[0][0] == "llm_debug:event_request_payload:dbg-legacy"


def test_publish_debug_event_sync_falls_back_to_event_id_when_no_request_ids_exist(monkeypatch):
    client = _FakeRedisClient()
    monkeypatch.setattr(event_publisher, "_get_sync_redis", lambda: client)

    assert event_publisher.publish_debug_event_sync(
        {
            "event_id": "payload_3",
            "event_type": "llm_request_payload",
            "session_id": "session-1",
            "chat_id": "chat-1",
            "data": {"model": "GPT-5.4"},
        }
    )

    assert client.setex_calls[0][0] == "llm_debug:event_request_payload:payload_3"


def test_publish_request_start_extracts_anchor_metadata(monkeypatch):
    captured = {}

    async def fake_publish_debug_event(event):
        captured["event"] = event
        return True

    monkeypatch.setattr(event_publisher, "publish_debug_event", fake_publish_debug_event)

    metadata = {
        "message_id": "assistant-1",
        "debug_request_id": "dbg-1",
        "upstream_request_id": "upstream-1",
        "request_phase": "tool_followup",
        "followup_index": 2,
        "outer_message_id": "assistant-1",
        "trigger_message_id": "user-1",
        "transcript_anchor_kind": "assistant_tool_block",
        "transcript_anchor_message_id": "assistant-1",
        "transcript_anchor_tool_block_index": 2,
    }

    result = asyncio.run(
        event_publisher.publish_request_start(
            session_id="session-1",
            chat_id="chat-1",
            model="Claude Opus 4.6",
            base_model="Claude Opus 4.6",
            message_count=3,
            tool_ids=["tool-1"],
            skills=["skill-1"],
            metadata=metadata,
        )
    )

    assert result is True
    assert captured["event"]["debug_request_id"] == "dbg-1"
    assert captured["event"]["message_id"] == "assistant-1"
    assert captured["event"]["upstream_request_id"] == "upstream-1"
    assert captured["event"]["request_phase"] == "tool_followup"
    assert captured["event"]["followup_index"] == 2
    assert captured["event"]["outer_message_id"] == "assistant-1"
    assert captured["event"]["trigger_message_id"] == "user-1"
    assert captured["event"]["transcript_anchor_kind"] == "assistant_tool_block"
    assert captured["event"]["transcript_anchor_message_id"] == "assistant-1"
    assert captured["event"]["transcript_anchor_tool_block_index"] == 2
    assert "metadata" not in captured["event"]["data"]


def test_publish_request_payload_extracts_anchor_metadata_from_raw_payload(monkeypatch):
    captured = {}

    async def fake_publish_debug_event(event):
        captured["event"] = event
        return True

    monkeypatch.setattr(event_publisher, "publish_debug_event", fake_publish_debug_event)

    raw_payload = {
        "metadata": {
            "message_id": "assistant-2",
            "debug_request_id": "dbg-2",
            "upstream_request_id": "upstream-2",
            "request_phase": "tool_followup",
            "followup_index": "3",
            "outer_message_id": "assistant-2",
            "trigger_message_id": "user-2",
            "transcript_anchor_kind": "assistant_tool_block",
            "transcript_anchor_message_id": "assistant-2",
            "transcript_anchor_tool_block_index": "4",
        }
    }

    result = asyncio.run(
        event_publisher.publish_request_payload(
            session_id="session-1",
            chat_id="chat-1",
            model="Claude Opus 4.6",
            base_model="Claude Opus 4.6",
            messages=[{"role": "user", "content": "hello"}],
            tools=[{"id": "tool-2"}],
            raw_payload=raw_payload,
        )
    )

    assert result is True
    assert captured["event"]["debug_request_id"] == "dbg-2"
    assert captured["event"]["upstream_request_id"] == "upstream-2"
    assert captured["event"]["request_phase"] == "tool_followup"
    assert captured["event"]["followup_index"] == 3
    assert captured["event"]["outer_message_id"] == "assistant-2"
    assert captured["event"]["trigger_message_id"] == "user-2"
    assert captured["event"]["transcript_anchor_kind"] == "assistant_tool_block"
    assert captured["event"]["transcript_anchor_message_id"] == "assistant-2"
    assert captured["event"]["transcript_anchor_tool_block_index"] == 4
    assert captured["event"]["data"]["raw_payload"] == raw_payload


def test_publish_request_payload_preserves_request_local_tool_ids_and_skills(monkeypatch):
    captured = {}

    async def fake_publish_debug_event(event):
        captured["event"] = event
        return True

    monkeypatch.setattr(event_publisher, "publish_debug_event", fake_publish_debug_event)

    result = asyncio.run(
        event_publisher.publish_request_payload(
            session_id="session-1",
            chat_id="chat-1",
            model="Claude Sonnet 4.6",
            messages=[{"role": "user", "content": "hello"}],
            tools=[{"type": "function", "function": {"name": "google_workspace_get_events"}}],
            tool_ids=["server:skills", "server:google_workspace"],
            skills=["google-workspace"],
            raw_payload={"messages": [{"role": "user", "content": "hello"}]},
        )
    )

    assert result is True
    assert captured["event"]["data"]["tool_ids"] == [
        "server:skills",
        "server:google_workspace",
    ]
    assert captured["event"]["data"]["skills"] == ["google-workspace"]
