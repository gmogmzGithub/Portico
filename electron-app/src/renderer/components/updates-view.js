// Updates view - Control Plane tab between Agent Skills and Cost Dashboard.
//
// One place to see what's stale, in both directions:
//   INBOUND  (left):  installed marketplace agents, Solutions-Marketplace
//                     skills, and git marketplaces whose remote moved past
//                     our local copies — with "Update All".
//   OUTBOUND (right): the viewer's published agents/skills with local edits
//                     not yet republished — with "Publish All".
//
// Cost-dashboard pattern: self-contained plain script, no router. Data loads
// ONLY on tab open / Refresh / after a bulk run — no timers, no polling
// (checkSkillUpdates runs with interactiveAuth:false so a passive view open
// can never pop a sign-in).

let updatesViewInitialized = false;
let updatesViewLoading = false;
let updatesBulkRunning = false;

const updatesViewState = {
  loadedAt: 0,
  inbound: { agents: [], skills: [], gitMarketplaces: [], gitMissing: [] },
  outbound: { agents: [], skills: [] },
};

function updatesEscapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// LOCKSTEP with services/ai-marketplace-freshness.js solutionFreshnessStamp:
// the live backend's fields are updated_timestamp/created_timestamp; the
// legacy *_at names are fixture-era fallbacks.
function updatesFreshnessStamp(solution) {
  return (
    solution?.updated_timestamp ??
    solution?.updated_at ??
    solution?.created_timestamp ??
    solution?.created_at ??
    null
  );
}

function updatesTimestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

// "How many days behind our local copy is": the gap between the newer remote
// stamp and the older local baseline (marketplace clock on both sides where
// possible). Unknown inputs read as a quiet dash, never "0 days".
function daysBehindLabel(newerMs, olderMs) {
  if (
    typeof newerMs !== "number" ||
    !Number.isFinite(newerMs) ||
    typeof olderMs !== "number" ||
    !Number.isFinite(olderMs)
  ) {
    return "—";
  }
  const diff = newerMs - olderMs;
  if (diff <= 0) return "<1 day";
  const days = Math.floor(diff / 86400000);
  if (days < 1) return "<1 day";
  return days === 1 ? "1 day" : `${days} days`;
}

function updatesCanonicalSkillName(value) {
  return (
    String(value || "")
      .trim()
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean)
      .at(-1) || ""
  );
}

function updatesSkillDisplayName(value) {
  return (
    window.SkillCardRenderer?.formatSkillDisplayName?.(value) || String(value || "")
  );
}

function updatesPluginSkillLabel(skillId, pluginName) {
  const base = updatesSkillDisplayName(skillId);
  if (!pluginName) return base;
  return (
    window.SkillCardRenderer?.composeSkillPluginLabel?.(base, pluginName) || base
  );
}

// Leaf segment of a skill reference — the same normalization the sync
// classifier's inventory reader applies (agent-skill-usage-guard), so the
// tab's usage verdicts can never disagree with the classifier's.
function updatesSkillLeafName(skillId) {
  return (
    String(skillId || "")
      .split("/")
      .filter(Boolean)
      .pop() || ""
  );
}

// ---------------------------------------------------------------------------
// Row assembly (pure — fed by loadUpdates, pinned directly by unit tests)
// ---------------------------------------------------------------------------

// Author cell for listing-backed rows: prefer the real name the publish path
// stamped on the listing (author_display_name); for the viewer's OWN rows
// fall back to the session's Okta full name (legacy listings predate the
// field); else the ldap the listing has always carried.
function updatesAuthorLabel(listing, viewer) {
  const displayName =
    typeof listing?.author_display_name === "string"
      ? listing.author_display_name.trim()
      : "";
  if (displayName) return displayName;
  const ldap = listing?.author || listing?.submitted_by || "";
  if (
    ldap &&
    viewer?.fullName &&
    viewer?.ldaps instanceof Set &&
    viewer.ldaps.has(String(ldap).trim().toLowerCase())
  ) {
    return viewer.fullName;
  }
  return ldap || "";
}

