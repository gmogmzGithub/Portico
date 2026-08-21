// Shared, presentation-only Agent Skill card renderer.
//
// Produces the EXACT control-plane skill-card shell (.mcp-server-card.skill-card
// with the same badge rows) so the AI Marketplace publish modal can show the
// real card in BOTH windows. agent-skills.js delegates its card body here (and
// layers the interactive dropdown menu on top), so the two cannot drift.
// This file must stay dependency-free: the conversation window loads it without
// agent-skills.js.
(function () {
  "use strict";

  function escapeSkillCardHtml(text) {
    return String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeSkillCardAttribute(text) {
    return escapeSkillCardHtml(text);
  }

  function sanitizeSkillCardImageUrl(rawUrl) {
    const value = String(rawUrl ?? "").trim();
    if (!value) return null;
    if (/^data:image\//i.test(value)) return value;
    try {
      const parsed = new URL(value);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed.toString();
      }
    } catch (_error) {
      return null;
    }
    return null;
  }

  function applySkillCardAcronyms(displayName) {
    // Lockstep with skill-frontmatter.js applySkillDisplayAcronyms and rust
    // skills_catalog.rs format_skill_display_name.
    return String(displayName || "").replace(
      /\b(Lm|Mcp|Api|Url|Ui|Ai|Id|Gtm|Qa|Icp)\b/g,
      (match) => match.toUpperCase(),
    );
  }

  // String-level formatter for callers that only have an id or raw label —
  // the ONE derivation every skill-name surface funnels through, so a slug
  // never renders three different ways across modals.
  function formatSkillDisplayName(raw) {
    return skillCardDisplayName({ name: raw });
  }

  function skillCardDisplayName(skill) {
    const raw = String(skill?.display_name || skill?.name || "").trim();
    if (!raw) return "";
    const formatted = raw
      .replace(/[-_/]+/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
      .join(" ");
    return applySkillCardAcronyms(formatted);
  }

  // Plugin slugs read through the same skill formatter ("a11y" → "A11y",
  // "knowledge-work-plugins" → "Knowledge Work Plugins") so plugin and skill
  // names never diverge in casing rules.
  function formatPluginLabel(plugin) {
    return formatSkillDisplayName(plugin);
  }

  // The one plugin-provenance chip. Every surface that shows "this skill came
  // from a plugin" as a badge renders through this, so the class, tooltip and
  // escaping stay in one place.
  function skillCardPluginBadgeHtml(pluginName) {
    const pluginLabel = pluginName ? formatPluginLabel(pluginName) : "";
    if (!pluginLabel) return "";
    return `<span class="mcp-card-badge badge-plugin" title="${escapeSkillCardAttribute(
      `From plugin ${pluginLabel}`,
    )}">${escapeSkillCardHtml(pluginLabel)}</span>`;
  }

  // "Plugin → Skill" composition for name surfaces (tables, tooltips,
  // pickers, modal rows). Cards use a badge instead — this is for text.
  function composeSkillPluginLabel(label, plugin) {
    const base = String(label || "").trim();
    const pluginLabel = formatPluginLabel(plugin);
    return pluginLabel && base ? `${pluginLabel} → ${base}` : base || pluginLabel;
  }

  function truncateSkillCardDescription(desc, maxLength = 120) {
    if (!desc) return "No description available";
    if (desc.length <= maxLength) return desc;
    return desc.substring(0, maxLength).trim() + "...";
  }

  function skillCardSourceBadgeClass(source) {
    switch (source) {
      case "system":
        return "badge-core";
      case "user":
        return "badge-user";
      case "marketplace":
        return "badge-installed";
      default:
        return "badge-core";
    }
  }

  function skillCardSourceBadgeLabel(source) {
    switch (source) {
      case "system":
        return "Core";
      case "user":
        return "User";
      case "marketplace":
        return "Installed";
      default: {
        const raw = String(source || "Core");
        return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
      }
    }
  }

  function normalizeSkillCardLdap(value) {
    const normalized = String(value || "").trim();
    if (!normalized) return "";
    const at = normalized.indexOf("@");
    return at === -1 ? normalized : normalized.slice(0, at).trim();
  }

  // Every skill without an explicit logo gets the layers glyph — one icon
  // language for skills everywhere (no per-provenance globes or app logos).
  function skillCardLogoHtml(skill, { defaultLogo = "" } = {}) {
    void defaultLogo;
    const logoSrc = sanitizeSkillCardImageUrl(skill?.logo);
    if (logoSrc) {
      return `<img src="${escapeSkillCardAttribute(logoSrc)}" alt="${escapeSkillCardAttribute(
        skillCardDisplayName(skill),
      )}" class="mcp-card-icon-img" />`;
    }
    return `<div class="mcp-card-icon-placeholder">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
        <path d="M2 17l10 5 10-5"></path>
        <path d="M2 12l10 5 10-5"></path>
      </svg>
    </div>`;
  }

  // skill: { name, display_name?, description, source, version, author,
  //          created_by_email?, logo?, marketplace_name? }
  // options: {
  //   interactive: layers a caller-supplied dropdown menu (menuHtml) into the
  //     header — the modal path uses interactive: false;
  //   link: { solutionId, hasLocalChanges } | null — published-state chips;
  //   published: boolean — simplified alternative to `link` for callers
  //     without registry state (the chat publish modal);
  //   updateAvailable / conflict: installed-copy freshness state (git version
  //     compare or solutions listing updated_at) — chip + card tint;
  //   defaultLogo: data/https URL used when the skill has no logo;
  //   hideSourceBadge: suppress the Core/User/Installed source chip — for
  //     remote marketplace LISTINGS that have no local copy (the fallback
  //     source label would misdescribe them);
  //   footerHtml: optional caller-built action row (e.g. the Discover tab's
  //     Install button) rendered in a .mcp-card-footer.skill-card-actions
  //     strip — local skill cards never pass this and stay footer-free;
  //   usedByAgents: [{ id, name }] — locally installed agents referencing
  //     this skill (leaf-name matched by the caller). Non-empty renders the
  //     "N AGENT(S)" badge row with a names tooltip; omitted/empty renders
  //     nothing, so callers without usage data (the publish modal) opt out
  //     by default.
  // }
  function buildSkillCardHtml(skill, options = {}) {
    const {
      interactive = true,
      menuHtml = "",
      link = null,
      published = false,
      updateAvailable = false,
      conflict = false,
      defaultLogo = "",
      hideSourceBadge = false,
      footerHtml = "",
      usedByAgents = [],
    } = options || {};

    const source = skill?.source || "user";
    const safeSkillNameAttr = escapeSkillCardAttribute(skill?.name || "");
    const safeDescription = escapeSkillCardHtml(
      truncateSkillCardDescription(skill?.description),
    );
    const marketplaceName =
      source === "marketplace"
        ? skill?.marketplace_name || skill?.marketplace_id || null
        : null;
    const marketplaceBadge = marketplaceName
      ? `<span class="mcp-card-badge badge-marketplace-name" title="${escapeSkillCardAttribute(
          marketplaceName,
        )}">${escapeSkillCardHtml(marketplaceName)}</span>`
      : "";
    // Plugin provenance as a quiet chip — cards stay uncrowded while the
    // plugin is still evident (name surfaces use the "Plugin → Skill" form).
    const pluginBadge = skillCardPluginBadgeHtml(skill?.plugin_name);
    const publishedLink = link || (published ? { solutionId: "" } : null);
    const publishedBadge = publishedLink
      ? `<span class="mcp-card-badge badge-published" title="${
          publishedLink.solutionId
            ? `Linked to AI Marketplace solution ${escapeSkillCardAttribute(publishedLink.solutionId)}`
            : "Published to the AI Marketplace"
        }">Published</span>`
      : "";
    const unpublishedBadge = publishedLink?.hasLocalChanges
      ? `<span class="mcp-card-badge badge-unpublished" title="Local edits not yet published to the marketplace">Unpublished changes</span>`
      : "";
    const conflictBadge = conflict
      ? `<span class="mcp-card-badge badge-conflict" title="The marketplace copy changed AND this copy has local edits">Conflict</span>`
      : "";
    const updateBadge =
      updateAvailable && !conflict
        ? `<span class="mcp-card-badge badge-has-updates" title="The marketplace copy changed since this skill was installed">Update available</span>`
        : "";

    // User badges represent ownership and come EXCLUSIVELY from the durable
    // authenticated creator email — never the caller/frontmatter `author`,
    // which is spoofable. Core/marketplace cards keep descriptive authors.
    const cardAuthor =
      source === "user"
        ? normalizeSkillCardLdap(skill?.created_by_email) || "Unknown"
        : skill?.author || "Unknown";
    const authorBadges = String(cardAuthor)
      .split(",")
      .map((author) => author.trim())
      .filter(Boolean)
      .map(
        (author) => `<span class="mcp-card-badge badge-author">${escapeSkillCardHtml(author)}</span>`,
      )
      .join("");

    const menuWrapper =
      interactive && menuHtml
        ? `<div class="mcp-card-menu-wrapper">${menuHtml}</div>`
        : "";

    // "Used by N agents" row — its own line under the other badges. Badge
    // chip + info icon travel INSIDE one tooltip trigger, so hovering either
    // (or the space between) shows the rich agents panel without flicker
    // (the shared floating tooltip is delegated document-wide by agents.js;
    // absent helper = badge only, never broken markup). Older hosts without
    // the list variant fall back to badge + plain sentence icon.
    const agentNames = (Array.isArray(usedByAgents) ? usedByAgents : [])
      .map((agent) => String(agent?.name || "").trim())
      .filter(Boolean);
    const agentsBadgeChip = `<span class="mcp-card-badge badge-agents">${agentNames.length} AGENT${agentNames.length === 1 ? "" : "S"}</span>`;
    const agentsHoverUnit =
      typeof window.InfoTooltips?.listTriggerHtml === "function"
        ? window.InfoTooltips.listTriggerHtml(
            {
              title: `Used by ${agentNames.length} agent${agentNames.length === 1 ? "" : "s"}`,
              items: agentNames,
              icon: "agent",
            },
            agentsBadgeChip,
          )
        : agentsBadgeChip +
          (typeof window.InfoTooltips?.triggerHtml === "function"
            ? window.InfoTooltips.triggerHtml(`Used by: ${agentNames.join(", ")}`)
            : "");
    const agentsBadgeRow = agentNames.length
      ? `<div class="mcp-card-badges skill-agents-badges">${agentsHoverUnit}</div>`
      : "";

    // The amber card tint marks a published skill whose local copy has
    // diverged; the blue tint marks an installed copy whose marketplace
    // source moved ahead (same states the chips announce).
    const cardStateClass = `${
      publishedLink?.hasLocalChanges ? " has-unpublished-changes" : ""
    }${updateAvailable || conflict ? " update-available" : ""}`;

    return `
    <div class="mcp-server-card skill-card${cardStateClass}" data-skill-name="${safeSkillNameAttr}">
      <div class="mcp-card-header">
        <div class="mcp-card-icon-wrapper">
          ${skillCardLogoHtml(skill, { defaultLogo })}
        </div>
        <div class="mcp-card-title-info">
          <h3 class="mcp-card-name">${escapeSkillCardHtml(skillCardDisplayName(skill))}</h3>
        </div>
        ${menuWrapper}
      </div>
      <div class="mcp-card-body">
        <div class="mcp-card-badges">
          ${
            // Same ordering as the facet filters: User, Published, Installed.
            // Core/User source chips lead (they say what the copy IS), the
            // Published state follows, and the Installed source chip + its
            // marketplace name come after Published. Remote listings hide the
            // source chip entirely (they have no local copy to describe).
            source === "marketplace"
              ? `${publishedBadge}${hideSourceBadge ? "" : `<span class="mcp-card-badge ${skillCardSourceBadgeClass(source)}">${skillCardSourceBadgeLabel(source)}</span>`}${marketplaceBadge}${pluginBadge}`
              : `${hideSourceBadge ? "" : `<span class="mcp-card-badge ${skillCardSourceBadgeClass(source)}">${skillCardSourceBadgeLabel(source)}</span>`}${publishedBadge}${pluginBadge}`
          }
          ${unpublishedBadge}
          ${conflictBadge}
          ${updateBadge}
          ${authorBadges}
        </div>
        ${agentsBadgeRow}
        <p class="skill-card-description">${safeDescription}</p>
      </div>
      ${footerHtml ? `<div class="mcp-card-footer skill-card-actions">${footerHtml}</div>` : ""}
    </div>
  `;
  }

  // ---------------------------------------------------------------------
  // Shared kebab-menu behavior for card surfaces without their own wiring
  // (the Discover tab + git-marketplace grids). Deliberately the same class
  // names and _originalParent reparenting protocol as agent-skills' local-
  // card menus, so the two document-level outside-click closers are
  // idempotent on each other's dropdowns.
  // ---------------------------------------------------------------------

  function closeAllCardMenus() {
    document
      .querySelectorAll(".mcp-card-dropdown.visible")
      .forEach((dropdown) => {
        dropdown.classList.remove("visible");
        if (
          dropdown._originalParent &&
          dropdown.parentElement === document.body
        ) {
          dropdown._originalParent.appendChild(dropdown);
        }
        // Stale fixed coords on the hidden box get re-based into the card by
        // hover transforms and widen the scroll host.
        dropdown.style.top = "";
        dropdown.style.left = "";
      });
  }

  function handleCardMenuOutsideClick(event) {
    if (
      !event.target.closest(".mcp-card-menu-wrapper") &&
      !event.target.closest(".mcp-card-dropdown")
    ) {
      closeAllCardMenus();
    }
  }
  let outsideCloserAttached = false;

  // Wire every .mcp-card-menu-trigger under rootEl: toggle its sibling
  // dropdown, body-reparented and fixed-positioned with viewport clamps
  // (open-upward fallback) — a faithful port of the local-card behavior.
  function attachCardMenus(rootEl) {
    if (!rootEl) return;
    rootEl.querySelectorAll(".mcp-card-menu-trigger").forEach((trigger) => {
      trigger.addEventListener("click", (event) => {
        event.stopPropagation();
        const dropdown =
          trigger.parentElement?.querySelector?.(".mcp-card-dropdown");
        const wasOpen = dropdown?.classList.contains("visible");
        closeAllCardMenus();
        if (wasOpen || !dropdown) return;
        // Move to body to escape overflow clipping; remember the way home.
        dropdown._originalParent = dropdown.parentElement;
        document.body.appendChild(dropdown);
        const btnRect = trigger.getBoundingClientRect();
        // Temporarily show to measure the real size.
        dropdown.style.visibility = "hidden";
        dropdown.style.display = "block";
        const dropdownWidth = dropdown.offsetWidth;
        const dropdownHeight = dropdown.offsetHeight;
        dropdown.style.visibility = "";
        dropdown.style.display = "";
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
    // One stable document-level closer for every attachCardMenus surface
    // (re-registration is deduped by the flag; the real DOM also dedupes
    // identical listener references).
    if (!outsideCloserAttached) {
      document.addEventListener("click", handleCardMenuOutsideClick);
      outsideCloserAttached = true;
    }
  }

  // Decoration for a Delete/Uninstall control blocked by local agent
  // references. agents: [{ id, name }] from the already-loaded usage maps.
  // Empty/absent agents -> not blocked (fail-open: the main-process
  // referential-integrity guard remains the backstop). Callers merge
  // triggerClass into the class attribute and append attrs AFTER their data
  // attributes so unblocked markup stays byte-identical.
  // aria-disabled, NEVER [disabled]: Chromium suppresses mouse events on
  // disabled buttons and the explanation tooltip rides on hover.
  function agentsBlockedDecoration(
    agents,
    { note = "Remove it from these agents first." } = {},
  ) {
    const names = (Array.isArray(agents) ? agents : [])
      .map((agent) => String(agent?.name || "").trim())
      .filter(Boolean);
    if (!names.length) return { blocked: false, attrs: "", triggerClass: "" };
    const spec = {
      title: `Used by ${names.length} agent${names.length === 1 ? "" : "s"}`,
      items: names,
      icon: "agent",
      note,
    };
    return {
      blocked: true,
      triggerClass: " info-tooltip-trigger",
      attrs: ` aria-disabled="true" data-info-tooltip-list="${escapeSkillCardAttribute(
        JSON.stringify(spec),
      )}" data-info-tooltip-placement="right"`,
    };
  }

  window.SkillCardRenderer = {
    buildSkillCardHtml,
    formatSkillDisplayName,
    formatPluginLabel,
    skillCardPluginBadgeHtml,
    composeSkillPluginLabel,
    skillCardSourceBadgeClass,
    skillCardSourceBadgeLabel,
    attachCardMenus,
    closeAllCardMenus,
    agentsBlockedDecoration,
  };
})();
