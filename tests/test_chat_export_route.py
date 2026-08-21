import ast
import asyncio
from pathlib import Path
from types import SimpleNamespace


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


def _load_get_user_chats(namespace_overrides=None):
    source = CHATS_ROUTER_PATH.read_text(encoding="utf-8")
    module_ast = ast.parse(source, filename=str(CHATS_ROUTER_PATH))
    selected_nodes = [
        node
        for node in module_ast.body
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "get_user_chats"
    ]

    assert len(selected_nodes) == 1, "expected exactly one get_user_chats definition"

    namespace = {
        "router": SimpleNamespace(get=lambda *_args, **_kwargs: (lambda fn: fn)),
        "Depends": lambda dependency: dependency,
        "get_verified_user": lambda: None,
        "Chats": None,
        "ChatResponse": FakeChatResponse,
        "HTTPException": FakeHTTPException,
        "status": SimpleNamespace(HTTP_400_BAD_REQUEST=400),
        "ERROR_MESSAGES": SimpleNamespace(DEFAULT=lambda: "default error"),
        "log": SimpleNamespace(exception=lambda *_args, **_kwargs: None),
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
    return namespace["get_user_chats"]


def test_get_user_chats_exports_result_items_without_iterating_wrapper():
    class FakeChatModel:
        def __init__(self, chat_id, title):
            self.chat_id = chat_id
            self.title = title

        def model_dump(self):
            return {
                "id": self.chat_id,
                "user_id": "user-1",
                "title": self.title,
                "chat": {"title": self.title},
                "updated_at": 123,
                "created_at": 122,
                "share_id": None,
                "archived": False,
                "pinned": False,
                "meta": {},
                "folder_id": None,
            }

    class FakeChatListResponse:
        def __init__(self, items):
            self.items = items
            self.total = len(items)

        def __iter__(self):
            raise AssertionError("route iterated ChatListResponse directly")

    chats_stub = SimpleNamespace(
        get_chats_by_user_id=lambda user_id: FakeChatListResponse(
            [
                FakeChatModel("chat-1", "First export"),
                FakeChatModel("chat-2", "Second export"),
            ]
        )
    )
    get_user_chats = _load_get_user_chats({"Chats": chats_stub})

    result = asyncio.run(get_user_chats(SimpleNamespace(id="user-1")))

    assert [entry.payload["id"] for entry in result] == ["chat-1", "chat-2"]
    assert [entry.payload["title"] for entry in result] == [
        "First export",
        "Second export",
    ]


def test_get_user_chats_wraps_backend_failures_in_json_http_exception():
    chats_stub = SimpleNamespace(
        get_chats_by_user_id=lambda user_id: (_ for _ in ()).throw(RuntimeError("boom"))
    )
    log_events = []
    get_user_chats = _load_get_user_chats(
        {
            "Chats": chats_stub,
            "log": SimpleNamespace(
                exception=lambda error: log_events.append(str(error)),
            ),
        }
    )

    try:
        asyncio.run(get_user_chats(SimpleNamespace(id="user-1")))
        raise AssertionError("expected get_user_chats to raise FakeHTTPException")
    except FakeHTTPException as error:
        assert error.status_code == 400
        assert error.detail == "default error"

    assert log_events == ["boom"]
