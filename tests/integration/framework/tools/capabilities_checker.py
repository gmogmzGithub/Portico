"""
Capabilities Checker Tool

Verifies that MCP tool servers and skills are enabled correctly for chats.
"""

from typing import Any, Dict, List

from ..utils.redis_client import RedisClient
from .assertions import assert_condition


# Global client instance
_client: RedisClient = None


def get_redis_client() -> RedisClient:
    """Get or create the Redis client."""
    global _client
    if _client is None:
        _client = RedisClient()
    return _client


async def verify_enabled_tools(
    chat_id: str,
    expected_tools: List[str],
    auto_assert: bool = True
) -> Dict[str, Any]:
    """
    Verify that specific MCP tool servers are enabled for a chat.

    Args:
        chat_id: Chat ID to check
        expected_tools: List of tool server IDs that should be enabled
                       (e.g., ["server:mcp-assistant", "server:agent-vm"])

    Returns:
        Dict containing:
            - success: Boolean indicating if all expected tools are enabled
            - enabled: List of currently enabled tool servers
            - expected: List of expected tools
            - missing: List of expected tools that are not enabled
            - extra: List of enabled tools not in expected list
            - chat_id: The chat ID checked
    """
    client = get_redis_client()

    try:
        key = f"chat_tools:{chat_id}"
        result = client.verify_list_contains(key, expected_tools)

        if not result.get("exists"):
            return {
                "success": False,
                "enabled": [],
                "expected": expected_tools,
                "missing": expected_tools,
                "extra": [],
                "chat_id": chat_id,
                "error": f"Key '{key}' does not exist"
            }

        if not result.get("is_list"):
            return {
                "success": False,
                "enabled": [],
                "expected": expected_tools,
                "missing": expected_tools,
                "extra": [],
                "chat_id": chat_id,
                "error": f"Value is not a list: {result.get('value')}"
            }

        response = {
            "success": result.get("all_found", False),
            "enabled": result.get("value", []),
            "expected": expected_tools,
            "missing": result.get("missing", []),
            "extra": result.get("extra", []),
            "chat_id": chat_id
        }

        # Auto-assert if enabled
        if auto_assert:
            missing = response.get("missing", [])
            if response["success"]:
                await assert_condition(
                    condition=True,
                    message=f"All expected tools enabled: {expected_tools}",
                    severity="critical"
                )
            else:
                await assert_condition(
                    condition=False,
                    message=f"Missing tools: {missing}. Expected: {expected_tools}, Got: {response.get('enabled', [])}",
                    severity="critical"
                )

        return response

    except Exception as e:
        response = {
            "success": False,
            "error": str(e),
            "enabled": [],
            "expected": expected_tools,
            "missing": expected_tools,
            "extra": [],
            "chat_id": chat_id
        }

        if auto_assert:
            await assert_condition(
                condition=False,
                message=f"Error verifying tools: {e}",
                severity="critical"
            )

        return response


