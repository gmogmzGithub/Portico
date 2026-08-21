// Agents tab overhaul regressions: unpublished-changes link flag semantics
// (registry behavior + the renderer→preload→ipc pipeline + the card badge),
// card menu positioning, and clone-as-prefilled-create. Renderer behavior is
// driven through the real agents.js module in a vm harness; the preload/ipc
// pipeline through Module._load stubs (mirrors terminal-command-ipc).
//
// Not asserted here (visual layer, covered by live visual QA): the
// .badge-unpublished badge styling, the #agents-tab-browser /
// .agent-editor-inline-host scroll-chain CSS, model-picker tier colors and
// provider-grid CSS, the .agent-editor-page full-width/header grid CSS, and
// the retired #agents-tab-view .mcp-server-card.agent-card override.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");

const links = require("./ai-marketplace-agent-links");

function tmpDeps() {
  return { userDataPath: fs.mkdtempSync(path.join(os.tmpdir(), "agent-links-")) };
}

// ---------------------------------------------------------------------------
// Link registry behavior (State & Persistence layer)
// ---------------------------------------------------------------------------

test("markLinkDirty flags a linked agent and setLink clears it on publish", async () => {
  const deps = tmpDeps();
  // No link yet: dirty marking is a no-op.
  assert.equal(await links.markLinkDirty("agent-1", deps), null);

  const created = await links.setLink("agent-1", "sol-1", deps);
  assert.equal(created.hasLocalChanges, false);

  const dirty = await links.markLinkDirty("agent-1", deps);
  assert.equal(dirty.hasLocalChanges, true);
  assert.equal((await links.listLinks(deps))["agent-1"].hasLocalChanges, true);

  // Publish success rewrites the link and clears the flag.
  const republished = await links.setLink("agent-1", "sol-1", deps);
  assert.equal(republished.hasLocalChanges, false);
});

test("legacy link records without the flag normalize to clean", () => {
  const normalized = links.normalizeState({
    links: { "agent-legacy": { solutionId: "sol-9", publishedAt: 5, lastUpdatedAt: 6 } },
  });
  assert.equal(normalized.schemaVersion, 2);
  assert.equal(normalized.links["agent-legacy"].hasLocalChanges, false);
  assert.equal(normalized.links["agent-legacy"].relationship, "unknown");
  assert.equal(normalized.links["agent-legacy"].authorIdentity, null);
  assert.equal(normalized.links["agent-legacy"].attributionPending, false);
});

test("installed links preserve publisher identity and finalize pending attribution", async () => {
  const deps = tmpDeps();
  const pending = await links.setInstalledLink(
    "agent-installed",
    "sol-installed",
    "OriginalPublisher",
    { ...deps, attributionPending: true },
  );
  assert.equal(pending.relationship, "installed");
  assert.equal(pending.authorIdentity, "OriginalPublisher");
  assert.equal(pending.attributionPending, true);

  const reinstalled = await links.setInstalledLink(
    "agent-installed",
    "sol-installed",
    "ChangedPublisher",
    deps,
  );
  assert.equal(reinstalled.authorIdentity, "OriginalPublisher");
  assert.equal(reinstalled.attributionPending, false);

  await links.setInstalledLink(
    "agent-installed",
    "sol-installed",
    "OriginalPublisher",
    { ...deps, attributionPending: true },
  );
  const finalized = await links.finalizeAttribution("agent-installed", deps);
  assert.equal(finalized.attributionPending, false);
});

test("unpublish clears published links without erasing installed provenance", async () => {
  const deps = tmpDeps();
  await links.setPublishedLink(
    "agent-published",
    "sol-shared",
    "owner@example.invalid",
    deps,
  );
  await links.setInstalledLink(
    "agent-installed",
    "sol-shared",
    "owner@example.invalid",
    deps,
  );

  assert.deepEqual(
    await links.clearPublishedLinksBySolutionId("sol-shared", deps),
    ["agent-published"],
  );
  const remaining = await links.listLinks(deps);
  assert.equal(remaining["agent-published"], undefined);
  assert.equal(remaining["agent-installed"].relationship, "installed");
});

test("strict registry reads reject malformed data while tolerant UI reads stay empty", async () => {
  const deps = tmpDeps();
  await fs.promises.writeFile(
    links.getLinksFilePath(deps),
    "{ malformed",
    "utf8",
  );
  await assert.rejects(() => links.readStateStrict(deps), /JSON/);
  assert.deepEqual(await links.listLinks(deps), {});
  await assert.rejects(
    () => links.setPublishedLink("unsafe", "solution", "owner@example.com", deps),
    /JSON/,
  );
  await assert.rejects(() => links.markLinkDirty("unsafe", deps), /JSON/);
  await assert.rejects(() => links.clearLink("unsafe", deps), /JSON/);

  await fs.promises.writeFile(
    links.getLinksFilePath(deps),
    JSON.stringify({ schemaVersion: 2, links: [] }),
    "utf8",
  );
  await assert.rejects(
    () => links.readStateStrict(deps),
    /must contain a links object/,
  );

  await fs.promises.writeFile(
    links.getLinksFilePath(deps),
    JSON.stringify({ schemaVersion: 2, links: { unsafe: { relationship: "installed" } } }),
    "utf8",
  );
  await assert.rejects(() => links.readStateStrict(deps), /missing solutionId/);
});