// Inbound: agents (installed links vs live listings), Solutions-Marketplace
// skills (sweep-flagged records), git marketplaces (grouped flagged records).
function buildInboundRows({
  agentLinks = {},
  agentListingsById = new Map(),
  installedSkills = [],
  marketplaces = [],
  skillRows = [],
  sweepUpdates = [],
  nowMs = Date.now(),
  viewer = null,
  // Leaf ids of missing skills some agent still references (Set), or null
  // when the inventory probe was unavailable — null fails OPEN (rows stay
  // actionable so the consent path is never hidden by an outage).
  skillUsageLeaves = null,
} = {}) {
  const agents = [];
  for (const [agentId, link] of Object.entries(agentLinks)) {
    if (link?.relationship !== "installed" || !link?.solutionId) continue;
    const listing = agentListingsById.get(link.solutionId) || null;
    const stampMs = updatesTimestampMs(updatesFreshnessStamp(listing));
    const baselineMs = updatesTimestampMs(link.remoteUpdatedAt);
    const stampNewer =
      stampMs !== null && baselineMs !== null && stampMs > baselineMs;
    if (!stampNewer && link.hasRemoteUpdate !== true) continue;
    agents.push({
      key: `in-agent:${agentId}`,
      agentId,
      solutionId: link.solutionId,
      name: listing?.name || agentId,
      author: updatesAuthorLabel(listing, viewer) || link.authorIdentity || "—",
      drift: stampNewer ? daysBehindLabel(stampMs, baselineMs) : "—",
      statusLabel: "Update available",
      statusTone: "update",
    });
  }
  agents.sort((a, b) => a.name.localeCompare(b.name));

  const skillRowByCanonical = new Map();
  const skillRowBySolutionId = new Map();
  for (const row of skillRows) {
    const canonical = updatesCanonicalSkillName(row?.name || row?.id);
    if (canonical && !skillRowByCanonical.has(canonical)) {
      skillRowByCanonical.set(canonical, row);
    }
    if (row?.marketplace_solution_id) {
      skillRowBySolutionId.set(String(row.marketplace_solution_id), row);
    }
  }
  const solutionStampByKey = new Map();
  const gitHeadDateByMarketplace = new Map();
  for (const entry of sweepUpdates) {
    if (!entry || !entry.marketplaceId || !entry.skillId) continue;
    if (entry.marketplaceId === "ai-marketplace") {
      solutionStampByKey.set(`${entry.marketplaceId}:${entry.skillId}`, entry.remoteVersion);
    } else if (entry.headCommittedAt && !gitHeadDateByMarketplace.has(entry.marketplaceId)) {
      gitHeadDateByMarketplace.set(entry.marketplaceId, entry.headCommittedAt);
    }
  }

  const skills = [];
  const gitRecordsByMarketplace = new Map();
  // Records whose recorded repo path no longer exists upstream: NOT updates.
  // They render as an honest "No longer published" row; running a sync is
  // what resolves them (destructive flow).
  const gitMissingByMarketplace = new Map();
  for (const record of installedSkills) {
    if (
      record?.sourceMissing === true &&
      record?.marketplaceId &&
      record.marketplaceId !== "ai-marketplace"
    ) {
      if (!gitMissingByMarketplace.has(record.marketplaceId)) {
        gitMissingByMarketplace.set(record.marketplaceId, []);
      }
      gitMissingByMarketplace.get(record.marketplaceId).push(record);
      continue;
    }
    if (record?.hasUpdate !== true) continue;
    const isSolutions =
      record?.marketplaceId === "ai-marketplace" &&
      record?.skillSource?.type === "ai-marketplace-solution" &&
      record?.skillSource?.solutionId;
    if (isSolutions) {
      const skillRow =
        skillRowBySolutionId.get(String(record.skillSource.solutionId)) ||
        skillRowByCanonical.get(updatesCanonicalSkillName(record.skillId)) ||
        null;
      const stampMs = updatesTimestampMs(
        solutionStampByKey.get(`${record.marketplaceId}:${record.skillId}`),
      );
      const dirty = record.isDirty === true || record.hasConflict === true;
      skills.push({
        key: `in-skill:${record.marketplaceId}:${record.skillId}`,
        skillId: record.skillId,
        solutionId: record.skillSource.solutionId,
        name: skillRow?.display_name || updatesSkillDisplayName(record.skillId),
        author: skillRow?.author || "—",
        drift: daysBehindLabel(stampMs, updatesTimestampMs(record.remoteUpdatedAt)),
        statusLabel: "Update available",
        statusTone: "update",
        // Local edits: an in-place refresh would clobber them, so Update All
        // keeps these and points at the Marketplaces page instead.
        dirty,
      });
      continue;
    }
    if (record?.marketplaceId && record.marketplaceId !== "ai-marketplace") {
      if (!gitRecordsByMarketplace.has(record.marketplaceId)) {
        gitRecordsByMarketplace.set(record.marketplaceId, []);
      }
      gitRecordsByMarketplace.get(record.marketplaceId).push(record);
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));

  const gitMarketplaces = [];
  for (const [marketplaceId, records] of gitRecordsByMarketplace.entries()) {
    const entry = marketplaces.find((m) => m?.id === marketplaceId) || null;
    // Live sweep date first; else the date persisted when the flag was set —
    // a sweep whose probes fail (expired GitLab session, offline) keeps the
    // flags but supplies no entries, and the drift must not blank out.
    let headDateMs = updatesTimestampMs(gitHeadDateByMarketplace.get(marketplaceId));
    if (headDateMs === null) {
      for (const record of records) {
        const persistedMs = updatesTimestampMs(record?.updateHeadCommittedAt);
        if (persistedMs !== null && (headDateMs === null || persistedMs > headDateMs)) {
          headDateMs = persistedMs;
        }
      }
    }
    const lastSyncedMs = updatesTimestampMs(entry?.lastSynced);
    const staleLabels = records
      .map((record) => updatesPluginSkillLabel(record.skillId, record.pluginName))
      .sort((a, b) => a.localeCompare(b));
    gitMarketplaces.push({
      key: `in-git:${marketplaceId}`,
      marketplaceId,
      name: entry?.name || marketplaceId,
      author: entry?.owner?.name || "—",
      drift: daysBehindLabel(headDateMs, lastSyncedMs),
      statusLabel: "Updates available",
      statusTone: "update",
      staleLabels,
    });
  }
  gitMarketplaces.sort((a, b) => a.name.localeCompare(b.name));

  const gitMissing = [];
  for (const [marketplaceId, records] of gitMissingByMarketplace.entries()) {
    const entry = marketplaces.find((m) => m?.id === marketplaceId) || null;
    const missingLabels = records
      .map((record) => updatesPluginSkillLabel(record.skillId, record.pluginName))
      .sort((a, b) => a.localeCompare(b));
    // Parked = no agent references ANY of the group's skills anymore (same
    // leaf matching as the sync classifier). A parked row is informational —
    // bundled skills stay installed until an app update resolves them, so
    // re-running the sync can never clear it and must not be offered as the
    // fix. Unknown usage (probe unavailable) keeps the row actionable.
    const parked =
      skillUsageLeaves !== null &&
      records.every(
        (record) => !skillUsageLeaves.has(updatesSkillLeafName(record.skillId)),
      );
    // Drift for a vanished skill = time since the upstream removal commit
    // (persisted as sourceMissingSince by the sweep). The row has been
    // actionable since the EARLIEST removal in the group; unstamped records
    // (stamp fetch failed) fall back to "—".
    let oldestMissingMs = null;
    for (const record of records) {
      const stampMs = updatesTimestampMs(record?.sourceMissingSince);
      if (stampMs === null) continue;
      if (oldestMissingMs === null || stampMs < oldestMissingMs) {
        oldestMissingMs = stampMs;
      }
    }
    gitMissing.push({
      key: `in-git-missing:${marketplaceId}`,
      marketplaceId,
      name: entry?.name || marketplaceId,
      author: entry?.owner?.name || "—",
      drift: oldestMissingMs === null ? "—" : daysBehindLabel(nowMs, oldestMissingMs),
      statusLabel: parked ? "Waiting for app update" : "No longer published",
      statusTone: parked ? "kept" : "missing",
      missing: true,
      parked,
      staleLabels: missingLabels,
    });
  }
  gitMissing.sort((a, b) => a.name.localeCompare(b.name));

  return { agents, skills, gitMarketplaces, gitMissing };
}

