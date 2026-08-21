import json
import logging
import os
from typing import Any, Optional

import aiohttp
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator

from open_webui.utils.auth import get_verified_user


log = logging.getLogger(__name__)
router = APIRouter()

SCHEDULING_SERVER_ID = "scheduling"
MCP_ASSISTANT_SERVER_ID = "mcp-assistant"
SKILLS_SERVER_ID = "skills"
SUBAGENTS_SERVER_ID = "subagents"
# Scheduled tasks are local to the single-user DMG installation. The Rust
# scheduling server owns the on-disk task store, so this proxy authenticates the
# caller but intentionally does not add a separate per-user ownership layer.
GENERAL_TOOL_TIMEOUT_SECONDS = float(
    os.getenv("SCHEDULED_TASKS_MCP_TIMEOUT_SECONDS", "30")
)
RUN_NOW_TIMEOUT_SECONDS = float(
    os.getenv("SCHEDULED_TASKS_RUN_NOW_TIMEOUT_SECONDS", "1800")
)


class TaskScheduleForm(BaseModel):
    kind: str
    cron_expression: Optional[str] = None
    run_at: Optional[str] = None
    timezone: str


class ScheduledTaskCreateForm(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    prompt: str
    model_id: str
    schedule: TaskScheduleForm
    skill_ids: list[str] = Field(default_factory=list)
    tool_server_ids: list[str] = Field(default_factory=list)
    enabled: bool = True

    @field_validator("name", mode="before")
    @classmethod
    def normalize_name(cls, value: Any) -> Any:
        if not isinstance(value, str):
            return value
        return " ".join(value.split())[:80]


class ScheduledTaskUpdateForm(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=80)
    prompt: Optional[str] = None
    model_id: Optional[str] = None
    schedule: Optional[TaskScheduleForm] = None
    skill_ids: Optional[list[str]] = None
    tool_server_ids: Optional[list[str]] = None
    enabled: Optional[bool] = None

    @field_validator("name", mode="before")
    @classmethod
    def normalize_name(cls, value: Any) -> Any:
        if not isinstance(value, str):
            return value
        return " ".join(value.split())[:80]


def _model_dump(value: BaseModel) -> dict[str, Any]:
    if hasattr(value, "model_dump"):
        return value.model_dump(exclude_none=True)
    return value.dict(exclude_none=True)


def _scheduling_proxy_base_url() -> str:
    return os.getenv(
        "SCHEDULED_TASKS_MCP_BASE_URL",
        os.getenv("CORE_MCP_PROXY_BASE_URL", "http://mcpo-core:8081"),
    ).rstrip("/")


def _scheduling_tool_url(tool_name: str) -> str:
    return (
        f"{_scheduling_proxy_base_url()}/{SCHEDULING_SERVER_ID}/"
        f"{SCHEDULING_SERVER_ID}_{tool_name}"
    )


def _core_tool_url(server_id: str, tool_name: str) -> str:
    tool_prefix = server_id.replace("-", "_")
    return f"{_scheduling_proxy_base_url()}/{server_id}/{tool_prefix}_{tool_name}"


def _unwrap_tool_response(payload: Any) -> Any:
    if not isinstance(payload, dict):
        return payload

    if payload.get("is_error"):
        error = payload.get("error")
        if isinstance(error, dict):
            message = error.get("message") or error.get("detail") or str(error)
        else:
            message = payload.get("message") or payload.get("detail") or str(payload)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=message)

    content = payload.get("content")
    if (
        isinstance(content, list)
        and content
        and isinstance(content[0], dict)
        and isinstance(content[0].get("text"), str)
    ):
        try:
            return json.loads(content[0]["text"])
        except json.JSONDecodeError:
            return {"text": content[0]["text"]}

    return payload


