#!/usr/bin/env python3
"""
Run a live headless Open WebUI reasoning regression against Claude Opus 4.8.

This uses the same live chat/debug-monitor flow as the Opus 5 reasoning
runner, but fails if the saved assistant reasoning block or debug-monitor
thinking text contains duplicated streamed reasoning chunks.
"""

from __future__ import annotations

from run_opus_5_reasoning_chat_consistency import main


if __name__ == "__main__":
    raise SystemExit(
        main(
            default_model="Claude Opus 4.8",
            default_require_clean_reasoning_stream=True,
            default_require_debug_monitor_details=False,
        )
    )
