const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { FakeElement } = require("./test-helpers/fake-dom");

const TERMINAL_RECOVERY_DONE_MESSAGE = "All done. You may now close this terminal window.";

function loadModule() {
  const modulePath = require.resolve(
    "../renderer/screens/guided-setup/screen-prerequisites",
  );
  delete require.cache[modulePath];
  return require("../renderer/screens/guided-setup/screen-prerequisites");
}

function withPrereqDom(run, options = {}) {
  const previousDocument = global.document;
  const previousWindow = global.window;

  const elements = {
    "prerequisites-continue-btn": new FakeElement("prerequisites-continue-btn"),
    ...(options.elements || {}),
  };
  const registrations = [];
  const baseElectronApi = new Proxy(options.electronAPI || {}, {
    get(target, prop) {
      if (prop in target) {
        return target[prop];
      }
      if (String(prop).startsWith("onPrerequisites")) {
        return (handler) => {
          registrations.push({ prop: String(prop), handler });
        };
      }
      return undefined;
    },
  });

  global.document = {
    createElement() {
      return {
        _textContent: "",
        innerHTML: "",
        set textContent(value) {
          this._textContent = String(value);
          this.innerHTML = this._textContent
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
        },
        get textContent() {
          return this._textContent;
        },
      };
    },
    getElementById(id) {
      return elements[id] || null;
    },
  };
  global.window = {
    electronAPI: baseElectronApi,
    ...(options.window || {}),
  };

  let result;
  try {
    result = run({
      elements,
      registrations,
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

function createPrereqScreenElements(extraIds = []) {
  const ids = [
    "prerequisites-progress",
    "prerequisites-overall-progress",
    "prerequisites-progress-text",
    "prerequisites-title",
    "prerequisites-current-step",
    "prerequisites-spotlight",
    "prerequisites-spotlight-visual",
    "prerequisites-spotlight-helper",
    "prerequisites-warning",
    "prerequisites-warning-message",
    "prerequisites-continue",
    "prerequisites-error",
    "prerequisites-error-eyebrow",
    "prerequisites-error-title",
    "prerequisites-error-message",
    "prerequisites-error-followup",
    "prerequisites-error-manual-action",
    "prerequisites-error-recovery",
    "prerequisites-password-guidance",
    "prerequisites-error-command-details",
    "prerequisites-error-command-summary",
    "prerequisites-error-command",
    "prerequisites-error-copy-command-btn",
    "prerequisites-error-copy-command-status",
    "prerequisites-password-hint",
    "prerequisites-error-command-status",
    "prerequisites-open-terminal-command-btn",
    "prerequisites-retry-btn",
    "prerequisites-retry-label",
    ...extraIds,
  ];

  return Object.fromEntries(ids.map((id) => [id, new FakeElement(id)]));
}

async function flushPromises(count = 4) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

async function withImmediateTimeout(run) {
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  const delays = [];

  global.setTimeout = (handler, delay = 0) => {
    delays.push(delay);
    handler();
    return delays.length;
  };
  global.clearTimeout = () => {};

  try {
    return await run({ delays });
  } finally {
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
  }
}

test("prerequisites helpers derive the right labels and run options for basic vs power", () => {
  const mod = loadModule();

  mod._test.setContext({ onboardingMode: "basic" });
  assert.equal(mod._test.getPhaseLabels()[4], "Downloading core runtime containers...");
  assert.deepEqual(mod._test.getPrerequisitesRunOptions(), {
    onboardingMode: "basic",
  });

  mod._test.setContext({ onboardingMode: "power" });
  assert.equal(mod._test.getPhaseLabels()[4], "Setting up host mode...");
  assert.deepEqual(mod._test.getPrerequisitesRunOptions(), {
    onboardingMode: "power",
  });

  mod._test.setContext({});
  assert.deepEqual(mod._test.getPrerequisitesRunOptions(), {
    onboardingMode: "power",
  });
});

test("recovery command normalizer trims and stops on failure without visible completion text", () => {
  const mod = loadModule();

  const normalized = mod._test.normalizeRecoveryCommand("sudo -v\nbrew --version\n");
  assert.equal(normalized.startsWith("set -e\n"), true);
  assert.equal(normalized.endsWith("brew --version"), true);
  assert.doesNotMatch(normalized, new RegExp(TERMINAL_RECOVERY_DONE_MESSAGE));

  assert.equal(mod._test.normalizeRecoveryCommand(normalized), normalized);
  assert.equal(mod._test.normalizeRecoveryCommand("set -e\nbrew --version").startsWith("set -e\nset -e\n"), false);
  assert.equal(mod._test.normalizeRecoveryCommand("  "), null);
  assert.equal(mod._test.normalizeRecoveryCommand(null), null);
});

test("markAuthorizeReady never regresses progress and auto-advance prefers the explicit callback", async () => {
  await withImmediateTimeout(async ({ delays }) => {
    const mod = loadModule();
    mod._test.resetState();
    mod._test.setContext(
      { onboardingMode: "basic", currentStage: "prerequisites" },
      {
        advanceAfterPrerequisites() {
          advanceCalls += 1;
        },
        showStage() {
          showStageCalls += 1;
        },
      },
    );

    let advanceCalls = 0;
    let showStageCalls = 0;

    mod._test.markAuthorizeReady({ progressPercent: 70 });
    mod._test.markAuthorizeReady({ progressPercent: 25 });

    assert.equal(mod._test.getState().authorizeReadiness.ready, true);
    assert.equal(mod._test.getState().authorizeReadiness.progressPercent, 70);

    mod._test.maybeAutoAdvanceAfterAuthorizeReady();

    assert.equal(advanceCalls, 1);
    assert.equal(showStageCalls, 0);
    assert.equal(mod._test.getState().autoAdvanceTriggered, true);
    assert.deepEqual(delays, [2000]);
  });
});

test("prerequisites auto-advance falls back to the correct next stage when no explicit callback exists", async () => {
  await withImmediateTimeout(async ({ delays }) => {
    const mod = loadModule();
    mod._test.resetState();
    const shownStages = [];
    mod._test.setContext(
      { onboardingMode: "power", currentStage: "prerequisites" },
      {
        showStage(stage) {
          shownStages.push(stage);
        },
      },
    );

    mod._test.markAuthorizeReady({ progressPercent: 100 });
    mod._test.maybeAutoAdvanceAfterAuthorizeReady();

    assert.deepEqual(shownStages, ["server-selection"]);
    assert.deepEqual(delays, [2000]);
  });
});

test("hydrateStatusSnapshot carries readiness and docker progress into the prerequisites state", () => {
  const mod = loadModule();
  mod._test.resetState();
  mod._test.setContext({ onboardingMode: "basic", currentStage: "prerequisites" });

  mod._test.hydrateStatusSnapshot({
    running: true,
    currentSequence: "interactive",
    activePhase: 2,
    blockingReady: false,
    backgroundReady: true,
    authorizeReadiness: {
      ready: true,
      waiting: false,
      progressPercent: 100,
      missingImages: [],
    },
    dockerPull: {
      running: true,
      totalImages: 2,
      completedCount: 1,
      currentLabel: "Open WebUI",
      images: [
        {
          image: "redis:7-alpine",
          label: "Redis Cache",
          status: "done",
          percent: 100,
          eta: null,
        },
      ],
    },
  });

  const state = mod._test.getState();
  assert.equal(state.isRunning, true);
  assert.equal(state.currentPhase, 2);
  assert.equal(state.authorizeReadiness.ready, true);
  assert.equal(state.authorizeReadiness.progressPercent, 100);
  assert.equal(state.dockerPull.isActive, true);
  assert.equal(state.dockerPull.totalImages, 2);
  assert.equal(state.dockerPull.completedCount, 1);
  assert.equal(state.dockerPull.currentLabel, "Open WebUI");
  assert.deepEqual([...state.dockerPull.images.keys()], ["redis:7-alpine"]);
  assert.equal(state.backgroundReady, true);
  assert.equal(state.continueAvailable, false);
});

test("hydrateStatusSnapshot preserves the active phase-2 step for CLT guidance", () => {
  const mod = loadModule();
  mod._test.resetState();
  mod._test.setContext({ onboardingMode: "power", currentStage: "prerequisites" });

  mod._test.hydrateStatusSnapshot({
    running: true,
    currentSequence: "interactive",
    activePhase: 2,
    activeStep: "command_line_tools",
    phaseResults: {
      phase1: { success: true },
    },
  });

  const state = mod._test.getState();
  const spotlight = mod._test.getSpotlightContent();

  assert.equal(state.activeStep, "command_line_tools");
  assert.equal(
    spotlight.helper,
    "Approve the Apple Command Line Developer Tools / Software Update window.",
  );
});

test("phase-2 spotlight uses password guidance for later dependency steps", () => {
  const mod = loadModule();
  mod._test.resetState();
  mod._test.setContext({ onboardingMode: "power", currentStage: "prerequisites" });

  mod._test.hydrateStatusSnapshot({
    running: true,
    currentSequence: "interactive",
    activePhase: 2,
    activeStep: "homebrew",
    phaseResults: {
      phase1: { success: true },
    },
  });

  const spotlight = mod._test.getSpotlightContent();
  assert.equal(
    spotlight.helper,
    "If prompted, please provide your <strong>computer</strong> password.",
  );
});

test("loadPrerequisitesScreen registers listeners and binds the continue action when start is deferred", async () => {
  const mod = loadModule();
  let advanced = 0;

  await withPrereqDom(async ({ elements, registrations }) => {
    await mod.loadPrerequisitesScreen(
      { onboardingMode: "basic", currentStage: "prerequisites" },
      {
        advanceAfterPrerequisites() {
          advanced += 1;
        },
      },
      { deferStart: true },
    );

    await elements["prerequisites-continue-btn"].click();

    assert.equal(registrations.length >= 10, true);
    assert.equal(mod._test.getState().autoAdvanceTriggered, false);
  });

  assert.equal(advanced, 1);
});

test("loadPrerequisitesScreen immediately bootstraps prerequisites and resumes the next stage when readiness is already satisfied", async () => {
  await withImmediateTimeout(async ({ delays }) => {
    const mod = loadModule();
    mod._test.resetState();
    const shownStages = [];
    let removeCalls = 0;
    let resumeCalls = 0;

    await withPrereqDom(
      async ({ registrations }) => {
        await mod.loadPrerequisitesScreen(
          { onboardingMode: "power", currentStage: "prerequisites" },
          {
            showStage(stage) {
              shownStages.push(stage);
            },
          },
          { resume: true },
        );

        assert.equal(registrations.length >= 10, true);
      },
      {
        electronAPI: {
          removePrerequisitesListeners() {
            removeCalls += 1;
          },
          async prerequisitesGetStatus() {
            return {
              success: true,
              dockerImages: [{ image: "custom:1", label: "Custom" }],
            };
          },
          async prerequisitesGetDetailedStatus() {
            return {
              success: true,
              running: true,
              currentSequence: "interactive",
              activePhase: 4,
              blockingReady: true,
              backgroundReady: true,
              authorizeReadiness: {
                ready: true,
                waiting: false,
                progressPercent: 100,
                missingImages: [],
              },
            };
          },
          async prerequisitesResumeInteractive() {
            resumeCalls += 1;
            return {
              success: true,
              started: true,
              status: {
                running: true,
                currentSequence: "interactive",
                activePhase: 4,
                blockingReady: false,
                backgroundReady: true,
                authorizeReadiness: {
                  ready: true,
                  waiting: false,
                  progressPercent: 100,
                  missingImages: [],
                },
              },
            };
          },
        },
      },
    );

    const state = mod._test.getState();
    assert.equal(removeCalls, 1);
    assert.equal(resumeCalls, 1);
    assert.equal(state.dockerPull.images.has("custom:1"), true);
    assert.equal(
      state.logs.some((entry) => /Refreshing prerequisites status/.test(entry.text)),
      true,
    );
    assert.equal(
      state.logs.some((entry) => /Installing core prerequisites/.test(entry.text)),
      true,
    );
    assert.deepEqual(shownStages, ["server-selection"]);
    assert.equal(delays.filter((delay) => delay === 1000).length, 3);
    assert.equal(delays.filter((delay) => delay === 2000).length, 1);
  });
});

test("loadPrerequisitesScreen keeps the user on prerequisites during a manual revisit even when readiness is already satisfied", async () => {
  await withImmediateTimeout(async ({ delays }) => {
    const mod = loadModule();
    mod._test.resetState();
    const shownStages = [];
    let elementsRef = null;

    await withPrereqDom(
      async ({ elements }) => {
        elementsRef = elements;
        elements["prerequisites-continue"] = new FakeElement("prerequisites-continue");
        elements["prerequisites-continue-title"] = new FakeElement("prerequisites-continue-title");
        elements["prerequisites-continue-message"] = new FakeElement("prerequisites-continue-message");
        elements["prerequisites-spotlight-visual"] = new FakeElement("prerequisites-spotlight-visual");
        elements["prerequisites-spotlight-helper"] = new FakeElement("prerequisites-spotlight-helper");

        await mod.loadPrerequisitesScreen(
          { onboardingMode: "power", currentStage: "prerequisites" },
          {
            showStage(stage) {
              shownStages.push(stage);
            },
          },
          { resume: true, manualVisit: true, suppressAutoAdvance: true },
        );
      },
      {
        electronAPI: {
          async prerequisitesGetStatus() {
            return {
              success: true,
              dockerImages: [{ image: "custom:1", label: "Custom" }],
            };
          },
          async prerequisitesGetDetailedStatus() {
            return {
              success: true,
              running: true,
              currentSequence: "interactive",
              activePhase: 4,
              blockingReady: true,
              backgroundReady: true,
              authorizeReadiness: {
                ready: true,
                waiting: false,
                progressPercent: 100,
                missingImages: [],
              },
            };
          },
          async prerequisitesResumeInteractive() {
            return {
              success: true,
              started: true,
              status: {
                running: true,
                currentSequence: "interactive",
                activePhase: 4,
                blockingReady: false,
                backgroundReady: true,
                authorizeReadiness: {
                  ready: true,
                  waiting: false,
                  progressPercent: 100,
                  missingImages: [],
                },
              },
            };
          },
        },
      },
    );

    const state = mod._test.getState();
    assert.deepEqual(shownStages, []);
    assert.equal(state.autoAdvanceTriggered, false);
    assert.equal(state.continueAvailable, true);
    assert.equal(state.manualVisit, true);
    assert.equal(state.suppressAutoAdvance, true);
    assert.equal(elementsRef["prerequisites-continue"].style.display, "flex");
    assert.equal(elementsRef["prerequisites-continue"].classList.contains("is-compact"), true);
    assert.equal(elementsRef["prerequisites-spotlight-helper"].innerHTML, "");
    assert.deepEqual(delays, [1000, 1000, 1000]);
  });
});

test("bootstrapPrerequisitesSession hydrates image plans and surfaces failed prior runs without restarting", async () => {
  await withImmediateTimeout(async () => {
    const mod = loadModule();
    mod._test.resetState();
    mod._test.setContext({ onboardingMode: "power", currentStage: "prerequisites" });
    let resumeCalls = 0;

    await withPrereqDom(
      async () => {
        await mod.bootstrapPrerequisitesSession({ shouldResume: false });
      },
      {
        electronAPI: {
          async prerequisitesGetStatus() {
            return {
              success: true,
              dockerImages: [{ name: "custom-image", tag: "1", label: "Custom Image" }],
            };
          },
          async prerequisitesGetDetailedStatus() {
            return {
              success: true,
              currentSequence: "failed",
              activePhase: 4,
              phaseResults: {
                phase4: { success: false },
              },
              lastError: "Host mode missing",
            };
          },
          async prerequisitesResumeInteractive() {
            resumeCalls += 1;
            return { success: true };
          },
        },
      },
    );

    const state = mod._test.getState();
    const sections = mod.getPrereqDebugSections();

    assert.equal(resumeCalls, 0);
    assert.equal(state.hostModeWarning, true);
    assert.match(state.hostModeWarningMessage, /Host mode is optional/);
    assert.equal(state.dockerPull.images.has("custom-image:1"), true);
    assert.equal(sections.length >= 1, true);
    assert.match(sections[0].content, /previous prerequisites attempt needs attention/i);
  });
});

test("bootstrapPrerequisitesSession records startup errors when the prerequisites status lookup throws", async () => {
  await withImmediateTimeout(async () => {
    const mod = loadModule();
    mod._test.resetState();
    mod._test.setContext({ onboardingMode: "power", currentStage: "prerequisites" });

    await withPrereqDom(
      async () => {
        await mod.bootstrapPrerequisitesSession({ shouldResume: false });
      },
      {
        electronAPI: {
          async prerequisitesGetDetailedStatus() {
            throw new Error("status exploded");
          },
        },
      },
    );

    const state = mod._test.getState();
    assert.equal(
      state.logs.some((entry) => /Error starting prerequisites: status exploded/.test(entry.text)),
      true,
    );
  });
});

test("openPrereqLogs, collectPrereqDebugInfo, and retryPrerequisites use the guided setup debug integrations", async () => {
  const mod = loadModule();
  mod._test.resetState();
  mod._test.setContext({ onboardingMode: "basic", currentStage: "prerequisites" });
  const state = mod._test.getState();
  state.phaseLogs[1].push({
    text: "Downloaded payload",
    type: "info",
    timestamp: Date.now(),
  });
  state.isRunning = true;
  state.error = { message: "Old failure" };

  const openedLogs = [];
  let collectCalls = 0;
  let initialPhaseLog = "";

  await withPrereqDom(
    async () => {
      mod.openPrereqLogs(1);
      initialPhaseLog = openedLogs[0].options.logProvider();
      const collectResult = await mod.collectPrereqDebugInfo();
      assert.deepEqual(collectResult, { success: true, zipFile: "/tmp/logs.zip" });

      await mod.retryPrerequisites();
    },
    {
      window: {
        openLogViewerModal(id, mode, options) {
          openedLogs.push({ id, mode, options });
        },
        async collectGuidedSetupDebugInfo() {
          collectCalls += 1;
          return { success: true, zipFile: "/tmp/logs.zip" };
        },
      },
      electronAPI: {
        async prerequisitesResumeInteractive() {
          return {
            success: true,
            status: {
              running: true,
              activePhase: 2,
              blockingReady: false,
              backgroundReady: false,
              recentLogs: [{ text: "Resumed run", type: "info", timestamp: Date.now() }],
            },
          };
        },
      },
    },
  );

  const nextState = mod._test.getState();
  assert.equal(openedLogs.length, 1);
  assert.equal(openedLogs[0].id, "prereq-phase-1");
  assert.match(initialPhaseLog, /Downloaded payload/);
  assert.equal(collectCalls, 1);
  assert.equal(nextState.error, null);
  assert.equal(nextState.isRunning, true);
  assert.equal(nextState.currentPhase, 2);
  assert.equal(nextState.logs.length > 0, true);
});

test("prerequisites helper exports normalize docker specs and compute progress summaries", () => {
  const mod = loadModule();
  mod._test.resetState();
  mod._test.setContext({ onboardingMode: "basic", currentStage: "prerequisites" });

  assert.equal(mod._test.formatPercentText(12.7), "13%");
  assert.equal(mod._test.normalizeDockerImageSpec(null), null);
  assert.deepEqual(
    mod._test.normalizeDockerImageSpec({
      name: "redis",
      tag: "7-alpine",
      label: "Redis Cache",
    }),
    {
      image: "redis:7-alpine",
      label: "Redis Cache",
    },
  );

  mod._test.seedDockerImages([
    { name: "redis", tag: "7-alpine", label: "Redis Cache" },
    { image: "custom:1", label: "Custom" },
  ]);
  let state = mod._test.getState();
  assert.equal(state.dockerPull.images.size, 2);

  state.phase1Progress.percent = 50;
  assert.equal(mod._test.calculateOverallProgress(), 17);

  state.phase1Progress.downloadComplete = true;
  state.phases[1].status = "complete";
  state.phases[2].status = "active";
  assert.equal(mod._test.calculateOverallProgress(), 44);

  state.phases[2].status = "complete";
  state.dockerPull.isActive = true;
  state.authorizeReadiness.progressPercent = 50;
  assert.equal(mod._test.calculateOverallProgress(), 82);

  state.dockerPull.images = new Map([
    ["redis:7-alpine", { status: "complete", percent: 100, label: "Redis" }],
    ["custom:1", { status: "failed", percent: 25, label: "Custom" }],
  ]);
  state.dockerPull.totalImages = 2;
  const failedSummary = mod._test.getDockerPullSummary();
  assert.equal(failedSummary.statusText, "Downloads need attention");
  assert.match(failedSummary.detailText, /1 image failed/);

  state.dockerPull.images = new Map([
    ["redis:7-alpine", { status: "complete", percent: 100, label: "Redis" }],
    ["custom:1", { status: "deferred", percent: 100, label: "Custom" }],
  ]);
  const readySummary = mod._test.getDockerPullSummary();
  assert.equal(readySummary.percent, 100);
  assert.equal(readySummary.statusText, "All downloads are ready");

  state.error = { message: "Boom", phase: 2 };
  assert.equal(
    mod._test.getCurrentStepSummary(),
    "Needs attention: Installing core dependencies...",
  );
  state.error = null;
  state.phases[2].status = "active";
  assert.equal(
    mod._test.getCurrentStepSummary(),
    "Installing core dependencies...",
  );

  const formatted = mod._test.formatLogEntry({
    text: "Ready",
    type: "success",
    timestamp: Date.now(),
  });
  assert.match(formatted, /\[SUCCESS\] Ready/);
  const section = mod._test.buildSectionFromEntries(
    "phase-1",
    "Phase 1",
    [{ text: "Hello", type: "info", timestamp: 1 }],
    "Meta",
  );
  assert.equal(section.id, "phase-1");
  assert.equal(section.title, "Phase 1");
  assert.equal(section.meta, "Meta");
  assert.match(section.content, /\[INFO\] Hello/);
  assert.equal(mod._test.stripAnsi("\u001b[31mBoom\u001b[0m"), "Boom");
});

test("prerequisites handler exports update warning, retry, blocking-ready, and completion state", async () => {
  const mod = loadModule();
  const elements = createPrereqScreenElements();
  const completedSteps = { prerequisites: false, prerequisitesWarning: false };
  let progressUpdates = 0;

  await withPrereqDom(
    async () => {
      mod._test.resetState();
      mod._test.setContext(
        {
          onboardingMode: "power",
          currentStage: "prerequisites",
          completedSteps,
          hostModeSupported: true,
        },
        {
          updateProgressTracker() {
            progressUpdates += 1;
          },
        },
      );

      mod._test.handleStart({ totalPhases: 4 });
      mod._test.handlePhaseStart({ phase: 2, label: "Installing dependencies" });
      mod._test.handleStepUpdate({ step: "docker", status: "failed", phase: 4 });
      mod._test.handleProgress({ metric: "download_percent", value: "55" });
      mod._test.handleWarning({ message: "Heads up" });
      mod._test.handleHostMode({ enabled: false });
      mod._test.handleBlockingReady();
      mod._test.handleRetry({ phase: 4, attempt: 2, maxAttempts: 3 });
      mod._test.handleComplete({
        success: true,
        results: {
          phase4: { success: false },
        },
      });

      let state = mod._test.getState();
      assert.equal(state.warningMessage, null);
      assert.equal(state.hostModeWarning, true);
      assert.equal(state.authorizeReadiness.ready, true);
      assert.equal(state.continueAvailable, true);
      assert.equal(state.fullInstallComplete, true);
      assert.equal(completedSteps.prerequisites, true);
      assert.equal(completedSteps.prerequisitesWarning, true);
      assert.equal(progressUpdates, 2);

      mod._test.resetState();
      mod._test.setContext(
        {
          onboardingMode: "basic",
          currentStage: "prerequisites",
          completedSteps: { prerequisites: false, prerequisitesWarning: false },
        },
        {},
      );
      mod._test.handleError({ error: "Disk full", phase: 2 });
      mod._test.handleComplete({
        success: false,
        failedPhase: 3,
        error: "Docker failed",
        results: {
          phase3: { success: false },
        },
      });

      state = mod._test.getState();
      assert.equal(state.error.message, "Docker failed");
      assert.equal(state.phases[3].status, "failed");
      assert.equal(elements["prerequisites-error"].style.display, "block");
      assert.equal(elements["prerequisites-error-eyebrow"].style.display, "none");
      assert.equal(elements["prerequisites-error-title"].textContent, "Setup hit a problem");
      assert.equal(elements["prerequisites-error-message"].textContent, "Click Retry. If it fails again, open Diagnostics.");
      assert.equal(elements["prerequisites-error-manual-action"].style.display, "none");
      assert.equal(elements["prerequisites-error-followup"].style.display, "none");
      assert.equal(elements["prerequisites-error-recovery"].style.display, "none");
    },
    {
      elements,
      window: {
        setInterval() {
          return 1;
        },
        clearInterval() {},
      },
      electronAPI: {
        async prerequisitesCheckAuthorizeReadiness() {
          return { success: true, ready: false, progressPercent: 55 };
        },
      },
    },
  );
});

test("known prerequisite failure codes render compact Terminal recovery and open Terminal", async () => {
  const mod = loadModule();
  const elements = createPrereqScreenElements();
  const terminalCommands = [];

  await withPrereqDom(async () => {
    mod._test.resetState();
    mod._test.setContext({ onboardingMode: "power", currentStage: "prerequisites" });

    mod._test.handleComplete({
      success: false,
      failedPhase: 2,
      error: "Administrator authorization failed",
      code: "homebrew_sudo_validation_failed",
      details: ["sudo -A -v exit code: 1"],
      results: {
        phase2: { success: false },
      },
    });

    const state = mod._test.getState();
    assert.equal(state.error.code, "homebrew_sudo_validation_failed");
    assert.match(state.error.message, /Homebrew authorization flow failed/);
    assert.equal(elements["prerequisites-title"].style.display, "none");
    assert.equal(elements["prerequisites-progress"].style.display, "none");
    assert.equal(elements["prerequisites-current-step"].style.display, "none");
    assert.equal(elements["prerequisites-spotlight"].style.display, "none");
    assert.equal(elements["prerequisites-error-eyebrow"].style.display, "none");
    assert.equal(elements["prerequisites-error-title"].textContent, "Manual step required...");
    assert.equal(
      elements["prerequisites-error-message"].textContent,
      "Please click the button below.",
    );
    assert.equal(elements["prerequisites-error-manual-action"].style.display, "flex");
    assert.equal(elements["prerequisites-open-terminal-command-btn"].textContent, "Run Setup Step");
    assert.equal(elements["prerequisites-error-followup"].textContent, "");
    assert.equal(elements["prerequisites-error-followup"].style.display, "none");
    assert.equal(elements["prerequisites-error-recovery"].style.display, "block");
    assert.equal(elements["prerequisites-password-guidance"].style.display, "");
    assert.equal(
      elements["prerequisites-password-hint"].textContent,
      "If prompted, enter your password and press Return. Note that you won't see any characters appear as you type, this is normal.",
    );
    assert.equal(elements["prerequisites-error-command-summary"].textContent, "(Optional) View terminal command");
    assert.equal(elements["prerequisites-error-copy-command-btn"].textContent, "Copy Command");
    assert.equal(elements["prerequisites-error-copy-command-btn"].style.display, "inline-flex");
    assert.equal(
      [
        elements["prerequisites-error-message"].textContent,
        elements["prerequisites-error-followup"].textContent,
        elements["prerequisites-password-hint"].textContent,
      ].filter((text) => text.includes("Please click the button below.")).length,
      1,
    );
    assert.doesNotMatch(
      [
        elements["prerequisites-error-eyebrow"].textContent,
        elements["prerequisites-error-title"].textContent,
        elements["prerequisites-error-message"].textContent,
        elements["prerequisites-error-followup"].textContent,
        elements["prerequisites-password-hint"].textContent,
      ].join(" "),
      /\b(Homebrew|OrbStack|Docker)\b/,
    );
    assert.match(elements["prerequisites-error-command"].textContent, /sudo -v/);
    assert.equal(elements["prerequisites-open-terminal-command-btn"].style.display, "inline-flex");

    await elements["prerequisites-open-terminal-command-btn"].click();
    assert.equal(terminalCommands.length, 1);
    assert.equal(terminalCommands[0].startsWith("set -e\n"), true);
    assert.match(terminalCommands[0], /curl -fsSL https:\/\/raw\.githubusercontent\.com\/Homebrew\/install\/HEAD\/install\.sh/);
    assert.doesNotMatch(terminalCommands[0], new RegExp(TERMINAL_RECOVERY_DONE_MESSAGE));
    assert.equal(elements["prerequisites-error-command-status"].textContent, "");
    assert.equal(elements["prerequisites-error-command-status"].style.display, "none");
    assert.equal(elements["prerequisites-error-followup"].textContent, "");
    assert.equal(elements["prerequisites-error-followup"].style.display, "none");
  }, {
    elements,
    electronAPI: {
      async openTerminalWithCommand(text) {
        terminalCommands.push(text);
        return { success: true, copied: true, terminalOpened: true, commandStarted: true };
      },
    },
  });
});

test("homebrew_outdated renders Terminal recovery with a brew update command", async () => {
  const mod = loadModule();
  const elements = createPrereqScreenElements();
  const terminalCommands = [];

  await withPrereqDom(async () => {
    mod._test.resetState();
    mod._test.setContext({ onboardingMode: "power", currentStage: "prerequisites" });

    mod._test.handleComplete({
      success: false,
      failedPhase: 2,
      error: "Homebrew is too old for this version of macOS",
      code: "homebrew_outdated",
      details: ["brew config output: unknown or unsupported macOS version: 26.5"],
      results: {
        phase2: { success: false },
      },
    });

    const state = mod._test.getState();
    assert.equal(state.error.code, "homebrew_outdated");
    assert.match(state.error.message, /predates this version of macOS/);
    assert.equal(elements["prerequisites-error-title"].textContent, "Manual step required...");
    assert.equal(
      elements["prerequisites-error-message"].textContent,
      "Please click the button below.",
    );
    assert.equal(elements["prerequisites-error-manual-action"].style.display, "flex");
    assert.equal(elements["prerequisites-error-recovery"].style.display, "block");
    assert.equal(elements["prerequisites-retry-label"].textContent, "Retry");
    assert.doesNotMatch(
      [
        elements["prerequisites-error-eyebrow"].textContent,
        elements["prerequisites-error-title"].textContent,
        elements["prerequisites-error-message"].textContent,
        elements["prerequisites-error-followup"].textContent,
        elements["prerequisites-password-hint"].textContent,
      ].join(" "),
      /\b(Homebrew|OrbStack|Docker)\b/,
    );

    await elements["prerequisites-open-terminal-command-btn"].click();
    assert.equal(terminalCommands.length, 1);
    assert.equal(terminalCommands[0].startsWith("set -e\n"), true);
    assert.match(terminalCommands[0], /\/usr\/local\/bin\/brew update/);
    assert.match(terminalCommands[0], /\/opt\/homebrew\/bin\/brew update/);
    assert.match(terminalCommands[0], /brew config/);
    assert.doesNotMatch(terminalCommands[0], /sudo -v/);
    assert.doesNotMatch(terminalCommands[0], /install\.sh/);
    assert.doesNotMatch(terminalCommands[0], /xattr|spctl|codesign/);
    assert.doesNotMatch(terminalCommands[0], new RegExp(TERMINAL_RECOVERY_DONE_MESSAGE));
  }, {
    elements,
    electronAPI: {
      async openTerminalWithCommand(text) {
        terminalCommands.push(text);
        return { success: true, copied: true, terminalOpened: true, commandStarted: true };
      },
    },
  });
});

test("manual recovery button distinguishes copy fallback and unavailable states", async () => {
  const mod = loadModule();
  const elements = createPrereqScreenElements();
  const responses = [
    { success: true, copied: true, terminalOpened: true, commandStarted: false },
    { success: false, copied: true, terminalOpened: false, commandStarted: false, error: "automation blocked" },
    { success: false, error: "clipboard denied" },
  ];

  await withPrereqDom(async () => {
    mod._test.resetState();
    mod._test.setContext({ onboardingMode: "power", currentStage: "prerequisites" });

    mod._test.handleComplete({
      success: false,
      failedPhase: 2,
      error: "Administrator authorization failed",
      code: "homebrew_sudo_validation_failed",
      results: {
        phase2: { success: false },
      },
    });

    await elements["prerequisites-open-terminal-command-btn"].click();
    assert.equal(elements["prerequisites-error-followup"].textContent, "Then paste into the terminal and hit Return.");
    assert.equal(elements["prerequisites-error-followup"].style.display, "block");
    assert.equal(elements["prerequisites-error-command-status"].textContent, "");
    assert.equal(elements["prerequisites-error-command-status"].style.display, "none");
    assert.equal(elements["prerequisites-error-command-status"].classList.contains("error"), false);

    await elements["prerequisites-open-terminal-command-btn"].click();
    assert.equal(elements["prerequisites-error-followup"].textContent, "Then paste into the terminal and hit Return.");
    assert.equal(elements["prerequisites-error-followup"].style.display, "block");
    assert.equal(elements["prerequisites-error-command-status"].textContent, "");
    assert.equal(elements["prerequisites-error-command-status"].style.display, "none");
    assert.equal(elements["prerequisites-error-command-status"].classList.contains("error"), false);

    await elements["prerequisites-open-terminal-command-btn"].click();
    assert.equal(elements["prerequisites-error-command-status"].textContent, "Could not copy the command. Use the optional command below or open Diagnostics.");
    assert.equal(elements["prerequisites-error-command-status"].classList.contains("error"), true);
    assert.equal(elements["prerequisites-error-command-details"].open, true);
    assert.equal(elements["prerequisites-error-followup"].style.display, "none");
  }, {
    elements,
    electronAPI: {
      async openTerminalWithCommand() {
        return responses.shift();
      },
    },
  });
});

test("optional command accordion copy button copies command without launching Terminal", async () => {
  const mod = loadModule();
  const elements = createPrereqScreenElements();
  const copied = [];
  const copyFailures = [null, new Error("clipboard denied")];
  let terminalLaunches = 0;

  await withPrereqDom(async () => {
    mod._test.resetState();
    mod._test.setContext({ onboardingMode: "power", currentStage: "prerequisites" });

    mod._test.handleComplete({
      success: false,
      failedPhase: 2,
      error: "Administrator authorization failed",
      code: "homebrew_sudo_validation_failed",
      results: {
        phase2: { success: false },
      },
    });

    assert.equal(elements["prerequisites-error-copy-command-btn"].style.display, "inline-flex");

    await elements["prerequisites-error-copy-command-btn"].click();
    assert.equal(copied.length, 1);
    assert.equal(copied[0].startsWith("set -e\n"), true);
    assert.match(copied[0], /sudo -v/);
    assert.doesNotMatch(copied[0], new RegExp(TERMINAL_RECOVERY_DONE_MESSAGE));
    assert.equal(terminalLaunches, 0);
    assert.equal(elements["prerequisites-error-copy-command-status"].textContent, "Copied.");
    assert.equal(elements["prerequisites-error-copy-command-status"].style.display, "inline");
    assert.equal(elements["prerequisites-error-copy-command-status"].classList.contains("error"), false);
    assert.equal(elements["prerequisites-error-command-status"].style.display, "none");
    assert.equal(elements["prerequisites-error-followup"].style.display, "none");

    await elements["prerequisites-error-copy-command-btn"].click();
    assert.equal(copied.length, 2);
    assert.equal(elements["prerequisites-error-copy-command-status"].textContent, "Copy failed. Select and copy the command manually.");
    assert.equal(elements["prerequisites-error-copy-command-status"].style.display, "inline");
    assert.equal(elements["prerequisites-error-copy-command-status"].classList.contains("error"), true);
    assert.equal(terminalLaunches, 0);
  }, {
    elements,
    electronAPI: {
      async copyToClipboard(value) {
        copied.push(value);
        const failure = copyFailures.shift();
        if (failure) {
          throw failure;
        }
      },
      async openTerminalWithCommand() {
        terminalLaunches += 1;
        return { success: true, copied: true, terminalOpened: true, commandStarted: true };
      },
    },
  });
});

test("manual recovery layout keeps CTA compact and password hint above image", () => {
  const css = fs.readFileSync(
    path.join(__dirname, "../renderer/views/guided-setup.css"),
    "utf8",
  );
  const html = fs.readFileSync(
    path.join(__dirname, "../renderer/views/guided-setup.html"),
    "utf8",
  );

  assert.match(css, /\.prereq-open-terminal-command-btn\s*\{[^}]*min-width:\s*0;/s);
  assert.doesNotMatch(css, /\.prereq-open-terminal-command-btn\s*\{[^}]*min-width:\s*14rem;/s);
  assert.match(css, /\.prerequisites-password-guidance\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s);
  assert.doesNotMatch(css, /\.prerequisites-password-guidance\s*\{[^}]*grid-template-columns:/s);
  assert.ok(
    html.indexOf('id="prerequisites-password-hint"') < html.indexOf('class="prerequisites-password-image"'),
    "password hint should appear above the image in the recovery card",
  );
});

test("OrbStack first-launch approval stays in-app and never offers Terminal", async () => {
  const mod = loadModule();
  const elements = createPrereqScreenElements();

  await withPrereqDom(async () => {
    mod._test.resetState();
    mod._test.setContext({ onboardingMode: "power", currentStage: "prerequisites" });
    mod._test.getState().phases[1].status = "complete";
    mod._test.handlePhaseStart({ phase: 3, label: "Preparing workspace..." });
    mod._test.handleStepUpdate({ step: "orbstack_approval", status: "start", phase: 3 });

    const content = mod._test.getSpotlightContent();
    assert.match(content.helper, /Click <strong>Open<\/strong> once/);
    assert.equal(elements["prerequisites-open-terminal-command-btn"].style.display, "none");

    mod._test.handleComplete({
      success: false,
      failedPhase: 3,
      error: "macOS did not finish opening OrbStack",
      code: "orbstack_launch_approval_timeout",
      results: { phase3: { success: false } },
    });

    assert.equal(elements["prerequisites-error-title"].textContent, "OrbStack is waiting for approval");
    assert.match(elements["prerequisites-error-message"].textContent, /click Open if macOS asks/i);
    assert.equal(elements["prerequisites-open-terminal-command-btn"].style.display, "none");
    assert.equal(elements["prerequisites-error-recovery"].style.display, "none");
    assert.equal(elements["prerequisites-retry-label"].textContent, "Try Again");
  }, { elements });
});

test("all simulated prerequisite error states map to compact main-surface copy", async () => {
  const mod = loadModule();
  const elements = createPrereqScreenElements();
  const cases = [
    {
      state: "generic",
      eyebrow: "",
      title: "Setup hit a problem",
      body: "Click Retry. If it fails again, open Diagnostics.",
      followup: "",
      showsRecovery: false,
      showsPassword: false,
      showsManualAction: false,
    },
    {
      state: "phase1_download_stalled",
      eyebrow: "",
      title: "Download stalled",
      body: "The setup download stopped receiving new bytes for 20 minutes. Check your network or VPN, then click Retry.",
      followup: "",
      showsRecovery: false,
      showsPassword: false,
      showsManualAction: false,
    },
    {
      state: "homebrew_auth_dialog_cancelled",
      eyebrow: "",
      title: "Manual step required...",
      body: "Please click the button below.",
      followup: "",
      showsRecovery: true,
      showsPassword: true,
      showsManualAction: true,
    },
    {
      state: "homebrew_sudo_validation_failed",
      eyebrow: "",
      title: "Manual step required...",
      body: "Please click the button below.",
      followup: "",
      showsRecovery: true,
      showsPassword: true,
      showsManualAction: true,
    },
    {
      state: "homebrew_admin_required",
      eyebrow: "",
      title: "Manual step required...",
      body: "Please click the button below.",
      followup: "",
      showsRecovery: true,
      showsPassword: true,
      showsManualAction: true,
    },
    {
      state: "homebrew_osascript_probe_failed",
      eyebrow: "",
      title: "Manual step required...",
      body: "Please click the button below.",
      followup: "",
      showsRecovery: true,
      showsPassword: true,
      showsManualAction: true,
    },
    {
      state: "homebrew_outdated",
      eyebrow: "",
      title: "Manual step required...",
      body: "Please click the button below.",
      followup: "",
      showsRecovery: true,
      showsPassword: true,
      showsManualAction: true,
    },
    {
      state: "orbstack_stale_artifact_conflict",
      eyebrow: "",
      title: "OrbStack setup needs attention",
      body: "Click Try Again. If it still fails, open Diagnostics—no Terminal command is required.",
      followup: "",
      showsRecovery: false,
      showsPassword: false,
      showsManualAction: false,
    },
    {
      state: "orbstack_cask_xattr_conflict",
      eyebrow: "",
      title: "OrbStack setup needs attention",
      body: "Click Try Again. If it still fails, open Diagnostics—no Terminal command is required.",
      followup: "",
      showsRecovery: false,
      showsPassword: false,
      showsManualAction: false,
    },
    {
      state: "orbstack_manual_recovery_required",
      eyebrow: "",
      title: "OrbStack setup needs attention",
      body: "Click Try Again. If it still fails, open Diagnostics—no Terminal command is required.",
      followup: "",
      showsRecovery: false,
      showsPassword: false,
      showsManualAction: false,
    },
    {
      state: "orbstack_translocated_launch",
      eyebrow: "",
      title: "OrbStack must be fully quit",
      body: "Quit OrbStack completely from its menu bar icon, then click Try Again. Setup will reopen it safely.",
      followup: "",
      showsRecovery: false,
      showsPassword: false,
      showsManualAction: false,
    },
    {
      state: "docker_pull_recovery_required",
      eyebrow: "",
      title: "Manual step required...",
      body: "Please click the button below.",
      followup: "",
      showsRecovery: true,
      showsPassword: true,
      showsManualAction: true,
    },
  ];

  await withPrereqDom(async () => {
    mod._test.resetState();
    mod._test.setContext({ onboardingMode: "power", currentStage: "prerequisites" });
    mod._test.getState().warningMessage = "Background warning";

    for (const testCase of cases) {
      mod._test.simulatePrerequisitesErrorState(testCase.state);
      assert.equal(elements["prerequisites-error"].style.display, "block", testCase.state);
      assert.equal(elements["prerequisites-warning"].style.display, "none", testCase.state);
      assert.equal(elements["prerequisites-title"].style.display, "none", testCase.state);
      assert.equal(elements["prerequisites-progress"].style.display, "none", testCase.state);
      assert.equal(elements["prerequisites-current-step"].style.display, "none", testCase.state);
      assert.equal(elements["prerequisites-spotlight"].style.display, "none", testCase.state);
      assert.equal(elements["prerequisites-error-eyebrow"].textContent, testCase.eyebrow, testCase.state);
      assert.equal(elements["prerequisites-error-eyebrow"].style.display, testCase.eyebrow ? "" : "none", testCase.state);
      assert.equal(elements["prerequisites-error-title"].textContent, testCase.title, testCase.state);
      assert.equal(elements["prerequisites-error-message"].textContent, testCase.body, testCase.state);
      assert.equal(elements["prerequisites-error-followup"].textContent, testCase.followup, testCase.state);
      assert.equal(
        elements["prerequisites-error-followup"].style.display,
        testCase.followup ? "block" : "none",
        testCase.state,
      );
      assert.equal(
        elements["prerequisites-error-manual-action"].style.display,
        testCase.showsManualAction ? "flex" : "none",
        testCase.state,
      );
      assert.equal(
        elements["prerequisites-error-recovery"].style.display,
        testCase.showsRecovery ? "block" : "none",
        testCase.state,
      );
      assert.equal(
        elements["prerequisites-password-guidance"].style.display,
        testCase.showsPassword ? "" : "none",
        testCase.state,
      );
      if (testCase.showsRecovery) {
        assert.equal(elements["prerequisites-error-command-summary"].textContent, "(Optional) View terminal command", testCase.state);
        assert.equal(elements["prerequisites-error-command"].textContent.startsWith("set -e\n"), true, testCase.state);
        assert.doesNotMatch(elements["prerequisites-error-command"].textContent, new RegExp(TERMINAL_RECOVERY_DONE_MESSAGE), testCase.state);
      }
      if (!testCase.state.startsWith("orbstack_")) {
        assert.doesNotMatch(
          [
            elements["prerequisites-error-eyebrow"].textContent,
            elements["prerequisites-error-title"].textContent,
            elements["prerequisites-error-message"].textContent,
            elements["prerequisites-error-followup"].textContent,
            elements["prerequisites-password-hint"].textContent,
          ].join(" "),
          /\b(Homebrew|OrbStack|Docker)\b/,
          testCase.state,
        );
      } else {
        assert.equal(elements["prerequisites-open-terminal-command-btn"].style.display, "none", testCase.state);
        assert.equal(elements["prerequisites-retry-label"].textContent, "Try Again", testCase.state);
      }

      const bodyOccurrenceCount = Object.values(elements)
        .filter((element) => element.style.display !== "none")
        .map((element) => element.textContent || "")
        .filter((text) => text === testCase.body).length;
      assert.equal(bodyOccurrenceCount, 1, testCase.state);
    }
  }, { elements });
});

test("docker recovery payloads render the existing recovery panel and preserve retry codes", async () => {
  const mod = loadModule();
  const elements = createPrereqScreenElements();
  const terminalCommands = [];
  const payloads = [];

  await withPrereqDom(async () => {
    mod._test.resetState();
    mod._test.setContext({ onboardingMode: "power", currentStage: "prerequisites" });

    mod._test.handleComplete({
      success: false,
      failedPhase: 3,
      error: "Docker image downloads stalled",
      code: "docker_pull_recovery_required",
      recovery: {
        title: "Run This In Terminal",
        diagnosis: "Pull the required images in Terminal, then click Retry.",
        command: 'docker pull "nginx:alpine" && \\\necho "Done - click Retry in Portico"',
        restartOnRetry: true,
      },
      results: {
        phase3: { success: false },
      },
    });

    const state = mod._test.getState();
    assert.equal(state.error.code, "docker_pull_recovery_required");
    assert.equal(elements["prerequisites-error-eyebrow"].style.display, "none");
    assert.equal(elements["prerequisites-error-title"].textContent, "Manual step required...");
    assert.equal(
      elements["prerequisites-error-message"].textContent,
      "Please click the button below.",
    );
    assert.equal(elements["prerequisites-error-followup"].textContent, "");
    assert.equal(elements["prerequisites-error-followup"].style.display, "none");
    assert.equal(elements["prerequisites-password-guidance"].style.display, "");
    assert.equal(elements["prerequisites-error-command-summary"].textContent, "(Optional) View terminal command");
    assert.equal(elements["prerequisites-error-command"].textContent.startsWith("set -e\n"), true);
    assert.match(elements["prerequisites-error-command"].textContent, /docker pull "nginx:alpine"/);
    assert.doesNotMatch(elements["prerequisites-error-command"].textContent, new RegExp(TERMINAL_RECOVERY_DONE_MESSAGE));

    await elements["prerequisites-open-terminal-command-btn"].click();
    assert.equal(terminalCommands.length, 1);
    assert.match(terminalCommands[0], /Done - click Retry in Portico/);
    assert.doesNotMatch(terminalCommands[0], new RegExp(TERMINAL_RECOVERY_DONE_MESSAGE));
    assert.equal(elements["prerequisites-error-command-status"].textContent, "");
    assert.equal(elements["prerequisites-error-command-status"].style.display, "none");
    assert.equal(elements["prerequisites-error-followup"].style.display, "none");

    await mod.retryPrerequisites();
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].previousFailureCode, "docker_pull_recovery_required");
    assert.equal(payloads[0].skipHomebrewAuthOnRetry, undefined);
  }, {
    elements,
    electronAPI: {
      async openTerminalWithCommand(text) {
        terminalCommands.push(text);
        return { success: true, copied: true, terminalOpened: true, commandStarted: true };
      },
      async prerequisitesResumeInteractive(payload) {
        payloads.push(payload);
        return { success: true, status: { success: true } };
      },
    },
  });
});

test("prerequisites handlers track docker pull lifecycle, preserve failed phases, and surface host-mode warnings", async () => {
  const mod = loadModule();
  const elements = createPrereqScreenElements();

  await withPrereqDom(async () => {
    mod._test.resetState();
    mod._test.setContext({ onboardingMode: "power", currentStage: "prerequisites" });

    mod._test.handleStart({ totalPhases: 4 });
    mod._test.handlePhaseStart({ phase: 2, label: "Installing dependencies" });
    mod._test.getState().phases[2].status = "failed";
    mod._test.handlePhaseComplete({ phase: 2 });
    mod._test.setHostModeWarning("Host mode is optional here.");
    mod._test.handlePhaseComplete({ phase: 4 });

    mod._test.handleDockerPullStart({
      totalImages: 2,
      images: [
        { image: "redis:7-alpine", label: "Redis Cache" },
        { name: "open-webui", tag: "latest", label: "Open WebUI" },
      ],
    });
    mod._test.handleDockerPull({
      image: "redis:7-alpine",
      label: "Redis Cache",
      status: "pulling",
      percent: 35,
    });
    mod._test.handleDockerPull({
      image: "open-webui:latest",
      label: "Open WebUI",
      status: "extracting",
      percent: 80,
    });
    mod._test.handleDockerPullDeferred({
      deferredImages: ["open-webui:latest"],
      message: "One image will be built locally",
    });
    mod._test.handleDockerPullComplete({
      success: false,
      pulled: ["redis:7-alpine"],
      failed: ["open-webui:latest"],
    });
    mod._test.handleError({ error: "Host mode could not be enabled", phase: 4 });

    const state = mod._test.getState();
    assert.equal(state.phases[2].status, "failed");
    assert.equal(state.phases[4].status, "warning");
    assert.equal(state.error, null);
    assert.equal(state.hostModeWarning, true);
    assert.equal(state.dockerPull.images.get("redis:7-alpine").status, "complete");
    assert.equal(state.dockerPull.images.get("open-webui:latest").status, "failed");
    assert.equal(state.dockerPull.images.get("redis:7-alpine").percent, 100);
    assert.equal(state.dockerPull.completedCount, 2);
    assert.equal(
      state.logs.some((entry) => /Host mode warning: Host mode could not be enabled/.test(entry.text)),
      true,
    );
  }, { elements });
});

test("retryPrerequisites passes Homebrew auth suppression for classified failures", async () => {
  const mod = loadModule();
  const elements = createPrereqScreenElements();
  const payloads = [];

  await withPrereqDom(async () => {
    mod._test.resetState();
    mod._test.setContext({ onboardingMode: "power", currentStage: "prerequisites" });

    mod._test.handleComplete({
      success: false,
      failedPhase: 2,
      error: "Administrator authorization failed",
      code: "homebrew_auth_dialog_cancelled",
      results: {
        phase2: { success: false },
      },
    });

    await mod.retryPrerequisites();

    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].skipHomebrewAuthOnRetry, true);
    assert.equal(payloads[0].previousFailureCode, "homebrew_auth_dialog_cancelled");
  }, {
    elements,
    electronAPI: {
      async prerequisitesResumeInteractive(payload) {
        payloads.push(payload);
        return { success: false, error: "boom" };
      },
    },
  });
});

