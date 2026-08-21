// Marketplace requirements audit — behavioral edition.
// Chat UI + IPC/Communication + Agent Skills layers.
//
// Each "requirement N" test drives the REAL renderer/service code through a
// harness (vm-loaded agents.js with a FakeElement DOM, esbuild-bundled
// agent-skills.js, Module._load-stubbed ipc.js) and asserts observable
// behavior: rendered HTML, recorded IPC/marketplace calls, thrown errors.
// Static data contracts (MCP tool_spec.json, index.html markup) are asserted
// as parsed data, not as source-text regexes.
//
// Deleted pin groups (no Node-side behavioral surface here):
// - requirement 3c (Chat.svelte URL-selected agent resolution) and 3d
//   (ModelSelector Selector.svelte loading state): Chat UI layer, OWUI
//   frontend Svelte — verified by the OWUI frontend harness tests and live
//   visual QA of the chat webview.
// - requirement 3e Rust halves (subagents.rs create/update access_control
//   omission, health-check app.rs agent writers): Agent Skills / Health Check
//   layers — verified by cargo tests in src/core-mcp-rust and
//   src/mcp-orc-rust. The Node-side halves (repair IPC + renderer repair
//   triggers) are covered behaviorally below.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");

const servicesDir = __dirname;
const componentsDir = path.join(servicesDir, "..", "renderer", "components");

function readRepoFile(...segments) {
  return fs.readFileSync(path.join(servicesDir, ...segments), "utf8");
}

// ============================================================================
// Harness: FakeElement DOM + vm-loaded agents.js
// (self-contained per repo convention; mirrors agents-tab-card-tooltips /
// agents-dependent-skill-publish harnesses, extended with memoized
// querySelector children so openModal/inline-editor wiring works.)
// ============================================================================

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
    const target = force ?? !this.classes.has(name);
    if (target) this.classes.add(name);
    else this.classes.delete(name);
    return target;
  }
}

