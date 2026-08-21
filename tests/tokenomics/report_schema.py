"""Metrics-only report writer for the tokenomics problem-proof suite.

Sensitive-data rule (hard constraint, motivated by the raw-message filesystem
leak incident): reports written by this module may contain ONLY aggregate
metrics — scenario ids, tags, counts, byte sizes, token numbers, timings,
pass/fail booleans, and short identifiers (model aliases, git sha). Never
message text, prompts, tool-call arguments, or tool results.

The validator below is the mechanical tripwire: it rejects unexpected key
names, any forbidden content-ish key, and any string value longer than
MAX_STRING_CHARS. The suite refuses to write a report that fails validation.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

SCHEMA_ID = "tokenomics-baseline/1"
MAX_STRING_CHARS = 200
MAX_KEY_CHARS = 64

KEY_PATTERN = re.compile(r"^[A-Za-z0-9_.\-/]+$")

# Key names that indicate payload content is leaking into a report.
FORBIDDEN_KEY_NAMES = frozenset(
    {
        "content",
        "contents",
        "message",
        "messages",
        "prompt",
        "prompts",
        "arguments",
        "args",
        "result",
        "results",
        "response",
        "text",
        "body",
        "description",
        "query",
        "transcript",
        "payload",
        "raw_payload",
        "tool_calls",
        "system",
    }
)

TOP_LEVEL_KEYS = frozenset({"schema", "captured_at", "git_sha", "stack", "scenarios"})
SCENARIO_KEYS = frozenset(
    {"id", "tag", "status", "runs", "metrics", "desired", "would_pass", "notes"}
)
SCENARIO_STATUSES = frozenset({"measured", "requires-plan-d", "skipped", "error"})


class ReportSchemaError(ValueError):
    """Raised when a report violates the metrics-only schema."""


def _validate_leaf(path: str, value: Any) -> None:
    if value is None or isinstance(value, (bool, int, float)):
        return
    if isinstance(value, str):
        if len(value) > MAX_STRING_CHARS:
            raise ReportSchemaError(
                f"{path}: string value exceeds {MAX_STRING_CHARS} chars "
                f"({len(value)}) — payload content is not allowed in reports"
            )
        return
    raise ReportSchemaError(f"{path}: unsupported leaf type {type(value).__name__}")


def _validate_node(path: str, value: Any) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if not isinstance(key, str):
                raise ReportSchemaError(f"{path}: non-string key {key!r}")
            if len(key) > MAX_KEY_CHARS or not KEY_PATTERN.match(key):
                raise ReportSchemaError(f"{path}: invalid key name {key!r}")
            if key.lower() in FORBIDDEN_KEY_NAMES:
                raise ReportSchemaError(
                    f"{path}: forbidden key {key!r} — reports are metrics-only"
                )
            _validate_node(f"{path}.{key}", child)
        return
    if isinstance(value, list):
        for index, child in enumerate(value):
            _validate_node(f"{path}[{index}]", child)
        return
    _validate_leaf(path, value)


def validate_report(report: dict[str, Any]) -> None:
    """Raise ReportSchemaError unless `report` is metrics-only."""
    if not isinstance(report, dict):
        raise ReportSchemaError("report must be a dict")
    unexpected = set(report) - TOP_LEVEL_KEYS
    if unexpected:
        raise ReportSchemaError(f"unexpected top-level keys: {sorted(unexpected)}")
    missing = TOP_LEVEL_KEYS - set(report)
    if missing:
        raise ReportSchemaError(f"missing top-level keys: {sorted(missing)}")
    if report["schema"] != SCHEMA_ID:
        raise ReportSchemaError(f"schema must be {SCHEMA_ID!r}")
    scenarios = report["scenarios"]
    if not isinstance(scenarios, list) or not scenarios:
        raise ReportSchemaError("scenarios must be a non-empty list")
    for index, scenario in enumerate(scenarios):
        if not isinstance(scenario, dict):
            raise ReportSchemaError(f"scenarios[{index}] must be a dict")
        unexpected = set(scenario) - SCENARIO_KEYS
        if unexpected:
            raise ReportSchemaError(
                f"scenarios[{index}] unexpected keys: {sorted(unexpected)}"
            )
        status = scenario.get("status")
        if status not in SCENARIO_STATUSES:
            raise ReportSchemaError(
                f"scenarios[{index}].status invalid: {status!r}"
            )
    _validate_node("report", report)


def write_report(report: dict[str, Any], path: Path) -> None:
    """Validate then write; refuses to persist anything non-metrics."""
    validate_report(report)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
