#!/usr/bin/env python3
"""One round of the n8n two-server hard-disable scenario (PORTICO-410 / AI4IPLAT-835).

Preconditions (set up by the caller): exactly one of the two n8n servers is
hard-disabled, the other enabled+tool_ready, both pointing at the same live
n8n backend containing a workflow named "PORTICO-410 Hard Disable Probe".

The round drives a REAL chat asking the model to list n8n workflows, then
asserts from ground truth:
  1. the answer names the probe workflow (the task actually succeeded);
  2. every n8n tool call the model made used the ACTIVE server's prefix;
  3. no LLM payload for the chat mentions the hard-disabled server in any
     form (id, underscored tool prefix);
  4. list_mcp_servers omits the hard-disabled server and toggle_integration
     refuses to enable it.

Usage:
  run_n8n_round.py --active mcp-n8n --hidden n8n-community-mcp
  run_n8n_round.py --active n8n-community-mcp --hidden mcp-n8n
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
API_CLIENT_PATH = REPO_ROOT / "tests" / "integration" / "framework" / "utils" / "api_client.py"
OPENWEBUI_BASE_URL = os.getenv("OPENWEBUI_BASE_URL", "http://127.0.0.1:3789")
DEBUG_MONITOR_BASE_URL = os.getenv("LLM_DEBUG_MONITOR_BASE_URL", "http://127.0.0.1:8879").rstrip("/")
DEBUG_MONITOR_CONTAINER = os.getenv("DEBUG_MONITOR_CONTAINER_NAME", "llm-debug-monitor")
CHAT_MODEL = os.getenv("HARD_DISABLE_E2E_MODEL", "Atlas Opus 5")
TURN_TIMEOUT_SECONDS = int(os.getenv("HARD_DISABLE_E2E_TURN_TIMEOUT", "300"))
PROBE_WORKFLOW = "PORTICO-410 Hard Disable Probe"

PROMPT = (
    "Use your n8n tools to list all workflows on the connected n8n instance "
    "and report their exact names. Activate the n8n integration for this chat "
    "first if it is not active yet."
)

RESULTS: list[dict] = []


def record(check: str, ok: bool, detail: str = "") -> bool:
    RESULTS.append({"check": check, "ok": ok})
    print(f"{'✅' if ok else '❌'} {check}{(' — ' + detail) if detail else ''}", flush=True)
    return ok


def tool_prefix(server_id: str) -> str:
    return server_id.replace("-", "_") + "_"


_MONITOR_TOKEN: str | None = None


def monitor_get(path: str):
    global _MONITOR_TOKEN
    if _MONITOR_TOKEN is None:
        for key in ("DEBUG_MONITOR_TOKEN", "LLM_DEBUG_MONITOR_TOKEN"):
            if os.getenv(key):
                _MONITOR_TOKEN = os.environ[key].strip()
                break
        else:
            _MONITOR_TOKEN = subprocess.run(
                ["docker", "exec", DEBUG_MONITOR_CONTAINER, "cat", "/run/secrets/bifrost_bridge_local_api_key"],
                capture_output=True, text=True, timeout=30,
            ).stdout.strip()
    req = urllib.request.Request(f"{DEBUG_MONITOR_BASE_URL}{path}")
    req.add_header("X-Debug-Monitor-Token", _MONITOR_TOKEN)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def chat_payloads(chat_id: str, minimum: int = 1, timeout: int = 120) -> list[dict]:
    """All merged request payloads for a chat (polling the async merge)."""
    deadline = time.time() + timeout
    payloads: list[dict] = []
    while time.time() < deadline:
        data = monitor_get(f"/api/chats/{chat_id}/requests")
        summaries = data if isinstance(data, list) else data.get("requests", []) or []
        if len(summaries) >= minimum:
            payloads = []
            complete = True
            for s in summaries:
                rid = s.get("request_id") or s.get("id")
                detail = monitor_get(f"/api/requests/{rid}")
                payload = detail.get("raw_payload") or detail.get("request", {}).get("raw_payload") or {}
                if isinstance(payload, str):
                    try:
                        payload = json.loads(payload)
                    except Exception:
                        payload = {}
                if not payload.get("messages"):
                    complete = False
                payloads.append(payload)
            if complete:
                return payloads
        time.sleep(4)
    return payloads


def payload_text(payload: dict) -> str:
    chunks = []
    for message in payload.get("messages", []):
        content = message.get("content")
        if isinstance(content, str):
            chunks.append(content)
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict):
                    chunks.append(json.dumps(block))
    if isinstance(payload.get("system"), str):
        chunks.append(payload["system"])
    for tool in payload.get("tools", []) or []:
        chunks.append(json.dumps(tool))
    return "\n".join(chunks)


def assistant_tool_calls(payload: dict) -> list[str]:
    names = []
    for message in payload.get("messages", []):
        if message.get("role") != "assistant":
            continue
        for tc in message.get("tool_calls", []) or []:
            name = (tc.get("function") or {}).get("name")
            if name:
                names.append(name)
        content = message.get("content")
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "tool_use" and block.get("name"):
                    names.append(block["name"])
    return names


def mcpo_core_call(tool: str, payload: dict):
    req = urllib.request.Request(
        f"http://127.0.0.1:8766/mcp-assistant/mcp_assistant_{tool}", method="POST",
        data=json.dumps(payload).encode())
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            return r.read().decode()
    except urllib.error.HTTPError as e:
        return e.read().decode()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--active", required=True)
    parser.add_argument("--hidden", required=True)
    parser.add_argument("--keep-chat", action="store_true")
    args = parser.parse_args()
    active, hidden = args.active, args.hidden
    active_prefix, hidden_prefix = tool_prefix(active), tool_prefix(hidden)

    spec = importlib.util.spec_from_file_location("owui_api_client", API_CLIENT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    client = module.OWUIClient(base_url=OPENWEBUI_BASE_URL)

    print(f"— round: active={active} hidden={hidden} —")

    # Tool-surface ground truth first.
    listing = mcpo_core_call("list_mcp_servers", {"filter": "all", "include_disabled": True})
    record(f"list_mcp_servers omits '{hidden}'", f'"{hidden}"' not in listing)
    record(f"list_mcp_servers keeps '{active}'", f'"{active}"' in listing)
    refusal = mcpo_core_call("toggle_integration", {"server_id": hidden, "enabled": True})
    record(f"toggle_integration({hidden}) refused", "INTEGRATION_HARD_DISABLED" in refusal)

    # The real chat.
    created = client.create_chat(model=CHAT_MODEL, prompt=PROMPT)
    chat_id = created["chat_id"]
    print(f"chat: {chat_id}")
    client.generate_completion(
        chat_id=chat_id, model=CHAT_MODEL, prompt=PROMPT,
        user_message_id=created["user_message_id"],
        stream=True,  # native tool execution runs only on the streamed path
    )
    result = client.poll_for_completion(chat_id, created["user_message_id"], timeout_seconds=TURN_TIMEOUT_SECONDS)
    record("chat turn completed", bool(result.get("complete")), str(result.get("error"))[:120] if not result.get("complete") else "")

    # Final answer names the probe workflow.
    with urllib.request.urlopen(
        urllib.request.Request(
            f"{OPENWEBUI_BASE_URL}/api/v1/chats/{chat_id}",
            headers={"Authorization": f"Bearer {client.token}"},
        ), timeout=30,
    ) as r:
        chat_doc = json.loads(r.read())
    chat_body = chat_doc.get("chat") or {}
    candidates = list(chat_body.get("messages", []) or [])
    history_messages = ((chat_body.get("history") or {}).get("messages") or {})
    candidates.extend(history_messages.values())
    final_answer = ""
    for message in candidates:
        if message.get("role") == "assistant" and isinstance(message.get("content"), str):
            if PROBE_WORKFLOW in message["content"]:
                final_answer = message["content"]
                break
            if len(message["content"]) > len(final_answer):
                final_answer = message["content"]
    record("answer names the probe workflow", PROBE_WORKFLOW in final_answer,
           f"answer length {len(final_answer)}")

    # Ground truth from every LLM payload of the chat.
    payloads = chat_payloads(chat_id, minimum=1)
    record("monitor payloads captured", len(payloads) >= 1, f"{len(payloads)} requests")
    all_calls = [name for p in payloads for name in assistant_tool_calls(p)]
    n8n_calls = [n for n in all_calls if "n8n" in n]
    active_calls = [n for n in n8n_calls if n.startswith(active_prefix)]
    hidden_calls = [n for n in n8n_calls if n.startswith(hidden_prefix)]
    record(f"model called {active} tools", len(active_calls) >= 1, f"{sorted(set(active_calls))}")
    record(f"model never called {hidden} tools", len(hidden_calls) == 0, f"{sorted(set(hidden_calls))}")

    blob = "\n".join(payload_text(p) for p in payloads)
    leak = hidden in blob
    if leak:
        idx = blob.find(hidden)
        while idx != -1:
            print(f"   LEAK CONTEXT: …{blob[max(0, idx - 160):idx + 100]}…".replace("\n", " "))
            idx = blob.find(hidden, idx + 1)
    record(f"no payload mentions '{hidden}'", not leak)
    # Boundary-guarded: the fork prefix embeds the literal "mcp_n8n_"
    # (n8n_community_MCP_N8N_list_workflows), so a raw substring check would
    # false-positive against the active server's tool names.
    hidden_prefix_hit = re.search(rf"(?<![\w-]){re.escape(hidden_prefix)}", blob)
    record(f"no payload mentions '{hidden_prefix.rstrip('_')}' tools", hidden_prefix_hit is None)
    record(f"payloads do mention '{active}'", active in blob or active_prefix in blob)

    if not args.keep_chat:
        try:
            client.delete_chat(chat_id)
        except Exception:
            pass

    failures = [r for r in RESULTS if not r["ok"]]
    print(f"round result: {len(RESULTS) - len(failures)}/{len(RESULTS)} checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