test("strict agent-link reads reject a symlinked registry", async () => {
  const deps = tmpDeps();
  const targetPath = path.join(deps.userDataPath, "agent-links-target.json");
  await fs.promises.writeFile(
    targetPath,
    JSON.stringify({ schemaVersion: 2, links: {} }),
    "utf8",
  );
  await fs.promises.symlink(targetPath, links.getLinksFilePath(deps));

  await assert.rejects(
    () => links.readStateStrict(deps),
    /must be a regular file/,
  );
});

// ---------------------------------------------------------------------------
// vm harness for the renderer module (mirrors agents-tab-clickability)
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

// Set per-harness so ownerDocument (needed by the real model-picker mount)
// resolves to the active fake document.
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
  marketplaceLinks = {},
  // Local-only warning flags served by electronAPI.listAgentFlags.
  agentFlags = {},
  // Payload returned by electronAPI.currentUser.get(); undefined models the
  // pre-auth state (identity resolution falls back to getUsername).
  currentUser = undefined,
} = {}) {
  const componentsDir = path.join(__dirname, "..", "renderer", "components");
  const agentsPath = path.join(componentsDir, "agents.js");
  const source = fs.readFileSync(agentsPath, "utf8");
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
    "agents-discard-modal",
    "agents-discard-subject",
    "agents-discard-close-btn",
    "agents-discard-keep-btn",
    "agents-discard-confirm-btn",
  ].forEach(addElement);
  const editorHost = new FakeElement("agents-tab-editor", { autoVivify: true });
  elements.set("agents-tab-editor", editorHost);

  const body = new FakeElement("body");
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
    querySelectorAll() {
      return [];
    },
    querySelector() {
      return null;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  currentDocument = documentObject;

  const calls = [];
  const marketplaceCalls = [];
  const notifications = [];
  const windowObject = {
    appState: { controlPlaneView: "mcp-servers" },
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener() {},
    removeEventListener() {},
    electronAPI: {
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
          return { success: true, data: { system_prompt: "You are a fixture." } };
        }
        return { success: true, data: {} };
      },
      getSkills: async () => ({ success: true, skills: [] }),
      loadMcpServers: async () => ({ success: true, data: [] }),
      listAgentFlags: async () => ({ success: true, flags: agentFlags }),
      getUsername: async () => ({ username: "dsantiago" }),
      currentUser: {
        get: async () => currentUser,
      },
      aiMarketplace: {
        listLinks: async () => ({ success: true, links: marketplaceLinks }),
        markLinkDirty: async (agentId) => {
          marketplaceCalls.push(["markLinkDirty", agentId]);
          return { success: true };
        },
      },
    },
    showNotification(message, kind) {
      notifications.push([String(message || ""), String(kind || "")]);
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
  vm.runInNewContext(source, context, { filename: agentsPath });

  return {
    window: windowObject,
    elements,
    body,
    calls,
    marketplaceCalls,
    notifications,
    editorHost,
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

function actionButton({ classes = [], agentId = "" } = {}) {
  const btn = new FakeElement("");
  classes.forEach((name) => btn.classList.add(name));
  if (agentId) btn.attributes["data-agent-id"] = agentId;
  return btn;
}

const ownedAgent = (overrides = {}) => ({
  id: "agent-1",
  name: "Base Agent",
  description: "Fixture agent",
  base_model_id: "gpt-5",
  skill_ids: [],
  tool_server_ids: [],
  created_by_email: "dsantiago@example.invalid",
  creation_source: "local",
  ...overrides,
});

// ---------------------------------------------------------------------------
// Dirty flag pipeline: preload channel → ipc handler → registry → card badge.
// (The editor-submit call site — markLinkDirty only on non-sync saves with
// real content changes — is an editor-form integration verified in live QA;
// each layer it composes is covered below.)
// ---------------------------------------------------------------------------

function loadPreloadWithIpc(handlers) {
  const preloadPath = require.resolve("./preload");
  const originalLoad = Module._load;
  const previous = require.cache[preloadPath];
  const sent = [];
  const electronStub = {
    contextBridge: {
      exposed: {},
      exposeInMainWorld(name, api) {
        this.exposed[name] = api;
      },
    },
    ipcRenderer: {
      invoke: (channel, ...args) => {
        const handler = handlers.get(channel);
        if (!handler) {
          return Promise.reject(new Error(`no ipc handler for ${channel}`));
        }
        return Promise.resolve(handler(null, ...args));
      },
      send(channel, ...args) {
        sent.push([channel, ...args]);
      },
      on() {},
      removeListener() {},
      removeAllListeners() {},
    },
  };
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") return electronStub;
    return originalLoad.apply(this, [request, parent, isMain]);
  };
  delete require.cache[preloadPath];
  try {
    require("./preload");
  } finally {
    Module._load = originalLoad;
    delete require.cache[preloadPath];
    if (previous) require.cache[preloadPath] = previous;
  }
  return { electronAPI: electronStub.contextBridge.exposed.electronAPI, sent };
}

function loadIpcMarketplaceHandlers(userDataPath) {
  const ipcModulePath = require.resolve("./ipc");
  const linksModulePath = require.resolve("./ai-marketplace-agent-links");
  const originalLoad = Module._load;
  const previousIpc = require.cache[ipcModulePath];
  const previousLinks = require.cache[linksModulePath];
  const handlers = new Map();
  const electronStub = {
    app: {
      getPath() {
        return userDataPath;
      },
    },
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
      on() {},
    },
    shell: { async openExternal() {}, async openPath() {} },
    clipboard: { writeText() {} },
    BrowserWindow: {
      fromWebContents() {
        return null;
      },
      getAllWindows() {
        return [];
      },
    },
    Notification: function Notification() {},
  };
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") return electronStub;
    const fromIpc = parent?.filename === ipcModulePath;
    if (fromIpc && (request.startsWith("./") || request.startsWith("../"))) {
      // The link registry stays REAL so the handler drives the actual
      // persistence code; every other ipc.js dependency is stubbed out.
      if (request === "./ai-marketplace-agent-links") {
        return originalLoad.apply(this, [request, parent, isMain]);
      }
      return {};
    }
    return originalLoad.apply(this, [request, parent, isMain]);
  };
  delete require.cache[ipcModulePath];
  delete require.cache[linksModulePath];
  const ipc = require("./ipc");
  ipc.registerAiMarketplaceHandlers();
  const restore = () => {
    Module._load = originalLoad;
    delete require.cache[ipcModulePath];
    delete require.cache[linksModulePath];
    if (previousIpc) require.cache[ipcModulePath] = previousIpc;
    if (previousLinks) require.cache[linksModulePath] = previousLinks;
  };
  return { handlers, restore };
}