// Outbound: published links with local edits, verified against the viewer's
// live owned listings (dead links never render as republishable).
function buildOutboundRows({
  agentLinks = {},
  skillLinks = {},
  ownedSolutions = [],
  skillRows = [],
  nowMs = Date.now(),
  viewer = null,
} = {}) {
  const ownedById = new Map();
  for (const solution of ownedSolutions) {
    if (solution?.id) ownedById.set(String(solution.id), solution);
  }
  const agents = [];
  for (const [agentId, link] of Object.entries(agentLinks)) {
    if (link?.relationship !== "published" || link?.hasLocalChanges !== true) continue;
    const listing = ownedById.get(String(link.solutionId || ""));
    if (!listing) continue;
    const stampMs = updatesTimestampMs(updatesFreshnessStamp(listing));
    const anchorMs = stampMs ?? updatesTimestampMs(link.lastUpdatedAt);
    agents.push({
      key: `out-agent:${agentId}`,
      agentId,
      solutionId: String(link.solutionId),
      name: listing.name || agentId,
      author: updatesAuthorLabel(listing, viewer) || "—",
      drift: daysBehindLabel(nowMs, anchorMs),
      statusLabel: "Unpublished changes",
      statusTone: "dirty",
    });
  }
  agents.sort((a, b) => a.name.localeCompare(b.name));

  const userSkillByCanonical = new Map();
  for (const row of skillRows) {
    if (row?.source !== "user") continue;
    const canonical = updatesCanonicalSkillName(row?.name || row?.id);
    if (canonical && !userSkillByCanonical.has(canonical)) {
      userSkillByCanonical.set(canonical, row);
    }
  }
  const skills = [];
  for (const [skillName, link] of Object.entries(skillLinks)) {
    if (link?.hasLocalChanges !== true || !link?.solutionId) continue;
    const listing = ownedById.get(String(link.solutionId));
    if (!listing) continue;
    const skillRow = userSkillByCanonical.get(updatesCanonicalSkillName(skillName));
    if (!skillRow) continue; // republish needs the local user copy's skill_path
    const stampMs = updatesTimestampMs(updatesFreshnessStamp(listing));
    const anchorMs = stampMs ?? updatesTimestampMs(link.lastUpdatedAt);
    skills.push({
      key: `out-skill:${skillName}`,
      skillName,
      solutionId: String(link.solutionId),
      name: skillRow.display_name || updatesSkillDisplayName(skillName),
      author: updatesAuthorLabel(listing, viewer) || "—",
      drift: daysBehindLabel(nowMs, anchorMs),
      statusLabel: "Unpublished changes",
      statusTone: "dirty",
      skillRow,
    });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));

  return { agents, skills };
}

// Actionable-work counters (dirty inbound skills are "kept", not actionable):
// shared by the bulk-run guards and the Sync All header button's disabling.
function updatesInboundTargetCount() {
  const { agents, skills, gitMarketplaces, gitMissing = [] } = updatesViewState.inbound;
  // Mirrors updateAllCore's target math: missing-upstream rows fold into the
  // git sync leg (deduped per marketplace), so they are actionable targets.
  // The guard, the button, and the loop must never disagree — a missing-only
  // inbound used to render Update All enabled while this counter said 0, so
  // the click silently no-opped (and Sync All rendered inert). PARKED rows
  // (bundled skills nobody uses anymore — only an app update resolves them)
  // are not targets: re-syncing can never clear them.
  const gitIds = new Set(gitMarketplaces.map((row) => row.marketplaceId));
  const missingOnly = gitMissing.filter(
    (row) => !row.parked && !gitIds.has(row.marketplaceId),
  ).length;
  return (
    agents.length +
    skills.filter((s) => !s.dirty).length +
    gitMarketplaces.length +
    missingOnly
  );
}

function updatesOutboundTargetCount() {
  const { agents, skills } = updatesViewState.outbound;
  return agents.length + skills.length;
}

// ---------------------------------------------------------------------------
// Data load
// ---------------------------------------------------------------------------

function getUpdatesShell() {
  return document.getElementById("updates-shell");
}

