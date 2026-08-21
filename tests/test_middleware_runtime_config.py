import ast
import asyncio
import os
from pathlib import Path
from typing import Any, Optional


MIDDLEWARE_PATH = (
    Path(__file__).resolve().parents[1]
    / "src"
    / "patches"
    / "backend"
    / "open_webui"
    / "utils"
    / "middleware.py"
)


class _FakeLog:
    def info(self, *args, **kwargs):
        return None

    def warning(self, *args, **kwargs):
        return None


def _load_runtime_helpers():
    source = MIDDLEWARE_PATH.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(MIDDLEWARE_PATH))
    wanted_names = {
        "_positive_int_from_env",
        "_float_env",
        "_ensure_llm_debug_event_publisher_available",
        "_should_publish_bifrost_debug_response",
        "_is_openai_prompt_cache_tool_model",
        "_is_gpt5_responses_api_model",
        "_get_gpt_openai_route_mode",
        "_get_transient_chat_completion_retry_max_attempts",
        "_get_transient_tool_execution_retry_max_attempts",
        "_get_direct_tool_event_call_timeout_seconds",
        "_call_direct_tool_event",
        "_GPT_OPENAI_ROUTE_MODE_ENV",
        "_GPT_OPENAI_ROUTE_MODE_DIRECT",
        "_GPT_OPENAI_ROUTE_MODE_BIFROST",
        "_TRANSIENT_CHAT_COMPLETION_RETRY_MAX_ATTEMPTS",
        "_TRANSIENT_TOOL_EXECUTION_RETRY_MAX_ATTEMPTS",
        "_DIRECT_TOOL_EVENT_CALL_TIMEOUT_ENV",
        "_DEFAULT_DIRECT_TOOL_EVENT_CALL_TIMEOUT_SECONDS",
        "_DIRECT_TOOL_EVENT_NO_TIMEOUT_PATTERNS_ENV",
        "_DEFAULT_DIRECT_TOOL_EVENT_NO_TIMEOUT_PATTERNS",
    }
    selected_nodes = []
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id in wanted_names:
                    selected_nodes.append(node)
                    break
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in wanted_names:
            selected_nodes.append(node)

    namespace = {
        "Any": Any,
        "Optional": Optional,
        "LLM_DEBUG_MONITOR_GATEWAY_EVENTS_ENABLED": True,
        "LLM_DEBUG_EVENT_PUBLISHER_AVAILABLE": True,
        "_publish_error_impl": object(),
        "_publish_response_complete_impl": object(),
        "_optimization_flag_enabled": lambda flag_name, default=True: default,
        "log": _FakeLog(),
        "asyncio": asyncio,
        "os": os,
    }
    exec(
        compile(ast.Module(body=selected_nodes, type_ignores=[]), str(MIDDLEWARE_PATH), "exec"),
        namespace,
    )
    return namespace


def test_positive_int_and_float_env_helpers_handle_missing_invalid_and_valid_values(monkeypatch):
    helpers = _load_runtime_helpers()
    positive_int = helpers["_positive_int_from_env"]
    float_env = helpers["_float_env"]

    monkeypatch.delenv("OWUI_TEST_INT", raising=False)
    monkeypatch.delenv("OWUI_TEST_FLOAT", raising=False)
    assert positive_int("OWUI_TEST_INT", 7) == 7
    assert float_env("OWUI_TEST_FLOAT", 1.25) == 1.25

    monkeypatch.setenv("OWUI_TEST_INT", "11")
    monkeypatch.setenv("OWUI_TEST_FLOAT", "2.5")
    assert positive_int("OWUI_TEST_INT", 7) == 11
    assert float_env("OWUI_TEST_FLOAT", 1.25) == 2.5

    monkeypatch.setenv("OWUI_TEST_INT", "0")
    monkeypatch.setenv("OWUI_TEST_FLOAT", "bad")
    assert positive_int("OWUI_TEST_INT", 7) == 7
    assert float_env("OWUI_TEST_FLOAT", 1.25) == 1.25


def test_should_publish_bifrost_debug_response_requires_flags_and_ids():
    helpers = _load_runtime_helpers()
    should_publish = helpers["_should_publish_bifrost_debug_response"]

    assert should_publish({"session_id": "session-1", "chat_id": "chat-1"}) is True
    assert should_publish({"session_id": "session-1"}) is False
    assert should_publish({"chat_id": "chat-1"}) is False
    assert should_publish(None) is False

    helpers["LLM_DEBUG_MONITOR_GATEWAY_EVENTS_ENABLED"] = False
    assert should_publish({"session_id": "session-1", "chat_id": "chat-1"}) is False

    helpers["LLM_DEBUG_MONITOR_GATEWAY_EVENTS_ENABLED"] = True
    helpers["LLM_DEBUG_EVENT_PUBLISHER_AVAILABLE"] = False
    helpers["_publish_error_impl"] = None
    helpers["_publish_response_complete_impl"] = None
    assert should_publish({"session_id": "session-1", "chat_id": "chat-1"}) is True


