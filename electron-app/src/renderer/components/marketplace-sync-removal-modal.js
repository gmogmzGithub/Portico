// Destructive-sync consent modal.
// Chat UI layer. A marketplace sync found installed skills that no longer
// exist upstream AND are referenced by agents: the sync hard-fails until the
// user decides. This modal shows every pending removal with the agents that
// use it (a table per skill), and offers exactly two exits:
//   Stop sync        → nothing changes; the next sync asks again (by design).
//   Proceed          → editable agents get the reference removed; read-only
//                      installed agents are NEVER written — they keep the
//                      reference and receive a local SKILLS_NOT_FOUND flag
//                      (their owner republishes the fix). Non-seeded skills
//                      are then removed from this computer; OOTB-seeded
//                      skills (seeded:true rows) are unlink-only — they stay
//                      installed (the bundle re-adds absent seeds, so
//                      removal can't stick) until an app update resolves
//                      them.
// No relink suggestions, deliberately: guessing which new skill replaces a
// vanished one is the caller's (human's) judgment, not the client's.
//
// Promise contract: window.runMarketplaceSyncRemovalModal(groups) resolves
// {action:"proceed"} or {action:"cancel"}. `groups` is
// [{marketplaceId, marketplaceName, pendingRemovals:[{skillId, pluginName,
//   label, seeded?, agents:[{id, name, readOnly}]}]}].
// One modal instance at a time; a second call while open resolves "cancel"
// immediately (the callers serialize syncs, so this is a programming-error
// guard, not a real path).

