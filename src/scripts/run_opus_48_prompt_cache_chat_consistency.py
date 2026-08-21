#!/usr/bin/env python3
"""
Run real headless Open WebUI prompt-cache consistency checks for the Opus models.

The required regression check creates streaming OWUI chats for Atlas Opus 5
and Atlas Opus 4.8, sends three immediate turns, then verifies from safe usage
events that each model reads the prompt cache and does not produce a large
zero-read rewrite after an earlier cache read. (The retired Atlas Opus 4.7
"control" run was dropped when 4.7 left the catalog; both current Opus models
are validated strictly.) The all-tools scenario is available as diagnostic
coverage; the default required path is the no-tools/core-tools mode.
"""

from __future__ import annotations

import argparse
import json
import time
import uuid
from pathlib import Path
from typing import Any

from run_google_workspace_chat_consistency import (
    OWUIClient,
    _detect_openwebui_base_url,
    _restart_counts,
)


REPO_ROOT = Path(__file__).resolve().parents[2]
REPORTING_EVENTS_DIR = Path(
    __import__("os").getenv(
        "PORTICO_COST_REPORTING_HOST_DIR",
        str(REPO_ROOT / "open-webui-data" / "reporting"),
    )
) / "events"

MODELS = ("Atlas Opus 5", "Atlas Opus 4.8")
SCENARIOS = ("no-tools", "all-tools")
DEFAULT_TIMEOUT_SECONDS = 600
DEFAULT_DEBUG_TIMEOUT_SECONDS = 75
DEFAULT_LARGE_WRITE_THRESHOLD = 4096

PROMPTS = (
    "For this prompt-cache test, do not use tools. Reply with exactly: cache-turn-1",
    "For this prompt-cache test, do not use tools. Reply with exactly: cache-turn-2",
    "For this prompt-cache test, do not use tools. Reply with exactly: cache-turn-3",
)


def _json_file_payload(path: Path) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _usage_int(usage: dict[str, Any], *keys: str) -> int:
    for key in keys:
        value = usage.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, int):
            return value
        if isinstance(value, float):
            return int(value)
        if isinstance(value, str):
            try:
                return int(float(value))
            except ValueError:
                continue
    return 0


def _load_reporting_usage_events(chat_id: str) -> list[dict[str, Any]]:
    if not REPORTING_EVENTS_DIR.exists():
        return []

    events: list[dict[str, Any]] = []
    for path in REPORTING_EVENTS_DIR.glob("*.json"):
        payload = _json_file_payload(path)
        if not payload or payload.get("chatId") != chat_id:
            continue
        usage = payload.get("usage")
        if not isinstance(usage, dict):
            continue
        events.append(payload)

    events.sort(
        key=lambda event: (
            int(event.get("promptSubmittedAtMs") or 0),
            int(event.get("completedAt") or 0),
            str(event.get("eventId") or ""),
        )
    )
    return events


def _summarize_usage_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    summaries: list[dict[str, Any]] = []
    for index, event in enumerate(events, start=1):
        usage = event.get("usage") if isinstance(event.get("usage"), dict) else {}
        summaries.append(
            {
                "index": index,
                "call_id": event.get("callId"),
                "message_id": event.get("messageId"),
                "request_phase": event.get("requestPhase"),
                "model_id": event.get("modelId"),
                "prompt_submitted_at_ms": event.get("promptSubmittedAtMs"),
                "completed_at": event.get("completedAt"),
                "input_tokens": _usage_int(usage, "input_tokens", "prompt_tokens"),
                "output_tokens": _usage_int(usage, "output_tokens", "completion_tokens"),
                "cache_read_input_tokens": _usage_int(
                    usage,
                    "cache_read_input_tokens",
                    "cached_content_token_count",
                    "cachedContentTokenCount",
                ),
                "cache_creation_input_tokens": _usage_int(
                    usage,
                    "cache_creation_input_tokens",
                    "cache_write_input_tokens",
                ),
            }
        )
    return summaries


def _wait_for_reporting_usage_events(
    chat_id: str,
    *,
    min_count: int,
    timeout_seconds: int,
) -> list[dict[str, Any]]:
    deadline = time.time() + timeout_seconds
    latest: list[dict[str, Any]] = []
    while time.time() < deadline:
        latest = _load_reporting_usage_events(chat_id)
        if len(latest) >= min_count:
            return latest
        time.sleep(1)
    return latest


