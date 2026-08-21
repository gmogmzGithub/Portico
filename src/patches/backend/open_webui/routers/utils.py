import logging
import markdown
from typing import Optional

from open_webui.models.chats import ChatTitleMessagesForm, Chats
from open_webui.config import DATA_DIR, ENABLE_ADMIN_EXPORT
from open_webui.constants import ERROR_MESSAGES
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field
from starlette.responses import FileResponse


from open_webui.utils.misc import get_gravatar_url
from open_webui.utils.pdf_generator import PDFGenerator
from open_webui.utils.auth import get_admin_user, get_verified_user
from open_webui.utils.tool_confirmation_gate import default_gate as default_tool_confirmation_gate


log = logging.getLogger(__name__)

router = APIRouter()


# PORTICO PATCH: feature toggle helpers. Both the chip-resolve endpoint
# and the per-user tool-allowlist endpoints belong to the per-action
# confirmation feature added in commits bbbb6aba / 1c483ca6 / 845cfc98.
# The toggle lives in ``optimization_flags.json`` so the Settings tab
# (frontend) and the routes (here) can be disabled in lockstep without
# ripping the code out. Defaults stay ON so omitting the flag is a
# no-op.
def _confirmation_gate_enabled() -> bool:
    from open_webui.utils.middleware import _optimization_flag_enabled

    return _optimization_flag_enabled("tool_confirmation_gate", default=True)


def _tool_allowlist_enabled() -> bool:
    from open_webui.utils.middleware import _optimization_flag_enabled

    return _optimization_flag_enabled("tool_allowlist", default=True)


def _load_black():
    try:
        import black

        return black
    except ImportError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Code formatting is unavailable in this deployment",
        ) from exc


def _load_execute_code_jupyter():
    from open_webui.utils.code_interpreter import execute_code_jupyter

    return execute_code_jupyter


@router.get("/gravatar")
async def get_gravatar(email: str, user=Depends(get_verified_user)):
    return get_gravatar_url(email)


class CodeForm(BaseModel):
    code: str


@router.post("/code/format")
async def format_code(form_data: CodeForm, user=Depends(get_verified_user)):
    black = _load_black()

    try:
        formatted_code = black.format_str(form_data.code, mode=black.Mode())
        return {"code": formatted_code}
    except black.NothingChanged:
        return {"code": form_data.code}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/code/execute")
async def execute_code(
    request: Request, form_data: CodeForm, user=Depends(get_verified_user)
):
    if not request.app.state.config.ENABLE_CODE_EXECUTION:
        raise HTTPException(
            status_code=400,
            detail="Code execution is disabled",
        )

    if request.app.state.config.CODE_EXECUTION_ENGINE == "jupyter":
        execute_code_jupyter = _load_execute_code_jupyter()
        output = await execute_code_jupyter(
            request.app.state.config.CODE_EXECUTION_JUPYTER_URL,
            form_data.code,
            (
                request.app.state.config.CODE_EXECUTION_JUPYTER_AUTH_TOKEN
                if request.app.state.config.CODE_EXECUTION_JUPYTER_AUTH == "token"
                else None
            ),
            (
                request.app.state.config.CODE_EXECUTION_JUPYTER_AUTH_PASSWORD
                if request.app.state.config.CODE_EXECUTION_JUPYTER_AUTH == "password"
                else None
            ),
            request.app.state.config.CODE_EXECUTION_JUPYTER_TIMEOUT,
        )

        return output

    raise HTTPException(
        status_code=400,
        detail="Code execution engine not supported",
    )


class MarkdownForm(BaseModel):
    md: str


@router.post("/markdown")
async def get_html_from_markdown(
    form_data: MarkdownForm, user=Depends(get_verified_user)
):
    return {"html": markdown.markdown(form_data.md)}


class ChatForm(BaseModel):
    title: str
    messages: list[dict]


@router.post("/pdf")
async def download_chat_as_pdf(
    form_data: ChatTitleMessagesForm, user=Depends(get_verified_user)
):
    try:
        pdf_bytes = PDFGenerator(form_data).generate_chat_pdf()

        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={"Content-Disposition": "attachment;filename=chat.pdf"},
        )
    except Exception as e:
        log.exception(f"Error generating PDF: {e}")
        raise HTTPException(status_code=400, detail=str(e))


