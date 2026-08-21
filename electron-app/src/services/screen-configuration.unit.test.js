const test = require("node:test");
const assert = require("node:assert/strict");

const { FakeElement } = require("./test-helpers/fake-dom");

function loadModule() {
  const modulePath = require.resolve(
    "../renderer/screens/guided-setup/screen-configuration",
  );
  delete require.cache[modulePath];
  return require("../renderer/screens/guided-setup/screen-configuration");
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

function createInput(varNameRaw, value) {
  const input = new FakeElement(`input-${varNameRaw}`);
  input.className = "input-field";
  input.dataset.var = varNameRaw;
  input.value = value;
  const errorEl = new FakeElement(`error-${varNameRaw}`);
  errorEl.classList = {
    classes: new Set(),
    add(name) {
      this.classes.add(name);
    },
    remove(name) {
      this.classes.delete(name);
    },
    contains(name) {
      return this.classes.has(name);
    },
  };
  const wrapper = new FakeElement(`wrapper-${varNameRaw}`);
  wrapper.querySelector = (selector) => {
    if (selector === ".input-error") {
      return errorEl;
    }
    return null;
  };
  input.parentElement = wrapper;
  input.errorEl = errorEl;
  return input;
}

function createConfirmationCard(id, options = {}) {
  const card = new FakeElement(id);
  card.className = "confirmation-card";
  if (options.hidden) {
    card.style.display = "none";
  }

  const accordionContent = new FakeElement(`${id}-content`);
  const accordion =
    options.accordion || new FakeElement(`${id}-accordion`);
  if (options.accordionClassName) {
    accordion.className = options.accordionClassName;
  } else if (!accordion.classList.contains("accordion-section")) {
    accordion.classList.add("accordion-section");
  }
  accordionContent.parentElement = accordion;
  card.parentElement = accordionContent;

  if (options.afterContentVisible !== undefined) {
    const afterContent = new FakeElement(`after-${id}`);
    afterContent.className = options.afterContentVisible
      ? "content-after-confirmation visible"
      : "content-after-confirmation";
    accordionContent.parentElement = afterContent;
    afterContent.parentElement = accordion;
    card.parentElement = accordionContent;
  }

  return { card, accordion };
}

function createConfigurationDocument({
  inputs = [],
  titleNode = null,
  firstAccordion = null,
  confirmationCards = [],
  scrollContainer = null,
  elements = {},
} = {}) {
  const configContent = elements["config-content"] || new FakeElement("config-content");
  const saveButton = elements["save-btn"] || new FakeElement("save-btn");
  const titleElement =
    elements["configuration-card-title"] ||
    new FakeElement("configuration-card-title");

  configContent.querySelector = (selector) => {
    if (selector === "h1") {
      return titleNode;
    }
    if (selector === ".accordion-section") {
      return firstAccordion;
    }
    return null;
  };

  configContent.querySelectorAll = (selector) => {
    if (selector === ".input-field:not([disabled])") {
      return inputs.filter((input) => !input.disabled);
    }
    if (selector === ".input-field") {
      return inputs;
    }
    if (
      selector === ".accordion-section.is-guidance-pulsing" &&
      firstAccordion?.classList?.contains?.("is-guidance-pulsing")
    ) {
      return [firstAccordion];
    }
    if (selector === ".confirmation-card") {
      return confirmationCards;
    }
    if (selector === ".confirmation-card.is-guidance-pulsing") {
      return confirmationCards.filter((card) =>
        card.classList?.contains?.("is-guidance-pulsing"),
      );
    }
    return [];
  };

  const elementMap = {
    "config-content": configContent,
    "save-btn": saveButton,
    "configuration-card-title": titleElement,
    ...elements,
  };

  if (firstAccordion?.id) {
    elementMap[firstAccordion.id] = firstAccordion;
  }
  confirmationCards.forEach((card) => {
    if (card?.id) {
      elementMap[card.id] = card;
    }
  });

  return {
    configContent,
    saveButton,
    titleElement,
    document: {
      querySelector(selector) {
        if (selector === ".content-scroll-area") {
          return scrollContainer;
        }
        return null;
      },
      querySelectorAll(selector) {
        if (selector === ".setup-stage.active .input-field:not([disabled])") {
          return inputs.filter((input) => !input.disabled);
        }
        return [];
      },
      getElementById(id) {
        return elementMap[id] || null;
      },
    },
  };
}

async function withInputs(inputs, run, options = {}) {
  const previousDocument = global.document;
  const dom = createConfigurationDocument({
    inputs,
    elements: options.elements,
  });
  global.document = dom.document;

  try {
    return await run(dom);
  } finally {
    global.document = previousDocument;
  }
}

function withDocument(doc, run) {
  const previousDocument = global.document;
  global.document = doc;
  let result;
  try {
    result = run();
  } finally {
    if (!result || typeof result.then !== "function") {
      global.document = previousDocument;
    }
  }

  if (!result || typeof result.then !== "function") {
    return result;
  }

  return result.finally(() => {
    global.document = previousDocument;
  });
}

test("loadServerConfiguration finalizes immediately when there are no more configuration servers", async () => {
  const mod = loadModule();
  const setupState = {
    serverConfigs: [],
    configuredServers: new Set(),
  };
  const shownStages = [];

  await mod.loadServerConfiguration(0, setupState, {
    showStage(stage) {
      shownStages.push(stage);
    },
  });

  assert.deepEqual(shownStages, ["finalize"]);
});

test("getNextPendingConfigurationIndex skips configured and skipped servers", () => {
  const mod = loadModule();
  const setupState = {
    serverConfigs: [
      { id: "gitlab" },
      { id: "slack" },
      { id: "sourcegraph" },
      { id: "teamworks-mcp" },
    ],
    configuredServers: new Set(["gitlab", "sourcegraph"]),
    skippedServers: new Set(["slack"]),
  };

  assert.equal(mod.getNextPendingConfigurationIndex(setupState, 0), 3);
  assert.equal(mod.getNextPendingConfigurationIndex(setupState, 3), 3);
  assert.equal(mod.getNextPendingConfigurationIndex(setupState, 4), -1);
});

test("syncConfigurationSkipAllButtonVisibility only shows Skip All when later pending servers remain", () => {
  const mod = loadModule();
  const skipAllButton = new FakeElement("skip-all-servers-btn");
  skipAllButton.disabled = true;
  skipAllButton.textContent = "Skipping Remaining...";
  const dom = createConfigurationDocument({
    elements: {
      "skip-all-servers-btn": skipAllButton,
    },
  });

  withDocument(dom.document, () => {
    assert.equal(
      mod.hasAdditionalPendingConfigurationServers({
        serverConfigs: [{ id: "glean" }],
        currentServerIndex: 0,
        configuredServers: new Set(),
        skippedServers: new Set(),
      }),
      false,
    );
    assert.equal(
      mod.syncConfigurationSkipAllButtonVisibility({
        serverConfigs: [{ id: "glean" }],
        currentServerIndex: 0,
        configuredServers: new Set(),
        skippedServers: new Set(),
      }),
      false,
    );
    assert.equal(skipAllButton.style.display, "none");

    assert.equal(
      mod.hasAdditionalPendingConfigurationServers({
        serverConfigs: [
          { id: "glean" },
          { id: "slack" },
        ],
        currentServerIndex: 0,
        configuredServers: new Set(),
        skippedServers: new Set(),
      }),
      true,
    );
    assert.equal(
      mod.syncConfigurationSkipAllButtonVisibility({
        serverConfigs: [
          { id: "glean" },
          { id: "slack" },
        ],
        currentServerIndex: 0,
        configuredServers: new Set(),
        skippedServers: new Set(),
      }),
      true,
    );
    assert.equal(skipAllButton.style.display, "");
    assert.equal(skipAllButton.disabled, false);
    assert.equal(skipAllButton.textContent, "Skip All");
  });
});

test("evaluateConfigurationReadiness requires every active input to validate", () => {
  const mod = loadModule();
  const valid = createInput("TOKEN", "secret");
  const invalid = createInput("TEAM", "   ");

  const readyResult = mod.evaluateConfigurationReadiness([valid], {});
  const invalidResult = mod.evaluateConfigurationReadiness([valid, invalid], {});
  const confirmationBlocked = mod.evaluateConfigurationReadiness([valid], {}, {
    unresolvedConfirmationCount: 1,
  });

  assert.deepEqual(readyResult, {
    ready: true,
    activeInputCount: 1,
    unresolvedConfirmationCount: 0,
  });
  assert.deepEqual(invalidResult, {
    ready: false,
    activeInputCount: 2,
    unresolvedConfirmationCount: 0,
  });
  assert.deepEqual(confirmationBlocked, {
    ready: false,
    activeInputCount: 1,
    unresolvedConfirmationCount: 1,
  });
});

test("configuration guidance controller dismisses the accordion pulse after first expand and resets on new arrival", () => {
  const mod = loadModule();
  const controller = mod.createConfigurationGuidanceController();

  assert.equal(
    controller.startArrival({
      serverId: "gitlab",
      firstAccordionId: "accordion-1",
      ready: false,
    }),
    "accordion",
  );
  assert.equal(
    controller.handleAccordionToggle({
      accordionId: "accordion-1",
      isCollapsed: false,
      ready: false,
    }),
    null,
  );
  assert.equal(controller.getPulseTarget({ ready: true }), "save");
  assert.equal(controller.getPulseTarget({ ready: false }), null);

  assert.equal(
    controller.startArrival({
      serverId: "gitlab",
      firstAccordionId: "accordion-1",
      ready: false,
    }),
    "accordion",
  );
});

test("resolveConfigurationPulseTarget prioritizes visible confirmation panels over other guidance targets", () => {
  const mod = loadModule();

  assert.equal(
    mod.resolveConfigurationPulseTarget({
      ready: true,
      confirmationId: "confirmation-1",
      hasFirstAccordion: true,
      firstAccordionDismissed: false,
    }),
    "confirmation",
  );
  assert.equal(
    mod.resolveConfigurationPulseTarget({
      ready: true,
      confirmationId: null,
      hasFirstAccordion: true,
      firstAccordionDismissed: false,
    }),
    "save",
  );
});

test("configuration guidance prefers the save CTA when a server is already ready on arrival", () => {
  const mod = loadModule();
  const controller = mod.createConfigurationGuidanceController();

  assert.equal(
    controller.startArrival({
      serverId: "gitlab",
      firstAccordionId: "accordion-1",
      ready: true,
    }),
    "save",
  );
  assert.equal(controller.getPulseTarget({ ready: false }), null);
});

test("visible confirmation cards become the active guidance target when an accordion is opened", () => {
  const mod = loadModule();
  const firstAccordion = new FakeElement("accordion-1");
  firstAccordion.className = "accordion-section collapsed";
  const { card: confirmationCard } = createConfirmationCard("confirmation-1", {
    accordion: firstAccordion,
  });

  const dom = createConfigurationDocument({
    firstAccordion,
    confirmationCards: [confirmationCard],
  });

  withDocument(dom.document, () => {
    const initState = mod.initializeConfigurationGuidance(
      { id: "slack", name: "Slack MCP Server" },
      {},
    );
    assert.equal(initState.pulseTarget, "accordion");
    assert(firstAccordion.classList.contains("is-guidance-pulsing"));

    firstAccordion.classList.remove("collapsed");
    const toggleState = mod.handleConfigurationAccordionToggle(
      {
        accordionId: "accordion-1",
        isCollapsed: false,
      },
      {},
    );

    assert.equal(toggleState.pulseTarget, "confirmation");
    assert.equal(toggleState.confirmationId, "confirmation-1");
    assert.equal(firstAccordion.classList.contains("is-guidance-pulsing"), false);
    assert.equal(
      confirmationCard.classList.contains("is-guidance-pulsing"),
      true,
    );
  });
});

test("visible confirmation cards outrank save guidance until the question is answered", () => {
  const mod = loadModule();
  const input = createInput("TOKEN", "secret");
  const firstAccordion = new FakeElement("accordion-1");
  firstAccordion.className = "accordion-section";
  const { card: confirmationCard } = createConfirmationCard("confirmation-1", {
    accordion: firstAccordion,
  });

  const dom = createConfigurationDocument({
    inputs: [input],
    firstAccordion,
    confirmationCards: [confirmationCard],
  });

  withDocument(dom.document, () => {
    const initState = mod.initializeConfigurationGuidance(
      { id: "slack", name: "Slack MCP Server" },
      {},
    );

    assert.equal(initState.pulseTarget, "confirmation");
    assert.equal(dom.saveButton.style.display, "none");
    assert.equal(dom.saveButton.classList.contains("is-pulsing"), false);
    assert.equal(
      confirmationCard.classList.contains("is-guidance-pulsing"),
      true,
    );

    confirmationCard.style.display = "none";
    const refreshedState = mod.refreshConfigurationGuidance({});

    assert.equal(refreshedState.pulseTarget, "save");
    assert.equal(dom.saveButton.style.display, "");
    assert.equal(
      confirmationCard.classList.contains("is-guidance-pulsing"),
      false,
    );
    assert.equal(dom.saveButton.classList.contains("is-pulsing"), true);
  });
});

test("initializeConfigurationGuidance and refreshConfigurationGuidance switch pulses as readiness changes", () => {
  const mod = loadModule();
  const input = createInput("TOKEN", "");
  const titleNode = new FakeElement("markdown-title");
  titleNode.innerHTML =
    '<span class="gs-md-cyan">GitLab MCP Server Configuration</span>';
  titleNode.textContent = "GitLab MCP Server Configuration";
  titleNode.remove = () => {
    titleNode.removed = true;
  };

  const firstAccordion = new FakeElement("accordion-1");
  firstAccordion.className = "accordion-section collapsed";

  const dom = createConfigurationDocument({
    inputs: [input],
    titleNode,
    firstAccordion,
  });

  withDocument(dom.document, () => {
    const initState = mod.initializeConfigurationGuidance(
      { id: "gitlab", name: "GitLab MCP Server" },
      {},
    );

    assert.equal(initState.pulseTarget, "accordion");
    assert.equal(titleNode.removed, true);
    assert.equal(
      dom.titleElement.innerHTML,
      '<span class="gs-md-cyan">GitLab MCP Server Configuration</span>',
    );
    assert(firstAccordion.classList.contains("is-guidance-pulsing"));
    assert.equal(dom.saveButton.style.display, "none");
    assert.equal(dom.saveButton.classList.contains("is-pulsing"), false);

    input.value = "secret";
    const readyState = mod.refreshConfigurationGuidance({});

    assert.equal(readyState.pulseTarget, "save");
    assert.equal(firstAccordion.classList.contains("is-guidance-pulsing"), false);
    assert.equal(dom.saveButton.style.display, "");
    assert.equal(dom.saveButton.classList.contains("is-pulsing"), true);

    input.value = "   ";
    const invalidatedState = mod.refreshConfigurationGuidance({});

    assert.equal(invalidatedState.pulseTarget, null);
    assert.equal(dom.saveButton.style.display, "none");
    assert.equal(dom.saveButton.classList.contains("is-pulsing"), false);
  });
});

test("handleConfigurationAccordionToggle stops the first-step pulse for the current arrival", () => {
  const mod = loadModule();
  const input = createInput("TOKEN", "");
  const firstAccordion = new FakeElement("accordion-1");
  firstAccordion.className = "accordion-section collapsed";
  input.parentElement.parentElement = firstAccordion;

  const dom = createConfigurationDocument({
    inputs: [input],
    firstAccordion,
  });

  withDocument(dom.document, () => {
    mod.initializeConfigurationGuidance(
      { id: "gitlab", name: "GitLab MCP Server" },
      {},
    );
    assert(firstAccordion.classList.contains("is-guidance-pulsing"));

    const toggleState = mod.handleConfigurationAccordionToggle(
      {
        accordionId: "accordion-1",
        isCollapsed: false,
      },
      {},
    );

    assert.equal(toggleState.pulseTarget, null);
    assert.equal(firstAccordion.classList.contains("is-guidance-pulsing"), false);

    const refreshedState = mod.refreshConfigurationGuidance({});
    assert.equal(refreshedState.pulseTarget, null);
    assert.equal(firstAccordion.classList.contains("is-guidance-pulsing"), false);
  });
});

test("handleConfigurationAccordionToggle focuses and pulses the first empty input in the expanded accordion", () => {
  const mod = loadModule();
  const filledInput = createInput("TOKEN", "already-set");
  const pendingInput = createInput("TEAM", "");
  const firstAccordion = new FakeElement("accordion-1");
  firstAccordion.className = "accordion-section collapsed";
  filledInput.parentElement.parentElement = firstAccordion;
  pendingInput.parentElement.parentElement = firstAccordion;

  const dom = createConfigurationDocument({
    inputs: [filledInput, pendingInput],
    firstAccordion,
  });

  withDocument(dom.document, () => {
    mod.initializeConfigurationGuidance(
      { id: "gitlab", name: "GitLab MCP Server" },
      {},
    );

    const toggleState = mod.handleConfigurationAccordionToggle(
      {
        accordionId: "accordion-1",
        isCollapsed: false,
      },
      {},
    );

    assert.equal(toggleState.focusedInputId, "input-TEAM");
    assert.equal(filledInput.focused, false);
    assert.equal(pendingInput.focused, true);
    assert.equal(
      pendingInput.classList.contains("is-input-guidance-pulsing"),
      true,
    );
  });
});

test("configuration input guidance pulse clears once the user starts typing", () => {
  const mod = loadModule();
  const input = createInput("TOKEN", "");
  const firstAccordion = new FakeElement("accordion-1");
  firstAccordion.className = "accordion-section collapsed";
  input.parentElement.parentElement = firstAccordion;

  const dom = createConfigurationDocument({
    inputs: [input],
    firstAccordion,
  });

  withDocument(dom.document, () => {
    mod.initializeConfigurationGuidance(
      { id: "gitlab", name: "GitLab MCP Server" },
      {},
    );

    mod.handleConfigurationAccordionToggle(
      {
        accordionId: "accordion-1",
        isCollapsed: false,
      },
      {},
    );

    assert.equal(input.classList.contains("is-input-guidance-pulsing"), true);

    const inputHandlers = dom.configContent.listeners.get("input") || [];
    input.value = "secret";
    inputHandlers[0]({ target: input });

    assert.equal(input.classList.contains("is-input-guidance-pulsing"), false);
  });
});

test("parseSetupMarkdown creates collapsed server accordions and initializes the header title", async () => {
  const mod = loadModule();
  const input = createInput("GITLAB_PERSONAL_ACCESS_TOKEN", "");
  const titleNode = new FakeElement("markdown-title");
  titleNode.innerHTML =
    '<span class="gs-md-cyan">GitLab MCP Server Configuration</span>';
  titleNode.textContent = "GitLab MCP Server Configuration";
  titleNode.remove = () => {
    titleNode.removed = true;
  };

  const firstAccordion = new FakeElement("accordion-visible-server-config-0");
  firstAccordion.className = "accordion-section collapsed";
  const scrollContainer = new FakeElement("content-scroll-area");

  const dom = createConfigurationDocument({
    inputs: [input],
    titleNode,
    firstAccordion,
    scrollContainer,
  });
  const createAccordionCalls = [];

  await withDocument(dom.document, async () => {
    await mod.parseSetupMarkdown(
      {
        id: "gitlab",
        name: "GitLab MCP Server",
        setupMarkdown: "# GitLab",
      },
      { envVars: {} },
      {
        parseMarkdownContent() {
          return "<h1>GitLab</h1><h2>Step 1</h2>";
        },
        createAccordionsForVisibleContent(container, context, options) {
          createAccordionCalls.push({ container, context, options });
        },
      },
    );
  });

  assert.equal(createAccordionCalls.length, 1);
  assert.equal(createAccordionCalls[0].context, "server-config");
  assert.equal(createAccordionCalls[0].options.startCollapsed, true);
  assert.equal(createAccordionCalls[0].options.scrollContainer, scrollContainer);
  assert.equal(typeof createAccordionCalls[0].options.onToggle, "function");
  assert.equal(titleNode.removed, true);
  assert.equal(dom.saveButton.style.display, "none");
  assert.equal(
    dom.titleElement.innerHTML,
    '<span class="gs-md-cyan">GitLab MCP Server Configuration</span>',
  );
  assert(firstAccordion.classList.contains("is-guidance-pulsing"));
});

test("loadServerConfiguration hides Skip All when the current server is the last pending configuration step", async () => {
  const mod = loadModule();
  const skipAllButton = new FakeElement("skip-all-servers-btn");
  const dom = createConfigurationDocument({
    elements: {
      "skip-all-servers-btn": skipAllButton,
    },
  });
  const setupState = {
    serverConfigs: [{ id: "sourcegraph", name: "Sourcegraph" }],
    currentServerIndex: 0,
    configuredServers: new Set(),
    skippedServers: new Set(),
    completedSteps: { servers: {} },
    envVars: {},
  };

  await withDocument(dom.document, async () => {
    await mod.loadServerConfiguration(0, setupState, {
      showStage() {},
    });
  });

  assert.equal(skipAllButton.style.display, "none");
});

test("loadServerConfiguration keeps configuration in loading mode until the current server UI is fully built", async () => {
  const mod = loadModule();
  const loadingCalls = [];
  const shownStages = [];
  const dom = createConfigurationDocument();
  const setupState = {
    serverConfigs: [{ id: "slack", name: "Slack", required_env_vars: [] }],
    currentServerIndex: 0,
    configuredServers: new Set(),
    skippedServers: new Set(),
    completedSteps: { servers: {} },
    envVars: {},
  };

  await withDocument(dom.document, async () => {
    await mod.loadServerConfiguration(0, setupState, {
      setConfigurationLoadingState(isLoading) {
        loadingCalls.push(isLoading);
      },
      async showStage(stageName, options) {
        shownStages.push([stageName, options]);
      },
      createServerNavigation() {},
    });
  });

  assert.deepEqual(loadingCalls, [true, false]);
  assert.deepEqual(shownStages, [["configuration", { initialLoading: true }]]);
  assert.match(dom.configContent.innerHTML, /class="setup-step"/);
});

test("parseSetupMarkdown populates existing env vars and logs a configuration error when parsing fails", async () => {
  const mod = loadModule();
  const existingInput = createInput("SLACK_TOKEN", "");
  const dom = createConfigurationDocument({
    inputs: [existingInput],
  });
  const logs = [];

  await withDocument(dom.document, async () => {
    await mod.parseSetupMarkdown(
      {
        id: "slack",
        name: "Slack",
        setupMarkdown: "# Slack",
      },
      {
        envVars: {
          SLACK_TOKEN: "persisted-token",
        },
      },
      {
        parseMarkdownContent() {
          throw new Error("bad markdown");
        },
        addLog(message, level) {
          logs.push({ message, level });
        },
      },
    );
  });

  assert.deepEqual(logs, [
    {
      message: "Error loading configuration for Slack",
      level: "error",
    },
  ]);
});

test("loadServerConfiguration renders an already configured secure-token server without inputs", async () => {
  const mod = loadModule();
  const dom = createConfigurationDocument();
  const setupState = {
    envVars: {},
    serverConfigs: [
      {
        id: "gitlab-mcp",
        name: "GitLab MCP Server",
        display_name: "GitLab",
        setupMarkdown: "# GitLab",
        required_env_vars: [
          { name: "GITLAB_PERSONAL_ACCESS_TOKEN", sensitive: true },
        ],
      },
    ],
    currentServerIndex: 0,
    configuredServers: new Set(),
    preConfiguredServers: new Set(["gitlab-mcp"]),
    skippedServers: new Set(),
  };
  const logs = [];
  let navigationCreated = 0;

  await withDocument(dom.document, async () => {
    await mod.loadServerConfiguration(0, setupState, {
      async showStage() {},
      isServerConfigured() {
        return true;
      },
      createServerNavigation() {
        navigationCreated += 1;
      },
      addLog(message, level) {
        logs.push({ message, level });
      },
    });
  });

  assert.equal(setupState.configuredServers.has("gitlab-mcp"), true);
  assert.equal(navigationCreated, 1);
  assert.match(dom.configContent.innerHTML, /Already configured/);
  assert.match(dom.configContent.innerHTML, /securely stored token/);
  assert.equal(dom.saveButton.style.display, "none");
  assert.deepEqual(logs, [
    {
      message: "GitLab MCP Server is already configured",
      level: "success",
    },
  ]);
});

test("generateConfigForm renders required fields, populates saved values, and initializes guidance", () => {
  const mod = loadModule();
  const tokenInput = createInput("TOKEN", "");
  const teamInput = createInput("TEAM", "");
  const firstAccordion = new FakeElement("accordion-1");
  firstAccordion.className = "accordion-section collapsed";
  const dom = createConfigurationDocument({
    inputs: [tokenInput, teamInput],
    firstAccordion,
  });

  withDocument(dom.document, () => {
    mod.generateConfigForm(
      {
        id: "custom",
        name: "Custom OAuth",
        required_env_vars: [
          {
            name: "TOKEN",
            description: "API Token",
            placeholder: "Enter token",
          },
          {
            name: "TEAM",
            description: "Team slug",
          },
        ],
      },
      {
        envVars: {
          TOKEN: "token-123",
          TEAM: "platform",
        },
      },
      {},
    );
  });

  assert.match(dom.configContent.innerHTML, /Required Configuration/);
  assert.match(dom.configContent.innerHTML, /input-TOKEN/);
  assert.match(dom.configContent.innerHTML, /input-TEAM/);
  assert.equal(tokenInput.value, "token-123");
  assert.equal(teamInput.value, "platform");
  assert.equal(dom.saveButton.style.display, "");
});

test("syncConfigurationSaveButtonVisibility hides Save until configuration readiness is true", () => {
  const mod = loadModule();
  const dom = createConfigurationDocument();

  withDocument(dom.document, () => {
    assert.equal(
      mod.syncConfigurationSaveButtonVisibility({ ready: false }),
      false,
    );
    assert.equal(dom.saveButton.style.display, "none");

    assert.equal(
      mod.syncConfigurationSaveButtonVisibility({ ready: true }),
      true,
    );
    assert.equal(dom.saveButton.style.display, "");
  });
});

test("saveAndContinue blocks on invalid inputs and focuses the first invalid field", async () => {
  const mod = loadModule();
  const blankInput = createInput("TOKEN", "   ");
  const setupState = {
    envVars: {},
    serverConfigs: [{ id: "glean", name: "Glean" }],
    currentServerIndex: 0,
    completedSteps: { servers: {} },
    configuredServers: new Set(),
    skippedServers: new Set(),
  };
  const logs = [];

  await withInputs([blankInput], async () => {
    await mod.saveAndContinue(setupState, false, {
      addLog(message, level) {
        logs.push({ message, level });
      },
    });
  });

  assert(blankInput.classList.contains("error"));
  assert(blankInput.errorEl.classList.contains("visible"));
  assert.equal(blankInput.focused, true);
  assert.deepEqual(setupState.envVars, {});
  assert.deepEqual(logs, [
    {
      message: "Please fix validation errors before continuing",
      level: "error",
    },
  ]);
});

test("saveAndContinue persists values, supports multi-var fields, and advances to the next server", async () => {
  const mod = loadModule();
  const firstInput = createInput("TOKEN,API_KEY", " secret ");
  const secondInput = createInput("TEAM", "core-platform");
  const setupState = {
    envVars: {},
    serverConfigs: [
      { id: "glean", name: "Glean" },
      { id: "teamworks-mcp", name: "Teamworks" },
    ],
    currentServerIndex: 0,
    completedSteps: { servers: {} },
    configuredServers: new Set(),
    skippedServers: new Set(),
  };
  const savedVars = [];
  const shownStages = [];

  await withInputs([firstInput, secondInput], async () => {
    await mod.saveAndContinue(setupState, false, {
      async saveEnvVarImmediately(key, value) {
        savedVars.push([key, value]);
      },
      showStage(stage) {
        shownStages.push(stage);
      },
    });
  });

  assert.deepEqual(setupState.envVars, {
    TOKEN: "secret",
    API_KEY: "secret",
    TEAM: "core-platform",
  });
  assert.deepEqual(savedVars, [
    ["TOKEN", "secret"],
    ["API_KEY", "secret"],
    ["TEAM", "core-platform"],
  ]);
  assert.equal(firstInput.disabled, true);
  assert.equal(secondInput.disabled, true);
  assert(firstInput.classList.contains("saved"));
  assert(secondInput.classList.contains("saved"));
  assert.equal(setupState.completedSteps.servers.glean, true);
  assert.equal(setupState.configuredServers.has("glean"), true);
  assert.equal(setupState.skippedServers.has("glean"), false);
  assert.equal(setupState.currentServerIndex, 1);
  assert.deepEqual(shownStages, ["configuration"]);
});

test("saveAndContinue resumes pending OAuth immediately after prerequisite configuration", async () => {
  const mod = loadModule();
  const tokenInput = createInput("waldoapikey", "waldo-secret");
  const trustKit = { id: "trust-kit-mcp", name: "Trust Kit" };
  const setupState = {
    envVars: {},
    serverConfigs: [trustKit, { id: "gitlab", name: "GitLab" }],
    oauthServers: [trustKit],
    currentServerIndex: 0,
    completedSteps: { servers: {} },
    configuredServers: new Set(),
    skippedServers: new Set(),
    skippedOAuthServers: new Set(),
    pendingOAuthConfigurationServerId: "trust-kit-mcp",
  };
  const shownStages = [];

  await withInputs([tokenInput], async () => {
    await mod.saveAndContinue(setupState, false, {
      async saveEnvVarImmediately() {},
      async showStage(stage, options) {
        shownStages.push({ stage, options });
      },
    });
  });

  assert.equal(setupState.configuredServers.has("trust-kit-mcp"), true);
  assert.equal(setupState.pendingOAuthConfigurationServerId, null);
  assert.equal(setupState.currentServerIndex, 0);
  assert.deepEqual(shownStages, [
    { stage: "oauth", options: { autoStartPendingOAuth: true } },
  ]);
});

test("saveAndContinue skips over servers that are already configured when advancing", async () => {
  const mod = loadModule();
  const tokenInput = createInput("TOKEN", "secret");
  const setupState = {
    envVars: {},
    serverConfigs: [
      { id: "glean", name: "Glean" },
      { id: "google_workspace", name: "Google Workspace" },
      { id: "slack", name: "Slack" },
    ],
    currentServerIndex: 0,
    completedSteps: { servers: {} },
    configuredServers: new Set(["google_workspace"]),
    skippedServers: new Set(),
  };
  const shownStages = [];

  await withInputs([tokenInput], async () => {
    await mod.saveAndContinue(setupState, false, {
      showStage(stage) {
        shownStages.push(stage);
      },
    });
  });

  assert.equal(setupState.currentServerIndex, 2);
  assert.deepEqual(shownStages, ["configuration"]);
});

test("saveAndContinue finalizes after the last configuration screen", async () => {
  const mod = loadModule();
  const tokenInput = createInput("TOKEN", "secret");
  const setupState = {
    envVars: {},
    serverConfigs: [{ id: "glean", name: "Glean" }],
    currentServerIndex: 0,
    completedSteps: { servers: {} },
    configuredServers: new Set(),
    skippedServers: new Set(),
  };
  const shownStages = [];
  let finalized = 0;

  await withImmediateTimeout(async () => {
    await withInputs([tokenInput], async () => {
      await mod.saveAndContinue(setupState, false, {
        showStage(stage) {
          shownStages.push(stage);
        },
        finalizeSetup() {
          finalized += 1;
        },
      });
    });
  });

  assert.deepEqual(shownStages, ["finalize"]);
  assert.equal(finalized, 1);
});

test("saveAndContinue supports skip-validation mode and still advances when env persistence throws", async () => {
  const mod = loadModule();
  const tokenInput = createInput("TOKEN", "  secret  ");
  const blankInput = createInput("OPTIONAL", "   ");
  const setupState = {
    envVars: {},
    serverConfigs: [
      { id: "glean", name: "Glean" },
      { id: "slack", name: "Slack" },
    ],
    currentServerIndex: 0,
    completedSteps: { servers: {} },
    configuredServers: new Set(),
    skippedServers: new Set(),
  };
  const shownStages = [];

  await withInputs([tokenInput, blankInput], async () => {
    await mod.saveAndContinue(setupState, true, {
      async saveEnvVarImmediately() {
        throw new Error("persist failed");
      },
      showStage(stage) {
        shownStages.push(stage);
      },
    });
  });

  assert.deepEqual(setupState.envVars, {
    TOKEN: "secret",
  });
  assert.equal(setupState.completedSteps.servers.glean, undefined);
  assert.equal(setupState.configuredServers.has("glean"), false);
  assert.equal(tokenInput.disabled, true);
  assert.equal(blankInput.disabled, false);
  assert.equal(setupState.currentServerIndex, 1);
  assert.deepEqual(shownStages, ["configuration"]);
});

test("saveAndContinue fails closed when env persistence throws during normal save", async () => {
  const mod = loadModule();
  const tokenInput = createInput("TOKEN", "secret");
  const setupState = {
    envVars: {},
    serverConfigs: [
      { id: "glean", name: "Glean" },
      { id: "slack", name: "Slack" },
    ],
    currentServerIndex: 0,
    completedSteps: { servers: {} },
    configuredServers: new Set(),
    skippedServers: new Set(),
  };
  const logs = [];
  const shownStages = [];

  await withInputs([tokenInput], async () => {
    await mod.saveAndContinue(setupState, false, {
      async saveEnvVarImmediately() {
        throw new Error("Keychain persistence failed");
      },
      addLog(message, level) {
        logs.push({ message, level });
      },
      showStage(stage) {
        shownStages.push(stage);
      },
    });
  });

  assert.deepEqual(setupState.envVars, {});
  assert.equal(setupState.completedSteps.servers.glean, undefined);
  assert.equal(setupState.configuredServers.has("glean"), false);
  assert.equal(tokenInput.disabled, false);
  assert.equal(tokenInput.classList.contains("error"), true);
  assert.equal(tokenInput.errorEl.classList.contains("visible"), true);
  assert.equal(setupState.currentServerIndex, 0);
  assert.deepEqual(shownStages, []);
  assert.deepEqual(logs, [
    {
      message: "Error saving values: Keychain persistence failed",
      level: "error",
    },
  ]);
});

test("saveAndContinue logs an error and stays put when input processing throws unexpectedly", async () => {
  const mod = loadModule();
  const badInput = createInput("TOKEN", "secret");
  badInput.dataset = {};
  const setupState = {
    envVars: {},
    serverConfigs: [
      { id: "glean", name: "Glean" },
      { id: "slack", name: "Slack" },
    ],
    currentServerIndex: 0,
    completedSteps: { servers: {} },
    configuredServers: new Set(),
    skippedServers: new Set(),
  };
  const logs = [];
  const shownStages = [];

  await withInputs([badInput], async () => {
    await mod.saveAndContinue(setupState, false, {
      addLog(message, level) {
        logs.push({ message, level });
      },
      showStage(stage) {
        shownStages.push(stage);
      },
    });
  });

  assert.deepEqual(logs, [
    {
      message: "Error saving values: Cannot read properties of undefined (reading 'split')",
      level: "error",
    },
  ]);
  assert.equal(setupState.currentServerIndex, 0);
  assert.deepEqual(shownStages, []);
});

test("skipServer marks the current server skipped and proceeds through the remaining flow", async () => {
  const mod = loadModule();
  const setupState = {
    serverConfigs: [
      { id: "glean", name: "Glean" },
      { id: "google_workspace", name: "Google Workspace" },
    ],
    currentServerIndex: 0,
    configuredServers: new Set(["glean"]),
    skippedServers: new Set(),
  };

  await withInputs([], async () => {
    await mod.skipServer(setupState, {
      addLog() {},
      showStage() {},
    });
  });

  assert.equal(setupState.skippedServers.has("glean"), true);
  assert.equal(setupState.configuredServers.has("glean"), false);
  assert.equal(setupState.currentServerIndex, 1);
});

test("skipAllServers skips the current and remaining servers then finalizes", async () => {
  const mod = loadModule();
  const setupState = {
    serverConfigs: [
      { id: "glean", name: "Glean" },
      { id: "google_workspace", name: "Google Workspace" },
      { id: "slack", name: "Slack" },
    ],
    currentServerIndex: 1,
    configuredServers: new Set(["glean", "google_workspace", "slack"]),
    skippedServers: new Set(),
  };
  const shownStages = [];
  const logs = [];
  let finalized = 0;

  await withImmediateTimeout(async () => {
    await withInputs([], async () => {
      await mod.skipAllServers(setupState, {
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
  });

  assert.equal(setupState.skippedServers.has("glean"), false);
  assert.equal(setupState.skippedServers.has("google_workspace"), true);
  assert.equal(setupState.skippedServers.has("slack"), true);
  assert.equal(setupState.configuredServers.has("glean"), true);
  assert.equal(setupState.configuredServers.has("google_workspace"), false);
  assert.equal(setupState.configuredServers.has("slack"), false);
  assert.deepEqual(logs, [
    {
      message: "Skipped configuration for the remaining 2 servers",
      level: "warning",
    },
  ]);
  assert.deepEqual(shownStages, ["finalize"]);
  assert.equal(finalized, 1);
});

test("handleSkipAllServers disables the skip controls and restores them on error", async () => {
  const mod = loadModule();
  const skipAllBtn = new FakeElement("skip-all-servers-btn");
  const skipBtn = new FakeElement("skip-server-btn");
  const setupState = {
    serverConfigs: [{ id: "glean", name: "Glean" }],
    currentServerIndex: 0,
    configuredServers: new Set(),
    skippedServers: new Set(),
  };
  const logs = [];

  await withInputs(
    [],
    async () => {
      await mod.handleSkipAllServers(setupState, {
        addLog(message, level) {
          logs.push({ message, level });
        },
        showStage() {
          throw new Error("boom");
        },
      });
    },
    {
      elements: {
        "skip-all-servers-btn": skipAllBtn,
        "skip-server-btn": skipBtn,
      },
    },
  );

  assert.equal(skipAllBtn.disabled, false);
  assert.equal(skipAllBtn.textContent, "Skip All");
  assert.equal(skipBtn.disabled, false);
  assert.equal(skipBtn.textContent, "Skip");
  assert.deepEqual(logs, [
    {
      message: "Skipped Glean configuration",
      level: "warning",
    },
    {
      message: "Error occurred while skipping all remaining servers",
      level: "error",
    },
  ]);
});

test("handleSaveAndContinue and handleSkipServer restore button state on both success and error", async () => {
  const mod = loadModule();
  const saveBtn = new FakeElement("save-btn");
  const skipBtn = new FakeElement("skip-server-btn");
  const tokenInput = createInput("TOKEN", "secret");
  const successState = {
    envVars: {},
    serverConfigs: [{ id: "glean", name: "Glean" }],
    currentServerIndex: 0,
    completedSteps: { servers: {} },
    configuredServers: new Set(),
    skippedServers: new Set(),
  };
  const errorState = {
    serverConfigs: [{ id: "glean", name: "Glean" }],
    currentServerIndex: 0,
    configuredServers: new Set(),
    skippedServers: new Set(),
  };
  const logs = [];

  await withImmediateTimeout(async () => {
    await withInputs(
      [tokenInput],
      async () => {
        await mod.handleSaveAndContinue(successState, {
          showStage() {},
          finalizeSetup() {},
        });
      },
      {
        elements: {
          "save-btn": saveBtn,
        },
      },
    );
  });

  assert.equal(saveBtn.disabled, false);
  assert.equal(saveBtn.textContent, "Save & Continue");

  await withInputs(
    [],
    async () => {
      await mod.handleSkipServer(errorState, {
        addLog(message, level) {
          logs.push({ message, level });
        },
        showStage() {
          throw new Error("skip failed");
        },
      });
    },
    {
      elements: {
        "skip-server-btn": skipBtn,
      },
    },
  );

  assert.equal(skipBtn.disabled, false);
  assert.equal(skipBtn.textContent, "Skip");
  assert.deepEqual(logs, [
    {
      message: "Skipped Glean configuration",
      level: "warning",
    },
    {
      message: "Error occurred while skipping",
      level: "error",
    },
  ]);
});

test("previousServer returns to server selection from the first config screen", async () => {
  const mod = loadModule();
  const setupState = {
    currentServerIndex: 0,
  };
  const shownStages = [];

  await mod.previousServer(setupState, {
    showStage(stage) {
      shownStages.push(stage);
    },
  });

  assert.deepEqual(shownStages, ["server-selection"]);
});

test("previousServer reloads the prior server and jumpToServer ignores invalid indices", async () => {
  const mod = loadModule();
  const shownStages = [];
  const setupState = {
    currentServerIndex: 1,
    serverConfigs: [
      { id: "glean", name: "Glean", required_env_vars: [] },
      { id: "slack", name: "Slack", required_env_vars: [] },
    ],
    configuredServers: new Set(),
    skippedServers: new Set(),
    envVars: {},
  };

  await withInputs([], async () => {
    await mod.previousServer(setupState, {
      showStage(stage) {
        shownStages.push(stage);
      },
    });
  });

  assert.equal(setupState.currentServerIndex, 0);
  assert.deepEqual(shownStages, ["configuration"]);

  setupState.currentServerIndex = 0;
  await withInputs([], async () => {
    mod.jumpToServer(-1, setupState, {
      showStage(stage) {
        shownStages.push(stage);
      },
    });
    mod.jumpToServer(1, setupState, {
      showStage(stage) {
        shownStages.push(stage);
      },
    });
  });

  assert.equal(setupState.currentServerIndex, 1);
  assert.deepEqual(shownStages.slice(-1), ["configuration"]);
});
