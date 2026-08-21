// Deleted-agent link prune, soft-miss edition (Chat UI + State & Persistence).
// 2026-08-08 incident: an access flap made subagents_list_agents return a
// PARTIAL list and the prune hard-deleted the links for two read-only
// installed agents on a single missed sighting. The rewrite must: keep the
// empty-list fail-safe, repair access + re-list before judging a miss, hand
// the verdict to the store's sightings policy, remove ONLY store-confirmed
// deletions from local state, and never fall back to hard deletes when the
// sightings channel is unavailable.
//
// Renderer behavior is driven through the real agents.js module in a vm
// harness (loadAgentsModuleHarness pattern from agents-tab-overhaul).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

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

// Loads the real agents.js in a vm realm with a scripted electronAPI:
// - listAgentQueues: successive subagents_list_agents responses (the prune's
//   recheck consumes the second entry)
// - sightingsResponses: successive ai-marketplace-link-report-sightings
//   results (undefined models a stale preload without the channel)
// - linksByCall: successive listLinks payloads (the prune re-fetches after a
//   report changes something)
function loadPruneHarness({
  listAgentQueues = [],
  sightingsResponses = [],
  linksByCall = [],
  includeSightingsChannel = true,
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
  const sightingsCalls = [];
  const repairCalls = [];
  const clearLinkCalls = [];
  let listAgentCallCount = 0;
  let sightingsCallCount = 0;
  let listLinksCallCount = 0;
  const aiMarketplace = {
    listLinks: async () => {
      const payload =
        linksByCall[Math.min(listLinksCallCount, linksByCall.length - 1)] || {};
      listLinksCallCount += 1;
      return { success: true, links: payload };
    },
    clearLink: async (agentId) => {
      clearLinkCalls.push(agentId);
      return { success: true };
    },
    repairLinkedAgentAccess: async (options) => {
      repairCalls.push(options?.reason || "");
      return { success: true, result: { checked: 1, repaired: 0, repairedAgentIds: [] } };
    },
  };
  if (includeSightingsChannel) {
    aiMarketplace.reportLinkSightings = async (sightings) => {
      sightingsCalls.push(sightings);
      const scripted = sightingsResponses[sightingsCallCount];
      sightingsCallCount += 1;
      return (
        scripted || { success: true, healed: [], flagged: [], deleted: [] }
      );
    };
  }
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
          const queue =
            listAgentQueues[Math.min(listAgentCallCount, listAgentQueues.length - 1)] || [];
          listAgentCallCount += 1;
          return { success: true, data: { agents: queue } };
        }
        return { success: true, data: {} };
      },
      getSkills: async () => ({ success: true, skills: [] }),
      loadMcpServers: async () => ({ success: true, data: [] }),
      listAgentFlags: async () => ({ success: true, flags: {} }),
      getUsername: async () => ({ username: "dsantiago" }),
      currentUser: { get: async () => undefined },
      aiMarketplace,
    },
    showNotification() {},
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
      constructor() {
        this.fields = [];
      }

      entries() {
        return this.fields[Symbol.iterator]();
      }

      get() {
        return null;
      }
    },
  };
  context.globalThis = context;

  for (const extra of extraSources) {
    vm.runInNewContext(extra.source, context, { filename: extra.path });
  }
  vm.runInNewContext(source, context, { filename: agentsPath });

  const hooks = windowObject.AgentsTabRenderHooks;
  return {
    window: windowObject,
    hooks,
    calls,
    sightingsCalls,
    repairCalls,
    clearLinkCalls,
    setLinks: (links) => hooks.setMarketplaceLinksForTests(links),
    getLinks: () => hooks.marketplaceLinksForTests(),
    // The Set must be born INSIDE the realm: the prune's `instanceof Set`
    // guard rejects a host-realm Set (cross-realm identity), silently
    // early-returning. agentIdsFromListResponse builds it realm-side.
    prune: (ids) =>
      hooks.pruneMarketplaceLinksToExistingAgents(
        hooks.agentIdsFromListResponse({ agents: ids.map((id) => ({ id })) }),
      ),
  };
}

// vm-realm gotcha: objects born inside the realm are not reference-equal to
// host literals under deepEqual — compare scalar + copied array instead.
function assertPruneResult(result, pruned, prunedAgentIds) {
  assert.equal(result.pruned, pruned);
  assert.deepEqual(Array.from(result.prunedAgentIds), prunedAgentIds);
}

const LINKS_TWO = {
  "research-assistant": { solutionId: "sol-research", relationship: "installed" },
  "smart-slides": { solutionId: "sol-slides", relationship: "installed" },
};

