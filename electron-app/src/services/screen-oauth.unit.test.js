const test = require("node:test");
const assert = require("node:assert/strict");
const { FakeElement } = require("./test-helpers/fake-dom");

function loadModule() {
  const modulePath = require.resolve(
    "../renderer/screens/guided-setup/screen-oauth",
  );
  delete require.cache[modulePath];
  return require("../renderer/screens/guided-setup/screen-oauth");
}

async function withImmediateTimeout(run) {
  const previousSetTimeout = global.setTimeout;
  global.setTimeout = (handler) => {
    handler();
    return 1;
  };
  try {
    return await run();
  } finally {
    global.setTimeout = previousSetTimeout;
  }
}

async function withNoopTimeout(run) {
  const previousSetTimeout = global.setTimeout;
  global.setTimeout = () => 1;
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

test("dual-requirement OAuth routes through configuration before starting its server", async () => {
  const mod = loadModule();
  const trustKit = {
    id: "trust-kit-mcp",
    display_name: "Trust Kit",
    oauth: { requires_user_authorization: true },
    required_env_vars: [{ name: "waldoapikey", sensitive: true }],
  };
  const setupState = {
    configuredServers: new Set(),
    serverConfigs: [trustKit],
    currentServerIndex: 0,
  };
  const loadedIndexes = [];
  const logs = [];
  const item = {
    server: trustKit,
    metadata: { display_name: "Trust Kit" },
    status: "current",
  };

  const routed = await mod._test.routeToRequiredConfigurationBeforeOAuth(
    item,
    setupState,
    {
      async loadServerConfiguration(index) {
        loadedIndexes.push(index);
      },
      addLog(message, level) {
        logs.push({ message, level });
      },
    },
  );

  assert.equal(routed, true);
  assert.equal(setupState.pendingOAuthConfigurationServerId, "trust-kit-mcp");
  assert.deepEqual(loadedIndexes, [0]);
  assert.deepEqual(logs, [
    { message: "Configure Trust Kit before authorization", level: "info" },
  ]);
});

test("dual-requirement OAuth does not reroute after configuration is saved", async () => {
  const mod = loadModule();
  const trustKit = {
    id: "trust-kit-mcp",
    oauth: { requires_user_authorization: true },
    required_env_vars: [{ name: "waldoapikey", sensitive: true }],
  };

  const routed = await mod._test.routeToRequiredConfigurationBeforeOAuth(
    { server: trustKit, metadata: { display_name: "Trust Kit" } },
    {
      configuredServers: new Set(["trust-kit-mcp"]),
      serverConfigs: [trustKit],
    },
    {
      async loadServerConfiguration() {
        assert.fail("configured server must not return to configuration");
      },
    },
  );

  assert.equal(routed, false);
});

function createPreviewCard(index) {
  const card = new FakeElement(`preview-card-${index}`);
  const iconContainer = new FakeElement(`preview-icon-${index}`);
  let badge = null;

  iconContainer.querySelector = (selector) => {
    if (selector === ".oauth-preview-status-badge") {
      return badge;
    }
    return null;
  };
  iconContainer.insertAdjacentHTML = (_position, html) => {
    badge = {
      html,
      remove() {
        badge = null;
      },
    };
    iconContainer.lastBadgeHtml = html;
  };

  card.querySelector = (selector) => {
    if (selector === ".oauth-preview-icon-container") {
      return iconContainer;
    }
    return null;
  };
  card.iconContainer = iconContainer;
  return card;
}

function withOauthDom(run, options = {}) {
  const previousDocument = global.document;
  const previousWindow = global.window;

  function initializeElement(element) {
    if (typeof element.querySelector !== "function") {
      element.querySelector = () => null;
    }
    if (typeof element.querySelectorAll !== "function") {
      element.querySelectorAll = () => [];
    }
    return element;
  }

  const stage = new FakeElement("stage-oauth");
  if (options.activeStage !== false) {
    stage.classList.add("active");
  }

  const elements = {
    "stage-oauth": stage,
    "oauth-stage-content": new FakeElement("oauth-stage-content"),
    "oauth-stage-preview": new FakeElement("oauth-stage-preview"),
    "oauth-stage-server-icon": new FakeElement("oauth-stage-server-icon"),
    "oauth-stage-server-name": new FakeElement("oauth-stage-server-name"),
    "oauth-stage-server-description": new FakeElement("oauth-stage-server-description"),
    "oauth-stage-progress-text": new FakeElement("oauth-stage-progress-text"),
    "oauth-stage-status-text": new FakeElement("oauth-stage-status-text"),
    "oauth-stage-next-btn": new FakeElement("oauth-stage-next-btn"),
    "oauth-stage-skip-all-btn": new FakeElement("oauth-stage-skip-all-btn"),
    "oauth-stage-authorize-btn": new FakeElement("oauth-stage-authorize-btn"),
    "oauth-stage-buttons": new FakeElement("oauth-stage-buttons"),
    "oauth-stage-testing": new FakeElement("oauth-stage-testing"),
    "oauth-stage-testing-content": new FakeElement("oauth-stage-testing-content"),
    "oauth-readiness-back-btn": new FakeElement("oauth-readiness-back-btn"),
  };
  const progressSection = new FakeElement("oauth-stage-progress");
  const oauthTestSteps = [];
  const cards = Array.from({ length: options.previewCardCount || 3 }, (_, index) =>
    createPreviewCard(index),
  );

  Object.values(elements).forEach(initializeElement);

  ["oauth-stage-content", "oauth-stage-testing-content"].forEach((id) => {
    Object.defineProperty(elements[id], "innerHTML", {
      get() {
        return this._innerHTML || "";
      },
      set(value) {
        this._innerHTML = value;
        const pattern = /id="([^"]+)"/g;
        let match = null;
        while ((match = pattern.exec(value))) {
          if (!elements[match[1]]) {
            elements[match[1]] = initializeElement(new FakeElement(match[1]));
          }
          if (match[1] === "copy-logs-btn") {
            const copyLabel = new FakeElement("copy-logs-label");
            copyLabel.textContent = "Copy";
            elements[match[1]].querySelector = (selector) => {
              if (selector === "span") {
                return copyLabel;
              }
              return null;
            };
          }
        }

        if (id === "oauth-stage-testing-content") {
          oauthTestSteps.length = 0;
          const stepPattern = /data-step="([^"]+)"/g;
          let stepMatch = null;
          while ((stepMatch = stepPattern.exec(value))) {
            const step = new FakeElement(`oauth-test-step-${stepMatch[1]}`);
            step.dataset.step = stepMatch[1];
            const icon = new FakeElement(`oauth-test-icon-${stepMatch[1]}`);
            const detail = new FakeElement(`oauth-test-detail-${stepMatch[1]}`);
            step.querySelector = (selector) => {
              if (selector === ".oauth-test-icon") return icon;
              if (selector === ".oauth-test-detail") return detail;
              return null;
            };
            step.icon = icon;
            step.detail = detail;
            oauthTestSteps.push(step);
          }
        }
      },
      configurable: true,
    });
  });

  elements["oauth-stage-testing-content"].querySelector = (selector) => {
    if (
      selector === ".oauth-test-steps" &&
      /class="oauth-test-steps"/.test(elements["oauth-stage-testing-content"].innerHTML)
    ) {
      return { outerHTML: '<div class="oauth-test-steps"></div>' };
    }
    return null;
  };

  elements["oauth-stage-preview"].querySelectorAll = (selector) => {
    if (selector === ".oauth-stage-preview-card") {
      return cards;
    }
    return [];
  };

  global.document = {
    getElementById(id) {
      return elements[id] || null;
    },
    querySelector(selector) {
      if (selector === ".oauth-stage-progress") {
        return progressSection;
      }
      const stepMatch = selector.match(/^\.oauth-test-step\[data-step="([^"]+)"\]$/);
      if (stepMatch) {
        return oauthTestSteps.find((step) => step.dataset.step === stepMatch[1]) || null;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === ".oauth-stage-preview-card") {
        return cards;
      }
      if (selector === ".oauth-test-step") {
        return oauthTestSteps;
      }
      return [];
    },
    createElement() {
      return initializeElement(new FakeElement());
    },
  };

  global.window = options.window || {};

  let result;
  try {
    result = run({
      elements,
      cards,
      progressSection,
    });
  } finally {
    if (!result || typeof result.then !== "function") {
      global.document = previousDocument;
      global.window = previousWindow;
    }
  }

  if (!result || typeof result.then !== "function") {
    return result;
  }

  return result.finally(() => {
    global.document = previousDocument;
    global.window = previousWindow;
  });
}

test("analyzeOAuthServers sorts by guided priority and marks preconfigured servers", async () => {
  const previousWindow = global.window;
  global.window = {
    electronAPI: {
      async checkOAuthTokensExist(serverId) {
        return { exists: serverId === "google_workspace" };
      },
    },
  };

  try {
    const mod = loadModule();
    const result = await mod.analyzeOAuthServers([
      { id: "custom-oauth", display_name: "Custom OAuth" },
      { id: "mcp-atlassian", display_name: "Atlassian" },
      { id: "google_workspace", display_name: "Google Workspace" },
      { id: "glean", display_name: "Glean" },
    ]);

    assert.deepEqual(
      result.servers.map((server) => server.id),
      ["glean", "google_workspace", "mcp-atlassian", "custom-oauth"],
    );
    assert.deepEqual(result.completedServerIds, ["google_workspace"]);
    assert.equal(result.completedCount, 1);
    assert.equal(result.pendingCount, 3);
    assert.equal(
      result.items.find((item) => item.server.id === "google_workspace")
        .preConfigured,
      true,
    );
  } finally {
    global.window = previousWindow;
  }
});

test("loadOAuthScreen skips the readiness gate entirely when all selected servers are already authorized", async () => {
  const previousWindow = global.window;
  global.window = {
    electronAPI: {
      async checkOAuthTokensExist() {
        return { exists: true };
      },
      async prerequisitesCheckAuthorizeReadiness() {
        throw new Error("readiness should not be called when nothing is pending");
      },
    },
  };

  try {
    const mod = loadModule();
    const setupState = {
      oauthServers: [{ id: "glean", display_name: "Glean" }],
      serverConfigs: [],
      completedSteps: {
        prerequisites: false,
        prerequisitesWarning: true,
        oauth: false,
      },
      completedOAuthServers: new Set(),
    };
    let progressUpdates = 0;
    const shownStages = [];
    let finalized = 0;

    await withImmediateTimeout(async () => {
      await mod.loadOAuthScreen(setupState, {
        updateProgressTracker() {
          progressUpdates += 1;
        },
        showStage(stage) {
          shownStages.push(stage);
        },
        finalizeSetup() {
          finalized += 1;
        },
      });
    });

    assert.equal(setupState.completedSteps.prerequisites, true);
    assert.equal(setupState.completedSteps.prerequisitesWarning, false);
    assert.equal(setupState.oauthStepRequired, false);
    assert.equal(setupState.completedSteps.oauth, true);
    assert.equal(setupState.completedOAuthServers.has("glean"), true);
    assert.equal(progressUpdates, 1);
    assert.deepEqual(shownStages, ["finalize"]);
    assert.equal(finalized, 1);
  } finally {
    global.window = previousWindow;
  }
});

