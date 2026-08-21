// Agent Skills component - Control Plane V2
// Card-based UI for viewing and managing Agent Skills

// Import marked for markdown rendering
import { marked } from "marked";
// Skill-name validation for the Duplicate flow (bundled by esbuild). Keeps the
// renderer's uniqueness check in sync with the directory the main process
// creates.
import {
  validateSkillName,
  sanitizeSkillDirectoryName,
} from "../../services/skill-name-validation.js";
import {
  canonicalSkillName,
  marketplaceSolutionIdForSkill,
  normalizeOwnerIdentity,
  skillMatchesFilter,
} from "../../services/agent-skills-filtering.js";

// Configure marked
marked.setOptions({ breaks: true, gfm: true });

// Search and filter state for Skills
const SKILLS_MARKETPLACES_BROWSE_FILTER = "marketplaces-browse";
const SKILLS_DISCOVER_FILTER = "discover";
// Page-skill source marker for a REMOTE marketplace listing (no local copy).
// Distinct from "marketplace" (an installed local copy) so the page chrome,
// edit gates, and action sets branch correctly.
const SKILLS_DISCOVER_LISTING_SOURCE = "marketplace-listing";
// Page-skill source marker for a GIT-marketplace skill opened from a
// marketplace details page (installed or not). Content renders read-only
// from a materialized bundle; Back resumes the suspended details page.
const GIT_MARKETPLACE_LISTING_SOURCE = "git-marketplace-listing";
// Attempt TTL for the Discover listings cache — refreshes only from
// user-triggered paths (tab click, subview re-entry, Retry); no timers.
const SKILLS_DISCOVER_TTL_MS = 60_000;
let skillsSearchQuery = "";
let skillsActiveFilter = "user";
// leaf skill name -> [{ id, name }] of locally installed agents referencing
// it (the "used by N agents" badges). Refreshed once per loadSkills cycle;
// empty on any failure (badges are strictly fail-open decoration).
let skillsAgentUsage = new Map();
// Inline Discover tab: Solutions Marketplace skill listings.
let skillsDiscoverState = {
  solutions: null,
  fetchedAt: 0,
  promise: null,
  error: null,
};
let skillsData = [];
let skillsDefaultLogo = null;
let skillsSearchFilterInitialized = false;
let skillsLoading = false;
let skillsRefreshQueued = false;
let skillsViewerIdentity = "";
let skillsViewerIdentityPromise = null;

// Inline skill page state (file tree + tabbed viewer/editor)
let currentSkillForDetails = null;
let skillDetailsTabs = []; // { id, name, path, content, type, editing?, draft? }
let activeSkillTabId = null;
let skillPage = null; // { skill } while the inline page is open
// canonicalSkillName -> { solutionId, publishedAt, lastUpdatedAt, hasLocalChanges }
let skillsMarketplaceLinks = {};
// Exact solution ids returned by the ownership-authoritative
// list_published_skills operation. Local links and creator metadata are never
// sufficient to classify a solution as viewer-owned.
let skillsPublishedSolutionIds = new Set();

// Structured, content-free marketplace diagnostics for the Skills tab —
// mirrors agents.js logMarketplacePublish (the "[Agents][Marketplace" prefix
// routes metas through the main-side content belt into the app log).
function logSkillsMarketplace(eventName, meta = {}) {
  const payload = { event: eventName, ...meta, at: new Date().toISOString() };
  console.log("[Agents][MarketplaceSkills]", payload);
  try {
    window.electronAPI?.logToMain?.({
      level: "info",
      message: `[Agents][MarketplaceSkills] ${eventName}`,
      meta: payload,
    });
  } catch {}
}

async function loadPublishedSkillSolutionIds() {
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
  } catch (error) {
    console.warn(
      "[Agent Skills] Failed to load viewer-owned Marketplace skills",
      error,
    );
    return new Set();
  }
}

function rawSkillMarketplaceLink(skill) {
  if (skill?.source === "marketplace") return null;
  return skillsMarketplaceLinks[canonicalSkillName(skill?.name)] || null;
}

function authoritativeSkillMarketplaceLink(skill) {
  const solutionId = marketplaceSolutionIdForSkill(
    skill,
    skillsMarketplaceLinks,
  );
  if (!solutionId || !skillsPublishedSolutionIds.has(solutionId)) return null;
  const rawLink = rawSkillMarketplaceLink(skill);
  return {
    ...(rawLink || {}),
    solutionId,
    relationship:
      skill?.source === "marketplace" ? "installed" : "published",
  };
}

function skillHasUnverifiedMarketplaceLink(skill) {
  const rawLink = rawSkillMarketplaceLink(skill);
  return Boolean(
    rawLink?.solutionId && !authoritativeSkillMarketplaceLink(skill),
  );
}

function applySkillDisplayAcronyms(displayName) {
  return String(displayName || "").replace(/\b(Lm|Mcp|Api|Url|Ui|Ai|Id)\b/g, (match) =>
    match.toUpperCase(),
  );
}

function getSkillDisplayName(skill) {
  const raw = String(skill?.display_name || skill?.name || "").trim();
  if (!raw) return "";

  const formatted = raw
    .replace(/[-_/]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");

  return applySkillDisplayAcronyms(formatted);
}

function normalizeCreatorLdap(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  const at = normalized.indexOf("@");
  return at === -1 ? normalized : normalized.slice(0, at).trim();
}

// Blocked-delete decoration for controls whose skill is referenced by agents
// (greyed + agents tooltip). Absent helper (bundle skew) degrades to active
// controls — the main-process guard still blocks the mutation itself.
const AGENTS_BLOCKED_NONE = { blocked: false, attrs: "", triggerClass: "" };
function agentsBlockedDeco(usedByAgents) {
  return typeof window.SkillCardRenderer?.agentsBlockedDecoration === "function"
    ? window.SkillCardRenderer.agentsBlockedDecoration(usedByAgents)
    : AGENTS_BLOCKED_NONE;
}

async function resolveCurrentSkillsViewerIdentity() {
  try {
    const user = await window.electronAPI?.currentUser?.get?.();
    const identity = normalizeOwnerIdentity(
      user?.sessionSummary?.user?.email ||
        user?.email ||
        user?.claims?.email ||
        "",
    );
    if (identity) return identity;
  } catch (error) {
    console.warn("[Agent Skills] Failed to resolve current user identity", error);
  }

  try {
    const usernameRes = await window.electronAPI?.getUsername?.();
    return normalizeOwnerIdentity(usernameRes?.username || "");
  } catch (_error) {
    return "";
  }
}

function ensureSkillsViewerIdentity() {
  if (!skillsViewerIdentityPromise) {
    skillsViewerIdentityPromise = resolveCurrentSkillsViewerIdentity().then(
      (identity) => {
        skillsViewerIdentity = identity || "";
        if (!identity) skillsViewerIdentityPromise = null;
        return skillsViewerIdentity;
      },
    );
  }
  return skillsViewerIdentityPromise;
}

// Skill details divider drag state
let skillDividerDragState = {
  isDragging: false,
  startX: 0,
  startWidth: 0,
};

const SKILL_IMAGE_FILE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
  "avif",
]);

function getFileExtension(fileName) {
  if (!fileName || typeof fileName !== "string") return "";
  const match = fileName.trim().toLowerCase().match(/\.([^.]+)$/);
  return match ? match[1] : "";
}

// Mirrors the main process's read-skill-file mime map (ipc.js) so remote
// bundle previews type images identically to local reads.
const SKILL_IMAGE_MIME_BY_EXTENSION = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

function isSkillImageFile(fileName) {
  return SKILL_IMAGE_FILE_EXTENSIONS.has(getFileExtension(fileName));
}

function isSkillsMarketplacesBrowseActive() {
  return skillsActiveFilter === SKILLS_MARKETPLACES_BROWSE_FILTER;
}

function isSkillsDiscoverActive() {
  return skillsActiveFilter === SKILLS_DISCOVER_FILTER;
}

function setSkillsBrowsePanelVisible(visible) {
  const panel = document.getElementById("skills-browse-panel");
  const marketplacesView = document.getElementById("marketplaces-view");
  if (panel) panel.style.display = visible ? "" : "none";
  if (marketplacesView) marketplacesView.style.display = visible ? "none" : "";
}

function updateAgentSkillsSearchBar() {
  const skillsSearch = document.getElementById("skills-search-wrapper");
  const marketplacesSearch = document.getElementById("marketplaces-search-wrapper");
  const isBrowse = isSkillsMarketplacesBrowseActive();
  if (skillsSearch) skillsSearch.style.display = isBrowse ? "none" : "";
  if (marketplacesSearch) marketplacesSearch.style.display = isBrowse ? "" : "none";
}

// Sync All syncs git marketplaces, so it only belongs on the Git tab; the
// other tabs keep just Add Marketplace in the header.
function updateSkillsHeaderActions() {
  const syncAllBtn = document.getElementById("check-updates-btn");
  if (syncAllBtn) {
    syncAllBtn.style.display = isSkillsMarketplacesBrowseActive() ? "" : "none";
  }
}

function applySkillsActiveFilter(filter) {
  skillsActiveFilter = filter;
  const filterTabs = document.querySelectorAll("#skills-filter-tabs .mcp-filter-tab");
  filterTabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.filter === filter);
  });

  updateAgentSkillsSearchBar();
  updateSkillsHeaderActions();

  if (filter === SKILLS_MARKETPLACES_BROWSE_FILTER) {
    setSkillsBrowsePanelVisible(false);
    if (typeof window.loadMarketplaces === "function") {
      void window.loadMarketplaces();
    }
    return;
  }

  setSkillsBrowsePanelVisible(true);
  if (filter === SKILLS_DISCOVER_FILTER) {
    void ensureSkillsDiscoverListings();
  }
  renderSkillsList();
}

function switchAgentSkillsToInstalledTab() {
  applySkillsActiveFilter("marketplace");
  void loadSkills();
}

/**
 * Show the Agent Skills subview and optionally refresh its filesystem-backed data.
 */
function showAgentSkillsView({ refresh = true } = {}) {
  const mcpServersBtn = document.getElementById("view-mcp-servers-btn");
  const agentSkillsBtn = document.getElementById("view-agent-skills-btn");
  const costDashboardBtn = document.getElementById("view-cost-dashboard-btn");
  const agentsTabBtn = document.getElementById("view-agents-tab-btn");

  const mcpServersView = document.getElementById("mcp-servers-view");
  const agentSkillsView = document.getElementById("agent-skills-view");
  const agentsTabView = document.getElementById("agents-tab-view");
  const costDashboardView = document.getElementById("cost-dashboard-view");

  const mcpHeaderActions = document.getElementById("mcp-header-actions");
  const skillsHeaderActions = document.getElementById("skills-header-actions");
  const agentsTabHeaderActions = document.getElementById("agents-tab-header-actions");
  const costDashboardHeaderActions = document.getElementById(
    "cost-dashboard-header-actions",
  );

  agentSkillsBtn?.classList.add("active");
  mcpServersBtn?.classList.remove("active");
  costDashboardBtn?.classList.remove("active");
  agentsTabBtn?.classList.remove("active");

  if (mcpServersView) mcpServersView.style.display = "none";
  if (agentSkillsView) agentSkillsView.style.display = "";
  if (agentsTabView) agentsTabView.style.display = "none";
  if (costDashboardView) costDashboardView.style.display = "none";

  if (mcpHeaderActions) mcpHeaderActions.style.display = "none";
  if (skillsHeaderActions) skillsHeaderActions.style.display = "";
  if (agentsTabHeaderActions) agentsTabHeaderActions.style.display = "none";
  if (costDashboardHeaderActions) costDashboardHeaderActions.style.display = "none";

  // While an inline page (skill page or marketplace details page) is open,
  // its chrome replaces the browse UI and header actions.
  const marketplacePageOpen =
    typeof window.isMarketplaceDetailsPageOpen === "function" &&
    window.isMarketplaceDetailsPageOpen();
  if (skillPage || marketplacePageOpen) {
    const skillsBrowser = document.getElementById("agent-skills-browser");
    if (skillsBrowser) skillsBrowser.style.display = "none";
    if (skillsHeaderActions) skillsHeaderActions.style.display = "none";
  }

  setSkillsBrowsePanelVisible(!isSkillsMarketplacesBrowseActive());
  updateAgentSkillsSearchBar();
  updateSkillsHeaderActions();

  if (window.appState) {
    window.appState.controlPlaneView = "agent-skills";
  }

  if (refresh) {
    if (isSkillsMarketplacesBrowseActive()) {
      if (typeof window.loadMarketplaces === "function") {
        void window.loadMarketplaces();
      }
    } else {
      if (isSkillsDiscoverActive()) {
        void ensureSkillsDiscoverListings({ force: true });
      }
      void loadSkills();
    }
  }
}

/**
 * Initialize view toggle functionality
 */
function initViewToggle() {
  const mcpServersBtn = document.getElementById("view-mcp-servers-btn");
  const agentSkillsBtn = document.getElementById("view-agent-skills-btn");
  const costDashboardBtn = document.getElementById("view-cost-dashboard-btn");
  const agentsTabBtn = document.getElementById("view-agents-tab-btn");
  const mcpServersView = document.getElementById("mcp-servers-view");
  const agentSkillsView = document.getElementById("agent-skills-view");
  const agentsTabView = document.getElementById("agents-tab-view");
  const costDashboardView = document.getElementById("cost-dashboard-view");
  const mcpHeaderActions = document.getElementById("mcp-header-actions");
  const skillsHeaderActions = document.getElementById("skills-header-actions");
  const agentsTabHeaderActions = document.getElementById("agents-tab-header-actions");
  const costDashboardHeaderActions = document.getElementById(
    "cost-dashboard-header-actions",
  );

  if (!mcpServersBtn || !agentSkillsBtn) {
    console.warn("[Agent Skills] View toggle buttons not found");
    return;
  }

  mcpServersBtn.addEventListener("click", () => {
    // Update button states
    mcpServersBtn.classList.add("active");
    agentSkillsBtn.classList.remove("active");
    costDashboardBtn?.classList.remove("active");
    agentsTabBtn?.classList.remove("active");

    // Show/hide views
    if (mcpServersView) mcpServersView.style.display = "";
    if (agentSkillsView) agentSkillsView.style.display = "none";
    if (agentsTabView) agentsTabView.style.display = "none";
    if (costDashboardView) costDashboardView.style.display = "none";

    // Show/hide header actions
    if (mcpHeaderActions) mcpHeaderActions.style.display = "";
    if (skillsHeaderActions) skillsHeaderActions.style.display = "none";
    if (agentsTabHeaderActions) agentsTabHeaderActions.style.display = "none";
    if (costDashboardHeaderActions) costDashboardHeaderActions.style.display = "none";
    if (window.appState) {
      window.appState.controlPlaneView = "mcp-servers";
    }
    if (window.refreshToolsCountForHealthyServers) {
      window.refreshToolsCountForHealthyServers({ forceRender: true });
    }
  });

  agentSkillsBtn.addEventListener("click", () => {
    showAgentSkillsView();
  });

  console.log("[Agent Skills] View toggle initialized");
}

/**
 * Initialize search and filter for skills
 */
function initSkillsSearchFilter() {
  if (skillsSearchFilterInitialized) return;

  const searchInput = document.getElementById("skills-search-input");
  const filterTabs = document.querySelectorAll(
    "#skills-filter-tabs .mcp-filter-tab",
  );

  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      skillsSearchQuery = e.target.value.toLowerCase();
      renderSkillsList();
    });
  }

  filterTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      applySkillsActiveFilter(tab.dataset.filter);
    });
  });

  skillsSearchFilterInitialized = true;
  console.log("[Agent Skills] Search/filter initialized");
}

/**
 * Load skills from the API
 */
