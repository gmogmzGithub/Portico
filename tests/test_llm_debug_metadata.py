from pathlib import Path
import importlib.util


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "src"
    / "patches"
    / "backend"
    / "open_webui"
    / "utils"
    / "llm_debug.py"
)


def _load_module():
    spec = importlib.util.spec_from_file_location("tested_llm_debug", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


LLM_DEBUG = _load_module()


def test_normalize_task_name_trims_and_handles_non_strings():
    assert LLM_DEBUG.normalize_task_name(None) is None
    assert LLM_DEBUG.normalize_task_name("  title_generation  ") == "title_generation"
    assert LLM_DEBUG.normalize_task_name("   ") is None
    assert LLM_DEBUG.normalize_task_name(42) == "42"


def test_is_auxiliary_task_name_matches_known_tasks_after_trim_only():
    assert LLM_DEBUG.is_auxiliary_task_name(" title_generation ")
    assert LLM_DEBUG.is_auxiliary_task_name("autocomplete_generation")
    assert not LLM_DEBUG.is_auxiliary_task_name("TITLE_GENERATION")
    assert not LLM_DEBUG.is_auxiliary_task_name("not_a_task")


def test_ensure_debug_request_metadata_generates_and_preserves_ids(monkeypatch):
    monkeypatch.setattr(LLM_DEBUG, "generate_debug_request_id", lambda: "dbg-new")
    monkeypatch.setattr(LLM_DEBUG, "generate_upstream_request_id", lambda: "up-new")

    generated = LLM_DEBUG.ensure_debug_request_metadata({})
    assert generated["debug_request_id"] == "dbg-new"
    assert generated["upstream_request_id"] == "up-new"

    preserved = LLM_DEBUG.ensure_debug_request_metadata(
        {
            "debug_request_id": "dbg-existing",
            "upstream_request_id": "up-existing",
        }
    )
    assert preserved["debug_request_id"] == "dbg-existing"
    assert preserved["upstream_request_id"] == "up-existing"

    forced = LLM_DEBUG.ensure_debug_request_metadata(
        {
            "debug_request_id": "dbg-existing",
            "upstream_request_id": "up-existing",
        },
        force_new_debug_request_id=True,
        force_new_upstream_request_id=True,
    )
    assert forced["debug_request_id"] == "dbg-new"
    assert forced["upstream_request_id"] == "up-new"


def test_ensure_debug_request_metadata_defaults_foreground_phase_without_overwrite(
    monkeypatch,
):
    monkeypatch.setattr(LLM_DEBUG, "generate_debug_request_id", lambda: "dbg-new")
    monkeypatch.setattr(LLM_DEBUG, "generate_upstream_request_id", lambda: "up-new")
    monkeypatch.setattr(LLM_DEBUG, "generate_prompt_submitted_at_ms", lambda: 1234)

    generated = LLM_DEBUG.ensure_debug_request_metadata(
        {},
        default_request_phase=LLM_DEBUG.FOREGROUND_REQUEST_PHASE,
    )
    assert generated["request_phase"] == "initial"
    assert generated["prompt_submitted_at_ms"] == 1234

    explicit = LLM_DEBUG.ensure_debug_request_metadata(
        {
            "request_phase": "tool_followup",
            "prompt_submitted_at_ms": 1000,
        },
        default_request_phase=LLM_DEBUG.FOREGROUND_REQUEST_PHASE,
    )
    assert explicit["request_phase"] == "tool_followup"
    assert explicit["prompt_submitted_at_ms"] == 1000


def test_build_auxiliary_task_metadata_forces_new_ids_and_background_anchor(
    monkeypatch,
):
    monkeypatch.setattr(LLM_DEBUG, "generate_debug_request_id", lambda: "dbg-aux")
    monkeypatch.setattr(LLM_DEBUG, "generate_upstream_request_id", lambda: "up-aux")
    monkeypatch.setattr(LLM_DEBUG, "generate_debug_message_id", lambda: "msg-aux")
    monkeypatch.setattr(LLM_DEBUG, "generate_prompt_submitted_at_ms", lambda: 2000)

    metadata = LLM_DEBUG.build_auxiliary_task_metadata(
        {
            "debug_request_id": "dbg-old",
            "upstream_request_id": "up-old",
            "message_id": "msg-old",
            "prompt_submitted_at_ms": 1000,
            "request_phase": "initial",
            "trigger_message_id": "user-1",
            "transcript_anchor_kind": "assistant_tool_block",
            "transcript_anchor_message_id": "assistant-1",
            "transcript_anchor_tool_block_index": 2,
            "user_id": "user-a",
        },
        task_name="title_generation",
        task_body={"prompt": "hello"},
        chat_id="chat-1",
    )

    assert metadata["debug_request_id"] == "dbg-aux"
    assert metadata["upstream_request_id"] == "up-aux"
    assert metadata["message_id"] == "msg-aux"
    assert metadata["prompt_submitted_at_ms"] == 2000
    assert metadata["origin_prompt_submitted_at_ms"] == 1000
    assert metadata["request_phase"] == "auxiliary_task"
    assert metadata["task"] == "title_generation"
    assert metadata["task_body"] == {"prompt": "hello"}
    assert metadata["chat_id"] == "chat-1"
    assert metadata["transcript_anchor_kind"] == "background"
    assert "trigger_message_id" not in metadata
    assert "transcript_anchor_message_id" not in metadata
    assert "transcript_anchor_tool_block_index" not in metadata
    assert metadata["user_id"] == "user-a"


def test_restore_auxiliary_task_metadata_restores_ids_and_anchor_metadata():
    restored = LLM_DEBUG.restore_auxiliary_task_metadata(
        {
            "message_id": "msg-live",
            "debug_request_id": "dbg-live",
            "upstream_request_id": "up-live",
            "prompt_submitted_at_ms": 9999,
            "origin_prompt_submitted_at_ms": 8888,
            "request_phase": "initial",
            "task": "old_task",
            "task_body": {"old": True},
            "chat_id": "chat-live",
            "user_id": "user-live",
        },
        {
            "user_id": "user-aux",
            "session_id": "session-aux",
            "message_id": "msg-aux",
            "debug_request_id": "dbg-aux",
            "upstream_request_id": "up-aux",
            "prompt_submitted_at_ms": 2222,
            "origin_prompt_submitted_at_ms": 1111,
            "request_phase": "auxiliary_task",
            "task": "title_generation",
            "task_body": {"prompt": "title"},
            "chat_id": "chat-aux",
            "transcript_anchor_kind": "background",
        },
        task_name="emoji_generation",
        task_body={"prompt": "emoji"},
        chat_id="chat-final",
    )

    assert restored["user_id"] == "user-aux"
    assert restored["session_id"] == "session-aux"
    assert restored["message_id"] == "msg-aux"
    assert restored["debug_request_id"] == "dbg-aux"
    assert restored["upstream_request_id"] == "up-aux"
    assert restored["prompt_submitted_at_ms"] == 2222
    assert restored["origin_prompt_submitted_at_ms"] == 1111
    assert restored["request_phase"] == "auxiliary_task"
    assert restored["task"] == "emoji_generation"
    assert restored["task_body"] == {"prompt": "emoji"}
    assert restored["chat_id"] == "chat-final"
    assert restored["transcript_anchor_kind"] == "background"
