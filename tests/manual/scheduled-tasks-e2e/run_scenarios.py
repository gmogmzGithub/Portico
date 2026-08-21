#!/usr/bin/env python3
"""End-to-end miss-scenario campaign for the scheduling daemon.

Runs the REAL `scheduling-daemon` binary against a REAL Redis (throwaway
docker container) and the mock OWUI in mock_owui.py, with tasks created
through the REAL scheduling-server MCP `create_task` tool over stdio.
Downtime is simulated the way it actually happens: the task file was armed
in the past and the daemon wasn't running when the occurrence came due.

Usage:  python3 tests/manual/scheduled-tasks-e2e/run_scenarios.py

Prereqs: `cargo build -p scheduling-server --bins` in src/core-mcp-rust,
docker available (for the throwaway redis), port 18990/63790 free.
"""

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
TARGET = REPO / "src/core-mcp-rust/target/debug"
DAEMON = TARGET / "scheduling-daemon"
MCP_SERVER = TARGET / "scheduling-server"
MOCK = Path(__file__).resolve().parent / "mock_owui.py"

MOCK_PORT = 18990
MOCK_BASE = f"http://127.0.0.1:{MOCK_PORT}"
REDIS_NAME = "sched-e2e-redis"
REDIS_PORT = 63790
MODEL_ID = "Claude Sonnet 5"

FAILURES = []


def log(message):
    print(f"[e2e] {message}", flush=True)


