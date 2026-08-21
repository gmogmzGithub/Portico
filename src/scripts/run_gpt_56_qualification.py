#!/usr/bin/env python3
"""Run live headless Open WebUI qualification for the GPT-5.6 family.

The default matrix proves every ordinary reasoning effort and one local MCP
function call for Sol, Sol Pro, Terra, and Luna, then runs a two-turn
prompt-cache check that proves an accepted cache-populating request followed by
a real cache hit for each model. Explicit cache-write counters are recorded
when available but are not required. Invalid efforts must fail closed. The
--include-ultra option also proves a private root-only response and one local
safe-read MCP continuation through the Ultra adapter.

Run from the repository root:

    uv run --with httpx src/scripts/run_gpt_56_qualification.py
"""

from __future__ import annotations

import argparse
import json
import os
import re
import time
from pathlib import Path
from typing import Any, Iterable

from run_google_workspace_chat_consistency import (
    OWUIClient,
    _detect_openwebui_base_url,
    _fetch_chat_request_summaries,
    _fetch_request_detail,
    _main_request_summaries,
    ensure_debug_monitor_healthy,
)


REPO_ROOT = Path(__file__).resolve().parents[2]
REPORTING_EVENTS_DIR = Path(
    os.getenv(
        "PORTICO_COST_REPORTING_HOST_DIR",
        str(REPO_ROOT / "open-webui-data" / "reporting"),
    )
) / "events"

MODEL_SPECS: dict[str, dict[str, Any]] = {
    "GPT-5.6 Sol": {"provider_model": "gpt-5.6-sol", "pro": False},
    "GPT-5.6 Sol Pro": {"provider_model": "gpt-5.6-sol", "pro": True},
    "GPT-5.6 Terra": {"provider_model": "gpt-5.6-terra", "pro": False},
    "GPT-5.6 Luna": {"provider_model": "gpt-5.6-luna", "pro": False},
}
MODELS = tuple(MODEL_SPECS)
ORDINARY_EFFORTS = ("none", "low", "medium", "high", "xhigh", "max")
INVALID_EFFORT = "invalid-portico-qualification"
ULTRA_MODEL = "GPT-5.6 Sol"
ULTRA_TOOL_SERVER_ID = "server:web-tools"
ULTRA_TOOL_NAME = "web_tools_web_search"
WEB_SEARCH_SERVER_ID = "server:web-tools"
WEB_SEARCH_TOOL_NAME = "web_tools_web_search"
ORDINARY_OUTPUT = "qualification ok"
ULTRA_ROOT_OUTPUT = "ultra root ok"
ULTRA_TOOL_OUTPUT = "ultra tool ok"
ULTRA_CHILD_CANARY = "private child marker 7319"
DEFAULT_TIMEOUT_SECONDS = 1800
DEFAULT_EVIDENCE_TIMEOUT_SECONDS = 90

ORDINARY_PROMPT = (
    "This is a GPT-5.6 qualification check. Do not use tools. "
    f'Reply with exactly the text "{ORDINARY_OUTPUT}" and nothing else.'
)
ORDINARY_TOOL_OUTPUT = "tool qualification ok"
ORDINARY_TOOL_PROMPT = (
    f"Use {ULTRA_TOOL_NAME} exactly once with query="
    "'official OpenAI GPT-5.6 Sol model documentation'. After the local tool "
    f'result is returned, answer with exactly "{ORDINARY_TOOL_OUTPUT}".'
)
INVALID_PROMPT = (
    "This request carries an intentionally invalid reasoning effort and must "
    "be rejected. Do not answer it."
)
ULTRA_ROOT_PROMPT = (
    "Use Ultra multi-agent reasoning without tools. Spawn exactly one server-side "
    f"child agent and require it to include {ULTRA_CHILD_CANARY} in its private "
    "answer. The final root answer must "
    f'contain exactly "{ULTRA_ROOT_OUTPUT}" and must not repeat any child marker.'
)
ULTRA_TOOL_PROMPT = (
    "Spawn exactly one server-side child agent and have it privately verify the "
    "tool plan without using tools. After that child finishes, only the root must "
    f"emit the developer function {ULTRA_TOOL_NAME} exactly once with query="
    "'official OpenAI GPT-5.6 Sol model documentation' and end that response so "
    "PORTICO can supply the local result. After the result "
    "arrives in the provider continuation, the root must answer with exactly "
    f'"{ULTRA_TOOL_OUTPUT}".'
)
WEB_SEARCH_OUTPUT = "web search qualification ok"
WEB_SEARCH_PROMPT = (
    f"Use {WEB_SEARCH_TOOL_NAME} exactly once to find the official OpenAI "
    "GPT-5.6 Sol model documentation. After the local tool result is returned, "
    f'answer with exactly "{WEB_SEARCH_OUTPUT}".'
)
CACHE_STATIC_PREFIX = " ".join(
    f"GPT56-CACHE-SEGMENT-{index:04d} stable qualification context"
    for index in range(1, 401)
)
CACHE_PROMPTS = (
    f'{CACHE_STATIC_PREFIX}\nReply with exactly "cache qualification ok".',
    f'{CACHE_STATIC_PREFIX}\nReply with exactly "cache qualification ok".',
)

