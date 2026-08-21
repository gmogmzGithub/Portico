import ast
import asyncio
import inspect
import json
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Optional


class _FakeLog:
    def debug(self, *args, **kwargs):
        return None

    def info(self, *args, **kwargs):
        return None

    def warning(self, *args, **kwargs):
        return None


class _SimpleYaml:
    @staticmethod
    def safe_load(handle):
        data = {}
        for line in handle.read().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or ":" not in line:
                continue
            key, value = line.split(":", 1)
            value = value.strip().strip('"').strip("'")
            if value.lower() == "true":
                parsed_value = True
            elif value.lower() == "false":
                parsed_value = False
            else:
                parsed_value = value
            data[key.strip()] = parsed_value
        return data


def _load_dynamic_tool_helpers():
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
        "_coerce_tool_ids",
        "_canonicalize_tool_ids_for_loading",
        "_extract_tool_server_id",
        "_filter_subagent_locked_tool_registry",
        "_find_mcp_yaml_path",
        "_merge_tool_ids",
        "_load_server_metadata",
        "_load_server_fragment_payload",
        "_server_uses_external_oauth21",
        "_proxy_base_url_for_server_metadata",
        "_proxy_base_url_for_server_id",
        "_build_openapi_tool_server_connection",
        "_build_tool_server_openapi_url",
        "_build_tool_server_status_url",
        "_build_openai_function_tools_payload",
        "_invalidate_tool_servers_cache",
        "_ensure_tool_server_connections_for_tool_ids",
        "_openapi_has_callable_tool_paths",
        "_server_status_is_tool_ready",
        "_build_dynamic_tool_starting_system_message",
        "_merge_chat_attached_tool_ids_for_request",
        "_load_pending_tool_specs_after_inlet",
        "_refresh_cached_tool_specs_for_ids",
        "_tool_server_connections_list",
        "_load_mcp_toggles_for_prompt_path",
        "_filter_cached_tool_servers_by_toggle",
        "_get_cached_tool_servers_for_prompt_path",
        "_connection_index_by_server_id",
        "_openapi_tool_headers_and_cookies",
        "load_cached_tool_specs_for_ids",
        "_inject_loaded_tool_specs_into_request",
        "_inject_loaded_tool_specs_into_followup_request",
        "_missing_tool_ids_from_registry",
        "_missing_followup_tool_ids_from_registry",
        "_normalize_followup_tool_refresh_id",
        "_extract_followup_tool_refresh_ids",
        "_normalize_server_id",
        "_resolve_tool_server_id",
        "_ensure_native_tool_payload_for_active_tools",
    }
    selected_nodes = [
        node
        for node in module_ast.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name in wanted_functions
    ]

    namespace = {
        "log": _FakeLog(),
        "_is_openai_prompt_cache_tool_model": lambda _model_id: False,
        "_augment_openai_prompt_cache_tool_registry_aliases": lambda tools: (tools, {}),
        "_normalize_openai_function_tools_payloads": lambda tools, chat_id=None: tools,
        "_ensure_tool_server_connections_for_tool_ids": (
            lambda request, tool_ids: asyncio.sleep(0)
        ),
        "_invalidate_tool_servers_cache": lambda request: asyncio.sleep(0),
        "get_tool_servers": lambda request: asyncio.sleep(0, result=[]),
        "execute_tool_server": lambda **_kwargs: asyncio.sleep(0, result={}),
        "refresh_tool_servers_for_ids": lambda request, server_ids: asyncio.sleep(
            0, result=[]
        ),
        "get_async_tool_function_and_apply_extra_params": lambda fn, _params: fn,
        "is_string_allowed": lambda value, allowed: value in allowed,
        "_enrich_loaded_external_tools_with_runtime_metadata": (
            lambda loaded_tools, **_kwargs: loaded_tools
        ),
        "_SUBAGENT_LOCKED_TOOL_NAMES": {
            "skills_activate_skill",
            "mcp_assistant_activate_integration",
        },
        "_SERVER_METADATA_CACHE": {},
        "MCPO_CORE_PROXY_BASE_URL": "http://mcpo-core:8090",
        "MCPO_REGULAR_PROXY_BASE_URL": "http://mcpo:8080",
        "MCPO_HOST_PROXY_BASE_URL": "http://host.docker.internal:8890",
        "MCP_CONFIGS_DIR": Path("/app/mcp-configs"),
        "MCP_CONFIGS_USER_DIR": Path("/app/mcp-configs-user"),
        "Path": Path,
        "inspect": inspect,
        "json": json,
        "time": time,
        "yaml": _SimpleYaml,
        "Any": Any,
        "Optional": Optional,
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


def test_pending_tool_specs_load_from_cache_without_readiness_or_openapi_probe():
    helpers = _load_dynamic_tool_helpers()
    request = SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(
                TOOL_SERVERS=[
                    {
                        "id": "google_workspace",
                        "idx": 0,
                        "url": "http://mcpo/google_workspace",
                        "specs": [{"name": "google_workspace_get_events"}],
                    }
                ],
                redis=None,
                config=SimpleNamespace(
                    TOOL_SERVER_CONNECTIONS=[
                        {
                            "url": "http://mcpo/google_workspace",
                            "path": "openapi.json",
                            "type": "openapi",
                            "auth_type": "bearer",
                            "headers": None,
                            "key": "",
                            "config": {"enable": True, "access_control": None},
                            "info": {
                                "id": "google_workspace",
                                "name": "Google Workspace",
                                "description": "",
                            },
                        }
                    ]
                ),
            )
        )
    )

    async def fail_wait_for_tool_servers_ready(**_kwargs):
        raise AssertionError("prompt path must not wait for tool readiness")

    async def fail_load_tool_specs_for_ids(**_kwargs):
        raise AssertionError("prompt path must not fetch live OpenAPI specs")

    async def fail_ensure_tool_server_connections_for_tool_ids(*_args, **_kwargs):
        raise AssertionError("prompt path must not mutate tool server connections")

    helpers["wait_for_tool_servers_ready"] = fail_wait_for_tool_servers_ready
    helpers["load_tool_specs_for_ids"] = fail_load_tool_specs_for_ids
    helpers["_ensure_tool_server_connections_for_tool_ids"] = (
        fail_ensure_tool_server_connections_for_tool_ids
    )

    loaded_tools, loaded_tool_ids, loaded_tool_specs, unresolved_tool_ids = asyncio.run(
        helpers["_load_pending_tool_specs_after_inlet"](
            request=request,
            pending_tool_ids=["server:google_workspace"],
            user={"id": "user-1"},
            extra_params={},
            model={},
            form_data={"messages": []},
            metadata={"files": []},
        )
    )

    assert list(loaded_tools) == ["google_workspace_get_events"]
    assert loaded_tool_ids == ["server:google_workspace"]
    assert loaded_tool_specs == [
        {
            "type": "function",
            "function": {"name": "google_workspace_get_events"},
        }
    ]
    assert unresolved_tool_ids == []


