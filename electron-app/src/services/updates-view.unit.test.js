// Behavioral tests for the control-plane "Updates" tab (updates-view.js):
// view switching, inbound/outbound row assembly, the Update All / Publish All
// bulk loops, and the days-behind arithmetic. Plain-script component → the
// source is evaluated directly in a vm context with a FakeElement DOM and a
// recording window.electronAPI (agents-tab-overhaul-v2 harness pattern).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const UPDATES_VIEW_PATH = path.join(
  __dirname,
  "..",
  "renderer",
  "components",
  "updates-view.js",
);

class FakeClassList {
  constructor() {
    this.classes = new Set();
  }
  add(...names) {
    names.filter(Boolean).forEach((name) => this.classes.add(name));
  }
  remove(...names) {
    names.filter(Boolean).forEach((name) => this.classes.delete(name));
  }
  contains(name) {
    return this.classes.has(name);
  }
}

class FakeElement {
  constructor(id) {
    this.id = id;
    this.classList = new FakeClassList();
    this.style = { display: "" };
    this.dataset = {};
    this.disabled = false;
    this.textContent = "";
    this.innerHTML = "";
    this.listeners = new Map();
    this.statusCells = null; // set on the shell by the harness
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  click() {
    (this.listeners.get("click") || []).forEach((handler) =>
      handler({ target: { closest: () => null } }),
    );
  }
  querySelector(selector) {
    // The component addresses per-row status cells through the shell:
    // `[data-update-row="<key>"] .updates-status`.
    const match = /\[data-update-row="(.+?)"\]/.exec(String(selector || ""));
    if (match && this.statusCells) {
      if (!this.statusCells.has(match[1])) {
        this.statusCells.set(match[1], { dataset: { status: "idle" } });
      }
      return this.statusCells.get(match[1]);
    }
    return null;
  }
}

function flushAsync(rounds = 8) {
  let p = Promise.resolve();
  for (let i = 0; i < rounds; i += 1) {
    p = p.then(() => new Promise((resolve) => setImmediate(resolve)));
  }
  return p;
}

function loadUpdatesViewHarness(overrides = {}) {
  const elements = new Map();
  const getElementById = (id) => {
    if (!elements.has(id)) elements.set(id, new FakeElement(id));
    return elements.get(id);
  };
  const shell = getElementById("updates-shell");
  shell.statusCells = new Map();

  const calls = [];
  const notifications = [];

  const fixtures = {
    agentLinks: {},
    skillLinks: {},
    marketplaces: [],
    installedSkills: [],
    skills: [],
    ownedSolutions: [],
    searchResults: [],
    sweepUpdates: [],
    solutionsById: {},
    ...overrides.fixtures,
  };

  const electronAPI = {
    aiMarketplace: {
      listLinks: async () => {
        calls.push(["listLinks"]);
        return { success: true, links: fixtures.agentLinks };
      },
      listSkillLinks: async () => {
        calls.push(["listSkillLinks"]);
        return { success: true, links: fixtures.skillLinks };
      },
      listPublished: async () => {
        calls.push(["listPublished"]);
        return { success: true, data: { solutions: fixtures.ownedSolutions } };
      },
      search: async (params) => {
        calls.push(["search", params]);
        return { success: true, data: { results: fixtures.searchResults } };
      },
      getSolution: async (id) => {
        calls.push(["getSolution", id]);
        const data = fixtures.solutionsById[id];
        return data ? { success: true, data } : { success: false };
      },
      install: async (solutionId, options) => {
        calls.push(["install", solutionId, options]);
        if (typeof overrides.installImpl === "function") {
          return overrides.installImpl(solutionId, options);
        }
        return { success: true };
      },
    },
    getMarketplaces: async () => {
      calls.push(["getMarketplaces"]);
      return {
        success: true,
        data: {
          marketplaces: fixtures.marketplaces,
          installedSkills: fixtures.installedSkills,
        },
      };
    },
    getSkills: async () => {
      calls.push(["getSkills"]);
      return { success: true, skills: fixtures.skills };
    },
    checkSkillUpdates: async (options) => {
      calls.push(["checkSkillUpdates", options]);
      return { success: true, updates: fixtures.sweepUpdates, hasUpdates: true };
    },
    syncMarketplace: async (marketplaceId) => {
      calls.push(["syncMarketplace", marketplaceId]);
      if (typeof overrides.syncImpl === "function") {
        return overrides.syncImpl(marketplaceId);
      }
      return { success: true };
    },
    applyMarketplaceSyncRemovals: async (marketplaceId, removals) => {
      calls.push(["applyMarketplaceSyncRemovals", marketplaceId, removals]);
      if (typeof overrides.applyRemovalsImpl === "function") {
        return overrides.applyRemovalsImpl(marketplaceId, removals);
      }
      return {
        success: true,
        removed: removals,
        skipped: [],
        agentsUpdated: [],
        agentsFlagged: [],
        agentsSkipped: [],
      };
    },
  };

  const windowObject = {
    appState: { controlPlaneView: "mcp-servers" },
    electronAPI,
    showNotification: (message, kind) => notifications.push([message, kind]),
    AgentsPublishHooks: {
      republishCalls: [],
      republishAgentHeadless: async (agentId) => {
        windowObject.AgentsPublishHooks.republishCalls.push(agentId);
        if (typeof overrides.republishImpl === "function") {
          return overrides.republishImpl(agentId);
        }
        return { solutionId: `republished-${agentId}` };
      },
      invalidated: 0,
      invalidateMarketplaceSkillLookups: () => {
        windowObject.AgentsPublishHooks.invalidated += 1;
      },
      agentFreshnessInvalidated: 0,
      invalidateInstalledAgentFreshness: () => {
        windowObject.AgentsPublishHooks.agentFreshnessInvalidated += 1;
      },
    },
    AgentSkillsHooks: {
      publishCalls: [],
      performPublishSkillToAiMarketplace: async (skillRow) => {
        windowObject.AgentSkillsHooks.publishCalls.push(skillRow?.name);
        if (typeof overrides.publishSkillImpl === "function") {
          return overrides.publishSkillImpl(skillRow);
        }
        return true;
      },
    },
    SkillCardRenderer: {
      formatSkillDisplayName: (value) =>
        String(value || "")
          .split(/[-_/\s]+/)
          .filter(Boolean)
          .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
          .join(" "),
      composeSkillPluginLabel: (label, plugin) =>
        plugin
          ? `${windowObject.SkillCardRenderer.formatSkillDisplayName(plugin)} → ${label}`
          : label,
    },
  };
  windowObject.window = windowObject;
  // Destructive-sync consent modal stub: records payloads, answers with the
  // override (default: cancel — the safe path).
  windowObject.syncRemovalModalCalls = [];
  windowObject.runMarketplaceSyncRemovalModal = async (groups) => {
    windowObject.syncRemovalModalCalls.push(groups);
    if (typeof overrides.removalModalImpl === "function") {
      return overrides.removalModalImpl(groups);
    }
    return { action: "cancel" };
  };

  const documentObject = {
    readyState: "complete",
    getElementById,
    addEventListener: () => {},
  };

  const context = {
    window: windowObject,
    document: documentObject,
    console,
    setTimeout,
    clearTimeout,
    setImmediate,
    Promise,
    Date,
    Math,
    Map,
    Set,
    JSON,
    Number,
    String,
    Object,
    Array,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInNewContext(fs.readFileSync(UPDATES_VIEW_PATH, "utf8"), context, {
    filename: UPDATES_VIEW_PATH,
  });

  return {
    window: windowObject,
    elements,
    getElementById,
    shell,
    calls,
    notifications,
    fixtures,
    hooks: windowObject.UpdatesViewHooks,
  };
}

// Shared "everything stale" fixture: one inbound agent (stamp 3 days past the
// baseline), one clean + one dirty solutions skill, one git marketplace with
// a plugin skill, and one dirty published agent + skill on the outbound side.
function fullFixtures() {
  return {
    agentLinks: {
      "agent-fresh": {
        relationship: "installed",
        solutionId: "sol-agent-fresh",
        remoteUpdatedAt: "2026-08-01T00:00:00Z",
      },
      "agent-current": {
        relationship: "installed",
        solutionId: "sol-agent-current",
        remoteUpdatedAt: "2026-08-01T00:00:00Z",
      },
      "agent-pub-dirty": {
        relationship: "published",
        solutionId: "sol-pub-agent",
        hasLocalChanges: true,
        lastUpdatedAt: Date.parse("2026-08-01T00:00:00Z"),
      },
      "agent-pub-dead": {
        relationship: "published",
        solutionId: "sol-gone",
        hasLocalChanges: true,
      },
    },
    skillLinks: {
      "my-skill": { solutionId: "sol-pub-skill", hasLocalChanges: true },
      "ghost-skill": { solutionId: "sol-pub-ghost", hasLocalChanges: true },
      "clean-skill": { solutionId: "sol-pub-clean", hasLocalChanges: false },
    },
    marketplaces: [
      {
        id: "team-git",
        name: "team-git",
        owner: { name: "Community" },
        lastSynced: "2026-07-30T00:00:00Z",
      },
    ],
    installedSkills: [
      {
        marketplaceId: "ai-marketplace",
        skillId: "writing-helper",
        hasUpdate: true,
        remoteUpdatedAt: "2026-08-01T00:00:00Z",
        skillSource: { type: "ai-marketplace-solution", solutionId: "sol-skill-upd" },
      },
      {
        marketplaceId: "ai-marketplace",
        skillId: "dirty-solutions",
        hasUpdate: true,
        isDirty: true,
        remoteUpdatedAt: "2026-08-01T00:00:00Z",
        skillSource: { type: "ai-marketplace-solution", solutionId: "sol-dirty" },
      },
      {
        marketplaceId: "team-git",
        skillId: "fixing-jira-a11y-in-bulk",
        pluginName: "a11y",
        hasUpdate: true,
      },
      { marketplaceId: "team-git", skillId: "quiet-skill", hasUpdate: false },
    ],
    skills: [
      { name: "my-skill", display_name: "My Skill", source: "user" },
      {
        name: "ai-marketplace/writing-helper",
        display_name: "Writing Helper",
        source: "marketplace",
        author: "zstevens",
        marketplace_solution_id: "sol-skill-upd",
      },
    ],
    ownedSolutions: [
      {
        id: "sol-pub-agent",
        type: "portico-agents",
        name: "My Published Agent",
        author: "dsantiago",
        updated_timestamp: "2026-08-01T00:00:00Z",
      },
      {
        id: "sol-pub-skill",
        type: "skills",
        name: "my-skill",
        author: "dsantiago",
        updated_timestamp: "2026-08-02T00:00:00Z",
      },
      {
        id: "sol-pub-ghost",
        type: "skills",
        name: "ghost-skill",
        author: "dsantiago",
        updated_timestamp: "2026-08-02T00:00:00Z",
      },
    ],
    searchResults: [
      {
        id: "sol-agent-fresh",
        name: "Fresh Agent",
        author: "zstevens",
        updated_timestamp: "2026-08-04T00:00:00Z",
      },
      {
        id: "sol-agent-current",
        name: "Current Agent",
        author: "zstevens",
        updated_timestamp: "2026-08-01T00:00:00Z",
      },
    ],
    sweepUpdates: [
      {
        marketplaceId: "ai-marketplace",
        skillId: "writing-helper",
        remoteVersion: "2026-08-04T00:00:00Z",
      },
      {
        marketplaceId: "ai-marketplace",
        skillId: "dirty-solutions",
        remoteVersion: "2026-08-04T00:00:00Z",
      },
      {
        marketplaceId: "team-git",
        skillId: "fixing-jira-a11y-in-bulk",
        remoteVersion: "2.0.0",
        headCommittedAt: "2026-08-02T00:00:00Z",
      },
    ],
    solutionsById: {},
  };
}

// ---- days-behind arithmetic -------------------------------------------------

test("daysBehindLabel boundaries: unknown, same-day, exact days", () => {
  const { hooks } = loadUpdatesViewHarness();
  const day = 86400000;
  const base = Date.parse("2026-08-01T00:00:00Z");
  assert.equal(hooks.daysBehindLabel(null, base), "—");
  assert.equal(hooks.daysBehindLabel(base, null), "—");
  assert.equal(hooks.daysBehindLabel(base, base), "<1 day");
  assert.equal(hooks.daysBehindLabel(base + day / 2, base), "<1 day");
  assert.equal(hooks.daysBehindLabel(base + day, base), "1 day");
  assert.equal(hooks.daysBehindLabel(base + 3 * day + 5000, base), "3 days");
  assert.equal(hooks.daysBehindLabel(base - day, base), "<1 day");
});

// ---- view wiring --------------------------------------------------------------

test("the Updates nav button shows the view, hides the other four, and loads once", async () => {
  const h = loadUpdatesViewHarness({ fixtures: fullFixtures() });
  h.getElementById("view-updates-btn").click();
  await flushAsync();

  assert.equal(h.getElementById("updates-view").style.display, "");
  assert.equal(h.getElementById("updates-header-actions").style.display, "");
  assert.equal(h.getElementById("view-updates-btn").classList.contains("active"), true);
  for (const id of [
    "mcp-servers-view",
    "agents-tab-view",
    "agent-skills-view",
    "cost-dashboard-view",
  ]) {
    assert.equal(h.getElementById(id).style.display, "none", `${id} hidden`);
  }
  for (const id of [
    "view-mcp-servers-btn",
    "view-agents-tab-btn",
    "view-agent-skills-btn",
    "view-cost-dashboard-btn",
  ]) {
    assert.equal(h.getElementById(id).classList.contains("active"), false);
  }
  assert.equal(h.window.appState.controlPlaneView, "updates");
  assert.equal(h.calls.filter(([name]) => name === "listLinks").length, 1);
  // The passive sweep must never be allowed to pop interactive auth.
  const sweepCall = h.calls.find(([name]) => name === "checkSkillUpdates");
  assert.deepEqual(JSON.parse(JSON.stringify(sweepCall[1])), { interactiveAuth: false });

  // Any other nav button hides the view and de-activates the button.
  h.getElementById("view-agents-tab-btn").click();
  assert.equal(h.getElementById("updates-view").style.display, "none");
  assert.equal(
    h.getElementById("view-updates-btn").classList.contains("active"),
    false,
  );

  // Refresh re-loads (the arrival refresh has already settled — no floor).
  h.getElementById("updates-refresh-btn").click();
  await flushAsync();
  assert.equal(h.calls.filter(([name]) => name === "listLinks").length, 2);
});

test("first load renders the sweep's verdicts, not the pre-sweep registry snapshot", async () => {
  const h = loadUpdatesViewHarness();
  // Registry reads cross IPC as point-in-time snapshots, and the sweep saves
  // its verdicts only at its end. Model both faithfully: getMarketplaces
  // deep-clones at invocation; checkSkillUpdates flips the flags before it
  // resolves. Reading the registry concurrently with the sweep renders the
  // previous sweep's world — the tab must read only after the sweep lands.
  const registry = {
    marketplaces: [
      {
        id: "team-git",
        name: "team-git",
        owner: { name: "Community" },
        lastSynced: "2026-07-30T00:00:00Z",
      },
    ],
    installedSkills: [
      {
        marketplaceId: "ai-marketplace",
        skillId: "late-bloomer",
        hasUpdate: false,
        remoteUpdatedAt: "2026-08-01T00:00:00Z",
        skillSource: { type: "ai-marketplace-solution", solutionId: "sol-late" },
      },
      {
        marketplaceId: "team-git",
        skillId: "gone-upstream",
        pluginName: "ux-quality-beta",
        hasUpdate: true,
      },
    ],
  };
  const api = h.window.electronAPI;
  api.getMarketplaces = async () => ({
    success: true,
    data: JSON.parse(JSON.stringify(registry)),
  });
  api.checkSkillUpdates = async () => {
    const [solutions, git] = registry.installedSkills;
    solutions.hasUpdate = true; // the sweep found the pending listing update…
    git.hasUpdate = false; // …and reclassified the upstream deletion
    git.sourceMissing = true;
    return {
      success: true,
      updates: [
        {
          marketplaceId: "ai-marketplace",
          skillId: "late-bloomer",
          remoteVersion: "2026-08-04T00:00:00Z",
        },
      ],
      hasUpdates: true,
    };
  };

  await h.hooks.loadUpdates(true);

  const inbound = h.hooks.stateForTests().inbound;
  assert.deepEqual(
    JSON.parse(JSON.stringify(inbound.skills.map((row) => [row.name, row.drift]))),
    [["Late Bloomer", "3 days"]],
    "the update the sweep just found appears on the same visit",
  );
  assert.equal(
    inbound.gitMarketplaces.length,
    0,
    "the stale 'Updates available' row must not survive the sweep's verdict",
  );
  assert.equal(inbound.gitMissing.length, 1);
  assert.equal(inbound.gitMissing[0].statusLabel, "No longer published");
});

// ---- inbound assembly ----------------------------------------------------------

test("inbound rows: flagged agent with 3-day gap; current agent excluded", () => {
  const { hooks } = loadUpdatesViewHarness();
  const fx = fullFixtures();
  const inbound = hooks.buildInboundRows({
    agentLinks: fx.agentLinks,
    agentListingsById: new Map(fx.searchResults.map((s) => [s.id, s])),
    installedSkills: fx.installedSkills,
    marketplaces: fx.marketplaces,
    skillRows: fx.skills,
    sweepUpdates: fx.sweepUpdates,
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(inbound.agents.map((row) => [row.name, row.author, row.drift]))),
    [["Fresh Agent", "zstevens", "3 days"]],
  );
  assert.equal(inbound.agents[0].agentId, "agent-fresh");
  assert.equal(inbound.agents[0].solutionId, "sol-agent-fresh");
  assert.equal(inbound.agents[0].statusLabel, "Update available");
  assert.equal(inbound.agents[0].statusTone, "update");
});

test("inbound rows: persisted hasRemoteUpdate flags even without a listing (days —)", () => {
  const { hooks } = loadUpdatesViewHarness();
  const inbound = hooks.buildInboundRows({
    agentLinks: {
      "agent-flagged": {
        relationship: "installed",
        solutionId: "sol-hidden",
        remoteUpdatedAt: "2026-08-01T00:00:00Z",
        hasRemoteUpdate: true,
      },
    },
    agentListingsById: new Map(),
  });
  assert.equal(inbound.agents.length, 1);
  assert.equal(inbound.agents[0].name, "agent-flagged");
  assert.equal(inbound.agents[0].drift, "—");
});

test("inbound rows: solutions skills only — git records never enter the skills section", () => {
  const { hooks } = loadUpdatesViewHarness();
  const fx = fullFixtures();
  const inbound = hooks.buildInboundRows({
    agentLinks: {},
    agentListingsById: new Map(),
    installedSkills: fx.installedSkills,
    marketplaces: fx.marketplaces,
    skillRows: fx.skills,
    sweepUpdates: fx.sweepUpdates,
  });
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(inbound.skills.map((row) => [row.name, row.author, row.drift, row.dirty])),
    ),
    [
      ["Dirty Solutions", "—", "3 days", true],
      ["Writing Helper", "zstevens", "3 days", false],
    ],
  );
  // Git rows group by marketplace with plugin-composed labels.
  assert.equal(inbound.gitMarketplaces.length, 1);
  const git = inbound.gitMarketplaces[0];
  assert.equal(git.name, "team-git");
  assert.equal(git.author, "Community");
  assert.equal(git.drift, "3 days"); // head 2026-08-02 vs lastSynced 2026-07-30
  assert.equal(git.statusLabel, "Updates available");
  assert.deepEqual(JSON.parse(JSON.stringify(git.staleLabels)), [
    "A11y → Fixing Jira A11y In Bulk",
  ]);
});

