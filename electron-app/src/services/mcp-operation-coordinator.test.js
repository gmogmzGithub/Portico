const test = require("node:test");
const assert = require("node:assert/strict");

const { McpOperationCoordinator } = require("./mcp-operation-coordinator");
const { McpOperationManager } = require("./mcp-operation-manager");

function createHarness(options = {}) {
  const scheduled = [];
  const mutations = [];
  const restarts = [];
  const restartOptions = [];
  const disables = [];
  const reconciliations = [];
  const runtimeResolutions = [];
  const publications = [];
  const manager = new McpOperationManager({
    idFactory: () => "operation-1",
    lifecycleUpdater: () => {},
  });
  const coordinator = new McpOperationCoordinator({
    operationManager: manager,
    schedule: (callback) => scheduled.push(callback),
    resolveServerLabel: options.resolveServerLabel,
    inspectServer: options.inspectServer || (async (server) => server),
    mutateToggles: async (mutator, mutationOptions) => {
      const draft = { unrelated: true };
      await mutator(draft);
      mutations.push({ draft, options: mutationOptions });
      return { toggles: draft };
    },
    restartServers: async (serverIds, restartOptionsValue) => {
      restarts.push(serverIds);
      restartOptions.push(restartOptionsValue);
      if (options.restartServers) {
        return options.restartServers(serverIds);
      }
      return {
        success: true,
        results: serverIds.map((serverId) => ({
          serverId,
          success: true,
          mode: "docker",
        })),
      };
    },
    disableServers: async (serverIds) => {
      disables.push(serverIds);
      return {
        success: true,
        results: serverIds.map((serverId) => ({ serverId, success: true })),
      };
    },
    reconcileConfiguration: async (request) => {
      reconciliations.push(request);
      if (options.reconcileConfiguration) {
        return options.reconcileConfiguration(request);
      }
      return { success: true };
    },
    resolveRuntimeTargets: async (request) => {
      runtimeResolutions.push(request);
      if (options.resolveRuntimeTargets) {
        return options.resolveRuntimeTargets(request);
      }
      return {
        configuredComposeServices: new Set(["mcpo-slack", "mcpo-snowflake"]),
      };
    },
    publishTerminalState: async (entry) => {
      publications.push(entry);
      if (options.publishTerminalState) {
        return options.publishTerminalState(entry);
      }
    },
    createReadinessScheduler: () => ({
      async run(operationId, targets) {
        for (const target of targets) {
          manager.updateServer(operationId, target.serverId, {
            status: "succeeded",
            phase: "tool_ready",
            outcome: "tool_ready",
            healthy: true,
            terminal: true,
            progressPercent: 100,
          });
        }
        return manager.getMcpOperation(operationId);
      },
    }),
    logger: { error() {} },
  });
  return {
    coordinator,
    manager,
    scheduled,
    mutations,
    restarts,
    restartOptions,
    disables,
    reconciliations,
    runtimeResolutions,
    publications,
  };
}

test("serverIds-only operations use resolved display names from the initial snapshot", async () => {
  const harness = createHarness({
    resolveServerLabel: (server) =>
      server.serverId === "mcp-atlassian" ? "Atlassian" : null,
    resolveRuntimeTargets: async () => ({
      configuredComposeServices: new Set(["mcpo-mcp-atlassian"]),
    }),
  });
  const initial = harness.coordinator.start({
    kind: "restart",
    serverIds: ["mcp-atlassian"],
  });

  assert.equal(initial.rows[0].serverId, "mcp-atlassian");
  assert.equal(initial.rows[0].label, "Atlassian");

  await harness.scheduled[0]();
  await new Promise((resolve) => setImmediate(resolve));
  const completed = harness.manager.getMcpOperation(initial.operationId);
  assert.equal(completed.rows[0].label, "Atlassian");
});

test("server label resolution falls back to the requested server ID", () => {
  const harness = createHarness({
    resolveServerLabel: () => null,
  });
  const initial = harness.coordinator.start({
    kind: "restart",
    serverIds: ["missing-server"],
  });

  assert.equal(initial.rows[0].label, "missing-server");
});

