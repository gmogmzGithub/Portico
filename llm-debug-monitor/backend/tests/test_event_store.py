import asyncio
import json

from backend.redis_subscriber import EventStore


class _FakeAsyncRedisClient:
    def __init__(self, values=None):
        self.values = values or {}
        self.setex_calls = []

    async def get(self, key):
        return self.values.get(key)

    async def setex(self, key, ttl, payload):
        self.setex_calls.append((key, ttl, json.loads(payload)))


def test_event_store_matches_transformed_payloads_by_message_id_and_keeps_both_stages():
    store = EventStore()

    asyncio.run(
        store.process_event(
            {
                "event_id": "req_1",
                "event_type": "llm_request_start",
                "timestamp": "2026-03-17T16:00:00Z",
                "session_id": "session_1",
                "chat_id": "chat_1",
                "message_id": "message_1",
                "debug_request_id": "dbg_1",
                "data": {
                    "model": "cluck-cluck-foo-foo",
                    "base_model": "Claude Sonnet 4.6",
                    "message_count": 3,
                    "tool_ids": [],
                    "skills": [],
                },
            }
        )
    )

    asyncio.run(
        store.process_event(
            {
                "event_id": "payload_1",
                "event_type": "llm_request_payload",
                "timestamp": "2026-03-17T16:00:01Z",
                "session_id": "session_1",
                "chat_id": "chat_1",
                "data": {
                    "model": "cluck-cluck-foo-foo",
                    "base_model": "Claude Sonnet 4.6",
                    "messages": [
                        {"role": "system", "content": "agent prompt"},
                        {"role": "system", "content": "static context"},
                        {"role": "user", "content": "hello"},
                    ],
                    "raw_payload": {
                        "messages": [
                            {"role": "system", "content": "agent prompt"},
                            {"role": "system", "content": "static context"},
                            {"role": "user", "content": "hello"},
                        ]
                    },
                },
            }
        )
    )

    asyncio.run(
        store.process_event(
            {
                "event_id": "stage_1",
                "event_type": "llm_request_transformed",
                "timestamp": "2026-03-17T16:00:02Z",
                "session_id": "session_1",
                "chat_id": "chat_1",
                "message_id": "message_1",
                "debug_request_id": "dbg_1",
                "data": {
                    "model": "Claude Sonnet 4.6",
                    "api_path": "chat-completions",
                    "payload": {
                        "messages": [
                            {"role": "system", "content": "agent prompt"},
                            {"role": "system", "content": "static context"},
                            {"role": "user", "content": "hello"},
                        ]
                    },
                    "provider_headers_redacted": {"authorization": "Bearer <redacted>"},
                },
            }
        )
    )

    asyncio.run(
        store.process_event(
            {
                "event_id": "stage_2",
                "event_type": "llm_request_transformed",
                "timestamp": "2026-03-17T16:00:03Z",
                "session_id": "session_1",
                "chat_id": "chat_1",
                "message_id": "message_1",
                "debug_request_id": "dbg_1",
                "data": {
                    "model": "us.anthropic.claude-sonnet-4-6",
                    "api_path": "bedrock-converse",
                    "payload": {
                        "messages": [
                            {"role": "system", "content": "static context\n\nagent prompt"},
                            {"role": "user", "content": "hello"},
                        ]
                    },
                    "provider_headers_redacted": {"authorization": "Bearer <redacted>"},
                },
            }
        )
    )

    request = store._requests["dbg_1"]

    assert request["message_id"] == "message_1"
    assert request["debug_request_id"] == "dbg_1"
    assert [stage["api_path"] for stage in request["transformed_payloads"]] == [
        "chat-completions",
        "bedrock-converse",
    ]
    assert request["transformed_payloads"][1]["payload"]["messages"][0]["role"] == "system"


def test_event_store_falls_back_to_model_matching_when_message_id_is_missing():
    store = EventStore()

    asyncio.run(
        store.process_event(
            {
                "event_id": "req_2",
                "event_type": "llm_request_start",
                "timestamp": "2026-03-17T16:01:00Z",
                "session_id": "session_2",
                "chat_id": "chat_2",
                "data": {
                    "model": "gpt-5-mini",
                    "base_model": None,
                    "message_count": 1,
                    "tool_ids": [],
                    "skills": [],
                    "metadata": {},
                },
            }
        )
    )

    asyncio.run(
        store.process_event(
            {
                "event_id": "stage_3",
                "event_type": "llm_request_transformed",
                "timestamp": "2026-03-17T16:01:01Z",
                "session_id": "session_2",
                "chat_id": "chat_2",
                "data": {
                    "model": "gpt-5-mini",
                    "api_path": "responses",
                    "payload": {"input": [{"role": "user", "content": "hi"}]},
                },
            }
        )
    )

    request = store._requests["req_2"]

    assert request["transformed_payloads"] == [
        {
            "event_id": "stage_3",
            "api_path": "responses",
            "payload": {"input": [{"role": "user", "content": "hi"}]},
            "provider_headers_redacted": {},
            "timestamp": "2026-03-17T16:01:01Z",
        }
    ]