async function loadUpdates(force = false) {
  const shell = getUpdatesShell();
  if (!shell || !window.electronAPI) return;
  if (updatesViewLoading && !force) return;
  updatesViewLoading = true;
  // Stale tables sitting under a spinning Refresh button read as "nothing is
  // happening" — swap the panel bodies for an explicit loading state for
  // exactly as long as the reload runs.
  renderUpdatesViewLoading();
  try {
    const api = window.electronAPI;
    const mp = api.aiMarketplace || {};
    // The sweep rewrites the registry's hasUpdate/sourceMissing flags and
    // saves before resolving; the registry reads below must not race it or
    // the tables render the PREVIOUS sweep's state (one visit behind).
    const sweepPromise = api.checkSkillUpdates?.({ interactiveAuth: false }).catch(() => null);
    const independentPromise = Promise.all([
      mp.listLinks?.().catch(() => null),
      mp.listSkillLinks?.().catch(() => null),
      mp.listPublished?.().catch(() => null),
      mp.search?.({
        query: "",
        filters: { type: ["portico-agents"] },
        page: 1,
        pageSize: 100,
      }).catch(() => null),
      api.getUsername?.().catch(() => null),
      api.currentUser?.get?.().catch(() => null),
    ]);
    const sweepRes = await sweepPromise;
    const [marketplacesRes, skillsRes] = await Promise.all([
      api.getMarketplaces?.().catch(() => null),
      api.getSkills?.().catch(() => null),
    ]);
    const [
      linksRes,
      skillLinksRes,
      publishedRes,
      searchRes,
      usernameRes,
      currentUserRes,
    ] = await independentPromise;

    const agentLinks = linksRes?.success ? linksRes.links || {} : {};
    const skillLinks = skillLinksRes?.success ? skillLinksRes.links || {} : {};
    const marketplaces = marketplacesRes?.success
      ? marketplacesRes.data?.marketplaces || []
      : [];
    const installedSkills = marketplacesRes?.success
      ? marketplacesRes.data?.installedSkills || []
      : [];
    const skillRows = skillsRes?.success ? skillsRes.skills || [] : [];
    const ownedSolutions = publishedRes?.success
      ? publishedRes.data?.solutions || []
      : [];
    const sweepUpdates = sweepRes?.success ? sweepRes.updates || [] : [];

    // Viewer identity for author labels: the ldap forms listings carry
    // (whoami + email local-part) and the Okta full name to swap in for the
    // viewer's own legacy rows.
    const viewerLdaps = new Set();
    const whoami = usernameRes?.success ? String(usernameRes.username || "").trim() : "";
    if (whoami) viewerLdaps.add(whoami.toLowerCase());
    const sessionUser = currentUserRes?.sessionSummary?.user || null;
    const sessionEmail = typeof sessionUser?.email === "string" ? sessionUser.email.trim() : "";
    if (sessionEmail) {
      viewerLdaps.add(sessionEmail.toLowerCase());
      const at = sessionEmail.indexOf("@");
      if (at > 0) viewerLdaps.add(sessionEmail.slice(0, at).toLowerCase());
    }
    const viewerFullName =
      typeof sessionUser?.name === "string" ? sessionUser.name.trim() : "";
    const viewer = viewerLdaps.size || viewerFullName
      ? { ldaps: viewerLdaps, fullName: viewerFullName }
      : null;

    const agentListingsById = new Map();
    for (const solution of (searchRes?.success && searchRes.data?.results) || []) {
      const id = String(solution?.id || solution?.solution_id || "").trim();
      if (id) agentListingsById.set(id, solution);
    }
    // Ranked search misses (ACL'd or beyond page 1): bounded per-id fill,
    // same cap as the Agents-tab freshness sweep.
    const missing = Object.values(agentLinks)
      .filter(
        (link) =>
          link?.relationship === "installed" &&
          link?.solutionId &&
          !agentListingsById.has(link.solutionId),
      )
      .slice(0, 12);
    for (const link of missing) {
      try {
        const res = await mp.getSolution?.(link.solutionId);
        if (res?.success && res.data) agentListingsById.set(link.solutionId, res.data);
      } catch {
        /* listing unreachable: row falls back to link/registry facts */
      }
    }

    // Missing-upstream skills terminalize once no agent references them:
    // reuse the existing usage-badge channel (full per-agent leaf inventory,
    // one bounded MCP call, fail-open) — invoked only when missing rows
    // exist so parked rows stop arming the bulk buttons. A null verdict
    // (probe unavailable) must never hide the consent path.
    let skillUsageLeaves = null;
    const hasMissingRecords = installedSkills.some(
      (record) =>
        record?.sourceMissing === true &&
        record?.marketplaceId &&
        record.marketplaceId !== "ai-marketplace",
    );
    if (hasMissingRecords && api.listAgentSkillUsage) {
      try {
        const usageRes = await api.listAgentSkillUsage();
        if (usageRes?.success && Array.isArray(usageRes.agents)) {
          skillUsageLeaves = new Set(
            usageRes.agents.flatMap((agent) =>
              Array.isArray(agent?.leaves) ? agent.leaves : [],
            ),
          );
        }
      } catch {
        /* fail open: rows stay actionable */
      }
    }

    // A reload resolving mid-bulk (e.g. an arrival refresh still in flight
    // when a bulk button was clicked) must not re-render the tables — that
    // would wipe live row statuses and re-enable the panel buttons.
    if (updatesBulkRunning) return;
    updatesViewState.inbound = buildInboundRows({
      agentLinks,
      agentListingsById,
      installedSkills,
      marketplaces,
      skillRows,
      sweepUpdates,
      viewer,
      skillUsageLeaves,
    });
    updatesViewState.outbound = buildOutboundRows({
      agentLinks,
      skillLinks,
      ownedSolutions,
      skillRows,
      viewer,
    });
    updatesViewState.loadedAt = Date.now();
    renderUpdatesView();
  } catch (error) {
    console.error("[Updates] load failed", error);
    shell.innerHTML = `<div class="updates-empty"><div class="updates-empty-title">Could not check for updates.</div><div class="updates-empty-copy">${updatesEscapeHtml(error?.message || String(error))}</div></div>`;
  } finally {
    updatesViewLoading = false;
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function updatesRowHtml(row, { detail = "" } = {}) {
  const detailHtml = detail
    ? `<span class="updates-row-detail">${updatesEscapeHtml(detail)}</span>`
    : "";
  return `
    <tr class="updates-table-row" data-update-row="${updatesEscapeHtml(row.key)}">
      <td class="updates-status-cell"><span class="updates-status" data-status="${updatesEscapeHtml(row.statusTone || "update")}">${updatesEscapeHtml(row.statusLabel || "")}</span></td>
      <td><span class="updates-row-name">${updatesEscapeHtml(row.name)}</span>${detailHtml}</td>
      <td>${updatesEscapeHtml(row.author)}</td>
      <td>${updatesEscapeHtml(row.drift)}</td>
    </tr>`;
}

function updatesSectionRowHtml(label) {
  return `<tr class="updates-table-section-row"><td colspan="4">${updatesEscapeHtml(label)}</td></tr>`;
}

// One gridded table per panel: a single thead and band rows between groups
// (band rows only when the group has rows) so columns align panel-wide.
function updatesTableHtml(sections) {
  const body = [];
  for (const section of sections) {
    if (!section.rows.length) continue;
    body.push(updatesSectionRowHtml(section.label));
    for (const row of section.rows) {
      body.push(
        updatesRowHtml(row, {
          detail: section.rowDetail ? section.rowDetail(row) : "",
        }),
      );
    }
  }
  if (!body.length) return "";
  return `
    <table class="updates-table">
      <thead>
        <tr><th>Status</th><th>Name</th><th>Author</th><th>Drift</th></tr>
      </thead>
      <tbody>${body.join("")}</tbody>
    </table>`;
}

function updatesLoadingPanelHtml({ id, title, subtitle, btnId, btnLabel }) {
  return `
    <section class="updates-panel" id="${id}">
      <div class="updates-panel-header">
        <div class="updates-panel-title">${title}</div>
        <button class="btn-primary" id="${btnId}" disabled>${btnLabel}</button>
      </div>
      <p class="updates-panel-subtitle">${subtitle}</p>
      <div class="updates-empty updates-loading"><div class="updates-loading-spinner"></div>Checking for updates…</div>
    </section>`;
}

// Same panel scaffolding as the real render with the bodies swapped for
// spinners; every action is inert until fresh data lands.
function renderUpdatesViewLoading() {
  const shell = getUpdatesShell();
  if (!shell) return;
  shell.innerHTML = `
    <div class="updates-panels">
      ${updatesLoadingPanelHtml({
        id: "updates-inbound-panel",
        title: "Inbound",
        subtitle: "Installed copies with newer published versions.",
        btnId: "updates-update-all-btn",
        btnLabel: "Update All",
      })}
      ${updatesLoadingPanelHtml({
        id: "updates-outbound-panel",
        title: "Outbound",
        subtitle: "Your published listings with local changes not yet published.",
        btnId: "updates-publish-all-btn",
        btnLabel: "Publish All",
      })}
    </div>`;
  const syncBtn = document.getElementById("updates-sync-all-btn");
  if (syncBtn) syncBtn.disabled = true;
}

function renderUpdatesView() {
  const shell = getUpdatesShell();
  if (!shell) return;
  const { inbound, outbound } = updatesViewState;
  const inboundCount =
    inbound.agents.length +
    inbound.skills.length +
    inbound.gitMarketplaces.length +
    (inbound.gitMissing?.length || 0);
  const outboundCount = outbound.agents.length + outbound.skills.length;

  const inboundSections = inboundCount
    ? updatesTableHtml([
        { label: "Agents", rows: inbound.agents },
        {
          label: "Skills (Solutions Marketplace)",
          rows: inbound.skills,
          rowDetail: (row) =>
            row.dirty ? "Has local edits. Resolve from the Marketplaces page." : "",
        },
        {
          label: "Git marketplaces",
          rows: [...inbound.gitMarketplaces, ...(inbound.gitMissing || [])],
          rowDetail: (row) =>
            row.missing
              ? row.parked
                ? `Bundled with the app — agents unlinked: ${row.staleLabels.join(", ")}. An app update resolves them.`
                : `No longer published upstream: ${row.staleLabels.join(", ")}. Sync to resolve.`
              : `Updated: ${row.staleLabels.join(", ")}`,
        },
      ])
    : '<div class="updates-empty"><div class="updates-empty-title">Everything is up to date.</div><div class="updates-empty-copy">Installed agents and skills match their marketplace listings.</div></div>';

  const outboundSections = outboundCount
    ? updatesTableHtml([
        { label: "Agents", rows: outbound.agents },
        { label: "Skills", rows: outbound.skills },
      ])
    : '<div class="updates-empty"><div class="updates-empty-title">Nothing waiting to publish.</div><div class="updates-empty-copy">Your published agents and skills match their listings.</div></div>';

  shell.innerHTML = `
    <div class="updates-panels">
      <section class="updates-panel" id="updates-inbound-panel">
        <div class="updates-panel-header">
          <div class="updates-panel-title">Inbound</div>
          <button class="btn-primary" id="updates-update-all-btn"${updatesInboundTargetCount() ? "" : " disabled"}>Update All</button>
        </div>
        <p class="updates-panel-subtitle">Installed copies with newer published versions.</p>
        ${inboundSections}
      </section>
      <section class="updates-panel" id="updates-outbound-panel">
        <div class="updates-panel-header">
          <div class="updates-panel-title">Outbound</div>
          <button class="btn-primary" id="updates-publish-all-btn"${outboundCount ? "" : " disabled"}>Publish All</button>
        </div>
        <p class="updates-panel-subtitle">Your published listings with local changes not yet published.</p>
        ${outboundSections}
      </section>
    </div>`;

  // Sync All lives in the static header (unlike the panel buttons it is not
  // re-rendered with the shell), so its disabled state can only track the
  // data here: no actionable work on either side → inert.
  const syncBtn = document.getElementById("updates-sync-all-btn");
  if (syncBtn) {
    syncBtn.disabled =
      updatesInboundTargetCount() + updatesOutboundTargetCount() === 0;
  }
}

function setUpdatesRowStatus(key, status, label, title = "") {
  const shell = getUpdatesShell();
  const cell = shell?.querySelector?.(
    `[data-update-row="${key}"] .updates-status`,
  );
  if (!cell) return;
  cell.dataset.status = status;
  if (typeof label === "string") cell.textContent = label;
  // Property writes only (the unit-test stubs are plain objects, not
  // Elements); always reset title so a stale error tooltip never outlives
  // a later rerun of the same row.
  cell.title = title;
}

// ---------------------------------------------------------------------------
// Bulk actions (sequential; failures accumulate and never abort the loop)
// ---------------------------------------------------------------------------

// Mid-run reloads are poison: they re-render the tables (wiping live row
// statuses), so every bulk run also disables the two header buttons.
function setUpdatesHeaderBulkDisabled(disabled) {
  const refreshBtn = document.getElementById("updates-refresh-btn");
  const syncBtn = document.getElementById("updates-sync-all-btn");
  if (refreshBtn) refreshBtn.disabled = disabled;
  if (syncBtn) syncBtn.disabled = disabled;
}

// Core loops carry no guard/toast/reload — the public wrappers and Sync All
// own those, so Sync All can chain both cores under one guard. Row arrays
// are captured once at entry: a reload landing mid-run must not swap the
// iteration targets underneath the loops.
async function updateAllCore() {
  const { agents, skills, gitMarketplaces, gitMissing = [] } = updatesViewState.inbound;
  // Missing-upstream rows resolve through the same per-marketplace sync (the
  // destructive flow) — fold them into the git leg, deduped by marketplace.
  // Parked rows stay out: no agent uses those bundled skills anymore, so the
  // sync has nothing left to resolve (an app update is the only fix).
  const gitRows = [...gitMarketplaces];
  for (const row of gitMissing) {
    if (row.parked) continue;
    if (!gitRows.some((existing) => existing.marketplaceId === row.marketplaceId)) {
      gitRows.push(row);
    }
  }
  const targets =
    agents.length + skills.filter((s) => !s.dirty).length + gitRows.length;
  const summary = {
    done: 0,
    targets,
    failures: [],
    kept: 0,
    // Missing-upstream skills still used by agents: the sync hard-fails until
    // the user decides in the consent modal (resolveUpdatesPendingRemovals).
    pendingRemovalGroups: [],
  };
  if (!targets) return summary;
  const btn = document.getElementById("updates-update-all-btn");
  let index = 0;
  const step = () => {
    index += 1;
    if (btn) btn.textContent = `Updating ${index}/${targets}…`;
  };
  for (const row of agents) {
    step();
    setUpdatesRowStatus(row.key, "working", "Updating…");
    try {
      const result = await window.electronAPI?.aiMarketplace?.install(row.solutionId, {
        existingAgentId: row.agentId,
      });
      if (!result?.success) throw new Error(result?.error || "Update failed");
      setUpdatesRowStatus(row.key, "done", "Updated");
      summary.done += 1;
    } catch (error) {
      setUpdatesRowStatus(row.key, "error", "Failed", `${error?.message || error}`);
      summary.failures.push(`${row.name}: ${error?.message || error}`);
    }
  }
  for (const row of skills) {
    if (row.dirty) {
      // Never clobber local edits from a bulk button.
      setUpdatesRowStatus(row.key, "kept", "Kept local edits");
      summary.kept += 1;
      continue;
    }
    step();
    setUpdatesRowStatus(row.key, "working", "Updating…");
    try {
      const result = await window.electronAPI?.aiMarketplace?.install(row.solutionId, {
        refreshInstalledSkillId: row.skillId,
      });
      if (!result?.success) throw new Error(result?.error || "Update failed");
      setUpdatesRowStatus(row.key, "done", "Updated");
      summary.done += 1;
    } catch (error) {
      setUpdatesRowStatus(row.key, "error", "Failed", `${error?.message || error}`);
      summary.failures.push(`${row.name}: ${error?.message || error}`);
    }
  }
  for (const row of gitRows) {
    step();
    setUpdatesRowStatus(row.key, "working", "Syncing…");
    try {
      const result = await window.electronAPI?.syncMarketplace?.(row.marketplaceId);
      if (!result?.success) throw new Error(result?.error || "Sync failed");
      applyGitSyncRowOutcome(row, result, summary);
    } catch (error) {
      setUpdatesRowStatus(row.key, "error", "Failed", `${error?.message || error}`);
      summary.failures.push(`${row.name}: ${error?.message || error}`);
    }
  }
  return summary;
}

// Human-readable reason for one per-skill sync error. skill_path_not_found is
// the moved/removed-upstream signature; everything else shows its message.
function updatesSkillSyncErrorReason(entry) {
  return entry?.errorCode === "skill_path_not_found"
    ? "Source moved or removed upstream"
    : entry?.error || "Sync failed";
}

// Truthful per-row verdict for a git marketplace sync envelope. A sync where
// every skill failed must never read "Synced" (the 2026-08-11 ux-quality
// incident hid exactly that for days).
function applyGitSyncRowOutcome(row, result, summary) {
  const errors = Array.isArray(result.skillSyncErrors) ? result.skillSyncErrors : [];
  const conflicts = Array.isArray(result.skillsConflicted) ? result.skillsConflicted : [];
  const pending = Array.isArray(result.pendingRemovals) ? result.pendingRemovals : [];
  const missing = Array.isArray(result.skillsSourceMissing)
    ? result.skillsSourceMissing
    : [];
  const updatedCount = Array.isArray(result.skillsUpdated)
    ? result.skillsUpdated.length
    : 0;

  if (pending.length) {
    summary.pendingRemovalGroups.push({
      marketplaceId: row.marketplaceId,
      marketplaceName: row.name,
      pendingRemovals: pending.map((entry) => ({
        skillId: entry.skillId,
        pluginName: entry.pluginName ?? null,
        label: updatesPluginSkillLabel(entry.skillId, entry.pluginName),
        seeded: entry.seeded === true,
        agents: Array.isArray(entry.agents) ? entry.agents : [],
      })),
    });
  }
  const unknownUsage = missing.filter((entry) => entry.agentsUnknown);
  if (unknownUsage.length) {
    summary.failures.push(
      `${row.name}: ${unknownUsage.length} removed-upstream skill${unknownUsage.length === 1 ? "" : "s"} kept — couldn't verify agent usage (services unavailable)`,
    );
  }

  if (errors.length) {
    const detail = errors
      .map(
        (entry) =>
          `${updatesPluginSkillLabel(entry.skillId, entry.pluginName)}: ${updatesSkillSyncErrorReason(entry)}`,
      )
      .join("\n");
    setUpdatesRowStatus(
      row.key,
      "error",
      updatedCount ? "Partial" : "Failed",
      detail,
    );
    summary.failures.push(
      `${row.name}: ${errors.length} skill${errors.length === 1 ? "" : "s"} failed`,
    );
    return;
  }
  if (pending.length) {
    setUpdatesRowStatus(
      row.key,
      "error",
      "Needs decision",
      `${pending.length} skill${pending.length === 1 ? "" : "s"} no longer published upstream and still used by agents.`,
    );
    return;
  }
  if (unknownUsage.length) {
    setUpdatesRowStatus(row.key, "kept", "Kept", "Couldn't verify agent usage.");
    summary.kept += 1;
    return;
  }
  if (conflicts.length && !updatedCount) {
    setUpdatesRowStatus(row.key, "kept", "Kept local edits");
    summary.kept += 1;
    return;
  }
  setUpdatesRowStatus(row.key, "done", "Synced");
  summary.done += 1;
}

// Consent flow for pendingRemovals collected across marketplaces: one modal,
// then the removal executor per marketplace. Cancel keeps everything and the
// sync reports itself incomplete (it will ask again next run — by design).
async function resolveUpdatesPendingRemovals(summary) {
  const groups = summary.pendingRemovalGroups || [];
  if (!groups.length) return { removed: 0, keptSeeded: 0, agentsFlagged: 0 };
  const totalSkills = groups.reduce(
    (count, group) => count + group.pendingRemovals.length,
    0,
  );
  const modal = window.runMarketplaceSyncRemovalModal;
  if (typeof modal !== "function") {
    summary.failures.push(
      `${totalSkills} skill${totalSkills === 1 ? "" : "s"} no longer published upstream need your decision`,
    );
    return { removed: 0, keptSeeded: 0, agentsFlagged: 0 };
  }
  const { action } = await modal(groups);
  if (action !== "proceed") {
    summary.failures.push(
      `Sync stopped: ${totalSkills} skill${totalSkills === 1 ? "" : "s"} no longer published upstream kept until you decide`,
    );
    return { removed: 0, keptSeeded: 0, agentsFlagged: 0 };
  }

  let removed = 0;
  let keptSeeded = 0;
  let agentsFlagged = 0;
  for (const group of groups) {
    const res = await window.electronAPI?.applyMarketplaceSyncRemovals?.(
      group.marketplaceId,
      group.pendingRemovals.map(({ skillId, pluginName }) => ({ skillId, pluginName })),
    );
    if (!res?.success) {
      summary.failures.push(
        `${group.marketplaceName}: ${res?.error || "could not apply removals"}`,
      );
      continue;
    }
    removed += res.removed?.length || 0;
    keptSeeded += res.keptSeeded?.length || 0;
    agentsFlagged += res.agentsFlagged?.length || 0;
    const unlinkFailures = (res.skipped || []).filter(
      (entry) => entry.reason === "unlink_failed",
    );
    if (unlinkFailures.length) {
      summary.failures.push(
        `${group.marketplaceName}: ${unlinkFailures.length} skill${unlinkFailures.length === 1 ? "" : "s"} kept — agent unlink failed`,
      );
    }
    setUpdatesRowStatus(`in-git:${group.marketplaceId}`, "done", "Synced");
    // Bundled (seeded) skills stay installed and missing after an unlink-only
    // proceed — "Resolved" would lie for those rows.
    const seededOnly = group.pendingRemovals.every((entry) => entry.seeded === true);
    if (seededOnly && res.keptSeeded?.length) {
      setUpdatesRowStatus(
        `in-git-missing:${group.marketplaceId}`,
        "kept",
        "Agents unlinked",
        "Bundled skills stay installed until an app update resolves them.",
      );
    } else {
      setUpdatesRowStatus(`in-git-missing:${group.marketplaceId}`, "done", "Resolved");
    }
  }
  return { removed, keptSeeded, agentsFlagged };
}

function updatesRemovalOutcomeMessage({ removed, keptSeeded, agentsFlagged }) {
  if (!removed && !keptSeeded) return "";
  const flaggedNote = agentsFlagged
    ? ` ${agentsFlagged} read-only agent${agentsFlagged === 1 ? "" : "s"} flagged for their owner.`
    : "";
  const removedNote = removed
    ? ` Removed ${removed} skill${removed === 1 ? "" : "s"} no longer published upstream.`
    : "";
  const seededNote = keptSeeded
    ? ` Unlinked agents from ${keptSeeded} bundled skill${keptSeeded === 1 ? "" : "s"} — they stay installed until an app update resolves them.`
    : "";
  return `${removedNote}${seededNote}${flaggedNote}`;
}

async function runUpdateAll() {
  if (updatesBulkRunning) return;
  if (!updatesInboundTargetCount()) return;
  updatesBulkRunning = true;
  const btn = document.getElementById("updates-update-all-btn");
  if (btn) btn.disabled = true;
  setUpdatesHeaderBulkDisabled(true);
  let summary;
  try {
    summary = await updateAllCore();
  } finally {
    updatesBulkRunning = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Update All";
    }
    setUpdatesHeaderBulkDisabled(false);
  }
  const removalOutcome = await resolveUpdatesPendingRemovals(summary);
  window.AgentsPublishHooks?.invalidateMarketplaceSkillLookups?.();
  window.AgentsPublishHooks?.invalidateInstalledAgentFreshness?.();
  if (summary.failures.length) {
    window.showNotification?.(
      `Updated ${summary.done} of ${summary.targets}. Failed: ${summary.failures.join("; ")}${updatesRemovalOutcomeMessage(removalOutcome)}`,
      "error",
    );
  } else {
    window.showNotification?.(
      `Updated ${summary.done} item${summary.done === 1 ? "" : "s"}.${updatesRemovalOutcomeMessage(removalOutcome)}`,
      "success",
    );
  }
  await loadUpdates(true);
}

// Republishing an agent CASCADES to its dirty dependent user skills: the
// publish engine content-writes them (outcomes below) and sets their links
// clean, and the envelope reports each one. The skills phase uses that to
// checkmark those rows as "Published with <agent>" instead of re-pushing —
// no double work. Non-content outcomes (referenced/visibility_updated/…)
// never count: those listings were not rewritten.
const CASCADE_WRITTEN_OUTCOMES = new Set([
  "published",
  "updated",
  "adopted",
  "repaired",
]);

async function publishAllCore() {
  const { agents, skills } = updatesViewState.outbound;
  const summary = {
    done: 0,
    targets: agents.length + skills.length,
    failures: [],
    kept: 0,
  };
  if (!summary.targets) return summary;
  const btn = document.getElementById("updates-publish-all-btn");
  let index = 0;
  const step = () => {
    index += 1;
    if (btn) btn.textContent = `Publishing ${index}/${summary.targets}…`;
  };
  const cascadePublishedBy = new Map();
  for (const row of agents) {
    step();
    setUpdatesRowStatus(row.key, "working", "Publishing…");
    try {
      const result = await window.AgentsPublishHooks?.republishAgentHeadless?.(
        row.agentId,
      );
      for (const report of result?.skills || []) {
        if (!CASCADE_WRITTEN_OUTCOMES.has(report?.outcome)) continue;
        if (report.solution_id) {
          cascadePublishedBy.set(String(report.solution_id), row.name);
        }
        if (report.skill_id) {
          cascadePublishedBy.set(String(report.skill_id), row.name);
        }
      }
      setUpdatesRowStatus(row.key, "done", "Published");
      summary.done += 1;
    } catch (error) {
      setUpdatesRowStatus(row.key, "error", "Failed", `${error?.message || error}`);
      summary.failures.push(`${row.name}: ${error?.message || error}`);
    }
  }
  // Belt and suspenders under the cascade map: re-read the registry so links
  // cleaned by any interim publish (including dependents of an agent whose
  // republish failed midway) are also skipped, never re-pushed.
  let freshSkillLinks = null;
  if (skills.length) {
    const res = await window.electronAPI?.aiMarketplace
      ?.listSkillLinks?.()
      .catch(() => null);
    freshSkillLinks = res?.success ? res.links || {} : null;
  }
  for (const row of skills) {
    step();
    const cascadeAgent =
      cascadePublishedBy.get(String(row.solutionId)) ||
      cascadePublishedBy.get(String(row.skillName));
    if (cascadeAgent) {
      setUpdatesRowStatus(row.key, "done", `Published with ${cascadeAgent}`);
      summary.done += 1;
      continue;
    }
    const fresh = freshSkillLinks?.[row.skillName];
    if (freshSkillLinks && fresh && fresh.hasLocalChanges !== true) {
      setUpdatesRowStatus(row.key, "done", "Published");
      summary.done += 1;
      continue;
    }
    setUpdatesRowStatus(row.key, "working", "Publishing…");
    try {
      await window.AgentSkillsHooks?.performPublishSkillToAiMarketplace?.(
        row.skillRow,
        null,
      );
      setUpdatesRowStatus(row.key, "done", "Published");
      summary.done += 1;
    } catch (error) {
      setUpdatesRowStatus(row.key, "error", "Failed", `${error?.message || error}`);
      summary.failures.push(`${row.name}: ${error?.message || error}`);
    }
  }
  return summary;
}

async function runPublishAll() {
  if (updatesBulkRunning) return;
  if (!updatesOutboundTargetCount()) return;
  updatesBulkRunning = true;
  const btn = document.getElementById("updates-publish-all-btn");
  if (btn) btn.disabled = true;
  setUpdatesHeaderBulkDisabled(true);
  let summary;
  try {
    summary = await publishAllCore();
  } finally {
    updatesBulkRunning = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Publish All";
    }
    setUpdatesHeaderBulkDisabled(false);
  }
  window.AgentsPublishHooks?.invalidateMarketplaceSkillLookups?.();
  window.AgentsPublishHooks?.invalidateInstalledAgentFreshness?.();
  if (summary.failures.length) {
    window.showNotification?.(
      `Published ${summary.done} of ${summary.targets}. Failed: ${summary.failures.join("; ")}`,
      "error",
    );
  } else {
    window.showNotification?.(
      `Published ${summary.done} item${summary.done === 1 ? "" : "s"}.`,
      "success",
    );
  }
  await loadUpdates(true);
}

