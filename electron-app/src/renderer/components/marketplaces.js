// Marketplaces component - Control Plane
// UI for managing skill marketplaces, browsing skills, and installing/updating

const marketplaceSourceUrlApi =
  globalThis.marketplaceSourceUrl ||
  (typeof require === "function"
    ? require("./marketplace-source-url")
    : null) ||
  {};
const deriveCanonicalMarketplaceUrl =
  marketplaceSourceUrlApi.deriveCanonicalMarketplaceUrl ||
  function fallbackDeriveCanonicalMarketplaceUrl() {
    return null;
  };

// =============================================================================
// STATE
// =============================================================================

// Source id stamped on AI Marketplace (Solutions) skill installs. Their
// browse/install UX lives on the Agent Skills tab's inline Discover mode;
// this module only refreshes their provenance via Sync All.
const SOLUTIONS_MARKETPLACE_SKILL_SOURCE_ID = "ai-marketplace";

let marketplacesSearchQuery = "";
let marketplacesActiveFilter = "all";
let marketplacesData = [];
let installedSkillsMap = new Map(); // marketplaceId:skillId -> install info
let marketplacesLoadPromise = null;
let marketplacesSearchFilterInitialized = false;

// Marketplace details page state
let currentMarketplaceForDetails = null;
let marketplaceSkillsCache = new Map(); // marketplaceId -> skills array
let marketplaceSkillsSearchQuery = "";
let marketplaceSkillsFilter = "all";
let marketplaceCopyUrlResetTimer = null;
// Bumped on every page open/close so an in-flight skills load resolving
// after the view changed can tell it is stale and must not paint.
let marketplacePageGeneration = 0;
// Plugin drill-in state: "all" renders plugin folders + root skills; "plugin"
// renders one plugin's skills behind a back row. Search or a non-"all"
// filter always falls back to the flat list.
let marketplaceDetailsView = { mode: "all", pluginName: null };
// leaf skill id -> [{ id, name }] of locally installed agents referencing it
// (the "used by N agents" badges). Refreshed once per page open and per
// action refresh; empty on any failure (badges are fail-open decoration).
let marketplaceAgentUsage = new Map();
// Sort rules apply only when a view is (re)entered — page open, drill-in or
// back, a new search query — never on action-driven refreshes
// (install/uninstall/update), which would teleport the card just acted on.
// Holds the order captured at the current view's first paint.
let marketplaceOrderFreeze = null;

// Update check state
let hasAvailableUpdates = false;

const MARKETPLACE_COPY_URL_DEFAULT_HTML = `
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
  </svg>
  Copy URL
`;

const MARKETPLACE_COPY_URL_COPIED_HTML = `
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <polyline points="20 6 9 17 4 12"></polyline>
  </svg>
  Copied!
`;

// =============================================================================
// UTILITIES
// =============================================================================

function encodeSkillSource(skillSource) {
  if (!skillSource) return "";
  try {
    return encodeURIComponent(JSON.stringify(skillSource));
  } catch (e) {
    return "";
  }
}

function decodeSkillSource(encoded) {
  if (!encoded) return null;
  try {
    return JSON.parse(decodeURIComponent(encoded));
  } catch (e) {
    return null;
  }
}

// Info-tooltip trigger for a NAME LIST (rich titled rows when the shared
// helper supports it, plain sentence fallback for older hosts). innerHtml
// (e.g. a badge chip) rides INSIDE the trigger so badge + icon are one
// hover surface; with no helper at all, the inner markup still renders —
// never broken markup.
function infoListTriggerHtml(spec, fallbackText, innerHtml = "") {
  if (typeof window.InfoTooltips?.listTriggerHtml === "function") {
    return window.InfoTooltips.listTriggerHtml(spec, innerHtml);
  }
  if (typeof window.InfoTooltips?.triggerHtml === "function") {
    return innerHtml + window.InfoTooltips.triggerHtml(fallbackText);
  }
  return innerHtml;
}

function getMarketplaceCopyUrlButton() {
  return document.getElementById("marketplace-details-copy-url-btn");
}

function getMarketplaceViewRepoButton() {
  return document.getElementById("marketplace-details-view-repo-btn");
}

function isPorticoAiMarketplace(marketplace) {
  const source = marketplace?.source || {};
  const candidates = [
    marketplace?.id,
    marketplace?.name,
    source.projectPath,
    source.repoUrl,
  ]
    .filter(Boolean)
    .map((value) => String(value).trim().toLowerCase());

  return candidates.some(
    (value) =>
      value === "portico-ai-marketplace" ||
      value === "community/portico-ai-marketplace" ||
      value.includes("/community/portico-ai-marketplace") ||
      value.includes("/portico-ai-marketplace"),
  );
}

function updateMarketplaceCopyUrlButton(marketplace = currentMarketplaceForDetails) {
  const copyBtn = getMarketplaceCopyUrlButton();
  const viewRepoBtn = getMarketplaceViewRepoButton();
  if (!copyBtn && !viewRepoBtn) return;

  if (marketplaceCopyUrlResetTimer) {
    clearTimeout(marketplaceCopyUrlResetTimer);
    marketplaceCopyUrlResetTimer = null;
  }

  const copyUrl = deriveCanonicalMarketplaceUrl(marketplace?.source);
  if (copyBtn) {
    copyBtn.classList.remove("copied");
    copyBtn.innerHTML = MARKETPLACE_COPY_URL_DEFAULT_HTML;
    copyBtn.dataset.copyUrl = copyUrl || "";
    copyBtn.disabled = !copyUrl;
    copyBtn.style.display = copyUrl ? "" : "none";
    copyBtn.title = copyUrl
      ? "Copy the configured marketplace URL"
      : "Marketplace URL unavailable";
  }

  if (viewRepoBtn) {
    viewRepoBtn.dataset.repoUrl = copyUrl || "";
    viewRepoBtn.disabled = !copyUrl;
    viewRepoBtn.style.display = copyUrl ? "" : "none";
    viewRepoBtn.title = copyUrl
      ? "Open the configured marketplace repository"
      : "Marketplace URL unavailable";
  }
}

async function copyMarketplaceUrlToClipboard() {
  const copyBtn = getMarketplaceCopyUrlButton();
  if (!copyBtn) return;

  const copyUrl =
    copyBtn.dataset.copyUrl ||
    deriveCanonicalMarketplaceUrl(currentMarketplaceForDetails?.source);
  if (!copyUrl) {
    updateMarketplaceCopyUrlButton(currentMarketplaceForDetails);
    showMarketplacesNotification("Marketplace URL unavailable", "warning");
    return;
  }

  try {
    if (!window.electronAPI?.copyToClipboard) {
      throw new Error("Clipboard unavailable");
    }

    await window.electronAPI.copyToClipboard(copyUrl);
    copyBtn.classList.add("copied");
    copyBtn.innerHTML = MARKETPLACE_COPY_URL_COPIED_HTML;
    showMarketplacesNotification("Marketplace URL copied to clipboard", "success");

    marketplaceCopyUrlResetTimer = setTimeout(() => {
      updateMarketplaceCopyUrlButton(currentMarketplaceForDetails);
    }, 2000);
  } catch (error) {
    console.error("[Marketplaces] Failed to copy marketplace URL:", error);
    updateMarketplaceCopyUrlButton(currentMarketplaceForDetails);
    showMarketplacesNotification(
      `Failed to copy marketplace URL: ${error.message}`,
      "error",
    );
  }
}

async function openMarketplaceRepository() {
  const viewRepoBtn = getMarketplaceViewRepoButton();
  if (!viewRepoBtn) return;

  const repoUrl =
    viewRepoBtn.dataset.repoUrl ||
    deriveCanonicalMarketplaceUrl(currentMarketplaceForDetails?.source);
  if (!repoUrl) {
    updateMarketplaceCopyUrlButton(currentMarketplaceForDetails);
    showMarketplacesNotification("Marketplace URL unavailable", "warning");
    return;
  }

  try {
    if (!window.electronAPI?.openExternal) {
      throw new Error("Browser unavailable");
    }

    const result = await window.electronAPI.openExternal(repoUrl);
    if (result?.success === false) {
      throw new Error(result.error || "Failed to open repository");
    }
  } catch (error) {
    console.error("[Marketplaces] Failed to open marketplace repository:", error);
    updateMarketplaceCopyUrlButton(currentMarketplaceForDetails);
    showMarketplacesNotification(
      `Failed to open marketplace repository: ${error.message}`,
      "error",
    );
  }
}

// =============================================================================
// VIEW TOGGLE
// =============================================================================

/**
 * Wire marketplace header actions (Add Marketplace, Sync All).
 * View switching lives under Agent Skills; marketplaces browse is a sub-tab there.
 */
function initMarketplacesHeaderActions() {
  const addMarketplaceBtn = document.getElementById("add-marketplace-btn");
  const checkUpdatesBtn = document.getElementById("check-updates-btn");

  if (addMarketplaceBtn) {
    addMarketplaceBtn.addEventListener("click", openAddMarketplaceModal);
  }

  if (checkUpdatesBtn) {
    checkUpdatesBtn.addEventListener("click", checkForMarketplaceUpdates);
  }

  console.log("[Marketplaces] Header actions initialized");
}

// =============================================================================
// SEARCH AND FILTER
// =============================================================================

/**
 * Initialize search and filter for marketplaces
 */
function initMarketplacesSearchFilter() {
  if (marketplacesSearchFilterInitialized) return;

  const searchInput = document.getElementById("marketplaces-search-input");
  const filterTabs = document.querySelectorAll(
    "#marketplaces-filter-tabs .mcp-filter-tab",
  );

  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      marketplacesSearchQuery = e.target.value.toLowerCase();
      renderMarketplacesList();
    });
  }

  filterTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      filterTabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      marketplacesActiveFilter = tab.dataset.filter;
      renderMarketplacesList();
    });
  });

  marketplacesSearchFilterInitialized = true;
  console.log("[Marketplaces] Search and filter initialized");
}

/**
 * Get filtered marketplaces based on search and filter
 */
function getFilteredMarketplaces() {
  let filtered = [...marketplacesData];

  // Apply search filter
  if (marketplacesSearchQuery) {
    filtered = filtered.filter(
      (m) =>
        m.name.toLowerCase().includes(marketplacesSearchQuery) ||
        m.description?.toLowerCase().includes(marketplacesSearchQuery) ||
        m.owner?.name?.toLowerCase().includes(marketplacesSearchQuery),
    );
  }

  // Apply category filter
  switch (marketplacesActiveFilter) {
    case "with-installed":
      filtered = filtered.filter((m) => m.installedCount > 0);
      break;
    case "has-updates":
      filtered = filtered.filter((m) => m.hasUpdates);
      break;
    // 'all' - no additional filtering
  }

  return filtered;
}

// =============================================================================
// DATA LOADING
// =============================================================================

/**
 * Load marketplaces from the backend
 */
async function loadMarketplaces() {
  if (marketplacesLoadPromise) {
    return marketplacesLoadPromise;
  }

  const marketplacesList = document.getElementById("marketplaces-list");
  if (!marketplacesList) return;

  marketplacesLoadPromise = (async () => {
    // Show loading state
    marketplacesList.innerHTML = `
      <div class="mcp-loading">
        <div class="mcp-loading-spinner"></div>
        <p>Loading marketplaces...</p>
      </div>
    `;

    try {
      const result = await window.electronAPI.getMarketplaces();

      if (!result.success) {
        throw new Error(result.error || "Failed to load marketplaces");
      }

      const config = result.data;

      // Build installed skills map
      installedSkillsMap.clear();
      for (const skill of config.installedSkills || []) {
        const key = `${skill.marketplaceId}:${skill.skillId}`;
        installedSkillsMap.set(key, skill);
      }

      // Process marketplaces with additional info
      marketplacesData = (config.marketplaces || []).map((m) => {
        const installedSkills = (config.installedSkills || []).filter(
          (s) => s.marketplaceId === m.id,
        );
        // ONE counting rule everywhere (2026-08-14: the list card said 5
        // INSTALLED, the drilldown 4, the Installed filter 1): INSTALLED
        // counts only records whose upstream source still exists; records
        // parked on a vanished source ("waiting for an app update") get
        // their own explicit chip instead of silently inflating INSTALLED.
        const liveInstalled = installedSkills.filter(
          (s) => s.sourceMissing !== true,
        );
        const hasUpdates = liveInstalled.some((s) => s.hasUpdate);
        const dirtyCount = liveInstalled.filter((s) => s.isDirty).length;
        const conflictCount = liveInstalled.filter((s) => s.hasConflict).length;

        return {
          ...m,
          installedCount: liveInstalled.length,
          parkedCount: installedSkills.length - liveInstalled.length,
          totalSkills: countTotalSkills(m.cachedManifest),
          hasUpdates: hasUpdates,
          dirtyCount,
          conflictCount,
        };
      });

      initMarketplacesSearchFilter();
      renderMarketplacesList();
      updateUpdateIndicator();

      console.log(
        `[Marketplaces] Loaded ${marketplacesData.length} marketplaces`,
      );
    } catch (error) {
      console.error("[Marketplaces] Failed to load marketplaces:", error);
      marketplacesList.innerHTML = `
        <div class="mcp-no-results">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="15" y1="9" x2="9" y2="15"></line>
            <line x1="9" y1="9" x2="15" y2="15"></line>
          </svg>
          <p>Failed to load marketplaces</p>
          <p style="font-size: 0.75rem; color: var(--text-tertiary);">${error.message}</p>
          <button class="btn-secondary" onclick="loadMarketplaces()" style="margin-top: 1rem;">Retry</button>
        </div>
      `;
    }
  })();

  try {
    return await marketplacesLoadPromise;
  } finally {
    marketplacesLoadPromise = null;
  }
}