def test_event_store_keeps_same_chat_requests_separate_when_debug_request_ids_differ():
    store = EventStore()

    events = [
        {
            "event_id": "req_main",
            "event_type": "llm_request_start",
            "timestamp": "2026-03-17T16:02:00Z",
            "session_id": "session_3",
            "chat_id": "chat_3",
            "debug_request_id": "dbg_main",
            "data": {
                "model": "cluck-cluck-foo-foo",
                "base_model": "Claude Sonnet 4.6",
                "message_count": 1,
                "tool_ids": [],
                "skills": [],
                "metadata": {
                    "message_id": "message_shared",
                    "debug_request_id": "dbg_main",
                },
            },
        },
        {
            "event_id": "payload_main",
            "event_type": "llm_request_payload",
            "timestamp": "2026-03-17T16:02:01Z",
            "session_id": "session_3",
            "chat_id": "chat_3",
            "debug_request_id": "dbg_main",
            "data": {
                "model": "cluck-cluck-foo-foo",
                "base_model": "Claude Sonnet 4.6",
                "messages": [{"role": "user", "content": "hello"}],
                "raw_payload": {
                    "metadata": {
                        "message_id": "message_shared",
                        "debug_request_id": "dbg_main",
                    }
                },
            },
        },
        {
            "event_id": "req_title",
            "event_type": "llm_request_start",
            "timestamp": "2026-03-17T16:02:02Z",
            "session_id": "session_3",
            "chat_id": "chat_3",
            "debug_request_id": "dbg_title",
            "task_name": "title_generation",
            "data": {
                "model": "Claude Haiku 4.5",
                "base_model": None,
                "message_count": 1,
                "tool_ids": [],
                "skills": [],
                "metadata": {
                    "message_id": "message_shared",
                    "debug_request_id": "dbg_title",
                    "task": "title_generation",
                },
            },
        },
        {
            "event_id": "payload_title",
            "event_type": "llm_request_payload",
            "timestamp": "2026-03-17T16:02:03Z",
            "session_id": "session_3",
            "chat_id": "chat_3",
            "debug_request_id": "dbg_title",
            "task_name": "title_generation",
            "data": {
                "model": "Claude Haiku 4.5",
                "messages": [{"role": "user", "content": "Summarize this chat"}],
                "raw_payload": {
                    "metadata": {
                        "message_id": "message_shared",
                        "debug_request_id": "dbg_title",
                        "task": "title_generation",
                    }
                },
            },
        },
        {
            "event_id": "resp_title",
            "event_type": "llm_response_complete",
            "timestamp": "2026-03-17T16:02:04Z",
            "session_id": "session_3",
            "chat_id": "chat_3",
            "debug_request_id": "dbg_title",
            "task_name": "title_generation",
            "data": {
                "model": "Claude Haiku 4.5",
                "usage": {"prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 7},
                "finish_reason": "stop",
                "duration_ms": 150,
                "has_tool_calls": False,
            },
        },
        {
            "event_id": "resp_main",
            "event_type": "llm_response_complete",
            "timestamp": "2026-03-17T16:02:05Z",
            "session_id": "session_3",
            "chat_id": "chat_3",
            "debug_request_id": "dbg_main",
            "data": {
                "model": "cluck-cluck-foo-foo",
                "usage": {"prompt_tokens": 11, "completion_tokens": 3, "total_tokens": 14},
                "finish_reason": "stop",
                "duration_ms": 500,
                "has_tool_calls": False,
            },
        },
    ]

    for event in events:
        asyncio.run(store.process_event(event))

    assert set(store._requests.keys()) == {"dbg_main", "dbg_title"}

    main_request = store._requests["dbg_main"]
    title_request = store._requests["dbg_title"]

    assert main_request["model"] == "cluck-cluck-foo-foo"
    assert main_request["status"] == "complete"
    assert main_request["message_id"] == "message_shared"
    assert main_request["debug_request_id"] == "dbg_main"
    assert not main_request.get("is_auxiliary", False)

    assert title_request["model"] == "Claude Haiku 4.5"
    assert title_request["status"] == "complete"
    assert title_request["message_id"] == "message_shared"
    assert title_request["debug_request_id"] == "dbg_title"
    assert title_request["task_name"] == "title_generation"
    assert title_request["is_auxiliary"] is True


def test_event_store_creates_shell_for_transformed_only_request_with_debug_request_id():
    store = EventStore()

    asyncio.run(
        store.process_event(
            {
                "event_id": "stage_aux",
                "event_type": "llm_request_transformed",
                "timestamp": "2026-03-17T16:03:00Z",
                "session_id": "session_4",
                "chat_id": "chat_4",
                "message_id": "message_aux",
                "debug_request_id": "dbg_aux",
                "data": {
                    "model": "Claude Haiku 4.5",
                    "api_path": "bedrock-converse",
                    "payload": {
                        "messages": [{"role": "user", "content": "Summarize this chat"}],
                    },
                },
            }
        )
    )

    assert set(store._requests.keys()) == {"dbg_aux"}
    request = store._requests["dbg_aux"]

    assert request["model"] == "Claude Haiku 4.5"
    assert request["message_id"] == "message_aux"
    assert request["debug_request_id"] == "dbg_aux"
    assert request["status"] == "pending"
    assert request["transformed_payloads"] == [
        {
            "event_id": "stage_aux",
            "api_path": "bedrock-converse",
            "payload": {
                "messages": [{"role": "user", "content": "Summarize this chat"}],
            },
            "provider_headers_redacted": {},
            "timestamp": "2026-03-17T16:03:00Z",
        }
    ]


def test_event_store_keeps_main_request_when_auxiliary_transformed_payload_arrives_later():
    store = EventStore()

    events = [
        {
            "event_id": "req_main_2",
            "event_type": "llm_request_start",
            "timestamp": "2026-03-17T16:04:00Z",
            "session_id": "session_5",
            "chat_id": "chat_5",
            "debug_request_id": "dbg_opus",
            "data": {
                "model": "Claude Opus 4.6",
                "base_model": None,
                "message_count": 1,
                "tool_ids": [],
                "skills": [],
                "metadata": {
                    "message_id": "message_opus",
                    "debug_request_id": "dbg_opus",
                },
            },
        },
        {
            "event_id": "payload_main_2",
            "event_type": "llm_request_payload",
            "timestamp": "2026-03-17T16:04:01Z",
            "session_id": "session_5",
            "chat_id": "chat_5",
            "debug_request_id": "dbg_opus",
            "data": {
                "model": "Claude Opus 4.6",
                "messages": [{"role": "user", "content": "Hello assistant"}],
                "raw_payload": {
                    "metadata": {
                        "message_id": "message_opus",
                        "debug_request_id": "dbg_opus",
                    }
                },
            },
        },
        {
            "event_id": "resp_main_2",
            "event_type": "llm_response_complete",
            "timestamp": "2026-03-17T16:04:02Z",
            "session_id": "session_5",
            "chat_id": "chat_5",
            "debug_request_id": "dbg_opus",
            "data": {
                "model": "Claude Opus 4.6",
                "usage": {
                    "prompt_tokens": 10,
                    "completion_tokens": 4,
                    "total_tokens": 14,
                },
                "finish_reason": "stop",
                "duration_ms": 420,
                "has_tool_calls": False,
            },
        },
        {
            "event_id": "stage_aux_2",
            "event_type": "llm_request_transformed",
            "timestamp": "2026-03-17T16:04:03Z",
            "session_id": "session_5",
            "chat_id": "chat_5",
            "message_id": "message_title",
            "debug_request_id": "dbg_title_only",
            "task_name": "title_generation",
            "data": {
                "model": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
                "api_path": "bedrock-converse",
                "payload": {
                    "messages": [
                        {"role": "user", "content": "Summarize this chat"}
                    ]
                },
            },
        },
    ]

    for event in events:
        asyncio.run(store.process_event(event))

    assert set(store._requests.keys()) == {"dbg_opus", "dbg_title_only"}
    assert store._chats["chat_5"]["request_count"] == 2

    main_request = store._requests["dbg_opus"]
    aux_request = store._requests["dbg_title_only"]

    assert main_request["model"] == "Claude Opus 4.6"
    assert main_request["status"] == "complete"
    assert main_request["debug_request_id"] == "dbg_opus"
    assert main_request["message_id"] == "message_opus"

    assert aux_request["model"] == "us.anthropic.claude-haiku-4-5-20251001-v1:0"
    assert aux_request["status"] == "pending"
    assert aux_request["debug_request_id"] == "dbg_title_only"
    assert aux_request["message_id"] == "message_title"
    assert aux_request["task_name"] == "title_generation"
    assert aux_request["is_auxiliary"] is True
    assert aux_request["transformed_payloads"] == [
        {
            "event_id": "stage_aux_2",
            "api_path": "bedrock-converse",
            "payload": {
                "messages": [{"role": "user", "content": "Summarize this chat"}],
            },
            "provider_headers_redacted": {},
            "timestamp": "2026-03-17T16:04:03Z",
        }
    ]


def test_event_store_keeps_same_outer_turn_requests_separate_by_upstream_request_id():
    store = EventStore()

    events = []
    for index in range(4):
        upstream_request_id = f"upstream-main-{index}"
        timestamp = f"2026-03-17T16:05:0{index}Z"
        events.extend(
            [
                {
                    "event_id": f"req_main_{index}",
                    "event_type": "llm_request_start",
                    "timestamp": timestamp,
                    "session_id": "session_6",
                    "chat_id": "chat_6",
                    "debug_request_id": "dbg_outer_turn",
                    "upstream_request_id": upstream_request_id,
                    "data": {
                        "model": "Claude Opus 4.6",
                        "base_model": "Claude Opus 4.6",
                        "message_count": 3 + index,
                        "tool_ids": ["tool_a"] if index else [],
                        "skills": [],
                        "metadata": {
                            "message_id": "assistant_1",
                            "debug_request_id": "dbg_outer_turn",
                            "upstream_request_id": upstream_request_id,
                            "outer_message_id": "assistant_1",
                            "trigger_message_id": "user_1",
                            "request_phase": "tool_followup" if index else "initial",
                            "followup_index": index,
                            "transcript_anchor_kind": (
                                "assistant_tool_block" if index else "user_message"
                            ),
                            "transcript_anchor_message_id": (
                                "assistant_1" if index else "user_1"
                            ),
                            "transcript_anchor_tool_block_index": index if index else None,
                        },
                    },
                },
                {
                    "event_id": f"payload_main_{index}",
                    "event_type": "llm_request_payload",
                    "timestamp": f"2026-03-17T16:05:1{index}Z",
                    "session_id": "session_6",
                    "chat_id": "chat_6",
                    "debug_request_id": "dbg_outer_turn",
                    "upstream_request_id": upstream_request_id,
                    "data": {
                        "model": "Claude Opus 4.6",
                        "base_model": "Claude Opus 4.6",
                        "messages": [{"role": "user", "content": "What are my most important meetings this week?"}],
                        "tools": [{"id": "tool_a"}] if index else [],
                        "raw_payload": {
                            "metadata": {
                            "message_id": "assistant_1",
                            "debug_request_id": "dbg_outer_turn",
                            "upstream_request_id": upstream_request_id,
                            "outer_message_id": "assistant_1",
                            "trigger_message_id": "user_1",
                            "request_phase": "tool_followup" if index else "initial",
                            "followup_index": index,
                            "transcript_anchor_kind": (
                                "assistant_tool_block" if index else "user_message"
                            ),
                            "transcript_anchor_message_id": (
                                "assistant_1" if index else "user_1"
                            ),
                            "transcript_anchor_tool_block_index": index if index else None,
                        }
                    },
                },
                },
                {
                    "event_id": f"resp_main_{index}",
                    "event_type": "llm_response_complete",
                    "timestamp": f"2026-03-17T16:05:2{index}Z",
                    "session_id": "session_6",
                    "chat_id": "chat_6",
                    "debug_request_id": "dbg_outer_turn",
                    "upstream_request_id": upstream_request_id,
                    "data": {
                        "model": "Claude Opus 4.6",
                        "usage": {
                            "prompt_tokens": 10 + index,
                            "completion_tokens": 4,
                            "total_tokens": 14 + index,
                        },
                        "finish_reason": "tool_calls" if index < 3 else "stop",
                        "duration_ms": 200 + index,
                        "has_tool_calls": index < 3,
                    },
                },
            ]
        )

    events.extend(
        [
            {
                "event_id": "req_title_1",
                "event_type": "llm_request_start",
                "timestamp": "2026-03-17T16:05:50Z",
                "session_id": "session_6",
                "chat_id": "chat_6",
                "debug_request_id": "dbg_title_turn",
                "upstream_request_id": "upstream-title-1",
                "task_name": "title_generation",
                "data": {
                    "model": "Claude Haiku 4.5",
                    "base_model": "Claude Haiku 4.5",
                    "message_count": 1,
                    "tool_ids": [],
                    "skills": [],
                    "metadata": {
                        "message_id": "assistant_1",
                        "debug_request_id": "dbg_title_turn",
                        "upstream_request_id": "upstream-title-1",
                        "task": "title_generation",
                    },
                },
            },
            {
                "event_id": "payload_title_1",
                "event_type": "llm_request_payload",
                "timestamp": "2026-03-17T16:05:51Z",
                "session_id": "session_6",
                "chat_id": "chat_6",
                "debug_request_id": "dbg_title_turn",
                "upstream_request_id": "upstream-title-1",
                "task_name": "title_generation",
                "data": {
                    "model": "Claude Haiku 4.5",
                    "messages": [{"role": "user", "content": "Summarize this chat"}],
                    "raw_payload": {
                        "metadata": {
                            "message_id": "assistant_1",
                            "debug_request_id": "dbg_title_turn",
                            "upstream_request_id": "upstream-title-1",
                            "task": "title_generation",
                        }
                    },
                },
            },
        ]
    )

    for event in events:
        asyncio.run(store.process_event(event))

    assert set(store._requests.keys()) == {
        "upstream-main-0",
        "upstream-main-1",
        "upstream-main-2",
        "upstream-main-3",
        "upstream-title-1",
    }
    assert store._chats["chat_6"]["request_count"] == 5

    main_requests = [store._requests[f"upstream-main-{index}"] for index in range(4)]
    assert [request["followup_index"] for request in main_requests] == [0, 1, 2, 3]
    assert all(request["debug_request_id"] == "dbg_outer_turn" for request in main_requests)
    assert all(request["outer_message_id"] == "assistant_1" for request in main_requests)
    assert [request["transcript_anchor_kind"] for request in main_requests] == [
        "user_message",
        "assistant_tool_block",
        "assistant_tool_block",
        "assistant_tool_block",
    ]
    assert [request["transcript_anchor_message_id"] for request in main_requests] == [
        "user_1",
        "assistant_1",
        "assistant_1",
        "assistant_1",
    ]
    assert [request["transcript_anchor_tool_block_index"] for request in main_requests] == [
        None,
        1,
        2,
        3,
    ]
    assert [request["status"] for request in main_requests] == [
        "complete",
        "complete",
        "complete",
        "complete",
    ]

    title_request = store._requests["upstream-title-1"]
    assert title_request["task_name"] == "title_generation"
    assert title_request["is_auxiliary"] is True
    assert title_request["debug_request_id"] == "dbg_title_turn"
    assert title_request["upstream_request_id"] == "upstream-title-1"


def test_event_store_matches_transformed_payloads_by_upstream_request_id_before_debug_request_id():
    store = EventStore()

    for upstream_request_id in ("upstream-1", "upstream-2"):
        asyncio.run(
            store.process_event(
                {
                    "event_id": f"req_{upstream_request_id}",
                    "event_type": "llm_request_start",
                    "timestamp": "2026-03-17T16:06:00Z",
                    "session_id": "session_7",
                    "chat_id": "chat_7",
                    "debug_request_id": "dbg-shared",
                    "upstream_request_id": upstream_request_id,
                    "data": {
                        "model": "Claude Opus 4.6",
                        "base_model": "Claude Opus 4.6",
                        "message_count": 2,
                        "tool_ids": [],
                        "skills": [],
                        "metadata": {
                            "message_id": "assistant_2",
                            "debug_request_id": "dbg-shared",
                            "upstream_request_id": upstream_request_id,
                            "trigger_message_id": "user_2",
                        },
                    },
                }
            )
        )

    asyncio.run(
        store.process_event(
            {
                "event_id": "stage_upstream_2",
                "event_type": "llm_request_transformed",
                "timestamp": "2026-03-17T16:06:01Z",
                "session_id": "session_7",
                "chat_id": "chat_7",
                "message_id": "assistant_2",
                "debug_request_id": "dbg-shared",
                "upstream_request_id": "upstream-2",
                "data": {
                    "model": "Claude Opus 4.6",
                    "api_path": "bedrock-converse",
                    "payload": {
                        "messages": [{"role": "user", "content": "hello"}],
                    },
                },
            }
        )
    )

    assert store._requests["upstream-1"]["transformed_payloads"] == []
    assert store._requests["upstream-2"]["trigger_message_id"] == "user_2"
    assert store._requests["upstream-2"]["transformed_payloads"] == [
        {
            "event_id": "stage_upstream_2",
            "api_path": "bedrock-converse",
            "payload": {"messages": [{"role": "user", "content": "hello"}]},
            "provider_headers_redacted": {},
            "timestamp": "2026-03-17T16:06:01Z",
        }
    ]


def test_event_store_preserves_trigger_message_id_from_request_events_and_transformed_payloads():
    store = EventStore()

    asyncio.run(
        store.process_event(
            {
                "event_id": "req_trigger",
                "event_type": "llm_request_start",
                "timestamp": "2026-03-17T16:07:00Z",
                "session_id": "session_8",
                "chat_id": "chat_8",
                "debug_request_id": "dbg-trigger",
                "upstream_request_id": "upstream-trigger",
                "data": {
                    "model": "Claude Opus 4.6",
                    "base_model": "Claude Opus 4.6",
                    "message_count": 2,
                    "tool_ids": [],
                    "skills": [],
                    "metadata": {
                        "message_id": "assistant_8",
                        "debug_request_id": "dbg-trigger",
                        "upstream_request_id": "upstream-trigger",
                        "outer_message_id": "assistant_8",
                        "trigger_message_id": "user_8",
                        "transcript_anchor_kind": "assistant_tool_block",
                        "transcript_anchor_message_id": "assistant_8",
                        "transcript_anchor_tool_block_index": 2,
                    },
                },
            }
        )
    )

    asyncio.run(
        store.process_event(
            {
                "event_id": "stage_trigger",
                "event_type": "llm_request_transformed",
                "timestamp": "2026-03-17T16:07:01Z",
                "session_id": "session_8",
                "chat_id": "chat_8",
                "message_id": "assistant_8",
                "debug_request_id": "dbg-trigger",
                "upstream_request_id": "upstream-trigger",
                "trigger_message_id": "user_8",
                "transcript_anchor_kind": "assistant_tool_block",
                "transcript_anchor_message_id": "assistant_8",
                "transcript_anchor_tool_block_index": 2,
                "data": {
                    "model": "Claude Opus 4.6",
                    "api_path": "bedrock-converse",
                    "payload": {
                        "messages": [{"role": "user", "content": "hello"}],
                    },
                },
            }
        )
    )

    request = store._requests["upstream-trigger"]
    assert request["message_id"] == "assistant_8"
    assert request["outer_message_id"] == "assistant_8"
    assert request["trigger_message_id"] == "user_8"
    assert request["transcript_anchor_kind"] == "assistant_tool_block"
    assert request["transcript_anchor_message_id"] == "assistant_8"
    assert request["transcript_anchor_tool_block_index"] == 2
    assert request["transformed_payloads"][0]["api_path"] == "bedrock-converse"


def test_event_store_creates_payload_only_request_and_parses_string_anchor_indices():
    store = EventStore()

    asyncio.run(
        store.process_event(
            {
                "event_id": "payload_only",
                "event_type": "llm_request_payload",
                "timestamp": "2026-03-17T16:08:00Z",
                "session_id": "session_9",
                "chat_id": "chat_9",
                "data": {
                    "model": "Claude Opus 4.6",
                    "messages": [{"role": "user", "content": "hello"}],
                    "tools": [{"id": "tool_a"}],
                    "raw_payload": {
                        "metadata": {
                            "message_id": "assistant_9",
                            "debug_request_id": "dbg_9",
                            "upstream_request_id": "upstream_9",
                            "request_phase": "tool_followup",
                            "followup_index": "3",
                            "outer_message_id": "assistant_9",
                            "trigger_message_id": "user_9",
                            "transcript_anchor_kind": "assistant_tool_block",
                            "transcript_anchor_message_id": "assistant_9",
                            "transcript_anchor_tool_block_index": "4",
                        }
                    },
                },
            }
        )
    )

    request = store._requests["upstream_9"]
    assert request["message_id"] == "assistant_9"
    assert request["debug_request_id"] == "dbg_9"
    assert request["upstream_request_id"] == "upstream_9"
    assert request["request_phase"] == "tool_followup"
    assert request["followup_index"] == 3
    assert request["outer_message_id"] == "assistant_9"
    assert request["trigger_message_id"] == "user_9"
    assert request["transcript_anchor_kind"] == "assistant_tool_block"
    assert request["transcript_anchor_message_id"] == "assistant_9"
    assert request["transcript_anchor_tool_block_index"] == 4
    assert request["status"] == "streaming"
    assert len(request["messages"]) == 1
    assert len(request["tools"]) == 1


def test_event_store_preserves_existing_anchor_when_later_events_omit_anchor_fields():
    store = EventStore()

    asyncio.run(
        store.process_event(
            {
                "event_id": "req_anchor",
                "event_type": "llm_request_start",
                "timestamp": "2026-03-17T16:09:00Z",
                "session_id": "session_10",
                "chat_id": "chat_10",
                "debug_request_id": "dbg_10",
                "upstream_request_id": "upstream_10",
                "data": {
                    "model": "Claude Opus 4.6",
                    "base_model": "Claude Opus 4.6",
                    "message_count": 2,
                    "tool_ids": [],
                    "skills": [],
                    "metadata": {
                        "message_id": "assistant_10",
                        "debug_request_id": "dbg_10",
                        "upstream_request_id": "upstream_10",
                        "request_phase": "initial",
                        "outer_message_id": "assistant_10",
                        "trigger_message_id": "user_10",
                        "transcript_anchor_kind": "user_message",
                        "transcript_anchor_message_id": "user_10",
                    },
                },
            }
        )
    )

    asyncio.run(
        store.process_event(
            {
                "event_id": "resp_anchor",
                "event_type": "llm_response_complete",
                "timestamp": "2026-03-17T16:09:02Z",
                "session_id": "session_10",
                "chat_id": "chat_10",
                "debug_request_id": "dbg_10",
                "upstream_request_id": "upstream_10",
                "data": {
                    "model": "Claude Opus 4.6",
                    "usage": {"prompt_tokens": 12},
                    "finish_reason": "stop",
                    "duration_ms": 250,
                    "has_tool_calls": False,
                },
            }
        )
    )

    request = store._requests["upstream_10"]
    assert request["transcript_anchor_kind"] == "user_message"
    assert request["transcript_anchor_message_id"] == "user_10"
    assert request["transcript_anchor_tool_block_index"] is None
    assert request["status"] == "complete"
    assert request["usage"] == {"prompt_tokens": 12}


def test_event_store_reads_transformed_payload_metadata_and_preserves_zero_indices():
    store = EventStore()

    asyncio.run(
        store.process_event(
            {
                "event_id": "stage_zero",
                "event_type": "llm_request_transformed",
                "timestamp": "2026-03-17T16:09:30Z",
                "session_id": "session_zero",
                "chat_id": "chat_zero",
                "data": {
                    "model": "Claude Opus 4.6",
                    "api_path": "responses",
                    "payload": {
                        "messages": [{"role": "user", "content": "hello"}],
                        "metadata": {
                            "message_id": "assistant_zero",
                            "debug_request_id": "dbg_zero",
                            "upstream_request_id": "upstream_zero",
                            "request_phase": "tool_followup",
                            "followup_index": 0,
                            "outer_message_id": "assistant_zero",
                            "trigger_message_id": "user_zero",
                            "transcript_anchor_kind": "assistant_tool_block",
                            "transcript_anchor_message_id": "assistant_zero",
                            "transcript_anchor_tool_block_index": 0,
                        },
                    },
                },
            }
        )
    )

    asyncio.run(
        store.process_event(
            {
                "event_id": "resp_zero",
                "event_type": "llm_response_complete",
                "timestamp": "2026-03-17T16:09:31Z",
                "session_id": "session_zero",
                "chat_id": "chat_zero",
                "upstream_request_id": "upstream_zero",
                "data": {
                    "model": "Claude Opus 4.6",
                    "duration_ms": 140,
                    "finish_reason": "stop",
                    "usage": {"prompt_tokens": 10},
                },
            }
        )
    )

    request = store._requests["upstream_zero"]
    assert request["message_id"] == "assistant_zero"
    assert request["request_phase"] == "tool_followup"
    assert request["followup_index"] == 0
    assert request["outer_message_id"] == "assistant_zero"
    assert request["trigger_message_id"] == "user_zero"
    assert request["transcript_anchor_kind"] == "assistant_tool_block"
    assert request["transcript_anchor_message_id"] == "assistant_zero"
    assert request["transcript_anchor_tool_block_index"] == 0
    assert request["status"] == "complete"


def test_event_store_persists_nested_response_payload_on_response_complete():
    store = EventStore()

    asyncio.run(
        store.process_event(
            {
                "event_id": "payload_resp",
                "event_type": "llm_request_payload",
                "timestamp": "2026-03-29T10:00:00Z",
                "session_id": "session_resp",
                "chat_id": "chat_resp",
                "debug_request_id": "dbg_resp",
                "upstream_request_id": "upstream_resp",
                "data": {
                    "model": "Claude Opus 4.6",
                    "messages": [{"role": "user", "content": "hello"}],
                    "tools": [],
                    "raw_payload": {
                        "metadata": {
                            "message_id": "assistant_resp",
                            "debug_request_id": "dbg_resp",
                            "upstream_request_id": "upstream_resp",
                        }
                    },
                },
            }
        )
    )

    asyncio.run(
        store.process_event(
            {
                "event_id": "resp_complete",
                "event_type": "llm_response_complete",
                "timestamp": "2026-03-29T10:00:01Z",
                "session_id": "session_resp",
                "chat_id": "chat_resp",
                "debug_request_id": "dbg_resp",
                "upstream_request_id": "upstream_resp",
                "data": {
                    "model": "Claude Opus 4.6",
                    "duration_ms": 321,
                    "finish_reason": "stop",
                    "usage": {
                        "prompt_tokens": 10,
                        "completion_tokens": 5,
                        "total_tokens": 15,
                    },
                    "response_content": "Final answer",
                    "thinking_content": "chain",
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "type": "function",
                            "function": {"name": "foo", "arguments": "{}"},
                        }
                    ],
                },
            }
        )
    )

    request = store._requests["upstream_resp"]
    assert request["status"] == "complete"
    assert request["duration_ms"] == 321
    assert request["usage"] == {
        "prompt_tokens": 10,
        "completion_tokens": 5,
        "total_tokens": 15,
    }
    assert request["response"] == {
        "content": "Final answer",
        "tool_calls": [
            {
                "id": "call_1",
                "type": "function",
                "function": {"name": "foo", "arguments": "{}"},
            }
        ],
        "finish_reason": "stop",
        "usage": {
            "prompt_tokens": 10,
            "completion_tokens": 5,
            "total_tokens": 15,
        },
        "thinking": "chain",
    }


