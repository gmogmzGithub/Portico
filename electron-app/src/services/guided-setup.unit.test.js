const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { FakeElement } = require("./test-helpers/fake-dom");

const repoRoot = path.resolve(__dirname, "../../..");
const srcRoot = path.join(repoRoot, "electron-app", "src");
const guidedSetupPath = path.join(
  srcRoot,
  "renderer",
  "views",
  "guided-setup.js",
);

function createStyledElement(id = "") {
  const element = new FakeElement(id);
  element.style.setProperty = function setProperty(name, value) {
    this[name] = value;
  };
  element.style.removeProperty = function removeProperty(name) {
    delete this[name];
  };
  return element;
}

async function withNoopTimeout(run) {
  const previousSetTimeout = global.setTimeout;
  global.setTimeout = () => {
    return 1;
  };

  try {
    return await run();
  } finally {
    global.setTimeout = previousSetTimeout;
  }
}

async function withImmediateTimeout(run) {
  const previousSetTimeout = global.setTimeout;
  global.setTimeout = (handler) => {
    if (typeof handler === "function") {
      handler();
    }
    return 1;
  };

  try {
    return await run();
  } finally {
    global.setTimeout = previousSetTimeout;
  }
}

async function flushMicrotasks(count = 4) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return { promise, resolve, reject };
}

async function withCapturedConsoleLog(run) {
  const previousConsoleLog = console.log;
  const calls = [];
  console.log = (...args) => {
    calls.push(args);
  };

  try {
    return await run(calls);
  } finally {
    console.log = previousConsoleLog;
  }
}

async function withCapturedConsoleError(run) {
  const previousConsoleError = console.error;
  const calls = [];
  console.error = (...args) => {
    calls.push(args);
  };

  try {
    return await run(calls);
  } finally {
    console.error = previousConsoleError;
  }
}