/**
 * Count total skills in a marketplace manifest
 */
function countTotalSkills(manifest) {
  if (!manifest || !manifest.plugins) return 0;

  let count = 0;
  for (const plugin of manifest.plugins) {
    if (plugin.skills && Array.isArray(plugin.skills)) {
      count += plugin.skills.length;
    } else {
      count += 1; // Plugin itself is a skill
    }
  }
  return count;
}

function getMarketplaceProviderLabel(marketplace) {
  switch (marketplace?.source?.type) {
    case "gitlab":
      return "GITLAB";
    case "github":
      return "GITHUB";
    case "url":
      return "URL";
    default:
      return null;
  }
}

function buildMarketplaceBadges(
  marketplace,
  { includeInstallState = true, includeVersion = true } = {},
) {
  const badges = [];

  if (marketplace.isOfficial) {
    badges.push('<span class="mcp-card-badge badge-official">OFFICIAL</span>');
  }

  const providerLabel = getMarketplaceProviderLabel(marketplace);
  if (providerLabel) {
    badges.push(
      `<span class="mcp-card-badge badge-provider">${providerLabel}</span>`,
    );
  }

  if (includeInstallState && marketplace.installedCount > 0) {
    badges.push(
      `<span class="mcp-card-badge badge-installed">${marketplace.installedCount} INSTALLED</span>`,
    );
  }

  if (includeInstallState && marketplace.parkedCount > 0) {
    badges.push(
      `<span class="mcp-card-badge badge-parked" title="Installed from a source that no longer exists upstream — waiting for an app update to resolve">${marketplace.parkedCount} PARKED</span>`,
    );
  }

  if (includeInstallState && marketplace.hasUpdates) {
    badges.push(
      '<span class="mcp-card-badge badge-has-updates">UPDATES</span>',
    );
  }

  if (includeInstallState && marketplace.conflictCount > 0) {
    badges.push(
      `<span class="mcp-card-badge badge-conflict">${marketplace.conflictCount} ${marketplace.conflictCount === 1 ? "CONFLICT" : "CONFLICTS"}</span>`,
    );
  }

  if (includeInstallState && marketplace.dirtyCount > 0) {
    badges.push(
      `<span class="mcp-card-badge badge-dirty">${marketplace.dirtyCount} DIRTY</span>`,
    );
  }

  if (includeVersion && marketplace.marketplaceVersion) {
    badges.push(
      `<span class="mcp-card-badge badge-version">v${marketplace.marketplaceVersion}</span>`,
    );
  }

  return badges;
}

// Service registry entries (result.marketplace) lack the enrichment
// loadMarketplaces adds to list cards, so the details header derives the same
// install-state counts from the open page's catalog instead.
function withCatalogDerivedBadgeCounts(marketplace) {
  const skills = marketplaceSkillsCache.get(marketplace?.id);
  if (!Array.isArray(skills)) return marketplace;
  // Count what the page can actually show: unavailable (external/degraded)
  // entries are dropped by every rendered view, so the header must not count
  // them either — a header/filter mismatch otherwise (2026-08-14 report).
  const visible = skills.filter((s) => s.available !== false);
  return {
    ...marketplace,
    installedCount: visible.filter((s) => s.installed).length,
    hasUpdates: visible.some((s) => s.hasUpdate),
    dirtyCount: visible.filter((s) => s.isDirty).length,
    conflictCount: visible.filter((s) => s.hasConflict).length,
  };
}

function updateMarketplaceDetailsHeader(marketplace = currentMarketplaceForDetails) {
  const contributionNoticeEl = document.getElementById(
    "marketplace-contribution-notice",
  );
  if (!marketplace) {
    if (contributionNoticeEl) contributionNoticeEl.style.display = "none";
    return;
  }

  const nameEl = document.getElementById("marketplace-details-name");
  const ownerEl = document.getElementById("marketplace-details-owner");
  const versionEl = document.getElementById("marketplace-details-version");
  const descriptionEl = document.getElementById(
    "marketplace-details-description",
  );
  const badgesEl = document.getElementById("marketplace-details-badges");

  if (nameEl) nameEl.textContent = marketplace.name;
  if (ownerEl) ownerEl.textContent = marketplace.owner?.name || "Unknown";
  if (versionEl)
    versionEl.textContent = marketplace.marketplaceVersion || "1.0.0";
  const versionWrap = document.getElementById(
    "marketplace-details-version-wrap",
  );
  if (versionWrap) versionWrap.style.display = "";
  if (descriptionEl)
    descriptionEl.textContent = marketplace.description || "No description";
  if (badgesEl) {
    badgesEl.innerHTML = buildMarketplaceBadges(
      withCatalogDerivedBadgeCounts(marketplace),
    ).join("");
  }
  if (contributionNoticeEl) {
    contributionNoticeEl.style.display = isPorticoAiMarketplace(marketplace)
      ? "flex"
      : "none";
  }

  updateMarketplaceCopyUrlButton(marketplace);
}

// =============================================================================
// RENDERING
// =============================================================================

/**
 * Render the marketplaces list
 */
function renderMarketplacesList() {
  const marketplacesList = document.getElementById("marketplaces-list");
  if (!marketplacesList) return;

  const filteredMarketplaces = getFilteredMarketplaces();

  if (filteredMarketplaces.length === 0) {
    if (marketplacesSearchQuery || marketplacesActiveFilter !== "all") {
      marketplacesList.innerHTML = `
        <div class="mcp-no-results">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="11" cy="11" r="8"></circle>
            <path d="m21 21-4.35-4.35"></path>
          </svg>
          <p>No marketplaces match your search</p>
        </div>
      `;
    } else {
      marketplacesList.innerHTML = `
        <div class="mcp-no-results">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="12" r="10"></circle>
            <path d="M2 12h20"></path>
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
          </svg>
          <p>No marketplaces configured</p>
          <p style="font-size: 0.75rem; color: var(--text-tertiary);">Click "Add Marketplace" to get started</p>
        </div>
      `;
    }
    return;
  }

  marketplacesList.innerHTML = filteredMarketplaces
    .map(renderMarketplaceCard)
    .join("");

  // Attach click handlers
  marketplacesList.querySelectorAll(".marketplace-card").forEach((card) => {
    const marketplaceId = card.dataset.marketplaceId;

    // Click on card to open details
    card.addEventListener("click", (e) => {
      // Don't trigger if clicking on action buttons
      if (e.target.closest(".marketplace-card-actions")) return;
      const marketplace = marketplacesData.find((m) => m.id === marketplaceId);
      if (!marketplace) return;
      openMarketplaceDetailsPage(marketplace);
    });
  });

  // Attach action button handlers
  marketplacesList.querySelectorAll(".marketplace-sync-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const marketplaceId = btn.dataset.marketplaceId;
      await syncMarketplace(marketplaceId);
    });
  });

  marketplacesList
    .querySelectorAll(".marketplace-remove-btn")
    .forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const marketplaceId = btn.dataset.marketplaceId;
        const marketplace = marketplacesData.find(
          (m) => m.id === marketplaceId,
        );
        if (marketplace) {
          openRemoveMarketplaceModal(marketplace);
        }
      });
    });
}

/**
 * Render a single marketplace card
 */
function renderMarketplaceCard(marketplace) {
  // Overview cards skip the version chip (noise at grid density); the
  // details-page header keeps the full badge set.
  const badges = buildMarketplaceBadges(marketplace, { includeVersion: false });

  const statsText = `${marketplace.totalSkills} skills available`;

  const cardActions = `
        <div class="marketplace-card-actions">
          <button class="marketplace-action-btn marketplace-sync-btn" data-marketplace-id="${marketplace.id}" title="Sync marketplace">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M1 4v6h6"></path>
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
            </svg>
          </button>
          ${
            marketplace.isOfficial || marketplace.ootb === true
              ? ""
              : `
          <button class="marketplace-action-btn marketplace-remove-btn" data-marketplace-id="${marketplace.id}" title="Remove marketplace">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
          `
          }
        </div>
  `;

  const metaText = `<span class="marketplace-card-synced">Synced ${
    marketplace.lastSynced
      ? formatRelativeTime(new Date(marketplace.lastSynced))
      : "Never synced"
  }</span>`;

  return `
    <div class="mcp-server-card marketplace-card" data-marketplace-id="${marketplace.id}">
      <div class="mcp-card-header">
        <div class="mcp-card-icon-wrapper">
          <div class="marketplace-card-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="12" cy="12" r="10"></circle>
              <path d="M2 12h20"></path>
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
            </svg>
          </div>
        </div>
        <div class="mcp-card-title-info">
          <h3 class="mcp-card-name">${escapeHtml(marketplace.name)}</h3>
          <span class="marketplace-card-stats">${statsText}</span>
        </div>
        ${cardActions}
      </div>
      <div class="mcp-card-body">
        <p class="marketplace-card-description">${escapeHtml(truncateText(marketplace.description || "No description", 120))}</p>
        <div class="mcp-card-badges">
          ${badges.join("")}
        </div>
        <div class="marketplace-card-meta">
          <span class="marketplace-card-owner">by ${escapeHtml(marketplace.owner?.name || "Unknown")}</span>
          ${metaText}
        </div>
      </div>
    </div>
  `;
}

// =============================================================================
// MARKETPLACE ACTIONS
// =============================================================================

function buildMarketplaceSyncNotification(marketplaceId, result) {
  const updatedSkills = Array.isArray(result.skillsUpdated) ? result.skillsUpdated : [];
  const contentRefreshCount = updatedSkills.filter(
    (skill) => skill?.updateKind === "content",
  ).length;
  const versionUpdateCount = updatedSkills.length - contentRefreshCount;
  const conflictedCount = result.skillsConflicted?.length || 0;
  const errorCount = result.skillSyncErrors?.length || 0;
  const removedCount = result.skillsRemoved?.length || 0;
  const pendingCount = result.pendingRemovals?.length || 0;
  const unknownUsageCount = Array.isArray(result.skillsSourceMissing)
    ? result.skillsSourceMissing.filter((entry) => entry?.agentsUnknown).length
    : 0;
  const parts = [`Marketplace "${marketplaceId}" synced`];

  if (versionUpdateCount > 0) {
    parts.push(`${versionUpdateCount} skill(s) updated`);
  }
  if (contentRefreshCount > 0) {
    parts.push(`${contentRefreshCount} skill(s) refreshed from changed content`);
  }
  if (conflictedCount > 0) {
    parts.push(`${conflictedCount} skill(s) have conflicts`);
  }
  if (errorCount > 0) {
    parts.push(`${errorCount} skill(s) failed`);
  }
  if (removedCount > 0) {
    parts.push(`${removedCount} skill(s) removed (no longer published upstream)`);
  }
  if (pendingCount > 0) {
    parts.push(`${pendingCount} skill(s) need your decision`);
  }
  if (unknownUsageCount > 0) {
    parts.push(
      `${unknownUsageCount} removed-upstream skill(s) kept — couldn't verify agent usage`,
    );
  }

  return {
    message: parts.join(". "),
    type:
      conflictedCount > 0 || errorCount > 0 || pendingCount > 0 || unknownUsageCount > 0
        ? "info"
        : "success",
  };
}

// Consent flow for one sync result's pendingRemovals (shared by the card and
// details-page sync buttons): modal → executor. Returns true when removals
// were applied (callers reload after).
async function resolveMarketplacePendingRemovals(marketplaceId, marketplaceName, result) {
  const pending = Array.isArray(result?.pendingRemovals) ? result.pendingRemovals : [];
  if (!pending.length) return false;
  const modal = window.runMarketplaceSyncRemovalModal;
  if (typeof modal !== "function") return false;
  const { action } = await modal([
    {
      marketplaceId,
      marketplaceName: marketplaceName || marketplaceId,
      pendingRemovals: pending.map((entry) => ({
        skillId: entry.skillId,
        pluginName: entry.pluginName ?? null,
        label: window.SkillCardRenderer?.composeSkillPluginLabel
          ? window.SkillCardRenderer.composeSkillPluginLabel(entry.skillId, entry.pluginName)
          : entry.skillId,
        seeded: entry.seeded === true,
        agents: Array.isArray(entry.agents) ? entry.agents : [],
      })),
    },
  ]);
  if (action !== "proceed") {
    showMarketplacesNotification(
      `Sync stopped: ${pending.length} skill(s) no longer published upstream kept until you decide.`,
      "info",
    );
    return false;
  }
  const res = await window.electronAPI?.applyMarketplaceSyncRemovals?.(
    marketplaceId,
    pending.map(({ skillId, pluginName }) => ({ skillId, pluginName: pluginName ?? null })),
  );
  if (!res?.success) {
    showMarketplacesNotification(
      `Could not apply removals: ${res?.error || "unknown error"}`,
      "error",
    );
    return false;
  }
  const flaggedNote = res.agentsFlagged?.length
    ? ` ${res.agentsFlagged.length} read-only agent(s) flagged for their owner.`
    : "";
  const seededNote = res.keptSeeded?.length
    ? ` Unlinked agents from ${res.keptSeeded.length} bundled skill(s) — they stay installed until an app update resolves them.`
    : "";
  const removedNote = res.removed?.length
    ? `Removed ${res.removed.length} skill(s) no longer published upstream.`
    : "";
  showMarketplacesNotification(
    `${removedNote}${seededNote}${flaggedNote}`.trim() || "Nothing to change.",
    "success",
  );
  return true;
}