def test_missing_cached_spec_on_normal_prompt_does_not_refresh_targeted_specs():
    helpers = _load_dynamic_tool_helpers()
    request = SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(
                TOOL_SERVERS=[],
                redis=None,
                config=SimpleNamespace(
                    TOOL_SERVER_CONNECTIONS=[
                        {
                            "url": "http://mcpo/google_workspace",
                            "path": "openapi.json",
                            "info": {"id": "google_workspace"},
                        }
                    ]
                ),
            )
        )
    )

    async def fail_refresh_tool_servers_for_ids(*_args, **_kwargs):
        raise AssertionError("normal prompt path must not refresh OpenAPI specs")

    async def fail_ensure_tool_server_connections_for_tool_ids(*_args, **_kwargs):
        raise AssertionError("normal prompt path must not mutate tool server connections")

    helpers["refresh_tool_servers_for_ids"] = fail_refresh_tool_servers_for_ids
    helpers["_ensure_tool_server_connections_for_tool_ids"] = (
        fail_ensure_tool_server_connections_for_tool_ids
    )

    loaded_tools, loaded_tool_ids, loaded_tool_specs, unresolved_tool_ids = asyncio.run(
        helpers["_load_pending_tool_specs_after_inlet"](
            request=request,
            pending_tool_ids=["server:google_workspace"],
            user={"id": "user-1"},
            extra_params={},
            model={},
            form_data={"messages": []},
            metadata={"chat_id": "chat-1", "files": []},
        )
    )

    assert loaded_tools == {}
    assert loaded_tool_ids == []
    assert loaded_tool_specs == []
    assert unresolved_tool_ids == ["server:google_workspace"]


def test_activation_scoped_refresh_hydrates_only_requested_missing_server():
    helpers = _load_dynamic_tool_helpers()
    request = SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(
                TOOL_SERVERS=[
                    {
                        "id": "snowflake",
                        "idx": 0,
                        "url": "http://mcpo/snowflake",
                        "specs": [{"name": "snowflake_query"}],
                    }
                ],
                redis=None,
                config=SimpleNamespace(
                    TOOL_SERVER_CONNECTIONS=[
                        {
                            "url": "http://mcpo/google_workspace",
                            "path": "openapi.json",
                            "info": {"id": "google_workspace"},
                        },
                        {
                            "url": "http://mcpo/snowflake",
                            "path": "openapi.json",
                            "info": {"id": "snowflake"},
                        },
                    ]
                ),
            )
        )
    )
    refresh_calls = []
    ensure_calls = []

    async def fake_refresh_tool_servers_for_ids(request_arg, server_ids):
        assert request_arg is request
        refresh_calls.append(list(server_ids))
        assert server_ids == ["google_workspace"]
        request.app.state.TOOL_SERVERS = [
            *request.app.state.TOOL_SERVERS,
            {
                "id": "google_workspace",
                "idx": 1,
                "url": "http://mcpo/google_workspace",
                "specs": [{"name": "google_workspace_get_events"}],
            },
        ]
        return [
            {
                "id": "google_workspace",
                "idx": 1,
                "url": "http://mcpo/google_workspace",
                "specs": [{"name": "google_workspace_get_events"}],
            }
        ]

    async def fake_ensure_tool_server_connections_for_tool_ids(**kwargs):
        ensure_calls.append(kwargs)
        return []

    helpers["refresh_tool_servers_for_ids"] = fake_refresh_tool_servers_for_ids
    helpers["_ensure_tool_server_connections_for_tool_ids"] = (
        fake_ensure_tool_server_connections_for_tool_ids
    )

    loaded_tools, loaded_tool_ids, loaded_tool_specs, unresolved_tool_ids = asyncio.run(
        helpers["_load_pending_tool_specs_after_inlet"](
            request=request,
            pending_tool_ids=["server:google_workspace", "server:snowflake"],
            user={"id": "user-1"},
            extra_params={},
            model={},
            form_data={"messages": []},
            metadata={"chat_id": "chat-1", "files": []},
            allow_targeted_refresh=True,
            targeted_refresh_tool_ids=["server:google_workspace"],
            refresh_reason="activation_followup",
        )
    )

    assert refresh_calls == [["google_workspace"]]
    assert ensure_calls == [
        {
            "request": request,
            "tool_ids": ["server:google_workspace"],
            "chat_id": "chat-1",
            "invalidate_cache": False,
        }
    ]
    assert sorted(loaded_tools) == [
        "google_workspace_get_events",
        "snowflake_query",
    ]
    assert loaded_tool_ids == ["server:snowflake", "server:google_workspace"]
    assert loaded_tool_specs == [
        {"type": "function", "function": {"name": "snowflake_query"}},
        {"type": "function", "function": {"name": "google_workspace_get_events"}},
    ]
    assert unresolved_tool_ids == []


def test_foreground_request_backfills_only_chat_attached_tool_ids_from_redis():
    helpers = _load_dynamic_tool_helpers()

    async def fake_load_pending_chat_tool_ids_from_redis(request, chat_id):
        assert request == "request"
        assert chat_id == "chat-1"
        return ["server:portico-proctor"]

    async def fake_load_pending_chat_skill_required_tool_ids_from_redis(request, chat_id):
        assert request == "request"
        assert chat_id == "chat-1"
        return ["server:skills", "server:google_workspace"]

    helpers["load_pending_chat_tool_ids_from_redis"] = fake_load_pending_chat_tool_ids_from_redis
    helpers["load_pending_chat_skill_required_tool_ids_from_redis"] = (
        fake_load_pending_chat_skill_required_tool_ids_from_redis
    )

    merged_tool_ids = asyncio.run(
        helpers["_merge_chat_attached_tool_ids_for_request"](
            request="request",
            chat_id="chat-1",
            existing_tool_ids=["server:mcp-assistant", "server:skills"],
        )
    )

    assert merged_tool_ids == [
        "server:mcp-assistant",
        "server:skills",
        "server:portico-proctor",
    ]


