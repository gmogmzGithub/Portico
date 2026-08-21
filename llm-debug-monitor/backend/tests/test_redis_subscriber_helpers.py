from backend import redis_subscriber as subscriber


def test_extract_event_metadata_prefers_top_level_then_metadata_then_raw_payload():
    event = {
        "upstream_request_id": "up-top",
        "debug_request_id": "dbg-top",
        "request_phase": "tool_followup",
        "followup_index": 7,
        "outer_message_id": "assistant-top",
        "trigger_message_id": "user-top",
        "transcript_anchor_kind": "assistant_tool_block",
        "transcript_anchor_message_id": "assistant-top",
        "transcript_anchor_tool_block_index": 3,
        "data": {
            "metadata": {
                "upstream_request_id": "up-meta",
                "debug_request_id": "dbg-meta",
                "request_phase": "initial",
                "followup_index": 1,
                "outer_message_id": "assistant-meta",
                "trigger_message_id": "user-meta",
                "transcript_anchor_kind": "user_message",
                "transcript_anchor_message_id": "user-meta",
                "transcript_anchor_tool_block_index": 1,
            },
            "raw_payload": {
                "metadata": {
                    "upstream_request_id": "up-payload",
                    "debug_request_id": "dbg-payload",
                }
            },
        },
    }

    assert subscriber._extract_upstream_request_id_from_event(event) == "up-top"
    assert subscriber._extract_debug_request_id_from_event(event) == "dbg-top"
    assert subscriber._extract_request_phase_from_event(event) == "tool_followup"
    assert subscriber._extract_followup_index_from_event(event) == 7
    assert subscriber._extract_outer_message_id_from_event(event) == "assistant-top"
    assert subscriber._extract_trigger_message_id_from_event(event) == "user-top"
    assert (
        subscriber._extract_transcript_anchor_kind_from_event(event)
        == "assistant_tool_block"
    )
    assert (
        subscriber._extract_transcript_anchor_message_id_from_event(event)
        == "assistant-top"
    )
    assert (
        subscriber._extract_transcript_anchor_tool_block_index_from_event(event) == 3
    )


def test_extract_event_metadata_falls_back_to_nested_metadata_and_parses_strings():
    event = {
        "data": {
            "metadata": {
                "upstream_request_id": "up-meta",
                "debug_request_id": "dbg-meta",
                "request_phase": "tool_followup",
                "followup_index": "4",
                "outer_message_id": "assistant-meta",
                "trigger_message_id": "user-meta",
                "transcript_anchor_kind": "assistant_tool_block",
                "transcript_anchor_message_id": "assistant-meta",
                "transcript_anchor_tool_block_index": "6",
            }
        }
    }

    assert subscriber._extract_upstream_request_id_from_event(event) == "up-meta"
    assert subscriber._extract_debug_request_id_from_event(event) == "dbg-meta"
    assert subscriber._extract_request_phase_from_event(event) == "tool_followup"
    assert subscriber._extract_followup_index_from_event(event) == 4
    assert subscriber._extract_outer_message_id_from_event(event) == "assistant-meta"
    assert subscriber._extract_trigger_message_id_from_event(event) == "user-meta"
    assert (
        subscriber._extract_transcript_anchor_kind_from_event(event)
        == "assistant_tool_block"
    )
    assert (
        subscriber._extract_transcript_anchor_message_id_from_event(event)
        == "assistant-meta"
    )
    assert (
        subscriber._extract_transcript_anchor_tool_block_index_from_event(event) == 6
    )


def test_extract_event_metadata_falls_back_to_raw_payload_and_ignores_invalid_values():
    event = {
        "data": {
            "raw_payload": {
                "metadata": {
                    "upstream_request_id": "up-payload",
                    "debug_request_id": "dbg-payload",
                    "followup_index": "not-an-int",
                    "transcript_anchor_kind": "not-valid",
                    "transcript_anchor_tool_block_index": "",
                }
            }
        }
    }

    assert subscriber._extract_upstream_request_id_from_event(event) == "up-payload"
    assert subscriber._extract_debug_request_id_from_event(event) == "dbg-payload"
    assert subscriber._extract_followup_index_from_event(event) is None
    assert subscriber._extract_transcript_anchor_kind_from_event(event) is None
    assert subscriber._extract_transcript_anchor_tool_block_index_from_event(event) is None


