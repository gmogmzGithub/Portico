import copy
import json
import logging
import os
import time
import uuid
from typing import Any, Optional
import re

import aiohttp

# PORTICO PATCH: Redis import for active capabilities
try:
    import redis
    REDIS_AVAILABLE = True
except ImportError:
    REDIS_AVAILABLE = False

try:
    import yaml
    YAML_AVAILABLE = True
except ImportError:
    YAML_AVAILABLE = False

from open_webui.utils.misc import get_message_list
from open_webui.socket.main import sio
from open_webui.utils.delegated_events import get_event_emitter
from open_webui.models.chats import (
    Chat,
    ChatForm,
    ChatImportForm,
    ChatUsageStatsListResponse,
    ChatsImportForm,
    ChatResponse,
    Chats,
    ChatTitleIdResponse,
)
from open_webui.models.tags import TagModel, Tags
from open_webui.models.folders import Folders
from open_webui.models.users import Users
from open_webui.utils.chat_model_id import resolve_chat_model_id

from open_webui.config import ENABLE_ADMIN_CHAT_ACCESS, ENABLE_ADMIN_EXPORT
from open_webui.constants import ERROR_MESSAGES
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from pathlib import Path


from open_webui.internal.db import engine, get_db
from sqlalchemy import text as sql_text
from open_webui.utils.auth import get_admin_user, get_verified_user
from open_webui.utils.access_control import has_permission
from open_webui.utils.chat_search import (
    sync_chat_to_search,
    delete_chat_from_search,
)
from open_webui.utils.rate_limit_retry import (
    build_rate_limit_cancel_key,
    request_rate_limit_cancel,
)
from open_webui.tasks import list_task_ids_by_item_id
from open_webui.utils.pending_chat_work import (
    append_queued_prompt,
    chat_payload_has_active_current_turn,
    delete_pending_steer,
    delete_queued_prompt,
    emit_multi_chat_pane_added,
    emit_pending_chat_work_updated,
    load_pending_chat_work_state,
    replace_pending_steer,
    sanitize_pending_chat_work_state_for_client,
    schedule_pending_chat_work_drain,
    update_pending_steer,
    update_queued_prompt,
)

log = logging.getLogger(__name__)

router = APIRouter()


class SidebarChatTitleIdResponse(ChatTitleIdResponse):
    model_id: Optional[str] = None


def _sidebar_chat_rows(chats, _user_id: str) -> list[SidebarChatTitleIdResponse]:
    """Return lightweight sidebar rows without reading full chat histories."""
    chat_list = list(chats)

    rows = []
    for chat in chat_list:
        data = chat.model_dump() if hasattr(chat, "model_dump") else dict(chat)
        model_id = data.pop("model_id", None)
        rows.append(SidebarChatTitleIdResponse(**data, model_id=model_id))
    return rows

# PORTICO PATCH: MCP server icon paths
# Icons are stored in mcp-configs/{server_id}/{server_id}.png
# User-installed servers store icons in mcp-configs-user/{server_id}/{server_id}.png
MCP_CONFIGS_DIR = Path("/app/mcp-configs")
MCP_CONFIGS_USER_DIR = Path("/app/mcp-configs-user")
# In dev mode, source is at /app/source; in production, it's at /app/backend
DEFAULT_ICON_PATH = Path("/app/source/backend/open_webui/static/logo.png")
DEFAULT_ICON_PATH_PROD = Path("/app/backend/open_webui/static/logo.png")
SUBAGENT_SERVICE_USER_ID = "portico-service"
SUBAGENT_PARENT_REPAIR_SCAN_LIMIT = 80
SUBAGENT_DESCENDANT_LIMIT = 512
SCHEDULED_RUN_ORIGIN_KEY = "run_origin"
SCHEDULED_RUN_ORIGIN_VALUE = "scheduled"
SCHEDULED_TASK_ID_KEY = "scheduled_task_id"
SCHEDULED_TRUST_META_KEY = "scheduled_run_trusted_by_service"


def _count_list_items(value: Any) -> int:
    return len(value) if isinstance(value, list) else 0


def _usage_to_int(value) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _usage_to_float(value) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def sync_imported_chats_to_search(chats: list[Any], fallback_user_id: str) -> None:
    for imported_chat in chats or []:
        try:
            if isinstance(imported_chat, dict):
                chat_id = imported_chat.get("id")
                chat_user_id = imported_chat.get("user_id") or fallback_user_id
                chat_payload = imported_chat.get("chat")
            else:
                chat_id = getattr(imported_chat, "id", None)
                chat_user_id = getattr(imported_chat, "user_id", None) or fallback_user_id
                chat_payload = getattr(imported_chat, "chat", None)

            if chat_id and isinstance(chat_payload, dict):
                sync_chat_to_search(chat_id, chat_user_id, chat_payload)
        except Exception:
            log.exception(
                "[MessageSearch] Failed to sync imported chat into search index",
            )


def merge_usage(existing_usage: dict, new_usage: dict) -> dict:
    merged_usage = {**existing_usage}
    numeric_usage_fields = {
        "prompt_tokens",
        "completion_tokens",
        "total_tokens",
        "cached_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
        "cache_write_input_tokens",
    }
    numeric_detail_fields = {
        "cached_tokens",
        "cache_creation_tokens",
        "cache_read_tokens",
    }

    for key, value in new_usage.items():
        if key == "prompt_tokens_details":
            merged_details = {}
            if isinstance(merged_usage.get(key), dict):
                merged_details = {**merged_usage[key]}
            if isinstance(value, dict):
                for detail_key, detail_value in value.items():
                    if detail_key in numeric_detail_fields:
                        merged_details[detail_key] = max(
                            _usage_to_int(merged_details.get(detail_key)),
                            _usage_to_int(detail_value),
                        )
                    else:
                        merged_details[detail_key] = detail_value
            merged_usage[key] = merged_details
        elif key in numeric_usage_fields:
            merged_usage[key] = max(
                _usage_to_int(merged_usage.get(key)),
                _usage_to_int(value),
            )
        elif key == "cost":
            merged_usage[key] = max(
                _usage_to_float(merged_usage.get(key)),
                _usage_to_float(value),
            )
        else:
            merged_usage[key] = value

    return merged_usage


def _merge_children_ids(existing_children: Any, new_children: Any) -> list[str]:
    merged_children: list[str] = []
    for children in (existing_children or [], new_children or []):
        if not isinstance(children, list):
            continue
        for child_id in children:
            if not child_id:
                continue
            child_id = str(child_id)
            if child_id not in merged_children:
                merged_children.append(child_id)
    return merged_children


def merge_chat_message(existing_msg: dict, new_msg: dict) -> dict:
    merged_msg = {**existing_msg, **new_msg}

    if "contentBlocks" in existing_msg and "contentBlocks" not in new_msg:
        merged_msg["contentBlocks"] = existing_msg["contentBlocks"]

    existing_usage = existing_msg.get("usage")
    new_usage = new_msg.get("usage")
    if isinstance(existing_usage, dict):
        if new_usage is None:
            merged_msg["usage"] = existing_usage
        elif isinstance(new_usage, dict):
            merged_msg["usage"] = merge_usage(existing_usage, new_usage)

    merged_children = _merge_children_ids(
        existing_msg.get("childrenIds"), new_msg.get("childrenIds")
    )
    if merged_children:
        merged_msg["childrenIds"] = merged_children

    return merged_msg


def _resolve_history_current_id(
    history: dict[str, Any], messages_map: dict[str, Any], fallback_current_id: Any = None
) -> str | None:
    current_id = history.get("currentId")
    if isinstance(current_id, str) and current_id in messages_map:
        return current_id

    if isinstance(fallback_current_id, str) and fallback_current_id in messages_map:
        return fallback_current_id

    leaf_candidates = [
        message
        for message in messages_map.values()
        if isinstance(message, dict) and not (message.get("childrenIds") or [])
    ]
    if not leaf_candidates:
        return None

    leaf_candidates.sort(
        key=lambda message: (
            int(message.get("timestamp") or 0),
            str(message.get("id") or ""),
        )
    )
    return leaf_candidates[-1].get("id")


def rebuild_flat_messages_from_history(history: dict[str, Any]) -> list[dict[str, Any]]:
    messages_map = history.get("messages", {}) or {}
    if not isinstance(messages_map, dict) or not messages_map:
        return []

    current_id = _resolve_history_current_id(history, messages_map)
    if not current_id:
        return []

    try:
        return get_message_list(messages_map, current_id)
    except Exception:
        log.exception("Failed to rebuild flattened chat messages from history")
        return []


def merge_whole_chat_save_with_existing_chat(
    existing_chat_payload: dict[str, Any], incoming_chat_payload: dict[str, Any]
) -> tuple[dict[str, Any], bool]:
    updated_chat = {**existing_chat_payload, **incoming_chat_payload}

    existing_history = existing_chat_payload.get("history", {}) or {}
    existing_messages = existing_history.get("messages", {}) or {}
    new_history = copy.deepcopy(updated_chat.get("history", {}) or {})
    new_messages = copy.deepcopy(new_history.get("messages", {}) or {})

    if not isinstance(existing_messages, dict) or not isinstance(new_messages, dict):
        return updated_chat, False

    backend_only_message_ids = [
        msg_id for msg_id in existing_messages.keys() if msg_id not in new_messages
    ]
    is_stale_save = len(backend_only_message_ids) > 0

    for msg_id, existing_msg in existing_messages.items():
        if msg_id in new_messages:
            new_messages[msg_id] = merge_chat_message(existing_msg, new_messages[msg_id])
        elif is_stale_save:
            new_messages[msg_id] = copy.deepcopy(existing_msg)

    if not new_messages:
        return updated_chat, is_stale_save

    backend_current_id = existing_history.get("currentId")
    if is_stale_save and isinstance(backend_current_id, str) and backend_current_id in new_messages:
        new_history["currentId"] = backend_current_id
    else:
        resolved_current_id = _resolve_history_current_id(
            new_history,
            new_messages,
            fallback_current_id=backend_current_id,
        )
        new_history["currentId"] = resolved_current_id

    new_history["messages"] = new_messages
    updated_chat["history"] = new_history

    rebuilt_messages = rebuild_flat_messages_from_history(new_history)
    if rebuilt_messages:
        updated_chat["messages"] = rebuilt_messages

    return updated_chat, is_stale_save


############################
# MCP Server Icon
############################

@router.get("/mcp/servers/{server_id}/icon")
async def get_mcp_server_icon(server_id: str):
    """Serve MCP server icon.

    PORTICO PATCH: Icons for capabilities display.
    Searches for icon in:
    1. mcp-configs/{server_id}/{server_id}.png (system servers)
    2. mcp-configs-user/{server_id}/{server_id}.png (user-installed servers)
    3. Falls back to default Open WebUI logo
    """
    # A bundled directory reserves the ID even if its icon is incomplete.
    system_dir = MCP_CONFIGS_DIR / server_id
    if system_dir.is_dir():
        icon_path = system_dir / f"{server_id}.png"
        if icon_path.is_file():
            log.debug(f"[MCPIcon] Serving system icon for {server_id}: {icon_path}")
            return FileResponse(icon_path, media_type="image/png")
    else:
        icon_path = MCP_CONFIGS_USER_DIR / server_id / f"{server_id}.png"
        if icon_path.is_file():
            log.debug(f"[MCPIcon] Serving user icon for {server_id}: {icon_path}")
            return FileResponse(icon_path, media_type="image/png")

    # Fallback to default logo (try dev path first, then production path)
    for default_path in [DEFAULT_ICON_PATH, DEFAULT_ICON_PATH_PROD]:
        if default_path.exists():
            log.debug(f"[MCPIcon] No icon found for {server_id}, serving default from {default_path}")
            return FileResponse(default_path, media_type="image/png")

    log.warning(f"[MCPIcon] No icon found for {server_id} and no default available")
    raise HTTPException(status_code=404, detail="Icon not found")


############################
# GetChatList
############################


@router.get("/", response_model=list[SidebarChatTitleIdResponse])
@router.get("/list", response_model=list[SidebarChatTitleIdResponse])
def get_session_user_chat_list(
    user=Depends(get_verified_user),
    page: Optional[int] = None,
    include_pinned: Optional[bool] = False,
    include_folders: Optional[bool] = False,
):
    try:
        if page is not None:
            limit = 60
            skip = (page - 1) * limit

            return _sidebar_chat_rows(
                Chats.get_chat_title_id_list_by_user_id(
                    user.id,
                    include_folders=include_folders,
                    include_pinned=include_pinned,
                    skip=skip,
                    limit=limit,
                ),
                user.id,
            )
        else:
            return _sidebar_chat_rows(
                Chats.get_chat_title_id_list_by_user_id(
                    user.id,
                    include_folders=include_folders,
                    include_pinned=include_pinned,
                ),
                user.id,
            )
    except Exception as e:
        log.exception(e)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=ERROR_MESSAGES.DEFAULT()
        )


############################
# GetChatUsageStats
# EXPERIMENTAL: may be removed in future releases
############################


