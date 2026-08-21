import asyncio
import ast
import copy
from pathlib import Path
import sys
from types import ModuleType
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, patch


REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src/patches/backend"))
MIDDLEWARE_PATH = (
    REPO_ROOT / "src/patches/backend/open_webui/utils/middleware.py"
)
CHATS_ROUTER_PATH = REPO_ROOT / "src/patches/backend/open_webui/routers/chats.py"
MAIN_PATH = REPO_ROOT / "src/patches/backend/open_webui/main.py"

import open_webui.utils.pending_chat_work as pending_chat_work_module  # noqa: E402
from open_webui.utils.pending_chat_work import (  # noqa: E402
    EMPTY_PENDING_CHAT_WORK_TOMBSTONE_TTL_SECONDS,
    append_queued_prompt,
    append_user_steer_content_block,
    build_background_dispatch_request_metadata,
    build_background_task_request_context_defaults,
    is_background_turn_branch_persisted,
    branch_has_replayed_tool_history,
    build_background_assistant_message,
    chat_payload_has_active_current_turn,
    consume_pending_steer,
    ensure_pending_steer_is_active,
    get_next_dispatchable_queued_prompt,
    inject_pending_steer_into_continue_messages,
    inject_pending_steer_into_followup_messages,
    insert_background_dispatch_messages,
    load_pending_chat_work_state,
    mark_chat_payload_message_terminal,
    maybe_backfill_pending_dispatch_tool_ids,
    merge_top_level_files,
    pending_work_item_to_request_message,
    repair_missing_background_turn_branch_in_chat_payload,
    repair_missing_parent_message_in_chat_payload,
    replace_pending_steer,
    restore_pending_chat_item_after_dispatch_failure,
    run_pending_chat_work_drain,
    update_queued_prompt,
)


class FakeAsyncRedis:
    def __init__(self):
        self.store = {}
        self.expirations = {}

    async def get(self, key):
        return self.store.get(key)

    async def set(self, key, value, ex=None, nx=False):
        if nx and key in self.store:
            return False
        self.store[key] = value
        if ex is not None:
            self.expirations[key] = ex
        elif key in self.expirations:
            del self.expirations[key]
        return True

    async def delete(self, key):
        self.store.pop(key, None)
        self.expirations.pop(key, None)
        return 1


def make_request(redis_client):
    return SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(redis=redis_client, MODELS={}))
    )


def make_user(user_id: str = "user-1"):
    return SimpleNamespace(id=user_id)


def _middleware_source_segment(start_marker: str, end_marker: str) -> str:
    source = MIDDLEWARE_PATH.read_text(encoding="utf-8")
    start = source.index(start_marker)
    end = source.index(end_marker, start)
    return source[start:end]


def _get_message_list(messages_map, current_id):
    ordered = []
    cursor = current_id
    visited = set()

    while cursor and cursor not in visited and cursor in messages_map:
        ordered.append(messages_map[cursor])
        visited.add(cursor)
        cursor = messages_map[cursor].get("parentId")

    return list(reversed(ordered))


def _load_chat_merge_helpers():
    source = CHATS_ROUTER_PATH.read_text(encoding="utf-8")
    start = source.index("def _usage_to_int")
    end = source.index("############################\n# MCP Server Icon", start)
    namespace = {
        "copy": copy,
        "Any": Any,
        "get_message_list": _get_message_list,
        "log": SimpleNamespace(exception=lambda *args, **kwargs: None),
    }
    exec(source[start:end], namespace)
    return (
        namespace["merge_whole_chat_save_with_existing_chat"],
        namespace["rebuild_flat_messages_from_history"],
    )


(
    merge_whole_chat_save_with_existing_chat,
    rebuild_flat_messages_from_history,
) = _load_chat_merge_helpers()


def test_pending_steer_replacement_and_consume_semantics():
    async def _run():
        redis_client = FakeAsyncRedis()
        state = await replace_pending_steer(
            redis_client,
            "chat-123",
            prompt="first steer",
            files=[],
            request_context={"session_id": "socket-1"},
        )
        first_id = state["pending_steer"]["id"]

        state = await replace_pending_steer(
            redis_client,
            "chat-123",
            prompt="second steer",
            files=[],
            request_context={"session_id": "socket-2"},
        )

        assert ensure_pending_steer_is_active(state)["prompt"] == "second steer"
        assert state["pending_steer"]["id"] == first_id

        consumed, state = await consume_pending_steer(redis_client, "chat-123")
        assert consumed["prompt"] == "second steer"
        assert state["pending_steer"] is None

    asyncio.run(_run())


def test_consuming_last_pending_item_persists_empty_tombstone_with_incremented_version():
    async def _run():
        redis_client = FakeAsyncRedis()
        state = await replace_pending_steer(
            redis_client,
            "chat-123",
            prompt="first steer",
            files=[],
            request_context={"session_id": "socket-1"},
        )
        prior_version = state["version"]

        _, state = await consume_pending_steer(redis_client, "chat-123")

        assert state["pending_steer"] is None
        assert state["queued_prompts"] == []
        assert state["version"] == prior_version + 1

        redis_key = f"{pending_chat_work_module.PENDING_CHAT_WORK_KEY_PREFIX}chat-123"
        assert redis_key in redis_client.store
        assert (
            redis_client.expirations[redis_key]
            == EMPTY_PENDING_CHAT_WORK_TOMBSTONE_TTL_SECONDS
        )

        loaded_state = await load_pending_chat_work_state(redis_client, "chat-123")
        assert loaded_state["pending_steer"] is None
        assert loaded_state["queued_prompts"] == []
        assert loaded_state["version"] == state["version"]

    asyncio.run(_run())


def test_stale_whole_chat_save_preserves_backend_inserted_messages_and_current_branch():
    existing_chat_payload = {
        "history": {
            "currentId": "assistant-steer",
            "messages": {
                "user-1": {
                    "id": "user-1",
                    "parentId": None,
                    "childrenIds": ["assistant-1"],
                    "role": "user",
                    "content": "first prompt",
                },
                "assistant-1": {
                    "id": "assistant-1",
                    "parentId": "user-1",
                    "childrenIds": ["user-steer"],
                    "role": "assistant",
                    "content": "first reply",
                },
                "user-steer": {
                    "id": "user-steer",
                    "parentId": "assistant-1",
                    "childrenIds": ["assistant-steer"],
                    "role": "user",
                    "content": "steered prompt",
                },
                "assistant-steer": {
                    "id": "assistant-steer",
                    "parentId": "user-steer",
                    "childrenIds": [],
                    "role": "assistant",
                    "content": "steered reply",
                },
            },
        },
        "messages": [
            {"id": "user-1", "role": "user"},
            {"id": "assistant-1", "role": "assistant"},
            {"id": "user-steer", "role": "user"},
            {"id": "assistant-steer", "role": "assistant"},
        ],
    }
    incoming_chat_payload = {
        "history": {
            "currentId": "assistant-1",
            "messages": {
                "user-1": {
                    "id": "user-1",
                    "parentId": None,
                    "childrenIds": ["assistant-1"],
                    "role": "user",
                    "content": "first prompt",
                },
                "assistant-1": {
                    "id": "assistant-1",
                    "parentId": "user-1",
                    "childrenIds": [],
                    "role": "assistant",
                    "content": "first reply",
                },
            },
        },
        "messages": [
            {"id": "user-1", "role": "user"},
            {"id": "assistant-1", "role": "assistant"},
        ],
    }

    merged_chat, stale_save_detected = merge_whole_chat_save_with_existing_chat(
        existing_chat_payload,
        incoming_chat_payload,
    )

    assert stale_save_detected is True
    assert merged_chat["history"]["currentId"] == "assistant-steer"
    assert "user-steer" in merged_chat["history"]["messages"]
    assert "assistant-steer" in merged_chat["history"]["messages"]
    assert merged_chat["history"]["messages"]["assistant-1"]["childrenIds"] == ["user-steer"]
    assert [message["id"] for message in merged_chat["messages"]] == [
        "user-1",
        "assistant-1",
        "user-steer",
        "assistant-steer",
    ]


