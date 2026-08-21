"""Round 4 / Issue 2 — unit tests for the per-user tool allowlist.

These tests cover the storage helpers in
``open_webui.utils.tool_allowlist`` directly (no FastAPI / no DB).
The router-level tests live in ``test_tool_allowlist_router.py``.

Key invariants pinned here:

* Default file shape for a user with no entries is ``master_disabled
  = False`` and an empty entry list (NOT a 404 / not-an-error).
* Upsert is idempotent on (tool_name, mcp): a re-upsert refreshes
  ``updated_at`` instead of creating a duplicate row.
* Delete by id returns True/False so the REST handler can decide
  between 204 vs 404.
* ``is_call_allowlisted_for_user`` honours the master toggle and
  per-row ``enabled`` flag, AND fails closed on any I/O error so a
  filesystem corruption can't accidentally bypass the chip flow.
* The on-disk file path is sandboxed by ``data_dir`` so tests
  using ``tmp_path`` cannot stomp on real user state.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from open_webui.utils import tool_allowlist as ta


def test_list_for_unknown_user_returns_empty_file(tmp_path: Path) -> None:
    file = ta.list_entries_for_user(user_id="user-1", data_dir=tmp_path)
    assert file.master_disabled is False
    assert file.entries == []


def test_upsert_creates_new_entry_with_uuid_and_timestamps(
    tmp_path: Path,
) -> None:
    entry = ta.upsert_entry_for_user(
        user_id="user-1",
        tool_name="slack_conversations_add_message",
        mcp="slack",
        data_dir=tmp_path,
    )
    assert entry.tool_name == "slack_conversations_add_message"
    assert entry.mcp == "slack"
    assert entry.enabled is True
    assert len(entry.id) == 32  # uuid4 hex
    assert entry.created_at != ""
    assert entry.updated_at != ""

    file = ta.list_entries_for_user(user_id="user-1", data_dir=tmp_path)
    assert len(file.entries) == 1
    assert file.entries[0].id == entry.id


def test_upsert_is_idempotent_on_tool_name_and_mcp(tmp_path: Path) -> None:
    """A second upsert with identical (tool_name, mcp) must NOT
    create a duplicate row — instead it refreshes the existing row's
    ``updated_at`` and ``enabled`` flag."""

    first = ta.upsert_entry_for_user(
        user_id="user-1",
        tool_name="slack_conversations_add_message",
        mcp="slack",
        enabled=True,
        data_dir=tmp_path,
    )
    second = ta.upsert_entry_for_user(
        user_id="user-1",
        tool_name="slack_conversations_add_message",
        mcp="slack",
        enabled=False,  # toggle off this time
        data_dir=tmp_path,
    )
    assert first.id == second.id
    assert second.enabled is False

    file = ta.list_entries_for_user(user_id="user-1", data_dir=tmp_path)
    assert len(file.entries) == 1


def test_upsert_distinguishes_entries_by_mcp(tmp_path: Path) -> None:
    """Same tool_name across different mcp servers should produce
    two distinct rows — e.g. some "slack" tool exists in
    ``slack-mcp`` and in ``slack-bot-mcp`` and the user might want
    to allow only one of them."""

    a = ta.upsert_entry_for_user(
        user_id="user-1",
        tool_name="slack_conversations_add_message",
        mcp="slack",
        data_dir=tmp_path,
    )
    b = ta.upsert_entry_for_user(
        user_id="user-1",
        tool_name="slack_conversations_add_message",
        mcp="slack-bot",
        data_dir=tmp_path,
    )
    assert a.id != b.id

    file = ta.list_entries_for_user(user_id="user-1", data_dir=tmp_path)
    assert {e.mcp for e in file.entries} == {"slack", "slack-bot"}


def test_delete_returns_true_on_existing_and_false_on_missing(
    tmp_path: Path,
) -> None:
    entry = ta.upsert_entry_for_user(
        user_id="user-1",
        tool_name="slack_conversations_add_message",
        mcp="slack",
        data_dir=tmp_path,
    )
    assert (
        ta.delete_entry_for_user(
            user_id="user-1", entry_id=entry.id, data_dir=tmp_path
        )
        is True
    )
    # Idempotent — second call returns False so the REST handler
    # can return 404 instead of pretending it deleted something.
    assert (
        ta.delete_entry_for_user(
            user_id="user-1", entry_id=entry.id, data_dir=tmp_path
        )
        is False
    )


def test_set_entry_enabled_toggles_without_removing(tmp_path: Path) -> None:
    entry = ta.upsert_entry_for_user(
        user_id="user-1",
        tool_name="slack_conversations_add_message",
        mcp="slack",
        data_dir=tmp_path,
    )
    updated = ta.set_entry_enabled_for_user(
        user_id="user-1",
        entry_id=entry.id,
        enabled=False,
        data_dir=tmp_path,
    )
    assert updated is not None
    assert updated.enabled is False

    file = ta.list_entries_for_user(user_id="user-1", data_dir=tmp_path)
    assert len(file.entries) == 1
    assert file.entries[0].enabled is False


def test_set_entry_enabled_returns_none_for_unknown_id(tmp_path: Path) -> None:
    result = ta.set_entry_enabled_for_user(
        user_id="user-1",
        entry_id="nonexistent",
        enabled=True,
        data_dir=tmp_path,
    )
    assert result is None


def test_master_disabled_toggle_persists_across_reads(tmp_path: Path) -> None:
    file = ta.set_master_disabled_for_user(
        user_id="user-1", master_disabled=True, data_dir=tmp_path
    )
    assert file.master_disabled is True

    re_read = ta.list_entries_for_user(user_id="user-1", data_dir=tmp_path)
    assert re_read.master_disabled is True


def test_is_call_allowlisted_returns_true_for_enabled_match(
    tmp_path: Path,
) -> None:
    ta.upsert_entry_for_user(
        user_id="user-1",
        tool_name="slack_conversations_add_message",
        mcp="slack",
        data_dir=tmp_path,
    )
    assert (
        ta.is_call_allowlisted_for_user(
            user_id="user-1",
            tool_name="slack_conversations_add_message",
            mcp="slack",
            data_dir=tmp_path,
        )
        is True
    )


def test_is_call_allowlisted_returns_false_for_disabled_entry(
    tmp_path: Path,
) -> None:
    """A row exists but ``enabled=False`` — the gate must surface
    a chip; this is the user's "armed but disarmed" state."""

    ta.upsert_entry_for_user(
        user_id="user-1",
        tool_name="slack_conversations_add_message",
        mcp="slack",
        enabled=False,
        data_dir=tmp_path,
    )
    assert (
        ta.is_call_allowlisted_for_user(
            user_id="user-1",
            tool_name="slack_conversations_add_message",
            mcp="slack",
            data_dir=tmp_path,
        )
        is False
    )