def test_get_request_detail_backfills_missing_response_from_recent_events():
    store = EventStore()
    store._requests["upstream_backfill"] = {
        "request_id": "upstream_backfill",
        "chat_id": "chat_backfill",
        "session_id": "session_backfill",
        "timestamp": "2026-03-29T10:05:00Z",
        "model": "Claude Opus 4.6",
        "message_id": "assistant_backfill",
        "debug_request_id": "dbg_backfill",
        "upstream_request_id": "upstream_backfill",
        "status": "streaming",
        "messages": [],
        "tools": [],
        "parameters": {},
        "raw_payload": {},
        "transformed_payloads": [],
    }
    store._events.append(
        {
            "event_id": "resp_backfill",
            "event_type": "llm_response_complete",
            "timestamp": "2026-03-29T10:05:01Z",
            "session_id": "session_backfill",
            "chat_id": "chat_backfill",
            "debug_request_id": "dbg_backfill",
            "upstream_request_id": "upstream_backfill",
            "data": {
                "model": "Claude Opus 4.6",
                "duration_ms": 250,
                "finish_reason": "stop",
                "usage": {"prompt_tokens": 8, "completion_tokens": 2, "total_tokens": 10},
                "response_content": "Recovered response",
                "tool_calls": [],
                "thinking_content": "",
            },
        }
    )

    request = asyncio.run(store.get_request_detail("upstream_backfill"))

    assert request is not None
    assert request["status"] == "complete"
    assert request["duration_ms"] == 250
    assert request["usage"] == {
        "prompt_tokens": 8,
        "completion_tokens": 2,
        "total_tokens": 10,
    }
    assert request["response"] == {
        "content": "Recovered response",
        "tool_calls": [],
        "finish_reason": "stop",
        "usage": {
            "prompt_tokens": 8,
            "completion_tokens": 2,
            "total_tokens": 10,
        },
        "thinking": "",
    }


