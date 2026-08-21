from pathlib import Path
import ast
import copy
from typing import Any, Optional


MIDDLEWARE_PATH = (
    Path(__file__).resolve().parents[1]
    / "src"
    / "patches"
    / "backend"
    / "open_webui"
    / "utils"
    / "middleware.py"
)


class _FakeLog:
    def info(self, *args, **kwargs):
        return None

    def warning(self, *args, **kwargs):
        return None


def _load_followup_helpers():
    source = MIDDLEWARE_PATH.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(MIDDLEWARE_PATH))
    wanted_names = {
        "_debug_request_metadata_snapshot",
        "_llm_debug_usage_to_int",
        "_normalize_llm_debug_usage",
        "_user_message_anchor_updates",
        "_coerce_tool_ids",
        "_extract_tool_server_id",
        "_merge_tool_ids",
        "_sanitize_replayed_tool_history_messages",
        "_ensure_replay_safe_tool_payload",
        "_strip_replayed_model_system_prompt",
        "_ensure_internal_request_system_prompt_placeholder",
        "_openapi_has_callable_tool_paths",
        "_server_status_is_tool_ready",
        "_build_dynamic_tool_starting_system_message",
    }
    selected_nodes = [
        node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name in wanted_names
    ]

    namespace = {
        "Any": Any,
        "Optional": Optional,
        "copy": copy,
        "log": _FakeLog(),
        "branch_has_replayed_tool_history": lambda _messages: False,
        "_rebuild_followup_function_tools_payload": lambda **_kwargs: [],
    }
    exec(
        compile(ast.Module(body=selected_nodes, type_ignores=[]), str(MIDDLEWARE_PATH), "exec"),
        namespace,
    )
    return namespace


HELPERS = _load_followup_helpers()
_debug_request_metadata_snapshot = HELPERS["_debug_request_metadata_snapshot"]
_normalize_llm_debug_usage = HELPERS["_normalize_llm_debug_usage"]
_user_message_anchor_updates = HELPERS["_user_message_anchor_updates"]
_coerce_tool_ids = HELPERS["_coerce_tool_ids"]
_extract_tool_server_id = HELPERS["_extract_tool_server_id"]
_merge_tool_ids = HELPERS["_merge_tool_ids"]
_sanitize_replayed_tool_history_messages = HELPERS[
    "_sanitize_replayed_tool_history_messages"
]
_ensure_replay_safe_tool_payload = HELPERS["_ensure_replay_safe_tool_payload"]
_strip_replayed_model_system_prompt = HELPERS["_strip_replayed_model_system_prompt"]
_ensure_internal_request_system_prompt_placeholder = HELPERS[
    "_ensure_internal_request_system_prompt_placeholder"
]
_openapi_has_callable_tool_paths = HELPERS["_openapi_has_callable_tool_paths"]
_server_status_is_tool_ready = HELPERS["_server_status_is_tool_ready"]
_build_dynamic_tool_starting_system_message = HELPERS[
    "_build_dynamic_tool_starting_system_message"
]


def test_debug_request_metadata_snapshot_keeps_only_relevant_non_none_fields():
    snapshot = _debug_request_metadata_snapshot(
        {
            "user_id": "user-1",
            "chat_id": "chat-1",
            "session_id": "session-1",
            "message_id": "assistant-1",
            "debug_request_id": "dbg-1",
            "upstream_request_id": "up-1",
            "task": None,
            "request_phase": "tool_followup",
            "followup_index": 2,
            "outer_message_id": "assistant-1",
            "trigger_message_id": "user-1",
            "transcript_anchor_kind": "assistant_tool_block",
            "transcript_anchor_message_id": "assistant-1",
            "transcript_anchor_tool_block_index": 1,
            "ignored": "value",
        }
    )

    assert snapshot == {
        "user_id": "user-1",
        "chat_id": "chat-1",
        "session_id": "session-1",
        "message_id": "assistant-1",
        "debug_request_id": "dbg-1",
        "upstream_request_id": "up-1",
        "request_phase": "tool_followup",
        "followup_index": 2,
        "outer_message_id": "assistant-1",
        "trigger_message_id": "user-1",
        "transcript_anchor_kind": "assistant_tool_block",
        "transcript_anchor_message_id": "assistant-1",
        "transcript_anchor_tool_block_index": 1,
    }


