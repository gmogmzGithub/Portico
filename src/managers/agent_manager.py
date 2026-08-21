"""
Agent Manager for Open WebUI
Handles discovery, installation, and management of system-delivered agents.
"""

import os
import json
import logging
import yaml
import base64
from typing import Any, Dict, List, Optional
from pathlib import Path
from urllib.parse import quote

from src.managers.filter_manager import OpenWebUIApiError, coerce_open_webui_api_client

logger = logging.getLogger(__name__)


def get_agent_icon_data_url() -> str:
    """
    Load the custom agent icon and convert to base64 data URL.

    Returns:
        Data URL string for the icon, or default icon path if file not found
    """
    # Path to the icon file in container (same as subagents)
    icon_path = Path("/app/assets/agent-icon.png")

    try:
        if icon_path.exists():
            with open(icon_path, "rb") as f:
                icon_data = f.read()
            encoded = base64.b64encode(icon_data).decode('utf-8')
            data_url = f"data:image/png;base64,{encoded}"
            logger.info(f"✅ Loaded custom agent icon from {icon_path} ({len(icon_data)} bytes)")
            return data_url
        else:
            logger.warning(f"⚠️  Custom icon not found at {icon_path}, using default")
            return "/static/favicon.png"
    except Exception as e:
        logger.error(f"Failed to load custom icon: {e}")
        return "/static/favicon.png"