def test_non_stale_whole_chat_save_keeps_requested_current_branch():
    existing_chat_payload = {
        "history": {
            "currentId": "assistant-1",
            "messages": {
                "user-1": {
                    "id": "user-1",
                    "parentId": None,
                    "childrenIds": ["assistant-1"],
                    "role": "user",
                    "content": "first prompt",
                },
                "assistant-1": {
                    "id": "assistant-1",
                    "parentId": "user-1",
                    "childrenIds": [],
                    "role": "assistant",
                    "content": "first reply",
                },
            },
        },
        "messages": [
            {"id": "user-1", "role": "user"},
            {"id": "assistant-1", "role": "assistant"},
        ],
    }
    incoming_chat_payload = {
        "history": {
            "currentId": "assistant-1",
            "messages": {
                "user-1": {
                    "id": "user-1",
                    "parentId": None,
                    "childrenIds": ["assistant-1", "assistant-2"],
                    "role": "user",
                    "content": "first prompt",
                },
                "assistant-1": {
                    "id": "assistant-1",
                    "parentId": "user-1",
                    "childrenIds": [],
                    "role": "assistant",
                    "content": "first reply",
                },
                "assistant-2": {
                    "id": "assistant-2",
                    "parentId": "user-1",
                    "childrenIds": [],
                    "role": "assistant",
                    "content": "alternate reply",
                },
            },
        },
        "messages": [
            {"id": "user-1", "role": "user"},
            {"id": "assistant-1", "role": "assistant"},
            {"id": "assistant-2", "role": "assistant"},
        ],
    }

    merged_chat, stale_save_detected = merge_whole_chat_save_with_existing_chat(
        existing_chat_payload,
        incoming_chat_payload,
    )

    assert stale_save_detected is False
    assert merged_chat["history"]["currentId"] == "assistant-1"
    assert "assistant-2" in merged_chat["history"]["messages"]
    assert merged_chat["history"]["messages"]["user-1"]["childrenIds"] == [
        "assistant-1",
        "assistant-2",
    ]


def test_background_turn_branch_persistence_verifier_detects_complete_branch():
    chat_payload = {
        "history": {
            "currentId": "assistant-steer",
            "messages": {
                "user-1": {
                    "id": "user-1",
                    "parentId": None,
                    "childrenIds": ["assistant-1"],
                    "role": "user",
                },
                "assistant-1": {
                    "id": "assistant-1",
                    "parentId": "user-1",
                    "childrenIds": ["user-steer"],
                    "role": "assistant",
                },
                "user-steer": {
                    "id": "user-steer",
                    "parentId": "assistant-1",
                    "childrenIds": ["assistant-steer"],
                    "role": "user",
                },
                "assistant-steer": {
                    "id": "assistant-steer",
                    "parentId": "user-steer",
                    "childrenIds": [],
                    "role": "assistant",
                },
            },
        },
        "messages": [
            {"id": "user-1", "role": "user"},
            {"id": "assistant-1", "role": "assistant"},
            {"id": "user-steer", "role": "user"},
            {"id": "assistant-steer", "role": "assistant"},
        ],
    }

    assert is_background_turn_branch_persisted(
        chat_payload=chat_payload,
        parent_message_id="assistant-1",
        user_message=chat_payload["history"]["messages"]["user-steer"],
        assistant_messages=[chat_payload["history"]["messages"]["assistant-steer"]],
        current_id="assistant-steer",
    )


def test_repair_missing_background_turn_branch_restores_user_assistant_and_current_branch():
    chat_payload = {
        "history": {
            "currentId": "assistant-1",
            "messages": {
                "user-1": {
                    "id": "user-1",
                    "parentId": None,
                    "childrenIds": ["assistant-1"],
                    "role": "user",
                },
                "assistant-1": {
                    "id": "assistant-1",
                    "parentId": "user-1",
                    "childrenIds": [],
                    "role": "assistant",
                },
            },
        },
        "messages": [
            {"id": "user-1", "role": "user"},
            {"id": "assistant-1", "role": "assistant"},
        ],
    }
    user_message = {
        "id": "user-steer",
        "parentId": "assistant-1",
        "childrenIds": ["assistant-steer"],
        "role": "user",
        "content": "steered prompt",
    }
    assistant_message = {
        "id": "assistant-steer",
        "parentId": "user-steer",
        "childrenIds": [],
        "role": "assistant",
        "content": "steered reply",
    }

    repaired = repair_missing_background_turn_branch_in_chat_payload(
        chat_payload=chat_payload,
        parent_message_id="assistant-1",
        user_message=user_message,
        assistant_messages=[assistant_message],
        current_id="assistant-steer",
    )

    assert repaired is True
    assert is_background_turn_branch_persisted(
        chat_payload=chat_payload,
        parent_message_id="assistant-1",
        user_message=user_message,
        assistant_messages=[assistant_message],
        current_id="assistant-steer",
    )
    assert chat_payload["history"]["messages"]["assistant-1"]["childrenIds"] == [
        "user-steer"
    ]
    assert [message["id"] for message in chat_payload["messages"][-2:]] == [
        "user-steer",
        "assistant-steer",
    ]


def test_rebuild_flat_messages_from_history_uses_history_current_branch():
    history = {
        "currentId": "assistant-steer",
        "messages": {
            "user-1": {
                "id": "user-1",
                "parentId": None,
                "childrenIds": ["assistant-1"],
                "role": "user",
                "content": "first prompt",
            },
            "assistant-1": {
                "id": "assistant-1",
                "parentId": "user-1",
                "childrenIds": ["user-steer"],
                "role": "assistant",
                "content": "first reply",
            },
            "user-steer": {
                "id": "user-steer",
                "parentId": "assistant-1",
                "childrenIds": ["assistant-steer"],
                "role": "user",
                "content": "steer prompt",
            },
            "assistant-steer": {
                "id": "assistant-steer",
                "parentId": "user-steer",
                "childrenIds": [],
                "role": "assistant",
                "content": "steered reply",
            },
        },
    }

    rebuilt_messages = rebuild_flat_messages_from_history(history)

    assert [message["id"] for message in rebuilt_messages] == [
        "user-1",
        "assistant-1",
        "user-steer",
        "assistant-steer",
    ]


