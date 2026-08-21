"""Behavioral tests for the cross-chat messaging plumbing.

Covers the two OWUI backend-patch pieces behind subagents_list_chats and
subagents_send_message_to_chat:
- middleware._force_cross_chat_context — trusted source-context injection
- routers.chats queued-prompts service branch — service principal delivery
  into another user's chat, draining as the chat owner with a defaulted model

Follows the extract-and-exec technique from tests/test_pending_chat_work.py:
the real function bodies are executed against stubs and asserted on behavior.
"""

import asyncio
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Optional
from unittest.mock import AsyncMock, Mock


REPO_ROOT = Path(__file__).resolve().parents[1]
MIDDLEWARE_PATH = REPO_ROOT / "src/patches/backend/open_webui/utils/middleware.py"
CHATS_ROUTER_PATH = REPO_ROOT / "src/patches/backend/open_webui/routers/chats.py"

SERVICE_USER_ID = "portico-service"

SEND_TOOL = "subagents_send_message_to_chat"
LIST_TOOL = "subagents_list_chats"

SEND_SPEC = {
    "parameters": {
        "properties": {
            "target_chat_id": {},
            "message": {},
            "source_chat_id": {},
            "source_model_name": {},
            "source_is_agent": {},
            "source_display_name": {},
            "source_model_id": {},
        }
    }
}
LEGACY_SEND_SPEC = {
    "parameters": {
        "properties": {
            "target_chat_id": {},
            "message": {},
            "source_chat_id": {},
            "source_model_name": {},
            "source_is_agent": {},
        }
    }
}
LIST_SPEC = {"parameters": {"properties": {"days": {}, "owner_user_id": {}}}}


def _source_segment(path: Path, start_marker: str, end_marker: str) -> str:
    source = path.read_text(encoding="utf-8")
    start = source.index(start_marker)
    end = source.index(end_marker, start)
    return source[start:end]


class _FakeChats:
    """Stubbed Chats model: chat_id -> object with .meta."""

    def __init__(self):
        self.chats = {}
        self.lookups = []

    def get_chat_by_id(self, chat_id):
        self.lookups.append(chat_id)
        return self.chats.get(chat_id)


_fake_chats = _FakeChats()


def _load_force_cross_chat_context():
    segment = _source_segment(
        MIDDLEWARE_PATH, "def _force_cross_chat_context", "def _safe_json_loads"
    )
    namespace = {"Optional": Optional, "Chats": _fake_chats}
    exec(segment, namespace)
    return namespace["_force_cross_chat_context"]


_force_cross_chat_context = _load_force_cross_chat_context()


def _agent_metadata():
    return {
        "chat_id": "chat-src",
        "user_id": "human-1",
        "model": {
            "id": "portico_agent_x",
            "name": "Research Agent",
            "info": {"base_model_id": "gpt"},
        },
    }


def _base_model_metadata():
    return {
        "chat_id": "chat-src",
        "user_id": "human-1",
        "model": {"id": "gpt", "name": "GPT-5.6 Terra", "info": {}},
    }


def test_force_cross_chat_context_injects_agent_source_and_overrides_spoofed_values():
    params = {
        "target_chat_id": "chat-target",
        "message": "hello",
        "source_chat_id": "spoofed-chat",
        "source_model_name": "Spoofed Name",
        "source_is_agent": False,
    }
    result = _force_cross_chat_context(
        SEND_TOOL, params, _agent_metadata(), tool_spec=SEND_SPEC
    )
    assert result["source_chat_id"] == "chat-src"
    assert result["source_model_name"] == "Research Agent"
    assert result["source_is_agent"] is True
    assert result["target_chat_id"] == "chat-target"
    assert result["message"] == "hello"


def test_force_cross_chat_context_marks_base_models_as_not_agent():
    result = _force_cross_chat_context(
        SEND_TOOL,
        {"target_chat_id": "t", "message": "m"},
        _base_model_metadata(),
        tool_spec=SEND_SPEC,
    )
    assert result["source_model_name"] == "GPT-5.6 Terra"
    assert result["source_is_agent"] is False


