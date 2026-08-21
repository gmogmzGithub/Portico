"""
Redis Client Helper

Provides Redis connection and common operations for the testing framework.
"""

import json
import os
import subprocess
from typing import Any, List, Optional

import redis


class RedisClient:
    """Redis client wrapper for integration testing."""

    def __init__(
        self,
        host: str = None,
        port: int = None,
        db: int = 0,
        decode_responses: bool = True
    ):
        """
        Initialize Redis client.

        Args:
            host: Redis host (default: from env or localhost)
            port: Redis port (default: from env or 6379)
            db: Redis database number
            decode_responses: Decode bytes to strings
        """
        self.host = host or os.getenv("REDIS_HOST", "localhost")
        self.port = port or int(os.getenv("REDIS_PORT", "6379"))
        self._configured_host = self.host
        self._configured_port = self.port
        self.db = db
        self.decode_responses = decode_responses
        self._client: Optional[redis.Redis] = None

    @property
    def client(self) -> redis.Redis:
        """Get or create Redis client."""
        if self._client is None:
            self._client = self._build_client(self.host, self.port)
        return self._client

    def _build_client(self, host: str, port: int) -> redis.Redis:
        """Build a Redis client for the current host/port."""
        return redis.Redis(
            host=host,
            port=port,
            db=self.db,
            decode_responses=self.decode_responses,
            socket_connect_timeout=5,
        )

    def _resolve_runtime_connection(self) -> Optional[tuple[str, int]]:
        """Resolve the current Redis connection from Docker when local IPs drift."""
        container_name = os.getenv("DEFAULT_REDIS_CONTAINER", "portico-redis")

        try:
            inspect = subprocess.run(
                [
                    "docker",
                    "inspect",
                    container_name,
                    "--format",
                    "{{json .NetworkSettings.Networks}}",
                ],
                capture_output=True,
                check=True,
                text=True,
                timeout=5,
            )
            networks = json.loads(inspect.stdout.strip() or "{}")
            if isinstance(networks, dict):
                for network_data in networks.values():
                    if not isinstance(network_data, dict):
                        continue
                    ip_address = str(network_data.get("IPAddress") or "").strip()
                    if ip_address:
                        return ip_address, self._configured_port
        except Exception:
            pass

        try:
            port_result = subprocess.run(
                ["docker", "port", container_name, f"{self._configured_port}/tcp"],
                capture_output=True,
                check=True,
                text=True,
                timeout=5,
            )
            mapping = (port_result.stdout or "").strip().splitlines()
            if mapping:
                host_port = mapping[0].rsplit(":", 1)[-1].strip()
                if host_port.isdigit():
                    return "127.0.0.1", int(host_port)
        except Exception:
            pass

        return None

    def _reconnect_with_runtime_resolution(self) -> bool:
        """Reconnect using the current Docker-discovered Redis endpoint if possible."""
        resolved = self._resolve_runtime_connection()
        candidates = []
        if resolved:
            candidates.append(resolved)
        candidates.append((self._configured_host, self._configured_port))

        seen = set()
        for host, port in candidates:
            if (host, port) in seen:
                continue
            seen.add((host, port))
            try:
                candidate = self._build_client(host, port)
                candidate.ping()
            except Exception:
                continue

            self.close()
            self.host = host
            self.port = port
            self._client = candidate
            return True

        return False

    def _run(self, operation):
        """Run a Redis operation with one reconnect attempt on connection errors."""
        try:
            return operation(self.client)
        except redis.exceptions.RedisError:
            if self._reconnect_with_runtime_resolution():
                return operation(self.client)
            raise

    def close(self):
        """Close the Redis connection."""
        if self._client:
            self._client.close()
            self._client = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    # ==========================================================================
    # Basic Operations
    # ==========================================================================

    def get(self, key: str) -> Optional[str]:
        """Get a key value."""
        return self._run(lambda client: client.get(key))

    def set(self, key: str, value: str, ex: int = None) -> bool:
        """Set a key value with optional expiration."""
        return self._run(lambda client: client.set(key, value, ex=ex))

    def delete(self, *keys: str) -> int:
        """Delete one or more keys."""
        return self._run(lambda client: client.delete(*keys))

    def exists(self, key: str) -> bool:
        """Check if key exists."""
        return self._run(lambda client: client.exists(key)) > 0

    def ttl(self, key: str) -> int:
        """Get TTL for a key (-1 if no expiry, -2 if key doesn't exist)."""
        return self._run(lambda client: client.ttl(key))

    def keys(self, pattern: str) -> List[str]:
        """Get keys matching pattern."""
        return self._run(lambda client: client.keys(pattern))

    # ==========================================================================
    # JSON Operations
    # ==========================================================================

    def get_json(self, key: str) -> Optional[Any]:
        """Get a key and parse as JSON."""
        value = self.get(key)
        if value:
            try:
                return json.loads(value)
            except json.JSONDecodeError:
                return value
        return None

    def set_json(self, key: str, value: Any, ex: int = None) -> bool:
        """Set a key with JSON-serialized value."""
        return self.set(key, json.dumps(value), ex=ex)

    # ==========================================================================
    # Chat-Specific Operations
    # ==========================================================================

    def get_agent_vm_id(self, chat_id: str) -> Optional[str]:
        """Get the agent VM ID for a chat."""
        return self.get(f"agent_vm:{chat_id}")

    def get_chat_tools(self, chat_id: str) -> List[str]:
        """Get enabled tool servers for a chat."""
        data = self.get_json(f"chat_tools:{chat_id}")
        return data if isinstance(data, list) else []

    def get_chat_skills(self, chat_id: str) -> List[str]:
        """Get activated skills for a chat."""
        data = self.get_json(f"chat_skills:{chat_id}")
        return data if isinstance(data, list) else []

    def delete_chat_state(self, chat_id: str) -> int:
        """Delete all Redis state for a chat."""
        keys_to_delete = [
            f"agent_vm:{chat_id}",
            f"chat_tools:{chat_id}",
            f"chat_skills:{chat_id}",
        ]
        # Also find any pattern-matched keys
        for pattern in [f"*:{chat_id}", f"*:{chat_id}:*"]:
            keys_to_delete.extend(self.keys(pattern))

        if keys_to_delete:
            return self.delete(*keys_to_delete)
        return 0

    def delete_test_keys(self, pattern: str = "test-*") -> int:
        """Delete all keys matching a test pattern."""
        count = 0
        for key_pattern in [
            f"agent_vm:{pattern}",
            f"chat_tools:{pattern}",
            f"chat_skills:{pattern}",
        ]:
            keys = self.keys(key_pattern)
            if keys:
                count += self.delete(*keys)
        return count

    # ==========================================================================
    # Verification Helpers
    # ==========================================================================

    def verify_key_exists(self, key: str) -> dict:
        """Verify a key exists and return its value and TTL."""
        exists = self.exists(key)
        return {
            "exists": exists,
            "value": self.get(key) if exists else None,
            "ttl": self.ttl(key) if exists else -2
        }

    def verify_list_contains(self, key: str, expected_items: List[str]) -> dict:
        """Verify a JSON list key contains expected items."""
        data = self.get_json(key)
        if not isinstance(data, list):
            return {
                "exists": data is not None,
                "is_list": False,
                "value": data,
                "missing": expected_items,
                "found": []
            }

        found = [item for item in expected_items if item in data]
        missing = [item for item in expected_items if item not in data]
        extra = [item for item in data if item not in expected_items]

        return {
            "exists": True,
            "is_list": True,
            "value": data,
            "found": found,
            "missing": missing,
            "extra": extra,
            "all_found": len(missing) == 0
        }
