from pathlib import Path
import ast
import asyncio
import base64
import copy
import json
import re
import time
from typing import Any, Optional

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
MIDDLEWARE_PATH = (
    REPO_ROOT / "src/patches/backend/open_webui/utils/middleware.py"
)


class _FakeLog:
    def debug(self, *args, **kwargs):
        return None

    def info(self, *args, **kwargs):
        return None

    def warning(self, *args, **kwargs):
        return None


def _load_reconstruction_helpers():
    source = MIDDLEWARE_PATH.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(MIDDLEWARE_PATH))
    wanted_names = {
        "_safe_json_loads",
        "_resolve_reasoning_tags",
        "_split_inline_reasoning_sections",
        "_remove_complete_inline_reasoning_sections",
        "_tool_calls_block_has_complete_results",
        "_build_terminal_tool_result_message",
        "_freeze_tool_calls_block_for_terminal_state",
        "normalize_tool_results",
        "_serialize_replay_text_blocks",
        "_sanitize_skill_asset_tool_result_for_model",
        "_is_displayable_image_tool_file",
        "_inline_image_file_count",
        "_is_chrome_devtools_screenshot_tool",
        "_parse_tool_result_for_enrichment",
        "_render_tool_result_enrichment",
        "_build_tool_result_inline_image_metadata",
        "_extract_saved_screenshot_host_path",
        "_enrich_chrome_screenshot_file_path_result",
        "_enrich_tool_result_for_inline_image_files",
        "_tool_name_for_call_id",
        "_tool_result_content_for_model_replay",
        "_partition_tool_call_block_for_replay",
        "_freeze_tool_calls_block_for_terminal_error",
        "_message_content_part_is_empty",
        "_message_content_is_empty",
        "_assistant_message_has_model_replay_payload",
        "_user_message_has_attachment_payload",
        "_user_message_is_empty_for_provider",
        "_sanitize_provider_request_messages",
        "_is_workspace_image_url",
        "_workspace_image_conversion_error",
        "_sniff_image_media_type",
        "_decode_base64_image_data",
        "_normalize_image_data_url_mime",
        "convert_url_images_to_base64",
        "reconstruct_anthropic_format",
    }
    wanted_assigns = {
        "_SKILL_ASSET_MARKDOWN_DATA_IMAGE_RE",
        "_SKILL_ASSET_DATA_IMAGE_RE",
    }
    selected_nodes = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in wanted_names:
            selected_nodes.append(node)
        elif isinstance(node, ast.Assign):
            names = {
                target.id
                for target in node.targets
                if isinstance(target, ast.Name)
            }
            if names & wanted_assigns:
                selected_nodes.append(node)

    namespace = {
        "Any": Any,
        "copy": copy,
        "base64": base64,
        "json": json,
        "log": _FakeLog(),
        "re": re,
        "time": time,
        "asyncio": asyncio,
        "Optional": Optional,
        "HTTPException": type(
            "HTTPException",
            (Exception,),
            {
                "__init__": lambda self, status_code, detail: (
                    setattr(self, "status_code", status_code),
                    setattr(self, "detail", detail),
                )
                and None
            },
        ),
        "CANONICAL_REASONING_START_TAG": "<think>",
        "CANONICAL_REASONING_END_TAG": "</think>",
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
        "_normalize_server_id": lambda value: str(value or "").strip(),
    }
    exec(
        compile(ast.Module(body=selected_nodes, type_ignores=[]), str(MIDDLEWARE_PATH), "exec"),
        namespace,
    )
    return namespace


HELPERS = _load_reconstruction_helpers()
_partition_tool_call_block_for_replay = HELPERS["_partition_tool_call_block_for_replay"]
_freeze_tool_calls_block_for_terminal_error = HELPERS[
    "_freeze_tool_calls_block_for_terminal_error"
]
_serialize_replay_text_blocks = HELPERS["_serialize_replay_text_blocks"]
_sanitize_provider_request_messages = HELPERS["_sanitize_provider_request_messages"]
reconstruct_anthropic_format = HELPERS["reconstruct_anthropic_format"]
convert_url_images_to_base64 = HELPERS["convert_url_images_to_base64"]


def test_partition_tool_call_block_for_replay_drops_unmatched_calls_and_results():
    block = {
        "type": "tool_calls",
        "content": [
            {"id": "call-1", "function": {"name": "tool_a", "arguments": "{}"}},
            {"id": "call-2", "function": {"name": "tool_b", "arguments": "{}"}},
        ],
        "results": [
            {"tool_call_id": "call-1", "content": "ok"},
            {"tool_call_id": "call-9", "content": "orphaned"},
        ],
    }

    replay_block = _partition_tool_call_block_for_replay(block)

    assert [tool_call["id"] for tool_call in replay_block["matched_tool_calls"]] == [
        "call-1"
    ]
    assert [result["tool_call_id"] for result in replay_block["matched_results"]] == [
        "call-1"
    ]
    assert replay_block["unmatched_tool_call_ids"] == ["call-2"]
    assert replay_block["orphaned_result_ids"] == ["call-9"]


