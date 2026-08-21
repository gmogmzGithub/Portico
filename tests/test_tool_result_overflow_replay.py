"""Defect C reproduction — web-tools results truncated on every follow-up round.

On tool_followup / stream_continue / anomaly_retry replay, tool results larger
than OWUI_TOOL_RESULT_OVERFLOW_MAX_CHARS (default 4000) are compacted to a
``{"truncated_tool_result": true, ...}`` preview. The core-server exemption
explicitly excludes ``web-tools`` — so web-search results get chopped to a 4KB
preview on every round of an agentic loop, feeding "forgot I already searched"
behavior (observed in incident chat c0127a20).

Fix contract (WS3): ``OWUI_TOOL_RESULT_OVERFLOW_EXEMPT_SERVERS`` (csv, default
``web-tools``) exempts listed servers; unset-to-empty restores today's exact
behavior; the existing core-server exemption is otherwise unchanged.
"""

from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

from helpers.middleware_replay_extract import (  # noqa: E402
    load_replay_namespace,
)

NS = load_replay_namespace()

LARGE = "S" * 20_000


def followup_messages_for_result(result):
    blocks = [
        {
            "type": "tool_calls",
            "content": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "web_tools_web_search",
                        "arguments": json.dumps({"query": "q"}),
                    },
                }
            ],
            "results": [result],
        }
    ]
    return NS["convert_content_blocks_to_messages"](
        blocks, True, replay_mode="tool_followup"
    )


def tool_message_content(messages):
    for m in messages:
        if m.get("role") == "tool":
            return m.get("content") or ""
    raise AssertionError("no tool message produced")


class WebToolsOverflowExemptionTests(unittest.TestCase):
    def test_C_U1_web_tools_exempt_by_default(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("OWUI_TOOL_RESULT_OVERFLOW_EXEMPT_SERVERS", None)
            self.assertTrue(
                NS["_tool_result_overflow_exempt_for_metadata"](
                    {"server_id": "web-tools", "server_is_core": True}
                ),
                "web-tools must be exempt from follow-up truncation by default",
            )

    def test_C_U1b_large_web_tools_result_survives_followup_replay(self):
        result = {
            "tool_call_id": "call_1",
            "content": LARGE,
            "server_id": "web-tools",
            "server_is_core": True,
        }
        content = tool_message_content(followup_messages_for_result(result))
        self.assertNotIn("truncated_tool_result", content)
        self.assertGreaterEqual(len(content), len(LARGE))

    def test_C_U1c_env_listed_server_is_exempt(self):
        with mock.patch.dict(
            os.environ,
            {"OWUI_TOOL_RESULT_OVERFLOW_EXEMPT_SERVERS": "web-tools,special-server"},
        ):
            self.assertTrue(
                NS["_tool_result_overflow_exempt_for_metadata"](
                    {"server_id": "special-server", "server_is_core": False}
                ),
                "servers listed in OWUI_TOOL_RESULT_OVERFLOW_EXEMPT_SERVERS "
                "must be exempt",
            )


class OverflowRegressionGuards(unittest.TestCase):
    """Current, intended compaction behavior that must NOT regress."""

    def test_C_U2_non_core_server_still_truncates(self):
        result = {
            "tool_call_id": "call_1",
            "content": LARGE,
            "server_id": "random-server",
            "server_is_core": False,
        }
        content = tool_message_content(followup_messages_for_result(result))
        payload = json.loads(content)
        self.assertTrue(payload.get("truncated_tool_result"))
        self.assertEqual(payload.get("char_count"), len(LARGE))
        self.assertEqual(len(payload.get("preview") or ""), 4000)

    def test_C_U2b_core_non_web_tools_server_exempt(self):
        self.assertTrue(
            NS["_tool_result_overflow_exempt_for_metadata"](
                {"server_id": "agent-vm", "server_is_core": True}
            )
        )

    def test_C_U2c_small_results_never_compacted(self):
        result = {
            "tool_call_id": "call_1",
            "content": "small result",
            "server_id": "random-server",
            "server_is_core": False,
        }
        content = tool_message_content(followup_messages_for_result(result))
        self.assertEqual(content, "small result")


if __name__ == "__main__":
    unittest.main()
