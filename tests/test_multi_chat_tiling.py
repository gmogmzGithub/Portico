"""Behavioral tests for the multi-chat tiling backend plumbing.

Covers the routers.chats pieces behind subagents_start_chat tiling:
- _validate_multi_chat_start — child-block, pane cap, display-name rules
- _register_multi_chat_pane — one-transaction child+root meta stamping
- create_new_chat — structured HTTPExceptions surface verbatim; pane
  registration + socket emit run for tiling starts
- pending_chat_work.emit_multi_chat_pane_added — event envelope

Follows the extract-and-exec technique from tests/test_cross_chat_messaging.py:
the real function bodies execute against stubs and are asserted on behavior.
"""

import asyncio
import json
import re
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Optional
from unittest.mock import AsyncMock


REPO_ROOT = Path(__file__).resolve().parents[1]
CHATS_ROUTER_PATH = REPO_ROOT / "src/patches/backend/open_webui/routers/chats.py"
PENDING_WORK_PATH = REPO_ROOT / "src/patches/backend/open_webui/utils/pending_chat_work.py"

SERVICE_USER_ID = "portico-service"


def _source_segment(path: Path, start_marker: str, end_marker: str) -> str:
    source = path.read_text(encoding="utf-8")
    start = source.index(start_marker)
    end = source.index(end_marker, start)
    return source[start:end]


class FakeHTTPException(Exception):
    def __init__(self, status_code, detail):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class FakeChats:
    def __init__(self):
        self.chats = {}

    def get_chat_by_id(self, chat_id):
        return self.chats.get(chat_id)


def _parsed_json_object(value):
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return {}


class FakeConn:
    """Captures raw-SQL meta reads/writes keyed by chat id."""

    def __init__(self, store):
        self.store = store

    def execute(self, statement, params):
        text = str(statement)
        chat_id = params["chat_id"]
        if text.strip().upper().startswith("SELECT"):
            row = (
                {"meta": self.store[chat_id]} if chat_id in self.store else None
            )
            return SimpleNamespace(mappings=lambda: SimpleNamespace(first=lambda: row))
        self.store[chat_id] = params["meta"]
        return SimpleNamespace()


class FakeEngine:
    def __init__(self, store):
        self.store = store
        self.begin_count = 0

    def begin(self):
        engine = self

        class _Ctx:
            def __enter__(self_inner):
                engine.begin_count += 1
                return FakeConn(engine.store)

            def __exit__(self_inner, *args):
                return False

        return _Ctx()


def _load_tiling_helpers(chats=None, engine_store=None):
    segment = _source_segment(
        CHATS_ROUTER_PATH,
        "MULTI_CHAT_META_KEY",
        "def _delegated_human_chat_target_for_create",
    )
    store = engine_store if engine_store is not None else {}
    namespace = {
        "re": re,
        "json": json,
        "time": time,
        "Optional": Optional,
        "Any": Any,
        "HTTPException": FakeHTTPException,
        "status": SimpleNamespace(HTTP_400_BAD_REQUEST=400),
        "Chats": chats if chats is not None else FakeChats(),
        "ChatForm": object,
        "SUBAGENT_SERVICE_USER_ID": SERVICE_USER_ID,
        "SERVICE_OWNER_PRIMARY_HUMAN": "primary-human",
        "engine": FakeEngine(store),
        "sql_text": lambda s: s,
        "_parsed_json_object": _parsed_json_object,
        "log": SimpleNamespace(warning=lambda *a, **k: None),
    }
    exec(segment, namespace)
    return namespace


def _service_form(**overrides):
    fields = {
        "service_owner": "primary-human",
        "service_started_by_chat_id": "root-1",
        "service_pane_display_name": "Reviewer",
    }
    fields.update(overrides)
    return SimpleNamespace(**fields)


def _service_user():
    return SimpleNamespace(id=SERVICE_USER_ID)


def _root_chat(meta=None):
    return SimpleNamespace(id="root-1", meta=meta if meta is not None else {})


# ---------------------------------------------------------------------------
# _validate_multi_chat_start
# ---------------------------------------------------------------------------


def test_validate_returns_root_and_name_for_a_plain_root_start():
    chats = FakeChats()
    chats.chats["root-1"] = _root_chat()
    ns = _load_tiling_helpers(chats=chats)
    assert ns["_validate_multi_chat_start"](_service_form(), _service_user()) == (
        "root-1",
        "Reviewer",
    )


def test_validate_skips_non_service_and_non_delegated_and_sourceless_starts():
    chats = FakeChats()
    chats.chats["root-1"] = _root_chat()
    ns = _load_tiling_helpers(chats=chats)
    validate = ns["_validate_multi_chat_start"]

    assert validate(_service_form(), SimpleNamespace(id="human-1")) is None
    assert validate(_service_form(service_owner=None), _service_user()) is None
    assert (
        validate(_service_form(service_started_by_chat_id="  "), _service_user())
        is None
    )


