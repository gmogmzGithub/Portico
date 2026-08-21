"""
title: Unified Context Filter
author: dsantiago
description: Consolidates context injection into stable and dynamic system messages: session info, time, VM, tools, and skills.
version: 1.0.0
required_open_webui_version: 0.6.4
"""

import asyncio
import datetime
import json
import logging
import os
import sys
import time
import html
import uuid
from typing import Callable, Awaitable, Any, Optional, Sequence
from contextlib import contextmanager, nullcontext

from pydantic import BaseModel, Field

# Optional dependencies with graceful fallbacks
try:
    import redis
    REDIS_AVAILABLE = True
except ImportError:
    REDIS_AVAILABLE = False

try:
    import httpx
    HTTPX_AVAILABLE = True
except ImportError:
    HTTPX_AVAILABLE = False

try:
    import yaml
    YAML_AVAILABLE = True
except ImportError:
    YAML_AVAILABLE = False

# Add src directory to path for imports
CONTAINER_SRC_DIR = "/app/src"
if CONTAINER_SRC_DIR not in sys.path:
    sys.path.insert(0, CONTAINER_SRC_DIR)

# Import event publisher for LLM Debug Monitor
try:
    from event_publisher import publish_request_start, publish_capabilities_change
    EVENT_PUBLISHER_AVAILABLE = True
except ImportError:
    EVENT_PUBLISHER_AVAILABLE = False
    async def publish_request_start(*args, **kwargs):
        pass
    async def publish_capabilities_change(*args, **kwargs):
        pass

# Import skill manager
try:
    from managers.skill_manager import get_skill_manager, SkillManager
    SKILL_MANAGER_AVAILABLE = True
except ImportError:
    SKILL_MANAGER_AVAILABLE = False

# Import workspace manager
try:
    from managers.workspace_manager import get_workspace_manager, WorkspaceManager
    WORKSPACE_MANAGER_AVAILABLE = True
except ImportError:
    WORKSPACE_MANAGER_AVAILABLE = False

# Optional model access helpers (used to filter model inventory per-user)
try:
    from open_webui.models.models import Models as OWUIModels
    from open_webui.utils.access_control import has_access as owui_has_access
    MODEL_ACCESS_HELPERS_AVAILABLE = True
except ImportError:
    MODEL_ACCESS_HELPERS_AVAILABLE = False
    OWUIModels = None
    owui_has_access = None


# Set up logging
logger = logging.getLogger("UnifiedContextFilter")
handler = logging.StreamHandler()
formatter = logging.Formatter("%(asctime)s - %(name)s - %(levelname)s - %(message)s")
handler.setFormatter(formatter)
logger.addHandler(handler)
logger.setLevel(logging.INFO)

CHAT_CAPABILITIES_LOCK_TTL_SECONDS = 180
CHAT_CAPABILITIES_LOCK_WAIT_SECONDS = 125.0
CHAT_CAPABILITIES_LOCK_POLL_INTERVAL_SECONDS = 0.1
CHAT_WORKSPACES_SETTINGS_FILE = "chat-workspaces.json"
DEFAULT_CHAT_WORKSPACE_SETTINGS_DIR = "/app/workspace-cfg"
HEALTH_STATUS_PATH = "/app/health-status/health_status.json"
HEALTH_STATUS_STALE_MS = 120000
HEALTH_STATUS_TERMINAL_AUTH_PHASES = {"needs_oauth", "waiting_callback"}
HEALTH_STATUS_TERMINAL_CONFIG_PHASES = {"needs_config", "not_configured"}
HEALTH_STATUS_PROMPT_BLOCKING_PHASES = (
    HEALTH_STATUS_TERMINAL_AUTH_PHASES
    | HEALTH_STATUS_TERMINAL_CONFIG_PHASES
    | {"disabled"}
)
CHAT_CAPABILITIES_LOCK_RELEASE_SCRIPT = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
end
return 0
"""


class Filter:
    """
    Unified context filter that consolidates context injection into stable and
    dynamic system messages for better prompt-cache hit rates.

    Combines functionality from:
    - auto_agent_vm.py: VM creation and context
    - force_core_mcp_tools.py: Tool server management
    - include_date_and_time.py: Time context
    - include_ldap.py: User context
    - include_model.py: Model context
    - skills_loader.py: Skill loading and activation
    """

    class Valves(BaseModel):
        """Configuration valves for the unified context filter."""

        # Master toggle
        enable: bool = Field(
            default=True,
            description="Enable or disable the unified context filter",
        )

        # Section toggles
        enable_session_context: bool = Field(
            default=True,
            description="Include chat ID, model, and user context",
        )
        enable_models_context: bool = Field(
            default=True,
            description="Include available model inventory context",
        )
        enable_time_context: bool = Field(
            default=True,
            description="Include date/time context",
        )
        enable_agent_vm: bool = Field(
            default=True,
            description="Enable auto Agent VM creation and context injection",
        )
        enable_mcp_tools: bool = Field(
            default=True,
            description="Enable core MCP tools injection and tool_ids management",
        )
        enable_skills: bool = Field(
            default=True,
            description="Enable skills loading and auto-activation",
        )
        enable_workspace_files: bool = Field(
            default=True,
            description="Enable auto-copy of uploaded files to workspace",
        )

        # Time context settings
        auto_detect_timezone: bool = Field(
            default=True,
            description="Automatically detect system timezone",
        )
        timezone_hours: int = Field(default=0, description="Manual timezone offset hours")
        timezone_minutes: int = Field(default=0, description="Manual timezone offset minutes")
        southern_hemisphere: bool = Field(default=False, description="Southern hemisphere season adjustment")

        # User context settings
        ldap_env_variable: str = Field(
            default="PORTICO_USER_ID",
            description="Environment variable name containing the user's LDAP ID",
        )
        name_env_variable: str = Field(
            default="PORTICO_USER_NAME",
            description="Environment variable name containing the user's full name",
        )
        email_domain: str = Field(
            default="example.invalid",
            description="Email domain to append to LDAP",
        )

        # Agent VM settings
        vm_timeout_hours: float = Field(
            default=4.0,
            description="VM timeout in hours (default: 4, max: 24)",
        )

        # MCP tools settings
        core_tool_ids: Sequence[str] = Field(
            default=("server:mcp-assistant", "server:subagents", "server:skills", "server:agent-vm"),
            description="Tool server IDs that must always be enabled for every chat",
        )
        max_models_in_context: int = Field(
            default=60,
            description="Maximum number of models to include in prompt context",
        )
        # NOTE: always_enabled is now read dynamically from MCP server YAML configs.
        # This fallback list is only used if metadata fetch fails.
        fallback_always_enabled_ids: Sequence[str] = Field(
            default=("server:mcp-assistant", "server:subagents", "server:skills", "server:agent-vm"),
            description="Fallback tool server IDs if metadata fetch fails (meta-services only)",
        )

        # Skills settings
        enable_auto_activation: bool = Field(
            default=True,
            description="Enable auto-activation of high-priority skills based on trigger keywords",
        )

        # Infrastructure settings
        mcpo_url: str = Field(
            default="http://mcpo",
            description="URL for the shared MCPO proxy regular routes",
        )
        mcpo_core_url: str = Field(
            default="http://mcpo-core:8081",
            description="URL for the shared MCPO proxy core routes",
        )
        redis_host: str = Field(default="redis", description="Redis host")
        redis_port: int = Field(default=6379, description="Redis port")
        log_level: str = Field(
            default="INFO",
            description="Logging level (DEBUG, INFO, WARNING, ERROR)",
        )

    # OWUI upload directory path (inside container)
    OWUI_UPLOAD_DIR = "/app/backend/data/uploads"

    # Path to base system prompt for custom agents
    BASE_SYSTEM_PROMPT_PATH = "/app/agents/base_system_prompt.md"

    # Class-level cache for base system prompt
    _base_system_prompt_cache: Optional[str] = None

    @classmethod
    def get_base_system_prompt(cls) -> str:
        """
        Load and cache the base system prompt from file.

        This is used to ensure custom agents get the same base capabilities
        (skill activation, progressive disclosure, etc.) as base models.
        """
        if cls._base_system_prompt_cache is None:
            try:
                with open(cls.BASE_SYSTEM_PROMPT_PATH, 'r') as f:
                    cls._base_system_prompt_cache = f.read().strip()
                logger.info(f"Loaded base system prompt from {cls.BASE_SYSTEM_PROMPT_PATH}")
            except Exception as e:
                logger.warning(f"Failed to load base system prompt: {e}")
                cls._base_system_prompt_cache = ""
        return cls._base_system_prompt_cache

    def __init__(self):
        """Initialize the unified context filter."""
        self.valves = self.Valves()
        self.redis_client = None
        self.skill_manager: Optional[SkillManager] = None
        self._fragment_payload_cache = {}
        self._health_status_snapshot_cache = None
        self._disable_modes_cache = None

        # Cached user info (loaded once from env)
        self.ldap_id = None
        self.user_name = None

        # Set log level
        log_level = getattr(logging, self.valves.log_level.upper(), logging.INFO)
        logger.setLevel(log_level)

        # Initialize Redis
        if REDIS_AVAILABLE:
            try:
                self.redis_client = redis.Redis(
                    host=self.valves.redis_host,
                    port=self.valves.redis_port,
                    db=0,
                    decode_responses=True,
                    socket_connect_timeout=2
                )
                self.redis_client.ping()
                logger.info("UnifiedContextFilter initialized with Redis")
            except Exception as e:
                logger.warning(f"UnifiedContextFilter initialized without Redis: {e}")
                self.redis_client = None
        else:
            logger.warning("UnifiedContextFilter: redis-py not available")

        # Initialize skill manager with Redis client for cross-container hot-reload
        if SKILL_MANAGER_AVAILABLE:
            try:
                self.skill_manager = get_skill_manager(redis_client=self.redis_client)
                skills = self.skill_manager.discover_skills()
                logger.info(f"UnifiedContextFilter initialized with {len(skills)} skills (hot-reload: {'enabled' if self.redis_client else 'disabled'})")
            except Exception as e:
                logger.error(f"Failed to initialize skill manager: {e}")
                self.skill_manager = None

        # Load user info from environment
        self.ldap_id = self._load_env_var(self.valves.ldap_env_variable)
        self.user_name = self._load_env_var(self.valves.name_env_variable)

        logger.info("UnifiedContextFilter initialized")

    def _load_env_var(self, var_name: str) -> Optional[str]:
        """Load and validate environment variable."""
        value = os.getenv(var_name)
        if value:
            return value.strip() or None
        return None

    # ═══════════════════════════════════════════════════════════════════════════
    # TIME CONTEXT
    # ═══════════════════════════════════════════════════════════════════════════

    def _get_season(self, month: int) -> str:
        """Get season based on month and hemisphere."""
        if not self.valves.southern_hemisphere:
            if 3 <= month <= 5:
                return "Spring"
            elif 6 <= month <= 8:
                return "Summer"
            elif 9 <= month <= 11:
                return "Autumn"
            else:
                return "Winter"
        else:
            if 3 <= month <= 5:
                return "Autumn"
            elif 6 <= month <= 8:
                return "Winter"
            elif 9 <= month <= 11:
                return "Spring"
            else:
                return "Summer"

    def _get_time_of_day(self, hour: int) -> str:
        """Get time of day description."""
        if 5 <= hour < 12:
            return "Morning"
        elif 12 <= hour < 17:
            return "Afternoon"
        elif 17 <= hour < 21:
            return "Evening"
        else:
            return "Night"

    def _build_time_context(self) -> str:
        """Build time context string."""
        try:
            if self.valves.auto_detect_timezone:
                now = datetime.datetime.now().astimezone()
                tz_name = now.strftime("%Z")
                utc_offset = now.utcoffset()
                total_offset_seconds = int(utc_offset.total_seconds())
                total_offset_minutes = total_offset_seconds // 60
                hours_offset = abs(total_offset_minutes) // 60
                minutes_offset = abs(total_offset_minutes) % 60

                if minutes_offset == 0:
                    sign = "+" if total_offset_minutes >= 0 else "-"
                    timezone_str = f"{tz_name} (UTC{sign}{hours_offset})"
                else:
                    sign = "+" if total_offset_minutes >= 0 else "-"
                    timezone_str = f"{tz_name} (UTC{sign}{hours_offset}:{minutes_offset:02d})"
            else:
                now_utc = datetime.datetime.now(datetime.timezone.utc)
                total_offset_minutes = (self.valves.timezone_hours * 60) + self.valves.timezone_minutes
                now = now_utc + datetime.timedelta(minutes=total_offset_minutes)
                hours_offset = abs(total_offset_minutes) // 60
                minutes_offset = abs(total_offset_minutes) % 60
                sign = "+" if total_offset_minutes >= 0 else "-"
                if minutes_offset == 0:
                    timezone_str = f"UTC{sign}{hours_offset}"
                else:
                    timezone_str = f"UTC{sign}{hours_offset}:{minutes_offset:02d}"

            formatted_date = now.strftime("%B %d, %Y")
            day_of_week = now.strftime("%A")
            season = self._get_season(now.month)

            return (
                f"Current local date is {day_of_week}, {formatted_date}, {season}, "
                f"timezone {timezone_str}."
            )
        except Exception as e:
            logger.error(f"Failed to build time context: {e}")
            return ""

    @staticmethod
    def _extract_request_reasoning_effort(body: Any) -> str:
        """The current turn's reasoning effort from the request params (the frontend
        sends params.reasoning_effort). Surfaced in <reasoning_effort> so the model
        can start subagents with the same effort by default. No chat-state lookup."""
        params = body.get("params") if isinstance(body, dict) else None
        if isinstance(params, dict):
            effort = params.get("reasoning_effort")
            if isinstance(effort, str):
                return effort.strip()
        return ""

    # ═══════════════════════════════════════════════════════════════════════════
    # USER CONTEXT
    # ═══════════════════════════════════════════════════════════════════════════

    @staticmethod
    def _identity_mapping(value: Any) -> dict:
        """Return an identity-like value as a plain mapping when possible."""
        if isinstance(value, dict):
            return value
        if isinstance(value, BaseModel):
            try:
                return value.model_dump()
            except Exception:
                return {}
        if isinstance(value, str):
            try:
                parsed = json.loads(value)
            except (TypeError, ValueError):
                return {}
            return parsed if isinstance(parsed, dict) else {}
        return {}

    @staticmethod
    def _identity_value(*values: Any) -> Optional[str]:
        for value in values:
            if isinstance(value, str) and value.strip():
                return value.strip()
        return None

    @staticmethod
    def _normalize_ldap(value: Optional[str]) -> Optional[str]:
        normalized = str(value or "").strip()
        if not normalized:
            return None
        if "\\" in normalized:
            normalized = normalized.rsplit("\\", 1)[-1]
        if "@" in normalized:
            normalized = normalized.split("@", 1)[0]
        normalized = normalized.strip()
        return normalized or None

    def _authenticated_identity(self, user: Optional[dict]) -> dict:
        user_mapping = self._identity_mapping(user)
        oauth = self._identity_mapping(user_mapping.get("oauth"))
        okta = self._identity_mapping(oauth.get("portico-okta"))
        claims = self._identity_mapping(okta.get("claims"))

        service_markers = {
            str(user_mapping.get("id") or "").strip().lower(),
            str(user_mapping.get("email") or "").strip().lower(),
            str(user_mapping.get("username") or "").strip().lower(),
            str(claims.get("preferred_username") or "").strip().lower(),
        }
        if "portico-service" in oauth or any(
            marker == "portico-service"
            or marker.startswith("portico-service@")
            for marker in service_markers
        ):
            return {"is_service": True}

        display_name = self._identity_value(
            user_mapping.get("name"),
            claims.get("name"),
            self.user_name,
        )
        given_name = self._identity_value(claims.get("given_name"))
        email = self._identity_value(user_mapping.get("email"), claims.get("email"))
        ldap = self._normalize_ldap(
            self._identity_value(
                claims.get("preferred_username"),
                user_mapping.get("username"),
                email,
                self.ldap_id,
            )
        )
        if not email and ldap:
            email = f"{ldap}@{self.valves.email_domain}"

        return {
            "is_service": False,
            "display_name": display_name,
            "given_name": given_name,
            "ldap": ldap,
            "email": email,
        }

    def _build_user_context(self, user: Optional[dict] = None) -> str:
        """Build per-request authenticated user context with env fallbacks."""
        identity = self._authenticated_identity(user)
        if identity.get("is_service"):
            return ""

        parts = []
        display_name = identity.get("display_name")
        given_name = identity.get("given_name")
        ldap = identity.get("ldap")
        email = identity.get("email")

        if display_name:
            parts.append(f"Name: {html.escape(display_name, quote=True)}")
        if given_name and given_name.casefold() != str(display_name or "").casefold():
            parts.append(f"Given name: {html.escape(given_name, quote=True)}")
        if ldap:
            parts.append(f"LDAP: {html.escape(ldap, quote=True)}")
        if email:
            parts.append(f"Email: {html.escape(email, quote=True)}")

        if parts:
            return "User: " + ", ".join(parts)
        return ""

    # ═══════════════════════════════════════════════════════════════════════════
    # AGENT VM
    # ═══════════════════════════════════════════════════════════════════════════

    async def _create_vm_via_mcp(self, chat_id: str) -> Optional[str]:
        """Create a VM by calling the agent-vm MCP server."""
        if not HTTPX_AVAILABLE:
            logger.error("httpx not available, cannot create VM")
            return None

        url = f"{self.valves.mcpo_core_url}/agent-vm/agent_vm_create"

        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    url,
                    json={"chat_id": chat_id, "timeout_hours": self.valves.vm_timeout_hours},
                    headers={"Content-Type": "application/json"},
                    timeout=30.0,
                )
                response.raise_for_status()
                result = response.json()

                if result.get("success"):
                    vm_id = result.get("vm_id")
                    logger.info(f"Created VM via MCP: {vm_id}")
                    return vm_id
                else:
                    logger.error(f"MCP create failed: {result.get('error')}")
                    return None
        except Exception as e:
            logger.error(f"Error creating VM via MCP: {e}")
            return None

    async def _check_vm_status_via_mcp(self, vm_id: str) -> bool:
        """Check if a VM is still running."""
        if not HTTPX_AVAILABLE:
            return False

        url = f"{self.valves.mcpo_core_url}/agent-vm/agent_vm_get_status"

        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    url,
                    json={"vm_id": vm_id},
                    headers={"Content-Type": "application/json"},
                    timeout=5.0,
                )
                response.raise_for_status()
                result = response.json()
                return result.get("status") == "running"
        except Exception:
            return False

    async def _get_or_create_vm(self, chat_id: str) -> Optional[str]:
        """Get existing VM or create a new one."""
        if not self.redis_client:
            return None

        redis_key = f"agent_vm:{chat_id}"

        try:
            existing_vm_id = self.redis_client.get(redis_key)
            if existing_vm_id:
                if await self._check_vm_status_via_mcp(existing_vm_id):
                    logger.info(f"VM {existing_vm_id} is still running")
                    return existing_vm_id
                else:
                    logger.info(f"VM {existing_vm_id} no longer running")
                    self.redis_client.delete(redis_key)

            vm_id = await self._create_vm_via_mcp(chat_id)
            if vm_id:
                self.redis_client.set(redis_key, vm_id)
                logger.info(f"Stored VM ID {vm_id} in Redis")
                return vm_id
        except Exception as e:
            logger.error(f"Error getting/creating VM: {e}")
        return None

    @staticmethod
    def _chat_workspace_settings_path() -> str:
        configured = os.getenv("PORTICO_WORKSPACE_CFG_DIR", "").strip()
        configured = configured or DEFAULT_CHAT_WORKSPACE_SETTINGS_DIR
        if os.path.basename(configured) == CHAT_WORKSPACES_SETTINGS_FILE:
            return configured
        return os.path.join(configured, CHAT_WORKSPACES_SETTINGS_FILE)

    def _read_chat_workspace_settings(self) -> dict:
        settings_path = self._chat_workspace_settings_path()
        try:
            with open(settings_path, "r", encoding="utf-8") as settings_file:
                settings = json.load(settings_file)
        except FileNotFoundError:
            return {}
        except (OSError, ValueError, TypeError) as error:
            logger.warning(
                "Failed to read chat workspace settings from %s: %s",
                settings_path,
                error,
            )
            return {}

        chats = settings.get("chats") if isinstance(settings, dict) else None
        return chats if isinstance(chats, dict) else {}

    def _read_chat_workspace_entry(self, chat_id: str) -> dict:
        normalized_chat_id = str(chat_id or "").strip()
        if not normalized_chat_id:
            return {}
        entry = self._read_chat_workspace_settings().get(normalized_chat_id)
        return entry if isinstance(entry, dict) else {}

    def _build_chat_workspace_context(self, chat_id: str) -> str:
        normalized_chat_id = str(chat_id or "").strip()
        if not normalized_chat_id:
            return ""

        chats = self._read_chat_workspace_settings()
        entry = chats.get(normalized_chat_id)
        entry = entry if isinstance(entry, dict) else {}

        # Workspace-linked chats (started by another chat via start_chat)
        # follow the ROOT chat's CURRENT binding at read time — one hop only.
        # Anomalies (missing/linked root entry) fall back to this entry's
        # snapshot host_path, which the Electron fan-out keeps refreshed.
        linked_root = str(entry.get("root_parent_chat_id") or "").strip()
        if (
            bool(entry.get("linked_workspace"))
            and linked_root
            and linked_root != normalized_chat_id
        ):
            resolved_path = str(entry.get("host_path") or "").strip()
            root_entry = chats.get(linked_root)
            root_entry = root_entry if isinstance(root_entry, dict) else {}
            if not root_entry.get("linked_workspace"):
                root_path = str(root_entry.get("host_path") or "").strip()
                if root_entry.get("source") == "custom" and os.path.isabs(root_path):
                    resolved_path = root_path
            inherited_from_chat_id = str(
                entry.get("inherited_from_chat_id") or ""
            ).strip()

            lines = [
                '<chat_workspace mode="shared">',
                f"  <chat_id>{html.escape(normalized_chat_id, quote=True)}</chat_id>",
                "  <internal_path>/work</internal_path>",
            ]
            if resolved_path:
                lines.append(
                    f"  <host_path>{html.escape(resolved_path, quote=True)}</host_path>"
                )
            lines.append(
                "  <root_parent_chat_id>"
                f"{html.escape(linked_root, quote=True)}"
                "</root_parent_chat_id>"
            )
            if inherited_from_chat_id:
                lines.append(
                    "  <inherited_from_chat_id>"
                    f"{html.escape(inherited_from_chat_id, quote=True)}"
                    "</inherited_from_chat_id>"
                )
            lines.extend(
                [
                    "  <instruction>This block is authoritative for the current request. Ignore workspace paths and Agent VM IDs from earlier conversation or tool results when they disagree with this block and the current agent_vm context.</instruction>",
                    "  <instruction>Use /work as the Agent VM path. This chat SHARES the workspace of the chat that started it (root_parent_chat_id); the path follows that chat's current workspace and may change if that chat's workspace changes.</instruction>",
                    "</chat_workspace>",
                ]
            )
            return "\n".join(lines)

        inherited = bool(
            entry.get("inherited_workspace")
            or entry.get("inherited_from_chat_id")
            or entry.get("root_parent_chat_id")
        )
        raw_host_path = str(entry.get("host_path") or "").strip()
        has_custom_path = entry.get("source") == "custom" and os.path.isabs(
            raw_host_path
        )
        mode = (
            "inherited"
            if inherited and has_custom_path
            else "custom" if has_custom_path else "generated"
        )

        lines = [
            f'<chat_workspace mode="{mode}">',
            f"  <chat_id>{html.escape(normalized_chat_id, quote=True)}</chat_id>",
            "  <internal_path>/work</internal_path>",
        ]
        if has_custom_path:
            lines.append(
                f"  <host_path>{html.escape(raw_host_path, quote=True)}</host_path>"
            )
        if mode == "inherited":
            root_parent_chat_id = str(entry.get("root_parent_chat_id") or "").strip()
            inherited_from_chat_id = str(
                entry.get("inherited_from_chat_id") or ""
            ).strip()
            if root_parent_chat_id:
                lines.append(
                    "  <root_parent_chat_id>"
                    f"{html.escape(root_parent_chat_id, quote=True)}"
                    "</root_parent_chat_id>"
                )
            if inherited_from_chat_id:
                lines.append(
                    "  <inherited_from_chat_id>"
                    f"{html.escape(inherited_from_chat_id, quote=True)}"
                    "</inherited_from_chat_id>"
                )
        lines.extend(
            [
                "  <instruction>This block is authoritative for the current request. Ignore workspace paths and Agent VM IDs from earlier conversation or tool results when they disagree with this block and the current agent_vm context.</instruction>",
                "  <instruction>Use /work as the Agent VM path. Describe a custom host_path as the user's workspace; otherwise describe this as the generated workspace for this chat.</instruction>",
                "</chat_workspace>",
            ]
        )
        return "\n".join(lines)

    # NOTE: _enable_vm_tools was removed as part of progressive disclosure.
    # VM tools (agent-vm, artifacts) are now enabled via skill activation:
    # - code-execution skill enables server:agent-vm
    # - artifacts skill enables server:agent-vm and server:artifacts
    # Skills define their required_mcp_servers in SKILL.md. Keyword activation
    # snapshots which required servers were already eligible for chat auto-enable
    # at the moment the skill activated. Core/always-enabled dependencies are
    # always eligible. Optional integrations that were disabled at activation
    # time remain a separate explicit chat activation step even if they become
    # ready later in the same turn.

    def _build_vm_context(self, vm_id: str, chat_id: str) -> str:
        """Build VM context string with consistent XML structure."""
        return f"""<agent_vm id="{vm_id}">
  <description>A persistent Agent VM is automatically created for this chat.</description>
  <description>The default Agent VM already includes the standard Python, document/data, and Node/npm tooling for this chat.</description>

  <web_apps>
    <step>create_files(vm_id="{vm_id}", files=[...]) - Create HTML/CSS/JS files</step>
    <step>create_artifact(vm_id="{vm_id}", chat_id="{chat_id}", name="...", start_command="python -m http.server 5173", container_port=5173) - Opens live preview automatically</step>
  </web_apps>

  <code_execution>
    <command>bash(vm_id="{vm_id}", command="...") - Run shell commands</command>
    <command>python(vm_id="{vm_id}", script="...") - Run Python scripts</command>
    <command>read_fragment(vm_id="{vm_id}", path="/work/...", offset_chars=0, max_chars=20000) - Read large text files in chunks</command>
    <command>jq is installed in the Agent VM and can be used from bash for JSON inspection</command>
  </code_execution>

  <restrictions>
    <restriction>Do NOT call create - already done automatically (use VM ID above)</restriction>
    <restriction>Do NOT create duplicate download copies - /work is the internal Agent VM mount for the chat workspace</restriction>
    <restriction>Do NOT call open_artifact separately - create_artifact auto-opens the preview panel</restriction>
    <restriction>Do NOT start python -m http.server manually - use create_artifact instead</restriction>
    <restriction>Do NOT provide download links - use create_artifact for live preview instead</restriction>
  </restrictions>