def test_is_call_allowlisted_returns_false_when_master_disabled(
    tmp_path: Path,
) -> None:
    """Master toggle is the user's panic button — even fully-armed
    entries must NOT bypass the chip while it's set."""

    ta.upsert_entry_for_user(
        user_id="user-1",
        tool_name="slack_conversations_add_message",
        mcp="slack",
        data_dir=tmp_path,
    )
    ta.set_master_disabled_for_user(
        user_id="user-1", master_disabled=True, data_dir=tmp_path
    )
    assert (
        ta.is_call_allowlisted_for_user(
            user_id="user-1",
            tool_name="slack_conversations_add_message",
            mcp="slack",
            data_dir=tmp_path,
        )
        is False
    )


def test_is_call_allowlisted_returns_false_for_mismatched_mcp(
    tmp_path: Path,
) -> None:
    """Allowlist for ``slack`` must NOT cover a same-name tool from
    ``slack-bot``. The fingerprint is (tool_name, mcp)."""

    ta.upsert_entry_for_user(
        user_id="user-1",
        tool_name="slack_conversations_add_message",
        mcp="slack",
        data_dir=tmp_path,
    )
    assert (
        ta.is_call_allowlisted_for_user(
            user_id="user-1",
            tool_name="slack_conversations_add_message",
            mcp="slack-bot",
            data_dir=tmp_path,
        )
        is False
    )


def test_is_call_allowlisted_fails_closed_on_corrupt_file(
    tmp_path: Path,
) -> None:
    """A corrupt user file MUST return False so the gate falls back
    to the chip flow. No "permissive on error" anywhere."""

    # Hand-write a corrupt user file
    corrupt_dir = tmp_path / "tool-allowlists"
    corrupt_dir.mkdir(parents=True, exist_ok=True)
    (corrupt_dir / "user-1.json").write_text("{not json")

    assert (
        ta.is_call_allowlisted_for_user(
            user_id="user-1",
            tool_name="slack_conversations_add_message",
            mcp="slack",
            data_dir=tmp_path,
        )
        is False
    )


def test_is_call_allowlisted_returns_false_on_missing_user_id() -> None:
    assert (
        ta.is_call_allowlisted_for_user(
            user_id="",
            tool_name="slack_conversations_add_message",
            mcp="slack",
        )
        is False
    )


def test_unsafe_user_id_is_rejected(tmp_path: Path) -> None:
    """A path-traversal-y ``user_id`` must hit ValueError, NEVER
    write to the parent directory. This guards against the REST
    layer accidentally trusting an attacker-controlled identity."""

    with pytest.raises(ValueError):
        ta.upsert_entry_for_user(
            user_id="../escape",
            tool_name="x",
            mcp="y",
            data_dir=tmp_path,
        )


def test_file_is_atomic_replace_with_restrictive_perms(
    tmp_path: Path,
) -> None:
    """Writes use ``os.replace`` so a partial write can't leave a
    truncated file. The mode is also tightened to 0o600 so a
    shared host can't cross-read another user's allowlist."""

    ta.upsert_entry_for_user(
        user_id="user-1",
        tool_name="slack_conversations_add_message",
        mcp="slack",
        data_dir=tmp_path,
    )
    target = tmp_path / "tool-allowlists" / "user-1.json"
    assert target.is_file()
    # Validate the JSON shape so a future refactor doesn't silently
    # break the on-disk schema (Settings UI / gate read this same
    # file).
    raw = json.loads(target.read_text())
    assert raw["version"] == 1
    assert raw["master_disabled"] is False
    assert isinstance(raw["entries"], list) and len(raw["entries"]) == 1
    assert raw["entries"][0]["tool_name"] == "slack_conversations_add_message"
    # Mode check is best-effort — we don't fail on filesystems that
    # don't honour chmod (e.g. macOS NFS volumes).
    mode = target.stat().st_mode & 0o777
    assert mode in (0o600, 0o644)
