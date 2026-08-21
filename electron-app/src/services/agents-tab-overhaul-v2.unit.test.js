// Round-5 Agents-tab overhaul, behavioral edition: the User/Published/
// Installed classification spec (full facet matrix on the real
// filterAgentsForMode), mode-tab wiring, the restyled publish modal (summary
// contract + Escape lifecycle), the chained delete confirms, Discover-card
// parity (solution ellipsis menu, bundle-derived card facts, author
// normalization), and the read-only installed-agent pane.
//
// Deliberately NOT pinned here (visual layer, live visual QA): the card type
// scale / badge geometry CSS, the agents-modal blur/border/keyframes CSS, the
// index.html mode-tab markup, the marketplace-readonly-pane CSS, and the
// agent-skills.js skill-side read-only pane (covered by its own suite).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const AGENTS_PATH = path.join(__dirname, "..", "renderer", "components", "agents.js");

// ---------------------------------------------------------------------------
// vm harness (extends the shared FakeElement pattern used by the other
// agents-tab suites with document listener capture, staged mode tabs, and the
// confirm-modal elements)
// ---------------------------------------------------------------------------

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
    const shouldAdd = force === undefined ? !this.classes.has(name) : Boolean(force);
    if (shouldAdd) this.classes.add(name);
    else this.classes.delete(name);
    return shouldAdd;
  }
}

let currentDocument = null;

class FakeElement {
  constructor(id = "", { autoVivify = false } = {}) {
    this.id = id;
    this.className = "";
    this.style = { display: "" };
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.innerHTML = "";
    this.textContent = "";
    this.dataset = {};
    this.attributes = {};
    this.value = "";
    this.hidden = false;
    this.disabled = false;
    this.isConnected = true;
    this.children = [];
    this.parentElement = null;
    this.offsetWidth = 120;
    this.offsetHeight = 40;
    this.rect = { left: 20, right: 60, top: 20, bottom: 40, width: 40, height: 20 };
    this.selectorMap = new Map();
    this.autoVivify = autoVivify;
    this.autoChildren = new Map();
  }

  get ownerDocument() {
    return currentDocument;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const handlers = this.listeners.get(type);
    if (!handlers) return;
    const index = handlers.indexOf(handler);
    if (index >= 0) handlers.splice(index, 1);
  }

  dispatchEvent(typeOrEvent, event = {}) {
    const type = typeof typeOrEvent === "string" ? typeOrEvent : typeOrEvent?.type;
    const props = typeof typeOrEvent === "string" ? event : typeOrEvent;
    for (const handler of [...(this.listeners.get(type) || [])]) {
      handler({
        preventDefault() {},
        stopPropagation() {},
        target: this,
        currentTarget: this,
        ...props,
      });
    }
    return true;
  }

  click() {
    this.dispatchEvent("click");
  }

  focus() {}

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name)
      ? this.attributes[name]
      : null;
  }

  removeAttribute(name) {
    delete this.attributes[name];
  }

  setCustomValidity() {}

  insertAdjacentHTML() {}

  getBoundingClientRect() {
    return { ...this.rect };
  }

  contains(other) {
    return other === this || this.children.includes(other);
  }

  closest() {
    return null;
  }

  autoChild(selector) {
    if (!this.autoChildren.has(selector)) {
      const child = new FakeElement("", { autoVivify: true });
      child.parentElement = this;
      this.autoChildren.set(selector, child);
    }
    return this.autoChildren.get(selector);
  }

  querySelector(selector) {
    if (this.selectorMap.has(selector)) return this.selectorMap.get(selector);
    if (this.autoVivify) return this.autoChild(selector);
    return null;
  }

  querySelectorAll(selector) {
    const staged = this.selectorMap.get(`all:${selector}`);
    if (Array.isArray(staged)) return staged;
    return [];
  }

  appendChild(child) {
    if (child && typeof child === "object") {
      child.parentElement = this;
      this.children.push(child);
    }
    return child;
  }

  remove() {
    if (this.parentElement) {
      const index = this.parentElement.children.indexOf(this);
      if (index >= 0) this.parentElement.children.splice(index, 1);
      this.parentElement = null;
    }
  }
}