CACHE_READ_KEYS = (
    "cached_tokens",
    "cached_read_tokens",
    "cache_read_tokens",
    "cache_read_input_tokens",
    "cachedContentTokenCount",
    "cached_content_token_count",
)
CACHE_WRITE_KEYS = (
    "cached_write_tokens",
    "cache_write_tokens",
    "cache_write_input_tokens",
    "cache_creation_input_tokens",
)
CACHE_INPUT_KEYS = (
    "input_tokens",
    "prompt_tokens",
    "inputTokenCount",
    "promptTokenCount",
)
CACHE_UNCACHED_INPUT_KEYS = (
    "uncached_input_tokens",
    "non_cached_input_tokens",
    "uncached_tokens",
)


def _parse_csv(value: str, *, allowed: Iterable[str], label: str) -> list[str]:
    allowed_values = tuple(allowed)
    requested = [item.strip() for item in value.split(",") if item.strip()]
    invalid = [item for item in requested if item not in allowed_values]
    if invalid:
        raise argparse.ArgumentTypeError(
            f"invalid {label}: {', '.join(invalid)}; "
            f"expected one of {', '.join(allowed_values)}"
        )
    if not requested:
        raise argparse.ArgumentTypeError(f"at least one {label} is required")
    return requested


def _parse_models(value: str) -> list[str]:
    return _parse_csv(value, allowed=MODELS, label="model")


def _parse_efforts(value: str) -> list[str]:
    return _parse_csv(value, allowed=ORDINARY_EFFORTS, label="effort")