def test_serialize_replay_text_blocks_canonicalizes_reasoning_tags():
    serialized = _serialize_replay_text_blocks(
        [
            {
                "type": "reasoning",
                "start_tag": "<thinking>",
                "end_tag": "</thinking>",
                "content": "Plan the next action.",
            },
            {
                "type": "text",
                "content": "Done.",
            },
        ]
    )

    assert serialized == "<think>Plan the next action.</think>\nDone."
    assert "<thinking>" not in serialized


def test_serialize_replay_text_blocks_scrubs_leaked_think_sections_from_text_blocks():
    serialized = _serialize_replay_text_blocks(
        [
            {
                "type": "reasoning",
                "start_tag": "<thinking>",
                "end_tag": "</thinking>",
                "content": "Genuine reasoning.",
            },
            {
                "type": "text",
                "content": "<think>leaked thought text</think>Answer.",
            },
        ]
    )

    # Genuine reasoning keeps its canonical wrapping; the literal think
    # section a model wrote into visible text does not ride the replay.
    assert serialized == "<think>Genuine reasoning.</think>\nAnswer."

    leak_only = _serialize_replay_text_blocks(
        [
            {"type": "text", "content": "<think>only a leak</think>"},
            {"type": "text", "content": "Visible."},
        ]
    )
    assert leak_only == "Visible."


def test_reconstruct_anthropic_format_scrubs_leaked_think_from_plain_assistant_content():
    messages = [
        {"role": "user", "content": "Which skills can be unpublished?"},
        {
            "role": "assistant",
            "content": (
                "<think>stored leak from an older build</think>"
                "A skill cannot be unpublished."
            ),
        },
    ]

    reconstructed = reconstruct_anthropic_format(messages, chat_id="chat-1")

    assert reconstructed[0] == messages[0]
    assert reconstructed[1]["content"] == "A skill cannot be unpublished."
    # The caller's message dict is not mutated in place.
    assert "<think>" in messages[1]["content"]


def test_reconstruct_anthropic_format_skips_orphaned_trailing_tool_block():
    messages = [
        {"role": "user", "content": "Check the metrics"},
        {
            "role": "assistant",
            "contentBlocks": [
                {"type": "text", "content": "Let me parse the files first."},
                {
                    "type": "tool_calls",
                    "content": [
                        {
                            "id": "tooluse-1",
                            "function": {
                                "name": "agent_vm_python",
                                "arguments": '{"script":"print(1)"}',
                            },
                        }
                    ],
                    "results": [],
                },
            ],
        },
    ]

    reconstructed = reconstruct_anthropic_format(messages, chat_id="chat-123")

    assert reconstructed == [
        {"role": "user", "content": "Check the metrics"},
        {"role": "assistant", "content": "Let me parse the files first."},
    ]


def test_reconstruct_anthropic_format_keeps_only_matched_tool_pairs_in_mixed_block():
    tool_call_a = {
        "id": "call-1",
        "function": {"name": "tool_a", "arguments": '{"q":"alpha"}'},
    }
    tool_call_b = {
        "id": "call-2",
        "function": {"name": "tool_b", "arguments": '{"q":"beta"}'},
    }
    messages = [
        {
            "role": "assistant",
            "contentBlocks": [
                {"type": "text", "content": "Working on it."},
                {
                    "type": "tool_calls",
                    "content": [tool_call_a, tool_call_b],
                    "results": [
                        {"tool_call_id": "call-1", "content": "alpha result"},
                        {"tool_call_id": "call-9", "content": "orphaned"},
                    ],
                },
                {"type": "text", "content": "Done."},
            ],
        }
    ]

    reconstructed = reconstruct_anthropic_format(messages, chat_id="chat-456")

    assert reconstructed == [
        {
            "role": "assistant",
            "content": "Working on it.",
            "tool_calls": [tool_call_a],
        },
        {
            "role": "tool",
            "tool_call_id": "call-1",
            "content": "alpha result",
        },
        {
            "role": "assistant",
            "content": "Done.",
        },
    ]


