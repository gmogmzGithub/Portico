const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const McpOperationProgress = require("../renderer/components/mcp-operation-progress");

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
    const shouldAdd = force === undefined ? !this.contains(name) : Boolean(force);
    if (shouldAdd) this.add(name);
    else this.remove(name);
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
    this.listeners = new Map();
    this.attributes = new Map();
  }

  addEventListener(type, handler) {
    this.listeners.set(type, handler);
  }

  click() {
    const handler = this.listeners.get("click");
    if (handler) return handler({ preventDefault() {} });
    return undefined;
  }

  appendChild(child) {
    this.child = child;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
}

function buildControlPlaneHarness(options = {}) {
  const sourcePath = path.join(
    __dirname,
    "..",
    "renderer",
    "components",
    "control-plane.js",
  );
  const htmlPath = path.join(
    __dirname,
    "..",
    "renderer",
    "views",
    "index.html",
  );
  const source = fs.readFileSync(sourcePath, "utf8");
  const html = fs.readFileSync(htmlPath, "utf8");

  assert.match(html, /id="mcp-operation-overlay"/);
  assert.match(html, /id="mcp-operation-background-btn"/);
  assert.match(html, /id="mcp-operation-banner"/);

  const operationIds = [
    "mcp-operation-overlay",
    "mcp-operation-shell",
    "mcp-operation-spinner",
    "mcp-operation-title",
    "mcp-operation-subtitle",
    "mcp-operation-summary",
    "mcp-operation-bar-fill",
    "mcp-operation-list",
    "mcp-operation-background-btn",
    "mcp-operation-footer",
    "mcp-operation-footer-message",
    "mcp-operation-done-btn",
    "mcp-operation-banner",
    "mcp-operation-banner-dot",
    "mcp-operation-banner-title",
    "mcp-operation-banner-subtitle",
  ];
  const elements = Object.fromEntries(
    ["loading-overlay", "loading-spinner", "loading-text", ...operationIds].map(
      (id) => [id, new FakeElement(id)],
    ),
  );
  elements["mcp-operation-banner"].classList.add("hidden");
  elements["mcp-operation-footer"].classList.add("hidden");

  const storageValues = new Map(Object.entries(options.storage || {}));
  const localStorage = {
    getItem(key) {
      return storageValues.has(key) ? storageValues.get(key) : null;
    },
    setItem(key, value) {
      storageValues.set(key, String(value));
    },
  };
  let updateListener = null;
  let subscriptions = 0;
  let unsubscribeCalls = 0;
  const electronAPI = {
    getActiveMcpOperation: async () => options.activeOperation || null,
    getMcpOperation: async () => options.latestOperation || null,
    onMcpOperationUpdated(listener) {
      subscriptions += 1;
      updateListener = listener;
      return () => {
        unsubscribeCalls += 1;
      };
    },
    startMcpOperation: options.startMcpOperation || (async () => null),
  };
  const timers = new Map();
  let nextTimerId = 0;
  const setTimeoutFake = (callback, delay) => {
    const id = ++nextTimerId;
    timers.set(id, { callback, delay });
    return id;
  };
  const clearTimeoutFake = (id) => timers.delete(id);

  const document = {
    readyState: "complete",
    head: new FakeElement("head"),
    body: new FakeElement("body"),
    createElement() {
      return new FakeElement();
    },
    getElementById(id) {
      return elements[id] || null;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const suppressionReasons = new Set();
  const suppressionCalls = [];
  const window = {
    appState: {},
    electronAPI,
    localStorage,
    McpOperationProgress,
    addEventListener() {},
    setNativeOverlayInteractionSuppressed(reason, suppressed) {
      suppressionCalls.push({ reason, suppressed });
      if (suppressed) suppressionReasons.add(reason);
      else suppressionReasons.delete(reason);
    },
  };
  const context = {
    window,
    document,
    console,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: setTimeoutFake,
    clearTimeout: clearTimeoutFake,
    Math,
  };

  vm.runInNewContext(source, context, { filename: sourcePath });

  return {
    document,
    elements,
    emit(snapshot) {
      assert.equal(typeof updateListener, "function");
      updateListener(snapshot);
    },
    fireTimerWithDelay(delay) {
      const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay);
      assert(entry, `expected a ${delay}ms timer`);
      timers.delete(entry[0]);
      entry[1].callback();
    },
    get subscriptions() {
      return subscriptions;
    },
    get unsubscribeCalls() {
      return unsubscribeCalls;
    },
    storageValues,
    timers,
    window,
    suppressionReasons,
    suppressionCalls,
  };
}

async function clickOperationAction(harness, { action, serverId }) {
  const handler = harness.elements["mcp-operation-list"].listeners.get("click");
  assert.equal(typeof handler, "function");
  await handler({
    preventDefault() {},
    stopPropagation() {},
    target: {
      closest(selector) {
        return selector === "[data-mcp-operation-action]"
          ? {
              dataset: {
                mcpOperationAction: action,
                serverId,
              },
            }
          : null;
      },
    },
  });
}

function runningSnapshot(sequence = 1) {
  return {
    operationId: "enable-op-1",
    sequence,
    action: "enable",
    status: "running",
    total: 1,
    completed: 0,
    servers: [
      {
        id: "time",
        label: "Time",
        status: sequence === 1 ? "queued" : "checking",
        detail: sequence === 1 ? "Queued" : "Checking readiness",
        terminal: false,
      },
    ],
  };
}

test("bulk toggle starts one authoritative operation instead of renderer polling", () => {
  const sourcePath = path.join(
    __dirname,
    "..",
    "renderer",
    "components",
    "mcp-servers.js",
  );
  const source = fs.readFileSync(sourcePath, "utf8");
  const authoritativeBlock = source.slice(
    source.indexOf("async function confirmBulkToggleServers() {"),
    source.indexOf("async function confirmBulkToggleServersLegacy() {"),
  );

  assert.match(authoritativeBlock, /McpOperationOverlayController/);
  assert.match(authoritativeBlock, /controller\.startOperation\(request/);
  assert.match(authoritativeBlock, /createMcpOperationRequest/);
  assert.doesNotMatch(authoritativeBlock, /toggleMcpServersBulk/);
  assert.doesNotMatch(authoritativeBlock, /refreshServerAfterOperation/);
});

test("REST toggle operations do not force a passive background presentation", () => {
  const apiPath = path.join(__dirname, "api.js");
  const source = fs.readFileSync(apiPath, "utf8");
  const routeStart = source.indexOf("apiApp.post('/api/toggle-mcp-server'");
  const toggleRoute = source.slice(
    routeStart,
    source.indexOf("return withTrackedSetupFlow", routeStart),
  );

  // The route must not hardcode a passive background presentation. Presentation
  // is decided in the renderer based on the originating chat tab (foreground
  // when active, deferred banner + tab attention otherwise), so the modal is
  // shown right away on the originating tab rather than always as a banner.
  assert.doesNotMatch(toggleRoute, /presentationMode:\s*'background'/);
  // The originating chat tab is threaded through so the renderer can attribute
  // the operation to the correct tab.
  assert.match(toggleRoute, /normalizeOptionalChatId\(req\.body\?\.chat_id\)/);
  assert.match(toggleRoute, /chat_id:\s*toggleChatId/);
});

test("single toggle and restart confirmations use authoritative operations", () => {
  const sourcePath = path.join(
    __dirname,
    "..",
    "renderer",
    "components",
    "mcp-servers.js",
  );
  const source = fs.readFileSync(sourcePath, "utf8");
  const toggleBlock = source.slice(
    source.indexOf("async function confirmToggleServer() {"),
    source.indexOf("async function confirmToggleServerLegacy() {"),
  );
  const restartBlock = source.slice(
    source.indexOf("async function confirmRestart() {"),
    source.indexOf("async function confirmRestartLegacy() {"),
  );

  assert.match(toggleBlock, /controller\.startOperation/);
  assert.match(toggleBlock, /createMcpOperationRequest\(enabled \? "enable" : "disable"/);
  assert.doesNotMatch(toggleBlock, /toggleMcpServer\(/);
  assert.match(restartBlock, /controller\.startOperation/);
  assert.match(restartBlock, /createMcpOperationRequest\("restart"/);
  assert.doesNotMatch(restartBlock, /apiRestartAllMcpServers/);
  assert.doesNotMatch(restartBlock, /apiRestartMcpServers/);
});

test("legacy post-operation refresh disposes its lifecycle subscription", () => {
  const sourcePath = path.join(
    __dirname,
    "..",
    "renderer",
    "components",
    "mcp-servers.js",
  );
  const source = fs.readFileSync(sourcePath, "utf8");
  const refreshStart = source.indexOf(
    "async function refreshServerAfterOperation",
  );
  const refreshBlock = source.slice(refreshStart, refreshStart + 20_000);
  assert.match(refreshBlock, /let lifecycleUnsubscribe = null/);
  assert.match(refreshBlock, /onServerLifecycleTransition\(lifecycleHandler\)/);
  assert.match(refreshBlock, /lifecycleUnsubscribe\?\.\(\)/);
});

test("authoritative MCP operation uses one subscription and remains backgrounded", async () => {
  const harness = buildControlPlaneHarness();
  await Promise.resolve();
  assert.equal(harness.subscriptions, 1);

  harness.emit(runningSnapshot(1));
  assert(harness.elements["mcp-operation-overlay"].classList.contains("visible"));
  assert(!harness.elements["loading-overlay"].classList.contains("visible"));
  assert.equal(harness.elements["mcp-operation-title"].textContent, "Enabling MCP servers");
  assert.equal(
    [...harness.timers.values()].some((timer) => timer.delay === 60_000),
    false,
  );

  harness.elements["mcp-operation-background-btn"].click();
  assert(!harness.elements["mcp-operation-overlay"].classList.contains("visible"));
  assert(!harness.elements["mcp-operation-banner"].classList.contains("hidden"));

  harness.emit(runningSnapshot(2));
  assert(!harness.elements["mcp-operation-overlay"].classList.contains("visible"));
  assert.equal(
    harness.elements["mcp-operation-banner-subtitle"].textContent,
    "0/1 server complete",
  );

  harness.emit({ ...runningSnapshot(1), title: "Stale update" });
  assert.equal(
    harness.window.McpOperationOverlayController.getCurrentSnapshot().revision,
    2,
  );
  assert.notEqual(harness.elements["mcp-operation-banner-title"].textContent, "Stale update");

  harness.elements["mcp-operation-banner"].click();
  assert(harness.elements["mcp-operation-overlay"].classList.contains("visible"));
  assert(harness.elements["mcp-operation-banner"].classList.contains("hidden"));

  harness.window.McpOperationOverlayController.dispose();
  assert.equal(harness.unsubscribeCalls, 1);
});

test("MCP operation rows render the server display name instead of its ID", async () => {
  const harness = buildControlPlaneHarness();
  await Promise.resolve();

  harness.emit({
    operationId: "restart-atlassian",
    sequence: 3,
    action: "restart",
    status: "running",
    servers: [
      {
        id: "mcp-atlassian",
        label: "Atlassian",
        status: "running",
        phase: "reloading_routes",
      },
    ],
  });

  const markup = harness.elements["mcp-operation-list"].innerHTML;
  assert.match(
    markup,
    /class="loading-progress-row-label">Atlassian<\/div>/,
  );
  assert.doesNotMatch(
    markup,
    /class="loading-progress-row-label">mcp-atlassian<\/div>/,
  );
  harness.window.McpOperationOverlayController.dispose();
});

test("chat-triggered MCP operation foregrounds the modal and suppresses the native chat view", async () => {
  const harness = buildControlPlaneHarness();
  await Promise.resolve();

  harness.emit({
    ...runningSnapshot(1),
    operationId: "chat-tool-enable-op",
    metadata: {
      presentationSource: "chat_tool",
    },
  });

  // Shown right away: modal visible on top with the native chat view suppressed
  // so the header stays visible and the later auth step is a natural follow-on.
  assert(harness.elements["mcp-operation-overlay"].classList.contains("visible"));
  assert(harness.elements["mcp-operation-banner"].classList.contains("hidden"));
  assert(harness.suppressionReasons.has("mcp-operation-overlay"));

  // Backgrounding still works and releases the native-view suppression.
  harness.window.McpOperationOverlayController.background();
  assert(!harness.elements["mcp-operation-overlay"].classList.contains("visible"));
  assert(!harness.elements["mcp-operation-banner"].classList.contains("hidden"));
  assert.equal(harness.elements["mcp-operation-banner"].disabled, false);
  assert(!harness.suppressionReasons.has("mcp-operation-overlay"));

  harness.window.McpOperationOverlayController.dispose();
  assert(!harness.suppressionReasons.has("mcp-operation-overlay"));
});

test("chat-triggered operation on a background tab defers to a banner and flashes the originating tab", async () => {
  const harness = buildControlPlaneHarness();
  await Promise.resolve();

  const attentionCalls = [];
  harness.window.appState.activeTab = "chat";
  harness.window.setChatTabAttentionRequired = (tabId, required) => {
    attentionCalls.push({ tabId, required });
  };
  harness.window.backendModalAttention = {
    resolveTabIdForPayload: ({ chat_id }) =>
      chat_id === "chat-xyz" ? "tab-1" : null,
    getPendingCountForTab: () => 0,
  };

  harness.emit({
    ...runningSnapshot(1),
    operationId: "chat-defer-op",
    metadata: {
      presentationSource: "chat_tool",
      chat_id: "chat-xyz",
    },
  });

  // The originating conversation tab ("tab-1" -> "conversation-tab-1") is not
  // the active tab, so the modal must not pop up over the unrelated tab.
  assert(!harness.elements["mcp-operation-overlay"].classList.contains("visible"));
  assert(!harness.elements["mcp-operation-banner"].classList.contains("hidden"));
  assert(!harness.suppressionReasons.has("mcp-operation-overlay"));
  assert.deepEqual(attentionCalls, [{ tabId: "tab-1", required: true }]);

  // Returning to the originating tab surfaces the modal and clears the flash.
  harness.window.appState.activeTab = "conversation-tab-1";
  const shown =
    harness.window.McpOperationOverlayController.handleActiveTabChange(
      "conversation-tab-1",
    );
  assert.equal(shown, true);
  assert(harness.elements["mcp-operation-overlay"].classList.contains("visible"));
  assert(harness.elements["mcp-operation-banner"].classList.contains("hidden"));
  assert(harness.suppressionReasons.has("mcp-operation-overlay"));
  assert.deepEqual(attentionCalls[attentionCalls.length - 1], {
    tabId: "tab-1",
    required: false,
  });

  harness.window.McpOperationOverlayController.dispose();
});

test("a foregrounded chat operation is deferred to a banner when the user switches away", async () => {
  const harness = buildControlPlaneHarness();
  await Promise.resolve();

  const attentionCalls = [];
  // The user is on the originating tab when the toggle starts.
  harness.window.appState.activeTab = "conversation-tab-1";
  harness.window.setChatTabAttentionRequired = (tabId, required) => {
    attentionCalls.push({ tabId, required });
  };
  harness.window.backendModalAttention = {
    resolveTabIdForPayload: ({ chat_id }) =>
      chat_id === "chat-xyz" ? "tab-1" : null,
    getPendingCountForTab: () => 0,
  };

  harness.emit({
    ...runningSnapshot(1),
    operationId: "chat-switch-op",
    metadata: {
      presentationSource: "chat_tool",
      chat_id: "chat-xyz",
    },
  });

  // Shown up front because the originating tab is active.
  assert(harness.elements["mcp-operation-overlay"].classList.contains("visible"));
  assert(harness.suppressionReasons.has("mcp-operation-overlay"));

  // Switching to an unrelated tab must hide the modal and flash the origin tab.
  harness.window.appState.activeTab = "chat";
  harness.window.McpOperationOverlayController.handleActiveTabChange("chat");
  assert(!harness.elements["mcp-operation-overlay"].classList.contains("visible"));
  assert(!harness.elements["mcp-operation-banner"].classList.contains("hidden"));
  assert(!harness.suppressionReasons.has("mcp-operation-overlay"));
  assert.deepEqual(attentionCalls[attentionCalls.length - 1], {
    tabId: "tab-1",
    required: true,
  });

  harness.window.McpOperationOverlayController.dispose();
});

test("chat-triggered operation on the active originating tab foregrounds immediately", async () => {
  const harness = buildControlPlaneHarness();
  await Promise.resolve();

  const attentionCalls = [];
  harness.window.appState.activeTab = "conversation-tab-1";
  harness.window.setChatTabAttentionRequired = (tabId, required) => {
    attentionCalls.push({ tabId, required });
  };
  harness.window.backendModalAttention = {
    resolveTabIdForPayload: ({ chat_id }) =>
      chat_id === "chat-xyz" ? "tab-1" : null,
    getPendingCountForTab: () => 0,
  };

  harness.emit({
    ...runningSnapshot(1),
    operationId: "chat-active-op",
    metadata: {
      presentationSource: "chat_tool",
      chat_id: "chat-xyz",
    },
  });

  // The user is already on the originating tab, so the modal opens right away
  // and no attention flashing is needed.
  assert(harness.elements["mcp-operation-overlay"].classList.contains("visible"));
  assert(harness.elements["mcp-operation-banner"].classList.contains("hidden"));
  assert(harness.suppressionReasons.has("mcp-operation-overlay"));
  assert.deepEqual(attentionCalls, []);

  harness.window.McpOperationOverlayController.dispose();
});

test("starting an operation shows queued progress before accepting the main snapshot", async () => {
  let receivedRequest = null;
  const harness = buildControlPlaneHarness({
    startMcpOperation: async (request) => {
      receivedRequest = request;
      return {
        operationId: "backend-operation",
        desiredRevision: 9,
        sequence: 1,
        action: request.action,
        status: "running",
        total: 1,
        completed: 0,
        servers: [{ id: "slack", label: "Slack", status: "queued" }],
      };
    },
  });
  await Promise.resolve();
  const result = await harness.window.McpOperationOverlayController.startOperation(
    {
      clientRequestId: "client-request",
      action: "enable",
      kind: "enable",
      serverIds: ["slack"],
    },
    { servers: [{ id: "slack", label: "Slack" }] },
  );

  assert.equal(receivedRequest.clientRequestId, "client-request");
  assert.equal(result.operationId, "backend-operation");
  assert.equal(
    harness.window.McpOperationOverlayController.getCurrentSnapshot().operationId,
    "backend-operation",
  );
  assert(harness.elements["mcp-operation-overlay"].classList.contains("visible"));
  harness.window.McpOperationOverlayController.dispose();
});

test("background choice survives optimistic-to-authoritative operation ID handoff", async () => {
  let resolveStart;
  const harness = buildControlPlaneHarness({
    startMcpOperation: () =>
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
  });
  await Promise.resolve();
  const startPromise = harness.window.McpOperationOverlayController.startOperation(
    {
      clientRequestId: "client-before-backend-id",
      action: "enable",
      kind: "enable",
      serverIds: ["slack"],
    },
    { servers: [{ id: "slack", label: "Slack" }] },
  );
  assert(harness.elements["mcp-operation-overlay"].classList.contains("visible"));
  harness.elements["mcp-operation-background-btn"].click();

  resolveStart({
    kind: "mcp_operation",
    operationId: "authoritative-operation-id",
    action: "enable",
    desiredRevision: 2,
    sequence: 1,
    status: "queued",
    servers: [{ id: "slack", label: "Slack", status: "queued" }],
  });
  await startPromise;

  assert(!harness.elements["mcp-operation-overlay"].classList.contains("visible"));
  assert(!harness.elements["mcp-operation-banner"].classList.contains("hidden"));
  harness.window.McpOperationOverlayController.dispose();
});

test("busy start does not re-foreground the active background operation", async () => {
  const activeOperation = runningSnapshot(2);
  const harness = buildControlPlaneHarness({
    startMcpOperation: async () => ({
      success: false,
      errorCode: "MCP_OPERATION_BUSY",
      error: "Another MCP operation is already active",
      activeOperation,
    }),
  });
  await Promise.resolve();
  harness.emit(runningSnapshot(1));
  harness.elements["mcp-operation-background-btn"].click();

  const result = await harness.window.McpOperationOverlayController.startOperation(
    {
      clientRequestId: "second-operation-request",
      action: "enable",
      kind: "enable",
      serverIds: ["snowflake"],
    },
    { servers: [{ id: "snowflake", label: "Snowflake" }] },
  );

  assert.equal(result.operationId, activeOperation.operationId);
  assert(!harness.elements["mcp-operation-overlay"].classList.contains("visible"));
  assert(!harness.elements["mcp-operation-banner"].classList.contains("hidden"));
  assert.deepEqual(
    JSON.parse(
      harness.storageValues.get(
        "portico.mcp-operation-presentation.v1",
      ),
    ),
    {
      operationId: activeOperation.operationId,
      mode: "background",
    },
  );
  harness.window.McpOperationOverlayController.dispose();
});

test("partial completion stays visible until Done", async () => {
  const harness = buildControlPlaneHarness();
  await Promise.resolve();
  harness.emit({
    operationId: "partial-op",
    sequence: 3,
    action: "enable",
    status: "partial",
    total: 2,
    completed: 2,
    failed: 1,
    servers: [
      {
        id: "slack",
        label: "Slack",
        status: "succeeded",
        terminal: true,
        success: true,
      },
      {
        id: "snowflake",
        label: "Snowflake",
        status: "timed_out",
        terminal: true,
        success: false,
        error: "Readiness timed out",
      },
    ],
  });

  assert(harness.elements["mcp-operation-overlay"].classList.contains("visible"));
  assert(!harness.elements["mcp-operation-footer"].classList.contains("hidden"));
  assert.match(
    harness.elements["mcp-operation-list"].innerHTML,
    /data-mcp-operation-action="logs"[^>]*>View logs</,
  );
  assert.equal(
    [...harness.timers.values()].some(
      (timer) => timer.delay === 1_500 || timer.delay === 5_000,
    ),
    false,
  );
  // The foreground failure-terminal modal holds the native-view suppression
  // open (no auto-close timer), so the release below is a real transition.
  assert(harness.suppressionReasons.has("mcp-operation-overlay"));

  harness.elements["mcp-operation-done-btn"].click();
  assert(!harness.elements["mcp-operation-overlay"].classList.contains("visible"));
  // Dismissing a failure-terminal snapshot must release the native-view
  // suppression so the OWUI chat view is interactive again.
  assert(!harness.suppressionReasons.has("mcp-operation-overlay"));
  harness.window.McpOperationOverlayController.dispose();
});

test("setup-attention rows use warning presentation and keep existing actions", async () => {
  const harness = buildControlPlaneHarness();
  await Promise.resolve();
  harness.emit({
    kind: "mcp_operation",
    operationId: "attention-op",
    action: "enable",
    sequence: 5,
    status: "attention_required",
    total: 3,
    completed: 3,
    servers: [
      {
        id: "google-workspace",
        label: "Google Workspace",
        status: "attention_required",
        phase: "needs_oauth",
        terminal: true,
        requiredAction: { type: "authorize" },
      },
      {
        id: "gitlab",
        label: "GitLab",
        status: "attention_required",
        phase: "not_configured",
        terminal: true,
        requiredAction: "configure",
      },
      {
        id: "slack",
        label: "Slack",
        status: "attention_required",
        phase: "waiting_callback",
        terminal: true,
        requiredAction: "oauth",
      },
    ],
  });

  const markup = harness.elements["mcp-operation-list"].innerHTML;
  assert.match(
    markup,
    /class="loading-progress-row terminal-warning" data-server-id="google-workspace"/,
  );
  assert.match(
    markup,
    /class="loading-progress-row terminal-warning" data-server-id="gitlab"/,
  );
  assert.match(
    markup,
    /class="loading-progress-row terminal-warning" data-server-id="slack"/,
  );
  assert.doesNotMatch(markup, /terminal-error/);
  assert.match(markup, /data-mcp-operation-action="oauth"[^>]*>Authenticate</);
  assert.match(markup, /data-mcp-operation-action="configure"[^>]*>Configure</);
  harness.window.McpOperationOverlayController.dispose();
});

test("attention OAuth action uses server-level OAuth wizard route", async () => {
  const calls = [];
  const harness = buildControlPlaneHarness();
  harness.window.runOAuthFlowForServer = async (serverId) => {
    calls.push({ kind: "wizard", serverId });
    return { completedCount: 0, completedServerIds: [] };
  };
  harness.window.runOAuthFlowForSingleServer = async (serverId) => {
    calls.push({ kind: "legacy", serverId });
  };

  await Promise.resolve();
  harness.emit({
    operationId: "enable-op-1",
    sequence: 5,
    action: "enable",
    status: "attention_required",
    total: 1,
    completed: 1,
    servers: [
      {
        id: "data-plat-mcp",
        label: "Data Platform",
        status: "attention_required",
        phase: "needs_oauth",
        terminal: true,
        requiredAction: { type: "authorize" },
      },
    ],
  });

  await clickOperationAction(harness, {
    action: "oauth",
    serverId: "data-plat-mcp",
  });

  assert.deepEqual(calls, [{ kind: "wizard", serverId: "data-plat-mcp" }]);
  harness.window.McpOperationOverlayController.dispose();
});

test("successful OAuth reconciles the visible needs-auth operation row", async () => {
  const harness = buildControlPlaneHarness();
  harness.window.runOAuthFlowForServer = async () => ({
    completedCount: 1,
    completedServerIds: ["productkit-mcp"],
  });
  harness.window.refreshServerAfterOperation = async () => ({
    success: true,
    healthy: true,
    enabledCount: 18,
    totalCount: 18,
  });

  await Promise.resolve();
  harness.emit({
    operationId: "enable-productkit",
    sequence: 5,
    action: "enable",
    status: "attention_required",
    total: 1,
    completed: 1,
    servers: [
      {
        id: "productkit-mcp",
        label: "Product Kit",
        status: "attention_required",
        phase: "needs_oauth",
        terminal: true,
        requiredAction: { type: "authorize" },
      },
    ],
  });

  await clickOperationAction(harness, {
    action: "oauth",
    serverId: "productkit-mcp",
  });

  const snapshot = harness.window.McpOperationOverlayController.getCurrentSnapshot();
  assert.equal(snapshot.status, "succeeded");
  assert.equal(snapshot.successful, true);
  assert.equal(snapshot.rows[0].stage, "healthy");
  assert.equal(snapshot.rows[0].requiredAction, null);
  assert.match(harness.elements["mcp-operation-list"].innerHTML, /Authenticated and ready/);
  assert.doesNotMatch(
    harness.elements["mcp-operation-list"].innerHTML,
    /data-mcp-operation-action="oauth"/,
  );
  harness.window.McpOperationOverlayController.dispose();
});

test("backend OAuth completion reconciles a needs-auth row without an Authenticate click", async () => {
  const harness = buildControlPlaneHarness();
  harness.window.refreshServerAfterOperation = async () => ({
    success: true,
    healthy: true,
  });

  await Promise.resolve();
  harness.emit({
    operationId: "enable-assumeapi-smart",
    sequence: 2,
    action: "enable",
    status: "attention_required",
    total: 1,
    completed: 1,
    servers: [
      {
        id: "assumeapi-smart",
        label: "assumeapi-smart",
        status: "attention_required",
        phase: "needs_oauth",
        terminal: true,
        requiredAction: { type: "authorize" },
      },
    ],
  });

  const reconciled =
    await harness.window.McpOperationOverlayController.reconcileOAuthCompletion(
      "assumeapi-smart",
    );

  assert.equal(reconciled, true);
  const snapshot = harness.window.McpOperationOverlayController.getCurrentSnapshot();
  assert.equal(snapshot.status, "succeeded");
  assert.equal(snapshot.rows[0].stage, "healthy");
  assert.equal(snapshot.rows[0].stageLabel, "Connected");
  assert.equal(snapshot.rows[0].requiredAction, null);
  assert.doesNotMatch(
    harness.elements["mcp-operation-list"].innerHTML,
    /data-mcp-operation-action="oauth"/,
  );
  harness.window.McpOperationOverlayController.dispose();
});

test("OAuth follow-up does not rewrite a newer operation", async () => {
  const harness = buildControlPlaneHarness();
  let resolveOAuth;
  harness.window.runOAuthFlowForServer = () =>
    new Promise((resolve) => {
      resolveOAuth = resolve;
    });
  harness.window.refreshServerAfterOperation = async () => ({ healthy: true });

  await Promise.resolve();
  harness.emit({
    operationId: "old-operation",
    sequence: 1,
    action: "enable",
    status: "attention_required",
    servers: [
      {
        id: "productkit-mcp",
        status: "attention_required",
        phase: "needs_oauth",
        terminal: true,
      },
    ],
  });
  const click = clickOperationAction(harness, {
    action: "oauth",
    serverId: "productkit-mcp",
  });
  await Promise.resolve();
  harness.emit({
    operationId: "new-operation",
    sequence: 1,
    action: "enable",
    status: "attention_required",
    servers: [
      {
        id: "other-server",
        status: "attention_required",
        phase: "not_configured",
        terminal: true,
      },
    ],
  });
  resolveOAuth({
    completedCount: 1,
    completedServerIds: ["productkit-mcp"],
  });
  await click;

  const snapshot = harness.window.McpOperationOverlayController.getCurrentSnapshot();
  assert.equal(snapshot.operationId, "new-operation");
  assert.equal(snapshot.status, "attention_required");
  assert.equal(snapshot.rows[0].id, "other-server");
  harness.window.McpOperationOverlayController.dispose();
});

test("OAuth follow-up does not show Connected from tool counts without healthy readiness", async () => {
  const harness = buildControlPlaneHarness();
  harness.window.runOAuthFlowForServer = async () => ({
    completedCount: 1,
    completedServerIds: ["productkit-mcp"],
  });
  harness.window.refreshServerAfterOperation = async () => ({
    healthy: false,
    enabledCount: 18,
    totalCount: 18,
  });

  await Promise.resolve();
  harness.emit({
    operationId: "unhealthy-productkit",
    sequence: 1,
    action: "enable",
    status: "attention_required",
    servers: [
      {
        id: "productkit-mcp",
        status: "attention_required",
        phase: "needs_oauth",
        terminal: true,
      },
    ],
  });
  await clickOperationAction(harness, {
    action: "oauth",
    serverId: "productkit-mcp",
  });

  const snapshot = harness.window.McpOperationOverlayController.getCurrentSnapshot();
  assert.equal(snapshot.status, "attention_required");
  assert.equal(snapshot.rows[0].stage, "needs_oauth");
  harness.window.McpOperationOverlayController.dispose();
});

test("background presentation is restored from localStorage and operation history", async () => {
  const storageKey = "portico.mcp-operation-presentation.v1";
  const persistedOperation = {
    ...runningSnapshot(4),
    operationId: "persisted-op",
  };
  const harness = buildControlPlaneHarness({
    storage: {
      [storageKey]: JSON.stringify({
        operationId: "persisted-op",
        mode: "background",
      }),
    },
    latestOperation: persistedOperation,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert(!harness.elements["mcp-operation-overlay"].classList.contains("visible"));
  assert(!harness.elements["mcp-operation-banner"].classList.contains("hidden"));
  assert.equal(
    harness.window.McpOperationOverlayController.getCurrentSnapshot().operationId,
    "persisted-op",
  );
  harness.window.McpOperationOverlayController.dispose();
});

test("pre-ack background state rekeys from client request ID after reload", async () => {
  const storageKey = "portico.mcp-operation-presentation.v1";
  const harness = buildControlPlaneHarness({
    storage: {
      [storageKey]: JSON.stringify({
        operationId: "client-before-reload",
        mode: "background",
      }),
    },
    activeOperation: {
      ...runningSnapshot(2),
      operationId: "authoritative-after-reload",
      clientRequestId: "client-before-reload",
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert(!harness.elements["mcp-operation-overlay"].classList.contains("visible"));
  assert(!harness.elements["mcp-operation-banner"].classList.contains("hidden"));
  assert.equal(
    JSON.parse(harness.storageValues.get(storageKey)).operationId,
    "authoritative-after-reload",
  );
  harness.window.McpOperationOverlayController.dispose();
});

test("successful foreground and background completions close on their own timers", async () => {
  const foregroundHarness = buildControlPlaneHarness();
  await Promise.resolve();
  foregroundHarness.emit({
    operationId: "success-foreground",
    sequence: 2,
    action: "enable",
    status: "succeeded",
    total: 1,
    completed: 1,
    servers: [
      { id: "slack", label: "Slack", status: "succeeded", terminal: true },
    ],
  });
  assert(foregroundHarness.elements["mcp-operation-overlay"].classList.contains("visible"));
  assert.equal(
    foregroundHarness.document.body.child.textContent,
    "1 MCP server enabled successfully",
  );
  foregroundHarness.fireTimerWithDelay(1_500);
  assert(!foregroundHarness.elements["mcp-operation-overlay"].classList.contains("visible"));
  foregroundHarness.window.McpOperationOverlayController.dispose();

  const backgroundHarness = buildControlPlaneHarness();
  await Promise.resolve();
  backgroundHarness.emit(runningSnapshot(1));
  backgroundHarness.elements["mcp-operation-background-btn"].click();
  backgroundHarness.emit({
    operationId: "enable-op-1",
    sequence: 2,
    action: "enable",
    status: "succeeded",
    total: 1,
    completed: 1,
    servers: [
      { id: "time", label: "Time", status: "succeeded", terminal: true },
    ],
  });
  assert(!backgroundHarness.elements["mcp-operation-banner"].classList.contains("hidden"));
  backgroundHarness.fireTimerWithDelay(5_000);
  assert(backgroundHarness.elements["mcp-operation-banner"].classList.contains("hidden"));
  backgroundHarness.window.McpOperationOverlayController.dispose();
});

test("terminal presentation waits for delayed main-process effects finalization", async () => {
  const harness = buildControlPlaneHarness();
  await Promise.resolve();
  harness.emit({
    operationId: "delayed-invalidation",
    sequence: 2,
    action: "enable",
    status: "succeeded",
    effectsFinalized: false,
    total: 1,
    completed: 1,
    progressPercent: 100,
    servers: [
      { id: "slack", label: "Slack", status: "succeeded", terminal: true },
    ],
  });

  assert(harness.elements["mcp-operation-overlay"].classList.contains("visible"));
  assert.equal(
    [...harness.timers.values()].some((timer) => timer.delay === 1_500),
    false,
  );

  harness.emit({
    operationId: "delayed-invalidation",
    sequence: 3,
    action: "enable",
    status: "succeeded",
    effectsFinalized: true,
    total: 1,
    completed: 1,
    progressPercent: 100,
    servers: [
      { id: "slack", label: "Slack", status: "succeeded", terminal: true },
    ],
  });
  harness.fireTimerWithDelay(1_500);
  assert(!harness.elements["mcp-operation-overlay"].classList.contains("visible"));
  harness.window.McpOperationOverlayController.dispose();
});

test("startup_failed rows render a View logs action with wrapped-detail styling", async () => {
  const harness = buildControlPlaneHarness();
  await Promise.resolve();
  harness.emit({
    operationId: "startup-failed-op",
    sequence: 4,
    action: "enable",
    status: "failed",
    total: 1,
    completed: 1,
    failed: 1,
    servers: [
      {
        id: "snowflake",
        label: "Snowflake",
        status: "failed",
        phase: "startup_failed",
        terminal: true,
        success: false,
        error:
          "Failed to start. Logs indicate a credential error (rejected token or failed authentication) — fix the credential and re-enable. The runtime kept returning HTTP 503 while starting. Check the server logs for details.",
      },
    ],
  });

  const list = harness.elements["mcp-operation-list"].innerHTML;
  // The failed row carries the terminal-error class (which unlocks the
  // 3-line wrapped detail styling) and the View logs action button.
  assert.match(list, /loading-progress-row[^"]*terminal-error/);
  assert.doesNotMatch(list, /terminal-warning/);
  assert.match(
    list,
    /data-mcp-operation-action="logs"[^>]*data-server-id="snowflake"[^>]*>View logs</,
  );
  assert.match(list, /Failed to start\. Logs indicate a credential error/);
  assert.match(list, /Failed to start<\/div>/);
  harness.window.McpOperationOverlayController.dispose();
});