def _generate_completion_with_tool_mode(
    client: OWUIClient,
    *,
    chat_id: str,
    model: str,
    prompt: str,
    user_message_id: str,
    scenario: str,
    reasoning_effort: str,
) -> dict[str, Any]:
    model_item = client.get_model_item(model)
    session_id = client._generate_session_id()
    variables = client._generate_variables()
    message_id = str(uuid.uuid4())
    tool_ids = client.get_tool_ids() if scenario == "all-tools" else []

    completion_payload = {
        "stream": True,
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "params": {
            "function_calling": "native",
            "reasoning_effort": reasoning_effort,
        },
        "tool_ids": tool_ids,
        "tool_servers": [],
        "features": {
            "image_generation": False,
            "code_interpreter": False,
            "web_search": False,
        },
        "variables": variables,
        "model_item": model_item,
        "session_id": session_id,
        "chat_id": chat_id,
        "id": message_id,
        "parent_id": user_message_id,
        "parent_message": {
            "id": user_message_id,
            "files": [],
        },
        "background_tasks": {
            "title_generation": False,
            "tags_generation": False,
            "follow_up_generation": False,
        },
    }

    response = client.client.post(
        "/api/chat/completions",
        json=completion_payload,
        timeout=60.0,
    )
    response.raise_for_status()
    result = response.json()
    result.setdefault("session_id", session_id)
    result.setdefault("message_id", message_id)
    return result


def _normalize_live_error(exc: BaseException) -> str:
    return f"{exc.__class__.__name__}: {exc}"


def _large_zero_read_rewrites(
    usage_summaries: list[dict[str, Any]],
    *,
    large_write_threshold: int,
) -> list[dict[str, Any]]:
    saw_read = False
    misses: list[dict[str, Any]] = []
    for summary in usage_summaries:
        read_tokens = int(summary.get("cache_read_input_tokens") or 0)
        write_tokens = int(summary.get("cache_creation_input_tokens") or 0)
        if read_tokens > 0:
            saw_read = True
        elif saw_read and write_tokens >= large_write_threshold:
            misses.append(summary)
    return misses


def _validate_prompt_cache_sequence(
    *,
    model: str,
    scenario: str,
    usage_summaries: list[dict[str, Any]],
    required_target: bool,
    large_write_threshold: int,
) -> list[str]:
    failures: list[str] = []
    if len(usage_summaries) < len(PROMPTS):
        failures.append(
            f"expected at least {len(PROMPTS)} usage events, saw {len(usage_summaries)}"
        )

    has_cache_read = any(
        int(summary.get("cache_read_input_tokens") or 0) > 0
        for summary in usage_summaries
    )
    if required_target and not has_cache_read:
        failures.append("Opus 4.8 never reported a prompt-cache read")

    misses = _large_zero_read_rewrites(
        usage_summaries,
        large_write_threshold=large_write_threshold,
    )
    if required_target and misses:
        failures.append(
            "Opus 4.8 had a large zero-read prompt-cache rewrite after a prior read: "
            f"{misses}"
        )

    return failures

def run_model_scenario(
    client: OWUIClient,
    *,
    model: str,
    scenario: str,
    timeout_seconds: int,
    debug_timeout_seconds: int,
    large_write_threshold: int,
    reasoning_effort: str,
) -> dict[str, Any]:
    created = client.create_chat(model=model, prompt=PROMPTS[0])
    chat_id = created["chat_id"]
    current_parent_id = created["user_message_id"]
    completions: list[dict[str, Any]] = []
    live_failures: list[str] = []

    for turn_index, prompt in enumerate(PROMPTS, start=1):
        if turn_index > 1:
            try:
                appended = client.append_user_message(
                    chat_id=chat_id,
                    model=model,
                    prompt=prompt,
                    parent_id=current_parent_id,
                )
            except Exception as exc:
                live_failures.append(
                    f"turn {turn_index} failed while appending user message: {_normalize_live_error(exc)}"
                )
                break
            current_parent_id = appended["user_message_id"]

        try:
            completion_result = _generate_completion_with_tool_mode(
                client,
                chat_id=chat_id,
                model=model,
                prompt=prompt,
                user_message_id=current_parent_id,
                scenario=scenario,
                reasoning_effort=reasoning_effort,
            )
            polled = client.poll_for_completion(
                chat_id=chat_id,
                user_message_id=current_parent_id,
                timeout_seconds=timeout_seconds,
                poll_interval=2,
            )
        except Exception as exc:
            completions.append(
                {
                    "turn": turn_index,
                    "user_message_id": current_parent_id,
                    "session_id": None,
                    "assistant_message_id": None,
                    "complete": False,
                    "error": _normalize_live_error(exc),
                }
            )
            live_failures.append(
                f"turn {turn_index} failed while generating completion: {_normalize_live_error(exc)}"
            )
            break
        completions.append(
            {
                "turn": turn_index,
                "user_message_id": current_parent_id,
                "session_id": completion_result.get("session_id"),
                "assistant_message_id": polled.get("assistant_message_id"),
                "complete": polled.get("complete"),
                "error": polled.get("error"),
            }
        )
        if not polled.get("complete"):
            break
        current_parent_id = str(polled.get("assistant_message_id") or current_parent_id)

    usage_events = _wait_for_reporting_usage_events(
        chat_id,
        min_count=len(completions),
        timeout_seconds=debug_timeout_seconds,
    )
    usage_summaries = _summarize_usage_events(usage_events)

    incomplete_turns = [
        completion for completion in completions if not completion.get("complete")
    ]
    failures = list(live_failures)
    failures.extend(
        f"turn {completion['turn']} did not complete: {completion.get('error')}"
        for completion in incomplete_turns
        if completion.get("error")
    )
    failures.extend(
        _validate_prompt_cache_sequence(
            model=model,
            scenario=scenario,
            usage_summaries=usage_summaries,
            # Every catalog Opus model is validated strictly (the retired 4.7
            # control run was the only non-required model).
            required_target=True,
            large_write_threshold=large_write_threshold,
        )
    )

    return {
        "chat_id": chat_id,
        "model": model,
        "scenario": scenario,
        "perfect": not failures,
        "failures": failures,
        "completions": completions,
        "usage_summaries": usage_summaries,
    }

