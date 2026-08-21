"""Scheduled-run scope binding for the per-action tool confirmation gate.

Phase 1 of the chip rework. Threat model item N-012, Option C
(pre-approved scope for scheduled runs). See
``docs/security-tool-confirmation.md`` and
``docs/_drafts/chip-rework-review-checklist.md`` for the design notes.

This module implements the policy half of the bypass:

* :func:`read_scheduled_run_metadata` — pull the daemon-stamped
  ``chat.meta`` block off the OWUI chat row and decide whether this
  chat is a scheduled-run sub-agent chat.
* :func:`tool_in_scheduled_scope` — membership check for a destructive
  tool call against the task's pre-approved tool_server_ids.
* :func:`propose_out_of_scope_clarification` — build the three-option
  clarification chip the user sees when the model tries to call an
  out-of-scope tool inside a scheduled-run chat.
* :func:`format_out_of_scope_resolution_line` — render the
  system-note line the model sees on the next turn AND apply the
  per-option side effects (mark approved hash, audit log).

The module avoids importing anything from the OWUI request stack so
the pure logic can be tested without standing up a FastAPI app. Only
the chat-record reader takes a callable indirection over
``Chats.get_chat_by_id`` so tests can substitute a fake.
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
from typing import Any, Callable, Optional, Tuple

from open_webui.utils.tool_confirmation_gate import (
    ChipOption,
    OUT_OF_SCOPE_OPTION_APPROVE_ONCE,
    OUT_OF_SCOPE_OPTION_BLOCK,
    OUT_OF_SCOPE_OPTION_WIDEN_SCOPE,
)


# Round 4 / Issue 5b — OAuth-initiating tool denylist for scheduled-run
# sub-agent chats. Sub-agents typically run unattended (cron-fired
# tasks at midnight, etc.) so initiating an OAuth flow inside one
# is meaningless: there's no human to consent. We refuse the call,
# abort the run with ``last_run_status: auth_required``, and surface
# an interactive auth-required clarification chip so the operator
# notices and can authenticate from the main app on next opening.
#
# Kept narrow — only the canonical authorize/setup tools belong here.
# A ``mcp_assistant_list_mcp_servers`` style read tool stays callable.
_OAUTH_INITIATING_TOOL_NAMES: frozenset[str] = frozenset(
    {
        "mcp_assistant_authorize_integration",
        "authorize_integration",
        # The skill activation flow can initiate OAuth as a side effect
        # when it activates an unauthenticated dependency, so the
        # guardrail covers it too. The skill activation tool itself is
        # not destructive but its OAuth side-effect breaks the
        # unattended-run invariant.
        "skills_activate_skill",
        "mcp_assistant_install_integration",
    }
)


def is_oauth_initiating_tool(tool_name: str) -> bool:
    """Return ``True`` for tools that, when invoked, can launch an
    OAuth flow / consent dialog. These must NOT be called from inside
    a scheduled-run sub-agent chat (Issue 5b)."""

    if not tool_name or not isinstance(tool_name, str):
        return False
    return tool_name in _OAUTH_INITIATING_TOOL_NAMES


def is_oauth_recovery_signal(payload: Any) -> bool:
    """Return ``True`` if a tool result indicates an OAuth-recovery
    flow is required.

    The shape produced by ``open_webui.utils.mcp_runtime`` for an
    OAuth-recovery error is::

        {
            "is_error": True,
            "oauth_recovery_required": True,
            "error": {"error_type": "oauth_recovery", ...},
            ...
        }

    We also accept the legacy ``recovery_hint == "oauth_required"``
    signal that integration-status payloads use, so both surfaces
    funnel into the same guardrail.
    """

    if not isinstance(payload, dict):
        return False
    if payload.get("oauth_recovery_required") is True:
        return True
    error = payload.get("error")
    if isinstance(error, dict):
        if error.get("error_type") == "oauth_recovery":
            return True
        if error.get("oauth_recovery_required") is True:
            return True
    if payload.get("recovery_hint") == "oauth_required":
        return True
    return False


# Round 4 / Issue 5b — option ids for the auth-required clarification
# chip surfaced inside a scheduled-run sub-agent chat. The user has two
# choices: stop the run (no auth attempted), or open the main app and
# re-authenticate (the auth flow happens THERE, not in the sub-agent).
AUTH_REQUIRED_OPTION_CANCEL_RUN = "auth_required_cancel_run"
AUTH_REQUIRED_OPTION_OPEN_AUTH = "auth_required_open_auth"

log = logging.getLogger(__name__)


# ``chat.meta`` keys stamped by the scheduling daemon. Kept in sync
# with ``src/core-mcp-rust/crates/scheduling-server/src/runtime.rs``
# (CHAT_META_RUN_ORIGIN_KEY etc).
CHAT_META_RUN_ORIGIN_KEY = "run_origin"
CHAT_META_RUN_ORIGIN_VALUE_SCHEDULED = "scheduled"
CHAT_META_TASK_ID_KEY = "scheduled_task_id"
CHAT_META_APPROVED_SCOPE_KEY = "scheduled_approved_scope"
SERVICE_USER_ID = "portico-service"
TRUSTED_BY_SERVICE_META_KEY = "scheduled_run_trusted_by_service"


def _extract_scheduled_meta_block(record: Any) -> Optional[dict[str, Any]]:
    """Return the scheduled-run ``meta`` dict from an OWUI ChatModel-shaped
    record, checking both possible locations.

    Why two locations?

    OWUI's ``ChatModel`` has both:

    * ``record.chat`` — the raw JSON blob the renderer / API works
      with. The scheduling daemon stamps the meta inside this blob
      via ``POST /api/v1/chats/new`` because ``ChatForm`` only
      accepts ``chat`` + ``folder_id`` (no top-level ``meta`` field).
      So the canonical write path lands here.
    * ``record.meta`` — a separate top-level SQLAlchemy column that
      OWUI uses for tags / sync state. ``insert_new_chat`` does NOT
      touch it, but a future upstream patch (or a custom code path
      that calls ``Chats.update_chat_by_id`` after creation) could
      surface the meta here. We check it as a fallback so a future
      OWUI version that consolidates meta into the top-level column
      doesn't silently break the chip-bypass.

    Read precedence: nested first (canonical write path), top-level
    second (fallback). The first one whose ``run_origin`` matches the
    scheduled-run sentinel wins.
    """

    nested_chat = getattr(record, "chat", None)
    if isinstance(nested_chat, dict):
        nested_meta = nested_chat.get("meta")
        if (
            isinstance(nested_meta, dict)
            and nested_meta.get(CHAT_META_RUN_ORIGIN_KEY)
            == CHAT_META_RUN_ORIGIN_VALUE_SCHEDULED
        ):
            return nested_meta
    top_meta = getattr(record, "meta", None)
    if (
        isinstance(top_meta, dict)
        and top_meta.get(CHAT_META_RUN_ORIGIN_KEY)
        == CHAT_META_RUN_ORIGIN_VALUE_SCHEDULED
    ):
        return top_meta
    return None


def _record_has_trusted_scheduled_marker(record: Any) -> bool:
    """Return whether a scheduled-run metadata block should be trusted.

    Legacy scheduled chats are service-owned; that remains trusted because
    only the scheduling daemon can create them with the service token. Newer
    scheduled chats are remapped into the human user's chat list at creation
    time, so they must carry a backend-only top-level marker set by the
    service create path. A user-editable nested ``chat.meta`` block alone is
    not enough to enable scheduled-run tool-scope bypass.
    """

    if getattr(record, "user_id", None) == SERVICE_USER_ID:
        return True
    top_meta = getattr(record, "meta", None)
    return isinstance(top_meta, dict) and top_meta.get(TRUSTED_BY_SERVICE_META_KEY) is True


def read_scheduled_run_metadata(
    chat_id: Optional[str],
    *,
    get_chat_by_id: Callable[[str], Any],
) -> Optional[dict[str, Any]]:
    """Return the scheduled-run binding stamped on ``chat.meta`` for a
    given chat, or ``None`` if the chat is not a scheduled-run chat.

    ``get_chat_by_id`` is the indirection seam: production callers pass
    ``open_webui.models.chats.Chats.get_chat_by_id``; tests pass a
    fake. The callable receives a single positional ``chat_id`` and
    must return either ``None`` or an object with a ``.chat`` attribute
    that is a dict.

    Returns a dict shaped like ``{"task_id": str, "approved_scope":
    set[str]}``. Defensively coerces malformed metadata to ``None``
    rather than raising — a corrupt meta block must not break chat.

    Read path: see :func:`_extract_scheduled_meta_block` for the
    nested-first / top-level-fallback rationale.
    """

    if not chat_id:
        return None
    try:
        record = get_chat_by_id(chat_id)
    except Exception:  # noqa: BLE001 — never break dispatch on a DB miss
        log.exception(
            "[scheduled-run-scope] failed to read chat metadata for chat_id=%s",
            chat_id,
        )
        return None
    if record is None:
        return None
    meta = _extract_scheduled_meta_block(record)
    if meta is None:
        return None
    if not _record_has_trusted_scheduled_marker(record):
        return None
    task_id = meta.get(CHAT_META_TASK_ID_KEY)
    if not isinstance(task_id, str) or not task_id:
        return None
    raw_scope = meta.get(CHAT_META_APPROVED_SCOPE_KEY)
    if isinstance(raw_scope, list):
        approved_scope: set[str] = {
            str(item) for item in raw_scope if isinstance(item, (str, int, float))
        }
    else:
        # Empty / missing scope still surfaces a chip on every
        # destructive call (a "scheduled but no scope" task is a real
        # configuration option — only the core / read-only tools were
        # whitelisted at creation time).
        approved_scope = set()
    return {"task_id": task_id, "approved_scope": approved_scope}


# Round 4 / Issue 3a — common ``tool_server_id`` suffixes to strip for
# alias normalization. The catalogues in ``mcp-configs/`` and the
# registry's ``mcp`` field don't always agree on whether to suffix
# ``-mcp`` / ``_mcp``: the user's task might be scoped to ``slack-mcp``
# while the registry classifies a destructive tool under ``slack``.
# Without normalization the in-scope check misses and the user gets a
# spurious out-of-scope chip even though their task is fully approved.
#
# Kept intentionally small (no regex, no wildcards). If the catalog
# grows a new naming convention, add a literal suffix here.
_ALIAS_STRIP_SUFFIXES: tuple[str, ...] = (
    "-mcp",
    "_mcp",
    "-server",
    "_server",
)


def _normalize_tool_server_alias(value: str) -> str:
    """Lower-case + strip known cosmetic suffixes (e.g. ``-mcp``,
    ``-mcp-server``).

    Returns the empty string for an empty / non-string input. This is
    a PURE display normalization — the alias map is not transitive (we
    don't infer that ``slack`` and ``slack_v2`` are the same MCP).

    Multi-pass stripping: we loop because real-world ids like
    ``slack-mcp-server`` need both ``-server`` and ``-mcp`` removed to
    collapse to the registry's canonical ``slack``. A single pass would
    only strip the outermost suffix and the in-scope check would still
    miss.
    """

    if not value or not isinstance(value, str):
        return ""
    s = value.strip().lower()
    if not s:
        return ""
    # Repeat until no known suffix matches. Bounded by len(s) so a
    # pathological input can't loop.
    for _ in range(len(_ALIAS_STRIP_SUFFIXES) + 2):
        stripped = False
        for suffix in _ALIAS_STRIP_SUFFIXES:
            if s.endswith(suffix) and len(s) > len(suffix):
                s = s[: -len(suffix)]
                stripped = True
                break
        if not stripped:
            break
    return s


def _normalize_scope(approved_scope: set[str]) -> set[str]:
    return {
        normalized
        for raw in approved_scope
        if (normalized := _normalize_tool_server_alias(raw))
    }


def tool_in_scheduled_scope(
    *,
    tool_name: str,
    tool_mcp: str,
    approved_scope: set[str],
) -> bool:
    """Return ``True`` if a destructive tool call is in the scheduled
    run's pre-approved scope.

    Membership is checked against:

    * ``tool_mcp`` — the registry's ``mcp`` label, e.g. ``"slack"`` or
      ``"google_workspace"``.
    * the leading underscore-prefix of ``tool_name`` — e.g.
      ``slack_conversations_add_message`` → ``"slack"``.

    Either match wins. The two-pronged check tolerates the historical
    drift where the registry uses a label ("google_workspace") that
    doesn't match the tool_server_id ("gmail") — at least one of them
    is likely to match a real entry in the user's task scope.

    Round 4 / Issue 3a — alias normalization. Both sides of the
    comparison are passed through :func:`_normalize_tool_server_alias`
    so cosmetic suffix differences (``slack-mcp`` vs ``slack``) match.
    """

    if not approved_scope:
        return False
    normalized_scope = _normalize_scope(approved_scope)
    if not normalized_scope:
        return False
    if tool_mcp:
        if _normalize_tool_server_alias(tool_mcp) in normalized_scope:
            return True
    if tool_name:
        prefix = tool_name.split("_", 1)[0]
        if prefix and _normalize_tool_server_alias(prefix) in normalized_scope:
            return True
    return False


def propose_out_of_scope_clarification(
    *,
    gate,
    chat_id: str,
    user_id: Optional[str],
    task_id: str,
    tool_name: str,
    tool_mcp: str,
    tool_args: Any,
    tool_summary: str,
    original_hash: str,
):
    """Build and register the out-of-scope clarification chip on
    ``gate``. Returns the proposed Card or ``None`` on failure.

    The chip carries three security-bounded options:

    * ``out_of_scope_block`` — block this run.
    * ``out_of_scope_approve_once`` — approve this single call.
    * ``out_of_scope_widen_scope`` — approve + widen task scope.

    A "never ask again" option is intentionally NOT offered: it would
    let a model accumulate persistent silent capability via a single
    clarification turn and defeats N-012's per-action invariant.
    """

    tool_server_id_guess = tool_mcp or (
        tool_name.split("_", 1)[0] if tool_name else ""
    )

    options = [
        ChipOption(
            id=OUT_OF_SCOPE_OPTION_BLOCK,
            label="Block this run",
            style="danger",
        ),
        ChipOption(
            id=OUT_OF_SCOPE_OPTION_APPROVE_ONCE,
            label="Approve once for this run",
            style="primary",
        ),
        ChipOption(
            id=OUT_OF_SCOPE_OPTION_WIDEN_SCOPE,
            label=(
                f"Approve + always allow {tool_server_id_guess}"
                if tool_server_id_guess
                else "Approve + widen task scope"
            ),
            style="secondary",
        ),
    ]

    prompt = (
        f"Scheduled task {task_id!r} is trying to call a tool outside its "
        f"pre-approved scope: {tool_name}"
        + (f" ({tool_mcp})" if tool_mcp else "")
        + ". "
        f"Originally approved tools do not include this one. {tool_summary}"
    )

    try:
        return gate.propose_clarification(
            chat_id=chat_id,
            user_id=user_id,
            prompt=prompt,
            options=options,
            allow_freeform=False,
            context={
                "out_of_scope": True,
                "task_id": task_id,
                "tool_name": tool_name,
                "tool_mcp": tool_mcp,
                "tool_args": tool_args,
                "tool_summary": tool_summary,
                "tool_server_id_guess": tool_server_id_guess,
                "original_hash": original_hash,
            },
        )
    except Exception:  # noqa: BLE001
        log.exception(
            "[scheduled-run-scope] failed to propose out-of-scope chip"
        )
        return None


def propose_auth_required_clarification(
    *,
    gate,
    chat_id: str,
    user_id: Optional[str],
    task_id: str,
    tool_server_id: str,
    tool_name: str,
    reason: str,
):
    """Round 4 / Issue 5b — propose the auth-required clarification
    chip in a scheduled-run sub-agent chat after a tool-response
    signals OAuth recovery is needed (or after the model attempts an
    OAuth-initiating tool call).

    The chip carries TWO options:

    * ``auth_required_cancel_run`` — stop the run cleanly. The
      executor will re-classify the run as
      ``LastRunStatus::AuthRequired``.
    * ``auth_required_open_auth`` — surfaces a hint to the user that
      they need to open the main app (NOT the sub-agent chat) and
      authenticate the integration. The auth flow itself happens in
      the main UI; this option is purely a navigation cue.

    A "retry now" option is intentionally NOT offered — the sub-agent
    can't usefully retry without first having auth, and we don't want
    to invite OAuth-flow initiation from inside the sub-agent.

    Returns the proposed Card or ``None`` on failure.
    """

    options = [
        ChipOption(
            id=AUTH_REQUIRED_OPTION_OPEN_AUTH,
            label=f"Open app to authenticate {tool_server_id}",
            style="primary",
        ),
        ChipOption(
            id=AUTH_REQUIRED_OPTION_CANCEL_RUN,
            label="Cancel run",
            style="danger",
        ),
    ]

    prompt = (
        f"Scheduled task {task_id!r} cannot continue: integration "
        f"{tool_server_id!r} needs authentication ({reason}). "
        "Sub-agent runs cannot start an OAuth flow on their own — please "
        "authenticate from the main app, then run the task again."
    )

    try:
        return gate.propose_clarification(
            chat_id=chat_id,
            user_id=user_id,
            prompt=prompt,
            options=options,
            allow_freeform=False,
            context={
                "auth_required": True,
                "task_id": task_id,
                "tool_server_id": tool_server_id,
                "tool_name": tool_name,
                "reason": reason,
            },
        )
    except Exception:  # noqa: BLE001
        log.exception(
            "[scheduled-run-scope] failed to propose auth-required chip"
        )
        return None


def _format_args(args: Any) -> str:
    """Compact, deterministic JSON encoding (matches the gate's hash
    canonicalization). Used for the system note so the model has a
    byte-for-byte recipe of the args to re-emit."""

    try:
        return json.dumps(args, sort_keys=True, separators=(", ", ": "))
    except (TypeError, ValueError):
        return repr(args)


_MCPO_SCHEDULING_PATH_PREFIX = "/scheduling"


def _post_mcpo_scheduling_tool_sync(
    *,
    mcpo_base_url: str,
    tool_name: str,
    payload: dict[str, Any],
    timeout_seconds: float = 5.0,
) -> Tuple[Optional[dict[str, Any]], Optional[str]]:
    """Sync POST to the scheduling-server MCP behind the mcpo-core
    HTTP proxy. Returns ``(parsed_response, None)`` on success or
    ``(None, error_string)`` on any failure.

    Round 4 / Issue 3b — the middleware actuates ``scheduling_update_task``
    itself for the WIDEN-SCOPE option so the user's choice produces the
    persisted change even when the sub-agent doesn't have the tool
    available in its registry. urllib (no external deps) keeps this
    callable from a sync code path.
    """

    base = (mcpo_base_url or "").rstrip("/")
    if not base:
        return None, "missing mcpo base url"
    url = f"{base}{_MCPO_SCHEDULING_PATH_PREFIX}/{tool_name}"
    body_bytes = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body_bytes,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            status = getattr(response, "status", None)
            raw = response.read().decode("utf-8")
            if status is not None and (status < 200 or status >= 300):
                return None, f"HTTP {status}: {raw[:200]}"
            try:
                return json.loads(raw), None
            except (ValueError, json.JSONDecodeError) as parse_error:
                return None, f"invalid JSON response: {parse_error}"
    except urllib.error.HTTPError as http_error:  # pragma: no cover -- exercised via fake actuator
        return None, f"HTTP {http_error.code}: {http_error.reason}"
    except (urllib.error.URLError, TimeoutError) as transport_error:  # pragma: no cover
        return None, f"transport error: {transport_error}"
    except Exception as error:  # noqa: BLE001 -- broad to keep the gate path resilient
        return None, f"unexpected error: {error!r}"


def widen_scheduled_task_scope_via_mcpo(
    *,
    task_id: str,
    tool_server_id_to_add: str,
    mcpo_base_url: str,
    actuator: Optional[
        Callable[..., Tuple[Optional[dict[str, Any]], Optional[str]]]
    ] = None,
) -> dict[str, Any]:
    """Round 4 / Issue 3b — append ``tool_server_id_to_add`` to a
    scheduled task's ``tool_server_ids`` via the scheduling-server's
    MCP HTTP surface (mcpo-core).

    Returns a result dict with one of three shapes:

    * ``{"status": "widened", "tool_server_ids": [...]}`` — the id was
      not previously in scope; the persisted task now includes it.
    * ``{"status": "already_in_scope", "tool_server_ids": [...]}`` —
      the id was already there; no write was needed.
    * ``{"status": "failed", "error": "..."}`` — something went wrong
      (the caller should fall back to instructing the model to call
      ``scheduling_update_task`` itself).

    ``actuator`` is the test seam — production wiring uses
    :func:`_post_mcpo_scheduling_tool_sync`. Unit tests pass a fake
    that asserts the expected call shape and returns a canned
    response.
    """

    if not task_id or not isinstance(task_id, str):
        return {"status": "failed", "error": "missing task_id"}
    if not tool_server_id_to_add or not isinstance(tool_server_id_to_add, str):
        return {"status": "failed", "error": "missing tool_server_id"}

    poster = actuator or _post_mcpo_scheduling_tool_sync

    fetched, fetch_error = poster(
        mcpo_base_url=mcpo_base_url,
        tool_name="get_task",
        payload={"task_id": task_id},
    )
    if fetch_error or not isinstance(fetched, dict):
        return {
            "status": "failed",
            "error": f"get_task failed: {fetch_error or 'no response'}",
        }
    existing = fetched.get("tool_server_ids")
    if not isinstance(existing, list):
        existing = []
    # Idempotent: dedupe by exact string match (ALSO normalize so
    # ``slack`` and ``slack-mcp`` don't both end up in the list when
    # they alias the same integration). The first occurrence wins.
    normalized_seen: set[str] = set()
    deduped: list[str] = []
    for entry in existing:
        if not isinstance(entry, str):
            continue
        key = _normalize_tool_server_alias(entry)
        if key in normalized_seen:
            continue
        normalized_seen.add(key)
        deduped.append(entry)

    add_key = _normalize_tool_server_alias(tool_server_id_to_add)
    if add_key in normalized_seen:
        return {"status": "already_in_scope", "tool_server_ids": deduped}

    updated_ids = list(deduped) + [tool_server_id_to_add]
    updated, update_error = poster(
        mcpo_base_url=mcpo_base_url,
        tool_name="update_task",
        payload={"task_id": task_id, "tool_server_ids": updated_ids},
    )
    if update_error or not isinstance(updated, dict):
        return {
            "status": "failed",
            "error": f"update_task failed: {update_error or 'no response'}",
        }
    return {"status": "widened", "tool_server_ids": updated_ids}


def format_out_of_scope_resolution_line(
    *,
    idx: int,
    record,
    gate,
    chat_id: str,
    widen_actuation_result: Optional[dict[str, Any]] = None,
) -> Optional[str]:
    """Build the system-note line for one out-of-scope clarification
    resolution AND apply its side effects (mark approved hash, audit).

    Round 4 / Issue 3b — when ``widen_actuation_result`` is supplied
    (the middleware called :func:`widen_scheduled_task_scope_via_mcpo`
    BEFORE invoking us) the rendered line for the WIDEN option tells
    the model to ONLY re-emit the original tool call. The scope
    persistence is no longer the model's responsibility, fixing the
    "I don't have a scheduling_update_task tool available" dead-end.

    When ``widen_actuation_result`` is ``None`` or its status is
    ``failed`` we fall back to the legacy two-step instruction (model
    calls ``scheduling_update_task`` then re-emits) so a transient
    HTTP failure between OWUI and mcpo doesn't leave the user with no
    path forward.

    Returns ``None`` if the option is unrecognised; the caller should
    skip the entry rather than crash the batch.
    """

    option = record.option_id or record.effective_option_id
    ctx = record.context or {}
    task_id = ctx.get("task_id") or "(unknown)"
    tool_name = ctx.get("tool_name") or record.tool_name or "(unknown tool)"
    tool_server_id_guess = (
        ctx.get("tool_server_id_guess") or ctx.get("tool_mcp") or ""
    )
    original_hash = ctx.get("original_hash") or record.call_hash
    original_args = ctx.get("tool_args")

    if option == OUT_OF_SCOPE_OPTION_BLOCK:
        gate._audit(
            "cancelled",
            chat_id=chat_id,
            tool_name=tool_name,
            mcp=ctx.get("tool_mcp", ""),
            hash=original_hash,
            reason="out_of_scope_block",
            task_id=task_id,
        )
        return (
            f"{idx}. OUT-OF-SCOPE BLOCK — the user blocked `{tool_name}` "
            f"because it is outside scheduled task {task_id!r}'s pre-approved "
            f"scope. Do NOT re-emit. Acknowledge in plain text that the "
            f"action was blocked and stop the run; offer the user a clear "
            f"summary of what was attempted and what the next step would be "
            f"if they want to retry under a different task."
        )

    if option == OUT_OF_SCOPE_OPTION_APPROVE_ONCE:
        if original_hash:
            gate._mark_approved(chat_id, original_hash)
            gate._audit(
                "approved",
                chat_id=chat_id,
                tool_name=tool_name,
                mcp=ctx.get("tool_mcp", ""),
                hash=original_hash,
                reason="out_of_scope_approve_once",
                task_id=task_id,
            )
        args_blob = _format_args(original_args)
        return (
            f"{idx}. OUT-OF-SCOPE APPROVED ONCE — the user approved "
            f"`{tool_name}` for THIS run only. Re-emit `{tool_name}` with "
            f"EXACTLY these arguments (byte-identical so the approval "
            f"hash matches): {args_blob}. Do NOT call "
            f"`scheduling_update_task` — the user did not widen the task "
            f"scope, only allowed this single call."
        )

    if option == OUT_OF_SCOPE_OPTION_WIDEN_SCOPE:
        if original_hash:
            gate._mark_approved(chat_id, original_hash)
            gate._audit(
                "approved",
                chat_id=chat_id,
                tool_name=tool_name,
                mcp=ctx.get("tool_mcp", ""),
                hash=original_hash,
                reason="out_of_scope_widen_scope",
                task_id=task_id,
                tool_server_id=tool_server_id_guess,
            )
        args_blob = _format_args(original_args)

        # Round 4 / Issue 3b — middleware actuated the scope widening
        # itself (or tried to). Tailor the system-note to whichever
        # outcome we got so the model knows what's left for it to do.
        actuation_status = (
            (widen_actuation_result or {}).get("status") if widen_actuation_result else None
        )

        if actuation_status in {"widened", "already_in_scope"}:
            persistence_note = (
                "The middleware has ALREADY persisted the wider scope "
                f"(tool_server_id={tool_server_id_guess!r} is now in the "
                f"task's `tool_server_ids`). Do NOT call "
                "`scheduling_update_task` yourself."
                if actuation_status == "widened"
                else (
                    f"The integration {tool_server_id_guess!r} was already "
                    "in the task's pre-approved scope (the user's chip "
                    "ack just confirmed they're happy with that). Do NOT "
                    "call `scheduling_update_task`."
                )
            )
            return (
                f"{idx}. OUT-OF-SCOPE WIDEN — the user approved "
                f"`{tool_name}` AND the task's scope has been widened. "
                f"{persistence_note} Re-emit `{tool_name}` with EXACTLY "
                f"these arguments: {args_blob}. The approval is "
                f"hash-bound, so any deviation produces a fresh chip."
            )

        # Either we didn't try to actuate (no mcpo url available) or
        # it failed (HTTP error, timeout). Fall back to the legacy
        # two-step instruction so the user still gets a path forward.
        if actuation_status == "failed":
            failure_detail = (widen_actuation_result or {}).get("error") or "(unknown)"
            log.warning(
                "[scheduled-run-scope] middleware widen actuation failed for "
                "task_id=%s tool_server_id=%s: %s",
                task_id,
                tool_server_id_guess,
                failure_detail,
            )

        return (
            f"{idx}. OUT-OF-SCOPE WIDEN — the user approved `{tool_name}` "
            f"AND wants the scheduled task's scope widened so future runs "
            f"don't re-prompt. Take TWO actions in this order:\n"
            f"   (a) Call `scheduling_update_task` with task_id={task_id!r} "
            f"to ADD {tool_server_id_guess!r} to the task's "
            f"`tool_server_ids` (preserve any existing ids — append, do "
            f"not replace). If {tool_server_id_guess!r} is not the right "
            f"server id for this tool, pick the correct one from "
            f"`mcp_assistant_list_mcp_servers` first.\n"
            f"   (b) Then re-emit `{tool_name}` with EXACTLY these "
            f"arguments: {args_blob}. The approval is hash-bound, so any "
            f"deviation produces a fresh chip."
        )

    log.warning(
        "[scheduled-run-scope] resolution carried unexpected option_id=%r "
        "for hash=%s task_id=%s",
        option,
        record.call_hash,
        task_id,
    )
    return None


__all__ = [
    "AUTH_REQUIRED_OPTION_CANCEL_RUN",
    "AUTH_REQUIRED_OPTION_OPEN_AUTH",
    "CHAT_META_APPROVED_SCOPE_KEY",
    "CHAT_META_RUN_ORIGIN_KEY",
    "CHAT_META_RUN_ORIGIN_VALUE_SCHEDULED",
    "CHAT_META_TASK_ID_KEY",
    "format_out_of_scope_resolution_line",
    "is_oauth_initiating_tool",
    "is_oauth_recovery_signal",
    "propose_auth_required_clarification",
    "propose_out_of_scope_clarification",
    "read_scheduled_run_metadata",
    "tool_in_scheduled_scope",
    "widen_scheduled_task_scope_via_mcpo",
    "_normalize_tool_server_alias",
    "_ALIAS_STRIP_SUFFIXES",
]