def test_event_store_hydrates_compact_payload_events_from_stored_redis_payload():
    store = EventStore()
    store._client = _FakeAsyncRedisClient(
        {
            "llm_debug:event_request_payload:upstream_compact": json.dumps(
                {
                    "event_id": "payload_compact",
                    "event_type": "llm_request_payload",
                    "chat_id": "chat_compact",
                    "upstream_request_id": "upstream_compact",
                    "debug_request_id": "dbg_compact",
                    "data": {
                        "model": "cluck",
                        "base_model": "Claude Haiku 4.5",
                        "tool_ids": ["tool-1"],
                        "skills": ["skill-1"],
                        "temperature": 0.2,
                        "max_tokens": 123,
                        "reasoning_effort": "medium",
                        "reasoning_config": {"ui_effort": "medium"},
                        "raw_payload": {
                            "metadata": {
                                "message_id": "message_compact",
                                "debug_request_id": "dbg_compact",
                                "upstream_request_id": "upstream_compact",
                            },
                            "messages": [{"role": "user", "content": "hello"}],
                            "tools": [
                                {"type": "function", "function": {"name": "foo"}}
                            ],
                        },
                    },
                }
            )
        }
    )

    asyncio.run(
        store.process_event(
            {
                "event_id": "req_compact",
                "event_type": "llm_request_start",
                "timestamp": "2026-03-29T10:10:00Z",
                "session_id": "session_compact",
                "chat_id": "chat_compact",
                "debug_request_id": "dbg_compact",
                "upstream_request_id": "upstream_compact",
                "data": {
                    "model": "cluck",
                    "base_model": "Claude Haiku 4.5",
                    "message_count": 1,
                    "tool_ids": [],
                    "skills": [],
                    "metadata": {"message_id": "message_compact"},
                },
            }
        )
    )

    asyncio.run(
        store.process_event(
            {
                "event_id": "payload_compact",
                "event_type": "llm_request_payload",
                "timestamp": "2026-03-29T10:10:01Z",
                "session_id": "session_compact",
                "chat_id": "chat_compact",
                "debug_request_id": "dbg_compact",
                "upstream_request_id": "upstream_compact",
                "data": {
                    "model": "cluck",
                    "base_model": "Claude Haiku 4.5",
                    "message_count": 1,
                    "tool_count": 1,
                    "raw_payload_stored": True,
                },
            }
        )
    )

    request = store._requests["upstream_compact"]
    assert request["status"] == "streaming"
    assert request["messages"] == [{"role": "user", "content": "hello"}]
    assert request["tools"] == [{"type": "function", "function": {"name": "foo"}}]
    assert request["tool_ids"] == ["tool-1"]
    assert request["skills"] == ["skill-1"]
    assert request["raw_payload"]["messages"] == [
        {"role": "user", "content": "hello"}
    ]