/**
 * Sync a single marketplace
 */
async function syncMarketplace(marketplaceId) {
  const card = document.querySelector(
    `.marketplace-card[data-marketplace-id="${marketplaceId}"]`,
  );
  const syncBtn = card?.querySelector(".marketplace-sync-btn");

  if (syncBtn) {
    syncBtn.disabled = true;
    syncBtn.innerHTML = `<div class="btn-spinner"></div>`;
  }

  try {
    const result = await window.electronAPI.syncMarketplace(marketplaceId);

    if (!result.success) {
      throw new Error(result.error);
    }

    // Reload to get updated data
    await loadMarketplaces();

    const notification = buildMarketplaceSyncNotification(marketplaceId, result);
    showMarketplacesNotification(notification.message, notification.type);

    // Missing-upstream skills still used by agents: consent flow, then a
    // second reload when removals actually applied.
    const applied = await resolveMarketplacePendingRemovals(
      marketplaceId,
      result.marketplace?.name,
      result,
    );
    if (applied) {
      await loadMarketplaces();
    }
  } catch (error) {
    console.error(`[Marketplaces] Failed to sync ${marketplaceId}:`, error);
    showMarketplacesNotification(`Failed to sync marketplace: ${error.message}`, "error");

    // Restore button
    if (syncBtn) {
      syncBtn.disabled = false;
      syncBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M1 4v6h6"></path>
          <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
        </svg>
      `;
    }
  }
}

/**
 * Re-fetch and reinstall the exact marketplace solution recorded for every
 * installed Solutions Marketplace skill. Refresh authority comes from local
 * provenance, never from a remote name match.
 */
async function syncSolutionsMarketplaceSkills({ staggerMs = 350 } = {}) {
  const targets = [];
  const seen = new Set();
  try {
    const marketplacesRes = await window.electronAPI?.getMarketplaces?.();
    if (marketplacesRes?.success) {
      for (const skill of marketplacesRes.data?.installedSkills || []) {
        if (skill.marketplaceId !== SOLUTIONS_MARKETPLACE_SKILL_SOURCE_ID) continue;
        // Refresh only skills whose listing actually changed (checkSkillUpdates
        // runs before this in the Sync All flow and compares the listing's
        // updated_at against the stored baseline). Blind-reinstalling every
        // solutions skill wasted marketplace calls and reported "refreshed"
        // for copies that were already current.
        if (skill.hasUpdate !== true) continue;
        const skillId = String(skill.skillId || "").trim();
        const source = skill.skillSource;
        const solutionId =
          source?.type === "ai-marketplace-solution"
            ? String(source.solutionId || "").trim()
            : "";
        if (!skillId || !solutionId) continue;
        const key = `${solutionId}\u0000${skillId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        targets.push({ skillId, solutionId });
      }
    }
  } catch (error) {
    console.warn(
      "[Marketplaces] Could not resolve installed Solutions Marketplace provenance:",
      error,
    );
  }

  if (targets.length === 0) {
    return { updated: 0, failed: 0 };
  }

  let updated = 0;
  let failed = 0;
  for (const target of targets) {
    try {
      const result = await window.electronAPI?.aiMarketplace?.install(
        target.solutionId,
        { refreshInstalledSkillId: target.skillId },
      );
      if (result?.success) {
        updated += 1;
      } else {
        failed += 1;
      }
    } catch (error) {
      failed += 1;
      console.warn(
        `[Marketplaces] Failed to update Solutions Marketplace skill ${target.solutionId}:`,
        error,
      );
    }
    // Stagger between installs to spread out marketplace API load.
    if (staggerMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, staggerMs));
    }
  }

  return { updated, failed };
}

/**
 * Check for updates across all marketplaces
 */
async function checkForMarketplaceUpdates() {
  const btn = document.getElementById("check-updates-btn");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<div class="btn-spinner"></div> Syncing...`;
  }

  try {
    // First sync all git-backed marketplaces
    const syncAllRes = await window.electronAPI.syncAllMarketplaces();

    // Then check for skill updates
    const result = await window.electronAPI.checkSkillUpdates();

    // Refresh latest skills from the Solutions Marketplace (staggered).
    const solutionsResult = await syncSolutionsMarketplaceSkills();

    // Reload to get updated data
    await loadMarketplaces();
    if (typeof loadSkills === "function") {
      loadSkills();
    }

    // Missing-upstream skills still used by agents block the sync until the
    // user decides — one consent flow per affected marketplace.
    if (syncAllRes?.success && Array.isArray(syncAllRes.results)) {
      let appliedAny = false;
      for (const entry of syncAllRes.results) {
        if (!entry?.success || !entry.pendingRemovals?.length) continue;
        const applied = await resolveMarketplacePendingRemovals(
          entry.id,
          entry.id,
          entry,
        );
        appliedAny = appliedAny || applied;
      }
      if (appliedAny) {
        await loadMarketplaces();
      }
    }

    const messages = [];
    if (result.success && result.hasUpdates) {
      messages.push(`${result.updates.length} skill update(s) available`);
    }
    if (solutionsResult.updated > 0) {
      messages.push(
        `${solutionsResult.updated} Solutions Marketplace skill(s) refreshed`,
      );
    }
    if (solutionsResult.failed > 0) {
      messages.push(
        `${solutionsResult.failed} Solutions Marketplace skill(s) failed`,
      );
    }

    if (messages.length > 0) {
      showMarketplacesNotification(
        messages.join(". "),
        solutionsResult.failed > 0 ? "info" : "success",
      );
    } else {
      showMarketplacesNotification("All skills are up to date", "success");
    }
  } catch (error) {
    console.error("[Marketplaces] Failed to check for updates:", error);
    showMarketplacesNotification(`Failed to check for updates: ${error.message}`, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M1 4v6h6"></path>
          <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
        </svg>
        Sync All
      `;
    }
  }
}

// =============================================================================
// ADD MARKETPLACE MODAL
// =============================================================================

function focusAddMarketplaceInputAfterRender() {
  const focusInput = () => {
    const modal = document.getElementById("add-marketplace-modal");
    const input = document.getElementById("marketplace-source-input");
    if (!modal?.classList?.contains("visible") || !input) {
      return;
    }

    try {
      input.focus({ preventScroll: true });
    } catch (_) {
      input.focus();
    }
  };

  if (
    typeof window !== "undefined" &&
    typeof window.requestAnimationFrame === "function"
  ) {
    window.requestAnimationFrame(focusInput);
    return;
  }

  if (typeof setTimeout === "function") {
    setTimeout(focusInput, 0);
    return;
  }

  focusInput();
}

/**
 * Open the add marketplace modal
 */
function openAddMarketplaceModal() {
  const modal = document.getElementById("add-marketplace-modal");
  const input = document.getElementById("marketplace-source-input");
  const errorDiv = document.getElementById("add-marketplace-error");

  if (modal) {
    modal.classList.add("visible");
    if (input) {
      input.value = "";
    }
    if (errorDiv) {
      errorDiv.style.display = "none";
    }
    focusAddMarketplaceInputAfterRender();
  }
}

/**
 * Close the add marketplace modal
 */
function closeAddMarketplaceModal() {
  const modal = document.getElementById("add-marketplace-modal");
  if (modal) {
    modal.classList.remove("visible");
  }
}

/**
 * Submit the add marketplace form
 */