function loadAgentsModuleHarness({
  agents = [],
  skills = [],
  marketplaceLinks = {},
  searchResults = [],
  bundlesBySolutionId = {},
  solutionsById = {},
  deleteSolutionImpl = null,
  installImpl = null,
  hasKey = true,
} = {}) {
  const componentsDir = path.join(__dirname, "..", "renderer", "components");
  const source = fs.readFileSync(AGENTS_PATH, "utf8");
  const extraSources = [
    "agent-reasoning-options.js",
    "agent-model-picker.js",
    "agent-reasoning-slider.js",
  ].map((name) => ({
    path: path.join(componentsDir, name),
    source: fs.readFileSync(path.join(componentsDir, name), "utf8"),
  }));

  const elements = new Map();
  const addElement = (id) => {
    const element = new FakeElement(id);
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
    "agents-tab-browser",
    "agents-confirm-modal",
    "agents-confirm-title",
    "agents-confirm-message",
    "agents-confirm-meta",
    "agents-confirm-error",
    "agents-confirm-btn",
    "agents-confirm-cancel-btn",
    "agents-confirm-secondary-btn",
    "agents-confirm-close-btn",
  ].forEach(addElement);
  const editorHost = new FakeElement("agents-tab-editor", { autoVivify: true });
  elements.set("agents-tab-editor", editorHost);

  // The five mode tabs exactly as index.html declares them (markup itself is
  // exercised live; this stages the same contract for setMode's wiring).
  const modeTabs = ["user", "published", "marketplace", "all", "discover"].map((mode) => {
    const tab = new FakeElement(`tab-${mode}`);
    tab.dataset.agentsMode = mode;
    if (mode === "user") tab.classList.add("active");
    tab.classList.add("mcp-filter-tab");
    return tab;
  });

  const body = new FakeElement("body");
  const documentListeners = new Map();
  const documentObject = {
    readyState: "complete",
    body,
    defaultView: null,
    createElement(tag) {
      const element = new FakeElement("", { autoVivify: true });
      element.tagName = String(tag || "").toUpperCase();
      return element;
    },
    getElementById(id) {
      if (elements.has(id)) return elements.get(id);
      return body.children.find((child) => child.id === id) || null;
    },
    querySelectorAll(selector) {
      if (selector === "#agents-tab-mode-tabs .mcp-filter-tab") return modeTabs;
      return [];
    },
    querySelector() {
      return null;
    },
    addEventListener(type, handler) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const handlers = documentListeners.get(type);
      if (!handlers) return;
      const index = handlers.indexOf(handler);
      if (index >= 0) handlers.splice(index, 1);
    },
  };
  currentDocument = documentObject;

  const calls = [];
  const notifications = [];
  const externalOpens = [];
  const linksState = { links: marketplaceLinks };
  const windowObject = {
    appState: { controlPlaneView: "mcp-servers" },
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener() {},
    removeEventListener() {},
    confirm() {
      throw new Error("window.confirm must never be used by the agents tab");
    },
    open() {},
    electronAPI: {
      openExternal(url) {
        externalOpens.push(url);
      },
      invokeMcpTool: async (_serverId, toolName, input = {}) => {
        calls.push([toolName, input]);
        if (toolName === "subagents_list_agents") {
          if (input.filter_type === "base") {
            return { success: true, data: { agents: [] } };
          }
          return { success: true, data: { agents } };
        }
        if (toolName === "subagents_get_agent") {
          const agent = agents.find((item) => item.id === input.model_id);
          return agent
            ? { success: true, data: agent }
            : { success: false, error: "not found" };
        }
        if (toolName === "subagents_get_agent_system_prompt") {
          return { success: true, data: { system_prompt: "Prompt fixture body." } };
        }
        if (toolName === "subagents_delete_agent") {
          return { success: true, data: { success: true } };
        }
        return { success: true, data: {} };
      },
      getSkills: async () => ({ success: true, skills }),
      loadMcpServers: async () => ({ success: true, data: [] }),
      getUsername: async () => ({ username: "dsantiago" }),
      currentUser: {
        get: async () => ({
          authenticated: true,
          sessionSummary: { user: { email: "dsantiago@example.invalid" } },
        }),
      },
      aiMarketplace: {
        listLinks: async () => ({ success: true, links: linksState.links }),
        hasApiKey: async () => {
          calls.push(["hasApiKey"]);
          return { hasKey };
        },
        search: async (params) => {
          calls.push(["search", params]);
          return { success: true, data: { results: searchResults } };
        },
        getBundle: async (solutionId) => {
          calls.push(["getBundle", solutionId]);
          return (
            bundlesBySolutionId[solutionId] || { success: false, error: "no bundle" }
          );
        },
        getSolution: async (solutionId) => {
          calls.push(["getSolution", solutionId]);
          const solution = solutionsById[solutionId];
          return solution
            ? { success: true, data: solution }
            : { success: false, error: "not found" };
        },
        delete: async (solutionId) => {
          calls.push(["deleteSolution", solutionId]);
          if (deleteSolutionImpl) return deleteSolutionImpl(solutionId);
          return { success: true };
        },
        install: async (solutionId, options) => {
          calls.push(["install", solutionId, options]);
          if (installImpl) return installImpl(solutionId, options);
          return { success: false, error: "no installImpl in fixture" };
        },
        clearLink: async (agentId) => {
          calls.push(["clearLink", agentId]);
          delete linksState.links[agentId];
          return { success: true };
        },
        // Soft-miss prune seam: the fixture emulates the store's CONFIRMED
        // verdict (absent -> deleted immediately) so single-pass tests can
        // observe the cleanup contract; the real flag/confirm/heal timing is
        // covered by ai-marketplace-agent-links.unit.test.js and
        // agents-link-prune.unit.test.js.
        reportLinkSightings: async (sightings) => {
          const absent = Array.isArray(sightings?.absentIds)
            ? [...sightings.absentIds]
            : [];
          calls.push(["reportLinkSightings", absent]);
          for (const agentId of absent) delete linksState.links[agentId];
          return { success: true, healed: [], flagged: [], deleted: absent };
        },
      },
    },
    showNotification(message, kind) {
      notifications.push([kind, message]);
    },
  };
  documentObject.defaultView = windowObject;

  const context = {
    window: windowObject,
    document: documentObject,
    console,
    setTimeout,
    clearTimeout,
    Math,
    Date,
    Promise,
    JSON,
    HTMLElement: FakeElement,
    MutationObserver: class MutationObserver {
      observe() {}
      disconnect() {}
    },
    CustomEvent: class CustomEvent {
      constructor(type, options = {}) {
        this.type = type;
        this.detail = options.detail;
      }
    },
    FormData: class FormData {
      constructor(form) {
        this.fields = Array.isArray(form?.formEntries) ? form.formEntries : [];
      }

      entries() {
        return this.fields[Symbol.iterator]();
      }

      get(name) {
        const hit = this.fields.find(([key]) => key === name);
        return hit ? hit[1] : null;
      }
    },
  };
  context.globalThis = context;

  for (const extra of extraSources) {
    vm.runInNewContext(extra.source, context, { filename: extra.path });
  }
  vm.runInNewContext(source, context, { filename: AGENTS_PATH });

  return {
    window: windowObject,
    elements,
    body,
    calls,
    notifications,
    externalOpens,
    documentListeners,
    modeTabs,
    editorHost,
    linksState,
  };
}

const settle = async (rounds = 10) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

function listClickEvent(btn) {
  return { target: { closest: (selector) => (selector === "button" ? btn : null) } };
}

function actionButton({ classes = [], agentId = "", solutionId = "" } = {}) {
  const btn = new FakeElement("");
  classes.forEach((name) => btn.classList.add(name));
  if (agentId) btn.attributes["data-agent-id"] = agentId;
  if (solutionId) btn.attributes["data-solution-id"] = solutionId;
  return btn;
}

function dispatchDocumentKeydown(documentListeners, event) {
  for (const handler of [...(documentListeners.get("keydown") || [])]) {
    handler({ preventDefault() {}, stopPropagation() {}, ...event });
  }
}

// ---------------------------------------------------------------------------
// Item 4 — ownership classification (THE User/Published/Installed spec).
// The facet matrix below is the pinned contract: creation source
// (local/marketplace) × ownership (viewer/foreign) × marketplace relationship
// (published/installed/none/unknown) × read-only, with the expected membership
// of every mode. Any change to filterAgentsForMode semantics must show up as
// an explicit edit to this table.
// ---------------------------------------------------------------------------

const VIEWER = "dsantiago";
const VIEWER_EMAIL = "dsantiago@example.invalid";
const FOREIGN_EMAIL = "someoneelse@example.invalid";

function matrixAgent({
  id,
  source, // 'local' | 'marketplace'
  owned, // creator email belongs to the viewer
  relationship, // 'published' | 'installed' | 'none' | 'unknown'
  linkAuthor = "creator", // 'creator' | 'viewer' | 'foreign' | null
  readOnly = false,
}) {
  const creator = owned ? VIEWER_EMAIL : FOREIGN_EMAIL;
  const hasLink = relationship !== "none";
  const authorIdentity =
    linkAuthor === null
      ? null
      : linkAuthor === "viewer"
        ? VIEWER_EMAIL
        : linkAuthor === "foreign"
          ? FOREIGN_EMAIL
          : creator;
  return {
    id,
    name: id,
    description: "matrix fixture",
    base_model_id: "gpt-5",
    skill_ids: [],
    tool_server_ids: [],
    created_by_email: creator,
    creation_source: source,
    marketplace_relationship: hasLink ? relationship : null,
    marketplace_solution_id: hasLink ? `sol-${id}` : null,
    marketplace_link: hasLink ? { authorIdentity } : null,
    is_read_only: readOnly,
  };
}

