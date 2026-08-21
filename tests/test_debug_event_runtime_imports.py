import ast
import asyncio
import sys
import types
from pathlib import Path
from typing import Optional


ROOT = Path(__file__).resolve().parents[1]
OPENAI_PATH = (
    ROOT / "src" / "patches" / "backend" / "open_webui" / "routers" / "openai.py"
)
MIDDLEWARE_PATH = (
    ROOT
    / "src"
    / "patches"
    / "backend"
    / "open_webui"
    / "utils"
    / "middleware.py"
)


def _load_openai_debug_helpers():
    source = OPENAI_PATH.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(OPENAI_PATH))
    wanted_names = {
        "_ensure_llm_debug_event_publisher_available",
        "publish_request_start",
        "publish_request_payload",
        "should_publish_bifrost_debug_request_payload",
    }
    selected_nodes = [
        node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name in wanted_names
    ]
    namespace = {
        "Optional": Optional,
        "sys": sys,
        "LLM_DEBUG_MONITOR_GATEWAY_EVENTS_ENABLED": True,
        "LLM_DEBUG_EVENT_PUBLISHER_AVAILABLE": False,
        "_publish_request_start_impl": None,
        "_publish_request_payload_impl": None,
        "is_auxiliary_task_name": lambda task_name: task_name == "title_generation",
    }
    exec(
        compile(
            ast.Module(body=selected_nodes, type_ignores=[]),
            str(OPENAI_PATH),
            "exec",
        ),
        namespace,
    )
    return namespace


def _load_middleware_debug_helpers():
    source = MIDDLEWARE_PATH.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(MIDDLEWARE_PATH))
    wanted_names = {
        "_ensure_llm_debug_event_publisher_available",
        "publish_error",
        "publish_response_complete",
        "_should_publish_bifrost_debug_response",
    }
    selected_nodes = [
        node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name in wanted_names
    ]
    namespace = {
        "Optional": Optional,
        "LLM_DEBUG_MONITOR_GATEWAY_EVENTS_ENABLED": True,
        "LLM_DEBUG_EVENT_PUBLISHER_AVAILABLE": False,
        "_publish_error_impl": None,
        "_publish_response_complete_impl": None,
    }
    exec(
        compile(
            ast.Module(body=selected_nodes, type_ignores=[]),
            str(MIDDLEWARE_PATH),
            "exec",
        ),
        namespace,
    )
    return namespace


def test_openai_debug_wrappers_recover_event_publisher_after_import_failure(monkeypatch):
    helpers = _load_openai_debug_helpers()
    captured = {}

    fake_module = types.ModuleType("event_publisher")

    async def fake_publish_request_start(**kwargs):
        captured["start"] = kwargs
        return True

    async def fake_publish_request_payload(**kwargs):
        captured["payload"] = kwargs
        return True

    fake_module.publish_request_start = fake_publish_request_start
    fake_module.publish_request_payload = fake_publish_request_payload
    monkeypatch.setitem(sys.modules, "event_publisher", fake_module)

    assert (
        helpers["should_publish_bifrost_debug_request_payload"](
            {"chat_id": "chat-1", "session_id": "session-1"},
            {"stream": True},
        )
        is True
    )

    result = asyncio.run(
        helpers["publish_request_start"](
            session_id="session-1",
            chat_id="chat-1",
            model="Cluck",
            message_count=1,
        )
    )

    assert result is True
    assert helpers["LLM_DEBUG_EVENT_PUBLISHER_AVAILABLE"] is True
    assert captured["start"]["model"] == "Cluck"

    result = asyncio.run(
        helpers["publish_request_payload"](
            session_id="session-1",
            chat_id="chat-1",
            model="Cluck",
            messages=[],
            raw_payload={"stream": True},
        )
    )

    assert result is True
    assert captured["payload"]["model"] == "Cluck"


def test_openai_request_payload_publish_gate_allows_non_stream_main_requests():
    helpers = _load_openai_debug_helpers()
    helpers["_publish_request_start_impl"] = object()
    helpers["_publish_request_payload_impl"] = object()

    assert (
        helpers["should_publish_bifrost_debug_request_payload"](
            {"chat_id": "chat-1", "session_id": "session-1", "task": None},
            {"stream": False},
        )
        is True
    )
    assert (
        helpers["should_publish_bifrost_debug_request_payload"](
            {"chat_id": "chat-1", "session_id": "session-1", "task": "title_generation"},
            {"stream": False},
        )
        is True
    )
    assert (
        helpers["should_publish_bifrost_debug_request_payload"](
            {"chat_id": "chat-1"},
            {"stream": False},
        )
        is False
    )


def test_middleware_debug_wrappers_recover_event_publisher_after_import_failure(
    monkeypatch,
):
    helpers = _load_middleware_debug_helpers()
    captured = {}

    fake_module = types.ModuleType("event_publisher")

    async def fake_publish_error(**kwargs):
        captured["error"] = kwargs
        return True

    async def fake_publish_response_complete(**kwargs):
        captured["response"] = kwargs
        return True

    fake_module.publish_error = fake_publish_error
    fake_module.publish_response_complete = fake_publish_response_complete
    monkeypatch.setitem(sys.modules, "event_publisher", fake_module)

    assert (
        helpers["_should_publish_bifrost_debug_response"](
            {"chat_id": "chat-1", "session_id": "session-1"}
        )
        is True
    )

    response_result = asyncio.run(
        helpers["publish_response_complete"](
            session_id="session-1",
            chat_id="chat-1",
            model="Cluck",
            usage={},
            finish_reason="stop",
        )
    )
    error_result = asyncio.run(
        helpers["publish_error"](
            session_id="session-1",
            chat_id="chat-1",
            error="boom",
        )
    )

    assert response_result is True
    assert error_result is True
    assert helpers["LLM_DEBUG_EVENT_PUBLISHER_AVAILABLE"] is True
    assert captured["response"]["model"] == "Cluck"
    assert captured["error"]["error"] == "boom"
