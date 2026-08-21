// AI Marketplace approval modal - Chat UI layer.
// App-styled, minimizable replacement for the native dialog.showMessageBox
// confirmation that gates marketplace writes (publish agent/skill, unpublish).
// BATCHING: concurrent approval flows aggregate into ONE modal — every pending
// flow renders as an item (checkbox default-checked, card + solution-id copy
// badge); the confirm button approves checked items and denies unchecked ones,
// Cancel/X/Escape denies all, and each flow completes individually through
// notifyAiMarketplacePublishConfirmCompleted. Eyeball hide parks the whole
// batch via the shared native-input presentation channel (flow_ids), reopen
// restores it, and per-flow native-input-terminal events evict single items
// (e.g. a flow's own deny timeout) without touching the rest.

let aiMarketplacePublishTemplateLoaded = false;
// flowId -> item; insertion order is display order. `executing` marks the
// run-in-place phase after Approve: agent items publish sequentially in the
// renderer while their rows show live status chips; chrome is locked (the
// flows are already approved) until the queue drains.
const aiMarketplacePublishBatch = {
  items: new Map(),
  presentation: "visible",
  renderSeq: 0,
  executing: false,
};

// Approved main-side items (unpublish / skill publish / degraded hosts) hold
// a busy chip until the flow-keyed "ai-marketplace-publish-outcome" push
// settles them; the one-shot fallback timer covers a lost push. flowId →
// { item, timer, settle }.
const aiMarketplacePublishOutcomeWaits = new Map();
let AI_MARKETPLACE_PUBLISH_OUTCOME_FALLBACK_MS = 30000;

function settleAiMarketplacePublishOutcomeWait(flowId, outcome) {
  const wait = aiMarketplacePublishOutcomeWaits.get(flowId);
  if (!wait) return;
  aiMarketplacePublishOutcomeWaits.delete(flowId);
  clearTimeout(wait.timer);
  wait.settle(outcome);
}

function normalizeAiMarketplacePublishString(value) {
  const normalized = String(value || "").trim();
  return normalized || "";
}

function escapeAiMarketplacePublishHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const AI_MARKETPLACE_PUBLISH_COPY_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
const AI_MARKETPLACE_PUBLISH_CHECKED_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>';

async function loadAiMarketplacePublishTemplate() {
  if (
    aiMarketplacePublishTemplateLoaded ||
    document.getElementById("ai-marketplace-publish-modal")
  ) {
    aiMarketplacePublishTemplateLoaded = true;
    return;
  }
  const container = document.getElementById("ai-marketplace-publish-container");
  if (!container) {
    throw new Error("Container #ai-marketplace-publish-container not found");
  }
  const response = await fetch("renderer/components/ai-marketplace-publish-modal.html");
  container.innerHTML = await response.text();
  aiMarketplacePublishTemplateLoaded = true;
}

function getAiMarketplacePublishElements() {
  return {
    modal: document.getElementById("ai-marketplace-publish-modal"),
    title: document.getElementById("ai-marketplace-publish-title"),
    summary: document.getElementById("ai-marketplace-publish-summary"),
    items: document.getElementById("ai-marketplace-publish-items"),
    approveBtn: document.getElementById("ai-marketplace-publish-approve-btn"),
    cancelBtn: document.getElementById("ai-marketplace-publish-cancel-btn"),
    hideBtn: document.getElementById("ai-marketplace-publish-hide-btn"),
    closeBtn: document.getElementById("ai-marketplace-publish-close-btn"),
  };
}

function setAiMarketplacePublishInteractionSuppressed(suppressed) {
  window.setOwuiInteractionSuppressed?.("ai-marketplace-publish-modal", suppressed);
  window.setNativeOverlayInteractionSuppressed?.("ai-marketplace-publish-modal", suppressed);
}

function aiMarketplacePublishItems() {
  return [...aiMarketplacePublishBatch.items.values()];
}

// --- dev-only auto-approve -----------------------------------------------------
// Arms ONE 1s timer whenever the modal is visibly presenting at least one
// auto_approve-flagged item. The flag is stamped by main ONLY onto agentic
// broadcast payloads, and only on dev builds with the bug-drawer toggle on —
// manual control-plane confirms never reach this component. The callback
// re-validates the presentation (a hide/deny inside the window cancels the
// click) and never touches focus, preserving the focus-on-Cancel invariant.
let aiMarketplacePublishAutoApproveTimer = null;

function clearAiMarketplacePublishAutoApproveTimer() {
  if (aiMarketplacePublishAutoApproveTimer) {
    clearTimeout(aiMarketplacePublishAutoApproveTimer);
    aiMarketplacePublishAutoApproveTimer = null;
  }
}

function maybeArmAiMarketplacePublishAutoApprove() {
  if (aiMarketplacePublishAutoApproveTimer) return;
  if (aiMarketplacePublishBatch.executing) return;
  if (aiMarketplacePublishBatch.presentation !== "visible") return;
  // Post-mortem rows (status set) are display-only — never re-approve them.
  if (
    !aiMarketplacePublishItems().some((item) => item.autoApprove && !item.status)
  ) {
    return;
  }
  aiMarketplacePublishAutoApproveTimer = setTimeout(() => {
    aiMarketplacePublishAutoApproveTimer = null;
    if (
      aiMarketplacePublishBatch.presentation !== "visible" ||
      !aiMarketplacePublishBatch.items.size
    ) {
      return;
    }
    approveAiMarketplacePublishModal();
  }, 1000);
}

// AGENT/SKILL chip source: the explicit solution type when the route sent
// one, else whichever display payload the item carries.
function aiMarketplacePublishItemType(item) {
  if (item.solutionType === "agents" || item.agent) return "agent";
  if (item.solutionType === "skills" || item.skill) return "skill";
  return null;
}

function aiMarketplacePublishItemDomId(kind, flowId) {
  return `ai-marketplace-publish-item-${kind}-${flowId}`;
}

// --- rendering ---------------------------------------------------------------

function buildAiMarketplacePublishItemMetaHtml(item) {
  if (!item.solutionId) return "";
  const escapedId = escapeAiMarketplacePublishHtml(item.solutionId);
  const copyDomId = escapeAiMarketplacePublishHtml(
    aiMarketplacePublishItemDomId("copy", item.flowId),
  );
  const badgeDomId = escapeAiMarketplacePublishHtml(
    aiMarketplacePublishItemDomId("badge", item.flowId),
  );
  return `
    <div class="ai-marketplace-publish-item-meta">
      <code class="ai-marketplace-publish-id-badge" id="${badgeDomId}" title="${escapedId}">${escapedId}</code>
      <button
        type="button"
        class="ai-marketplace-publish-copy-btn"
        id="${copyDomId}"
        title="Copy solution id"
        aria-label="Copy solution id"
      >${AI_MARKETPLACE_PUBLISH_COPY_ICON}</button>
    </div>
  `;
}

