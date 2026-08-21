#!/usr/bin/env python3
"""A/B-test signed reasoning replay directly through the local Bedrock bridge."""

from __future__ import annotations

import argparse
import concurrent.futures
import copy
import json
import os
import random
import subprocess
import threading
import uuid
from typing import Any

import httpx

from malformed_tool_use_diagnostics import (
    BEDROCK_MALFORMED_TOOL_USE_CODE,
    TOOL_TERMINAL_REASONS,
    classify_ab_results,
    sanitize_probe_outcome,
)


MODEL = "us.anthropic.claude-opus-4-8"
DEFAULT_SERIAL_PAIRS = 20
DEFAULT_WAVES = 5
DEFAULT_PARALLELISM = 4
DEFAULT_MAX_INITIAL_ATTEMPTS = 4
DEFAULT_TIMEOUT_SECONDS = 180
DEFAULT_RANDOM_SEED = 20260622

SYSTEM_PROMPT = (
    "This is a synthetic tool protocol diagnostic. Never use real user or employee data."
)
USER_PROMPT = (
    "Call diagnostic_step with step=1. After its result, call diagnostic_step again "
    "with step=2 before answering. Use one tool call at a time."
)
TOOL = {
    "name": "diagnostic_step",
    "description": "Advance a synthetic two-step protocol diagnostic.",
    "input_schema": {
        "type": "object",
        "properties": {"step": {"type": "integer", "enum": [1, 2]}},
        "required": ["step"],
        "additionalProperties": False,
    },
}