test("start acknowledges before persistence or runtime work begins", async () => {
  const harness = createHarness();
  const initial = harness.coordinator.start({
    clientRequestId: "request-1",
    kind: "enable",
    serverIds: ["slack", "snowflake"],
  });

  assert.equal(initial.status, "queued");
  assert.equal(initial.summary.completed, 0);
  assert.equal(harness.mutations.length, 0);
  assert.equal(harness.restarts.length, 0);
  assert.equal(harness.scheduled.length, 1);

  await harness.scheduled[0]();
  await new Promise((resolve) => setImmediate(resolve));
  const completed = harness.manager.getMcpOperation(initial.operationId);
  assert.equal(completed.status, "succeeded");
  assert.equal(harness.mutations.length, 1);
  assert.deepEqual(harness.mutations[0].draft, {
    unrelated: true,
    slack: true,
    snowflake: true,
  });
  assert.deepEqual(harness.restarts, [["slack", "snowflake"]]);
  assert.ok(
    harness.restartOptions[0].configuredComposeServices instanceof Set,
  );
  assert.equal(harness.restartOptions[0].skipEnsureEnabled, true);
});

for (const targetCount of [1, 15, 16]) {
  test(`runtime targets are resolved once for ${targetCount} operation target(s)`, async () => {
    const serverIds = Array.from(
      { length: targetCount },
      (_unused, index) => `server-${index + 1}`,
    );
    const harness = createHarness({
      resolveRuntimeTargets: async () => ({
        configuredComposeServices: new Set(["mcpo-grouped-runtime"]),
      }),
    });
    const initial = harness.coordinator.start({ kind: "enable", serverIds });
    await harness.scheduled[0]();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(harness.runtimeResolutions.length, 1);
    assert.deepEqual(harness.runtimeResolutions[0].serverIds, serverIds);
    assert.equal(harness.restarts.length, 1);
    assert.deepEqual(harness.restarts[0], serverIds);
    assert.equal(
      harness.manager.getMcpOperation(initial.operationId).status,
      "succeeded",
    );
  });
}

test("configuration-required enable persists desired state without starting runtime", async () => {
  const harness = createHarness({
    inspectServer: async (server) => ({
      ...server,
      deploymentType: "docker",
      requiresConfiguration: true,
      configurationIssue: "saved_secret_unavailable",
      configurationErrorCode: "SAVED_SECRET_UNAVAILABLE",
      requiredAction: "replace_saved_secret",
      requiresSecretReplacement: true,
      recoveryPrompt:
        "My Snowflake token is broken. Help me replace it with a fresh token.",
    }),
  });
  const initial = harness.coordinator.start({
    kind: "enable",
    serverIds: ["snowflake"],
  });
  await harness.scheduled[0]();
  await new Promise((resolve) => setImmediate(resolve));

  const completed = harness.manager.getMcpOperation(initial.operationId);
  assert.equal(completed.status, "attention_required");
  assert.equal(completed.rows[0].outcome, "not_configured");
  assert.equal(completed.rows[0].requiredAction, "replace_saved_secret");
  assert.equal(
    completed.rows[0].configurationIssue,
    "saved_secret_unavailable",
  );
  assert.equal(
    completed.rows[0].configurationErrorCode,
    "SAVED_SECRET_UNAVAILABLE",
  );
  assert.equal(completed.rows[0].requiresSecretReplacement, true);
  assert.deepEqual(harness.restarts, []);
  assert.equal(harness.runtimeResolutions.length, 0);
  assert.equal(harness.mutations[0].draft.snowflake, true);
  assert.equal(harness.publications.length, 1);
  assert.equal(harness.publications[0].status, "not_configured");
  assert.equal(harness.publications[0].configured, false);
});

