import ast
import asyncio
import hashlib
import json
import os
import re
import time
from pathlib import Path
from typing import Any, Optional


class _FakeLog:
    def debug(self, *args, **kwargs):
        return None

    def info(self, *args, **kwargs):
        return None

    def warning(self, *args, **kwargs):
        return None


def _load_overflow_helpers():
    source_path = (
        Path(__file__).resolve().parents[1]
        / "src"
        / "patches"
        / "backend"
        / "open_webui"
        / "utils"
        / "middleware.py"
    )
    module_ast = ast.parse(source_path.read_text())
    wanted_functions = {
        "_float_env",
        "_create_chat_agent_vm_for_overflow",
        "_iter_agent_vm_info_keys",
        "_decode_agent_vm_info_payload",
        "_agent_vm_metadata_ttl_seconds",
        "_agent_vm_container_status_is_active",
        "_agent_vm_is_inactivity_expired",
        "_open_agent_vm_docker_client",
        "_inspect_agent_vm_container_status",
        "_list_active_chat_agent_vms_sync",
        "_list_active_chat_agent_vms",
        "_refresh_active_chat_agent_vms",
        "_render_tool_result_for_overflow",
        "_detect_tool_result_overflow_format",
        "_overflow_agent_vm_timeout_hours",
        "_overflow_redis_client",
        "_tool_result_overflow_enabled",
        "_tool_result_overflow_max_chars",
        "_tool_result_overflow_chunk_chars",
        "_tool_result_overflow_read_hint",
        "_tool_result_overflow_path",
        "_ensure_chat_agent_vm_for_overflow",
        "_write_overflow_file_for_tool_result",
        "_compact_tool_result_for_internal_replay",
        "_tool_result_overflow_exempt_for_metadata",
        "_proxy_base_url_for_server_metadata",
        "_enrich_loaded_external_tools_with_runtime_metadata",
        "_build_unavailable_tool_result",
        "_normalize_followup_tool_refresh_id",
        "_extract_followup_tool_refresh_ids",
        "_maybe_spill_large_tool_result",
    }
    selected_nodes = []
    for node in module_ast.body:
        if (
            isinstance(node, ast.Assign)
            and any(
                isinstance(target, ast.Name)
                and target.id == "_DEFAULT_OVERFLOW_AGENT_VM_TIMEOUT_HOURS"
                for target in node.targets
            )
        ):
            selected_nodes.append(node)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in wanted_functions:
            selected_nodes.append(node)

    namespace = {
        "Any": Any,
        "Optional": Optional,
        "asyncio": asyncio,
        "hashlib": hashlib,
        "json": json,
        "log": _FakeLog(),
        "MCPO_CORE_PROXY_BASE_URL": "http://mcpo-core:8081",
        "MCPO_REGULAR_PROXY_BASE_URL": "http://mcpo",
        "MCPO_HOST_PROXY_BASE_URL": "http://host.docker.internal:8890",
        "os": os,
        "re": re,
        "time": time,
    }
    exec(
        compile(
            ast.Module(body=selected_nodes, type_ignores=[]),
            str(source_path),
            "exec",
        ),
        namespace,
    )
    return namespace


def _middleware_source() -> str:
    return (
        Path(__file__).resolve().parents[1]
        / "src"
        / "patches"
        / "backend"
        / "open_webui"
        / "utils"
        / "middleware.py"
    ).read_text(encoding="utf-8")


def _main_source() -> str:
    return (
        Path(__file__).resolve().parents[1]
        / "src"
        / "patches"
        / "backend"
        / "open_webui"
        / "main.py"
    ).read_text(encoding="utf-8")


class _FakeRedis:
    def __init__(self, values=None):
        self.values = dict(values or {})
        self.ttls = {}

    def get(self, key):
        return self.values.get(key)

    def set(self, key, value, nx=False, ex=None):
        if nx and key in self.values:
            return False
        self.values[key] = value
        if ex is not None:
            self.ttls[key] = ex
        else:
            self.ttls.pop(key, None)
        return True

    def setex(self, key, ttl, value):
        self.values[key] = value
        self.ttls[key] = ttl
        return True

    def delete(self, key):
        self.values.pop(key, None)
        self.ttls.pop(key, None)
        return 1

    def keys(self, pattern):
        if pattern == "agent_vm_info:*":
            return [key for key in self.values if key.startswith("agent_vm_info:")]
        return []

    def scan_iter(self, match=None):
        for key in self.keys(match or "*"):
            yield key


def _vm_info(
    vm_id: str,
    chat_id: str,
    *,
    last_activity: float,
    timeout_hours: float = 4.0,
    status: str = "running",
    container_id: str | None = None,
):
    return {
        "vm_id": vm_id,
        "container_id": container_id or f"container-{vm_id}",
        "chat_id": chat_id,
        "created_at": 1.0,
        "last_activity": last_activity,
        "timeout_hours": timeout_hours,
        "status": status,
        "network_enabled": True,
        "port_mappings": {},
    }