test("filterAgentsForMode implements the User/Published/Installed facet matrix", () => {
  const { window } = loadAgentsModuleHarness();
  const hooks = window.AgentsTabRenderHooks;
  assert.ok(hooks, "window.AgentsTabRenderHooks is exposed");

  // [fixture, expected modes (of user/published/marketplace; 'all' always)]
  const matrix = [
    // Local creations owned by the viewer.
    [matrixAgent({ id: "l-own-none", source: "local", owned: true, relationship: "none" }), ["user"]],
    [matrixAgent({ id: "l-own-pub", source: "local", owned: true, relationship: "published" }), ["user", "published"]],
    [matrixAgent({ id: "l-own-inst", source: "local", owned: true, relationship: "installed" }), ["published", "marketplace"]],
    // An unknown-provenance link fails closed everywhere (read-only limbo).
    [matrixAgent({ id: "l-own-unknown", source: "local", owned: true, relationship: "unknown" }), []],
    // Read-only strips the User facet even from an owned local agent.
    [matrixAgent({ id: "l-own-ro", source: "local", owned: true, relationship: "none", readOnly: true }), []],
    // Local records created by someone else.
    [matrixAgent({ id: "l-for-none", source: "local", owned: false, relationship: "none" }), []],
    [matrixAgent({ id: "l-for-pub", source: "local", owned: false, relationship: "published" }), []],
    // A foreign-authored local copy whose LINK belongs to the viewer counts as
    // the viewer's published listing (the link is the provenance authority).
    [matrixAgent({ id: "l-for-pub-viewerlink", source: "local", owned: false, relationship: "published", linkAuthor: "viewer" }), ["published"]],
    // Marketplace-sourced copies (installed from a listing).
    [matrixAgent({ id: "m-own-inst", source: "marketplace", owned: true, relationship: "installed" }), ["published", "marketplace"]],
    [matrixAgent({ id: "m-for-inst", source: "marketplace", owned: false, relationship: "installed" }), ["marketplace"]],
    [matrixAgent({ id: "m-own-none", source: "marketplace", owned: true, relationship: "none" }), []],
    [matrixAgent({ id: "m-for-pub", source: "marketplace", owned: false, relationship: "published" }), []],
    // Published relationship without any link identity: ownership falls back
    // to the creator email.
    [matrixAgent({ id: "m-own-pub-nolinkid", source: "marketplace", owned: true, relationship: "published", linkAuthor: null }), ["published"]],
    [matrixAgent({ id: "m-for-pub-nolinkid", source: "marketplace", owned: false, relationship: "published", linkAuthor: null }), []],
  ];

  const list = matrix.map(([agent]) => agent);
  const expectFor = (mode) =>
    matrix.filter(([, modes]) => modes.includes(mode)).map(([agent]) => agent.id);
  const ids = (result) => result.map((agent) => agent.id);

  assert.deepEqual(ids(hooks.filterAgentsForMode(list, "user", VIEWER)), expectFor("user"));
  assert.deepEqual(
    ids(hooks.filterAgentsForMode(list, "published", VIEWER)),
    expectFor("published"),
  );
  assert.deepEqual(
    ids(hooks.filterAgentsForMode(list, "marketplace", VIEWER)),
    expectFor("marketplace"),
  );
  assert.deepEqual(
    ids(hooks.filterAgentsForMode(list, "all", VIEWER)),
    list.map((agent) => agent.id),
    "all mode never filters",
  );
  // Unknown modes fall back to the full list.
  assert.deepEqual(
    ids(hooks.filterAgentsForMode(list, "discover", VIEWER)),
    list.map((agent) => agent.id),
  );

  // Ownership-sensitive facets fail closed without a viewer identity; the
  // Installed facet is relationship-only and survives.
  assert.deepEqual(ids(hooks.filterAgentsForMode(list, "user", "")), []);
  assert.deepEqual(ids(hooks.filterAgentsForMode(list, "published", "")), []);
  assert.deepEqual(
    ids(hooks.filterAgentsForMode(list, "marketplace", "")),
    expectFor("marketplace"),
  );

  // Identity normalization: full email, bare handle, and case variants all
  // resolve to the same owner.
  const owned = matrixAgent({ id: "norm", source: "local", owned: true, relationship: "none" });
  assert.equal(hooks.agentOwnedByViewer(owned, "dsantiago"), true);
  assert.equal(hooks.agentOwnedByViewer(owned, "DSANTIAGO@example.invalid"), true);
  assert.equal(hooks.agentOwnedByViewer({ ...owned, created_by_email: "DSANTIAGO" }, "dsantiago@x.y"), true);
  assert.equal(hooks.agentOwnedByViewer(owned, "someoneelse"), false);
  assert.equal(hooks.agentOwnedByViewer({ ...owned, created_by_email: "" }, "dsantiago"), false);
});

