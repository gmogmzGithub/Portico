"""Shared AST-extraction harness for middleware replay-path unit tests.

The OWUI middleware patch (src/patches/backend/open_webui/utils/middleware.py)
defines the transcript replay machinery partly at module level and partly as
functions nested inside ``process_chat_response``. Importing the module wholesale
would drag in the entire OWUI runtime, so — following the established pattern in
tests/test_incomplete_tool_call_guard.py — we parse the source with ``ast``,
extract the real function definitions by name (including nested ones), and exec
them into a namespace seeded with their runtime dependencies.

Tests built on this harness exercise REAL middleware behavior. They never assert
on source text (see AGENTS.md "Source-Pin Assertions Are BANNED").

Fixtures from the real incident (chat c0127a20, 2026-08-06) live in
tests/fixtures/steer-seam-c0127a20/.
"""

from __future__ import annotations

import ast
import copy
import html
import json
import os
import re
import sys
import time
import unittest
from pathlib import Path
from typing import Any, Optional

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "src/patches/backend"))

from open_webui.utils.tool_call_streaming import (  # noqa: E402
    get_tool_call_summary_label,
)

MIDDLEWARE_PATH = REPO_ROOT / "src/patches/backend/open_webui/utils/middleware.py"
PENDING_CHAT_WORK_PATH = (
    REPO_ROOT / "src/patches/backend/open_webui/utils/pending_chat_work.py"
)
FIXTURES_DIR = REPO_ROOT / "tests/fixtures/steer-seam-c0127a20"


class _FakeLog:
    def debug(self, *args, **kwargs):
        return None

    def info(self, *args, **kwargs):
        return None

    def warning(self, *args, **kwargs):
        return None

    def error(self, *args, **kwargs):
        return None


# Top-level middleware defs the replay tests need, extracted verbatim.
_MIDDLEWARE_TOP_LEVEL_DEFS = {
    "_safe_json_loads",
    "_resolve_reasoning_tags",
    "_split_inline_reasoning_sections",
    "_remove_complete_inline_reasoning_sections",
    "_strip_legacy_tool_followup_system_message",
    "_strip_replayed_model_system_prompt",
    "_ensure_internal_request_system_prompt_placeholder",
    "normalize_tool_results",
    "_serialize_replay_text_blocks",
    "_partition_tool_call_block_for_replay",
    "_tool_name_for_call_id",
    "_tool_result_content_for_model_replay",
    "_render_tool_result_for_overflow",
    "_compact_tool_result_for_internal_replay",
    "_tool_result_overflow_max_chars",
    "_tool_result_overflow_enabled",
    "_tool_result_overflow_exempt_for_metadata",
}

# Post-fix helpers (Defect B / guards). Extracted when present so the same
# tests flip red -> green as the fixes land; absent on unfixed builds.
_OPTIONAL_TOP_LEVEL_DEFS = {
    "build_followup_replay_messages",
    "fold_promoted_seam_into_replay",
    "verify_followup_history_fidelity",
    "collect_followup_user_message_anchors",
    "_tool_result_overflow_exempt_servers",
}

# Module-level constant assignments to carry over verbatim.
_MIDDLEWARE_CONSTANTS = {
    "CANONICAL_REASONING_START_TAG",
    "CANONICAL_REASONING_END_TAG",
    "DEFAULT_REASONING_TAGS",
    "_LEGACY_TOOL_FOLLOWUP_CONTINUATION_SYSTEM_MESSAGE",
}

# Functions nested inside process_chat_response.
_NESTED_DEFS = {
    "resolve_tool_display_name",
    "is_scheduled_finalizer_tool_name",
    "serialize_content_blocks",
    "convert_content_blocks_to_messages",
}

_PENDING_CHAT_WORK_DEFS = {
    "split_message_files",
    "pending_work_item_to_request_message",
    "inject_pending_steer_into_followup_messages",
    "inject_pending_steer_into_continue_messages",
    "append_user_steer_content_block",
}


def _collect_defs(tree: ast.Module, wanted: set[str]) -> list[ast.stmt]:
    return [
        node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name in wanted
    ]


def _collect_constants(tree: ast.Module, wanted: set[str]) -> list[ast.stmt]:
    selected = []
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id in wanted:
                    selected.append(node)
                    break
    return selected


def _collect_nested_defs(tree: ast.Module, wanted: set[str]) -> list[ast.stmt]:
    """Extract function defs nested (at any depth) inside process_chat_response."""
    for node in tree.body:
        if (
            isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and node.name == "process_chat_response"
        ):
            found = {}
            for inner in ast.walk(node):
                if (
                    isinstance(inner, (ast.FunctionDef, ast.AsyncFunctionDef))
                    and inner.name in wanted
                    and inner.name not in found
                ):
                    found[inner.name] = inner
            return list(found.values())
    return []