def test_maybe_spill_large_tool_result_returns_pointer_for_oversized_payload():
    helpers = _load_overflow_helpers()
    captured = {}

    async def fake_write_overflow_file_for_tool_result(
        *, chat_id, tool_function_name, rendered
    ):
        captured["chat_id"] = chat_id
        captured["tool_function_name"] = tool_function_name
        captured["rendered"] = rendered
        return {
            "overflow_file": True,
            "tool_name": tool_function_name,
            "char_count": len(rendered),
            "vm_id": "vm-overflow",
            "path": "/work/.mcp-overflow/test.json",
            "format": "json",
            "read_hint": "read it",
        }

    helpers["_tool_result_overflow_max_chars"] = lambda: 10
    helpers["_write_overflow_file_for_tool_result"] = fake_write_overflow_file_for_tool_result

    result = asyncio.run(
        helpers["_maybe_spill_large_tool_result"](
            request=object(),
            tool_function_name="google_workspace_get_events",
            tool_result={"result": "x" * 128},
            metadata={"chat_id": "chat-overflow"},
        )
    )

    assert result["overflow_file"] is True
    assert result["path"] == "/work/.mcp-overflow/test.json"
    assert captured["chat_id"] == "chat-overflow"
    assert captured["tool_function_name"] == "google_workspace_get_events"
    assert len(captured["rendered"]) > 10


def test_write_overflow_file_for_tool_result_rebuilds_pointer_from_effective_vm_and_path():
    helpers = _load_overflow_helpers()
    calls = []

    async def fake_ensure_chat_agent_vm_for_overflow(chat_id):
        assert chat_id == "chat-overflow"
        return "vm-original"

    async def fake_core_post_json(path, payload):
        assert path == "/agent-vm/agent_vm_create_file"
        calls.append(dict(payload))
        return {
            "success": True,
            "vm_id": "vm-recovered",
            "path": "/work/.mcp-overflow/recovered.json",
        }

    helpers["_ensure_chat_agent_vm_for_overflow"] = fake_ensure_chat_agent_vm_for_overflow
    helpers["_core_post_json"] = fake_core_post_json
    helpers["_tool_result_overflow_chunk_chars"] = lambda: 8

    pointer = asyncio.run(
        helpers["_write_overflow_file_for_tool_result"](
            "chat-overflow",
            "demo_echo",
            json.dumps({"payload": "x" * 64}),
        )
    )

    assert pointer["overflow_file"] is True
    assert pointer["vm_id"] == "vm-recovered"
    assert pointer["path"] == "/work/.mcp-overflow/recovered.json"
    assert len(calls) > 1
    assert calls[0]["vm_id"] == "vm-original"
    assert calls[0]["append"] is False
    assert calls[0]["path"] != pointer["path"]
    for call in calls[1:]:
        assert call["vm_id"] == "vm-recovered"
        assert call["path"] == pointer["path"]
        assert call["append"] is True


def test_maybe_spill_large_tool_result_keeps_core_non_web_payload_inline():
    helpers = _load_overflow_helpers()
    helpers["_tool_result_overflow_max_chars"] = lambda: 10
    helpers["_write_overflow_file_for_tool_result"] = None

    original = {"result": "x" * 128}
    result = asyncio.run(
        helpers["_maybe_spill_large_tool_result"](
            request=object(),
            tool_function_name="skills_list_available_skills",
            tool_result=original,
            metadata={
                "chat_id": "chat-overflow",
                "server_id": "skills",
                "server_is_core": True,
            },
        )
    )

    assert result == original


def test_maybe_spill_large_tool_result_still_spills_web_tools_when_marked_core():
    helpers = _load_overflow_helpers()
    helpers["_tool_result_overflow_max_chars"] = lambda: 10
    captured = {}

    async def fake_write_overflow_file_for_tool_result(
        *, chat_id, tool_function_name, rendered
    ):
        captured["chat_id"] = chat_id
        captured["tool_function_name"] = tool_function_name
        captured["rendered"] = rendered
        return {
            "overflow_file": True,
            "tool_name": tool_function_name,
            "char_count": len(rendered),
            "vm_id": "vm-overflow",
            "path": "/work/.mcp-overflow/web-tools.json",
            "format": "json",
            "read_hint": "read it",
        }

    helpers["_write_overflow_file_for_tool_result"] = fake_write_overflow_file_for_tool_result

    original = {"result": "x" * 128}
    result = asyncio.run(
        helpers["_maybe_spill_large_tool_result"](
            request=object(),
            tool_function_name="web_tools_search_web",
            tool_result=original,
            metadata={
                "chat_id": "chat-overflow",
                "server_id": "server:web-tools",
                "server_is_core": True,
            },
        )
    )

    assert result["overflow_file"] is True
    assert result["path"] == "/work/.mcp-overflow/web-tools.json"
    assert captured["chat_id"] == "chat-overflow"
    assert captured["tool_function_name"] == "web_tools_search_web"
    assert len(captured["rendered"]) > 10


def test_maybe_spill_large_tool_result_skips_missing_chat_id():
    helpers = _load_overflow_helpers()
    helpers["_tool_result_overflow_max_chars"] = lambda: 10
    helpers["_write_overflow_file_for_tool_result"] = None

    original = {"result": "x" * 128}
    result = asyncio.run(
        helpers["_maybe_spill_large_tool_result"](
            request=object(),
            tool_function_name="google_workspace_get_events",
            tool_result=original,
            metadata={},
        )
    )

    assert result == original