class FakeElement {
  constructor(id = "", doc = null) {
    this.id = id;
    this.ownerDocument = doc;
    this.style = { display: "none" };
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.attributes = new Map();
    this.innerHTML = "";
    this._textContent = "";
    this.dataset = {};
    this.value = "";
    this.disabled = false;
    this.hidden = false;
    this.children = [];
    this.selectorChildren = new Map();
    this.selectorLists = new Map();
    this.isConnected = false;
    this.scrollTop = 0;
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  removeEventListener() {}
  dispatchEvent(eventOrType, extra = {}) {
    const type =
      typeof eventOrType === "string" ? eventOrType : eventOrType?.type;
    const eventProps = typeof eventOrType === "object" ? eventOrType : extra;
    for (const handler of this.listeners.get(type) || []) {
      handler({
        preventDefault() {},
        stopPropagation() {},
        target: this,
        currentTarget: this,
        ...eventProps,
      });
    }
    return true;
  }
  click() {
    this.dispatchEvent("click");
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  // DOM-parity: assigning textContent renders escaped text into innerHTML
  // (agent-skills' escapeHtml round-trips a detached div through textContent).
  get textContent() {
    return this._textContent || "";
  }
  set textContent(value) {
    this._textContent = String(value ?? "");
    this.innerHTML = this._textContent
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  // Memoized per-selector child: the wiring code queries a selector, attaches
  // listeners, and later code paths re-query the same selector to drive it.
  querySelector(selector) {
    if (!this.selectorChildren.has(selector)) {
      const child = new FakeElement("", this.ownerDocument);
      child.parentElement = this;
      this.selectorChildren.set(selector, child);
    }
    return this.selectorChildren.get(selector);
  }
  // Registered lists only; unknown selectors wire nothing (delegated card
  // menus etc. stay inert unless a test registers buttons for them).
  querySelectorAll(selector) {
    return this.selectorLists.get(selector) || [];
  }
  registerQueryList(selector, elements) {
    this.selectorLists.set(selector, elements);
  }
  appendChild(child) {
    this.children.push(child);
    if (child && typeof child === "object") {
      child.parentElement = this;
      if (child.id && this.ownerDocument) {
        this.ownerDocument._registry.set(child.id, child);
      }
    }
    return child;
  }
  remove() {
    if (this.id && this.ownerDocument) {
      this.ownerDocument._registry.delete(this.id);
    }
    if (this.parentElement) {
      const siblings = this.parentElement.children;
      const index = siblings.indexOf(this);
      if (index >= 0) siblings.splice(index, 1);
    }
  }
  insertAdjacentHTML() {}
  closest() {
    return null;
  }
  contains() {
    return false;
  }
  focus() {}
  select() {}
  getBoundingClientRect() {
    return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
}

function createFakeDocument() {
  const registry = new Map();
  const queryLists = new Map();
  const doc = {
    readyState: "complete",
    _registry: registry,
    createElement(tag) {
      return new FakeElement(String(tag || ""), doc);
    },
    getElementById(id) {
      if (!registry.has(id)) registry.set(id, new FakeElement(id, doc));
      return registry.get(id);
    },
    querySelector: () => null,
    querySelectorAll: (selector) => queryLists.get(selector) || [],
    // Document-level selector lists must be registered BEFORE the component
    // loads when its init() wires them (e.g. the Agents mode tabs).
    registerQueryList: (selector, elements) => {
      queryLists.set(selector, elements);
    },
    addEventListener() {},
    removeEventListener() {},
  };
  doc.body = new FakeElement("body", doc);
  doc.documentElement = new FakeElement("html", doc);
  return doc;
}

function loadAgentsModuleHarness() {
  const source = fs.readFileSync(path.join(componentsDir, "agents.js"), "utf8");
  const extraSources = [
    "agent-reasoning-options.js",
    "agent-model-picker.js",
    "agent-reasoning-slider.js",
  ].map((name) => ({
    path: path.join(componentsDir, name),
    source: fs.readFileSync(path.join(componentsDir, name), "utf8"),
  }));

  const document = createFakeDocument();
  const windowObject = {
    appState: {
      controlPlaneView: "agents-tab",
      servers: [],
      toggles: {},
      healthStatus: { servers: {} },
    },
    innerWidth: 1440,
    innerHeight: 900,
    confirm: () => false,
    localStorage: (() => {
      const store = new Map();
      return {
        getItem: (key) => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => store.set(key, String(value)),
        removeItem: (key) => store.delete(key),
      };
    })(),
    electronAPI: {
      invokeMcpTool: async () => ({ success: true, data: { agents: [] } }),
      getSkills: async () => ({ success: true, skills: [] }),
      loadMcpServers: async () => ({ success: true, data: [] }),
      aiMarketplace: {
        listLinks: async () => ({ success: true, links: {} }),
      },
    },
    showNotification() {},
  };

  const context = {
    window: windowObject,
    document,
    console,
    setTimeout,
    clearTimeout,
    Math,
    Date,
    Promise,
    JSON,
    HTMLElement: FakeElement,
    CustomEvent: class CustomEvent {
      constructor(type, options = {}) {
        this.type = type;
        this.detail = options.detail;
      }
    },
    Event: class Event {
      constructor(type, options = {}) {
        this.type = type;
        this.bubbles = Boolean(options.bubbles);
      }
    },
    MutationObserver: class MutationObserver {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame: (cb) => {
      cb();
      return 0;
    },
    encodeURIComponent,
    URL,
  };
  context.globalThis = context;

  for (const extra of extraSources) {
    vm.runInNewContext(extra.source, context, { filename: extra.path });
  }
  vm.runInNewContext(source, context, {
    filename: path.join(componentsDir, "agents.js"),
  });

  return { window: windowObject, document };
}

// Recording fake for the electronAPI surface the agents flows touch. `calls`
// captures [name, ...args] tuples in invocation order.
function installMarketplaceFixture(windowObject, {
  agents = [],
  baseModels = [],
  agentById = null,
  systemPromptById = {},
  skills = [],
  mcpServers = [],
  links = {},
  skillLinks = {},
  ownedSolutions = [],
  installedSources = {},
  searchResults = [],
  bundlesBySolutionId = {},
  solutionsById = {},
  hasApiKey = true,
  currentUserEmail = "dsantiago@example.invalid",
  publishImpl = null,
  updateImpl = null,
  installImpl = null,
  deleteImpl = null,
  getSolutionImpl = null,
  invokeMcpToolImpl = null,
  deleteAgentImpl = null,
} = {}) {
  const calls = [];
  const notifications = [];
  const logToMainEvents = [];
  const agentsById =
    agentById ||
    Object.fromEntries(
      agents.filter(Boolean).map((agent) => [agent.id, agent]),
    );

  const api = {
    hasApiKey: async () => {
      calls.push(["hasApiKey"]);
      return { hasKey: hasApiKey };
    },
    listLinks: async () => {
      calls.push(["listLinks"]);
      return { success: true, links };
    },
    getSolution: async (solutionId) => {
      calls.push(["getSolution", solutionId]);
      if (getSolutionImpl) return getSolutionImpl(solutionId);
      const solution = solutionsById[solutionId];
      // Default ACTIVE: clean-link liveness probes at publish time must see
      // a live listing unless a test opts into a tombstone via
      // solutionsById/getSolutionImpl.
      return solution
        ? { success: true, data: solution }
        : { success: true, data: { id: solutionId, status: "active" } };
    },
    getBundle: async (solutionId) => {
      calls.push(["getBundle", solutionId]);
      return (
        bundlesBySolutionId[solutionId] || { success: false, error: "no bundle" }
      );
    },
    search: async (params) => {
      calls.push(["search", params]);
      return { success: true, data: { results: searchResults } };
    },
    buildPublishBundle: async (input) => {
      if (input?.type === "skills") {
        calls.push(["buildPublishBundle", input?.skill?.name, input]);
        return {
          success: true,
          data: {
            type: "skills",
            payload: { name: input?.skill?.name, description: "d" },
          },
        };
      }
      calls.push(["buildAgentBundle", input?.agent]);
      return {
        success: true,
        data: {
          type: input?.type,
          payload: { name: input?.agent?.name, description: "agent bundle" },
        },
      };
    },
    publish: async (input, opts) => {
      calls.push(["publish", input, opts]);
      if (publishImpl) return publishImpl(input, opts);
      return {
        success: true,
        data: { id: `new-${input?.name}` },
        publishStatus: { id: `new-${input?.name}`, status: "active" },
      };
    },
    update: async (solutionId, input, opts) => {
      calls.push(["update", solutionId, input, opts]);
      if (updateImpl) return updateImpl(solutionId, input, opts);
      return {
        success: true,
        data: { id: solutionId },
        publishStatus: { id: solutionId, status: "active" },
      };
    },
    delete: async (solutionId) => {
      calls.push(["delete", solutionId]);
      if (deleteImpl) return deleteImpl(solutionId);
      return { success: true, data: { id: solutionId, status: "deleted" } };
    },
    install: async (solutionId, options) => {
      calls.push(["install", solutionId, options]);
      if (installImpl) return installImpl(solutionId, options);
      return { success: true, data: { type: "" } };
    },
    getSkillLink: async (name) => {
      calls.push(["getSkillLink", name]);
      return { success: true, link: skillLinks[name] || null };
    },
    setSkillLink: async (name, solutionId) => {
      calls.push(["setSkillLink", name, solutionId]);
      return { success: true };
    },
    clearSkillLink: async (name) => {
      calls.push(["clearSkillLink", name]);
      return { success: true };
    },
    getInstalledSkillSource: async (name) => {
      calls.push(["getInstalledSkillSource", name]);
      return { success: true, source: installedSources[name] || null };
    },
    clearLink: async (agentId) => {
      calls.push(["clearLink", agentId]);
      return { success: true };
    },
    markLinkDirty: async (agentId) => {
      calls.push(["markLinkDirty", agentId]);
      return { success: true };
    },
    repairLinkedAgentAccess: async (options) => {
      calls.push(["repairLinkedAgentAccess", options?.reason || ""]);
      return {
        success: true,
        result: { checked: 0, repaired: 0, repairedAgentIds: [] },
      };
    },
    listPublished: async (type) => {
      calls.push(["listPublished", type]);
      return { success: true, data: { solutions: ownedSolutions } };
    },
    listSkillLinks: async () => {
      calls.push(["listSkillLinks"]);
      return { success: true, links: skillLinks };
    },
    markSkillLinkDirty: async (name) => {
      calls.push(["markSkillLinkDirty", name]);
      if (skillLinks[name]) skillLinks[name].hasLocalChanges = true;
      return { success: true };
    },
  };

  windowObject.electronAPI = {
    invokeMcpTool: async (serverId, tool, input) => {
      calls.push(["invokeMcpTool", serverId, tool, input]);
      if (invokeMcpToolImpl) {
        const result = await invokeMcpToolImpl(serverId, tool, input);
        if (result !== undefined) return result;
      }
      if (tool === "subagents_list_agents") {
        return {
          success: true,
          data: {
            agents: input?.filter_type === "base" ? baseModels : agents,
          },
        };
      }
      if (tool === "subagents_get_agent") {
        return { success: true, data: agentsById[input?.model_id] || null };
      }
      if (tool === "subagents_get_agent_system_prompt") {
        return {
          success: true,
          data: {
            system_prompt:
              systemPromptById[input?.model_id] ?? "You are helpful.",
          },
        };
      }
      if (tool === "subagents_delete_agent") {
        if (deleteAgentImpl) return deleteAgentImpl(input);
        return { success: true, data: { success: true } };
      }
      return { success: true, data: {} };
    },
    getSkills: async () => {
      calls.push(["getSkills"]);
      return { success: true, skills };
    },
    loadMcpServers: async () => ({ success: true, data: mcpServers }),
    getUsername: async () => ({ username: "dsantiago" }),
    currentUser: {
      get: async () => ({
        authenticated: true,
        sessionSummary: { user: { email: currentUserEmail } },
      }),
    },
    logToMain: (payload) => {
      logToMainEvents.push(payload);
    },
    openExternal: () => {},
    aiMarketplace: api,
  };
  windowObject.showNotification = (message, kind = "info") => {
    notifications.push([kind, message]);
  };
  return { api, calls, notifications, logToMainEvents };
}

const localAgent = (id, extra = {}) => ({
  id,
  name: extra.name || id,
  description: extra.description || `${id} description`,
  base_model_id: "atlas-sonnet-5",
  system_prompt: `You are ${id}.`,
  skill_ids: [],
  tool_server_ids: [],
  creation_source: "local",
  created_by_email: "dsantiago@example.invalid",
  ...extra,
});

const userSkill = (name) => ({
  name,
  source: "user",
  skill_path: `/tmp/skills-user/${name}`,
  description: `${name} description`,
});

async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// ============================================================================
// Requirement 1: new agents support skills, MCP servers, model, prompt, and
// allowed emails — the real editor form renders an input surface for all five.
// (The create submit path itself needs a real DOM FormData; its id/field
// contract on the MCP wire is covered behaviorally in
// ai-marketplace-operations.unit.test.js "agent read tools are called with
// model_id, never agent_id" and by the create_skill/create_agent tool specs
// below.)
// ============================================================================

test("requirement 1: the agent editor form renders skills, MCP servers, model, prompt, and allowed-emails fields", () => {
  const { window } = loadAgentsModuleHarness();
  installMarketplaceFixture(window, {});

  const html = window.AgentsPublishHooks.buildAgentForm(
    {
      name: "Research assistant",
      description: "Helps with research",
      allowed_emails: ["teammate@example.invalid", "TEAMMATE@example.invalid"],
      base_model_id: "atlas-sonnet-5",
      system_prompt: "Do research.",
      skill_ids: ["notes"],
      tool_server_ids: ["glean"],
    },
    {
      baseModels: [{ id: "atlas-sonnet-5", display_name: "Atlas Sonnet 5" }],
      skills: [{ id: "notes", display_name: "Notes", description: "" }],
      toolServers: [
        { id: "server:glean", display_name: "Glean", description: "" },
      ],
    },
  );

  // Identity + access: renames allowed (never readonly), allowed emails with
  // guidance and an inline error slot, values normalized/deduped.
  assert.match(html, /<input[^>]*name="name"[^>]*value="Research assistant"/);
  assert.doesNotMatch(html, /<input[^>]*name="name"[^>]*readonly/);
  assert.match(html, /<span>Allowed emails<\/span>/);
  assert.match(
    html,
    /Comma or newline separated\. Leave blank to make the marketplace copy visible to everyone\./,
  );
  assert.match(html, /data-agent-error="allowed_emails"/);
  const allowedEmailsValue = html.match(
    /name="allowed_emails"[^>]*>\s*([^<]*)</,
  )?.[1];
  assert.equal(allowedEmailsValue.trim(), "teammate@example.invalid");

  // Model + behavior: the shared model picker field and the system prompt.
  assert.match(html, /<div class="agents-form-label">Base model \*<\/div>/);
  assert.match(html, /data-agent-model-picker data-current-value="atlas-sonnet-5"/);
  assert.match(html, /name="system_prompt"/);
  assert.match(html, /data-agent-error="base_model_id"/);

  // Capabilities: both pickers render with the agent's current selection
  // encoded where readPickerSelection reads it back at submit time.
  assert.match(
    html,
    /data-picker-kind="skills" data-selected='\[&quot;notes&quot;\]'/,
  );
  assert.match(
    html,
    /data-picker-kind="tool_server_ids" data-selected='\[&quot;server:glean&quot;\]'/,
  );
  assert.match(html, /<span class="agents-picker-label">Skills<\/span>/);
  assert.match(html, /<span class="agents-picker-label">MCP servers<\/span>/);
});

test("agent tool contract keeps attribution app-owned and documents is_local semantics", () => {
  const subagentsToolSpec = JSON.parse(
    readRepoFile(
      "..",
      "..",
      "..",
      "src",
      "core-mcp-rust",
      "crates",
      "subagents-server",
      "tool_spec.json",
    ),
  );
  const byName = new Map(subagentsToolSpec.map((tool) => [tool.name, tool]));
  assert.equal(
    Object.hasOwn(byName.get("create_agent").inputSchema.properties, "created_by_email"),
    false,
  );
  assert.equal(byName.has("reconcile_agent_attribution"), true);
  assert.match(byName.get("list_agents").description, /is_local field describes only/);
  assert.match(byName.get("list_agents").description, /creation_source/);
  assert.match(byName.get("list_agents").description, /marketplace_relationship/);
});

// ============================================================================
// Requirement 1b: disabled base models cannot be selected and MCP tool errors
// are surfaced.
// ============================================================================

test("requirement 1b: MCP tool error envelopes surface their message instead of masquerading as data", async () => {
  const { window, document } = loadAgentsModuleHarness();
  installMarketplaceFixture(window, {
    invokeMcpToolImpl: (_serverId, tool) =>
      tool === "subagents_list_agents"
        ? {
            success: true,
            data: { is_error: true, message: "model registry is offline" },
          }
        : undefined,
  });

  await window.AgentsTabModule.loadMyAgents();

  const list = document.getElementById("agents-tab-list");
  assert.match(list.innerHTML, /Failed to load agents\./);
  assert.match(list.innerHTML, /model registry is offline/);
});

test("requirement 1b: catalog normalization marks disabled base models (a disabled_reason alone disables)", async () => {
  const { window } = loadAgentsModuleHarness();
  installMarketplaceFixture(window, {
    baseModels: [
      { id: "atlas-sonnet-5", name: "Atlas Sonnet 5" },
      { id: "gpt-5.6-sol-pro", name: "Sol Pro", disabled_reason: "High cost" },
      { id: "local/qwen", name: "Qwen", disabled: true },
    ],
  });

  await window.AgentsTabRenderHooks.loadCatalogsForTests({ force: true });
  const models = window.AgentsTabRenderHooks.baseModelsForTests();
  const byId = new Map(models.map((model) => [model.id, model]));

  assert.equal(byId.get("atlas-sonnet-5").disabled, false);
  assert.equal(byId.get("gpt-5.6-sol-pro").disabled, true);
  assert.equal(byId.get("gpt-5.6-sol-pro").disabled_reason, "High cost");
  assert.equal(byId.get("local/qwen").disabled, true);
});

test("requirement 1b: the model picker renders disabled rows unselectable and reports the disabled reason", () => {
  // The picker is a standalone CJS module — drive it directly with the same
  // FakeElement DOM the vm harness uses.
  const picker = require("../renderer/components/agent-model-picker");
  const doc = createFakeDocument();
  doc.defaultView = {
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 1440,
    innerHeight: 900,
  };
  const container = new FakeElement("picker-container", doc);
  container.dataset.currentValue = "";

  const instance = picker.mount(container, {
    models: [
      {
        id: "atlas-sonnet-5",
        display_name: "Atlas Sonnet 5",
        picker_provider: "anthropic",
        picker_tier: "general",
      },
      {
        id: "gpt-5.6-sol-pro",
        display_name: "Sol Pro",
        picker_provider: "openai",
        picker_tier: "premium",
        disabled: true,
        disabled_reason: "High cost",
      },
    ],
    value: "gpt-5.6-sol-pro",
  });

  // Rows render with the selectability contract the click handler enforces
  // (rows with aria-disabled="true" are ignored) and a stable model id.
  instance.open();
  const popover = doc.body.children.at(-1);
  const rows = popover.querySelector(".agent-model-picker-results").innerHTML;
  assert.match(
    rows,
    /aria-disabled="true"[^>]*data-model-id="gpt-5\.6-sol-pro"/s,
  );
  assert.match(
    rows,
    /aria-disabled="false"[^>]*data-model-id="atlas-sonnet-5"/s,
  );

  // A disabled current selection is reported unavailable with its reason —
  // this is what blocks the editor's submit with the
  // `Base model "<id>" is disabled: <reason>` field error.
  assert.equal(instance.isUnavailableSelection(), true);
  assert.equal(instance.getUnavailableReason(), "High cost");
});

// ============================================================================
// Requirement 2: control panel supports viewing agents in My Agents.
// ============================================================================

test("requirement 2: My Agents loads via the Subagents MCP, normalizes records, and renders the grid", async () => {
  const { window, document } = loadAgentsModuleHarness();
  const { calls } = installMarketplaceFixture(window, {
    agents: [
      localAgent("research-assistant", { name: "Research Assistant" }),
      localAgent("portico_agent_context_resolver", { name: "Internal Utility" }),
      null, // malformed rows are dropped, not rendered
    ],
  });

  await window.AgentsTabModule.loadMyAgents();

  const list = document.getElementById("agents-tab-list");
  assert.match(list.innerHTML, /Research Assistant/);
  // System-delivered agents never appear in the user-facing grid.
  assert.doesNotMatch(list.innerHTML, /Internal Utility/);
  // The load asked the Subagents MCP for the agent inventory.
  assert.ok(
    calls.some(
      (entry) =>
        entry[0] === "invokeMcpTool" &&
        entry[1] === "subagents" &&
        entry[2] === "subagents_list_agents",
    ),
  );
  // Loading My Agents repairs linked-agent access up front (requirement 3e).
  assert.ok(
    calls.some(
      (entry) =>
        entry[0] === "repairLinkedAgentAccess" && entry[1] === "load-my-agents",
    ),
  );
});

// ============================================================================
// Requirement 3: discover flow forwards viewer identity, installs agents,
// fails closed on non-owner edits, and supports chat use.
// The viewer-identity + install IPC forwarding is asserted in the
// "ipc: ai-marketplace handlers..." tests at the bottom of this file.
// ============================================================================

test("requirement 3: a rejected marketplace update fails closed without creating a second solution", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installMarketplaceFixture(window, {
    updateImpl: () => ({
      success: false,
      error: "You are not the owner",
      code: "not_owner",
      status: 403,
    }),
  });

  await assert.rejects(
    window.AgentsPublishHooks.pushAgentToMarketplace({
      localId: "agent-1",
      solutionId: "sol-linked",
      args: {
        name: "Agent One",
        description: "",
        base_model_id: "model-a",
        system_prompt: "prompt",
        skill_ids: [],
        tool_server_ids: [],
        reasoning_effort: null,
      },
    }),
    (error) => {
      assert.match(error.message, /You are not the owner/);
      assert.match(error.message, /code=not_owner/);
      return true;
    },
  );
  assert.ok(
    !calls.some((entry) => entry[0] === "publish"),
    "a rejected update must never fork a new solution",
  );
});

test("requirement 3: installSolution reports success/failure as a boolean and repairs installed-agent access", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls, notifications } = installMarketplaceFixture(window, {
    installImpl: async () => ({
      success: true,
      data: {
        type: "portico-agents",
        mutation: "created",
        created: localAgent("installed-agent", { name: "Installed Agent" }),
      },
    }),
  });

  const installed = await window.AgentsPublishHooks.installSolution("sol-1");

  assert.equal(installed, true, "successful installs report true");
  assert.ok(
    calls.some(
      (entry) => entry[0] === "install" && entry[1] === "sol-1",
    ),
  );
  assert.ok(
    calls.some(
      (entry) =>
        entry[0] === "repairLinkedAgentAccess" &&
        entry[1] === "install-solution",
    ),
    "agent installs run the access repair with the install-solution reason (requirement 3e)",
  );
  assert.ok(notifications.some(([kind]) => kind === "success"));

  // Failures surface as false so the Discover page keeps its modal open.
  const { window: window2 } = loadAgentsModuleHarness();
  installMarketplaceFixture(window2, {
    installImpl: async () => ({ success: false, error: "boom" }),
  });
  assert.equal(
    await window2.AgentsPublishHooks.installSolution("sol-1"),
    false,
    "failed installs report false",
  );
});

test("requirement 3: Use from chat opens a preconfigured chat tab when every MCP dependency is ready", async () => {
  const { window } = loadAgentsModuleHarness();
  installMarketplaceFixture(window, {
    agents: [
      localAgent("chat-ready", {
        name: "Chat Ready",
        tool_server_ids: ["server:glean"],
      }),
    ],
  });
  window.appState.servers = [{ id: "server:glean", name: "Glean" }];
  window.appState.healthStatus = {
    servers: { "server:glean": { status: "running" } },
  };
  const openedTabs = [];
  window.openNewChatTab = (options) => {
    openedTabs.push(options);
    return true;
  };

  await window.AgentsTabModule.loadMyAgents();
  window.AgentsTabModule.useAgentFromChat("chat-ready", "Chat Ready");

  assert.equal(openedTabs.length, 1);
  assert.equal(openedTabs[0].modelId, "chat-ready");
  assert.match(openedTabs[0].title, /Chat Ready/);
});

// ============================================================================
// Requirement 3b: Use from chat blocks until the agent's MCP servers are set
// up (no silent degrade into a plain model session).
// ============================================================================

async function driveUseFromChatGate({ servers, toggles, healthServers, agent }) {
  const { window, document } = loadAgentsModuleHarness();
  installMarketplaceFixture(window, { agents: [agent] });
  window.appState.servers = servers;
  window.appState.toggles = toggles;
  window.appState.healthStatus = { servers: healthServers };
  const openedTabs = [];
  window.openNewChatTab = (options) => {
    openedTabs.push(options);
    return true;
  };
  await window.AgentsTabModule.loadMyAgents();
  window.AgentsTabModule.useAgentFromChat(agent.id, agent.name);
  return { window, document, openedTabs };
}

test("requirement 3b: a not-installed MCP dependency blocks chat behind the setup modal", async () => {
  const { document, openedTabs } = await driveUseFromChatGate({
    servers: [],
    toggles: {},
    healthServers: {},
    agent: localAgent("gated", {
      name: "Gated",
      tool_server_ids: ["server:glean"],
    }),
  });

  assert.equal(openedTabs.length, 0, "chat must not open past the gate");
  const overlay = document.getElementById("agents-modal-overlay");
  assert.ok(overlay, "the setup modal opened");
  assert.match(overlay.innerHTML, /requires 1 MCP server/);
  assert.match(overlay.innerHTML, /Install, enable, or authenticate/);
  assert.match(overlay.innerHTML, /Set up servers/);
  assert.match(overlay.innerHTML, /Close/);
  // There is no bypass: the modal only offers setup or close.
  assert.doesNotMatch(overlay.innerHTML, /Use anyway/);

  // The setup action routes to the Integrations tab.
  let integrationsOpened = 0;
  document
    .getElementById("view-mcp-servers-btn")
    .addEventListener("click", () => {
      integrationsOpened += 1;
    });
  overlay.querySelector(".agents-modal-submit").click();
  await settle();
  assert.equal(integrationsOpened, 1);
  assert.equal(openedTabs.length, 0, "setup routing still never opens chat");
});

test("requirement 3b: needs_oauth and user-disabled servers gate chat; core servers never do", async () => {
  // Enabled but unauthenticated (needs_oauth) blocks.
  const oauthGate = await driveUseFromChatGate({
    servers: [{ id: "server:jira", name: "Jira" }],
    toggles: { "server:jira": true },
    healthServers: { "server:jira": { status: "needs_oauth" } },
    agent: localAgent("oauth-agent", {
      name: "OAuth Agent",
      tool_server_ids: ["server:jira"],
    }),
  });
  assert.equal(oauthGate.openedTabs.length, 0);
  assert.match(
    oauthGate.document.getElementById("agents-modal-overlay").innerHTML,
    /Jira/,
  );

  // Core servers are always available; nothing to set up.
  const coreOk = await driveUseFromChatGate({
    servers: [{ id: "server:skills", name: "Skills", isCore: true }],
    toggles: {},
    healthServers: {},
    agent: localAgent("core-agent", {
      name: "Core Agent",
      tool_server_ids: ["server:skills"],
    }),
  });
  assert.equal(coreOk.openedTabs.length, 1, "core-only agents chat freely");
});

// Requirement 3c (Chat.svelte URL-selected model resolution) and 3d
// (Selector.svelte workspace-agent loading state) are OWUI frontend Svelte
// behavior — verified by the OWUI frontend harness tests and live visual QA;
// no Node-side pin belongs here.

// ============================================================================
// Requirement 3e (Node halves): the repair IPC exists and the renderer
// triggers it on load and install (asserted in requirement 2 / requirement 3
// tests above and the ipc handler test below). The SQL semantics
// (`UPDATE model SET access_control = NULL` for linked agents only) run for
// real against SQLite in ai-marketplace-agent-access-repair.unit.test.js; the
// Rust writers are covered by cargo tests.
// ============================================================================

// ============================================================================
// Requirement 4: publishing agents preserves allowed-email visibility and
// marketplace ownership attribution.
// ============================================================================

test("requirement 4: publish sends normalized allowed emails and submitted_by on both create and update", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installMarketplaceFixture(window, {});

  const args = {
    name: "Agent One",
    description: "",
    base_model_id: "model-a",
    system_prompt: "prompt",
    allowed_emails: ["  TeamMate@example.invalid ", "teammate@example.invalid"],
    skill_ids: [],
    tool_server_ids: [],
    reasoning_effort: null,
  };

  // Create branch (no linked solution).
  await window.AgentsPublishHooks.pushAgentToMarketplace({
    localId: "agent-1",
    solutionId: "",
    args,
  });
  const publishCall = calls.find((entry) => entry[0] === "publish");
  assert.ok(publishCall, "unlinked publish creates a solution");
  assert.deepEqual(JSON.parse(JSON.stringify(publishCall[1].allowed_emails)), [
    "teammate@example.invalid",
  ]);
  assert.equal(publishCall[1].submitted_by, "dsantiago");
  assert.equal(publishCall[1].author, "dsantiago");
  assert.deepEqual(JSON.parse(JSON.stringify(publishCall[2])), {
    localAgentId: "agent-1",
  });

  // Update branch (linked solution) carries the same identity + visibility.
  await window.AgentsPublishHooks.pushAgentToMarketplace({
    localId: "agent-1",
    solutionId: "sol-linked",
    args,
  });
  const updateCall = calls.find((entry) => entry[0] === "update");
  assert.ok(updateCall);
  assert.equal(updateCall[1], "sol-linked");
  assert.deepEqual(JSON.parse(JSON.stringify(updateCall[2].allowed_emails)), [
    "teammate@example.invalid",
  ]);
  assert.equal(updateCall[2].submitted_by, "dsantiago");
});

test("requirement 4: invalid allowed emails abort the publish before any marketplace write", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installMarketplaceFixture(window, {});

  await assert.rejects(
    window.AgentsPublishHooks.pushAgentToMarketplace({
      localId: "agent-1",
      solutionId: "",
      args: {
        name: "Agent One",
        description: "",
        base_model_id: "model-a",
        system_prompt: "prompt",
        allowed_emails: ["not-an-email"],
        skill_ids: [],
        tool_server_ids: [],
        reasoning_effort: null,
      },
    }),
    /Allowed emails must be valid email addresses\. Check: not-an-email\./,
  );
  for (const forbidden of ["publish", "update", "buildAgentBundle"]) {
    assert.ok(
      !calls.some((entry) => entry[0] === forbidden),
      `${forbidden} must not run with invalid allowed emails`,
    );
  }
});