@router.get("/stats/usage", response_model=ChatUsageStatsListResponse)
def get_session_user_chat_usage_stats(
    items_per_page: Optional[int] = 50,
    page: Optional[int] = 1,
    user=Depends(get_verified_user),
):
    try:
        limit = items_per_page
        skip = (page - 1) * limit

        result = Chats.get_chats_by_user_id(user.id, skip=skip, limit=limit)

        chats = result.items
        total = result.total

        chat_stats = []
        for chat in chats:
            messages_map = chat.chat.get("history", {}).get("messages", {})
            message_id = chat.chat.get("history", {}).get("currentId")

            if messages_map and message_id:
                try:
                    history_models = {}
                    history_message_count = len(messages_map)
                    history_user_messages = []
                    history_assistant_messages = []

                    for message in messages_map.values():
                        if message.get("role", "") == "user":
                            history_user_messages.append(message)
                        elif message.get("role", "") == "assistant":
                            history_assistant_messages.append(message)
                            model = message.get("model", None)
                            if model:
                                if model not in history_models:
                                    history_models[model] = 0
                                history_models[model] += 1

                    average_user_message_content_length = (
                        sum(
                            len(message.get("content", ""))
                            for message in history_user_messages
                        )
                        / len(history_user_messages)
                        if len(history_user_messages) > 0
                        else 0
                    )
                    average_assistant_message_content_length = (
                        sum(
                            len(message.get("content", ""))
                            for message in history_assistant_messages
                        )
                        / len(history_assistant_messages)
                        if len(history_assistant_messages) > 0
                        else 0
                    )

                    response_times = []
                    for message in history_assistant_messages:
                        user_message_id = message.get("parentId", None)
                        if user_message_id and user_message_id in messages_map:
                            user_message = messages_map[user_message_id]
                            response_time = message.get(
                                "timestamp", 0
                            ) - user_message.get("timestamp", 0)

                            response_times.append(response_time)

                    average_response_time = (
                        sum(response_times) / len(response_times)
                        if len(response_times) > 0
                        else 0
                    )

                    message_list = get_message_list(messages_map, message_id)
                    message_count = len(message_list)

                    models = {}
                    for message in reversed(message_list):
                        if message.get("role") == "assistant":
                            model = message.get("model", None)
                            if model:
                                if model not in models:
                                    models[model] = 0
                                models[model] += 1

                            annotation = message.get("annotation", {})

                    chat_stats.append(
                        {
                            "id": chat.id,
                            "models": models,
                            "message_count": message_count,
                            "history_models": history_models,
                            "history_message_count": history_message_count,
                            "history_user_message_count": len(history_user_messages),
                            "history_assistant_message_count": len(
                                history_assistant_messages
                            ),
                            "average_response_time": average_response_time,
                            "average_user_message_content_length": average_user_message_content_length,
                            "average_assistant_message_content_length": average_assistant_message_content_length,
                            "tags": chat.meta.get("tags", []),
                            "last_message_at": message_list[-1].get("timestamp", None),
                            "updated_at": chat.updated_at,
                            "created_at": chat.created_at,
                        }
                    )
                except Exception as e:
                    pass

        return ChatUsageStatsListResponse(items=chat_stats, total=total)

    except Exception as e:
        log.exception(e)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=ERROR_MESSAGES.DEFAULT()
        )


############################
# PORTICO PATCH: Active Capabilities
############################


def _get_redis_client():
    """Get Redis client for capabilities lookup."""
    if not REDIS_AVAILABLE:
        return None
    try:
        client = redis.Redis(
            host="redis",
            port=6379,
            db=0,
            decode_responses=True,
            socket_connect_timeout=2
        )
        client.ping()
        return client
    except Exception as e:
        log.warning(f"Failed to connect to Redis: {e}")
        return None


def _format_server_display_name(server_id: str) -> str:
    """Format server ID to display name.

    Examples:
        'server:glean' -> 'Glean'
        'server:chrome-devtools' -> 'Chrome Devtools'
        'server:mcp-assistant' -> 'MCP Assistant'
    """
    name = server_id.replace("server:", "")

    if YAML_AVAILABLE:
        system_dir = MCP_CONFIGS_DIR / name
        base_dirs = (
            (MCP_CONFIGS_DIR,)
            if system_dir.is_dir()
            else (MCP_CONFIGS_USER_DIR,)
        )
        for base_dir in base_dirs:
            yaml_path = base_dir / name / f"{name}.yaml"
            if not yaml_path.exists():
                continue
            try:
                with open(yaml_path, "r") as handle:
                    config = yaml.safe_load(handle) or {}
                display_name = (config.get("display_name") or config.get("name") or "").strip()
                if display_name:
                    return display_name
            except Exception as e:
                log.debug(f"[ChatCapabilities] Failed to read server metadata for {name}: {e}")

    words = [word for word in re.split(r"[-_]+", name) if word]
    acronyms = {"mcp", "vm", "api", "pdf", "oauth", "ai"}
    formatted_words = []
    for word in words:
        if word.lower() in acronyms:
            formatted_words.append(word.upper())
        else:
            formatted_words.append(word.capitalize())
    return " ".join(formatted_words)


# PORTICO PATCH: skills provenance enrichment for active-capabilities.
# One list_skills call against the core skills server, cached briefly so a
# burst of chat loads / capability events shares a single fetch. Fail-open:
# enrichment failures degrade to unbadged rows, never to endpoint errors.
_SKILLS_CATALOG_TTL_SECONDS = 60.0
_SKILLS_CATALOG_TIMEOUT_SECONDS = 3.0
_skills_catalog_cache: dict = {"at": 0.0, "skills": None}


def _core_mcp_proxy_base_url() -> str:
    return os.getenv("CORE_MCP_PROXY_BASE_URL", "http://mcpo-core:8081").rstrip("/")


async def _get_skills_catalog() -> list:
    now = time.monotonic()
    cached = _skills_catalog_cache["skills"]
    if cached is not None and now - _skills_catalog_cache["at"] < _SKILLS_CATALOG_TTL_SECONDS:
        return cached
    try:
        timeout = aiohttp.ClientTimeout(total=_SKILLS_CATALOG_TIMEOUT_SECONDS)
        async with aiohttp.ClientSession(timeout=timeout, trust_env=True) as session:
            async with session.post(
                f"{_core_mcp_proxy_base_url()}/skills/skills_list_skills",
                json={"include_content": False, "filter_source": "all"},
            ) as response:
                payload = await response.json(content_type=None)
        content = payload.get("content") if isinstance(payload, dict) else None
        if (
            isinstance(content, list)
            and content
            and isinstance(content[0], dict)
            and isinstance(content[0].get("text"), str)
        ):
            payload = json.loads(content[0]["text"])
        skills = payload.get("skills") if isinstance(payload, dict) else None
        if not isinstance(skills, list):
            skills = []
        _skills_catalog_cache["at"] = now
        _skills_catalog_cache["skills"] = skills
        return skills
    except Exception as e:
        log.warning(f"[ChatCapabilities] Skills catalog fetch failed (enrichment degraded): {e}")
        return cached or []


def _skill_catalog_index(skills: list) -> tuple:
    """Index a list_skills catalog for alias-tolerant lookups.

    Redis stores whatever skill_name activation received: the FQN
    ({marketplace}/{plugin}/{skill} or {marketplace}/{skill}), a legacy
    2-segment {marketplace}/{skill} alias for plugin skills, or a bare
    leaf name.
    """
    exact: dict = {}
    by_leaf: dict = {}
    legacy: dict = {}
    for skill in skills:
        if not isinstance(skill, dict):
            continue
        name = str(skill.get("name") or "")
        if not name:
            continue
        exact[name] = skill
        by_leaf.setdefault(name.split("/")[-1], []).append(skill)
        parts = name.split("/")
        if len(parts) == 3:
            legacy.setdefault(f"{parts[0]}/{parts[2]}", []).append(skill)
    return exact, by_leaf, legacy


def _default_skill_display_name(raw_name: str) -> str:
    return raw_name.replace("-", " ").title()


def _enrich_active_skill(raw_name: str, index) -> dict:
    base = {"name": raw_name, "display_name": _default_skill_display_name(raw_name)}
    if index is None:
        return base
    exact, by_leaf, legacy = index
    skill = exact.get(raw_name)
    if skill is None:
        candidates = legacy.get(raw_name) or by_leaf.get(raw_name.split("/")[-1]) or []
        # Ambiguous aliases stay unenriched rather than guessing a provenance.
        skill = candidates[0] if len(candidates) == 1 else None
    if skill is None:
        return base
    fq_name = str(skill.get("name") or raw_name)
    source = str(skill.get("source") or "") or None
    display_name = str(skill.get("display_name") or "").strip()
    if not display_name:
        display_name = _default_skill_display_name(fq_name.split("/")[-1])
    marketplace_id = (
        fq_name.split("/")[0] if source == "marketplace" and "/" in fq_name else None
    )
    # Plugin identity is positional in 3-segment FQNs ({marketplace}/{plugin}/
    # {skill}) — display-only, parallel to the marketplace_id derivation.
    fq_parts = fq_name.split("/")
    plugin_name = (
        fq_parts[1] if source == "marketplace" and len(fq_parts) == 3 else None
    )
    return {
        "name": raw_name,
        "display_name": display_name,
        "source": source,
        "marketplace_relationship": skill.get("marketplace_relationship"),
        "marketplace_id": marketplace_id,
        "plugin_name": plugin_name,
    }


@router.get("/{id}/active-capabilities")
async def get_chat_active_capabilities(id: str, user=Depends(get_verified_user)):
    """Get active MCP tools and skills for a chat session.

    PORTICO PATCH: Real-time capabilities display
    """
    log.info(f"[ChatCapabilities] GET /active-capabilities called for chat_id={id}")
    _get_read_authorized_chat_or_404(id, user)

    redis_client = _get_redis_client()
    if not redis_client:
        log.warning("[ChatCapabilities] Redis client not available, returning empty capabilities")
        return {"tools": [], "skills": []}

    try:
        # Fetch from Redis
        tools_key = f"chat_tools:{id}"
        skills_key = f"chat_skills:{id}"
        tools_json = redis_client.get(tools_key)
        skills_json = redis_client.get(skills_key)

        log.info(
            "[ChatCapabilities] Redis lookup chat_id=%s tools_key_present=%s skills_key_present=%s",
            id,
            bool(tools_json),
            bool(skills_json),
        )

        tools = json.loads(tools_json) if tools_json else []
        skills = json.loads(skills_json) if skills_json else []

        log.info(
            "[ChatCapabilities] Parsed capabilities chat_id=%s tools_count=%d skills_count=%d",
            id,
            _count_list_items(tools),
            _count_list_items(skills),
        )

        # Build response with display names and icon URLs
        # Icon URLs point to OWUI backend which serves icons from mcp-configs directory
        # Endpoint is at /api/v1/chats/mcp/servers/{server_id}/icon
        core_servers = {"agent-vm", "web-tools", "artifacts", "mcp-assistant", "scheduling", "skills", "subagents"}

        tools_response = []
        for t in tools:
            server_id = t.replace("server:", "")
            is_core = server_id in core_servers
            tools_response.append({
                "server_id": server_id,
                "display_name": _format_server_display_name(t),
                "icon_url": f"/api/v1/chats/mcp/servers/{server_id}/icon",
                "is_core": is_core
            })

        # Provenance enrichment only when the chat actually has active skills
        # (the catalog fetch is TTL-cached and bounded, see _get_skills_catalog).
        skills_index = (
            _skill_catalog_index(await _get_skills_catalog()) if skills else None
        )
        skills_response = [
            _enrich_active_skill(str(s), skills_index) for s in skills
        ]

        log.info(
            "[ChatCapabilities] Response chat_id=%s tools_count=%d skills_count=%d",
            id,
            len(tools_response),
            len(skills_response),
        )

        return {
            "tools": tools_response,
            "skills": skills_response
        }
    except Exception as e:
        log.error(f"[ChatCapabilities] Failed to get active capabilities: {e}")
        return {"tools": [], "skills": []}


@router.get("/subagents/tool-call/{tool_call_id}")
async def get_subagent_chat_by_tool_call(tool_call_id: str, user=Depends(get_verified_user)):
    """Resolve a subagent chat_id from a parent tool_call_id."""
    redis_client = _get_redis_client()
    if not redis_client:
        return {"chat_id": None}

    try:
        mapping_key = f"subagent_tool_call:{tool_call_id}"
        mapping_json = redis_client.get(mapping_key)
        if not mapping_json:
            return {"chat_id": None}

        try:
            mapping = json.loads(mapping_json)
        except Exception:
            mapping = {}

        chat_id = mapping.get("chat_id") if isinstance(mapping, dict) else None
        if chat_id and not _get_read_authorized_chat(chat_id, user):
            log.info(
                "[SubagentLookup] Denied subagent child chat lookup tool_call_id=%s chat_id=%s user_id=%s",
                tool_call_id,
                chat_id,
                user.id,
            )
            chat_id = None
        return {"chat_id": chat_id}
    except Exception as e:
        log.warning(f"[SubagentLookup] Failed to resolve tool_call_id={tool_call_id}: {e}")
        return {"chat_id": None}