// One-shot fetch of the agent-usage inventory, folded into
// leaf -> [{ id, name }]. Fail-open by contract: API absent, transport down,
// or a coded failure all yield an empty map (no badges), never an error.
async function loadAgentSkillUsage() {
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

async function loadSkills() {
  console.log("[Agent Skills] Loading skills...");

  const skillsList = document.getElementById("skills-list");
  if (!skillsList) return;

  if (skillsLoading) {
    skillsRefreshQueued = true;
    return;
  }

  skillsLoading = true;
  try {
    do {
      skillsRefreshQueued = false;

      try {
        // Load the local catalog, published-link registry, signed-in
        // identity, and agent usage together so the first render has
        // authoritative filter + badge data.
        const [result, linksRes, publishedSolutionIds, viewerIdentity, agentUsage] =
          await Promise.all([
            window.electronAPI.getSkills(),
            window.electronAPI.aiMarketplace
              ?.listSkillLinks?.()
              .catch(() => null),
            loadPublishedSkillSolutionIds(),
            ensureSkillsViewerIdentity(),
            loadAgentSkillUsage(),
          ]);
        skillsMarketplaceLinks = linksRes?.success ? linksRes.links || {} : {};
        skillsPublishedSolutionIds = publishedSolutionIds;
        skillsViewerIdentity = viewerIdentity || "";
        skillsAgentUsage = agentUsage;

        if (result.success) {
          skillsData = result.skills || [];
          skillsDefaultLogo = result.defaultLogo || null;
          console.log(`[Agent Skills] Loaded ${skillsData.length} skills`);
        } else {
          console.warn("[Agent Skills] API returned error:", result.error);
          skillsData = [];
          skillsDefaultLogo = null;
        }
      } catch (error) {
        console.error("[Agent Skills] Failed to load skills:", error);
        // Use fallback data for development/testing
        skillsData = getFallbackSkills();
      }

      renderSkillsList();
      // An open inline skill page shows its own Published chip — keep it in
      // step with the freshly fetched links (e.g. after a chat-side unpublish).
      if (skillPage) {
        refreshSkillPageMarketplaceState();
      }
    } while (skillsRefreshQueued);
  } finally {
    skillsLoading = false;
  }
}

/**
 * Get fallback skills data for when API is unavailable
 */
function getFallbackSkills() {
  return [
    {
      name: "mcp-server-management",
      display_name: "MCP Server Management",
      description:
        "Install, configure, update, and delete MCP tool servers. Use when user mentions installing tools, MCP servers, OAuth setup, or managing integrations.",
      source: "system",
      priority: "high",
      version: "1.0",
      author: "portico-ai-team",
      triggers: ["install mcp", "create server", "oauth", "add tool"],
      has_references: true,
      skill_path: "skills/mcp-server-management",
    },
    {
      name: "tool-server-selection",
      display_name: "Tool Server Selection",
      description:
        "Dynamically select and enable tool servers based on user needs. Use when determining which tools to enable, analyzing available servers, or enabling multiple tools for a task.",
      source: "system",
      priority: "medium",
      version: "1.0",
      author: "portico-ai-team",
      triggers: ["enable tool", "which tool", "what tools", "available tools"],
      has_references: false,
      skill_path: "skills/tool-server-selection",
    },
  ];
}

/**
 * Filter skills based on current search and filter state
 */
function getFilteredSkills() {
  let filtered = skillsData.filter((skill) => {
    // Apply search filter. Search contract (all tabs, both Agents and Agent
    // Skills): TITLE and AUTHOR only — descriptions/marketplace ids/triggers
    // matched too broadly.
    if (skillsSearchQuery) {
      const searchableText = [
        skill.name,
        getSkillDisplayName(skill),
        skill.author,
        skill.created_by_email,
        normalizeCreatorLdap(skill.created_by_email),
      ]
        .map((value) => String(value || ""))
        .join(" ")
        .toLowerCase();

      if (!searchableText.includes(skillsSearchQuery)) {
        return false;
      }
    }

    // Apply provenance/ownership filter. These are facets, so a signed-in
    // user's published or installed skill may intentionally match User too.
    if (
      !skillMatchesFilter(skill, skillsActiveFilter, {
        viewerIdentity: skillsViewerIdentity,
        marketplaceLinks: skillsMarketplaceLinks,
        publishedSolutionIds: skillsPublishedSolutionIds,
      })
    ) {
      return false;
    }

    return true;
  });

  // Sort: system/core skills first, then others, alphabetically within each group
  // Agent-used skills lead (usage count descending), then the classic
  // core-first grouping, alphabetical within each tier.
  const usageCount = (skill) =>
    (skillsAgentUsage.get(canonicalSkillName(skill.name)) || []).length;
  return [...filtered].sort(
    (a, b) =>
      usageCount(b) - usageCount(a) ||
      Number(b.source === "system") - Number(a.source === "system") ||
      getSkillDisplayName(a).localeCompare(getSkillDisplayName(b)),
  );
}

/**
 * Get badge class for skill source
 */
function getSourceBadgeClass(source) {
  const shared = window.SkillCardRenderer?.skillCardSourceBadgeClass;
  if (typeof shared === "function") return shared(source);
  return source === "user" ? "badge-user" : source === "marketplace" ? "badge-installed" : "badge-core";
}

/**
 * Get badge label for skill source (delegates to the shared card renderer so
 * cards, detail pages, and modals stay on one label set)
 */
function getSourceBadgeLabel(source) {
  const shared = window.SkillCardRenderer?.skillCardSourceBadgeLabel;
  if (typeof shared === "function") return shared(source);
  return source === "user" ? "User" : source === "marketplace" ? "Installed" : "Core";
}

/**
 * Truncate description for card display
 * @param {string} desc - Description text
 * @param {number} maxLength - Maximum length before truncation
 * @returns {string} Truncated description with ellipsis if needed
 */
function truncateDescription(desc, maxLength = 120) {
  if (!desc) return "No description available";
  if (desc.length <= maxLength) return desc;
  return desc.substring(0, maxLength).trim() + "...";
}

function getSkillFolderMenuLabel() {
  return window.electronAPI.platform === "darwin"
    ? "Open in Finder"
    : "Open Folder";
}
function escapeHtmlAttribute(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function sanitizeInlineAssetUrl(rawUrl, options = {}) {
  const value = String(rawUrl ?? "").trim();
  if (!value) return null;

  if (options.allowDataImage === true && /^data:image\//i.test(value)) {
    return value;
  }

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

function buildSafeImageTag(src, altText, className) {
  const safeSrc = sanitizeInlineAssetUrl(src, { allowDataImage: true });
  if (!safeSrc) {
    return "";
  }

  return `<img src="${escapeHtmlAttribute(safeSrc)}" alt="${escapeHtmlAttribute(altText)}" class="${escapeHtmlAttribute(className)}" />`;
}

function sanitizeRenderedHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = String(html ?? "");

  template.content
    .querySelectorAll(
      "script, iframe, object, embed, link, meta, base, form, button, input, textarea, select, option",
    )
    .forEach((el) => el.remove());

  template.content.querySelectorAll("*").forEach((el) => {
    Array.from(el.attributes).forEach((attr) => {
      const attrName = attr.name.toLowerCase();
      if (attrName.startsWith("on") || attrName === "srcdoc") {
        el.removeAttribute(attr.name);
        return;
      }

      if (
        attrName === "href" ||
        attrName === "src" ||
        attrName === "xlink:href" ||
        attrName === "poster"
      ) {
        const safeUrl = sanitizeInlineAssetUrl(attr.value, {
          allowDataImage: attrName !== "href",
        });
        if (!safeUrl) {
          el.removeAttribute(attr.name);
          return;
        }
        el.setAttribute(attr.name, safeUrl);
      }
    });

    if (el.tagName === "A" && el.getAttribute("href")) {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    }
  });

  return template.innerHTML;
}

/**
 * Render a single skill card
 */
function renderSkillCard(skill) {
  const safeSkillNameAttr = escapeHtmlAttribute(skill.name || "");
  // Published is ownership-sensitive and resolved by exact solution id. This
  // allows a viewer-owned installed copy to show both Installed and Published
  // without ever aliasing a same-named editable User skill.
  const skillLink = authoritativeSkillMarketplaceLink(skill);
  const usedByAgents =
    skillsAgentUsage.get(canonicalSkillName(skill.name)) || [];
  const blockedDeco = agentsBlockedDeco(usedByAgents);
  const openFolderOption = skill.skill_path && skill.source !== "marketplace"
    ? `
    <button class="mcp-dropdown-item skill-open-folder-menu-btn" data-skill-name="${safeSkillNameAttr}">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
      </svg>
      ${getSkillFolderMenuLabel()}
    </button>
  `
    : "";
  const exportSkillOption = skill.skill_path
    ? `
    <button class="mcp-dropdown-item skill-export-menu-btn" data-skill-name="${safeSkillNameAttr}">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
        <polyline points="7 10 12 15 17 10"></polyline>
        <line x1="12" y1="15" x2="12" y2="3"></line>
      </svg>
      Export Skill
    </button>
  `
    : "";
  const publishAiMarketplaceOption =
    skill.skill_path &&
    skill.source === "user" &&
    !skillHasUnverifiedMarketplaceLink(skill)
    ? `
    <button class="mcp-dropdown-item skill-publish-ai-marketplace-menu-btn" data-skill-name="${safeSkillNameAttr}" title="Share this skill with everyone at Portico so they can add it to their own AI Chat sessions.">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 3v12"></path>
        <polyline points="7 8 12 3 17 8"></polyline>
        <path d="M5 21h14"></path>
      </svg>
      ${skillLink ? "Republish" : "Publish"}
    </button>
  `
    : "";
  const duplicateSkillOption = skill.skill_path
    ? `
    <button class="mcp-dropdown-item skill-duplicate-menu-btn" data-skill-name="${safeSkillNameAttr}">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
      </svg>
      Duplicate
    </button>
  `
    : "";
  // A solutions-installed copy of a listing the viewer authored can be
  // promoted into the editable user skill behind that listing (ownership is
  // re-verified fail-closed in the main process).
  const reclaimSkillOption =
    skill.source === "marketplace" &&
    skill.marketplace_id === "ai-marketplace" &&
    skill.marketplace_solution_id &&
    skillsPublishedSolutionIds.has(skill.marketplace_solution_id)
      ? `
    <button class="mcp-dropdown-item skill-reclaim-menu-btn" data-skill-name="${safeSkillNameAttr}">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
        <path d="M7 11V7a5 5 0 0 1 9.9-1"></path>
      </svg>
      Convert to editable copy
    </button>
  `
      : "";
  // Outdated installed copies get a one-click refresh; conflicted copies
  // (update + local edits) resolve through the Marketplaces modal instead.
  const updateSkillOption =
    skill.source === "marketplace" &&
    skill.has_update === true &&
    skill.has_conflict !== true
      ? `
    <button class="mcp-dropdown-item skill-update-menu-btn" data-skill-name="${safeSkillNameAttr}">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 12a9 9 0 1 1-2.64-6.36"></path>
        <polyline points="21 3 21 9 15 9"></polyline>
      </svg>
      Update from marketplace
    </button>
  `
      : "";

  // Build ellipsis dropdown menu items. Marketplace-installed copies get the
  // real Uninstall (registry-pruning) lifecycle instead of Delete — the
  // legacy delete path only partially cleaned up managed installs.
  const uninstallOption =
    skill.source === "marketplace" && skill.ootb_seeded === true
      ? `
    <button class="mcp-dropdown-item skill-builtin-menu-btn" aria-disabled="true" title="Built-in default — ships with the app and cannot be uninstalled. Use Duplicate to create an editable user copy.">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="7" width="18" height="13" rx="2"></rect>
        <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
      </svg>
      Built-in — ships with the app
    </button>
  `
      : skill.source === "marketplace"
      ? `
    <button class="mcp-dropdown-item skill-uninstall-menu-btn delete-action${blockedDeco.triggerClass}" data-skill-name="${safeSkillNameAttr}"${blockedDeco.attrs}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="3 6 5 6 21 6"></polyline>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
      </svg>
      Uninstall
    </button>
  `
      : "";
  const deleteOption =
    skill.source !== "system" && skill.source !== "marketplace"
      ? `
    <button class="mcp-dropdown-item skill-delete-menu-btn delete-action${blockedDeco.triggerClass}" data-skill-name="${safeSkillNameAttr}"${blockedDeco.attrs}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="3 6 5 6 21 6"></polyline>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        <line x1="10" y1="11" x2="10" y2="17"></line>
        <line x1="14" y1="11" x2="14" y2="17"></line>
      </svg>
      Delete
    </button>
  `
      : "";

  const menuHtml = `
          <button class="mcp-card-menu-trigger" data-menu-skill-name="${safeSkillNameAttr}" aria-label="Skill options">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="5" r="2"></circle>
              <circle cx="12" cy="12" r="2"></circle>
              <circle cx="12" cy="19" r="2"></circle>
            </svg>
          </button>
          <div class="mcp-card-dropdown" data-dropdown-skill-name="${safeSkillNameAttr}">
            <button class="mcp-dropdown-item skill-details-menu-btn" data-skill-name="${safeSkillNameAttr}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                <circle cx="12" cy="12" r="3"></circle>
              </svg>
              Details
            </button>
            ${openFolderOption}
            ${exportSkillOption}
            ${updateSkillOption}
            ${reclaimSkillOption}
            ${publishAiMarketplaceOption}
            ${duplicateSkillOption}
            ${uninstallOption}
            ${deleteOption}
          </div>`;

  // The static card shell (icon, name, description, badge rows) is the shared
  // SkillCardRenderer — the same markup the AI Marketplace publish modal shows
  // — so the two presentations cannot drift.
  return window.SkillCardRenderer.buildSkillCardHtml(skill, {
    interactive: true,
    menuHtml,
    link: skillLink,
    updateAvailable: skill.has_update === true,
    conflict: skill.has_conflict === true,
    defaultLogo: skillsDefaultLogo,
    usedByAgents,
  });
}

// "Convert to editable copy" on a self-authored solutions-installed skill:
// the main process re-verifies listing ownership, detaches the copy into
// skills-user (creator reset to the viewer), and relinks it to the listing so
// Published state survives. Recoverable by reinstalling the listing.
// Throws on failure — runs under the confirm modal's busy spinner so the
// error renders inline in the dialog instead of only as a toast (mirrors
// the agents-side performReclaimAgent contract).
async function reclaimInstalledSkillCopy(skill) {
  const result = await window.electronAPI?.aiMarketplace?.reclaimSkill?.(
    skill?.name,
  );
  if (!result?.success) {
    logSkillsMarketplace("reclaim:result", {
      skillId: skill?.name || "",
      success: false,
      errorMessage: String(result?.error || "").slice(0, 200),
    });
    throw new Error(result?.error || "Failed to convert the installed copy.");
  }
  const finalName = result?.data?.local_skill_id || skill?.name;
  showNotification(
    `"${getSkillDisplayName(skill)}" is now your editable copy (${finalName}).`,
    "success",
  );
  logSkillsMarketplace("reclaim:result", {
    skillId: skill?.name || "",
    finalName,
    success: true,
  });
  // The Agents publish modal caches the owned-listings page per session.
  window.AgentsPublishHooks?.invalidateMarketplaceSkillLookups?.();
  await loadSkills();
}

// Confirmation gate for the reclaim: same shared modal (and wording shape)
// the agents-side "Convert to editable copy?" uses.
function confirmReclaimInstalledSkillCopy(skill) {
  const confirmName = getSkillDisplayName(skill);
  if (typeof window.showAgentsConfirmModal === "function") {
    window.showAgentsConfirmModal({
      title: "Convert to editable copy?",
      message:
        `Make "${confirmName}" your editable author copy for this marketplace ` +
        `solution? The installed copy moves to your user skills; Edit and ` +
        `Republish will update your published listing.`,
      meta: { badge: skill?.marketplace_solution_id || "" },
      confirmLabel: "Convert",
      confirmBusyLabel: "Converting...",
      onConfirm: () => reclaimInstalledSkillCopy(skill),
    });
    return;
  }
  if (window.confirm(`Convert "${confirmName}" to your editable copy?`)) {
    reclaimInstalledSkillCopy(skill).catch((error) => {
      console.error("[Agent Skills] reclaim installed copy failed", error);
      showNotification(error?.message || String(error), "error");
    });
  }
}

// "Update from marketplace" on an outdated installed copy: solutions installs
// refresh in place from their listing; git-marketplace installs pull the
// remote skill. Both preserve the local id and clear hasUpdate on success.
async function updateInstalledSkillFromMarketplace(skill) {
  const bareSkillId =
    String(skill?.name || "")
      .split("/")
      .filter(Boolean)
      .at(-1) || "";
  try {
    let result;
    if (
      skill?.marketplace_id === "ai-marketplace" &&
      skill?.marketplace_solution_id
    ) {
      result = await window.electronAPI?.aiMarketplace?.install(
        skill.marketplace_solution_id,
        { refreshInstalledSkillId: bareSkillId },
      );
    } else if (skill?.marketplace_id) {
      result = await window.electronAPI?.updateMarketplaceSkill?.(
        skill.marketplace_id,
        bareSkillId,
        {},
      );
    }
    if (!result?.success) {
      throw new Error(result?.error || "Failed to update the installed skill.");
    }
    showNotification(
      `Skill "${skill.display_name || skill.name}" updated from the marketplace.`,
      "success",
    );
    await loadSkills();
  } catch (error) {
    console.error("[Agent Skills] update from marketplace failed", error);
    showNotification(error?.message || String(error), "error");
  }
}

// ---------------------------------------------------------------------------
// Inline Discover tab: Solutions Marketplace skill listings rendered as real
// skill cards. Badges derive from LOCAL state at render time (link registry +
// installed copies), so a listing the viewer publishes or has installed never
// reads as a plain installable — parity with the Agents tab's Discover.
// ---------------------------------------------------------------------------

async function ensureSkillsDiscoverListings({ force = false } = {}) {
  if (skillsDiscoverState.promise) return skillsDiscoverState.promise;
  const attemptFresh =
    Date.now() - skillsDiscoverState.fetchedAt < SKILLS_DISCOVER_TTL_MS;
  if (!force && skillsDiscoverState.solutions && attemptFresh) {
    return skillsDiscoverState.solutions;
  }
  const run = (async () => {
    try {
      const result = await window.electronAPI?.aiMarketplace?.search?.({
        query: "",
        filters: { type: ["skills"] },
        page: 1,
        pageSize: 100,
      });
      if (result?.success) {
        skillsDiscoverState.solutions = Array.isArray(result.data?.results)
          ? result.data.results
          : [];
        skillsDiscoverState.error = null;
      } else {
        // Keep any stale listings so the tab degrades instead of blanking.
        skillsDiscoverState.error =
          result?.error || "Marketplace search failed";
      }
    } catch (error) {
      skillsDiscoverState.error = error?.message || String(error);
    } finally {
      skillsDiscoverState.fetchedAt = Date.now();
      skillsDiscoverState.promise = null;
      logSkillsMarketplace("discover:listings", {
        count: Array.isArray(skillsDiscoverState.solutions)
          ? skillsDiscoverState.solutions.length
          : null,
        failed: Boolean(skillsDiscoverState.error),
      });
      if (isSkillsDiscoverActive()) renderSkillsList();
    }
    return skillsDiscoverState.solutions;
  })();
  skillsDiscoverState.promise = run;
  return run;
}

function discoverSolutionId(sol) {
  return String(sol?.id || sol?.solution_id || "").trim();
}

// The local skill this listing corresponds to, if any: an installed
// marketplace copy wins (it IS this listing on disk), then a linked
// non-marketplace skill (the viewer publishes this listing).
function findDiscoverLocalCounterpart(solutionId) {
  if (!solutionId) return null;
  const installed = skillsData.find(
    (s) =>
      s?.source === "marketplace" &&
      String(s?.marketplace_solution_id || "").trim() === solutionId,
  );
  if (installed) return installed;
  return (
    skillsData.find(
      (s) =>
        s?.source !== "marketplace" &&
        marketplaceSolutionIdForSkill(s, skillsMarketplaceLinks) === solutionId,
    ) || null
  );
}

// ---------------------------------------------------------------------------
// Remote listing pages: read-only skill preview rendered straight from the
// solution's marketplace bundle (SKILL.md + references/scripts entries).
// ---------------------------------------------------------------------------

// solutionId -> normalized bundle. Successes only: a failed fetch is retried
// naturally the next time the listing is opened.
const skillsDiscoverBundleCache = new Map();

// "mp::plugin::skill" -> materialized git bundle, REMOTE fetches only —
// installed copies re-read from disk every open (cheap and never stale).
const gitMarketplaceBundleCache = new Map();

function parseJsonObjectSafe(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_error) {
    return null;
  }
}

// Renderer copy of agents.js's bundle normalization: bundles arrive as
// objects or JSON strings, sometimes nested one level, with payloads that may
// themselves be JSON strings.
function normalizeSolutionBundle(value) {
  let bundle = parseJsonObjectSafe(value);
  if (!bundle) return null;
  if (!bundle.payload && bundle.bundle) {
    bundle = parseJsonObjectSafe(bundle.bundle) || bundle;
  }
  const payload = parseJsonObjectSafe(bundle.payload);
  if (payload) return { ...bundle, payload };
  return bundle;
}

// Inline-first: search envelopes often carry the bundle (or the git-resolved
// cache) directly, skipping the getBundle IPC entirely.
function discoverInlineSolutionBundle(sol) {
  const cache = parseJsonObjectSafe(sol?.resolved_bundle_cache);
  if (cache) {
    const cached = normalizeSolutionBundle(cache.bundle || cache);
    if (cached?.payload) return cached;
  }
  const inline = normalizeSolutionBundle(sol?.bundle);
  return inline?.payload ? inline : null;
}

// Full parity with the install side's extractSkillMarkdown: if install
// accepts a payload shape, the preview must render it too.
function extractDiscoverSkillMarkdown(payload, bundle) {
  const candidates = [
    payload?.skill_md,
    payload?.skillMd,
    payload?.skill_markdown,
    payload?.markdown,
    payload?.content,
    payload?.skill,
    bundle?.skill_md,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  for (const group of [payload?.files, payload?.references, payload?.scripts]) {
    if (!Array.isArray(group)) continue;
    for (const file of group) {
      const base = String(file?.path || file?.name || "")
        .split("/")
        .pop()
        .toLowerCase();
      if (base !== "skill.md") continue;
      if (typeof file?.content === "string" && file.content.trim()) {
        return file.content;
      }
      const decoded = decodeBundleText(file?.content_b64);
      if (decoded && decoded.trim()) return decoded;
    }
  }
  return "";
}

// Mirror of the install side's relative-path sanitizer: forward slashes only,
// no absolute paths, no traversal.
function sanitizeBundleRelativePath(relPath) {
  const normalized = String(relPath || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  if (!normalized) return "";
  const segments = normalized.split("/");
  if (segments.some((seg) => !seg || seg === "." || seg === "..")) return "";
  return segments.join("/");
}

// Publisher-controlled base64 feeds an unescaped `img src` attribute in the
// shared viewer; the strict charset gate makes attribute breakout impossible
// (the base64 alphabet has no quotes or angle brackets).
function isStrictBase64(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    /^[A-Za-z0-9+/=\r\n]*$/.test(value)
  );
}

function decodeBundleText(b64) {
  if (!isStrictBase64(b64)) return null;
  try {
    const raw = atob(String(b64).replace(/\s+/g, ""));
    const bytes = Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  } catch (_error) {
    return null;
  }
}

// Virtual file set for the inline page: `files` matches getSkillFiles' shape
// (renderSkillFileTree/buildFileTree consume name/relativePath/fullPath),
// `contents` backs openSkillFile's in-memory seam. pathPrefix is a synthetic
// scheme (marketplace-listing://… or git-marketplace-listing://…) so full
// paths can never collide with a real filesystem path.
function buildListingSkillVirtualFiles(pathPrefix, bundle) {
  const payload = bundle?.payload || {};
  const files = [];
  const contents = new Map();
  const seen = new Set();
  const pathFor = (relativePath) => `${pathPrefix}/${relativePath}`;

  const skillMd = extractDiscoverSkillMarkdown(payload, bundle);
  if (skillMd) {
    const fullPath = pathFor("SKILL.md");
    files.push({
      name: "SKILL.md",
      relativePath: "SKILL.md",
      fullPath,
      type: "file",
    });
    contents.set(fullPath, { content: skillMd });
    seen.add("SKILL.md");
  }

  for (const entry of [
    ...(Array.isArray(payload.references) ? payload.references : []),
    ...(Array.isArray(payload.scripts) ? payload.scripts : []),
  ]) {
    if (!entry || typeof entry !== "object") continue;
    const relativePath = sanitizeBundleRelativePath(entry.path);
    if (!relativePath || seen.has(relativePath)) continue;
    if (relativePath.toLowerCase() === "skill.md") continue;
    seen.add(relativePath);
    const name = relativePath.split("/").pop();
    const fullPath = pathFor(relativePath);
    files.push({ name, relativePath, fullPath, type: "file" });
    if (isSkillImageFile(name)) {
      if (isStrictBase64(entry.content_b64)) {
        const b64 = String(entry.content_b64).replace(/\s+/g, "");
        const mimeType =
          SKILL_IMAGE_MIME_BY_EXTENSION[getFileExtension(name)] ||
          "application/octet-stream";
        const padding = (b64.match(/=+$/) || [""])[0].length;
        contents.set(fullPath, {
          dataUrl: `data:${mimeType};base64,${b64}`,
          mimeType,
          sizeBytes: Math.max(0, Math.floor((b64.length * 3) / 4) - padding),
        });
      } else {
        // No dataUrl → the shared viewer shows its image placeholder.
        contents.set(fullPath, { mimeType: null });
      }
    } else {
      const text =
        typeof entry.content === "string" && entry.content
          ? entry.content
          : decodeBundleText(entry.content_b64);
      contents.set(fullPath, {
        content:
          text ?? "Unable to decode this file from the marketplace bundle.",
      });
    }
  }
  return { files, contents };
}

// Shared tail for every remote-listing page load: turn the bundle into virtual
// files, publish them to the page, paint the tree, and auto-open SKILL.md.
// Each listing source differs only in its path prefix and log event.
function renderListingSkillBundle(pathPrefix, bundle, logEvent, logMeta) {
  const { files, contents } = buildListingSkillVirtualFiles(pathPrefix, bundle);
  skillPage.remoteFiles = contents;
  logSkillsMarketplace(logEvent, { ...logMeta, fileCount: files.length });
  renderSkillFileTree(files, "");
  const skillMdFile = files.find(
    (f) => f.name === "SKILL.md" || f.relativePath === "SKILL.md",
  );
  if (skillMdFile) {
    openSkillFile(skillMdFile.fullPath, skillMdFile.name);
  }
}

// Open the read-only inline page for a remote listing. The page skill is a
// synthetic record — NEVER the card-synthesis object (whose source is "user"
// for the author badge and would enable the edit gate).
async function openDiscoverSkillPage(sol) {
  const solutionId = discoverSolutionId(sol);
  if (!solutionId) return;
  logSkillsMarketplace("discover:open-page", { solutionId });
  await openSkillPage({
    name: sol?.name || solutionId,
    description: sol?.description || "",
    source: SKILLS_DISCOVER_LISTING_SOURCE,
    marketplace_solution_id: solutionId,
    has_bundle: sol?.has_bundle,
    discover_solution: sol,
  });
}

// Remote variant of the page's file-load tail: bundle (cache → inline →
// getBundle IPC) → virtual files → tree + SKILL.md auto-open.
async function loadDiscoverSkillPageFiles(skill) {
  const fileTree = document.getElementById("skill-file-tree");
  const solutionId = String(skill?.marketplace_solution_id || "");
  if (skill?.has_bundle === false) {
    if (fileTree) {
      fileTree.innerHTML =
        '<div class="skill-file-empty">This listing has no bundle to preview</div>';
    }
    return;
  }
  let bundle = skillsDiscoverBundleCache.get(solutionId) || null;
  if (!bundle) {
    bundle = discoverInlineSolutionBundle(skill?.discover_solution);
  }
  let failureCode = null;
  if (!bundle) {
    try {
      const result =
        await window.electronAPI?.aiMarketplace?.getBundle?.(solutionId);
      if (result?.success) {
        bundle = normalizeSolutionBundle(result.data);
      } else {
        failureCode = result?.code || null;
      }
    } catch (error) {
      failureCode = error?.message || String(error);
    }
  }
  if (skillPage?.skill !== skill) return; // navigated away mid-fetch
  if (!bundle?.payload) {
    logSkillsMarketplace("discover:page-bundle-failed", {
      solutionId,
      code: failureCode || "empty_payload",
    });
    if (failureCode === "no_bundle") {
      // The listing has nothing installable — disable the page Install too.
      skill.has_bundle = false;
      refreshSkillPageMarketplaceState();
    }
    if (fileTree) {
      fileTree.innerHTML =
        '<div class="skill-file-error">Couldn\'t load this skill from the marketplace</div>';
    }
    return;
  }
  skillsDiscoverBundleCache.set(solutionId, bundle);
  renderListingSkillBundle(`marketplace-listing://${solutionId}`, bundle, "discover:page-loaded", {
    solutionId,
  });
}

// ---------------------------------------------------------------------------
// Git-marketplace listing pages: the same read-only page, fed by the
// get-marketplace-skill-bundle IPC (disk for installed copies, allowlisted
// repository download otherwise). Opened from a marketplace details page,
// which suspends underneath so Back restores it exactly as left.
// ---------------------------------------------------------------------------

function gitListingCacheKey(rec) {
  return `${rec.marketplaceId}::${rec.pluginName || ""}::${rec.skillId}`;
}

function gitListingBannerText(skill) {
  const rec = skill?.git_listing || {};
  const marketplaceName = rec.marketplaceName || rec.marketplaceId || "this";
  return rec.installed
    ? `This skill is installed from the "${marketplaceName}" marketplace and is read only here.`
    : `This skill is from the "${marketplaceName}" marketplace. Install it to use it in chats.`;
}

// Open the read-only inline page for a git-marketplace skill. The synthetic
// page skill carries the full catalog record (git_listing) — install needs
// skillSource/skillPath, which never travel through DOM attributes.
async function openGitMarketplaceSkillPage(record) {
  if (!record?.marketplaceId || !record?.skillId) return;
  logSkillsMarketplace("git-listing:open-page", {
    marketplaceId: record.marketplaceId,
    skillId: record.skillId,
    pluginName: record.pluginName || null,
  });
  await openSkillPage(
    {
      name: record.displayName || record.skillId,
      description: record.description || "",
      source: GIT_MARKETPLACE_LISTING_SOURCE,
      git_listing: { ...record },
    },
    { fromMarketplaceDetails: true },
  );
}

// Git variant of the page's file-load tail: bundle (remote session cache →
// get-marketplace-skill-bundle IPC) → virtual files → tree + SKILL.md.
async function loadGitMarketplaceSkillPageFiles(skill) {
  const fileTree = document.getElementById("skill-file-tree");
  const rec = skill?.git_listing;
  if (!rec) return;
  const cacheKey = gitListingCacheKey(rec);
  let bundle = rec.installed
    ? null
    : gitMarketplaceBundleCache.get(cacheKey) || null;
  let failureMessage = null;
  let installedFlipped = false;
  if (!bundle) {
    try {
      const result = await window.electronAPI?.getMarketplaceSkillBundle?.(
        rec.marketplaceId,
        rec.skillId,
        rec.pluginName || null,
      );
      if (result?.success && result.bundle?.payload) {
        bundle = result.bundle;
        // The main process is authoritative on installed state (the card
        // record can lag right after installs/uninstalls elsewhere).
        const installedNow = result.installed === true;
        installedFlipped = installedNow !== (rec.installed === true);
        rec.installed = installedNow;
        if (!installedNow) gitMarketplaceBundleCache.set(cacheKey, bundle);
      } else {
        failureMessage = result?.error || null;
      }
    } catch (error) {
      failureMessage = error?.message || String(error);
    }
  }
  if (skillPage?.skill !== skill) return; // navigated away mid-fetch
  if (installedFlipped) {
    refreshSkillPageMarketplaceState();
  }
  if (!bundle?.payload) {
    logSkillsMarketplace("git-listing:page-bundle-failed", {
      marketplaceId: rec.marketplaceId,
      skillId: rec.skillId,
      message: failureMessage || "empty_payload",
    });
    if (fileTree) {
      fileTree.innerHTML =
        '<div class="skill-file-error">Couldn\'t load this skill from the marketplace</div>';
    }
    return;
  }
  renderListingSkillBundle(
    `git-marketplace-listing://${rec.marketplaceId}/${rec.pluginName ? `${rec.pluginName}/` : ""}${rec.skillId}`,
    bundle,
    "git-listing:page-loaded",
    { marketplaceId: rec.marketplaceId, skillId: rec.skillId },
  );
}

// Install from the git-listing page and flip the page state IN PLACE — no
// navigation, so Back still resumes the suspended marketplace details page.
async function installGitMarketplaceSkillFromPage(skill, triggerBtn) {
  const rec = skill?.git_listing;
  if (!rec || rec.installed) return;
  const restore = setSkillMenuActionBusy(triggerBtn, "Installing...");
  try {
    const result = await window.electronAPI?.installMarketplaceSkill?.(
      rec.marketplaceId,
      rec.skillId,
      rec.skillPath,
      rec.skillSource || null,
      rec.pluginName || null,
    );
    if (!result?.success) {
      throw new Error(result?.error || "Install failed");
    }
    showNotification("Skill installed successfully", "success");
    if (skillPage?.skill === skill) {
      rec.installed = true;
      gitMarketplaceBundleCache.delete(gitListingCacheKey(rec));
      refreshSkillPageMarketplaceState();
    }
    // The suspended marketplace grid + the local catalog both need the new
    // install state so Back (and the tabs) land fresh.
    if (typeof window.refreshMarketplaceSurfaces === "function") {
      try {
        await window.refreshMarketplaceSurfaces();
      } catch (error) {
        showNotification(
          `Installed, but refreshing the marketplace view failed: ${error?.message || error}`,
          "error",
        );
      }
    } else {
      await loadSkills();
    }
  } catch (error) {
    showNotification(
      `Failed to install skill: ${error?.message || error}`,
      "error",
    );
  } finally {
    restore();
  }
}

// Install from the remote page, then land on the local installed copy — the
// only reliable success signal, since installDiscoverSolution surfaces its
// own notifications and returns nothing. (A re-render during the in-flight
// install can restore a fresh Install button; a second click just re-runs a
// server-side in-place refresh, so no re-entrancy plumbing.)
async function installDiscoverSkillFromPage(skill, triggerBtn) {
  const solutionId = String(skill?.marketplace_solution_id || "");
  if (!solutionId) return;
  const pageAtCall = skillPage;
  const restore = setSkillMenuActionBusy(triggerBtn, "Installing...");
  try {
    await installDiscoverSolution(solutionId);
  } finally {
    restore();
  }
  if (skillPage !== pageAtCall) return;
  const counterpart = findDiscoverLocalCounterpart(solutionId);
  if (counterpart) {
    await openSkillPage(counterpart);
  }
}

function renderDiscoverSkillCard(sol) {
  const solutionId = discoverSolutionId(sol);
  const local = findDiscoverLocalCounterpart(solutionId);
  // Kebab menu (UX parity with the local tabs): View Details always; pure
  // listings with a bundle also offer Install. Shared open/close behavior
  // comes from SkillCardRenderer.attachCardMenus.
  const menuSolutionId = escapeHtmlAttribute(solutionId);
  const viewDetailsItem = `
            <button class="mcp-dropdown-item skill-discover-menu-details-btn" data-solution-id="${menuSolutionId}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                <circle cx="12" cy="12" r="3"></circle>
              </svg>
              View Details
            </button>`;
  const discoverMenuHtml = (items) => `
          <button class="mcp-card-menu-trigger" data-menu-solution-id="${menuSolutionId}" aria-label="Skill options">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="5" r="2"></circle>
              <circle cx="12" cy="12" r="2"></circle>
              <circle cx="12" cy="19" r="2"></circle>
            </svg>
          </button>
          <div class="mcp-card-dropdown" data-dropdown-solution-id="${menuSolutionId}">${items}</div>`;
  if (local) {
    // Build from the local copy with the exact options renderSkillCard uses,
    // so User/Published/Installed/marketplace-name badges are pixel-identical
    // to the other tabs.
    const title =
      local.source === "marketplace"
        ? `Already installed as ${getSkillDisplayName(local)}`
        : "You publish this skill — it is already in your User skills";
    // The whole tab IS the Solutions Marketplace — repeating its name chip on
    // every counterpart card is noise (the Installed tab keeps the chip to
    // distinguish ai-marketplace copies from git-marketplace ones).
    const cardSkill = { ...local, marketplace_name: "", marketplace_id: "" };
    const usedByAgents =
      skillsAgentUsage.get(canonicalSkillName(local.name)) || [];
    // The destructive lifecycle item for the LOCAL copy — same labels, same
    // agent-usage blocking as the local tabs and the marketplace directory
    // kebabs. Managed installs uninstall; user copies delete.
    const blockedDeco = agentsBlockedDeco(usedByAgents);
    const localNameAttr = escapeHtmlAttribute(local.name);
    // Listings the viewer publishes also offer Unpublish here (the page has
    // it; parity). The published-agent dependency check runs on confirm.
    const localLink = authoritativeSkillMarketplaceLink(local);
    const unpublishItem = localLink
      ? `
            <button class="mcp-dropdown-item skill-discover-menu-unpublish-btn" data-solution-id="${menuSolutionId}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 5v14"></path>
                <path d="M19 12l-7 7-7-7"></path>
              </svg>
              Unpublish
            </button>`
      : "";
    const removeItem =
      local.source === "marketplace" && local.ootb_seeded === true
        ? `
    <button class="mcp-dropdown-item skill-builtin-menu-btn" aria-disabled="true" title="Built-in default — ships with the app and cannot be uninstalled. Use Duplicate to create an editable user copy.">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="7" width="18" height="13" rx="2"></rect>
        <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
      </svg>
      Built-in — ships with the app
    </button>
  `
        : local.source === "marketplace"
        ? `
            <button class="mcp-dropdown-item skill-discover-menu-uninstall-btn delete-action${blockedDeco.triggerClass}" data-solution-id="${menuSolutionId}" data-skill-name="${localNameAttr}"${blockedDeco.attrs}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              </svg>
              Uninstall
            </button>`
        : local.source !== "system"
          ? `
            <button class="mcp-dropdown-item skill-discover-menu-delete-btn delete-action${blockedDeco.triggerClass}" data-solution-id="${menuSolutionId}" data-skill-name="${localNameAttr}"${blockedDeco.attrs}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                <line x1="10" y1="11" x2="10" y2="17"></line>
                <line x1="14" y1="11" x2="14" y2="17"></line>
              </svg>
              Delete
            </button>`
          : "";
    return window.SkillCardRenderer.buildSkillCardHtml(cardSkill, {
      interactive: true,
      menuHtml: discoverMenuHtml(`${viewDetailsItem}${unpublishItem}${removeItem}`),
      link: localLink,
      updateAvailable: local.has_update === true,
      conflict: local.has_conflict === true,
      defaultLogo: skillsDefaultLogo,
      usedByAgents,
      // Green state indicator (same face as the marketplace folder cards'
      // All Installed) — disabled keeps the install wiring's skip guard.
      footerHtml: `<button class="btn-primary skill-discover-install-btn btn-all-installed" disabled title="${escapeHtmlAttribute(title)}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg> Installed</button>`,
    });
  }
  const hasBundle = sol?.has_bundle !== false;
  const footerHtml = hasBundle
    ? `<button class="btn-primary skill-discover-install-btn" data-solution-id="${escapeHtmlAttribute(solutionId)}">Install Skill</button>`
    : `<button class="btn-primary skill-discover-install-btn" disabled title="No bundle attached">Install Skill</button>`;
  const installItem = hasBundle
    ? `
            <button class="mcp-dropdown-item skill-discover-menu-install-btn" data-solution-id="${menuSolutionId}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
              </svg>
              Install Skill
            </button>`
    : "";
  // Remote listing with no local copy: synthesized card. No source chip (it
  // is not Core/User/Installed here), Published only when the viewer's
  // verified listings include it (covers a stale link whose local skill was
  // deleted — install stays enabled, matching the main-process guard).
  return window.SkillCardRenderer.buildSkillCardHtml(
    {
      name: sol?.name || solutionId,
      description: sol?.description || "",
      source: "user",
      created_by_email:
        sol?.submitted_by || sol?.submittedBy || sol?.owner || sol?.author || "",
    },
    {
      interactive: true,
      menuHtml: discoverMenuHtml(`${viewDetailsItem}${installItem}`),
      hideSourceBadge: true,
      published: skillsPublishedSolutionIds.has(solutionId),
      defaultLogo: skillsDefaultLogo,
      footerHtml,
    },
  );
}

async function installDiscoverSolution(solutionId, btn) {
  if (btn) {
    btn.disabled = true;
    btn.dataset.busy = "true";
    btn.innerHTML = '<div class="btn-spinner"></div> Installing...';
  }
  logSkillsMarketplace("discover:install", { solutionId });
  try {
    const result =
      await window.electronAPI?.aiMarketplace?.install?.(solutionId);
    if (!result?.success) {
      const remediation =
        typeof result?.remediation === "string" && result.remediation.trim()
          ? ` — ${result.remediation.trim()}`
          : "";
      throw new Error(`${result?.error || "Install failed"}${remediation}`);
    }
    showNotification("Skill installed successfully", "success");
    logSkillsMarketplace("discover:install-done", { solutionId });
    // loadSkills refreshes the catalog + link registries and ends in
    // renderSkillsList(), which re-renders Discover in place — the card
    // flips to its Installed state without leaving the tab.
    await loadSkills();
  } catch (error) {
    const message = error?.message || String(error);
    logSkillsMarketplace("discover:install-failed", { solutionId, message });
    showNotification(`Failed to install skill: ${message}`, "error");
    if (btn) {
      btn.disabled = false;
      btn.dataset.busy = "false";
      btn.textContent = "Install Skill";
    }
  }
}

function renderSkillsDiscover(skillsList) {
  if (skillsDiscoverState.promise && !skillsDiscoverState.solutions) {
    skillsList.innerHTML = `
      <div class="mcp-loading">
        <div class="mcp-loading-spinner"></div>
        <p>Loading marketplace skills...</p>
      </div>
    `;
    return;
  }
  const solutions = Array.isArray(skillsDiscoverState.solutions)
    ? skillsDiscoverState.solutions
    : null;
  if (!solutions) {
    skillsList.innerHTML = `
      <div class="mcp-no-results">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>
        <p>Couldn't load marketplace skills${skillsDiscoverState.error ? `: ${escapeHtml(skillsDiscoverState.error)}` : ""}</p>
        <button class="btn-secondary skill-discover-retry-btn" type="button">Retry</button>
      </div>
    `;
    skillsList
      .querySelector(".skill-discover-retry-btn")
      ?.addEventListener("click", () => {
        void ensureSkillsDiscoverListings({ force: true });
        renderSkillsList();
      });
    return;
  }
  // skillsSearchQuery is stored lowercased by the input handler.
  // Search contract: TITLE and AUTHOR only (matches every other tab).
  const filtered = skillsSearchQuery
    ? solutions.filter((sol) => {
        const haystack = [
          sol?.name,
          getSkillDisplayName({ name: sol?.name }),
          sol?.author,
          sol?.submitted_by,
          sol?.owner,
        ]
          .map((value) => String(value || "").toLowerCase())
          .join(" ");
        return haystack.includes(skillsSearchQuery);
      })
    : solutions;
  if (filtered.length === 0) {
    skillsList.innerHTML = skillsSearchQuery
      ? `
        <div class="mcp-no-results">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="11" cy="11" r="8"></circle>
            <path d="m21 21-4.35-4.35"></path>
          </svg>
          <p>No skills match your search</p>
        </div>
      `
      : `
        <div class="mcp-no-results">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
            <path d="M2 17l10 5 10-5"></path>
            <path d="M2 12l10 5 10-5"></path>
          </svg>
          <p>No marketplace skills available</p>
        </div>
      `;
    return;
  }
  // Ranking: agent-used skills first (usage count descending; only
  // counterparts can have local agent references), then installed
  // (counterpart-backed) listings, then alphabetical by the card's displayed
  // title — the same final tiebreak as every other skill surface, instead of
  // the backend's opaque relevance order.
  const discoverUsageCount = (sol) => {
    const counterpart = findDiscoverLocalCounterpart(discoverSolutionId(sol));
    if (!counterpart) return 0;
    return (skillsAgentUsage.get(canonicalSkillName(counterpart.name)) || [])
      .length;
  };
  const discoverTitle = (sol) => {
    const counterpart = findDiscoverLocalCounterpart(discoverSolutionId(sol));
    return counterpart
      ? getSkillDisplayName(counterpart)
      : getSkillDisplayName({ name: sol?.name || discoverSolutionId(sol) });
  };
  const hasCounterpart = (sol) =>
    Boolean(findDiscoverLocalCounterpart(discoverSolutionId(sol)));
  const ranked = [...filtered].sort(
    (a, b) =>
      discoverUsageCount(b) - discoverUsageCount(a) ||
      Number(hasCounterpart(b)) - Number(hasCounterpart(a)) ||
      discoverTitle(a).localeCompare(discoverTitle(b)),
  );
  skillsList.innerHTML = ranked.map(renderDiscoverSkillCard).join("");
  skillsList
    .querySelectorAll(".skill-discover-install-btn")
    .forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (btn.disabled || btn.dataset.busy === "true") return;
        const solutionId =
          btn.dataset.solutionId || btn.getAttribute("data-solution-id") || "";
        if (solutionId) void installDiscoverSolution(solutionId, btn);
      });
    });
  // Kebab items: View Details opens exactly what a card-body click opens;
  // Install mirrors the footer action.
  skillsList
    .querySelectorAll(".skill-discover-menu-details-btn")
    .forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        window.SkillCardRenderer?.closeAllCardMenus?.();
        const solutionId = btn.dataset.solutionId || "";
        if (!solutionId) return;
        const counterpart = findDiscoverLocalCounterpart(solutionId);
        if (counterpart) {
          void openSkillPage(counterpart);
          return;
        }
        const sol = ranked.find((s) => discoverSolutionId(s) === solutionId);
        if (sol) void openDiscoverSkillPage(sol);
      });
    });
  skillsList
    .querySelectorAll(".skill-discover-menu-install-btn")
    .forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        window.SkillCardRenderer?.closeAllCardMenus?.();
        const solutionId = btn.dataset.solutionId || "";
        if (solutionId) void installDiscoverSolution(solutionId);
      });
    });
  // Destructive items on installed-counterpart cards route through the exact
  // local-tab confirm flows (and their main-process agent-usage guards).
  // Blocked items stay inert but still stopPropagation — mcp-servers.js
  // wires an UNCONDITIONAL document-level closeAllDropdowns, so any bubbled
  // click slams the menu shut while the tooltip is showing.
  const wireDiscoverRemoveItem = (selector, action) => {
    skillsList.querySelectorAll(selector).forEach((btn) => {
      btn.addEventListener("click", (e) => {
        if (btn.getAttribute?.("aria-disabled") === "true") {
          e.stopPropagation();
          return;
        }
        e.stopPropagation();
        const counterpart = findDiscoverLocalCounterpart(
          btn.dataset.solutionId || "",
        );
        closeAllSkillDropdowns();
        if (counterpart) action(counterpart);
      });
    });
  };
  wireDiscoverRemoveItem(".skill-discover-menu-delete-btn", (skill) =>
    confirmDeleteSkill(skill),
  );
  wireDiscoverRemoveItem(".skill-discover-menu-uninstall-btn", (skill) =>
    confirmUninstallMarketplaceSkill(skill),
  );
  // Unpublish opens the shared confirm (never blocked client-side — the
  // published-agent dependency check runs on confirm, in the main process).
  skillsList
    .querySelectorAll(".skill-discover-menu-unpublish-btn")
    .forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const counterpart = findDiscoverLocalCounterpart(
          btn.dataset.solutionId || "",
        );
        closeAllSkillDropdowns();
        if (counterpart) unpublishSkill(counterpart);
      });
    });
  window.SkillCardRenderer?.attachCardMenus?.(skillsList);
  // Card click-through, like every other card surface. Index pairing is
  // sound ONLY against the ranked array the cards were rendered from —
  // querySelectorAll returns document order.
  skillsList.querySelectorAll(".skill-card").forEach((card, index) => {
    const sol = ranked[index];
    if (!sol) return;
    card.addEventListener("click", (e) => {
      if (
        e.target.closest(".mcp-card-menu-wrapper") ||
        e.target.closest(".mcp-card-dropdown") ||
        e.target.closest(".skill-card-actions") ||
        e.target.closest(".info-tooltip-trigger") ||
        e.target.closest("button")
      ) {
        return;
      }
      const counterpart = findDiscoverLocalCounterpart(discoverSolutionId(sol));
      if (counterpart) {
        // Local copy exists — the exact same page as the other tabs.
        void openSkillPage(counterpart);
        return;
      }
      void openDiscoverSkillPage(sol);
    });
  });
}

