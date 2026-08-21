const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { FakeElement } = require("./test-helpers/fake-dom");

class WizardElement extends FakeElement {
  querySelector(selector) {
    if (
      selector === ".oauth-wizard-test-steps" &&
      this.innerHTML.includes('class="oauth-wizard-test-steps"')
    ) {
      return { outerHTML: '<div class="oauth-wizard-test-steps"></div>' };
    }
    return null;
  }

  querySelectorAll() {
    return [];
  }

  insertAdjacentHTML() {}
}

function buildWizardState(overrides = {}) {
  return {
    servers: [],
    currentIndex: 0,
    completedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    completedServerIds: [],
    resolveFlow: null,
    escapeHandler: null,
    queueStarted: false,
    flowLocked: false,
    pendingAutoStartIndex: null,
    flowSource: "manual",
    requestedServerId: null,
    dismissibleRequestServerId: null,
    backendManagedServerIds: new Set(),
    backendCompletionNotifiedServerIds: new Set(),
    backendRequestOutcomes: new Map(),
    contractorDeniedServerIds: new Set(),
    wasDismissed: false,
    activePollAbortController: null,
    ...overrides,
  };
}

function buildOauthWizardHarness() {
  const sourcePath = path.join(
    __dirname,
    "..",
    "renderer",
    "components",
    "oauth-wizard-modal.js",
  );
  const source = `${fs.readFileSync(sourcePath, "utf8")}
window.__oauthWizardTestHooks = {
  closeWizardModal,
  pollWizardOAuthCompletionWithManualRestart,
  redactWizardOAuthAuthUrls,
  revealExistingOAuthWizard,
  runOAuthWizard,
  startWizardProdRecovery,
  prepareWizardForFreshOAuthStart,
  handleWizardOAuthVerification,
  notifyBackendOAuthCompletionOnce,
  restartWizardOAuthSession,
  renderWizardTestingSteps,
  showWizardTestingError,
  showOAuthWizardModal,
  getState() {
    return oauthWizardState;
  },
  setState(nextState) {
    oauthWizardState = nextState;
  },
  getFlowInProgress() {
    return oauthWizardFlowInProgress;
  },
  setFlowInProgress(nextValue) {
    oauthWizardFlowInProgress = nextValue;
  },
};
`;

  const elements = new Map();
  const documentListeners = new Map();
  const suppressionChanges = [];
  const postSuccessStartingCalls = [];
  const oauthAuthenticatedCalls = [];
  const oauthServerDoneCalls = [];
  const oauthDismissedCalls = [];
  let postOauthRecoveryCalls = 0;
  let openExternalCalls = 0;

  const ensureElement = (id) => {
    if (!elements.has(id)) {
      elements.set(id, new WizardElement(id));
    }
    return elements.get(id);
  };

  [
    "oauth-wizard-modal",
    "oauth-wizard-main-content",
    "oauth-wizard-completion",
    "oauth-wizard-preview",
    "oauth-wizard-current-server",
    "oauth-wizard-buttons",
    "oauth-wizard-authorize-btn",
    "oauth-wizard-prev-btn",
    "oauth-wizard-next-btn",
    "oauth-wizard-skip-all-btn",
    "oauth-wizard-testing",
    "oauth-wizard-testing-content",
    "oauth-wizard-status-text",
    "oauth-wizard-progress-text",
    "oauth-wizard-description",
    "oauth-wizard-server-icon",
    "oauth-wizard-server-name",
    "oauth-wizard-server-description",
    "oauth-wizard-done-btn",
    "oauth-wizard-finalizing",
    "oauth-wizard-stats",
    "oauth-wizard-stat-done",
    "oauth-wizard-stat-skipped",
    "oauth-wizard-stat-failed",
    "oauth-wizard-close-btn",
    "oauth-wizard-progress",
  ].forEach(ensureElement);

  const document = {
    createElement() {
      return new WizardElement();
    },
    getElementById(id) {
      return ensureElement(id);
    },
    querySelector(selector) {
      if (selector === ".oauth-wizard-progress") {
        return ensureElement("oauth-wizard-progress");
      }
      return null;
    },
    querySelectorAll() {
      return [];
    },
    addEventListener(type, handler) {
      documentListeners.set(type, handler);
    },
    removeEventListener(type, handler) {
      const current = documentListeners.get(type);
      if (!handler || current === handler) {
        documentListeners.delete(type);
      }
    },
  };

  const context = {
    console,
    document,
    fetch: async () => ({
      async text() {
        return "<div></div>";
      },
    }),
    setTimeout(handler) {
      return setTimeout(handler, 0);
    },
    clearTimeout(timeoutId) {
      clearTimeout(timeoutId);
    },
    setInterval(handler) {
      return setInterval(handler, 0);
    },
    clearInterval(intervalId) {
      clearInterval(intervalId);
    },
    window: {
      electronAPI: {
        async checkOAuthTokensExist() {
          return { exists: false };
        },
        async prepareOAuthStart() {
          return { success: true, cleared: true };
        },
        async openExternal() {
          openExternalCalls += 1;
        },
        async stopSingleMcpServer() {},
        async startSingleMcpServer() {
          return { success: true };
        },
        async getOAuthStatusSingle() {
          return {
            active: [
              {
                server_name: "data-plat-mcp",
                authorization_url: "https://auth.example.test",
              },
            ],
            completed: [],
            failed: [],
          };
        },
        async pollOAuthCompletionSingle() {
          return { completed: true };
        },
        async waitForPostOauthServerRecovery() {
          postOauthRecoveryCalls += 1;
          return { state: "ready", toolCount: 1, healthy: true };
        },
        notifyOAuthServerDone(serverId) {
          oauthServerDoneCalls.push(serverId);
        },
        notifyOAuthDismissed(serverId) {
          oauthDismissedCalls.push(serverId);
        },
      },
      refreshServerAfterOperation: async () => ({
        success: true,
        healthy: true,
        enabledCount: 1,
        totalCount: 1,
      }),
      markMcpServerPostSuccessStarting(serverId, options = {}) {
        postSuccessStartingCalls.push({ serverId, ...options });
      },
      markMcpServerOAuthAuthenticated(serverId, options = {}) {
        oauthAuthenticatedCalls.push({ serverId, ...options });
      },
      setOwuiInteractionSuppressed(reason, suppressed) {
        suppressionChanges.push({ layer: "owui", reason, suppressed });
      },
      setNativeOverlayInteractionSuppressed(reason, suppressed) {
        suppressionChanges.push({ layer: "native", reason, suppressed });
      },
    },
  };

  vm.runInNewContext(source, context, { filename: sourcePath });

  return {
    hooks: context.window.__oauthWizardTestHooks,
    window: context.window,
    elements,
    documentListeners,
    suppressionChanges,
    getOpenExternalCalls() {
      return openExternalCalls;
    },
    getPostSuccessStartingCalls() {
      return postSuccessStartingCalls.slice();
    },
    getOauthAuthenticatedCalls() {
      return oauthAuthenticatedCalls.slice();
    },
    getOauthServerDoneCalls() {
      return oauthServerDoneCalls.slice();
    },
    getOauthDismissedCalls() {
      return oauthDismissedCalls.slice();
    },
    getPostOauthRecoveryCalls() {
      return postOauthRecoveryCalls;
    },
    async flush() {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

function readOauthWizardTemplate() {
  return fs.readFileSync(
    path.join(__dirname, "..", "renderer", "components", "oauth-wizard-modal.html"),
    "utf8",
  );
}

function getCssRuleBlock(source, selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\}`));
  return match ? match[1] : "";
}

test("oauth wizard testing styles use the guided setup horizontal step grid", () => {
  const source = readOauthWizardTemplate();
  const stepsBlock = getCssRuleBlock(source, ".oauth-wizard-test-steps");
  const stepBlock = getCssRuleBlock(source, ".oauth-wizard-test-step");
  const containerBlock = getCssRuleBlock(source, ".oauth-wizard-test-container");
  const stepsPanelBlock = getCssRuleBlock(source, ".oauth-wizard-steps-panel");

  assert.match(stepsBlock, /display:\s*grid;/);
  assert.match(stepsBlock, /grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\);/);
  assert.doesNotMatch(stepsBlock, /flex-direction:\s*column;/);
  assert.match(stepBlock, /flex-direction:\s*column;/);
  assert.match(stepBlock, /min-height:\s*9rem;/);
  assert.match(containerBlock, /flex-direction:\s*column;/);
  assert.match(stepsPanelBlock, /width:\s*100%;/);
});

test("oauth wizard testing markup keeps retry controls in a horizontal action row", () => {
  const harness = buildOauthWizardHarness();
  const container = harness.elements.get("oauth-wizard-testing-content");

  harness.hooks.renderWizardTestingSteps();

  assert.match(container.innerHTML, /class="oauth-wizard-test-steps"/);
  assert.match(
    container.innerHTML,
    /data-step="poll"[\s\S]*class="oauth-wizard-test-action-row"[\s\S]*id="oauth-wizard-restart-auth-btn"/,
  );
  assert.doesNotMatch(container.innerHTML, /justify-content:\s*space-between/);
});

test("oauth wizard error layout stacks full-width steps, error summary, and logs", async () => {
  const harness = buildOauthWizardHarness();
  const container = harness.elements.get("oauth-wizard-testing-content");

  harness.window.electronAPI.getWizardMcpServerLogs = async () => ({
    logs: "line 1\nline 2",
  });
  harness.hooks.renderWizardTestingSteps();

  await harness.hooks.showWizardTestingError("broken", "glean");

  const errorMarkup = container.innerHTML;
  assert.match(
    errorMarkup,
    /class="oauth-wizard-steps-panel"[\s\S]*class="oauth-wizard-test-steps"/,
  );
  assert.match(errorMarkup, /class="oauth-wizard-error-panel"[\s\S]*id="oauth-wizard-retry-btn"/);
  assert.match(errorMarkup, /class="oauth-wizard-logs-container"/);
  assert.ok(
    errorMarkup.indexOf('class="oauth-wizard-steps-panel"') <
      errorMarkup.indexOf('class="oauth-wizard-error-panel"'),
  );
  assert.ok(
    errorMarkup.indexOf('class="oauth-wizard-error-panel"') <
      errorMarkup.indexOf('class="oauth-wizard-logs-container"'),
  );
});

test("oauth wizard busy-lease errors render wait guidance without fetching logs", async () => {
  const harness = buildOauthWizardHarness();
  const container = harness.elements.get("oauth-wizard-testing-content");

  let logsFetched = 0;
  harness.window.electronAPI.getWizardMcpServerLogs = async () => {
    logsFetched += 1;
    return { logs: "should not appear" };
  };
  harness.hooks.renderWizardTestingSteps();

  const busyMessage =
    "Another MCP change is still running (restart_mcp_server, started by oauth-complete-recovery, 1s ago). Wait for it to finish, or restart Portico if it looks stuck.";
  await harness.hooks.showWizardTestingError(busyMessage, "trust-kit-mcp", null, {
    errorCode: "MCP_OPERATION_BUSY",
  });

  const errorMarkup = container.innerHTML;
  assert.equal(logsFetched, 0, "busy errors must not fetch container logs");
  assert.match(errorMarkup, /A previous change is still finishing/);
  assert.match(errorMarkup, /oauth-complete-recovery/);
  assert.match(errorMarkup, /Wait a few seconds and press Retry\./);
  assert.match(errorMarkup, /id="oauth-wizard-retry-btn"/);
  assert.doesNotMatch(errorMarkup, /Oops\. Something went wrong\./);
  assert.doesNotMatch(errorMarkup, /oauth-wizard-logs-container/);
});

test("oauth wizard errors without a busy code keep the generic panel and logs", async () => {
  const harness = buildOauthWizardHarness();
  const container = harness.elements.get("oauth-wizard-testing-content");

  harness.window.electronAPI.getWizardMcpServerLogs = async () => ({
    logs: "container output",
  });
  harness.hooks.renderWizardTestingSteps();

  await harness.hooks.showWizardTestingError("broken", "glean", null, {
    errorCode: null,
  });

  const errorMarkup = container.innerHTML;
  assert.match(errorMarkup, /Oops\. Something went wrong\./);
  assert.match(errorMarkup, /class="oauth-wizard-logs-container"/);
  assert.doesNotMatch(errorMarkup, /A previous change is still finishing/);
});

test("oauth wizard visibility applies and clears both suppression layers", async () => {
  const harness = buildOauthWizardHarness();
  const modal = harness.elements.get("oauth-wizard-modal");
  let resolved = false;

  harness.hooks.setState(
    buildWizardState({
      servers: [
        {
          server: { id: "data-plat-mcp" },
          metadata: {
            id: "data-plat-mcp",
            name: "data-plat-mcp",
            display_name: "Data Platform",
          },
          status: "current",
          preConfigured: false,
        },
      ],
      resolveFlow() {
        resolved = true;
      },
      escapeHandler() {},
    }),
  );

  harness.hooks.showOAuthWizardModal();

  assert.equal(modal.classList.contains("visible"), true);
  assert.equal(modal.classList.contains("single-server"), true);
  assert.deepEqual(harness.suppressionChanges.slice(0, 2), [
    { layer: "owui", reason: "oauth-wizard", suppressed: true },
    { layer: "native", reason: "oauth-wizard", suppressed: true },
  ]);

  harness.hooks.setState(
    buildWizardState({
      servers: [],
      resolveFlow() {
        resolved = true;
      },
      escapeHandler() {},
    }),
  );

  harness.hooks.closeWizardModal();
  await harness.flush();

  assert.equal(modal.classList.contains("visible"), false);
  assert.equal(modal.classList.contains("single-server"), false);
  assert.equal(resolved, true);
  assert.deepEqual(harness.suppressionChanges.slice(-2), [
    { layer: "owui", reason: "oauth-wizard", suppressed: false },
    { layer: "native", reason: "oauth-wizard", suppressed: false },
  ]);
});

test("runOAuthWizard reuses the existing flow, reveals the modal, and does not reopen the browser", async () => {
  const harness = buildOauthWizardHarness();
  const modal = harness.elements.get("oauth-wizard-modal");

  harness.hooks.setState(
    buildWizardState({
      currentIndex: 0,
      completedServerIds: ["glean"],
      servers: [
        {
          server: { id: "glean" },
          metadata: {
            id: "glean",
            name: "glean",
            display_name: "Glean",
          },
          status: "done",
          preConfigured: false,
        },
        {
          server: { id: "data-plat-mcp" },
          metadata: {
            id: "data-plat-mcp",
            name: "data-plat-mcp",
            display_name: "Data Platform",
          },
          status: "pending",
          preConfigured: false,
        },
      ],
    }),
  );
  harness.hooks.setFlowInProgress(true);

  const result = await harness.hooks.runOAuthWizard([], {
    requestedServerId: "data-plat-mcp",
    flowSource: "backend-requested",
  });

  assert.equal(result.completedCount, 0);
  assert.deepEqual(Array.from(result.completedServerIds), ["glean"]);
  assert.equal(result.skipped, false);
  assert.equal(result.reusedExistingFlow, true);
  assert.equal(modal.classList.contains("visible"), true);
  assert.equal(harness.hooks.getState().currentIndex, 1);
  assert.equal(harness.getOpenExternalCalls(), 0);
  assert.deepEqual(harness.suppressionChanges.slice(-2), [
    { layer: "owui", reason: "oauth-wizard", suppressed: true },
    { layer: "native", reason: "oauth-wizard", suppressed: true },
  ]);
});

test("backend request attaches to an existing same-server manual wizard and completes its waiter", async () => {
  const harness = buildOauthWizardHarness();
  const item = {
    server: { id: "productkit-mcp" },
    metadata: {
      id: "productkit-mcp",
      name: "productkit-mcp",
      display_name: "Product Kit",
    },
    status: "waiting",
    preConfigured: false,
    postAuthSyncState: "idle",
    postAuthToolCount: 0,
    postAuthSyncError: null,
  };
  harness.hooks.setState(
    buildWizardState({
      servers: [item],
      currentIndex: 0,
    }),
  );
  harness.hooks.setFlowInProgress(true);
  harness.window.electronAPI.checkOAuthTokensExist = async () => ({ exists: true });

  const reused = await harness.hooks.runOAuthWizard([item.server], {
    requestedServerId: "productkit-mcp",
    preferredServerId: "productkit-mcp",
    backendManagedServerIds: ["productkit-mcp"],
    flowSource: "backend-requested",
  });

  assert.equal(reused.reusedExistingFlow, true);
  assert.equal(
    harness.hooks.getState().backendManagedServerIds.has("productkit-mcp"),
    true,
  );

  await harness.hooks.handleWizardOAuthVerification("productkit-mcp", item);
  harness.hooks.notifyBackendOAuthCompletionOnce("productkit-mcp");

  assert.deepEqual(harness.getOauthServerDoneCalls(), ["productkit-mcp"]);
  assert.equal(harness.getPostOauthRecoveryCalls(), 0);
  assert.equal(item.postAuthSyncState, "backend_managed");
});

test("closing an attached wizard while tokens persist cannot emit completion after dismissal", async () => {
  const harness = buildOauthWizardHarness();
  let resolveTokenCheck;
  const item = {
    server: { id: "productkit-mcp" },
    metadata: {
      id: "productkit-mcp",
      name: "productkit-mcp",
      display_name: "Product Kit",
    },
    status: "waiting",
    preConfigured: false,
  };
  harness.window.electronAPI.checkOAuthTokensExist = () =>
    new Promise((resolve) => {
      resolveTokenCheck = resolve;
    });
  harness.hooks.setState(
    buildWizardState({
      servers: [item],
      currentIndex: 0,
      requestedServerId: "productkit-mcp",
      dismissibleRequestServerId: "productkit-mcp",
      backendManagedServerIds: new Set(["productkit-mcp"]),
      backendRequestOutcomes: new Map([["productkit-mcp", "pending"]]),
    }),
  );

  const verification = harness.hooks.handleWizardOAuthVerification(
    "productkit-mcp",
    item,
  );
  await Promise.resolve();
  harness.hooks.closeWizardModal();
  resolveTokenCheck({ exists: true });
  await verification;
  await harness.flush();

  assert.deepEqual(harness.getOauthDismissedCalls(), ["productkit-mcp"]);
  assert.deepEqual(harness.getOauthServerDoneCalls(), []);
});

test("oauth wizard seeds Control Plane starting state when prod recovery begins", async () => {
  const harness = buildOauthWizardHarness();

  harness.hooks.setState(
    buildWizardState({
      servers: [
        {
          server: { id: "data-plat-mcp" },
          metadata: {
            id: "data-plat-mcp",
            name: "data-plat-mcp",
            display_name: "Data Platform",
          },
          status: "done",
          preConfigured: false,
        },
      ],
    }),
  );

  const result = await harness.hooks.startWizardProdRecovery("data-plat-mcp");

  assert.deepEqual(harness.getPostSuccessStartingCalls(), [
    {
      serverId: "data-plat-mcp",
      label: "Data Platform",
      stage: "checking",
      detail: "Checking...",
      operationKind: "post_oauth_recovery",
      postAuthRecovery: true,
    },
  ]);
  assert.equal(result.success, true);
  assert.equal(result.state, "ready");
  assert.equal(result.toolCount, 1);
});

test("oauth wizard exposes configuration after dual-requirement auth without starting production recovery", async () => {
  const harness = buildOauthWizardHarness();
  const item = {
    server: {
      id: "dual-server",
      configurationPending: true,
    },
    metadata: {
      id: "dual-server",
      name: "dual-server",
      display_name: "Dual Server",
    },
    status: "current",
    preConfigured: false,
    postAuthSyncState: "idle",
    postAuthToolCount: 0,
    postAuthSyncError: null,
  };

  harness.window.electronAPI.checkOAuthTokensExist = async () => ({
    exists: true,
  });
  harness.hooks.setState(
    buildWizardState({
      servers: [item],
      currentIndex: 0,
    }),
  );

  await harness.hooks.handleWizardOAuthVerification("dual-server", item);

  assert.deepEqual(harness.getOauthAuthenticatedCalls(), [
    {
      serverId: "dual-server",
      configurationPending: true,
    },
  ]);
  assert.deepEqual(harness.getPostSuccessStartingCalls(), []);
  assert.equal(harness.getPostOauthRecoveryCalls(), 0);
  assert.equal(item.status, "done");
  assert.equal(item.postAuthSyncState, "configuration_pending");
  assert.match(
    harness.elements.get("oauth-wizard-testing-content").innerHTML,
    /Complete configuration from the Control Plane to finish setup/,
  );
});

test("fresh wizard OAuth start preserves durable tokens while preparing bootstrap state", async () => {
  const harness = buildOauthWizardHarness();
  const prepareCalls = [];
  const clearCalls = [];

  harness.window.electronAPI.prepareOAuthStart = async (serverId) => {
    prepareCalls.push(serverId);
    return { success: true, cleared: true };
  };
  harness.window.electronAPI.clearOAuthTokens = async (serverId) => {
    clearCalls.push(serverId);
    return { success: true, cleared: true };
  };

  await harness.hooks.prepareWizardForFreshOAuthStart("data-plat-mcp");

  assert.deepEqual(prepareCalls, ["data-plat-mcp"]);
  assert.deepEqual(clearCalls, []);
});

test("wizard restart flows prepare bootstrap state without clearing durable OAuth records", async () => {
  const harness = buildOauthWizardHarness();
  const prepareCalls = [];
  const clearCalls = [];
  const startCalls = [];
  const stopCalls = [];

  harness.window.electronAPI.prepareOAuthStart = async (serverId) => {
    prepareCalls.push(serverId);
    return { success: true, cleared: true };
  };
  harness.window.electronAPI.clearOAuthTokens = async (serverId) => {
    clearCalls.push(serverId);
    return { success: true, cleared: true };
  };
  harness.window.electronAPI.stopSingleMcpServer = async (serverId, options) => {
    stopCalls.push({ serverId, options });
    return { success: true };
  };
  harness.window.electronAPI.startSingleMcpServer = async (serverId, options) => {
    startCalls.push({ serverId, options });
    return { success: true, sessionId: "new-session" };
  };

  await harness.hooks.prepareWizardForFreshOAuthStart("data-plat-mcp");
  await harness.hooks.restartWizardOAuthSession(
    "data-plat-mcp",
    "old-session",
  );

  assert.deepEqual(prepareCalls, ["data-plat-mcp", "data-plat-mcp"]);
  assert.deepEqual(clearCalls, []);
  assert.deepEqual(JSON.parse(JSON.stringify(stopCalls)), [
    {
      serverId: "data-plat-mcp",
      options: { sessionId: "old-session" },
    },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(startCalls)), [
    {
      serverId: "data-plat-mcp",
      options: { oauthMode: "bootstrap" },
    },
  ]);
});

test("wizard restart cleanup stops a replacement session that cannot open the browser", async () => {
  const harness = buildOauthWizardHarness();
  const stopCalls = [];

  harness.window.electronAPI.stopSingleMcpServer = async (serverId, options) => {
    stopCalls.push({ serverId, sessionId: options?.sessionId });
    return { success: true };
  };
  harness.window.electronAPI.startSingleMcpServer = async () => ({
    success: true,
    sessionId: "replacement-session",
  });
  harness.window.electronAPI.openExternal = async () => {
    throw new Error("browser launch failed");
  };

  await assert.rejects(
    harness.hooks.restartWizardOAuthSession(
      "data-plat-mcp",
      "original-session",
    ),
    /browser launch failed/,
  );
  assert.deepEqual(stopCalls, [
    { serverId: "data-plat-mcp", sessionId: "original-session" },
    { serverId: "data-plat-mcp", sessionId: "replacement-session" },
  ]);
});

test("wizard callback polling keeps waiting while the server remains in waiting_callback", async () => {
  const harness = buildOauthWizardHarness();
  let pollCalls = 0;

  harness.window.electronAPI.pollOAuthCompletionSingle = async () => {
    pollCalls += 1;
    if (pollCalls < 3) {
      return { success: false, timeout: true };
    }
    return {
      success: true,
      completed: true,
      server: { server_name: "data-plat-mcp" },
    };
  };
  harness.window.electronAPI.getOAuthStatusSingle = async () => ({
    waiting_callback: [
      {
        server_name: "data-plat-mcp",
        authorization_url: "https://auth.example.test",
      },
    ],
    completed: [],
    failed: [],
  });

  const result = await harness.hooks.pollWizardOAuthCompletionWithManualRestart(
    "data-plat-mcp",
    {
      timeoutMs: 200,
      chunkTimeoutMs: 5,
    },
  );

  assert.equal(result.completed, true);
  assert.equal(pollCalls, 3);
});

test("wizard callback polling keeps waiting while persisted tokens are being validated", async () => {
  const harness = buildOauthWizardHarness();
  let pollCalls = 0;
  const progressStates = [];

  harness.window.electronAPI.pollOAuthCompletionSingle = async () => {
    pollCalls += 1;
    if (pollCalls < 3) {
      return {
        success: false,
        timeout: true,
        checking: true,
        server: { server_name: "product-pal", state: "checking" },
      };
    }
    return {
      success: true,
      completed: true,
      server: { server_name: "product-pal", state: "completed" },
    };
  };

  const result = await harness.hooks.pollWizardOAuthCompletionWithManualRestart(
    "product-pal",
    {
      timeoutMs: 200,
      chunkTimeoutMs: 5,
      onProgress(_elapsedSeconds, progress) {
        progressStates.push(progress?.checking === true);
      },
    },
  );

  assert.equal(result.completed, true);
  assert.equal(pollCalls, 3);
  assert.deepEqual(progressStates, [true, true]);
  assert.equal(harness.getPostOauthRecoveryCalls(), 0);
});

test("wizard callback polling times out only after the overall timeout budget", async () => {
  const harness = buildOauthWizardHarness();
  let pollCalls = 0;

  harness.window.electronAPI.pollOAuthCompletionSingle = async () => {
    pollCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { success: false, timeout: true };
  };

  const result = await harness.hooks.pollWizardOAuthCompletionWithManualRestart(
    "data-plat-mcp",
    {
      timeoutMs: 45,
      chunkTimeoutMs: 10,
    },
  );

  assert.equal(result.completed, undefined);
  assert.equal(result.timeout, true);
  assert.ok(pollCalls >= 2);
});

// Note: H-18 stale-callback fast-fail tests were intentionally removed when
// we reverted the 30s/15-poll auto-fail in the renderer wizard loop. See the
// long-form rationale next to WIZARD_OAUTH_FLOW_TIMEOUT_MS in
// oauth-wizard-modal.js — the wizard now relies on the user-driven
// "Stuck? Retry" button, the modal close (X), the outer 10-min budget, and
// the contractor + data-plat-mcp 4xx auth-URL probe in handleWizardAuthorize.

// --------------------------------------------------------------------------
// H-21 Bug A/D regression coverage: a newer OAuth flow (or the modal close)
// must abort the prior poll loop so its elapsed-second counter does not
// leak into the next flow's DOM updates.
// --------------------------------------------------------------------------
test("wizard poll loop exits with aborted=true when its signal is aborted", async () => {
  const harness = buildOauthWizardHarness();
  const controller = new AbortController();
  let pollCalls = 0;

  harness.window.electronAPI.pollOAuthCompletionSingle = async () => {
    pollCalls += 1;
    // Fire the abort *during* the very first poll so we exit on the next
    // top-of-loop check instead of returning the poll result.
    controller.abort();
    return { success: false, timeout: true };
  };

  const result = await harness.hooks.pollWizardOAuthCompletionWithManualRestart(
    "data-plat-mcp",
    {
      timeoutMs: 5000,
      chunkTimeoutMs: 5,
      signal: controller.signal,
    },
  );

  // Cross-realm: result was constructed inside the VM context; compare fields.
  assert.equal(result.aborted, true);
  assert.equal(result.completed, undefined);
  assert.equal(result.failed, undefined);
  // We exited as soon as the signal flipped — at most one extra poll, never
  // a runaway loop accumulating elapsedSeconds counters into the DOM.
  assert.ok(pollCalls <= 2, `expected <= 2 polls before abort, got ${pollCalls}`);
});

test("wizard poll loop returns aborted=true immediately when signal already aborted", async () => {
  const harness = buildOauthWizardHarness();
  const controller = new AbortController();
  controller.abort();
  let pollCalls = 0;

  harness.window.electronAPI.pollOAuthCompletionSingle = async () => {
    pollCalls += 1;
    return { success: false, timeout: true };
  };

  const result = await harness.hooks.pollWizardOAuthCompletionWithManualRestart(
    "data-plat-mcp",
    {
      timeoutMs: 5000,
      chunkTimeoutMs: 5,
      signal: controller.signal,
    },
  );

  assert.equal(result.aborted, true);
  assert.equal(pollCalls, 0, "no IPC poll should fire when signal is pre-aborted");
});

// --------------------------------------------------------------------------
// H-21 Bug B regression coverage: container logs (and any error string) sent
// to the wizard's error card must have IdP authorization URLs stripped, so
// users don't see raw code_challenge / state / scope query params.
// --------------------------------------------------------------------------
test("redactWizardOAuthAuthUrls strips bare authorization_url=...", () => {
  const harness = buildOauthWizardHarness();
  const input =
    "[OAuth:MCPO] [google_workspace] OAuth authorization URL generated " +
    "authorization_url=https://accounts.google.com/o/oauth2/v2/auth?" +
    "response_type=code&client_id=621624.apps.googleusercontent.com&" +
    "state=YE5CMkc&code_challenge=RX8C5&code_challenge_method=S256&" +
    "scope=openid+email&resource=http%3A%2F%2F127.0.0.1%3A8080%2Fmcp\n" +
    "next log line stays intact";

  const out = harness.hooks.redactWizardOAuthAuthUrls(input);

  assert.match(out, /authorization_url=<redacted>/);
  assert.doesNotMatch(out, /accounts\.google\.com/);
  assert.doesNotMatch(out, /code_challenge/);
  assert.doesNotMatch(out, /client_id=/);
  assert.match(out, /next log line stays intact/);
});

test("redactWizardOAuthAuthUrls strips JSON-style \"authorization_url\": \"...\"", () => {
  const harness = buildOauthWizardHarness();
  const input = `{"authorization_url": "https://idp.example.com/auth?state=abc&code_challenge=xyz"}`;

  const out = harness.hooks.redactWizardOAuthAuthUrls(input);

  assert.match(out, /"authorization_url"\s*:\s*"<redacted>"/);
  assert.doesNotMatch(out, /idp\.example\.com/);
});

test("redactWizardOAuthAuthUrls is a no-op for empty / non-string input", () => {
  const harness = buildOauthWizardHarness();
  assert.equal(harness.hooks.redactWizardOAuthAuthUrls(""), "");
  assert.equal(harness.hooks.redactWizardOAuthAuthUrls(null), null);
  assert.equal(harness.hooks.redactWizardOAuthAuthUrls(undefined), undefined);
});
