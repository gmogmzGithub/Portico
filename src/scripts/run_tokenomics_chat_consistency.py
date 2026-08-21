#!/usr/bin/env python3
"""Tokenomics problem-proof suite (Plan A / Plan D gates).

Headless real-chat scenarios that (a) document the tool-spec token problem with
hard numbers (--capture-baseline, red) and (b) gate the fixes (green) as each
rollout tag flips. Follows the run_*_chat_consistency.py house pattern: drives
chats through the OWUI backend API against the running Docker stack; reads
ground truth from the llm-debug-monitor, the bridge's per-request logs, and the
durable reporting events. No Electron, no Playwright.

Scenario tags:
  A-claude  — pass after Plan A's `tool_slimming` flips for Claude aliases
  A-gemini  — pass after the Gemini flip
  D         — pass after Plan D (deferred loading + find_tools) ships
  guard     — must pass in EVERY mode (non-regression canaries)

Gate semantics: scenarios whose tag is NOT in --expect-pass are expected to
fail (xfail); an xfail that PASSES is reported as XPASS and exits non-zero so
tag flips stay deliberate. `guard` scenarios are always expected to pass.

Sensitive-data rule (hard constraint): this script persists ONLY aggregate
metrics via tests/tokenomics/report_schema.py (schema-tripwired). Transcript
dumps require --dump-artifacts and land in the gitignored
tests/tokenomics/artifacts/ directory only.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import statistics
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]

API_CLIENT_PATH = REPO_ROOT / "tests" / "integration" / "framework" / "utils" / "api_client.py"
API_CLIENT_SPEC = importlib.util.spec_from_file_location("owui_api_client", API_CLIENT_PATH)
if API_CLIENT_SPEC is None or API_CLIENT_SPEC.loader is None:
    raise RuntimeError(f"Failed to load OWUI API client from {API_CLIENT_PATH}")
API_CLIENT_MODULE = importlib.util.module_from_spec(API_CLIENT_SPEC)
API_CLIENT_SPEC.loader.exec_module(API_CLIENT_MODULE)
OWUIClient = API_CLIENT_MODULE.OWUIClient

REPORT_SCHEMA_PATH = REPO_ROOT / "tests" / "tokenomics" / "report_schema.py"
REPORT_SPEC = importlib.util.spec_from_file_location("tokenomics_report_schema", REPORT_SCHEMA_PATH)
report_schema = importlib.util.module_from_spec(REPORT_SPEC)
REPORT_SPEC.loader.exec_module(report_schema)

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

OPENWEBUI_BASE_URL = os.getenv("OPENWEBUI_BASE_URL", "http://127.0.0.1:3789")
DEBUG_MONITOR_BASE_URL = os.getenv("LLM_DEBUG_MONITOR_BASE_URL", "http://127.0.0.1:8879").rstrip("/")
DEBUG_MONITOR_TOKEN_ENV_KEYS = (
    "DEBUG_MONITOR_TOKEN",
    "LLM_DEBUG_MONITOR_TOKEN",
    "BIFROST_BRIDGE_LOCAL_API_KEY",
    "LOCAL_STACK_API_KEY",
)
DEBUG_MONITOR_TOKEN_FILE_ENV_KEYS = (
    "DEBUG_MONITOR_TOKEN_FILE",
    "LLM_DEBUG_MONITOR_TOKEN_FILE",
    "BIFROST_BRIDGE_LOCAL_API_KEY_FILE",
    "LOCAL_STACK_API_KEY_FILE",
)
LLM_GATEWAY_CONTAINER = os.getenv("LLM_GATEWAY_CONTAINER_NAME", "llm-gateway")
DEBUG_MONITOR_CONTAINER = os.getenv("DEBUG_MONITOR_CONTAINER_NAME", "llm-debug-monitor")
REPORTING_EVENTS_DIR = Path(
    os.getenv("REPORTING_EVENTS_DIR", str(REPO_ROOT / "open-webui-data" / "reporting" / "events"))
)

CLAUDE_MODEL = os.getenv("TOKENOMICS_CLAUDE_MODEL", "Claude Opus 5")
GEMINI_MODEL = os.getenv("TOKENOMICS_GEMINI_MODEL", "")  # auto-detect when empty
GPT_MODEL = os.getenv("TOKENOMICS_GPT_MODEL", "GPT-5.6 Sol")

# The three-server mix mirrors the live request measured on 2026-08-06
# (318 tools ≈ 400KB tools JSON on an Opus 5 request).
THREE_SERVER_TOOL_IDS = [
    "server:google_workspace",
    "server:data-plat-mcp",
    "server:slack",
]
GW_TOOL_IDS = ["server:google_workspace"]

PROMPT_TRIVIAL = "Reply with exactly: ok"
PROMPT_ARGS = (
    "If Google Workspace is not active in this chat yet, first call "
    "mcp_assistant_activate_integration for server_id='google_workspace'. Then use "
    "google_workspace_get_events to list my calendar events between "
    "2026-08-10T09:00:00Z and 2026-08-14T17:00:00Z, and summarize only the event "
    "titles. Do not call any tools other than those two, and do not call "
    "mcp_assistant_authorize_integration unless a tool result explicitly says "
    "OAuth is required."
)

TURN_TIMEOUT_SECONDS = int(os.getenv("TOKENOMICS_TURN_TIMEOUT", "300"))
BASELINE_DIR = REPO_ROOT / "tests" / "tokenomics"
ARTIFACTS_DIR = BASELINE_DIR / "artifacts"

# Desired-state thresholds (post-fix expectations with ~25-30% headroom;
# problem-scale values fail unambiguously).
THRESHOLDS = {
    "T1_wire_tools_bytes_max": 70_000,        # baseline ~116KB uncompacted core
    "T2_wire_tools_delta_max": 60_000,        # baseline +147KB google_workspace
    "T2P2_wire_tools_delta_max": 8_000,       # Plan D: attach adds notice only
    "T3_billed_prompt_tokens_max": 150_000,   # baseline ~210k class
    "T3D_billed_prompt_tokens_max": 110_000,  # Plan D tightening
    "T3G_billed_prompt_tokens_max": 95_000,   # baseline ~127k class
    "T4_tool_count_max": 130,                 # Plan D: eager ~101 + working set
    "T8_billed_ratio_max": 1.10,
    "TARGS_max_main_requests": 4,             # initial + up to 3 tool batches
}

MONITOR_SETTLE_POLLS = 2
MONITOR_POLL_SECONDS = 3.0
MONITOR_TIMEOUT_SECONDS = 60


class SuiteError(RuntimeError):
    pass


# --------------------------------------------------------------------------
# Small helpers (docker / monitor / metrics)
# --------------------------------------------------------------------------

def _docker_text(cmd: list[str]) -> str:
    completed = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if completed.returncode != 0:
        raise SuiteError(f"docker command failed: {' '.join(cmd)}: {completed.stderr.strip()[:200]}")
    return completed.stdout


def _debug_monitor_token() -> str:
    for key in DEBUG_MONITOR_TOKEN_ENV_KEYS:
        value = (os.getenv(key) or "").strip()
        if value:
            return value
    for key in DEBUG_MONITOR_TOKEN_FILE_ENV_KEYS:
        path = (os.getenv(key) or "").strip()
        if path and Path(path).exists():
            value = Path(path).read_text().strip()
            if value:
                return value
    try:
        return _docker_text(
            ["docker", "exec", DEBUG_MONITOR_CONTAINER, "cat", "/run/secrets/bifrost_bridge_local_api_key"]
        ).strip()
    except SuiteError as exc:
        raise SuiteError(f"Cannot resolve debug-monitor token: {exc}") from exc


_MONITOR_TOKEN: str | None = None


def _monitor_get(path: str) -> Any:
    global _MONITOR_TOKEN
    import httpx

    if _MONITOR_TOKEN is None:
        _MONITOR_TOKEN = _debug_monitor_token()
    response = httpx.get(
        f"{DEBUG_MONITOR_BASE_URL}{path}",
        headers={"X-Debug-Monitor-Token": _MONITOR_TOKEN},
        timeout=30.0,
    )
    response.raise_for_status()
    return response.json()


def _chat_request_summaries(chat_id: str) -> list[dict[str, Any]]:
    data = _monitor_get(f"/api/chats/{chat_id}/requests")
    if isinstance(data, list):
        return data
    return data.get("requests", []) or []


def _request_detail(request_id: str) -> dict[str, Any]:
    data = _monitor_get(f"/api/requests/{request_id}")
    return data if isinstance(data, dict) else {}


def _request_detail_with_payload(request_id: str, timeout_seconds: int = 45) -> dict[str, Any]:
    """The monitor merges the llm_request_payload event asynchronously after the
    request summary appears; reading too early yields an empty raw_payload.
    Poll until the payload carries messages (the merge signal) or time out."""
    deadline = time.time() + timeout_seconds
    detail: dict[str, Any] = {}
    while time.time() < deadline:
        detail = _request_detail(request_id)
        payload = _raw_payload(detail)
        if payload.get("messages"):
            return detail
        time.sleep(MONITOR_POLL_SECONDS)
    return detail


def _wait_for_main_requests(chat_id: str, minimum: int) -> list[dict[str, Any]]:
    """Poll the monitor until >= minimum request summaries exist and settle."""
    deadline = time.time() + MONITOR_TIMEOUT_SECONDS
    stable_polls = 0
    last_count = -1
    summaries: list[dict[str, Any]] = []
    while time.time() < deadline:
        summaries = _chat_request_summaries(chat_id)
        if len(summaries) >= minimum:
            if len(summaries) == last_count:
                stable_polls += 1
                if stable_polls >= MONITOR_SETTLE_POLLS:
                    return summaries
            else:
                stable_polls = 0
        last_count = len(summaries)
        time.sleep(MONITOR_POLL_SECONDS)
    if len(summaries) >= minimum:
        return summaries
    raise SuiteError(
        f"debug monitor produced {len(summaries)} request summaries for chat {chat_id}, needed {minimum}"
    )


def _raw_payload(detail: dict[str, Any]) -> dict[str, Any]:
    payload = detail.get("raw_payload") or detail.get("request", {}).get("raw_payload") or {}
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError:
            payload = {}
    return payload if isinstance(payload, dict) else {}


def _payload_tools_metrics(payload: dict[str, Any]) -> dict[str, int]:
    tools = payload.get("tools") or []
    return {
        "owui_tools_bytes": len(json.dumps(tools)),
        "tool_count": len(tools) if isinstance(tools, list) else 0,
        "has_tool_namespaces": 1 if payload.get("_tool_namespaces") else 0,
    }


_SLIM_LOG_PATTERN = re.compile(
    r"Applied tool-spec slimming.*?tools_bytes_preslim[=:\s]+(\d+).*?tools_bytes[=:\s]+(\d+)|"
    r"Applied tool-spec slimming.*?tools_bytes[=:\s]+(\d+).*?tools_bytes_preslim[=:\s]+(\d+)",
    re.DOTALL,
)


_ANSI_ESCAPES = re.compile(r"\x1b\[[0-9;]*m")


def _bridge_slimming_entries(since_epoch: int, chat_id: str) -> list[dict[str, int]]:
    """Parse 'Applied tool-spec slimming' log lines for a chat (numeric fields
    only). The tracing formatter interleaves ANSI color codes between field
    names and values, so lines are de-colored before matching."""
    try:
        # Unix-epoch form avoids docker's local-time interpretation of bare
        # ISO timestamps (a UTC string without tz reads ~hours in the future).
        logs = _docker_text(["docker", "logs", LLM_GATEWAY_CONTAINER, "--since", str(since_epoch)])
    except SuiteError:
        return []
    entries: list[dict[str, int]] = []
    for raw_line in logs.splitlines():
        line = _ANSI_ESCAPES.sub("", raw_line)
        if "Applied tool-spec slimming" not in line or chat_id not in line:
            continue
        preslim = re.search(r"tools_bytes_preslim=(\d+)", line)
        postslim = re.search(r"(?<!preslim)\btools_bytes=(\d+)", line.replace("tools_bytes_preslim=", "PRESLIM="))
        if preslim and postslim:
            entries.append(
                {
                    "tools_bytes_preslim": int(preslim.group(1)),
                    "tools_bytes": int(postslim.group(1)),
                }
            )
    return entries


def _wire_tools_bytes(owui_bytes: int, since_epoch: int, chat_id: str) -> tuple[int, int]:
    """Return (wire_bytes, slimming_applied). Falls back to the OWUI payload
    size when no slimming log entry exists (verbatim passthrough today)."""
    entries = _bridge_slimming_entries(since_epoch, chat_id)
    if entries:
        return entries[-1]["tools_bytes"], 1
    return owui_bytes, 0


_CACHE_READ_KEY = re.compile(r"cache.*read", re.IGNORECASE)


def _usage_from_summary(summary: dict[str, Any]) -> dict[str, Any]:
    usage = summary.get("usage")
    return usage if isinstance(usage, dict) else {}


def _billed_prompt_tokens(chat_id: str, summaries: list[dict[str, Any]]) -> int:
    best = 0
    for summary in summaries:
        usage = _usage_from_summary(summary)
        for key in ("prompt_tokens", "input_tokens", "context_tokens"):
            value = usage.get(key)
            if isinstance(value, (int, float)):
                best = max(best, int(value))
    if best:
        return best
    return _billed_from_reporting_events(chat_id)


def _billed_from_reporting_events(chat_id: str) -> int:
    if not REPORTING_EVENTS_DIR.is_dir():
        return 0
    best = 0
    files = sorted(REPORTING_EVENTS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    for path in files[:300]:
        try:
            event = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        event_id = str(event.get("eventId") or "")
        if chat_id not in event_id and event.get("chatId") != chat_id:
            continue
        usage = event.get("usage") or {}
        for key in ("prompt_tokens", "input_tokens"):
            value = usage.get(key)
            if isinstance(value, (int, float)):
                best = max(best, int(value))
    return best


def _cache_read_tokens(chat_id: str, summaries: list[dict[str, Any]]) -> int:
    def scan(usage: dict[str, Any]) -> int:
        found = 0
        for key, value in usage.items():
            if isinstance(value, (int, float)) and _CACHE_READ_KEY.search(key):
                found = max(found, int(value))
            elif isinstance(value, dict):
                found = max(found, scan(value))
        return found

    best = 0
    if summaries:
        best = scan(_usage_from_summary(summaries[-1]))
    if best:
        return best
    if REPORTING_EVENTS_DIR.is_dir():
        files = sorted(
            REPORTING_EVENTS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True
        )
        for path in files[:100]:
            try:
                event = json.loads(path.read_text())
            except (OSError, json.JSONDecodeError):
                continue
            if chat_id not in str(event.get("eventId") or "") and event.get("chatId") != chat_id:
                continue
            best = max(best, scan(event.get("usage") or {}))
            if best:
                break
    return best


def _assistant_tool_names(chat_id: str, summaries: list[dict[str, Any]]) -> list[str]:
    """Tool names the assistant called, from follow-up request payload history."""
    names: list[str] = []
    for summary in summaries:
        request_id = summary.get("request_id") or summary.get("id")
        if not request_id:
            continue
        payload = _raw_payload(_request_detail_with_payload(str(request_id)))
        for message in payload.get("messages") or []:
            if not isinstance(message, dict) or message.get("role") != "assistant":
                continue
            for tool_call in message.get("tool_calls") or []:
                name = ((tool_call or {}).get("function") or {}).get("name")
                if isinstance(name, str) and name not in names:
                    names.append(name)
    return names


def _container_env(container: str, key: str) -> str:
    try:
        output = _docker_text(["docker", "exec", container, "printenv", key])
        return output.strip() or "unset"
    except SuiteError:
        return "unset"


def _git_sha() -> str:
    try:
        return _docker_text(["git", "-C", str(REPO_ROOT), "rev-parse", "--short=12", "HEAD"]).strip()
    except SuiteError:
        return "unknown"


# --------------------------------------------------------------------------
# Chat driving
# --------------------------------------------------------------------------

@dataclass
class Turn:
    chat_id: str
    user_message_id: str
    started_at_epoch: int


def _now_epoch() -> int:
    return int(time.time())


def _resolve_model(client: OWUIClient, configured: str, fallback_substring: str) -> str:
    models = client.get_models()
    names = []
    for model in models:
        name = model.get("name") or model.get("id")
        if isinstance(name, str):
            names.append(name)
    if configured and configured in names:
        return configured
    for name in names:
        if fallback_substring.lower() in name.lower():
            return name
    raise SuiteError(
        f"No model matching {configured!r} or substring {fallback_substring!r} in {len(names)} models"
    )


def _start_chat(client: OWUIClient, model: str, prompt: str, tool_ids: list[str] | None) -> Turn:
    started = _now_epoch()
    created = client.create_chat(model=model, prompt=prompt)
    chat_id = created["chat_id"]
    user_message_id = created["user_message_id"]
    client.generate_completion(
        chat_id=chat_id,
        model=model,
        prompt=prompt,
        user_message_id=user_message_id,
        stream=True,  # native tool execution runs only on the streamed path
        tool_ids=tool_ids,
    )
    result = client.poll_for_completion(chat_id, user_message_id, timeout_seconds=TURN_TIMEOUT_SECONDS)
    if not result.get("complete"):
        raise SuiteError(f"turn did not complete for chat {chat_id}: {str(result.get('error'))[:160]}")
    return Turn(chat_id=chat_id, user_message_id=user_message_id, started_at_epoch=started)


def _follow_up(client: OWUIClient, turn: Turn, model: str, prompt: str, tool_ids: list[str] | None) -> None:
    appended = client.append_user_message(turn.chat_id, model=model, prompt=prompt)
    client.generate_completion(
        chat_id=turn.chat_id,
        model=model,
        prompt=prompt,
        user_message_id=appended["user_message_id"],
        stream=True,  # native tool execution runs only on the streamed path
        tool_ids=tool_ids,
    )
    result = client.poll_for_completion(
        turn.chat_id, appended["user_message_id"], timeout_seconds=TURN_TIMEOUT_SECONDS
    )
    if not result.get("complete"):
        raise SuiteError(f"follow-up did not complete for chat {turn.chat_id}")


# --------------------------------------------------------------------------
# Scenarios
# --------------------------------------------------------------------------

@dataclass
class ScenarioResult:
    id: str
    tag: str
    status: str = "measured"
    runs: int = 0
    metrics: dict[str, float] = field(default_factory=dict)
    desired: dict[str, float] = field(default_factory=dict)
    checks: list[tuple[str, bool]] = field(default_factory=list)
    notes: str = ""

    @property
    def passed(self) -> bool:
        return self.status == "measured" and all(ok for _, ok in self.checks)


def _median_metrics(runs: list[dict[str, float]]) -> dict[str, float]:
    merged: dict[str, float] = {}
    for key in {key for run in runs for key in run}:
        values = [run[key] for run in runs if key in run]
        merged[key] = statistics.median(values) if values else 0
    return merged


class Suite:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.client = OWUIClient(base_url=OPENWEBUI_BASE_URL, timeout=60.0)
        self.claude_model = _resolve_model(self.client, CLAUDE_MODEL, "Claude")
        self.chats_created: list[str] = []
        self._t1_metrics: dict[str, float] | None = None
        self._t3_metrics: dict[str, float] | None = None

    # -- infrastructure -----------------------------------------------------

    def _cleanup_chat(self, chat_id: str, scenario_ok: bool) -> None:
        if self.args.keep_chats or (not scenario_ok and self.args.keep_failed_chats):
            print(f"    keeping chat {chat_id} for inspection")
            return
        try:
            self.client.delete_chat(chat_id)
        except Exception as exc:  # noqa: BLE001 — cleanup is best-effort
            print(f"    warning: failed to delete chat {chat_id}: {str(exc)[:120]}")

    def _measure_last_request(self, turn: Turn, minimum_requests: int = 1) -> dict[str, float]:
        summaries = _wait_for_main_requests(turn.chat_id, minimum_requests)
        last = summaries[-1]
        request_id = str(last.get("request_id") or last.get("id"))
        payload = _raw_payload(_request_detail_with_payload(request_id))
        metrics: dict[str, float] = dict(_payload_tools_metrics(payload))
        wire, applied = _wire_tools_bytes(int(metrics["owui_tools_bytes"]), turn.started_at_epoch, turn.chat_id)
        metrics["wire_tools_bytes"] = wire
        metrics["slimming_applied"] = applied
        metrics["main_request_count"] = len(summaries)
        billed = _billed_prompt_tokens(turn.chat_id, summaries)
        if billed:
            metrics["billed_prompt_tokens"] = billed
        return metrics

    # -- scenarios ----------------------------------------------------------

    def t1_fresh_chat(self) -> ScenarioResult:
        result = ScenarioResult(id="T1", tag="A-claude")
        runs: list[dict[str, float]] = []
        for _ in range(self.args.runs):
            turn = _start_chat(self.client, self.claude_model, PROMPT_TRIVIAL, tool_ids=None)
            self.chats_created.append(turn.chat_id)
            metrics = self._measure_last_request(turn)
            runs.append(metrics)
            self._cleanup_chat(turn.chat_id, True)
        result.runs = len(runs)
        result.metrics = _median_metrics(runs)
        result.desired = {"wire_tools_bytes_max": THRESHOLDS["T1_wire_tools_bytes_max"]}
        result.checks = [
            (
                "wire_tools_bytes<=max",
                result.metrics.get("wire_tools_bytes", 1e12) <= THRESHOLDS["T1_wire_tools_bytes_max"],
            )
        ]
        self._t1_metrics = result.metrics
        return result

    def t2_activation_balloon(self) -> ScenarioResult:
        """Attaching google_workspace mid-chat. Measured deterministically via
        per-request tool_ids (same payload effect as agentic activation); the
        Plan-D variant (T2-P2) switches to the real activation rail."""
        result = ScenarioResult(id="T2", tag="A-claude")
        runs: list[dict[str, float]] = []
        for _ in range(self.args.runs):
            turn = _start_chat(self.client, self.claude_model, PROMPT_TRIVIAL, tool_ids=None)
            self.chats_created.append(turn.chat_id)
            base = self._measure_last_request(turn)
            _follow_up(self.client, turn, self.claude_model, PROMPT_TRIVIAL, tool_ids=GW_TOOL_IDS)
            after = self._measure_last_request(turn, minimum_requests=2)
            runs.append(
                {
                    "wire_tools_bytes_before": base["wire_tools_bytes"],
                    "wire_tools_bytes_after": after["wire_tools_bytes"],
                    "wire_tools_delta": after["wire_tools_bytes"] - base["wire_tools_bytes"],
                    "tool_count_after": after["tool_count"],
                    "slimming_applied": after["slimming_applied"],
                }
            )
            self._cleanup_chat(turn.chat_id, True)
        result.runs = len(runs)
        result.metrics = _median_metrics(runs)
        result.desired = {
            "wire_tools_delta_max": THRESHOLDS["T2_wire_tools_delta_max"],
            "plan_d_wire_tools_delta_max": THRESHOLDS["T2P2_wire_tools_delta_max"],
        }
        result.checks = [
            (
                "wire_tools_delta<=max",
                result.metrics.get("wire_tools_delta", 1e12) <= THRESHOLDS["T2_wire_tools_delta_max"],
            )
        ]
        return result

    def t3_billed_three_servers(self) -> ScenarioResult:
        result = ScenarioResult(id="T3", tag="A-claude")
        runs: list[dict[str, float]] = []
        for _ in range(self.args.runs):
            turn = _start_chat(
                self.client, self.claude_model, PROMPT_TRIVIAL, tool_ids=THREE_SERVER_TOOL_IDS
            )
            self.chats_created.append(turn.chat_id)
            metrics = self._measure_last_request(turn)
            # Second trivial turn feeds T9 (steady-state cache health).
            _follow_up(self.client, turn, self.claude_model, PROMPT_TRIVIAL, tool_ids=THREE_SERVER_TOOL_IDS)
            summaries = _wait_for_main_requests(turn.chat_id, 2)
            metrics["cache_read_tokens_turn2"] = _cache_read_tokens(turn.chat_id, summaries)
            billed = _billed_prompt_tokens(turn.chat_id, summaries)
            if billed:
                metrics["billed_prompt_tokens"] = billed
            runs.append(metrics)
            self._cleanup_chat(turn.chat_id, True)
        result.runs = len(runs)
        result.metrics = _median_metrics(runs)
        result.desired = {
            "billed_prompt_tokens_max": THRESHOLDS["T3_billed_prompt_tokens_max"],
            "plan_d_billed_prompt_tokens_max": THRESHOLDS["T3D_billed_prompt_tokens_max"],
        }
        billed_value = result.metrics.get("billed_prompt_tokens", 0)
        result.checks = [
            ("billed_prompt_tokens>0", billed_value > 0),
            ("billed_prompt_tokens<=max", 0 < billed_value <= THRESHOLDS["T3_billed_prompt_tokens_max"]),
        ]
        self._t3_metrics = result.metrics
        return result

    def t3g_billed_gemini(self) -> ScenarioResult:
        result = ScenarioResult(id="T3g", tag="A-gemini")
        model = _resolve_model(self.client, GEMINI_MODEL, "Gemini")
        runs: list[dict[str, float]] = []
        for _ in range(self.args.runs):
            turn = _start_chat(self.client, model, PROMPT_TRIVIAL, tool_ids=THREE_SERVER_TOOL_IDS)
            self.chats_created.append(turn.chat_id)
            runs.append(self._measure_last_request(turn))
            self._cleanup_chat(turn.chat_id, True)
        result.runs = len(runs)
        result.metrics = _median_metrics(runs)
        result.desired = {"billed_prompt_tokens_max": THRESHOLDS["T3G_billed_prompt_tokens_max"]}
        billed_value = result.metrics.get("billed_prompt_tokens", 0)
        result.checks = [
            ("billed_prompt_tokens>0", billed_value > 0),
            ("billed_prompt_tokens<=max", 0 < billed_value <= THRESHOLDS["T3G_billed_prompt_tokens_max"]),
        ]
        return result

    def t4_tool_count(self) -> ScenarioResult:
        result = ScenarioResult(id="T4", tag="D")
        if self._t3_metrics is None:
            result.status = "skipped"
            result.notes = "requires T3 in the same invocation"
            return result
        result.runs = 1
        result.metrics = {"tool_count": self._t3_metrics.get("tool_count", 0)}
        result.desired = {"tool_count_max": THRESHOLDS["T4_tool_count_max"]}
        result.checks = [
            ("tool_count<=max", result.metrics["tool_count"] <= THRESHOLDS["T4_tool_count_max"])
        ]
        return result

    def t8_gpt_guard(self) -> ScenarioResult:
        result = ScenarioResult(id="T8", tag="guard")
        model = _resolve_model(self.client, GPT_MODEL, "GPT")
        runs: list[dict[str, float]] = []
        for _ in range(self.args.runs):
            turn = _start_chat(self.client, model, PROMPT_TRIVIAL, tool_ids=THREE_SERVER_TOOL_IDS)
            self.chats_created.append(turn.chat_id)
            runs.append(self._measure_last_request(turn))
            self._cleanup_chat(turn.chat_id, True)
        result.runs = len(runs)
        result.metrics = _median_metrics(runs)
        baseline_billed = self._baseline_metric("T8", "billed_prompt_tokens")
        checks = [("tool_namespaces_present", result.metrics.get("has_tool_namespaces", 0) >= 1)]
        if baseline_billed:
            result.desired = {"billed_ratio_max": THRESHOLDS["T8_billed_ratio_max"]}
            ratio_ok = (
                result.metrics.get("billed_prompt_tokens", 0)
                <= baseline_billed * THRESHOLDS["T8_billed_ratio_max"]
            )
            checks.append(("billed_within_baseline_ratio", ratio_ok))
        result.checks = checks
        return result

    def t9_cache_health(self) -> ScenarioResult:
        result = ScenarioResult(id="T9", tag="guard")
        if self._t3_metrics is None:
            result.status = "skipped"
            result.notes = "requires T3 in the same invocation"
            return result
        result.runs = 1
        result.metrics = {"cache_read_tokens_turn2": self._t3_metrics.get("cache_read_tokens_turn2", 0)}
        result.checks = [("turn2_cache_read>0", result.metrics["cache_read_tokens_turn2"] > 0)]
        return result

    def targs_schema_sensitive(self) -> ScenarioResult:
        result = ScenarioResult(id="T-args", tag="guard")
        turn = _start_chat(self.client, self.claude_model, PROMPT_ARGS, tool_ids=GW_TOOL_IDS)
        self.chats_created.append(turn.chat_id)
        summaries = _wait_for_main_requests(turn.chat_id, 1)
        tool_names = _assistant_tool_names(turn.chat_id, summaries)
        metrics: dict[str, float] = {
            "main_request_count": len(summaries),
            "called_expected_tool": 1 if "google_workspace_get_events" in tool_names else 0,
            "distinct_tools_called": len(tool_names),
        }
        result.runs = 1
        result.metrics = metrics
        result.desired = {"max_main_requests": THRESHOLDS["TARGS_max_main_requests"]}
        ok = metrics["called_expected_tool"] == 1
        result.checks = [
            ("called_google_workspace_get_events", ok),
            ("request_count<=max", len(summaries) <= THRESHOLDS["TARGS_max_main_requests"]),
        ]
        self._cleanup_chat(turn.chat_id, result.passed)
        return result

    def plan_d_stub(self, scenario_id: str, note: str) -> ScenarioResult:
        return ScenarioResult(id=scenario_id, tag="D", status="requires-plan-d", notes=note)

    # -- baseline access ----------------------------------------------------

    def _baseline_metric(self, scenario_id: str, metric: str) -> float:
        path = self.args.baseline_file
        if not path or not Path(path).exists():
            return 0
        try:
            report = json.loads(Path(path).read_text())
        except (OSError, json.JSONDecodeError):
            return 0
        for scenario in report.get("scenarios", []):
            if scenario.get("id") == scenario_id:
                value = (scenario.get("metrics") or {}).get(metric)
                return float(value) if isinstance(value, (int, float)) else 0
        return 0


SCENARIO_ORDER = ["T1", "T2", "T3", "T3g", "T4", "T5", "T6", "T7", "T8", "T9", "T10", "T-args"]

PLAN_D_STUBS = {
    "T5": "discovery flow (find_tools -> activate -> hydrate -> native call) needs Plan D",
    "T6": "sticky/replay after discovered-tool call needs Plan D",
    "T7": "confirmation gate on a discovered destructive tool needs Plan D",
    "T10": "subset hydration correctness needs Plan D",
}


def run_suite(args: argparse.Namespace) -> int:
    suite = Suite(args)
    selected = [s.strip() for s in args.scenarios.split(",")] if args.scenarios else SCENARIO_ORDER
    expect_pass = {t.strip() for t in args.expect_pass.split(",") if t.strip()}

    runners = {
        "T1": suite.t1_fresh_chat,
        "T2": suite.t2_activation_balloon,
        "T3": suite.t3_billed_three_servers,
        "T3g": suite.t3g_billed_gemini,
        "T4": suite.t4_tool_count,
        "T8": suite.t8_gpt_guard,
        "T9": suite.t9_cache_health,
        "T-args": suite.targs_schema_sensitive,
    }

    results: list[ScenarioResult] = []
    for scenario_id in SCENARIO_ORDER:
        if scenario_id not in selected:
            continue
        if scenario_id in PLAN_D_STUBS:
            results.append(suite.plan_d_stub(scenario_id, PLAN_D_STUBS[scenario_id]))
            continue
        runner = runners.get(scenario_id)
        if runner is None:
            continue
        print(f"== {scenario_id} ==")
        try:
            result = runner()
        except SuiteError as exc:
            result = ScenarioResult(id=scenario_id, tag="guard", status="error", notes=str(exc)[:180])
        for name, ok in result.checks:
            print(f"    {name}: {'PASS' if ok else 'FAIL'}")
        for key, value in sorted(result.metrics.items()):
            print(f"    {key} = {value}")
        results.append(result)

    exit_code = 0
    print("\n== outcome ==")
    for result in results:
        if result.status == "requires-plan-d":
            print(f"  {result.id}: SPECIFIED (requires Plan D)")
            continue
        if result.status == "skipped":
            print(f"  {result.id}: SKIPPED ({result.notes})")
            continue
        if result.status == "error":
            print(f"  {result.id}: ERROR ({result.notes})")
            exit_code = max(exit_code, 2)
            continue
        expected_to_pass = result.tag == "guard" or result.tag in expect_pass
        if args.capture_baseline and not expected_to_pass:
            verdict = "RED (documented)" if not result.passed else "XPASS (unexpected)"
            print(f"  {result.id} [{result.tag}]: {verdict}")
            continue
        if expected_to_pass and not result.passed:
            print(f"  {result.id} [{result.tag}]: FAIL")
            exit_code = max(exit_code, 1)
        elif not expected_to_pass and result.passed:
            print(f"  {result.id} [{result.tag}]: XPASS — flip its tag deliberately via --expect-pass")
            exit_code = max(exit_code, 1)
        elif not expected_to_pass:
            print(f"  {result.id} [{result.tag}]: XFAIL (expected until rollout)")
        else:
            print(f"  {result.id} [{result.tag}]: PASS")

    if args.capture_baseline:
        report = {
            "schema": report_schema.SCHEMA_ID,
            "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "git_sha": _git_sha(),
            "stack": {
                "claude_model": suite.claude_model,
                "gemini_model": GEMINI_MODEL or "auto",
                "gpt_model": GPT_MODEL,
                "slimming_env": _container_env(LLM_GATEWAY_CONTAINER, "BRIDGE_TOOL_SLIMMING"),
            },
            "scenarios": [
                {
                    "id": r.id,
                    "tag": r.tag,
                    "status": r.status,
                    "runs": r.runs,
                    "metrics": {k: v for k, v in r.metrics.items()},
                    "desired": {k: v for k, v in r.desired.items()},
                    "would_pass": r.passed if r.status == "measured" else None,
                    "notes": r.notes or None,
                }
                for r in results
            ],
        }
        target = BASELINE_DIR / f"baseline-{datetime.now(timezone.utc).date().isoformat()}.json"
        report_schema.write_report(report, target)
        print(f"\nBaseline report written (metrics-only, schema-tripwired): {target}")

    return exit_code


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture-baseline", action="store_true", help="record the red baseline report")
    parser.add_argument("--scenarios", default="", help="comma-separated subset (default: all)")
    parser.add_argument("--runs", type=int, default=1, help="runs per scenario, median-of-N (default 1)")
    parser.add_argument(
        "--expect-pass",
        default=os.getenv("TOKENOMICS_EXPECT_PASS", ""),
        help="comma-separated tags whose gates must pass (A-claude,A-gemini,D)",
    )
    parser.add_argument("--baseline-file", default="", help="baseline report for ratio guards (T8)")
    parser.add_argument("--keep-chats", action="store_true", help="do not delete scenario chats")
    parser.add_argument(
        "--keep-failed-chats", action="store_true", default=True,
        help="keep chats for failed scenarios (default true)",
    )
    args = parser.parse_args()
    try:
        return run_suite(args)
    except SuiteError as exc:
        print(f"precondition/setup failure: {exc}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
