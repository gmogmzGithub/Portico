// Agents-tab clickability behavior: control-plane view switching, busy-state
// affordances on async card actions, publish-modal backdrop close semantics,
// and the body-mounted capability picker popover — all driven through the real
// agents.js module in a vm harness. Popover/backdrop visuals are covered by
// live visual QA.
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

class FakeElement {
  constructor(id = "", { autoVivify = false } = {}) {
    this.id = id;
    this.className = "";
    this.style = { display: "none" };
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
    if (this.autoVivify) return [this.autoChild(selector)];
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

function loadAgentsModuleHarness({ agents = [], skills = [], api = {} } = {}) {
  const sourcePath = path.join(__dirname, "..", "renderer", "components", "agents.js");
  const source = fs.readFileSync(sourcePath, "utf8");
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

  addElement("view-mcp-servers-btn", { display: "" });
  addElement("view-agent-skills-btn", { display: "" });
  addElement("view-cost-dashboard-btn", { display: "" });
  addElement("view-agents-tab-btn", { display: "" });
  addElement("mcp-servers-view", { display: "" });
  addElement("agent-skills-view", { display: "none" });
  addElement("cost-dashboard-view", { display: "none" });
  addElement("agents-tab-view", { display: "none" });
  addElement("mcp-header-actions", { display: "" });
  addElement("skills-header-actions", { display: "none" });
  addElement("cost-dashboard-header-actions", { display: "none" });
  addElement("agents-tab-header-actions", { display: "none" });
  addElement("agents-tab-list", { display: "" });
  addElement("agents-tab-new-agent-btn", { display: "" });
  addElement("agents-tab-settings-btn", { display: "" });
  addElement("agents-tab-search-input", { display: "" });
  addElement("agents-tab-mode-tabs", { display: "" });

  const body = new FakeElement("body");
  const documentListeners = new Map();
  const document = {
    readyState: "complete",
    body,
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

  const calls = [];
  const notifications = [];
  const windowObject = {
    appState: {
      controlPlaneView: "mcp-servers",
    },
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener() {},
    removeEventListener() {},
    electronAPI: {
      invokeMcpTool: async (_serverId, toolName, input = {}) => {
        calls.push([toolName, input]);
        if (typeof api.invokeMcpToolImpl === "function") {
          const handled = await api.invokeMcpToolImpl(toolName, input);
          if (handled) return handled;
        }
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
      getSkills: async () => ({ success: true, skills }),
      loadMcpServers: async () => ({ success: true, data: [] }),
      getUsername: async () => ({ username: "dsantiago" }),
      aiMarketplace: {
        listLinks: async () => {
          calls.push(["listLinks"]);
          return { success: true, links: api.links || {} };
        },
        hasApiKey: async () => {
          calls.push(["hasApiKey"]);
          return { hasKey: api.hasKey !== false };
        },
        install: async (solutionId, opts) => {
          calls.push(["install", solutionId, opts]);
          return api.installResult || { success: false, error: "fixture install failed" };
        },
      },
    },
    showNotification(message, kind) {
      notifications.push([kind, message]);
    },
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
  };
  context.globalThis = context;

  for (const extra of extraSources) {
    vm.runInNewContext(extra.source, context, { filename: extra.path });
  }
  vm.runInNewContext(source, context, { filename: sourcePath });

  return {
    window: windowObject,
    elements,
    body,
    calls,
    notifications,
    documentListeners,
  };
}

const settle = async (rounds = 8) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

// A list-click event whose target resolves closest("button") to `btn`.
function listClickEvent(btn) {
  return {
    target: {
      closest: (selector) => (selector === "button" ? btn : null),
    },
  };
}

function actionButton({ classes = [], agentId = "", solutionId = "" } = {}) {
  const btn = new FakeElement("");
  classes.forEach((name) => btn.classList.add(name));
  if (agentId) btn.attributes["data-agent-id"] = agentId;
  if (solutionId) btn.attributes["data-solution-id"] = solutionId;
  return btn;
}

const OWNED_AGENT = {
  id: "agent-1",
  name: "Fixture Agent",
  description: "Fixture description",
  base_model_id: "gpt-5",
  skill_ids: [],
  tool_server_ids: [],
  created_by_email: "dsantiago@example.invalid",
  creation_source: "local",
};

test("agents tab renderer loads without require and wires the control plane button", async () => {
  const { window, elements } = loadAgentsModuleHarness();

  assert.ok(window.AgentsTabModule);
  assert.equal(typeof window.AgentsTabModule.show, "function");

  elements.get("view-agents-tab-btn").click();
  await Promise.resolve();

  assert.equal(window.appState.controlPlaneView, "agents-tab");
  assert.equal(elements.get("agents-tab-view").style.display, "");
  assert.equal(elements.get("agents-tab-header-actions").style.display, "");
  assert.equal(elements.get("mcp-servers-view").style.display, "none");
  assert.equal(elements.get("mcp-header-actions").style.display, "none");
  assert.ok(elements.get("view-agents-tab-btn").classList.contains("active"));
  assert.ok(!elements.get("view-mcp-servers-btn").classList.contains("active"));
});

test("async card actions show busy affordances and ignore re-clicks while busy", async () => {
  let releaseGet;
  const gate = new Promise((resolve) => {
    releaseGet = resolve;
  });
  const { window, elements, calls } = loadAgentsModuleHarness({
    agents: [OWNED_AGENT],
    api: {
      invokeMcpToolImpl: async (toolName) => {
        if (toolName === "subagents_get_agent") {
          await gate;
          return { success: false, error: "fixture load failure" };
        }
        return null;
      },
    },
  });
  await window.AgentsTabModule.loadMyAgents();
  await settle();

  // The list-delegated action handler ignores buttons already marked busy:
  // no marketplace/link/agent traffic happens at all.
  const busyBtn = actionButton({ classes: ["agent-publish-btn"], agentId: "agent-1" });
  busyBtn.dataset.busy = "true";
  const before = calls.length;
  elements.get("agents-tab-list").dispatchEvent("click", listClickEvent(busyBtn));
  await settle();
  assert.equal(calls.length, before, "busy buttons do not dispatch actions");

  // A real publish click flips the trigger into the spinner busy state while
  // the agent record loads, and restores it when the load settles.
  const publishBtn = actionButton({ classes: ["agent-publish-btn"], agentId: "agent-1" });
  publishBtn.innerHTML = "Publish";
  elements.get("agents-tab-list").dispatchEvent("click", listClickEvent(publishBtn));
  await settle();
  assert.equal(publishBtn.dataset.busy, "true");
  assert.equal(publishBtn.disabled, true);
  assert.equal(publishBtn.getAttribute("aria-busy"), "true");
  assert.match(publishBtn.innerHTML, /btn-spinner/);
  assert.match(publishBtn.innerHTML, /Preparing\.\.\./);

  releaseGet();
  await settle();
  assert.notEqual(publishBtn.dataset.busy, "true");
  assert.equal(publishBtn.disabled, false);
  assert.equal(publishBtn.innerHTML, "Publish", "original label restored");
});

test("card action dispatch routes unpublish and install clicks to their flows", async () => {
  const { window, elements, calls, notifications } = loadAgentsModuleHarness({
    agents: [OWNED_AGENT],
    api: { installResult: { success: false, error: "fixture stop" } },
  });
  await window.AgentsTabModule.loadMyAgents();
  await settle();
  const list = elements.get("agents-tab-list");

  // Unpublish without a marketplace link fails safe with a notification.
  list.dispatchEvent(
    "click",
    listClickEvent(actionButton({ classes: ["agent-unpublish-btn"], agentId: "agent-1" })),
  );
  await settle();
  assert.ok(
    notifications.some(([, message]) => /not linked to a marketplace solution/.test(message)),
    "unlinked unpublish surfaces the guard notification",
  );

  // Install routes to the marketplace install IPC with the solution id.
  list.dispatchEvent(
    "click",
    listClickEvent(actionButton({ classes: ["agent-install-btn"], solutionId: "sol-9" })),
  );
  await settle();
  const installCall = calls.find((entry) => entry[0] === "install");
  assert.ok(installCall, "install click reaches aiMarketplace.install");
  assert.equal(installCall[1], "sol-9");
});

test("publish modal closes on backdrop click only when the press started on the backdrop", async () => {
  const { window, elements, body, calls } = loadAgentsModuleHarness({
    agents: [OWNED_AGENT],
  });
  await window.AgentsTabModule.loadMyAgents();
  await settle();

  const publishBtn = actionButton({ classes: ["agent-publish-btn"], agentId: "agent-1" });
  elements.get("agents-tab-list").dispatchEvent("click", listClickEvent(publishBtn));
  await settle();

  assert.ok(
    calls.some(([name]) => name === "hasApiKey"),
    "publish is gated on the marketplace API key",
  );
  const overlay = body.children.find((child) => child.id === "agents-modal-overlay");
  assert.ok(overlay, "publish confirmation modal is body-mounted");
  assert.match(overlay.innerHTML, /Publish agent/);

  // Press begins on modal content, released over the backdrop (drag-out):
  // the modal must stay open.
  const inner = new FakeElement("");
  overlay.dispatchEvent("pointerdown", { target: inner });
  overlay.dispatchEvent("click", { target: overlay });
  assert.ok(
    body.children.includes(overlay),
    "drag-out from the modal content does not close it",
  );

  // Press and release both on the backdrop: closes.
  overlay.dispatchEvent("pointerdown", { target: overlay });
  overlay.dispatchEvent("click", { target: overlay });
  assert.ok(!body.children.includes(overlay), "true backdrop click closes the modal");
});

test("capability picker popover: summary toggle, row multi-select, bounded upward positioning, done/detach", async () => {
  const { window, body } = loadAgentsModuleHarness();
  const options = [
    { id: "skill-a", display_name: "Alpha Skill", description: "first", source: "user" },
    { id: "skill-b", display_name: "Beta Skill", description: "second", source: "marketplace" },
    { id: "skill-c", display_name: "Gamma Skill", description: "third", source: "system" },
  ];

  const container = new FakeElement("picker-host", { autoVivify: true });
  // Mirror the dataset the rendered buildPicker markup carries (the fake DOM
  // does not materialize innerHTML into children).
  const pickerEl = container.querySelector(".agents-picker");
  pickerEl.dataset.pickerKind = "skills";
  pickerEl.dataset.selected = JSON.stringify(["skill-a"]);
  const remounted = window.AgentsTabRenderHooks.mountCapabilityPickerForTests(container, {
    kind: "skills",
    options,
    value: ["skill-a"],
    label: "Skills",
    addButtonLabel: "Add skills",
  });
  assert.ok(remounted, "standalone picker mounts");
  assert.deepEqual(remounted.getValue(), ["skill-a"]);

  // The compact summary control replaces the old inline panel + chip list,
  // and the rendered markup carries the same selection contract.
  assert.match(container.innerHTML, /agents-picker-toggle/);
  assert.match(container.innerHTML, /aria-haspopup="dialog"/);
  assert.match(container.innerHTML, /data-selected='\[&quot;skill-a&quot;\]'/);
  assert.match(container.innerHTML, /agents-picker-summary-title">Alpha Skill</);
  assert.match(container.innerHTML, /agents-picker-summary-description/);
  assert.match(container.innerHTML, /1 selected/);
  assert.doesNotMatch(container.innerHTML, /agents-picker-panel/);
  assert.doesNotMatch(container.innerHTML, /data-picker-chips/);

  // Open the popover from the summary toggle: body-mounted, header/footer
  // chrome, search field, and upward-first positioning when space allows.
  const toggle = pickerEl.querySelector("[data-picker-toggle]");
  toggle.isConnected = true;
  toggle.rect = { left: 100, right: 500, top: 500, bottom: 540, width: 400, height: 40 };
  toggle.click();

  const popover = body.children.find(
    (child) => child.className === "agent-capability-popover",
  );
  assert.ok(popover, "popover is body-mounted");
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(popover.getAttribute("role"), "dialog");
  assert.match(popover.innerHTML, /agent-capability-header/);
  assert.match(popover.innerHTML, /agent-capability-footer/);
  assert.match(popover.innerHTML, /Choose skills/);
  assert.match(popover.innerHTML, /Search skills/);
  // spaceAbove = 500-12 = 488 >= 330 → opens above, height bounded to
  // min(440, max(240, 488-8)) and anchored above the toggle.
  assert.ok(popover.classList.contains("opens-above"));
  assert.equal(popover.style.maxHeight, "440px");
  assert.equal(popover.style.width, "448px");
  assert.equal(popover.style.top, `${500 - popover.offsetHeight - 8}px`);

  // Every option renders as a row with its source badge; the selected row is
  // marked and carries the check.
  const listEl = popover.querySelector(".agent-capability-list");
  assert.match(listEl.innerHTML, /data-row-id="skill-a"/);
  assert.match(listEl.innerHTML, /data-row-id="skill-b"/);
  assert.match(listEl.innerHTML, /badge-installed/);
  assert.match(listEl.innerHTML, /agent-capability-row is-selected[\s\S]*?skill-a/);

  // Row clicks toggle membership without closing the popover.
  const rowTarget = (rowId) => ({
    closest: (selector) =>
      selector === "[data-row-id]"
        ? { getAttribute: (name) => (name === "data-row-id" ? rowId : null) }
        : null,
  });
  listEl.dispatchEvent("click", { target: rowTarget("skill-b") });
  assert.deepEqual(remounted.getValue(), ["skill-a", "skill-b"]);
  assert.ok(body.children.includes(popover), "selection keeps the popover open");
  // The summary toggle re-renders in place with the updated selection.
  assert.match(toggle.innerHTML, /Alpha Skill, Beta Skill/);
  assert.match(toggle.innerHTML, /2 selected/);
  listEl.dispatchEvent("click", { target: rowTarget("skill-a") });
  assert.deepEqual(remounted.getValue(), ["skill-b"], "re-click deselects");

  // Search narrows the rows via the same predicate as the row renderer.
  const search = popover.querySelector(".agent-capability-search");
  search.value = "beta";
  search.dispatchEvent("input");
  assert.match(listEl.innerHTML, /Beta Skill/);
  assert.doesNotMatch(listEl.innerHTML, /Alpha Skill/);
  search.value = "zzz";
  search.dispatchEvent("input");
  assert.match(listEl.innerHTML, /No matches/);

  // Done closes and releases the popover.
  popover.querySelector("[data-picker-done]").click();
  assert.ok(!body.children.includes(popover), "Done removes the popover");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");

  // Reopen, then the standalone destroy() detach handshake closes it too.
  toggle.click();
  const reopened = body.children.find(
    (child) => child.className === "agent-capability-popover",
  );
  assert.ok(reopened, "popover reopens");
  remounted.destroy();
  assert.ok(
    !body.children.includes(reopened),
    "agents-picker-detach releases the body-mounted popover",
  );
});

test("capability picker flips below the toggle when the space above is worse", async () => {
  const { window, body } = loadAgentsModuleHarness();
  const container = new FakeElement("picker-host-2", { autoVivify: true });
  window.AgentsTabRenderHooks.mountCapabilityPickerForTests(container, {
    kind: "tool_server_ids",
    options: [{ id: "server:core", display_name: "Core", source: "core" }],
    value: [],
    label: "MCP servers",
    addButtonLabel: "Add MCP servers",
  });
  const pickerEl = container.querySelector(".agents-picker");
  pickerEl.dataset.pickerKind = "tool_server_ids";
  pickerEl.dataset.selected = "[]";
  const toggle = pickerEl.querySelector("[data-picker-toggle]");
  toggle.isConnected = true;
  // spaceAbove = 88 (< 330) and spaceBelow = 668 → opens below.
  toggle.rect = { left: 100, right: 500, top: 100, bottom: 120, width: 400, height: 20 };
  toggle.click();

  const popover = body.children.find(
    (child) => child.className === "agent-capability-popover",
  );
  assert.ok(popover, "popover opened");
  assert.ok(!popover.classList.contains("opens-above"), "flips below the toggle");
  assert.equal(popover.style.maxHeight, "440px");
  assert.equal(popover.style.top, "128px");
  assert.match(popover.innerHTML, /Choose MCP servers/);
});