test("loadOAuthScreen schedules the pending authorization after prerequisite configuration", async () => {
  await withOauthDom(async () => {
    global.window = {
      electronAPI: {
        async checkOAuthTokensExist() {
          return { exists: false };
        },
        async prerequisitesCheckAuthorizeReadiness() {
          return { success: true, ready: true };
        },
      },
    };

    const mod = loadModule();
    const setupState = {
      oauthServers: [{ id: "trust-kit-mcp", display_name: "Trust Kit" }],
      serverConfigs: [],
      completedSteps: {
        prerequisites: false,
        prerequisitesWarning: true,
        oauth: false,
      },
      completedOAuthServers: new Set(),
      connectedOAuthServers: new Set(),
      skippedOAuthServers: new Set(),
    };

    await withNoopTimeout(() =>
      mod.loadOAuthScreen(setupState, {}, { autoStartPending: true }),
    );

    assert.equal(mod._test.getOauthScreenState().pendingAutoStartIndex, 0);
  });
});

test("loadOAuthScreen keeps manual Connect revisits on the Connect stage with the full completed Connect layout", async () => {
  const previousWindow = global.window;

  try {
    await withOauthDom(async ({ elements, cards }) => {
      global.window = {
        electronAPI: {
          async checkOAuthTokensExist(serverId) {
            return { exists: serverId === "glean" || serverId === "google_workspace" };
          },
          async prerequisitesCheckAuthorizeReadiness() {
            throw new Error("readiness should not be called when nothing is pending");
          },
        },
      };

      const mod = loadModule();
      const setupState = {
        oauthServers: [
          { id: "glean", display_name: "Glean", description: "Search company knowledge" },
          { id: "google_workspace", display_name: "Google Workspace", description: "Access docs" },
        ],
        serverConfigs: [{ id: "sourcegraph" }],
        completedSteps: {
          prerequisites: false,
          prerequisitesWarning: true,
          oauth: false,
        },
        completedOAuthServers: new Set(),
        connectedOAuthServers: new Set(["glean", "google_workspace"]),
        skippedOAuthServers: new Set(["glean"]),
        currentOAuthIndex: 1,
      };
      const shownStages = [];
      let finalized = 0;

      await mod.loadOAuthScreen(
        setupState,
        {
          showStage(stage) {
            shownStages.push(stage);
          },
          finalizeSetup() {
            finalized += 1;
          },
        },
        { suppressAutoAdvance: true },
      );

      assert.equal(setupState.completedSteps.oauth, true);
      assert.equal(setupState.oauthStepRequired, false);
      assert.equal(setupState.skippedOAuthServers.has("glean"), false);
      assert.equal(elements["oauth-stage-server-name"].textContent, "Google Workspace");
      assert.equal(elements["oauth-stage-server-description"].textContent, "Access docs");
      assert.equal(elements["oauth-stage-progress-text"].textContent, "Server 2 of 2");
      assert.match(elements["oauth-stage-testing-content"].innerHTML, /Continue →/);
      assert.doesNotMatch(elements["oauth-stage-testing-content"].innerHTML, /Skip All/);
      assert.doesNotMatch(elements["oauth-stage-content"].innerHTML, /All OAuth servers authorized\./);

      await cards[0].click();
      assert.equal(elements["oauth-stage-server-name"].textContent, "Glean");
      assert.equal(setupState.currentOAuthIndex, 0);

      assert.deepEqual(shownStages, []);
      assert.equal(finalized, 0);
    });
  } finally {
    global.window = previousWindow;
  }
});

test("renderCompletedOauthRevisitScreen restores the last completed OAuth server and continues to configuration", async () => {
  const mod = loadModule();
  const setupState = {
    currentOAuthIndex: 99,
    connectedOAuthServers: new Set(["glean", "google_workspace"]),
    completedOAuthServers: new Set(["glean", "google_workspace"]),
    skippedOAuthServers: new Set(),
    serverConfigs: [{ id: "sourcegraph" }],
    completedSteps: { oauth: true },
  };
  const loadConfigurationCalls = [];

  await withOauthDom(async ({ elements }) => {
    mod._test.renderCompletedOauthRevisitScreen(
      setupState,
      {
        async loadServerConfiguration(index) {
          loadConfigurationCalls.push(index);
        },
        findNextPendingConfigurationIndex() {
          return 0;
        },
      },
      {
        items: [
          {
            server: { id: "glean" },
            metadata: { id: "glean", display_name: "Glean", description: "Company knowledge" },
            status: "done",
            preConfigured: false,
            postAuthSyncState: "ready",
            postAuthToolCount: 4,
          },
          {
            server: { id: "google_workspace" },
            metadata: { id: "google_workspace", display_name: "Google Workspace", description: "Workspace docs" },
            status: "done",
            preConfigured: false,
            postAuthSyncState: "ready",
            postAuthToolCount: 8,
          },
        ],
        completedCount: 2,
      },
    );

    assert.equal(elements["oauth-stage-server-name"].textContent, "Google Workspace");
    assert.equal(elements["oauth-stage-server-description"].textContent, "Workspace docs");
    assert.equal(setupState.currentOAuthIndex, 1);
    assert.match(elements["oauth-stage-testing-content"].innerHTML, /Continue →/);

    await elements["oauth-test-next-btn"].onclick();
    assert.deepEqual(loadConfigurationCalls, [0]);
  });
});

test("initOAuthScreen returns skipped and routes onward when analysis says every OAuth server is already done", async () => {
  const mod = loadModule();
  const setupState = {
    oauthServers: [{ id: "glean", display_name: "Glean" }],
    serverConfigs: [],
    completedSteps: { oauth: false },
    completedOAuthServers: new Set(),
  };
  let progressUpdates = 0;
  const shownStages = [];
  let finalized = 0;

  const result = await withImmediateTimeout(async () =>
    mod.initOAuthScreen(
      setupState,
      {
        updateProgressTracker() {
          progressUpdates += 1;
        },
        showStage(stage) {
          shownStages.push(stage);
        },
        finalizeSetup() {
          finalized += 1;
        },
      },
      {
        analysis: {
          servers: setupState.oauthServers,
          items: [
            {
              server: setupState.oauthServers[0],
              status: "done",
              preConfigured: true,
              metadata: { display_name: "Glean" },
            },
          ],
          completedServerIds: ["glean"],
          completedCount: 1,
          pendingCount: 0,
        },
      },
    ),
  );

  assert.deepEqual(result, { skipped: true });
  assert.equal(setupState.oauthStepRequired, false);
  assert.equal(setupState.completedSteps.oauth, true);
  assert.equal(setupState.completedOAuthServers.has("glean"), true);
  assert.equal(progressUpdates, 1);
  assert.deepEqual(shownStages, ["finalize"]);
  assert.equal(finalized, 1);
});

test("markCurrentAsDoneNoRestart clears a previously skipped server once it is connected", async () => {
  await withOauthDom(async () => {
    const mod = loadModule();
    const setupState = {
      completedOAuthServers: new Set(),
      connectedOAuthServers: new Set(),
      skippedOAuthServers: new Set(["glean"]),
    };

    mod._test.setOauthScreenState({
      servers: [
        {
          server: { id: "glean" },
          metadata: { id: "glean", display_name: "Glean", name: "Glean" },
          status: "current",
          preConfigured: false,
          postAuthSyncState: "idle",
          postAuthToolCount: 0,
        },
        {
          server: { id: "google_workspace" },
          metadata: {
            id: "google_workspace",
            display_name: "Google Workspace",
            name: "Google Workspace",
          },
          status: "pending",
          preConfigured: false,
          postAuthSyncState: "idle",
          postAuthToolCount: 0,
        },
      ],
      currentIndex: 0,
      completedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      setupState,
      callbacks: {},
      queueStarted: false,
      flowLocked: false,
      pendingAutoStartIndex: null,
    });

    await mod._test.markCurrentAsDoneNoRestart(setupState, {});

    assert.equal(setupState.completedOAuthServers.has("glean"), true);
    assert.equal(setupState.connectedOAuthServers.has("glean"), true);
    assert.equal(setupState.skippedOAuthServers.has("glean"), false);
  });
});

test("initOAuthScreen renders a no-servers CTA that continues directly onward", async () => {
  const mod = loadModule();
  const setupState = {
    oauthServers: [],
    serverConfigs: [],
    completedSteps: { oauth: false },
    completedOAuthServers: new Set(),
  };
  const shownStages = [];
  let finalized = 0;

  await withOauthDom(async ({ elements }) => {
    const result = await mod.initOAuthScreen(setupState, {
      showStage(stage) {
        shownStages.push(stage);
      },
      finalizeSetup() {
        finalized += 1;
      },
    });

    assert.equal(result, undefined);
    assert.equal(setupState.completedSteps.oauth, true);
    assert.match(elements["oauth-stage-content"].innerHTML, /No OAuth Servers Selected/);
    await withImmediateTimeout(async () => {
      elements["oauth-continue-btn"].onclick();
    });
  });

  assert.deepEqual(shownStages, ["finalize"]);
  assert.equal(finalized, 1);
});

test("initOAuthScreen starts on the first pending server after preconfigured oauth entries", async () => {
  const previousWindow = global.window;
  global.window = {
    electronAPI: {
      async checkOAuthTokensExist(serverId) {
        return { exists: serverId === "google_workspace" };
      },
    },
  };

  try {
    const mod = loadModule();
    const setupState = {
      oauthServers: [
        { id: "google_workspace", display_name: "Google Workspace", icon: "google.svg" },
        { id: "custom-oauth", display_name: "Custom OAuth", description: "Authorize me" },
      ],
      completedSteps: { oauth: false },
      completedOAuthServers: new Set(),
    };

    await withOauthDom(async ({ elements }) => {
      const result = await mod.initOAuthScreen(setupState, {});

      assert.deepEqual(result, { skipped: false });
      assert.equal(mod._test.getOauthScreenState().currentIndex, 1);
      assert.equal(mod._test.getOauthScreenState().servers[0].status, "done");
      assert.equal(mod._test.getOauthScreenState().servers[0].preConfigured, true);
      assert.equal(mod._test.getOauthScreenState().servers[1].status, "current");
      assert.equal(elements["oauth-stage-server-name"].textContent, "Custom OAuth");
      assert.equal(elements["oauth-stage-progress-text"].textContent, "Server 2 of 2");
    }, { window: global.window });
  } finally {
    global.window = previousWindow;
  }
});

test("proceedAfterOAuth opens configuration for a dual-requirement server with missing values", async () => {
  const mod = loadModule();
  const { getNextPendingConfigurationIndex } = require(
    "../renderer/screens/guided-setup/screen-configuration",
  );
  const setupState = {
    serverConfigs: [{ id: "hybrid-mcp" }],
    configuredServers: new Set(),
    skippedServers: new Set(),
    currentServerIndex: 99,
  };
  const loadedConfigs = [];

  await mod.proceedAfterOAuth(setupState, {
    findNextPendingConfigurationIndex(startIndex) {
      return getNextPendingConfigurationIndex(setupState, startIndex);
    },
    async loadServerConfiguration(index) {
      loadedConfigs.push(index);
    },
  });

  assert.equal(setupState.currentServerIndex, 0);
  assert.deepEqual(loadedConfigs, [0]);
});

test("proceedAfterOAuth skips configuration when a dual-requirement server already has its values", async () => {
  const mod = loadModule();
  const { getNextPendingConfigurationIndex } = require(
    "../renderer/screens/guided-setup/screen-configuration",
  );
  const setupState = {
    serverConfigs: [{ id: "hybrid-mcp" }],
    configuredServers: new Set(["hybrid-mcp"]),
    skippedServers: new Set(),
    currentServerIndex: 99,
  };
  const shownStages = [];
  let finalized = 0;

  await withImmediateTimeout(async () => {
    await mod.proceedAfterOAuth(setupState, {
      findNextPendingConfigurationIndex(startIndex) {
        return getNextPendingConfigurationIndex(setupState, startIndex);
      },
      showStage(stage) {
        shownStages.push(stage);
      },
      finalizeSetup() {
        finalized += 1;
      },
    });
  });

  assert.deepEqual(shownStages, ["finalize"]);
  assert.equal(finalized, 1);
});