// Sync All = Update All then Publish All: per-row statuses via the cores,
// ONE reload and ONE combined toast at the end. It calls the cores directly —
// the guarded wrappers would no-op under the flag this sets.
async function runSyncAll() {
  if (updatesBulkRunning) return;
  if (!updatesInboundTargetCount() && !updatesOutboundTargetCount()) return;
  updatesBulkRunning = true;
  const syncBtn = document.getElementById("updates-sync-all-btn");
  const refreshBtn = document.getElementById("updates-refresh-btn");
  const updateBtn = document.getElementById("updates-update-all-btn");
  const publishBtn = document.getElementById("updates-publish-all-btn");
  const originalSync = syncBtn ? syncBtn.innerHTML : "";
  if (syncBtn) {
    syncBtn.disabled = true;
    syncBtn.innerHTML = '<div class="btn-spinner"></div> Syncing…';
  }
  if (refreshBtn) refreshBtn.disabled = true;
  if (updateBtn) updateBtn.disabled = true;
  if (publishBtn) publishBtn.disabled = true;
  let updated;
  let published;
  try {
    updated = await updateAllCore();
    published = await publishAllCore();
  } finally {
    updatesBulkRunning = false;
    if (updateBtn) {
      updateBtn.disabled = false;
      updateBtn.textContent = "Update All";
    }
    if (publishBtn) {
      publishBtn.disabled = false;
      publishBtn.textContent = "Publish All";
    }
    if (refreshBtn) refreshBtn.disabled = false;
    if (syncBtn) {
      syncBtn.disabled = false;
      syncBtn.innerHTML = originalSync;
    }
  }
  const removalOutcome = await resolveUpdatesPendingRemovals(updated);
  window.AgentsPublishHooks?.invalidateMarketplaceSkillLookups?.();
  window.AgentsPublishHooks?.invalidateInstalledAgentFreshness?.();
  const failures = [...updated.failures, ...published.failures];
  if (failures.length) {
    window.showNotification?.(
      `Synced ${updated.done + published.done} of ${updated.targets + published.targets}. Failed: ${failures.join("; ")}${updatesRemovalOutcomeMessage(removalOutcome)}`,
      "error",
    );
  } else {
    window.showNotification?.(
      `Synced: ${updated.done} updated, ${published.done} published.${updatesRemovalOutcomeMessage(removalOutcome)}`,
      "success",
    );
  }
  await loadUpdates(true);
}