def test_sanitize_provider_request_messages_drops_empty_assistant_history_entries():
    messages = [
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "", "error": True, "done": True},
        {"role": "assistant", "content": []},
        {
            "role": "assistant",
            "content": [{"type": "text", "text": "   "}],
        },
        {"role": "assistant", "content": "ok"},
    ]

    sanitized, metadata = _sanitize_provider_request_messages(messages)

    assert metadata == {
        "dropped_empty_assistant_messages": 3,
        "dropped_historical_empty_user_messages": 0,
        "latest_empty_user_message_rejected": False,
        "latest_empty_user_message_index": None,
    }
    assert sanitized == [
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "ok"},
    ]


def test_sanitize_provider_request_messages_drops_historical_empty_user_messages():
    messages = [
        {"role": "user", "content": ""},
        {"role": "assistant", "content": "previous answer"},
        {"role": "user", "content": [{"type": "text", "text": "   "}]},
        {"role": "assistant", "content": "another answer"},
        {"role": "user", "content": "continue from here"},
    ]

    sanitized, metadata = _sanitize_provider_request_messages(messages)

    assert metadata == {
        "dropped_empty_assistant_messages": 0,
        "dropped_historical_empty_user_messages": 2,
        "latest_empty_user_message_rejected": False,
        "latest_empty_user_message_index": None,
    }
    assert sanitized == [
        {"role": "assistant", "content": "previous answer"},
        {"role": "assistant", "content": "another answer"},
        {"role": "user", "content": "continue from here"},
    ]


def test_sanitize_provider_request_messages_flags_latest_empty_user_message():
    messages = [
        {"role": "user", "content": "first question"},
        {"role": "assistant", "content": "first answer"},
        {"role": "user", "content": "   "},
    ]

    sanitized, metadata = _sanitize_provider_request_messages(messages)

    assert metadata == {
        "dropped_empty_assistant_messages": 0,
        "dropped_historical_empty_user_messages": 0,
        "latest_empty_user_message_rejected": True,
        "latest_empty_user_message_index": 2,
    }
    assert sanitized == [
        {"role": "user", "content": "first question"},
        {"role": "assistant", "content": "first answer"},
    ]


def test_sanitize_provider_request_messages_preserves_user_multimodal_and_file_turns():
    messages = [
        {"role": "user", "content": "", "files": [{"id": "file-1"}]},
        {
            "role": "user",
            "content": [{"type": "image_url", "image_url": {"url": "data:image/png;base64,YWJj"}}],
        },
        {
            "role": "user",
            "content": [{"type": "file", "file": {"id": "file-2"}}],
        },
        {"role": "user", "content": "latest"},
    ]

    sanitized, metadata = _sanitize_provider_request_messages(messages)

    assert metadata == {
        "dropped_empty_assistant_messages": 0,
        "dropped_historical_empty_user_messages": 0,
        "latest_empty_user_message_rejected": False,
        "latest_empty_user_message_index": None,
    }
    assert sanitized == messages


def test_sanitize_provider_request_messages_preserves_assistant_tool_call_turns():
    tool_call = {
        "id": "call-1",
        "function": {"name": "tool_a", "arguments": "{}"},
    }
    messages = [
        {"role": "assistant", "content": "", "tool_calls": [tool_call]},
        {"role": "assistant", "content": None, "function_call": {"name": "legacy"}},
    ]

    sanitized, metadata = _sanitize_provider_request_messages(messages)

    assert metadata["dropped_empty_assistant_messages"] == 0
    assert metadata["dropped_historical_empty_user_messages"] == 0
    assert metadata["latest_empty_user_message_rejected"] is False
    assert sanitized == messages


def test_convert_url_images_to_base64_preserves_existing_data_urls():
    form_data = {
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {"url": "data:image/png;base64,YWJj"},
                    }
                ],
            }
        ]
    }

    result = asyncio.run(convert_url_images_to_base64(copy.deepcopy(form_data)))

    assert result == form_data


def test_convert_url_images_to_base64_converts_workspace_urls_to_data_urls():
    original_converter = HELPERS.get("get_image_base64_from_url")
    jpeg_bytes = b"\xff\xd8\xff\xd9"
    jpeg_base64 = base64.b64encode(jpeg_bytes).decode("ascii")
    HELPERS["get_image_base64_from_url"] = (
        lambda url: f"data:image/png;base64,{jpeg_base64}"
    )
    try:
        result = asyncio.run(
            convert_url_images_to_base64(
                {
                    "messages": [
                        {
                            "role": "user",
                            "content": [
                                {
                                    "type": "image_url",
                                    "image_url": {
                                        "url": "http://host.docker.internal:9876/workspace/chat/slide.jpg"
                                    },
                                }
                            ],
                        }
                    ]
                }
            )
        )
    finally:
        if original_converter is None:
            HELPERS.pop("get_image_base64_from_url", None)
        else:
            HELPERS["get_image_base64_from_url"] = original_converter

    assert result["messages"][0]["content"][0]["image_url"]["url"] == (
        f"data:image/jpeg;base64,{jpeg_base64}"
    )