def test_queued_prompt_order_is_stable_through_edit_updates():
    async def _run():
        redis_client = FakeAsyncRedis()
        state = await append_queued_prompt(
            redis_client,
            "chat-123",
            prompt="first",
            files=[],
            request_context={},
        )
        first = state["queued_prompts"][0]

        state = await append_queued_prompt(
            redis_client,
            "chat-123",
            prompt="second",
            files=[],
            request_context={},
        )
        second = state["queued_prompts"][1]

        state = await update_queued_prompt(
            redis_client,
            "chat-123",
            item_id=second["id"],
            patch={"prompt": "second edited", "status": "editing"},
        )

        updated_second = next(
            item for item in state["queued_prompts"] if item["id"] == second["id"]
        )
        assert updated_second["sort_index"] == second["sort_index"]
        assert updated_second["prompt"] == "second edited"
        assert get_next_dispatchable_queued_prompt(state) == first

    asyncio.run(_run())


def test_followup_steer_injection_appends_user_message_and_top_level_files():
    steer_item = {
        "prompt": "steer now",
        "files": [
            {"type": "image", "url": "data:image/png;base64,abc"},
            {"type": "file", "id": "doc-1", "name": "notes.txt"},
        ],
    }
    base_messages = [
        {"role": "assistant", "content": "tool call summary"},
        {"role": "tool", "content": "tool result", "tool_call_id": "call-1"},
    ]

    messages, files = inject_pending_steer_into_followup_messages(
        base_messages=base_messages,
        steer_item=steer_item,
    )

    assert [message["role"] for message in messages] == ["assistant", "tool", "user"]
    assert messages[-1]["content"][0]["text"] == "steer now"
    assert files == [{"type": "file", "id": "doc-1", "name": "notes.txt"}]


def test_continue_steer_injection_replaces_synthetic_continue_prompt():
    steer_item = {"prompt": "take the answer this direction", "files": []}
    base_messages = [{"role": "assistant", "content": "partial answer"}]

    messages, files = inject_pending_steer_into_continue_messages(
        base_messages=base_messages,
        continue_prompt="continue",
        steer_item=steer_item,
    )

    assert messages == [
        {"role": "assistant", "content": "partial answer"},
        {"role": "user", "content": "take the answer this direction"},
    ]
    assert files == []


def test_user_steer_content_blocks_and_message_conversion_preserve_files():
    content_blocks = [{"type": "text", "content": "before steer"}]
    steer_item = {
        "id": "steer-1",
        "prompt": "Use the file too",
        "files": [{"type": "file", "id": "doc-1", "name": "brief.txt"}],
        "created_at": "2026-01-01T00:00:00+00:00",
    }

    next_blocks = append_user_steer_content_block(content_blocks, steer_item)
    user_message, top_level_files = pending_work_item_to_request_message(
        {"prompt": steer_item["prompt"], "files": steer_item["files"]}
    )

    assert next_blocks[-1]["type"] == "user_steer"
    assert next_blocks[-1]["files"] == steer_item["files"]
    assert user_message == {"role": "user", "content": "Use the file too"}
    assert top_level_files == steer_item["files"]


def test_merge_top_level_files_dedupes_identical_entries():
    merged = merge_top_level_files(
        [{"id": "file-1", "type": "file"}],
        [{"id": "file-1", "type": "file"}, {"id": "file-2", "type": "file"}],
    )

    assert merged == [
        {"id": "file-1", "type": "file"},
        {"id": "file-2", "type": "file"},
    ]


def test_background_assistant_placeholder_is_explicitly_incomplete():
    assistant_message = build_background_assistant_message(
        parent_id="user-1",
        model_id="model-1",
        model_name="Model 1",
        model_idx=0,
    )

    assert assistant_message["role"] == "assistant"
    assert assistant_message["parentId"] == "user-1"
    assert assistant_message["done"] is False


def test_insert_background_dispatch_messages_allows_assistant_parent_override():
    chat_payload = {
        "history": {
            "currentId": "assistant-1",
            "messages": {
                "user-1": {
                    "id": "user-1",
                    "parentId": None,
                    "childrenIds": ["assistant-1"],
                    "role": "user",
                    "content": "original prompt",
                },
                "assistant-1": {
                    "id": "assistant-1",
                    "parentId": "user-1",
                    "childrenIds": [],
                    "role": "assistant",
                    "content": "original reply",
                    "done": False,
                },
            },
        },
        "messages": [
            {"id": "user-1", "role": "user"},
            {"id": "assistant-1", "role": "assistant"},
        ],
    }

    next_chat_payload, user_message, assistant_messages = insert_background_dispatch_messages(
        chat_payload=chat_payload,
        parent_id="assistant-1",
        prompt="steer prompt",
        files=[],
        selected_model_ids=["model-1"],
        selected_model_items={"model-1": {"name": "Model 1"}},
        app_models={},
    )

    inserted_assistant = assistant_messages[0]
    assert user_message["parentId"] == "assistant-1"
    assert inserted_assistant["parentId"] == user_message["id"]
    assert next_chat_payload["history"]["messages"]["assistant-1"]["childrenIds"] == [
        user_message["id"]
    ]
    assert next_chat_payload["history"]["currentId"] == inserted_assistant["id"]
    assert [message["id"] for message in next_chat_payload["messages"]] == [
        "user-1",
        "assistant-1",
        user_message["id"],
        inserted_assistant["id"],
    ]


def test_chat_payload_has_active_current_turn_is_scoped_to_current_branch():
    chat_payload = {
        "history": {
            "currentId": "assistant-done",
            "messages": {
                "stale-user": {
                    "id": "stale-user",
                    "role": "user",
                    "childrenIds": ["stale-assistant"],
                },
                "stale-assistant": {
                    "id": "stale-assistant",
                    "role": "assistant",
                    "parentId": "stale-user",
                    "done": False,
                },
                "current-user": {
                    "id": "current-user",
                    "role": "user",
                    "childrenIds": ["assistant-done"],
                },
                "assistant-done": {
                    "id": "assistant-done",
                    "role": "assistant",
                    "parentId": "current-user",
                    "done": True,
                },
            },
        }
    }

    assert chat_payload_has_active_current_turn(chat_payload) is False

    chat_payload["history"]["messages"]["assistant-done"]["done"] = False
    assert chat_payload_has_active_current_turn(chat_payload) is True


def test_mark_chat_payload_message_terminal_unblocks_active_current_turn():
    chat_payload = {
        "history": {
            "currentId": "assistant-1",
            "messages": {
                "user-1": {
                    "id": "user-1",
                    "role": "user",
                    "childrenIds": ["assistant-1"],
                },
                "assistant-1": {
                    "id": "assistant-1",
                    "role": "assistant",
                    "parentId": "user-1",
                    "done": False,
                },
            },
        },
        "messages": [
            {
                "id": "assistant-1",
                "role": "assistant",
                "parentId": "user-1",
                "done": False,
            }
        ],
    }

    assert chat_payload_has_active_current_turn(chat_payload) is True

    changed = mark_chat_payload_message_terminal(
        chat_payload,
        "assistant-1",
        stop_reason="user_stop",
    )

    assert changed is True
    assert chat_payload["history"]["messages"]["assistant-1"]["done"] is True
    assert (
        chat_payload["history"]["messages"]["assistant-1"]["stop_reason"]
        == "user_stop"
    )
    assert chat_payload["messages"][0]["done"] is True
    assert chat_payload["messages"][0]["stop_reason"] == "user_stop"
    assert chat_payload_has_active_current_turn(chat_payload) is False


