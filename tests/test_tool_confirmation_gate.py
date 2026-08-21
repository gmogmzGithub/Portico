"""Unit tests for the per-action MCP write/action confirmation gate.

Backs scenarios L-18..L-23 (security) and G-30..G-32 (mcp) from
``docs/testing/plan/``. Threat-model item N-012.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = (
    REPO_ROOT
    / "src"
    / "patches"
    / "backend"
    / "open_webui"
    / "utils"
    / "tool_confirmation_gate.py"
)


def _load_gate_module():
    import sys

    spec = importlib.util.spec_from_file_location(
        "tool_confirmation_gate", MODULE_PATH
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # Register before execution so @dataclass decorators on Python 3.14 can
    # resolve the module via sys.modules during _is_type lookups.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


tcg = _load_gate_module()


@pytest.fixture()
def registry_path() -> Path:
    return REPO_ROOT / "mcp-policy" / "destructive-tools.json"


@pytest.fixture()
def registry(registry_path: Path):
    return tcg.Registry.load(registry_path)


@pytest.fixture()
def gate(registry):
    audit_events: list[tuple[str, dict]] = []

    def record(event: str, **fields):
        audit_events.append((event, fields))

    g = tcg.Gate(registry=registry, audit_log_fn=record)
    g.audit_events = audit_events  # type: ignore[attr-defined]
    return g


# ---------------------------------------------------------------------------
# Registry classification (covers L-22 + G-30)
# ---------------------------------------------------------------------------


def test_registry_loads_known_destructive_tools(registry):
    side, rule = registry.classify("slack_conversations_add_message")
    assert side == "destructive"
    assert rule is not None
    assert rule.mcp == "slack"


def test_registry_classifies_read_tools_as_safe(registry):
    side, rule = registry.classify("slack_conversations_search_messages")
    assert side == "safe"
    assert rule is None


def test_registry_classifies_official_n8n_write_and_execution_tools_as_destructive(
    registry,
):
    for tool_name in (
        "create_workflow_from_code",
        "update_workflow",
        "archive_workflow",
        "restore_workflow_version",
        "publish_workflow",
        "unpublish_workflow",
        "execute_workflow",
        "test_workflow",
        "prepare_test_pin_data",
        "create_data_table",
        "rename_data_table",
        "add_data_table_column",
        "delete_data_table_column",
        "rename_data_table_column",
        "add_data_table_rows",
    ):
        side, rule = registry.classify(tool_name)
        assert side == "destructive", f"{tool_name} must require confirmation"
        assert rule is not None and rule.mcp == "mcp-n8n", (
            f"{tool_name} must match an explicit mcp-n8n confirmation rule"
        )


def test_registry_classifies_official_n8n_read_tools_as_safe(registry):
    for tool_name in (
        "search_workflows",
        "get_workflow_details",
        "get_workflow_history",
        "get_workflow_version",
        "search_executions",
        "get_execution",
        "search_data_tables",
        "validate_workflow",
        "search_nodes",
    ):
        side, rule = registry.classify(tool_name)
        assert side == "safe", f"{tool_name} must not require confirmation"
        assert rule is None


def test_registry_classifies_community_fork_n8n_write_tools_as_destructive(
    registry,
):
    # The fork's rules bind to the PREFIXED dispatched names
    # (server id n8n-community-mcp → prefix n8n_community_mcp_). Names below
    # are the live tool set of Portico's fork build, plus defensive globs for
    # tools the fork disables server-side (delete_execution, trigger, creds).
    for tool_name in (
        "n8n_community_mcp_n8n_create_workflow",
        "n8n_community_mcp_n8n_update_full_workflow",
        "n8n_community_mcp_n8n_update_partial_workflow",
        "n8n_community_mcp_n8n_delete_workflow",
        "n8n_community_mcp_n8n_test_workflow",
        "n8n_community_mcp_n8n_deploy_template",
        "n8n_community_mcp_n8n_autofix_workflow",
        "n8n_community_mcp_n8n_delete_execution",
        "n8n_community_mcp_n8n_trigger_webhook_workflow",
        "n8n_community_mcp_n8n_credential_create",
    ):
        side, rule = registry.classify(tool_name)
        assert side == "destructive", f"{tool_name} must require confirmation"
        assert rule is not None and rule.mcp == "n8n-community-mcp", (
            f"{tool_name} must match an explicit n8n-community-mcp rule"
        )


def test_registry_classifies_community_fork_n8n_read_tools_as_safe(registry):
    # Live read set of Portico's fork build. n8n_executions stays safe because
    # the fallback regex matches whole segments ("executions" != "execute").
    for tool_name in (
        "n8n_community_mcp_n8n_list_workflows",
        "n8n_community_mcp_n8n_get_workflow",
        "n8n_community_mcp_n8n_executions",
        "n8n_community_mcp_n8n_workflow_versions",
        "n8n_community_mcp_n8n_search_example_workflows",
        "n8n_community_mcp_search_nodes",
        "n8n_community_mcp_get_node",
        "n8n_community_mcp_tools_documentation",
        "n8n_community_mcp_validate_node",
        "n8n_community_mcp_validate_workflow",
        "n8n_community_mcp_n8n_validate_workflow",
        "n8n_community_mcp_n8n_health_check",
    ):
        side, rule = registry.classify(tool_name)
        assert side == "safe", f"{tool_name} must not require confirmation"
        assert rule is None


def test_registry_explicit_read_overrides_fallback(registry):
    # data_plat_query_generate has an explicit side_effect: "read" rule even
    # though the fallback regex would match on "_generate".
    side, rule = registry.classify("data_plat_query_generate")
    assert side == "safe"
    assert rule is None


def test_registry_treats_mcp_assistant_local_setup_flows_as_safe(registry):
    for tool_name in (
        "mcp_assistant_trigger_guided_setup",
        "mcp_assistant_toggle_integration",
        "mcp_assistant_authorize_integration",
        "mcp_assistant_activate_integration",
    ):
        side, rule = registry.classify(tool_name)
        assert side == "safe"
        assert rule is None


def test_registry_fallback_catches_unknown_destructive_names(registry):
    side, rule = registry.classify("some_brand_new_create_thing")
    assert side == "destructive"
    assert rule is None  # caught only by the fallback regex


def test_registry_fallback_does_not_match_pure_reads(registry):
    side, _rule = registry.classify("read_user_profile")
    assert side == "safe"


def test_registry_classifies_scheduling_lifecycle_tools_as_destructive_round4(
    registry,
):
    """Round 4 / Issue 3c — every scheduling lifecycle tool that
    persists or runs a task must be classified as destructive so the
    user gets a main-chat chip before the schedule is committed.
    Without this, sub-agents end up re-asking 'should I send the
    message?' once per scheduled occurrence; with this, the
    confirmation lives at the moment the user actually decided to
    create the schedule."""

    for tool_name in (
        "scheduling_create_task",
        "scheduling_update_task",
        "scheduling_delete_task",
        "scheduling_run_task_now",
    ):
        side, rule = registry.classify(tool_name)
        assert side == "destructive", (
            f"{tool_name} must be destructive so the user gets a main-chat "
            f"confirmation chip; got {side}"
        )
        assert rule is not None and rule.mcp == "scheduling", (
            f"{tool_name} must match the explicit scheduling rule (got mcp="
            f"{rule.mcp if rule else None})"
        )


def test_registry_classifies_scheduling_read_tools_as_safe_round4(registry):
    """The read-side scheduling tools must NOT trigger the chip —
    listing or fetching tasks should not interrupt the conversation."""

    for tool_name in (
        "scheduling_list_tasks",
        "scheduling_get_task",
    ):
        side, _ = registry.classify(tool_name)
        assert side == "safe", (
            f"{tool_name} should be safe (no main-chat chip needed); got {side}"
        )


def test_registry_load_handles_missing_file(tmp_path):
    nonexistent = tmp_path / "does-not-exist.json"
    reg = tcg.Registry.load(nonexistent)
    # Hardcoded fallback still works.
    side, _ = reg.classify("send_email")
    assert side == "destructive"


def test_utils_router_exposes_chip_resolve_endpoint():
    """Lock the route shape the chip frontend depends on.

    Chip clicks fetch ``POST /api/v1/utils/chip/resolve`` (the generic
    Phase-3 endpoint). The legacy ``/tool-confirmation/resolve`` was
    removed when KISS-pruned in favour of the unified surface — the
    frontend has been on the generic endpoint since Phase 3 landed.

    The handler MUST require an authenticated user, MUST verify chat
    ownership (anti-cross-tenant approval), and MUST forward the
    per-hash click to ``Gate.resolve_via_chip_click``.
    """

    utils_path = (
        Path(__file__).resolve().parents[1]
        / "src" / "patches" / "backend" / "open_webui" / "routers" / "utils.py"
    )
    source = utils_path.read_text()
    assert '"/chip/resolve"' in source, (
        "REST route must be registered under /api/v1/utils/chip/resolve"
    )
    # The legacy wrapper has been removed; if it ever creeps back in,
    # this assertion fails and we re-evaluate.
    assert '"/tool-confirmation/resolve"' not in source, (
        "Legacy /tool-confirmation/resolve endpoint should stay removed"
    )
    assert "Depends(get_verified_user)" in source, (
        "Handler must require an authenticated user"
    )
    assert "Chats.get_chat_by_id_and_user_id" in source, (
        "Handler must verify chat ownership before approving a chip click"
    )
    assert "resolve_via_chip_click" in source, (
        "Handler must call Gate.resolve_via_chip_click with the per-hash decision"
    )


def test_middleware_wires_batch_resolution_synthesis_into_resolve():
    """Lock the new batch-send synthesis path.

    The renderer fires a single chat completion after every chip on
    screen has reached a terminal state. That request carries a
    ``tool_confirmation_batch_send: true`` flag; the middleware must
    detect it, drain the gate's resolution log, and inject a hidden
    system note describing per-chip outcomes BEFORE the model sees the
    turn. If a refactor drops the wiring, the auto-fired turn would
    arrive at the model with no context and the model would re-prompt
    or guess, and approved hashes would expire (no replay).
    """

    middleware_path = (
        Path(__file__).resolve().parents[1]
        / "src" / "patches" / "backend" / "open_webui" / "utils" / "middleware.py"
    )
    source = middleware_path.read_text()
    assert "def _inject_batch_resolution_note" in source, (
        "Helper that synthesizes the batch resolution note must exist"
    )
    assert "pop_resolutions_for_batch" in source, (
        "Synthesis helper must drain the gate's per-chat resolution log"
    )
    assert "tool_confirmation_batch_send" in source, (
        "Resolve hook must read the renderer's batch-send marker from form_data"
    )
    # The synthesis MUST run inside _resolve_pending_tool_confirmations so
    # it executes BEFORE the upstream model receives form_data.
    resolve_idx = source.find("def _resolve_pending_tool_confirmations")
    inject_call_idx = source.find(
        "_inject_batch_resolution_note(form_data, gate, chat_id)"
    )
    assert resolve_idx >= 0
    assert inject_call_idx > resolve_idx, (
        "_inject_batch_resolution_note must be called from inside "
        "_resolve_pending_tool_confirmations"
    )


def test_middleware_wires_gate_into_streaming_dispatch_site():
    """Regression for N-012 dispatch-site bypass.

    The original wiring put ``_apply_tool_confirmation_gate`` only into the
    legacy ``chat_completion_tools_handler -> tool_call_handler`` path. The
    modern hot path — ``process_tool_calls -> execute_single_tool_call ->
    invoke_tool_with_transient_retries`` — went unprotected. A real Slack
    DM dispatched in production despite the gate.

    Lock the contract: both call sites must invoke
    ``_apply_tool_confirmation_gate`` BEFORE the tool dispatcher. If a
    refactor un-wires either, this test fails before the bug ships.
    """

    middleware_path = (
        Path(__file__).resolve().parents[1]
        / "src"
        / "patches"
        / "backend"
        / "open_webui"
        / "utils"
        / "middleware.py"
    )
    text = middleware_path.read_text(encoding="utf-8")

    # The legacy path must still be wired.
    assert "async def tool_call_handler" in text
    assert text.count("_apply_tool_confirmation_gate(") >= 3, (
        "expected the gate helper to be called from at least: definition, "
        "legacy tool_call_handler, and streaming execute_single_tool_call"
    )

    # The streaming hot path must be wired. The structural anchor is the
    # nesting: execute_single_tool_call (or its enclosing process_tool_calls)
    # must contain a gate call before the dispatcher invocation.
    assert "async def execute_single_tool_call" in text, (
        "execute_single_tool_call no longer present — refactor likely; "
        "re-verify the gate is still wired into the new dispatch site"
    )
    streaming_start = text.index("async def execute_single_tool_call")
    streaming_end = text.index("results = []", streaming_start)
    streaming_block = text[streaming_start:streaming_end]
    assert "_apply_tool_confirmation_gate(" in streaming_block, (
        "execute_single_tool_call dispatches tools without going through "
        "_apply_tool_confirmation_gate first — N-012 regression. The chip "
        "will never appear for streaming MCP tool calls."
    )
    # Extra belt: the gate call must precede the actual invoke. Anchor on
    # ``await invoke_tool_with_transient_retries()`` (the call site) rather
    # than the bare name, which also matches the inner ``async def`` and
    # would give a false-positive "gate is too late" failure.
    gate_pos = streaming_block.index("_apply_tool_confirmation_gate(")
    invoke_pos = streaming_block.index(
        "await invoke_tool_with_transient_retries()"
    )
    assert gate_pos < invoke_pos, (
        "_apply_tool_confirmation_gate must run BEFORE "
        "`await invoke_tool_with_transient_retries()`, otherwise the "
        "dispatch happens unconditionally"
    )


def test_registry_fallback_catches_real_world_write_verbs():
    """Regression for N-012 bypass: when the registry file is missing, the
    hardcoded fallback regex MUST still classify tools whose verb is one of
    the real-world write conventions used by the MCP servers we ship.

    Originally the fallback only knew ``send/post/publish/create/update/delete/...``.
    `slack_conversations_add_message` (verb = ``add``) slipped past it, and a
    Slack DM was sent without the per-action chip. Lock the canonical
    write-verb set in here so the fallback is the same belt-and-suspenders
    contract whether or not ``mcp-policy/destructive-tools.json`` is mounted.
    """

    reg = tcg.Registry.load(None)  # forces hardcoded fallback only

    must_be_destructive = [
        # Slack
        "slack_conversations_add_message",
        "slack_conversations_reply",
        # Gmail / mail
        "gmail_messages_send",
        "gmail_drafts_create",
        "send_email",
        # Drive / Docs / Sheets / Slides write surface
        "drive_files_upload",
        "drive_files_copy",
        "docs_documents_insert_text",
        "sheets_values_append",
        "sheets_values_update",
        "slides_presentations_rename",
        # GitLab / Jira / Confluence write surface
        "gitlab_merge_request_create",
        "gitlab_branch_delete",
        "jira_issue_transition",
        "jira_issue_assign",
        "confluence_page_publish",
        # n8n / scheduling
        "n8n_workflow_trigger",
        "scheduling_run_task_now",
        "scheduling_cancel_run",
        # Generic / notifications
        "notify_user",
        "share_with_team",
        "dispatch_alert",
        "broadcast_announcement",
        "approve_request",
        "reject_request",
    ]
    for tool_name in must_be_destructive:
        side, _ = reg.classify(tool_name)
        assert side == "destructive", (
            f"hardcoded fallback failed N-012 for {tool_name!r}: "
            "if mcp-policy/destructive-tools.json is missing, this tool "
            "would dispatch without the confirmation chip"
        )


# ---------------------------------------------------------------------------
# Hashing & summary rendering
# ---------------------------------------------------------------------------


def test_call_hash_is_stable_under_arg_order():
    h1 = tcg.compute_call_hash("x", {"a": 1, "b": 2})
    h2 = tcg.compute_call_hash("x", {"b": 2, "a": 1})
    assert h1 == h2


def test_call_hash_changes_with_args():
    h1 = tcg.compute_call_hash("x", {"a": 1})
    h2 = tcg.compute_call_hash("x", {"a": 2})
    assert h1 != h2


def test_call_hash_changes_with_tool_name():
    h1 = tcg.compute_call_hash("x", {"a": 1})
    h2 = tcg.compute_call_hash("y", {"a": 1})
    assert h1 != h2


def test_render_summary_supports_dotted_paths():
    out = tcg.render_summary("{{a.b}} -> {{a.c}}", {"a": {"b": 1, "c": "two"}})
    assert out == "1 -> two"


def test_render_summary_filters_truncate_chars_join():
    out = tcg.render_summary(
        "{{body|truncate:5}}/{{body|chars}}/{{tags|join:'+'}}",
        {"body": "hello world", "tags": ["red", "blue"]},
    )
    assert out.startswith("hell")
    assert "/" in out
    assert "red+blue" in out


def test_render_summary_missing_field_renders_dash():
    out = tcg.render_summary("hi {{nope}}", {})
    assert out == "hi -"


# ---------------------------------------------------------------------------
# Gate.evaluate_tool_call (L-19, L-20, L-23, G-30, G-31)
# ---------------------------------------------------------------------------


def test_safe_tool_dispatches_without_confirmation(gate):
    decision = gate.evaluate_tool_call(
        chat_id="c1",
        user_id="u1",
        tool_name="slack_conversations_history",
        args={"channel": "C123"},
    )
    assert decision.action == "dispatch"


def test_destructive_tool_blocks_first_call(gate):
    decision = gate.evaluate_tool_call(
        chat_id="c1",
        user_id="u1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "D9", "payload": "hi"},
    )
    assert decision.action == "block"
    assert decision.card is not None
    assert decision.card.tool_name == "slack_conversations_add_message"
    assert "hi" in decision.card.summary
    assert decision.card.hash
    assert gate.has_pending("c1") is True


def test_destructive_dispatch_with_matching_token(gate):
    first = gate.evaluate_tool_call(
        chat_id="c1",
        user_id="u1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "D9", "payload": "hi"},
    )
    assert first.action == "block"
    second = gate.evaluate_tool_call(
        chat_id="c1",
        user_id="u1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "D9", "payload": "hi"},
        confirmation_token=first.card.hash,
    )
    assert second.action == "dispatch"
    assert gate.has_pending("c1") is False


def test_destructive_token_is_single_use(gate):
    first = gate.evaluate_tool_call(
        chat_id="c1",
        user_id="u1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "D9", "payload": "hi"},
    )
    gate.evaluate_tool_call(
        chat_id="c1",
        user_id="u1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "D9", "payload": "hi"},
        confirmation_token=first.card.hash,
    )
    # Replay with same token must not dispatch.
    replay = gate.evaluate_tool_call(
        chat_id="c1",
        user_id="u1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "D9", "payload": "hi"},
        confirmation_token=first.card.hash,
    )
    assert replay.action == "reject"
    assert replay.reject_reason == "gate_bypass_attempted"


def test_destructive_token_rejects_on_arg_drift(gate):
    first = gate.evaluate_tool_call(
        chat_id="c1",
        user_id="u1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "D9", "payload": "hi"},
    )
    drift = gate.evaluate_tool_call(
        chat_id="c1",
        user_id="u1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "D9", "payload": "evil"},
        confirmation_token=first.card.hash,
    )
    assert drift.action == "reject"
    assert drift.reject_reason == "hash_mismatch"


def test_destructive_token_rejects_on_tool_drift(gate):
    first = gate.evaluate_tool_call(
        chat_id="c1",
        user_id="u1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "D9", "payload": "hi"},
    )
    drift = gate.evaluate_tool_call(
        chat_id="c1",
        user_id="u1",
        tool_name="gmail_send_message",
        args={"to": ["x@y"], "subject": "hi", "body": "z"},
        confirmation_token=first.card.hash,
    )
    assert drift.action == "reject"
    # Arg-shape difference produces hash_mismatch when the rule still maps,
    # OR gate_bypass_attempted when the token belongs to a different chat
    # context. Either is acceptable so long as it is NOT dispatch.
    assert drift.reject_reason in {"hash_mismatch", "gate_bypass_attempted"}


def test_unknown_token_is_rejected(gate):
    decision = gate.evaluate_tool_call(
        chat_id="c1",
        user_id="u1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "D9", "payload": "hi"},
        confirmation_token="0123456789abcdef",
    )
    assert decision.action == "reject"
    assert decision.reject_reason == "gate_bypass_attempted"


def test_multi_call_batch_each_blocks_independently(gate):
    a = gate.evaluate_tool_call(
        chat_id="c1",
        user_id="u1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "D9", "payload": "msg-A"},
    )
    b = gate.evaluate_tool_call(
        chat_id="c1",
        user_id="u1",
        tool_name="gmail_send_message",
        args={"to": ["x@y"], "subject": "hi", "body": "msg-B"},
    )
    assert a.action == "block"
    assert b.action == "block"
    assert a.card.hash != b.card.hash
    assert len(gate.pending_for_chat("c1")) == 2


# ---------------------------------------------------------------------------
# resolve_user_reply (L-21, B.3)
# ---------------------------------------------------------------------------


def _propose_one_destructive(gate):
    decision = gate.evaluate_tool_call(
        chat_id="c1",
        user_id="u1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "D9", "payload": "hi"},
    )
    assert decision.action == "block"
    return decision.card.hash


def test_resolve_yes_with_one_pending_approves(gate):
    h = _propose_one_destructive(gate)
    outcome = gate.resolve_user_reply(chat_id="c1", user_text="yes")
    assert outcome.decision == "approve"
    assert outcome.approved_hash == h
    # Marked-approved means a subsequent dispatch (without the model passing
    # an explicit token) succeeds — this is what makes natural-language
    # approval work end-to-end.
    second = gate.evaluate_tool_call(
        chat_id="c1",
        user_id="u1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "D9", "payload": "hi"},
    )
    assert second.action == "dispatch"


def test_resolve_yes_with_multiple_pending_drops_all_no_approval(gate):
    gate.evaluate_tool_call(
        chat_id="c1",
        user_id="u1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "D9", "payload": "msg-A"},
    )
    gate.evaluate_tool_call(
        chat_id="c1",
        user_id="u1",
        tool_name="gmail_send_message",
        args={"to": ["x@y"], "subject": "hi", "body": "msg-B"},
    )
    outcome = gate.resolve_user_reply(chat_id="c1", user_text="yes")
    # Ambiguous "yes" -> modify, not approve.
    assert outcome.decision == "modify"
    # And a subsequent re-emit of either action is BLOCKED again, not
    # silently dispatched.
    again = gate.evaluate_tool_call(
        chat_id="c1",
        user_id="u1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "D9", "payload": "msg-A"},
    )
    assert again.action == "block"


def test_resolve_no_cancels_all_pending(gate):
    _propose_one_destructive(gate)
    outcome = gate.resolve_user_reply(chat_id="c1", user_text="no, do not send")
    assert outcome.decision == "modify"  # text isn't a strict bare "no"
    # Strict-bare cancellation
    _propose_one_destructive(gate)
    out2 = gate.resolve_user_reply(chat_id="c1", user_text="no")
    assert out2.decision == "cancel"
    assert gate.has_pending("c1") is False


def test_resolve_free_text_drops_pending(gate):
    _propose_one_destructive(gate)
    outcome = gate.resolve_user_reply(
        chat_id="c1", user_text="actually, change the message to 'see you tomorrow'"
    )
    assert outcome.decision == "modify"
    assert outcome.free_text == "actually, change the message to 'see you tomorrow'"
    assert gate.has_pending("c1") is False


def test_resolve_with_no_pending_is_modify_passthrough(gate):
    outcome = gate.resolve_user_reply(chat_id="c1", user_text="hello")
    assert outcome.decision == "modify"
    assert outcome.cancelled_hashes == []


def test_consume_user_turn_clears_pending(gate):
    _propose_one_destructive(gate)
    cleared = gate.consume_user_turn("c1")
    assert len(cleared) == 1
    assert gate.has_pending("c1") is False


def test_stale_yes_cannot_authorize_future_action(gate):
    # User said yes long ago in a different turn; gate.consume_assistant_turn
    # cleared the approval. New destructive call must block again.
    h = _propose_one_destructive(gate)
    gate.resolve_user_reply(chat_id="c1", user_text="yes")
    gate.consume_assistant_turn("c1")  # simulate end of assistant turn
    new_call = gate.evaluate_tool_call(
        chat_id="c1",
        user_id="u1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "D9", "payload": "hi"},
    )
    assert new_call.action == "block"


# ---------------------------------------------------------------------------
# Stacked-chip helpers + natural-language fallback for the hand-typed path
# (UI button clicks now flow through ``resolve_via_chip_click`` directly via
# ``POST /api/v1/utils/chip/resolve``; see the "Chip-click REST resolver"
# section below.)
# ---------------------------------------------------------------------------


def _propose_two_destructive(gate):
    """Stand up two stacked pendings on the same chat (different args ->
    different hashes). Returns the two hashes in registration order.

    Mirrors the chip UX where a single assistant turn emits two destructive
    tool calls, and the gate produces two stacked chips above the input.
    """
    first = gate.evaluate_tool_call(
        chat_id="c1",
        user_id="u1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "D9", "payload": "hi A"},
    )
    second = gate.evaluate_tool_call(
        chat_id="c1",
        user_id="u1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "D9", "payload": "hi B"},
    )
    assert first.action == "block" and second.action == "block"
    return first.card.hash, second.card.hash


def test_natural_language_no_with_stacked_pendings_still_drops_all(gate):
    """A hand-typed bare "no" with multiple pendings must drop everything —
    the original Slack-incident invariant. This is the natural-language
    fallback (chip clicks bypass this path entirely via REST).
    """

    h_a, h_b = _propose_two_destructive(gate)
    outcome = gate.resolve_user_reply(chat_id="c1", user_text="no")
    assert outcome.decision == "cancel"
    assert set(outcome.cancelled_hashes) == {h_a, h_b}
    assert gate.pending_for_chat("c1") == []


# ---------------------------------------------------------------------------
# Chip-click REST resolver (resolve_via_chip_click + pop_resolutions_for_batch)
# Covers L-23, G-32 — Cursor-style batched chip resolution flow.
# ---------------------------------------------------------------------------


def test_resolve_via_chip_click_approve_marks_and_records(gate):
    """A click 'Yes' through the REST endpoint marks the hash approved
    AND adds a ``ResolutionRecord`` so the next batch-send turn can
    describe the outcome to the model. The args snapshot must round-trip
    so the synthesis note can echo them verbatim into the model — without
    that, the model reconstructs them with subtle JSON differences and
    the re-emit produces a NEW hash + a fresh chip (the
    "approved-but-didn't-vanish" regression)."""

    h_a, h_b = _propose_two_destructive(gate)
    record = gate.resolve_via_chip_click(
        chat_id="c1", call_hash=h_a, option_id="approve"
    )
    assert record is not None
    assert record.decision == "approve"
    assert record.option_id == "approve"
    assert record.call_hash == h_a
    assert record.tool_name == "slack_conversations_add_message"
    assert record.args == {"channel_id": "D9", "payload": "hi A"}, (
        f"args snapshot must match the proposed call, got {record.args!r}"
    )
    # The audit log must use the past-tense event name (registered in
    # ``_AUDIT_EVENTS``); the bare decision string ("approve") would
    # trigger the "unknown audit event" warning path.
    events = [event for event, _ in gate.audit_events]  # type: ignore[attr-defined]
    assert "approved" in events
    assert "approve" not in events
    # Sibling chip B is unaffected.
    pending_remaining = {p.call_hash for p in gate.pending_for_chat("c1")}
    assert pending_remaining == {h_b}
    # And a follow-up dispatch with same args goes through.
    res = gate.evaluate_tool_call(
        chat_id="c1",
        user_id="u1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "D9", "payload": "hi A"},
    )
    assert res.action == "dispatch"


def test_resolve_via_chip_click_cancel_drops_only_target(gate):
    h_a, h_b = _propose_two_destructive(gate)
    record = gate.resolve_via_chip_click(
        chat_id="c1", call_hash=h_a, option_id="cancel"
    )
    assert record is not None
    assert record.decision == "cancel"
    assert {p.call_hash for p in gate.pending_for_chat("c1")} == {h_b}
    # Past-tense audit event (see resolve_via_chip_click_approve test).
    events = [event for event, _ in gate.audit_events]  # type: ignore[attr-defined]
    assert "cancelled" in events
    assert "cancel" not in events


def test_resolve_via_chip_click_modify_records_payload(gate):
    h_a, _ = _propose_two_destructive(gate)
    record = gate.resolve_via_chip_click(
        chat_id="c1",
        call_hash=h_a,
        option_id="modify",
        freeform_payload="use #different-channel",
    )
    assert record is not None
    assert record.decision == "modify"
    assert record.modify_payload == "use #different-channel"
    assert record.freeform_payload == "use #different-channel"
    # Args are also captured on modify so the synthesis note can show the
    # baseline alongside the user's requested adjustments.
    assert record.args == {"channel_id": "D9", "payload": "hi A"}
    # Pending entry for h_a is dropped — model will issue a fresh tool call
    # whose args incorporate the modify payload, which produces a NEW hash
    # and a NEW chip.
    assert h_a not in {p.call_hash for p in gate.pending_for_chat("c1")}


def test_resolve_via_chip_click_unknown_hash_returns_none_and_audits(gate):
    _propose_one_destructive(gate)
    record = gate.resolve_via_chip_click(
        chat_id="c1", call_hash="ffffffffdeadbeef", option_id="approve"
    )
    assert record is None
    events = [event for event, _ in gate.audit_events]  # type: ignore[attr-defined]
    assert "gate_bypass_attempted" in events


def test_resolve_via_chip_click_rejects_unknown_option_id(gate):
    """A click with an option id the chip never declared (forged button
    or stale frontend) is rejected with ``gate_bypass_attempted`` and no
    ResolutionRecord."""

    h_a, _ = _propose_two_destructive(gate)
    record = gate.resolve_via_chip_click(
        chat_id="c1", call_hash=h_a, option_id="bogus"
    )
    assert record is None
    events = [event for event, _ in gate.audit_events]  # type: ignore[attr-defined]
    assert "gate_bypass_attempted" in events


def test_pop_resolutions_for_batch_drains_in_order_and_clears(gate):
    """Stacked chips with mixed decisions all surface in the batch pop,
    in registration order, and the call empties the buffer so a follow-
    up turn does not see them again."""

    h_a, h_b = _propose_two_destructive(gate)
    gate.resolve_via_chip_click(chat_id="c1", call_hash=h_a, option_id="approve")
    gate.resolve_via_chip_click(
        chat_id="c1", call_hash=h_b, option_id="modify", freeform_payload="shorter"
    )
    records = gate.pop_resolutions_for_batch("c1")
    assert len(records) == 2
    decisions = [r.decision for r in records]
    assert decisions == ["approve", "modify"]
    assert records[1].modify_payload == "shorter"
    # Buffer is empty after the pop.
    assert gate.pop_resolutions_for_batch("c1") == []
    assert gate.has_resolutions("c1") is False


def test_resolve_via_chip_click_three_chips_mixed_decisions(gate):
    """Three stacked chips, one of each decision (approve, cancel, modify),
    all resolve independently and the batch-pop returns all three records.
    This is the canonical Cursor-style multi-chip turn."""

    first = gate.evaluate_tool_call(
        chat_id="c1",
        user_id="u1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "D9", "payload": "msg A"},
    )
    second = gate.evaluate_tool_call(
        chat_id="c1",
        user_id="u1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "D9", "payload": "msg B"},
    )
    third = gate.evaluate_tool_call(
        chat_id="c1",
        user_id="u1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "D9", "payload": "msg C"},
    )
    assert all(r.action == "block" for r in (first, second, third))
    h1, h2, h3 = first.card.hash, second.card.hash, third.card.hash

    gate.resolve_via_chip_click(chat_id="c1", call_hash=h1, option_id="approve")
    gate.resolve_via_chip_click(chat_id="c1", call_hash=h2, option_id="cancel")
    gate.resolve_via_chip_click(
        chat_id="c1", call_hash=h3, option_id="modify", freeform_payload="use #x"
    )

    # Pending should be empty — all three resolved.
    assert gate.pending_for_chat("c1") == []
    # Approval cache holds only h1.
    res_dispatch = gate.evaluate_tool_call(
        chat_id="c1",
        user_id="u1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "D9", "payload": "msg A"},
    )
    assert res_dispatch.action == "dispatch"

    # And the batch pop carries all three records (h2 still pops as
    # "cancel" so the model knows not to retry — even though it never
    # registered an approval).
    # Reset the accidentally-registered new pending from the dispatch
    # check above by popping any resolutions and ignoring extra pending
    # state — this assertion is about what the click clicks recorded.
    records = gate.pop_resolutions_for_batch("c1")
    decisions_by_hash = {r.call_hash: r.decision for r in records}
    assert decisions_by_hash == {h1: "approve", h2: "cancel", h3: "modify"}


def test_resolve_via_chip_click_idempotent_on_double_click(gate):
    """Clicking the same chip twice (e.g. user double-tapped Yes) is a
    no-op the second time — the gate audits a bypass attempt (the hash is
    no longer pending) and returns None. Important so the renderer can
    safely retry on flaky network without registering a duplicate
    approval."""

    h_a, _ = _propose_two_destructive(gate)
    first = gate.resolve_via_chip_click(
        chat_id="c1", call_hash=h_a, option_id="approve"
    )
    assert first is not None
    second = gate.resolve_via_chip_click(
        chat_id="c1", call_hash=h_a, option_id="approve"
    )
    assert second is None


# ---------------------------------------------------------------------------
# Audit logging (B.4)
# ---------------------------------------------------------------------------


def test_audit_log_captures_propose_and_dispatch(gate):
    _propose_one_destructive(gate)
    gate.resolve_user_reply(chat_id="c1", user_text="yes")
    gate.evaluate_tool_call(
        chat_id="c1",
        user_id="u1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "D9", "payload": "hi"},
    )
    events = [event for event, _ in gate.audit_events]  # type: ignore[attr-defined]
    assert "proposed" in events
    assert "approved" in events
    assert "dispatched_after_approval" in events


def test_audit_log_captures_bypass_attempt(gate):
    gate.evaluate_tool_call(
        chat_id="c1",
        user_id="u1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "D9", "payload": "hi"},
        confirmation_token="forged-token-not-from-the-gate",
    )
    events = [event for event, _ in gate.audit_events]  # type: ignore[attr-defined]
    assert "gate_bypass_attempted" in events


# ---------------------------------------------------------------------------
# Tool Action Policy injection (C.1)
# ---------------------------------------------------------------------------


def test_inject_tool_action_policy_adds_block():
    form_data = {"messages": [{"role": "system", "content": "Be helpful."}]}
    out = tcg.inject_tool_action_policy(form_data)
    assert "Tool Action Policy" in out["messages"][0]["content"]


def test_inject_tool_action_policy_is_idempotent():
    form_data = {"messages": [{"role": "system", "content": "Be helpful."}]}
    tcg.inject_tool_action_policy(form_data)
    first = form_data["messages"][0]["content"]
    tcg.inject_tool_action_policy(form_data)
    assert form_data["messages"][0]["content"] == first


def test_inject_tool_action_policy_when_no_system_prompt():
    form_data = {"messages": [{"role": "user", "content": "hi"}]}
    out = tcg.inject_tool_action_policy(form_data)
    assert out["messages"][0]["role"] == "system"
    assert "Tool Action Policy" in out["messages"][0]["content"]


# ---------------------------------------------------------------------------
# Read-only bypass (G-30)
# ---------------------------------------------------------------------------


def test_read_only_tools_never_block(gate):
    for tool in (
        "slack_conversations_search_messages",
        "slack_conversations_history",
        "slack_conversations_replies",
        "gmail_messages_list",
        "drive_files_list",
        "data_plat_query_generate",
    ):
        decision = gate.evaluate_tool_call(
            chat_id="c1",
            user_id="u1",
            tool_name=tool,
            args={"q": "anything"},
        )
        assert decision.action == "dispatch", tool


# ---------------------------------------------------------------------------
# Per-chat isolation
# ---------------------------------------------------------------------------


def test_pending_actions_are_per_chat(gate):
    a = gate.evaluate_tool_call(
        chat_id="chat-A",
        user_id="u1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "D9", "payload": "hi"},
    )
    # Same hash, different chat should still block.
    b = gate.evaluate_tool_call(
        chat_id="chat-B",
        user_id="u1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "D9", "payload": "hi"},
        confirmation_token=a.card.hash,
    )
    assert b.action == "reject"
    assert b.reject_reason == "gate_bypass_attempted"


def test_registry_json_is_well_formed():
    # Belt-and-braces: the registry file must parse and contain the canonical
    # Slack rule, even if no other test exercises it directly.
    path = REPO_ROOT / "mcp-policy" / "destructive-tools.json"
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    rules = data.get("rules", [])
    assert any(
        rule.get("tool_name_glob") == "slack_conversations_add_message"
        for rule in rules
    ), "registry must explicitly cover slack_conversations_add_message"


# ---------------------------------------------------------------------------
# Phase 3: generic chip primitive
# ---------------------------------------------------------------------------
#
# The chip is no longer hard-wired to "tool confirmation". It can also
# represent a runtime CLARIFICATION question with a caller-supplied
# option set. These tests cover the primitive in isolation: today's
# tool-confirmation flow keeps its existing fields + buttons (back-
# compat tests run above), while propose_clarification opens a new path
# for callers like the scheduling executor's out-of-scope handler.


def test_card_default_options_match_tool_confirmation_buttons(gate):
    # The historical chip rendered Yes / No / Reply with changes. The
    # default options list on a fresh tool-confirmation Card MUST keep
    # those three ids (so the renderer's option-id wiring keeps
    # working) and the primary button MUST stay the approve action.
    decision = gate.evaluate_tool_call(
        chat_id="chat-1",
        user_id="user-1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "C1", "payload": "hi"},
    )
    assert decision.action == "block"
    assert decision.card is not None
    option_ids = [opt.id for opt in decision.card.options]
    # Round 4 / Issue 2 — the default tool-confirmation chip now
    # carries a fourth ``always_allow`` option that approves THIS
    # call AND writes a per-user persistent allowlist entry.
    # The historical three ids must keep their order so the
    # renderer's option-id wiring keeps working AND the primary
    # button must remain ``approve`` so the default keystroke
    # behaviour is unchanged.
    assert option_ids == [
        tcg.TOOL_CONFIRMATION_OPTION_APPROVE,
        tcg.TOOL_CONFIRMATION_OPTION_CANCEL,
        tcg.TOOL_CONFIRMATION_OPTION_MODIFY,
        tcg.TOOL_CONFIRMATION_OPTION_ALWAYS_ALLOW,
    ]
    primary = next(
        opt for opt in decision.card.options if opt.style == "primary"
    )
    assert primary.id == tcg.TOOL_CONFIRMATION_OPTION_APPROVE
    assert decision.card.kind == "tool_confirmation"
    assert decision.card.allow_freeform is True


def test_propose_clarification_registers_pending_chip(gate):
    options = [
        tcg.ChipOption(id="block", label="Block", style="danger"),
        tcg.ChipOption(id="approve_once", label="Approve once", style="primary"),
        tcg.ChipOption(id="widen", label="Widen scope", style="secondary"),
    ]
    card = gate.propose_clarification(
        chat_id="chat-9",
        user_id="user-1",
        prompt="Out-of-scope tool — what should I do?",
        options=options,
        allow_freeform=False,
        context={"task_id": "t-1", "tool_server_id": "server:gmail"},
    )
    assert card.kind == "clarification"
    assert card.prompt.startswith("Out-of-scope")
    assert [opt.id for opt in card.options] == ["block", "approve_once", "widen"]
    assert card.allow_freeform is False
    assert card.context["task_id"] == "t-1"
    # The chip is now pending in the gate so a chip-click can resolve it.
    pending = gate.pending_for_chat("chat-9")
    assert len(pending) == 1
    assert pending[0].kind == "clarification"
    assert pending[0].call_hash == card.hash


def test_propose_clarification_rejects_empty_options(gate):
    with pytest.raises(ValueError):
        gate.propose_clarification(
            chat_id="c", user_id=None, prompt="?", options=[],
        )


def test_propose_clarification_rejects_empty_prompt(gate):
    with pytest.raises(ValueError):
        gate.propose_clarification(
            chat_id="c",
            user_id=None,
            prompt="",
            options=[tcg.ChipOption(id="x", label="X")],
        )


def test_resolve_via_chip_click_clarification_records_option(gate):
    # End-to-end: propose a clarification, resolve via the generic
    # ``option_id`` path, drain the resolution and verify the record
    # carries the option id + caller context (vs. the legacy
    # decision vocabulary).
    card = gate.propose_clarification(
        chat_id="chat-2",
        user_id=None,
        prompt="Pick one",
        options=[
            tcg.ChipOption(id="a", label="A"),
            tcg.ChipOption(id="b", label="B"),
        ],
        context={"x": 1},
    )
    record = gate.resolve_via_chip_click(
        chat_id="chat-2",
        call_hash=card.hash,
        option_id="b",
    )
    assert record is not None
    assert record.kind == "clarification"
    assert record.option_id == "b"
    assert record.effective_option_id == "b"
    assert record.context["x"] == 1
    assert record.decision == ""  # legacy field unused for clarifications
    drained = gate.pop_resolutions_for_batch("chat-2")
    assert len(drained) == 1
    assert drained[0].option_id == "b"
    # Pending entry is gone (single-use).
    assert gate.pending_for_chat("chat-2") == []
    # Audit event for clarifications is the neutral "resolved".
    events = [e for e, _ in gate.audit_events]  # type: ignore[attr-defined]
    assert "resolved" in events


def test_resolve_via_chip_click_clarification_rejects_unknown_option(gate):
    card = gate.propose_clarification(
        chat_id="chat-3",
        user_id=None,
        prompt="Pick",
        options=[tcg.ChipOption(id="only", label="Only")],
    )
    record = gate.resolve_via_chip_click(
        chat_id="chat-3",
        call_hash=card.hash,
        option_id="not-a-button",
    )
    assert record is None
    audit = [e for e, _ in gate.audit_events]  # type: ignore[attr-defined]
    assert "gate_bypass_attempted" in audit
    # Pending entry still alive — unknown option doesn't drop it.
    assert len(gate.pending_for_chat("chat-3")) == 1


# ---------------------------------------------------------------------------
# Round 4 / Issue 7b — chat_attention_for_user (sidebar dot)
#
# The sidebar amber-dot endpoint reads from this method. The contract:
#
# * one entry per chat with at least one pending chip
# * reason mapping: tool_confirmation -> awaiting_confirmation,
#   clarification -> awaiting_clarification, anything else -> raw kind
# * filtering: when ``user_id`` is given, drop chips owned by another
#   verified user (defense-in-depth, the route also cross-references
#   chat ownership)
# * unowned chips (``user_id=None``) are surfaced because the route
#   layer enforces ownership too — leaving them in the gate output
#   keeps system-level proposers (legacy / tests) usable.
# ---------------------------------------------------------------------------


def test_chat_attention_for_user_empty_when_nothing_pending(gate):
    assert gate.chat_attention_for_user(user_id="u-1") == {}


def test_chat_attention_for_user_surfaces_tool_confirmation_chip(gate):
    # Triggering a destructive tool without a token registers a pending
    # tool-confirmation chip — the sidebar dot should show.
    decision = gate.evaluate_tool_call(
        chat_id="chat-attn-1",
        user_id="u-1",
        tool_name="slack_conversations_add_message",
        args={"channel": "C", "text": "hi"},
    )
    assert decision.action == "block"
    attention = gate.chat_attention_for_user(user_id="u-1")
    assert attention == {"chat-attn-1": "awaiting_confirmation"}


def test_chat_attention_for_user_surfaces_clarification_chip(gate):
    gate.propose_clarification(
        chat_id="chat-attn-2",
        user_id="u-1",
        prompt="Out of scope — what to do?",
        options=[
            tcg.ChipOption(id="block", label="Block"),
            tcg.ChipOption(id="approve", label="Approve once"),
        ],
    )
    attention = gate.chat_attention_for_user(user_id="u-1")
    assert attention == {"chat-attn-2": "awaiting_clarification"}


def test_chat_attention_for_user_filters_by_owner(gate):
    # Two chips, two users: each user only sees their own.
    gate.propose_clarification(
        chat_id="chat-mine",
        user_id="u-1",
        prompt="Mine?",
        options=[tcg.ChipOption(id="ok", label="OK")],
    )
    gate.propose_clarification(
        chat_id="chat-yours",
        user_id="u-2",
        prompt="Yours?",
        options=[tcg.ChipOption(id="ok", label="OK")],
    )
    assert gate.chat_attention_for_user(user_id="u-1") == {
        "chat-mine": "awaiting_clarification"
    }
    assert gate.chat_attention_for_user(user_id="u-2") == {
        "chat-yours": "awaiting_clarification"
    }


def test_chat_attention_for_user_clears_after_chip_resolved(gate):
    # Once the user clicks a chip option the pending entry is dropped,
    # so the sidebar dot vanishes on the next refresh.
    card = gate.propose_clarification(
        chat_id="chat-clear",
        user_id="u-1",
        prompt="Pick",
        options=[tcg.ChipOption(id="ok", label="OK")],
    )
    assert gate.chat_attention_for_user(user_id="u-1") == {
        "chat-clear": "awaiting_clarification"
    }
    record = gate.resolve_via_chip_click(
        chat_id="chat-clear",
        call_hash=card.hash,
        option_id="ok",
    )
    assert record is not None
    assert gate.chat_attention_for_user(user_id="u-1") == {}


def test_chat_attention_for_user_collapses_multiple_chips_per_chat(gate):
    # A chat can accumulate >1 pending chip (bulk delete, ...). The
    # sidebar dot is binary so the gate returns one entry per chat.
    gate.evaluate_tool_call(
        chat_id="chat-multi",
        user_id="u-1",
        tool_name="slack_conversations_add_message",
        args={"channel": "C", "text": "first"},
    )
    gate.evaluate_tool_call(
        chat_id="chat-multi",
        user_id="u-1",
        tool_name="slack_conversations_add_message",
        args={"channel": "C", "text": "second"},
    )
    attention = gate.chat_attention_for_user(user_id="u-1")
    assert list(attention.keys()) == ["chat-multi"]
    assert attention["chat-multi"] == "awaiting_confirmation"


def test_chat_attention_for_user_surfaces_unowned_chips(gate):
    # System / legacy proposers may set user_id=None. The gate still
    # returns these — the route layer cross-references chat ownership
    # before exposing them to the client, so this is safe and keeps
    # backward compatibility.
    gate.propose_clarification(
        chat_id="chat-system",
        user_id=None,
        prompt="System?",
        options=[tcg.ChipOption(id="ok", label="OK")],
    )
    attention = gate.chat_attention_for_user(user_id="u-1")
    assert attention == {"chat-system": "awaiting_clarification"}


def test_resolve_via_chip_click_tool_confirmation_accepts_option_id(gate):
    # Existing tool-confirmation chips MUST still resolve when the
    # caller passes the canonical option_id (the new REST shape) in
    # place of the legacy ``decision`` field. This is the key
    # backward-compat hinge.
    decision = gate.evaluate_tool_call(
        chat_id="chat-4",
        user_id="u",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "C", "payload": "hi"},
    )
    assert decision.card is not None
    record = gate.resolve_via_chip_click(
        chat_id="chat-4",
        call_hash=decision.card.hash,
        option_id=tcg.TOOL_CONFIRMATION_OPTION_APPROVE,
    )
    assert record is not None
    assert record.kind == "tool_confirmation"
    assert record.decision == "approve"
    assert record.option_id == tcg.TOOL_CONFIRMATION_OPTION_APPROVE
    audit = [e for e, _ in gate.audit_events]  # type: ignore[attr-defined]
    assert "approved" in audit, "tool_confirmation must keep past-tense audit"


def test_resolve_via_chip_click_tool_confirmation_modify_record_shape(gate):
    # Tool-confirmation chips with ``modify`` carry the user's
    # adjusted text in ``freeform_payload``; for backwards
    # compatibility with the audit/middleware pipeline the same value
    # is mirrored into the legacy ``modify_payload`` field of the
    # record. The wire (REST) shape only exposes ``freeform_payload``
    # — there is no ``modify_payload`` parameter on the resolver.
    decision = gate.evaluate_tool_call(
        chat_id="chat-5",
        user_id="u",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "C", "payload": "hi"},
    )
    record = gate.resolve_via_chip_click(
        chat_id="chat-5",
        call_hash=decision.card.hash,
        option_id="modify",
        freeform_payload="change to #general",
    )
    assert record is not None
    assert record.decision == "modify"
    assert record.option_id == "modify"
    assert record.modify_payload == "change to #general"
    assert record.freeform_payload == "change to #general"


def test_resolve_via_chip_click_clarification_freeform_payload(gate):
    # Clarification chips can opt into a freeform answer (the chip
    # carries ``allow_freeform=True``). The payload rides into the
    # resolution record under ``freeform_payload``.
    card = gate.propose_clarification(
        chat_id="chat-6",
        user_id=None,
        prompt="Pick or describe",
        options=[
            tcg.ChipOption(id="describe", label="Describe"),
        ],
        allow_freeform=True,
    )
    record = gate.resolve_via_chip_click(
        chat_id="chat-6",
        call_hash=card.hash,
        option_id="describe",
        freeform_payload="please retry tomorrow at 9am",
    )
    assert record is not None
    assert record.option_id == "describe"
    assert record.freeform_payload == "please retry tomorrow at 9am"


def test_resolve_via_chip_click_missing_option_id_rejected(gate):
    # The REST endpoint must always pass an ``option_id``. A bare hash
    # with no option is rejected with a ``gate_bypass_attempted`` audit
    # so a malformed frontend payload doesn't silently approve.
    decision = gate.evaluate_tool_call(
        chat_id="chat-7",
        user_id="u",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "C", "payload": "x"},
    )
    record = gate.resolve_via_chip_click(
        chat_id="chat-7",
        call_hash=decision.card.hash,
        option_id="",
    )
    assert record is None
    audit = [e for e, _ in gate.audit_events]  # type: ignore[attr-defined]
    assert "gate_bypass_attempted" in audit


def test_propose_clarification_stable_identity_collapses_duplicates(gate):
    # Re-proposing the same logical clarification must collapse onto
    # the same hash so we don't stack duplicate chips when a polling
    # caller retries (e.g. daemon restart).
    options = [
        tcg.ChipOption(id="block", label="Block"),
        tcg.ChipOption(id="ok", label="Approve"),
    ]
    a = gate.propose_clarification(
        chat_id="chat-8",
        user_id=None,
        prompt="Same question",
        options=options,
        context={"task_id": "t-9"},
    )
    b = gate.propose_clarification(
        chat_id="chat-8",
        user_id=None,
        prompt="Same question",
        options=options,
        context={"task_id": "t-9"},
    )
    assert a.hash == b.hash
    # Only one entry pending despite two propose calls.
    assert len(gate.pending_for_chat("chat-8")) == 1


def test_chip_option_serializes_to_dict():
    opt = tcg.ChipOption(id="approve", label="Yes, send", style="primary")
    serialized = opt.to_dict()
    assert serialized == {"id": "approve", "label": "Yes, send", "style": "primary"}


# ---------------------------------------------------------------------------
# Phase 1: scheduled-run scope binding & out-of-scope clarification chip.
#
# These cover the GATE-LEVEL invariants of the out-of-scope flow. The
# integration with chat metadata + the batch-resolution side effects
# (mark_approved, audit lines for block / approve_once / widen) live in
# middleware.py and are exercised by test_phase1_scheduled_run_scope.py.
# ---------------------------------------------------------------------------


def test_out_of_scope_option_constants_exist_and_are_distinct():
    # Three caller-bounded option ids surface to the user via the chip.
    # We deliberately do NOT offer a "never ask again" option — that
    # bypass would defeat N-012's per-action invariant.
    assert tcg.OUT_OF_SCOPE_OPTION_BLOCK == "out_of_scope_block"
    assert tcg.OUT_OF_SCOPE_OPTION_APPROVE_ONCE == "out_of_scope_approve_once"
    assert tcg.OUT_OF_SCOPE_OPTION_WIDEN_SCOPE == "out_of_scope_widen_scope"
    options = {
        tcg.OUT_OF_SCOPE_OPTION_BLOCK,
        tcg.OUT_OF_SCOPE_OPTION_APPROVE_ONCE,
        tcg.OUT_OF_SCOPE_OPTION_WIDEN_SCOPE,
    }
    assert len(options) == 3


def _propose_out_of_scope_chip(gate, chat_id="chat-oos"):
    """Helper: build the canonical 3-option clarification chip the
    middleware proposes when a scheduled run hits an out-of-scope tool
    call. Mirrors the shape ``_propose_out_of_scope_clarification`` in
    middleware.py builds, so tests don't drift if that helper changes
    its option ordering or labels."""

    options = [
        tcg.ChipOption(
            id=tcg.OUT_OF_SCOPE_OPTION_BLOCK,
            label="Block this run",
            style="danger",
        ),
        tcg.ChipOption(
            id=tcg.OUT_OF_SCOPE_OPTION_APPROVE_ONCE,
            label="Approve once for this run",
            style="primary",
        ),
        tcg.ChipOption(
            id=tcg.OUT_OF_SCOPE_OPTION_WIDEN_SCOPE,
            label="Approve + widen task scope",
            style="secondary",
        ),
    ]
    return gate.propose_clarification(
        chat_id=chat_id,
        user_id="u1",
        prompt=(
            "Scheduled task 't-1' is trying to call an out-of-scope tool "
            "(slack_conversations_add_message). Pre-approved scope did "
            "not include this tool."
        ),
        options=options,
        allow_freeform=False,
        context={
            "out_of_scope": True,
            "task_id": "t-1",
            "tool_name": "slack_conversations_add_message",
            "tool_mcp": "slack",
            "tool_args": {"channel_id": "D9", "payload": "hi"},
            "tool_summary": "Send Slack message to D9",
            "tool_server_id_guess": "slack",
            "original_hash": "abc123",
        },
    )


def test_out_of_scope_chip_carries_three_security_bounded_options(gate):
    card = _propose_out_of_scope_chip(gate)
    option_ids = [opt.id for opt in card.options]
    assert option_ids == [
        tcg.OUT_OF_SCOPE_OPTION_BLOCK,
        tcg.OUT_OF_SCOPE_OPTION_APPROVE_ONCE,
        tcg.OUT_OF_SCOPE_OPTION_WIDEN_SCOPE,
    ]
    # Free-form input must NOT be allowed on this chip — letting the
    # user type prose into the freeform slot would invite the model
    # to interpret "ok approve forever for this whole org" as a
    # quasi-policy decision. We only allow declared options.
    assert card.allow_freeform is False
    # The chip's context must propagate the original action so the
    # batch-resolution path can register the approved hash on
    # approve_once / widen.
    assert card.context["out_of_scope"] is True
    assert card.context["task_id"] == "t-1"
    assert card.context["original_hash"] == "abc123"


def test_out_of_scope_block_resolution_records_block_choice(gate):
    card = _propose_out_of_scope_chip(gate)
    record = gate.resolve_via_chip_click(
        chat_id="chat-oos",
        call_hash=card.hash,
        option_id=tcg.OUT_OF_SCOPE_OPTION_BLOCK,
    )
    assert record is not None
    assert record.kind == "clarification"
    assert record.option_id == tcg.OUT_OF_SCOPE_OPTION_BLOCK
    assert record.context.get("out_of_scope") is True
    assert record.context.get("original_hash") == "abc123"


def test_out_of_scope_approve_once_resolution_records_choice(gate):
    card = _propose_out_of_scope_chip(gate)
    record = gate.resolve_via_chip_click(
        chat_id="chat-oos",
        call_hash=card.hash,
        option_id=tcg.OUT_OF_SCOPE_OPTION_APPROVE_ONCE,
    )
    assert record is not None
    assert record.option_id == tcg.OUT_OF_SCOPE_OPTION_APPROVE_ONCE
    # Note: the chip resolver does NOT itself mark the original hash
    # as approved. That side effect is owned by the middleware's
    # batch-resolution path so the audit line and approval slot land
    # in the same atomic step the model can act on. We verify here
    # that the resolver leaves enough information in context to do
    # that downstream.
    assert record.context.get("original_hash") == "abc123"
    assert record.context.get("tool_args") == {"channel_id": "D9", "payload": "hi"}


def test_out_of_scope_widen_resolution_records_choice_with_server_id_guess(gate):
    card = _propose_out_of_scope_chip(gate)
    record = gate.resolve_via_chip_click(
        chat_id="chat-oos",
        call_hash=card.hash,
        option_id=tcg.OUT_OF_SCOPE_OPTION_WIDEN_SCOPE,
    )
    assert record is not None
    assert record.option_id == tcg.OUT_OF_SCOPE_OPTION_WIDEN_SCOPE
    # Widen path needs the task_id (target of the update) AND a guess
    # at which tool_server_id to add. The model is free to override
    # the guess via mcp_assistant_list_mcp_servers, but we MUST give
    # it a starting point — without it the model might call
    # scheduling_update_task with no new servers and silently break
    # the user's intent.
    assert record.context.get("task_id") == "t-1"
    assert record.context.get("tool_server_id_guess") == "slack"


def test_out_of_scope_chip_rejects_unknown_option_id(gate):
    # Defense-in-depth: the renderer must not be able to inject an
    # arbitrary option_id like ``approve_forever`` to bypass the
    # security-bounded choices. The gate validates against the chip's
    # declared options and returns None (with a ``gate_bypass_attempted``
    # audit) for anything else.
    audit_calls: list[tuple[str, dict]] = []

    def capture(event: str, **fields):
        audit_calls.append((event, fields))

    gate.audit_log_fn = capture
    card = _propose_out_of_scope_chip(gate)
    record = gate.resolve_via_chip_click(
        chat_id="chat-oos",
        call_hash=card.hash,
        option_id="approve_forever",
    )
    assert record is None
    # And the gate must have logged the bypass attempt.
    assert any(
        event == "gate_bypass_attempted"
        and "unknown_chip_option:'approve_forever'" in fields.get("reason", "")
        for event, fields in audit_calls
    )


def test_dispatched_scheduled_pre_approved_is_a_known_audit_event():
    # The scheduled-run bypass path emits this event for every
    # auto-dispatched in-scope tool call. It MUST be in the gate's
    # known-event allow-list so the audit sink doesn't silently drop
    # it as "unknown event".
    assert "dispatched_scheduled_pre_approved" in tcg._AUDIT_EVENTS


# ---------------------------------------------------------------------------
# Round 4 / Issue 2 — per-user allowlist integration with the gate
# ---------------------------------------------------------------------------


def test_allowlist_lookup_dispatches_silently_when_match(registry_path):
    """When the lookup function returns True for (user_id,
    tool_name, mcp), the gate dispatches the destructive call
    WITHOUT emitting a chip and audits ``dispatched_user_allowlist``.
    """

    audit_calls: list[tuple[str, dict]] = []

    def capture(event: str, **fields):
        audit_calls.append((event, fields))

    def fake_lookup(*, user_id, tool_name, mcp):
        return (
            user_id == "user-1"
            and tool_name == "slack_conversations_add_message"
            and mcp == "slack"
        )

    gate = tcg.Gate(
        registry=tcg.Registry.load(path=registry_path),
        audit_log_fn=capture,
        allowlist_lookup_fn=fake_lookup,
    )
    decision = gate.evaluate_tool_call(
        chat_id="chat-1",
        user_id="user-1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "C1", "payload": "hi"},
    )
    assert decision.action == "dispatch"
    assert decision.card is None
    assert any(event == "dispatched_user_allowlist" for event, _ in audit_calls)


def test_allowlist_lookup_miss_still_emits_chip(registry_path):
    """A lookup that returns False MUST fall through to the chip
    flow — the allowlist is opt-in and silent failure is the
    expected behaviour for non-matching tools."""

    def deny_all_lookup(*, user_id, tool_name, mcp):
        return False

    gate = tcg.Gate(
        registry=tcg.Registry.load(path=registry_path),
        allowlist_lookup_fn=deny_all_lookup,
    )
    decision = gate.evaluate_tool_call(
        chat_id="chat-1",
        user_id="user-1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "C1", "payload": "hi"},
    )
    assert decision.action == "block"
    assert decision.card is not None


def test_allowlist_lookup_skipped_for_anonymous_user(registry_path):
    """If the gate is called without a ``user_id`` (e.g. legacy
    callers), the allowlist is bypassed entirely — there's no
    "user" to look up — and the chip flow runs as usual."""

    def lookup(*, user_id, tool_name, mcp):
        return True

    gate = tcg.Gate(
        registry=tcg.Registry.load(path=registry_path),
        allowlist_lookup_fn=lookup,
    )
    decision = gate.evaluate_tool_call(
        chat_id="chat-1",
        user_id=None,
        tool_name="slack_conversations_add_message",
        args={"channel_id": "C1", "payload": "hi"},
    )
    assert decision.action == "block"


def test_always_allow_chip_click_persists_via_writer(registry_path):
    """Clicking ``always_allow`` resolves the chip like ``approve``
    AND triggers ``allowlist_writer_fn`` with the chip's
    (user_id, tool_name, mcp) fingerprint."""

    writer_calls: list[dict] = []

    def writer(*, user_id, tool_name, mcp):
        writer_calls.append(
            {"user_id": user_id, "tool_name": tool_name, "mcp": mcp}
        )

    gate = tcg.Gate(
        registry=tcg.Registry.load(path=registry_path),
        allowlist_writer_fn=writer,
    )
    decision = gate.evaluate_tool_call(
        chat_id="chat-1",
        user_id="user-1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "C1", "payload": "hi"},
    )
    assert decision.card is not None
    record = gate.resolve_via_chip_click(
        chat_id="chat-1",
        call_hash=decision.card.hash,
        option_id=tcg.TOOL_CONFIRMATION_OPTION_ALWAYS_ALLOW,
    )
    assert record is not None
    assert record.decision == "approve"
    assert writer_calls == [
        {
            "user_id": "user-1",
            "tool_name": "slack_conversations_add_message",
            "mcp": "slack",
        }
    ]


def test_always_allow_writer_failure_does_not_break_resolution(registry_path):
    """If the writer raises (e.g. disk full), the user's chip click
    must STILL resolve into an approve — they get one-shot dispatch
    even though the persistent rule didn't take. Audit captures the
    failure."""

    audit_calls: list[tuple[str, dict]] = []

    def capture(event: str, **fields):
        audit_calls.append((event, fields))

    def writer(*, user_id, tool_name, mcp):
        raise RuntimeError("simulated disk failure")

    gate = tcg.Gate(
        registry=tcg.Registry.load(path=registry_path),
        audit_log_fn=capture,
        allowlist_writer_fn=writer,
    )
    decision = gate.evaluate_tool_call(
        chat_id="chat-1",
        user_id="user-1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "C1", "payload": "hi"},
    )
    record = gate.resolve_via_chip_click(
        chat_id="chat-1",
        call_hash=decision.card.hash,
        option_id=tcg.TOOL_CONFIRMATION_OPTION_ALWAYS_ALLOW,
    )
    assert record is not None
    assert record.decision == "approve"
    assert any(
        event == "always_allow_writer_failed" for event, _ in audit_calls
    )


def test_always_allow_chip_audits_persisted_event(registry_path):
    audit_calls: list[tuple[str, dict]] = []

    def capture(event: str, **fields):
        audit_calls.append((event, fields))

    gate = tcg.Gate(
        registry=tcg.Registry.load(path=registry_path),
        audit_log_fn=capture,
        allowlist_writer_fn=lambda **kwargs: None,
    )
    decision = gate.evaluate_tool_call(
        chat_id="chat-1",
        user_id="user-1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "C1", "payload": "hi"},
    )
    gate.resolve_via_chip_click(
        chat_id="chat-1",
        call_hash=decision.card.hash,
        option_id=tcg.TOOL_CONFIRMATION_OPTION_ALWAYS_ALLOW,
    )
    assert any(event == "always_allow_persisted" for event, _ in audit_calls)


def test_always_allow_audit_events_are_known():
    # Pin the new audit events so the gate's audit sink doesn't
    # drop them as "unknown event".
    for name in (
        "dispatched_user_allowlist",
        "always_allow_persisted",
        "always_allow_skipped_no_user",
        "always_allow_skipped_no_writer",
        "always_allow_writer_failed",
    ):
        assert name in tcg._AUDIT_EVENTS, name


def test_scheduled_run_diagnostic_audit_events_are_known():
    # Round 4 hotfix — diagnostic events emitted from the middleware
    # so an operator can grep audit logs to debug "why did the chip
    # show inside a scheduled-run sub-agent chat?". Both events are
    # benign-by-design (they fire on the destructive-tool path that
    # already audits) but must NOT trip the gate's "unknown audit
    # event" warning.
    for name in (
        "scheduled_run_scope_decision",
        "scheduled_run_meta_absent",
    ):
        assert name in tcg._AUDIT_EVENTS, name


def test_always_allow_option_id_is_in_audit_decision_map():
    # The resolver maps option ids to audit decision strings; if
    # ``always_allow`` slips out of this map the gate would log a
    # gate_bypass_attempted on legitimate clicks.
    assert (
        tcg.Gate._OPTION_ID_TO_AUDIT_DECISION[
            tcg.TOOL_CONFIRMATION_OPTION_ALWAYS_ALLOW
        ]
        == "approve"
    )