/**
 * Render the skills list
 */
function renderSkillsList() {
  const skillsList = document.getElementById("skills-list");
  if (!skillsList) return;

  if (isSkillsDiscoverActive()) {
    renderSkillsDiscover(skillsList);
    return;
  }

  const filteredSkills = getFilteredSkills();

  if (filteredSkills.length === 0) {
    if (skillsSearchQuery || skillsActiveFilter !== "all") {
      // Match MCP servers "no results" style - centered, simple, no button
      skillsList.innerHTML = `
        <div class="mcp-no-results">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="11" cy="11" r="8"></circle>
            <path d="m21 21-4.35-4.35"></path>
          </svg>
          <p>No skills match your search</p>
        </div>
      `;
    } else {
      // No skills available at all - show hint
      skillsList.innerHTML = `
        <div class="mcp-no-results">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
            <path d="M2 17l10 5 10-5"></path>
            <path d="M2 12l10 5 10-5"></path>
          </svg>
          <p>No skills available</p>
        </div>
      `;
    }
    return;
  }

  // Skills are already sorted by getFilteredSkills(): agent-used first
  // (count descending), then core, then others, alphabetically.
  skillsList.innerHTML = filteredSkills.map(renderSkillCard).join("");

  // Attach click handler for card body to open details modal
  skillsList.querySelectorAll(".skill-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      // Don't trigger if clicking on menu trigger, dropdown, buttons, or
      // tooltip triggers (badge hover units toggle their tooltip instead).
      if (
        e.target.closest(".mcp-card-menu-wrapper") ||
        e.target.closest(".mcp-card-menu-trigger") ||
        e.target.closest(".mcp-card-dropdown") ||
        e.target.closest(".info-tooltip-trigger")
      ) {
        return;
      }
      const skillName = card.dataset.skillName;
      const skill = skillsData.find((s) => s.name === skillName);
      if (skill) {
        void openSkillPage(skill);
      }
    });
  });

  // Attach click handlers for menu triggers (ellipsis menu)
  skillsList.querySelectorAll(".mcp-card-menu-trigger").forEach((trigger) => {
    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      const skillName = trigger.dataset.menuSkillName;
      const dropdown =
        trigger.parentElement.querySelector(".mcp-card-dropdown");
      const wasOpen = dropdown?.classList.contains("visible");

      // Close all other dropdowns first
      closeAllSkillDropdowns();

      if (!wasOpen && dropdown) {
        // Move dropdown to body to escape overflow clipping
        dropdown._originalParent = dropdown.parentElement;
        document.body.appendChild(dropdown);

        // Position dropdown using fixed positioning
        const btnRect = trigger.getBoundingClientRect();

        // Temporarily show dropdown to measure its real size
        dropdown.style.visibility = "hidden";
        dropdown.style.display = "block";
        const dropdownWidth = dropdown.offsetWidth;
        const dropdownHeight = dropdown.offsetHeight;
        dropdown.style.visibility = "";
        dropdown.style.display = "";

        // Open below the ellipsis and extend to its right (matches the
        // Integrations and Agents tabs). Viewport clamps below are the only
        // reason a menu should shift leftward.
        let left = btnRect.left;
        let top = btnRect.bottom + 4;
        let openUpward = false;

        // Check if dropdown would go off the bottom edge
        if (top + dropdownHeight > window.innerHeight - 8) {
          // Open upward instead
          top = btnRect.top - dropdownHeight - 4;
          openUpward = true;
        }

        // Ensure dropdown doesn't go off the top edge when opening upward
        if (openUpward && top < 8) {
          top = 8;
        }

        // Ensure dropdown doesn't go off screen horizontally
        if (left < 8) left = 8;
        if (left + dropdownWidth > window.innerWidth - 8) {
          left = window.innerWidth - dropdownWidth - 8;
        }

        dropdown.style.top = `${top}px`;
        dropdown.style.left = `${left}px`;

        // Add class for upward opening animation if needed
        dropdown.classList.toggle("open-upward", openUpward);

        dropdown.classList.add("visible");
      }
    });
  });

  // Attach click handlers for Details button in dropdown
  skillsList.querySelectorAll(".skill-details-menu-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const skillName = btn.dataset.skillName;
      const skill = skillsData.find((s) => s.name === skillName);
      closeAllSkillDropdowns();
      if (skill) {
        void openSkillPage(skill);
      }
    });
  });

  // Attach click handlers for Duplicate button in dropdown
  skillsList.querySelectorAll(".skill-duplicate-menu-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (btn.dataset.busy === "true") return;
      const skillName = btn.dataset.skillName;
      const skill = skillsData.find((s) => s.name === skillName);
      if (skill) {
        void duplicateSkillAction(skill, btn);
      }
    });
  });

  // Attach click handlers for Convert-to-editable-copy button in dropdown
  skillsList.querySelectorAll(".skill-reclaim-menu-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (btn.dataset.busy === "true") return;
      const skillName = btn.dataset.skillName;
      const skill = skillsData.find((s) => s.name === skillName);
      closeAllSkillDropdowns();
      if (skill) {
        confirmReclaimInstalledSkillCopy(skill);
      }
    });
  });

  // Attach click handlers for Update-from-marketplace button in dropdown
  skillsList.querySelectorAll(".skill-update-menu-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (btn.dataset.busy === "true") return;
      const skillName = btn.dataset.skillName;
      const skill = skillsData.find((s) => s.name === skillName);
      closeAllSkillDropdowns();
      if (skill) {
        void updateInstalledSkillFromMarketplace(skill);
      }
    });
  });

  // Attach click handlers for Open Folder button in dropdown
  skillsList.querySelectorAll(".skill-open-folder-menu-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const skillName = btn.dataset.skillName;
      const skill = skillsData.find((s) => s.name === skillName);
      closeAllSkillDropdowns();
      if (skill) {
        void openSkillFolderForSkill(skill);
      }
    });
  });

  // Attach click handlers for Export Skill button in dropdown
  skillsList.querySelectorAll(".skill-export-menu-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const skillName = btn.dataset.skillName;
      const skill = skillsData.find((s) => s.name === skillName);
      closeAllSkillDropdowns();
      if (skill) {
        void exportSkillForSkill(skill);
      }
    });
  });

  // Attach click handlers for the Publish (AI Marketplace) button in dropdown
  skillsList
    .querySelectorAll(".skill-publish-ai-marketplace-menu-btn")
    .forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (btn.dataset.busy === "true") return;
        const skillName = btn.dataset.skillName;
        const skill = skillsData.find((s) => s.name === skillName);
        if (skill) {
          void publishSkillToAiMarketplace(skill, btn);
        }
      });
    });

  // Attach click handlers for Delete button in dropdown
  skillsList.querySelectorAll(".skill-delete-menu-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      // Blocked by agent references: inert, but still stopPropagation —
      // mcp-servers.js wires an UNCONDITIONAL document-level
      // closeAllDropdowns, so any bubbled click slams the menu shut.
      // Hover/focus own the explanation tooltip; the click does nothing.
      if (btn.getAttribute?.("aria-disabled") === "true") {
        e.stopPropagation();
        return;
      }
      e.stopPropagation();
      const skillName = btn.dataset.skillName;
      const skill = skillsData.find((s) => s.name === skillName);
      closeAllSkillDropdowns();
      if (skill) {
        confirmDeleteSkill(skill);
      }
    });
  });

  // Attach click handlers for Uninstall (marketplace-installed skills only)
  skillsList.querySelectorAll(".skill-uninstall-menu-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      if (btn.getAttribute?.("aria-disabled") === "true") {
        e.stopPropagation();
        return;
      }
      e.stopPropagation();
      const skillName = btn.dataset.skillName;
      const skill = skillsData.find((s) => s.name === skillName);
      closeAllSkillDropdowns();
      if (skill) {
        confirmUninstallMarketplaceSkill(skill);
      }
    });
  });

  // Close dropdowns when clicking elsewhere
  document.addEventListener("click", handleSkillDropdownOutsideClick);
}