def test_maybe_spill_large_tool_result_skips_small_payloads():
    helpers = _load_overflow_helpers()
    helpers["_tool_result_overflow_max_chars"] = lambda: 1000
    helpers["_write_overflow_file_for_tool_result"] = None

    original = {"result": "short"}
    result = asyncio.run(
        helpers["_maybe_spill_large_tool_result"](
            request=object(),
            tool_function_name="google_workspace_get_events",
            tool_result=original,
            metadata={"chat_id": "chat-1"},
        )
    )

    assert result == original


def test_maybe_spill_large_tool_result_returns_original_when_overflow_is_disabled():
    helpers = _load_overflow_helpers()
    helpers["_tool_result_overflow_enabled"] = lambda: False
    helpers["_tool_result_overflow_max_chars"] = lambda: 10
    helpers["_write_overflow_file_for_tool_result"] = None

    original = {"result": "x" * 128}
    result = asyncio.run(
        helpers["_maybe_spill_large_tool_result"](
            request=object(),
            tool_function_name="google_workspace_get_events",
            tool_result=original,
            metadata={"chat_id": "chat-disabled"},
        )
    )

    assert result == original


def test_maybe_spill_large_tool_result_skips_local_chat_ids():
    helpers = _load_overflow_helpers()
    helpers["_tool_result_overflow_max_chars"] = lambda: 10
    helpers["_write_overflow_file_for_tool_result"] = None

    original = {"result": "x" * 128}
    result = asyncio.run(
        helpers["_maybe_spill_large_tool_result"](
            request=object(),
            tool_function_name="google_workspace_get_events",
            tool_result=original,
            metadata={"chat_id": "local:chat-overflow"},
        )
    )

    assert result == original


def test_maybe_spill_large_tool_result_falls_back_to_original_after_write_failure():
    helpers = _load_overflow_helpers()
    helpers["_tool_result_overflow_max_chars"] = lambda: 10

    async def fake_write_overflow_file_for_tool_result(**_kwargs):
        raise RuntimeError("disk full")

    helpers["_write_overflow_file_for_tool_result"] = fake_write_overflow_file_for_tool_result

    original = {"result": "x" * 128}
    result = asyncio.run(
        helpers["_maybe_spill_large_tool_result"](
            request=object(),
            tool_function_name="google_workspace_get_events",
            tool_result=original,
            metadata={"chat_id": "chat-overflow"},
        )
    )

    assert result == original


def test_tool_result_overflow_max_chars_uses_new_default(monkeypatch):
    monkeypatch.delenv("OWUI_TOOL_RESULT_OVERFLOW_MAX_CHARS", raising=False)
    helpers = _load_overflow_helpers()

    assert helpers["_tool_result_overflow_max_chars"]() == 4000


def test_tool_result_overflow_max_chars_preserves_env_override(monkeypatch):
    monkeypatch.setenv("OWUI_TOOL_RESULT_OVERFLOW_MAX_CHARS", "4321")
    helpers = _load_overflow_helpers()

    assert helpers["_tool_result_overflow_max_chars"]() == 4321


def test_tool_result_overflow_enabled_defaults_true_and_honors_env(monkeypatch):
    monkeypatch.delenv("OWUI_TOOL_RESULT_OVERFLOW_ENABLED", raising=False)
    helpers = _load_overflow_helpers()
    assert helpers["_tool_result_overflow_enabled"]() is True

    monkeypatch.setenv("OWUI_TOOL_RESULT_OVERFLOW_ENABLED", "false")
    helpers = _load_overflow_helpers()
    assert helpers["_tool_result_overflow_enabled"]() is False


def test_tool_result_overflow_read_hint_warns_against_dumping_raw_files():
    helpers = _load_overflow_helpers()

    json_hint = helpers["_tool_result_overflow_read_hint"]("json")
    assert "Do not dump the raw overflow file" in json_hint
    assert "read_fragment" in json_hint
    assert "under 2,000 chars" in json_hint
    assert "jq" in json_hint

    text_hint = helpers["_tool_result_overflow_read_hint"]("txt")
    assert "Do not dump the raw overflow file" in text_hint
    assert "read_fragment" in text_hint
    assert "under 2,000 chars" in text_hint


def test_compact_tool_result_for_internal_replay_truncates_large_payloads():
    helpers = _load_overflow_helpers()
    helpers["_tool_result_overflow_max_chars"] = lambda: 10

    compacted = helpers["_compact_tool_result_for_internal_replay"]({"result": "x" * 128})
    payload = json.loads(compacted)

    assert payload["truncated_tool_result"] is True
    assert payload["char_count"] > 10
    assert len(payload["preview"]) == 10


def test_compact_tool_result_for_internal_replay_keeps_small_payload_and_ignores_unknown_types():
    helpers = _load_overflow_helpers()
    helpers["_tool_result_overflow_max_chars"] = lambda: 100

    assert helpers["_compact_tool_result_for_internal_replay"]("small text") == "small text"
    assert helpers["_compact_tool_result_for_internal_replay"](12345) == ""


def test_compact_tool_result_for_internal_replay_respects_non_positive_limit():
    helpers = _load_overflow_helpers()
    helpers["_tool_result_overflow_max_chars"] = lambda: 0

    rendered = helpers["_compact_tool_result_for_internal_replay"]({"result": "x" * 32})

    assert json.loads(rendered) == {"result": "x" * 32}


