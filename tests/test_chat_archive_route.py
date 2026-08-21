import ast
import asyncio
import time as time_module
from pathlib import Path
from types import SimpleNamespace
from typing import Optional


ROOT = Path(__file__).resolve().parents[1]
CHATS_ROUTER_PATH = (
    ROOT / "src" / "patches" / "backend" / "open_webui" / "routers" / "chats.py"
)


class FakeChatResponse:
    def __init__(self, **kwargs):
        self.payload = kwargs


class FakeHTTPException(Exception):
    def __init__(self, status_code=None, detail=None):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class FakeChatModel:
    def __init__(self, *, archived, meta=None):
        self.archived = archived
        self.meta = meta or {}

    def model_dump(self):
        return {
            "id": "chat-1",
            "user_id": "user-1",
            "title": "Archive test",
            "chat": {},
            "updated_at": 123,
            "created_at": 122,
            "share_id": None,
            "archived": self.archived,
            "pinned": False,
            "meta": self.meta,
            "folder_id": None,
        }


def _router_nodes(*names):
    source = CHATS_ROUTER_PATH.read_text(encoding="utf-8")
    module_ast = ast.parse(source, filename=str(CHATS_ROUTER_PATH))
    selected = [
        node
        for node in module_ast.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name in names
    ]
    assert {node.name for node in selected} == set(names)
    return selected


def _load_archive_route(namespace_overrides=None):
    namespace = {
        "Optional": Optional,
        "ChatResponse": FakeChatResponse,
        "router": SimpleNamespace(post=lambda *_args, **_kwargs: (lambda fn: fn)),
        "Depends": lambda dependency: dependency,
        "get_verified_user": lambda: None,
        "HTTPException": FakeHTTPException,
        "status": SimpleNamespace(HTTP_500_INTERNAL_SERVER_ERROR=500, HTTP_401_UNAUTHORIZED=401),
        "ERROR_MESSAGES": SimpleNamespace(DEFAULT=lambda: "default error"),
        "Tags": SimpleNamespace(),
    }
    if namespace_overrides:
        namespace.update(namespace_overrides)
    exec(
        compile(
            ast.Module(body=_router_nodes("archive_chat_by_id"), type_ignores=[]),
            str(CHATS_ROUTER_PATH),
            "exec",
        ),
        namespace,
    )
    return namespace["archive_chat_by_id"]


def test_exact_archive_state_is_idempotent_and_owner_scoped():
    row = SimpleNamespace(
        user_id="user-1",
        archived=False,
        folder_id="folder-1",
        updated_at=100,
    )

    class FakeDb:
        commits = 0

        def get(self, model, chat_id):
            assert model is FakeChat
            assert chat_id == "chat-1"
            return row

        def commit(self):
            self.commits += 1

    db = FakeDb()

    class DbContext:
        def __enter__(self):
            return db

        def __exit__(self, *_args):
            return False

    expected = FakeChatModel(archived=True)
    chats = SimpleNamespace(
        get_chat_by_id_and_user_id=lambda chat_id, user_id: expected
    )
    namespace = {
        "Chat": FakeChat,
        "Chats": chats,
        "get_db": lambda: DbContext(),
        "time": time_module,
    }
    exec(
        compile(
            ast.Module(
                body=_router_nodes("_set_chat_archived_by_id_and_user_id"),
                type_ignores=[],
            ),
            str(CHATS_ROUTER_PATH),
            "exec",
        ),
        namespace,
    )
    set_archived = namespace["_set_chat_archived_by_id_and_user_id"]

    result = set_archived("chat-1", "user-1", True)
    assert result is expected
    assert row.archived is True
    assert row.folder_id is None
    assert row.updated_at >= 100
    assert db.commits == 1

    result = set_archived("chat-1", "user-1", True)
    assert result is expected
    assert db.commits == 1

    assert set_archived("chat-1", "another-user", True) is None
    assert db.commits == 1


class FakeChat:
    pass


def test_archive_route_preserves_legacy_toggle_and_supports_exact_state():
    initial = FakeChatModel(archived=False)
    exact = FakeChatModel(archived=True)
    calls = []
    chats = SimpleNamespace(
        get_chat_by_id_and_user_id=lambda _chat_id, _user_id: initial,
        toggle_chat_archive_by_id=lambda chat_id: (
            calls.append(("toggle", chat_id)) or exact
        ),
        count_chats_by_tag_name_and_user_id=lambda *_args: 1,
    )
    tags = SimpleNamespace(
        delete_tag_by_name_and_user_id=lambda *_args: None,
        get_tag_by_name_and_user_id=lambda *_args: object(),
        insert_new_tag=lambda *_args: None,
    )
    route = _load_archive_route(
        {
            "Chats": chats,
            "Tags": tags,
            "_set_chat_archived_by_id_and_user_id": lambda chat_id, user_id, archived: (
                calls.append(("set", chat_id, user_id, archived)) or exact
            ),
        }
    )
    user = SimpleNamespace(id="user-1")

    exact_result = asyncio.run(route("chat-1", True, user))
    assert exact_result.payload["archived"] is True
    assert calls == [("set", "chat-1", "user-1", True)]

    calls.clear()
    legacy_result = asyncio.run(route("chat-1", None, user))
    assert legacy_result.payload["archived"] is True
    assert calls == [("toggle", "chat-1")]