async def verify_activated_skills(
    chat_id: str,
    expected_skills: List[str],
    auto_assert: bool = True
) -> Dict[str, Any]:
    """
    Verify that specific skills are activated for a chat.

    Args:
        chat_id: Chat ID to check
        expected_skills: List of skill names that should be activated
                        (e.g., ["artifacts", "frontend-design"])
        auto_assert: Automatically record assertion (default True)

    Returns:
        Dict containing:
            - success: Boolean indicating if all expected skills are activated
            - activated: List of currently activated skills
            - expected: List of expected skills
            - missing: List of expected skills that are not activated
            - extra: List of activated skills not in expected list
            - chat_id: The chat ID checked
    """
    client = get_redis_client()

    try:
        key = f"chat_skills:{chat_id}"
        result = client.verify_list_contains(key, expected_skills)

        if not result.get("exists"):
            response = {
                "success": False,
                "activated": [],
                "expected": expected_skills,
                "missing": expected_skills,
                "extra": [],
                "chat_id": chat_id,
                "error": f"Key '{key}' does not exist"
            }
            if auto_assert:
                await assert_condition(
                    condition=False,
                    message=f"Skills key does not exist for chat {chat_id}",
                    severity="critical"
                )
            return response

        if not result.get("is_list"):
            response = {
                "success": False,
                "activated": [],
                "expected": expected_skills,
                "missing": expected_skills,
                "extra": [],
                "chat_id": chat_id,
                "error": f"Value is not a list: {result.get('value')}"
            }
            if auto_assert:
                await assert_condition(
                    condition=False,
                    message=f"Skills value is not a list: {result.get('value')}",
                    severity="critical"
                )
            return response

        response = {
            "success": result.get("all_found", False),
            "activated": result.get("value", []),
            "expected": expected_skills,
            "missing": result.get("missing", []),
            "extra": result.get("extra", []),
            "chat_id": chat_id
        }

        if auto_assert:
            missing = response.get("missing", [])
            if response["success"]:
                await assert_condition(
                    condition=True,
                    message=f"All expected skills activated: {expected_skills}",
                    severity="critical"
                )
            else:
                await assert_condition(
                    condition=False,
                    message=f"Missing skills: {missing}. Expected: {expected_skills}, Got: {response.get('activated', [])}",
                    severity="critical"
                )

        return response

    except Exception as e:
        response = {
            "success": False,
            "error": str(e),
            "activated": [],
            "expected": expected_skills,
            "missing": expected_skills,
            "extra": [],
            "chat_id": chat_id
        }

        if auto_assert:
            await assert_condition(
                condition=False,
                message=f"Error verifying skills: {e}",
                severity="critical"
            )

        return response


async def get_chat_capabilities(
    chat_id: str
) -> Dict[str, Any]:
    """
    Get all capabilities (tools and skills) for a chat.

    Args:
        chat_id: Chat ID to check

    Returns:
        Dict containing all capability information
    """
    client = get_redis_client()

    try:
        tools = client.get_chat_tools(chat_id)
        skills = client.get_chat_skills(chat_id)
        vm_id = client.get_agent_vm_id(chat_id)

        return {
            "success": True,
            "chat_id": chat_id,
            "tools": tools,
            "skills": skills,
            "agent_vm_id": vm_id,
            "tool_count": len(tools),
            "skill_count": len(skills),
            "has_agent_vm": vm_id is not None
        }

    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "chat_id": chat_id
        }


# Tool definitions for Claude Agent SDK
VERIFY_ENABLED_TOOLS_TOOL = {
    "name": "verify_enabled_tools",
    "description": "Verify that specific MCP tool servers are enabled for a chat. Checks the chat_tools Redis key.",
    "input_schema": {
        "type": "object",
        "properties": {
            "chat_id": {
                "type": "string",
                "description": "The chat ID to check"
            },
            "expected_tools": {
                "type": "array",
                "items": {"type": "string"},
                "description": "List of tool server IDs that should be enabled (e.g., 'server:agent-vm')"
            }
        },
        "required": ["chat_id", "expected_tools"]
    }
}

VERIFY_ACTIVATED_SKILLS_TOOL = {
    "name": "verify_activated_skills",
    "description": "Verify that specific skills are activated for a chat. Checks the chat_skills Redis key.",
    "input_schema": {
        "type": "object",
        "properties": {
            "chat_id": {
                "type": "string",
                "description": "The chat ID to check"
            },
            "expected_skills": {
                "type": "array",
                "items": {"type": "string"},
                "description": "List of skill names that should be activated (e.g., 'artifacts')"
            }
        },
        "required": ["chat_id", "expected_skills"]
    }
}

GET_CHAT_CAPABILITIES_TOOL = {
    "name": "get_chat_capabilities",
    "description": "Get all capabilities (tools, skills, VM) for a chat.",
    "input_schema": {
        "type": "object",
        "properties": {
            "chat_id": {
                "type": "string",
                "description": "The chat ID to check"
            }
        },
        "required": ["chat_id"]
    }
}