def test_tool_result_overflow_exempt_for_metadata_only_for_core_non_web_servers():
    helpers = _load_overflow_helpers()
    exempt = helpers["_tool_result_overflow_exempt_for_metadata"]

    assert exempt({"server_id": "skills", "server_is_core": True}) is True
    assert exempt({"server_id": "server:agent-vm", "server_is_core": True}) is True
    assert exempt({"server_id": "server:web-tools", "server_is_core": True}) is False
    assert exempt({"server_id": "google_workspace", "server_is_core": False}) is False
    assert exempt({"server_id": None, "server_is_core": True}) is False
    assert exempt(None) is False


def test_enrich_loaded_external_tools_with_runtime_metadata_attaches_dynamic_server_fields():
    helpers = _load_overflow_helpers()
    helpers["_normalize_server_id"] = (
        lambda server_id: server_id.split("server:", 1)[1]
        if isinstance(server_id, str) and server_id.startswith("server:")
        else server_id
    )
    helpers["_resolve_tool_server_id"] = lambda tool: tool.get("server_id")
    helpers["_extract_tool_server_id"] = lambda tool_id: tool_id.split("server:", 1)[1]
    helpers["_build_openapi_tool_server_connection"] = (
        lambda server_id: {"info": {"id": server_id}, "url": f"http://mcpo/{server_id}"}
    )
    helpers["_load_server_metadata"] = lambda server_id: {"is_core": server_id == "agent-vm"}
    helpers["MCPO_CORE_PROXY_BASE_URL"] = "http://mcpo-core:8081"
    helpers["MCPO_REGULAR_PROXY_BASE_URL"] = "http://mcpo"

    enriched = helpers["_enrich_loaded_external_tools_with_runtime_metadata"](
        {
            "agent_vm_bash": {
                "tool_id": "server:agent-vm",
                "type": "external",
                "spec": {"name": "agent_vm_bash"},
                "callable": object(),
            }
        },
        tool_servers=[{"id": "agent-vm", "url": "http://mcpo-core:8081/agent-vm"}],
        tool_server_connections=[{"info": {"id": "agent-vm"}, "auth_type": "bearer"}],
    )

    tool = enriched["agent_vm_bash"]
    assert tool["server_id"] == "agent-vm"
    assert tool["tool_server_data"]["id"] == "agent-vm"
    assert tool["tool_server_data"]["url"] == "http://mcpo-core:8081/agent-vm"
    assert tool["tool_server_connection"]["info"]["id"] == "agent-vm"
    assert tool["server_operation_name"] == "agent_vm_bash"


def test_enrich_loaded_external_tools_with_runtime_metadata_builds_synthetic_server_data_when_cache_missing():
    helpers = _load_overflow_helpers()
    helpers["_normalize_server_id"] = (
        lambda server_id: server_id.split("server:", 1)[1]
        if isinstance(server_id, str) and server_id.startswith("server:")
        else server_id
    )
    helpers["_resolve_tool_server_id"] = lambda tool: tool.get("server_id")
    helpers["_extract_tool_server_id"] = lambda tool_id: tool_id.split("server:", 1)[1]
    helpers["_build_openapi_tool_server_connection"] = (
        lambda server_id: {"info": {"id": server_id}, "auth_type": "bearer"}
    )
    helpers["_load_server_metadata"] = lambda server_id: {"is_core": server_id == "agent-vm"}
    helpers["MCPO_CORE_PROXY_BASE_URL"] = "http://mcpo-core:8081"
    helpers["MCPO_REGULAR_PROXY_BASE_URL"] = "http://mcpo"

    enriched = helpers["_enrich_loaded_external_tools_with_runtime_metadata"](
        {
            "agent_vm_read_file": {
                "tool_id": "server:agent-vm",
                "type": "external",
                "spec": {"name": "agent_vm_read_file"},
                "callable": object(),
            }
        },
        tool_servers=[],
        tool_server_connections=[],
    )

    tool = enriched["agent_vm_read_file"]
    assert tool["server_id"] == "agent-vm"
    assert tool["tool_server_data"] == {
        "id": "agent-vm",
        "url": "http://mcpo-core:8081/agent-vm",
    }
    assert tool["tool_server_connection"]["info"]["id"] == "agent-vm"
    assert tool["server_operation_name"] == "agent_vm_read_file"


def test_normalize_followup_tool_refresh_id_adds_server_prefix_only_when_needed():
    helpers = _load_overflow_helpers()

    assert helpers["_normalize_followup_tool_refresh_id"]("google_workspace") == "server:google_workspace"
    assert helpers["_normalize_followup_tool_refresh_id"]("server:slack") == "server:slack"
    assert helpers["_normalize_followup_tool_refresh_id"]("  ") == ""


def test_build_unavailable_tool_result_respects_subagent_lock_policy():
    helpers = _load_overflow_helpers()
    helpers["_SUBAGENT_LOCKED_TOOL_NAMES"] = frozenset(
        {"mcp_assistant_toggle_integration", "skills_activate_skill"}
    )

    blocked = helpers["_build_unavailable_tool_result"](
        "mcp_assistant_toggle_integration",
        is_subagent_chat=True,
        lock_integrations=True,
    )
    generic = helpers["_build_unavailable_tool_result"](
        "google_workspace_get_events",
        is_subagent_chat=False,
        lock_integrations=False,
    )

    assert blocked["code"] == "delegated_subagent_tool_locked"
    assert "delegated subagent chats" in blocked["message"]
    assert "not available in the current chat yet" in generic


