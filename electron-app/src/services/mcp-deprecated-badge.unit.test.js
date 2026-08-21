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
  renderUnconfiguredCard,
};
`;

  const elements = new Map();
  const getElement = (id) => {
    if (!elements.has(id)) {
      elements.set(id, new FakeElement(id));
    }
    return elements.get(id);
  };

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
    electronAPI: {},
    showNotification() {},
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
  };
}

test("enabled deprecated server shows DEPRECATED with no disable-mode badge", () => {
  const harness = buildHarness();
  const state = harness.window.appState;

  const card = harness.hooks.renderServerCard(
    {
      id: "slack",
      name: "Slack",
      display_name: "Slack",
      isConfigured: true,
      deprecated: true,
    },
    state,
    null,
  );

  assert.match(card, /badge-deprecated">DEPRECATED</);
  assert.doesNotMatch(card, /badge-soft-disabled|badge-hard-disabled/);
});

test("soft-disabled deprecated server shows DEPRECATED and SOFT together", () => {
  const harness = buildHarness();
  const state = harness.window.appState;

  const card = harness.hooks.renderServerCard(
    {
      id: "n8n",
      name: "n8n",
      display_name: "n8n",
      isConfigured: true,
      deprecated: true,
    },
    state,
    null,
  );

  assert.match(card, /badge-deprecated">DEPRECATED</);
  assert.match(card, /badge-soft-disabled">SOFT</);
  assert.ok(
    card.indexOf("badge-deprecated") < card.indexOf("badge-soft-disabled"),
    "DEPRECATED renders before the disable-mode badge",
  );
});

test("hard-disabled deprecated server shows DEPRECATED and HARD together", () => {
  const harness = buildHarness();
  const state = harness.window.appState;
  state.disableModes = { n8n: "hard" };

  const card = harness.hooks.renderServerCard(
    {
      id: "n8n",
      name: "n8n",
      display_name: "n8n",
      isConfigured: true,
      deprecated: true,
    },
    state,
    null,
  );

  assert.match(card, /badge-deprecated">DEPRECATED</);
  assert.match(card, /badge-hard-disabled">HARD</);
});

test("unconfigured deprecated server shows DEPRECATED beside its Configure action", () => {
  const harness = buildHarness();
  const state = harness.window.appState;

  const card = harness.hooks.renderUnconfiguredCard(
    {
      id: "n8n-community-mcp",
      name: "n8n (Community Fork)",
      display_name: "n8n (Community Fork)",
      isConfigured: false,
      deprecated: true,
      deploymentType: "docker",
    },
    state,
    "configure",
  );

  assert.match(card, /badge-deprecated">DEPRECATED</);
  assert.match(card, /configure-btn/);
});

test("non-deprecated servers never render the DEPRECATED badge in either renderer", () => {
  const harness = buildHarness();
  const state = harness.window.appState;

  const configured = harness.hooks.renderServerCard(
    { id: "slack", name: "Slack", display_name: "Slack", isConfigured: true },
    state,
    null,
  );
  const unconfigured = harness.hooks.renderUnconfiguredCard(
    {
      id: "sourcegraph",
      name: "Sourcegraph",
      display_name: "Sourcegraph",
      isConfigured: false,
      deploymentType: "docker",
    },
    state,
    "configure",
  );

  assert.doesNotMatch(configured, /badge-deprecated/);
  assert.doesNotMatch(unconfigured, /badge-deprecated/);
});
