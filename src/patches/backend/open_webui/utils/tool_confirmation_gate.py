"""MCP tool-call confirmation gate.

The gate is the single structural defense against the failure mode reported
under threat-model item N-012: an MCP write/action tool firing without an
explicit, action-specific user confirmation. It runs in the chat middleware
*below* the model — a model that ignores the prompt-level Tool Action Policy
must still go through the gate before any external tool can run.

High-level flow:

    assistant turn -> evaluate_tool_call() -> destructive ?
        if no confirmation_token: register pending action,
            return Decision(action="block", card=...)  # rendered as a chip
        if confirmation_token matches a pending action's hash:
            return Decision(action="dispatch")
        else: return Decision(action="reject", reason="hash_mismatch" or
            "gate_bypass_attempted")

    user turn -> resolve_user_reply() -> {approve, cancel, modify}
        approve(hash) -> caller replays original tool call with that token
        cancel        -> drop pending, emit "Action cancelled" message
        modify(text)  -> drop pending, forward `text` as a normal user message

    end of user turn -> consume_user_turn(chat_id) -> drop ALL pending for
        the chat, regardless of outcome. This enforces the TTL=1 turn
        invariant — an old "yes" can never authorize a future action.

Renderer surface:

  The ``Card`` dataclass below is the renderable payload. The frontend
  surfaces it as a ``ToolConfirmationChip`` in the chat input frame
  (``src/patches/frontend/src/lib/components/chat/MessageInput/ToolConfirmationChip.svelte``).
  The class is still named ``Card`` in this module for back-compat with the
  ``Card as ToolConfirmationCard`` import in ``middleware.py`` and with the
  ``decision.card`` field on ``ToolCallDecision``.

Cross-references:

  - docs/security-hardening-overview.md (item N-012)
  - docs/security-tool-confirmation.md (catalogue)
  - mcp-policy/destructive-tools.json (registry)
  - tests/test_tool_confirmation_gate.py (unit tests)
  - tests/test_tool_confirmation_chip.node.test.js (renderer smoke + anchor tests)
  - docs/testing/plan/security/tool-confirmation-gate.md (test plan: L-18..L-23)
  - docs/testing/plan/mcp/tool-confirmation.md (test plan: G-30..G-32)
"""

from __future__ import annotations

import fnmatch
import hashlib
import json
import logging
import os
import re
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Optional

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


_DEFAULT_TRUNCATE = 160
_DEFAULT_REGISTRY_REL = "mcp-policy/destructive-tools.json"
# Fallback regex used when neither an explicit rule matches nor a registry
# file is loaded. Tracks the JSON-side default so behaviour does not depend
# on the file existing on disk.
#
# IMPORTANT: this list is the LAST line of defence if the registry file is
# missing (e.g. mount drift, packaging mistake). It must be conservative on
# the safe side — false positives (treating a read tool as destructive)
# only cost a redundant chip; false negatives (missing a write verb) sent
# real Slack DMs in production and broke N-012. When in doubt, add the
# verb here and let the explicit per-tool registry rules say "side_effect:
# read" if it should bypass.
#
# Naming conventions observed in the wild that drove this list:
#   - Slack MCP uses ``add`` for posting (slack_conversations_add_message)
#     and ``reply`` / ``thread_reply``.
#   - Gmail MCP uses ``send`` and ``draft``.
#   - GitLab / Jira mix ``create``, ``update``, ``post``, ``add``, ``open``.
#   - n8n / scheduling use ``trigger`` / ``run`` / ``execute`` / ``cancel``.
#   - Notification MCP uses ``share`` / ``notify`` / ``dispatch``.
#   - Drive / Docs / Sheets / Slides use ``write`` / ``upload`` / ``copy``
#     / ``rename``.
_HARDCODED_FALLBACK_REGEX = (
    r"(?i)(?:^|_)(?:"
    r"send|post|publish|share|dispatch|notify|broadcast|email|"
    r"add|append|write|reply|comment|"
    r"create|insert|upload|draft|submit|open|"
    r"update|patch|edit|rename|"
    r"delete|remove|archive|unarchive|purge|"
    r"modify|move|copy|set|"
    r"invite|kick|grant|revoke|assign|unassign|"
    r"merge|close|reopen|fork|push|"
    r"execute|run|trigger|cancel|"
    r"activate|deactivate|enable|disable|approve|reject|transition"
    r")(?:_|$)"
)


@dataclass(frozen=True)
class _RegistryRule:
    tool_name_glob: str
    mcp: str
    summary_template: str
    side_effect: str  # "external-write" | "read"

    def matches(self, tool_name: str) -> bool:
        return fnmatch.fnmatchcase(tool_name, self.tool_name_glob)