// ---------------------------------------------------------------------------
// View switching (cost-dashboard pattern: self-contained; every OTHER nav
// button gets a hide-me listener, and showUpdatesView hides everyone else)
// ---------------------------------------------------------------------------

const UPDATES_OTHER_VIEWS = [
  ["view-mcp-servers-btn", "mcp-servers-view", "mcp-header-actions"],
  ["view-agents-tab-btn", "agents-tab-view", "agents-tab-header-actions"],
  ["view-agent-skills-btn", "agent-skills-view", "skills-header-actions"],
  ["view-cost-dashboard-btn", "cost-dashboard-view", "cost-dashboard-header-actions"],
];

function setUpdatesViewVisible(isVisible) {
  const view = document.getElementById("updates-view");
  const actions = document.getElementById("updates-header-actions");
  if (view) view.style.display = isVisible ? "" : "none";
  if (actions) actions.style.display = isVisible ? "" : "none";
  if (!isVisible) {
    document.getElementById("view-updates-btn")?.classList.remove("active");
  }
}

function showUpdatesView() {
  document.getElementById("view-updates-btn")?.classList.add("active");
  for (const [btnId, viewId, actionsId] of UPDATES_OTHER_VIEWS) {
    document.getElementById(btnId)?.classList.remove("active");
    const view = document.getElementById(viewId);
    if (view) view.style.display = "none";
    const actions = document.getElementById(actionsId);
    if (actions) actions.style.display = "none";
  }
  setUpdatesViewVisible(true);
  if (window.appState) {
    window.appState.controlPlaneView = "updates";
  }
  // Arrival with a fresh-enough load (<45s) renders instantly from state —
  // tab-flipping must not re-run the whole update sweep on every entry. The
  // explicit Refresh button and post-bulk reloads still force a full reload.
  const fresh =
    updatesViewState.loadedAt && Date.now() - updatesViewState.loadedAt < 45_000;
  if (fresh && !updatesViewLoading && !updatesBulkRunning) {
    renderUpdatesView();
    return;
  }
  // Arrival = a Refresh click: spinner on the button + forced reload (the
  // busy no-op inside handleUpdatesRefresh absorbs rapid re-arrivals).
  void handleUpdatesRefresh();
}

