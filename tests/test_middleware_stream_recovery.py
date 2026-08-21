from pathlib import Path
import ast
import os
import sys
from typing import Optional

try:
    from starlette.responses import JSONResponse, Response
except ModuleNotFoundError:
    class Response:  # pragma: no cover - local test shim
        def __init__(self, content=None, status_code: int = 200, **_kwargs):
            self.content = content
            self.status_code = status_code
            self.body = (
                __import__("json").dumps(content).encode("utf-8")
                if content is not None
                else b""
            )

    class JSONResponse(Response):  # pragma: no cover - local test shim
        pass


REPO_ROOT = Path(__file__).resolve().parents[1]
MIDDLEWARE_PATH = (
    REPO_ROOT / "src/patches/backend/open_webui/utils/middleware.py"
)
sys.path.insert(0, str(REPO_ROOT / "src/patches/backend"))

from open_webui.utils.mcp_runtime import (  # noqa: E402
    normalize_tool_execution_error,
)


def _is_ultra_request(payload):
    if not isinstance(payload, dict):
        return False
    return payload.get("reasoning_effort") == "ultra" or (
        isinstance(payload.get("params"), dict)
        and payload["params"].get("reasoning_effort") == "ultra"
    )


class _FakeLog:
    def info(self, *args, **kwargs):
        return None

    def warning(self, *args, **kwargs):
        return None


