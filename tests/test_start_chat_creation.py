"""Behavioral tests for the start_chat backend surface.

Covers the service-principal "create a chat owned by the primary human" branch
in routers/chats.py (`_delegated_human_chat_target_for_create` + its wiring in
`create_new_chat`). Follows the extract-and-exec technique from
tests/test_pending_chat_work.py: the real function bodies run against stubs
and are asserted on behavior — no source-text assertions.
"""

import asyncio
import json
import re
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Optional
from unittest.mock import AsyncMock, Mock


REPO_ROOT = Path(__file__).resolve().parents[1]
CHATS_ROUTER_PATH = REPO_ROOT / "src/patches/backend/open_webui/routers/chats.py"

SERVICE_USER_ID = "portico-service"


class _HTTPException(Exception):
    def __init__(self, status_code=None, detail=None):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class _RouterStub:
    def post(self, *args, **kwargs):
        return lambda fn: fn


def _source_segment(start_marker: str, end_marker: str) -> str:
    source = CHATS_ROUTER_PATH.read_text(encoding="utf-8")
    start = source.index(start_marker)
    end = source.index(end_marker, start)
    return source[start:end]


def _load_namespace():
    segment = _source_segment(
        "SERVICE_OWNER_PRIMARY_HUMAN =", "def _mark_scheduled_chat_trusted"
    )
    route_segment = _source_segment(
        '@router.post("/new", response_model=Optional[ChatResponse])',
        "############################\n# ImportChats",
    )
    namespace = {
        "Any": Any,
        "Optional": Optional,
        "ChatForm": object,
        "ChatResponse": lambda **kwargs: SimpleNamespace(**kwargs),
        "SUBAGENT_SERVICE_USER_ID": SERVICE_USER_ID,
        "HTTPException": _HTTPException,
        "status": SimpleNamespace(
            HTTP_400_BAD_REQUEST=400, HTTP_404_NOT_FOUND=404
        ),
        "ERROR_MESSAGES": SimpleNamespace(NOT_FOUND="not found", DEFAULT=lambda: "error"),
        "router": _RouterStub(),
        "Depends": lambda dependency: None,
        "get_verified_user": lambda: None,
        "log": SimpleNamespace(
            warning=Mock(), exception=Mock(), info=Mock(), debug=Mock()
        ),
        "_primary_human_user_id": lambda: "human-1",
        "_ensure_folder_for_user_id": Mock(return_value="folder-9"),
        "_copy_chat_form_with_folder_id": lambda form, folder_id: SimpleNamespace(
            **{**form.__dict__, "folder_id": folder_id}
        ),
        "_scheduled_chat_target_for_create": lambda form, user: (user.id, form, False),
        "_mark_scheduled_chat_trusted": Mock(),
        "Chats": SimpleNamespace(),
        # Multi-chat tiling additions in the extracted region: the validator
        # and registrar are defined by the segment itself; these are the
        # module-level names they reference. Non-tiling forms (no
        # service_started_by_chat_id) short-circuit before touching them.
        "re": re,
        "json": json,
        "time": time,
        "engine": SimpleNamespace(begin=Mock(side_effect=AssertionError("engine must not be touched"))),
        "sql_text": lambda s: s,
        "_parsed_json_object": lambda value: value if isinstance(value, dict) else {},
        "sio": object(),
        "emit_multi_chat_pane_added": AsyncMock(),
    }
    exec(segment, namespace)
    exec(route_segment, namespace)
    return namespace


def _make_form(service_owner=None, service_folder_name=None, folder_id=None):
    return SimpleNamespace(
        chat={"models": ["m1"], "history": {"messages": {}, "currentId": None}},
        folder_id=folder_id,
        service_owner=service_owner,
        service_folder_name=service_folder_name,
    )


def _service_user():
    return SimpleNamespace(id=SERVICE_USER_ID)


def _human_user():
    return SimpleNamespace(id="human-1")


def test_service_caller_with_primary_human_creates_chat_for_human():
    namespace = _load_namespace()
    target = namespace["_delegated_human_chat_target_for_create"]

    owner_id, form = target(_make_form(service_owner="primary-human"), _service_user())

    assert owner_id == "human-1"
    namespace["_ensure_folder_for_user_id"].assert_not_called()
    assert form.folder_id is None


def test_service_caller_folder_name_creates_human_owned_folder():
    namespace = _load_namespace()
    target = namespace["_delegated_human_chat_target_for_create"]

    owner_id, form = target(
        _make_form(service_owner="primary-human", service_folder_name="Research"),
        _service_user(),
    )

    assert owner_id == "human-1"
    namespace["_ensure_folder_for_user_id"].assert_called_once_with("human-1", "Research")
    assert form.folder_id == "folder-9"


def test_blank_folder_name_skips_folder_rewrite():
    namespace = _load_namespace()
    target = namespace["_delegated_human_chat_target_for_create"]

    _, form = target(
        _make_form(service_owner="primary-human", service_folder_name="   "),
        _service_user(),
    )

    namespace["_ensure_folder_for_user_id"].assert_not_called()
    assert form.folder_id is None


