import ast
import os
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import pytest


def _load_openai_capability_helpers():
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
        "_url_hostname",
        "_is_internal_gateway_multimodal_input_disabled",
        "_is_gateway_multimodal_capable_model",
        "_apply_internal_gateway_capability_overrides",
    }
    wanted_assignments = {
        "LLM_GATEWAY_MULTIMODAL_INPUT_ENV",
        "_ENV_FALSE_VALUES",
        "_INTERNAL_LLM_GATEWAY_HOSTNAMES",
        "_GATEWAY_MULTIMODAL_CAPABLE_FAMILY_NEEDLES",
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
        "os": os,
        "urlparse": urlparse,
    }
    exec(
        compile(ast.Module(body=selected_nodes, type_ignores=[]), str(source_path), "exec"),
        namespace,
    )
    return namespace


HELPERS = _load_openai_capability_helpers()
ENV_NAME = HELPERS["LLM_GATEWAY_MULTIMODAL_INPUT_ENV"]
_apply_overrides = HELPERS["_apply_internal_gateway_capability_overrides"]


INTERNAL_GATEWAY_URL = "http://llm-gateway:4000/v1"


def _gateway_model(model_id="GPT-5.6 Sol"):
    return {
        "id": model_id,
        "name": model_id,
        "owned_by": "openai",
        "connection_type": "external",
        "urlIdx": 0,
    }


def test_models_untouched_when_env_unset(monkeypatch):
    monkeypatch.delenv(ENV_NAME, raising=False)

    model = _apply_overrides(_gateway_model(), INTERNAL_GATEWAY_URL)

    assert "info" not in model


def test_models_untouched_when_multimodal_input_enabled(monkeypatch):
    monkeypatch.setenv(ENV_NAME, "true")

    model = _apply_overrides(_gateway_model(), INTERNAL_GATEWAY_URL)

    assert "info" not in model


@pytest.mark.parametrize("env_value", ["false", "FALSE", " 0 ", "no", "off"])
def test_internal_gateway_models_advertise_vision_disabled(monkeypatch, env_value):
    monkeypatch.setenv(ENV_NAME, env_value)

    model = _apply_overrides(_gateway_model(), INTERNAL_GATEWAY_URL)

    assert model["info"] == {"meta": {"capabilities": {"vision": False}}}


@pytest.mark.parametrize(
    "model_id",
    ["GPT-5.6 Sol", "GPT-5.6 Terra", "GPT-5.5", "Gemini 3.5 Flash", "Gemini 3.1 Flash-Lite"],
)
def test_blocked_route_families_advertise_vision_disabled(monkeypatch, model_id):
    """The Jupiter proxy rejects multimodal input on its OpenAI and Gemini
    routes, so those families must not advertise vision."""
    monkeypatch.setenv(ENV_NAME, "false")

    model = _apply_overrides(_gateway_model(model_id), INTERNAL_GATEWAY_URL)

    assert model["info"] == {"meta": {"capabilities": {"vision": False}}}


@pytest.mark.parametrize(
    "model_id",
    ["Claude Sonnet 5", "Claude Opus 4.8", "Claude Haiku 4.5"],
)
def test_claude_models_keep_vision_on_bedrock_route(monkeypatch, model_id):
    """The Jupiter proxy accepts image blocks on its Bedrock/Claude route
    (verified empirically), so Claude models keep working vision even when
    gateway multimodal input is disabled."""
    monkeypatch.setenv(ENV_NAME, "false")

    model = _apply_overrides(_gateway_model(model_id), INTERNAL_GATEWAY_URL)

    assert "info" not in model


@pytest.mark.parametrize(
    "base_url",
    [
        "http://llm-gateway:4000/v1",
        "http://litellm:4000/v1",
        "http://bifrost:4000/v1",
    ],
)
def test_all_internal_gateway_hostnames_are_covered(monkeypatch, base_url):
    monkeypatch.setenv(ENV_NAME, "false")

    model = _apply_overrides(_gateway_model(), base_url)

    assert model["info"]["meta"]["capabilities"]["vision"] is False


@pytest.mark.parametrize(
    "base_url",
    [
        "http://host.docker.internal:1234/v1",
        "https://api.openai.com/v1",
        "",
    ],
)
def test_user_added_connections_are_untouched(monkeypatch, base_url):
    monkeypatch.setenv(ENV_NAME, "false")

    model = _apply_overrides(_gateway_model(), base_url)

    assert "info" not in model


def test_existing_model_info_is_preserved(monkeypatch):
    monkeypatch.setenv(ENV_NAME, "false")
    model = _gateway_model()
    model["info"] = {"meta": {"capabilities": {"vision": True}}}

    result = _apply_overrides(model, INTERNAL_GATEWAY_URL)

    assert result["info"] == {"meta": {"capabilities": {"vision": True}}}