class CapabilitiesChangedForm(BaseModel):
    """Form data for capabilities changed callback."""
    tools: Optional[list[dict]] = None
    skills: Optional[list[dict]] = None


@router.post("/{id}/capabilities-changed")
async def notify_capabilities_changed(id: str, form_data: CapabilitiesChangedForm):
    """Internal callback from MCP servers when capabilities change.

    Emits socket event to frontend for real-time UI updates.
    PORTICO PATCH: Real-time capabilities display
    """
    log.info(f"[ChatCapabilities] POST /capabilities-changed called for chat_id={id}")
    log.info(
        "[ChatCapabilities] Received capabilities update chat_id=%s tools_count=%d skills_count=%d",
        id,
        _count_list_items(form_data.tools),
        _count_list_items(form_data.skills),
    )

    try:
        # Get the chat to find its owner's user_id
        chat = Chats.get_chat_by_id(id)
        if not chat:
            log.warning(f"[ChatCapabilities] Chat {id} not found")
            return {"success": False, "error": "Chat not found"}

        user_id = chat.user_id
        log.info(f"[ChatCapabilities] Found chat owner user_id={user_id}")

        # Enrich the pushed skills the same way GET /active-capabilities does,
        # so the socket payload stays self-contained for the frontend.
        skills_payload = form_data.skills or []
        skill_names = [
            str(s.get("name") or "")
            for s in skills_payload
            if isinstance(s, dict) and s.get("name")
        ]
        if skill_names:
            skills_index = _skill_catalog_index(await _get_skills_catalog())
            skills_payload = [
                _enrich_active_skill(name, skills_index) for name in skill_names
            ]

        # Emit directly to the user's room via sio
        event_data = {
            "chat_id": id,
            "message_id": None,  # No specific message, this is a chat-level event
            "data": {
                "type": "chat:capabilities:updated",
                "data": {
                    "chat_id": id,
                    "tools": form_data.tools or [],
                    "skills": skills_payload
                }
            }
        }
        log.info(
            "[ChatCapabilities] Emitting capabilities update chat_id=%s user_id=%s tools_count=%d skills_count=%d",
            id,
            user_id,
            _count_list_items(form_data.tools),
            _count_list_items(form_data.skills),
        )
        await sio.emit("events", event_data, room=f"user:{user_id}")
        log.info(f"[ChatCapabilities] Successfully emitted capabilities update for chat {id}")
        return {"success": True}
    except Exception as e:
        log.error(f"[ChatCapabilities] Failed to emit capabilities update: {e}")
        return {"success": False, "error": str(e)}


class PendingWorkRequestContext(BaseModel):
    selected_model_ids: list[str] = Field(default_factory=list)
    selected_model_items: Optional[dict[str, dict[str, Any]]] = None
    tool_ids: list[str] = Field(default_factory=list)
    tool_servers: list[dict[str, Any]] = Field(default_factory=list)
    filter_ids: list[str] = Field(default_factory=list)
    features: dict[str, Any] = Field(default_factory=dict)
    reasoning_effort_by_model: dict[str, str] = Field(default_factory=dict)
    params: dict[str, Any] = Field(default_factory=dict)
    variables: dict[str, Any] = Field(default_factory=dict)
    background_tasks: dict[str, Any] = Field(default_factory=dict)
    session_id: Optional[str] = None


class PendingWorkMessageForm(BaseModel):
    id: Optional[str] = None
    prompt: str = ""
    files: list[dict[str, Any]] = Field(default_factory=list)
    request_context: Optional[PendingWorkRequestContext] = None
    status: Optional[str] = None


def _get_async_redis_client(request: Request):
    return getattr(request.app.state, "redis", None)


def _chat_payload_dict(chat) -> dict[str, Any]:
    payload = getattr(chat, "chat", None)
    if isinstance(payload, dict):
        return payload
    if isinstance(payload, str):
        try:
            parsed = json.loads(payload)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            return {}
    return {}


def _subagent_metadata_from_chat(chat) -> dict[str, Any]:
    payload = _chat_payload_dict(chat)
    nested_meta = payload.get("meta")
    candidates = []
    if isinstance(nested_meta, dict):
        candidates.append(nested_meta)
    top_level_meta = getattr(chat, "meta", None)
    if isinstance(top_level_meta, dict):
        candidates.append(top_level_meta)

    for candidate in candidates:
        subagent = candidate.get("subagent")
        if isinstance(subagent, dict):
            return subagent
        if any(
            isinstance(candidate.get(key), str)
            for key in ("parent_chat_id", "root_parent_chat_id")
        ):
            return candidate
    return {}


def _subagent_parent_ids_from_metadata(metadata: Any) -> list[str]:
    if not isinstance(metadata, dict):
        return []

    candidates = [metadata]
    nested = metadata.get("subagent")
    if isinstance(nested, dict):
        candidates.insert(0, nested)

    parent_ids: list[str] = []
    for candidate in candidates:
        for key in ("parent_chat_id", "root_parent_chat_id", "inherited_from_chat_id"):
            value = candidate.get(key)
            if isinstance(value, str):
                parent_id = value.strip()
                if parent_id and parent_id not in parent_ids:
                    parent_ids.append(parent_id)
    return parent_ids


def _read_subagent_reverse_metadata(chat_id: str) -> dict[str, Any]:
    redis_client = _get_redis_client()
    if not redis_client:
        return {}

    try:
        raw = redis_client.get(f"subagent_chat:{chat_id}")
        if not raw:
            return {}
        metadata = json.loads(raw)
        return metadata if isinstance(metadata, dict) else {}
    except Exception as error:
        log.debug("[SubagentAccess] Failed to read reverse metadata for %s: %s", chat_id, error)
        return {}


def _parent_chat_is_owned_by_user(parent_chat_id: str, user_id: str) -> bool:
    if not parent_chat_id:
        return False
    try:
        return Chats.get_chat_by_id_and_user_id(parent_chat_id, user_id) is not None
    except Exception as error:
        log.debug(
            "[SubagentAccess] Parent ownership check failed parent_chat_id=%s user_id=%s: %s",
            parent_chat_id,
            user_id,
            error,
        )
        return False


def _parsed_json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        return {}
    try:
        parsed = json.loads(value)
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


def _scheduled_run_metadata_from_payload(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    meta = payload.get("meta")
    if not isinstance(meta, dict):
        return {}
    if meta.get(SCHEDULED_RUN_ORIGIN_KEY) != SCHEDULED_RUN_ORIGIN_VALUE:
        return {}
    task_id = meta.get(SCHEDULED_TASK_ID_KEY)
    if not isinstance(task_id, str) or not task_id.strip():
        return {}
    return meta


def _chat_has_scheduled_run_metadata(chat: Any) -> bool:
    return bool(_scheduled_run_metadata_from_payload(_chat_payload_dict(chat)))


def _chat_is_trusted_scheduled_run(chat: Any) -> bool:
    if not _chat_has_scheduled_run_metadata(chat):
        return False
    if getattr(chat, "user_id", None) == SUBAGENT_SERVICE_USER_ID:
        return True
    top_meta = getattr(chat, "meta", None)
    return isinstance(top_meta, dict) and top_meta.get(SCHEDULED_TRUST_META_KEY) is True


def _primary_human_user_id() -> Optional[str]:
    try:
        with engine.connect() as conn:
            row = conn.execute(
                sql_text(
                    """
                    SELECT id
                    FROM user
                    WHERE id != :service_user_id
                    ORDER BY updated_at DESC, created_at DESC
                    LIMIT 1
                    """
                ),
                {"service_user_id": SUBAGENT_SERVICE_USER_ID},
            ).mappings().first()
            return row["id"] if row else None
    except Exception as error:
        log.warning("[ScheduledTasks] Failed to resolve human chat owner: %s", error)
        return None


def _folder_name_for_id(folder_id: Optional[str]) -> Optional[str]:
    if not folder_id:
        return None
    try:
        with engine.connect() as conn:
            row = conn.execute(
                sql_text("SELECT name FROM folder WHERE id = :folder_id"),
                {"folder_id": folder_id},
            ).mappings().first()
            name = row["name"] if row else None
            return name if isinstance(name, str) and name.strip() else None
    except Exception as error:
        log.debug("[ScheduledTasks] Failed to read service folder name: %s", error)
        return None


def _ensure_folder_for_user_id(user_id: str, folder_name: str) -> Optional[str]:
    name = folder_name.strip()
    if not user_id or not name:
        return None

    try:
        with engine.begin() as conn:
            existing = conn.execute(
                sql_text(
                    """
                    SELECT id
                    FROM folder
                    WHERE user_id = :user_id
                      AND parent_id IS NULL
                      AND name = :name
                    ORDER BY updated_at DESC, created_at DESC
                    LIMIT 1
                    """
                ),
                {"user_id": user_id, "name": name},
            ).mappings().first()
            if existing:
                return existing["id"]

            folder_id = str(uuid.uuid4())
            now = int(time.time())
            conn.execute(
                sql_text(
                    """
                    INSERT INTO folder
                        (id, parent_id, user_id, name, items, meta, is_expanded, created_at, updated_at, data)
                    VALUES
                        (:id, NULL, :user_id, :name, NULL, NULL, 1, :now, :now, :data)
                    """
                ),
                {
                    "id": folder_id,
                    "user_id": user_id,
                    "name": name,
                    "now": now,
                    "data": json.dumps({"files": [], "system_prompt": "", "model_ids": []}),
                },
            )
            return folder_id
    except Exception as error:
        log.warning(
            "[ScheduledTasks] Failed to ensure human folder user_id=%s name=%s: %s",
            user_id,
            name,
            error,
        )
        return None


def _copy_chat_form_with_folder_id(form_data: ChatForm, folder_id: Optional[str]) -> ChatForm:
    if hasattr(form_data, "model_copy"):
        return form_data.model_copy(update={"folder_id": folder_id})
    if hasattr(form_data, "copy"):
        return form_data.copy(update={"folder_id": folder_id})
    form_data.folder_id = folder_id
    return form_data


def _scheduled_chat_target_for_create(form_data: ChatForm, user) -> tuple[str, ChatForm, bool]:
    if getattr(user, "id", None) != SUBAGENT_SERVICE_USER_ID:
        return user.id, form_data, False
    if not _scheduled_run_metadata_from_payload(getattr(form_data, "chat", None)):
        return user.id, form_data, False

    human_user_id = _primary_human_user_id()
    if not human_user_id:
        return user.id, form_data, False

    folder_id = getattr(form_data, "folder_id", None)
    folder_name = _folder_name_for_id(folder_id)
    if folder_name:
        human_folder_id = _ensure_folder_for_user_id(human_user_id, folder_name)
        if human_folder_id:
            form_data = _copy_chat_form_with_folder_id(form_data, human_folder_id)

    return human_user_id, form_data, True


SERVICE_OWNER_PRIMARY_HUMAN = "primary-human"

# Multi-chat tiling: a start_chat child records its root under this chat.meta
# key; the root chat accumulates its pane registry under the panes key.
MULTI_CHAT_META_KEY = "multi_chat"
MULTI_CHAT_PANES_META_KEY = "multi_chat_panes"
MAX_MULTI_CHAT_PANES = 3
ORCHESTRATOR_DISPLAY_NAME = "Orchestrator"
MULTI_CHAT_DISPLAY_NAME_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,24}$")


def _validate_multi_chat_start(form_data: ChatForm, user) -> Optional[tuple[str, str]]:
    """Validate a tiling start_chat creation. Returns (root_chat_id,
    display_name) when this creation should join a tile grid, or None for
    non-tiling creations (human callers, scheduled chats, legacy starts
    without a source chat). Raises HTTPException with a structured
    detail code on policy violations so the Rust caller can relay them."""
    if getattr(user, "id", None) != SUBAGENT_SERVICE_USER_ID:
        return None
    if getattr(form_data, "service_owner", None) != SERVICE_OWNER_PRIMARY_HUMAN:
        return None
    source_chat_id = (getattr(form_data, "service_started_by_chat_id", None) or "").strip()
    if not source_chat_id:
        return None

    display_name = (getattr(form_data, "service_pane_display_name", None) or "").strip()
    if (
        not MULTI_CHAT_DISPLAY_NAME_PATTERN.fullmatch(display_name)
        or display_name.lower() == ORCHESTRATOR_DISPLAY_NAME.lower()
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "invalid_display_name",
                "message": (
                    "display_name must be a single word of 1-24 letters, digits, "
                    "hyphens, or underscores, and must not be 'Orchestrator' "
                    "(reserved for the root chat)."
                ),
            },
        )

    source_chat = Chats.get_chat_by_id(source_chat_id)
    if not source_chat:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "source_chat_not_found",
                "message": f"Source chat {source_chat_id} does not exist.",
            },
        )

    source_meta = getattr(source_chat, "meta", None) or {}
    if not isinstance(source_meta, dict):
        source_meta = {}
    multi_chat_link = source_meta.get(MULTI_CHAT_META_KEY)
    if isinstance(multi_chat_link, dict) and multi_chat_link.get("started_by_chat_id"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "child_chat_cannot_start_chats",
                "message": (
                    "Only the orchestrator (root) chat can start new chats. "
                    "This chat was itself started by another chat — reply to "
                    "your peer with subagents_send_message_to_chat instead."
                ),
            },
        )

    existing_panes = source_meta.get(MULTI_CHAT_PANES_META_KEY)
    if isinstance(existing_panes, list) and len(existing_panes) >= MAX_MULTI_CHAT_PANES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "multi_chat_tiles_full",
                "message": (
                    "The tile grid is full (orchestrator + "
                    f"{MAX_MULTI_CHAT_PANES} chats). Coordinate with the "
                    "existing chats via subagents_send_message_to_chat instead."
                ),
            },
        )

    return source_chat_id, display_name