def _exec_defs(
    nodes: list[ast.stmt], namespace: dict, filename: str
) -> None:
    module = ast.Module(
        body=[
            ast.ImportFrom(
                module="__future__",
                names=[ast.alias(name="annotations")],
                level=0,
            ),
            *[copy.deepcopy(node) for node in nodes],
        ],
        type_ignores=[],
    )
    ast.fix_missing_locations(module)
    exec(compile(module, filename, "exec"), namespace)


def load_replay_namespace() -> dict:
    """Load the real replay functions into a self-contained namespace.

    Stubs are limited to dependencies that are pass-throughs for the block
    shapes these tests use (no attached files, no code_interpreter blocks):
      - _enrich_tool_result_for_inline_image_files / _render_tool_result_enrichment
        (image-file inlining; identity for file-less results)
      - _display_files_tool_result_files_for_serialization (display-file lists)
      - split_content_and_whitespace / is_opening_code_block (code_interpreter
        serialization only)
    Everything else is the genuine middleware implementation.
    """
    source = MIDDLEWARE_PATH.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(MIDDLEWARE_PATH))

    namespace: dict = {
        "Any": Any,
        "Optional": Optional,
        "Path": Path,
        "copy": copy,
        "hashlib": __import__("hashlib"),
        "html": html,
        "json": json,
        "log": _FakeLog(),
        "metadata": {},
        "os": os,
        "re": re,
        "time": time,
        "get_tool_call_summary_label": get_tool_call_summary_label,
        # Pass-through stubs (see docstring).
        "_enrich_tool_result_for_inline_image_files": (
            lambda content, files, **kwargs: content
        ),
        "_render_tool_result_enrichment": (
            lambda enriched: enriched if isinstance(enriched, str) else json.dumps(enriched)
        ),
        "_display_files_tool_result_files_for_serialization": (
            lambda **kwargs: kwargs.get("fallback_files")
        ),
        "split_content_and_whitespace": (
            lambda content: (content.rstrip(), content[len(content.rstrip()):])
        ),
        "is_opening_code_block": (lambda content: False),
    }

    _exec_defs(
        _collect_constants(tree, _MIDDLEWARE_CONSTANTS),
        namespace,
        str(MIDDLEWARE_PATH),
    )
    _exec_defs(
        _collect_defs(tree, _MIDDLEWARE_TOP_LEVEL_DEFS),
        namespace,
        str(MIDDLEWARE_PATH),
    )
    _exec_defs(
        _collect_defs(tree, _OPTIONAL_TOP_LEVEL_DEFS),
        namespace,
        str(MIDDLEWARE_PATH),
    )
    _exec_defs(
        _collect_nested_defs(tree, _NESTED_DEFS),
        namespace,
        str(MIDDLEWARE_PATH),
    )

    pending_source = PENDING_CHAT_WORK_PATH.read_text(encoding="utf-8")
    pending_tree = ast.parse(pending_source, filename=str(PENDING_CHAT_WORK_PATH))
    _exec_defs(
        _collect_defs(pending_tree, _PENDING_CHAT_WORK_DEFS),
        namespace,
        str(PENDING_CHAT_WORK_PATH),
    )

    missing = (
        (_MIDDLEWARE_TOP_LEVEL_DEFS | _NESTED_DEFS | _PENDING_CHAT_WORK_DEFS)
        - set(namespace)
    )
    if missing:
        raise AssertionError(
            f"middleware extraction failed; missing defs: {sorted(missing)}"
        )
    return namespace


def load_incident_fixture(name: str) -> dict:
    path = FIXTURES_DIR / f"{name}.json"
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def known_red(defect: str):
    """Mark a test as a known-red reproduction of an unfixed defect.

    Default (CI): wraps in unittest.expectedFailure so the suite stays green
    while the defect is unfixed, and turns into an *unexpected success*
    (= suite failure) the moment the fix lands — forcing the fix MR to remove
    the marker.

    portico_REPRO_STRICT=1 (used by `make chat-repro-report`): no wrapping, so the
    reproduction fails loudly and the failure output becomes the dated
    "problem proven" artifact.
    """

    def decorator(fn):
        fn.__portico_defect__ = defect
        if os.getenv("portico_REPRO_STRICT", "").strip() in {"1", "true", "yes"}:
            return fn
        return unittest.expectedFailure(fn)

    return decorator


def user_message_shas(messages: list[dict]) -> list[str]:
    import hashlib

    shas = []
    for m in messages:
        if not isinstance(m, dict) or m.get("role") != "user":
            continue
        content = m.get("content")
        text = content if isinstance(content, str) else json.dumps(content)
        shas.append(hashlib.sha256((text or "").encode()).hexdigest())
    return shas