</agent_vm>"""

    # ═══════════════════════════════════════════════════════════════════════════
    # MCP TOOLS
    # ═══════════════════════════════════════════════════════════════════════════

    def _get_mcpo_base_url(self, *, is_core: bool = False) -> str:
        """Return the base URL for shared MCPO regular or core proxy routes."""
        base_url = self.valves.mcpo_core_url if is_core else self.valves.mcpo_url
        return base_url.rstrip("/")

    def _get_server_openapi_url(self, server_id: str, *, is_core: bool = False) -> str:
        """Build the proxied OpenAPI URL for a specific server."""
        return f"{self._get_mcpo_base_url(is_core=is_core)}/{server_id}/openapi.json"

    def _iter_local_mcp_server_configs(self) -> list[tuple[str, dict, bool]]:
        """Read MCP server config metadata from local mounted config dirs."""
        if not YAML_AVAILABLE:
            return []

        configs = []
        seen = set()
        system_configs_dir = "/app/mcp-configs"
        system_ids = {
            entry
            for entry in os.listdir(system_configs_dir)
            if os.path.isdir(os.path.join(system_configs_dir, entry))
        } if os.path.isdir(system_configs_dir) else set()
        for configs_dir, is_user_dir in (
            (system_configs_dir, False),
            ("/app/mcp-configs-user", True),
        ):
            if not os.path.isdir(configs_dir):
                continue
            for entry in sorted(os.listdir(configs_dir)):
                if is_user_dir and entry in system_ids:
                    continue
                yaml_path = os.path.join(configs_dir, entry, f"{entry}.yaml")
                if not os.path.isfile(yaml_path):
                    continue
                try:
                    with open(yaml_path, "r") as f:
                        config = yaml.safe_load(f) or {}
                except Exception as e:
                    logger.debug(f"Could not read MCP config {yaml_path}: {e}")
                    continue

                server_id = str(config.get("id") or entry).strip()
                if not server_id or server_id in seen:
                    continue
                seen.add(server_id)
                configs.append((server_id, config, is_user_dir))

        return configs

    def _build_local_mcp_server_metadata(self) -> dict:
        """Build prompt-time MCP metadata without live MCP/OpenAPI calls."""
        metadata = {}
        for server_id, config, is_user_dir in self._iter_local_mcp_server_configs():
            oauth_cfg = config.get("oauth", {})
            display_name = config.get(
                "display_name",
                server_id.replace("-", " ").replace("_", " ").title(),
            )
            metadata[server_id] = {
                "id": server_id,
                "display_name": display_name,
                "name": display_name,
                "description": config.get("description", ""),
                "is_core": bool(config.get("is_core", False)),
                "always_enabled": bool(config.get("always_enabled", False)),
                "user_installed": bool(config.get("user_installed", is_user_dir)),
                "oauth": bool(
                    isinstance(oauth_cfg, dict)
                    and oauth_cfg.get("requires_user_authorization")
                ),
            }
        return metadata

    async def _fetch_available_tools(self) -> list:
        """Return locally known MCP tool servers without prompt-path probing."""
        available_tools = []
        for server_id, meta in self._build_local_mcp_server_metadata().items():
            available_tools.append({
                "id": f"server:{server_id}",
                "name": meta.get("display_name") or meta.get("name") or server_id,
                "description": meta.get("description", ""),
            })
        return available_tools

    async def _fetch_mcp_server_metadata(self) -> dict:
        """Return MCP server metadata from local config files only."""
        return self._build_local_mcp_server_metadata()

    def _get_chat_tools(self, chat_id: str) -> list:
        """Get chat-specific enabled tools from Redis."""
        if not self.redis_client or not chat_id:
            return []

        try:
            redis_key = f"chat_tools:{chat_id}"
            tools_json = self.redis_client.get(redis_key)
            return json.loads(tools_json) if tools_json else []
        except Exception:
            return []

    def _chat_capabilities_lock_key(self, chat_id: str) -> str:
        return f"chat_capabilities_lock:{chat_id}"

    @contextmanager
    def _chat_capabilities_lock(self, chat_id: Optional[str]):
        if not self.redis_client or not chat_id:
            yield
            return

        lock_key = self._chat_capabilities_lock_key(chat_id)
        token = str(uuid.uuid4())
        started_at = time.time()
        acquired = False

        try:
            while (time.time() - started_at) < CHAT_CAPABILITIES_LOCK_WAIT_SECONDS:
                if self.redis_client.set(
                    lock_key,
                    token,
                    nx=True,
                    ex=CHAT_CAPABILITIES_LOCK_TTL_SECONDS,
                ):
                    acquired = True
                    break
                time.sleep(CHAT_CAPABILITIES_LOCK_POLL_INTERVAL_SECONDS)

            if not acquired:
                raise RuntimeError(
                    f"Timed out acquiring chat capabilities lock for {chat_id}"
                )

            yield
        finally:
            if acquired:
                try:
                    self.redis_client.eval(
                        CHAT_CAPABILITIES_LOCK_RELEASE_SCRIPT,
                        1,
                        lock_key,
                        token,
                    )
                except Exception as e:
                    logger.warning(
                        f"Failed to release chat capabilities lock for {chat_id}: {e}"
                    )

    def _store_chat_tools(self, chat_id: str, tools: list, lock: bool = True):
        """Store enabled tools to Redis."""
        if not self.redis_client or not chat_id:
            return

        try:
            lock_ctx = self._chat_capabilities_lock(chat_id) if lock else nullcontext()
            with lock_ctx:
                redis_key = f"chat_tools:{chat_id}"
                self.redis_client.setex(redis_key, 604800, json.dumps(tools))
        except Exception as e:
            logger.error(f"Failed to store chat tools: {e}")

    def _build_persisted_chat_tool_ids(
        self,
        chat_tools: Sequence[str],
        core_tool_ids: Sequence[str],
        always_enabled_ids: Sequence[str],
        include_tool: Optional[Callable[[str], bool]] = None,
    ) -> list[str]:
        """Build the capability set that should persist to Redis for a chat.

        This intentionally excludes request-only tool_ids derived from model
        inventory or other transient sources. The chat_tools Redis key is the
        source of truth for chat-attached capabilities, not the full per-turn
        request tool list.
        """
        persisted = []
        for tool_id in list(core_tool_ids) + list(always_enabled_ids) + list(chat_tools):
            if not tool_id or tool_id in persisted:
                continue
            if include_tool is not None and not include_tool(tool_id):
                continue
            persisted.append(tool_id)
        return persisted

    def _store_session_mapping(self, session_id: str, chat_id: str):
        """Store session↔chat mapping in Redis."""
        if not self.redis_client or not session_id or not chat_id:
            return

        try:
            self.redis_client.setex(f"session_chat:{session_id}", 604800, chat_id)
            self.redis_client.setex(f"chat_session:{chat_id}", 604800, session_id)
        except Exception as e:
            logger.error(f"Failed to store session mapping: {e}")

    def _get_disabled_integrations(self) -> list:
        """Discover disabled integrations from MCP config YAMLs + toggles.

        Reads mcp_toggles.json (via cached _load_toggles) and /app/mcp-configs/
        for server metadata. Any non-core, non-always-enabled server that is
        toggled off is considered a disabled integration.

        Result is cached per request (reset in inlet()).
        Returns list of dicts with 'id', 'name', 'description' for each.
        """
        if self._cached_disabled_integrations is not None:
            return self._cached_disabled_integrations

        configs_dir = "/app/mcp-configs"
        toggles = self._load_toggles()
        if not toggles or not YAML_AVAILABLE or not os.path.isdir(configs_dir):
            self._cached_disabled_integrations = []
            return []

        disabled = []
        for entry in os.listdir(configs_dir):
            yaml_path = os.path.join(configs_dir, entry, f"{entry}.yaml")
            if not os.path.isfile(yaml_path):
                continue
            try:
                with open(yaml_path, "r") as f:
                    config = yaml.safe_load(f) or {}
            except Exception:
                continue

            server_id = config.get("id", entry)
            is_core = config.get("is_core", False)
            always_enabled = config.get("always_enabled", False)
            user_installed = config.get("user_installed", False)

            # Skip core/always-enabled/user-installed servers
            if is_core or always_enabled or user_installed:
                continue

            # Check toggle state — if toggled off, it's a disabled integration
            if not toggles.get(server_id, True):
                # PORTICO-410: hard-disabled integrations are opaque to the model —
                # never listed, so the model cannot be prompted to re-enable them.
                if self._is_server_hard_disabled(server_id):
                    continue
                oauth_cfg = config.get("oauth", {})
                auth_type = "oauth" if oauth_cfg and oauth_cfg.get("requires_user_authorization") else "token"
                disabled.append({
                    "id": server_id,
                    "name": config.get("display_name", server_id),
                    "description": config.get("description", ""),
                    "auth_type": auth_type,
                })

        self._cached_disabled_integrations = disabled
        return disabled

    def _get_unauthenticated_integrations(self) -> list:
        """Find toggled-on OAuth integrations that lack authentication.

        Uses the periodic MCP health snapshot. Prompt construction must not
        synchronously probe MCPO/OpenAPI routes.

        Returns list of dicts with 'id', 'name', 'description' for each.
        """
        configs_dir = "/app/mcp-configs"
        if not YAML_AVAILABLE or not os.path.isdir(configs_dir):
            return []

        snapshot = self._load_health_status_snapshot()
        unauthenticated = []
        for entry in os.listdir(configs_dir):
            yaml_path = os.path.join(configs_dir, entry, f"{entry}.yaml")
            if not os.path.isfile(yaml_path):
                continue
            try:
                with open(yaml_path, "r") as f:
                    config = yaml.safe_load(f) or {}
            except Exception:
                continue

            server_id = config.get("id", entry)
            oauth_cfg = config.get("oauth", {})
            if not oauth_cfg or not oauth_cfg.get("requires_user_authorization"):
                continue

            # Only check toggled-on servers (disabled ones are handled separately)
            if not self._is_server_toggled_on(server_id):
                continue

            # Hard-disabled servers must be fully opaque to the model —
            # belt-and-braces against the fail-open toggle read above (an
            # absent toggle key counts as "on").
            if self._is_server_hard_disabled(server_id):
                continue

            readiness = self._readiness_from_health_snapshot(server_id, snapshot)
            if readiness.get("readiness_phase") not in HEALTH_STATUS_TERMINAL_AUTH_PHASES:
                continue

            unauthenticated.append({
                "id": server_id,
                "name": config.get("display_name", server_id),
                "description": config.get("description", ""),
            })

        return unauthenticated

    def _get_unconfigured_integrations(self) -> list:
        """Find toggled-on integrations that need initial configuration (env vars).

        Uses the periodic MCP health snapshot. Missing, stale, starting,
        failed, or unknown health data does not block prompt processing.

        Returns list of dicts with 'id', 'name', 'description' for each.
        """
        if hasattr(self, '_cached_unconfigured') and self._cached_unconfigured is not None:
            return self._cached_unconfigured

        configs_dir = "/app/mcp-configs"
        if not YAML_AVAILABLE or not os.path.isdir(configs_dir):
            self._cached_unconfigured = []
            return []

        # IDs already handled by other checks
        unauthenticated_ids = getattr(self, '_unauthenticated_server_ids', set())
        snapshot = self._load_health_status_snapshot()

        unconfigured = []
        for entry in os.listdir(configs_dir):
            yaml_path = os.path.join(configs_dir, entry, f"{entry}.yaml")
            if not os.path.isfile(yaml_path):
                continue
            try:
                with open(yaml_path, "r") as f:
                    config = yaml.safe_load(f) or {}
            except Exception:
                continue

            server_id = config.get("id", entry)
            is_core = config.get("is_core", False)
            always_enabled = config.get("always_enabled", False)
            required_env_vars = config.get("required_env_vars", [])

            # Only check non-core, toggled-on servers with required env vars
            if is_core or always_enabled:
                continue
            if not self._is_server_toggled_on(server_id):
                continue
            # Hard-disabled servers must be fully opaque to the model —
            # belt-and-braces against the fail-open toggle read above.
            if self._is_server_hard_disabled(server_id):
                continue
            if not required_env_vars:
                continue
            if server_id in unauthenticated_ids:
                continue

            readiness = self._readiness_from_health_snapshot(server_id, snapshot)
            if readiness.get("readiness_phase") not in HEALTH_STATUS_TERMINAL_CONFIG_PHASES:
                continue

            unconfigured.append({
                "id": server_id,
                "name": config.get("display_name", server_id),
                "description": config.get("description", ""),
            })

        self._cached_unconfigured = unconfigured
        self._unconfigured_server_ids = {info["id"] for info in unconfigured}
        return unconfigured

    def _build_integrations_status_context(
        self,
        mcp_metadata: dict,
        enabled_tool_ids: Optional[Sequence[str]] = None,
        chat_id: Optional[str] = None,
        *,
        include_active: bool = True,
        include_inactive: bool = True,
        include_setup_guidance: bool = True,
        readiness_cache: Optional[dict[str, dict]] = None,
    ) -> str:
        """Build a single compact context block for ALL integration statuses.

        Combines active, activatable, disabled, needs-auth, and needs-config
        integrations into one <integrations_status> block with a compact table
        and shared instructions, instead of per-server blocks with repeated text.
        """
        enabled_server_ids = None
        if enabled_tool_ids is not None:
            enabled_server_ids = set()
            for tool_id in enabled_tool_ids:
                if not tool_id:
                    continue
                enabled_server_ids.add(
                    tool_id.replace("server:", "", 1)
                    if tool_id.startswith("server:")
                    else tool_id
                )

        # --- Collect all integration lists ---
        disabled = self._get_disabled_integrations()

        if hasattr(self, '_cached_unauthenticated') and self._cached_unauthenticated is not None:
            unauthenticated = self._cached_unauthenticated
        else:
            unauthenticated = self._get_unauthenticated_integrations()
            self._unauthenticated_server_ids = {info["id"] for info in unauthenticated}

        unconfigured = self._get_unconfigured_integrations()

        unconfigured_ids = getattr(self, '_unconfigured_server_ids', set())
        unauthenticated_ids = set(getattr(self, '_unauthenticated_server_ids', set()))

        disabled_ids_set = {info["id"] for info in disabled}
        readiness_cache = readiness_cache if readiness_cache is not None else {}
        health_snapshot = self._load_health_status_snapshot()

        def get_readiness(server_id: str) -> dict:
            if server_id not in readiness_cache:
                readiness_cache[server_id] = self._readiness_from_health_snapshot(
                    server_id,
                    health_snapshot,
                )
            return readiness_cache[server_id]

        def readiness_requires_authorization(readiness: dict) -> bool:
            readiness_phase = readiness.get("readiness_phase")
            oauth_state = readiness.get("oauth_state")
            authorization_url_available = bool(
                readiness.get("authorization_url_available")
            )
            return (
                readiness_phase in {"needs_oauth", "waiting_callback"}
                or (
                    authorization_url_available
                    and oauth_state in {"active", "waiting_callback"}
                )
            )

        def normalize_available_phase(readiness: dict) -> str:
            readiness_phase = str(readiness.get("readiness_phase") or "").strip()
            if readiness_phase in {"needs_oauth", "waiting_callback"}:
                return "needs_oauth"
            if readiness_phase == "needs_config":
                return "needs_config"
            if readiness_phase == "disabled":
                return "disabled"
            return "tool_ready"

        active = []
        available_to_activate = []
        candidate_server_ids = []
        for server_id in sorted(mcp_metadata.keys(), key=lambda value: str(value).lower()):
            meta = mcp_metadata.get(server_id, {})
            is_core = bool(meta.get("is_core", False))
            always_enabled = bool(meta.get("always_enabled", False))
            if not is_core and not always_enabled and not self._is_server_toggled_on(server_id):
                continue
            # PORTICO-410 belt-and-braces: even when toggles are unreadable
            # (fail-open True) or health reports it disabled, a hard-disabled
            # server must never surface in any integrations listing.
            if not is_core and not always_enabled and self._is_server_hard_disabled(server_id):
                continue
            if server_id in unconfigured_ids or server_id in unauthenticated_ids:
                continue
            is_active_for_chat = enabled_server_ids is not None and server_id in enabled_server_ids
            if not include_inactive and not is_active_for_chat:
                continue
            candidate_server_ids.append(server_id)

        for server_id in candidate_server_ids:
            meta = mcp_metadata.get(server_id, {})
            is_core = bool(meta.get("is_core", False))
            always_enabled = bool(meta.get("always_enabled", False))
            display_name = meta.get("display_name", server_id)
            auth_type = "oauth" if meta.get("oauth") else "token"
            info = {"id": server_id, "name": display_name, "auth_type": auth_type}
            if enabled_server_ids is not None and server_id in enabled_server_ids:
                readiness = get_readiness(server_id)
                if not (is_core or always_enabled) and readiness.get("readiness_phase") == "disabled":
                    if server_id not in disabled_ids_set:
                        info["description"] = meta.get("description", "")
                        disabled.append(info)
                        disabled_ids_set.add(server_id)
                elif readiness_requires_authorization(readiness):
                    if server_id not in unauthenticated_ids:
                        info["description"] = meta.get("description", "")
                        unauthenticated.append(info)
                        unauthenticated_ids.add(server_id)
                elif readiness.get("readiness_phase") in HEALTH_STATUS_TERMINAL_CONFIG_PHASES:
                    if server_id not in unconfigured_ids:
                        info["description"] = meta.get("description", "")
                        unconfigured.append(info)
                        unconfigured_ids.add(server_id)
                else:
                    active.append(info)
            else:
                readiness = get_readiness(server_id)
                if not (is_core or always_enabled) and readiness.get("readiness_phase") == "disabled":
                    if server_id not in disabled_ids_set:
                        info["description"] = meta.get("description", "")
                        disabled.append(info)
                        disabled_ids_set.add(server_id)
                elif readiness_requires_authorization(readiness):
                    if server_id not in unauthenticated_ids:
                        info["description"] = meta.get("description", "")
                        unauthenticated.append(info)
                        unauthenticated_ids.add(server_id)
                elif readiness.get("readiness_phase") in HEALTH_STATUS_TERMINAL_CONFIG_PHASES:
                    if server_id not in unconfigured_ids:
                        info["description"] = meta.get("description", "")
                        unconfigured.append(info)
                        unconfigured_ids.add(server_id)
                else:
                    info["readiness_phase"] = normalize_available_phase(readiness)
                    available_to_activate.append(info)

        self._unauthenticated_server_ids = unauthenticated_ids
        self._cached_unauthenticated = unauthenticated
        self._unconfigured_server_ids = unconfigured_ids
        self._cached_unconfigured = unconfigured

        active.sort(key=lambda info: info["id"].lower())
        available_to_activate.sort(key=lambda info: info["id"].lower())
        disabled.sort(key=lambda info: info["id"].lower())
        unauthenticated.sort(key=lambda info: info["id"].lower())
        unconfigured.sort(key=lambda info: info["id"].lower())

        if (
            not active
            and not available_to_activate
            and not disabled
            and not unauthenticated
            and not unconfigured
        ):
            return ""

        is_delegated_subagent = self._is_delegated_subagent_chat(chat_id)

        lines = ["<integrations_status>"]

        # --- Active integrations (compact table) ---
        if include_active and active:
            lines.append("<active>")
            lines.append(
                "These tool servers are ACTIVE for this chat and currently attached. "
                "Use their tools normally. If previous messages said any were disabled, that is STALE."
            )
            for info in active:
                lines.append(f'  {info["id"]} | {info["name"]} | auth={info["auth_type"]}')
            lines.append("</active>")

        if is_delegated_subagent:
            if include_setup_guidance and (
                disabled or unauthenticated or unconfigured or available_to_activate
            ):
                lines.append("<delegated_subagent_rule>")
                lines.append(
                    "This is a delegated subagent chat. Do NOT toggle, authorize, activate, guided_setup, "
                    "or activate new skills/integrations here."
                )
                lines.append(
                    "Use only tool servers already ACTIVE for this chat. Treat all non-active servers "
                    "as unavailable and continue with the currently attached tools and evidence."
                )
                lines.append("</delegated_subagent_rule>")
            if len(lines) == 1:
                return ""
            lines.append("</integrations_status>")
            return "\n".join(lines)

        # --- Enabled system-wide but not yet active in this chat ---
        if include_inactive and available_to_activate:
            lines.append("<available_to_activate>")
            lines.append("ENABLED but not active for this chat. Do NOT toggle.")
            for info in available_to_activate:
                lines.append(
                    f'  {info["id"]} | auth={info["auth_type"]} | phase={info.get("readiness_phase", "starting")}'
                )
            lines.append("</available_to_activate>")

        # --- Disabled integrations ---
        if include_inactive and disabled:
            lines.append("<disabled>")
            lines.append("DISABLED. First action is ALWAYS toggle_integration(id, enabled=true).")
            for info in disabled:
                lines.append(f'  {info["id"]} | auth={info.get("auth_type", "token")} | {info.get("description", "")}')
            lines.append("</disabled>")

        # --- Needs authentication ---
        if include_inactive and unauthenticated:
            lines.append("<needs_auth>")
            lines.append("Enabled but NOT AUTHENTICATED. Tools will fail until authorized.")
            for info in unauthenticated:
                lines.append(f'  {info["id"]} | {info.get("description", "")}')
            lines.append("</needs_auth>")

        # --- Needs configuration ---
        if include_inactive and unconfigured:
            lines.append("<needs_config>")
            lines.append("Enabled but NOT CONFIGURED. Tools will fail until configured.")
            for info in unconfigured:
                lines.append(f'  {info["id"]} | {info.get("description", "")}')
            lines.append("</needs_config>")

        # --- Instructions: recipes + planning + two-phase ---
        instruction_lines = []
        setup_needed = include_inactive and (
            disabled or unauthenticated or unconfigured or available_to_activate
        )

        if include_setup_guidance and setup_needed:
            instruction_lines.append(
                "PLAN FIRST: Read the user's request. Identify ONLY the integrations needed "
                "to fulfill it by matching to the descriptions above. Do NOT enable integrations speculatively."
            )
            instruction_lines.append("TWO-PHASE EXECUTION:")
            instruction_lines.append(
                "  Phase 1 — SET UP integrations STRICTLY ONE AT A TIME, IN SEQUENCE. "
                "Complete EVERY step for one integration before touching the next. "
                "OAuth integrations first (faster, no manual config)."
            )
            instruction_lines.append(
                "  STRICT RULE: Issue ONE tool call at a time. Wait for its result. "
                "Act on the result. Then issue the NEXT call. NEVER batch multiple setup calls."
            )
            instruction_lines.append(
                "  Per-integration sequence: toggle → (wait for result) → authorize/guided_setup → (wait for completion) → next integration."
            )
            instruction_lines.append(
                "  authorize_integration is BLOCKING — it waits for the user to finish OAuth in the browser. "
                "Do NOT start the next integration until authorize returns success."
            )
            instruction_lines.append(
                "  Phase 2 — USE TOOLS from all ready integrations to answer the user's request. "
                "CRITICAL: You may ONLY call tools belonging to a server that has been activated "
                "(activate_integration returned success) and is tool_ready. "
                "If a tool call fails with 'not available', activate its server first — do NOT retry blindly."
            )
            instruction_lines.append("SETUP RECIPES (per status):")
            instruction_lines.append("  disabled      → toggle(id, true), then follow auth recipe below")
            instruction_lines.append("  needs_auth    → authorize(id, chat_id) — auto-activates")
            instruction_lines.append("  needs_config  → guided_setup(id), then activate(chat_id, [\"server:id\"])")
            instruction_lines.append(
                "  available     → activate(chat_id, [\"server:id\"]) regardless of auth type; "
                "if the result reports OAuth or config work, follow the returned readiness_phase and next_steps"
            )
            instruction_lines.append("RULES:")
            instruction_lines.append(
                "  - disabled: toggle FIRST. NEVER call authorize/guided_setup before toggle."
            )
            instruction_lines.append(
                "  - After any setup tool call, trust its returned readiness_phase and next_steps over auth_type heuristics."
            )
            instruction_lines.append(
                "  - available_to_activate/needs_config: NEVER call toggle — already enabled."
            )
            instruction_lines.append(
                "  - guided_setup success=true → server IS configured. Do NOT re-trigger."
            )
            instruction_lines.append(
                "  - Hierarchical data (GitLab, Jira, Confluence): resolve parent (repo/project) first."
            )
            instruction_lines.append("ERRORS:")
            instruction_lines.append(
                "  - 'Server disconnected' / HTTP 5xx after toggle → toggle SUCCEEDED. Next step."
            )
            instruction_lines.append(
                "  - 'DISABLED' from authorize/setup → call toggle(id, true) first, then retry."
            )
            instruction_lines.append("  - FLOW_IN_PROGRESS → wait, retry. Do NOT skip.")
            instruction_lines.append(
                "  - MAX_RETRIES_EXCEEDED → STOP that integration. Inform user."
            )
            instruction_lines.append(
                "  - Same call fails 2x for same integration → STOP. Suggest Control Plane > Integrations."
            )
            instruction_lines.append("TOOL USAGE — HARD RULES (violating these causes errors):")
            instruction_lines.append(
                "  1. NEVER call any tool before its server appears in <enabled>. "
                "Check <enabled> BEFORE every tool call — not just once."
            )
            instruction_lines.append(
                "  2. agent_vm_*, artifacts_* tools REQUIRE activation first. "
                "Call activate_integration(chat_id, tool_server_ids=[\"server:agent-vm\"]) BEFORE "
                "any agent_vm_execute_skill_script, agent_vm_bash, or artifacts call."
            )
            instruction_lines.append(
                "  3. If a tool call fails, check if its server is in <enabled>. "
                "If not, activate it. Do NOT retry the same call without activating."
            )
            instruction_lines.append(
                "  4. Activation order: finish ALL Phase 1 integration setup, "
                "THEN activate core servers (agent-vm, artifacts), THEN use tools in Phase 2."
            )

        if include_setup_guidance and active:
            instruction_lines.append(
                "Auth-like tool errors on active (401, invalid token, expired token, re-authenticate): oauth→authorize(server_id, chat_id, force_auth=true); token→tell user, offer guided_setup only if they agree. NEVER authorize token-based servers."
            )
            instruction_lines.append(
                "Do NOT claim auth is refreshed unless authorize(server_id, chat_id, force_auth=true) succeeds or the retried tool call actually succeeds."
            )
            instruction_lines.append("DISABLE: toggle(server_id, enabled=false)")

        if instruction_lines:
            lines.append("<instructions>")
            lines.extend(instruction_lines)
            lines.append("</instructions>")

        if len(lines) == 1:
            return ""

        lines.append("</integrations_status>")
        return "\n".join(lines)

    def _sanitize_disabled_tool_history(self, messages: list, disabled_server_ids: set) -> int:
        """Remove or neutralize tool calls/results for disabled integrations in chat history.

        When an integration is disabled mid-chat, old successful tool call results
        remain in the conversation history. The LLM reads these and attempts to call
        the same tools again. This method neutralizes those stale entries so the LLM
        has no evidence the tools ever worked.

        Returns the number of messages modified.
        """
        if not disabled_server_ids or not messages:
            return 0

        def _is_disabled_tool(func_name: str) -> bool:
            """Check if a tool function name belongs to a disabled server."""
            for sid in disabled_server_ids:
                if func_name.startswith(f"{sid}_"):
                    return True
            return False

        # First pass: collect tool_call_ids from disabled tools in assistant messages
        disabled_call_ids = set()
        for msg in messages:
            if msg.get("role") != "assistant":
                continue
            tool_calls = msg.get("tool_calls", [])
            for tc in tool_calls:
                func = tc.get("function", {})
                if _is_disabled_tool(func.get("name", "")):
                    tc_id = tc.get("id", "")
                    if tc_id:
                        disabled_call_ids.add(tc_id)

        if not disabled_call_ids:
            return 0

        modified = 0

        # Second pass: neutralize tool result messages for disabled tools
        # Keep the message structure intact (toolUse→toolResult pairing) to
        # avoid Bedrock validation errors, but replace the content so the LLM
        # sees no evidence of successful past results.
        for msg in messages:
            if msg.get("role") == "tool" and msg.get("tool_call_id") in disabled_call_ids:
                msg["content"] = "[This integration has been disabled by the user. Do not call this tool.]"
                modified += 1

        return modified

    def _build_tools_context(
        self,
        available_tools: list,
        enabled_tools: list,
        mcp_metadata: dict,
        include_available: bool = True,
        include_enabled: bool = True,
    ) -> str:
        """Build tools context string with consistent XML structure, sorted by Core > System > User."""
        if not include_available and not include_enabled:
            return ""

        lines = ["<tool_servers>"]

        if include_available and available_tools:
            # Separate into three categories based on metadata:
            # - Core: is_core=true
            # - System: is_core=false AND user_installed=false (e.g., Glean)
            # - User: user_installed=true
            core_tools = []
            system_tools = []
            user_tools = []

            for tool in available_tools:
                if not isinstance(tool, dict):
                    continue
                tool_id = tool.get("id", "unknown")
                tool_name = tool.get("name", "Unknown")
                tool_desc = tool.get("description", "")

                # Get server_id without "server:" prefix for metadata lookup
                server_id = tool_id.replace("server:", "") if tool_id.startswith("server:") else tool_id
                server_meta = mcp_metadata.get(server_id, {})
                is_core = server_meta.get("is_core", False)
                user_installed = server_meta.get("user_installed", False)

                # Filter out tools for servers that are toggled off in mcp_toggles.json.
                # Core servers are always shown. User-installed and system servers
                # are hidden when toggled off to avoid confusing the AI.
                if not is_core and not self._is_server_toggled_on(server_id):
                    continue
                # PORTICO-410: hard-disabled servers are opaque to the model even if
                # the toggles read is stale/fail-open (modes come snapshot-first
                # through the rename-safe health-status directory bind).
                if not is_core and self._is_server_hard_disabled(server_id):
                    continue

                tool_entry = {
                    "id": tool_id,
                    "name": tool_name,
                    "desc": tool_desc,
                }

                if is_core:
                    core_tools.append(tool_entry)
                elif user_installed:
                    user_tools.append(tool_entry)
                else:
                    # System tools: not core and not user-installed (e.g., Glean)
                    system_tools.append(tool_entry)

            # Sort each group alphabetically by tool_id
            core_tools.sort(key=lambda t: t["id"].lower())
            system_tools.sort(key=lambda t: t["id"].lower())
            user_tools.sort(key=lambda t: t["id"].lower())

            lines.append("  <available>")

            if core_tools:
                lines.append('    <category type="core">')
                for tool in core_tools:
                    desc_attr = f' description="{tool["desc"]}"' if tool["desc"] else ""
                    lines.append(f'      <server id="{tool["id"]}" name="{tool["name"]}"{desc_attr}/>')
                lines.append("    </category>")

            if system_tools:
                lines.append('    <category type="system">')
                for tool in system_tools:
                    desc_attr = f' description="{tool["desc"]}"' if tool["desc"] else ""
                    lines.append(f'      <server id="{tool["id"]}" name="{tool["name"]}"{desc_attr}/>')
                lines.append("    </category>")

            if user_tools:
                lines.append('    <category type="user">')
                for tool in user_tools:
                    desc_attr = f' description="{tool["desc"]}"' if tool["desc"] else ""
                    lines.append(f'      <server id="{tool["id"]}" name="{tool["name"]}"{desc_attr}/>')
                lines.append("    </category>")

            lines.append("  </available>")

        if include_enabled and enabled_tools:
            # Sort enabled tools: Core > System > User, alphabetically within each
            core_enabled = []
            system_enabled = []
            user_enabled = []

            for tool_id in enabled_tools:
                server_id = tool_id.replace("server:", "") if tool_id.startswith("server:") else tool_id
                server_meta = mcp_metadata.get(server_id, {})
                is_core = server_meta.get("is_core", False)
                user_installed = server_meta.get("user_installed", False)

                if is_core:
                    core_enabled.append(tool_id)
                elif user_installed:
                    user_enabled.append(tool_id)
                else:
                    system_enabled.append(tool_id)

            core_enabled.sort(key=lambda x: x.lower())
            system_enabled.sort(key=lambda x: x.lower())
            user_enabled.sort(key=lambda x: x.lower())
            sorted_enabled = core_enabled + system_enabled + user_enabled

            lines.append("  <enabled>")
            for tool_id in sorted_enabled:
                lines.append(f"    <server>{tool_id}</server>")
            lines.append("  </enabled>")

        if len(lines) == 1:
            return ""

        lines.append("</tool_servers>")
        return "\n".join(lines)

    def _build_active_capability_tools(
        self,
        available_tools: list,
        enabled_tools: list,
        mcp_metadata: dict,
    ) -> list[dict]:
        """Build frontend capability entries from enabled tool ids with metadata fallback."""
        if not enabled_tools:
            return []

        available_by_id = {}
        for tool in available_tools or []:
            if not isinstance(tool, dict):
                continue
            tool_id = tool.get("id", "")
            if tool_id and tool_id not in available_by_id:
                available_by_id[tool_id] = tool

        active_tools = []
        seen_server_ids = set()

        for tool_id in enabled_tools:
            if not tool_id:
                continue

            server_id = tool_id.replace("server:", "", 1) if tool_id.startswith("server:") else tool_id
            if not server_id or server_id in seen_server_ids:
                continue

            seen_server_ids.add(server_id)
            tool = available_by_id.get(tool_id) or available_by_id.get(f"server:{server_id}") or {}
            server_meta = mcp_metadata.get(server_id, {})

            active_tools.append({
                "server_id": server_id,
                "display_name": server_meta.get("display_name") or tool.get("name", server_id),
                "icon_url": f"/api/v1/chats/mcp/servers/{server_id}/icon",
                "is_core": server_meta.get("is_core", False),
                "user_installed": server_meta.get("user_installed", False),
            })

        return active_tools

    @staticmethod
    def _is_skills_server_enabled(enabled_tools: Sequence[str]) -> bool:
        for tool_id in enabled_tools or []:
            normalized = str(tool_id).strip()
            if normalized in {"server:skills", "skills"}:
                return True
        return False

    @staticmethod
    def _is_agent_vm_server_enabled(enabled_tools: Sequence[str]) -> bool:
        for tool_id in enabled_tools or []:
            normalized = str(tool_id).strip()
            if normalized in {"server:agent-vm", "agent-vm"}:
                return True
        return False

    @staticmethod
    def _build_ask_user_question_policy(
        enabled_tools: Sequence[str],
        chat_id: Optional[str],
    ) -> str:
        """Build recency-weighted guidance for native ask-user modal use."""
        if not Filter._is_skills_server_enabled(enabled_tools):
            return ""

        lines = [
            "<ask_user_question_policy>",
            "  <tool>skills_ask_user_question</tool>",
            "  <instruction>When you have any question for the user, call skills_ask_user_question instead of asking inline.</instruction>",
            "  <instruction>Use this for clarifications, confirmations, choices, missing information, preferences, permission checks, and other question bundles.</instruction>",
            "  <instruction>Use 1-5 single-choice questions with concrete, distinct caller-supplied options; use freeform notes for extra context or open-ended details.</instruction>",
            '  <instruction>The modal automatically adds a generic "Something else" option to every question; do not provide fallback options such as "Something else", "Other", or "None of the above".</instruction>',
            "  <instruction>Do not provide options whose only purpose is for the user to describe, specify, or customize the answer in notes; open-ended details belong in freeform notes.</instruction>",
            "  <instruction>Ask inline only when the tool is unavailable or a direct answer does not require asking the user anything.</instruction>",
        ]

        if chat_id:
            safe_chat_id = html.escape(str(chat_id), quote=True)
            lines.append(f"  <chat_id>{safe_chat_id}</chat_id>")
            lines.append("  <instruction>Always pass this chat_id when calling the tool.</instruction>")
        else:
            lines.append("  <instruction>Pass the injected Chat ID value when calling the tool.</instruction>")

        lines.append("</ask_user_question_policy>")
        return "\n".join(lines)

    @staticmethod
    def _build_sensitive_information_policy(
        enabled_tools: Sequence[str],
        chat_id: Optional[str],
    ) -> str:
        """Build guidance for secure Agent VM secret collection."""
        if not Filter._is_agent_vm_server_enabled(enabled_tools):
            return ""

        lines = [
            "<sensitive_information_policy>",
            "  <tool>agent_vm_request_sensitive_information</tool>",
            "  <instruction>Never ask users to paste API keys, tokens, passwords, private keys, client secrets, or other secrets into chat.</instruction>",
            "  <instruction>When code execution needs one sensitive value and this tool is available, call agent_vm_request_sensitive_information instead of asking inline.</instruction>",
            "  <instruction>The tool returns only a temporary workspace file path and expiry metadata; use the file from code execution without reading, printing, echoing, summarizing, linking, or displaying the contents.</instruction>",
            "  <instruction>Never use this Agent VM flow to collect credentials that a custom MCP server must persist through required_env_vars: its temporary file cannot configure that server. Declare the variables and call mcp_assistant_trigger_guided_setup; the Configure flow must be the only credential prompt. An integration-specific workflow may still use this tool when it explicitly consumes the temporary file through code execution.</instruction>",
            "  <instruction>The generated file expires after 15 minutes.</instruction>",
        ]

        if chat_id:
            safe_chat_id = html.escape(str(chat_id), quote=True)
            lines.append(f"  <chat_id>{safe_chat_id}</chat_id>")
            lines.append("  <instruction>Always pass this chat_id when calling the tool.</instruction>")
        else:
            lines.append("  <instruction>Pass the injected Chat ID value when calling the tool.</instruction>")

        lines.append("</sensitive_information_policy>")
        return "\n".join(lines)

    # ═══════════════════════════════════════════════════════════════════════════
    # MODELS
    # ═══════════════════════════════════════════════════════════════════════════

    def _is_model_accessible_to_user(self, model_id: str, user: Optional[dict]) -> bool:
        """Best-effort model access check for current user."""
        if not MODEL_ACCESS_HELPERS_AVAILABLE:
            return True
        if not user or not isinstance(user, dict):
            return True

        user_id = user.get("id")
        if not user_id:
            return True

        try:
            model_info = OWUIModels.get_model_by_id(model_id)
            if not model_info:
                return True

            if user_id == getattr(model_info, "user_id", None):
                return True

            access_control = getattr(model_info, "access_control", None)
            if access_control is None:
                return True

            return bool(owui_has_access(user_id, type="read", access_control=access_control))
        except Exception:
            # Fail-open to avoid blocking chat on access lookup failures
            return True

    def _get_available_models(self, request: Any, user: Optional[dict] = None) -> tuple[list, int]:
        """Get available chat models from app state, preserving configured order."""
        if not request:
            return [], 0

        try:
            app_state = getattr(request, "app", None).state if getattr(request, "app", None) else None
            models_map = getattr(app_state, "MODELS", None) if app_state else None
            if not models_map:
                return [], 0

            model_order_list = []
            config = getattr(app_state, "config", None)
            if config:
                order = getattr(config, "MODEL_ORDER_LIST", None) or []
                if isinstance(order, str):
                    model_order_list = [m.strip() for m in order.split(",") if m.strip()]
                elif isinstance(order, (list, tuple)):
                    model_order_list = [str(m).strip() for m in order if str(m).strip()]

            order_map = {model_id: idx for idx, model_id in enumerate(model_order_list)}

            def is_embedding_model(model_id: str, model_name: str) -> bool:
                combined = f"{model_id} {model_name}".lower()
                return any(token in combined for token in ("embedding", "text-embedding", "embed"))

            normalized = []
            seen_ids = set()

            for raw_model in models_map.values():
                if not isinstance(raw_model, dict):
                    continue

                pipeline = raw_model.get("pipeline")
                if isinstance(pipeline, dict) and pipeline.get("type") == "filter":
                    continue

                model_id = str(raw_model.get("id", "")).strip()
                if not model_id or model_id in seen_ids:
                    continue

                if not self._is_model_accessible_to_user(model_id, user):
                    continue

                model_name = str(raw_model.get("name") or model_id).strip()
                if is_embedding_model(model_id, model_name):
                    continue

                if raw_model.get("is_active") is False:
                    continue

                info = raw_model.get("info", {}) if isinstance(raw_model.get("info"), dict) else {}
                info_meta = info.get("meta", {}) if isinstance(info.get("meta"), dict) else {}
                model_meta = raw_model.get("meta", {}) if isinstance(raw_model.get("meta"), dict) else {}
                if info_meta.get("hidden") is True or model_meta.get("hidden") is True:
                    continue
                base_model_id = info.get("base_model_id") or raw_model.get("base_model_id")

                normalized.append(
                    {
                        "id": model_id,
                        "name": model_name,
                        "base_model_id": str(base_model_id).strip() if base_model_id else "",
                    }
                )
                seen_ids.add(model_id)

            normalized.sort(
                key=lambda m: (
                    order_map.get(m["id"], float("inf")),
                    m["name"].lower(),
                    m["id"].lower(),
                )
            )

            total_count = len(normalized)
            if self.valves.max_models_in_context > 0:
                normalized = normalized[: self.valves.max_models_in_context]

            return normalized, total_count
        except Exception as e:
            logger.warning(f"Could not build model inventory context: {e}")
            return [], 0

    def _build_models_context(self, models: list, total_count: int, current_model_id: str) -> str:
        """Build model inventory context."""
        if not models:
            return ""

        base_models = [m for m in models if not m.get("base_model_id")]
        derived_models = [m for m in models if m.get("base_model_id")]
        truncated = total_count > len(models)

        lines = [
            "<models>",
            (
                f'  <available count="{len(models)}" total_count="{total_count}"'
                f' truncated="{str(truncated).lower()}">'
            ),
        ]

        def append_model_group(category_type: str, items: list) -> None:
            if not items:
                return
            lines.append(f'    <category type="{category_type}">')
            for model in items:
                model_id = html.escape(model["id"], quote=True)
                model_name = html.escape(model["name"], quote=True)
                base_attr = ""
                if model.get("base_model_id"):
                    base_attr = f' base_model_id="{html.escape(model["base_model_id"], quote=True)}"'
                lines.append(
                    f'      <model id="{model_id}" name="{model_name}"{base_attr}/>'
                )
            lines.append("    </category>")

        append_model_group("base", base_models)
        append_model_group("derived", derived_models)

        lines.extend(["  </available>", "</models>"])
        return "\n".join(lines)

    # ═══════════════════════════════════════════════════════════════════════════
    # SKILLS
    # ═══════════════════════════════════════════════════════════════════════════

    def _get_activated_skills(self, chat_id: str) -> list:
        """Get activated skill names from Redis."""
        if not self.redis_client or not chat_id:
            return []

        try:
            redis_key = f"chat_skills:{chat_id}"
            skills_json = self.redis_client.get(redis_key)
            return json.loads(skills_json) if skills_json else []
        except Exception:
            return []

    def _get_auto_enable_skill_servers(self, chat_id: str) -> list:
        """Get required MCP servers that were eligible for auto-enable at skill activation time."""
        if not self.redis_client or not chat_id:
            return []

        try:
            redis_key = f"chat_skill_auto_enable_servers:{chat_id}"
            servers_json = self.redis_client.get(redis_key)
            return json.loads(servers_json) if servers_json else []
        except Exception:
            return []

    def _store_auto_enable_skill_servers(self, chat_id: str, server_ids: list) -> None:
        """Persist the chat-scoped list of skill-required servers eligible for auto-enable."""
        if not self.redis_client or not chat_id:
            return

        try:
            redis_key = f"chat_skill_auto_enable_servers:{chat_id}"
            canonical = []
            for server_id in server_ids:
                if server_id and server_id not in canonical:
                    canonical.append(server_id)
            self.redis_client.setex(redis_key, 604800, json.dumps(canonical))
        except Exception as e:
            logger.error(f"Failed to store auto-enable skill servers: {e}")

    def _snapshot_skill_auto_enable_servers(self, chat_id: str, skill_name: str) -> None:
        """Record which required MCP servers were already eligible when the skill activated."""
        if not self.skill_manager or not chat_id:
            return

        metadata = self.skill_manager.get_skill_metadata(skill_name)
        if not metadata:
            return

        redis_key = f"chat_skill_auto_enable_servers:{chat_id}"
        existing_raw = self.redis_client.get(redis_key) if self.redis_client else None
        existing = self._get_auto_enable_skill_servers(chat_id)
        updated = list(existing)
        for server_id in metadata.required_mcp_servers or []:
            if not server_id:
                continue
            if self._is_server_auto_enable_eligible(server_id):
                updated.append(server_id)

        if updated != existing or existing_raw is None:
            self._store_auto_enable_skill_servers(chat_id, updated)

    def _get_subagent_explicit_skill_ids(self, chat_id: str) -> list:
        """Get explicit skill_ids supplied when a subagent chat was created."""
        if not self.redis_client or not chat_id:
            return []

        try:
            redis_key = f"subagent_explicit_skills:{chat_id}"
            skills_json = self.redis_client.get(redis_key)
            return json.loads(skills_json) if skills_json else []
        except Exception:
            return []

    def _is_delegated_subagent_chat(self, chat_id: str) -> bool:
        """Return whether the chat was created by the delegated subagent flow."""
        if not self.redis_client or not chat_id:
            return False

        try:
            return bool(self.redis_client.exists(f"subagent_chat:{chat_id}"))
        except Exception:
            return False

    def _should_skip_subagent_keyword_auto_activation(self, chat_id: str, messages: list) -> bool:
        """Skip keyword auto-activation for delegated subagent prompts with explicit skill_ids.

        Delegated subagent prompts are machine-generated task contracts, not free-form
        end-user messages. When the parent already supplied explicit skill_ids, broad
        trigger terms like "search" or "documents" can spuriously expand the tool
        surface. Keep the explicit subagent skills authoritative for the initial
        delegated run while the chat still contains only that original user message.
        """
        if not chat_id:
            return False

        explicit_skill_ids = self._get_subagent_explicit_skill_ids(chat_id)
        if not explicit_skill_ids:
            return False

        user_message_count = sum(1 for msg in messages or [] if msg.get("role") == "user")
        return user_message_count <= 1

    def _activate_skill_for_chat(self, skill_name: str, chat_id: str) -> bool:
        """Activate a skill for a chat session via keyword auto-activation only."""
        if not self.redis_client or not chat_id:
            return False

        try:
            with self._chat_capabilities_lock(chat_id):
                redis_key = f"chat_skills:{chat_id}"
                activated = self._get_activated_skills(chat_id)

                if skill_name in activated:
                    return True

                activated.append(skill_name)
                self.redis_client.setex(redis_key, 604800, json.dumps(activated))
                self._snapshot_skill_auto_enable_servers(chat_id, skill_name)
                logger.info(f"Activated skill '{skill_name}' for chat {chat_id}")

            return True
        except Exception as e:
            logger.error(f"Failed to activate skill: {e}")
            return False

    def _load_toggles(self) -> dict:
        """Load and cache mcp_toggles.json for the current request.

        Prefers the health-status snapshot: it is reached through a DIRECTORY
        bind mount, which keeps following the host's atomic rename
        replacements, while the individual /app/mcp_toggles.json file bind can
        pin a stale inode after the host rewrites the file (observed live,
        PORTICO-410 round). Falls back to the direct file, then {}.

        Called once per request; subsequent calls return the cached dict.
        Cache is reset at the start of each inlet() invocation.
        """
        cached = getattr(self, "_toggles_cache", None)
        if cached is not None:
            return cached
        toggles: dict = {}
        for toggles_path in (
            "/app/health-status/mcp_toggles_snapshot.json",
            "/app/mcp_toggles.json",
        ):
            try:
                with open(toggles_path, "r") as f:
                    parsed = json.load(f)
            except Exception:
                continue
            if isinstance(parsed, dict) and isinstance(parsed.get("toggles"), dict):
                parsed = parsed["toggles"]
            if not isinstance(parsed, dict):
                continue
            toggles = parsed
            break
        self._toggles_cache = toggles
        return toggles

    def _is_server_toggled_on(self, server_id: str) -> bool:
        """Check if a server is enabled in mcp_toggles.json.

        Returns True if the server is toggled on or if toggles can't be read
        (fail-open for backwards compatibility).
        """
        toggles = self._load_toggles()
        # Strip "server:" prefix for lookup
        bare_id = server_id.replace("server:", "") if server_id.startswith("server:") else server_id
        # If server not in toggles, default to True (fail-open)
        return toggles.get(bare_id, True)

    def _disable_modes_paths(self) -> list:
        """Candidate paths for the PORTICO-410 hard-disable sidecar, most trusted first.

        The health-status directory is a directory bind mount, so its snapshot
        follows atomic host-side file replacements; the direct file bind is a
        fallback (individual file binds can pin a stale inode after rename).
        """
        paths = []
        env_path = os.getenv("PORTICO_DISABLE_MODES_PATH")
        if env_path:
            paths.append(env_path)
        paths.append("/app/health-status/mcp_disable_modes_snapshot.json")
        paths.append("/app/mcp_disable_modes.json")
        return paths

    def _load_disable_modes(self) -> dict:
        """Load and cache mcp_disable_modes.json for the current request.

        Accepts either the snapshot wrapper ({"modes": {...}}) or a bare map.
        Fail-open: any read/parse problem yields {} (no hard disables), which
        degrades to today's soft-disable behavior. Cache is reset at the start
        of each inlet() invocation.
        """
        cached = getattr(self, "_disable_modes_cache", None)
        if cached is not None:
            return cached
        modes: dict = {}
        for modes_path in self._disable_modes_paths():
            try:
                with open(modes_path, "r") as f:
                    parsed = json.load(f)
            except Exception:
                continue
            if isinstance(parsed, dict) and isinstance(parsed.get("modes"), dict):
                parsed = parsed["modes"]
            if not isinstance(parsed, dict):
                continue
            modes = {
                str(server_id): value.strip().lower()
                for server_id, value in parsed.items()
                if isinstance(value, str)
            }
            break
        self._disable_modes_cache = modes
        return modes

    def _is_server_hard_disabled(self, server_id: str) -> bool:
        """True when the user hard-disabled this server (PORTICO-410).

        Hard-disabled servers must be fully opaque to the model: excluded from
        every integrations listing, regardless of toggle readability.
        """
        if not server_id:
            return False
        bare_id = server_id.replace("server:", "") if server_id.startswith("server:") else server_id
        return self._load_disable_modes().get(bare_id) == "hard"

    def _get_hard_disabled_server_ids(self) -> set:
        """All server ids currently hard-disabled (blank ids ignored)."""
        return {
            str(server_id).strip()
            for server_id, mode in self._load_disable_modes().items()
            if mode == "hard" and str(server_id).strip()
        }

    def _get_history_sanitize_server_ids(self) -> set:
        """Server ids whose stale tool history must be scrubbed (Phase 3b).

        Union of the model-visible disabled listing and the hard-disabled set:
        hard-disabled servers are excluded from `_get_disabled_integrations`
        (opacity, PORTICO-410) but their old tool results still need sanitizing.
        """
        disabled_ids = {info["id"] for info in self._get_disabled_integrations()}
        return disabled_ids | self._get_hard_disabled_server_ids()

    def _health_status_file_path(self) -> str:
        return os.getenv("PORTICO_HEALTH_STATUS_PATH") or HEALTH_STATUS_PATH

    def _health_status_stale_ms(self) -> int:
        raw_value = os.getenv("HEALTH_STATUS_STALE_MS")
        if not raw_value:
            return HEALTH_STATUS_STALE_MS
        try:
            return max(0, int(raw_value))
        except ValueError:
            return HEALTH_STATUS_STALE_MS

    def _load_health_status_snapshot(self) -> dict:
        """Load the periodic MCP health snapshot from the local read-only mount."""
        cached_snapshot = getattr(self, "_health_status_snapshot_cache", None)
        if cached_snapshot is not None:
            return cached_snapshot

        path = self._health_status_file_path()
        try:
            with open(path, "r") as f:
                payload = json.load(f)
            if not isinstance(payload, dict):
                payload = {}
        except Exception as e:
            logger.debug(f"Could not read MCP health snapshot from {path}: {e}")
            payload = {}

        self._health_status_snapshot_cache = payload
        return payload

    def _health_snapshot_timestamp_ms(self, snapshot: dict) -> Optional[int]:
        timestamp = snapshot.get("timestamp") if isinstance(snapshot, dict) else None
        if isinstance(timestamp, (int, float)):
            return int(timestamp * 1000)

        timestamp_iso = snapshot.get("timestamp_iso") if isinstance(snapshot, dict) else None
        if isinstance(timestamp_iso, str) and timestamp_iso.strip():
            try:
                return int(datetime.datetime.fromisoformat(
                    timestamp_iso.strip().replace("Z", "+00:00")
                ).timestamp() * 1000)
            except ValueError:
                return None

        return None

    def _is_health_snapshot_stale(self, snapshot: dict) -> bool:
        if not snapshot:
            return True

        stale_ms = self._health_status_stale_ms()
        if stale_ms <= 0:
            return False

        timestamp_ms = self._health_snapshot_timestamp_ms(snapshot)
        if timestamp_ms is None:
            return True

        age_ms = int(time.time() * 1000) - timestamp_ms
        return age_ms > stale_ms

    def _get_health_snapshot_server_entry(
        self,
        server_id: str,
        snapshot: Optional[dict] = None,
    ) -> Optional[dict]:
        snapshot = snapshot if snapshot is not None else self._load_health_status_snapshot()
        servers = snapshot.get("servers") if isinstance(snapshot, dict) else None
        if not isinstance(servers, dict):
            return None

        bare_id = (
            server_id.replace("server:", "", 1)
            if server_id.startswith("server:")
            else server_id
        )
        entry = servers.get(bare_id) or servers.get(server_id)
        return entry if isinstance(entry, dict) else None

    def _readiness_from_health_snapshot(
        self,
        server_id: str,
        snapshot: Optional[dict] = None,
    ) -> dict:
        """Classify MCP readiness from the cached health-check snapshot only.

        Missing, stale, or unknown health data intentionally fails open for
        prompt construction. Runtime tool calls remain the enforcement point.
        """
        snapshot = snapshot if snapshot is not None else self._load_health_status_snapshot()
        bare_id = (
            server_id.replace("server:", "", 1)
            if server_id.startswith("server:")
            else server_id
        )
        base_result = {
            "healthy": False,
            "readiness_phase": "unknown",
            "_fetch_failed": False,
            "_from_health_snapshot": True,
        }

        if self._is_health_snapshot_stale(snapshot):
            return {
                **base_result,
                "_snapshot_stale": True,
            }

        entry = self._get_health_snapshot_server_entry(bare_id, snapshot)
        if not entry:
            return {
                **base_result,
                "_snapshot_missing": True,
            }

        def normalized_text(*keys: str) -> str:
            for key in keys:
                value = entry.get(key)
                if value is None:
                    continue
                text = str(value).strip().lower()
                if text:
                    return text
            return ""

        status = normalized_text("status")
        readiness_phase = normalized_text("readiness_phase", "readinessPhase")
        oauth_state = normalized_text("oauth_state", "oauthState")
        configured = entry.get("configured")
        disabled_by_user = entry.get("disabled_by_user") is True
        healthy = bool(entry.get("healthy")) or status == "healthy" or readiness_phase == "tool_ready"

        if disabled_by_user or status == "disabled" or readiness_phase == "disabled":
            normalized_phase = "disabled"
            healthy = False
        elif (
            status == "waiting_callback"
            or readiness_phase == "waiting_callback"
            or oauth_state == "waiting_callback"
        ):
            normalized_phase = "waiting_callback"
            healthy = False
        elif (
            status == "needs_oauth"
            or readiness_phase == "needs_oauth"
            or oauth_state in {"active", "pending", "checking"}
        ):
            normalized_phase = "needs_oauth"
            healthy = False
        elif (
            status in HEALTH_STATUS_TERMINAL_CONFIG_PHASES
            or readiness_phase in HEALTH_STATUS_TERMINAL_CONFIG_PHASES
            or configured is False
        ):
            normalized_phase = "needs_config"
            healthy = False
        elif healthy:
            normalized_phase = "tool_ready"
            healthy = True
        elif status:
            normalized_phase = status
        elif readiness_phase:
            normalized_phase = readiness_phase
        else:
            normalized_phase = "unknown"

        return {
            **entry,
            "healthy": healthy,
            "readiness_phase": normalized_phase,
            "_fetch_failed": False,
            "_from_health_snapshot": True,
        }

    def _get_server_readiness(self, server_id: str) -> dict:
        """Return cached health-check readiness without prompt-path HTTP probes."""
        return self._readiness_from_health_snapshot(server_id)

    def _get_server_readiness_bulk(self, server_ids: Sequence[str]) -> dict[str, dict]:
        """Return cached health-check readiness for several servers."""
        bare_ids = []
        seen = set()
        for server_id in server_ids:
            bare_id = server_id.replace("server:", "") if server_id.startswith("server:") else server_id
            if bare_id and bare_id not in seen:
                seen.add(bare_id)
                bare_ids.append(bare_id)
        if not bare_ids:
            return {}

        snapshot = self._load_health_status_snapshot()
        return {
            bare_id: self._readiness_from_health_snapshot(bare_id, snapshot)
            for bare_id in bare_ids
        }

    def _prime_server_readiness_cache(
        self,
        server_ids: Sequence[str],
        readiness_cache: dict[str, dict],
    ) -> None:
        missing_ids = []
        for server_id in server_ids:
            if server_id not in readiness_cache:
                missing_ids.append(server_id)
        if not missing_ids:
            return
        snapshot = self._load_health_status_snapshot()
        for server_id in missing_ids:
            bare_id = server_id.replace("server:", "") if server_id.startswith("server:") else server_id
            readiness_cache[server_id] = self._readiness_from_health_snapshot(bare_id, snapshot)

    def _is_server_tool_ready(self, server_id: str) -> bool:
        """Return True only when the server is actually callable."""
        readiness = self._get_server_readiness(server_id)
        return bool(readiness.get("healthy")) and readiness.get("readiness_phase") == "tool_ready"

    @staticmethod
    def _is_truthy_fragment_env(value: Any) -> bool:
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "on"}
        return False

    def _load_server_fragment_payload(self, server_id: str) -> Optional[dict]:
        cache = getattr(self, "_fragment_payload_cache", None)
        if cache is None:
            cache = {}
            self._fragment_payload_cache = cache

        if server_id in cache:
            return cache[server_id]

        system_dir = os.path.join("/app/mcp-configs", server_id)
        base_dirs = (
            ("/app/mcp-configs",)
            if os.path.isdir(system_dir)
            else ("/app/mcp-configs-user",)
        )
        for base_dir in base_dirs:
            fragment_path = os.path.join(base_dir, server_id, f"{server_id}.fragment")
            if not os.path.isfile(fragment_path):
                continue
            try:
                with open(fragment_path, "r") as f:
                    payload = json.load(f) or {}
                cache[server_id] = payload if isinstance(payload, dict) else None
            except Exception as e:
                logger.warning(
                    f"Failed to load fragment for {server_id} from {fragment_path}: {e}"
                )
                cache[server_id] = None
            return cache[server_id]

        cache[server_id] = None
        return None

    def _server_uses_external_oauth21(self, server_id: str) -> bool:
        fragment = self._load_server_fragment_payload(server_id)
        if not isinstance(fragment, dict):
            return False

        env = fragment.get("env") or {}
        if not isinstance(env, dict):
            return False

        return self._is_truthy_fragment_env(
            env.get("MCP_ENABLE_OAUTH21")
        ) and self._is_truthy_fragment_env(env.get("EXTERNAL_OAUTH21_PROVIDER"))

    def _ensure_tool_server_connections(self, request) -> bool:
        """Sync TOOL_SERVER_CONNECTIONS with current MCP toggle state.

        Bidirectional sync:
        - Adds connections for toggled-on servers missing from connections
          (e.g., user enabled an integration after health check ran).
        - Removes connections for toggled-off optional servers
          (e.g., user disabled an integration mid-session).

        Core servers (served via the shared core proxy route) are never removed;
        only optional servers on the regular proxy route are managed by toggles.

        When changes occur, also invalidates the Redis tool_servers cache so
        stale tool specs are cleared immediately.

        Returns True if any connections were added or removed.
        """
        config_dirs = ("/app/mcp-configs", "/app/mcp-configs-user")
        if not YAML_AVAILABLE or not any(os.path.isdir(path) for path in config_dirs):
            return False
        system_ids = {
            entry
            for entry in os.listdir(config_dirs[0])
            if os.path.isdir(os.path.join(config_dirs[0], entry))
        } if os.path.isdir(config_dirs[0]) else set()

        try:
            connections = request.app.state.config.TOOL_SERVER_CONNECTIONS
            if hasattr(connections, 'value'):
                current_connections = list(connections.value)
            else:
                current_connections = list(connections)

            existing_ids = {c.get("info", {}).get("id") for c in current_connections}

            # --- Add missing toggled-on servers ---
            added = []
            for configs_dir in config_dirs:
                if not os.path.isdir(configs_dir):
                    continue
                for entry in os.listdir(configs_dir):
                    if configs_dir == "/app/mcp-configs-user" and entry in system_ids:
                        continue
                    yaml_path = os.path.join(configs_dir, entry, f"{entry}.yaml")
                    if not os.path.isfile(yaml_path):
                        continue
                    try:
                        with open(yaml_path, "r") as f:
                            config = yaml.safe_load(f) or {}
                    except Exception:
                        continue

                    server_id = config.get("id", entry)

                    if server_id in existing_ids:
                        continue
                    if not self._is_server_toggled_on(server_id):
                        continue

                    display_name = config.get("display_name",
                                              server_id.replace('-', ' ').replace('_', ' ').title())
                    description = config.get("description", "")
                    auth_type = (
                        "oauth_2.1"
                        if self._server_uses_external_oauth21(server_id)
                        else "bearer"
                    )

                    connection = {
                        "url": f"{self._get_mcpo_base_url(is_core=bool(config.get('is_core', False)))}/{server_id}",
                        "path": "openapi.json",
                        "type": "openapi",
                        "auth_type": auth_type,
                        "headers": None,
                        "key": "",
                        "config": {"enable": True, "access_control": None},
                        "info": {
                            "id": server_id,
                            "name": display_name,
                            "description": description,
                        },
                    }
                    current_connections.append(connection)
                    existing_ids.add(server_id)
                    added.append(server_id)

            # --- Remove toggled-off optional servers ---
            # Only remove servers on the regular route; keep core-route servers.
            removed = []
            filtered_connections = []
            core_base_url = self._get_mcpo_base_url(is_core=True)
            for conn in current_connections:
                server_id = conn.get("info", {}).get("id", "")
                url = (conn.get("url", "") or "").rstrip("/")
                is_optional = not url.startswith(f"{core_base_url}/")
                if is_optional and server_id and not self._is_server_toggled_on(server_id):
                    removed.append(server_id)
                else:
                    filtered_connections.append(conn)

            changed = bool(added or removed)
            if changed:
                if added:
                    logger.info(f"Dynamically registering tool server connections: {added}")
                if removed:
                    logger.info(f"Removing disabled tool server connections: {removed}")
                request.app.state.config.TOOL_SERVER_CONNECTIONS = filtered_connections

                # Invalidate Redis tool_servers cache so stale specs are cleared
                try:
                    redis_client = getattr(request.app.state, 'redis', None)
                    if redis_client is not None:
                        asyncio.get_event_loop().create_task(
                            redis_client.delete("tool_servers")
                        )
                    elif self.redis_client:
                        self.redis_client.delete("tool_servers")
                except Exception as e:
                    logger.debug(f"Could not invalidate tool_servers cache: {e}")

                return True
        except Exception as e:
            logger.error(f"Error ensuring tool server connections: {e}")

        return False

    def _auto_enable_mcp_servers(self, chat_id: str, server_ids: list, lock: bool = True):
        """Auto-enable MCP servers for a skill."""
        if not self.redis_client or not chat_id or not server_ids:
            return

        try:
            lock_ctx = self._chat_capabilities_lock(chat_id) if lock else nullcontext()
            with lock_ctx:
                redis_key = f"chat_tools:{chat_id}"
                existing_json = self.redis_client.get(redis_key)
                existing = json.loads(existing_json) if existing_json else []

                for server_id in server_ids:
                    if not self._should_auto_enable_skill_server(chat_id, server_id):
                        logger.info(
                            "Leaving MCP server '%s' for explicit chat activation on chat %s",
                            server_id,
                            chat_id,
                        )
                        continue
                    if server_id not in existing:
                        existing.append(server_id)
                        logger.info(f"Auto-enabled MCP server '{server_id}' for chat {chat_id}")

                self.redis_client.setex(redis_key, 604800, json.dumps(existing))
        except Exception as e:
            logger.error(f"Failed to auto-enable MCP servers: {e}")

    def _seed_chat_tool_servers(self, chat_id: str, server_ids: Sequence[str]) -> None:
        """Union explicit tool servers into chat_tools without the skill-readiness
        gate. Used to attach an agent's user-configured MCP servers (the user
        deliberately chose them) — Phase 3's per-turn filter still drops un-ready
        servers from the actual request while keeping them as chat intent."""
        if not self.redis_client or not chat_id or not server_ids:
            return

        try:
            with self._chat_capabilities_lock(chat_id):
                redis_key = f"chat_tools:{chat_id}"
                existing_json = self.redis_client.get(redis_key)
                existing = json.loads(existing_json) if existing_json else []
                changed = False
                for server_id in server_ids:
                    if server_id and server_id not in existing:
                        existing.append(server_id)
                        changed = True
                        logger.info(
                            "Seeded agent MCP server '%s' for chat %s", server_id, chat_id
                        )
                if changed:
                    self.redis_client.setex(redis_key, 604800, json.dumps(existing))
        except Exception as e:
            logger.error(f"Failed to seed chat tool servers: {e}")

    def _get_seeded_agent_tool_servers(self, chat_id: str) -> list:
        """The agent-configured MCP servers to keep attached as chat intent. These
        are re-merged into the persisted chat_tools every turn so a server that was
        un-ready (unauth/toggled-off) on the first turn still attaches once it
        becomes ready — standalone agent servers have no per-turn reconcile like
        skill-required servers do."""
        if not self.redis_client or not chat_id:
            return []
        try:
            raw = self.redis_client.get(f"agent_seeded_tool_servers:{chat_id}")
            value = json.loads(raw) if raw else []
            return value if isinstance(value, list) else []
        except Exception:
            return []

    def _seed_agent_capabilities_if_needed(self, chat_id: str, model: Any) -> None:
        """On the FIRST turn of a UI-selected custom-agent chat, attach the agent's
        configured skills + MCP servers so they are active immediately (no need for
        the model to call activate/toggle first).

        Idempotent via a Redis flag (seed once, then respect the chat's own state).
        Delegated subagent chats are already seeded by the Rust start_subagent_run,
        so they're skipped. Capabilities are read from the in-memory model meta —
        no HTTP call on the prompt hot path.
        """
        if not self.redis_client or not chat_id or not isinstance(model, dict):
            return

        # Flag check FIRST so a chat that's already been handled (seeded OR
        # delegated-skipped) short-circuits on a single Redis GET every turn.
        flag_key = f"agent_capabilities_seeded:{chat_id}"
        try:
            if self.redis_client.get(flag_key):
                return
        except Exception:
            return

        def _mark_handled():
            try:
                self.redis_client.setex(flag_key, 604800, "1")
            except Exception as e:
                logger.warning(f"Failed to mark agent capabilities seeded for {chat_id}: {e}")

        # Delegated subagent chats are pre-seeded by start_subagent_run — mark
        # handled so subsequent turns also short-circuit on the flag GET.
        if self._is_delegated_subagent_chat(chat_id):
            _mark_handled()
            return

        meta = {}
        info = model.get("info")
        if isinstance(info, dict) and isinstance(info.get("meta"), dict):
            meta = info["meta"]
        elif isinstance(model.get("meta"), dict):
            meta = model["meta"]

        raw_skill_ids = meta.get("subagent_skill_ids")
        skill_ids = (
            [str(s).strip() for s in raw_skill_ids if str(s or "").strip()]
            if isinstance(raw_skill_ids, list)
            else []
        )

        raw_tool_server_ids = meta.get("subagent_tool_server_ids")
        server_ids = []
        if isinstance(raw_tool_server_ids, list):
            for sid in raw_tool_server_ids:
                text = str(sid or "").strip()
                if not text:
                    continue
                if not text.startswith("server:"):
                    text = f"server:{text}"
                if text not in server_ids:
                    server_ids.append(text)

        for skill_id in skill_ids:
            self._activate_skill_for_chat(skill_id, chat_id)

        if server_ids:
            self._seed_chat_tool_servers(chat_id, server_ids)
            # Persist as chat intent so Phase 3's readiness filter can't drop an
            # un-ready server permanently (it re-merges every turn — see
            # _get_seeded_agent_tool_servers).
            try:
                self.redis_client.setex(
                    f"agent_seeded_tool_servers:{chat_id}", 604800, json.dumps(server_ids)
                )
            except Exception as e:
                logger.warning(f"Failed to persist seeded agent servers for {chat_id}: {e}")

        _mark_handled()

        logger.info(
            "Seeded agent capabilities for chat %s: %d skill(s), %d MCP server(s)",
            chat_id,
            len(skill_ids),
            len(server_ids),
        )

    def _is_server_auto_enable_eligible(self, server_id: str) -> bool:
        """Return True if a required MCP server is currently safe to attach automatically."""
        if not self._is_server_toggled_on(server_id):
            return False
        if not self._is_server_tool_ready(server_id):
            return False
        return True

    def _should_auto_enable_skill_server(self, chat_id: str, server_id: str) -> bool:
        """Return True when a skill-required MCP server should auto-attach to the chat.

        Core/always-enabled dependencies may always auto-enable once ready.
        Optional integrations only auto-enable if they were already enabled and
        tool_ready when the skill originally activated for this chat.
        """
        if not YAML_AVAILABLE:
            return False

        bare_id = server_id.replace("server:", "", 1) if server_id.startswith("server:") else server_id
        if not bare_id:
            return False

        system_dir = os.path.join("/app/mcp-configs", bare_id)
        candidate_dirs = (
            ("/app/mcp-configs",)
            if os.path.isdir(system_dir)
            else ("/app/mcp-configs-user",)
        )
        for base_dir in candidate_dirs:
            yaml_path = os.path.join(base_dir, bare_id, f"{bare_id}.yaml")
            if not os.path.isfile(yaml_path):
                continue

            try:
                with open(yaml_path, "r") as f:
                    config = yaml.safe_load(f) or {}
            except Exception as e:
                logger.debug(
                    "Failed to read MCP server config for skill auto-enable (%s): %s",
                    bare_id,
                    e,
                )
                continue

            if config.get("is_core", False) or config.get("always_enabled", False):
                return self._is_server_auto_enable_eligible(server_id)

            auto_enable_servers = self._get_auto_enable_skill_servers(chat_id)
            return (
                server_id in auto_enable_servers
                and self._is_server_auto_enable_eligible(server_id)
            )

        return False

    def _get_required_skill_servers(self, skill_names: Sequence[str]) -> list[str]:
        """Return the de-duplicated MCP servers required by the given skills."""
        if not self.skill_manager or not skill_names:
            return []

        required_servers = []
        for skill_name in skill_names:
            metadata = self.skill_manager.get_skill_metadata(skill_name)
            if not metadata:
                continue
            for server_id in metadata.required_mcp_servers or []:
                if server_id and server_id not in required_servers:
                    required_servers.append(server_id)
        return required_servers

    def _reconcile_activated_skill_servers(self, chat_id: str, skill_names: Sequence[str]) -> list[str]:
        """Attach ready MCP dependencies for activated skills to the chat."""
        required_servers = self._get_required_skill_servers(skill_names)
        if not required_servers:
            return []

        logger.info(
            "Reconciling %d required MCP server(s) for activated skills %s",
            len(required_servers),
            list(skill_names),
        )
        self._auto_enable_mcp_servers(chat_id, required_servers)
        return required_servers

    def _get_user_message(self, messages: list) -> Optional[str]:
        """Extract the latest user message."""
        for msg in reversed(messages):
            if msg.get("role") == "user":
                content = msg.get("content", "")
                if isinstance(content, str):
                    return content
                elif isinstance(content, list):
                    text_parts = [p.get("text", "") for p in content if p.get("type") == "text"]
                    return " ".join(text_parts)
        return None

    async def _notify_capabilities_changed(self, chat_id: str, tools: list = None, skills: list = None):
        """Notify backend of capabilities change for real-time OWUI display.

        Args:
            chat_id: The chat ID to notify
            tools: List of tool dicts with server_id, display_name, icon_url, is_core, user_installed
            skills: List of skill name strings
        """
        if not HTTPX_AVAILABLE:
            return

        try:
            # Format skills if provided as simple strings
            formatted_skills = []
            if skills:
                for s in skills:
                    if isinstance(s, dict):
                        formatted_skills.append(s)
                    else:
                        display_name = " / ".join(
                            part.replace("-", " ").title() for part in str(s).split("/")
                        )
                        formatted_skills.append({"name": s, "display_name": display_name})

            payload = {
                "tools": tools or [],
                "skills": formatted_skills
            }

            url = f"http://open-webui:8080/api/v1/chats/{chat_id}/capabilities-changed"
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.post(url, json=payload)
                logger.info(f"Notified capabilities change for chat {chat_id}: {len(tools or [])} tools, {len(formatted_skills)} skills")
        except Exception as e:
            logger.warning(f"Failed to notify capabilities change: {e}")

    def _build_skill_instructions(self, activated_skills: list) -> str:
        """Generate skill usage instructions with consistent XML structure."""
        lines = [
            "<skills>",
            "  <instructions>",
            "    <description>Agent Skills are specialized capabilities loaded on-demand.</description>",
            "",
            "    <activation_rules>",
            "      <rule>Review available_skills section below when user requests a task</rule>",
            "      <rule>If ANY skill's description matches user intent, activate it IMMEDIATELY</rule>",
            "      <rule>Use semantic understanding - 'make an artifact' = 'create artifact'</rule>",
            "      <rule>Skills provide specialized tools, references, and detailed instructions</rule>",
            "    </activation_rules>",
            "",
            "    <usage>",
            '      <activate>skills_activate_skill(skill_name="skill-name", chat_id="&lt;chat_id&gt;")</activate>',
            "      <result>Once activated, detailed instructions appear in activated_skill tags</result>",
            "      <persistence>Skills persist for the chat session (7 days)</persistence>",
            "    </usage>",
            "",
            "    <references>",
            "      <description>Activated skills may have available_references or SKILL.md links to additional documentation</description>",
            '      <load>skills_get_skill_reference(skill_name="skill-name", reference_path="pptxgenjs.md")</load>',
            "      <path_rule>Use the safe skill-relative path exactly as linked, such as editing.md, pptxgenjs.md, or references/file.md.</path_rule>",
            "    </references>",
        ]

        if activated_skills:
            lines.extend([
                "",
                f'    <status activated="{", ".join(activated_skills)}">Follow instructions in activated_skill tags below.</status>',
            ])
        else:
            lines.extend([
                "",
                '    <status activated="none">Activate skills as needed based on user request.</status>',
            ])

        lines.append("  </instructions>")
        return "\n".join(lines)

    def _build_skills_context(self, all_skills: list, activated_skills: list) -> str:
        """Build complete skills context with consistent XML structure."""
        lines = []

        # Skill instructions (opens <skills> and <instructions>)
        lines.append(self._build_skill_instructions(activated_skills))

        # Available skills (from skill_manager) - indent to fit inside <skills>
        if self.skill_manager and all_skills:
            skills_prompt = self.skill_manager.format_skills_for_prompt(all_skills)
            # Indent the available_skills content
            indented = "\n".join("  " + line if line else "" for line in skills_prompt.split("\n"))
            lines.append("")
            lines.append(indented)

        # Activated skill content - indent to fit inside <skills>
        for skill_name in activated_skills:
            if self.skill_manager:
                skill_content = self.skill_manager.format_activated_skill(skill_name)
                if skill_content:
                    indented = "\n".join("  " + line if line else "" for line in skill_content.split("\n"))
                    lines.append("")
                    lines.append(indented)

        # Close <skills>
        lines.append("</skills>")

        return "\n".join(lines)

    # ═══════════════════════════════════════════════════════════════════════════
    # WORKSPACE FILES
    # ═══════════════════════════════════════════════════════════════════════════

    def _should_extract_zip(self, content_type: str, filename: str) -> bool:
        """Check if file is a zip that should be auto-extracted."""
        if content_type == "application/zip":
            return True
        if filename and filename.lower().endswith('.zip'):
            return True
        return False

    def _extract_zip_to_workspace(
        self,
        chat_id: str,
        zip_path: str,
        zip_filename: str,
        workspace_manager,
    ) -> list:
        """
        Extract zip file contents to workspace input directory.

        Args:
            chat_id: Chat session ID
            zip_path: Full path to the copied zip file
            zip_filename: Original zip filename (for logging)
            workspace_manager: WorkspaceManager instance

        Returns:
            List of extracted file metadata dicts
        """
        import zipfile

        extracted = []

        # Extract directly into the shared chat workspace root.
        workspace_root_dir = workspace_manager.get_workspace_path(chat_id)
        if not workspace_root_dir:
            logger.error(f"[Skills] Could not get workspace dir for chat {chat_id}")
            return []

        # Determine extraction subdirectory (zip filename without extension)
        extract_dir_name = zip_filename.rsplit('.', 1)[0] if '.' in zip_filename else zip_filename
        extract_path = os.path.join(workspace_root_dir, extract_dir_name)

        try:
            with zipfile.ZipFile(zip_path, 'r') as zf:
                # Security: check for path traversal in zip
                safe_members = []
                for name in zf.namelist():
                    if name.startswith('/') or '..' in name:
                        logger.warning(f"[Skills] Skipping unsafe path in zip: {name}")
                        continue
                    safe_members.append(name)

                # Check total uncompressed size (100MB limit)
                total_size = sum(info.file_size for info in zf.infolist() if info.filename in safe_members)
                if total_size > 100 * 1024 * 1024:
                    logger.warning(f"[Skills] Zip contents too large ({total_size} bytes), skipping extraction")
                    return []

                # Clean old extraction directory to prevent stale files
                if os.path.exists(extract_path):
                    import shutil
                    shutil.rmtree(extract_path)
                    logger.info(f"[Skills] Cleaned old extraction directory: {extract_dir_name}/")

                # Create fresh extraction directory
                os.makedirs(extract_path, exist_ok=True)

                # Extract safe members only
                for member in safe_members:
                    zf.extract(member, extract_path)

                logger.info(f"[Skills] Extracted {zip_filename} to {extract_dir_name}/")

                # Build list of extracted files
                for root, dirs, files in os.walk(extract_path):
                    for filename in files:
                        full_path = os.path.join(root, filename)
                        rel_path = os.path.relpath(full_path, workspace_root_dir)
                        file_size = os.path.getsize(full_path)

                        extracted.append({
                            "name": filename,
                            "workspace_path": rel_path.replace(os.sep, "/"),
                            "extracted_from": zip_filename,
                            "size": file_size,
                        })

                logger.info(f"[Skills] Extracted {len(extracted)} files from {zip_filename}")

        except zipfile.BadZipFile:
            logger.error(f"[Skills] Invalid zip file: {zip_filename}")
        except Exception as e:
            logger.error(f"[Skills] Failed to extract {zip_filename}: {e}")

        return extracted

    def _auto_copy_files_to_workspace(
        self,
        chat_id: str,
        files: list,
        vm_id: Optional[str] = None,
    ) -> list:
        """Auto-copy attached files to the shared chat workspace root."""
        logger.info("[Skills] " + "-" * 50)
        logger.info("[Skills] 📂 Auto-copy files to workspace")
        logger.info(f"[Skills]    Chat ID: {chat_id}")
        if vm_id:
            logger.info(f"[Skills]    VM ID: {vm_id}")
        logger.info(f"[Skills]    Files to process: {len(files)}")
        logger.info(f"[Skills]    WORKSPACE_MANAGER_AVAILABLE: {WORKSPACE_MANAGER_AVAILABLE}")

        if not WORKSPACE_MANAGER_AVAILABLE:
            logger.warning("[Skills]    ❌ WorkspaceManager not available, skipping auto-copy")
            logger.info("[Skills] " + "-" * 50)
            return []

        try:
            workspace_manager = get_workspace_manager()
            logger.info("[Skills]    ✅ Got WorkspaceManager instance")
        except Exception as e:
            logger.error(f"[Skills]    ❌ Failed to get workspace manager: {e}")
            logger.info("[Skills] " + "-" * 50)
            return []

        copied = []
        for i, file_info in enumerate(files):
            file_path = file_info.get("path")
            filename = file_info.get("name")
            file_id = file_info.get("id", "unknown")
            file_size = file_info.get("size", 0)
            content_type = file_info.get("content_type", "unknown")

            logger.info(f"[Skills]    Processing file [{i + 1}/{len(files)}]:")
            logger.info(f"[Skills]       Name: {filename}")
            logger.info(f"[Skills]       ID: {file_id[:16] if file_id and len(file_id) > 16 else file_id}...")
            logger.info(f"[Skills]       Path (from metadata): {file_path}")
            logger.info(f"[Skills]       Size: {file_size} bytes")
            logger.info(f"[Skills]       Type: {content_type}")

            # Construct path if not provided
            if not file_path and file_id and filename:
                constructed_path = f"{self.OWUI_UPLOAD_DIR}/{file_id}_{filename}"
                logger.info(f"[Skills]       → Path was None, constructing: {constructed_path}")
                if os.path.exists(constructed_path):
                    file_path = constructed_path
                    logger.info("[Skills]       ✅ Constructed path exists!")
                else:
                    logger.warning("[Skills]       ❌ Constructed path does not exist")

            if not file_path or not filename:
                logger.warning("[Skills]       ❌ Skipping - missing path or name")
                continue

            if not os.path.exists(file_path):
                logger.warning(f"[Skills]       ❌ File not found at path: {file_path}")
                continue
            else:
                logger.info("[Skills]       ✅ File exists at path")

            try:
                logger.info(f"[Skills]       → Copying to workspace/{chat_id}/{filename}")
                result = workspace_manager.copy_to_workspace(
                    chat_id=chat_id,
                    source_path=file_path,
                    target_path=filename,
                )
                if result:
                    copied.append({
                        "name": filename,
                        "workspace_path": filename,
                        "original_id": file_id,
                        "content_type": content_type,
                        "size": file_size,
                    })
                    logger.info("[Skills]       ✅ Successfully copied to workspace")

                    # Auto-extract zip files
                    if self._should_extract_zip(content_type, filename):
                        logger.info(f"[Skills]       📦 Auto-extracting zip file: {filename}")
                        extracted_files = self._extract_zip_to_workspace(
                            chat_id=chat_id,
                            zip_path=result,  # result is the destination path from copy
                            zip_filename=filename,
                            workspace_manager=workspace_manager,
                        )
                        if extracted_files:
                            copied.extend(extracted_files)
                            logger.info(f"[Skills]       ✅ Extracted {len(extracted_files)} files from zip")
                else:
                    logger.warning("[Skills]       ❌ copy_to_workspace returned False/None")
            except Exception as e:
                logger.error(f"[Skills]       ❌ Exception during copy: {e}", exc_info=True)

        logger.info(f"[Skills]    Summary: {len(copied)}/{len(files)} files copied successfully")
        logger.info("[Skills] " + "-" * 50)
        return copied

    def _build_workspace_context(self, files: list) -> str:
        """Build workspace files context with consistent XML structure."""
        if not files:
            return ""

        lines = [
            "<workspace_files>",
            "  <description>Files automatically copied to workspace</description>",
            "  <files>",
        ]

        for f in files:
            size_attr = ""
            if f.get("size"):
                size_kb = f["size"] / 1024
                size_str = f"{size_kb / 1024:.1f} MB" if size_kb > 1024 else f"{size_kb:.1f} KB"
                size_attr = f' size="{size_str}"'

            content_type_attr = ""
            if f.get("content_type"):
                content_type_attr = f' type="{f["content_type"]}"'

            lines.append(f'    <file name="{f["name"]}" path="{f["workspace_path"]}"{content_type_attr}{size_attr}/>')

        lines.extend([
            "  </files>",
            "  <usage>",
            "    <location>Files are ready in the chat workspace root</location>",
            "    <access>Inside Agent VMs, chat workspace files are visible directly under /work/...; /work is the internal VM mount path, not the user-facing folder name.</access>",
            "    <output>Write generated files directly under /work and use Agent VM file-link tooling when a user-facing URL is needed.</output>",
            "  </usage>",
            "</workspace_files>",
        ])

        return "\n".join(lines)

    def _build_file_upload_notice(self, files: list) -> str:
        """Build hidden notice for file-only turns so the model can react safely."""
        if not files:
            return ""

        lines = [
            "<file_upload_notice>",
            "  <description>User uploaded files without an accompanying message</description>",
            "  <instruction>The uploaded files are available in the chat workspace root for this chat.</instruction>",
            "  <instruction>If no explicit task is given, acknowledge the upload and ask what the user wants done with these files.</instruction>",
            "  <files>",
        ]

        seen = set()
        file_count = 0

        for file_info in files:
            if not isinstance(file_info, dict):
                continue

            name = str(file_info.get("name") or "").strip()
            if not name:
                continue

            workspace_path = str(file_info.get("workspace_path") or "").strip()
            if not workspace_path:
                workspace_path = name

            key = (name, workspace_path)
            if key in seen:
                continue
            seen.add(key)

            safe_name = html.escape(name, quote=True)
            safe_workspace_path = html.escape(workspace_path, quote=True)
            lines.append(f'    <file name="{safe_name}" path="{safe_workspace_path}"/>')
            file_count += 1

        if file_count == 0:
            return ""

        lines.extend([
            "  </files>",
            "</file_upload_notice>",
        ])

        return "\n".join(lines)

    # ═══════════════════════════════════════════════════════════════════════════
    # MAIN INLET
    # ═══════════════════════════════════════════════════════════════════════════

    async def inlet(
        self,
        body: dict,
        __event_emitter__: Callable[[Any], Awaitable[None]],
        __request__: Any,
        __user__: Optional[dict] = None,
        __model__: Optional[dict] = None,
        __metadata__: Optional[dict] = None,
        __is_followup_request__: bool = False,
        __followup_phase__: Optional[str] = None,
        __preserve_dynamic_context__: bool = False,
    ) -> dict:
        """
        Process request and inject unified context message.

        Consolidates context into separate static and dynamic system messages.

        For follow-up requests (mid-turn tool calling), this filter will UPDATE
        existing context messages rather than inserting duplicates when possible.
        """
        # Track current phase for debugging (will be logged if exception occurs)
        current_phase = "init"
        request_started_at = time.monotonic()

        def log_phase_duration(phase: str, started_at: float, **fields):
            suffix = "".join(f" {key}={value}" for key, value in fields.items())
            logger.info(
                "UnifiedContextFilter phase_duration phase=%s duration_ms=%s%s",
                phase,
                int((time.monotonic() - started_at) * 1000),
                suffix,
            )

        try:
            if not self.valves.enable:
                return body

            logger.info("=" * 80)
            if __is_followup_request__:
                logger.info("UNIFIED_CONTEXT_FILTER - Processing FOLLOW-UP Request")
            else:
                logger.info("UNIFIED_CONTEXT_FILTER - Processing Request")
            logger.info("=" * 80)

            # ─── Extract Metadata ───────────────────────────────────────────
            chat_id = __metadata__.get("chat_id") if __metadata__ else None
            if not chat_id:
                chat_id = body.get("chat_id")

            session_id = __metadata__.get("session_id") if __metadata__ else None
            model_id = body.get("model", "unknown")

            logger.info(f"Chat ID: {chat_id}, Session ID: {session_id}, Model: {model_id}")

            # Ensure messages list exists
            if "messages" not in body or not isinstance(body["messages"], list):
                body["messages"] = []

            # ─── Extract base_model_id for Custom Agents ────────────────────────
            # Debug logging to understand __model__ structure
            if __model__:
                logger.info(f"DEBUG __model__ keys: {list(__model__.keys())}")
                if "info" in __model__ and __model__["info"]:
                    logger.info(f"DEBUG __model__.info keys: {list(__model__['info'].keys()) if isinstance(__model__['info'], dict) else 'not a dict'}")

            # Try multiple paths to find base_model_id and model tool IDs
            base_model_id = None
            model_tool_ids = []
            if __model__:
                base_model_id = (
                    __model__.get("info", {}).get("base_model_id") or
                    __model__.get("base_model_id") or
                    __model__.get("info", {}).get("meta", {}).get("base_model_id")
                )
                model_tool_ids = (
                    __model__.get("info", {}).get("meta", {}).get("toolIds") or
                    __model__.get("meta", {}).get("toolIds") or
                    __model__.get("toolIds") or
                    []
                )
            if isinstance(model_tool_ids, str):
                model_tool_ids = [model_tool_ids]
            elif not isinstance(model_tool_ids, list):
                model_tool_ids = list(model_tool_ids) if model_tool_ids else []
            logger.info(f"DEBUG base_model_id extracted: {base_model_id}")

            # NOTE: Base system prompt injection moved to openai.py (line ~851)
            # because filters run BEFORE the model's system prompt is merged.
            # This extraction is kept for passing base_model_id to debug monitor events.

            # Reset per-request caches
            self._toggles_cache = None
            self._disable_modes_cache = None
            self._cached_disabled_integrations = None
            self._cached_unconfigured = None
            self._health_status_snapshot_cache = None

            # Initialize context sections (split for prompt-cache stability)
            static_sections = []
            dynamic_sections = []
            vm_id = None
            available_tools = []
            enabled_tools = []
            capability_tool_ids = []
            available_models = []
            available_model_total = 0
            activated_skill_names = []
            newly_activated = []
            reconciled_skill_servers = []
            copied_files = []

            # ─── Phase 0.5: Agent capability seeding (first turn only) ───────────
            # For a UI-selected custom agent, attach the agent's configured skills
            # + MCP servers on the first prompt so they're active immediately. Reads
            # in-memory model meta (no HTTP); idempotent via a Redis flag; skips
            # delegated subagent chats (already seeded by start_subagent_run).
            if base_model_id and chat_id:
                self._seed_agent_capabilities_if_needed(chat_id, __model__)

            # ─── Phase 1: Skills Auto-Activation (writes to chat_skills and core deps only) ───
            current_phase = "phase1_skills"
            phase_started_at = time.monotonic()
            # Skills activation runs FIRST so we know which core capabilities to attach
            if self.valves.enable_skills and self.skill_manager and chat_id:
                if self.valves.enable_auto_activation:
                    messages = body.get("messages", [])
                    skip_keyword_auto_activation = (
                        self._should_skip_subagent_keyword_auto_activation(chat_id, messages)
                    )
                    user_message = self._get_user_message(messages)
                    if skip_keyword_auto_activation:
                        logger.info(
                            "Skipping keyword auto-activation for delegated subagent chat %s because explicit skill_ids were supplied",
                            chat_id,
                        )
                    elif user_message:
                        try:
                            auto_activated = self.skill_manager.check_auto_activation(user_message)
                        except Exception as e:
                            skill_cache = getattr(self.skill_manager, "_skills_cache", None)
                            skill_cache_entries = (
                                len(skill_cache) if isinstance(skill_cache, dict) else "unknown"
                            )
                            logger.warning(
                                "Skill keyword auto-activation failed for chat %s; "
                                "continuing unified context processing "
                                "(skill_cache_entries=%s, error_type=%s): %s",
                                chat_id,
                                skill_cache_entries,
                                type(e).__name__,
                                e,
                                exc_info=True,
                            )
                            auto_activated = []
                        for skill_name in auto_activated:
                            if self._activate_skill_for_chat(skill_name, chat_id):
                                newly_activated.append(skill_name)
                                logger.info(f"Auto-activated skill: {skill_name}")

                activated_skill_names = self._get_activated_skills(chat_id)
                if activated_skill_names:
                    reconciled_skill_servers = self._reconcile_activated_skill_servers(
                        chat_id, activated_skill_names
                    )

            logger.info(
                "Phase 1 complete: Skills - %s activated, %s required server(s) reconciled",
                len(activated_skill_names),
                len(reconciled_skill_servers),
            )
            log_phase_duration(
                "skills",
                phase_started_at,
                activated=len(activated_skill_names),
                reconciled=len(reconciled_skill_servers),
            )

            # ─── Phase 1b: Model Inventory ──────────────────────────────────────
            current_phase = "phase1b_models"
            phase_started_at = time.monotonic()
            if self.valves.enable_models_context:
                available_models, available_model_total = self._get_available_models(
                    __request__,
                    __user__,
                )
                logger.info(
                    f"Models: {available_model_total} available, {len(available_models)} included in context"
                )
            logger.info("Phase 1b complete: Model inventory done")
            log_phase_duration(
                "models",
                phase_started_at,
                available=available_model_total,
                included=len(available_models),
            )

            # ─── Phase 2: VM Creation (only if needed by activated skills) ────────────
            current_phase = "phase2_vm_creation"
            phase_started_at = time.monotonic()
            # VM is only created if code-execution or artifacts skill is activated
            # This implements progressive disclosure - VMs aren't created for simple chats
            vm_requiring_skills = {"code-execution", "artifacts"}
            should_create_vm = bool(vm_requiring_skills & set(activated_skill_names))

            if self.valves.enable_agent_vm and chat_id and should_create_vm:
                vm_id = await self._get_or_create_vm(chat_id)
                if vm_id:
                    logger.info(f"VM ready: {vm_id} (triggered by skills: {vm_requiring_skills & set(activated_skill_names)})")
            elif self.valves.enable_agent_vm and chat_id:
                # Check if VM already exists from previous activation (don't create new one)
                redis_key = f"agent_vm:{chat_id}"
                if self.redis_client:
                    existing_vm_id = self.redis_client.get(redis_key)
                    if existing_vm_id and await self._check_vm_status_via_mcp(existing_vm_id):
                        vm_id = existing_vm_id
                        logger.info(f"Reusing existing VM: {vm_id}")

            logger.info(f"Phase 2 complete: VM - {'created/reused' if vm_id else 'not needed'}")
            log_phase_duration("vm", phase_started_at, ready=bool(vm_id))

            # ─── Phase 3: Tools Management (reads from Redis, updates body) ─
            current_phase = "phase3_tools"
            phase_started_at = time.monotonic()
            # Note: _notify_capabilities_changed called later after tools are built
            # to send complete capabilities (both tools AND skills) to OWUI frontend
            mcp_metadata = {}
            if self.valves.enable_mcp_tools:
                available_tools = await self._fetch_available_tools()
                mcp_metadata = await self._fetch_mcp_server_metadata()

                # Get always-enabled servers dynamically from metadata
                # Servers with always_enabled=true are auto-enabled for every chat
                # Default to false if the field is missing (backwards compatibility)
                core_tool_ids = list(self.valves.core_tool_ids)
                always_enabled_ids = []
                if mcp_metadata:
                    for server_id, server_meta in mcp_metadata.items():
                        # Default to False if always_enabled field is missing
                        if server_meta.get("always_enabled", False):
                            always_enabled_ids.append(f"server:{server_id}")
                    logger.info(f"Always-enabled servers from metadata: {always_enabled_ids}")
                else:
                    # Fallback to hardcoded list if metadata fetch failed
                    always_enabled_ids = list(self.valves.fallback_always_enabled_ids)
                    logger.warning(f"Using fallback always-enabled list: {always_enabled_ids}")

                lock_ctx = self._chat_capabilities_lock(chat_id) if chat_id else nullcontext()
                with lock_ctx:
                    # Get chat-specific tools from Redis (includes skill-activated servers)
                    chat_tools = self._get_chat_tools(chat_id) if chat_id else []

                    # Merge all tools
                    current_tool_ids = body.get("tool_ids") or []
                    if isinstance(current_tool_ids, str):
                        current_tool_ids = [current_tool_ids]
                    else:
                        current_tool_ids = list(current_tool_ids)

                    for server_id in model_tool_ids:
                        if server_id not in current_tool_ids:
                            current_tool_ids.append(server_id)

                    for server_id in core_tool_ids + always_enabled_ids + chat_tools:
                        if server_id not in current_tool_ids:
                            current_tool_ids.append(server_id)

                    # Compute unauthenticated integrations early (used here and in Phase 6 context)
                    try:
                        self._cached_unauthenticated = self._get_unauthenticated_integrations()
                        self._unauthenticated_server_ids = {info["id"] for info in self._cached_unauthenticated}
                    except Exception:
                        self._cached_unauthenticated = []
                        self._unauthenticated_server_ids = set()

                    # Final pass: remove toggled-off AND unauthenticated servers
                    tool_health_snapshot = self._load_health_status_snapshot()

                    def _should_include_tool(server_id):
                        if not self._is_server_toggled_on(server_id):
                            return False
                        bare = server_id.replace("server:", "") if server_id.startswith("server:") else server_id
                        readiness_phase = self._readiness_from_health_snapshot(
                            bare,
                            tool_health_snapshot,
                        ).get("readiness_phase")
                        if (
                            bare in self._unauthenticated_server_ids
                            or readiness_phase in HEALTH_STATUS_PROMPT_BLOCKING_PHASES
                        ):
                            return False
                        return True

                    current_tool_ids = [
                        t for t in current_tool_ids
                        if _should_include_tool(t)
                    ]

                    capability_tool_ids = self._build_persisted_chat_tool_ids(
                        chat_tools=chat_tools,
                        core_tool_ids=core_tool_ids,
                        always_enabled_ids=always_enabled_ids,
                        include_tool=_should_include_tool,
                    )

                    # Keep the agent's explicitly-configured servers as persisted
                    # chat intent even while un-ready, so they attach on a later
                    # turn once ready (the readiness filter above still keeps them
                    # out of the per-turn request via current_tool_ids).
                    for server_id in self._get_seeded_agent_tool_servers(chat_id):
                        if server_id and server_id not in capability_tool_ids:
                            capability_tool_ids.append(server_id)

                    body["tool_ids"] = current_tool_ids
                    enabled_tools = current_tool_ids

                    # Store chat-attached capabilities only. Do not persist the
                    # full per-turn request tool list back into chat_tools.
                    if chat_id:
                        self._store_chat_tools(chat_id, capability_tool_ids, lock=False)

                logger.info(f"Tools: {len(available_tools)} available, {len(enabled_tools)} enabled")

            logger.info(f"Phase 3 complete: Tools management done")
            log_phase_duration(
                "tools",
                phase_started_at,
                available=len(available_tools),
                enabled=len(enabled_tools),
            )

            # ─── Phase 3b: Sanitize Disabled Tool History ────────────────────
            current_phase = "phase3b_sanitize"
            # PORTICO-410: includes hard-disabled servers, which are excluded from
            # the disabled listing (opacity) but still need history scrubbing.
            disabled_server_id_set = self._get_history_sanitize_server_ids()
            if disabled_server_id_set:
                sanitized = self._sanitize_disabled_tool_history(
                    body.get("messages", []), disabled_server_id_set
                )
                if sanitized:
                    logger.info(
                        f"Sanitized {sanitized} stale tool messages for disabled servers: {disabled_server_id_set}"
                    )

            # ─── Phase 4: Session Mapping ───────────────────────────────────
            current_phase = "phase4_session"
            if chat_id and session_id:
                self._store_session_mapping(session_id, chat_id)

            logger.info(f"Phase 4 complete: Session mapping done")

            # ─── Phase 5: Workspace File Copy ───────────────────────────────
            current_phase = "phase5_workspace"
            if self.valves.enable_workspace_files and chat_id:
                metadata = body.get("metadata") or {}
                files = metadata.get("files") or []
                logger.info(f"[Skills] Phase 5: Workspace file copy - {len(files)} files in metadata")
                logger.info(f"[Skills]    enable_workspace_files: {self.valves.enable_workspace_files}")
                logger.info(f"[Skills]    chat_id: {chat_id}")
                logger.info(f"[Skills]    WORKSPACE_MANAGER_AVAILABLE: {WORKSPACE_MANAGER_AVAILABLE}")
                if files:
                    for idx, f in enumerate(files):
                        logger.info(f"[Skills]    File metadata [{idx}]: {f}")
                if files and WORKSPACE_MANAGER_AVAILABLE:
                    copied_files = self._auto_copy_files_to_workspace(chat_id, files, vm_id=vm_id)
                    logger.info(f"Copied {len(copied_files)} files to workspace")
                elif files and not WORKSPACE_MANAGER_AVAILABLE:
                    logger.warning("[Skills]    ⚠️ Files present but WORKSPACE_MANAGER_AVAILABLE=False, skipping copy")

            logger.info(f"Phase 5 complete: Workspace files processed")

            # ═══════════════════════════════════════════════════════════════
            # BUILD STATIC + DYNAMIC CONTEXT MESSAGES
            # ═══════════════════════════════════════════════════════════════
            current_phase = "phase6_build_message"
            phase6_started_at = time.monotonic()

            static_sections.append("<portico_context>")
            static_sections.append("<static_context>")
            dynamic_sections.append("<portico_context>")
            dynamic_sections.append("<dynamic_context>")

            # Session context
            if self.valves.enable_session_context:
                session_parts = ["<session>"]
                if chat_id:
                    session_parts.append(f"  <chat_id>{chat_id}</chat_id>")
                session_parts.append(f"  <model>{model_id}</model>")
                user_ctx = self._build_user_context(__user__)
                if user_ctx:
                    session_parts.append(f"  <user>{user_ctx}</user>")
                session_parts.append("</session>")
                static_sections.append("\n".join(session_parts))

            if chat_id:
                workspace_ctx = self._build_chat_workspace_context(chat_id)
                if workspace_ctx:
                    static_sections.append(workspace_ctx)

            # Models context
            if self.valves.enable_models_context:
                models_ctx = self._build_models_context(
                    available_models,
                    available_model_total,
                    model_id,
                )
                if models_ctx:
                    static_sections.append(models_ctx)

            # Time context
            if self.valves.enable_time_context:
                time_ctx = self._build_time_context()
                if time_ctx:
                    dynamic_sections.append(f"<time>\n{time_ctx}\n</time>")

            # Current reasoning effort (dynamic — the user can change it per turn).
            # Surfaced so the model can start subagents with the SAME effort by
            # default (see the base system prompt). Read straight from the request
            # params the frontend already sends — no chat-state lookup on the hot
            # path.
            if self.valves.enable_session_context:
                current_reasoning_effort = self._extract_request_reasoning_effort(body)
                if current_reasoning_effort:
                    dynamic_sections.append(
                        "<reasoning_effort>"
                        f"{html.escape(current_reasoning_effort, quote=True)}"
                        "</reasoning_effort>"
                    )

            # VM context
            if self.valves.enable_agent_vm and vm_id and chat_id:
                vm_ctx = self._build_vm_context(vm_id, chat_id)
                static_sections.append(vm_ctx)

            # Tools context
            if self.valves.enable_mcp_tools:
                tools_available_ctx = self._build_tools_context(
                    available_tools,
                    enabled_tools,
                    mcp_metadata,
                    include_available=True,
                    include_enabled=False,
                )
                if tools_available_ctx:
                    static_sections.append(tools_available_ctx)

                tools_enabled_ctx = self._build_tools_context(
                    available_tools,
                    enabled_tools,
                    mcp_metadata,
                    include_available=False,
                    include_enabled=True,
                )
                if tools_enabled_ctx:
                    dynamic_sections.append(tools_enabled_ctx)

                integrations_readiness_cache = {}
                capability_classification_started_at = time.monotonic()

                integrations_static_ctx = self._build_integrations_status_context(
                    mcp_metadata,
                    enabled_tool_ids=enabled_tools,
                    chat_id=chat_id,
                    include_active=False,
                    include_inactive=True,
                    include_setup_guidance=True,
                    readiness_cache=integrations_readiness_cache,
                )
                if integrations_static_ctx:
                    static_sections.append(integrations_static_ctx)

                integrations_active_ctx = self._build_integrations_status_context(
                    mcp_metadata,
                    enabled_tool_ids=enabled_tools,
                    chat_id=chat_id,
                    include_active=True,
                    include_inactive=False,
                    include_setup_guidance=False,
                    readiness_cache=integrations_readiness_cache,
                )
                if integrations_active_ctx:
                    dynamic_sections.append(integrations_active_ctx)

                logger.info(
                    "UnifiedContextFilter phase_duration phase=mcp_capability_classification duration_ms=%s cache_entries=%s",
                    int((time.monotonic() - capability_classification_started_at) * 1000),
                    len(integrations_readiness_cache),
                )

                ask_user_question_policy = self._build_ask_user_question_policy(
                    enabled_tools,
                    chat_id,
                )
                if ask_user_question_policy:
                    dynamic_sections.append(ask_user_question_policy)

                sensitive_information_policy = self._build_sensitive_information_policy(
                    enabled_tools,
                    chat_id,
                )
                if sensitive_information_policy:
                    dynamic_sections.append(sensitive_information_policy)

            # Skills context
            if self.valves.enable_skills and self.skill_manager:
                all_skills = self.skill_manager.get_all_metadata()
                skills_ctx = self._build_skills_context(all_skills, activated_skill_names)
                if skills_ctx:
                    static_sections.append(skills_ctx)

            # Workspace files context
            if copied_files:
                workspace_ctx = self._build_workspace_context(copied_files)
                if workspace_ctx:
                    static_sections.append(workspace_ctx)

                latest_user_message = (self._get_user_message(body.get("messages", [])) or "").strip()
                if not latest_user_message and not __is_followup_request__:
                    file_upload_notice = self._build_file_upload_notice(copied_files)
                    if file_upload_notice:
                        dynamic_sections.append(file_upload_notice)

            static_sections.append("</static_context>")
            static_sections.append("</portico_context>")
            dynamic_sections.append("</dynamic_context>")
            dynamic_sections.append("</portico_context>")

            # ═══════════════════════════════════════════════════════════════
            # INJECT STATIC + DYNAMIC CONTEXT AS SEPARATE SYSTEM MESSAGES
            # ═══════════════════════════════════════════════════════════════
            # IMPORTANT: The model's system prompt (from admin settings) is applied
            # AFTER filters run, in openai.py's apply_system_prompt_to_body().
            # That function uses add_or_update_system_message() which MERGES into
            # position 0.
            #
            # To keep our context SEPARATE:
            # 1. Insert a PLACEHOLDER system message at position 0
            # 2. Insert static context at position 1
            # 3. Insert dynamic context at position 2
            # 3. When openai.py runs, it replaces/merges into position 0 (placeholder)
            # 4. Result: model's system prompt at 0, static at 1, dynamic at 2.
            # 5. Claude prompt-cache shaping can then forward the stable prefix as
            #    static_context -> model/custom prompt -> dynamic_context.
            #
            # This keeps the static prefix stable for prompt caching while preserving
            # dynamic context freshness.

            logger.info(
                "Phase 6 complete: Built context messages (static_sections=%s, dynamic_sections=%s, phase_ms=%s, elapsed_ms=%s)",
                len(static_sections),
                len(dynamic_sections),
                int((time.monotonic() - phase6_started_at) * 1000),
                int((time.monotonic() - request_started_at) * 1000),
            )
            log_phase_duration(
                "context_build",
                phase6_started_at,
                static_sections=len(static_sections),
                dynamic_sections=len(dynamic_sections),
            )

            # Count system messages BEFORE injection
            current_phase = "phase7_inject_message"
            system_msgs_before = sum(1 for m in body["messages"] if m.get("role") == "system")

            static_content = "\n\n".join(static_sections)
            dynamic_content = "\n\n".join(dynamic_sections)

            # ─── Handle Follow-up Requests ────────────────────────────────────
            # For follow-up requests, update dynamic context every turn and only
            # update static context if it has materially changed.
            if __is_followup_request__:
                static_idx = None
                dynamic_idx = None
                legacy_idx = None
                preserve_dynamic_context = bool(__preserve_dynamic_context__)

                for i, msg in enumerate(body["messages"]):
                    if msg.get("role") != "system":
                        continue
                    content = msg.get("content", "")
                    if not isinstance(content, str):
                        continue

                    if "<static_context>" in content:
                        static_idx = i
                    elif "<dynamic_context>" in content:
                        dynamic_idx = i
                    elif "<portico_context>" in content:
                        legacy_idx = i

                if static_idx is not None:
                    if body["messages"][static_idx].get("content", "") != static_content:
                        body["messages"][static_idx]["content"] = static_content
                        logger.info(
                            "Updated static context at position %s (%s chars)",
                            static_idx,
                            len(static_content),
                        )
                    else:
                        logger.info("Static context unchanged; no update needed")

                if dynamic_idx is not None:
                    if preserve_dynamic_context:
                        logger.info(
                            "Preserved dynamic context at position %s during %s follow-up",
                            dynamic_idx,
                            __followup_phase__ or "internal",
                        )
                    else:
                        body["messages"][dynamic_idx]["content"] = dynamic_content
                        logger.info(
                            "Updated dynamic context at position %s (%s chars)",
                            dynamic_idx,
                            len(dynamic_content),
                        )

                # Migrate legacy single-message context to static+dynamic format.
                if static_idx is None and dynamic_idx is None and legacy_idx is not None:
                    body["messages"][legacy_idx]["content"] = dynamic_content
                    body["messages"].insert(
                        legacy_idx, {"role": "system", "content": static_content}
                    )
                    static_idx = legacy_idx
                    dynamic_idx = legacy_idx + 1
                    logger.info(
                        "Migrated legacy context message to static+dynamic at positions %s/%s",
                        static_idx,
                        dynamic_idx,
                    )

                if static_idx is None:
                    insert_at = dynamic_idx if dynamic_idx is not None else (
                        1 if len(body["messages"]) > 0 else 0
                    )
                    body["messages"].insert(
                        insert_at, {"role": "system", "content": static_content}
                    )
                    static_idx = insert_at
                    if dynamic_idx is not None and dynamic_idx >= insert_at:
                        dynamic_idx += 1
                    logger.info(
                        "Inserted missing static context at position %s (%s chars)",
                        static_idx,
                        len(static_content),
                    )

                if dynamic_idx is None:
                    insert_at = static_idx + 1 if static_idx is not None else (
                        1 if len(body["messages"]) > 0 else 0
                    )
                    body["messages"].insert(
                        insert_at, {"role": "system", "content": dynamic_content}
                    )
                    dynamic_idx = insert_at
                    logger.info(
                        "Inserted missing dynamic context at position %s (%s chars)",
                        dynamic_idx,
                        len(dynamic_content),
                    )
            else:
                # ─── Initial Request Injection ────────────────────────────────────
                if system_msgs_before == 0:
                    # No system message exists yet. The model's system prompt will be added
                    # later by openai.py. We insert a placeholder at position 0 so that
                    # the model's prompt merges into it, and context blocks stay separate.
                    placeholder_message = {
                        "role": "system",
                        "content": ""  # Empty placeholder - will be replaced by model's system prompt
                    }
                    body["messages"].insert(0, placeholder_message)
                    logger.info("Inserted placeholder system message at position 0")

                    body["messages"].insert(1, {"role": "system", "content": static_content})
                    body["messages"].insert(2, {"role": "system", "content": dynamic_content})
                    logger.info(
                        "Injected static/dynamic context at positions 1/2 (%s/%s chars)",
                        len(static_content),
                        len(dynamic_content),
                    )
                else:
                    # A system message already exists at position 0.
                    # Insert static and dynamic contexts after it.
                    body["messages"].insert(1, {"role": "system", "content": static_content})
                    body["messages"].insert(2, {"role": "system", "content": dynamic_content})
                    logger.info(
                        "Injected static/dynamic context at positions 1/2 after existing system (%s/%s chars)",
                        len(static_content),
                        len(dynamic_content),
                    )

            # Count system messages AFTER injection
            system_msgs_after = sum(1 for m in body["messages"] if m.get("role") == "system")
            logger.info(f"Phase 7 complete: Message injection done ({system_msgs_before} -> {system_msgs_after} system messages)")

            # ─── Publish Events ─────────────────────────────────────────────
            current_phase = "phase8_events"
            phase_started_at = time.monotonic()
            if EVENT_PUBLISHER_AVAILABLE and chat_id:
                try:
                    # Capabilities change event
                    active_tools = self._build_active_capability_tools(
                        available_tools,
                        capability_tool_ids,
                        mcp_metadata,
                    )
                    activated_skills_data = [{"name": s, "display_name": s} for s in activated_skill_names]

                    if active_tools or activated_skills_data:
                        await publish_capabilities_change(
                            session_id=session_id or "unknown",
                            chat_id=chat_id,
                            tools=active_tools,
                            skills=activated_skills_data,
                            change_type="initial"
                        )

                        # Also notify OWUI frontend via socket for real-time display
                        await self._notify_capabilities_changed(
                            chat_id=chat_id,
                            tools=active_tools,
                            skills=activated_skills_data
                        )

                    # base_model_id was extracted earlier for system prompt injection
                    # Request start event
                    await publish_request_start(
                        session_id=session_id or "unknown",
                        chat_id=chat_id,
                        model=model_id,
                        message_count=len(body.get("messages", [])),
                        tool_ids=enabled_tools,
                        skills=activated_skill_names,
                        metadata={
                            "user_id": __user__.get("id") if __user__ else None,
                            "message_id": __metadata__.get("message_id") if __metadata__ else None,
                            "debug_request_id": __metadata__.get("debug_request_id")
                            if __metadata__
                            else None,
                            "upstream_request_id": __metadata__.get("upstream_request_id")
                            if __metadata__
                            else None,
                            "request_phase": __metadata__.get("request_phase")
                            if __metadata__
                            else None,
                            "followup_index": __metadata__.get("followup_index")
                            if __metadata__
                            else None,
                            "outer_message_id": __metadata__.get("outer_message_id")
                            if __metadata__
                            else None,
                            "trigger_message_id": __metadata__.get("trigger_message_id")
                            if __metadata__
                            else None,
                            "transcript_anchor_kind": __metadata__.get(
                                "transcript_anchor_kind"
                            )
                            if __metadata__
                            else None,
                            "transcript_anchor_message_id": __metadata__.get(
                                "transcript_anchor_message_id"
                            )
                            if __metadata__
                            else None,
                            "transcript_anchor_tool_block_index": __metadata__.get(
                                "transcript_anchor_tool_block_index"
                            )
                            if __metadata__
                            else None,
                            "task": __metadata__.get("task") if __metadata__ else None,
                        },
                        base_model=base_model_id
                    )
                    logger.info("Published events to debug monitor")
                except Exception as e:
                    logger.warning(f"Failed to publish events: {e}")
            log_phase_duration("events", phase_started_at)

            logger.info("=" * 80)
            logger.info("UNIFIED_CONTEXT_FILTER - Completed Successfully")
            logger.info("=" * 80)
            log_phase_duration("total", request_started_at)

            return body

        except Exception as e:
            logger.error(f"Error in unified context filter during phase '{current_phase}': {e}", exc_info=True)
            logger.error(f"Body messages before filter: {len(body.get('messages', []))}")
            return body