def test_repair_missing_parent_message_restores_branch_links():
    chat_payload = {
        "history": {
            "currentId": "assistant-2",
            "messages": {
                "user-1": {
                    "id": "user-1",
                    "parentId": None,
                    "childrenIds": ["assistant-1"],
                    "role": "user",
                    "content": "first prompt",
                },
                "assistant-1": {
                    "id": "assistant-1",
                    "parentId": "user-1",
                    "childrenIds": [],
                    "role": "assistant",
                    "content": "first reply",
                },
                "assistant-2": {
                    "id": "assistant-2",
                    "parentId": "user-2",
                    "childrenIds": [],
                    "role": "assistant",
                    "content": "",
                    "done": False,
                },
            },
        },
        "messages": [
            {"id": "user-1", "parentId": None, "childrenIds": ["assistant-1"]},
            {"id": "assistant-1", "parentId": "user-1", "childrenIds": []},
            {"id": "assistant-2", "parentId": "user-2", "childrenIds": []},
        ],
    }

    repaired = repair_missing_parent_message_in_chat_payload(
        chat_payload=chat_payload,
        parent_message_id="user-2",
        parent_message={
            "id": "user-2",
            "parentId": "assistant-1",
            "childrenIds": ["assistant-2"],
            "role": "user",
            "content": "steer prompt",
        },
    )

    assert repaired is True
    assert chat_payload["history"]["messages"]["user-2"]["parentId"] == "assistant-1"
    assert "user-2" in chat_payload["history"]["messages"]["assistant-1"]["childrenIds"]
    assert chat_payload["messages"][-1]["id"] == "user-2"


def test_branch_tool_history_detection_catches_tools_and_tool_blocks():
    assert branch_has_replayed_tool_history(
        [
            {"role": "assistant", "content": "plain text"},
            {"role": "tool", "content": "result"},
        ]
    )
    assert branch_has_replayed_tool_history(
        [
            {
                "role": "assistant",
                "contentBlocks": [{"type": "tool_calls", "content": [{"id": "call-1"}]}],
            }
        ]
    )
    assert not branch_has_replayed_tool_history(
        [{"role": "assistant", "content": "plain text"}]
    )


def test_pending_dispatch_backfills_tool_ids_from_redis_when_replaying_tool_history():
    async def _run():
        redis_client = FakeAsyncRedis()
        redis_client.store["chat_tools:chat-tools"] = (
            '["server:skills", "server:google_workspace"]'
        )
        request = make_request(redis_client)
        request_context = {"tool_ids": []}
        message_list = [
            {
                "role": "assistant",
                "contentBlocks": [{"type": "tool_calls", "content": [{"id": "call-1"}]}],
            },
            {"role": "tool", "content": "tool result"},
        ]

        tool_ids = await maybe_backfill_pending_dispatch_tool_ids(
            request=request,
            chat_id="chat-tools",
            message_list=message_list,
            request_context=request_context,
        )

        assert tool_ids == ["server:skills", "server:google_workspace"]
        assert request_context["tool_ids"] == [
            "server:skills",
            "server:google_workspace",
        ]

    asyncio.run(_run())


def test_pending_dispatch_backfills_tool_ids_from_activated_skill_servers_when_replaying_tool_history():
    async def _run():
        redis_client = FakeAsyncRedis()
        redis_client.store["chat_skills:chat-tools"] = '["slack"]'
        request = make_request(redis_client)
        request_context = {"tool_ids": ["server:mcp-assistant"]}
        message_list = [
            {
                "role": "assistant",
                "contentBlocks": [{"type": "tool_calls", "content": [{"id": "call-1"}]}],
            },
            {"role": "tool", "content": "tool result"},
        ]
        fake_skill_manager = SimpleNamespace(
            get_skill_metadata=lambda skill_name: SimpleNamespace(
                required_mcp_servers=["slack"] if skill_name == "slack" else []
            )
        )

        with patch.object(
            pending_chat_work_module,
            "get_skill_manager",
            return_value=fake_skill_manager,
        ):
            tool_ids = await maybe_backfill_pending_dispatch_tool_ids(
                request=request,
                chat_id="chat-tools",
                message_list=message_list,
                request_context=request_context,
            )

        assert tool_ids == ["server:mcp-assistant"]
        assert request_context["tool_ids"] == ["server:mcp-assistant"]

    asyncio.run(_run())


def test_build_background_dispatch_request_metadata_anchors_request_to_inserted_user_message():
    metadata = build_background_dispatch_request_metadata(
        user_id="user-1",
        chat_id="chat-1",
        session_id="pending-work:chat-1",
        assistant_message_id="assistant-bg-1",
        user_message={"id": "user-bg-1", "role": "user", "content": "steer"},
        request_context={
            "filter_ids": ["filter-1"],
            "tool_ids": ["server:mcp-assistant", "server:mcp-atlassian"],
            "tool_servers": ["server:mcp-atlassian"],
            "features": {"web_search": False},
            "variables": {"workspace": "foo"},
        },
        model="Claude Opus 4.6",
    )

    assert metadata["message_id"] == "assistant-bg-1"
    assert metadata["parent_message_id"] == "user-bg-1"
    assert metadata["trigger_message_id"] == "user-bg-1"
    assert metadata["transcript_anchor_kind"] == "user_message"
    assert metadata["transcript_anchor_message_id"] == "user-bg-1"
    assert metadata["request_phase"] == "initial"
    assert metadata["tool_ids"] == ["server:mcp-assistant", "server:mcp-atlassian"]
    assert metadata["debug_request_id"]
    assert metadata["upstream_request_id"]


def test_pending_dispatch_preserves_existing_tool_ids_and_only_merges_missing_redis_tools():
    async def _run():
        redis_client = FakeAsyncRedis()
        redis_client.store["chat_tools:chat-tools"] = (
            '["server:skills", "server:google_workspace"]'
        )
        request = make_request(redis_client)
        request_context = {"tool_ids": ["server:skills", "server:slack"]}
        message_list = [{"role": "tool", "content": "tool result"}]

        tool_ids = await maybe_backfill_pending_dispatch_tool_ids(
            request=request,
            chat_id="chat-tools",
            message_list=message_list,
            request_context=request_context,
        )

        assert tool_ids == [
            "server:skills",
            "server:slack",
            "server:google_workspace",
        ]
        assert request_context["tool_ids"] == [
            "server:skills",
            "server:slack",
            "server:google_workspace",
        ]

    asyncio.run(_run())


def test_pending_dispatch_does_not_backfill_when_no_tool_history_is_replayed():
    async def _run():
        redis_client = FakeAsyncRedis()
        redis_client.store["chat_tools:chat-tools"] = '["server:skills"]'
        request = make_request(redis_client)
        request_context = {"tool_ids": []}
        message_list = [{"role": "assistant", "content": "plain text"}]

        tool_ids = await maybe_backfill_pending_dispatch_tool_ids(
            request=request,
            chat_id="chat-tools",
            message_list=message_list,
            request_context=request_context,
        )

        assert tool_ids == []
        assert request_context["tool_ids"] == []

    asyncio.run(_run())