(function marketplaceSyncRemovalModalModule() {
  const MODAL_ID = "marketplace-sync-removal-modal";

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function skillLabel(removal) {
    if (removal.label) return removal.label;
    const compose = window.SkillCardRenderer?.composeSkillPluginLabel;
    if (typeof compose === "function") {
      return compose(removal.skillId, removal.pluginName);
    }
    return removal.pluginName
      ? `${removal.pluginName} → ${removal.skillId}`
      : removal.skillId;
  }

  function agentRowHtml(agent) {
    const access = agent.readOnly
      ? '<span class="sync-removal-access sync-removal-access-readonly">Read-only (installed)</span>'
      : '<span class="sync-removal-access">Editable</span>';
    const outcome = agent.readOnly
      ? '<span class="sync-removal-outcome-flagged">⚠ Keeps the reference — flagged; the agent\'s owner must republish</span>'
      : '<span>Skill unlinked from this agent</span>';
    return `
      <tr>
        <td class="sync-removal-agent-name">${escapeHtml(agent.name || agent.id)}</td>
        <td>${access}</td>
        <td>${outcome}</td>
      </tr>`;
  }

  function skillSectionHtml(removal) {
    const agents = Array.isArray(removal.agents) ? removal.agents : [];
    const seededNote = removal.seeded
      ? '<div class="sync-removal-skill-note">Bundled with the app — the skill stays installed; only the agent links are removed. An app update resolves the skill itself.</div>'
      : "";
    return `
      <div class="sync-removal-skill">
        <div class="sync-removal-skill-title">${escapeHtml(skillLabel(removal))}</div>
        ${seededNote}
        <table class="sync-removal-agents-table">
          <thead>
            <tr><th>Agent using this skill</th><th>Access</th><th>What happens</th></tr>
          </thead>
          <tbody>${agents.map(agentRowHtml).join("")}</tbody>
        </table>
      </div>`;
  }

  function groupSectionHtml(group) {
    const removals = Array.isArray(group.pendingRemovals) ? group.pendingRemovals : [];
    return `
      <div class="sync-removal-marketplace" data-marketplace-id="${escapeHtml(group.marketplaceId)}">
        <div class="sync-removal-marketplace-name">${escapeHtml(group.marketplaceName || group.marketplaceId)}</div>
        ${removals.map(skillSectionHtml).join("")}
      </div>`;
  }

  function buildModalHtml(groups, totalSkills) {
    const plural = totalSkills !== 1;
    const seededCount = groups.reduce(
      (count, group) =>
        count + group.pendingRemovals.filter((removal) => removal.seeded === true).length,
      0,
    );
    const removableCount = totalSkills - seededCount;
    // The intro and the button must never promise a removal that seeded rows
    // won't get (they stay installed; only their agent links are removed).
    const outcomeSentence =
      removableCount === 0
        ? `Completing the sync unlinks ${plural ? "them" : "it"} from the agents shown below — the skill${plural ? "s stay" : " stays"} installed until an app update resolves ${plural ? "them" : "it"}.`
        : seededCount === 0
          ? `Completing the sync removes ${plural ? "these skills" : "this skill"} and detaches ${plural ? "them" : "it"} as shown below.`
          : `Completing the sync detaches ${plural ? "them" : "it"} as shown below, removes ${removableCount} skill${removableCount === 1 ? "" : "s"}, and keeps ${seededCount} bundled skill${seededCount === 1 ? "" : "s"} installed until an app update resolves ${seededCount === 1 ? "it" : "them"}.`;
    const proceedLabel =
      removableCount === 0
        ? "Unlink from agents"
        : `Unlink &amp; remove ${removableCount} skill${removableCount === 1 ? "" : "s"}`;
    return `
      <div class="modal-content sync-removal-modal-content">
        <button class="confirmation-modal-close" data-sync-removal-close title="Close">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
        <div class="remove-marketplace-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
            <line x1="12" y1="9" x2="12" y2="13"></line>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
          </svg>
        </div>
        <h2 class="remove-marketplace-title">Skills no longer published</h2>
        <p class="remove-marketplace-message">
          ${totalSkills === 1 ? "An installed skill" : `${totalSkills} installed skills`} no longer exist${plural ? "" : "s"} in ${plural ? "their" : "its"} marketplace, and agents on this computer still use ${plural ? "them" : "it"}.
          ${outcomeSentence}
        </p>
        <div class="sync-removal-body">
          ${groups.map(groupSectionHtml).join("")}
        </div>
        <p class="sync-removal-footnote">Stop the sync if you want to sort this out first — it will ask again next time.</p>
        <div class="remove-marketplace-buttons">
          <button class="btn btn-secondary" data-sync-removal-stop>Stop sync</button>
          <button class="btn btn-danger" data-sync-removal-proceed>${proceedLabel}</button>
        </div>
      </div>`;
  }

  function runMarketplaceSyncRemovalModal(groups) {
    const safeGroups = (Array.isArray(groups) ? groups : []).filter(
      (group) => group && Array.isArray(group.pendingRemovals) && group.pendingRemovals.length,
    );
    const totalSkills = safeGroups.reduce(
      (count, group) => count + group.pendingRemovals.length,
      0,
    );
    if (!totalSkills) {
      return Promise.resolve({ action: "cancel" });
    }
    if (document.getElementById(MODAL_ID)) {
      return Promise.resolve({ action: "cancel" });
    }

    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "modal-overlay visible";
      overlay.id = MODAL_ID;
      overlay.innerHTML = buildModalHtml(safeGroups, totalSkills);
      document.body.appendChild(overlay);

      const settle = (action) => {
        overlay.remove();
        document.removeEventListener("keydown", onKeydown, true);
        resolve({ action });
      };
      const onKeydown = (event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          settle("cancel");
        }
      };
      document.addEventListener("keydown", onKeydown, true);

      overlay.addEventListener("click", (event) => {
        const target = event.target;
        if (target === overlay) {
          settle("cancel");
          return;
        }
        if (target.closest?.("[data-sync-removal-close]") || target.closest?.("[data-sync-removal-stop]")) {
          settle("cancel");
          return;
        }
        if (target.closest?.("[data-sync-removal-proceed]")) {
          settle("proceed");
        }
      });
    });
  }

  window.runMarketplaceSyncRemovalModal = runMarketplaceSyncRemovalModal;
  window.MarketplaceSyncRemovalModalHooks = { buildModalHtml };
})();