def test_foreground_request_does_not_expose_skill_required_servers_before_attachment():
    helpers = _load_dynamic_tool_helpers()

    async def fake_load_pending_chat_tool_ids_from_redis(request, chat_id):
        assert request == "request"
        assert chat_id == "chat-1"
        return ["server:mcp-assistant", "server:skills"]

    async def fake_load_pending_chat_skill_required_tool_ids_from_redis(request, chat_id):
        assert request == "request"
        assert chat_id == "chat-1"
        return ["server:google_workspace", "server:agent-vm"]

    helpers["load_pending_chat_tool_ids_from_redis"] = fake_load_pending_chat_tool_ids_from_redis
    helpers["load_pending_chat_skill_required_tool_ids_from_redis"] = (
        fake_load_pending_chat_skill_required_tool_ids_from_redis
    )

    merged_tool_ids = asyncio.run(
        helpers["_merge_chat_attached_tool_ids_for_request"](
            request="request",
            chat_id="chat-1",
            existing_tool_ids=["server:mcp-assistant", "server:skills"],
        )
    )

    assert merged_tool_ids == ["server:mcp-assistant", "server:skills"]


def test_merge_chat_attached_tool_ids_returns_existing_ids_when_chat_id_is_missing():
    helpers = _load_dynamic_tool_helpers()

    merged_tool_ids = asyncio.run(
        helpers["_merge_chat_attached_tool_ids_for_request"](
            request="request",
            chat_id=None,
            existing_tool_ids=("server:mcp-assistant", "server:skills"),
        )
    )

    assert merged_tool_ids == ["server:mcp-assistant", "server:skills"]


def test_tool_id_helpers_and_dynamic_starting_message_preserve_order_and_normalize_ids():
    helpers = _load_dynamic_tool_helpers()

    assert helpers["_coerce_tool_ids"](None) == []
    assert helpers["_coerce_tool_ids"]("server:skills") == ["server:skills"]
    assert helpers["_canonicalize_tool_ids_for_loading"](
        [
            "server:google_workspace|get_events,get_messages",
            "server:server:google_workspace|get_events,get_messages",
            "local-tool",
            "server:skills",
        ]
    ) == [
        "server:google_workspace|get_events,get_messages",
        "local-tool",
        "server:skills",
    ]
    assert helpers["_extract_tool_server_id"]("server:mcp:google_workspace") == "google_workspace"
    assert helpers["_merge_tool_ids"](
        ["server:skills", "server:agent-vm"],
        ["server:agent-vm", "server:google_workspace", "server:skills"],
    ) == [
        "server:skills",
        "server:agent-vm",
        "server:google_workspace",
    ]

    message = helpers["_build_dynamic_tool_starting_system_message"](
        ["server:mcp:google_workspace", "server:agent-vm"]
    )
    assert "server:google_workspace" in message
    assert "server:agent-vm" in message
    assert "Do not call these tools in this response." in message


def test_cached_tool_loading_deduplicates_canonical_and_doubled_server_ids():
    helpers = _load_dynamic_tool_helpers()
    request = SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(
                TOOL_SERVERS=[
                    {
                        "id": "google_workspace",
                        "idx": 0,
                        "url": "http://mcpo/google_workspace",
                        "specs": [
                            {"name": "google_workspace_get_gmail_messages_content_batch"}
                        ],
                    }
                ],
                redis=None,
                config=SimpleNamespace(
                    TOOL_SERVER_CONNECTIONS=[
                        {
                            "url": "http://mcpo/google_workspace",
                            "path": "openapi.json",
                            "info": {"id": "google_workspace"},
                        }
                    ]
                ),
            )
        )
    )

    loaded_tools, loaded_tool_ids, loaded_tool_specs, unresolved_tool_ids = asyncio.run(
        helpers["load_cached_tool_specs_for_ids"](
            request=request,
            tool_ids=[
                "server:google_workspace",
                "server:server:google_workspace",
            ],
            user={"id": "user-1"},
            extra_params={},
            model={},
            form_data={"messages": []},
            metadata={"chat_id": "chat-1", "files": []},
        )
    )

    assert list(loaded_tools) == ["google_workspace_get_gmail_messages_content_batch"]
    assert loaded_tool_ids == ["server:google_workspace"]
    assert loaded_tool_specs == [
        {
            "type": "function",
            "function": {"name": "google_workspace_get_gmail_messages_content_batch"},
        }
    ]
    assert unresolved_tool_ids == []


def test_foreground_unresolved_chat_attached_tools_append_not_callable_guardrail():
    source_path = (
        Path(__file__).resolve().parents[1]
        / "src"
        / "patches"
        / "backend"
        / "open_webui"
        / "utils"
        / "middleware.py"
    )
    source = source_path.read_text(encoding="utf-8")
    branch_start = source.index(
        'log.info(\n                "[DYNAMIC_TOOLS] Foreground request missing chat-attached tool specs'
    )
    branch_end = source.index(
        'log.warning(\n                    "[DYNAMIC_TOOLS] Foreground request tool spec hydration failed',
        branch_start,
    )
    branch = source[branch_start:branch_end]

    assert "add_or_update_system_message(" in branch
    assert "_build_dynamic_tool_starting_system_message(unresolved_tool_ids)" in branch
    assert "append=True" in branch


def test_active_tools_force_native_provider_payload_across_model_families():
    helpers = _load_dynamic_tool_helpers()

    for model_name in (
        "Claude Opus 4.8",
        "Gemini 3.5 Flash",
        "GPT-5.5",
        "custom-roadmap-agent",
    ):
        form_data = {
            "model": model_name,
            "messages": [],
            "reasoning_effort": "xhigh",
        }
        metadata = {
            "chat_id": "chat-1",
            "message_id": "message-1",
            "params": {"function_calling": "default"},
        }

        promoted = helpers["_ensure_native_tool_payload_for_active_tools"](
            form_data=form_data,
            metadata=metadata,
            tools_dict={
                "agent_vm_bash": {
                    "server_id": "agent-vm",
                    "spec": {"name": "agent_vm_bash"},
                }
            },
        )

        assert promoted is True
        assert metadata["params"]["function_calling"] == "native"
        assert "params" not in form_data
        assert form_data["reasoning_effort"] == "xhigh"
        assert form_data["metadata"] is metadata
        assert form_data["tools"] == [
            {"type": "function", "function": {"name": "agent_vm_bash"}}
        ]


def test_auth_migrated_model_row_shape_still_forces_native_tool_payload():
    helpers = _load_dynamic_tool_helpers()

    form_data = {"model": "Claude Opus 4.8", "messages": []}
    metadata = {
        "chat_id": "chat-opus-48",
        "message_id": "message-1",
        "params": {},
    }

    promoted = helpers["_ensure_native_tool_payload_for_active_tools"](
        form_data=form_data,
        metadata=metadata,
        tools_dict={
            "skills_list_skills": {
                "server_id": "skills",
                "spec": {"name": "skills_list_skills"},
            },
            "legacy_tool": {
                "server_id": "legacy",
                "spec": {"name": "legacy_tool"},
            },
        },
    )

    assert promoted is True
    assert metadata["params"]["function_calling"] == "native"
    assert "params" not in form_data
    assert [tool["function"]["name"] for tool in form_data["tools"]] == [
        "skills_list_skills",
        "legacy_tool",
    ]