// Track current open dropdown
let openSkillDropdownName = null;

/**
 * Close all skill dropdowns and return them to their original parents
 */
function closeAllSkillDropdowns() {
  document
    .querySelectorAll(".mcp-card-dropdown.visible")
    .forEach((dropdown) => {
      dropdown.classList.remove("visible");
      // Return to original parent if moved
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
  openSkillDropdownName = null;
}

/**
 * Handle clicks outside of skill dropdowns
 */
function handleSkillDropdownOutsideClick(e) {
  if (
    !e.target.closest(".mcp-card-menu-wrapper") &&
    !e.target.closest(".mcp-card-dropdown")
  ) {
    closeAllSkillDropdowns();
  }
}

// Track skill pending deletion for modal
let skillPendingDelete = null;

/**
 * Show the delete skill confirmation modal
 */
function showDeleteSkillModal(skill) {
  skillPendingDelete = skill;
  const modal = document.getElementById("delete-skill-modal");
  const skillNameEl = document.getElementById("delete-skill-name");

  if (modal && skillNameEl) {
    skillNameEl.textContent = getSkillDisplayName(skill);
    modal.classList.add("visible");
  }
}

/**
 * Hide the delete skill confirmation modal
 */
function hideDeleteSkillModal() {
  const modal = document.getElementById("delete-skill-modal");
  if (modal) {
    modal.classList.remove("visible");
  }
  skillPendingDelete = null;
}

/**
 * Execute the skill deletion after confirmation
 */
async function executeDeleteSkill() {
  if (!skillPendingDelete) return;

  const skill = skillPendingDelete;
  hideDeleteSkillModal();

  try {
    // Call IPC to delete skill
    const result = await window.electronAPI.deleteSkill(
      skill.name,
      skill.skill_path,
    );
    if (result.success) {
      // Remove from local data and re-render
      skillsData = skillsData.filter((s) => s.name !== skill.name);
      // If the deleted skill's inline page is open, close it back to the list.
      if (skillPage?.skill?.name === skill.name) {
        teardownSkillPage();
      }
      renderSkillsList();
      console.log(`[Agent Skills] Deleted skill: ${skill.name}`);
      if (window.showNotification) {
        window.showNotification(
          `Skill "${getSkillDisplayName(skill)}" deleted successfully`,
          "success",
        );
      }
    } else if (skillInUseGuardCode(result)) {
      showSkillInUseByAgentsModal({
        message: result.error,
        agents: result.body?.agents || [],
      });
    } else {
      if (window.showNotification) {
        window.showNotification(
          `Failed to delete skill: ${result.error}`,
          "error",
        );
      } else {
        alert(`Failed to delete skill: ${result.error}`);
      }
    }
  } catch (error) {
    console.error("[Agent Skills] Error deleting skill:", error);
    if (window.showNotification) {
      window.showNotification(
        `Error deleting skill: ${error.message}`,
        "error",
      );
    } else {
      alert(`Error deleting skill: ${error.message}`);
    }
  }
}

/**
 * Setup delete skill modal event listeners
 */
function setupDeleteSkillModalListeners() {
  const modal = document.getElementById("delete-skill-modal");
  const closeBtn = document.getElementById("delete-skill-modal-close-btn");
  const cancelBtn = document.getElementById("delete-skill-cancel-btn");
  const confirmBtn = document.getElementById("delete-skill-confirm-btn");

  // Close button
  if (closeBtn) {
    closeBtn.addEventListener("click", hideDeleteSkillModal);
  }

  // Cancel button
  if (cancelBtn) {
    cancelBtn.addEventListener("click", hideDeleteSkillModal);
  }

  // Confirm button
  if (confirmBtn) {
    confirmBtn.addEventListener("click", executeDeleteSkill);
  }

  // Click outside modal to close
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        hideDeleteSkillModal();
      }
    });
  }

  // Escape key to close
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal?.classList.contains("visible")) {
      hideDeleteSkillModal();
    }
  });
}