def _register_multi_chat_pane(
    root_chat_id: str, child_chat_id: str, display_name: str
) -> Optional[dict[str, Any]]:
    """Stamp the child's root link and append the pane to the root's registry
    in ONE transaction (raw SQL — no meta-update model helper exists). Returns
    the pane entry, or None when a concurrent start filled the grid first."""
    pane = {
        "chat_id": child_chat_id,
        "display_name": display_name,
        "created_at": int(time.time()),
    }
    try:
        with engine.begin() as conn:
            root_row = conn.execute(
                sql_text("SELECT meta FROM chat WHERE id = :chat_id"),
                {"chat_id": root_chat_id},
            ).mappings().first()
            root_meta = _parsed_json_object(root_row["meta"]) if root_row else {}
            panes = root_meta.get(MULTI_CHAT_PANES_META_KEY)
            panes = list(panes) if isinstance(panes, list) else []
            if len(panes) >= MAX_MULTI_CHAT_PANES:
                log.warning(
                    "[MultiChat] Pane registry for %s filled concurrently; "
                    "not tiling chat %s",
                    root_chat_id,
                    child_chat_id,
                )
                return None

            child_row = conn.execute(
                sql_text("SELECT meta FROM chat WHERE id = :chat_id"),
                {"chat_id": child_chat_id},
            ).mappings().first()
            child_meta = _parsed_json_object(child_row["meta"]) if child_row else {}
            child_meta[MULTI_CHAT_META_KEY] = {
                "started_by_chat_id": root_chat_id,
                "display_name": display_name,
            }
            conn.execute(
                sql_text("UPDATE chat SET meta = :meta WHERE id = :chat_id"),
                {"chat_id": child_chat_id, "meta": json.dumps(child_meta)},
            )

            panes.append(pane)
            root_meta[MULTI_CHAT_PANES_META_KEY] = panes
            conn.execute(
                sql_text("UPDATE chat SET meta = :meta WHERE id = :chat_id"),
                {"chat_id": root_chat_id, "meta": json.dumps(root_meta)},
            )
        return pane
    except Exception as error:
        log.warning("[MultiChat] Failed to register pane: %s", error)
        return None


def _delegated_human_chat_target_for_create(form_data: ChatForm, user) -> tuple[str, ChatForm]:
    """Cross-chat start_chat: the service principal creates a chat OWNED by
    the primary human user (visible in their sidebar). Unlike the scheduled
    branch above, the signal is an explicit form field and NO scheduled/trust
    metadata is read or stamped — the chat behaves like any human-created one.
    """
    service_owner = getattr(form_data, "service_owner", None)
    if getattr(user, "id", None) != SUBAGENT_SERVICE_USER_ID:
        if service_owner:
            log.warning(
                "[StartChat] Ignoring service_owner from non-service caller %s",
                getattr(user, "id", None),
            )
        return user.id, form_data
    if service_owner != SERVICE_OWNER_PRIMARY_HUMAN:
        return user.id, form_data

    human_user_id = _primary_human_user_id()
    if not human_user_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No human user available to own the chat",
        )

    folder_name = (getattr(form_data, "service_folder_name", None) or "").strip()
    if folder_name:
        human_folder_id = _ensure_folder_for_user_id(human_user_id, folder_name)
        if human_folder_id:
            form_data = _copy_chat_form_with_folder_id(form_data, human_folder_id)

    return human_user_id, form_data


def _mark_scheduled_chat_trusted(chat_id: str) -> None:
    try:
        with engine.begin() as conn:
            row = conn.execute(
                sql_text("SELECT meta FROM chat WHERE id = :chat_id"),
                {"chat_id": chat_id},
            ).mappings().first()
            current_meta = _parsed_json_object(row["meta"]) if row else {}
            current_meta[SCHEDULED_TRUST_META_KEY] = True
            conn.execute(
                sql_text("UPDATE chat SET meta = :meta WHERE id = :chat_id"),
                {"chat_id": chat_id, "meta": json.dumps(current_meta)},
            )
    except Exception as error:
        log.warning("[ScheduledTasks] Failed to mark scheduled chat trusted: %s", error)


def _preserve_trusted_scheduled_metadata_on_save(chat: Any, payload: dict[str, Any]) -> dict[str, Any]:
    existing_meta = _scheduled_run_metadata_from_payload(_chat_payload_dict(chat))
    if not existing_meta:
        return payload

    top_meta = getattr(chat, "meta", None)
    trusted = getattr(chat, "user_id", None) == SUBAGENT_SERVICE_USER_ID or (
        isinstance(top_meta, dict) and top_meta.get(SCHEDULED_TRUST_META_KEY) is True
    )
    if not trusted:
        return payload

    next_payload = copy.deepcopy(payload)
    next_meta = next_payload.get("meta")
    if not isinstance(next_meta, dict):
        next_meta = {}
    next_meta.update(existing_meta)
    next_payload["meta"] = next_meta
    return next_payload


def _result_references_subagent_child(result: Any, child_chat_id: str) -> bool:
    if not isinstance(result, dict):
        return False
    if result.get("server_id") not in (None, "subagents", "server:subagents"):
        return False

    content = result.get("content")
    content_payload = _parsed_json_object(content)
    return content_payload.get("chat_id") == child_chat_id


def _parse_nested_json_object(value: Any) -> dict[str, Any]:
    """Parse tool results that may be JSON encoded more than once."""
    parsed = value
    for _ in range(3):
        if isinstance(parsed, dict):
            return parsed
        if not isinstance(parsed, str) or not parsed.strip():
            return {}
        try:
            parsed = json.loads(parsed)
        except Exception:
            return {}
    return parsed if isinstance(parsed, dict) else {}


def _is_subagent_tool_name(value: Any) -> bool:
    normalized = str(value or "").strip().lower()
    return "run_subagent" in normalized or "subagent" in normalized


def _non_negative_int_or_none(value: Any) -> Optional[int]:
    try:
        numeric = int(value)
    except (TypeError, ValueError):
        return None
    return numeric if numeric >= 0 else None


def _subagent_display_tokens_from_stats(stats: dict[str, Any]) -> Optional[int]:
    context_tokens = _non_negative_int_or_none(stats.get("context_tokens"))
    max_context_tokens = _non_negative_int_or_none(stats.get("max_context_tokens"))
    if context_tokens and context_tokens > 0:
        if max_context_tokens and max_context_tokens > 0:
            return min(context_tokens, max_context_tokens)
        return context_tokens

    usage_tokens = _non_negative_int_or_none(
        stats.get("usage_tokens", stats.get("total_tokens"))
    )
    return usage_tokens if usage_tokens and usage_tokens > 0 else None


def _collect_subagent_tool_call_details_from_messages(
    messages: Any,
) -> dict[str, dict[str, Any]]:
    """Collect direct subagent calls and any stats embedded in their results."""
    if isinstance(messages, dict):
        message_values = messages.values()
    elif isinstance(messages, list):
        message_values = messages
    else:
        return {}

    details: dict[str, dict[str, Any]] = {}

    def add_tool_calls(tool_calls: Any) -> None:
        if not isinstance(tool_calls, list):
            return
        for tool_call in tool_calls:
            if not isinstance(tool_call, dict):
                continue
            function_data = tool_call.get("function")
            if not isinstance(function_data, dict) or not _is_subagent_tool_name(
                function_data.get("name")
            ):
                continue
            tool_call_id = str(tool_call.get("id") or "").strip()
            if tool_call_id:
                details.setdefault(
                    tool_call_id,
                    {
                        "chat_id": None,
                        "tool_call_count": None,
                        "display_tokens": None,
                    },
                )

    def add_results(results: Any) -> None:
        if not isinstance(results, list):
            return
        for result in results:
            if not isinstance(result, dict):
                continue
            tool_call_id = str(result.get("tool_call_id") or "").strip()
            server_id = str(result.get("server_id") or "").strip().lower()
            if not tool_call_id or (
                tool_call_id not in details
                and server_id not in ("subagents", "server:subagents")
            ):
                continue
            parsed = _parse_nested_json_object(
                result.get("content", result.get("result", result))
            )
            detail = details.setdefault(
                tool_call_id,
                {
                    "chat_id": None,
                    "tool_call_count": None,
                    "display_tokens": None,
                },
            )
            chat_id = str(parsed.get("chat_id") or result.get("chat_id") or "").strip()
            if chat_id and not chat_id.startswith("local:"):
                detail["chat_id"] = chat_id
            tool_call_count = _non_negative_int_or_none(parsed.get("tool_call_count"))
            if tool_call_count is not None:
                detail["tool_call_count"] = tool_call_count
            display_tokens = _subagent_display_tokens_from_stats(parsed)
            if display_tokens is not None:
                detail["display_tokens"] = display_tokens

    for message in message_values:
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        add_tool_calls(message.get("tool_calls"))
        content_blocks = message.get("contentBlocks")
        if isinstance(content_blocks, list):
            for block in content_blocks:
                if not isinstance(block, dict) or block.get("type") != "tool_calls":
                    continue
                add_tool_calls(block.get("content"))
                add_results(block.get("results"))
        add_results(message.get("results"))
        add_results(message.get("tool_results"))

    return details


def _collect_subagent_tool_call_details_from_chat(
    chat: Any,
) -> dict[str, dict[str, Any]]:
    payload = _chat_payload_dict(chat)
    history = payload.get("history")
    history_messages = history.get("messages") if isinstance(history, dict) else None
    if isinstance(history_messages, (dict, list)):
        return _collect_subagent_tool_call_details_from_messages(history_messages)
    return _collect_subagent_tool_call_details_from_messages(payload.get("messages"))


def _collect_subagent_refs_from_messages(
    messages: Any,
) -> tuple[list[str], list[str]]:
    """Return embedded child chat IDs and unresolved subagent tool-call IDs."""
    if isinstance(messages, dict):
        message_values = messages.values()
    elif isinstance(messages, list):
        message_values = messages
    else:
        return [], []

    chat_ids: list[str] = []
    unresolved_tool_call_ids: list[str] = []
    subagent_tool_call_ids: set[str] = set()

    def add_tool_calls(tool_calls: Any) -> None:
        if not isinstance(tool_calls, list):
            return
        for tool_call in tool_calls:
            if not isinstance(tool_call, dict):
                continue
            function_data = tool_call.get("function")
            if not isinstance(function_data, dict) or not _is_subagent_tool_name(
                function_data.get("name")
            ):
                continue
            tool_call_id = str(tool_call.get("id") or "").strip()
            if tool_call_id:
                subagent_tool_call_ids.add(tool_call_id)
                if tool_call_id not in unresolved_tool_call_ids:
                    unresolved_tool_call_ids.append(tool_call_id)

    def add_results(results: Any) -> None:
        if not isinstance(results, list):
            return
        for result in results:
            if not isinstance(result, dict):
                continue
            tool_call_id = str(result.get("tool_call_id") or "").strip()
            server_id = str(result.get("server_id") or "").strip().lower()
            if (
                tool_call_id not in subagent_tool_call_ids
                and server_id not in ("subagents", "server:subagents")
            ):
                continue
            parsed = _parse_nested_json_object(
                result.get("content", result.get("result", result))
            )
            chat_id = str(parsed.get("chat_id") or result.get("chat_id") or "").strip()
            if chat_id and not chat_id.startswith("local:"):
                if chat_id not in chat_ids:
                    chat_ids.append(chat_id)
                if tool_call_id in unresolved_tool_call_ids:
                    unresolved_tool_call_ids.remove(tool_call_id)

    for message in message_values:
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        add_tool_calls(message.get("tool_calls"))
        content_blocks = message.get("contentBlocks")
        if isinstance(content_blocks, list):
            for block in content_blocks:
                if not isinstance(block, dict) or block.get("type") != "tool_calls":
                    continue
                add_tool_calls(block.get("content"))
                add_results(block.get("results"))
        add_results(message.get("results"))
        add_results(message.get("tool_results"))

    return chat_ids, unresolved_tool_call_ids


def _collect_subagent_refs_from_chat(chat: Any) -> tuple[list[str], list[str]]:
    payload = _chat_payload_dict(chat)
    history = payload.get("history")
    history_messages = history.get("messages") if isinstance(history, dict) else None
    if isinstance(history_messages, (dict, list)):
        return _collect_subagent_refs_from_messages(history_messages)
    return _collect_subagent_refs_from_messages(payload.get("messages"))


