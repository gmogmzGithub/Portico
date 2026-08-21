import ast
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse


def _load_openai_gateway_helpers():
    source_path = (
        Path(__file__).resolve().parents[1]
        / "src"
        / "patches"
        / "backend"
        / "open_webui"
        / "routers"
        / "openai.py"
    )
    module_ast = ast.parse(source_path.read_text())
    wanted_functions = {
        "_is_bifrost_gateway_mode",
        "_is_lm_studio_api_config",
        "_inject_openwebui_affinity_headers",
        "_strip_lm_studio_generated_token_limits",
        "_should_embed_metadata_in_payload",
        "_url_hostname",
        "_should_bypass_env_proxy_for_url",
        "_aiohttp_trust_env_for_url",
    }
    wanted_assignments = {
        "INTERNAL_AIOHTTP_PROXY_BYPASS_HOSTS",
    }
    selected_nodes = [
        node
        for node in module_ast.body
        if (isinstance(node, ast.FunctionDef) and node.name in wanted_functions)
        or (
            isinstance(node, ast.Assign)
            and any(
                isinstance(target, ast.Name) and target.id in wanted_assignments
                for target in node.targets
            )
        )
    ]

    namespace = {
        "Optional": Optional,
        "urlparse": urlparse,
    }
    exec(
        compile(ast.Module(body=selected_nodes, type_ignores=[]), str(source_path), "exec"),
        namespace,
    )
    return namespace


def test_bifrost_gateway_does_not_embed_metadata_in_payload():
    helpers = _load_openai_gateway_helpers()

    assert helpers["_is_bifrost_gateway_mode"]() is True
    assert helpers["_should_embed_metadata_in_payload"]() is False


def test_affinity_headers_include_chat_and_session_ids():
    helpers = _load_openai_gateway_helpers()
    inject_headers = helpers["_inject_openwebui_affinity_headers"]

    headers = inject_headers(
        {"Content-Type": "application/json"},
        {"chat_id": "chat-123", "session_id": "session-456"},
    )

    assert headers["X-OpenWebUI-Chat-Id"] == "chat-123"
    assert headers["X-OpenWebUI-Session-Id"] == "session-456"
    assert headers["Content-Type"] == "application/json"


def test_affinity_headers_include_followup_phase_and_anchor_fields():
    helpers = _load_openai_gateway_helpers()
    inject_headers = helpers["_inject_openwebui_affinity_headers"]

    headers = inject_headers(
        {"Content-Type": "application/json"},
        {
            "chat_id": "chat-123",
            "session_id": "session-456",
            "request_phase": "tool_followup",
            "followup_index": 0,
            "outer_message_id": "assistant-1",
            "trigger_message_id": "user-1",
            "transcript_anchor_kind": "assistant_tool_block",
            "transcript_anchor_message_id": "assistant-1",
            "transcript_anchor_tool_block_index": 0,
        },
    )

    assert headers["X-OpenWebUI-Request-Phase"] == "tool_followup"
    assert headers["X-OpenWebUI-Followup-Index"] == "0"
    assert headers["X-OpenWebUI-Outer-Message-Id"] == "assistant-1"
    assert headers["X-OpenWebUI-Trigger-Message-Id"] == "user-1"
    assert headers["X-OpenWebUI-Transcript-Anchor-Kind"] == "assistant_tool_block"
    assert headers["X-OpenWebUI-Transcript-Anchor-Message-Id"] == "assistant-1"
    assert headers["X-OpenWebUI-Transcript-Anchor-Tool-Block-Index"] == "0"


def test_affinity_headers_use_corrected_auxiliary_prompt_timestamp():
    helpers = _load_openai_gateway_helpers()
    inject_headers = helpers["_inject_openwebui_affinity_headers"]

    headers = inject_headers(
        {"Content-Type": "application/json"},
        {
            "chat_id": "chat-123",
            "session_id": "session-456",
            "request_phase": "auxiliary_task",
            "prompt_submitted_at_ms": 2222,
            "origin_prompt_submitted_at_ms": 1111,
            "transcript_anchor_kind": "background",
        },
    )

    assert headers["X-OpenWebUI-Request-Phase"] == "auxiliary_task"
    assert headers["X-OpenWebUI-Prompt-Submitted-At-Ms"] == "2222"
    assert headers["X-OpenWebUI-Transcript-Anchor-Kind"] == "background"
    assert "X-OpenWebUI-Origin-Prompt-Submitted-At-Ms" not in headers


def test_affinity_headers_ignore_missing_metadata():
    helpers = _load_openai_gateway_helpers()
    inject_headers = helpers["_inject_openwebui_affinity_headers"]

    headers = inject_headers({"Content-Type": "application/json"}, None)

    assert headers == {"Content-Type": "application/json"}


def test_lm_studio_api_config_detection():
    helpers = _load_openai_gateway_helpers()
    is_lm_studio_api_config = helpers["_is_lm_studio_api_config"]

    assert is_lm_studio_api_config({"portico_provider": "lm_studio"}) is True
    assert is_lm_studio_api_config({"local_provider": "lm-studio"}) is True
    assert is_lm_studio_api_config({"connection_type": "lmstudio"}) is True
    assert is_lm_studio_api_config({"portico_provider": "openai"}) is False
    assert is_lm_studio_api_config(None) is False


def test_internal_openai_gateway_urls_bypass_env_proxy():
    helpers = _load_openai_gateway_helpers()

    assert helpers["_should_bypass_env_proxy_for_url"](
        "http://llm-gateway:4000/v1/models"
    )
    assert helpers["_should_bypass_env_proxy_for_url"](
        "http://host.docker.internal:1234/v1/models"
    )
    assert not helpers["_aiohttp_trust_env_for_url"](
        "http://llm-gateway:4000/v1/chat/completions"
    )
    assert helpers["_aiohttp_trust_env_for_url"]("https://api.openai.com/v1/models")


def test_lm_studio_generated_token_limits_removed_unless_explicit_wrapper_limit():
    helpers = _load_openai_gateway_helpers()
    strip_token_limits = helpers["_strip_lm_studio_generated_token_limits"]

    payload = {
        "model": "google/gemma-4-e4b",
        "max_tokens": 128000,
        "max_completion_tokens": 128000,
        "temperature": 0.1,
    }
    strip_token_limits(payload, {})

    assert "max_tokens" not in payload
    assert "max_completion_tokens" not in payload
    assert payload["temperature"] == 0.1

    explicit_payload = {
        "model": "google/gemma-4-e4b",
        "max_tokens": 4096,
        "max_completion_tokens": 8192,
    }
    strip_token_limits(explicit_payload, {"max_tokens": 4096})

    assert explicit_payload["max_tokens"] == 4096
    assert explicit_payload["max_completion_tokens"] == 8192


def test_bifrost_gateway_source_uses_headers_not_payload_fields():
    source_path = (
        Path(__file__).resolve().parents[1]
        / "src"
        / "patches"
        / "backend"
        / "open_webui"
        / "routers"
        / "openai.py"
    )
    source = source_path.read_text()

    assert "_inject_openwebui_affinity_fields" not in source
    assert '"X-OpenWebUI-Chat-Id"' in source
    assert '"X-OpenWebUI-Session-Id"' in source
    assert '"X-OpenWebUI-Request-Phase"' in source
    assert '"X-OpenWebUI-Followup-Index"' in source
    assert '"X-OpenWebUI-Outer-Message-Id"' in source
