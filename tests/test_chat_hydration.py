import ast
import copy
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Optional


ROOT = Path(__file__).resolve().parents[1]
CHATS_ROUTER_PATH = (
    ROOT / "src" / "patches" / "backend" / "open_webui" / "routers" / "chats.py"
)


class FakeChatResponse:
    def __init__(self, **data):
        self.data = data

    def model_dump(self):
        return copy.deepcopy(self.data)


class FakeChat:
    def __init__(self, chat_id: str, chat: dict[str, Any], user_id: str = "user-1"):
        self.id = chat_id
        self.user_id = user_id
        self.chat = chat
        self.meta = {}

    def model_dump(self):
        return {
            "id": self.id,
            "user_id": self.user_id,
            "chat": self.chat,
            "meta": self.meta,
        }


class FakeRedis:
    def __init__(self, values: dict[str, Any]):
        self.values = values
        self.mget_calls = []

    def mget(self, keys):
        self.mget_calls.append(list(keys))
        return [self.values.get(key) for key in keys]


def _load_helpers():
    module_ast = ast.parse(
        CHATS_ROUTER_PATH.read_text(encoding="utf-8"), filename=str(CHATS_ROUTER_PATH)
    )
    helper_names = {
        "_chat_payload_dict",
        "_subagent_metadata_from_chat",
        "_parse_nested_json_object",
        "_is_subagent_tool_name",
        "_non_negative_int_or_none",
        "_subagent_display_tokens_from_stats",
        "_collect_subagent_tool_call_details_from_messages",
        "_collect_subagent_tool_call_details_from_chat",
        "_collect_subagent_refs_from_messages",
        "_collect_subagent_refs_from_chat",
        "_resolve_subagent_tool_call_mappings",
        "_resolve_subagent_tool_call_ids",
        "_resolve_subagent_tool_calls_from_persisted_metadata",
        "_extract_subagent_chat_stats",
        "_get_authorized_subagent_descendants",
        "_get_authorized_subagent_descendant_details",
        "_build_chat_hydration_response",
    }
    selected = [
        node
        for node in module_ast.body
        if isinstance(node, ast.FunctionDef) and node.name in helper_names
    ]
    namespace = {
        "Any": Any,
        "Optional": Optional,
        "json": json,
        "ChatResponse": FakeChatResponse,
        "SUBAGENT_DESCENDANT_LIMIT": 512,
        "SUBAGENT_SERVICE_USER_ID": "portico-service",
        "_get_read_authorized_chat": lambda _chat_id, _user: None,
        "_iter_recent_user_chat_records": lambda _user_id: [],
    }
    exec(
        compile(ast.Module(body=selected, type_ignores=[]), str(CHATS_ROUTER_PATH), "exec"),
        namespace,
    )
    return namespace


def _assistant_message(*, calls=None, results=None):
    return {
        "id": "assistant",
        "role": "assistant",
        "content": "done",
        "contentBlocks": [
            {
                "type": "tool_calls",
                "content": calls or [],
                "results": results or [],
            }
        ],
    }


def _subagent_call(tool_call_id: str):
    return {
        "id": tool_call_id,
        "function": {"name": "tool_run_subagent_post", "arguments": "{}"},
    }


def _chat_with_message(chat_id: str, message: dict[str, Any]):
    return FakeChat(
        chat_id,
        {
            "title": chat_id,
            "history": {"currentId": message["id"], "messages": {message["id"]: message}},
        },
    )


def test_hydration_omits_duplicate_flattened_messages_without_mutating_source():
    helpers = _load_helpers()
    hidden_activity = "x" * 1_500_000
    canonical_messages = {
        "user": {"id": "user", "role": "user", "content": "question"},
        "assistant": {
            "id": "assistant",
            "role": "assistant",
            "content": hidden_activity,
            "contentBlocks": [{"type": "tool_calls", "content": []}] * 66,
        },
    }
    source_payload = {
        "title": "pathological long chat",
        "history": {"currentId": "assistant", "messages": canonical_messages},
        "messages": copy.deepcopy(list(canonical_messages.values())),
    }
    source = FakeChat("root", source_payload)
    before = copy.deepcopy(source.model_dump())

    response = helpers["_build_chat_hydration_response"](source).model_dump()

    assert "messages" not in response["chat"]
    assert response["chat"]["history"]["messages"] == canonical_messages
    assert source.model_dump() == before
    assert len(json.dumps(response)) <= len(json.dumps(before)) * 0.60


def test_hydration_preserves_legacy_messages_when_canonical_history_is_absent():
    helpers = _load_helpers()
    legacy_messages = [{"id": "one", "role": "user", "content": "hello"}]
    source = FakeChat("legacy", {"title": "legacy", "messages": legacy_messages})

    response = helpers["_build_chat_hydration_response"](source).model_dump()

    assert response["chat"]["messages"] == legacy_messages