// Refresh feedback comes from the button spinner + the panels' loading
// state for exactly as long as the reload actually runs — no artificial
// floor (it read as the data being held back).
async function handleUpdatesRefresh() {
  const btn = document.getElementById("updates-refresh-btn");
  if (btn?.disabled) return;
  let restore = null;
  if (btn) {
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<div class="btn-spinner"></div> Refreshing…';
    restore = () => {
      // A bulk run may have started inside the refresh window — the stale
      // restore must not re-enable Refresh mid-run.
      btn.disabled = updatesBulkRunning;
      btn.innerHTML = original;
    };
  }
  try {
    await loadUpdates(true);
  } finally {
    restore?.();
  }
}

function initUpdatesView() {
  if (updatesViewInitialized) return;
  updatesViewInitialized = true;

  const shell = getUpdatesShell();
  const selfBtn = document.getElementById("view-updates-btn");
  if (!shell || !selfBtn) return;

  selfBtn.addEventListener("click", showUpdatesView);
  for (const [btnId] of UPDATES_OTHER_VIEWS) {
    document
      .getElementById(btnId)
      ?.addEventListener("click", () => setUpdatesViewVisible(false));
  }
  document.getElementById("updates-refresh-btn")?.addEventListener("click", () => {
    void handleUpdatesRefresh();
  });
  document.getElementById("updates-sync-all-btn")?.addEventListener("click", () => {
    void runSyncAll();
  });
  // Bulk buttons live inside re-rendered shell HTML: one delegated listener.
  shell.addEventListener("click", (event) => {
    const target = event.target?.closest?.("button") || event.target;
    if (!target?.id) return;
    if (target.id === "updates-update-all-btn") void runUpdateAll();
    else if (target.id === "updates-publish-all-btn") void runPublishAll();
  });
}

window.UpdatesViewHooks = {
  daysBehindLabel,
  buildInboundRows,
  buildOutboundRows,
  loadUpdates,
  runUpdateAll,
  runPublishAll,
  runSyncAll,
  showUpdatesView,
  stateForTests: () => updatesViewState,
};
window.initUpdatesView = initUpdatesView;

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initUpdatesView);
} else {
  initUpdatesView();
}
