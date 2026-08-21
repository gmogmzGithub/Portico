"""Reasoning replay policy contracts (A-U1 — permanent green, no-regression).

The Defect A fix (WS2) restores native thinking blocks at the BRIDGE, not here:
the Python layer keeps stripping reasoning from in-loop follow-up replay (the
bridge splices the signed blocks back at the Bedrock boundary), and cross-turn
replay keeps re-emitting persisted reasoning as canonical ``<think>`` text.
These tests pin that division of labor so WS1/WS2 changes cannot silently
regress it.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from helpers.middleware_replay_extract import load_replay_namespace  # noqa: E402

NS = load_replay_namespace()


class FollowupReasoningPolicyTests(unittest.TestCase):
    def test_followup_replay_strips_reasoning_blocks(self):
        blocks = [
            {"type": "reasoning", "content": "secret chain of thought", "duration": 3},
            {"type": "text", "content": "Visible answer."},
        ]
        messages = NS["convert_content_blocks_to_messages"](
            blocks, True, replay_mode="tool_followup"
        )
        text = "\n".join(
            m.get("content") or "" for m in messages if isinstance(m, dict)
        )
        self.assertNotIn("secret chain of thought", text)
        self.assertNotIn("<think>", text)
        self.assertIn("Visible answer.", text)

    def test_followup_replay_scrubs_leaked_literal_think_sections(self):
        blocks = [
            {
                "type": "text",
                "content": "<think>leaked literal reasoning</think>\nVisible answer.",
            },
        ]
        messages = NS["convert_content_blocks_to_messages"](
            blocks, True, replay_mode="tool_followup"
        )
        text = "\n".join(
            m.get("content") or "" for m in messages if isinstance(m, dict)
        )
        self.assertNotIn("leaked literal reasoning", text)
        self.assertIn("Visible answer.", text)


class CrossTurnReasoningPolicyTests(unittest.TestCase):
    def test_cross_turn_replay_wraps_reasoning_canonically(self):
        text = NS["_serialize_replay_text_blocks"](
            [
                {"type": "reasoning", "content": "genuine reasoning summary"},
                {"type": "text", "content": "Visible answer."},
            ]
        )
        self.assertIn("<think>genuine reasoning summary</think>", text)
        self.assertIn("Visible answer.", text)

    def test_cross_turn_replay_scrubs_leaked_literals_but_keeps_genuine(self):
        text = NS["_serialize_replay_text_blocks"](
            [
                {"type": "reasoning", "content": "genuine reasoning summary"},
                {
                    "type": "text",
                    "content": "<think>leaked imitation</think>\nVisible answer.",
                },
            ]
        )
        self.assertIn("<think>genuine reasoning summary</think>", text)
        self.assertNotIn("leaked imitation", text)
        self.assertIn("Visible answer.", text)


if __name__ == "__main__":
    unittest.main()
