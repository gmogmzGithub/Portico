#!/usr/bin/env python3
"""PORTICO-410 full five-state battery over the two live n8n servers.

States (transitions use the app's real paths — REST toggles for soft, the
Control Plane mode-switch IPC for hard, the UI enable flow to lift hard):

  S1 all-on       native enabled            fork enabled
  S2 native-soft  native soft-disabled      fork enabled
  S3 native-hard  native HARD-disabled      fork enabled
  S4 fork-soft    native enabled            fork soft-disabled
  S5 fork-hard    native enabled            fork HARD-disabled

Per state: a REAL chat lists n8n workflows (read-only guard in the prompt),
then assertions over ground truth:
  - the LLM context is EXACTLY as specified for the state: which section of
    <integrations_status> each server appears in (<available_to_activate> /
    <disabled> / absent), tool_servers category membership, and — for hard
    states — zero mention of the server in ANY payload byte;
  - the model's n8n tool calls route to the expected server(s);
  - the answer names real workflows (validated against a direct read-only
    call to the active server; only counts are printed, never names);
  - list_mcp_servers include/omit and the toggle gate (soft: chat-side
    re-enable SUCCEEDS then is re-disabled — today's semantics; hard:
    INTEGRATION_HARD_DISABLED refusal).

product-pal stays soft-disabled throughout as a constant <disabled> control.

Prints a final matrix; exits non-zero on any failure. Restores all-on at end.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
API_CLIENT_PATH = REPO_ROOT / "tests" / "integration" / "framework" / "utils" / "api_client.py"
OPENWEBUI_BASE_URL = os.getenv("OPENWEBUI_BASE_URL", "http://127.0.0.1:3789")
DEBUG_MONITOR_BASE_URL = os.getenv("LLM_DEBUG_MONITOR_BASE_URL", "http://127.0.0.1:8879").rstrip("/")
DEBUG_MONITOR_CONTAINER = os.getenv("DEBUG_MONITOR_CONTAINER_NAME", "llm-debug-monitor")
CHAT_MODEL = os.getenv("HARD_DISABLE_E2E_MODEL", "Claude Opus 5")
TURN_TIMEOUT_SECONDS = int(os.getenv("HARD_DISABLE_E2E_TURN_TIMEOUT", "300"))
NATIVE = "mcp-n8n"
FORK = "n8n-community-mcp"
CONTROL_SOFT = "product-pal"
TOGGLE_SCRIPT = "/tmp/hard-disable-ui-verify/n8n-toggle.mjs"
CONTEXT_DUMP_DIR = Path("/tmp/hard-disable-ui-verify")

PROMPT = (
    "Use your n8n tools to list the workflows on the connected n8n instance and "
    "report the exact names of up to five of them. Activate the n8n integration "
    "for this chat first if needed. STRICTLY READ-ONLY: do not create, modify, "
    "execute, archive, or delete anything."
)

RESULTS: list[dict] = []


def record(state: str, check: str, ok: bool, detail: str = "") -> bool:
    RESULTS.append({"state": state, "check": check, "ok": ok})
    print(f"{'✅' if ok else '❌'} [{state}] {check}{(' — ' + detail) if detail else ''}", flush=True)
    return ok


def under(server_id: str) -> str:
    return server_id.replace("-", "_")


# ── plumbing ────────────────────────────────────────────────────────────────

def rest(path: str, payload=None, timeout=240):
    req = urllib.request.Request(
        f"http://127.0.0.1:9876{path}", method="POST" if payload is not None else "GET",
        data=json.dumps(payload).encode() if payload is not None else None)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read())
        except Exception:
            return {"http_error": e.code}


def rest_toggle(server_id: str, enabled: bool):
    for _ in range(12):
        result = rest("/api/toggle-mcp-server", {"server_id": server_id, "enabled": enabled})
        if result.get("errorCode") != "MCP_OPERATION_BUSY":
            return result
        time.sleep(10)
    return result


def wait_phase(server_id: str, phases=("tool_ready",), timeout=240):
    deadline = time.time() + timeout
    status = {}
    while time.time() < deadline:
        status = rest(f"/api/server-readiness/{server_id}")
        if status.get("readiness_phase") in phases + ("failed", "not_configured", "timeout"):
            break
        time.sleep(5)
    return status


def node_toggle(server_id: str, action: str) -> bool:
    proc = subprocess.run(["node", TOGGLE_SCRIPT, server_id, action], capture_output=True, text=True, timeout=300)
    print(f"   ui-toggle {server_id} {action}: {(proc.stdout or proc.stderr).strip()[:120]}")
    return proc.returncode == 0


def set_mode(server_id: str, mode: str) -> bool:
    script = f"""