def test_force_cross_chat_context_pops_local_and_missing_source_context():
    metadata = _agent_metadata()
    metadata["chat_id"] = "local:draft"
    result = _force_cross_chat_context(
        SEND_TOOL,
        {"target_chat_id": "t", "message": "m", "source_chat_id": "spoofed"},
        metadata,
        tool_spec=SEND_SPEC,
    )
    assert "source_chat_id" not in result

    result = _force_cross_chat_context(
        SEND_TOOL,
        {"target_chat_id": "t", "message": "m", "source_model_name": "spoofed"},
        {"chat_id": "chat-src"},
        tool_spec=SEND_SPEC,
    )
    assert result["source_chat_id"] == "chat-src"
    assert "source_model_name" not in result
    assert "source_is_agent" not in result


def test_force_cross_chat_context_injects_owner_for_list_tool():
    result = _force_cross_chat_context(
        LIST_TOOL,
        {"days": 14, "owner_user_id": "spoofed"},
        _agent_metadata(),
        tool_spec=LIST_SPEC,
    )
    assert result["owner_user_id"] == "human-1"
    assert result["days"] == 14

    result = _force_cross_chat_context(
        LIST_TOOL, {"owner_user_id": "spoofed"}, {}, tool_spec=LIST_SPEC
    )
    assert "owner_user_id" not in result


def test_force_cross_chat_context_injects_display_name_from_child_meta():
    _fake_chats.chats.clear()
    _fake_chats.chats["chat-src"] = SimpleNamespace(
        meta={"multi_chat": {"started_by_chat_id": "root-1", "display_name": "Reviewer"}}
    )
    result = _force_cross_chat_context(
        SEND_TOOL,
        {"target_chat_id": "t", "message": "m", "source_display_name": "spoofed"},
        _agent_metadata(),
        tool_spec=SEND_SPEC,
    )
    assert result["source_display_name"] == "Reviewer"


def test_force_cross_chat_context_defaults_display_name_to_orchestrator():
    _fake_chats.chats.clear()
    # Root chat with no multi_chat meta.
    _fake_chats.chats["chat-src"] = SimpleNamespace(meta={})
    result = _force_cross_chat_context(
        SEND_TOOL,
        {"target_chat_id": "t", "message": "m"},
        _agent_metadata(),
        tool_spec=SEND_SPEC,
    )
    assert result["source_display_name"] == "Orchestrator"

    # Missing chat row entirely: still Orchestrator, never an error.
    _fake_chats.chats.clear()
    result = _force_cross_chat_context(
        SEND_TOOL,
        {"target_chat_id": "t", "message": "m"},
        _agent_metadata(),
        tool_spec=SEND_SPEC,
    )
    assert result["source_display_name"] == "Orchestrator"


def test_force_cross_chat_context_skips_db_lookup_for_local_chats():
    _fake_chats.chats.clear()
    _fake_chats.lookups.clear()
    metadata = _agent_metadata()
    metadata["chat_id"] = "local:draft"
    result = _force_cross_chat_context(
        SEND_TOOL,
        {"target_chat_id": "t", "message": "m"},
        metadata,
        tool_spec=SEND_SPEC,
    )
    assert result["source_display_name"] == "Orchestrator"
    assert _fake_chats.lookups == []


def test_force_cross_chat_context_injects_model_id_and_respects_declarations():
    _fake_chats.chats.clear()
    result = _force_cross_chat_context(
        SEND_TOOL,
        {"target_chat_id": "t", "message": "m", "source_model_id": "spoofed"},
        _agent_metadata(),
        tool_spec=SEND_SPEC,
    )
    assert result["source_model_id"] == "portico_agent_x"

    # A spec that does not declare the new keys gets them popped, not injected.
    result = _force_cross_chat_context(
        SEND_TOOL,
        {
            "target_chat_id": "t",
            "message": "m",
            "source_display_name": "spoofed",
            "source_model_id": "spoofed",
        },
        _agent_metadata(),
        tool_spec=LEGACY_SEND_SPEC,
    )
    assert "source_display_name" not in result
    assert "source_model_id" not in result


START_SPEC = {
    "parameters": {
        "properties": {
            "prompt": {},
            "model": {},
            "source_chat_id": {},
            "source_model_name": {},
            "source_is_agent": {},
            "source_display_name": {},
            "source_model_id": {},
        }
    }
}


def test_force_cross_chat_context_injects_source_for_start_chat():
    result = _force_cross_chat_context(
        "subagents_start_chat",
        {"prompt": "kick off", "source_chat_id": "spoofed"},
        _agent_metadata(),
        tool_spec=START_SPEC,
    )
    assert result["source_chat_id"] == "chat-src"
    assert result["source_model_name"] == "Research Agent"
    assert result["source_is_agent"] is True
    assert result["prompt"] == "kick off"