/**
 * Confirm and delete a skill (shows modal)
 */
function confirmDeleteSkill(skill) {
  showDeleteSkillModal(skill);
}

async function openSkillFolderForSkill(skill) {
  if (!skill?.skill_path) return;

  try {
    const result = await window.electronAPI.openSkillFolder(skill.skill_path);
    if (!result?.success) {
      throw new Error(result?.error || "Failed to open skill folder");
    }
  } catch (error) {
    console.error("[Agent Skills] Error opening skill folder:", error);
    if (window.showNotification) {
      window.showNotification(
        `Failed to open skill folder: ${error.message}`,
        "error",
      );
    } else {
      alert(`Failed to open skill folder: ${error.message}`);
    }
  }
}

async function exportSkillForSkill(skill) {
  if (!skill?.skill_path) return;

  try {
    const result = await window.electronAPI.exportSkill(skill.skill_path);
    if (!result?.success) {
      throw new Error(result?.error || "Failed to export skill");
    }
    if (window.showNotification) {
      window.showNotification(
        `Skill archive created: ${result.path}`,
        "success",
      );
    }
  } catch (error) {
    console.error("[Agent Skills] Error exporting skill:", error);
    if (window.showNotification) {
      window.showNotification(
        `Failed to export skill: ${error.message}`,
        "error",
      );
    } else {
      alert(`Failed to export skill: ${error.message}`);
    }
  }
}

/**
 * Publish a copy of a local skill to the AI Marketplace.
 */
function setSkillMenuActionBusy(button, label) {
  if (!button) return () => {};
  const originalHtml = button.innerHTML;
  const originalDisabled = button.disabled;
  button.disabled = true;
  button.dataset.busy = "true";
  button.setAttribute("aria-busy", "true");
  button.innerHTML = `<div class="btn-spinner"></div> ${escapeHtml(label)}`;
  return () => {
    button.innerHTML = originalHtml;
    button.disabled = originalDisabled;
    button.removeAttribute("aria-busy");
    delete button.dataset.busy;
  };
}

async function publishSkillToAiMarketplace(skill, triggerBtn = null) {
  const api = window.electronAPI?.aiMarketplace;
  if (!api) {
    if (window.showNotification) {
      window.showNotification(
        "AI Marketplace client is unavailable in this build.",
        "error",
      );
    }
    return;
  }
  if (!skill?.skill_path) {
    if (window.showNotification) {
      window.showNotification(
        "Skill has no local path; cannot publish.",
        "error",
      );
    }
    return;
  }
  if (skill.source !== "user") {
    if (window.showNotification) {
      window.showNotification(
        skill.source === "marketplace"
          ? "Marketplace-installed skills are read-only. Use Duplicate to create an editable user copy before publishing."
          : "System skills are read-only. Use Duplicate to create an editable user copy before publishing.",
        "info",
      );
    }
    return;
  }

  // App-styled confirmation (same modal the unpublish path uses) instead of a
  // native window.confirm alert.
  const confirmName = canonicalSkillName(skill.name);
  if (skillHasUnverifiedMarketplaceLink(skill)) {
    if (window.showNotification) {
      window.showNotification(
        "This skill's Marketplace ownership could not be verified. Refresh the page before publishing.",
        "error",
      );
    }
    return;
  }
  const republish = Boolean(authoritativeSkillMarketplaceLink(skill));
  window.showAgentsConfirmModal({
    title: republish ? "Republish?" : "Publish?",
    message: `Publish "${confirmName}" to the AI Marketplace so everyone at Portico can use it.`,
    confirmLabel: republish ? "Republish" : "Publish",
    onConfirm: () => {
      void performPublishSkillToAiMarketplace(skill, triggerBtn);
    },
  });
}

// The actual publish work, run only after the user confirms.
async function performPublishSkillToAiMarketplace(skill, triggerBtn = null) {
  const api = window.electronAPI?.aiMarketplace;
  try {
    const canonicalName = canonicalSkillName(skill.name);
    // The dropdown menu item may have been detached while the confirm modal
    // was up (menus close on re-render) — fall back to the page-level publish
    // button so the user still sees a busy indicator during the publish.
    const busyTarget =
      triggerBtn && triggerBtn.isConnected
        ? triggerBtn
        : document.querySelector(".skill-page-publish-btn");
    const restoreButton = setSkillMenuActionBusy(busyTarget, "Publishing...");
    try {
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

      const usernameRes = await window.electronAPI?.getUsername?.();
      const author =
        (usernameRes && usernameRes.username) || skill.author || "unknown";

      const description =
        skill.description ||
        `Agent Skill "${canonicalName}" published via Portico.`;
      const fallbackDetailUrl = `https://solutions.sandbox.example.invalid/?type=${encodeURIComponent(
        bundle?.type || "skills",
      )}`;
      const detailUrl =
        skill.git_url ||
        skill.marketplace_url ||
        bundle?.payload?.source?.git_url ||
        fallbackDetailUrl;

      const solutionInput = {
        name: canonicalName,
        description,
        author,
        detail_url: detailUrl,
        type: "skills",
        bundle,
      };
      const linkRes = await api.getSkillLink?.(canonicalName);
      const existingSolutionId = linkRes?.link?.solutionId || null;
      let resolvedSolutionId = existingSolutionId;
      if (existingSolutionId) {
        const updateRes = await api.update(existingSolutionId, solutionInput, {
          localSkillId: canonicalName,
        });
        if (!updateRes?.success) {
          throw new Error(updateRes?.error || "Failed to update skill");
        }
      }
      if (!resolvedSolutionId) {
        const publishRes = await api.publish(solutionInput, {
          localSkillId: canonicalName,
        });
        if (!publishRes?.success) {
          throw new Error(publishRes?.error || "Failed to publish skill");
        }
        resolvedSolutionId =
          publishRes.data?.id || publishRes.data?.solution_id || publishRes.data?.uuid;
        if (!resolvedSolutionId) {
          throw new Error("Marketplace did not return a skill solution id");
        }
      }
      await api.setSkillLink?.(canonicalName, resolvedSolutionId);
      // Publish success means local == marketplace; refresh badge state on
      // both the open page (if any) and the list cards.
      skillsMarketplaceLinks[canonicalName] = {
        ...(skillsMarketplaceLinks[canonicalName] || {}),
        solutionId: resolvedSolutionId,
        hasLocalChanges: false,
      };
      skillsPublishedSolutionIds.add(resolvedSolutionId);
      logSkillsMarketplace("publish:result", {
        skillId: canonicalName,
        solutionId: resolvedSolutionId,
        success: true,
      });
      // The Agents publish modal caches the owned-listings page per session.
      window.AgentsPublishHooks?.invalidateMarketplaceSkillLookups?.();
      refreshSkillPageMarketplaceState();
      renderSkillsList();
      if (window.showNotification) {
        window.showNotification(
          `Published "${canonicalName}" to AI Marketplace.`,
          "success",
        );
      }
    } finally {
      restoreButton();
      closeAllSkillDropdowns();
    }
  } catch (error) {
    console.error("[Agent Skills] Error publishing skill:", error);
    logSkillsMarketplace("publish:result", {
      skillId: canonicalSkillName(skill?.name || ""),
      success: false,
      errorMessage: String(error?.message || error).slice(0, 200),
    });
    if (window.showNotification) {
      window.showNotification(
        `Failed to publish skill: ${error.message}`,
        "error",
      );
    } else {
      alert(`Failed to publish skill: ${error.message}`);
    }
  }
}

/**
 * Clear all skills filters
 */
function clearSkillsFilters() {
  skillsSearchQuery = "";

  const searchInput = document.getElementById("skills-search-input");
  if (searchInput) searchInput.value = "";

  applySkillsActiveFilter("all");
}

// ============================================================================
// INLINE SKILL PAGE
// Replaces the details modal: renders into #agent-skills-editor using the
// same page chrome classes as the Agents inline pages, hosting the existing
// file tree + tabbed viewer (fixed ids) plus per-file editing for user skills
// and marketplace publish parity actions.
// ============================================================================

function skillPageHasUnsavedEdits() {
  return skillDetailsTabs.some(
    (tab) => tab.editing && (tab.draft ?? tab.content) !== tab.content,
  );
}

function teardownSkillPage() {
  const returnToMarketplace = skillPage?.returnToMarketplaceDetails === true;
  const host = document.getElementById("agent-skills-editor");
  if (host) {
    host.innerHTML = "";
    host.style.display = "none";
  }
  skillPage = null;
  currentSkillForDetails = null;
  skillDetailsTabs = [];
  activeSkillTabId = null;
  // A page opened from the marketplace details page hands the subview back
  // to it (state and DOM were suspended, not torn down). Resume failing —
  // the page was closed meanwhile — falls through to the browser restore.
  if (
    returnToMarketplace &&
    typeof window.resumeMarketplaceDetailsPage === "function" &&
    window.resumeMarketplaceDetailsPage() === true
  ) {
    return;
  }
  const browser = document.getElementById("agent-skills-browser");
  if (browser) browser.style.display = "";
  // Restore the Sync All / Add Marketplace actions only if the skills subview
  // is still the active one.
  if (window.appState?.controlPlaneView === "agent-skills") {
    const actions = document.getElementById("skills-header-actions");
    if (actions) actions.style.display = "";
    updateSkillsHeaderActions();
  }
}

// Close the page, warning first when a file edit has unsaved changes.
function requestCloseSkillPage(onAfterClose) {
  if (!skillPage) return;
  if (!skillPageHasUnsavedEdits()) {
    teardownSkillPage();
    onAfterClose?.();
    return;
  }
  const subject = getSkillDisplayName(skillPage.skill) || "this skill";
  if (typeof window.showAgentsDiscardModal === "function") {
    window.showAgentsDiscardModal({
      subject,
      onDiscard: () => {
        teardownSkillPage();
        onAfterClose?.();
      },
    });
  } else if (window.confirm("You have unsaved changes. Discard them?")) {
    teardownSkillPage();
    onAfterClose?.();
  }
}

// Plugin provenance chip — same shape the skill cards use, so a plugin skill
// is recognizable on its detail page too.
function skillPluginChipHtml(pluginName) {
  if (!pluginName) return "";
  const shared = window.SkillCardRenderer?.skillCardPluginBadgeHtml;
  if (typeof shared === "function") return shared(pluginName);
  const label = String(pluginName);
  return `<span class="mcp-card-badge badge-plugin" title="${escapeHtmlAttribute(`From plugin ${label}`)}">${escapeHtml(label)}</span>`;
}

