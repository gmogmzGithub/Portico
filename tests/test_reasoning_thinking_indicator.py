from pathlib import Path
from typing import Any
import ast
import time


REPO_ROOT = Path(__file__).resolve().parents[1]
MIDDLEWARE_PATH = (
    REPO_ROOT / "src/patches/backend/open_webui/utils/middleware.py"
)


def _load_thinking_indicator_helpers():
    source = MIDDLEWARE_PATH.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(MIDDLEWARE_PATH))
    wanted_functions = {
        "_append_reasoning_text_to_content_blocks",
        "_is_empty_open_reasoning_block",
        "_finalize_or_prune_trailing_reasoning_block",
        "_strip_reasoning_delta_fields",
        "_freeze_content_blocks_for_terminal_state",
    }
    wanted_assigns = {"_REASONING_DELTA_KEYS"}
    selected_nodes = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in wanted_functions:
            selected_nodes.append(node)
        elif isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id in wanted_assigns
            for target in node.targets
        ):
            selected_nodes.append(node)

    namespace = {
        "CANONICAL_REASONING_START_TAG": "<think>",
        "CANONICAL_REASONING_END_TAG": "</think>",
        "time": time,
        "Any": Any,
        # Behavioral scope of this suite is the reasoning-block handling;
        # tool-call freezing is exercised by its own suites.
        "_freeze_tool_calls_block_for_terminal_state": (
            lambda block, **kwargs: block
        ),
    }
    exec(
        compile(
            ast.Module(body=selected_nodes, type_ignores=[]),
            str(MIDDLEWARE_PATH),
            "exec",
        ),
        namespace,
    )
    return namespace


HELPERS = _load_thinking_indicator_helpers()
_append_reasoning_text_to_content_blocks = HELPERS[
    "_append_reasoning_text_to_content_blocks"
]
_is_empty_open_reasoning_block = HELPERS["_is_empty_open_reasoning_block"]
_finalize_or_prune_trailing_reasoning_block = HELPERS[
    "_finalize_or_prune_trailing_reasoning_block"
]
_strip_reasoning_delta_fields = HELPERS["_strip_reasoning_delta_fields"]
_freeze_content_blocks_for_terminal_state = HELPERS[
    "_freeze_content_blocks_for_terminal_state"
]
_REASONING_DELTA_KEYS = HELPERS["_REASONING_DELTA_KEYS"]


def test_backdated_block_close_yields_real_thinking_duration():
    content_blocks = []
    thinking_seconds = 103.2
    backdated = time.time() - thinking_seconds
    _append_reasoning_text_to_content_blocks(content_blocks, "", now=backdated)
    _append_reasoning_text_to_content_blocks(content_blocks, "summary text")

    outcome = _finalize_or_prune_trailing_reasoning_block(content_blocks)

    assert outcome == "closed"
    block = content_blocks[-1]
    assert block["started_at"] == backdated
    assert block["ended_at"] is not None
    assert block["duration"] in (103, 104)


def test_close_uses_round_not_truncation():
    content_blocks = []
    _append_reasoning_text_to_content_blocks(
        content_blocks, "thought hard", now=time.time() - 1.8
    )

    outcome = _finalize_or_prune_trailing_reasoning_block(content_blocks)

    assert outcome == "closed"
    assert content_blocks[-1]["duration"] == 2


def test_empty_open_block_is_pruned_not_closed():
    content_blocks = [{"type": "text", "content": "before"}]
    _append_reasoning_text_to_content_blocks(
        content_blocks, "", now=time.time() - 5
    )
    assert content_blocks[-1]["type"] == "reasoning"

    outcome = _finalize_or_prune_trailing_reasoning_block(content_blocks)

    assert outcome == "pruned"
    assert content_blocks == [{"type": "text", "content": "before"}]
    assert not any(
        isinstance(block, dict) and "duration" in block
        for block in content_blocks
    )


def test_whitespace_only_reasoning_block_is_pruned():
    content_blocks = []
    _append_reasoning_text_to_content_blocks(content_blocks, "  \n\t ")

    assert _finalize_or_prune_trailing_reasoning_block(content_blocks) == "pruned"
    assert content_blocks == []


def test_finalize_ignores_non_reasoning_tail():
    content_blocks = [{"type": "text", "content": "hello"}]
    assert _finalize_or_prune_trailing_reasoning_block(content_blocks) == "none"
    assert _finalize_or_prune_trailing_reasoning_block([]) == "none"


def test_is_empty_open_reasoning_block_predicate():
    open_empty = []
    _append_reasoning_text_to_content_blocks(open_empty, "")
    assert _is_empty_open_reasoning_block(open_empty[-1]) is True

    with_content = []
    _append_reasoning_text_to_content_blocks(with_content, "actual thoughts")
    assert _is_empty_open_reasoning_block(with_content[-1]) is False

    closed_empty = []
    _append_reasoning_text_to_content_blocks(closed_empty, "")
    closed_empty[-1]["ended_at"] = time.time()
    assert _is_empty_open_reasoning_block(closed_empty[-1]) is False

    assert _is_empty_open_reasoning_block({"type": "text", "content": ""}) is False
    assert _is_empty_open_reasoning_block(None) is False


def test_strip_reasoning_delta_fields_covers_marker_keys():
    assert "reasoning_status" in _REASONING_DELTA_KEYS
    assert "reasoning_thinking_ms" in _REASONING_DELTA_KEYS

    marker_only_delta = {"reasoning_status": "started"}
    assert _strip_reasoning_delta_fields(marker_only_delta) is True
    assert marker_only_delta == {}

    timed_delta = {
        "reasoning_content": "hmm",
        "reasoning_thinking_ms": 4200,
        "content": "kept",
    }
    assert _strip_reasoning_delta_fields(timed_delta) is True
    assert timed_delta == {"content": "kept"}

    plain_delta = {"content": "no reasoning here"}
    assert _strip_reasoning_delta_fields(plain_delta) is False
    assert plain_delta == {"content": "no reasoning here"}


def test_terminal_freeze_prunes_empty_open_reasoning_blocks():
    content_blocks = []
    _append_reasoning_text_to_content_blocks(
        content_blocks, "real thoughts", now=time.time() - 30.4
    )
    content_blocks[0]["ended_at"] = None
    content_blocks.append({"type": "text", "content": "answer"})
    _append_reasoning_text_to_content_blocks(content_blocks, "")

    frozen = _freeze_content_blocks_for_terminal_state(
        content_blocks, stop_reason="stop"
    )

    assert [block["type"] for block in frozen] == ["reasoning", "text"]
    assert frozen[0]["duration"] == 30
    assert frozen[0]["stop_reason"] == "stop"
