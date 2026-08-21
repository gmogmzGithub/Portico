#!/usr/bin/env python3
"""
Run the Google Workspace headless OWUI scenario in parallel waves.

Each wave:
1. forces the shared google_workspace integration back to the disabled precondition
2. creates N fresh chats
3. starts all completions at the same time
4. verifies that every chat succeeds end-to-end in the same turn

This runner is stricter than a generic smoke test but looser than the single-chat
"perfect run" contract: under parallel load, only one chat may need to toggle the
shared server while the others can legitimately skip straight to activation once
the server is already tool-ready.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import statistics
import threading
import time
import traceback
from typing import Any

from run_google_workspace_chat_consistency import (
    MODEL,
    PROMPT,
    OWUIClient,
    _detect_openwebui_base_url,
    _restart_counts,
    _validate_perfect_run,
    ensure_disabled_precondition,
)

DEFAULT_PARALLELISM = 10
DEFAULT_WAVES = 10
DEFAULT_CHAT_TIMEOUT_SECONDS = 300
DEFAULT_OWUI_READY_TIMEOUT_SECONDS = 120


def _toggle_result_error(result: Any) -> str | None:
    if not isinstance(result, dict):
        return "toggle_integration did not return a structured payload"
    error = result.get("error")
    if error:
        return str(error)
    return None


def _validate_parallel_success(chat_id: str, assistant_html: str) -> dict[str, Any]:
    base = _validate_perfect_run(chat_id, assistant_html)
    tool_calls = base["tool_calls"]
    tool_names = base["tool_names"]
    tool_durations = base["tool_durations"]
    chat_skills = base["chat_skills"]
    chat_tools = base["chat_tools"]

    failures: list[str] = []
    toggle_calls = [
        call for call in tool_calls if call["name"] == "mcp_assistant_toggle_integration"
    ]
    activate_calls = [
        call for call in tool_calls if call["name"] == "mcp_assistant_activate_integration"
    ]
    google_calls = [
        call for call in tool_calls if call["name"].startswith("google_workspace_")
    ]
    get_events_calls = [
        call for call in tool_calls if call["name"] == "google_workspace_get_events"
    ]

    if not tool_names:
        failures.append("the chat completed without any tool calls")

    if tool_names and tool_names[0] not in {
        "mcp_assistant_toggle_integration",
        "mcp_assistant_activate_integration",
    }:
        failures.append(f"unexpected first tool call: {tool_names[0]}")

    if len(toggle_calls) > 1:
        failures.append(
            f"expected at most one toggle_integration call under parallel load, saw {len(toggle_calls)}"
        )
    if toggle_calls:
        if tool_names[0] != "mcp_assistant_toggle_integration":
            failures.append("toggle_integration occurred, but it was not the first tool call")
        toggle_duration = toggle_calls[0]["duration_seconds"]
        if toggle_duration >= 15:
            failures.append(
                f"toggle_integration took {toggle_duration:.1f}s (expected < 15s)"
            )
        toggle_error = _toggle_result_error(toggle_calls[0]["result"])
        if toggle_error:
            failures.append(
                f"toggle_integration surfaced a raw error payload: {toggle_error}"
            )

    if "mcp_assistant_authorize_integration" in tool_names:
        failures.append("authorize_integration was called even though tokens already exist")

    if len(activate_calls) != 1:
        failures.append(
            f"expected exactly one activate_integration call, saw {len(activate_calls)}"
        )

    if not get_events_calls:
        failures.append(
            "expected at least one google_workspace_get_events call"
        )

    if not google_calls or any(
        call["name"] != "google_workspace_get_events" for call in google_calls
    ):
        failures.append(
            f"unexpected Google Workspace tool sequence: {[call['name'] for call in google_calls]}"
        )

    if activate_calls and google_calls:
        activate_index = tool_names.index("mcp_assistant_activate_integration")
        first_google_index = next(
            (
                index
                for index, name in enumerate(tool_names)
                if name.startswith("google_workspace_")
            ),
            None,
        )
        if first_google_index is None or first_google_index <= activate_index:
            failures.append(
                "google_workspace_get_events was called before activate_integration completed"
            )

    if "google-workspace" not in chat_skills:
        failures.append("google-workspace skill was not auto-activated")

    if "server:google_workspace" not in chat_tools:
        failures.append("server:google_workspace was not activated for the chat")

    activate_result = activate_calls[0]["result"] if activate_calls else None
    if not isinstance(activate_result, dict) or not activate_result.get("success"):
        failures.append("activate_integration did not succeed")

    if any(
        not isinstance(call.get("result"), dict) or call["result"].get("error")
        for call in get_events_calls
    ):
        failures.append("one or more google_workspace_get_events calls surfaced an error")

    if not tool_names[:2] in [
        ["mcp_assistant_activate_integration", "google_workspace_get_events"],
        [
            "mcp_assistant_toggle_integration",
            "mcp_assistant_activate_integration",
        ],
    ] and not tool_names[:3] == [
        "mcp_assistant_toggle_integration",
        "mcp_assistant_activate_integration",
        "google_workspace_get_events",
    ]:
        failures.append(f"unexpected initial tool sequence: {tool_names[:3]}")

    return {
        "perfect": not failures,
        "failures": failures,
        "tool_names": tool_names,
        "tool_durations": tool_durations,
        "tool_calls": tool_calls,
        "chat_skills": chat_skills,
        "chat_tools": chat_tools,
        "toggled": bool(toggle_calls),
    }


def _run_single_chat(
    *,
    slot: int,
    base_url: str,
    token: str,
    model: str,
    prompt: str,
    chat_id: str,
    user_message_id: str,
    start_barrier: threading.Barrier,
    timeout_seconds: int,
) -> dict[str, Any]:
    try:
        with OWUIClient(base_url=base_url, token=token) as client:
            start_barrier.wait()
            started = time.time()
            client.generate_completion(
                chat_id=chat_id,
                model=model,
                prompt=prompt,
                user_message_id=user_message_id,
                stream=True,
            )
            completion = client.poll_for_completion(
                chat_id=chat_id,
                user_message_id=user_message_id,
                timeout_seconds=timeout_seconds,
                poll_interval=2,
            )
            elapsed = round(time.time() - started, 1)
    except Exception as exc:
        return {
            "slot": slot,
            "chat_id": chat_id,
            "perfect": False,
            "elapsed_seconds": None,
            "failures": [f"worker exception: {exc}"],
            "traceback": traceback.format_exc(),
        }

    if not completion.get("complete"):
        return {
            "slot": slot,
            "chat_id": chat_id,
            "perfect": False,
            "elapsed_seconds": elapsed,
            "failures": [completion.get("error", "chat did not complete")],
        }

    verdict = _validate_parallel_success(chat_id, completion.get("content", ""))
    verdict["slot"] = slot
    verdict["chat_id"] = chat_id
    verdict["elapsed_seconds"] = elapsed
    return verdict


def _wait_for_owui_token(base_url: str, timeout_seconds: int = DEFAULT_OWUI_READY_TIMEOUT_SECONDS) -> str:
    """Wait for Open WebUI auth routes to become stable enough to issue a token."""
    deadline = time.time() + timeout_seconds
    last_error: Exception | None = None

    while time.time() < deadline:
        try:
            with OWUIClient(base_url=base_url) as client:
                return client.token
        except Exception as exc:
            last_error = exc
            time.sleep(2)

    raise RuntimeError(
        f"Open WebUI did not become auth-ready within {timeout_seconds}s: {last_error}"
    )


def _create_wave_chats(
    *,
    base_url: str,
    token: str,
    parallelism: int,
    prompt: str,
    model: str,
) -> list[dict[str, str]]:
    with OWUIClient(base_url=base_url, token=token) as client:
        return [
            client.create_chat(model=model, prompt=prompt)
            for _ in range(parallelism)
        ]


def run_wave(
    *,
    wave: int,
    base_url: str,
    token: str,
    parallelism: int,
    prompt: str,
    model: str,
    timeout_seconds: int,
) -> dict[str, Any]:
    ensure_disabled_precondition()
    chat_specs = _create_wave_chats(
        base_url=base_url,
        token=token,
        parallelism=parallelism,
        prompt=prompt,
        model=model,
    )

    started = time.time()
    start_barrier = threading.Barrier(parallelism + 1)
    results: list[dict[str, Any]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=parallelism) as executor:
        futures = [
            executor.submit(
                _run_single_chat,
                slot=index,
                base_url=base_url,
                token=token,
                model=model,
                prompt=prompt,
                chat_id=chat_spec["chat_id"],
                user_message_id=chat_spec["user_message_id"],
                start_barrier=start_barrier,
                timeout_seconds=timeout_seconds,
            )
            for index, chat_spec in enumerate(chat_specs, start=1)
        ]
        start_barrier.wait()
        for future in concurrent.futures.as_completed(futures):
            results.append(future.result())

    results.sort(key=lambda result: result["slot"])
    wall_clock_seconds = round(time.time() - started, 1)
    elapsed_values = [
        result["elapsed_seconds"]
        for result in results
        if isinstance(result.get("elapsed_seconds"), (int, float))
    ]
    toggle_durations = [
        call["duration_seconds"]
        for result in results
        for call in result.get("tool_calls", [])
        if call["name"] == "mcp_assistant_toggle_integration"
    ]
    failures = [
        {
            "slot": result["slot"],
            "chat_id": result.get("chat_id"),
            "failures": result.get("failures", []),
        }
        for result in results
        if not result.get("perfect")
    ]
    summary = {
        "wave": wave,
        "parallelism": parallelism,
        "success": not failures,
        "wall_clock_seconds": wall_clock_seconds,
        "toggle_count": sum(1 for result in results if result.get("toggled")),
        "toggle_duration_max_seconds": round(max(toggle_durations), 1)
        if toggle_durations
        else 0.0,
        "chat_elapsed_min_seconds": round(min(elapsed_values), 1)
        if elapsed_values
        else None,
        "chat_elapsed_p50_seconds": round(statistics.median(elapsed_values), 1)
        if elapsed_values
        else None,
        "chat_elapsed_max_seconds": round(max(elapsed_values), 1)
        if elapsed_values
        else None,
        "chat_ids": [result.get("chat_id") for result in results],
        "failures": failures,
    }
    return {"wave": wave, "summary": summary, "results": results}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--waves", type=int, default=DEFAULT_WAVES)
    parser.add_argument("--parallelism", type=int, default=DEFAULT_PARALLELISM)
    parser.add_argument("--prompt", default=PROMPT)
    parser.add_argument("--model", default=MODEL)
    parser.add_argument("--timeout-seconds", type=int, default=DEFAULT_CHAT_TIMEOUT_SECONDS)
    parser.add_argument("--owui-ready-timeout-seconds", type=int, default=DEFAULT_OWUI_READY_TIMEOUT_SECONDS)
    args = parser.parse_args()

    base_url = _detect_openwebui_base_url()
    token = _wait_for_owui_token(
        base_url=base_url,
        timeout_seconds=args.owui_ready_timeout_seconds,
    )

    restart_counts_before = _restart_counts()
    print(json.dumps({"restart_counts_before": restart_counts_before}, indent=2))

    wave_results = []
    for wave in range(1, args.waves + 1):
        result = run_wave(
            wave=wave,
            base_url=base_url,
            token=token,
            parallelism=args.parallelism,
            prompt=args.prompt,
            model=args.model,
            timeout_seconds=args.timeout_seconds,
        )
        wave_results.append(result)
        print(json.dumps(result, indent=2, sort_keys=True))
        if not result["summary"]["success"]:
            break

    restart_counts_after = _restart_counts()
    completed_waves = len(wave_results)
    successful_waves = sum(1 for result in wave_results if result["summary"]["success"])
    summary = {
        "requested_waves": args.waves,
        "parallelism": args.parallelism,
        "completed_waves": completed_waves,
        "successful_waves": successful_waves,
        "restart_counts_before": restart_counts_before,
        "restart_counts_after": restart_counts_after,
        "success": successful_waves == args.waves
        and restart_counts_before == restart_counts_after,
        "wave_chat_ids": [
            {
                "wave": result["wave"],
                "chat_ids": result["summary"]["chat_ids"],
            }
            for result in wave_results
        ],
    }
    print(json.dumps({"summary": summary}, indent=2, sort_keys=True))
    return 0 if summary["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