def test_build_unavailable_tool_result_returns_generic_message_for_unlocked_subagent_tool():
    helpers = _load_overflow_helpers()
    helpers["_SUBAGENT_LOCKED_TOOL_NAMES"] = frozenset({"skills_activate_skill"})

    generic = helpers["_build_unavailable_tool_result"](
        "google_workspace_get_events",
        is_subagent_chat=True,
        lock_integrations=True,
    )

    assert isinstance(generic, str)
    assert "not available in the current chat yet" in generic


def test_followup_replay_and_core_overflow_exemption_paths_are_wired_in_middleware_source():
    source = _middleware_source()

    assert 'replay_mode="tool_followup"' in source
    assert 'replay_mode="stream_continue"' in source
    assert '"request_phase": "tool_followup"' in source
    assert "_LEGACY_TOOL_FOLLOWUP_CONTINUATION_SYSTEM_MESSAGE" in source
    assert "Skipped inlet filter refresh for tool follow-up" not in source
    assert '"__is_followup_request__": True' in source
    assert '"__followup_phase__": "tool_followup"' in source
    assert '"__preserve_dynamic_context__": False' in source
    assert "process_pipeline_inlet_filter(" in source
    assert 'filter_type="inlet"' in source
    assert "include_trailing_assistant_text = True" in source
    assert '"content": "" if is_duplicate else assistant_content' in source
    assert "_strip_legacy_tool_followup_system_message(" in source
    assert "_ensure_internal_request_system_prompt_placeholder(" in source
    assert "await _ensure_tool_server_connections_for_tool_ids(" in source
    assert "pending_tool_ids," in source
    assert "_enrich_loaded_external_tools_with_runtime_metadata(" in source
    assert "pending_tool_ids=followup_refresh_tool_ids" in source
    assert "_tool_result_overflow_exempt_for_metadata(metadata)" in source
    assert "compact_tool_results and not _tool_result_overflow_exempt_for_metadata(" in source
    assert "tool_call_retries < CHAT_RESPONSE_MAX_TOOL_CALL_RETRIES" in source
    assert "tool_loop_guard" not in source


def test_extract_followup_tool_refresh_ids_tracks_only_chat_attachment_calls():
    helpers = _load_overflow_helpers()

    refresh_ids, tooling_state_changed = helpers["_extract_followup_tool_refresh_ids"](
        [
            {
                "id": "call-toggle",
                "function": {
                    "name": "mcp_assistant_toggle_integration",
                    "arguments": json.dumps({"server_id": "google_workspace"}),
                },
            },
            {
                "id": "call-activate",
                "function": {
                    "name": "mcp_assistant_activate_integration",
                    "arguments": json.dumps(
                        {"tool_server_ids": ["server:google_workspace", "server:slack"]}
                    ),
                },
            },
        ],
        [
            {
                "tool_call_id": "call-toggle",
                "content": json.dumps(
                    {
                        "server_id": "google_workspace",
                        "success": True,
                        "readiness_phase": "tool_ready",
                    }
                ),
            },
            {
                "tool_call_id": "call-activate",
                "content": json.dumps(
                    {"newly_added": ["server:google_workspace", "server:slack"]}
                ),
            },
        ],
    )

    assert tooling_state_changed is True
    assert refresh_ids == ["server:google_workspace", "server:slack"]


def test_extract_followup_tool_refresh_ids_uses_argument_fallback_and_dedupes_authorize_auto_activation():
    helpers = _load_overflow_helpers()

    refresh_ids, tooling_state_changed = helpers["_extract_followup_tool_refresh_ids"](
        [
            {
                "id": "call-toggle",
                "function": {
                    "name": "mcp_assistant_toggle_integration",
                    "arguments": json.dumps({"server_id": "google_workspace"}),
                },
            },
            {
                "id": "call-authorize",
                "function": {
                    "name": "mcp_assistant_authorize_integration",
                    "arguments": json.dumps({"server_id": "server:google_workspace"}),
                },
            },
        ],
        [
            {"tool_call_id": "call-toggle", "content": "not-json"},
            {
                "tool_call_id": "call-authorize",
                "content": json.dumps({"success": True, "auto_activated": True}),
            },
        ],
    )

    assert tooling_state_changed is True
    assert refresh_ids == ["server:google_workspace"]


def test_extract_followup_tool_refresh_ids_prefers_authorize_result_server_id_over_arguments():
    helpers = _load_overflow_helpers()

    refresh_ids, tooling_state_changed = helpers["_extract_followup_tool_refresh_ids"](
        [
            {
                "id": "call-toggle",
                "function": {
                    "name": "mcp_assistant_authorize_integration",
                    "arguments": json.dumps({"server_id": "google_workspace"}),
                },
            }
        ],
        [
            {
                "tool_call_id": "call-toggle",
                "content": json.dumps({"server_id": "slack", "auto_activated": True}),
            }
        ],
    )

    assert tooling_state_changed is True
    assert refresh_ids == ["server:slack"]


