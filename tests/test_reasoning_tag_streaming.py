from pathlib import Path
import ast
import time


REPO_ROOT = Path(__file__).resolve().parents[1]
MIDDLEWARE_PATH = (
    REPO_ROOT / "src/patches/backend/open_webui/utils/middleware.py"
)


def _load_reasoning_tag_helpers():
    source = MIDDLEWARE_PATH.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(MIDDLEWARE_PATH))
    wanted_names = {
        "_resolve_reasoning_tags",
        "_should_detect_inline_reasoning_tags",
        "_split_inline_reasoning_sections",
        "_extract_pending_reasoning_start_tag_prefix",
        "_extract_pending_reasoning_end_tag_suffix",
        "_text_tail_at_line_boundary",
        "_remove_complete_inline_reasoning_sections",
        "_append_reasoning_text_to_content_blocks",
    }
    selected_nodes = [
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name in wanted_names
    ]

    namespace = {
        "DEFAULT_REASONING_TAGS": [
            ("<think>", "</think>"),
            ("<thinking>", "</thinking>"),
            ("<reason>", "</reason>"),
            ("<reasoning>", "</reasoning>"),
            ("<thought>", "</thought>"),
            ("<Thought>", "</Thought>"),
            ("<|begin_of_thought|>", "<|end_of_thought|>"),
            ("◁think▷", "◁/think▷"),
        ],
        "CANONICAL_REASONING_START_TAG": "<think>",
        "CANONICAL_REASONING_END_TAG": "</think>",
        "time": time,
    }
    exec(
        compile(ast.Module(body=selected_nodes, type_ignores=[]), str(MIDDLEWARE_PATH), "exec"),
        namespace,
    )
    return namespace


HELPERS = _load_reasoning_tag_helpers()
_split_inline_reasoning_sections = HELPERS["_split_inline_reasoning_sections"]
_should_detect_inline_reasoning_tags = HELPERS["_should_detect_inline_reasoning_tags"]
_extract_pending_reasoning_start_tag_prefix = HELPERS[
    "_extract_pending_reasoning_start_tag_prefix"
]
_extract_pending_reasoning_end_tag_suffix = HELPERS[
    "_extract_pending_reasoning_end_tag_suffix"
]
_text_tail_at_line_boundary = HELPERS["_text_tail_at_line_boundary"]
_remove_complete_inline_reasoning_sections = HELPERS[
    "_remove_complete_inline_reasoning_sections"
]
_append_reasoning_text_to_content_blocks = HELPERS[
    "_append_reasoning_text_to_content_blocks"
]
DEFAULT_REASONING_TAGS = HELPERS["DEFAULT_REASONING_TAGS"]

DEFAULT_MODE_SPLIT_KWARGS = dict(
    reasoning_tags=DEFAULT_REASONING_TAGS,
    allow_unmatched_start=False,
    require_line_start=True,
    allow_unmatched_start_at_line_start=True,
)


def test_default_reasoning_tag_config_does_not_enable_unmatched_stream_parsing():
    assert _should_detect_inline_reasoning_tags(None) is False
    assert _should_detect_inline_reasoning_tags(False) is False
    assert _should_detect_inline_reasoning_tags(DEFAULT_REASONING_TAGS) is False
    assert _should_detect_inline_reasoning_tags(["<think>", "</think>"]) is True


def test_split_inline_reasoning_sections_preserves_unmatched_literal_start_tag():
    (
        cleaned,
        reasoning,
        changed,
        opened,
        closed,
        active,
        end_tag,
    ) = _split_inline_reasoning_sections(
        "Visible answer mentions <thinking> as literal text.",
        inline_reasoning_active=False,
        inline_reasoning_end_tag=None,
        reasoning_tags=DEFAULT_REASONING_TAGS,
    )

    assert cleaned == "Visible answer mentions <thinking> as literal text."
    assert reasoning == ""
    assert changed is False
    assert opened is False
    assert closed is False
    assert active is False
    assert end_tag is None


def test_split_inline_reasoning_sections_extracts_complete_line_start_pair_before_visible_text():
    (
        cleaned,
        reasoning,
        changed,
        opened,
        closed,
        active,
        end_tag,
    ) = _split_inline_reasoning_sections(
        '<think>Inspect one more result.</think>Continue with the visible answer.',
        inline_reasoning_active=False,
        inline_reasoning_end_tag=None,
        reasoning_tags=DEFAULT_REASONING_TAGS,
        require_line_start=True,
    )

    assert cleaned == "Continue with the visible answer."
    assert reasoning == "Inspect one more result."
    assert changed is True
    assert opened is True
    assert closed is True
    assert active is False
    assert end_tag is None