def test_event_store_hydrates_transformed_requests_from_stored_payload_when_pubsub_payload_is_missed():
    store = EventStore()
    store._client = _FakeAsyncRedisClient(
        {
            "llm_debug:event_request_payload:upstream_transformed": json.dumps(
                {
                    "event_id": "payload_transformed",
                    "event_type": "llm_request_payload",
                    "chat_id": "chat_transformed",
                    "upstream_request_id": "upstream_transformed",
                    "debug_request_id": "dbg_transformed",
                    "data": {
                        "model": "cluck",
                        "base_model": "Claude Haiku 4.5",
                        "tool_ids": [],
                        "skills": [],
                        "raw_payload": {
                            "metadata": {
                                "message_id": "message_transformed",
                                "debug_request_id": "dbg_transformed",
                                "upstream_request_id": "upstream_transformed",
                            },
                            "messages": [{"role": "user", "content": "hello"}],
                        },
                    },
                }
            )
        }
    )

    asyncio.run(
        store.process_event(
            {
                "event_id": "stage_transformed",
                "event_type": "llm_request_transformed",
                "timestamp": "2026-03-29T10:11:00Z",
                "session_id": "session_transformed",
                "chat_id": "chat_transformed",
                "message_id": "message_transformed",
                "debug_request_id": "dbg_transformed",
                "upstream_request_id": "upstream_transformed",
                "data": {
                    "model": "Claude Haiku 4.5",
                    "api_path": "chat-completions",
                    "payload": {"messages": [{"role": "user", "content": "hello"}]},
                },
            }
        )
    )

    request = store._requests["upstream_transformed"]
    assert request["model"] == "cluck"
    assert request["base_model"] == "Claude Haiku 4.5"
    assert request["messages"] == [{"role": "user", "content": "hello"}]
    assert request["status"] == "streaming"