test("empty agents list never prunes (2026-08-04 fail-safe retained)", async () => {
  const h = loadPruneHarness();
  h.setLinks({ ...LINKS_TWO });
  const result = await h.prune([]);
  assertPruneResult(result, 0, []);
  assert.equal(h.sightingsCalls.length, 0);
  assert.equal(h.repairCalls.length, 0);
  assert.equal(Object.keys(h.getLinks()).length, 2);
});

test("steady state (all present, nothing flagged) makes zero IPC calls", async () => {
  const h = loadPruneHarness();
  h.setLinks({ ...LINKS_TWO });
  const result = await h.prune(["research-assistant", "smart-slides"]);
  assertPruneResult(result, 0, []);
  assert.equal(h.sightingsCalls.length, 0);
  assert.equal(h.repairCalls.length, 0);
  assert.equal(h.calls.length, 0);
});

test("a miss repairs access, re-lists, and a reappearance reports the agent PRESENT", async () => {
  const h = loadPruneHarness({
    // Recheck (the queue's only entry) sees the agent again post-repair.
    listAgentQueues: [[{ id: "research-assistant" }, { id: "smart-slides" }]],
  });
  h.setLinks({ ...LINKS_TWO });
  // First read missed research-assistant (partial-list flap).
  const result = await h.prune(["smart-slides"]);
  assertPruneResult(result, 0, []);
  assert.deepEqual(h.repairCalls, ["link-prune-miss"]);
  assert.equal(h.sightingsCalls.length, 1);
  assert.deepEqual(Array.from(h.sightingsCalls[0].presentIds).sort(), [
    "research-assistant",
    "smart-slides",
  ]);
  assert.deepEqual(Array.from(h.sightingsCalls[0].absentIds), []);
  assert.equal(Object.keys(h.getLinks()).length, 2);
});

test("a persistent miss is reported absent and the link is FLAGGED locally, not removed", async () => {
  const flaggedLinks = {
    ...LINKS_TWO,
    "research-assistant": {
      ...LINKS_TWO["research-assistant"],
      missingSince: "2026-08-08T04:20:53.000Z",
      missCount: 1,
    },
  };
  const h = loadPruneHarness({
    listAgentQueues: [[{ id: "smart-slides" }]],
    sightingsResponses: [
      { success: true, healed: [], flagged: ["research-assistant"], deleted: [] },
    ],
    linksByCall: [flaggedLinks],
  });
  h.setLinks({ ...LINKS_TWO });
  const result = await h.prune(["smart-slides"]);
  assertPruneResult(result, 0, []);
  assert.deepEqual(Array.from(h.sightingsCalls[0].absentIds), ["research-assistant"]);
  // Local state refreshed from the store: link kept, now carrying the flag.
  assert.equal(h.getLinks()["research-assistant"].missingSince, "2026-08-08T04:20:53.000Z");
  assert.equal(h.clearLinkCalls.length, 0);
});

test("only a store-CONFIRMED deletion leaves local state", async () => {
  const afterDelete = { "smart-slides": LINKS_TWO["smart-slides"] };
  const h = loadPruneHarness({
    listAgentQueues: [[{ id: "smart-slides" }]],
    sightingsResponses: [
      { success: true, healed: [], flagged: [], deleted: ["research-assistant"] },
    ],
    linksByCall: [afterDelete],
  });
  h.setLinks({ ...LINKS_TWO });
  const result = await h.prune(["smart-slides"]);
  assertPruneResult(result, 1, ["research-assistant"]);
  assert.deepEqual(Array.from(Object.keys(h.getLinks())), ["smart-slides"]);
});

test("flagged links heal when seen again even with no new misses", async () => {
  const flagged = {
    ...LINKS_TWO,
    "research-assistant": {
      ...LINKS_TWO["research-assistant"],
      missingSince: "2026-08-08T04:20:53.000Z",
      missCount: 1,
    },
  };
  const h = loadPruneHarness({
    sightingsResponses: [
      { success: true, healed: ["research-assistant"], flagged: [], deleted: [] },
    ],
    linksByCall: [LINKS_TWO],
  });
  h.setLinks(flagged);
  const result = await h.prune(["research-assistant", "smart-slides"]);
  assertPruneResult(result, 0, []);
  // No misses → no repair round-trip; the report still runs so the store heals.
  assert.equal(h.repairCalls.length, 0);
  assert.deepEqual(Array.from(h.sightingsCalls[0].absentIds), []);
  assert.equal(h.getLinks()["research-assistant"].missingSince, undefined);
});

test("stale preload without the sightings channel NEVER falls back to hard deletes", async () => {
  const h = loadPruneHarness({
    includeSightingsChannel: false,
    listAgentQueues: [[{ id: "smart-slides" }]],
  });
  h.setLinks({ ...LINKS_TWO });
  const result = await h.prune(["smart-slides"]);
  assertPruneResult(result, 0, []);
  assert.equal(h.clearLinkCalls.length, 0);
  assert.equal(Object.keys(h.getLinks()).length, 2);
});