def test_extract_followup_tool_refresh_ids_does_not_refresh_after_toggle_without_chat_attachment():
    helpers = _load_overflow_helpers()

    refresh_ids, tooling_state_changed = helpers["_extract_followup_tool_refresh_ids"](
        [
            {
                "id": "call-toggle",
                "function": {
                    "name": "mcp_assistant_toggle_integration",
                    "arguments": json.dumps({"server_id": "google_workspace"}),
                },
            }
        ],
        [
            {
                "tool_call_id": "call-toggle",
                "content": json.dumps(
                    {
                        "server_id": "google_workspace",
                        "success": True,
                        "healthy": True,
                        "readiness_phase": "tool_ready",
                    }
                ),
            }
        ],
    )

    assert tooling_state_changed is True
    assert refresh_ids == []


def test_extract_followup_tool_refresh_ids_does_not_refresh_after_authorize_without_auto_activation():
    helpers = _load_overflow_helpers()

    refresh_ids, tooling_state_changed = helpers["_extract_followup_tool_refresh_ids"](
        [
            {
                "id": "call-authorize",
                "function": {
                    "name": "mcp_assistant_authorize_integration",
                    "arguments": json.dumps({"server_id": "google_workspace"}),
                },
            }
        ],
        [
            {
                "tool_call_id": "call-authorize",
                "content": json.dumps(
                    {
                        "server_id": "google_workspace",
                        "success": True,
                        "already_authorized": True,
                        "readiness_phase": "tool_ready",
                        "auto_activated": False,
                    }
                ),
            }
        ],
    )

    assert tooling_state_changed is True
    assert refresh_ids == []


def test_extract_followup_tool_refresh_ids_uses_arguments_when_newly_added_is_missing():
    helpers = _load_overflow_helpers()

    refresh_ids, tooling_state_changed = helpers["_extract_followup_tool_refresh_ids"](
        [
            {
                "id": "call-activate",
                "function": {
                    "name": "mcp_assistant_activate_integration",
                    "arguments": json.dumps({"tool_server_ids": ["server:argument-server"]}),
                },
            }
        ],
        [
            {
                "tool_call_id": "call-activate",
                "content": json.dumps({"enabled_tools": ["server:glean"]}),
            }
        ],
    )

    assert tooling_state_changed is True
    assert refresh_ids == ["server:argument-server"]


def test_extract_followup_tool_refresh_ids_ignores_failed_activate_result():
    helpers = _load_overflow_helpers()

    refresh_ids, tooling_state_changed = helpers["_extract_followup_tool_refresh_ids"](
        [
            {
                "id": "call-activate",
                "function": {
                    "name": "mcp_assistant_activate_integration",
                    "arguments": json.dumps(
                        {"tool_server_ids": ["server:chrome-devtools"]}
                    ),
                },
            }
        ],
        [
            {
                "tool_call_id": "call-activate",
                "content": json.dumps(
                    {
                        "success": False,
                        "newly_added": [],
                        "enabled_tools": ["server:chrome-devtools"],
                    }
                ),
            }
        ],
    )

    assert tooling_state_changed is True
    assert refresh_ids == []


def test_extract_followup_tool_refresh_ids_refreshes_successful_already_enabled_activation():
    helpers = _load_overflow_helpers()

    refresh_ids, tooling_state_changed = helpers["_extract_followup_tool_refresh_ids"](
        [
            {
                "id": "call-activate",
                "function": {
                    "name": "mcp_assistant_activate_integration",
                    "arguments": json.dumps(
                        {"tool_server_ids": ["server:chrome-devtools"]}
                    ),
                },
            }
        ],
        [
            {
                "tool_call_id": "call-activate",
                "content": json.dumps(
                    {
                        "success": True,
                        "newly_added": [],
                        "already_enabled": ["server:chrome-devtools"],
                    }
                ),
            }
        ],
    )

    assert tooling_state_changed is True
    assert refresh_ids == ["server:chrome-devtools"]


def test_extract_followup_tool_refresh_ids_marks_tooling_state_change_without_refresh_ids():
    helpers = _load_overflow_helpers()

    refresh_ids, tooling_state_changed = helpers["_extract_followup_tool_refresh_ids"](
        [
            {
                "id": "call-skill",
                "function": {
                    "name": "skills_activate_skill",
                    "arguments": json.dumps({"name": "google-workspace"}),
                },
            }
        ],
        [
            {
                "tool_call_id": "call-skill",
                "content": json.dumps({"success": True}),
            }
        ],
    )

    assert refresh_ids == []
    assert tooling_state_changed is True


def test_extract_followup_tool_refresh_ids_marks_deactivation_without_refresh_ids():
    helpers = _load_overflow_helpers()

    refresh_ids, tooling_state_changed = helpers["_extract_followup_tool_refresh_ids"](
        [
            {
                "id": "call-deactivate",
                "function": {
                    "name": "mcp_assistant_deactivate_integration",
                    "arguments": json.dumps({"tool_server_ids": ["server:slack"]}),
                },
            }
        ],
        [
            {
                "tool_call_id": "call-deactivate",
                "content": json.dumps({"success": True}),
            }
        ],
    )

    assert refresh_ids == []
    assert tooling_state_changed is True


def test_extract_followup_tool_refresh_ids_marks_skill_activation_without_refresh_ids():
    helpers = _load_overflow_helpers()

    refresh_ids, tooling_state_changed = helpers["_extract_followup_tool_refresh_ids"](
        [
            {
                "id": "call-1",
                "function": {
                    "name": "skills_activate_skill",
                    "arguments": '{"skill_name":"company-knowledge"}',
                },
            },
            {
                "id": "call-2",
                "function": {
                    "name": "skills_deactivate_skill",
                    "arguments": '{"skill_name":"company-knowledge"}',
                },
            },
        ],
        [
            {"tool_call_id": "call-1", "content": '{"ok": true}'},
            {"tool_call_id": "call-2", "content": '{"ok": true}'},
        ],
    )

    assert refresh_ids == []
    assert tooling_state_changed is True


