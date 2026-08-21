const test = require("node:test");
const assert = require("node:assert/strict");

const { FakeElement } = require("./test-helpers/fake-dom");

function loadModule() {
  const modulePath = require.resolve(
    "../renderer/screens/guided-setup/screen-finalize",
  );
  delete require.cache[modulePath];
  return require("../renderer/screens/guided-setup/screen-finalize");
}

async function withFinalizeDom(run, options = {}) {
  const stage = new FakeElement("stage-finalize");
  if (options.activeStage !== false) {
    stage.classList.add("active");
  }
  const setupStep = new FakeElement("setup-step");
  const wrapupLabel = new FakeElement("finalize-wrapup-label");
  const statusEl = new FakeElement("finalize-status");
  const backBtn = new FakeElement("finalize-readiness-back-btn");
  stage.querySelector = (selector) => {
    if (selector === ".setup-step") return setupStep;
    if (selector === ".finalize-wrapup-label") return wrapupLabel;
    return null;
  };

  const previousDocument = global.document;
  global.document = {
    getElementById(id) {
      if (id === "stage-finalize") return stage;
      if (id === "finalize-status") return statusEl;
      if (
        id === "finalize-readiness-back-btn" &&
        statusEl.innerHTML.includes('id="finalize-readiness-back-btn"')
      ) {
        return backBtn;
      }
      return null;
    },
  };

  try {
    return await run({ stage, setupStep, wrapupLabel, statusEl, backBtn });
  } finally {
    global.document = previousDocument;
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

async function withMockedNow(sequence, run) {
  const previousDateNow = Date.now;
  let index = 0;
  Date.now = () => {
    const value = sequence[Math.min(index, sequence.length - 1)];
    index += 1;
    return value;
  };

  try {
    return await run();
  } finally {
    Date.now = previousDateNow;
  }
}

test("finalize helper detects host selections", () => {
  const mod = loadModule();

  assert.equal(
    mod._test.hasHostSelections({
      selectedServers: [1],
      mcpServers: [
        { id: "data-plat-mcp", deploymentType: "docker" },
        { id: "chrome-devtools", deploymentType: "host" },
      ],
    }),
    true,
  );
  assert.equal(
    mod._test.hasHostSelections({
      selectedServers: [0],
      mcpServers: [{ id: "glean", deploymentType: "docker" }],
    }),
    false,
  );
  assert.deepEqual(
    mod._test.getSelectedServerIds({
      selectedServers: [1, 0, 1],
      mcpServers: [
        { id: "data-plat-mcp", deploymentType: "docker" },
        { id: "chrome-devtools", deploymentType: "host" },
      ],
    }),
    ["chrome-devtools", "data-plat-mcp"],
  );
});

test("persistMcpTogglesFromSelection preserves hidden or unrelated toggles and writes explicit guided setup choices", async () => {
  const previousWindow = global.window;
  let savedPayload = null;
  global.window = {
    electronAPI: {
      async applyGuidedSetupMcpToggleChanges(payload) {
        savedPayload = payload;
        return { success: true, applied: true, changedServerIds: ["glean"] };
      },
    },
  };

  try {
    const mod = loadModule();
    await mod.persistMcpTogglesFromSelection({
      selectedServers: [1],
      mcpServers: [
        { id: "skills", isCore: true },
        { id: "glean" },
        { id: "custom", userInstalled: true },
        { id: "chrome-devtools", deploymentType: "host" },
        { id: "google_workspace" },
      ],
      hostModeSupported: false,
      launchContext: { setupMode: "full" },
      mcpToggleState: {
        writeMode: "apply",
        changes: { glean: true, google_workspace: false },
      },
    });

    assert.deepEqual(savedPayload, {
      setupOperationId: null,
      setupMode: "full",
      setupReason: null,
      changes: { glean: true, google_workspace: false },
    });
  } finally {
    global.window = previousWindow;
  }
});

test("persistMcpTogglesFromSelection leaves contractor-disabled Data Platform untouched", async () => {
  const previousWindow = global.window;
  let savedPayload = null;
  global.window = {
    electronAPI: {
      async applyGuidedSetupMcpToggleChanges(payload) {
        savedPayload = payload;
        return { success: true };
      },
    },
  };

  try {
    const mod = loadModule();
    await mod.persistMcpTogglesFromSelection({
      selectedServers: [1],
      mcpServers: [
        { id: "data-plat-mcp" },
        { id: "glean" },
      ],
      hostModeSupported: true,
      guidedSetupDisabledServerIds: new Set(["data-plat-mcp"]),
      mcpToggleState: {
        writeMode: "apply",
        changes: { glean: true },
      },
    });

    assert.deepEqual(savedPayload.changes, { glean: true });
    assert.equal("data-plat-mcp" in savedPayload.changes, false);
  } finally {
    global.window = previousWindow;
  }
});

test("generateEnvFile strips runtime-only API keys and upserts guided setup values", async () => {
  const previousWindow = global.window;
  let writtenContent = "";
  const runtimeSecretWrites = [];
  global.window = {
    electronAPI: {
      async readEnvFile() {
        return {
          success: true,
          content:
            "PORTICO_USER_ID=fresh-id\nPORTICO_USER_NAME=Fresh User\nPORTICO_LLM_API_KEY=old-key\nLOCAL_STACK_API_KEY=local-old\nCLOUDSMITH_ENTITLEMENT_TOKEN=cloudsmith-old\nSLACK_TOKEN=legacy\n",
        };
      },
      async writeEnvFile(content) {
        writtenContent = content;
        return { success: true };
      },
      async upsertRuntimeSecret(key, value) {
        runtimeSecretWrites.push({ key, value });
        return { success: true };
      },
    },
  };

  try {
    const mod = loadModule();
    await mod.generateEnvFile(
      {
        envVars: {
          PORTICO_USER_ID: "stale-id",
          PORTICO_USER_NAME: "Stale User",
          SLACK_TOKEN: "new-token",
          PORTICO_LLM_API_KEY: "sk-portico-where-real-key",
          TEAMWORKS_KEY: "teamworks-secret",
        },
      },
      "/tmp/project",
    );

    assert.doesNotMatch(writtenContent, /PORTICO_LLM_API_KEY=/);
    assert.doesNotMatch(writtenContent, /LOCAL_STACK_API_KEY=/);
    assert.doesNotMatch(writtenContent, /CLOUDSMITH_ENTITLEMENT_TOKEN=/);
    assert.match(writtenContent, /SLACK_TOKEN=new-token/);
    assert.match(writtenContent, /TEAMWORKS_KEY=teamworks-secret/);
    assert.match(writtenContent, /PORTICO_USER_ID=fresh-id/);
    assert.match(writtenContent, /PORTICO_USER_NAME=Fresh User/);
    assert.doesNotMatch(writtenContent, /stale-id|Stale User/);
    assert.deepEqual(runtimeSecretWrites, [
      { key: "PORTICO_LLM_API_KEY", value: "sk-portico-where-real-key" },
    ]);
  } finally {
    global.window = previousWindow;
  }
});

test("generateEnvFile stores sensitive required MCP vars securely and preserves non-sensitive setup values", async () => {
  const previousWindow = global.window;
  let writtenContent = "";
  const runtimeSecretWrites = [];
  global.window = {
    electronAPI: {
      async readEnvFile() {
        return {
          success: true,
          content: [
            "MATRIX_SECRET=old-secret",
            "MATRIX_SECRET_FILE=/tmp/old-secret",
            "MATRIX_PUBLIC=old-public",
            "",
          ].join("\n"),
        };
      },
      async writeEnvFile(content) {
        writtenContent = content;
        return { success: true };
      },
      async upsertRuntimeSecret(key, value) {
        runtimeSecretWrites.push({ key, value });
        return { success: true };
      },
    },
  };

  try {
    const mod = loadModule();
    await mod.generateEnvFile(
      {
        serverConfigs: [
          {
            required_env_vars: [
              { name: "MATRIX_SECRET", sensitive: true },
              { name: "MATRIX_PUBLIC", sensitive: false },
              "MATRIX_LEGACY",
            ],
          },
        ],
        envVars: {
          MATRIX_SECRET: "new-secret",
          MATRIX_PUBLIC: "new-public",
          MATRIX_LEGACY: "legacy-public",
          MATRIX_PRESET: "preset value",
        },
      },
      "/tmp/project",
    );

    assert.doesNotMatch(writtenContent, /MATRIX_SECRET=/);
    assert.doesNotMatch(writtenContent, /MATRIX_SECRET_FILE=/);
    assert.match(writtenContent, /MATRIX_PUBLIC=new-public/);
    assert.match(writtenContent, /MATRIX_LEGACY=legacy-public/);
    assert.match(writtenContent, /MATRIX_PRESET=preset value/);
    assert.deepEqual(runtimeSecretWrites, [
      { key: "MATRIX_SECRET", value: "new-secret" },
    ]);
  } finally {
    global.window = previousWindow;
  }
});

test("waitForFinalizeReadiness passes the selected mode and host-selection context to the readiness IPC", async () => {
  await withFinalizeDom(async ({ setupStep, wrapupLabel, statusEl }) => {
    const previousWindow = global.window;
    const calls = [];
    global.window = {
      electronAPI: {
        async prerequisitesCheckFinalizeReadiness(payload) {
          calls.push(payload);
          return { success: true, ready: true };
        },
      },
    };

    try {
      const mod = loadModule();
      const ready = await mod._test.waitForFinalizeReadiness({
        onboardingMode: "basic",
        selectedServers: [0],
        mcpServers: [{ id: "chrome-devtools", deploymentType: "host" }],
      });

      assert.equal(ready, true);
      assert.deepEqual(calls, [
        {
          mode: "basic",
          hasHostSelections: true,
          selectedServerIds: ["chrome-devtools"],
        },
      ]);
      assert.equal(setupStep.style.display, "");
      assert.equal(wrapupLabel.textContent, "Wrapping things up...");
      assert.equal(statusEl.innerHTML, "");
    } finally {
      global.window = previousWindow;
    }
  });
});

test("finalize gate helpers render and clear blocked finalize state", async () => {
  const mod = loadModule();

  await withFinalizeDom(async ({ setupStep, wrapupLabel, statusEl }) => {
    mod._test.renderFinalizeGateState({
      title: "Finalize is blocked.",
      error: "Docker images are still downloading",
    });

    assert.equal(setupStep.style.display, "none");
    assert.equal(statusEl.getAttribute("aria-hidden"), "false");
    assert.match(statusEl.innerHTML, /Docker images are still downloading/);

    mod._test.clearFinalizeGateState();
    assert.equal(setupStep.style.display, "");
    assert.equal(wrapupLabel.textContent, "Wrapping things up...");
    assert.equal(statusEl.innerHTML, "");
    assert.equal(statusEl.getAttribute("aria-hidden"), "true");
  });
});

test("finalize gate offers a prereqs escape hatch for readiness blocks", async () => {
  const previousWindow = global.window;
  const navigatedSteps = [];

  await withFinalizeDom(async ({ statusEl, backBtn }) => {
    global.window = {
      navigateToStep(stepName) {
        navigatedSteps.push(stepName);
      },
    };

    try {
      const mod = loadModule();
      mod._test.renderFinalizeGateState({
        title: "Finalize is blocked.",
        error: "Docker images are still downloading",
        allowPrereqNavigation: true,
      });

      assert.match(statusEl.innerHTML, /Go to Prereqs/);
      assert.equal(typeof backBtn.onclick, "function");

      await backBtn.click();

      assert.deepEqual(navigatedSteps, ["prerequisites"]);
    } finally {
      global.window = previousWindow;
    }
  });
});

function wireFinalizeGateButtons(statusEl) {
  const retryButton = new FakeElement("finalize-retry");
  const startOverButton = new FakeElement("finalize-start-over");
  statusEl.querySelector = (selector) => {
    if (
      selector === "[data-finalize-retry]" &&
      statusEl.innerHTML.includes("data-finalize-retry")
    ) {
      return retryButton;
    }
    if (
      selector === "[data-finalize-start-over]" &&
      statusEl.innerHTML.includes("data-finalize-start-over")
    ) {
      return startOverButton;
    }
    return null;
  };
  return { retryButton, startOverButton };
}

test("finalize gate retry re-runs finalize without resetting the wizard", async () => {
  const mod = loadModule();

  await withFinalizeDom(async ({ statusEl }) => {
    const { retryButton } = wireFinalizeGateButtons(statusEl);
    let finalizeCalls = 0;
    let restartCalls = 0;

    mod._test.renderFinalizeGateState({
      title: "Finalize is blocked.",
      error: "Docker image was removed",
      retry: true,
      callbacks: {
        finalizeSetup() {
          finalizeCalls += 1;
        },
        restartSetupWizardFromFinalize() {
          restartCalls += 1;
        },
      },
    });

    assert.match(statusEl.innerHTML, /data-finalize-retry/);
    assert.match(statusEl.innerHTML, />Retry</);

    await retryButton.click();

    // Retry means retry: finalize re-runs, OAuth progress survives.
    assert.equal(finalizeCalls, 1);
    assert.equal(restartCalls, 0);
    assert.equal(statusEl.innerHTML, "");
    assert.equal(statusEl.getAttribute("aria-hidden"), "true");
  });
});

test("finalize gate retry re-runs finalize for a busy MCP mutation error", async () => {
  const mod = loadModule();

  await withFinalizeDom(async ({ statusEl }) => {
    const { retryButton } = wireFinalizeGateButtons(statusEl);
    let finalizeCalls = 0;
    let restartCalls = 0;

    mod._test.renderFinalizeGateState({
      title: "Setup could not be completed",
      error:
        "Failed to update .env file: Another MCP change is still running (stop_single_mcp_server, started by configuration_modal, 0s ago).",
      errorCode: "MCP_OPERATION_BUSY",
      retry: true,
      callbacks: {
        finalizeSetup() {
          finalizeCalls += 1;
        },
        restartSetupWizardFromFinalize() {
          restartCalls += 1;
        },
      },
    });

    await retryButton.click();

    assert.equal(finalizeCalls, 1);
    assert.equal(restartCalls, 0);
  });
});

test("finalize gate start-over button restarts the setup wizard", async () => {
  const mod = loadModule();

  await withFinalizeDom(async ({ statusEl }) => {
    const { startOverButton } = wireFinalizeGateButtons(statusEl);
    let finalizeCalls = 0;
    let restartCalls = 0;

    mod._test.renderFinalizeGateState({
      title: "Finalize is blocked.",
      error: "Docker image was removed",
      retry: true,
      callbacks: {
        finalizeSetup() {
          finalizeCalls += 1;
        },
        restartSetupWizardFromFinalize() {
          restartCalls += 1;
        },
      },
    });

    assert.match(statusEl.innerHTML, /data-finalize-start-over/);
    assert.match(statusEl.innerHTML, />Start over</);

    await startOverButton.click();

    assert.equal(restartCalls, 1);
    assert.equal(finalizeCalls, 0);
    assert.equal(statusEl.innerHTML, "");
  });
});

test("finalize gate retry falls back to a wizard restart when finalize is unavailable", async () => {
  const mod = loadModule();

  await withFinalizeDom(async ({ statusEl }) => {
    const { retryButton } = wireFinalizeGateButtons(statusEl);
    let restartCalls = 0;

    mod._test.renderFinalizeGateState({
      title: "Finalize is blocked.",
      error: "Docker image was removed",
      retry: true,
      callbacks: {
        restartSetupWizardFromFinalize() {
          restartCalls += 1;
        },
      },
    });

    await retryButton.click();

    assert.equal(restartCalls, 1);
    assert.equal(statusEl.innerHTML, "");
    assert.equal(statusEl.getAttribute("aria-hidden"), "true");
  });
});

test("waitForFinalizeReadiness blocks finalize when readiness reports an error", async () => {
  const previousWindow = global.window;

  await withFinalizeDom(async ({ statusEl }) => {
    global.window = {
      electronAPI: {
        async prerequisitesCheckFinalizeReadiness() {
          return { success: false, error: "Still preparing Docker" };
        },
      },
    };

    try {
      const mod = loadModule();
      const ready = await mod._test.waitForFinalizeReadiness({
        onboardingMode: "power",
        selectedServers: [],
        mcpServers: [],
      });

      assert.equal(ready, false);
      assert.match(statusEl.innerHTML, /Still preparing Docker/);
    } finally {
      global.window = previousWindow;
    }
  });
});

test("waitForFinalizeReadiness resumes prerequisites once for the generic stale prereq block and then succeeds", async () => {
  const previousWindow = global.window;

  await withImmediateTimeout(async ({ delays }) => {
    await withFinalizeDom(async ({ statusEl }) => {
      let readinessCalls = 0;
      const resumeCalls = [];
      global.window = {
        electronAPI: {
          async prerequisitesCheckFinalizeReadiness() {
            readinessCalls += 1;
            if (readinessCalls === 1) {
              return {
                success: true,
                ready: false,
                waiting: false,
                error: "Oops, something went wrong. Please navigate to the prereqs step.",
              };
            }
            return { success: true, ready: true };
          },
          async prerequisitesResumeInteractive(payload) {
            resumeCalls.push(payload);
            return { success: true, started: true };
          },
        },
      };

      try {
        const mod = loadModule();
        const ready = await mod._test.waitForFinalizeReadiness({
          onboardingMode: "power",
          selectedServers: [],
          mcpServers: [],
        });

        assert.equal(ready, true);
        assert.deepEqual(resumeCalls, [{
          onboardingMode: "power",
          purpose: "guided-setup-finalize",
          hasHostSelections: false,
          selectedServerIds: [],
        }]);
        assert.deepEqual(delays, [1200]);
        assert.equal(statusEl.innerHTML, "");
      } finally {
        global.window = previousWindow;
      }
    });
  });
});

test("waitForFinalizeReadiness uses a monotonic wall-clock timeout and does not reset on progress updates", async () => {
  const previousWindow = global.window;
  const timeoutMs = loadModule()._test.FINALIZE_WAIT_TIMEOUT_MS;

  await withImmediateTimeout(async () => {
    await withMockedNow(
      [
        0,
        0,
        0,
        timeoutMs - 1,
        timeoutMs + 2,
      ],
      async () => {
        await withFinalizeDom(async ({ statusEl }) => {
          let readinessCalls = 0;
          global.window = {
            electronAPI: {
              async prerequisitesCheckFinalizeReadiness() {
                readinessCalls += 1;
                return readinessCalls === 1
                  ? {
                      success: true,
                      ready: false,
                      waiting: true,
                      progressPercent: 84,
                      missingImages: ["first:image"],
                    }
                  : {
                      success: true,
                      ready: false,
                      waiting: true,
                      progressPercent: 85,
                      missingImages: ["second:image"],
                    };
              },
            },
          };

          try {
            const mod = loadModule();
            const ready = await mod._test.waitForFinalizeReadiness({
              onboardingMode: "power",
              selectedServers: [],
              mcpServers: [],
            });

            assert.equal(ready, false);
            assert.equal(readinessCalls, 2);
            assert.match(
              statusEl.innerHTML,
              /Finalize timed out after 15 minutes/,
            );
            assert.doesNotMatch(statusEl.innerHTML, /first:image/);
            assert.match(statusEl.innerHTML, /second:image/);
            assert.match(statusEl.innerHTML, /manually pull the missing Docker images/i);
          } finally {
            global.window = previousWindow;
          }
        });
      },
    );
  });
});

test("waitForFinalizeReadiness renders the recovery failure when restarting prerequisites fails", async () => {
  const previousWindow = global.window;

  await withImmediateTimeout(async () => {
    await withFinalizeDom(async ({ statusEl }) => {
      global.window = {
        electronAPI: {
          async prerequisitesCheckFinalizeReadiness() {
            return {
              success: true,
              ready: false,
              waiting: false,
              error: "Oops, something went wrong. Please navigate to the prereqs step.",
            };
          },
          async prerequisitesResumeInteractive() {
            return { success: false, error: "restart failed" };
          },
        },
      };

      try {
        const mod = loadModule();
        const ready = await mod._test.waitForFinalizeReadiness({
          onboardingMode: "power",
          selectedServers: [],
          mcpServers: [],
        });

        assert.equal(ready, false);
        assert.match(statusEl.innerHTML, /restart failed/);
      } finally {
        global.window = previousWindow;
      }
    });
  });
});

test("waitForFinalizeReadiness short-circuits without a checker and returns blocked when the stage is inactive or readiness surfaces an error field", async () => {
  await withFinalizeDom(async () => {
    const previousWindow = global.window;
    global.window = { electronAPI: {} };

    try {
      const mod = loadModule();
      const ready = await mod._test.waitForFinalizeReadiness({
        onboardingMode: "power",
        selectedServers: [],
        mcpServers: [],
      });
      assert.equal(ready, true);
    } finally {
      global.window = previousWindow;
    }
  });

  const previousWindow = global.window;
  await withFinalizeDom(async ({ statusEl }) => {
    global.window = {
      electronAPI: {
        async prerequisitesCheckFinalizeReadiness() {
          return { success: true, ready: false, error: "Need host mode assets" };
        },
      },
    };

    try {
      const mod = loadModule();
      const ready = await mod._test.waitForFinalizeReadiness({
        onboardingMode: "power",
        selectedServers: [],
        mcpServers: [],
      });
      assert.equal(ready, false);
      assert.match(statusEl.innerHTML, /Need host mode assets/);
    } finally {
      global.window = previousWindow;
    }
  });

  await withFinalizeDom(
    async () => {
      global.window = {
        electronAPI: {
          async prerequisitesCheckFinalizeReadiness() {
            return { success: true, ready: false, progressPercent: 50 };
          },
        },
      };

      try {
        const mod = loadModule();
        const ready = await mod._test.waitForFinalizeReadiness({
          onboardingMode: "power",
          selectedServers: [],
          mcpServers: [],
        });
        assert.equal(ready, false);
      } finally {
        global.window = previousWindow;
      }
    },
    { activeStage: false },
  );
});

test("generateMcpConfig and persistMcpTogglesFromSelection surface downstream failures", async () => {
  const previousWindow = global.window;

  try {
    global.window = {
      electronAPI: {
        async applyGuidedSetupMcpToggleChanges() {
          return { success: false, error: "save failed" };
        },
        async generateMcpConfig() {
          throw new Error("spawn failed");
        },
      },
    };

    const mod = loadModule();
    await assert.rejects(
      () =>
        mod.persistMcpTogglesFromSelection({
          selectedServers: [0],
          mcpServers: [{ id: "glean" }],
          hostModeSupported: true,
          mcpToggleState: {
            writeMode: "apply",
            changes: { glean: true },
          },
        }),
      /Failed to persist MCP server selection: save failed/,
    );
    await assert.rejects(
      () => mod.generateMcpConfig(null),
      /projectRoot \(string\) is required/,
    );
    await assert.rejects(
      () => mod.generateMcpConfig("/tmp/project"),
      /Failed to generate MCP configuration: spawn failed/,
    );
  } finally {
    global.window = previousWindow;
  }
});

test("generateMcpConfig includes IPC stderr details when config generation fails", async () => {
  const previousWindow = global.window;

  try {
    global.window = {
      electronAPI: {
        async generateMcpConfig() {
          return {
            success: false,
            error: "Command failed: generate-mcp-config",
            details: "stderr:\nmissing browser-use config cleanup",
          };
        },
      },
    };

    const mod = loadModule();
    await assert.rejects(
      () => mod.generateMcpConfig("/tmp/project"),
      /Failed to generate MCP configuration: Command failed: generate-mcp-config\s+stderr:\nmissing browser-use config cleanup/,
    );
  } finally {
    global.window = previousWindow;
  }
});

test("finalizeSetup runs the full happy path and records completion before showing success", async () => {
  const previousWindow = global.window;
  const logs = [];
  const shownStages = [];
  const commands = [];
  let wroteEnv = null;
  let savedTogglePayload = null;

  await withFinalizeDom(async () => {
    global.window = {
      electronAPI: {
        async prerequisitesCheckFinalizeReadiness() {
          return { success: true, ready: true };
        },
        async readEnvFile() {
          return {
            success: true,
            content:
              "CLOUDSMITH_API_KEY=protected-release-key\nSLACK_TOKEN=old\n",
          };
        },
        async writeEnvFile(content) {
          wroteEnv = content;
          return { success: true };
        },
        async applyGuidedSetupMcpToggleChanges(payload) {
          savedTogglePayload = payload;
          return { success: true };
        },
        async generateMcpConfig(projectRoot) {
          commands.push(projectRoot);
          return { success: true };
        },
        async markSetupRequirementCompleted() {
          return { success: true, setupRequirementId: "requirement-a" };
        },
      },
    };

    try {
      const mod = loadModule();
      await mod.finalizeSetup(
        {
          onboardingMode: "basic",
          envVars: {
            SLACK_TOKEN: "new",
          },
          selectedServers: [0],
          mcpServers: [{ id: "glean" }],
          hostModeSupported: true,
          mcpToggleState: {
            writeMode: "apply",
            changes: { glean: true },
          },
        },
        "/tmp/project",
        {
          addLog(message, level) {
            logs.push({ message, level });
          },
          showStage(stage) {
            shownStages.push(stage);
          },
        },
      );
    } finally {
      global.window = previousWindow;
    }
  });

  assert.match(wroteEnv, /SLACK_TOKEN=new/);
  assert.match(wroteEnv, /CLOUDSMITH_API_KEY=protected-release-key/);
  assert.deepEqual(savedTogglePayload.changes, { glean: true });
  assert.deepEqual(commands, ["/tmp/project"]);
  assert.deepEqual(shownStages, ["success"]);
  assert.deepEqual(logs, [
    { message: ".env file updated", level: "success" },
    { message: "MCP server selection saved", level: "success" },
    { message: "MCP configuration generated", level: "success" },
    {
      message: "Setup completion recorded for requirement requirement-a",
      level: "success",
    },
    { message: "Setup completed successfully!", level: "success" },
  ]);
});

test("finalizeSetup logs failures instead of advancing when completion persistence fails", async () => {
  const previousWindow = global.window;
  const logs = [];
  const shownStages = [];

  await withFinalizeDom(async () => {
    global.window = {
      electronAPI: {
        async prerequisitesCheckFinalizeReadiness() {
          return { success: true, ready: true };
        },
        async readEnvFile() {
          return { success: true, content: "" };
        },
        async writeEnvFile() {
          return { success: true };
        },
        async loadMcpToggles() {
          return { success: true, data: {} };
        },
        async saveMcpToggles() {
          return { success: true };
        },
        async generateMcpConfig() {
          return { success: true };
        },
        async markSetupRequirementCompleted() {
          return { success: false, error: "db write failed" };
        },
      },
    };

    try {
      const mod = loadModule();
      await mod.finalizeSetup(
        {
          onboardingMode: "power",
          envVars: {},
          selectedServers: [],
          mcpServers: [],
          hostModeSupported: true,
        },
        "/tmp/project",
        {
          addLog(message, level) {
            logs.push({ message, level });
          },
          showStage(stage) {
            shownStages.push(stage);
          },
        },
      );
    } finally {
      global.window = previousWindow;
    }
  });

  assert.deepEqual(shownStages, []);
  assert.deepEqual(logs.at(-1), {
    message: "Setup failed: db write failed",
    level: "error",
  });
});

test("packaged mcp-orc errors render packaged-binary guidance instead of Rust guidance", async () => {
  const mod = loadModule();

  await withFinalizeDom(async ({ statusEl }) => {
    mod._test.renderFinalizeGateState({
      title: "Setup could not be completed",
      error:
        "Failed to generate MCP configuration: Packaged macOS app requires bundled signed mcp-orc at /Applications/Portico.app/Contents/Resources/host-mcp-binaries/aarch64-apple-darwin/mcp-orc",
    });

    assert.match(statusEl.innerHTML, /missing its bundled MCP generator binary/i);
    assert.doesNotMatch(statusEl.innerHTML, /Rust toolchain is required in development mode/i);
  });
});

test("generateEnvFile creates a new file when no env exists and finalizeSetup exits quietly when readiness stays blocked", async () => {
  const previousWindow = global.window;
  let writtenContent = "";

  try {
    global.window = {
      electronAPI: {
        async readEnvFile() {
          return { success: false };
        },
        async writeEnvFile(content) {
          writtenContent = content;
          return { success: true, content };
        },
      },
    };

    const mod = loadModule();
    await mod.generateEnvFile(
      {
        envVars: {
          SLACK_TOKEN: "fresh-token",
        },
      },
      "/tmp/project",
    );
  } finally {
    global.window = previousWindow;
  }

  assert.match(writtenContent, /# Portico Configuration/);
  assert.match(writtenContent, /SLACK_TOKEN=fresh-token/);

  const blockedLogs = [];
  const shownStages = [];
  await withFinalizeDom(async () => {
    global.window = {
      electronAPI: {
        async prerequisitesCheckFinalizeReadiness() {
          return { success: false, error: "Still blocked" };
        },
      },
    };

    try {
      const mod = loadModule();
      await mod.finalizeSetup(
        {
          onboardingMode: "power",
          envVars: {},
          selectedServers: [],
          mcpServers: [],
          hostModeSupported: true,
        },
        "/tmp/project",
        {
          addLog(message, level) {
            blockedLogs.push({ message, level });
          },
          showStage(stage) {
            shownStages.push(stage);
          },
        },
      );
    } finally {
      global.window = previousWindow;
    }
  });

  assert.deepEqual(shownStages, []);
  assert.deepEqual(blockedLogs, []);
});

test("finalize strips Ultra signing secret plaintext and stores it securely", async () => {
  const previousWindow = global.window;
  const plaintextSecret = "ultra-sign-v1-finalize-test-secret";
  let writtenContent = "";
  const runtimeSecretWrites = [];
  global.window = {
    electronAPI: {
      async readEnvFile() {
        return {
          success: true,
          content: [
            "ULTRA_MULTI_AGENT_SIGNING_SECRET=" + plaintextSecret,
            "ULTRA_MULTI_AGENT_SIGNING_SECRET_FILE=/tmp/ultra-signing-secret",
            "VISIBLE_SETTING=old",
            "",
          ].join("\n"),
        };
      },
      async writeEnvFile(content) {
        writtenContent = content;
        return { success: true };
      },
      async upsertRuntimeSecret(key, value) {
        runtimeSecretWrites.push({ key, value });
        return { success: true };
      },
    },
  };

  try {
    const mod = loadModule();
    await mod.generateEnvFile(
      {
        envVars: {
          ULTRA_MULTI_AGENT_SIGNING_SECRET: plaintextSecret,
          VISIBLE_SETTING: "updated",
        },
      },
      "/tmp/project",
    );

    assert.doesNotMatch(
      writtenContent,
      /ULTRA_MULTI_AGENT_SIGNING_SECRET(?:_FILE)?=/,
    );
    assert.match(writtenContent, /VISIBLE_SETTING=updated/);
    assert.deepEqual(runtimeSecretWrites, [
      {
        key: "ULTRA_MULTI_AGENT_SIGNING_SECRET",
        value: plaintextSecret,
      },
    ]);
  } finally {
    global.window = previousWindow;
  }
});

test("finalize gate escapes error text instead of injecting it as markup", async () => {
  const mod = loadModule();

  await withFinalizeDom(async ({ statusEl }) => {
    mod._test.renderFinalizeGateState({
      title: "Setup could not be <b>completed</b>",
      error: '<img src=x onerror="alert(1)">',
      callbacks: {},
    });

    assert.doesNotMatch(statusEl.innerHTML, /<img /);
    assert.doesNotMatch(statusEl.innerHTML, /<b>completed<\/b>/);
    assert.match(statusEl.innerHTML, /&lt;img src=x onerror=/);
    assert.match(statusEl.innerHTML, /&lt;b&gt;completed&lt;\/b&gt;/);
  });
});

test("finalize gate replaces the prereqs advice for a busy MCP mutation", async () => {
  const mod = loadModule();

  await withFinalizeDom(async ({ statusEl }) => {
    const previousWindow = global.window;
    global.window = { navigateToStep() {} };
    try {
      mod._test.renderFinalizeGateState({
        title: "Setup could not be completed",
        error:
          "Failed to update .env file: Another MCP change is still running (docker_restart, started by control_plane, 4m ago).",
        errorCode: "MCP_OPERATION_BUSY",
        allowPrereqNavigation: true,
        retry: true,
        callbacks: {},
      });

      // Going back to prereqs cannot clear a held lease, so neither the advice
      // nor the button may be offered.
      assert.doesNotMatch(statusEl.innerHTML, /return to the prereqs step/);
      assert.doesNotMatch(statusEl.innerHTML, /finalize-readiness-back-btn/);
      assert.match(statusEl.innerHTML, /quit Portico completely and reopen it/);
      assert.match(statusEl.innerHTML, /data-finalize-retry/);
    } finally {
      global.window = previousWindow;
    }
  });
});

test("finalize gate still offers prereqs navigation for unrelated errors", async () => {
  const mod = loadModule();

  await withFinalizeDom(async ({ statusEl }) => {
    const previousWindow = global.window;
    global.window = { navigateToStep() {} };
    try {
      mod._test.renderFinalizeGateState({
        title: "Finalize is blocked.",
        error: "Docker image was removed",
        allowPrereqNavigation: true,
        callbacks: {},
      });

      assert.match(statusEl.innerHTML, /return to the prereqs step/);
      assert.match(statusEl.innerHTML, /finalize-readiness-back-btn/);
    } finally {
      global.window = previousWindow;
    }
  });
});