test("requirement 4: the publish modal shows visibility and ownership-aware action labels", async () => {
  // Owner of the linked solution → "Republish" (ownership detail stays in the
  // Marketplace action line; the submit label no longer forks on it).
  const owned = loadAgentsModuleHarness();
  installMarketplaceFixture(owned.window, {
    agents: [
      localAgent("agent-1", {
        name: "Agent One",
        allowed_emails: ["teammate@example.invalid"],
      }),
    ],
    links: { "agent-1": { solutionId: "sol-1" } },
    solutionsById: {
      "sol-1": {
        id: "sol-1",
        status: "active",
        submitted_by: "dsantiago@example.invalid",
      },
    },
  });
  await owned.window.AgentsTabModule.publishAgent("agent-1");
  const ownedOverlay = owned.document.getElementById("agents-modal-overlay");
  assert.ok(ownedOverlay, "publish confirmation modal opened");
  assert.match(
    ownedOverlay.innerHTML,
    /<strong>Visibility:<\/strong> Restricted to teammate@example\.invalid/,
  );
  assert.match(ownedOverlay.innerHTML, /You own the linked solution/);
  assert.match(
    ownedOverlay.innerHTML,
    /class="btn-primary agents-modal-submit"[^>]*>Republish</,
  );

  // Foreign owner → "Republish" + editable-copy guidance, never a fork offer.
  const foreign = loadAgentsModuleHarness();
  installMarketplaceFixture(foreign.window, {
    agents: [localAgent("agent-2", { name: "Agent Two" })],
    links: { "agent-2": { solutionId: "sol-2" } },
    solutionsById: {
      "sol-2": {
        id: "sol-2",
        status: "active",
        submitted_by: "someoneelse@example.invalid",
      },
    },
  });
  await foreign.window.AgentsTabModule.publishAgent("agent-2");
  const foreignOverlay = foreign.document.getElementById("agents-modal-overlay");
  assert.match(foreignOverlay.innerHTML, /<strong>Visibility:<\/strong> Public/);
  assert.match(foreignOverlay.innerHTML, /someoneelse/);
  assert.match(
    foreignOverlay.innerHTML,
    /Create an editable copy to publish a separate solution\./,
  );
  assert.doesNotMatch(foreignOverlay.innerHTML, /create your own fork/);
  assert.match(
    foreignOverlay.innerHTML,
    /class="btn-primary agents-modal-submit"[^>]*>Republish</,
  );
});