def test_split_inline_reasoning_sections_preserves_complete_mid_sentence_literal():
    content = "The literal <thinking>example</thinking> should stay visible."

    (
        cleaned,
        reasoning,
        changed,
        opened,
        closed,
        active,
        end_tag,
    ) = _split_inline_reasoning_sections(
        content,
        inline_reasoning_active=False,
        inline_reasoning_end_tag=None,
        reasoning_tags=DEFAULT_REASONING_TAGS,
        require_line_start=True,
    )

    assert cleaned == content
    assert reasoning == ""
    assert changed is False
    assert opened is False
    assert closed is False
    assert active is False
    assert end_tag is None


def test_split_inline_reasoning_sections_preserves_unmatched_line_start_literal():
    content = "<thinking>This is an unmatched literal example."

    (
        cleaned,
        reasoning,
        changed,
        opened,
        closed,
        active,
        end_tag,
    ) = _split_inline_reasoning_sections(
        content,
        inline_reasoning_active=False,
        inline_reasoning_end_tag=None,
        reasoning_tags=DEFAULT_REASONING_TAGS,
        require_line_start=True,
    )

    assert cleaned == content
    assert reasoning == ""
    assert changed is False
    assert opened is False
    assert closed is False
    assert active is False
    assert end_tag is None


def test_split_inline_reasoning_sections_tracks_thinking_tags_across_chunks():
    (
        cleaned,
        reasoning,
        changed,
        opened,
        closed,
        active,
        end_tag,
    ) = _split_inline_reasoning_sections(
        "<thinking>First chunk",
        inline_reasoning_active=False,
        inline_reasoning_end_tag=None,
        reasoning_tags=DEFAULT_REASONING_TAGS,
        allow_unmatched_start=True,
    )

    assert cleaned == ""
    assert reasoning == "First chunk"
    assert changed is True
    assert opened is True
    assert closed is False
    assert active is True
    assert end_tag == "</thinking>"

    (
        cleaned,
        reasoning,
        changed,
        opened,
        closed,
        active,
        end_tag,
    ) = _split_inline_reasoning_sections(
        " and second chunk</thinking> Visible answer",
        inline_reasoning_active=active,
        inline_reasoning_end_tag=end_tag,
        reasoning_tags=DEFAULT_REASONING_TAGS,
    )

    assert cleaned == " Visible answer"
    assert reasoning == " and second chunk"
    assert changed is True
    assert opened is False
    assert closed is True
    assert active is False
    assert end_tag is None


def test_split_inline_reasoning_sections_handles_complete_inline_thinking_pair():
    (
        cleaned,
        reasoning,
        changed,
        opened,
        closed,
        active,
        end_tag,
    ) = _split_inline_reasoning_sections(
        "Before <thinking>plan</thinking> after",
        inline_reasoning_active=False,
        inline_reasoning_end_tag=None,
        reasoning_tags=DEFAULT_REASONING_TAGS,
    )

    assert cleaned == "Before  after"
    assert reasoning == "plan"
    assert changed is True
    assert opened is True
    assert closed is True
    assert active is False
    assert end_tag is None


def test_extract_pending_reasoning_start_tag_prefix_buffers_partial_marker():
    cleaned, prefix = _extract_pending_reasoning_start_tag_prefix(
        "Visible text<think",
        reasoning_tags=DEFAULT_REASONING_TAGS,
        inline_reasoning_active=False,
    )

    assert cleaned == "Visible text"
    assert prefix == "<think"


def test_default_mode_opens_cross_delta_reasoning_for_line_start_think_tag():
    cleaned, reasoning, changed, opened, closed, active, end_tag = (
        _split_inline_reasoning_sections(
            "<think>\nThe user wants",
            inline_reasoning_active=False,
            inline_reasoning_end_tag=None,
            delta_at_line_start=True,
            **DEFAULT_MODE_SPLIT_KWARGS,
        )
    )
    assert cleaned == ""
    assert reasoning == "\nThe user wants"
    assert (changed, opened, closed, active) == (True, True, False, True)
    assert end_tag == "</think>"

    cleaned, reasoning, changed, opened, closed, active, end_tag = (
        _split_inline_reasoning_sections(
            " a list of skills.",
            inline_reasoning_active=active,
            inline_reasoning_end_tag=end_tag,
            delta_at_line_start=False,
            **DEFAULT_MODE_SPLIT_KWARGS,
        )
    )
    assert cleaned == ""
    assert reasoning == " a list of skills."
    assert (changed, opened, closed, active) == (True, False, False, True)

    cleaned, reasoning, changed, opened, closed, active, end_tag = (
        _split_inline_reasoning_sections(
            " Done.</think>The answer.",
            inline_reasoning_active=active,
            inline_reasoning_end_tag=end_tag,
            delta_at_line_start=False,
            **DEFAULT_MODE_SPLIT_KWARGS,
        )
    )
    assert cleaned == "The answer."
    assert reasoning == " Done."
    assert (changed, opened, closed, active) == (True, False, True, False)
    assert end_tag is None


