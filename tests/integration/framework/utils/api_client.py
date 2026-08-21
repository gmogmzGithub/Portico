"""
Open WebUI API Client

HTTP client for interacting with the Open WebUI API.
Based on patterns from simulate-owui-chat.py.
"""

import json
import os
import sys
import time
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

import httpx


def _is_message_done(value: Any) -> bool:
    """Normalize done flags that may be stored as bools or strings."""
    if isinstance(value, str):
        return value.lower() == "true"
    return value is True


def _normalize_reason(value: Any) -> str:
    """Normalize finish and stop reasons for comparison."""
    if value is None:
        return ""
    return str(value).strip().lower()


def _has_pending_tool_calls(message: Dict[str, Any]) -> bool:
    """Detect tool call blocks that have not been fully resolved yet."""
    content_blocks = message.get("contentBlocks")
    if isinstance(content_blocks, list):
        for block in content_blocks:
            if not isinstance(block, dict) or block.get("type") != "tool_calls":
                continue
            content = block.get("content") or []
            results = block.get("results") or []
            if not isinstance(content, list) or not isinstance(results, list):
                return True
            if len(results) < len(content):
                return True
            if not block.get("ended_at"):
                return True
        return False

    content = message.get("content")
    if isinstance(content, str) and '<details type="tool_calls" done="false"' in content:
        return True

    if message.get("tool_calls") and not message.get("tool_results"):
        return True

    return False


def _message_has_content(message: Dict[str, Any]) -> bool:
    """Require non-empty content before surfacing a completion."""
    content = message.get("content")
    if isinstance(content, str):
        return bool(content.strip())
    if isinstance(content, list):
        return len(content) > 0
    return bool(content)


def _is_message_complete(message: Dict[str, Any]) -> bool:
    """Detect a completed assistant message without returning too early."""
    if not isinstance(message, dict) or message.get("role") != "assistant":
        return False
    if _has_pending_tool_calls(message):
        return False
    if _is_message_done(message.get("done")):
        return True

    finish_reason = _normalize_reason(
        message.get("finish_reason") or message.get("finishReason")
    )
    stop_reason = _normalize_reason(
        message.get("stop_reason") or message.get("stopReason")
    )
    if finish_reason in {
        "length",
        "max_tokens",
        "max_output_tokens",
        "content_length",
        "tool_calls",
    }:
        return False
    if stop_reason in {
        "length",
        "max_tokens",
        "max_output_tokens",
        "tool_use",
        "tool_calls",
    }:
        return False
    if _has_pending_tool_calls(message):
        return False

    usage = message.get("usage") or {}
    if _message_has_content(message) and (
        usage.get("total_tokens")
        or usage.get("completion_tokens")
        or usage.get("prompt_tokens")
    ):
        return True

    return False


def _extract_error_message(message: Dict[str, Any]) -> str:
    """Normalize chat message error payloads into a readable string."""
    error_data = message.get("error")
    if isinstance(error_data, str):
        return error_data
    if isinstance(error_data, dict):
        content = error_data.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, dict):
            return (
                content.get("message")
                or content.get("content")
                or content.get("error")
                or str(content)
            )
        return (
            error_data.get("message")
            or error_data.get("error")
            or error_data.get("detail")
            or str(error_data)
        )
    return str(error_data or "Unknown chat error")