async def _call_scheduling_tool(
    tool_name: str,
    payload: dict[str, Any],
    *,
    timeout_seconds: float = GENERAL_TOOL_TIMEOUT_SECONDS,
) -> Any:
    url = _scheduling_tool_url(tool_name)
    timeout = aiohttp.ClientTimeout(total=timeout_seconds)

    try:
        async with aiohttp.ClientSession(timeout=timeout, trust_env=True) as session:
            async with session.post(url, json=payload) as response:
                raw_text = await response.text()
                try:
                    response_payload = json.loads(raw_text) if raw_text else {}
                except json.JSONDecodeError:
                    response_payload = {"detail": raw_text or response.reason}

                if response.status >= 400:
                    detail = response_payload.get("detail", response_payload)
                    raise HTTPException(status_code=response.status, detail=detail)

                return _unwrap_tool_response(response_payload)
    except HTTPException:
        raise
    except Exception as error:
        log.warning(
            "[ScheduledTasks] Failed to call scheduling tool %s via %s: %s",
            tool_name,
            url,
            error,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Scheduled tasks are unavailable. Please try again.",
        ) from error


async def _call_core_tool(
    server_id: str,
    tool_name: str,
    payload: dict[str, Any],
    *,
    timeout_seconds: float = GENERAL_TOOL_TIMEOUT_SECONDS,
) -> Any:
    url = _core_tool_url(server_id, tool_name)
    timeout = aiohttp.ClientTimeout(total=timeout_seconds)

    try:
        async with aiohttp.ClientSession(timeout=timeout, trust_env=True) as session:
            async with session.post(url, json=payload) as response:
                raw_text = await response.text()
                try:
                    response_payload = json.loads(raw_text) if raw_text else {}
                except json.JSONDecodeError:
                    response_payload = {"detail": raw_text or response.reason}

                if response.status >= 400:
                    detail = response_payload.get("detail", response_payload)
                    raise HTTPException(status_code=response.status, detail=detail)

                return _unwrap_tool_response(response_payload)
    except HTTPException:
        raise
    except Exception as error:
        log.warning(
            "[ScheduledTasks] Failed to call core tool %s/%s via %s: %s",
            server_id,
            tool_name,
            url,
            error,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Scheduled task capabilities are unavailable.",
        ) from error