def _resolve_subagent_tool_call_mappings(
    tool_call_ids: list[str], redis_client: Any
) -> dict[str, str]:
    if not tool_call_ids or not redis_client:
        return {}

    mapping_keys = [f"subagent_tool_call:{tool_call_id}" for tool_call_id in tool_call_ids]
    try:
        mapping_values = redis_client.mget(mapping_keys)
    except Exception:
        mapping_values = []
        for mapping_key in mapping_keys:
            try:
                mapping_values.append(redis_client.get(mapping_key))
            except Exception:
                mapping_values.append(None)

    mappings: dict[str, str] = {}
    for tool_call_id, mapping_value in zip(tool_call_ids, mapping_values):
        mapping = _parse_nested_json_object(mapping_value)
        chat_id = str(mapping.get("chat_id") or "").strip()
        if chat_id and not chat_id.startswith("local:"):
            mappings[tool_call_id] = chat_id
    return mappings


def _resolve_subagent_tool_call_ids(
    tool_call_ids: list[str], redis_client: Any
) -> list[str]:
    return list(
        dict.fromkeys(
            _resolve_subagent_tool_call_mappings(tool_call_ids, redis_client).values()
        )
    )


def _resolve_subagent_tool_calls_from_persisted_metadata(
    parent_chat_id: str,
    tool_call_ids: list[str],
    user: Any,
) -> dict[str, str]:
    """Recover expired Redis mappings from durable child-chat metadata."""
    unresolved = {str(tool_call_id or "").strip() for tool_call_id in tool_call_ids}
    unresolved.discard("")
    if not parent_chat_id or not unresolved:
        return {}

    mappings: dict[str, str] = {}
    for child_chat in _iter_recent_user_chat_records(SUBAGENT_SERVICE_USER_ID):
        metadata = _subagent_metadata_from_chat(child_chat)
        if str(metadata.get("parent_chat_id") or "").strip() != parent_chat_id:
            continue
        tool_call_id = str(metadata.get("parent_tool_call_id") or "").strip()
        child_chat_id = str(getattr(child_chat, "id", "") or "").strip()
        if tool_call_id not in unresolved or not child_chat_id:
            continue
        if not _get_read_authorized_chat(child_chat_id, user):
            continue
        mappings[tool_call_id] = child_chat_id
        unresolved.remove(tool_call_id)
        if not unresolved:
            break
    return mappings


def _extract_subagent_chat_stats(chat: Any) -> dict[str, Optional[int]]:
    payload = _chat_payload_dict(chat)
    history = payload.get("history")
    history_messages = history.get("messages") if isinstance(history, dict) else None
    if isinstance(history_messages, dict):
        messages = list(history_messages.values())
    elif isinstance(history_messages, list):
        messages = list(history_messages)
    elif isinstance(payload.get("messages"), list):
        messages = list(payload["messages"])
    else:
        messages = []

    tool_call_count = 0
    for message in messages:
        if not isinstance(message, dict):
            continue
        content_blocks = message.get("contentBlocks")
        if isinstance(content_blocks, list):
            for block in content_blocks:
                if not isinstance(block, dict) or block.get("type") != "tool_calls":
                    continue
                calls = block.get("content")
                tool_call_count += len(calls) if isinstance(calls, list) else int(bool(calls))
            continue
        calls = message.get("tool_calls")
        tool_call_count += len(calls) if isinstance(calls, list) else int(bool(calls))

    current_id = history.get("currentId") if isinstance(history, dict) else None
    current_message = (
        history_messages.get(current_id)
        if isinstance(history_messages, dict) and current_id
        else None
    )
    assistant_messages = [
        message
        for message in messages
        if isinstance(message, dict) and message.get("role") == "assistant"
    ]
    token_candidates = [current_message, *reversed(assistant_messages)]
    display_tokens = None
    seen_message_ids: set[int] = set()
    for message in token_candidates:
        if not isinstance(message, dict) or id(message) in seen_message_ids:
            continue
        seen_message_ids.add(id(message))
        usage = _parse_nested_json_object(message.get("usage"))
        total_tokens = _non_negative_int_or_none(usage.get("total_tokens"))
        if not total_tokens:
            prompt_tokens = _non_negative_int_or_none(usage.get("prompt_tokens")) or 0
            completion_tokens = _non_negative_int_or_none(usage.get("completion_tokens")) or 0
            total_tokens = prompt_tokens + completion_tokens
        if total_tokens > 0:
            display_tokens = total_tokens
            break

    return {
        "tool_call_count": tool_call_count,
        "display_tokens": display_tokens,
    }


def _get_authorized_subagent_descendants(
    root_chat: Any,
    user: Any,
    *,
    limit: int = SUBAGENT_DESCENDANT_LIMIT,
    redis_client: Any = None,
    tool_call_mappings: Optional[dict[str, str]] = None,
) -> tuple[list[str], bool]:
    """Walk a subagent workflow server-side without sending child payloads to the UI."""
    root_chat_id = str(getattr(root_chat, "id", "") or "").strip()
    visited = {root_chat_id} if root_chat_id else set()
    descendants: list[str] = []
    queue = [root_chat]
    truncated = False

    while queue:
        current_chat = queue.pop(0)
        embedded_ids, unresolved_tool_call_ids = _collect_subagent_refs_from_chat(current_chat)
        resolved_mappings = _resolve_subagent_tool_call_mappings(
            unresolved_tool_call_ids, redis_client
        )
        if tool_call_mappings:
            for tool_call_id in unresolved_tool_call_ids:
                mapped_chat_id = tool_call_mappings.get(tool_call_id)
                if mapped_chat_id:
                    resolved_mappings.setdefault(tool_call_id, mapped_chat_id)
        candidate_ids = [
            *embedded_ids,
            *resolved_mappings.values(),
        ]
        for candidate_id in candidate_ids:
            if not candidate_id or candidate_id in visited:
                continue
            if len(descendants) >= limit:
                truncated = True
                return descendants, truncated

            visited.add(candidate_id)
            child_chat = _get_read_authorized_chat(candidate_id, user)
            if not child_chat:
                continue
            descendants.append(candidate_id)
            queue.append(child_chat)

    return descendants, truncated


def _get_authorized_subagent_descendant_details(
    root_chat: Any,
    user: Any,
    *,
    limit: int = SUBAGENT_DESCENDANT_LIMIT,
    redis_client: Any = None,
) -> tuple[list[str], bool, dict[str, dict[str, Any]]]:
    root_chat_id = str(getattr(root_chat, "id", "") or "").strip()
    direct_details = _collect_subagent_tool_call_details_from_chat(root_chat)
    unresolved_tool_call_ids = [
        tool_call_id
        for tool_call_id, detail in direct_details.items()
        if not detail.get("chat_id")
    ]
    tool_call_mappings = _resolve_subagent_tool_call_mappings(
        unresolved_tool_call_ids, redis_client
    )
    still_unresolved = [
        tool_call_id
        for tool_call_id in unresolved_tool_call_ids
        if tool_call_id not in tool_call_mappings
    ]
    if still_unresolved:
        tool_call_mappings.update(
            _resolve_subagent_tool_calls_from_persisted_metadata(
                root_chat_id, still_unresolved, user
            )
        )

    for tool_call_id, chat_id in tool_call_mappings.items():
        if tool_call_id in direct_details:
            direct_details[tool_call_id]["chat_id"] = chat_id

    descendants, truncated = _get_authorized_subagent_descendants(
        root_chat,
        user,
        limit=limit,
        redis_client=redis_client,
        tool_call_mappings=tool_call_mappings,
    )
    authorized_descendant_ids = set(descendants)
    response_details: dict[str, dict[str, Any]] = {}
    for tool_call_id, detail in direct_details.items():
        chat_id = str(detail.get("chat_id") or "").strip()
        if not chat_id or chat_id not in authorized_descendant_ids:
            continue
        child_chat = _get_read_authorized_chat(chat_id, user)
        if not child_chat:
            continue
        child_stats = _extract_subagent_chat_stats(child_chat)
        response_details[tool_call_id] = {
            "chat_id": chat_id,
            "tool_call_count": (
                detail.get("tool_call_count")
                if detail.get("tool_call_count") is not None
                else child_stats["tool_call_count"]
            ),
            "display_tokens": (
                detail.get("display_tokens")
                if detail.get("display_tokens") is not None
                else child_stats["display_tokens"]
            ),
        }

    return descendants, truncated, response_details


def _build_chat_hydration_response(chat: Any) -> ChatResponse:
    """Build a load-optimized response without mutating the stored chat payload."""
    data = chat.model_dump()
    chat_payload = data.get("chat")
    if isinstance(chat_payload, dict):
        compact_payload = dict(chat_payload)
        history = compact_payload.get("history")
        if isinstance(history, dict) and history.get("messages") is not None:
            compact_payload.pop("messages", None)
        data["chat"] = compact_payload
    return ChatResponse(**data)


def _chat_contains_subagent_child_result(parent_chat, child_chat_id: str) -> bool:
    payload = _chat_payload_dict(parent_chat)
    history = payload.get("history")
    messages = []
    if isinstance(history, dict):
        history_messages = history.get("messages")
        if isinstance(history_messages, dict):
            messages.extend(history_messages.values())
        elif isinstance(history_messages, list):
            messages.extend(history_messages)
    payload_messages = payload.get("messages")
    if isinstance(payload_messages, list):
        messages.extend(payload_messages)

    for message in messages:
        if not isinstance(message, dict):
            continue
        content_blocks = message.get("contentBlocks")
        if isinstance(content_blocks, list):
            for block in content_blocks:
                if not isinstance(block, dict):
                    continue
                results = block.get("results")
                if isinstance(results, list) and any(
                    _result_references_subagent_child(result, child_chat_id)
                    for result in results
                ):
                    return True
        results = message.get("results")
        if isinstance(results, list) and any(
            _result_references_subagent_child(result, child_chat_id)
            for result in results
        ):
            return True
    return False


def _iter_recent_user_chat_records(user_id: str):
    try:
        result = Chats.get_chats_by_user_id(user_id)
    except Exception as error:
        log.debug("[SubagentAccess] Failed to list recent chats for %s: %s", user_id, error)
        return []

    items = getattr(result, "items", result)
    if not isinstance(items, list):
        return []
    return items[:SUBAGENT_PARENT_REPAIR_SCAN_LIMIT]


def _find_parent_chat_id_from_recent_results(child_chat_id: str, user_id: str) -> Optional[str]:
    for parent_chat in _iter_recent_user_chat_records(user_id):
        parent_chat_id = getattr(parent_chat, "id", None)
        if not parent_chat_id or parent_chat_id == child_chat_id:
            continue
        if _chat_contains_subagent_child_result(parent_chat, child_chat_id):
            return parent_chat_id
    return None


def _cache_subagent_parent_metadata(
    child_chat,
    *,
    parent_chat_id: str,
    root_parent_chat_id: Optional[str] = None,
    parent_tool_call_id: Optional[str] = None,
):
    payload = copy.deepcopy(_chat_payload_dict(child_chat))
    if not payload:
        return child_chat

    meta = payload.get("meta")
    if not isinstance(meta, dict):
        meta = {}
    subagent = meta.get("subagent")
    if not isinstance(subagent, dict):
        subagent = {}

    subagent["parent_chat_id"] = parent_chat_id
    subagent["root_parent_chat_id"] = root_parent_chat_id or parent_chat_id
    if parent_tool_call_id:
        subagent["parent_tool_call_id"] = parent_tool_call_id
    meta["subagent"] = subagent
    payload["meta"] = meta

    try:
        return Chats.update_chat_by_id(child_chat.id, payload) or child_chat
    except Exception as error:
        log.debug(
            "[SubagentAccess] Failed to cache parent metadata child_chat_id=%s parent_chat_id=%s: %s",
            getattr(child_chat, "id", None),
            parent_chat_id,
            error,
        )
        return child_chat


def _get_read_authorized_chat(chat_id: str, user):
    chat = Chats.get_chat_by_id_and_user_id(chat_id, user.id)
    if chat:
        return chat

    child = Chats.get_chat_by_id(chat_id)
    if not child:
        return None

    if getattr(user, "id", None) == SUBAGENT_SERVICE_USER_ID and _chat_is_trusted_scheduled_run(child):
        return child

    if getattr(child, "user_id", None) != SUBAGENT_SERVICE_USER_ID:
        return None

    if _chat_is_trusted_scheduled_run(child):
        return child

    child_metadata = _subagent_metadata_from_chat(child)
    parent_ids = _subagent_parent_ids_from_metadata(child_metadata)
    if any(_parent_chat_is_owned_by_user(parent_id, user.id) for parent_id in parent_ids):
        return child

    reverse_metadata = _read_subagent_reverse_metadata(chat_id)
    reverse_parent_ids = _subagent_parent_ids_from_metadata(reverse_metadata)
    for parent_id in reverse_parent_ids:
        if _parent_chat_is_owned_by_user(parent_id, user.id):
            immediate_parent_id = reverse_metadata.get("parent_chat_id")
            if not isinstance(immediate_parent_id, str) or not immediate_parent_id.strip():
                immediate_parent_id = parent_id
            root_parent_id = reverse_metadata.get("root_parent_chat_id")
            if not isinstance(root_parent_id, str) or not root_parent_id.strip():
                root_parent_id = parent_id
            parent_tool_call_id = reverse_metadata.get("parent_tool_call_id")
            if not isinstance(parent_tool_call_id, str) or not parent_tool_call_id.strip():
                parent_tool_call_id = None
            return _cache_subagent_parent_metadata(
                child,
                parent_chat_id=immediate_parent_id.strip(),
                root_parent_chat_id=root_parent_id.strip(),
                parent_tool_call_id=parent_tool_call_id.strip() if parent_tool_call_id else None,
            )

    repaired_parent_id = _find_parent_chat_id_from_recent_results(chat_id, user.id)
    if repaired_parent_id:
        return _cache_subagent_parent_metadata(
            child,
            parent_chat_id=repaired_parent_id,
            root_parent_chat_id=repaired_parent_id,
        )

    return None


