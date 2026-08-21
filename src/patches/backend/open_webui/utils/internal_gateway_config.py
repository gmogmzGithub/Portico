from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from typing import Any, Mapping, Sequence


class InternalGatewayConfigError(RuntimeError):
    """Raised when the app-owned OpenAI-compatible gateway is not configured."""


@dataclass(frozen=True)
class ReconciledInternalGatewayConfig:
    base_urls: list[str]
    api_keys: list[str]
    api_configs: dict[str, Any]
    changed: bool


def _normalize_url(value: Any) -> str:
    return str(value or "").strip().rstrip("/")


def _copy_api_configs(api_configs: Mapping[str, Any] | None) -> dict[str, Any]:
    return {
        str(key): deepcopy(value)
        for key, value in dict(api_configs or {}).items()
    }


def _remap_numeric_configs(
    api_configs: Mapping[str, Any],
    index_map: Mapping[int, int],
    *,
    unmatched_numeric_offset: int = 0,
) -> dict[str, Any]:
    remapped: dict[str, Any] = {}

    for raw_key, value in api_configs.items():
        key = str(raw_key)
        try:
            old_index = int(key)
        except ValueError:
            remapped[key] = deepcopy(value)
            continue

        new_index = index_map.get(old_index, old_index + unmatched_numeric_offset)
        remapped[str(new_index)] = deepcopy(value)

    return remapped


def reconcile_internal_gateway_config(
    base_urls: Sequence[Any] | None,
    api_keys: Sequence[Any] | None,
    api_configs: Mapping[str, Any] | None,
    *,
    runtime_base_url: str,
    runtime_api_key: str,
) -> ReconciledInternalGatewayConfig:
    """Make the runtime secret authoritative for the app-owned gateway.

    Open WebUI persists OpenAI connection credentials in its database. That is
    useful for user-managed providers, but an app-local bridge key can rotate
    independently. Reconcile only the connection matching the runtime gateway
    URL and preserve every unrelated connection and its indexed configuration.
    """

    internal_url = _normalize_url(runtime_base_url)
    if not internal_url:
        raise InternalGatewayConfigError(
            "OPENAI_API_BASE_URL is required for the app-owned LLM gateway"
        )

    internal_key = str(runtime_api_key or "").strip()
    if not internal_key:
        raise InternalGatewayConfigError(
            "OPENAI_API_KEY is required for the app-owned LLM gateway"
        )

    original_urls = list(base_urls or [])
    original_keys = list(api_keys or [])
    original_configs = _copy_api_configs(api_configs)

    urls = [str(value or "").strip() for value in original_urls]
    keys = [str(value or "") for value in original_keys]
    configs = _copy_api_configs(api_configs)

    if len(keys) < len(urls):
        keys.extend([""] * (len(urls) - len(keys)))
    elif len(keys) > len(urls):
        keys = keys[: len(urls)]

    matching_indexes = [
        index for index, url in enumerate(urls) if _normalize_url(url) == internal_url
    ]

    if matching_indexes:
        retained_internal_index = matching_indexes[0]
        duplicate_internal_indexes = set(matching_indexes[1:])
        index_map: dict[int, int] = {}
        reconciled_urls: list[str] = []
        reconciled_keys: list[str] = []

        for old_index, url in enumerate(urls):
            if old_index in duplicate_internal_indexes:
                continue

            new_index = len(reconciled_urls)
            index_map[old_index] = new_index
            if old_index == retained_internal_index:
                reconciled_urls.append(internal_url)
                reconciled_keys.append(internal_key)
            else:
                reconciled_urls.append(url)
                reconciled_keys.append(keys[old_index])

        urls = reconciled_urls
        keys = reconciled_keys
        configs = _remap_numeric_configs(configs, index_map)
        internal_index = index_map[retained_internal_index]
    else:
        index_map = {old_index: old_index + 1 for old_index in range(len(urls))}
        urls = [internal_url, *urls]
        keys = [internal_key, *keys]
        configs = _remap_numeric_configs(
            configs,
            index_map,
            unmatched_numeric_offset=1,
        )
        internal_index = 0

    internal_config_value = configs.get(str(internal_index), {})
    internal_config = (
        deepcopy(dict(internal_config_value))
        if isinstance(internal_config_value, Mapping)
        else {}
    )
    internal_config.update(
        {
            "enable": True,
            "auth_type": "bearer",
            "model_ids": [],
        }
    )
    configs[str(internal_index)] = internal_config

    changed = (
        urls != original_urls
        or keys != original_keys
        or configs != original_configs
    )

    return ReconciledInternalGatewayConfig(
        base_urls=urls,
        api_keys=keys,
        api_configs=configs,
        changed=changed,
    )
