// Behavior tests for the agent reclaim flow (convert a self-authored installed
// Marketplace copy into the author-side editable copy): card/menu gating via
// the real buildAgentCardHtml renderer, the post-reclaim facet/badge/action
// shape, and performReclaimAgent's IPC contract. Harness mirrors
// agents-dependent-skill-publish.unit.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const AGENTS_PATH = path.join(__dirname, "..", "renderer", "components", "agents.js");

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

  toggle(name, force) {
    if (force === undefined) {
      if (this.classes.has(name)) this.classes.delete(name);
      else this.classes.add(name);
      return this.classes.has(name);
    }
    if (force) this.classes.add(name);
    else this.classes.delete(name);
    return Boolean(force);
  }
}

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.style = { display: "none" };
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.innerHTML = "";
    this.textContent = "";
    this.dataset = {};
    this.value = "";
    this.disabled = false;
    this.children = [];
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type).push(handler);
  }

  removeAttribute() {}

  setAttribute() {}

  dispatchEvent(type, event = {}) {
    for (const handler of this.listeners.get(type) || []) {
      handler({
        preventDefault() {},
        stopPropagation() {},
        target: this,
        currentTarget: this,
        ...event,
      });
    }
  }

  click() {
    this.dispatchEvent("click");
  }

  closest() {
    return null;
  }

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }
}

function loadAgentsModuleHarness() {
  const source = fs.readFileSync(AGENTS_PATH, "utf8");
  const componentsDir = path.join(__dirname, "..", "renderer", "components");
  const extraSources = [
    "agent-reasoning-options.js",
    "agent-model-picker.js",
    "agent-reasoning-slider.js",
  ].map((name) => ({
    path: path.join(componentsDir, name),
    source: fs.readFileSync(path.join(componentsDir, name), "utf8"),
  }));

  const elements = new Map();
  const addElement = (id, { display = "none" } = {}) => {
    const element = new FakeElement(id);
    element.style.display = display;
    elements.set(id, element);
    return element;
  };

  [
    "view-mcp-servers-btn",
    "view-agent-skills-btn",
    "view-cost-dashboard-btn",
    "view-agents-tab-btn",
    "mcp-servers-view",
    "agent-skills-view",
    "cost-dashboard-view",
    "agents-tab-view",
    "mcp-header-actions",
    "skills-header-actions",
    "cost-dashboard-header-actions",
    "agents-tab-header-actions",
    "agents-tab-list",
    "agents-tab-new-agent-btn",
    "agents-tab-settings-btn",
    "agents-tab-search-input",
    "agents-tab-mode-tabs",
    "agents-confirm-modal",
    "agents-confirm-title",
    "agents-confirm-message",
    "agents-confirm-meta",
    "agents-confirm-error",
    "agents-confirm-btn",
    "agents-confirm-cancel-btn",
    "agents-confirm-secondary-btn",
    "agents-confirm-close-btn",
  ].forEach((id) => addElement(id));

  const document = {
    readyState: "complete",
    body: new FakeElement("body"),
    createElement(tag) {
      return new FakeElement(tag);
    },
    getElementById(id) {
      return elements.get(id) || null;
    },
    querySelectorAll() {
      return [];
    },
    querySelector() {
      return null;
    },
    addEventListener() {},
    removeEventListener() {},
  };

  const windowObject = {
    appState: { controlPlaneView: "mcp-servers" },
    electronAPI: {
      invokeMcpTool: async () => ({ success: true, data: { agents: [] } }),
      getSkills: async () => ({ success: true, skills: [] }),
      loadMcpServers: async () => ({ success: true, data: [] }),
      getUsername: async () => ({ username: "dsantiago" }),
      aiMarketplace: {
        listLinks: async () => ({ success: true, links: {} }),
      },
    },
    showNotification() {},
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
  };

  const copiedValues = [];
  const context = {
    window: windowObject,
    document,
    console,
    setTimeout,
    clearTimeout,
    Math,
    Date,
    Promise,
    HTMLElement: FakeElement,
    navigator: {
      clipboard: { writeText: async (value) => copiedValues.push(value) },
    },
  };
  context.globalThis = context;

  for (const extra of extraSources) {
    vm.runInNewContext(extra.source, context, { filename: extra.path });
  }
  vm.runInNewContext(source, context, { filename: AGENTS_PATH });

  return { window: windowObject, elements, copiedValues };
}