def test_validate_blocks_child_chats_from_starting_chats():
    chats = FakeChats()
    chats.chats["root-1"] = _root_chat(
        meta={"multi_chat": {"started_by_chat_id": "grandroot", "display_name": "Kid"}}
    )
    ns = _load_tiling_helpers(chats=chats)
    try:
        ns["_validate_multi_chat_start"](_service_form(), _service_user())
        raise AssertionError("expected HTTPException")
    except FakeHTTPException as error:
        assert error.status_code == 400
        assert error.detail["code"] == "child_chat_cannot_start_chats"
        assert "send_message_to_chat" in error.detail["message"]


def test_validate_rejects_a_full_tile_grid():
    chats = FakeChats()
    chats.chats["root-1"] = _root_chat(
        meta={
            "multi_chat_panes": [
                {"chat_id": f"c{i}", "display_name": f"P{i}", "created_at": 1}
                for i in range(3)
            ]
        }
    )
    ns = _load_tiling_helpers(chats=chats)
    try:
        ns["_validate_multi_chat_start"](_service_form(), _service_user())
        raise AssertionError("expected HTTPException")
    except FakeHTTPException as error:
        assert error.detail["code"] == "multi_chat_tiles_full"


def test_validate_rejects_missing_source_chat():
    ns = _load_tiling_helpers(chats=FakeChats())
    try:
        ns["_validate_multi_chat_start"](_service_form(), _service_user())
        raise AssertionError("expected HTTPException")
    except FakeHTTPException as error:
        assert error.detail["code"] == "source_chat_not_found"


def test_validate_display_name_rules():
    chats = FakeChats()
    chats.chats["root-1"] = _root_chat()
    ns = _load_tiling_helpers(chats=chats)
    validate = ns["_validate_multi_chat_start"]

    for bad in ["", "two words", "x" * 25, "Orchestrator", "orchestrator", "a|b", "π"]:
        try:
            validate(
                _service_form(service_pane_display_name=bad), _service_user()
            )
            raise AssertionError(f"expected rejection for {bad!r}")
        except FakeHTTPException as error:
            assert error.detail["code"] == "invalid_display_name"

    for good in ["Reviewer", "qa-bot", "Pane_2", "  Critic  "]:
        root, name = validate(
            _service_form(service_pane_display_name=good), _service_user()
        )
        assert root == "root-1"
        assert name == good.strip()


# ---------------------------------------------------------------------------
# _register_multi_chat_pane
# ---------------------------------------------------------------------------


def test_register_stamps_child_and_root_in_one_transaction():
    store = {
        "root-1": json.dumps({"existing": True}),
        "child-1": json.dumps({}),
    }
    ns = _load_tiling_helpers(engine_store=store)
    pane = ns["_register_multi_chat_pane"]("root-1", "child-1", "Reviewer")

    assert pane["chat_id"] == "child-1"
    assert pane["display_name"] == "Reviewer"
    assert isinstance(pane["created_at"], int)
    assert ns["engine"].begin_count == 1

    child_meta = json.loads(store["child-1"])
    assert child_meta["multi_chat"] == {
        "started_by_chat_id": "root-1",
        "display_name": "Reviewer",
    }
    root_meta = json.loads(store["root-1"])
    assert root_meta["existing"] is True
    assert root_meta["multi_chat_panes"] == [pane]


def test_register_appends_to_existing_panes_and_respects_cap():
    existing = [
        {"chat_id": f"c{i}", "display_name": f"P{i}", "created_at": 1} for i in range(2)
    ]
    store = {
        "root-1": json.dumps({"multi_chat_panes": existing}),
        "child-3": json.dumps({}),
    }
    ns = _load_tiling_helpers(engine_store=store)
    pane = ns["_register_multi_chat_pane"]("root-1", "child-3", "Third")
    assert pane is not None
    assert [p["chat_id"] for p in json.loads(store["root-1"])["multi_chat_panes"]] == [
        "c0",
        "c1",
        "child-3",
    ]

    # Grid now full: a concurrent fourth registration is refused with NO
    # partial writes (child meta untouched).
    store["child-4"] = json.dumps({})
    assert ns["_register_multi_chat_pane"]("root-1", "child-4", "Fourth") is None
    assert json.loads(store["child-4"]) == {}
    assert len(json.loads(store["root-1"])["multi_chat_panes"]) == 3


# ---------------------------------------------------------------------------
# create_new_chat wiring
# ---------------------------------------------------------------------------


