"""
Redis Checker Tool

Verifies Redis key existence and values for integration testing.
"""

import json
from typing import Any, Dict, List, Optional

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


async def check_redis(
    key: str,
    expected_value: Optional[Any] = None,
    expected_contains: Optional[List[str]] = None,
    should_exist: bool = True,
    auto_assert: bool = True
) -> Dict[str, Any]:
    """
    Check Redis key existence and value.

    Args:
        key: Redis key to check
        expected_value: Expected value (optional, for exact comparison)
        expected_contains: List of items that should exist in a JSON array value
        should_exist: Whether key should exist (default: True)

    Returns:
        Dict containing:
            - exists: Boolean indicating if key exists
            - value: The key's value (if exists)
            - ttl: TTL in seconds (-1 if no expiry, -2 if doesn't exist)
            - matches: Boolean indicating if value matches expected
            - contains_all: Boolean if all expected_contains items are present
            - missing_items: List of expected items not found
            - diff: Description of difference if value doesn't match
    """
    client = get_redis_client()

    try:
        exists = client.exists(key)
        value = None
        parsed_value = None
        ttl = client.ttl(key)

        if exists:
            raw_value = client.get(key)
            value = raw_value

            # Try to parse as JSON
            try:
                parsed_value = json.loads(raw_value)
                value = parsed_value
            except (json.JSONDecodeError, TypeError):
                pass

        result = {
            "exists": exists,
            "value": value,
            "ttl": ttl,
            "key": key
        }

        # Check existence expectation
        if should_exist and not exists:
            result["matches"] = False
            result["diff"] = f"Key '{key}' does not exist but should"
        elif not should_exist and exists:
            result["matches"] = False
            result["diff"] = f"Key '{key}' exists but should not"
        else:
            result["matches"] = True

        # Check exact value match
        if expected_value is not None and exists:
            if value == expected_value:
                result["value_matches"] = True
            else:
                result["value_matches"] = False
                result["diff"] = f"Expected: {expected_value}, Got: {value}"
                result["matches"] = False

        # Check contains
        if expected_contains is not None and exists:
            if isinstance(value, list):
                found = [item for item in expected_contains if item in value]
                missing = [item for item in expected_contains if item not in value]
                extra = [item for item in value if item not in expected_contains]

                result["contains_all"] = len(missing) == 0
                result["found_items"] = found
                result["missing_items"] = missing
                result["extra_items"] = extra

                if missing:
                    result["matches"] = False
                    result["diff"] = f"Missing items: {missing}"
            else:
                result["contains_all"] = False
                result["missing_items"] = expected_contains
                result["diff"] = f"Value is not a list: {type(value).__name__}"
                result["matches"] = False

        if auto_assert:
            if result.get("matches", False):
                await assert_condition(
                    condition=True,
                    message=f"Redis key '{key}' verified successfully",
                    severity="critical"
                )
            else:
                await assert_condition(
                    condition=False,
                    message=f"Redis check failed: {result.get('diff', 'Unexpected result')}",
                    severity="critical"
                )

        return result

    except Exception as e:
        if auto_assert:
            await assert_condition(
                condition=False,
                message=f"Redis check error for key '{key}': {str(e)}",
                severity="critical"
            )
        return {
            "exists": False,
            "error": str(e),
            "key": key,
            "matches": False
        }


async def delete_redis_keys(
    patterns: List[str],
    auto_assert: bool = True
) -> Dict[str, Any]:
    """
    Delete Redis keys matching patterns.

    Args:
        patterns: List of key patterns to delete (supports Redis glob patterns)
        auto_assert: Automatically record assertion (default True)

    Returns:
        Dict with deletion results
    """
    client = get_redis_client()

    try:
        deleted_count = 0
        deleted_keys = []

        for pattern in patterns:
            keys = client.keys(pattern)
            if keys:
                deleted_count += client.delete(*keys)
                deleted_keys.extend(keys)

        if auto_assert:
            await assert_condition(
                condition=True,
                message=f"Redis keys cleared successfully (deleted {deleted_count} keys)",
                severity="info"
            )

        return {
            "success": True,
            "deleted_count": deleted_count,
            "deleted_keys": deleted_keys
        }

    except Exception as e:
        if auto_assert:
            await assert_condition(
                condition=False,
                message=f"Failed to delete Redis keys: {str(e)}",
                severity="critical"
            )
        return {
            "success": False,
            "error": str(e),
            "deleted_count": 0
        }


# Tool definitions for Atlas Agent SDK
CHECK_REDIS_TOOL = {
    "name": "check_redis",
    "description": "Check Redis key existence and value. Verifies state stored in Redis for a chat.",
    "input_schema": {
        "type": "object",
        "properties": {
            "key": {
                "type": "string",
                "description": "Redis key to check (e.g., 'agent_vm:{chat_id}')"
            },
            "expected_value": {
                "description": "Expected value for exact comparison (optional)"
            },
            "expected_contains": {
                "type": "array",
                "items": {"type": "string"},
                "description": "List of items that should exist in a JSON array value"
            },
            "should_exist": {
                "type": "boolean",
                "description": "Whether the key should exist (default: true)",
                "default": True
            }
        },
        "required": ["key"]
    }
}

DELETE_REDIS_KEYS_TOOL = {
    "name": "delete_redis_keys",
    "description": "Delete Redis keys matching patterns. Use to clean up state before tests.",
    "input_schema": {
        "type": "object",
        "properties": {
            "patterns": {
                "type": "array",
                "items": {"type": "string"},
                "description": "List of key patterns to delete (supports * wildcards)"
            }
        },
        "required": ["patterns"]
    }
}
