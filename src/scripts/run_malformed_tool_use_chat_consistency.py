#!/usr/bin/env python3
"""Exercise malformed tool-use recovery through real headless OpenWebUI chats."""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import subprocess
import threading
import time
import traceback
from pathlib import Path
from typing import Any

from malformed_tool_use_diagnostics import (
    MALFORMED_TOOL_USE_KIND,
    annotate_cross_chat_overlaps,
    identity_mismatches,
    load_bridge_failure_events,
    summarize_debug_request,
)
from run_google_workspace_chat_consistency import (
    OWUIClient,
    _detect_openwebui_base_url,
    _parse_tool_calls,
    _wait_for_main_request_details,
    ensure_debug_monitor_healthy,
)


REPO_ROOT = Path(__file__).resolve().parents[2]
REPORTING_ERRORS_DIR = Path(
    os.getenv(
        "PORTICO_COST_REPORTING_HOST_DIR",
        str(REPO_ROOT / "open-webui-data" / "reporting"),
    )
) / "errors"

MODEL = "Atlas Opus 4.8"
PROMPT = """
Use the code-execution skill and Agent VM. Perform these as three separate,
sequential agent_vm_bash calls; do not combine them into one shell command:
1. Create /work/malformed-tool-use-step-1.txt containing the integer 17.
2. In a later call, read that file and create /work/malformed-tool-use-step-2.txt
   containing twice the value you read.
3. In a later call, verify both files and print exactly DIAGNOSTIC_SEQUENCE_COMPLETE.
After all three calls succeed, reply with exactly DIAGNOSTIC_SEQUENCE_COMPLETE.
""".strip()

DEFAULT_SERIAL_RUNS = 10
DEFAULT_WAVES = 5
DEFAULT_PARALLELISM = 4
DEFAULT_TIMEOUT_SECONDS = 600


