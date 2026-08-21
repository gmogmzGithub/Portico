// Agents component - Chat UI / Control Plane layer.
// Manages local OWUI agent presets + Discover/Install via the AI Marketplace.
// No timers, no polling. All work is triggered by user actions.

(function initAgentsModule() {
  const MCPO_PORT = 8766;
  const SUBAGENTS_SERVER_ID = "subagents";
  const TOOL_LIST = "subagents_list_agents";
  const TOOL_GET = "subagents_get_agent";
  const TOOL_GET_SYSTEM_PROMPT = "subagents_get_agent_system_prompt";
  const TOOL_CREATE = "subagents_create_agent";
  const TOOL_UPDATE = "subagents_update_agent";
  const TOOL_DELETE = "subagents_delete_agent";
  const SYSTEM_AGENT_PREFIX = "portico_agent_";
  const agentNameValidationApi =
    (typeof require === "function"
      ? require("../../services/agent-name-validation")
      : null) || {};
  // Two-letter fallback logo for a skill (first-word + last-word initials, e.g.
  // "MCP Bridge Setup" -> "MS"). Inlined (renderer has no `require`); the same
  // logic lives in services/skill-initials.js for unit tests.
  function skillInitials(displayName) {
    const cleaned = String(displayName || "")
      .split("/")
      .filter(Boolean)
      .pop();
    const words = String(cleaned || "")
      .replace(/[-_]+/g, " ")
      .split(/\s+/)
      .map((w) => w.trim())
      .filter(Boolean);
    if (words.length === 0) return "S";
    if (words.length === 1) {
      const w = words[0];
      return (w.length >= 2 ? w.slice(0, 2) : w).toUpperCase();
    }
    return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase();
  }
  const agentReasoningOptionsApi =
    globalThis.AgentReasoningOptions ||
    (typeof require === "function"
      ? require("./agent-reasoning-options")
      : null);
  if (!agentReasoningOptionsApi) {
    throw new Error("Agent reasoning options helper failed to load");
  }
  const agentModelPickerApi =
    globalThis.AgentModelPicker ||
    (typeof require === "function" ? require("./agent-model-picker") : null);
  if (!agentModelPickerApi) {
    throw new Error("Agent model picker helper failed to load");
  }
  const agentReasoningSliderApi =
    globalThis.AgentReasoningSlider ||
    (typeof require === "function" ? require("./agent-reasoning-slider") : null);
  if (!agentReasoningSliderApi) {
    throw new Error("Agent reasoning slider helper failed to load");
  }
  const {
    buildReasoningEffortFieldState,
    normalizeReasoningEffortForSubmission,
  } = agentReasoningOptionsApi;
  const MAX_AGENT_NAME_LENGTH =
    Number.isFinite(agentNameValidationApi.MAX_AGENT_NAME_LENGTH)
      ? agentNameValidationApi.MAX_AGENT_NAME_LENGTH
      : 100;
  const CONTROL_CHAR_REGEX = /[\u0000-\u001f\u007f]/;
  const normalizeAgentName =
    typeof agentNameValidationApi.normalizeAgentName === "function"
      ? agentNameValidationApi.normalizeAgentName
      : function fallbackNormalizeAgentName(value) {
          return String(value || "")
            .trim()
            .replace(/\s+/g, " ")
            .toLowerCase();
        };
  const validateAgentName =
    typeof agentNameValidationApi.validateAgentName === "function"
      ? agentNameValidationApi.validateAgentName
      : function fallbackValidateAgentName(
          value,
          { existingNames = [], currentName = "" } = {},
        ) {
          const trimmed = String(value || "").trim();
          if (!trimmed) {
            return { valid: false, value: "", error: "Name is required" };
          }
          if (trimmed.length > MAX_AGENT_NAME_LENGTH) {
            return {
              valid: false,
              value: trimmed,
              error: `Name must be ${MAX_AGENT_NAME_LENGTH} characters or fewer`,
            };
          }
          if (CONTROL_CHAR_REGEX.test(trimmed)) {
            return {
              valid: false,
              value: trimmed,
              error: "Name contains unsupported control characters",
            };
          }

          const normalized = normalizeAgentName(trimmed);
          const normalizedCurrent = normalizeAgentName(currentName);
          const duplicate = existingNames.some((candidate) => {
            const normalizedCandidate = normalizeAgentName(candidate);
            return normalizedCandidate && normalizedCandidate === normalized;
          });
          if (duplicate && normalized !== normalizedCurrent) {
            return {
              valid: false,
              value: trimmed,
              error: "Name must be unique",
            };
          }
          return { valid: true, value: trimmed, error: "" };
        };

  const TYPE_AGENTS = "portico-agents";
  const TYPE_SKILL = "skills";
  const TYPE_MCP_SERVERS = "mcp-servers";
  const DISCOVER_TYPES = new Set([TYPE_AGENTS, TYPE_SKILL]);
  const AGENT_ALLOWED_EMAILS_DRAFTS_KEY = "portico.agent-allowed-emails-drafts";
  const INSTALL_LABELS = {
    [TYPE_AGENTS]: "Install Agent",
    [TYPE_SKILL]: "Install Skill",
  };

  // ===========================================================================
  // DISCARD-CHANGES CONFIRMATION MODAL
  // Shared confirmation-card modal (same pattern as the delete-skill modal in
  // agent-skills.js) shown when leaving the inline agent editor with unsaved
  // changes. Static template lives in index.html (#agents-discard-modal).
  // ===========================================================================

  let discardModalWired = false;
  let discardModalOnDiscard = null;

  function hideAgentsDiscardModal() {
    document.getElementById("agents-discard-modal")?.classList.remove("visible");
    discardModalOnDiscard = null;
  }

  function wireAgentsDiscardModal(modal) {
    if (discardModalWired) return;
    discardModalWired = true;
    document
      .getElementById("agents-discard-close-btn")
      ?.addEventListener("click", hideAgentsDiscardModal);
    document
      .getElementById("agents-discard-keep-btn")
      ?.addEventListener("click", hideAgentsDiscardModal);
    document
      .getElementById("agents-discard-confirm-btn")
      ?.addEventListener("click", () => {
        const onDiscard = discardModalOnDiscard;
        // Hide before invoking so a re-dispatched navigation click isn't
        // swallowed by the still-open modal.
        hideAgentsDiscardModal();
        onDiscard?.();
      });
    modal.addEventListener("click", (event) => {
      if (event.target === modal) hideAgentsDiscardModal();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && modal.classList.contains("visible")) {
        hideAgentsDiscardModal();
      }
    });
  }

  function showAgentsDiscardModal({ subject, onDiscard }) {
    const modal = document.getElementById("agents-discard-modal");
    if (!modal) {
      // Fail open rather than trapping the user in the editor.
      onDiscard?.();
      return;
    }
    wireAgentsDiscardModal(modal);
    const subjectEl = document.getElementById("agents-discard-subject");
    if (subjectEl) subjectEl.textContent = subject || "this agent";
    discardModalOnDiscard = typeof onDiscard === "function" ? onDiscard : null;
    modal.classList.add("visible");
  }

  // Generic reusable confirm modal (replaces window.confirm) — consistent with
  // the discard/delete modal family. Static template lives in index.html
  // (#agents-confirm-modal). Exposed on window so bundled renderers (e.g.
  // agent-skills.js) can call it too.
  let confirmModalWired = false;
  let confirmModalOnConfirm = null;
  let confirmModalOnCancel = null;
  let confirmModalBusyLabel = "";
  // Optional third action (e.g. "Delete local only" beside "Delete local +
  // listing") — same busy/inline-error contract as the primary confirm.
  let confirmModalOnSecondary = null;
  let confirmModalSecondaryBusyLabel = "";
  // Bumped on every show(). Async-confirm settle handlers compare against it so
  // a chained modal (shown from inside an onConfirm) is never hidden or
  // error-stamped by its predecessor's completion.
  let confirmModalSession = 0;

  function hideAgentsConfirmModal() {
    document.getElementById("agents-confirm-modal")?.classList.remove("visible");
    confirmModalOnConfirm = null;
    confirmModalOnCancel = null;
    confirmModalOnSecondary = null;
  }

  function setAgentsConfirmError(message = "") {
    const errorEl = document.getElementById("agents-confirm-error");
    if (!errorEl) return;
    const text = String(message || "").trim();
    errorEl.textContent = text;
    errorEl.hidden = !text;
  }

  // Module-scope twin of the controller's setBusyButtonState (this modal code
  // lives outside the controller factory). Labels are our own literals.
  function setConfirmButtonBusy(button, busyLabel) {
    if (!button) return () => {};
    const originalHtml = button.innerHTML;
    const originalDisabled = button.disabled;
    button.disabled = true;
    button.dataset.busy = "true";
    button.setAttribute("aria-busy", "true");
    const safeLabel = String(busyLabel || "").replace(/[&<>"']/g, "");
    button.innerHTML = safeLabel
      ? `<div class="btn-spinner"></div> ${safeLabel}`
      : `<div class="btn-spinner"></div>`;
    return () => {
      button.innerHTML = originalHtml;
      button.disabled = originalDisabled;
      delete button.dataset.busy;
      button.removeAttribute("aria-busy");
    };
  }

  function setAgentsConfirmBusy(modal, busy) {
    if (busy) {
      modal.dataset.busy = "true";
    } else {
      delete modal.dataset.busy;
    }
    const cancelBtn = document.getElementById("agents-confirm-cancel-btn");
    const closeBtn = document.getElementById("agents-confirm-close-btn");
    const secondaryBtn = document.getElementById("agents-confirm-secondary-btn");
    if (cancelBtn) cancelBtn.disabled = busy;
    if (closeBtn) closeBtn.disabled = busy;
    if (secondaryBtn && !secondaryBtn.dataset.busy) secondaryBtn.disabled = busy;
  }

  // Runs a confirm-modal action with the shared busy/inline-error contract:
  // sync actions hide immediately; async actions spin on their own button,
  // surface failures inline, and stay open (session-guarded so a chained
  // modal is never hidden by its predecessor's completion).
  function runAgentsConfirmAction(modal, action, button, busyLabel) {
    if (!action) {
      hideAgentsConfirmModal();
      return;
    }
    const result = action();
    if (!result || typeof result.then !== "function") {
      hideAgentsConfirmModal();
      return;
    }
    const session = confirmModalSession;
    setAgentsConfirmError();
    setAgentsConfirmBusy(modal, true);
    const restore = setConfirmButtonBusy(button, busyLabel);
    const otherBtn =
      button?.id === "agents-confirm-secondary-btn"
        ? document.getElementById("agents-confirm-btn")
        : document.getElementById("agents-confirm-secondary-btn");
    const otherWasDisabled = otherBtn ? otherBtn.disabled : false;
    if (otherBtn) otherBtn.disabled = true;
    result
      .then(() => {
        if (session !== confirmModalSession) return;
        setAgentsConfirmBusy(modal, false);
        restore();
        if (otherBtn) otherBtn.disabled = otherWasDisabled;
        hideAgentsConfirmModal();
      })
      .catch((error) => {
        if (session !== confirmModalSession) return;
        setAgentsConfirmBusy(modal, false);
        restore();
        if (otherBtn) otherBtn.disabled = otherWasDisabled;
        setAgentsConfirmError(error?.message || String(error));
      });
  }

  function wireAgentsConfirmModal(modal) {
    if (confirmModalWired) return;
    confirmModalWired = true;
    const isBusy = () => modal.dataset.busy === "true";
    document.getElementById("agents-confirm-close-btn")?.addEventListener("click", () => {
      if (isBusy()) return;
      hideAgentsConfirmModal();
    });
    document.getElementById("agents-confirm-cancel-btn")?.addEventListener("click", () => {
      if (isBusy()) return;
      const onCancel = confirmModalOnCancel;
      hideAgentsConfirmModal();
      onCancel?.();
    });
    document.getElementById("agents-confirm-btn")?.addEventListener("click", () => {
      if (isBusy()) return;
      runAgentsConfirmAction(
        modal,
        confirmModalOnConfirm,
        document.getElementById("agents-confirm-btn"),
        confirmModalBusyLabel,
      );
    });
    document
      .getElementById("agents-confirm-secondary-btn")
      ?.addEventListener("click", () => {
        if (isBusy()) return;
        runAgentsConfirmAction(
          modal,
          confirmModalOnSecondary,
          document.getElementById("agents-confirm-secondary-btn"),
          confirmModalSecondaryBusyLabel,
        );
      });
    modal.addEventListener("click", (event) => {
      if (event.target === modal && !isBusy()) hideAgentsConfirmModal();
    });
    document.addEventListener("keydown", (event) => {
      if (
        event.key === "Escape" &&
        modal.classList.contains("visible") &&
        !isBusy()
      ) {
        hideAgentsConfirmModal();
      }
    });
  }

  const CONFIRM_META_COPY_ICON =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
  const CONFIRM_META_CHECK_ICON =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>';

  function showAgentsConfirmModal({
    title = "Are you sure?",
    message = "",
    confirmLabel = "Confirm",
    confirmBusyLabel = "",
    cancelLabel = "Cancel",
    danger = false,
    // { badge, copyValue? }: renders the badge (e.g. a solution id) in a
    // chip row under the message with a copy button — identifiers stay out
    // of the sentence copy.
    meta = null,
    // Optional third action rendered between Cancel and the confirm button
    // (same async busy/inline-error contract as onConfirm).
    secondaryLabel = "",
    secondaryBusyLabel = "",
    onSecondary = null,
    onConfirm,
    onCancel,
  } = {}) {
    const modal = document.getElementById("agents-confirm-modal");
    if (!modal) {
      // Fail closed for a confirm (do nothing) rather than silently acting.
      return;
    }
    wireAgentsConfirmModal(modal);
    confirmModalSession += 1;
    const titleEl = document.getElementById("agents-confirm-title");
    const messageEl = document.getElementById("agents-confirm-message");
    const confirmBtn = document.getElementById("agents-confirm-btn");
    const cancelBtn = document.getElementById("agents-confirm-cancel-btn");
    if (titleEl) titleEl.textContent = title;
    if (messageEl) messageEl.textContent = message;
    const metaEl = document.getElementById("agents-confirm-meta");
    if (metaEl) {
      metaEl.innerHTML = "";
      metaEl.hidden = true;
      if (meta?.badge) {
        const chip = document.createElement("span");
        chip.className = "agents-confirm-meta-badge";
        chip.textContent = String(meta.badge);
        metaEl.appendChild(chip);
        const copyValue = String(meta.copyValue ?? meta.badge);
        const copyBtn = document.createElement("button");
        copyBtn.type = "button";
        copyBtn.className = "agents-confirm-meta-copy";
        copyBtn.title = "Copy";
        copyBtn.setAttribute("aria-label", "Copy");
        copyBtn.innerHTML = CONFIRM_META_COPY_ICON;
        copyBtn.addEventListener("click", () => {
          void navigator.clipboard?.writeText?.(copyValue);
          copyBtn.innerHTML = CONFIRM_META_CHECK_ICON;
          setTimeout(() => {
            copyBtn.innerHTML = CONFIRM_META_COPY_ICON;
          }, 1200);
        });
        metaEl.appendChild(copyBtn);
        metaEl.hidden = false;
      }
    }
    if (confirmBtn) {
      confirmBtn.textContent = confirmLabel;
      confirmBtn.disabled = false;
      confirmBtn.removeAttribute("aria-busy");
      delete confirmBtn.dataset.busy;
      confirmBtn.classList.toggle("btn-danger", Boolean(danger));
      confirmBtn.classList.toggle("btn-primary", !danger);
    }
    if (cancelBtn) cancelBtn.textContent = cancelLabel;
    const secondaryBtn = document.getElementById("agents-confirm-secondary-btn");
    const hasSecondary =
      Boolean(secondaryLabel) && typeof onSecondary === "function";
    if (secondaryBtn) {
      secondaryBtn.hidden = !hasSecondary;
      secondaryBtn.disabled = false;
      secondaryBtn.removeAttribute("aria-busy");
      delete secondaryBtn.dataset.busy;
      if (hasSecondary) secondaryBtn.textContent = secondaryLabel;
    }
    setAgentsConfirmError();
    setAgentsConfirmBusy(modal, false);
    confirmModalBusyLabel = String(confirmBusyLabel || confirmLabel || "");
    confirmModalSecondaryBusyLabel = String(
      secondaryBusyLabel || secondaryLabel || "",
    );
    confirmModalOnConfirm = typeof onConfirm === "function" ? onConfirm : null;
    confirmModalOnCancel = typeof onCancel === "function" ? onCancel : null;
    confirmModalOnSecondary = hasSecondary ? onSecondary : null;
    modal.classList.add("visible");
  }

  // Controller factory. Instantiated once per tab (Solutions Marketplace +
  // Agents) so the same logic backs both views without duplicating ~1600 lines.
  // `cfg` supplies the DOM ids and per-tab behavior (e.g. locked discover type).
  // Floating tooltip for agent-card skills/description hovers. One body-level
  // node shared by every controller; body-appended because the card grid is a
  // scroll container that clips anything overflowing a card.
  let agentCardFloatingTooltip = null;

  function getAgentCardFloatingTooltip() {
    if (!agentCardFloatingTooltip) {
      agentCardFloatingTooltip = document.createElement("div");
      agentCardFloatingTooltip.className = "agent-card-tooltip";
      agentCardFloatingTooltip.hidden = true;
      document.body.appendChild(agentCardFloatingTooltip);
    }
    return agentCardFloatingTooltip;
  }

  function hideAgentCardTooltip() {
    if (agentCardFloatingTooltip) {
      agentCardFloatingTooltip.hidden = true;
    }
  }

  function createAgentsController(cfg) {
  const state = {
    mode: "user", // 'all' | 'user' | 'published' | 'marketplace' | 'discover'
    discoverType: cfg.lockedDiscoverType || TYPE_AGENTS,
    searchQuery: "",
    myAgents: [],
    discoverResults: [],
    initialized: false,
    // Logged-in marketplace identity (bare handle) for ownership filters.
    viewerIdentity: "",
    viewerIdentityPromise: null,
    // solution id -> bundle (or null in-flight/failed marker) resolved by the
    // Discover card enrichment; session-scoped so repeat searches reuse it.
    discoverBundleCache: new Map(),
    // Update-available scan results for installed copies: agent id -> the
    // listing's newer updated_at. One bounded check per session, piggybacked
    // on the first Agents-tab load (no timers/polling).
    solutionFreshness: new Map(),
    freshnessCheckedAt: 0,
    // Local-only agent warning flags (agent id -> [{type, skills, ...}]),
    // refreshed alongside the agents list. Display-only: NEVER an input to
    // stale/dirty/unpublished logic.
    agentLocalFlags: {},
    // Shared skills-freshness snapshot behind the per-agent "skills need
    // updates" state. Refreshed lazily (5-minute TTL) from render paths only —
    // never on a timer or interval (ATLAS.md performance rule). The
    // checkSkillUpdates pass runs HEADLESS so a passive render can never pop
    // a GitLab sign-in.
    skillFreshness: { snapshot: null, fetchedAt: 0, promise: null },
    // agent id -> { checkedAt, status: "pending"|"ready"|"error", updates: [],
    // conflicts: [] }, derived from the shared snapshot per agent (5-min TTL).
    agentSkillFreshness: new Map(),
    // Inline create/edit editor: { root, baseline, subjectName } while open.
    editor: null,
    loading: false,
    lastSearchAt: 0,
    discoverSearchSeq: 0,
    // local agent id -> { solutionId, publishedAt, lastUpdatedAt }
    marketplaceLinks: {},
    // Cached catalogs for the create/edit modal pickers.
    catalogs: {
      baseModels: null, // [{ id, display_name }]
      baseModelsError: "",
      skills: null, // [{ id, display_name, description, source }]
      toolServers: null, // [{ id, display_name, description, icon_url, is_core, user_installed }]
      loadedAt: 0,
      loading: false,
    },
  };

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Trim long card text so a single oversized description / name can't push
  // the action row off the visible card area. Full text stays accessible via
  // the element's title attribute.
  function truncateForCard(value, max = 100) {
    const text = String(value ?? "");
    if (text.length <= max) return text;
    return `${text.slice(0, max).trimEnd()}…`;
  }

  function canonicalSkillName(localSkillName) {
    const parts = String(localSkillName || "")
      .trim()
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean);
    return parts.at(-1) || "";
  }

  function normalizeAllowedEmailValue(value) {
    return String(value || "").trim().toLowerCase();
  }

  function allowedEmailValidationMessage(invalidEmails) {
    const invalid = Array.isArray(invalidEmails) ? invalidEmails : [];
    if (!invalid.length) return "";
    const sample = invalid.slice(0, 3).join(", ");
    const suffix = invalid.length > 3 ? ` and ${invalid.length - 3} more` : "";
    return `Allowed emails must be valid email addresses. Check: ${sample}${suffix}.`;
  }

  function isPlausibleAllowedEmail(value) {
    const email = String(value || "").trim();
    return /^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/.test(email);
  }

  function normalizeAllowedEmails(value) {
    const rawValues = Array.isArray(value)
      ? value
      : typeof value === "string"
        ? value.split(/[\n,]/)
        : [];
    const seen = new Set();
    const out = [];
    for (const entry of rawValues) {
      const normalized = normalizeAllowedEmailValue(entry);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    }
    return out;
  }

  function validateAllowedEmails(value) {
    const normalized = normalizeAllowedEmails(value);
    const invalid = normalized.filter((email) => !isPlausibleAllowedEmail(email));
    return {
      valid: invalid.length === 0,
      normalized,
      invalid,
      message: allowedEmailValidationMessage(invalid),
    };
  }

  function assertAllowedEmailsValid(value) {
    const validation = validateAllowedEmails(value);
    if (!validation.valid) {
      throw new Error(validation.message);
    }
    return validation.normalized;
  }

  function normalizeCreatorEmailCandidate(value) {
    const normalized = normalizeAllowedEmailValue(value);
    return normalized.includes("@") ? normalized : "";
  }

  async function resolveCreatorEmail() {
    try {
      const user = await window.electronAPI?.currentUser?.get?.();
      if (user?.authenticated !== true) return "";
      const email = normalizeCreatorEmailCandidate(
        user?.sessionSummary?.user?.email ||
          user?.email ||
          user?.claims?.email ||
          "",
      );
      if (email) return email;
    } catch (error) {
      console.warn("[Agents] failed to resolve current user email", error);
    }
    return "";
  }

  function normalizeMarketplaceOwnerIdentity(value) {
    const normalized = normalizeAllowedEmailValue(value);
    if (!normalized) return "";
    const at = normalized.indexOf("@");
    return at === -1 ? normalized : normalized.slice(0, at);
  }

  async function resolveCurrentMarketplaceOwnerIdentity() {
    try {
      const user = await window.electronAPI?.currentUser?.get?.();
      const identity = normalizeMarketplaceOwnerIdentity(
        user?.sessionSummary?.user?.email ||
          user?.email ||
          user?.claims?.email ||
          "",
      );
      if (identity) return identity;
    } catch (error) {
      console.warn("[Agents] failed to resolve current marketplace owner", error);
    }
    try {
      const usernameRes = await window.electronAPI?.getUsername?.();
      return normalizeMarketplaceOwnerIdentity(usernameRes?.username || "");
    } catch (_error) {
      return "";
    }
  }

  function marketplaceSolutionOwnerIdentity(solution) {
    return normalizeMarketplaceOwnerIdentity(
      solution?.submitted_by ||
        solution?.submittedBy ||
        solution?.owner ||
        "",
    );
  }

  async function inspectLinkedMarketplacePublishTarget(solutionId) {
    const id = String(solutionId || "").trim();
    if (!id) {
      return { solutionId: "", found: false, checked: false };
    }
    try {
      const [solutionRes, currentOwnerIdentity] = await Promise.all([
        window.electronAPI?.aiMarketplace?.getSolution?.(id),
        resolveCurrentMarketplaceOwnerIdentity(),
      ]);
      if (!solutionRes?.success) {
        return {
          solutionId: id,
          found: false,
          checked: true,
          status: "",
          ownerIdentity: "",
          currentOwnerIdentity,
          error: solutionRes?.error || "",
        };
      }
      const solution = solutionRes.data || {};
      const ownerIdentity = marketplaceSolutionOwnerIdentity(solution);
      return {
        solutionId: id,
        found: true,
        checked: true,
        status: String(solution.status || "").trim(),
        ownerIdentity,
        currentOwnerIdentity,
        isOwner:
          Boolean(ownerIdentity) &&
          Boolean(currentOwnerIdentity) &&
          ownerIdentity === currentOwnerIdentity,
        // The listing's live audience, for drift surfacing in the publish
        // modal. null = the envelope carried no allowed_emails field.
        listingAllowedEmails: Object.prototype.hasOwnProperty.call(
          solution,
          "allowed_emails",
        )
          ? normalizeAllowedEmails(solution.allowed_emails)
          : null,
      };
    } catch (error) {
      console.warn("[Agents] failed to inspect linked marketplace solution", error);
      return {
        solutionId: id,
        found: false,
        checked: false,
        status: "",
        ownerIdentity: "",
        currentOwnerIdentity: "",
        error: error?.message || String(error),
      };
    }
  }

  function linkedPublishActionLabel(isLinked) {
    return isLinked ? "Republish" : "Publish";
  }

  function formatLinkedPublishTargetHtml(publishTarget) {
    if (!publishTarget?.solutionId) return "";
    const statusText = publishTarget.status
      ? ` Status: ${escapeHtml(publishTarget.status)}.`
      : "";
    if (publishTarget.found && publishTarget.isOwner) {
      return `<p><strong>Marketplace action:</strong> You own the linked solution.${statusText} Publishing will replace that marketplace copy.</p>`;
    }
    if (publishTarget.found && publishTarget.ownerIdentity) {
      return `<p><strong>Marketplace action:</strong> Linked solution owner: <code>${escapeHtml(publishTarget.ownerIdentity)}</code>.${statusText} Only that owner can republish this solution. Create an editable copy to publish a separate solution.</p>`;
    }
    if (publishTarget.checked) {
      return `<p><strong>Marketplace action:</strong> The linked solution could not be confirmed.${statusText} Republish will fail closed unless Marketplace ownership can be verified.</p>`;
    }
    return `<p><strong>Marketplace action:</strong> Ownership could not be checked.${statusText} Republish will fail closed unless Marketplace ownership can be verified.</p>`;
  }

  async function withCreatorAllowedEmail(args, { heal = false } = {}) {
    const allowedEmails = normalizeAllowedEmails(args?.allowed_emails);
    if (!allowedEmails.length) return { ...args, allowed_emails: allowedEmails };
    let creatorEmail = await resolveCreatorEmail();
    if (!creatorEmail && heal) {
      // Heal-then-retry (PORTICO-414): silently backfill the session email, and
      // for interactive callers escalate to a real re-auth (browser) before
      // giving up. Headless/batch callers pass no heal and keep the
      // fail-fast coded throw — they must never open a browser.
      try {
        await window.electronAPI?.currentUser?.repairIdentity?.();
      } catch {
        /* an unavailable repair falls through to the coded failure */
      }
      creatorEmail = await resolveCreatorEmail();
      logMarketplacePublish("open:creator-email-heal", {
        stage: "repair",
        recovered: Boolean(creatorEmail),
      });
      if (!creatorEmail && heal === "interactive") {
        try {
          await window.electronAPI?.currentUser?.ensureAuthenticated?.();
        } catch {
          /* a cancelled/failed sign-in falls through to the coded failure */
        }
        creatorEmail = await resolveCreatorEmail();
        logMarketplacePublish("open:creator-email-heal", {
          stage: "interactive",
          recovered: Boolean(creatorEmail),
        });
      }
    }
    if (!creatorEmail) {
      const error = new Error(
        "Your authenticated email is unavailable, so restricted agent access cannot be saved.",
      );
      error.code = "creator_email_unavailable";
      throw error;
    }
    if (allowedEmails.includes(creatorEmail)) {
      return { ...args, allowed_emails: allowedEmails };
    }
    return { ...args, allowed_emails: [...allowedEmails, creatorEmail] };
  }

  function formatAllowedEmailsForField(value) {
    return normalizeAllowedEmails(value).join("\n");
  }

  function formatAllowedEmailsVisibilitySummary(value) {
    const normalized = normalizeAllowedEmails(value);
    if (!normalized.length) return "Public";
    return `Restricted to ${normalized.join(", ")}`;
  }

  function readStoredAllowedEmailDrafts() {
    try {
      const storage = window.localStorage;
      if (!storage) return {};
      const raw = storage.getItem(AGENT_ALLOWED_EMAILS_DRAFTS_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (_error) {
      return {};
    }
  }

  function writeStoredAllowedEmailDrafts(drafts) {
    try {
      const storage = window.localStorage;
      if (!storage) return;
      storage.setItem(AGENT_ALLOWED_EMAILS_DRAFTS_KEY, JSON.stringify(drafts));
    } catch (_error) {}
  }

  function getStoredAllowedEmails(agentId) {
    const normalizedId = String(agentId || "").trim();
    if (!normalizedId) return null;
    const drafts = readStoredAllowedEmailDrafts();
    if (!Object.prototype.hasOwnProperty.call(drafts, normalizedId)) {
      return null;
    }
    return normalizeAllowedEmails(drafts[normalizedId]);
  }

  function setStoredAllowedEmails(agentId, allowedEmails) {
    const normalizedId = String(agentId || "").trim();
    if (!normalizedId) return [];
    const normalized = normalizeAllowedEmails(allowedEmails);
    const drafts = readStoredAllowedEmailDrafts();
    drafts[normalizedId] = normalized;
    writeStoredAllowedEmailDrafts(drafts);
    return normalized;
  }

  function clearStoredAllowedEmails(agentId) {
    const normalizedId = String(agentId || "").trim();
    if (!normalizedId) return;
    const drafts = readStoredAllowedEmailDrafts();
    if (!Object.prototype.hasOwnProperty.call(drafts, normalizedId)) return;
    delete drafts[normalizedId];
    writeStoredAllowedEmailDrafts(drafts);
  }

  async function hydrateLinkedAgentAllowedEmails(agent) {
    if (!agent?.marketplace_solution_id) return agent;
    const draftAllowedEmails = getStoredAllowedEmails(agent.id);
    if (draftAllowedEmails !== null) {
      return { ...agent, allowed_emails: draftAllowedEmails };
    }
    try {
      const result = await window.electronAPI?.aiMarketplace?.getSolution?.(
        agent.marketplace_solution_id,
      );
      if (!result?.success) return agent;
      const solution = result.data;
      if (
        !solution ||
        typeof solution !== "object" ||
        !Object.prototype.hasOwnProperty.call(solution, "allowed_emails")
      ) {
        return agent;
      }
      const allowedEmails = normalizeAllowedEmails(solution.allowed_emails);
      setStoredAllowedEmails(agent.id, allowedEmails);
      return {
        ...agent,
        allowed_emails: allowedEmails,
      };
    } catch (error) {
      console.warn("[Agents] failed to hydrate allowed emails from marketplace", error);
      return agent;
    }
  }

  function canonicalSkillIds(skillIds) {
    const out = [];
    const seen = new Set();
    for (const skillId of Array.isArray(skillIds) ? skillIds : []) {
      const canonicalName = canonicalSkillName(skillId);
      if (!canonicalName || seen.has(canonicalName)) continue;
      seen.add(canonicalName);
      out.push(canonicalName);
    }
    return out;
  }

  function marketplaceInstalledSkillId(skillId) {
    const canonicalName = canonicalSkillName(skillId);
    return canonicalName ? `ai-marketplace/${canonicalName}` : "";
  }

  function solutionHasInstallableBundle(solution) {
    if (!solution || typeof solution !== "object") return false;
    if (solution.install_error_code === "no_bundle") return false;
    // Lenient gating to match the Agent Skills marketplace browse experience:
    // search list results rarely carry has_bundle, so treat unknown as
    // installable and rely on the server's no_bundle response to disable any
    // entry that genuinely has no bundle attached.
    return solution.has_bundle !== false;
  }

  function parseJsonObject(value) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : null;
    } catch {
      return null;
    }
  }

  function normalizeSolutionBundle(value) {
    const bundle =
      value && typeof value === "object" && !Array.isArray(value)
        ? value
        : parseJsonObject(value);
    if (!bundle) return null;
    const nestedBundle = normalizeSolutionBundle(bundle.bundle);
    if (!bundle.payload && nestedBundle) return nestedBundle;
    const payload =
      bundle.payload && typeof bundle.payload === "object" && !Array.isArray(bundle.payload)
        ? bundle.payload
        : parseJsonObject(bundle.payload);
    return payload ? { ...bundle, payload } : bundle;
  }

  function getSolutionResolvedBundleCache(solution) {
    const cache = solution?.resolved_bundle_cache;
    return cache && typeof cache === "object" && !Array.isArray(cache)
      ? cache
      : parseJsonObject(cache);
  }

  function getSolutionBundle(solution) {
    if (!solution || typeof solution !== "object") return null;
    const resolvedCache = getSolutionResolvedBundleCache(solution);
    const resolvedBundle = normalizeSolutionBundle(resolvedCache?.bundle || resolvedCache);
    if (resolvedBundle && resolvedBundle.payload) {
      return resolvedBundle;
    }
    return normalizeSolutionBundle(solution.bundle);
  }

  function marketplaceAgentPayloadFromBundle(bundle) {
    const payload = bundle?.payload && typeof bundle.payload === "object" ? bundle.payload : {};
    const nestedAgent =
      payload.agent && typeof payload.agent === "object" && !Array.isArray(payload.agent)
        ? payload.agent
        : null;
    return nestedAgent ? { ...payload, ...nestedAgent } : payload;
  }

  function asDisplayIds(value, normalizer = (id) => String(id || "").trim()) {
    if (!Array.isArray(value)) return [];
    const out = [];
    const seen = new Set();
    for (const entry of value) {
      const id = normalizer(entry);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  // Precise installability check for the details modal, where we have already
  // fetched the full solution envelope. Unlike the lenient list-level
  // `solutionHasInstallableBundle()`, this requires an actually-retrievable
  // bundle payload (the sandbox API leaves `has_bundle` null even when a bundle
  // exists inline, and stores an empty `{}` bundle for listings published
  // without one). This prevents enabling Install for empty-bundle listings that
  // would only fail server-side with `no_bundle`.
  function solutionBundleIsRetrievable(solution) {
    if (!solution || typeof solution !== "object") return false;
    if (solution.install_error_code === "no_bundle") return false;
    if (solution.has_bundle === true) return true;
    const bundle = getSolutionBundle(solution);
    return Boolean(bundle && bundle.payload && typeof bundle.payload === "object");
  }

  function markDiscoverSolutionAsNonInstallable(solutionId) {
    if (!solutionId || !Array.isArray(state.discoverResults) || !state.discoverResults.length) {
      return false;
    }
    let changed = false;
    state.discoverResults = state.discoverResults.map((solution) => {
      if (!solution || solution.id !== solutionId) return solution;
      changed = true;
      return {
        ...solution,
        has_bundle: false,
        bundle: null,
        resolved_bundle_cache: null,
        install_error_code: "no_bundle",
      };
    });
    return changed;
  }

  function findLinkedAgentIdForSolution(solutionId, links = {}) {
    if (!solutionId || !links || typeof links !== "object") return "";
    for (const [localAgentId, link] of Object.entries(links)) {
      if (link?.solutionId === solutionId) {
        return localAgentId;
      }
    }
    return "";
  }

  function agentIdsFromListResponse(data) {
    const agentsRaw = Array.isArray(data?.agents) ? data.agents : Array.isArray(data) ? data : [];
    return new Set(
      agentsRaw
        .map((agent) => String(agent?.id || "").trim())
        .filter(Boolean),
    );
  }

  async function pruneMarketplaceLinksToExistingAgents(existingAgentIds) {
    if (!(existingAgentIds instanceof Set) || !state.marketplaceLinks) {
      return { pruned: 0, prunedAgentIds: [] };
    }
    // FAIL-SAFE: an EMPTY agents list next to a non-empty registry is far
    // more likely a transient read (OWUI mid-boot, webview reload) than the
    // user truly deleting every agent — and pruning against it mass-clears
    // every published/installed link (2026-08-04 incident: the whole
    // registry was wiped to {} and every Published badge vanished). Stale
    // links are harmless until the next load that sees ≥1 agent.
    if (existingAgentIds.size === 0) {
      if (Object.keys(state.marketplaceLinks).length) {
        console.warn(
          "[Agents] skipping link prune: agents list came back empty while links exist",
        );
      }
      return { pruned: 0, prunedAgentIds: [] };
    }
    const linkedAgentIds = Object.keys(state.marketplaceLinks);
    let absentIds = linkedAgentIds.filter((id) => !existingAgentIds.has(id));
    // Steady state (nothing missing, nothing previously flagged): no IPC.
    const hasFlaggedLinks = linkedAgentIds.some(
      (id) => state.marketplaceLinks[id]?.missingSince,
    );
    if (!absentIds.length && !hasFlaggedLinks) {
      return { pruned: 0, prunedAgentIds: [] };
    }
    if (absentIds.length) {
      // A linked agent can vanish from ONE inventory read because an OWUI
      // access grant flapped (2026-08-08: two read-only zstevens-owned
      // installs disappeared for a single read and their links were
      // hard-deleted). Heal access first, then re-list once — a reappearance
      // here means the store heals instead of flagging.
      await repairLinkedAgentAccess("link-prune-miss");
      try {
        const recheck = agentIdsFromListResponse(await callSubagent(TOOL_LIST, {}));
        if (recheck.size > 0) {
          absentIds = linkedAgentIds.filter((id) => !recheck.has(id));
          for (const id of recheck) existingAgentIds.add(id);
        }
      } catch (error) {
        console.warn("[Agents] link-prune recheck failed; using first read", error);
      }
    }
    const reportSightings = window.electronAPI?.aiMarketplace?.reportLinkSightings;
    if (typeof reportSightings !== "function") {
      // Stale preload without the sightings channel: do nothing. A stale
      // link is harmless; the old hard-delete-on-first-miss is the bug.
      console.warn("[Agents] link sightings channel unavailable; prune skipped");
      return { pruned: 0, prunedAgentIds: [] };
    }
    // The store owns the policy (flag -> spaced confirm -> delete, heal on
    // reappearance); only store-CONFIRMED deletions leave local state.
    const res = await reportSightings({
      presentIds: linkedAgentIds.filter((id) => existingAgentIds.has(id)),
      absentIds,
    });
    if (!res?.success) {
      console.warn("[Agents] link sightings report failed", res?.error);
      return { pruned: 0, prunedAgentIds: [] };
    }
    const deletedIds = Array.isArray(res.deleted) ? res.deleted : [];
    const flaggedIds = Array.isArray(res.flagged) ? res.flagged : [];
    const healedIds = Array.isArray(res.healed) ? res.healed : [];
    if (deletedIds.length || flaggedIds.length || healedIds.length) {
      const linksRes = await window.electronAPI?.aiMarketplace?.listLinks?.();
      if (linksRes?.success) {
        state.marketplaceLinks = linksRes.links || {};
      }
      console.log("[Agents] marketplace link sightings applied", {
        flaggedAgentIds: flaggedIds,
        healedAgentIds: healedIds,
        prunedAgentIds: deletedIds,
      });
    }
    return { pruned: deletedIds.length, prunedAgentIds: deletedIds };
  }

  function isMarketplaceOwnershipError(resultOrError) {
    const code = String(resultOrError?.code || "").toLowerCase();
    const status = Number(resultOrError?.status || 0);
    return status === 403 || code === "not_owner" || code === "forbidden";
  }

  function extractMarketplaceSkillIdsFromBundle(bundle) {
    let payload = bundle?.payload || {};
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        payload = {};
      }
    }
    const installedSkillIds = [];
    const seen = new Set();
    for (const skillId of Array.isArray(payload?.skill_ids) ? payload.skill_ids : []) {
      const installedId = marketplaceInstalledSkillId(skillId);
      if (!installedId || seen.has(installedId)) continue;
      seen.add(installedId);
      installedSkillIds.push(installedId);
    }
    return installedSkillIds;
  }

  async function refreshInstalledSkillViews({ focusInstalledTab = false } = {}) {
    invalidateCatalogs();
    await loadCatalogs({ force: true });
    if (
      window.appState?.controlPlaneView === "agent-skills" &&
      typeof window.showAgentSkillsView === "function"
    ) {
      window.showAgentSkillsView({ refresh: true });
      if (
        focusInstalledTab &&
        typeof window.switchAgentSkillsToInstalledTab === "function"
      ) {
        window.switchAgentSkillsToInstalledTab();
      }
      return;
    }

    if (typeof window.loadSkills === "function") {
      await window.loadSkills();
    }
  }

  async function maybeOfferMarketplaceSkillCleanup(skillIds) {
    const orphanCandidates = Array.from(
      new Set((Array.isArray(skillIds) ? skillIds : []).filter(Boolean)),
    );
    if (!orphanCandidates.length) return;

    const remainingSkillIds = new Set();
    for (const agent of Array.isArray(state.myAgents) ? state.myAgents : []) {
      for (const skillId of Array.isArray(agent?.skill_ids) ? agent.skill_ids : []) {
        remainingSkillIds.add(skillId);
      }
    }

    const orphanedSkillIds = orphanCandidates.filter(
      (skillId) => !remainingSkillIds.has(skillId),
    );
    if (!orphanedSkillIds.length) return;

    const skillsRes = await window.electronAPI?.getSkills?.();
    const installedSkills = Array.isArray(skillsRes?.skills) ? skillsRes.skills : [];
    const marketplaceSkills = orphanedSkillIds
      .map((skillId) =>
        installedSkills.find(
          (skill) =>
            skill?.name === skillId &&
            skill?.source === "marketplace" &&
            skill?.marketplace_id === "ai-marketplace",
        ),
      )
      .filter(Boolean);
    if (!marketplaceSkills.length) return;

    const skillLabels = marketplaceSkills.map((skill) => skill.name).join(", ");
    if (
      !window.confirm(
        `This agent was the last local reference to ${marketplaceSkills.length} marketplace skill(s): ${skillLabels}.\n\nRemove them from Agent Skills → Installed as well?`,
      )
    ) {
      return;
    }

    const removed = [];
    const failed = [];
    for (const skill of marketplaceSkills) {
      try {
        const result = await window.electronAPI?.deleteSkill?.(
          skill.name,
          skill.skill_path,
        );
        if (!result?.success) {
          throw new Error(result?.error || "Failed to delete skill");
        }
        removed.push(skill.name);
        await window.electronAPI?.aiMarketplace?.clearSkillLink?.(skill.name);
      } catch (error) {
        failed.push({
          name: skill.name,
          error: error?.message || String(error),
        });
      }
    }

    if (removed.length) {
      await refreshInstalledSkillViews({ focusInstalledTab: false });
    }

    if (failed.length) {
      notify(
        `Removed ${removed.length} unused marketplace skill(s). ${failed.length} could not be removed.`,
        "warning",
      );
      return;
    }

    if (removed.length) {
      notify(`Removed ${removed.length} unused marketplace skill(s).`, "success");
    }
  }

  function notify(message, kind = "info") {
    if (typeof window.showNotification === "function") {
      window.showNotification(message, kind);
    } else {
      console.log(`[Agents][${kind}] ${message}`);
    }
  }

  const COPY_ICON_SVG =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
  const COPIED_ICON_SVG =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>';

  async function copyTextToClipboard(value, label = "Value") {
    const text = String(value ?? "");
    if (!text) return false;
    try {
      if (window.electronAPI?.copyToClipboard) {
        await window.electronAPI.copyToClipboard(text);
      } else {
        await navigator.clipboard.writeText(text);
      }
      notify(`${label} copied to clipboard`, "success");
      return true;
    } catch (error) {
      notify(`Copy failed: ${error?.message || String(error)}`, "error");
      return false;
    }
  }

  // Small copy button used next to ids and names. Handled by ONE delegated
  // document-level listener (covers pages and body-mounted modals alike).
  function copyButtonHtml(value, label) {
    if (!value) return "";
    return `<button type="button" class="agents-copy-btn" data-copy-value="${escapeHtml(value)}" data-copy-label="${escapeHtml(label)}" title="Copy ${escapeHtml(label.toLowerCase())}" aria-label="Copy ${escapeHtml(label.toLowerCase())}">${COPY_ICON_SVG}</button>`;
  }

  // Grey monospace badge + copy button for marketplace ids. Deliberately NOT
  // .mcp-card-badge: uuids must render verbatim (no uppercase transform).
  function copyableIdBadgeHtml(value, label = "Solution id") {
    const id = String(value || "").trim();
    if (!id) return "—";
    return `<span class="agents-id-copy"><code class="agents-id-badge" title="${escapeHtml(id)}">${escapeHtml(id)}</code>${copyButtonHtml(id, label)}</span>`;
  }

  function handleCopyButtonClick(event) {
    const btn = event.target?.closest?.(".agents-copy-btn");
    if (!btn) return false;
    event.preventDefault();
    event.stopPropagation();
    const value = btn.getAttribute("data-copy-value") || "";
    const label = btn.getAttribute("data-copy-label") || "Value";
    void copyTextToClipboard(value, label).then((copied) => {
      if (!copied) return;
      btn.classList.add("copied");
      const original = btn.innerHTML;
      btn.innerHTML = COPIED_ICON_SVG;
      setTimeout(() => {
        btn.classList.remove("copied");
        btn.innerHTML = original;
      }, 2000);
    });
    return true;
  }

  function marketplaceResponseId(response) {
    return String(response?.id || response?.solution_id || response?.uuid || "").trim();
  }

  function marketplacePublishStatus(result, fallbackId = "") {
    const data = result?.data && typeof result.data === "object" ? result.data : {};
    const status =
      result?.publishStatus && typeof result.publishStatus === "object"
        ? result.publishStatus
        : {};
    return {
      id: String(status.id || marketplaceResponseId(data) || fallbackId || "").trim(),
      status: String(status.status || data.status || "").trim(),
      hasBundle:
        status.has_bundle !== undefined && status.has_bundle !== null
          ? status.has_bundle
          : data.has_bundle,
    };
  }

  function formatMarketplacePublishStatusLabel(publishStatus) {
    const status = String(publishStatus?.status || "").trim();
    return status ? `Marketplace status: ${status}` : "";
  }

  function formatCountedNoun(count, singular, plural = `${singular}s`) {
    return `${count} ${count === 1 ? singular : plural}`;
  }

  function createDependentSkillPublishSummary() {
    return {
      published: 0,
      updated: 0,
      adopted: 0,
      referenced: 0,
      unchanged: 0,
      gitReferenced: 0,
      repaired: 0,
      visibilityUpdated: 0,
    };
  }

  function formatDependentSkillPublishSummary(summary) {
    if (!summary || typeof summary !== "object") return "";
    const parts = [];
    if (summary.updated) {
      parts.push(`${formatCountedNoun(summary.updated, "skill")} updated`);
    }
    if (summary.published) {
      parts.push(`${formatCountedNoun(summary.published, "skill")} published`);
    }
    if (summary.adopted) {
      parts.push(
        `${formatCountedNoun(summary.adopted, "skill")} relinked to your existing listing and updated`,
      );
    }
    if (summary.referenced) {
      parts.push(
        `${formatCountedNoun(summary.referenced, "skill")} referenced unchanged`,
      );
    }
    if (summary.unchanged) {
      parts.push(
        `${formatCountedNoun(summary.unchanged, "skill")} unchanged (listing referenced, nothing re-uploaded)`,
      );
    }
    if (summary.gitReferenced) {
      parts.push(
        `${formatCountedNoun(summary.gitReferenced, "skill")} referenced from their git marketplace`,
      );
    }
    if (summary.repaired) {
      parts.push(`${formatCountedNoun(summary.repaired, "stale skill link")} repaired`);
    }
    if (summary.visibilityUpdated) {
      parts.push(
        `${formatCountedNoun(summary.visibilityUpdated, "listing")} re-shared with this agent's audience`,
      );
    }
    return parts.length ? `Skills: ${parts.join(", ")}.` : "";
  }

  function formatMarketplacePublishDetails(result) {
    if (!result) return "";
    const parts = [];
    const statusLabel = formatMarketplacePublishStatusLabel(result.publishStatus);
    if (statusLabel) parts.push(`${statusLabel}.`);
    const skillLabel = formatDependentSkillPublishSummary(result.skillPublishSummary);
    if (skillLabel) parts.push(skillLabel);
    return parts.length ? ` ${parts.join(" ")}` : "";
  }

  function marketplaceResultError(result, fallbackMessage) {
    return [
      result?.error || fallbackMessage,
      result?.code ? `code=${result.code}` : null,
      result?.status ? `status=${result.status}` : null,
      result?.publishStatus?.status
        ? `marketplace_status=${result.publishStatus.status}`
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }

  // Structured, content-free marketplace diagnostics. The "[Agents][...]"
  // prefix routes metas through the main-side content belt into the app log;
  // each flow gets its own tag so the log stays greppable per flow.
  function makeMarketplaceLogger(tag) {
    return function logMarketplaceEvent(eventName, meta = {}) {
      const payload = {
        event: eventName,
        ...meta,
        at: new Date().toISOString(),
      };
      console.log(`[Agents][${tag}]`, payload);
      try {
        window.electronAPI?.logToMain?.({
          level: "info",
          message: `[Agents][${tag}] ${eventName}`,
          meta: payload,
        });
      } catch {}
    };
  }

  const logMarketplacePublish = makeMarketplaceLogger("MarketplacePublish");
  const logMarketplaceInstall = makeMarketplaceLogger("MarketplaceInstall");

  function setBusyButtonState(button, busyLabel = "") {
    if (!button) return () => {};
    const originalHtml = button.innerHTML;
    const originalDisabled = button.disabled;
    button.disabled = true;
    button.dataset.busy = "true";
    button.setAttribute("aria-busy", "true");
    button.innerHTML = busyLabel
      ? `<div class="btn-spinner"></div> ${escapeHtml(busyLabel)}`
      : `<div class="btn-spinner"></div>`;
    return () => {
      button.innerHTML = originalHtml;
      button.disabled = originalDisabled;
      button.removeAttribute("aria-busy");
      delete button.dataset.busy;
    };
  }

  function focusWithoutScrolling(element) {
    if (!element || typeof element.focus !== "function") return;
    try {
      element.focus({ preventScroll: true });
    } catch (_error) {
      element.focus();
    }
  }

  function setModalBusyState(overlay, busy, submitLabel = "Saving...") {
    if (!overlay) return;
    overlay.dataset.busy = busy ? "true" : "false";
    const submitBtn = overlay.querySelector(".agents-modal-submit");
    const cancelBtn = overlay.querySelector(".agents-modal-cancel");
    const closeBtn = overlay.querySelector(".agents-modal-close");
    const backBtn = overlay.querySelector(".agent-editor-back-btn");
    if (submitBtn) {
      if (!submitBtn.dataset.originalHtml) {
        submitBtn.dataset.originalHtml = submitBtn.innerHTML;
      }
      submitBtn.disabled = busy;
      if (busy) {
        submitBtn.setAttribute("aria-busy", "true");
        submitBtn.innerHTML = `<div class="btn-spinner"></div> ${escapeHtml(submitLabel)}`;
      } else {
        submitBtn.removeAttribute("aria-busy");
        submitBtn.innerHTML = submitBtn.dataset.originalHtml;
      }
    }
    [cancelBtn, closeBtn, backBtn].forEach((button) => {
      if (!button) return;
      button.disabled = busy;
      if (busy) {
        button.setAttribute("aria-disabled", "true");
      } else {
        button.removeAttribute("aria-disabled");
      }
    });
  }

  function getView() {
    return document.getElementById(cfg.viewId);
  }

  function getList() {
    return document.getElementById(cfg.listId);
  }

  function getHeaderActions() {
    return document.getElementById(cfg.headerActionsId);
  }

  // All control-plane views except this controller's own (hidden when this tab
  // is shown). Includes the sibling agents view so the two agents tabs are
  // mutually exclusive.
  function getOtherViews() {
    return [
      { view: document.getElementById("mcp-servers-view"), actions: document.getElementById("mcp-header-actions") },
      { view: document.getElementById("agent-skills-view"), actions: document.getElementById("skills-header-actions") },
      { view: document.getElementById("updates-view"), actions: document.getElementById("updates-header-actions") },
      { view: document.getElementById("cost-dashboard-view"), actions: document.getElementById("cost-dashboard-header-actions") },
      { view: document.getElementById(cfg.siblingViewId), actions: document.getElementById(cfg.siblingActionsId) },
    ];
  }

  function getPanelButtons() {
    return {
      mcp: document.getElementById("view-mcp-servers-btn"),
      skills: document.getElementById("view-agent-skills-btn"),
      updates: document.getElementById("view-updates-btn"),
      cost: document.getElementById("view-cost-dashboard-btn"),
      self: document.getElementById(cfg.buttonId),
      sibling: document.getElementById(cfg.siblingButtonId),
    };
  }

  // Button ids for every OTHER control-plane tab. Clicking any of them must
  // hide this controller's view and de-highlight its button.
  function getOtherButtonIds() {
    return [
      "view-mcp-servers-btn",
      "view-agent-skills-btn",
      "view-updates-btn",
      "view-cost-dashboard-btn",
      cfg.siblingButtonId,
    ];
  }

  function setAgentsVisible(visible) {
    const view = getView();
    const actions = getHeaderActions();
    if (view) view.style.display = visible ? "" : "none";
    // While the inline editor is open its own chrome replaces the header
    // actions; keep them hidden until the editor closes.
    if (actions) actions.style.display = visible && !state.editor ? "" : "none";
  }

  function showAgentsView() {
    const buttons = getPanelButtons();
    buttons.self?.classList.add("active");
    buttons.mcp?.classList.remove("active");
    buttons.skills?.classList.remove("active");
    buttons.cost?.classList.remove("active");
    buttons.sibling?.classList.remove("active");

    for (const { view, actions } of getOtherViews()) {
      if (view) view.style.display = "none";
      if (actions) actions.style.display = "none";
    }
    setAgentsVisible(true);

    if (window.appState) {
      window.appState.controlPlaneView = cfg.controlPlaneView;
    }

    // The list is hidden behind the inline editor; skip the fetch until the
    // editor closes.
    if (state.editor) return;
    void refreshCurrentMode();
  }

  function refreshCurrentMode() {
    return state.mode === "discover" ? runDiscoverSearch() : loadMyAgents();
  }

  // Resolved once per session (retried if the IPC returned empty, so a
  // transient failure on the first load can't stick).
  function ensureViewerIdentity() {
    if (!state.viewerIdentityPromise) {
      state.viewerIdentityPromise = resolveCurrentMarketplaceOwnerIdentity().then((identity) => {
        state.viewerIdentity = identity || "";
        if (!identity) state.viewerIdentityPromise = null;
        return state.viewerIdentity;
      });
    }
    return state.viewerIdentityPromise;
  }

  async function callCoreMcp(serverId, toolName, input = {}) {
    const api = window.electronAPI;
    if (!api?.invokeMcpTool) {
      throw new Error("invoke-mcp-tool is not available in this renderer.");
    }
    const result = await api.invokeMcpTool(serverId, toolName, input, MCPO_PORT);
    if (!result?.success) {
      const detail =
        (result?.data && (result.data.error || result.data.detail)) ||
        result?.error ||
        result?.statusText ||
        `Core MCP call failed (${serverId}/${toolName})`;
      throw new Error(detail);
    }
    if (result?.data?.is_error) {
      const detail =
        result.data.message ||
        result.data.content ||
        result.data.error ||
        `Core MCP call failed (${serverId}/${toolName})`;
      throw new Error(detail);
    }
    return result.data;
  }

  function callSubagent(toolName, input = {}) {
    return callCoreMcp(SUBAGENTS_SERVER_ID, toolName, input);
  }

  // subagents_get_agent intentionally omits the system prompt (it can be
  // large). Fetch both in parallel and merge so callers that need the prompt
  // (Edit modal, Publish bundle) get a complete record.
  async function fetchAgentWithSystemPrompt(agentId) {
    const [agentRes, promptRes] = await Promise.allSettled([
      callSubagent(TOOL_GET, { model_id: agentId }),
      callSubagent(TOOL_GET_SYSTEM_PROMPT, { model_id: agentId }),
    ]);
    if (agentRes.status !== "fulfilled") {
      throw agentRes.reason instanceof Error
        ? agentRes.reason
        : new Error(String(agentRes.reason));
    }
    const merged = { ...(agentRes.value || {}) };
    if (promptRes.status === "fulfilled") {
      const value = promptRes.value;
      const prompt =
        (value && typeof value.system_prompt === "string" && value.system_prompt) ||
        (typeof value === "string" ? value : "") ||
        "";
      if (prompt) merged.system_prompt = prompt;
    } else {
      console.warn(
        "[Agents] failed to fetch system prompt for",
        agentId,
        promptRes.reason,
      );
    }
    return merged;
  }

  // --- Catalog helpers (shared by create/edit modal pickers) ---------------

  function displayNameFromId(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    return (
      raw
        .replace(/^server:/, "")
        .split(/[-_/]+/)
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ") || raw
    );
  }

  function normalizeToolServerId(value) {
    const trimmed = String(value || "").trim();
    if (!trimmed) return "";
    return trimmed.startsWith("server:") ? trimmed : `server:${trimmed}`;
  }

  function buildAgentNameValidationContext(currentAgentId = null) {
    const existingNames = Array.isArray(state.myAgents)
      ? state.myAgents
          .filter((agent) => agent?.id !== currentAgentId)
          .map((agent) => String(agent?.name || "").trim())
          .filter(Boolean)
      : [];
    return { existingNames };
  }

  function setAgentNameError(overlay, message = "") {
    const input = overlay?.querySelector('input[name="name"]');
    const errorEl = overlay?.querySelector("[data-agent-name-error]");
    const hasError = Boolean(message);
    if (input) {
      input.setAttribute("aria-invalid", hasError ? "true" : "false");
      if (hasError) {
        input.setAttribute("aria-describedby", "agents-name-error");
      } else {
        input.removeAttribute("aria-describedby");
      }
    }
    if (!errorEl) return;
    errorEl.hidden = !hasError;
    errorEl.textContent = message || "";
  }

  function validateAgentNameField(
    overlay,
    { currentAgentId = null, currentName = "" } = {},
  ) {
    const input = overlay?.querySelector('input[name="name"]');
    if (!input) {
      return { valid: true, value: "", error: "" };
    }
    const validation = validateAgentName(input.value, {
      ...buildAgentNameValidationContext(currentAgentId),
      currentName,
    });
    input.setCustomValidity(validation.error || "");
    setAgentNameError(overlay, validation.error);
    return validation;
  }

  function wireAgentNameValidation(
    overlay,
    { currentAgentId = null, currentName = "" } = {},
  ) {
    const input = overlay?.querySelector('input[name="name"]');
    if (!input) return;
    const validate = () =>
      validateAgentNameField(overlay, {
        currentAgentId,
        currentName,
      });
    input.addEventListener("input", validate);
    input.addEventListener("blur", validate);
    validate();
  }

  // Inline error UI for the simple required fields (Base model, System prompt),
  // mirroring the Name field's pattern so users can see exactly why the
  // "Create agent" / "Save" button did nothing instead of only getting a toast.
  function setAgentFieldError(overlay, fieldName, message = "") {
    const field = overlay?.querySelector(`.agents-form [name="${fieldName}"]`);
    const errorEl = overlay?.querySelector(`[data-agent-error="${fieldName}"]`);
    const hasError = Boolean(message);
    const modelPicker =
      fieldName === "base_model_id"
        ? overlay?.querySelector("[data-agent-model-picker]")?.agentModelPicker
        : null;
    if (modelPicker) {
      modelPicker.setInvalid(message);
      if (errorEl && modelPicker.errorId) errorEl.id = modelPicker.errorId;
    } else if (field) {
      field.setAttribute("aria-invalid", hasError ? "true" : "false");
    }
    if (!errorEl) return;
    errorEl.hidden = !hasError;
    errorEl.textContent = message || "";
  }

  function selectedDisabledBaseModel(overlay) {
    const field = overlay?.querySelector('.agents-form [name="base_model_id"]');
    if (!field) return null;
    const modelPicker = overlay
      ?.querySelector("[data-agent-model-picker]")
      ?.agentModelPicker;
    if (modelPicker?.isUnavailableSelection?.()) {
      return {
        id: field.value,
        reason:
          modelPicker.getUnavailableReason?.() || "Temporarily unavailable",
      };
    }
    const selected = field.selectedOptions?.[0];
    if (!selected?.disabled || !field.value) return null;
    return {
      id: field.value,
      reason: selected.dataset.disabledReason || selected.title || "Temporarily unavailable",
    };
  }

  function validateAllowedEmailsField(overlay) {
    const field = overlay?.querySelector('.agents-form [name="allowed_emails"]');
    if (!field) {
      return { valid: true, firstInvalid: null, normalized: [] };
    }
    const validation = validateAllowedEmails(field.value || "");
    field.setCustomValidity(validation.message || "");
    setAgentFieldError(overlay, "allowed_emails", validation.message);
    return {
      ...validation,
      firstInvalid: validation.valid ? null : field,
    };
  }

  const AGENT_REQUIRED_FIELDS = [
    { name: "base_model_id", message: "Base model is required" },
    { name: "system_prompt", message: "System prompt is required" },
  ];

  // Validate every required field at once, surface inline errors, and report the
  // first invalid field so the caller can focus it.
  function validateAgentRequiredFields(
    overlay,
    { currentAgentId = null, currentName = "" } = {},
  ) {
    const form = overlay?.querySelector(".agents-form");
    const nameValidation = validateAgentNameField(overlay, {
      currentAgentId,
      currentName,
    });
    let firstInvalid = nameValidation.valid
      ? null
      : form?.querySelector('[name="name"]') || null;
    let valid = nameValidation.valid;
    for (const { name, message } of AGENT_REQUIRED_FIELDS) {
      const field = form?.querySelector(`[name="${name}"]`);
      const filled = Boolean(String(field?.value || "").trim());
      setAgentFieldError(overlay, name, filled ? "" : message);
      if (!filled) {
        valid = false;
        if (!firstInvalid) {
          firstInvalid =
            name === "base_model_id"
              ? form?.querySelector(".agent-model-picker-trigger") || field || null
              : field || null;
        }
      }
    }
    const disabledBaseModel = selectedDisabledBaseModel(overlay);
    if (disabledBaseModel) {
      const field = form?.querySelector('[name="base_model_id"]');
      setAgentFieldError(
        overlay,
        "base_model_id",
        `Base model "${disabledBaseModel.id}" is disabled: ${disabledBaseModel.reason}`,
      );
      valid = false;
      if (!firstInvalid) {
        firstInvalid =
          form?.querySelector(".agent-model-picker-trigger") || field || null;
      }
    }
    const allowedEmailsValidation = validateAllowedEmailsField(overlay);
    if (!allowedEmailsValidation.valid) {
      valid = false;
      if (!firstInvalid) firstInvalid = allowedEmailsValidation.firstInvalid;
    }
    return { valid, firstInvalid, name: nameValidation.value };
  }

  // Once a submit attempt has flagged missing fields, clear each field's error
  // live as the user fills it in (gated so we don't nag before the first submit).
  function wireAgentRequiredFieldValidation(overlay) {
    const form = overlay?.querySelector(".agents-form");
    if (!form) return;
    for (const { name, message } of AGENT_REQUIRED_FIELDS) {
      const field = form.querySelector(`[name="${name}"]`);
      if (!field) continue;
      const eventName =
        field.tagName === "SELECT" || name === "base_model_id"
          ? "change"
          : "input";
      field.addEventListener(eventName, () => {
        if (overlay.dataset.showFieldErrors !== "true") return;
        const filled = Boolean(String(field.value || "").trim());
        const disabledBaseModel =
          name === "base_model_id" ? selectedDisabledBaseModel(overlay) : null;
        setAgentFieldError(
          overlay,
          name,
          !filled
            ? message
            : disabledBaseModel
              ? `Base model "${disabledBaseModel.id}" is disabled: ${disabledBaseModel.reason}`
              : "",
        );
      });
    }
    const allowedEmailsField = form.querySelector('[name="allowed_emails"]');
    if (allowedEmailsField) {
      allowedEmailsField.addEventListener("input", () => {
        if (overlay.dataset.showFieldErrors !== "true") return;
        validateAllowedEmailsField(overlay);
      });
      allowedEmailsField.addEventListener("blur", () => {
        validateAllowedEmailsField(overlay);
      });
    }
  }

  function runtimeServerIdFromToolServerId(value) {
    return normalizeToolServerId(value).replace(/^server:/, "");
  }

  function normalizeBaseModel(raw) {
    if (!raw || typeof raw !== "object") return null;
    const id = String(raw.id || raw.model_id || "").trim();
    if (!id) return null;
    const disabledReason = String(raw.disabled_reason || "").trim();
    const reasoningEffortOptions = Array.isArray(raw.reasoning_effort_options)
      ? Array.from(
          new Set(
            raw.reasoning_effort_options
              .map((value) => String(value || "").trim())
              .filter(Boolean),
          ),
        )
      : null;
    return {
      id,
      display_name: String(raw.name || raw.display_name || id),
      description: String(raw.description || ""),
      picker_provider: String(raw.picker_provider || "").trim().toLowerCase(),
      picker_tier: String(raw.picker_tier || "").trim().toLowerCase() || null,
      is_local: raw.is_local === true,
      hidden: raw.hidden === true,
      disabled: raw.disabled === true || Boolean(disabledReason),
      disabled_reason: disabledReason,
      supports_reasoning:
        raw.supports_reasoning === true
          ? true
          : raw.supports_reasoning === false
            ? false
            : null,
      reasoning_effort_options: reasoningEffortOptions,
    };
  }

  // Skill records come from the existing get-skills IPC (rich data + logo path).
  function normalizeSkill(raw) {
    if (!raw || typeof raw !== "object") return null;
    const id = String(raw.name || raw.id || "").trim();
    if (!id) return null;
    const display_name = String(raw.display_name || displayNameFromId(id));
    return {
      id,
      display_name,
      description: String(raw.description || ""),
      source: String(raw.source || ""),
      icon_url: raw.logo || null,
      // Fallback logo = first-word + last-word initials (e.g. "MCP Bridge
      // Setup" -> "MS"), instead of a generic "S".
      icon_initial: skillInitials(display_name),
      // Marketplace provenance for display surfaces (read-only detail table).
      // Freshness truth (update/conflict) is read from the skills-freshness
      // snapshot, not from this 60s catalog cache.
      marketplace_id: raw.marketplace_id || "",
      marketplace_name: raw.marketplace_name || "",
      marketplace_solution_id: raw.marketplace_solution_id || null,
      plugin_name: raw.plugin_name || null,
      // Provenance gate: only explicitly-false blocks attachment, so older
      // catalog payloads without the flag keep working.
      agent_attachable: raw.agent_attachable !== false,
      has_update: raw.has_update === true,
      has_conflict: raw.has_conflict === true,
      is_read_only: raw.is_read_only === true,
    };
  }

  // MCP-server records come from loadMcpServers IPC, which already returns a
  // base64 data URL in `icon`.
  function normalizeToolServer(raw) {
    if (!raw || typeof raw !== "object") return null;
    const id = normalizeToolServerId(raw.id);
    if (!id) return null;
    const rawDisplay = String(raw.name || raw.display_name || "").trim();
    const isCore = Boolean(raw.isCore || raw.is_core);
    const userInstalled = Boolean(raw.userInstalled || raw.user_installed);
    const deploymentType = String(
      raw.deploymentType || raw.deployment_type || "",
    )
      .trim()
      .toLowerCase();
    // Source category for the unified picker badge (host wins, then core, then
    // user). Host servers run on the user's machine; core are built-in.
    let source = "";
    if (deploymentType === "host") source = "host";
    else if (isCore) source = "core";
    else if (userInstalled) source = "user";
    return {
      id,
      display_name: rawDisplay || displayNameFromId(id),
      description: String(raw.description || ""),
      icon_url: raw.icon || raw.icon_url || null,
      icon_initial: "M",
      is_core: isCore,
      user_installed: userInstalled,
      source,
    };
  }

  function invalidateCatalogs() {
    state.catalogs.loadedAt = 0;
  }

  async function refreshInstalledMcpServers() {
    const api = window.electronAPI;
    if (!api?.loadMcpServers) return;
    const result = await api.loadMcpServers();
    if (!result?.success) {
      throw new Error(result?.error || "Failed to refresh MCP servers");
    }
    const servers = Array.isArray(result.data) ? result.data : [];
    if (window.appState) {
      window.appState.servers = servers;
    }
    if (typeof window.updateMcpServersList === "function") {
      window.updateMcpServersList();
    }
    return servers;
  }

  function findInstalledMcpServer(servers, toolServerId) {
    const target = normalizeToolServerId(toolServerId);
    if (!target) return null;
    for (const server of servers || []) {
      const ids = [
        server?.id,
        server?.folderId,
        server?.folder_id,
      ].map(normalizeToolServerId);
      if (ids.includes(target)) return server;
    }
    return null;
  }

  function isRequiredMcpServerAlreadyEnabled(server) {
    if (!server) return false;
    if (server.isCore || server.is_core) return true;
    const serverId = String(server.id || server.folderId || "").trim();
    const state = window.appState || {};
    if (state.toggles?.[serverId] === true) return true;
    const status = String(
      state.healthStatus?.servers?.[serverId]?.status || "",
    ).toLowerCase();
    return Boolean(status && !["disabled", "not_configured", "unknown"].includes(status));
  }

  // Health statuses that mean a server is installed and enabled but still not
  // usable until the user finishes setup (auth or a startup failure). Mirrors
  // the control-plane attention badge in mcp-servers.js
  // (CONTROL_PLANE_ATTENTION_FAILURE_STATUSES + shouldShowNeedsAuth =>
  // "needs_oauth").
  const MCP_NEEDS_SETUP_STATUSES = new Set([
    "needs_oauth",
    "failed",
    "timeout",
    "not_running",
  ]);

  // Return display names of the agent's MCP tool servers that are not currently
  // integrated: not installed, not enabled, or enabled but not authenticated /
  // failing. Reads the same shared window.appState the control-plane badge uses
  // (no extra IPC), so it stays in sync with the "needs attention" indicator.
  function agentToolServersNeedingSetup(agent) {
    const toolServerIds = Array.isArray(agent?.tool_server_ids)
      ? agent.tool_server_ids
      : [];
    if (!toolServerIds.length) return [];
    const servers = window.appState?.servers || [];
    const toggles = window.appState?.toggles || {};
    const healthServers = window.appState?.healthStatus?.servers || {};
    const needing = [];
    const seen = new Set();
    for (const rawId of toolServerIds) {
      const toolServerId = normalizeToolServerId(rawId);
      if (!toolServerId || seen.has(toolServerId)) continue;
      seen.add(toolServerId);
      const server = findInstalledMcpServer(servers, toolServerId);
      // Core servers are always available; nothing to set up.
      if (server && (server.isCore || server.is_core)) continue;
      const runtimeId =
        (server && String(server.id || server.folderId || "").trim()) ||
        runtimeServerIdFromToolServerId(toolServerId);
      const displayName = server
        ? String(server.name || server.display_name || runtimeId)
        : runtimeId;
      if (!server) {
        // Referenced server is not installed locally.
        needing.push(displayName);
        continue;
      }
      const info = healthServers[runtimeId] || {};
      const status = String(info.status || "").trim().toLowerCase();
      const enabled =
        toggles[runtimeId] === true ||
        (status && !["disabled", "not_configured", "unknown"].includes(status));
      if (!enabled || info.disabled_by_user === true || status === "disabled") {
        needing.push(displayName);
        continue;
      }
      if (MCP_NEEDS_SETUP_STATUSES.has(status)) {
        needing.push(displayName);
      }
    }
    return needing;
  }

  async function enableRequiredMcpServersForAgentInstall(data) {
    const summary = {
      enabled: [],
      needsConfiguration: [],
      failed: [],
      missing: [],
    };
    const api = window.electronAPI;
    if (data?.type !== TYPE_AGENTS || !api?.toggleMcpServer) return summary;

    const requiredIds = new Set();
    for (const id of data?.created?.tool_server_ids || []) {
      const normalized = normalizeToolServerId(id);
      if (normalized) requiredIds.add(normalized);
    }
    for (const installed of data?.installedToolServers || []) {
      const normalized = normalizeToolServerId(
        installed?.installed_id || installed?.tool_server_id,
      );
      if (normalized) requiredIds.add(normalized);
    }
    if (!requiredIds.size) return summary;

    let servers = window.appState?.servers || [];
    try {
      servers = (await refreshInstalledMcpServers()) || servers;
    } catch (error) {
      console.warn("[Agents] Failed to refresh MCP servers after install", error);
    }

    for (const toolServerId of requiredIds) {
      const server = findInstalledMcpServer(servers, toolServerId);
      if (!server) {
        summary.missing.push(toolServerId);
        continue;
      }
      if (isRequiredMcpServerAlreadyEnabled(server)) continue;

      const runtimeServerId =
        String(server.id || server.folderId || "").trim() ||
        runtimeServerIdFromToolServerId(toolServerId);
      const displayName = String(
        server.name || server.display_name || runtimeServerId,
      );
      const deploymentType =
        server.deploymentType || server.deployment_type || "docker";

      try {
        const result = await api.toggleMcpServer(
          runtimeServerId,
          true,
          deploymentType,
          { backgroundLifecycle: true },
        );
        if (!result?.success) {
          throw new Error(result?.error || "Failed to enable MCP server");
        }
        if (window.appState?.toggles) {
          window.appState.toggles[runtimeServerId] = true;
        }
        if (result.requiresConfiguration) {
          summary.needsConfiguration.push(displayName);
        } else {
          summary.enabled.push(displayName);
        }
      } catch (error) {
        summary.failed.push({
          name: displayName,
          error: error?.message || String(error),
        });
      }
    }

    return summary;
  }

  function openMcpServersTab() {
    const buttons = getPanelButtons();
    if (buttons.mcp) {
      buttons.mcp.click();
      return;
    }
    setAgentsVisible(false);
    if (window.appState) {
      window.appState.controlPlaneView = "mcp-servers";
    }
  }

  let catalogsLoadPromise = null;

  async function loadCatalogs(options = {}) {
    // Concurrent callers (the question modal alongside the Agents tab, or a
    // picker Retry while the initial load is in flight) await the same load
    // instead of getting the still-empty catalogs object back immediately.
    if (state.catalogs.loading && catalogsLoadPromise) {
      return catalogsLoadPromise;
    }
    catalogsLoadPromise = runCatalogLoad(options);
    try {
      return await catalogsLoadPromise;
    } finally {
      catalogsLoadPromise = null;
    }
  }

  async function runCatalogLoad({ force = false } = {}) {
    const catalogs = state.catalogs;
    if (catalogs.loading) return catalogs;
    const isFresh =
      catalogs.baseModels &&
      catalogs.skills &&
      catalogs.toolServers &&
      Date.now() - catalogs.loadedAt < 60_000;
    if (!force && isFresh) return catalogs;
    catalogs.loading = true;
    try {
      // Base models: discovered via the Subagents MCP (filter_type=base).
      // Skills + MCP servers: use the existing rich IPC handlers so we get
      // icons (data URLs / file URLs) without an extra round trip.
      const api = window.electronAPI;
      const [baseModelsRes, skillsRes, serversRes] = await Promise.allSettled([
        callSubagent(TOOL_LIST, { filter_type: "base" }),
        api?.getSkills ? api.getSkills() : Promise.resolve({ success: false }),
        api?.loadMcpServers ? api.loadMcpServers() : Promise.resolve({ success: false }),
      ]);

      if (baseModelsRes.status === "fulfilled") {
        const baseRaw = Array.isArray(baseModelsRes.value?.agents)
          ? baseModelsRes.value.agents
          : Array.isArray(baseModelsRes.value)
            ? baseModelsRes.value
            : [];
        catalogs.baseModels = baseRaw
          .map(normalizeBaseModel)
          .filter((model) => model && !model.hidden);
        catalogs.baseModelsError = "";
      } else if (!catalogs.baseModels) {
        catalogs.baseModels = [];
        catalogs.baseModelsError =
          baseModelsRes.reason?.message ||
          String(baseModelsRes.reason || "Unable to load base models");
      } else {
        catalogs.baseModelsError =
          baseModelsRes.reason?.message ||
          String(baseModelsRes.reason || "Unable to refresh base models");
      }

      const skillsRaw = (() => {
        if (skillsRes.status !== "fulfilled") return [];
        const value = skillsRes.value;
        if (Array.isArray(value)) return value;
        if (Array.isArray(value?.skills)) return value.skills;
        if (Array.isArray(value?.data)) return value.data;
        return [];
      })();
      if (skillsRes.status === "fulfilled" || !catalogs.skills) {
        catalogs.skills = skillsRaw
          .map(normalizeSkill)
          .filter(Boolean)
          .sort((a, b) => a.display_name.localeCompare(b.display_name));
      }

      const serversRaw = (() => {
        if (serversRes.status !== "fulfilled") return [];
        const value = serversRes.value;
        if (Array.isArray(value?.data)) return value.data;
        if (Array.isArray(value?.servers)) return value.servers;
        if (Array.isArray(value)) return value;
        return [];
      })();
      if (serversRes.status === "fulfilled" || !catalogs.toolServers) {
        catalogs.toolServers = serversRaw
          .map(normalizeToolServer)
          .filter(Boolean)
          .sort((a, b) => a.display_name.localeCompare(b.display_name));
      }

      catalogs.loadedAt = Date.now();
      if (
        baseModelsRes.status === "rejected" ||
        skillsRes.status === "rejected" ||
        serversRes.status === "rejected"
      ) {
        console.warn("[Agents] catalog load partial failure", {
          baseModels: baseModelsRes.status,
          skills: skillsRes.status,
          toolServers: serversRes.status,
        });
      }
    } finally {
      catalogs.loading = false;
    }
    return catalogs;
  }

  function catalogOptionFor(id, options) {
    return (
      options.find((opt) => opt.id === id) || {
        id,
        display_name: displayNameFromId(id),
        description: id,
      }
    );
  }

  function normalizeAgentRecord(raw) {
    if (!raw || typeof raw !== "object") return null;
    const id = raw.id || "";
    const link = state.marketplaceLinks?.[id] || null;
    const draftAllowedEmails = getStoredAllowedEmails(id);
    return {
      id,
      name: raw.name || id,
      description: raw.description || "",
      base_model_id: raw.base_model_id || "",
      system_prompt: raw.system_prompt || "",
      skill_ids: Array.isArray(raw.skill_ids) ? raw.skill_ids.slice() : [],
      tool_server_ids: Array.isArray(raw.tool_server_ids)
        ? raw.tool_server_ids.slice()
        : [],
      allowed_emails:
        draftAllowedEmails !== null
          ? draftAllowedEmails
          : normalizeAllowedEmails(raw.allowed_emails),
      reasoning_effort: raw.reasoning_effort || null,
      profile_image_url: raw.profile_image_url || null,
      created_by_email: raw.created_by_email || "",
      creation_source: raw.creation_source || null,
      // Sidecar link wins; OWUI meta mirrors it; creation_source is the
      // last-resort provenance for installed copies whose listing AND link
      // records were both destroyed (2026-08-14 Smart Slides incident) —
      // an installed marketplace copy stays truthfully "installed".
      marketplace_relationship:
        link?.relationship ||
        raw.marketplace_relationship ||
        (raw.creation_source === "marketplace" && raw.is_read_only === true
          ? "installed"
          : null),
      marketplace_solution_id:
        link?.solutionId || raw.marketplace_solution_id || null,
      marketplace_link: link,
      is_read_only:
        raw.is_read_only === true ||
        raw.creation_source === "marketplace" ||
        link?.relationship === "installed" ||
        raw.marketplace_relationship === "installed",
      // Local edits saved without syncing to the marketplace (event-driven
      // flag on the link record; see ai-marketplace-agent-links.js).
      has_unpublished_changes: link?.hasLocalChanges === true,
    };
  }

  function upsertMyAgentFromInstallResult(rawAgent, solutionId) {
    const agent = normalizeAgentRecord(rawAgent);
    if (!agent?.id) return;
    if (solutionId) {
      agent.marketplace_solution_id = solutionId;
      agent.marketplace_link = {
        ...(agent.marketplace_link || {}),
        solutionId,
      };
    }
    const existingIndex = state.myAgents.findIndex((item) => item?.id === agent.id);
    if (existingIndex >= 0) {
      state.myAgents[existingIndex] = agent;
    } else {
      state.myAgents = [...state.myAgents, agent];
    }
  }

  // One skill-label derivation for every surface: authored bundle/ref name >
  // local authored display_name > the shared formatter (never a raw id on one
  // modal and a title-cased slug on another).
  function formatSkillLabel(value) {
    return (
      window.SkillCardRenderer?.formatSkillDisplayName?.(value) ||
      displayNameFromId(value)
    );
  }

  // "Plugin → Skill" label for every name surface — a plugin skill should be
  // recognizable as such wherever its name appears (tables, tooltips,
  // pickers, modal rows). Cards carry the plugin as a badge instead.
  function skillLabelWithPlugin(label, pluginName) {
    const base = String(label || "").trim();
    if (!pluginName) return base;
    const composed = window.SkillCardRenderer?.composeSkillPluginLabel?.(
      base,
      pluginName,
    );
    return composed || (base ? `${formatSkillLabel(pluginName)} → ${base}` : base);
  }

  // Authored display names AND provenance carried by an agent bundle's
  // skill_refs, keyed by canonical skill name — the only name/source
  // information for skills that are not on this computer. Every ref gets an
  // entry: kind matters even when the publisher didn't author a display name.
  function refInfoFromPayload(payload) {
    const info = new Map();
    for (const ref of asInstallSkillRefs(payload?.skill_refs)) {
      const canonicalName = canonicalSkillName(ref.skill_id);
      if (!canonicalName || info.has(canonicalName)) continue;
      info.set(canonicalName, {
        displayName: String(ref.display_name || "").trim(),
        kind: ref.kind || "",
        marketplaceName:
          ref.kind === "git-marketplace"
            ? String(ref.marketplace?.name || "").trim()
            : "",
        pluginName:
          ref.kind === "git-marketplace"
            ? String(ref.plugin_name || "").trim()
            : "",
      });
    }
    return info;
  }

  function getAgentSkillDetails(skillIds, catalogs, { refInfo = null } = {}) {
    const installedSkills = Array.isArray(catalogs?.skills) ? catalogs.skills : [];
    const seen = new Set();
    return (Array.isArray(skillIds) ? skillIds : [])
      .filter(Boolean)
      .filter((skillId) => {
        const canonicalName = canonicalSkillName(skillId);
        if (!canonicalName || seen.has(canonicalName)) return false;
        seen.add(canonicalName);
        return true;
      })
      .map((skillId) => {
        const canonicalName = canonicalSkillName(skillId);
        const match = installedSkills.find((skill) => canonicalSkillName(skill.id) === canonicalName);
        const info = refInfo?.get?.(canonicalName) || null;
        return {
          id: canonicalName || skillId,
          label: skillLabelWithPlugin(
            info?.displayName ||
              match?.display_name ||
              formatSkillLabel(canonicalName || skillId),
            match?.plugin_name || info?.pluginName || "",
          ),
        };
      });
  }

  // Source badge for a skill row — delegates to the shared SkillCardRenderer
  // maps so cards, detail tables, and modals stay on one class/label set.
  function skillSourceBadgeHtml(source) {
    const cls =
      window.SkillCardRenderer?.skillCardSourceBadgeClass?.(source) ??
      (source === "user" ? "badge-user" : source === "marketplace" ? "badge-installed" : "badge-core");
    const label =
      window.SkillCardRenderer?.skillCardSourceBadgeLabel?.(source) ??
      (source === "user" ? "User" : source === "marketplace" ? "Installed" : "Core");
    return `<span class="mcp-card-badge ${cls}">${escapeHtml(label)}</span>`;
  }

  // GIT provenance chip: shown next to Installed wherever an agent screen
  // lists a skill whose installed copy came from a git-based marketplace
  // (marketplace_id !== "ai-marketplace" — the Solutions Marketplace id).
  function gitMarketplaceBadgeHtml() {
    return '<span class="mcp-card-badge badge-git" title="Comes from a git-based marketplace repository">Git</span>';
  }

  function isGitMarketplaceSkillRow(row) {
    return (
      row?.source === "marketplace" &&
      Boolean(row?.marketplaceId) &&
      row.marketplaceId !== "ai-marketplace"
    );
  }

  // Skill resolution precedence (mirrors the get-skills loader): when a
  // canonical name exists in several sources, the system copy wins, then the
  // user copy, then installed marketplace copies.
  function skillSourcePrecedence(source) {
    return source === "system" ? 3 : source === "user" ? 2 : source === "marketplace" ? 1 : 0;
  }

  // Row details for the read-only agent view's skills table: display name +
  // source provenance from the catalog (freshness comes from the snapshot).
  // Skill tables everywhere sort by source group — Core/system first, then
  // the viewer's user skills, then Solutions Marketplace installs, then
  // git-marketplace installs (missing rows last) — alphabetically within
  // each group. Selection order is noise to readers.
  function skillTableSourceRank(row) {
    if (row?.missing) return 4;
    if (row?.source === "system") return 0;
    if (row?.source === "user") return 1;
    return isGitMarketplaceSkillRow(row) ? 3 : 2;
  }

  function sortSkillTableRows(rows) {
    return rows.sort(
      (a, b) =>
        skillTableSourceRank(a) - skillTableSourceRank(b) ||
        String(a.label || "").localeCompare(String(b.label || "")),
    );
  }

  // Same grouping for plan-based tables (publish/install modals): plans carry
  // provenance strings instead of a bare source.
  function sortSkillPlansForDisplay(plans) {
    const rank = (plan) => {
      const provenance = String(plan?.provenance || "");
      if (provenance === "system" || provenance === "local-system") return 0;
      if (provenance.includes("user")) return 1;
      // Git installs rank last whether the plan says so directly or via the
      // reused local copy's marketplace id (mirrors isGitMarketplaceSkillRow).
      if (
        provenance.includes("git") ||
        (plan?.marketplaceId && plan.marketplaceId !== "ai-marketplace")
      ) {
        return 3;
      }
      return 2;
    };
    const label = (plan) =>
      String(plan?.displayName || plan?.canonicalName || plan?.skillId || "");
    return plans.sort(
      (a, b) => rank(a) - rank(b) || label(a).localeCompare(label(b)),
    );
  }

  function getAgentSkillRowDetails(skillIds, catalogs, { refInfo = null } = {}) {
    const installedSkills = Array.isArray(catalogs?.skills) ? catalogs.skills : [];
    const seen = new Set();
    return sortSkillTableRows((Array.isArray(skillIds) ? skillIds : [])
      .map((value) => canonicalSkillName(String(value || "")))
      .filter((name) => {
        if (!name || seen.has(name)) return false;
        seen.add(name);
        return true;
      })
      .map((canonicalName) => {
        // Prefer the copy that actually wins skill resolution when the same
        // canonical name exists in several sources (system > user >
        // marketplace) instead of trusting catalog order.
        let match = null;
        for (const skill of installedSkills) {
          if (canonicalSkillName(skill.id) !== canonicalName) continue;
          if (!match || skillSourcePrecedence(skill.source) > skillSourcePrecedence(match.source)) {
            match = skill;
          }
        }
        const info = refInfo?.get?.(canonicalName) || null;
        return {
          canonicalName,
          label: skillLabelWithPlugin(
            info?.displayName ||
              match?.display_name ||
              formatSkillLabel(canonicalName),
            match?.plugin_name || info?.pluginName || "",
          ),
          source: match?.source || "",
          // get-skills only carries a real marketplace name for marketplace
          // copies; other sources may echo unrelated values — never show them.
          marketplaceName:
            match?.source === "marketplace" ? match?.marketplace_name || "" : "",
          marketplaceId:
            match?.source === "marketplace" ? String(match?.marketplace_id || "") : "",
          marketplaceSolutionId:
            match?.source === "marketplace"
              ? String(match?.marketplace_solution_id || "")
              : "",
          missing: !match,
          // Bundle-ref provenance: the only source facts we have for skills
          // that are not on this computer.
          refKind: match ? "" : info?.kind || "",
          refMarketplaceName: match ? "" : info?.marketplaceName || "",
        };
      }));
  }

  // Source-cell chips for one skills-table row. Shared between the initial
  // render (published unknown → false) and the freshness patch so both paths
  // agree. Chip order = facet order: for installed copies the viewer owns,
  // Published comes before the Installed source chip; every other source
  // shows its source chip first, then Published (matches the skill cards).
  // installedBadge:false drops the Installed chip from marketplace rows — the
  // provenance TABLES say "Already installed on this computer." in their Note
  // column instead; tooltips keep the chip (they have no Note column, so it
  // is their only installed-vs-not signal).
  function agentViewSkillRowChipsHtml(
    row,
    { published = false, installedBadge = true } = {},
  ) {
    if (row.missing) {
      return '<span class="agent-details-empty">Not on this computer</span>';
    }
    const solutionId =
      row.source === "marketplace"
        ? row.marketplaceSolutionId || ""
        : state.skillFreshness.snapshot?.linksByName?.[row.canonicalName]?.solutionId || "";
    const publishedBadge = published
      ? `<span class="mcp-card-badge badge-published" title="${
          solutionId
            ? `Linked to AI Marketplace solution ${escapeHtml(solutionId)}`
            : "Published to the AI Marketplace"
        }">Published</span>`
      : "";
    const sourceBadge =
      row.source === "marketplace" && !installedBadge
        ? ""
        : skillSourceBadgeHtml(row.source);
    const gitBadge = isGitMarketplaceSkillRow(row) ? gitMarketplaceBadgeHtml() : "";
    const marketplaceBadge = row.marketplaceName
      ? `<span class="mcp-card-badge badge-marketplace-name" title="${escapeHtml(row.marketplaceName)}">${escapeHtml(row.marketplaceName)}</span>`
      : "";
    return row.source === "marketplace"
      ? `${publishedBadge}${sourceBadge}${gitBadge}${marketplaceBadge}`
      : `${sourceBadge}${publishedBadge}${gitBadge}${marketplaceBadge}`;
  }

  // Source-cell chips for the skills TABLE only (the card tooltip keeps the
  // plain agentViewSkillRowChipsHtml missing branch and Installed chip).
  // Missing rows still get provenance badges when the agent bundle's
  // skill_refs say where the skill comes from; installed-vs-not lives in the
  // Note column, so the Installed chip stays out of Source here.
  function agentViewSkillRowSourceChipsHtml(row, { published = false } = {}) {
    if (!row.missing) {
      return agentViewSkillRowChipsHtml(row, { published, installedBadge: false });
    }
    if (row.refKind === "git-marketplace") {
      const name = row.refMarketplaceName || "marketplace";
      return `${gitMarketplaceBadgeHtml()}<span class="mcp-card-badge badge-marketplace-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>`;
    }
    if (row.refKind === "solution") {
      return '<span class="mcp-card-badge badge-marketplace-name">Solutions Marketplace</span>';
    }
    return '<span class="agent-details-empty">—</span>';
  }

  // Note column: per-row caveats only. Everything fine reads as a quiet dash.
  // A flagged row (SKILLS_NOT_FOUND on this agent) gets the warning glyph and
  // the ownership-boundary explanation instead of the plain missing note.
  function agentViewSkillRowNoteHtml(row, { flagged = false } = {}) {
    if (flagged) {
      return `<span class="agent-skill-warning-note" title="Removed after its source left the marketplace. The agent's owner resolves this by republishing.">⚠ No longer available — owner must republish</span>`;
    }
    const note = row.missing
      ? "Not on this computer"
      : row.source === "marketplace"
        ? "Already installed on this computer."
        : "—";
    return `<span class="agent-details-empty">${note}</span>`;
  }

  // Published in these tables means VERIFIED published, mirroring the skill
  // cards (authoritativeSkillMarketplaceLink): the linked/installed solution
  // id must appear in the viewer's list_published_skills result — a stale
  // local link to a dead listing must not read as Published here while the
  // skill's own card refuses to.
  function agentViewSkillRowPublished(snapshot, { canonicalName, source, marketplaceSolutionId }) {
    const publishedIds = snapshot?.publishedSolutionIds;
    if (!publishedIds || publishedIds.size === 0) return false;
    if (source === "marketplace") {
      return Boolean(marketplaceSolutionId) && publishedIds.has(marketplaceSolutionId);
    }
    const link = snapshot?.linksByName?.[canonicalName];
    return Boolean(link?.solutionId) && publishedIds.has(link.solutionId);
  }

  // Read-only agent view: Status | Skill | Source | Note table (same table
  // family as the publish/install modals, with per-row caveats in Note instead
  // of a "What happens" column). Status cells start as a spinner and are
  // patched in place once the skills-freshness snapshot resolves
  // (applyAgentViewSkillStatuses), which also fills in the Published chip for
  // rows whose skill the viewer publishes.
  function buildAgentViewSkillsTableHtml(rows, { flaggedLeaves = null } = {}) {
    if (!Array.isArray(rows) || rows.length === 0) {
      return '<span class="agent-details-empty">No skills configured.</span>';
    }
    const body = rows
      .map((row) => {
        const flagged = Boolean(flaggedLeaves?.has?.(row.canonicalName));
        return `
          <tr class="agents-publish-skill-row" data-skill="${escapeHtml(row.canonicalName)}" data-skill-source="${escapeHtml(row.missing ? "" : row.source)}" data-skill-solution="${escapeHtml(row.marketplaceSolutionId || "")}" data-skill-marketplace-name="${escapeHtml(row.marketplaceName || "")}" data-skill-marketplace-id="${escapeHtml(row.marketplaceId || "")}"${flagged ? ' data-skill-flagged="true"' : ""}>
            <td><span class="agents-publish-skill-status" data-status="${row.missing ? "idle" : "working"}" data-skill-status="${escapeHtml(row.canonicalName)}"></span></td>
            <td class="agents-publish-skill-name">${escapeHtml(row.label)}</td>
            <td><span class="agents-publish-skill-chips">${agentViewSkillRowSourceChipsHtml(row)}</span></td>
            <td><span class="agents-publish-skill-note">${agentViewSkillRowNoteHtml(row, { flagged })}</span></td>
          </tr>`;
      })
      .join("");
    return `
      <table class="agents-publish-skill-table agent-view-skill-table">
        <thead>
          <tr><th>Status</th><th>Skill</th><th>Source</th><th>Note</th></tr>
        </thead>
        <tbody>${body}</tbody>
      </table>`;
  }

  // Resolve the freshness snapshot and stamp each row of the read-only /
  // edit-form skills tables: status cells get their freshness state, and the
  // Source chips are re-rendered so verified-published skills gain their
  // Published chip. Session-guarded; patches cells in place (no re-render).
  async function applyAgentViewSkillStatuses(root, session) {
    let snapshot = null;
    try {
      snapshot = await loadSkillFreshnessSnapshot();
    } catch {
      snapshot = state.skillFreshness.snapshot;
    }
    if (state.editor !== session || !root) return;
    const cells = root.querySelectorAll(".agent-view-skill-table [data-skill-status]");
    (cells || []).forEach((cell) => {
      const name = cell.getAttribute("data-skill-status");
      const entry = snapshot?.bySkill?.get?.(name) || null;
      cell.dataset.status = entry ? skillFreshnessStatusFor(entry) : "idle";
    });
    const rows = root.querySelectorAll(".agent-view-skill-table .agents-publish-skill-row");
    (rows || []).forEach((rowEl) => {
      const source = rowEl.getAttribute("data-skill-source") || "";
      // Missing rows keep their "Not on this computer" cell untouched.
      if (!source) return;
      const chipsHost = rowEl.querySelector(".agents-publish-skill-chips");
      if (!chipsHost) return;
      const row = {
        canonicalName: rowEl.getAttribute("data-skill") || "",
        source,
        marketplaceName: rowEl.getAttribute("data-skill-marketplace-name") || "",
        marketplaceId: rowEl.getAttribute("data-skill-marketplace-id") || "",
        marketplaceSolutionId: rowEl.getAttribute("data-skill-solution") || "",
        missing: false,
      };
      // Table variant, not the tooltip one: the patch must not resurrect the
      // Installed chip these tables moved into their Note column.
      chipsHost.innerHTML = agentViewSkillRowSourceChipsHtml(row, {
        published: agentViewSkillRowPublished(snapshot, row),
      });
    });
  }

  // Compact skills summary for the agent card: an "N skills" link; the full
  // deduped, friendly-labelled list lives in the hover tooltip.
  function buildAgentSkillsLinkHtml(agentId, skillIds, catalogs = state.catalogs) {
    const count = getAgentSkillDetails(skillIds, catalogs).length;
    if (count === 0) return "";
    return `<div class="agent-card-row"><strong>Skills:</strong> <button type="button" class="agent-card-skills-link" data-agent-id="${escapeHtml(agentId)}">${count} ${count === 1 ? "skill" : "skills"}</button></div>`;
  }

  // Same compact skills link for a Discover card; keyed by solution id so the
  // hover tooltip can resolve skills from the marketplace record.
  function buildSolutionSkillsLinkHtml(solutionId, skillIds, catalogs = state.catalogs) {
    const count = getAgentSkillDetails(skillIds, catalogs).length;
    if (count === 0) return "";
    return `<div class="agent-card-row"><strong>Skills:</strong> <button type="button" class="agent-card-skills-link" data-solution-id="${escapeHtml(solutionId)}">${count} ${count === 1 ? "skill" : "skills"}</button></div>`;
  }

  function buildAgentSkillsTooltipHtml(skillItems) {
    const items = Array.isArray(skillItems) ? skillItems.filter(Boolean) : [];
    if (items.length === 0) return "";
    const rows = items
      .map((item) => `<div class="agent-card-tooltip-row">${escapeHtml(item.label || item.id || "")}</div>`)
      .join("");
    return `<div class="tooltip-header">Skills</div><div class="tooltip-content">${rows}</div>`;
  }

  // Skills tooltip: the provenance table's Skill + Source columns (same
  // chips, no status column). Provenance is viewer-local, so rows the local
  // catalog can't resolve are controlled by `missingChips`: my-agents keeps
  // the "Not on this computer" note, Discover shows a neutral Marketplace
  // chip (every skill in a listing is a marketplace-listing skill, and
  // not-yet-installed is the expected state there).
  function buildAgentSkillsProvenanceTooltipHtml(skillIds, { missingChips = "note" } = {}) {
    const rows = getAgentSkillRowDetails(skillIds, state.catalogs);
    if (!rows.length) return "";
    const snapshot = state.skillFreshness.snapshot;
    const body = rows
      .map((row) => {
        const chips =
          row.missing && missingChips === "marketplace"
            ? '<span class="mcp-card-badge badge-marketplace-name">Solutions Marketplace</span>'
            : agentViewSkillRowChipsHtml(row, {
                published: agentViewSkillRowPublished(snapshot, row),
              });
        return `<div class="agent-card-tooltip-skill-name">${escapeHtml(row.label)}</div><div class="agent-card-tooltip-skill-chips"><span class="agents-publish-skill-chips">${chips}</span></div>`;
      })
      .join("");
    return `<div class="tooltip-header">Skills</div><div class="tooltip-content agent-card-tooltip-skill-grid">${body}</div>`;
  }

  function resolveAgentCardTooltipHtml(anchor) {
    if (anchor.classList.contains("agent-card-skills-link")) {
      const solutionId = anchor.dataset.solutionId || "";
      if (solutionId) {
        const sol = state.discoverResults.find((item) => item.id === solutionId);
        if (!sol) return "";
        // TTL-guarded (5-min backoff) + single-flight: makes Published chips
        // resolvable when Discover is reached with zero my-agents (the render
        // path that normally loads the snapshot early-returns on empty).
        void loadSkillFreshnessSnapshot().catch(() => {});
        return buildAgentSkillsProvenanceTooltipHtml(solutionAgentFacts(sol).skill_ids, {
          missingChips: "marketplace",
        });
      }
      const agentId = anchor.dataset.agentId || "";
      const agent = state.myAgents.find((candidate) => candidate.id === agentId);
      if (!agent) return "";
      return buildAgentSkillsProvenanceTooltipHtml(agent.skill_ids);
    }
    return "";
  }

  function showAgentCardTooltipFor(anchor, html) {
    const tooltip = getAgentCardFloatingTooltip();
    tooltip.innerHTML = html;
    tooltip.hidden = false;
    tooltip.style.visibility = "hidden";
    const width = tooltip.offsetWidth;
    const height = tooltip.offsetHeight;
    tooltip.style.visibility = "";
    const rect = anchor.getBoundingClientRect();
    let left;
    let top;
    // Opt-in right-side placement (data-info-tooltip-placement="right"), used
    // by blocked Delete/Uninstall controls whose dropdown would cover a
    // below-placed panel. Falls back to the default flow when the panel
    // would not fit between the trigger and the viewport edge.
    const placeRight =
      anchor?.dataset?.infoTooltipPlacement === "right" &&
      rect.right + 6 + width <= window.innerWidth - 8;
    if (placeRight) {
      left = rect.right + 6;
      top = rect.top + (rect.height - height) / 2;
      if (top + height > window.innerHeight - 8) {
        top = window.innerHeight - height - 8;
      }
    } else {
      left = rect.left;
      top = rect.bottom + 6;
      if (top + height > window.innerHeight - 8) {
        top = rect.top - height - 6;
      }
    }
    if (top < 8) top = 8;
    if (left < 8) left = 8;
    if (left + width > window.innerWidth - 8) {
      left = window.innerWidth - width - 8;
    }
    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${left}px`;
  }

  function getAgentToolDetails(toolServerIds, catalogs) {
    const installedServers = Array.isArray(catalogs?.toolServers) ? catalogs.toolServers : [];
    const seen = new Set();
    return (Array.isArray(toolServerIds) ? toolServerIds : [])
      .map(normalizeToolServerId)
      .filter(Boolean)
      .filter((serverId) => {
        if (seen.has(serverId)) return false;
        seen.add(serverId);
        return true;
      })
      .map((serverId) => {
        const match = installedServers.find((server) => server.id === serverId);
        return {
          id: runtimeServerIdFromToolServerId(serverId),
          rawId: serverId,
          label: match?.display_name || displayNameFromId(serverId),
        };
      });
  }

  function renderAgentDetailsFields(fields) {
    return fields
      .filter((field) => field && field.valueHtml)
      .map(
        (field) => `
          <div class="agent-details-field">
            <dt>${escapeHtml(field.label)}</dt>
            <dd>${field.valueHtml}</dd>
          </div>
        `,
      )
      .join("");
  }

  function renderAgentDetailsTools(items, emptyLabel) {
    if (!Array.isArray(items) || items.length === 0) {
      return `<span class="agent-details-empty">${escapeHtml(emptyLabel)}</span>`;
    }
    return `
      <div class="agent-tool-icon-list agent-details-tool-list">
        ${items
          .map(
            (item) => `
              <span class="agent-details-tool-item" title="${escapeHtml(`${item.label || item.rawId || item.id || ""} (${item.rawId || item.id || ""})`)}">
                ${renderAgentToolServerIcon(item.id)}
                <span>${escapeHtml(item.label || item.rawId || item.id || "")}</span>
              </span>
            `,
          )
          .join("")}
      </div>
    `;
  }

  // Read-only page body: mirrors the editor's 3 numbered sections with static
  // values instead of a disabled interactive form (the pickers register
  // document-level listeners and popovers that a read-only page never needs).
  function buildAgentViewHtml({
    description,
    notice = "",
    informationMessage = "",
    // Local warning strip (pastel), stacked UNDER the read-only info pane:
    // e.g. SKILLS_NOT_FOUND flags on an installed copy.
    warningMessage = "",
    identityFields,
    modelFields,
    systemPrompt,
    toolItems,
    // Who can use the marketplace copy. Read-only mirror of the edit form's
    // Allowed emails field; empty list renders "Everyone (public)".
    allowedEmails = [],
    // The skills section, built by buildAgentViewSkillsTableHtml (which
    // renders its own "No skills configured." empty state).
    skillsSectionHtml = "",
  }) {
    const normalizedEmails = normalizeAllowedEmails(allowedEmails);
    return `
      <div class="agents-form-editor agent-view" data-readonly="true">
        ${
          informationMessage
            ? `<div class="marketplace-readonly-pane" role="note">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v5"></path><path d="M12 8h.01"></path></svg>
                <span>${escapeHtml(informationMessage)}</span>
              </div>`
            : ""
        }
        ${
          warningMessage
            ? `<div class="marketplace-warning-pane" role="note" data-agent-warning-pane="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
                <span>${escapeHtml(warningMessage)}</span>
              </div>`
            : ""
        }
        <section class="agent-editor-section">
          <div class="agent-editor-section-heading">
            <span class="agent-editor-step" aria-hidden="true">1</span>
            <div>
              <h3>Identity and access</h3>
              <p>This agent's description, access, and provenance.</p>
            </div>
          </div>
          <div class="agent-editor-section-body">
            ${notice ? `<div class="agent-details-notice">${escapeHtml(notice)}</div>` : ""}
            <div class="agents-form-field">
              <span class="agents-form-label">Description</span>
              <div class="agent-view-textbox">${escapeHtml(description || "No description provided.")}</div>
            </div>
            <div class="agents-form-field">
              <span class="agents-form-label">Allowed emails</span>
              <div class="agent-view-textbox agent-view-textbox-pre">${
                normalizedEmails.length
                  ? escapeHtml(normalizedEmails.join("\n"))
                  : "Everyone (public)"
              }</div>
            </div>
            <dl class="agent-details-grid">${renderAgentDetailsFields(identityFields)}</dl>
          </div>
        </section>
        <section class="agent-editor-section">
          <div class="agent-editor-section-heading">
            <span class="agent-editor-step" aria-hidden="true">2</span>
            <div>
              <h3>Model and behavior</h3>
              <p>The model foundation and instructions this agent runs with.</p>
            </div>
          </div>
          <div class="agent-editor-section-body">
            <dl class="agent-details-grid">${renderAgentDetailsFields(modelFields)}</dl>
            <div class="agents-form-field">
              <span class="agents-form-label">System prompt</span>
              ${
                systemPrompt
                  ? `<pre class="agent-view-prompt">${escapeHtml(systemPrompt)}</pre>`
                  : '<span class="agent-details-empty">No system prompt available.</span>'
              }
            </div>
          </div>
        </section>
        <section class="agent-editor-section">
          <div class="agent-editor-section-heading">
            <span class="agent-editor-step" aria-hidden="true">3</span>
            <div>
              <h3>Capabilities</h3>
              <p>The reusable knowledge and tools this agent can use.</p>
            </div>
          </div>
          <div class="agent-editor-section-body">
            <div class="agents-form-field">
              <span class="agents-form-label">Skills</span>
              ${skillsSectionHtml}
            </div>
            <div class="agents-form-field">
              <span class="agents-form-label">MCP servers</span>
              ${renderAgentDetailsTools(toolItems, "No MCP servers configured.")}
            </div>
          </div>
        </section>
      </div>
    `;
  }

  function buildInstalledAgentViewHtml(agent, catalogs, notice = "") {
    const warningMessage = agentWarningsSummary(agent);
    const flaggedLeaves = agentFlaggedSkillLeaves(agent);
    return buildAgentViewHtml({
      description: agent.description,
      notice,
      informationMessage:
        "This agent was installed from the AI Solutions Marketplace and is read only. Create a copy if you'd like to customize it.",
      warningMessage: warningMessage
        ? `There are warnings for this agent: ${warningMessage}`
        : "",
      identityFields: [
        { label: "Source", valueHtml: "Installed from AI Solutions Marketplace" },
        agent.marketplace_solution_id
          ? {
              label: "Solution ID",
              valueHtml: copyableIdBadgeHtml(agent.marketplace_solution_id),
            }
          : null,
        { label: "Author", valueHtml: escapeHtml(agent.created_by_email || "Unknown") },
      ],
      allowedEmails: agent.allowed_emails,
      modelFields: [
        // Same presentation as the editor/cards: provider icon + display name
        // and a formatted effort chip, instead of raw ids ("gpt-5-6-terra",
        // "medium") that read as styling bugs next to the editable form.
        { label: "Base model", valueHtml: agentModelChipHtml(agent, catalogs) },
        {
          label: "Reasoning effort",
          valueHtml: agentReasoningChipHtml(agent) || escapeHtml("Standard"),
        },
      ],
      toolItems: getAgentToolDetails(agent.tool_server_ids, catalogs),
      systemPrompt: agent.system_prompt,
      skillsSectionHtml: buildAgentViewSkillsTableHtml(
        getAgentSkillRowDetails(agent.skill_ids, catalogs),
        { flaggedLeaves },
      ),
    });
  }

  function buildDiscoverAgentViewHtml(solution, catalogs, notice = "") {
    const bundle = getSolutionBundle(solution);
    const payload = marketplaceAgentPayloadFromBundle(bundle);
    const skillIds = asDisplayIds(payload.skill_ids, canonicalSkillName);
    const toolServerIds = asDisplayIds(payload.tool_server_ids, normalizeToolServerId);
    // Bundle-authored names ("GTM Brief QA") beat slug derivation, and ref
    // provenance (solution vs git marketplace) drives Source badges for
    // skills that only exist on the publisher's machine.
    const refInfo = refInfoFromPayload(payload);
    return buildAgentViewHtml({
      description: solution.description || payload.description || "",
      notice:
        notice ||
        (solutionBundleIsRetrievable(solution)
          ? ""
          : "This marketplace listing does not currently include an installable bundle, so it cannot be installed. Ask the author to re-publish it with a bundle attached."),
      identityFields: [
        { label: "Source", valueHtml: "AI Marketplace" },
        { label: "Solution ID", valueHtml: copyableIdBadgeHtml(solution.id) },
        { label: "Author", valueHtml: escapeHtml(solution.author || "—") },
      ],
      allowedEmails: solution.allowed_emails || payload.allowed_emails,
      modelFields: [
        // Same presentation as the installed read-only view: identity chip +
        // formatted effort instead of raw ids; skills/tools render in the
        // Capabilities section below, not as raw id lists here.
        {
          label: "Base model",
          valueHtml: agentModelChipHtml({ base_model_id: payload.base_model_id }, catalogs),
        },
        {
          label: "Reasoning effort",
          valueHtml:
            agentReasoningChipHtml({ reasoning_effort: payload.reasoning_effort }) ||
            escapeHtml("Standard"),
        },
      ],
      toolItems: getAgentToolDetails(toolServerIds, catalogs),
      systemPrompt: typeof payload.system_prompt === "string" ? payload.system_prompt : "",
      skillsSectionHtml: buildAgentViewSkillsTableHtml(
        getAgentSkillRowDetails(skillIds, catalogs, { refInfo }),
      ),
    });
  }

  async function loadInstalledAgentDetails(agentId) {
    let agent = state.myAgents.find((item) => item.id === agentId) || null;
    let notice = "";
    try {
      const fetchedAgent = normalizeAgentRecord(await fetchAgentWithSystemPrompt(agentId));
      agent = await hydrateLinkedAgentAllowedEmails(fetchedAgent);
    } catch (error) {
      if (!agent) throw error;
      notice = `Some details could not be loaded: ${error.message || String(error)}`;
    }
    if (!agent) throw new Error("Agent not found");
    return {
      title: agent.name || agentId,
      agent,
      notice,
    };
  }

  async function loadDiscoverAgentDetails(solutionId) {
    let solution = state.discoverResults.find((item) => item.id === solutionId) || null;
    let notice = "";
    try {
      const result = await window.electronAPI?.aiMarketplace?.getSolution?.(solutionId);
      if (!result?.success) {
        throw new Error(result?.error || "Failed to load marketplace agent");
      }
      const fetchedSolution =
        result.data && typeof result.data === "object" ? result.data : {};
      solution =
        fetchedSolution.has_bundle === false
          ? {
              ...(solution || {}),
              bundle: null,
              resolved_bundle_cache: null,
              ...fetchedSolution,
            }
          : { ...(solution || {}), ...fetchedSolution };
      if (!getSolutionBundle(solution) && solution?.has_bundle !== false) {
        const bundleResult = await window.electronAPI?.aiMarketplace?.getBundle?.(solutionId);
        if (bundleResult?.success && bundleResult.data) {
          solution = { ...solution, bundle: bundleResult.data };
        }
      }
    } catch (error) {
      if (!solution) throw error;
      notice = `Some details could not be loaded: ${error.message || String(error)}`;
    }
    if (!solution) throw new Error("Marketplace agent not found");
    const installedAgentId = findLinkedAgentIdForSolution(
      solution.id,
      state.marketplaceLinks,
    );
    return {
      title: solution.name || solutionId,
      solution,
      notice,
      installable: !installedAgentId && solutionBundleIsRetrievable(solution),
      installLabel: installedAgentId
        ? "Installed"
        : INSTALL_LABELS[solution.type] || "Install",
    };
  }

  // Marketplace status chips shown in the page hero (mirrors the card badges).
  function buildAgentPageChipsHtml(agent) {
    if (!agent) return "";
    const user =
      agent?.creation_source === "local" &&
      agentOwnedByViewer(agent, state.viewerIdentity)
        ? '<span class="mcp-card-badge badge-user">User</span>'
        : "";
    const installed =
      agentMarketplaceRelationship(agent) === "installed"
        ? '<span class="mcp-card-badge badge-installed">Installed</span>'
        : "";
    const published = agentPublishedForViewer(agent, state.viewerIdentity)
      ? `<span class="mcp-card-badge badge-published" title="Viewer-owned AI Marketplace solution ${escapeHtml(agent.marketplace_solution_id)}">Published</span>`
      : "";
    const unpublished =
      agentCanPublish(agent, state.viewerIdentity) &&
      Boolean(agent.marketplace_solution_id) &&
      agent.has_unpublished_changes
        ? `<span class="mcp-card-badge badge-unpublished" title="Local edits not yet published to the marketplace">Unpublished changes</span>`
        : "";
    const updateAvailable = agentUpdateBadgeHtml(agent);
    // Same ordering as the facet filters: User, Published, Installed.
    return `${user}${published}${installed}${unpublished}${updateAvailable}`;
  }

  // id/leaf lookups over the skill catalog, memoized on the catalog array's
  // identity. agentBlockedSkillNames runs once per agent card, so rebuilding
  // both maps per call costs O(agents x skills) per repaint for a handful of
  // lookups each.
  let skillLookupIndexCache = { source: null, byId: null, byLeaf: null };
  function skillLookupIndex(skills) {
    if (skillLookupIndexCache.source === skills) return skillLookupIndexCache;
    const byId = new Map(skills.map((skill) => [skill.id, skill]));
    const byLeaf = new Map();
    for (const skill of skills) {
      const leaf = canonicalSkillName(skill.id);
      if (!leaf) continue;
      if (!byLeaf.has(leaf)) byLeaf.set(leaf, []);
      byLeaf.get(leaf).push(skill);
    }
    skillLookupIndexCache = { source: skills, byId, byLeaf };
    return skillLookupIndexCache;
  }

  // Skills on this agent that the provenance policy blocks from publishing
  // (installed from a non-qualifying marketplace). Grandfathered skills stay
  // usable locally; they only stop the agent from SPREADING via publish.
  function agentBlockedSkillNames(agent) {
    const skills = Array.isArray(state.catalogs.skills) ? state.catalogs.skills : [];
    if (!skills.length) return [];
    const { byId, byLeaf } = skillLookupIndex(skills);
    const blocked = [];
    const seen = new Set();
    for (const rawId of Array.isArray(agent?.skill_ids) ? agent.skill_ids : []) {
      const id = String(rawId || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      let skill = byId.get(id) || null;
      if (!skill) {
        const matches = byLeaf.get(canonicalSkillName(id)) || [];
        if (matches.length === 1) skill = matches[0];
      }
      if (skill && skill.agent_attachable === false) {
        blocked.push(skill.display_name || id);
      }
    }
    return blocked;
  }

  function blockedPublishTooltip(blockedNames) {
    return `Publishing is blocked: ${blockedNames.join(", ")} ${blockedNames.length === 1 ? "comes" : "come"} from an unapproved marketplace. Remove ${blockedNames.length === 1 ? "it" : "them"} to publish.`;
  }

  // Header action buttons for the inline agent pages. They reuse the
  // delegated data-agent-id classes, so handleAgentAction dispatches them.
  function buildAgentPageActionsHtml(agent, mode) {
    if (!agent?.id) return "";
    const id = escapeHtml(agent.id);
    const name = escapeHtml(agent.name || agent.id);
    const useBtn = `
      <button class="btn-secondary agent-page-action agent-use-btn" type="button" data-agent-id="${id}" data-agent-name="${name}" title="Open a new chat using this agent">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
        Chat
      </button>`;
    const cloneBtn = `
      <button class="btn-secondary agent-page-action agent-clone-btn" type="button" data-agent-id="${id}" title="Create an editable copy of this agent">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
        Duplicate
      </button>`;
    const deleteBtn = `
      <button class="btn-secondary agent-page-action agent-page-action-danger agent-delete-btn" type="button" data-agent-id="${id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
        Delete
      </button>`;
    if (mode === "view") {
      const reclaimBtn = agentCanReclaim(agent, state.viewerIdentity)
        ? `
      <button class="btn-secondary agent-page-action agent-reclaim-btn" type="button" data-agent-id="${id}" title="Make this your editable author copy; Republish will update your listing">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 9.9-1"></path></svg>
        Convert to editable copy
      </button>`
        : "";
      const unpublishBtn =
        agentCanUnpublish(agent, state.viewerIdentity)
          ? `
      <button class="btn-secondary agent-page-action agent-unpublish-btn" type="button" data-agent-id="${id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 5v14"></path><path d="M19 12l-7 7-7-7"></path></svg>
        Unpublish
      </button>`
          : "";
      return `${useBtn}${reclaimBtn}${unpublishBtn}${cloneBtn}${deleteBtn}`;
    }
    const isLinked = Boolean(agent.marketplace_solution_id);
    const blockedPublishSkills = agentBlockedSkillNames(agent);
    const publishBtn = `
      <button class="btn-secondary agent-page-action agent-publish-btn" type="button" data-agent-id="${id}"${blockedPublishSkills.length ? ` disabled title="${escapeHtml(blockedPublishTooltip(blockedPublishSkills))}"` : ""}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
        ${isLinked ? "Republish" : "Publish"}
      </button>`;
    const unpublishBtn = isLinked
      ? `
      <button class="btn-secondary agent-page-action agent-unpublish-btn" type="button" data-agent-id="${id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 5v14"></path><path d="M19 12l-7 7-7-7"></path></svg>
        Unpublish
      </button>`
      : "";
    // Chat → (Re)publish → Unpublish → Duplicate → Delete: lifecycle actions
    // together, the copy action after them, destruction last.
    return `${useBtn}${publishBtn}${unpublishBtn}${cloneBtn}${deleteBtn}`;
  }

  // Footer twin of the header (Re)publish action, rendered beside Save
  // changes: one click saves the open edit, then enters the publish flow —
  // the delegated agent-publish-btn class routes to publishAgentWithDirtySave.
  function buildAgentFooterPublishButtonHtml(agent) {
    if (!agent?.id) return "";
    const isLinked = Boolean(agent.marketplace_solution_id);
    const blockedPublishSkills = agentBlockedSkillNames(agent);
    return `
      <button class="btn-primary agents-footer-publish-btn agent-publish-btn" type="button" data-agent-id="${escapeHtml(agent.id)}"${blockedPublishSkills.length ? ` disabled title="${escapeHtml(blockedPublishTooltip(blockedPublishSkills))}"` : ""}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
        ${isLinked ? "Save and republish" : "Save and publish"}
      </button>`;
  }

  // Re-render the hero chips + action row (and keep the footer sync checkbox
  // in step) after publish/unpublish changed the marketplace link state
  // (event-driven; called from those flows only).
  function refreshEditorPageMarketplaceState() {
    const editor = state.editor;
    if (!editor?.agentId) return;
    const agent = state.myAgents.find((item) => item?.id === editor.agentId);
    if (!agent) return;
    const chipsEl = editor.root.querySelector("[data-agent-page-chips]");
    if (chipsEl) chipsEl.innerHTML = buildAgentPageChipsHtml(agent);
    const actionsEl = editor.root.querySelector("[data-agent-page-actions]");
    if (actionsEl) actionsEl.innerHTML = buildAgentPageActionsHtml(agent, editor.mode);
    // The footer combo button mirrors the header label (Publish ↔ Republish
    // flips with the link state).
    const footerPublishBtn = editor.root.querySelector(".agents-footer-publish-btn");
    if (footerPublishBtn) {
      footerPublishBtn.outerHTML = buildAgentFooterPublishButtonHtml(agent);
    }
    // Saves are strictly local (no sync opt-in in the footer); link-state
    // changes only affect the chips and header actions refreshed above.
  }

  // Shared helpers for the async read-only pages: the page opens immediately
  // with a loading body, then swaps in the real content once data lands —
  // guarded against the user having navigated away in the meantime.
  function setAgentPageTitle(root, title, copyValue = "") {
    const titleEl = root.querySelector(".agent-editor-page h1");
    if (titleEl) titleEl.textContent = title || "Agent details";
    // The copy button is a SIBLING of the h1 (textContent swaps above would
    // wipe a child); refresh its value once the real name lands.
    const copyHost = root.querySelector("[data-agent-title-copy]");
    if (copyHost) {
      copyHost.innerHTML = copyValue ? copyButtonHtml(copyValue, "Agent name") : "";
    }
  }

  function setAgentPageContent(root, html) {
    const contentEl = root.querySelector("[data-agent-editor-content]");
    if (contentEl) contentEl.innerHTML = html;
  }

  function buildAgentPageFailureHtml(error) {
    return `
      <div class="mcp-no-results">
        <p>Failed to load agent details.</p>
        <p style="font-size: 0.75rem; color: var(--text-tertiary);">${escapeHtml(error.message || String(error))}</p>
      </div>
    `;
  }

  // Read-only page for a locally installed agent the user does not own
  // (installed from the AI Marketplace).
  async function openViewAgentPage(agentId) {
    const preview = state.myAgents.find((item) => item.id === agentId) || null;
    const root = openAgentEditor({
      mode: "view",
      title: preview?.name || "Agent details",
      headerSubtitle: "",
      bodyHtml: '<div class="agents-form-loading">Loading agent details...</div>',
      cancelLabel: "Close",
      subjectName: preview?.name || "this agent",
      agentId,
      titleCopyValue: preview?.name || "",
      headerActionsHtml: buildAgentPageActionsHtml(preview, "view"),
    });
    if (!root) return;
    // The host element is reused across sessions, so staleness must be judged
    // by the per-open session object, never by the root element.
    const session = state.editor;
    try {
      const [catalogs, details] = await Promise.all([
        loadCatalogs(),
        loadInstalledAgentDetails(agentId),
      ]);
      if (state.editor !== session) return;
      setAgentPageTitle(root, details.title, details.agent?.name || "");
      setAgentPageContent(
        root,
        buildInstalledAgentViewHtml(details.agent, catalogs, details.notice),
      );
      // The preview record used at open time may have been missing or stale.
      const actionsEl = root.querySelector("[data-agent-page-actions]");
      if (actionsEl) {
        actionsEl.innerHTML = buildAgentPageActionsHtml(details.agent, "view");
      }
      const chipsEl = root.querySelector("[data-agent-page-chips]");
      if (chipsEl) chipsEl.innerHTML = buildAgentPageChipsHtml(details.agent);
      // Fire-and-forget: resolve per-skill freshness and stamp the table's
      // status cells once the shared snapshot lands (spinner until then).
      void applyAgentViewSkillStatuses(root, session);
    } catch (error) {
      if (state.editor !== session) return;
      setAgentPageContent(root, buildAgentPageFailureHtml(error));
    }
  }

  // Read-only page for a marketplace listing (Discover tab); Install is the
  // footer primary action.
  async function openDiscoverAgentPage(solutionId) {
    const preview =
      state.discoverResults.find((item) => item.id === solutionId) || null;
    const root = openAgentEditor({
      mode: "view",
      title: preview?.name || "Agent details",
      headerSubtitle: "From the AI Marketplace. Install it to use it from chat.",
      bodyHtml: '<div class="agents-form-loading">Loading agent details...</div>',
      cancelLabel: "Close",
      submitLabel: INSTALL_LABELS[preview?.type] || "Install",
      submitBusyLabel: "Installing...",
      subjectName: preview?.name || "this agent",
      titleCopyValue: preview?.name || "",
      onSubmit: async (editorRoot, submitBtn) => {
        // Agent installs continue in the provenance modal stacked above this
        // page; the page tears down only once the install actually lands
        // (the install flow switches to the Installed tab and reloads).
        const opened = await installSolution(solutionId, submitBtn, {
          onInstalled: () => teardownAgentEditor(),
        });
        if (!opened) {
          setModalError(
            editorRoot,
            "Install failed. Check the notification for details and try again.",
          );
        }
      },
    });
    if (!root) return;
    // Judge staleness by the per-open session object (the host is reused).
    const session = state.editor;
    const submitBtn = root.querySelector(".agents-modal-submit");
    try {
      const [catalogs, details] = await Promise.all([
        loadCatalogs(),
        loadDiscoverAgentDetails(solutionId),
      ]);
      if (state.editor !== session) return;
      setAgentPageTitle(root, details.title, details.solution?.name || "");
      setAgentPageContent(
        root,
        buildDiscoverAgentViewHtml(details.solution, catalogs, details.notice),
      );
      // Same async status resolve as the installed view: locally-present
      // skills tick green/update, missing ones stay "—".
      void applyAgentViewSkillStatuses(root, session);
      if (submitBtn) {
        if (details.installLabel) submitBtn.textContent = details.installLabel;
        if (!details.installable) {
          submitBtn.disabled = true;
          submitBtn.title = "No bundle attached";
        }
      }
    } catch (error) {
      if (state.editor !== session) return;
      setAgentPageContent(root, buildAgentPageFailureHtml(error));
      if (submitBtn) submitBtn.disabled = true;
    }
  }

  async function refreshMarketplaceLinks({ pruneMissingAgents = false } = {}) {
    try {
      const res = await window.electronAPI?.aiMarketplace?.listLinks();
      state.marketplaceLinks = res?.success ? res.links || {} : {};
      if (pruneMissingAgents && Object.keys(state.marketplaceLinks).length) {
        try {
          const agentsRes = await callSubagent(TOOL_LIST, {});
          await pruneMarketplaceLinksToExistingAgents(agentIdsFromListResponse(agentsRes));
        } catch (error) {
          console.warn("[Agents] failed to prune stale marketplace links", error);
        }
      }
    } catch (error) {
      console.warn("[Agents] failed to load marketplace links", error);
      state.marketplaceLinks = {};
    }
  }

  async function repairLinkedAgentAccess(reason) {
    const api = window.electronAPI?.aiMarketplace;
    if (typeof api?.repairLinkedAgentAccess !== "function") {
      return null;
    }
    try {
      const res = await api.repairLinkedAgentAccess({ reason });
      console.log("[Agents] linked agent access repair", {
        reason,
        success: Boolean(res?.success),
        checked: res?.result?.checked || 0,
        repaired: res?.result?.repaired || 0,
        repairedAgentIds: res?.result?.repairedAgentIds || [],
      });
      return res?.success ? res.result || null : null;
    } catch (error) {
      console.warn("[Agents] linked agent access repair failed", {
        reason,
        error: error?.message || String(error),
      });
      return null;
    }
  }

  async function loadMyAgents() {
    const list = getList();
    if (!list) return;
    if (state.loading) return;
    state.loading = true;
    // On Discover the grid belongs to runDiscoverSearch — refresh the data
    // silently (facets stay fresh for the next tab switch) without painting
    // a spinner over the marketplace results.
    if (state.mode !== "discover") {
      list.innerHTML = `<div class="mcp-loading"><div class="mcp-loading-spinner"></div><p>Loading agents...</p></div>`;
    }
    try {
      await refreshMarketplaceLinks();
      const repairResult = await repairLinkedAgentAccess("load-my-agents");
      const [agentsRes, , , flagsRes] = await Promise.all([
        callSubagent(TOOL_LIST, {}),
        loadCatalogs(),
        ensureViewerIdentity(),
        // Fail-open: warning glyphs never block the grid.
        window.electronAPI?.listAgentFlags?.().catch(() => null),
      ]);
      state.agentLocalFlags =
        flagsRes?.success && flagsRes.flags && typeof flagsRes.flags === "object"
          ? flagsRes.flags
          : {};
      const data = agentsRes;
      const agentsRaw = Array.isArray(data?.agents) ? data.agents : Array.isArray(data) ? data : [];
      state.myAgents = agentsRaw.map(normalizeAgentRecord).filter(Boolean);
      // System-delivered agents (e.g. the MCP Context Resolver) are internal
      // utility agents and should never appear in the user-facing grid.
      state.myAgents = state.myAgents.filter(
        (agent) => !String(agent.id || "").startsWith(SYSTEM_AGENT_PREFIX),
      );
      const pruneResult = await pruneMarketplaceLinksToExistingAgents(
        agentIdsFromListResponse(data),
      );
      if (pruneResult.pruned) {
        state.myAgents = state.myAgents.map(normalizeAgentRecord).filter(Boolean);
      }
      console.log("[Agents] my agents loaded", {
        rawCount: agentsRaw.length,
        normalizedCount: state.myAgents.length,
        linkedAgentCount: Object.keys(state.marketplaceLinks || {}).length,
        repaired: repairResult?.repaired || 0,
        prunedLinks: pruneResult.pruned,
      });
      renderMyAgents();
      void maybeCheckInstalledAgentFreshness();
    } catch (error) {
      console.warn("[Agents] failed to load my agents", error);
      if (state.myAgents.length) {
        renderMyAgents();
        return;
      }
      if (state.mode !== "discover") {
        list.innerHTML = `
        <div class="mcp-no-results">
          <p>Failed to load agents.</p>
          <p style="font-size: 0.75rem; color: var(--text-tertiary);">${escapeHtml(error.message)}</p>
        </div>
      `;
      }
    } finally {
      state.loading = false;
    }
  }

  // Search contract (all tabs, both Agents and Agent Skills): match the
  // TITLE and the AUTHOR — nothing else. Descriptions and internal ids match
  // too broadly and made results unpredictable.
  function filterAgents(list, query) {
    if (!query) return list;
    const q = query.toLowerCase();
    return list.filter((a) => {
      const author = String(a.created_by_email || "");
      return (
        (a.name || "").toLowerCase().includes(q) ||
        author.toLowerCase().includes(q) ||
        normalizeMarketplaceOwnerIdentity(author).includes(q)
      );
    });
  }

  function agentOwnedByViewer(agent, viewerIdentity) {
    const owner = normalizeMarketplaceOwnerIdentity(agent?.created_by_email || "");
    const viewer = normalizeMarketplaceOwnerIdentity(viewerIdentity);
    return Boolean(owner && viewer) && owner === viewer;
  }

  function agentMarketplaceRelationship(agent) {
    const value = String(agent?.marketplace_relationship || "").trim().toLowerCase();
    return value === "published" || value === "installed" ? value : "unknown";
  }

  function agentPublishedForViewer(agent, viewerIdentity) {
    if (!agent?.marketplace_solution_id) return false;
    const relationship = agentMarketplaceRelationship(agent);
    if (relationship !== "published" && relationship !== "installed") {
      return false;
    }
    const viewer = normalizeMarketplaceOwnerIdentity(viewerIdentity);
    if (!viewer) return false;
    const linkedPublisher = normalizeMarketplaceOwnerIdentity(
      agent?.marketplace_link?.authorIdentity || "",
    );
    if (linkedPublisher) return linkedPublisher === viewer;
    return agentOwnedByViewer(agent, viewer);
  }

  function agentLocallyReadOnly(agent) {
    const relationship = agentMarketplaceRelationship(agent);
    return (
      agent?.is_read_only === true ||
      agent?.creation_source === "marketplace" ||
      relationship === "installed" ||
      (Boolean(agent?.marketplace_solution_id) && relationship === "unknown")
    );
  }

  function agentCanPublish(agent, viewerIdentity) {
    return (
      !agentLocallyReadOnly(agent) &&
      agent?.creation_source === "local" &&
      agentOwnedByViewer(agent, viewerIdentity)
    );
  }

  function agentCanUnpublish(agent, viewerIdentity) {
    return (
      Boolean(agent?.marketplace_solution_id) &&
      agentPublishedForViewer(agent, viewerIdentity)
    );
  }

  // An installed copy of a listing the viewer authored can be promoted into
  // the author-side editable copy (reclaim). Mid-install copies (attribution
  // still pending) are excluded.
  function agentCanReclaim(agent, viewerIdentity) {
    return (
      agentMarketplaceRelationship(agent) === "installed" &&
      agentPublishedForViewer(agent, viewerIdentity) &&
      agent?.marketplace_link?.attributionPending !== true
    );
  }

  function agentStatusBadgesHtml(agent, viewerIdentity) {
    const user =
      agent?.creation_source === "local" &&
      agentOwnedByViewer(agent, viewerIdentity)
        ? '<span class="mcp-card-badge badge-user">User</span>'
        : "";
    const installed =
      agentMarketplaceRelationship(agent) === "installed"
        ? '<span class="mcp-card-badge badge-installed">Installed</span>'
        : "";
    const published = agentCanUnpublish(agent, viewerIdentity)
      ? `<span class="mcp-card-badge badge-published" title="Viewer-owned AI Marketplace solution ${escapeHtml(agent.marketplace_solution_id)}">Published</span>`
      : "";
    const updateAvailable = agentUpdateBadgeHtml(agent);
    // Same ordering as the facet filters: User, Published, Installed.
    return `${user}${published}${installed}${updateAvailable}`;
  }

  // "Update available" badge composed from two independent signals: the
  // agent's own marketplace listing moved ahead (installed copies), or any
  // skill this agent uses has a marketplace update/conflict (any agent).
  function agentUpdateBadgeHtml(agent) {
    const listingStale = agentUpdateAvailable(agent);
    const skillsStale = agentHasSkillUpdates(agent);
    if (!listingStale && !skillsStale) return "";
    const title = listingStale
      ? "The marketplace listing changed since this copy was installed"
      : agentMarketplaceRelationship(agent) === "installed"
        ? "One or more skills used by this agent have marketplace updates available"
        : "One or more skills used by this agent have marketplace updates available. Update them from the Skills tab or Sync All.";
    return `<span class="mcp-card-badge badge-has-updates" title="${escapeHtml(title)}">Update available</span>`;
  }

  // Subtle per-card spinner while this agent's skill freshness is unknown
  // (shared snapshot fetch pending). Renders nothing once resolved.
  function agentFreshnessSpinnerHtml(agent) {
    if (!Array.isArray(agent?.skill_ids) || agent.skill_ids.length === 0) return "";
    const entry = agentSkillFreshnessFor(agent);
    if (entry) return "";
    return '<span class="agent-card-freshness-spinner" title="Checking for skill updates" aria-hidden="true"></span>';
  }

  // All applicable badges for a Discover listing card — facet-independent:
  // when the listing is linked to a local copy, render the SAME badge set the
  // Agents-tab card shows (User/Published/Installed/Unpublished/Update, in
  // filter order); otherwise fall back to the link relationship, then to
  // listing ownership alone.
  function discoverAgentCardBadgesHtml(installedAgentId, isOwner) {
    const localAgent = installedAgentId
      ? state.myAgents.find((item) => String(item?.id) === String(installedAgentId)) || null
      : null;
    if (localAgent) {
      const statusBadges = agentStatusBadgesHtml(localAgent, state.viewerIdentity);
      const unpublished =
        agentCanPublish(localAgent, state.viewerIdentity) &&
        Boolean(localAgent.marketplace_solution_id) &&
        localAgent.has_unpublished_changes
          ? `<span class="mcp-card-badge badge-unpublished" title="Local edits not yet published to the marketplace">Unpublished changes</span>`
          : "";
      return `${statusBadges}${unpublished}`;
    }
    const link = installedAgentId ? state.marketplaceLinks?.[installedAgentId] : null;
    if (link) {
      return link.relationship === "published"
        ? '<span class="mcp-card-badge badge-user">User</span><span class="mcp-card-badge badge-published">Published</span>'
        : `<span class="mcp-card-badge badge-installed" title="Already installed as ${escapeHtml(installedAgentId)}">Installed</span>`;
    }
    if (isOwner) {
      return '<span class="mcp-card-badge badge-published" title="You published this listing">Published</span>';
    }
    return "";
  }

  // Relationship records describe how the local copy arrived. A viewer who
  // installs their own published listing therefore belongs to both facets.
  function filterAgentsForMode(list, mode, viewerIdentity) {
    switch (mode) {
      case "user":
        return list.filter(
          (agent) =>
            agent?.creation_source === "local" &&
            !agentLocallyReadOnly(agent) &&
            agentOwnedByViewer(agent, viewerIdentity),
        );
      case "published":
        return list.filter((agent) => agentPublishedForViewer(agent, viewerIdentity));
      case "marketplace":
        return list.filter(
          (agent) => agentMarketplaceRelationship(agent) === "installed",
        );
      default:
        return list;
    }
  }

  // Close any open agent-card ellipsis menu and restore it to its original
  // parent if it was moved to <body> for fixed positioning.
  function closeAllAgentDropdowns() {
    hideAgentCardTooltip();
    document
      .querySelectorAll(`#${cfg.listId} .mcp-card-dropdown.visible, body > .mcp-card-dropdown.visible[data-dropdown-owner="${cfg.key}"]`)
      .forEach((dropdown) => {
        dropdown.classList.remove("visible");
        dropdown.classList.remove("open-upward");
        const original = dropdown._originalParent;
        if (original && dropdown.parentElement === document.body) {
          original.appendChild(dropdown);
        }
        // Stale fixed coords on the hidden box get re-based into the card by
        // hover transforms and widen the scroll host.
        dropdown.style.top = "";
        dropdown.style.left = "";
      });
  }

  // Outside-click closer (registered once at init below).
  function handleAgentDropdownOutsideClick(event) {
    if (
      !event.target.closest(".agent-card-menu-wrapper") &&
      !event.target.closest('.mcp-card-dropdown[data-dropdown-agent-id], .mcp-card-dropdown[data-dropdown-solution-id]') &&
      // Info-tooltip triggers toggle the shared floating tooltip from their
      // own document-level handler; the closer must not hide it in the same
      // click (document-level listeners all fire regardless of ordering).
      !event.target.closest(".info-tooltip-trigger")
    ) {
      closeAllAgentDropdowns();
    }
  }

  function wireAgentCardMenus() {
    const list = getList();
    if (!list) return;
    list.querySelectorAll(".mcp-card-menu-trigger[data-menu-agent-id], .mcp-card-menu-trigger[data-menu-solution-id]").forEach((trigger) => {
      trigger.addEventListener("click", (event) => {
        event.stopPropagation();
        const wrapper = trigger.parentElement;
        const dropdown = wrapper?.querySelector(".mcp-card-dropdown");
        const wasOpen = dropdown?.classList.contains("visible");

        closeAllAgentDropdowns();
        if (wasOpen || !dropdown) return;

        // Move to body to escape card overflow clipping, then position with
        // fixed coordinates. Mirrors the agent-skills.js implementation.
        dropdown._originalParent = wrapper;
        document.body.appendChild(dropdown);

        const btnRect = trigger.getBoundingClientRect();
        dropdown.style.visibility = "hidden";
        dropdown.style.display = "block";
        const dropdownWidth = dropdown.offsetWidth;
        const dropdownHeight = dropdown.offsetHeight;
        dropdown.style.visibility = "";
        dropdown.style.display = "";

        // Open below the ellipsis and extend to its right (matches the
        // Integrations tab). Viewport clamps below are the only reason a
        // menu should shift leftward.
        let left = btnRect.left;
        let top = btnRect.bottom + 4;
        let openUpward = false;
        if (top + dropdownHeight > window.innerHeight - 8) {
          top = btnRect.top - dropdownHeight - 4;
          openUpward = true;
        }
        if (openUpward && top < 8) top = 8;
        if (left < 8) left = 8;
        if (left + dropdownWidth > window.innerWidth - 8) {
          left = window.innerWidth - dropdownWidth - 8;
        }
        dropdown.style.top = `${top}px`;
        dropdown.style.left = `${left}px`;
        dropdown.classList.toggle("open-upward", openUpward);
        dropdown.classList.add("visible");
      });
    });
  }

  // Route a My Agents card to the right inline page: owners (and unlinked
  // local agents) edit; agents installed from someone else's marketplace
  // listing open read-only. When ownership of a linked agent cannot be
  // confirmed, fall to read-only rather than risking edits to a copy.
  async function openAgentPageForCard(agentId) {
    const agent = state.myAgents.find((item) => item?.id === agentId);
    if (agentLocallyReadOnly(agent)) {
      void openViewAgentPage(agentId);
      return;
    }
    // Unlinked local agents are always editable — skip the identity IPC.
    if (!agent?.marketplace_solution_id) {
      void openEditAgentEditor(agentId);
      return;
    }
    const creatorIdentity = normalizeMarketplaceOwnerIdentity(
      agentMarketplaceRelationship(agent) === "published"
        ? agent?.marketplace_link?.authorIdentity || agent?.created_by_email || ""
        : agent?.created_by_email || "",
    );
    const viewerIdentity = await resolveCurrentMarketplaceOwnerIdentity();
    const isOwner =
      Boolean(creatorIdentity && viewerIdentity) && creatorIdentity === viewerIdentity;
    if (isOwner) {
      void openEditAgentEditor(agentId);
    } else {
      void openViewAgentPage(agentId);
    }
  }

  function wireAgentCardDetails() {
    const list = getList();
    if (!list) return;
    list.querySelectorAll(".agent-card").forEach((card) => {
      if (!(card instanceof HTMLElement)) return;
      card.classList.add("agent-card-clickable");
      card.setAttribute("role", "button");
      card.setAttribute("tabindex", "0");
      const openDetails = async () => {
        const agentId = card.dataset.agentId || "";
        const solutionId = card.dataset.solutionId || "";
        if (agentId) {
          await openAgentPageForCard(agentId);
        } else if (solutionId) {
          void openDiscoverAgentPage(solutionId);
        }
      };
      card.addEventListener("click", (event) => {
        if (
          event.target.closest("button") ||
          event.target.closest(".mcp-card-menu-wrapper") ||
          event.target.closest(".mcp-card-dropdown")
        ) {
          return;
        }
        void openDetails();
      });
      card.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        if (event.target.closest("button")) return;
        event.preventDefault();
        void openDetails();
      });
    });
  }

  // Logo + display name + tier sparkle for an agent's base model, matching how
  // models read elsewhere (model picker). Falls back to the raw id label if the
  // model isn't in the catalog yet.
  function agentModelChipHtml(agent, catalogs = state.catalogs) {
    const id = agent?.base_model_id || "";
    if (!id) return `<span class="agent-model-identity"><span class="agent-model-identity-name">—</span></span>`;
    const model = (catalogs?.baseModels || []).find((m) => m.id === id);
    if (model && agentModelPickerApi.buildModelIdentityHtml) {
      return agentModelPickerApi.buildModelIdentityHtml(model, { withTier: true });
    }
    return `<span class="agent-model-identity"><span class="agent-model-identity-name">${escapeHtml(displayNameFromId(id))}</span></span>`;
  }

  function agentReasoningChipHtml(agent) {
    if (!agent?.reasoning_effort) return "";
    return agentReasoningSliderApi.buildReasoningBadgeHtml
      ? agentReasoningSliderApi.buildReasoningBadgeHtml(agent.reasoning_effort)
      : "";
  }

  // Author badge, styled like the skill-card author badge (unified tokens).
  function agentAuthorBadgeHtml(agent) {
    // Username format everywhere: local creates stamp a full email while
    // marketplace installs stamp the bare handle — normalize both.
    const author =
      normalizeMarketplaceOwnerIdentity(agent?.created_by_email || "") ||
      String(agent?.created_by_email || "").trim() ||
      "Unknown";
    return `<span class="mcp-card-badge badge-author" title="${escapeHtml(author)}">${escapeHtml(author)}</span>`;
  }

  function renderMyAgents() {
    const list = getList();
    if (!list) return;
    // On Discover the grid belongs to runDiscoverSearch: my-agents has no
    // facet there, and filterAgentsForMode's default returns EVERYTHING — a
    // late load completing after a quick User→Discover switch would paint
    // the whole local list over the marketplace results. Same stale-render
    // discipline as enrichDiscoverBundles' seq + mode check.
    if (state.mode === "discover") return;
    closeAllAgentDropdowns();
    const modeFiltered = filterAgentsForMode(state.myAgents, state.mode, state.viewerIdentity);
    const filtered = filterAgents(modeFiltered, state.searchQuery);
    if (filtered.length === 0) {
      const emptyMessage =
        state.myAgents.length === 0
          ? "No agents yet."
          : modeFiltered.length === 0
            ? "No agents match this filter."
            : "No agents match your search.";
      list.innerHTML = `
        <div class="mcp-no-results">
          <p>${emptyMessage}</p>
          ${state.myAgents.length === 0 ? '<p style="font-size: 0.75rem; color: var(--text-tertiary);">Click <strong>New Agent</strong> to create one.</p>' : ""}
        </div>
      `;
      return;
    }

    list.innerHTML = filtered
      .map((agent) => buildAgentCardHtml(agent))
      .join("");
    wireAgentCardMenus();
    wireAgentCardDetails();
    // Fire-and-forget: refresh the shared skills-freshness snapshot when its
    // TTL lapsed and re-render once when it lands (cards show a subtle
    // spinner chip until then). Render-path only — never on a timer.
    ensureAgentSkillFreshnessScan();
  }

  // The agent card, extracted so other surfaces (the AI Marketplace publish
  // confirmation modal) render the EXACT card the Agents tab shows.
  // `interactive: false` drops the kebab menu, the skills hover-link, and the
  // Chat action — presentation-only, same header/model/effort/author/tools.
  // Local warning flags for one agent (SKILLS_NOT_FOUND today). Display-only
  // local state written by the destructive marketplace sync / relink sweep;
  // deliberately NOT consulted by stale/dirty/unpublished computations.
  function agentLocalFlagEntries(agent) {
    const flags = state.agentLocalFlags?.[agent?.id];
    return Array.isArray(flags) ? flags : [];
  }

  function agentFlaggedSkillLeaves(agent) {
    const leaves = new Set();
    for (const flag of agentLocalFlagEntries(agent)) {
      if (flag?.type !== "SKILLS_NOT_FOUND") continue;
      for (const id of Array.isArray(flag.skills) ? flag.skills : []) {
        const leaf = canonicalSkillName(String(id || ""));
        if (leaf) leaves.add(leaf);
      }
    }
    return leaves;
  }

  function agentWarningsSummary(agent) {
    const leaves = agentFlaggedSkillLeaves(agent);
    if (!leaves.size) return "";
    const plural = leaves.size !== 1;
    return `${leaves.size} skill${plural ? "s" : ""} this agent uses ${plural ? "are" : "is"} no longer available on this computer (removed after ${plural ? "their sources" : "its source"} left the marketplace). The agent's owner resolves this by republishing a corrected agent.`;
  }

  function agentWarningBadgeHtml(agent) {
    const summary = agentWarningsSummary(agent);
    if (!summary) return "";
    return `<span class="mcp-card-badge badge-agent-warning" title="${escapeHtml(summary)}">⚠ Warnings</span>`;
  }

  function buildAgentCardHtml(
    agent,
    { interactive = true, viewerIdentity = state.viewerIdentity } = {},
  ) {
    const skillsRowHtml = interactive
      ? buildAgentSkillsLinkHtml(agent.id, agent.skill_ids)
      : (() => {
          const count = getAgentSkillDetails(agent.skill_ids, state.catalogs).length;
          return count
            ? `<div class="agent-card-row"><strong>Skills:</strong> <span>${count} ${count === 1 ? "skill" : "skills"}</span></div>`
            : "";
        })();
    const serverIconChips = (agent.tool_server_ids || [])
      .map((id) => renderAgentToolServerIcon(id))
      .join("");
    const isLinked = Boolean(agent.marketplace_solution_id);
    const statusBadges = agentStatusBadgesHtml(agent, viewerIdentity);
    const warningBadge = agentWarningBadgeHtml(agent);
    const freshnessSpinner = interactive ? agentFreshnessSpinnerHtml(agent) : "";
    const unpublishedBadge =
      agentCanPublish(agent, viewerIdentity) &&
      isLinked &&
      agent.has_unpublished_changes
        ? `<span class="mcp-card-badge badge-unpublished" title="Local edits not yet published to the marketplace">Unpublished changes</span>`
        : "";
    const publishLabel = isLinked ? "Republish" : "Publish";
    const canPublish = agentCanPublish(agent, viewerIdentity);
    const canUnpublish = agentCanUnpublish(agent, viewerIdentity);
    const readOnly = agentLocallyReadOnly(agent);
    const unpublishMenuItem = canUnpublish
      ? `
          <button class="mcp-dropdown-item agent-unpublish-btn" data-agent-id="${escapeHtml(agent.id)}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14"></path><path d="M19 12l-7 7-7-7"></path></svg>
            Unpublish
          </button>`
      : "";
    const blockedPublishSkills = canPublish ? agentBlockedSkillNames(agent) : [];
    const publishMenuItem = canPublish
      ? `
                  <button class="mcp-dropdown-item agent-publish-btn" data-agent-id="${escapeHtml(agent.id)}"${blockedPublishSkills.length ? ` disabled title="${escapeHtml(blockedPublishTooltip(blockedPublishSkills))}"` : ""}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
                    ${escapeHtml(publishLabel)}
                  </button>`
      : "";
    const reclaimMenuItem = agentCanReclaim(agent, viewerIdentity)
      ? `
                  <button class="mcp-dropdown-item agent-reclaim-btn" data-agent-id="${escapeHtml(agent.id)}">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 9.9-1"></path></svg>
                    Convert to editable copy
                  </button>`
      : "";
    // Every installed copy gets the manual update action — detection only
    // drives the badge/tint. The update flow is an idempotent in-place
    // refresh ("Everything is already up to date." when current), so a
    // stale or never-run freshness sweep must not leave users with no way
    // to update (2026-08-04 incident).
    const updateMenuItem =
      agentMarketplaceRelationship(agent) === "installed"
        ? `
                  <button class="mcp-dropdown-item agent-update-btn" data-agent-id="${escapeHtml(agent.id)}">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-2.64-6.36"></path><polyline points="21 3 21 9 15 9"></polyline></svg>
                    Update from marketplace
                  </button>`
        : "";
    const primaryMenuItem = readOnly
      ? `
                  <button class="mcp-dropdown-item agent-details-btn" data-agent-id="${escapeHtml(agent.id)}">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                    Details
                  </button>`
      : `
                  <button class="mcp-dropdown-item agent-edit-btn" data-agent-id="${escapeHtml(agent.id)}">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                    Edit
                  </button>`;
    const menuHtml = interactive
      ? `
              <div class="mcp-card-menu-wrapper agent-card-menu-wrapper">
                <button class="mcp-card-menu-trigger" data-menu-agent-id="${escapeHtml(agent.id)}" aria-label="Agent options" type="button">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="12" cy="5" r="2"></circle>
                    <circle cx="12" cy="12" r="2"></circle>
                    <circle cx="12" cy="19" r="2"></circle>
                  </svg>
                </button>
                <div class="mcp-card-dropdown" data-dropdown-agent-id="${escapeHtml(agent.id)}" data-dropdown-owner="${escapeHtml(cfg.key)}">
                  ${primaryMenuItem}
                  <button class="mcp-dropdown-item agent-clone-btn" data-agent-id="${escapeHtml(agent.id)}">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                    Duplicate
                  </button>
                  ${updateMenuItem}
                  ${reclaimMenuItem}
                  ${publishMenuItem}
                  ${unpublishMenuItem}
                  <button class="mcp-dropdown-item agent-delete-btn delete-action" data-agent-id="${escapeHtml(agent.id)}">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
                    Delete
                  </button>
                </div>
              </div>`
      : "";
    const actionsHtml = interactive
      ? `
            <div class="agent-card-actions">
              <button class="btn-primary agent-use-btn" data-agent-id="${escapeHtml(agent.id)}" data-agent-name="${escapeHtml(agent.name)}" title="Open a new chat using this agent">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                Chat
              </button>
            </div>`
      : "";
    return `
          <div class="mcp-server-card agent-card${unpublishedBadge ? " has-unpublished-changes" : ""}${agentUpdateAvailable(agent) || agentHasSkillUpdates(agent) ? " update-available" : ""}" data-agent-id="${escapeHtml(agent.id)}">
            <div class="agent-card-header">
              <div class="agent-card-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M12 3v3"></path><rect x="5" y="6" width="14" height="13" rx="4"></rect><path d="M9 11h.01M15 11h.01M9 15h6"></path></svg>
              </div>
              <div class="agent-card-title">
                <strong>${escapeHtml(agent.name)}</strong>
              </div>${menuHtml}
            </div>
            <div class="agent-card-body">
              ${statusBadges || unpublishedBadge || warningBadge || freshnessSpinner ? `<div class="mcp-card-badges agent-card-badges">${statusBadges}${unpublishedBadge}${warningBadge}${freshnessSpinner}</div>` : ""}
              <p class="agent-card-desc">${escapeHtml(truncateForCard(agent.description || "No description", 70))}</p>
              <div class="agent-card-meta">
                <div class="agent-card-model">${agentModelChipHtml(agent)}</div>
                <div class="agent-card-chips">
                  ${agentReasoningChipHtml(agent)}
                  ${agentAuthorBadgeHtml(agent)}
                </div>
              </div>
              ${skillsRowHtml}
              ${serverIconChips ? `<div class="agent-card-row agent-card-tools-row"><strong>Tools:</strong><div class="agent-tool-icon-list">${serverIconChips}</div></div>` : ""}
            </div>${actionsHtml}
          </div>
        `;
  }

  async function runDiscoverSearch() {
    const list = getList();
    if (!list) return;
    state.lastSearchAt = Date.now();
    const searchSeq = ++state.discoverSearchSeq;
    const searchQuery = state.searchQuery;
    const discoverType = state.discoverType;
    list.innerHTML = `<div class="mcp-loading"><div class="mcp-loading-spinner"></div><p>Searching AI Marketplace...</p></div>`;
    try {
      const [result] = await Promise.all([
        window.electronAPI?.aiMarketplace?.search({
          query: searchQuery,
          filters: { type: [discoverType] },
          page: 1,
          pageSize: 100,
        }),
        refreshMarketplaceLinks({ pruneMissingAgents: true }),
        ensureViewerIdentity(),
      ]);
      if (searchSeq !== state.discoverSearchSeq) {
        return;
      }
      if (!result?.success) {
        throw new Error(result?.error || "Search failed");
      }
      let results = Array.isArray(result.data?.results) ? result.data.results : [];
      // The marketplace's relevance ranking returns loose matches; users
      // expect a query to filter on the listing TITLE or the author's ldap.
      // Empty query keeps the ranked browse untouched.
      const q = String(searchQuery || "").trim().toLowerCase();
      if (q) {
        results = results.filter((sol) => {
          const name = String(sol?.name || "").toLowerCase();
          const owner = marketplaceSolutionOwnerIdentity(sol);
          const author = String(sol?.author || "").toLowerCase();
          return name.includes(q) || owner.includes(q) || author.includes(q);
        });
      }
      state.discoverResults = results;
      renderDiscover();
    } catch (error) {
      if (searchSeq !== state.discoverSearchSeq) {
        return;
      }
      list.innerHTML = `
        <div class="mcp-no-results">
          <p>AI Marketplace search failed.</p>
          <p style="font-size: 0.75rem; color: var(--text-tertiary);">${escapeHtml(error.message)}</p>
        </div>
      `;
    }
  }

  // Agent-shaped view of a marketplace solution: prefer the bundle payload
  // (inline, enrichment-cached, or resolved), then fall back to the flattened
  // envelope fields the publish flow writes top-level on the solution.
  function solutionAgentFacts(sol) {
    let payload = marketplaceAgentPayloadFromBundle(getSolutionBundle(sol));
    // An inline bundle can carry an empty payload (trimmed search results);
    // fall through to the enrichment-cached bundle when it says nothing.
    if (!payload.base_model_id && sol?.id) {
      const cachedBundle = state.discoverBundleCache.get(sol.id);
      if (cachedBundle) {
        payload = marketplaceAgentPayloadFromBundle(cachedBundle);
      }
    }
    return {
      base_model_id: payload.base_model_id || sol?.base_model_id || "",
      reasoning_effort: payload.reasoning_effort || sol?.reasoning_effort || "",
      skill_ids: asDisplayIds(payload.skill_ids || sol?.skill_ids, canonicalSkillName),
      tool_server_ids: asDisplayIds(
        payload.tool_server_ids || sol?.tool_server_ids,
        normalizeToolServerId,
      ),
    };
  }

  // Bounded, cached, user-triggered enrichment for search results whose
  // envelope lacks the agent facts: fetch the bundle for up to 24 visible
  // solutions (concurrency 4) and re-render once. No timers, no polling; a
  // failed/empty fetch is cached so it is never retried this session.
  function enrichDiscoverBundles() {
    const seq = state.discoverSearchSeq;
    const candidates = state.discoverResults
      .filter(
        (sol) =>
          sol?.id &&
          !state.discoverBundleCache.has(sol.id) &&
          !solutionAgentFacts(sol).base_model_id &&
          solutionHasInstallableBundle(sol),
      )
      .slice(0, 24);
    if (candidates.length === 0) return;
    candidates.forEach((sol) => state.discoverBundleCache.set(sol.id, null));
    let index = 0;
    let resolvedAny = false;
    const worker = async () => {
      while (index < candidates.length) {
        const sol = candidates[index];
        index += 1;
        try {
          const res = await window.electronAPI?.aiMarketplace?.getBundle?.(sol.id);
          if (res?.success && res.data) {
            state.discoverBundleCache.set(sol.id, res.data);
            resolvedAny = true;
          }
        } catch (error) {
          console.warn("[Agents] discover bundle enrichment failed", sol?.id, error);
        }
      }
    };
    void Promise.all(
      Array.from({ length: Math.min(4, candidates.length) }, worker),
    ).then(() => {
      if (resolvedAny && seq === state.discoverSearchSeq && state.mode === "discover") {
        renderDiscover();
      }
    });
  }

  function renderDiscover() {
    const list = getList();
    if (!list) return;
    if (state.discoverResults.length === 0) {
      list.innerHTML = `
        <div class="mcp-no-results">
          <p>No results.</p>
          <p style="font-size: 0.75rem; color: var(--text-tertiary);">Try a broader query or switch between Agents and Skills.</p>
        </div>
      `;
      return;
    }
    list.innerHTML = state.discoverResults
      .map((sol) => {
        const id = sol.id || "";
        const fullName = sol.name || id;
        const author =
          marketplaceSolutionOwnerIdentity(sol) ||
          normalizeMarketplaceOwnerIdentity(sol.author || "") ||
          String(sol.author || "").trim() ||
          "—";
        const fullDescription = sol.description || "";
        const name = truncateForCard(fullName, 100);
        const description = truncateForCard(fullDescription, 70);
        const facts = solutionAgentFacts(sol);
        const skillsRowHtml = buildSolutionSkillsLinkHtml(id, facts.skill_ids);
        const serverIconChips = facts.tool_server_ids
          .map((toolServerId) => renderAgentToolServerIcon(toolServerId))
          .join("");
        const hasBundle = solutionHasInstallableBundle(sol);
        const installedAgentId = findLinkedAgentIdForSolution(id, state.marketplaceLinks);
        const isInstalled = Boolean(installedAgentId);
        const isOwner =
          Boolean(state.viewerIdentity) &&
          marketplaceSolutionOwnerIdentity(sol) === state.viewerIdentity;
        const discoverBadges = discoverAgentCardBadgesHtml(installedAgentId, isOwner);
        const installLabel = isInstalled
          ? "Installed"
          : INSTALL_LABELS[sol.type] || "Install";
        const installDisabled = !hasBundle || isInstalled;
        const installTitle = isInstalled
          ? `Already installed as ${installedAgentId}`
          : hasBundle
            ? ""
            : "No bundle attached";
        return `
          <div class="mcp-server-card agent-card" data-solution-id="${escapeHtml(id)}">
            <div class="agent-card-header">
              <div class="agent-card-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M12 3v3"></path><rect x="5" y="6" width="14" height="13" rx="4"></rect><path d="M9 11h.01M15 11h.01M9 15h6"></path></svg>
              </div>
              <div class="agent-card-title">
                <strong title="${escapeHtml(fullName)}">${escapeHtml(name)}</strong>
              </div>
              <div class="mcp-card-menu-wrapper agent-card-menu-wrapper">
                <button class="mcp-card-menu-trigger" data-menu-solution-id="${escapeHtml(id)}" aria-label="Solution options" type="button">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="12" cy="5" r="2"></circle>
                    <circle cx="12" cy="12" r="2"></circle>
                    <circle cx="12" cy="19" r="2"></circle>
                  </svg>
                </button>
                <div class="mcp-card-dropdown" data-dropdown-solution-id="${escapeHtml(id)}" data-dropdown-owner="${escapeHtml(cfg.key)}">
                  ${
                    !isInstalled && hasBundle
                      ? `<button class="mcp-dropdown-item agent-install-btn" data-solution-id="${escapeHtml(id)}">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                          ${escapeHtml(INSTALL_LABELS[sol.type] || "Install")}
                        </button>`
                      : ""
                  }
                  ${
                    isInstalled
                      ? `<button class="mcp-dropdown-item solution-uninstall-btn delete-action" data-solution-id="${escapeHtml(id)}">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                          Uninstall
                        </button>`
                      : ""
                  }
                  ${
                    isOwner
                      ? `<button class="mcp-dropdown-item solution-unpublish-btn" data-solution-id="${escapeHtml(id)}">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14"></path><path d="M19 12l-7 7-7-7"></path></svg>
                          Unpublish
                        </button>`
                      : ""
                  }
                </div>
              </div>
            </div>
            <div class="agent-card-body">
              ${discoverBadges ? `<div class="mcp-card-badges agent-card-badges">${discoverBadges}</div>` : ""}
              <p class="agent-card-desc" title="${escapeHtml(fullDescription)}">${escapeHtml(description)}</p>
              <div class="agent-card-meta">
                ${facts.base_model_id ? `<div class="agent-card-model">${agentModelChipHtml(facts)}</div>` : ""}
                <div class="agent-card-chips">
                  ${agentReasoningChipHtml(facts)}
                  <span class="mcp-card-badge badge-author" title="${escapeHtml(author)}">${escapeHtml(author)}</span>
                </div>
              </div>
              ${skillsRowHtml}
              ${serverIconChips ? `<div class="agent-card-row agent-card-tools-row"><strong>Tools:</strong><div class="agent-tool-icon-list">${serverIconChips}</div></div>` : ""}
            </div>
            <div class="agent-card-actions">
              <button class="btn-primary agent-install-btn" data-solution-id="${escapeHtml(id)}" ${installDisabled ? "disabled" : ""} ${installTitle ? `title="${escapeHtml(installTitle)}"` : ""}>${escapeHtml(installLabel)}</button>
            </div>
          </div>
        `;
      })
      .join("");
    wireAgentCardMenus();
    wireAgentCardDetails();
    enrichDiscoverBundles();
  }

  // ===========================================================================
  // MODALS (simple inline DOM)
  // ===========================================================================

  // Escape handler for the currently open agents modal; added on open,
  // removed on close so it never outlives the overlay.
  let modalEscapeHandler = null;

  function closeModal() {
    if (modalEscapeHandler) {
      document.removeEventListener("keydown", modalEscapeHandler);
      modalEscapeHandler = null;
    }
    const existing = document.getElementById("agents-modal-overlay");
    if (!existing) return;
    existing.querySelectorAll("[data-picker-kind]").forEach((picker) => {
      picker.dispatchEvent(new CustomEvent("agents-picker-detach"));
    });
    existing.querySelectorAll("[data-agent-model-picker]").forEach((picker) => {
      picker.dispatchEvent(new CustomEvent("agent-model-picker-detach"));
    });
    existing.querySelectorAll("[data-agent-reasoning-slider]").forEach((slider) => {
      slider.dispatchEvent(new CustomEvent("agent-reasoning-slider-detach"));
    });
    existing.remove();
  }

  function setModalError(overlay, message = "") {
    const errorEl = overlay?.querySelector(".agents-modal-error");
    if (!errorEl) return;
    const text = String(message || "").trim();
    errorEl.textContent = text;
    errorEl.hidden = !text;
  }

  function openModal(
    title,
    bodyHtml,
    {
      onSubmit,
      submitLabel = "Save",
      submitBusyLabel = `${submitLabel}...`,
      cancelLabel = "Cancel",
      footerLeftHtml = "",
      modalClassName = "",
      headerEyebrow = "",
      headerSubtitle = "",
      headerIcon = false,
      // Backend-flow chrome: an eye button that lets the user stow the modal
      // and return to chat (returned un-wired — the caller owns hide
      // semantics), and a callback fired on every USER dismissal (Escape, ×,
      // Cancel, backdrop) so pending approval flows can be denied. A
      // programmatic closeModal() never fires onDismiss.
      headerHideButton = false,
      onDismiss = null,
    } = {},
  ) {
    closeModal();
    const overlay = document.createElement("div");
    overlay.id = "agents-modal-overlay";
    overlay.className = "agents-modal-overlay";
    overlay.dataset.pointerDownOnBackdrop = "false";
    const safeModalClassName = String(modalClassName || "")
      .replace(/[^a-zA-Z0-9_-\s]/g, "")
      .trim();
    const hasEnhancedHeader = Boolean(headerEyebrow || headerSubtitle || headerIcon);
    const headerContent = hasEnhancedHeader
      ? `
        <div class="agents-modal-heading">
          ${
            headerIcon
              ? `<div class="agents-modal-heading-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24"><path d="M12 3v3"></path><rect x="5" y="6" width="14" height="13" rx="4"></rect><path d="M9 11h.01M15 11h.01M9 15h6"></path></svg>
                </div>`
              : ""
          }
          <div class="agents-modal-heading-copy">
            ${headerEyebrow ? `<div class="agents-modal-eyebrow">${escapeHtml(headerEyebrow)}</div>` : ""}
            <h2>${escapeHtml(title)}</h2>
            ${headerSubtitle ? `<p>${escapeHtml(headerSubtitle)}</p>` : ""}
          </div>
        </div>`
      : `<h2>${escapeHtml(title)}</h2>`;
    overlay.innerHTML = `
      <div class="agents-modal${safeModalClassName ? ` ${safeModalClassName}` : ""}">
        <div class="agents-modal-header">
          ${headerContent}
          <div class="agents-modal-header-actions">
            ${
              headerHideButton
                ? `<button class="agents-modal-hide" type="button" title="Hide and return to chat" aria-label="Hide publish approval and return to chat">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                  </button>`
                : ""
            }
            <button class="agents-modal-close" type="button" aria-label="Close">&times;</button>
          </div>
        </div>
        <div class="agents-modal-body">${bodyHtml}</div>
        <div class="agents-modal-footer">
          ${footerLeftHtml}
          <div class="agents-modal-error" role="alert" hidden style="margin-right: auto; color: var(--danger, #d14343); font-size: 0.82rem;"></div>
          <button class="btn-secondary agents-modal-cancel" type="button">${escapeHtml(cancelLabel)}</button>
          ${onSubmit ? `<button class="btn-primary agents-modal-submit" type="button">${escapeHtml(submitLabel)}</button>` : ""}
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const dismiss = () => {
      closeModal();
      if (typeof onDismiss === "function") {
        try {
          onDismiss();
        } catch {
          /* dismissal callbacks must never break teardown */
        }
      }
    };
    modalEscapeHandler = (event) => {
      if (event.key !== "Escape") return;
      if (overlay.dataset.busy === "true") return;
      dismiss();
    };
    document.addEventListener("keydown", modalEscapeHandler);
    overlay.querySelector(".agents-modal-close")?.addEventListener("click", () => {
      if (overlay.dataset.busy === "true") return;
      dismiss();
    });
    overlay.querySelector(".agents-modal-cancel")?.addEventListener("click", () => {
      if (overlay.dataset.busy === "true") return;
      dismiss();
    });
    overlay.addEventListener("pointerdown", (e) => {
      overlay.dataset.pointerDownOnBackdrop = e.target === overlay ? "true" : "false";
    });
    overlay.addEventListener("click", (e) => {
      if (overlay.dataset.busy === "true") return;
      if (e.target === overlay && overlay.dataset.pointerDownOnBackdrop === "true") {
        dismiss();
      }
      overlay.dataset.pointerDownOnBackdrop = "false";
    });
    if (onSubmit) {
      overlay
        .querySelector(".agents-modal-submit")
        ?.addEventListener("click", async () => {
          if (overlay.dataset.busy === "true") return;
          const submitBtn = overlay.querySelector(".agents-modal-submit");
          setModalError(overlay);
          setModalBusyState(overlay, true, submitBusyLabel);
          try {
            await onSubmit(overlay, submitBtn);
          } catch (error) {
            setModalError(overlay, error.message || String(error));
            notify(error.message || String(error), "error");
          } finally {
            if (document.getElementById("agents-modal-overlay") === overlay) {
              setModalBusyState(overlay, false, submitBusyLabel);
            }
          }
        });
    }
    return overlay;
  }

  // Build a <select> for a static catalog, preserving the current value even
  // if it's missing from the catalog (e.g. base model was removed).
  function buildSelect(name, options, currentValue, { placeholder } = {}) {
    const current = String(currentValue || "");
    const hasCurrent = current && options.some((opt) => opt.id === current);
    const placeholderOpt = `<option value="">${escapeHtml(placeholder || "Select...")}</option>`;
    const orphanOpt =
      current && !hasCurrent
        ? `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)} (unknown)</option>`
        : "";
    const items = options
      .map(
        (opt) => {
          const disabledReason = String(opt.disabled_reason || "").trim();
          const disabled = opt.disabled === true || Boolean(disabledReason);
          const label = disabled
            ? `${opt.display_name} (disabled${disabledReason ? `: ${disabledReason}` : ""})`
            : opt.display_name;
          return `<option value="${escapeHtml(opt.id)}" ${opt.id === current ? "selected" : ""} ${disabled ? "disabled" : ""} ${disabledReason ? `title="${escapeHtml(disabledReason)}" data-disabled-reason="${escapeHtml(disabledReason)}"` : ""}>${escapeHtml(label)}</option>`;
        },
      )
      .join("");
    return `
      <select name="${escapeHtml(name)}" required>
        ${placeholderOpt}
        ${orphanOpt}
        ${items}
      </select>
    `;
  }

  // Compact multi-select picker shared by the Agents editor and Ask User
  // Question. It mirrors the scheduled-tasks integration picker: one summary
  // control opens a bounded capability browser instead of growing the form
  // with a separate chip list.
  function buildPicker({ kind, label, addButtonLabel, options, selectedIds }) {
    const selected = Array.from(new Set((selectedIds || []).filter(Boolean)));
    return `
      <div class="agents-picker" data-picker-kind="${escapeHtml(kind)}" data-selected='${escapeHtml(JSON.stringify(selected))}'>
        <div class="agents-picker-header">
          <span class="agents-picker-label">${escapeHtml(label)}</span>
        </div>
        <button type="button" class="agents-picker-toggle" data-picker-toggle aria-haspopup="dialog" aria-expanded="false">
          ${renderPickerSummary(selected, options, kind, addButtonLabel)}
        </button>
      </div>
    `;
  }

  function renderPickerIcon(opt, kind) {
    const fallback = opt?.icon_initial || (kind === "skills" ? "S" : "M");
    const variant = kind === "skills" ? "skill" : "server";
    if (opt?.icon_url) {
      return `<span class="agents-picker-icon agents-picker-icon-${variant}"><img src="${escapeHtml(opt.icon_url)}" alt="" /></span>`;
    }
    return `<span class="agents-picker-icon agents-picker-icon-${variant} agents-picker-icon-fallback">${escapeHtml(fallback)}</span>`;
  }

  function renderAgentToolServerIcon(id) {
    const normalizedId = normalizeToolServerId(id);
    if (!normalizedId) return "";
    const opt = catalogOptionFor(normalizedId, state.catalogs.toolServers || []);
    const label = `${opt.display_name} (${normalizedId})`;
    const fallback = opt.icon_initial || opt.display_name.charAt(0).toUpperCase() || "M";
    const icon = opt.icon_url
      ? `<img src="${escapeHtml(opt.icon_url)}" alt="" />`
      : `<span class="agent-tool-icon-fallback">${escapeHtml(fallback)}</span>`;
    return `
      <span
        class="agent-tool-icon-chip"
        role="img"
        aria-label="${escapeHtml(label)}"
        title="${escapeHtml(label)}"
        data-tool-server-id="${escapeHtml(normalizedId)}"
      >${icon}</span>
    `;
  }

  function pickerPresentation(kind) {
    if (kind === "skills") {
      return {
        title: "Choose skills",
        description: "Reusable knowledge and workflows for this agent",
        emptyDescription: "Give this agent reusable knowledge and workflows",
        selectedDescription: "Click to review or change skills",
        searchPlaceholder: "Search skills",
      };
    }
    return {
      title: "Choose MCP servers",
      description: "Connected tools available to this agent",
      emptyDescription: "Give this agent access to connected tools",
      selectedDescription: "Click to review or change access",
      searchPlaceholder: "Search MCP servers",
    };
  }

  function renderPickerSummary(selectedIds, options, kind, addButtonLabel) {
    const selectedOptions = selectedIds.map((id) => catalogOptionFor(id, options));
    const presentation = pickerPresentation(kind);
    const visibleNames = selectedOptions
      .slice(0, 2)
      .map((option) => option.display_name)
      .join(", ");
    const remaining = Math.max(0, selectedOptions.length - 2);
    const title = selectedOptions.length
      ? `${visibleNames}${remaining ? ` +${remaining}` : ""}`
      : addButtonLabel;
    const leading = selectedOptions.length
      ? `<span class="agents-picker-summary-icons" aria-hidden="true">${selectedOptions
          .slice(0, 3)
          .map((option) =>
            renderPickerIcon(option, kind).replace(
              'class="agents-picker-icon',
              'class="agents-picker-icon agents-picker-summary-icon',
            ),
          )
          .join("")}</span>`
      : '<span class="agents-picker-summary-add" aria-hidden="true">+</span>';
    return `
      <span class="agents-picker-summary-main">
        ${leading}
        <span class="agents-picker-summary-copy">
          <span class="agents-picker-summary-title">${escapeHtml(title)}</span>
          <span class="agents-picker-summary-description">${escapeHtml(selectedOptions.length ? presentation.selectedDescription : presentation.emptyDescription)}</span>
        </span>
      </span>
      <span class="agents-picker-count">${selectedOptions.length} selected</span>
      <span class="agents-picker-chevron" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="m6.5 8 3.5 3.5L13.5 8"></path></svg></span>
    `;
  }

  const CAPABILITY_CHECK_SVG = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4.5 10.25 3.25 3.25 7.75-7.75"></path></svg>`;
  const CAPABILITY_SEARCH_SVG = `<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.25"></circle><path d="m12.4 12.4 3.6 3.6"></path></svg>`;

  // Per-kind category filters for the picker popover. Skill sources are
  // system/user/marketplace (shown as Installed); MCP-server sources are
  // core/user/host.
  const PICKER_FILTERS = {
    skills: [
      { key: "all", label: "All" },
      { key: "system", label: "Core" },
      { key: "user", label: "User" },
      { key: "marketplace", label: "Installed" },
    ],
    tool_server_ids: [
      { key: "all", label: "All" },
      { key: "core", label: "Core" },
      { key: "user", label: "User" },
      { key: "host", label: "Host" },
    ],
  };

  // Unified source badge (matches the app-wide Core/User/Host/Installed
  // badges) for a picker row.
  function capabilitySourceBadgeHtml(source) {
    const map = {
      system: ["badge-core", "Core"],
      core: ["badge-core", "Core"],
      user: ["badge-user", "User"],
      marketplace: ["badge-installed", "Installed"],
      host: ["badge-host", "Host"],
    };
    const entry = map[String(source || "").toLowerCase()];
    if (!entry) return "";
    return `<span class="mcp-card-badge ${entry[0]} agent-capability-row-badge">${entry[1]}</span>`;
  }

  function pickerFilterChipsHtml(kind, activeFilter) {
    const filters = PICKER_FILTERS[kind];
    if (!filters) return "";
    return `<div class="agent-capability-filters" role="tablist">${filters
      .map(
        (f) =>
          `<button type="button" class="agent-capability-filter${f.key === activeFilter ? " active" : ""}" data-filter="${f.key}">${escapeHtml(f.label)}</button>`,
      )
      .join("")}</div>`;
  }

  // Multi-select rows for the capability popover: every option renders, with
  // a source badge to the right of the name and a trailing checkmark on the
  // selected ones (model-picker look).
  function renderCapabilityRows(
    options,
    selectedIds,
    query,
    emptyText,
    kind,
    activeFilter = "all",
  ) {
    const selected = new Set(selectedIds);
    const q = (query || "").trim().toLowerCase();
    const filtered = options.filter((opt) => {
      // Non-attachable skills (unapproved marketplace provenance) are hidden
      // from the picker UNLESS already selected — a grandfathered selection
      // stays visible as a removable "Blocked" row but can never be re-added
      // once removed.
      if (opt.agent_attachable === false && !selected.has(opt.id)) {
        return false;
      }
      if (activeFilter && activeFilter !== "all" && opt.source !== activeFilter) {
        return false;
      }
      if (!q) return true;
      return [opt.id, opt.display_name, opt.plugin_name, opt.description, opt.source]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q));
    });
    if (filtered.length === 0) {
      return `<div class="agent-capability-row-empty">${escapeHtml(q ? "No matches" : emptyText || "No options available")}</div>`;
    }
    return filtered
      .map((opt) => {
        const isSelected = selected.has(opt.id);
        const blocked = opt.agent_attachable === false;
        const blockedBadge = blocked
          ? `<span class="mcp-card-badge badge-blocked" title="${escapeHtml(`Comes from the unapproved marketplace "${opt.marketplace_name || opt.marketplace_id || "unknown"}". It can be removed but not re-added.`)}">Blocked</span>`
          : "";
        return `
          <button
            type="button"
            class="agent-capability-row${isSelected ? " is-selected" : ""}${blocked ? " agent-capability-row-blocked" : ""}"
            role="option"
            aria-selected="${isSelected ? "true" : "false"}"
            data-row-id="${escapeHtml(opt.id)}"
          >
            ${renderPickerIcon(opt, kind)}
            <span class="agent-capability-row-main">
              <span class="agent-capability-row-name">${escapeHtml(skillLabelWithPlugin(opt.display_name, opt.plugin_name || ""))}</span>
              ${capabilitySourceBadgeHtml(opt.source)}${blockedBadge}
            </span>
            <span class="agent-capability-row-check">${isSelected ? CAPABILITY_CHECK_SVG : ""}</span>
          </button>
        `;
      })
      .join("");
  }

  // Selected-first row order for the capability popover, computed ONCE per
  // open: already-selected rows surface at the top (keeping their relative
  // catalog order), unselected rows follow in catalog order. The partition is
  // deliberately FROZEN for the life of the open popover — toggling a row
  // must not reshuffle the list under the pointer — and recomputes on the
  // next open.
  function orderCapabilityOptionsForOpen(options, selectedIds) {
    const list = Array.isArray(options) ? options : [];
    const selected = new Set((selectedIds || []).filter(Boolean));
    if (!selected.size) return list;
    const top = [];
    const rest = [];
    for (const opt of list) {
      (selected.has(opt.id) ? top : rest).push(opt);
    }
    if (!top.length) return list;
    return [...top, ...rest];
  }

  // Model-picker-style multi-select popover for the Skills/MCP pickers.
  // Opens UPWARD by default; rows toggle without closing. Selection state
  // stays in container.dataset.selected (readPickerSelection contract).
  function wirePicker(container, options, { emptyText, onChange, refreshOptions } = {}) {
    if (!container) return;
    const kind = container.dataset.pickerKind || "";
    const toggleEl = container.querySelector("[data-picker-toggle]");
    const addButtonLabel = kind === "skills" ? "Add skills" : "Add MCP servers";
    const presentation = pickerPresentation(kind);
    let popover = null;
    let searchValue = "";
    let activeFilter = "all";
    // Row order shown in the popover: selected-first, frozen per open (see
    // orderCapabilityOptionsForOpen).
    let displayOptions = options;

    const getSelected = () => {
      try {
        const parsed = JSON.parse(container.dataset.selected || "[]");
        return Array.isArray(parsed) ? parsed : [];
      } catch (_e) {
        return [];
      }
    };

    const updateRowVisual = (row, isSelected) => {
      row.classList.toggle("is-selected", isSelected);
      row.setAttribute("aria-selected", isSelected ? "true" : "false");
      const check = row.querySelector(".agent-capability-row-check");
      if (check) check.innerHTML = isSelected ? CAPABILITY_CHECK_SVG : "";
    };

    const setSelected = (next) => {
      const uniq = Array.from(new Set(next.filter(Boolean)));
      container.dataset.selected = JSON.stringify(uniq);
      toggleEl.innerHTML = renderPickerSummary(uniq, options, kind, addButtonLabel);
      popover?.querySelectorAll("[data-selected-count]").forEach((count) => {
        count.textContent = `${uniq.length} selected`;
      });
      const selectedSet = new Set(uniq);
      popover?.querySelectorAll("[data-row-id]").forEach((row) => {
        updateRowVisual(row, selectedSet.has(row.getAttribute("data-row-id")));
      });
      // After the dataset/summary contract is fully updated (tests pin it).
      onChange?.(uniq);
    };

    function renderRows() {
      const listEl = popover?.querySelector(".agent-capability-list");
      if (!listEl) return;
      listEl.innerHTML = renderCapabilityRows(
        displayOptions,
        getSelected(),
        searchValue,
        emptyText,
        kind,
        activeFilter,
      );
    }

    function availableRows() {
      return Array.from(popover?.querySelectorAll("[data-row-id]") || []);
    }

    // Prefer opening ABOVE the toggle (the pickers sit in the last form
    // section, right above the footer); flip below only when the space above
    // is clearly worse.
    function positionPopover() {
      if (!popover || !toggleEl.isConnected) return;
      const rect = toggleEl.getBoundingClientRect();
      const viewportWidth = Math.max(320, Number(window.innerWidth || 0));
      const viewportHeight = Math.max(320, Number(window.innerHeight || 0));
      const width = Math.min(Math.max(rect.width, 448), viewportWidth - 32);
      const left = Math.min(Math.max(16, rect.left), viewportWidth - width - 16);
      const spaceAbove = rect.top - 12;
      const spaceBelow = viewportHeight - rect.bottom - 12;
      const openAbove = spaceAbove >= 330 || spaceAbove >= spaceBelow;
      const maxHeight = Math.round(
        Math.min(440, Math.max(240, (openAbove ? spaceAbove : spaceBelow) - 8)),
      );
      popover.style.width = `${Math.round(width)}px`;
      popover.style.maxHeight = `${maxHeight}px`;
      popover.style.left = `${Math.round(left)}px`;
      const height = Math.min(popover.offsetHeight, maxHeight);
      const top = openAbove
        ? Math.max(16, rect.top - height - 8)
        : Math.min(viewportHeight - height - 16, rect.bottom + 8);
      popover.style.top = `${Math.round(top)}px`;
      popover.classList.toggle("opens-above", openAbove);
    }

    function onDocumentPointerDown(event) {
      if (!popover) return;
      if (popover.contains(event.target) || toggleEl.contains(event.target)) return;
      close();
    }

    function onGlobalKeydown(event) {
      if (event.key === "Escape" && popover) {
        event.preventDefault();
        close({ restoreFocus: true });
      }
    }

    function handleRowKeydown(event) {
      const rows = availableRows();
      // Delegated listener: currentTarget is the list, not the focused row.
      const current = event.target.closest("[data-row-id]");
      const index = rows.indexOf(current);
      if (event.key === "ArrowDown") {
        event.preventDefault();
        rows[(index + 1) % rows.length]?.focus();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        rows[(index - 1 + rows.length) % rows.length]?.focus();
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        rows[event.key === "Home" ? 0 : rows.length - 1]?.focus();
      }
    }

    function wireRows() {
      const listEl = popover?.querySelector(".agent-capability-list");
      if (!listEl) return;
      listEl.addEventListener("click", (event) => {
        const row = event.target.closest("[data-row-id]");
        if (!row) return;
        const id = row.getAttribute("data-row-id");
        if (!id) return;
        const selected = getSelected();
        if (selected.includes(id)) {
          setSelected(selected.filter((sid) => sid !== id));
          // A blocked (non-attachable) row is removable ONLY: re-render so it
          // disappears immediately instead of lingering as a re-addable row.
          const option = options.find((opt) => opt.id === id);
          if (option && option.agent_attachable === false) {
            renderRows();
            positionPopover();
          }
        } else {
          setSelected([...selected, id]);
        }
      });
      listEl.addEventListener("keydown", (event) => {
        if (event.target.closest("[data-row-id]")) handleRowKeydown(event);
      });
    }

    function wireFilters() {
      const filtersEl = popover?.querySelector(".agent-capability-filters");
      if (!filtersEl) return;
      filtersEl.addEventListener("click", (event) => {
        const btn = event.target.closest("[data-filter]");
        if (!btn) return;
        activeFilter = btn.getAttribute("data-filter") || "all";
        filtersEl.querySelectorAll("[data-filter]").forEach((el) => {
          el.classList.toggle("active", el === btn);
        });
        renderRows();
        positionPopover();
      });
    }

    // Ids of the rows currently VISIBLE (same active-filter + search predicate
    // as renderCapabilityRows), used by "Select all".
    function visibleOptionIds() {
      const q = (searchValue || "").trim().toLowerCase();
      return options
        .filter((opt) => {
          if (activeFilter && activeFilter !== "all" && opt.source !== activeFilter) {
            return false;
          }
          if (!q) return true;
          return [opt.id, opt.display_name, opt.description, opt.source]
            .filter(Boolean)
            .some((value) => String(value).toLowerCase().includes(q));
        })
        .map((opt) => opt.id);
    }

    function wireActions() {
      const actionsEl = popover?.querySelector(".agent-capability-actions");
      if (!actionsEl) return;
      actionsEl.addEventListener("click", (event) => {
        const btn = event.target.closest("[data-action]");
        if (!btn) return;
        const action = btn.getAttribute("data-action");
        if (action === "select-all") {
          // Add all currently-visible rows to the selection (keeps others).
          setSelected([...getSelected(), ...visibleOptionIds()]);
        } else if (action === "clear") {
          setSelected([]);
        }
      });
    }

    function open() {
      if (popover) return;
      searchValue = "";
      // Freeze the selected-first order on the selection AS OF OPEN so that
      // neither row toggles nor the async catalog refresh below reshuffle
      // rows mid-interaction; the next open re-floats the current selection.
      const selectionAtOpen = getSelected();
      displayOptions = orderCapabilityOptionsForOpen(options, selectionAtOpen);
      popover = document.createElement("div");
      popover.className = "agent-capability-popover";
      popover.setAttribute("role", "dialog");
      popover.setAttribute(
        "aria-label",
        presentation.title,
      );
      popover.innerHTML = `
        <div class="agent-capability-header">
          <div class="agent-capability-heading">
            <strong>${escapeHtml(presentation.title)}</strong>
            <small>${escapeHtml(presentation.description)}</small>
          </div>
          <button type="button" class="agent-capability-done" data-picker-done>Done</button>
        </div>
        <div class="agent-capability-controls">
          <label class="agent-capability-search-row">
            <span>${CAPABILITY_SEARCH_SVG}</span>
            <input class="agent-capability-search" type="search" placeholder="${escapeHtml(presentation.searchPlaceholder)}" aria-label="${escapeHtml(presentation.searchPlaceholder)}" autocomplete="off" />
          </label>
          <div class="agent-capability-control-row">
            ${pickerFilterChipsHtml(kind, activeFilter)}
            <div class="agent-capability-actions">
              <button type="button" class="agent-capability-action" data-action="select-all">Select all</button>
              <button type="button" class="agent-capability-action" data-action="clear">Clear</button>
            </div>
          </div>
        </div>
        <div class="agent-capability-list" role="listbox" aria-multiselectable="true"></div>
        <div class="agent-capability-footer">
          <span><span data-selected-count>${getSelected().length} selected</span> · changes apply immediately</span>
          <button type="button" class="agent-capability-done" data-picker-done>Done</button>
        </div>
      `;
      document.body.appendChild(popover);
      toggleEl.setAttribute("aria-expanded", "true");
      renderRows();
      wireRows();
      wireFilters();
      wireActions();
      // Refresh the catalog on every open so options created elsewhere (e.g.
      // a skill made in Chat moments ago) appear without reopening the
      // editor. The popover opens synchronously with the current options;
      // fresh rows swap in when the fetch lands (row clicks are delegated on
      // the list, so a re-render needs no re-wiring). Selection lives in
      // dataset.selected and survives the swap.
      if (typeof refreshOptions === "function") {
        const popoverAtOpen = popover;
        void (async () => {
          try {
            const next = await refreshOptions();
            if (!Array.isArray(next) || popover !== popoverAtOpen) return;
            options = next;
            displayOptions = orderCapabilityOptionsForOpen(options, selectionAtOpen);
            renderRows();
            toggleEl.innerHTML = renderPickerSummary(
              getSelected(),
              options,
              kind,
              addButtonLabel,
            );
            positionPopover();
          } catch (_error) {
            // Keep the already-rendered (stale) options on fetch failure.
          }
        })();
      }
      popover.querySelectorAll("[data-picker-done]").forEach((button) => {
        button.addEventListener("click", () => close({ restoreFocus: true }));
      });
      const search = popover.querySelector(".agent-capability-search");
      search?.addEventListener("input", () => {
        searchValue = search.value;
        renderRows();
        // Re-anchor: when opened above, the popover height shrinks as rows are
        // filtered, so reposition to keep it hugging the trigger.
        positionPopover();
      });
      search?.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          availableRows()[0]?.focus();
        }
      });
      document.addEventListener("pointerdown", onDocumentPointerDown, true);
      document.addEventListener("keydown", onGlobalKeydown, true);
      window.addEventListener("resize", positionPopover);
      window.addEventListener("scroll", positionPopover, true);
      positionPopover();
      window.requestAnimationFrame?.(() => {
        positionPopover();
        focusWithoutScrolling(search);
      });
    }

    function close({ restoreFocus = false } = {}) {
      if (!popover) return;
      popover.remove();
      popover = null;
      toggleEl.setAttribute("aria-expanded", "false");
      document.removeEventListener("pointerdown", onDocumentPointerDown, true);
      document.removeEventListener("keydown", onGlobalKeydown, true);
      window.removeEventListener("resize", positionPopover);
      window.removeEventListener("scroll", positionPopover, true);
      searchValue = "";
      activeFilter = "all";
      if (restoreFocus) focusWithoutScrolling(toggleEl);
    }

    toggleEl?.addEventListener("click", () => {
      if (popover) close();
      else open();
    });

    container.addEventListener("agents-picker-detach", () => close());
  }

  // Lazy self-heal for legacy skill ids: a 2-segment marketplace id
  // ({mp}/{leaf}) saved before the plugin layout rewrites to its unique
  // fully-qualified catalog id ({mp}/{plugin}/{leaf}) when the form is saved.
  // Ambiguous or unknown ids pass through untouched — no startup rewrites.
  function normalizeSelectedSkillIds(ids) {
    const skills = Array.isArray(state.catalogs.skills) ? state.catalogs.skills : [];
    if (!skills.length) return ids;
    const exact = new Set(skills.map((skill) => skill.id));
    return ids.map((id) => {
      const trimmed = String(id || "").trim();
      if (!trimmed || exact.has(trimmed)) return trimmed;
      const parts = trimmed.split("/").filter(Boolean);
      if (parts.length !== 2) return trimmed;
      const matches = skills.filter((skill) => {
        const candidate = String(skill.id).split("/");
        return (
          candidate.length === 3 &&
          candidate[0] === parts[0] &&
          candidate[2] === parts[1]
        );
      });
      return matches.length === 1 ? matches[0].id : trimmed;
    });
  }

  function readPickerSelection(container) {
    if (!container) return [];
    try {
      const parsed = JSON.parse(container.dataset.selected || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch (_e) {
      return [];
    }
  }

  // The reasoning-effort control is the OWUI slider replica; its stops depend
  // on the selected base model, so this re-derives the field state and pushes
  // it into the mounted slider on every model change.
  function syncAgentReasoningEffortField(overlay, catalogs = state.catalogs) {
    const baseModelSelect = overlay.querySelector('[name="base_model_id"]');
    const sliderContainer = overlay.querySelector("[data-agent-reasoning-slider]");
    const hiddenInput = overlay.querySelector('input[name="reasoning_effort"]');
    if (!baseModelSelect || !sliderContainer) return;
    const fieldState = buildReasoningEffortFieldState(
      catalogs.baseModels || [],
      baseModelSelect.value,
      hiddenInput?.value || "",
    );
    sliderContainer.agentReasoningSlider?.setFieldState(fieldState);
  }

  function buildAgentForm(agent = null, catalogs = state.catalogs, { isEdit = Boolean(agent) } = {}) {
    const baseModels = catalogs.baseModels || [];
    const skills = catalogs.skills || [];
    const toolServers = catalogs.toolServers || [];
    const baseModelField = agentModelPickerApi.buildFieldHtml(
      agent?.base_model_id || "",
    );

    return `
      <form class="agents-form agents-form-editor" data-edit="${isEdit ? "true" : "false"}">
        <section class="agent-editor-section">
          <div class="agent-editor-section-heading">
            <span class="agent-editor-step">1</span>
            <div><h3>Identity and access</h3><p>Give this agent a clear purpose and choose who can discover it.</p></div>
          </div>
          <div class="agent-editor-section-body">
            <div class="agent-editor-grid agent-editor-grid-two">
              <label>
                <span>Name *</span>
                <input
                  type="text"
                  name="name"
                  required
                  maxlength="${MAX_AGENT_NAME_LENGTH}"
                  value="${escapeHtml(agent?.name || "")}"
                  placeholder="Research assistant"
                  aria-invalid="false"
                />
                <div class="agents-form-field-error" id="agents-name-error" data-agent-name-error hidden></div>
              </label>
              <label>
                <span>Description</span>
                <textarea class="agent-editor-plain-textarea" name="description" rows="3" placeholder="What is this agent great at?">${escapeHtml(agent?.description || "")}</textarea>
              </label>
            </div>
            <label>
              <span>Allowed emails</span>
              <textarea
                name="allowed_emails"
                rows="2"
                placeholder="jdoe@example.invalid&#10;asmith@example.invalid"
              >${escapeHtml(formatAllowedEmailsForField(agent?.allowed_emails || []))}</textarea>
              <small class="agents-form-help">Comma or newline separated. Leave blank to make the marketplace copy visible to everyone.</small>
              <div class="agents-form-field-error" data-agent-error="allowed_emails" hidden></div>
            </label>
          </div>
        </section>

        <section class="agent-editor-section">
          <div class="agent-editor-section-heading">
            <span class="agent-editor-step">2</span>
            <div><h3>Model and behavior</h3><p>Choose the model foundation, then define how the agent should work.</p></div>
          </div>
          <div class="agent-editor-section-body">
            <div class="agent-editor-grid agent-editor-model-grid">
              <div class="agents-form-field agent-editor-model-field">
                <div class="agents-form-label">Base model *</div>
                ${baseModelField}
                <div class="agents-form-field-error" data-agent-error="base_model_id" hidden></div>
              </div>
              <div class="agents-form-field">
                <div class="agents-form-label">Reasoning effort</div>
                ${agentReasoningSliderApi.buildFieldHtml(agent?.reasoning_effort || "")}
                <small class="agents-form-help">Optional default for reasoning-capable models.</small>
              </div>
            </div>
            <label>
              <span>System prompt *</span>
              <textarea name="system_prompt" rows="8" required placeholder="Describe the agent's role, priorities, and boundaries.">${escapeHtml(agent?.system_prompt || "")}</textarea>
              <div class="agents-form-field-error" data-agent-error="system_prompt" hidden></div>
            </label>
          </div>
        </section>

        <section class="agent-editor-section">
          <div class="agent-editor-section-heading">
            <span class="agent-editor-step">3</span>
            <div><h3>Capabilities</h3><p>Connect the reusable knowledge and tools this agent can use.${window.InfoTooltips?.triggerHtml?.("Without selected skills or MCP servers, this agent picks its own tools per session — which may vary when others use it. Select your own to guarantee which tools to invoke.") || ""}</p></div>
          </div>
          <div class="agent-editor-section-body agent-editor-grid agent-editor-grid-two agent-editor-capabilities-grid">
            ${buildPicker({
              kind: "skills",
              label: "Skills",
              addButtonLabel: "Add skills",
              emptyText: "No skills available",
              options: skills,
              // Lazy self-heal starts at populate time: legacy 2-segment ids
              // rewrite to their unique FQN so the picker's selection matches
              // the catalog (Blocked rows render) and save persists the
              // normalized ids.
              selectedIds: normalizeSelectedSkillIds(agent?.skill_ids || []),
            })}
            ${buildPicker({
              kind: "tool_server_ids",
              label: "MCP servers",
              addButtonLabel: "Add MCP servers",
              emptyText: "No MCP servers available",
              options: toolServers,
              selectedIds: (agent?.tool_server_ids || []).map(normalizeToolServerId),
            })}
            <div class="agents-form-field agent-editor-grid-span">
              <span class="agents-form-label">Skill provenance (here, status means is the skill up to date)</span>
              <div data-agent-edit-skill-table>${buildAgentViewSkillsTableHtml(
                getAgentSkillRowDetails(agent?.skill_ids || [], catalogs),
              )}</div>
            </div>
            <div class="agents-form-field agent-editor-grid-span">
              <span class="agents-form-label">MCP servers</span>
              <div data-agent-edit-tool-list>${renderAgentDetailsTools(
                getAgentToolDetails(agent?.tool_server_ids || [], catalogs),
                "No MCP servers configured.",
              )}</div>
            </div>
          </div>
        </section>
      </form>
    `;
  }

  function wireAgentForm(overlay, catalogs = state.catalogs) {
    const skillsPicker = overlay.querySelector('[data-picker-kind="skills"]');
    const serversPicker = overlay.querySelector('[data-picker-kind="tool_server_ids"]');
    // The provenance table under the pickers mirrors the current selection so
    // skill provenance stays visible while editing (redundant with the picker
    // by design). Rebuilt on every selection change; status cells resolve
    // from the shared freshness snapshot.
    const skillTableHost = overlay.querySelector("[data-agent-edit-skill-table]");
    const refreshEditSkillTable = (ids) => {
      if (!skillTableHost) return;
      skillTableHost.innerHTML = buildAgentViewSkillsTableHtml(
        getAgentSkillRowDetails(ids, catalogs),
      );
      void applyAgentViewSkillStatuses(overlay, state.editor);
    };
    wirePicker(skillsPicker, catalogs.skills || [], {
      emptyText: "No skills available",
      onChange: refreshEditSkillTable,
      refreshOptions: async () => {
        const fresh = await loadCatalogs({ force: true });
        return fresh?.skills || [];
      },
    });
    void applyAgentViewSkillStatuses(overlay, state.editor);
    // Same read-only presentation as the detail view (friendly names +
    // icons), refreshed live as the MCP picker selection changes.
    const toolListHost = overlay.querySelector("[data-agent-edit-tool-list]");
    wirePicker(serversPicker, catalogs.toolServers || [], {
      emptyText: "No MCP servers available",
      onChange: (ids) => {
        if (!toolListHost) return;
        toolListHost.innerHTML = renderAgentDetailsTools(
          getAgentToolDetails(ids, catalogs),
          "No MCP servers configured.",
        );
      },
      refreshOptions: async () => {
        const fresh = await loadCatalogs({ force: true });
        return fresh?.toolServers || [];
      },
    });
    const modelPickerContainer = overlay.querySelector("[data-agent-model-picker]");
    const modelPicker = agentModelPickerApi.mount(modelPickerContainer, {
      models: catalogs.baseModels || [],
      value: modelPickerContainer?.dataset.currentValue || "",
      error: (catalogs.baseModels || []).length ? "" : catalogs.baseModelsError,
      onRetry: async () => {
        const refreshed = await loadCatalogs({ force: true });
        if (refreshed.baseModelsError) {
          throw new Error(refreshed.baseModelsError);
        }
        return refreshed.baseModels || [];
      },
    });
    const reasoningSliderContainer = overlay.querySelector(
      "[data-agent-reasoning-slider]",
    );
    if (reasoningSliderContainer) {
      agentReasoningSliderApi.mount(reasoningSliderContainer, {
        fieldState: buildReasoningEffortFieldState(
          catalogs.baseModels || [],
          modelPickerContainer?.dataset.currentValue || "",
          reasoningSliderContainer.dataset.currentValue || "",
        ),
      });
    }
    const baseModelSelect = overlay.querySelector('[name="base_model_id"]');
    baseModelSelect?.addEventListener("change", () => {
      syncAgentReasoningEffortField(overlay, catalogs);
      if (overlay.dataset.showFieldErrors === "true") {
        const unavailable = selectedDisabledBaseModel(overlay);
        setAgentFieldError(
          overlay,
          "base_model_id",
          !baseModelSelect.value
            ? "Base model is required"
            : unavailable
              ? `Base model "${unavailable.id}" is unavailable: ${unavailable.reason}`
              : "",
        );
      }
    });
    syncAgentReasoningEffortField(overlay, catalogs);
    return modelPicker;
  }

  function readAgentForm(overlay, { currentAgentId = null, currentName = "" } = {}) {
    const form = overlay.querySelector(".agents-form");
    if (!form) throw new Error("Agent form not found");
    // Surface inline errors on every required field so the user can see exactly
    // why the submit button isn't proceeding, then keep them updated live.
    overlay.dataset.showFieldErrors = "true";
    const validation = validateAgentRequiredFields(overlay, {
      currentAgentId,
      currentName,
    });
    if (!validation.valid) {
      const target = validation.firstInvalid;
      if (target) {
        target.focus();
        if (typeof target.reportValidity === "function") target.reportValidity();
      }
      return null;
    }
    const data = new FormData(form);
    const name = validation.name;
    const nameInput = form.querySelector('input[name="name"]');
    if (nameInput) nameInput.value = name;
    const base_model_id = String(data.get("base_model_id") || "").trim();
    const system_prompt = String(data.get("system_prompt") || "").trim();
    const allowedEmails = validateAllowedEmails(
      String(data.get("allowed_emails") || ""),
    ).normalized;
    return {
      name,
      base_model_id,
      system_prompt,
      description: String(data.get("description") || "").trim(),
      allowed_emails: allowedEmails,
      skill_ids: normalizeSelectedSkillIds(
        readPickerSelection(
          overlay.querySelector('[data-picker-kind="skills"]'),
        ),
      ),
      tool_server_ids: readPickerSelection(
        overlay.querySelector('[data-picker-kind="tool_server_ids"]'),
      ).map(normalizeToolServerId),
      reasoning_effort: normalizeReasoningEffortForSubmission(
        state.catalogs.baseModels || [],
        base_model_id,
        data.get("reasoning_effort"),
      ),
    };
  }

  // ===========================================================================
  // INLINE AGENT EDITOR
  // Create/edit renders directly into the control plane (#agents-tab-editor)
  // instead of a modal. Reuses buildAgentForm + all wiring/validation helpers
  // (they operate on any root element) and the .agents-modal-error/-cancel/
  // -submit class names so setModalError/setModalBusyState work unchanged.
  // ===========================================================================

  function getEditorHost() {
    return cfg.editorId ? document.getElementById(cfg.editorId) : null;
  }

  function getBrowser() {
    return cfg.browserId ? document.getElementById(cfg.browserId) : null;
  }

  // Serialize the editable form values (inputs + pickers) WITHOUT touching
  // validation UI (readAgentForm surfaces field errors), so it can run on
  // demand for dirty checks. The marketplace-sync checkbox lives in the footer
  // outside the form and is deliberately excluded: it is a save option, not
  // authored content.
  function serializeAgentEditorState(root) {
    const form = root?.querySelector(".agents-form");
    if (!form) return "";
    const fields = {};
    for (const [key, value] of new FormData(form).entries()) {
      fields[key] = String(value);
    }
    fields.__skills = readPickerSelection(
      root.querySelector('[data-picker-kind="skills"]'),
    ).join(",");
    fields.__tool_servers = readPickerSelection(
      root.querySelector('[data-picker-kind="tool_server_ids"]'),
    ).join(",");
    return JSON.stringify(fields);
  }

  function isAgentEditorDirty() {
    if (!state.editor) return false;
    // Read-only pages have nothing editable; leaving them never loses work.
    if (state.editor.mode === "view") return false;
    return (
      serializeAgentEditorState(state.editor.root) !== state.editor.baseline
    );
  }

  function teardownAgentEditor() {
    const editor = state.editor;
    if (!editor) return;
    // Same detach handshake as closeModal(): the pickers and the model picker
    // register document-level listeners that must be released.
    editor.root.querySelectorAll("[data-picker-kind]").forEach((picker) => {
      picker.dispatchEvent(new CustomEvent("agents-picker-detach"));
    });
    editor.root.querySelectorAll("[data-agent-model-picker]").forEach((picker) => {
      picker.dispatchEvent(new CustomEvent("agent-model-picker-detach"));
    });
    editor.root.querySelectorAll("[data-agent-reasoning-slider]").forEach((slider) => {
      slider.dispatchEvent(new CustomEvent("agent-reasoning-slider-detach"));
    });
    editor.root.innerHTML = "";
    editor.root.style.display = "none";
    // The host element is reused across sessions; a submit that succeeds tears
    // the editor down mid-flight, skipping the busy reset. Clear the flag so
    // the next session's submit/back/cancel handlers aren't dead on arrival.
    delete editor.root.dataset.busy;
    state.editor = null;
    const browser = getBrowser();
    if (browser) browser.style.display = "";
    const view = getView();
    if (view && view.style.display !== "none") {
      const actions = getHeaderActions();
      if (actions) actions.style.display = "";
    }
  }

  // Close the editor, warning first when there are unsaved changes.
  function requestCloseAgentEditor(onAfterClose) {
    if (!state.editor) return;
    if (!isAgentEditorDirty()) {
      teardownAgentEditor();
      onAfterClose?.();
      return;
    }
    showAgentsDiscardModal({
      subject: state.editor.subjectName,
      onDiscard: () => {
        teardownAgentEditor();
        onAfterClose?.();
      },
    });
  }

  function openAgentEditor({
    mode = "edit", // 'create' | 'edit' | 'view'
    title,
    headerSubtitle = "",
    bodyHtml,
    headerActionsHtml = "",
    pageChipsHtml = "",
    submitLabel = "Save",
    submitBusyLabel = `${submitLabel}...`,
    cancelLabel = "Cancel",
    footerLeftHtml = "",
    // Rendered AFTER the submit button (e.g. the Save-and-publish combo).
    footerRightHtml = "",
    subjectName = "",
    agentId = "",
    // Bare value the header copy button copies (the agent/listing NAME, never
    // a display title like "Edit X"). Empty hides the button.
    titleCopyValue = "",
    onSubmit,
  }) {
    teardownAgentEditor();
    const editorHost = getEditorHost();
    if (!editorHost) return null;
    editorHost.innerHTML = `
      <div class="agent-editor-page">
        <div class="agent-editor-header">
          <button class="agent-editor-back-btn" type="button">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"></path></svg>
            Back
          </button>
          <div class="agent-editor-header-main">
            <div class="agent-editor-title-row">
              <h1>${escapeHtml(title)}</h1>
              <span data-agent-title-copy>${titleCopyValue ? copyButtonHtml(titleCopyValue, "Agent name") : ""}</span>
            </div>
            ${headerSubtitle ? `<p>${escapeHtml(headerSubtitle)}</p>` : ""}
            <div class="agent-editor-page-chips" data-agent-page-chips>${pageChipsHtml}</div>
          </div>
          <div class="agent-editor-page-actions" data-agent-page-actions>${headerActionsHtml}</div>
        </div>
        <div class="agent-editor-inline-body">
          <div class="agent-editor-body-content" data-agent-editor-content>${bodyHtml}</div>
          <div class="agent-editor-inline-footer">
            ${footerLeftHtml}
            <div class="agents-modal-error" role="alert" hidden style="margin-right: auto; color: var(--danger, #d14343); font-size: 0.82rem;"></div>
            <button class="btn-secondary agents-modal-cancel" type="button">${escapeHtml(cancelLabel)}</button>
            ${onSubmit ? `<button class="btn-primary agents-modal-submit" type="button">${escapeHtml(submitLabel)}</button>` : ""}
            ${footerRightHtml}
          </div>
        </div>
      </div>
    `;
    // The editor takes over the Agents view: hide the browse UI (search, mode
    // tabs, list) and the header actions (New Agent / Settings).
    const browser = getBrowser();
    if (browser) browser.style.display = "none";
    const actions = getHeaderActions();
    if (actions) actions.style.display = "none";
    editorHost.style.display = "";
    editorHost.dataset.busy = "false";
    const editorState = { root: editorHost, baseline: "", subjectName, mode, agentId };
    state.editor = editorState;

    const leave = () => {
      if (editorHost.dataset.busy === "true") return;
      requestCloseAgentEditor();
    };
    editorHost
      .querySelector(".agent-editor-back-btn")
      ?.addEventListener("click", leave);
    editorHost
      .querySelector(".agents-modal-cancel")
      ?.addEventListener("click", leave);
    if (onSubmit) {
      // Programmatic seam shared with the footer button: Republish-from-a-
      // dirty-edit-page awaits this to save first. Resolves to onSubmit's
      // return value (the edit save returns true on success) or false when
      // the submit was busy-skipped or failed.
      editorState.submit = async () => {
        if (editorHost.dataset.busy === "true") return false;
        const submitBtn = editorHost.querySelector(".agents-modal-submit");
        setModalError(editorHost);
        setModalBusyState(editorHost, true, submitBusyLabel);
        try {
          return (await onSubmit(editorHost, submitBtn)) ?? false;
        } catch (error) {
          setModalError(editorHost, error.message || String(error));
          notify(error.message || String(error), "error");
          return false;
        } finally {
          // The host element is reused across editor sessions; only reset
          // the busy state if this session is still the mounted one.
          if (state.editor === editorState) {
            setModalBusyState(editorHost, false, submitBusyLabel);
          }
        }
      };
      editorHost
        .querySelector(".agents-modal-submit")
        ?.addEventListener("click", () => {
          void editorState.submit();
        });
    }
    // The host is the scroll container; start each session at the top.
    editorHost.scrollTop = 0;
    return editorHost;
  }

  async function openNewAgentEditor(prefill = null) {
    const catalogs = await loadCatalogs();
    let session = null;
    const root = openAgentEditor({
      mode: "create",
      title: "New agent",
      headerSubtitle: "Design a focused teammate with the right model, instructions, and tools.",
      bodyHtml: buildAgentForm(prefill, catalogs, { isEdit: false }),
      submitLabel: "Create agent",
      submitBusyLabel: "Creating...",
      subjectName: "this new agent",
      onSubmit: async (editorRoot) => {
        let args = readAgentForm(editorRoot);
        if (!args) return;
        try {
          args = await withCreatorAllowedEmail(args);
          const created = await callSubagent(TOOL_CREATE, args);
          const createdId = String(created?.id || "").trim();
          if (createdId) {
            setStoredAllowedEmails(createdId, args.allowed_emails);
          }
          if (state.editor === session) teardownAgentEditor();
          notify(`Agent "${args.name}" created.`, "success");
          await loadMyAgents();
        } catch (error) {
          notify(error.message, "error");
        }
      },
    });
    if (!root) return;
    wireAgentForm(root, catalogs);
    wireAgentNameValidation(root);
    wireAgentRequiredFieldValidation(root);
    // Baseline for the dirty check, captured after wiring: mounting the model
    // picker can normalize the hidden base_model_id value.
    session = state.editor;
    if (session?.root === root) {
      session.baseline = serializeAgentEditorState(root);
    }
  }

  // "<name> (copy)", then "(copy 2)", ... — unique against the loaded agent
  // list and within the max name length.
  function uniqueCopyName(sourceName) {
    const existing = new Set(
      state.myAgents
        .map((item) => normalizeAgentName(item?.name || ""))
        .filter(Boolean),
    );
    const base = String(sourceName || "Agent").trim() || "Agent";
    for (let attempt = 1; attempt <= 100; attempt += 1) {
      const suffix = attempt === 1 ? " (copy)" : ` (copy ${attempt})`;
      const trimmedBase = base.slice(0, Math.max(1, MAX_AGENT_NAME_LENGTH - suffix.length));
      const candidate = `${trimmedBase}${suffix}`;
      if (!existing.has(normalizeAgentName(candidate))) return candidate;
    }
    return `${base.slice(0, Math.max(1, MAX_AGENT_NAME_LENGTH - 14))} (copy ${Date.now() % 10000})`;
  }

  // Clone = open the New-agent editor prefilled from the source agent.
  // Nothing is written until the user clicks "Create agent", and the copy is
  // fully owned by the current user (no marketplace link, fresh creator).
  async function cloneAgent(sourceAgentId) {
    let source;
    try {
      source = normalizeAgentRecord(await fetchAgentWithSystemPrompt(sourceAgentId));
    } catch (error) {
      notify(error.message, "error");
      return;
    }
    if (!source) {
      notify("Agent not found", "error");
      return;
    }
    const prefill = {
      name: uniqueCopyName(source.name),
      description: source.description,
      base_model_id: source.base_model_id,
      system_prompt: source.system_prompt,
      skill_ids: source.skill_ids,
      tool_server_ids: source.tool_server_ids,
      reasoning_effort: source.reasoning_effort,
      allowed_emails: source.allowed_emails,
    };
    await openNewAgentEditor(prefill);
  }

  async function openEditAgentEditor(agentId) {
    let agent;
    try {
      await refreshMarketplaceLinks();
      agent = normalizeAgentRecord(await fetchAgentWithSystemPrompt(agentId));
      agent = await hydrateLinkedAgentAllowedEmails(agent);
    } catch (error) {
      notify(error.message, "error");
      return;
    }
    if (!agent) {
      notify("Agent not found", "error");
      return;
    }
    const catalogs = await loadCatalogs();
    let session = null;
    const root = openAgentEditor({
      mode: "edit",
      title: `Edit ${agent.name}`,
      headerSubtitle: "Refine this agent's model, instructions, access, and connected capabilities.",
      bodyHtml: buildAgentForm(agent, catalogs),
      headerActionsHtml: buildAgentPageActionsHtml(agent, "edit"),
      pageChipsHtml: buildAgentPageChipsHtml(agent),
      submitLabel: "Save changes",
      submitBusyLabel: "Saving...",
      footerRightHtml: buildAgentFooterPublishButtonHtml(agent),
      subjectName: agent.name,
      agentId: agent.id,
      titleCopyValue: agent.name,
      onSubmit: async (editorRoot) => {
        let args = readAgentForm(editorRoot, {
          currentAgentId: agent.id,
          currentName: agent.name,
        });
        if (!args) return false;
        // Save is strictly LOCAL: the marketplace copy only changes through
        // the explicit Republish flow. Re-derive link state at submit time
        // (header Publish/Unpublish may have changed it) so linked agents get
        // dirty-marked and their cards show "Unpublished changes".
        const currentLink = state.marketplaceLinks?.[agent.id] || null;
        const isLinkedNow = Boolean(currentLink?.solutionId);
        const hasContentChanges =
          serializeAgentEditorState(editorRoot) !== (session?.baseline ?? "");
        const updateArgs = {
          model_id: agent.id,
          name: args.name,
          description: args.description,
          system_prompt: args.system_prompt,
          base_model_id: args.base_model_id,
          skill_ids: args.skill_ids,
          tool_server_ids: args.tool_server_ids,
          reasoning_effort: args.reasoning_effort,
        };
        try {
          args = await withCreatorAllowedEmail(args);
          await callSubagent(TOOL_UPDATE, updateArgs);
          setStoredAllowedEmails(agent.id, args.allowed_emails);
          if (isLinkedNow && hasContentChanges) {
            // The marketplace copy is now behind the local one. Event-driven
            // flag; cleared on the next publish. No-op saves (nothing changed
            // vs the baseline) don't flag.
            await window.electronAPI?.aiMarketplace?.markLinkDirty?.(agent.id);
            logMarketplacePublish("sync:dirty-marked", { agentId: agent.id });
          }
          if (state.editor === session) teardownAgentEditor();
          notify("Agent updated.", "success");
          await loadMyAgents();
          return true;
        } catch (error) {
          notify(error.message, "error");
          return false;
        }
      },
    });
    if (!root) return;
    wireAgentForm(root, catalogs);
    wireAgentNameValidation(root, {
      currentAgentId: agent.id,
      currentName: agent.name,
    });
    wireAgentRequiredFieldValidation(root);
    // Baseline for the dirty check, captured after wiring: mounting the model
    // picker can normalize the hidden base_model_id value.
    session = state.editor;
    if (session?.root === root) {
      session.baseline = serializeAgentEditorState(root);
    }
  }

  // Republish from a dirty edit page implies Save: run the same wrapped
  // submit the footer button uses (validation, busy chrome, markLinkDirty),
  // then publish the freshly saved agent. A failed/blocked save aborts the
  // publish — its error is already surfaced inline. The publish modal is
  // body-mounted, so it opens fine after the save closes the editor.
  async function publishAgentWithDirtySave(agentId, btn) {
    const session = state.editor;
    if (
      session?.mode === "edit" &&
      session?.agentId === agentId &&
      typeof session.submit === "function" &&
      isAgentEditorDirty()
    ) {
      logMarketplacePublish("publish:auto-save", { agentId });
      const saved = await session.submit();
      if (!saved) return;
    }
    await publishAgent(agentId, btn);
  }

  // ONE modal per case, decided from the LOCAL link registry — no ownership
  // round-trip before the modal. performDeleteAgent's 403/tombstone
  // downgrades absorb stale links (limbo rows, foreign "published" links)
  // without a preflight.
  function deleteAgent(agentId) {
    console.log(`[Agents:${cfg.key}] deleteAgent invoked`, { agentId });
    // The cached link may be a beat stale; the confirm handler re-checks.
    const link = state.marketplaceLinks?.[agentId] || null;
    if (!link?.solutionId) {
      showAgentsConfirmModal({
        title: "Delete agent?",
        message: `Delete agent "${agentId}"? This cannot be undone.`,
        confirmLabel: "Delete",
        confirmBusyLabel: "Deleting...",
        danger: true,
        onConfirm: () => confirmedDeleteAgent(agentId, {}),
      });
      return;
    }
    if (link.relationship === "installed") {
      // Installed copy: deleting it never touches the listing — one quiet
      // modal, no owner names or id badges (it's reinstallable from Discover).
      showAgentsConfirmModal({
        title: "Delete agent?",
        message: `Delete "${agentId}" from this computer? The Marketplace listing won't be affected.`,
        confirmLabel: "Delete",
        confirmBusyLabel: "Deleting...",
        danger: true,
        onConfirm: () => confirmedDeleteAgent(agentId, {}),
      });
      return;
    }
    // Viewer-published (or unknown) link: one three-way choice replaces the
    // old chained pair of modals.
    showAgentsConfirmModal({
      title: "Delete agent?",
      message: `"${agentId}" is also published on the AI Marketplace. What should happen to the listing?`,
      meta: { badge: link.solutionId },
      confirmLabel: "Delete local + listing",
      confirmBusyLabel: "Deleting...",
      secondaryLabel: "Delete local only",
      secondaryBusyLabel: "Deleting...",
      danger: true,
      onConfirm: () =>
        confirmedDeleteAgent(agentId, { alsoRemoveFromMarketplace: true }),
      onSecondary: () => confirmedDeleteAgent(agentId, {}),
    });
  }

  // Shared confirm continuation (runs under the modal's spinner): re-read the
  // link for post-confirm truth, collect the dependent-skill ids for the
  // orphan-cleanup offer, then delete. Throws so failures surface inline.
  async function confirmedDeleteAgent(
    agentId,
    { alsoRemoveFromMarketplace = false } = {},
  ) {
    await refreshMarketplaceLinks();
    const link = state.marketplaceLinks?.[agentId] || null;
    console.log(`[Agents:${cfg.key}] deleteAgent confirmed`, {
      agentId,
      linked: Boolean(link?.solutionId),
      alsoRemoveFromMarketplace,
    });
    let installedMarketplaceSkillIds = [];
    if (link?.solutionId) {
      try {
        const bundleRes = await window.electronAPI?.aiMarketplace?.getBundle(
          link.solutionId,
        );
        if (bundleRes?.success) {
          installedMarketplaceSkillIds = extractMarketplaceSkillIdsFromBundle(
            bundleRes.data,
          );
        }
      } catch (error) {
        console.warn("[Agents] Failed to inspect marketplace bundle before delete", error);
      }
    }
    await performDeleteAgent(agentId, {
      link,
      alsoRemoveFromMarketplace: Boolean(
        alsoRemoveFromMarketplace && link?.solutionId,
      ),
      installedMarketplaceSkillIds,
    });
  }

  // Throws on failure — callers run it under the confirm modal's busy state.
  async function performDeleteAgent(
    agentId,
    {
      link = null,
      alsoRemoveFromMarketplace = false,
      installedMarketplaceSkillIds = [],
    } = {},
  ) {
    // Set only by the 403/not_owner downgrade below — the one genuinely
    // surprising outcome worth a warning.
    let skippedForOwnership = false;
    let marketplaceAlreadyGone = false;
    if (alsoRemoveFromMarketplace && link?.solutionId) {
      const res = await window.electronAPI?.aiMarketplace?.delete(link.solutionId);
      if (!res?.success) {
        // A 404 / not-found means the solution no longer exists in the
        // marketplace, so there is nothing left to remove there. Treat it as
        // already gone and continue deleting the local copy rather than
        // blocking on it — otherwise stale links would make local agents
        // impossible to delete once their marketplace solution is removed.
        const alreadyGone =
          res?.status === 404 ||
          res?.code === "not_found" ||
          res?.code === "no_solution" ||
          // Tombstoned (soft-deleted) listings reject the delete with "already
          // absent" under this code and no HTTP status — e.g. after an
          // unpublish, which tombstones the listing but deliberately keeps the
          // local link. Same "nothing left to remove" semantics as a 404.
          res?.code === "solution_not_found";
        if (isMarketplaceOwnershipError(res)) {
          skippedForOwnership = true;
          console.warn("[Agents] Marketplace delete skipped for non-owner", {
            agentId,
            solutionId: link.solutionId,
            code: res?.code || "",
            status: res?.status || null,
          });
        } else if (!alreadyGone) {
          // Trim any trailing period from the upstream error so appending the
          // sentence suffix cannot produce "absent.. Local agent not deleted."
          const reason = String(res?.error || "unknown error").replace(/\.+$/, "");
          throw new Error(
            `Failed to delete marketplace copy: ${reason}. Local agent not deleted.`,
          );
        } else {
          marketplaceAlreadyGone = true;
        }
      }
    }
    // confirm:true — the tool fail-closes without it, and this call only runs
    // after the user approved the GUI's own confirm modal(s).
    const deleteRes = await callSubagent(TOOL_DELETE, {
      model_id: agentId,
      confirm: true,
    });
    // The subagents handler reports failures via a `success: false` payload
    // rather than throwing, so surface that instead of falsely claiming the
    // agent was deleted. Domain failures carry the reason in `message` or
    // `error` (e.g. the confirm gate and agent_not_found use `error`).
    if (deleteRes && deleteRes.success === false) {
      throw new Error(
        deleteRes.message ||
          deleteRes.error ||
          `Failed to delete agent "${agentId}".`,
      );
    }
    // Once the local agent is gone, remove the local marketplace link even if
    // the remote copy was kept because this user is not its owner.
    if (link?.solutionId) {
      await window.electronAPI?.aiMarketplace?.clearLink(agentId);
    }
    notify(
      skippedForOwnership
        ? "Agent deleted locally. The Marketplace listing was left in place (someone else owns it)."
        : alsoRemoveFromMarketplace && !marketplaceAlreadyGone
          ? "Agent deleted locally and from the marketplace."
          : "Agent deleted.",
      skippedForOwnership ? "warning" : "success",
    );
    clearStoredAllowedEmails(agentId);
    // If the deleted agent's page is open (delete triggered from its header
    // actions), close it back to the list.
    if (state.editor?.agentId === agentId) {
      teardownAgentEditor();
    }
    await loadMyAgents();
    await maybeOfferMarketplaceSkillCleanup(installedMarketplaceSkillIds);
  }

  // Open a new OWUI chat tab preconfigured with this agent. The shared helper
  // also accepts an optional prompt for callers that need a submitted first
  // turn while preserving the normal Agents Chat behavior when omitted.
  function openAgentChatTab(agentId, agentName, prompt = "") {
    try {
      return window.openNewChatTab({
        modelId: agentId,
        prompt,
        title: agentName ? `Chat · ${agentName}` : "New Chat",
      });
    } catch (error) {
      console.error("[Agents] failed to open chat for agent", agentId, error);
      notify(error.message || "Failed to open chat tab", "error");
      return false;
    }
  }

  // Ask the user to set up an agent's not-yet-integrated MCP servers before
  // chatting. Missing integrations block chat so the agent cannot silently
  // degrade into a plain/default model session.
  function promptAgentMcpSetup(pendingNames) {
    const isSingle = pendingNames.length === 1;
    const noun = isSingle ? "server" : "servers";
    const list = pendingNames
      .map((name) => `<li>${escapeHtml(name)}</li>`)
      .join("");
    const body = `
      <p>This agent requires ${pendingNames.length} MCP ${noun} that ${isSingle ? "is" : "are"} not set up yet:</p>
      <ul style="margin: 0.5rem 0 0.75rem 1.25rem;">${list}</ul>
      <p>Install, enable, or authenticate ${isSingle ? "this server" : "these servers"} in Integrations before using this agent from chat.</p>
    `;
    openModal("Set up MCP servers", body, {
      submitLabel: "Set up servers",
      submitBusyLabel: "Opening...",
      cancelLabel: "Close",
      onSubmit: () => {
        closeModal();
        openMcpServersTab();
      },
    });
  }

  function useAgentFromChat(agentId, agentName) {
    if (!agentId) return;
    if (typeof window.openNewChatTab !== "function") {
      notify("Chat tab system not available.", "error");
      return;
    }
    const agent = state.myAgents.find((item) => item.id === agentId) || null;
    const pendingSetup = agentToolServersNeedingSetup(agent);
    console.log("[Agents] use from chat gate", {
      agentId,
      hasAgent: Boolean(agent),
      requiredToolServerIds: Array.isArray(agent?.tool_server_ids) ? agent.tool_server_ids : [],
      pendingSetup,
      failureReason: pendingSetup.length ? "dependency_gate" : null,
    });
    if (pendingSetup.length) {
      promptAgentMcpSetup(pendingSetup);
      return;
    }
    openAgentChatTab(agentId, agentName);
  }

  async function reclaimAgent(agentId) {
    await refreshMarketplaceLinks();
    const link = state.marketplaceLinks?.[agentId];
    if (link?.relationship !== "installed" || !link?.solutionId) {
      notify("This agent is not an installed marketplace copy.", "error");
      return;
    }
    showAgentsConfirmModal({
      title: "Convert to editable copy?",
      message:
        `Make "${agentId}" your editable author copy for this marketplace ` +
        `solution? The Installed badge is removed; Edit and Republish ` +
        `will update your published listing.`,
      meta: { badge: link.solutionId },
      confirmLabel: "Convert",
      confirmBusyLabel: "Converting...",
      onConfirm: () => performReclaimAgent(agentId),
    });
  }

  // Throws on failure so the confirm modal renders the inline error under its
  // busy spinner instead of closing as if nothing happened.
  async function performReclaimAgent(agentId) {
    const res = await window.electronAPI?.aiMarketplace?.reclaimAgent?.(agentId);
    logMarketplacePublish("reclaim:result", {
      agentId,
      success: Boolean(res?.success),
      solutionId: res?.data?.solution_id || null,
      errorMessage: res?.success ? null : String(res?.error || "").slice(0, 200),
    });
    if (!res?.success) {
      throw new Error(res?.error || "Failed to convert the installed copy.");
    }
    notify("This is now your editable copy.", "success");
    // The old details page was rendered for a read-only copy; drop it.
    if (state.editor?.agentId === agentId && state.editor.mode === "view") {
      teardownAgentEditor();
    }
    await loadMyAgents();
    refreshEditorPageMarketplaceState();
  }

  async function unpublishAgent(agentId, triggerBtn = null) {
    await refreshMarketplaceLinks();
    const link = state.marketplaceLinks?.[agentId];
    if (!link?.solutionId) {
      notify("Agent is not linked to a marketplace solution.", "error");
      return;
    }
    const hasKeyRes = await window.electronAPI?.aiMarketplace?.hasApiKey();
    if (!hasKeyRes?.hasKey) {
      notify("Set the AI Marketplace API key in Settings before unpublishing.", "error");
      openSettingsModal();
      return;
    }
    showAgentsConfirmModal({
      title: "Unpublish?",
      message:
        "Remove this agent from the AI Marketplace? The local agent will be kept.",
      meta: { badge: link.solutionId },
      confirmLabel: "Unpublish",
      confirmBusyLabel: "Removing...",
      danger: true,
      onConfirm: () => performUnpublishAgent(agentId, link.solutionId),
    });
  }

  // Throws on failure — runs under the confirm modal's busy spinner.
  async function performUnpublishAgent(agentId, solutionId) {
    const res = await window.electronAPI?.aiMarketplace?.delete(solutionId);
    logMarketplacePublish("unpublish:result", {
      agentId,
      solutionId,
      success: Boolean(res?.success),
      errorMessage: res?.success ? null : String(res?.error || "").slice(0, 200),
    });
    if (!res?.success) {
      throw new Error(res?.error || "Failed to delete marketplace solution");
    }
    notify("Marketplace copy removed.", "success");
    await loadMyAgents();
    refreshEditorPageMarketplaceState();
  }

  // Uninstall = delete the locally installed copy, keep the marketplace
  // listing. Deliberately NOT deleteAgent(): that flow offers to remove the
  // marketplace copy too, which is unpublish semantics.
  async function uninstallSolution(solutionId, triggerBtn = null) {
    await refreshMarketplaceLinks();
    const agentId = findLinkedAgentIdForSolution(solutionId, state.marketplaceLinks);
    if (!agentId) {
      notify("This solution is not installed.", "error");
      if (state.mode === "discover") renderDiscover();
      return;
    }
    showAgentsConfirmModal({
      title: "Uninstall agent?",
      message: `Remove the locally installed copy ("${agentId}")? The marketplace listing is kept.`,
      confirmLabel: "Uninstall",
      confirmBusyLabel: "Removing...",
      danger: true,
      onConfirm: () => performUninstallSolution(solutionId, agentId),
    });
  }

  // Throws on failure — runs under the confirm modal's busy spinner.
  async function performUninstallSolution(solutionId, agentId) {
    // confirm:true — same contract as performDeleteAgent: the uninstall
    // confirm modal already collected explicit user consent.
    const deleteRes = await callSubagent(TOOL_DELETE, {
      model_id: agentId,
      confirm: true,
    });
    if (deleteRes && deleteRes.success === false) {
      throw new Error(
        deleteRes.message ||
          deleteRes.error ||
          `Failed to delete agent "${agentId}".`,
      );
    }
    await window.electronAPI?.aiMarketplace?.clearLink(agentId);
    clearStoredAllowedEmails(agentId);
    await refreshMarketplaceLinks();
    notify("Uninstalled. The marketplace listing was kept.", "success");
    if (state.mode === "discover") {
      renderDiscover();
    } else {
      await loadMyAgents();
    }
  }

  // Solution-keyed unpublish for the Discover cards (the agent-keyed
  // unpublishAgent needs a local link; a published solution may not have one).
  async function unpublishSolutionFromDiscover(solutionId, triggerBtn = null) {
    const hasKeyRes = await window.electronAPI?.aiMarketplace?.hasApiKey();
    if (!hasKeyRes?.hasKey) {
      notify("Set the AI Marketplace API key in Settings before unpublishing.", "error");
      openSettingsModal();
      return;
    }
    await refreshMarketplaceLinks();
    const linkedAgentId = findLinkedAgentIdForSolution(solutionId, state.marketplaceLinks);
    showAgentsConfirmModal({
      title: "Unpublish?",
      message: `Remove this solution from the AI Marketplace?${linkedAgentId ? " Your local agent will be kept." : ""}`,
      meta: { badge: solutionId },
      confirmLabel: "Unpublish",
      confirmBusyLabel: "Removing...",
      danger: true,
      onConfirm: () => performUnpublishSolution(solutionId, linkedAgentId),
    });
  }

  // Throws on failure — runs under the confirm modal's busy spinner.
  async function performUnpublishSolution(solutionId, linkedAgentId) {
    const res = await window.electronAPI?.aiMarketplace?.delete(solutionId);
    if (!res?.success) {
      throw new Error(res?.error || "Failed to delete marketplace solution");
    }
    notify("Marketplace copy removed.", "success");
    if (state.mode === "discover") {
      await runDiscoverSearch();
    } else {
      await loadMyAgents();
    }
  }

  // Publish each of the agent's local skills as its own `skills` solution so the
  // skill bundles already exist in the marketplace when the agent is installed
  // elsewhere. Returns skill_refs ({ skill_id, solution_id }) to embed in the
  // agent bundle. System/built-in skills (no local path) are skipped.
  function isDuplicateMarketplaceSkillError(resultOrError) {
    const code = String(resultOrError?.code || "").toLowerCase();
    const status = Number(resultOrError?.status || 0);
    const message = String(
      resultOrError?.error ||
        resultOrError?.message ||
        resultOrError?.body?.error ||
        resultOrError?.body?.message ||
        "",
    ).toLowerCase();
    return (
      status === 409 ||
      code === "conflict" ||
      code === "duplicate" ||
      message.includes("already exists") ||
      message.includes("duplicate")
    );
  }

  // Session memo for the viewer's published skill listings — the one remote
  // fact adoption needs. Only the lookup promise is memoized: bundle
  // verifies stay fresh (a memoized verify could silently overwrite a
  // repurposed owned listing), and failed lookups are never cached (a
  // transient outage must not lock the session behind a blocked modal).
  // listPublished is a single query-less 100-item page, so an owned listing
  // it misses degrades to publish-new and fail-closes on the execute-time
  // name-conflict guard; pagination is the follow-up lever if that bites.
  let ownedSkillListingsPromise = null;

  function invalidateMarketplaceSkillLookups(reason = "unspecified") {
    if (ownedSkillListingsPromise !== null) {
      logMarketplacePublish("memo:invalidated", { reason });
    }
    ownedSkillListingsPromise = null;
    // Marketplace skill state just changed (publish/unpublish/install/
    // reclaim) — the skills-freshness snapshot is stale with it.
    invalidateSkillFreshness();
  }

  function getOwnedSkillListings(api) {
    if (!ownedSkillListingsPromise) {
      ownedSkillListingsPromise = (async () => {
        try {
          const publishedRes = await api.listPublished?.(TYPE_SKILL);
          if (!publishedRes?.success) {
            invalidateMarketplaceSkillLookups("lookup-failed");
            return { solutions: [], failed: true };
          }
          return {
            solutions: Array.isArray(publishedRes?.data?.solutions)
              ? publishedRes.data.solutions
              : [],
            failed: false,
          };
        } catch (error) {
          console.warn(
            "[Agents] list_published_skills for dependent skill publish failed",
            error,
          );
          invalidateMarketplaceSkillLookups("lookup-failed");
          return { solutions: [], failed: true };
        }
      })();
    }
    return ownedSkillListingsPromise;
  }

  // Adoption candidate for an unlinked user skill: an OWNED listing whose
  // name matches the canonical skill name, verified against its live bundle
  // so a coincidentally-named owned listing of different content is never
  // adopted. Foreign same-name listings are no longer pre-detected — the
  // main process's name-availability guard fail-closes those at publish
  // time with the same rename guidance.
  async function findAdoptableOwnedSkillSolution(api, canonicalName, ownedSolutions) {
    const match = (ownedSolutions || []).find((solution) => {
      if (solution?.type && solution.type !== TYPE_SKILL) return false;
      return canonicalSkillName(solution?.name || "") === canonicalName;
    });
    const solutionId = String(
      match?.id || match?.solution_id || match?.uuid || "",
    ).trim();
    if (!solutionId) return "";
    try {
      const bundleRes = await api.getBundle?.(solutionId);
      const bundle = normalizeSolutionBundle(bundleRes?.data);
      const payloadName = canonicalSkillName(
        bundle?.payload?.name || bundle?.payload?.skill_name || "",
      );
      if (
        bundleRes?.success &&
        bundle?.type === TYPE_SKILL &&
        payloadName === canonicalName
      ) {
        return solutionId;
      }
      console.warn(
        `[Agents] Ignoring owned skill listing "${solutionId}" because its bundle does not match "${canonicalName}"`,
      );
    } catch (error) {
      console.warn(
        `[Agents] Failed to verify owned skill listing "${solutionId}"`,
        error,
      );
    }
    return "";
  }

  async function resolveInstalledMarketplaceSkillSource(api, skill, canonicalName) {
    if (
      !api?.getInstalledSkillSource ||
      skill?.source !== "marketplace" ||
      skill?.marketplace_id !== "ai-marketplace" ||
      !canonicalName
    ) {
      return null;
    }
    try {
      const res = await api.getInstalledSkillSource(canonicalName);
      const source = res?.success ? res.source : null;
      const solutionId = String(source?.solutionId || "").trim();
      if (!solutionId) return null;
      return { ...source, solutionId };
    } catch (error) {
      console.warn(
        `[Agents] Failed to resolve installed marketplace skill source for "${canonicalName}"`,
        error,
      );
      return null;
    }
  }

  // Reference-only dependent-skill publishing (user policy): dependencies are
  // NEVER published as copies — installed copies resolve to fully-qualified
  // references (a Solutions listing id, or the git marketplace's durable
  // source spec so installers auto-provision it), and only the viewer's OWN
  // user skills publish/update their listings. Resolution is a pure,
  // zero-write planning pass (it also powers the publish modal's provenance
  // summary); execution runs only on a clean plan, so a failing skill cannot
  // leave partial marketplace state.
  // `probeAudience` (an email array, [] = public) opts into the ONE-shot
  // owner-scoped listing preflight: liveness + ACL drift ride back on each
  // plan as `plan.listing`, and the submit-time liveness check consumes them
  // instead of probing again. Callers that omit it keep the zero-remote
  // resolve contract.
  async function resolveDependentSkillPlans(skillIds, { probeAudience } = {}) {
    const api = window.electronAPI?.aiMarketplace;
    const ids = Array.isArray(skillIds) ? skillIds.filter(Boolean) : [];
    if (!api || !ids.length) return { plans: [], errors: [] };

    // One-shot local context, fetched in parallel: the skills catalog, the
    // marketplaces registry (git sources + installed records), the full
    // skill-link map, and the author identity.
    const [skillsRes, marketplacesRes, linksRes, authorRes] = await Promise.all([
      window.electronAPI?.getSkills?.().catch(() => null),
      window.electronAPI?.getMarketplaces?.().catch(() => null),
      api.listSkillLinks?.().catch(() => null),
      window.electronAPI?.getUsername?.().catch(() => null),
    ]);
    const skillsByName = new Map();
    if (skillsRes?.success) {
      for (const skill of skillsRes.skills || []) {
        if (!skill?.name) continue;
        skillsByName.set(skill.name, skill);
        const canonicalName = canonicalSkillName(skill.name);
        if (canonicalName && !skillsByName.has(canonicalName)) {
          skillsByName.set(canonicalName, skill);
        }
      }
    }
    const marketplacesById = new Map();
    // Dual-key record index: the fully-qualified id always wins, and the
    // legacy 2-segment leaf key resolves only while unoccupied — two plugins
    // sharing a leaf id can no longer publish the wrong skillPath.
    const installedByKey = new Map();
    if (marketplacesRes?.success) {
      for (const entry of marketplacesRes.data?.marketplaces || []) {
        if (entry?.id) marketplacesById.set(entry.id, entry);
      }
      for (const record of marketplacesRes.data?.installedSkills || []) {
        if (!record?.marketplaceId || !record?.skillId) continue;
        const leaf = canonicalSkillName(record.skillId);
        const fqn = record.pluginName
          ? `${record.marketplaceId}/${record.pluginName}/${leaf}`
          : `${record.marketplaceId}/${leaf}`;
        installedByKey.set(fqn, record);
        const leafKey = `${record.marketplaceId}/${leaf}`;
        if (!installedByKey.has(leafKey)) {
          installedByKey.set(leafKey, record);
        }
      }
    }
    const linksByName =
      linksRes?.success && linksRes.links && typeof linksRes.links === "object"
        ? linksRes.links
        : {};
    const author = (authorRes && authorRes.username) || "unknown";

    const buildSkillBundleInput = async (skill, canonicalName) => {
      const bundleRes = await api.buildPublishBundle({
        type: "skills",
        skill: {
          name: canonicalName,
          path: skill.skill_path,
          git_url: skill.git_url || skill.marketplace_url || null,
          git_ref: skill.git_ref || "main",
          git_subpath: skill.git_subpath || "",
          required_mcp_servers: skill.required_mcp_servers || [],
        },
      });
      if (!bundleRes?.success) {
        throw new Error(bundleRes?.error || "Failed to build skill bundle");
      }
      const bundle = bundleRes.data;
      return {
        name: bundle.payload.name || canonicalName,
        // Hoist the authored display name so the LISTING carries it (read
        // layer + discover cards) — parity with the chat publish path, which
        // spreads the whole bundle payload top-level.
        ...(bundle.payload.display_name
          ? { display_name: bundle.payload.display_name }
          : {}),
        description:
          bundle.payload.description ||
          skill.description ||
          `Agent Skill "${canonicalName}" published via Portico.`,
        author,
        submitted_by: author,
        detail_url: "https://solutions.sandbox.example.invalid/?type=skills",
        type: "skills",
        bundle,
      };
    };

    // Dedup by canonical name BEFORE the parallel pass.
    const seenCanonicalSkillNames = new Set();
    const targets = [];
    for (const skillId of ids) {
      const requestedCanonicalName = canonicalSkillName(skillId);
      if (
        !requestedCanonicalName ||
        seenCanonicalSkillNames.has(requestedCanonicalName)
      ) {
        continue;
      }
      const skill =
        skillsByName.get(skillId) || skillsByName.get(requestedCanonicalName);
      if (!skill || !skill.skill_path) continue; // unresolvable: keeps only its skill_id
      const canonicalName = canonicalSkillName(skill.name) || requestedCanonicalName;
      if (seenCanonicalSkillNames.has(canonicalName)) continue;
      seenCanonicalSkillNames.add(requestedCanonicalName);
      seenCanonicalSkillNames.add(canonicalName);
      // displayName stays the PURE authored/slug name — it feeds bundle-ref
      // display_name and report rows. The "Plugin → Skill" reading is
      // composed at render time from pluginName.
      targets.push({
        skill,
        canonicalName,
        displayName: skill.display_name || canonicalName,
        pluginName: skill.plugin_name || null,
      });
    }

    // Pre-warm the (session-memoized) owned-listings lookup so its single
    // round-trip overlaps the local per-skill work below. When every skill
    // is linked, installed, or built-in, the whole resolve is local.
    if (
      targets.some(
        ({ skill, canonicalName }) =>
          skill.source === "user" && !linksByName[canonicalName]?.solutionId,
      )
    ) {
      void getOwnedSkillListings(api);
    }

    const errors = [];
    const resolved = await Promise.all(
      targets.map(async ({ skill, canonicalName, displayName, pluginName }) => {
        try {
          // Built-in skills ship with the app: id-only, never published or
          // referenced (also prevents ever matching a same-named foreign
          // listing).
          if (skill.source === "system") {
            return { action: "system", provenance: "system", canonicalName, displayName, pluginName };
          }
          const installedSource = await resolveInstalledMarketplaceSkillSource(
            api,
            skill,
            canonicalName,
          );
          if (installedSource?.solutionId) {
            return {
              action: "reference",
              provenance: "installed-solution",
              canonicalName,
              displayName,
              pluginName,
              solutionId: installedSource.solutionId,
            };
          }
          if (skill.source === "marketplace") {
            // Provenance gate: skills from non-qualifying marketplaces can be
            // USED locally but never published into a shared agent — the
            // whole point is stopping the spread of untrusted marketplaces.
            if (skill.agent_attachable === false) {
              throw new Error(
                `comes from the unapproved marketplace "${skill.marketplace_name || skill.marketplace_id || "unknown"}". Remove this skill to publish.`,
              );
            }
            // Git-marketplace copy: reference its durable origin so installers
            // auto-provision the marketplace. Pure local joins — zero
            // marketplace reads. FQN lookup first; the unoccupied-leaf
            // fallback covers legacy 2-segment ids.
            const entry = marketplacesById.get(skill.marketplace_id);
            const record =
              installedByKey.get(skill.name) ||
              installedByKey.get(`${skill.marketplace_id}/${canonicalName}`);
            if (!entry?.source || !record?.skillPath) {
              throw new Error(
                "cannot reconstruct this skill's marketplace origin (its marketplace entry or installed record is missing)",
              );
            }
            return {
              action: "reference-git",
              provenance: "installed-git",
              canonicalName,
              displayName,
              marketplaceName: entry.name || entry.id,
              marketplaceSource: entry.source,
              skillPath: record.skillPath,
              skillSource: record.skillSource || null,
              pluginName: record.pluginName || null,
            };
          }
          // User-owned skill.
          const link = linksByName[canonicalName] || null;
          const linkedSolutionId = String(link?.solutionId || "").trim();
          if (linkedSolutionId && link?.hasLocalChanges !== true) {
            // Clean linked skill: pure local classification. The listing's
            // liveness is verified at publish time instead — execute probes
            // clean references in one parallel wave and marks dead links
            // dirty so the next attempt takes the update→self-heal path.
            return {
              action: "reference",
              provenance: "user-linked-clean",
              canonicalName,
              displayName,
              pluginName,
              solutionId: linkedSolutionId,
            };
          }
          const solutionInput = await buildSkillBundleInput(skill, canonicalName);
          if (linkedSolutionId) {
            return {
              action: "update",
              provenance: "user-linked-dirty",
              canonicalName,
              displayName,
              pluginName,
              solutionId: linkedSolutionId,
              solutionInput,
            };
          }
          // Unlinked user skill: the adopt-if-owned decision comes from the
          // viewer's own published listings (session-memoized, one page) —
          // the multi-second name search is gone. Foreign name collisions
          // fail closed at publish time on the name-availability guard.
          const { solutions: ownedSolutions, failed: ownedLookupFailed } =
            await getOwnedSkillListings(api);
          if (ownedLookupFailed) {
            throw new Error(
              "could not verify ownership of your Marketplace listings; retry when the AI Marketplace is reachable",
            );
          }
          const adoptableSolutionId = await findAdoptableOwnedSkillSolution(
            api,
            canonicalName,
            ownedSolutions,
          );
          if (adoptableSolutionId) {
            return {
              action: "adopt-update",
              provenance: "user-adopt",
              canonicalName,
              displayName,
              pluginName,
              solutionId: adoptableSolutionId,
              solutionInput,
            };
          }
          return {
            action: "publish-new",
            provenance: "user-new",
            canonicalName,
            displayName,
            pluginName,
            solutionInput,
          };
        } catch (error) {
          console.error(
            `[Agents] Failed to resolve dependent skill "${canonicalName}"`,
            error,
          );
          errors.push({
            skillId: canonicalName,
            error: error?.message || String(error),
          });
          return null;
        }
      }),
    );
    const plans = sortSkillPlansForDisplay(resolved.filter(Boolean));
    await attachListingPreflight(plans, probeAudience);
    return { plans, errors };
  }

  // Owner-scoped listing preflight (moved liveness wave): one parallel GET per
  // referenced/updated listing, attached as plan.listing. Fail-open — a probe
  // failure leaves plans without listings and the submit-time fallback probes
  // exactly as before this existed.
  const LISTING_PREFLIGHT_PROVENANCES = new Set([
    "user-linked-clean",
    "user-linked-dirty",
    "user-adopt",
  ]);
  async function attachListingPreflight(plans, probeAudience) {
    if (probeAudience === undefined) return;
    const probePlans = (plans || []).filter(
      (plan) =>
        plan.solutionId && LISTING_PREFLIGHT_PROVENANCES.has(plan.provenance),
    );
    if (!probePlans.length) return;
    const preflight =
      window.electronAPI?.aiMarketplace?.preflightPublishListings;
    if (typeof preflight !== "function") return;
    try {
      const res = await preflight({
        solutionIds: [...new Set(probePlans.map((plan) => plan.solutionId))],
        aclAudience: Array.isArray(probeAudience) ? probeAudience : null,
      });
      if (!res?.success) return;
      const byId = new Map(
        (res.data?.listings || []).map((entry) => [entry.solution_id, entry]),
      );
      for (const plan of probePlans) {
        const listing = byId.get(plan.solutionId);
        if (listing) plan.listing = listing;
      }
    } catch (error) {
      console.warn("[Agents] listing preflight failed (advisory only)", error);
    }
  }

  // A progress callback is UI-only: it must never be able to abort or reorder
  // marketplace writes, so every emission is swallowed on error.
  function reportSkillPublishProgress(onProgress, event) {
    if (typeof onProgress !== "function") return;
    try {
      onProgress(event);
    } catch (error) {
      console.error("[Agents] skill publish progress callback failed", error);
    }
  }

  // Liveness wave for clean references: resolve no longer probes linked
  // listings (modal-open speed), so verify them here in ONE parallel settled
  // pass before any write. Positive deletion (tombstone or 404/absent) marks
  // the link dirty so the next attempt takes the update→self-heal path; a
  // transient failure aborts retryably WITHOUT faking "Unpublished changes".
  // A fully-alive wave emits no progress events.
  async function assertCleanReferenceListingsAlive(api, plans, onProgress) {
    const cleanPlans = (plans || []).filter(
      (plan) =>
        plan.action === "reference" &&
        plan.provenance === "user-linked-clean" &&
        plan.solutionId,
    );
    if (!cleanPlans.length || typeof api?.getSolution !== "function") return;
    // Plans carrying a modal-open preflight result answer from it (no second
    // network wave); plans without one fall back to the live probe.
    const preflightBySolutionId = new Map();
    const needProbe = [];
    for (const plan of cleanPlans) {
      const state = String(plan.listing?.state || "");
      if (state === "alive" || state === "deleted") {
        preflightBySolutionId.set(plan.solutionId, state);
      } else {
        needProbe.push(plan.solutionId);
      }
    }
    const solutionIds = [...new Set(needProbe)];
    const probes = await Promise.all(
      solutionIds.map(async (solutionId) => {
        try {
          const res = await api.getSolution(solutionId);
          const status = String(res?.data?.status || "").trim().toLowerCase();
          if (res?.success && res.data && status !== "deleted") {
            return { solutionId, state: "alive" };
          }
          const code = String(res?.code || "").trim();
          const positivelyGone =
            (res?.success && status === "deleted") ||
            code === "not_found" ||
            code === "solution_not_found" ||
            res?.status === 404;
          return { solutionId, state: positivelyGone ? "deleted" : "unknown" };
        } catch {
          return { solutionId, state: "unknown" };
        }
      }),
    );
    for (const [solutionId, state] of preflightBySolutionId) {
      probes.push({ solutionId, state });
    }
    const deadIds = new Set(
      probes.filter((probe) => probe.state === "deleted").map((p) => p.solutionId),
    );
    const unknownIds = probes
      .filter((probe) => probe.state === "unknown")
      .map((probe) => probe.solutionId);
    if (deadIds.size || unknownIds.length) {
      logMarketplacePublish("execute:liveness", {
        probed: probes.length,
        deadSolutionIds: [...deadIds],
        unknownSolutionIds: unknownIds,
      });
    }
    if (deadIds.size) {
      const deadPlans = cleanPlans.filter((plan) => deadIds.has(plan.solutionId));
      for (const plan of deadPlans) {
        try {
          await api.markSkillLinkDirty?.(plan.canonicalName);
        } catch {
          // Best-effort: the aggregate error below still blocks the publish.
        }
        reportSkillPublishProgress(onProgress, {
          phase: "skill:error",
          plan,
          error: new Error("marketplace listing no longer exists"),
        });
      }
      throw new Error(
        `These skills' marketplace listings no longer exist: ${deadPlans
          .map((plan) => plan.canonicalName)
          .join(", ")}. Publish again to recreate them. No marketplace changes were made.`,
      );
    }
    if (probes.some((probe) => probe.state === "unknown")) {
      throw new Error(
        "Could not verify this agent's published skill listings; retry when the AI Marketplace is reachable. No marketplace changes were made.",
      );
    }
  }

  // Phase 2 — execute in plan order; the first failure aborts the rest and
  // reports what was already written so the user knows the marketplace state.
  // Emits skill:start/skill:done/skill:error per plan — including the instant
  // no-op plans, so every provenance row gets a completion mark.
  async function executeDependentSkillPlans(
    plans,
    { allowedEmails = null, onProgress = null } = {},
  ) {
    // Marketplace writes may happen below: the owned-listings memo is stale
    // after ANY run, success or failure.
    try {
      return await executeDependentSkillPlansInner(plans, {
        allowedEmails,
        onProgress,
      });
    } finally {
      invalidateMarketplaceSkillLookups("execute");
    }
  }

  // Marketplace writes run in small parallel batches (the slow network
  // part); local bookkeeping — skill links, refs, progress marks — applies
  // strictly in PLAN order after each batch settles, so refs stay
  // deterministic, concurrent setSkillLink writes never race, and every
  // successful write gets linked even when a batch-mate fails (no limbo
  // listings). Failures do NOT abort the sweep: remaining batches still run
  // so one click makes maximal progress (Zach's smart-slides incident took
  // 3-4 clicks because each attempt died at its first failed batch), and the
  // aggregate error afterwards names every failed skill. The agent write
  // still only happens when the sweep finished clean.
  const DEPENDENT_SKILL_PUBLISH_BATCH_SIZE = 3;

  // One publish-envelope row per dependent skill: identity + outcome +
  // marketplace coordinates. Chat models copy solution ids straight from
  // these rows for follow-up calls, so rows must agree with the refs the
  // agent bundle embeds.
  // Authored display name for bundle refs (omitted when it just restates the
  // id) — installers render it verbatim on machines that lack the skill.
  function refDisplayNameFields(plan) {
    return plan.displayName && plan.displayName !== plan.canonicalName
      ? { display_name: plan.displayName }
      : {};
  }

  function dependentSkillReportRow(plan, result) {
    const row = { skill_id: plan.canonicalName };
    if (plan.displayName && plan.displayName !== plan.canonicalName) {
      row.display_name = plan.displayName;
    }
    if (result.kind === "written") {
      row.outcome = result.outcome;
      row.solution_id = result.solutionId;
      return row;
    }
    if (plan.action === "reference-git") {
      row.outcome = "gitReferenced";
      const source = plan.marketplaceSource;
      row.git_origin = {
        marketplace_name: plan.marketplaceName || "",
        // Structured github sources flatten to their repo URL: the envelope
        // row identifies the origin, while the agent bundle ref keeps the
        // full source object for installs.
        marketplace_source:
          typeof source === "string" ? source : source?.repoUrl || source?.repo || "",
        skill_path: plan.skillPath || "",
      };
      return row;
    }
    if (plan.action === "reference") {
      row.outcome =
        plan.provenance === "user-linked-clean"
          ? result.visibilitySynced
            ? "visibility_updated"
            : "unchanged"
          : "referenced";
      row.solution_id = plan.solutionId;
      return row;
    }
    row.outcome = "system";
    return row;
  }

  async function executeDependentSkillPlansInner(
    plans,
    { allowedEmails = null, onProgress = null } = {},
  ) {
    const api = window.electronAPI?.aiMarketplace;
    const summary = createDependentSkillPublishSummary();
    const refs = [];
    const skillReports = [];
    const written = [];
    const failures = [];
    await assertCleanReferenceListingsAlive(api, plans, onProgress);
    const queue = [...(plans || [])];
    while (queue.length) {
      const batch = queue.splice(0, DEPENDENT_SKILL_PUBLISH_BATCH_SIZE);
      for (const plan of batch) {
        reportSkillPublishProgress(onProgress, { phase: "skill:start", plan });
      }
      const settled = await Promise.allSettled(
        batch.map(async (plan) => {
          if (plan.action === "system") return { kind: "none" };
          if (plan.action === "reference") {
            let visibilitySynced = false;
            if (
              plan.provenance === "user-linked-clean" &&
              plan.listing?.acl_sync?.changed &&
              typeof api?.syncSolutionAcl === "function"
            ) {
              // Content is current but the listing's audience is behind the
              // agent's: push the visibility-only union update (recomputed in
              // main against the LIVE listing, the preflight only decided to
              // try). Failures abort like any other dependent-skill write.
              const syncRes = await api.syncSolutionAcl(plan.solutionId, {
                localSkillId: plan.canonicalName,
                aclAudience: Array.isArray(allowedEmails) ? allowedEmails : null,
              });
              if (!syncRes?.success) {
                throw new Error(
                  marketplaceResultError(
                    syncRes,
                    "Failed to update the listing's visibility",
                  ),
                );
              }
              visibilitySynced = Boolean(syncRes.data?.changed);
            }
            if (plan.provenance !== "user-linked-clean") summary.referenced += 1;
            else if (visibilitySynced) summary.visibilityUpdated += 1;
            else summary.unchanged += 1;
            return {
              kind: "ref",
              visibilitySynced,
              ref: {
                skill_id: plan.canonicalName,
                kind: "solution",
                solution_id: plan.solutionId,
                ...refDisplayNameFields(plan),
              },
            };
          }
          if (plan.action === "reference-git") {
            summary.gitReferenced += 1;
            return {
              kind: "ref",
              ref: {
                skill_id: plan.canonicalName,
                kind: "git-marketplace",
                solution_id: null,
                ...refDisplayNameFields(plan),
                marketplace: {
                  name: plan.marketplaceName || "",
                  source: plan.marketplaceSource,
                },
                skill_path: plan.skillPath || "",
                skill_source: plan.skillSource || null,
                // Plugin-layout installs land at the same plugin path on the
                // installer's machine.
                plugin_name: plan.pluginName || null,
              },
            };
          }
          const writtenResult = await executeDependentSkillPlan(
            api,
            plan,
            summary,
            { allowedEmails },
          );
          return {
            kind: "written",
            solutionId: writtenResult.solutionId,
            outcome: writtenResult.outcome,
          };
        }),
      );

      for (const [index, outcome] of settled.entries()) {
        const plan = batch[index];
        if (outcome.status === "fulfilled") {
          const result = outcome.value;
          if (result.kind === "ref") refs.push(result.ref);
          if (result.kind === "written") {
            await api.setSkillLink(plan.canonicalName, result.solutionId);
            refs.push({
              skill_id: plan.canonicalName,
              kind: "solution",
              solution_id: result.solutionId,
              ...refDisplayNameFields(plan),
            });
            written.push(plan.canonicalName);
            logMarketplacePublish("execute:result", {
              skillId: plan.canonicalName,
              action: plan.action,
              solutionId: result.solutionId,
              outcome: result.outcome,
            });
          }
          skillReports.push(dependentSkillReportRow(plan, result));
          reportSkillPublishProgress(onProgress, { phase: "skill:done", plan });
          continue;
        }
        const error = outcome.reason;
        reportSkillPublishProgress(onProgress, {
          phase: "skill:error",
          plan,
          error,
        });
        logMarketplacePublish("execute:result", {
          skillId: plan.canonicalName,
          action: plan.action,
          solutionId: plan.solutionId || null,
          outcome: "failed",
          errorMessage: String(error?.message || error).slice(0, 200),
        });
        console.error(
          `[Agents] Failed to publish dependent skill "${plan.canonicalName}"`,
          error,
        );
        failures.push({ plan, error });
      }
    }
    if (failures.length) {
      const alreadyWritten = written.length
        ? ` Skills already published to the marketplace before the failure: ${written.join(", ")}.`
        : "";
      const detail = failures
        .map(({ plan, error }) => `${plan.canonicalName} (${error?.message || error})`)
        .join(", ");
      throw new Error(
        `Failed to publish dependent skill solutions: ${detail}.${alreadyWritten}`,
      );
    }
    return { refs, summary, skills: skillReports };
  }

  // Composition for callers without the modal's pre-resolved plan (the
  // editor-save sync path). Resolution errors abort before the first write.
  async function publishDependentSkills(
    skillIds,
    { allowedEmails = null, resolvedSkillPlan = null, onProgress = null } = {},
  ) {
    if (resolvedSkillPlan) {
      return executeDependentSkillPlans(resolvedSkillPlan, {
        allowedEmails,
        onProgress,
      });
    }
    const { plans, errors } = await resolveDependentSkillPlans(skillIds, {
      probeAudience: Array.isArray(allowedEmails) ? allowedEmails : null,
    });
    if (errors.length) {
      const detail = errors
        .map(({ skillId, error }) => `${skillId} (${error})`)
        .join(", ");
      throw new Error(
        `Cannot publish this agent's dependent skills: ${detail}. No marketplace changes were made.`,
      );
    }
    return executeDependentSkillPlans(plans, { allowedEmails, onProgress });
  }
  // Executes one resolved dependent-skill plan and returns the solution id
  // the skill should be linked to plus the outcome label for the publish
  // envelope. Never touches solutions the viewer does not own: adoption
  // requires prior resolve-phase ownership verification, and duplicate-name
  // rejections surface as errors instead of silently referencing a foreign
  // listing.
  async function executeDependentSkillPlan(api, plan, summary, { allowedEmails = null } = {}) {
    // Visibility is decided in the main process (ai-marketplace-acl.js): new
    // listings inherit the agent's audience; updates widen the listing's
    // CURRENT marketplace ACL to include it (union, public absorbs). The
    // renderer only forwards the audience — it never computes ACLs.
    const aclAudience = Array.isArray(allowedEmails) ? allowedEmails : null;
    const publishNewSkill = async () => {
      const res = await api.publish(plan.solutionInput, {
        localSkillId: plan.canonicalName,
        aclAudience,
      });
      if (!res?.success) {
        if (isDuplicateMarketplaceSkillError(res)) {
          throw new Error(
            `the Marketplace already has a solution named "${plan.canonicalName}" that you do not own; rename the skill or remove it from the agent`,
          );
        }
        throw new Error(res?.error || "Failed to publish skill solution");
      }
      const newId = res.data?.id || res.data?.solution_id || res.data?.uuid;
      if (!newId) {
        throw new Error("Marketplace did not return a skill solution id");
      }
      return newId;
    };

    if (plan.action === "publish-new") {
      const solutionId = await publishNewSkill();
      summary.published += 1;
      return { solutionId, outcome: "published" };
    }
    if (plan.action === "adopt-update") {
      // Reconnect the lost link BEFORE updating so the provenance gate sees a
      // matching linked solution; ownership was verified during resolve.
      await api.setSkillLink(plan.canonicalName, plan.solutionId);
      try {
        const updateRes = await api.update(plan.solutionId, plan.solutionInput, {
          localSkillId: plan.canonicalName,
          aclAudience,
        });
        if (!updateRes?.success) {
          throw new Error(
            marketplaceResultError(updateRes, "Failed to update skill solution"),
          );
        }
      } catch (error) {
        // Roll the adoption back so a failed update cannot leave the skill
        // linked to a listing it never synced with.
        await api.clearSkillLink?.(plan.canonicalName).catch?.(() => {});
        throw error;
      }
      summary.adopted += 1;
      return { solutionId: plan.solutionId, outcome: "adopted" };
    }
    // action === "update": the skill was already linked to this solution.
    const updateRes = await api.update(plan.solutionId, plan.solutionInput, {
      localSkillId: plan.canonicalName,
      aclAudience,
    });
    if (updateRes?.success) {
      summary.updated += 1;
      return { solutionId: plan.solutionId, outcome: "updated" };
    }
    const missingSolution =
      updateRes?.code === "not_found" ||
      // Soft-deleted listings reject the update with "already absent" under
      // this code (no HTTP status) — without matching it the dirty link
      // would loop on the same error forever instead of healing.
      updateRes?.code === "solution_not_found" ||
      updateRes?.status === 404;
    if (missingSolution) {
      // The linked listing vanished server-side: self-heal by publishing new.
      summary.repaired += 1;
      logMarketplacePublish("push:skill-link-stale", {
        skillId: plan.canonicalName,
        solutionId: plan.solutionId,
      });
      // Drop the dead link first: the publish gate rejects creating a new
      // listing for a still-linked skill ("republish using that solution
      // id"). The successful publish relinks to the new listing.
      await api.clearSkillLink?.(plan.canonicalName).catch?.(() => {});
      const solutionId = await publishNewSkill();
      summary.published += 1;
      return { solutionId, outcome: "repaired" };
    }
    throw new Error(
      marketplaceResultError(updateRes, "Failed to update skill solution"),
    );
  }

  // Build a bundle from the just-saved form values and either create or update
  // the marketplace solution. Records/refreshes the local link.
  async function pushAgentToMarketplace({
    localId,
    solutionId,
    args,
    resolvedSkillPlan = null,
    onProgress = null,
  }) {
    logMarketplacePublish("push:start", {
      localId,
      hasLinkedSolution: Boolean(solutionId),
      name: args?.name || "",
    });
    const hasKeyRes = await window.electronAPI?.aiMarketplace?.hasApiKey();
    logMarketplacePublish("push:api-key-check", {
      localId,
      hasKey: Boolean(hasKeyRes?.hasKey),
    });
    if (!hasKeyRes?.hasKey) {
      throw new Error(
        "AI Marketplace API key is required for marketplace updates. Set it in Settings.",
      );
    }
    const allowedEmails = assertAllowedEmailsValid(args.allowed_emails);
    const skillPublish = await publishDependentSkills(args.skill_ids || [], {
      allowedEmails,
      resolvedSkillPlan,
      onProgress,
    });
    const skillRefs = Array.isArray(skillPublish?.refs) ? skillPublish.refs : [];
    const skillReports = Array.isArray(skillPublish?.skills)
      ? skillPublish.skills
      : [];
    const skillPublishSummary =
      skillPublish?.summary || createDependentSkillPublishSummary();
    logMarketplacePublish("push:skills-published", {
      localId,
      skillCount: skillRefs.length,
      skillPublishSummary,
    });
    // All dependent-skill work is done; the only remaining step is the agent
    // itself. The modal moves its progress cue onto the Publish button here.
    reportSkillPublishProgress(onProgress, { phase: "agent:start" });
    const agentForBundle = {
      name: args.name,
      description: args.description,
      base_model_id: args.base_model_id,
      system_prompt: args.system_prompt,
      allowed_emails: allowedEmails,
      skill_ids: canonicalSkillIds(args.skill_ids),
      skill_refs: skillRefs,
      tool_server_ids: args.tool_server_ids,
      reasoning_effort: args.reasoning_effort,
    };
    const bundleRes = await window.electronAPI.aiMarketplace.buildPublishBundle({
      type: TYPE_AGENTS,
      agent: agentForBundle,
    });
    if (!bundleRes?.success) {
      throw new Error(bundleRes?.error || "Failed to build bundle");
    }
    const bundle = bundleRes.data;
    logMarketplacePublish("push:bundle-built", {
      localId,
      hasBundle: Boolean(bundle),
      type: bundle?.type || "",
      payloadName: bundle?.payload?.name || "",
    });
    const authorRes = await window.electronAPI?.getUsername?.();
    const author = (authorRes && authorRes.username) || "unknown";
    const detailUrl = `https://solutions.sandbox.example.invalid/?type=${encodeURIComponent(
      bundle?.type || TYPE_AGENTS,
    )}`;
    const solutionInput = {
      name: bundle.payload.name,
      description: bundle.payload.description || bundle.payload.name,
      author,
      allowed_emails: allowedEmails,
      // Owner identity. The marketplace PUT guard rejects updates whose
      // submitted_by does not match the stored owner, so this must be sent on
      // both the update and create branches or the real owner is also blocked.
      submitted_by: author,
      detail_url: detailUrl,
      type: bundle.type,
      bundle,
      // Flattened card facts ride top-level on the listing so display
      // surfaces (e.g. the unpublish confirmation card) can render the model/
      // effort/skills/tools without fetching the bundle — parity with the
      // legacy main-side publish path. The system prompt stays bundle-only.
      base_model_id: bundle.payload.base_model_id,
      reasoning_effort: bundle.payload.reasoning_effort,
      skill_ids: bundle.payload.skill_ids,
      skill_refs: bundle.payload.skill_refs,
      tool_server_ids: bundle.payload.tool_server_ids,
    };
    // Create a brand-new marketplace solution and return its id. This is used
    // only for a first publish; rejected republish attempts fail closed.
    const publishNewSolution = async () => {
      logMarketplacePublish("push:publish:start", { localId });
      const publishRes = await window.electronAPI.aiMarketplace.publish(solutionInput, {
        localAgentId: localId,
      });
      logMarketplacePublish("push:publish:result", {
        localId,
        success: Boolean(publishRes?.success),
        status: publishRes?.publishStatus?.status || publishRes?.data?.status || "",
        error: publishRes?.success ? undefined : publishRes?.error || "",
      });
      if (!publishRes?.success) {
        throw new Error(
          marketplaceResultError(publishRes, "Failed to publish marketplace solution"),
        );
      }
      const publishStatus = marketplacePublishStatus(publishRes);
      const newId = publishStatus.id;
      if (!newId) {
        throw new Error("Marketplace did not return a solution id");
      }
      return { solutionId: newId, publishStatus };
    };

    let resolvedSolutionId = solutionId;
    let resolvedPublishStatus = null;
    if (solutionId) {
      logMarketplacePublish("push:update:start", { localId, solutionId });
      const updateRes = await window.electronAPI.aiMarketplace.update(
        solutionId,
        solutionInput,
        { localAgentId: localId },
      );
      logMarketplacePublish("push:update:result", {
        localId,
        solutionId,
        success: Boolean(updateRes?.success),
        status: updateRes?.publishStatus?.status || updateRes?.data?.status || "",
        code: updateRes?.success ? undefined : updateRes?.code || "",
        error: updateRes?.success ? undefined : updateRes?.error || "",
      });
      if (!updateRes?.success) {
        throw new Error(
          marketplaceResultError(updateRes, "Failed to update marketplace solution"),
        );
      } else {
        resolvedPublishStatus = marketplacePublishStatus(updateRes, solutionId);
      }
    } else {
      const published = await publishNewSolution();
      resolvedSolutionId = published.solutionId;
      resolvedPublishStatus = published.publishStatus;
    }
    setStoredAllowedEmails(localId, allowedEmails);
    logMarketplacePublish("push:link-saved", {
      localId,
      solutionId: resolvedSolutionId,
      status: resolvedPublishStatus?.status || "",
    });
    return {
      solutionId: resolvedSolutionId,
      publishStatus: resolvedPublishStatus,
      skillPublishSummary,
      skills: skillReports,
    };
  }

  // Plan rows that involve no marketplace work: publish actions that only
  // reference existing listings, and install provenances satisfied by what is
  // already on this computer. These render a green check from resolve time.
  const NO_WORK_PUBLISH_ACTIONS = new Set(["system", "reference", "reference-git"]);
  const NO_WORK_INSTALL_PROVENANCES = new Set([
    "local-system",
    "local-user",
    "local-installed",
    "installed-solution-reuse",
    "user-published-reuse",
    "git-reuse-installed",
  ]);

  // Install-modal ordering: group rows by their "What happens" category,
  // action first — what this install will DO (updates, downloads, marketplace
  // adds) reads top-down before the rows that need nothing, with core
  // built-ins last. Alphabetical within each category.
  const INSTALL_PLAN_CATEGORY_RANKS = new Map([
    ["update:refresh", 10],
    ["update:review", 20],
    ["solution-install", 30],
    ["git-install", 40],
    ["git-add-install", 50],
    ["local-user", 60],
    ["user-published-reuse", 70],
    ["local-installed", 80],
    ["installed-solution-reuse", 90],
    ["git-reuse-installed", 100],
    ["local-system", 110],
  ]);
  function sortInstallPlansForDisplay(plans) {
    const rank = (plan) => {
      if (plan?.updateState === "refresh") return INSTALL_PLAN_CATEGORY_RANKS.get("update:refresh");
      if (plan?.updateState === "review") return INSTALL_PLAN_CATEGORY_RANKS.get("update:review");
      const byProvenance = INSTALL_PLAN_CATEGORY_RANKS.get(String(plan?.provenance || ""));
      // Unknown provenances render the default "Will be installed from the
      // Solutions Marketplace" copy — rank them with it.
      return byProvenance ?? INSTALL_PLAN_CATEGORY_RANKS.get("solution-install");
    };
    const label = (plan) =>
      String(plan?.displayName || plan?.canonicalName || plan?.skillId || "");
    return plans.sort(
      (a, b) => rank(a) - rank(b) || label(a).localeCompare(label(b)),
    );
  }

  // Provenance rows for the publish modal: one plain-language line per skill
  // saying exactly what publishing will do to it. Technical identifiers
  // (listing ids, repos) live in hover tooltips only — the visible copy is
  // written for non-technical users.
  function buildSkillProvenanceRowsHtml(resolution, { statusIdPrefix = "" } = {}) {
    const rows = [];
    for (const plan of resolution?.plans || []) {
      const name = escapeHtml(
        skillLabelWithPlugin(
          plan.displayName || plan.canonicalName,
          plan.pluginName || "",
        ),
      );
      let chips = "";
      let actionLine = "";
      let tooltip = "";
      switch (plan.provenance) {
        case "system":
          chips = '<span class="mcp-card-badge badge-core">Core</span>';
          actionLine = "Built into Portico.";
          break;
        case "installed-solution":
          chips = '<span class="mcp-card-badge badge-installed">Installed</span>';
          actionLine =
            'Marketplace install.<span class="agents-publish-skill-action-remedy">Your agent will point at that listing.</span>';
          tooltip = `Solutions Marketplace listing ${plan.solutionId || ""}`;
          break;
        case "installed-git": {
          const source = plan.marketplaceSource || {};
          const repoLabel =
            source.repo || source.projectPath || source.url || "";
          chips = `<span class="mcp-card-badge badge-installed">Installed</span>${gitMarketplaceBadgeHtml()}<span class="mcp-card-badge badge-marketplace-name">${escapeHtml(plan.marketplaceName || "marketplace")}</span>`;
          actionLine = `From the ${escapeHtml(plan.marketplaceName || "git")} marketplace.<span class="agents-publish-skill-action-remedy">Installers get it automatically.</span>`;
          tooltip = repoLabel ? `Marketplace repository: ${repoLabel}` : "";
          break;
        }
        case "user-linked-clean":
          chips =
            '<span class="mcp-card-badge badge-user">User</span><span class="mcp-card-badge badge-published">Published</span>';
          if (plan.listing?.acl_sync?.changed) {
            chips +=
              '<span class="mcp-card-badge badge-unpublished">Visibility</span>';
            actionLine =
              'Published and up to date.<span class="agents-publish-skill-action-remedy">Visibility is out of sync and will be updated to match this agent\'s audience.</span>';
            const audienceLabel = (list) =>
              Array.isArray(list) && list.length
                ? `${list.length} ${list.length === 1 ? "person" : "people"}`
                : "everyone at Portico";
            tooltip = `Solutions Marketplace listing ${plan.solutionId || ""} — currently shared with ${audienceLabel(
              plan.listing.allowed_emails,
            )}; publishing shares it with ${audienceLabel(
              plan.listing.acl_sync.allowed_emails,
            )}.`;
          } else {
            actionLine =
              'Published and up to date.<span class="agents-publish-skill-action-remedy">Nothing to re-upload.</span>';
            tooltip = `Solutions Marketplace listing ${plan.solutionId || ""}`;
          }
          break;
        case "user-linked-dirty":
          chips =
            '<span class="mcp-card-badge badge-user">User</span><span class="mcp-card-badge badge-unpublished">Unpublished changes</span>';
          actionLine =
            "Local changes will be published to your existing listing.";
          tooltip = `Solutions Marketplace listing ${plan.solutionId || ""}`;
          break;
        case "user-adopt":
          chips = '<span class="mcp-card-badge badge-user">User</span>';
          actionLine =
            'Yours on the marketplace.<span class="agents-publish-skill-action-remedy">Will be reconnected and updated.</span>';
          tooltip = `Solutions Marketplace listing ${plan.solutionId || ""}`;
          break;
        case "user-new":
        default:
          chips = '<span class="mcp-card-badge badge-user">User</span>';
          actionLine =
            '<strong>New.</strong><span class="agents-publish-skill-action-remedy">Will be published as your listing.</span>';
          break;
      }
      // No-work rows (referenced as-is, nothing uploaded) show a green check
      // from resolve time; rows with real work start idle and tick on submit.
      // An ACL-drifted clean reference IS work: its visibility-only update
      // ticks like any other write.
      const initialStatus =
        NO_WORK_PUBLISH_ACTIONS.has(plan.action) &&
        !(plan.provenance === "user-linked-clean" && plan.listing?.acl_sync?.changed)
          ? "current"
          : "idle";
      // Optional per-cell ids for hosts that must address status cells without
      // querySelector (the chat batch modal's ticker); prefix keeps ids unique
      // per batch item.
      const statusIdAttr = statusIdPrefix
        ? ` id="${escapeHtml(statusIdPrefix + plan.canonicalName)}"`
        : "";
      rows.push(`
        <tr class="agents-publish-skill-row" data-skill="${escapeHtml(plan.canonicalName)}" data-action="${escapeHtml(plan.action)}"${tooltip ? ` title="${escapeHtml(tooltip)}"` : ""}>
          <td><span class="agents-publish-skill-status"${statusIdAttr} data-status="${initialStatus}"></span></td>
          <td><span class="agents-publish-skill-name">${name}</span></td>
          <td><span class="agents-publish-skill-chips">${chips}</span></td>
          <td><span class="agents-publish-skill-action">${actionLine}</span></td>
        </tr>`);
    }
    for (const failure of resolution?.errors || []) {
      rows.push(`
        <tr class="agents-publish-skill-row agents-publish-skill-row-blocked" data-action="error">
          <td><span class="agents-publish-skill-status" data-status="blocked"></span></td>
          <td><span class="agents-publish-skill-name">${escapeHtml(failure.skillId)}</span></td>
          <td colspan="2"><span class="agents-publish-skill-action">Can't publish yet: ${escapeHtml(failure.error)}</span></td>
        </tr>`);
    }
    if (!rows.length) {
      return '<div class="agents-publish-skill-row"><span class="agents-publish-skill-action">No dependent skills.</span></div>';
    }
    return `
      <table class="agents-publish-skill-table">
        <thead>
          <tr>
            <th>Status</th>
            <th>Skill</th>
            <th>Source</th>
            <th>What happens</th>
          </tr>
        </thead>
        <tbody>${rows.join("")}</tbody>
      </table>`;
  }

  // Fixed, interpolation-free user copy for publish preflight failures: the
  // caught errors can wrap arbitrary text that must never reach the toast.
  const PUBLISH_PREFLIGHT_ERROR_COPY = {
    creator_email_unavailable:
      "Publishing is blocked because your signed-in account did not provide an email address. Sign in again when prompted, or restart the app, then retry.",
    publish_preflight_failed:
      "Publishing could not start due to an unexpected error. Try again; if it keeps failing, restart the app.",
  };

  async function publishAgent(agentId, triggerBtn = null, { backendFlow = null } = {}) {
    logMarketplacePublish("open:publish-flow", {
      agentId,
      backendFlow: Boolean(backendFlow),
    });
    // Backend (chat-initiated) mode: SAME modal + PORTICO-347 pipeline, plus flow
    // completions over the publish-confirm channel, OWUI suppression while
    // visible, focus-on-Cancel, and hide-to-pill/reopen chrome. `settled`
    // guarantees exactly one terminal completion; "publishing" is the
    // non-terminal phase marker that swaps main's deny timer for the publish
    // budget.
    let backendSettled = !backendFlow;
    let settleBackendDone = null;
    // Dev-only auto-approve plumbing (backendFlow.autoApprove rides the
    // agentic payload only on dev builds with the bug-drawer toggle on).
    let backendAutoApproveTimer = null;
    let backendAutoApproveWhenEnabled = false;
    const clearBackendAutoApprove = () => {
      if (backendAutoApproveTimer) {
        clearTimeout(backendAutoApproveTimer);
        backendAutoApproveTimer = null;
      }
      backendAutoApproveWhenEnabled = false;
    };
    const backendDone = backendFlow
      ? new Promise((resolve) => {
          settleBackendDone = resolve;
        })
      : null;
    const settleBackendLocally = () => {
      if (backendSettled) return;
      backendSettled = true;
      settleBackendDone?.();
    };
    const completeBackendFlow = (action, extra = {}) => {
      if (backendSettled) return;
      const terminal = action !== "publishing";
      try {
        window.electronAPI?.notifyAiMarketplacePublishConfirmCompleted?.({
          flow_id: backendFlow.flowId,
          action,
          ...extra,
        });
      } catch {
        /* main's flow timers own the fallback terminal */
      }
      if (terminal) settleBackendLocally();
    };
    const setBackendSuppression = (suppressed) => {
      if (!backendFlow) return;
      try {
        window.setOwuiInteractionSuppressed?.("agents-publish-modal", suppressed);
      } catch {}
      try {
        window.setNativeOverlayInteractionSuppressed?.("agents-publish-modal", suppressed);
      } catch {}
    };
    const teardownBackendSession = () => {
      if (!backendFlow) return;
      clearBackendAutoApprove();
      setBackendSuppression(false);
      if (activeBackendPublishSession?.flowId === backendFlow.flowId) {
        activeBackendPublishSession = null;
      }
    };
    const restoreButton = setBusyButtonState(triggerBtn, "Preparing...");
    let agent;
    try {
      await refreshMarketplaceLinks();
      agent = normalizeAgentRecord(await fetchAgentWithSystemPrompt(agentId));
      agent = await hydrateLinkedAgentAllowedEmails(agent);
      logMarketplacePublish("open:agent-loaded", {
        agentId,
        hasAgent: Boolean(agent),
        hasSystemPrompt: Boolean(agent?.system_prompt),
        hasLinkedSolution: Boolean(agent?.marketplace_solution_id),
      });
    } catch (error) {
      logMarketplacePublish("open:agent-load-failed", {
        agentId,
        error: error?.message || String(error),
      });
      notify(error.message, "error");
      completeBackendFlow("error", { error: error?.message || String(error) });
      restoreButton();
      return;
    }
    // The trigger stays busy through the ENTIRE preflight (API key, audience
    // normalization + identity heal, target inspection, modal open) so the
    // dataset.busy re-entry guard actually prevents duplicate flows, and any
    // rejection lands in ONE catch instead of a discarded promise (PORTICO-414:
    // nine silent restricted-publish attempts).
    let preflightStage = "agent-guard";
    try {
      if (!agent) {
        notify("Agent not found", "error");
        completeBackendFlow("error", { error: `Agent "${agentId}" was not found.` });
        return;
      }
      if (!agent.system_prompt) {
        notify(
          "Could not load this agent's system prompt; cannot publish an empty bundle.",
          "error",
        );
        completeBackendFlow("error", {
          error:
            "Could not load this agent's system prompt; cannot publish an empty bundle.",
        });
        return;
      }

      preflightStage = "api-key";
      const hasKeyRes = await window.electronAPI?.aiMarketplace?.hasApiKey();
      logMarketplacePublish("open:api-key-check", {
        agentId,
        hasKey: Boolean(hasKeyRes?.hasKey),
      });
      if (!hasKeyRes?.hasKey) {
        notify("Set the AI Marketplace API key in Settings before publishing.", "error");
        completeBackendFlow("error", {
          error:
            "The AI Marketplace API key is not set. Ask the user to set it in the Agents tab's Settings, then request the publish again.",
          code: "marketplace_api_key_missing",
        });
        openSettingsModal();
        return;
      }

      preflightStage = "audience";
      // Chat-supplied allowed_emails override the agent's saved visibility for
      // THIS publish only (legacy route semantics); the modal shows the
      // override so the user approves what will actually be shared.
      const allowedEmailsOverride =
        backendFlow &&
        Array.isArray(backendFlow.allowedEmailsOverride) &&
        backendFlow.allowedEmailsOverride.length
          ? backendFlow.allowedEmailsOverride
          : null;
      const effectiveAllowedEmails = allowedEmailsOverride || agent.allowed_emails;
      // ONE audience for the whole flow: the same post-creator-normalized list
      // drives the modal summary, the modal-open listing preflight, and the
      // submit-time writes — so what the user approves is what publishes.
      const publishAudience = (
        await withCreatorAllowedEmail(
          { allowed_emails: effectiveAllowedEmails },
          // Interactive publishes may heal a lost identity all the way through
          // a browser re-auth; chat-initiated flows stop at the silent repair
          // so a browser detour can never race main's confirm/publish timers.
          { heal: backendFlow ? "repair" : "interactive" },
        )
      ).allowed_emails;

      preflightStage = "target-inspect";
      const isLinked = Boolean(agent.marketplace_solution_id);
      const publishTarget = isLinked
        ? await inspectLinkedMarketplacePublishTarget(agent.marketplace_solution_id)
        : null;
      const action = linkedPublishActionLabel(isLinked);
      const visibilitySummary = formatAllowedEmailsVisibilitySummary(publishAudience);
      // Surface audience drift so a stale local draft cannot silently change a
      // listing's marketplace visibility: the form value (the user's latest
      // editor intent) still wins, but the modal states what will change.
      const listingAllowedEmails = publishTarget?.listingAllowedEmails ?? null;
      const sortedEmailKey = (list) => normalizeAllowedEmails(list).sort().join("|");
      const audienceDrifted =
        Array.isArray(listingAllowedEmails) &&
        sortedEmailKey(listingAllowedEmails) !== sortedEmailKey(publishAudience);
      if (audienceDrifted) {
        logMarketplacePublish("open:audience-drift", {
          agentId: agent.id,
          draftCount: normalizeAllowedEmails(publishAudience).length,
          listingCount: listingAllowedEmails.length,
        });
      }
      const audienceDriftNote = audienceDrifted
        ? `<p class="agents-publish-audience-drift"><strong>Note:</strong> the marketplace copy is currently ${escapeHtml(
            listingAllowedEmails.length
              ? `shared with ${listingAllowedEmails.length} ${listingAllowedEmails.length === 1 ? "person" : "people"}`
              : "public",
          )} — publishing will change that to ${escapeHtml(
            visibilitySummary === "Public" ? "public" : visibilitySummary.toLowerCase(),
          )}.</p>`
        : "";
      const summary = `
        <div class="agents-publish-summary">
        <p class="agents-publish-intro">This shares the agent's name, description, system prompt, and configured skills/tools with everyone who can see it on the AI Marketplace.</p>
        <div class="agents-publish-section">
          <div class="agents-publish-section-label">Agent</div>
          <div class="agents-publish-card-preview">${buildAgentCardHtml(agent, { interactive: false })}</div>
          <p><strong>Visibility:</strong> ${escapeHtml(visibilitySummary)}</p>
          ${audienceDriftNote}
          ${
            isLinked
              ? `<p><strong>Solution id:</strong> ${copyableIdBadgeHtml(agent.marketplace_solution_id)}</p>`
              : ""
          }
          ${formatLinkedPublishTargetHtml(publishTarget)}
        </div>
        <div class="agents-publish-section agents-publish-skill-provenance" data-state="loading">
          <div class="agents-publish-section-label">Skills (${(agent.skill_ids || []).length})${window.InfoTooltips?.triggerHtml?.("Without pinned skills, this agent picks its own tools per session — which may vary when others use it. Pin the skills you want to guarantee.") || ""}</div>
          <div class="agents-publish-skill-rows">
            <div class="agents-publish-skill-loading"><span class="agents-publish-skill-spinner" aria-hidden="true"></span>Checking this agent's skills…</div>
          </div>
        </div>
        <div class="agents-publish-section">
          <div class="agents-publish-section-label">System prompt preview</div>
          <pre class="agents-prepublish-pre">${escapeHtml((agent.system_prompt || "").slice(0, 400))}${(agent.system_prompt || "").length > 400 ? "..." : ""}</pre>
        </div>
        <p class="agents-publish-review-note"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg><span>Review for any sensitive information (internal URLs, tokens, customer data) before publishing.</span></p>
        </div>
      `;
      let resolvedSkillPlan = null;
      let planRefreshPromise = null;
      let lastResolveBlockedMessage = "";
      const busyLabel = isLinked ? "Republishing..." : "Publishing...";
      preflightStage = "modal-open";
      const overlay = openModal(`${isLinked ? "Republish" : "Publish"} agent`, summary, {
        headerEyebrow: "AI Marketplace",
        headerSubtitle: agent.name,
        headerIcon: true,
        modalClassName: "agents-modal-wide",
        submitLabel: action,
        submitBusyLabel: busyLabel,
        headerHideButton: Boolean(backendFlow),
        onDismiss: backendFlow
          ? () => {
              teardownBackendSession();
              completeBackendFlow("dismissed");
            }
          : null,
        onSubmit: async () => {
          // A missing plan re-resolves under the button spinner. This covers
          // both a click racing the initial check and a retry after a failed
          // publish, where the fresh plan turns already-published skills into
          // reference no-ops instead of replaying their creation.
          if (resolvedSkillPlan === null) {
            await (planRefreshPromise || refreshSkillPlan());
            if (resolvedSkillPlan === null) {
              throw new Error(
                lastResolveBlockedMessage ||
                  "Still checking this agent's skills — one moment.",
              );
            }
          }
          logMarketplacePublish("submit:clicked", {
            agentId: agent.id,
            action,
            linkedSolutionId: agent.marketplace_solution_id || null,
          });
          // Status cells for the live per-skill ticker, keyed by the raw
          // dataset value so skill names never need selector escaping.
          const statusCells = new Map();
          for (const row of overlay.querySelectorAll(
            ".agents-publish-skill-row[data-skill]",
          )) {
            const cell = row.querySelector(".agents-publish-skill-status");
            if (cell) statusCells.set(row.dataset.skill, cell);
          }
          const setRowStatus = (name, status) => {
            const cell = statusCells.get(name);
            if (cell) cell.dataset.status = status;
          };
          for (const plan of resolvedSkillPlan) {
            // No-work rows keep their green check instead of regressing to
            // "Waiting" (progress events may still tick them to "✓ Done").
            if (NO_WORK_PUBLISH_ACTIONS.has(plan.action)) continue;
            setRowStatus(plan.canonicalName, "pending");
          }
          const onProgress = (event) => {
            if (event.phase === "skill:start") {
              setRowStatus(event.plan?.canonicalName, "working");
              // While skills run, the spinners live in the table rows; the
              // button holds a plain label until only the agent step remains.
              if (submitBtn) submitBtn.textContent = "Publishing skills…";
            } else if (event.phase === "skill:done") {
              setRowStatus(event.plan?.canonicalName, "done");
            } else if (event.phase === "skill:error") {
              setRowStatus(event.plan?.canonicalName, "error");
            } else if (event.phase === "agent:start") {
              if (submitBtn) {
                submitBtn.innerHTML = `<div class="btn-spinner"></div> ${escapeHtml(busyLabel)}`;
              }
            }
          };
          try {
            const publishArgs = {
              name: agent.name,
              description: agent.description,
              base_model_id: agent.base_model_id,
              system_prompt: agent.system_prompt,
              // The exact audience the modal-open preflight used — creator
              // inclusion already applied by withCreatorAllowedEmail up top.
              allowed_emails: publishAudience,
              skill_ids: agent.skill_ids,
              tool_server_ids: agent.tool_server_ids,
              reasoning_effort: agent.reasoning_effort,
            };
            // Backend flows: flip main from the confirm deny-timer to the
            // publish budget BEFORE the first marketplace write, so a slow
            // dependent-skill run can't be auto-denied mid-flight.
            completeBackendFlow("publishing");
            const published = await pushAgentToMarketplace({
              localId: agent.id,
              solutionId: agent.marketplace_solution_id,
              args: publishArgs,
              resolvedSkillPlan,
              onProgress,
            });
            const solutionId = published.solutionId;
            const publishDetails = formatMarketplacePublishDetails(published);
            if (backendFlow) {
              const skillSummary = published.skillPublishSummary || {};
              completeBackendFlow("published", {
                result: {
                  solution_id: solutionId,
                  status: published.publishStatus?.status || "active",
                  has_bundle: published.publishStatus?.has_bundle !== false,
                  action: isLinked ? "updated" : "created",
                  name: agent.name || agent.id,
                  local_agent_id: agent.id,
                  dependent_skills: {
                    published: Number(skillSummary.published) || 0,
                    updated: Number(skillSummary.updated) || 0,
                    adopted: Number(skillSummary.adopted) || 0,
                    referenced: Number(skillSummary.referenced) || 0,
                    unchanged: Number(skillSummary.unchanged) || 0,
                    gitReferenced: Number(skillSummary.gitReferenced) || 0,
                    repaired: Number(skillSummary.repaired) || 0,
                    visibilityUpdated: Number(skillSummary.visibilityUpdated) || 0,
                  },
                  skills: Array.isArray(published.skills) ? published.skills : [],
                  message:
                    (isLinked
                      ? `Marketplace copy updated (solution ${solutionId}).`
                      : `Agent published to the AI Marketplace (solution ${solutionId}).`) +
                    publishDetails,
                },
              });
              teardownBackendSession();
            }
            closeModal();
            notify(
              isLinked
                ? `Marketplace copy updated (solution ${solutionId}).${publishDetails}`
                : `Agent published to marketplace (solution ${solutionId}).${publishDetails}`,
              "success",
            );
            logMarketplacePublish("submit:success", { agentId: agent.id, solutionId });
            // Publishing can create/refresh dependent SKILL listings — the
            // freshness snapshot's link + published-id data is now stale, and
            // an open edit page's provenance table must gain its Published
            // chips immediately (not after the 5-minute attempt TTL).
            invalidateSkillFreshness();
            await loadMyAgents();
            // Save-and-(re)publish lands back on the Agents list once the whole
            // workflow completes — the preceding save left the editor clean, so
            // this close never trips the discard guard. Publishes fired from a
            // card kebab (no editor, or an editor on another agent) skip it,
            // and the refreshes below then keep that page current.
            if (state.editor?.agentId === agent.id) {
              requestCloseAgentEditor();
            }
            refreshEditorPageMarketplaceState();
            if (state.editor?.root) {
              void applyAgentViewSkillStatuses(state.editor.root, state.editor);
            }
          } catch (error) {
            // The plan may be partially consumed (some skills already written),
            // so it cannot be replayed. Completed rows keep their ✓/✕ marks and
            // the next click re-resolves — against fresh remote facts — before
            // publishing anything again.
            resolvedSkillPlan = null;
            planRefreshPromise = null;
            invalidateMarketplaceSkillLookups("failed-submit");
            logMarketplacePublish("submit:failed", {
              agentId: agent.id,
              error: error?.message || String(error),
            });
            // Backend flows hear the FIRST attempt's outcome and are settled by
            // it; the modal stays open (inline error below), so any later manual
            // retry is a plain control-plane publish the chat agent no longer
            // observes.
            completeBackendFlow("publish_failed", {
              error: error?.message || String(error),
              ...(error?.code ? { code: String(error.code) } : {}),
            });
            // Rethrow so openModal's submit wrapper renders the inline modal
            // error and keeps the dialog open; a toast alone auto-dismisses in
            // three seconds and can sit underneath the overlay.
            throw error;
          }
        },
      });
      if (backendFlow && overlay) {
        // Chat overlays the control plane here: swap the OWUI view for its
        // snapshot while the modal is up, and land focus on Cancel so a
        // buffered Enter can never approve an LLM-initiated write (same
        // contract as the legacy confirmation component).
        setBackendSuppression(true);
        overlay.querySelector(".agents-modal-cancel")?.focus?.();
        // Dev-only auto-approve: confirm 1s after the modal comes up. If the
        // dependent-skill plan is still resolving (submit disabled), defer to
        // the enable point in refreshSkillPlan instead of polling — a click on
        // a disabled button would be silently swallowed in a real DOM. Never
        // touches focus (focus stays on Cancel, same as the batch modal).
        const fireBackendAutoApprove = () => {
          backendAutoApproveTimer = null;
          if (backendSettled) return;
          if (document.getElementById("agents-modal-overlay") !== overlay) return;
          if (overlay.style.display === "none") return; // parked behind the pill
          if (overlay.dataset.busy === "true") return;
          const autoSubmitBtn = overlay.querySelector(".agents-modal-submit");
          if (!autoSubmitBtn) return;
          if (autoSubmitBtn.disabled) {
            backendAutoApproveWhenEnabled = true;
            return;
          }
          autoSubmitBtn.click();
        };
        const armBackendAutoApprove = () => {
          if (backendFlow.autoApprove !== true) return;
          if (backendAutoApproveTimer || backendSettled) return;
          backendAutoApproveTimer = setTimeout(fireBackendAutoApprove, 1000);
        };
        armBackendAutoApprove();
        const showModal = () => {
          overlay.style.display = "";
          setBackendSuppression(true);
          armBackendAutoApprove();
        };
        const hideModal = async () => {
          // Stow the modal into the chat composer's approval pill. Inline
          // style, not [hidden]: the overlay class's display:flex would win
          // over the UA hidden rule.
          overlay.style.display = "none";
          clearBackendAutoApprove();
          setBackendSuppression(false);
          try {
            const res = await window.electronAPI?.setNativeInputPresentation?.({
              kind: "marketplace_publish",
              flow_id: backendFlow.flowId,
              presentation: "hidden",
            });
            if (res && res.success === false) showModal();
          } catch {
            showModal(); // never strand an invisible pending approval
          }
        };
        overlay.querySelector(".agents-modal-hide")?.addEventListener("click", () => {
          void hideModal();
        });
        activeBackendPublishSession = {
          flowId: backendFlow.flowId,
          show: showModal,
          onTerminal: () => {
            // Main declared the flow terminal (confirm timeout / publish-budget
            // expiry) — or echoed a terminal we sent, which `settled` absorbs.
            // Pre-decision: drop the modal. Mid-publish (busy): leave the UI to
            // finish and show the true outcome; the chat agent already has its
            // timeout answer.
            if (backendSettled) return;
            settleBackendLocally();
            if (overlay.dataset.busy !== "true") {
              closeModal();
            }
            teardownBackendSession();
          },
        };
      }
      // Pre-flight the dependency plan while the modal is open: the provenance
      // table renders in seconds and the Publish button unlocks only on a clean
      // plan, so blockers surface up front instead of after a long spin. The
      // resolved plan is reused on submit (zero re-resolution).
      const submitBtn = overlay?.querySelector?.(".agents-modal-submit");
      if (submitBtn) submitBtn.disabled = true;
      function refreshSkillPlan() {
        planRefreshPromise = (async () => {
          const resolveStartedAt = Date.now();
          let resolution;
          try {
            resolution = await resolveDependentSkillPlans(agent.skill_ids || [], {
              probeAudience: publishAudience,
            });
          } catch (error) {
            resolution = {
              plans: [],
              errors: [
                { skillId: "resolution", error: error?.message || String(error) },
              ],
            };
          }
          logMarketplacePublish("provenance:resolved", {
            agentId: agent.id,
            ms: Date.now() - resolveStartedAt,
            planCount: resolution.plans.length,
            errorCount: resolution.errors.length,
            plans: resolution.plans.slice(0, 20).map((plan) => ({
              skillId: plan.canonicalName,
              action: plan.action,
              provenance: plan.provenance,
              solutionId: plan.solutionId || null,
            })),
            errors: resolution.errors.slice(0, 20).map((entry) => ({
              skillId: entry.skillId,
              errorMessage: String(entry.error || "").slice(0, 200),
            })),
          });
          if (document.getElementById("agents-modal-overlay") !== overlay) {
            return; // modal closed or replaced while resolving
          }
          const section = overlay.querySelector(".agents-publish-skill-provenance");
          const rows = overlay.querySelector(".agents-publish-skill-rows");
          if (rows) rows.innerHTML = buildSkillProvenanceRowsHtml(resolution);
          if (section) {
            section.dataset.state = resolution.errors.length ? "blocked" : "ready";
          }
          if (resolution.errors.length) {
            lastResolveBlockedMessage = `Cannot publish this agent's dependent skills: ${resolution.errors
              .map((entry) => `${entry.skillId} (${entry.error})`)
              .join(", ")}. No marketplace changes were made.`;
            setModalError(overlay, lastResolveBlockedMessage);
            if (submitBtn) submitBtn.disabled = true;
            // Cleared so the next submit click re-checks instead of replaying
            // this settled blocked result forever.
            planRefreshPromise = null;
            return;
          }
          lastResolveBlockedMessage = "";
          resolvedSkillPlan = resolution.plans;
          // When the refresh was awaited mid-submit, the wrapper owns the
          // button state; only re-enable from the idle pre-flight path.
          if (submitBtn && overlay.dataset.busy !== "true") {
            submitBtn.disabled = false;
            // Deferred dev-only auto-approve: the 1s timer fired while the
            // plan was still resolving; click now that the button is live.
            if (
              backendAutoApproveWhenEnabled &&
              !backendSettled &&
              overlay.style.display !== "none"
            ) {
              backendAutoApproveWhenEnabled = false;
              submitBtn.click();
            }
          }
        })();
        return planRefreshPromise;
      }
      void refreshSkillPlan();
    } catch (error) {
      const code =
        typeof error?.code === "string" && error.code
          ? error.code
          : "publish_preflight_failed";
      // Meta carries only fixed identifiers: preflight exceptions can wrap
      // arbitrary text (IPC errors, backend payloads) that must never reach
      // the diagnostics channel.
      logMarketplacePublish("open:preflight-failed", {
        agentId,
        stage: preflightStage,
        code,
      });
      if (preflightStage === "modal-open") {
        // The failure happened after this run's modal came up; never leave an
        // orphaned modal behind a settled flow.
        try {
          closeModal();
        } catch {}
      }
      const preflightCopy =
        PUBLISH_PREFLIGHT_ERROR_COPY[code] ||
        PUBLISH_PREFLIGHT_ERROR_COPY.publish_preflight_failed;
      notify(preflightCopy, "error");
      teardownBackendSession();
      completeBackendFlow("error", { error: preflightCopy, code });
      return;
    } finally {
      restoreButton();
    }
    // Backend flows resolve when the flow settles (published / failed /
    // dismissed / terminal), so runOrDeferBackendModal keeps its "one backend
    // modal at a time" semantics.
    if (backendDone) await backendDone;
  }

  // --- Chat-initiated (backend) publish requests -------------------------
  // The bridge tool's publish-agent confirmation routes here (via
  // backend-modal-listeners) so chat-initiated publishes run the EXACT
  // control-plane modal + dependent-skill pipeline above. One reopen/terminal
  // listener pair serves whichever backend publish is active.
  let activeBackendPublishSession = null;
  let backendPublishListenersWired = false;

  function ensureBackendPublishListeners() {
    if (backendPublishListenersWired) return;
    backendPublishListenersWired = true;
    window.electronAPI?.onNativeInputReopenRequested?.((payload) => {
      const session = activeBackendPublishSession;
      if (!session) return;
      if (payload?.kind !== "marketplace_publish") return;
      if (payload?.flow_id !== session.flowId) return;
      session.show();
    });
    window.electronAPI?.onNativeInputTerminal?.((payload) => {
      const session = activeBackendPublishSession;
      if (!session) return;
      if (payload?.kind !== "marketplace_publish") return;
      if (payload?.flow_id !== session.flowId) return;
      session.onTerminal();
    });
  }

  // Modal-free republish of a linked PUBLISHED agent for bulk flows (the
  // Updates tab's "Publish All"): same engine, same audience hoisting, and
  // the same dependent-skill publishing as the modal path — minus the modal
  // chrome. Errors throw; callers own progress/summary UI.
  async function republishAgentHeadless(agentId) {
    await refreshMarketplaceLinks();
    const link = state.marketplaceLinks?.[agentId];
    if (link?.relationship !== "published" || !link?.solutionId) {
      throw new Error("This agent is not a published marketplace listing.");
    }
    let agent = normalizeAgentRecord(await fetchAgentWithSystemPrompt(agentId));
    agent = await hydrateLinkedAgentAllowedEmails(agent);
    if (!agent) throw new Error(`Agent "${agentId}" was not found.`);
    if (!agent.system_prompt) {
      throw new Error(
        "Could not load this agent's system prompt; cannot publish an empty bundle.",
      );
    }
    const hasKeyRes = await window.electronAPI?.aiMarketplace?.hasApiKey();
    if (!hasKeyRes?.hasKey) {
      throw new Error("Set the AI Marketplace API key in Settings before publishing.");
    }
    // Same ONE-audience rule as the modal: the saved visibility with the
    // creator appended drives every write in the flow.
    const publishAudience = (
      await withCreatorAllowedEmail({ allowed_emails: agent.allowed_emails })
    ).allowed_emails;
    return pushAgentToMarketplace({
      localId: agent.id,
      solutionId: link.solutionId,
      args: {
        name: agent.name,
        description: agent.description,
        base_model_id: agent.base_model_id,
        system_prompt: agent.system_prompt,
        allowed_emails: publishAudience,
        skill_ids: agent.skill_ids,
        tool_server_ids: agent.tool_server_ids,
        reasoning_effort: agent.reasoning_effort,
      },
    });
  }

  // Modal-free publish executor for APPROVED chat flows: the batch approval
  // modal collects the user's decision, then runs each checked agent through
  // here. Same engine as the consolidated modal's submit (audience hoisting,
  // self-resolved dependent-skill plans, first-publish AND republish), and it
  // returns the exact result object the modal path sends with its terminal
  // "published" completion. Errors throw (with .code where known); the modal
  // owns per-item completions and progress chrome.
  // Skill-plan preview for the chat batch modal: resolve the SAME dependency
  // plan (and publish audience) executeBackendAgentPublish will use, so the
  // provenance table the user approves is exactly what the queue executes.
  // Throws the executor's coded errors (agent missing, creator email
  // unavailable) — callers surface those as blocked rows.
  async function resolveBackendAgentPublishSkillPlan({
    agentId,
    allowedEmailsOverride = null,
  } = {}) {
    await refreshMarketplaceLinks();
    let agent = normalizeAgentRecord(await fetchAgentWithSystemPrompt(agentId));
    agent = await hydrateLinkedAgentAllowedEmails(agent);
    if (!agent) throw new Error(`Agent "${agentId}" was not found.`);
    const effectiveAllowedEmails =
      Array.isArray(allowedEmailsOverride) && allowedEmailsOverride.length
        ? allowedEmailsOverride
        : agent.allowed_emails;
    const publishAudience = (
      await withCreatorAllowedEmail({ allowed_emails: effectiveAllowedEmails })
    ).allowed_emails;
    const resolution = await resolveDependentSkillPlans(agent.skill_ids || [], {
      probeAudience: publishAudience,
    });
    for (const plan of resolution.plans || []) {
      // Real-work rows tick during the publish cascade; no-work rows keep
      // their resolve-time green check. An ACL-drifted clean reference IS
      // work (visibility-only update) — same rule as the row renderer.
      plan.hasMarketplaceWork =
        !NO_WORK_PUBLISH_ACTIONS.has(plan.action) ||
        (plan.provenance === "user-linked-clean" &&
          Boolean(plan.listing?.acl_sync?.changed));
    }
    return {
      plans: resolution.plans || [],
      errors: resolution.errors || [],
      skillIds: agent.skill_ids || [],
      publishAudience,
    };
  }

  async function executeBackendAgentPublish({
    agentId,
    allowedEmailsOverride = null,
    resolvedSkillPlan = null,
    onProgress = null,
  } = {}) {
    logMarketplacePublish("backend-batch:execute", { agentId });
    await refreshMarketplaceLinks();
    let agent = normalizeAgentRecord(await fetchAgentWithSystemPrompt(agentId));
    agent = await hydrateLinkedAgentAllowedEmails(agent);
    if (!agent) throw new Error(`Agent "${agentId}" was not found.`);
    if (!agent.system_prompt) {
      throw new Error(
        "Could not load this agent's system prompt; cannot publish an empty bundle.",
      );
    }
    const hasKeyRes = await window.electronAPI?.aiMarketplace?.hasApiKey();
    if (!hasKeyRes?.hasKey) {
      const keyError = new Error(
        "The AI Marketplace API key is not set. Ask the user to set it in the Agents tab's Settings, then request the publish again.",
      );
      keyError.code = "marketplace_api_key_missing";
      throw keyError;
    }
    const effectiveAllowedEmails =
      Array.isArray(allowedEmailsOverride) && allowedEmailsOverride.length
        ? allowedEmailsOverride
        : agent.allowed_emails;
    const publishAudience = (
      await withCreatorAllowedEmail({ allowed_emails: effectiveAllowedEmails })
    ).allowed_emails;
    const isLinked = Boolean(agent.marketplace_solution_id);
    try {
      const published = await pushAgentToMarketplace({
        localId: agent.id,
        solutionId: agent.marketplace_solution_id,
        args: {
          name: agent.name,
          description: agent.description,
          base_model_id: agent.base_model_id,
          system_prompt: agent.system_prompt,
          allowed_emails: publishAudience,
          skill_ids: agent.skill_ids,
          tool_server_ids: agent.tool_server_ids,
          reasoning_effort: agent.reasoning_effort,
        },
        resolvedSkillPlan,
        onProgress,
      });
      const solutionId = published.solutionId;
      const publishDetails = formatMarketplacePublishDetails(published);
      const skillSummary = published.skillPublishSummary || {};
      logMarketplacePublish("backend-batch:success", { agentId: agent.id, solutionId });
      // Same post-publish cache hygiene as the modal path — dependent skill
      // listings may have been created/refreshed.
      invalidateSkillFreshness();
      return {
        solution_id: solutionId,
        status: published.publishStatus?.status || "active",
        has_bundle: published.publishStatus?.has_bundle !== false,
        action: isLinked ? "updated" : "created",
        name: agent.name || agent.id,
        local_agent_id: agent.id,
        dependent_skills: {
          published: Number(skillSummary.published) || 0,
          updated: Number(skillSummary.updated) || 0,
          adopted: Number(skillSummary.adopted) || 0,
          referenced: Number(skillSummary.referenced) || 0,
          unchanged: Number(skillSummary.unchanged) || 0,
          gitReferenced: Number(skillSummary.gitReferenced) || 0,
          repaired: Number(skillSummary.repaired) || 0,
          visibilityUpdated: Number(skillSummary.visibilityUpdated) || 0,
        },
        skills: Array.isArray(published.skills) ? published.skills : [],
        message:
          (isLinked
            ? `Marketplace copy updated (solution ${solutionId}).`
            : `Agent published to the AI Marketplace (solution ${solutionId}).`) +
          publishDetails,
      };
    } catch (error) {
      invalidateMarketplaceSkillLookups("backend-batch-item");
      logMarketplacePublish("backend-batch:failed", {
        agentId: agent.id,
        error: error?.message || String(error),
      });
      throw error;
    }
  }

  async function publishAgentFromBackendRequest(payload) {
    const flowId = typeof payload?.flow_id === "string" ? payload.flow_id : "";
    const agentId = typeof payload?.agent?.id === "string" ? payload.agent.id : "";
    const completeEarly = (action, extra = {}) => {
      try {
        window.electronAPI?.notifyAiMarketplacePublishConfirmCompleted?.({
          flow_id: flowId,
          action,
          ...extra,
        });
      } catch {}
    };
    if (!flowId || !agentId) {
      completeEarly("error", {
        error: "Malformed publish confirmation payload (missing flow or agent id).",
      });
      return;
    }
    // Never stomp a dialog the user is already in — openModal would destroy
    // it. Mirrors the legacy component's one-flow-at-a-time rejection.
    // (parentElement check: only an overlay actually mounted in the document
    // counts as busy.)
    const existingOverlay = document.getElementById("agents-modal-overlay");
    if (existingOverlay && existingOverlay.parentElement) {
      completeEarly("error", {
        error:
          "Another Agents dialog is open in the app; ask the user to finish or close it, then request the publish again.",
        code: "publish_ui_busy",
      });
      return;
    }
    // The batch approval modal renders ABOVE the agents overlay (z 10001 vs
    // 1000) — opening the consolidated publish dialog underneath it would be
    // un-interactable. Fail fast with the same retryable busy code.
    if (window.AiMarketplacePublishBatch?.isActive?.()) {
      completeEarly("error", {
        error:
          "A marketplace approval dialog is open in the app; ask the user to finish it, then request the publish again.",
        code: "publish_ui_busy",
      });
      return;
    }
    ensureBackendPublishListeners();
    try {
      await publishAgent(agentId, null, {
        backendFlow: {
          flowId,
          allowedEmailsOverride: Array.isArray(payload?.allowed_emails)
            ? payload.allowed_emails
            : [],
          autoApprove: payload?.auto_approve === true,
        },
      });
    } catch (error) {
      // publishAgent settles the flow on every designed path; this catch is
      // the unexpected-crash backstop (send-once is enforced main-side by the
      // flow's in_progress status guard).
      completeEarly("error", { error: error?.message || String(error) });
    }
  }

  // --- Per-agent skills freshness ---------------------------------------
  // One shared snapshot (headless checkSkillUpdates + getSkills) behind every
  // card's "skills need updates" state and the read-only view's status table.
  // TTL applies to ATTEMPTS (failures back off too); refreshes are kicked
  // only from render paths — no timers, no intervals, no polling.
  const SKILL_FRESHNESS_TTL_MS = 5 * 60_000;

  function skillFreshnessAttemptFresh() {
    return Date.now() - state.skillFreshness.fetchedAt < SKILL_FRESHNESS_TTL_MS;
  }

  function skillFreshnessSnapshotFresh() {
    return Boolean(state.skillFreshness.snapshot) && skillFreshnessAttemptFresh();
  }

  function invalidateSkillFreshness() {
    state.skillFreshness.fetchedAt = 0;
    state.skillFreshness.snapshot = null;
    state.agentSkillFreshness.clear();
  }

  // Verified-published skill solution ids (list_published_skills), mirroring
  // agent-skills' loadPublishedSkillSolutionIds: fail open to an empty set so
  // an offline/headless render simply shows no Published chips.
  async function loadPublishedSkillSolutionIdSet() {
    const listPublished = window.electronAPI?.aiMarketplace?.listPublished;
    if (typeof listPublished !== "function") return new Set();
    try {
      const result = await listPublished("skills");
      if (!result?.success) return new Set();
      const solutions = Array.isArray(result?.data?.solutions)
        ? result.data.solutions
        : [];
      return new Set(
        solutions
          .map((solution) => String(solution?.id || "").trim())
          .filter(Boolean),
      );
    } catch {
      return new Set();
    }
  }

  function buildSkillFreshnessSnapshot(skillsRes, linksRes, publishedSolutionIds) {
    const list = Array.isArray(skillsRes?.skills) ? skillsRes.skills : [];
    const bySkill = new Map();
    const byFullName = new Map();
    for (const raw of list) {
      const canonical = canonicalSkillName(String(raw?.name || ""));
      if (!canonical) continue;
      const source = String(raw?.source || "");
      const entry = {
        canonicalName: canonical,
        source,
        marketplaceName: source === "marketplace" ? raw?.marketplace_name || "" : "",
        hasUpdate: raw?.has_update === true,
        hasConflict: raw?.has_conflict === true,
      };
      // Exact catalog name first: two plugins can install the same leaf,
      // and agents with fully-qualified ids must read THEIR copy's state.
      const fullName = String(raw?.name || "").trim();
      if (fullName) byFullName.set(fullName, entry);
      // A canonical name can exist in several sources (e.g. a system
      // skill shadowed by an installed marketplace copy). Keep the entry
      // that wins skill resolution — an update on a shadowed copy must
      // not flag agents that actually run the system/user copy.
      const existing = bySkill.get(canonical);
      if (existing && skillSourcePrecedence(existing.source) >= skillSourcePrecedence(source)) {
        continue;
      }
      bySkill.set(canonical, entry);
    }
    const linksByName =
      linksRes?.success && linksRes.links && typeof linksRes.links === "object"
        ? linksRes.links
        : {};
    return { bySkill, byFullName, linksByName, publishedSolutionIds };
  }

  async function loadSkillFreshnessSnapshot({ force = false } = {}) {
    if (!force && skillFreshnessAttemptFresh()) {
      // Within the TTL window we serve whatever the last attempt produced —
      // including null after a failure (natural backoff, no hot retry loop).
      return state.skillFreshness.snapshot;
    }
    if (state.skillFreshness.promise) return state.skillFreshness.promise;
    const run = (async () => {
      try {
        // LOCAL-FIRST: statuses render from the persisted update/conflict
        // flags immediately — the network refresh must never gate first
        // paint (2026-08-14: a marketplace availability blip held every
        // status spinner hostage for 19-84s while the sweep ground through
        // retry ladders).
        const [skillsRes, linksRes] = await Promise.all([
          window.electronAPI?.getSkills?.(),
          window.electronAPI?.aiMarketplace?.listSkillLinks?.().catch(() => null),
        ]);
        state.skillFreshness.snapshot = buildSkillFreshnessSnapshot(
          skillsRes,
          linksRes,
          state.skillFreshness.snapshot?.publishedSolutionIds || new Set(),
        );
        // NETWORK phase, same attempt (TTL/backoff unchanged): refresh the
        // persisted flags via the headless sweep (never pops a GitLab
        // sign-in) + the viewer's published set, rebuild, and repaint once.
        // Failures keep the local snapshot — strictly better than the old
        // all-or-nothing null.
        void (async () => {
          try {
            try {
              await window.electronAPI?.checkSkillUpdates?.({ interactiveAuth: false });
            } catch {
              // Degrade to the last-persisted flags.
            }
            const [refreshedRes, publishedSolutionIds] = await Promise.all([
              window.electronAPI?.getSkills?.(),
              loadPublishedSkillSolutionIdSet(),
            ]);
            state.skillFreshness.snapshot = buildSkillFreshnessSnapshot(
              refreshedRes,
              linksRes,
              publishedSolutionIds,
            );
            state.agentSkillFreshness.clear();
            renderMyAgents();
          } catch {
            // Keep the local-phase snapshot.
          }
        })();
        return state.skillFreshness.snapshot;
      } finally {
        state.skillFreshness.fetchedAt = Date.now();
        state.skillFreshness.promise = null;
      }
    })();
    state.skillFreshness.promise = run;
    return run;
  }

  // Provenance-aware freshness for one catalog skill: system and user copies
  // have nothing to sync (a dirty published user skill is "unpublished
  // changes", not an update); installed marketplace copies compare against
  // their marketplace source.
  function skillFreshnessStatusFor(entry) {
    if (!entry) return "idle";
    if (entry.source === "marketplace") {
      if (entry.hasConflict) return "conflict";
      if (entry.hasUpdate) return "update";
    }
    return "current";
  }

  function computeAgentSkillFreshness(agent, snapshot) {
    const updates = [];
    const conflicts = [];
    const seen = new Set();
    for (const rawId of Array.isArray(agent?.skill_ids) ? agent.skill_ids : []) {
      const id = String(rawId || "").trim();
      const canonical = canonicalSkillName(id);
      if (!canonical || seen.has(canonical)) continue;
      seen.add(canonical);
      // Exact-first: a fully-qualified id reads its own copy's state; the
      // canonical fallback covers bare/legacy ids.
      const entry =
        snapshot?.byFullName?.get?.(id) || snapshot?.bySkill?.get?.(canonical);
      const status = skillFreshnessStatusFor(entry);
      if (status === "conflict") conflicts.push(canonical);
      else if (status === "update") updates.push(canonical);
    }
    return { updates, conflicts };
  }

  // Per-agent freshness with a per-entry TTL; computes synchronously off the
  // shared snapshot when it is fresh. Returns null while unknown (snapshot
  // fetch pending/needed) — cards show the subtle spinner chip for null.
  function agentSkillFreshnessFor(agent) {
    const key = String(agent?.id || "");
    const entry = key ? state.agentSkillFreshness.get(key) : null;
    if (entry && entry.status !== "pending" && Date.now() - entry.checkedAt < SKILL_FRESHNESS_TTL_MS) {
      return entry;
    }
    if (skillFreshnessSnapshotFresh()) {
      const computed = {
        checkedAt: Date.now(),
        status: "ready",
        ...computeAgentSkillFreshness(agent, state.skillFreshness.snapshot),
      };
      if (key) state.agentSkillFreshness.set(key, computed);
      return computed;
    }
    return null;
  }

  function agentHasSkillUpdates(agent) {
    const entry = agentSkillFreshnessFor(agent);
    return Boolean(
      entry &&
        entry.status === "ready" &&
        (entry.updates.length > 0 || entry.conflicts.length > 0),
    );
  }

  // Render-path trigger: kick one snapshot fetch when stale, and re-render the
  // list exactly once when it settles (the post-settle render computes every
  // card synchronously from the fresh snapshot, so it cannot loop).
  function ensureAgentSkillFreshnessScan() {
    if (!Array.isArray(state.myAgents) || state.myAgents.length === 0) return;
    if (state.skillFreshness.renderQueued) return;
    if (!state.skillFreshness.promise && skillFreshnessAttemptFresh()) return;
    state.skillFreshness.renderQueued = true;
    loadSkillFreshnessSnapshot()
      .catch(() => {})
      .then(() => {
        state.skillFreshness.renderQueued = false;
        if (!skillFreshnessSnapshotFresh()) {
          // Failed cycle: stamp error entries so cards drop the spinner and
          // retry only after the TTL backoff.
          const stamped = Date.now();
          for (const agent of state.myAgents) {
            const key = String(agent?.id || "");
            if (!key) continue;
            state.agentSkillFreshness.set(key, {
              checkedAt: stamped,
              status: "error",
              updates: [],
              conflicts: [],
            });
          }
        }
        renderMyAgents();
      });
  }

  function remoteUpdatedAtMs(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
      // Tolerate second-resolution epochs from the marketplace.
      return value < 1e12 ? value * 1000 : value;
    }
    const parsed = Date.parse(String(value || ""));
    return Number.isFinite(parsed) ? parsed : null;
  }

  // The freshness scan flagged a newer listing for this installed copy —
  // stamped on the record, persisted on the link (hasRemoteUpdate, written by
  // the chat-tool update sweep and cleared when an update lands), or held in
  // the session map from this session's own sweep.
  function agentUpdateAvailable(agent) {
    if (agentMarketplaceRelationship(agent) !== "installed") return false;
    if (agent?.update_available === true) return true;
    const agentId = String(agent?.id || "");
    if (
      agent?.marketplace_link?.hasRemoteUpdate === true ||
      state.marketplaceLinks?.[agentId]?.hasRemoteUpdate === true
    ) {
      return true;
    }
    if (!(state.solutionFreshness instanceof Map)) return false;
    if (!state.solutionFreshness.has(agentId)) return false;
    // Session-map entries outlive updates applied elsewhere (Updates tab,
    // chat tools) — prune when the persisted baseline has caught up to the
    // stamp that flagged it, so a stale badge never survives a real update.
    // Record-borne and state links can lag each other; trust the freshest.
    const stampMs = remoteUpdatedAtMs(state.solutionFreshness.get(agentId));
    const baselines = [
      remoteUpdatedAtMs(agent?.marketplace_link?.remoteUpdatedAt),
      remoteUpdatedAtMs(state.marketplaceLinks?.[agentId]?.remoteUpdatedAt),
    ].filter((ms) => ms !== null);
    const baselineMs = baselines.length ? Math.max(...baselines) : null;
    if (stampMs !== null && baselineMs !== null && baselineMs >= stampMs) {
      state.solutionFreshness.delete(agentId);
      return false;
    }
    return true;
  }

  // Cross-surface invalidation: bulk updates applied outside this tab (the
  // Updates tab's Update All / Sync All) advance link baselines behind the
  // session sweep's back. Dropping the map AND the once-per-session guard
  // lets the next user-driven Agents render re-derive freshness — still no
  // timers/polling, just a bounded re-scan on the next visit.
  function invalidateInstalledAgentFreshness() {
    state.freshnessCheckedAt = 0;
    state.solutionFreshness = new Map();
  }

  // Bounded, session-cached, user-action-piggybacked update scan for installed
  // copies (the enrichDiscoverBundles precedent — no timers, no polling). One
  // type-filtered search covers the fleet; a bounded per-id fallback fills
  // listings the ranked search missed. Links without a stored baseline are
  // backfilled silently so legacy installs report from their NEXT listing
  // update onward — comparisons always use the marketplace's own clock.
  async function maybeCheckInstalledAgentFreshness() {
    if (state.freshnessCheckedAt) return;
    const installed = Object.entries(state.marketplaceLinks || {}).filter(
      ([, link]) => link?.relationship === "installed" && link?.solutionId,
    );
    if (!installed.length) return;
    state.freshnessCheckedAt = Date.now();
    try {
      const api = window.electronAPI?.aiMarketplace;
      const res = await api?.search?.({
        query: "",
        filters: { type: [TYPE_AGENTS] },
        page: 1,
        pageSize: 100,
      });
      const solutionsById = new Map();
      const results =
        res?.success && Array.isArray(res.data?.results) ? res.data.results : [];
      for (const solution of results) {
        const id = String(
          solution?.id || solution?.solution_id || solution?.uuid || "",
        ).trim();
        if (id) solutionsById.set(id, solution);
      }
      const missing = installed
        .filter(([, link]) => !solutionsById.has(link.solutionId))
        .slice(0, 12);
      for (const [, link] of missing) {
        try {
          const sol = await api?.getSolution?.(link.solutionId);
          if (sol?.success && sol.data) solutionsById.set(link.solutionId, sol.data);
        } catch (error) {
          console.warn("[Agents] freshness lookup failed for", link.solutionId, error);
        }
      }
      let flagged = 0;
      for (const [agentId, link] of installed) {
        const solution = solutionsById.get(link.solutionId);
        // LOCKSTEP with services/ai-marketplace-freshness.js
        // solutionFreshnessStamp: the live backend's field names are
        // updated_timestamp/created_timestamp; legacy names are fixture-era
        // fallbacks. Reading only the legacy names silently disabled update
        // detection for everyone (2026-08-04 incident).
        const remote =
          solution?.updated_timestamp ??
          solution?.updated_at ??
          solution?.created_timestamp ??
          solution?.created_at;
        if (remote === undefined || remote === null || remote === "") continue;
        if (link.remoteUpdatedAt === undefined || link.remoteUpdatedAt === null) {
          await api?.setLinkRemoteUpdatedAt?.(agentId, remote);
          continue;
        }
        const remoteMs = remoteUpdatedAtMs(remote);
        const baselineMs = remoteUpdatedAtMs(link.remoteUpdatedAt);
        if (remoteMs !== null && baselineMs !== null && remoteMs > baselineMs) {
          state.solutionFreshness.set(agentId, remote);
          flagged += 1;
        }
      }
      if (flagged) {
        console.log("[Agents] marketplace updates available", { flagged });
        await refreshMarketplaceLinks();
        renderMyAgents();
      }
    } catch (error) {
      console.warn("[Agents] installed-agent freshness check failed", error);
    }
  }

  // Renderer mirror of the main process's asSkillRefs parser (services/
  // ai-marketplace-install.js): a missing kind means "solution"; a solution
  // ref without a solution id and a git ref with an unknown source type are
  // dropped, so their skill ids classify as ref-less — exactly like install.
  function asInstallSkillRefs(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      const skillId =
        typeof entry.skill_id === "string" ? entry.skill_id.trim() : "";
      if (!skillId) continue;
      const kind =
        typeof entry.kind === "string" && entry.kind.trim()
          ? entry.kind.trim()
          : "solution";
      // Authored bundle name (mirrors install.js asSkillRefs): the only name
      // source for skills that are not on this computer.
      const displayName =
        typeof entry.display_name === "string" &&
        entry.display_name.trim() &&
        entry.display_name.trim() !== skillId
          ? entry.display_name.trim()
          : null;
      if (kind === "solution") {
        const refSolutionId =
          typeof entry.solution_id === "string" ? entry.solution_id.trim() : "";
        if (!refSolutionId) continue;
        out.push({
          skill_id: skillId,
          kind,
          solution_id: refSolutionId,
          ...(displayName ? { display_name: displayName } : {}),
        });
        continue;
      }
      if (kind === "git-marketplace") {
        const source = entry.marketplace?.source;
        const sourceType = typeof source?.type === "string" ? source.type : "";
        if (!source || !["github", "gitlab", "url"].includes(sourceType)) {
          continue;
        }
        out.push({
          skill_id: skillId,
          kind,
          solution_id: null,
          ...(displayName ? { display_name: displayName } : {}),
          marketplace: {
            name:
              typeof entry.marketplace?.name === "string"
                ? entry.marketplace.name.trim()
                : "",
            source: { ...source },
          },
          skill_path:
            typeof entry.skill_path === "string" ? entry.skill_path.trim() : "",
          plugin_name:
            typeof entry.plugin_name === "string" && entry.plugin_name.trim()
              ? entry.plugin_name.trim()
              : null,
        });
      }
    }
    return out;
  }

  // Renderer mirror of marketplace-service's isSameRepositorySource: durable
  // marketplace identity is the repository, ref-agnostic. Advisory only —
  // the main process re-normalizes and re-compares at install time.
  function sameRepositorySourceLoose(a, b) {
    if (!a || !b || a.type !== b.type) return false;
    if (a.type === "github") {
      return (
        Boolean(a.repo) &&
        String(a.repo || "").toLowerCase() === String(b.repo || "").toLowerCase()
      );
    }
    if (a.type === "gitlab") {
      return (
        Boolean(a.projectPath) &&
        String(a.host || "").toLowerCase() === String(b.host || "").toLowerCase() &&
        String(a.projectPath || "") === String(b.projectPath || "")
      );
    }
    if (a.type === "url") {
      return (
        Boolean(a.url) && String(a.url || "").trim() === String(b.url || "").trim()
      );
    }
    return false;
  }

  // Best-effort update classification for an already-installed dependency
  // (hydrated installed record: live isDirty, persisted hasUpdate). The main
  // process re-derives freshness from a live read at install time — a stale
  // flag here can only mis-word a row, never cause a wrong write.
  function classifyInstalledUpdateState(record) {
    if (record?.isDirty && record?.hasUpdate) return "review";
    if (record?.isDirty) return "review";
    if (record?.hasUpdate) return "refresh";
    return "current";
  }

  // Pre-install plan: how each dependent skill of a marketplace agent bundle
  // will be resolved on THIS machine. Mirrors the per-path decision order of
  // reconcileAgentSkillDependencies (services/ai-marketplace-install.js) but
  // is advisory only — the main process re-derives everything at install
  // time, so a divergence here can mis-word a row, never corrupt an install.
  // Plan/row keys are the VERBATIM bundle skill ids (legacy bundles may
  // carry qualified ids); the main process echoes them untransformed in its
  // progress events.
  async function resolveInstallSkillPlans({
    bundle,
    mode = "install",
    solutionId: agentSolutionId = "",
  }) {
    const payload =
      marketplaceAgentPayloadFromBundle(normalizeSolutionBundle(bundle)) || {};
    const skillIds = (Array.isArray(payload.skill_ids) ? payload.skill_ids : [])
      .map((id) => (typeof id === "string" ? id.trim() : ""))
      .filter(Boolean);
    if (!skillIds.length) return { plans: [], errors: [] };
    const refsBySkillId = new Map();
    for (const ref of asInstallSkillRefs(payload.skill_refs)) {
      if (!refsBySkillId.has(ref.skill_id)) refsBySkillId.set(ref.skill_id, ref);
    }
    const [skillsRes, marketplacesRes, skillLinksRes] = await Promise.all([
      window.electronAPI?.getSkills?.().catch(() => null),
      window.electronAPI?.getMarketplaces?.().catch(() => null),
      window.electronAPI?.aiMarketplace?.listSkillLinks?.().catch(() => null),
    ]);
    const localByName = new Map();
    for (const skill of Array.isArray(skillsRes?.skills) ? skillsRes.skills : []) {
      if (skill?.name) localByName.set(skill.name, skill);
    }
    const config = marketplacesRes?.data || {};
    const marketplaces = Array.isArray(config.marketplaces)
      ? config.marketplaces
      : [];
    const installedRecords = Array.isArray(config.installedSkills)
      ? config.installedSkills
      : [];
    const linkedSolutionIds = new Set(
      Object.values(skillLinksRes?.links || {})
        .map((link) => link?.solutionId)
        .filter(Boolean),
    );

    const plans = [];
    const errors = [];
    const seen = new Set();
    for (const skillId of skillIds) {
      if (seen.has(skillId)) continue;
      seen.add(skillId);
      const local = localByName.get(skillId) || null;
      const ref = refsBySkillId.get(skillId);
      // Same precedence as every other surface: authored ref name > local
      // authored name > shared formatter — never the raw slug. Plugin skills
      // read as "Plugin → Skill" here too.
      const displayName = skillLabelWithPlugin(
        ref?.display_name || local?.display_name || formatSkillLabel(skillId),
        ref?.plugin_name || local?.plugin_name || "",
      );
      const pushLocalReuse = () => {
        plans.push({
          skillId,
          displayName,
          provenance:
            local.source === "system"
              ? "local-system"
              : local.source === "user"
                ? "local-user"
                : "local-installed",
          marketplaceName: local.marketplace_name || "",
          marketplaceId: local.marketplace_id || "",
        });
      };
      if (!ref) {
        if (local) {
          pushLocalReuse();
          continue;
        }
        const slug = canonicalSkillName(skillId);
        const qualified = slug ? `ai-marketplace/${slug}` : "";
        const installedCopy = qualified ? localByName.get(qualified) : null;
        if (installedCopy) {
          plans.push({
            skillId,
            displayName: installedCopy.display_name || displayName,
            provenance: "installed-solution-reuse",
            solutionId: installedCopy.marketplace_solution_id || "",
          });
          continue;
        }
        errors.push({
          skillId,
          displayName,
          source: null,
          error: "it isn't on this computer",
          remediation: "This agent doesn't include a way to get it.",
        });
        continue;
      }
      if (ref.kind === "git-marketplace") {
        if (local) {
          pushLocalReuse();
          continue;
        }
        const wantedSource = ref.marketplace?.source || {};
        const matched =
          marketplaces.find((entry) =>
            sameRepositorySourceLoose(entry?.source, wantedSource),
          ) || null;
        const marketplaceName =
          matched?.name || matched?.id || ref.marketplace?.name || "git";
        const repoLabel =
          wantedSource.repo || wantedSource.projectPath || wantedSource.url || "";
        if (matched) {
          const slug = canonicalSkillName(ref.skill_id);
          const installed = installedRecords.find(
            (record) =>
              record?.marketplaceId === matched.id &&
              canonicalSkillName(record?.skillId) === slug,
          );
          plans.push({
            skillId,
            displayName,
            provenance: installed ? "git-reuse-installed" : "git-install",
            marketplaceName,
            repoLabel,
            updateState:
              mode === "update" && installed
                ? classifyInstalledUpdateState(installed)
                : null,
          });
          continue;
        }
        // Spread gate pre-flag: adding this marketplace must pass the add
        // allowlist. Advisory UI check — the backend addMarketplace remains
        // the enforcement point (and already rejects); an unavailable IPC
        // falls through to the plan so the backend gives the real answer.
        const allowedRes = await window.electronAPI
          ?.isMarketplaceSourceAllowed?.(wantedSource)
          .catch(() => null);
        if (allowedRes?.success && allowedRes.allowed === false) {
          errors.push({
            skillId,
            displayName,
            source: "git",
            marketplaceName,
            error: `its marketplace (${repoLabel || marketplaceName}) is not an approved source`,
            remediation: "It can't be added to this computer.",
          });
          continue;
        }
        plans.push({
          skillId,
          displayName,
          provenance: "git-add-install",
          marketplaceName,
          repoLabel,
          gitlabNote: wantedSource.type === "gitlab",
        });
        continue;
      }
      // Solution ref: reuse is decided by solution-id provenance, never by
      // name (mirrors installGuardedSkillDependency).
      const installedMatch = installedRecords.find(
        (record) =>
          record?.skillSource?.type === "ai-marketplace-solution" &&
          record?.skillSource?.solutionId === ref.solution_id,
      );
      if (installedMatch) {
        plans.push({
          skillId,
          displayName,
          provenance: "installed-solution-reuse",
          solutionId: ref.solution_id,
          updateState:
            mode === "update" ? classifyInstalledUpdateState(installedMatch) : null,
        });
        continue;
      }
      if (linkedSolutionIds.has(ref.solution_id)) {
        plans.push({
          skillId,
          displayName,
          provenance: "user-published-reuse",
          solutionId: ref.solution_id,
        });
        continue;
      }
      const slug = canonicalSkillName(ref.skill_id);
      const occupant = slug ? localByName.get(`ai-marketplace/${slug}`) : null;
      if (occupant) {
        errors.push({
          skillId,
          displayName,
          source: "marketplace",
          solutionId: ref.solution_id,
          error: "a different local skill already occupies its install location",
        });
        continue;
      }
      plans.push({
        skillId,
        displayName,
        provenance: "solution-install",
        solutionId: ref.solution_id,
      });
    }
    const visibility = await attachInstallRefVisibility(
      plans,
      errors,
      agentSolutionId,
    );
    return {
      plans: sortInstallPlansForDisplay(
        plans.filter((plan) => !visibility.blockedSkillIds.has(plan.skillId)),
      ),
      errors,
      ownerIdentity: visibility.ownerIdentity,
    };
  }

  // Viewer-scoped visibility pre-check for solution-kind install plans: a
  // pinned listing this viewer cannot fetch WILL fail the install, so it
  // surfaces as a blocked row before Install is clickable. One-shot at modal
  // open; network failures stay advisory (fail open) — the install-time
  // reconcile remains authoritative. The parent agent listing rides the same
  // wave to name the owner in the remediation copy.
  async function attachInstallRefVisibility(plans, errors, agentSolutionId) {
    const none = { blockedSkillIds: new Set(), ownerIdentity: "" };
    const probePlans = (plans || []).filter(
      (plan) => plan.provenance === "solution-install" && plan.solutionId,
    );
    if (!probePlans.length) return none;
    const probe = window.electronAPI?.aiMarketplace?.probeInstallRefs;
    if (typeof probe !== "function") return none;
    try {
      const ids = [...new Set(probePlans.map((plan) => plan.solutionId))];
      const res = await probe({
        solutionIds: agentSolutionId ? [...ids, agentSolutionId] : ids,
      });
      if (!res?.success) return none;
      const byId = new Map(
        (res.data?.listings || []).map((entry) => [entry.solution_id, entry]),
      );
      const ownerIdentity = String(
        byId.get(agentSolutionId)?.submitted_by || "",
      );
      const blockedSkillIds = new Set();
      for (const plan of probePlans) {
        if (byId.get(plan.solutionId)?.state !== "unavailable") continue;
        blockedSkillIds.add(plan.skillId);
        errors.push({
          skillId: plan.skillId,
          displayName: plan.displayName,
          source: "marketplace",
          solutionId: plan.solutionId,
          error: "its marketplace listing isn't shared with you",
          remediation: `Ask ${ownerIdentity || "the author"} to republish this agent.`,
        });
      }
      return { blockedSkillIds, ownerIdentity };
    } catch (error) {
      console.warn("[Agents] install visibility probe failed (advisory only)", error);
      return none;
    }
  }

  // Install-mode rows for the pre-install modal: same table scaffold and
  // status cells as the publish modal (shared CSS and ticker wiring); the
  // sentences describe what installing will do on this machine, with the
  // technical identifiers demoted to hover tooltips.
  function buildInstallSkillPlanRowsHtml(resolution, mode = "install") {
    const rows = [];
    // Blocked rows render ABOVE the plan rows: they are why the Install
    // button is disabled, so they must not hide below the fold.
    const blockedRows = [];
    // Update mode reports only what CHANGES (per UX request): refreshes,
    // needs-review rows, and fresh installs. Pure reuse rows are hidden.
    const visiblePlans = (resolution?.plans || []).filter((plan) => {
      if (mode !== "update") return true;
      if (plan.updateState === "refresh" || plan.updateState === "review") {
        return true;
      }
      return ["solution-install", "git-install", "git-add-install"].includes(
        plan.provenance,
      );
    });
    for (const plan of visiblePlans) {
      const name = escapeHtml(plan.displayName || plan.skillId);
      let chips = "";
      let actionLine = "";
      let tooltip = "";
      if (mode === "update" && plan.updateState === "refresh") {
        chips = '<span class="mcp-card-badge badge-installed">Installed</span>';
        actionLine =
          "<strong>Will be updated to the marketplace's latest version.</strong>";
        rows.push(buildInstallPlanRow(plan, chips, actionLine, ""));
        continue;
      }
      if (mode === "update" && plan.updateState === "review") {
        chips =
          '<span class="mcp-card-badge badge-installed">Installed</span><span class="mcp-card-badge badge-unpublished">Local edits</span>';
        actionLine =
          'Has local edits.<span class="agents-publish-skill-action-remedy">Your changes will be kept. Resolve from the Marketplaces page (Discard or Detach).</span>';
        rows.push(buildInstallPlanRow(plan, chips, actionLine, ""));
        continue;
      }
      switch (plan.provenance) {
        case "local-system":
          chips = '<span class="mcp-card-badge badge-core">Core</span>';
          actionLine =
            'Built into Portico.<span class="agents-publish-skill-action-remedy">Already available.</span>';
          break;
        case "local-user":
          chips = '<span class="mcp-card-badge badge-user">User</span>';
          actionLine =
            'You already have this skill.<span class="agents-publish-skill-action-remedy">Your copy will be used.</span>';
          break;
        case "local-installed":
          chips = `<span class="mcp-card-badge badge-installed">Installed</span>${plan.marketplaceId && plan.marketplaceId !== "ai-marketplace" ? gitMarketplaceBadgeHtml() : ""}${plan.marketplaceName ? `<span class="mcp-card-badge badge-marketplace-name">${escapeHtml(plan.marketplaceName)}</span>` : ""}`;
          actionLine =
            'Already on this computer.<span class="agents-publish-skill-action-remedy">Your installed copy will be used.</span>';
          break;
        case "installed-solution-reuse":
          chips = '<span class="mcp-card-badge badge-installed">Installed</span>';
          actionLine =
            'Already installed from the marketplace.<span class="agents-publish-skill-action-remedy">Nothing to download.</span>';
          tooltip = plan.solutionId
            ? `Solutions Marketplace listing ${plan.solutionId}`
            : "";
          break;
        case "user-published-reuse":
          chips =
            '<span class="mcp-card-badge badge-user">User</span><span class="mcp-card-badge badge-published">Published</span>';
          actionLine =
            'This is your published skill.<span class="agents-publish-skill-action-remedy">Your local copy will be used.</span>';
          tooltip = plan.solutionId
            ? `Solutions Marketplace listing ${plan.solutionId}`
            : "";
          break;
        case "git-reuse-installed":
          chips = `<span class="mcp-card-badge badge-installed">Installed</span>${gitMarketplaceBadgeHtml()}<span class="mcp-card-badge badge-marketplace-name">${escapeHtml(plan.marketplaceName || "marketplace")}</span>`;
          actionLine = `Already installed from the ${escapeHtml(plan.marketplaceName || "git")} marketplace.<span class="agents-publish-skill-action-remedy">Nothing to download.</span>`;
          tooltip = plan.repoLabel
            ? `Marketplace repository: ${plan.repoLabel}`
            : "";
          break;
        case "git-install":
          chips = `${gitMarketplaceBadgeHtml()}<span class="mcp-card-badge badge-marketplace-name">${escapeHtml(plan.marketplaceName || "marketplace")}</span>`;
          actionLine = `<strong>Will be installed from the ${escapeHtml(plan.marketplaceName || "git")} marketplace.</strong>`;
          tooltip = plan.repoLabel
            ? `Marketplace repository: ${plan.repoLabel}`
            : "";
          break;
        case "git-add-install":
          chips = `${gitMarketplaceBadgeHtml()}<span class="mcp-card-badge badge-marketplace-name">${escapeHtml(plan.marketplaceName || "marketplace")}</span>`;
          actionLine = `<strong>The ${escapeHtml(plan.marketplaceName || "git")} marketplace will be added to this computer, then the skill installed from it.</strong>${plan.gitlabNote ? " You may be asked to sign in to GitLab." : ""}`;
          tooltip = plan.repoLabel
            ? `Marketplace repository: ${plan.repoLabel}`
            : "";
          break;
        case "solution-install":
        default:
          chips =
            '<span class="mcp-card-badge badge-marketplace-name">Solutions Marketplace</span>';
          actionLine =
            "<strong>Will be installed from the Solutions Marketplace.</strong>";
          tooltip = plan.solutionId
            ? `Solutions Marketplace listing ${plan.solutionId}`
            : "";
          break;
      }
      rows.push(buildInstallPlanRow(plan, chips, actionLine, tooltip));
    }
    for (const failure of resolution?.errors || []) {
      // Two lines, no em-dash run-ons: the fact, then (when known) what to
      // do about it, quieter. Blocked rows keep the full four-cell shape:
      // display name (never the raw slug), provenance badges under Source,
      // and the red message under "What happens" like every other row.
      const remedy = failure.remediation
        ? `<span class="agents-publish-skill-action-remedy">${escapeHtml(failure.remediation)}</span>`
        : "";
      const name = failure.displayName || formatSkillLabel(failure.skillId);
      let chips = '<span class="agent-details-empty">—</span>';
      if (failure.source === "git") {
        const marketplaceName = failure.marketplaceName || "marketplace";
        chips = `${gitMarketplaceBadgeHtml()}<span class="mcp-card-badge badge-marketplace-name" title="${escapeHtml(marketplaceName)}">${escapeHtml(marketplaceName)}</span>`;
      } else if (failure.source === "marketplace") {
        chips =
          '<span class="mcp-card-badge badge-marketplace-name">Solutions Marketplace</span>';
      }
      blockedRows.push(`
        <tr class="agents-publish-skill-row agents-publish-skill-row-blocked" data-action="error" data-skill="${escapeHtml(failure.skillId)}">
          <td><span class="agents-publish-skill-status" data-status="blocked"></span></td>
          <td><span class="agents-publish-skill-name">${escapeHtml(name)}</span></td>
          <td><span class="agents-publish-skill-chips">${chips}</span></td>
          <td><span class="agents-publish-skill-action">Can't install yet: ${escapeHtml(failure.error)}.${remedy}</span></td>
        </tr>`);
    }
    if (!rows.length && !blockedRows.length) {
      return mode === "update"
        ? '<div class="agents-publish-skill-row"><span class="agents-publish-skill-action">Everything is already up to date.</span></div>'
        : '<div class="agents-publish-skill-row"><span class="agents-publish-skill-action">No dependent skills.</span></div>';
    }
    return `
      <table class="agents-publish-skill-table">
        <thead>
          <tr>
            <th>Status</th>
            <th>Skill</th>
            <th>Source</th>
            <th>What happens</th>
          </tr>
        </thead>
        <tbody>${blockedRows.join("")}${rows.join("")}</tbody>
      </table>`;
  }

  function buildInstallPlanRow(plan, chips, actionLine, tooltip) {
    const name = escapeHtml(plan.displayName || plan.skillId);
    // Reuse rows (already satisfied locally) show a green check from resolve
    // time; rows that will download/install start idle and tick on submit.
    const initialStatus =
      NO_WORK_INSTALL_PROVENANCES.has(plan.provenance) &&
      (!plan.updateState || plan.updateState === "current")
        ? "current"
        : "idle";
    return `
        <tr class="agents-publish-skill-row" data-skill="${escapeHtml(plan.skillId)}" data-action="${escapeHtml(plan.provenance)}"${tooltip ? ` title="${escapeHtml(tooltip)}"` : ""}>
          <td><span class="agents-publish-skill-status" data-status="${initialStatus}"></span></td>
          <td><span class="agents-publish-skill-name">${name}</span></td>
          <td><span class="agents-publish-skill-chips">${chips}</span></td>
          <td><span class="agents-publish-skill-action">${actionLine}</span></td>
        </tr>`;
  }

  // Pre-install provenance modal: the publish modal's table in install
  // dress. Rows resolve while the modal is open (Install unlocks on a clean
  // plan), then tick live during the install from main-process progress
  // events; the button's own spinner appears only once the agent itself is
  // the remaining step.
  function openAgentInstallModal({
    solutionId,
    bundle,
    mode = "install",
    onInstalled = null,
  }) {
    const payload = marketplaceAgentPayloadFromBundle(bundle) || {};
    const agentName = payload.name || "this agent";
    const skillCount = Array.isArray(payload.skill_ids)
      ? payload.skill_ids.length
      : 0;
    const isUpdate = mode === "update";
    const busyLabel = isUpdate ? "Updating..." : "Installing...";
    const summary = `
      <div class="agents-publish-summary">
      <p class="agents-publish-intro">You are about to ${isUpdate ? "update this installed agent from" : "install this agent from"} the AI Solutions Marketplace.</p>
      <div class="agents-publish-section">
        <div class="agents-publish-section-label">Agent</div>
        <p><strong>${escapeHtml(agentName)}</strong></p>
        ${payload.description ? `<p>${escapeHtml(payload.description)}</p>` : ""}
        ${payload.base_model_id ? `<p><strong>Model:</strong> ${escapeHtml(payload.base_model_id)}</p>` : ""}
      </div>
      <div class="agents-publish-section agents-publish-skill-provenance" data-state="loading">
        <div class="agents-publish-section-label">Skills (${skillCount})${window.InfoTooltips?.triggerHtml?.("Without pinned skills, this agent picks its own tools per session — which may vary when others use it. Pin the skills you want to guarantee.") || ""}</div>
        <div class="agents-publish-skill-rows">
          <div class="agents-publish-skill-loading"><span class="agents-publish-skill-spinner" aria-hidden="true"></span>Checking this agent's skills…</div>
        </div>
      </div>
      </div>
    `;
    let resolvedInstallPlan = null;
    let installOwnerIdentity = "";
    const overlay = openModal(`${isUpdate ? "Update" : "Install"} agent`, summary, {
      headerEyebrow: "AI Marketplace",
      headerSubtitle: agentName,
      headerIcon: true,
      modalClassName: "agents-modal-wide",
      submitLabel: isUpdate ? "Update" : "Install",
      submitBusyLabel: busyLabel,
      onSubmit: async () => {
        if (resolvedInstallPlan === null) {
          throw new Error("Still checking this agent's skills — one moment.");
        }
        // Status + what-happens cells keyed by the VERBATIM bundle skill id —
        // the main process echoes payload ids untransformed in progress
        // events and in the failure envelope's failedSkills rows.
        const statusCells = new Map();
        const actionCells = new Map();
        for (const row of overlay.querySelectorAll(
          ".agents-publish-skill-row[data-skill]",
        )) {
          const cell = row.querySelector(".agents-publish-skill-status");
          if (cell) statusCells.set(row.dataset.skill, cell);
          const actionCell = row.querySelector(".agents-publish-skill-action");
          if (actionCell) actionCells.set(row.dataset.skill, actionCell);
        }
        const setRowStatus = (name, status) => {
          const cell = statusCells.get(name);
          if (cell) cell.dataset.status = status;
        };
        // Per-skill failure reasons from the install error envelope replace
        // the plan-time "Will be installed…" copy, so a failed row explains
        // itself instead of contradicting its ✕ mark.
        const applyFailedSkillReasons = (error) => {
          const failedSkills = Array.isArray(error?.body?.failedSkills)
            ? error.body.failedSkills
            : [];
          for (const entry of failedSkills) {
            const skillId = String(entry?.skill_id || "");
            if (!skillId) continue;
            setRowStatus(skillId, "error");
            const cell = actionCells.get(skillId);
            if (!cell) continue;
            const reason = String(entry?.error || "");
            if (/solution not found|not_found|\b404\b/i.test(reason)) {
              cell.innerHTML = `Its marketplace listing isn't shared with you.<span class="agents-publish-skill-action-remedy">Ask ${escapeHtml(
                installOwnerIdentity || "the author",
              )} to republish this agent.</span>`;
            } else {
              cell.textContent = `Couldn't be installed: ${reason.slice(0, 160)}`;
            }
          }
        };
        for (const plan of resolvedInstallPlan) {
          // Reuse rows keep their green check instead of regressing to
          // "Waiting" (main-process progress may still tick them).
          const cell = statusCells.get(plan.skillId);
          if (cell?.dataset?.status === "current") continue;
          setRowStatus(plan.skillId, "pending");
        }
        const modalSubmitBtn = overlay.querySelector(".agents-modal-submit");
        const unsubscribe = window.electronAPI?.aiMarketplace?.onInstallProgress?.(
          (event) => {
            if (!event || String(event.solutionId || "") !== String(solutionId)) {
              return;
            }
            if (event.phase === "skill:start") {
              setRowStatus(event.skillId, "working");
              // Skill work in flight: the spinners live in the table; the
              // button holds a plain label until only the agent remains.
              if (modalSubmitBtn) {
                modalSubmitBtn.textContent = isUpdate
                  ? "Updating skills…"
                  : "Installing skills…";
              }
            } else if (event.phase === "skill:done") {
              setRowStatus(event.skillId, "done");
            } else if (event.phase === "skill:refreshed") {
              setRowStatus(event.skillId, "done");
            } else if (event.phase === "skill:refresh-skipped") {
              setRowStatus(event.skillId, "kept");
            } else if (event.phase === "skill:error") {
              setRowStatus(event.skillId, "error");
            } else if (event.phase === "skill:rolled-back") {
              // The install failed after this dependency installed: its files
              // were removed again, so the ✓ must not outlive them.
              setRowStatus(event.skillId, "rolled-back");
              const cell = actionCells.get(event.skillId);
              if (cell) {
                cell.textContent =
                  "Installed, then removed again because the install failed.";
              }
            } else if (event.phase === "agent:start") {
              if (modalSubmitBtn) {
                modalSubmitBtn.innerHTML = `<div class="btn-spinner"></div> ${escapeHtml(busyLabel)}`;
              }
            }
          },
        );
        try {
          await performInstallSolution(solutionId, null, { rethrow: true });
        } catch (error) {
          applyFailedSkillReasons(error);
          // Full-undo footer: rollback + auto-added-marketplace outcomes ride
          // the envelope body; say what was cleaned up (or couldn't be).
          const notes = [];
          if (Array.isArray(error?.body?.rollback) && error.body.rollback.length) {
            notes.push("Everything this install had set up was removed.");
          }
          for (const mp of Array.isArray(error?.body?.addedMarketplaces)
            ? error.body.addedMarketplaces
            : []) {
            const label = mp?.name || mp?.id || "added";
            notes.push(
              mp?.outcome === "removed"
                ? `The "${label}" marketplace it had added was removed too.`
                : `The "${label}" marketplace it had added could not be removed and was left in place.`,
            );
          }
          if (notes.length) error.message = `${error.message} ${notes.join(" ")}`;
          throw error; // the modal footer renders the envelope message
        } finally {
          if (typeof unsubscribe === "function") unsubscribe();
        }
        closeModal();
        if (typeof onInstalled === "function") onInstalled();
      },
    });
    const submitBtn = overlay?.querySelector?.(".agents-modal-submit");
    if (submitBtn) submitBtn.disabled = true;
    void (async () => {
      const resolveStartedAt = Date.now();
      let resolution;
      try {
        resolution = await resolveInstallSkillPlans({ bundle, mode, solutionId });
      } catch (error) {
        resolution = {
          plans: [],
          errors: [
            {
              skillId: "resolution",
              displayName: "Agent bundle",
              error: error?.message || String(error),
            },
          ],
        };
      }
      installOwnerIdentity = String(resolution.ownerIdentity || "");
      logMarketplaceInstall("plan:resolved", {
        solutionId,
        mode,
        ms: Date.now() - resolveStartedAt,
        plans: resolution.plans.slice(0, 20).map((plan) => ({
          skillId: plan.skillId,
          provenance: plan.provenance,
        })),
        errors: resolution.errors.slice(0, 20).map((entry) => ({
          skillId: entry.skillId,
          errorMessage: String(entry.error || "").slice(0, 200),
        })),
      });
      if (document.getElementById("agents-modal-overlay") !== overlay) {
        return; // modal closed or replaced while resolving
      }
      const section = overlay.querySelector(".agents-publish-skill-provenance");
      const rows = overlay.querySelector(".agents-publish-skill-rows");
      if (rows) rows.innerHTML = buildInstallSkillPlanRowsHtml(resolution, mode);
      if (section) {
        section.dataset.state = resolution.errors.length ? "blocked" : "ready";
      }
      if (resolution.errors.length) {
        // The blocked rows already say what's wrong and Install stays
        // disabled — no footer restatement of the same errors.
        return;
      }
      resolvedInstallPlan = resolution.plans;
      if (submitBtn) submitBtn.disabled = false;
    })();
  }

  // "Update" on an outdated installed copy: reinstall the same solution in
  // place (id + link preserved; the main process advances the stored
  // remoteUpdatedAt baseline from its fresh solution read on success).
  async function updateInstalledAgentFromMarketplace(agentId, triggerBtn = null) {
    const link = state.marketplaceLinks?.[agentId];
    if (link?.relationship !== "installed" || !link?.solutionId) {
      notify("This agent is not an installed marketplace copy.", "error");
      return;
    }
    await installSolution(link.solutionId, triggerBtn, {
      mode: "update",
      onInstalled: () => {
        state.solutionFreshness.delete(agentId);
        // An agent update may have refreshed dependent skill contents too.
        invalidateSkillFreshness();
        renderMyAgents();
      },
    });
  }

  // Router: agent solutions get a pre-install provenance modal (how each
  // dependent skill resolves on this machine, with live progress); every
  // other solution type installs directly, and a failed bundle probe also
  // falls through so the existing no_bundle handling stays authoritative.
  // Returns true once the flow is underway (modal opened or direct install
  // succeeded); onInstalled fires only after a completed install.
  async function installSolution(
    solutionId,
    triggerBtn = null,
    { mode = "install", onInstalled = null } = {},
  ) {
    let bundle = state.discoverBundleCache.get(solutionId) || null;
    if (!bundle) {
      const restorePrep = setBusyButtonState(triggerBtn, "Preparing...");
      try {
        const bundleRes =
          await window.electronAPI?.aiMarketplace?.getBundle?.(solutionId);
        if (bundleRes?.success) bundle = bundleRes.data;
      } catch (error) {
        console.warn("[Agents] pre-install bundle probe failed", error);
      } finally {
        restorePrep();
      }
    }
    const normalizedBundle = normalizeSolutionBundle(bundle);
    logMarketplaceInstall("router:route", {
      solutionId,
      mode,
      cacheHit: Boolean(state.discoverBundleCache.get(solutionId)),
      bundleType: normalizedBundle?.type || "",
      routed: normalizedBundle?.type === TYPE_AGENTS ? "modal" : "direct",
    });
    if (normalizedBundle?.type !== TYPE_AGENTS) {
      const installed = await performInstallSolution(solutionId, triggerBtn);
      if (installed && typeof onInstalled === "function") onInstalled();
      return installed;
    }
    openAgentInstallModal({
      solutionId,
      bundle: normalizedBundle,
      mode,
      onInstalled,
    });
    return true;
  }

  async function performInstallSolution(
    solutionId,
    triggerBtn = null,
    { rethrow = false } = {},
  ) {
    console.log("[Agents] install solution", solutionId);
    const restoreButton = setBusyButtonState(triggerBtn, "Installing...");
    try {
      let existingLocalAgentId = "";
      try {
        const linksRes = await window.electronAPI?.aiMarketplace?.listLinks?.();
        existingLocalAgentId = findLinkedAgentIdForSolution(
          solutionId,
          linksRes?.links || {},
        );
      } catch (error) {
        console.warn("[Agents] Failed to load marketplace links before install", error);
      }

      const result = await window.electronAPI?.aiMarketplace?.install(solutionId, {
        existingAgentId: existingLocalAgentId,
      });
      if (!result?.success) {
        if (result?.code === "no_bundle") {
          const markedNonInstallable = markDiscoverSolutionAsNonInstallable(solutionId);
          if (triggerBtn) {
            triggerBtn.disabled = true;
            triggerBtn.title = "No bundle attached";
          }
          if (markedNonInstallable && state.mode === "discover") {
            renderDiscover();
          }
          throw new Error(
            "This marketplace entry is not installable because it has no bundle attached.",
          );
        }
        const detail = [
          result?.error || "Install failed",
          result?.code ? `code=${result.code}` : null,
          result?.status ? `status=${result.status}` : null,
        ]
          .filter(Boolean)
          .join(" · ");
        // Structured rethrow: the failure envelope's body (failedSkills with
        // their reasons, rollback outcomes) rides the error so the install
        // modal can repaint per-skill rows instead of dropping the detail.
        const error = new Error(detail);
        if (result?.code) error.code = result.code;
        if (typeof result?.status === "number") error.status = result.status;
        if (result?.body && typeof result.body === "object") {
          error.body = result.body;
        }
        throw error;
      }
      const data = result.data || {};
      const installAction = data.mutation === "updated" ? "Updated" : "Installed";
      // Structured, content-free: the raw result carries descriptions and the
      // MCP echo — never dump it (these logs ship in bug reports).
      logMarketplaceInstall("install:result", {
        solutionId,
        type: data.type || "",
        mutation: data.mutation || "unknown",
        agentId: data?.created?.id || existingLocalAgentId || "",
        installedSkillCount: Array.isArray(data.installedSkills)
          ? data.installedSkills.length
          : 0,
        failedSkills: Array.isArray(data.failedSkills)
          ? data.failedSkills.slice(0, 20).map((entry) => ({
              skillId: entry?.skill_id || "",
              errorMessage: String(entry?.error || "").slice(0, 200),
            }))
          : [],
        unresolvedSkillCount: data?.unresolved?.skill_ids?.length || 0,
        unresolvedToolServerCount: data?.unresolved?.tool_server_ids?.length || 0,
        refreshedSkillCount: Array.isArray(data.refreshedSkills)
          ? data.refreshedSkills.length
          : 0,
        skippedSkillRefreshes: Array.isArray(data.skippedSkillRefreshes)
          ? data.skippedSkillRefreshes.slice(0, 20).map((entry) => ({
              skillId: entry?.skill_id || "",
              reason: entry?.reason || "",
            }))
          : [],
        addedMarketplaceIds: Array.isArray(data.addedMarketplaces)
          ? data.addedMarketplaces.map((entry) => entry?.id).filter(Boolean)
          : [],
      });
      // The install may have added or refreshed skills on disk — the shared
      // skills-freshness snapshot is stale with it.
      invalidateSkillFreshness();
      let message = `${installAction} ${data.type || "solution"}.`;
      const installedSkills = Array.isArray(data.installedSkills)
        ? data.installedSkills
        : [];
      if (installedSkills.length) {
        message += ` Also installed ${installedSkills.length} dependent skill(s).`;
      }
      const refreshedSkills = Array.isArray(data.refreshedSkills)
        ? data.refreshedSkills
        : [];
      if (refreshedSkills.length) {
        message += ` Updated ${refreshedSkills.length} dependent skill(s) to the latest version.`;
      }
      const skippedSkillRefreshes = Array.isArray(data.skippedSkillRefreshes)
        ? data.skippedSkillRefreshes
        : [];
      if (skippedSkillRefreshes.length) {
        message += ` Kept your local edits on: ${skippedSkillRefreshes
          .map((entry) => entry.skill_id)
          .join(", ")}.`;
      }
      const installedToolServers = Array.isArray(data.installedToolServers)
        ? data.installedToolServers
        : [];
      if (installedToolServers.length) {
        message += ` Also installed ${installedToolServers.length} dependent MCP server(s).`;
      }
      const mcpEnableSummary = await enableRequiredMcpServersForAgentInstall(data);
      if (mcpEnableSummary.needsConfiguration.length) {
        message += ` Configuration required for ${mcpEnableSummary.needsConfiguration.join(", ")} before the agent can use it.`;
      } else if (mcpEnableSummary.enabled.length) {
        message += ` Enabled ${mcpEnableSummary.enabled.length} required MCP server(s).`;
      }
      if (data.unresolved) {
        const missingSkills = data.unresolved.skill_ids || [];
        const missingServers = data.unresolved.tool_server_ids || [];
        if (missingSkills.length || missingServers.length) {
          const parts = [];
          if (missingSkills.length) parts.push(`${missingSkills.length} skill(s)`);
          if (missingServers.length) parts.push(`${missingServers.length} MCP server(s)`);
          message += ` Missing: ${parts.join(", ")}. Install them via Agent Skills or Integrations.`;
        }
      }
      const failedSkills = Array.isArray(data.failedSkills)
        ? data.failedSkills
        : [];
      if (failedSkills.length) {
        message += ` ${failedSkills.length} dependent skill(s) failed to install.`;
      }
      const failedToolServers = Array.isArray(data.failedToolServers)
        ? data.failedToolServers
        : [];
      if (failedToolServers.length) {
        message += ` ${failedToolServers.length} dependent MCP server(s) failed to install.`;
      }
      if (mcpEnableSummary.failed.length) {
        message += ` ${mcpEnableSummary.failed.length} MCP server(s) could not be enabled.`;
      }
      const addedMarketplaces = Array.isArray(data.addedMarketplaces)
        ? data.addedMarketplaces
        : [];
      if (addedMarketplaces.length) {
        message += ` Added marketplace(s): ${addedMarketplaces
          .map((entry) => entry?.name || entry?.id || "unknown")
          .join(", ")}.`;
      }
      const warning =
        failedSkills.length ||
        failedToolServers.length ||
        mcpEnableSummary.needsConfiguration.length ||
        mcpEnableSummary.failed.length;
      notify(message, warning ? "warning" : "success");
      if (data.type === TYPE_AGENTS) {
        const resolvedAgentId = String(data?.created?.id || existingLocalAgentId || "").trim();
        if (resolvedAgentId) {
          if (existingLocalAgentId && existingLocalAgentId !== resolvedAgentId) {
            await window.electronAPI?.aiMarketplace?.clearLink(existingLocalAgentId);
          }
          await refreshMarketplaceLinks();
          upsertMyAgentFromInstallResult(data.created, solutionId);
          await repairLinkedAgentAccess("install-solution");
        }
        if (installedSkills.length) {
          await refreshInstalledSkillViews({ focusInstalledTab: false });
        }
        // Land where the new agent lives: the Installed tab ("marketplace"
        // mode key), not the All haystack.
        setMode("marketplace");
      } else if (data.type === TYPE_SKILL) {
        invalidateCatalogs();
        await loadCatalogs({ force: true });
        if (typeof window.showAgentSkillsView === "function") {
          window.showAgentSkillsView({ refresh: true });
        }
        if (typeof window.switchAgentSkillsToInstalledTab === "function") {
          window.switchAgentSkillsToInstalledTab();
        }
        notify(
          "Skill installed. Create or edit an agent to use it from chat.",
          "info",
        );
      } else if (data.type === TYPE_MCP_SERVERS) {
        invalidateCatalogs();
        await Promise.allSettled([
          loadCatalogs({ force: true }),
          refreshInstalledMcpServers(),
        ]);
        openMcpServersTab();
      } else if (state.mode !== "discover") {
        await loadMyAgents();
      }
      return true;
    } catch (error) {
      console.error("[Agents] install failed", error);
      // The modal path rethrows so openModal's submit wrapper renders the
      // failure inline; direct installs keep the toast-and-boolean contract.
      if (rethrow) throw error;
      notify(error.message, "error");
      return false;
    } finally {
      restoreButton();
    }
  }

  function openSettingsModal() {
    const body = `
      <form class="agents-form">
        <label>
          <span>AI Marketplace API key</span>
          <input type="password" name="api_key" placeholder="paste your key" autocomplete="off" />
        </label>
        <p style="color: var(--text-tertiary); font-size: 0.85rem;">
          Stored in the macOS Keychain. Required for publishing. Read paths (search, install) work without a key.
        </p>
      </form>
      <div class="agents-form-actions">
        <button class="btn-secondary agents-clear-key-btn" type="button">Clear stored key</button>
      </div>
    `;
    const overlay = openModal("AI Marketplace settings", body, {
      submitLabel: "Save",
      submitBusyLabel: "Saving...",
      onSubmit: async (modalOverlay) => {
        const form = modalOverlay.querySelector(".agents-form");
        const value = String(new FormData(form).get("api_key") || "").trim();
        if (!value) {
          notify("API key cannot be empty (use Clear instead).", "error");
          return;
        }
        const res = await window.electronAPI?.aiMarketplace?.setApiKey(value);
        if (!res?.success) {
          notify(res?.error || "Failed to save API key", "error");
          return;
        }
        notify("AI Marketplace API key saved.", "success");
        closeModal();
      },
    });
    overlay
      .querySelector(".agents-clear-key-btn")
      ?.addEventListener("click", async () => {
        const res = await window.electronAPI?.aiMarketplace?.clearApiKey();
        if (!res?.success) {
          notify(res?.error || "Failed to clear API key", "error");
          return;
        }
        notify("Stored API key cleared.", "success");
      });
  }

  // ===========================================================================
  // EVENT WIRING
  // ===========================================================================

  function setMode(mode) {
    state.mode = mode;
    const modeTabs = document.querySelectorAll(`#${cfg.modeTabsId} .mcp-filter-tab`);
    modeTabs.forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.agentsMode === mode);
    });

    const typeTabs = cfg.discoverTypeTabsId
      ? document.getElementById(cfg.discoverTypeTabsId)
      : null;
    if (typeTabs) {
      typeTabs.style.display = mode === "discover" ? "" : "none";
    }
    const searchInput = document.getElementById(cfg.searchInputId);
    if (searchInput) {
      searchInput.placeholder =
        mode === "discover" ? "Search the AI Marketplace..." : "Search agents...";
    }

    void refreshCurrentMode();
  }

  function setDiscoverType(type) {
    if (!DISCOVER_TYPES.has(type)) {
      return;
    }
    state.discoverType = type;
    const tabs = cfg.discoverTypeTabsId
      ? document.querySelectorAll(`#${cfg.discoverTypeTabsId} .mcp-filter-tab`)
      : [];
    tabs.forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.discoverType === type);
    });
    void runDiscoverSearch();
  }

  let searchDebounce = null;
  function handleSearchInput(value) {
    state.searchQuery = value || "";
    if (state.mode !== "discover") {
      renderMyAgents();
      return;
    }
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      searchDebounce = null;
      void runDiscoverSearch();
    }, 350);
  }

  function handleAgentAction(event) {
    if (event && event.__agentsActionHandled) {
      return;
    }
    if (event) {
      event.__agentsActionHandled = true;
    }
    // Walk up so SVG/text children inside menu items still resolve to the
    // button that carries data-agent-id / data-solution-id. Note SVG icons are
    // SVGElement (not HTMLElement), so gate on .closest support, not the type.
    const target = event.target;
    const btn =
      target && typeof target.closest === "function"
        ? target.closest("button")
        : null;
    if (!btn) return;
    if (btn.dataset.busy === "true") return;
    // Hero page-actions must not fire while the page's submit is in flight
    // (setModalBusyState only disables the footer/back buttons).
    if (
      state.editor?.root?.dataset.busy === "true" &&
      state.editor.root.contains(btn)
    ) {
      return;
    }
    const agentId = btn.getAttribute("data-agent-id");
    const solutionId = btn.getAttribute("data-solution-id");
    console.log(`[Agents:${cfg.key}] action click resolved`, {
      classes: btn.className,
      agentId,
      solutionId,
    });
    let handled = true;

    if (btn.classList.contains("agent-edit-btn") && agentId) {
      void openEditAgentEditor(agentId);
    } else if (btn.classList.contains("agent-details-btn") && agentId) {
      void openViewAgentPage(agentId);
    } else if (btn.classList.contains("agent-clone-btn") && agentId) {
      // Cloning from a dirty edit page must go through the discard guard so
      // unsaved edits aren't silently replaced by the prefilled create page.
      if (state.editor) {
        requestCloseAgentEditor(() => void cloneAgent(agentId));
      } else {
        void cloneAgent(agentId);
      }
    } else if (btn.classList.contains("agent-delete-btn") && agentId) {
      void deleteAgent(agentId);
    } else if (btn.classList.contains("agent-publish-btn") && agentId) {
      logMarketplacePublish("menu:publish-click", {
        agentId,
        inDropdown: Boolean(btn.classList.contains("mcp-dropdown-item")),
      });
      // Defense in depth: publishAgent settles its own failures, so this
      // backstop should never fire — but a discarded rejection is exactly how
      // PORTICO-414 became nine silent publish attempts.
      void publishAgentWithDirtySave(agentId, btn).catch((error) => {
        logMarketplacePublish("publish:unhandled-rejection", {
          agentId,
          code: typeof error?.code === "string" ? error.code : "unknown",
        });
        notify(
          "Publishing failed unexpectedly. Try again; if it keeps failing, restart the app.",
          "error",
        );
      });
    } else if (btn.classList.contains("agent-unpublish-btn") && agentId) {
      void unpublishAgent(agentId, btn);
    } else if (btn.classList.contains("agent-reclaim-btn") && agentId) {
      void reclaimAgent(agentId);
    } else if (btn.classList.contains("agent-update-btn") && agentId) {
      void updateInstalledAgentFromMarketplace(agentId, btn);
    } else if (btn.classList.contains("agent-use-btn") && agentId) {
      useAgentFromChat(agentId, btn.getAttribute("data-agent-name") || "");
    } else if (btn.classList.contains("agent-install-btn") && solutionId) {
      void installSolution(solutionId, btn);
    } else if (btn.classList.contains("solution-uninstall-btn") && solutionId) {
      void uninstallSolution(solutionId, btn);
    } else if (btn.classList.contains("solution-unpublish-btn") && solutionId) {
      void unpublishSolutionFromDiscover(solutionId, btn);
    } else {
      handled = false;
    }

    if (handled && btn.classList.contains("mcp-dropdown-item")) {
      closeAllAgentDropdowns();
    }
  }

  function init() {
    if (state.initialized) return;
    const view = getView();
    if (!view) return;
    state.initialized = true;

    const selfButton = document.getElementById(cfg.buttonId);
    selfButton?.addEventListener("click", showAgentsView);
    getOtherButtonIds().forEach((id) => {
      document.getElementById(id)?.addEventListener("click", () => {
        setAgentsVisible(false);
        selfButton?.classList.remove("active");
      });
    });

    // Capture-phase guard: leaving the Agents sub-view destroys the inline
    // editor, so unsaved changes must go through the discard confirmation.
    // Capture on the toggle container runs before every controller's
    // bubble-phase listener on the individual buttons. Near-zero cost when no
    // editor is open (single flag check).
    if (cfg.editorId) {
      document.querySelector(".panel-view-toggle")?.addEventListener(
        "click",
        (event) => {
          if (!state.editor) return;
          const target = event.target;
          const btn =
            target && typeof target.closest === "function"
              ? target.closest(".panel-view-btn")
              : null;
          // Clicking "Agents" while editing keeps the editor open.
          if (!btn || btn.id === cfg.buttonId) return;
          if (!isAgentEditorDirty()) {
            teardownAgentEditor();
            return; // clean: let the navigation click proceed
          }
          event.preventDefault();
          event.stopPropagation();
          showAgentsDiscardModal({
            subject: state.editor.subjectName,
            onDiscard: () => {
              teardownAgentEditor();
              btn.click(); // re-dispatch the blocked navigation
            },
          });
        },
        true,
      );
    }

    // Wrapped so the click Event never arrives as the prefill argument.
    document
      .getElementById(cfg.newAgentBtnId)
      ?.addEventListener("click", () => void openNewAgentEditor());
    document
      .getElementById(cfg.settingsBtnId)
      ?.addEventListener("click", openSettingsModal);

    document.querySelectorAll(`#${cfg.modeTabsId} .mcp-filter-tab`).forEach((tab) => {
      tab.addEventListener("click", () => setMode(tab.dataset.agentsMode));
    });
    if (cfg.discoverTypeTabsId) {
      document.querySelectorAll(`#${cfg.discoverTypeTabsId} .mcp-filter-tab`).forEach((tab) => {
        tab.addEventListener("click", () => setDiscoverType(tab.dataset.discoverType));
      });
    }

    const searchInput = document.getElementById(cfg.searchInputId);
    searchInput?.addEventListener("input", (e) => handleSearchInput(e.target.value));

    const list = getList();
    list?.addEventListener("click", handleAgentAction);
    // Card hover tooltip for the skills link: one delegated listener set on
    // the stable list node; content resolves at hover time from state so late
    // catalog loads are picked up.
    const AGENT_CARD_TOOLTIP_ANCHORS = ".agent-card-skills-link";
    const handleAgentCardTooltipShow = (event) => {
      const target = event.target;
      if (!target || typeof target.closest !== "function") return;
      const anchor = target.closest(AGENT_CARD_TOOLTIP_ANCHORS);
      if (!anchor) return;
      if (event.relatedTarget && anchor.contains(event.relatedTarget)) return;
      const html = resolveAgentCardTooltipHtml(anchor);
      if (html) showAgentCardTooltipFor(anchor, html);
    };
    const handleAgentCardTooltipHide = (event) => {
      const target = event.target;
      if (!target || typeof target.closest !== "function") return;
      const anchor = target.closest(AGENT_CARD_TOOLTIP_ANCHORS);
      if (!anchor) return;
      if (event.relatedTarget && anchor.contains(event.relatedTarget)) return;
      hideAgentCardTooltip();
    };
    list?.addEventListener("mouseover", handleAgentCardTooltipShow);
    list?.addEventListener("focusin", handleAgentCardTooltipShow);
    list?.addEventListener("mouseout", handleAgentCardTooltipHide);
    list?.addEventListener("focusout", handleAgentCardTooltipHide);
    list?.addEventListener("scroll", hideAgentCardTooltip, { passive: true });
    list?.addEventListener("click", (event) => {
      const target = event.target;
      if (!target || typeof target.closest !== "function") return;
      const link = target.closest(".agent-card-skills-link");
      if (!link) return;
      // Keyboard/touch affordance: clicking toggles the same tooltip.
      event.stopPropagation();
      const tooltip = getAgentCardFloatingTooltip();
      if (!tooltip.hidden) {
        hideAgentCardTooltip();
        return;
      }
      const html = resolveAgentCardTooltipHtml(link);
      if (html) showAgentCardTooltipFor(link, html);
    });
    // Generic info-icon tooltips: any .info-tooltip-trigger[data-info-tooltip]
    // anywhere in the document (agent editor, publish modals, marketplace
    // cards — other components build triggers via window.InfoTooltips) shares
    // the same body-mounted floating tooltip. Document-level delegation
    // because triggers live across hosts inside re-rendered markup; wired
    // once even though two tab controllers initialize.
    if (!window.InfoTooltips) {
      const INFO_TOOLTIP_SELECTOR =
        ".info-tooltip-trigger[data-info-tooltip], .info-tooltip-trigger[data-info-tooltip-list]";
      // Rich list tooltips (data-info-tooltip-list carries a JSON spec):
      // titled, one row per item with a small glyph, capped with a "+N more"
      // line — for name lists (agents using a skill, skills in a plugin)
      // where a comma-joined sentence reads like terminal output.
      const INFO_TOOLTIP_LIST_ICONS = {
        agent:
          '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle>',
        skill:
          '<path d="M12 2L2 7l10 5 10-5-10-5z"></path><path d="M2 17l10 5 10-5"></path><path d="M2 12l10 5 10-5"></path>',
        check: '<polyline points="20 6 9 17 4 12"></polyline>',
      };
      const INFO_TOOLTIP_LIST_MAX_ROWS = 10;
      const infoTooltipListHtml = (spec) => {
        const items = (Array.isArray(spec?.items) ? spec.items : [])
          .map((item) => String(item ?? "").trim())
          .filter(Boolean);
        if (!items.length) return "";
        const iconPath =
          INFO_TOOLTIP_LIST_ICONS[spec?.icon] || INFO_TOOLTIP_LIST_ICONS.skill;
        const shown = items.slice(0, INFO_TOOLTIP_LIST_MAX_ROWS);
        const overflow = items.length - shown.length;
        const rows = shown
          .map(
            (item) =>
              `<li><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${iconPath}</svg><span>${escapeHtml(item)}</span></li>`,
          )
          .join("");
        return `<div class="info-tooltip-rich">${
          spec?.title
            ? `<div class="info-tooltip-rich-title">${escapeHtml(String(spec.title))}</div>`
            : ""
        }<ul class="info-tooltip-rich-list">${rows}</ul>${
          overflow > 0
            ? `<div class="info-tooltip-rich-more">+${overflow} more</div>`
            : ""
        }${
          spec?.note
            ? `<div class="info-tooltip-rich-note">${escapeHtml(String(spec.note))}</div>`
            : ""
        }</div>`;
      };
      const infoTooltipHtml = (trigger) => {
        const listRaw = trigger?.dataset?.infoTooltipList;
        if (listRaw) {
          try {
            const html = infoTooltipListHtml(JSON.parse(listRaw));
            if (html) return html;
          } catch {
            // Malformed spec: fall through to the plain-text attribute.
          }
        }
        return `<div class="tooltip-content">${escapeHtml(trigger?.dataset?.infoTooltip || "")}</div>`;
      };
      const closestInfoTrigger = (node) =>
        node && typeof node.closest === "function"
          ? node.closest(INFO_TOOLTIP_SELECTOR)
          : null;
      const handleInfoTooltipShow = (event) => {
        const trigger = closestInfoTrigger(event.target);
        if (!trigger) return;
        if (event.relatedTarget && trigger.contains?.(event.relatedTarget)) return;
        showAgentCardTooltipFor(trigger, infoTooltipHtml(trigger));
      };
      const handleInfoTooltipHide = (event) => {
        const trigger = closestInfoTrigger(event.target);
        if (!trigger) return;
        if (event.relatedTarget && trigger.contains?.(event.relatedTarget)) return;
        hideAgentCardTooltip();
      };
      document.addEventListener("mouseover", handleInfoTooltipShow);
      document.addEventListener("focusin", handleInfoTooltipShow);
      document.addEventListener("mouseout", handleInfoTooltipHide);
      document.addEventListener("focusout", handleInfoTooltipHide);
      document.addEventListener("click", (event) => {
        const trigger = closestInfoTrigger(event.target);
        if (!trigger) return;
        // Keyboard/touch affordance: clicking toggles the tooltip and never
        // activates the trigger's surroundings (cards, menu rows).
        event.preventDefault();
        event.stopPropagation();
        const tooltip = getAgentCardFloatingTooltip();
        if (!tooltip.hidden) {
          hideAgentCardTooltip();
          return;
        }
        showAgentCardTooltipFor(trigger, infoTooltipHtml(trigger));
      });
      const INFO_TRIGGER_ICON =
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>';
      window.InfoTooltips = {
        triggerHtml: (text) =>
          `<span class="info-tooltip-trigger" role="button" tabindex="0" aria-label="More information" data-info-tooltip="${escapeHtml(text)}">${INFO_TRIGGER_ICON}</span>`,
        // spec: { title, items: string[], icon: "agent" | "skill" | "check" }
        // innerHtml (optional): caller markup (e.g. a badge chip) wrapped
        // INSIDE the trigger, making badge + icon ONE hover surface — the
        // delegated handlers already ignore pointer moves between a
        // trigger's own children, so the tooltip never flickers in the gap.
        listTriggerHtml: (spec, innerHtml = "") =>
          `<span class="info-tooltip-trigger${innerHtml ? " info-tooltip-trigger-inline" : ""}" role="button" tabindex="0" aria-label="${escapeHtml(String(spec?.title || "More information"))}" data-info-tooltip-list="${escapeHtml(JSON.stringify(spec || {}))}">${innerHtml}${INFO_TRIGGER_ICON}</span>`,
      };
    }
    // Page-level actions (use/clone/publish/unpublish/delete) on the inline
    // editor pages reuse the same delegated handler; unknown buttons
    // (Back/Cancel/Submit) fall through it harmlessly.
    getEditorHost()?.addEventListener("click", handleAgentAction);
    // The dropdown menu is moved to <body> when opened, so it isn't a child of
    // the list anymore. Dispatch action clicks from document for those too.
    document.addEventListener("click", (event) => {
      // SVG icons inside menu items are SVGElement (not HTMLElement); both
      // support .closest, so gate on that rather than the element type.
      const target = event.target;
      if (!target || typeof target.closest !== "function") return;
      const dropdown = target.closest('.mcp-card-dropdown[data-dropdown-agent-id], .mcp-card-dropdown[data-dropdown-solution-id]');
      // Only handle dropdowns owned by this controller (both controllers add a
      // document-level listener; the owner check prevents cross-talk).
      if (dropdown && dropdown.dataset.dropdownOwner === cfg.key) {
        handleAgentAction(event);
      }
    });
    document.addEventListener("click", handleAgentDropdownOutsideClick);
    // Copy buttons render inside editor pages AND body-mounted modals; one
    // document-level delegate covers both. Guarded so only the primary
    // controller instance wires it (two controllers share this module).
    if (cfg.key === "agentsTab") {
      document.addEventListener("click", handleCopyButtonClick);
    }

    console.log(`[Agents:${cfg.key}] Initialized`);
  }

  if (typeof window !== "undefined") {
    // The exact Agents-tab card, reused by the AI Marketplace publish modal
    // (interactive:false renders the presentation-only variant).
    window.AgentCardRenderer = { buildAgentCardHtml };
    // Card-presentation helpers exposed for the vm-harness unit tests.
    window.AgentCardTooltips = {
      buildAgentSkillsLinkHtml,
      buildAgentSkillsTooltipHtml,
      buildAgentSkillsProvenanceTooltipHtml,
      getAgentSkillDetails,
    };
    // Pure mode-filter helpers exposed for the vm-harness unit tests.
    window.AgentsTabRenderHooks = {
      filterAgentsForMode,
      filterAgents,
      agentOwnedByViewer,
      agentPublishedForViewer,
      agentLocallyReadOnly,
      agentCanPublish,
      agentCanUnpublish,
      agentCanReclaim,
      agentStatusBadgesHtml,
      // Skills-freshness layer (per-agent update badges + the read-only
      // view's status table), exposed for the vm-harness unit tests.
      loadSkillFreshnessSnapshot,
      ensureAgentSkillFreshnessScan,
      invalidateSkillFreshness,
      agentSkillFreshnessFor,
      agentHasSkillUpdates,
      skillFreshnessStatusFor,
      buildAgentViewSkillsTableHtml,
      getAgentSkillRowDetails,
      buildInstalledAgentViewHtml,
      buildDiscoverAgentViewHtml,
      discoverAgentCardBadgesHtml,
      applyAgentViewSkillStatuses,
      copyTextToClipboard,
      copyableIdBadgeHtml,
      handleCopyButtonClick,
      openAgentPageForCard,
      // Provenance gating (round 9): picker rows, publish-block tooltips,
      // and the legacy-id save normalization, exposed for the vm-harness
      // unit tests.
      renderCapabilityRows,
      orderCapabilityOptionsForOpen,
      normalizeSkill,
      agentBlockedSkillNames,
      blockedPublishTooltip,
      buildAgentPageActionsHtml,
      normalizeSelectedSkillIds,
      loadCatalogsForTests: loadCatalogs,
      baseModelsForTests: () => state.catalogs.baseModels || [],
      mountCapabilityPickerForTests: (container, options = {}) => {
        const items = Array.isArray(options.options) ? options.options : [];
        container.innerHTML = buildPicker({
          kind: options.kind,
          label: options.label || "",
          addButtonLabel: options.addButtonLabel || "Add",
          emptyText: options.emptyText || "No options available",
          options: items,
          selectedIds: options.value || [],
        });
        const picker = container.querySelector(".agents-picker");
        if (!picker) return null;
        wirePicker(picker, items, { emptyText: options.emptyText || "No options available" });
        return {
          getValue: () => readPickerSelection(picker),
          destroy: () => picker.dispatchEvent(new CustomEvent("agents-picker-detach")),
        };
      },
      setCatalogSkillsForTests: (skills) => {
        state.catalogs.skills = skills;
      },
      // Installed-agent update detection (the 2026-08-04 field-name bug had
      // zero coverage): the sweep + its gates, exposed for the vm harness.
      maybeCheckInstalledAgentFreshness,
      agentUpdateAvailable,
      setMarketplaceLinksForTests: (links) => {
        state.marketplaceLinks = links || {};
      },
      setAgentLocalFlagsForTests: (flags) => {
        state.agentLocalFlags = flags || {};
      },
      resetFreshnessCheckForTests: () => invalidateInstalledAgentFreshness(),
      solutionFreshnessForTests: () => state.solutionFreshness,
      // Deleted-agent prune, soft-miss edition (2026-08-08 access-flap
      // incident), exposed for the vm-harness unit tests.
      pruneMarketplaceLinksToExistingAgents,
      agentIdsFromListResponse,
      marketplaceLinksForTests: () => state.marketplaceLinks,
      myAgentsForTests: () => state.myAgents,
    };
    // Dependent-skill publish/install planners exposed for the vm-harness
    // unit tests.
    window.AgentsPublishHooks = {
      publishDependentSkills,
      resolveDependentSkillPlans,
      executeDependentSkillPlans,
      createDependentSkillPublishSummary,
      buildSkillProvenanceRowsHtml,
      resolveInstallSkillPlans,
      sortInstallPlansForDisplay,
      buildInstallSkillPlanRowsHtml,
      installSolution,
      performInstallSolution,
      pushAgentToMarketplace,
      republishAgentHeadless,
      executeBackendAgentPublish,
      resolveBackendAgentPublishSkillPlan,
      reclaimAgent,
      performReclaimAgent,
      deleteAgent,
      confirmedDeleteAgent,
      performDeleteAgent,
      uninstallSolution,
      performUninstallSolution,
      unpublishSolutionFromDiscover,
      buildAgentForm,
      openDiscoverAgentPage,
      // Cross-module + test surface: the Skills tab busts the owned-listings
      // memo after it publishes/unpublishes/reclaims a skill listing; the
      // Updates tab busts installed-agent freshness after bulk updates.
      invalidateMarketplaceSkillLookups,
      invalidateInstalledAgentFreshness,
    };
  }

  return {
    init,
    show: showAgentsView,
    loadMyAgents,
    runDiscoverSearch,
    handleSearchInput,
    publishAgent,
    publishAgentFromBackendRequest,
    executeBackendAgentPublish,
    unpublishAgent,
    useAgentFromChat,
  };
  } // end createAgentsController

  // "Agents" tab: My Agents + Discover locked to type=agents (no type tabs).
  const agentsTabController = createAgentsController({
    key: "agentsTab",
    buttonId: "view-agents-tab-btn",
    viewId: "agents-tab-view",
    listId: "agents-tab-list",
    browserId: "agents-tab-browser",
    editorId: "agents-tab-editor",
    headerActionsId: "agents-tab-header-actions",
    searchInputId: "agents-tab-search-input",
    modeTabsId: "agents-tab-mode-tabs",
    discoverTypeTabsId: null,
    newAgentBtnId: "agents-tab-new-agent-btn",
    settingsBtnId: "agents-tab-settings-btn",
    controlPlaneView: "agents-tab",
    lockedDiscoverType: TYPE_AGENTS,
    siblingButtonId: null,
    siblingViewId: null,
    siblingActionsId: null,
  });

  function initAllAgents() {
    agentsTabController.init();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAllAgents);
  } else {
    initAllAgents();
  }

  window.AgentsModule = agentsTabController;
  window.AgentsTabModule = agentsTabController;
  // Shared with the Agent Skills inline page (generic copy + subject slot).
  window.showAgentsDiscardModal = showAgentsDiscardModal;
  window.showAgentsConfirmModal = showAgentsConfirmModal;
})();
