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
  showResyncConfirmationModal,
  hideResyncConfirmationModal,
  confirmResync,
  formatStartingLabel,
  formatRunningLabel,
  formatWarmupElapsed,
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
  const electronCalls = { resync: [], apiRestart: [] };
  const operationStarts = [];

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
        { id: "slack", name: "Slack", display_name: "Slack", isConfigured: true },
        { id: "gitlab-mcp", name: "GitLab", display_name: "GitLab", isConfigured: true },
      ],
      toggles: { slack: true, "gitlab-mcp": true },
      healthStatus: {
        servers: {
          slack: { status: "healthy", configured: true },
          "gitlab-mcp": { status: "healthy", configured: true },
        },
      },
    },
    electronAPI: {
      resyncMcpServerData: async (serverId) => {
        electronCalls.resync.push(serverId);
        return windowObject.__resyncResult;
      },
      apiRestartMcpServers: async (serverIds) => {
        electronCalls.apiRestart.push(serverIds);
        return { success: true };
      },
    },
    __resyncResult: { success: true, volumeRemoved: true },
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

  // The source assigns its real list-refresh functions onto window at load;
  // re-stub them so confirm flows exercised here stay DOM-free.
  windowObject.updateMcpServersList = () => {};
  windowObject.updateMcpBadgeWithHealth = () => {};

  return {
    hooks: windowObject.__mcpServersTestHooks,
    window: windowObject,
    elements,
    getElement,
    notifications,
    electronCalls,
    operationStarts,
  };
}

test("enabled slack card renders the re-sync menu item; other servers do not", () => {
  const harness = buildHarness();
  const state = harness.window.appState;

  const slackCard = harness.hooks.renderServerCard(
    { id: "slack", name: "Slack", display_name: "Slack" },
    state,
    null,
  );
  assert.match(slackCard, /mcp-resync-btn/);
  assert.match(slackCard, /Re-sync Slack data/);

  const gitlabCard = harness.hooks.renderServerCard(
    { id: "gitlab-mcp", name: "GitLab", display_name: "GitLab" },
    state,
    null,
  );
  assert.doesNotMatch(gitlabCard, /mcp-resync-btn/);
});

test("disabled slack card does not offer re-sync", () => {
  const harness = buildHarness();
  const state = {
    ...harness.window.appState,
    toggles: { slack: false },
    healthStatus: {
      servers: { slack: { status: "disabled", configured: true } },
    },
  };
  harness.window.appState = state;

  const slackCard = harness.hooks.renderServerCard(
    { id: "slack", name: "Slack", display_name: "Slack" },
    state,
    null,
  );
  assert.doesNotMatch(slackCard, /mcp-resync-btn/);
});

test("confirm flow purges then starts the restart operation with resync metadata", async () => {
  const harness = buildHarness();

  harness.hooks.showResyncConfirmationModal("slack", "Slack");
  const modal = harness.getElement("resync-confirm-modal");
  assert.ok(modal.classList.contains("visible"), "modal must open");
  assert.equal(harness.getElement("resync-server-name").textContent, "Slack");
  assert.match(
    harness.getElement("resync-info-text").textContent,
    /10–20 minutes/,
  );

  await harness.hooks.confirmResync();

  assert.deepEqual(harness.electronCalls.resync, ["slack"]);
  assert.equal(harness.operationStarts.length, 1);
  const { request } = harness.operationStarts[0];
  assert.equal(request.kind, "restart");
  assert.deepEqual([...request.serverIds], ["slack"]);
  assert.equal(request.targetEnabled, true);
  assert.equal(request.metadata.source, "slack-data-resync");
  assert.equal(
    modal.classList.contains("visible"),
    false,
    "modal closes on confirm",
  );
  assert.equal(harness.notifications.length, 0);
});

test("starting label surfaces warmup elapsed and percent from health info", () => {
  const harness = buildHarness();
  const { formatStartingLabel, formatWarmupElapsed } = harness.hooks;

  assert.equal(formatWarmupElapsed(15), "15s");
  assert.equal(formatWarmupElapsed(60), "1m");
  assert.equal(formatWarmupElapsed(185), "3m");
  assert.equal(formatWarmupElapsed(600), "10m");
  assert.equal(formatWarmupElapsed(3900), "1h 5m");

  assert.equal(formatStartingLabel(null), "Starting...");
  assert.equal(formatStartingLabel({}), "Starting...");
  assert.equal(
    formatStartingLabel({ provider_warmup: { elapsed_seconds: 185 } }),
    "Starting... (3m)",
  );
  assert.equal(
    formatStartingLabel({
      provider_warmup: { elapsed_seconds: 185, progress_percent: 42 },
    }),
    "Starting... (3m · 42%)",
  );
  assert.equal(
    formatStartingLabel({
      provider_warmup: { elapsed_seconds: 45, progress_percent: 0 },
    }),
    "Starting... (45s)",
    "zero percent is noise, not progress",
  );
  assert.equal(
    formatStartingLabel({
      provider_warmup: { phase: "users", elapsed_seconds: 720, items_fetched: 14000 },
    }),
    "Starting... (12m · 14,000 users)",
    "first-ever sync (no denominator) shows the running count",
  );
  assert.equal(
    formatStartingLabel({
      provider_warmup: { phase: "channels", elapsed_seconds: 60, items_fetched: 2500 },
    }),
    "Starting... (1m · 2,500 channels)",
  );
});

