"""Vanished workspace images must degrade to a text notice, never a 400.

Incident (2026-08-07, reviewer workflow chat 6a4bf937): the orchestrator's
round-1 cross-chat message attached workspace renders as user-message files;
round 2 replaced the files with fresh names. Every subsequent turn of the
reviewer chat reconstructed the dead `image_url` from persisted history, and
``convert_url_images_to_base64`` raised HTTPException(400) at dispatch —
before the model ever ran — permanently wedging the chat.

Contract: a workspace image that can no longer be fetched is replaced by a
text notice telling the model to re-request current files; non-workspace URL
failures keep today's pass-through behavior; healthy conversions unchanged.
"""

from __future__ import annotations

import ast
import asyncio
import base64
import re
import sys
import unittest
from pathlib import Path
from typing import Any, Optional

REPO_ROOT = Path(__file__).resolve().parents[1]
MIDDLEWARE_PATH = REPO_ROOT / "src/patches/backend/open_webui/utils/middleware.py"


class _FakeLog:
    def debug(self, *args, **kwargs):
        return None

    def info(self, *args, **kwargs):
        return None

    def warning(self, *args, **kwargs):
        return None


class _FakeHTTPException(Exception):
    def __init__(self, status_code=400, detail=""):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def _load_namespace(fetcher):
    source = MIDDLEWARE_PATH.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(MIDDLEWARE_PATH))
    wanted = {
        "_is_workspace_image_url",
        "_workspace_image_conversion_error",
        "_sniff_image_media_type",
        "_decode_base64_image_data",
        "_normalize_image_data_url_mime",
        "convert_url_images_to_base64",
    }
    nodes = [
        n
        for n in tree.body
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in wanted
    ]
    module = ast.Module(
        body=[
            ast.ImportFrom(
                module="__future__", names=[ast.alias(name="annotations")], level=0
            ),
            *nodes,
        ],
        type_ignores=[],
    )
    ast.fix_missing_locations(module)
    ns = {
        "Any": Any,
        "Optional": Optional,
        "asyncio": asyncio,
        "base64": base64,
        "re": re,
        "log": _FakeLog(),
        "HTTPException": _FakeHTTPException,
        "get_image_base64_from_url": fetcher,
    }
    exec(compile(module, str(MIDDLEWARE_PATH), "exec"), ns)
    return ns


WORKSPACE_URL = (
    "http://host.docker.internal:9876/workspace/abc-123/slide-1.jpg"
)
PUBLIC_URL = "https://example.com/image.jpg"
# 1x1 JPEG-ish payload with a valid JPEG magic prefix for the sniffer.
GOOD_DATA_URL = "data:image/jpeg;base64," + base64.b64encode(
    b"\xff\xd8\xff" + b"\x00" * 16
).decode()


def form(url):
    return {
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "review these"},
                    {"type": "image_url", "image_url": {"url": url}},
                ],
            }
        ]
    }


class WorkspaceImageDegradeTests(unittest.TestCase):
    def run_convert(self, fetcher, url):
        ns = _load_namespace(fetcher)
        return asyncio.run(ns["convert_url_images_to_base64"](form(url)))

    def test_vanished_workspace_image_becomes_text_notice(self):
        def dead_fetch(url):
            raise ValueError("HTTP 404")

        out = self.run_convert(dead_fetch, WORKSPACE_URL)
        content = out["messages"][0]["content"]
        kinds = [b.get("type") for b in content]
        self.assertNotIn("image_url", kinds, "dead workspace image must not ride")
        notice = next(b for b in content if b["type"] == "text" and "slide-1.jpg" in b["text"])
        self.assertIn("no longer available", notice["text"])
        self.assertIn("agent_vm_request_images", notice["text"])

    def test_vanished_workspace_image_never_raises(self):
        def dead_fetch(url):
            raise ValueError("HTTP 404")

        try:
            self.run_convert(dead_fetch, WORKSPACE_URL)
        except Exception as e:  # pragma: no cover
            self.fail(f"conversion failure aborted the turn: {e}")

    def test_public_url_failure_keeps_passthrough(self):
        def dead_fetch(url):
            raise ValueError("HTTP 404")

        out = self.run_convert(dead_fetch, PUBLIC_URL)
        content = out["messages"][0]["content"]
        self.assertEqual(content[1]["type"], "image_url")
        self.assertEqual(content[1]["image_url"]["url"], PUBLIC_URL)

    def test_healthy_workspace_image_converts_to_base64(self):
        def good_fetch(url):
            return GOOD_DATA_URL

        out = self.run_convert(good_fetch, WORKSPACE_URL)
        content = out["messages"][0]["content"]
        self.assertEqual(content[1]["type"], "image_url")
        self.assertTrue(content[1]["image_url"]["url"].startswith("data:image/jpeg;base64,"))


if __name__ == "__main__":
    unittest.main()