function withGuidedSetupHarness(run, overrides = {}) {
  const restoreCache = new Map();

  function primeModule(relativePath, exports) {
    const absolutePath = path.join(srcRoot, relativePath);
    restoreCache.set(absolutePath, require.cache[absolutePath]);
    require.cache[absolutePath] = {
      id: absolutePath,
      filename: absolutePath,
      loaded: true,
      exports,
    };
  }

  const setupState = {
    currentStage: "welcome",
    onboardingMode: "power",
    savedOnboardingMode: null,
    browserVisible: false,
    hostModeSupported: true,
    selectedServers: [],
    serverSelectionHydrated: false,
    mcpToggleState: {
      baseline: { loaded: false, exists: false, toggles: {} },
      changes: {},
      writeMode: "preserve",
    },
    mcpServers: [
      { id: "legacy-selected", name: "Legacy Selected" },
    ],
    serverConfigs: [{ id: "slack" }, { id: "sourcegraph" }, { id: "gitlab" }],
    currentServerIndex: 0,
    currentOAuthIndex: 0,
    envVars: {},
    configuredServers: new Set(),
    skippedServers: new Set(),
    guidedSetupDisabledServerIds: new Set(),
    guidedSetupDisabledTooltips: {},
    completedOAuthServers: new Set(),
    connectedOAuthServers: new Set(),
    skippedOAuthServers: new Set(),
    completedSteps: {
      prerequisites: false,
      prerequisitesWarning: false,
      serverSelection: false,
      oauth: false,
      servers: {},
    },
    prereqPolicy: { showStep: true, noInteractiveWorkRequired: false },
    isDevBuild: true,
    oauthStepRequired: true,
    oauthServers: [],
    mcpServersHealth: null,
    launchContext: { source: "manual" },
  };

  const elements = new Map();
  [
    "stage-welcome",
    "stage-hello",
    "stage-prerequisites",
    "stage-vpn-check",
    "stage-server-selection",
    "stage-oauth",
    "stage-configuration",
    "stage-finalize",
    "stage-success",
    "welcome-auth-state",
    "welcome-auth-message",
    "welcome-error",
    "welcome-start-button",
    "hello-basic-option",
    "hello-power-option",
    "hello-mode-error",
    "hello-title",
    "hello-basic-logo-strip",
    "progress-tracker-wrapper",
    "progress-label-hello",
    "theme-toggle",
    "server-selection-loading-shell",
    "server-selection-ready-content",
    "oauth-stage-loading-shell",
    "oauth-stage-ready-content",
    "configuration-stage-loading-shell",
    "configuration-stage-ready-content",
    "guided-setup-debug-toggle",
    "guided-setup-debug-scrim",
    "guided-setup-debug-drawer",
    "guided-setup-debug-close",
    "guided-setup-debug-copy-btn",
    "guided-setup-debug-collect-btn",
    "guided-setup-debug-test-panel",
    "guided-setup-debug-clear-error-state",
    "guided-setup-debug-force-error-generic",
    "guided-setup-debug-force-error-homebrew-auth-dialog-cancelled",
    "guided-setup-debug-force-error-homebrew-sudo-validation-failed",
    "guided-setup-debug-force-error-homebrew-admin-required",
    "guided-setup-debug-force-error-homebrew-osascript-probe-failed",
    "guided-setup-debug-force-error-homebrew-outdated",
    "guided-setup-debug-force-error-orbstack-stale-artifact-conflict",
    "guided-setup-debug-force-error-orbstack-cask-xattr-conflict",
    "guided-setup-debug-force-error-orbstack-manual-recovery-required",
    "guided-setup-debug-force-error-docker-pull-recovery-required",
    "guided-setup-debug-status",
    "guided-setup-debug-body",
    "guided-setup-debug-overlay",
  ].forEach((id) => {
    elements.set(id, createStyledElement(id));
  });

  const stageElements = [
    "stage-welcome",
    "stage-hello",
    "stage-prerequisites",
    "stage-vpn-check",
    "stage-server-selection",
    "stage-oauth",
    "stage-configuration",
    "stage-finalize",
    "stage-success",
  ].map((id) => {
    const stage = elements.get(id);
    stage.classList.add("setup-stage");
    return stage;
  });

  const setupPanel = createStyledElement("setup-panel");
  setupPanel.scrollTop = 123;
  const scrollArea = createStyledElement("content-scroll-area");
  const documentListeners = new Map();

  const previousDocument = global.document;
  const previousWindow = global.window;
  const previousMutationObserver = global.MutationObserver;

  const electronApi = {
    maximizeCalls: [],
    getProjectRootCalls: 0,
    bootstrapStateCalls: 0,
    saveModePreferenceCalls: [],
    setupAuthClearCalls: 0,
    setupAuthStartCalls: 0,
    vpnCheckCalls: 0,
    hostModeCheckCalls: 0,
    backgroundPrefetchCalls: 0,
    clipboardCopies: [],
    savedControlPaneLogs: [],
    collectDebugInfoCalls: 0,
    currentUserGetCalls: 0,
    getBuildInfoCalls: 0,
    async loadMcpServers() {
      return {
        success: true,
        data: [
          {
            id: "slack",
            name: "Slack MCP Server",
            requiredVars: [{ name: "SLACK_TOKEN" }],
            useCases: ["chat"],
            description: "Slack integration",
            guidedSetupDescription: "Chat with Slack",
          },
          {
            id: "sourcegraph",
            name: "Sourcegraph MCP Server",
            description: "Search source code.",
            oauth: { requires_user_authorization: true },
            logo_kind: "portico",
          },
        ],
      };
    },
    async loadMcpToggles() {
      return {
        success: true,
        data: { sourcegraph: true },
      };
    },
    async loadGuidedSetupMcpToggles() {
      return {
        success: true,
        data: { sourcegraph: true },
      };
    },
    async getLastHealthStatus() {
      return {
        servers: { sourcegraph: { enabled: true } },
      };
    },
    async getProjectRoot() {
      this.getProjectRootCalls += 1;
      return "/tmp/project";
    },
    async getGuidedSetupBootstrapState() {
      this.bootstrapStateCalls += 1;
      return {};
    },
    async getBuildInfo() {
      this.getBuildInfoCalls += 1;
      if (typeof overrides.getBuildInfoImpl === "function") {
        return overrides.getBuildInfoImpl();
      }
      return { buildNumber: overrides.buildNumber || "dev-build" };
    },
    async saveGuidedSetupModePreference(mode) {
      this.saveModePreferenceCalls.push(mode);
      return { success: true };
    },
    async checkVpnConnectivity() {
      this.vpnCheckCalls += 1;
      return { success: true };
    },
    async checkHostMode() {
      this.hostModeCheckCalls += 1;
      return { supported: true };
    },
    async prerequisitesStartBackgroundPrefetch() {
      this.backgroundPrefetchCalls += 1;
    },
    async getGuidedSetupDebugSections() {
      return { success: true, sections: [] };
    },
    async getSingleMcpServerLogs() {
      return { logs: "" };
    },
    async getWizardMcpServerLogs() {
      return { logs: "" };
    },
    async copyToClipboard(value) {
      this.clipboardCopies.push(value);
    },
    async saveControlPaneLogs(value) {
      this.savedControlPaneLogs.push(value);
    },
    async collectDebugInfo() {
      this.collectDebugInfoCalls += 1;
      return { success: true, zipFile: "/tmp/debug-info.zip" };
    },
    currentUser: {
      get: async () => {
        electronApi.currentUserGetCalls += 1;
        return {
          success: true,
          authenticated: true,
          sessionSummary: {
            user: {
              id: "user-123",
              name: "Sam Rivera",
              email: "sam.rivera@example.invalid",
            },
          },
        };
      },
    },
    setupAuth: {
      clearError: async () => {
        electronApi.setupAuthClearCalls += 1;
      },
      start: async () => {
        electronApi.setupAuthStartCalls += 1;
        return {
          success: true,
          authenticated: true,
          sessionSummary: {
            user: {
              id: "user-123",
              name: "Sam Rivera",
              email: "sam.rivera@example.invalid",
            },
          },
        };
      },
    },
    maximizeElectronApp(options) {
      this.maximizeCalls.push(options);
    },
  };

  global.window = {
    electronAPI: electronApi,
  };
  global.document = {
    body: createStyledElement("body"),
    addEventListener(type, handler) {
      if (!documentListeners.has(type)) {
        documentListeners.set(type, []);
      }
      documentListeners.get(type).push(handler);
    },
    getElementById(id) {
      return elements.get(id) || null;
    },
    querySelectorAll(selector) {
      if (selector === ".setup-stage") {
        return stageElements;
      }
      if (selector === ".input-field") {
        return [];
      }
      if (selector === "[data-tooltip-follow=\"pointer\"]") {
        return [];
      }
      return [];
    },
    querySelector(selector) {
      if (selector === ".setup-panel") {
        return setupPanel;
      }
      if (selector === ".content-scroll-area") {
        return scrollArea;
      }
      return null;
    },
    createElement() {
      return createStyledElement();
    },
  };
  global.window.document = global.document;
  globalThis.window = global.window;
  globalThis.document = global.document;
  global.MutationObserver = class MutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.observeCalls = [];
    }

    observe(target, options) {
      this.observeCalls.push({ target, options });
    }

    disconnect() {}
  };

  const progressCalls = [];
  const progressVisibilityCalls = [];
  const populateCalls = [];
  const updateSelectAllButtonCalls = [];
  const hideBrowserCalls = [];
  const loadConfigurationCalls = [];
  const pendingIndexCalls = [];
  const loadPrerequisitesCalls = [];
  const simulatedPrereqErrorCalls = [];
  const clearedSimulatedPrereqErrorCalls = [];
  const bootstrapPrereqCalls = [];
  const loadOauthCalls = [];
  const loadVpnCalls = [];
  const proceedToConfigurationCalls = [];
  const envInitCalls = [];
  const loadExistingEnvVarCalls = [];
  const saveEnvVarCalls = [];
  const setupWebviewCalls = [];
  const setupResizeHandleCalls = [];
  const setupClipboardShortcutCalls = [];
  const createWindowHandlersCalls = [];

  const parserStub = (...args) => ({ args });
  const generateConfirmationCard = (...args) => ({ confirmationCardArgs: args });
  const copyToClipboard = (...args) => ({ copyArgs: args });

  primeModule("services/guided-setup/setup-state.js", {
    setupState,
    getSetupState: () => setupState,
    setCurrentStage(stageName) {
      setupState.currentStage = stageName;
    },
    setEnvVar(key, value) {
      setupState.envVars[key] = value;
    },
    addConfiguredServer(serverId) {
      setupState.configuredServers.add(serverId);
    },
    addSkippedServer(serverId) {
      setupState.skippedServers.add(serverId);
    },
    setOnboardingMode(mode) {
      setupState.onboardingMode = mode;
    },
  });
  primeModule("services/guided-setup/server-selection-state.js", {
    getHydratedGuidedSetupSelectionIndices(options = {}) {
      const {
        servers = [],
        selectedIndices = [],
        toggles = {},
        hostModeSupported = true,
        guidedSetupDisabledServerIds = [],
      } = options;
      const selectedIds = new Set(
        selectedIndices.map((index) => servers[index]?.id).filter(Boolean),
      );
      const disabledIds = guidedSetupDisabledServerIds instanceof Set
        ? guidedSetupDisabledServerIds
        : new Set(guidedSetupDisabledServerIds || []);

      servers.forEach((server) => {
        if (!server?.id || toggles?.[server.id] !== true) {
          return;
        }
        if (server.isCore === true || server.userInstalled === true || disabledIds.has(server.id)) {
          return;
        }
        if ((server.deploymentType || server.deployment_type) === "host" && hostModeSupported === false) {
          return;
        }
        selectedIds.add(server.id);
      });

      return servers
        .map((server, index) => (selectedIds.has(server?.id) ? index : null))
        .filter((index) => index !== null);
    },
    getSelectedServerIdsFromIndices(servers, indices) {
      return indices.map((index) => servers[index]?.id).filter(Boolean);
    },
    getSelectedServerIndicesFromIds(servers, ids) {
      return servers
        .map((server, index) => ({ server, index }))
        .filter(({ server }) => ids.includes(server.id))
        .map(({ index }) => index);
    },
    isGuidedSetupSelectableServer(server, options = {}) {
      if (!server?.id || server.isCore === true || server.userInstalled === true) {
        return false;
      }
      if ((server.deploymentType || server.deployment_type) === "host" && options.hostModeSupported === false) {
        return false;
      }

      const disabledIds = options.guidedSetupDisabledServerIds instanceof Set
        ? options.guidedSetupDisabledServerIds
        : new Set(options.guidedSetupDisabledServerIds || []);
      return !disabledIds.has(server.id);
    },
    setGuidedSetupToggleBaseline(state, toggles, options = {}) {
      state.mcpToggleState = {
        baseline: {
          loaded: true,
          exists: options.exists === true,
          toggles: { ...toggles },
        },
        changes: {},
        writeMode: "preserve",
      };
    },
    recordGuidedSetupToggleChange(state, serverId, enabled) {
      const baseline = state.mcpToggleState?.baseline?.toggles || {};
      if (baseline[serverId] === enabled) {
        delete state.mcpToggleState.changes[serverId];
      } else {
        state.mcpToggleState.changes[serverId] = enabled;
      }
      state.mcpToggleState.writeMode =
        Object.keys(state.mcpToggleState.changes).length > 0
          ? "apply"
          : "preserve";
    },
    preserveGuidedSetupToggleState(state) {
      state.mcpToggleState.changes = {};
      state.mcpToggleState.writeMode = "preserve";
    },
  });
  // guided-setup-stage-window.js is deliberately NOT primed. It is a pure,
  // dependency-free lookup table, so stubbing it bought no isolation and only
  // created drift: the stub kept returning null for 'hello' long after that
  // became the wrong answer, which is how the stacked-cards regression shipped
  // green. Exercise the real table instead.
  primeModule("services/guided-setup/setup-env-manager.js", {
    init(projectRoot) {
      envInitCalls.push(projectRoot);
    },
    async loadExistingEnvVars() {
      loadExistingEnvVarCalls.push(true);
      return { EXISTING_TOKEN: "from-env" };
    },
    async saveEnvVarImmediately(key, value) {
      saveEnvVarCalls.push([key, value]);
    },
    isServerConfigured() {
      return false;
    },
    isPlaceholderValue() {
      return false;
    },
  });
  primeModule("services/guided-setup/setup-markdown-parser.js", {
    parseMarkdownContent: parserStub,
    substituteVariables(value) {
      return value;
    },
  });
  primeModule("utils/setup-validation.js", {
    validateEnvValue() {
      return true;
    },
    validateInputField() {
      return { valid: true };
    },
    validateAllInputs() {
      return { valid: true };
    },
  });
  primeModule("renderer/components/setup-progress.js", {
    updateProgressTracker(...args) {
      progressCalls.push(args);
    },
    isStepAccessible() {
      return true;
    },
    toggleProgressVisibility(...args) {
      progressVisibilityCalls.push(args);
    },
  });
  primeModule("renderer/components/setup-server-card.js", {
    createServerCard(server) {
      return { server };
    },
    selectServerCard() {},
    deselectServerCard() {},
    addConfiguredCheckmark() {},
    createHostWarning() {
      return createStyledElement("host-warning-message");
    },
  });
  primeModule("renderer/components/setup-server-nav.js", {
    createServerNavigation() {},
    updateServerNavigation() {},
    showServerNavContainer() {},
    hideServerNavContainer() {},
  });
  primeModule("renderer/components/setup-browser.js", {
    showBrowser() {},
    hideBrowser(state) {
      hideBrowserCalls.push(state.currentStage);
      state.browserVisible = false;
    },
    loadBrowserUrl() {},
    openExternalUrl() {},
    setupWebview() {
      setupWebviewCalls.push(true);
    },
    setupResizeHandle() {
      setupResizeHandleCalls.push(true);
    },
  });
  primeModule("renderer/components/setup-accordion.js", {
    createInitialAccordions() {},
    markAccordionsAsCompleted() {},
    createAccordionSection() {},
    toggleAccordion() {
      return false;
    },
    createAccordionsForVisibleContent() {},
  });
  primeModule("renderer/components/setup-confirmation.js", {
    generateConfirmationCard,
    handleConfirmationYes() {},
    handleConfirmationNo() {},
    createWindowHandlers(options) {
      createWindowHandlersCalls.push(options);
      return {};
    },
  });
  primeModule("renderer/components/setup-copy.js", {
    copyToClipboard,
    setupClipboardShortcuts() {
      setupClipboardShortcutCalls.push(true);
    },
  });
  primeModule("renderer/components/log-viewer-modal.js", {});
  primeModule("renderer/screens/guided-setup/screen-server-selection.js", {
    populateServerGrid(...args) {
      populateCalls.push(args);
    },
    toggleServerSelection() {},
    updateProceedButton() {},
    updateSelectAllButtons(...args) {
      updateSelectAllButtonCalls.push(args);
    },
    selectAllServers() {},
    selectAllUnconfigured() {},
    selectAllConfigured() {},
    skipServerSelection() {},
    async proceedToConfiguration(...args) {
      proceedToConfigurationCalls.push(args);
    },
    selectAllOAuth() {},
    selectAllConfig() {},
    selectAllReady() {},
  });
  primeModule("renderer/screens/guided-setup/screen-configuration.js", {
    async loadServerConfiguration(...args) {
      const [index] = args;
      loadConfigurationCalls.push(index);
      if (typeof overrides.loadServerConfigurationImpl === "function") {
        return overrides.loadServerConfigurationImpl(...args);
      }
    },
    parseSetupMarkdown() {},
    generateConfigForm() {},
    saveAndContinue() {},
    skipServer() {},
    skipAllServers() {},
    previousServer() {},
    jumpToServer() {},
    handleSaveAndContinue() {},
    handleSkipServer() {},
    handleSkipAllServers() {},
    refreshConfigurationGuidance() {},
    handleConfigurationAccordionToggle() {},
    getNextPendingConfigurationIndex(state, startIndex) {
      pendingIndexCalls.push([state, startIndex]);
      return 2;
    },
  });
  primeModule("renderer/screens/guided-setup/screen-finalize.js", {
    finalizeSetup() {},
    generateEnvFile() {},
    generateMcpConfig() {},
  });
  primeModule("renderer/screens/guided-setup/screen-success.js", {
    launchApp() {},
  });
  primeModule("renderer/screens/guided-setup/screen-oauth.js", {
    analyzeOAuthServers(...args) {
      if (typeof overrides.analyzeOAuthServersImpl === "function") {
        return overrides.analyzeOAuthServersImpl(...args);
      }
      return { pendingCount: 0 };
    },
    async loadOAuthScreen(...args) {
      loadOauthCalls.push(args);
      if (typeof overrides.loadOAuthScreenImpl === "function") {
        return overrides.loadOAuthScreenImpl(...args);
      }
    },
    async proceedAfterOAuth() {},
  });
  primeModule("renderer/screens/guided-setup/screen-prerequisites.js", {
    async loadPrerequisitesScreen(...args) {
      loadPrerequisitesCalls.push(args);
    },
    async bootstrapPrerequisitesSession(options) {
      bootstrapPrereqCalls.push(options);
    },
    cleanupListeners() {},
    retryPrerequisites() {},
    getPrereqDebugSections() {
      return [];
    },
    simulatePrerequisitesErrorState(errorState) {
      simulatedPrereqErrorCalls.push(errorState);
      return { success: true, errorState };
    },
    clearSimulatedPrerequisitesErrorState() {
      clearedSimulatedPrereqErrorCalls.push(true);
      return { success: true };
    },
  });
  primeModule("renderer/screens/guided-setup/screen-vpn-check.js", {
    async loadVpnCheckScreen(...args) {
      loadVpnCalls.push(args);
    },
    async runVpnCheck() {},
  });

  delete require.cache[guidedSetupPath];
  const loaded = require(guidedSetupPath);

  let result;
  try {
    result = run({
      loaded,
      setupState,
      elements,
      documentListeners,
      setupPanel,
      electronApi,
      progressCalls,
      progressVisibilityCalls,
      populateCalls,
      updateSelectAllButtonCalls,
      hideBrowserCalls,
      loadConfigurationCalls,
      pendingIndexCalls,
      loadPrerequisitesCalls,
      simulatedPrereqErrorCalls,
      clearedSimulatedPrereqErrorCalls,
      bootstrapPrereqCalls,
      loadOauthCalls,
      loadVpnCalls,
      proceedToConfigurationCalls,
      envInitCalls,
      loadExistingEnvVarCalls,
      saveEnvVarCalls,
      setupWebviewCalls,
      setupResizeHandleCalls,
      setupClipboardShortcutCalls,
      createWindowHandlersCalls,
      parserStub,
      generateConfirmationCard,
      copyToClipboard,
    });
  } finally {
    if (!result || typeof result.then !== "function") {
      delete require.cache[guidedSetupPath];
      for (const [absolutePath, previousValue] of restoreCache.entries()) {
        if (previousValue) {
          require.cache[absolutePath] = previousValue;
        } else {
          delete require.cache[absolutePath];
        }
      }
      global.document = previousDocument;
      global.window = previousWindow;
      globalThis.document = previousDocument;
      globalThis.window = previousWindow;
      global.MutationObserver = previousMutationObserver;
    }
  }

  if (!result || typeof result.then !== "function") {
    return result;
  }

  return result.finally(() => {
    delete require.cache[guidedSetupPath];
    for (const [absolutePath, previousValue] of restoreCache.entries()) {
      if (previousValue) {
        require.cache[absolutePath] = previousValue;
      } else {
        delete require.cache[absolutePath];
      }
    }
    global.document = previousDocument;
    global.window = previousWindow;
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    global.MutationObserver = previousMutationObserver;
  });
}