test("requirement 4: submitting the publish modal republishes and reports the marketplace status + skills summary", async () => {
  const { window, document } = loadAgentsModuleHarness();
  const { calls, notifications } = installMarketplaceFixture(window, {
    agents: [
      localAgent("agent-1", {
        name: "Agent One",
        allowed_emails: ["teammate@example.invalid"],
        skill_ids: ["alpha"],
      }),
    ],
    skills: [userSkill("alpha")],
    links: { "agent-1": { solutionId: "sol-1" } },
    solutionsById: {
      "sol-1": {
        id: "sol-1",
        status: "active",
        submitted_by: "dsantiago@example.invalid",
      },
    },
  });

  // Prime the skills-freshness snapshot so we can prove publishing
  // invalidates it (Published chips must not wait out the 5-minute TTL).
  await window.AgentsTabRenderHooks.loadSkillFreshnessSnapshot();
  const publishedFetches = () =>
    calls.filter((entry) => entry[0] === "listPublished").length;
  const fetchesBeforePublish = publishedFetches();

  await window.AgentsTabModule.publishAgent("agent-1");
  const overlay = document.getElementById("agents-modal-overlay");
  overlay.querySelector(".agents-modal-submit").click();
  await settle(30);

  const updateCall = calls.find((entry) => entry[0] === "update" && entry[1] === "sol-1");
  assert.ok(updateCall, "the linked solution is updated in place");
  assert.ok(
    publishedFetches() > fetchesBeforePublish,
    "publish success invalidates the skills-freshness snapshot (a fresh fetch happened)",
  );
  // The creator is auto-included in restricted visibility.
  assert.deepEqual(
    JSON.parse(JSON.stringify(updateCall[2].allowed_emails)).sort(),
    ["dsantiago@example.invalid", "teammate@example.invalid"],
  );
  const success = notifications.find(([kind]) => kind === "success");
  assert.ok(success, "publish success toast fired");
  assert.match(success[1], /Marketplace copy updated \(solution sol-1\)/);
  assert.match(success[1], /Marketplace status: active/);
  assert.match(success[1], /Skills: 1 skill published\./);
});

test("requirement 4: restricted visibility without a creator email fails closed; empty stays public", async () => {
  const { window } = loadAgentsModuleHarness();
  const fixture = installMarketplaceFixture(window, {});
  // No authenticated email available.
  window.electronAPI.currentUser.get = async () => ({ authenticated: false });

  // The publish path routes args through withCreatorAllowedEmail before
  // pushAgentToMarketplace; exercise the same composition the submit uses.
  const publishArgs = {
    name: "Agent",
    description: "",
    base_model_id: "m",
    system_prompt: "p",
    allowed_emails: [],
    skill_ids: [],
    tool_server_ids: [],
    reasoning_effort: null,
  };
  // Empty allowed emails stay public (no creator lookup needed).
  await window.AgentsPublishHooks.pushAgentToMarketplace({
    localId: "agent-1",
    solutionId: "",
    args: publishArgs,
  });
  const publishCall = fixture.calls.find((entry) => entry[0] === "publish");
  assert.deepEqual(JSON.parse(JSON.stringify(publishCall[1].allowed_emails)), []);
});

// ============================================================================
// Requirement 5: agent publish flows include the dependent skill marketplace
// lifecycle. (Install-side consumption of skill_refs — asSkillRefs →
// installSkillDependency({ expectedSkillId, solutionId }) with the
// parentSolutionId/viewerEmail guard — runs for real in
// ai-marketplace-agent-skill-deps.unit.test.js and
// ai-marketplace-operations.unit.test.js "guarded agent dependency ..." tests.)
// ============================================================================

