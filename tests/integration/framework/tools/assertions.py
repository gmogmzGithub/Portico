"""
Assertion Tool

Records test assertions for the integration testing framework.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional


@dataclass
class Assertion:
    """Represents a test assertion."""
    condition: bool
    message: str
    severity: str  # "critical", "warning", "info"
    timestamp: datetime = field(default_factory=datetime.now)
    context: Optional[Dict[str, Any]] = None

    @property
    def passed(self) -> bool:
        return self.condition

    def to_dict(self) -> Dict[str, Any]:
        return {
            "passed": self.passed,
            "message": self.message,
            "severity": self.severity,
            "timestamp": self.timestamp.isoformat(),
            "context": self.context
        }


# Global assertion storage
_assertions: List[Assertion] = []


def _get_assertions_file() -> Optional[str]:
    """Get the assertions file path from environment."""
    import os
    return os.environ.get("ASSERTIONS_FILE")


def _save_assertions_to_file():
    """Save assertions to file if ASSERTIONS_FILE is set."""
    file_path = _get_assertions_file()
    if file_path:
        import json
        data = [a.to_dict() for a in _assertions]
        with open(file_path, "w") as f:
            json.dump(data, f)


def _load_assertions_from_file() -> List[Assertion]:
    """Load assertions from file if ASSERTIONS_FILE is set."""
    file_path = _get_assertions_file()
    if file_path:
        import json
        import os
        if os.path.exists(file_path):
            with open(file_path, "r") as f:
                data = json.load(f)
            return [
                Assertion(
                    condition=a["passed"],
                    message=a["message"],
                    severity=a["severity"],
                    timestamp=datetime.fromisoformat(a["timestamp"]),
                    context=a.get("context")
                )
                for a in data
            ]
    return []


def clear_assertions():
    """Clear all recorded assertions."""
    global _assertions
    _assertions = []
    # Also clear file if exists
    file_path = _get_assertions_file()
    if file_path:
        import os
        if os.path.exists(file_path):
            os.remove(file_path)


def get_all_assertions() -> List[Assertion]:
    """Get all recorded assertions."""
    # Try to load from file first (for cross-process assertions)
    file_assertions = _load_assertions_from_file()
    if file_assertions:
        return file_assertions
    return _assertions.copy()


def get_assertion_summary() -> Dict[str, Any]:
    """Get a summary of all assertions."""
    # Use get_all_assertions to get file-based or in-memory assertions
    assertions = get_all_assertions()
    total = len(assertions)
    passed = sum(1 for a in assertions if a.passed)
    failed = total - passed

    critical_failures = [a for a in assertions if not a.passed and a.severity == "critical"]
    warnings = [a for a in assertions if not a.passed and a.severity == "warning"]

    return {
        "total": total,
        "passed": passed,
        "failed": failed,
        "pass_rate": passed / total if total > 0 else 1.0,
        "critical_failures": len(critical_failures),
        "warnings": len(warnings),
        "all_passed": failed == 0,
        "critical_passed": len(critical_failures) == 0
    }


async def assert_condition(
    condition: bool,
    message: str,
    severity: str = "critical",
    context: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    Assert a test condition and record the result.

    Args:
        condition: Boolean condition to assert
        message: Description of what's being tested
        severity: "critical" (test fails), "warning" (noted but continues), "info" (informational)
        context: Optional additional context data

    Returns:
        Dict containing:
            - passed: Boolean indicating if condition passed
            - message: The assertion message
            - severity: The severity level
            - assertion_count: Total assertions so far
    """
    # Load existing assertions from file first (for cross-process persistence)
    global _assertions
    _assertions = _load_assertions_from_file()

    assertion = Assertion(
        condition=condition,
        message=message,
        severity=severity,
        context=context
    )
    _assertions.append(assertion)

    # Save assertions to file for cross-process access
    _save_assertions_to_file()

    status = "PASSED" if condition else "FAILED"
    icon = "✅" if condition else "❌"

    return {
        "passed": condition,
        "message": message,
        "severity": severity,
        "status": f"{icon} {status}",
        "assertion_number": len(_assertions),
        "context": context
    }


async def assert_equals(
    actual: Any,
    expected: Any,
    message: str,
    severity: str = "critical"
) -> Dict[str, Any]:
    """
    Assert that actual equals expected.

    Args:
        actual: The actual value
        expected: The expected value
        message: Description of what's being tested
        severity: Assertion severity

    Returns:
        Assertion result dict
    """
    condition = actual == expected
    context = {
        "actual": actual,
        "expected": expected
    } if not condition else None

    full_message = f"{message}: expected '{expected}', got '{actual}'" if not condition else message

    return await assert_condition(condition, full_message, severity, context)


async def assert_contains(
    container: Any,
    item: Any,
    message: str,
    severity: str = "critical"
) -> Dict[str, Any]:
    """
    Assert that container contains item.

    Args:
        container: The container (list, string, dict keys, etc.)
        item: The item to find
        message: Description of what's being tested
        severity: Assertion severity

    Returns:
        Assertion result dict
    """
    try:
        condition = item in container
    except TypeError:
        condition = False

    context = {
        "container_type": type(container).__name__,
        "item": item
    } if not condition else None

    full_message = f"{message}: '{item}' not found" if not condition else message

    return await assert_condition(condition, full_message, severity, context)


async def assert_not_empty(
    value: Any,
    message: str,
    severity: str = "critical"
) -> Dict[str, Any]:
    """
    Assert that value is not empty/None/falsy.

    Args:
        value: The value to check
        message: Description of what's being tested
        severity: Assertion severity

    Returns:
        Assertion result dict
    """
    condition = bool(value)
    context = {"value_type": type(value).__name__} if not condition else None

    return await assert_condition(condition, message, severity, context)


# Tool definition for Atlas Agent SDK
ASSERT_CONDITION_TOOL = {
    "name": "assert_condition",
    "description": "Assert a test condition. Records pass/fail result for the test report.",
    "input_schema": {
        "type": "object",
        "properties": {
            "condition": {
                "type": "boolean",
                "description": "The condition to assert (true = pass, false = fail)"
            },
            "message": {
                "type": "string",
                "description": "Description of what is being tested"
            },
            "severity": {
                "type": "string",
                "enum": ["critical", "warning", "info"],
                "description": "Severity level: critical (fails test), warning (noted), info (informational)",
                "default": "critical"
            }
        },
        "required": ["condition", "message"]
    }
}