def test_extract_followup_tool_refresh_ids_ignores_results_without_matching_tool_calls():
    helpers = _load_overflow_helpers()

    refresh_ids, tooling_state_changed = helpers["_extract_followup_tool_refresh_ids"](
        [
            {
                "id": "call-1",
                "function": {
                    "name": "mcp_assistant_toggle_integration",
                    "arguments": '{"server_id":"google_workspace"}',
                },
            }
        ],
        [
            {"tool_call_id": "call-missing", "content": '{"server_id":"google_workspace"}'},
            {"tool_call_id": "", "content": '{"server_id":"slack"}'},
        ],
    )

    assert refresh_ids == []
    assert tooling_state_changed is False


def test_extract_followup_tool_refresh_ids_ignores_unrelated_or_malformed_entries():
    helpers = _load_overflow_helpers()

    refresh_ids, tooling_state_changed = helpers["_extract_followup_tool_refresh_ids"](
        [
            None,
            {"id": "call-1", "function": {"name": "google_workspace_get_events", "arguments": "{}"}},
            {"id": "call-2", "function": {"name": "", "arguments": "{"}},
        ],
        [
            {"tool_call_id": "call-1", "content": json.dumps({"events": []})},
            {"tool_call_id": "missing", "content": json.dumps({"server_id": "glean"})},
        ],
    )

    assert refresh_ids == []
    assert tooling_state_changed is False


def test_extract_followup_tool_refresh_ids_returns_no_change_for_non_list_inputs():
    helpers = _load_overflow_helpers()

    assert helpers["_extract_followup_tool_refresh_ids"](None, []) == ([], False)
    assert helpers["_extract_followup_tool_refresh_ids"]([], None) == ([], False)


def test_ensure_chat_agent_vm_for_overflow_reuses_single_vm_during_parallel_creation():
    helpers = _load_overflow_helpers()
    created = []
    now = 40_000.0
    fake_redis = _FakeRedis()

    async def fake_create(chat_id):
        created.append(chat_id)
        await asyncio.sleep(0.05)
        fake_redis.setex(
            "agent_vm_info:vm-shared",
            int(round((1.0 + 1.0) * 3600.0)),
            json.dumps(
                _vm_info(
                    "vm-shared",
                    chat_id,
                    last_activity=now,
                    timeout_hours=1.0,
                )
            ),
        )
        return "vm-shared"

    helpers["_overflow_redis_client"] = lambda: fake_redis
    helpers["_create_chat_agent_vm_for_overflow"] = fake_create
    helpers["time"] = type(
        "FakeTime",
        (),
        {
            "time": staticmethod(lambda: now),
            "time_ns": staticmethod(lambda: int(now * 1_000_000_000)),
            "monotonic": staticmethod(lambda: now),
        },
    )

    async def run():
        return await asyncio.gather(
            helpers["_ensure_chat_agent_vm_for_overflow"]("chat-race"),
            helpers["_ensure_chat_agent_vm_for_overflow"]("chat-race"),
            helpers["_ensure_chat_agent_vm_for_overflow"]("chat-race"),
        )

    result = asyncio.run(run())

    assert result == ["vm-shared", "vm-shared", "vm-shared"]
    assert created == ["chat-race"]
    assert fake_redis.get("agent_vm:chat-race") == "vm-shared"
    assert "agent_vm:chat-race" not in fake_redis.ttls


def test_list_active_chat_agent_vms_sync_returns_most_recent_active_vms_only():
    helpers = _load_overflow_helpers()
    now = 10_000.0
    fake_redis = _FakeRedis(
        {
            "agent_vm_info:vm-new": json.dumps(
                _vm_info("vm-new", "chat-1", last_activity=now - 5, timeout_hours=4.0)
            ),
            "agent_vm_info:vm-old": json.dumps(
                _vm_info("vm-old", "chat-1", last_activity=now - 25, timeout_hours=4.0)
            ),
            "agent_vm_info:vm-expired": json.dumps(
                _vm_info(
                    "vm-expired",
                    "chat-1",
                    last_activity=now - (5 * 3600),
                    timeout_hours=1.0,
                )
            ),
            "agent_vm_info:vm-other-chat": json.dumps(
                _vm_info("vm-other-chat", "chat-2", last_activity=now - 3)
            ),
        }
    )
    helpers["_overflow_redis_client"] = lambda: fake_redis
    helpers["_open_agent_vm_docker_client"] = lambda: object()
    helpers["_inspect_agent_vm_container_status"] = (
        lambda vm_info, _docker_client: (True, vm_info.get("status"))
    )
    helpers["time"] = type(
        "FakeTime",
        (),
        {"time": staticmethod(lambda: now)},
    )

    result = helpers["_list_active_chat_agent_vms_sync"]("chat-1")

    assert [vm["vm_id"] for vm in result] == ["vm-new", "vm-old"]