def test_no_tools_request_does_not_fabricate_native_payload():
    helpers = _load_dynamic_tool_helpers()

    form_data = {"model": "Claude Opus 4.8", "messages": []}
    metadata = {"chat_id": "chat-1", "params": {"function_calling": "default"}}

    promoted = helpers["_ensure_native_tool_payload_for_active_tools"](
        form_data=form_data,
        metadata=metadata,
        tools_dict={},
    )

    assert promoted is False
    assert metadata["params"]["function_calling"] == "default"
    assert "params" not in form_data
    assert "tools" not in form_data


def test_followup_activation_refresh_ids_prefer_ready_then_newly_added_then_args():
    helpers = _load_dynamic_tool_helpers()

    response_tool_calls = [
        {
            "id": "call-1",
            "function": {
                "name": "mcp_assistant_activate_integration",
                "arguments": json.dumps(
                    {
                        "tool_server_ids": [
                            "server:argument-server",
                            "server:another-argument-server",
                        ]
                    }
                ),
            },
        }
    ]
    results = [
        {
            "tool_call_id": "call-1",
            "content": json.dumps(
                {
                    "success": True,
                    "ready_tool_server_ids": ["server:google_workspace"],
                    "newly_added": ["server:slack"],
                    "enabled_tools": ["server:snowflake"],
                }
            ),
        }
    ]

    refresh_ids, tooling_state_changed = helpers["_extract_followup_tool_refresh_ids"](
        response_tool_calls,
        results,
    )

    assert tooling_state_changed is True
    assert refresh_ids == ["server:google_workspace"]

    results[0]["content"] = json.dumps(
        {
            "success": True,
            "newly_added": ["server:slack"],
            "enabled_tools": ["server:snowflake"],
        }
    )
    refresh_ids, _ = helpers["_extract_followup_tool_refresh_ids"](
        response_tool_calls,
        results,
    )
    assert refresh_ids == ["server:slack"]

    results[0]["content"] = json.dumps(
        {"success": True, "enabled_tools": ["server:snowflake"]}
    )
    refresh_ids, _ = helpers["_extract_followup_tool_refresh_ids"](
        response_tool_calls,
        results,
    )
    assert refresh_ids == ["server:argument-server", "server:another-argument-server"]


def test_followup_activation_failure_and_authorize_auto_activation_refresh_policy():
    helpers = _load_dynamic_tool_helpers()

    activation_refresh_ids, activation_state_changed = helpers[
        "_extract_followup_tool_refresh_ids"
    ](
        [
            {
                "id": "activation-call",
                "function": {
                    "name": "mcp_assistant_activate_integration",
                    "arguments": json.dumps({"tool_server_ids": ["server:snowflake"]}),
                },
            }
        ],
        [
            {
                "tool_call_id": "activation-call",
                "content": json.dumps(
                    {"success": False, "newly_added": ["server:snowflake"]}
                ),
            }
        ],
    )

    assert activation_state_changed is True
    assert activation_refresh_ids == []

    authorize_refresh_ids, authorize_state_changed = helpers[
        "_extract_followup_tool_refresh_ids"
    ](
        [
            {
                "id": "authorize-call",
                "function": {
                    "name": "mcp_assistant_authorize_integration",
                    "arguments": json.dumps({"server_id": "fallback-server"}),
                },
            }
        ],
        [
            {
                "tool_call_id": "authorize-call",
                "content": json.dumps(
                    {"auto_activated": True, "server_id": "google_workspace"}
                ),
            }
        ],
    )

    assert authorize_state_changed is True
    assert authorize_refresh_ids == ["server:google_workspace"]


def test_openapi_and_status_helpers_require_callable_non_oauth_tools():
    helpers = _load_dynamic_tool_helpers()

    assert helpers["_openapi_has_callable_tool_paths"](None) is False
    assert helpers["_openapi_has_callable_tool_paths"](
        {"paths": {"/oauth/token": {}, "/oauth/authorize": {}}}
    ) is False
    assert helpers["_openapi_has_callable_tool_paths"](
        {"paths": {"/oauth/token": {}, "/drive/files": {}}}
    ) is True

    assert helpers["_server_status_is_tool_ready"](None) is False
    assert helpers["_server_status_is_tool_ready"]({"readiness_phase": "tool_ready"}) is True
    assert helpers["_server_status_is_tool_ready"]({"healthy": True, "tools_count": "2"}) is True
    assert helpers["_server_status_is_tool_ready"]({"healthy": True, "tools_count": 0}) is False


def test_tool_server_url_builders_use_connection_config_and_proxy_fallbacks():
    helpers = _load_dynamic_tool_helpers()
    request = SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(
                config=SimpleNamespace(
                    TOOL_SERVER_CONNECTIONS=SimpleNamespace(
                        value=[
                            {
                                "info": {"id": "google_workspace"},
                                "url": "http://hosted/google_workspace/",
                                "path": "/spec/openapi.json",
                            },
                            {
                                "info": {"id": "agent-vm"},
                                "url": "http://mcpo-core:8090/agent-vm",
                            },
                            {
                                "info": {"id": "custom-host"},
                                "url": "http://custom-host/runtime",
                            },
                        ]
                    )
                )
            )
        )
    )

    assert helpers["_build_tool_server_openapi_url"](
        request, "server:google_workspace"
    ) == "http://hosted/google_workspace/spec/openapi.json"
    assert helpers["_build_tool_server_openapi_url"](
        request, "server:agent-vm"
    ) == "http://mcpo-core:8090/agent-vm/openapi.json"
    assert helpers["_build_tool_server_openapi_url"](
        request, "server:slack"
    ) == "http://mcpo:8080/slack/openapi.json"

    assert helpers["_build_tool_server_status_url"](
        request, "server:agent-vm"
    ) == "http://mcpo-core:8090/servers/agent-vm/status"
    assert helpers["_build_tool_server_status_url"](
        request, "server:google_workspace"
    ) is None
    assert helpers["_build_tool_server_status_url"](request, "server:custom-host") is None
    assert helpers["_build_tool_server_status_url"](
        request, "server:slack"
    ) == "http://mcpo:8080/servers/slack/status"


