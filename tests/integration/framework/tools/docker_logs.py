"""
Docker Logs Tool

Checks Docker container logs for expected patterns.
"""

import re
import subprocess
from typing import Any, Dict, List, Optional

from .assertions import assert_condition


async def check_docker_logs(
    patterns: List[str],
    container: str = "portico-open-webui",
    since: str = "5m",
    expect_all: bool = True,
    check_order: bool = False,
    auto_assert: bool = True
) -> Dict[str, Any]:
    """
    Search Docker container logs for specific patterns.

    Args:
        patterns: List of regex patterns to search for
        container: Container name (default: portico-open-webui)
        since: Time filter for logs (e.g., "5m", "1h", "30s")
        expect_all: All patterns must match (default: True)
        check_order: Verify patterns appear in order (default: False)

    Returns:
        Dict containing:
            - found: Boolean indicating if expectations were met
            - matches: List of {pattern, lines, line_numbers} for each found pattern
            - missing_patterns: List of patterns not found
            - log_lines: Total number of log lines checked
            - error: Error message if command failed
    """
    try:
        # Get Docker logs
        cmd = ["docker", "logs", "--since", since, container]
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30
        )

        # Combine stdout and stderr (Docker logs can go to either)
        logs = result.stdout + "\n" + result.stderr
        lines = logs.split("\n")

        matches = []
        missing_patterns = []
        pattern_positions = {}  # Track first occurrence position for order checking

        for pattern in patterns:
            pattern_matches = []
            regex = re.compile(pattern, re.IGNORECASE)

            for i, line in enumerate(lines):
                if regex.search(line):
                    pattern_matches.append({
                        "line_number": i + 1,
                        "line": line.strip()[:500]  # Truncate long lines
                    })
                    if pattern not in pattern_positions:
                        pattern_positions[pattern] = i

            if pattern_matches:
                matches.append({
                    "pattern": pattern,
                    "count": len(pattern_matches),
                    "lines": pattern_matches[:10]  # Limit to first 10 matches
                })
            else:
                missing_patterns.append(pattern)

        # Check order if requested
        order_correct = True
        order_details = None
        if check_order and len(pattern_positions) > 1:
            positions = [(p, pattern_positions.get(p, float('inf'))) for p in patterns if p in pattern_positions]
            sorted_positions = sorted(positions, key=lambda x: x[1])
            expected_order = [p for p, _ in positions]
            actual_order = [p for p, _ in sorted_positions]

            if expected_order != actual_order:
                order_correct = False
                order_details = {
                    "expected": expected_order,
                    "actual": actual_order
                }

        # Determine success
        if expect_all:
            found = len(missing_patterns) == 0 and (not check_order or order_correct)
        else:
            found = len(matches) > 0

        response = {
            "found": found,
            "matches": matches,
            "missing_patterns": missing_patterns,
            "log_lines": len(lines),
            "order_correct": order_correct if check_order else None,
            "order_details": order_details
        }

        if auto_assert:
            if found:
                await assert_condition(
                    condition=True,
                    message=f"All {len(patterns)} log patterns found in {container}",
                    severity="critical"
                )
            else:
                await assert_condition(
                    condition=False,
                    message=f"Missing log patterns in {container}: {missing_patterns}",
                    severity="critical"
                )

        return response

    except subprocess.TimeoutExpired:
        error_msg = "Docker logs command timed out"
        if auto_assert:
            await assert_condition(
                condition=False,
                message=f"Docker logs error: {error_msg}",
                severity="critical"
            )
        return {
            "found": False,
            "error": error_msg,
            "matches": [],
            "missing_patterns": patterns
        }
    except subprocess.CalledProcessError as e:
        error_msg = f"Docker command failed: {e.stderr}"
        if auto_assert:
            await assert_condition(
                condition=False,
                message=f"Docker logs error: {error_msg}",
                severity="critical"
            )
        return {
            "found": False,
            "error": error_msg,
            "matches": [],
            "missing_patterns": patterns
        }
    except Exception as e:
        error_msg = str(e)
        if auto_assert:
            await assert_condition(
                condition=False,
                message=f"Docker logs error: {error_msg}",
                severity="critical"
            )
        return {
            "found": False,
            "error": error_msg,
            "matches": [],
            "missing_patterns": patterns
        }


async def get_log_snippet(
    container: str = "portico-open-webui",
    since: str = "5m",
    grep_pattern: Optional[str] = None,
    tail: int = 100
) -> Dict[str, Any]:
    """
    Get a snippet of Docker logs, optionally filtered.

    Args:
        container: Container name
        since: Time filter
        grep_pattern: Optional pattern to filter logs
        tail: Number of lines to return

    Returns:
        Dict with logs and metadata
    """
    try:
        cmd = ["docker", "logs", "--since", since, "--tail", str(tail), container]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)

        logs = result.stdout + "\n" + result.stderr
        lines = logs.split("\n")

        if grep_pattern:
            regex = re.compile(grep_pattern, re.IGNORECASE)
            lines = [line for line in lines if regex.search(line)]

        return {
            "success": True,
            "lines": lines[:tail],
            "total_lines": len(lines),
            "container": container
        }

    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "lines": []
        }


# Tool definition for Atlas Agent SDK
CHECK_DOCKER_LOGS_TOOL = {
    "name": "check_docker_logs",
    "description": "Search Docker container logs for specific patterns. Returns matching lines and verifies expected log entries exist.",
    "input_schema": {
        "type": "object",
        "properties": {
            "patterns": {
                "type": "array",
                "items": {"type": "string"},
                "description": "List of regex patterns to search for in the logs"
            },
            "container": {
                "type": "string",
                "description": "Container name to check (default: portico-open-webui)",
                "default": "portico-open-webui"
            },
            "since": {
                "type": "string",
                "description": "Time filter for logs (e.g., '5m', '1h')",
                "default": "5m"
            },
            "expect_all": {
                "type": "boolean",
                "description": "Whether all patterns must be found (default: true)",
                "default": True
            },
            "check_order": {
                "type": "boolean",
                "description": "Verify patterns appear in the specified order (default: false)",
                "default": False
            }
        },
        "required": ["patterns"]
    }
}