test("inbound rows: git marketplace without a head date renders — and unflagged marketplaces stay out", () => {
  const { hooks } = loadUpdatesViewHarness();
  const inbound = hooks.buildInboundRows({
    installedSkills: [
      { marketplaceId: "team-git", skillId: "alpha", hasUpdate: true },
      { marketplaceId: "calm-git", skillId: "beta", hasUpdate: false },
    ],
    marketplaces: [
      { id: "team-git", name: "team-git", owner: { name: "Community" }, lastSynced: "2026-07-30T00:00:00Z" },
      { id: "calm-git", name: "calm-git", owner: { name: "Someone" } },
    ],
    sweepUpdates: [],
  });
  assert.equal(inbound.gitMarketplaces.length, 1);
  assert.equal(inbound.gitMarketplaces[0].drift, "—");
});

test("inbound rows: source-missing records render 'No longer published', never 'Updates available'", () => {
  const { hooks } = loadUpdatesViewHarness();
  // Missing-row drift = time since the upstream removal commit
  // (sourceMissingSince), oldest stamp in the group; unstamped records are
  // ignored, and a group with no stamps at all keeps the honest "—".
  const nowMs = Date.parse("2026-08-11T12:00:00Z");
  const inbound = hooks.buildInboundRows({
    installedSkills: [
      {
        marketplaceId: "team-git",
        skillId: "accessibility-quality",
        pluginName: "ux-quality-beta",
        hasUpdate: false,
        sourceMissing: true,
        sourceMissingSince: "2026-08-08T00:00:00Z", // 3.5 days before nowMs
      },
      {
        marketplaceId: "team-git",
        skillId: "design-system-quality",
        pluginName: "ux-quality-beta",
        hasUpdate: false,
        sourceMissing: true,
        sourceMissingSince: "2026-08-01T00:00:00Z", // oldest — wins
      },
      {
        marketplaceId: "team-git",
        skillId: "content-quality",
        pluginName: "ux-quality-beta",
        hasUpdate: false,
        sourceMissing: true, // stamp fetch failed — must not break the row
      },
      { marketplaceId: "team-git", skillId: "alpha", hasUpdate: true },
      {
        marketplaceId: "bare-git",
        skillId: "gone-quietly",
        hasUpdate: false,
        sourceMissing: true, // no stamps anywhere in this marketplace
      },
    ],
    marketplaces: [
      {
        id: "team-git",
        name: "team-git",
        owner: { name: "Community" },
        lastSynced: "2026-07-30T00:00:00Z",
      },
      { id: "bare-git", name: "bare-git", owner: { name: "Someone" } },
    ],
    sweepUpdates: [],
    nowMs,
  });
  // The flagged record still yields its normal update row…
  assert.equal(inbound.gitMarketplaces.length, 1);
  // …while the missing records get their own honest rows.
  assert.equal(inbound.gitMissing.length, 2);
  const missing = inbound.gitMissing.find((row) => row.marketplaceId === "team-git");
  assert.equal(missing.key, "in-git-missing:team-git");
  assert.equal(missing.statusLabel, "No longer published");
  assert.equal(missing.statusTone, "missing");
  assert.equal(missing.missing, true);
  assert.equal(missing.drift, "10 days", "oldest removal stamp anchors the row's drift");
  assert.deepEqual(JSON.parse(JSON.stringify(missing.staleLabels)), [
    "Ux Quality Beta → Accessibility Quality",
    "Ux Quality Beta → Content Quality",
    "Ux Quality Beta → Design System Quality",
  ]);
  const bare = inbound.gitMissing.find((row) => row.marketplaceId === "bare-git");
  assert.equal(bare.drift, "—", "no stamps → no fake number");
  assert.equal(bare.statusLabel, "No longer published");
});