def test_host_deployed_tool_server_uses_host_mcpo_fallback(tmp_path):
    helpers = _load_dynamic_tool_helpers()
    system_dir = tmp_path / "mcp-configs"
    user_dir = tmp_path / "mcp-configs-user"
    chrome_dir = system_dir / "chrome-devtools"
    chrome_dir.mkdir(parents=True)
    user_dir.mkdir()
    (chrome_dir / "chrome-devtools.yaml").write_text(
        "\n".join(
            [
                "name: Chrome DevTools MCP Server",
                "id: chrome-devtools",
                "display_name: Chrome DevTools",
                "deployment_type: host",
                "description: Browser automation",
                "is_core: false",
            ]
        ),
        encoding="utf-8",
    )
    helpers["MCP_CONFIGS_DIR"] = system_dir
    helpers["MCP_CONFIGS_USER_DIR"] = user_dir
    helpers["_SERVER_METADATA_CACHE"] = {}

    request = SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(
                TOOL_SERVERS=[
                    {
                        "id": "chrome-devtools",
                        "idx": 0,
                        "url": "http://host.docker.internal:8890/chrome-devtools",
                        "specs": [{"name": "chrome_devtools_navigate_page"}],
                    }
                ],
                redis=None,
                config=SimpleNamespace(
                    TOOL_SERVER_CONNECTIONS=[
                        {
                            "info": {"id": "chrome-devtools"},
                            "url": "http://mcpo/chrome-devtools",
                            "path": "openapi.json",
                        }
                    ]
                )
            )
        )
    )

    connection = helpers["_build_openapi_tool_server_connection"]("chrome-devtools")
    assert connection["url"] == "http://host.docker.internal:8890/chrome-devtools"
    assert helpers["_build_tool_server_openapi_url"](
        request, "server:chrome-devtools"
    ) == "http://host.docker.internal:8890/chrome-devtools/openapi.json"
    assert (
        helpers["_build_tool_server_status_url"](request, "server:chrome-devtools")
        is None
    )


def test_stale_host_tool_server_connection_is_repaired_and_cache_invalidated(tmp_path):
    helpers = _load_dynamic_tool_helpers()
    system_dir = tmp_path / "mcp-configs"
    user_dir = tmp_path / "mcp-configs-user"
    chrome_dir = system_dir / "chrome-devtools"
    chrome_dir.mkdir(parents=True)
    user_dir.mkdir()
    (chrome_dir / "chrome-devtools.yaml").write_text(
        "\n".join(
            [
                "name: Chrome DevTools MCP Server",
                "id: chrome-devtools",
                "display_name: Chrome DevTools",
                "deployment_type: host",
                "description: Browser automation",
                "is_core: false",
            ]
        ),
        encoding="utf-8",
    )
    helpers["MCP_CONFIGS_DIR"] = system_dir
    helpers["MCP_CONFIGS_USER_DIR"] = user_dir
    helpers["_SERVER_METADATA_CACHE"] = {}

    class FakeRedis:
        def __init__(self):
            self.deleted = []

        def delete(self, key):
            self.deleted.append(key)
            return 1

    redis = FakeRedis()
    request = SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(
                redis=redis,
                TOOL_SERVERS=[{"id": "chrome-devtools"}],
                config=SimpleNamespace(
                    TOOL_SERVER_CONNECTIONS=[
                        {
                            "url": "http://mcpo/chrome-devtools",
                            "path": "openapi.json",
                            "type": "openapi",
                            "auth_type": "bearer",
                            "headers": None,
                            "key": "",
                            "config": {"enable": True, "access_control": None},
                            "info": {
                                "id": "chrome-devtools",
                                "name": "Chrome DevTools",
                                "description": "stale",
                            },
                        },
                        {
                            "url": "http://mcpo/skills",
                            "path": "openapi.json",
                            "info": {"id": "skills"},
                        },
                    ]
                ),
            )
        )
    )

    repaired = asyncio.run(
        helpers["_ensure_tool_server_connections_for_tool_ids"](
            request,
            ["server:chrome-devtools"],
            chat_id="chat-1",
        )
    )

    assert repaired == ["chrome-devtools"]
    assert request.app.state.config.TOOL_SERVER_CONNECTIONS[0]["url"] == (
        "http://host.docker.internal:8890/chrome-devtools"
    )
    assert request.app.state.config.TOOL_SERVER_CONNECTIONS[0]["info"] == {
        "id": "chrome-devtools",
        "name": "Chrome DevTools",
        "description": "Browser automation",
    }
    assert request.app.state.config.TOOL_SERVER_CONNECTIONS[1]["url"] == (
        "http://mcpo/skills"
    )
    assert request.app.state.TOOL_SERVERS == []
    assert redis.deleted == ["tool_servers"]


def test_host_server_activation_followup_uses_cached_specs_without_connection_mutation(
    tmp_path,
):
    helpers = _load_dynamic_tool_helpers()
    system_dir = tmp_path / "mcp-configs"
    user_dir = tmp_path / "mcp-configs-user"
    chrome_dir = system_dir / "chrome-devtools"
    chrome_dir.mkdir(parents=True)
    user_dir.mkdir()
    (chrome_dir / "chrome-devtools.yaml").write_text(
        "\n".join(
            [
                "name: Chrome DevTools MCP Server",
                "id: chrome-devtools",
                "display_name: Chrome DevTools",
                "deployment_type: host",
                "description: Browser automation",
                "is_core: false",
            ]
        ),
        encoding="utf-8",
    )
    helpers["MCP_CONFIGS_DIR"] = system_dir
    helpers["MCP_CONFIGS_USER_DIR"] = user_dir
    helpers["_SERVER_METADATA_CACHE"] = {}

    request = SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(
                TOOL_SERVERS=[
                    {
                        "id": "chrome-devtools",
                        "idx": 0,
                        "url": "http://host.docker.internal:8890/chrome-devtools",
                        "specs": [{"name": "chrome_devtools_navigate_page"}],
                    }
                ],
                redis=None,
                config=SimpleNamespace(
                    TOOL_SERVER_CONNECTIONS=[
                        {
                            "url": "http://mcpo/chrome-devtools",
                            "path": "openapi.json",
                            "type": "openapi",
                            "auth_type": "bearer",
                            "headers": None,
                            "key": "",
                            "config": {"enable": True, "access_control": None},
                            "info": {
                                "id": "chrome-devtools",
                                "name": "Chrome DevTools",
                                "description": "stale",
                            },
                        }
                    ]
                )
            )
        )
    )

    async def fail_wait_for_tool_servers_ready(**_kwargs):
        raise AssertionError("prompt path must not wait for tool readiness")

    async def fail_load_tool_specs_for_ids(**_kwargs):
        raise AssertionError("prompt path must not fetch live OpenAPI specs")

    helpers["wait_for_tool_servers_ready"] = fail_wait_for_tool_servers_ready
    helpers["load_tool_specs_for_ids"] = fail_load_tool_specs_for_ids

    loaded_tools, loaded_tool_ids, loaded_tool_specs, unresolved_tool_ids = asyncio.run(
        helpers["_load_pending_tool_specs_after_inlet"](
            request=request,
            pending_tool_ids=["server:chrome-devtools"],
            user={"id": "user-1"},
            extra_params={},
            model={},
            form_data={"messages": []},
            metadata={"files": []},
        )
    )

    assert list(loaded_tools) == ["chrome_devtools_navigate_page"]
    assert loaded_tool_ids == ["server:chrome-devtools"]
    assert unresolved_tool_ids == []
    assert request.app.state.config.TOOL_SERVER_CONNECTIONS[0]["url"] == (
        "http://mcpo/chrome-devtools"
    )
    assert loaded_tools["chrome_devtools_navigate_page"]["tool_server_data"]["url"] == (
        "http://host.docker.internal:8890/chrome-devtools"
    )

    new_form_data = {"model": "gpt-4.1", "messages": []}
    metadata = {"chat_id": "chat-1", "tool_ids": [], "tools": {}}
    helpers["_inject_loaded_tool_specs_into_followup_request"](
        new_form_data=new_form_data,
        metadata=metadata,
        existing_tool_ids=[],
        loaded_tools=loaded_tools,
        loaded_tool_ids=loaded_tool_ids,
        loaded_tool_specs=loaded_tool_specs,
    )

    assert metadata["tool_ids"] == ["server:chrome-devtools"]
    assert sorted(metadata["tools"]) == ["chrome_devtools_navigate_page"]
    assert new_form_data["tools"] == [
        {
            "type": "function",
            "function": {"name": "chrome_devtools_navigate_page"},
        }
    ]