test("agent cards keep User, Installed, and Published independent and gate lifecycle actions", () => {
  const { window } = loadAgentsModuleHarness();
  const render = window.AgentCardRenderer.buildAgentCardHtml;
  const viewerIdentity = "dsantiago@example.invalid";
  const base = {
    name: "Lifecycle agent",
    description: "Classification fixture",
    base_model_id: "gpt-5.6-terra",
    skill_ids: [],
    tool_server_ids: [],
    created_by_email: viewerIdentity,
    creation_source: "local",
    marketplace_relationship: null,
    marketplace_solution_id: null,
  };

  const user = render(
    { ...base, id: "user-agent" },
    { viewerIdentity },
  );
  assert.match(user, /badge-user">User</);
  assert.match(user, /agent-edit-btn/);
  assert.match(user, /agent-publish-btn/);
  assert.doesNotMatch(user, /badge-installed">Installed</);
  assert.doesNotMatch(user, /badge-published/);
  assert.doesNotMatch(user, /agent-unpublish-btn/);

  const published = render(
    {
      ...base,
      id: "published-agent",
      marketplace_relationship: "published",
      marketplace_solution_id: "owned-solution",
      marketplace_link: { authorIdentity: viewerIdentity },
    },
    { viewerIdentity },
  );
  assert.match(published, /badge-user">User</);
  assert.match(published, /badge-published[^>]*>Published</);
  assert.match(published, /agent-edit-btn/);
  assert.match(published, /Republish/);
  assert.match(published, /agent-unpublish-btn/);
  // Unpublish's arrow points DOWN (the reverse of Publish), not left/back.
  assert.match(published, /agent-unpublish-btn[\s\S]*?M12 5v14/);
  assert.doesNotMatch(published, /agent-unpublish-btn[\s\S]*?M19 12H5/);
  assert.doesNotMatch(published, /badge-installed">Installed</);

  const foreignInstalled = render(
    {
      ...base,
      id: "foreign-installed",
      created_by_email: "other@example.invalid",
      creation_source: "marketplace",
      marketplace_relationship: "installed",
      marketplace_solution_id: "foreign-solution",
      marketplace_link: { authorIdentity: "other@example.invalid" },
      is_read_only: true,
    },
    { viewerIdentity },
  );
  assert.match(foreignInstalled, /badge-installed">Installed</);
  assert.match(foreignInstalled, /agent-details-btn/);
  assert.match(foreignInstalled, /<path d="M1 12s4-8 11-8/);
  assert.doesNotMatch(foreignInstalled, /badge-user">User</);
  assert.doesNotMatch(foreignInstalled, /badge-published/);
  assert.doesNotMatch(foreignInstalled, /agent-edit-btn/);
  assert.doesNotMatch(foreignInstalled, /agent-publish-btn/);
  assert.doesNotMatch(foreignInstalled, /agent-unpublish-btn/);

  const ownedInstalled = render(
    {
      ...base,
      id: "owned-installed",
      creation_source: "marketplace",
      marketplace_relationship: "installed",
      marketplace_solution_id: "owned-installed-solution",
      marketplace_link: { authorIdentity: viewerIdentity },
      is_read_only: true,
    },
    { viewerIdentity },
  );
  assert.match(ownedInstalled, /badge-installed">Installed</);
  assert.match(ownedInstalled, /badge-published[^>]*>Published</);
  assert.match(ownedInstalled, /agent-details-btn/);
  assert.match(ownedInstalled, /agent-unpublish-btn/);
  assert.doesNotMatch(ownedInstalled, /agent-publish-btn/);
  assert.doesNotMatch(ownedInstalled, /agent-edit-btn/);

  const unknown = render(
    {
      ...base,
      id: "unknown-provenance",
      marketplace_relationship: "unknown",
      marketplace_solution_id: "ambiguous-solution",
      marketplace_link: { authorIdentity: viewerIdentity },
      is_read_only: true,
    },
    { viewerIdentity },
  );
  assert.match(unknown, /agent-details-btn/);
  assert.doesNotMatch(unknown, /badge-published/);
  assert.doesNotMatch(unknown, /agent-publish-btn/);
  assert.doesNotMatch(unknown, /agent-unpublish-btn/);
});

// ---------------------------------------------------------------------------
// Link-prune fail-safe (2026-08-04 incident: a transient empty agents list
// mass-cleared the whole link registry and every Published badge vanished)
// ---------------------------------------------------------------------------

test("an empty agents list never wipes the marketplace-link registry", async () => {
  const { window, calls } = loadAgentsModuleHarness({
    agents: [],
    marketplaceLinks: {
      "agent-pub": {
        relationship: "published",
        solutionId: "sol-1",
        authorIdentity: "dsantiago",
      },
      "agent-inst": { relationship: "installed", solutionId: "sol-2" },
    },
  });
  await window.AgentsTabModule.loadMyAgents();
  await settle();
  assert.ok(
    !calls.some(([name]) => name === "clearLink"),
    "a transient empty list must not clear links",
  );
  assert.ok(
    !calls.some(([name]) => name === "reportLinkSightings"),
    "a transient empty list must not even report sightings",
  );
});

test("a non-empty agents list still prunes genuinely stale links only", async () => {
  const agent = matrixAgent({
    id: "agent-pub",
    source: "local",
    owned: true,
    relationship: "none",
  });
  const { window, calls } = loadAgentsModuleHarness({
    agents: [agent],
    marketplaceLinks: {
      "agent-pub": {
        relationship: "published",
        solutionId: "sol-1",
        authorIdentity: "dsantiago",
      },
      "agent-gone": {
        relationship: "published",
        solutionId: "sol-9",
        authorIdentity: "dsantiago",
      },
    },
  });
  await window.AgentsTabModule.loadMyAgents();
  await settle();
  // Soft-miss contract: the renderer never hard-deletes; it reports the miss
  // and removes only what the store confirms (the fixture confirms in one
  // pass; the real store requires spaced repeat misses).
  assert.ok(
    !calls.some(([name]) => name === "clearLink"),
    "the prune must not hard-delete links directly",
  );
  const reported = calls
    .filter(([name]) => name === "reportLinkSightings")
    .map(([, absent]) => absent);
  assert.deepEqual(JSON.parse(JSON.stringify(reported)), [["agent-gone"]]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(Object.keys(window.AgentsTabRenderHooks.marketplaceLinksForTests()))),
    ["agent-pub"],
  );
});

// ---------------------------------------------------------------------------
// Item 4 — five-mode filter row wiring
// ---------------------------------------------------------------------------

test("mode tabs default to User, re-filter the grid on click, and dispatch Discover searches", async () => {
  const ownedLocal = matrixAgent({ id: "own-local", source: "local", owned: true, relationship: "none" });
  const foreignInstalled = matrixAgent({ id: "foreign-inst", source: "marketplace", owned: false, relationship: "installed" });
  const { window, elements, calls, modeTabs } = loadAgentsModuleHarness({
    agents: [ownedLocal, foreignInstalled],
    // The query typed below ("own") must match this listing's author: Discover
    // results are client-filtered to title/author-ldap matches.
    searchResults: [
      { id: "sol-disc", name: "Discover fixture", author: "owner", type: "agents" },
    ],
  });
  const list = elements.get("agents-tab-list");

  await window.AgentsTabModule.loadMyAgents();
  await settle();

  // Default mode is "user": only the viewer's editable local agents render.
  assert.match(list.innerHTML, /own-local/);
  assert.doesNotMatch(list.innerHTML, /foreign-inst/);

  // Clicking Installed re-filters in place (no Discover search) and moves the
  // active tab marker.
  const tabFor = (mode) => modeTabs.find((tab) => tab.dataset.agentsMode === mode);
  tabFor("marketplace").click();
  await settle();
  assert.match(list.innerHTML, /foreign-inst/);
  assert.doesNotMatch(list.innerHTML, /own-local/);
  assert.ok(tabFor("marketplace").classList.contains("active"));
  assert.ok(!tabFor("user").classList.contains("active"));
  assert.ok(!calls.some(([name]) => name === "search"), "grid modes never hit the marketplace");

  // Published mode with no qualifying agents shows the filter empty state
  // (list is non-empty, so it is a filter miss, not a search miss).
  tabFor("published").click();
  await settle();
  assert.match(list.innerHTML, /No agents match this filter\./);

  // Non-discover search input re-renders synchronously without any
  // marketplace traffic.
  window.AgentsTabModule; // (tab state lives in the controller)
  elements.get("agents-tab-search-input").dispatchEvent("input", { target: { value: "own" } });
  assert.ok(!calls.some(([name]) => name === "search"));

  // Discover mode dispatches the marketplace search and renders results.
  tabFor("discover").click();
  await settle();
  const searchCall = calls.find(([name]) => name === "search");
  assert.ok(searchCall, "discover mode runs the marketplace search");
  assert.match(list.innerHTML, /Discover fixture/);
});

// ---------------------------------------------------------------------------
// Item 3 — restyled publish modal: summary contract + Escape lifecycle
// ---------------------------------------------------------------------------

test("publish modal carries the summary contract and closes on Escape unless busy", async () => {
  const agent = {
    ...matrixAgent({ id: "agent-pub", source: "local", owned: true, relationship: "none" }),
    name: "Publishable Agent",
    system_prompt: "Prompt fixture body.",
    allowed_emails: ["teammate@example.invalid"],
  };
  const { window, elements, body, documentListeners } = loadAgentsModuleHarness({
    agents: [agent],
  });
  await window.AgentsTabModule.loadMyAgents();
  await settle();

  const keydownCountBefore = (documentListeners.get("keydown") || []).length;
  elements.get("agents-tab-list").dispatchEvent(
    "click",
    listClickEvent(actionButton({ classes: ["agent-publish-btn"], agentId: "agent-pub" })),
  );
  await settle();

  const overlay = body.children.find((child) => child.id === "agents-modal-overlay");
  assert.ok(overlay, "publish confirmation modal opened");

  // Summary contract (the strings the other suites and the marketplace flow
  // depend on) inside the restyled body.
  assert.match(overlay.innerHTML, /class="agents-publish-summary"/);
  assert.match(overlay.innerHTML, /agents-modal-eyebrow">AI Marketplace</);
  assert.match(overlay.innerHTML, /<p><strong>Visibility:<\/strong> Restricted to teammate@example\.invalid/);
  // The internal "Type: portico-agents" line was dropped in the
  // panelled-body makeover; the panel sections carry the structure instead.
  assert.ok(!overlay.innerHTML.includes("portico-agents</p>"), "no raw type line");
  assert.match(overlay.innerHTML, /agents-publish-section-label">Agent</);
  assert.match(overlay.innerHTML, /agents-publish-card-preview/);
  assert.match(overlay.innerHTML, /Publishable Agent/);
  assert.match(overlay.innerHTML, /System prompt preview/);
  assert.match(overlay.innerHTML, /Prompt fixture body\./);
  // The review note is an icon banner now: class and copy are in the same
  // element with an inline SVG between them.
  assert.match(overlay.innerHTML, /class="agents-publish-review-note"/);
  assert.match(overlay.innerHTML, /Review for any sensitive information/);
  // Unlinked agent → the primary action is a fresh Publish.
  assert.match(overlay.innerHTML, /class="btn-primary agents-modal-submit"[^>]*>Publish</);

  // The Escape handler is registered on open and guarded while busy.
  assert.equal(
    (documentListeners.get("keydown") || []).length,
    keydownCountBefore + 1,
    "open registers one document Escape handler",
  );
  overlay.dataset.busy = "true";
  dispatchDocumentKeydown(documentListeners, { key: "Escape" });
  assert.ok(body.children.includes(overlay), "busy modal ignores Escape");

  overlay.dataset.busy = "false";
  dispatchDocumentKeydown(documentListeners, { key: "x" });
  assert.ok(body.children.includes(overlay), "non-Escape keys are ignored");
  dispatchDocumentKeydown(documentListeners, { key: "Escape" });
  assert.ok(!body.children.includes(overlay), "Escape closes the idle modal");
  assert.equal(
    (documentListeners.get("keydown") || []).length,
    keydownCountBefore,
    "close removes the document handler so it never outlives the overlay",
  );
});

// ---------------------------------------------------------------------------
// Confirm modal behavior (async onConfirm, inline error, onCancel, Escape)
// ---------------------------------------------------------------------------

test("confirm modal supports async onConfirm with spinner, inline error, and onCancel", async () => {
  const { window, elements, documentListeners } = loadAgentsModuleHarness();
  const modal = elements.get("agents-confirm-modal");
  const confirmBtn = elements.get("agents-confirm-btn");
  const errorEl = elements.get("agents-confirm-error");

  let failing = true;
  window.showAgentsConfirmModal({
    title: "Unpublish?",
    message: "x",
    confirmLabel: "Unpublish",
    onConfirm: () =>
      failing ? Promise.reject(new Error("boom")) : Promise.resolve(),
  });
  assert.ok(modal.classList.contains("visible"));

  confirmBtn.click();
  assert.equal(modal.dataset.busy, "true");
  assert.match(confirmBtn.innerHTML, /btn-spinner/);
  // While busy, Escape must not dismiss the in-flight confirm.
  dispatchDocumentKeydown(documentListeners, { key: "Escape" });
  assert.ok(modal.classList.contains("visible"), "busy confirm ignores Escape");
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(errorEl.textContent, "boom");
  assert.equal(errorEl.hidden, false);
  assert.ok(modal.classList.contains("visible"), "modal stays open on failure");
  assert.notEqual(modal.dataset.busy, "true");

  failing = false;
  confirmBtn.click();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.ok(!modal.classList.contains("visible"), "modal hides on success");

  // cancelLabel + onCancel: cancel runs the callback after hiding.
  let cancelled = false;
  window.showAgentsConfirmModal({
    title: "Also remove the marketplace copy?",
    confirmLabel: "Remove copy",
    cancelLabel: "Keep listing",
    onConfirm: () => Promise.resolve(),
    onCancel: () => {
      cancelled = true;
    },
  });
  const cancelBtn = elements.get("agents-confirm-cancel-btn");
  assert.equal(cancelBtn.textContent, "Keep listing");
  cancelBtn.click();
  assert.equal(cancelled, true);
  assert.ok(!modal.classList.contains("visible"));

  // Idle modal closes on Escape.
  window.showAgentsConfirmModal({ title: "Escape?", onConfirm: () => Promise.resolve() });
  assert.ok(modal.classList.contains("visible"));
  dispatchDocumentKeydown(documentListeners, { key: "Escape" });
  assert.ok(!modal.classList.contains("visible"));

  // Optional secondary action: hidden unless configured, and it runs under
  // the same busy/inline-error contract as the primary confirm.
  const secondaryBtn = elements.get("agents-confirm-secondary-btn");
  window.showAgentsConfirmModal({ title: "No third choice", onConfirm: () => Promise.resolve() });
  assert.equal(secondaryBtn.hidden, true, "hidden when not configured");
  dispatchDocumentKeydown(documentListeners, { key: "Escape" });

  let secondaryFails = true;
  window.showAgentsConfirmModal({
    title: "Three-way",
    confirmLabel: "Primary",
    secondaryLabel: "Secondary",
    secondaryBusyLabel: "Working...",
    onConfirm: () => Promise.resolve(),
    onSecondary: () =>
      secondaryFails ? Promise.reject(new Error("secondary boom")) : Promise.resolve(),
  });
  assert.equal(secondaryBtn.hidden, false);
  assert.equal(secondaryBtn.textContent, "Secondary");
  secondaryBtn.click();
  assert.equal(modal.dataset.busy, "true");
  assert.match(secondaryBtn.innerHTML, /btn-spinner/);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(errorEl.textContent, "secondary boom");
  assert.ok(modal.classList.contains("visible"), "modal stays open on secondary failure");
  assert.notEqual(modal.dataset.busy, "true");

  secondaryFails = false;
  secondaryBtn.click();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.ok(!modal.classList.contains("visible"), "modal hides on secondary success");
});

// ---------------------------------------------------------------------------
// Delete flow: ONE confirm modal per case (never window.confirm)
// ---------------------------------------------------------------------------

test("deleting a published agent shows one three-way modal; Delete local only keeps the listing", async () => {
  const agent = matrixAgent({ id: "agent-del", source: "local", owned: true, relationship: "published" });
  const solution = { id: "sol-agent-del", name: "agent-del", type: "agents", submitted_by: VIEWER_EMAIL };
  const { window, elements, calls } = loadAgentsModuleHarness({
    agents: [agent],
    marketplaceLinks: {
      "agent-del": { solutionId: "sol-agent-del", relationship: "published", authorIdentity: VIEWER },
    },
    solutionsById: { "sol-agent-del": solution },
    bundlesBySolutionId: { "sol-agent-del": { success: true, data: { payload: {} } } },
  });
  await window.AgentsTabModule.loadMyAgents();
  await settle();
  const modal = elements.get("agents-confirm-modal");
  const titleEl = elements.get("agents-confirm-title");

  // window.confirm is booby-trapped in the harness: any use would throw.
  elements.get("agents-tab-list").dispatchEvent(
    "click",
    listClickEvent(actionButton({ classes: ["agent-delete-btn"], agentId: "agent-del" })),
  );
  await settle();
  assert.ok(modal.classList.contains("visible"));
  assert.equal(titleEl.textContent, "Delete agent?");
  assert.match(
    elements.get("agents-confirm-message").textContent,
    /is also published on the AI Marketplace\. What should happen to the listing\?/,
  );
  const confirmBtn = elements.get("agents-confirm-btn");
  const secondaryBtn = elements.get("agents-confirm-secondary-btn");
  assert.equal(confirmBtn.textContent, "Delete local + listing");
  assert.equal(secondaryBtn.hidden, false, "the third choice is visible");
  assert.equal(secondaryBtn.textContent, "Delete local only");
  assert.ok(!calls.some(([name]) => name === "subagents_delete_agent"), "nothing deleted yet");

  // "Delete local only" deletes the local copy but never the marketplace
  // solution — no second modal.
  secondaryBtn.click();
  await settle();
  assert.ok(!modal.classList.contains("visible"), "one modal, then done");
  const deleteCall = calls.find(([name]) => name === "subagents_delete_agent");
  assert.ok(deleteCall, "local agent deleted");
  assert.equal(deleteCall[1].model_id, "agent-del");
  assert.ok(calls.some(([name, id]) => name === "clearLink" && id === "agent-del"));
  assert.ok(
    !calls.some(([name]) => name === "deleteSolution"),
    "Delete local only never touches the marketplace copy",
  );
});

test("Delete local + listing removes the marketplace copy in the same single modal", async () => {
  const agent = matrixAgent({ id: "agent-del", source: "local", owned: true, relationship: "published" });
  const solution = { id: "sol-agent-del", name: "agent-del", type: "agents", submitted_by: VIEWER_EMAIL };
  const { window, elements, calls } = loadAgentsModuleHarness({
    agents: [agent],
    marketplaceLinks: {
      "agent-del": { solutionId: "sol-agent-del", relationship: "published", authorIdentity: VIEWER },
    },
    solutionsById: { "sol-agent-del": solution },
    bundlesBySolutionId: { "sol-agent-del": { success: true, data: { payload: {} } } },
  });
  await window.AgentsTabModule.loadMyAgents();
  await settle();

  elements.get("agents-tab-list").dispatchEvent(
    "click",
    listClickEvent(actionButton({ classes: ["agent-delete-btn"], agentId: "agent-del" })),
  );
  await settle();
  elements.get("agents-confirm-btn").click();
  await settle();
  assert.ok(
    calls.some(([name, id]) => name === "deleteSolution" && id === "sol-agent-del"),
    "the listing goes too",
  );
  assert.ok(calls.some(([name]) => name === "subagents_delete_agent"));
  assert.ok(
    !elements.get("agents-confirm-modal").classList.contains("visible"),
    "still just the one modal",
  );
});

test("deleting an installed agent is one quiet modal and a success toast", async () => {
  const agent = matrixAgent({ id: "agent-x", source: "local", owned: false, relationship: "installed" });
  const { window, elements, calls, notifications } = loadAgentsModuleHarness({
    agents: [agent],
    marketplaceLinks: {
      "agent-x": { solutionId: "sol-x", relationship: "installed", authorIdentity: "cdougherty" },
    },
    solutionsById: {
      "sol-x": { id: "sol-x", name: "agent-x", type: "agents", submitted_by: FOREIGN_EMAIL },
    },
    bundlesBySolutionId: { "sol-x": { success: true, data: { payload: {} } } },
  });
  await window.AgentsTabModule.loadMyAgents();
  await settle();

  const callsBeforeDelete = calls.length;
  elements.get("agents-tab-list").dispatchEvent(
    "click",
    listClickEvent(actionButton({ classes: ["agent-delete-btn"], agentId: "agent-x" })),
  );
  await settle();
  assert.equal(elements.get("agents-confirm-title").textContent, "Delete agent?");
  assert.match(
    elements.get("agents-confirm-message").textContent,
    /Delete "agent-x" from this computer\? The Marketplace listing won't be affected\./,
  );
  assert.equal(
    elements.get("agents-confirm-secondary-btn").hidden,
    true,
    "no listing choice for a copy you don't own",
  );
  assert.equal(
    elements.get("agents-confirm-meta").hidden,
    true,
    "no solution-id badge fuss for installed copies",
  );

  elements.get("agents-confirm-btn").click();
  await settle();
  assert.ok(calls.some(([name]) => name === "subagents_delete_agent"));
  assert.ok(!calls.some(([name]) => name === "deleteSolution"));
  assert.ok(
    !calls
      .slice(callsBeforeDelete)
      .some(([name]) => name === "getSolution"),
    "the delete flow makes no ownership preflight round-trip",
  );
  assert.deepEqual(
    notifications.at(-1),
    ["success", "Agent deleted."],
    "an expected outcome is a plain success, not a warning",
  );
});

// ---------------------------------------------------------------------------
// Item 5 — Discover parity: ellipsis menu, bundle-derived facts, author
// normalization, and solution actions
// ---------------------------------------------------------------------------

const DISCOVER_FIXTURES = {
  // Facts arrive via the bundle payload.
  bundled: {
    id: "sol-bundled",
    name: "Bundled Solution",
    description: "Bundle-backed agent",
    type: "agents",
    submitted_by: FOREIGN_EMAIL,
    detail_url: "https://solutions.sandbox.example.invalid/solution/sol-bundled",
    bundle: {
      payload: {
        base_model_id: "gpt-5",
        reasoning_effort: "high",
        skill_ids: ["algorithmic-art", "deep-research"],
        tool_server_ids: ["server:core-tools"],
      },
    },
  },
  // Facts arrive via the flattened envelope fields.
  flattened: {
    id: "sol-flat",
    name: "Flattened Solution",
    description: "Envelope-backed agent",
    type: "agents",
    submitted_by: VIEWER_EMAIL, // owned by the viewer → Unpublish appears
    base_model_id: "gpt-5",
    skill_ids: ["deep-research"],
    tool_server_ids: [],
  },
  // Installed locally (linked) → Uninstall appears, Install is disabled.
  installed: {
    id: "sol-installed",
    name: "Installed Solution",
    description: "Already installed",
    type: "agents",
    submitted_by: FOREIGN_EMAIL,
    bundle: { payload: { base_model_id: "gpt-5" } },
  },
};

async function openDiscover(harness) {
  await harness.window.AgentsTabModule.loadMyAgents();
  await settle();
  harness.modeTabs.find((tab) => tab.dataset.agentsMode === "discover").click();
  await settle();
}

test("discover cards render the solution menu, bundle/envelope facts, and normalized authors", async () => {
  const harness = loadAgentsModuleHarness({
    // The linked local copy must exist or the startup link reconcile prunes
    // the installed link as stale.
    agents: [
      matrixAgent({ id: "agent-installed", source: "marketplace", owned: false, relationship: "installed", readOnly: true }),
    ],
    marketplaceLinks: {
      "agent-installed": { solutionId: "sol-installed", relationship: "installed", authorIdentity: "someoneelse" },
    },
    searchResults: [
      DISCOVER_FIXTURES.bundled,
      DISCOVER_FIXTURES.flattened,
      DISCOVER_FIXTURES.installed,
    ],
  });
  const { elements, window } = harness;
  await openDiscover(harness);
  const html = elements.get("agents-tab-list").innerHTML;

  // Solution ellipsis menu: View in Marketplace on every card; Install when
  // installable; Uninstall only when installed; Unpublish only for the owner.
  assert.match(html, /data-menu-solution-id="sol-bundled"/);
  assert.match(html, /data-dropdown-solution-id="sol-bundled"/);
  // "View in Marketplace" was removed (the site page never went anywhere
  // useful); the menu offers only install/uninstall/unpublish actions.
  assert.equal((html.match(/solution-view-marketplace-btn/g) || []).length, 0);
  assert.match(html, /solution-uninstall-btn[^"]*" data-solution-id="sol-installed"/);
  assert.doesNotMatch(html, /solution-uninstall-btn[^"]*" data-solution-id="sol-bundled"/);
  assert.match(html, /solution-unpublish-btn[^"]*" data-solution-id="sol-flat"/);
  assert.doesNotMatch(html, /solution-unpublish-btn[^"]*" data-solution-id="sol-bundled"/);

  // Installed state: the discover card renders the full applicable badge set
  // from the linked local copy (here a foreign installed agent → Installed).
  assert.match(html, /badge-installed">Installed</);

  // Card facts derive from the bundle payload…
  assert.match(html, /data-solution-id="sol-bundled">2 skills</);
  assert.match(html, /agent-card-tools-row/);
  // …or from the flattened envelope fields.
  assert.match(html, /data-solution-id="sol-flat">1 skill</);

  // No Maturity/Quality/Status meta rows and no type badge on Discover cards.
  assert.doesNotMatch(html, /<strong>Status:<\/strong>/);
  assert.doesNotMatch(html, /Maturity/);
  assert.doesNotMatch(html, /Quality/);
  assert.doesNotMatch(html, /agent-badge"/);

  // Authors normalize to the bare-handle identity on BOTH tabs.
  assert.match(html, /badge-author" title="someoneelse">someoneelse</);
  assert.match(html, /badge-author" title="dsantiago">dsantiago</);

  // The solution-keyed skills link resolves its tooltip from the bundle facts.
  const anchor = new FakeElement("");
  anchor.classList.add("agent-card-skills-link");
  anchor.dataset.solutionId = "sol-bundled";
  anchor.closest = (selector) =>
    selector === ".agent-card-skills-link" ? anchor : null;
  elements.get("agents-tab-list").dispatchEvent("mouseover", { target: anchor, relatedTarget: null });
  const tooltip = harness.body.children.find((child) => child.className === "agent-card-tooltip");
  assert.ok(tooltip && tooltip.hidden === false, "solution tooltip shows");
  assert.match(tooltip.innerHTML, /Algorithmic Art/);
  assert.match(tooltip.innerHTML, /Deep Research/);

  // My Agents side of the author normalization: an owned local agent renders
  // the viewer handle.
  const myCard = window.AgentCardRenderer.buildAgentCardHtml(
    matrixAgent({ id: "own", source: "local", owned: true, relationship: "none" }),
    { viewerIdentity: VIEWER },
  );
  assert.match(myCard, /badge-author" title="dsantiago">dsantiago</);
});

test("discover bundle enrichment is bounded, cached, and re-renders once resolved", async () => {
  // A search result with no inline facts: the card enriches via getBundle.
  const bare = {
    id: "sol-bare",
    name: "Bare Solution",
    description: "No inline facts",
    type: "agents",
    submitted_by: FOREIGN_EMAIL,
  };
  const harness = loadAgentsModuleHarness({
    searchResults: [bare],
    bundlesBySolutionId: {
      "sol-bare": {
        success: true,
        data: { payload: { base_model_id: "gpt-5", skill_ids: ["deep-research"] } },
      },
    },
  });
  const { elements, calls } = harness;
  await openDiscover(harness);

  const fetches = calls.filter(([name, id]) => name === "getBundle" && id === "sol-bare");
  assert.equal(fetches.length, 1, "one bounded enrichment fetch per candidate");
  // The re-render after enrichment shows the resolved facts.
  const html = elements.get("agents-tab-list").innerHTML;
  assert.match(html, /data-solution-id="sol-bare">1 skill</);

  // A repeat search reuses the session cache instead of refetching.
  harness.modeTabs.find((tab) => tab.dataset.agentsMode === "discover").click();
  await settle();
  assert.equal(
    calls.filter(([name, id]) => name === "getBundle" && id === "sol-bare").length,
    1,
    "enrichment result is cached for the session",
  );
});

test("solution actions: uninstall locally, unpublish for owners", async () => {
  const harness = loadAgentsModuleHarness({
    agents: [
      matrixAgent({ id: "agent-installed", source: "marketplace", owned: false, relationship: "installed", readOnly: true }),
    ],
    marketplaceLinks: {
      "agent-installed": { solutionId: "sol-installed", relationship: "installed", authorIdentity: "someoneelse" },
    },
    searchResults: [
      DISCOVER_FIXTURES.bundled,
      DISCOVER_FIXTURES.flattened,
      DISCOVER_FIXTURES.installed,
    ],
  });
  const { elements, calls, externalOpens } = harness;
  await openDiscover(harness);
  const list = elements.get("agents-tab-list");
  const modal = elements.get("agents-confirm-modal");

  // "View in Marketplace" is gone: clicks on its old class fall through and
  // never open an external page.
  list.dispatchEvent(
    "click",
    listClickEvent(actionButton({ classes: ["solution-view-marketplace-btn"], solutionId: "sol-bundled" })),
  );
  assert.deepEqual(externalOpens, []);

  // Uninstall: deletes only the local copy (subagents delete + link clear),
  // never the marketplace listing.
  list.dispatchEvent(
    "click",
    listClickEvent(actionButton({ classes: ["solution-uninstall-btn"], solutionId: "sol-installed" })),
  );
  await settle();
  assert.ok(modal.classList.contains("visible"));
  assert.equal(elements.get("agents-confirm-title").textContent, "Uninstall agent?");
  elements.get("agents-confirm-btn").click();
  await settle();
  const localDelete = calls.find(([name]) => name === "subagents_delete_agent");
  assert.ok(localDelete);
  assert.equal(localDelete[1].model_id, "agent-installed");
  assert.ok(calls.some(([name, id]) => name === "clearLink" && id === "agent-installed"));
  assert.ok(!calls.some(([name]) => name === "deleteSolution"), "uninstall keeps the listing");

  // Unpublish (owner-only menu entry): deletes the marketplace solution and
  // leaves link cleanup to the app-owned delete lifecycle.
  list.dispatchEvent(
    "click",
    listClickEvent(actionButton({ classes: ["solution-unpublish-btn"], solutionId: "sol-flat" })),
  );
  await settle();
  assert.ok(calls.some(([name]) => name === "hasApiKey"), "unpublish is key-gated");
  assert.equal(elements.get("agents-confirm-title").textContent, "Unpublish?");
  const clearsBefore = calls.filter(([name]) => name === "clearLink").length;
  elements.get("agents-confirm-btn").click();
  await settle();
  assert.ok(calls.some(([name, id]) => name === "deleteSolution" && id === "sol-flat"));
  assert.equal(
    calls.filter(([name]) => name === "clearLink").length,
    clearsBefore,
    "renderer-side unpublish never blindly erases links",
  );
});

// ---------------------------------------------------------------------------
// Installed agent read-only pane
// ---------------------------------------------------------------------------

test("installed agent details open the styled read-only information pane", async () => {
  const installed = matrixAgent({
    id: "agent-installed",
    source: "marketplace",
    owned: false,
    relationship: "installed",
    readOnly: true,
  });
  const { window, elements, editorHost } = loadAgentsModuleHarness({
    agents: [installed],
    marketplaceLinks: {
      "agent-installed": { solutionId: "sol-i", relationship: "installed", authorIdentity: "someoneelse" },
    },
  });
  await window.AgentsTabModule.loadMyAgents();
  await settle();

  elements.get("agents-tab-list").dispatchEvent(
    "click",
    listClickEvent(actionButton({ classes: ["agent-details-btn"], agentId: "agent-installed" })),
  );
  await settle();

  const content = editorHost.querySelector("[data-agent-editor-content]").innerHTML;
  assert.match(content, /data-readonly="true"/);
  assert.match(content, /class="marketplace-readonly-pane"/);
  assert.match(
    content,
    /This agent was installed from the AI Solutions Marketplace and is read only\. Create a copy if you&#39;d like to customize it\./,
  );
  assert.match(content, /Installed from AI Solutions Marketplace/);
});

// ---------------------------------------------------------------------------
// Post-install landing: a fresh agent shows up where it lives
// ---------------------------------------------------------------------------
// Behavioral home for the retired source-pin in
// control-plane-render-regressions.test.js (the TYPE_AGENTS install-branch
// regex): a successful agent install must land on the Installed tab, not All.

test("a successful agent install from Discover lands on the Installed tab", async () => {
  const { window, modeTabs } = loadAgentsModuleHarness({
    installImpl: () => ({
      success: true,
      data: {
        type: "portico-agents",
        mutation: "created",
        created: { id: "priv-analyzer", name: "Priv Analyzer" },
      },
    }),
  });
  await window.AgentsTabModule.loadMyAgents();
  await settle();

  await window.AgentsPublishHooks.performInstallSolution("sol-x");
  await settle();

  const activeModes = modeTabs
    .filter((tab) => tab.classList.contains("active"))
    .map((tab) => tab.dataset.agentsMode);
  assert.deepEqual(
    activeModes,
    ["marketplace"],
    "the Installed tab (mode key \"marketplace\") is the one left active",
  );
});

// ---------------------------------------------------------------------------
// Mode-switch race: a stale my-agents load must never clobber Discover
// ---------------------------------------------------------------------------

test("a late my-agents load never clobbers the Discover grid", async () => {
  const ownedLocal = matrixAgent({
    id: "own-local",
    source: "local",
    owned: true,
    relationship: "none",
  });
  const { window, elements, modeTabs } = loadAgentsModuleHarness({
    agents: [ownedLocal],
    searchResults: [
      { id: "sol-disc", name: "Discover fixture", author: "owner", type: "agents" },
    ],
  });
  const list = elements.get("agents-tab-list");
  const tabFor = (mode) => modeTabs.find((tab) => tab.dataset.agentsMode === mode);

  // Hold the agents list open so the load is still in flight when the user
  // switches tabs — the real repro is a quick User → Discover click while
  // loadMyAgents is mid-await.
  let releaseAgentsList;
  const agentsListGate = new Promise((resolve) => {
    releaseAgentsList = resolve;
  });
  const electronAPI = window.electronAPI;
  const originalInvoke = electronAPI.invokeMcpTool;
  electronAPI.invokeMcpTool = async (serverId, toolName, input) => {
    if (toolName === "subagents_list_agents") await agentsListGate;
    return originalInvoke(serverId, toolName, input);
  };

  const pendingLoad = window.AgentsTabModule.loadMyAgents();
  await settle();
  tabFor("discover").click();
  await settle();
  assert.match(list.innerHTML, /Discover fixture/, "discover results render first");

  releaseAgentsList();
  await pendingLoad;
  await settle();
  assert.match(
    list.innerHTML,
    /Discover fixture/,
    "the late load leaves the discover grid alone",
  );
  assert.doesNotMatch(
    list.innerHTML,
    /own-local/,
    "local agents never paint over marketplace results",
  );
  assert.ok(tabFor("discover").classList.contains("active"));
  assert.ok(!tabFor("user").classList.contains("active"));

  // Flipping back to User renders the local list normally (the guard only
  // suppresses paints while Discover owns the grid).
  tabFor("user").click();
  await settle();
  assert.match(list.innerHTML, /own-local/);
});

// ---------------------------------------------------------------------------
// Badge provenance fallback (2026-08-14 Smart Slides incident): an installed
// marketplace copy whose link AND meta relationship were both destroyed
// still renders INSTALLED from creation_source — the field the meta scrub
// never removes.
// ---------------------------------------------------------------------------

test("creation_source=marketplace read-only foreign agents render INSTALLED without any link", async () => {
  const orphanInstall = matrixAgent({
    id: "orphan-install",
    source: "marketplace",
    owned: false,
    relationship: "none",
    readOnly: true,
  });
  const writableForeign = matrixAgent({
    id: "writable-foreign",
    source: "marketplace",
    owned: false,
    relationship: "none",
    readOnly: false,
  });
  const ownedLocal = matrixAgent({
    id: "owned-local",
    source: "local",
    owned: true,
    relationship: "none",
  });
  const { window } = loadAgentsModuleHarness({
    agents: [orphanInstall, writableForeign, ownedLocal],
    marketplaceLinks: {},
  });
  await window.AgentsTabModule.loadMyAgents();

  const hooks = window.AgentsTabRenderHooks;
  const normalized = Object.fromEntries(
    hooks.myAgentsForTests().map((agent) => [agent.id, agent]),
  );
  assert.equal(normalized["orphan-install"].marketplace_relationship, "installed");
  assert.match(
    hooks.agentStatusBadgesHtml(normalized["orphan-install"]),
    /badge-installed/,
  );
  assert.equal(normalized["writable-foreign"].marketplace_relationship, null);
  assert.doesNotMatch(
    hooks.agentStatusBadgesHtml(normalized["writable-foreign"]) || "",
    /badge-installed/,
  );
  assert.equal(normalized["owned-local"].marketplace_relationship, null);
});
