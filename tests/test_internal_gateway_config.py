from copy import deepcopy
import importlib.util
from pathlib import Path
import sys

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = (
    REPO_ROOT
    / "src"
    / "patches"
    / "backend"
    / "open_webui"
    / "utils"
    / "internal_gateway_config.py"
)
MAIN_PATH = (
    REPO_ROOT
    / "src"
    / "patches"
    / "backend"
    / "open_webui"
    / "main.py"
)

SPEC = importlib.util.spec_from_file_location("internal_gateway_config", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

InternalGatewayConfigError = MODULE.InternalGatewayConfigError
reconcile_internal_gateway_config = MODULE.reconcile_internal_gateway_config


INTERNAL_URL = "http://llm-gateway:4000/v1"
RUNTIME_KEY = "sk-runtime-current"


def test_rotated_runtime_key_replaces_only_the_app_owned_gateway_key():
    urls = [INTERNAL_URL, "http://host.docker.internal:1234/v1"]
    keys = ["sk-persisted-stale", "lm-studio-key"]
    configs = {
        "0": {"tags": [{"name": "Portico Models"}], "auth_type": "none"},
        "1": {
            "enable": False,
            "connection_type": "local",
            "portico_provider": "lm_studio",
            "model_ids": ["local-model"],
        },
    }
    original_urls = deepcopy(urls)
    original_keys = deepcopy(keys)
    original_configs = deepcopy(configs)

    result = reconcile_internal_gateway_config(
        urls,
        keys,
        configs,
        runtime_base_url=INTERNAL_URL,
        runtime_api_key=RUNTIME_KEY,
    )

    assert result.changed is True
    assert result.base_urls == original_urls
    assert result.api_keys == [RUNTIME_KEY, "lm-studio-key"]
    assert result.api_configs["0"] == {
        "tags": [{"name": "Portico Models"}],
        "enable": True,
        "auth_type": "bearer",
        "model_ids": [],
    }
    assert result.api_configs["1"] == original_configs["1"]
    assert urls == original_urls
    assert keys == original_keys
    assert configs == original_configs


def test_matching_runtime_configuration_does_not_request_persistence():
    urls = [INTERNAL_URL]
    keys = [RUNTIME_KEY]
    configs = {
        "0": {
            "enable": True,
            "auth_type": "bearer",
            "model_ids": [],
        }
    }

    result = reconcile_internal_gateway_config(
        urls,
        keys,
        configs,
        runtime_base_url=f" {INTERNAL_URL}/ ",
        runtime_api_key=f" {RUNTIME_KEY} ",
    )

    assert result.changed is False
    assert result.base_urls == urls
    assert result.api_keys == keys
    assert result.api_configs == configs


def test_missing_internal_gateway_is_prepended_and_user_connections_are_reindexed():
    lm_studio_config = {
        "enable": False,
        "connection_type": "local",
        "portico_provider": "lm_studio",
        "model_ids": [],
    }

    result = reconcile_internal_gateway_config(
        ["http://host.docker.internal:1234/v1"],
        ["lm-studio-key"],
        {
            "0": lm_studio_config,
            "http://legacy-provider.example/v1": {"enable": False},
        },
        runtime_base_url=INTERNAL_URL,
        runtime_api_key=RUNTIME_KEY,
    )

    assert result.changed is True
    assert result.base_urls == [
        INTERNAL_URL,
        "http://host.docker.internal:1234/v1",
    ]
    assert result.api_keys == [RUNTIME_KEY, "lm-studio-key"]
    assert result.api_configs["0"] == {
        "enable": True,
        "auth_type": "bearer",
        "model_ids": [],
    }
    assert result.api_configs["1"] == lm_studio_config
    assert result.api_configs["http://legacy-provider.example/v1"] == {
        "enable": False
    }


@pytest.mark.parametrize(
    ("runtime_base_url", "runtime_api_key", "expected_name"),
    [
        ("", RUNTIME_KEY, "OPENAI_API_BASE_URL"),
        (INTERNAL_URL, "", "OPENAI_API_KEY"),
    ],
)
def test_missing_runtime_gateway_inputs_fail_closed(
    runtime_base_url, runtime_api_key, expected_name
):
    with pytest.raises(InternalGatewayConfigError, match=expected_name):
        reconcile_internal_gateway_config(
            [],
            [],
            {},
            runtime_base_url=runtime_base_url,
            runtime_api_key=runtime_api_key,
        )


def test_backend_reconciles_runtime_gateway_before_initializing_model_state():
    source = MAIN_PATH.read_text()
    registration = source.index(
        "app.state.config.OPENAI_API_CONFIGS = OPENAI_API_CONFIGS"
    )
    reconciliation_call = source.index(
        "reconcile_app_owned_openai_gateway()", registration
    )
    model_state_initialization = source.index(
        "app.state.OPENAI_MODELS = {}", reconciliation_call
    )

    assert registration < reconciliation_call < model_state_initialization
    assert 'runtime_base_url=os.environ.get("OPENAI_API_BASE_URL", "")' in source
    assert 'runtime_api_key=os.environ.get("OPENAI_API_KEY", "")' in source
    assert "Invalid app-owned LLM gateway configuration" in source
    assert "runtime ingress" in source