test("host-only enable does not depend on Docker Compose enumeration", async () => {
  const harness = createHarness({
    inspectServer: async (server) => ({
      ...server,
      deploymentType: "host",
    }),
    resolveRuntimeTargets: async () => {
      throw new Error("Compose must not be queried for host-only operations");
    },
  });
  const initial = harness.coordinator.start({
    kind: "enable",
    serverIds: ["chrome-devtools"],
  });
  await harness.scheduled[0]();
  await new Promise((resolve) => setImmediate(resolve));

  const completed = harness.manager.getMcpOperation(initial.operationId);
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.rows[0].deploymentType, "host");
  assert.equal(harness.runtimeResolutions.length, 0);
  assert.deepEqual(harness.restarts, [["chrome-devtools"]]);
});

test("Compose target discovery failure does not fail independent host targets", async () => {
  const harness = createHarness({
    inspectServer: async (server) => ({
      ...server,
      deploymentType: server.serverId === "chrome-devtools" ? "host" : "docker",
    }),
    resolveRuntimeTargets: async () => {
      const error = new Error("docker compose config failed");
      error.code = "COMPOSE_ENUMERATION_FAILED";
      throw error;
    },
  });
  const initial = harness.coordinator.start({
    kind: "enable",
    serverIds: ["chrome-devtools", "slack"],
  });
  await harness.scheduled[0]();
  await new Promise((resolve) => setImmediate(resolve));

  const completed = harness.manager.getMcpOperation(initial.operationId);
  const rows = new Map(completed.rows.map((row) => [row.serverId, row]));
  assert.equal(completed.status, "partial");
  assert.equal(rows.get("chrome-devtools").status, "succeeded");
  assert.equal(rows.get("slack").status, "failed");
  assert.equal(rows.get("slack").error.source, "compose");
  assert.deepEqual(harness.restarts, [["chrome-devtools"]]);
  assert.equal(harness.runtimeResolutions.length, 1);
  assert.deepEqual(harness.runtimeResolutions[0].serverIds, ["slack"]);
});

test("preflight persists discovered core deployment metadata on the operation row", async () => {
  const harness = createHarness({
    inspectServer: async (server) => ({
      ...server,
      deploymentType: "core",
      label: "Core Tools",
    }),
  });
  const initial = harness.coordinator.start({
    kind: "restart",
    serverIds: ["skills"],
  });
  await harness.scheduled[0]();
  await new Promise((resolve) => setImmediate(resolve));

  const completed = harness.manager.getMcpOperation(initial.operationId);
  assert.equal(completed.rows[0].deploymentType, "core");
  assert.equal(completed.rows[0].label, "Core Tools");
});

test("runtime-reported not-configured publication is explicitly unconfigured", async () => {
  const harness = createHarness({
    restartServers: async (serverIds) => ({
      success: true,
      results: serverIds.map((serverId) => ({
        serverId,
        success: true,
        requiresConfiguration: true,
        errorCode: "INVALID_USER_SERVER_CONFIG",
        error: "invalid YAML in user-mcp.yaml",
        message: "Server enabled; configuration required before it can start",
      })),
    }),
  });
  const initial = harness.coordinator.start({
    kind: "restart",
    serverIds: ["snowflake"],
  });
  await harness.scheduled[0]();
  await new Promise((resolve) => setImmediate(resolve));

  const completed = harness.manager.getMcpOperation(initial.operationId);
  assert.equal(completed.status, "attention_required");
  assert.equal(
    completed.rows[0].configurationErrorCode,
    "INVALID_USER_SERVER_CONFIG",
  );
  assert.equal(
    completed.rows[0].configurationMessage,
    "invalid YAML in user-mcp.yaml",
  );
  assert.equal(harness.publications.length, 1);
  assert.equal(harness.publications[0].status, "not_configured");
  assert.equal(harness.publications[0].configured, false);
  assert.equal(
    harness.publications[0].configurationMessage,
    "invalid YAML in user-mcp.yaml",
  );
  assert.equal(
    harness.publications[0].error,
    "invalid YAML in user-mcp.yaml",
  );
});

