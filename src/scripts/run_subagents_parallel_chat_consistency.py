#!/usr/bin/env python3
"""
Run a headless Open WebUI load test where each parent chat fans out to subagents.

Each wave:
1. creates N fresh parent chats
2. starts all completions at the same time
3. validates that every parent chat:
   - issues one or more `subagents_run_subagent` calls
   - receives successful child chat results with unique chat_ids
   - actually created resolvable child chats in the Sub-agents folder
   - finishes with a synthesized parent response in the same turn

This is intended for deep parallel load validation of parent chats plus their
subagent fan-out. The runner records continent coverage when it can infer it
from the parent prompts, but it does not fail the run if the model chooses a
different fan-out shape than expected.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import html
import json
import re
import statistics
import threading
import time
import traceback
from typing import Any

from run_google_workspace_chat_consistency import (
    MODEL,
    OWUIClient,
    _detect_openwebui_base_url,
    _restart_counts,
)

PROMPT = (
    "For each continent, start a subagent in parallel. Each subagent should choose "
    "5 countries from the continent it is responsible for and write a short poem "
    "about the country. After they're all done, synthesize a complete cohesive "
    "poem about all the chosen countries."
)

DEFAULT_PARALLELISM = 10
DEFAULT_WAVES = 10
DEFAULT_CHAT_TIMEOUT_SECONDS = 600
DEFAULT_HTTP_TIMEOUT_SECONDS = 120.0

EXPECTED_CONTINENT_LABELS = {
    "AFRICA": "Africa",
    "ANTARCTICA": "Antarctica",
    "ASIA": "Asia",
    "EUROPE": "Europe",
    "NORTH AMERICA": "North America",
    "SOUTH AMERICA": "South America",
    "OCEANIA/AUSTRALIA": "Oceania/Australia",
}


def _normalize_continent_label(raw: str | None) -> str | None:
    if not isinstance(raw, str):
        return None
    text = raw.strip()
    if not text:
        return None
    upper = re.sub(r"\s+", " ", text.upper())
    if upper.startswith("AFRICA"):
        return "AFRICA"
    if upper.startswith("ANTARCTICA"):
        return "ANTARCTICA"
    if upper.startswith("ASIA"):
        return "ASIA"
    if upper.startswith("EUROPE"):
        return "EUROPE"
    if upper.startswith("NORTH AMERICA"):
        return "NORTH AMERICA"
    if upper.startswith("SOUTH AMERICA"):
        return "SOUTH AMERICA"
    if upper.startswith("OCEANIA"):
        return "OCEANIA/AUSTRALIA"
    return None


def _decode_embedded_json(value: str | None) -> Any:
    if not value:
        return None
    text = html.unescape(value)
    try:
        decoded = json.loads(text)
    except json.JSONDecodeError:
        return text
    if isinstance(decoded, str):
        try:
            return json.loads(decoded)
        except json.JSONDecodeError:
            return decoded
    return decoded


def _parse_tool_calls(content: str) -> list[dict[str, Any]]:
    tool_calls: list[dict[str, Any]] = []
    for attrs_blob in re.findall(r'<details\s+type="tool_calls"\s+([^>]*)>', content or ""):
        attrs = {
            key: value
            for key, value in re.findall(r'([a-zA-Z_]+)="([^"]*)"', attrs_blob)
        }
        name = html.unescape(attrs.get("name", ""))
        duration_raw = attrs.get("duration", "0")
        try:
            duration = float(duration_raw)
        except ValueError:
            duration = 0.0
        tool_calls.append(
            {
                "id": attrs.get("id"),
                "name": name,
                "duration_seconds": duration,
                "arguments": _decode_embedded_json(attrs.get("arguments")),
                "result": _decode_embedded_json(attrs.get("result")),
            }
        )
    return tool_calls


def _strip_details_blocks(content: str) -> str:
    without_details = re.sub(r"<details\b.*?</details>", "", content or "", flags=re.DOTALL)
    without_tags = re.sub(r"<[^>]+>", "", without_details)
    return html.unescape(without_tags).strip()


def _continent_from_subagent_prompt(prompt: str | None) -> str | None:
    if not isinstance(prompt, str):
        return None
    for label in EXPECTED_CONTINENT_LABELS:
        if label in {"NORTH AMERICA", "SOUTH AMERICA"}:
            continue
        if re.search(rf"\b{re.escape(label)}\b", prompt, flags=re.IGNORECASE):
            return label
    if re.search(r"\bNORTH AMERICA\b", prompt, flags=re.IGNORECASE):
        return "NORTH AMERICA"
    if re.search(r"\bSOUTH AMERICA\b", prompt, flags=re.IGNORECASE):
        return "SOUTH AMERICA"

    patterns = [
        r"You are assigned to (.+?)\.",
        r"You are responsible for (.+?)\.",
        r"You are the (.+?) continent specialist\.",
        r"You are the (.+?) continent poet\.",
    ]
    for pattern in patterns:
        match = re.search(pattern, prompt, flags=re.IGNORECASE)
        if not match:
            continue
        raw = match.group(1).strip()
        if raw.upper().endswith(" CONTINENT"):
            raw = raw[: -len(" CONTINENT")].strip()
        return _normalize_continent_label(raw)
    return None


def _subagent_folder_id(client: OWUIClient) -> str:
    return client.ensure_folder("Sub-agents")


def _validate_parent_chat(
    *,
    client: OWUIClient,
    subagents_folder_id: str,
    chat_id: str,
    assistant_html: str,
) -> dict[str, Any]:
    tool_calls = _parse_tool_calls(assistant_html)
    tool_names = [call["name"] for call in tool_calls]
    subagent_calls = [call for call in tool_calls if call["name"] == "subagents_run_subagent"]
    failures: list[str] = []

    if tool_names != ["subagents_run_subagent"] * len(tool_names):
        failures.append(f"unexpected parent tool sequence: {tool_names}")

    if not subagent_calls:
        failures.append("expected at least one subagents_run_subagent call")

    seen_continents: list[str] = []
    unparsed_subagent_prompts: list[str] = []
    child_chat_ids: list[str] = []
    child_task_ids: list[str] = []
    child_durations: list[float] = []

    for call in subagent_calls:
        args = call.get("arguments")
        result = call.get("result")
        if not isinstance(args, dict):
            failures.append("subagents_run_subagent arguments were not structured JSON")
            continue
        if not isinstance(result, dict):
            failures.append("subagents_run_subagent result was not structured JSON")
            continue

        continent = _continent_from_subagent_prompt(args.get("prompt"))
        if not continent:
            if isinstance(args.get("prompt"), str):
                unparsed_subagent_prompts.append(args["prompt"])
        else:
            seen_continents.append(continent)

        parent_tool_call_id = args.get("parent_tool_call_id")
        if parent_tool_call_id != call.get("id"):
            failures.append(
                f"parent_tool_call_id mismatch for {continent or 'unknown'}: "
                f"{parent_tool_call_id!r} != {call.get('id')!r}"
            )

        if not result.get("success") or result.get("error"):
            failures.append(
                f"subagent call for {continent or 'unknown'} did not succeed: {result}"
            )

        child_chat_id = result.get("chat_id")
        if not isinstance(child_chat_id, str) or not child_chat_id:
            failures.append(f"subagent call for {continent or 'unknown'} did not return chat_id")
        else:
            child_chat_ids.append(child_chat_id)

        child_task_id = result.get("task_id")
        if isinstance(child_task_id, str) and child_task_id:
            child_task_ids.append(child_task_id)

        if not isinstance(result.get("response"), str) or not result["response"].strip():
            failures.append(f"subagent call for {continent or 'unknown'} returned empty response")

        child_durations.append(call["duration_seconds"])

    if len(set(child_chat_ids)) != len(child_chat_ids):
        failures.append(f"duplicate child chat_ids detected: {child_chat_ids}")

    child_chat_summaries: list[dict[str, Any]] = []
    for child_chat_id in child_chat_ids:
        try:
            child_chat = client.get_chat(child_chat_id)
        except Exception as exc:
            failures.append(f"failed to fetch child chat {child_chat_id}: {exc}")
            continue

        folder_id = child_chat.get("folder_id")
        if folder_id != subagents_folder_id:
            failures.append(
                f"child chat {child_chat_id} has folder_id={folder_id!r}, "
                f"expected {subagents_folder_id!r}"
            )

        child_messages = child_chat.get("chat", {}).get("history", {}).get("messages", {})
        assistant_messages = [
            message
            for message in child_messages.values()
            if isinstance(message, dict) and message.get("role") == "assistant"
        ]
        done_assistants = [
            message
            for message in assistant_messages
            if str(message.get("done")).lower() == "true" or message.get("done") is True
        ]
        if not done_assistants:
            failures.append(f"child chat {child_chat_id} has no completed assistant message")

        child_chat_summaries.append(
            {
                "chat_id": child_chat_id,
                "folder_id": folder_id,
                "assistant_message_count": len(assistant_messages),
                "done_assistant_count": len(done_assistants),
            }
        )

    final_text = _strip_details_blocks(assistant_html)
    if len(final_text) < 400:
        failures.append(
            f"parent synthesized response was unexpectedly short ({len(final_text)} chars)"
        )

    return {
        "perfect": not failures,
        "failures": failures,
        "tool_names": tool_names,
        "tool_calls": tool_calls,
        "subagent_call_count": len(subagent_calls),
        "subagent_durations": child_durations,
        "continent_assignments": seen_continents,
        "unparsed_subagent_prompt_count": len(unparsed_subagent_prompts),
        "child_chat_ids": child_chat_ids,
        "child_task_ids": child_task_ids,
        "child_chat_summaries": child_chat_summaries,
        "final_text_chars": len(final_text),
        "visible_continent_mentions": [
            label
            for label in EXPECTED_CONTINENT_LABELS.values()
            if label.lower() in final_text.lower()
        ],
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
        with OWUIClient(
            base_url=base_url,
            token=token,
            timeout=DEFAULT_HTTP_TIMEOUT_SECONDS,
        ) as client:
            subagents_folder_id = _subagent_folder_id(client)
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

    verdict = _validate_parent_chat(
        client=client,
        subagents_folder_id=subagents_folder_id,
        chat_id=chat_id,
        assistant_html=completion.get("content", ""),
    )
    verdict["slot"] = slot
    verdict["chat_id"] = chat_id
    verdict["elapsed_seconds"] = elapsed
    return verdict


def _create_wave_chats(
    *,
    base_url: str,
    token: str,
    parallelism: int,
    prompt: str,
    model: str,
) -> list[dict[str, str]]:
    with OWUIClient(
        base_url=base_url,
        token=token,
        timeout=DEFAULT_HTTP_TIMEOUT_SECONDS,
    ) as client:
        return [client.create_chat(model=model, prompt=prompt) for _ in range(parallelism)]


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
    elapsed_values = [
        result["elapsed_seconds"]
        for result in results
        if isinstance(result.get("elapsed_seconds"), (int, float))
    ]
    subagent_durations = [
        duration
        for result in results
        for duration in result.get("subagent_durations", [])
    ]
    total_child_chats = sum(len(result.get("child_chat_ids", [])) for result in results)
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
        "wall_clock_seconds": round(time.time() - started, 1),
        "parent_chat_count": len(results),
        "total_subagent_calls": sum(result.get("subagent_call_count", 0) for result in results),
        "total_child_chats": total_child_chats,
        "subagent_duration_max_seconds": round(max(subagent_durations), 1)
        if subagent_durations
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
    args = parser.parse_args()

    base_url = _detect_openwebui_base_url()
    with OWUIClient(base_url=base_url, timeout=DEFAULT_HTTP_TIMEOUT_SECONDS) as client:
        token = client.token

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
    successful_waves = sum(1 for result in wave_results if result["summary"]["success"])
    summary = {
        "requested_waves": args.waves,
        "parallelism": args.parallelism,
        "completed_waves": len(wave_results),
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