function buildSkillPageChipsHtml(skill) {
  if (!skill) return "";
  if (skill.source === GIT_MARKETPLACE_LISTING_SOURCE) {
    const rec = skill.git_listing || {};
    const installedChip = rec.installed
      ? `<span class="mcp-card-badge badge-installed">Installed</span>`
      : "";
    const marketplaceName = rec.marketplaceName || rec.marketplaceId || "";
    const marketplaceChip = marketplaceName
      ? `<span class="mcp-card-badge badge-marketplace-name" title="${escapeHtmlAttribute(marketplaceName)}">${escapeHtml(marketplaceName)}</span>`
      : "";
    return `${installedChip}${marketplaceChip}${skillPluginChipHtml(rec.pluginName)}`;
  }
  if (skill.source === SKILLS_DISCOVER_LISTING_SOURCE) {
    // Remote listing: no local-source chip. Published must be EXACT-ID
    // verified — never authoritativeSkillMarketplaceLink, whose
    // canonical-name fallback would false-Publish a listing that merely
    // shares a name with a linked local skill.
    const solutionId = String(skill.marketplace_solution_id || "");
    return skillsPublishedSolutionIds.has(solutionId)
      ? `<span class="mcp-card-badge badge-published" title="You publish this listing (solution ${escapeHtmlAttribute(solutionId)})">Published</span>`
      : "";
  }
  // Source badge (CORE/USER/INSTALLED) uses the app-wide badge tokens so it
  // matches the same badge everywhere else.
  const sourceBadge = `<span class="mcp-card-badge ${getSourceBadgeClass(skill.source)}">${getSourceBadgeLabel(skill.source)}</span>`;
  const marketplaceName =
    skill.source === "marketplace"
      ? skill.marketplace_name || skill.marketplace_id || null
      : null;
  const marketplaceBadge = marketplaceName
    ? `<span class="mcp-card-badge badge-marketplace-name" title="${escapeHtmlAttribute(marketplaceName)}">${escapeHtml(marketplaceName)}</span>`
    : "";
  const link = authoritativeSkillMarketplaceLink(skill);
  const published = link
    ? `<span class="mcp-card-badge badge-published" title="Linked to AI Marketplace solution ${escapeHtmlAttribute(link.solutionId)}">Published</span>`
    : "";
  const unpublished = link?.hasLocalChanges
    ? `<span class="mcp-card-badge badge-unpublished" title="Local edits not yet published to the marketplace">Unpublished changes</span>`
    : "";
  // Author chips mirror the card renderer: ownership comes EXCLUSIVELY from
  // the durable authenticated creator email for user skills — never the
  // spoofable frontmatter `author`, which is only trusted for core/installed
  // copies that have no local creator identity.
  const pageAuthor =
    skill.source === "user"
      ? normalizeCreatorLdap(skill.created_by_email) || "Unknown"
      : skill.author || "Unknown";
  const authorChips = String(pageAuthor)
    .split(",")
    .map((author) => author.trim())
    .filter(Boolean)
    .map(
      (author) => `<span class="mcp-card-badge badge-author">${escapeHtml(author)}</span>`,
    )
    .join("");
  // Same ordering as the facet filters: User, Published, Installed — the
  // Installed source chip (+ its marketplace name) renders after Published.
  const pluginChip = skillPluginChipHtml(skill.plugin_name);
  return skill.source === "marketplace"
    ? `${published}${sourceBadge}${marketplaceBadge}${pluginChip}${unpublished}${authorChips}`
    : `${sourceBadge}${published}${pluginChip}${unpublished}${authorChips}`;
}

// Header action buttons for the skill page, gated per source (user skills are
// editable/publishable; system read-only; marketplace copies detach first).
function buildSkillPageActionsHtml(skill) {
  if (!skill) return "";
  const name = escapeHtmlAttribute(skill.name || "");
  const link = authoritativeSkillMarketplaceLink(skill);
  const publishStateIsUnknown = skillHasUnverifiedMarketplaceLink(skill);
  const button = (cls, label, svgPath, { danger = false, disabled = false, title = "", blockedBy = null } = {}) => {
    const deco = agentsBlockedDeco(blockedBy);
    return `
    <button class="btn-secondary agent-page-action${danger ? " agent-page-action-danger" : ""} ${cls}${deco.triggerClass}" type="button" data-skill-name="${name}"${deco.attrs}${disabled ? " disabled" : ""}${title ? ` title="${escapeHtmlAttribute(title)}"` : ""}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${svgPath}</svg>
      ${label}
    </button>`;
  };
  if (skill.source === SKILLS_DISCOVER_LISTING_SOURCE) {
    // Remote listing: the only action is Install (mirrors the Discover card).
    const hasBundle = skill.has_bundle !== false;
    return button(
      "skill-page-install-btn",
      "Install Skill",
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line>',
      hasBundle ? {} : { disabled: true, title: "No bundle attached" },
    );
  }
  if (skill.source === GIT_MARKETPLACE_LISTING_SOURCE) {
    // Git-marketplace listing: Install, or the shared green state indicator
    // once installed (same face as the cards).
    if (skill.git_listing?.installed) {
      return `<button class="btn-primary agent-page-action btn-all-installed" type="button" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg> Installed</button>`;
    }
    return button(
      "skill-page-git-install-btn",
      "Install Skill",
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line>',
    );
  }
  // Info icon beside Publish: what publishing means (Noopur's copy). A
  // SIBLING of the button — triggers must never nest inside interactive
  // elements or the action handler would fire alongside the tooltip.
  const publishShareTooltip =
    window.InfoTooltips?.triggerHtml?.(
      "Share this skill with everyone at Portico so they can add it to their own AI Chat sessions.",
    ) || "";
  const publishBtn =
    skill.source === "user" && !publishStateIsUnknown
      ? `${button(
          "skill-page-publish-btn",
          link ? "Republish" : "Publish",
          '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line>',
        )}${publishShareTooltip}`
      : "";
  const unpublishBtn = link
    ? button(
        "skill-page-unpublish-btn",
        "Unpublish",
        '<path d="M12 5v14"></path><path d="M19 12l-7 7-7-7"></path>',
      )
    : "";
  const duplicateBtn = skill.skill_path
    ? button(
        "skill-page-duplicate-btn",
        "Duplicate",
        '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>',
      )
    : "";
  const openFolderBtn = button(
    "skill-page-open-folder-btn",
    getSkillFolderMenuLabel(),
    '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>',
  );
  const exportBtn = skill.skill_path
    ? button(
        "skill-page-export-btn",
        "Export",
        '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line>',
      )
    : "";
  // Agent references grey Delete/Uninstall with the explanation tooltip.
  const usedByAgents =
    skillsAgentUsage.get(canonicalSkillName(skill.name)) || [];
  const deleteBtn = button(
    "skill-page-delete-btn",
    "Delete",
    '<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>',
    { danger: true, blockedBy: usedByAgents },
  );
  if (skill.source === "user") {
    return `${publishBtn}${unpublishBtn}${duplicateBtn}${openFolderBtn}${exportBtn}${deleteBtn}`;
  }
  if (skill.source === "marketplace") {
    // The local install remains read-only. A viewer-owned remote listing may
    // still be unpublished because remote ownership is an independent fact.
    // Managed copies uninstall (registry-pruning) instead of deleting;
    // BUILT-IN bundle seeds cannot uninstall at all (the seeder restores
    // them), so their page offers no impossible action.
    if (skill.ootb_seeded === true) {
      const builtinBtn = `
      <button class="btn-secondary skill-page-builtin-btn" type="button" disabled title="Ships with the app — cannot be uninstalled. Use Duplicate to create an editable user copy.">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="7" width="18" height="13" rx="2"></rect><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
        Built-in
      </button>`;
      return `${unpublishBtn}${duplicateBtn}${exportBtn}${builtinBtn}`;
    }
    const uninstallBtn = button(
      "skill-page-uninstall-btn",
      "Uninstall",
      '<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>',
      { danger: true, blockedBy: usedByAgents },
    );
    return `${unpublishBtn}${duplicateBtn}${exportBtn}${uninstallBtn}`;
  }
  // System/core skills are read-only.
  return `${duplicateBtn}${exportBtn}`;
}

// Re-render the page chips + actions after publish/install state changed.
function refreshSkillPageMarketplaceState() {
  if (!skillPage) return;
  const chipsEl = document.querySelector("[data-skill-page-chips]");
  if (chipsEl) chipsEl.innerHTML = buildSkillPageChipsHtml(skillPage.skill);
  const actionsEl = document.querySelector("[data-skill-page-actions]");
  if (actionsEl) {
    actionsEl.innerHTML = buildSkillPageActionsHtml(skillPage.skill);
  }
  // Git-listing pages also flip their banner copy (installed vs not).
  if (skillPage.skill?.source === GIT_MARKETPLACE_LISTING_SOURCE) {
    const bannerEl = document.querySelector("[data-skill-page-banner]");
    if (bannerEl) bannerEl.textContent = gitListingBannerText(skillPage.skill);
  }
}

// Referential-integrity guard errors carry a coded envelope with the list of
// agents using the skill; recognize both IPC envelope key spellings.
function skillInUseGuardCode(result) {
  const code = result?.errorCode || result?.code;
  return code === "skill_in_use_by_agents" ||
    code === "skill_dependency_of_published_agents"
    ? code
    : null;
}

// Blocking explanation modal for guard errors: names the agents so the user
// can detach the skill (or unpublish the agents) first. The main-process
// message already carries the full explanation; the agents list is the
// fallback when only the body survived.
function showSkillInUseByAgentsModal({ title, message, agents = [] } = {}) {
  const names = agents
    .map((agent) => `"${agent?.name || agent?.id || "unknown agent"}"`)
    .join(", ");
  const text =
    message ||
    `This skill is attached to: ${names}. Remove it from those agents first, then try again.`;
  if (typeof window.showAgentsConfirmModal === "function") {
    window.showAgentsConfirmModal({
      title: title || "Skill is attached to agents",
      message: text,
      confirmLabel: "Close",
      onConfirm: () => {},
    });
  } else {
    showNotification(text, "error");
  }
}

// Derive the real uninstall identity from a browse-grid card: `name` is the
// canonical FQN (mp/skill or mp/plugin/skill) and marketplace_id/plugin_name
// are first-class on marketplace-installed entries.
function marketplaceUninstallTarget(skill) {
  const segments = String(skill?.name || "")
    .split("/")
    .filter(Boolean);
  const marketplaceId =
    (typeof skill?.marketplace_id === "string" && skill.marketplace_id.trim()) ||
    (segments.length >= 2 ? segments[0] : "");
  const pluginName =
    (typeof skill?.plugin_name === "string" && skill.plugin_name.trim()) ||
    (segments.length >= 3 ? segments[1] : null);
  return {
    marketplaceId,
    pluginName: pluginName || null,
    bareSkillId: segments.length
      ? segments[segments.length - 1]
      : String(skill?.name || ""),
  };
}

// Uninstall a marketplace-installed copy through the REAL uninstall pipeline
// (registry prune + directory removal + empty-parent cleanup) — never the
// legacy delete path, whose managed-install bookkeeping was partial.
function confirmUninstallMarketplaceSkill(skill) {
  const target = marketplaceUninstallTarget(skill);
  if (!target.marketplaceId) {
    showNotification("This skill has no marketplace identity to uninstall.", "error");
    return;
  }
  const displayName = getSkillDisplayName(skill);
  const marketplaceLabel = skill.marketplace_name || target.marketplaceId;
  if (typeof window.showAgentsConfirmModal === "function") {
    window.showAgentsConfirmModal({
      title: "Uninstall skill?",
      message: `Uninstall "${displayName}" (installed from ${marketplaceLabel})? You can reinstall it from the marketplace anytime.`,
      confirmLabel: "Uninstall",
      confirmBusyLabel: "Uninstalling...",
      danger: true,
      // Returning the promise lets the confirm modal surface failures inline.
      onConfirm: () => performUninstallMarketplaceSkill(skill, target),
    });
  } else if (window.confirm(`Uninstall "${displayName}"?`)) {
    void performUninstallMarketplaceSkill(skill, target).catch((error) => {
      showNotification(`Failed to uninstall skill: ${error.message}`, "error");
    });
  }
}

async function performUninstallMarketplaceSkill(
  skill,
  target = marketplaceUninstallTarget(skill),
) {
  const result = await window.electronAPI.uninstallMarketplaceSkill(
    target.marketplaceId,
    target.bareSkillId,
    target.pluginName,
  );
  if (!result?.success) {
    if (skillInUseGuardCode(result)) {
      // Swap the confirm for the blocking explanation (the confirm modal's
      // session guard keeps the re-shown modal open when this resolves).
      showSkillInUseByAgentsModal({
        message: result.error,
        agents: result.body?.agents || [],
      });
      return;
    }
    throw new Error(result?.error || "Failed to uninstall skill");
  }
  skillsData = skillsData.filter((s) => s.name !== skill.name);
  if (skillPage?.skill?.name === skill.name) {
    teardownSkillPage();
  }
  renderSkillsList();
  showNotification(`Skill "${getSkillDisplayName(skill)}" uninstalled`, "success");
  logSkillsMarketplace("uninstall:result", {
    skillId: skill.name,
    marketplaceId: target.marketplaceId,
    success: true,
  });
  await loadSkills();
}

// Remove the marketplace copy of a published skill (local skill is kept).
// Confirming runs the marketplace-side published-agent dependency check
// (main process, fail-closed) under the modal's spinner — a blocked result
// surfaces inline so the user learns to unpublish the agent first.
function unpublishSkill(skill, triggerBtn = null) {
  const api = window.electronAPI?.aiMarketplace;
  const canonicalName = canonicalSkillName(skill?.name);
  const link = authoritativeSkillMarketplaceLink(skill);
  if (!api || !link?.solutionId) return;
  if (typeof window.showAgentsConfirmModal === "function") {
    window.showAgentsConfirmModal({
      title: "Unpublish?",
      message: `Remove "${canonicalName}" from the AI Marketplace? The local skill will be kept.`,
      meta: { badge: link.solutionId },
      confirmLabel: "Unpublish",
      confirmBusyLabel: "Checking...",
      danger: true,
      // Awaited under the modal's busy spinner; throwing keeps the modal
      // open with the inline explanation (e.g. published agents still use
      // this listing).
      onConfirm: () =>
        performUnpublishSkill(api, canonicalName, link.solutionId, triggerBtn, {
          clearLocalLink: skill?.source === "user",
          rethrow: true,
        }),
    });
  } else if (
    window.confirm(
      `Remove "${canonicalName}" from the AI Marketplace? The local skill will be kept.`,
    )
  ) {
    void performUnpublishSkill(api, canonicalName, link.solutionId, triggerBtn, {
      clearLocalLink: skill?.source === "user",
    });
  }
}

async function performUnpublishSkill(
  api,
  canonicalName,
  solutionId,
  triggerBtn = null,
  { clearLocalLink = true, rethrow = false } = {},
) {
  const restoreButton = setSkillMenuActionBusy(triggerBtn, "Removing...");
  try {
    const res = await api.delete(solutionId);
    if (!res?.success) {
      throw new Error(res?.error || "Failed to delete marketplace solution");
    }
    if (clearLocalLink) {
      await api.clearSkillLink?.(canonicalName);
      delete skillsMarketplaceLinks[canonicalName];
    }
    skillsPublishedSolutionIds.delete(solutionId);
    logSkillsMarketplace("unpublish:result", {
      skillId: canonicalName,
      solutionId,
      success: true,
    });
    // The Agents publish modal caches the owned-listings page per session.
    window.AgentsPublishHooks?.invalidateMarketplaceSkillLookups?.();
    if (window.showNotification) {
      window.showNotification("Marketplace copy removed.", "success");
    }
    refreshSkillPageMarketplaceState();
    renderSkillsList();
  } catch (error) {
    console.error("[Agent Skills] Error unpublishing skill:", error);
    // rethrow: the caller (the confirm modal) renders the failure inline —
    // the dependency-guard message stays in front of the user instead of
    // racing by as a toast.
    if (rethrow) throw error;
    if (window.showNotification) {
      window.showNotification(
        `Failed to unpublish skill: ${error.message}`,
        "error",
      );
    }
  } finally {
    restoreButton();
  }
}

// Duplicate any skill into an editable copy under skills-user/ and open it.
async function duplicateSkillAction(skill, triggerBtn = null) {
  if (!skill?.skill_path) return;
  closeAllSkillDropdowns();
  // Ask the user to name the copy. A duplicate is always a new USER skill with
  // no marketplace link; its name becomes the directory/skill id. It must be
  // unique among ALL skills (system/user/marketplace) — a name colliding with a
  // core or marketplace skill would be silently shadowed by get-skills' source
  // precedence, so validate against every source.
  const existingSkillNames = skillsData.map((entry) => entry.name);
  const chosenName = await promptForSkillName({
    title: "Duplicate skill",
    label: "New skill name",
    initialValue: `${getSkillDisplayName(skill)} Copy`,
    confirmLabel: "Duplicate",
    existingSkillNames,
  });
  if (!chosenName) return; // cancelled

  const restoreButton = setSkillMenuActionBusy(triggerBtn, "Duplicating...");
  try {
    const result = await window.electronAPI?.duplicateSkill?.(
      skill.skill_path,
      chosenName,
      { exact: true },
    );
    if (!result?.success) {
      throw new Error(result?.error || "Failed to duplicate skill");
    }
    await loadSkills();
    applySkillsActiveFilter("user");
    if (window.showNotification) {
      window.showNotification(
        `Created editable copy "${result.skillName}" in your User skills.`,
        "success",
      );
    }
    const copy = skillsData.find(
      (entry) => entry.name === result.skillName && entry.source === "user",
    );
    if (copy) {
      openSkillPage(copy);
    }
  } catch (error) {
    console.error("[Agent Skills] Error duplicating skill:", error);
    if (window.showNotification) {
      window.showNotification(
        `Failed to duplicate skill: ${error.message}`,
        "error",
      );
    }
  } finally {
    restoreButton();
  }
}