class AgentManager:
    """Manages installation and updates of Open WebUI system-delivered agents."""

    SYSTEM_DELIVERED_PREFIX = "portico_agent_"

    def __init__(self, base_url: str, agents_dir: str):
        """
        Initialize the AgentManager.

        Args:
            base_url: Base URL for Open WebUI API (e.g., http://open-webui:8080)
            agents_dir: Path to directory containing agent subdirectories
        """
        self.base_url = base_url
        self.agents_dir = agents_dir

    def discover_agents(self) -> List[Dict[str, Any]]:
        """
        Scan agents directory and return list of agent configurations.

        Returns:
            List of dicts with keys: agent_id, name, base_model_id, system_prompt,
                                     tools_mode, tools_list, description
        """
        agents = []
        agents_path = Path(self.agents_dir)

        if not agents_path.exists():
            logger.warning(f"Agents directory not found: {self.agents_dir}")
            return agents

        for agent_dir in agents_path.iterdir():
            if not agent_dir.is_dir() or agent_dir.name.startswith("_"):
                # Skip non-directories and private directories
                continue

            try:
                config_file = agent_dir / "config.yaml"
                system_prompt_file = agent_dir / "system_prompt.md"

                if not config_file.exists():
                    logger.warning(f"Skipping {agent_dir.name}: No config.yaml found")
                    continue

                # Read config
                with open(config_file, 'r') as f:
                    config = yaml.safe_load(f)

                # Read system prompt
                system_prompt = ""
                if system_prompt_file.exists():
                    with open(system_prompt_file, 'r') as f:
                        system_prompt = f.read()
                else:
                    logger.warning(f"No system_prompt.md found for {agent_dir.name}")

                # Generate agent ID
                agent_slug = agent_dir.name  # Use directory name as slug
                agent_id = f"{self.SYSTEM_DELIVERED_PREFIX}{agent_slug}"

                agents.append({
                    "agent_id": agent_id,
                    "name": config.get("name", agent_dir.name),
                    "base_model_id": config.get("base_model_id"),
                    "system_prompt": system_prompt,
                    "tools_mode": config.get("tools_mode", "core"),
                    "tools_list": config.get("tools_list", []),
                    "description": config.get("description", ""),
                    "hidden": config.get("hidden", False),  # Support hidden flag
                    "directory": str(agent_dir)
                })

                logger.info(f"Discovered agent: {agent_id} ({config.get('name')})")

            except Exception as e:
                logger.error(f"Failed to process agent directory {agent_dir}: {e}")
                continue

        return agents

    async def get_base_system_prompt(self) -> str:
        """
        Read the base system prompt from agents/base_system_prompt.md.

        Returns:
            Content of base_system_prompt.md or empty string if not found
        """
        base_prompt_path = Path(self.agents_dir) / "base_system_prompt.md"

        if not base_prompt_path.exists():
            logger.warning(f"Base system prompt not found at {base_prompt_path}")
            return ""

        try:
            with open(base_prompt_path, 'r') as f:
                content = f.read()
            logger.info(f"✅ Read base system prompt ({len(content)} characters)")
            return content
        except Exception as e:
            logger.error(f"Failed to read base system prompt: {e}")
            return ""

    async def install_all_agents(self, page_or_client, tool_ids_by_mode: Dict[str, List[str]]) -> bool:
        """
        Install all discovered agents using subagents' create_agent tool.

        Args:
            page_or_client: Playwright page object or Open WebUI API client
            tool_ids_by_mode: Dict with keys "core", "all", "none" containing tool server IDs

        Returns:
            True if all agents installed successfully, False otherwise
        """
        logger.info("=" * 60)
        logger.info("🤖 Installing System-Delivered Agents")
        logger.info("=" * 60)

        # Step 1: Discover agents
        agents = self.discover_agents()
        if not agents:
            logger.warning("No agents found to install")
            return True

        logger.info(f"Found {len(agents)} agents to install")

        # Step 2: Install each agent
        success_count = 0
        for agent_config in agents:
            agent_id = agent_config['agent_id']
            logger.info(f"📦 Installing agent: {agent_id}")

            try:
                # Resolve tool IDs based on tools_mode
                tools_mode = agent_config.get('tools_mode', 'core')

                logger.info(f"  🔧 Resolving tools for {agent_id}...")
                logger.info(f"    Tools mode: {tools_mode}")

                if tools_mode == 'all':
                    tool_ids = tool_ids_by_mode.get('all', [])
                    logger.info(f"    Using ALL tool servers: {len(tool_ids)} tools")
                elif tools_mode == 'core':
                    tool_ids = tool_ids_by_mode.get('core', [])
                    logger.info(f"    Using CORE tool servers only: {tool_ids}")
                elif tools_mode == 'specific':
                    tool_ids = agent_config.get('tools_list', [])
                    logger.warning(f"    ⚠️  Using SPECIFIC tool list from config (may need remapping!): {tool_ids}")
                    logger.warning(f"    ⚠️  If tool IDs are hardcoded, they may break when server IDs change!")
                elif tools_mode == 'none':
                    tool_ids = []
                    logger.info(f"    No tools assigned")
                else:
                    logger.warning(f"  ⚠️  Unknown tools_mode '{tools_mode}', defaulting to core")
                    tool_ids = tool_ids_by_mode.get('core', [])

                logger.info(f"  📋 Final tool IDs to assign: {tool_ids}")

                # Check if agent already exists (idempotent operation)
                agent_exists = await self.check_agent_exists(page_or_client, agent_id)

                # Log if agent is hidden
                is_hidden = agent_config.get('hidden', False)
                if is_hidden:
                    logger.info(f"  🔒 Agent will be hidden from model list: {agent_id}")

                if agent_exists:
                    logger.info(f"  ♻️  Agent already exists, taking UPDATE path: {agent_id}")
                    logger.info(f"    Will update toolIds to: {tool_ids}")
                    # Update existing agent
                    if not await self.update_agent_via_api(
                        page_or_client,
                        agent_id,
                        agent_config['name'],
                        agent_config['base_model_id'],
                        agent_config['system_prompt'],
                        tool_ids,
                        agent_config['description'],
                        is_hidden  # Pass hidden flag
                    ):
                        continue
                else:
                    logger.info(f"  ➕ Agent does NOT exist, taking CREATE path: {agent_id}")
                    logger.info(f"    Will set toolIds to: {tool_ids}")
                    # Build payload for create_agent (must match OWUI API structure)
                    payload = {
                        "name": agent_config['name'],
                        "base_model_id": agent_config['base_model_id'],
                        "meta": {
                            "profile_image_url": get_agent_icon_data_url(),  # Load custom icon
                            "description": agent_config['description'],
                            "capabilities": {
                                "vision": False,
                                "file_upload": False,
                                "web_search": False,
                                "image_generation": False,
                                "code_interpreter": False,
                                "citations": False
                            },
                            "toolIds": tool_ids,  # Tool IDs go in meta.toolIds
                            "hidden": agent_config.get('hidden', False)  # Set hidden flag
                        },
                        "params": {
                            "system": agent_config['system_prompt']  # System prompt in params.system
                        }
                    }

                    # Create new agent
                    if not await self.create_agent_via_api(page_or_client, agent_id, payload):
                        continue

                success_count += 1
                logger.info(f"  ✅ Successfully installed: {agent_id}")
                logger.info(f"    Final toolIds: {tool_ids}")

            except Exception as e:
                logger.error(f"  ❌ Error installing {agent_id}: {e}", exc_info=True)
                continue

        # Summary
        logger.info("=" * 60)
        logger.info(f"📊 Agent Installation Summary:")
        logger.info(f"  Total agents: {len(agents)}")
        logger.info(f"  Successfully installed: {success_count}")
        logger.info(f"  Failed: {len(agents) - success_count}")
        logger.info("=" * 60)

        return success_count == len(agents)

    async def check_agent_exists(self, page_or_client, agent_id: str) -> bool:
        """
        Check if an agent already exists.

        Args:
            page_or_client: Playwright page object or Open WebUI API client
            agent_id: Agent ID to check

        Returns:
            True if agent exists, False otherwise
        """
        client = coerce_open_webui_api_client(page_or_client)

        try:
            await client.get_json("/api/v1/models/model", params={"id": agent_id})
            return True
        except OpenWebUIApiError:
            return False

    async def update_agent_via_api(
        self,
        page_or_client,
        agent_id: str,
        name: str,
        base_model_id: str,
        system_prompt: str,
        tool_ids: List[str],
        description: str,
        hidden: bool = False
    ) -> bool:
        """
        Update an existing agent (same pattern as subagents).

        Args:
            page_or_client: Playwright page object or Open WebUI API client
            agent_id: Agent ID to update
            name: Agent name
            base_model_id: Base model ID
            system_prompt: System prompt
            tool_ids: Tool server IDs
            description: Description

        Returns:
            True if successful, False otherwise
        """
        logger.info(f"  Updating agent via API: {agent_id}")
        client = coerce_open_webui_api_client(page_or_client)

        # Fetch FULL existing agent data first
        try:
            existing_agent = await client.get_json("/api/v1/models/model", params={"id": agent_id})
        except OpenWebUIApiError as exc:
            logger.error(f"    ❌ Failed to fetch existing agent data: {exc}")
            return False

        # Get user ID
        try:
            auth_data = await client.get_json("/api/v1/auths/")
        except OpenWebUIApiError as exc:
            logger.error(f"    ❌ Failed to get user ID: {exc}")
            return False

        user_id = auth_data.get('id')

        # Update the existing agent data
        # Log what we're updating
        old_tool_ids = existing_agent.get('meta', {}).get('toolIds', [])
        logger.info(f"    🔍 Existing agent tool IDs: {old_tool_ids}")
        logger.info(f"    🔄 New tool IDs to set: {tool_ids}")

        # Update fields
        existing_agent['name'] = name
        existing_agent['base_model_id'] = base_model_id

        if 'meta' not in existing_agent:
            existing_agent['meta'] = {}
        existing_agent['meta']['profile_image_url'] = get_agent_icon_data_url()
        existing_agent['meta']['description'] = description
        existing_agent['meta']['toolIds'] = tool_ids
        existing_agent['meta']['hidden'] = hidden  # Set hidden flag

        logger.info(f"    ✅ Updated agent meta.toolIds: {tool_ids}")

        if 'params' not in existing_agent:
            existing_agent['params'] = {}
        existing_agent['params']['system'] = system_prompt

        # Add user_id (REQUIRED for update)
        existing_agent['user_id'] = user_id

        # Remove read-only fields
        if 'user' in existing_agent:
            del existing_agent['user']
        if 'info' in existing_agent:
            del existing_agent['info']

        try:
            await client.post_text(
                "/api/v1/models/model/update",
                existing_agent,
                params={"id": agent_id},
            )
            logger.info(f"    ✅ Updated agent: {agent_id}")
            return True
        except OpenWebUIApiError as exc:
            logger.error(f"    ❌ Failed to update agent {agent_id}: {exc}")
            return False

    async def create_agent_via_api(self, page_or_client, agent_id: str, payload: Dict) -> bool:
        """
        Create an agent using Open WebUI API.

        Args:
            page_or_client: Playwright page object or Open WebUI API client
            agent_id: Agent ID to create
            payload: Agent configuration payload

        Returns:
            True if successful, False otherwise
        """
        logger.info(f"  Creating agent via API: {agent_id}")
        client = coerce_open_webui_api_client(page_or_client)

        payload_with_id = {**payload, "id": agent_id}

        try:
            await client.post_text("/api/v1/models/create", payload_with_id)
            logger.info(f"    ✅ Created agent: {agent_id}")
            logger.info(f"    📋 Agent created with toolIds: {payload_with_id.get('meta', {}).get('toolIds', [])}")
            return True
        except OpenWebUIApiError as exc:
            logger.error(f"    ❌ Failed to create agent {agent_id}: {exc}")
            logger.error(f"    Response status: {exc.status if exc.status is not None else 'N/A'}")
            logger.error(f"    Response data: {exc.response_text[:200] if exc.response_text else 'N/A'}...")
            return False

    async def update_base_models_system_prompt(
        self,
        page_or_client,
        system_prompt: str,
        skip_model_ids: List[str] = None,
    ) -> bool:
        """
        Apply base system prompt to all base models.

        Args:
            page_or_client: Playwright page object or Open WebUI API client
            system_prompt: System prompt content to apply
            skip_model_ids: Optional list of model IDs to skip (e.g., obsolete models)

        Returns:
            True if all base models updated successfully, False otherwise
        """
        if skip_model_ids is None:
            skip_model_ids = []
        logger.info("=" * 60)
        logger.info("📝 Applying Base System Prompt to Base Models")
        logger.info("=" * 60)

        if not system_prompt:
            logger.warning("No base system prompt content provided, skipping")
            return True
        client = coerce_open_webui_api_client(page_or_client)

        # Get user ID first
        try:
            auth_data = await client.get_json("/api/v1/auths/")
        except OpenWebUIApiError as exc:
            logger.error(f"❌ Failed to get user ID: {exc}")
            return False

        user_id = auth_data.get('id')
        logger.info(f"✅ Got user ID: {user_id}")

        # Fetch all models using /api/models? endpoint
        try:
            all_models_data = await client.get_json("/api/models?")
        except OpenWebUIApiError as exc:
            logger.error(f"❌ Failed to fetch models: {exc}")
            return False

        # Handle response format (might be wrapped in 'data' key)
        if isinstance(all_models_data, dict) and 'data' in all_models_data:
            all_models = all_models_data['data']
        else:
            all_models = all_models_data

        logger.info(f"Found {len(all_models)} total models")

        # Filter to only base models (info.base_model_id == null)
        actual_base_models = []
        for model in all_models:
            info = model.get('info', {})
            if info and info.get('base_model_id') is None:
                actual_base_models.append(model)

        logger.info(f"Filtered to {len(actual_base_models)} actual base models (info.base_model_id == null)")

        # Filter out models to skip
        if skip_model_ids:
            logger.info(f"Skipping {len(skip_model_ids)} obsolete models: {skip_model_ids}")
            actual_base_models = [m for m in actual_base_models if m.get('id') not in skip_model_ids]
            logger.info(f"After filtering: {len(actual_base_models)} base models to update")

        if not actual_base_models:
            logger.warning("No base models found to update")
            return True

        # Update each base model by fetching individually first
        success_count = 0
        skipped_count = 0
        for model_summary in actual_base_models:
            model_id = model_summary.get('id')
            model_name = model_summary.get('name', model_id)

            # Double-check skip list (defensive)
            if model_id in skip_model_ids:
                logger.info(f"  ⏭️  Skipping obsolete model: {model_name}")
                skipped_count += 1
                continue

            logger.info(f"  Updating base model: {model_name}")

            # Fetch FULL model data individually (same approach as subagents)
            # Try multiple endpoints to get complete data including params.system
            model = None
            encoded_model_id = quote(model_id, safe="")
            endpoints_to_try = [
                {"url": "/api/v1/models/model", "use_query_id": True},
                {"url": f"/api/models/{encoded_model_id}", "use_query_id": False},
                {"url": f"/api/v1/models/{encoded_model_id}", "use_query_id": False},
            ]

            for endpoint in endpoints_to_try:
                try:
                    request_params = {"id": model_id} if endpoint["use_query_id"] else None
                    model = await client.get_json(endpoint["url"], params=request_params)
                    logger.info(
                        f"    ✅ Fetched full model data from {endpoint['url']} "
                        f"(use_query_id={endpoint['use_query_id']})"
                    )
                    break
                except OpenWebUIApiError:
                    continue

            if not model:
                logger.error(f"    ❌ Failed to fetch full model data for {model_id}")
                continue

            # DEBUG: Log fetched model data
            logger.info(f"    📋 Fetched model data keys: {list(model.keys())}")
            logger.info(f"    📋 Current meta.toolIds: {model.get('meta', {}).get('toolIds', [])}")

            # Update params.system with base system prompt
            if 'params' not in model:
                model['params'] = {}

            old_system_prompt = model['params'].get('system', '')
            logger.info(f"    📋 Old system prompt length: {len(old_system_prompt)} chars")
            logger.info(f"    📋 New system prompt length: {len(system_prompt)} chars")

            model['params']['system'] = system_prompt

            # Add user_id for update operation (REQUIRED)
            model['user_id'] = user_id
            logger.info(f"    📋 Added user_id: {user_id}")

            # Remove read-only fields that cause issues (same as subagents)
            removed_fields = []
            if 'user' in model:
                del model['user']
                removed_fields.append('user')
            if 'info' in model:
                del model['info']  # Info is read-only, causes 422
                removed_fields.append('info')

            if removed_fields:
                logger.info(f"    📋 Removed read-only fields: {removed_fields}")

            model_json = json.dumps(model)
            logger.info(f"    📋 Payload size: {len(model_json)} bytes")

            # DEBUG: Log actual payload structure
            logger.info(f"    📋 Payload keys: {list(model.keys())}")
            logger.info(f"    📋 Payload params.system preview: {model.get('params', {}).get('system', '')[:200]}...")
            logger.info(f"    📋 Payload has user_id: {'user_id' in model}")
            logger.info(f"    📋 Payload has info: {'info' in model}")
            logger.info(f"    📋 Payload has user: {'user' in model}")

            try:
                await client.post_text(
                    "/api/v1/models/model/update",
                    model,
                    params={"id": model_id},
                )
                result_update_status = "success"
                result_update_http_status = "OK"
                result_update_error = ""
            except OpenWebUIApiError as exc:
                result_update_status = "failed"
                result_update_http_status = exc.status if exc.status is not None else "N/A"
                result_update_error = exc.response_text or str(exc)

            logger.info(
                f"    📋 Update endpoint: /api/v1/models/model/update?id=<encoded> "
                f"(model_id={model_id})"
            )
            logger.info(f"    📋 Response status: {result_update_http_status}")
            logger.info(f"    📋 Response success: {result_update_status == 'success'}")

            if result_update_status == "success":
                logger.info(f"    ✅ Updated: {model_name}")
                # Verify update by re-fetching
                try:
                    verify_data = await client.get_json(
                        "/api/v1/models/model",
                        params={"id": model_id},
                    )
                    system_prompt_length = len(verify_data.get("params", {}).get("system", ""))
                    logger.info(f"    ✅ Verified: System prompt now {system_prompt_length} chars")
                except OpenWebUIApiError:
                    pass
                success_count += 1
            else:
                logger.error(f"    ❌ Failed to update {model_name}: status={result_update_http_status}")
                logger.error(f"    📋 Response data: {result_update_error}")

        # Summary
        logger.info("=" * 60)
        logger.info(f"📊 Base Model Update Summary:")
        logger.info(f"  Total base models processed: {len(actual_base_models)}")
        logger.info(f"  Successfully updated: {success_count}")
        logger.info(f"  Skipped (obsolete): {len(skip_model_ids) if skip_model_ids else 0}")
        logger.info(f"  Failed: {len(actual_base_models) - success_count - skipped_count}")
        logger.info("=" * 60)

        return success_count == len(actual_base_models) - skipped_count