def http_json(method, path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(
        f"{MOCK_BASE}{path}", data=data, method=method,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read())


def mock_state():
    return http_json("GET", "/__control/state")


def utc_now():
    return datetime.now(timezone.utc)


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def wait_for(description, predicate, timeout=30.0, interval=0.4):
    deadline = time.monotonic() + timeout
    last_error = None
    while time.monotonic() < deadline:
        try:
            value = predicate()
            if value:
                return value
        except Exception as error:  # noqa: BLE001 — not-up-yet counts as falsy
            last_error = error
        time.sleep(interval)
    suffix = f" (last error: {last_error})" if last_error else ""
    raise AssertionError(f"timed out waiting for: {description}{suffix}")


def redis_cli(*args):
    return subprocess.run(
        ["docker", "exec", REDIS_NAME, "redis-cli", *args],
        capture_output=True, text=True, check=True,
    ).stdout.strip()


class Scenario:
    """One daemon lifetime against a fresh store."""

    def __init__(self, name):
        self.name = name
        self.root = Path(tempfile.mkdtemp(prefix=f"sched-e2e-{name}-"))
        self.store = self.root / "app-support" / "scheduled_tasks"
        self.store.mkdir(parents=True)
        self.log_path = self.root / "daemon.log"
        self.daemon = None
        redis_cli("FLUSHALL")
        http_json("POST", "/__control/reset")

    def env(self):
        env = os.environ.copy()
        env.update({
            "PORTICO_APP_SUPPORT_DIR": str(self.root / "app-support"),
            "REDIS_HOST": "127.0.0.1",
            "REDIS_PORT": str(REDIS_PORT),
            "OPENWEBUI_API_TOKEN": "e2e-token",
            "OPENWEBUI_BASE_URL": MOCK_BASE,
            "CHAT_STATE_API_BASE_URL": MOCK_BASE,
            "portico_SCHEDULER_BRIDGE_STATUS_URL": f"{MOCK_BASE}/bridge/status",
            "portico_SCHEDULER_BRIDGE_STATUS_TOKEN": "e2e-bridge-token",
            "SCHEDULING_DAEMON_POLL_INTERVAL_SECONDS": "2",
            "RUST_LOG": "info",
        })
        return env

    # -- real-tool task creation over MCP stdio ---------------------------
    def create_task_via_mcp(self, name, prompt, schedule, task_hint=None):
        proc = subprocess.Popen(
            [str(MCP_SERVER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, env=self.env(), text=True,
        )

        def send(message):
            proc.stdin.write(json.dumps(message) + "\n")
            proc.stdin.flush()

        def recv(expect_id):
            while True:
                line = proc.stdout.readline()
                if not line:
                    raise AssertionError("MCP server closed stdout early")
                message = json.loads(line)
                if message.get("id") == expect_id:
                    return message

        send({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "sched-e2e", "version": "0"},
            },
        })
        recv(1)
        send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        send({
            "jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": {
                "name": "create_task",
                "arguments": {
                    "name": name,
                    "prompt": prompt,
                    "model_id": MODEL_ID,
                    "schedule": schedule,
                },
            },
        })
        response = recv(2)
        proc.stdin.close()
        proc.terminate()
        proc.wait(timeout=10)
        if response.get("error") or response.get("result", {}).get("isError"):
            raise AssertionError(f"create_task failed: {json.dumps(response)[:400]}")
        files = sorted(self.store.glob("*.json"), key=lambda p: p.stat().st_mtime)
        assert files, "create_task produced no task file"
        return files[-1]

    # -- task file helpers -------------------------------------------------
    def read_task(self, path):
        for _ in range(10):
            try:
                return json.loads(path.read_text())
            except json.JSONDecodeError:
                time.sleep(0.05)
        raise AssertionError(f"unreadable task file {path}")

    def rewind(self, path, next_run_at, run_at=None):
        """Simulate downtime: the task was armed in the past."""
        task = self.read_task(path)
        task["next_run_at"] = next_run_at
        if run_at is not None:
            task["schedule"]["run_at"] = run_at
        path.write_text(json.dumps(task, indent=1))

    # -- daemon lifecycle --------------------------------------------------
    def start_daemon(self):
        self.daemon = subprocess.Popen(
            [str(DAEMON)], env=self.env(),
            stdout=subprocess.DEVNULL, stderr=open(self.log_path, "ab"),
        )

    def kill_daemon(self, sig=signal.SIGTERM):
        if self.daemon and self.daemon.poll() is None:
            self.daemon.send_signal(sig)
            try:
                self.daemon.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.daemon.kill()
                self.daemon.wait(timeout=10)
        self.daemon = None

    def daemon_log(self):
        return self.log_path.read_text() if self.log_path.exists() else ""

    # -- run driving -------------------------------------------------------
    def wait_current_run(self, path, timeout=30.0):
        return wait_for(
            f"{path.name} current_run",
            lambda: (self.read_task(path).get("current_run") or None),
            timeout=timeout,
        )

    def finish_run(self, path, verdict_status="success", reason=None,
                   chat_content="scheduled digest delivered"):
        """Inject the finalizer verdict (as the model's scheduling_finalize_run
        would) and complete the mock chat, then wait for the terminal state."""
        current = self.wait_current_run(path)
        run_id, chat_id = current["run_id"], current["chat_id"]
        task_id = self.read_task(path)["id"]
        verdict = {
            "task_id": task_id, "run_id": run_id, "chat_id": chat_id,
            "status": verdict_status, "summary": chat_content,
            "reason": reason, "finalized_at": iso(utc_now()),
        }
        redis_cli("SET", f"scheduling_run_verdict:{run_id}", json.dumps(verdict), "EX", "3600")
        http_json("POST", "/__control/complete", {"chat_id": chat_id, "content": chat_content})
        return wait_for(
            f"{path.name} terminal",
            lambda: (lambda t: t if t.get("current_run") is None and t.get("last_run_status") else None)(
                self.read_task(path)
            ),
            timeout=40.0,
        )

    def cleanup(self):
        self.kill_daemon()
        shutil.rmtree(self.root, ignore_errors=True)


def check(condition, label, detail=""):
    if condition:
        log(f"  PASS  {label}")
    else:
        log(f"  FAIL  {label}  {detail}")
        FAILURES.append(label)


def occurrence_minutes_ago(minutes):
    """A (cron_expression, next_run_at) pair whose occurrence grid includes
    the instant `minutes` ago, daily cadence."""
    at = (utc_now() - timedelta(minutes=minutes)).replace(second=0, microsecond=0)
    return f"{at.minute} {at.hour} * * *", iso(at)


# ---------------------------------------------------------------------------
def scenario_on_time_run_and_prompt_contract():
    s = Scenario("on-time")
    try:
        path = s.create_task_via_mcp(
            "On time digest", "Summarize M&A news for me.",
            {"kind": "cron", "cron_expression": "* * * * *", "timezone": "UTC"},
        )
        # 30s late = within the 5-minute on-time threshold (not a catch-up).
        s.rewind(path, iso(utc_now() - timedelta(seconds=30)))
        s.start_daemon()
        task = s.finish_run(path)
        check(task["last_run_status"] == "success", "on-time run succeeds")
        check(task["needs_attention"] is False, "success clears attention")
        check(task["next_run_at"] > iso(utc_now() - timedelta(seconds=5)),
              "cron advanced to a future occurrence", task["next_run_at"])
        state = mock_state()
        chats = list(state["chats"].values())
        check(len(chats) == 1, "exactly one chat created")
        meta = chats[0]["meta"] or {}
        check(meta.get("run_origin") == "scheduled", "chat.meta.run_origin=scheduled")
        check(meta.get("scheduled_task_id") == task["id"], "chat.meta carries task id")
        completions = state["completions"]
        check(len(completions) == 1, "exactly one completion request")
        system = next((m for m in completions[0]["messages"] if m["role"] == "system"), {})
        content = system.get("content", "")
        check("MUST NOT ask the user questions" in content,
              "system prompt forbids asking the user")
        check("what blocked this run" in content,
              "system prompt requires block-and-explain")
        log_text = s.daemon_log()
        check("Scheduled run started" in log_text, "run start logged")
        check("Scheduled run finished: success" in log_text, "run success logged")
    finally:
        s.cleanup()


def scenario_catch_up_after_downtime():
    s = Scenario("catch-up")
    try:
        cron, armed = occurrence_minutes_ago(120)
        path = s.create_task_via_mcp(
            "Morning digest", "Check the news for me.",
            {"kind": "cron", "cron_expression": cron, "timezone": "UTC"},
        )
        s.rewind(path, armed)  # came due 2h ago while "the app was closed"
        s.start_daemon()
        task = s.finish_run(path)
        check(task["last_run_status"] == "success", "2h-late occurrence runs (catch-up)")
        missed_rows = [r for r in task["runs"] if r.get("status") == "missed"]
        check(not missed_rows, "still-current occurrence records no missed rows")
        check("Scheduled run started" in s.daemon_log(), "catch-up start logged")
    finally:
        s.cleanup()


def scenario_superseded_multi_miss_and_restart_idempotence():
    s = Scenario("superseded")
    try:
        at = (utc_now() - timedelta(minutes=10)).replace(second=0, microsecond=0)
        cron = f"{at.minute} * * * *"  # hourly grid through 10 minutes ago
        path = s.create_task_via_mcp(
            "Hourly sweep", "Collect hourly metrics for me.",
            {"kind": "cron", "cron_expression": cron, "timezone": "UTC"},
        )
        s.rewind(path, iso(at - timedelta(hours=3)))  # 3 occurrences superseded
        s.start_daemon()
        task = s.finish_run(path)
        check(task["last_run_status"] == "success", "most recent occurrence ran")
        missed_rows = [r for r in task["runs"] if r.get("status") == "missed"]
        check(len(missed_rows) == 1, "exactly one missed row for the stale span",
              json.dumps(missed_rows)[:200])
        error = (missed_rows or [{}])[0].get("error", "")
        check(error.startswith("Skipped 3 scheduled runs"),
              "missed row counts 3 superseded occurrences", error[:120])
        check(missed_rows[0].get("needs_attention_reason") == "missed_run",
              "missed row flagged missed_run")
        check("Recorded superseded scheduled occurrences" in s.daemon_log(),
              "superseded recording logged")

        # Restart the daemon: nothing should re-run or re-record.
        rows_before = len(task["runs"])
        completions_before = len(mock_state()["completions"])
        s.kill_daemon()
        s.start_daemon()
        time.sleep(6)  # ~3 sweeps
        after = s.read_task(path)
        check(len(after["runs"]) == rows_before, "restart adds no run rows")
        check(len(mock_state()["completions"]) == completions_before,
              "restart starts no duplicate runs")
    finally:
        s.cleanup()


def scenario_throttle_one_catch_up_per_sweep():
    s = Scenario("throttle")
    try:
        cron, armed = occurrence_minutes_ago(90)
        paths = {}
        for suffix in ("a", "b", "c"):
            path = s.create_task_via_mcp(
                f"Throttle {suffix}", f"Run throttle task {suffix} for me.",
                {"kind": "cron", "cron_expression": cron, "timezone": "UTC"},
            )
            new_path = path.with_name(f"scheduled-task-throttle-{suffix}.json")
            task = s.read_task(path)
            task["id"] = f"scheduled-task-throttle-{suffix}"
            path.unlink()
            new_path.write_text(json.dumps(task, indent=1))
            s.rewind(new_path, armed)
            paths[suffix] = new_path
        s.start_daemon()
        for suffix in ("a", "b", "c"):
            task = s.finish_run(paths[suffix], chat_content=f"digest {suffix}")
            check(task["last_run_status"] == "success", f"throttled task {suffix} succeeds")
        log_text = s.daemon_log()
        defers = re.findall(r"Deferring catch-up run.*task_id=(\S+)", log_text)
        check(len(defers) >= 2, "later tasks deferred by per-sweep budget", str(defers))
        starts = re.findall(r"Scheduled run started.*?task_id=(\S+)", log_text)
        check(starts[:3] == [
            "scheduled-task-throttle-a",
            "scheduled-task-throttle-b",
            "scheduled-task-throttle-c",
        ], "catch-ups drain most-overdue-first, one per sweep", str(starts))
    finally:
        s.cleanup()


def scenario_bridge_defer_and_recover():
    s = Scenario("bridge")
    try:
        cron, armed = occurrence_minutes_ago(60)
        path = s.create_task_via_mcp(
            "Bridge held", "Deliver the report to me.",
            {"kind": "cron", "cron_expression": cron, "timezone": "UTC"},
        )
        s.rewind(path, armed)
        http_json("POST", "/__control/bridge", {"ready": False})
        s.start_daemon()
        time.sleep(7)  # ~3 sweeps with the bridge down
        held = s.read_task(path)
        check(held.get("last_run_status") is None, "no terminal while bridge down")
        check(held["next_run_at"] == armed, "occurrence NOT burned while bridge down")
        check(not mock_state()["chats"], "no chat created while bridge down")
        check("Scheduler bridge not ready; deferring" in s.daemon_log(),
              "bridge deferral logged")
        http_json("POST", "/__control/bridge", {"ready": True})
        task = s.finish_run(path)
        check(task["last_run_status"] == "success", "deferred occurrence runs after recovery")
    finally:
        s.cleanup()


def scenario_once_catch_up_and_expiry():
    s = Scenario("once")
    try:
        # Within the 24h window: runs late, then disables.
        catch_path = s.create_task_via_mcp(
            "Once catch up", "Send me the one-off summary.",
            {"kind": "once", "run_at": iso(utc_now() + timedelta(hours=1)), "timezone": "UTC"},
        )
        an_hour_ago = iso(utc_now() - timedelta(hours=1))
        s.rewind(catch_path, an_hour_ago, run_at=an_hour_ago)

        # Beyond the window: recorded missed + disabled, never executed.
        expired_path = s.create_task_via_mcp(
            "Once expired", "Send me the stale one-off summary.",
            {"kind": "once", "run_at": iso(utc_now() + timedelta(hours=2)), "timezone": "UTC"},
        )
        thirty_hours_ago = iso(utc_now() - timedelta(hours=30))
        s.rewind(expired_path, thirty_hours_ago, run_at=thirty_hours_ago)

        s.start_daemon()
        ran = s.finish_run(catch_path)
        check(ran["last_run_status"] == "success", "once-task within 24h catches up")
        check(ran["enabled"] is False, "once-task disables after running")

        expired = wait_for(
            "expired once-task terminal",
            lambda: (lambda t: t if t.get("last_run_status") else None)(s.read_task(expired_path)),
        )
        check(expired["last_run_status"] == "missed", "expired once-task recorded missed")
        check(expired["enabled"] is False, "expired once-task disabled")
        check(expired["needs_attention_reason"] == "missed_run", "expired once flagged")
        check("catch-up window had already passed" in (expired.get("last_run_error") or ""),
              "expiry explanation on task", expired.get("last_run_error"))
        chats = mock_state()["chats"]
        chat_prompts = [c["user_message"] for c in chats.values()]
        check(all("stale" not in p for p in chat_prompts),
              "expired once-task never created a chat", str(chat_prompts))
        check("One-off scheduled task expired unrun" in s.daemon_log(),
              "once expiry logged")
    finally:
        s.cleanup()


def scenario_orphan_reattach_after_kill():
    s = Scenario("orphan")
    try:
        path = s.create_task_via_mcp(
            "Orphan run", "Watch the long job for me.",
            {"kind": "cron", "cron_expression": "* * * * *", "timezone": "UTC"},
        )
        s.rewind(path, iso(utc_now() - timedelta(seconds=30)))
        s.start_daemon()
        current = s.wait_current_run(path)
        wait_for("completion request captured",
                 lambda: len(mock_state()["completions"]) == 1)
        s.kill_daemon(signal.SIGKILL)  # daemon dies mid-run

        s.start_daemon()  # restart: reconcile_orphans must re-attach, not restart
        time.sleep(6)
        after = s.read_task(path)
        check((after.get("current_run") or {}).get("run_id") == current["run_id"],
              "restart re-attaches the in-flight run")
        check(len(mock_state()["completions"]) == 1,
              "no duplicate completion for the in-flight chat")
        check(len(mock_state()["chats"]) == 1, "no duplicate chat after restart")
        task = s.finish_run(path)
        check(task["last_run_status"] == "success", "re-attached run completes")
    finally:
        s.cleanup()


def scenario_needs_attention_explanation():
    s = Scenario("attention")
    try:
        cron, armed = occurrence_minutes_ago(45)
        path = s.create_task_via_mcp(
            "Blocked task", "Post the digest to Slack for me.",
            {"kind": "cron", "cron_expression": cron, "timezone": "UTC"},
        )
        s.rewind(path, armed)
        s.start_daemon()
        explanation = (
            "This run could not post to Slack because the Slack integration is not "
            "authenticated. Re-connect Slack under Integrations, then this task will "
            "resume on its normal schedule."
        )
        task = s.finish_run(
            path, verdict_status="needs_attention",
            reason="Slack integration is not authenticated; re-connect Slack in Integrations.",
            chat_content=explanation,
        )
        check(task["last_run_status"] == "failed",
              "needs_attention verdict records failed terminal")
        check(task["needs_attention"] is True, "task flagged for attention")
        check("Slack integration is not authenticated"
              in (task.get("last_run_error") or ""),
              "blocker reason preserved on the task", task.get("last_run_error"))
        chats = list(mock_state()["chats"].values())
        check(any(c["assistant_content"] == explanation for c in chats),
              "explanation persisted as the run chat's final message")
        check("Scheduled run finished with non-success status" in s.daemon_log(),
              "non-success terminal logged")
    finally:
        s.cleanup()


SCENARIOS = [
    scenario_on_time_run_and_prompt_contract,
    scenario_catch_up_after_downtime,
    scenario_superseded_multi_miss_and_restart_idempotence,
    scenario_throttle_one_catch_up_per_sweep,
    scenario_bridge_defer_and_recover,
    scenario_once_catch_up_and_expiry,
    scenario_orphan_reattach_after_kill,
    scenario_needs_attention_explanation,
]


def main():
    for binary in (DAEMON, MCP_SERVER):
        if not binary.exists():
            sys.exit(f"missing {binary}; run: cargo build -p scheduling-server --bins")

    subprocess.run(["docker", "rm", "-f", REDIS_NAME], capture_output=True)
    subprocess.run(
        ["docker", "run", "-d", "--name", REDIS_NAME,
         "-p", f"127.0.0.1:{REDIS_PORT}:6379", "redis:7-alpine"],
        check=True, capture_output=True,
    )
    mock = subprocess.Popen([sys.executable, str(MOCK), str(MOCK_PORT)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait_for("redis ping", lambda: redis_cli("PING") == "PONG", timeout=20)
        wait_for("mock owui up", lambda: mock_state() is not None, timeout=20)
        for scenario in SCENARIOS:
            log(f"── {scenario.__name__} " + "─" * max(0, 46 - len(scenario.__name__)))
            try:
                scenario()
            except Exception as error:  # noqa: BLE001 — report and continue
                log(f"  FAIL  {scenario.__name__} raised: {error}")
                FAILURES.append(f"{scenario.__name__}: {error}")
    finally:
        mock.terminate()
        subprocess.run(["docker", "rm", "-f", REDIS_NAME], capture_output=True)

    log("═" * 60)
    if FAILURES:
        log(f"RESULT: {len(FAILURES)} failure(s)")
        for failure in FAILURES:
            log(f"  ✗ {failure}")
        sys.exit(1)
    log("RESULT: all scenarios passed")


if __name__ == "__main__":
    main()