test("showStage enters server selection, reloads configs, hydrates default selections, and refreshes the shell UI", async () => {
  await withGuidedSetupHarness(async ({
    loaded,
    setupState,
    elements,
    electronApi,
    progressCalls,
    progressVisibilityCalls,
    populateCalls,
    hideBrowserCalls,
  }) => {
    setupState.onboardingMode = "power";
    setupState.serverSelectionHydrated = false;
    let rawToggleLoads = 0;
    electronApi.loadGuidedSetupMcpToggles = async () => {
      rawToggleLoads += 1;
      return {
        success: true,
        data: { sourcegraph: true },
      };
    };
    electronApi.loadMcpToggles = async () => {
      throw new Error("guided setup should use raw MCP toggles");
    };

    await withNoopTimeout(async () => {
      await loaded.showStage("server-selection");
    });

    assert.equal(elements.get("stage-server-selection").classList.contains("active"), true);
    assert.equal(setupState.currentStage, "server-selection");
    assert.equal(setupState.serverSelectionHydrated, true);
    assert.equal(setupState.mcpServers.length, 2);
    assert.deepEqual(setupState.mcpServers[0].required_env_vars, [{ name: "SLACK_TOKEN" }]);
    assert.deepEqual(setupState.mcpServers[0].use_cases, ["chat"]);
    assert.equal(setupState.mcpServers[1].logoKind, "portico");
    assert.equal(setupState.mcpServers[1].guidedSetupDescription, "Search source code.");
    assert.deepEqual(electronApi.maximizeCalls, [{ targetHeight: 880 }]);
    assert.equal(populateCalls.length, 1);
    assert.equal(rawToggleLoads, 1);
    assert.deepEqual(setupState.selectedServers, [1]);
    assert.deepEqual(hideBrowserCalls, ["server-selection"]);
    assert.equal(progressVisibilityCalls[0][0], "server-selection");
    assert.equal(progressCalls[0][0], "server-selection");
    assert.equal(elements.get("stage-server-selection").classList.contains("is-loading"), false);
    assert.equal(elements.get("server-selection-loading-shell").getAttribute("aria-hidden"), "true");
    assert.equal(elements.get("server-selection-ready-content").getAttribute("aria-hidden"), "false");
  });
});

test("showStage keeps server selection in a loading shell until configs and hydrated selections are ready", async () => {
  await withGuidedSetupHarness(async ({
    loaded,
    setupState,
    elements,
    electronApi,
    progressCalls,
    progressVisibilityCalls,
    populateCalls,
    updateSelectAllButtonCalls,
  }) => {
    const serverLoad = createDeferred();
    setupState.onboardingMode = "power";
    setupState.serverSelectionHydrated = false;
    electronApi.loadMcpServers = async () => serverLoad.promise;

    await withNoopTimeout(async () => {
      const stagePromise = loaded.showStage("server-selection");
      await flushMicrotasks();

      assert.equal(elements.get("stage-server-selection").classList.contains("active"), true);
      assert.equal(elements.get("stage-server-selection").classList.contains("is-loading"), true);
      assert.equal(elements.get("server-selection-loading-shell").getAttribute("aria-hidden"), "false");
      assert.equal(elements.get("server-selection-ready-content").getAttribute("aria-hidden"), "true");
      assert.equal(elements.get("progress-tracker-wrapper").style.display, "none");
      assert.equal(progressVisibilityCalls.length, 0);
      assert.equal(progressCalls.length, 0);
      assert.equal(populateCalls.length, 0);

      serverLoad.resolve({
        success: true,
        data: [
          { id: "slack", name: "Slack MCP Server", requiredVars: [{ name: "SLACK_TOKEN" }] },
          { id: "sourcegraph", name: "Sourcegraph MCP Server", oauth: { requires_user_authorization: true } },
        ],
      });
      await stagePromise;

      assert.equal(elements.get("stage-server-selection").classList.contains("is-loading"), false);
      assert.equal(elements.get("server-selection-loading-shell").getAttribute("aria-hidden"), "true");
      assert.equal(elements.get("server-selection-ready-content").getAttribute("aria-hidden"), "false");
      assert.equal(populateCalls.length, 1);
      assert.equal(updateSelectAllButtonCalls.length, 1);
      assert.equal(progressVisibilityCalls.length, 1);
      assert.equal(progressVisibilityCalls[0][0], "server-selection");
      assert.equal(progressCalls.length, 1);
      assert.equal(progressCalls[0][0], "server-selection");
      assert.deepEqual(electronApi.maximizeCalls, [{ targetHeight: 880 }]);
    });
  });
});

test("showStage keeps oauth in a loading shell until the connect screen is ready", async () => {
  const oauthLoad = createDeferred();

  await withGuidedSetupHarness(async ({
    loaded,
    elements,
    electronApi,
    progressCalls,
    progressVisibilityCalls,
    loadOauthCalls,
    hideBrowserCalls,
  }) => {
    await withNoopTimeout(async () => {
      const stagePromise = loaded.showStage("oauth");
      await flushMicrotasks();

      assert.equal(elements.get("stage-oauth").classList.contains("active"), true);
      assert.equal(elements.get("stage-oauth").classList.contains("is-loading"), true);
      assert.equal(elements.get("oauth-stage-loading-shell").getAttribute("aria-hidden"), "false");
      assert.equal(elements.get("oauth-stage-ready-content").getAttribute("aria-hidden"), "true");
      assert.equal(elements.get("progress-tracker-wrapper").style.display, "none");
      assert.equal(loadOauthCalls.length, 1);
      assert.equal(progressVisibilityCalls.length, 0);
      assert.equal(progressCalls.length, 0);

      oauthLoad.resolve();
      await stagePromise;

      assert.equal(elements.get("stage-oauth").classList.contains("is-loading"), false);
      assert.equal(elements.get("oauth-stage-loading-shell").getAttribute("aria-hidden"), "true");
      assert.equal(elements.get("oauth-stage-ready-content").getAttribute("aria-hidden"), "false");
      assert.deepEqual(electronApi.maximizeCalls, [{ targetHeight: 860 }]);
      assert.equal(progressVisibilityCalls.length, 1);
      assert.equal(progressVisibilityCalls[0][0], "oauth");
      assert.equal(progressCalls.length, 1);
      assert.equal(progressCalls[0][0], "oauth");
      assert.deepEqual(hideBrowserCalls, ["oauth"]);
    });
  }, {
    loadOAuthScreenImpl() {
      return oauthLoad.promise;
    },
  });
});

test("navigateToStep keeps configuration in a loading shell until the server UI is ready", async () => {
  const configLoad = createDeferred();

  await withGuidedSetupHarness(async ({
    loaded,
    setupState,
    elements,
    progressCalls,
    progressVisibilityCalls,
    loadConfigurationCalls,
    electronApi,
  }) => {
    setupState.currentStage = "oauth";
    setupState.onboardingMode = "power";
    setupState.completedSteps.oauth = true;
    setupState.currentServerIndex = 0;

    await withNoopTimeout(async () => {
      loaded.navigateToStep("configuration");
      await flushMicrotasks();

      assert.deepEqual(loadConfigurationCalls, [0]);
      assert.equal(elements.get("stage-configuration").classList.contains("active"), true);
      assert.equal(elements.get("stage-configuration").classList.contains("is-loading"), true);
      assert.equal(
        elements.get("configuration-stage-loading-shell").getAttribute("aria-hidden"),
        "false",
      );
      assert.equal(
        elements.get("configuration-stage-ready-content").getAttribute("aria-hidden"),
        "true",
      );
      assert.equal(elements.get("progress-tracker-wrapper").style.display, "none");
      assert.equal(progressVisibilityCalls.length, 1);
      assert.equal(progressVisibilityCalls[0][0], "configuration");
      assert.equal(progressCalls.length, 1);
      assert.equal(progressCalls[0][0], "configuration");
      assert.deepEqual(electronApi.maximizeCalls, [{ targetHeight: 1080 }]);

      configLoad.resolve();
      await flushMicrotasks();

      assert.equal(elements.get("stage-configuration").classList.contains("is-loading"), false);
      assert.equal(
        elements.get("configuration-stage-loading-shell").getAttribute("aria-hidden"),
        "true",
      );
      assert.equal(
        elements.get("configuration-stage-ready-content").getAttribute("aria-hidden"),
        "false",
      );
    });
  }, {
    async loadServerConfigurationImpl(index, _state, callbacks) {
      await callbacks.showStage("configuration", { initialLoading: true });
      await configLoad.promise;
      callbacks.setConfigurationLoadingState?.(false);
    },
  });
});

test("showStage skips the prerequisites screen entirely when the current policy says it is hidden", async () => {
  await withGuidedSetupHarness(async ({
    loaded,
    setupState,
    elements,
    populateCalls,
    loadPrerequisitesCalls,
  }) => {
    setupState.prereqPolicy = { showStep: false, noInteractiveWorkRequired: false };
    setupState.serverSelectionHydrated = true;

    await withNoopTimeout(async () => {
      await loaded.showStage("prerequisites");
    });

    assert.equal(setupState.completedSteps.prerequisites, true);
    assert.equal(setupState.completedSteps.prerequisitesWarning, false);
    assert.equal(loadPrerequisitesCalls.length, 0);
    assert.equal(populateCalls.length, 1);
    assert.equal(elements.get("stage-server-selection").classList.contains("active"), true);
  });
});

test("showStage applies the taller Configure window height when entering configuration", async () => {
  await withGuidedSetupHarness(async ({
    loaded,
    setupState,
    elements,
    electronApi,
  }) => {
    setupState.onboardingMode = "power";

    await withNoopTimeout(async () => {
      await loaded.showStage("configuration");
    });

    assert.equal(elements.get("stage-configuration").classList.contains("active"), true);
    assert.equal(setupState.currentStage, "configuration");
    assert.deepEqual(electronApi.maximizeCalls, [{ targetHeight: 1080 }]);
  });
});

test("guided setup logs stage-driven window resize requests with the effective target size", async () => {
  await withGuidedSetupHarness(async ({ loaded }) => {
    await withCapturedConsoleLog(async (consoleCalls) => {
      await withNoopTimeout(async () => {
        await loaded.showStage("configuration");
      });

      assert.equal(
        consoleCalls.find(
          ([message]) =>
            message === "[guided-setup] Resizing guided setup window: reason=showStage:configuration targetWidth=1180 targetHeight=1080",
        )?.[0],
        "[guided-setup] Resizing guided setup window: reason=showStage:configuration targetWidth=1180 targetHeight=1080",
      );
    });
  });
});

test("navigateToStep blocks configuration until connect is complete and then loads the current server in power mode", () => {
  withGuidedSetupHarness(({ loaded, setupState, loadConfigurationCalls }) => {
    setupState.serverConfigs = [{ id: "slack" }, { id: "sourcegraph" }, { id: "gitlab" }];
    setupState.currentServerIndex = 2;
    setupState.oauthServers = [{ id: "glean" }];

    setupState.onboardingMode = "basic";
    loaded.navigateToStep("configuration");
    assert.deepEqual(loadConfigurationCalls, []);

    setupState.onboardingMode = "power";
    setupState.currentStage = "oauth";
    setupState.oauthStepRequired = true;
    setupState.completedSteps.oauth = false;
    loaded.navigateToStep("configuration");
    assert.deepEqual(loadConfigurationCalls, []);

    setupState.completedSteps.oauth = true;
    loaded.navigateToStep("configuration");
    assert.deepEqual(loadConfigurationCalls, [2]);

    setupState.completedSteps.oauth = false;
    setupState.oauthStepRequired = false;
    setupState.oauthServers = [];
    loaded.navigateToStep("configuration");
    assert.deepEqual(loadConfigurationCalls, [2, 2]);
  });
});

test("navigateToStep keeps manual Connect revisits on the Connect stage after OAuth is complete", async () => {
  await withGuidedSetupHarness(async ({ loaded, setupState, loadOauthCalls }) => {
    await withNoopTimeout(async () => {
      setupState.completedSteps.serverSelection = true;
      setupState.completedSteps.oauth = true;
      setupState.oauthStepRequired = false;
      setupState.oauthServers = [{ id: "glean" }];

      loaded.navigateToStep("oauth");
      await Promise.resolve();

      assert.equal(loadOauthCalls.length, 1);
      assert.equal(loadOauthCalls[0][2].suppressAutoAdvance, true);
    });
  });
});

test("guided setup callbacks proxy markdown parsing and pending-configuration lookup through the shared state", () => {
  withGuidedSetupHarness(({
    loaded,
    setupState,
    pendingIndexCalls,
    parserStub,
    generateConfirmationCard,
    copyToClipboard,
  }) => {
    const parseResult = loaded.callbacks.parseMarkdownContent(
      "## Slack",
      { SLACK_TOKEN: "token" },
      "server-config",
    );
    const pendingIndex = loaded.callbacks.findNextPendingConfigurationIndex(5);

    assert.equal(pendingIndex, 2);
    assert.deepEqual(pendingIndexCalls, [[setupState, 5]]);
    assert.equal(parseResult.args[0], "## Slack");
    assert.deepEqual(parseResult.args[1], { SLACK_TOKEN: "token" });
    assert.equal(parseResult.args[2], "server-config");
    assert.equal(parseResult.args[3].generateConfirmationCard, generateConfirmationCard);
    assert.equal(parseResult.args[3].copyToClipboard, copyToClipboard);
  });
});