function buildAiMarketplacePublishItemPromptHtml(item, { openPrompt = true } = {}) {
  const preview = normalizeAiMarketplacePublishString(item.agent?.system_prompt_preview);
  if (!preview) return "";
  const totalLength = Number(item.agent?.system_prompt_length) || preview.length;
  const text = totalLength > preview.length ? `${preview}...` : preview;
  const promptDomId = escapeAiMarketplacePublishHtml(
    aiMarketplacePublishItemDomId("prompt", item.flowId),
  );
  // Native <details>: collapsed inside batch grids so agent cards stay
  // uniform; open for the single-item modal (the pre-batch presentation).
  return `
    <details class="ai-marketplace-publish-prompt-block"${openPrompt ? " open" : ""}>
      <summary class="ai-marketplace-publish-prompt-label">System prompt preview</summary>
      <pre class="ai-marketplace-publish-prompt-pre" id="${promptDomId}">${escapeAiMarketplacePublishHtml(text)}</pre>
      <p class="ai-marketplace-publish-review-note">
        Review for any sensitive information (internal URLs, tokens, customer data) before publishing.
      </p>
    </details>
  `;
}

const AI_MARKETPLACE_PUBLISH_STATUS_PRESENTATION = {
  publishing: { status: "publishing", label: "Publishing…" },
  published: { status: "published", label: "✓ Published" },
  publish_failed: { status: "failed", label: "✕ Failed" },
  // Main-side unpublish items hold a busy chip until the flow-keyed outcome
  // push settles them (reusing the publishing/published/failed CSS states).
  removing: { status: "publishing", label: "Removing…" },
  removed: { status: "published", label: "✓ Removed" },
  remove_failed: { status: "failed", label: "✕ Failed" },
  // Outcome push never arrived (one-shot fallback): the write was approved
  // and is still finishing main-side.
  requested: { status: "published", label: "✓ Requested" },
};

function buildAiMarketplacePublishItemStatusHtml(item) {
  const presentation = AI_MARKETPLACE_PUBLISH_STATUS_PRESENTATION[item.status];
  if (!presentation) return "";
  const statusDomId = escapeAiMarketplacePublishHtml(
    aiMarketplacePublishItemDomId("status", item.flowId),
  );
  const title = item.statusError ? ` title="${escapeAiMarketplacePublishHtml(item.statusError)}"` : "";
  return `<span class="ai-marketplace-publish-item-status" id="${statusDomId}" data-status="${presentation.status}"${title}>${escapeAiMarketplacePublishHtml(presentation.label)}</span>`;
}

// In-place status tick for a running queue item — no full re-render, so open
// <details> prompts and scroll position survive each completion. The optional
// label override lets the cascade narrate sub-steps ("Publishing skills…")
// without minting extra statuses.
function updateAiMarketplacePublishItemStatusChip(item, { label } = {}) {
  const el = document.getElementById(
    aiMarketplacePublishItemDomId("status", item.flowId),
  );
  const presentation = AI_MARKETPLACE_PUBLISH_STATUS_PRESENTATION[item.status];
  if (!el || !presentation) return;
  el.setAttribute("data-status", presentation.status);
  el.textContent = label || presentation.label;
  if (item.statusError) {
    el.setAttribute("title", item.statusError);
  }
}

// --- dependent-skill provenance (publish-agent items) --------------------------

function aiMarketplacePublishSkillStatusIdPrefix(item) {
  return `${aiMarketplacePublishItemDomId("skillstatus", item.flowId)}-`;
}

const AI_MARKETPLACE_PUBLISH_SKILLS_UNAVAILABLE_NOTE =
  '<div class="ai-marketplace-publish-skills-note">Skill details unavailable — dependencies are verified at publish time.</div>';

// Loading placeholder: a table-shaped shimmer skeleton, one row per skill
// (bounded), so the section holds its final height instead of jumping when
// the resolved rows land.
function buildAiMarketplacePublishSkillsSkeletonHtml(skillCount) {
  const rows = Math.max(2, Math.min(6, skillCount || 3));
  const row = `
    <div class="ai-marketplace-publish-skills-skeleton-row">
      <span class="ai-marketplace-publish-skills-skeleton-cell"></span>
      <span class="ai-marketplace-publish-skills-skeleton-cell"></span>
      <span class="ai-marketplace-publish-skills-skeleton-cell"></span>
      <span class="ai-marketplace-publish-skills-skeleton-cell"></span>
    </div>`;
  return `<div class="ai-marketplace-publish-skills-skeleton" role="status" aria-label="Checking this agent's skills">${row.repeat(rows)}</div>`;
}

function buildAiMarketplacePublishSkillRowsHtml(item) {
  const build = window.AgentsPublishHooks?.buildSkillProvenanceRowsHtml;
  if (typeof build !== "function" || !item.skillPlanResolution) {
    return AI_MARKETPLACE_PUBLISH_SKILLS_UNAVAILABLE_NOTE;
  }
  try {
    return build(item.skillPlanResolution, {
      statusIdPrefix: aiMarketplacePublishSkillStatusIdPrefix(item),
    });
  } catch (error) {
    console.warn(
      "[Marketplace Publish] Failed to render skill rows:",
      error?.message || error,
    );
    return AI_MARKETPLACE_PUBLISH_SKILLS_UNAVAILABLE_NOTE;
  }
}

// The same status/source/what-happens table the control-plane publish modal
// shows, resolved once per item and cached — re-renders (live-append,
// eviction) rebuild from the cache, never re-resolve.
function buildAiMarketplacePublishItemSkillsHtml(item) {
  if (item.mode !== "publish-agent" || !item.agent) return "";
  const skillCount = Array.isArray(item.agent.skill_ids)
    ? item.agent.skill_ids.length
    : 0;
  const rowsDomId = escapeAiMarketplacePublishHtml(
    aiMarketplacePublishItemDomId("skillrows", item.flowId),
  );
  let rowsHtml;
  if (item.skillPlanState === "ready" || item.skillPlanState === "blocked") {
    rowsHtml = buildAiMarketplacePublishSkillRowsHtml(item);
  } else if (item.skillPlanState === "unavailable") {
    rowsHtml = AI_MARKETPLACE_PUBLISH_SKILLS_UNAVAILABLE_NOTE;
  } else {
    rowsHtml = buildAiMarketplacePublishSkillsSkeletonHtml(skillCount);
  }
  return `
    <div class="ai-marketplace-publish-skills">
      <div class="ai-marketplace-publish-skills-label">Skills (${skillCount})</div>
      <div class="ai-marketplace-publish-skills-rows" id="${rowsDomId}">${rowsHtml}</div>
    </div>
  `;
}