def test_hydration_treats_list_history_messages_as_canonical():
    helpers = _load_helpers()
    source = FakeChat(
        "list-history",
        {
            "history": {"messages": [{"id": "one", "role": "user"}]},
            "messages": [{"id": "one", "role": "user"}],
        },
    )

    response = helpers["_build_chat_hydration_response"](source).model_dump()

    assert "messages" not in response["chat"]


def test_descendants_resolve_embedded_and_redis_children_and_prevent_cycles():
    helpers = _load_helpers()
    root = _chat_with_message(
        "root",
        _assistant_message(
            calls=[_subagent_call("call-direct")],
            results=[
                {
                    "tool_call_id": "call-direct",
                    "content": json.dumps(json.dumps({"chat_id": "child-direct"})),
                }
            ],
        ),
    )
    direct = _chat_with_message(
        "child-direct", _assistant_message(calls=[_subagent_call("call-redis")])
    )
    redis_child = _chat_with_message(
        "child-redis",
        _assistant_message(
            results=[{"server_id": "subagents", "chat_id": "root"}]
        ),
    )
    chats = {chat.id: chat for chat in (root, direct, redis_child)}
    authorized_reads = []
    helpers["_get_read_authorized_chat"] = lambda chat_id, _user: (
        authorized_reads.append(chat_id) or chats.get(chat_id)
    )
    redis = FakeRedis(
        {"subagent_tool_call:call-redis": json.dumps({"chat_id": "child-redis"})}
    )

    descendants, truncated = helpers["_get_authorized_subagent_descendants"](
        root, SimpleNamespace(id="user-1"), redis_client=redis
    )

    assert descendants == ["child-direct", "child-redis"]
    assert truncated is False
    assert authorized_reads == ["child-direct", "child-redis"]
    assert redis.mget_calls == [["subagent_tool_call:call-redis"]]


def test_descendant_details_prefer_embedded_stats_and_authorized_child():
    helpers = _load_helpers()
    root = _chat_with_message(
        "root",
        _assistant_message(
            calls=[_subagent_call("call-direct")],
            results=[
                {
                    "tool_call_id": "call-direct",
                    "server_id": "subagents",
                    "content": json.dumps(
                        {
                            "chat_id": "child-direct",
                            "tool_call_count": 7,
                            "usage_tokens": 200,
                            "context_tokens": 120,
                            "max_context_tokens": 100,
                        }
                    ),
                }
            ],
        ),
    )
    child = _chat_with_message(
        "child-direct",
        {
            "id": "child-assistant",
            "role": "assistant",
            "usage": {"total_tokens": 999},
            "contentBlocks": [
                {"type": "tool_calls", "content": [_subagent_call("nested")]}
            ],
        },
    )
    chats = {root.id: root, child.id: child}
    helpers["_get_read_authorized_chat"] = lambda chat_id, _user: chats.get(chat_id)

    descendants, truncated, details = helpers[
        "_get_authorized_subagent_descendant_details"
    ](root, SimpleNamespace(id="user-1"))

    assert descendants == ["child-direct"]
    assert truncated is False
    assert details == {
        "call-direct": {
            "chat_id": "child-direct",
            "tool_call_count": 7,
            "display_tokens": 100,
        }
    }


def test_terminal_timeout_detail_recovers_from_redis_and_child_history():
    helpers = _load_helpers()
    root = _chat_with_message(
        "root",
        _assistant_message(
            calls=[_subagent_call("call-timeout")],
            results=[
                {
                    "tool_call_id": "call-timeout",
                    "server_id": "subagents",
                    "content": json.dumps(
                        {
                            "is_error": True,
                            "message": "Chat did not complete within 1500s",
                        }
                    ),
                }
            ],
        ),
    )
    child = _chat_with_message(
        "child-timeout",
        {
            "id": "child-assistant",
            "role": "assistant",
            "done": True,
            "usage": {"prompt_tokens": 300, "completion_tokens": 21},
            "contentBlocks": [
                {
                    "type": "tool_calls",
                    "content": [_subagent_call("nested-1"), _subagent_call("nested-2")],
                }
            ],
        },
    )
    chats = {root.id: root, child.id: child}
    helpers["_get_read_authorized_chat"] = lambda chat_id, _user: chats.get(chat_id)
    redis = FakeRedis(
        {"subagent_tool_call:call-timeout": json.dumps({"chat_id": child.id})}
    )

    descendants, _, details = helpers["_get_authorized_subagent_descendant_details"](
        root, SimpleNamespace(id="user-1"), redis_client=redis
    )

    assert descendants == [child.id]
    assert details["call-timeout"] == {
        "chat_id": child.id,
        "tool_call_count": 2,
        "display_tokens": 321,
    }