const VIEWER = "dsantiago@example.invalid";

function installedCopy(overrides = {}) {
  return {
    id: "zzz-copy",
    name: "zzz-copy",
    description: "",
    base_model_id: "GPT-5.6 Terra",
    skill_ids: [],
    tool_server_ids: [],
    creation_source: "marketplace",
    created_by_email: "dsantiago",
    marketplace_relationship: "installed",
    marketplace_solution_id: "sol-1",
    marketplace_link: {
      solutionId: "sol-1",
      relationship: "installed",
      authorIdentity: "dsantiago",
      attributionPending: false,
    },
    is_read_only: true,
    ...overrides,
  };
}

test("the reclaim action renders only for self-authored, fully-installed copies", () => {
  const { window } = loadAgentsModuleHarness();
  const render = (agent) =>
    window.AgentCardRenderer.buildAgentCardHtml(agent, { viewerIdentity: VIEWER });

  const selfAuthored = render(installedCopy());
  assert.match(selfAuthored, /agent-reclaim-btn/);
  assert.match(selfAuthored, /Convert to editable copy/);

  const thirdParty = render(
    installedCopy({
      created_by_email: "someoneelse",
      marketplace_link: {
        solutionId: "sol-1",
        relationship: "installed",
        authorIdentity: "someoneelse",
        attributionPending: false,
      },
    }),
  );
  assert.doesNotMatch(thirdParty, /agent-reclaim-btn/);

  const pending = render(
    installedCopy({
      marketplace_link: {
        solutionId: "sol-1",
        relationship: "installed",
        authorIdentity: "dsantiago",
        attributionPending: true,
      },
    }),
  );
  assert.doesNotMatch(pending, /agent-reclaim-btn/);

  const ownedLocalPublished = render(
    installedCopy({
      creation_source: "local",
      created_by_email: VIEWER,
      marketplace_relationship: "published",
      is_read_only: false,
      marketplace_link: {
        solutionId: "sol-1",
        relationship: "published",
        authorIdentity: "dsantiago",
        attributionPending: false,
      },
    }),
  );
  assert.doesNotMatch(ownedLocalPublished, /agent-reclaim-btn/);
});

