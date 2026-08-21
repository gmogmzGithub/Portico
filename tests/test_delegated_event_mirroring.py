import asyncio
import importlib.util
import json
from pathlib import Path


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "src/patches/backend/open_webui/utils/delegated_events.py"
)


def _load_module():
    spec = importlib.util.spec_from_file_location("delegated_events_under_test", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class FakeRedis:
    def __init__(self, value=None, error=None):
        self.value = value
        self.error = error
        self.keys = []

    async def get(self, key):
        self.keys.append(key)
        if self.error:
            raise self.error
        return self.value


class FakeChats:
    def __init__(self, chats):
        self.chats = chats
        self.lookups = []

    def get_chat_by_id(self, chat_id):
        self.lookups.append(chat_id)
        return self.chats.get(chat_id)


class FakeSio:
    def __init__(self, error=None):
        self.error = error
        self.emits = []

    async def emit(self, event, payload, *, room):
        if self.error:
            raise self.error
        self.emits.append((event, payload, room))


def _base_factory(calls):
    def factory(request_info, update_db=True):
        async def emit(event):
            calls.append((event, update_db))

        return emit

    return factory


def test_delegated_progress_completion_cancel_and_error_mirror_to_root_owner():
    module = _load_module()
    base_calls = []
    redis = FakeRedis(
        json.dumps(
            {
                "parent_chat_id": "service-parent",
                "root_parent_chat_id": "human-root",
            }
        )
    )
    chats = FakeChats(
        {
            "human-root": {"user_id": "human-owner"},
            "service-parent": {"user_id": "portico-service"},
        }
    )
    sio = FakeSio()
    request_info = {
        "user_id": "portico-service",
        "chat_id": "child-chat",
        "message_id": "assistant-1",
        "session_id": "service-session",
    }
    emitter = module.get_event_emitter(
        request_info,
        base_factory=_base_factory(base_calls),
        redis_client=redis,
        chats_model=chats,
        sio_server=sio,
    )
    events = [
        {"type": "status", "data": {"description": "Searching"}},
        {"type": "chat:completion", "data": {"done": True}},
        {"type": "chat:tasks:cancel", "data": {"stop_reason": "client_disconnect"}},
        {"type": "chat:message:error", "data": {"error": {"content": "failed"}}},
    ]

    async def run():
        for event in events:
            await emitter(event)

    asyncio.run(run())

    assert [event for event, _ in base_calls] == events
    assert redis.keys == ["subagent_chat:child-chat"]
    assert chats.lookups == ["human-root"]
    assert sio.emits == [
        (
            "events",
            {
                "chat_id": "child-chat",
                "message_id": "assistant-1",
                "data": event,
            },
            "user:human-owner",
        )
        for event in events
    ]


def test_ordinary_chat_remains_on_base_emitter_only():
    module = _load_module()
    base_calls = []
    redis = FakeRedis(None)
    sio = FakeSio()
    emitter = module.get_event_emitter(
        {"user_id": "human-owner", "chat_id": "ordinary", "message_id": "message-1"},
        base_factory=_base_factory(base_calls),
        redis_client=redis,
        chats_model=FakeChats({}),
        sio_server=sio,
    )

    asyncio.run(emitter({"type": "status", "data": {"description": "Working"}}))
    asyncio.run(emitter({"type": "message", "data": {"content": "done"}}))

    assert len(base_calls) == 2
    assert redis.keys == ["subagent_chat:ordinary"]
    assert sio.emits == []


def test_redis_lookup_failure_falls_back_and_retries_without_interrupting_base():
    module = _load_module()
    base_calls = []
    redis = FakeRedis(error=RuntimeError("redis unavailable"))
    sio = FakeSio()
    emitter = module.get_event_emitter(
        {"user_id": "service", "chat_id": "child", "message_id": "message-1"},
        base_factory=_base_factory(base_calls),
        redis_client=redis,
        chats_model=FakeChats({}),
        sio_server=sio,
    )

    asyncio.run(emitter({"type": "status", "data": {}}))
    asyncio.run(emitter({"type": "chat:tasks:cancel"}))

    assert len(base_calls) == 2
    assert redis.keys == ["subagent_chat:child", "subagent_chat:child"]
    assert sio.emits == []


def test_owner_room_emit_failure_does_not_fail_base_delivery():
    module = _load_module()
    base_calls = []
    emitter = module.get_event_emitter(
        {"user_id": "service", "chat_id": "child", "message_id": "message-1"},
        base_factory=_base_factory(base_calls),
        redis_client=FakeRedis(json.dumps({"root_parent_chat_id": "root"})),
        chats_model=FakeChats({"root": {"user_id": "owner"}}),
        sio_server=FakeSio(error=RuntimeError("socket unavailable")),
    )

    asyncio.run(emitter({"type": "status", "data": {}}))

    assert len(base_calls) == 1


def test_delegated_chat_mirrors_even_when_authenticated_user_is_the_owner():
    module = _load_module()
    base_calls = []
    sio = FakeSio()
    emitter = module.get_event_emitter(
        {"user_id": "owner", "chat_id": "child", "message_id": "message-1"},
        base_factory=_base_factory(base_calls),
        redis_client=FakeRedis(json.dumps({"root_parent_chat_id": "root"})),
        chats_model=FakeChats({"root": {"user_id": "owner"}}),
        sio_server=sio,
    )

    event = {"type": "status", "data": {"description": "Working"}}
    asyncio.run(emitter(event))

    assert len(base_calls) == 1
    assert sio.emits == [
        (
            "events",
            {"chat_id": "child", "message_id": "message-1", "data": event},
            "user:owner",
        )
    ]


def test_event_call_imports_remain_session_bound_to_socket_module():
    repo_root = Path(__file__).resolve().parents[1]
    functions_source = (
        repo_root / "src/patches/backend/open_webui/functions.py"
    ).read_text()
    middleware_source = (
        repo_root / "src/patches/backend/open_webui/utils/middleware.py"
    ).read_text()

    assert "from open_webui.socket.main import (\n    get_event_call," in functions_source
    assert "from open_webui.socket.main import (\n    get_event_call," in middleware_source
    assert "from open_webui.utils.delegated_events import get_event_emitter" in functions_source
    assert "from open_webui.utils.delegated_events import get_event_emitter" in middleware_source
