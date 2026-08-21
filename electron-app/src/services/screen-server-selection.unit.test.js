const test = require("node:test");
const assert = require("node:assert/strict");

const { FakeElement } = require("./test-helpers/fake-dom");

function loadModule() {
  const modulePath = require.resolve(
    "../renderer/screens/guided-setup/screen-server-selection",
  );
  delete require.cache[modulePath];
  return require("../renderer/screens/guided-setup/screen-server-selection");
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

function withServerSelectionDom(run) {
  const serverGrid = new FakeElement("all-server-grid");
  const proceedBtn = new FakeElement("proceed-btn");
  const selectAllBtn = new FakeElement("select-all-btn");
  const subtitle = new FakeElement("subtitle");
  let serverGridHtml = "";
  Object.defineProperty(serverGrid, "innerHTML", {
    configurable: true,
    get() {
      return serverGridHtml;
    },
    set(value) {
      serverGridHtml = String(value);
      if (serverGridHtml === "") {
        serverGrid.children = [];
      }
    },
  });
  const appendChild = serverGrid.appendChild.bind(serverGrid);
  serverGrid.appendChild = (child) => {
    if (child?.nodeType === 11 && Array.isArray(child.children)) {
      child.children.forEach((fragmentChild) => appendChild(fragmentChild));
      child.children = [];
      return child;
    }

    return appendChild(child);
  };
  const registry = new Map();
  const subtitleParent = {
    inserted: [],
    insertBefore(child) {
      this.inserted.push(child);
      registry.set(child.id, child);
    },
  };
  subtitle.parentNode = subtitleParent;

  const previousDocument = global.document;
  global.document = {
    getElementById(id) {
      if (id === "all-server-grid") return serverGrid;
      if (id === "proceed-btn") return proceedBtn;
      if (id === "select-all-btn") return selectAllBtn;
      return registry.get(id) || null;
    },
    querySelector(selector) {
      if (selector === "#stage-server-selection .subtitle") {
        return subtitle;
      }

      const match = selector.match(/\.mcp-server-card\[data-index="(\d+)"\]/);
      if (match) {
        return registry.get(`card-${match[1]}`) || null;
      }

      return null;
    },
    createDocumentFragment() {
      return {
        nodeType: 11,
        children: [],
        appendChild(child) {
          this.children.push(child);
          return child;
        },
      };
    },
  };

  try {
    return run({
      serverGrid,
      proceedBtn,
      selectAllBtn,
      subtitleParent,
      registerCard(index, card) {
        registry.set(`card-${index}`, card);
      },
    });
  } finally {
    global.document = previousDocument;
  }
}

function createCard(server, index) {
  const card = new FakeElement(`card-${index}`);
  card.className = "mcp-server-card";
  card.dataset.serverId = server.id;
  card.dataset.index = String(index);
  const indicator = new FakeElement(`indicator-${index}`);
  card.querySelector = (selector) => {
    if (selector === ".mcp-card-selection-indicator") {
      return indicator;
    }
    return null;
  };
  card.indicator = indicator;
  return card;
}

test("populateServerGrid filters unsupported entries and sorts eligible servers by guided setup priority", () => {
  withServerSelectionDom(
    ({ serverGrid, subtitleParent, registerCard }) => {
      const mod = loadModule();
      const setupState = {
        hostModeSupported: false,
        selectedServers: [],
        mcpServers: [
          { id: "skills", display_name: "Skills", isCore: true },
          { id: "custom", display_name: "Custom", userInstalled: true },
          {
            id: "chrome-devtools",
            display_name: "Chrome DevTools",
            deploymentType: "host",
          },
          {
            id: "data-plat-mcp",
            display_name: "Data Platform",
            required_env_vars: [{ name: "TOKEN" }],
          },
          {
            id: "glean",
            display_name: "Glean",
            oauth: { requires_user_authorization: true },
          },
          {
            id: "mcp-atlassian",
            display_name: "Atlassian",
            oauth: { requires_user_authorization: true },
          },
          { id: "ownership-mcp", display_name: "Ownership" },
        ],
      };

      mod.populateServerGrid(setupState, {
        createHostWarning() {
          const warning = new FakeElement("host-warning-message");
          return warning;
        },
        createServerCard(server, index) {
          const card = createCard(server, index);
          registerCard(index, card);
          return card;
        },
        isServerConfigured() {
          return false;
        },
      });

      assert.deepEqual(
        serverGrid.children.map((card) => card.dataset.serverId),
        ["mcp-atlassian", "glean", "data-plat-mcp", "ownership-mcp"],
      );
      assert.equal(subtitleParent.inserted.length, 1);
      assert.equal(subtitleParent.inserted[0].id, "host-warning-message");
      assert.equal(mod.getServerCategory(setupState.mcpServers[4]), 1);
      assert.equal(mod.getServerCategory(setupState.mcpServers[3]), 2);
      assert.equal(mod.getServerCategory(setupState.mcpServers[6]), 3);
    },
  );
});

test("populateServerGrid applies hydrated first-entry selections to cards and actions", () => {
  withServerSelectionDom(({ proceedBtn, selectAllBtn, registerCard }) => {
    const mod = loadModule();
    const setupState = {
      hostModeSupported: true,
      selectedServers: [0, 1],
      mcpServers: [
        {
          id: "data-plat-mcp",
          display_name: "Data Platform",
          required_env_vars: [{ name: "TOKEN" }],
        },
        {
          id: "glean",
          display_name: "Glean",
          oauth: { requires_user_authorization: true },
        },
        { id: "skills", display_name: "Skills", isCore: true },
      ],
    };

    mod.populateServerGrid(setupState, {
      createServerCard(server, index) {
        const card = createCard(server, index);
        registerCard(index, card);
        return card;
      },
      isServerConfigured(server) {
        return server.id === "data-plat-mcp";
      },
    });

    const dataPlatCard = global.document.querySelector(
      '.mcp-server-card[data-index="0"]',
    );
    const gleanCard = global.document.querySelector(
      '.mcp-server-card[data-index="1"]',
    );

    assert.equal(dataPlatCard.classList.contains("selected"), true);
    assert.equal(dataPlatCard.classList.contains("configured"), true);
    assert.match(dataPlatCard.indicator.innerHTML, /polyline/);
    assert.equal(gleanCard.classList.contains("selected"), true);
    assert.equal(gleanCard.classList.contains("configured"), false);
    assert.match(gleanCard.indicator.innerHTML, /polyline/);
    assert.equal(proceedBtn.disabled, false);
    assert.equal(selectAllBtn.textContent, "Deselect all");
    assert.equal(selectAllBtn.getAttribute("aria-pressed"), "true");
  });
});

test("toggleServerSelection updates selected state and ignores non-toggleable servers", () => {
  withServerSelectionDom(({ proceedBtn, selectAllBtn, registerCard }) => {
    const mod = loadModule();
    const setupState = {
      hostModeSupported: false,
      selectedServers: [],
      mcpServers: [
        {
          id: "data-plat-mcp",
          display_name: "Data Platform",
          required_env_vars: [{ name: "TOKEN" }],
        },
        { id: "custom", display_name: "Custom", userInstalled: true },
        { id: "skills", display_name: "Skills", isCore: true },
        {
          id: "chrome-devtools",
          display_name: "Chrome DevTools",
          deploymentType: "host",
        },
      ],
    };

    setupState.mcpServers.forEach((server, index) => {
      registerCard(index, createCard(server, index));
    });

    mod.toggleServerSelection(0, setupState, {
      isServerConfigured(server) {
        return server.id === "data-plat-mcp";
      },
    });

    const eligibleCard = global.document.querySelector(
      '.mcp-server-card[data-index="0"]',
    );
    assert.deepEqual(setupState.selectedServers, [0]);
    assert(eligibleCard.classList.contains("selected"));
    assert(eligibleCard.classList.contains("configured"));
    assert.match(eligibleCard.indicator.innerHTML, /polyline/);
    assert.equal(proceedBtn.disabled, false);
    assert.equal(selectAllBtn.textContent, "Deselect all");
    assert.equal(selectAllBtn.getAttribute("aria-pressed"), "true");

    mod.toggleServerSelection(0, setupState, {
      isServerConfigured() {
        return true;
      },
    });
    assert.deepEqual(setupState.selectedServers, []);
    assert.equal(eligibleCard.classList.contains("selected"), false);
    assert.equal(eligibleCard.indicator.innerHTML, "");

    mod.toggleServerSelection(1, setupState);
    mod.toggleServerSelection(2, setupState);
    mod.toggleServerSelection(3, setupState);
    assert.deepEqual(setupState.selectedServers, []);
  });
});

test("populateServerGrid keeps contractor-disabled Data Platform visible with tooltip-only disabled metadata", () => {
  withServerSelectionDom(({ serverGrid, registerCard }) => {
    const mod = loadModule();
    const createServerCardCalls = [];
    const setupState = {
      hostModeSupported: true,
      selectedServers: [],
      guidedSetupDisabledServerIds: new Set(["data-plat-mcp"]),
      guidedSetupDisabledTooltips: {
        "data-plat-mcp": "Unavailable during guided setup for contractor accounts.",
      },
      mcpServers: [
        {
          id: "data-plat-mcp",
          display_name: "Data Platform",
          oauth: { requires_user_authorization: true },
        },
        {
          id: "glean",
          display_name: "Glean",
          oauth: { requires_user_authorization: true },
        },
      ],
    };

    mod.populateServerGrid(setupState, {
      createServerCard(server, index, isConfigured, hostModeSupported, options) {
        createServerCardCalls.push({ server, index, options });
        const card = createCard(server, index);
        registerCard(index, card);
        return card;
      },
      isServerConfigured() {
        return false;
      },
    });

    assert.deepEqual(
      serverGrid.children.map((card) => card.dataset.serverId),
      ["data-plat-mcp", "glean"],
    );
    assert.equal(createServerCardCalls[0].options.guidedSetupDisabled, true);
    assert.match(
      createServerCardCalls[0].options.guidedSetupDisabledTooltip,
      /Unavailable during guided setup/,
    );
    assert.equal(
      global.document.querySelector('.mcp-server-card[data-index="0"]').dataset.tooltip,
      "Unavailable during guided setup for contractor accounts.",
    );
  });
});

test("contractor-disabled Data Platform cannot be toggled or included by select all", () => {
  withServerSelectionDom(({ selectAllBtn, registerCard }) => {
    const mod = loadModule();
    const setupState = {
      hostModeSupported: true,
      selectedServers: [],
      guidedSetupDisabledServerIds: new Set(["data-plat-mcp"]),
      guidedSetupDisabledTooltips: {
        "data-plat-mcp": "Unavailable during guided setup for contractor accounts.",
      },
      mcpServers: [
        { id: "data-plat-mcp", display_name: "Data Platform" },
        { id: "ownership-mcp", display_name: "Ownership" },
      ],
    };

    setupState.mcpServers.forEach((server, index) => {
      registerCard(index, createCard(server, index));
    });

    mod.toggleServerSelection(0, setupState);
    assert.deepEqual(setupState.selectedServers, []);

    selectAllBtn.textContent = "Select all";
    selectAllBtn.setAttribute("aria-pressed", "false");
    mod.selectAllServers(setupState);
    assert.deepEqual(setupState.selectedServers, [1]);
  });
});

test("selectAllServers toggles all eligible non-core servers and keeps button copy in sync", () => {
  withServerSelectionDom(({ selectAllBtn, registerCard }) => {
    const mod = loadModule();
    const setupState = {
      hostModeSupported: true,
      selectedServers: [],
      mcpServers: [
        { id: "ownership-mcp", display_name: "Ownership" },
        { id: "skills", display_name: "Skills", isCore: true },
        { id: "custom", display_name: "Custom", userInstalled: true },
        { id: "teamworks-mcp", display_name: "Teamworks" },
      ],
    };

    setupState.mcpServers.forEach((server, index) => {
      registerCard(index, createCard(server, index));
    });

    selectAllBtn.textContent = "Select all";
    selectAllBtn.setAttribute("aria-pressed", "false");
    mod.selectAllServers(setupState);
    assert.deepEqual(setupState.selectedServers.sort((a, b) => a - b), [0, 3]);
    assert.equal(selectAllBtn.textContent, "Deselect all");
    assert.equal(selectAllBtn.getAttribute("aria-pressed"), "true");
    assert.equal(
      selectAllBtn.title,
      "Clear the current guided setup selection",
    );

    mod.selectAllServers(setupState);
    assert.deepEqual(setupState.selectedServers, []);
    assert.equal(selectAllBtn.textContent, "Select all");
    assert.equal(selectAllBtn.getAttribute("aria-pressed"), "false");
    assert.equal(
      selectAllBtn.title,
      "Select all visible guided setup integrations",
    );
  });
});

test("skipServerSelection preserves persisted toggles and continues immediately", () => {
  const mod = loadModule();
  const setupState = {
    mcpServers: [
      { id: "skills", isCore: true },
      { id: "subagents", isCore: true },
      { id: "glean" },
    ],
    selectedServers: [2],
    mcpToggleState: {
      baseline: { toggles: { glean: true } },
      changes: { glean: false },
      writeMode: "apply",
    },
  };
  let proceeded = 0;

  mod.skipServerSelection(setupState, {
    proceedToConfiguration() {
      proceeded += 1;
    },
  });

  assert.deepEqual(setupState.selectedServers, []);
  assert.deepEqual(setupState.mcpToggleState.changes, {});
  assert.equal(setupState.mcpToggleState.writeMode, "preserve");
  assert.equal(proceeded, 1);
});

test("proceedToConfiguration merges non-sensitive presets without hydrating sensitive tokens", async () => {
  const mod = loadModule();
  const setupState = {
    selectedServers: [0, 1, 2],
    envVars: {
      SOURCEGRAPH_URL: "https://custom-sourcegraph.example",
      INTERNAL_MCP_URL: "your-api-url",
    },
    mcpServers: [
      {
        id: "gitlab-mcp",
        display_name: "GitLab",
        isConfigured: true,
        required_env_vars: [
          { name: "GITLAB_PERSONAL_ACCESS_TOKEN", sensitive: true },
        ],
        presetVars: [
          { name: "GITLAB_API_URL", value: "https://example.invalid/api/v4" },
          { name: "GITLAB_PERSONAL_ACCESS_TOKEN", value: "must-not-hydrate" },
        ],
      },
      {
        id: "sourcegraph",
        display_name: "Sourcegraph",
        isConfigured: true,
        required_env_vars: [{ name: "SOURCEGRAPH_TOKEN", sensitive: true }],
        presetVars: [{ name: "SOURCEGRAPH_URL", value: "https://portico.sourcegraph.com" }],
      },
      {
        id: "internal-mcp",
        display_name: "Internal MCP",
        isConfigured: true,
        required_env_vars: [{ name: "INTERNAL_MCP_TOKEN", sensitive: true }],
        presetVars: [
          { name: "INTERNAL_MCP_URL", value: "https://mcp.example.com/" },
        ],
      },
    ],
    serverConfigs: [],
    completedSteps: { serverSelection: false, oauth: false, servers: {} },
    configuredServers: new Set(),
    preConfiguredServers: new Set(),
    skippedServers: new Set(),
    completedOAuthServers: new Set(),
    skippedOAuthServers: new Set(),
  };
  const shownStages = [];

  await withImmediateTimeout(async () => {
    await mod.proceedToConfiguration(setupState, {
      isPlaceholderValue(value) {
        return /^your[-_]/i.test(value);
      },
      isServerConfigured(server) {
        return server.isConfigured === true;
      },
      findNextPendingConfigurationIndex() {
        return -1;
      },
      showStage(stage) {
        shownStages.push(stage);
      },
    });
  });

  assert.deepEqual(setupState.serverConfigs.map((server) => server.id), [
    "gitlab-mcp",
    "sourcegraph",
    "internal-mcp",
  ]);
  assert.equal(setupState.configuredServers.has("gitlab-mcp"), true);
  assert.equal(setupState.configuredServers.has("sourcegraph"), true);
  assert.equal(setupState.configuredServers.has("internal-mcp"), true);
  assert.equal(setupState.preConfiguredServers.has("gitlab-mcp"), true);
  assert.equal(setupState.preConfiguredServers.has("sourcegraph"), true);
  assert.equal(setupState.preConfiguredServers.has("internal-mcp"), true);
  assert.equal(setupState.envVars.GITLAB_API_URL, "https://example.invalid/api/v4");
  assert.equal(setupState.envVars.SOURCEGRAPH_URL, "https://custom-sourcegraph.example");
  assert.equal(setupState.envVars.INTERNAL_MCP_URL, "https://mcp.example.com/");
  assert.equal(setupState.envVars.GITLAB_PERSONAL_ACCESS_TOKEN, undefined);
  assert.deepEqual(shownStages, ["finalize"]);
});

test("proceedToConfiguration routes to oauth when pending OAuth work exists", async () => {
  const mod = loadModule();
  const setupState = {
    selectedServers: [0, 1],
    mcpServers: [
      {
        id: "glean",
        display_name: "Glean",
        oauth: { requires_user_authorization: true },
      },
      {
        id: "data-plat-mcp",
        display_name: "Data Platform",
        required_env_vars: [{ name: "TOKEN" }],
      },
    ],
    serverConfigs: [],
    completedSteps: { serverSelection: false, oauth: false, servers: {} },
    configuredServers: new Set(["old"]),
    preConfiguredServers: new Set(["old"]),
    skippedServers: new Set(["old"]),
    completedOAuthServers: new Set(["old"]),
    skippedOAuthServers: new Set(["old"]),
  };

  const shownStages = [];
  let progressUpdates = 0;

  await mod.proceedToConfiguration(setupState, {
    updateProgressTracker() {
      progressUpdates += 1;
    },
    analyzeOAuthServers() {
      return {
        servers: [setupState.mcpServers[0]],
        completedServerIds: [],
        pendingCount: 1,
      };
    },
    isServerConfigured() {
      return false;
    },
    showStage(stage) {
      shownStages.push(stage);
    },
  });

  assert.equal(setupState.completedSteps.serverSelection, true);
  assert.equal(setupState.oauthStepRequired, true);
  assert.equal(setupState.completedSteps.oauth, false);
  assert.deepEqual(setupState.serverConfigs.map((server) => server.id), [
    "data-plat-mcp",
  ]);
  assert.equal(setupState.configuredServers.size, 0);
  assert.equal(setupState.preConfiguredServers.size, 0);
  assert.equal(setupState.skippedServers.size, 0);
  assert.equal(setupState.completedOAuthServers.size, 0);
  assert.equal(setupState.currentOAuthIndex, 0);
  assert.deepEqual(shownStages, ["oauth"]);
  assert.equal(progressUpdates, 2);
});

test("proceedToConfiguration keeps a dual-requirement server in both setup queues", async () => {
  const mod = loadModule();
  const setupState = {
    selectedServers: [0],
    mcpServers: [
      {
        id: "hybrid-mcp",
        display_name: "Hybrid MCP",
        oauth: { requires_user_authorization: true },
        required_env_vars: [{ name: "API_KEY" }],
      },
    ],
    serverConfigs: [],
    completedSteps: { serverSelection: false, oauth: false, servers: {} },
    configuredServers: new Set(),
    preConfiguredServers: new Set(),
    skippedServers: new Set(),
    completedOAuthServers: new Set(),
    skippedOAuthServers: new Set(),
  };
  const shownStages = [];

  await mod.proceedToConfiguration(setupState, {
    analyzeOAuthServers(servers) {
      return {
        servers,
        completedServerIds: [],
        pendingCount: servers.length,
      };
    },
    isServerConfigured() {
      return false;
    },
    showStage(stage) {
      shownStages.push(stage);
    },
  });

  assert.deepEqual(setupState.oauthServers.map((server) => server.id), ["hybrid-mcp"]);
  assert.deepEqual(setupState.serverConfigs.map((server) => server.id), ["hybrid-mcp"]);
  assert.equal(setupState.configuredServers.size, 0);
  assert.deepEqual(shownStages, ["oauth"]);
});

test("proceedToConfiguration tracks existing configuration without skipping pending OAuth", async () => {
  const mod = loadModule();
  const setupState = {
    selectedServers: [0],
    mcpServers: [
      {
        id: "hybrid-mcp",
        display_name: "Hybrid MCP",
        oauth: { requires_user_authorization: true },
        required_env_vars: [{ name: "API_KEY" }],
      },
    ],
    serverConfigs: [],
    completedSteps: { serverSelection: false, oauth: false, servers: {} },
    configuredServers: new Set(),
    skippedServers: new Set(),
    completedOAuthServers: new Set(),
    skippedOAuthServers: new Set(),
  };
  const shownStages = [];

  await mod.proceedToConfiguration(setupState, {
    analyzeOAuthServers(servers) {
      return {
        servers,
        completedServerIds: [],
        pendingCount: servers.length,
      };
    },
    isServerConfigured() {
      return true;
    },
    showStage(stage) {
      shownStages.push(stage);
    },
  });

  assert.deepEqual(setupState.oauthServers.map((server) => server.id), ["hybrid-mcp"]);
  assert.deepEqual(setupState.serverConfigs.map((server) => server.id), ["hybrid-mcp"]);
  assert.deepEqual([...setupState.configuredServers], ["hybrid-mcp"]);
  assert.deepEqual(shownStages, ["oauth"]);
});

test("proceedToConfiguration strips contractor-disabled Data Platform from guided setup work", async () => {
  const mod = loadModule();
  const setupState = {
    selectedServers: [0, 1],
    guidedSetupDisabledServerIds: new Set(["data-plat-mcp"]),
    mcpServers: [
      {
        id: "data-plat-mcp",
        display_name: "Data Platform",
        oauth: { requires_user_authorization: true },
      },
      {
        id: "glean",
        display_name: "Glean",
        oauth: { requires_user_authorization: true },
      },
    ],
    serverConfigs: [],
    completedSteps: { serverSelection: false, oauth: false, servers: {} },
    configuredServers: new Set(),
    preConfiguredServers: new Set(),
    skippedServers: new Set(),
    completedOAuthServers: new Set(),
    skippedOAuthServers: new Set(),
  };

  const shownStages = [];

  await mod.proceedToConfiguration(setupState, {
    analyzeOAuthServers(servers) {
      return {
        servers,
        completedServerIds: [],
        pendingCount: servers.length,
      };
    },
    isServerConfigured() {
      return false;
    },
    showStage(stage) {
      shownStages.push(stage);
    },
  });

  assert.deepEqual(setupState.selectedServers, [1]);
  assert.deepEqual(setupState.oauthServers.map((server) => server.id), ["glean"]);
  assert.deepEqual(setupState.serverConfigs, []);
  assert.deepEqual(shownStages, ["oauth"]);
});

test("proceedToConfiguration skips oauth when selections are already authorized and lands on the next pending config server", async () => {
  const mod = loadModule();
  const setupState = {
    selectedServers: [0, 1, 2],
    mcpServers: [
      {
        id: "glean",
        display_name: "Glean",
        oauth: { requires_user_authorization: true },
      },
      {
        id: "data-plat-mcp",
        display_name: "Data Platform",
        required_env_vars: [{ name: "TOKEN" }],
      },
      {
        id: "sourcegraph",
        display_name: "Sourcegraph",
        required_env_vars: [{ name: "SOURCEGRAPH_TOKEN" }],
      },
    ],
    serverConfigs: [],
    completedSteps: { serverSelection: false, oauth: false, servers: {} },
    configuredServers: new Set(),
    preConfiguredServers: new Set(),
    skippedServers: new Set(),
    completedOAuthServers: new Set(),
    skippedOAuthServers: new Set(),
  };

  const loadedConfigs = [];

  await mod.proceedToConfiguration(setupState, {
    analyzeOAuthServers() {
      return {
        servers: [setupState.mcpServers[0]],
        completedServerIds: ["glean"],
        pendingCount: 0,
      };
    },
    isServerConfigured(server) {
      return server.id === "data-plat-mcp";
    },
    findNextPendingConfigurationIndex() {
      return 1;
    },
    async loadServerConfiguration(index) {
      loadedConfigs.push(index);
    },
  });

  assert.equal(setupState.oauthStepRequired, false);
  assert.equal(setupState.completedSteps.oauth, true);
  assert.equal(setupState.completedOAuthServers.has("glean"), true);
  assert.equal(setupState.configuredServers.has("data-plat-mcp"), true);
  assert.equal(setupState.preConfiguredServers.has("data-plat-mcp"), true);
  assert.equal(setupState.currentServerIndex, 1);
  assert.deepEqual(loadedConfigs, [1]);
});

test("proceedToConfiguration finalizes when every config-required server is already configured", async () => {
  const mod = loadModule();
  const setupState = {
    selectedServers: [0],
    mcpServers: [
      {
        id: "data-plat-mcp",
        display_name: "Data Platform",
        required_env_vars: [{ name: "TOKEN" }],
      },
    ],
    serverConfigs: [],
    completedSteps: { serverSelection: false, oauth: false, servers: {} },
    configuredServers: new Set(),
    preConfiguredServers: new Set(),
    skippedServers: new Set(),
    completedOAuthServers: new Set(),
    skippedOAuthServers: new Set(),
  };
  const shownStages = [];
  let finalized = 0;

  await withImmediateTimeout(async () => {
    await mod.proceedToConfiguration(setupState, {
      isServerConfigured() {
        return true;
      },
      findNextPendingConfigurationIndex() {
        return -1;
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
  assert.equal(setupState.preConfiguredServers.has("data-plat-mcp"), true);
});

test("proceedToConfiguration goes straight to finalize when nothing needs oauth or configuration", async () => {
  const mod = loadModule();
  const setupState = {
    selectedServers: [0],
    mcpServers: [{ id: "ownership-mcp", display_name: "Ownership" }],
    serverConfigs: [],
    completedSteps: { serverSelection: false, oauth: false, servers: {} },
    configuredServers: new Set(),
    skippedServers: new Set(),
    completedOAuthServers: new Set(),
    skippedOAuthServers: new Set(),
  };

  const shownStages = [];
  let finalized = 0;

  await withImmediateTimeout(async () => {
    await mod.proceedToConfiguration(setupState, {
      showStage(stage) {
        shownStages.push(stage);
      },
      finalizeSetup() {
        finalized += 1;
      },
    });
  });

  assert.equal(setupState.oauthStepRequired, false);
  assert.equal(setupState.completedSteps.oauth, true);
  assert.deepEqual(shownStages, ["finalize"]);
  assert.equal(finalized, 1);
});

test("proceedToConfiguration with zero selections marks oauth complete and finalizes", async () => {
  const mod = loadModule();
  const setupState = {
    selectedServers: [],
    mcpServers: [],
    completedSteps: { serverSelection: false, oauth: false, servers: {} },
  };
  const shownStages = [];

  await mod.proceedToConfiguration(setupState, {
    showStage(stage) {
      shownStages.push(stage);
    },
  });

  assert.equal(setupState.oauthStepRequired, false);
  assert.equal(setupState.completedSteps.oauth, true);
  assert.deepEqual(shownStages, ["finalize"]);
});