test("author cells prefer listing display names, then the viewer's own full name, then ldap", () => {
  const { hooks } = loadUpdatesViewHarness();
  const viewer = {
    ldaps: new Set(["dsantiago", "dsantiago@example.invalid"]),
    fullName: "Dionny Santiago",
  };
  const inbound = hooks.buildInboundRows({
    agentLinks: {
      "agent-named": {
        relationship: "installed",
        solutionId: "sol-named",
        remoteUpdatedAt: "2026-08-01T00:00:00Z",
      },
      "agent-foreign": {
        relationship: "installed",
        solutionId: "sol-foreign",
        remoteUpdatedAt: "2026-08-01T00:00:00Z",
      },
    },
    agentListingsById: new Map([
      [
        "sol-named",
        {
          id: "sol-named",
          name: "Named Agent",
          author: "zstevens",
          author_display_name: "Zach Stevens",
          updated_timestamp: "2026-08-04T00:00:00Z",
        },
      ],
      [
        "sol-foreign",
        {
          id: "sol-foreign",
          name: "Foreign Agent",
          author: "zstevens",
          updated_timestamp: "2026-08-04T00:00:00Z",
        },
      ],
    ]),
    viewer,
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(inbound.agents.map((row) => [row.name, row.author]))),
    [
      ["Foreign Agent", "zstevens"], // no display name, not the viewer → ldap stays
      ["Named Agent", "Zach Stevens"],
    ],
  );

  const outbound = hooks.buildOutboundRows({
    agentLinks: {
      "my-agent": {
        relationship: "published",
        solutionId: "sol-mine",
        hasLocalChanges: true,
        lastUpdatedAt: Date.parse("2026-08-01T00:00:00Z"),
      },
    },
    ownedSolutions: [
      {
        id: "sol-mine",
        type: "portico-agents",
        name: "My Agent",
        author: "dsantiago",
        updated_timestamp: "2026-08-01T00:00:00Z",
      },
    ],
    nowMs: Date.parse("2026-08-04T00:00:00Z"),
    viewer,
  });
  assert.equal(
    outbound.agents[0].author,
    "Dionny Santiago",
    "the viewer's own legacy rows swap ldap for the session full name",
  );
});