def _load_create_new_chat(namespace_overrides):
    segment = _source_segment(
        CHATS_ROUTER_PATH,
        "async def create_new_chat",
        "############################\n# ImportChats",
    )

    class _ChatResponse(dict):
        def __init__(self, **kwargs):
            super().__init__(**kwargs)

    inserted = SimpleNamespace(
        id="child-1", model_dump=lambda: {"id": "child-1", "meta": {}}
    )
    namespace = {
        "Optional": Optional,
        "Depends": lambda dependency: None,
        "get_verified_user": lambda: None,
        "ChatForm": object,
        "HTTPException": FakeHTTPException,
        "status": SimpleNamespace(HTTP_400_BAD_REQUEST=400),
        "ERROR_MESSAGES": SimpleNamespace(DEFAULT=lambda: "generic"),
        "log": SimpleNamespace(exception=lambda e: None, warning=lambda *a, **k: None),
        "ChatResponse": _ChatResponse,
        "Chats": SimpleNamespace(
            insert_new_chat=lambda user_id, form: inserted,
            get_chat_by_id=lambda chat_id: inserted,
        ),
        "_scheduled_chat_target_for_create": lambda form, user: (user.id, form, False),
        "_delegated_human_chat_target_for_create": lambda form, user: (
            "human-1",
            form,
        ),
        "_mark_scheduled_chat_trusted": lambda chat_id: None,
        "sio": object(),
    }
    namespace.update(namespace_overrides)
    exec(segment, namespace)
    return namespace["create_new_chat"], namespace


def test_create_new_chat_reraises_structured_policy_errors():
    def _raise(form, user):
        raise FakeHTTPException(400, {"code": "multi_chat_tiles_full", "message": "x"})

    create_new_chat, _ = _load_create_new_chat(
        {"_validate_multi_chat_start": _raise, "_register_multi_chat_pane": None,
         "emit_multi_chat_pane_added": AsyncMock()}
    )
    try:
        asyncio.run(create_new_chat(_service_form(), _service_user()))
        raise AssertionError("expected HTTPException")
    except FakeHTTPException as error:
        assert error.detail["code"] == "multi_chat_tiles_full"


def test_create_new_chat_registers_pane_and_emits_event_for_tiling_starts():
    emit = AsyncMock()
    registered = []

    def _register(root, child, name):
        registered.append((root, child, name))
        return {"chat_id": child, "display_name": name, "created_at": 5}

    create_new_chat, _ = _load_create_new_chat(
        {
            "_validate_multi_chat_start": lambda form, user: ("root-1", "Reviewer"),
            "_register_multi_chat_pane": _register,
            "emit_multi_chat_pane_added": emit,
        }
    )
    result = asyncio.run(create_new_chat(_service_form(), _service_user()))
    assert result["id"] == "child-1"
    assert registered == [("root-1", "child-1", "Reviewer")]
    emit.assert_awaited_once()
    kwargs = emit.await_args.kwargs
    assert kwargs["user_id"] == "human-1"
    assert kwargs["root_chat_id"] == "root-1"
    assert kwargs["pane"]["chat_id"] == "child-1"


def test_create_new_chat_emit_failure_never_fails_the_creation():
    emit = AsyncMock(side_effect=RuntimeError("socket down"))
    create_new_chat, _ = _load_create_new_chat(
        {
            "_validate_multi_chat_start": lambda form, user: ("root-1", "Reviewer"),
            "_register_multi_chat_pane": lambda *a: {
                "chat_id": "child-1",
                "display_name": "Reviewer",
                "created_at": 5,
            },
            "emit_multi_chat_pane_added": emit,
        }
    )
    result = asyncio.run(create_new_chat(_service_form(), _service_user()))
    assert result["id"] == "child-1"


def test_create_new_chat_skips_tiling_for_non_tiling_starts():
    emit = AsyncMock()
    create_new_chat, _ = _load_create_new_chat(
        {
            "_validate_multi_chat_start": lambda form, user: None,
            "_register_multi_chat_pane": lambda *a: (_ for _ in ()).throw(
                AssertionError("must not register")
            ),
            "emit_multi_chat_pane_added": emit,
        }
    )
    result = asyncio.run(create_new_chat(_service_form(), _service_user()))
    assert result["id"] == "child-1"
    emit.assert_not_awaited()


# ---------------------------------------------------------------------------
# emit_multi_chat_pane_added envelope
# ---------------------------------------------------------------------------


def test_emit_multi_chat_pane_added_envelope():
    import copy

    segment = _source_segment(
        PENDING_WORK_PATH,
        "async def emit_multi_chat_pane_added",
        "async def emit_background_turn_inserted",
    )
    namespace = {"Any": Any, "copy": copy}
    exec(segment, namespace)

    captured = {}

    class FakeSio:
        async def emit(self, event, data, room=None):
            captured["event"] = event
            captured["data"] = data
            captured["room"] = room

    pane = {"chat_id": "child-1", "display_name": "Reviewer", "created_at": 5}
    asyncio.run(
        namespace["emit_multi_chat_pane_added"](
            sio=FakeSio(), user_id="human-1", root_chat_id="root-1", pane=pane
        )
    )

    assert captured["event"] == "events"
    assert captured["room"] == "user:human-1"
    assert captured["data"]["chat_id"] == "root-1"
    assert captured["data"]["data"]["type"] == "chat:multi-chat:pane-added"
    inner = captured["data"]["data"]["data"]
    assert inner["root_chat_id"] == "root-1"
    assert inner["pane"] == pane
    assert inner["pane"] is not pane  # deep-copied, caller mutations don't leak


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS {name}")
            except Exception as error:  # noqa: BLE001
                failures += 1
                print(f"FAIL {name}: {error}")
    raise SystemExit(1 if failures else 0)