async function submitAddMarketplace() {
  const input = document.getElementById("marketplace-source-input");
  const errorDiv = document.getElementById("add-marketplace-error");
  const errorText = document.getElementById("add-marketplace-error-text");
  const submitBtn = document.getElementById("add-marketplace-submit-btn");

  const value = input?.value?.trim();

  if (!value) {
    showAddMarketplaceError(
      "Enter an Portico GitLab repository (example.invalid) or one of Anthropic's approved repos: anthropics/skills, anthropics/knowledge-work-plugins",
    );
    return;
  }

  // Disable button and show loading
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = `<div class="btn-spinner"></div> Adding...`;
  }
  if (errorDiv) {
    errorDiv.style.display = "none";
  }

  try {
    const result = await window.electronAPI.addMarketplace(value);

    if (!result.success) {
      throw new Error(result.error);
    }

    closeAddMarketplaceModal();
    await loadMarketplaces();
    showMarketplacesNotification(
      `Marketplace "${result.marketplace.name}" added successfully`,
      "success",
    );
  } catch (error) {
    console.error("[Marketplaces] Failed to add marketplace:", error);
    showAddMarketplaceError(error.message);
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="16"></line>
          <line x1="8" y1="12" x2="16" y2="12"></line>
        </svg>
        Add Marketplace
      `;
    }
  }
}

/**
 * Show error in add marketplace modal
 */
function showAddMarketplaceError(message) {
  const errorDiv = document.getElementById("add-marketplace-error");
  const errorText = document.getElementById("add-marketplace-error-text");

  if (errorDiv && errorText) {
    errorText.textContent = message;
    errorDiv.style.display = "flex";
  }
}

/**
 * Initialize add marketplace modal
 */
function initAddMarketplaceModal() {
  const modal = document.getElementById("add-marketplace-modal");
  const closeBtn = document.getElementById("add-marketplace-close-btn");
  const cancelBtn = document.getElementById("add-marketplace-cancel-btn");
  const submitBtn = document.getElementById("add-marketplace-submit-btn");
  const input = document.getElementById("marketplace-source-input");

  if (closeBtn) closeBtn.addEventListener("click", closeAddMarketplaceModal);
  if (cancelBtn) cancelBtn.addEventListener("click", closeAddMarketplaceModal);
  if (submitBtn) submitBtn.addEventListener("click", submitAddMarketplace);

  // Submit on Enter key
  if (input) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        submitAddMarketplace();
      }
    });
  }

  // Close on backdrop click
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeAddMarketplaceModal();
    });
  }

  // Close on Escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal?.classList.contains("visible")) {
      closeAddMarketplaceModal();
    }
  });
}

// =============================================================================
// REMOVE MARKETPLACE MODAL
// =============================================================================

let marketplaceToRemove = null;

/**
 * Open the remove marketplace confirmation modal
 */
function openRemoveMarketplaceModal(marketplace) {
  marketplaceToRemove = marketplace;

  const modal = document.getElementById("remove-marketplace-modal");
  const nameEl = document.getElementById("remove-marketplace-name");
  const countEl = document.getElementById("remove-marketplace-skill-count");
  const checkbox = document.getElementById(
    "remove-marketplace-skills-checkbox",
  );
  const warningDiv = document.querySelector(".remove-marketplace-warning");

  if (nameEl) nameEl.textContent = marketplace.name;
  if (countEl) countEl.textContent = marketplace.installedCount || 0;
  if (checkbox) checkbox.checked = false;

  // Show/hide warning based on installed skills
  if (warningDiv) {
    warningDiv.style.display = marketplace.installedCount > 0 ? "flex" : "none";
  }

  if (modal) modal.classList.add("visible");
}

/**
 * Close the remove marketplace modal
 */
function closeRemoveMarketplaceModal() {
  const modal = document.getElementById("remove-marketplace-modal");
  if (modal) modal.classList.remove("visible");
  marketplaceToRemove = null;
}

/**
 * Confirm remove marketplace
 */
async function confirmRemoveMarketplace() {
  if (!marketplaceToRemove) return;

  const checkbox = document.getElementById(
    "remove-marketplace-skills-checkbox",
  );
  const removeSkills = checkbox?.checked || false;
  const confirmBtn = document.getElementById("remove-marketplace-confirm-btn");

  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Removing...";
  }

  try {
    const result = await window.electronAPI.removeMarketplace(
      marketplaceToRemove.id,
      removeSkills,
    );

    if (!result.success) {
      throw new Error(result.error);
    }

    const removedName = marketplaceToRemove.name;
    closeRemoveMarketplaceModal();
    await loadMarketplaces();
    showMarketplacesNotification(
      `Marketplace "${removedName}" removed`,
      "success",
    );
  } catch (error) {
    console.error("[Marketplaces] Failed to remove marketplace:", error);
    showMarketplacesNotification(`Failed to remove marketplace: ${error.message}`, "error");
  } finally {
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = "Remove Marketplace";
    }
  }
}

/**
 * Initialize remove marketplace modal
 */
function initRemoveMarketplaceModal() {
  const modal = document.getElementById("remove-marketplace-modal");
  const closeBtn = document.getElementById("remove-marketplace-close-btn");
  const cancelBtn = document.getElementById("remove-marketplace-cancel-btn");
  const confirmBtn = document.getElementById("remove-marketplace-confirm-btn");

  if (closeBtn) closeBtn.addEventListener("click", closeRemoveMarketplaceModal);
  if (cancelBtn)
    cancelBtn.addEventListener("click", closeRemoveMarketplaceModal);
  if (confirmBtn)
    confirmBtn.addEventListener("click", confirmRemoveMarketplace);

  // Close on backdrop click
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeRemoveMarketplaceModal();
    });
  }

  // Close on Escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal?.classList.contains("visible")) {
      closeRemoveMarketplaceModal();
    }
  });
}

// =============================================================================
// MARKETPLACE DETAILS MODAL (BROWSE SKILLS)
// =============================================================================

/**
 * Open the marketplace details modal to browse skills
 */
function getMarketplaceDetailsHost() {
  return document.getElementById("marketplace-details-page");
}

// The details page renders the same .agent-editor-page chrome as the inline
// skill and agent pages; all functional ids from the old modal are preserved
// so the header/copy-url updaters keep working unchanged.
function renderMarketplaceDetailsPageShell() {
  const host = getMarketplaceDetailsHost();
  if (!host) return null;
  host.innerHTML = `
    <div class="agent-editor-page">
      <div class="agent-editor-header">
        <button class="agent-editor-back-btn" id="marketplace-details-back-btn" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"></path></svg>
          Back
        </button>
        <div class="agent-editor-header-main">
          <h1 id="marketplace-details-name">Marketplace</h1>
          <p>
            by <span id="marketplace-details-owner">Unknown</span><span id="marketplace-details-version-wrap"> • v<span id="marketplace-details-version">1.0.0</span></span>
          </p>
          <div class="agent-editor-page-chips" id="marketplace-details-badges"></div>
        </div>
        <div class="agent-editor-page-actions" data-marketplace-page-actions>
          <button
            class="btn-secondary agent-page-action marketplace-copy-url-btn"
            id="marketplace-details-copy-url-btn"
            title="Copy the configured marketplace URL"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            Copy URL
          </button>
          <button
            class="btn-secondary agent-page-action marketplace-view-repo-btn"
            id="marketplace-details-view-repo-btn"
            title="Open the configured marketplace repository"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 3h7v7"></path>
              <path d="M10 14L21 3"></path>
              <path d="M21 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
            </svg>
            View Repo
          </button>
          <button
            class="btn-secondary agent-page-action marketplace-sync-btn"
            id="marketplace-details-sync-btn"
            title="Fetch latest skills and updates from the remote repository"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M1 4v6h6"></path>
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
            </svg>
            Sync
          </button>
        </div>
      </div>
      <div class="agent-editor-inline-body marketplace-details-page-body">
        <p class="marketplace-details-page-description" id="marketplace-details-description"></p>
        <div
          class="marketplace-contribution-notice"
          id="marketplace-contribution-notice"
          role="note"
          style="display: none"
        >
          <svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="16" x2="12" y2="12"></line>
            <line x1="12" y1="8" x2="12.01" y2="8"></line>
          </svg>
          <span>
            Contributing to portico-ai-marketplace? Follow README.md and
            AGENTS.md, plus CONTRIBUTING.md if present: create a branch in the
            target project and open an MR from that branch. Fork MRs fail
            because CI needs internal variables; fix project access or
            GitLab/SSH setup instead of forking.
          </span>
        </div>
        <div class="mcp-search-filter-bar">
          <div class="mcp-search-wrapper">
            <svg class="mcp-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8"></circle>
              <path d="M21 21l-4.35-4.35"></path>
            </svg>
            <input
              type="text"
              class="mcp-search-input"
              id="marketplace-skills-search-input"
              placeholder="Search skills..."
            />
          </div>
          <div class="mcp-filter-tabs" id="marketplace-skills-filter-tabs">
            <button class="mcp-filter-tab active" data-filter="all">All</button>
            <button class="mcp-filter-tab" data-filter="installed">Installed</button>
            <button class="mcp-filter-tab" data-filter="available">Available</button>
            <button class="mcp-filter-tab" data-filter="updates">Has Updates</button>
          </div>
        </div>
        <div class="marketplace-skills-grid" id="marketplace-skills-list"></div>
      </div>
    </div>
  `;
  return host;
}

// Wire page chrome (elements are recreated per open).
function wireMarketplaceDetailsPageChrome() {
  const backBtn = document.getElementById("marketplace-details-back-btn");
  if (backBtn) backBtn.addEventListener("click", closeMarketplaceDetailsPage);

  const copyBtn = document.getElementById("marketplace-details-copy-url-btn");
  if (copyBtn) copyBtn.addEventListener("click", copyMarketplaceUrlToClipboard);

  const viewRepoBtn = document.getElementById("marketplace-details-view-repo-btn");
  if (viewRepoBtn) viewRepoBtn.addEventListener("click", openMarketplaceRepository);

  const syncBtn = document.getElementById("marketplace-details-sync-btn");
  if (syncBtn) {
    syncBtn.addEventListener("click", async () => {
      if (!currentMarketplaceForDetails) return;

      const originalHtml = syncBtn.innerHTML;
      syncBtn.disabled = true;
      syncBtn.innerHTML = `<div class="btn-spinner"></div> Syncing...`;

      try {
        const syncResult = await window.electronAPI.syncMarketplace(
          currentMarketplaceForDetails.id,
        );

        if (!syncResult.success) {
          throw new Error(syncResult.error || "Sync failed");
        }

        // A sync is fresh data, not an in-place action — re-rank the view.
        marketplaceOrderFreeze = null;
        await refreshCurrentMarketplaceDetails();
        await loadMarketplaces();
        const notification = buildMarketplaceSyncNotification(
          currentMarketplaceForDetails.id,
          syncResult,
        );
        showMarketplacesNotification(notification.message, notification.type);
        const applied = await resolveMarketplacePendingRemovals(
          currentMarketplaceForDetails.id,
          syncResult.marketplace?.name,
          syncResult,
        );
        if (applied) {
          await refreshCurrentMarketplaceDetails();
          await loadMarketplaces();
        }
      } catch (error) {
        console.error("[Marketplaces] Sync failed:", error);
        showMarketplacesNotification(`Sync failed: ${error.message}`, "error");
      } finally {
        syncBtn.disabled = false;
        syncBtn.innerHTML = originalHtml;
      }
    });
  }

  const searchInput = document.getElementById("marketplace-skills-search-input");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      marketplaceSkillsSearchQuery = e.target.value.toLowerCase();
      rerenderCurrentMarketplaceSkills();
    });
  }

  const filterTabs = document.querySelectorAll(
    "#marketplace-skills-filter-tabs .mcp-filter-tab",
  );
  filterTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      filterTabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      marketplaceSkillsFilter = tab.dataset.filter;
      rerenderCurrentMarketplaceSkills();
    });
  });
}

async function openMarketplaceDetailsPage(marketplace) {
  currentMarketplaceForDetails = marketplace;
  marketplaceSkillsSearchQuery = "";
  marketplaceSkillsFilter = "all";
  marketplaceDetailsView = { mode: "all", pluginName: null };
  const generation = ++marketplacePageGeneration;

  const host = renderMarketplaceDetailsPageShell();
  if (!host) return;
  updateMarketplaceDetailsHeader(marketplace);
  wireMarketplaceDetailsPageChrome();

  // Take over the Agent Skills subview exactly like the inline skill page:
  // the whole browser (search + tabs + list) and the header actions hide
  // while the page owns the view.
  const browser = document.getElementById("agent-skills-browser");
  if (browser) browser.style.display = "none";
  const headerActions = document.getElementById("skills-header-actions");
  if (headerActions) headerActions.style.display = "none";
  host.style.display = "";
  host.scrollTop = 0;

  // Agent-usage badges load in parallel with the skills paint and repaint at
  // most once — and only when a grid has already painted, so the loading
  // spinner is never replaced by a premature empty state.
  void refreshMarketplaceAgentUsage(generation).then((applied) => {
    if (!applied) return;
    if (marketplaceSkillsCache.has(marketplace.id)) {
      // Still part of view initialization: usage arriving means the usage
      // ranking can finally apply — recapture the order.
      marketplaceOrderFreeze = null;
      rerenderCurrentMarketplaceSkills();
    }
  });

  // Progressive load, one shot per open: paint instantly from the session
  // cache or the main process's cached-manifest fast path, then run the
  // single authoritative refresh (which can do network work the first time).
  const skillsList = document.getElementById("marketplace-skills-list");
  let painted = false;
  const sessionCached = marketplaceSkillsCache.get(marketplace.id);
  if (sessionCached) {
    renderMarketplaceSkillsList(sessionCached);
    painted = true;
  } else if (skillsList) {
    skillsList.innerHTML = `
      <div class="mcp-loading">
        <div class="mcp-loading-spinner"></div>
        <p>Loading skills...</p>
      </div>
    `;
  }

  if (
    !painted &&
    typeof window.electronAPI.getMarketplaceSkillsCached === "function"
  ) {
    const fast = await window.electronAPI
      .getMarketplaceSkillsCached(marketplace.id)
      .catch(() => null);
    if (generation !== marketplacePageGeneration) return;
    if (fast?.success && Array.isArray(fast.skills)) {
      currentMarketplaceForDetails = fast.marketplace || currentMarketplaceForDetails;
      marketplaceSkillsCache.set(marketplace.id, fast.skills);
      updateMarketplaceDetailsHeader(currentMarketplaceForDetails);
      marketplaceOrderFreeze = null; // open-path paint: sort fresh
      renderMarketplaceSkillsList(fast.skills);
      painted = true;
    }
  }

  try {
    const result = await window.electronAPI.getMarketplaceSkills(
      marketplace.id,
    );
    if (generation !== marketplacePageGeneration) return;

    if (!result.success) {
      throw new Error(result.error);
    }

    currentMarketplaceForDetails = result.marketplace || currentMarketplaceForDetails;
    marketplaceSkillsCache.set(marketplace.id, result.skills);
    updateMarketplaceDetailsHeader(currentMarketplaceForDetails);
    marketplaceOrderFreeze = null; // open-path paint: sort fresh
    renderMarketplaceSkillsList(result.skills);
  } catch (error) {
    if (generation !== marketplacePageGeneration) return;
    console.error("[Marketplaces] Failed to load skills:", error);
    if (painted) {
      // A stale-but-rendered catalog beats an error screen; surface the
      // refresh failure without discarding the grid.
      showMarketplacesNotification(`Failed to refresh skills: ${error.message}`, "error");
    } else if (skillsList) {
      skillsList.innerHTML = `
        <div class="mcp-no-results">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="15" y1="9" x2="9" y2="15"></line>
            <line x1="9" y1="9" x2="15" y2="15"></line>
          </svg>
          <p>Failed to load skills</p>
          <p style="font-size: 0.75rem; color: var(--text-tertiary);">${error.message}</p>
        </div>
      `;
    }
  }
}

// One-shot fetch of the agent-usage inventory, folded into
// leaf -> [{ id, name }]. Fail-open: any failure yields an empty map.
async function fetchAgentSkillUsageMap() {
  const usage = new Map();
  try {
    const result = await window.electronAPI?.listAgentSkillUsage?.();
    if (result?.success && Array.isArray(result.agents)) {
      for (const agent of result.agents) {
        if (!agent || !Array.isArray(agent.leaves)) continue;
        const entry = { id: agent.id, name: agent.name };
        for (const leaf of new Set(agent.leaves)) {
          if (!leaf) continue;
          if (!usage.has(leaf)) usage.set(leaf, []);
          usage.get(leaf).push(entry);
        }
      }
    }
  } catch {
    // fail-open: no badges this cycle
  }
  return usage;
}

// Refresh the usage map unless the page moved on while we fetched. Returns
// whether the result was applied (callers decide if a repaint is due).
async function refreshMarketplaceAgentUsage(generation) {
  const usage = await fetchAgentSkillUsageMap();
  if (generation !== marketplacePageGeneration) return false;
  marketplaceAgentUsage = usage;
  return true;
}

/**
 * Close the inline marketplace details page and restore the browse view.
 */
function closeMarketplaceDetailsPage() {
  marketplacePageGeneration += 1;
  updateMarketplaceCopyUrlButton(null);

  const host = getMarketplaceDetailsHost();
  if (host) {
    host.innerHTML = "";
    host.style.display = "none";
  }
  // When an inline skill page owns the subview (e.g. it force-closed this
  // page while suspended), tearing down state is fine but the browse chrome
  // must NOT come back underneath the editor — its own teardown restores it.
  const inlineSkillPageOpen =
    typeof window.isInlineSkillPageOpen === "function" &&
    window.isInlineSkillPageOpen();
  if (!inlineSkillPageOpen) {
    const browser = document.getElementById("agent-skills-browser");
    if (browser) browser.style.display = "";
    // Restore the Sync All / Add Marketplace actions only if the skills
    // subview is still the active one, mirroring the inline skill page
    // teardown.
    if (window.appState?.controlPlaneView === "agent-skills") {
      const actions = document.getElementById("skills-header-actions");
      if (actions) actions.style.display = "";
      if (typeof window.AgentSkillsHooks?.updateSkillsHeaderActions === "function") {
        window.AgentSkillsHooks.updateSkillsHeaderActions();
      }
    }
  }

  currentMarketplaceForDetails = null;
  marketplaceDetailsView = { mode: "all", pluginName: null };
}

// Suspend/resume: hide the details page WITHOUT tearing it down, so the
// inline skill page can borrow the Agent Skills subview and Back lands
// exactly where the user left off — state, DOM, drill-in, filter, and
// generation all stay live. Neither function touches marketplacePageGeneration.
function suspendMarketplaceDetailsPage() {
  if (!currentMarketplaceForDetails) return false;
  const host = getMarketplaceDetailsHost();
  if (!host || !host.innerHTML) return false;
  host.style.display = "none";
  return true;
}

function resumeMarketplaceDetailsPage() {
  if (!currentMarketplaceForDetails) return false;
  const host = getMarketplaceDetailsHost();
  if (!host || !host.innerHTML) return false;
  host.style.display = "";
  // The page still owns the subview — keep the browse chrome hidden.
  const browser = document.getElementById("agent-skills-browser");
  if (browser) browser.style.display = "none";
  const headerActions = document.getElementById("skills-header-actions");
  if (headerActions) headerActions.style.display = "none";
  return true;
}

function isMarketplaceDetailsPageOpen() {
  return Boolean(currentMarketplaceForDetails);
}

function matchesMarketplaceSkillsFilter(skill) {
  switch (marketplaceSkillsFilter) {
    case "installed":
      return Boolean(skill.installed);
    case "available":
      return !skill.installed;
    case "updates":
      return Boolean(skill.hasUpdate);
    default:
      return true;
  }
}

/**
 * Get filtered skills for the marketplace details modal
 */
function getFilteredMarketplaceSkills(skills) {
  // External/unavailable entries are unreachable (no install path) — they are
  // hidden from every list view, including search results.
  let filtered = skills.filter((s) => s.available !== false);

  // Apply search filter
  if (marketplaceSkillsSearchQuery) {
    filtered = filtered.filter(
      (s) =>
        s.name.toLowerCase().includes(marketplaceSkillsSearchQuery) ||
        s.displayName.toLowerCase().includes(marketplaceSkillsSearchQuery) ||
        s.description?.toLowerCase().includes(marketplaceSkillsSearchQuery),
    );
  }

  filtered = filtered.filter(matchesMarketplaceSkillsFilter);

  // Sort: agent-used skills first (usage count descending), then installed,
  // then alphabetically within each group.
  filtered.sort((a, b) => {
    const usageDelta =
      (marketplaceAgentUsage.get(b.id) || []).length -
      (marketplaceAgentUsage.get(a.id) || []).length;
    if (usageDelta) return usageDelta;
    if (a.installed && !b.installed) return -1;
    if (!a.installed && b.installed) return 1;
    return (a.displayName || a.name).localeCompare(b.displayName || b.name);
  });

  return filtered;
}

/**
 * Group the flat catalog into plugin folders + root skills using the cached
 * manifest. Unavailable sourced plugins (external repos, failed sources) are
 * hidden entirely — they have no install path, so listing them is pure noise;
 * their placeholder root entries are consumed so they can't resurface either.
 */
function buildMarketplaceFolderModel(marketplace, skills) {
  const plugins = Array.isArray(marketplace?.cachedManifest?.plugins)
    ? marketplace.cachedManifest.plugins
    : [];
  const byPlugin = new Map();
  for (const skill of skills) {
    if (!skill.pluginName) continue;
    if (!byPlugin.has(skill.pluginName)) byPlugin.set(skill.pluginName, []);
    byPlugin.get(skill.pluginName).push(skill);
  }

  const folders = [];
  const consumedRootIds = new Set();
  for (const plugin of plugins) {
    if (!plugin || typeof plugin.name !== "string" || !plugin.name) continue;
    const pluginSkills = byPlugin.get(plugin.name) || [];
    const unavailable = plugin.unavailable === true;
    if (!pluginSkills.length && !unavailable) {
      // Single-skill plugin (plugin IS the skill): stays a root skill card.
      continue;
    }
    if (unavailable) {
      // The flat catalog carries a single placeholder entry for a sourced
      // unavailable plugin — consume it so it can't render as a root skill,
      // and skip the folder itself (externals are hidden, not badged).
      consumedRootIds.add(plugin.name);
      continue;
    }
    const installedCount = pluginSkills.filter((skill) => skill.installed).length;
    folders.push({
      name: plugin.name,
      displayName: plugin.displayName || formatPluginDisplayName(plugin.name),
      description: plugin.description || "No description available",
      category: typeof plugin.category === "string" ? plugin.category : "",
      skills: pluginSkills,
      installedCount,
      // Full-catalog totals survive the filter-tab narrowing spread, so
      // installed-state affordances stay truthful under narrowed views.
      totalSkillCount: pluginSkills.length,
      totalInstalledCount: installedCount,
      unavailable: false,
      unavailableReason: null,
    });
  }
  const rootSkills = skills.filter(
    (skill) =>
      !skill.pluginName &&
      !consumedRootIds.has(skill.id) &&
      skill.available !== false,
  );
  // Directory order: most-installed plugins first (installed count
  // descending), alphabetical within a count; root skills rank agent-used
  // first (usage count descending), then installed, alphabetical within
  // each group.
  folders.sort(
    (a, b) =>
      b.installedCount - a.installedCount ||
      a.displayName.localeCompare(b.displayName),
  );
  rootSkills.sort(
    (a, b) =>
      (marketplaceAgentUsage.get(b.id) || []).length -
        (marketplaceAgentUsage.get(a.id) || []).length ||
      Number(Boolean(b.installed)) - Number(Boolean(a.installed)) ||
      (a.displayName || a.name).localeCompare(b.displayName || b.name),
  );
  return { folders, rootSkills };
}

// Funnel every plugin-name surface through the shared skill-name derivation
// (it carries the acronym pass, so "mcp-tools" reads "MCP Tools" here exactly
// as it does on the Agent Skills cards). The local title-case is only the
// fallback for when the renderer module has not loaded.
function formatPluginDisplayName(name) {
  const shared = window.SkillCardRenderer?.formatPluginLabel;
  if (typeof shared === "function") return shared(name);
  return String(name || "")
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function renderMarketplacePluginFolderCard(folder) {
  // Counter badges are hover units (the shared floating tooltip is wired
  // document-wide by agents.js): the chip + its info icon travel INSIDE one
  // trigger, so hovering either — or the gap between — shows the list. One
  // names every skill this card counts, one names WHICH are installed.
  const skillNames = folder.skills.map((skill) => skill.displayName || skill.name);
  const skillCountChip = `<span class="mcp-card-badge badge-version">${escapeHtml(`${folder.skills.length} skill${folder.skills.length === 1 ? "" : "s"}`)}</span>`;
  const skillCountUnit = skillNames.length
    ? infoListTriggerHtml(
        {
          title: `${skillNames.length} skill${skillNames.length === 1 ? "" : "s"} in this plugin`,
          items: skillNames,
          icon: "skill",
        },
        `Skills in this plugin: ${skillNames.join(", ")}`,
        skillCountChip,
      )
    : skillCountChip;
  // Search results decorate the folder with the members the query matched —
  // they fold into this chip instead of duplicating as loose skill cards.
  const matchingNames = Array.isArray(folder.searchMatches)
    ? folder.searchMatches.map((skill) => skill.displayName || skill.name)
    : [];
  const matchingChip = `<span class="mcp-card-badge badge-installed">${escapeHtml(`${matchingNames.length} matching`)}</span>`;
  const matchingUnit = matchingNames.length
    ? infoListTriggerHtml(
        {
          title: `${matchingNames.length} matching skill${matchingNames.length === 1 ? "" : "s"} in this plugin`,
          items: matchingNames,
          icon: "skill",
        },
        `Matching skills in this plugin: ${matchingNames.join(", ")}`,
        matchingChip,
      )
    : "";
  const installedNames = folder.skills
    .filter((skill) => skill.installed)
    .map((skill) => skill.displayName || skill.name);
  const installedChip = `<span class="mcp-card-badge badge-installed">${folder.installedCount} INSTALLED</span>`;
  const installedUnit = installedNames.length
    ? infoListTriggerHtml(
        {
          title: "Installed from this plugin",
          items: installedNames,
          icon: "check",
        },
        `Installed from this plugin: ${installedNames.join(", ")}`,
        installedChip,
      )
    : installedChip;
  // The installed counter reads best on its own line under the other badges.
  const installedRow =
    folder.installedCount > 0
      ? `<div class="marketplace-skill-badges marketplace-folder-installed-row">${installedUnit}</div>`
      : "";
  // Footer states are decided on FULL-catalog totals (which survive the
  // filter-tab narrowing) so a partially-installed plugin can never read
  // "All Installed" just because the current tab hid its remaining skills.
  const totalSkillCount = folder.totalSkillCount ?? folder.skills.length;
  const totalInstalledCount = folder.totalInstalledCount ?? folder.installedCount;
  const installableCount = folder.skills.filter(
    (skill) => !skill.installed && skill.available !== false,
  ).length;
  let footerAction = "";
  if (totalSkillCount > 0 && totalInstalledCount === totalSkillCount) {
    footerAction = `<button class="btn-primary btn-all-installed" type="button" disabled title="All ${totalSkillCount} skill${totalSkillCount === 1 ? "" : "s"} from this plugin are installed"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg> All Installed</button>`;
  } else if (installableCount > 0) {
    footerAction = `<button class="btn-primary marketplace-plugin-install-all-btn" data-plugin-name="${escapeHtml(folder.name)}">Install All</button>`;
  }

  // Kebab appears only when something is actually uninstallable. Gate on the
  // FULL-catalog installed total (like the footer) so a filter tab that hides
  // installed members can't make the menu vanish from a partially-shown card.
  const kebabInstalledCount = folder.totalInstalledCount ?? folder.installedCount;
  const menuWrapper =
    kebabInstalledCount > 0
      ? `
      <div class="mcp-card-menu-wrapper">
        <button class="mcp-card-menu-trigger" data-menu-plugin-name="${escapeHtml(folder.name)}" aria-label="Plugin options">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="5" r="2"></circle>
            <circle cx="12" cy="12" r="2"></circle>
            <circle cx="12" cy="19" r="2"></circle>
          </svg>
        </button>
        <div class="mcp-card-dropdown" data-dropdown-plugin-name="${escapeHtml(folder.name)}">
          <button class="mcp-dropdown-item marketplace-plugin-uninstall-all-btn delete-action" data-plugin-name="${escapeHtml(folder.name)}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
            Uninstall All
          </button>
        </div>
      </div>`
      : "";

  return `
    <div class="marketplace-skill-card marketplace-plugin-folder-card" data-plugin-name="${escapeHtml(folder.name)}" data-drillable="true">
      ${menuWrapper}
      <div class="marketplace-skill-main">
        <div class="marketplace-skill-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
          </svg>
        </div>
        <div class="marketplace-skill-info">
          <h4 class="marketplace-skill-name">${escapeHtml(folder.displayName)}</h4>
          <p class="marketplace-skill-description">${escapeHtml(truncateText(folder.description, 100))}</p>
          <div class="marketplace-skill-badges">
            ${skillCountUnit}${matchingUnit}
          </div>
          ${installedRow}
        </div>
      </div>
      ${footerAction ? `<div class="mcp-card-footer skill-card-actions">${footerAction}</div>` : ""}
    </div>
  `;
}

/**
 * Render the details modal body for the current view state: plugin folders +
 * root skills ("all" + empty search), one plugin's skills with a back row
 * (drill-in), or the flat filtered list (search / non-"all" filter).
 */
// Identity of the currently painted view. The filter TAB is deliberately
// absent: tab switches narrow the frozen order rather than re-ranking it.
function marketplaceDetailsViewKey() {
  return [
    marketplacePageGeneration,
    marketplaceDetailsView.mode,
    marketplaceDetailsView.pluginName || "",
    marketplaceSkillsSearchQuery,
  ].join("|");
}

// Reorders freshly-sorted folder/skill lists to the order captured at this
// view's first paint. A key change (new page open, drill-in/back, new query)
// recaptures — that IS the resort. Entries unseen at capture time (e.g.
// sync-added skills) append in their sorted relative order, then hold that
// slot on later paints.
function applyMarketplaceOrderFreeze(folders, skills) {
  const key = marketplaceDetailsViewKey();
  if (marketplaceOrderFreeze?.key !== key) {
    marketplaceOrderFreeze = {
      key,
      folders: folders.map((folder) => folder.name),
      skills: skills.map((skill) => skill.id),
    };
    return { folders, skills };
  }
  const orderBy = (list, frozenIds, idOf) => {
    const index = new Map(frozenIds.map((id, i) => [id, i]));
    const known = list.filter((item) => index.has(idOf(item)));
    const fresh = list.filter((item) => !index.has(idOf(item)));
    known.sort((a, b) => index.get(idOf(a)) - index.get(idOf(b)));
    for (const item of fresh) frozenIds.push(idOf(item));
    return known.concat(fresh);
  };
  return {
    folders: orderBy(folders, marketplaceOrderFreeze.folders, (folder) => folder.name),
    skills: orderBy(skills, marketplaceOrderFreeze.skills, (skill) => skill.id),
  };
}

function renderMarketplaceSkillsList(skills) {
  const skillsList = document.getElementById("marketplace-skills-list");
  if (!skillsList) return;

  const { folders, rootSkills } = buildMarketplaceFolderModel(
    currentMarketplaceForDetails,
    skills,
  );

  // The placeholder needs the async-loaded catalog (folders come from member
  // grouping, not just the manifest), so it settles here rather than with
  // the page chrome.
  const searchInput = document.getElementById(
    "marketplace-skills-search-input",
  );
  if (searchInput) {
    searchInput.placeholder = folders.length
      ? "Search plugins and skills..."
      : "Search skills...";
  }

  // Search matches plugins too: name-matching folders render as folder cards
  // (with a "N matching" chip when member skills also match), while skills
  // inside NON-matching plugins keep rendering as loose cards with plugin
  // subtitles. The Installed/Available/Has Updates tabs keep the folder
  // hierarchy, narrowed to matching skills.
  if (marketplaceSkillsSearchQuery) {
    const query = marketplaceSkillsSearchQuery;
    const matchesQuery = (value) =>
      String(value || "")
        .toLowerCase()
        .includes(query);
    const filterActive = marketplaceSkillsFilter !== "all";
    const matchingFolders = folders
      .filter(
        (folder) => matchesQuery(folder.name) || matchesQuery(folder.displayName),
      )
      .map((folder) => {
        const tabSkills = filterActive
          ? folder.skills.filter(matchesMarketplaceSkillsFilter)
          : folder.skills;
        // Members the query itself matches — surfaced on the folder card as
        // the "N matching" chip/tooltip instead of duplicate loose cards.
        const searchMatches = tabSkills.filter(
          (skill) =>
            skill.available !== false &&
            (matchesQuery(skill.name) ||
              matchesQuery(skill.displayName) ||
              matchesQuery(skill.description)),
        );
        return {
          ...folder,
          skills: tabSkills,
          installedCount: tabSkills.filter((skill) => skill.installed).length,
          searchMatches,
        };
      })
      .filter((folder) => !filterActive || folder.skills.length > 0);
    const matchedFolderNames = new Set(
      matchingFolders.map((folder) => folder.name),
    );
    const looseSkills = getFilteredMarketplaceSkills(skills).filter(
      (skill) =>
        !skill.pluginName || !matchedFolderNames.has(skill.pluginName),
    );
    const ordered = applyMarketplaceOrderFreeze(matchingFolders, looseSkills);

    if (!matchingFolders.length && !looseSkills.length) {
      skillsList.innerHTML = `
        <div class="mcp-no-results">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="11" cy="11" r="8"></circle>
            <path d="m21 21-4.35-4.35"></path>
          </svg>
          <p>${folders.length ? "No plugins or skills match your search" : "No skills match your search"}</p>
        </div>
      `;
      return;
    }
    // Unlike the overview, search results label EVERY non-empty section —
    // folder-only or skill-only result sets are ambiguous without the header
    // ("are these plugins or skills?").
    skillsList.innerHTML = `
      ${ordered.folders.length ? '<h4 class="marketplace-section-title">Plugins</h4>' : ""}
      ${ordered.folders.map(renderMarketplacePluginFolderCard).join("")}
      ${
        ordered.skills.length
          ? `<h4 class="marketplace-section-title marketplace-root-skills-title">Skills</h4>${ordered.skills
              .map((skill) => renderMarketplaceSkillCard(skill, { showPluginSubtitle: true }))
              .join("")}`
          : ""
      }
    `;
    wireMarketplaceFolderCardHandlers(skillsList);
    wireMarketplaceSkillListHandlers(skillsList);
    return;
  }

  if (marketplaceDetailsView.mode === "plugin") {
    const folder = folders.find(
      (entry) => entry.name === marketplaceDetailsView.pluginName,
    );
    const pluginSkills = applyMarketplaceOrderFreeze(
      [],
      getFilteredMarketplaceSkills(folder?.skills || []),
    ).skills;
    const drillinEmpty =
      marketplaceSkillsFilter !== "all"
        ? "No skills in this plugin match this filter"
        : "No skills in this plugin";
    skillsList.innerHTML = `
      <button class="agent-editor-back-btn marketplace-plugin-back-btn" type="button">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"></path></svg>
        All plugins
      </button>
      <h4 class="marketplace-plugin-drillin-title">${escapeHtml(folder?.displayName || marketplaceDetailsView.pluginName || "")}</h4>
      ${
        pluginSkills.length
          ? pluginSkills.map((skill) => renderMarketplaceSkillCard(skill)).join("")
          : `<div class="mcp-no-results"><p>${drillinEmpty}</p></div>`
      }
    `;
    skillsList
      .querySelector(".marketplace-plugin-back-btn")
      ?.addEventListener("click", () => {
        marketplaceDetailsView = { mode: "all", pluginName: null };
        rerenderCurrentMarketplaceSkills();
      });
    wireMarketplaceSkillListHandlers(skillsList);
    return;
  }

  // Under a non-"all" tab each folder narrows to its matching skills (with
  // the count badges following) and disappears when nothing matches; root
  // skills pass the same predicate. Order stays the model's (most-installed
  // plugins first, alphabetical) — the tabs never re-rank the directory.
  const filterActive = marketplaceSkillsFilter !== "all";
  const visibleFolders = filterActive
    ? folders
        .map((folder) => {
          const matching = folder.skills.filter(matchesMarketplaceSkillsFilter);
          return {
            ...folder,
            skills: matching,
            installedCount: matching.filter((skill) => skill.installed).length,
          };
        })
        .filter((folder) => folder.skills.length > 0)
    : folders;
  const visibleRootSkills = filterActive
    ? rootSkills.filter(matchesMarketplaceSkillsFilter)
    : rootSkills;
  const orderedView = applyMarketplaceOrderFreeze(
    visibleFolders,
    visibleRootSkills,
  );

  if (!visibleFolders.length && !visibleRootSkills.length) {
    skillsList.innerHTML = `
      <div class="mcp-no-results">
        <p>${filterActive ? "No skills match this filter" : "No skills in this marketplace"}</p>
      </div>
    `;
    return;
  }

  // Folder cards are direct grid children (a wrapper div would collapse them
  // all into a single grid cell); section headings span the full grid row.
  skillsList.innerHTML = `
    ${orderedView.folders.length && orderedView.skills.length ? '<h4 class="marketplace-section-title">Plugins</h4>' : ""}
    ${orderedView.folders.map(renderMarketplacePluginFolderCard).join("")}
    ${
      orderedView.skills.length
        ? `${orderedView.folders.length ? '<h4 class="marketplace-section-title marketplace-root-skills-title">Skills</h4>' : ""}${orderedView.skills
            .map((skill) => renderMarketplaceSkillCard(skill))
            .join("")}`
        : ""
    }
  `;

  wireMarketplaceFolderCardHandlers(skillsList);
  wireMarketplaceSkillListHandlers(skillsList);
}

// Folder-card behavior is identical on the overview and in search results:
// card click drills in, footer Install All installs.
function wireMarketplaceFolderCardHandlers(skillsList) {
  skillsList
    .querySelectorAll(".marketplace-plugin-folder-card")
    .forEach((card) => {
      card.addEventListener("click", (event) => {
        // Footer buttons (Install All, the disabled All Installed indicator)
        // act or inert on their own — never a drill-in.
        if (event.target.closest("button")) return;
        // The info icons toggle their tooltips, never a drill-in.
        if (event.target.closest(".info-tooltip-trigger")) return;
        // Kebab wrapper gaps and the body-reparented dropdown are menu
        // territory, never a drill-in (parity with the skill-card handler).
        if (event.target.closest(".mcp-card-menu-wrapper")) return;
        if (event.target.closest(".mcp-card-dropdown")) return;
        if (card.dataset.drillable !== "true") return;
        // Drilling in from search results shows the FULL plugin — the chip
        // already named the matches; a pre-filtered subset (or an empty
        // drill-in when only the plugin NAME matched) would be a dead end.
        if (marketplaceSkillsSearchQuery) {
          marketplaceSkillsSearchQuery = "";
          const searchInput = document.getElementById(
            "marketplace-skills-search-input",
          );
          if (searchInput) searchInput.value = "";
        }
        marketplaceDetailsView = {
          mode: "plugin",
          pluginName: card.dataset.pluginName,
        };
        rerenderCurrentMarketplaceSkills();
      });
    });
  skillsList
    .querySelectorAll(".marketplace-plugin-install-all-btn")
    .forEach((btn) => {
      btn.addEventListener("click", async (event) => {
        event.stopPropagation();
        await installAllPluginSkills(btn.dataset.pluginName, btn);
      });
    });
  skillsList
    .querySelectorAll(".marketplace-plugin-uninstall-all-btn")
    .forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        window.SkillCardRenderer?.closeAllCardMenus?.();
        confirmUninstallAllPluginSkills(btn.dataset.pluginName);
      });
    });
}

// Resolve the full catalog record behind a rendered skill card — the
// read-only details page needs fields (skillSource, localPath, description)
// that never travel through DOM attributes.
function marketplaceSkillRecordFor(skillId, pluginName) {
  const skills = marketplaceSkillsCache.get(currentMarketplaceForDetails?.id) || [];
  return (
    skills.find(
      (skill) =>
        skill.id === skillId &&
        (skill.pluginName || null) === (pluginName || null),
    ) || null
  );
}

// Open the read-only skill details page (agent-skills.js owns the page
// machinery; the hook suspends this page so Back restores it as-is).
function openMarketplaceSkillDetails(skillId, pluginName) {
  if (!currentMarketplaceForDetails) return;
  const record = marketplaceSkillRecordFor(skillId, pluginName);
  if (!record) return;
  if (typeof window.AgentSkillsHooks?.openGitMarketplaceSkillPage !== "function") {
    return;
  }
  window.AgentSkillsHooks.openGitMarketplaceSkillPage({
    marketplaceId: currentMarketplaceForDetails.id,
    marketplaceName:
      currentMarketplaceForDetails.name || currentMarketplaceForDetails.id,
    skillId: record.id,
    pluginName: record.pluginName || null,
    skillPath: record.skillPath,
    skillSource: record.skillSource || null,
    installed: Boolean(record.installed),
    installedVersion: record.installedVersion || null,
    displayName: record.displayName || record.name || record.id,
    description: record.description || "",
  });
}

function wireMarketplaceSkillListHandlers(skillsList) {
  // Card-body click drills into the read-only skill details page. Buttons,
  // footers, tooltips, and (future) menus act on their own.
  skillsList.querySelectorAll(".marketplace-skill-card").forEach((card) => {
    if (card.classList.contains("marketplace-plugin-folder-card")) return;
    card.addEventListener("click", (event) => {
      if (
        event.target.closest("button") ||
        event.target.closest(".skill-card-actions") ||
        event.target.closest(".info-tooltip-trigger") ||
        event.target.closest(".mcp-card-menu-wrapper") ||
        event.target.closest(".mcp-card-dropdown")
      ) {
        return;
      }
      openMarketplaceSkillDetails(
        card.dataset.skillId,
        card.dataset.pluginName || null,
      );
    });
  });

  skillsList
    .querySelectorAll(".marketplace-skill-install-btn")
    .forEach((btn) => {
      btn.addEventListener("click", async () => {
        const skillId = btn.dataset.skillId;
        const skillPath = btn.dataset.skillPath;
        const skillSource = decodeSkillSource(btn.dataset.skillSource);
        await installSkill(skillId, skillPath, skillSource, btn.dataset.pluginName || null);
      });
    });

  skillsList
    .querySelectorAll(".marketplace-skill-update-btn")
    .forEach((btn) => {
      btn.addEventListener("click", async () => {
        const skillId = btn.dataset.skillId;
        await updateSkill(skillId, btn.dataset.pluginName || null);
      });
    });

  skillsList
    .querySelectorAll(".marketplace-skill-discard-btn")
    .forEach((btn) => {
      btn.addEventListener("click", async () => {
        const skillId = btn.dataset.skillId;
        await discardSkillChanges(skillId, btn.dataset.pluginName || null);
      });
    });

  skillsList
    .querySelectorAll(".marketplace-skill-detach-btn")
    .forEach((btn) => {
      btn.addEventListener("click", async () => {
        const skillId = btn.dataset.skillId;
        await detachSkillToUserCopy(skillId, btn.dataset.pluginName || null);
      });
    });

  // Kebab menu items mirror the footer/card actions; the shared trigger
  // open/close behavior comes from SkillCardRenderer.attachCardMenus.
  const closeCardMenus = () =>
    window.SkillCardRenderer?.closeAllCardMenus?.();
  skillsList
    .querySelectorAll(".marketplace-skill-menu-details-btn")
    .forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        closeCardMenus();
        openMarketplaceSkillDetails(
          btn.dataset.skillId,
          btn.dataset.pluginName || null,
        );
      });
    });
  skillsList
    .querySelectorAll(".marketplace-skill-menu-install-btn")
    .forEach((btn) => {
      btn.addEventListener("click", async (event) => {
        event.stopPropagation();
        closeCardMenus();
        await installSkill(
          btn.dataset.skillId,
          btn.dataset.skillPath,
          decodeSkillSource(btn.dataset.skillSource),
          btn.dataset.pluginName || null,
        );
      });
    });
  skillsList
    .querySelectorAll(".marketplace-skill-menu-update-btn")
    .forEach((btn) => {
      btn.addEventListener("click", async (event) => {
        event.stopPropagation();
        closeCardMenus();
        await updateSkill(btn.dataset.skillId, btn.dataset.pluginName || null);
      });
    });
  skillsList
    .querySelectorAll(".marketplace-skill-menu-uninstall-btn")
    .forEach((btn) => {
      btn.addEventListener("click", (event) => {
        // Blocked: inert, but still stopPropagation — mcp-servers.js wires an
        // UNCONDITIONAL document-level closeAllDropdowns, so a bubbled click
        // would slam the menu shut. Hover/focus own the explanation tooltip.
        if (btn.getAttribute?.("aria-disabled") === "true") {
          event.stopPropagation();
          return;
        }
        event.stopPropagation();
        closeCardMenus();
        confirmUninstallSkill(
          btn.dataset.skillId,
          btn.dataset.pluginName || null,
        );
      });
    });
  if (typeof window.SkillCardRenderer?.attachCardMenus === "function") {
    window.SkillCardRenderer.attachCardMenus(skillsList);
  }
}

/**
 * Sequentially install every not-yet-installed available skill of a plugin,
 * accumulating errors instead of stopping at the first failure.
 */
async function installAllPluginSkills(pluginName, btn) {
  if (!currentMarketplaceForDetails || !pluginName) return;
  const skills = marketplaceSkillsCache.get(currentMarketplaceForDetails.id) || [];
  const memberSkills = skills.filter(
    (skill) => skill.pluginName === pluginName,
  );
  const targets = memberSkills.filter(
    (skill) => !skill.installed && skill.available !== false,
  );
  if (!targets.length) return;

  // Progress counts plugin COMPLETION ("10/12"), matching the card's "12
  // skills" chip — already-installed members seed the numerator instead of
  // shrinking the denominator to just this run's remainder.
  const totalCount = memberSkills.length;
  const preInstalledCount = memberSkills.filter((skill) => skill.installed).length;

  if (btn) btn.disabled = true;
  const failures = [];
  let installedCount = 0;
  for (const [index, skill] of targets.entries()) {
    if (btn) btn.textContent = `Installing ${preInstalledCount + index + 1}/${totalCount}…`;
    try {
      const result = await window.electronAPI.installMarketplaceSkill(
        currentMarketplaceForDetails.id,
        skill.id,
        skill.skillPath,
        skill.skillSource,
        pluginName,
      );
      if (!result?.success) {
        throw new Error(result?.error || "Install failed");
      }
      installedCount += 1;
    } catch (error) {
      failures.push(`${skill.id}: ${error.message}`);
    }
  }
  if (btn) {
    btn.disabled = false;
    btn.textContent = "Install All";
  }

  if (failures.length) {
    showMarketplacesNotification(
      `Installed ${installedCount} of ${targets.length} skills from "${pluginName}". Failed: ${failures.join("; ")}`,
      "error",
    );
  } else {
    showMarketplacesNotification(
      `Installed ${installedCount} skill${installedCount === 1 ? "" : "s"} from "${pluginName}"`,
      "success",
    );
  }
  await refreshMarketplaceSurfaces();
}

/**
 * Render a single skill card in the marketplace details modal
 */
function renderMarketplaceSkillCard(skill, { showPluginSubtitle = false } = {}) {
  let actionButton;
  let warningHtml = "";
  const pluginAttr = skill.pluginName
    ? ` data-plugin-name="${escapeHtml(skill.pluginName)}"`
    : "";
  const unavailable = skill.available === false;
  // Agent references grey Uninstall (footer + kebab) with the explanation
  // tooltip. Computed at render time from the same map the badges read, so
  // the usage-arrival repaint converges both. Fail-open on empty map — the
  // main-process guard remains the backstop.
  const usedByAgents = marketplaceAgentUsage.get(skill.id) || [];
  const blockedDeco =
    typeof window.SkillCardRenderer?.agentsBlockedDecoration === "function"
      ? window.SkillCardRenderer.agentsBlockedDecoration(usedByAgents)
      : { blocked: false, attrs: "", triggerClass: "" };

  if (unavailable) {
    // External / degraded plugin sources render but never install.
    actionButton = "";
  } else if (skill.installed && skill.hasConflict) {
    actionButton = `
      <button class="btn-primary marketplace-skill-discard-btn" data-skill-id="${skill.id}"${pluginAttr}>
        Discard Local Changes and Sync
      </button>
      <button class="btn-secondary marketplace-skill-detach-btn" data-skill-id="${skill.id}"${pluginAttr}>
        Detach to User Skill
      </button>
    `;
    warningHtml = `
      <p class="marketplace-skill-warning marketplace-skill-warning-conflict">
        Local edits conflict with an available marketplace update. Discard to sync the managed copy, or detach your version into a user skill before updating.
      </p>
    `;
  } else if (skill.installed && skill.hasUpdate) {
    actionButton = `
      <button class="btn-primary marketplace-skill-update-btn" data-skill-id="${skill.id}"${pluginAttr}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
        Update
      </button>
    `;
  } else if (skill.installed && skill.seeded) {
    // Built-in bundle seed: the service refuses uninstall/detach (the seeder
    // restores them next load), so the card must not present a green
    // "Installed" that implies removability.
    actionButton = `
      <button class="btn-secondary marketplace-skill-builtin-btn" type="button" disabled title="Ships with the app — cannot be uninstalled. Use Copy to create an editable user copy.">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="7" width="18" height="13" rx="2"></rect><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
        Built-in
      </button>
    `;
  } else if (skill.installed) {
    // Discover-tab parity: installed shows the green state button; the
    // destructive Uninstall lives only in the kebab menu (agent-blocking
    // decoration included there).
    actionButton = `
      <button class="btn-primary btn-all-installed marketplace-skill-installed-btn" type="button" disabled>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>
        Installed
      </button>
    `;
  } else {
    // Same face as the Discover tab's install action: plain primary button.
    actionButton = `
      <button class="btn-primary marketplace-skill-install-btn" data-skill-id="${skill.id}" data-skill-path="${skill.skillPath}" data-skill-source="${encodeSkillSource(skill.skillSource)}"${pluginAttr}>
        Install Skill
      </button>
    `;
  }

  if (!unavailable && !warningHtml && skill.installed && skill.isDirty && !skill.seeded) {
    actionButton = `
      <button class="btn-primary btn-all-installed marketplace-skill-installed-btn" type="button" disabled>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>
        Installed
      </button>
      <button class="btn-secondary marketplace-skill-detach-btn" data-skill-id="${skill.id}"${pluginAttr}>
        Detach to User Skill
      </button>
    `;
    warningHtml = `
      <p class="marketplace-skill-warning">
        This installed marketplace skill has local edits. A future update will require you to discard those changes or detach the skill first.
      </p>
    `;
  }

  const badges = [];
  if (unavailable) {
    badges.push(
      `<span class="mcp-card-badge badge-external" title="This plugin lives in a repository outside the approved marketplace sources and cannot be installed from here">EXTERNAL</span>`,
    );
  }
  if (skill.installed) {
    badges.push(
      `<span class="mcp-card-badge badge-installed">INSTALLED</span>`,
    );
  }
  if (skill.installed && skill.seeded) {
    badges.push(
      `<span class="mcp-card-badge badge-builtin" title="Ships with the app — cannot be uninstalled">BUILT-IN</span>`,
    );
  }
  if (skill.hasUpdate) {
    badges.push(`<span class="mcp-card-badge badge-has-updates">UPDATE</span>`);
  }
  if (skill.hasConflict) {
    badges.push(`<span class="mcp-card-badge badge-conflict">CONFLICT</span>`);
  }
  if (skill.isDirty) {
    badges.push(`<span class="mcp-card-badge badge-dirty">DIRTY</span>`);
  }

  // Plugin provenance renders as the app-wide plugin badge (same chip as the
  // Agent Skills cards and the skill detail page), not a subtitle line.
  if (showPluginSubtitle && skill.pluginName) {
    const shared = window.SkillCardRenderer?.skillCardPluginBadgeHtml;
    if (typeof shared === "function") {
      badges.push(shared(skill.pluginName));
    } else {
      const pluginLabel = formatPluginDisplayName(skill.pluginName);
      badges.push(
        `<span class="mcp-card-badge badge-plugin" title="${escapeHtml(`From plugin ${pluginLabel}`)}">${escapeHtml(pluginLabel)}</span>`,
      );
    }
  }

  // Kebab menu (UX parity with the local skill tabs): View Details always,
  // then the contextual lifecycle action. Discard/Detach stay footer-only —
  // conflict resolution should be a deliberate, visible choice.
  const menuItems = [
    `<button class="mcp-dropdown-item marketplace-skill-menu-details-btn" data-skill-id="${skill.id}"${pluginAttr}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
        <circle cx="12" cy="12" r="3"></circle>
      </svg>
      View Details
    </button>`,
  ];
  if (!unavailable && !skill.installed) {
    menuItems.push(
      `<button class="mcp-dropdown-item marketplace-skill-menu-install-btn" data-skill-id="${skill.id}" data-skill-path="${skill.skillPath}" data-skill-source="${encodeSkillSource(skill.skillSource)}"${pluginAttr}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
        <polyline points="7 10 12 15 17 10"></polyline>
        <line x1="12" y1="15" x2="12" y2="3"></line>
      </svg>
      Install Skill
    </button>`,
    );
  }
  if (!unavailable && skill.installed && skill.hasUpdate && !skill.hasConflict) {
    menuItems.push(
      `<button class="mcp-dropdown-item marketplace-skill-menu-update-btn" data-skill-id="${skill.id}"${pluginAttr}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
        <polyline points="7 10 12 15 17 10"></polyline>
        <line x1="12" y1="15" x2="12" y2="3"></line>
      </svg>
      Update
    </button>`,
    );
  }
  if (!unavailable && skill.installed && skill.seeded) {
    menuItems.push(
      `<button class="mcp-dropdown-item marketplace-skill-menu-builtin-btn" aria-disabled="true" title="Built-in default — ships with the app and cannot be uninstalled. Use Copy to create an editable user copy.">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="7" width="18" height="13" rx="2"></rect>
        <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
      </svg>
      Built-in — ships with the app
    </button>`,
    );
  }
  if (!unavailable && skill.installed && !skill.seeded) {
    menuItems.push(
      `<button class="mcp-dropdown-item marketplace-skill-menu-uninstall-btn delete-action${blockedDeco.triggerClass}" data-skill-id="${skill.id}"${pluginAttr}${blockedDeco.attrs}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="3 6 5 6 21 6"></polyline>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
      </svg>
      Uninstall
    </button>`,
    );
  }
  const menuWrapper = `
      <div class="mcp-card-menu-wrapper">
        <button class="mcp-card-menu-trigger" data-menu-skill-id="${skill.id}"${pluginAttr} aria-label="Skill options">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="5" r="2"></circle>
            <circle cx="12" cy="12" r="2"></circle>
            <circle cx="12" cy="19" r="2"></circle>
          </svg>
        </button>
        <div class="mcp-card-dropdown" data-dropdown-skill-id="${skill.id}">${menuItems.join("")}</div>
      </div>`;

  // "Used by N agents" — own line under the other badges; catalog ids are
  // bare leaf names, the same key the usage map folds to (usedByAgents is
  // hoisted above so the blocked decoration reads the identical list).
  const agentNames = usedByAgents
    .map((agent) => String(agent?.name || "").trim())
    .filter(Boolean);
  // Badge chip + info icon are ONE hover surface (see infoListTriggerHtml).
  const agentsBadgeRow = agentNames.length
    ? `<div class="marketplace-skill-badges skill-agents-badges">${infoListTriggerHtml(
        {
          title: `Used by ${agentNames.length} agent${agentNames.length === 1 ? "" : "s"}`,
          items: agentNames,
          icon: "agent",
        },
        `Used by: ${agentNames.join(", ")}`,
        `<span class="mcp-card-badge badge-agents">${agentNames.length} AGENT${agentNames.length === 1 ? "" : "S"}</span>`,
      )}</div>`
    : "";

  // Actions live in a bottom footer strip (divider + compact buttons), the
  // exact Discover-card pattern; actionless (external) cards get no footer.
  return `
    <div class="marketplace-skill-card" data-skill-id="${skill.id}"${pluginAttr}>
      ${menuWrapper}
      <div class="marketplace-skill-main">
        <div class="marketplace-skill-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
            <path d="M2 17l10 5 10-5"></path>
            <path d="M2 12l10 5 10-5"></path>
          </svg>
        </div>
        <div class="marketplace-skill-info">
          <h4 class="marketplace-skill-name">${escapeHtml(skill.displayName)}</h4>
          <p class="marketplace-skill-description">${escapeHtml(truncateText(skill.description || "No description", 100))}</p>
          <div class="marketplace-skill-badges">
            ${badges.join("")}
          </div>
          ${agentsBadgeRow}
          ${warningHtml}
        </div>
      </div>
      ${actionButton.trim() ? `<div class="mcp-card-footer skill-card-actions">${actionButton}</div>` : ""}
    </div>
  `;
}

/**
 * Initialize marketplace details modal
 */
/**
 * Re-render the details page skill list for whichever marketplace is open.
 */
function rerenderCurrentMarketplaceSkills() {
  const skills =
    marketplaceSkillsCache.get(currentMarketplaceForDetails?.id) || [];
  renderMarketplaceSkillsList(skills);
}

async function refreshCurrentMarketplaceDetails() {
  if (!currentMarketplaceForDetails) return;

  // Skills and agent usage refresh together so the single repaint below
  // carries both (one usage IPC per action-refresh cycle).
  const [result] = await Promise.all([
    window.electronAPI.getMarketplaceSkills(currentMarketplaceForDetails.id),
    refreshMarketplaceAgentUsage(marketplacePageGeneration),
  ]);
  if (!result.success) {
    throw new Error(result.error || "Failed to refresh marketplace skills");
  }

  currentMarketplaceForDetails = result.marketplace || currentMarketplaceForDetails;
  marketplaceSkillsCache.set(currentMarketplaceForDetails.id, result.skills);
  updateMarketplaceDetailsHeader(currentMarketplaceForDetails);
  renderMarketplaceSkillsList(result.skills);
}

async function refreshMarketplaceSurfaces() {
  await refreshCurrentMarketplaceDetails();
  await loadMarketplaces();

  if (typeof loadSkills === "function") {
    loadSkills();
  }
}

// =============================================================================
// SKILL ACTIONS
// =============================================================================

/**
 * Install a skill from the current marketplace
 */
async function installSkill(skillId, skillPath, skillSource, pluginName = null) {
  if (!currentMarketplaceForDetails) return;

  const btn = document.querySelector(
    `.marketplace-skill-install-btn[data-skill-id="${skillId}"]`,
  );
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<div class="btn-spinner"></div> Installing...`;
  }

  try {
    const result = await window.electronAPI.installMarketplaceSkill(
      currentMarketplaceForDetails.id,
      skillId,
      skillPath,
      skillSource,
      pluginName,
    );

    if (!result.success) {
      throw new Error(result.error);
    }

    showMarketplacesNotification(`Skill "${skillId}" installed successfully`, "success");
    // The page stays open: the surface refresh re-renders this grid in place
    // with the INSTALLED state (no tab flip underneath the inline page).
    await refreshMarketplaceSurfaces();
  } catch (error) {
    console.error(`[Marketplaces] Failed to install skill ${skillId}:`, error);
    showMarketplacesNotification(`Failed to install skill: ${error.message}`, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = "Install Skill";
    }
  }
}