def _ensure_owui_auth_bridge_secret() -> None:
    if os.getenv("OWUI_AUTH_BRIDGE_SECRET") or os.getenv("OWUI_AUTH_BRIDGE_SECRET_FILE"):
        return
    inspect = subprocess.run(
        [
            "docker",
            "inspect",
            "portico-open-webui",
            "--format",
            "{{range .Config.Env}}{{println .}}{{end}}",
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
    secret_file = ""
    for line in inspect.stdout.splitlines():
        if line.startswith("OWUI_AUTH_BRIDGE_SECRET_FILE="):
            secret_file = line.split("=", 1)[1].strip()
            break
    if not secret_file:
        raise RuntimeError("portico-open-webui did not expose its auth bridge secret file")
    result = subprocess.run(
        [
            "docker",
            "exec",
            "portico-open-webui",
            "sh",
            "-lc",
            'cat "$1"',
            "sh",
            secret_file,
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
    secret = result.stdout.strip()
    if not secret:
        raise RuntimeError("OpenWebUI auth bridge secret file was empty")
    os.environ["OWUI_AUTH_BRIDGE_SECRET"] = secret


def _create_chat(base_url: str, token: str, model: str, prompt: str) -> dict[str, str]:
    with OWUIClient(base_url=base_url, token=token) as client:
        return client.create_chat(model=model, prompt=prompt)


def _run_chat(
    *,
    slot: str,
    mode: str,
    base_url: str,
    token: str,
    model: str,
    prompt: str,
    chat_spec: dict[str, str],
    timeout_seconds: int,
    start_barrier: threading.Barrier | None = None,
) -> dict[str, Any]:
    chat_id = chat_spec["chat_id"]
    user_message_id = chat_spec["user_message_id"]
    started = time.time()
    generation: dict[str, Any] = {}
    completion: dict[str, Any] = {}
    collection_error: str | None = None
    try:
        with OWUIClient(base_url=base_url, token=token) as client:
            if start_barrier is not None:
                start_barrier.wait()
            generation = client.generate_completion(
                chat_id=chat_id,
                model=model,
                prompt=prompt,
                user_message_id=user_message_id,
                stream=True,
                reasoning_effort="max",
            )
            completion = client.poll_for_completion(
                chat_id=chat_id,
                user_message_id=user_message_id,
                timeout_seconds=timeout_seconds,
                poll_interval=2,
            )
    except Exception as exc:  # pragma: no cover - live diagnostic path
        collection_error = f"chat execution failed: {type(exc).__name__}: {exc}"

    request_summaries: list[dict[str, Any]] = []
    try:
        request_details = _wait_for_main_request_details(
            chat_id,
            expected_main_request_count=1,
            timeout_seconds=min(timeout_seconds, 120),
        )
        request_summaries = [
            summarize_debug_request(detail) for detail in request_details
        ]
    except Exception as exc:  # pragma: no cover - live diagnostic path
        message = f"request trace collection failed: {type(exc).__name__}: {exc}"
        collection_error = f"{collection_error}; {message}" if collection_error else message

    assistant_html = completion.get("content") if isinstance(completion, dict) else ""
    tool_calls = _parse_tool_calls(assistant_html if isinstance(assistant_html, str) else "")
    tool_names = [
        str(call.get("name"))
        for call in tool_calls
        if isinstance(call, dict) and call.get("name")
    ]
    bash_call_count = sum(name == "agent_vm_bash" for name in tool_names)
    return {
        "slot": slot,
        "mode": mode,
        "chat_id": chat_id,
        "session_id": generation.get("session_id"),
        "message_id": generation.get("message_id"),
        "elapsed_seconds": round(time.time() - started, 1),
        "completion_status": "complete" if completion.get("complete") else "error",
        "collection_error": collection_error,
        "tool_names": tool_names,
        "agent_vm_bash_call_count": bash_call_count,
        "scenario_conformant": (
            completion.get("complete") is True
            and bash_call_count >= 3
            and "DIAGNOSTIC_SEQUENCE_COMPLETE" in (assistant_html or "")
        ),
        "requests": request_summaries,
    }


def _run_parallel_wave(
    *,
    wave: int,
    base_url: str,
    token: str,
    model: str,
    prompt: str,
    parallelism: int,
    timeout_seconds: int,
) -> list[dict[str, Any]]:
    chat_specs = [
        _create_chat(base_url, token, model, prompt) for _ in range(parallelism)
    ]
    barrier = threading.Barrier(parallelism + 1)
    results: list[dict[str, Any]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=parallelism) as executor:
        futures = [
            executor.submit(
                _run_chat,
                slot=f"parallel-{wave}-{index}",
                mode="parallel",
                base_url=base_url,
                token=token,
                model=model,
                prompt=prompt,
                chat_spec=chat_spec,
                timeout_seconds=timeout_seconds,
                start_barrier=barrier,
            )
            for index, chat_spec in enumerate(chat_specs, start=1)
        ]
        barrier.wait()
        for future in concurrent.futures.as_completed(futures):
            try:
                results.append(future.result())
            except Exception as exc:  # pragma: no cover - live diagnostic path
                results.append(
                    {
                        "slot": "parallel-worker",
                        "mode": "parallel",
                        "collection_error": f"worker failed: {type(exc).__name__}: {exc}",
                        "traceback": traceback.format_exc(limit=3),
                        "requests": [],
                    }
                )
    return sorted(results, key=lambda item: str(item.get("slot") or ""))


def _classify_full_stack(
    chats: list[dict[str, Any]],
    requests: list[dict[str, Any]],
    bridge_failures: list[dict[str, Any]],
    mismatches: list[dict[str, Any]],
) -> str:
    malformed_bridge = [
        event
        for event in bridge_failures
        if event.get("failure_kind") == MALFORMED_TOOL_USE_KIND
    ]
    malformed_debug = [request for request in requests if request.get("malformed_tool_use")]
    if mismatches and (malformed_bridge or malformed_debug):
        return "local_isolation_bug"
    if malformed_bridge:
        mode_by_chat = {chat.get("chat_id"): chat.get("mode") for chat in chats}
        modes = {mode_by_chat.get(event.get("chat_id")) for event in malformed_bridge}
        if modes == {"parallel"}:
            return "concurrency_sensitive_upstream_event_sequence"
        return "upstream_event_sequence_concurrency_not_required"
    if malformed_debug:
        return "openwebui_or_bridge_translation"
    return "inconclusive_no_reproduction"


def run(args: argparse.Namespace) -> dict[str, Any]:
    ensure_debug_monitor_healthy()
    _ensure_owui_auth_bridge_secret()
    base_url = _detect_openwebui_base_url()
    with OWUIClient(base_url=base_url) as client:
        token = client.token

    run_started_ms = int(time.time() * 1000)
    chats: list[dict[str, Any]] = []
    for index in range(1, args.serial_runs + 1):
        chat_spec = _create_chat(base_url, token, args.model, args.prompt)
        chats.append(
            _run_chat(
                slot=f"serial-{index}",
                mode="serial",
                base_url=base_url,
                token=token,
                model=args.model,
                prompt=args.prompt,
                chat_spec=chat_spec,
                timeout_seconds=args.timeout_seconds,
            )
        )

    for wave in range(1, args.waves + 1):
        chats.extend(
            _run_parallel_wave(
                wave=wave,
                base_url=base_url,
                token=token,
                model=args.model,
                prompt=args.prompt,
                parallelism=args.parallelism,
                timeout_seconds=args.timeout_seconds,
            )
        )

    # Parallel chats can finish before the debug monitor has settled all request
    # details. Rehydrate trace-only failures after the wave has quiesced instead
    # of treating that ingestion lag as a chat failure.
    for chat in chats:
        if (
            not chat.get("collection_error")
            or chat.get("completion_status") != "complete"
            or not chat.get("chat_id")
        ):
            continue
        try:
            request_details = _wait_for_main_request_details(
                str(chat["chat_id"]),
                expected_main_request_count=1,
                timeout_seconds=min(args.timeout_seconds, 180),
            )
            chat["requests"] = [
                summarize_debug_request(detail) for detail in request_details
            ]
            chat["collection_error"] = None
        except Exception:
            pass

    requests = [request for chat in chats for request in chat.get("requests", [])]
    requests = annotate_cross_chat_overlaps(requests)
    for chat in chats:
        chat["requests"] = [
            request for request in requests if request.get("chat_id") == chat.get("chat_id")
        ]

    expected = {
        str(chat["chat_id"]): {
            "session_id": str(chat.get("session_id") or ""),
            "message_id": str(chat.get("message_id") or ""),
        }
        for chat in chats
        if chat.get("chat_id")
    }
    mismatches = identity_mismatches(requests, expected)
    chat_ids = set(expected)
    bridge_failures = load_bridge_failure_events(
        REPORTING_ERRORS_DIR,
        chat_ids=chat_ids,
        not_before_ms=run_started_ms,
    )
    classification = _classify_full_stack(
        chats, requests, bridge_failures, mismatches
    )
    malformed_request_ids = [
        request.get("request_id")
        for request in requests
        if request.get("malformed_tool_use")
    ]
    malformed_event_ids = [
        event.get("event_id")
        for event in bridge_failures
        if event.get("failure_kind") == MALFORMED_TOOL_USE_KIND
    ]
    return {
        "diagnostic": "malformed_tool_use_full_stack",
        "model": args.model,
        "serial_runs": args.serial_runs,
        "waves": args.waves,
        "parallelism": args.parallelism,
        "classification": classification,
        "chat_count": len(chats),
        "scenario_conformant_chat_count": sum(
            chat.get("scenario_conformant") is True for chat in chats
        ),
        "collection_error_count": sum(bool(chat.get("collection_error")) for chat in chats),
        "identity_mismatches": mismatches,
        "malformed_request_ids": malformed_request_ids,
        "malformed_bridge_event_ids": malformed_event_ids,
        "bridge_failures": bridge_failures,
        "chats": chats,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--serial-runs", type=int, default=DEFAULT_SERIAL_RUNS)
    parser.add_argument("--waves", type=int, default=DEFAULT_WAVES)
    parser.add_argument("--parallelism", type=int, default=DEFAULT_PARALLELISM)
    parser.add_argument("--timeout-seconds", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--model", default=MODEL)
    parser.add_argument("--prompt", default=PROMPT)
    args = parser.parse_args()

    if args.serial_runs < 0 or args.waves < 0 or args.parallelism < 1:
        parser.error("serial-runs and waves must be non-negative; parallelism must be positive")

    try:
        result = run(args)
    except Exception as exc:  # pragma: no cover - live diagnostic path
        print(
            json.dumps(
                {
                    "diagnostic": "malformed_tool_use_full_stack",
                    "fatal_error": f"{type(exc).__name__}: {exc}",
                },
                indent=2,
                sort_keys=True,
            )
        )
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 1 if result["collection_error_count"] or result["identity_mismatches"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