test("attributed config failure fails one row and retries remaining targets once", async () => {
  let reconciliationAttempt = 0;
  const harness = createHarness({
    inspectServer: async (server) => ({
      ...server,
      deploymentType: "docker",
    }),
    reconcileConfiguration: async () => {
      reconciliationAttempt += 1;
      if (reconciliationAttempt === 1) {
        return {
          success: false,
          attributedFailure: {
            serverId: "snowflake",
            code: "CONFIG_GENERATION_FAILED",
            message: "Snowflake config generation failed",
            source: "config",
            stage: "config_generation",
            retryable: true,
            configPath: "/tmp/snowflake.yaml",
          },
        };
      }
      return { success: true };
    },
  });
  const initial = harness.coordinator.start({
    kind: "enable",
    serverIds: ["snowflake", "slack"],
  });
  await harness.scheduled[0]();
  await new Promise((resolve) => setImmediate(resolve));

  const completed = harness.manager.getMcpOperation(initial.operationId);
  const rowById = new Map(completed.rows.map((row) => [row.serverId, row]));
  assert.equal(completed.status, "partial");
  assert.equal(rowById.get("snowflake").status, "failed");
  assert.equal(
    rowById.get("snowflake").error.code,
    "CONFIG_GENERATION_FAILED",
  );
  assert.equal(rowById.get("slack").status, "succeeded");
  assert.deepEqual(
    harness.reconciliations.map((request) => ({
      attempt: request.attempt,
      serverIds: request.serverIds,
      excludedServerIds: request.excludedServerIds,
    })),
    [
      {
        attempt: 1,
        serverIds: ["snowflake", "slack"],
        excludedServerIds: [],
      },
      {
        attempt: 2,
        serverIds: ["slack"],
        excludedServerIds: ["snowflake"],
      },
    ],
  );
  assert.deepEqual(harness.restarts, [["slack"]]);
  assert.equal(harness.publications.length, 1);
  assert.deepEqual(
    {
      serverId: harness.publications[0].serverId,
      status: harness.publications[0].status,
      configured: harness.publications[0].configured,
      configPath: harness.publications[0].configPath,
    },
    {
      serverId: "snowflake",
      status: "failed",
      configured: false,
      configPath: "/tmp/snowflake.yaml",
    },
  );
});

test("shared config failure bubbles and fails every active row", async () => {
  const harness = createHarness({
    reconcileConfiguration: async () => {
      const error = new Error("Shared generator process failed");
      error.code = "CONFIG_GENERATION_FAILED";
      error.source = "config";
      error.stage = "config_generation";
      throw error;
    },
  });
  const initial = harness.coordinator.start({
    kind: "enable",
    serverIds: ["snowflake", "slack"],
  });
  await harness.scheduled[0]();
  await new Promise((resolve) => setImmediate(resolve));

  const completed = harness.manager.getMcpOperation(initial.operationId);
  assert.equal(completed.status, "failed");
  assert.deepEqual(
    completed.rows.map((row) => row.status),
    ["failed", "failed"],
  );
  assert.deepEqual(harness.restarts, []);
  assert.equal(harness.reconciliations.length, 1);
  assert.deepEqual(harness.publications, []);
});

test("disable commits once and succeeds only after the runtime reports disabled", async () => {
  const harness = createHarness();
  const initial = harness.coordinator.start({
    kind: "disable",
    serverIds: ["slack"],
  });
  await harness.scheduled[0]();
  await new Promise((resolve) => setImmediate(resolve));

  const completed = harness.manager.getMcpOperation(initial.operationId);
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.rows[0].outcome, "disabled");
  assert.equal(completed.rows[0].phase, "disabled");
  assert.equal(harness.mutations[0].draft.slack, false);
  assert.deepEqual(harness.disables, [["slack"]]);
});

test("clientRequestId deduplicates an accidental double submission", () => {
  const harness = createHarness();
  const request = {
    clientRequestId: "same-click",
    kind: "enable",
    serverIds: ["slack"],
  };
  const first = harness.coordinator.start(request);
  const second = harness.coordinator.start(request);

  assert.equal(second.operationId, first.operationId);
  assert.equal(harness.scheduled.length, 1);
});