const pw = require('{REPO_ROOT}/electron-app/node_modules/playwright-core/index.js');
(async () => {{
  const b = await pw.chromium.connectOverCDP('http://127.0.0.1:9223');
  for (const p of b.contexts().flatMap(c => c.pages())) {{
    if (await p.locator('#control-plane-toggle').count().catch(() => 0)) {{
      const r = await p.evaluate(async (a) => await window.electronAPI.setMcpDisableMode(a.id, a.mode), {{id: '{server_id}', mode: '{mode}'}});
      console.log(JSON.stringify(r));
      break;
    }}
  }}
  process.exit(0);
}})();
"""
    for attempt in range(15):
        proc = subprocess.run(["node", "-e", script], capture_output=True, text=True, timeout=120)
        out = (proc.stdout or "").strip()
        if "MCP_OPERATION_BUSY" not in out:
            print(f"   set-mode {server_id} {mode}: {out[:100]}")
            break
        time.sleep(10)
    if '"success":true' not in out.replace(" ", ""):
        return False
    _, modes = disk_state()
    return (modes.get(server_id) == "hard") if mode == "hard" else (server_id not in modes)


def disk_state():
    toggles = json.loads((REPO_ROOT / "mcp_toggles.json").read_text() or "{}")
    modes = json.loads((REPO_ROOT / "mcp_disable_modes.json").read_text() or "{}")
    return toggles, modes


_MONITOR_TOKEN: str | None = None


def monitor_get(path: str):
    global _MONITOR_TOKEN
    if _MONITOR_TOKEN is None:
        _MONITOR_TOKEN = subprocess.run(
            ["docker", "exec", DEBUG_MONITOR_CONTAINER, "cat", "/run/secrets/bifrost_bridge_local_api_key"],
            capture_output=True, text=True, timeout=30).stdout.strip()
    req = urllib.request.Request(f"{DEBUG_MONITOR_BASE_URL}{path}")
    req.add_header("X-Debug-Monitor-Token", _MONITOR_TOKEN)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def chat_payloads(chat_id: str, timeout=150) -> list[dict]:
    deadline = time.time() + timeout
    payloads: list[dict] = []
    while time.time() < deadline:
        data = monitor_get(f"/api/chats/{chat_id}/requests")
        summaries = data if isinstance(data, list) else data.get("requests", []) or []
        if summaries:
            payloads, complete = [], True
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


def assistant_tool_calls(payloads: list[dict]) -> list[str]:
    names = []
    for payload in payloads:
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


def extract_section(text: str, tag: str) -> str:
    match = re.search(rf"<{tag}>(.*?)</{tag}>", text, re.DOTALL)
    return match.group(1) if match else ""


def extract_category(text: str, category: str) -> str:
    match = re.search(
        rf'<category type="{category}">(.*?)</category>', text, re.DOTALL)
    return match.group(1) if match else ""


def mcpo_core(tool: str, payload: dict) -> str:
    req = urllib.request.Request(
        f"http://127.0.0.1:8766/mcp-assistant/mcp_assistant_{tool}", method="POST",
        data=json.dumps(payload).encode())
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            return r.read().decode()
    except urllib.error.HTTPError as e:
        return e.read().decode()


def ground_truth_names(active_servers: list[str]) -> set[str]:
    names: set[str] = set()
    if NATIVE in active_servers:
        out = subprocess.run(
            ["docker", "exec", "mcpo-mcp-n8n", "python3", "-c",
             "import json,urllib.request;req=urllib.request.Request('http://127.0.0.1:8000/mcp-n8n/mcp_n8n_search_workflows',method='POST',data=b'{}');req.add_header('Content-Type','application/json');print(urllib.request.urlopen(req,timeout=60).read().decode())"],
            capture_output=True, text=True, timeout=90).stdout
        try:
            data = json.loads(out)
            for item in data.get("data", []) or []:
                if item.get("name"):
                    names.add(item["name"])
        except Exception:
            pass
    if FORK in active_servers:
        # Bundled fork runs in its own mcpo container, same in-container route
        # shape as the native server.
        out = subprocess.run(
            ["docker", "exec", f"mcpo-{FORK}", "python3", "-c",
             f"import json,urllib.request;req=urllib.request.Request('http://127.0.0.1:8000/{FORK}/{under(FORK)}_n8n_list_workflows',method='POST',data=b'{{}}');req.add_header('Content-Type','application/json');print(urllib.request.urlopen(req,timeout=60).read().decode())"],
            capture_output=True, text=True, timeout=90).stdout
        try:
            data = json.loads(out)
            container = data.get("data") or data
            for item in (container.get("workflows") if isinstance(container, dict) else None) or []:
                if item.get("name"):
                    names.add(item["name"])
        except Exception:
            pass
    return names


# ── the per-state battery ──────────────────────────────────────────────────

def run_state(state: str, expect: dict, client) -> None:
    print(f"\n════ {state}: {expect['title']} ════", flush=True)

    toggles, modes = disk_state()
    record(state, "disk state matches", all([
        toggles.get(NATIVE) is expect["native_toggle"],
        toggles.get(FORK) is expect["fork_toggle"],
        modes.get(NATIVE) == expect["native_mode"],
        modes.get(FORK) == expect["fork_mode"],
    ]), f"toggles(n8n={toggles.get(NATIVE)}, fork={toggles.get(FORK)}) modes={modes}")

    # Surface probes.
    listing = mcpo_core("list_mcp_servers", {"filter": "all", "include_disabled": True})
    for sid, listed in expect["listed"].items():
        record(state, f"list_mcp_servers {'shows' if listed else 'omits'} {sid}",
               (f'"{sid}"' in listing) is listed)
    for sid in expect["toggle_refused"]:
        out = mcpo_core("toggle_integration", {"server_id": sid, "enabled": True})
        record(state, f"toggle_integration({sid}) refused", "INTEGRATION_HARD_DISABLED" in out)

    # The real chat.
    truth = ground_truth_names(expect["truth_servers"])
    created = client.create_chat(model=CHAT_MODEL, prompt=PROMPT)
    chat_id = created["chat_id"]
    print(f"   chat: {chat_id}")
    client.generate_completion(
        chat_id=chat_id, model=CHAT_MODEL, prompt=PROMPT,
        user_message_id=created["user_message_id"], stream=True)
    result = client.poll_for_completion(chat_id, created["user_message_id"], timeout_seconds=TURN_TIMEOUT_SECONDS)
    record(state, "chat turn completed", bool(result.get("complete")))

    with urllib.request.urlopen(urllib.request.Request(
            f"{OPENWEBUI_BASE_URL}/api/v1/chats/{chat_id}",
            headers={"Authorization": f"Bearer {client.token}"}), timeout=30) as r:
        chat_doc = json.loads(r.read())
    chat_body = chat_doc.get("chat") or {}
    candidates = list(chat_body.get("messages", []) or [])
    candidates.extend(((chat_body.get("history") or {}).get("messages") or {}).values())
    answer = ""
    for message in candidates:
        if message.get("role") == "assistant" and isinstance(message.get("content"), str):
            if len(message["content"]) > len(answer):
                answer = message["content"]
    named = [n for n in truth if n in answer]
    record(state, "answer names real workflows", len(named) >= 1,
           f"{len(named)} of {len(truth)} ground-truth names appear")

    payloads = chat_payloads(chat_id)
    record(state, "payloads captured", len(payloads) >= 1, f"{len(payloads)} requests")
    blob = "\n".join(payload_text(p) for p in payloads)
    first = payload_text(payloads[0]) if payloads else ""

    # Exact context assertions on the fresh-chat (first) payload.
    integrations = extract_section(first, "integrations_status")
    disabled_section = extract_section(integrations, "disabled")
    available_section = extract_section(integrations, "available_to_activate")
    tool_servers = extract_section(first, "tool_servers")
    system_cat = extract_category(tool_servers, "system")
    user_cat = extract_category(tool_servers, "user")

    dump = CONTEXT_DUMP_DIR / f"battery-{state}-context.txt"
    dump.write_text(
        f"== integrations_status ==\n{integrations}\n== tool_servers ==\n{tool_servers}\n")
    print(f"   context sections saved: {dump}")

    # Control: product-pal appears in <disabled> exactly when it is
    # soft-disabled on disk (derive the expectation from actual state — the
    # user may have it enabled).
    control_soft = toggles.get(CONTROL_SOFT) is False and modes.get(CONTROL_SOFT) != "hard"
    record(state,
           f"control '{CONTROL_SOFT}' {'listed in' if control_soft else 'absent from'} <disabled> (matches its disk state)",
           (CONTROL_SOFT in disabled_section) is control_soft)

    for sid, placement in expect["context"].items():
        in_disabled = re.search(rf"^\s*{re.escape(sid)} \| auth=", disabled_section, re.M) is not None
        in_available = re.search(rf"^\s*{re.escape(sid)} \| auth=", available_section, re.M) is not None
        # Both n8n flavors ship bundled now, so both land in the system category.
        cat = system_cat
        in_tool_servers = f'id="server:{sid}"' in cat
        if placement == "available":
            record(state, f"context: {sid} in <available_to_activate>", in_available)
            record(state, f"context: {sid} NOT in <disabled>", not in_disabled)
            record(state, f"context: {sid} in tool_servers/system", in_tool_servers)
        elif placement == "disabled":
            record(state, f"context: {sid} in <disabled> with toggle guidance", in_disabled and "toggle_integration" in disabled_section)
            record(state, f"context: {sid} NOT in <available_to_activate>", not in_available)
            record(state, f"context: {sid} NOT in tool_servers", not in_tool_servers)
        elif placement == "invisible":
            record(state, f"context: {sid} NOT in <disabled>", not in_disabled)
            record(state, f"context: {sid} NOT in <available_to_activate>", not in_available)
            record(state, f"context: {sid} NOT in tool_servers", not in_tool_servers)
        elif placement == "zero-mention":
            # Boundary-guarded: the fork's tool prefix (n8n_community_mcp_ +
            # tools starting n8n_) embeds the literal "mcp_n8n", so a raw
            # substring count would false-positive against the OTHER server's
            # tool names. A mention must not be glued to a preceding
            # identifier character (suffix continuation like mcp_n8n_search_*
            # is still a real mention and must count).
            hits = sum(
                len(re.findall(rf"(?<![\w-]){re.escape(form)}", blob))
                for form in (sid, under(sid))
            )
            record(state, f"context: ZERO bytes mention {sid} (any payload, any form)", hits == 0,
                   f"{hits} occurrences" if hits else "")

    # Tool-routing assertions.
    calls = assistant_tool_calls(payloads)
    n8n_calls = sorted({n for n in calls if "n8n" in n})
    native_calls = [n for n in n8n_calls if n.startswith(under(NATIVE) + "_")]
    fork_calls = [n for n in n8n_calls if n.startswith(under(FORK) + "_")]
    route = expect["route"]
    if route == "either":
        # Soft states included: the model MAY legitimately re-enable a
        # soft-disabled server (today's semantics — the reason hard exists).
        record(state, "model used an n8n tool", bool(native_calls or fork_calls),
               f"route taken: native={native_calls} fork={fork_calls}")
    else:
        allowed, banned, banned_name = (native_calls, fork_calls, FORK) if route == NATIVE else (fork_calls, native_calls, NATIVE)
        record(state, f"model routed via {route}", bool(allowed), f"{allowed}")
        record(state, f"model never called {banned_name} tools", not banned, f"{banned}")

    try:
        client.delete_chat(chat_id)
    except Exception:
        pass

    # Soft semantics: the model-path re-enable must WORK (then re-disable).
    for sid in expect["soft_reenable"]:
        r1 = rest_toggle(sid, True)
        ok1 = r1.get("success") is True and "INTEGRATION_HARD_DISABLED" not in json.dumps(r1)
        status = wait_phase(sid) if ok1 else {}
        r2 = rest_toggle(sid, False)
        wait_phase(sid, phases=("disabled",))
        record(state, f"soft semantics: chat-side re-enable of {sid} works (then re-disabled)",
               ok1 and status.get("readiness_phase") == "tool_ready" and r2.get("success") is True,
               f"enable={r1.get('readiness_phase')} settle={status.get('readiness_phase')}")


def main() -> int:
    spec = importlib.util.spec_from_file_location("owui_api_client", API_CLIENT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    client = module.OWUIClient(base_url=OPENWEBUI_BASE_URL)

    both_available = {NATIVE: "available", FORK: "available"}
    listed_both = {NATIVE: True, FORK: True}

    # S1 — all on.
    run_state("S1-all-on", {
        "title": "both n8n servers enabled",
        "native_toggle": True, "fork_toggle": True, "native_mode": None, "fork_mode": None,
        "listed": listed_both, "toggle_refused": [],
        "context": both_available, "route": "either",
        "truth_servers": [NATIVE, FORK], "soft_reenable": [],
    }, client)

    # S2 — native soft.
    assert rest_toggle(NATIVE, False).get("success"), "soft-disable native failed"
    wait_phase(NATIVE, phases=("disabled",))
    run_state("S2-native-soft", {
        "title": "bundled native n8n soft-disabled",
        "native_toggle": False, "fork_toggle": True, "native_mode": None, "fork_mode": None,
        "listed": listed_both, "toggle_refused": [],
        "context": {NATIVE: "disabled", FORK: "available"}, "route": "either",
        "truth_servers": [FORK], "soft_reenable": [NATIVE],
    }, client)

    # S3 — native hard.
    assert set_mode(NATIVE, "hard"), "hard-switch native failed"
    run_state("S3-native-hard", {
        "title": "bundled native n8n HARD-disabled",
        "native_toggle": False, "fork_toggle": True, "native_mode": "hard", "fork_mode": None,
        "listed": {NATIVE: False, FORK: True}, "toggle_refused": [NATIVE],
        "context": {NATIVE: "zero-mention", FORK: "available"}, "route": FORK,
        "truth_servers": [FORK], "soft_reenable": [],
    }, client)

    # Back to all-on via the UI enable (lifts hard).
    assert node_toggle(NATIVE, "enable"), "UI enable of native failed"
    status = wait_phase(NATIVE)
    assert status.get("readiness_phase") == "tool_ready", f"native did not return: {status}"

    # S4 — fork soft.
    assert rest_toggle(FORK, False).get("success"), "soft-disable fork failed"
    wait_phase(FORK, phases=("disabled",))
    run_state("S4-fork-soft", {
        "title": "community fork soft-disabled (bundled: listed in <disabled>)",
        "native_toggle": True, "fork_toggle": False, "native_mode": None, "fork_mode": None,
        "listed": listed_both, "toggle_refused": [],
        "context": {NATIVE: "available", FORK: "disabled"}, "route": "either",
        "truth_servers": [NATIVE], "soft_reenable": [FORK],
    }, client)

    # S5 — fork hard.
    assert set_mode(FORK, "hard"), "hard-switch fork failed"
    run_state("S5-fork-hard", {
        "title": "community fork HARD-disabled",
        "native_toggle": True, "fork_toggle": False, "native_mode": None, "fork_mode": "hard",
        "listed": {NATIVE: True, FORK: False}, "toggle_refused": [FORK],
        "context": {NATIVE: "available", FORK: "zero-mention"}, "route": NATIVE,
        "truth_servers": [NATIVE], "soft_reenable": [],
    }, client)

    # Restore the user's all-on state.
    assert node_toggle(FORK, "enable"), "UI enable of fork failed"
    status = wait_phase(FORK)
    print(f"restore: fork {status.get('readiness_phase')}")
    toggles, modes = disk_state()
    print(f"final: toggles(n8n={toggles.get(NATIVE)}, fork={toggles.get(FORK)}) modes={modes}")

    failures = [r for r in RESULTS if not r["ok"]]
    print("\n" + "=" * 72)
    by_state: dict[str, list] = {}
    for r in RESULTS:
        by_state.setdefault(r["state"], []).append(r)
    for state, rows in by_state.items():
        bad = [r for r in rows if not r["ok"]]
        print(f"{state}: {len(rows) - len(bad)}/{len(rows)} passed" + (f"  ← {[r['check'] for r in bad]}" if bad else ""))
    print(f"TOTAL: {len(RESULTS) - len(failures)}/{len(RESULTS)} checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