test("dirty flag flows renderer→preload→ipc into the real link registry", async () => {
  const deps = tmpDeps();
  await links.setLink("agent-1", "sol-1", deps);

  const { handlers, restore } = loadIpcMarketplaceHandlers(deps.userDataPath);
  try {
    const { electronAPI } = loadPreloadWithIpc(handlers);
    assert.equal(typeof electronAPI.aiMarketplace.markLinkDirty, "function");

    // Renderer-facing call → preload channel → ipc handler → registry file.
    const res = await electronAPI.aiMarketplace.markLinkDirty("agent-1");
    assert.equal(res.success, true);
    assert.equal(res.link.hasLocalChanges, true);
    assert.equal(
      (await links.listLinks(deps))["agent-1"].hasLocalChanges,
      true,
      "the same registry file the app reads reflects the dirty flag",
    );

    // Unlinked agents stay a no-op end to end.
    const noop = await electronAPI.aiMarketplace.markLinkDirty("agent-unlinked");
    assert.equal(noop.success, true);
    assert.equal(noop.link, null);
  } finally {
    restore();
  }
});

test("linked agents with local changes render the Unpublished changes badge", async () => {
  const dirtyLink = {
    "agent-1": {
      solutionId: "sol-1",
      relationship: "published",
      authorIdentity: "dsantiago",
      hasLocalChanges: true,
    },
  };
  const { window, elements } = loadAgentsModuleHarness({
    agents: [ownedAgent()],
    marketplaceLinks: dirtyLink,
  });
  await window.AgentsTabModule.loadMyAgents();
  await settle();

  // The link's hasLocalChanges surfaces on the rendered card.
  const listHtml = elements.get("agents-tab-list").innerHTML;
  assert.match(listHtml, /class="mcp-card-badge badge-unpublished"[^>]*>Unpublished changes</);

  // A clean link renders no badge; neither does a dirty link on an agent the
  // viewer cannot publish (foreign installed copy).
  const render = window.AgentCardRenderer.buildAgentCardHtml;
  const clean = render(
    {
      ...ownedAgent(),
      marketplace_solution_id: "sol-1",
      marketplace_relationship: "published",
      marketplace_link: { authorIdentity: "dsantiago" },
      has_unpublished_changes: false,
    },
    { viewerIdentity: "dsantiago" },
  );
  assert.doesNotMatch(clean, /badge-unpublished/);
  const foreign = render(
    {
      ...ownedAgent({ created_by_email: "someone-else", creation_source: "marketplace" }),
      marketplace_solution_id: "sol-2",
      marketplace_relationship: "installed",
      has_unpublished_changes: true,
      is_read_only: true,
    },
    { viewerIdentity: "dsantiago" },
  );
  assert.doesNotMatch(foreign, /badge-unpublished/);
});

// ---------------------------------------------------------------------------
// Card menu anchoring
// ---------------------------------------------------------------------------

test("agent card menus anchor at the trigger using the dropdown's measured size", async () => {
  const { window, elements, body } = loadAgentsModuleHarness({
    agents: [ownedAgent()],
  });
  const list = elements.get("agents-tab-list");

  const makeMenu = (rect) => {
    const trigger = new FakeElement("");
    const wrapper = new FakeElement("");
    const dropdown = new FakeElement("");
    dropdown.offsetWidth = 260;
    dropdown.offsetHeight = 180;
    trigger.parentElement = wrapper;
    trigger.rect = rect;
    wrapper.selectorMap.set(".mcp-card-dropdown", dropdown);
    wrapper.appendChild(dropdown);
    return { trigger, wrapper, dropdown };
  };
  const roomy = makeMenu({ left: 900, right: 920, top: 100, bottom: 120, width: 20, height: 20 });
  const clamped = makeMenu({ left: 1050, right: 1070, top: 100, bottom: 120, width: 20, height: 20 });
  const flipped = makeMenu({ left: 300, right: 320, top: 680, bottom: 700, width: 20, height: 20 });
  list.selectorMap.set(
    "all:.mcp-card-menu-trigger[data-menu-agent-id], .mcp-card-menu-trigger[data-menu-solution-id]",
    [roomy.trigger, clamped.trigger, flipped.trigger],
  );

  await window.AgentsTabModule.loadMyAgents();
  await settle();

  // Plenty of room: the menu opens below the ellipsis, aligned to its left
  // edge, and is body-mounted to escape card overflow clipping.
  roomy.trigger.click();
  assert.ok(roomy.dropdown.classList.contains("visible"));
  assert.equal(roomy.dropdown.parentElement, body);
  assert.equal(roomy.dropdown._originalParent, roomy.wrapper);
  assert.equal(roomy.dropdown.style.left, "900px");
  assert.equal(roomy.dropdown.style.top, `${120 + 4}px`);
  assert.ok(!roomy.dropdown.classList.contains("open-upward"));

  // Near the right edge: the MEASURED width (260px, not a hardcoded one)
  // drives the viewport clamp.
  clamped.trigger.click();
  assert.equal(clamped.dropdown.style.left, `${1200 - 260 - 8}px`);

  // Near the bottom edge: the measured height flips the menu upward.
  flipped.trigger.click();
  assert.ok(flipped.dropdown.classList.contains("open-upward"));
  assert.equal(flipped.dropdown.style.top, `${680 - 180 - 4}px`);
});