def test_normalize_llm_debug_usage_handles_provider_variants_and_cache_fallbacks():
    normalized = _normalize_llm_debug_usage(
        {
            "inputTokens": "70",
            "output_tokens": "11",
            "totalTokens": "",
            "prompt_tokens_details": {
                "cached_read_tokens": "67",
                "cache_creation_tokens": "4",
            },
        }
    )

    assert normalized == {
        "prompt_tokens": 70,
        "completion_tokens": 11,
        "total_tokens": 81,
        "cached_tokens": 67,
        "cache_read_input_tokens": 67,
        "cache_creation_input_tokens": 4,
        "cache_write_input_tokens": 4,
    }


def test_normalize_llm_debug_usage_gracefully_handles_invalid_inputs():
    assert _normalize_llm_debug_usage(None) == {}
    assert _normalize_llm_debug_usage("bad") == {}
    assert _normalize_llm_debug_usage({"prompt_tokens": "not-an-int"}) == {
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0,
    }


def test_normalize_llm_debug_usage_passes_through_ultra_context_tokens():
    # ULTRA multi-agent usage reports cumulative prompt_tokens for spend plus
    # a non-cumulative context_tokens for the last round's true occupancy —
    # the occupancy field must survive normalization (it feeds the context
    # gauge's history fallback).
    normalized = _normalize_llm_debug_usage(
        {"prompt_tokens": 900000, "completion_tokens": 500, "context_tokens": 61000}
    )
    assert normalized["context_tokens"] == 61000
    assert normalized["prompt_tokens"] == 900000

    camel = _normalize_llm_debug_usage(
        {"prompt_tokens": 10, "completion_tokens": 1, "contextTokens": 2500}
    )
    assert camel["context_tokens"] == 2500

    # Absent or zero context_tokens must not synthesize the key.
    assert "context_tokens" not in _normalize_llm_debug_usage({"prompt_tokens": 10})
    assert "context_tokens" not in _normalize_llm_debug_usage(
        {"prompt_tokens": 10, "context_tokens": 0}
    )


def test_normalize_llm_debug_usage_prefers_explicit_cache_fields_over_nested_details():
    normalized = _normalize_llm_debug_usage(
        {
            "prompt_tokens": 20,
            "completion_tokens": 5,
            "cached_tokens": "3",
            "cache_read_input_tokens": "2",
            "cache_write_input_tokens": "7",
            "prompt_tokens_details": {
                "cached_tokens": "99",
                "cache_read_tokens": "88",
                "cached_write_tokens": "77",
            },
        }
    )

    assert normalized == {
        "prompt_tokens": 20,
        "completion_tokens": 5,
        "total_tokens": 25,
        "cached_tokens": 3,
        "cache_read_input_tokens": 2,
        "cache_creation_input_tokens": 7,
        "cache_write_input_tokens": 7,
    }


def test_normalize_llm_debug_usage_maps_gemini_cached_content_tokens_to_cache_reads():
    normalized = _normalize_llm_debug_usage(
        {
            "prompt_tokens": 100,
            "completion_tokens": 6,
            "cachedContentTokenCount": "42",
        }
    )

    assert normalized == {
        "prompt_tokens": 100,
        "completion_tokens": 6,
        "total_tokens": 106,
        "cached_tokens": 42,
        "cache_read_input_tokens": 42,
    }