def test_refresh_active_chat_agent_vms_updates_all_active_metadata_and_repoints_mapping():
    helpers = _load_overflow_helpers()
    now = 20_000.0
    fake_redis = _FakeRedis(
        {
            "agent_vm:chat-1": "vm-stale",
            "agent_vm_info:vm-a": json.dumps(
                _vm_info("vm-a", "chat-1", last_activity=now - 90, timeout_hours=6.0)
            ),
            "agent_vm_info:vm-b": json.dumps(
                _vm_info("vm-b", "chat-1", last_activity=now - 30, timeout_hours=2.0)
            ),
            "agent_vm_info:vm-expired": json.dumps(
                _vm_info(
                    "vm-expired",
                    "chat-1",
                    last_activity=now - (4 * 3600),
                    timeout_hours=1.0,
                )
            ),
        }
    )
    fake_redis.ttls.update(
        {
            "agent_vm:chat-1": 3600,
            "agent_vm_info:vm-a": 3600,
            "agent_vm_info:vm-b": 3600,
        }
    )

    helpers["_overflow_redis_client"] = lambda: fake_redis
    helpers["_open_agent_vm_docker_client"] = lambda: object()
    helpers["_inspect_agent_vm_container_status"] = (
        lambda vm_info, _docker_client: (True, "running")
    )
    helpers["time"] = type(
        "FakeTime",
        (),
        {"time": staticmethod(lambda: now)},
    )

    refreshed = asyncio.run(
        helpers["_refresh_active_chat_agent_vms"]("chat-1", reason="prompt_start")
    )

    assert refreshed == ["vm-b", "vm-a"]
    assert fake_redis.get("agent_vm:chat-1") == "vm-b"
    assert "agent_vm:chat-1" not in fake_redis.ttls
    assert "agent_vm_info:vm-a" not in fake_redis.ttls
    assert "agent_vm_info:vm-b" not in fake_redis.ttls

    vm_a = json.loads(fake_redis.get("agent_vm_info:vm-a"))
    vm_b = json.loads(fake_redis.get("agent_vm_info:vm-b"))
    vm_expired = json.loads(fake_redis.get("agent_vm_info:vm-expired"))

    assert vm_a["last_activity"] == now
    assert vm_b["last_activity"] == now
    assert vm_expired["last_activity"] == now - (4 * 3600)


def test_ensure_chat_agent_vm_for_overflow_reuses_most_recent_active_chat_vm_before_creating():
    helpers = _load_overflow_helpers()
    now = 30_000.0
    fake_redis = _FakeRedis(
        {
            "agent_vm:chat-overflow": "vm-stale",
            "agent_vm_info:vm-older": json.dumps(
                _vm_info("vm-older", "chat-overflow", last_activity=now - 60, timeout_hours=8.0)
            ),
            "agent_vm_info:vm-newer": json.dumps(
                _vm_info("vm-newer", "chat-overflow", last_activity=now - 10, timeout_hours=3.0)
            ),
        }
    )
    created = []

    async def fake_create(_chat_id):
        created.append(True)
        return "vm-created"

    helpers["_overflow_redis_client"] = lambda: fake_redis
    helpers["_create_chat_agent_vm_for_overflow"] = fake_create
    helpers["_open_agent_vm_docker_client"] = lambda: object()
    helpers["_inspect_agent_vm_container_status"] = (
        lambda vm_info, _docker_client: (True, vm_info.get("status"))
    )
    helpers["time"] = type(
        "FakeTime",
        (),
        {
            "time": staticmethod(lambda: now),
            "time_ns": staticmethod(lambda: int(now * 1_000_000_000)),
            "monotonic": staticmethod(lambda: now),
        },
    )
    helpers["os"] = type(
        "FakeOs",
        (),
        {
            "getpid": staticmethod(lambda: 1234),
            "getenv": staticmethod(lambda _name: None),
        },
    )

    vm_id = asyncio.run(helpers["_ensure_chat_agent_vm_for_overflow"]("chat-overflow"))

    assert vm_id == "vm-newer"
    assert created == []
    assert fake_redis.get("agent_vm:chat-overflow") == "vm-newer"
    assert "agent_vm:chat-overflow" not in fake_redis.ttls


def test_chat_activity_vm_refresh_hooks_are_wired_in_prompt_and_terminal_paths():
    middleware_source = _middleware_source()
    main_source = _main_source()

    assert 'reason="prompt_start"' in main_source
    assert "await _refresh_active_chat_agent_vms(" in main_source
    assert 'reason="assistant_terminal"' in middleware_source
    assert 'reason="terminal_error"' in middleware_source


def test_overflow_agent_vm_timeout_hours_defaults_and_honors_env(monkeypatch):
    monkeypatch.delenv("OWUI_OVERFLOW_AGENT_VM_TIMEOUT_HOURS", raising=False)
    helpers = _load_overflow_helpers()
    assert helpers["_overflow_agent_vm_timeout_hours"]() == 1.0

    monkeypatch.setenv("OWUI_OVERFLOW_AGENT_VM_TIMEOUT_HOURS", "1.5")
    helpers = _load_overflow_helpers()
    assert helpers["_overflow_agent_vm_timeout_hours"]() == 1.5

    monkeypatch.setenv("OWUI_OVERFLOW_AGENT_VM_TIMEOUT_HOURS", "0")
    helpers = _load_overflow_helpers()
    assert helpers["_overflow_agent_vm_timeout_hours"]() == 1.0