def test_default_mode_keeps_unanchored_delta_start_think_tag_visible():
    # The tag sits at index 0 of the delta, but the visible stream is
    # mid-line — this is an inline literal, not transport markup.
    content = "<think>now consider this"
    cleaned, reasoning, changed, opened, closed, active, end_tag = (
        _split_inline_reasoning_sections(
            content,
            inline_reasoning_active=False,
            inline_reasoning_end_tag=None,
            delta_at_line_start=False,
            **DEFAULT_MODE_SPLIT_KWARGS,
        )
    )
    assert cleaned == content
    assert reasoning == ""
    assert (changed, opened, closed, active) == (False, False, False, False)
    assert end_tag is None


def test_default_mode_opens_cross_delta_capture_at_line_start_inside_delta():
    cleaned, reasoning, changed, opened, closed, active, end_tag = (
        _split_inline_reasoning_sections(
            "The answer starts.\n<think>and reasoning follows",
            inline_reasoning_active=False,
            inline_reasoning_end_tag=None,
            delta_at_line_start=False,
            **DEFAULT_MODE_SPLIT_KWARGS,
        )
    )
    assert cleaned == "The answer starts.\n"
    assert reasoning == "and reasoning follows"
    assert (changed, opened, closed, active) == (True, True, False, True)
    assert end_tag == "</think>"


def test_default_mode_does_not_reopen_capture_right_after_a_close_tag():
    # After "</think>" the stream is mid-line, so a second "<think>" that
    # immediately follows is not anchored at a line start.
    cleaned, reasoning, changed, opened, closed, active, end_tag = (
        _split_inline_reasoning_sections(
            "<think>plan</think><think>again",
            inline_reasoning_active=False,
            inline_reasoning_end_tag=None,
            delta_at_line_start=True,
            **DEFAULT_MODE_SPLIT_KWARGS,
        )
    )
    assert cleaned == "<think>again"
    assert reasoning == "plan"
    assert (changed, opened, closed, active) == (True, True, True, False)
    assert end_tag is None


def test_pending_start_tag_prefix_requires_line_start_in_default_mode():
    # Mid-line partial start tag: stays visible in default mode.
    cleaned, prefix = _extract_pending_reasoning_start_tag_prefix(
        "uses <thi",
        reasoning_tags=DEFAULT_REASONING_TAGS,
        inline_reasoning_active=False,
        require_line_start=True,
        at_line_start=True,
    )
    assert (cleaned, prefix) == ("uses <thi", "")

    # Line-start-anchored partial start tag: buffered.
    cleaned, prefix = _extract_pending_reasoning_start_tag_prefix(
        "First line.\n<thi",
        reasoning_tags=DEFAULT_REASONING_TAGS,
        inline_reasoning_active=False,
        require_line_start=True,
        at_line_start=False,
    )
    assert (cleaned, prefix) == ("First line.\n", "<thi")

    # Whole-delta prefix: anchoring is decided by the stream boundary.
    cleaned, prefix = _extract_pending_reasoning_start_tag_prefix(
        "<thi",
        reasoning_tags=DEFAULT_REASONING_TAGS,
        inline_reasoning_active=False,
        require_line_start=True,
        at_line_start=True,
    )
    assert (cleaned, prefix) == ("", "<thi")

    cleaned, prefix = _extract_pending_reasoning_start_tag_prefix(
        "<thi",
        reasoning_tags=DEFAULT_REASONING_TAGS,
        inline_reasoning_active=False,
        require_line_start=True,
        at_line_start=False,
    )
    assert (cleaned, prefix) == ("<thi", "")


def test_pending_end_tag_suffix_buffers_partial_close_tag():
    cleaned, suffix = _extract_pending_reasoning_end_tag_suffix(
        "thought tail</thi",
        inline_reasoning_end_tag="</think>",
    )
    assert (cleaned, suffix) == ("thought tail", "</thi")

    # A complete close tag is the splitter's job — nothing to peel.
    cleaned, suffix = _extract_pending_reasoning_end_tag_suffix(
        "done</think>after",
        inline_reasoning_end_tag="</think>",
    )
    assert (cleaned, suffix) == ("done</think>after", "")

    # Without an active capture the default tag set is scanned.
    cleaned, suffix = _extract_pending_reasoning_end_tag_suffix(
        "text ends with <",
        reasoning_tags=DEFAULT_REASONING_TAGS,
    )
    assert (cleaned, suffix) == ("text ends with ", "<")

    cleaned, suffix = _extract_pending_reasoning_end_tag_suffix(
        "no markers here",
        reasoning_tags=DEFAULT_REASONING_TAGS,
    )
    assert (cleaned, suffix) == ("no markers here", "")