test("handleBlockingReady polls authorize readiness until ready and auto-advances once", async () => {
  const mod = loadModule();
  const completedSteps = { prerequisites: false, prerequisitesWarning: false };
  let advanceCalls = 0;
  let progressUpdates = 0;
  let intervalId = null;
  let clearedInterval = null;
  const previousClearInterval = global.clearInterval;
  global.clearInterval = (id) => {
    clearedInterval = id;
  };

  try {
    await withImmediateTimeout(async ({ delays }) => {
      await withPrereqDom(
        async () => {
          mod._test.resetState();
          mod._test.setContext(
            {
              onboardingMode: "power",
              currentStage: "prerequisites",
              completedSteps,
            },
            {
              updateProgressTracker() {
                progressUpdates += 1;
              },
              advanceAfterPrerequisites() {
                advanceCalls += 1;
              },
            },
          );

          mod._test.handleBlockingReady();
          await flushPromises();

          const state = mod._test.getState();
          assert.equal(state.authorizeReadiness.ready, true);
          assert.equal(state.autoAdvanceTriggered, true);
          assert.equal(completedSteps.prerequisites, true);
          assert.equal(progressUpdates, 1);
          assert.equal(advanceCalls, 1);
          assert.equal(clearedInterval, intervalId);
          assert.deepEqual(delays, [2000]);
        },
        {
          window: {
            setInterval(handler) {
              intervalId = 42;
              handler();
              return intervalId;
            },
          },
          electronAPI: {
            async prerequisitesCheckAuthorizeReadiness() {
              return { success: true, ready: true, progressPercent: 100 };
            },
          },
        },
      );
    });
  } finally {
    global.clearInterval = previousClearInterval;
  }
});

