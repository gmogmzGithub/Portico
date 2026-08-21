"""CI-safe unit tests for the tokenomics report tripwire (no network/stack)."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

MODULE_PATH = Path(__file__).resolve().parent / "report_schema.py"
SPEC = importlib.util.spec_from_file_location("tokenomics_report_schema", MODULE_PATH)
report_schema = importlib.util.module_from_spec(SPEC)
sys.modules["tokenomics_report_schema"] = report_schema
SPEC.loader.exec_module(report_schema)


def _valid_report() -> dict:
    return {
        "schema": report_schema.SCHEMA_ID,
        "captured_at": "2026-08-06T12:00:00Z",
        "git_sha": "abc1234",
        "stack": {
            "atlas_model": "Atlas Opus 5",
            "gemini_model": "Gemini 3.6 Flash",
            "gpt_model": "GPT-5.6 Sol",
            "slimming_env": "unset",
        },
        "scenarios": [
            {
                "id": "T1",
                "tag": "A-atlas",
                "status": "measured",
                "runs": 1,
                "metrics": {
                    "owui_tools_bytes": 116386,
                    "wire_tools_bytes": 116386,
                    "tool_count": 106,
                },
                "desired": {"wire_tools_bytes_max": 70000},
                "would_pass": False,
            },
            {
                "id": "T5",
                "tag": "D",
                "status": "requires-plan-d",
                "runs": 0,
                "metrics": {},
                "desired": {},
                "would_pass": None,
            },
        ],
    }


def test_valid_report_passes():
    report_schema.validate_report(_valid_report())


def test_write_report_round_trips(tmp_path):
    target = tmp_path / "baseline-test.json"
    report_schema.write_report(_valid_report(), target)
    assert target.exists()
    assert "owui_tools_bytes" in target.read_text()


def test_long_string_rejected():
    report = _valid_report()
    report["scenarios"][0]["metrics"]["oversize"] = "x" * 201
    with pytest.raises(report_schema.ReportSchemaError, match="exceeds 200"):
        report_schema.validate_report(report)


@pytest.mark.parametrize(
    "leak_key", ["messages", "prompt", "arguments", "result", "raw_payload", "query"]
)
def test_forbidden_content_keys_rejected(leak_key):
    report = _valid_report()
    report["scenarios"][0]["metrics"][leak_key] = 1
    with pytest.raises(report_schema.ReportSchemaError, match="forbidden key"):
        report_schema.validate_report(report)


def test_unexpected_top_level_key_rejected():
    report = _valid_report()
    report["extra"] = {}
    with pytest.raises(report_schema.ReportSchemaError, match="unexpected top-level"):
        report_schema.validate_report(report)


def test_unexpected_scenario_key_rejected():
    report = _valid_report()
    report["scenarios"][0]["surprise"] = 1
    with pytest.raises(report_schema.ReportSchemaError, match="unexpected keys"):
        report_schema.validate_report(report)


def test_invalid_status_rejected():
    report = _valid_report()
    report["scenarios"][0]["status"] = "mystery"
    with pytest.raises(report_schema.ReportSchemaError, match="status invalid"):
        report_schema.validate_report(report)


def test_nested_dict_leak_rejected():
    report = _valid_report()
    report["scenarios"][0]["metrics"]["nested"] = {"deep": {"text": "leak"}}
    with pytest.raises(report_schema.ReportSchemaError, match="forbidden key"):
        report_schema.validate_report(report)


def test_write_refuses_invalid(tmp_path):
    report = _valid_report()
    report["scenarios"][0]["metrics"]["prompt"] = "leak"
    target = tmp_path / "never.json"
    with pytest.raises(report_schema.ReportSchemaError):
        report_schema.write_report(report, target)
    assert not target.exists()