// Lightweight name-entry modal for the Duplicate flow. Reuses the discard-modal
// chrome for a consistent look. Resolves the trimmed name, or null on cancel.
function promptForSkillName({
  title = "Name skill",
  label = "Skill name",
  initialValue = "",
  confirmLabel = "Save",
  existingSkillNames = [],
} = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "agents-discard-modal skill-name-modal";
    overlay.innerHTML = `
      <div class="agents-discard-modal-content skill-name-modal-content">
        <h2 class="agents-discard-modal-title">${escapeHtml(title)}</h2>
        <div class="skill-name-modal-field">
          <label class="skill-name-modal-label">${escapeHtml(label)}</label>
          <input type="text" class="skill-name-modal-input" spellcheck="false" autocomplete="off" />
          <p class="skill-name-modal-error" role="alert"></p>
        </div>
        <div class="agents-discard-modal-buttons">
          <button class="btn btn-secondary skill-name-modal-cancel" type="button">Cancel</button>
          <button class="btn btn-primary skill-name-modal-confirm" type="button">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const input = overlay.querySelector(".skill-name-modal-input");
    const errorEl = overlay.querySelector(".skill-name-modal-error");
    const confirmBtn = overlay.querySelector(".skill-name-modal-confirm");
    const cancelBtn = overlay.querySelector(".skill-name-modal-cancel");
    input.value = initialValue;

    let settled = false;
    const cleanup = () => {
      document.removeEventListener("keydown", onKeydown, true);
      overlay.remove();
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const revalidate = () => {
      const { valid, error } = validateSkillName(input.value, {
        existingSkillNames,
      });
      errorEl.textContent = valid ? "" : error;
      confirmBtn.disabled = !valid;
      input.classList.toggle("has-error", !valid && Boolean(input.value.trim()));
      return valid;
    };
    const submit = () => {
      const { valid, value } = validateSkillName(input.value, {
        existingSkillNames,
      });
      if (!valid) {
        revalidate();
        return;
      }
      finish(value);
    };
    const onKeydown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(null);
      } else if (event.key === "Enter" && document.activeElement === input) {
        event.preventDefault();
        submit();
      }
    };

    input.addEventListener("input", revalidate);
    confirmBtn.addEventListener("click", submit);
    cancelBtn.addEventListener("click", () => finish(null));
    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) finish(null);
    });
    document.addEventListener("keydown", onKeydown, true);

    // Show + focus (select-all so the user can retype quickly).
    requestAnimationFrame(() => {
      overlay.classList.add("visible");
      input.focus();
      input.select();
      revalidate();
    });
  });
}

// Delegated handler for the skill page header actions.
async function handleSkillPageAction(event) {
  const btn = event.target?.closest?.("button");
  if (!btn || !skillPage) return;
  if (btn.dataset.busy === "true") return;
  // Blocked Delete/Uninstall (agent references): inert — the button doubles
  // as the tooltip trigger, so the click only toggles the explanation panel.
  if (btn.getAttribute?.("aria-disabled") === "true") return;
  const skill = skillPage.skill;
  if (btn.classList.contains("skill-page-publish-btn")) {
    // publishSkillToAiMarketplace refreshes page chips and list badges.
    await publishSkillToAiMarketplace(skill, btn);
  } else if (btn.classList.contains("skill-page-unpublish-btn")) {
    await unpublishSkill(skill, btn);
  } else if (btn.classList.contains("skill-page-duplicate-btn")) {
    if (skillPageHasUnsavedEdits()) {
      requestCloseSkillPage(() => void duplicateSkillAction(skill));
    } else {
      await duplicateSkillAction(skill, btn);
    }
  } else if (btn.classList.contains("skill-page-open-folder-btn")) {
    await openSkillFolderForSkill(skill);
  } else if (btn.classList.contains("skill-page-export-btn")) {
    await exportSkillForSkill(skill);
  } else if (btn.classList.contains("skill-page-delete-btn")) {
    confirmDeleteSkill(skill);
  } else if (btn.classList.contains("skill-page-uninstall-btn")) {
    confirmUninstallMarketplaceSkill(skill);
  } else if (btn.classList.contains("skill-page-install-btn")) {
    if (btn.disabled) return;
    await installDiscoverSkillFromPage(skill, btn);
  } else if (btn.classList.contains("skill-page-git-install-btn")) {
    if (btn.disabled) return;
    await installGitMarketplaceSkillFromPage(skill, btn);
  } else if (btn.classList.contains("skill-page-spec-btn")) {
    if (window.electronAPI?.openExternal) {
      window.electronAPI.openExternal("https://agentskills.io/specification");
    } else {
      window.open("https://agentskills.io/specification", "_blank");
    }
  }
}

/**
 * Open the inline skill page.
 */
async function openSkillPage(skill, options = {}) {
  const host = document.getElementById("agent-skills-editor");
  if (!host || !skill) return;
  teardownSkillPage();
  // Only one inline page owns the subview at a time. A page opened FROM the
  // marketplace details page SUSPENDS it (hidden, state intact) so Back can
  // resume it exactly as left; every other open closes it as before.
  const suspendedMarketplace =
    options.fromMarketplaceDetails === true &&
    typeof window.suspendMarketplaceDetailsPage === "function" &&
    window.suspendMarketplaceDetailsPage() === true;
  if (
    !suspendedMarketplace &&
    typeof window.closeMarketplaceDetailsPage === "function"
  ) {
    window.closeMarketplaceDetailsPage();
  }
  currentSkillForDetails = skill;
  skillDetailsTabs = [];
  activeSkillTabId = null;
  skillPage = { skill, returnToMarketplaceDetails: suspendedMarketplace };

  host.innerHTML = `
    <div class="agent-editor-page">
      <div class="agent-editor-header">
        <button class="agent-editor-back-btn" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"></path></svg>
          Back
        </button>
        <div class="agent-editor-header-main">
          <h1>${escapeHtml(getSkillDisplayName(skill))}</h1>
          <div class="agent-editor-page-chips" data-skill-page-chips>${buildSkillPageChipsHtml(skill)}</div>
        </div>
        <div class="agent-editor-page-actions" data-skill-page-actions>${buildSkillPageActionsHtml(skill)}</div>
      </div>
      <div class="agent-editor-inline-body">
        ${
          skill.source === "marketplace"
            ? `<div class="marketplace-readonly-pane marketplace-readonly-pane--skill" role="note">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v5"></path><path d="M12 8h.01"></path></svg>
                <span>This skill was installed from the AI Solutions Marketplace and is read only. Create a copy if you'd like to customize it.</span>
              </div>`
            : skill.source === SKILLS_DISCOVER_LISTING_SOURCE
              ? `<div class="marketplace-readonly-pane marketplace-readonly-pane--skill" role="note">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v5"></path><path d="M12 8h.01"></path></svg>
                <span>This skill is on the AI Solutions Marketplace. Install it to use it in chats.</span>
              </div>`
              : skill.source === GIT_MARKETPLACE_LISTING_SOURCE
                ? `<div class="marketplace-readonly-pane marketplace-readonly-pane--skill" role="note">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v5"></path><path d="M12 8h.01"></path></svg>
                <span data-skill-page-banner>${escapeHtml(gitListingBannerText(skill))}</span>
              </div>`
                : ""
        }
        <div class="skill-details-body">
          <div class="skill-file-browser">
            <div class="skill-file-tree-header">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
              </svg>
              <span>Files</span>
              <button class="skill-spec-badge skill-page-spec-btn" type="button" title="View Agent Skills specification">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                  <polyline points="14 2 14 8 20 8"></polyline>
                </svg>
                <span>Spec</span>
              </button>
            </div>
            <div class="skill-file-tree" id="skill-file-tree">
              <!-- File tree rendered here -->
            </div>
          </div>
          <div class="skill-details-divider" id="skill-details-divider"></div>
          <div class="skill-content-panel">
            <div class="skill-tabs-container" id="skill-tabs-container">
              <!-- Tabs rendered here -->
            </div>
            <div class="skill-content-area" id="skill-content-area">
              <div class="skill-content-placeholder">Select a file to view its contents</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // The page takes over the skills subview.
  const browser = document.getElementById("agent-skills-browser");
  if (browser) browser.style.display = "none";
  const headerActions = document.getElementById("skills-header-actions");
  if (headerActions) headerActions.style.display = "none";
  host.style.display = "";
  host.scrollTop = 0;

  // Wire page chrome (elements are recreated per open).
  host
    .querySelector(".agent-editor-back-btn")
    ?.addEventListener("click", () => requestCloseSkillPage());
  host
    .querySelector("[data-skill-page-actions]")
    ?.addEventListener("click", (event) => void handleSkillPageAction(event));
  host
    .querySelector(".skill-file-tree-header .skill-page-spec-btn")
    ?.addEventListener("click", (event) => void handleSkillPageAction(event));
  const tabsContainer = document.getElementById("skill-tabs-container");
  tabsContainer?.addEventListener(
    "wheel",
    (e) => {
      const scrollArea = tabsContainer.querySelector(".skill-tabs-scroll");
      if (scrollArea && e.deltaY !== 0) {
        e.preventDefault();
        scrollArea.scrollLeft += e.deltaY;
      }
    },
    { passive: false },
  );
  document
    .getElementById("skill-details-divider")
    ?.addEventListener("mousedown", startSkillDividerDrag);
  wireSkillDividerDocumentListeners();

  // Load file tree (same sequence the modal used).
  const fileTree = document.getElementById("skill-file-tree");
  if (fileTree) {
    fileTree.innerHTML =
      '<div class="skill-file-loading">Loading files...</div>';
  }
  // Remote listings have no local files — their tree comes from the
  // marketplace bundle instead of the filesystem IPC.
  if (skill.source === SKILLS_DISCOVER_LISTING_SOURCE) {
    await loadDiscoverSkillPageFiles(skill);
    return;
  }
  if (skill.source === GIT_MARKETPLACE_LISTING_SOURCE) {
    await loadGitMarketplaceSkillPageFiles(skill);
    return;
  }
  try {
    const result = await window.electronAPI.getSkillFiles(
      skill.name,
      skill.skill_path,
    );
    if (skillPage?.skill !== skill) return; // navigated away mid-fetch
    if (result.success) {
      renderSkillFileTree(result.files, result.basePath);
      const skillMdFile = result.files.find(
        (f) => f.name === "SKILL.md" || f.relativePath === "SKILL.md",
      );
      if (skillMdFile) {
        openSkillFile(skillMdFile.fullPath, skillMdFile.name);
      }
    } else if (fileTree) {
      fileTree.innerHTML =
        '<div class="skill-file-error">Failed to load files</div>';
    }
  } catch (error) {
    console.error("[Skill Page] Error loading files:", error);
    if (skillPage?.skill === skill && fileTree) {
      fileTree.innerHTML =
        '<div class="skill-file-error">Error loading files</div>';
    }
  }
}

/**
 * Initialize skill details divider drag functionality. The divider element is
 * recreated per page mount (mousedown attached there); the document-level
 * listeners are wired once.
 */
let skillDividerDocListenersWired = false;
function wireSkillDividerDocumentListeners() {
  if (skillDividerDocListenersWired) return;
  skillDividerDocListenersWired = true;
  document.addEventListener("mousemove", onSkillDividerDrag);
  document.addEventListener("mouseup", stopSkillDividerDrag);
  document.addEventListener("pointercancel", stopSkillDividerDrag);
  window.addEventListener("blur", stopSkillDividerDrag);
}

function startSkillDividerDrag(e) {
  const filePanel = document.querySelector(".skill-file-browser");
  if (!filePanel) return;

  skillDividerDragState.isDragging = true;
  skillDividerDragState.startX = e.clientX;
  skillDividerDragState.startWidth = filePanel.getBoundingClientRect().width;

  document.getElementById("skill-details-divider")?.classList.add("dragging");
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  e.preventDefault();
}

function onSkillDividerDrag(e) {
  if (!skillDividerDragState.isDragging) return;

  const filePanel = document.querySelector(".skill-file-browser");
  const container = document.querySelector(
    "#agent-skills-editor .skill-details-body",
  );
  if (!filePanel || !container) return;

  const delta = e.clientX - skillDividerDragState.startX;
  const newWidth = Math.max(
    150,
    Math.min(
      skillDividerDragState.startWidth + delta,
      container.clientWidth - 300,
    ),
  );

  filePanel.style.flex = `0 0 ${newWidth}px`;
  filePanel.style.minWidth = `${newWidth}px`;
  filePanel.style.maxWidth = `${newWidth}px`;
}

function stopSkillDividerDrag() {
  if (!skillDividerDragState.isDragging) return;

  skillDividerDragState.isDragging = false;
  document
    .getElementById("skill-details-divider")
    ?.classList.remove("dragging");
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
}

/**
 * Render the file tree for a skill
 */
function renderSkillFileTree(files, basePath) {
  const fileTree = document.getElementById("skill-file-tree");
  if (!fileTree) return;

  if (!files || files.length === 0) {
    fileTree.innerHTML = '<div class="skill-file-empty">No files found</div>';
    return;
  }

  // Build tree structure
  const tree = buildFileTree(files);
  fileTree.innerHTML = renderTreeNode(tree, basePath, "");

  // Attach click handlers
  fileTree.querySelectorAll(".skill-file-item").forEach((item) => {
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      const filePath = item.dataset.path;
      const fileName = item.dataset.name;
      openSkillFile(filePath, fileName);
    });
  });

  // Attach folder toggle handlers
  fileTree.querySelectorAll(".skill-folder-toggle").forEach((toggle) => {
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      const folder = toggle.closest(".skill-folder");
      folder.classList.toggle("collapsed");
    });
  });

  // Auto-size the file browser panel to fit content
  autoSizeFileBrowserPanel(files);
}

/**
 * Auto-size the file browser panel based on the longest file/folder name
 */
function autoSizeFileBrowserPanel(files) {
  const filePanel = document.querySelector(".skill-file-browser");
  if (!filePanel) return;

  // Calculate the longest path segment (including folder depth indentation)
  let maxWidth = 180; // Minimum default width
  const charWidth = 7.5; // Approximate character width in pixels at 0.8125rem
  const basePadding = 70; // Icon + padding + scrollbar buffer

  files.forEach((file) => {
    const parts = file.relativePath.split("/");
    const fileName = parts[parts.length - 1];
    const depth = parts.length - 1;
    const indentWidth = depth * 16; // 1rem indent per depth level
    const textWidth = fileName.length * charWidth;
    const totalWidth = basePadding + indentWidth + textWidth;
    maxWidth = Math.max(maxWidth, totalWidth);
  });

  // Also check folder names
  const folderNames = new Set();
  files.forEach((file) => {
    const parts = file.relativePath.split("/");
    for (let i = 0; i < parts.length - 1; i++) {
      const depth = i;
      const folderName = parts[i];
      const indentWidth = depth * 16;
      const textWidth = folderName.length * charWidth;
      const totalWidth = basePadding + indentWidth + textWidth;
      maxWidth = Math.max(maxWidth, totalWidth);
    }
  });

  // Clamp to reasonable bounds: min 180px, max 350px
  const clampedWidth = Math.min(Math.max(maxWidth, 180), 350);

  // Apply the width
  filePanel.style.flex = `0 0 ${clampedWidth}px`;
  filePanel.style.minWidth = `${clampedWidth}px`;
  filePanel.style.maxWidth = `${clampedWidth}px`;
}

/**
 * Build a tree structure from flat file list
 */
function buildFileTree(files) {
  const tree = { name: "", children: {}, files: [] };

  files.forEach((file) => {
    const parts = file.relativePath.split("/");
    let current = tree;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!current.children[part]) {
        current.children[part] = { name: part, children: {}, files: [] };
      }
      current = current.children[part];
    }

    current.files.push({
      name: parts[parts.length - 1],
      path: file.fullPath,
      type: file.type,
    });
  });

  return tree;
}

/**
 * Render a tree node (folder or file)
 */
function renderTreeNode(node, basePath, indent) {
  let html = "";

  // Render folders first
  const folders = Object.keys(node.children).sort();
  folders.forEach((folderName) => {
    const folder = node.children[folderName];
    html += `
      <div class="skill-folder collapsed">
        <div class="skill-folder-toggle">
          <svg class="folder-icon-closed" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
          </svg>
          <svg class="folder-icon-open" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
            <path d="M2 10h20"></path>
          </svg>
          <span class="folder-name">${escapeHtml(folderName)}</span>
        </div>
        <div class="skill-folder-contents">
          ${renderTreeNode(folder, basePath, indent + "  ")}
        </div>
      </div>
    `;
  });

  // Render files
  const sortedFiles = node.files.sort((a, b) => {
    // SKILL.md first, then alphabetically
    if (a.name === "SKILL.md") return -1;
    if (b.name === "SKILL.md") return 1;
    return a.name.localeCompare(b.name);
  });

  sortedFiles.forEach((file) => {
    const icon = getFileIcon(file.name, file.type);
    html += `
      <div class="skill-file-item" data-path="${escapeHtmlAttribute(file.path)}" data-name="${escapeHtmlAttribute(file.name)}">
        ${icon}
        <span class="file-name">${escapeHtml(file.name)}</span>
      </div>
    `;
  });

  return html;
}

/**
 * Get icon for a file type
 */