def test_background_task_request_context_defaults_deepcopy_nested_reasoning_state():
    request_context = {
        "selected_model_ids": ["model-1"],
        "reasoning_effort_by_model": {"0": "max"},
        "params": {"temperature": 0.2},
        "background_tasks": {"follow_up_generation": False},
    }

    normalized = build_background_task_request_context_defaults(request_context)

    assert normalized["selected_model_ids"] == ["model-1"]
    assert normalized["reasoning_effort_by_model"] == {"0": "max"}
    assert normalized["params"] == {"temperature": 0.2}
    assert normalized["tool_ids"] == []
    assert normalized["tool_servers"] == []
    assert normalized["filter_ids"] == []
    assert normalized["features"] == {}
    assert normalized["variables"] == {}

    normalized["selected_model_ids"].append("model-2")
    normalized["reasoning_effort_by_model"]["0"] = "medium"
    normalized["params"]["temperature"] = 0.9
    normalized["tool_ids"].append("server:skills")

    assert request_context["selected_model_ids"] == ["model-1"]
    assert request_context["reasoning_effort_by_model"] == {"0": "max"}
    assert request_context["params"] == {"temperature": 0.2}
    assert "tool_ids" not in request_context


def test_pending_dispatch_omits_reasoning_effort_when_no_value_was_captured():
    async def _run():
        redis_client = FakeAsyncRedis()
        request = make_request(redis_client)
        user = make_user()
        fake_chat_completion = AsyncMock(return_value={"status": True})
        base_chat_payload = {
            "history": {"messages": {}, "currentId": None},
            "messages": [],
            "files": [],
        }
        fake_chats_module = ModuleType("open_webui.models.chats")
        fake_chats_module.Chats = type(
            "FakeChats",
            (),
            {
                "get_chat_by_id_and_user_id": staticmethod(
                    lambda _chat_id, _user_id: SimpleNamespace(chat=copy.deepcopy(base_chat_payload))
                ),
                "update_chat_by_id": staticmethod(lambda _chat_id, _payload: None),
                "upsert_message_to_chat_by_id_and_message_id": staticmethod(
                    lambda *args, **kwargs: None
                ),
            },
        )
        fake_main_module = ModuleType("open_webui.main")
        fake_main_module.chat_completion = fake_chat_completion
        fake_misc_module = ModuleType("open_webui.utils.misc")
        fake_misc_module.get_message_list = _get_message_list
        item = {
            "id": "item-1",
            "prompt": "queued follow-up",
            "files": [],
            "request_context": {
                "selected_model_ids": ["model-1"],
                "selected_model_items": {"model-1": {"name": "Model 1"}},
                "reasoning_effort_by_model": {},
            },
        }

        with patch.dict(
            sys.modules,
            {
                "open_webui.main": fake_main_module,
                "open_webui.models.chats": fake_chats_module,
                "open_webui.utils.misc": fake_misc_module,
            },
        ):
            dispatch_ok, any_dispatch_started = await pending_chat_work_module.dispatch_pending_chat_item(
                request=request,
                user=user,
                chat_id="chat-reasoning",
                item=item,
                item_kind="queue",
                pending_state={"chat_id": "chat-reasoning", "pending_steer": None, "queued_prompts": []},
                sio=None,
            )

        form_data = fake_chat_completion.await_args.args[1]
        assert dispatch_ok is True
        assert any_dispatch_started is True
        assert "reasoning_effort" not in (form_data.get("params") or {})

    asyncio.run(_run())


def test_pending_dispatch_uses_model_index_specific_reasoning_for_multi_model_turns():
    async def _run():
        redis_client = FakeAsyncRedis()
        request = make_request(redis_client)
        user = make_user()
        fake_chat_completion = AsyncMock(return_value={"status": True})
        base_chat_payload = {
            "history": {"messages": {}, "currentId": None},
            "messages": [],
            "files": [],
        }
        fake_chats_module = ModuleType("open_webui.models.chats")
        fake_chats_module.Chats = type(
            "FakeChats",
            (),
            {
                "get_chat_by_id_and_user_id": staticmethod(
                    lambda _chat_id, _user_id: SimpleNamespace(chat=copy.deepcopy(base_chat_payload))
                ),
                "update_chat_by_id": staticmethod(lambda _chat_id, _payload: None),
                "upsert_message_to_chat_by_id_and_message_id": staticmethod(
                    lambda *args, **kwargs: None
                ),
            },
        )
        fake_main_module = ModuleType("open_webui.main")
        fake_main_module.chat_completion = fake_chat_completion
        fake_misc_module = ModuleType("open_webui.utils.misc")
        fake_misc_module.get_message_list = _get_message_list
        item = {
            "id": "item-1",
            "prompt": "queued follow-up",
            "files": [],
            "request_context": {
                "selected_model_ids": ["model-1", "model-2"],
                "selected_model_items": {
                    "model-1": {"name": "Model 1"},
                    "model-2": {"name": "Model 2"},
                },
                "reasoning_effort_by_model": {"1": "high"},
            },
        }

        with patch.dict(
            sys.modules,
            {
                "open_webui.main": fake_main_module,
                "open_webui.models.chats": fake_chats_module,
                "open_webui.utils.misc": fake_misc_module,
            },
        ):
            dispatch_ok, any_dispatch_started = await pending_chat_work_module.dispatch_pending_chat_item(
                request=request,
                user=user,
                chat_id="chat-reasoning-multi",
                item=item,
                item_kind="queue",
                pending_state={
                    "chat_id": "chat-reasoning-multi",
                    "pending_steer": None,
                    "queued_prompts": [],
                },
                sio=None,
            )

        assert dispatch_ok is True
        assert any_dispatch_started is True
        assert fake_chat_completion.await_count == 2

        first_form_data = fake_chat_completion.await_args_list[0].args[1]
        second_form_data = fake_chat_completion.await_args_list[1].args[1]

        assert first_form_data["model"] == "model-1"
        assert first_form_data["model_item"] == {"name": "Model 1"}
        assert "reasoning_effort" not in (first_form_data.get("params") or {})

        assert second_form_data["model"] == "model-2"
        assert second_form_data["model_item"] == {"name": "Model 2"}
        assert second_form_data["params"]["reasoning_effort"] == "high"

    asyncio.run(_run())


