import asyncio
import importlib.util
import json
import sys
import types
from pathlib import Path

import pytest
from fastapi import HTTPException
from pydantic import ValidationError


ROOT = Path(__file__).resolve().parents[1]
ROUTER_PATH = (
    ROOT
    / "src"
    / "patches"
    / "backend"
    / "open_webui"
    / "routers"
    / "scheduled_tasks.py"
)


def load_router_module(monkeypatch):
    open_webui_module = types.ModuleType("open_webui")
    open_webui_module.__path__ = []
    utils_module = types.ModuleType("open_webui.utils")
    utils_module.__path__ = []
    auth_module = types.ModuleType("open_webui.utils.auth")
    auth_module.get_verified_user = lambda: object()

    monkeypatch.setitem(sys.modules, "open_webui", open_webui_module)
    monkeypatch.setitem(sys.modules, "open_webui.utils", utils_module)
    monkeypatch.setitem(sys.modules, "open_webui.utils.auth", auth_module)

    spec = importlib.util.spec_from_file_location(
        "scheduled_tasks_router_under_test", ROUTER_PATH
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_unwrap_tool_response_parses_scheduling_content(monkeypatch):
    module = load_router_module(monkeypatch)
    payload = {
        "content": [
            {
                "type": "text",
                "text": json.dumps({"tasks": [{"id": "scheduled-task-1"}], "count": 1}),
            }
        ]
    }

    assert module._unwrap_tool_response(payload) == {
        "tasks": [{"id": "scheduled-task-1"}],
        "count": 1,
    }


def test_unwrap_tool_response_turns_mcp_errors_into_http_errors(monkeypatch):
    module = load_router_module(monkeypatch)

    with pytest.raises(HTTPException) as exc_info:
        module._unwrap_tool_response(
            {"is_error": True, "error": {"message": "scheduler unavailable"}}
        )

    assert exc_info.value.status_code == 502
    assert exc_info.value.detail == "scheduler unavailable"


def test_scheduling_tool_url_uses_core_proxy_base(monkeypatch):
    module = load_router_module(monkeypatch)
    monkeypatch.setenv("CORE_MCP_PROXY_BASE_URL", "http://mcpo-core:8081/")
    monkeypatch.delenv("SCHEDULED_TASKS_MCP_BASE_URL", raising=False)

    assert (
        module._scheduling_tool_url("list_tasks")
        == "http://mcpo-core:8081/scheduling/scheduling_list_tasks"
    )


def test_create_route_proxies_exact_task_shape(monkeypatch):
    module = load_router_module(monkeypatch)
    calls = []

    async def fake_call(tool_name, payload, **kwargs):
        calls.append((tool_name, payload, kwargs))
        return {"id": "scheduled-task-1", **payload}

    monkeypatch.setattr(module, "_call_scheduling_tool", fake_call)

    form = module.ScheduledTaskCreateForm(
        name="Weekly wins summary",
        prompt="Summarize wins",
        model_id="Claude Sonnet 4.6",
        schedule=module.TaskScheduleForm(
            kind="cron", cron_expression="0 9 * * MON-FRI", timezone="America/New_York"
        ),
        skill_ids=["company-knowledge"],
        tool_server_ids=["server:web-tools"],
        enabled=True,
    )

    result = asyncio.run(module.create_scheduled_task(form, user=object()))

    assert result["id"] == "scheduled-task-1"
    assert calls == [
        (
            "create_task",
            {
                "name": "Weekly wins summary",
                "prompt": "Summarize wins",
                "model_id": "Claude Sonnet 4.6",
                "schedule": {
                    "kind": "cron",
                    "cron_expression": "0 9 * * MON-FRI",
                    "timezone": "America/New_York",
                },
                "skill_ids": ["company-knowledge"],
                "tool_server_ids": ["server:web-tools"],
                "enabled": True,
            },
            {},
        )
    ]


def test_create_and_update_forms_normalize_and_bound_generated_name(monkeypatch):
    module = load_router_module(monkeypatch)
    form = module.ScheduledTaskCreateForm(
        name="  Weekly\n wins   summary  ",
        prompt="Summarize wins",
        model_id="Claude Sonnet 4.6",
        schedule=module.TaskScheduleForm(
            kind="once", run_at="2030-01-01T12:00:00Z", timezone="UTC"
        ),
    )
    assert form.name == "Weekly wins summary"

    long_form = module.ScheduledTaskCreateForm(
        name="x" * 100,
        prompt="Summarize wins",
        model_id="Claude Sonnet 4.6",
        schedule=module.TaskScheduleForm(
            kind="once", run_at="2030-01-01T12:00:00Z", timezone="UTC"
        ),
    )
    assert long_form.name == "x" * 80

    update_form = module.ScheduledTaskUpdateForm(name="  Updated\n task   name  ")
    assert update_form.name == "Updated task name"

    with pytest.raises(ValidationError):
        module.ScheduledTaskCreateForm(
            name="  \n ",
            prompt="Summarize wins",
            model_id="Claude Sonnet 4.6",
            schedule=module.TaskScheduleForm(
                kind="once", run_at="2030-01-01T12:00:00Z", timezone="UTC"
            ),
        )


def test_capabilities_route_adapts_existing_catalog_tools(monkeypatch):
    module = load_router_module(monkeypatch)
    calls = []

    async def fake_call(server_id, tool_name, payload, **kwargs):
        calls.append((server_id, tool_name, payload, kwargs))
        if server_id == module.MCP_ASSISTANT_SERVER_ID:
            return {
                "servers": [
                    {
                        "id": "glean",
                        "display_name": "Glean",
                        "description": "Company search",
                        "is_core": False,
                        "user_installed": True,
                        "deployment_type": "host",
                    },
                    {
                        "id": "server:web-tools",
                        "name": "Web Tools",
                        "description": "Search the web",
                        "is_core": True,
                    },
                ]
            }
        return {
            "skills": [
                {
                    "name": "company-knowledge",
                    "description": "Use company docs",
                    "source": "system",
                }
            ]
        }

    monkeypatch.setattr(module, "_call_core_tool", fake_call)

    result = asyncio.run(module.list_scheduled_task_capabilities(user=object()))

    assert result == {
        "skills": [
            {
                "id": "company-knowledge",
                "display_name": "Company Knowledge",
                "description": "Use company docs",
                "source": "system",
            }
        ],
        "tool_servers": [
            {
                "id": "server:glean",
                "display_name": "Glean",
                "description": "Company search",
                "icon_url": "/api/v1/chats/mcp/servers/glean/icon",
                "is_core": False,
                "user_installed": True,
                "deployment_type": "host",
            },
            {
                "id": "server:web-tools",
                "display_name": "Web Tools",
                "description": "Search the web",
                "icon_url": "/api/v1/chats/mcp/servers/web-tools/icon",
                "is_core": True,
                "user_installed": False,
                "deployment_type": "docker",
            },
        ],
    }
    assert calls == [
        (
            module.MCP_ASSISTANT_SERVER_ID,
            "list_mcp_servers",
            {"include_disabled": True},
            {},
        ),
        (
            module.SKILLS_SERVER_ID,
            "list_skills",
            {"include_content": False, "filter_source": "all"},
            {},
        ),
    ]


def test_capabilities_route_returns_empty_catalogs_when_discovery_fails(monkeypatch):
    module = load_router_module(monkeypatch)

    async def fake_call(*args, **kwargs):
        raise HTTPException(status_code=503, detail="catalog unavailable")

    monkeypatch.setattr(module, "_call_core_tool", fake_call)

    result = asyncio.run(module.list_scheduled_task_capabilities(user=object()))

    assert result == {"skills": [], "tool_servers": []}


def test_update_route_injects_task_id(monkeypatch):
    module = load_router_module(monkeypatch)
    calls = []

    async def fake_call(tool_name, payload, **kwargs):
        calls.append((tool_name, payload, kwargs))
        return payload

    monkeypatch.setattr(module, "_call_scheduling_tool", fake_call)

    form = module.ScheduledTaskUpdateForm(name="  Updated task  ", enabled=False)
    result = asyncio.run(
        module.update_scheduled_task("scheduled-task-1", form, user=object())
    )

    assert result == {
        "task_id": "scheduled-task-1",
        "name": "Updated task",
        "enabled": False,
    }
    assert calls == [
        (
            "update_task",
            {"task_id": "scheduled-task-1", "name": "Updated task", "enabled": False},
            {},
        )
    ]
