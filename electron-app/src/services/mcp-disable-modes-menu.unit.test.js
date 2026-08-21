const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const mcpServersSourcePath = path.join(
  __dirname,
  "..",
  "renderer",
  "components",
  "mcp-servers.js",
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
  toggle(name, force) {
    const shouldAdd = force === undefined ? !this.classes.has(name) : force;
    if (shouldAdd) {
      this.classes.add(name);
    } else {
      this.classes.delete(name);
    }
    return shouldAdd;
  }
}

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.classList = new FakeClassList();
    this.style = {};
    this.textContent = "";
    this.innerHTML = "";
    this.onclick = null;
    this.dataset = {};
    this.listeners = new Map();
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  removeEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    this.listeners.set(
      type,
      handlers.filter((item) => item !== handler),
    );
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
}

function buildHarness() {
  const source = `${fs.readFileSync(mcpServersSourcePath, "utf8")}
window.__mcpServersTestHooks = {
  renderServerCard,
  showToggleConfirmationModal,
  hideToggleConfirmationModal,
  confirmToggleServer,
  handleDisableModeSwitch,
  applyLocalDisableModeState,
  createMcpOperationRequest,
};
`;

  const elements = new Map();
  const getElement = (id) => {
    if (!elements.has(id)) {
      elements.set(id, new FakeElement(id));
    }
    return elements.get(id);
  };

  const notifications = [];
  const operationStarts = [];
  const disableModeCalls = [];

  const documentObject = {
    hidden: false,
    body: { classList: new FakeClassList(), style: {} },
    documentElement: { getAttribute: () => "light" },
    getElementById: (id) => getElement(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => new FakeElement(),
    addEventListener() {},
    removeEventListener() {},
  };

  const windowObject = {
    appState: {
      servers: [
        { id: "n8n", name: "n8n", display_name: "n8n", isConfigured: true },
        { id: "slack", name: "Slack", display_name: "Slack", isConfigured: true },
      ],
      toggles: { n8n: false, slack: true },
      disableModes: {},
      healthStatus: {
        servers: {
          n8n: { status: "disabled", configured: true },
          slack: { status: "healthy", configured: true },
        },
      },
    },
    electronAPI: {
      setMcpDisableMode: async (serverId, mode) => {
        disableModeCalls.push({ serverId, mode });
        return windowObject.__setDisableModeResult;
      },
    },
    __setDisableModeResult: { success: true },
    McpOperationOverlayController: {
      isSupported: () => true,
      startOperation: async (request, options) => {
        operationStarts.push({ request, options });
        return { success: true };
      },
    },
    showNotification: (message, level) => {
      notifications.push({ message, level });
    },
    updateMcpServersList: () => {},
    updateMcpBadgeWithHealth: () => {},
    addEventListener() {},
    removeEventListener() {},
    localStorage: { getItem: () => null, setItem() {} },
  };
  windowObject.window = windowObject;

  const context = {
    window: windowObject,
    document: documentObject,
    console,
    localStorage: windowObject.localStorage,
    navigator: {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Math,
    Date,
    Promise,
    Set,
    Map,
    URL,
    runOAuthFlowForSingleServer() {},
    openServiceLogsPanel() {},
  };

  vm.runInNewContext(source, context, { filename: mcpServersSourcePath });

  windowObject.updateMcpServersList = () => {};
  windowObject.updateMcpBadgeWithHealth = () => {};

  return {
    hooks: windowObject.__mcpServersTestHooks,
    window: windowObject,
    elements,
    getElement,
    notifications,
    operationStarts,
    disableModeCalls,
  };
}

test("enabled card offers Disable (Soft) and Disable (Hard) with their action colors", () => {
  const harness = buildHarness();
  const state = harness.window.appState;

  const card = harness.hooks.renderServerCard(
    { id: "slack", name: "Slack", display_name: "Slack", isConfigured: true },
    state,
    null,
  );

  assert.match(card, /Disable \(Soft\)/);
  assert.match(card, /Disable \(Hard\)/);
  assert.match(card, /disable-soft-action"[\s\S]*?data-disable-mode="soft"/);
  assert.match(card, /mcp-power-toggle-item disable-action"[\s\S]*?data-disable-mode="hard"/);
  assert.doesNotMatch(card, /Disable Integration</);
  assert.doesNotMatch(card, /mcp-disable-mode-switch-item/);
  assert.doesNotMatch(card, /badge-soft-disabled|badge-hard-disabled/);
});

test("soft-disabled card shows the SOFT badge, Enable, and Switch to Hard Disable", () => {
  const harness = buildHarness();
  const state = harness.window.appState;

  const card = harness.hooks.renderServerCard(
    { id: "n8n", name: "n8n", display_name: "n8n", isConfigured: true },
    state,
    null,
  );

  assert.match(card, /badge-soft-disabled">SOFT</);
  assert.match(card, /Enable Integration/);
  assert.match(card, /mcp-disable-mode-switch-item disable-action/);
  assert.match(card, /data-target-mode="hard"/);
  assert.match(card, /Switch to Hard Disable/);
});

test("hard-disabled card shows the HARD badge and Switch to Soft Disable", () => {
  const harness = buildHarness();
  const state = harness.window.appState;
  state.disableModes = { n8n: "hard" };

  const card = harness.hooks.renderServerCard(
    { id: "n8n", name: "n8n", display_name: "n8n", isConfigured: true },
    state,
    null,
  );

  assert.match(card, /badge-hard-disabled">HARD</);
  assert.match(card, /mcp-disable-mode-switch-item disable-soft-action/);
  assert.match(card, /data-target-mode="soft"/);
  assert.match(card, /Switch to Soft Disable/);
});

test("hard-disable modal is red and explains opacity; soft modal notes the AI may re-enable", () => {
  const harness = buildHarness();
  const modal = harness.getElement("toggle-server-modal");

  harness.hooks.showToggleConfirmationModal("n8n", "n8n", false, "docker", "hard");
  assert.ok(modal.classList.contains("hard-mode"));
  assert.ok(!modal.classList.contains("enable-mode"));
  assert.equal(
    harness.getElement("toggle-modal-title").textContent,
    "Disable Integration (Hard)",
  );
  assert.match(
    harness.getElement("toggle-info-text").textContent,
    /will not see this integration and cannot re-enable it/,
  );
  assert.equal(
    harness.getElement("toggle-server-confirm-btn").textContent,
    "Disable (Hard)",
  );
  harness.hooks.hideToggleConfirmationModal();
  assert.ok(!modal.classList.contains("hard-mode"), "hide clears hard-mode");

  harness.hooks.showToggleConfirmationModal("n8n", "n8n", false, "docker", "soft");
  assert.ok(!modal.classList.contains("hard-mode"));
  assert.equal(
    harness.getElement("toggle-modal-title").textContent,
    "Disable Integration (Soft)",
  );
  assert.match(
    harness.getElement("toggle-info-text").textContent,
    /the AI may re-enable it when a task needs it/,
  );
  assert.equal(
    harness.getElement("toggle-server-confirm-btn").textContent,
    "Disable (Soft)",
  );
  harness.hooks.hideToggleConfirmationModal();

  harness.hooks.showToggleConfirmationModal("slack", "Slack", true, "docker");
  assert.ok(modal.classList.contains("enable-mode"));
  assert.ok(!modal.classList.contains("hard-mode"));
});

test("confirming a hard disable starts an operation carrying disableMode=hard", async () => {
  const harness = buildHarness();

  harness.hooks.showToggleConfirmationModal("slack", "Slack", false, "docker", "hard");
  await harness.hooks.confirmToggleServer();

  assert.equal(harness.operationStarts.length, 1);
  const { request } = harness.operationStarts[0];
  assert.equal(request.kind, "disable");
  assert.deepEqual([...request.serverIds], ["slack"]);
  assert.equal(request.disableMode, "hard");
  assert.equal(request.metadata.disableMode, "hard");
  assert.equal(request.clearDisableMode, undefined);
  assert.equal(
    harness.window.appState.disableModes.slack,
    "hard",
    "local state mirrors the confirmed hard disable",
  );
});

test("confirming a soft disable carries no disable-mode fields", async () => {
  const harness = buildHarness();

  harness.hooks.showToggleConfirmationModal("slack", "Slack", false, "docker", "soft");
  await harness.hooks.confirmToggleServer();

  const { request } = harness.operationStarts[0];
  assert.equal(request.kind, "disable");
  assert.equal(request.disableMode, undefined);
  assert.equal(request.metadata, undefined);
  assert.equal(harness.window.appState.disableModes.slack, undefined);
});

test("confirming an enable clears the hard mode and requests clearDisableMode", async () => {
  const harness = buildHarness();
  harness.window.appState.disableModes = { n8n: "hard" };

  harness.hooks.showToggleConfirmationModal("n8n", "n8n", true, "docker");
  await harness.hooks.confirmToggleServer();

  const { request } = harness.operationStarts[0];
  assert.equal(request.kind, "enable");
  assert.equal(request.clearDisableMode, true);
  assert.equal(request.metadata.clearDisableMode, true);
  assert.equal(
    harness.window.appState.disableModes.n8n,
    undefined,
    "local hard mode lifts optimistically on enable",
  );
});

test("mode switch calls setMcpDisableMode and mirrors success into local state", async () => {
  const harness = buildHarness();

  await harness.hooks.handleDisableModeSwitch("n8n", "hard");
  assert.deepEqual(harness.disableModeCalls, [{ serverId: "n8n", mode: "hard" }]);
  assert.equal(harness.window.appState.disableModes.n8n, "hard");
  assert.equal(harness.notifications.length, 1);
  assert.match(harness.notifications[0].message, /hard-disabled/);
  assert.equal(harness.notifications[0].level, "success");

  await harness.hooks.handleDisableModeSwitch("n8n", "soft");
  assert.equal(harness.window.appState.disableModes.n8n, undefined);
  assert.match(harness.notifications[1].message, /soft-disabled/);
});

test("mode switch failure surfaces the error and leaves local state unchanged", async () => {
  const harness = buildHarness();
  harness.window.__setDisableModeResult = {
    success: false,
    error: "Another MCP operation is in progress.",
  };

  await harness.hooks.handleDisableModeSwitch("n8n", "hard");

  assert.equal(harness.window.appState.disableModes.n8n, undefined);
  assert.equal(harness.notifications.length, 1);
  assert.match(harness.notifications[0].message, /Another MCP operation/);
  assert.equal(harness.notifications[0].level, "error");
});