def test_normalize_llm_debug_usage_does_not_synthesize_reads_from_write_only_details():
    normalized = _normalize_llm_debug_usage(
        {
            "prompt_tokens": 20,
            "completion_tokens": 5,
            "prompt_tokens_details": {
                "cached_tokens": "11",
                "cached_write_tokens": "11",
            },
        }
    )

    assert normalized == {
        "prompt_tokens": 20,
        "completion_tokens": 5,
        "total_tokens": 25,
        "cache_creation_input_tokens": 11,
        "cache_write_input_tokens": 11,
    }


def test_coerce_and_merge_tool_ids_preserve_order_and_dedupe():
    assert _coerce_tool_ids(None) == []
    assert _coerce_tool_ids("server:skills") == ["server:skills"]
    assert _coerce_tool_ids(("server:skills", "server:agent-vm")) == [
        "server:skills",
        "server:agent-vm",
    ]

    assert _merge_tool_ids(
        ["server:mcp-assistant", "server:skills"],
        ["server:skills", "server:google_workspace", "server:mcp-assistant", "server:agent-vm"],
    ) == [
        "server:mcp-assistant",
        "server:skills",
        "server:google_workspace",
        "server:agent-vm",
    ]


def test_user_message_anchor_updates_target_inserted_steer_message():
    assert _user_message_anchor_updates("user-steer-1") == {
        "trigger_message_id": "user-steer-1",
        "transcript_anchor_kind": "user_message",
        "transcript_anchor_message_id": "user-steer-1",
        "transcript_anchor_tool_block_index": None,
    }
    assert _user_message_anchor_updates(None) == {
        "transcript_anchor_kind": "background",
        "transcript_anchor_message_id": None,
        "transcript_anchor_tool_block_index": None,
    }


def test_extract_tool_server_id_handles_bare_server_and_mcp_prefixes():
    assert _extract_tool_server_id("") == ""
    assert _extract_tool_server_id("server:mcp:google_workspace") == "google_workspace"
    assert _extract_tool_server_id("server:agent-vm") == "agent-vm"
    assert _extract_tool_server_id("skills") == "skills"


def test_build_dynamic_tool_starting_system_message_uses_normalized_server_labels():
    message = _build_dynamic_tool_starting_system_message(
        ["server:google_workspace", "server:mcp:agent-vm"]
    )

    assert "<integration_starting>" in message
    assert "server:google_workspace" in message
    assert "server:agent-vm" in message
    assert "Do not call these tools in this response." in message


def test_openapi_has_callable_tool_paths_ignores_oauth_only_specs():
    assert _openapi_has_callable_tool_paths(None) is False
    assert _openapi_has_callable_tool_paths({"paths": {"/oauth/authorize": {}}}) is False
    assert (
        _openapi_has_callable_tool_paths(
            {"paths": {"/oauth/token": {}, "/calendar/events": {}}}
        )
        is True
    )


def test_server_status_is_tool_ready_accepts_tool_ready_phase_or_healthy_tool_count():
    assert _server_status_is_tool_ready(None) is False
    assert _server_status_is_tool_ready({"readiness_phase": "tool_ready"}) is True
    assert _server_status_is_tool_ready({"healthy": True, "tools_count": "2"}) is True
    assert _server_status_is_tool_ready({"healthy": True, "tools_count": 0}) is False