def _get_read_authorized_chat_or_404(chat_id: str, user):
    chat = _get_read_authorized_chat(chat_id, user)
    if chat:
        return chat

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=ERROR_MESSAGES.NOT_FOUND,
    )


def _get_authorized_chat_or_404(chat_id: str, user):
    chat = Chats.get_chat_by_id_and_user_id(chat_id, user.id)
    if chat:
        return chat

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=ERROR_MESSAGES.NOT_FOUND,
    )


async def _emit_pending_work_update_for_chat(request: Request, chat, state: dict[str, Any]) -> None:
    try:
        await emit_pending_chat_work_updated(
            sio=sio,
            user_id=chat.user_id,
            chat_id=chat.id,
            state=state,
        )
    except Exception as error:
        log.warning(
            "[PendingChatWork] Failed to emit pending-work update for %s: %s",
            chat.id,
            error,
        )


@router.get("/{id}/pending-work")
async def get_chat_pending_work(id: str, request: Request, user=Depends(get_verified_user)):
    _get_authorized_chat_or_404(id, user)
    redis_client = _get_async_redis_client(request)
    state = await load_pending_chat_work_state(redis_client, id)
    return sanitize_pending_chat_work_state_for_client(state)


def _get_status_authorized_chat(chat_id: str, user):
    """Read-only twin of _get_queued_prompt_authorized_chat_and_actor: the
    subagents service principal may read any chat's status (cross-chat
    workflow orchestration needs busy/idle for peers it started); missing
    chats 404 — not 401 — so service-token clients do not treat a bad chat id
    as an auth failure and mint a fresh token. Humans stay owner-scoped."""
    if getattr(user, "id", None) == SUBAGENT_SERVICE_USER_ID:
        chat = Chats.get_chat_by_id(chat_id)
        if not chat:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=ERROR_MESSAGES.NOT_FOUND,
            )
        return chat

    return _get_authorized_chat_or_404(chat_id, user)


@router.get("/{id}/status")
async def get_chat_status(id: str, request: Request, user=Depends(get_verified_user)):
    """Busy/idle + basic info for a chat. Busy mirrors the pending-work
    drain's authoritative definition: a registered completion task for the
    chat OR a persisted current turn that has not reached a terminal state
    (covers the window where the task record is gone or not yet written)."""
    chat = _get_status_authorized_chat(id, user)
    redis_client = _get_async_redis_client(request)

    task_ids = []
    try:
        task_ids = await list_task_ids_by_item_id(redis_client, id)
    except Exception as error:
        log.warning("[ChatStatus] Failed to list tasks for %s: %s", id, error)
    task_ids = task_ids or []
    active_turn = chat_payload_has_active_current_turn(_chat_payload_dict(chat))

    pending_state = sanitize_pending_chat_work_state_for_client(
        await load_pending_chat_work_state(redis_client, id)
    )
    queued_prompts = pending_state.get("queued_prompts") or []

    model_id = getattr(chat, "model_id", None) or resolve_chat_model_id(
        _chat_payload_dict(chat)
    )

    return {
        "chat_id": chat.id,
        "busy": bool(task_ids) or active_turn,
        "task_count": len(task_ids),
        "active_turn": active_turn,
        "title": chat.title,
        "model_id": model_id,
        "updated_at": chat.updated_at,
        "queued_prompt_count": len(queued_prompts),
        "has_pending_steer": bool(pending_state.get("pending_steer")),
        "pending_work_updated_at": pending_state.get("updated_at"),
    }


@router.put("/{id}/pending-steer")
async def put_chat_pending_steer(
    id: str,
    form_data: PendingWorkMessageForm,
    request: Request,
    user=Depends(get_verified_user),
):
    chat = _get_authorized_chat_or_404(id, user)
    redis_client = _get_async_redis_client(request)
    state = await replace_pending_steer(
        redis_client,
        id,
        prompt=form_data.prompt,
        files=form_data.files,
        request_context=(form_data.request_context.model_dump() if form_data.request_context else {}),
        item_id=form_data.id,
        status=form_data.status or "active",
    )
    await _emit_pending_work_update_for_chat(request, chat, state)
    schedule_pending_chat_work_drain(request=request, user=user, chat_id=id, sio=sio)
    return sanitize_pending_chat_work_state_for_client(state)


@router.patch("/{id}/pending-steer")
async def patch_chat_pending_steer(
    id: str,
    form_data: PendingWorkMessageForm,
    request: Request,
    user=Depends(get_verified_user),
):
    chat = _get_authorized_chat_or_404(id, user)
    if not form_data.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="pending steer id is required",
        )

    patch = {
        "prompt": form_data.prompt,
        "files": form_data.files,
    }
    if form_data.request_context is not None:
        patch["request_context"] = form_data.request_context.model_dump()
    if form_data.status:
        patch["status"] = form_data.status

    redis_client = _get_async_redis_client(request)
    state = await update_pending_steer(
        redis_client,
        id,
        item_id=form_data.id,
        patch=patch,
    )
    await _emit_pending_work_update_for_chat(request, chat, state)
    schedule_pending_chat_work_drain(request=request, user=user, chat_id=id, sio=sio)
    return sanitize_pending_chat_work_state_for_client(state)


@router.delete("/{id}/pending-steer")
async def remove_chat_pending_steer(
    id: str,
    request: Request,
    item_id: Optional[str] = None,
    user=Depends(get_verified_user),
):
    chat = _get_authorized_chat_or_404(id, user)
    redis_client = _get_async_redis_client(request)
    state = await delete_pending_steer(redis_client, id, item_id=item_id)
    await _emit_pending_work_update_for_chat(request, chat, state)
    schedule_pending_chat_work_drain(request=request, user=user, chat_id=id, sio=sio)
    return sanitize_pending_chat_work_state_for_client(state)


def _get_queued_prompt_authorized_chat_and_actor(chat_id: str, user):
    """Resolve the target chat and the user the queued work should run as.

    The subagents service principal may queue prompts into any chat
    (cross-chat message delivery). The pending-work drain must then run as
    the chat OWNER: dispatch re-fetches the chat by owner id and the
    completion has to execute with the owner's identity.
    """
    if getattr(user, "id", None) == SUBAGENT_SERVICE_USER_ID:
        chat = Chats.get_chat_by_id(chat_id)
        if not chat:
            # 404 (not the owner path's 401) so service-token clients do not
            # treat a bad chat id as an auth failure and mint a fresh token.
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=ERROR_MESSAGES.NOT_FOUND,
            )
        if getattr(chat, "user_id", None) == user.id:
            return chat, user
        acting_user = Users.get_user_by_id(chat.user_id)
        if not acting_user:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=ERROR_MESSAGES.NOT_FOUND,
            )
        return chat, acting_user

    return _get_authorized_chat_or_404(chat_id, user), user


def _queued_prompt_request_context(chat, form_data, user) -> dict[str, Any]:
    request_context = (
        form_data.request_context.model_dump() if form_data.request_context else {}
    )
    # Service callers (cross-chat message delivery) cannot know the target
    # chat's model, but dispatch skips items without selected_model_ids —
    # default to the model currently driving the target chat so the reply
    # always comes from that chat's own model or agent.
    if (
        getattr(user, "id", None) == SUBAGENT_SERVICE_USER_ID
        and not request_context.get("selected_model_ids")
    ):
        model_id = getattr(chat, "model_id", None) or resolve_chat_model_id(
            _chat_payload_dict(chat)
        )
        if model_id:
            request_context["selected_model_ids"] = [model_id]
    return request_context


@router.post("/{id}/queued-prompts")
async def post_chat_queued_prompt(
    id: str,
    form_data: PendingWorkMessageForm,
    request: Request,
    user=Depends(get_verified_user),
):
    chat, acting_user = _get_queued_prompt_authorized_chat_and_actor(id, user)
    redis_client = _get_async_redis_client(request)
    state = await append_queued_prompt(
        redis_client,
        id,
        prompt=form_data.prompt,
        files=form_data.files,
        request_context=_queued_prompt_request_context(chat, form_data, user),
        item_id=form_data.id,
        status=form_data.status or "queued",
    )
    await _emit_pending_work_update_for_chat(request, chat, state)
    schedule_pending_chat_work_drain(request=request, user=acting_user, chat_id=id, sio=sio)
    return sanitize_pending_chat_work_state_for_client(state)


@router.patch("/{id}/queued-prompts/{item_id}")
async def patch_chat_queued_prompt(
    id: str,
    item_id: str,
    form_data: PendingWorkMessageForm,
    request: Request,
    user=Depends(get_verified_user),
):
    chat = _get_authorized_chat_or_404(id, user)
    redis_client = _get_async_redis_client(request)
    patch = {
        "prompt": form_data.prompt,
        "files": form_data.files,
    }
    if form_data.request_context is not None:
        patch["request_context"] = form_data.request_context.model_dump()
    if form_data.status:
        patch["status"] = form_data.status
    state = await update_queued_prompt(redis_client, id, item_id=item_id, patch=patch)
    await _emit_pending_work_update_for_chat(request, chat, state)
    schedule_pending_chat_work_drain(request=request, user=user, chat_id=id, sio=sio)
    return sanitize_pending_chat_work_state_for_client(state)


@router.delete("/{id}/queued-prompts/{item_id}")
async def delete_chat_queued_prompt(
    id: str,
    item_id: str,
    request: Request,
    user=Depends(get_verified_user),
):
    chat = _get_authorized_chat_or_404(id, user)
    redis_client = _get_async_redis_client(request)
    state = await delete_queued_prompt(redis_client, id, item_id=item_id)
    await _emit_pending_work_update_for_chat(request, chat, state)
    schedule_pending_chat_work_drain(request=request, user=user, chat_id=id, sio=sio)
    return sanitize_pending_chat_work_state_for_client(state)


############################
# DeleteAllChats
############################


@router.delete("/", response_model=bool)
async def delete_all_user_chats(request: Request, user=Depends(get_verified_user)):

    if user.role == "user" and not has_permission(
        user.id, "chat.delete", request.app.state.config.USER_PERMISSIONS
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=ERROR_MESSAGES.ACCESS_PROHIBITED,
        )

    result = Chats.delete_chats_by_user_id(user.id)
    return result


############################
# GetUserChatList
############################


@router.get("/list/user/{user_id}", response_model=list[ChatTitleIdResponse])
async def get_user_chat_list_by_user_id(
    user_id: str,
    page: Optional[int] = None,
    query: Optional[str] = None,
    order_by: Optional[str] = None,
    direction: Optional[str] = None,
    user=Depends(get_admin_user),
):
    if not ENABLE_ADMIN_CHAT_ACCESS:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=ERROR_MESSAGES.ACCESS_PROHIBITED,
        )

    if page is None:
        page = 1

    limit = 60
    skip = (page - 1) * limit

    filter = {}
    if query:
        filter["query"] = query
    if order_by:
        filter["order_by"] = order_by
    if direction:
        filter["direction"] = direction

    return Chats.get_chat_list_by_user_id(
        user_id, include_archived=True, filter=filter, skip=skip, limit=limit
    )


############################
# CreateNewChat
############################


@router.post("/new", response_model=Optional[ChatResponse])
async def create_new_chat(form_data: ChatForm, user=Depends(get_verified_user)):
    try:
        target_user_id, form_data, scheduled_trusted = _scheduled_chat_target_for_create(
            form_data, user
        )
        if not scheduled_trusted:
            target_user_id, form_data = _delegated_human_chat_target_for_create(
                form_data, user
            )
        multi_chat_start = (
            None if scheduled_trusted else _validate_multi_chat_start(form_data, user)
        )
        chat = Chats.insert_new_chat(target_user_id, form_data)
        if scheduled_trusted:
            _mark_scheduled_chat_trusted(chat.id)
            chat = Chats.get_chat_by_id(chat.id) or chat
        if multi_chat_start:
            root_chat_id, display_name = multi_chat_start
            pane = _register_multi_chat_pane(root_chat_id, chat.id, display_name)
            if pane:
                chat = Chats.get_chat_by_id(chat.id) or chat
                try:
                    await emit_multi_chat_pane_added(
                        sio=sio,
                        user_id=target_user_id,
                        root_chat_id=root_chat_id,
                        pane=pane,
                    )
                except Exception as emit_error:
                    log.warning(
                        "[MultiChat] Failed to emit pane-added event: %s", emit_error
                    )
        return ChatResponse(**chat.model_dump())
    except HTTPException:
        # Structured policy errors (e.g. multi-chat tiling codes) must reach
        # the caller verbatim, not be flattened into the generic 400 below.
        raise
    except Exception as e:
        log.exception(e)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=ERROR_MESSAGES.DEFAULT()
        )