def test_extract_event_metadata_reads_transformed_payload_metadata_and_preserves_zero_indices():
    event = {
        "event_type": "llm_request_transformed",
        "data": {
            "payload": {
                "metadata": {
                    "upstream_request_id": "up-transformed",
                    "debug_request_id": "dbg-transformed",
                    "request_phase": "tool_followup",
                    "followup_index": 0,
                    "outer_message_id": "assistant-transformed",
                    "trigger_message_id": "user-transformed",
                    "transcript_anchor_kind": "assistant_tool_block",
                    "transcript_anchor_message_id": "assistant-transformed",
                    "transcript_anchor_tool_block_index": 0,
                    "task": "analysis",
                }
            }
        },
    }

    assert subscriber._extract_upstream_request_id_from_event(event) == "up-transformed"
    assert subscriber._extract_debug_request_id_from_event(event) == "dbg-transformed"
    assert subscriber._extract_task_name_from_event(event) == "analysis"
    assert subscriber._extract_request_phase_from_event(event) == "tool_followup"
    assert subscriber._extract_followup_index_from_event(event) == 0
    assert (
        subscriber._extract_outer_message_id_from_event(event)
        == "assistant-transformed"
    )
    assert (
        subscriber._extract_trigger_message_id_from_event(event)
        == "user-transformed"
    )
    assert (
        subscriber._extract_transcript_anchor_kind_from_event(event)
        == "assistant_tool_block"
    )
    assert (
        subscriber._extract_transcript_anchor_message_id_from_event(event)
        == "assistant-transformed"
    )
    assert (
        subscriber._extract_transcript_anchor_tool_block_index_from_event(event)
        == 0
    )


def test_find_request_by_identity_keeps_distinct_upstream_requests_separate():
    requests = {
        "up-1": {
            "request_id": "up-1",
            "debug_request_id": "dbg-shared",
            "upstream_request_id": "up-1",
        },
        "up-2": {
            "request_id": "up-2",
            "debug_request_id": "dbg-shared",
            "upstream_request_id": "up-2",
        },
    }

    assert subscriber._find_request_by_identity(requests, "up-1", "dbg-shared") is requests["up-1"]
    assert subscriber._find_request_by_identity(requests, "up-2", "dbg-shared") is requests["up-2"]
    assert subscriber._find_request_by_identity(requests, "up-3", "dbg-shared") is None


def test_find_request_by_identity_reuses_legacy_debug_shell_without_upstream_id():
    legacy = {
        "request_id": "dbg-legacy",
        "debug_request_id": "dbg-legacy",
        "upstream_request_id": None,
    }
    requests = {"dbg-legacy": legacy}

    assert (
        subscriber._find_request_by_identity(requests, "up-legacy", "dbg-legacy")
        is legacy
    )


def test_rekey_request_moves_existing_request_id_without_cloning():
    request = {"request_id": "dbg-1", "debug_request_id": "dbg-1"}
    requests = {"dbg-1": request}

    subscriber._rekey_request(requests, request, "up-1")

    assert "dbg-1" not in requests
    assert request["request_id"] == "up-1"