# ---------------------------------------------------------------------------
# Tool confirmation chip resolve endpoint (Portico N-012)
#
# The destructive-MCP-tool confirmation gate (`tool_confirmation_gate.py`)
# emits a chip per blocked tool call into the renderer's input frame. Each
# chip's Yes / No / Reply-with-changes button hits this endpoint to record
# a per-hash decision against the gate without firing a chat completion —
# stacked chips can therefore resolve independently and in parallel.
#
# Threat model invariants this endpoint preserves (see
# docs/security-tool-confirmation.md and
# docs/security-hardening-overview.md item N-012):
#
#   * Auth: ``get_verified_user`` is required; a forged or anonymous
#     caller cannot register approvals.
#   * Chat ownership: the caller must own ``chat_id`` (verified via
#     ``Chats.get_chat_by_id_and_user_id``). Without this check, a
#     malicious user could approve another user's pending action by
#     guessing their chat_id.
#   * Hash binding: ``Gate.resolve_via_chip_click`` only honours hashes
#     that are CURRENTLY pending for the chat. Replayed or forged hashes
#     hit the ``gate_bypass_attempted`` audit and return a no-op.
#   * Single-use: an approved hash is consumed by the next dispatch
#     (``evaluate_tool_call``); a cancelled / modified hash drops out
#     of ``_pending`` so it cannot be re-resolved.
# ---------------------------------------------------------------------------


class ChipResolveForm(BaseModel):
    """Generic chip-click resolution shape (Phase 3).

    The chip primitive carries an arbitrary option set; the renderer
    just sends back which option the user clicked plus an optional
    free-form payload (used by ``modify`` on tool-confirmation chips
    and by ``approve_once`` / freeform answer on clarification chips).

    Threat-model invariants are unchanged: auth via ``get_verified_user``,
    chat-ownership ACL via ``Chats.get_chat_by_id_and_user_id``, hash
    binding inside the gate, single-use approvals.
    """

    chat_id: str = Field(..., min_length=1)
    hash: str = Field(..., min_length=1)
    option_id: str = Field(..., min_length=1)
    freeform_payload: Optional[str] = None


def _resolve_chip_common(
    *,
    chat_id: str,
    user,
    call_hash: str,
    option_id: str,
    freeform_payload: Optional[str] = None,
):
    """Shared resolution path for the generic chip endpoint.

    Verifies chat ownership, delegates to ``Gate.resolve_via_chip_click``,
    and shapes the response so the renderer's chip lifecycle can mirror
    the gate's truth.
    """

    # Chat-ownership ACL: we never trust the caller's claim that they
    # own ``chat_id``. Without this, any verified user could resolve
    # another user's pending chip by knowing the chat id and a public
    # hash from a stolen UI screenshot.
    chat = Chats.get_chat_by_id_and_user_id(chat_id, user.id)
    if chat is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=ERROR_MESSAGES.NOT_FOUND,
        )

    gate = default_tool_confirmation_gate()
    record = gate.resolve_via_chip_click(
        chat_id=chat_id,
        call_hash=call_hash,
        option_id=option_id,
        freeform_payload=freeform_payload,
    )

    if record is None:
        # Unknown hash for this chat — could be a double-click after
        # the chip already resolved, or a forged hash. Either way, the
        # gate already audit-logged ``gate_bypass_attempted``; surface
        # a soft failure to the renderer so it can clear the local
        # chip state.
        return {
            "ok": False,
            "option_id": option_id,
            "reason": "unknown_or_already_resolved_hash",
            "pending_remaining": len(gate.pending_for_chat(chat_id)),
        }

    return {
        "ok": True,
        "decision": record.decision,
        "option_id": record.effective_option_id,
        "kind": record.kind,
        "hash": record.call_hash,
        "tool_name": record.tool_name,
        "pending_remaining": len(gate.pending_for_chat(chat_id)),
    }