// Resolve the dependent-skill plan ONCE per publish-agent item. Rows land in
// a stable per-flow container (getElementById — survives re-renders), and the
// approve queue executes the SAME plan, so the table the user reviewed is
// exactly what runs. A blocked plan fails closed for THIS item only.
function ensureAiMarketplacePublishItemSkillPlan(item) {
  if (item.mode !== "publish-agent" || !item.agent || item.skillPlanState !== null) {
    return;
  }
  const resolvePlan = window.AgentsPublishHooks?.resolveBackendAgentPublishSkillPlan;
  if (typeof resolvePlan !== "function" || !item.agentId) {
    item.skillPlanState = "unavailable";
    return;
  }
  item.skillPlanState = "loading";
  void (async () => {
    let resolution;
    try {
      resolution = await resolvePlan({
        agentId: item.agentId,
        allowedEmailsOverride: item.allowedEmails,
      });
    } catch (error) {
      resolution = {
        plans: [],
        errors: [{ skillId: "This agent", error: error?.message || String(error) }],
      };
    }
    if (!aiMarketplacePublishBatch.items.has(item.flowId)) return;
    item.skillPlanResolution = resolution;
    item.skillPlanState = resolution.errors?.length ? "blocked" : "ready";
    const rowsEl = document.getElementById(
      aiMarketplacePublishItemDomId("skillrows", item.flowId),
    );
    if (rowsEl) {
      rowsEl.innerHTML = buildAiMarketplacePublishSkillRowsHtml(item);
    }
    if (item.skillPlanState === "blocked") {
      // Same rule as the control-plane modal (which blocks its submit): this
      // item cannot be approved until the blocker is fixed.
      item.blocked = true;
      item.checked = false;
      const checkEl = document.getElementById(
        aiMarketplacePublishItemDomId("check", item.flowId),
      );
      if (checkEl) {
        checkEl.classList.remove("checked");
        checkEl.setAttribute("aria-checked", "false");
        checkEl.innerHTML = "";
        checkEl.disabled = true;
        checkEl.setAttribute("title", "Can't publish yet — see the skills list");
      }
    }
    // Releases the approve gate once no plans are still resolving.
    syncAiMarketplacePublishExecutionChrome();
  })();
}

// Ticker plumbing: status cells are addressed by per-item ids (the fake-DOM
// test harness has no querySelector), and flip decisions come from plan data.
function setAiMarketplacePublishSkillRowStatus(item, canonicalName, status) {
  if (!canonicalName) return;
  const cell = document.getElementById(
    `${aiMarketplacePublishSkillStatusIdPrefix(item)}${canonicalName}`,
  );
  cell?.setAttribute?.("data-status", status);
}

function flipAiMarketplacePublishPlannedRowsToPending(item) {
  if (item.skillPlanState !== "ready") return;
  for (const plan of item.skillPlanResolution?.plans || []) {
    if (plan.hasMarketplaceWork) {
      setAiMarketplacePublishSkillRowStatus(item, plan.canonicalName, "pending");
    }
  }
}

function buildAiMarketplacePublishItemProgressHandler(item) {
  return (event = {}) => {
    const canonicalName = event.plan?.canonicalName;
    if (event.phase === "skill:start") {
      setAiMarketplacePublishSkillRowStatus(item, canonicalName, "working");
      updateAiMarketplacePublishItemStatusChip(item, { label: "Publishing skills…" });
    } else if (event.phase === "skill:done") {
      setAiMarketplacePublishSkillRowStatus(item, canonicalName, "done");
    } else if (event.phase === "skill:error") {
      setAiMarketplacePublishSkillRowStatus(item, canonicalName, "error");
    } else if (event.phase === "agent:start") {
      // Dependent skills are done; the chip narrates the agent write.
      updateAiMarketplacePublishItemStatusChip(item);
    }
  };
}

function buildAiMarketplacePublishItemHtml(item, { withHeader }) {
  const flowDomId = escapeAiMarketplacePublishHtml(item.flowId);
  const cardDomId = escapeAiMarketplacePublishHtml(
    aiMarketplacePublishItemDomId("card", item.flowId),
  );
  const type = aiMarketplacePublishItemType(item);
  // Executing/finished items swap the checkbox for a live status chip — the
  // decision is already made, only the outcome matters now.
  const statusHtml = buildAiMarketplacePublishItemStatusHtml(item);
  const checkHtml = statusHtml
    ? statusHtml
    : `<button
          type="button"
          class="ai-marketplace-publish-item-check${item.checked ? " checked" : ""}"
          id="${escapeAiMarketplacePublishHtml(aiMarketplacePublishItemDomId("check", item.flowId))}"
          role="checkbox"
          aria-checked="${item.checked ? "true" : "false"}"
          ${item.blocked ? "disabled " : ""}title="${
            item.blocked
              ? "Can't publish yet — see the skills list"
              : "Uncheck to deny this request"
          }"
        >${item.checked ? AI_MARKETPLACE_PUBLISH_CHECKED_ICON : ""}</button>`;
  // Checkbox renders from item.checked: a re-render (live-append, eviction)
  // must not visually re-check an item the user already unchecked. The shared
  // per-request boilerplate is NOT repeated here — it renders once per group.
  const headerHtml = withHeader
    ? `
      <div class="ai-marketplace-publish-item-header">
        ${checkHtml}
        <span class="ai-marketplace-publish-item-chip">${escapeAiMarketplacePublishHtml(item.confirmLabel)}</span>
        ${
          type
            ? `<span class="ai-marketplace-publish-item-chip ai-marketplace-publish-item-chip-type">${
                type === "agent" ? "AGENT" : "SKILL"
              }</span>`
            : ""
        }
        <span class="ai-marketplace-publish-item-title">${escapeAiMarketplacePublishHtml(item.title)}</span>
      </div>
    `
    : statusHtml
      ? `<div class="ai-marketplace-publish-item-header">${statusHtml}<span class="ai-marketplace-publish-item-title">${escapeAiMarketplacePublishHtml(item.title)}</span></div>`
      : "";
  const failed = item.status === "publish_failed" || item.status === "remove_failed";
  const errorNote =
    failed && item.statusError ? escapeAiMarketplacePublishHtml(item.statusError) : "";
  const metaHtml = buildAiMarketplacePublishItemMetaHtml(item);
  const cardHtml = `<div class="ai-marketplace-publish-card" id="${cardDomId}"></div>`;
  const skillsHtml = buildAiMarketplacePublishItemSkillsHtml(item);
  const promptHtml = buildAiMarketplacePublishItemPromptHtml(item, {
    openPrompt: !withHeader,
  });
  // Items with a provenance table span the whole grid row (the -wide class)
  // and seat the table BESIDE the card — a 4-column table is unreadable
  // inside one ~340px grid track. Narrow viewports wrap back to a stack.
  // The prompt preview sits BELOW the columns at full item width: inside the
  // 340px card column an open preview renders as an unreadable strip.
  const bodyHtml = skillsHtml
    ? `
      <div class="ai-marketplace-publish-item-columns">
        <div class="ai-marketplace-publish-item-main">
          ${metaHtml}
          ${cardHtml}
        </div>
        <div class="ai-marketplace-publish-item-side">${skillsHtml}</div>
      </div>
      ${promptHtml}
    `
    : `
      ${metaHtml}
      ${cardHtml}
      ${promptHtml}
    `;
  return `
    <div class="ai-marketplace-publish-item${skillsHtml ? " ai-marketplace-publish-item-wide" : ""}" data-flow-id="${flowDomId}">
      ${headerHtml}
      ${bodyHtml}
      <div class="ai-marketplace-publish-item-error" id="${escapeAiMarketplacePublishHtml(
        aiMarketplacePublishItemDomId("error", item.flowId),
      )}"${errorNote ? "" : " hidden"}>${errorNote}</div>
    </div>
  `;
}