test("a reclaimed copy renders USER+PUBLISHED, editable, with Republish and no reclaim", () => {
  const { window } = loadAgentsModuleHarness();
  const reclaimed = installedCopy({
    creation_source: "local",
    created_by_email: VIEWER,
    marketplace_relationship: "published",
    is_read_only: false,
    marketplace_link: {
      solutionId: "sol-1",
      relationship: "published",
      authorIdentity: "dsantiago",
      attributionPending: false,
    },
  });
  const html = window.AgentCardRenderer.buildAgentCardHtml(reclaimed, {
    viewerIdentity: VIEWER,
  });

  assert.match(html, /badge-user/);
  assert.match(html, /badge-published/);
  assert.doesNotMatch(html, /badge-installed">Installed</);
  assert.match(html, /agent-edit-btn/);
  assert.match(html, />\s*Republish\s*</);
  assert.doesNotMatch(html, /agent-reclaim-btn/);

  const hooks = window.AgentsTabRenderHooks;
  const ids = (list) => list.map((agent) => agent.id);
  assert.deepEqual(ids(hooks.filterAgentsForMode([reclaimed], "user", VIEWER)), [
    "zzz-copy",
  ]);
  assert.deepEqual(
    ids(hooks.filterAgentsForMode([reclaimed], "published", VIEWER)),
    ["zzz-copy"],
  );
  assert.deepEqual(
    ids(hooks.filterAgentsForMode([reclaimed], "marketplace", VIEWER)),
    [],
  );
});

test("a dirty published agent card carries the unpublished-changes tint; clean cards do not", () => {
  const { window } = loadAgentsModuleHarness();
  const publishedAgent = installedCopy({
    creation_source: "local",
    created_by_email: VIEWER,
    marketplace_relationship: "published",
    is_read_only: false,
    marketplace_link: {
      solutionId: "sol-1",
      relationship: "published",
      authorIdentity: "dsantiago",
      attributionPending: false,
    },
  });

  const dirty = window.AgentCardRenderer.buildAgentCardHtml(
    { ...publishedAgent, has_unpublished_changes: true },
    { viewerIdentity: VIEWER },
  );
  assert.match(dirty, /mcp-server-card agent-card has-unpublished-changes/);
  assert.match(dirty, /badge-unpublished[^>]*>Unpublished changes</);

  const clean = window.AgentCardRenderer.buildAgentCardHtml(publishedAgent, {
    viewerIdentity: VIEWER,
  });
  assert.doesNotMatch(clean, /has-unpublished-changes/);

  // Installed copies never show the dirty tint (they are read-only mirrors).
  const installed = window.AgentCardRenderer.buildAgentCardHtml(
    installedCopy({ has_unpublished_changes: true }),
    { viewerIdentity: VIEWER },
  );
  assert.doesNotMatch(installed, /has-unpublished-changes/);
});

test("an outdated installed copy shows the update badge and tint; the menu action is always there", () => {
  const { window } = loadAgentsModuleHarness();
  // The badge rides the PERSISTED sweep verdict on the link (hasRemoteUpdate,
  // written by the update sweep) — a real production signal, not a test-only
  // field.
  const outdated = window.AgentCardRenderer.buildAgentCardHtml(
    installedCopy({
      marketplace_link: {
        solutionId: "sol-1",
        relationship: "installed",
        authorIdentity: "dsantiago",
        attributionPending: false,
        hasRemoteUpdate: true,
      },
    }),
    { viewerIdentity: VIEWER },
  );
  assert.match(outdated, /badge-has-updates[^>]*>Update available</);
  assert.match(outdated, /mcp-server-card agent-card update-available/);
  assert.match(outdated, /agent-update-btn/);
  assert.match(outdated, /Update from marketplace/);

  // A current installed copy has no badge/tint, but the manual update action
  // is ALWAYS available — detection staleness must never strand users with
  // no way to update (2026-08-04 incident).
  const current = window.AgentCardRenderer.buildAgentCardHtml(installedCopy(), {
    viewerIdentity: VIEWER,
  });
  assert.doesNotMatch(current, /badge-has-updates/);
  assert.doesNotMatch(current, /update-available/);
  assert.match(current, /agent-update-btn/);
  assert.match(current, /Update from marketplace/);

  // Only installed copies can be outdated relative to a listing — published
  // agents get neither the badge nor the update action.
  const localWithFlag = window.AgentCardRenderer.buildAgentCardHtml(
    installedCopy({
      creation_source: "local",
      created_by_email: VIEWER,
      marketplace_relationship: "published",
      is_read_only: false,
      update_available: true,
      marketplace_link: {
        solutionId: "sol-1",
        relationship: "published",
        authorIdentity: "dsantiago",
        attributionPending: false,
        hasRemoteUpdate: true,
      },
    }),
    { viewerIdentity: VIEWER },
  );
  assert.doesNotMatch(localWithFlag, /badge-has-updates/);
  assert.doesNotMatch(localWithFlag, /agent-update-btn/);
});

// ---- installed-agent update DETECTION (2026-08-04: the sweep read the wrong
// field names — updated_at/created_at — while the live marketplace emits
// updated_timestamp/created_timestamp, so detection failed closed for
// everyone and had zero coverage). ----------------------------------------

test("the freshness sweep flags installed copies when the listing's updated_timestamp moves past the baseline", async () => {
  const { window } = loadAgentsModuleHarness();
  const hooks = window.AgentsTabRenderHooks;
  const links = {
    "zzz-copy": {
      relationship: "installed",
      solutionId: "sol-1",
      remoteUpdatedAt: "2026-08-01T00:00:00Z",
    },
  };
  hooks.setMarketplaceLinksForTests(links);
  window.electronAPI.aiMarketplace.listLinks = async () => ({
    success: true,
    links,
  });
  let searchCalls = 0;
  window.electronAPI.aiMarketplace.search = async () => {
    searchCalls += 1;
    return {
      success: true,
      data: {
        results: [{ id: "sol-1", updated_timestamp: "2026-08-04T12:00:00Z" }],
      },
    };
  };

  await hooks.maybeCheckInstalledAgentFreshness();
  assert.equal(searchCalls, 1);
  assert.equal(hooks.solutionFreshnessForTests().has("zzz-copy"), true);
  assert.equal(hooks.agentUpdateAvailable(installedCopy()), true);
  const card = window.AgentCardRenderer.buildAgentCardHtml(installedCopy(), {
    viewerIdentity: VIEWER,
  });
  assert.match(card, /badge-has-updates[^>]*>Update available</);

  // One bounded check per session: a second call never re-hits the network.
  await hooks.maybeCheckInstalledAgentFreshness();
  assert.equal(searchCalls, 1);
});

test("legacy updated_at listings still flag through the fallback chain", async () => {
  const { window } = loadAgentsModuleHarness();
  const hooks = window.AgentsTabRenderHooks;
  const links = {
    "zzz-copy": {
      relationship: "installed",
      solutionId: "sol-1",
      remoteUpdatedAt: "2026-08-01T00:00:00Z",
    },
  };
  hooks.setMarketplaceLinksForTests(links);
  window.electronAPI.aiMarketplace.listLinks = async () => ({ success: true, links });
  window.electronAPI.aiMarketplace.search = async () => ({
    success: true,
    data: { results: [{ id: "sol-1", updated_at: "2026-08-03T00:00:00Z" }] },
  });

  await hooks.maybeCheckInstalledAgentFreshness();
  assert.equal(hooks.solutionFreshnessForTests().has("zzz-copy"), true);
});

test("a legacy link without a baseline backfills silently instead of flagging", async () => {
  const { window } = loadAgentsModuleHarness();
  const hooks = window.AgentsTabRenderHooks;
  hooks.setMarketplaceLinksForTests({
    "zzz-copy": { relationship: "installed", solutionId: "sol-1" },
  });
  const backfills = [];
  window.electronAPI.aiMarketplace.setLinkRemoteUpdatedAt = async (agentId, stamp) => {
    backfills.push([agentId, stamp]);
    return { success: true };
  };
  window.electronAPI.aiMarketplace.search = async () => ({
    success: true,
    data: {
      results: [{ id: "sol-1", updated_timestamp: "2026-08-04T12:00:00Z" }],
    },
  });

  await hooks.maybeCheckInstalledAgentFreshness();
  assert.deepEqual(
    JSON.parse(JSON.stringify(backfills)),
    [["zzz-copy", "2026-08-04T12:00:00Z"]],
    "the baseline is stamped from the marketplace's own clock",
  );
  assert.equal(hooks.solutionFreshnessForTests().size, 0, "backfill never flags");
});

test("listings with no timestamp fields at all are skipped without flagging", async () => {
  const { window } = loadAgentsModuleHarness();
  const hooks = window.AgentsTabRenderHooks;
  hooks.setMarketplaceLinksForTests({
    "zzz-copy": {
      relationship: "installed",
      solutionId: "sol-1",
      remoteUpdatedAt: "2026-08-01T00:00:00Z",
    },
  });
  const backfills = [];
  window.electronAPI.aiMarketplace.setLinkRemoteUpdatedAt = async (...args) => {
    backfills.push(args);
    return { success: true };
  };
  window.electronAPI.aiMarketplace.search = async () => ({
    success: true,
    data: { results: [{ id: "sol-1" }] },
  });

  await hooks.maybeCheckInstalledAgentFreshness();
  assert.equal(hooks.solutionFreshnessForTests().size, 0);
  assert.equal(backfills.length, 0);
});

test("agentUpdateAvailable honors the persisted hasRemoteUpdate verdict on the link", () => {
  const { window } = loadAgentsModuleHarness();
  const hooks = window.AgentsTabRenderHooks;
  hooks.setMarketplaceLinksForTests({
    "zzz-copy": {
      relationship: "installed",
      solutionId: "sol-1",
      hasRemoteUpdate: true,
    },
  });
  assert.equal(hooks.agentUpdateAvailable(installedCopy()), true);
  // The record-borne link works too (list payload shape).
  hooks.setMarketplaceLinksForTests({});
  assert.equal(
    hooks.agentUpdateAvailable(
      installedCopy({
        marketplace_link: {
          solutionId: "sol-1",
          relationship: "installed",
          authorIdentity: "dsantiago",
          attributionPending: false,
          hasRemoteUpdate: true,
        },
      }),
    ),
    true,
  );
  // Never for published relationships.
  assert.equal(
    hooks.agentUpdateAvailable(
      installedCopy({
        marketplace_relationship: "published",
        marketplace_link: {
          solutionId: "sol-1",
          relationship: "published",
          hasRemoteUpdate: true,
        },
      }),
    ),
    false,
  );
});

// ---- session-map staleness (2026-08-05: an Updates-tab Sync All advanced the
// persisted baseline but the once-per-session map kept flagging the card until
// an app restart). --------------------------------------------------------

test("an update applied elsewhere prunes the stale session flag on the next read", async () => {
  const { window } = loadAgentsModuleHarness();
  const hooks = window.AgentsTabRenderHooks;
  const links = {
    "zzz-copy": {
      relationship: "installed",
      solutionId: "sol-1",
      remoteUpdatedAt: "2026-08-01T00:00:00Z",
    },
  };
  hooks.setMarketplaceLinksForTests(links);
  window.electronAPI.aiMarketplace.listLinks = async () => ({ success: true, links });
  window.electronAPI.aiMarketplace.search = async () => ({
    success: true,
    data: { results: [{ id: "sol-1", updated_timestamp: "2026-08-05T20:12:28Z" }] },
  });

  await hooks.maybeCheckInstalledAgentFreshness();
  assert.equal(hooks.agentUpdateAvailable(installedCopy()), true);

  // The Updates tab applies the update: the persisted baseline catches up to
  // the flagged stamp while this tab's session map is never touched.
  hooks.setMarketplaceLinksForTests({
    "zzz-copy": {
      relationship: "installed",
      solutionId: "sol-1",
      remoteUpdatedAt: "2026-08-05T20:12:28Z",
    },
  });
  assert.equal(hooks.agentUpdateAvailable(installedCopy()), false);
  assert.equal(
    hooks.solutionFreshnessForTests().has("zzz-copy"),
    false,
    "the stale entry is pruned, not just masked",
  );
});

test("unparseable stamps keep the flag conservatively", () => {
  const { window } = loadAgentsModuleHarness();
  const hooks = window.AgentsTabRenderHooks;
  hooks.setMarketplaceLinksForTests({
    "zzz-copy": {
      relationship: "installed",
      solutionId: "sol-1",
      remoteUpdatedAt: "2026-08-05T20:12:28Z",
    },
  });
  hooks.solutionFreshnessForTests().set("zzz-copy", "not-a-timestamp");
  assert.equal(hooks.agentUpdateAvailable(installedCopy()), true);
  assert.equal(hooks.solutionFreshnessForTests().has("zzz-copy"), true);
});

test("invalidateInstalledAgentFreshness lets the bounded sweep run again", async () => {
  const { window } = loadAgentsModuleHarness();
  const hooks = window.AgentsTabRenderHooks;
  const links = {
    "zzz-copy": {
      relationship: "installed",
      solutionId: "sol-1",
      remoteUpdatedAt: "2026-08-01T00:00:00Z",
    },
  };
  hooks.setMarketplaceLinksForTests(links);
  window.electronAPI.aiMarketplace.listLinks = async () => ({ success: true, links });
  let searchCalls = 0;
  window.electronAPI.aiMarketplace.search = async () => {
    searchCalls += 1;
    return {
      success: true,
      data: { results: [{ id: "sol-1", updated_timestamp: "2026-08-04T12:00:00Z" }] },
    };
  };

  await hooks.maybeCheckInstalledAgentFreshness();
  await hooks.maybeCheckInstalledAgentFreshness();
  assert.equal(searchCalls, 1, "the per-session guard holds");

  window.AgentsPublishHooks.invalidateInstalledAgentFreshness();
  assert.equal(hooks.solutionFreshnessForTests().size, 0);
  await hooks.maybeCheckInstalledAgentFreshness();
  assert.equal(searchCalls, 2, "bulk updates elsewhere re-open the sweep");
});

test("reclaimAgent's confirm modal renders the solution id as a copyable meta chip", async () => {
  const { window, elements, copiedValues } = loadAgentsModuleHarness();
  window.electronAPI.aiMarketplace.listLinks = async () => ({
    success: true,
    links: { "zzz-copy": { relationship: "installed", solutionId: "sol-1" } },
  });

  await window.AgentsPublishHooks.reclaimAgent("zzz-copy");

  const modal = elements.get("agents-confirm-modal");
  assert.ok(modal.classList.contains("visible"), "the confirm modal opens");
  assert.equal(
    elements.get("agents-confirm-title").textContent,
    "Convert to editable copy?",
  );
  const message = elements.get("agents-confirm-message").textContent;
  assert.match(message, /zzz-copy/);
  assert.doesNotMatch(
    message,
    /sol-1/,
    "the solution id lives in the meta chip, not the sentence",
  );

  const metaEl = elements.get("agents-confirm-meta");
  assert.equal(metaEl.hidden, false, "the meta chip row is shown");
  assert.equal(metaEl.children.length, 2, "badge chip + copy button");
  const [chip, copyBtn] = metaEl.children;
  assert.equal(chip.className, "agents-confirm-meta-badge");
  assert.equal(chip.textContent, "sol-1");
  assert.equal(copyBtn.className, "agents-confirm-meta-copy");

  copyBtn.click();
  await Promise.resolve();
  assert.deepEqual(copiedValues, ["sol-1"], "the copy button copies the id");
});

test("performReclaimAgent invokes the reclaim IPC and surfaces failures", async () => {
  const { window } = loadAgentsModuleHarness();
  const reclaimCalls = [];
  window.electronAPI.aiMarketplace.reclaimAgent = async (agentId) => {
    reclaimCalls.push(agentId);
    return { success: true, data: { local_agent_id: agentId, solution_id: "sol-1" } };
  };
  window.electronAPI.aiMarketplace.repairLinkedAgentAccess = async () => ({
    success: true,
  });
  window.electronAPI.currentUser = {
    get: async () => ({
      authenticated: true,
      sessionSummary: { user: { email: VIEWER } },
    }),
  };

  await window.AgentsPublishHooks.performReclaimAgent("zzz-copy");
  assert.deepEqual(reclaimCalls, ["zzz-copy"]);

  window.electronAPI.aiMarketplace.reclaimAgent = async () => ({
    success: false,
    error: "The current viewer does not own this AI Marketplace solution.",
    code: "not_owner",
  });
  await assert.rejects(
    window.AgentsPublishHooks.performReclaimAgent("zzz-copy"),
    /does not own this AI Marketplace solution/,
  );
});