test("oauth helper utilities handle callback restart loops and auth URL extraction", async () => {
  const previousWindow = global.window;
  let pollCalls = 0;
  const tokenChecks = [{ exists: false }, { exists: false }, { exists: true }];
  global.window = {
    electronAPI: {
      async pollOAuthCompletionSingle() {
        pollCalls += 1;
        if (pollCalls === 1) {
          return { timeout: true };
        }
        return { completed: true };
      },
      async checkOAuthTokensExist() {
        return tokenChecks.shift() || { exists: true };
      },
    },
  };

  try {
    const mod = loadModule();
    const restarted = await mod._test.pollOAuthCompletionWithManualRestart(
      "glean",
      {
        timeoutMs: 50,
        chunkTimeoutMs: 5,
        shouldRestart: () => pollCalls === 1,
      },
    );
    assert.deepEqual(restarted, { restartRequested: true });

    const skipped = await mod._test.pollOAuthCompletionWithManualRestart(
      "glean",
      {
        timeoutMs: 50,
        chunkTimeoutMs: 5,
        getManualAction: () => "skip",
      },
    );
    assert.deepEqual(skipped, { skipRequested: true });

    const completed = await mod._test.pollOAuthCompletionWithManualRestart(
      "glean",
      {
        timeoutMs: 50,
        chunkTimeoutMs: 5,
      },
    );
    assert.equal(completed.completed, true);

    const persisted = await mod._test.waitForOAuthTokensPersisted("glean", {
      timeoutMs: 500,
      pollIntervalMs: 1,
      checkOAuthTokensExist: global.window.electronAPI.checkOAuthTokensExist,
    });
    assert.equal(persisted.persisted, true);

    assert.equal(
      mod._test.extractAuthUrlFromStatus(
        {
          waiting_callback: [
            {
              server_name: "glean",
              authorization_url: "https://example.test/auth",
            },
          ],
        },
        "glean",
      ),
      "https://example.test/auth",
    );
    assert.equal(
      mod._test.getStatusMessage({
        status: "done",
        preConfigured: false,
        postAuthSyncState: "ready",
        postAuthToolCount: 12,
      }),
      "Authorization complete · 12 tools ready",
    );
  } finally {
    global.window = previousWindow;
  }
});