def test_force_cross_chat_context_ignores_foreign_start_chat_without_declared_keys():
    foreign_spec = {"parameters": {"properties": {"prompt": {}}}}
    result = _force_cross_chat_context(
        "acme_start_chat",
        {"prompt": "kick off"},
        _agent_metadata(),
        tool_spec=foreign_spec,
    )
    assert "source_chat_id" not in result
    assert "source_model_name" not in result
    assert "source_is_agent" not in result


def test_force_cross_chat_context_leaves_unrelated_tools_untouched():
    params = {"chat_id": "whatever", "source_chat_id": "keep-me"}
    result = _force_cross_chat_context(
        "acme_send_email", dict(params), _agent_metadata(), tool_spec=None
    )
    assert result == params


def test_force_cross_chat_context_spec_guard_limits_injection_to_declared_keys():
    # A third-party tool sharing the name suffix but declaring none of the
    # host-injected properties gets nothing injected.
    foreign_spec = {"parameters": {"properties": {"target_chat_id": {}, "message": {}}}}
    result = _force_cross_chat_context(
        "acme_send_message_to_chat",
        {"target_chat_id": "t", "message": "m"},
        _agent_metadata(),
        tool_spec=foreign_spec,
    )
    assert "source_chat_id" not in result
    assert "source_model_name" not in result
    assert "source_is_agent" not in result


# --- queued-prompts service branch ------------------------------------------


class _HTTPException(Exception):
    def __init__(self, status_code=None, detail=None):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class _RouterStub:
    def post(self, *args, **kwargs):
        return lambda fn: fn


def _load_queued_prompt_route():
    segment = _source_segment(
        CHATS_ROUTER_PATH,
        "def _get_queued_prompt_authorized_chat_and_actor",
        '@router.patch("/{id}/queued-prompts/{item_id}")',
    )
    namespace = {
        "Any": Any,
        "Optional": Optional,
        "SUBAGENT_SERVICE_USER_ID": SERVICE_USER_ID,
        "HTTPException": _HTTPException,
        "status": SimpleNamespace(HTTP_404_NOT_FOUND=404),
        "ERROR_MESSAGES": SimpleNamespace(NOT_FOUND="not found"),
        "router": _RouterStub(),
        "Depends": lambda dependency: None,
        "get_verified_user": lambda: None,
        "Request": object,
        "PendingWorkMessageForm": object,
        "Chats": SimpleNamespace(),
        "Users": SimpleNamespace(),
        "resolve_chat_model_id": lambda chat_payload: None,
        "_chat_payload_dict": lambda chat: getattr(chat, "chat", None) or {},
        "_get_authorized_chat_or_404": None,
        "_get_async_redis_client": lambda request: "redis-client",
        "append_queued_prompt": None,
        "_emit_pending_work_update_for_chat": None,
        "schedule_pending_chat_work_drain": None,
        "sanitize_pending_chat_work_state_for_client": lambda state: state,
        "sio": None,
    }
    exec(segment, namespace)
    return namespace


def _make_form(request_context=None):
    context_form = None
    if request_context is not None:
        context_values = dict(request_context)
        context_form = SimpleNamespace(model_dump=lambda: dict(context_values))
    return SimpleNamespace(
        id=None, prompt="ping", files=[], request_context=context_form, status=None
    )


def _make_chat(chat_id="chat-target", user_id="human-1", model_id="gpt", payload=None):
    return SimpleNamespace(id=chat_id, user_id=user_id, model_id=model_id, chat=payload or {})


def _run_route(namespace, *, form=None, caller=None):
    namespace["append_queued_prompt"] = AsyncMock(return_value={"queued_prompts": []})
    namespace["_emit_pending_work_update_for_chat"] = AsyncMock()
    namespace["schedule_pending_chat_work_drain"] = Mock()
    route = namespace["post_chat_queued_prompt"]
    return asyncio.run(
        route(
            "chat-target",
            form or _make_form(),
            SimpleNamespace(),
            user=caller or SimpleNamespace(id=SERVICE_USER_ID),
        )
    )


def test_service_caller_delivers_into_human_chat_and_drains_as_owner():
    namespace = _load_queued_prompt_route()
    chat = _make_chat()
    owner = SimpleNamespace(id="human-1")
    namespace["Chats"] = SimpleNamespace(get_chat_by_id=lambda chat_id: chat)
    namespace["Users"] = SimpleNamespace(get_user_by_id=lambda user_id: owner)

    _run_route(namespace)

    append_call = namespace["append_queued_prompt"].call_args
    assert append_call.kwargs["request_context"] == {"selected_model_ids": ["gpt"]}
    drain_call = namespace["schedule_pending_chat_work_drain"].call_args
    assert drain_call.kwargs["user"] is owner
    assert drain_call.kwargs["chat_id"] == "chat-target"