def test_pending_tool_specs_return_unresolved_after_direct_retry_and_preserve_loaded_specs():
    helpers = _load_dynamic_tool_helpers()
    request = SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(
                TOOL_SERVERS=[
                    {
                        "id": "google_workspace",
                        "idx": 0,
                        "url": "http://mcpo/google_workspace",
                        "specs": [{"name": "google_workspace_get_events"}],
                    }
                ],
                redis=None,
                config=SimpleNamespace(
                    TOOL_SERVER_CONNECTIONS=[
                        {
                            "url": "http://mcpo/google_workspace",
                            "path": "openapi.json",
                            "type": "openapi",
                            "auth_type": "bearer",
                            "headers": None,
                            "key": "",
                            "config": {"enable": True, "access_control": None},
                            "info": {
                                "id": "google_workspace",
                                "name": "Google Workspace",
                                "description": "",
                            },
                        }
                    ]
                ),
            )
        )
    )
    captured = {}

    def fake_enrich_loaded_external_tools_with_runtime_metadata(
        loaded_tools, *, tool_servers, tool_server_connections
    ):
        captured["tool_servers"] = tool_servers
        captured["tool_server_connections"] = tool_server_connections
        enriched = dict(loaded_tools)
        enriched["google_workspace_get_events"]["server_id"] = "google_workspace"
        return enriched

    async def fail_wait_for_tool_servers_ready(**_kwargs):
        raise AssertionError("prompt path must not wait for tool readiness")

    async def fail_load_tool_specs_for_ids(**_kwargs):
        raise AssertionError("prompt path must not fetch live OpenAPI specs")

    helpers["wait_for_tool_servers_ready"] = fail_wait_for_tool_servers_ready
    helpers["load_tool_specs_for_ids"] = fail_load_tool_specs_for_ids
    helpers["_enrich_loaded_external_tools_with_runtime_metadata"] = (
        fake_enrich_loaded_external_tools_with_runtime_metadata
    )

    loaded_tools, loaded_tool_ids, loaded_tool_specs, unresolved_tool_ids = asyncio.run(
        helpers["_load_pending_tool_specs_after_inlet"](
            request=request,
            pending_tool_ids=["server:google_workspace", "server:agent-vm"],
            user={"id": "user-1"},
            extra_params={},
            model={},
            form_data={"messages": []},
            metadata={"files": []},
        )
    )

    assert loaded_tool_ids == ["server:google_workspace"]
    assert unresolved_tool_ids == ["server:agent-vm"]
    assert loaded_tool_specs == [
        {
            "type": "function",
            "function": {"name": "google_workspace_get_events"},
        }
    ]
    assert loaded_tools["google_workspace_get_events"]["server_id"] == "google_workspace"
    assert captured["tool_servers"][0]["id"] == "google_workspace"
    assert captured["tool_servers"][0]["url"] == "http://mcpo/google_workspace"
    assert captured["tool_server_connections"][0]["info"]["id"] == "google_workspace"


def test_prompt_path_does_not_mutate_tool_server_connections_before_hydration():
    source_path = (
        Path(__file__).resolve().parents[1]
        / "src"
        / "patches"
        / "backend"
        / "open_webui"
        / "utils"
        / "middleware.py"
    )
    text = source_path.read_text()
    prompt_path = text[
        text.index('metadata["__subagent_scope_locked"] = lock_subagent_integrations') :
        text.index("tools_dict = {}")
    ]

    assert "_ensure_tool_server_connections_for_tool_ids" not in prompt_path


def test_loaded_pending_tool_specs_are_injected_into_followup_request():
    helpers = _load_dynamic_tool_helpers()

    new_form_data = {"model": "gpt-4.1", "messages": []}
    metadata = {
        "chat_id": "chat-1",
        "tool_ids": ["server:skills"],
        "tools": {
            "skills_activate_skill": {"spec": {"name": "skills_activate_skill"}}
        },
    }

    helpers["_inject_loaded_tool_specs_into_followup_request"](
        new_form_data=new_form_data,
        metadata=metadata,
        existing_tool_ids=["server:skills"],
        loaded_tools={
            "google_workspace_get_events": {
                "spec": {"name": "google_workspace_get_events"}
            }
        },
        loaded_tool_ids=["server:google_workspace"],
        loaded_tool_specs=[
            {
                "type": "function",
                "function": {"name": "google_workspace_get_events"},
            }
        ],
    )

    assert sorted(metadata["tools"]) == [
        "google_workspace_get_events",
        "skills_activate_skill",
    ]
    assert metadata["tool_ids"] == ["server:skills", "server:google_workspace"]
    assert new_form_data["tools"] == [
        {
            "type": "function",
            "function": {"name": "google_workspace_get_events"},
        }
    ]