def test_sanitize_replayed_tool_history_messages_drops_tool_roles_and_tool_content_parts():
    sanitized_messages, dropped_call_ids, dropped_tool_names = (
        _sanitize_replayed_tool_history_messages(
            [
                {"role": "system", "content": "sys"},
                {
                    "role": "assistant",
                    "content": "Let me activate the skill.",
                    "tool_calls": [
                        {
                            "id": "call-skill",
                            "function": {"name": "skills_activate_skill"},
                        }
                    ],
                },
                {
                    "role": "assistant",
                    "content": [
                        {"type": "text", "text": "Visible"},
                        {"type": "toolUse", "id": "toolu_1"},
                        {"type": "toolResult", "content": "Hidden"},
                        {"type": "input_text", "text": "Still visible"},
                        "raw-string",
                    ],
                },
                {
                    "role": "assistant",
                    "content": [
                        {"type": "tool_use", "id": "toolu_2"},
                        {"type": "tool_result", "content": "also hidden"},
                    ],
                },
                {
                    "role": "tool",
                    "tool_call_id": "call-skill",
                    "content": '{"success": true}',
                },
                {"role": "user", "content": "continue"},
            ]
        )
    )

    assert sanitized_messages == [
        {"role": "system", "content": "sys"},
        {"role": "assistant", "content": "Let me activate the skill."},
        {
            "role": "assistant",
            "content": [
                {"type": "text", "text": "Visible"},
                {"type": "input_text", "text": "Still visible"},
                "raw-string",
            ],
        },
        {"role": "user", "content": "continue"},
    ]
    assert dropped_call_ids == ["call-skill"]
    assert dropped_tool_names == ["skills_activate_skill"]


def test_strip_replayed_model_system_prompt_drops_leading_non_context_system_message_only():
    messages = [
        {"role": "system", "content": "# Portico - Your AI Assistant"},
        {"role": "system", "content": "<portico_context><static_context>...</static_context></portico_context>"},
        {"role": "system", "content": "<portico_context><dynamic_context>...</dynamic_context></portico_context>"},
        {"role": "user", "content": "Hello"},
    ]

    stripped = _strip_replayed_model_system_prompt(messages)

    assert stripped == messages[1:]


def test_strip_replayed_model_system_prompt_preserves_nonleading_and_context_system_messages():
    messages = [
        {"role": "system", "content": "<portico_context><static_context>...</static_context></portico_context>"},
        {"role": "system", "content": "request-local extra system message"},
        {"role": "assistant", "content": "Hi"},
    ]

    stripped = _strip_replayed_model_system_prompt(messages)

    assert stripped == messages


def test_ensure_internal_request_system_prompt_placeholder_inserts_empty_slot_zero():
    messages = [
        {"role": "system", "content": "<portico_context><static_context>...</static_context></portico_context>"},
        {"role": "system", "content": "<portico_context><dynamic_context>...</dynamic_context></portico_context>"},
        {"role": "user", "content": "Hello"},
    ]

    rewritten = _ensure_internal_request_system_prompt_placeholder(messages)

    assert rewritten[0] == {"role": "system", "content": ""}
    assert rewritten[1:] == messages
    assert messages[0]["content"].startswith("<portico_context>")


def test_ensure_internal_request_system_prompt_placeholder_preserves_existing_empty_slot_zero():
    messages = [
        {"role": "system", "content": ""},
        {"role": "system", "content": "<portico_context><static_context>...</static_context></portico_context>"},
        {"role": "system", "content": "<portico_context><dynamic_context>...</dynamic_context></portico_context>"},
    ]

    rewritten = _ensure_internal_request_system_prompt_placeholder(messages)

    assert rewritten == messages


def test_sanitize_replayed_tool_history_messages_drops_blank_assistant_content_without_mutating_input():
    original_messages = [
        {
            "role": "assistant",
            "content": "   ",
            "tool_calls": [
                {
                    "id": "call-1",
                    "function": {"name": "google_workspace_get_events"},
                }
            ],
        },
        {
            "role": "assistant",
            "content": [
                {"type": "toolUse", "id": "call-2"},
                {"type": "toolResult", "content": "hidden"},
            ],
        },
        {
            "role": "tool",
            "tool_call_id": "call-1",
            "content": '{"ok": true}',
        },
    ]
    snapshot = copy.deepcopy(original_messages)

    sanitized_messages, dropped_call_ids, dropped_tool_names = (
        _sanitize_replayed_tool_history_messages(original_messages)
    )

    assert sanitized_messages == []
    assert dropped_call_ids == ["call-1"]
    assert dropped_tool_names == ["google_workspace_get_events"]
    assert original_messages == snapshot


