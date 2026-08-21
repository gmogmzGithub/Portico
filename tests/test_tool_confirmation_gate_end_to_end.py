"""End-to-end harness for the tool-confirmation gate.

Stands up a fake destructive MCP tool dispatcher, drives a synthetic
chat turn through the gate's full lifecycle (propose -> resolve user
reply -> dispatch), and asserts that the dispatcher is invoked ONLY
after a user-confirmed approval reaches the gate. This is the test that
the original Slack incident would have caught: with the gate in place,
the model's "draft + send" pattern can no longer dispatch on a stale
"yes".

Backs scenarios L-18 (no-confirmation -> no dispatch), L-19 (confirm
-> dispatch), L-20 (token replay safety), G-31 (multi-call batches).
"""

from __future__ import annotations

import importlib.util
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
        "tool_confirmation_gate_e2e", MODULE_PATH
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


tcg = _load_gate_module()


class _FakeDispatcher:
    """Stand-in for the upstream MCP / OpenAPI tool dispatcher.

    Records every dispatch the gate authorizes, so tests can assert the
    exact sequence and arguments. This is the unit a real dispatch site
    inside ``call_mcp_tool_with_runtime_headers`` would call into; the
    gate's job is to intercept BEFORE that call happens.
    """

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    def __call__(self, tool_name: str, args: dict) -> dict:
        self.calls.append((tool_name, dict(args)))
        return {"ok": True, "tool": tool_name}


def _gated_dispatch(gate, dispatcher, *, chat_id, user_id, tool_name, args, confirmation_token=None):
    """Mirror the integration in middleware.py's ``_apply_tool_confirmation_gate``:
    consult the gate, and only forward to the dispatcher when the gate
    authorizes dispatch. Returns the dispatcher's result OR a sentinel
    describing why the gate refused.
    """

    decision = gate.evaluate_tool_call(
        chat_id=chat_id,
        user_id=user_id,
        tool_name=tool_name,
        args=args,
        confirmation_token=confirmation_token,
    )
    if decision.action == "dispatch":
        return dispatcher(tool_name, args)
    if decision.action == "block":
        return {"gate": "blocked", "card_hash": decision.card.hash}
    return {"gate": "rejected", "reason": decision.reject_reason}


@pytest.fixture()
def gate():
    return tcg.Gate()


@pytest.fixture()
def dispatcher():
    return _FakeDispatcher()


# ---------------------------------------------------------------------------
# L-18: no confirmation, no dispatch
# ---------------------------------------------------------------------------


def test_first_destructive_call_never_dispatches(gate, dispatcher):
    result = _gated_dispatch(
        gate,
        dispatcher,
        chat_id="c1",
        user_id="u1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "D9", "payload": "hi"},
    )
    assert result["gate"] == "blocked"
    assert dispatcher.calls == []
    assert gate.has_pending("c1") is True


# ---------------------------------------------------------------------------
# L-19: explicit confirmation, then dispatch
# ---------------------------------------------------------------------------


def test_yes_after_propose_results_in_one_dispatch(gate, dispatcher):
    blocked = _gated_dispatch(
        gate,
        dispatcher,
        chat_id="c1",
        user_id="u1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "D9", "payload": "hi"},
    )
    assert blocked["gate"] == "blocked"

    # User says "yes". The gate's resolver marks the matching hash as
    # approved.
    outcome = gate.resolve_user_reply(chat_id="c1", user_text="yes")
    assert outcome.decision == "approve"

    # Model re-emits the same call (no token in the params — it doesn't
    # know about the token mechanism). Gate sees the pre-approved hash
    # and dispatches.
    result = _gated_dispatch(
        gate,
        dispatcher,
        chat_id="c1",
        user_id="u1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "D9", "payload": "hi"},
    )
    assert result == {"ok": True, "tool": "slack_conversations_add_message"}
    assert dispatcher.calls == [
        (
            "slack_conversations_add_message",
            {"channel_id": "D9", "payload": "hi"},
        )
    ]


# ---------------------------------------------------------------------------
# L-20: hash binding survives argument drift after approval
# ---------------------------------------------------------------------------


def test_approval_does_not_authorize_a_different_payload(gate, dispatcher):
    _gated_dispatch(
        gate,
        dispatcher,
        chat_id="c1",
        user_id="u1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "D9", "payload": "hi"},
    )
    gate.resolve_user_reply(chat_id="c1", user_text="yes")

    # Model pivots to a different payload. The approved hash binds to the
    # ORIGINAL args, so this call must block again.
    result = _gated_dispatch(
        gate,
        dispatcher,
        chat_id="c1",
        user_id="u1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "D9", "payload": "EVIL CONTENT"},
    )
    assert result["gate"] == "blocked"
    assert dispatcher.calls == []