function getFileIcon(fileName, fileType) {
  if (fileName.endsWith(".md")) {
    return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
      <polyline points="14 2 14 8 20 8"></polyline>
      <line x1="16" y1="13" x2="8" y2="13"></line>
      <line x1="16" y1="17" x2="8" y2="17"></line>
      <polyline points="10 9 9 9 8 9"></polyline>
    </svg>`;
  } else if (fileName.endsWith(".py")) {
    return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#3776ab" stroke-width="2">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z"></path>
      <path d="M8 12h8M12 8v8"></path>
    </svg>`;
  } else if (fileName.endsWith(".sh")) {
    return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#4EAA25" stroke-width="2">
      <polyline points="4 17 10 11 4 5"></polyline>
      <line x1="12" y1="19" x2="20" y2="19"></line>
    </svg>`;
  } else if (fileName.endsWith(".json")) {
    return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#f5a623" stroke-width="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
      <path d="M8 13h2M14 13h2M8 17h8"></path>
    </svg>`;
  } else if (isSkillImageFile(fileName)) {
    return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
      <circle cx="8.5" cy="8.5" r="1.5"></circle>
      <polyline points="21 15 16 10 5 21"></polyline>
    </svg>`;
  }
  return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
    <polyline points="14 2 14 8 20 8"></polyline>
  </svg>`;
}

/**
 * Open a skill file in a tab
 */
async function openSkillFile(filePath, fileName) {
  // Check if tab already exists
  const existingTab = skillDetailsTabs.find((t) => t.path === filePath);
  if (existingTab) {
    activateSkillTab(existingTab.id);
    return;
  }

  // Remote listing pages read from the in-memory bundle, not the filesystem.
  // Local pages never set remoteFiles, so this branch is inert for them.
  const remoteEntry = skillPage?.remoteFiles?.get(filePath);
  if (remoteEntry) {
    const tabId = `tab-${Date.now()}`;
    const fileType = getFileType(fileName);
    skillDetailsTabs.push({
      id: tabId,
      name: fileName,
      path: filePath,
      content: remoteEntry.content ?? "",
      dataUrl: remoteEntry.dataUrl || null,
      mimeType: remoteEntry.mimeType || null,
      sizeBytes: remoteEntry.sizeBytes || null,
      type: fileType,
      viewMode: fileType === "markdown" ? "rendered" : "raw",
    });
    renderSkillTabs();
    activateSkillTab(tabId);
    return;
  }

  // Load file content
  const pageAtCall = skillPage;
  try {
    const result = await window.electronAPI.readSkillFile(filePath);
    if (skillPage !== pageAtCall) {
      return; // page closed or switched mid-read; drop the stale tab
    }
    if (!result.success) {
      console.error("[Skill Details] Failed to read file:", result.error);
      return;
    }

    // Create new tab
    const tabId = `tab-${Date.now()}`;
    const fileType = getFileType(fileName);

    skillDetailsTabs.push({
      id: tabId,
      name: fileName,
      path: filePath,
      content: result.content,
      dataUrl: result.dataUrl || null,
      mimeType: result.mimeType || null,
      sizeBytes: result.sizeBytes || null,
      type: fileType,
      viewMode: fileType === "markdown" ? "rendered" : "raw", // Default to rendered for markdown
    });

    renderSkillTabs();
    activateSkillTab(tabId);
  } catch (error) {
    console.error("[Skill Details] Error reading file:", error);
  }
}

/**
 * Get the type of a file based on extension
 */
function getFileType(fileName) {
  if (!fileName || typeof fileName !== "string") {
    return "text";
  }

  // Normalize: trim whitespace and check lowercase
  const lowerName = fileName.trim().toLowerCase();

  if (lowerName.endsWith(".md")) return "markdown";
  if (lowerName.endsWith(".py")) return "python";
  if (lowerName.endsWith(".sh")) return "shell";
  if (lowerName.endsWith(".json")) return "json";
  if (lowerName.endsWith(".yaml") || lowerName.endsWith(".yml")) return "yaml";
  if (isSkillImageFile(lowerName)) return "image";

  return "text";
}

/**
 * Render the tabs bar
 */
function renderSkillTabs() {
  const tabsContainer = document.getElementById("skill-tabs-container");
  if (!tabsContainer) return;

  const tabsHtml = skillDetailsTabs
    .map(
      (tab) => `
    <div class="skill-tab ${tab.id === activeSkillTabId ? "active" : ""}" data-tab-id="${escapeHtmlAttribute(tab.id)}">
      <span class="skill-tab-name">${escapeHtml(tab.name)}</span>
      <button class="skill-tab-close" data-tab-id="${escapeHtmlAttribute(tab.id)}" title="Close tab">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>
  `,
    )
    .join("");
  tabsContainer.innerHTML = `<div class="skill-tabs-scroll">${tabsHtml}</div>`;

  // Attach click handlers
  tabsContainer.querySelectorAll(".skill-tab").forEach((tab) => {
    tab.addEventListener("click", (e) => {
      if (!e.target.closest(".skill-tab-close")) {
        activateSkillTab(tab.dataset.tabId);
      }
    });
  });

  tabsContainer.querySelectorAll(".skill-tab-close").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeSkillTab(btn.dataset.tabId);
    });
  });
}

/**
 * Activate a tab and show its content
 */
function activateSkillTab(tabId) {
  activeSkillTabId = tabId;
  const tab = skillDetailsTabs.find((t) => t.id === tabId);
  if (!tab) return;

  // Update tab styles
  document.querySelectorAll(".skill-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tabId === tabId);
  });

  // Scroll the active tab into view
  const activeTabEl = document.querySelector(
    `.skill-tab[data-tab-id="${tabId}"]`,
  );
  if (activeTabEl) {
    activeTabEl.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "nearest",
    });
  }

  // Highlight file in tree
  document.querySelectorAll(".skill-file-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.path === tab.path);
  });

  // Render content
  renderSkillFileContent(tab);
}

/**
 * Close a tab
 */
function closeSkillTab(tabId) {
  const index = skillDetailsTabs.findIndex((t) => t.id === tabId);
  if (index === -1) return;

  skillDetailsTabs.splice(index, 1);

  // If closing active tab, activate another
  if (activeSkillTabId === tabId) {
    if (skillDetailsTabs.length > 0) {
      const newIndex = Math.min(index, skillDetailsTabs.length - 1);
      activeSkillTabId = skillDetailsTabs[newIndex].id;
    } else {
      activeSkillTabId = null;
    }
  }

  renderSkillTabs();

  if (activeSkillTabId) {
    activateSkillTab(activeSkillTabId);
  } else {
    const contentArea = document.getElementById("skill-content-area");
    if (contentArea) {
      contentArea.innerHTML =
        '<div class="skill-content-placeholder">Select a file to view its contents</div>';
    }
    // Clear file highlight
    document.querySelectorAll(".skill-file-item").forEach((item) => {
      item.classList.remove("active");
    });
  }
}

/**
 * Update the Preview/Raw toggle in the tabs row based on the active tab
 */
function updateSkillTabsToggle(tab) {
  const tabsContainer = document.getElementById("skill-tabs-container");
  if (!tabsContainer) return;

  // Remove existing toggle
  const existing = tabsContainer.querySelector(".skill-view-toggle");
  if (existing) existing.remove();

  // Only show toggle for markdown files
  if (!tab || tab.type !== "markdown") return;

  const isRendered = tab.viewMode === "rendered";
  const toggleHtml = `
    <div class="skill-view-toggle">
      <button class="skill-view-toggle-btn ${isRendered ? "active" : ""}" data-mode="rendered" title="Rendered view">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
          <circle cx="12" cy="12" r="3"></circle>
        </svg>
        <span>Preview</span>
      </button>
      <button class="skill-view-toggle-btn ${!isRendered ? "active" : ""}" data-mode="raw" title="Raw text">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="16 18 22 12 16 6"></polyline>
          <polyline points="8 6 2 12 8 18"></polyline>
        </svg>
        <span>Raw</span>
      </button>
    </div>
  `;
  tabsContainer.insertAdjacentHTML("beforeend", toggleHtml);

  // Attach toggle handlers
  tabsContainer.querySelectorAll(".skill-view-toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const newMode = btn.dataset.mode;
      if (newMode !== tab.viewMode) {
        tab.viewMode = newMode;
        renderSkillFileContent(tab);
      }
    });
  });
}

/**
 * Render the content of a file
 */
function renderSkillFileContent(tab) {
  const contentArea = document.getElementById("skill-content-area");
  if (!contentArea) return;

  // Ensure viewMode defaults for markdown
  if (tab.type === "markdown" && !tab.viewMode) {
    tab.viewMode = "rendered";
  }

  // FALLBACK: If type wasn't set correctly but file name ends with .md, fix it
  const isMarkdownByName = tab.name && tab.name.toLowerCase().endsWith(".md");
  if (isMarkdownByName && tab.type !== "markdown") {
    console.log(
      "[Skill Details] FIXING: tab.type was",
      tab.type,
      "but filename ends with .md, setting to markdown",
    );
    tab.type = "markdown";
    if (!tab.viewMode || tab.viewMode === "raw") {
      tab.viewMode = "rendered";
    }
  }

  console.log(
    "[Skill Details] Rendering:",
    tab.name,
    "| type:",
    tab.type,
    "| viewMode:",
    tab.viewMode,
  );

  // Update the Preview/Raw toggle in the tabs row (hidden while editing)
  updateSkillTabsToggle(tab.editing ? null : tab);

  // Per-file editing: user-authored skills only (system is read-only;
  // marketplace copies must be detached to a user copy first).
  const canEditTab = skillPage?.skill?.source === "user" && tab.type !== "image";

  if (tab.editing) {
    contentArea.classList.add("editing");
    contentArea.innerHTML = `
      <div class="skill-content-toolbar">
        <button class="btn-secondary skill-file-cancel-btn" type="button">Cancel</button>
        <button class="btn-primary skill-file-save-btn" type="button">Save</button>
      </div>
      <textarea class="skill-file-editor" spellcheck="false"></textarea>
    `;
    const textarea = contentArea.querySelector(".skill-file-editor");
    textarea.value = tab.draft ?? tab.content ?? "";
    textarea.addEventListener("input", () => {
      tab.draft = textarea.value;
    });
    contentArea
      .querySelector(".skill-file-cancel-btn")
      ?.addEventListener("click", () => {
        tab.editing = false;
        delete tab.draft;
        renderSkillFileContent(tab);
      });
    contentArea
      .querySelector(".skill-file-save-btn")
      ?.addEventListener("click", (event) => {
        void saveSkillFileTab(tab, event.currentTarget);
      });
    // Enter editing at the TOP of the document: value assignment parks the
    // caret at the end, and focusing there scrolls the editor to the bottom.
    textarea.setSelectionRange(0, 0);
    textarea.focus({ preventScroll: true });
    textarea.scrollTop = 0;
    return;
  }
  contentArea.classList.remove("editing");

  const editToolbarHtml = canEditTab
    ? `
      <div class="skill-content-toolbar">
        <button class="btn-secondary skill-file-edit-btn" type="button">Edit</button>
      </div>
    `
    : "";

  if (tab.type === "image") {
    if (tab.dataUrl) {
      const sizeLabel = tab.sizeBytes
        ? `${Math.max(1, Math.round(tab.sizeBytes / 1024))} KB`
        : "";
      const metadata = [tab.mimeType, sizeLabel].filter(Boolean).join(" | ");
      contentArea.innerHTML = `
        <div class="skill-image-content">
          <div class="skill-image-stage">
            <img src="${tab.dataUrl}" alt="${escapeHtmlAttribute(tab.name)}" class="skill-image-preview" />
          </div>
          <div class="skill-image-metadata">
            <span>${escapeHtml(tab.name)}</span>
            ${metadata ? `<span>${escapeHtml(metadata)}</span>` : ""}
          </div>
        </div>
      `;
    } else {
      contentArea.innerHTML = `
        <div class="skill-content-placeholder">Unable to render image preview</div>
      `;
    }
    return;
  }

  // Render content based on type and viewMode
  let contentHtml = "";
  const shouldRenderMarkdown =
    tab.type === "markdown" && tab.viewMode === "rendered";

  if (shouldRenderMarkdown) {
    // Render markdown using marked library
    try {
      // Extract frontmatter if present
      const { frontmatter, body } = extractFrontmatter(tab.content);
      let frontmatterHtml = "";
      if (frontmatter) {
        frontmatterHtml = `
          <div class="md-frontmatter">
            <div class="md-frontmatter-label">Frontmatter</div>
            <pre><code>${escapeHtml(frontmatter)}</code></pre>
          </div>
        `;
      }
      const renderedMarkdown = sanitizeRenderedHtml(marked.parse(body));
      contentHtml = `<div class="skill-markdown-content markdown-content">${frontmatterHtml}${renderedMarkdown}</div>`;
    } catch (err) {
      console.error("[Skill Details] Markdown render error:", err);
      contentHtml = `<pre class="skill-code-content"><code>${escapeHtml(tab.content)}</code></pre>`;
    }
  } else {
    // Render as code/raw text with syntax highlighting for Python
    const languageClass =
      tab.type === "python"
        ? "language-python"
        : tab.type === "shell"
          ? "language-bash"
          : tab.type === "json"
            ? "language-json"
            : tab.type === "yaml"
              ? "language-yaml"
              : tab.type === "markdown"
                ? "language-markdown"
                : "";

    // Use Prism for Python syntax highlighting if available
    if (
      tab.type === "python" &&
      typeof Prism !== "undefined" &&
      Prism.languages.python
    ) {
      const highlighted = Prism.highlight(
        tab.content || "",
        Prism.languages.python,
        "python",
      );
      contentHtml = `<pre class="skill-code-content language-python"><code class="language-python">${highlighted}</code></pre>`;
    } else {
      contentHtml = `<pre class="skill-code-content ${languageClass}"><code>${escapeHtml(tab.content)}</code></pre>`;
    }
  }

  contentArea.innerHTML = `${editToolbarHtml}${contentHtml}`;
  contentArea
    .querySelector(".skill-file-edit-btn")
    ?.addEventListener("click", () => {
      tab.editing = true;
      renderSkillFileContent(tab);
    });
}

// Save an edited skill file, then flag the marketplace link (if any) as
// having unpublished local changes.
async function saveSkillFileTab(tab, saveBtn) {
  const restoreButton = setSkillMenuActionBusy(saveBtn, "Saving...");
  // Resolve the owning skill BEFORE the write: if the user navigates to
  // another skill page while the write is in flight, the dirty flag must
  // land on the skill whose file actually changed, and the stale tab must
  // not repaint the new page's content area.
  const pageAtCall = skillPage;
  const canonicalName = canonicalSkillName(pageAtCall?.skill?.name || "");
  try {
    const value = tab.draft ?? tab.content ?? "";
    const result = await window.electronAPI.writeSkillFile(tab.path, value);
    if (!result?.success) {
      throw new Error(result?.error || "Failed to save file");
    }
    tab.content = value;
    tab.editing = false;
    delete tab.draft;
    if (skillPage === pageAtCall) {
      renderSkillFileContent(tab);
    }
    if (canonicalName && skillsMarketplaceLinks[canonicalName]) {
      try {
        await window.electronAPI.aiMarketplace?.markSkillLinkDirty?.(
          canonicalName,
        );
        skillsMarketplaceLinks[canonicalName].hasLocalChanges = true;
        if (skillPage === pageAtCall) {
          refreshSkillPageMarketplaceState();
        }
        renderSkillsList();
      } catch (error) {
        console.warn("[Agent Skills] Failed to flag unpublished changes", error);
      }
    }
    if (window.showNotification) {
      window.showNotification(`Saved ${tab.name}.`, "success");
    }
  } catch (error) {
    console.error("[Agent Skills] Error saving skill file:", error);
    if (window.showNotification) {
      window.showNotification(
        `Failed to save ${tab.name}: ${error.message}`,
        "error",
      );
    }
  } finally {
    restoreButton();
  }
}

// Markdown rendering is now handled by the marked library via window.electronAPI.renderMarkdown()

/**
 * Extract YAML frontmatter from markdown content
 * Returns { frontmatter: string|null, body: string }
 */
function extractFrontmatter(content) {
  if (!content) return { frontmatter: null, body: content || "" };
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (frontmatterMatch) {
    return {
      frontmatter: frontmatterMatch[1],
      body: content.slice(frontmatterMatch[0].length),
    };
  }
  return { frontmatter: null, body: content };
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Make clearSkillsFilters available globally
window.clearSkillsFilters = clearSkillsFilters;

/**
 * Initialize Agent Skills component
 */
function initAgentSkills() {
  initViewToggle();
  initSkillsSearchFilter();
  setupDeleteSkillModalListeners();
  console.log("[Agent Skills] Component initialized");
}

// Initialize on DOM ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initAgentSkills);
} else {
  initAgentSkills();
}

// Export for use by other modules
window.loadSkills = loadSkills;
window.showAgentSkillsView = showAgentSkillsView;
window.switchAgentSkillsToInstalledTab = switchAgentSkillsToInstalledTab;
window.initAgentSkills = initAgentSkills;
// Compatibility aliases: the details modal was replaced by the inline page.
window.openSkillDetailsModal = openSkillPage;
window.closeSkillDetailsModal = teardownSkillPage;
// Shared with marketplaces.js: the referential-integrity blocking modal.
window.showSkillInUseByAgentsModal = showSkillInUseByAgentsModal;
// Behavioral-test surface (vm harness) — mirrors window.AgentsPublishHooks.
// updateSkillsHeaderActions is also consumed by marketplaces.js so the inline
// marketplace page teardown restores Sync All per the active tab.
// The marketplace details page consults this before restoring the browse
// chrome — an open inline skill page owns the subview.
window.isInlineSkillPageOpen = () => Boolean(skillPage);
window.AgentSkillsHooks = {
  confirmReclaimInstalledSkillCopy,
  reclaimInstalledSkillCopy,
  confirmUninstallMarketplaceSkill,
  publishSkillToAiMarketplace,
  // Modal-free republish worker (confirm chrome lives in
  // publishSkillToAiMarketplace) — the Updates tab's "Publish All" calls this
  // directly per dirty linked skill.
  performPublishSkillToAiMarketplace,
  duplicateSkillAction,
  applySkillsActiveFilter,
  updateSkillsHeaderActions,
  openGitMarketplaceSkillPage,
};