// Destructive-action gate: the drill-in kebab routes through the SAME
// confirm modal (title/message wording included) as the Installed-facet and
// Discover uninstall surfaces (agent-skills.js confirmUninstallMarketplaceSkill)
// before the existing uninstall + grid refresh runs. Cancel is a no-op.
function confirmUninstallSkill(skillId, pluginName = null) {
  if (!currentMarketplaceForDetails) return;
  const record = marketplaceSkillRecordFor(skillId, pluginName);
  const displayName = record?.displayName || record?.name || skillId;
  const marketplaceLabel =
    currentMarketplaceForDetails.name || currentMarketplaceForDetails.id;
  if (typeof window.showAgentsConfirmModal === "function") {
    window.showAgentsConfirmModal({
      title: "Uninstall skill?",
      message: `Uninstall "${displayName}" (installed from ${marketplaceLabel})? You can reinstall it from the marketplace anytime.`,
      confirmLabel: "Uninstall",
      confirmBusyLabel: "Uninstalling...",
      danger: true,
      // Returning the promise keeps the modal's busy spinner up for the
      // duration; uninstallSkill surfaces its own failures via notification.
      onConfirm: () => uninstallSkill(skillId, pluginName),
    });
  } else if (window.confirm(`Uninstall "${displayName}"?`)) {
    void uninstallSkill(skillId, pluginName);
  }
}

