from __future__ import annotations

import json
import os
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any

import httpx
import pytest
import yaml


REPO_ROOT = Path(__file__).resolve().parents[2]
CORE_MCP_BASE_URL = os.getenv("MCPO_CORE_PROXY_BASE_URL", "http://127.0.0.1:8766").rstrip("/")
CHAT_STATE_API_BASE_URL = os.getenv("CHAT_STATE_API_BASE_URL", "http://localhost:3835").rstrip("/")
CORE_TOOL_SERVERS = {
    "server:mcp-assistant",
    "server:subagents",
    "server:skills",
    "server:agent-vm",
}
DEFAULT_REASONING_EFFORT_OPTIONS = ["low", "medium", "high", "max"]


def _resolve_runtime_redis_endpoint() -> tuple[str, str] | None:
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
            for network in networks.values():
                if not isinstance(network, dict):
                    continue
                ip_address = str(network.get("IPAddress") or "").strip()
                if ip_address:
                    return ip_address, "6379"
    except Exception:
        pass

    try:
        port_result = subprocess.run(
            ["docker", "port", container_name, "6379/tcp"],
            capture_output=True,
            check=True,
            text=True,
            timeout=5,
        )
        mapping = (port_result.stdout or "").strip().splitlines()
        if mapping:
            host_port = mapping[0].rsplit(":", 1)[-1].strip()
            if host_port.isdigit():
                return "127.0.0.1", host_port
    except Exception:
        pass

    return None


os.environ.setdefault("OPENWEBUI_BASE_URL", "http://127.0.0.1:3789")
if "REDIS_HOST" not in os.environ:
    resolved_redis = _resolve_runtime_redis_endpoint()
    if resolved_redis is not None:
        os.environ["REDIS_HOST"] = resolved_redis[0]
        os.environ.setdefault("REDIS_PORT", resolved_redis[1])


def _unwrap_tool_output(payload: Any) -> Any:
    if not isinstance(payload, dict):
        return payload
    content = payload.get("content")
    if (
        not isinstance(content, list)
        or not content
        or not isinstance(content[0], dict)
        or "text" not in content[0]
    ):
        return payload
    return json.loads(content[0]["text"])


def _call_tool_raw(server_id: str, tool_name: str, payload: dict[str, Any]) -> httpx.Response:
    prefix = server_id.replace("-", "_")
    url = f"{CORE_MCP_BASE_URL}/{server_id}/{prefix}_{tool_name}"
    return httpx.post(url, json=payload, timeout=300.0)


def _call_tool(server_id: str, tool_name: str, payload: dict[str, Any]) -> Any:
    response = _call_tool_raw(server_id, tool_name, payload)
    response.raise_for_status()
    return _unwrap_tool_output(response.json())


def _error_message_from_response(response: httpx.Response) -> str:
    try:
        payload = _unwrap_tool_output(response.json())
    except ValueError:
        return response.text

    if isinstance(payload, dict):
        return str(payload.get("message") or payload.get("content") or payload)
    return str(payload)


def _capture_new_chat_id(redis_client, existing_chat_tool_keys: set[str]) -> str:
    deadline = time.time() + 10.0
    while time.time() < deadline:
        new_keys = sorted(set(redis_client.keys("chat_tools:*")) - existing_chat_tool_keys)
        if new_keys:
            return new_keys[-1].split(":", 1)[1]
        time.sleep(0.5)

    raise AssertionError("Expected run_subagent to create a child chat")


def _run_subagent_and_capture_chat(
    redis_client,
    payload: dict[str, Any],
) -> tuple[dict[str, Any], str]:
    existing_chat_tool_keys = set(redis_client.keys("chat_tools:*"))
    response = _call_tool_raw("subagents", "run_subagent", payload)
    response.raise_for_status()
    result = _unwrap_tool_output(response.json())
    if not isinstance(result, dict):
        raise AssertionError(f"Expected structured run_subagent result, got: {result!r}")

    chat_id = result.get("chat_id")
    if isinstance(chat_id, str) and chat_id:
        return result, chat_id

    return result, _capture_new_chat_id(redis_client, existing_chat_tool_keys)


def _assert_run_subagent_outcome(result: dict[str, Any]) -> None:
    if result.get("success") is True:
        return

    error_text = json.dumps(result, sort_keys=True).lower()
    assert (
        "invalid_api_key" in error_text
        or "invalid api key" in error_text
        or "missing_authorization" in error_text
        or "authorization header is missing" in error_text
        or "authenticationerror" in error_text
    ), f"Unexpected run_subagent result: {result}"