############################
# ImportChats
############################


@router.post("/import", response_model=list[ChatResponse])
async def import_chats(form_data: ChatsImportForm, user=Depends(get_verified_user)):
    try:
        chats = Chats.import_chats(user.id, form_data.chats)
        sync_imported_chats_to_search(chats, user.id)
        return chats
    except Exception as e:
        log.exception(e)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=ERROR_MESSAGES.DEFAULT()
        )


############################
# GetChats
############################


@router.get("/search", response_model=list[ChatTitleIdResponse])
def search_user_chats(
    text: str,
    page: Optional[int] = None,
    updated_since: Optional[float] = None,
    user=Depends(get_verified_user),
):
    if page is None:
        page = 1

    limit = 60
    skip = (page - 1) * limit

    raw_chats = Chats.get_chats_by_user_id_and_search_text(
        user.id, text, skip=skip, limit=limit
    )

    if updated_since is not None:
        raw_chats = [
            chat
            for chat in raw_chats
            if (getattr(chat, "updated_at", 0) or 0) >= updated_since
        ]

    chat_list = [ChatTitleIdResponse(**chat.model_dump()) for chat in raw_chats]

    # Delete tag if no chat is found
    words = text.strip().split(" ")
    if page == 1 and len(words) == 1 and words[0].startswith("tag:"):
        tag_id = words[0].replace("tag:", "")
        if len(chat_list) == 0:
            if Tags.get_tag_by_name_and_user_id(tag_id, user.id):
                log.debug(f"deleting tag: {tag_id}")
                Tags.delete_tag_by_name_and_user_id(tag_id, user.id)

    return chat_list


############################
# PORTICO PATCH: Message-Level Search
############################


class MessageMatch(BaseModel):
    message_id: str
    role: str
    snippet: str
    timestamp: float


class ChatMessageSearchResult(BaseModel):
    chat_id: str
    title: str
    title_html: str = ""
    updated_at: float
    model_id: Optional[str] = None
    title_matched: bool = False
    match_count: int
    matches: list[MessageMatch]


class MessageSearchIndexStatus(BaseModel):
    state: str
    partial: bool
    indexed_chats: int
    total_chats: int
    indexed_messages: int
    last_error: Optional[str] = None


class MessageSearchResponse(BaseModel):
    results: list[ChatMessageSearchResult]
    has_more: bool
    next_cursor: Optional[str] = None
    index_status: MessageSearchIndexStatus
    regex_budget_exhausted: bool = False


@router.get("/search/messages", response_model=MessageSearchResponse)
def search_user_chat_messages(
    text: str,
    cursor: Optional[str] = None,
    size: Optional[int] = None,
    role: Optional[str] = None,
    updated_since: Optional[float] = None,
    case_sensitive: Optional[bool] = False,
    regex: Optional[bool] = False,
    user=Depends(get_verified_user),
):
    """Search across chat titles and message bodies."""
    from open_webui.utils.chat_search import search_messages

    try:
        result = search_messages(
            user_id=user.id,
            query=text,
            page_size=size or 10,
            cursor=cursor,
            role=role,
            updated_since=updated_since,
            case_sensitive=case_sensitive or False,
            regex=regex or False,
        )
        search_results = result["results"]
        return MessageSearchResponse(
            results=[
                ChatMessageSearchResult(**search_result)
                for search_result in search_results
            ],
            has_more=result["has_more"],
            next_cursor=result.get("next_cursor"),
            index_status=MessageSearchIndexStatus(**result["index_status"]),
            regex_budget_exhausted=result.get("regex_budget_exhausted", False),
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        ) from e
    except Exception as e:
        log.exception("[MessageSearch] Failed to search messages")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Search is temporarily unavailable. Please retry.",
        )


############################
# GetChatsByFolderId
############################


@router.get("/folder/{folder_id}", response_model=list[ChatResponse])
async def get_chats_by_folder_id(folder_id: str, user=Depends(get_verified_user)):
    folder_ids = [folder_id]
    children_folders = Folders.get_children_folders_by_id_and_user_id(
        folder_id, user.id
    )
    if children_folders:
        folder_ids.extend([folder.id for folder in children_folders])

    return [
        ChatResponse(**chat.model_dump())
        for chat in Chats.get_chats_by_folder_ids_and_user_id(folder_ids, user.id)
    ]


@router.get("/folder/{folder_id}/list", response_model=list[SidebarChatTitleIdResponse])
async def get_chat_list_by_folder_id(
    folder_id: str, page: Optional[int] = 1, user=Depends(get_verified_user)
):
    try:
        limit = 10
        skip = (page - 1) * limit

        return _sidebar_chat_rows(
            Chats.get_chats_by_folder_id_and_user_id(
                folder_id, user.id, skip=skip, limit=limit
            ),
            user.id,
        )

    except Exception as e:
        log.exception(e)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=ERROR_MESSAGES.DEFAULT()
        )


############################
# GetPinnedChats
############################


@router.get("/pinned", response_model=list[SidebarChatTitleIdResponse])
async def get_user_pinned_chats(user=Depends(get_verified_user)):
    return _sidebar_chat_rows(Chats.get_pinned_chats_by_user_id(user.id), user.id)


############################
# GetChats
############################


@router.get("/all", response_model=list[ChatResponse])
async def get_user_chats(user=Depends(get_verified_user)):
    try:
        result = Chats.get_chats_by_user_id(user.id)
        return [ChatResponse(**chat.model_dump()) for chat in result.items]
    except Exception as e:
        log.exception(e)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=ERROR_MESSAGES.DEFAULT()
        )


############################
# GetArchivedChats
############################


@router.get("/all/archived", response_model=list[ChatResponse])
async def get_user_archived_chats(user=Depends(get_verified_user)):
    return [
        ChatResponse(**chat.model_dump())
        for chat in Chats.get_archived_chats_by_user_id(user.id)
    ]


############################
# GetAllTags
############################


@router.get("/all/tags", response_model=list[TagModel])
async def get_all_user_tags(user=Depends(get_verified_user)):
    try:
        tags = Tags.get_tags_by_user_id(user.id)
        return tags
    except Exception as e:
        log.exception(e)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=ERROR_MESSAGES.DEFAULT()
        )


############################
# GetAllChatsInDB
############################


@router.get("/all/db", response_model=list[ChatResponse])
async def get_all_user_chats_in_db(user=Depends(get_admin_user)):
    if not ENABLE_ADMIN_EXPORT:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=ERROR_MESSAGES.ACCESS_PROHIBITED,
        )
    return [ChatResponse(**chat.model_dump()) for chat in Chats.get_chats()]


############################
# GetArchivedChats
############################


@router.get("/archived", response_model=list[ChatTitleIdResponse])
async def get_archived_session_user_chat_list(
    page: Optional[int] = None,
    query: Optional[str] = None,
    order_by: Optional[str] = None,
    direction: Optional[str] = None,
    user=Depends(get_verified_user),
):
    if page is None:
        page = 1

    limit = 60
    skip = (page - 1) * limit

    filter = {}
    if query:
        filter["query"] = query
    if order_by:
        filter["order_by"] = order_by
    if direction:
        filter["direction"] = direction

    chat_list = [
        ChatTitleIdResponse(**chat.model_dump())
        for chat in Chats.get_archived_chat_list_by_user_id(
            user.id,
            filter=filter,
            skip=skip,
            limit=limit,
        )
    ]

    return chat_list


############################
# ArchiveAllChats
############################


@router.post("/archive/all", response_model=bool)
async def archive_all_chats(user=Depends(get_verified_user)):
    return Chats.archive_all_chats_by_user_id(user.id)


############################
# UnarchiveAllChats
############################


@router.post("/unarchive/all", response_model=bool)
async def unarchive_all_chats(user=Depends(get_verified_user)):
    return Chats.unarchive_all_chats_by_user_id(user.id)


############################
# GetSharedChatById
############################


@router.get("/share/{share_id}", response_model=Optional[ChatResponse])
async def get_shared_chat_by_id(share_id: str, user=Depends(get_verified_user)):
    if user.role == "pending":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail=ERROR_MESSAGES.NOT_FOUND
        )

    if user.role == "user" or (user.role == "admin" and not ENABLE_ADMIN_CHAT_ACCESS):
        chat = Chats.get_chat_by_share_id(share_id)
    elif user.role == "admin" and ENABLE_ADMIN_CHAT_ACCESS:
        chat = Chats.get_chat_by_id(share_id)

    if chat:
        return ChatResponse(**chat.model_dump())

    else:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail=ERROR_MESSAGES.NOT_FOUND
        )


############################
# GetChatsByTags
############################


class TagForm(BaseModel):
    name: str


class TagFilterForm(TagForm):
    skip: Optional[int] = 0
    limit: Optional[int] = 50


@router.post("/tags", response_model=list[ChatTitleIdResponse])
async def get_user_chat_list_by_tag_name(
    form_data: TagFilterForm, user=Depends(get_verified_user)
):
    chats = Chats.get_chat_list_by_user_id_and_tag_name(
        user.id, form_data.name, form_data.skip, form_data.limit
    )
    if len(chats) == 0:
        Tags.delete_tag_by_name_and_user_id(form_data.name, user.id)

    return chats


############################
# GetChatById
############################


class SubagentToolCallDetailResponse(BaseModel):
    chat_id: str
    tool_call_count: Optional[int] = None
    display_tokens: Optional[int] = None


class SubagentDescendantsResponse(BaseModel):
    chat_ids: list[str] = Field(default_factory=list)
    truncated: bool = False
    tool_calls: dict[str, SubagentToolCallDetailResponse] = Field(default_factory=dict)


@router.get("/{id}/hydrate", response_model=Optional[ChatResponse])
async def hydrate_chat_by_id(id: str, user=Depends(get_verified_user)):
    chat = _get_read_authorized_chat_or_404(id, user)
    return _build_chat_hydration_response(chat)


@router.get("/{id}/subagent-descendants", response_model=SubagentDescendantsResponse)
async def get_subagent_descendants(id: str, user=Depends(get_verified_user)):
    root_chat = _get_read_authorized_chat_or_404(id, user)
    chat_ids, truncated, tool_calls = _get_authorized_subagent_descendant_details(
        root_chat,
        user,
        redis_client=_get_redis_client(),
    )
    return SubagentDescendantsResponse(
        chat_ids=chat_ids,
        truncated=truncated,
        tool_calls=tool_calls,
    )


@router.get("/{id}", response_model=Optional[ChatResponse])
async def get_chat_by_id(id: str, user=Depends(get_verified_user)):
    chat = _get_read_authorized_chat_or_404(id, user)
    return ChatResponse(**chat.model_dump())


############################
# UpdateChatById
############################


@router.post("/{id}", response_model=Optional[ChatResponse])
async def update_chat_by_id(
    id: str, form_data: ChatForm, user=Depends(get_verified_user)
):
    chat = Chats.get_chat_by_id_and_user_id(id, user.id)
    if chat:
        updated_chat, stale_save_detected = merge_whole_chat_save_with_existing_chat(
            chat.chat,
            form_data.chat,
        )
        if stale_save_detected:
            log.info(
                "[ChatSave] Preserved backend-only newer messages during stale whole-chat save chat_id=%s user_id=%s",
                id,
                user.id,
            )

        updated_chat = _preserve_trusted_scheduled_metadata_on_save(chat, updated_chat)
        chat = Chats.update_chat_by_id(id, updated_chat)
        sync_chat_to_search(id, user.id, updated_chat)
        return ChatResponse(**chat.model_dump())
    else:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=ERROR_MESSAGES.ACCESS_PROHIBITED,
        )


############################
# UpdateChatMessageById
############################
class MessageForm(BaseModel):
    content: str


@router.post("/{id}/messages/{message_id}", response_model=Optional[ChatResponse])
async def update_chat_message_by_id(
    id: str, message_id: str, form_data: MessageForm, user=Depends(get_verified_user)
):
    chat = Chats.get_chat_by_id(id)

    if not chat:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=ERROR_MESSAGES.ACCESS_PROHIBITED,
        )

    if chat.user_id != user.id and user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=ERROR_MESSAGES.ACCESS_PROHIBITED,
        )

    chat = Chats.upsert_message_to_chat_by_id_and_message_id(
        id,
        message_id,
        {
            "content": form_data.content,
        },
    )

    event_emitter = get_event_emitter(
        {
            "user_id": user.id,
            "chat_id": id,
            "message_id": message_id,
        },
        False,
    )

    if event_emitter:
        await event_emitter(
            {
                "type": "chat:message",
                "data": {
                    "chat_id": id,
                    "message_id": message_id,
                    "content": form_data.content,
                },
            }
        )

    sync_chat_to_search(id, user.id, chat.chat if isinstance(chat.chat, dict) else {})
    return ChatResponse(**chat.model_dump())