// ---------------------------------------------------------------------------
// Clone = prefilled create page (and inline-page header/read-only behavior)
// ---------------------------------------------------------------------------

test("clone opens a prefilled create page with a unique copy name and never writes", async () => {
  const { window, elements, calls, editorHost } = loadAgentsModuleHarness({
    agents: [
      ownedAgent(),
      ownedAgent({ id: "agent-2", name: "Base Agent (copy)", description: "Existing copy" }),
    ],
  });
  await window.AgentsTabModule.loadMyAgents();
  await settle();

  const list = elements.get("agents-tab-list");
  list.dispatchEvent(
    "click",
    listClickEvent(actionButton({ classes: ["agent-clone-btn"], agentId: "agent-1" })),
  );
  await settle();

  // The inline create page opens with the compact header (hero chrome is
  // gone) and the prefilled unique copy name — "(copy)" is taken, so the
  // clone becomes "(copy 2)".
  const editorHtml = editorHost.innerHTML;
  assert.match(editorHtml, /class="agent-editor-header"/);
  assert.match(editorHtml, /class="agent-editor-header-main"/);
  assert.doesNotMatch(editorHtml, /agent-editor-hero/);
  assert.doesNotMatch(editorHtml, /agents-modal-eyebrow/);
  assert.match(editorHtml, /New agent/);
  assert.match(editorHtml, /Base Agent \(copy 2\)/);
  assert.match(editorHtml, /You are a fixture\./, "system prompt is prefilled");
  assert.match(editorHtml, /Create agent/);

  // Nothing was written: clone only prefills the editor.
  assert.ok(!calls.some(([tool]) => tool === "subagents_create_agent"));
  assert.ok(!calls.some(([tool]) => tool === "subagents_update_agent"));
});

test("clone from a dirty editor routes through the discard guard; a clean read-only page never trips it", async () => {
  const { window, elements, calls, editorHost } = loadAgentsModuleHarness({
    agents: [ownedAgent()],
  });
  await window.AgentsTabModule.loadMyAgents();
  await settle();
  const list = elements.get("agents-tab-list");
  const discardModal = elements.get("agents-discard-modal");

  // Open the create editor and dirty it (the serialized form diverges from
  // the baseline captured at open).
  elements.get("agents-tab-new-agent-btn").click();
  await settle();
  const form = editorHost.querySelector(".agents-form");
  form.formEntries = [["name", "edited by hand"]];

  // Clone while dirty: the discard modal interposes and the clone does NOT
  // run yet.
  const before = calls.filter(([tool]) => tool === "subagents_get_agent").length;
  list.dispatchEvent(
    "click",
    listClickEvent(actionButton({ classes: ["agent-clone-btn"], agentId: "agent-1" })),
  );
  await settle();
  assert.ok(discardModal.classList.contains("visible"), "dirty editor shows the discard guard");
  assert.equal(
    calls.filter(([tool]) => tool === "subagents_get_agent").length,
    before,
    "clone waits for the discard decision",
  );

  // Confirming the discard tears the editor down and continues the clone.
  elements.get("agents-discard-confirm-btn").click();
  await settle();
  assert.ok(!discardModal.classList.contains("visible"));
  assert.match(editorHost.innerHTML, /Base Agent \(copy\)/);

  // Read-only view pages (mode "view") never count as dirty: closing one
  // tears down immediately without the guard.
  list.dispatchEvent(
    "click",
    listClickEvent(actionButton({ classes: ["agent-details-btn"], agentId: "agent-1" })),
  );
  await settle();
  // The async page swaps the loaded read-only body into the content slot.
  const viewContent = editorHost.querySelector("[data-agent-editor-content]").innerHTML;
  assert.match(viewContent, /data-readonly="true"/, "view page renders read-only");
  editorHost.querySelector(".agents-form").formEntries = [["name", "poke"]];
  editorHost.querySelector(".agent-editor-back-btn").click();
  await settle();
  assert.ok(!discardModal.classList.contains("visible"), "view pages skip the discard guard");
  assert.equal(editorHost.style.display, "none", "view page closed straight away");
});

// ---------------------------------------------------------------------------
// Creator identity + card routing + local-only saves (behavioral homes for the
// former source-pin tests in control-plane-render-regressions.test.js)
// ---------------------------------------------------------------------------

