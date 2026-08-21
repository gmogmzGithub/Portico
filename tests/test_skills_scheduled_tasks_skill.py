"""Structural assertions for the scheduled-tasks skill.

The skill's pre-flight section is a critical safety net for Phase 2 of
the chip rework: without it, the model can create tasks whose
``tool_server_ids`` reference offline integrations and the daemon
silently fails at execution time. These tests pin the SKILL.md
contract so a future edit can't accidentally drop the section.

We deliberately keep these tests at the structural level (regex-style
checks on the raw markdown) rather than functional — the model's
adherence is observed at runtime via the executor guardrail, which
has its own tests in scheduling-server.
"""

from __future__ import annotations

from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
SKILL_PATH = REPO_ROOT / "skills" / "scheduled-tasks" / "SKILL.md"


@pytest.fixture(scope="module")
def skill_text() -> str:
    return SKILL_PATH.read_text(encoding="utf-8")


def test_skill_includes_preflight_section_header(skill_text: str) -> None:
    assert "## Pre-flight Checks" in skill_text


def test_preflight_section_requires_list_mcp_servers_call(skill_text: str) -> None:
    # The first concrete step of the pre-flight is calling the
    # registry-listing tool. Without this, the model can't reason
    # about integration availability.
    assert "mcp_assistant_list_mcp_servers" in skill_text


def test_preflight_section_describes_diff_against_proposed_tool_server_ids(
    skill_text: str,
) -> None:
    # The skill must instruct the model to actually use the listing
    # response — not just call the tool and discard the result.
    assert "tool_server_ids" in skill_text
    assert "Diff against the proposed" in skill_text


def test_preflight_section_offers_activation_path_when_offline(skill_text: str) -> None:
    # When an integration is offline the model is supposed to OFFER
    # to activate it (not silently refuse OR silently proceed).
    assert "Should I start it" in skill_text or "activate" in skill_text.lower()


def test_preflight_section_refuses_to_create_unhealthy_task(skill_text: str) -> None:
    # The strongest invariant: the model MUST refuse to create the
    # task if the user declines activation, rather than soldiering on
    # with a half-broken scope.
    assert "REFUSE" in skill_text or "refuse" in skill_text


def test_preflight_section_warns_about_silent_midnight_failures(
    skill_text: str,
) -> None:
    # The "why this matters" callout is essential for the model to
    # understand the priority. Without it, models tend to treat the
    # pre-flight as optional polite-ness rather than a safety
    # invariant.
    assert "midnight" in skill_text.lower() or "without an interactive user" in skill_text


def test_preflight_extends_to_widen_path_for_scheduling_update_task(
    skill_text: str,
) -> None:
    # Phase 1's "widen task scope" path also adds tool_server_ids and
    # therefore must run the same pre-flight.
    assert "scheduling_update_task" in skill_text
    assert "widening scope" in skill_text or "widen scope" in skill_text


def test_preflight_requires_auth_state_check_round4(skill_text: str) -> None:
    """Round 4 / Issue 5c — the skill must instruct the model to
    inspect ``auth_state`` on each integration before creating a task.
    A merely-installed integration with an expired token is the
    silent-midnight-failure case the skill is supposed to prevent."""

    assert "auth_state" in skill_text, (
        "auth_state inspection must be in the pre-flight; without it the "
        "skill regresses to round-3 behaviour and integrations with expired "
        "tokens silently break scheduled runs."
    )
    # The skill must enumerate the auth states (named values) so the
    # model knows what 'good' looks like.
    assert "authenticated" in skill_text.lower()
    assert "expired" in skill_text.lower() or "not_authenticated" in skill_text


def test_preflight_round4_requires_clarification_chip_for_auth_failure(
    skill_text: str,
) -> None:
    """Round 4 / Issue 5c — for AUTH failures the skill MUST instruct
    the model to surface a clarification chip (with explicit options)
    rather than calling ``mcp_assistant_authorize_integration``
    directly. This preserves user agency and prevents surprise OAuth
    popups during what looks to the user like a benign 'create a
    task' request."""

    lowered = skill_text.lower()
    assert "clarification chip" in lowered, (
        "auth failure must trigger an explicit clarification chip — the "
        "model is forbidden from launching OAuth without first asking."
    )
    assert "do not call `mcp_assistant_authorize_integration`" in lowered or (
        "do not call mcp_assistant_authorize_integration" in lowered
    ), (
        "the skill must explicitly forbid calling authorize_integration "
        "directly from main chat without surfacing the chip."
    )


def test_preflight_round4_warns_about_subagent_oauth_guardrail(
    skill_text: str,
) -> None:
    """Round 4 / Issue 5b — the 'why this matters' callout must
    mention that sub-agent runs cannot initiate OAuth. Without this,
    the model might rationalise that 'the daemon will handle it' when
    in fact the gate will refuse the call."""

    lowered = skill_text.lower()
    assert (
        "sub-agent" in lowered or "subagent" in lowered
    ) and "oauth" in lowered, (
        "the skill must mention the sub-agent OAuth guardrail so the "
        "model doesn't punt auth issues to runtime."
    )


def test_required_mcp_servers_includes_scheduling(skill_text: str) -> None:
    # Sanity check that the YAML frontmatter still declares the
    # scheduling MCP server as required — without it none of the
    # tools the skill mentions are reachable.
    assert "required_mcp_servers" in skill_text
    assert "server:scheduling" in skill_text


def test_create_task_name_is_generated_from_instructions(skill_text: str) -> None:
    assert "concise 3-5 word task name" in skill_text
    assert "Do not ask the user to name it" in skill_text
    assert "`name`" in skill_text


def test_task_prompt_is_an_action_not_assumed_output(skill_text: str) -> None:
    assert "job specification for a future unattended agent" in skill_text
    assert "not the expected answer" in skill_text
    assert "Do not pre-write or fabricate" in skill_text
    assert 'use "me", "my", and "I" rather than "the user"' in skill_text
    assert '"Remind me to take a break"' in skill_text
    assert '"Remind the user to take a break"' in skill_text


def test_timezone_defaults_to_current_user_context(skill_text: str) -> None:
    assert "Use the current/injected user timezone by default rather than asking for it" in skill_text
    assert "If a genuinely material timezone ambiguity remains" in skill_text
    assert "### Timezone defaults" not in skill_text


def test_skills_activate_adhoc_without_user_configuration(skill_text: str) -> None:
    assert "Do not ask the user to choose skills" in skill_text
    assert "activate relevant skills ad hoc" in skill_text
    assert "Leave `skill_ids` empty by default" in skill_text
    assert "Skill activation does not grant new unattended integration permission" in skill_text


def test_common_user_task_failure_modes_are_covered(skill_text: str) -> None:
    assert "Resolve relative periods at execution time" in skill_text
    assert "For external side effects" in skill_text
    assert "For conditional monitoring, state both branches" in skill_text
    assert "Do not pre-write or fabricate" in skill_text
    assert "### Reminder failure mode" not in skill_text
    assert "### Common task patterns" not in skill_text