class OWUIClient:
    """Client for Open WebUI API interactions."""

    def __init__(
        self,
        base_url: str = None,
        token: str = None,
        timeout: float = 30.0
    ):
        """
        Initialize the OWUI client.

        Args:
            base_url: Base URL for Open WebUI (default: from env or localhost:8080)
            token: API token (default: from Redis or env)
            timeout: Request timeout in seconds
        """
        self.base_url = base_url or os.getenv("OPENWEBUI_BASE_URL", "http://localhost:8080")
        self._token = token
        self.timeout = timeout
        self._client: Optional[httpx.Client] = None

    @property
    def token(self) -> str:
        """Get a valid API token, reauthenticating if cached state is stale."""
        candidate_tokens = []

        if self._token:
            candidate_tokens.append(self._token)

        env_token = os.getenv("OWUI_API_TOKEN")
        if env_token and env_token not in candidate_tokens:
            candidate_tokens.append(env_token)

        # Try Redis-backed cached token from the running app.
        try:
            import redis

            redis_host = os.getenv("REDIS_HOST", "localhost")
            redis_port = int(os.getenv("REDIS_PORT", "6379"))
            r = redis.Redis(host=redis_host, port=redis_port, decode_responses=True)
            redis_token = r.get("openwebui:api_token")
            if redis_token and redis_token not in candidate_tokens:
                candidate_tokens.append(redis_token)
        except Exception:
            pass

        for candidate in candidate_tokens:
            if self._token_is_valid(candidate):
                self._token = candidate
                os.environ["OWUI_API_TOKEN"] = candidate
                return candidate

        token = self._service_token_for_token()
        self._token = token
        os.environ["OWUI_API_TOKEN"] = token
        return token

    @property
    def client(self) -> httpx.Client:
        """Get or create HTTP client."""
        if self._client is None:
            self._client = httpx.Client(
                base_url=self.base_url,
                timeout=self.timeout,
                headers={
                    "Authorization": f"Bearer {self.token}",
                    "Content-Type": "application/json",
                }
            )
        return self._client

    def _token_is_valid(self, token: str) -> bool:
        """Check whether a bearer token can access authenticated user routes."""
        if not token:
            return False

        try:
            response = httpx.get(
                f"{self.base_url}/api/v1/auths/",
                timeout=self.timeout,
                headers={"Authorization": f"Bearer {token}"},
            )
            return response.status_code == 200
        except httpx.HTTPError:
            return False

    def _bridge_secret(self) -> str:
        file_path = (os.getenv("OWUI_AUTH_BRIDGE_SECRET_FILE") or "").strip()
        if file_path:
            try:
                with open(file_path, "r", encoding="utf-8") as handle:
                    value = handle.read().strip()
                if value:
                    return value
            except OSError:
                pass
        return (os.getenv("OWUI_AUTH_BRIDGE_SECRET") or "").strip()

    def _service_token_for_token(self) -> str:
        """Mint a service-principal token through the local auth bridge."""
        bridge_secret = self._bridge_secret()
        if not bridge_secret:
            raise RuntimeError(
                "Open WebUI API token unavailable. Set OWUI_API_TOKEN, seed Redis "
                "openwebui:api_token, or configure OWUI_AUTH_BRIDGE_SECRET(_FILE)."
            )

        response = httpx.post(
            f"{self.base_url}/api/v1/portico/auth/service-token",
            timeout=self.timeout,
            json={"reason": "integration-api-client"},
            headers={
                "Authorization": f"Bearer {bridge_secret}",
                "Content-Type": "application/json",
            },
        )
        response.raise_for_status()

        data = response.json()
        token = data.get("token") or data.get("access_token")
        if not token:
            raise RuntimeError("Open WebUI service-token bridge succeeded but no token was returned")

        if self._client is not None:
            self._client.close()
            self._client = None

        return token

    def close(self):
        """Close the HTTP client."""
        if self._client:
            self._client.close()
            self._client = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    # ==========================================================================
    # Folder Operations
    # ==========================================================================

    def get_folders(self) -> List[Dict]:
        """Get all folders."""
        response = self.client.get("/api/v1/folders/")
        response.raise_for_status()
        return response.json()

    def ensure_folder(self, name: str) -> str:
        """Ensure folder exists, create if needed. Returns folder ID."""
        folders = self.get_folders()
        matches = [
            folder
            for folder in folders
            if folder.get("name") == name and folder.get("id")
        ]
        if matches:
            canonical_folder = min(
                matches,
                key=lambda folder: (
                    0 if folder.get("parent_id") in (None, "", "null") else 1,
                    int(folder.get("created_at", sys.maxsize))
                    if str(folder.get("created_at", "")).isdigit()
                    else sys.maxsize,
                    str(folder.get("id", "")),
                ),
            )
            return canonical_folder["id"]

        # Create folder
        response = self.client.post(
            "/api/v1/folders/",
            json={"name": name, "data": {"system_prompt": "", "files": []}}
        )
        response.raise_for_status()
        return response.json()["id"]

    # ==========================================================================
    # Chat Operations
    # ==========================================================================

    def create_chat(
        self,
        model: str,
        prompt: str,
        folder_id: Optional[str] = None
    ) -> Dict[str, str]:
        """
        Create a new chat with initial user message.

        Returns:
            Dict with: chat_id, user_message_id, timestamp
        """
        user_message_id = str(uuid.uuid4())
        timestamp = int(time.time())

        chat_payload = {
            "chat": {
                "id": "",
                "title": "Integration Test Chat",
                "models": [model],
                "params": {},
                "history": {
                    "messages": {
                        user_message_id: {
                            "id": user_message_id,
                            "parentId": None,
                            "childrenIds": [],
                            "role": "user",
                            "content": prompt,
                            "timestamp": timestamp,
                            "models": [model]
                        }
                    },
                    "currentId": user_message_id
                },
                "messages": [
                    {
                        "id": user_message_id,
                        "parentId": None,
                        "childrenIds": [],
                        "role": "user",
                        "content": prompt,
                        "timestamp": timestamp,
                        "models": [model]
                    }
                ],
                "tags": [],
                "timestamp": timestamp * 1000
            }
        }

        if folder_id:
            chat_payload["folder_id"] = folder_id

        response = self.client.post("/api/v1/chats/new", json=chat_payload)
        response.raise_for_status()
        chat_data = response.json()

        return {
            "chat_id": chat_data["id"],
            "user_message_id": user_message_id,
            "timestamp": timestamp
        }

    def append_user_message(
        self,
        chat_id: str,
        model: str,
        prompt: str,
        parent_id: Optional[str] = None,
    ) -> Dict[str, str]:
        """Append a new user message to an existing chat."""
        chat_wrapper = self.get_chat(chat_id)
        chat_data = chat_wrapper.get("chat", chat_wrapper)
        history = chat_data.setdefault("history", {})
        history_messages = history.setdefault("messages", {})
        messages = chat_data.setdefault("messages", [])

        if parent_id is None:
            parent_id = history.get("currentId")
        if not parent_id:
            raise RuntimeError(f"Chat {chat_id} is missing a currentId for follow-up")

        user_message_id = str(uuid.uuid4())
        timestamp = int(time.time())
        user_message = {
            "id": user_message_id,
            "parentId": parent_id,
            "childrenIds": [],
            "role": "user",
            "content": prompt,
            "timestamp": timestamp,
            "models": [model],
        }

        parent_message = history_messages.get(parent_id)
        if isinstance(parent_message, dict):
            parent_message.setdefault("childrenIds", [])
            if user_message_id not in parent_message["childrenIds"]:
                parent_message["childrenIds"].append(user_message_id)

        history_messages[user_message_id] = user_message
        messages.append(user_message)
        history["currentId"] = user_message_id

        self.update_chat(chat_id, chat_data)
        return {
            "chat_id": chat_id,
            "user_message_id": user_message_id,
            "timestamp": timestamp,
        }

    def get_chat(self, chat_id: str) -> Dict:
        """Get full chat data."""
        response = self.client.get(f"/api/v1/chats/{chat_id}")
        response.raise_for_status()
        return response.json()

    def update_chat(self, chat_id: str, chat_data: Dict) -> Dict:
        """Update chat data."""
        response = self.client.post(
            f"/api/v1/chats/{chat_id}",
            json={"chat": chat_data}
        )
        response.raise_for_status()
        return response.json()

    def delete_chat(self, chat_id: str) -> bool:
        """Delete a chat."""
        try:
            response = self.client.delete(f"/api/v1/chats/{chat_id}")
            response.raise_for_status()
            return True
        except httpx.HTTPError:
            return False

    # ==========================================================================
    # Model Operations
    # ==========================================================================

    def get_models(self) -> List[Dict]:
        """Get available models."""
        response = self.client.get("/api/models?")
        response.raise_for_status()
        data = response.json()
        return data.get("data", [])

    def get_model_item(self, model_id: str) -> Dict:
        """Get model item by ID."""
        models = self.get_models()
        for model in models:
            if model.get("id") == model_id:
                return model
        raise ValueError(f"Model '{model_id}' not found")

    # ==========================================================================
    # Tool Operations
    # ==========================================================================

    def get_tools(self) -> List[Dict]:
        """Get available tools."""
        response = self.client.get("/api/v1/tools/")
        response.raise_for_status()
        return response.json()

    def get_tool_ids(self) -> List[str]:
        """Get list of tool IDs."""
        tools = self.get_tools()
        return [t["id"] for t in tools if "id" in t]

    def get_chat_active_capability_tool_ids(self, chat_id: str) -> List[str]:
        """Return the active server tool IDs the real chat frontend would submit."""
        response = self.client.get(f"/api/v1/chats/{chat_id}/active-capabilities")
        response.raise_for_status()
        payload = response.json()
        tools = payload.get("tools", []) if isinstance(payload, dict) else []

        tool_ids: List[str] = []
        seen = set()
        for tool in tools if isinstance(tools, list) else []:
            if not isinstance(tool, dict):
                continue
            server_id = tool.get("server_id")
            if not isinstance(server_id, str) or not server_id.strip():
                continue
            tool_id = f"server:{server_id.strip()}"
            if tool_id in seen:
                continue
            seen.add(tool_id)
            tool_ids.append(tool_id)
        return tool_ids

    # ==========================================================================
    # Completion Operations
    # ==========================================================================

    def generate_completion(
        self,
        chat_id: str,
        model: str,
        prompt: str,
        user_message_id: str = None,
        stream: bool = False,
        reasoning_effort: str | None = None,
        tool_ids: Optional[List[str]] = None,
    ) -> Dict:
        """
        Trigger completion generation.

        Returns:
            Dict with task_id and status
        """
        model_item = self.get_model_item(model)
        resolved_tool_ids = (
            list(tool_ids)
            if tool_ids is not None
            else self.get_chat_active_capability_tool_ids(chat_id)
        )
        session_id = self._generate_session_id()
        variables = self._generate_variables()
        message_id = str(uuid.uuid4())

        completion_payload = {
            "stream": stream,
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "params": {"function_calling": "native"},
            "tool_ids": resolved_tool_ids,
            "tool_servers": [],
            "features": {
                "image_generation": False,
                "code_interpreter": False,
                "web_search": False
            },
            "variables": variables,
            "model_item": model_item,
            "session_id": session_id,
            "chat_id": chat_id,
            "id": message_id,
            "parent_id": user_message_id,
            "parent_message": {
                "id": user_message_id,
                "files": []
            },
            "background_tasks": {
                "title_generation": False,
                "tags_generation": False,
                "follow_up_generation": False
            }
        }

        if reasoning_effort:
            completion_payload["params"]["reasoning_effort"] = reasoning_effort

        response = self.client.post(
            "/api/chat/completions",
            json=completion_payload,
            timeout=60.0
        )
        response.raise_for_status()
        result = response.json()
        result.setdefault("session_id", session_id)
        result.setdefault("message_id", message_id)
        return result

    def poll_for_completion(
        self,
        chat_id: str,
        user_message_id: str,
        timeout_seconds: int = 300,
        poll_interval: float = 2.0
    ) -> Dict:
        """
        Poll chat until assistant response is complete.

        Returns:
            Dict with assistant message data
        """
        start_time = time.time()
        last_poll_error: Optional[str] = None

        while time.time() - start_time < timeout_seconds:
            try:
                chat = self.get_chat(chat_id)
                last_poll_error = None
            except Exception as exc:
                last_poll_error = str(exc)
                time.sleep(poll_interval)
                continue
            chat_data = chat.get("chat", {})
            messages = chat_data.get("messages", []) or []
            history_messages = list((chat_data.get("history", {}).get("messages", {}) or {}).values())

            for message_group in (messages, history_messages):
                for msg in message_group:
                    if not isinstance(msg, dict):
                        continue
                    if "error" in msg:
                        return {
                            "complete": False,
                            "error": _extract_error_message(msg),
                            "assistant_message_id": msg.get("id"),
                        }

            seen_message_ids = set()
            for message_group in (history_messages, messages):
                for msg in message_group:
                    if not isinstance(msg, dict):
                        continue
                    if msg.get("role") != "assistant" or msg.get("parentId") != user_message_id:
                        continue
                    message_id = msg.get("id")
                    if message_id and message_id in seen_message_ids:
                        continue
                    if message_id:
                        seen_message_ids.add(message_id)
                    if msg.get("pending", False):
                        continue
                    if not _is_message_complete(msg):
                        continue
                    if not _message_has_content(msg):
                        continue
                    return {
                        "assistant_message_id": message_id,
                        "content": msg.get("content", ""),
                        "tool_calls": msg.get("tool_calls", []),
                        "content_blocks": msg.get("contentBlocks", []),
                        "model": msg.get("model"),
                        "complete": True,
                    }

            time.sleep(poll_interval)

        error = "Timeout waiting for completion"
        if last_poll_error:
            error = f"{error} (last poll error: {last_poll_error})"
        return {"complete": False, "error": error}

    # ==========================================================================
    # Helper Methods
    # ==========================================================================

    def _generate_session_id(self) -> str:
        """Generate a session ID."""
        import random
        import string
        chars = string.ascii_letters + string.digits + '_'
        return ''.join(random.choice(chars) for _ in range(24))

    def _generate_variables(self) -> Dict[str, str]:
        """Generate datetime variables."""
        now = datetime.now()
        return {
            "{{USER_NAME}}": "TestUser",
            "{{USER_LOCATION}}": "Test",
            "{{CURRENT_DATETIME}}": now.strftime("%Y-%m-%d %H:%M:%S"),
            "{{CURRENT_DATE}}": now.strftime("%Y-%m-%d"),
            "{{CURRENT_TIME}}": now.strftime("%H:%M:%S"),
            "{{CURRENT_WEEKDAY}}": now.strftime("%A"),
            "{{CURRENT_TIMEZONE}}": "UTC",
            "{{USER_LANGUAGE}}": "en-US"
        }