test("inbound rows: a degraded sweep falls back to the persisted head date for git drift", () => {
  const { hooks } = loadUpdatesViewHarness();
  // Two flagged records in the marketplace; the drift uses the NEWEST
  // persisted date. The sweep supplied nothing (failed probes keep flags).
  const inbound = hooks.buildInboundRows({
    installedSkills: [
      {
        marketplaceId: "team-git",
        skillId: "alpha",
        hasUpdate: true,
        updateHeadCommittedAt: "2026-08-01T00:00:00Z",
      },
      {
        marketplaceId: "team-git",
        skillId: "beta",
        hasUpdate: true,
        updateHeadCommittedAt: "2026-08-02T00:00:00Z",
      },
    ],
    marketplaces: [
      { id: "team-git", name: "team-git", owner: { name: "Community" }, lastSynced: "2026-07-30T00:00:00Z" },
    ],
    sweepUpdates: [],
  });
  assert.equal(inbound.gitMarketplaces.length, 1);
  assert.equal(inbound.gitMarketplaces[0].drift, "3 days"); // 08-02 vs 07-30
});

test("inbound rows: a live sweep head date wins over the persisted fallback", () => {
  const { hooks } = loadUpdatesViewHarness();
  const inbound = hooks.buildInboundRows({
    installedSkills: [
      {
        marketplaceId: "team-git",
        skillId: "alpha",
        hasUpdate: true,
        updateHeadCommittedAt: "2026-07-31T00:00:00Z",
      },
    ],
    marketplaces: [
      { id: "team-git", name: "team-git", owner: { name: "Community" }, lastSynced: "2026-07-30T00:00:00Z" },
    ],
    sweepUpdates: [
      {
        marketplaceId: "team-git",
        skillId: "alpha",
        remoteVersion: "2.0.0",
        headCommittedAt: "2026-08-04T00:00:00Z",
      },
    ],
  });
  assert.equal(inbound.gitMarketplaces[0].drift, "5 days"); // sweep 08-04, not record 07-31
});

// ---- outbound assembly ---------------------------------------------------------

test("outbound rows: verified dirty agent + skill; dead links, clean links, and ghost skills excluded", () => {
  const { hooks } = loadUpdatesViewHarness();
  const fx = fullFixtures();
  const nowMs = Date.parse("2026-08-04T00:00:00Z");
  const outbound = hooks.buildOutboundRows({
    agentLinks: fx.agentLinks,
    skillLinks: fx.skillLinks,
    ownedSolutions: fx.ownedSolutions,
    skillRows: fx.skills,
    nowMs,
  });
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        outbound.agents.map((row) => [row.agentId, row.name, row.author, row.drift]),
      ),
    ),
    [["agent-pub-dirty", "My Published Agent", "dsantiago", "3 days"]],
  );
  assert.equal(outbound.agents[0].statusLabel, "Unpublished changes");
  assert.equal(outbound.agents[0].statusTone, "dirty");
  // ghost-skill has a live listing but no local user copy → excluded;
  // clean-skill isn't dirty; my-skill renders with drift vs its listing stamp.
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(outbound.skills.map((row) => [row.skillName, row.name, row.drift])),
    ),
    [["my-skill", "My Skill", "2 days"]],
  );
  assert.equal(outbound.skills[0].statusLabel, "Unpublished changes");
  // Installed-relationship links never show as outbound.
  assert.ok(!outbound.agents.some((row) => row.agentId === "agent-fresh"));
});

// ---- Update All ---------------------------------------------------------------

test("Update All runs agents, then clean solutions skills, then git syncs; dirty skills kept", async () => {
  const h = loadUpdatesViewHarness({ fixtures: fullFixtures() });
  await h.hooks.loadUpdates(true);
  await flushAsync();
  const before = h.calls.length;

  await h.hooks.runUpdateAll();
  await flushAsync();

  const actions = h.calls
    .slice(before)
    .filter(([name]) => ["install", "syncMarketplace"].includes(name));
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(actions.map(([name, target, opts]) => [name, target, opts || null])),
    ),
    [
      ["install", "sol-agent-fresh", { existingAgentId: "agent-fresh" }],
      ["install", "sol-skill-upd", { refreshInstalledSkillId: "writing-helper" }],
      ["syncMarketplace", "team-git", null],
    ],
  );
  assert.equal(
    h.shell.statusCells.get("in-agent:agent-fresh").dataset.status,
    "done",
  );
  assert.equal(
    h.shell.statusCells.get("in-skill:ai-marketplace:writing-helper").dataset.status,
    "done",
  );
  assert.equal(
    h.shell.statusCells.get("in-skill:ai-marketplace:dirty-solutions").dataset.status,
    "kept",
    "local edits are never clobbered from the bulk button",
  );
  assert.equal(h.shell.statusCells.get("in-git:team-git").dataset.status, "done");
  // Chips carry human labels, never bare glyphs.
  assert.equal(h.shell.statusCells.get("in-agent:agent-fresh").textContent, "Updated");
  assert.equal(
    h.shell.statusCells.get("in-skill:ai-marketplace:dirty-solutions").textContent,
    "Kept local edits",
  );
  assert.equal(h.shell.statusCells.get("in-git:team-git").textContent, "Synced");
  assert.equal(h.window.AgentsPublishHooks.invalidated >= 1, true);
  assert.equal(
    h.window.AgentsPublishHooks.agentFreshnessInvalidated >= 1,
    true,
    "bulk updates bust the Agents tab's session freshness map",
  );
  assert.deepEqual(h.notifications.at(-1), ["Updated 3 items.", "success"]);
  // The view reloads afterward.
  assert.ok(
    h.calls.slice(before).some(([name]) => name === "listLinks"),
    "loadUpdates re-ran after the bulk apply",
  );
  const btn = h.getElementById("updates-update-all-btn");
  assert.equal(btn.disabled, false);
  assert.equal(btn.textContent, "Update All");
});