############################
# SendChatMessageEventById
############################
class EventForm(BaseModel):
    type: str
    data: dict


@router.post("/{id}/messages/{message_id}/event", response_model=Optional[bool])
async def send_chat_message_event_by_id(
    id: str, message_id: str, form_data: EventForm, user=Depends(get_verified_user)
):
    chat = Chats.get_chat_by_id(id)

    if not chat:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=ERROR_MESSAGES.ACCESS_PROHIBITED,
        )

    if chat.user_id != user.id and user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=ERROR_MESSAGES.ACCESS_PROHIBITED,
        )

    event_emitter = get_event_emitter(
        {
            "user_id": user.id,
            "chat_id": id,
            "message_id": message_id,
        }
    )

    try:
        if event_emitter:
            await event_emitter(form_data.model_dump())
        else:
            return False
        return True
    except:
        return False


############################
# CancelRateLimitRetry
############################
@router.post("/{id}/messages/{message_id}/rate-limit/cancel", response_model=bool)
async def cancel_rate_limit_retry(
    id: str, message_id: str, user=Depends(get_verified_user)
):
    chat = Chats.get_chat_by_id(id)

    if not chat:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=ERROR_MESSAGES.ACCESS_PROHIBITED,
        )

    if chat.user_id != user.id and user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=ERROR_MESSAGES.ACCESS_PROHIBITED,
        )

    cancel_key = build_rate_limit_cancel_key(user.id, id, message_id)
    if not cancel_key:
        return False

    canceled = await request_rate_limit_cancel(cancel_key)
    if canceled:
        log.info(
            "[RateLimitCancel] Cancel requested for chat %s message %s",
            id,
            message_id,
        )
    else:
        log.info(
            "[RateLimitCancel] No active retry to cancel for chat %s message %s",
            id,
            message_id,
        )
    return canceled


############################
# DeleteChatById
############################


@router.delete("/{id}", response_model=bool)
async def delete_chat_by_id(request: Request, id: str, user=Depends(get_verified_user)):
    if user.role == "admin":
        chat = Chats.get_chat_by_id(id)
        for tag in chat.meta.get("tags", []):
            if Chats.count_chats_by_tag_name_and_user_id(tag, user.id) == 1:
                Tags.delete_tag_by_name_and_user_id(tag, user.id)

        result = Chats.delete_chat_by_id(id)
        delete_chat_from_search(id)

        return result
    else:
        if not has_permission(
            user.id, "chat.delete", request.app.state.config.USER_PERMISSIONS
        ):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=ERROR_MESSAGES.ACCESS_PROHIBITED,
            )

        chat = Chats.get_chat_by_id(id)
        for tag in chat.meta.get("tags", []):
            if Chats.count_chats_by_tag_name_and_user_id(tag, user.id) == 1:
                Tags.delete_tag_by_name_and_user_id(tag, user.id)

        result = Chats.delete_chat_by_id_and_user_id(id, user.id)
        delete_chat_from_search(id)
        return result


############################
# GetPinnedStatusById
############################


@router.get("/{id}/pinned", response_model=Optional[bool])
async def get_pinned_status_by_id(id: str, user=Depends(get_verified_user)):
    chat = Chats.get_chat_by_id_and_user_id(id, user.id)
    if chat:
        return chat.pinned
    else:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail=ERROR_MESSAGES.DEFAULT()
        )


############################
# PinChatById
############################


@router.post("/{id}/pin", response_model=Optional[ChatResponse])
async def pin_chat_by_id(id: str, user=Depends(get_verified_user)):
    chat = Chats.get_chat_by_id_and_user_id(id, user.id)
    if chat:
        chat = Chats.toggle_chat_pinned_by_id(id)
        return chat
    else:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail=ERROR_MESSAGES.DEFAULT()
        )


############################
# CloneChat
############################


class CloneForm(BaseModel):
    title: Optional[str] = None


@router.post("/{id}/clone", response_model=Optional[ChatResponse])
async def clone_chat_by_id(
    form_data: CloneForm, id: str, user=Depends(get_verified_user)
):
    chat = Chats.get_chat_by_id_and_user_id(id, user.id)
    if chat:
        updated_chat = {
            **chat.chat,
            "originalChatId": chat.id,
            "branchPointMessageId": chat.chat["history"]["currentId"],
            "title": form_data.title if form_data.title else f"Clone of {chat.title}",
        }

        chats = Chats.import_chats(
            user.id,
            [
                ChatImportForm(
                    **{
                        "chat": updated_chat,
                        "meta": chat.meta,
                        "pinned": chat.pinned,
                        "folder_id": chat.folder_id,
                    }
                )
            ],
        )
        sync_imported_chats_to_search(chats, user.id)

        if chats:
            chat = chats[0]
            return ChatResponse(**chat.model_dump())
        else:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=ERROR_MESSAGES.DEFAULT(),
            )
    else:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail=ERROR_MESSAGES.DEFAULT()
        )


############################
# CloneSharedChatById
############################


@router.post("/{id}/clone/shared", response_model=Optional[ChatResponse])
async def clone_shared_chat_by_id(id: str, user=Depends(get_verified_user)):

    if user.role == "admin":
        chat = Chats.get_chat_by_id(id)
    else:
        chat = Chats.get_chat_by_share_id(id)

    if chat:
        updated_chat = {
            **chat.chat,
            "originalChatId": chat.id,
            "branchPointMessageId": chat.chat["history"]["currentId"],
            "title": f"Clone of {chat.title}",
        }

        chats = Chats.import_chats(
            user.id,
            [
                ChatImportForm(
                    **{
                        "chat": updated_chat,
                        "meta": chat.meta,
                        "pinned": chat.pinned,
                        "folder_id": chat.folder_id,
                    }
                )
            ],
        )
        sync_imported_chats_to_search(chats, user.id)

        if chats:
            chat = chats[0]
            return ChatResponse(**chat.model_dump())
        else:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=ERROR_MESSAGES.DEFAULT(),
            )
    else:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail=ERROR_MESSAGES.DEFAULT()
        )


############################
# ArchiveChat
############################


def _set_chat_archived_by_id_and_user_id(
    id: str, user_id: str, archived: bool
):
    """Set an exact archive state so retries cannot toggle a chat back."""
    with get_db() as db:
        chat_item = db.get(Chat, id)
        if chat_item is None or chat_item.user_id != user_id:
            return None

        needs_update = chat_item.archived != archived or (
            archived and chat_item.folder_id is not None
        )
        if needs_update:
            chat_item.archived = archived
            if archived:
                chat_item.folder_id = None
            chat_item.updated_at = int(time.time())
            db.commit()

    return Chats.get_chat_by_id_and_user_id(id, user_id)


@router.post("/{id}/archive", response_model=Optional[ChatResponse])
async def archive_chat_by_id(
    id: str, archived: Optional[bool] = None, user=Depends(get_verified_user)
):
    chat = Chats.get_chat_by_id_and_user_id(id, user.id)
    if chat:
        chat = (
            Chats.toggle_chat_archive_by_id(id)
            if archived is None
            else _set_chat_archived_by_id_and_user_id(id, user.id, archived)
        )
        if chat is None:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=ERROR_MESSAGES.DEFAULT(),
            )

        # Delete tags if chat is archived
        if chat.archived:
            for tag_id in chat.meta.get("tags", []):
                if Chats.count_chats_by_tag_name_and_user_id(tag_id, user.id) == 0:
                    log.debug(f"deleting tag: {tag_id}")
                    Tags.delete_tag_by_name_and_user_id(tag_id, user.id)
        else:
            for tag_id in chat.meta.get("tags", []):
                tag = Tags.get_tag_by_name_and_user_id(tag_id, user.id)
                if tag is None:
                    log.debug(f"inserting tag: {tag_id}")
                    tag = Tags.insert_new_tag(tag_id, user.id)

        return ChatResponse(**chat.model_dump())
    else:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail=ERROR_MESSAGES.DEFAULT()
        )


############################
# ShareChatById
############################


@router.post("/{id}/share", response_model=Optional[ChatResponse])
async def share_chat_by_id(request: Request, id: str, user=Depends(get_verified_user)):
    if (user.role != "admin") and (
        not has_permission(
            user.id, "chat.share", request.app.state.config.USER_PERMISSIONS
        )
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=ERROR_MESSAGES.ACCESS_PROHIBITED,
        )

    chat = Chats.get_chat_by_id_and_user_id(id, user.id)

    if chat:
        if chat.share_id:
            shared_chat = Chats.update_shared_chat_by_chat_id(chat.id)
            return ChatResponse(**shared_chat.model_dump())

        shared_chat = Chats.insert_shared_chat_by_chat_id(chat.id)
        if not shared_chat:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=ERROR_MESSAGES.DEFAULT(),
            )
        return ChatResponse(**shared_chat.model_dump())

    else:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=ERROR_MESSAGES.ACCESS_PROHIBITED,
        )


############################
# DeletedSharedChatById
############################


@router.delete("/{id}/share", response_model=Optional[bool])
async def delete_shared_chat_by_id(id: str, user=Depends(get_verified_user)):
    chat = Chats.get_chat_by_id_and_user_id(id, user.id)
    if chat:
        if not chat.share_id:
            return False

        result = Chats.delete_shared_chat_by_chat_id(id)
        update_result = Chats.update_chat_share_id_by_id(id, None)

        return result and update_result != None
    else:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=ERROR_MESSAGES.ACCESS_PROHIBITED,
        )


############################
# UpdateChatFolderIdById
############################


class ChatFolderIdForm(BaseModel):
    folder_id: Optional[str] = None


@router.post("/{id}/folder", response_model=Optional[ChatResponse])
async def update_chat_folder_id_by_id(
    id: str, form_data: ChatFolderIdForm, user=Depends(get_verified_user)
):
    chat = Chats.get_chat_by_id_and_user_id(id, user.id)
    if chat:
        chat = Chats.update_chat_folder_id_by_id_and_user_id(
            id, user.id, form_data.folder_id
        )
        return ChatResponse(**chat.model_dump())
    else:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail=ERROR_MESSAGES.DEFAULT()
        )


############################
# GetChatTagsById
############################


@router.get("/{id}/tags", response_model=list[TagModel])
async def get_chat_tags_by_id(id: str, user=Depends(get_verified_user)):
    chat = _get_read_authorized_chat_or_404(id, user)
    tags = chat.meta.get("tags", []) if isinstance(chat.meta, dict) else []
    return Tags.get_tags_by_ids_and_user_id(tags, user.id)


############################
# AddChatTagById
############################


@router.post("/{id}/tags", response_model=list[TagModel])
async def add_tag_by_id_and_tag_name(
    id: str, form_data: TagForm, user=Depends(get_verified_user)
):
    chat = Chats.get_chat_by_id_and_user_id(id, user.id)
    if chat:
        tags = chat.meta.get("tags", [])
        tag_id = form_data.name.replace(" ", "_").lower()

        if tag_id == "none":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=ERROR_MESSAGES.DEFAULT("Tag name cannot be 'None'"),
            )

        if tag_id not in tags:
            Chats.add_chat_tag_by_id_and_user_id_and_tag_name(
                id, user.id, form_data.name
            )

        chat = Chats.get_chat_by_id_and_user_id(id, user.id)
        tags = chat.meta.get("tags", [])
        return Tags.get_tags_by_ids_and_user_id(tags, user.id)
    else:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail=ERROR_MESSAGES.DEFAULT()
        )


############################
# DeleteChatTagById
############################


@router.delete("/{id}/tags", response_model=list[TagModel])
async def delete_tag_by_id_and_tag_name(
    id: str, form_data: TagForm, user=Depends(get_verified_user)
):
    chat = Chats.get_chat_by_id_and_user_id(id, user.id)
    if chat:
        Chats.delete_tag_by_id_and_user_id_and_tag_name(id, user.id, form_data.name)

        if Chats.count_chats_by_tag_name_and_user_id(form_data.name, user.id) == 0:
            Tags.delete_tag_by_name_and_user_id(form_data.name, user.id)

        chat = Chats.get_chat_by_id_and_user_id(id, user.id)
        tags = chat.meta.get("tags", [])
        return Tags.get_tags_by_ids_and_user_id(tags, user.id)
    else:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail=ERROR_MESSAGES.NOT_FOUND
        )


############################
# DeleteAllTagsById
############################


@router.delete("/{id}/tags/all", response_model=Optional[bool])
async def delete_all_tags_by_id(id: str, user=Depends(get_verified_user)):
    chat = Chats.get_chat_by_id_and_user_id(id, user.id)
    if chat:
        Chats.delete_all_tags_by_id_and_user_id(id, user.id)

        for tag in chat.meta.get("tags", []):
            if Chats.count_chats_by_tag_name_and_user_id(tag, user.id) == 0:
                Tags.delete_tag_by_name_and_user_id(tag, user.id)

        return True
    else:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail=ERROR_MESSAGES.NOT_FOUND
        )