test("guided setup helper exports derive prereq policy and normalize auth-related UI state", () => {
  withGuidedSetupHarness(({ loaded, setupState, elements }) => {
    setupState.launchContext = { source: "required" };
    setupState.prereqReadiness = { readyForAuth: true };
    setupState.onboardingMode = "power";
    setupState.hostModeSupported = true;

    const requiredPolicy = loaded._test.refreshPrereqPolicy();
    assert.deepEqual(requiredPolicy, {
      showStep: true,
      noInteractiveWorkRequired: true,
      reason: "required-no-op",
    });
    assert.equal(loaded._test.prerequisitesStepIsVisible(), true);
    assert.equal(loaded._test.canAdvancePastPrerequisites(), false);
    assert.equal(loaded._test.shouldStartPrereqBackgroundPrefetch(), false);

    setupState.launchContext = { source: "manual" };
    setupState.prereqReadiness = { readyForAuth: false };
    const blockedPolicy = loaded._test.refreshPrereqPolicy();
    assert.equal(blockedPolicy.reason, "install-not-ready");
    assert.equal(loaded._test.shouldStartPrereqBackgroundPrefetch(), true);

    loaded._test.setWelcomeAuthState({
      loading: true,
      message: "Logging in...",
      error: "No session",
    });
    assert.equal(elements.get("welcome-auth-state").style.display, "block");
    assert.equal(elements.get("welcome-auth-message").textContent, "Logging in...");
    assert.equal(elements.get("welcome-error").textContent, "No session");
    assert.equal(elements.get("welcome-start-button").disabled, true);
    assert.equal(elements.get("welcome-start-button").getAttribute("aria-busy"), "true");

    elements.get("hello-basic-option").className = "hello-option-card";
    elements.get("hello-power-option").className = "hello-option-card";
    setupState.savedOnboardingMode = "basic";
    loaded._test.syncHelloModeSelectionUI();
    assert.equal(elements.get("hello-basic-option").classList.contains("is-selected"), true);
    assert.equal(elements.get("hello-basic-option").getAttribute("aria-pressed"), "true");
    assert.equal(elements.get("hello-power-option").classList.contains("is-selected"), false);

    loaded._test.setHelloModeError("Pick one");
    assert.equal(elements.get("hello-mode-error").textContent, "Pick one");
    assert.equal(elements.get("hello-mode-error").style.display, "block");

    assert.equal(
      loaded._test.getHelloFirstName({ user: { preferredUsername: "Sam Rivera" } }),
      "Sam",
    );
    assert.equal(loaded._test.normalizeOnboardingModeSelection("power"), "power");
    assert.equal(loaded._test.normalizeOnboardingModeSelection("invalid"), null);
    assert.equal(
      loaded._test.formatSetupAuthError({
        errorCode: "access_denied_user_cancelled",
        message: "/Users/example/private-login-message",
      }),
      "Sign-in was canceled. Try again when you are ready.",
    );
    assert.equal(
      loaded._test.formatSetupAuthError({
        errorCode: "missing_refresh_token",
        message: "/Users/example/private-refresh-message",
      }),
      "The saved Okta login could not be refreshed. Sign in again.",
    );
  });
});

test("guided setup helper exports validate the basic bundle and can reset MCP server loading on failure", async () => {
  await withGuidedSetupHarness(async ({ loaded, setupState, electronApi }) => {
    setupState.mcpServers = [
      { id: "mcp-atlassian" },
      { id: "data-plat-mcp" },
      { id: "glean" },
      { id: "google_workspace" },
      { id: "slack" },
      { id: "ownership-mcp" },
      { id: "teamworks-mcp" },
    ];
    assert.deepEqual(loaded._test.validateBasicBundleSelection(), [0, 1, 2, 3, 4]);

    setupState.mcpServers = [
      { id: "mcp-atlassian", required_env_vars: [{ name: "TOKEN" }] },
      { id: "data-plat-mcp" },
      { id: "glean" },
      { id: "google_workspace" },
      { id: "slack" },
      { id: "ownership-mcp" },
      { id: "teamworks-mcp" },
    ];
    assert.throws(
      () => loaded._test.validateBasicBundleSelection(),
      /unsupported integrations: mcp-atlassian/,
    );

    setupState.mcpServers = [{ id: "mcp-atlassian" }];
    assert.throws(
      () => loaded._test.validateBasicBundleSelection(),
      /missing integrations:/,
    );

    setupState.mcpServers = [{ id: "legacy-selected", name: "Legacy Selected" }];
    setupState.selectedServers = [0];
    electronApi.loadMcpServers = async () => {
      throw new Error("network down");
    };

    await loaded._test.loadMcpServerConfigs();
    assert.deepEqual(setupState.mcpServers, []);
    assert.deepEqual(setupState.selectedServers, []);
  });
});

test("guided setup debug helper exports bucket and format entries by stage", () => {
  withGuidedSetupHarness(({ loaded, setupState }) => {
    setupState.currentStage = "oauth";
    loaded._test.recordGuidedSetupDebugEntry("OAuth started", "info");
    loaded._test.recordGuidedSetupDebugEntry("Finalizing", "success", "finalize");

    const sections = loaded._test.buildGuidedSetupTimelineSections();
    const documentText = loaded._test.buildGuidedSetupDebugDocument(sections);

    assert.equal(loaded._test.getGuidedSetupDebugBucket("vpn-check"), "prerequisites");
    assert.match(loaded._test.formatGuidedSetupDebugEntry(sections[0].content ? {
      text: "Manual",
      type: "info",
      timestamp: Date.now(),
    } : { text: "", type: "info", timestamp: Date.now() }), /\[INFO\]/);
    assert.equal(sections.some((section) => section.title === "Authorization"), true);
    assert.equal(sections.some((section) => section.title === "Finalize"), true);
    assert.match(documentText, /Guided Setup Debug/);
    assert.match(documentText, /OAuth started/);
  });
});

test("guided setup debug drawer refreshes, copies logs, collects debug info, and responds to bound controls", async () => {
  await withGuidedSetupHarness(async ({
    loaded,
    setupState,
    elements,
    electronApi,
    documentListeners,
    simulatedPrereqErrorCalls,
    clearedSimulatedPrereqErrorCalls,
  }) => {
    setupState.oauthServers = [
      { id: "sourcegraph", display_name: "Sourcegraph" },
      { id: "sourcegraph", display_name: "Sourcegraph Duplicate" },
    ];
    electronApi.getWizardMcpServerLogs = async () => ({ logs: "oauth runtime log" });
    electronApi.getGuidedSetupDebugSections = async () => ({
      success: true,
      sections: [
        {
          id: "runtime",
          title: "System / Runtime",
          meta: "Runtime",
          content: "runtime ok",
        },
      ],
    });

    loaded._test.recordGuidedSetupDebugEntry("Wizard started", "info", "welcome");
    const debugDocument = await loaded._test.refreshGuidedSetupDebugDrawer();

    assert.match(debugDocument, /Wizard started/);
    assert.match(debugDocument, /oauth runtime log/);
    assert.match(elements.get("guided-setup-debug-body").innerHTML, /System \/ Runtime/);

    loaded._test.showGuidedSetupDebugDrawer({ refresh: false });
    assert.equal(elements.get("guided-setup-debug-scrim").classList.contains("open"), true);
    assert.equal(elements.get("guided-setup-debug-drawer").classList.contains("open"), true);
    assert.equal(elements.get("guided-setup-debug-drawer").getAttribute("aria-hidden"), "false");

    await loaded._test.copyGuidedSetupDebugLogs();
    assert.equal(electronApi.clipboardCopies.length, 1);
    assert.match(electronApi.clipboardCopies[0], /Guided Setup Debug/);
    assert.equal(
      elements.get("guided-setup-debug-status").textContent,
      "Copied all guided setup logs to your clipboard.",
    );

    const collectResult = await loaded._test.collectGuidedSetupDebugInfo();
    assert.deepEqual(collectResult, { success: true, zipFile: "/tmp/debug-info.zip" });
    assert.equal(electronApi.savedControlPaneLogs.length, 1);
    assert.equal(electronApi.collectDebugInfoCalls, 1);
    assert.equal(elements.get("guided-setup-debug-overlay").classList.contains("visible"), false);

    loaded._test.bindGuidedSetupDebugDrawer();
    const forcedErrorButtons = [
      ["guided-setup-debug-force-error-generic", "generic"],
      ["guided-setup-debug-force-error-homebrew-auth-dialog-cancelled", "homebrew_auth_dialog_cancelled"],
      ["guided-setup-debug-force-error-homebrew-sudo-validation-failed", "homebrew_sudo_validation_failed"],
      ["guided-setup-debug-force-error-homebrew-admin-required", "homebrew_admin_required"],
      ["guided-setup-debug-force-error-homebrew-osascript-probe-failed", "homebrew_osascript_probe_failed"],
      ["guided-setup-debug-force-error-homebrew-outdated", "homebrew_outdated"],
      ["guided-setup-debug-force-error-orbstack-stale-artifact-conflict", "orbstack_stale_artifact_conflict"],
      ["guided-setup-debug-force-error-orbstack-cask-xattr-conflict", "orbstack_cask_xattr_conflict"],
      ["guided-setup-debug-force-error-orbstack-manual-recovery-required", "orbstack_manual_recovery_required"],
      ["guided-setup-debug-force-error-docker-pull-recovery-required", "docker_pull_recovery_required"],
    ];
    await withNoopTimeout(async () => {
      for (const [buttonId] of forcedErrorButtons) {
        await elements.get(buttonId).click();
      }
      await elements.get("guided-setup-debug-clear-error-state").click();
    });
    assert.deepEqual(
      simulatedPrereqErrorCalls,
      forcedErrorButtons.map(([, errorState]) => errorState),
    );
    assert.equal(clearedSimulatedPrereqErrorCalls.length, 1);
    assert.match(
      elements.get("guided-setup-debug-status").textContent,
      /Cleared simulated prerequisite error state/,
    );

    await elements.get("guided-setup-debug-toggle").click();
    assert.equal(elements.get("guided-setup-debug-drawer").classList.contains("open"), false);

    await elements.get("guided-setup-debug-toggle").click();
    await flushMicrotasks();
    assert.equal(elements.get("guided-setup-debug-drawer").classList.contains("open"), true);

    const keydownHandlers = documentListeners.get("keydown") || [];
    keydownHandlers[keydownHandlers.length - 1]({ key: "Escape" });
    assert.equal(elements.get("guided-setup-debug-drawer").classList.contains("open"), false);
  });
});

test("guided setup hides and does not bind simulated error controls outside dev builds", async () => {
  await withGuidedSetupHarness(async ({
    loaded,
    elements,
    electronApi,
    simulatedPrereqErrorCalls,
    clearedSimulatedPrereqErrorCalls,
  }) => {
    await withImmediateTimeout(() => loaded.initialize());

    assert.equal(electronApi.getBuildInfoCalls, 1);
    assert.equal(loaded._test.isGuidedSetupDevBuild(), false);
    assert.equal(elements.get("guided-setup-debug-test-panel").hidden, true);
    assert.equal(elements.get("guided-setup-debug-test-panel").style.display, "none");
    assert.equal(elements.get("guided-setup-debug-test-panel").getAttribute("aria-hidden"), "true");

    await elements.get("guided-setup-debug-force-error-generic").click();
    await elements.get("guided-setup-debug-clear-error-state").click();
    await flushMicrotasks();
    assert.deepEqual(simulatedPrereqErrorCalls, []);
    assert.deepEqual(clearedSimulatedPrereqErrorCalls, []);
    await assert.rejects(
      () => loaded._test.forceGuidedSetupPrereqErrorState("generic"),
      /only available in dev builds/,
    );

    loaded._test.recordGuidedSetupDebugEntry("release diagnostics still work", "info");
    await elements.get("guided-setup-debug-copy-btn").click();
    await flushMicrotasks();
    assert.equal(electronApi.clipboardCopies.length, 1);
    assert.match(electronApi.clipboardCopies[0], /release diagnostics still work/);

    await elements.get("guided-setup-debug-collect-btn").click();
    await flushMicrotasks();
    assert.equal(electronApi.collectDebugInfoCalls, 1);
  }, { buildNumber: "20260419.1" });
});