def _load_reasoning_capabilities() -> dict[str, dict[str, Any]]:
    config_path = REPO_ROOT / "model_catalog.yaml"
    parsed = yaml.safe_load(config_path.read_text()) or {}
    model_list = parsed.get("model_list") or []
    capabilities: dict[str, dict[str, Any]] = {}
    for entry in model_list:
        if not isinstance(entry, dict):
            continue
        model_name = str(entry.get("model_name") or "").strip()
        if not model_name:
            continue
        model_info = entry.get("model_info")
        capabilities[model_name] = model_info if isinstance(model_info, dict) else {}
    return capabilities


def _match_model_capabilities(
    model: dict[str, Any],
    capabilities_by_name: dict[str, dict[str, Any]],
) -> dict[str, Any] | None:
    candidates: list[str] = []
    for key in ("id", "name"):
        value = str(model.get(key) or "").strip()
        if not value:
            continue
        candidates.append(value)
        candidates.append(value.removesuffix(":latest"))

    seen = set()
    for candidate in candidates:
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        for model_name, capabilities in capabilities_by_name.items():
            if (
                candidate == model_name
                or f"{candidate}:latest" == model_name
                or candidate == model_name.removesuffix(":latest")
            ):
                return capabilities
    return None


def _select_models() -> tuple[dict[str, Any], dict[str, Any] | None]:
    capabilities_by_name = _load_reasoning_capabilities()
    listed = _call_tool("subagents", "list_agents", {"filter_type": "all"})
    reasoning_candidates: list[dict[str, Any]] = []
    non_reasoning_candidates: list[dict[str, Any]] = []

    for model in listed:
        if not isinstance(model, dict) or model.get("base_model_id") is not None:
            continue
        capabilities = _match_model_capabilities(model, capabilities_by_name)
        if not capabilities:
            continue
        if capabilities.get("supports_reasoning"):
            reasoning_candidates.append(
                {
                    "id": model["id"],
                    "name": model.get("name") or model["id"],
                    "allowed_values": list(
                        capabilities.get("reasoning_effort_options")
                        or DEFAULT_REASONING_EFFORT_OPTIONS
                    ),
                    "disabled": bool(capabilities.get("disabled")),
                    "has_explicit_options": bool(capabilities.get("reasoning_effort_options")),
                }
            )
        if capabilities.get("supports_reasoning") is False:
            non_reasoning_candidates.append(
                {
                    "id": model["id"],
                    "name": model.get("name") or model["id"],
                    "disabled": bool(capabilities.get("disabled")),
                }
            )

    reasoning_model = next(
        (
            candidate
            for candidate in reasoning_candidates
            if not candidate["disabled"] and candidate["has_explicit_options"]
        ),
        next(
        (candidate for candidate in reasoning_candidates if not candidate["disabled"]),
        reasoning_candidates[0] if reasoning_candidates else None,
        ),
    )
    non_reasoning_model = next(
        (candidate for candidate in non_reasoning_candidates if not candidate["disabled"]),
        non_reasoning_candidates[0] if non_reasoning_candidates else None,
    )

    if reasoning_model is None:
        pytest.skip("No reasoning-capable base model was available in the live stack")

    return reasoning_model, non_reasoning_model


def _available_tool_server_ids() -> set[str]:
    tools = _call_tool("subagents", "list_available_tools", {})
    return {tool["id"] for tool in tools if isinstance(tool, dict) and tool.get("id")}


def _sign_in(owui_base_url: str) -> str:
    env_token = (os.getenv("OWUI_API_TOKEN") or "").strip()
    if env_token:
        return env_token

    bridge_secret = (os.getenv("OWUI_AUTH_BRIDGE_SECRET") or "").strip()
    bridge_secret_file = (os.getenv("OWUI_AUTH_BRIDGE_SECRET_FILE") or "").strip()
    if not bridge_secret and bridge_secret_file:
        bridge_secret = Path(bridge_secret_file).read_text(encoding="utf-8").strip()
    if not bridge_secret:
        raise RuntimeError(
            "Open WebUI token unavailable. Set OWUI_API_TOKEN or "
            "OWUI_AUTH_BRIDGE_SECRET(_FILE) for live subagent tests."
        )

    response = httpx.post(
        f"{owui_base_url.rstrip('/')}/api/v1/portico/auth/service-token",
        json={"reason": "live-subagents-configuration-test"},
        headers={"Authorization": f"Bearer {bridge_secret}"},
        timeout=30.0,
    )
    response.raise_for_status()
    payload = response.json()
    return payload.get("token") or payload.get("access_token")