def test_openai_model_routing_helpers_identify_supported_gpt_variants(monkeypatch):
    helpers = _load_runtime_helpers()
    is_prompt_cache_tool_model = helpers["_is_openai_prompt_cache_tool_model"]
    is_gpt5_responses_api_model = helpers["_is_gpt5_responses_api_model"]
    get_route_mode = helpers["_get_gpt_openai_route_mode"]

    assert is_prompt_cache_tool_model("GPT-5.5") is True
    assert is_prompt_cache_tool_model("GPT-5.4") is True
    assert is_prompt_cache_tool_model(" gpt-4.1-mini ") is True
    assert is_prompt_cache_tool_model("gpt-5.4-pro") is False
    assert is_prompt_cache_tool_model("Atlas Opus 4.6") is False

    assert is_gpt5_responses_api_model("gpt-5") is True
    assert is_gpt5_responses_api_model("GPT-5.5") is True
    assert is_gpt5_responses_api_model("GPT-5.4") is True
    assert is_gpt5_responses_api_model("GPT-4.1") is False

    env_name = helpers["_GPT_OPENAI_ROUTE_MODE_ENV"]
    monkeypatch.delenv(env_name, raising=False)
    assert get_route_mode() == helpers["_GPT_OPENAI_ROUTE_MODE_DIRECT"]

    monkeypatch.setenv(env_name, "bifrost")
    assert get_route_mode() == helpers["_GPT_OPENAI_ROUTE_MODE_BIFROST"]

    monkeypatch.setenv(env_name, "garbage")
    assert get_route_mode() == helpers["_GPT_OPENAI_ROUTE_MODE_DIRECT"]


def test_retry_attempt_helpers_use_env_defaults_and_optimization_flag(monkeypatch):
    helpers = _load_runtime_helpers()
    get_chat_attempts = helpers["_get_transient_chat_completion_retry_max_attempts"]
    get_tool_attempts = helpers["_get_transient_tool_execution_retry_max_attempts"]

    monkeypatch.delenv("OPENWEBUI_TRANSIENT_CHAT_COMPLETION_RETRY_MAX_ATTEMPTS", raising=False)
    monkeypatch.delenv("OPENWEBUI_TRANSIENT_TOOL_EXECUTION_RETRY_MAX_ATTEMPTS", raising=False)

    assert get_chat_attempts() == helpers["_TRANSIENT_CHAT_COMPLETION_RETRY_MAX_ATTEMPTS"]
    assert get_tool_attempts() == helpers["_TRANSIENT_TOOL_EXECUTION_RETRY_MAX_ATTEMPTS"]

    monkeypatch.setenv("OPENWEBUI_TRANSIENT_CHAT_COMPLETION_RETRY_MAX_ATTEMPTS", "6")
    monkeypatch.setenv("OPENWEBUI_TRANSIENT_TOOL_EXECUTION_RETRY_MAX_ATTEMPTS", "5")
    assert get_chat_attempts() == 6
    assert get_tool_attempts() == 5

    helpers["_optimization_flag_enabled"] = lambda flag_name, default=True: False
    assert get_tool_attempts() == 1


def test_direct_tool_event_timeout_uses_default_for_invalid_or_non_positive_values(monkeypatch):
    helpers = _load_runtime_helpers()
    get_timeout = helpers["_get_direct_tool_event_call_timeout_seconds"]
    env_name = helpers["_DIRECT_TOOL_EVENT_CALL_TIMEOUT_ENV"]
    default_timeout = helpers["_DEFAULT_DIRECT_TOOL_EVENT_CALL_TIMEOUT_SECONDS"]

    monkeypatch.delenv(env_name, raising=False)
    assert get_timeout() == default_timeout

    monkeypatch.setenv(env_name, "45.5")
    assert get_timeout() == 45.5

    monkeypatch.setenv(env_name, "0")
    assert get_timeout() == default_timeout

    monkeypatch.setenv(env_name, "not-a-number")
    assert get_timeout() == default_timeout


def test_run_subagent_direct_tool_event_keeps_no_timeout_exemption(monkeypatch):
    helpers = _load_runtime_helpers()
    call_direct_tool_event = helpers["_call_direct_tool_event"]
    timeout_env = helpers["_DIRECT_TOOL_EVENT_CALL_TIMEOUT_ENV"]
    no_timeout_env = helpers["_DIRECT_TOOL_EVENT_NO_TIMEOUT_PATTERNS_ENV"]

    monkeypatch.setenv(timeout_env, "0.001")
    monkeypatch.delenv(no_timeout_env, raising=False)

    async def slow_callback(payload):
        await asyncio.sleep(0.01)
        return payload["result"]

    result = asyncio.run(
        call_direct_tool_event(
            slow_callback,
            {"result": "completed"},
            "subagents_run_subagent",
        )
    )
    assert result == "completed"
