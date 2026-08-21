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


class FakeHTTPException(Exception):
    def __init__(self, status_code=None, detail=None):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class FakeChat:
    def __init__(self, chat_id, user_id, chat=None, meta=None):
        self.id = chat_id
        self.user_id = user_id
        self.chat = chat if chat is not None else {}
        self.meta = meta if meta is not None else {}

    def model_dump(self):
        return {
            "id": self.id,
            "user_id": self.user_id,
            "chat": self.chat,
            "meta": self.meta,
        }


class FakeChats:
    def __init__(self, chats=None, recent_by_user=None):
        self.chats = {chat.id: chat for chat in chats or []}
        self.recent_by_user = recent_by_user or {}
        self.updated = []

    def get_chat_by_id_and_user_id(self, chat_id, user_id):
        chat = self.chats.get(chat_id)
        if chat and chat.user_id == user_id:
            return chat
        return None

    def get_chat_by_id(self, chat_id):
        return self.chats.get(chat_id)

    def get_chats_by_user_id(self, user_id):
        return self.recent_by_user.get(user_id, [])

    def update_chat_by_id(self, chat_id, payload):
        self.updated.append((chat_id, copy.deepcopy(payload)))
        chat = self.chats.get(chat_id)
        if chat:
            chat.chat = payload
        return chat


class FakeRedis:
    def __init__(self, values=None):
        self.values = values or {}

    def get(self, key):
        return self.values.get(key)


def _source_for_function(name):
    source = CHATS_ROUTER_PATH.read_text(encoding="utf-8")
    start = source.index(f"async def {name}") if f"async def {name}" in source else source.index(f"def {name}")
    next_def = source.find("\n\n@", start + 1)
    next_plain_def = source.find("\n\ndef ", start + 1)
    candidates = [value for value in (next_def, next_plain_def) if value != -1]
    end = min(candidates) if candidates else len(source)
    return source[start:end]


def _load_access_helpers(namespace_overrides=None):
    source = CHATS_ROUTER_PATH.read_text(encoding="utf-8")
    module_ast = ast.parse(source, filename=str(CHATS_ROUTER_PATH))
    helper_names = {
        "_chat_payload_dict",
        "_subagent_metadata_from_chat",
        "_subagent_parent_ids_from_metadata",
        "_read_subagent_reverse_metadata",
        "_parent_chat_is_owned_by_user",
        "_parsed_json_object",
        "_scheduled_run_metadata_from_payload",
        "_chat_has_scheduled_run_metadata",
        "_chat_is_trusted_scheduled_run",
        "_preserve_trusted_scheduled_metadata_on_save",
        "_result_references_subagent_child",
        "_chat_contains_subagent_child_result",
        "_iter_recent_user_chat_records",
        "_find_parent_chat_id_from_recent_results",
        "_cache_subagent_parent_metadata",
        "_get_read_authorized_chat",
        "_get_read_authorized_chat_or_404",
    }
    selected_nodes = [
        node
        for node in module_ast.body
        if isinstance(node, ast.FunctionDef) and node.name in helper_names
    ]

    namespace = {
        "Any": Any,
        "Optional": Optional,
        "copy": copy,
        "json": json,
        "SUBAGENT_SERVICE_USER_ID": "portico-service",
        "SUBAGENT_PARENT_REPAIR_SCAN_LIMIT": 80,
        "SCHEDULED_RUN_ORIGIN_KEY": "run_origin",
        "SCHEDULED_RUN_ORIGIN_VALUE": "scheduled",
        "SCHEDULED_TASK_ID_KEY": "scheduled_task_id",
        "SCHEDULED_TRUST_META_KEY": "scheduled_run_trusted_by_service",
        "Chats": None,
        "HTTPException": FakeHTTPException,
        "status": SimpleNamespace(HTTP_401_UNAUTHORIZED=401),
        "ERROR_MESSAGES": SimpleNamespace(NOT_FOUND="not found"),
        "log": SimpleNamespace(
            debug=lambda *_args, **_kwargs: None,
            info=lambda *_args, **_kwargs: None,
        ),
        "_get_redis_client": lambda: None,
    }
    if namespace_overrides:
        namespace.update(namespace_overrides)

    exec(
        compile(
            ast.Module(body=selected_nodes, type_ignores=[]),
            str(CHATS_ROUTER_PATH),
            "exec",
        ),
        namespace,
    )
    return namespace


def test_direct_chat_owner_read_still_wins():
    parent = FakeChat("parent", "user-1", {"title": "parent"})
    chats = FakeChats([parent])
    namespace = _load_access_helpers({"Chats": chats})

    result = namespace["_get_read_authorized_chat"]("parent", SimpleNamespace(id="user-1"))

    assert result is parent


def test_parent_owned_service_subagent_child_read_is_allowed_but_cross_user_denied():
    parent = FakeChat("parent", "user-1", {"title": "parent"})
    child = FakeChat(
        "child",
        "portico-service",
        {"meta": {"subagent": {"parent_chat_id": "parent", "root_parent_chat_id": "parent"}}},
    )
    chats = FakeChats([parent, child])
    namespace = _load_access_helpers({"Chats": chats})

    allowed = namespace["_get_read_authorized_chat"]("child", SimpleNamespace(id="user-1"))
    denied = namespace["_get_read_authorized_chat"]("child", SimpleNamespace(id="user-2"))

    assert allowed is child
    assert denied is None