def _chat_state(chat_id: str) -> dict[str, Any]:
    response = httpx.get(
        f"{CHAT_STATE_API_BASE_URL}/api/v1/chat-state/{chat_id}",
        timeout=30.0,
    )
    response.raise_for_status()
    return response.json()


def _active_capabilities(owui_base_url: str, token: str, chat_id: str) -> dict[str, Any]:
    response = httpx.get(
        f"{owui_base_url.rstrip('/')}/api/v1/chats/{chat_id}/active-capabilities",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30.0,
    )
    response.raise_for_status()
    return response.json()


def _debug_request_events(redis_client, chat_id: str) -> list[dict[str, Any]]:
    events = []
    for pattern in ("llm_debug:event_request_payload:*", "llm_debug:request:*"):
        for key in redis_client.keys(pattern):
            raw = redis_client.get(key)
            if not raw:
                continue
            try:
                event = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if event.get("chat_id") == chat_id:
                events.append(event)
    return events


def _assert_debug_event_contains(
    redis_client,
    chat_id: str,
    required_fragments: list[str],
) -> None:
    events = _debug_request_events(redis_client, chat_id)
    assert events, f"Expected at least one llm_debug:request event for chat {chat_id}"
    serialized = json.dumps(events[-1], sort_keys=True)
    for fragment in required_fragments:
        assert fragment in serialized, f"Missing {fragment!r} from request event: {serialized[:4000]}"


def _capability_server_ids(capabilities: dict[str, Any]) -> set[str]:
    return {
        f"server:{tool['server_id']}"
        for tool in capabilities.get("tools", [])
        if isinstance(tool, dict) and tool.get("server_id")
    }


def _capability_skill_ids(capabilities: dict[str, Any]) -> set[str]:
    return {
        skill_id
        for skill in capabilities.get("skills", [])
        if isinstance(skill, dict)
        for skill_id in [skill.get("id") or skill.get("name")]
        if skill_id
    }


def _create_skill(skill_name: str, required_mcp_servers: list[str]) -> None:
    content = "\n".join(
        [
            "---",
            f"name: {skill_name}",
            "description: Live integration skill",
            "required_mcp_servers:",
            *[f"  - {server_id}" for server_id in required_mcp_servers],
            "---",
            f"# {skill_name}",
            "Use the attached capability context.",
            "",
        ]
    )
    created = _call_tool(
        "skills",
        "create_skill",
        {"skill_name": skill_name, "skill_content": content},
    )
    assert created["success"] is True


def _delete_skill(skill_name: str) -> None:
    response = _call_tool("skills", "delete_skill", {"skill_name": skill_name, "confirm": True})
    assert response["success"] is True


@pytest.mark.mcp
@pytest.mark.slow
def test_run_subagent_base_model_configuration_persists_reasoning_and_capabilities_live(
    owui_client,
    redis_client,
):
    available_tool_ids = _available_tool_server_ids()
    required_servers = {"server:web-tools", "server:google_workspace"}
    missing = required_servers - available_tool_ids
    if missing:
        pytest.skip(f"Required live tool servers were unavailable: {sorted(missing)}")

    reasoning_model, _ = _select_models()
    reasoning_effort = (
        "max"
        if "max" in reasoning_model["allowed_values"]
        else reasoning_model["allowed_values"][-1]
    )
    token = _sign_in(owui_client.base_url)
    skill_name = f"subagent-live-skill-{uuid.uuid4().hex[:8]}"
    chat_id = None

    try:
        _create_skill(skill_name, ["server:web-tools"])
        result, chat_id = _run_subagent_and_capture_chat(
            redis_client,
            {
                "model": reasoning_model["id"],
                "prompt": "Reply with the exact text integration ok and nothing else.",
                "tool_server_ids": ["server:google_workspace"],
                "skill_ids": [skill_name],
                "reasoning_effort": reasoning_effort,
            },
        )
        _assert_run_subagent_outcome(result)

        chat_tools = set(redis_client.get_chat_tools(chat_id))
        assert CORE_TOOL_SERVERS.issubset(chat_tools)
        assert "server:google_workspace" in chat_tools
        assert "server:web-tools" in chat_tools

        chat_skills = set(redis_client.get_chat_skills(chat_id))
        assert skill_name in chat_skills

        capabilities = _active_capabilities(owui_client.base_url, token, chat_id)
        capability_servers = _capability_server_ids(capabilities)
        capability_skills = _capability_skill_ids(capabilities)
        assert "server:google_workspace" in capability_servers
        assert "server:web-tools" in capability_servers
        assert skill_name in capability_skills

        chat_state = _chat_state(chat_id)
        assert chat_state["reasoning_effort"] == reasoning_effort
        assert chat_state["reasoning_effort_by_model"]["0"] == reasoning_effort

        _assert_debug_event_contains(
            redis_client,
            chat_id,
            [
                skill_name,
                "server:google_workspace",
                "server:web-tools",
                reasoning_effort,
            ],
        )
    finally:
        if chat_id:
            owui_client.delete_chat(chat_id)
        _delete_skill(skill_name)