test("requirement 5: a marketplace-installed dependency is referenced by its recorded solution without republishing", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installMarketplaceFixture(window, {
    skills: [
      {
        name: "ai-marketplace/toolkit",
        source: "marketplace",
        marketplace_id: "ai-marketplace",
        skill_path: "/tmp/skills-marketplace/ai-marketplace/toolkit",
      },
    ],
    installedSources: { toolkit: { solutionId: "sol-installed" } },
  });

  const result = await window.AgentsPublishHooks.publishDependentSkills([
    "ai-marketplace/toolkit",
  ]);

  assert.deepEqual(JSON.parse(JSON.stringify(result.refs)), [
    { skill_id: "toolkit", kind: "solution", solution_id: "sol-installed" },
  ]);
  assert.equal(result.summary.referenced, 1);
  for (const forbidden of ["publish", "update", "setSkillLink"]) {
    assert.ok(
      !calls.some((entry) => entry[0] === forbidden),
      `${forbidden} must not run for installed marketplace copies`,
    );
  }
});

test("requirement 5: a linked user skill updates its existing solution and refreshes the link", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installMarketplaceFixture(window, {
    skills: [userSkill("alpha")],
    // Dirty link: a clean one is referenced without any upload (and its
    // liveness is verified at publish time, not resolve time).
    skillLinks: { alpha: { solutionId: "sol-a", hasLocalChanges: true } },
  });

  const result = await window.AgentsPublishHooks.publishDependentSkills(["alpha"]);

  assert.equal(result.summary.updated, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(result.refs)), [
    { skill_id: "alpha", kind: "solution", solution_id: "sol-a" },
  ]);
  const updateCall = calls.find((entry) => entry[0] === "update");
  assert.equal(updateCall[1], "sol-a");
  assert.equal(updateCall[2].type, "skills");
  assert.equal(updateCall[2].submitted_by, "dsantiago");
  assert.ok(
    calls.some(
      (entry) => entry[0] === "setSkillLink" && entry[1] === "alpha" && entry[2] === "sol-a",
    ),
  );
  assert.ok(
    !calls.some((entry) => entry[0] === "search"),
    "linked skills never fall back to the name search",
  );
});

test("requirement 5: an unlinked skill adopts an existing marketplace solution only after bundle verification", async () => {
  // OWNED name-match whose bundle IS the same skill → adopt that solution.
  // (Adoption decides from the viewer's own listings; foreign collisions
  // fail closed at publish time on the name-availability guard.)
  const matched = loadAgentsModuleHarness();
  const matchedFixture = installMarketplaceFixture(matched.window, {
    skills: [userSkill("alpha")],
    ownedSolutions: [{ id: "sol-x", type: "skills", name: "alpha" }],
    bundlesBySolutionId: {
      "sol-x": {
        success: true,
        data: { type: "skills", payload: { name: "alpha" } },
      },
    },
  });
  const adopted =
    await matched.window.AgentsPublishHooks.publishDependentSkills(["alpha"]);
  assert.equal(adopted.summary.adopted, 1);
  assert.ok(
    matchedFixture.calls.some(
      (entry) => entry[0] === "getBundle" && entry[1] === "sol-x",
    ),
    "the candidate is bundle-verified before adoption",
  );
  assert.ok(
    matchedFixture.calls.some(
      (entry) => entry[0] === "update" && entry[1] === "sol-x",
    ),
  );

  // Owned name-match whose bundle is a DIFFERENT skill → ignored, fresh
  // publish.
  const mismatched = loadAgentsModuleHarness();
  const mismatchedFixture = installMarketplaceFixture(mismatched.window, {
    skills: [userSkill("alpha")],
    ownedSolutions: [{ id: "sol-y", type: "skills", name: "alpha" }],
    bundlesBySolutionId: {
      "sol-y": {
        success: true,
        data: { type: "skills", payload: { name: "omega" } },
      },
    },
  });
  const republished =
    await mismatched.window.AgentsPublishHooks.publishDependentSkills(["alpha"]);
  assert.equal(republished.summary.published, 1);
  assert.ok(
    !mismatchedFixture.calls.some((entry) => entry[0] === "update"),
    "a mismatched bundle must never be updated",
  );
});

test("requirement 5: a stale skill link (solution deleted remotely) is repaired by republish + relink", async () => {
  const { window } = loadAgentsModuleHarness();
  const skillLinks = { alpha: { solutionId: "sol-gone", hasLocalChanges: false } };
  const { calls, logToMainEvents } = installMarketplaceFixture(window, {
    skills: [userSkill("alpha")],
    skillLinks,
    solutionsById: { "sol-gone": { id: "sol-gone", status: "deleted" } },
    updateImpl: () => ({ success: false, code: "not_found", status: 404 }),
  });

  // Attempt 1: the execute-time liveness wave finds the tombstone, marks the
  // link dirty, and aborts before any write.
  await assert.rejects(
    window.AgentsPublishHooks.publishDependentSkills(["alpha"]),
    /marketplace listings no longer exist: alpha/,
  );
  // Attempt 2: the dirty link takes the update path, whose absent-listing
  // self-heal republishes and relinks.
  const result = await window.AgentsPublishHooks.publishDependentSkills(["alpha"]);

  assert.equal(result.summary.repaired, 1);
  assert.equal(result.summary.published, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(result.refs)), [
    { skill_id: "alpha", kind: "solution", solution_id: "new-alpha" },
  ]);
  assert.ok(
    calls.some(
      (entry) =>
        entry[0] === "setSkillLink" &&
        entry[1] === "alpha" &&
        entry[2] === "new-alpha",
    ),
    "the stale link is repointed at the fresh solution",
  );
  assert.ok(
    logToMainEvents.some((event) =>
      String(event?.message || "").includes("push:skill-link-stale"),
    ),
    "the stale-link repair is logged to main for observability",
  );
});

test("requirement 5: dependent skill failures aggregate into one publish-blocking error", async () => {
  const { window } = loadAgentsModuleHarness();
  installMarketplaceFixture(window, {
    skills: [userSkill("alpha")],
    publishImpl: () => ({ success: false, error: "server exploded" }),
  });

  await assert.rejects(
    window.AgentsPublishHooks.publishDependentSkills(["alpha"]),
    /Failed to publish dependent skill solutions: alpha \(server exploded\)/,
  );
});

test("requirement 5: the agent bundle embeds resolved skill_refs and canonical skill ids", async () => {
  const { window } = loadAgentsModuleHarness();
  const { calls } = installMarketplaceFixture(window, {
    skills: [userSkill("alpha")],
  });

  await window.AgentsPublishHooks.pushAgentToMarketplace({
    localId: "agent-1",
    solutionId: "",
    args: {
      name: "Agent One",
      description: "",
      base_model_id: "model-a",
      system_prompt: "prompt",
      // The requested id is prefixed; the bundle must carry canonical names.
      skill_ids: ["skills-user/alpha", "alpha"],
      tool_server_ids: [],
      reasoning_effort: "medium",
    },
  });

  const agentBundleCall = calls.find((entry) => entry[0] === "buildAgentBundle");
  assert.ok(agentBundleCall, "the agent bundle is built");
  assert.deepEqual(JSON.parse(JSON.stringify(agentBundleCall[1].skill_refs)), [
    { skill_id: "alpha", kind: "solution", solution_id: "new-alpha" },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(agentBundleCall[1].skill_ids)), [
    "alpha",
  ]);
  const skillPublishIndex = calls.findIndex((entry) => entry[0] === "publish");
  const agentBundleIndex = calls.indexOf(agentBundleCall);
  assert.ok(
    skillPublishIndex >= 0 && skillPublishIndex < agentBundleIndex,
    "dependent skills publish before the agent bundle is built",
  );
});