def test_event_store_hydrates_compact_response_events_from_stored_redis_response():
    store = EventStore()
    store._client = _FakeAsyncRedisClient(
        {
            "llm_debug:event_response_complete:upstream_response": json.dumps(
                {
                    "event_id": "resp_stored",
                    "event_type": "llm_response_complete",
                    "chat_id": "chat_response",
                    "upstream_request_id": "upstream_response",
                    "debug_request_id": "dbg_response",
                    "data": {
                        "model": "cluck",
                        "duration_ms": 250,
                        "finish_reason": "stop",
                        "usage": {"prompt_tokens": 8, "completion_tokens": 2},
                        "response_content": "Cluck cluck",
                        "tool_calls": [],
                        "thinking_content": "",
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
        }
    )

    asyncio.run(
        store.process_event(
            {
                "event_id": "req_response",
                "event_type": "llm_request_start",
                "timestamp": "2026-03-29T10:12:00Z",
                "session_id": "session_response",
                "chat_id": "chat_response",
                "debug_request_id": "dbg_response",
                "upstream_request_id": "upstream_response",
                "data": {
                    "model": "cluck",
                    "base_model": "Claude Haiku 4.5",
                    "message_count": 1,
                    "tool_ids": [],
                    "skills": [],
                    "metadata": {},
                },
            }
        )
    )

    asyncio.run(
        store.process_event(
            {
                "event_id": "resp_compact",
                "event_type": "llm_response_complete",
                "timestamp": "2026-03-29T10:12:01Z",
                "session_id": "session_response",
                "chat_id": "chat_response",
                "debug_request_id": "dbg_response",
                "upstream_request_id": "upstream_response",
                "data": {
                    "model": "cluck",
                    "usage": {"prompt_tokens": 8, "completion_tokens": 2},
                    "finish_reason": "stop",
                    "duration_ms": 250,
                    "response_stored": True,
                },
            }
        )
    )

    request = store._requests["upstream_response"]
    assert request["status"] == "complete"
    assert request["response"] == {
        "content": "Cluck cluck",
        "tool_calls": [],
        "finish_reason": "stop",
        "usage": {"prompt_tokens": 8, "completion_tokens": 2},
        "thinking": "",
        "ultra_audit": {
            "child_agent_count": 2,
            "tool_call_count": 1,
            "child_tool_call_count": 1,
            "tool_result_count": 1,
            "continuation_count": 1,
            "arguments_logged": False,
            "results_logged": False,
        },
    }


def test_event_store_tracks_background_anchor_for_auxiliary_requests():
    store = EventStore()

    asyncio.run(
        store.process_event(
            {
                "event_id": "req_aux",
                "event_type": "llm_request_start",
                "timestamp": "2026-03-17T16:10:00Z",
                "session_id": "session_11",
                "chat_id": "chat_11",
                "debug_request_id": "dbg_aux",
                "upstream_request_id": "upstream_aux",
                "task_name": "title_generation",
                "data": {
                    "model": "Claude Haiku 4.5",
                    "base_model": "Claude Haiku 4.5",
                    "message_count": 1,
                    "tool_ids": [],
                    "skills": [],
                    "metadata": {
                        "message_id": "assistant_11",
                        "debug_request_id": "dbg_aux",
                        "upstream_request_id": "upstream_aux",
                        "task": "title_generation",
                        "transcript_anchor_kind": "background",
                    },
                },
            }
        )
    )

    request = store._requests["upstream_aux"]
    assert request["task_name"] == "title_generation"
    assert request["is_auxiliary"] is True
    assert request["transcript_anchor_kind"] == "background"
    assert request["transcript_anchor_message_id"] is None
    assert request["transcript_anchor_tool_block_index"] is None


def test_event_store_rekeys_legacy_debug_id_request_when_payload_introduces_upstream_id():
    store = EventStore()

    asyncio.run(
        store.process_event(
            {
                "event_id": "req_legacy",
                "event_type": "llm_request_start",
                "timestamp": "2026-03-27T11:00:00Z",
                "session_id": "session_legacy",
                "chat_id": "chat_legacy",
                "debug_request_id": "dbg_legacy",
                "data": {
                    "model": "Claude Opus 4.6",
                    "base_model": "Claude Opus 4.6",
                    "message_count": 1,
                    "tool_ids": [],
                    "skills": [],
                    "metadata": {
                        "message_id": "assistant_legacy",
                        "debug_request_id": "dbg_legacy",
                        "trigger_message_id": "user_legacy",
                        "transcript_anchor_kind": "user_message",
                        "transcript_anchor_message_id": "user_legacy",
                    },
                },
            }
        )
    )

    asyncio.run(
        store.process_event(
            {
                "event_id": "payload_legacy",
                "event_type": "llm_request_payload",
                "timestamp": "2026-03-27T11:00:01Z",
                "session_id": "session_legacy",
                "chat_id": "chat_legacy",
                "debug_request_id": "dbg_legacy",
                "data": {
                    "model": "Claude Opus 4.6",
                    "base_model": "Claude Opus 4.6",
                    "messages": [{"role": "user", "content": "hello"}],
                    "tools": [],
                    "raw_payload": {
                        "metadata": {
                            "message_id": "assistant_legacy",
                            "debug_request_id": "dbg_legacy",
                            "upstream_request_id": "upstream_legacy",
                            "request_phase": "initial",
                            "trigger_message_id": "user_legacy",
                            "transcript_anchor_kind": "user_message",
                            "transcript_anchor_message_id": "user_legacy",
                        }
                    },
                },
            }
        )
    )

    assert "dbg_legacy" not in store._requests
    assert "upstream_legacy" in store._requests
    request = store._requests["upstream_legacy"]
    assert request["debug_request_id"] == "dbg_legacy"
    assert request["upstream_request_id"] == "upstream_legacy"
    assert request["trigger_message_id"] == "user_legacy"
    assert request["transcript_anchor_kind"] == "user_message"


def test_event_store_uses_debug_request_id_for_legacy_transformed_payloads_without_upstream_ids():
    store = EventStore()

    asyncio.run(
        store.process_event(
            {
                "event_id": "req_transform_legacy",
                "event_type": "llm_request_start",
                "timestamp": "2026-03-27T11:05:00Z",
                "session_id": "session_transform_legacy",
                "chat_id": "chat_transform_legacy",
                "debug_request_id": "dbg_transform_legacy",
                "data": {
                    "model": "Claude Opus 4.6",
                    "base_model": "Claude Opus 4.6",
                    "message_count": 1,
                    "tool_ids": [],
                    "skills": [],
                    "metadata": {
                        "message_id": "assistant_transform_legacy",
                        "debug_request_id": "dbg_transform_legacy",
                    },
                },
            }
        )
    )

    asyncio.run(
        store.process_event(
            {
                "event_id": "stage_transform_legacy",
                "event_type": "llm_request_transformed",
                "timestamp": "2026-03-27T11:05:01Z",
                "session_id": "session_transform_legacy",
                "chat_id": "chat_transform_legacy",
                "message_id": "assistant_transform_legacy",
                "debug_request_id": "dbg_transform_legacy",
                "data": {
                    "model": "Claude Opus 4.6",
                    "api_path": "chat-completions",
                    "payload": {"messages": [{"role": "user", "content": "legacy"}]},
                },
            }
        )
    )

    request = store._requests["dbg_transform_legacy"]
    assert request["debug_request_id"] == "dbg_transform_legacy"
    assert request["transformed_payloads"] == [
        {
            "event_id": "stage_transform_legacy",
            "api_path": "chat-completions",
            "payload": {"messages": [{"role": "user", "content": "legacy"}]},
            "provider_headers_redacted": {},
            "timestamp": "2026-03-27T11:05:01Z",
        }
    ]