// The create/edit forms are driven through the same FakeElement seams the
// module reads: FormData comes from form.formEntries, required-field
// validation reads the vivified field elements' .value.
function fillAgentEditorForm(editorHost, { name, allowedEmails = "" } = {}) {
  const form = editorHost.querySelector(".agents-form");
  form.formEntries = [
    ["name", name],
    ["base_model_id", "gpt-5"],
    ["system_prompt", "You are a fixture."],
    ["description", "Round 5 fixture"],
    ["allowed_emails", allowedEmails],
    ["reasoning_effort", ""],
  ];
  const nameInput = editorHost.querySelector('input[name="name"]');
  nameInput.value = name;
  nameInput.setCustomValidity = () => {};
  form.querySelector('[name="name"]').value = name;
  form.querySelector('[name="base_model_id"]').value = "gpt-5";
  form.querySelector('[name="system_prompt"]').value = "You are a fixture.";
  const allowedField = editorHost.querySelector('.agents-form [name="allowed_emails"]');
  allowedField.value = allowedEmails;
  allowedField.setCustomValidity = () => {};
  return form;
}

test("create submits app-owned identity: created_by_email is never sent and the authenticated creator joins the allow list", async () => {
  const { window, elements, calls, editorHost } = loadAgentsModuleHarness({
    agents: [ownedAgent()],
    currentUser: { authenticated: true, email: "dsantiago@example.invalid" },
  });
  await window.AgentsTabModule.loadMyAgents();
  await settle();

  elements.get("agents-tab-new-agent-btn").click();
  await settle();
  fillAgentEditorForm(editorHost, {
    name: "Round5 Restricted Agent",
    allowedEmails: "teammate@example.invalid",
  });
  editorHost.querySelector(".agents-modal-submit").click();
  await settle();

  const createCall = calls.find(([tool]) => tool === "subagents_create_agent");
  assert.ok(createCall, "create was submitted");
  const args = createCall[1];
  assert.ok(
    !Object.prototype.hasOwnProperty.call(args, "created_by_email"),
    "creator identity is app-owned; the renderer never sends created_by_email",
  );
  assert.equal(args.name, "Round5 Restricted Agent");
  // Restricted agents always keep their creator: the authenticated email is
  // appended to the allow list server-args before the create fires. (Spread
  // re-creates the array in this realm; vm-realm arrays fail deepEqual.)
  assert.deepEqual([...args.allowed_emails], [
    "teammate@example.invalid",
    "dsantiago@example.invalid",
  ]);
});

test("restricted creates fail closed without a usable authenticated email", async () => {
  // Unauthenticated session: the email is not trusted even though present.
  const unauthenticated = loadAgentsModuleHarness({
    agents: [ownedAgent()],
    currentUser: { authenticated: false, email: "dsantiago@example.invalid" },
  });
  await unauthenticated.window.AgentsTabModule.loadMyAgents();
  await settle();
  unauthenticated.elements.get("agents-tab-new-agent-btn").click();
  await settle();
  fillAgentEditorForm(unauthenticated.editorHost, {
    name: "Round5 Restricted Agent",
    allowedEmails: "teammate@example.invalid",
  });
  unauthenticated.editorHost.querySelector(".agents-modal-submit").click();
  await settle();
  assert.ok(
    !unauthenticated.calls.some(([tool]) => tool === "subagents_create_agent"),
    "no create call without an authenticated email",
  );
  assert.ok(
    unauthenticated.notifications.some(
      ([message, kind]) =>
        kind === "error" && /Your authenticated email is unavailable/.test(message),
    ),
    "the fail-closed reason is surfaced",
  );
  assert.notEqual(
    unauthenticated.editorHost.style.display,
    "none",
    "the editor stays open so the user can react",
  );

  // Authenticated but the identity is a bare handle (no "@"): it cannot be
  // used as an allow-list email, so the same fail-closed path fires.
  const bareHandle = loadAgentsModuleHarness({
    agents: [ownedAgent()],
    currentUser: { authenticated: true, email: "dsantiago" },
  });
  await bareHandle.window.AgentsTabModule.loadMyAgents();
  await settle();
  bareHandle.elements.get("agents-tab-new-agent-btn").click();
  await settle();
  fillAgentEditorForm(bareHandle.editorHost, {
    name: "Round5 Restricted Agent",
    allowedEmails: "teammate@example.invalid",
  });
  bareHandle.editorHost.querySelector(".agents-modal-submit").click();
  await settle();
  assert.ok(
    !bareHandle.calls.some(([tool]) => tool === "subagents_create_agent"),
    "a non-email identity is rejected",
  );
  assert.ok(
    bareHandle.notifications.some(
      ([message, kind]) =>
        kind === "error" && /Your authenticated email is unavailable/.test(message),
    ),
  );

  // Public agents (no allow list) don't need the creator email at all.
  fillAgentEditorForm(bareHandle.editorHost, {
    name: "Round5 Public Agent",
    allowedEmails: "",
  });
  bareHandle.editorHost.querySelector(".agents-modal-submit").click();
  await settle();
  const publicCreate = bareHandle.calls.find(
    ([tool]) => tool === "subagents_create_agent",
  );
  assert.ok(publicCreate, "public creates proceed without an authenticated email");
  assert.deepEqual([...publicCreate[1].allowed_emails], []);
});

