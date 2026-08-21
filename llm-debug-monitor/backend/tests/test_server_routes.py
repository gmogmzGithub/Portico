from fastapi.testclient import TestClient

from backend import server


def test_chat_requests_route_exposes_upstream_request_identity(monkeypatch):
    def fake_get_chat_requests(chat_id: str, limit: int, offset: int):
        assert chat_id == "chat-1"
        assert limit == 50
        assert offset == 0
        return (
            [
                {
                    "request_id": "upstream-1",
                    "timestamp": "2026-03-27T10:00:00Z",
                    "chat_id": "chat-1",
                    "message_id": "assistant-1",
                    "debug_request_id": "dbg-1",
                    "upstream_request_id": "upstream-1",
                    "model": "Claude Opus 4.6",
                    "base_model": "Claude Opus 4.6",
                    "task_name": None,
                    "is_auxiliary": False,
                    "request_phase": "tool_followup",
                    "followup_index": 2,
                    "outer_message_id": "assistant-1",
                    "trigger_message_id": "user-1",
                    "transcript_anchor_kind": "assistant_tool_block",
                    "transcript_anchor_message_id": "assistant-1",
                    "transcript_anchor_tool_block_index": 2,
                    "messages": [{"role": "user", "content": "hello"}],
                    "tools": [{"id": "tool-1"}],
                    "tool_ids": ["server:mcp-assistant", "server:google_workspace"],
                    "skills": ["calibration-host"],
                    "status": "complete",
                    "duration_ms": 321,
                    "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
                }
            ],
            1,
        )

    monkeypatch.setattr(server.event_store, "get_chat_requests", fake_get_chat_requests)

    client = TestClient(server.app)
    response = client.get("/api/chats/chat-1/requests")
    assert response.status_code == 200

    payload = response.json()
    assert payload["total"] == 1
    assert payload["requests"] == [
        {
            "request_id": "upstream-1",
            "timestamp": "2026-03-27T10:00:00Z",
            "chat_id": "chat-1",
            "message_id": "assistant-1",
            "debug_request_id": "dbg-1",
            "upstream_request_id": "upstream-1",
            "model": "Claude Opus 4.6",
            "base_model": "Claude Opus 4.6",
            "task_name": None,
            "is_auxiliary": False,
            "request_phase": "tool_followup",
            "followup_index": 2,
            "outer_message_id": "assistant-1",
            "trigger_message_id": "user-1",
            "transcript_anchor_kind": "assistant_tool_block",
            "transcript_anchor_message_id": "assistant-1",
            "transcript_anchor_tool_block_index": 2,
            "message_count": 1,
            "tool_count": 1,
            "status": "complete",
            "duration_ms": 321,
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
            "tool_ids": ["server:mcp-assistant", "server:google_workspace"],
            "skills": ["calibration-host"],
        }
    ]


def test_chat_requests_route_keeps_same_debug_request_id_requests_separate(monkeypatch):
    def fake_get_chat_requests(chat_id: str, limit: int, offset: int):
        assert chat_id == "chat-shared"
        return (
            [
                {
                    "request_id": "upstream-a",
                    "timestamp": "2026-03-27T10:00:00Z",
                    "chat_id": "chat-shared",
                    "message_id": "assistant-1",
                    "debug_request_id": "dbg-shared",
                    "upstream_request_id": "upstream-a",
                    "model": "Claude Opus 4.6",
                    "messages": [],
                    "tools": [],
                    "tool_ids": ["server:skills"],
                    "skills": [],
                    "status": "complete",
                },
                {
                    "request_id": "upstream-b",
                    "timestamp": "2026-03-27T10:00:01Z",
                    "chat_id": "chat-shared",
                    "message_id": "assistant-1",
                    "debug_request_id": "dbg-shared",
                    "upstream_request_id": "upstream-b",
                    "model": "Claude Opus 4.6",
                    "messages": [],
                    "tools": [{"id": "tool-1"}],
                    "tool_ids": ["server:skills", "server:google_workspace"],
                    "skills": ["calibration-host"],
                    "status": "complete",
                },
            ],
            2,
        )

    monkeypatch.setattr(server.event_store, "get_chat_requests", fake_get_chat_requests)

    client = TestClient(server.app)
    response = client.get("/api/chats/chat-shared/requests")
    assert response.status_code == 200

    payload = response.json()
    assert payload["total"] == 2
    assert [request["request_id"] for request in payload["requests"]] == [
        "upstream-a",
        "upstream-b",
    ]
    assert [request["debug_request_id"] for request in payload["requests"]] == [
        "dbg-shared",
        "dbg-shared",
    ]
    assert [request["tool_count"] for request in payload["requests"]] == [0, 1]
    assert [request["tool_ids"] for request in payload["requests"]] == [
        ["server:skills"],
        ["server:skills", "server:google_workspace"],
    ]


def test_request_detail_route_preserves_transcript_anchor_metadata(monkeypatch):
    async def fake_get_request_detail(request_id: str):
        assert request_id == "upstream-2"
        return {
            "request_id": "upstream-2",
            "timestamp": "2026-03-27T10:05:00Z",
            "chat_id": "chat-2",
            "message_id": "assistant-2",
            "debug_request_id": "dbg-2",
            "upstream_request_id": "upstream-2",
            "model": "Claude Opus 4.6",
            "base_model": "Claude Opus 4.6",
            "request_phase": "tool_followup",
            "followup_index": 3,
            "outer_message_id": "assistant-2",
            "trigger_message_id": "user-2",
            "transcript_anchor_kind": "assistant_tool_block",
            "transcript_anchor_message_id": "assistant-2",
            "transcript_anchor_tool_block_index": 3,
            "messages": [{"role": "user", "content": "hello"}],
            "tools": [{"id": "tool-1"}],
            "tool_ids": ["server:skills", "server:google_workspace", "server:agent-vm"],
            "skills": ["calibration-host"],
            "response": {
                "content": "Done",
                "tool_calls": [],
                "finish_reason": "stop",
                "usage": {
                    "prompt_tokens": 10,
                    "completion_tokens": 4,
                    "total_tokens": 14,
                },
                "thinking": "",
            },
            "status": "complete",
        }

    monkeypatch.setattr(server.event_store, "get_request_detail", fake_get_request_detail)

    client = TestClient(server.app)
    response = client.get("/api/requests/upstream-2")
    assert response.status_code == 200
    payload = response.json()
    assert payload["request"]["request_id"] == "upstream-2"
    assert payload["request"]["transcript_anchor_kind"] == "assistant_tool_block"
    assert payload["request"]["transcript_anchor_message_id"] == "assistant-2"
    assert payload["request"]["transcript_anchor_tool_block_index"] == 3
    assert payload["request"]["tool_ids"] == [
        "server:skills",
        "server:google_workspace",
        "server:agent-vm",
    ]
    assert payload["request"]["skills"] == ["calibration-host"]
    assert payload["request"]["response"]["content"] == "Done"
    assert payload["request"]["response"]["finish_reason"] == "stop"


def test_request_detail_route_returns_404_when_request_is_missing(monkeypatch):
    async def fake_get_request_detail(request_id: str):
        assert request_id == "missing-request"
        return None

    monkeypatch.setattr(server.event_store, "get_request_detail", fake_get_request_detail)

    client = TestClient(server.app)
    response = client.get("/api/requests/missing-request")
    assert response.status_code == 404
    assert response.json() == {"detail": "Request not found"}