class Registry:
    """In-memory registry of destructive tool rules.

    The registry is loaded once at process start. It exposes a single
    classification API: ``classify(tool_name) -> ("destructive" | "safe",
    matched_rule_or_none, generic_summary_template_or_none)``.
    """

    def __init__(
        self,
        rules: Iterable[_RegistryRule],
        default_glob_fallback: Optional[str] = None,
    ) -> None:
        self._rules = list(rules)
        # Compile both the JSON-provided fallback (if any) and the hardcoded
        # default so the gate still works if the registry file is missing.
        self._fallback_regexes = []
        for pattern in (default_glob_fallback, _HARDCODED_FALLBACK_REGEX):
            if pattern:
                try:
                    self._fallback_regexes.append(re.compile(pattern))
                except re.error as error:
                    log.warning(
                        "[tool-confirmation-gate] Skipping invalid fallback regex %r: %s",
                        pattern,
                        error,
                    )

    @classmethod
    def load(cls, path: Optional[str | os.PathLike] = None) -> "Registry":
        """Load the registry from JSON. Returns an empty registry on failure
        (with the hardcoded fallback regex still active) so the gate never
        crashes the chat path because of a missing or malformed file."""

        resolved = cls._resolve_path(path)
        if resolved is None:
            log.warning(
                "[tool-confirmation-gate] No registry file found; using hardcoded fallback only"
            )
            return cls(rules=[], default_glob_fallback=None)

        try:
            with open(resolved, "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except (OSError, json.JSONDecodeError) as error:
            log.warning(
                "[tool-confirmation-gate] Failed to load registry from %s: %s",
                resolved,
                error,
            )
            return cls(rules=[], default_glob_fallback=None)

        rules: list[_RegistryRule] = []
        for raw in data.get("rules", []) or []:
            try:
                rules.append(
                    _RegistryRule(
                        tool_name_glob=str(raw["tool_name_glob"]),
                        mcp=str(raw.get("mcp", "")),
                        summary_template=str(raw.get("summary_template", "")),
                        side_effect=str(raw.get("side_effect", "external-write")),
                    )
                )
            except (KeyError, TypeError) as error:
                log.warning(
                    "[tool-confirmation-gate] Skipping malformed rule %r: %s",
                    raw,
                    error,
                )

        return cls(
            rules=rules,
            default_glob_fallback=data.get("default_glob_fallback"),
        )

    @staticmethod
    def _resolve_path(path: Optional[str | os.PathLike]) -> Optional[Path]:
        if path is not None:
            candidate = Path(path)
            return candidate if candidate.is_file() else None

        env_override = os.environ.get("portico_DESTRUCTIVE_TOOLS_REGISTRY")
        if env_override:
            candidate = Path(env_override)
            if candidate.is_file():
                return candidate

        # Walk up from this file until we find the repo's mcp-policy folder.
        # Keeps the gate working in dev (running from source) and in
        # the patched OWUI image (where this file lives at
        # /backend/open_webui/utils/tool_confirmation_gate.py).
        for ancestor in (Path(__file__).resolve(), *Path(__file__).resolve().parents):
            candidate = ancestor / _DEFAULT_REGISTRY_REL
            if candidate.is_file():
                return candidate

        # Production fallback: the patches folder ships its own copy.
        patches_copy = (
            Path(__file__).resolve().parent.parent.parent.parent
            / _DEFAULT_REGISTRY_REL
        )
        if patches_copy.is_file():
            return patches_copy

        return None

    def classify(
        self, tool_name: str
    ) -> tuple[str, Optional[_RegistryRule]]:
        """Return ``("destructive", matched_rule | None)`` if the tool is
        destructive (explicit rule or fallback match), or ``("safe", None)``
        otherwise.

        Explicit rules win over the fallback regex. An explicit rule with
        ``side_effect="read"`` short-circuits even when the fallback regex
        would match — that's the allowlist escape hatch documented in
        ``docs/security-tool-confirmation.md``.
        """

        for rule in self._rules:
            if rule.matches(tool_name):
                if rule.side_effect == "read":
                    return ("safe", None)
                return ("destructive", rule)

        for regex in self._fallback_regexes:
            if regex.search(tool_name):
                return ("destructive", None)

        return ("safe", None)


# ---------------------------------------------------------------------------
# Hashing and template rendering
# ---------------------------------------------------------------------------


def _canonicalize_args(args: Any) -> Any:
    """Recursively sort dict keys so equal-by-value args produce the same hash
    regardless of insertion order. Lists keep their order."""

    if isinstance(args, dict):
        return {k: _canonicalize_args(args[k]) for k in sorted(args.keys())}
    if isinstance(args, list):
        return [_canonicalize_args(item) for item in args]
    return args


def compute_call_hash(tool_name: str, args: Any) -> str:
    """Stable per-call hash. Bound to (tool_name, canonicalized_args) so any
    argument drift between confirmation and dispatch breaks the binding."""

    canonical = json.dumps(
        {"name": tool_name, "args": _canonicalize_args(args)},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


# ----- Template rendering ---------------------------------------------------


_TEMPLATE_TOKEN_RE = re.compile(r"\{\{\s*([^{}]+?)\s*\}\}")


def _resolve_field(args: Any, path: str) -> Any:
    """Navigate dotted path through nested dicts/lists. Missing -> None."""

    cursor: Any = args
    for segment in path.split("."):
        if isinstance(cursor, dict):
            cursor = cursor.get(segment)
        elif isinstance(cursor, list):
            try:
                cursor = cursor[int(segment)]
            except (ValueError, IndexError):
                return None
        else:
            return None
    return cursor


def _apply_filter(value: Any, filt: str) -> str:
    """Apply Mustache-lite filters: ``truncate:N``, ``chars``, ``join:'sep'``."""

    name, _, arg = filt.partition(":")
    name = name.strip()
    arg = arg.strip().strip("'\"")

    if name == "truncate":
        try:
            limit = int(arg) if arg else _DEFAULT_TRUNCATE
        except ValueError:
            limit = _DEFAULT_TRUNCATE
        text = "" if value is None else str(value)
        return text if len(text) <= limit else text[: max(0, limit - 1)] + "\u2026"

    if name == "chars":
        if value is None:
            return "0"
        if isinstance(value, (list, dict)):
            return str(len(json.dumps(value, ensure_ascii=False)))
        return str(len(str(value)))

    if name == "join":
        sep = arg or ", "
        if isinstance(value, list):
            return sep.join(str(item) for item in value if item is not None)
        return "" if value is None else str(value)

    # Unknown filter — be quiet, render the value as-is.
    return "" if value is None else str(value)


def render_summary(template: str, args: Any) -> str:
    """Render a ``summary_template`` with the given args dict.

    Missing fields render as ``"-"`` so the card never shows a confusing empty
    placeholder. Multiple filters can be chained with ``|`` (left-to-right)."""

    if not template:
        return ""

    def replace(match: re.Match[str]) -> str:
        spec = match.group(1)
        head, *filters = (segment.strip() for segment in spec.split("|"))
        value = _resolve_field(args, head)
        if not filters:
            return "-" if value is None else str(value)
        rendered: Any = value
        for filt in filters:
            rendered = _apply_filter(rendered, filt)
        return str(rendered)

    return _TEMPLATE_TOKEN_RE.sub(replace, template)


# ---------------------------------------------------------------------------
# Generic chip primitive (Phase 3)
# ---------------------------------------------------------------------------
#
# The chip started life as a per-action confirmation surface for destructive
# MCP calls (N-012). It is now also used for runtime CLARIFICATIONS — for
# example, when a scheduled run hits a tool outside the task's pre-approved
# scope and we need the user to pick: block / approve-once / widen-scope.
# To support both without forking the renderer, ``Card`` carries:
#
#   * ``kind`` — "tool_confirmation" (default, today's chip) or
#     "clarification" (any in-the-loop question).
#   * ``options`` — declarative button set the renderer paints.
#   * ``allow_freeform`` — whether the freeform textarea is offered for
#     "modify" / "custom answer" decisions.
#
# Existing tool-confirmation flows keep the same field shape: ``Card`` still
# carries ``hash``, ``tool_name``, ``mcp``, ``summary``, ``args_preview`` and
# the default options list mirrors today's [Approve / Cancel / Reply with
# changes] hard-coded buttons.

# Stable option ids — keep these in sync with the chip renderer so server-
# side code doesn't accidentally drift from button labels.
TOOL_CONFIRMATION_OPTION_APPROVE = "approve"
TOOL_CONFIRMATION_OPTION_CANCEL = "cancel"
TOOL_CONFIRMATION_OPTION_MODIFY = "modify"
# Round 4 / Issue 2 — "Always allow this action" persistent
# allowlist option. Resolves the chip exactly like ``approve`` AND
# writes a per-user allowlist entry so future identical
# (tool_name, mcp) calls dispatch silently. The renderer paints
# this as a small icon button on the chip's right edge so it's
# discoverable but not the default action — preserving the
# explicit-confirmation invariant for first-time encounters.
TOOL_CONFIRMATION_OPTION_ALWAYS_ALLOW = "always_allow"

# Out-of-scope clarification chip option ids (Phase 1). Defined here (vs.
# the scheduling code) so the gate's option-id allowlist is one source of
# truth for the REST endpoint to validate against.
OUT_OF_SCOPE_OPTION_BLOCK = "out_of_scope_block"
OUT_OF_SCOPE_OPTION_APPROVE_ONCE = "out_of_scope_approve_once"
OUT_OF_SCOPE_OPTION_WIDEN_SCOPE = "out_of_scope_widen_scope"


@dataclass(frozen=True)
class ChipOption:
    """A single button on a chip. ``id`` is what the REST endpoint receives;
    ``label`` is what the user sees; ``style`` is a frontend rendering hint
    (primary / secondary / danger) so the renderer doesn't have to map ids
    to colors."""

    id: str
    label: str
    style: str = "secondary"  # "primary" | "secondary" | "danger"

    def to_dict(self) -> dict[str, str]:
        return {"id": self.id, "label": self.label, "style": self.style}


def _default_tool_confirmation_options() -> list[ChipOption]:
    """The historical Yes / No / Reply-with-changes button set. Kept as the
    default so existing chips render identically without the proposer
    having to spell out the option list."""

    return [
        ChipOption(
            id=TOOL_CONFIRMATION_OPTION_APPROVE,
            label="Yes, send",
            style="primary",
        ),
        ChipOption(
            id=TOOL_CONFIRMATION_OPTION_CANCEL,
            label="No",
            style="secondary",
        ),
        ChipOption(
            id=TOOL_CONFIRMATION_OPTION_MODIFY,
            label="Reply with changes",
            style="secondary",
        ),
        ChipOption(
            id=TOOL_CONFIRMATION_OPTION_ALWAYS_ALLOW,
            label="Always allow",
            style="secondary",
        ),
    ]


# ---------------------------------------------------------------------------
# Pending-action store
# ---------------------------------------------------------------------------


@dataclass
class PendingAction:
    chat_id: str
    user_id: Optional[str]
    tool_name: str
    mcp: str
    args: Any
    summary: str
    call_hash: str
    proposed_at_ns: int
    # Generic-chip extensions (Phase 3). For the historical
    # tool-confirmation flow these carry their default values and the
    # behavior is unchanged.
    kind: str = "tool_confirmation"
    options: list[ChipOption] = field(default_factory=_default_tool_confirmation_options)
    prompt: str = ""
    allow_freeform: bool = True
    context: dict[str, Any] = field(default_factory=dict)


@dataclass
class Card:
    """Renderable card for the renderer.

    Backward-compat: ``kind`` defaults to ``"tool_confirmation"`` so any
    existing call site that just sets the historical fields continues to
    render the standard chip. ``prompt`` is used for clarification chips
    (free-form question text); for tool-confirmation chips it is empty
    and the renderer keeps using ``summary``.
    """

    hash: str
    tool_name: str
    mcp: str
    summary: str
    args_preview: dict[str, Any]
    kind: str = "tool_confirmation"
    prompt: str = ""
    options: list[ChipOption] = field(
        default_factory=_default_tool_confirmation_options
    )
    allow_freeform: bool = True
    # Optional opaque per-kind metadata the chip carries from proposer to
    # resolver. The gate doesn't interpret it; the proposing subsystem
    # (e.g. scheduling) reads it back via ``ResolutionRecord.context``
    # to stitch the resolution to its own state. Keep it small and
    # JSON-serializable — it rides over the wire to the renderer too.
    context: dict[str, Any] = field(default_factory=dict)


@dataclass
class ToolCallDecision:
    action: str  # "dispatch" | "block" | "reject"
    card: Optional[Card] = None
    reject_reason: Optional[str] = None
    audit_event: Optional[str] = None


# Round 4 / Issue 1 — redispatch TTL cache. After a destructive tool
# call dispatches (whether via explicit token or via the pre-approved-
# hash path) we remember ``(chat_id, call_hash)`` for a short window so
# that hash-identical retries — typical of upstream-side transient
# failures like Slack cache-syncing — don't re-show the chip the user
# already clicked.
#
# The window is wallclock-bound, NOT turn-bound: ``consume_assistant_turn``
# does not clear it, because the retries we want to absorb often happen
# AFTER the assistant turn the original approval lived in (the model
# observes the upstream error, calls again on the next turn). Single-use
# semantics still apply — every dispatch consumes the entry, but the
# entry is also a "pre-approval" for any retry inside the window.
@dataclass(frozen=True)
class RedispatchEntry:
    dispatched_at_ns: int
    ttl_ns: int

    def is_alive(self, now_ns: int) -> bool:
        return now_ns - self.dispatched_at_ns < self.ttl_ns


# Bounds for ``PORTICO_TOOL_CONFIRMATION_REDISPATCH_TTL_SECONDS``.
# 0 disables the cache (every retry shows a chip, like before round 4).
# 3600 (one hour) is the upper bound — anything longer starts conflicting
# with the user's mental model of "I approved this an hour ago" and
# would let a long-running retry loop reuse stale consent.
_REDISPATCH_TTL_DEFAULT_SECONDS = 600
_REDISPATCH_TTL_MIN_SECONDS = 0
_REDISPATCH_TTL_MAX_SECONDS = 3600
_REDISPATCH_TTL_ENV_VAR = "PORTICO_TOOL_CONFIRMATION_REDISPATCH_TTL_SECONDS"


def _resolve_redispatch_ttl_seconds() -> int:
    """Read the configured redispatch TTL with bounds clamping.

    The value comes from the env var ``PORTICO_TOOL_CONFIRMATION_REDISPATCH_TTL_SECONDS``
    so admins can tune it without re-deploying. Out-of-range values are
    clamped to ``[0, 3600]`` and a warning is logged so misconfiguration
    is observable. Non-numeric values fall back to the default. The
    function is called once per ``evaluate_tool_call`` so config changes
    propagate in seconds.
    """

    raw = os.environ.get(_REDISPATCH_TTL_ENV_VAR)
    if raw is None or raw == "":
        return _REDISPATCH_TTL_DEFAULT_SECONDS
    try:
        value = int(raw)
    except ValueError:
        log.warning(
            "[tool-confirmation-gate] %s=%r is not an integer; using default %ds",
            _REDISPATCH_TTL_ENV_VAR,
            raw,
            _REDISPATCH_TTL_DEFAULT_SECONDS,
        )
        return _REDISPATCH_TTL_DEFAULT_SECONDS
    if value < _REDISPATCH_TTL_MIN_SECONDS:
        log.warning(
            "[tool-confirmation-gate] %s=%d is below %d; clamping",
            _REDISPATCH_TTL_ENV_VAR,
            value,
            _REDISPATCH_TTL_MIN_SECONDS,
        )
        return _REDISPATCH_TTL_MIN_SECONDS
    if value > _REDISPATCH_TTL_MAX_SECONDS:
        log.warning(
            "[tool-confirmation-gate] %s=%d exceeds %d; clamping",
            _REDISPATCH_TTL_ENV_VAR,
            value,
            _REDISPATCH_TTL_MAX_SECONDS,
        )
        return _REDISPATCH_TTL_MAX_SECONDS
    return value


_AFFIRMATIVE_RE = re.compile(
    r"^(?:yes|y|do\s*it|send\s*it|go\s*ahead|approve|approved|confirm|confirmed|ok|okay|sure|please)\.?$",
    re.IGNORECASE,
)
_NEGATIVE_RE = re.compile(
    r"^(?:no|n|cancel|stop|abort|don'?t|do\s*not|nope|nevermind|never\s*mind)\.?$",
    re.IGNORECASE,
)


@dataclass
class UserReplyOutcome:
    decision: str  # "approve" | "cancel" | "modify"
    approved_hash: Optional[str] = None
    cancelled_hashes: list[str] = field(default_factory=list)
    free_text: Optional[str] = None


@dataclass
class ResolutionRecord:
    """One chip's per-hash decision, captured at the moment the user clicks
    the chip (via the REST resolve endpoint) and held until the next chat
    completion turn fires. The batch of records lets the gate synthesize a
    single "user resolved N pending actions" note for the model so it knows
    which calls to re-emit, which to acknowledge as cancelled, and which to
    re-issue with modified args.

    A record is per-hash: stacked chips that share a tool name still resolve
    independently and surface their own modify payload.

    Generic-chip extensions (Phase 3):

    * ``kind`` mirrors ``Card.kind`` so consumers that drain the
      resolution log can route per-kind logic. For tool-confirmation
      chips it stays ``"tool_confirmation"``.
    * ``option_id`` is the canonical "which button did the user click"
      field. For tool-confirmation chips it is one of approve / cancel
      / modify and is kept aligned with the legacy ``decision`` field
      (which existing call sites still read).
    * ``context`` is the opaque per-kind metadata the proposer
      attached to the chip (e.g. for an out-of-scope clarification it
      carries ``{task_id, run_id, tool_server_id}`` so the scheduler
      can act on the user's choice).
    """

    call_hash: str
    tool_name: str
    mcp: str
    summary: str
    decision: str  # legacy: "approve" | "cancel" | "modify"
    modify_payload: Optional[str] = None
    # Snapshot of the args the user actually approved. Captured at
    # chip-click time so the synthesized batch-resolution note can echo
    # them verbatim into the model's context. Without this, the model
    # has to reconstruct args from chat history and tends to produce
    # subtly different JSON (different key order, default fields filled
    # in, whitespace), which yields a new hash and a fresh chip — the
    # user perceives it as "I approved but the chip didn't vanish".
    args: Any = None
    kind: str = "tool_confirmation"
    option_id: str = ""  # canonical button id; "" means "fall back to ``decision``"
    context: dict[str, Any] = field(default_factory=dict)
    freeform_payload: Optional[str] = None  # generic alias for modify_payload

    @property
    def effective_option_id(self) -> str:
        """Prefer the explicit ``option_id`` if set, else map the legacy
        ``decision`` field for tool-confirmation records. Keeps callers
        from having to know which field was populated."""

        if self.option_id:
            return self.option_id
        return self.decision


# ---------------------------------------------------------------------------
# Audit
# ---------------------------------------------------------------------------


_AUDIT_EVENTS = frozenset(
    {
        "proposed",
        "approved",
        "cancelled",
        "modified",
        "expired",
        "hash_mismatch",
        "gate_bypass_attempted",
        "dispatched_safe",
        "dispatched_after_approval",
        # Phase 1: scheduled-run scope binding. A destructive tool call
        # fired inside a scheduled-run sub-agent chat whose ``mcp`` is
        # in the task's pre-approved scope is dispatched without a chip,
        # but still emits an audit line so the security log shows every
        # external write.
        "dispatched_scheduled_pre_approved",
        # Phase 3: generic clarification chip resolved via UI click.
        # Tool-confirmation chips keep their past-tense events
        # (approved / cancelled / modified) so dashboards don't break.
        "resolved",
        # Round 4 / Issue 1: a hash-identical tool call re-fired within
        # the configured redispatch TTL (default 600s). The user already
        # approved an identical call recently; absorbing the retry
        # silently is what they expect (Slack cache-syncing UX bug).
        "redispatch_within_ttl",
        # Round 4 / Issue 5b: a scheduled-run sub-agent attempted to
        # invoke an OAuth-initiating tool (e.g.
        # ``mcp_assistant_authorize_integration``). Sub-agents must
        # NOT start OAuth flows since no human is present to consent.
        # Refused calls get this audit line + an auth-required
        # clarification chip surfaced to the user.
        "subagent_oauth_initiation_blocked",
        # Round 4 / Issue 2: a destructive tool was dispatched
        # silently because the (tool_name, mcp) matches an enabled
        # entry in the user's persistent allowlist. Distinct from
        # ``dispatched_after_approval`` so the security log can
        # answer "show me actions the user pre-approved IN this
        # conversation" vs "show me actions the user pre-approved
        # FOR EVER via the Settings page" — different review SLAs.
        "dispatched_user_allowlist",
        # Round 4 / Issue 2b — "Always allow" chip click bookkeeping.
        "always_allow_persisted",
        "always_allow_skipped_no_user",
        "always_allow_skipped_no_writer",
        "always_allow_writer_failed",
        # Round 4 hotfix: scheduled-run scope diagnostic events. Both
        # are non-actionable on the hot path; they exist purely so
        # operators can grep the audit log to debug "why did this
        # chip show inside a scheduled-run sub-agent chat?".
        #   * ``scheduled_run_scope_decision`` — fired with the
        #     resolved scope set + the tool's mcp + an in_scope
        #     verdict, on every destructive call inside a chat that
        #     DOES carry the daemon's run-origin stamp.
        #   * ``scheduled_run_meta_absent`` — fired when a chip is
        #     about to surface in a chat that does NOT carry the
        #     stamp. Helps tell apart "daemon didn't propagate" from
        #     "the scope match logic missed the registry alias".
        "scheduled_run_scope_decision",
        "scheduled_run_meta_absent",
    }
)


def _default_audit(event: str, **fields: Any) -> None:
    """Default audit sink — structured stdlib log line.

    Production callers can pass their own callback to ``Gate(...,
    audit_log_fn=...)`` to ship into the existing chat audit pipeline."""

    if event in {"hash_mismatch"}:
        level = logging.WARNING
    elif event in {"gate_bypass_attempted"}:
        level = logging.ERROR
    else:
        level = logging.INFO

    log.log(level, "[tool-confirmation-gate] %s %s", event, fields)


# ---------------------------------------------------------------------------
# Gate
# ---------------------------------------------------------------------------


class Gate:
    """Thread-safe per-process gate.

    The pending-action store is keyed by ``(chat_id, hash)``; multiple chats
    can have pending actions concurrently. Within one chat, multiple
    concurrent destructive tool calls in one assistant turn each produce
    their own card with an independent hash — approvals are per-card.
    """

    def __init__(
        self,
        registry: Optional[Registry] = None,
        audit_log_fn: Any = None,
        redispatch_ttl_seconds_provider: Optional[Any] = None,
        # Round 4 / Issue 2 — pluggable allowlist lookup. Production
        # wiring passes a function that defers to
        # ``open_webui.utils.tool_allowlist.is_call_allowlisted_for_user``;
        # tests pass a fake so the gate's allowlist behavior is
        # exercisable without touching the disk-backed user file.
        # Signature: ``(user_id: str, tool_name: str, mcp: str) -> bool``.
        allowlist_lookup_fn: Optional[Any] = None,
        # Round 4 / Issue 2b — companion writer for the "Always
        # allow" chip option. Called from ``resolve_via_chip_click``
        # when the user picks ``always_allow``. Signature:
        # ``(user_id: str, tool_name: str, mcp: str) -> None``. May
        # raise — the resolver wraps the call in try/except so a
        # disk failure can't corrupt the resolution flow (the
        # "approve once" semantics still apply on resolver failure;
        # the user just doesn't get a persistent rule).
        allowlist_writer_fn: Optional[Any] = None,
    ) -> None:
        self.registry = registry or Registry.load()
        self.audit_log_fn = audit_log_fn or _default_audit
        self._allowlist_lookup_fn = allowlist_lookup_fn
        self._allowlist_writer_fn = allowlist_writer_fn
        self._pending: dict[str, dict[str, PendingAction]] = {}
        # Approved hashes that the user has confirmed but the model has not
        # yet replayed. Single-use: consumed by ``evaluate_tool_call`` on a
        # matching dispatch. Cleared by ``consume_assistant_turn`` once the
        # assistant turn finishes — that's the upper bound on how long an
        # approval can sit waiting. Hash binding keeps this safe across
        # turns: only a tool call whose canonicalized args match exactly can
        # consume the approval, so the model can't pivot to a different
        # action and steal the consent.
        self._approved: dict[str, set[str]] = {}
        # Per-chat batch of resolution records. Populated when the user clicks
        # a chip (via REST `/api/v1/utils/chip/resolve`).
        # Drained by
        # ``pop_resolutions_for_batch`` when the batch-send chat turn fires —
        # the middleware synthesizes a system message from these records so
        # the model knows which calls to re-emit, which were cancelled, and
        # which need re-issuing with modify payloads.
        self._resolutions: dict[str, dict[str, ResolutionRecord]] = {}
        # Round 4 / Issue 1 — recently-dispatched cache. Wallclock-bound,
        # NOT turn-bound. See ``RedispatchEntry`` for rationale. Tests
        # inject a deterministic provider; production reads the env var.
        self._recently_dispatched: dict[str, dict[str, RedispatchEntry]] = {}
        self._redispatch_ttl_seconds_provider = (
            redispatch_ttl_seconds_provider or _resolve_redispatch_ttl_seconds
        )
        self._lock = threading.Lock()

    # -- helpers -----------------------------------------------------------

    def _audit(self, event: str, **fields: Any) -> None:
        if event not in _AUDIT_EVENTS:
            log.warning(
                "[tool-confirmation-gate] unknown audit event %r — emitting anyway", event
            )
        try:
            self.audit_log_fn(event, **fields)
        except Exception:  # noqa: BLE001 - audit must never break dispatch
            log.exception("[tool-confirmation-gate] audit_log_fn raised")

    @staticmethod
    def _args_preview(args: Any) -> dict[str, Any]:
        """Bounded preview of args for the card. Long strings get truncated;
        nested structures get reduced to their JSON length."""

        if not isinstance(args, dict):
            return {"_value": _truncate_for_preview(args)}

        preview: dict[str, Any] = {}
        for key, value in args.items():
            preview[str(key)] = _truncate_for_preview(value)
        return preview

    # -- main API ----------------------------------------------------------

    def evaluate_tool_call(
        self,
        *,
        chat_id: str,
        user_id: Optional[str],
        tool_name: str,
        args: Any,
        confirmation_token: Optional[str] = None,
    ) -> ToolCallDecision:
        """Decide whether a tool call may be dispatched right now.

        Outcomes:

        - "safe" tool call -> ``ToolCallDecision(action="dispatch")``
        - destructive without token -> register pending and return
          ``ToolCallDecision(action="block", card=...)``
        - destructive with matching token -> consume the pending entry and
          return ``ToolCallDecision(action="dispatch")``
        - destructive with mismatched / unknown token -> return
          ``ToolCallDecision(action="reject", ...)``
        """

        side, rule = self.registry.classify(tool_name)
        if side == "safe":
            self._audit("dispatched_safe", chat_id=chat_id, tool_name=tool_name)
            return ToolCallDecision(action="dispatch")

        call_hash = compute_call_hash(tool_name, args)

        if confirmation_token:
            with self._lock:
                pending_for_chat = self._pending.get(chat_id, {})
                pending = pending_for_chat.get(confirmation_token)
                if pending is None:
                    self._audit(
                        "gate_bypass_attempted",
                        chat_id=chat_id,
                        tool_name=tool_name,
                        token_present=True,
                        reason="unknown_token",
                    )
                    return ToolCallDecision(
                        action="reject",
                        reject_reason="gate_bypass_attempted",
                    )
                if pending.call_hash != call_hash or pending.tool_name != tool_name:
                    self._audit(
                        "hash_mismatch",
                        chat_id=chat_id,
                        tool_name=tool_name,
                        token_hash=confirmation_token,
                        actual_hash=call_hash,
                    )
                    return ToolCallDecision(
                        action="reject",
                        reject_reason="hash_mismatch",
                    )
                # Single-use: consume the pending entry on dispatch.
                pending_for_chat.pop(confirmation_token, None)
                if not pending_for_chat:
                    self._pending.pop(chat_id, None)
            self._record_recent_dispatch(chat_id, call_hash)
            self._audit(
                "dispatched_after_approval",
                chat_id=chat_id,
                tool_name=tool_name,
                hash=call_hash,
            )
            return ToolCallDecision(action="dispatch")

        # No explicit token from the model — check pre-approved hashes
        # (set by resolve_user_reply when the user confirmed). Single-use.
        with self._lock:
            approved_for_chat = self._approved.get(chat_id)
            pre_approved_hit = bool(
                approved_for_chat and call_hash in approved_for_chat
            )
            if pre_approved_hit:
                approved_for_chat.discard(call_hash)
                if not approved_for_chat:
                    self._approved.pop(chat_id, None)
        if pre_approved_hit:
            # Pre-approved path: audit, seed the redispatch cache so a
            # follow-up identical retry (Slack cache-syncing UX bug) is
            # auto-absorbed within the configured window, and dispatch.
            self._audit(
                "dispatched_after_approval",
                chat_id=chat_id,
                tool_name=tool_name,
                hash=call_hash,
                via="pre_approved_hash",
            )
            self._record_recent_dispatch(chat_id, call_hash)
            return ToolCallDecision(action="dispatch")

        # Round 4 / Issue 1 — redispatch TTL check. The user already
        # approved a hash-identical call recently; absorb the retry
        # silently. The cache is wallclock-bound — every successful
        # dispatch refreshes the entry, so a tight retry loop on a
        # single approval can keep dispatching for the lifetime of the
        # configured TTL but no longer.
        if self._consume_recent_dispatch(chat_id, call_hash):
            self._audit(
                "redispatch_within_ttl",
                chat_id=chat_id,
                tool_name=tool_name,
                hash=call_hash,
            )
            self._record_recent_dispatch(chat_id, call_hash)
            return ToolCallDecision(action="dispatch")

        # Round 4 / Issue 2 — per-user persistent allowlist. The user
        # has previously clicked "Always allow" on a chip with the
        # same (tool_name, mcp) fingerprint, OR added the entry by
        # hand from the Settings → Allowlists page. We dispatch
        # silently AND seed the redispatch cache so identical
        # transient-error retries inside the same TTL window also
        # pass without touching the disk-backed allowlist.
        #
        # Precedence note: this check sits AFTER the in-conversation
        # approval paths (confirmation_token, _approved, redispatch
        # TTL) and BEFORE the chip-emission path. Per-conversation
        # state always wins — the user's freshest gesture beats any
        # historic Settings entry. This matters when the user
        # cancels a chip in this turn but the model retries the same
        # call: the redispatch TTL is wallclock-bound by approval,
        # NOT by cancellation, so a cancel doesn't punch through to
        # the allowlist.
        mcp_for_allowlist = rule.mcp if rule else ""
        if (
            user_id
            and self._allowlist_lookup_fn is not None
            and self._allowlist_lookup_fn(
                user_id=user_id, tool_name=tool_name, mcp=mcp_for_allowlist
            )
        ):
            self._audit(
                "dispatched_user_allowlist",
                chat_id=chat_id,
                user_id=user_id,
                tool_name=tool_name,
                mcp=mcp_for_allowlist,
                hash=call_hash,
            )
            self._record_recent_dispatch(chat_id, call_hash)
            return ToolCallDecision(action="dispatch")

        # No token -> register pending and emit a card.
        summary_template = (
            rule.summary_template if rule and rule.summary_template else ""
        )
        if not summary_template:
            summary_template = (
                f"Run {tool_name} with the listed arguments."
            )
        summary = render_summary(summary_template, args)
        mcp = rule.mcp if rule else "unknown"

        action = PendingAction(
            chat_id=chat_id,
            user_id=user_id,
            tool_name=tool_name,
            mcp=mcp,
            args=args,
            summary=summary,
            call_hash=call_hash,
            proposed_at_ns=_now_ns(),
            # kind / options / prompt / context default to today's
            # tool-confirmation shape — no behavior change.
        )
        with self._lock:
            self._pending.setdefault(chat_id, {})[call_hash] = action

        card = Card(
            hash=call_hash,
            tool_name=tool_name,
            mcp=mcp,
            summary=summary,
            args_preview=self._args_preview(args),
            # The default Card constructor populates kind /
            # options / allow_freeform with the tool-confirmation
            # values. Set ``context`` empty for parity with the
            # historical chip; clarification chips set it.
            context={},
        )
        self._audit(
            "proposed",
            chat_id=chat_id,
            tool_name=tool_name,
            mcp=mcp,
            hash=call_hash,
        )
        return ToolCallDecision(action="block", card=card)

    # -- Generic clarification chip API (Phase 3) ---------------------------

    def propose_clarification(
        self,
        *,
        chat_id: str,
        user_id: Optional[str],
        prompt: str,
        options: list[ChipOption],
        allow_freeform: bool = False,
        context: Optional[dict[str, Any]] = None,
        # The proposer can pin a stable identity for the chip — useful when
        # the same logical question may be re-proposed (e.g. retry after a
        # process restart) and we want a stable hash. If omitted, we hash
        # (kind, prompt, sorted_option_ids, context_keys) so equivalent
        # questions collapse to one chip.
        identity: Optional[str] = None,
    ) -> Card:
        """Propose a generic clarification chip.

        Unlike tool-confirmation chips, clarifications:

        * have no ``tool_name`` / ``mcp`` / ``args`` (the chip is asking
          a question, not gating a side effect),
        * carry caller-supplied ``options`` (e.g. block / approve-once /
          widen-scope),
        * carry an opaque ``context`` dict so the proposer can correlate
          the resolution back to its own state (task_id, run_id, ...),
        * still flow through the same REST endpoint and same
          ``ResolutionRecord`` log as tool-confirmation chips, so
          consumers drain them with one API.

        The chip is registered in ``_pending`` like a tool-confirmation
        chip so the chip-click endpoint and ``has_pending`` checks see
        it. ``call_hash`` is treated as the chip's identity.
        """

        if not options:
            raise ValueError("clarification chip requires at least one option")
        if not prompt:
            raise ValueError("clarification chip requires a prompt")

        ctx = dict(context or {})
        identity_payload = identity or json.dumps(
            {
                "kind": "clarification",
                "prompt": prompt,
                "option_ids": sorted(opt.id for opt in options),
                # Only include sorted top-level context keys in the
                # identity hash — values may be timestamps that would
                # otherwise force a fresh chip on every retry.
                "context_keys": sorted(ctx.keys()),
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        call_hash = hashlib.sha256(identity_payload.encode("utf-8")).hexdigest()[:16]

        action = PendingAction(
            chat_id=chat_id,
            user_id=user_id,
            tool_name="",
            mcp="",
            args=None,
            summary=prompt,
            call_hash=call_hash,
            proposed_at_ns=_now_ns(),
            kind="clarification",
            options=list(options),
            prompt=prompt,
            allow_freeform=allow_freeform,
            context=ctx,
        )
        with self._lock:
            self._pending.setdefault(chat_id, {})[call_hash] = action

        card = Card(
            hash=call_hash,
            tool_name="",
            mcp="",
            summary=prompt,
            args_preview={},
            kind="clarification",
            prompt=prompt,
            options=list(options),
            allow_freeform=allow_freeform,
            context=ctx,
        )
        self._audit(
            "proposed",
            chat_id=chat_id,
            tool_name="",
            mcp="",
            hash=call_hash,
            kind="clarification",
        )
        return card

    def resolve_user_reply(
        self,
        *,
        chat_id: str,
        user_text: str,
    ) -> UserReplyOutcome:
        """Map a hand-typed user reply onto an approve/cancel/modify decision.

        UI button clicks (chip Yes / No / Reply-with-changes) flow through
        ``resolve_via_chip_click`` directly — they don't piggy-back on
        chat-completion turns. This resolver therefore only sees natural
        language:

        1. Strict-affirmative match (``yes``, ``y``, ``ok``, ``do it``,
           ``go ahead``, etc.) — counts as ``approve`` ONLY when EXACTLY one
           card is pending. Multiple pending + bare "yes" -> ``modify``,
           all pending dropped (this is what closes the original Slack
           incident's failure mode).
        2. Strict-negative match -> ``cancel``.
        3. Anything else (a question, edit request, new topic, compound
           reply) -> ``modify``, all pending dropped, the user's text is
           forwarded to the model as a normal turn.
        """

        with self._lock:
            pending_for_chat = dict(self._pending.get(chat_id, {}))

        text = (user_text or "").strip()

        if pending_for_chat and _AFFIRMATIVE_RE.match(text):
            if len(pending_for_chat) == 1:
                only_hash = next(iter(pending_for_chat.keys()))
                self._mark_approved(chat_id, only_hash)
                self._audit(
                    "approved",
                    chat_id=chat_id,
                    hash=only_hash,
                    via="natural_language",
                )
                return UserReplyOutcome(
                    decision="approve", approved_hash=only_hash
                )
            # Ambiguous "yes" with multiple cards pending -> drop them all
            # and treat as modify; this is the failure mode the original
            # Slack incident exercised.
            cancelled = self._drop_chat(chat_id)
            self._audit(
                "modified",
                chat_id=chat_id,
                hashes=cancelled,
                reason="ambiguous_affirmative_with_multi_pending",
            )
            return UserReplyOutcome(
                decision="modify",
                free_text=text,
                cancelled_hashes=cancelled,
            )

        if pending_for_chat and _NEGATIVE_RE.match(text):
            cancelled = self._drop_chat(chat_id)
            self._audit(
                "cancelled",
                chat_id=chat_id,
                hashes=cancelled,
                via="natural_language",
            )
            return UserReplyOutcome(
                decision="cancel", cancelled_hashes=cancelled
            )

        # Anything else -> modify. Drops pending; caller forwards `text` to
        # the model as a normal user turn so it can revise.
        cancelled = self._drop_chat(chat_id) if pending_for_chat else []
        if cancelled:
            self._audit(
                "modified",
                chat_id=chat_id,
                hashes=cancelled,
                reason="non_affirmative_reply",
            )
        return UserReplyOutcome(
            decision="modify",
            free_text=text,
            cancelled_hashes=cancelled,
        )

    def consume_user_turn(self, chat_id: str) -> list[str]:
        """TTL=1 turn enforcement on PENDING (un-confirmed) actions.

        After every user message (including the one resolve_user_reply() saw),
        clear any pending actions that the user did not explicitly approve.
        An old "yes" cannot authorize a future action because the pending
        entry it would match against is gone — and the approved-hash set is
        bound to the exact call hash, so consent never leaks to a different
        action.
        """

        return self._drop_chat(chat_id)

    def consume_assistant_turn(self, chat_id: str) -> list[str]:
        """Drop any unused approved hashes at the end of the assistant turn.

        If the model failed to replay an approved tool call within the same
        assistant turn, the approval expires. The next attempt will surface
        a fresh confirmation card.
        """

        with self._lock:
            approved = self._approved.pop(chat_id, set())
        if approved:
            self._audit(
                "expired",
                chat_id=chat_id,
                hashes=sorted(approved),
                reason="assistant_turn_finished_without_replay",
            )
        return sorted(approved)

    def _mark_approved(self, chat_id: str, call_hash: str) -> None:
        with self._lock:
            self._approved.setdefault(chat_id, set()).add(call_hash)
            # Approval also implies the pending entry is no longer eligible
            # for re-use through a different path; drop it.
            pending_for_chat = self._pending.get(chat_id)
            if pending_for_chat and call_hash in pending_for_chat:
                pending_for_chat.pop(call_hash, None)
                if not pending_for_chat:
                    self._pending.pop(chat_id, None)

    def _persist_allowlist_entry_after_chip(
        self,
        *,
        user_id: Optional[str],
        tool_name: str,
        mcp: str,
        chat_id: str,
        call_hash: str,
    ) -> None:
        """Round 4 / Issue 2b — persist a per-user allowlist entry
        when the user clicks "Always allow" on a chip. The actual
        write is delegated to ``_allowlist_writer_fn`` so the gate
        stays storage-agnostic. Failures are audit-logged but
        deliberately swallowed: the chip's "approve once" semantics
        already fired (see ``_mark_approved`` above) so the user's
        immediate intent is honoured even if the persistence fails.
        """

        if not user_id:
            self._audit(
                "always_allow_skipped_no_user",
                chat_id=chat_id,
                tool_name=tool_name,
                hash=call_hash,
            )
            return
        writer = self._allowlist_writer_fn
        if writer is None:
            # No writer wired (e.g. unit tests that didn't inject
            # one). Audit and bail; the user's chip click is still
            # honoured for THIS call via the normal approve path.
            self._audit(
                "always_allow_skipped_no_writer",
                chat_id=chat_id,
                tool_name=tool_name,
                hash=call_hash,
            )
            return
        try:
            writer(user_id=user_id, tool_name=tool_name, mcp=mcp or "")
        except Exception:  # noqa: BLE001
            log.exception(
                "[tool-confirmation-gate] always_allow writer raised; "
                "approve-once still applied"
            )
            self._audit(
                "always_allow_writer_failed",
                chat_id=chat_id,
                tool_name=tool_name,
                hash=call_hash,
            )
            return
        self._audit(
            "always_allow_persisted",
            chat_id=chat_id,
            user_id=user_id,
            tool_name=tool_name,
            mcp=mcp,
            hash=call_hash,
        )

    # ---- Round 4 / Issue 1: redispatch TTL cache helpers ---------------

    def _record_recent_dispatch(self, chat_id: str, call_hash: str) -> None:
        """Seed the redispatch cache with ``(chat_id, call_hash)`` valid for
        the configured TTL window.

        Called by ``evaluate_tool_call`` immediately after every successful
        dispatch (whether via explicit token, pre-approved hash, or a
        prior redispatch hit). When the TTL is configured to ``0`` the
        cache is disabled and this is a no-op.

        Lazy GC: this is also where we prune any expired entries for the
        same chat to keep the dict bounded without a background thread.
        """

        ttl_seconds = max(0, int(self._redispatch_ttl_seconds_provider()))
        if ttl_seconds == 0:
            with self._lock:
                self._recently_dispatched.pop(chat_id, None)
            return
        ttl_ns = ttl_seconds * 1_000_000_000
        now_ns = _now_ns()
        with self._lock:
            cache_for_chat = self._recently_dispatched.setdefault(chat_id, {})
            # Lazy GC for this chat.
            stale = [
                h for h, e in cache_for_chat.items() if not e.is_alive(now_ns)
            ]
            for h in stale:
                cache_for_chat.pop(h, None)
            cache_for_chat[call_hash] = RedispatchEntry(
                dispatched_at_ns=now_ns, ttl_ns=ttl_ns
            )

    def _consume_recent_dispatch(self, chat_id: str, call_hash: str) -> bool:
        """Check whether ``(chat_id, call_hash)`` is in the redispatch cache
        and still alive. Removes the entry on hit so the caller can re-seed
        it with a fresh timestamp under the call's actual TTL — this avoids
        a stale entry from a previously-larger TTL outliving the current
        config.

        Returns ``True`` on a fresh hit (caller should dispatch silently),
        ``False`` otherwise.
        """

        now_ns = _now_ns()
        with self._lock:
            cache_for_chat = self._recently_dispatched.get(chat_id)
            if not cache_for_chat:
                return False
            entry = cache_for_chat.get(call_hash)
            if entry is None:
                return False
            if not entry.is_alive(now_ns):
                cache_for_chat.pop(call_hash, None)
                if not cache_for_chat:
                    self._recently_dispatched.pop(chat_id, None)
                return False
            cache_for_chat.pop(call_hash, None)
            if not cache_for_chat:
                self._recently_dispatched.pop(chat_id, None)
            return True

    def recently_dispatched_size(self, chat_id: str) -> int:
        """Test/debug helper — number of live entries in the redispatch
        cache for this chat. Performs lazy GC on stale entries before
        returning."""

        now_ns = _now_ns()
        with self._lock:
            cache_for_chat = self._recently_dispatched.get(chat_id, {})
            stale = [
                h for h, e in cache_for_chat.items() if not e.is_alive(now_ns)
            ]
            for h in stale:
                cache_for_chat.pop(h, None)
            if not cache_for_chat:
                self._recently_dispatched.pop(chat_id, None)
                return 0
            return len(cache_for_chat)

    # Maps a tool-confirmation option id (the canonical chip-button id
    # the user clicked) to the audit-event "decision" string consumed by
    # historical audit dashboards (and ``ResolutionRecord.decision``).
    # The dict is the only place the tool-confirmation option vocabulary
    # is "interpreted" — clarification chips bypass it entirely.
    #
    # Renamed from ``_TOOL_CONFIRMATION_OPTION_TO_DECISION`` after the
    # round-4 KISS prune that deleted the legacy ``decision`` /
    # ``modify_payload`` parameters of ``resolve_via_chip_click``.
    _OPTION_ID_TO_AUDIT_DECISION = {
        TOOL_CONFIRMATION_OPTION_APPROVE: "approve",
        TOOL_CONFIRMATION_OPTION_CANCEL: "cancel",
        TOOL_CONFIRMATION_OPTION_MODIFY: "modify",
        # Round 4 / Issue 2 — "always allow" resolves the chip with
        # the same approve semantics as a regular Yes click; the
        # difference is that the resolver ALSO writes a per-user
        # allowlist entry (handled below in
        # ``resolve_via_chip_click``). We map it to the same audit
        # decision so historical dashboards counting "approved"
        # actions still see this click.
        TOOL_CONFIRMATION_OPTION_ALWAYS_ALLOW: "approve",
    }
    _TOOL_CONFIRMATION_DECISION_TO_AUDIT = {
        "approve": "approved",
        "cancel": "cancelled",
        "modify": "modified",
    }

    def resolve_via_chip_click(
        self,
        *,
        chat_id: str,
        call_hash: str,
        option_id: str,
        freeform_payload: Optional[str] = None,
    ) -> Optional[ResolutionRecord]:
        """Per-hash chip-click resolver used by the REST resolve endpoint.

        Unlike ``resolve_user_reply`` this does NOT consume sibling
        pendings, does NOT consume the assistant turn, and does NOT fire
        a chat-completion. It just updates per-hash state and accumulates
        a ``ResolutionRecord`` into ``_resolutions[chat_id]``. The
        caller (REST endpoint) returns immediately. The synthesis +
        dispatch happens later, when the renderer fires a batch-send
        chat turn and the middleware reads the resolution log via
        ``pop_resolutions_for_batch``.

        Returns the recorded ``ResolutionRecord`` on success, or ``None``
        if the hash is not currently pending for this chat OR the option
        id is unknown for this chip (both are idempotent no-ops — a
        double click on the same chip, or a forged button id, must not
        crash the resolver).

        Vocabulary: ``option_id`` is the canonical button id the chip
        declared. For tool-confirmation chips it is one of
        ``approve`` / ``cancel`` / ``modify`` (matching the
        ``TOOL_CONFIRMATION_OPTION_*`` constants). For clarification
        chips it must match one of ``Card.options[*].id``. The gate
        validates the id against the chip's own declaration — a forged
        or unknown id is rejected with ``gate_bypass_attempted`` so a
        malicious frontend cannot invent extra buttons.

        ``freeform_payload`` carries the optional textarea contents
        (used by tool-confirmation ``modify`` and by clarification
        chips with ``allow_freeform=true``). For all other tool-
        confirmation options the parameter is ignored.

        Hash binding: the call hash MUST currently be pending — this
        prevents replay of an already-resolved hash and prevents a
        forged hash from registering an approval. ``_audit`` records
        the click (or the rejection) under the audit pipeline used by
        the rest of the gate.

        Note: the legacy ``decision`` and ``modify_payload`` parameters
        were removed in round 4 of the chip rework. Old call sites that
        passed ``decision="approve"`` migrate to ``option_id="approve"``
        (same string value) and ``modify_payload="..."`` migrates to
        ``freeform_payload="..."``.
        """

        if not option_id:
            self._audit(
                "gate_bypass_attempted",
                chat_id=chat_id,
                hash=call_hash,
                reason="chip_click_missing_option_id",
            )
            return None

        with self._lock:
            pending_for_chat = self._pending.get(chat_id, {})
            pending = pending_for_chat.get(call_hash)
            if pending is None:
                # Hash is not currently pending — either already
                # resolved (idempotent no-op), or forged.
                self._audit(
                    "gate_bypass_attempted",
                    chat_id=chat_id,
                    hash=call_hash,
                    reason="chip_click_for_unknown_hash",
                )
                return None
            tool_name = pending.tool_name
            mcp = pending.mcp
            summary = pending.summary
            kind = pending.kind
            # Round 4 / Issue 2 — snapshot the user_id for the
            # ``always_allow`` writer so we don't have to re-grab
            # ``pending`` (which may be evicted by ``_drop_chat``
            # immediately after this block).
            pending_user_id = pending.user_id
            allowed_option_ids = {opt.id for opt in pending.options}
            context_snapshot = dict(pending.context)
            # Deep-snapshot args before ``_mark_approved`` / ``_drop_chat``
            # remove the pending entry — without this the args we'd echo
            # back at the model would already be gone.
            args_snapshot = (
                json.loads(json.dumps(pending.args, default=str))
                if pending.args is not None
                else None
            )

        if option_id not in allowed_option_ids:
            self._audit(
                "gate_bypass_attempted",
                chat_id=chat_id,
                hash=call_hash,
                reason=f"unknown_chip_option:{option_id!r}",
                kind=kind,
            )
            return None

        # Tool-confirmation chips populate ``ResolutionRecord.decision``
        # for audit-pipeline consumers; clarification chips leave it
        # blank so consumers know to read ``option_id``.
        if kind == "tool_confirmation":
            decision = self._OPTION_ID_TO_AUDIT_DECISION.get(option_id, "")
            if not decision:
                # Defensive: a tool-confirmation chip with an option id
                # outside the canonical vocabulary should never reach
                # this resolver (the routing for ``allow_always`` etc.
                # happens upstream). Audit and bail.
                self._audit(
                    "gate_bypass_attempted",
                    chat_id=chat_id,
                    hash=call_hash,
                    reason=f"tool_confirmation_option_not_resolvable:{option_id!r}",
                )
                return None
            legacy_modify_payload: Optional[str] = (
                (freeform_payload or None)
                if option_id == TOOL_CONFIRMATION_OPTION_MODIFY
                else None
            )
            resolved_freeform = legacy_modify_payload
        else:
            decision = ""
            legacy_modify_payload = None
            resolved_freeform = freeform_payload

        record = ResolutionRecord(
            call_hash=call_hash,
            tool_name=tool_name,
            mcp=mcp,
            summary=summary,
            decision=decision,
            modify_payload=legacy_modify_payload,
            args=args_snapshot,
            kind=kind,
            option_id=option_id,
            context=context_snapshot,
            freeform_payload=resolved_freeform,
        )

        if kind == "tool_confirmation" and option_id in (
            TOOL_CONFIRMATION_OPTION_APPROVE,
            TOOL_CONFIRMATION_OPTION_ALWAYS_ALLOW,
        ):
            # Both options approve THIS call. ``always_allow``
            # additionally writes a persistent allowlist entry so
            # future identical calls dispatch silently.
            self._mark_approved(chat_id, call_hash)
            if option_id == TOOL_CONFIRMATION_OPTION_ALWAYS_ALLOW:
                self._persist_allowlist_entry_after_chip(
                    user_id=pending_user_id,
                    tool_name=tool_name,
                    mcp=mcp,
                    chat_id=chat_id,
                    call_hash=call_hash,
                )
        else:
            # cancel / modify / any-clarification: drop the pending
            # entry. ``_drop_chat`` is a no-op if it's already gone.
            self._drop_chat(chat_id, only=[call_hash])

        with self._lock:
            self._resolutions.setdefault(chat_id, {})[call_hash] = record

        # Audit: tool-confirmation chips keep their past-tense event
        # names (so dashboards keep working). Clarifications use a
        # neutral ``resolved`` event with the option id.
        if kind == "tool_confirmation":
            audit_event = self._TOOL_CONFIRMATION_DECISION_TO_AUDIT[decision]
            self._audit(
                audit_event,
                chat_id=chat_id,
                hash=call_hash,
                tool_name=tool_name,
                via="ui_button_rest",
            )
        else:
            self._audit(
                "resolved",
                chat_id=chat_id,
                hash=call_hash,
                kind=kind,
                option_id=option_id,
                via="ui_button_rest",
            )
        return record

    def pop_resolutions_for_batch(self, chat_id: str) -> list[ResolutionRecord]:
        """Drain and return the resolution records accumulated for this chat.

        Called by the middleware when the renderer fires a batch-send
        chat turn (``form_data.tool_confirmation_batch_send: true``).
        The records are cleared atomically so a follow-up turn cannot
        replay them. The returned list is ordered by registration time
        (Python 3.7+ dict insertion order).
        """

        with self._lock:
            records = list(self._resolutions.pop(chat_id, {}).values())
        return records

    def has_resolutions(self, chat_id: str) -> bool:
        with self._lock:
            return bool(self._resolutions.get(chat_id))

    def pending_for_chat(self, chat_id: str) -> list[PendingAction]:
        with self._lock:
            return list(self._pending.get(chat_id, {}).values())

    def has_pending(self, chat_id: str) -> bool:
        with self._lock:
            return bool(self._pending.get(chat_id))

    def chat_attention_for_user(
        self, user_id: Optional[str]
    ) -> dict[str, str]:
        """Return ``{chat_id: reason}`` for chats with at least one pending
        chip belonging to ``user_id`` — drives the amber attention dot in
        the sidebar (Round 4 / Issue 7b wiring).

        Reasons are derived from the chip ``kind`` so the renderer's
        tooltip can be specific without leaking call details:

        * ``tool_confirmation`` → ``"awaiting_confirmation"``
        * ``clarification`` → ``"awaiting_clarification"``
        * any other (forward-compat) kind → its raw label

        Filtering rules:

        * If a pending action carries no ``user_id`` (legacy / system
          actions), it's still surfaced — the chat ownership check is
          done at the route layer via ``Chats.get_chats_by_user_id``.
          That gives the route a tighter authorization boundary than
          the in-memory store.
        * If ``user_id`` is provided AND the action also has a
          ``user_id`` and they don't match, the entry is skipped — that
          stops the gate from leaking another user's pending chips even
          if a route's chat-ownership check is ever bypassed.
        """

        out: dict[str, str] = {}
        with self._lock:
            # Snapshot to avoid holding the lock while doing any
            # bookkeeping. ``_pending`` is a small dict; iteration is
            # cheap.
            snapshot = {
                chat_id: list(by_hash.values())
                for chat_id, by_hash in self._pending.items()
            }
        for chat_id, actions in snapshot.items():
            for action in actions:
                if (
                    user_id
                    and action.user_id
                    and action.user_id != user_id
                ):
                    continue
                kind = action.kind or "tool_confirmation"
                if kind == "tool_confirmation":
                    reason = "awaiting_confirmation"
                elif kind == "clarification":
                    reason = "awaiting_clarification"
                else:
                    reason = kind
                # First chip wins — the dot is binary, the reason is
                # just a hint for the tooltip. Deterministic ordering
                # by insertion order of ``_pending`` keeps output stable
                # for tests.
                out.setdefault(chat_id, reason)
                break
        return out

    # -- internal ----------------------------------------------------------

    def _drop_chat(
        self, chat_id: str, *, only: Optional[list[str]] = None
    ) -> list[str]:
        with self._lock:
            chat = self._pending.get(chat_id)
            if not chat:
                return []
            if only is None:
                hashes = list(chat.keys())
                self._pending.pop(chat_id, None)
                return hashes
            removed: list[str] = []
            for h in only:
                if chat.pop(h, None) is not None:
                    removed.append(h)
            if not chat:
                self._pending.pop(chat_id, None)
            return removed


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _now_ns() -> int:
    import time

    return time.monotonic_ns()


def _truncate_for_preview(value: Any, *, limit: int = 200) -> Any:
    if isinstance(value, str):
        return value if len(value) <= limit else value[: limit - 1] + "\u2026"
    if isinstance(value, (list, dict)):
        try:
            serialized = json.dumps(value, ensure_ascii=False)
        except (TypeError, ValueError):
            return str(value)[:limit]
        if len(serialized) <= limit:
            return value
        return f"<{type(value).__name__} ~{len(serialized)} chars>"
    return value


# ---------------------------------------------------------------------------
# Module-level default gate (lazy)
# ---------------------------------------------------------------------------


_default_gate_lock = threading.Lock()
_default_gate: Optional[Gate] = None


def default_gate() -> Gate:
    """Return the module-level singleton gate, creating it on first call."""

    global _default_gate
    if _default_gate is None:
        with _default_gate_lock:
            if _default_gate is None:
                _default_gate = Gate(
                    allowlist_lookup_fn=_default_allowlist_lookup,
                    allowlist_writer_fn=_default_allowlist_writer,
                )
    return _default_gate


def _default_allowlist_writer(
    *, user_id: str, tool_name: str, mcp: str
) -> None:
    """Production writer for the "Always allow" chip resolver.

    Mirrors ``_default_allowlist_lookup`` — defers to
    ``tool_allowlist`` so the gate stays decoupled from the on-disk
    layout. Imports are lazy for the same reasons (tests + boot
    environments without ``open_webui.config``)."""

    from open_webui.utils.tool_allowlist import upsert_entry_for_user
    from open_webui.config import DATA_DIR  # type: ignore[import-not-found]

    upsert_entry_for_user(
        user_id=user_id,
        tool_name=tool_name,
        mcp=mcp,
        enabled=True,
        data_dir=DATA_DIR,
    )


def _default_allowlist_lookup(
    *, user_id: str, tool_name: str, mcp: str
) -> bool:
    """Production allowlist hook for the default gate.

    Round 4 / Issue 2 — defers to ``tool_allowlist`` so the gate
    doesn't have a hard dependency on file-system layout. Tests
    inject a fake via ``Gate(allowlist_lookup_fn=...)`` and never
    touch this function.

    Imported lazily so unrelated tool-confirmation tests (which
    monkeypatch ``DATA_DIR`` env vars or run in environments
    without ``open_webui.config``) keep working.
    """

    try:
        from open_webui.utils.tool_allowlist import is_call_allowlisted_for_user
        from open_webui.config import DATA_DIR  # type: ignore[import-not-found]
    except Exception:  # noqa: BLE001
        return False
    return is_call_allowlisted_for_user(
        user_id=user_id,
        tool_name=tool_name,
        mcp=mcp,
        data_dir=DATA_DIR,
    )


def reset_default_gate_for_testing(gate: Optional[Gate] = None) -> None:
    """Test helper — replace or clear the singleton."""

    global _default_gate
    with _default_gate_lock:
        _default_gate = gate


# ---------------------------------------------------------------------------
# Public exports
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Tool Action Policy — system-prompt block (Phase C.1)
# ---------------------------------------------------------------------------


TOOL_ACTION_POLICY_PROMPT = """\
## Tool Action Policy (mandatory)

Tools that have an externally-observable side effect (send / post /
publish / create / update / delete / move / merge / execute / trigger /
grant / revoke / assign / activate / deactivate, including but not
limited to Slack messages, Gmail / calendar / Drive / Docs / Sheets /
Slides mutations, GitLab / Jira / Confluence / Atlassian writes, n8n
workflow runs, data-platform query execution, notifications, and any
similar action) are gated by a runtime confirmation chip. The chip is
the canonical and SOLE confirmation surface for these tools.

### Calling destructive tools

1. The current user must have just asked you, in their most recent
   turn, to do this action. Do not re-use approval the user gave for a
   different action, even if it was in the same conversation. If the
   user's last message is a question, a planning request, an "ok sounds
   good", a brainstorm, or anything other than a direct go-ahead for
   this kind of action, do NOT call the tool — answer or plan in plain
   text instead.

2. When the user does ask, call the tool DIRECTLY with the arguments
   that match their request. Do not first ask "Should I send this?" or
   "Are you sure?" in plain text — that creates a redundant double
   confirmation. Likewise, do NOT use `skills_ask_user_question` for
   destructive-tool confirmation. The runtime will intercept the
   dispatch and show the user a confirmation chip in their chat input
   frame containing the exact tool name, destination, and full payload.
   The user clicks Yes / No / "Reply with changes" — that is the per-
   action confirmation. (`skills_ask_user_question` is still fine for
   *other* short user choices: picking a marketplace target, selecting
   between implementation options, etc. — just not for confirming
   destructive tool calls.)

3. The arguments you pass should reflect the user's request as closely
   as you can interpret it. If they were vague, pick a reasonable
   interpretation — the chip shows the FULL payload, so the user has
   the chance to edit or cancel before any side effect occurs.

4. If the user asks for several destructive actions in one turn (e.g.
   "send the Slack message AND a follow-up email"), emit ALL of them
   in the SAME assistant turn, each as its own tool call. The runtime
   will block them all and stack them as separate chips above the
   input. The user resolves the chips as a batch; do not loop one at
   a time waiting for replies between calls.

### How chip resolutions reach you

When the user clicks chips and submits the batch, you will receive a
hidden system message bracketed by:

  [PORTICO-PORTICO-N-012-BATCH-RESOLUTION-START]
  ...
  [PORTICO-PORTICO-N-012-BATCH-RESOLUTION-END]

Each line inside is one chip's outcome:

- **APPROVED — re-emit `<tool_name>` with the original arguments.**
  Re-emit that exact tool call on THIS turn. The runtime has cached
  the approval keyed by the call's hash; the next dispatch will
  succeed silently without showing a new chip. If you fail to re-
  emit, the action will not happen — the chip click is a license to
  call, not a delegation. The approval is single-use; only one
  re-emit is needed per APPROVED line.

- **CANCELLED — do NOT re-emit `<tool_name>`.** Acknowledge the
  cancellation in plain text and (optionally) offer a different next
  step. Do not silently retry the original call. Do not "try again
  with slightly different args" unless the user explicitly asks for
  it on a follow-up turn.

- **MODIFY — re-issue `<tool_name>` with arguments that incorporate
  the user's request: '<payload>'.** Issue a NEW tool call whose
  arguments reflect the modification verbatim. This will produce a
  fresh chip with the new payload; the user will approve (or cancel
  / modify again) on the next turn. Do not pre-emptively explain or
  ask for clarification — make the modification you understood and
  let the chip surface the result.

A typical batch turn for you looks like:

    [system: BATCH-RESOLUTION-START
       1. APPROVED — re-emit `slack_conversations_add_message` ...
       2. CANCELLED — do NOT re-emit `gmail_send_message` ...
       3. MODIFY — re-issue `calendar_create_event` with: 'tomorrow at 2pm'.
     BATCH-RESOLUTION-END]

You: emit `slack_conversations_add_message` (re-emit, will dispatch),
emit `calendar_create_event` with the new args (will produce a fresh
chip), then write a brief plain-text acknowledgement that the email
was cancelled.

### Failure modes

If you call a destructive tool and the runtime returns
`hash_mismatch`, `gate_bypass_attempted`, or any block reason, do NOT
retry the same call. Wait for the user's next message.

Read-only tools (search, list, history, get-by-id) do not require
confirmation; you may use them freely and in parallel with destructive
ones.
"""


def inject_tool_action_policy(form_data: Any) -> Any:
    """Append the Tool Action Policy block to the request's system prompt.

    Idempotent: if the block is already present, the call is a no-op. Works
    on both string and array message-content shapes.
    """

    if not isinstance(form_data, dict):
        return form_data

    messages = form_data.get("messages")
    if not isinstance(messages, list):
        return form_data

    marker = "## Tool Action Policy (mandatory)"
    block = TOOL_ACTION_POLICY_PROMPT.strip()

    for message in messages:
        if not isinstance(message, dict) or message.get("role") != "system":
            continue
        content = message.get("content")
        if isinstance(content, str):
            if marker in content:
                return form_data
            message["content"] = (
                content.rstrip() + "\n\n" + block if content.strip() else block
            )
            return form_data
        if isinstance(content, list):
            text_blocks = [
                piece for piece in content
                if isinstance(piece, dict) and piece.get("type") == "text"
            ]
            joined = "".join(str(piece.get("text", "")) for piece in text_blocks)
            if marker in joined:
                return form_data
            content.append({"type": "text", "text": "\n\n" + block})
            return form_data

    messages.insert(0, {"role": "system", "content": block})
    return form_data


__all__ = [
    "Card",
    "ChipOption",
    "Gate",
    "OUT_OF_SCOPE_OPTION_APPROVE_ONCE",
    "OUT_OF_SCOPE_OPTION_BLOCK",
    "OUT_OF_SCOPE_OPTION_WIDEN_SCOPE",
    "PendingAction",
    "Registry",
    "ResolutionRecord",
    "TOOL_ACTION_POLICY_PROMPT",
    "TOOL_CONFIRMATION_OPTION_APPROVE",
    "TOOL_CONFIRMATION_OPTION_CANCEL",
    "TOOL_CONFIRMATION_OPTION_MODIFY",
    "TOOL_CONFIRMATION_OPTION_ALWAYS_ALLOW",
    "ToolCallDecision",
    "UserReplyOutcome",
    "compute_call_hash",
    "default_gate",
    "inject_tool_action_policy",
    "render_summary",
    "reset_default_gate_for_testing",
]
