// Round 8 — consolidated agent-publish modal, backend (chat-initiated) mode.
// Chat UI + IPC/Communication layers.
//
// A chat agent's subagents_publish_agent call lands in agents.js
// publishAgentFromBackendRequest (via backend-modal-listeners): the EXACT
// control-plane publish modal + PORTICO-347 dependent-skill pipeline runs, and
// the flow completes over the publish-confirm channel with the two-phase
// contract ("publishing" → "published"/"publish_failed"), or "dismissed"/
// "error" terminals. These tests drive the REAL agents.js in a FakeElement vm
// DOM and assert the completion payloads, marketplace calls, and modal
// chrome (suppression, hide-to-pill, reopen, terminal teardown).
//
// Harness: self-contained per repo convention (mirrors
// marketplace-requirements-audit.unit.test.js), extended with the backend
// seams (notifyAiMarketplacePublishConfirmCompleted, presentation, reopen /
// terminal listeners, OWUI suppression).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const servicesDir = __dirname;
const componentsDir = path.join(servicesDir, "..", "renderer", "components");

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
    this.style = { display: "" };
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
    this.focusCount = 0;
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
  querySelector(selector) {
    if (!this.selectorChildren.has(selector)) {
      const child = new FakeElement("", this.ownerDocument);
      child.parentElement = this;
      this.selectorChildren.set(selector, child);
    }
    return this.selectorChildren.get(selector);
  }
  querySelectorAll(selector) {
    return this.selectorLists.get(selector) || [];
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
      this.parentElement = null;
    }
  }
  insertAdjacentHTML() {}
  closest() {
    return null;
  }
  contains() {
    return false;
  }
  focus() {
    this.focusCount += 1;
  }
  select() {}
  getBoundingClientRect() {
    return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
}

function createFakeDocument() {
  const registry = new Map();
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
    querySelectorAll: () => [],
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
  const suppressions = [];
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
    setOwuiInteractionSuppressed: (key, suppressed) => {
      suppressions.push([key, suppressed]);
    },
    setNativeOverlayInteractionSuppressed: (key, suppressed) => {
      suppressions.push([key, suppressed]);
    },
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

  return { window: windowObject, document, suppressions };
}