// Batch grouping: one section per (mode, exact summary) pair, insertion
// ordered. Identical backend boilerplate collapses to a single explanation
// above its grid; publish-agent items whose "Visible to:" suffix differs
// correctly split into separate groups because the suffix is part of the
// summary string.
function aiMarketplacePublishGroupKey(item) {
  return `${item.mode || "other"} ${item.summary || ""}`;
}

function aiMarketplacePublishGroupLabel(item, count) {
  const base =
    item.mode === "publish-skill"
      ? "Publish · Skills"
      : item.mode === "publish-agent"
        ? "Publish · Agents"
        : item.mode === "unpublish"
          ? "Unpublish"
          : "Requests";
  return `${base} (${count})`;
}

function buildAiMarketplacePublishGroupsHtml(items) {
  const groups = new Map();
  for (const item of items) {
    const key = aiMarketplacePublishGroupKey(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.values()]
    .map((groupItems) => {
      const first = groupItems[0];
      const label = aiMarketplacePublishGroupLabel(first, groupItems.length);
      const summary = normalizeAiMarketplacePublishString(first.summary);
      return `
        <section class="ai-marketplace-publish-group">
          <p class="ai-marketplace-publish-group-title">${escapeAiMarketplacePublishHtml(label)}</p>
          ${
            summary
              ? `<p class="ai-marketplace-publish-group-summary">${escapeAiMarketplacePublishHtml(summary)}</p>`
              : ""
          }
          <div class="ai-marketplace-publish-group-grid">
            ${groupItems
              .map((item) => buildAiMarketplacePublishItemHtml(item, { withHeader: true }))
              .join("")}
          </div>
        </section>
      `;
    })
    .join("");
}

function aiMarketplacePublishAgentCardFallbackHtml(agent) {
  return `
    <div class="mcp-server-card agent-card">
      <div class="agent-card-header">
        <div class="agent-card-title"><strong>${escapeAiMarketplacePublishHtml(agent.name || agent.id)}</strong></div>
      </div>
      <div class="agent-card-body">
        <p class="agent-card-desc">${escapeAiMarketplacePublishHtml(agent.description || "No description")}</p>
      </div>
    </div>
  `;
}

function aiMarketplacePublishSkillCardFallbackHtml(skill) {
  return `
    <div class="mcp-server-card skill-card">
      <div class="mcp-card-header">
        <div class="mcp-card-title-info">
          <h3 class="mcp-card-name">${escapeAiMarketplacePublishHtml(skill.name || "Skill")}</h3>
        </div>
      </div>
      <div class="mcp-card-body">
        <p class="skill-card-description">${escapeAiMarketplacePublishHtml(skill.description || "No description")}</p>
      </div>
    </div>
  `;
}

// Skill cards render synchronously via the shared control-plane renderer.
function renderAiMarketplacePublishSkillCardInto(cardEl, skill) {
  if (!cardEl || !skill) return;
  try {
    const buildSkillCardHtml = window.SkillCardRenderer?.buildSkillCardHtml;
    cardEl.innerHTML =
      typeof buildSkillCardHtml === "function"
        ? buildSkillCardHtml(skill, {
            interactive: false,
            published: skill.published === true,
          })
        : aiMarketplacePublishSkillCardFallbackHtml(skill);
  } catch (error) {
    console.warn(
      "[Marketplace Publish] Failed to render the skill card:",
      error?.message || error,
    );
    cardEl.innerHTML = aiMarketplacePublishSkillCardFallbackHtml(skill);
  }
}

// Agent cards need the capability catalogs; ensure them ONCE per render pass
// and guard writes with the render generation so a stale async pass can never
// clobber a newer batch layout.
async function renderAiMarketplacePublishAgentCards(renderSeq, agentItems) {
  if (!agentItems.length) return;
  try {
    await window.AgentCapabilityCatalog?.ensure?.({});
  } catch (error) {
    console.warn(
      "[Marketplace Publish] Failed to load capability catalogs for agent cards:",
      error?.message || error,
    );
  }
  if (renderSeq !== aiMarketplacePublishBatch.renderSeq) return;
  for (const item of agentItems) {
    const cardEl = document.getElementById(
      aiMarketplacePublishItemDomId("card", item.flowId),
    );
    if (!cardEl) continue;
    try {
      const buildAgentCardHtml = window.AgentCardRenderer?.buildAgentCardHtml;
      cardEl.innerHTML =
        typeof buildAgentCardHtml === "function"
          ? buildAgentCardHtml(item.agent, { interactive: false })
          : aiMarketplacePublishAgentCardFallbackHtml(item.agent);
    } catch (error) {
      console.warn(
        "[Marketplace Publish] Failed to render the agent card:",
        error?.message || error,
      );
      cardEl.innerHTML = aiMarketplacePublishAgentCardFallbackHtml(item.agent);
    }
  }
}

function syncAiMarketplacePublishApproveButton() {
  const { approveBtn } = getAiMarketplacePublishElements();
  if (!approveBtn) return;
  const items = aiMarketplacePublishItems();
  if (aiMarketplacePublishBatch.executing) {
    const executingItems = items.filter(
      (item) => item.status === "publishing" || item.status === "removing",
    );
    const allRemoving =
      executingItems.length > 0 &&
      executingItems.every((item) => item.status === "removing");
    approveBtn.textContent = allRemoving ? "Removing…" : "Publishing…";
    return;
  }
  // Post-run linger: every item settled and released, the chrome closes in
  // ~800ms — keep the final busy label instead of flashing "Approve 0".
  if (!items.length) return;
  // Post-mortem-only state (failed rows kept for reading): Approve acts as a
  // dismiss, so say so.
  const actionable = items.filter((item) => !item.status);
  if (!actionable.length) {
    approveBtn.textContent = "Dismiss";
    return;
  }
  approveBtn.textContent =
    actionable.length === 1 && items.length === 1
      ? items[0].confirmLabel || "Publish"
      : `Approve ${actionable.filter((item) => item.checked).length}`;
}

// Publish gate: while any agent item's skill plan is still resolving, the
// primary button stays disabled — approving then would run a plan the user
// never reviewed. Every resolution path lands in a terminal state (ready /
// blocked / unavailable), so the gate always releases.
function aiMarketplacePublishHasLoadingSkillPlans() {
  return aiMarketplacePublishItems().some(
    (item) =>
      item.mode === "publish-agent" &&
      !!item.agent &&
      (item.skillPlanState === null || item.skillPlanState === "loading"),
  );
}

// While the approved queue runs, every dismissal affordance locks: the flows
// are already approved, so Cancel/X/Escape would lie. Hide stays available —
// a parked queue keeps publishing behind the chat pill — EXCEPT while
// main-side outcome waits exist: those flows are already COMPLETED, so the
// presentation channel would reject re-parking them.
function syncAiMarketplacePublishExecutionChrome() {
  const { approveBtn, cancelBtn, closeBtn, hideBtn } =
    getAiMarketplacePublishElements();
  const executing = aiMarketplacePublishBatch.executing;
  // Approve also locks through the post-run linger (no items left to act on)
  // and while skill plans are still resolving (Cancel stays available).
  if (approveBtn) {
    approveBtn.disabled =
      executing ||
      !aiMarketplacePublishBatch.items.size ||
      aiMarketplacePublishHasLoadingSkillPlans();
  }
  if (cancelBtn) cancelBtn.disabled = executing;
  if (closeBtn) closeBtn.disabled = executing;
  if (hideBtn) hideBtn.disabled = aiMarketplacePublishOutcomeWaits.size > 0;
  syncAiMarketplacePublishApproveButton();
}

function wireAiMarketplacePublishItemHandlers() {
  for (const item of aiMarketplacePublishItems()) {
    const checkEl = document.getElementById(
      aiMarketplacePublishItemDomId("check", item.flowId),
    );
    if (checkEl && item.blocked) {
      // Blocked items (unpublishable skill plan) can never be re-checked.
      checkEl.onclick = null;
    } else if (checkEl) {
      checkEl.onclick = () => {
        // Component-owned checkbox state: the button reflects item.checked.
        item.checked = !item.checked;
        checkEl.classList.toggle("checked", item.checked);
        checkEl.setAttribute("aria-checked", item.checked ? "true" : "false");
        checkEl.innerHTML = item.checked ? AI_MARKETPLACE_PUBLISH_CHECKED_ICON : "";
        syncAiMarketplacePublishApproveButton();
      };
    }
    const copyEl = document.getElementById(
      aiMarketplacePublishItemDomId("copy", item.flowId),
    );
    if (copyEl && item.solutionId) {
      copyEl.onclick = () => {
        const value = item.solutionId;
        try {
          if (typeof window.electronAPI?.copyToClipboard === "function") {
            window.electronAPI.copyToClipboard(value);
          } else {
            void navigator.clipboard?.writeText?.(value);
          }
        } catch (error) {
          console.warn("[Marketplace Publish] copy failed:", error?.message || error);
        }
        copyEl.innerHTML = AI_MARKETPLACE_PUBLISH_CHECKED_ICON;
        setTimeout(() => {
          copyEl.innerHTML = AI_MARKETPLACE_PUBLISH_COPY_ICON;
        }, 1200);
      };
    }
  }
}

function renderAiMarketplacePublishModal() {
  const elements = getAiMarketplacePublishElements();
  const items = aiMarketplacePublishItems();
  const renderSeq = ++aiMarketplacePublishBatch.renderSeq;
  const single = items.length === 1;

  // Batch mode widens the dialog (CSS .batch) so grouped request cards can
  // sit side by side; the single-item presentation keeps the narrow layout —
  // unless the item carries the skills provenance table (CSS .roomy), which
  // needs the width to seat the table beside the agent card.
  elements.modal?.classList.toggle("batch", !single);
  elements.modal?.classList.toggle(
    "roomy",
    items.some((item) => item.mode === "publish-agent" && !!item.agent),
  );

  if (elements.title) {
    elements.title.textContent = single
      ? items[0].title || "Publish to the AI Marketplace"
      : `Marketplace approvals (${items.length})`;
  }
  if (elements.summary) {
    const summary = single
      ? items[0].summary || ""
      : "Review each request below. Unchecked requests will be denied.";
    elements.summary.textContent = summary;
    elements.summary.hidden = !summary;
  }
  syncAiMarketplacePublishApproveButton();

  if (elements.items) {
    elements.items.innerHTML = single
      ? items
          .map((item) => buildAiMarketplacePublishItemHtml(item, { withHeader: false }))
          .join("")
      : buildAiMarketplacePublishGroupsHtml(items);
    wireAiMarketplacePublishItemHandlers();
    for (const item of items) {
      ensureAiMarketplacePublishItemSkillPlan(item);
    }
    // Plan kicks may have flipped items to loading (initial show OR a
    // live-appended flow): re-derive the approve gate from the new states.
    syncAiMarketplacePublishExecutionChrome();
    for (const item of items) {
      if (item.skill && !item.agent) {
        renderAiMarketplacePublishSkillCardInto(
          document.getElementById(aiMarketplacePublishItemDomId("card", item.flowId)),
          item.skill,
        );
      }
    }
    void renderAiMarketplacePublishAgentCards(
      renderSeq,
      items.filter((item) => item.agent),
    );
  }
}

// --- lifecycle ----------------------------------------------------------------

function showAiMarketplacePublishModal() {
  if (!aiMarketplacePublishBatch.items.size) {
    return false;
  }
  const { modal, cancelBtn } = getAiMarketplacePublishElements();
  if (!modal) {
    return false;
  }
  aiMarketplacePublishBatch.presentation = "visible";
  renderAiMarketplacePublishModal();
  syncAiMarketplacePublishExecutionChrome();
  modal.classList.add("visible");
  modal.setAttribute("aria-hidden", "false");
  modal.setAttribute("tabindex", "-1");
  setAiMarketplacePublishInteractionSuppressed(true);
  // Default focus goes to CANCEL: the window may have been force-activated
  // for an LLM-initiated write, and a buffered Enter/Space must never approve
  // a marketplace publish the user did not read.
  setTimeout(() => cancelBtn?.focus?.(), 0);
  maybeArmAiMarketplacePublishAutoApprove();
  return true;
}

async function hideAiMarketplacePublishModal() {
  if (!aiMarketplacePublishBatch.items.size) {
    return false;
  }
  const setPresentation = window.electronAPI?.setNativeInputPresentation;
  if (typeof setPresentation !== "function") {
    return false;
  }
  const { modal } = getAiMarketplacePublishElements();
  modal?.classList.remove("visible");
  modal?.setAttribute("aria-hidden", "true");
  setAiMarketplacePublishInteractionSuppressed(false);
  aiMarketplacePublishBatch.presentation = "hidden";
  clearAiMarketplacePublishAutoApproveTimer();

  try {
    // ONE presentation call parks the whole batch; the chat pill counts every
    // hidden marketplace flow, so the badge shows the real pending number.
    const result = await setPresentation({
      kind: "marketplace_publish",
      flow_ids: [...aiMarketplacePublishBatch.items.keys()],
      presentation: "hidden",
    });
    if (!result?.success) {
      throw new Error(result?.error || "Failed to hide publish approval");
    }
    return true;
  } catch (error) {
    console.error("[Marketplace Publish] Failed to hide modal:", error);
    showAiMarketplacePublishModal();
    return false;
  }
}

function closeAiMarketplacePublishChrome() {
  clearAiMarketplacePublishAutoApproveTimer();
  const { modal } = getAiMarketplacePublishElements();
  if (modal) {
    modal.classList.remove("visible");
    modal.setAttribute("aria-hidden", "true");
  }
  setAiMarketplacePublishInteractionSuppressed(false);
}

// Exported teardown: settles every remaining item's runner promise WITHOUT
// sending completions (callers that need completions use approve/deny).
function closeAiMarketplacePublishModal(options = {}) {
  for (const flowId of [...aiMarketplacePublishOutcomeWaits.keys()]) {
    // Unblock any in-flight execution phase without touching chips or
    // re-resolving runners — the items are being torn down anyway.
    settleAiMarketplacePublishOutcomeWait(flowId, { teardown: true });
  }
  for (const item of aiMarketplacePublishItems()) {
    if (typeof item.resolve === "function") {
      item.resolve(options.result || null);
    }
  }
  aiMarketplacePublishBatch.items.clear();
  closeAiMarketplacePublishChrome();
}

function settleAiMarketplacePublishItem(item, action) {
  window.electronAPI?.notifyAiMarketplacePublishConfirmCompleted?.({
    flow_id: item.flowId,
    action,
  });
  if (typeof item.resolve === "function") {
    item.resolve({ action });
  }
}

// Cancel / X / Escape: deny every remaining request. No-op while the approved
// queue is executing (those flows are already past the decision).
function denyAiMarketplacePublishModal() {
  if (aiMarketplacePublishBatch.executing) return;
  for (const item of aiMarketplacePublishItems()) {
    // Post-mortem rows (a failed outcome kept them visible) already settled
    // their flow — dismissing must not send a second completion.
    if (item.status) continue;
    settleAiMarketplacePublishItem(item, "denied");
  }
  aiMarketplacePublishBatch.items.clear();
  closeAiMarketplacePublishChrome();
}

// Confirm: approve checked items, deny unchecked ones — one decisive action,
// no item is left pending to time out. Checked publish-agent items do NOT
// settle with a bare "approved" (main's fallback executor fails closed for
// agents with real dependent skills): they run IN PLACE through the renderer
// executor, each row ticking Publishing… → ✓/✕ while the modal stays open.
function approveAiMarketplacePublishModal() {
  if (aiMarketplacePublishBatch.executing) return;
  const items = aiMarketplacePublishItems();
  const executor = window.AgentsTabModule?.executeBackendAgentPublish;
  const agentQueue = [];
  const mainSideQueue = [];
  for (const item of items) {
    // Post-mortem rows (a failed outcome kept them visible) are display-only;
    // a second Approve must not re-send their completions.
    if (item.status) continue;
    if (!item.checked) {
      settleAiMarketplacePublishItem(item, "denied");
      aiMarketplacePublishBatch.items.delete(item.flowId);
      continue;
    }
    if (
      item.mode === "publish-agent" &&
      typeof executor === "function" &&
      item.agentId
    ) {
      agentQueue.push(item);
      continue;
    }
    if (!aiMarketplacePublishOutcomeChannelAvailable) {
      // Hosts without the outcome channel (older preload) keep the legacy
      // contract: settle immediately; the write still runs main-side,
      // unobserved by this modal.
      settleAiMarketplacePublishItem(item, "approved");
      aiMarketplacePublishBatch.items.delete(item.flowId);
      continue;
    }
    // Skill publishes / unpublishes (and degraded hosts without the agents
    // module) execute main-side after "approved"; they hold a busy chip until
    // the flow-keyed outcome push settles them.
    mainSideQueue.push(item);
  }
  if (!agentQueue.length && !mainSideQueue.length) {
    aiMarketplacePublishBatch.items.clear();
    closeAiMarketplacePublishChrome();
    return;
  }
  void runAiMarketplacePublishExecutionPhase(agentQueue, mainSideQueue);
}

// Sequential renderer-side execution of the approved agent publishes plus
// OBSERVED main-side execution of everything else (unpublish, skill publish,
// degraded hosts). All flows flip to "publishing" up front (main swaps each
// deny timer for the publish budget BEFORE any queue wait); agent items then
// publish one at a time — registry-write-lock friendly, each later resolve
// seeing the earlier items' fresh listings/links — while main-side items hold
// a busy chip ("Removing…") until the flow-keyed outcome push (or its
// one-shot fallback) settles them. Unpublish no longer vanishes the modal
// before anything actually happened.
async function runAiMarketplacePublishExecutionPhase(agentQueue, mainSideQueue) {
  aiMarketplacePublishBatch.executing = true;
  clearAiMarketplacePublishAutoApproveTimer();

  // Main-side items: status BEFORE the sends (the "approved" terminal echo is
  // then ignored by the terminal guard), publishing → approved, then wait.
  const mainSummary = { ok: 0, failed: 0, pending: 0 };
  const mainSideWaits = [];
  for (const item of mainSideQueue) {
    item.status = item.mode === "unpublish" ? "removing" : "publishing";
    try {
      window.electronAPI?.notifyAiMarketplacePublishConfirmCompleted?.({
        flow_id: item.flowId,
        action: "publishing",
      });
      window.electronAPI?.notifyAiMarketplacePublishConfirmCompleted?.({
        flow_id: item.flowId,
        action: "approved",
      });
    } catch {
      /* main's flow timers own the fallback terminal */
    }
    mainSideWaits.push(
      new Promise((settle) => {
        const timer = setTimeout(() => {
          settleAiMarketplacePublishOutcomeWait(item.flowId, { fallback: true });
        }, AI_MARKETPLACE_PUBLISH_OUTCOME_FALLBACK_MS);
        aiMarketplacePublishOutcomeWaits.set(item.flowId, { item, timer, settle });
      }).then((outcome) => {
        if (outcome?.teardown) return;
        if (outcome?.fallback) {
          item.status = "requested";
          item.statusError = "Still finishing — check the chat for the outcome.";
          mainSummary.pending += 1;
        } else if (outcome?.ok) {
          item.status = item.mode === "unpublish" ? "removed" : "published";
          mainSummary.ok += 1;
        } else {
          item.status =
            item.mode === "unpublish" ? "remove_failed" : "publish_failed";
          item.statusError =
            outcome?.message || "The request failed. See the chat for details.";
          mainSummary.failed += 1;
          const errorEl = document.getElementById(
            aiMarketplacePublishItemDomId("error", item.flowId),
          );
          if (errorEl) {
            errorEl.textContent = item.statusError;
            errorEl.hidden = false;
          }
        }
        updateAiMarketplacePublishItemStatusChip(item);
        if (typeof item.resolve === "function") {
          item.resolve({ action: "approved" });
        }
      }),
    );
  }

  for (const item of agentQueue) {
    item.status = "publishing";
    try {
      window.electronAPI?.notifyAiMarketplacePublishConfirmCompleted?.({
        flow_id: item.flowId,
        action: "publishing",
      });
    } catch {
      /* main's flow timers own the fallback terminal */
    }
  }
  if (aiMarketplacePublishBatch.presentation === "visible") {
    renderAiMarketplacePublishModal();
  }
  syncAiMarketplacePublishExecutionChrome();
  // The provenance rows the user reviewed become the cascade's ticker: rows
  // with real marketplace work flip to Waiting, then tick as the plan runs.
  for (const item of agentQueue) {
    flipAiMarketplacePublishPlannedRowsToPending(item);
  }

  const executor = window.AgentsTabModule?.executeBackendAgentPublish;
  const summary = { published: 0, failed: 0 };
  for (const item of agentQueue) {
    let action = "published";
    let extra = {};
    try {
      const result = await executor({
        agentId: item.agentId,
        allowedEmailsOverride: item.allowedEmails,
        resolvedSkillPlan:
          item.skillPlanState === "ready" ? item.skillPlanResolution.plans : null,
        onProgress: buildAiMarketplacePublishItemProgressHandler(item),
      });
      extra = { result };
      item.status = "published";
      summary.published += 1;
    } catch (error) {
      action = "publish_failed";
      const message = error?.message || String(error);
      extra = {
        error: message,
        ...(error?.code ? { code: String(error.code) } : {}),
      };
      item.status = "publish_failed";
      item.statusError = message;
      summary.failed += 1;
    }
    try {
      window.electronAPI?.notifyAiMarketplacePublishConfirmCompleted?.({
        flow_id: item.flowId,
        action,
        ...extra,
      });
    } catch {
      /* main's flow timers own the fallback terminal */
    }
    if (typeof item.resolve === "function") {
      item.resolve({ action });
    }
    updateAiMarketplacePublishItemStatusChip(item);
  }

  await Promise.all(mainSideWaits);

  // Settled items release; FAILED main-side rows stay visible so the user can
  // read the error (Cancel/X or a later Approve dismisses them). Requests
  // that live-appended while the queue ran stay pending for a fresh decision.
  for (const item of agentQueue) {
    aiMarketplacePublishBatch.items.delete(item.flowId);
  }
  for (const item of mainSideQueue) {
    if (item.status === "remove_failed" || item.status === "publish_failed") {
      continue;
    }
    aiMarketplacePublishBatch.items.delete(item.flowId);
  }
  aiMarketplacePublishBatch.executing = false;

  let summaryText;
  const totalFailed = summary.failed + mainSummary.failed;
  if (!mainSideQueue.length) {
    // Agent-only runs keep the historical phrasing.
    summaryText = summary.failed
      ? `Published ${summary.published} of ${summary.published + summary.failed} agents. ${summary.failed} failed — see the chat for details.`
      : `Published ${summary.published} agent${summary.published === 1 ? "" : "s"}.`;
  } else {
    const parts = [];
    const publishedCount = summary.published + mainSummary.ok;
    // Main-side ok counts are removals only when the item was an unpublish;
    // mixed batches read best as one settled tally.
    if (publishedCount) {
      const removedOnly =
        !summary.published &&
        mainSideQueue.every((item) => item.mode === "unpublish");
      parts.push(
        removedOnly
          ? `Removed ${publishedCount} listing${publishedCount === 1 ? "" : "s"} from the AI Marketplace.`
          : `${publishedCount} request${publishedCount === 1 ? "" : "s"} completed.`,
      );
    }
    if (mainSummary.pending) {
      parts.push(
        `${mainSummary.pending} still finishing — check the chat for the outcome.`,
      );
    }
    if (totalFailed) {
      parts.push(`${totalFailed} failed — see the details above or in the chat.`);
    }
    summaryText = parts.join(" ") || "Marketplace requests settled.";
  }
  window.showNotification?.(summaryText, totalFailed ? "error" : "success");
  void window.AgentsTabModule?.loadMyAgents?.();

  if (!aiMarketplacePublishBatch.items.size) {
    // Let the last ✓/✕ paint before the chrome goes away.
    setTimeout(() => {
      if (!aiMarketplacePublishBatch.items.size && !aiMarketplacePublishBatch.executing) {
        closeAiMarketplacePublishChrome();
      }
    }, 800);
    syncAiMarketplacePublishExecutionChrome();
    return;
  }
  if (aiMarketplacePublishBatch.presentation === "visible") {
    renderAiMarketplacePublishModal();
  }
  syncAiMarketplacePublishExecutionChrome();
  maybeArmAiMarketplacePublishAutoApprove();
}

function attachAiMarketplacePublishModalListeners() {
  const elements = getAiMarketplacePublishElements();
  if (elements.cancelBtn) {
    elements.cancelBtn.onclick = () => denyAiMarketplacePublishModal();
  }
  if (elements.closeBtn) {
    elements.closeBtn.onclick = () => denyAiMarketplacePublishModal();
  }
  if (elements.hideBtn) {
    elements.hideBtn.onclick = () => void hideAiMarketplacePublishModal();
  }
  if (elements.approveBtn) {
    elements.approveBtn.onclick = () => approveAiMarketplacePublishModal();
  }
  if (elements.modal) {
    elements.modal.onkeydown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        denyAiMarketplacePublishModal();
      }
    };
  }
}

