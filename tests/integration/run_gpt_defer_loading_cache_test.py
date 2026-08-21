#!/usr/bin/env python3
"""
Direct bridge test for GPT prompt caching with defer_loading and instructions hoisting.

Tests GPT-5.6 Sol by sending identical repeated Responses API requests through the
bridge with real Glean tool schemas and checking cache behavior.

Usage:
    python tests/integration/run_gpt_defer_loading_cache_test.py
"""

import json
import os
import sys
import time
from typing import Any

import httpx

BRIDGE_URL = os.getenv("BRIDGE_URL", "http://127.0.0.1:4583")
GLEAN_OPENAPI_URL = os.getenv(
    "GLEAN_OPENAPI_URL", "http://127.0.0.1:8765/glean/openapi.json"
)

SYSTEM_PROMPT = (
    "<static_context>\n"
    + "You are a helpful company assistant with access to internal tools. " * 300
    + "\n</static_context>"
)
DYNAMIC_CONTEXT = "<dynamic_context>Current time: 2026-03-15T12:00:00Z. User: test-user.</dynamic_context>"
USER_PROMPT = "What tools do you have access to? List them briefly."

# How long to wait between identical requests so the provider has time
# to commit the cache entry.
CACHE_SETTLE_SECONDS = 8
NUM_CALLS = 3


def load_glean_tools() -> list[dict]:
    """Derive chat-completions-format tool definitions from the live Glean OpenAPI spec."""
    resp = httpx.get(GLEAN_OPENAPI_URL, timeout=15)
    resp.raise_for_status()
    spec = resp.json()

    tools = []
    for _path, methods in spec.get("paths", {}).items():
        for _method, details in methods.items():
            op_id = details.get("operationId", "")
            desc = details.get("description", details.get("summary", ""))
            body = (
                details.get("requestBody", {})
                .get("content", {})
                .get("application/json", {})
                .get("schema", {})
            )
            tools.append(
                {
                    "type": "function",
                    "function": {
                        "name": op_id,
                        "description": desc,
                        "parameters": body
                        if body
                        else {"type": "object", "properties": {}},
                    },
                }
            )
    return tools


def build_request(model: str, tools: list[dict]) -> dict:
    return {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "system", "content": DYNAMIC_CONTEXT},
            {"role": "user", "content": USER_PROMPT},
        ],
        "tools": tools,
        "max_tokens": 256,
        "stream": False,
    }


def extract_cache_info(response: dict) -> dict[str, Any]:
    usage = response.get("usage", {})
    prompt_details = usage.get("prompt_tokens_details", {})
    if not isinstance(prompt_details, dict):
        prompt_details = {}

    cached_read = prompt_details.get("cached_tokens", 0) or prompt_details.get(
        "cached_read_tokens", 0
    )
    # Responses API style
    if not cached_read:
        input_details = usage.get("input_tokens_details", {})
        if isinstance(input_details, dict):
            cached_read = input_details.get("cached_read_tokens", 0) or input_details.get("cached_tokens", 0)

    return {
        "prompt_tokens": usage.get("prompt_tokens", usage.get("input_tokens", 0)),
        "completion_tokens": usage.get(
            "completion_tokens", usage.get("output_tokens", 0)
        ),
        "cached_read_tokens": cached_read or 0,
        "cached_write_tokens": prompt_details.get("cached_write_tokens", 0)
        or prompt_details.get("cache_creation_tokens", 0),
    }


def send_completion(
    client: httpx.Client, model: str, tools: list[dict], label: str
) -> dict[str, Any]:
    body = build_request(model, tools)
    print(f"    Sending {label}...")
    start = time.monotonic()
    resp = client.post(
        f"{BRIDGE_URL}/v1/chat/completions",
        json=body,
        timeout=120,
    )
    elapsed = time.monotonic() - start

    if resp.status_code != 200:
        print(f"    ERROR: HTTP {resp.status_code}")
        print(f"    Body: {resp.text[:500]}")
        return {"error": resp.status_code, "elapsed": elapsed}

    data = resp.json()
    cache = extract_cache_info(data)
    model_returned = data.get("model", "?")
    print(
        f"    {label}: model={model_returned} "
        f"prompt={cache['prompt_tokens']} "
        f"cached_read={cache['cached_read_tokens']} "
        f"cached_write={cache['cached_write_tokens']} "
        f"completion={cache['completion_tokens']} "
        f"({elapsed:.1f}s)"
    )
    return {**cache, "model": model_returned, "elapsed": elapsed, "raw_usage": data.get("usage", {})}