def _detect_gateway_base_url() -> str:
    configured = os.getenv("LLM_GATEWAY_BASE_URL", "").strip()
    if configured:
        return configured.rstrip("/")
    result = subprocess.run(
        ["docker", "port", "llm-gateway", "4000/tcp"],
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
    address = result.stdout.strip().splitlines()[0]
    host, port = address.rsplit(":", 1)
    host = host.strip("[]")
    if host in {"0.0.0.0", "::", ""}:
        host = "127.0.0.1"
    return f"http://{host}:{port}"


def _bridge_token() -> str:
    configured = os.getenv("BIFROST_BRIDGE_LOCAL_API_KEY", "").strip()
    if configured:
        return configured
    inspect = subprocess.run(
        [
            "docker",
            "inspect",
            "llm-gateway",
            "--format",
            "{{range .Config.Env}}{{println .}}{{end}}",
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
    token_file = ""
    for line in inspect.stdout.splitlines():
        if line.startswith("BIFROST_BRIDGE_LOCAL_API_KEY_FILE="):
            token_file = line.split("=", 1)[1].strip()
            break
    if not token_file:
        raise RuntimeError("llm-gateway did not expose its local API key file")
    result = subprocess.run(
        ["docker", "exec", "llm-gateway", "sh", "-lc", 'cat "$1"', "sh", token_file],
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
    token = result.stdout.strip()
    if not token:
        raise RuntimeError("llm-gateway local API key file was empty")
    return token


def _append_delta(block: dict[str, Any], delta: dict[str, Any]) -> None:
    delta_type = delta.get("type")
    if delta_type == "thinking_delta":
        block["thinking"] = str(block.get("thinking") or "") + str(
            delta.get("thinking") or ""
        )
    elif delta_type == "signature_delta":
        block["signature"] = str(block.get("signature") or "") + str(
            delta.get("signature") or ""
        )
    elif delta_type == "text_delta":
        block["text"] = str(block.get("text") or "") + str(delta.get("text") or "")
    elif delta_type == "input_json_delta":
        block["_partial_json"] = str(block.get("_partial_json") or "") + str(
            delta.get("partial_json") or ""
        )


def _finalize_block(block: dict[str, Any]) -> None:
    partial = block.pop("_partial_json", None)
    if partial is None:
        return
    try:
        block["input"] = json.loads(partial) if partial else {}
    except json.JSONDecodeError:
        block["input"] = {}


def _stream_anthropic(
    client: httpx.Client,
    *,
    url: str,
    token: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    blocks: dict[int, dict[str, Any]] = {}
    current_event = ""
    stop_reason = ""
    error_code = ""
    message_stop_seen = False
    with client.stream(
        "POST",
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Anthropic-Version": "2023-06-01",
            "Content-Type": "application/json",
        },
        json=payload,
    ) as response:
        response.raise_for_status()
        for raw_line in response.iter_lines():
            line = raw_line.strip()
            if not line:
                current_event = ""
                continue
            if line.startswith("event:"):
                current_event = line.split(":", 1)[1].strip()
                continue
            if not line.startswith("data:"):
                continue
            raw_data = line.split(":", 1)[1].strip()
            if not raw_data or raw_data == "[DONE]":
                continue
            try:
                event = json.loads(raw_data)
            except json.JSONDecodeError:
                error_code = "invalid_sse_json"
                continue
            event_type = event.get("type") or current_event
            if event_type == "content_block_start":
                index = int(event.get("index") or 0)
                content_block = event.get("content_block")
                blocks[index] = copy.deepcopy(content_block) if isinstance(content_block, dict) else {}
            elif event_type == "content_block_delta":
                index = int(event.get("index") or 0)
                delta = event.get("delta")
                if isinstance(delta, dict):
                    _append_delta(blocks.setdefault(index, {}), delta)
            elif event_type == "content_block_stop":
                _finalize_block(blocks.setdefault(int(event.get("index") or 0), {}))
            elif event_type == "message_delta":
                delta = event.get("delta")
                if isinstance(delta, dict) and delta.get("stop_reason"):
                    stop_reason = str(delta["stop_reason"])
            elif event_type == "message_stop":
                message_stop_seen = True
            elif event_type == "error":
                error = event.get("error")
                if isinstance(error, dict):
                    error_code = str(error.get("code") or error.get("type") or "api_error")

    content_blocks = []
    for index in sorted(blocks):
        block = blocks[index]
        _finalize_block(block)
        if block.get("type"):
            content_blocks.append(block)
    tool_use_count = sum(block.get("type") == "tool_use" for block in content_blocks)
    malformed = error_code == BEDROCK_MALFORMED_TOOL_USE_CODE or (
        stop_reason.strip().lower() in TOOL_TERMINAL_REASONS and tool_use_count == 0
    )
    return {
        "stop_reason": stop_reason,
        "error_code": error_code,
        "message_stop_seen": message_stop_seen,
        "content_blocks": content_blocks,
        "malformed_tool_use": malformed,
    }


def _base_payload(model: str) -> dict[str, Any]:
    return {
        "model": model,
        "max_tokens": 4096,
        "stream": True,
        "system": SYSTEM_PROMPT,
        "thinking": {"type": "adaptive", "display": "summarized"},
        "output_config": {"effort": "max"},
        "tool_choice": {"type": "auto"},
        "tools": [copy.deepcopy(TOOL)],
        "messages": [{"role": "user", "content": USER_PROMPT}],
    }


def _eligible_initial(outcome: dict[str, Any]) -> bool:
    blocks = outcome.get("content_blocks")
    if not isinstance(blocks, list) or outcome.get("error_code"):
        return False
    tool_uses = [block for block in blocks if block.get("type") == "tool_use"]
    thinking = [
        block
        for block in blocks
        if block.get("type") == "thinking"
        and isinstance(block.get("signature"), str)
        and block["signature"].strip()
    ]
    return bool(tool_uses and thinking)


def _followup_payload(
    base: dict[str, Any], outcome: dict[str, Any], *, preserve_reasoning: bool
) -> dict[str, Any]:
    blocks = copy.deepcopy(outcome["content_blocks"])
    if not preserve_reasoning:
        blocks = [block for block in blocks if block.get("type") != "thinking"]
    tool_uses = [block for block in blocks if block.get("type") == "tool_use"]
    tool_results = [
        {
            "type": "tool_result",
            "tool_use_id": block.get("id"),
            "content": "Synthetic step 1 completed. Call diagnostic_step with step=2 now.",
        }
        for block in tool_uses
    ]
    payload = copy.deepcopy(base)
    payload["messages"] = [
        *copy.deepcopy(base["messages"]),
        {"role": "assistant", "content": blocks},
        {"role": "user", "content": tool_results},
    ]
    return payload


def _run_pair(
    *,
    pair_id: str,
    mode: str,
    base_url: str,
    token: str,
    model: str,
    timeout_seconds: int,
    max_initial_attempts: int,
    seed: int,
    start_barrier: threading.Barrier | None = None,
) -> dict[str, Any]:
    if start_barrier is not None:
        start_barrier.wait()
    url = f"{base_url}/internal/anthropic/v1/messages"
    initial: dict[str, Any] | None = None
    attempts = 0
    with httpx.Client(timeout=timeout_seconds) as client:
        for attempts in range(1, max_initial_attempts + 1):
            candidate = _stream_anthropic(
                client,
                url=url,
                token=token,
                payload=_base_payload(model),
            )
            if _eligible_initial(candidate):
                initial = candidate
                break
        if initial is None:
            return {
                "pair_id": pair_id,
                "mode": mode,
                "eligible": False,
                "initial_attempts": attempts,
                "initial": sanitize_probe_outcome(candidate),
                "variants": [],
            }

        variants = ["preserved", "stripped"]
        random.Random(seed).shuffle(variants)
        results: list[dict[str, Any]] = []
        base = _base_payload(model)
        for variant in variants:
            outcome = _stream_anthropic(
                client,
                url=url,
                token=token,
                payload=_followup_payload(
                    base,
                    initial,
                    preserve_reasoning=variant == "preserved",
                ),
            )
            results.append({"variant": variant, **sanitize_probe_outcome(outcome)})

    return {
        "pair_id": pair_id,
        "mode": mode,
        "eligible": True,
        "initial_attempts": attempts,
        "initial": sanitize_probe_outcome(initial),
        "variant_order": variants,
        "variants": results,
    }


def _parallel_wave(
    *,
    wave: int,
    parallelism: int,
    **kwargs: Any,
) -> list[dict[str, Any]]:
    barrier = threading.Barrier(parallelism + 1)
    results: list[dict[str, Any]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=parallelism) as executor:
        futures = [
            executor.submit(
                _run_pair,
                pair_id=f"parallel-{wave}-{slot}-{uuid.uuid4().hex[:8]}",
                mode="parallel",
                start_barrier=barrier,
                seed=int(kwargs["seed"]) + wave * 1000 + slot,
                **{key: value for key, value in kwargs.items() if key != "seed"},
            )
            for slot in range(1, parallelism + 1)
        ]
        barrier.wait()
        for future in concurrent.futures.as_completed(futures):
            results.append(future.result())
    return sorted(results, key=lambda result: result["pair_id"])


def run(args: argparse.Namespace) -> dict[str, Any]:
    base_url = _detect_gateway_base_url()
    token = _bridge_token()
    pairs: list[dict[str, Any]] = []
    common = {
        "base_url": base_url,
        "token": token,
        "model": args.model,
        "timeout_seconds": args.timeout_seconds,
        "max_initial_attempts": args.max_initial_attempts,
    }
    for index in range(1, args.serial_pairs + 1):
        pairs.append(
            _run_pair(
                pair_id=f"serial-{index}-{uuid.uuid4().hex[:8]}",
                mode="serial",
                seed=args.seed + index,
                **common,
            )
        )
    for wave in range(1, args.waves + 1):
        pairs.extend(
            _parallel_wave(
                wave=wave,
                parallelism=args.parallelism,
                seed=args.seed,
                **common,
            )
        )

    variant_results = [
        variant
        for pair in pairs
        if pair.get("eligible")
        for variant in pair.get("variants", [])
    ]
    classification = classify_ab_results(variant_results)
    eligible_pairs = sum(pair.get("eligible") is True for pair in pairs)
    return {
        "diagnostic": "malformed_tool_use_reasoning_ab",
        "model": args.model,
        "serial_pairs": args.serial_pairs,
        "waves": args.waves,
        "parallelism": args.parallelism,
        "pair_count": len(pairs),
        "eligible_pair_count": eligible_pairs,
        "classification": classification,
        "pairs": pairs,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--serial-pairs", type=int, default=DEFAULT_SERIAL_PAIRS)
    parser.add_argument("--waves", type=int, default=DEFAULT_WAVES)
    parser.add_argument("--parallelism", type=int, default=DEFAULT_PARALLELISM)
    parser.add_argument("--max-initial-attempts", type=int, default=DEFAULT_MAX_INITIAL_ATTEMPTS)
    parser.add_argument("--timeout-seconds", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--seed", type=int, default=DEFAULT_RANDOM_SEED)
    parser.add_argument("--model", default=MODEL)
    args = parser.parse_args()
    if (
        args.serial_pairs < 0
        or args.waves < 0
        or args.parallelism < 1
        or args.max_initial_attempts < 1
    ):
        parser.error("pair and wave counts must be non-negative; other counts must be positive")
    try:
        result = run(args)
    except Exception as exc:  # pragma: no cover - live diagnostic path
        print(
            json.dumps(
                {
                    "diagnostic": "malformed_tool_use_reasoning_ab",
                    "fatal_error_type": type(exc).__name__,
                },
                indent=2,
                sort_keys=True,
            )
        )
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["eligible_pair_count"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