async def _catalog_or_empty(
    server_id: str,
    tool_name: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    try:
        result = await _call_core_tool(server_id, tool_name, payload)
        return result if isinstance(result, dict) else {}
    except HTTPException as error:
        log.warning(
            "[ScheduledTasks] Capability discovery failed for %s/%s: %s",
            server_id,
            tool_name,
            error.detail,
        )
        return {}


def _canonical_tool_server_id(server_id: str) -> str:
    normalized = str(server_id or "").strip()
    if not normalized:
        return ""
    return normalized if normalized.startswith("server:") else f"server:{normalized}"


def _server_icon_url(canonical_id: str) -> str:
    server_id = canonical_id.replace("server:", "", 1)
    return f"/api/v1/chats/mcp/servers/{server_id}/icon"


def _display_name_from_id(identifier: str) -> str:
    return " ".join(
        word.capitalize()
        for word in identifier.replace("server:", "").replace("_", "-").split("-")
        if word
    )


@router.get("")
@router.get("/")
async def list_scheduled_tasks(
    include_disabled: bool = True,
    user=Depends(get_verified_user),
):
    return await _call_scheduling_tool(
        "list_tasks",
        {"include_disabled": include_disabled},
    )


@router.get("/capabilities")
async def list_scheduled_task_capabilities(user=Depends(get_verified_user)):
    servers_catalog = await _catalog_or_empty(
        MCP_ASSISTANT_SERVER_ID,
        "list_mcp_servers",
        {"include_disabled": True},
    )
    skills_catalog = await _catalog_or_empty(
        SKILLS_SERVER_ID,
        "list_skills",
        {"include_content": False, "filter_source": "all"},
    )

    tool_servers = []
    for server in servers_catalog.get("servers", []):
        if not isinstance(server, dict):
            continue
        canonical_id = _canonical_tool_server_id(server.get("id", ""))
        if not canonical_id:
            continue
        raw_display_name = server.get("display_name") or server.get("name")
        display_name = (
            raw_display_name.strip()
            if isinstance(raw_display_name, str) and raw_display_name.strip()
            else _display_name_from_id(canonical_id)
        )
        tool_servers.append(
            {
                "id": canonical_id,
                "display_name": display_name,
                "description": server.get("description") or "",
                "icon_url": _server_icon_url(canonical_id),
                "is_core": bool(server.get("is_core")),
                "user_installed": bool(server.get("user_installed")),
                # Needed for the "Host" source badge in the picker (host runs on
                # the user's machine). Raw record has it; we were dropping it.
                "deployment_type": server.get("deployment_type") or "docker",
            }
        )

    skills = []
    for skill in skills_catalog.get("skills", []):
        if not isinstance(skill, dict):
            continue
        skill_id = str(skill.get("name") or skill.get("id") or "").strip()
        if not skill_id:
            continue
        # Prefer the skill's real frontmatter display_name (as the agents-side
        # picker does) so both pickers show identical names + initials; fall back
        # to the id-derived name only when frontmatter has none. The frontend
        # applies acronym casing (MCP/API/…) to whichever we send.
        raw_skill_name = skill.get("display_name")
        skill_display_name = (
            raw_skill_name.strip()
            if isinstance(raw_skill_name, str) and raw_skill_name.strip()
            else _display_name_from_id(skill_id)
        )
        skills.append(
            {
                "id": skill_id,
                "display_name": skill_display_name,
                "description": skill.get("description") or "",
                "source": skill.get("source") or "",
            }
        )

    return {
        "skills": skills,
        "tool_servers": tool_servers,
    }


@router.get("/agent-capabilities/{agent_id}")
async def get_agent_capabilities(agent_id: str, user=Depends(get_verified_user)):
    """Return an agent's configured skill_ids + tool_server_ids so the task form
    can pre-populate (and "Reload from Agent" can merge) when an agent is chosen.
    Reads from the subagents core MCP server (the source of truth for agent
    config)."""
    normalized = str(agent_id or "").strip()
    if not normalized:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="agent_id is required")
    # Call the tool directly (not _catalog_or_empty) so a subagents outage / bad
    # id propagates as an error instead of silently returning empty caps — that
    # would make the frontend show a false "reloaded" success and let prepopulate
    # overwrite the user's selection with nothing.
    config = await _call_core_tool(
        SUBAGENTS_SERVER_ID,
        "get_agent",
        {"model_id": normalized},
    )
    if isinstance(config, dict) and isinstance(config.get("agent"), dict):
        agent = config["agent"]
    elif isinstance(config, dict):
        agent = config
    else:
        agent = {}

    def _id_list(value):
        if not isinstance(value, list):
            return []
        seen = []
        for item in value:
            text = str(item or "").strip()
            if text and text not in seen:
                seen.append(text)
        return seen

    return {
        "skill_ids": _id_list(agent.get("skill_ids")),
        "tool_server_ids": _id_list(agent.get("tool_server_ids")),
    }


@router.post("")
@router.post("/")
async def create_scheduled_task(
    form_data: ScheduledTaskCreateForm,
    user=Depends(get_verified_user),
):
    return await _call_scheduling_tool("create_task", _model_dump(form_data))


@router.get("/{task_id}")
async def get_scheduled_task(task_id: str, user=Depends(get_verified_user)):
    return await _call_scheduling_tool("get_task", {"task_id": task_id})


@router.patch("/{task_id}")
async def update_scheduled_task(
    task_id: str,
    form_data: ScheduledTaskUpdateForm,
    user=Depends(get_verified_user),
):
    payload = {"task_id": task_id, **_model_dump(form_data)}
    return await _call_scheduling_tool("update_task", payload)


@router.delete("/{task_id}")
async def delete_scheduled_task(task_id: str, user=Depends(get_verified_user)):
    return await _call_scheduling_tool("delete_task", {"task_id": task_id})


@router.post("/{task_id}/run")
async def run_scheduled_task_now(
    task_id: str,
    user=Depends(get_verified_user),
):
    return await _call_scheduling_tool(
        "run_task_now",
        {"task_id": task_id},
        timeout_seconds=RUN_NOW_TIMEOUT_SECONDS,
    )