test("Update All: one failure marks the row error, continues, and reports counts", async () => {
  const h = loadUpdatesViewHarness({
    fixtures: fullFixtures(),
    installImpl: (solutionId) =>
      solutionId === "sol-agent-fresh"
        ? { success: false, error: "boom" }
        : { success: true },
  });
  await h.hooks.loadUpdates(true);
  await h.hooks.runUpdateAll();
  await flushAsync();

  assert.equal(
    h.shell.statusCells.get("in-agent:agent-fresh").dataset.status,
    "error",
  );
  assert.equal(h.shell.statusCells.get("in-agent:agent-fresh").textContent, "Failed");
  assert.match(h.shell.statusCells.get("in-agent:agent-fresh").title, /boom/);
  assert.equal(
    h.shell.statusCells.get("in-skill:ai-marketplace:writing-helper").dataset.status,
    "done",
    "a failure never aborts the loop",
  );
  assert.equal(h.shell.statusCells.get("in-git:team-git").dataset.status, "done");
  const [message, kind] = h.notifications.at(-1);
  assert.equal(kind, "error");
  assert.match(message, /Updated 2 of 3/);
  assert.match(message, /Fresh Agent: boom/);
});

// ---- Publish All ----------------------------------------------------------------

test("Publish All republishes agents first, then only still-dirty skills", async () => {
  const fixtures = fullFixtures();
  const h = loadUpdatesViewHarness({
    fixtures,
    republishImpl: async () => {
      // The agent republish also republished its dependent skill: the
      // registry re-read must see the cleaned link and skip it.
      fixtures.skillLinks["my-skill"] = {
        solutionId: "sol-pub-skill",
        hasLocalChanges: false,
      };
      return { solutionId: "sol-pub-agent" };
    },
  });
  await h.hooks.loadUpdates(true);
  await h.hooks.runPublishAll();
  await flushAsync();

  assert.deepEqual(h.window.AgentsPublishHooks.republishCalls, ["agent-pub-dirty"]);
  assert.deepEqual(
    h.window.AgentSkillsHooks.publishCalls,
    [],
    "a link cleaned by the agent phase is never re-pushed",
  );
  assert.equal(
    h.shell.statusCells.get("out-agent:agent-pub-dirty").dataset.status,
    "done",
  );
  assert.equal(
    h.shell.statusCells.get("out-skill:my-skill").dataset.status,
    "done",
  );
  // Cleaned via the registry fallback (no cascade envelope): generic label.
  assert.equal(h.shell.statusCells.get("out-skill:my-skill").textContent, "Published");
  assert.deepEqual(h.notifications.at(-1), ["Published 2 items.", "success"]);
});

test("Publish All publishes skills that stayed dirty and continues past agent failures", async () => {
  const h = loadUpdatesViewHarness({
    fixtures: fullFixtures(),
    republishImpl: async () => {
      throw new Error("publish exploded");
    },
  });
  await h.hooks.loadUpdates(true);
  await h.hooks.runPublishAll();
  await flushAsync();

  assert.equal(
    h.shell.statusCells.get("out-agent:agent-pub-dirty").dataset.status,
    "error",
  );
  assert.equal(
    h.shell.statusCells.get("out-agent:agent-pub-dirty").textContent,
    "Failed",
  );
  assert.match(
    h.shell.statusCells.get("out-agent:agent-pub-dirty").title,
    /publish exploded/,
  );
  assert.deepEqual(h.window.AgentSkillsHooks.publishCalls, ["my-skill"]);
  assert.equal(
    h.shell.statusCells.get("out-skill:my-skill").dataset.status,
    "done",
  );
  const [message, kind] = h.notifications.at(-1);
  assert.equal(kind, "error");
  assert.match(message, /Published 1 of 2/);
  assert.match(message, /My Published Agent: publish exploded/);
  const btn = h.getElementById("updates-publish-all-btn");
  assert.equal(btn.disabled, false);
  assert.equal(btn.textContent, "Publish All");
});

// ---- refresh feedback -----------------------------------------------------------

test("Refresh disables the button and swaps the panels to a loading state until the reload lands", async () => {
  const h = loadUpdatesViewHarness({ fixtures: fullFixtures() });
  await h.hooks.loadUpdates(true);
  await flushAsync();
  const refreshBtn = h.getElementById("updates-refresh-btn");
  refreshBtn.innerHTML = "Refresh";

  // Gate the reload so the in-flight state is observable (no artificial
  // spinner floor anymore — feedback lasts exactly as long as the load).
  const mp = h.window.electronAPI.aiMarketplace;
  const origListLinks = mp.listLinks;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let loadStarts = 0;
  mp.listLinks = async () => {
    loadStarts += 1;
    await gate;
    return origListLinks();
  };

  refreshBtn.click();
  await flushAsync(2);
  assert.equal(refreshBtn.disabled, true, "refresh disables while running");
  assert.match(refreshBtn.innerHTML, /btn-spinner/);
  assert.match(refreshBtn.innerHTML, /Refreshing/);
  // Panels show an explicit loading state instead of stale tables.
  assert.match(h.shell.innerHTML, /updates-loading/);
  assert.match(h.shell.innerHTML, /id="updates-update-all-btn" disabled/);
  assert.match(h.shell.innerHTML, /id="updates-publish-all-btn" disabled/);
  assert.ok(!h.shell.innerHTML.includes("updates-table"), "stale tables are gone");
  assert.equal(h.getElementById("updates-sync-all-btn").disabled, true);

  // Second click while busy is a no-op (no double load).
  refreshBtn.click();
  await flushAsync(2);
  assert.equal(loadStarts, 1);

  release();
  await flushAsync();
  assert.equal(refreshBtn.disabled, false, "refresh restores as soon as the load lands");
  assert.equal(refreshBtn.innerHTML, "Refresh");
  assert.match(h.shell.innerHTML, /class="updates-table"/, "fresh tables render");
  assert.equal(h.getElementById("updates-sync-all-btn").disabled, false);
  assert.equal(loadStarts, 1, "exactly one reload ran");
});

// ---- render surface --------------------------------------------------------------