def test_service_caller_without_signal_keeps_service_ownership():
    namespace = _load_namespace()
    target = namespace["_delegated_human_chat_target_for_create"]

    owner_id, _ = target(_make_form(), _service_user())
    assert owner_id == SERVICE_USER_ID

    owner_id, _ = target(_make_form(service_owner="someone-else"), _service_user())
    assert owner_id == SERVICE_USER_ID


def test_non_service_caller_signal_is_ignored_with_warning():
    namespace = _load_namespace()
    target = namespace["_delegated_human_chat_target_for_create"]

    owner_id, _ = target(_make_form(service_owner="primary-human"), _human_user())

    assert owner_id == "human-1"
    namespace["_ensure_folder_for_user_id"].assert_not_called()
    namespace["log"].warning.assert_called_once()


def test_missing_primary_human_raises_400():
    namespace = _load_namespace()
    namespace["_primary_human_user_id"] = lambda: None
    # Re-exec so the helper closes over the new stub? Not needed: the exec'd
    # function looks the name up in its globals (the namespace dict) at call
    # time, so mutating the dict is sufficient.
    target = namespace["_delegated_human_chat_target_for_create"]

    try:
        target(_make_form(service_owner="primary-human"), _service_user())
    except _HTTPException as error:
        assert error.status_code == 400
    else:
        raise AssertionError("expected HTTPException 400 when no human exists")


def test_create_new_chat_wires_delegated_branch_and_skips_trust_stamp():
    namespace = _load_namespace()
    inserted = {}

    def insert_new_chat(user_id, form):
        inserted["user_id"] = user_id
        inserted["form"] = form
        return SimpleNamespace(
            model_dump=lambda: {
                "id": "c1",
                "user_id": user_id,
                "title": "New Chat",
                "chat": {},
                "updated_at": 0,
                "created_at": 0,
                "archived": False,
            },
            id="c1",
        )

    namespace["Chats"] = SimpleNamespace(insert_new_chat=insert_new_chat)
    route = namespace["create_new_chat"]

    response = asyncio.run(
        route(_make_form(service_owner="primary-human"), user=_service_user())
    )

    assert inserted["user_id"] == "human-1"
    assert response.user_id == "human-1"
    namespace["_mark_scheduled_chat_trusted"].assert_not_called()


def test_create_new_chat_scheduled_branch_keeps_precedence():
    namespace = _load_namespace()
    scheduled_form = _make_form(service_owner="primary-human")

    namespace["_scheduled_chat_target_for_create"] = lambda form, user: (
        "scheduled-owner",
        form,
        True,
    )
    delegated_spy = Mock(side_effect=AssertionError("delegated branch must not run"))
    namespace["_delegated_human_chat_target_for_create"] = delegated_spy

    inserted = {}

    def insert_new_chat(user_id, form):
        inserted["user_id"] = user_id
        return SimpleNamespace(
            model_dump=lambda: {
                "id": "c2",
                "user_id": user_id,
                "title": "New Chat",
                "chat": {},
                "updated_at": 0,
                "created_at": 0,
                "archived": False,
            },
            id="c2",
        )

    namespace["Chats"] = SimpleNamespace(
        insert_new_chat=insert_new_chat, get_chat_by_id=lambda chat_id: None
    )
    route = namespace["create_new_chat"]

    asyncio.run(route(scheduled_form, user=_service_user()))

    assert inserted["user_id"] == "scheduled-owner"
    namespace["_mark_scheduled_chat_trusted"].assert_called_once_with("c2")
    delegated_spy.assert_not_called()


def test_human_caller_path_unchanged():
    namespace = _load_namespace()
    inserted = {}

    def insert_new_chat(user_id, form):
        inserted["user_id"] = user_id
        return SimpleNamespace(
            model_dump=lambda: {
                "id": "c3",
                "user_id": user_id,
                "title": "New Chat",
                "chat": {},
                "updated_at": 0,
                "created_at": 0,
                "archived": False,
            },
            id="c3",
        )

    namespace["Chats"] = SimpleNamespace(insert_new_chat=insert_new_chat)
    route = namespace["create_new_chat"]

    asyncio.run(route(_make_form(), user=_human_user()))

    assert inserted["user_id"] == "human-1"
    namespace["_mark_scheduled_chat_trusted"].assert_not_called()


def test_chat_form_without_new_fields_still_validates():
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "portico_chat_models_probe",
        REPO_ROOT / "src/patches/backend/open_webui/models/chats.py",
    )
    # Importing the real module pulls in the OWUI dependency tree; instead,
    # assert the pydantic contract through a minimal re-exec of the ChatForm
    # class body with BaseModel available.
    source = (REPO_ROOT / "src/patches/backend/open_webui/models/chats.py").read_text(
        encoding="utf-8"
    )
    start = source.index("class ChatForm(BaseModel):")
    end = source.index("class ChatImportForm", start)
    from pydantic import BaseModel

    namespace = {"BaseModel": BaseModel, "Optional": Optional}
    exec(source[start:end], namespace)
    chat_form_cls = namespace["ChatForm"]

    legacy = chat_form_cls(chat={"models": ["m1"]})
    assert legacy.service_owner is None
    assert legacy.service_folder_name is None

    delegated = chat_form_cls(
        chat={}, service_owner="primary-human", service_folder_name="Research"
    )
    assert delegated.service_owner == "primary-human"