test("guided setup callback polling waits while persisted tokens are being validated", async () => {
  const previousWindow = global.window;
  let pollCalls = 0;
  const progressStates = [];
  global.window = {
    electronAPI: {
      async pollOAuthCompletionSingle() {
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
      },
    },
  };

  try {
    const mod = loadModule();
    const result = await mod._test.pollOAuthCompletionWithManualRestart(
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
  } finally {
    global.window = previousWindow;
  }
});

test("guided setup keeps a legitimate OAuth consent flow alive past five minutes", async () => {
  const previousWindow = global.window;
  const previousNow = Date.now;
  let now = 0;
  let pollCalls = 0;
  let actionChecks = 0;

  global.window = {
    electronAPI: {
      async pollOAuthCompletionSingle() {
        pollCalls += 1;
        now = 5 * 60 * 1000 + 1;
        return { success: false, timeout: true };
      },
    },
  };
  Date.now = () => now;

  try {
    const mod = loadModule();
    assert.equal(mod._test.guidedSetupOAuthFlowTimeoutMs, null);

    const result = await mod._test.pollOAuthCompletionWithManualRestart(
      "data-plat-mcp",
      {
        chunkTimeoutMs: 2000,
        getManualAction() {
          actionChecks += 1;
          return actionChecks >= 3 ? "skip" : "none";
        },
      },
    );

    assert.equal(pollCalls, 1);
    assert.deepEqual(result, { skipRequested: true });
  } finally {
    Date.now = previousNow;
    global.window = previousWindow;
  }
});

test("oauth _test helpers normalize metadata and sync completed server ids", () => {
  const mod = loadModule();
  const server = {
    id: "data-plat-mcp",
    name: "Portico Data Platform",
    display_name: "Portico Data Platform",
    description: "Search data",
  };

  assert.equal(mod._test.getOauthDisplayName(server), "Portico Data Platform");
  assert.deepEqual(
    mod._test.sortOauthServers([
      { id: "custom", display_name: "Custom OAuth" },
      { id: "mcp-atlassian", display_name: "Atlassian" },
      { id: "glean", display_name: "Glean" },
    ]).map((item) => item.id),
    ["glean", "mcp-atlassian", "custom"],
  );
  assert.deepEqual(mod._test.createOauthScreenItem(server), {
    server,
    metadata: {
      id: "data-plat-mcp",
      name: "Portico Data Platform",
      display_name: "Portico Data Platform",
      description: "Search data",
      icon: undefined,
      logoKind: null,
    },
    status: "pending",
    preConfigured: false,
    postAuthSyncState: "idle",
    postAuthToolCount: 0,
    postAuthSyncError: null,
  });
});

test("initOAuthScreen renders the pending oauth queue and supports preview-card navigation", async () => {
  const mod = loadModule();
  const setupState = {
    oauthServers: [{ id: "glean" }, { id: "sourcegraph" }],
    completedSteps: { oauth: false },
    completedOAuthServers: new Set(),
  };

  await withOauthDom(async ({ elements, cards }) => {
    const result = await mod.initOAuthScreen(
      setupState,
      {},
      {
        analysis: {
          servers: setupState.oauthServers,
          items: [
            {
              server: { id: "glean" },
              metadata: {
                id: "glean",
                name: "Glean",
                display_name: "Glean",
                description: "Already authorized",
                icon: "glean.svg",
              },
              status: "done",
              preConfigured: true,
              postAuthSyncState: "idle",
              postAuthToolCount: 0,
            },
            {
              server: { id: "sourcegraph" },
              metadata: {
                id: "sourcegraph",
                name: "Sourcegraph",
                display_name: "Sourcegraph",
                description: "Authorize Sourcegraph",
                icon: "sourcegraph.svg",
              },
              status: "pending",
              preConfigured: false,
              postAuthSyncState: "idle",
              postAuthToolCount: 0,
            },
          ],
          completedServerIds: ["glean"],
          completedCount: 1,
          pendingCount: 1,
        },
      },
    );

    assert.deepEqual(result, { skipped: false });
    assert.equal(setupState.oauthStepRequired, true);
    assert.equal(mod._test.getOauthScreenState().currentIndex, 1);
    assert.equal(mod._test.getOauthScreenState().servers[1].status, "current");
    assert.equal(elements["oauth-stage-server-name"].textContent, "Sourcegraph");
    assert.equal(
      elements["oauth-stage-progress-text"].textContent,
      "Server 2 of 2",
    );
    assert.equal(cards[1].className, "oauth-stage-preview-card current");

    await cards[0].click();
    assert.equal(mod._test.getOauthScreenState().currentIndex, 0);
    assert.equal(elements["oauth-stage-authorize-btn"].style.display, "none");
    assert.equal(elements["oauth-stage-testing"].style.display, "block");
    assert.match(
      elements["oauth-stage-testing-content"].innerHTML,
      /(Connected|Authorized)/,
    );
  });
});

test("skipCurrentServer and skipAllRemainingServers advance and complete the oauth queue", async () => {
  const mod = loadModule();
  const setupState = {
    skippedOAuthServers: new Set(),
    completedSteps: { oauth: false },
    serverConfigs: [],
  };
  const logs = [];
  const shownStages = [];
  let finalized = 0;
  let progressUpdates = 0;

  await withOauthDom(async () => {
    mod._test.setOauthScreenState({
      servers: [
        {
          server: { id: "glean" },
          metadata: { display_name: "Glean" },
          status: "current",
        },
        {
          server: { id: "google_workspace" },
          metadata: { display_name: "Google Workspace" },
          status: "pending",
        },
        {
          server: { id: "mcp-atlassian" },
          metadata: { display_name: "Atlassian" },
          status: "pending",
        },
      ],
      currentIndex: 0,
      skippedCount: 0,
      completedCount: 0,
      failedCount: 0,
      setupState,
      callbacks: {
        addLog(message, level) {
          logs.push({ message, level });
        },
      },
    });

    mod.skipCurrentServer(setupState, {
      addLog(message, level) {
        logs.push({ message, level });
      },
    });

    assert.equal(mod._test.getOauthScreenState().currentIndex, 1);
    assert.equal(mod._test.getOauthScreenState().servers[0].status, "skipped");
    assert.equal(mod._test.getOauthScreenState().servers[1].status, "current");

    await withImmediateTimeout(async () => {
      mod.skipAllRemainingServers(setupState, {
        addLog(message, level) {
          logs.push({ message, level });
        },
        updateProgressTracker() {
          progressUpdates += 1;
        },
        showStage(stage) {
          shownStages.push(stage);
        },
        finalizeSetup() {
          finalized += 1;
        },
      });
    });
  });

  assert.equal(setupState.completedSteps.oauth, true);
  assert.equal(setupState.skippedOAuthServers.size, 3);
  assert.equal(progressUpdates, 1);
  assert.deepEqual(shownStages, ["finalize"]);
  assert.equal(finalized, 1);
  assert.deepEqual(logs, [
    { message: "Skipped OAuth for Glean", level: "info" },
    { message: "Skipped all remaining OAuth authorizations", level: "info" },
  ]);
});

test("loadOAuthScreen renders readiness errors and wires the prereq back button when authorize setup is blocked", async () => {
  const previousWindow = global.window;
  const navigatedSteps = [];

  try {
    await withOauthDom(async ({ elements }) => {
      global.window = {
        electronAPI: {
          async checkOAuthTokensExist() {
            return { exists: false };
          },
          async prerequisitesCheckAuthorizeReadiness() {
            return { success: false, error: "Docker is still pulling" };
          },
        },
        navigateToStep(step) {
          navigatedSteps.push(step);
        },
      };

      const mod = loadModule();
      const setupState = {
        oauthServers: [{ id: "glean", display_name: "Glean" }],
        completedSteps: {
          prerequisites: false,
          prerequisitesWarning: true,
          oauth: false,
        },
        completedOAuthServers: new Set(),
      };

      let progressUpdates = 0;
      await mod.loadOAuthScreen(setupState, {
        updateProgressTracker() {
          progressUpdates += 1;
        },
      });

      assert.equal(progressUpdates, 1);
      assert.equal(setupState.completedSteps.prerequisites, true);
      assert.match(elements["oauth-stage-content"].innerHTML, /Go to Prereqs/);
      elements["oauth-readiness-back-btn"].onclick();
      assert.deepEqual(navigatedSteps, ["prerequisites"]);
    });
  } finally {
    global.window = previousWindow;
  }
});

test("oauth helper exports derive completion copy, status icons, and pending navigation targets", async () => {
  await withOauthDom(async ({ elements }) => {
    const mod = loadModule();
    const setupState = {
      serverConfigs: [],
      completedSteps: { oauth: false },
    };

    mod._test.setOauthScreenState({
      servers: [
        {
          server: { id: "glean" },
          metadata: { id: "glean", display_name: "Glean", name: "Glean" },
          status: "done",
          preConfigured: false,
          postAuthSyncState: "ready",
          postAuthToolCount: 4,
        },
        {
          server: { id: "google_workspace" },
          metadata: { id: "google_workspace", display_name: "Google Workspace", name: "Google Workspace" },
          status: "pending",
          preConfigured: false,
        },
        {
          server: { id: "custom-oauth" },
          metadata: { id: "custom-oauth", display_name: "Custom OAuth", name: "Custom OAuth" },
          status: "pending",
          preConfigured: false,
        },
      ],
      currentIndex: 0,
      setupState,
      callbacks: {},
      queueStarted: false,
      flowLocked: false,
    });

    assert.equal(
      mod._test.getCompletionDetail(mod._test.getOauthScreenState().servers[0]),
      "4 tools are ready to use.",
    );
    assert.equal(mod._test.getStatusIcon("starting"), "⏳");
    assert.equal(mod._test.getOAuthLogoKind({ id: "data-plat-mcp" }), "portico");
    assert.equal(mod._test.isOauthItemProcessing({ status: "waiting" }), true);
    assert.deepEqual(mod._test.getRemainingPendingIndices(0), [1, 2]);
    assert.equal(mod._test.findNextPendingServer(0, { wrap: false }), 1);
    assert.equal(mod._test.shouldAutoAdvanceAfterSuccess(), true);

    mod._test.setOauthScreenState({
      currentIndex: 1,
      queueStarted: false,
      flowLocked: false,
      servers: [
        {
          server: { id: "glean" },
          metadata: { id: "glean", display_name: "Glean", name: "Glean" },
          status: "done",
          preConfigured: false,
        },
        {
          server: { id: "google_workspace" },
          metadata: { id: "google_workspace", display_name: "Google Workspace", name: "Google Workspace" },
          status: "current",
          preConfigured: false,
        },
        {
          server: { id: "custom-oauth" },
          metadata: { id: "custom-oauth", display_name: "Custom OAuth", name: "Custom OAuth" },
          status: "pending",
          preConfigured: false,
        },
      ],
    });
    mod._test.renderOAuthStage();
    mod._test.updateNavigationButtons();
    assert.equal(elements["oauth-stage-authorize-btn"].textContent, "Connect");
    assert.equal(elements["oauth-stage-next-btn"].textContent, "Skip");
    assert.equal(elements["oauth-stage-skip-all-btn"].textContent, "Skip All");
    assert.equal(elements["oauth-stage-next-btn"].style.display, "inline-flex");
    assert.equal(elements["oauth-stage-skip-all-btn"].style.display, "inline-flex");
    assert.match(
      elements["oauth-stage-content"].innerHTML,
      /id="oauth-stage-next-btn"[\s\S]*data-tooltip="You can always connect more integrations later\."[\s\S]*>Skip<\/button>/,
    );
    assert.match(
      elements["oauth-stage-content"].innerHTML,
      /id="oauth-stage-skip-all-btn"[\s\S]*data-tooltip="You can always connect more integrations later\."[\s\S]*>Skip All<\/button>/,
    );
  });
});

test("oauth readiness helpers render status cards and poll until the authorize environment is ready", async () => {
  let readinessCalls = 0;
  await withOauthDom(
    async ({ elements }) => {
      const mod = loadModule();

      mod._test.renderOAuthReadinessState({
        title: "Preparing authorization environment...",
        message: "Almost there.",
        progressPercent: 35,
      });
      assert.match(elements["oauth-stage-content"].innerHTML, /35% ready/);

      const ready = await withImmediateTimeout(async () =>
        mod._test.waitForAuthorizeReadiness(),
      );

      assert.equal(ready, true);
      assert.equal(readinessCalls, 2);

      mod._test.renderOAuthReadinessState({
        title: "Authorization setup is blocked.",
        error: "Need Docker",
      });
      assert.match(elements["oauth-stage-content"].innerHTML, /Need Docker/);
    },
    {
      window: {
        electronAPI: {
          async prerequisitesCheckAuthorizeReadiness() {
            readinessCalls += 1;
            if (readinessCalls === 1) {
              return { success: true, ready: false, progressPercent: 42 };
            }
            return { success: true, ready: true };
          },
        },
      },
    },
  );
});

test("oauth helper exports render all-authorized screens and waiting controls", async () => {
  await withOauthDom(async ({ elements }) => {
    const mod = loadModule();
    const setupState = {
      serverConfigs: [],
      completedSteps: { oauth: false },
    };
    const shownStages = [];
    let finalized = 0;
    let restarted = 0;
    let skipped = 0;

    mod._test.setOauthScreenState({
      servers: [
        {
          server: { id: "glean" },
          metadata: { id: "glean", display_name: "Glean", name: "Glean", icon: "glean.svg" },
          status: "done",
          preConfigured: true,
        },
      ],
      currentIndex: 0,
      setupState,
      callbacks: {},
      flowLocked: false,
    });

    mod._test.renderAllAuthorizedScreen(setupState, {
      showStage(stage) {
        shownStages.push(stage);
      },
      finalizeSetup() {
        finalized += 1;
      },
    });
    await withImmediateTimeout(async () => {
      elements["oauth-continue-btn"].onclick();
    });

    elements["oauth-restart-auth-btn"] = new FakeElement("oauth-restart-auth-btn");
    elements["oauth-skip-auth-btn"] = new FakeElement("oauth-skip-auth-btn");
    mod._test.setPollWaitingControls({
      visible: true,
      onRestart() {
        restarted += 1;
      },
      onSkip() {
        skipped += 1;
      },
    });
    await elements["oauth-restart-auth-btn"].click();
    await elements["oauth-skip-auth-btn"].click();
    mod._test.setPollWaitingControls({ visible: true, pendingAction: "skip" });
    assert.equal(elements["oauth-skip-auth-btn"].textContent, "Skipping...");
    assert.equal(elements["oauth-restart-auth-btn"].disabled, true);
    mod._test.setPollRestartControls({ visible: true, inProgress: true });
    assert.equal(elements["oauth-restart-auth-btn"].textContent, "Retrying...");
    mod._test.setPollRestartControls({ visible: false });
    assert.equal(elements["oauth-restart-auth-btn"].style.display, "none");
    assert.equal(elements["oauth-skip-auth-btn"].style.display, "none");

    assert.deepEqual(shownStages, ["finalize"]);
    assert.equal(finalized, 1);
    assert.equal(restarted, 1);
    assert.equal(skipped, 1);
  });
});

test("handleAuthorize completes the standalone OAuth flow, verifies tools, and advances to finalize", async () => {
  const previousWindow = global.window;
  const setupState = {
    completedOAuthServers: new Set(),
    skippedOAuthServers: new Set(),
    completedSteps: { oauth: false },
    serverConfigs: [],
  };
  const logs = [];
  const shownStages = [];
  let finalized = 0;
  const openedUrls = [];
  const lifecycleEvents = [];

  try {
    await withOauthDom(
      async () => {
        global.window = {
          electronAPI: {
            async prepareOAuthStart(serverId) {
              lifecycleEvents.push(`prepare:${serverId}`);
              return { success: true, cleared: true };
            },
            async clearOAuthTokens(serverId) {
              lifecycleEvents.push(`clear:${serverId}`);
              return { success: true, cleared: true };
            },
            async startSingleMcpServer(serverId) {
              lifecycleEvents.push(`start:${serverId}`);
              return { success: true };
            },
            async getOAuthStatusSingle() {
              return {
                current: {
                  server_name: "glean",
                  authorization_url: "https://auth.example.test",
                },
              };
            },
            async openExternal(url) {
              openedUrls.push(url);
            },
            async pollOAuthCompletionSingle() {
              return { completed: true };
            },
            async checkOAuthTokensExist() {
              return { exists: true };
            },
            async checkSingleMcpServer() {
              return {
                success: true,
                healthy: true,
                tools: [{ name: "search" }, { name: "list" }],
              };
            },
            async stopSingleMcpServer() {
              return { success: true };
            },
          },
        };

        const mod = loadModule();
        mod._test.setOauthScreenState({
          servers: [
            {
              server: { id: "glean" },
              metadata: { id: "glean", display_name: "Glean", name: "Glean" },
              status: "current",
              preConfigured: false,
              postAuthSyncState: "idle",
              postAuthToolCount: 0,
            },
          ],
          currentIndex: 0,
          completedCount: 0,
          skippedCount: 0,
          failedCount: 0,
          setupState,
          callbacks: {},
          queueStarted: false,
          flowLocked: false,
          pendingAutoStartIndex: null,
        });

        await withImmediateTimeout(async () => {
          await mod.handleAuthorize(setupState, {
            addLog(message, level) {
              logs.push({ message, level });
            },
            showStage(stage) {
              shownStages.push(stage);
            },
            finalizeSetup() {
              finalized += 1;
            },
          });
        });

        const oauthState = mod._test.getOauthScreenState();
        assert.equal(oauthState.servers[0].status, "done");
        assert.equal(oauthState.completedCount, 1);
        assert.equal(setupState.completedOAuthServers.has("glean"), true);
        assert.deepEqual(openedUrls, ["https://auth.example.test"]);
        assert.deepEqual(lifecycleEvents.slice(0, 2), [
          "prepare:glean",
          "start:glean",
        ]);
        assert.equal(lifecycleEvents.includes("clear:glean"), false);
      },
      { window: global.window },
    );
  } finally {
    global.window = previousWindow;
  }

  assert.equal(setupState.completedSteps.oauth, true);
  assert.deepEqual(shownStages, ["finalize"]);
  assert.equal(finalized, 1);
  assert.equal(
    logs.some((entry) => entry.message.includes("OAuth authorization successful for Glean")),
    true,
  );
  assert.equal(
    logs.some((entry) => entry.message.includes("Discovered 2 tools")),
    true,
  );
});

test("handleAuthorize surfaces the busy code when the single-server start is rejected", async () => {
  const previousWindow = global.window;
  const previousConsoleError = console.error;
  const setupState = {
    configuredServers: new Set(),
    completedOAuthServers: new Set(),
    completedSteps: { oauth: false },
    serverConfigs: [],
  };
  const logs = [];
  const surfacedErrors = [];

  console.error = (...args) => {
    surfacedErrors.push(args);
  };

  try {
    await withOauthDom(
      async () => {
        global.window = {
          electronAPI: {
            async prepareOAuthStart() {
              return { success: true, cleared: true };
            },
            async startSingleMcpServer() {
              return {
                success: false,
                error:
                  "Another MCP change is still running (restart_mcp_server, started by oauth-complete-recovery, 1s ago). Wait for it to finish, or restart Portico if it looks stuck.",
                errorCode: "MCP_OPERATION_BUSY",
              };
            },
            async getWizardMcpServerLogs() {
              return { logs: "" };
            },
            async stopSingleMcpServer() {
              return { success: true };
            },
          },
        };

        const mod = loadModule();
        mod._test.setOauthScreenState({
          servers: [
            {
              server: { id: "trust-kit-mcp" },
              metadata: {
                id: "trust-kit-mcp",
                display_name: "Trust Kit",
                name: "Trust Kit",
              },
              status: "current",
              preConfigured: false,
              postAuthSyncState: "idle",
              postAuthToolCount: 0,
            },
          ],
          currentIndex: 0,
          completedCount: 0,
          skippedCount: 0,
          failedCount: 0,
          setupState,
          callbacks: {},
          queueStarted: false,
          flowLocked: false,
          pendingAutoStartIndex: null,
        });

        await withImmediateTimeout(async () => {
          await mod.handleAuthorize(setupState, {
            addLog(message, level) {
              logs.push({ message, level });
            },
            showStage() {},
            finalizeSetup() {},
          });
        });

        const oauthState = mod._test.getOauthScreenState();
        assert.equal(oauthState.servers[0].status, "failed");
        const oauthError = surfacedErrors
          .flat()
          .find((arg) => arg instanceof Error);
        assert.ok(oauthError, "the OAuth error object must be logged");
        assert.equal(oauthError.code, "MCP_OPERATION_BUSY");
        assert.match(oauthError.message, /oauth-complete-recovery/);
      },
      { window: global.window },
    );
  } finally {
    global.window = previousWindow;
    console.error = previousConsoleError;
  }
});

test("handleAuthorize lets users skip for now while waiting and advances to finalize", async () => {
  const previousWindow = global.window;
  const setupState = {
    completedOAuthServers: new Set(),
    skippedOAuthServers: new Set(),
    completedSteps: { oauth: false },
    serverConfigs: [],
  };
  const shownStages = [];
  let finalized = 0;
  let progressUpdates = 0;
  const lifecycleEvents = [];
  const pollDeferred = createDeferred();

  try {
    await withOauthDom(async ({ elements }) => {
      global.window = {
        electronAPI: {
          async prepareOAuthStart(serverId) {
            lifecycleEvents.push(`prepare:${serverId}`);
            return { success: true, cleared: true };
          },
          async clearOAuthTokens(serverId) {
            lifecycleEvents.push(`clear:${serverId}`);
            return { success: true, cleared: true };
          },
          async startSingleMcpServer(serverId) {
            lifecycleEvents.push(`start:${serverId}`);
            return { success: true };
          },
          async getOAuthStatusSingle() {
            return {
              current: {
                server_name: "glean",
                authorization_url: "https://auth.example.test",
              },
            };
          },
          async openExternal(url) {
            lifecycleEvents.push(`open:${url}`);
          },
          async pollOAuthCompletionSingle() {
            lifecycleEvents.push("poll");
            return pollDeferred.promise;
          },
          async stopSingleMcpServer(serverId) {
            lifecycleEvents.push(`stop:${serverId}`);
            return { success: true };
          },
        },
      };

      const mod = loadModule();
      mod._test.setOauthScreenState({
        servers: [
          {
            server: { id: "glean" },
            metadata: { id: "glean", display_name: "Glean", name: "Glean" },
            status: "current",
            preConfigured: false,
          },
        ],
        currentIndex: 0,
        completedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        setupState,
        callbacks: {},
        queueStarted: false,
        flowLocked: false,
        pendingAutoStartIndex: null,
      });

      const authorizePromise = mod.handleAuthorize(setupState, {
        updateProgressTracker() {
          progressUpdates += 1;
        },
        showStage(stage) {
          shownStages.push(stage);
        },
        finalizeSetup() {
          finalized += 1;
        },
      });

      for (let index = 0; index < 8; index += 1) {
        await flushMicrotasks();
      }

      assert.equal(typeof elements["oauth-skip-auth-btn"].onclick, "function");
      await elements["oauth-skip-auth-btn"].click();
      assert.equal(elements["oauth-skip-auth-btn"].textContent, "Skipping...");

      pollDeferred.resolve({ timeout: true });
      await authorizePromise;

      const oauthState = mod._test.getOauthScreenState();
      assert.equal(oauthState.servers[0].status, "skipped");
      assert.equal(oauthState.skippedCount, 1);
    });
  } finally {
    global.window = previousWindow;
  }

  assert.equal(setupState.completedSteps.oauth, true);
  assert.equal(setupState.skippedOAuthServers.has("glean"), true);
  assert.equal(progressUpdates, 1);
  assert.deepEqual(shownStages, ["finalize"]);
  assert.equal(finalized, 1);
  assert.deepEqual(
    lifecycleEvents.filter((entry) => entry.startsWith("stop:")),
    ["stop:glean"],
  );
});

test("handleAuthorize renders actionable Docker Compose guidance for typed startup failures", async () => {
  const previousWindow = global.window;
  const setupState = {
    completedOAuthServers: new Set(),
    skippedOAuthServers: new Set(),
    completedSteps: { oauth: false },
    serverConfigs: [],
  };
  const logs = [];

  try {
    await withOauthDom(async ({ elements }) => {
      global.window = {
        electronAPI: {
          async startSingleMcpServer() {
            return {
              success: false,
              code: "docker_compose_unavailable",
              error:
                "Docker is running, but no usable Docker Compose v2 frontend is available.",
              details:
                "DOCKER_COMPOSE_UNAVAILABLE\nDOCKER_COMPOSE_PLUGIN_PROBE=docker: unknown command: docker compose",
              selectedFrontend: "unavailable",
              probeDiagnostics: {
                dockerPlugin: "docker: unknown command: docker compose",
                standaloneV2: "docker-compose: command not found",
              },
              recoveryAttempted: true,
            };
          },
          async getWizardMcpServerLogs() {
            return {
              success: false,
              code: "container_not_created",
              logs:
                "Error response from daemon: No such container: mcpo-single-glean",
            };
          },
          async stopSingleMcpServer() {
            return { success: true };
          },
        },
      };

      const mod = loadModule();
      mod._test.setOauthScreenState({
        servers: [
          {
            server: { id: "glean" },
            metadata: { id: "glean", display_name: "Glean", name: "Glean" },
            status: "current",
            preConfigured: false,
          },
        ],
        currentIndex: 0,
        completedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        setupState,
        callbacks: {},
        queueStarted: false,
        flowLocked: false,
      });

      await mod.handleAuthorize(setupState, {
        addLog(message, level) {
          logs.push({ message, level });
        },
      });

      assert.equal(mod._test.getOauthScreenState().servers[0].status, "failed");
      assert.match(
        elements["oauth-stage-testing-content"].innerHTML,
        /Docker Compose is unavailable/,
      );
      assert.match(
        elements["oauth-stage-testing-content"].innerHTML,
        /Fully quit and reopen OrbStack/,
      );
      assert.doesNotMatch(
        elements["oauth-stage-testing-content"].innerHTML,
        /NO_PROXY|cookies/i,
      );
      assert.match(
        elements["oauth-stage-testing-content"].innerHTML,
        /DOCKER_COMPOSE_UNAVAILABLE/,
      );
      assert.equal(typeof elements["oauth-test-retry-btn"].onclick, "function");
      mod._test.setOauthScreenState({ queueStarted: false });
      elements["oauth-test-retry-btn"].onclick();
      assert.equal(mod._test.getOauthScreenState().servers[0].status, "current");
      assert.equal(elements["oauth-stage-testing"].style.display, "none");
    });
  } finally {
    global.window = previousWindow;
  }

  assert.equal(
    logs.some((entry) =>
      entry.message.includes(
        "OAuth failed for Glean: Docker is running, but no usable Docker Compose v2 frontend is available.",
      ),
    ),
    true,
  );
});

test("oauth preview helpers update badges and block navigation while authorization is in flight", async () => {
  await withOauthDom(async ({ elements, cards }) => {
    const mod = loadModule();
    mod._test.setOauthScreenState({
      servers: [
        {
          server: { id: "glean" },
          metadata: {
            id: "glean",
            display_name: "Glean",
            name: "Glean",
            icon: "glean.svg",
            description: "Authorize Glean",
          },
          status: "current",
          preConfigured: false,
        },
        {
          server: { id: "google_workspace" },
          metadata: {
            id: "google_workspace",
            display_name: "Google Workspace",
            name: "Google Workspace",
            description: "Connected already",
          },
          status: "done",
          preConfigured: true,
        },
        {
          server: { id: "custom-oauth" },
          metadata: {
            id: "custom-oauth",
            display_name: "Custom OAuth",
            name: "Custom OAuth",
            description: "Needs attention",
          },
          status: "failed",
          preConfigured: false,
        },
      ],
      currentIndex: 0,
      queueStarted: false,
      flowLocked: false,
    });

    mod._test.renderOAuthStage();
    mod._test.updateCurrentServerUI();
    mod._test.updatePreviewBar();

    assert.equal(elements["oauth-stage-server-icon"].src, "glean.svg");
    assert.equal(elements["oauth-stage-server-icon"].style.display, "block");
    assert.equal(elements["oauth-stage-server-name"].textContent, "Glean");
    assert.equal(elements["oauth-stage-status-text"].style.display, "none");
    assert.match(cards[1].iconContainer.lastBadgeHtml, /preconfigured/);
    assert.match(cards[2].iconContainer.lastBadgeHtml, /failed/);

    mod.navigateToServer(1);
    assert.equal(mod._test.getOauthScreenState().currentIndex, 1);
    assert.equal(mod._test.getOauthScreenState().servers[0].status, "pending");
    assert.equal(elements["oauth-stage-server-icon"].style.display, "none");
    assert.equal(elements["oauth-stage-status-text"].textContent, "");
    assert.equal(elements["oauth-stage-status-text"].style.display, "none");
    assert.equal(elements["oauth-stage-authorize-btn"].textContent, "Authorized ✓");

    mod._test.setOauthScreenState({ flowLocked: true });
    mod.navigateToServer(2);
    assert.equal(mod._test.getOauthScreenState().currentIndex, 1);

    mod._test.setOauthScreenState({
      flowLocked: false,
      currentIndex: 0,
      servers: [
        {
          server: { id: "glean" },
          metadata: { id: "glean", display_name: "Glean", name: "Glean" },
          status: "starting",
          preConfigured: false,
        },
        {
          server: { id: "custom-oauth" },
          metadata: { id: "custom-oauth", display_name: "Custom OAuth", name: "Custom OAuth" },
          status: "pending",
          preConfigured: false,
        },
      ],
    });
    mod.navigateToServer(1);
    assert.equal(mod._test.getOauthScreenState().currentIndex, 0);
  });
});

test("oauth testing helpers render step progress and support copy, retry, and back actions from the error pane", async () => {
  const previousWindow = global.window;
  const copiedLogs = [];

  try {
    await withOauthDom(async ({ elements }) => {
      global.window = {
        electronAPI: {
          async getWizardMcpServerLogs() {
            return { logs: "line 1\nline 2" };
          },
          async copyToClipboard(text) {
            copiedLogs.push(text);
          },
        },
      };

      const mod = loadModule();
      mod._test.setOauthScreenState({
        servers: [
          {
            server: { id: "glean" },
            metadata: { id: "glean", display_name: "Glean", name: "Glean" },
            status: "current",
            preConfigured: false,
          },
        ],
        currentIndex: 0,
        queueStarted: false,
        flowLocked: false,
      });

      mod._test.showTestingProgress("Glean");
      assert.match(
        elements["oauth-stage-testing-content"].innerHTML,
        /class="oauth-test-action-row"[\s\S]*id="oauth-restart-auth-btn"[\s\S]*id="oauth-skip-auth-btn"/,
      );
      mod._test.updateTestStep("verify", "success", "Connected", [{ name: "search" }, "list"]);

      const verifyStep = global.document.querySelector('.oauth-test-step[data-step="verify"]');
      assert.equal(elements["oauth-stage-buttons"].style.display, "none");
      assert.equal(elements["oauth-stage-testing"].style.display, "block");
      assert.equal(verifyStep.icon.textContent, "✓");
      assert.equal(verifyStep.detail.textContent, "Connected");

      await mod._test.showTestingError("boom", "glean");
      const errorMarkup = elements["oauth-stage-testing-content"].innerHTML;
      assert.ok(
        errorMarkup.indexOf('class="oauth-test-steps-panel"') <
          errorMarkup.indexOf('class="oauth-test-logs-container"'),
      );
      await withImmediateTimeout(async () => {
        await elements["copy-logs-btn"].click();
      });
      assert.deepEqual(copiedLogs, ["line 1\nline 2"]);
      assert.equal(elements["copy-logs-btn"].querySelector("span").textContent, "Copy");

      mod._test.setOauthScreenState({ queueStarted: true, pendingAutoStartIndex: null });
      await withNoopTimeout(async () => {
        elements["oauth-test-retry-btn"].onclick();
      });
      assert.equal(mod._test.getOauthScreenState().pendingAutoStartIndex, 0);
      assert.equal(elements["oauth-stage-testing"].style.display, "none");

      await mod._test.showTestingError("boom", "glean");
      mod._test.setOauthScreenState({ queueStarted: false, pendingAutoStartIndex: null });
      elements["oauth-test-back-btn"].onclick();
      assert.equal(mod._test.getOauthScreenState().servers[0].status, "current");
      assert.equal(elements["oauth-stage-testing"].style.display, "none");
    });
  } finally {
    global.window = previousWindow;
  }
});

test("handleAuthorize retries the standalone flow when tokens are missing after callback completion", async () => {
  const previousWindow = global.window;
  const setupState = {
    completedOAuthServers: new Set(),
    skippedOAuthServers: new Set(),
    completedSteps: { oauth: false },
    serverConfigs: [],
  };
  const logs = [];
  const shownStages = [];
  let finalized = 0;
  const openedUrls = [];
  const startedServers = [];
  const stoppedServers = [];
  let tokenCheckCount = 0;

  try {
    await withOauthDom(async () => {
      global.window = {
        electronAPI: {
          async startSingleMcpServer(serverId) {
            startedServers.push(serverId);
            return { success: true };
          },
          async getOAuthStatusSingle() {
            return {
              current: {
                server_name: "glean",
                authorization_url:
                  startedServers.length > 1
                    ? "https://auth.example.test/reauth"
                    : "https://auth.example.test/initial",
              },
            };
          },
          async openExternal(url) {
            openedUrls.push(url);
          },
          async pollOAuthCompletionSingle() {
            return { completed: true };
          },
          async checkOAuthTokensExist() {
            tokenCheckCount += 1;
            if (tokenCheckCount === 1) {
              return { exists: false, reason: "missing-tokens" };
            }
            return { exists: true };
          },
          async checkSingleMcpServer() {
            return {
              success: true,
              healthy: true,
              tools: [{ name: "search" }],
            };
          },
          async stopSingleMcpServer(serverId) {
            stoppedServers.push(serverId);
            return { success: true };
          },
        },
      };

      const mod = loadModule();
      mod._test.setOauthScreenState({
        servers: [
          {
            server: { id: "glean" },
            metadata: { id: "glean", display_name: "Glean", name: "Glean" },
            status: "current",
            preConfigured: false,
            postAuthSyncState: "idle",
            postAuthToolCount: 0,
          },
        ],
        currentIndex: 0,
        completedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        setupState,
        callbacks: {},
        queueStarted: false,
        flowLocked: false,
        pendingAutoStartIndex: null,
      });

      await withImmediateTimeout(async () => {
        await mod.handleAuthorize(setupState, {
          addLog(message, level) {
            logs.push({ message, level });
          },
          showStage(stage) {
            shownStages.push(stage);
          },
          finalizeSetup() {
            finalized += 1;
          },
        });
      });

      const oauthState = mod._test.getOauthScreenState();
      assert.equal(oauthState.servers[0].status, "done");
      assert.equal(oauthState.completedCount, 1);
      assert.equal(setupState.completedOAuthServers.has("glean"), true);
      assert.deepEqual(openedUrls, [
        "https://auth.example.test/initial",
        "https://auth.example.test/reauth",
      ]);
      assert.deepEqual(startedServers, ["glean", "glean"]);
      assert.deepEqual(stoppedServers, ["glean", "glean"]);
    });
  } finally {
    global.window = previousWindow;
  }

  assert.equal(setupState.completedSteps.oauth, true);
  assert.deepEqual(shownStages, ["finalize"]);
  assert.equal(finalized, 1);
  assert.equal(
    logs.some((entry) => entry.message.includes("Re-authenticating Glean")),
    true,
  );
  assert.equal(
    logs.some((entry) => entry.message.includes("Re-authentication successful")),
    true,
  );
});

test("markCurrentAsDone restarts the MCP server and advances to the next pending OAuth server", async () => {
  const previousWindow = global.window;
  const previousSetInterval = global.setInterval;
  const previousClearInterval = global.clearInterval;
  const previousRandom = Math.random;
  const setupState = {
    completedOAuthServers: new Set(),
    completedSteps: { oauth: false },
  };
  const logs = [];
  const restartedServerIds = [];

  global.setInterval = () => 1;
  global.clearInterval = () => {};
  Math.random = () => 0;

  try {
    await withOauthDom(async () => {
      global.window = {
        electronAPI: {
          async apiRestartMcpServers(serverIds) {
            restartedServerIds.push(serverIds);
            return { success: true };
          },
        },
      };

      const mod = loadModule();
      mod._test.setOauthScreenState({
        servers: [
          {
            server: { id: "glean" },
            metadata: { id: "glean", display_name: "Glean", name: "Glean" },
            status: "current",
            preConfigured: false,
          },
          {
            server: { id: "sourcegraph" },
            metadata: { id: "sourcegraph", display_name: "Sourcegraph", name: "Sourcegraph" },
            status: "pending",
            preConfigured: false,
          },
        ],
        currentIndex: 0,
        completedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        setupState,
        callbacks: {},
        queueStarted: false,
        flowLocked: false,
      });

      await withImmediateTimeout(async () => {
        await mod._test.markCurrentAsDone(setupState, {
          addLog(message, level) {
            logs.push({ message, level });
          },
        });
      });

      const oauthState = mod._test.getOauthScreenState();
      assert.equal(oauthState.servers[0].status, "done");
      assert.equal(oauthState.currentIndex, 1);
      assert.equal(oauthState.servers[1].status, "current");
      assert.equal(setupState.completedOAuthServers.has("glean"), true);
      assert.deepEqual(restartedServerIds, [["glean"]]);
    });
  } finally {
    global.window = previousWindow;
    global.setInterval = previousSetInterval;
    global.clearInterval = previousClearInterval;
    Math.random = previousRandom;
  }

  assert.equal(
    logs.some((entry) => entry.message.includes("Finalizing Glean setup")),
    true,
  );
  assert.equal(
    logs.some((entry) => entry.message.includes("Glean is ready!")),
    true,
  );
});

test("oauth testing helpers toggle the testing pane and annotate step details with tool lists", async () => {
  await withOauthDom(async ({ elements, progressSection }) => {
    const mod = loadModule();

    mod._test.showTestingProgress("Glean");
    assert.equal(elements["oauth-stage-buttons"].style.display, "none");
    assert.equal(progressSection.style.display, "none");
    assert.equal(elements["oauth-stage-testing"].style.display, "block");
    assert.match(elements["oauth-stage-testing-content"].innerHTML, /Getting things ready/);

    mod._test.updateTestStep("standalone", "success", "Ready");
    const standaloneStep = global.document.querySelector(
      '.oauth-test-step[data-step="standalone"]',
    );
    assert.equal(standaloneStep.icon.textContent, "✓");
    assert.equal(standaloneStep.detail.textContent, "Ready");

    mod._test.updateTestStep("verify", "success", "Connected", [
      { name: "search" },
      "list",
    ]);
    const verifyStep = global.document.querySelector('.oauth-test-step[data-step="verify"]');
    assert.equal(verifyStep.detail.textContent, "Connected");
    assert.equal(verifyStep.detail.children.length, 1);
    assert.match(verifyStep.detail.children[0].innerHTML, /search/);
    assert.match(verifyStep.detail.children[0].innerHTML, /list/);

    mod._test.hideTestingProgress();
    assert.equal(elements["oauth-stage-testing"].style.display, "none");
    assert.equal(elements["oauth-stage-buttons"].style.display, "block");
    assert.equal(progressSection.style.display, "flex");
  });
});

test("oauth readiness helpers wait for auth URLs and single-server health checks across retries", async () => {
  const previousWindow = global.window;
  let oauthStatusCalls = 0;
  let healthChecks = 0;

  try {
    await withOauthDom(async () => {
      global.window = {
        electronAPI: {
          async getOAuthStatusSingle() {
            oauthStatusCalls += 1;
            if (oauthStatusCalls === 1) {
              return { pending: [{ server_name: "glean" }] };
            }
            return {
              waiting_callback: [
                {
                  server_name: "glean",
                  authorization_url: "https://auth.example.test",
                },
              ],
            };
          },
          async checkSingleMcpServer() {
            healthChecks += 1;
            if (healthChecks === 1) {
              throw new Error("not ready");
            }
            return {
              success: true,
              healthy: true,
              tools: [{ name: "search" }],
            };
          },
        },
      };

      const mod = loadModule();
      mod._test.renderTestingSteps();

      const oauthReady = await withImmediateTimeout(async () =>
        mod._test.waitForOAuthReady("glean", 5000),
      );
      const serverHealthy = await withImmediateTimeout(async () =>
        mod._test.waitForServerHealthSingle("glean", 5000),
      );

      assert.deepEqual(oauthReady, {
        ready: true,
        authUrl: "https://auth.example.test",
      });
      assert.deepEqual(serverHealthy, {
        healthy: true,
        tools: [{ name: "search" }],
      });
      assert.equal(oauthStatusCalls, 2);
      assert.equal(healthChecks, 2);
    });
  } finally {
    global.window = previousWindow;
  }
});

test("showTestingError copies logs and the back action restores the current server without auto-starting", async () => {
  const previousWindow = global.window;
  const copiedLogs = [];

  try {
    await withOauthDom(async ({ elements }) => {
      global.window = {
        electronAPI: {
          async getWizardMcpServerLogs() {
            return { logs: "line 1\nline 2" };
          },
          async copyToClipboard(value) {
            copiedLogs.push(value);
          },
        },
      };

      const mod = loadModule();
      mod._test.setOauthScreenState({
        servers: [
          {
            server: { id: "glean" },
            metadata: { id: "glean", display_name: "Glean", name: "Glean" },
            status: "failed",
          },
        ],
        currentIndex: 0,
        queueStarted: false,
        flowLocked: false,
      });

      await mod._test.showTestingError("broken", "glean");
      await elements["copy-logs-btn"].click();
      elements["oauth-test-back-btn"].onclick();

      assert.deepEqual(copiedLogs, ["line 1\nline 2"]);
      assert.equal(mod._test.getOauthScreenState().servers[0].status, "current");
      assert.equal(elements["oauth-stage-testing"].style.display, "none");
      assert.match(elements["oauth-stage-testing-content"].innerHTML, /Container Logs/);
      assert.ok(
        elements["oauth-stage-testing-content"].innerHTML.indexOf('class="oauth-test-steps-panel"') <
          elements["oauth-stage-testing-content"].innerHTML.indexOf('class="oauth-test-logs-container"'),
      );
    });
  } finally {
    global.window = previousWindow;
  }
});

test("showTestingError renders a skip action that marks the failed server skipped and auto-starts the next pending server", async () => {
  const previousWindow = global.window;

  try {
    await withOauthDom(async ({ elements }) => {
      global.window = {
        electronAPI: {
          async getWizardMcpServerLogs() {
            return { logs: "line 1\nline 2" };
          },
          async copyToClipboard() {
            return null;
          },
        },
      };

      const mod = loadModule();
      const setupState = {
        skippedOAuthServers: new Set(),
        completedSteps: { oauth: false },
        serverConfigs: [],
      };
      mod._test.setOauthScreenState({
        servers: [
          {
            server: { id: "glean" },
            metadata: { id: "glean", display_name: "Glean", name: "Glean" },
            status: "failed",
          },
          {
            server: { id: "google_workspace" },
            metadata: { id: "google_workspace", display_name: "Google Workspace", name: "Google Workspace" },
            status: "pending",
          },
        ],
        currentIndex: 0,
        skippedCount: 0,
        completedCount: 0,
        failedCount: 1,
        queueStarted: true,
        flowLocked: false,
        pendingAutoStartIndex: null,
        setupState,
        callbacks: {
          addLog() {},
        },
      });

      await mod._test.showTestingError("broken", "glean");
      assert.match(elements["oauth-stage-testing-content"].innerHTML, /id="oauth-test-skip-current-btn"/);

      await withNoopTimeout(async () => {
        elements["oauth-test-skip-current-btn"].onclick();
      });

      const oauthState = mod._test.getOauthScreenState();
      assert.equal(oauthState.servers[0].status, "skipped");
      assert.equal(oauthState.servers[1].status, "current");
      assert.equal(oauthState.currentIndex, 1);
      assert.equal(oauthState.failedCount, 0);
      assert.equal(oauthState.skippedCount, 1);
      assert.equal(oauthState.pendingAutoStartIndex, 1);
      assert.equal(setupState.skippedOAuthServers.has("glean"), true);
      assert.equal(elements["oauth-stage-testing"].style.display, "none");
    });
  } finally {
    global.window = previousWindow;
  }
});

test("showTestingError skip completes oauth when the failed server is the last remaining item", async () => {
  const previousWindow = global.window;
  const shownStages = [];
  let finalized = 0;
  let progressUpdates = 0;

  try {
    await withOauthDom(async ({ elements }) => {
      global.window = {
        electronAPI: {
          async getWizardMcpServerLogs() {
            return { logs: "line 1\nline 2" };
          },
        },
      };

      const mod = loadModule();
      const setupState = {
        skippedOAuthServers: new Set(),
        completedSteps: { oauth: false },
        serverConfigs: [],
      };
      mod._test.setOauthScreenState({
        servers: [
          {
            server: { id: "glean" },
            metadata: { id: "glean", display_name: "Glean", name: "Glean" },
            status: "failed",
          },
        ],
        currentIndex: 0,
        skippedCount: 0,
        completedCount: 0,
        failedCount: 1,
        queueStarted: false,
        flowLocked: false,
        pendingAutoStartIndex: null,
        setupState,
        callbacks: {
          addLog() {},
          updateProgressTracker() {
            progressUpdates += 1;
          },
          showStage(stage) {
            shownStages.push(stage);
          },
          finalizeSetup() {
            finalized += 1;
          },
        },
      });

      await mod._test.showTestingError("broken", "glean");
      await withImmediateTimeout(async () => {
        elements["oauth-test-skip-current-btn"].onclick();
      });
    });
  } finally {
    global.window = previousWindow;
  }

  assert.equal(progressUpdates, 1);
  assert.deepEqual(shownStages, ["finalize"]);
  assert.equal(finalized, 1);
});

test("oauth helpers restart standalone auth sessions and extract auth URLs from all supported status buckets", async () => {
  const previousWindow = global.window;
  const openedUrls = [];
  const logs = [];
  const stoppedServers = [];
  const startedServers = [];
  const statusSessions = [];

  try {
    await withOauthDom(async () => {
      global.window = {
        electronAPI: {
          async stopSingleMcpServer(serverId, options) {
            stoppedServers.push({ serverId, options });
            return { success: true };
          },
          async startSingleMcpServer(serverId, options) {
            startedServers.push({ serverId, options });
            return { success: true, sessionId: "new-session" };
          },
          async getOAuthStatusSingle(options) {
            statusSessions.push(options);
            return {
              current: {
                server_name: "glean",
                authorization_url: "https://auth.example.test/restart",
              },
            };
          },
          async openExternal(url) {
            openedUrls.push(url);
          },
        },
      };

      const mod = loadModule();
      assert.equal(mod._test.getCompletionDetail(null), "Connected.");
      assert.equal(
        mod._test.getCompletionDetail({ postAuthSyncState: "deferred" }),
        "Connected. Final checks will finish after setup completes.",
      );
      assert.equal(
        mod._test.getCompletionDetail({ preConfigured: true }),
        "Already connected and ready to use.",
      );
      assert.equal(
        mod._test.extractAuthUrlFromStatus(
          { current: { server_name: "GLEAN", authorization_url: "https://auth.example.test/current" } },
          "glean",
        ),
        "https://auth.example.test/current",
      );
      assert.equal(
        mod._test.extractAuthUrlFromStatus(
          { active: [{ server_name: "glean", authorization_url: "https://auth.example.test/active" }] },
          "glean",
        ),
        "https://auth.example.test/active",
      );
      assert.equal(
        mod._test.extractAuthUrlFromStatus(
          { pending: [{ server_name: "glean", authorization_url: "https://auth.example.test/pending" }] },
          "glean",
        ),
        "https://auth.example.test/pending",
      );
      assert.equal(
        mod._test.extractAuthUrlFromStatus(
          { checking: [{ server_name: "glean", authorization_url: "https://auth.example.test/checking" }] },
          "glean",
        ),
        "https://auth.example.test/checking",
      );
      assert.equal(
        mod._test.extractAuthUrlFromStatus(
          { failed: [{ server_name: "glean", authorization_url: "https://auth.example.test/failed" }] },
          "glean",
        ),
        "https://auth.example.test/failed",
      );

      await withImmediateTimeout(async () => {
        await mod._test.restartOAuthAuthorizationSession(
          "glean",
          "old-session",
          {
            addLog(message, level) {
              logs.push({ message, level });
            },
          },
        );
      });
    });
  } finally {
    global.window = previousWindow;
  }

  assert.deepEqual(stoppedServers, [
    { serverId: "glean", options: { sessionId: "old-session" } },
  ]);
  assert.deepEqual(startedServers, [
    { serverId: "glean", options: { oauthMode: "bootstrap" } },
  ]);
  assert.deepEqual(statusSessions, [{ sessionId: "new-session" }]);
  assert.deepEqual(openedUrls, ["https://auth.example.test/restart"]);
  assert.equal(
    logs.some((entry) => entry.message.includes("Authorization flow restarted")),
    true,
  );
});

test("failed OAuth session restarts clean up the newly owned session", async () => {
  const previousWindow = global.window;
  const stoppedSessions = [];

  try {
    await withOauthDom(async () => {
      global.window = {
        electronAPI: {
          async stopSingleMcpServer(serverId, options) {
            stoppedSessions.push({ serverId, sessionId: options?.sessionId });
            return { success: true };
          },
          async startSingleMcpServer() {
            return { success: true, sessionId: "replacement-session" };
          },
          async getOAuthStatusSingle() {
            return {
              current: {
                server_name: "glean",
                authorization_url: "https://auth.example.test/restart",
              },
            };
          },
          async openExternal() {
            throw new Error("browser launch failed");
          },
        },
      };

      const mod = loadModule();
      await assert.rejects(
        mod._test.restartOAuthAuthorizationSession(
          "glean",
          "original-session",
        ),
        /browser launch failed/,
      );
    });
  } finally {
    global.window = previousWindow;
  }

  assert.deepEqual(stoppedSessions, [
    { serverId: "glean", sessionId: "original-session" },
    { serverId: "glean", sessionId: "replacement-session" },
  ]);
});

test("showCompletedServerState next and skip actions advance the remaining OAuth queue without re-running the completed item", async () => {
  const mod = loadModule();
  const setupState = {
    skippedOAuthServers: new Set(),
    completedSteps: { oauth: false },
    serverConfigs: [],
  };

  await withOauthDom(async ({ elements }) => {
    mod._test.setOauthScreenState({
      servers: [
        {
          server: { id: "glean" },
          metadata: { display_name: "Glean" },
          status: "done",
          preConfigured: false,
        },
        {
          server: { id: "google_workspace" },
          metadata: { display_name: "Google Workspace" },
          status: "pending",
          preConfigured: false,
        },
        {
          server: { id: "sourcegraph" },
          metadata: { display_name: "Sourcegraph" },
          status: "pending",
          preConfigured: false,
        },
      ],
      currentIndex: 0,
      completedCount: 1,
      skippedCount: 0,
      failedCount: 0,
      setupState,
      callbacks: {
        addLog() {},
      },
      queueStarted: false,
      flowLocked: false,
      pendingAutoStartIndex: null,
    });

    mod._test.showCompletedServerState();
    assert.match(
      elements["oauth-stage-testing-content"].innerHTML,
      /id="oauth-test-skip-btn"[\s\S]*data-tooltip="You can always connect more integrations later\."[\s\S]*>Skip<\/button>/,
    );
    assert.match(
      elements["oauth-stage-testing-content"].innerHTML,
      /id="oauth-test-skip-all-btn"[\s\S]*data-tooltip="You can always connect more integrations later\."[\s\S]*>Skip All<\/button>/,
    );
    await withNoopTimeout(async () => {
      elements["oauth-test-skip-btn"].onclick();
    });

    let oauthState = mod._test.getOauthScreenState();
    assert.equal(oauthState.servers[1].status, "skipped");
    assert.equal(oauthState.servers[2].status, "current");
    assert.equal(oauthState.currentIndex, 2);
    assert.equal(setupState.skippedOAuthServers.has("google_workspace"), true);
    assert.equal(oauthState.pendingAutoStartIndex, 2);

    mod._test.setOauthScreenState({
      servers: [
        {
          server: { id: "glean" },
          metadata: { display_name: "Glean" },
          status: "done",
          preConfigured: false,
        },
        {
          server: { id: "google_workspace" },
          metadata: { display_name: "Google Workspace" },
          status: "pending",
          preConfigured: false,
        },
      ],
      currentIndex: 0,
      completedCount: 1,
      skippedCount: 0,
      failedCount: 0,
      setupState: {
        skippedOAuthServers: new Set(),
        completedSteps: { oauth: false },
        serverConfigs: [],
      },
      callbacks: {
        addLog() {},
      },
      queueStarted: false,
      flowLocked: false,
      pendingAutoStartIndex: null,
    });

    mod._test.showCompletedServerState();
    await withNoopTimeout(async () => {
      elements["oauth-test-next-btn"].onclick();
    });

    oauthState = mod._test.getOauthScreenState();
    assert.equal(oauthState.currentIndex, 1);
    assert.equal(oauthState.servers[1].status, "current");
    assert.equal(oauthState.pendingAutoStartIndex, 1);
  });
});

test("markCurrentAsDoneNoRestart completes OAuth and markCurrentAsDone restarts the server then advances to the next pending item", async () => {
  const previousWindow = global.window;
  const previousSetInterval = global.setInterval;
  const previousClearInterval = global.clearInterval;
  const restartCalls = [];
  const logs = [];
  const shownStages = [];
  let finalized = 0;

  try {
    global.setInterval = (handler) => {
      handler();
      return 1;
    };
    global.clearInterval = () => {};

    await withOauthDom(async () => {
      global.window = {
        electronAPI: {
          async apiRestartMcpServers(serverIds) {
            restartCalls.push(serverIds);
            return { success: true };
          },
        },
      };

      const mod = loadModule();
      const finalizeState = {
        completedOAuthServers: new Set(),
        completedSteps: { oauth: false },
        serverConfigs: [],
      };
      mod._test.setOauthScreenState({
        servers: [
          {
            server: { id: "glean" },
            metadata: { id: "glean", display_name: "Glean", name: "Glean" },
            status: "current",
          },
        ],
        currentIndex: 0,
        completedCount: 0,
        skippedCount: 0,
        failedCount: 0,
      });

      await withImmediateTimeout(async () => {
        await mod._test.markCurrentAsDoneNoRestart(finalizeState, {
          addLog(message, level) {
            logs.push({ message, level });
          },
          updateProgressTracker() {},
          showStage(stage) {
            shownStages.push(stage);
          },
          finalizeSetup() {
            finalized += 1;
          },
        });
      });

      assert.equal(finalizeState.completedOAuthServers.has("glean"), true);
      assert.equal(finalizeState.completedSteps.oauth, true);
      assert.deepEqual(shownStages, ["finalize"]);
      assert.equal(finalized, 1);

      mod._test.setOauthScreenState({
        servers: [
          {
            server: { id: "glean" },
            metadata: { id: "glean", display_name: "Glean", name: "Glean" },
            status: "current",
          },
          {
            server: { id: "sourcegraph" },
            metadata: { id: "sourcegraph", display_name: "Sourcegraph", name: "Sourcegraph" },
            status: "pending",
          },
        ],
        currentIndex: 0,
        completedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        setupState: {
          completedOAuthServers: new Set(),
        },
        callbacks: {},
      });

      await withImmediateTimeout(async () => {
        await mod._test.markCurrentAsDone(
          { completedOAuthServers: new Set() },
          {
            addLog(message, level) {
              logs.push({ message, level });
            },
          },
        );
      });

      const oauthState = mod._test.getOauthScreenState();
      assert.deepEqual(restartCalls, [["glean"]]);
      assert.equal(oauthState.servers[0].status, "done");
      assert.equal(oauthState.servers[1].status, "current");
      assert.equal(oauthState.currentIndex, 1);
    });
  } finally {
    global.window = previousWindow;
    global.setInterval = previousSetInterval;
    global.clearInterval = previousClearInterval;
  }

  assert.equal(
    logs.some((entry) => entry.message.includes("OAuth authorization successful for Glean")),
    true,
  );
  assert.equal(
    logs.some((entry) => entry.message.includes("Finalizing Glean setup")),
    true,
  );
});

test("handleAuthorize retries the OAuth flow when tokens were not persisted after the first completion", async () => {
  const previousWindow = global.window;
  const setupState = {
    completedOAuthServers: new Set(),
    skippedOAuthServers: new Set(),
    completedSteps: { oauth: false },
    serverConfigs: [],
  };
  const logs = [];
  const openedUrls = [];
  let startCalls = 0;
  let pollCalls = 0;
  let tokenChecks = 0;

  try {
    await withOauthDom(async () => {
      global.window = {
        electronAPI: {
          async startSingleMcpServer() {
            startCalls += 1;
            return { success: true };
          },
          async getOAuthStatusSingle() {
            return {
              current: {
                server_name: "glean",
                authorization_url: "https://auth.example.test",
              },
            };
          },
          async openExternal(url) {
            openedUrls.push(url);
          },
          async pollOAuthCompletionSingle() {
            pollCalls += 1;
            return { completed: true };
          },
          async checkOAuthTokensExist() {
            tokenChecks += 1;
            if (tokenChecks === 1) {
              return { exists: false, reason: "missing-client" };
            }
            return { exists: true };
          },
          async checkSingleMcpServer() {
            return {
              success: true,
              healthy: true,
              tools: [{ name: "search" }],
            };
          },
          async stopSingleMcpServer() {
            return { success: true };
          },
        },
      };

      const mod = loadModule();
      mod._test.setOauthScreenState({
        servers: [
          {
            server: { id: "glean" },
            metadata: { id: "glean", display_name: "Glean", name: "Glean" },
            status: "current",
            preConfigured: false,
            postAuthSyncState: "idle",
            postAuthToolCount: 0,
          },
        ],
        currentIndex: 0,
        completedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        setupState,
        callbacks: {},
        queueStarted: false,
        flowLocked: false,
        pendingAutoStartIndex: null,
      });

      await withImmediateTimeout(async () => {
        await mod.handleAuthorize(setupState, {
          addLog(message, level) {
            logs.push({ message, level });
          },
        });
      });

      const oauthState = mod._test.getOauthScreenState();
      assert.equal(oauthState.servers[0].status, "done");
      assert.equal(oauthState.servers[0].postAuthSyncState, "ready");
      assert.equal(oauthState.completedCount, 1);
    });
  } finally {
    global.window = previousWindow;
  }

  assert.equal(startCalls, 2);
  assert.equal(pollCalls, 2);
  assert.deepEqual(openedUrls, [
    "https://auth.example.test",
    "https://auth.example.test",
  ]);
  assert.equal(
    logs.some((entry) => entry.message.includes("Re-authentication successful")),
    true,
  );
});

// --- PORTICO-339 follow-up: finalize must not race the single-server teardown ----
// On the LAST processed server the advance chain enters finalize, whose .env
// write takes the same global mutation lease the stop holds across a docker
// compose down. The stop must therefore complete BEFORE the advance fires.

function buildOrderingElectronApi(events, { alreadyAuthorized = false } = {}) {
  return {
    async prepareOAuthStart() {
      return { success: true, cleared: true };
    },
    async clearOAuthTokens() {
      return { success: true, cleared: true };
    },
    async startSingleMcpServer() {
      events.push("start");
      return { success: true };
    },
    async getOAuthStatusSingle() {
      // waitForOAuthReady needs an authorization_url to consider the stack
      // ready even for an already-authorized server; the fast path then keys
      // off the completed entry in the follow-up status fetch.
      return {
        current: {
          server_name: "glean",
          authorization_url: "https://auth.example.test",
        },
        ...(alreadyAuthorized
          ? { completed: [{ server_name: "glean", state: "completed" }] }
          : {}),
      };
    },
    async openExternal() {},
    async pollOAuthCompletionSingle() {
      return { completed: true };
    },
    async checkOAuthTokensExist() {
      return { exists: true };
    },
    async checkSingleMcpServer() {
      return {
        success: true,
        healthy: true,
        tools: [{ name: "search" }],
      };
    },
    async stopSingleMcpServer() {
      events.push("stop:start");
      // A real teardown holds the mutation lease for seconds; a few microtask
      // turns are enough to catch an advance chain that failed to wait.
      await Promise.resolve();
      await Promise.resolve();
      events.push("stop:done");
      return { success: true };
    },
  };
}

function buildLastPendingScreenState(setupState) {
  return {
    servers: [
      {
        server: { id: "glean" },
        metadata: { id: "glean", display_name: "Glean", name: "Glean" },
        status: "current",
        preConfigured: false,
        postAuthSyncState: "idle",
        postAuthToolCount: 0,
      },
    ],
    currentIndex: 0,
    completedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    setupState,
    callbacks: {},
    queueStarted: false,
    flowLocked: false,
    pendingAutoStartIndex: null,
  };
}

for (const [label, alreadyAuthorized] of [
  ["poll path", false],
  ["already-authorized fast path", true],
]) {
  test(`handleAuthorize stops the single server before entering finalize (${label})`, async () => {
    const previousWindow = global.window;
    const setupState = {
      completedOAuthServers: new Set(),
      skippedOAuthServers: new Set(),
      completedSteps: { oauth: false },
      serverConfigs: [],
    };
    const events = [];

    try {
      await withOauthDom(
        async () => {
          global.window = {
            electronAPI: buildOrderingElectronApi(events, { alreadyAuthorized }),
          };

          const mod = loadModule();
          mod._test.setOauthScreenState(buildLastPendingScreenState(setupState));

          await withImmediateTimeout(async () => {
            await mod.handleAuthorize(setupState, {
              addLog() {},
              showStage(stage) {
                events.push(`stage:${stage}`);
              },
              finalizeSetup() {
                events.push("finalize");
              },
            });
          });

          const stopDone = events.indexOf("stop:done");
          const finalize = events.indexOf("finalize");
          assert.notEqual(stopDone, -1, `expected a completed stop in ${JSON.stringify(events)}`);
          assert.notEqual(finalize, -1, `expected finalize in ${JSON.stringify(events)}`);
          assert.ok(
            stopDone < finalize,
            `single-server stop must complete before finalize starts: ${JSON.stringify(events)}`,
          );
          // Exactly one teardown -- the finally must not double-stop.
          assert.equal(
            events.filter((entry) => entry === "stop:start").length,
            1,
            `expected exactly one stop: ${JSON.stringify(events)}`,
          );
          assert.equal(events.filter((entry) => entry === "finalize").length, 1);
        },
        { window: global.window },
      );
    } finally {
      global.window = previousWindow;
    }
  });
}

// --- PORTICO-339 follow-up: Skip must survive outages ----------------------------
// The old gate hid Skip unless a LATER server was still pending, which hard-
// blocked users exactly when one flaky integration remained (live repro:
// Glean outage, 4 of 5 servers already tokened, Glean priority-sorted first).

function buildSkipVisibilityServers(statuses) {
  const names = ["glean", "google_workspace", "mcp-atlassian", "data-plat-mcp", "slack"];
  return statuses.map((status, index) => ({
    server: { id: names[index] },
    metadata: { id: names[index], display_name: names[index], name: names[index] },
    status,
    preConfigured: false,
  }));
}

test("skip stays available on the only remaining pending server", async () => {
  await withOauthDom(async ({ elements }) => {
    const mod = loadModule();

    // The exact logged scenario: current server first (priority sort), the
    // other four already done -- previously rendered with NO skip at all.
    mod._test.setOauthScreenState({
      currentIndex: 0,
      queueStarted: false,
      flowLocked: false,
      servers: buildSkipVisibilityServers(["current", "done", "done", "done", "done"]),
    });
    mod._test.renderOAuthStage();
    mod._test.updateNavigationButtons();

    assert.equal(elements["oauth-stage-authorize-btn"].textContent, "Connect");
    assert.equal(
      elements["oauth-stage-next-btn"].style.display,
      "inline-flex",
      "Skip must render for the last actionable server",
    );
    assert.equal(
      elements["oauth-stage-skip-all-btn"].style.display,
      "none",
      "Skip All is redundant when only the current server remains",
    );
    mod._test.updateCurrentServerUI();
    assert.equal(
      elements["oauth-stage-progress-text"].textContent,
      "Server 5 of 5",
      "counter must reflect progress, not sort position",
    );
  });
});

test("skip hides while the current server is processing or already processed", async () => {
  await withOauthDom(async ({ elements }) => {
    const mod = loadModule();

    mod._test.setOauthScreenState({
      currentIndex: 0,
      queueStarted: false,
      flowLocked: false,
      servers: buildSkipVisibilityServers(["waiting", "pending", "done", "done", "done"]),
    });
    mod._test.updateNavigationButtons();
    assert.equal(elements["oauth-stage-next-btn"].style.display, "none");
    assert.equal(elements["oauth-stage-skip-all-btn"].style.display, "none");

    mod._test.setOauthScreenState({
      currentIndex: 0,
      queueStarted: false,
      flowLocked: false,
      servers: buildSkipVisibilityServers(["done", "done", "done", "done", "done"]),
    });
    mod._test.updateNavigationButtons();
    assert.equal(elements["oauth-stage-next-btn"].style.display, "none");
    assert.equal(elements["oauth-stage-skip-all-btn"].style.display, "none");
  });
});

test("skip and skip-all both show while later servers are still pending", async () => {
  await withOauthDom(async ({ elements }) => {
    const mod = loadModule();

    mod._test.setOauthScreenState({
      currentIndex: 0,
      queueStarted: false,
      flowLocked: false,
      servers: buildSkipVisibilityServers(["current", "pending", "pending", "done", "done"]),
    });
    mod._test.updateNavigationButtons();
    assert.equal(elements["oauth-stage-next-btn"].style.display, "inline-flex");
    assert.equal(elements["oauth-stage-skip-all-btn"].style.display, "inline-flex");
  });
});

test("success card offers Skip down to the last remaining server, without a redundant Skip All", async () => {
  await withOauthDom(async ({ elements }) => {
    const mod = loadModule();

    mod._test.setOauthScreenState({
      currentIndex: 0,
      queueStarted: false,
      flowLocked: false,
      servers: buildSkipVisibilityServers(["done", "pending", "done", "done", "done"]),
    });
    mod._test.showCompletedServerState(mod._test.getOauthScreenState().servers[0]);

    const html = elements["oauth-stage-testing-content"].innerHTML;
    assert.match(html, /id="oauth-test-skip-btn"/);
    assert.doesNotMatch(html, /id="oauth-test-skip-all-btn"/);
  });
});