def test_convert_url_images_to_base64_fails_closed_for_unsupported_workspace_images():
    original_converter = HELPERS.get("get_image_base64_from_url")
    HELPERS["get_image_base64_from_url"] = lambda url: "data:image/png;base64,YWJj"
    try:
        with pytest.raises(Exception) as exc_info:
            asyncio.run(
                convert_url_images_to_base64(
                    {
                        "messages": [
                            {
                                "role": "user",
                                "content": [
                                    {
                                        "type": "image_url",
                                        "image_url": {
                                            "url": "http://host.docker.internal:9876/workspace/chat/slide.jpg"
                                        },
                                    }
                                ],
                            }
                        ]
                    }
                )
            )
    finally:
        if original_converter is None:
            HELPERS.pop("get_image_base64_from_url", None)
        else:
            HELPERS["get_image_base64_from_url"] = original_converter

    assert exc_info.value.status_code == 400
    assert "unsupported image bytes" in exc_info.value.detail


def test_convert_url_images_to_base64_fails_closed_for_workspace_fetch_errors():
    def _raise_fetch_error(url):
        raise RuntimeError("not reachable")

    original_converter = HELPERS.get("get_image_base64_from_url")
    HELPERS["get_image_base64_from_url"] = _raise_fetch_error
    try:
        with pytest.raises(Exception) as exc_info:
            asyncio.run(
                convert_url_images_to_base64(
                    {
                        "messages": [
                            {
                                "role": "user",
                                "content": [
                                    {
                                        "type": "image_url",
                                        "image_url": {
                                            "url": "http://host.docker.internal:9876/workspace/chat/slide.jpg"
                                        },
                                    }
                                ],
                            }
                        ]
                    }
                )
            )
    finally:
        if original_converter is None:
            HELPERS.pop("get_image_base64_from_url", None)
        else:
            HELPERS["get_image_base64_from_url"] = original_converter

    assert exc_info.value.status_code == 400
    assert "Unable to fetch workspace image URL" in exc_info.value.detail


def test_reconstruct_anthropic_format_enriches_inline_screenshot_files_for_replay():
    tool_call = {
        "id": "tooluse-screenshot",
        "function": {"name": "chrome_devtools_take_screenshot", "arguments": "{}"},
    }
    messages = [
        {
            "role": "assistant",
            "contentBlocks": [
                {"type": "text", "content": "Capturing the viewport."},
                {
                    "type": "tool_calls",
                    "content": [tool_call],
                    "results": [
                        {
                            "tool_call_id": "tooluse-screenshot",
                            "content": json.dumps(
                                {
                                    "results": [
                                        "Took a screenshot of the current page's viewport."
                                    ]
                                }
                            ),
                            "server_id": "chrome-devtools",
                            "files": [
                                {
                                    "type": "data",
                                    "content": "data:image/png;base64,AAAA",
                                }
                            ],
                        }
                    ],
                },
            ],
        }
    ]

    reconstructed = reconstruct_anthropic_format(messages, chat_id="chat-screenshot")
    tool_result = json.loads(reconstructed[1]["content"])

    assert reconstructed[0]["tool_calls"] == [tool_call]
    assert tool_result["inline_image_attached"] is True
    assert tool_result["inline_image_count"] == 1
    assert tool_result["message"] == "The screenshot image is attached for inline display in the chat."
    assert "data:image" not in reconstructed[1]["content"]
    assert "AAAA" not in reconstructed[1]["content"]


def test_freeze_tool_calls_block_for_terminal_error_synthesizes_missing_results():
    block = {
        "type": "tool_calls",
        "content": [
            {"id": "call-1", "function": {"name": "tool_a", "arguments": "{}"}},
            {"id": "call-2", "function": {"name": "tool_b", "arguments": "{}"}},
        ],
        "results": [{"tool_call_id": "call-1", "content": "already complete"}],
        "started_at": 10.0,
        "streaming_preview": True,
    }

    results = _freeze_tool_calls_block_for_terminal_error(
        block,
        "Upstream model provider stream timed out. Please retry.",
        now=15.0,
    )

    assert block["streaming_preview"] is False
    assert block["ended_at"] == 15.0
    assert block["duration"] == 5
    assert [result["tool_call_id"] for result in results] == ["call-1", "call-2"]
    assert results[-1]["content"] == (
        "Interrupted: Upstream model provider stream timed out. Please retry."
    )
    assert block["results"] == results