test("requirement 5: skill publish bundles carry required_mcp_servers into the payload", async () => {
  // Real bundle builder (the payload agents/skills installs consume).
  const { buildPublishBundle } = require("./ai-marketplace-install");
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "req5-skill-bundle-"),
  );
  try {
    const skillDir = path.join(projectRoot, "skills-user", "alpha");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Alpha\n", "utf8");

    const bundle = await buildPublishBundle({
      type: "skills",
      projectRoot,
      skill: {
        name: "alpha",
        path: path.join("skills-user", "alpha"),
        required_mcp_servers: ["server:glean"],
      },
    });

    assert.equal(bundle.type, "skills");
    assert.deepEqual(bundle.payload.required_mcp_servers, ["server:glean"]);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// Harness: esbuild-bundled agent-skills.js (Agent Skills layer)
// ============================================================================

let bundledAgentSkillsSource = null;
function bundleAgentSkills() {
  if (bundledAgentSkillsSource) return bundledAgentSkillsSource;
  const esbuild = require("esbuild");
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-skills-audit-"));
  const outfile = path.join(outDir, "agent-skills.bundle.js");
  esbuild.buildSync({
    entryPoints: [path.join(componentsDir, "agent-skills.js")],
    bundle: true,
    outfile,
    format: "iife",
    platform: "browser",
    logLevel: "silent",
  });
  bundledAgentSkillsSource = fs.readFileSync(outfile, "utf8");
  return bundledAgentSkillsSource;
}

function loadAgentSkillsHarness({
  skills = [],
  skillLinks = {},
  publishedSolutions = [],
  publishImpl = null,
  updateImpl = null,
  duplicateImpl = null,
} = {}) {
  const source = bundleAgentSkills();
  const document = createFakeDocument();
  const calls = [];
  const notifications = [];
  const confirmCalls = [];

  const windowObject = {
    appState: {},
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    electronAPI: {
      getSkills: async () => {
        calls.push(["getSkills"]);
        return { success: true, skills };
      },
      getUsername: async () => ({ username: "dsantiago" }),
      currentUser: {
        get: async () => ({
          authenticated: true,
          sessionSummary: { user: { email: "dsantiago@example.invalid" } },
        }),
      },
      duplicateSkill: async (skillPath, newName, options) => {
        calls.push(["duplicateSkill", skillPath, newName, options]);
        if (duplicateImpl) return duplicateImpl(skillPath, newName, options);
        return { success: true, skillName: newName };
      },
      logToMain: () => {},
      aiMarketplace: {
        listSkillLinks: async () => ({ success: true, links: skillLinks }),
        listPublished: async (type) => {
          calls.push(["listPublished", type]);
          return { success: true, data: { solutions: publishedSolutions } };
        },
        getSkillLink: async (name) => {
          calls.push(["getSkillLink", name]);
          return { success: true, link: skillLinks[name] || null };
        },
        setSkillLink: async (name, solutionId) => {
          calls.push(["setSkillLink", name, solutionId]);
          return { success: true };
        },
        buildPublishBundle: async (input) => {
          calls.push(["buildPublishBundle", input?.skill?.name, input]);
          return {
            success: true,
            data: { type: "skills", payload: { name: input?.skill?.name } },
          };
        },
        publish: async (input, opts) => {
          calls.push(["publish", input, opts]);
          if (publishImpl) return publishImpl(input, opts);
          return { success: true, data: { id: `new-${input?.name}` } };
        },
        update: async (solutionId, input, opts) => {
          calls.push(["update", solutionId, input, opts]);
          if (updateImpl) return updateImpl(solutionId, input, opts);
          return { success: true, data: { id: solutionId } };
        },
      },
    },
    showNotification: (message, kind = "info") =>
      notifications.push([kind, message]),
    showAgentsConfirmModal: (options) => {
      confirmCalls.push(options);
    },
  };
  windowObject.window = windowObject;

  const context = {
    window: windowObject,
    document,
    console,
    setTimeout,
    clearTimeout,
    Promise,
    Math,
    Date,
    JSON,
    URL,
    HTMLElement: FakeElement,
    navigator: { clipboard: { writeText: async () => {} } },
    requestAnimationFrame: (cb) => {
      cb();
      return 0;
    },
    showNotification: windowObject.showNotification,
  };
  context.globalThis = context;

  // The shared card shell used by renderSkillCard (plain script, same context).
  vm.runInNewContext(
    fs.readFileSync(path.join(componentsDir, "skill-card-renderer.js"), "utf8"),
    context,
    { filename: path.join(componentsDir, "skill-card-renderer.js") },
  );
  vm.runInNewContext(source, context, {
    filename: path.join(componentsDir, "agent-skills.js"),
  });

  return { window: windowObject, document, calls, notifications, confirmCalls };
}

// ============================================================================
// Requirement 6: chat-created user skills can be published from Agent Skills.
// ============================================================================

test("requirement 6: the skills MCP exposes create_skill/update_skill (chat-created skills exist locally)", () => {
  const skillToolSpec = JSON.parse(
    readRepoFile(
      "..",
      "..",
      "..",
      "src",
      "core-mcp-rust",
      "crates",
      "skills-server",
      "tool_spec.json",
    ),
  );
  const toolNames = new Set(skillToolSpec.map((entry) => entry.name));
  assert.equal(toolNames.has("create_skill"), true);
  assert.equal(toolNames.has("update_skill"), true);
});

test("requirement 6: a user skill publishes from the card menu as a skills solution with a link", async () => {
  const harness = loadAgentSkillsHarness({ skills: [userSkill("notes")] });
  const { window, document, calls, confirmCalls } = harness;

  // Render the list, then click the real Publish menu button the card wired.
  const publishBtn = new FakeElement("", document);
  publishBtn.dataset.skillName = "notes";
  publishBtn.isConnected = true;
  document
    .getElementById("skills-list")
    .registerQueryList(".skill-publish-ai-marketplace-menu-btn", [publishBtn]);
  await window.loadSkills();

  assert.match(
    document.getElementById("skills-list").innerHTML,
    /skill-publish-ai-marketplace-menu-btn/,
    "user skill cards render the Publish action",
  );

  publishBtn.click();
  await settle();
  assert.equal(confirmCalls.length, 1, "publishing asks for confirmation first");
  assert.equal(confirmCalls[0].title, "Publish?");
  assert.equal(
    calls.some((entry) => entry[0] === "publish"),
    false,
    "no marketplace write before the user confirms",
  );

  await confirmCalls[0].onConfirm();
  await settle();

  const bundleCall = calls.find((entry) => entry[0] === "buildPublishBundle");
  assert.equal(bundleCall[1], "notes");
  assert.equal(bundleCall[2].type, "skills");
  const publishCall = calls.find((entry) => entry[0] === "publish");
  assert.ok(publishCall, "the confirmed publish creates a skills solution");
  assert.equal(publishCall[1].type, "skills");
  assert.deepEqual(JSON.parse(JSON.stringify(publishCall[2])), {
    localSkillId: "notes",
  });
  assert.ok(
    calls.some(
      (entry) =>
        entry[0] === "setSkillLink" &&
        entry[1] === "notes" &&
        entry[2] === "new-notes",
    ),
    "the published skill records its marketplace link",
  );
});

// ============================================================================
// Requirement 7: Agent Skills exposes the unified filter row with publish
// actions. The static tab row is a markup contract on the real DOM template
// (index.html), asserted as extracted data; the filter/publish behavior runs
// through the bundled component.
// ============================================================================

test("requirement 7: the Agent Skills filter row markup exposes exactly User/Published/Installed/All/Discover/Git", () => {
  const indexHtmlSource = readRepoFile("..", "renderer", "views", "index.html");
  const tabsBlock = indexHtmlSource.match(
    /<div class="mcp-filter-tabs" id="skills-filter-tabs">[\s\S]*?<\/div>/,
  );
  assert.ok(tabsBlock, "Agent Skills filter row exists");
  const block = tabsBlock[0];
  assert.deepEqual(
    [...block.matchAll(/data-filter="([^"]+)"/g)].map((match) => match[1]),
    ["user", "published", "marketplace", "all", "discover", "marketplaces-browse"],
  );
  assert.match(block, /class="mcp-filter-tab active" data-filter="user"/);
  assert.match(block, /data-filter="user">\s*User/s);
  assert.match(block, /data-filter="published">\s*Published/s);
  assert.match(block, /data-filter="marketplace">\s*Installed/s);
  // Discover = inline Solutions Marketplace listings; Git = the git-backed
  // marketplaces browse (relabeled, keeps its filter id + update dot).
  assert.match(block, /data-filter="discover">\s*Discover/s);
  assert.match(block, /data-filter="marketplaces-browse"[\s\S]*?>\s*Git/s);
  assert.doesNotMatch(block, />\s*Core\s*</s);
  assert.doesNotMatch(block, />\s*Marketplaces\s*</s);
});

test("requirement 7: the list defaults to the User facet and Installed shows marketplace skills with the INSTALLED badge", async () => {
  const marketplaceSkill = {
    name: "ai-marketplace/toolkit",
    display_name: "Toolkit",
    source: "marketplace",
    marketplace_id: "ai-marketplace",
    marketplace_name: "Solutions Marketplace",
    skill_path: "/tmp/skills-marketplace/ai-marketplace/toolkit",
    created_by_email: "someoneelse@example.invalid",
  };
  const mine = {
    ...userSkill("notes"),
    display_name: "Notes",
    created_by_email: "dsantiago@example.invalid",
  };
  const { window, document } = loadAgentSkillsHarness({
    skills: [mine, marketplaceSkill],
  });

  await window.loadSkills();
  const list = document.getElementById("skills-list");

  // Default facet is User: my editable skill renders, the installed copy not.
  assert.match(list.innerHTML, /Notes/);
  assert.doesNotMatch(list.innerHTML, /Toolkit/);

  // Installed facet: the marketplace copy renders with the INSTALLED badge
  // and without a publish action (read-only copies cannot publish directly).
  window.switchAgentSkillsToInstalledTab();
  await settle();
  assert.match(list.innerHTML, /Toolkit/);
  assert.doesNotMatch(list.innerHTML, /Notes/);
  assert.match(list.innerHTML, />Installed</);
  assert.doesNotMatch(list.innerHTML, /skill-publish-ai-marketplace-menu-btn/);
});

// ============================================================================
// Requirement 8: installed marketplace skills duplicate for editing; no
// silent foreign-solution forking. (The Duplicate prompt→copy→User-facet flow
// itself is exercised end to end in
// ai-marketplace-publish-lifecycle.unit.test.js "installed marketplace skills
// become editable via Duplicate".)
// ============================================================================

test("requirement 8: publishing an installed marketplace copy is refused with Duplicate guidance", async () => {
  const { window, calls, notifications, confirmCalls } = loadAgentSkillsHarness({});

  await window.AgentSkillsHooks.publishSkillToAiMarketplace({
    name: "ai-marketplace/toolkit",
    source: "marketplace",
    marketplace_id: "ai-marketplace",
    skill_path: "/tmp/skills-marketplace/ai-marketplace/toolkit",
  });

  const info = notifications.find(([kind]) => kind === "info");
  assert.ok(info, "the guard explains instead of publishing");
  assert.match(info[1], /Marketplace-installed skills are read-only/);
  assert.match(info[1], /Use Duplicate to create an editable user copy/);
  assert.equal(confirmCalls.length, 0, "no publish confirmation is offered");
  for (const forbidden of ["buildPublishBundle", "publish", "update", "setSkillLink"]) {
    assert.ok(
      !calls.some((entry) => entry[0] === forbidden),
      `${forbidden} must not run for read-only copies`,
    );
  }
});

test("requirement 8: a linked republish updates in place and a rejected update never forks a new solution", async () => {
  const { window, calls, confirmCalls, notifications } = loadAgentSkillsHarness({
    skills: [userSkill("notes")],
    skillLinks: { notes: { solutionId: "sol-notes" } },
    publishedSolutions: [{ id: "sol-notes", type: "skills", name: "notes" }],
    updateImpl: () => ({
      success: false,
      error: "not the owner",
      code: "not_owner",
      status: 403,
    }),
  });
  await window.loadSkills();

  await window.AgentSkillsHooks.publishSkillToAiMarketplace({
    ...userSkill("notes"),
    marketplace_solution_id: "sol-notes",
  });
  assert.equal(confirmCalls.length, 1);
  assert.equal(confirmCalls[0].title, "Republish?");
  await confirmCalls[0].onConfirm();
  await settle();

  const updateCall = calls.find((entry) => entry[0] === "update");
  assert.equal(updateCall[1], "sol-notes");
  assert.deepEqual(JSON.parse(JSON.stringify(updateCall[3])), {
    localSkillId: "notes",
  });
  assert.ok(
    !calls.some((entry) => entry[0] === "publish"),
    "a rejected update must never fork a second solution",
  );
  assert.ok(
    !calls.some((entry) => entry[0] === "setSkillLink"),
    "no link is written for a failed update",
  );
  const failure = notifications.find(([kind]) => kind === "error");
  assert.match(failure[1], /not the owner/);
});

// ============================================================================
// IPC/Communication layer: the ai-marketplace handlers forward viewer
// identity and delegate writes to the shared operations service.
// Harness: Module._load-stubbed ipc.js (terminal-command-ipc pattern) with
// recorded service fakes.
// ============================================================================

function loadAiMarketplaceIpcHandlers({ operations = {}, client = {} } = {}) {
  const ipcModulePath = require.resolve("./ipc");
  const previousModule = require.cache[ipcModulePath];
  const originalLoad = Module._load;
  const handlers = new Map();
  const calls = [];

  const electronStub = {
    app: { getPath: () => "/tmp/portico-tests" },
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
      on() {},
    },
    shell: { async openExternal() {}, async openPath() {} },
    clipboard: { writeText() {} },
    BrowserWindow: {
      fromWebContents: () => null,
      getAllWindows: () => [],
    },
    Notification: function Notification() {},
  };

  const fakeClient = {
    search: async (params, opts) => {
      calls.push(["client.search", params, opts]);
      return client.searchResult || { results: [] };
    },
    getSolution: async (id, opts) => {
      calls.push(["client.getSolution", id, opts]);
      return { id };
    },
    getSolutionBundle: async (id, opts) => {
      calls.push(["client.getSolutionBundle", id, opts]);
      return { type: "skills", payload: {} };
    },
  };
  const fakeOperations = {
    install: async (id, options) => {
      calls.push(["operations.install", id, options]);
      if (operations.installImpl) return operations.installImpl(id, options);
      return { type: "skills" };
    },
    publishSolution: async (solutionInput, options) => {
      calls.push(["operations.publishSolution", solutionInput, options]);
      return {
        data: { id: "sol-new" },
        publishStatus: { id: "sol-new", status: "active", has_bundle: true },
      };
    },
    updatePublishedSolution: async (id, patch, options) => {
      calls.push(["operations.updatePublishedSolution", id, patch, options]);
      return {
        data: { id },
        publishStatus: { id, status: "active", has_bundle: true },
      };
    },
    deletePublishedSolution: async (id) => {
      calls.push(["operations.deletePublishedSolution", id]);
      return { data: { id, status: "deleted" } };
    },
    listPublished: async (options) => {
      calls.push(["operations.listPublished", options]);
      return { solutions: [] };
    },
  };
  const fakeCurrentUser = {
    get: async () => ({
    sessionSummary: { user: { email: "JDoe@example.invalid" } },
    }),
  };
  const fakeRepair = {
    repairMarketplaceLinkedAgentAccess: async (options) => {
      calls.push(["repair.repairMarketplaceLinkedAgentAccess", options]);
      return { checked: 2, repaired: 1, repairedAgentIds: ["agent-1"] };
    },
  };

  const fakesByRequest = new Map([
    ["./ai-marketplace-client", fakeClient],
    ["./ai-marketplace-operations", fakeOperations],
    ["./current-user", fakeCurrentUser],
    ["./ai-marketplace-agent-access-repair", fakeRepair],
  ]);

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") return electronStub;
    if (
      parent?.filename === ipcModulePath &&
      (request.startsWith("./") || request.startsWith("../"))
    ) {
      return fakesByRequest.get(request) || {};
    }
    return originalLoad.apply(this, [request, parent, isMain]);
  };

  delete require.cache[ipcModulePath];
  let ipc;
  try {
    ipc = require("./ipc");
    // Marketplace handlers require their services lazily at registration
    // time, so register while Module._load is still patched.
    ipc.registerAiMarketplaceHandlers();
  } finally {
    Module._load = originalLoad;
    delete require.cache[ipcModulePath];
    if (previousModule) require.cache[ipcModulePath] = previousModule;
  }

  return { handlers, calls };
}