def test_service_caller_does_not_override_provided_model_ids():
    namespace = _load_queued_prompt_route()
    namespace["Chats"] = SimpleNamespace(get_chat_by_id=lambda chat_id: _make_chat())
    namespace["Users"] = SimpleNamespace(
        get_user_by_id=lambda user_id: SimpleNamespace(id=user_id)
    )

    _run_route(namespace, form=_make_form({"selected_model_ids": ["explicit-model"]}))

    append_call = namespace["append_queued_prompt"].call_args
    assert append_call.kwargs["request_context"]["selected_model_ids"] == [
        "explicit-model"
    ]


def test_service_caller_falls_back_to_resolved_chat_model_id():
    namespace = _load_queued_prompt_route()
    chat = _make_chat(model_id=None, payload={"models": ["payload-model"]})
    namespace["Chats"] = SimpleNamespace(get_chat_by_id=lambda chat_id: chat)
    namespace["Users"] = SimpleNamespace(
        get_user_by_id=lambda user_id: SimpleNamespace(id=user_id)
    )
    namespace["resolve_chat_model_id"] = lambda chat_payload: (chat_payload.get("models") or [None])[0]

    _run_route(namespace)

    append_call = namespace["append_queued_prompt"].call_args
    assert append_call.kwargs["request_context"] == {
        "selected_model_ids": ["payload-model"]
    }


def test_service_caller_missing_chat_maps_to_404():
    namespace = _load_queued_prompt_route()
    namespace["Chats"] = SimpleNamespace(get_chat_by_id=lambda chat_id: None)

    try:
        _run_route(namespace)
    except _HTTPException as error:
        assert error.status_code == 404
    else:
        raise AssertionError("expected HTTPException 404 for missing chat")


def test_service_caller_owning_the_chat_drains_as_itself():
    namespace = _load_queued_prompt_route()
    chat = _make_chat(user_id=SERVICE_USER_ID, model_id="child-model")
    namespace["Chats"] = SimpleNamespace(get_chat_by_id=lambda chat_id: chat)

    caller = SimpleNamespace(id=SERVICE_USER_ID)
    _run_route(namespace, caller=caller)

    drain_call = namespace["schedule_pending_chat_work_drain"].call_args
    assert drain_call.kwargs["user"] is caller
    append_call = namespace["append_queued_prompt"].call_args
    assert append_call.kwargs["request_context"] == {
        "selected_model_ids": ["child-model"]
    }


def test_human_caller_path_uses_owner_check_and_no_model_defaulting():
    namespace = _load_queued_prompt_route()
    chat = _make_chat(user_id="human-1")
    authorized = Mock(return_value=chat)
    namespace["_get_authorized_chat_or_404"] = authorized
    namespace["Chats"] = SimpleNamespace(
        get_chat_by_id=Mock(side_effect=AssertionError("service lookup must not run"))
    )

    caller = SimpleNamespace(id="human-1")
    _run_route(namespace, caller=caller)

    authorized.assert_called_once_with("chat-target", caller)
    append_call = namespace["append_queued_prompt"].call_args
    assert append_call.kwargs["request_context"] == {}
    drain_call = namespace["schedule_pending_chat_work_drain"].call_args
    assert drain_call.kwargs["user"] is caller


# ── get_chat_status route (subagents_get_chat_status backing) ────────────────


def _load_chat_status_route():
    segment = _source_segment(
        CHATS_ROUTER_PATH,
        "def _get_status_authorized_chat",
        '@router.put("/{id}/pending-steer")',
    )
    namespace = {
        "Any": Any,
        "SUBAGENT_SERVICE_USER_ID": SERVICE_USER_ID,
        "HTTPException": _HTTPException,
        "status": SimpleNamespace(HTTP_404_NOT_FOUND=404),
        "ERROR_MESSAGES": SimpleNamespace(NOT_FOUND="not found"),
        "router": SimpleNamespace(get=lambda *args, **kwargs: (lambda fn: fn)),
        "Depends": lambda dependency: None,
        "get_verified_user": lambda: None,
        "Request": object,
        "Chats": SimpleNamespace(),
        "_get_authorized_chat_or_404": None,
        "_get_async_redis_client": lambda request: "redis-client",
        "list_task_ids_by_item_id": AsyncMock(return_value=[]),
        "chat_payload_has_active_current_turn": lambda payload: False,
        "_chat_payload_dict": lambda chat: getattr(chat, "chat", None) or {},
        "load_pending_chat_work_state": AsyncMock(
            return_value={
                "chat_id": "chat-target",
                "version": 1,
                "updated_at": 111.0,
                "pending_steer": None,
                "queued_prompts": [],
            }
        ),
        "sanitize_pending_chat_work_state_for_client": lambda state: state,
        "resolve_chat_model_id": lambda chat_payload: None,
        "log": SimpleNamespace(warning=lambda *args: None),
    }
    exec(segment, namespace)
    return namespace


