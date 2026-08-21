#!/usr/bin/env python3
"""Regression coverage for active GPT model guidance."""

from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class ActiveGptModelGuidanceTests(unittest.TestCase):
    def test_subagent_guidance_uses_current_display_names(self) -> None:
        prompt = (ROOT / "agents/base_system_prompt.md").read_text()
        tool_spec = (
            ROOT / "src/core-mcp-rust/crates/subagents-server/tool_spec.json"
        ).read_text()
        tool_viewer = (
            ROOT
            / "llm-debug-monitor/src/components/RequestInspector/ToolCallViewer.tsx"
        ).read_text()

        for display_name in (
            "GPT-5.6 Sol",
            "GPT-5.6 Sol Pro",
            "GPT-5.6 Terra",
            "GPT-5.6 Luna",
            "GPT-5.5",
        ):
            self.assertIn(display_name, prompt)

        for retired_name in (
            "GPT-5.4",
            "GPT-4.1",
        ):
            self.assertNotIn(retired_name, prompt)
            self.assertNotIn(retired_name, tool_spec)
            self.assertNotIn(retired_name, tool_viewer)

        self.assertIn("GPT-5.6 Sol", tool_spec)
        self.assertIn("OpenAI Responses API", tool_viewer)

if __name__ == "__main__":
    unittest.main()