test("ipc: marketplace reads resolve and forward the normalized viewer identity", async () => {
  const { handlers, calls } = loadAiMarketplaceIpcHandlers();

  const searchResult = await handlers.get("ai-marketplace-search")(
    {},
    { query: "agents" },
  );
  assert.equal(searchResult.success, true);
  const searchCall = calls.find((entry) => entry[0] === "client.search");
  assert.equal(searchCall[2].viewerEmail, "jdoe@example.invalid");

  await handlers.get("ai-marketplace-get-solution")({}, "sol-1");
  const getCall = calls.find((entry) => entry[0] === "client.getSolution");
  assert.equal(getCall[1], "sol-1");
  assert.equal(getCall[2].viewerEmail, "jdoe@example.invalid");
});

test("ipc: install/publish/update/delete delegate to the shared operations service with normalized options", async () => {
  const { handlers, calls } = loadAiMarketplaceIpcHandlers();

  await handlers.get("ai-marketplace-install")({}, "sol-1", {
    existingAgentId: "  agent-1 ",
    refreshInstalledSkillId: " notes ",
  });
  const installCall = calls.find((entry) => entry[0] === "operations.install");
  assert.equal(installCall[1], "sol-1");
  // The control-plane route hardcodes interactive auth and streams
  // per-dependency progress; the renderer-supplied ids pass through trimmed.
  assert.equal(installCall[2].existingAgentId, "agent-1");
  assert.equal(installCall[2].refreshInstalledSkillId, "notes");
  assert.equal(installCall[2].interactiveAuth, true);
  assert.equal(typeof installCall[2].onProgress, "function");

  const publishResult = await handlers.get("ai-marketplace-publish")(
    {},
    { name: "n", type: "skills" },
    { localSkillId: "notes" },
  );
  assert.equal(publishResult.success, true);
  assert.equal(publishResult.publishStatus.status, "active");
  const publishCall = calls.find(
    (entry) => entry[0] === "operations.publishSolution",
  );
  assert.deepEqual(publishCall[2], {
    localAgentId: "",
    localSkillId: "notes",
    aclAudience: undefined,
  });

  await handlers.get("ai-marketplace-update")(
    {},
    "sol-1",
    { name: "n" },
    { localAgentId: "agent-1" },
  );
  const updateCall = calls.find(
    (entry) => entry[0] === "operations.updatePublishedSolution",
  );
  assert.equal(updateCall[1], "sol-1");
  assert.deepEqual(updateCall[3], {
    localAgentId: "agent-1",
    localSkillId: "",
    aclAudience: undefined,
  });

  // The audience sanitizer: arrays keep only strings, null passes through
  // (ACL-agnostic caller), anything else degrades to undefined.
  await handlers.get("ai-marketplace-update")(
    {},
    "sol-acl",
    { name: "n" },
    { localSkillId: "notes", aclAudience: ["a@example.invalid", 42, null] },
  );
  const sanitizedCall = calls.findLast(
    (entry) => entry[0] === "operations.updatePublishedSolution",
  );
  assert.deepEqual(sanitizedCall[3].aclAudience, ["a@example.invalid"]);
  await handlers.get("ai-marketplace-publish")(
    {},
    { name: "n2", type: "skills" },
    { localSkillId: "notes", aclAudience: null },
  );
  const nullAudienceCall = calls.findLast(
    (entry) => entry[0] === "operations.publishSolution",
  );
  assert.equal(nullAudienceCall[2].aclAudience, null);

  await handlers.get("ai-marketplace-delete")({}, "sol-1");
  assert.ok(
    calls.some(
      (entry) =>
        entry[0] === "operations.deletePublishedSolution" && entry[1] === "sol-1",
    ),
  );

  // Operation failures come back as { success:false } envelopes, not throws.
  const { handlers: failingHandlers } = loadAiMarketplaceIpcHandlers({
    operations: {
      installImpl: () => {
        const error = new Error("no bundle");
        error.code = "no_bundle";
        error.status = 404;
        throw error;
      },
    },
  });
  const failure = await failingHandlers.get("ai-marketplace-install")({}, "x", {});
  assert.equal(failure.success, false);
  assert.equal(failure.code, "no_bundle");
  assert.equal(failure.status, 404);
});

test("ipc: the linked-agent access repair handler runs the repair service with the caller's reason", async () => {
  const { handlers, calls } = loadAiMarketplaceIpcHandlers();

  const result = await handlers.get("ai-marketplace-repair-linked-agent-access")(
    {},
    { reason: "load-my-agents" },
  );

  assert.equal(result.success, true);
  assert.equal(result.result.repaired, 1);
  const repairCall = calls.find(
    (entry) => entry[0] === "repair.repairMarketplaceLinkedAgentAccess",
  );
  assert.equal(repairCall[1].reason, "load-my-agents");
});

// ============================================================================
// PORTICO-414: publish preflight failures are visible, coded, and heal-then-retry
// ============================================================================