def test_update_request_identity_fills_missing_fields_without_overwriting_existing():
    request = {
        "message_id": "assistant-existing",
        "debug_request_id": "dbg-existing",
        "upstream_request_id": None,
        "task_name": None,
        "request_phase": None,
        "followup_index": None,
        "outer_message_id": None,
        "trigger_message_id": None,
        "transcript_anchor_kind": None,
        "transcript_anchor_message_id": None,
        "transcript_anchor_tool_block_index": None,
        "is_auxiliary": False,
    }

    subscriber._update_request_identity(
        request,
        message_id="assistant-new",
        debug_request_id="dbg-new",
        upstream_request_id="up-new",
        task_name="title_generation",
        request_phase="tool_followup",
        followup_index=5,
        outer_message_id="assistant-new",
        trigger_message_id="user-new",
        transcript_anchor_kind="background",
        transcript_anchor_message_id="assistant-new",
        transcript_anchor_tool_block_index=2,
    )

    assert request["message_id"] == "assistant-existing"
    assert request["debug_request_id"] == "dbg-existing"
    assert request["upstream_request_id"] == "up-new"
    assert request["task_name"] == "title_generation"
    assert request["request_phase"] == "tool_followup"
    assert request["followup_index"] == 5
    assert request["outer_message_id"] == "assistant-new"
    assert request["trigger_message_id"] == "user-new"
    assert request["transcript_anchor_kind"] == "background"
    assert request["transcript_anchor_message_id"] == "assistant-new"
    assert request["transcript_anchor_tool_block_index"] == 2
    assert request["is_auxiliary"] is True

    subscriber._update_request_identity(
        request,
        upstream_request_id="up-overwrite",
        task_name="emoji_generation",
        request_phase="initial",
        followup_index=1,
        transcript_anchor_kind="user_message",
        transcript_anchor_tool_block_index=9,
    )

    assert request["upstream_request_id"] == "up-new"
    assert request["task_name"] == "title_generation"
    assert request["request_phase"] == "tool_followup"
    assert request["followup_index"] == 5
    assert request["transcript_anchor_kind"] == "background"
    assert request["transcript_anchor_tool_block_index"] == 2


def test_create_request_shell_prefers_upstream_request_id_then_debug_request_id_then_event_id():
    shell = subscriber._create_request_shell(
        {"event_id": "event-1", "chat_id": "chat-1", "session_id": "session-1", "timestamp": "2026-03-27T10:00:00Z"},
        None,
        debug_request_id="dbg-1",
        upstream_request_id="up-1",
        task_name="title_generation",
        request_phase="tool_followup",
        followup_index=2,
        outer_message_id="assistant-1",
        trigger_message_id="user-1",
        transcript_anchor_kind="background",
        raw_payload={"raw": True},
    )

    assert shell["request_id"] == "up-1"
    assert shell["model"] == "unknown"
    assert shell["debug_request_id"] == "dbg-1"
    assert shell["is_auxiliary"] is True
    assert shell["raw_payload"] == {"raw": True}

    legacy_shell = subscriber._create_request_shell(
        {"event_id": "event-2", "chat_id": "chat-2", "session_id": "session-2", "timestamp": "2026-03-27T10:05:00Z"},
        "Atlas Opus 4.6",
        debug_request_id="dbg-2",
    )
    assert legacy_shell["request_id"] == "dbg-2"

    fallback_shell = subscriber._create_request_shell(
        {"event_id": "event-3", "chat_id": "chat-3", "session_id": "session-3", "timestamp": "2026-03-27T10:10:00Z"},
        "Atlas Opus 4.6",
    )
    assert fallback_shell["request_id"] == "event-3"


def test_request_matches_transformed_event_respects_identity_precedence():
    request = {
        "upstream_request_id": "up-1",
        "debug_request_id": "dbg-1",
        "message_id": "assistant-1",
        "model": "Atlas Opus 4.6",
        "base_model": "Atlas Opus 4.6",
    }

    assert subscriber._request_matches_transformed_event(
        request,
        "Atlas Opus 4.6",
        "assistant-1",
        "up-1",
        "dbg-mismatch",
    )
    assert not subscriber._request_matches_transformed_event(
        request,
        "Atlas Opus 4.6",
        "assistant-1",
        "up-mismatch",
        "dbg-1",
    )

    no_upstream = {
        "debug_request_id": "dbg-2",
        "message_id": "assistant-2",
        "model": "Atlas Haiku 4.5",
    }
    assert subscriber._request_matches_transformed_event(
        no_upstream,
        "Atlas Haiku 4.5",
        "assistant-2",
        None,
        "dbg-2",
    )

    no_ids = {"message_id": "assistant-3", "model": "gpt-5-mini", "base_model": None}
    assert subscriber._request_matches_transformed_event(
        no_ids,
        "gpt-5-mini",
        "assistant-3",
        None,
        None,
    )