@router.post("/chip/resolve")
async def resolve_chip(
    form_data: ChipResolveForm,
    user=Depends(get_verified_user),
):
    """Generic chip resolve endpoint (Phase 3).

    Accepts any chip kind (tool_confirmation, clarification, ...) by
    forwarding the user-clicked ``option_id`` and optional freeform
    payload to the gate. The gate enforces:

      * the option id must match one the chip actually declared (so a
        forged button id can't escalate),
      * the hash must currently be pending for this chat (single-use,
        replay-resistant),
      * tool-confirmation approvals still need a hash-bound replay to
        produce side effects (the chip click is a license, not a
        delegation).

    For tool-confirmation chips, ``option_id`` may be one of the
    canonical "approve" / "cancel" / "modify" ids for compatibility
    with old clients. The renderer should prefer this endpoint going
    forward and pass whatever ids the chip declared.
    """

    # PORTICO PATCH: feature toggle.
    if not _confirmation_gate_enabled():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=ERROR_MESSAGES.NOT_FOUND,
        )

    return _resolve_chip_common(
        chat_id=form_data.chat_id,
        user=user,
        call_hash=form_data.hash,
        option_id=form_data.option_id,
        freeform_payload=form_data.freeform_payload,
    )


# ---------------------------------------------------------------------------
# Round 4 / Issue 2 — per-user tool allowlist REST endpoints
#
# The Settings → Allowlists page reads + mutates a per-user JSON file
# under ``<DATA_DIR>/tool-allowlists/<user_id>.json`` (see
# ``open_webui.utils.tool_allowlist``). The same file is read by the
# tool-confirmation gate's hot-path so a user-approved entry causes
# silent dispatch with the ``dispatched_user_allowlist`` audit line.
#
# Threat model:
#
#   * All endpoints require ``get_verified_user``; ``user.id`` is
#     taken from the verified identity, NEVER from request body.
#   * The storage helpers refuse to write entries with unsafe
#     characters in ``user_id``.
#   * The 'Always allow' chip option populates the same file via
#     the gate's resolve path (see middleware._inject_batch_…), not
#     via a body field — so a forged option-id can't pivot into a
#     persistent allowlist write of an arbitrary tool.
# ---------------------------------------------------------------------------


class AllowlistEntryForm(BaseModel):
    """Body for POST /api/v1/utils/allowlists/entries."""

    tool_name: str = Field(..., min_length=1, max_length=200)
    mcp: str = Field("", max_length=200)
    enabled: bool = True


class AllowlistEntryToggleForm(BaseModel):
    enabled: bool


class AllowlistMasterToggleForm(BaseModel):
    master_disabled: bool


def _allowlist_data_dir():
    """Resolve the storage root with one place to monkeypatch in
    tests. Production reads ``DATA_DIR`` from ``open_webui.config``;
    tests pass ``portico_TOOL_ALLOWLIST_DIR`` via env."""

    return DATA_DIR


def _serialize_allowlist_file(file) -> dict:
    return {
        "version": file.version,
        "master_disabled": file.master_disabled,
        "entries": [entry.to_dict() for entry in file.entries],
    }


def _require_allowlist_enabled() -> None:
    """PORTICO PATCH: feature toggle gate for the 4 allowlist routes."""
    if not _tool_allowlist_enabled():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=ERROR_MESSAGES.NOT_FOUND,
        )


@router.get("/allowlists")
async def get_allowlist(user=Depends(get_verified_user)):
    """Return the calling user's allowlist file (entries + master
    toggle). Empty allowlists return an empty entry list — the
    Settings UI uses this as the canonical "no rules yet" signal."""

    _require_allowlist_enabled()
    from open_webui.utils.tool_allowlist import list_entries_for_user

    file = list_entries_for_user(
        user_id=user.id, data_dir=_allowlist_data_dir()
    )
    return _serialize_allowlist_file(file)


@router.post("/allowlists/entries")
async def upsert_allowlist_entry(
    form_data: AllowlistEntryForm, user=Depends(get_verified_user)
):
    """Add or refresh an allowlist entry for the calling user.

    Idempotent on (tool_name, mcp): a second POST with the same
    fingerprint refreshes ``updated_at`` instead of duplicating.
    """

    _require_allowlist_enabled()
    from open_webui.utils.tool_allowlist import upsert_entry_for_user

    entry = upsert_entry_for_user(
        user_id=user.id,
        tool_name=form_data.tool_name,
        mcp=form_data.mcp,
        enabled=form_data.enabled,
        data_dir=_allowlist_data_dir(),
    )
    return entry.to_dict()