def test_pending_dispatch_uses_captured_reasoning_effort_without_backend_fallback():
    async def _run():
        redis_client = FakeAsyncRedis()
        request = make_request(redis_client)
        user = make_user()
        fake_chat_completion = AsyncMock(return_value={"status": True})
        base_chat_payload = {
            "history": {"messages": {}, "currentId": None},
            "messages": [],
            "files": [],
        }
        fake_chats_module = ModuleType("open_webui.models.chats")
        fake_chats_module.Chats = type(
            "FakeChats",
            (),
            {
                "get_chat_by_id_and_user_id": staticmethod(
                    lambda _chat_id, _user_id: SimpleNamespace(chat=copy.deepcopy(base_chat_payload))
                ),
                "update_chat_by_id": staticmethod(lambda _chat_id, _payload: None),
                "upsert_message_to_chat_by_id_and_message_id": staticmethod(
                    lambda *args, **kwargs: None
                ),
            },
        )
        fake_main_module = ModuleType("open_webui.main")
        fake_main_module.chat_completion = fake_chat_completion
        fake_misc_module = ModuleType("open_webui.utils.misc")
        fake_misc_module.get_message_list = _get_message_list
        item = {
            "id": "item-1",
            "prompt": "queued follow-up",
            "files": [],
            "request_context": {
                "selected_model_ids": ["model-1"],
                "selected_model_items": {"model-1": {"name": "Model 1"}},
                "reasoning_effort_by_model": {"0": "max"},
            },
        }

        with patch.dict(
            sys.modules,
            {
                "open_webui.main": fake_main_module,
                "open_webui.models.chats": fake_chats_module,
                "open_webui.utils.misc": fake_misc_module,
            },
        ):
            dispatch_ok, any_dispatch_started = await pending_chat_work_module.dispatch_pending_chat_item(
                request=request,
                user=user,
                chat_id="chat-reasoning",
                item=item,
                item_kind="queue",
                pending_state={"chat_id": "chat-reasoning", "pending_steer": None, "queued_prompts": []},
                sio=None,
            )

        form_data = fake_chat_completion.await_args.args[1]
        assert dispatch_ok is True
        assert any_dispatch_started is True
        assert form_data["params"]["reasoning_effort"] == "max"

    asyncio.run(_run())


def test_pending_dispatch_passes_explicit_debug_metadata_for_background_branch_requests():
    async def _run():
        redis_client = FakeAsyncRedis()
        request = make_request(redis_client)
        user = make_user()
        fake_chat_completion = AsyncMock(return_value={"status": True})
        base_chat_payload = {
            "history": {"messages": {}, "currentId": None},
            "messages": [],
            "files": [],
        }
        fake_chats_module = ModuleType("open_webui.models.chats")
        fake_chats_module.Chats = type(
            "FakeChats",
            (),
            {
                "get_chat_by_id_and_user_id": staticmethod(
                    lambda _chat_id, _user_id: SimpleNamespace(
                        chat=copy.deepcopy(base_chat_payload)
                    )
                ),
                "update_chat_by_id": staticmethod(lambda _chat_id, _payload: None),
                "upsert_message_to_chat_by_id_and_message_id": staticmethod(
                    lambda *args, **kwargs: None
                ),
            },
        )
        fake_main_module = ModuleType("open_webui.main")
        fake_main_module.chat_completion = fake_chat_completion
        fake_misc_module = ModuleType("open_webui.utils.misc")
        fake_misc_module.get_message_list = _get_message_list
        item = {
            "id": "item-steer-1",
            "prompt": "please steer",
            "files": [],
            "request_context": {
                "selected_model_ids": ["model-1"],
                "selected_model_items": {"model-1": {"name": "Model 1"}},
                "tool_ids": ["server:mcp-assistant", "server:mcp-atlassian"],
            },
        }

        with patch.dict(
            sys.modules,
            {
                "open_webui.main": fake_main_module,
                "open_webui.models.chats": fake_chats_module,
                "open_webui.utils.misc": fake_misc_module,
            },
        ):
            dispatch_ok, any_dispatch_started = await pending_chat_work_module.dispatch_pending_chat_item(
                request=request,
                user=user,
                chat_id="chat-steer",
                item=item,
                item_kind="steer",
                pending_state={"chat_id": "chat-steer", "pending_steer": None, "queued_prompts": []},
                sio=None,
            )

        assert dispatch_ok is True
        assert any_dispatch_started is True
        form_data = fake_chat_completion.await_args.args[1]
        metadata = form_data["metadata"]
        assert metadata["chat_id"] == "chat-steer"
        assert metadata["message_id"] == form_data["id"]
        assert metadata["parent_message_id"] == form_data["parent_id"]
        assert metadata["trigger_message_id"] == form_data["parent_id"]
        assert metadata["transcript_anchor_kind"] == "user_message"
        assert metadata["transcript_anchor_message_id"] == form_data["parent_id"]
        assert metadata["request_phase"] == "initial"
        assert metadata["tool_ids"] == ["server:mcp-assistant", "server:mcp-atlassian"]

    asyncio.run(_run())


def test_failed_background_dispatch_restores_pending_items_without_dropping_order():
    async def _run():
        redis_client = FakeAsyncRedis()

        steer_state = await replace_pending_steer(
            redis_client,
            "chat-restore",
            prompt="steer me",
            files=[],
            request_context={},
        )
        consumed_steer, _ = await consume_pending_steer(redis_client, "chat-restore")
        restored_steer_state = await restore_pending_chat_item_after_dispatch_failure(
            redis_client,
            "chat-restore",
            item=consumed_steer,
            error="background_dispatch_failed_before_start",
        )

        assert restored_steer_state["pending_steer"]["prompt"] == "steer me"
        assert restored_steer_state["pending_steer"]["attempt_count"] == 1
        assert restored_steer_state["pending_steer"]["last_error"] == "background_dispatch_failed_before_start"

        queue_state = await append_queued_prompt(
            redis_client,
            "chat-restore",
            prompt="queued first",
            files=[],
            request_context={},
        )
        queued_item = queue_state["queued_prompts"][0]
        restored_queue_state = await restore_pending_chat_item_after_dispatch_failure(
            redis_client,
            "chat-restore",
            item=queued_item,
            error="background_dispatch_failed_before_start",
        )

        restored_queue_item = next(
            item
            for item in restored_queue_state["queued_prompts"]
            if item["id"] == queued_item["id"]
        )
        assert restored_queue_item["sort_index"] == queued_item["sort_index"]
        assert restored_queue_item["attempt_count"] == 1
        assert restored_queue_item["last_error"] == "background_dispatch_failed_before_start"

    asyncio.run(_run())


def test_background_dispatch_messages_preserve_branch_history_and_flat_messages():
    chat_payload = {
        "history": {
            "currentId": "assistant-1",
            "messages": {
                "user-1": {
                    "id": "user-1",
                    "parentId": None,
                    "childrenIds": ["assistant-1"],
                    "role": "user",
                    "content": "first prompt",
                    "timestamp": 1,
                    "models": ["model-1"],
                },
                "assistant-1": {
                    "id": "assistant-1",
                    "parentId": "user-1",
                    "childrenIds": [],
                    "role": "assistant",
                    "content": "first reply",
                    "timestamp": 2,
                    "model": "model-1",
                    "modelName": "Model 1",
                    "modelIdx": 0,
                },
            },
        },
        "messages": [
            {
                "id": "user-1",
                "parentId": None,
                "childrenIds": ["assistant-1"],
                "role": "user",
                "content": "first prompt",
                "timestamp": 1,
                "models": ["model-1"],
            },
            {
                "id": "assistant-1",
                "parentId": "user-1",
                "childrenIds": [],
                "role": "assistant",
                "content": "first reply",
                "timestamp": 2,
                "model": "model-1",
                "modelName": "Model 1",
                "modelIdx": 0,
            },
        ],
    }

    next_chat_payload, user_message, assistant_messages = insert_background_dispatch_messages(
        chat_payload=chat_payload,
        prompt="queued follow-up",
        files=[],
        selected_model_ids=["model-1"],
        selected_model_items={"model-1": {"name": "Model 1"}},
        app_models={},
    )

    assistant_message = assistant_messages[0]

    assert user_message["parentId"] == "assistant-1"
    assert assistant_message["parentId"] == user_message["id"]
    assert next_chat_payload["history"]["messages"]["assistant-1"]["childrenIds"] == [
        user_message["id"]
    ]
    assert next_chat_payload["history"]["currentId"] == assistant_message["id"]
    assert [
        message["id"] for message in next_chat_payload["messages"][-2:]
    ] == [user_message["id"], assistant_message["id"]]