test("guided setup keeps simulated error controls hidden when build info is unavailable", async () => {
  await withGuidedSetupHarness(async ({ loaded, elements }) => {
    await loaded.initialize();

    assert.equal(loaded._test.isGuidedSetupDevBuild(), false);
    assert.equal(elements.get("guided-setup-debug-test-panel").hidden, true);
    assert.equal(elements.get("guided-setup-debug-test-panel").style.display, "none");
    assert.equal(elements.get("guided-setup-debug-test-panel").getAttribute("aria-hidden"), "true");
  }, {
    getBuildInfoImpl() {
      throw new Error("build info unavailable");
    },
  });

  await withGuidedSetupHarness(async ({ loaded, elements, electronApi }) => {
    delete electronApi.getBuildInfo;
    await loaded.initialize();

    assert.equal(loaded._test.isGuidedSetupDevBuild(), false);
    assert.equal(elements.get("guided-setup-debug-test-panel").hidden, true);
    assert.equal(elements.get("guided-setup-debug-test-panel").style.display, "none");
    assert.equal(elements.get("guided-setup-debug-test-panel").getAttribute("aria-hidden"), "true");
  });
});

test("guided setup simulated prerequisite errors force the prerequisites stage when it is normally hidden", async () => {
  await withGuidedSetupHarness(async ({
    loaded,
    setupState,
    elements,
    loadPrerequisitesCalls,
    progressVisibilityCalls,
    simulatedPrereqErrorCalls,
    clearedSimulatedPrereqErrorCalls,
    bootstrapPrereqCalls,
  }) => {
    const hiddenPolicy = {
      showStep: false,
      noInteractiveWorkRequired: false,
      reason: "manual-ready",
    };
    setupState.currentStage = "server-selection";
    setupState.prereqPolicy = { ...hiddenPolicy };
    setupState.skipPrerequisites = true;
    setupState.completedSteps.prerequisites = true;
    setupState.completedSteps.prerequisitesWarning = true;
    elements.get("stage-server-selection").classList.add("active");

    loaded._test.bindGuidedSetupDebugDrawer();

    const forcedErrorButtons = [
      ["guided-setup-debug-force-error-generic", "generic"],
      ["guided-setup-debug-force-error-homebrew-auth-dialog-cancelled", "homebrew_auth_dialog_cancelled"],
      ["guided-setup-debug-force-error-homebrew-sudo-validation-failed", "homebrew_sudo_validation_failed"],
      ["guided-setup-debug-force-error-homebrew-admin-required", "homebrew_admin_required"],
      ["guided-setup-debug-force-error-homebrew-osascript-probe-failed", "homebrew_osascript_probe_failed"],
      ["guided-setup-debug-force-error-homebrew-outdated", "homebrew_outdated"],
      ["guided-setup-debug-force-error-orbstack-stale-artifact-conflict", "orbstack_stale_artifact_conflict"],
      ["guided-setup-debug-force-error-orbstack-cask-xattr-conflict", "orbstack_cask_xattr_conflict"],
      ["guided-setup-debug-force-error-orbstack-manual-recovery-required", "orbstack_manual_recovery_required"],
      ["guided-setup-debug-force-error-docker-pull-recovery-required", "docker_pull_recovery_required"],
    ];

    await withNoopTimeout(async () => {
      for (const [buttonId] of forcedErrorButtons) {
        await elements.get(buttonId).click();
        await flushMicrotasks();

        assert.equal(elements.get("stage-prerequisites").classList.contains("active"), true);
        assert.equal(elements.get("stage-server-selection").classList.contains("active"), false);
        assert.equal(setupState.currentStage, "prerequisites");

        const lastPrereqLoad = loadPrerequisitesCalls[loadPrerequisitesCalls.length - 1];
        assert.equal(lastPrereqLoad?.[2]?.deferStart, true);
        assert.equal(lastPrereqLoad?.[2]?.suppressAutoAdvance, true);
        assert.equal(lastPrereqLoad?.[2]?.manualVisit, false);
        assert.equal(lastPrereqLoad?.[2]?.resume, false);
        assert.deepEqual(progressVisibilityCalls.at(-1)?.[4], {
          showPrerequisitesTracker: false,
        });
        assert.equal(bootstrapPrereqCalls.length, 0);
      }

      assert.deepEqual(
        simulatedPrereqErrorCalls,
        forcedErrorButtons.map(([, errorState]) => errorState),
      );
      assert.deepEqual(setupState.prereqPolicy, {
        showStep: true,
        noInteractiveWorkRequired: false,
        reason: "debug-simulated-error",
      });
      assert.equal(setupState.skipPrerequisites, false);
      assert.equal(setupState.completedSteps.prerequisites, false);

      await elements.get("guided-setup-debug-clear-error-state").click();
      await flushMicrotasks();
    });

    assert.equal(clearedSimulatedPrereqErrorCalls.length, 1);
    assert.equal(elements.get("stage-prerequisites").classList.contains("active"), false);
    assert.equal(elements.get("stage-server-selection").classList.contains("active"), true);
    assert.equal(setupState.currentStage, "server-selection");
    assert.deepEqual(setupState.prereqPolicy, hiddenPolicy);
    assert.equal(setupState.skipPrerequisites, true);
    assert.equal(setupState.completedSteps.prerequisites, true);
    assert.equal(setupState.completedSteps.prerequisitesWarning, true);
    assert.equal(bootstrapPrereqCalls.length, 0);
  });
});

test("guided setup shared titlebar controls remain available while navigating prerequisites, finalize, and success", async () => {
  await withGuidedSetupHarness(async ({
    loaded,
    elements,
  }) => {
    const themeToggle = elements.get("theme-toggle");
    const debugToggle = elements.get("guided-setup-debug-toggle");

    loaded._test.bindGuidedSetupDebugDrawer();

    await withNoopTimeout(async () => {
      for (const stageName of ["prerequisites", "finalize", "success"]) {
        await loaded.showStage(stageName);

        assert.ok(themeToggle, `expected theme toggle for ${stageName}`);
        assert.ok(debugToggle, `expected debug toggle for ${stageName}`);
        assert.notEqual(themeToggle.style.display, "none");
        assert.notEqual(debugToggle.style.display, "none");

        await debugToggle.click();
        assert.equal(
          elements.get("guided-setup-debug-drawer").classList.contains("open"),
          true,
          `expected debug drawer to open on ${stageName}`,
        );

        await debugToggle.click();
        assert.equal(
          elements.get("guided-setup-debug-drawer").classList.contains("open"),
          false,
          `expected debug drawer to close on ${stageName}`,
        );
      }
    });
  });
});

test("guided setup debug helpers cover empty, hidden, and failure states", async () => {
  await withGuidedSetupHarness(async ({
    loaded,
    setupState,
    elements,
    electronApi,
  }) => {
    assert.equal(loaded._test.escapeDebugHtml('<tag>"x"&\'y\''), "&lt;tag&gt;&quot;x&quot;&amp;&#39;y&#39;");
    assert.equal(
      loaded._test.buildGuidedSetupDebugDocument([]),
      "Guided Setup Debug\n\nNo logs were captured yet.",
    );

    loaded._test.setGuidedSetupDebugStatus("Broken", "error");
    assert.equal(elements.get("guided-setup-debug-status").style.display, "block");
    assert.equal(elements.get("guided-setup-debug-status").classList.contains("error"), true);
    loaded._test.setGuidedSetupDebugStatus(null);
    assert.equal(elements.get("guided-setup-debug-status").style.display, "none");
    assert.equal(elements.get("guided-setup-debug-status").textContent, "");

    loaded._test.renderGuidedSetupDebugSections([]);
    assert.match(elements.get("guided-setup-debug-body").innerHTML, /Detailed guided setup logs will appear here/);

    setupState.oauthServers = null;
    assert.deepEqual(await loaded._test.getOAuthDebugSections(), []);

    setupState.oauthServers = [{ id: "sourcegraph", display_name: "Sourcegraph" }];
    electronApi.getWizardMcpServerLogs = async () => {
      throw new Error("runtime unavailable");
    };
    assert.deepEqual(await loaded._test.getOAuthDebugSections(), []);

    electronApi.getGuidedSetupDebugSections = async () => {
      throw new Error("runtime collection failed");
    };
    const failureSections = await loaded._test.buildGuidedSetupDebugSections();
    assert.equal(
      failureSections.some((section) => /Failed to gather runtime logs/.test(section.content)),
      true,
    );

    loaded._test.setGuidedSetupDebugState({
      refreshing: true,
      lastDocument: "cached document",
    });
    const cached = await loaded._test.refreshGuidedSetupDebugDrawer();
    assert.equal(cached, "cached document");

    loaded._test.setGuidedSetupDebugState({
      refreshing: false,
      collecting: true,
    });
    assert.deepEqual(await loaded._test.collectGuidedSetupDebugInfo(), {
      success: false,
      error: "Debug collection already in progress.",
    });

    loaded._test.setGuidedSetupDebugState({
      collecting: false,
      lastDocument: "cached document",
    });
    electronApi.collectDebugInfo = async () => {
      electronApi.collectDebugInfoCalls += 1;
      return { success: false, error: "zip failed" };
    };
    const failedCollect = await loaded._test.collectGuidedSetupDebugInfo();
    assert.deepEqual(failedCollect, { success: false, error: "zip failed" });
    assert.match(
      elements.get("guided-setup-debug-status").textContent,
      /Failed to collect debug information: zip failed/,
    );

    electronApi.collectDebugInfo = async () => {
      throw new Error("collector crashed");
    };
    const crashedCollect = await loaded._test.collectGuidedSetupDebugInfo();
    assert.deepEqual(crashedCollect, {
      success: false,
      error: "collector crashed",
    });

    loaded._test.bindGuidedSetupDebugDrawer();
    electronApi.copyToClipboard = async () => {
      throw new Error("clipboard offline");
    };
    await elements.get("guided-setup-debug-copy-btn").click();
    await flushMicrotasks();
    assert.match(
      elements.get("guided-setup-debug-status").textContent,
      /Failed to copy logs: clipboard offline/,
    );

    electronApi.collectDebugInfo = async () => {
      throw new Error("collect click failed");
    };
    await elements.get("guided-setup-debug-collect-btn").click();
    await flushMicrotasks();
    assert.match(
      elements.get("guided-setup-debug-status").textContent,
      /Failed to collect debug information: collect click failed/,
    );

    loaded._test.setGuidedSetupDebugState({ drawerOpen: false });
    await withImmediateTimeout(async () => {
      loaded._test.scheduleGuidedSetupDebugRefresh();
      await flushMicrotasks();
    });
    assert.equal(loaded._test.getGuidedSetupDebugState().drawerOpen, false);
  });
});

test("showStage loads prerequisites, oauth, vpn-check, and finalize with the expected shell behavior", async () => {
  await withGuidedSetupHarness(async ({
    loaded,
    setupState,
    elements,
    electronApi,
    loadPrerequisitesCalls,
    loadOauthCalls,
    loadVpnCalls,
    hideBrowserCalls,
  }) => {
    setupState.completedSteps.prerequisites = true;

    await withNoopTimeout(async () => {
      await loaded.showStage("prerequisites");
      await loaded.showStage("vpn-check", { initialResult: { success: true } });
      await loaded.showStage("oauth");
      await loaded.showStage("finalize");
    });

    assert.equal(loadPrerequisitesCalls.length, 1);
    assert.equal(loadPrerequisitesCalls[0][2].resume, true);
    assert.equal(loadVpnCalls.length, 1);
    assert.equal(loadOauthCalls.length, 1);
    assert.equal(elements.get("stage-finalize").classList.contains("active"), true);
    assert.deepEqual(electronApi.maximizeCalls.slice(-3), [
      { targetHeight: 860 },
      { targetHeight: 800 },
    ]);
    assert.deepEqual(hideBrowserCalls.slice(-2), ["oauth", "finalize"]);
  });
});