def test_text_tail_at_line_boundary_tracks_visible_stream_position():
    assert _text_tail_at_line_boundary([]) is True
    assert _text_tail_at_line_boundary([{"type": "text", "content": ""}]) is True
    assert _text_tail_at_line_boundary([{"type": "text", "content": "abc"}]) is False
    assert _text_tail_at_line_boundary([{"type": "text", "content": "abc\n"}]) is True
    assert (
        _text_tail_at_line_boundary(
            [{"type": "reasoning", "content": "thinking"}]
        )
        is True
    )


def test_remove_complete_inline_reasoning_sections_scrubs_line_start_pairs_only():
    assert (
        _remove_complete_inline_reasoning_sections("<think>leak</think>Answer.")
        == "Answer."
    )
    assert (
        _remove_complete_inline_reasoning_sections(
            "Intro.\n<think>leak</think>\nMore."
        )
        == "Intro.\n\nMore."
    )
    # Unterminated and mid-line sections stay untouched.
    assert (
        _remove_complete_inline_reasoning_sections("<think>leak only")
        == "<think>leak only"
    )
    assert (
        _remove_complete_inline_reasoning_sections("uses <think>x</think> inline")
        == "uses <think>x</think> inline"
    )
    assert _remove_complete_inline_reasoning_sections("plain text") == "plain text"
    assert _remove_complete_inline_reasoning_sections("") == ""


def test_gemini_multi_delta_thought_leak_regression():
    # Reproduces chat aa88bd8e-0ab8-45d2-9404-e90620836b09: a native
    # reasoning_content block is still open when the model also streams a
    # literal <think> section split across text deltas, followed by the
    # visible answer. The whole think section must land in the reasoning
    # block; no text block may retain a "<think" marker.
    content_blocks = [
        {"type": "text", "content": ""},
        {
            "type": "reasoning",
            "start_tag": "<think>",
            "end_tag": "</think>",
            "attributes": {"type": "reasoning_content"},
            "content": "Native summary.",
            "started_at": 1000.0,
        },
    ]

    deltas = [
        "<think>**Analyzing Skill",
        " Dependencies**\n\nChecking usage.",
        "</think>A skill cannot be unpublished.",
    ]

    inline_active = False
    inline_end_tag = None
    for delta in deltas:
        cleaned, reasoning, _changed, _opened, _closed, inline_active, inline_end_tag = (
            _split_inline_reasoning_sections(
                delta,
                inline_reasoning_active=inline_active,
                inline_reasoning_end_tag=inline_end_tag,
                delta_at_line_start=_text_tail_at_line_boundary(content_blocks),
                **DEFAULT_MODE_SPLIT_KWARGS,
            )
        )
        if reasoning:
            _append_reasoning_text_to_content_blocks(content_blocks, reasoning)
        if cleaned:
            if not content_blocks or content_blocks[-1].get("type") != "text":
                content_blocks.append({"type": "text", "content": ""})
            content_blocks[-1]["content"] += cleaned

    assert inline_active is False
    assert inline_end_tag is None

    reasoning_blocks = [
        block for block in content_blocks if block.get("type") == "reasoning"
    ]
    assert len(reasoning_blocks) == 1
    assert reasoning_blocks[0]["content"] == (
        "Native summary.**Analyzing Skill Dependencies**\n\nChecking usage."
    )

    text_blocks = [
        block for block in content_blocks if block.get("type") == "text"
    ]
    assert all("<think" not in block["content"] for block in text_blocks)
    assert text_blocks[-1]["content"] == "A skill cannot be unpublished."


def test_gemini_thought_leak_regression_without_a_closing_tag():
    # Stream ends while the literal think section is still open: everything
    # captured so far stays in the reasoning block and capture stays active
    # for the terminal freeze to close.
    content_blocks = []
    inline_active = False
    inline_end_tag = None
    for delta in ["<think>reasoning without", " a close tag"]:
        cleaned, reasoning, _changed, _opened, _closed, inline_active, inline_end_tag = (
            _split_inline_reasoning_sections(
                delta,
                inline_reasoning_active=inline_active,
                inline_reasoning_end_tag=inline_end_tag,
                delta_at_line_start=_text_tail_at_line_boundary(content_blocks),
                **DEFAULT_MODE_SPLIT_KWARGS,
            )
        )
        assert cleaned == ""
        if reasoning:
            _append_reasoning_text_to_content_blocks(content_blocks, reasoning)

    assert inline_active is True
    assert inline_end_tag == "</think>"
    assert len(content_blocks) == 1
    assert content_blocks[0]["type"] == "reasoning"
    assert content_blocks[0]["content"] == "reasoning without a close tag"