test("hydrateStatusSnapshot clamps prior progress and retryPrerequisites logs failed restart paths", async () => {
  const mod = loadModule();

  await withPrereqDom(
    async () => {
      mod._test.resetState();
      mod._test.setContext({ onboardingMode: "power", currentStage: "prerequisites" });

      mod._test.hydrateStatusSnapshot({
        running: false,
        currentSequence: "failed",
        activePhase: 4,
        blockingReady: false,
        backgroundReady: false,
        lastError: "Previous failure",
        phaseResults: {
          phase4: { success: false },
        },
        phase1Progress: {
          percent: 180,
          bytesDownloaded: -5,
          totalBytes: 0,
        },
      });

      let state = mod._test.getState();
      assert.equal(state.phase1Progress.percent, 100);
      assert.equal(state.phase1Progress.bytesDownloaded, 0);
      assert.equal(state.phase1Progress.totalBytes, null);
      assert.equal(state.phases[4].status, "warning");
      assert.equal(state.hostModeWarning, true);

      const collected = await mod.collectPrereqDebugInfo();
      assert.deepEqual(collected, { success: true, zipFile: "/tmp/prereq.zip" });

      await mod.retryPrerequisites();
      state = mod._test.getState();
      assert.equal(
        state.logs.some((entry) => /Failed to restart prerequisites: boom/.test(entry.text)),
        true,
      );
      assert.equal(state.dockerPull.images.size > 0, true);

      global.window.electronAPI.prerequisitesResumeInteractive = async () => {
        throw new Error("boom");
      };
      await mod.retryPrerequisites();
      assert.equal(
        mod._test
          .getState()
          .logs.some((entry) => /Error retrying: boom/.test(entry.text)),
        true,
      );
    },
    {
      electronAPI: {
        async collectDebugInfo() {
          return { success: true, zipFile: "/tmp/prereq.zip" };
        },
        async prerequisitesResumeInteractive() {
          return { success: false, error: "boom" };
        },
      },
    },
  );
});