def _parse_scenarios(value: str) -> list[str]:
    scenarios = [item.strip() for item in value.split(",") if item.strip()]
    invalid = [scenario for scenario in scenarios if scenario not in SCENARIOS]
    if invalid:
        raise argparse.ArgumentTypeError(
            f"invalid scenario(s): {', '.join(invalid)}; expected one of {', '.join(SCENARIOS)}"
        )
    return scenarios


def _parse_models(value: str) -> list[str]:
    requested = [item.strip() for item in value.split(",") if item.strip()]
    invalid = [model for model in requested if model not in MODELS]
    if invalid:
        raise argparse.ArgumentTypeError(
            f"invalid model(s): {', '.join(invalid)}; expected one of {', '.join(MODELS)}"
        )
    return requested


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--scenarios",
        type=_parse_scenarios,
        default=["no-tools"],
        help="Comma-separated scenarios to run: no-tools,all-tools",
    )
    parser.add_argument(
        "--models",
        type=_parse_models,
        default=list(MODELS),
        help="Comma-separated models to run; defaults to the 4.7 control and 4.8 target",
    )
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=DEFAULT_TIMEOUT_SECONDS,
    )
    parser.add_argument(
        "--debug-timeout-seconds",
        type=int,
        default=DEFAULT_DEBUG_TIMEOUT_SECONDS,
    )
    parser.add_argument(
        "--large-write-threshold",
        type=int,
        default=DEFAULT_LARGE_WRITE_THRESHOLD,
    )
    parser.add_argument(
        "--reasoning-effort",
        default="low",
        choices=["low", "medium", "high", "xhigh", "max"],
    )
    args = parser.parse_args()

    restart_counts_before = _restart_counts()
    print(json.dumps({"restart_counts_before": restart_counts_before}, indent=2))

    results: list[dict[str, Any]] = []
    with OWUIClient(base_url=_detect_openwebui_base_url()) as client:
        for scenario in args.scenarios:
            for model in args.models:
                started = time.time()
                result = run_model_scenario(
                    client,
                    model=model,
                    scenario=scenario,
                    timeout_seconds=args.timeout_seconds,
                    debug_timeout_seconds=args.debug_timeout_seconds,
                    large_write_threshold=args.large_write_threshold,
                    reasoning_effort=args.reasoning_effort,
                )
                result["elapsed_seconds"] = round(time.time() - started, 1)
                results.append(result)
                print(json.dumps(result, indent=2, sort_keys=True))

    failures = [
        {
            "model": result["model"],
            "scenario": result["scenario"],
            "chat_id": result["chat_id"],
            "failures": result["failures"],
        }
        for result in results
        if not result.get("perfect")
    ]
    restart_counts_after = _restart_counts()
    summary = {
        "success": not failures,
        "scenarios": args.scenarios,
        "models": args.models,
        "chat_ids": [result["chat_id"] for result in results],
        "failures": failures,
        "restart_counts_before": restart_counts_before,
        "restart_counts_after": restart_counts_after,
    }
    print(json.dumps({"summary": summary}, indent=2, sort_keys=True))
    return 0 if summary["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