async function runAiMarketplacePublishModal(payload = {}) {
  await loadAiMarketplacePublishTemplate();

  const flowId = normalizeAiMarketplacePublishString(payload?.flow_id);
  if (!flowId) {
    throw new Error("ai-marketplace publish flow_id is required");
  }
  if (aiMarketplacePublishBatch.items.has(flowId)) {
    throw new Error(`ai-marketplace publish flow ${flowId} is already pending`);
  }

  return new Promise((resolve) => {
    const item = {
      flowId,
      mode: normalizeAiMarketplacePublishString(payload?.mode) || null,
      title: normalizeAiMarketplacePublishString(payload?.title),
      confirmLabel:
        normalizeAiMarketplacePublishString(payload?.confirm_label) || "Publish",
      summary: String(payload?.summary || ""),
      agent:
        payload?.agent && typeof payload.agent === "object" ? payload.agent : null,
      skill:
        payload?.skill && typeof payload.skill === "object" ? payload.skill : null,
      solutionId: normalizeAiMarketplacePublishString(payload?.solution_id) || null,
      solutionType:
        normalizeAiMarketplacePublishString(payload?.solution_type) || null,
      republish: payload?.republish === true,
      autoApprove: payload?.auto_approve === true,
      checked: true,
      resolve,
      // Approved publish-agent items execute in the renderer: the executor
      // needs the local agent id and the chat-supplied audience override.
      agentId: normalizeAiMarketplacePublishString(payload?.agent?.id) || null,
      allowedEmails: Array.isArray(payload?.allowed_emails)
        ? payload.allowed_emails
        : null,
      status: null,
      statusError: null,
      // Dependent-skill provenance for publish-agent items: resolved once on
      // first render, reused verbatim by the approve queue.
      skillPlanState: null,
      skillPlanResolution: null,
      blocked: false,
    };
    aiMarketplacePublishBatch.items.set(flowId, item);

    const { modal } = getAiMarketplacePublishElements();
    if (!modal) {
      aiMarketplacePublishBatch.items.delete(flowId);
      throw new Error("#ai-marketplace-publish-modal not found after template load");
    }

    if (aiMarketplacePublishBatch.items.size === 1) {
      attachAiMarketplacePublishModalListeners();
      showAiMarketplacePublishModal();
      return;
    }
    if (aiMarketplacePublishBatch.presentation === "hidden") {
      // The batch is parked behind the chat pill: the newcomer joins it
      // hidden so the pill's pending count grows instead of a surprise modal.
      void window.electronAPI
        ?.setNativeInputPresentation?.({
          kind: "marketplace_publish",
          flow_ids: [flowId],
          presentation: "hidden",
        })
        ?.catch?.(() => {});
      return;
    }
    // Live-append into the open modal.
    renderAiMarketplacePublishModal();
    maybeArmAiMarketplacePublishAutoApprove();
  });
}