def test_foreground_injection_hydrates_chat_attached_chrome_specs_before_provider_payload():
    helpers = _load_dynamic_tool_helpers()

    form_data = {
        "model": "claude-sonnet",
        "messages": [],
        "tools": [{"type": "function", "function": {"name": "skills_list_skills"}}],
    }
    metadata = {
        "chat_id": "chat-1",
        "message_id": "message-1",
        "tool_ids": ["server:skills", "server:chrome-devtools"],
        "tools": {
            "skills_list_skills": {
                "server_id": "skills",
                "spec": {"name": "skills_list_skills"},
            }
        },
    }

    missing = helpers["_missing_tool_ids_from_registry"](
        metadata["tool_ids"],
        metadata["tools"],
    )
    assert missing == ["server:chrome-devtools"]

    injected = helpers["_inject_loaded_tool_specs_into_request"](
        form_data=form_data,
        metadata=metadata,
        existing_tool_ids=["server:skills", "server:chrome-devtools"],
        loaded_tools={
            "chrome_devtools_navigate_page": {
                "type": "external",
                "server_id": "chrome-devtools",
                "tool_id": "server:chrome-devtools",
                "spec": {"name": "chrome_devtools_navigate_page"},
            }
        },
        loaded_tool_ids=["server:chrome-devtools"],
        loaded_tool_specs=[
            {
                "type": "function",
                "function": {"name": "chrome_devtools_navigate_page"},
            }
        ],
        request_phase="foreground",
    )

    assert sorted(injected) == ["chrome_devtools_navigate_page"]
    assert sorted(metadata["tools"]) == [
        "chrome_devtools_navigate_page",
        "skills_list_skills",
    ]
    assert metadata["tool_ids"] == ["server:skills", "server:chrome-devtools"]
    assert [tool["function"]["name"] for tool in form_data["tools"]] == [
        "skills_list_skills",
        "chrome_devtools_navigate_page",
    ]
    assert form_data["metadata"] is metadata


def test_first_turn_context_tool_hydration_promotes_complete_native_payload():
    helpers = _load_dynamic_tool_helpers()

    form_data = {
        "model": "Claude Opus 4.8",
        "messages": [],
        "tools": [{"type": "function", "function": {"name": "skills_list_skills"}}],
        "reasoning_effort": "high",
    }
    metadata = {
        "chat_id": "chat-opus-48",
        "message_id": "message-1",
        "params": {"function_calling": "default"},
        "tool_ids": ["server:skills", "server:agent-vm"],
        "tools": {
            "skills_list_skills": {
                "server_id": "skills",
                "spec": {"name": "skills_list_skills"},
            }
        },
    }

    missing = helpers["_missing_tool_ids_from_registry"](
        metadata["tool_ids"],
        metadata["tools"],
    )
    assert missing == ["server:agent-vm"]

    injected = helpers["_inject_loaded_tool_specs_into_request"](
        form_data=form_data,
        metadata=metadata,
        existing_tool_ids=["server:skills", "server:agent-vm"],
        loaded_tools={
            "agent_vm_bash": {
                "type": "external",
                "server_id": "agent-vm",
                "tool_id": "server:agent-vm",
                "spec": {
                    "name": "agent_vm_bash",
                    "description": "Run a shell command in the workspace",
                },
            },
        },
        loaded_tool_ids=["server:agent-vm"],
        loaded_tool_specs=[
            {
                "type": "function",
                "function": {
                    "name": "agent_vm_bash",
                    "description": "Run a shell command in the workspace",
                },
            }
        ],
        request_phase="foreground",
    )

    assert sorted(injected) == ["agent_vm_bash"]
    assert sorted(metadata["tools"]) == ["agent_vm_bash", "skills_list_skills"]
    assert metadata["tool_ids"] == ["server:skills", "server:agent-vm"]
    assert [tool["function"]["name"] for tool in form_data["tools"]] == [
        "skills_list_skills",
        "agent_vm_bash",
    ]

    promoted = helpers["_ensure_native_tool_payload_for_active_tools"](
        form_data=form_data,
        metadata=metadata,
        tools_dict=metadata["tools"],
    )

    assert promoted is True
    assert metadata["params"]["function_calling"] == "native"
    assert "params" not in form_data
    assert form_data["reasoning_effort"] == "high"

    assert [tool["function"]["name"] for tool in form_data["tools"]] == [
        "skills_list_skills",
        "agent_vm_bash",
    ]


def test_followup_tool_injection_filters_locked_tools_and_normalizes_prompt_cache_payload():
    helpers = _load_dynamic_tool_helpers()
    captured = {}

    def fake_normalize_openai_function_tools_payloads(tools, chat_id=None):
        captured["tools"] = list(tools)
        captured["chat_id"] = chat_id
        return [{"type": "function", "function": {"name": "normalized_payload"}}]

    helpers["_is_openai_prompt_cache_tool_model"] = lambda _model_id: True
    helpers["_normalize_openai_function_tools_payloads"] = (
        fake_normalize_openai_function_tools_payloads
    )

    new_form_data = {
        "model": "gpt-4.1-mini",
        "messages": [],
        "tools": [{"type": "function", "function": {"name": "existing_tool"}}],
    }
    metadata = {
        "chat_id": "chat-1",
        "__subagent_scope_locked": True,
        "tool_ids": ["server:skills"],
        "tools": {},
    }

    helpers["_inject_loaded_tool_specs_into_followup_request"](
        new_form_data=new_form_data,
        metadata=metadata,
        existing_tool_ids=["server:skills"],
        loaded_tools={
            "skills_activate_skill": {
                "spec": {"name": "skills_activate_skill"},
            },
            "google_workspace_get_events": {
                "spec": {"name": "google_workspace_get_events"},
            },
        },
        loaded_tool_ids=["server:skills", "server:google_workspace"],
        loaded_tool_specs=[
            {"type": "function", "function": {"name": "skills_activate_skill"}},
            {"type": "function", "function": {"name": "google_workspace_get_events"}},
        ],
    )

    assert metadata["tools"] == {
        "google_workspace_get_events": {
            "spec": {"name": "google_workspace_get_events"},
        }
    }
    assert metadata["tool_ids"] == ["server:skills", "server:google_workspace"]
    assert captured["chat_id"] == "chat-1"
    assert captured["tools"] == [
        {"type": "function", "function": {"name": "existing_tool"}},
        {"type": "function", "function": {"name": "google_workspace_get_events"}},
    ]
    assert new_form_data["tools"] == [
        {"type": "function", "function": {"name": "normalized_payload"}}
    ]