@router.patch("/allowlists/entries/{entry_id}")
async def patch_allowlist_entry(
    entry_id: str,
    form_data: AllowlistEntryToggleForm,
    user=Depends(get_verified_user),
):
    """Toggle an entry's ``enabled`` flag without removing it. Lets
    the user temporarily disarm an allowlist entry from Settings
    without losing the historical fingerprint set."""

    _require_allowlist_enabled()
    from open_webui.utils.tool_allowlist import set_entry_enabled_for_user

    entry = set_entry_enabled_for_user(
        user_id=user.id,
        entry_id=entry_id,
        enabled=form_data.enabled,
        data_dir=_allowlist_data_dir(),
    )
    if entry is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=ERROR_MESSAGES.NOT_FOUND,
        )
    return entry.to_dict()


@router.delete("/allowlists/entries/{entry_id}")
async def delete_allowlist_entry(
    entry_id: str, user=Depends(get_verified_user)
):
    """Remove an allowlist entry. Returns 204 on success, 404 if
    no such entry existed for this user (so the Settings UI can
    tell the user the row was already gone in another tab)."""

    _require_allowlist_enabled()
    from open_webui.utils.tool_allowlist import delete_entry_for_user

    removed = delete_entry_for_user(
        user_id=user.id,
        entry_id=entry_id,
        data_dir=_allowlist_data_dir(),
    )
    if not removed:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=ERROR_MESSAGES.NOT_FOUND,
        )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put("/allowlists/master-toggle")
async def update_allowlist_master_toggle(
    form_data: AllowlistMasterToggleForm, user=Depends(get_verified_user)
):
    """Flip the user's master "Allowlists enabled" toggle. While
    ``master_disabled=True``, the gate ignores all entries and
    falls back to the chip flow for every destructive call — gives
    the user a quick "panic button" without nuking their rules."""

    _require_allowlist_enabled()
    from open_webui.utils.tool_allowlist import set_master_disabled_for_user

    file = set_master_disabled_for_user(
        user_id=user.id,
        master_disabled=form_data.master_disabled,
        data_dir=_allowlist_data_dir(),
    )
    return _serialize_allowlist_file(file)


# ---------------------------------------------------------------------------
# Round 4 / Issue 7b — sidebar attention map
#
# The sidebar shows an amber dot on chats where the user owes a chip
# decision (sub-agent clarification, tool-confirmation pending, …). The
# rendered surface is ``TaskAttentionDot.svelte``; this endpoint feeds
# it the per-chat reason so the tooltip stays specific.
#
# Trust boundary:
#
#   * The gate's ``_pending`` store may contain pending actions whose
#     ``user_id`` was not stamped (older code paths). To avoid leaking
#     attention dots across users, we cross-reference the gate result
#     with the verified user's chat ids — only chats actually owned by
#     ``user.id`` are returned.
#   * The endpoint is read-only and intentionally cheap so the sidebar
#     can poll it on every chat-list refresh without backend cost.
# ---------------------------------------------------------------------------


@router.get("/chat-attention")
async def get_chat_attention(user=Depends(get_verified_user)):
    """Return ``{ items: [{chat_id, reason}, ...] }`` for chats owned
    by the calling user that currently need their attention (pending
    chip decisions). The frontend uses this to render the amber dot
    next to the chat title in the sidebar.
    """

    gate = default_tool_confirmation_gate()
    raw = gate.chat_attention_for_user(user_id=user.id)
    if not raw:
        return {"items": []}
    # Cross-reference each candidate with chat ownership so we never
    # surface attention for chats this user can't see. The candidate
    # set is small in practice (one entry per chat with a pending
    # chip), so per-row authorization is cheap AND stricter than a
    # bulk list-and-set-intersect — no risk of leaking new pending
    # actions added between the bulk fetch and the filter.
    items: list[dict] = []
    for chat_id, reason in raw.items():
        try:
            owned = Chats.get_chat_by_id_and_user_id(chat_id, user.id)
        except Exception:  # noqa: BLE001 - storage hiccup -> drop the row, dot suppressed
            log.exception(
                "[chat-attention] ownership check failed for chat_id=%s", chat_id
            )
            continue
        if owned is None:
            continue
        items.append({"chat_id": chat_id, "reason": reason})
    return {"items": items}


@router.get("/db/download")
async def download_db(user=Depends(get_admin_user)):
    if not ENABLE_ADMIN_EXPORT:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=ERROR_MESSAGES.ACCESS_PROHIBITED,
        )
    from open_webui.internal.db import engine

    if engine.name != "sqlite":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=ERROR_MESSAGES.DB_NOT_SQLITE,
        )
    return FileResponse(
        engine.url.database,
        media_type="application/octet-stream",
        filename="webui.db",
    )