def test_ensure_replay_safe_tool_payload_noops_without_replayed_tool_history():
    form_data = {
        "messages": [{"role": "assistant", "content": "plain"}],
        "tools": [{"type": "function", "function": {"name": "keep_me"}}],
        "_tool_namespaces": {"skills": ["keep_me"]},
    }

    _ensure_replay_safe_tool_payload(form_data=form_data, metadata={"chat_id": "chat-1"})

    assert form_data == {
        "messages": [{"role": "assistant", "content": "plain"}],
        "tools": [{"type": "function", "function": {"name": "keep_me"}}],
        "_tool_namespaces": {"skills": ["keep_me"]},
    }


def test_ensure_replay_safe_tool_payload_prefers_rebuilt_tool_payload_when_available():
    original_branch_helper = HELPERS["branch_has_replayed_tool_history"]
    original_rebuild_helper = HELPERS["_rebuild_followup_function_tools_payload"]
    HELPERS["branch_has_replayed_tool_history"] = lambda _messages: True
    captured = {}

    def fake_rebuild_followup_function_tools_payload(**kwargs):
        captured.update(kwargs)
        return [{"type": "function", "function": {"name": "google_workspace_get_events"}}]

    HELPERS["_rebuild_followup_function_tools_payload"] = fake_rebuild_followup_function_tools_payload

    try:
        form_data = {
            "model": "atlas-opus",
            "messages": [
                {"role": "assistant", "content": "I will fetch your calendar."},
                {"role": "tool", "tool_call_id": "call-1", "content": "raw"},
            ],
        }
        metadata = {"chat_id": "chat-1", "tools": {"google_workspace_get_events": {"spec": {}}}}

        _ensure_replay_safe_tool_payload(form_data=form_data, metadata=metadata)

        assert captured["existing_tool_payloads"] == []
        assert captured["metadata_tools"] == metadata["tools"]
        assert captured["model_name"] == "atlas-opus"
        assert captured["chat_id"] == "chat-1"
        assert form_data["tools"] == [
            {"type": "function", "function": {"name": "google_workspace_get_events"}}
        ]
        assert form_data["messages"][1]["role"] == "tool"
    finally:
        HELPERS["branch_has_replayed_tool_history"] = original_branch_helper
        HELPERS["_rebuild_followup_function_tools_payload"] = original_rebuild_helper


def test_ensure_replay_safe_tool_payload_strips_replayed_tool_history_when_rebuild_fails():
    original_branch_helper = HELPERS["branch_has_replayed_tool_history"]
    original_rebuild_helper = HELPERS["_rebuild_followup_function_tools_payload"]
    HELPERS["branch_has_replayed_tool_history"] = lambda _messages: True
    HELPERS["_rebuild_followup_function_tools_payload"] = lambda **_kwargs: []

    try:
        form_data = {
            "model": "atlas-opus",
            "messages": [
                {
                    "role": "assistant",
                    "content": "I need to activate integrations.",
                    "tool_calls": [
                        {
                            "id": "call-1",
                            "function": {"name": "mcp_assistant_activate_integration"},
                        }
                    ],
                },
                {"role": "tool", "tool_call_id": "call-1", "content": '{"success": true}'},
                {"role": "user", "content": "continue"},
            ],
            "tools": [{"type": "function", "function": {"name": "old_tool"}}],
            "_tool_namespaces": {"mcp-assistant": ["old_tool"]},
        }

        _ensure_replay_safe_tool_payload(form_data=form_data, metadata={"chat_id": "chat-1"})

        assert form_data["messages"] == [
            {"role": "assistant", "content": "I need to activate integrations."},
            {"role": "user", "content": "continue"},
        ]
        assert "tools" not in form_data
        assert "_tool_namespaces" not in form_data
    finally:
        HELPERS["branch_has_replayed_tool_history"] = original_branch_helper
        HELPERS["_rebuild_followup_function_tools_payload"] = original_rebuild_helper