def test_approval_does_not_authorize_a_different_destination(gate, dispatcher):
    _gated_dispatch(
        gate,
        dispatcher,
        chat_id="c1",
        user_id="u1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "D9", "payload": "hi"},
    )
    gate.resolve_user_reply(chat_id="c1", user_text="yes")

    result = _gated_dispatch(
        gate,
        dispatcher,
        chat_id="c1",
        user_id="u1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "DIFFERENT_CHANNEL", "payload": "hi"},
    )
    assert result["gate"] == "blocked"
    assert dispatcher.calls == []


# ---------------------------------------------------------------------------
# Stale-yes safety — the original Slack incident's exact failure mode
# ---------------------------------------------------------------------------


def test_planning_yes_far_from_propose_does_not_dispatch(gate, dispatcher):
    """User said 'yes' to a planning question several turns ago. Now the
    model decides on its own to send a Slack message. With the gate, the
    pending action exists only AFTER the model proposes — the planning
    yes happened before that, so it leaves no consent residue. New
    destructive call must still block."""

    # Several earlier user turns, none of which produced a pending action.
    gate.resolve_user_reply(chat_id="c1", user_text="yes")  # to a plan
    gate.consume_user_turn("c1")
    gate.resolve_user_reply(chat_id="c1", user_text="yes")  # again
    gate.consume_user_turn("c1")

    # Now the model wakes up and tries to send a message. No pending,
    # no approved hashes -> must block.
    result = _gated_dispatch(
        gate,
        dispatcher,
        chat_id="c1",
        user_id="u1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "D9", "payload": "hi"},
    )
    assert result["gate"] == "blocked"
    assert dispatcher.calls == []


# ---------------------------------------------------------------------------
# G-31: multi-call batch — each call needs its own approval
# ---------------------------------------------------------------------------


def test_multi_call_batch_requires_per_call_approval(gate, dispatcher):
    a = _gated_dispatch(
        gate,
        dispatcher,
        chat_id="c1",
        user_id="u1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "D9", "payload": "msg-A"},
    )
    b = _gated_dispatch(
        gate,
        dispatcher,
        chat_id="c1",
        user_id="u1",
        tool_name="gmail_send_message",
        args={"to": ["x@y"], "subject": "hi", "body": "msg-B"},
    )
    assert a["gate"] == "blocked"
    assert b["gate"] == "blocked"
    assert dispatcher.calls == []

    # Ambiguous "yes" must NOT approve either, because the user can't have
    # been talking about both at once.
    gate.resolve_user_reply(chat_id="c1", user_text="yes")
    a2 = _gated_dispatch(
        gate,
        dispatcher,
        chat_id="c1",
        user_id="u1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "D9", "payload": "msg-A"},
    )
    b2 = _gated_dispatch(
        gate,
        dispatcher,
        chat_id="c1",
        user_id="u1",
        tool_name="gmail_send_message",
        args={"to": ["x@y"], "subject": "hi", "body": "msg-B"},
    )
    assert a2["gate"] == "blocked"
    assert b2["gate"] == "blocked"
    assert dispatcher.calls == []


# ---------------------------------------------------------------------------
# Read-only bypass — confirmed end-to-end
# ---------------------------------------------------------------------------


def test_read_tools_pass_through_without_user_input(gate, dispatcher):
    result = _gated_dispatch(
        gate,
        dispatcher,
        chat_id="c1",
        user_id="u1",
        tool_name="slack_conversations_search_messages",
        args={"query": "incident"},
    )
    assert result == {"ok": True, "tool": "slack_conversations_search_messages"}
    assert dispatcher.calls == [
        ("slack_conversations_search_messages", {"query": "incident"})
    ]


# ---------------------------------------------------------------------------
# Cancellation drops pending and never dispatches
# ---------------------------------------------------------------------------


def test_explicit_no_after_propose_blocks_dispatch(gate, dispatcher):
    _gated_dispatch(
        gate,
        dispatcher,
        chat_id="c1",
        user_id="u1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "D9", "payload": "hi"},
    )
    outcome = gate.resolve_user_reply(chat_id="c1", user_text="no")
    assert outcome.decision == "cancel"

    # Model re-tries -> blocked again, never dispatches.
    result = _gated_dispatch(
        gate,
        dispatcher,
        chat_id="c1",
        user_id="u1",
        tool_name="slack_conversations_add_message",
        args={"channel_id": "D9", "payload": "hi"},
    )
    assert result["gate"] == "blocked"
    assert dispatcher.calls == []
