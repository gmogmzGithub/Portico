"""Per-user persistent allowlist for the tool-confirmation gate.

Round 4 / Issue 2 — when the user clicks "Always allow" on a chip,
record the (tool_name, mcp) pair against the user's identity so the
gate can dispatch identical future calls silently. The user manages
the allowlist from the Settings "Allowlists" page; the gate reads it
at the start of every ``evaluate_tool_call`` and short-circuits
before surfacing a chip when there's a match AND the
per-chat-MCP-precedence check passes.

Storage model — keep it simple:

    <DATA_DIR>/tool-allowlists/<user_id>.json

Each user gets one JSON file with the shape::

    {
        "version": 1,
        "master_disabled": false,
        "entries": [
            {
                "id": "<uuid>",
                "tool_name": "slack_conversations_add_message",
                "mcp": "slack",
                "enabled": true,
                "created_at": "2026-04-29T12:00:00Z",
                "updated_at": "2026-04-29T12:00:00Z"
            },
            ...
        ]
    }

Rationale for file-backed (vs OWUI's SQLAlchemy / Alembic):

* The OWUI patches layer doesn't ship migrations — the upstream
  Alembic chain is owned by OWUI itself, and adding a fork-only
  table conflicts with their migration history on every rebase.
* The data is per-user-isolated (no cross-user joins) and small
  (typical single-digit entry counts), so a flat file is plenty.
* Atomic writes via ``write_json_atomic`` give us crash-safety
  without needing a transactional DB.
* The same machinery is used by the scheduling-server's
  ``TaskFileStore`` so operators already know how to back up /
  restore this directory.

Threat model:

* The directory and per-user files are written with mode 600 to
  prevent cross-user reads on shared hosts.
* The REST endpoints that call these helpers ALL go through
  ``get_verified_user`` and pass ``user.id`` from the verified
  identity — never from a request body field.
* Tool-name + mcp are the only fingerprint we match on; we
  intentionally do NOT match on the call-args hash because the
  user's intent ("always allow Slack messages from this app") is
  about the action class, not a single argument shape. The gate
  still hashes the args for audit purposes — every dispatched
  call still leaves a per-call audit line.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger(__name__)


_FILE_VERSION = 1
_DEFAULT_DIR_NAME = "tool-allowlists"

# Process-local lock so two concurrent REST requests for the same
# user don't lose updates. Cross-process safety relies on the
# atomic-rename write below — at worst, two writers stomp on each
# other and one set of updates is lost (unlikely in practice for
# user-driven Settings edits).
_FILE_LOCKS: dict[str, threading.Lock] = {}
_FILE_LOCKS_GUARD = threading.Lock()


def _lock_for(user_id: str) -> threading.Lock:
    with _FILE_LOCKS_GUARD:
        existing = _FILE_LOCKS.get(user_id)
        if existing is None:
            existing = threading.Lock()
            _FILE_LOCKS[user_id] = existing
        return existing


@dataclass
class ToolAllowlistEntry:
    """A single per-user allowlist row. ``id`` is a uuid4 so the
    Settings UI can address rows for delete / toggle independently
    of (tool_name, mcp). ``enabled=False`` means "exists but the
    user's master toggle says don't honour it" — kept on disk so a
    later master-toggle flip restores the prior fingerprint set
    instead of forcing the user to re-add every entry."""

    id: str
    tool_name: str
    mcp: str
    enabled: bool = True
    created_at: str = ""
    updated_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ToolAllowlistFile:
    """Whole-file shape on disk. ``master_disabled=True`` is the
    user's "kill switch" — the Settings page exposes this as the
    'Allowlists enabled' master toggle. Even if entries exist, none
    are honoured while master_disabled is True."""

    version: int = _FILE_VERSION
    master_disabled: bool = False
    entries: list[ToolAllowlistEntry] = field(default_factory=list)


def _utc_now_iso() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _resolve_storage_dir(data_dir: Optional[str | os.PathLike]) -> Path:
    """Decide where to put the per-user files.

    Tests pass ``data_dir`` directly. Production callers pass
    ``open_webui.config.DATA_DIR``. The ``portico_TOOL_ALLOWLIST_DIR``
    env var can override for local debugging without touching the
    chat data dir.
    """

    override = os.environ.get("portico_TOOL_ALLOWLIST_DIR")
    if override:
        return Path(override)
    if data_dir is None:
        # No data_dir given AND no override: return a local default
        # the caller can ignore. We don't crash here so module import
        # keeps working in environments without DATA_DIR.
        return Path.cwd() / _DEFAULT_DIR_NAME
    return Path(data_dir) / _DEFAULT_DIR_NAME


def _user_file_path(storage_dir: Path, user_id: str) -> Path:
    # Whitelist alnum + '-' + '_'. A user_id that contains anything
    # else (e.g. ``"../escape"``, ``"a/b"``, ``"x.y"``) is rejected
    # outright — silently stripping disallowed chars would let an
    # attacker collide with a different user's file by smuggling
    # path separators through a request.
    if not user_id or any(
        not (ch.isalnum() or ch in ("-", "_")) for ch in user_id
    ):
        raise ValueError(
            f"refusing to write allowlist for unsafe user_id={user_id!r}"
        )
    return storage_dir / f"{user_id}.json"


def _empty_file() -> ToolAllowlistFile:
    return ToolAllowlistFile()


def _file_to_dict(file: ToolAllowlistFile) -> dict[str, Any]:
    return {
        "version": file.version,
        "master_disabled": file.master_disabled,
        "entries": [entry.to_dict() for entry in file.entries],
    }


def _dict_to_file(raw: Any) -> ToolAllowlistFile:
    if not isinstance(raw, dict):
        return _empty_file()
    entries_raw = raw.get("entries")
    if not isinstance(entries_raw, list):
        entries_raw = []
    parsed_entries: list[ToolAllowlistEntry] = []
    for item in entries_raw:
        if not isinstance(item, dict):
            continue
        tool_name = str(item.get("tool_name") or "").strip()
        mcp = str(item.get("mcp") or "").strip()
        if not tool_name:
            continue
        parsed_entries.append(
            ToolAllowlistEntry(
                id=str(item.get("id") or uuid.uuid4().hex),
                tool_name=tool_name,
                mcp=mcp,
                enabled=bool(item.get("enabled", True)),
                created_at=str(item.get("created_at") or ""),
                updated_at=str(item.get("updated_at") or ""),
            )
        )
    return ToolAllowlistFile(
        version=int(raw.get("version") or _FILE_VERSION),
        master_disabled=bool(raw.get("master_disabled", False)),
        entries=parsed_entries,
    )


def _read_file(storage_dir: Path, user_id: str) -> ToolAllowlistFile:
    path = _user_file_path(storage_dir, user_id)
    if not path.is_file():
        return _empty_file()
    try:
        with open(path, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except (OSError, json.JSONDecodeError) as error:
        log.warning("[tool-allowlist] failed to read %s: %s", path, error)
        return _empty_file()
    return _dict_to_file(raw)


def _write_file(storage_dir: Path, user_id: str, file: ToolAllowlistFile) -> None:
    path = _user_file_path(storage_dir, user_id)
    storage_dir.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(".json.tmp")
    body = json.dumps(_file_to_dict(file), sort_keys=True, indent=2)
    with open(tmp_path, "w", encoding="utf-8") as handle:
        handle.write(body)
    os.replace(tmp_path, path)
    # Best-effort tighten the perms — a chmod failure on a hostile
    # filesystem doesn't break the write.
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def list_entries_for_user(
    *, user_id: str, data_dir: Optional[str | os.PathLike] = None
) -> ToolAllowlistFile:
    """Return the user's full allowlist file (entries + master toggle).
    Missing file = empty allowlist (NOT an error)."""

    storage_dir = _resolve_storage_dir(data_dir)
    return _read_file(storage_dir, user_id)


def upsert_entry_for_user(
    *,
    user_id: str,
    tool_name: str,
    mcp: str,
    enabled: bool = True,
    data_dir: Optional[str | os.PathLike] = None,
) -> ToolAllowlistEntry:
    """Add a new allowlist entry, or refresh ``updated_at`` /
    ``enabled`` on an existing one with the same (tool_name, mcp)
    fingerprint. Idempotent."""

    if not tool_name or not isinstance(tool_name, str):
        raise ValueError("tool_name must be a non-empty string")
    if mcp is None:
        mcp = ""

    storage_dir = _resolve_storage_dir(data_dir)
    with _lock_for(user_id):
        file = _read_file(storage_dir, user_id)
        now = _utc_now_iso()
        for entry in file.entries:
            if entry.tool_name == tool_name and entry.mcp == mcp:
                entry.enabled = enabled
                entry.updated_at = now
                _write_file(storage_dir, user_id, file)
                return entry
        new_entry = ToolAllowlistEntry(
            id=uuid.uuid4().hex,
            tool_name=tool_name,
            mcp=mcp,
            enabled=enabled,
            created_at=now,
            updated_at=now,
        )
        file.entries.append(new_entry)
        _write_file(storage_dir, user_id, file)
        return new_entry


def delete_entry_for_user(
    *,
    user_id: str,
    entry_id: str,
    data_dir: Optional[str | os.PathLike] = None,
) -> bool:
    """Remove a single entry by id. Returns True if an entry was
    removed (so the REST handler can return 204 vs 404)."""

    storage_dir = _resolve_storage_dir(data_dir)
    with _lock_for(user_id):
        file = _read_file(storage_dir, user_id)
        before = len(file.entries)
        file.entries = [entry for entry in file.entries if entry.id != entry_id]
        if len(file.entries) == before:
            return False
        _write_file(storage_dir, user_id, file)
        return True


def set_entry_enabled_for_user(
    *,
    user_id: str,
    entry_id: str,
    enabled: bool,
    data_dir: Optional[str | os.PathLike] = None,
) -> Optional[ToolAllowlistEntry]:
    """Toggle the per-row ``enabled`` flag without removing the
    entry. Returns the updated entry, or ``None`` if no entry with
    that id existed."""

    storage_dir = _resolve_storage_dir(data_dir)
    with _lock_for(user_id):
        file = _read_file(storage_dir, user_id)
        for entry in file.entries:
            if entry.id == entry_id:
                entry.enabled = enabled
                entry.updated_at = _utc_now_iso()
                _write_file(storage_dir, user_id, file)
                return entry
    return None


def set_master_disabled_for_user(
    *,
    user_id: str,
    master_disabled: bool,
    data_dir: Optional[str | os.PathLike] = None,
) -> ToolAllowlistFile:
    """Flip the user's master "Allowlists enabled" toggle. Returns
    the post-update file shape."""

    storage_dir = _resolve_storage_dir(data_dir)
    with _lock_for(user_id):
        file = _read_file(storage_dir, user_id)
        file.master_disabled = bool(master_disabled)
        _write_file(storage_dir, user_id, file)
        return file


def is_call_allowlisted_for_user(
    *,
    user_id: str,
    tool_name: str,
    mcp: str,
    data_dir: Optional[str | os.PathLike] = None,
) -> bool:
    """The gate's hot-path read: does this (tool_name, mcp) match an
    enabled entry in the user's allowlist AND the master toggle is
    off (i.e. allowlists ARE honoured)?

    Returns False on any data error so the gate falls back to the
    chip flow. We deliberately fail-closed here.
    """

    if not user_id or not tool_name:
        return False
    try:
        file = list_entries_for_user(user_id=user_id, data_dir=data_dir)
    except Exception:  # noqa: BLE001
        log.exception("[tool-allowlist] failure reading allowlist; failing closed")
        return False
    if file.master_disabled:
        return False
    for entry in file.entries:
        if not entry.enabled:
            continue
        if entry.tool_name == tool_name and entry.mcp == (mcp or ""):
            return True
    return False


__all__ = [
    "ToolAllowlistEntry",
    "ToolAllowlistFile",
    "delete_entry_for_user",
    "is_call_allowlisted_for_user",
    "list_entries_for_user",
    "set_entry_enabled_for_user",
    "set_master_disabled_for_user",
    "upsert_entry_for_user",
]