def run_model_test(
    client: httpx.Client,
    model: str,
    tools: list[dict],
    expect_defer_loading: bool,
) -> dict[str, Any]:
    print(f"\n  [{model}] (defer_loading={'expected' if expect_defer_loading else 'N/A — Chat Completions path'})")

    calls = []
    for i in range(1, NUM_CALLS + 1):
        label = f"request-{i} ({'cold' if i == 1 else 'warm'})"
        result = send_completion(client, model, tools, label)
        calls.append(result)

        if "error" in result:
            return {"model": model, "passed": False, "reason": f"{label} failed: HTTP {result['error']}"}

        if i < NUM_CALLS:
            print(f"    Waiting {CACHE_SETTLE_SECONDS}s for cache to settle...")
            time.sleep(CACHE_SETTLE_SECONDS)

    # Check if ANY warm call (2+) got cache hits
    warm_calls = calls[1:]
    best_cached = max(c.get("cached_read_tokens", 0) for c in warm_calls)
    best_prompt = warm_calls[0].get("prompt_tokens", 0)

    result = {
        "model": model,
        "calls": calls,
        "best_cached_read_tokens": best_cached,
        "prompt_tokens": best_prompt,
    }

    if best_cached > 0:
        pct = (best_cached / best_prompt * 100) if best_prompt > 0 else 0
        print(f"    BEST CACHE HIT: {best_cached}/{best_prompt} tokens cached ({pct:.0f}%)")
        result["passed"] = True
        result["cache_pct"] = pct
    else:
        print(f"    CACHE MISS: 0/{best_prompt} tokens cached on all warm calls")
        result["passed"] = False
        result["reason"] = "no warm call had cached tokens"
        result["raw_usage"] = warm_calls[-1].get("raw_usage", {})

    return result


def main() -> int:
    print("=" * 70)
    print("GPT Prompt Cache Test: defer_loading + instructions hoisting")
    print("=" * 70)
    print(f"  Bridge: {BRIDGE_URL}")
    print(f"  Glean spec: {GLEAN_OPENAPI_URL}")

    print("\n[Step 1] Loading Glean tool definitions from OpenAPI spec...")
    tools = load_glean_tools()
    tool_names = [t["function"]["name"] for t in tools]
    tools_json_size = len(json.dumps(tools))
    print(f"  Loaded {len(tools)} tools ({tools_json_size} chars): {tool_names}")

    print("\n[Step 2] Running cache tests...")

    results = []
    with httpx.Client() as client:
        # GPT-5.6 Sol: Responses API path, defer_loading should be active
        results.append(run_model_test(client, "GPT-5.6 Sol", tools, expect_defer_loading=True))

    print("\n" + "=" * 70)
    print("RESULTS")
    print("=" * 70)

    all_passed = True
    for r in results:
        model = r["model"]
        if r.get("passed"):
            pct = r.get("cache_pct", 0)
            print(f"  PASS  {model}: {r['best_cached_read_tokens']}/{r['prompt_tokens']} cached ({pct:.0f}%)")
        else:
            print(f"  FAIL  {model}: {r.get('reason', 'unknown')}")
            if r.get("raw_usage"):
                print(f"        raw usage: {json.dumps(r['raw_usage'])}")
            all_passed = False

    print()
    if all_passed:
        print("ALL PASSED")
        return 0
    else:
        print("SOME TESTS FAILED — see details above")
        return 1


if __name__ == "__main__":
    sys.exit(main())
