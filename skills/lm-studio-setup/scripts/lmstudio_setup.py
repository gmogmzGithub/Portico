#!/usr/bin/env python3
"""LM Studio setup helper.

Stdlib-only script used by the LM Studio Setup skill through Agent VM.
It prints compact JSON to stdout and sends diagnostics to stderr only.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


DEFAULT_BASE_URL = "http://host.docker.internal:1234"
CONTEXT_RETRY_LADDER = [131072, 65536, 32768, 16384, 8192]
FAMILY_CONTEXT_FALLBACKS = {
    "gemma-4": 131072,
    "gemma4": 131072,
    "gemma-3": 131072,
    "qwen3": 131072,
    "qwen-3": 131072,
    "llama-4": 131072,
    "llama4": 131072,
    "llama-3.3": 131072,
    "mistral-small": 32768,
}
EMBEDDING_TERMS = ("embedding", "text-embedding", "embed", "rerank", "ranker")


class HttpError(RuntimeError):
    def __init__(self, message: str, status: int | None = None, body: str | None = None):
        super().__init__(message)
        self.status = status
        self.body = body or ""


def compact_dump(payload: Any) -> None:
    print(json.dumps(payload, sort_keys=True, separators=(",", ":")))


def normalize_base_url(value: str) -> str:
    url = (value or DEFAULT_BASE_URL).strip().rstrip("/")
    for suffix in ("/api/v1", "/v1"):
        if url.endswith(suffix):
            return url[: -len(suffix)]
    return url


def api_url(base_url: str, path: str) -> str:
    return f"{normalize_base_url(base_url)}/api/v1/{path.lstrip('/')}"


def http_json(
    method: str,
    url: str,
    payload: Any | None = None,
    timeout: float = 30.0,
) -> Any:
    body = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=body, method=method.upper(), headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        raise HttpError(
            f"{method.upper()} {url} returned HTTP {error.code}",
            status=error.code,
            body=raw,
        ) from error
    except urllib.error.URLError as error:
        raise HttpError(f"{method.upper()} {url} failed: {error.reason}") from error

    if not raw.strip():
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError as error:
        raise HttpError(f"{method.upper()} {url} returned non-JSON response", body=raw) from error


def as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def model_entries(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if not isinstance(payload, dict):
        return []
    for key in ("data", "models", "items"):
        value = payload.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    return []


def string_at(value: Any, path: tuple[str, ...]) -> str | None:
    current = value
    for segment in path:
        if not isinstance(current, dict):
            return None
        current = current.get(segment)
    return current if isinstance(current, str) else None


def int_value(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        cleaned = value.strip().replace(",", "")
        if cleaned.isdigit():
            return int(cleaned)
    return None


def int_at(value: dict[str, Any], paths: list[tuple[str, ...]]) -> int | None:
    for path in paths:
        current: Any = value
        for segment in path:
            if not isinstance(current, dict):
                current = None
                break
            current = current.get(segment)
        result = int_value(current)
        if result is not None and result > 0:
            return result
    return None


def model_id(model: dict[str, Any]) -> str | None:
    for key in ("id", "model_key", "key", "name", "path"):
        value = model.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def model_text_haystack(model: dict[str, Any]) -> str:
    values: list[str] = []
    for path in (
        ("id",),
        ("name",),
        ("type",),
        ("object",),
        ("model_type",),
        ("task",),
        ("pipeline_tag",),
        ("architecture",),
        ("capabilities", "type"),
        ("metadata", "type"),
        ("metadata", "model_type"),
        ("metadata", "task"),
    ):
        value = string_at(model, path)
        if value:
            values.append(value)
    capabilities = model.get("capabilities")
    if isinstance(capabilities, list):
        values.extend(str(item) for item in capabilities)
    return " ".join(values).lower()


def is_embedding_model(model: dict[str, Any]) -> bool:
    haystack = model_text_haystack(model)
    return any(term in haystack for term in EMBEDDING_TERMS)


def loaded_instances(model: dict[str, Any]) -> list[dict[str, Any]]:
    instances = model.get("loaded_instances")
    if isinstance(instances, list):
        return [item for item in instances if isinstance(item, dict)]
    instances = model.get("instances")
    if isinstance(instances, list):
        return [item for item in instances if isinstance(item, dict)]
    if model.get("loaded") is True or str(model.get("state", "")).lower() == "loaded":
        return [{"config": model.get("config", {}) if isinstance(model.get("config"), dict) else {}}]
    return []


def loaded_instance_ids(model: dict[str, Any]) -> list[str]:
    ids: list[str] = []
    for instance in loaded_instances(model):
        for key in ("id", "instance_id"):
            value = instance.get(key)
            if isinstance(value, str) and value.strip():
                ids.append(value.strip())
                break
    if not ids and loaded_instances(model):
        key = model_id(model)
        if key:
            ids.append(key)
    return ids


def max_context_length(model: dict[str, Any]) -> int | None:
    return int_at(
        model,
        [
            ("max_context_length",),
            ("max_context_tokens",),
            ("context_length",),
            ("metadata", "max_context_length"),
            ("metadata", "max_context_tokens"),
            ("defaults", "context_length"),
        ],
    )


def loaded_context_length(model: dict[str, Any]) -> int | None:
    for instance in loaded_instances(model):
        value = int_at(
            instance,
            [
                ("config", "context_length"),
                ("config", "contextLength"),
                ("load_config", "context_length"),
                ("context_length",),
            ],
        )
        if value:
            return value
    return None


def family_context_fallback(model_key: str) -> int | None:
    normalized = model_key.lower().replace("/", "-").replace("_", "-")
    for family, context in FAMILY_CONTEXT_FALLBACKS.items():
        if family in normalized:
            return context
    return None


def context_candidates(model: dict[str, Any], requested: int | None = None) -> list[int]:
    model_key = model_id(model) or ""
    max_context = max_context_length(model) or family_context_fallback(model_key)
    initial = requested or max_context or 32768
    candidates = [initial, *CONTEXT_RETRY_LADDER]
    result: list[int] = []
    seen: set[int] = set()
    for candidate in candidates:
        if candidate is None:
            continue
        value = int(candidate)
        if max_context:
            value = min(value, max_context)
        if value > 0 and value not in seen:
            result.append(value)
            seen.add(value)
    return result or [8192]


def summarize_model(model: dict[str, Any]) -> dict[str, Any]:
    key = model_id(model) or ""
    instances = loaded_instances(model)
    return {
        "id": key,
        "loaded": bool(instances),
        "loaded_instance_ids": loaded_instance_ids(model),
        "loaded_context_length": loaded_context_length(model),
        "max_context_length": max_context_length(model),
        "quantization": model.get("quantization") or model.get("quant") or string_at(model, ("metadata", "quantization")),
        "size_bytes": int_at(model, [("size_bytes",), ("file_size",), ("size",), ("metadata", "size_bytes")]),
        "capabilities": model.get("capabilities", []),
    }


def choose_best_model(models: list[dict[str, Any]]) -> dict[str, Any] | None:
    chat_models = [model for model in models if model_id(model) and not is_embedding_model(model)]
    if not chat_models:
        return None

    def rank(model: dict[str, Any]) -> tuple[int, int, int, str]:
        key = (model_id(model) or "").lower()
        preferred_family = int(
            any(term in key for term in ("gemma", "qwen", "llama", "mistral", "deepseek"))
        )
        size = int_at(model, [("size_bytes",), ("file_size",), ("size",)]) or 0
        return (int(bool(loaded_instances(model))), preferred_family, -size, key)

    return sorted(chat_models, key=rank, reverse=True)[0]


def inspect_models(base_url: str) -> dict[str, Any]:
    payload = http_json("GET", api_url(base_url, "/models"), timeout=10.0)
    entries = model_entries(payload)
    downloaded_llms = [model for model in entries if model_id(model) and not is_embedding_model(model)]
    loaded_llms = [model for model in downloaded_llms if loaded_instances(model)]
    embedding_model_ids = [
        model_id(model)
        for model in entries
        if model_id(model) and is_embedding_model(model)
    ]
    best = choose_best_model(downloaded_llms)
    return {
        "base_url": normalize_base_url(base_url),
        "downloaded_llms": [summarize_model(model) for model in downloaded_llms],
        "loaded_llms": [summarize_model(model) for model in loaded_llms],
        "embedding_model_ids": embedding_model_ids,
        "best_model_id": model_id(best) if best else None,
    }


def raw_chat_models(base_url: str) -> list[dict[str, Any]]:
    payload = http_json("GET", api_url(base_url, "/models"), timeout=10.0)
    return [
        model
        for model in model_entries(payload)
        if model_id(model) and not is_embedding_model(model)
    ]


def probe_server(base_url: str) -> dict[str, Any]:
    normalized = normalize_base_url(base_url)
    try:
        payload = http_json("GET", api_url(normalized, "/models"), timeout=5.0)
        entries = model_entries(payload)
        chat_models = [
            model_id(model)
            for model in entries
            if model_id(model) and not is_embedding_model(model)
        ]
        return {
            "ok": True,
            "reachable": True,
            "base_url": normalized,
            "model_count": len(entries),
            "chat_model_count": len(chat_models),
            "chat_model_ids": chat_models[:10],
        }
    except Exception as error:
        return {
            "ok": True,
            "reachable": False,
            "base_url": normalized,
            "error": str(error),
        }


def unload_instances(base_url: str, model: dict[str, Any]) -> list[dict[str, Any]]:
    unloaded = []
    for instance_id in loaded_instance_ids(model):
        response = http_json(
            "POST",
            api_url(base_url, "/models/unload"),
            {"instance_id": instance_id},
            timeout=30.0,
        )
        unloaded.append({"instance_id": instance_id, "response": response})
    return unloaded


def load_model(base_url: str, model_key: str | None, requested_context: int | None) -> dict[str, Any]:
    downloaded_llms = raw_chat_models(base_url)
    models_by_id = {
        model_id(model): model
        for model in downloaded_llms
        if model_id(model)
    }
    if not model_key:
        best_model = choose_best_model(downloaded_llms)
        model_key = model_id(best_model) if best_model else None
    if not model_key:
        raise RuntimeError("No downloaded chat-capable LM Studio model was found")
    source_model = models_by_id.get(model_key, {"id": model_key})
    attempts = context_candidates(source_model, requested_context)
    target_context_length = attempts[0]
    current_context_length = loaded_context_length(source_model)
    current_instance_ids = loaded_instance_ids(source_model)
    if (
        current_context_length
        and current_context_length >= target_context_length
        and current_instance_ids
    ):
        return {
            "model_id": model_key,
            "loaded": True,
            "already_loaded": True,
            "reloaded": False,
            "target_context_length": target_context_length,
            "requested_context_length": current_context_length,
            "attempted_context_lengths": [],
            "loaded_context_length": current_context_length,
            "unloaded_instances": [],
            "response": None,
        }

    unloaded_instances = unload_instances(base_url, source_model) if current_instance_ids else []
    errors = []
    last_response: Any = None
    for context_length in attempts:
        payload = {
            "model": model_key,
            "context_length": context_length,
            "echo_load_config": True,
            "flash_attention": True,
            "offload_kv_cache_to_gpu": True,
        }
        try:
            last_response = http_json("POST", api_url(base_url, "/models/load"), payload, timeout=120.0)
            refreshed = inspect_models(base_url)
            loaded = next(
                (model for model in refreshed["loaded_llms"] if model.get("id") == model_key),
                None,
            )
            return {
                "model_id": model_key,
                "loaded": True,
                "already_loaded": False,
                "reloaded": bool(unloaded_instances),
                "target_context_length": target_context_length,
                "requested_context_length": context_length,
                "attempted_context_lengths": attempts,
                "loaded_context_length": (loaded or {}).get("loaded_context_length") or context_length,
                "unloaded_instances": unloaded_instances,
                "response": last_response,
            }
        except HttpError as error:
            errors.append(
                {
                    "context_length": context_length,
                    "status": error.status,
                    "message": str(error),
                    "body": error.body[:500],
                }
            )
    return {
        "model_id": model_key,
        "loaded": False,
        "already_loaded": False,
        "reloaded": bool(unloaded_instances),
        "target_context_length": target_context_length,
        "attempted_context_lengths": attempts,
        "errors": errors,
        "unloaded_instances": unloaded_instances,
        "last_response": last_response,
    }


def start_download(base_url: str, model_key: str) -> dict[str, Any]:
    response = http_json(
        "POST",
        api_url(base_url, "/models/download"),
        {"model_key": model_key},
        timeout=30.0,
    )
    return {"model_id": model_key, "response": response}


def download_status(base_url: str, job_id: str, poll: bool, interval: float, timeout: float) -> dict[str, Any]:
    deadline = time.time() + timeout
    attempts = 0
    last: Any = None
    while True:
        attempts += 1
        encoded = urllib.parse.quote(job_id, safe="")
        last = http_json("GET", api_url(base_url, f"/models/download/status/{encoded}"), timeout=20.0)
        status_text = str(
            last.get("status") if isinstance(last, dict) else ""
        ).lower()
        done = status_text in {"completed", "complete", "downloaded", "success", "succeeded", "failed", "error"}
        if not poll or done or time.time() >= deadline:
            return {"job_id": job_id, "attempts": attempts, "response": last}
        time.sleep(interval)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Inspect and manage LM Studio setup")
    subparsers = parser.add_subparsers(dest="command", required=True)

    def add_base(subparser: argparse.ArgumentParser) -> None:
        subparser.add_argument("--base-url", default=DEFAULT_BASE_URL)

    inspect_parser = subparsers.add_parser("inspect")
    add_base(inspect_parser)

    probe_parser = subparsers.add_parser("probe")
    add_base(probe_parser)

    load_parser = subparsers.add_parser("load")
    add_base(load_parser)
    load_parser.add_argument("--model-key")
    load_parser.add_argument("--context-length", type=int)

    download_parser = subparsers.add_parser("download")
    add_base(download_parser)
    download_parser.add_argument("--model-key", required=True)

    status_parser = subparsers.add_parser("download-status")
    add_base(status_parser)
    status_parser.add_argument("--job-id", required=True)
    status_parser.add_argument("--poll", action="store_true")
    status_parser.add_argument("--interval", type=float, default=5.0)
    status_parser.add_argument("--timeout", type=float, default=3600.0)

    args = parser.parse_args(argv)
    try:
        if args.command == "probe":
            compact_dump(probe_server(args.base_url))
        elif args.command == "inspect":
            compact_dump(inspect_models(args.base_url))
        elif args.command == "load":
            compact_dump(load_model(args.base_url, args.model_key, args.context_length))
        elif args.command == "download":
            compact_dump(start_download(args.base_url, args.model_key))
        elif args.command == "download-status":
            compact_dump(download_status(args.base_url, args.job_id, args.poll, args.interval, args.timeout))
        else:
            parser.error(f"unknown command {args.command}")
    except Exception as error:
        compact_dump({"error": str(error), "ok": False})
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