def test_background_dispatch_messages_fall_back_when_current_id_is_invalid():
    chat_payload = {
        "history": {
            "currentId": "missing-id",
            "messages": {
                "user-1": {
                    "id": "user-1",
                    "parentId": None,
                    "childrenIds": ["assistant-1"],
                    "role": "user",
                    "content": "first prompt",
                    "timestamp": 1,
                    "models": ["model-1"],
                },
                "assistant-1": {
                    "id": "assistant-1",
                    "parentId": "user-1",
                    "childrenIds": [],
                    "role": "assistant",
                    "content": "first reply",
                    "timestamp": 2,
                    "model": "model-1",
                    "modelName": "Model 1",
                    "modelIdx": 0,
                },
            },
        },
        "messages": [
            {"id": "user-1", "parentId": None, "childrenIds": ["assistant-1"]},
            {"id": "assistant-1", "parentId": "user-1", "childrenIds": []},
        ],
    }

    _, user_message, _ = insert_background_dispatch_messages(
        chat_payload=chat_payload,
        prompt="queued follow-up",
        files=[],
        selected_model_ids=["model-1"],
        selected_model_items={"model-1": {"name": "Model 1"}},
        app_models={},
    )

    assert user_message["parentId"] == "assistant-1"


def test_pending_chat_work_drain_ignores_the_finishing_task_and_dispatches_immediately():
    async def _run():
        redis_client = FakeAsyncRedis()
        request = make_request(redis_client)
        user = make_user()

        await replace_pending_steer(
            redis_client,
            "chat-drain",
            prompt="send me next",
            files=[],
            request_context={},
        )

        dispatch_mock = AsyncMock(return_value=(True, True))
        fake_tasks_module = ModuleType("open_webui.tasks")
        fake_tasks_module.list_task_ids_by_item_id = AsyncMock(return_value=["task-self"])
        fake_chats_module = ModuleType("open_webui.models.chats")
        fake_chats_module.Chats = type(
            "FakeChats",
            (),
            {"get_chat_by_id": staticmethod(lambda _chat_id: SimpleNamespace(chat={}))},
        )
        with patch.dict(
            sys.modules,
            {
                "open_webui.tasks": fake_tasks_module,
                "open_webui.models.chats": fake_chats_module,
            },
        ), patch.object(
            pending_chat_work_module,
            "dispatch_pending_chat_item",
            new=dispatch_mock,
        ):
            result = await run_pending_chat_work_drain(
                request=request,
                user=user,
                chat_id="chat-drain",
                ignore_task_ids=["task-self"],
                triggered_at=123.0,
            )

        state = await load_pending_chat_work_state(redis_client, "chat-drain")
        assert result is True
        assert dispatch_mock.await_count == 1
        assert dispatch_mock.await_args.kwargs["triggered_at"] == 123.0
        assert state["pending_steer"] is None

    asyncio.run(_run())


def test_pending_chat_work_drain_waits_for_other_active_tasks():
    async def _run():
        redis_client = FakeAsyncRedis()
        request = make_request(redis_client)
        user = make_user()

        await replace_pending_steer(
            redis_client,
            "chat-drain-blocked",
            prompt="still waiting",
            files=[],
            request_context={},
        )

        dispatch_mock = AsyncMock(return_value=(True, True))
        fake_tasks_module = ModuleType("open_webui.tasks")
        fake_tasks_module.list_task_ids_by_item_id = AsyncMock(
            return_value=["task-self", "task-other"]
        )
        fake_chats_module = ModuleType("open_webui.models.chats")
        fake_chats_module.Chats = type(
            "FakeChats",
            (),
            {"get_chat_by_id": staticmethod(lambda _chat_id: SimpleNamespace(chat={}))},
        )
        with patch.dict(
            sys.modules,
            {
                "open_webui.tasks": fake_tasks_module,
                "open_webui.models.chats": fake_chats_module,
            },
        ), patch.object(
            pending_chat_work_module,
            "dispatch_pending_chat_item",
            new=dispatch_mock,
        ):
            result = await run_pending_chat_work_drain(
                request=request,
                user=user,
                chat_id="chat-drain-blocked",
                ignore_task_ids=["task-self"],
                triggered_at=123.0,
            )

        state = await load_pending_chat_work_state(redis_client, "chat-drain-blocked")
        assert result is False
        assert dispatch_mock.await_count == 0
        assert state["pending_steer"]["prompt"] == "still waiting"

    asyncio.run(_run())


def test_pending_chat_work_drain_waits_for_active_persisted_turn_even_without_task_ids():
    async def _run():
        redis_client = FakeAsyncRedis()
        request = make_request(redis_client)
        user = make_user()

        await replace_pending_steer(
            redis_client,
            "chat-history-blocked",
            prompt="still waiting on current turn",
            files=[],
            request_context={},
        )

        chat_payload_holder = {
            "chat": {
                "history": {
                    "currentId": "assistant-active",
                    "messages": {
                        "user-1": {
                            "id": "user-1",
                            "role": "user",
                            "childrenIds": ["assistant-active"],
                        },
                        "assistant-active": {
                            "id": "assistant-active",
                            "role": "assistant",
                            "parentId": "user-1",
                            "done": False,
                        },
                    },
                }
            }
        }

        class FakeChats:
            @staticmethod
            def get_chat_by_id(_chat_id):
                return SimpleNamespace(chat=chat_payload_holder["chat"])

        fake_tasks_module = ModuleType("open_webui.tasks")
        fake_tasks_module.list_task_ids_by_item_id = AsyncMock(return_value=[])
        fake_chats_module = ModuleType("open_webui.models.chats")
        fake_chats_module.Chats = FakeChats
        dispatch_mock = AsyncMock(return_value=(True, True))

        with patch.dict(
            sys.modules,
            {
                "open_webui.tasks": fake_tasks_module,
                "open_webui.models.chats": fake_chats_module,
            },
        ), patch.object(
            pending_chat_work_module,
            "dispatch_pending_chat_item",
            new=dispatch_mock,
        ):
            blocked = await run_pending_chat_work_drain(
                request=request,
                user=user,
                chat_id="chat-history-blocked",
                ignore_task_ids=[],
                triggered_at=123.0,
            )

            chat_payload_holder["chat"]["history"]["messages"]["assistant-active"]["done"] = True

            unblocked = await run_pending_chat_work_drain(
                request=request,
                user=user,
                chat_id="chat-history-blocked",
                ignore_task_ids=[],
                triggered_at=456.0,
            )

        state = await load_pending_chat_work_state(redis_client, "chat-history-blocked")
        assert blocked is False
        assert unblocked is True
        assert dispatch_mock.await_count == 1
        assert dispatch_mock.await_args.kwargs["triggered_at"] == 456.0
        assert state["pending_steer"] is None

    asyncio.run(_run())