@pytest.mark.mcp
@pytest.mark.slow
def test_saved_agent_defaults_merge_and_override_live(owui_client, redis_client):
    available_tool_ids = _available_tool_server_ids()
    required_servers = {"server:web-tools", "server:google_workspace"}
    missing = required_servers - available_tool_ids
    if missing:
        pytest.skip(f"Required live tool servers were unavailable: {sorted(missing)}")

    reasoning_model, _ = _select_models()
    allowed_values = reasoning_model["allowed_values"]
    if not allowed_values:
        pytest.skip("No supported reasoning_effort values were available")

    saved_effort = "high" if "high" in allowed_values else allowed_values[0]
    override_effort = (
        "max"
        if "max" in allowed_values and "max" != saved_effort
        else allowed_values[-1]
    )
    token = _sign_in(owui_client.base_url)
    skill_name = f"subagent-live-saved-{uuid.uuid4().hex[:8]}"
    agent_name = f"Subagent Live Agent {uuid.uuid4().hex[:6]}"
    agent_id = None
    chat_id = None

    try:
        _create_skill(skill_name, ["server:web-tools"])
        created = _call_tool(
            "subagents",
            "create_agent",
            {
                "name": agent_name,
                "base_model_id": reasoning_model["id"],
                "system_prompt": "Be concise.",
                "tool_server_ids": ["server:google_workspace"],
                "skill_ids": [skill_name],
                "reasoning_effort": saved_effort,
            },
        )
        agent_id = created["id"]
        fetched = _call_tool("subagents", "get_agent", {"model_id": agent_id})
        assert fetched["tool_server_ids"] == ["server:google_workspace"]
        assert fetched["skill_ids"] == [skill_name]
        assert fetched["reasoning_effort"] == saved_effort

        result, chat_id = _run_subagent_and_capture_chat(
            redis_client,
            {
                "model": agent_id,
                "prompt": "Reply with the exact text saved defaults integration and nothing else.",
                "tool_server_ids": ["server:web-tools"],
                "reasoning_effort": override_effort,
            },
        )
        _assert_run_subagent_outcome(result)

        chat_tools = set(redis_client.get_chat_tools(chat_id))
        assert CORE_TOOL_SERVERS.issubset(chat_tools)
        assert "server:google_workspace" in chat_tools
        assert "server:web-tools" in chat_tools

        chat_skills = set(redis_client.get_chat_skills(chat_id))
        assert skill_name in chat_skills

        capabilities = _active_capabilities(owui_client.base_url, token, chat_id)
        capability_servers = _capability_server_ids(capabilities)
        capability_skills = _capability_skill_ids(capabilities)
        assert "server:google_workspace" in capability_servers
        assert "server:web-tools" in capability_servers
        assert skill_name in capability_skills

        chat_state = _chat_state(chat_id)
        assert chat_state["reasoning_effort"] == override_effort
        assert chat_state["reasoning_effort_by_model"]["0"] == override_effort

        _assert_debug_event_contains(
            redis_client,
            chat_id,
            [
                skill_name,
                "server:google_workspace",
                "server:web-tools",
                override_effort,
            ],
        )
    finally:
        if chat_id:
            owui_client.delete_chat(chat_id)
        if agent_id:
            _call_tool("subagents", "delete_agent", {"model_id": agent_id})
        _delete_skill(skill_name)


@pytest.mark.mcp
@pytest.mark.slow
def test_run_subagent_rejects_invalid_reasoning_and_legacy_tool_ids_live():
    reasoning_model, non_reasoning_model = _select_models()
    _ = reasoning_model

    if non_reasoning_model is not None:
        response = _call_tool_raw(
            "subagents",
            "run_subagent",
            {
                "model": non_reasoning_model["id"],
                "prompt": "Say hello.",
                "reasoning_effort": "medium",
            },
        )
        assert "does not support reasoning_effort" in _error_message_from_response(response)

    legacy_response = _call_tool_raw(
        "subagents",
        "create_agent",
        {
            "name": f"Legacy Tool Ids {uuid.uuid4().hex[:6]}",
            "base_model_id": reasoning_model["id"],
            "tool_ids": ["server:google_workspace"],
        },
    )
    assert "Use 'tool_server_ids' instead" in _error_message_from_response(legacy_response)