def test_legacy_service_owned_scheduled_run_chat_read_is_allowed():
    child = FakeChat(
        "scheduled-child",
        "portico-service",
        {
            "meta": {
                "run_origin": "scheduled",
                "scheduled_task_id": "task-1",
                "scheduled_approved_scope": ["google_workspace"],
            }
        },
    )
    chats = FakeChats([child])
    namespace = _load_access_helpers({"Chats": chats})

    allowed = namespace["_get_read_authorized_chat"](
        "scheduled-child", SimpleNamespace(id="user-1")
    )

    assert allowed is child


def test_service_can_read_trusted_human_owned_scheduled_run_chat_only():
    trusted = FakeChat(
        "trusted-scheduled",
        "user-1",
        {
            "meta": {
                "run_origin": "scheduled",
                "scheduled_task_id": "task-1",
                "scheduled_approved_scope": ["google_workspace"],
            }
        },
        meta={"scheduled_run_trusted_by_service": True},
    )
    untrusted = FakeChat(
        "untrusted-scheduled",
        "user-1",
        {
            "meta": {
                "run_origin": "scheduled",
                "scheduled_task_id": "task-1",
                "scheduled_approved_scope": ["google_workspace"],
            }
        },
    )
    chats = FakeChats([trusted, untrusted])
    namespace = _load_access_helpers({"Chats": chats})

    service_user = SimpleNamespace(id="portico-service")

    assert namespace["_get_read_authorized_chat"]("trusted-scheduled", service_user) is trusted
    assert namespace["_get_read_authorized_chat"]("untrusted-scheduled", service_user) is None


def test_trusted_scheduled_metadata_is_preserved_on_user_save():
    chat = FakeChat(
        "scheduled-child",
        "user-1",
        {
            "meta": {
                "run_origin": "scheduled",
                "scheduled_task_id": "task-1",
                "scheduled_approved_scope": ["google_workspace"],
            }
        },
        meta={"scheduled_run_trusted_by_service": True},
    )
    namespace = _load_access_helpers()

    updated = namespace["_preserve_trusted_scheduled_metadata_on_save"](
        chat,
        {
            "meta": {
                "run_origin": "scheduled",
                "scheduled_task_id": "task-1",
                "scheduled_approved_scope": ["slack"],
                "other": "client",
            }
        },
    )

    assert updated["meta"] == {
        "run_origin": "scheduled",
        "scheduled_task_id": "task-1",
        "scheduled_approved_scope": ["google_workspace"],
        "other": "client",
    }


def test_redis_reverse_metadata_allows_read_and_caches_child_linkage():
    parent = FakeChat("parent", "user-1", {"title": "parent"})
    child = FakeChat("child", "portico-service", {"title": "child"})
    chats = FakeChats([parent, child])
    redis = FakeRedis(
        {
            "subagent_chat:child": json.dumps(
                {
                    "parent_chat_id": "parent",
                    "root_parent_chat_id": "root-parent",
                    "parent_tool_call_id": "tool-call-1",
                }
            )
        }
    )
    namespace = _load_access_helpers(
        {
            "Chats": chats,
            "_get_redis_client": lambda: redis,
        }
    )

    result = namespace["_get_read_authorized_chat"]("child", SimpleNamespace(id="user-1"))

    assert result is child
    assert chats.updated == [
        (
            "child",
            {
                "title": "child",
                "meta": {
                    "subagent": {
                        "parent_chat_id": "parent",
                        "root_parent_chat_id": "root-parent",
                        "parent_tool_call_id": "tool-call-1",
                    }
                },
            },
        )
    ]


def test_recent_parent_repair_fallback_discovers_exact_subagent_result_and_caches_linkage():
    parent = FakeChat(
        "parent",
        "user-1",
        {
            "messages": [
                {
                    "role": "assistant",
                    "contentBlocks": [
                        {
                            "type": "tool_calls",
                            "results": [
                                {
                                    "server_id": "server:subagents",
                                    "content": json.dumps({"chat_id": "child"}),
                                }
                            ],
                        }
                    ],
                }
            ]
        },
    )
    child = FakeChat("child", "portico-service", {"title": "child"})
    chats = FakeChats([parent, child], recent_by_user={"user-1": [parent]})
    namespace = _load_access_helpers({"Chats": chats})

    result = namespace["_get_read_authorized_chat"]("child", SimpleNamespace(id="user-1"))

    assert result is child
    assert chats.updated == [
        (
            "child",
            {
                "title": "child",
                "meta": {
                    "subagent": {
                        "parent_chat_id": "parent",
                        "root_parent_chat_id": "parent",
                    }
                },
            },
        )
    ]


def test_service_owned_subagent_children_do_not_gain_update_route_access():
    update_source = _source_for_function("update_chat_by_id")

    assert "Chats.get_chat_by_id_and_user_id(id, user.id)" in update_source
    assert "_get_read_authorized_chat" not in update_source


def test_subagent_details_read_routes_use_delegated_read_helper():
    assert "_get_read_authorized_chat_or_404(id, user)" in _source_for_function(
        "get_chat_by_id"
    )
    assert "_get_read_authorized_chat_or_404(id, user)" in _source_for_function(
        "get_chat_tags_by_id"
    )
    assert "_get_read_authorized_chat_or_404(id, user)" in _source_for_function(
        "get_chat_active_capabilities"
    )
    assert "_get_read_authorized_chat(chat_id, user)" in _source_for_function(
        "get_subagent_chat_by_tool_call"
    )