test("guided setup logs default startup window resize requests", async () => {
  await withGuidedSetupHarness(async ({ electronApi }) => {
    await withCapturedConsoleLog(async (consoleCalls) => {
      await withImmediateTimeout(async () => {
        await global.window.startSetup();
      });

      assert.deepEqual(electronApi.maximizeCalls[0], {});
      assert.equal(
        consoleCalls.find(
          ([message]) =>
            message === "[guided-setup] Resizing guided setup window: reason=startSetup targetWidth=1180 targetHeight=820",
        )?.[0],
        "[guided-setup] Resizing guided setup window: reason=startSetup targetWidth=1180 targetHeight=820",
      );
    });
  });
});

test("navigateToStep routes hello, server-selection, oauth, prerequisites, and finalize only when allowed", async () => {
  await withGuidedSetupHarness(async ({
    loaded,
    setupState,
    elements,
    loadOauthCalls,
    populateCalls,
    loadPrerequisitesCalls,
    progressVisibilityCalls,
  }) => {
    await withNoopTimeout(async () => {
      loaded.navigateToStep("hello");
      assert.equal(elements.get("stage-hello").classList.contains("active"), false);

      setupState.currentStage = "server-selection";
      loaded.navigateToStep("hello");
      assert.equal(elements.get("stage-hello").classList.contains("active"), true);

      setupState.currentStage = "server-selection";
      setupState.prereqPolicy = { showStep: true };
      setupState.completedSteps.prerequisites = true;
      loaded.navigateToStep("prerequisites");
      await Promise.resolve();
      assert.equal(loadPrerequisitesCalls.length, 1);
      assert.equal(loadPrerequisitesCalls[0][2].manualVisit, true);
      assert.equal(loadPrerequisitesCalls[0][2].suppressAutoAdvance, true);
      assert.deepEqual(progressVisibilityCalls.at(-1)[4], {
        showPrerequisitesTracker: true,
      });

      setupState.completedSteps.serverSelection = true;
      setupState.oauthServers = [{ id: "sourcegraph" }];
      setupState.oauthStepRequired = true;
      loaded.navigateToStep("oauth");
      await Promise.resolve();
      assert.equal(loadOauthCalls.length, 1);

      setupState.currentStage = "finalize";
      loaded.navigateToStep("finalize");
      await Promise.resolve();
      assert.equal(elements.get("stage-finalize").classList.contains("active"), true);
    });
  });
});

test("initialize bootstraps guided setup state, wires startup helpers, and starts background prereq prefetch when needed", async () => {
  await withGuidedSetupHarness(async ({
    loaded,
    setupState,
    electronApi,
    populateCalls,
    envInitCalls,
    loadExistingEnvVarCalls,
    setupWebviewCalls,
    setupResizeHandleCalls,
    setupClipboardShortcutCalls,
    createWindowHandlersCalls,
  }) => {
    electronApi.getGuidedSetupBootstrapState = async () => ({
      launchContext: {
        source: "required",
        trigger: "bootstrap",
        startedAt: 123,
      },
      prereqReadiness: {
        readyForAuth: false,
        reason: "missing-images",
        missingImages: ["redis:latest"],
      },
      savedOnboardingMode: "basic",
      hostModeEnabled: false,
    });

    await loaded.initialize();

    assert.deepEqual(envInitCalls, ["/tmp/project"]);
    assert.equal(loadExistingEnvVarCalls.length, 1);
    assert.equal(setupState.envVars.EXISTING_TOKEN, "from-env");
    assert.deepEqual(setupState.launchContext, {
      source: "required",
      trigger: "bootstrap",
      startedAt: 123,
      setupMode: null,
      setupReason: null,
      setupRequirementId: null,
      safeErrorCode: null,
      setupOperationId: null,
      seedDefaults: false,
    });
    assert.deepEqual(setupState.prereqReadiness, {
      readyForAuth: false,
      reason: "missing-images",
      missingImages: ["redis:latest"],
    });
    assert.equal(setupState.savedOnboardingMode, "basic");
    assert.equal(setupState.hostModeSupported, false);
    assert.equal(setupState.prereqPolicy.reason, "required-interactive");
    assert.equal(setupWebviewCalls.length, 1);
    assert.equal(setupResizeHandleCalls.length, 1);
    assert.equal(setupClipboardShortcutCalls.length, 1);
    assert.equal(createWindowHandlersCalls.length, 1);
    assert.equal(populateCalls.length, 0);
    assert.equal(electronApi.backgroundPrefetchCalls, 1);
  });
});

test("identity repair initializes only the login stage and exits after disk re-evaluation", async () => {
  await withGuidedSetupHarness(async ({
    loaded,
    setupState,
    electronApi,
    envInitCalls,
    loadExistingEnvVarCalls,
    setupWebviewCalls,
    setupResizeHandleCalls,
    setupClipboardShortcutCalls,
    createWindowHandlersCalls,
  }) => {
    electronApi.getGuidedSetupBootstrapState = async () => ({
      launchContext: {
        source: "required",
        trigger: "identity-repair",
        startedAt: 123,
        setupMode: "identity_repair",
        setupReason: "env-user-missing",
        setupOperationId: "setup-identity-1",
      },
    });
    electronApi.loadMcpServers = async () => {
      throw new Error("identity repair must not load integrations");
    };
    electronApi.loadGuidedSetupMcpToggles = async () => {
      throw new Error("identity repair must not load toggles");
    };
    electronApi.getSetupLaunchDecision = async () => ({
      success: true,
      decision: { action: "continue" },
    });
    let completionCalls = 0;
    electronApi.electronAppComplete = () => {
      completionCalls += 1;
    };

    await withImmediateTimeout(() => loaded.initialize());
    assert.equal(setupState.currentStage, "welcome");
    assert.deepEqual(envInitCalls, []);
    assert.equal(loadExistingEnvVarCalls.length, 0);
    assert.equal(setupWebviewCalls.length, 0);
    assert.equal(setupResizeHandleCalls.length, 0);
    assert.equal(createWindowHandlersCalls.length, 0);
    assert.equal(setupClipboardShortcutCalls.length, 1);

    await withImmediateTimeout(async () => {
      await global.window.startSetup();
    });
    assert.equal(completionCalls, 1);
    assert.equal(setupState.currentStage, "welcome");
  });
});

test("runtime repair initializes prerequisites directly without loading integrations or showing login", async () => {
  await withGuidedSetupHarness(async ({
    loaded,
    setupState,
    electronApi,
    envInitCalls,
    loadExistingEnvVarCalls,
    setupClipboardShortcutCalls,
    createWindowHandlersCalls,
  }) => {
    electronApi.getGuidedSetupBootstrapState = async () => ({
      launchContext: {
        source: "required",
        trigger: "runtime-repair",
        startedAt: 123,
        setupMode: "runtime_repair",
        setupReason: "runtime-file-missing",
        setupOperationId: "setup-runtime-1",
      },
      prereqReadiness: {
        readyForAuth: false,
        reason: "runtime-file-missing",
        missingImages: [],
      },
    });
    electronApi.loadMcpServers = async () => {
      throw new Error("runtime repair must not load integrations");
    };
    electronApi.loadGuidedSetupMcpToggles = async () => {
      throw new Error("runtime repair must not load toggles");
    };

    await withImmediateTimeout(() => loaded.initialize());

    assert.equal(electronApi.currentUserGetCalls, 1);
    assert.equal(electronApi.setupAuthStartCalls, 0);
    assert.equal(setupState.currentStage, "prerequisites");
    assert.deepEqual(envInitCalls, []);
    assert.equal(loadExistingEnvVarCalls.length, 0);
    assert.equal(createWindowHandlersCalls.length, 0);
    assert.equal(setupClipboardShortcutCalls.length, 1);
  });
});

test("window.startSetup validates the authenticated session without renderer identity writes", async () => {
  await withGuidedSetupHarness(async ({
    elements,
    setupState,
    electronApi,
    saveEnvVarCalls,
  }) => {
    await withImmediateTimeout(async () => {
      await global.window.startSetup();
    });

    assert.equal(electronApi.setupAuthClearCalls, 1);
    assert.equal(electronApi.setupAuthStartCalls, 1);
    assert.equal(setupState.envVars.PORTICO_USER_ID, undefined);
    assert.equal(setupState.envVars.PORTICO_USER_NAME, undefined);
    assert.deepEqual(saveEnvVarCalls, []);
    assert.equal(elements.get("stage-hello").classList.contains("active"), true);
    assert.equal(setupState.currentStage, "hello");
    assert.equal(elements.get("hello-title").textContent, "Hello, Sam!");
  });
});

test("window.startSetup surfaces fixed current-user failures without leaving welcome", async () => {
  await withGuidedSetupHarness(async ({ elements, electronApi, setupState }) => {
    const privateMessage =
      "Failed to write /Users/example/private/.env for employee@example.com";
    electronApi.currentUser = {
      clearError: async () => null,
      ensureAuthenticated: async () => ({
        success: false,
        errorCode: "identity_sync_failed",
        error: privateMessage,
      }),
    };

    await withCapturedConsoleError(async (calls) => {
      await withImmediateTimeout(async () => {
        await global.window.startSetup();
      });

      assert.deepEqual(calls, [
        ["[guided-setup] Setup auth failed (identity_sync_failed)"],
      ]);
      assert.doesNotMatch(JSON.stringify(calls), /Users|employee/);
    });

    assert.equal(setupState.currentStage, "welcome");
    assert.equal(
      elements.get("welcome-error").textContent,
      "The signed-in account could not be saved locally. Try again.",
    );
    assert.equal(elements.get("welcome-auth-state").style.display, "none");
    assert.equal(elements.get("welcome-start-button").disabled, false);
    assert.equal(
      elements.get("welcome-start-button").getAttribute("aria-busy"),
      "false",
    );
  });
});

test("window.startSetup surfaces a specific fixed token-exchange failure", async () => {
  await withGuidedSetupHarness(async ({ elements, electronApi, setupState }) => {
    electronApi.currentUser = {
      clearError: async () => null,
      ensureAuthenticated: async () => ({
        success: false,
        errorCode: "token_exchange_failed",
        error:
          "employee@example.com /Users/example/private.txt PRIVATE_TOKEN",
      }),
    };

    await withCapturedConsoleError(async (calls) => {
      await withImmediateTimeout(async () => {
        await global.window.startSetup();
      });
      assert.deepEqual(calls, [
        ["[guided-setup] Setup auth failed (token_exchange_failed)"],
      ]);
    });

    assert.equal(setupState.currentStage, "welcome");
    assert.equal(
      elements.get("welcome-error").textContent,
      "Okta rejected the final sign-in step. Try again once; if it keeps failing, contact support.",
    );
    assert.doesNotMatch(
      elements.get("welcome-error").textContent,
      /employee|Users|PRIVATE_TOKEN/,
    );
    assert.equal(elements.get("welcome-start-button").disabled, false);
  });
});