window.runAiMarketplacePublishModal = runAiMarketplacePublishModal;
window.closeAiMarketplacePublishModal = closeAiMarketplacePublishModal;
window.hideAiMarketplacePublishModal = hideAiMarketplacePublishModal;
// Contention predicate for the consolidated agents publish modal: while ANY
// batch item is pending (visible or hidden) the agents overlay would render
// underneath this modal — the agents seam fast-fails with publish_ui_busy.
window.AiMarketplacePublishBatch = {
  isActive: () => aiMarketplacePublishBatch.items.size > 0,
  // Test seam: shrink the lost-outcome fallback so suites don't wait 30s.
  _setOutcomeFallbackMsForTests: (ms) => {
    AI_MARKETPLACE_PUBLISH_OUTCOME_FALLBACK_MS = Number(ms) > 0 ? Number(ms) : 30000;
  },
};

// Flow-keyed outcome of an approved main-side write. Pushes also fire for
// renderer-executed publish-agent flows and for flows owned by other windows;
// only registered waits react. Hosts without the channel keep the legacy
// instant-settle contract (see approveAiMarketplacePublishModal).
const aiMarketplacePublishOutcomeChannelAvailable =
  typeof window.electronAPI?.onAiMarketplacePublishOutcome === "function";
if (aiMarketplacePublishOutcomeChannelAvailable) {
  window.electronAPI.onAiMarketplacePublishOutcome((payload = {}) => {
    const flowId = normalizeAiMarketplacePublishString(payload?.flow_id);
    if (!flowId || !aiMarketplacePublishOutcomeWaits.has(flowId)) {
      return;
    }
    settleAiMarketplacePublishOutcomeWait(flowId, {
      ok: payload?.ok === true,
      message: normalizeAiMarketplacePublishString(payload?.message) || null,
    });
  });
}