// Recording fake for the electronAPI surface backend publish flows touch,
// including the confirm-completion channel and the pill/reopen seams.
function installBackendPublishFixture(windowObject, {
  agents = [],
  baseModels = [],
  systemPromptById = {},
  skills = [],
  links = {},
  skillLinks = {},
  ownedSolutions = [],
  hasApiKey = true,
  publishImpl = null,
  updateImpl = null,
  presentationImpl = null,
} = {}) {
  const calls = [];
  const notifications = [];
  const completions = [];
  const presentations = [];
  const reopenCallbacks = [];
  const terminalCallbacks = [];
  const agentsById = Object.fromEntries(
    agents.filter(Boolean).map((agent) => [agent.id, agent]),
  );

  const api = {
    hasApiKey: async () => {
      calls.push(["hasApiKey"]);
      return { hasKey: hasApiKey };
    },
    listLinks: async () => ({ success: true, links }),
    getSolution: async (solutionId) => {
      calls.push(["getSolution", solutionId]);
      return { success: true, data: { id: solutionId, status: "active" } };
    },
    buildPublishBundle: async (input) => {
      calls.push(["buildPublishBundle", input?.type]);
      return {
        success: true,
        data: {
          type: input?.type,
          payload: {
            name: input?.agent?.name || input?.skill?.name,
            description: "bundle",
          },
        },
      };
    },
    publish: async (input, opts) => {
      calls.push(["publish", input, opts]);
      if (publishImpl) return publishImpl(input, opts);
      return {
        success: true,
        data: { id: "sol-published" },
        publishStatus: { id: "sol-published", status: "active", has_bundle: true },
      };
    },
    update: async (solutionId, input, opts) => {
      calls.push(["update", solutionId, input, opts]);
      if (updateImpl) return updateImpl(solutionId, input, opts);
      return {
        success: true,
        data: { id: solutionId },
        publishStatus: { id: solutionId, status: "active", has_bundle: true },
      };
    },
    setSkillLink: async (name, solutionId) => {
      calls.push(["setSkillLink", name, solutionId]);
      return { success: true };
    },
    clearSkillLink: async () => ({ success: true }),
    getInstalledSkillSource: async () => ({ success: true, source: null }),
    listPublished: async (type) => {
      calls.push(["listPublished", type]);
      return { success: true, data: { solutions: ownedSolutions } };
    },
    listSkillLinks: async () => ({ success: true, links: skillLinks }),
    markSkillLinkDirty: async () => ({ success: true }),
  };

  windowObject.electronAPI = {
    invokeMcpTool: async (serverId, tool, input) => {
      calls.push(["invokeMcpTool", tool, input]);
      if (tool === "subagents_list_agents") {
        return {
          success: true,
          data: { agents: input?.filter_type === "base" ? baseModels : agents },
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
    logToMain: () => {},
    openExternal: () => {},
    aiMarketplace: api,
    notifyAiMarketplacePublishConfirmCompleted: (payload) => {
      completions.push(payload);
    },
    setNativeInputPresentation: async (payload) => {
      presentations.push(payload);
      return presentationImpl ? presentationImpl(payload) : { success: true };
    },
    onNativeInputReopenRequested: (cb) => {
      reopenCallbacks.push(cb);
    },
    onNativeInputTerminal: (cb) => {
      terminalCallbacks.push(cb);
    },
  };
  windowObject.showNotification = (message, kind = "info") => {
    notifications.push([kind, message]);
  };
  return {
    calls,
    notifications,
    completions,
    presentations,
    fireReopen: (payload) => reopenCallbacks.forEach((cb) => cb(payload)),
    fireTerminal: (payload) => terminalCallbacks.forEach((cb) => cb(payload)),
  };
}

const localAgent = (id, extra = {}) => ({
  id,
  name: extra.name || id,
  description: extra.description || `${id} description`,
  base_model_id: "claude-sonnet-5",
  system_prompt: `You are ${id}.`,
  skill_ids: [],
  tool_server_ids: [],
  creation_source: "local",
  created_by_email: "dsantiago@example.invalid",
  ...extra,
});

const backendPayload = (overrides = {}) => ({
  flow_id: "flow-1",
  mode: "publish-agent",
  title: "Publish agent",
  confirm_label: "Publish",
  summary: "This shares the agent.",
  allowed_emails: [],
  republish: false,
  agent: { id: "agent-1", name: "Agent One", skill_ids: [], tool_server_ids: [] },
  timeout_seconds: 90,
  ...overrides,
});

async function settle(rounds = 10) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// ---------------------------------------------------------------------------

test("a chat publish request runs the consolidated modal and reports the published result", async () => {
  const h = loadAgentsModuleHarness();
  const fx = installBackendPublishFixture(h.window, {
    agents: [localAgent("agent-1", { name: "Agent One" })],
  });

  const flowPromise =
    h.window.AgentsTabModule.publishAgentFromBackendRequest(backendPayload());
  await settle();

  const overlay = h.document.getElementById("agents-modal-overlay");
  assert.ok(overlay.parentElement, "the control-plane publish modal opened");
  assert.match(overlay.innerHTML, /Publish agent/);
  assert.match(
    overlay.innerHTML,
    /agents-publish-skill-provenance/,
    "the SKILLS plan table is part of the chat-initiated modal",
  );
  // The Skills section label carries the pinned-skills info tooltip (round 11).
  assert.match(overlay.innerHTML, /info-tooltip-trigger/);
  assert.match(overlay.innerHTML, /Without pinned skills, this agent picks its own tools per session/);
  assert.match(overlay.innerHTML, /agents-modal-hide/, "hide-to-chat eye button present");
  // Safety chrome: chat is suppressed under the modal, focus lands on Cancel
  // so a buffered Enter cannot approve the LLM-initiated write.
  assert.deepEqual(h.suppressions[0], ["agents-publish-modal", true]);
  assert.ok(overlay.querySelector(".agents-modal-cancel").focusCount >= 1);

  overlay.querySelector(".agents-modal-submit").click();
  await flowPromise;

  assert.deepEqual(
    fx.completions.map((c) => c.action),
    ["publishing", "published"],
    "two-phase completion: publishing marker, then the published terminal",
  );
  const published = fx.completions.at(-1);
  assert.equal(published.flow_id, "flow-1");
  assert.equal(published.result.solution_id, "sol-published");
  assert.equal(published.result.action, "created");
  assert.equal(published.result.local_agent_id, "agent-1");
  // Spread: vm-realm objects are not reference-equal for deepStrictEqual.
  assert.deepEqual({ ...published.result.dependent_skills }, {
    published: 0,
    updated: 0,
    adopted: 0,
    referenced: 0,
    unchanged: 0,
    gitReferenced: 0,
    repaired: 0,
    visibilityUpdated: 0,
  });
  assert.match(published.result.message, /published to the AI Marketplace/);
  // Skill-less agents still carry the (empty) per-skill row array so the
  // envelope shape is stable for chat models.
  assert.deepEqual(JSON.parse(JSON.stringify(published.result.skills)), []);
  assert.ok(
    fx.calls.some(([name]) => name === "publish"),
    "the publish executed in the renderer pipeline",
  );
  assert.ok(!h.document.body.children.includes(overlay), "modal closed on success");
  assert.deepEqual(h.suppressions.at(-1), ["agents-publish-modal", false]);
});

// PORTICO-347: the completion envelope names each dependent skill with its
// outcome and marketplace solution id — the chat proxy serves this envelope
// verbatim, so models copy ids from here instead of re-listing.
test("a backend publish reports each dependent skill's identity in the completion envelope", async () => {
  const h = loadAgentsModuleHarness();
  const fx = installBackendPublishFixture(h.window, {
    agents: [localAgent("agent-1", { name: "Agent One", skill_ids: ["alpha"] })],
    skills: [
      {
        name: "alpha",
        source: "user",
        skill_path: "/tmp/skills-user/alpha",
        description: "alpha description",
      },
    ],
    publishImpl: (input, opts) =>
      opts?.localSkillId
        ? { success: true, data: { id: `sol-skill-${opts.localSkillId}` } }
        : {
            success: true,
            data: { id: "sol-published" },
            publishStatus: { id: "sol-published", status: "active", has_bundle: true },
          },
  });

  const flowPromise = h.window.AgentsTabModule.publishAgentFromBackendRequest(
    backendPayload({
      agent: {
        id: "agent-1",
        name: "Agent One",
        skill_ids: ["alpha"],
        tool_server_ids: [],
      },
    }),
  );
  await settle();
  const overlay = h.document.getElementById("agents-modal-overlay");
  overlay.querySelector(".agents-modal-submit").click();
  await flowPromise;

  const published = fx.completions.at(-1);
  assert.equal(published.action, "published");
  assert.equal(published.result.dependent_skills.published, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(published.result.skills)), [
    { skill_id: "alpha", outcome: "published", solution_id: "sol-skill-alpha" },
  ]);
  assert.ok(
    fx.calls.some(
      ([name, , opts]) => name === "publish" && opts?.localSkillId === "alpha",
    ),
    "the dependent skill published in the renderer pipeline",
  );
});

test("dismissing the chat-initiated modal denies the flow exactly once", async () => {
  const h = loadAgentsModuleHarness();
  const fx = installBackendPublishFixture(h.window, {
    agents: [localAgent("agent-1")],
  });

  const flowPromise =
    h.window.AgentsTabModule.publishAgentFromBackendRequest(backendPayload());
  await settle();
  const overlay = h.document.getElementById("agents-modal-overlay");
  const cancel = overlay.querySelector(".agents-modal-cancel");
  cancel.click();
  cancel.click(); // double-click must not double-complete
  await flowPromise;

  assert.deepEqual(fx.completions.map((c) => c.action), ["dismissed"]);
  assert.equal(fx.completions[0].flow_id, "flow-1");
  assert.ok(!fx.calls.some(([name]) => name === "publish"), "nothing was published");
  assert.deepEqual(h.suppressions.at(-1), ["agents-publish-modal", false]);
});

test("a missing marketplace API key completes the flow with an agent-actionable code", async () => {
  const h = loadAgentsModuleHarness();
  const fx = installBackendPublishFixture(h.window, {
    agents: [localAgent("agent-1")],
    hasApiKey: false,
  });

  await h.window.AgentsTabModule.publishAgentFromBackendRequest(backendPayload());

  assert.equal(fx.completions.length, 1);
  assert.equal(fx.completions[0].action, "error");
  assert.equal(fx.completions[0].code, "marketplace_api_key_missing");
  assert.match(fx.completions[0].error, /API key/);
});

// ---------------------------------------------------------------------------
// executeBackendAgentPublish: the headless executor the BATCH approval modal
// runs per approved agent item. Same pipeline as the consolidated modal's
// submit, no modal chrome, and the return value is the exact "published"
// result envelope shape.
// ---------------------------------------------------------------------------

test("executeBackendAgentPublish publishes headlessly and returns the envelope-shaped result", async () => {
  const h = loadAgentsModuleHarness();
  const fx = installBackendPublishFixture(h.window, {
    agents: [localAgent("agent-1", { name: "Agent One" })],
  });

  const result = await h.window.AgentsPublishHooks.executeBackendAgentPublish({
    agentId: "agent-1",
    allowedEmailsOverride: ["teammate@example.invalid"],
  });

  assert.equal(result.solution_id, "sol-published");
  assert.equal(result.action, "created");
  assert.equal(result.local_agent_id, "agent-1");
  assert.equal(result.name, "Agent One");
  assert.deepEqual({ ...result.dependent_skills }, {
    published: 0,
    updated: 0,
    adopted: 0,
    referenced: 0,
    unchanged: 0,
    gitReferenced: 0,
    repaired: 0,
    visibilityUpdated: 0,
  });
  assert.match(result.message, /published to the AI Marketplace/);
  assert.deepEqual(JSON.parse(JSON.stringify(result.skills)), []);
  // The publish ran through the renderer pipeline with the override audience
  // (plus the creator, per the ONE-audience rule)…
  const publishCall = fx.calls.find(([name]) => name === "publish");
  assert.ok(publishCall, "publish executed in the renderer pipeline");
  assert.ok(
    JSON.parse(JSON.stringify(publishCall[1].allowed_emails)).includes(
      "teammate@example.invalid",
    ),
  );
  // …and never touched the flow-completion channel — the batch modal owns
  // per-item completions.
  assert.equal(fx.completions.length, 0);
  const overlay = h.document.getElementById("agents-modal-overlay");
  assert.ok(!overlay?.parentElement, "no modal chrome");
});

test("resolveBackendAgentPublishSkillPlan mirrors the executor audience and annotates work", async () => {
  const h = loadAgentsModuleHarness();
  installBackendPublishFixture(h.window, {
    agents: [
      localAgent("agent-1", {
        skill_ids: ["alpha"],
        allowed_emails: ["viewer@example.invalid"],
      }),
    ],
    skills: [{ name: "alpha", skill_path: "/skills/alpha", source: "system" }],
  });

  const plan = await h.window.AgentsPublishHooks.resolveBackendAgentPublishSkillPlan({
    agentId: "agent-1",
    allowedEmailsOverride: ["teammate@example.invalid"],
  });

  const audience = JSON.parse(JSON.stringify(plan.publishAudience));
  assert.ok(audience.includes("teammate@example.invalid"), "the override wins");
  assert.ok(!audience.includes("viewer@example.invalid"), "saved visibility is replaced");
  assert.ok(
    audience.length >= 2,
    "the creator joins the audience (ONE-audience rule, same as the executor)",
  );
  assert.deepEqual(JSON.parse(JSON.stringify(plan.skillIds)), ["alpha"]);
  assert.equal(plan.plans.length, 1);
  assert.equal(plan.plans[0].action, "system");
  assert.equal(
    plan.plans[0].hasMarketplaceWork,
    false,
    "built-in skills carry no marketplace work (the ticker never flips them)",
  );
  assert.deepEqual(JSON.parse(JSON.stringify(plan.errors)), []);
});

test("executeBackendAgentPublish forwards the pre-resolved plan and streams progress", async () => {
  const h = loadAgentsModuleHarness();
  const fx = installBackendPublishFixture(h.window, {
    agents: [localAgent("agent-1", { name: "Agent One" })],
  });

  const events = [];
  const result = await h.window.AgentsPublishHooks.executeBackendAgentPublish({
    agentId: "agent-1",
    resolvedSkillPlan: [],
    onProgress: (event) => events.push(event.phase),
  });

  assert.equal(result.solution_id, "sol-published");
  // No dependent skills: the only cascade event is the agent-write handoff —
  // proof the callback reaches pushAgentToMarketplace intact.
  assert.deepEqual(JSON.parse(JSON.stringify(events)), ["agent:start"]);
  assert.equal(fx.completions.length, 0);
});

test("executeBackendAgentPublish throws the agent-actionable api-key code", async () => {
  const h = loadAgentsModuleHarness();
  installBackendPublishFixture(h.window, {
    agents: [localAgent("agent-1")],
    hasApiKey: false,
  });
  await assert.rejects(
    h.window.AgentsPublishHooks.executeBackendAgentPublish({ agentId: "agent-1" }),
    (error) => {
      assert.equal(error.code, "marketplace_api_key_missing");
      assert.match(error.message, /API key is not set/);
      return true;
    },
  );
});

test("a chat publish request never stomps a dialog the user already has open", async () => {
  const h = loadAgentsModuleHarness();
  const fx = installBackendPublishFixture(h.window, {
    agents: [localAgent("agent-1")],
  });

  // The user opened the publish modal themselves…
  const userFlow = h.window.AgentsTabModule.publishAgent("agent-1");
  await settle();
  const overlay = h.document.getElementById("agents-modal-overlay");
  assert.ok(overlay.parentElement, "user modal open");
  const userOverlayHtml = overlay.innerHTML;

  // …then the chat asks to publish: structured busy error, user modal intact.
  await h.window.AgentsTabModule.publishAgentFromBackendRequest(
    backendPayload({ flow_id: "flow-busy" }),
  );
  assert.equal(fx.completions.length, 1);
  assert.equal(fx.completions[0].action, "error");
  assert.equal(fx.completions[0].code, "publish_ui_busy");
  assert.equal(fx.completions[0].flow_id, "flow-busy");
  assert.ok(overlay.parentElement, "the user's modal was not destroyed");
  assert.equal(overlay.innerHTML, userOverlayHtml);

  overlay.querySelector(".agents-modal-cancel").click();
  await userFlow;
});

test("a chat publish request fails fast while the batch approval modal is active", async () => {
  const h = loadAgentsModuleHarness();
  const fx = installBackendPublishFixture(h.window, {
    agents: [localAgent("agent-1")],
  });
  // The batch approval modal (z 10001) renders ABOVE the agents overlay
  // (z 1000): opening the consolidated dialog underneath it would be
  // un-interactable, so the seam rejects with the same retryable busy code.
  h.window.AiMarketplacePublishBatch = { isActive: () => true };

  await h.window.AgentsTabModule.publishAgentFromBackendRequest(
    backendPayload({ flow_id: "flow-batch-busy" }),
  );
  assert.equal(fx.completions.length, 1);
  assert.equal(fx.completions[0].action, "error");
  assert.equal(fx.completions[0].code, "publish_ui_busy");
  assert.match(fx.completions[0].error, /marketplace approval dialog/i);
  const overlay = h.document.getElementById("agents-modal-overlay");
  assert.ok(!overlay?.parentElement, "the consolidated modal never opened");
});

test("a failed publish reports publish_failed once and leaves the modal open for a plain retry", async () => {
  const h = loadAgentsModuleHarness();
  let publishAttempts = 0;
  const fx = installBackendPublishFixture(h.window, {
    agents: [localAgent("agent-1", { name: "Agent One" })],
    publishImpl: () => {
      publishAttempts += 1;
      if (publishAttempts === 1) {
        return { success: false, error: "marketplace exploded" };
      }
      return {
        success: true,
        data: { id: "sol-retry" },
        publishStatus: { id: "sol-retry", status: "active", has_bundle: true },
      };
    },
  });

  const flowPromise =
    h.window.AgentsTabModule.publishAgentFromBackendRequest(backendPayload());
  await settle();
  const overlay = h.document.getElementById("agents-modal-overlay");
  overlay.querySelector(".agents-modal-submit").click();
  await flowPromise;

  assert.deepEqual(
    fx.completions.map((c) => c.action),
    ["publishing", "publish_failed"],
  );
  assert.match(fx.completions.at(-1).error, /marketplace exploded/);
  assert.ok(overlay.parentElement, "the modal stays open for a manual retry");
  assert.match(
    overlay.querySelector(".agents-modal-error").textContent,
    /marketplace exploded/,
  );

  // The manual retry is a plain control-plane publish: it succeeds without
  // sending the settled flow anything new.
  overlay.querySelector(".agents-modal-submit").click();
  await settle(20);
  assert.equal(publishAttempts, 2, "the retry re-ran the publish");
  assert.deepEqual(
    fx.completions.map((c) => c.action),
    ["publishing", "publish_failed"],
    "the settled flow hears nothing further",
  );
  assert.ok(!h.document.body.children.includes(overlay), "retry success closes the modal");
});

test("the eye button stows the modal into the chat pill and the reopen event restores it", async () => {
  const h = loadAgentsModuleHarness();
  const fx = installBackendPublishFixture(h.window, {
    agents: [localAgent("agent-1")],
  });

  const flowPromise =
    h.window.AgentsTabModule.publishAgentFromBackendRequest(backendPayload());
  await settle();
  const overlay = h.document.getElementById("agents-modal-overlay");

  overlay.querySelector(".agents-modal-hide").click();
  await settle();
  assert.equal(overlay.style.display, "none", "the modal is stowed, not closed");
  assert.deepEqual(
    fx.presentations.map((p) => ({ ...p })),
    [
      {
        kind: "marketplace_publish",
        flow_id: "flow-1",
        presentation: "hidden",
      },
    ],
  );
  assert.deepEqual(h.suppressions.at(-1), ["agents-publish-modal", false]);

  fx.fireReopen({ kind: "marketplace_publish", flow_id: "flow-1" });
  assert.equal(overlay.style.display, "", "reopen restores the modal");
  assert.deepEqual(h.suppressions.at(-1), ["agents-publish-modal", true]);

  // Mismatched reopen events are ignored.
  overlay.querySelector(".agents-modal-hide").click();
  await settle();
  fx.fireReopen({ kind: "user_question", flow_id: "flow-1" });
  fx.fireReopen({ kind: "marketplace_publish", flow_id: "flow-OTHER" });
  assert.equal(overlay.style.display, "none");

  fx.fireReopen({ kind: "marketplace_publish", flow_id: "flow-1" });
  overlay.querySelector(".agents-modal-cancel").click();
  await flowPromise;
  assert.equal(fx.completions.at(-1).action, "dismissed");
});

test("a main-side terminal before any decision closes the modal without a completion", async () => {
  const h = loadAgentsModuleHarness();
  const fx = installBackendPublishFixture(h.window, {
    agents: [localAgent("agent-1")],
  });

  const flowPromise =
    h.window.AgentsTabModule.publishAgentFromBackendRequest(backendPayload());
  await settle();
  const overlay = h.document.getElementById("agents-modal-overlay");
  assert.ok(overlay.parentElement);

  // Main timed the flow out (auto-deny): the renderer modal folds quietly.
  fx.fireTerminal({ kind: "marketplace_publish", flow_id: "flow-1", status: "timeout" });
  await flowPromise;

  assert.deepEqual(fx.completions, [], "no completion is sent for a main-side terminal");
  assert.ok(!h.document.body.children.includes(overlay), "the modal closed");
  assert.deepEqual(h.suppressions.at(-1), ["agents-publish-modal", false]);
});

test("control-plane publishes never touch the backend completion channel", async () => {
  const h = loadAgentsModuleHarness();
  const fx = installBackendPublishFixture(h.window, {
    agents: [localAgent("agent-1")],
  });

  await h.window.AgentsTabModule.publishAgent("agent-1");
  await settle();
  const overlay = h.document.getElementById("agents-modal-overlay");
  overlay.querySelector(".agents-modal-submit").click();
  await settle(20);

  assert.ok(
    fx.calls.some(([name]) => name === "publish"),
    "the control-plane publish ran",
  );
  assert.deepEqual(fx.completions, [], "no flow completions without a backendFlow");
  assert.deepEqual(fx.presentations, []);
});

test("chat-supplied allowed_emails override the saved visibility for this publish", async () => {
  const h = loadAgentsModuleHarness();
  const fx = installBackendPublishFixture(h.window, {
    agents: [
      localAgent("agent-1", { name: "Agent One", allowed_emails: [] }),
    ],
  });

  const flowPromise = h.window.AgentsTabModule.publishAgentFromBackendRequest(
    backendPayload({ allowed_emails: ["teammate@example.invalid"] }),
  );
  await settle();
  const overlay = h.document.getElementById("agents-modal-overlay");
  assert.match(
    overlay.innerHTML,
    /Restricted to teammate@example\.invalid/,
    "the modal shows the overridden visibility the user is approving",
  );
  overlay.querySelector(".agents-modal-submit").click();
  await flowPromise;

  const publishCall = fx.calls.find(([name]) => name === "publish");
  assert.ok(publishCall);
  // The creator is always appended to a restricted allow-list so the
  // publisher never locks themselves out (withCreatorAllowedEmail).
  assert.deepEqual(
    [...publishCall[1].allowed_emails],
    ["teammate@example.invalid", "dsantiago@example.invalid"],
  );
});

// ---------------------------------------------------------------------------
// Dev-only auto-approve (backendFlow.autoApprove rides the agentic payload
// only on dev builds with the bug-drawer toggle on): the consolidated modal
// self-submits ~1s after it comes up, deferring past the disabled-submit
// window while the dependent-skill plan resolves. Manual publishes and
// unflagged backend flows never self-approve.
// ---------------------------------------------------------------------------

const AUTO_APPROVE_RACE_MS = 10000;
const raceAutoApprove = (promise, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} never settled`)), AUTO_APPROVE_RACE_MS),
    ),
  ]);

test("an auto_approve chat publish self-submits ~1s after the modal opens", async () => {
  const h = loadAgentsModuleHarness();
  const fx = installBackendPublishFixture(h.window, {
    agents: [localAgent("agent-1", { name: "Agent One" })],
  });

  const flowPromise = h.window.AgentsTabModule.publishAgentFromBackendRequest(
    backendPayload({ auto_approve: true }),
  );
  await settle();
  const overlay = h.document.getElementById("agents-modal-overlay");
  assert.ok(overlay.parentElement, "the modal opened and waits for the timer");
  assert.equal(fx.completions.length, 0, "nothing completes before the 1s delay");
  // Focus landed on Cancel and stays there — the auto-click never focuses.
  assert.ok(overlay.querySelector(".agents-modal-cancel").focusCount >= 1);

  await raceAutoApprove(flowPromise, "agents auto-approve");
  assert.deepEqual(
    fx.completions.map((c) => c.action),
    ["publishing", "published"],
    "the auto-click ran the full two-phase publish with no manual click",
  );
  assert.equal(fx.completions.at(-1).result.solution_id, "sol-published");
  assert.ok(!h.document.body.children.includes(overlay), "modal closed on success");
});

test("auto-approve defers past the disabled submit until the skill plan resolves", async () => {
  const h = loadAgentsModuleHarness();
  const fx = installBackendPublishFixture(h.window, {
    agents: [localAgent("agent-1", { skill_ids: ["alpha"] })],
    skills: [{ name: "alpha", skill_path: "/skills/alpha", source: "system" }],
  });
  // The dependent-skill plan blocks on the skills catalog: keep it pending
  // well past the 1s auto-approve window.
  const originalGetSkills = h.window.electronAPI.getSkills;
  h.window.electronAPI.getSkills = async () => {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return originalGetSkills();
  };

  const flowPromise = h.window.AgentsTabModule.publishAgentFromBackendRequest(
    backendPayload({ auto_approve: true }),
  );
  await settle();
  const overlay = h.document.getElementById("agents-modal-overlay");
  const submitBtn = overlay.querySelector(".agents-modal-submit");
  assert.equal(submitBtn.disabled, true, "submit locked while the plan resolves");

  // Past the 1s timer but before the plan resolves: the deferred click must
  // NOT have fired (a naive click() would be swallowed in a real DOM and
  // would publish prematurely in this fake one).
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.equal(fx.completions.length, 0, "no completion while submit is disabled");
  assert.equal(submitBtn.disabled, true);

  await raceAutoApprove(flowPromise, "deferred auto-approve");
  assert.deepEqual(
    fx.completions.map((c) => c.action),
    ["publishing", "published"],
    "the deferred click fired exactly once when the plan unlocked the button",
  );
});

test("unflagged backend flows never self-approve", async () => {
  const h = loadAgentsModuleHarness();
  const fx = installBackendPublishFixture(h.window, {
    agents: [localAgent("agent-1")],
  });

  const flowPromise =
    h.window.AgentsTabModule.publishAgentFromBackendRequest(backendPayload());
  await settle();
  const overlay = h.document.getElementById("agents-modal-overlay");

  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.equal(fx.completions.length, 0, "still waiting on the user");
  assert.ok(overlay.parentElement, "the modal stayed open");

  overlay.querySelector(".agents-modal-cancel").click();
  await flowPromise;
  assert.deepEqual(fx.completions.map((c) => c.action), ["dismissed"]);
});

test("manual control-plane publishes never self-approve even with the dev toggle on", async () => {
  const h = loadAgentsModuleHarness();
  const fx = installBackendPublishFixture(h.window, {
    agents: [localAgent("agent-1")],
  });

  // Manual click path: no backendFlow, so there is nothing to carry the
  // auto_approve flag — the modal must sit untouched past the 1s window.
  const userFlow = h.window.AgentsTabModule.publishAgent("agent-1");
  await settle();
  const overlay = h.document.getElementById("agents-modal-overlay");
  assert.ok(overlay.parentElement, "user modal open");

  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.deepEqual(fx.completions, [], "no backend completions for manual publishes");
  assert.ok(
    !fx.calls.some(([name]) => name === "publish"),
    "nothing was published without the user's click",
  );
  assert.ok(overlay.parentElement, "the modal still waits on the user");

  overlay.querySelector(".agents-modal-cancel").click();
  await userFlow;
});

test("a user cancel inside the auto-approve window wins and no late click fires", async () => {
  const h = loadAgentsModuleHarness();
  const fx = installBackendPublishFixture(h.window, {
    agents: [localAgent("agent-1")],
  });

  const flowPromise = h.window.AgentsTabModule.publishAgentFromBackendRequest(
    backendPayload({ auto_approve: true }),
  );
  await settle();
  const overlay = h.document.getElementById("agents-modal-overlay");

  await new Promise((resolve) => setTimeout(resolve, 300));
  overlay.querySelector(".agents-modal-cancel").click();
  await flowPromise;
  assert.deepEqual(fx.completions.map((c) => c.action), ["dismissed"]);

  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.deepEqual(
    fx.completions.map((c) => c.action),
    ["dismissed"],
    "the cleared timer never publishes after a dismissal",
  );
  assert.ok(!fx.calls.some(([name]) => name === "publish"));
});

test("stowing the modal cancels auto-approve; reopen re-arms it", async () => {
  const h = loadAgentsModuleHarness();
  const fx = installBackendPublishFixture(h.window, {
    agents: [localAgent("agent-1")],
  });

  const flowPromise = h.window.AgentsTabModule.publishAgentFromBackendRequest(
    backendPayload({ auto_approve: true }),
  );
  await settle();
  const overlay = h.document.getElementById("agents-modal-overlay");

  await new Promise((resolve) => setTimeout(resolve, 300));
  overlay.querySelector(".agents-modal-hide").click();
  await settle();
  assert.equal(overlay.style.display, "none", "the modal is stowed");

  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.equal(fx.completions.length, 0, "stowed modals never self-approve");

  fx.fireReopen({ kind: "marketplace_publish", flow_id: "flow-1" });
  assert.equal(overlay.style.display, "", "reopen restores the modal");
  await raceAutoApprove(flowPromise, "reopen auto-approve");
  assert.deepEqual(
    fx.completions.map((c) => c.action),
    ["publishing", "published"],
    "the re-armed timer approved after the reopen",
  );
});

// ---------------------------------------------------------------------------
// PORTICO-414: email-less identity in backend flows — silent repair only, one
// coded completion, and headless callers keep their throw contract.
// ---------------------------------------------------------------------------

const CREATOR_EMAIL_UNAVAILABLE_COPY =
  "Publishing is blocked because your signed-in account did not provide an email address. Sign in again when prompted, or restart the app, then retry.";

test("a chat publish with restricted visibility and an unrepairable identity completes once with the coded error and never goes interactive", async () => {
  const h = loadAgentsModuleHarness();
  const fx = installBackendPublishFixture(h.window, {
    agents: [localAgent("agent-1", { name: "Agent One" })],
  });
  let repairCalls = 0;
  let interactiveCalls = 0;
  h.window.electronAPI.currentUser = {
    get: async () => ({
      authenticated: true,
      sessionSummary: { user: { email: null } },
    }),
    repairIdentity: async () => {
      repairCalls += 1;
      return { authenticated: true, repaired: false, emailUnavailable: true };
    },
    ensureAuthenticated: async () => {
      interactiveCalls += 1;
      return { success: true, authenticated: true };
    },
  };

  await h.window.AgentsTabModule.publishAgentFromBackendRequest(
    backendPayload({
      flow_id: "flow-email",
      allowed_emails: ["teammate@example.invalid"],
    }),
  );
  await settle();

  assert.equal(repairCalls, 1, "the silent repair was attempted");
  assert.equal(
    interactiveCalls,
    0,
    "chat-initiated flows never open a browser re-auth",
  );
  const errorCompletions = fx.completions.filter(
    (entry) => entry.action === "error",
  );
  assert.equal(errorCompletions.length, 1, "exactly one terminal completion");
  assert.equal(errorCompletions[0].flow_id, "flow-email");
  assert.equal(errorCompletions[0].code, "creator_email_unavailable");
  assert.equal(errorCompletions[0].error, CREATOR_EMAIL_UNAVAILABLE_COPY);
  const overlay = h.document.getElementById("agents-modal-overlay");
  assert.ok(!overlay?.parentElement, "no modal for the failed flow");
});

test("a chat publish with restricted visibility heals through the silent repair and opens the modal", async () => {
  const h = loadAgentsModuleHarness();
  const fx = installBackendPublishFixture(h.window, {
    agents: [localAgent("agent-1", { name: "Agent One" })],
  });
  let email = null;
  h.window.electronAPI.currentUser = {
    get: async () => ({
      authenticated: true,
      sessionSummary: { user: { email } },
    }),
    repairIdentity: async () => {
      email = "dsantiago@example.invalid";
      return { authenticated: true, repaired: true };
    },
    ensureAuthenticated: async () => {
      throw new Error("chat flows must not reach interactive re-auth");
    },
  };

  const flowPromise = h.window.AgentsTabModule.publishAgentFromBackendRequest(
    backendPayload({
      flow_id: "flow-healed",
      allowed_emails: ["teammate@example.invalid"],
    }),
  );
  await settle(20);

  const overlay = h.document.getElementById("agents-modal-overlay");
  assert.ok(overlay.parentElement, "the modal opened after the heal");
  assert.equal(
    fx.completions.filter((entry) => entry.action === "error").length,
    0,
  );

  overlay.querySelector(".agents-modal-cancel").click();
  await flowPromise;
});

test("headless backend publish throws the coded email failure without attempting any heal", async () => {
  const h = loadAgentsModuleHarness();
  installBackendPublishFixture(h.window, {
    agents: [
      localAgent("agent-1", { allowed_emails: ["teammate@example.invalid"] }),
    ],
  });
  let repairCalls = 0;
  let interactiveCalls = 0;
  h.window.electronAPI.currentUser = {
    get: async () => ({
      authenticated: true,
      sessionSummary: { user: { email: null } },
    }),
    repairIdentity: async () => {
      repairCalls += 1;
      return { authenticated: true, repaired: true };
    },
    ensureAuthenticated: async () => {
      interactiveCalls += 1;
      return { success: true };
    },
  };

  await assert.rejects(
    h.window.AgentsPublishHooks.executeBackendAgentPublish({ agentId: "agent-1" }),
    (error) => {
      assert.equal(error.code, "creator_email_unavailable");
      assert.match(error.message, /authenticated email is unavailable/);
      return true;
    },
  );
  assert.equal(repairCalls, 0, "headless callers never trigger the repair");
  assert.equal(interactiveCalls, 0, "headless callers never go interactive");
});