test("window.selectHelloMode persists the choice, resets guided setup state, and routes to VPN check when connectivity fails", async () => {
  await withGuidedSetupHarness(async ({
    setupState,
    electronApi,
    loadPrerequisitesCalls,
    loadVpnCalls,
  }) => {
    setupState.currentStage = "hello";
    setupState.savedOnboardingMode = "basic";
    setupState.selectedServers = [1];
    setupState.serverSelectionHydrated = true;
    setupState.oauthServers = [{ id: "sourcegraph" }];
    setupState.oauthStepRequired = true;
    setupState.serverConfigs = [{ id: "slack" }];
    setupState.completedSteps.serverSelection = true;
    setupState.completedSteps.oauth = true;
    setupState.currentOAuthIndex = 4;
    setupState.currentServerIndex = 3;
    setupState.configuredServers.add("slack");
    setupState.skippedServers.add("gitlab");
    setupState.completedOAuthServers.add("sourcegraph");
    setupState.skippedOAuthServers.add("gitlab");
    electronApi.checkVpnConnectivity = async () => {
      electronApi.vpnCheckCalls += 1;
      return {
        success: false,
        harbor: { ok: false, error: "vpn down" },
        cloudsmith: { ok: false, error: "vpn down" },
      };
    };

    await withImmediateTimeout(async () => {
      await global.window.selectHelloMode("power");
      await flushMicrotasks();
    });

    assert.deepEqual(electronApi.saveModePreferenceCalls, ["power"]);
    assert.equal(setupState.savedOnboardingMode, "power");
    assert.equal(setupState.onboardingMode, "power");
    assert.deepEqual(setupState.selectedServers, []);
    assert.equal(setupState.serverSelectionHydrated, false);
    assert.deepEqual(setupState.oauthServers, []);
    assert.equal(setupState.oauthStepRequired, null);
    assert.deepEqual(setupState.serverConfigs, []);
    assert.equal(setupState.completedSteps.serverSelection, false);
    assert.equal(setupState.completedSteps.oauth, false);
    assert.equal(setupState.currentOAuthIndex, 0);
    assert.equal(setupState.currentServerIndex, 0);
    assert.equal(setupState.configuredServers.size, 0);
    assert.equal(setupState.skippedServers.size, 0);
    assert.equal(setupState.completedOAuthServers.size, 0);
    assert.equal(setupState.skippedOAuthServers.size, 0);
    assert.equal(loadPrerequisitesCalls.length, 1);
    assert.equal(loadVpnCalls.length, 1);
    assert.equal(setupState.currentStage, "vpn-check");
  });
});

test("window.selectHelloMode restores the previous selection and shows an error when preference persistence fails", async () => {
  await withGuidedSetupHarness(async ({ setupState, elements, electronApi, loadPrerequisitesCalls }) => {
    setupState.currentStage = "hello";
    setupState.savedOnboardingMode = "basic";
    elements.get("hello-basic-option").className = "hello-option-card is-selected";
    electronApi.saveGuidedSetupModePreference = async () => ({
      success: false,
      error: "Preference store unavailable",
    });

    await global.window.selectHelloMode("power");

    assert.equal(setupState.savedOnboardingMode, "basic");
    assert.equal(elements.get("hello-mode-error").textContent, "Preference store unavailable");
    assert.equal(elements.get("hello-mode-error").style.display, "block");
    assert.equal(elements.get("hello-basic-option").classList.contains("is-selected"), true);
    assert.equal(elements.get("hello-power-option").classList.contains("is-selected"), false);
    assert.equal(loadPrerequisitesCalls.length, 0);
    assert.equal(setupState.currentStage, "hello");
  });
});

test("continueAfterModeSelection skips prereqs entirely when the current policy says the step is hidden", async () => {
  await withGuidedSetupHarness(async ({
    loaded,
    setupState,
    loadPrerequisitesCalls,
    populateCalls,
    electronApi,
  }) => {
    setupState.onboardingMode = "power";
    setupState.prereqReadiness = { readyForAuth: true };
    setupState.hostModeSupported = true;
    setupState.launchContext = { source: "manual" };

    await withNoopTimeout(async () => {
      await loaded._test.continueAfterModeSelection();
    });

    assert.equal(loadPrerequisitesCalls.length, 0);
    assert.equal(populateCalls.length, 1);
    assert.equal(setupState.completedSteps.prerequisites, true);
    assert.equal(setupState.currentStage, "server-selection");
    assert.deepEqual(electronApi.maximizeCalls, [{ targetHeight: 880 }]);
  });
});

test("window.selectHelloMode transitions directly to integrations with a single resize when prereqs are already satisfied", async () => {
  await withGuidedSetupHarness(async ({
    setupState,
    electronApi,
    populateCalls,
    loadPrerequisitesCalls,
  }) => {
    setupState.currentStage = "hello";
    setupState.prereqReadiness = { readyForAuth: true };
    setupState.hostModeSupported = true;
    setupState.launchContext = { source: "manual" };

    await withNoopTimeout(async () => {
      await global.window.selectHelloMode("power");
    });

    assert.deepEqual(electronApi.saveModePreferenceCalls, ["power"]);
    assert.equal(loadPrerequisitesCalls.length, 0);
    assert.equal(populateCalls.length, 1);
    assert.equal(setupState.currentStage, "server-selection");
    assert.deepEqual(electronApi.maximizeCalls, [{ targetHeight: 880 }]);
  });
});

test("continueAfterModeSelection shows prereqs and boots the session immediately when no interactive work is required", async () => {
  await withGuidedSetupHarness(async ({
    loaded,
    setupState,
    loadPrerequisitesCalls,
    bootstrapPrereqCalls,
    electronApi,
  }) => {
    setupState.onboardingMode = "power";
    setupState.prereqReadiness = { readyForAuth: true };
    setupState.hostModeSupported = true;
    setupState.launchContext = { source: "required" };

    await withNoopTimeout(async () => {
      await loaded._test.continueAfterModeSelection();
      await flushMicrotasks();
    });

    assert.equal(loadPrerequisitesCalls.length, 1);
    assert.deepEqual(bootstrapPrereqCalls, [{ shouldResume: false }]);
    assert.equal(electronApi.vpnCheckCalls, 0);
    assert.equal(setupState.currentStage, "prerequisites");
  });
});

test("continueAfterModeSelection resumes prereqs after a successful VPN check when the step was already completed", async () => {
  await withGuidedSetupHarness(async ({
    loaded,
    setupState,
    bootstrapPrereqCalls,
    electronApi,
  }) => {
    setupState.completedSteps.prerequisites = true;
    setupState.onboardingMode = "power";
    setupState.prereqReadiness = { readyForAuth: false };

    await withNoopTimeout(async () => {
      await loaded._test.continueAfterModeSelection();
      await flushMicrotasks();
    });

    assert.equal(electronApi.vpnCheckCalls, 1);
    assert.deepEqual(bootstrapPrereqCalls, [{ shouldResume: true }]);
    assert.equal(setupState.currentStage, "prerequisites");
  });
});

test("power mode server selection preserves prior choices and hydrates every explicitly enabled toggle", async () => {
  await withGuidedSetupHarness(async ({
    loaded,
    setupState,
    electronApi,
  }) => {
    setupState.onboardingMode = "power";
    setupState.serverSelectionHydrated = false;
    setupState.mcpServers = [{ id: "datadog", name: "Datadog" }];
    setupState.selectedServers = [0];
    let rawToggleLoads = 0;
    electronApi.loadGuidedSetupMcpToggles = async () => {
      rawToggleLoads += 1;
      return {
        success: true,
        data: {
          sourcegraph: true,
          slack: true,
        },
      };
    };
    electronApi.loadMcpServers = async () => ({
      success: true,
      data: [
        { id: "mcp-atlassian", name: "Atlassian" },
        { id: "data-plat-mcp", name: "Data Platform" },
        { id: "glean", name: "Glean" },
        { id: "google_workspace", name: "Google Workspace" },
        { id: "datadog", name: "Datadog" },
        { id: "sourcegraph", name: "Sourcegraph" },
        { id: "slack", name: "Slack" },
      ],
    });

    await withNoopTimeout(async () => {
      await loaded.showStage("server-selection");
    });

    assert.equal(rawToggleLoads, 1);
    assert.deepEqual(setupState.selectedServers, [4, 5, 6]);
  });
});

test("advanceAfterPrerequisites loads the basic bundle and proceeds directly to configuration in basic mode", async () => {
  await withGuidedSetupHarness(async ({
    loaded,
    setupState,
    electronApi,
    proceedToConfigurationCalls,
  }) => {
    setupState.onboardingMode = "basic";
    electronApi.loadMcpServers = async () => ({
      success: true,
      data: [
        { id: "mcp-atlassian", name: "Atlassian" },
        { id: "data-plat-mcp", name: "Data Platform" },
        { id: "glean", name: "Glean" },
        { id: "google_workspace", name: "Google Workspace" },
        { id: "slack", name: "Slack" },
        { id: "ownership-mcp", name: "Ownership" },
        { id: "teamworks-mcp", name: "Teamworks" },
      ],
    });

    await loaded._test.advanceAfterPrerequisites();

    assert.equal(setupState.completedSteps.prerequisites, true);
    assert.deepEqual(setupState.selectedServers, [0, 1, 2, 3, 4]);
    assert.equal(proceedToConfigurationCalls.length, 1);
    assert.equal(setupState.currentStage, "welcome");
  });
});

test("contractor guided setup sync marks Data Platform as wizard-disabled and removes it from the basic bundle", async () => {
  await withGuidedSetupHarness(async ({
    loaded,
    setupState,
    electronApi,
    proceedToConfigurationCalls,
  }) => {
    setupState.onboardingMode = "basic";
    loaded._test.setAuthenticatedSetupSession({
      user: {
        id: "sof",
        name: "Sof Contractor",
        email: "sof_bshorokh@contractor.example.invalid",
      },
    });
    electronApi.loadMcpServers = async () => ({
      success: true,
      data: [
        { id: "mcp-atlassian", name: "Atlassian" },
        { id: "data-plat-mcp", name: "Data Platform" },
        { id: "glean", name: "Glean" },
        { id: "google_workspace", name: "Google Workspace" },
        { id: "slack", name: "Slack" },
        { id: "ownership-mcp", name: "Ownership" },
        { id: "teamworks-mcp", name: "Teamworks" },
      ],
    });

    await loaded._test.advanceAfterPrerequisites();

    assert.equal(setupState.guidedSetupDisabledServerIds.has("data-plat-mcp"), true);
    assert.match(
      setupState.guidedSetupDisabledTooltips["data-plat-mcp"],
      /Unavailable during guided setup for contractor accounts/,
    );
    assert.deepEqual(setupState.selectedServers, [0, 2, 3, 4]);
    assert.equal(proceedToConfigurationCalls.length, 1);
  });
});

test("contractor helpers only match the contractor domain suffix", async () => {
  await withGuidedSetupHarness(async ({ loaded }) => {
    assert.equal(
      loaded._test.isContractorGuidedSetupEmail("sof_bshorokh@contractor.example.invalid"),
      true,
    );
    assert.equal(
      loaded._test.isContractorGuidedSetupEmail("SOF_BSHOROKH@CONTRACTOR.EXAMPLE.INVALID"),
      true,
    );
    assert.equal(
      loaded._test.isContractorGuidedSetupEmail("sof_bshorokh@example.invalid"),
      false,
    );
    assert.deepEqual(
      loaded._test.getBasicCuratedServerIds({
        user: { email: "sof_bshorokh@contractor.example.invalid" },
      }),
      [
        "mcp-atlassian",
        "glean",
        "google_workspace",
        "slack",
      ],
    );
  });
});

test("guided setup helper exports cover launch policy fallbacks, health loading, host-mode checks, and background prefetch failures", async () => {
  await withGuidedSetupHarness(async ({ loaded, setupState, electronApi }) => {
    setupState.launchContext = null;
    assert.equal(loaded._test.getGuidedSetupLaunchSource(), "unknown");

    setupState.launchContext = { source: "required" };
    setupState.prereqReadiness = { readyForAuth: true };
    setupState.hostModeSupported = false;
    assert.deepEqual(loaded._test.applyPrereqSkipState(), {
      showStep: true,
      noInteractiveWorkRequired: false,
      reason: "required-interactive",
    });

    electronApi.getLastHealthStatus = async () => {
      throw new Error("primary unavailable");
    };
    electronApi.getHealthStatus = async () => ({
      servers: { sourcegraph: { enabled: true } },
    });
    assert.deepEqual(await loaded._test.loadGuidedSetupHealthStatus(), {
      servers: { sourcegraph: { enabled: true } },
    });

    electronApi.getLastHealthStatus = async () => ({ error: "bad" });
    electronApi.getHealthStatus = async () => {
      throw new Error("secondary unavailable");
    };
    assert.equal(await loaded._test.loadGuidedSetupHealthStatus(), null);

    electronApi.checkHostMode = async () => {
      throw new Error("unsupported");
    };
    await loaded._test.checkHostModeSupport();
    assert.equal(setupState.hostModeSupported, false);

    electronApi.prerequisitesStartBackgroundPrefetch = async () => {
      throw new Error("prefetch failed");
    };
    loaded._test.startPrereqBackgroundPrefetch();
    await flushMicrotasks();
  });
});