// Bulk counterpart to Install All: uninstall every cleanly-installed member
// of a plugin. Skills with local edits (dirty/conflict) or agent references
// are pre-classified and KEPT (the Updates-tab bulk convention) — the modal
// and the summary toast both say so. Members come from the full catalog
// cache, never the filter-tab-narrowed folder model.
function confirmUninstallAllPluginSkills(pluginName) {
  if (!currentMarketplaceForDetails || !pluginName) return;
  const skills =
    marketplaceSkillsCache.get(currentMarketplaceForDetails.id) || [];
  const installedMembers = skills.filter(
    (skill) => skill.pluginName === pluginName && skill.installed,
  );
  if (!installedMembers.length) return;

  const keptDirty = installedMembers.filter(
    (skill) => skill.isDirty || skill.hasConflict,
  );
  const keptAgents = installedMembers.filter(
    (skill) =>
      !keptDirty.includes(skill) &&
      (marketplaceAgentUsage.get(skill.id) || []).length > 0,
  );
  const targets = installedMembers.filter(
    (skill) => !keptDirty.includes(skill) && !keptAgents.includes(skill),
  );

  const keptParts = [];
  if (keptDirty.length) {
    keptParts.push(
      `${keptDirty.length} with local edits will be kept`,
    );
  }
  if (keptAgents.length) {
    keptParts.push(
      `${keptAgents.length} used by agents will be kept`,
    );
  }

  if (!targets.length) {
    showMarketplacesNotification(
      `Nothing to uninstall from "${pluginName}": ${keptParts.join("; ") || "no removable skills"}.`,
      "info",
    );
    return;
  }

  const keptSuffix = keptParts.length ? ` ${keptParts.join("; ")}.` : "";
  if (typeof window.showAgentsConfirmModal === "function") {
    window.showAgentsConfirmModal({
      title: "Uninstall all plugin skills?",
      message: `Uninstall ${targets.length} skill${targets.length === 1 ? "" : "s"} installed from "${pluginName}"?${keptSuffix} You can reinstall them from the marketplace anytime.`,
      confirmLabel: "Uninstall All",
      confirmBusyLabel: "Uninstalling…",
      danger: true,
      // Returning the promise keeps the modal's busy spinner up while the
      // whole sequential loop runs.
      onConfirm: () =>
        uninstallAllPluginSkills(pluginName, {
          targets,
          keptDirty: keptDirty.length,
          keptAgents: keptAgents.length,
        }),
    });
  } else if (
    window.confirm(
      `Uninstall ${targets.length} skill(s) installed from "${pluginName}"?`,
    )
  ) {
    void uninstallAllPluginSkills(pluginName, {
      targets,
      keptDirty: keptDirty.length,
      keptAgents: keptAgents.length,
    });
  }
}