def _load_stream_recovery_helpers():
    source = MIDDLEWARE_PATH.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(MIDDLEWARE_PATH))
    wanted_names = {
        "_refresh_upstream_request_metadata",
        "_latest_tool_calls_block_index",
        "_assistant_tool_block_anchor_updates",
        "_strip_legacy_tool_followup_system_message",
        "_is_context_window_error",
        "_is_model_access_denied_error",
        "_is_multimodal_unsupported_error",
        "_is_bedrock_malformed_tool_use_error",
        "_is_empty_tool_call_terminal",
        "_format_error_message",
        "_build_terminal_tool_result_message",
        "_freeze_tool_calls_block_for_terminal_state",
        "_is_empty_open_reasoning_block",
        "_freeze_content_blocks_for_terminal_state",
        "_has_completed_tool_results_block",
        "_tool_calls_block_has_complete_results",
        "_serialize_replay_text_blocks",
        "_resolve_reasoning_tags",
        "_split_inline_reasoning_sections",
        "_remove_complete_inline_reasoning_sections",
        "_partition_tool_call_block_for_replay",
        "_should_synthesize_incomplete_stream_length",
        "_should_finalize_reasoning_only_incomplete_stream",
        "_continuation_followup_index",
        "_coerce_status_code",
        "_extract_error_message",
        "_safe_json_loads",
        "_sync_flattened_message_with_history",
        "_get_response_status_code",
        "_positive_int_from_env",
        "_is_bedrock_stream_inactive_error",
        "_retryable_chat_completion_error_reason",
        "_is_retryable_chat_completion_error",
        "_terminal_stop_reason_for_chat_completion_error",
        "_should_retry_chat_completion_attempt",
        "_coerce_non_negative_int",
        "_build_stream_attempt_snapshot",
        "_restore_stream_attempt_snapshot",
        "_should_retry_stream_error_event",
        "_get_bedrock_stream_inactive_retry_max_attempts",
        "_get_transient_chat_completion_retry_max_attempts",
        "_get_chat_completion_request_retry_max_attempts",
        "_get_transient_chat_completion_retry_delay_seconds",
        "_is_retryable_tool_execution_error",
        "_is_retryable_tool_execution_result",
        "_get_transient_tool_execution_retry_delay_seconds",
        "_llm_debug_usage_to_int",
        "_normalize_llm_debug_usage",
        "_extract_reasoning_details_text",
        "_merge_reasoning_delta_text",
        "_strip_reasoning_delta_fields",
        "_append_reasoning_text_to_content_blocks",
        "normalize_tool_results",
    }
    selected_nodes = [
        node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name in wanted_names
    ]

    module = ast.Module(body=selected_nodes, type_ignores=[])
    namespace = {
        "Optional": Optional,
        "Any": object,
        "json": __import__("json"),
        "copy": __import__("copy"),
        "os": os,
        "re": __import__("re"),
        "time": __import__("time"),
        "log": _FakeLog(),
        "JSONResponse": JSONResponse,
        "Response": Response,
        "is_ultra_request": _is_ultra_request,
        "_LEGACY_TOOL_FOLLOWUP_CONTINUATION_SYSTEM_MESSAGE": (
            "Internal tool follow-up for the same assistant turn. "
            "No new user message was sent. Continue the current answer using the "
            "existing conversation and the tool results below."
        ),
        "_TRANSIENT_CHAT_COMPLETION_RETRY_BASE_DELAY_SECONDS": 1.0,
        "_TRANSIENT_CHAT_COMPLETION_RETRY_MAX_DELAY_SECONDS": 8.0,
        "_TRANSIENT_CHAT_COMPLETION_RETRY_MAX_ATTEMPTS": 4,
        "_BEDROCK_STREAM_INACTIVE_RETRY_MAX_ATTEMPTS": 8,
        "_BEDROCK_MALFORMED_TOOL_USE_RETRY_MAX_ATTEMPTS": 2,
        "_TRANSIENT_TOOL_EXECUTION_RETRY_BASE_DELAY_SECONDS": 0.5,
        "_TRANSIENT_TOOL_EXECUTION_RETRY_MAX_DELAY_SECONDS": 2.0,
        "_TRANSIENT_CHAT_COMPLETION_RETRYABLE_STATUS_CODES": frozenset(
            {408, 409, 425, 429, 500, 502, 503, 504}
        ),
        "BEDROCK_MALFORMED_TOOL_USE_ERROR_KIND": "bedrock_malformed_tool_use",
        "MALFORMED_TOOL_USE_STOP_REASON": "malformed_tool_use",
        "MALFORMED_TOOL_USE_USER_MESSAGE": (
            "The model provider ended the response before producing its requested "
            "tool call. Please retry."
        ),
        "_CONTEXT_WINDOW_ERROR_FRAGMENTS": (
            "context window",
            "maximum context length",
            "maximum context window",
            "prompt is too long",
            "context_length_exceeded",
        ),
        "_MODEL_ACCESS_DENIED_FRAGMENTS": (
            "model not found",
            "model access denied",
            "does not have access to model",
            "permission denied for model",
            "not authorized to access model",
        ),
        "_MULTIMODAL_UNSUPPORTED_FRAGMENTS": (
            "multimodal content (images, audio, video) is not supported",
            "multimodal content is not supported",
        ),
        "_HTTP_ERROR_STATUS_RE": __import__("re").compile(
            r"\bhttp(?:\s+error)?\s+(\d{3})\b", __import__("re").IGNORECASE
        ),
        "normalize_tool_execution_error": normalize_tool_execution_error,
        "ensure_upstream_request_id": lambda metadata, force_new=False: {
            **dict(metadata or {}),
            "upstream_request_id": (
                "fresh-upstream-id"
                if force_new
                or not isinstance(dict(metadata or {}).get("upstream_request_id"), str)
                or not dict(metadata or {}).get("upstream_request_id", "").strip()
                else dict(metadata or {}).get("upstream_request_id")
            ),
        },
        "_TRANSIENT_CHAT_COMPLETION_RETRYABLE_MESSAGE_FRAGMENTS": (
            "server disconnected",
            "service unavailable",
            "temporarily unavailable",
            "upstream model provider stream failed",
            "connection reset",
            "connection aborted",
            "connection closed",
            "remote protocol error",
            "timed out",
            "timeout",
            "broken pipe",
            "transport closed",
            "try again",
        ),
        "_BEDROCK_UNEXPECTED_PROCESSING_ERROR_FRAGMENTS": (
            "unexpected error during processing",
            "try your request again",
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
        "_REASONING_DELTA_KEYS": (
            "reasoning_content",
            "reasoning",
            "thinking",
            "reasoning_details",
        ),
        "_float_env": lambda name, default: default,
    }
    exec(compile(module, str(MIDDLEWARE_PATH), "exec"), namespace)
    return namespace


HELPERS = _load_stream_recovery_helpers()
_has_completed_tool_results_block = HELPERS["_has_completed_tool_results_block"]
_refresh_upstream_request_metadata = HELPERS["_refresh_upstream_request_metadata"]
_latest_tool_calls_block_index = HELPERS["_latest_tool_calls_block_index"]
_assistant_tool_block_anchor_updates = HELPERS[
    "_assistant_tool_block_anchor_updates"
]
_strip_legacy_tool_followup_system_message = HELPERS[
    "_strip_legacy_tool_followup_system_message"
]
_should_synthesize_incomplete_stream_length = HELPERS[
    "_should_synthesize_incomplete_stream_length"
]
_should_finalize_reasoning_only_incomplete_stream = HELPERS[
    "_should_finalize_reasoning_only_incomplete_stream"
]
_continuation_followup_index = HELPERS["_continuation_followup_index"]
_freeze_tool_calls_block_for_terminal_state = HELPERS[
    "_freeze_tool_calls_block_for_terminal_state"
]
_freeze_content_blocks_for_terminal_state = HELPERS[
    "_freeze_content_blocks_for_terminal_state"
]
_tool_calls_block_has_complete_results = HELPERS[
    "_tool_calls_block_has_complete_results"
]
_serialize_replay_text_blocks = HELPERS["_serialize_replay_text_blocks"]
_partition_tool_call_block_for_replay = HELPERS[
    "_partition_tool_call_block_for_replay"
]
_sync_flattened_message_with_history = HELPERS[
    "_sync_flattened_message_with_history"
]
_is_retryable_chat_completion_error = HELPERS[
    "_is_retryable_chat_completion_error"
]
_retryable_chat_completion_error_reason = HELPERS[
    "_retryable_chat_completion_error_reason"
]
_is_bedrock_malformed_tool_use_error = HELPERS[
    "_is_bedrock_malformed_tool_use_error"
]
_is_empty_tool_call_terminal = HELPERS["_is_empty_tool_call_terminal"]
_format_error_message = HELPERS["_format_error_message"]
_terminal_stop_reason_for_chat_completion_error = HELPERS[
    "_terminal_stop_reason_for_chat_completion_error"
]
_should_retry_chat_completion_attempt = HELPERS[
    "_should_retry_chat_completion_attempt"
]
_build_stream_attempt_snapshot = HELPERS["_build_stream_attempt_snapshot"]
_restore_stream_attempt_snapshot = HELPERS["_restore_stream_attempt_snapshot"]
_should_retry_stream_error_event = HELPERS["_should_retry_stream_error_event"]
_get_transient_chat_completion_retry_max_attempts = HELPERS[
    "_get_transient_chat_completion_retry_max_attempts"
]
_get_chat_completion_request_retry_max_attempts = HELPERS[
    "_get_chat_completion_request_retry_max_attempts"
]
_get_transient_chat_completion_retry_delay_seconds = HELPERS[
    "_get_transient_chat_completion_retry_delay_seconds"
]
_is_retryable_tool_execution_error = HELPERS[
    "_is_retryable_tool_execution_error"
]
_is_retryable_tool_execution_result = HELPERS[
    "_is_retryable_tool_execution_result"
]
_get_transient_tool_execution_retry_delay_seconds = HELPERS[
    "_get_transient_tool_execution_retry_delay_seconds"
]
_normalize_llm_debug_usage = HELPERS["_normalize_llm_debug_usage"]
_extract_reasoning_details_text = HELPERS["_extract_reasoning_details_text"]
_merge_reasoning_delta_text = HELPERS["_merge_reasoning_delta_text"]
_strip_reasoning_delta_fields = HELPERS["_strip_reasoning_delta_fields"]
_append_reasoning_text_to_content_blocks = HELPERS[
    "_append_reasoning_text_to_content_blocks"
]


def test_safe_json_loads_and_status_helpers_handle_invalid_and_nested_inputs():
    safe_json_loads = HELPERS["_safe_json_loads"]
    coerce_status = HELPERS["_coerce_status_code"]
    get_status = HELPERS["_get_response_status_code"]

    assert safe_json_loads('{"ok": true}') == {"ok": True}
    assert safe_json_loads("not-json") is None

    assert coerce_status(None) is None
    assert coerce_status("") is None
    assert coerce_status("503") == 503
    assert coerce_status("bad") is None

    assert get_status({"status_code": "502"}) == 502
    assert get_status({"error": {"code": "503"}}) == 503
    assert get_status({"error": {"message": "HTTP error 504: gateway timeout"}}) == 504
    assert get_status({"error": {"message": "validation failed"}}) is None


def test_normalize_llm_debug_usage_preserves_reasoning_tokens_from_nested_details():
    usage = _normalize_llm_debug_usage(
        {
            "prompt_tokens": 11,
            "completion_tokens": 22,
            "total_tokens": 33,
            "completion_tokens_details": {
                "reasoning_tokens": 17,
                "text_tokens": 5,
            },
        }
    )

    assert usage["prompt_tokens"] == 11
    assert usage["completion_tokens"] == 22
    assert usage["total_tokens"] == 33
    assert usage["reasoning_tokens"] == 17

    output_usage = _normalize_llm_debug_usage(
        {
            "input_tokens": 3,
            "output_tokens": 4,
            "output_tokens_details": {"reasoning_tokens": 2},
        }
    )

    assert output_usage["reasoning_tokens"] == 2


def test_extract_reasoning_details_text_only_uses_displayable_gemini_text_entries():
    reasoning_details = [
        {
            "type": "reasoning.text",
            "text": "visible summary",
            "signature": "should-not-render",
        },
        {
            "type": "reasoning.encrypted",
            "signature": "encrypted-payload",
        },
        {
            "type": "reasoning.text",
            "text": " continues",
            "thoughtSignature": "also-not-rendered",
        },
        {"type": "reasoning.text", "content": "ignored-nonstandard-field"},
    ]

    assert _extract_reasoning_details_text(reasoning_details) == (
        "visible summary continues"
    )
    assert _extract_reasoning_details_text(
        [{"type": "reasoning.encrypted", "signature": "secret"}]
    ) == ""


def test_merge_reasoning_delta_text_collapses_duplicate_bifrost_reasoning_details():
    assert _merge_reasoning_delta_text("chunk", "chunk") == "chunk"
    assert _merge_reasoning_delta_text("", "chunk") == "chunk"
    assert _merge_reasoning_delta_text(None, "chunk") == "chunk"
    assert _merge_reasoning_delta_text("chunk", " other") == "chunk other"


def test_strip_reasoning_delta_fields_removes_gemini_reasoning_details():
    delta = {
        "role": "assistant",
        "reasoning_details": [
            {"type": "reasoning.encrypted", "signature": "must-not-leak"}
        ],
        "reasoning_content": "hidden",
        "thinking": "hidden",
        "content": "visible",
    }

    assert _strip_reasoning_delta_fields(delta)
    assert delta == {"role": "assistant", "content": "visible"}


def test_append_reasoning_text_to_content_blocks_creates_and_extends_block():
    content_blocks = []

    first = _append_reasoning_text_to_content_blocks(
        content_blocks, "first", now=123.0
    )
    second = _append_reasoning_text_to_content_blocks(
        content_blocks, " second", now=999.0
    )

    assert first is second
    assert content_blocks == [
        {
            "type": "reasoning",
            "start_tag": "<think>",
            "end_tag": "</think>",
            "attributes": {"type": "reasoning_content"},
            "content": "first second",
            "started_at": 123.0,
        }
    ]


def test_error_classifiers_detect_context_window_and_model_access_denied_fragments():
    is_context_window_error = HELPERS["_is_context_window_error"]
    is_model_access_denied_error = HELPERS["_is_model_access_denied_error"]

    assert is_context_window_error("Maximum context length exceeded for this model")
    assert is_context_window_error("prompt is too long for the context window")
    assert not is_context_window_error("ordinary validation failed")

    assert is_model_access_denied_error("Permission denied for model atlas-opus")
    assert is_model_access_denied_error("User does not have access to model foo")
    assert not is_model_access_denied_error("service unavailable")


def test_refresh_upstream_request_metadata_forces_new_id_and_applies_updates():
    original = {"upstream_request_id": "old-upstream", "request_phase": "initial"}

    refreshed = _refresh_upstream_request_metadata(
        original,
        {"request_phase": "tool_followup", "followup_index": 2},
    )

    assert refreshed["upstream_request_id"] == "fresh-upstream-id"
    assert refreshed["request_phase"] == "tool_followup"
    assert refreshed["followup_index"] == 2
    assert original == {
        "upstream_request_id": "old-upstream",
        "request_phase": "initial",
    }


def test_latest_tool_calls_block_index_counts_tool_batches_not_list_position():
    assert _latest_tool_calls_block_index(None) is None
    assert _latest_tool_calls_block_index([{"type": "text"}]) is None
    assert (
        _latest_tool_calls_block_index(
            [
                {"type": "tool_calls"},
                {"type": "text"},
                {"type": "tool_calls"},
                {"type": "tool_calls"},
            ]
        )
        == 2
    )


def test_assistant_tool_block_anchor_updates_uses_latest_tool_batch_and_background_fallback():
    assert _assistant_tool_block_anchor_updates(
        "assistant-1",
        [{"type": "text"}, {"type": "tool_calls"}, {"type": "tool_calls"}],
    ) == {
        "transcript_anchor_kind": "assistant_tool_block",
        "transcript_anchor_message_id": "assistant-1",
        "transcript_anchor_tool_block_index": 1,
    }

    assert _assistant_tool_block_anchor_updates(
        "",
        [{"type": "tool_calls"}],
    ) == {
        "transcript_anchor_kind": "background",
        "transcript_anchor_message_id": None,
        "transcript_anchor_tool_block_index": None,
    }


def test_strip_legacy_tool_followup_system_message_removes_repeated_internal_followup_text():
    messages = [
        {"role": "system", "content": ""},
        {
            "role": "system",
            "content": (
                "<base>\n"
                "Internal tool follow-up for the same assistant turn. "
                "No new user message was sent. Continue the current answer using the "
                "existing conversation and the tool results below.\n"
                "Internal tool follow-up for the same assistant turn. "
                "No new user message was sent. Continue the current answer using the "
                "existing conversation and the tool results below.\n"
                "<still_here>true</still_here>"
            ),
        },
        {"role": "assistant", "content": "keep me"},
    ]

    cleaned = _strip_legacy_tool_followup_system_message(messages)

    assert cleaned[0]["content"] == ""
    assert cleaned[1]["content"] == "<base>\n\n<still_here>true</still_here>"
    assert cleaned[2]["content"] == "keep me"

    assert _assistant_tool_block_anchor_updates(
        "assistant-1",
        [{"type": "text"}],
    ) == {
        "transcript_anchor_kind": "background",
        "transcript_anchor_message_id": None,
        "transcript_anchor_tool_block_index": None,
    }


def test_normalize_tool_results_accepts_dict_wrappers_json_strings_and_lists():
    normalized = HELPERS["normalize_tool_results"](
        {
            "results": [
                {"tool_call_id": "call-1", "content": "ok"},
                json_string := '{"tool_call_id":"call-2","content":"done"}',
            ]
        }
    )

    assert normalized == [
        {"tool_call_id": "call-1", "content": "ok"},
        {"tool_call_id": "call-2", "content": "done"},
    ]
    assert isinstance(json_string, str)


def test_normalize_tool_results_ignores_non_dict_entries_and_invalid_json():
    normalized = HELPERS["normalize_tool_results"](
        ["not-json", 123, '{"tool_call_id":"call-3","content":"ok"}']
    )

    assert normalized == [{"tool_call_id": "call-3", "content": "ok"}]


def test_detects_completed_tool_results_blocks():
    assert _has_completed_tool_results_block(
        [
            {
                "type": "tool_calls",
                "content": [{"id": "call-1"}],
                "results": [{"id": "call-1"}],
                "ended_at": 123.0,
            }
        ]
    )
    assert not _has_completed_tool_results_block(
        [
            {
                "type": "tool_calls",
                "content": [{"id": "call-1"}],
                "results": [],
                "ended_at": 123.0,
            }
        ]
    )


def test_freeze_tool_calls_block_for_terminal_state_marks_block_done_and_synthesizes_results():
    block = {
        "type": "tool_calls",
        "content": [
            {"id": "call-1"},
            {"id": "call-2"},
        ],
        "results": [{"tool_call_id": "call-1", "content": "ok"}],
        "started_at": 10.0,
    }

    results = _freeze_tool_calls_block_for_terminal_state(
        block,
        stop_reason="client_disconnect",
        now=15.0,
    )

    assert block["done"] is True
    assert block["stop_reason"] == "client_disconnect"
    assert block["ended_at"] == 15.0
    assert block["duration"] == 5
    assert block["streaming_preview"] is False
    assert len(results) == 2
    assert results[0]["tool_call_id"] == "call-1"
    assert results[0].get("stop_reason") is None
    assert results[1]["tool_call_id"] == "call-2"
    assert results[1]["content"].startswith("Interrupted:")
    assert results[1]["stop_reason"] == "client_disconnect"


def test_freeze_content_blocks_for_terminal_state_closes_reasoning_and_tool_blocks():
    blocks = [
        {
            "type": "reasoning",
            "content": "thinking",
            "started_at": 100.0,
        },
        {
            "type": "tool_calls",
            "content": [{"id": "call-1"}],
            "started_at": 102.0,
            "streaming_preview": True,
        },
    ]

    _freeze_content_blocks_for_terminal_state(
        blocks,
        stop_reason="client_disconnect",
        now=108.0,
    )

    assert blocks[0]["ended_at"] == 108.0
    assert blocks[0]["duration"] == 8
    assert blocks[0]["stop_reason"] == "client_disconnect"
    assert blocks[1]["done"] is True
    assert blocks[1]["ended_at"] == 108.0
    assert blocks[1]["duration"] == 6
    assert blocks[1]["stop_reason"] == "client_disconnect"
    assert blocks[1]["streaming_preview"] is False
    assert blocks[1]["results"][0]["tool_call_id"] == "call-1"


def test_freeze_tool_calls_block_uses_execution_started_at_after_preview_handoff():
    block = {
        "type": "tool_calls",
        "content": [{"id": "call-1"}],
        "started_at": 100.0,
        "execution_started_at": 104.0,
        "streaming_preview": False,
    }

    results = _freeze_tool_calls_block_for_terminal_state(
        block,
        stop_reason="client_disconnect",
        now=110.0,
    )

    assert block["ended_at"] == 110.0
    assert block["duration"] == 6
    assert results[0]["tool_call_id"] == "call-1"
    assert results[0]["duration"] == 6
    assert results[0]["stop_reason"] == "client_disconnect"


def test_tool_calls_block_has_complete_results_requires_results_for_every_call():
    assert _tool_calls_block_has_complete_results(
        {
            "type": "tool_calls",
            "content": [{"id": "call-1"}, {"id": "call-2"}],
            "results": [
                {"tool_call_id": "call-1", "content": "ok"},
                {"tool_call_id": "call-2", "content": ""},
            ],
        }
    )
    assert not _tool_calls_block_has_complete_results(
        {
            "type": "tool_calls",
            "content": [{"id": "call-1"}, {"id": "call-2"}],
            "results": [{"tool_call_id": "call-1", "content": "ok"}],
        }
    )


def test_freeze_tool_calls_block_preserves_completed_results_on_disconnect():
    block = {
        "type": "tool_calls",
        "content": [{"id": "call-1"}, {"id": "call-2"}],
        "results": [
            {"tool_call_id": "call-1", "content": "ok"},
            {"tool_call_id": "call-2", "content": "done"},
        ],
        "started_at": 50.0,
    }

    results = _freeze_tool_calls_block_for_terminal_state(
        block,
        stop_reason="client_disconnect",
        now=60.0,
    )

    assert block.get("stop_reason") in (None, "")
    assert all(result.get("stop_reason") in (None, "") for result in results)
    assert len(results) == 2


def test_freeze_tool_calls_block_returns_empty_for_non_tool_blocks():
    assert (
        _freeze_tool_calls_block_for_terminal_state(
            {"type": "text", "content": "plain text"},
            stop_reason="client_disconnect",
            now=15.0,
        )
        == []
    )


def test_build_terminal_tool_result_message_prefers_error_and_normalizes_stop_reason():
    build_message = HELPERS["_build_terminal_tool_result_message"]

    assert build_message(error_message="gateway timeout") == "Interrupted: gateway timeout"
    assert (
        build_message(stop_reason="user_stop")
        == "Interrupted: response stopped before tool completed."
    )
    assert (
        build_message(stop_reason="client_disconnect")
        == "Interrupted: client disconnected before tool completed."
    )
    assert build_message(stop_reason="custom_stop_reason") == "Interrupted: custom stop reason."


def test_build_terminal_tool_result_message_uses_generic_fallback_without_reason_or_error():
    build_message = HELPERS["_build_terminal_tool_result_message"]

    assert build_message() == "Interrupted: tool execution ended before completion."


def test_freeze_content_blocks_preserves_completed_tool_block_during_client_disconnect():
    blocks = [
        {
            "type": "tool_calls",
            "content": [{"id": "call-1"}],
            "results": [{"tool_call_id": "call-1", "content": "ok"}],
            "started_at": 20.0,
        }
    ]

    _freeze_content_blocks_for_terminal_state(
        blocks,
        stop_reason="client_disconnect",
        now=30.0,
    )

    assert blocks[0]["done"] is True
    assert blocks[0].get("stop_reason") in (None, "")
    assert len(blocks[0]["results"]) == 1
    assert blocks[0]["results"][0]["tool_call_id"] == "call-1"
    assert blocks[0]["results"][0]["content"] == "ok"
    assert blocks[0]["results"][0].get("stop_reason") in (None, "")


def test_freeze_content_blocks_ignores_plain_text_and_preserves_completed_reasoning_blocks():
    blocks = [
        {"type": "text", "content": "plain text"},
        {
            "type": "reasoning",
            "content": "already closed",
            "started_at": 100.0,
            "ended_at": 101.0,
            "duration": 1,
        },
    ]

    result = _freeze_content_blocks_for_terminal_state(
        blocks,
        stop_reason="client_disconnect",
        now=108.0,
    )

    assert result[0] == {"type": "text", "content": "plain text"}
    assert result[1]["ended_at"] == 101.0
    assert result[1]["duration"] == 1
    assert result[1].get("stop_reason") in (None, "")


def test_freeze_tool_calls_block_backfills_result_timing_and_uses_error_message_for_missing_calls():
    block = {
        "type": "tool_calls",
        "content": [{"id": "call-1"}, {"id": "call-2"}],
        "results": [{"tool_call_id": "call-1", "content": "ok", "started_at": 12.0}],
        "started_at": 10.0,
    }

    results = _freeze_tool_calls_block_for_terminal_state(
        block,
        stop_reason="upstream_error",
        error_message="upstream broke",
        now=15.0,
    )

    assert results[0]["ended_at"] == 15.0
    assert results[0]["duration"] == 3
    assert results[1]["tool_call_id"] == "call-2"
    assert results[1]["content"] == "Interrupted: upstream broke"
    assert results[1]["stop_reason"] == "upstream_error"


def test_serialize_replay_text_blocks_wraps_reasoning_in_canonical_tags_and_skips_blanks():
    serialized = _serialize_replay_text_blocks(
        [
            {"type": "text", "content": "Visible answer"},
            {"type": "reasoning", "content": "private chain"},
            {"type": "text", "content": "   "},
        ]
    )

    assert serialized == "Visible answer\n<think>private chain</think>"


def test_serialize_replay_text_blocks_preserves_order_and_serializes_non_reasoning_blocks_verbatim():
    serialized = _serialize_replay_text_blocks(
        [
            {"type": "reasoning", "content": "step 1"},
            {"type": "tool_calls", "content": [{"id": "call-1"}]},
            {"type": "text", "content": "Visible answer"},
            {"type": "reasoning", "content": "step 2"},
        ]
    )

    assert serialized == (
        "<think>step 1</think>\n[{'id': 'call-1'}]\nVisible answer\n<think>step 2</think>"
    )


def test_partition_tool_call_block_for_replay_separates_matched_unmatched_and_orphaned_entries():
    partitioned = _partition_tool_call_block_for_replay(
        {
            "type": "tool_calls",
            "content": [{"id": "call-1"}, {"id": "call-2"}],
            "results": [
                {"tool_call_id": "call-2", "content": "done"},
                {"tool_call_id": "orphan", "content": "extra"},
                {"tool_call_id": "call-1", "content": "ok"},
            ],
        }
    )

    assert [entry["id"] for entry in partitioned["matched_tool_calls"]] == [
        "call-1",
        "call-2",
    ]
    assert [entry["tool_call_id"] for entry in partitioned["matched_results"]] == [
        "call-1",
        "call-2",
    ]
    assert partitioned["unmatched_tool_call_ids"] == []
    assert partitioned["orphaned_result_ids"] == ["orphan"]


def test_partition_tool_call_block_for_replay_returns_empty_partition_for_invalid_shape():
    assert _partition_tool_call_block_for_replay({"type": "text", "content": "plain"}) == {
        "matched_tool_calls": [],
        "matched_results": [],
        "unmatched_tool_call_ids": [],
        "orphaned_result_ids": [],
    }


def test_partition_tool_call_block_for_replay_reports_unmatched_tool_calls_without_results():
    partitioned = _partition_tool_call_block_for_replay(
        {
            "type": "tool_calls",
            "content": [{"id": "call-1"}, {"id": "call-2"}],
            "results": [{"tool_call_id": "call-1", "content": "ok"}],
        }
    )

    assert [entry["id"] for entry in partitioned["matched_tool_calls"]] == ["call-1"]
    assert partitioned["unmatched_tool_call_ids"] == ["call-2"]
    assert partitioned["orphaned_result_ids"] == []


def test_sync_flattened_message_with_history_updates_existing_flattened_entry():
    chat_payload = {
        "history": {
            "messages": {
                "msg-1": {
                    "id": "msg-1",
                    "content": "updated",
                    "done": True,
                    "stop_reason": "upstream_error",
                    "contentBlocks": [{"type": "text", "text": "updated"}],
                    "error": {"content": "timeout"},
                }
            }
        },
        "messages": [
            {
                "id": "msg-1",
                "content": "stale",
                "done": False,
                "contentBlocks": [],
            }
        ],
    }

    assert _sync_flattened_message_with_history(chat_payload, "msg-1")
    assert chat_payload["messages"] == [chat_payload["history"]["messages"]["msg-1"]]


def test_sync_flattened_message_with_history_appends_missing_flattened_entry():
    chat_payload = {
        "history": {
            "messages": {
                "msg-1": {
                    "id": "msg-1",
                    "content": "final",
                    "done": True,
                    "stop_reason": "upstream_error",
                }
            }
        },
        "messages": [],
    }

    assert _sync_flattened_message_with_history(chat_payload, "msg-1")
    assert chat_payload["messages"] == [chat_payload["history"]["messages"]["msg-1"]]


def test_sync_flattened_message_with_history_returns_false_when_message_missing():
    chat_payload = {
        "history": {"messages": {}},
        "messages": [],
    }

    assert not _sync_flattened_message_with_history(chat_payload, "missing")
    assert chat_payload["messages"] == []


def test_synthesizes_length_for_interrupted_post_tool_followup_with_small_output():
    assert _should_synthesize_incomplete_stream_length(
        response_tool_calls=[],
        finish_reason=None,
        stop_reason=None,
        generated_text_chars=10,
        generated_reasoning_chars=64,
        had_completed_tool_results_before_stream=True,
    )


def test_does_not_synthesize_length_for_tiny_initial_stream_output_without_tool_phase():
    assert not _should_synthesize_incomplete_stream_length(
        response_tool_calls=[],
        finish_reason=None,
        stop_reason=None,
        generated_text_chars=10,
        generated_reasoning_chars=0,
        had_completed_tool_results_before_stream=False,
    )


def test_does_not_synthesize_length_once_finish_reason_or_stop_reason_is_present():
    assert not _should_synthesize_incomplete_stream_length(
        response_tool_calls=[],
        finish_reason="stop",
        stop_reason=None,
        generated_text_chars=100,
        generated_reasoning_chars=0,
        had_completed_tool_results_before_stream=True,
    )
    assert not _should_synthesize_incomplete_stream_length(
        response_tool_calls=[],
        finish_reason=None,
        stop_reason="client_disconnect",
        generated_text_chars=100,
        generated_reasoning_chars=0,
        had_completed_tool_results_before_stream=True,
    )


def test_synthesizes_length_for_post_tool_stream_with_id_only_partial_tool_call():
    assert _should_synthesize_incomplete_stream_length(
        response_tool_calls=[{"id": "call-1", "function": {"name": "", "arguments": ""}}],
        finish_reason=None,
        stop_reason=None,
        generated_text_chars=125,
        generated_reasoning_chars=0,
        had_completed_tool_results_before_stream=True,
    )


def test_does_not_synthesize_length_for_meaningful_partial_tool_call():
    assert not _should_synthesize_incomplete_stream_length(
        response_tool_calls=[{"id": "call-1", "function": {"name": "agent_vm_create_file", "arguments": ""}}],
        finish_reason=None,
        stop_reason=None,
        generated_text_chars=125,
        generated_reasoning_chars=0,
        had_completed_tool_results_before_stream=True,
    )


def test_finalize_reasoning_only_stream_without_terminal_event():
    assert _should_finalize_reasoning_only_incomplete_stream(
        response_tool_calls=[],
        finish_reason=None,
        stop_reason=None,
        generated_text_chars=0,
        generated_reasoning_chars=784,
        had_completed_tool_results_before_stream=False,
    )


def test_does_not_finalize_reasoning_only_stream_when_terminal_or_visible_output_exists():
    assert not _should_finalize_reasoning_only_incomplete_stream(
        response_tool_calls=[],
        finish_reason=None,
        stop_reason="stop",
        generated_text_chars=0,
        generated_reasoning_chars=784,
        had_completed_tool_results_before_stream=False,
    )
    assert not _should_finalize_reasoning_only_incomplete_stream(
        response_tool_calls=[],
        finish_reason=None,
        stop_reason=None,
        generated_text_chars=1,
        generated_reasoning_chars=784,
        had_completed_tool_results_before_stream=False,
    )
    assert not _should_finalize_reasoning_only_incomplete_stream(
        response_tool_calls=[{"id": "call-1", "function": {"name": "lookup"}}],
        finish_reason=None,
        stop_reason=None,
        generated_text_chars=0,
        generated_reasoning_chars=784,
        had_completed_tool_results_before_stream=False,
    )


def test_continuation_followup_index_is_monotonic_across_retry_types():
    assert (
        _continuation_followup_index(
            length_continue_attempts=1,
            anomaly_retry_attempts=0,
        )
        == 0
    )
    assert (
        _continuation_followup_index(
            length_continue_attempts=2,
            anomaly_retry_attempts=0,
        )
        == 1
    )
    assert (
        _continuation_followup_index(
            length_continue_attempts=2,
            anomaly_retry_attempts=1,
        )
        == 2
    )


def test_retryable_chat_completion_error_detects_503_jsonresponse():
    response = JSONResponse(
        status_code=503,
        content={"error": {"message": "Service unavailable", "code": "503"}},
    )
    assert _is_retryable_chat_completion_error(response)


def test_retryable_chat_completion_error_detects_server_disconnect_message():
    assert _is_retryable_chat_completion_error(
        {"error": {"message": "BedrockException - Server disconnected."}}
    )


def test_retryable_chat_completion_error_detects_bedrock_incomplete_stream_message():
    assert _is_retryable_chat_completion_error(
        {
            "error": {
                "message": (
                    "Bedrock Converse stream ended without message_stop, visible output, "
                    "tool use, or usage after 0 chunks (thinking_delta_events=0, "
                    "thinking_delta_chars=0); treating as incomplete_stream"
                )
            }
        }
    )


def test_empty_tool_call_terminal_requires_retry_only_when_no_call_exists():
    assert _is_empty_tool_call_terminal(
        finish_reason="tool_calls",
        stop_reason=None,
        response_tool_calls=[],
    )
    assert _is_empty_tool_call_terminal(
        finish_reason=None,
        stop_reason="tool_use",
        response_tool_calls=[],
    )
    assert not _is_empty_tool_call_terminal(
        finish_reason="tool_calls",
        stop_reason=None,
        response_tool_calls=[
            {
                "id": "toolu_1",
                "function": {"name": "lookup", "arguments": "{}"},
            }
        ],
    )
    assert not _is_empty_tool_call_terminal(
        finish_reason="stop",
        stop_reason="end_turn",
        response_tool_calls=[],
    )


def test_bedrock_malformed_tool_use_retries_once_then_surfaces_friendly_error():
    error = {
        "error": {
            "code": "bedrock_malformed_tool_use",
            "message": (
                "Bedrock Converse bedrock_malformed_tool_use: "
                "stopReason=tool_use was emitted without a toolUse content block"
            ),
        }
    }

    assert _is_bedrock_malformed_tool_use_error(
        error["error"]["message"]
    )
    assert (
        _retryable_chat_completion_error_reason(error)
        == "bedrock_malformed_tool_use"
    )
    assert _should_retry_stream_error_event(
        error["error"],
        tool_calls_queued_at_attempt_start=1,
        current_tool_calls_queued=1,
    )
    max_attempts = _get_transient_chat_completion_retry_max_attempts(error)
    assert max_attempts == 2
    assert _should_retry_chat_completion_attempt(
        error, attempt=1, max_attempts=max_attempts
    )
    assert not _should_retry_chat_completion_attempt(
        error, attempt=2, max_attempts=max_attempts
    )
    assert (
        _terminal_stop_reason_for_chat_completion_error(error)
        == "malformed_tool_use"
    )
    assert _format_error_message(error["error"]["message"]) == (
        "The model provider ended the response before producing its requested "
        "tool call. Please retry."
    )


def test_retryable_chat_completion_error_detects_bedrock_stream_inactive_message():
    assert _is_retryable_chat_completion_error(
        {"error": {"message": "Bedrock stream inactive for more than 30000ms"}}
    )


def test_retryable_chat_completion_error_detects_bedrock_unexpected_processing_error():
    error = {
        "error": {
            "message": (
                "The system encountered an unexpected error during processing. "
                "Try your request again."
            )
        }
    }

    assert _is_retryable_chat_completion_error(error)
    assert (
        _retryable_chat_completion_error_reason(error)
        == "bedrock_unexpected_processing_error"
    )


def test_bedrock_unexpected_processing_error_uses_generic_retry_budget_and_stops_at_exhaustion():
    error = {
        "message": (
            "The system encountered an unexpected error during processing. "
            "Try your request again."
        )
    }
    max_attempts = _get_transient_chat_completion_retry_max_attempts(error)

    assert max_attempts == 4
    assert _should_retry_chat_completion_attempt(
        error, attempt=3, max_attempts=max_attempts
    )
    assert not _should_retry_chat_completion_attempt(
        error, attempt=4, max_attempts=max_attempts
    )


def test_bedrock_stream_inactive_retry_budget_uses_bedrock_default(monkeypatch):
    monkeypatch.delenv(
        "OPENWEBUI_TRANSIENT_CHAT_COMPLETION_BEDROCK_STREAM_INACTIVE_RETRY_MAX_ATTEMPTS",
        raising=False,
    )
    monkeypatch.delenv("OPENWEBUI_TRANSIENT_CHAT_COMPLETION_RETRY_MAX_ATTEMPTS", raising=False)

    assert (
        _get_transient_chat_completion_retry_max_attempts(
            {"error": {"message": "Bedrock stream inactive for more than 30000ms"}}
        )
        == 8
    )


def test_bedrock_stream_inactive_retry_budget_env_only_changes_bedrock(monkeypatch):
    monkeypatch.setenv(
        "OPENWEBUI_TRANSIENT_CHAT_COMPLETION_BEDROCK_STREAM_INACTIVE_RETRY_MAX_ATTEMPTS",
        "10",
    )
    monkeypatch.delenv("OPENWEBUI_TRANSIENT_CHAT_COMPLETION_RETRY_MAX_ATTEMPTS", raising=False)

    assert (
        _get_transient_chat_completion_retry_max_attempts(
            {"error": {"message": "Bedrock stream inactive for more than 30000ms"}}
        )
        == 10
    )
    assert _get_transient_chat_completion_retry_max_attempts(
        {"error": {"message": "service unavailable"}}
    ) == 4


def test_bedrock_stream_inactive_retry_budget_ignores_invalid_env(monkeypatch):
    monkeypatch.setenv(
        "OPENWEBUI_TRANSIENT_CHAT_COMPLETION_BEDROCK_STREAM_INACTIVE_RETRY_MAX_ATTEMPTS",
        "0",
    )
    assert (
        _get_transient_chat_completion_retry_max_attempts(
            {"error": {"message": "Bedrock stream inactive for more than 30000ms"}}
        )
        == 8
    )


def test_generic_transient_retry_budget_stays_generic_default(monkeypatch):
    monkeypatch.delenv(
        "OPENWEBUI_TRANSIENT_CHAT_COMPLETION_BEDROCK_STREAM_INACTIVE_RETRY_MAX_ATTEMPTS",
        raising=False,
    )
    monkeypatch.delenv("OPENWEBUI_TRANSIENT_CHAT_COMPLETION_RETRY_MAX_ATTEMPTS", raising=False)

    assert _get_transient_chat_completion_retry_max_attempts(
        {"error": {"message": "HTTP error 503: service unavailable"}}
    ) == 4


def test_ultra_request_retry_budget_is_single_attempt():
    error = {"error": {"message": "HTTP error 502: service unavailable"}}

    assert (
        _get_chat_completion_request_retry_max_attempts(
            error,
            {"reasoning_effort": "ultra"},
        )
        == 1
    )
    assert (
        _get_chat_completion_request_retry_max_attempts(
            error,
            {"params": {"reasoning_effort": "ultra"}},
        )
        == 1
    )
    assert (
        _get_chat_completion_request_retry_max_attempts(
            error,
            {"reasoning_effort": "max"},
        )
        == 4
    )


def test_process_chat_response_uses_request_aware_retry_budget_at_every_seam():
    tree = ast.parse(
        MIDDLEWARE_PATH.read_text(encoding="utf-8"),
        filename=str(MIDDLEWARE_PATH),
    )
    process_chat_response = next(
        node
        for node in tree.body
        if isinstance(node, ast.AsyncFunctionDef)
        and node.name == "process_chat_response"
    )
    calls = [
        node
        for node in ast.walk(process_chat_response)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "_get_chat_completion_request_retry_max_attempts"
    ]

    assert len(calls) == 3
    assert sorted(ast.unparse(call.args[1]) for call in calls) == [
        "form_data",
        "request_form_data",
        "request_form_data",
    ]


def test_inline_reasoning_capture_and_replay_scrub_wiring():
    tree = ast.parse(
        MIDDLEWARE_PATH.read_text(encoding="utf-8"),
        filename=str(MIDDLEWARE_PATH),
    )
    process_chat_response = next(
        node
        for node in tree.body
        if isinstance(node, ast.AsyncFunctionDef)
        and node.name == "process_chat_response"
    )

    # The streaming split must run with cross-delta line-start capture wired
    # in (the Gemini literal-<think> leak fix) alongside the existing kwargs.
    split_calls = [
        node
        for node in ast.walk(process_chat_response)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "_split_inline_reasoning_sections"
    ]
    assert len(split_calls) == 1
    split_keywords = {keyword.arg for keyword in split_calls[0].keywords}
    assert {
        "allow_unmatched_start",
        "require_line_start",
        "allow_unmatched_start_at_line_start",
        "delta_at_line_start",
    } <= split_keywords

    # Replay transcripts are scrubbed of leaked literal think sections at all
    # three choke points: block replay, legacy plain-content replay, and the
    # tool-followup serializer.
    scrub_parents = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for call in ast.walk(node):
                if (
                    isinstance(call, ast.Call)
                    and isinstance(call.func, ast.Name)
                    and call.func.id
                    == "_remove_complete_inline_reasoning_sections"
                ):
                    scrub_parents.add(node.name)
                    break
    assert {
        "_serialize_replay_text_blocks",
        "reconstruct_anthropic_format",
        "serialize_replay_blocks",
    } <= scrub_parents


def test_retryable_stream_error_event_is_retried_before_tool_execution():
    assert _should_retry_stream_error_event(
        {"message": "Bedrock stream inactive for more than 30000ms"},
        tool_calls_queued_at_attempt_start=0,
        current_tool_calls_queued=0,
    )


def test_retryable_stream_error_event_can_retry_after_partial_output_without_tool_execution():
    assert _should_retry_stream_error_event(
        {"message": "Bedrock stream inactive for more than 30000ms"},
        tool_calls_queued_at_attempt_start=2,
        current_tool_calls_queued=2,
    )


def test_retryable_stream_error_event_is_not_retried_after_tool_execution_queue_handoff():
    assert not _should_retry_stream_error_event(
        {"message": "Bedrock stream inactive for more than 30000ms"},
        tool_calls_queued_at_attempt_start=0,
        current_tool_calls_queued=1,
    )
    assert not _should_retry_stream_error_event(
        {"message": "Bedrock stream inactive for more than 30000ms"},
        tool_calls_queued_at_attempt_start=2,
        current_tool_calls_queued=1,
    )


def test_stream_error_event_preserves_non_retryable_errors():
    assert not _should_retry_stream_error_event(
        {
            "message": (
                "Error in Bedrock handling: ValidationException: The content field "
                "in the Message object at messages.193 is empty. Add a ContentBlock "
                "object to the content field and try again."
            )
        },
        tool_calls_queued_at_attempt_start=0,
        current_tool_calls_queued=0,
    )


def test_stream_attempt_snapshot_rollback_discards_partial_tool_call_and_keeps_prior_results():
    prior_content_blocks = [
        {"type": "text", "content": "Existing answer.\n"},
        {
            "type": "tool_calls",
            "content": [
                {
                    "id": "tooluse_done",
                    "function": {"name": "agent_vm_bash", "arguments": "{}"},
                }
            ],
            "results": [{"tool_call_id": "tooluse_done", "content": "ok"}],
            "started_at": 10,
            "ended_at": 11,
        },
        {"type": "text", "content": ""},
    ]

    snapshot = _build_stream_attempt_snapshot(
        content="Existing answer.\n",
        content_blocks=prior_content_blocks,
        last_finish_reason=None,
        last_stop_reason=None,
        last_completion_tokens=12,
        continuation_seam_deltas=["Existing answer.\n"],
        streaming_tool_calls_block_index=None,
        tool_calls_queue_len=0,
    )

    mutated_blocks = prior_content_blocks
    mutated_blocks[-1]["content"] = "partial retry text"
    mutated_blocks.append(
        {
            "type": "reasoning",
            "content": "partial thinking",
            "started_at": 20,
        }
    )
    mutated_blocks.append(
        {
            "type": "tool_calls",
            "content": [
                {
                    "id": "tooluse_partial",
                    "function": {
                        "name": "agent_vm_python",
                        "arguments": '{"script"',
                    },
                }
            ],
            "streaming_preview": True,
        }
    )

    restored = _restore_stream_attempt_snapshot(snapshot)

    assert restored["content"] == "Existing answer.\n"
    assert restored["last_completion_tokens"] == 12
    assert restored["continuation_seam_deltas"] == ["Existing answer.\n"]
    assert restored["streaming_tool_calls_block_index"] is None
    assert restored["content_blocks"][-1] == {"type": "text", "content": ""}
    assert _tool_calls_block_has_complete_results(restored["content_blocks"][1])
    assert "tooluse_partial" not in repr(restored["content_blocks"])
    assert "agent_vm_python" not in repr(restored["content_blocks"])


def test_retryable_chat_completion_error_does_not_retry_empty_bedrock_message_validation():
    assert not _is_retryable_chat_completion_error(
        {
            "error": {
                "message": (
                    "Error in Bedrock handling: ValidationException: The content field "
                    "in the Message object at messages.193 is empty. Add a ContentBlock "
                    "object to the content field and try again."
                )
            }
        }
    )


def test_retryable_chat_completion_error_does_not_retry_multimodal_unsupported_rejection():
    # Deterministic Jupiter security-stack rejection (PORTICO-156): retrying can
    # never succeed, even when the upstream wraps it in a retryable status.
    assert not _is_retryable_chat_completion_error(
        {
            "status_code": 500,
            "error": {
                "message": (
                    "multimodal content (images, audio, video) is not supported "
                    "in the current MVP"
                )
            },
        }
    )


def test_transient_retry_delay_is_exponential():
    assert _get_transient_chat_completion_retry_delay_seconds(1) == 1.0
    assert _get_transient_chat_completion_retry_delay_seconds(2) == 2.0
    assert _get_transient_chat_completion_retry_delay_seconds(4) == 8.0


def test_retryable_tool_execution_error_detects_http_error_text():
    assert _is_retryable_tool_execution_error(
        'HTTP error 500: {"message":"tool call failed","authorization_url":null}'
    )


def test_retryable_tool_execution_error_does_not_retry_oauth_reauthorization_failures():
    assert not _is_retryable_tool_execution_error(
        'HTTP error 401: {"message":"OAuth re-authorization required","authorization_url":"https://secure.example.invalid/oauth/v2/authorize","server_id":"data-plat-mcp","oauth_recovery_required":true,"force_auth_recommended":true}'
    )


def test_retryable_tool_execution_result_detects_transient_http_error_dict():
    assert _is_retryable_tool_execution_result(
        {
            "error": (
                'HTTP error 502: {"message":"failed to connect sse server '
                '\'mcp-atlassian\'","authorization_url":null}'
            )
        }
    )


def test_retryable_tool_execution_result_does_not_retry_structured_oauth_failures():
    assert not _is_retryable_tool_execution_result(
        {
            "error": {
                "message": "OAuth re-authorization required",
                "authorization_url": "https://secure.example.invalid/oauth/v2/authorize",
                "server_id": "data-plat-mcp",
                "oauth_recovery_required": True,
                "force_auth_recommended": True,
                "status_code": 401,
            }
        }
    )


def test_retryable_tool_execution_result_ignores_non_retryable_validation_error():
    assert not _is_retryable_tool_execution_result(
        {"error": 'HTTP error 400: {"message":"validation failed"}'}
    )


def test_transient_tool_retry_delay_is_exponential():
    assert _get_transient_tool_execution_retry_delay_seconds(1) == 0.5
    assert _get_transient_tool_execution_retry_delay_seconds(2) == 1.0
    assert _get_transient_tool_execution_retry_delay_seconds(4) == 2.0