def test_pending_chat_work_drain_schedules_fast_retry_when_only_persisted_turn_is_still_active():
    async def _run():
        redis_client = FakeAsyncRedis()
        request = make_request(redis_client)
        user = make_user()

        await replace_pending_steer(
            redis_client,
            "chat-history-retry",
            prompt="retry me as soon as the turn is terminal",
            files=[],
            request_context={},
        )

        class FakeChats:
            @staticmethod
            def get_chat_by_id(_chat_id):
                return SimpleNamespace(
                    chat={
                        "history": {
                            "currentId": "assistant-active",
                            "messages": {
                                "user-1": {
                                    "id": "user-1",
                                    "role": "user",
                                    "childrenIds": ["assistant-active"],
                                },
                                "assistant-active": {
                                    "id": "assistant-active",
                                    "role": "assistant",
                                    "parentId": "user-1",
                                    "done": False,
                                },
                            },
                        }
                    }
                )

        fake_tasks_module = ModuleType("open_webui.tasks")
        fake_tasks_module.list_task_ids_by_item_id = AsyncMock(return_value=[])
        fake_chats_module = ModuleType("open_webui.models.chats")
        fake_chats_module.Chats = FakeChats
        dispatch_mock = AsyncMock(return_value=(True, True))

        with patch.dict(
            sys.modules,
            {
                "open_webui.tasks": fake_tasks_module,
                "open_webui.models.chats": fake_chats_module,
            },
        ), patch.object(
            pending_chat_work_module,
            "dispatch_pending_chat_item",
            new=dispatch_mock,
        ), patch.object(
            pending_chat_work_module,
            "schedule_pending_chat_work_active_turn_retry",
        ) as retry_mock:
            blocked = await run_pending_chat_work_drain(
                request=request,
                user=user,
                chat_id="chat-history-retry",
                ignore_task_ids=[],
                triggered_at=123.0,
            )

        assert blocked is False
        assert dispatch_mock.await_count == 0
        assert retry_mock.call_count == 1
        assert retry_mock.call_args.kwargs["chat_id"] == "chat-history-retry"
        assert retry_mock.call_args.kwargs["triggered_at"] == 123.0

    asyncio.run(_run())


def test_streaming_terminal_path_schedules_pending_drain_before_background_tasks():
    segment = _middleware_source_segment(
        '[CHAT-DONE] Setting done=true',
        'except asyncio.CancelledError as cancel_error:'
    )

    assert "schedule_terminal_pending_chat_work_drain(" in segment
    assert segment.index("schedule_terminal_pending_chat_work_drain(") < segment.index(
        "await background_tasks_handler()"
    )


def test_non_streaming_terminal_path_schedules_pending_drain_before_background_tasks():
    segment = _middleware_source_segment(
        'if choices and choices[0].get("message", {}).get("content"):',
        "if events and isinstance(events, list):"
    )

    assert '"done": True' in segment
    assert "schedule_terminal_pending_chat_work_drain(" in segment
    assert segment.index("schedule_terminal_pending_chat_work_drain(") < segment.index(
        "await background_tasks_handler()"
    )


def test_terminal_pending_drain_helper_is_defined_before_non_streaming_path():
    source = MIDDLEWARE_PATH.read_text(encoding="utf-8")
    assert source.index("def schedule_terminal_pending_chat_work_drain(") < source.index(
        "# Non-streaming response"
    )


def test_main_cancelled_path_terminalizes_message_before_pending_drain():
    source = MAIN_PATH.read_text(encoding="utf-8")
    segment_start = source.index("except asyncio.CancelledError as cancel_error:")
    segment_end = source.index("finally:\n                raise", segment_start)
    segment = source[segment_start:segment_end]

    assert "mark_chat_payload_message_terminal(" in segment
    assert "schedule_pending_chat_work_drain(" in segment
    assert segment.index("mark_chat_payload_message_terminal(") < segment.index(
        "schedule_pending_chat_work_drain("
    )


def test_mid_turn_steer_seams_promote_consumed_steers_into_real_history_nodes():
    source = MIDDLEWARE_PATH.read_text(encoding="utf-8")
    assert "async def promote_consumed_steer_to_live_turn(" in source
    assert "metadata.update(" in source
    assert "_user_message_anchor_updates(" in source
    assert "is_background_turn_branch_persisted(" in source
    assert "repair_missing_background_turn_branch_in_chat_payload(" in source
    assert "restore_pending_chat_item_after_dispatch_failure(" in source
    assert "[PendingChatWork] Mid-turn steer promotion verification failed" in source

    followup_segment = _middleware_source_segment(
        "followup_messages = [",
        "new_form_data[\"metadata\"] = followup_metadata"
    )
    assert followup_segment.index("await promote_consumed_steer_to_live_turn(") < followup_segment.index(
        "inject_pending_steer_into_followup_messages("
    )
    assert "_user_message_anchor_updates(" in followup_segment
    assert "append_user_steer_content_block(" not in followup_segment
    assert "await restore_failed_mid_turn_steer(" in followup_segment

    continue_segment = _middleware_source_segment(
        "continue_messages = [",
        "continue_form_data[\"metadata\"] = continue_metadata"
    )
    assert continue_segment.index("await promote_consumed_steer_to_live_turn(") < continue_segment.index(
        "inject_pending_steer_into_continue_messages("
    )
    assert "_user_message_anchor_updates(" in continue_segment
    assert "append_user_steer_content_block(" not in continue_segment
    assert "await restore_failed_mid_turn_steer(" in continue_segment


def test_middleware_imports_copy_for_mid_turn_steer_promotion_runtime():
    source = MIDDLEWARE_PATH.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(MIDDLEWARE_PATH))

    assert any(
        isinstance(node, ast.Import)
        and any(alias.name == "copy" for alias in node.names)
        for node in tree.body
    )


def test_main_chat_entrypoint_preserves_caller_supplied_metadata_for_internal_dispatches():
    source = MAIN_PATH.read_text(encoding="utf-8")

    assert 'incoming_metadata = (' in source
    assert "default_request_phase=\"initial\"" in source
    assert 'incoming_metadata.get("debug_request_id")' in source
    assert 'incoming_metadata.get("upstream_request_id")' in source
    assert 'incoming_metadata.get("trigger_message_id")' in source
    assert 'incoming_metadata.get("transcript_anchor_kind")' in source


def test_main_request_path_rebuilds_or_sanitizes_replayed_tool_history_before_provider_call():
    source = MIDDLEWARE_PATH.read_text(encoding="utf-8")
    assert "def _ensure_replay_safe_tool_payload(" in source
    assert "def _sanitize_replayed_tool_history_messages(" in source
    assert 'metadata["tools"] = tools_dict' in source
    assert "_ensure_replay_safe_tool_payload(" in source
    assert (
        "Stripped replayed tool history because no effective tool payload could be built"
        in source
    )