test("guided setup helper exports wire scroll, tooltip, input-field, and hello-stage UI behaviors", async () => {
  await withGuidedSetupHarness(async ({
    loaded,
    setupState,
    setupPanel,
    elements,
  }) => {
    const scrollArea = global.document.querySelector(".content-scroll-area");
    scrollArea.scrollTop = 0;
    const originalQuerySelectorAll = global.document.querySelectorAll.bind(global.document);

    loaded._test.setupLeftPanelScroll();
    const wheelHandler = setupPanel.listeners.get("wheel")[0];

    let prevented = false;
    wheelHandler({
      defaultPrevented: false,
      deltaY: 24,
      target: { closest: () => null },
      preventDefault() {
        prevented = true;
      },
    });
    assert.equal(scrollArea.scrollTop, 24);
    assert.equal(prevented, true);

    const tooltipButton = createStyledElement("tooltip-button");
    tooltipButton.dataset = {};
    tooltipButton.getBoundingClientRect = () => ({
      left: 10,
      top: 20,
      width: 80,
      height: 24,
    });

    const existingInput = createStyledElement("existing-input");
    existingInput.classList.add("input-field");
    const nestedInput = createStyledElement("nested-input");
    nestedInput.classList.add("input-field");
    const container = createStyledElement("container");
    container.nodeType = 1;
    container.classList.contains = () => false;
    container.querySelectorAll = (selector) =>
      selector === ".input-field" ? [nestedInput] : [];

    let observerCallback = null;
    const previousMutationObserver = global.MutationObserver;
    global.MutationObserver = class MutationObserver {
      constructor(callback) {
        observerCallback = callback;
      }

      observe() {}
      disconnect() {}
    };

    global.document.querySelectorAll = (selector) => {
      if (selector === '[data-tooltip-follow="pointer"]') {
        return [tooltipButton];
      }
      if (selector === ".input-field") {
        return [existingInput];
      }
      return originalQuerySelectorAll(selector);
    };

    loaded._test.setupPointerTrackedTooltips();
    const moveHandler = tooltipButton.listeners.get("mousemove")[0];
    const blurHandler = tooltipButton.listeners.get("blur")[0];
    moveHandler({ clientX: 40, clientY: 32 });
    assert.equal(tooltipButton.style["--tooltip-anchor-x"], "30px");
    assert.equal(tooltipButton.style["--tooltip-anchor-y"], "12px");
    blurHandler();
    assert.equal(tooltipButton.style["--tooltip-anchor-x"], undefined);

    loaded._test.setupInputFieldObservers();
    assert.equal(existingInput.style.pointerEvents, "auto");
    observerCallback([{ addedNodes: [container] }]);
    assert.equal(nestedInput.style.pointerEvents, "auto");

    global.document.querySelectorAll = originalQuerySelectorAll;
    global.MutationObserver = previousMutationObserver;

    setupState.savedOnboardingMode = "power";
    setupState.mcpServers = [
      { id: "glean", icon: "/glean.svg" },
      { id: "google_workspace", icon: "/google.svg" },
      { id: "mcp-atlassian", icon: "/atlassian.svg" },
      { id: "data-plat-mcp", icon: "/portico.svg" },
    ];
    loaded._test.setAuthenticatedSetupSession({
      user: { preferredUsername: "Taylor Lane" },
    });

    loaded._test.renderHelloStage();
    assert.equal(elements.get("hello-title").textContent, "Hello, Taylor!");
    assert.match(elements.get("hello-basic-logo-strip").innerHTML, /glean\.svg/);
    assert.equal(elements.get("hello-power-option").getAttribute("aria-pressed"), "true");
    assert.equal(elements.get("hello-mode-error").style.display, "none");
    assert.equal(
      loaded._test.createHelloLogoChip({ label: "Custom" }),
      `
    <div class="hello-logo-chip" data-logo-kind="default" data-tooltip="Custom" title="Custom" aria-label="Custom" tabindex="0">
      <span class="hello-logo-chip-fallback">CU</span>
    </div>
  `,
    );
  });
});

test("window auth and hello-mode actions ignore re-entry and goBackToWelcome resets the wizard shell", async () => {
  await withGuidedSetupHarness(async ({ setupState, electronApi, elements }) => {
    let releaseClearError = null;
    let clearCalls = 0;
    let startCalls = 0;
    electronApi.setupAuth.clearError = async () => {
      clearCalls += 1;
      await new Promise((resolve) => {
        releaseClearError = resolve;
      });
    };
    electronApi.setupAuth.start = async () => {
      startCalls += 1;
      return {
        success: true,
        authenticated: true,
        sessionSummary: {
          user: {
            id: "user-123",
            name: "Casey Morgan",
          },
        },
      };
    };

    await withImmediateTimeout(async () => {
      const firstRun = global.window.startSetup();
      await flushMicrotasks();
      await global.window.startSetup();
      releaseClearError();
      await firstRun;
    });

    assert.equal(clearCalls, 1);
    assert.equal(startCalls, 1);

    let resolveSavePreference = null;
    let saveCalls = 0;
    electronApi.saveGuidedSetupModePreference = async () => {
      saveCalls += 1;
      await new Promise((resolve) => {
        resolveSavePreference = resolve;
      });
      return { success: true };
    };

    await withNoopTimeout(async () => {
      const firstSave = global.window.selectHelloMode("power");
      await flushMicrotasks();
      await global.window.selectHelloMode("power");
      await global.window.selectHelloMode("invalid");
      resolveSavePreference();
      await firstSave;
      await flushMicrotasks();
    });

    assert.equal(saveCalls, 1);

    setupState.currentStage = "hello";
    setupState.serverSelectionHydrated = true;
    setupState.onboardingMode = "power";
    elements.get("welcome-error").style.display = "block";
    await withNoopTimeout(async () => {
      global.window.goBackToWelcome();
      await flushMicrotasks();
    });

    assert.equal(setupState.currentStage, "welcome");
    assert.equal(setupState.serverSelectionHydrated, false);
    assert.equal(setupState.onboardingMode, null);
    assert.equal(elements.get("welcome-error").style.display, "none");
  });
});

test("window.startSetup surfaces missing authenticated user claims from an otherwise successful auth response", async () => {
  await withGuidedSetupHarness(async ({
    setupState,
    electronApi,
    saveEnvVarCalls,
    elements,
  }) => {
    electronApi.setupAuth.start = async () => ({
      success: true,
      authenticated: true,
      sessionSummary: {
        user: {
          id: "user-123",
        },
      },
    });

    await withImmediateTimeout(async () => {
      await global.window.startSetup();
    });

    assert.equal(setupState.currentStage, "welcome");
    assert.deepEqual(saveEnvVarCalls, []);
    assert.equal(setupState.envVars.PORTICO_USER_ID, undefined);
    assert.equal(elements.get("welcome-start-button").getAttribute("aria-busy"), "false");
    assert.equal(
      elements.get("welcome-error").textContent,
      "The signed-in account is missing required identity information.",
    );
  });
});

test("continueAfterModeSelection converts VPN check exceptions into a blocked vpn-check screen", async () => {
  await withGuidedSetupHarness(async ({
    loaded,
    setupState,
    electronApi,
    loadVpnCalls,
    bootstrapPrereqCalls,
  }) => {
    setupState.onboardingMode = "power";
    setupState.prereqReadiness = { readyForAuth: false };
    electronApi.checkVpnConnectivity = async () => {
      throw new Error("vpn exploded");
    };

    await withNoopTimeout(async () => {
      await loaded._test.continueAfterModeSelection();
      await flushMicrotasks();
    });

    assert.equal(loadVpnCalls.length, 1);
    assert.equal(loadVpnCalls[0][2].initialResult.success, false);
    assert.equal(loadVpnCalls[0][2].initialResult.harbor.error, "vpn exploded");
    assert.equal(loadVpnCalls[0][2].initialResult.cloudsmith.error, "vpn exploded");
    assert.deepEqual(bootstrapPrereqCalls, []);
  });
});

test("window.selectHelloMode restores the previous selection and logs when mode persistence throws", async () => {
  await withGuidedSetupHarness(async ({
    setupState,
    electronApi,
    elements,
    loadPrerequisitesCalls,
    loadVpnCalls,
    bootstrapPrereqCalls,
    loaded,
  }) => {
    setupState.savedOnboardingMode = "basic";
    electronApi.saveGuidedSetupModePreference = async () => {
      throw new Error("disk full");
    };
    loaded._test.setGuidedSetupDebugState({ entries: [] });

    await global.window.selectHelloMode("power");

    assert.equal(setupState.savedOnboardingMode, "basic");
    assert.equal(elements.get("hello-basic-option").getAttribute("aria-pressed"), "true");
    assert.equal(elements.get("hello-power-option").getAttribute("aria-pressed"), "false");
    assert.equal(elements.get("hello-mode-error").textContent, "disk full");
    assert.deepEqual(loadPrerequisitesCalls, []);
    assert.deepEqual(loadVpnCalls, []);
    assert.deepEqual(bootstrapPrereqCalls, []);
    assert.equal(
      loaded._test
        .getGuidedSetupDebugState()
        .entries.some((entry) => /Failed to persist guided setup mode preference: disk full/.test(entry.text)),
      true,
    );
  });
});

test("guided setup loadMcpServerConfigs clears selections and records a debug entry when the manifest load fails cleanly", async () => {
  await withGuidedSetupHarness(async ({ loaded, setupState, electronApi, progressCalls }) => {
    setupState.mcpServers = [{ id: "legacy-selected", name: "Legacy Selected" }];
    setupState.selectedServers = [0];
    loaded._test.setGuidedSetupDebugState({ entries: [] });
    electronApi.loadMcpServers = async () => ({
      success: false,
      error: "bad manifest",
    });

    await loaded._test.loadMcpServerConfigs();
    global.window.updateProgressTracker();

    assert.deepEqual(setupState.mcpServers, []);
    assert.deepEqual(setupState.selectedServers, []);
    assert.equal(progressCalls.length > 0, true);
    assert.equal(
      loaded._test
        .getGuidedSetupDebugState()
        .entries.some((entry) => /Failed to load MCP server configurations/.test(entry.text)),
      true,
    );
  });
});

test("a full setup launch lands on hello and widens the window for side-by-side cards", async () => {
  // Regression guard for the 'full' path: initialize() jumps straight to hello,
  // skipping the welcome screen's startSetup resize. With no hello entry in the
  // stage window table the window stayed at its 740px birth width and the two
  // mode cards collapsed into a stacked, clipped column.
  await withGuidedSetupHarness(async ({ loaded, setupState, electronApi, elements }) => {
    electronApi.getGuidedSetupBootstrapState = async () => ({
      launchContext: {
        source: "required",
        trigger: "init-failure",
        startedAt: 123,
        setupMode: "full",
        setupReason: "setup-not-completed",
      },
      prereqReadiness: {
        readyForAuth: true,
        reason: null,
        missingImages: [],
      },
    });

    await withImmediateTimeout(() => loaded.initialize());

    assert.equal(setupState.currentStage, "hello");
    assert.equal(elements.get("stage-hello").classList.contains("active"), true);
    assert.deepEqual(electronApi.maximizeCalls, [
      { targetWidth: 1180, targetHeight: 820 },
    ]);
  });
});

test("window.startSetup errors in-stage when an otherwise complete sign-in yields no email (PORTICO-414 loop breaker)", async () => {
  await withGuidedSetupHarness(async ({ elements, electronApi, setupState }) => {
    electronApi.setupAuth.start = async () => ({
      success: true,
      authenticated: true,
      sessionSummary: {
        user: { id: "user-123", name: "Sam Rivera", email: null },
      },
    });
    let completionCalls = 0;
    electronApi.electronAppComplete = () => {
      completionCalls += 1;
    };

    await withImmediateTimeout(async () => {
      await global.window.startSetup();
    });

    assert.equal(setupState.currentStage, "welcome", "never leaves the sign-in stage");
    assert.equal(completionCalls, 0, "an email-less sign-in must not complete guided setup");
    assert.equal(
      elements.get("welcome-error").textContent,
      "Sign-in finished, but your account did not provide an email address, which this app requires. Retry login; if it keeps happening, contact support.",
    );
    assert.equal(
      elements.get("welcome-start-button").getAttribute("aria-busy"),
      "false",
    );
  });
});