test("running label narrates a background directory sync only while syncing", () => {
  const harness = buildHarness();
  const { formatRunningLabel } = harness.hooks;

  assert.equal(formatRunningLabel(null), "Running");
  assert.equal(formatRunningLabel({}), "Running");
  assert.equal(
    formatRunningLabel({ provider_warmup: { elapsed_seconds: 185, progress_percent: 42 } }),
    "Running",
    "warmup without syncing:true is a stale/legacy payload, not a live sync",
  );
  assert.equal(
    formatRunningLabel({
      provider_warmup: { syncing: true, elapsed_seconds: 1680, progress_percent: 9 },
    }),
    "Running — syncing (28m · 9%)",
  );
  assert.equal(
    formatRunningLabel({
      provider_warmup: { syncing: true, phase: "channels", elapsed_seconds: 60, items_fetched: 2500 },
    }),
    "Running — syncing (1m · 2,500 channels)",
    "first-ever sync (no denominator) shows the running count",
  );
  assert.equal(
    formatRunningLabel({ provider_warmup: { syncing: true } }),
    "Running — syncing",
    "a syncing flag without counters still gets narrated",
  );
});

test("healthy card shows Running with sync narration while the directory syncs", () => {
  const harness = buildHarness();
  const state = {
    ...harness.window.appState,
    healthStatus: {
      servers: {
        slack: {
          status: "healthy",
          configured: true,
          provider_warmup: { syncing: true, elapsed_seconds: 1680, progress_percent: 9 },
        },
        "gitlab-mcp": {
          status: "healthy",
          configured: true,
        },
      },
    },
  };
  harness.window.appState = state;

  const slackCard = harness.hooks.renderServerCard(
    { id: "slack", name: "Slack", display_name: "Slack", isConfigured: true },
    state,
    null,
  );
  assert.match(slackCard, /Running — syncing \(28m · 9%\)/);
  assert.match(slackCard, /mcp-card-status-text healthy/, "narrated sync keeps the healthy visual state");

  const gitlabCard = harness.hooks.renderServerCard(
    { id: "gitlab-mcp", name: "GitLab", display_name: "GitLab", isConfigured: true },
    state,
    null,
  );
  assert.match(gitlabCard, />Running</, "servers without sync narration render plain Running");
});

test("starting card renders the warmup detail inline", () => {
  const harness = buildHarness();
  const state = {
    ...harness.window.appState,
    healthStatus: {
      servers: {
        slack: {
          status: "starting",
          configured: true,
          provider_warmup: { elapsed_seconds: 185, progress_percent: 42 },
        },
      },
    },
  };
  harness.window.appState = state;

  const slackCard = harness.hooks.renderServerCard(
    { id: "slack", name: "Slack", display_name: "Slack", isConfigured: true },
    state,
    null,
  );
  assert.match(slackCard, /Starting\.\.\. \(3m · 42%\)/);
});

test("busy purge surfaces a notification and starts no operation", async () => {
  const harness = buildHarness();
  harness.window.__resyncResult = {
    success: false,
    errorCode: "MCP_OPERATION_BUSY",
    error: "Another MCP change is still running",
  };

  harness.hooks.showResyncConfirmationModal("slack", "Slack");
  await harness.hooks.confirmResync();

  assert.deepEqual(harness.electronCalls.resync, ["slack"]);
  assert.equal(harness.operationStarts.length, 0);
  assert.equal(harness.notifications.length, 1);
  assert.match(harness.notifications[0].message, /still running/);
  assert.equal(harness.notifications[0].level, "error");
});

test("failed purge reports the reason and does not restart", async () => {
  const harness = buildHarness();
  harness.window.__resyncResult = {
    success: false,
    errorCode: "MCP_RESYNC_FAILED",
    error: "docker daemon unreachable",
  };

  harness.hooks.showResyncConfirmationModal("slack", "Slack");
  await harness.hooks.confirmResync();

  assert.equal(harness.operationStarts.length, 0);
  assert.equal(harness.notifications.length, 1);
  assert.match(harness.notifications[0].message, /docker daemon unreachable/);
});