window.electronAPI?.onNativeInputReopenRequested?.((payload = {}) => {
  const flowId = normalizeAiMarketplacePublishString(payload?.flow_id);
  if (
    payload?.kind !== "marketplace_publish" ||
    !flowId ||
    !aiMarketplacePublishBatch.items.has(flowId)
  ) {
    return;
  }
  showAiMarketplacePublishModal();
  // The main process flipped the requested flow visible; sync its batch
  // siblings in one call so the pill drains for the whole batch.
  const siblings = [...aiMarketplacePublishBatch.items.keys()].filter(
    (id) => id !== flowId,
  );
  if (siblings.length) {
    void window.electronAPI
      ?.setNativeInputPresentation?.({
        kind: "marketplace_publish",
        flow_ids: siblings,
        presentation: "visible",
      })
      ?.catch?.(() => {});
  }
});

window.electronAPI?.onNativeInputTerminal?.((payload = {}) => {
  const flowId = normalizeAiMarketplacePublishString(payload?.flow_id);
  if (payload?.kind !== "marketplace_publish" || !flowId) {
    return;
  }
  const item = aiMarketplacePublishBatch.items.get(flowId);
  if (!item) {
    return;
  }
  // Queue-owned items ignore terminal events: our own "published"/
  // "publish_failed" completions echo back as terminals, and evicting the
  // row would yank its ✓/✕ chip mid-display. A flow whose budget expired
  // mid-queue still executes (the user approved it); main's in_progress
  // guard simply drops the late completion.
  if (item.status) {
    return;
  }
  // A single flow terminated main-side (deny timeout / proxy abandonment):
  // evict just that item; the rest of the batch stays up for the user.
  aiMarketplacePublishBatch.items.delete(flowId);
  if (typeof item.resolve === "function") {
    item.resolve({
      success: false,
      status: normalizeAiMarketplacePublishString(payload?.status) || "completed",
      flow_id: flowId,
    });
  }
  if (!aiMarketplacePublishBatch.items.size) {
    closeAiMarketplacePublishChrome();
    return;
  }
  if (aiMarketplacePublishBatch.presentation === "visible") {
    renderAiMarketplacePublishModal();
  }
});