def test_terminal_timeout_detail_recovers_from_persisted_child_metadata():
    helpers = _load_helpers()
    root = _chat_with_message(
        "root",
        _assistant_message(calls=[_subagent_call("call-expired")]),
    )
    child = _chat_with_message(
        "child-expired",
        {
            "id": "child-assistant",
            "role": "assistant",
            "done": True,
            "usage": {"total_tokens": 444},
        },
    )
    child.user_id = "portico-service"
    child.chat["meta"] = {
        "subagent": {
            "parent_chat_id": root.id,
            "parent_tool_call_id": "call-expired",
        }
    }
    chats = {root.id: root, child.id: child}
    helpers["_iter_recent_user_chat_records"] = lambda user_id: (
        [child] if user_id == "portico-service" else []
    )
    helpers["_get_read_authorized_chat"] = lambda chat_id, _user: chats.get(chat_id)

    descendants, _, details = helpers["_get_authorized_subagent_descendant_details"](
        root, SimpleNamespace(id="user-1")
    )

    assert descendants == [child.id]
    assert details["call-expired"] == {
        "chat_id": child.id,
        "tool_call_count": 0,
        "display_tokens": 444,
    }


def test_descendants_enforce_read_authorization_for_every_candidate():
    helpers = _load_helpers()
    root = _chat_with_message(
        "root",
        _assistant_message(
            results=[
                {"server_id": "subagents", "chat_id": "allowed"},
                {"server_id": "subagents", "chat_id": "denied"},
            ]
        ),
    )
    allowed = _chat_with_message("allowed", _assistant_message())
    reads = []

    def authorize(chat_id, _user):
        reads.append(chat_id)
        return allowed if chat_id == "allowed" else None

    helpers["_get_read_authorized_chat"] = authorize
    descendants, truncated = helpers["_get_authorized_subagent_descendants"](
        root, SimpleNamespace(id="user-1")
    )

    assert reads == ["allowed", "denied"]
    assert descendants == ["allowed"]
    assert truncated is False


def test_descendant_tool_call_details_exclude_unauthorized_children():
    helpers = _load_helpers()
    root = _chat_with_message(
        "root",
        _assistant_message(calls=[_subagent_call("call-denied")]),
    )
    redis = FakeRedis(
        {"subagent_tool_call:call-denied": json.dumps({"chat_id": "denied"})}
    )
    helpers["_get_read_authorized_chat"] = lambda _chat_id, _user: None

    descendants, truncated, details = helpers[
        "_get_authorized_subagent_descendant_details"
    ](root, SimpleNamespace(id="user-1"), redis_client=redis)

    assert descendants == []
    assert truncated is False
    assert details == {}


def test_subagent_stats_preserve_legacy_message_fallback():
    helpers = _load_helpers()
    child = FakeChat(
        "legacy-child",
        {
            "messages": [
                {
                    "id": "assistant",
                    "role": "assistant",
                    "usage": {"prompt_tokens": 80, "completion_tokens": 20},
                    "tool_calls": [_subagent_call("one"), _subagent_call("two")],
                }
            ]
        },
    )

    assert helpers["_extract_subagent_chat_stats"](child) == {
        "tool_call_count": 2,
        "display_tokens": 100,
    }


def test_descendant_traversal_is_capped_and_reports_truncation():
    helpers = _load_helpers()
    results = [
        {"server_id": "subagents", "chat_id": f"child-{index}"}
        for index in range(514)
    ]
    root = _chat_with_message("root", _assistant_message(results=results))
    helpers["_get_read_authorized_chat"] = lambda chat_id, _user: _chat_with_message(
        chat_id, _assistant_message()
    )

    descendants, truncated = helpers["_get_authorized_subagent_descendants"](
        root, SimpleNamespace(id="user-1"), limit=512
    )

    assert len(descendants) == 512
    assert descendants[0] == "child-0"
    assert descendants[-1] == "child-511"
    assert truncated is True


def test_new_routes_use_existing_read_authorization_gate():
    source = CHATS_ROUTER_PATH.read_text(encoding="utf-8")
    hydration_route = source[source.index('router.get("/{id}/hydrate"') :]
    hydration_route = hydration_route[: hydration_route.index("\n\n@router.get", 1)]
    descendant_route = source[source.index('router.get("/{id}/subagent-descendants"') :]
    descendant_route = descendant_route[: descendant_route.index("\n\n@router.get", 1)]

    assert "_get_read_authorized_chat_or_404(id, user)" in hydration_route
    assert "_get_read_authorized_chat_or_404(id, user)" in descendant_route