def _make_status_chat(**kwargs):
    chat = _make_chat(**kwargs)
    chat.title = "Reviewer"
    chat.updated_at = 1754_000_000
    return chat


def _run_status_route(namespace, *, caller=None, chat_id="chat-target"):
    route = namespace["get_chat_status"]
    return asyncio.run(
        route(
            chat_id,
            SimpleNamespace(),
            user=caller or SimpleNamespace(id=SERVICE_USER_ID),
        )
    )


def test_status_busy_when_a_completion_task_is_registered():
    namespace = _load_chat_status_route()
    namespace["Chats"] = SimpleNamespace(
        get_chat_by_id=lambda chat_id: _make_status_chat(payload={"history": {}})
    )
    namespace["list_task_ids_by_item_id"] = AsyncMock(return_value=["task-1"])

    result = _run_status_route(namespace)

    assert result["busy"] is True
    assert result["task_count"] == 1
    assert result["active_turn"] is False
    assert result["model_id"] == "gpt"
    assert result["queued_prompt_count"] == 0
    assert result["has_pending_steer"] is False


def test_status_busy_when_only_the_persisted_turn_is_active():
    # Covers the drain's fallback: task record gone (or not yet written) but
    # the persisted current turn has not reached a terminal state.
    namespace = _load_chat_status_route()
    namespace["Chats"] = SimpleNamespace(
        get_chat_by_id=lambda chat_id: _make_status_chat(payload={"marker": "active"})
    )
    namespace["chat_payload_has_active_current_turn"] = (
        lambda payload: payload.get("marker") == "active"
    )

    result = _run_status_route(namespace)

    assert result["busy"] is True
    assert result["task_count"] == 0
    assert result["active_turn"] is True


def test_status_idle_reports_counts_and_resolved_model():
    namespace = _load_chat_status_route()
    chat = _make_status_chat(model_id=None, payload={"models": ["payload-model"]})
    namespace["Chats"] = SimpleNamespace(get_chat_by_id=lambda chat_id: chat)
    namespace["resolve_chat_model_id"] = (
        lambda chat_payload: (chat_payload.get("models") or [None])[0]
    )
    namespace["load_pending_chat_work_state"] = AsyncMock(
        return_value={
            "chat_id": "chat-target",
            "version": 3,
            "updated_at": 222.0,
            "pending_steer": {"prompt": "steer"},
            "queued_prompts": [{"prompt": "a"}, {"prompt": "b"}],
        }
    )

    result = _run_status_route(namespace)

    assert result["busy"] is False
    assert result["model_id"] == "payload-model"
    assert result["queued_prompt_count"] == 2
    assert result["has_pending_steer"] is True
    assert result["pending_work_updated_at"] == 222.0


def test_status_missing_chat_maps_to_404_for_service_caller():
    namespace = _load_chat_status_route()
    namespace["Chats"] = SimpleNamespace(get_chat_by_id=lambda chat_id: None)

    try:
        _run_status_route(namespace)
    except _HTTPException as error:
        assert error.status_code == 404
    else:
        raise AssertionError("expected HTTPException 404 for missing chat")


def test_status_human_caller_stays_owner_scoped():
    namespace = _load_chat_status_route()
    chat = _make_status_chat(user_id="human-1")
    authorized = Mock(return_value=chat)
    namespace["_get_authorized_chat_or_404"] = authorized
    namespace["Chats"] = SimpleNamespace(
        get_chat_by_id=Mock(side_effect=AssertionError("service lookup must not run"))
    )

    caller = SimpleNamespace(id="human-1")
    result = _run_status_route(namespace, caller=caller)

    authorized.assert_called_once_with("chat-target", caller)
    assert result["busy"] is False