async function uninstallAllPluginSkills(
  pluginName,
  { targets, keptDirty = 0, keptAgents = 0 },
) {
  if (!currentMarketplaceForDetails || !targets?.length) return;

  const failures = [];
  let keptBuiltIn = 0;
  let keptAgentsRuntime = 0;
  let removedCount = 0;
  for (const skill of targets) {
    try {
      const result = await window.electronAPI.uninstallMarketplaceSkill(
        currentMarketplaceForDetails.id,
        skill.id,
        skill.pluginName || pluginName,
      );
      if (result?.success) {
        removedCount += 1;
      } else if (result?.errorCode === "ootb_skill_immutable") {
        keptBuiltIn += 1;
      } else if (result?.errorCode === "skill_in_use_by_agents") {
        // The fail-closed main-process guard caught a reference the renderer
        // map missed — treat like the pre-classified keeps.
        keptAgentsRuntime += 1;
      } else {
        failures.push(`${skill.id}: ${result?.error || "Uninstall failed"}`);
      }
    } catch (error) {
      failures.push(`${skill.id}: ${error.message}`);
    }
  }

  const parts = [
    `Uninstalled ${removedCount} skill${removedCount === 1 ? "" : "s"} from "${pluginName}"`,
  ];
  if (keptDirty) parts.push(`kept ${keptDirty} with local edits`);
  const totalKeptAgents = keptAgents + keptAgentsRuntime;
  if (totalKeptAgents) parts.push(`kept ${totalKeptAgents} used by agents`);
  if (keptBuiltIn) parts.push(`kept ${keptBuiltIn} built-in`);
  if (failures.length) parts.push(`failed: ${failures.join("; ")}`);
  showMarketplacesNotification(
    `${parts.join("; ")}.`,
    failures.length ? "error" : "success",
  );
  await refreshMarketplaceSurfaces();
}