test("the rendered shell carries both panels, section titles, and empty states", async () => {
  const h = loadUpdatesViewHarness({ fixtures: fullFixtures() });
  await h.hooks.loadUpdates(true);
  const html = h.shell.innerHTML;
  assert.match(html, /updates-panel-title">Inbound</);
  assert.match(html, /updates-panel-title">Outbound</);
  assert.match(html, /class="updates-table"/);
  assert.match(html, /updates-table-section-row"><td colspan="4">Agents<\/td>/);
  assert.match(
    html,
    /updates-table-section-row"><td colspan="4">Skills \(Solutions Marketplace\)<\/td>/,
  );
  assert.match(html, /updates-table-section-row"><td colspan="4">Git marketplaces<\/td>/);
  assert.match(html, /<th>Status<\/th><th>Name<\/th><th>Author<\/th><th>Drift<\/th>/);
  // Idle chips: labeled statuses, never a dash.
  assert.match(
    html,
    /<span class="updates-status" data-status="update">Update available<\/span>/,
  );
  assert.match(html, /data-status="update">Updates available</);
  assert.match(html, /data-status="dirty">Unpublished changes</);
  assert.ok(!html.includes("updates-section-title"), "old section divs are gone");
  assert.ok(
    !html.includes("agents-publish-skill-table"),
    "the modal's table classes left this surface",
  );
  assert.match(html, /Updated: A11y → Fixing Jira A11y In Bulk/);
  assert.match(html, /Has local edits\. Resolve from the Marketplaces page\./);
  assert.match(html, /id="updates-update-all-btn"(?! disabled)/);
  assert.match(html, /id="updates-publish-all-btn"(?! disabled)/);
  assert.equal(h.getElementById("updates-sync-all-btn").disabled, false);

  // Empty fixture → both empty states, buttons disabled.
  const empty = loadUpdatesViewHarness();
  await empty.hooks.loadUpdates(true);
  const emptyHtml = empty.shell.innerHTML;
  assert.match(emptyHtml, /Everything is up to date\./);
  assert.match(emptyHtml, /Nothing waiting to publish\./);
  assert.match(emptyHtml, /id="updates-update-all-btn" disabled/);
  assert.match(emptyHtml, /id="updates-publish-all-btn" disabled/);
  assert.equal(empty.getElementById("updates-sync-all-btn").disabled, true);
});

// ---- Sync All --------------------------------------------------------------------

test("Sync All runs the inbound phase then the publish phase, with one reload and one combined toast", async () => {
  const h = loadUpdatesViewHarness({ fixtures: fullFixtures() });
  await h.hooks.loadUpdates(true);
  await flushAsync();
  const before = h.calls.length;
  const notificationsBefore = h.notifications.length;
  const syncBtn = h.getElementById("updates-sync-all-btn");
  syncBtn.innerHTML = "Sync All";

  await h.hooks.runSyncAll();
  await flushAsync();

  const actions = h.calls
    .slice(before)
    .filter(([name]) => ["install", "syncMarketplace"].includes(name));
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(actions.map(([name, target, opts]) => [name, target, opts || null])),
    ),
    [
      ["install", "sol-agent-fresh", { existingAgentId: "agent-fresh" }],
      ["install", "sol-skill-upd", { refreshInstalledSkillId: "writing-helper" }],
      ["syncMarketplace", "team-git", null],
    ],
  );
  assert.deepEqual(h.window.AgentsPublishHooks.republishCalls, ["agent-pub-dirty"]);
  assert.deepEqual(h.window.AgentSkillsHooks.publishCalls, ["my-skill"]);
  const sliced = h.calls.slice(before).map(([name]) => name);
  assert.ok(
    sliced.indexOf("syncMarketplace") < sliced.indexOf("listSkillLinks"),
    "the publish phase (skill-link re-read) runs after the inbound phase",
  );
  assert.equal(
    h.calls.slice(before).filter(([name]) => name === "listLinks").length,
    1,
    "exactly ONE reload for both phases",
  );
  assert.equal(h.window.AgentsPublishHooks.invalidated, 1, "one invalidate per user action");
  assert.equal(
    h.window.AgentsPublishHooks.agentFreshnessInvalidated,
    1,
    "one agent-freshness bust per user action",
  );
  assert.equal(h.notifications.length, notificationsBefore + 1, "one combined toast");
  assert.deepEqual(h.notifications.at(-1), ["Synced: 3 updated, 2 published.", "success"]);
  // Row chips from both phases.
  assert.equal(h.shell.statusCells.get("in-agent:agent-fresh").textContent, "Updated");
  assert.equal(h.shell.statusCells.get("in-git:team-git").textContent, "Synced");
  assert.equal(
    h.shell.statusCells.get("in-skill:ai-marketplace:dirty-solutions").textContent,
    "Kept local edits",
  );
  assert.equal(h.shell.statusCells.get("out-agent:agent-pub-dirty").textContent, "Published");
  assert.equal(h.shell.statusCells.get("out-skill:my-skill").textContent, "Published");
  // Button restored (fixtures still show work, so it stays enabled).
  assert.equal(syncBtn.disabled, false);
  assert.equal(syncBtn.innerHTML, "Sync All");
});

test("Sync All no-ops when there is nothing to do on either side", async () => {
  const h = loadUpdatesViewHarness();
  await h.hooks.loadUpdates(true);
  await flushAsync();
  const before = h.calls.length;
  assert.equal(
    h.getElementById("updates-sync-all-btn").disabled,
    true,
    "rendered inert with no work",
  );

  await h.hooks.runSyncAll();
  await flushAsync();
  assert.equal(h.calls.length, before, "no IPC work ran");
  assert.equal(h.notifications.length, 0);
  assert.deepEqual(h.window.AgentsPublishHooks.republishCalls, []);
});

// ---- cascade tracking -------------------------------------------------------------

test("skills republished by an agent cascade get 'Published with <agent>' and are never re-pushed", async () => {
  const h = loadUpdatesViewHarness({
    fixtures: fullFixtures(),
    republishImpl: async () => ({
      solutionId: "sol-pub-agent",
      skills: [
        { skill_id: "my-skill", outcome: "updated", solution_id: "sol-pub-skill" },
      ],
    }),
  });
  await h.hooks.loadUpdates(true);
  await h.hooks.runPublishAll();
  await flushAsync();

  assert.deepEqual(h.window.AgentsPublishHooks.republishCalls, ["agent-pub-dirty"]);
  assert.deepEqual(
    h.window.AgentSkillsHooks.publishCalls,
    [],
    "the cascade already wrote this listing — no double work",
  );
  const cell = h.shell.statusCells.get("out-skill:my-skill");
  assert.equal(cell.dataset.status, "done");
  assert.equal(cell.textContent, "Published with My Published Agent");
  assert.deepEqual(h.notifications.at(-1), ["Published 2 items.", "success"]);
});

test("non-content cascade outcomes (referenced) never skip the skill publish", async () => {
  const h = loadUpdatesViewHarness({
    fixtures: fullFixtures(),
    republishImpl: async () => ({
      solutionId: "sol-pub-agent",
      skills: [
        { skill_id: "my-skill", outcome: "referenced", solution_id: "sol-pub-skill" },
      ],
    }),
  });
  await h.hooks.loadUpdates(true);
  await h.hooks.runPublishAll();
  await flushAsync();

  assert.deepEqual(h.window.AgentSkillsHooks.publishCalls, ["my-skill"]);
  assert.equal(h.shell.statusCells.get("out-skill:my-skill").textContent, "Published");
});

// ---- header locking + arrival ------------------------------------------------------

test("Refresh and Sync All are disabled while a bulk run is in flight", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = loadUpdatesViewHarness({
    fixtures: fullFixtures(),
    installImpl: () => gate.then(() => ({ success: true })),
  });
  await h.hooks.loadUpdates(true);
  const refreshBtn = h.getElementById("updates-refresh-btn");
  const syncBtn = h.getElementById("updates-sync-all-btn");
  const listLinksBefore = h.calls.filter(([name]) => name === "listLinks").length;

  const run = h.hooks.runUpdateAll();
  await flushAsync(2);
  assert.equal(refreshBtn.disabled, true, "Refresh locked mid-run");
  assert.equal(syncBtn.disabled, true, "Sync All locked mid-run");

  // A refresh click while locked must not reload (a mid-run re-render would
  // wipe the live row statuses).
  refreshBtn.click();
  await flushAsync(2);
  assert.equal(
    h.calls.filter(([name]) => name === "listLinks").length,
    listLinksBefore,
    "locked refresh is a no-op",
  );

  release();
  await run;
  await flushAsync();
  assert.equal(refreshBtn.disabled, false, "Refresh restored after the run");
  assert.equal(syncBtn.disabled, false, "Sync All restored after the run");
});

test("arriving at the Updates tab auto-runs the refresh with the button spinner", async () => {
  const h = loadUpdatesViewHarness({ fixtures: fullFixtures() });
  const refreshBtn = h.getElementById("updates-refresh-btn");
  refreshBtn.innerHTML = "Refresh";
  const mp = h.window.electronAPI.aiMarketplace;
  const origListLinks = mp.listLinks;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  mp.listLinks = async () => {
    await gate;
    return origListLinks();
  };

  h.getElementById("view-updates-btn").click();
  await flushAsync(2);
  assert.equal(refreshBtn.disabled, true, "arrival spins the Refresh button");
  assert.match(refreshBtn.innerHTML, /btn-spinner/);
  assert.match(refreshBtn.innerHTML, /Refreshing/);
  assert.match(h.shell.innerHTML, /updates-loading/, "panels show the loading state");

  release();
  await flushAsync();
  assert.equal(refreshBtn.disabled, false, "restores when the load lands");
  assert.equal(refreshBtn.innerHTML, "Refresh");
  assert.equal(
    h.calls.filter(([name]) => name === "listLinks").length,
    1,
    "exactly one load per arrival",
  );
});

// ---------------------------------------------------------------------------
// Destructive sync: truthful git-row outcomes + the pendingRemovals consent
// flow (modal → executor). The 2026-08-11 incident regression pins live here:
// an all-failed sync must never toast "Synced: 1 updated, 0 published."
// ---------------------------------------------------------------------------

function gitSyncFixtures() {
  return {
    marketplaces: [
      {
        id: "team-git",
        name: "team-git",
        owner: { name: "Community" },
        lastSynced: "2026-07-30T00:00:00Z",
      },
    ],
    installedSkills: [
      {
        marketplaceId: "team-git",
        skillId: "accessibility-quality",
        pluginName: "ux-quality-beta",
        hasUpdate: true,
      },
    ],
  };
}

function syncEnvelope(overrides = {}) {
  return {
    success: true,
    marketplace: { id: "team-git", name: "team-git", marketplaceVersion: "1.0.0" },
    hasUpdate: false,
    skillsUpdated: [],
    skillsConflicted: [],
    skillsUpToDate: [],
    skillSyncErrors: [],
    skillsRemoved: [],
    skillsSourceMissing: [],
    pendingRemovals: [],
    agentInventoryUnavailable: false,
    ...overrides,
  };
}

test("an all-failed git sync toasts failure with the moved-upstream reason — never success", async () => {
  const h = loadUpdatesViewHarness({
    fixtures: gitSyncFixtures(),
    syncImpl: async () =>
      syncEnvelope({
        skillSyncErrors: [
          {
            skillId: "accessibility-quality",
            pluginName: "ux-quality-beta",
            error: "Skill not found at path: ./community/ux-quality-beta/skills/accessibility-quality",
            errorCode: "skill_path_not_found",
          },
        ],
      }),
  });
  await h.hooks.loadUpdates(true);
  await h.hooks.runSyncAll();

  const [message, kind] = h.notifications.at(-1);
  assert.equal(kind, "error");
  assert.match(message, /team-git: 1 skill failed/);
  assert.doesNotMatch(message, /Synced: 1 updated/);

  const statusCell = h.shell.statusCells.get("in-git:team-git");
  assert.equal(statusCell?.dataset.status, "error");
  assert.equal(statusCell?.textContent, "Failed");
  assert.match(statusCell?.title || "", /Source moved or removed upstream/);
});

test("pendingRemovals open the consent modal; Cancel keeps everything and reports the sync incomplete", async () => {
  const h = loadUpdatesViewHarness({
    fixtures: gitSyncFixtures(),
    syncImpl: async () =>
      syncEnvelope({
        pendingRemovals: [
          {
            skillId: "accessibility-quality",
            pluginName: "ux-quality-beta",
            leaf: "accessibility-quality",
            agents: [
              { id: "agent-1", name: "My Agent", relationship: null, readOnly: false },
            ],
          },
        ],
      }),
  });
  await h.hooks.loadUpdates(true);
  await h.hooks.runUpdateAll();

  assert.equal(h.window.syncRemovalModalCalls.length, 1);
  const group = h.window.syncRemovalModalCalls[0][0];
  assert.equal(group.marketplaceId, "team-git");
  assert.equal(group.pendingRemovals[0].label, "Ux Quality Beta → Accessibility Quality");
  assert.deepEqual(JSON.parse(JSON.stringify(group.pendingRemovals[0].agents)), [
    { id: "agent-1", name: "My Agent", relationship: null, readOnly: false },
  ]);

  // Cancel: no executor call, incomplete-sync toast.
  assert.ok(
    !h.calls.some(([name]) => name === "applyMarketplaceSyncRemovals"),
    "cancel must not apply removals",
  );
  const [message, kind] = h.notifications.at(-1);
  assert.equal(kind, "error");
  assert.match(message, /Sync stopped: 1 skill no longer published upstream/);
});

test("Proceed applies removals with the exact keys and reports the outcome", async () => {
  const h = loadUpdatesViewHarness({
    fixtures: gitSyncFixtures(),
    syncImpl: async () =>
      syncEnvelope({
        pendingRemovals: [
          {
            skillId: "accessibility-quality",
            pluginName: "ux-quality-beta",
            leaf: "accessibility-quality",
            agents: [
              { id: "agent-ro", name: "RO Agent", relationship: "installed", readOnly: true },
            ],
          },
        ],
      }),
    removalModalImpl: async () => ({ action: "proceed" }),
    applyRemovalsImpl: async (marketplaceId, removals) => ({
      success: true,
      removed: removals,
      skipped: [],
      agentsUpdated: [],
      agentsFlagged: [{ id: "agent-ro", name: "RO Agent" }],
      agentsSkipped: [],
    }),
  });
  await h.hooks.loadUpdates(true);
  await h.hooks.runUpdateAll();

  const applyCall = h.calls.find(([name]) => name === "applyMarketplaceSyncRemovals");
  assert.deepEqual(JSON.parse(JSON.stringify(applyCall)), [
    "applyMarketplaceSyncRemovals",
    "team-git",
    [{ skillId: "accessibility-quality", pluginName: "ux-quality-beta" }],
  ]);
  const [message, kind] = h.notifications.at(-1);
  assert.equal(kind, "success");
  assert.match(message, /Removed 1 skill no longer published upstream/);
  assert.match(message, /1 read-only agent flagged for their owner/);
});

test("seeded pendingRemovals reach the modal marked seeded; Proceed is unlink-only and the row reads 'Agents unlinked'", async () => {
  const h = loadUpdatesViewHarness({
    fixtures: gitSyncFixtures(),
    syncImpl: async () =>
      syncEnvelope({
        pendingRemovals: [
          {
            skillId: "accessibility-quality",
            pluginName: "ux-quality-beta",
            seeded: true,
            leaf: "accessibility-quality",
            agents: [
              { id: "agent-1", name: "My Agent", relationship: null, readOnly: false },
            ],
          },
        ],
      }),
    removalModalImpl: async () => ({ action: "proceed" }),
    applyRemovalsImpl: async () => ({
      success: true,
      removed: [],
      keptSeeded: [{ skillId: "accessibility-quality", pluginName: "ux-quality-beta" }],
      skipped: [],
      agentsUpdated: [{ id: "agent-1", name: "My Agent", removed: ["accessibility-quality"] }],
      agentsFlagged: [],
      agentsSkipped: [],
    }),
  });
  await h.hooks.loadUpdates(true);
  await h.hooks.runUpdateAll();

  // The modal payload carries the bundled marker so it can render the
  // unlink-only note and button.
  const group = h.window.syncRemovalModalCalls[0][0];
  assert.equal(group.pendingRemovals[0].seeded, true);

  // The skills are still installed and still missing: "Resolved" would lie.
  const missingCell = h.shell.statusCells.get("in-git-missing:team-git");
  assert.equal(missingCell?.dataset.status, "kept");
  assert.equal(missingCell?.textContent, "Agents unlinked");

  const [message, kind] = h.notifications.at(-1);
  assert.equal(kind, "success");
  assert.match(message, /Unlinked agents from 1 bundled skill/);
  assert.match(message, /stay installed until an app update resolves them/);
  assert.doesNotMatch(message, /Removed \d+ skill/);
});

test("fail-closed syncs (agent inventory down) keep the row and say why", async () => {
  const h = loadUpdatesViewHarness({
    fixtures: gitSyncFixtures(),
    syncImpl: async () =>
      syncEnvelope({
        agentInventoryUnavailable: true,
        skillsSourceMissing: [
          { skillId: "accessibility-quality", pluginName: "ux-quality-beta", agentsUnknown: true },
        ],
      }),
  });
  await h.hooks.loadUpdates(true);
  await h.hooks.runSyncAll();

  const [message, kind] = h.notifications.at(-1);
  assert.equal(kind, "error");
  assert.match(message, /couldn't verify agent usage/);
  assert.equal(h.window.syncRemovalModalCalls.length, 0);
});

test("a clean git sync still reads Synced (regression guard)", async () => {
  const h = loadUpdatesViewHarness({
    fixtures: gitSyncFixtures(),
    syncImpl: async () =>
      syncEnvelope({ skillsUpdated: [{ skillId: "accessibility-quality" }] }),
  });
  await h.hooks.loadUpdates(true);
  await h.hooks.runSyncAll();

  const [message, kind] = h.notifications.at(-1);
  assert.equal(kind, "success");
  assert.match(message, /Synced: 1 updated, 0 published/);
  const statusCell = h.shell.statusCells.get("in-git:team-git");
  assert.equal(statusCell?.textContent, "Synced");
});

test("Update All reaches a missing-only inbound (guard matches the core)", async () => {
  const h = loadUpdatesViewHarness();
  const api = h.window.electronAPI;
  api.getMarketplaces = async () => ({
    success: true,
    data: {
      marketplaces: [
        {
          id: "team-git",
          name: "team-git",
          owner: { name: "Community" },
          lastSynced: "2026-07-30T00:00:00Z",
        },
      ],
      installedSkills: [
        {
          marketplaceId: "team-git",
          skillId: "gone-upstream",
          pluginName: "ux-quality-beta",
          hasUpdate: false,
          sourceMissing: true,
        },
      ],
    },
  });
  await h.hooks.loadUpdates(true);
  const inbound = h.hooks.stateForTests().inbound;
  assert.equal(inbound.gitMissing.length, 1);
  assert.equal(
    inbound.agents.length + inbound.skills.length + inbound.gitMarketplaces.length,
    0,
    "fixture is missing-only",
  );
  // The button renders enabled for a missing-only inbound…
  assert.doesNotMatch(h.shell.innerHTML, /id="updates-update-all-btn" disabled/);
  // …and the header Sync All agrees (it keys off the same counter).
  assert.equal(h.getElementById("updates-sync-all-btn").disabled, false);

  // The regression: the guard counted 0 targets while the render counted 1,
  // so the click silently no-opped — no sync, no statuses, no toast.
  const before = h.calls.filter(([name]) => name === "syncMarketplace").length;
  await h.hooks.runUpdateAll();
  await flushAsync();
  const syncCalls = h.calls.filter(([name]) => name === "syncMarketplace");
  assert.equal(syncCalls.length - before, 1, "the missing row folds into the git sync leg");
  assert.deepEqual(syncCalls.at(-1), ["syncMarketplace", "team-git"]);
  assert.ok(h.notifications.length > 0, "the run reports an outcome");
});

test("parked missing rows: unused bundled skills read 'Waiting for app update' and leave the bulk buttons inert", async () => {
  const h = loadUpdatesViewHarness();
  const api = h.window.electronAPI;
  api.getMarketplaces = async () => ({
    success: true,
    data: {
      marketplaces: [
        { id: "team-git", name: "team-git", owner: { name: "Community" }, lastSynced: "2026-07-30T00:00:00Z" },
      ],
      installedSkills: [
        { marketplaceId: "team-git", skillId: "accessibility-quality", pluginName: "ux-quality-beta", sourceMissing: true },
        { marketplaceId: "team-git", skillId: "content-quality", pluginName: "ux-quality-beta", sourceMissing: true },
      ],
    },
  });
  const usageCalls = [];
  api.listAgentSkillUsage = async () => {
    usageCalls.push(1);
    // Existing badge-channel contract: full per-agent leaf inventory.
    return { success: true, agents: [{ id: "a1", name: "Other Agent", leaves: ["other-skill"] }] };
  };
  await h.hooks.loadUpdates(true);

  assert.equal(usageCalls.length, 1, "one inventory read per load");
  const row = h.hooks.stateForTests().inbound.gitMissing[0];
  assert.equal(row.parked, true);
  assert.equal(row.statusLabel, "Waiting for app update");
  assert.equal(row.statusTone, "kept");
  // Parked-only inbound: the buttons are honestly inert…
  assert.match(h.shell.innerHTML, /id="updates-update-all-btn" disabled/);
  assert.equal(h.getElementById("updates-sync-all-btn").disabled, true);
  assert.match(h.shell.innerHTML, /Bundled with the app — agents unlinked/);
  assert.doesNotMatch(h.shell.innerHTML, /Sync to resolve/);
  // …and the bulk loop has nothing to run (no sync calls).
  const before = h.calls.filter(([name]) => name === "syncMarketplace").length;
  await h.hooks.runUpdateAll();
  await flushAsync();
  assert.equal(h.calls.filter(([name]) => name === "syncMarketplace").length, before);
});

test("missing rows with any agent still using a skill stay actionable", async () => {
  const h = loadUpdatesViewHarness();
  const api = h.window.electronAPI;
  api.getMarketplaces = async () => ({
    success: true,
    data: {
      marketplaces: [{ id: "team-git", name: "team-git", owner: { name: "Community" } }],
      installedSkills: [
        { marketplaceId: "team-git", skillId: "accessibility-quality", pluginName: "ux-quality-beta", sourceMissing: true },
        { marketplaceId: "team-git", skillId: "content-quality", pluginName: "ux-quality-beta", sourceMissing: true },
      ],
    },
  });
  api.listAgentSkillUsage = async () => ({
    success: true,
    agents: [{ id: "a1", name: "UX Agent", leaves: ["content-quality"] }],
  });
  await h.hooks.loadUpdates(true);

  const row = h.hooks.stateForTests().inbound.gitMissing[0];
  assert.equal(row.parked, false);
  assert.equal(row.statusLabel, "No longer published");
  assert.match(h.shell.innerHTML, /Sync to resolve/);
  const before = h.calls.filter(([name]) => name === "syncMarketplace").length;
  await h.hooks.runUpdateAll();
  await flushAsync();
  assert.equal(
    h.calls.filter(([name]) => name === "syncMarketplace").length,
    before + 1,
    "still folds into the git sync leg (consent path reachable)",
  );
});

test("a failed usage probe fails OPEN: rows stay actionable, never silently parked", async () => {
  const h = loadUpdatesViewHarness();
  const api = h.window.electronAPI;
  api.getMarketplaces = async () => ({
    success: true,
    data: {
      marketplaces: [{ id: "team-git", name: "team-git", owner: { name: "Community" } }],
      installedSkills: [
        { marketplaceId: "team-git", skillId: "accessibility-quality", pluginName: "ux-quality-beta", sourceMissing: true },
      ],
    },
  });
  api.listAgentSkillUsage = async () => ({ success: false, error: "agent services unavailable" });
  await h.hooks.loadUpdates(true);
  const row = h.hooks.stateForTests().inbound.gitMissing[0];
  assert.equal(row.parked, false);
  assert.equal(row.statusLabel, "No longer published");
  assert.doesNotMatch(h.shell.innerHTML, /id="updates-update-all-btn" disabled/);
});

test("the usage probe only fires when missing rows exist, and tab re-entry within the TTL skips the reload", async () => {
  const h = loadUpdatesViewHarness({ fixtures: fullFixtures() });
  const usageCalls = [];
  h.window.electronAPI.listAgentSkillUsage = async () => {
    usageCalls.push(1);
    return { success: true, agents: [] };
  };
  await h.hooks.loadUpdates(true);
  assert.equal(usageCalls.length, 0, "no missing rows -> no probe");

  // Fresh load just happened: arriving on the tab must reuse it instead of
  // re-running the sweep (the tab-flip storm).
  const callsBefore = h.calls.length;
  h.hooks.showUpdatesView();
  await flushAsync();
  assert.equal(h.calls.length, callsBefore, "TTL reuse: no new IPC work");
  assert.doesNotMatch(
    h.shell.innerHTML,
    /Checking for updates/,
    "tables render from state, not the loading placeholder",
  );
});