def _walk_dicts(value: Any) -> Iterable[dict[str, Any]]:
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from _walk_dicts(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk_dicts(child)


def _numeric(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        return max(0, int(value))
    if isinstance(value, str):
        try:
            return max(0, int(float(value)))
        except ValueError:
            return 0
    return 0


def _normalized_output(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _completion_final_text(completion: dict[str, Any]) -> str:
    blocks = completion.get("content_blocks")
    if isinstance(blocks, list):
        text_parts = [
            block.get("content")
            for block in blocks
            if isinstance(block, dict)
            and block.get("type") == "text"
            and isinstance(block.get("content"), str)
            and block.get("content", "").strip()
        ]
        if text_parts:
            return _normalized_output(" ".join(text_parts))

    content = str(completion.get("content") or "")
    content = re.sub(
        r"<details\s+type=[\"']tool_calls[\"'][^>]*>.*?</details>",
        "",
        content,
        flags=re.IGNORECASE | re.DOTALL,
    )
    return _normalized_output(content)


def _max_metric(value: Any, keys: Iterable[str]) -> int:
    key_set = set(keys)
    return max(
        (
            _numeric(candidate)
            for mapping in _walk_dicts(value)
            for key, candidate in mapping.items()
            if key in key_set
        ),
        default=0,
    )


def _cache_observation(
    value: Any,
    *,
    source: str,
    turn_index: int,
) -> dict[str, Any]:
    cache_read_tokens = _max_metric(value, CACHE_READ_KEYS)
    input_tokens = _max_metric(value, CACHE_INPUT_KEYS)
    explicit_uncached = _max_metric(value, CACHE_UNCACHED_INPUT_KEYS)
    return {
        "source": source,
        "turn_index": turn_index,
        "input_tokens": input_tokens,
        "uncached_input_tokens": max(
            explicit_uncached,
            input_tokens - cache_read_tokens,
        ),
        "cache_read_tokens": cache_read_tokens,
        "cache_write_tokens": _max_metric(value, CACHE_WRITE_KEYS),
    }


def validate_cache_evidence(observations: list[dict[str, Any]]) -> list[str]:
    if not observations:
        return ["no prompt-cache usage evidence was captured"]

    turns: dict[int, list[dict[str, Any]]] = {}
    for observation in observations:
        turn_index = observation.get("turn_index")
        if not isinstance(turn_index, int) or isinstance(turn_index, bool):
            return ["prompt-cache evidence was missing strict turn ordering"]
        turns.setdefault(turn_index, []).append(observation)
    if set(turns) != {0, 1}:
        return ["prompt-cache evidence did not contain exactly turns 1 and 2"]

    first = turns[0]
    second = turns[1]
    failures: list[str] = []
    if not any(item.get("accepted") is True for item in first):
        failures.append("cache turn 1 was not captured as an accepted request")
    if not any(_numeric(item.get("uncached_input_tokens")) > 0 for item in first):
        failures.append("cache turn 1 reported no positive uncached input")
    if not any(item.get("accepted") is True for item in second):
        failures.append("cache turn 2 was not captured as an accepted request")
    if not any(_numeric(item.get("cache_read_tokens")) > 0 for item in second):
        failures.append("cache turn 2 reported no real prompt-cache read")
    return failures

def _json_file_payload(path: Path) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _turn_index_for_message_id(
    message_id: Any,
    turn_message_ids: tuple[str, ...],
) -> int | None:
    normalized = str(message_id or "")
    for turn_index, expected_id in enumerate(turn_message_ids):
        if normalized == expected_id:
            return turn_index
    return None


def _turn_index_for_request(
    request: dict[str, Any],
    turn_message_ids: tuple[str, ...],
) -> int | None:
    for key in (
        "trigger_message_id",
        "transcript_anchor_message_id",
        "parent_message_id",
        "message_id",
    ):
        turn_index = _turn_index_for_message_id(request.get(key), turn_message_ids)
        if turn_index is not None:
            return turn_index
    return None


def _reporting_observations(
    chat_id: str,
    *,
    turn_message_ids: tuple[str, ...],
) -> list[dict[str, Any]]:
    if not REPORTING_EVENTS_DIR.exists():
        return []
    observations: list[dict[str, Any]] = []
    for path in REPORTING_EVENTS_DIR.glob("*.json"):
        payload = _json_file_payload(path)
        if not payload or payload.get("chatId") != chat_id:
            continue
        usage = payload.get("usage")
        if not isinstance(usage, dict):
            continue
        turn_index = _turn_index_for_request(
            {
                "trigger_message_id": payload.get("triggerMessageId"),
                "transcript_anchor_message_id": payload.get(
                    "transcriptAnchorMessageId"
                ),
                "message_id": payload.get("messageId"),
            },
            turn_message_ids,
        )
        if turn_index is None:
            continue
        observations.append(
            {
                **_cache_observation(
                    usage,
                    source="reporting",
                    turn_index=turn_index,
                ),
                "request_phase": payload.get("requestPhase"),
                "message_id": payload.get("messageId"),
            }
        )
    return observations


def _terminal_request_details(chat_id: str) -> list[dict[str, Any]]:
    summaries = _main_request_summaries(_fetch_chat_request_summaries(chat_id))
    details: list[dict[str, Any]] = []
    for summary in summaries:
        if str(summary.get("status") or "") not in {"complete", "error"}:
            continue
        request_id = summary.get("request_id")
        if not request_id:
            continue
        detail = _fetch_request_detail(str(request_id))
        merged = dict(detail)
        for key, value in summary.items():
            if merged.get(key) in (None, "", [], {}):
                merged[key] = value
        details.append(merged)
    return details


def _wait_for_request_details(
    chat_id: str, *, min_count: int, timeout_seconds: int
) -> list[dict[str, Any]]:
    deadline = time.time() + timeout_seconds
    latest: list[dict[str, Any]] = []
    while time.time() < deadline:
        try:
            latest = _terminal_request_details(chat_id)
        except Exception:
            latest = []
        if len(latest) >= min_count:
            return latest
        time.sleep(1)
    return latest


def _debug_cache_observation(
    detail: dict[str, Any],
    *,
    turn_index: int,
) -> dict[str, Any]:
    return {
        **_cache_observation(
            detail.get("usage", detail),
            source="debug-monitor",
            turn_index=turn_index,
        ),
        "accepted": str(detail.get("status") or "") == "complete",
        "request_id": detail.get("request_id"),
        "request_phase": detail.get("request_phase"),
    }

def _wait_for_cache_evidence(
    chat_id: str,
    *,
    turn_message_ids: tuple[str, ...],
    min_request_count: int,
    timeout_seconds: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    deadline = time.time() + timeout_seconds
    latest_details: list[dict[str, Any]] = []
    latest_observations: list[dict[str, Any]] = []
    while time.time() < deadline:
        all_details = _wait_for_request_details(
            chat_id, min_count=min_request_count, timeout_seconds=1
        )
        correlated: list[tuple[int, dict[str, Any]]] = []
        for detail in all_details:
            turn_index = _turn_index_for_request(detail, turn_message_ids)
            if turn_index is not None:
                correlated.append((turn_index, detail))
        latest_details = [detail for _, detail in correlated]
        debug_observations = [
            _debug_cache_observation(detail, turn_index=turn_index)
            for turn_index, detail in correlated
        ]
        latest_observations = _reporting_observations(
            chat_id,
            turn_message_ids=turn_message_ids,
        ) + debug_observations
        if not validate_cache_evidence(latest_observations):
            return latest_details, latest_observations
        time.sleep(1)
    return latest_details, latest_observations


def _openai_controls(request_details: list[dict[str, Any]]) -> list[dict[str, Any]]:
    controls: list[dict[str, Any]] = []
    for detail in request_details:
        parameters = detail.get("parameters")
        if not isinstance(parameters, dict):
            continue
        effort = parameters.get("reasoning_effort")
        if isinstance(effort, str) and effort:
            controls.append({"effort": effort})
    return controls

def validate_ordinary_controls(
    *, model: str, effort: str, controls: list[dict[str, Any]]
) -> list[str]:
    if not controls:
        return ["llm-debug-monitor captured no safe reasoning-effort parameters"]
    if any(control.get("effort") != effort for control in controls):
        return [
            f"one or more {model} requests did not preserve reasoning_effort={effort!r}"
        ]
    return []

def _run_completion(
    client: OWUIClient,
    *,
    model: str,
    prompt: str,
    effort: str,
    timeout_seconds: int,
    evidence_timeout_seconds: int,
    tool_ids: list[str] | None = None,
) -> dict[str, Any]:
    created = client.create_chat(model=model, prompt=prompt)
    chat_id = created["chat_id"]
    user_message_id = created["user_message_id"]
    client.generate_completion(
        chat_id=chat_id,
        model=model,
        prompt=prompt,
        user_message_id=user_message_id,
        stream=True,
        reasoning_effort=effort,
        tool_ids=tool_ids,
    )
    completion = client.poll_for_completion(
        chat_id=chat_id,
        user_message_id=user_message_id,
        timeout_seconds=timeout_seconds,
        poll_interval=2,
    )
    request_details = _wait_for_request_details(
        chat_id, min_count=1, timeout_seconds=evidence_timeout_seconds
    )
    return {
        "chat_id": chat_id,
        "completion": completion,
        "request_details": request_details,
        "controls": _openai_controls(request_details),
    }


def run_ordinary_case(
    client: OWUIClient,
    *,
    model: str,
    effort: str,
    timeout_seconds: int,
    evidence_timeout_seconds: int,
) -> dict[str, Any]:
    try:
        run = _run_completion(
            client,
            model=model,
            prompt=ORDINARY_PROMPT,
            effort=effort,
            timeout_seconds=timeout_seconds,
            evidence_timeout_seconds=evidence_timeout_seconds,
            tool_ids=[],
        )
    except Exception as exc:
        return {
            "model": model,
            "effort": effort,
            "perfect": False,
            "failures": [f"{type(exc).__name__}: {exc}"],
        }
    completion = run["completion"]
    failures: list[str] = []
    if not completion.get("complete"):
        failures.append(f"chat did not complete: {completion.get('error')}")
    if _normalized_output(completion.get("content")) != ORDINARY_OUTPUT:
        failures.append(
            f"assistant response was not exactly {ORDINARY_OUTPUT}"
        )
    failures.extend(
        validate_ordinary_controls(model=model, effort=effort, controls=run["controls"])
    )
    return {
        "model": model,
        "effort": effort,
        "chat_id": run["chat_id"],
        "perfect": not failures,
        "failures": failures,
        "controls": run["controls"],
    }




def _request_details_include_function_call(
    request_details: list[dict[str, Any]],
    *,
    tool_name: str,
) -> bool:
    for mapping in _walk_dicts(request_details):
        if mapping.get("type") != "function_call":
            continue
        name = mapping.get("name")
        function = mapping.get("function")
        if not name and isinstance(function, dict):
            name = function.get("name")
        if name == tool_name:
            return True
    return False


def run_ordinary_tool_case(
    client: OWUIClient,
    *,
    model: str,
    timeout_seconds: int,
    evidence_timeout_seconds: int,
) -> dict[str, Any]:
    try:
        run = _run_completion(
            client,
            model=model,
            prompt=ORDINARY_TOOL_PROMPT,
            effort="medium",
            timeout_seconds=timeout_seconds,
            evidence_timeout_seconds=evidence_timeout_seconds,
            tool_ids=[ULTRA_TOOL_SERVER_ID],
        )
        request_details = _wait_for_request_details(
            run["chat_id"],
            min_count=2,
            timeout_seconds=evidence_timeout_seconds,
        )
    except Exception as exc:
        return {
            "model": model,
            "perfect": False,
            "failures": [f"{type(exc).__name__}: {exc}"],
        }

    completion = run["completion"]
    failures: list[str] = []
    if not completion.get("complete"):
        failures.append(f"tool chat did not complete: {completion.get('error')}")
    if _completion_final_text(completion) != ORDINARY_TOOL_OUTPUT:
        failures.append(
            f"tool chat response was not exactly {ORDINARY_TOOL_OUTPUT}"
        )
    if len(request_details) < 2:
        failures.append("tool chat did not capture a provider continuation")
    if not _request_details_include_function_call(
        request_details,
        tool_name=ULTRA_TOOL_NAME,
    ):
        failures.append("tool chat captured no provider function call")
    failures.extend(
        validate_ordinary_controls(
            model=model,
            effort="medium",
            controls=_openai_controls(request_details),
        )
    )
    return {
        "model": model,
        "chat_id": run["chat_id"],
        "perfect": not failures,
        "failures": failures,
    }


def run_web_search_case(
    client: OWUIClient,
    *,
    timeout_seconds: int,
    evidence_timeout_seconds: int,
) -> dict[str, Any]:
    """Prove the built-in web-search MCP path with the new Sol default."""
    try:
        run = _run_completion(
            client,
            model=ULTRA_MODEL,
            prompt=WEB_SEARCH_PROMPT,
            effort="medium",
            timeout_seconds=timeout_seconds,
            evidence_timeout_seconds=evidence_timeout_seconds,
            tool_ids=[WEB_SEARCH_SERVER_ID],
        )
        request_details = _wait_for_request_details(
            run["chat_id"],
            min_count=2,
            timeout_seconds=evidence_timeout_seconds,
        )
    except Exception as exc:
        return {
            "model": ULTRA_MODEL,
            "perfect": False,
            "failures": [f"{type(exc).__name__}: {exc}"],
        }

    completion = run["completion"]
    failures: list[str] = []
    if not completion.get("complete"):
        failures.append(f"web-search chat did not complete: {completion.get('error')}")
    if _completion_final_text(completion) != WEB_SEARCH_OUTPUT:
        failures.append(
            f"web-search response was not exactly {WEB_SEARCH_OUTPUT}"
        )
    if len(request_details) < 2:
        failures.append("web-search chat did not capture a provider continuation")
    if not _request_details_include_function_call(
        request_details,
        tool_name=WEB_SEARCH_TOOL_NAME,
    ):
        failures.append("web-search chat captured no provider function call")
    failures.extend(
        validate_ordinary_controls(
            model=ULTRA_MODEL,
            effort="medium",
            controls=_openai_controls(request_details),
        )
    )
    return {
        "model": ULTRA_MODEL,
        "chat_id": run["chat_id"],
        "perfect": not failures,
        "failures": failures,
    }
def run_cache_case(
    client: OWUIClient,
    *,
    model: str,
    timeout_seconds: int,
    evidence_timeout_seconds: int,
) -> dict[str, Any]:
    created = client.create_chat(model=model, prompt=CACHE_PROMPTS[0])
    chat_id = created["chat_id"]
    parent_id = created["user_message_id"]
    completions: list[dict[str, Any]] = []
    turn_message_ids: list[str] = []
    failures: list[str] = []
    for index, prompt in enumerate(CACHE_PROMPTS):
        if index:
            appended = client.append_user_message(
                chat_id=chat_id, model=model, prompt=prompt, parent_id=parent_id
            )
            parent_id = appended["user_message_id"]
        turn_message_ids.append(str(parent_id))
        try:
            client.generate_completion(
                chat_id=chat_id,
                model=model,
                prompt=prompt,
                user_message_id=parent_id,
                stream=True,
                reasoning_effort="medium",
                tool_ids=[],
            )
            completion = client.poll_for_completion(
                chat_id=chat_id,
                user_message_id=parent_id,
                timeout_seconds=timeout_seconds,
                poll_interval=2,
            )
        except Exception as exc:
            failures.append(f"cache turn {index + 1} failed: {type(exc).__name__}: {exc}")
            break
        completions.append(completion)
        if not completion.get("complete"):
            failures.append(
                f"cache turn {index + 1} did not complete: {completion.get('error')}"
            )
            break
        expected_output = "cache qualification ok"
        if _normalized_output(completion.get("content")) != expected_output:
            failures.append(
                f"cache turn {index + 1} response was not exactly {expected_output}"
            )
            break
        parent_id = str(completion.get("assistant_message_id") or parent_id)

    request_details, observations = _wait_for_cache_evidence(
        chat_id,
        min_request_count=len(completions),
        turn_message_ids=tuple(turn_message_ids),
        timeout_seconds=evidence_timeout_seconds,
    )
    failures.extend(validate_cache_evidence(observations))
    failures.extend(
        validate_ordinary_controls(
            model=model,
            effort="medium",
            controls=_openai_controls(request_details),
        )
    )
    return {
        "model": model,
        "chat_id": chat_id,
        "perfect": not failures,
        "failures": failures,
        "completed_turns": len(completions),
        "cache_observations": observations,
    }


def _string_fragments(value: Any) -> Iterable[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from _string_fragments(child)
    elif isinstance(value, list):
        for child in value:
            yield from _string_fragments(child)


def _invalid_effort_error_signal(value: Any) -> bool:
    text = " ".join(_string_fragments(value)).lower()
    if not text:
        return False
    if INVALID_EFFORT.lower() in text:
        return True
    return (
        "effort" in text
        and ("reasoning" in text or "reasoning_effort" in text)
        and any(
            marker in text
            for marker in (
                "invalid",
                "unsupported",
                "not allowed",
                "unrecognized",
                "unknown",
                "must be",
                "expected",
                "allowed values",
            )
        )
    )


def _invalid_value_rejection_signal(value: Any) -> bool:
    text = " ".join(_string_fragments(value)).lower()
    return "invalid value" in text and any(
        marker in text for marker in ("supported values", "allowed values", "expected")
    )


def _transport_or_server_failure_signal(value: Any) -> bool:
    text = " ".join(_string_fragments(value)).lower()
    return bool(re.search(r"\b5\d{2}\b", text)) or any(
        marker in text
        for marker in (
            "bad gateway",
            "connection error",
            "connection reset",
            "connection refused",
            "gateway timeout",
            "network error",
            "service unavailable",
            "timed out",
            "timeout",
            "transport error",
        )
    )


def _http_exception_is_invalid_effort_rejection(exception: BaseException) -> bool:
    response = getattr(exception, "response", None)
    status_code = _numeric(getattr(response, "status_code", None))
    if not 400 <= status_code < 500:
        return False
    evidence = [str(exception), getattr(response, "text", "")]
    return _invalid_effort_error_signal(
        evidence
    ) and not _transport_or_server_failure_signal(evidence)


def _error_payloads(value: Any) -> Iterable[Any]:
    error_keys = {
        "detail",
        "error",
        "errors",
        "error_message",
        "exception",
        "failure",
        "provider_error",
        "response_error",
    }
    for mapping in _walk_dicts(value):
        for key, candidate in mapping.items():
            if str(key).lower().replace("-", "_") in error_keys:
                yield candidate


def _http_status_codes(value: Any) -> Iterable[int]:
    status_keys = {"http_status", "http_status_code", "status_code", "statuscode"}
    for mapping in _walk_dicts(value):
        for key, candidate in mapping.items():
            if str(key).lower().replace("-", "_") in status_keys:
                status_code = _numeric(candidate)
                if status_code:
                    yield status_code


def _detail_has_invalid_effort_control(detail: dict[str, Any]) -> bool:
    effort_keys = {"effort", "reasoning_effort"}
    return any(
        str(candidate) == INVALID_EFFORT
        for mapping in _walk_dicts(detail)
        for key, candidate in mapping.items()
        if str(key).lower().replace("-", "_") in effort_keys
    )


def _terminal_debug_invalid_effort_rejection(
    *,
    completion: dict[str, Any] | None,
    request_details: list[dict[str, Any]],
) -> bool:
    completion_error = (
        completion.get("error")
        if completion is not None and not completion.get("complete")
        else None
    )
    for detail in request_details:
        if str(detail.get("status") or "") != "error":
            continue
        if not _detail_has_invalid_effort_control(detail):
            continue
        error_evidence = list(_error_payloads(detail))
        if completion_error:
            error_evidence.append(completion_error)
        if any(status_code >= 500 for status_code in _http_status_codes(detail)):
            continue
        if _transport_or_server_failure_signal(error_evidence):
            continue
        if _invalid_effort_error_signal(
            error_evidence
        ) or _invalid_value_rejection_signal(error_evidence):
            return True
    return False


def invalid_effort_was_rejected(
    *,
    completion: dict[str, Any] | None,
    exception: BaseException | None,
    request_details: list[dict[str, Any]],
) -> bool:
    if exception is not None and _http_exception_is_invalid_effort_rejection(exception):
        return True
    return _terminal_debug_invalid_effort_rejection(
        completion=completion,
        request_details=request_details,
    )


def run_invalid_effort_case(
    client: OWUIClient,
    *,
    model: str,
    timeout_seconds: int,
    evidence_timeout_seconds: int,
) -> dict[str, Any]:
    created = client.create_chat(model=model, prompt=INVALID_PROMPT)
    chat_id = created["chat_id"]
    user_message_id = created["user_message_id"]
    completion: dict[str, Any] | None = None
    exception: BaseException | None = None
    try:
        client.generate_completion(
            chat_id=chat_id,
            model=model,
            prompt=INVALID_PROMPT,
            user_message_id=user_message_id,
            stream=True,
            reasoning_effort=INVALID_EFFORT,
            tool_ids=[],
        )
        completion = client.poll_for_completion(
            chat_id=chat_id,
            user_message_id=user_message_id,
            timeout_seconds=timeout_seconds,
            poll_interval=2,
        )
    except Exception as exc:
        exception = exc
    request_details = _wait_for_request_details(
        chat_id, min_count=1, timeout_seconds=evidence_timeout_seconds
    )
    rejected = invalid_effort_was_rejected(
        completion=completion,
        exception=exception,
        request_details=request_details,
    )
    return {
        "model": model,
        "chat_id": chat_id,
        "perfect": rejected,
        "failures": [] if rejected else [
            "invalid reasoning effort lacked a matching HTTP 4xx validation "
            "rejection or terminal debug error"
        ],
        "rejected": rejected,
        "rejection": f"{type(exception).__name__}: {exception}" if exception else (
            completion.get("error") if completion else None
        ),
    }


def validate_ultra_root_case(
    completion: dict[str, Any],
    child_agent_count: int,
) -> list[str]:
    failures: list[str] = []
    content = _normalized_output(completion.get("content"))
    if not completion.get("complete"):
        failures.append(f"Ultra root-only chat did not complete: {completion.get('error')}")
    if content != ULTRA_ROOT_OUTPUT:
        failures.append(
            f"Ultra root-only chat did not return exactly {ULTRA_ROOT_OUTPUT}"
        )
    if ULTRA_CHILD_CANARY in content:
        failures.append("private Ultra child output leaked into the root answer")
    if '<details type="tool_calls"' in content:
        failures.append("Ultra root-only output unexpectedly contained tool-call HTML")
    if child_agent_count < 1:
        failures.append("Ultra root-only evidence did not prove a server-side child agent ran")
    return failures


def _extract_ultra_child_count(request_details: list[dict[str, Any]]) -> int:
    child_count_keys = {
        "child_agent_count",
        "x_portico_ultra_child_count",
    }
    return max(
        (
            _numeric(candidate)
            for detail in request_details
            for mapping in _walk_dicts(detail)
            for key, candidate in mapping.items()
            if str(key).lower().replace("-", "_") in child_count_keys
        ),
        default=0,
    )


def _extract_ultra_audit(request_details: list[dict[str, Any]]) -> dict[str, Any]:
    audits: list[dict[str, Any]] = []
    for detail in request_details:
        candidates = [
            detail.get("ultra_audit"),
            detail.get("response", {}).get("ultra_audit")
            if isinstance(detail.get("response"), dict)
            else None,
        ]
        audits.extend(candidate for candidate in candidates if isinstance(candidate, dict))
    if not audits:
        return {}
    return {
        "child_agent_count": max(
            (_numeric(audit.get("child_agent_count")) for audit in audits),
            default=0,
        ),
        "tool_call_count": max(
            (_numeric(audit.get("tool_call_count")) for audit in audits),
            default=0,
        ),
        "child_tool_call_count": max(
            (_numeric(audit.get("child_tool_call_count")) for audit in audits),
            default=0,
        ),
        "tool_result_count": max(
            (_numeric(audit.get("tool_result_count")) for audit in audits),
            default=0,
        ),
        "continuation_count": max(
            (_numeric(audit.get("continuation_count")) for audit in audits),
            default=0,
        ),
        "arguments_logged": any(audit.get("arguments_logged") is True for audit in audits),
        "results_logged": any(audit.get("results_logged") is True for audit in audits),
    }


def validate_ultra_tool_case(
    completion: dict[str, Any],
    audit: dict[str, Any],
) -> list[str]:
    failures: list[str] = []
    content = _normalized_output(completion.get("content"))
    if not completion.get("complete"):
        failures.append(f"Ultra tool chat did not complete: {completion.get('error')}")
    if content != ULTRA_TOOL_OUTPUT:
        failures.append(
            f"Ultra tool continuation did not return exactly {ULTRA_TOOL_OUTPUT}"
        )
    if '<details type="tool_calls"' in content:
        failures.append("private Ultra tool activity leaked into visible tool-call HTML")
    if not audit:
        failures.append("sanitized Ultra audit counters were unavailable")
    else:
        tool_call_count = _numeric(audit.get("tool_call_count"))
        child_tool_call_count = _numeric(audit.get("child_tool_call_count"))
        tool_result_count = _numeric(audit.get("tool_result_count"))
        if _numeric(audit.get("child_agent_count")) < 1:
            failures.append("Ultra audit did not prove a server-side child agent ran")
        if tool_call_count < 1:
            failures.append("Ultra audit did not report a local tool call")
        if child_tool_call_count != 0:
            failures.append("Ultra audit reported a forbidden child-owned local tool call")
        if tool_result_count != tool_call_count:
            failures.append(
                "Ultra audit did not match every local tool call to one result"
            )
        if _numeric(audit.get("continuation_count")) < 1:
            failures.append("Ultra audit did not report a provider continuation")
        if audit.get("arguments_logged") is True or audit.get("results_logged") is True:
            failures.append("Ultra audit reported private arguments or results as logged")
    return failures


def run_ultra_hooks(
    client: OWUIClient,
    *,
    timeout_seconds: int,
    evidence_timeout_seconds: int,
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    try:
        root = _run_completion(
            client,
            model=ULTRA_MODEL,
            prompt=ULTRA_ROOT_PROMPT,
            effort="ultra",
            timeout_seconds=timeout_seconds,
            evidence_timeout_seconds=evidence_timeout_seconds,
            tool_ids=[],
        )
        child_agent_count = _extract_ultra_child_count(root["request_details"])
        root_failures = validate_ultra_root_case(
            root["completion"],
            child_agent_count,
        )
        results.append(
            {
                "scenario": "root-only",
                "chat_id": root["chat_id"],
                "perfect": not root_failures,
                "failures": root_failures,
                "child_agent_count": child_agent_count,
            }
        )
    except Exception as exc:
        results.append(
            {
                "scenario": "root-only",
                "perfect": False,
                "failures": [f"{type(exc).__name__}: {exc}"],
            }
        )

    try:
        tool = _run_completion(
            client,
            model=ULTRA_MODEL,
            prompt=ULTRA_TOOL_PROMPT,
            effort="ultra",
            timeout_seconds=timeout_seconds,
            evidence_timeout_seconds=evidence_timeout_seconds,
            tool_ids=[ULTRA_TOOL_SERVER_ID],
        )
        audit = _extract_ultra_audit(tool["request_details"])
        tool_failures = validate_ultra_tool_case(tool["completion"], audit)
        results.append(
            {
                "scenario": "local-tool-continuation",
                "chat_id": tool["chat_id"],
                "perfect": not tool_failures,
                "failures": tool_failures,
                "ultra_audit": audit,
            }
        )
    except Exception as exc:
        results.append(
            {
                "scenario": "local-tool-continuation",
                "perfect": False,
                "failures": [f"{type(exc).__name__}: {exc}"],
            }
        )
    return results


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", type=_parse_models, default=list(MODELS))
    parser.add_argument("--efforts", type=_parse_efforts, default=list(ORDINARY_EFFORTS))
    parser.add_argument("--timeout-seconds", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument(
        "--evidence-timeout-seconds",
        type=int,
        default=DEFAULT_EVIDENCE_TIMEOUT_SECONDS,
    )
    parser.add_argument(
        "--include-invalid",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    parser.add_argument(
        "--include-tools",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    parser.add_argument(
        "--include-ultra",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    parser.add_argument(
        "--include-web-search",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    ensure_debug_monitor_healthy()
    results: dict[str, Any] = {
        "ordinary": [],
        "ordinary_tool": [],
        "cache": [],
        "web_search": [],
        "invalid_effort": [],
        "ultra": [],
    }
    with OWUIClient(base_url=_detect_openwebui_base_url()) as client:
        for model in args.models:
            for effort in args.efforts:
                result = run_ordinary_case(
                    client,
                    model=model,
                    effort=effort,
                    timeout_seconds=args.timeout_seconds,
                    evidence_timeout_seconds=args.evidence_timeout_seconds,
                )
                results["ordinary"].append(result)
                print(json.dumps(result, sort_keys=True))
            if args.include_tools:
                tool_result = run_ordinary_tool_case(
                    client,
                    model=model,
                    timeout_seconds=args.timeout_seconds,
                    evidence_timeout_seconds=args.evidence_timeout_seconds,
                )
                results["ordinary_tool"].append(tool_result)
                print(json.dumps(tool_result, sort_keys=True))
            cache_result = run_cache_case(
                client,
                model=model,
                timeout_seconds=args.timeout_seconds,
                evidence_timeout_seconds=args.evidence_timeout_seconds,
            )
            results["cache"].append(cache_result)
            print(json.dumps(cache_result, sort_keys=True))
            if args.include_invalid:
                invalid_result = run_invalid_effort_case(
                    client,
                    model=model,
                    timeout_seconds=args.timeout_seconds,
                    evidence_timeout_seconds=args.evidence_timeout_seconds,
                )
                results["invalid_effort"].append(invalid_result)
                print(json.dumps(invalid_result, sort_keys=True))
        if args.include_web_search:
            web_search_result = run_web_search_case(
                client,
                timeout_seconds=args.timeout_seconds,
                evidence_timeout_seconds=args.evidence_timeout_seconds,
            )
            results["web_search"].append(web_search_result)
            print(json.dumps(web_search_result, sort_keys=True))
        if args.include_ultra:
            results["ultra"] = run_ultra_hooks(
                client,
                timeout_seconds=args.timeout_seconds,
                evidence_timeout_seconds=args.evidence_timeout_seconds,
            )
            for result in results["ultra"]:
                print(json.dumps(result, sort_keys=True))

    failures = [
        {
            "section": section,
            "model": result.get("model"),
            "scenario": result.get("scenario"),
            "chat_id": result.get("chat_id"),
            "failures": result.get("failures"),
        }
        for section, section_results in results.items()
        for result in section_results
        if not result.get("perfect")
    ]
    summary = {
        "success": not failures,
        "models": args.models,
        "efforts": args.efforts,
        "ultra_included": args.include_ultra,
        "tools_included": args.include_tools,
        "failures": failures,
        "web_search_included": args.include_web_search,
        "results": results,
    }
    rendered = json.dumps(summary, indent=2, sort_keys=True)
    print(json.dumps({"summary": summary}, indent=2, sort_keys=True))
    if args.output:
        args.output.write_text(rendered + "\n")
    return 0 if summary["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