test("card clicks route by provenance: installed copies open read-only, owned and unlinked agents open the editor", async () => {
  const { window, editorHost } = loadAgentsModuleHarness({
    agents: [
      ownedAgent(),
      ownedAgent({
        id: "agent-installed",
        name: "Installed Agent",
        creation_source: "marketplace",
        marketplace_relationship: "installed",
        marketplace_solution_id: "sol-inst",
        created_by_email: "someoneelse",
      }),
      ownedAgent({
        id: "agent-linked",
        name: "Linked Agent",
        marketplace_relationship: "published",
        marketplace_solution_id: "sol-owned",
      }),
      ownedAgent({
        id: "agent-foreign",
        name: "Foreign Agent",
        marketplace_relationship: "published",
        marketplace_solution_id: "sol-foreign",
        created_by_email: "someoneelse@example.invalid",
      }),
    ],
    marketplaceLinks: { "agent-linked": { solutionId: "sol-owned" } },
  });
  const hooks = window.AgentsTabRenderHooks;
  await window.AgentsTabModule.loadMyAgents();
  await settle();
  const contentEl = editorHost.querySelector("[data-agent-editor-content]");

  // Marketplace-installed copy: read-only page.
  contentEl.innerHTML = "";
  await hooks.openAgentPageForCard("agent-installed");
  await settle();
  assert.match(contentEl.innerHTML, /data-readonly="true"/, "installed copies open read-only");
  assert.doesNotMatch(editorHost.innerHTML, /Edit Installed Agent/);

  // Unlinked local agent: straight to the editor, no identity lookup needed.
  await hooks.openAgentPageForCard("agent-1");
  await settle();
  assert.match(editorHost.innerHTML, /Edit Base Agent/, "unlinked local agents are editable");
  assert.match(editorHost.innerHTML, /class="agents-form/);

  // Published agent the viewer owns (viewer identity resolves via getUsername
  // fallback → "dsantiago", creator normalizes to the same bare handle).
  await hooks.openAgentPageForCard("agent-linked");
  await settle();
  assert.match(editorHost.innerHTML, /Edit Linked Agent/, "owned published agents are editable");

  // Published agent someone else authored: read-only page.
  contentEl.innerHTML = "";
  await hooks.openAgentPageForCard("agent-foreign");
  await settle();
  assert.match(contentEl.innerHTML, /data-readonly="true"/, "foreign agents open read-only");
  assert.doesNotMatch(editorHost.innerHTML, /Edit Foreign Agent/);
});

test("agent saves are strictly local: no sync opt-in, update-only IPC, linked saves mark the link dirty", async () => {
  const { window, calls, marketplaceCalls, notifications, editorHost } =
    loadAgentsModuleHarness({
      agents: [
        ownedAgent({
          id: "agent-linked",
          name: "Linked Agent",
          marketplace_relationship: "published",
          marketplace_solution_id: "sol-owned",
        }),
      ],
      marketplaceLinks: { "agent-linked": { solutionId: "sol-owned" } },
    });
  const hooks = window.AgentsTabRenderHooks;
  await window.AgentsTabModule.loadMyAgents();
  await settle();

  await hooks.openAgentPageForCard("agent-linked");
  await settle();
  // The old marketplace-sync opt-in is gone for good: saving can never write
  // to the marketplace copy (Republish is the only path).
  assert.doesNotMatch(editorHost.innerHTML, /Also sync the marketplace copy you own/);
  assert.doesNotMatch(editorHost.innerHTML, /sync_marketplace/);
  assert.doesNotMatch(editorHost.innerHTML, /if you do not own it, a fork will be published/);

  fillAgentEditorForm(editorHost, { name: "Linked Agent Prime" });
  editorHost.querySelector(".agents-modal-submit").click();
  await settle();

  const updateCall = calls.find(([tool]) => tool === "subagents_update_agent");
  assert.ok(updateCall, "save updates the local agent");
  assert.equal(updateCall[1].model_id, "agent-linked");
  assert.equal(updateCall[1].name, "Linked Agent Prime");
  assert.ok(
    !calls.some(([tool]) => /publish/i.test(String(tool))),
    "no marketplace publish IPC fires on save",
  );
  // The linked copy is now behind the local one: the link gets dirty-marked so
  // the card shows "Unpublished changes" (registry round-trip behavior is
  // covered by the marketplace-links tests).
  assert.deepEqual(marketplaceCalls, [["markLinkDirty", "agent-linked"]]);
  assert.ok(
    notifications.some(([message, kind]) => kind === "success" && message === "Agent updated."),
  );
});

test("agent search matches title and author only — never the description", async () => {
  const { window } = loadAgentsModuleHarness({ agents: [] });
  const hooks = window.AgentsTabRenderHooks;
  const agents = [
    {
      name: "Alpha Agent",
      description: "zebra sightings dispatcher",
      created_by_email: "dsantiago@example.invalid",
    },
    {
      name: "Beta Agent",
      description: "plain",
      created_by_email: "someoneelse@example.invalid",
    },
  ];

  const names = (query) => hooks.filterAgents(agents, query).map((a) => a.name);

  assert.deepEqual(names("zebra"), [], "descriptions never match");
  assert.deepEqual(names("alpha"), ["Alpha Agent"], "titles match");
  assert.deepEqual(names("someoneelse"), ["Beta Agent"], "author handles match");
  assert.deepEqual(
    names("someoneelse@example.invalid"),
    ["Beta Agent"],
    "full author emails match too",
  );
});

test("capability pickers force-refresh their options every time they open", async () => {
  const { window, body, editorHost } = loadAgentsModuleHarness({
    agents: [ownedAgent()],
  });
  const skillsCatalog = [
    { id: "old-skill", display_name: "Old Skill", source: "user" },
  ];
  let getSkillsCalls = 0;
  window.electronAPI.getSkills = async () => {
    getSkillsCalls += 1;
    return { success: true, skills: skillsCatalog };
  };
  await window.AgentsTabModule.loadMyAgents();
  await settle();
  await window.AgentsTabRenderHooks.openAgentPageForCard("agent-1");
  await settle();
  const callsAtEditorOpen = getSkillsCalls;
  assert.ok(callsAtEditorOpen >= 1, "editor open loads the catalog");

  // A new skill lands on disk (e.g. created in Chat) AFTER the editor opened
  // — the picker must surface it without reopening the editor.
  skillsCatalog.push({
    id: "weekly-team-update-sample",
    display_name: "Weekly Team Update Sample",
    source: "user",
  });

  const picker = editorHost.querySelector('[data-picker-kind="skills"]');
  picker.dataset.selected = JSON.stringify(["old-skill"]);
  picker.querySelector("[data-picker-toggle]").click();
  await settle();

  assert.ok(
    getSkillsCalls > callsAtEditorOpen,
    "opening the picker force-refreshes the catalog",
  );
  const popover = body.children.find((el) =>
    String(el.className || "").includes("agent-capability-popover"),
  );
  assert.ok(popover, "the picker popover mounted");
  assert.match(
    popover.querySelector(".agent-capability-list").innerHTML,
    /Weekly Team Update Sample/,
    "freshly created skills appear in the reopened picker",
  );
  assert.deepEqual(
    JSON.parse(picker.dataset.selected),
    ["old-skill"],
    "the current selection survives the refresh",
  );
});

// ---------------------------------------------------------------------------
// Republish implies Save (round 7): publishing from a dirty edit page runs
// the same wrapped save first, so the publish flow reads fresh data.
// ---------------------------------------------------------------------------

function republishHarness() {
  const h = loadAgentsModuleHarness({
    agents: [ownedAgent({ marketplace_solution_id: "sol-1", marketplace_relationship: "published" })],
    marketplaceLinks: { "agent-1": { solutionId: "sol-1" } },
    currentUser: { authenticated: true, email: "dsantiago@example.invalid" },
  });
  // Publish-flow probe: the api-key gate fails closed with a distinctive
  // notification, proving publishAgent was ENTERED without needing the whole
  // modal machinery.
  h.window.electronAPI.aiMarketplace.hasApiKey = async () => ({ hasKey: false });
  return h;
}

const API_KEY_GATE = /Set the AI Marketplace API key in Settings before publishing/;

test("Republish on a dirty edit page saves first, then enters the publish flow", async () => {
  const h = republishHarness();
  await h.window.AgentsTabModule.loadMyAgents();
  await settle();
  await h.window.AgentsTabRenderHooks.openAgentPageForCard("agent-1");
  await settle();

  fillAgentEditorForm(h.editorHost, { name: "Republish Draft" });
  h.elements.get("agents-tab-list").dispatchEvent(
    "click",
    listClickEvent(actionButton({ classes: ["agent-publish-btn"], agentId: "agent-1" })),
  );
  await settle(20);

  const updateIdx = h.calls.findIndex(([tool]) => tool === "subagents_update_agent");
  assert.ok(updateIdx >= 0, "the dirty edit was saved");
  assert.equal(h.calls[updateIdx][1].name, "Republish Draft");
  assert.ok(
    h.calls.slice(updateIdx + 1).some(([tool]) => tool === "subagents_get_agent"),
    "the publish flow re-read the agent AFTER the save",
  );
  assert.ok(h.notifications.some(([m]) => m === "Agent updated."));
  assert.ok(
    h.notifications.some(([m]) => API_KEY_GATE.test(m)),
    "the publish flow was entered after saving",
  );
});

test("edit-page header actions run Chat, Republish, Unpublish, Duplicate, Delete", async () => {
  const h = republishHarness();
  await h.window.AgentsTabModule.loadMyAgents();
  await settle();
  await h.window.AgentsTabRenderHooks.openAgentPageForCard("agent-1");
  await settle();

  assert.match(
    h.editorHost.innerHTML,
    /agent-use-btn[\s\S]*?agent-publish-btn[\s\S]*?agent-unpublish-btn[\s\S]*?agent-clone-btn[\s\S]*?agent-delete-btn/,
    "lifecycle actions precede Duplicate; Delete stays last",
  );
});

test("the editor footer offers Save and republish beside Save changes (linked agent)", async () => {
  const h = republishHarness();
  await h.window.AgentsTabModule.loadMyAgents();
  await settle();
  await h.window.AgentsTabRenderHooks.openAgentPageForCard("agent-1");
  await settle();

  // The combo button sits AFTER Save changes and reuses the delegated
  // agent-publish-btn class — one click saves the dirty edit, then enters
  // the same publish flow the header button uses.
  assert.match(
    h.editorHost.innerHTML,
    /agents-modal-submit" type="button">Save changes<\/button>\s*<button class="btn-primary agents-footer-publish-btn agent-publish-btn" type="button" data-agent-id="agent-1"[\s\S]*?Save and republish/,
  );
});

test("Republish aborts when the dirty save fails validation", async () => {
  const h = republishHarness();
  await h.window.AgentsTabModule.loadMyAgents();
  await settle();
  await h.window.AgentsTabRenderHooks.openAgentPageForCard("agent-1");
  await settle();

  // Dirty the form but blank the required name so the save fails validation.
  const form = h.editorHost.querySelector(".agents-form");
  fillAgentEditorForm(h.editorHost, { name: "" });
  form.formEntries = [["name", ""]];
  const nameInput = h.editorHost.querySelector('input[name="name"]');
  nameInput.value = "";
  form.querySelector('[name="name"]').value = "";
  form.querySelector('[name="name"]').focus = () => {};
  nameInput.focus = () => {};

  h.elements.get("agents-tab-list").dispatchEvent(
    "click",
    listClickEvent(actionButton({ classes: ["agent-publish-btn"], agentId: "agent-1" })),
  );
  await settle(20);

  assert.ok(
    !h.calls.some(([tool]) => tool === "subagents_update_agent"),
    "no save happened",
  );
  assert.ok(
    !h.notifications.some(([m]) => API_KEY_GATE.test(m)),
    "the publish flow never started",
  );
});

test("Republish on a clean edit page publishes directly without a save", async () => {
  const h = republishHarness();
  await h.window.AgentsTabModule.loadMyAgents();
  await settle();
  await h.window.AgentsTabRenderHooks.openAgentPageForCard("agent-1");
  await settle();

  h.elements.get("agents-tab-list").dispatchEvent(
    "click",
    listClickEvent(actionButton({ classes: ["agent-publish-btn"], agentId: "agent-1" })),
  );
  await settle(20);

  assert.ok(
    !h.calls.some(([tool]) => tool === "subagents_update_agent"),
    "no save for a clean editor",
  );
  assert.ok(
    h.notifications.some(([m]) => API_KEY_GATE.test(m)),
    "the publish flow was entered directly",
  );
});

// ---------------------------------------------------------------------------
// Local agent warning flags (SKILLS_NOT_FOUND): card badge + detail surfaces.
// Display-only local state — never an input to stale/dirty logic.
// ---------------------------------------------------------------------------

test("flagged agents render the warning badge on cards; unflagged agents do not", async () => {
  const flags = {
    "agent-1": [
      {
        type: "SKILLS_NOT_FOUND",
        skills: ["gone-skill"],
        firstSeen: 1,
        lastSeen: 1,
      },
    ],
  };
  const { window, elements } = loadAgentsModuleHarness({
    agents: [
      ownedAgent(),
      ownedAgent({ id: "agent-2", name: "Clean Agent" }),
    ],
    agentFlags: flags,
  });
  await window.AgentsTabModule.loadMyAgents();
  await settle();

  const listHtml = elements.get("agents-tab-list").innerHTML;
  assert.match(listHtml, /badge-agent-warning/);
  assert.match(listHtml, /no longer available on this computer/);

  const render = window.AgentCardRenderer.buildAgentCardHtml;
  const cleanHtml = render(ownedAgent({ id: "agent-2", name: "Clean Agent" }));
  assert.doesNotMatch(cleanHtml, /badge-agent-warning/);
});

test("the installed read-only view stacks the warning pane and marks flagged skill rows", async () => {
  const { window } = loadAgentsModuleHarness({ agents: [] });
  await settle();
  window.AgentsTabRenderHooks.setAgentLocalFlagsForTests({
    "agent-ro": [
      {
        type: "SKILLS_NOT_FOUND",
        skills: ["mp/plugin/gone-skill"],
        firstSeen: 1,
        lastSeen: 1,
      },
    ],
  });

  const installedAgent = {
    id: "agent-ro",
    name: "RO Agent",
    description: "Installed copy",
    base_model_id: "gpt-5",
    skill_ids: ["gone-skill", "healthy-skill"],
    tool_server_ids: [],
    allowed_emails: [],
    system_prompt: "You are a fixture.",
    created_by_email: "owner@example.invalid",
    marketplace_relationship: "installed",
    marketplace_solution_id: "sol-ro",
    is_read_only: true,
  };
  const html = window.AgentsTabRenderHooks.buildInstalledAgentViewHtml(
    installedAgent,
    { skills: [] },
  );

  // Pastel warning pane stacked under the blue read-only pane, in order.
  assert.match(html, /marketplace-readonly-pane[\s\S]*marketplace-warning-pane/);
  assert.match(html, /There are warnings for this agent/);
  // The flagged row carries the warning note; the healthy row keeps the
  // ordinary missing note (no catalog in this fixture).
  assert.match(html, /data-skill="gone-skill"[\s\S]*?No longer available — owner must republish/);
  assert.match(html, /data-skill="healthy-skill"[\s\S]*?Not on this computer/);

  // No flags → neither surface renders.
  window.AgentsTabRenderHooks.setAgentLocalFlagsForTests({});
  const cleanHtml = window.AgentsTabRenderHooks.buildInstalledAgentViewHtml(
    installedAgent,
    { skills: [] },
  );
  assert.doesNotMatch(cleanHtml, /marketplace-warning-pane/);
  assert.doesNotMatch(cleanHtml, /owner must republish/);
});

test("warning flags never feed staleness: an agent with flags and no listing drift reads as up to date", async () => {
  const { window } = loadAgentsModuleHarness({ agents: [] });
  await settle();
  window.AgentsTabRenderHooks.setAgentLocalFlagsForTests({
    "agent-1": [
      { type: "SKILLS_NOT_FOUND", skills: ["gone-skill"], firstSeen: 1, lastSeen: 1 },
    ],
  });
  const agent = ownedAgent({
    marketplace_relationship: "installed",
    marketplace_solution_id: "sol-1",
  });
  assert.equal(window.AgentsTabRenderHooks.agentUpdateAvailable(agent), false);
  const cardHtml = window.AgentCardRenderer.buildAgentCardHtml(agent);
  assert.doesNotMatch(cardHtml, /update-available/);
});
