// Unconfigured MCP cards (Needs Config / Needs Auth) carry a kebab menu so
// servers can be disabled before they are ever configured. Toggle
// normalization writes an explicit false for EVERY non-enabled server, so a
// bare false toggle is the default state of a fresh unconfigured server —
// NOT a user decision. The only unambiguous deliberate-disable signal is the
// hard-mode entry: hard-disabled unconfigured servers present as plain
// Disabled (no setup CTA, HARD badge, Enable + Switch-to-Soft). Everything
// else keeps its setup CTA and offers Disable (Hard) — plus Disable (Soft)
// only when the server is explicitly toggled ON (where soft changes the
// model-facing listing).
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
  renderUnconfiguredCard,
  resolveVisibleServerSetupAction,
  buildMcpServerGridEntry,
  handleDisableModeSwitch,
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
        {
          id: "fork",
          name: "Fork",
          display_name: "Fork",
          isConfigured: false,
          requiredVars: [{ name: "API_KEY" }],
        },
      ],
      toggles: {},
      disableModes: {},
      healthStatus: { servers: {} },
    },
    electronAPI: {
      setMcpDisableMode: async (serverId, mode) => {
        disableModeCalls.push({ serverId, mode });
        return windowObject.__setDisableModeResult;
      },
    },
    __setDisableModeResult: { success: true },
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
    notifications,
    disableModeCalls,
  };
}

const UNCONFIGURED = {
  id: "fork",
  name: "Fork",
  display_name: "Fork",
  isConfigured: false,
  requiredVars: [{ name: "API_KEY" }],
};

test("needs-config card (normalized false toggle) offers Disable (Hard) but keeps its setup CTA", () => {
  const harness = buildHarness();
  const state = harness.window.appState;
  state.toggles = { fork: false };

  const card = harness.hooks.renderUnconfiguredCard(UNCONFIGURED, state, "configure");

  assert.match(card, /mcp-card-menu-trigger/);
  assert.match(card, /Disable \(Hard\)/);
  assert.match(card, /mcp-power-toggle-item disable-action"[\s\S]*?data-disable-mode="hard"/);
  assert.doesNotMatch(
    card,
    /Disable \(Soft\)/,
    "bare false is normalization, not a user decision — soft adds nothing",
  );
  assert.doesNotMatch(card, /Enable Integration/);
  assert.doesNotMatch(card, /mcp-disable-mode-switch-item/);
  assert.doesNotMatch(card, /badge-soft-disabled|badge-hard-disabled/);
  assert.match(card, /Needs Config/);
  assert.match(card, /configure-btn/);
  // State-independent parity actions ride along.
  assert.match(card, /mcp-open-folder-btn/);
  assert.match(card, /mcp-export-btn/);
});

test("needs-auth card also carries the disable menu", () => {
  const harness = buildHarness();
  const state = harness.window.appState;

  const card = harness.hooks.renderUnconfiguredCard(UNCONFIGURED, state, "authenticate");

  assert.match(card, /Needs Auth/);
  assert.match(card, /authenticate-btn/);
  assert.match(card, /Disable \(Hard\)/);
});

test("toggled-ON unconfigured card offers Disable (Soft) too", () => {
  const harness = buildHarness();
  const state = harness.window.appState;
  state.toggles = { fork: true };

  const card = harness.hooks.renderUnconfiguredCard(UNCONFIGURED, state, "configure");

  assert.match(card, /Disable \(Soft\)/);
  assert.match(card, /disable-soft-action"[\s\S]*?data-disable-mode="soft"/);
  assert.match(card, /Disable \(Hard\)/);
  assert.match(card, /Needs Config/, "soft option never hides the setup CTA");
});

test("hard-disabled unconfigured card presents as Disabled with HARD badge, Enable, and Switch to Soft", () => {
  const harness = buildHarness();
  const state = harness.window.appState;
  state.toggles = { fork: false };
  state.disableModes = { fork: "hard" };

  const resolved = harness.hooks.resolveVisibleServerSetupAction(UNCONFIGURED, {
    state,
    configured: false,
    enabled: false,
  });
  assert.equal(resolved, null, "hard mode suppresses the setup CTA");

  const card = harness.hooks.renderUnconfiguredCard(UNCONFIGURED, state, resolved);

  assert.match(card, /status-text disabled">Disabled</);
  assert.match(card, /disabled-state/);
  assert.match(card, /badge-hard-disabled">HARD</);
  assert.match(card, /Enable Integration/);
  assert.match(card, /data-target-mode="soft"/);
  assert.match(card, /Switch to Soft Disable/);
  assert.doesNotMatch(card, /Disable \(Hard\)/);
  assert.doesNotMatch(card, /configure-btn|authenticate-btn/);
});

test("setup-action resolution: only hard mode suppresses the CTA; configured-disabled unchanged", () => {
  const harness = buildHarness();
  const state = harness.window.appState;

  assert.equal(
    harness.hooks.resolveVisibleServerSetupAction(UNCONFIGURED, {
      state,
      configured: false,
      enabled: false,
    }),
    "configure",
    "absent toggle keeps the setup CTA",
  );

  state.toggles = { fork: false };
  assert.equal(
    harness.hooks.resolveVisibleServerSetupAction(UNCONFIGURED, {
      state,
      configured: false,
      enabled: false,
    }),
    "configure",
    "normalized false keeps the setup CTA too",
  );

  // Configured + toggled-off servers keep returning null (regression guard).
  assert.equal(
    harness.hooks.resolveVisibleServerSetupAction(UNCONFIGURED, {
      state,
      configured: true,
      enabled: false,
    }),
    null,
  );

  state.disableModes = { fork: "hard" };
  const entry = harness.hooks.buildMcpServerGridEntry(UNCONFIGURED, state);
  assert.equal(entry.setupAction, null, "hard-disabled entry drops the setup action");
  assert.equal(entry.configured, false);
  assert.equal(entry.enabled, false);
});

test("core servers get no toggle items; user-installed servers get Delete", () => {
  const harness = buildHarness();
  const state = harness.window.appState;

  const coreCard = harness.hooks.renderUnconfiguredCard(
    { ...UNCONFIGURED, id: "core-x", isCore: true },
    state,
    "configure",
  );
  assert.doesNotMatch(coreCard, /mcp-power-toggle-item/);

  const userCard = harness.hooks.renderUnconfiguredCard(
    { ...UNCONFIGURED, id: "user-x", userInstalled: true },
    state,
    "configure",
  );
  assert.match(userCard, /mcp-delete-btn delete-action/);

  const bundledCard = harness.hooks.renderUnconfiguredCard(UNCONFIGURED, state, "configure");
  assert.doesNotMatch(bundledCard, /mcp-delete-btn/);
});

test("mode switch to hard mirrors toggles=false locally (disk invariant)", async () => {
  const harness = buildHarness();
  const state = harness.window.appState;

  await harness.hooks.handleDisableModeSwitch("fork", "hard");

  assert.deepEqual(harness.disableModeCalls, [{ serverId: "fork", mode: "hard" }]);
  assert.equal(state.disableModes.fork, "hard");
  assert.equal(state.toggles.fork, false, "hard implies toggled-off locally too");

  await harness.hooks.handleDisableModeSwitch("fork", "soft");
  assert.equal(state.disableModes.fork, undefined);
  assert.equal(state.toggles.fork, false, "soft switch leaves the toggle alone");
});