def test_followup_tool_injection_noops_when_all_loaded_tools_are_filtered_out():
    helpers = _load_dynamic_tool_helpers()

    new_form_data = {
        "model": "claude-opus",
        "messages": [],
        "tools": [{"type": "function", "function": {"name": "existing_tool"}}],
    }
    metadata = {
        "chat_id": "chat-1",
        "__subagent_scope_locked": True,
        "tool_ids": ["server:skills"],
        "tools": {"existing_tool": {"spec": {"name": "existing_tool"}}},
    }

    helpers["_inject_loaded_tool_specs_into_followup_request"](
        new_form_data=new_form_data,
        metadata=metadata,
        existing_tool_ids=["server:skills"],
        loaded_tools={
            "skills_activate_skill": {
                "spec": {"name": "skills_activate_skill"},
            },
            "mcp_assistant_activate_integration": {
                "spec": {"name": "mcp_assistant_activate_integration"},
            },
        },
        loaded_tool_ids=["server:skills", "server:mcp-assistant"],
        loaded_tool_specs=[
            {"type": "function", "function": {"name": "skills_activate_skill"}},
            {
                "type": "function",
                "function": {"name": "mcp_assistant_activate_integration"},
            },
        ],
    )

    assert metadata["tools"] == {"existing_tool": {"spec": {"name": "existing_tool"}}}
    assert metadata["tool_ids"] == ["server:skills"]
    assert new_form_data["tools"] == [
        {"type": "function", "function": {"name": "existing_tool"}}
    ]


def test_missing_followup_tool_ids_from_registry_detects_chat_attached_servers_not_in_registry():
    helpers = _load_dynamic_tool_helpers()

    missing = helpers["_missing_followup_tool_ids_from_registry"](
        ["server:skills", "server:google_workspace", "server:agent-vm"],
        {
            "skills_activate_skill": {
                "server_id": "skills",
                "spec": {"name": "skills_activate_skill"},
            },
            "agent_vm_bash": {
                "server_id": "agent-vm",
                "spec": {"name": "agent_vm_bash"},
            },
        },
    )

    assert missing == ["server:google_workspace"]


def test_missing_followup_tool_ids_from_registry_ignores_non_server_ids_and_existing_entries():
    helpers = _load_dynamic_tool_helpers()

    missing = helpers["_missing_followup_tool_ids_from_registry"](
        ["server:mcp:legacy", "server:skills", "not-a-server"],
        {
            "skills_activate_skill": {
                "tool_server_connection": {"info": {"id": "skills"}},
                "spec": {"name": "skills_activate_skill"},
            }
        },
    )

    assert missing == []


def test_followup_inlet_filter_uses_explicit_runtime_model_registry():
    source_path = (
        Path(__file__).resolve().parents[1]
        / "src"
        / "patches"
        / "backend"
        / "open_webui"
        / "utils"
        / "middleware.py"
    )
    source = source_path.read_text(encoding="utf-8")

    assert "followup_models = (" in source
    assert "request, new_form_data, user, followup_models" in source
    assert "request, new_form_data, user, models" not in source


def test_active_dynamic_tools_force_native_provider_tool_calling():
    source_path = (
        Path(__file__).resolve().parents[1]
        / "src"
        / "patches"
        / "backend"
        / "open_webui"
        / "utils"
        / "middleware.py"
    )
    source = source_path.read_text(encoding="utf-8")

    force_native_guard = (
        'if tools_dict and metadata.get("params", {}).get("function_calling") != "native":'
    )
    force_native_assignment = (
        'metadata.setdefault("params", {})["function_calling"] = "native"'
    )
    helper_force_metadata = 'metadata_params["function_calling"] = "native"'
    helper_call = "if _ensure_native_tool_payload_for_active_tools("
    native_payload_assignment = 'form_data["tools"] = _build_openai_function_tools_payload('
    fallback_selector_call = "form_data, flags = await chat_completion_tools_handler("

    assert force_native_guard in source
    assert force_native_assignment in source
    assert helper_force_metadata in source
    assert helper_call in source
    assert native_payload_assignment in source
    assert fallback_selector_call in source

    helper_index = source.index("def _ensure_native_tool_payload_for_active_tools(")
    helper_end = source.index("def _rebuild_followup_function_tools_payload(", helper_index)
    helper_source = source[helper_index:helper_end]
    helper_payload_index = source.index(native_payload_assignment, helper_index)
    assert source.index(helper_force_metadata, helper_index) < helper_payload_index
    assert "form_params" not in helper_source
    assert 'form_data["params"]' not in helper_source
    legacy_guard_index = source.index(force_native_guard, source.index(helper_call))
    assert (
        source.index(force_native_assignment, legacy_guard_index)
        < source.index(native_payload_assignment, legacy_guard_index)
        < source.index(fallback_selector_call, legacy_guard_index)
    )


def test_non_native_tool_execution_postprocesses_success_and_error_results():
    source_path = (
        Path(__file__).resolve().parents[1]
        / "src"
        / "patches"
        / "backend"
        / "open_webui"
        / "utils"
        / "middleware.py"
    )
    source = source_path.read_text(encoding="utf-8")

    error_assignment = "tool_result = normalize_tool_execution_error(e)"
    postprocess_assignment = "tool_result, tool_result_files, tool_result_embeds = ("
    event_check = "if event_emitter:"

    assert error_assignment in source
    assert postprocess_assignment in source
    assert event_check in source

    error_index = source.index(error_assignment)
    postprocess_index = source.index(postprocess_assignment, error_index)
    event_index = source.index(event_check, postprocess_index)

    assert error_index < postprocess_index < event_index
    postprocess_line = source[:postprocess_index].splitlines()[-1]
    event_line = source[:event_index].splitlines()[-1]
    assert len(postprocess_line) - len(postprocess_line.lstrip()) == len(
        event_line
    ) - len(event_line.lstrip())


def test_system_mcp_directory_reserves_yaml_and_fragment_namespace(tmp_path):
    helpers = _load_dynamic_tool_helpers()
    system_root = tmp_path / "mcp-configs"
    user_root = tmp_path / "mcp-configs-user"
    system_dir = system_root / "collision-mcp"
    user_dir = user_root / "collision-mcp"
    system_dir.mkdir(parents=True)
    user_dir.mkdir(parents=True)
    (user_dir / "collision-mcp.yaml").write_text("name: User must not leak\n")
    (user_dir / "collision-mcp.fragment").write_text(
        json.dumps({"url": "https://user.invalid/mcp"})
    )
    helpers["MCP_CONFIGS_DIR"] = system_root
    helpers["MCP_CONFIGS_USER_DIR"] = user_root

    assert helpers["_find_mcp_yaml_path"]("collision-mcp") is None
    assert helpers["_load_server_fragment_payload"]("collision-mcp") is None

    (system_dir / "collision-mcp.yaml").write_text("name: System\n")
    (system_dir / "collision-mcp.fragment").write_text(
        json.dumps({"url": "https://system.example/mcp"})
    )
    assert helpers["_find_mcp_yaml_path"]("collision-mcp") == (
        system_dir / "collision-mcp.yaml"
    )
    assert helpers["_load_server_fragment_payload"]("collision-mcp") == {
        "url": "https://system.example/mcp"
    }