/**
 * Uninstall a skill
 */
async function uninstallSkill(skillId, pluginName = null) {
  // Fires from the kebab menu (the menu closes on click); success re-renders
  // the whole grid, so there is no in-place button to spin.
  if (!currentMarketplaceForDetails) return;

  try {
    const result = await window.electronAPI.uninstallMarketplaceSkill(
      currentMarketplaceForDetails.id,
      skillId,
      pluginName,
    );

    if (!result.success) {
      if (result.errorCode === "skill_in_use_by_agents") {
        // Referential integrity: explain which agents still use the skill.
        if (typeof window.showSkillInUseByAgentsModal === "function") {
          window.showSkillInUseByAgentsModal({
            message: result.error,
            agents: result.body?.agents || [],
          });
        } else {
          showMarketplacesNotification(result.error, "error");
        }
        return;
      }
      throw new Error(result.error);
    }

    showMarketplacesNotification(`Skill "${skillId}" uninstalled`, "success");
    await refreshMarketplaceSurfaces();
  } catch (error) {
    console.error(
      `[Marketplaces] Failed to uninstall skill ${skillId}:`,
      error,
    );
    showMarketplacesNotification(`Failed to uninstall skill: ${error.message}`, "error");
  }
}

/**
 * Update a skill to the latest version
 */
async function updateSkill(skillId, pluginName = null) {
  return await updateSkillWithOptions(skillId, { pluginName });
}

async function discardSkillChanges(skillId, pluginName = null) {
  return await updateSkillWithOptions(skillId, {
    pluginName,
    forceDiscardLocalChanges: true,
    successMessage: `Local changes discarded and "${skillId}" synced`,
  });
}

async function updateSkillWithOptions(skillId, options = {}) {
  if (!currentMarketplaceForDetails) return;

  const btn = document.querySelector(
    `.marketplace-skill-update-btn[data-skill-id="${skillId}"], .marketplace-skill-discard-btn[data-skill-id="${skillId}"]`,
  );
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<div class="btn-spinner"></div> Syncing...`;
  }

  try {
    const result = await window.electronAPI.updateMarketplaceSkill(
      currentMarketplaceForDetails.id,
      skillId,
      {
        forceDiscardLocalChanges: Boolean(options.forceDiscardLocalChanges),
        pluginName: options.pluginName || null,
      },
    );

    if (!result.success) {
      throw new Error(result.error);
    }

    showMarketplacesNotification(
      options.successMessage || `Skill "${skillId}" updated to v${result.version}`,
      "success",
    );
    await refreshMarketplaceSurfaces();
  } catch (error) {
    console.error(`[Marketplaces] Failed to update skill ${skillId}:`, error);
    showMarketplacesNotification(`Failed to update skill: ${error.message}`, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      if (btn.classList.contains("marketplace-skill-discard-btn")) {
        btn.textContent = "Discard Local Changes and Sync";
      } else {
        btn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="7 10 12 15 17 10"></polyline>
            <line x1="12" y1="15" x2="12" y2="3"></line>
          </svg>
          Update
        `;
      }
    }
  }
}

async function detachSkillToUserCopy(skillId, pluginName = null) {
  if (!currentMarketplaceForDetails) return;

  const btn = document.querySelector(
    `.marketplace-skill-detach-btn[data-skill-id="${skillId}"]`,
  );
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<div class="btn-spinner"></div> Detaching...`;
  }

  try {
    const result = await window.electronAPI.detachMarketplaceSkillToUserSkill(
      currentMarketplaceForDetails.id,
      skillId,
      null,
      pluginName,
    );

    if (!result.success) {
      throw new Error(result.error || "Detach failed");
    }

    showMarketplacesNotification(
      `Detached "${skillId}" to user skill "${result.skillName}"`,
      "success",
    );
    await refreshMarketplaceSurfaces();
  } catch (error) {
    console.error(`[Marketplaces] Failed to detach skill ${skillId}:`, error);
    showMarketplacesNotification(`Failed to detach skill: ${error.message}`, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Detach to User Skill";
    }
  }
}

// =============================================================================
// UPDATE INDICATOR
// =============================================================================

/**
 * Update the update indicator on the Marketplaces tab
 */
function updateUpdateIndicator() {
  const indicator = document.getElementById("marketplaces-update-indicator");
  if (!indicator) return;

  hasAvailableUpdates = marketplacesData.some((m) => m.hasUpdates);
  indicator.style.display = hasAvailableUpdates ? "" : "none";
}

// =============================================================================
// UTILITIES
// =============================================================================

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
  if (!text) return "";
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Truncate text to a maximum length
 */
function truncateText(text, maxLength) {
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength).trim() + "...";
}

/**
 * Format a relative time string
 */
function formatRelativeTime(date) {
  const now = new Date();
  const diff = now - date;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days} day${days > 1 ? "s" : ""} ago`;
  if (hours > 0) return `${hours} hour${hours > 1 ? "s" : ""} ago`;
  if (minutes > 0) return `${minutes} minute${minutes > 1 ? "s" : ""} ago`;
  return "Just now";
}

/**
 * Show a notification toast via the app-wide implementation (control-plane's
 * window.showNotification). Deliberately NOT named showNotification: a
 * top-level declaration with that name replaces the global binding for every
 * later classic script, which is how app toasts once vanished entirely.
 */
function showMarketplacesNotification(message, type = "info") {
  if (typeof window.showNotification === "function") {
    window.showNotification(message, type);
    return;
  }

  // Fallback: console log
  console.log(`[Marketplaces] ${type.toUpperCase()}: ${message}`);
}

// =============================================================================
// INITIALIZATION
// =============================================================================

/**
 * Initialize the marketplaces component
 */
function initMarketplaces() {
  console.log("[Marketplaces] Initializing...");

  initMarketplacesHeaderActions();
  initAddMarketplaceModal();
  initRemoveMarketplaceModal();

  console.log("[Marketplaces] Initialized");
}

// Initialize when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initMarketplaces);
} else {
  initMarketplaces();
}

// =============================================================================
// EXPORTS
// =============================================================================

window.loadMarketplaces = loadMarketplaces;
window.openAddMarketplaceModal = openAddMarketplaceModal;
window.closeAddMarketplaceModal = closeAddMarketplaceModal;
window.openMarketplaceDetailsPage = openMarketplaceDetailsPage;
window.closeMarketplaceDetailsPage = closeMarketplaceDetailsPage;
window.isMarketplaceDetailsPageOpen = isMarketplaceDetailsPageOpen;
window.suspendMarketplaceDetailsPage = suspendMarketplaceDetailsPage;
window.resumeMarketplaceDetailsPage = resumeMarketplaceDetailsPage;
window.refreshMarketplaceSurfaces = refreshMarketplaceSurfaces;
// Compatibility aliases: the details modal was replaced by the inline page.
window.openMarketplaceDetailsModal = openMarketplaceDetailsPage;
window.closeMarketplaceDetailsModal = closeMarketplaceDetailsPage;
window.checkForMarketplaceUpdates = checkForMarketplaceUpdates;
// Render seams for the vm-harness unit tests (built-in gating + the shared
// installed/parked counting rule).
window.MarketplaceRenderHooks = {
  renderMarketplaceSkillCard,
  buildMarketplaceBadges,
  withCatalogDerivedBadgeCounts,
  setMarketplaceSkillsCacheForTests: (marketplaceId, skills) => {
    marketplaceSkillsCache.set(marketplaceId, skills);
  },
};