const CREATOR_EMAIL_UNAVAILABLE_COPY =
  "Publishing is blocked because your signed-in account did not provide an email address. Sign in again when prompted, or restart the app, then retry.";
const PREFLIGHT_DEFAULT_COPY =
  "Publishing could not start due to an unexpected error. Try again; if it keeps failing, restart the app.";

test("PORTICO-414: restricted publish without a creator email fails visibly once with fixed copy", async () => {
  const { window, document } = loadAgentsModuleHarness();
  const fixture = installMarketplaceFixture(window, {
    agents: [
      localAgent("agent-1", {
        name: "Agent One",
        allowed_emails: ["teammate@example.invalid"],
      }),
    ],
  });
  // Email-less authenticated session, and NO heal APIs at all (old preload
  // shape): the flow must still fail closed, visibly, exactly once.
  window.electronAPI.currentUser = {
    get: async () => ({
      authenticated: true,
      sessionSummary: { user: { email: null } },
    }),
  };

  await window.AgentsTabModule.publishAgent("agent-1");
  await settle();

  assert.equal(
    document._registry.has("agents-modal-overlay"),
    false,
    "the review modal never opened",
  );
  const errors = fixture.notifications.filter(([kind]) => kind === "error");
  assert.equal(errors.length, 1, "exactly one visible failure");
  assert.equal(errors[0][1], CREATOR_EMAIL_UNAVAILABLE_COPY);

  const failEvents = fixture.logToMainEvents.filter(
    (entry) => entry?.meta?.event === "open:preflight-failed",
  );
  assert.equal(failEvents.length, 1);
  assert.equal(failEvents[0].meta.stage, "audience");
  assert.equal(failEvents[0].meta.code, "creator_email_unavailable");
  // The failure meta is fixed identifiers only — never free error text.
  assert.deepEqual(
    Object.keys(failEvents[0].meta).sort(),
    ["agentId", "at", "code", "event", "stage"],
  );
});

test("PORTICO-414: the trigger stays busy through the whole preflight, so a double click cannot fork the flow", async () => {
  const { window, document } = loadAgentsModuleHarness();
  const fixture = installMarketplaceFixture(window, {
    agents: [
      localAgent("agent-1", {
        name: "Agent One",
        allowed_emails: ["teammate@example.invalid"],
      }),
    ],
  });
  // Identity resolution parks until the test releases it, holding the
  // preflight open across both clicks.
  const pendingIdentity = [];
  window.electronAPI.currentUser = {
    get: () =>
      new Promise((resolve) => {
        pendingIdentity.push(resolve);
      }),
  };

  window.AgentsTabModule.init();
  const list = document.getElementById("agents-tab-list");
  const btn = document.createElement("button");
  btn.classList.add("agent-publish-btn");
  btn.setAttribute("data-agent-id", "agent-1");
  btn.closest = (selector) => (selector === "button" ? btn : null);

  list.dispatchEvent("click", { target: btn });
  await settle();
  assert.equal(btn.dataset.busy, "true", "trigger is busy during the preflight");
  list.dispatchEvent("click", { target: btn });
  await settle();

  const flowStarts = fixture.logToMainEvents.filter(
    (entry) => entry?.meta?.event === "open:publish-flow",
  );
  assert.equal(flowStarts.length, 1, "the second click was swallowed by the busy guard");

  // Release identity: the single flow completes into the review modal.
  const identity = {
    authenticated: true,
    sessionSummary: { user: { email: "dsantiago@example.invalid" } },
  };
  pendingIdentity.forEach((resolve) => resolve(identity));
  window.electronAPI.currentUser.get = async () => identity;
  await settle(20);

  const overlay = document.getElementById("agents-modal-overlay");
  assert.ok(overlay.parentElement, "the review modal opened after identity resolved");
  assert.notEqual(btn.dataset.busy, "true", "trigger restored after the preflight");
});

test("PORTICO-414: a silent identity repair heals the publish without any interactive re-auth", async () => {
  const { window, document } = loadAgentsModuleHarness();
  const fixture = installMarketplaceFixture(window, {
    agents: [
      localAgent("agent-1", {
        name: "Agent One",
        allowed_emails: ["teammate@example.invalid"],
      }),
    ],
  });
  let email = null;
  let repairCalls = 0;
  let interactiveCalls = 0;
  window.electronAPI.currentUser = {
    get: async () => ({
      authenticated: true,
      sessionSummary: { user: { email } },
    }),
    repairIdentity: async () => {
      repairCalls += 1;
      email = "dsantiago@example.invalid";
      return { authenticated: true, repaired: true };
    },
    ensureAuthenticated: async () => {
      interactiveCalls += 1;
      return { success: true, authenticated: true };
    },
  };

  await window.AgentsTabModule.publishAgent("agent-1");
  await settle();

  assert.equal(repairCalls, 1);
  assert.equal(interactiveCalls, 0, "no browser re-auth when the silent repair works");
  const overlay = document.getElementById("agents-modal-overlay");
  assert.ok(overlay.parentElement, "the review modal opened after the heal");
  assert.match(overlay.innerHTML, /Restricted to/);
  assert.equal(
    fixture.notifications.filter(([kind]) => kind === "error").length,
    0,
    "no error toast on a healed flow",
  );
});

test("PORTICO-414: when repair fails, an interactive re-auth runs under the busy trigger and the same publish continues", async () => {
  const { window, document } = loadAgentsModuleHarness();
  const fixture = installMarketplaceFixture(window, {
    agents: [
      localAgent("agent-1", {
        name: "Agent One",
        allowed_emails: ["teammate@example.invalid"],
      }),
    ],
  });
  const btn = document.createElement("button");
  btn.closest = (selector) => (selector === "button" ? btn : null);
  let email = null;
  let interactiveCalls = 0;
  let busyDuringInteractive = null;
  window.electronAPI.currentUser = {
    get: async () => ({
      authenticated: true,
      sessionSummary: { user: { email } },
    }),
    repairIdentity: async () => ({
      authenticated: true,
      repaired: false,
      emailUnavailable: true,
    }),
    ensureAuthenticated: async () => {
      interactiveCalls += 1;
      busyDuringInteractive = btn.dataset.busy;
      email = "dsantiago@example.invalid";
      return { success: true, authenticated: true };
    },
  };

  await window.AgentsTabModule.publishAgent("agent-1", btn);
  await settle();

  assert.equal(interactiveCalls, 1, "interactive re-auth ran exactly once");
  assert.equal(
    busyDuringInteractive,
    "true",
    "the trigger was still busy while the browser sign-in was pending",
  );
  const overlay = document.getElementById("agents-modal-overlay");
  assert.ok(overlay.parentElement, "the SAME publish continued into the modal (no re-click)");
  assert.equal(
    fixture.notifications.filter(([kind]) => kind === "error").length,
    0,
  );
  const healEvents = fixture.logToMainEvents.filter(
    (entry) => entry?.meta?.event === "open:creator-email-heal",
  );
  assert.deepEqual(
    healEvents.map((entry) => [entry.meta.stage, entry.meta.recovered]),
    [
      ["repair", false],
      ["interactive", true],
    ],
  );
});

test("PORTICO-414: a cancelled re-auth resolves to one coded visible failure and restores the trigger", async () => {
  const { window, document } = loadAgentsModuleHarness();
  const fixture = installMarketplaceFixture(window, {
    agents: [
      localAgent("agent-1", {
        name: "Agent One",
        allowed_emails: ["teammate@example.invalid"],
      }),
    ],
  });
  const btn = document.createElement("button");
  btn.closest = (selector) => (selector === "button" ? btn : null);
  window.electronAPI.currentUser = {
    get: async () => ({
      authenticated: true,
      sessionSummary: { user: { email: null } },
    }),
    repairIdentity: async () => ({ authenticated: true, repaired: false }),
    ensureAuthenticated: async () => ({
      success: false,
      authenticated: false,
      errorCode: "access_denied_user_cancelled",
    }),
  };

  await window.AgentsTabModule.publishAgent("agent-1", btn);
  await settle();

  assert.equal(
    document._registry.has("agents-modal-overlay"),
    false,
    "no modal after a cancelled re-auth",
  );
  const errors = fixture.notifications.filter(([kind]) => kind === "error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0][1], CREATOR_EMAIL_UNAVAILABLE_COPY);
  const failEvents = fixture.logToMainEvents.filter(
    (entry) => entry?.meta?.event === "open:preflight-failed",
  );
  assert.equal(failEvents.length, 1);
  assert.equal(failEvents[0].meta.code, "creator_email_unavailable");
  assert.notEqual(btn.dataset.busy, "true", "trigger restored after the failure");
  assert.equal(btn.disabled, false);
});

test("PORTICO-414: an exception carrying sensitive text is redacted to fixed copy in both toast and logs", async () => {
  const { window, document } = loadAgentsModuleHarness();
  const fixture = installMarketplaceFixture(window, {
    agents: [localAgent("agent-1", { name: "Agent One" })],
  });
  window.electronAPI.aiMarketplace.hasApiKey = async () => {
    throw new Error("SENTINEL-XYZ leaked prompt content");
  };

  await window.AgentsTabModule.publishAgent("agent-1");
  await settle();

  assert.equal(document._registry.has("agents-modal-overlay"), false);
  const errors = fixture.notifications.filter(([kind]) => kind === "error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0][1], PREFLIGHT_DEFAULT_COPY);
  assert.doesNotMatch(JSON.stringify(fixture.notifications), /SENTINEL-XYZ/);
  assert.doesNotMatch(JSON.stringify(fixture.logToMainEvents), /SENTINEL-XYZ/);
  const failEvents = fixture.logToMainEvents.filter(
    (entry) => entry?.meta?.event === "open:preflight-failed",
  );
  assert.equal(failEvents.length, 1);
  assert.equal(failEvents[0].meta.stage, "api-key");
  assert.equal(failEvents[0].meta.code, "publish_preflight_failed");
});
