from pathlib import Path
import ast
import asyncio
from typing import Any, Callable, Optional


REPO_ROOT = Path(__file__).resolve().parents[1]
MIDDLEWARE_PATH = (
    REPO_ROOT / "src/patches/backend/open_webui/utils/middleware.py"
)


class _FakeLog:
    def debug(self, *args, **kwargs):
        return None


def _load_retry_status_helpers():
    source = MIDDLEWARE_PATH.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(MIDDLEWARE_PATH))
    wanted_names = {
        "UPSTREAM_RETRY_STATUS_ACTION",
        "UPSTREAM_RETRY_STATUS_KEY",
        "_status_event_observed_at",
        "_build_upstream_retry_status_data",
        "_emit_upstream_retry_status",
    }
    selected_nodes = []
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id in wanted_names:
                    selected_nodes.append(node)
                    break
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.name in wanted_names:
                selected_nodes.append(node)

    module = ast.Module(body=selected_nodes, type_ignores=[])
    namespace = {
        "Any": Any,
        "Callable": Callable,
        "Optional": Optional,
        "time": __import__("time"),
        "log": _FakeLog(),
    }
    exec(compile(module, str(MIDDLEWARE_PATH), "exec"), namespace)
    return namespace


HELPERS = _load_retry_status_helpers()
UPSTREAM_RETRY_STATUS_ACTION = HELPERS["UPSTREAM_RETRY_STATUS_ACTION"]
UPSTREAM_RETRY_STATUS_KEY = HELPERS["UPSTREAM_RETRY_STATUS_KEY"]
_build_upstream_retry_status_data = HELPERS["_build_upstream_retry_status_data"]
_emit_upstream_retry_status = HELPERS["_emit_upstream_retry_status"]


def test_build_upstream_retry_status_data_contains_retry_identity():
    payload = _build_upstream_retry_status_data(
        description="Model provider stalled; retrying (attempt 1/4)",
        done=False,
        observed_at="2026-03-19T20:00:51Z",
    )

    assert payload == {
        "action": UPSTREAM_RETRY_STATUS_ACTION,
        "status_key": UPSTREAM_RETRY_STATUS_KEY,
        "description": "Model provider stalled; retrying (attempt 1/4)",
        "done": False,
        "observed_at": "2026-03-19T20:00:51Z",
    }


def test_emit_upstream_retry_status_emits_retry_recovery_and_terminal_events():
    events = []

    async def event_emitter(event):
        events.append(event)

    async def run():
        await _emit_upstream_retry_status(
            event_emitter,
            description="Model provider stalled; retrying (attempt 1/4)",
            done=False,
        )
        await _emit_upstream_retry_status(
            event_emitter,
            description="Recovered after upstream retry",
            done=True,
            hidden=True,
        )
        await _emit_upstream_retry_status(
            event_emitter,
            description="Model provider did not recover after retries",
            done=True,
            error=True,
        )

    asyncio.run(run())

    assert [event["type"] for event in events] == ["status", "status", "status"]
    assert events[0]["data"]["status_key"] == UPSTREAM_RETRY_STATUS_KEY
    assert events[0]["data"]["done"] is False
    assert events[1]["data"]["hidden"] is True
    assert events[2]["data"]["error"] is True


def test_emit_upstream_retry_status_ignores_missing_emitter():
    asyncio.run(
        _emit_upstream_retry_status(
            None,
            description="Model provider stalled; retrying (attempt 1/4)",
            done=False,
        )
    )
