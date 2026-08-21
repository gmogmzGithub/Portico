const test = require("node:test");
const assert = require("node:assert/strict");

const { McpOperationCoordinator } = require("./mcp-operation-coordinator");
const { McpOperationManager } = require("./mcp-operation-manager");
const {
  HARD_DISABLED_ERROR_CODE,
  HARD_DISABLED_ERROR_TEXT,
  evaluateHardDisableToggleGate,
  hardDisabledToggleRefusal,
} = require("./mcp-hard-disable-gate");

// Substrings the mcp-assistant Rust client interprets as "transport error →
// toggle likely succeeded" (is_toggle_transport_error). The refusal text must
// never contain them or a refused enable would be reported as a success.
const TRANSPORT_ERROR_SUBSTRINGS = [
  "nginx",
  "connection closed",
  "server disconnected",
  "timed out",
];

function createHarness(options = {}) {
  const scheduled = [];
  const calls = [];
  const manager = new McpOperationManager({
    idFactory: () => "operation-1",
    lifecycleUpdater: () => {},
  });
  const coordinator = new McpOperationCoordinator({
    operationManager: manager,
    schedule: (callback) => scheduled.push(callback),
    inspectServer: options.inspectServer || (async (server) => server),
    mutateToggles: async (mutator) => {
      const draft = {};
      await mutator(draft);
      calls.push({ kind: "toggles", draft });
      return { toggles: draft };
    },
    mutateDisableModes: async (mutator) => {
      const draft = { ...(options.existingModes || {}) };
      await mutator(draft);
      calls.push({ kind: "disableModes", draft });
      return { modes: draft };
    },
    restartServers: async (serverIds) => ({
      success: true,
      results: serverIds.map((serverId) => ({
        serverId,
        success: true,
        mode: "docker",
      })),
    }),
    disableServers: async (serverIds) => ({
      success: true,
      results: serverIds.map((serverId) => ({ serverId, success: true })),
    }),
    reconcileConfiguration: async () => ({ success: true }),
    resolveRuntimeTargets: async () => ({
      configuredComposeServices: new Set(["mcpo-n8n"]),
    }),
    publishTerminalState: async () => {},
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
  return { coordinator, manager, scheduled, calls };
}

async function runScheduled(harness) {
  for (const callback of harness.scheduled) {
    await callback();
  }
  await new Promise((resolve) => setImmediate(resolve));
}

test("hard disable persists toggles false before recording the hard mode", async () => {
  const harness = createHarness();
  const snapshot = harness.coordinator.start({
    kind: "disable",
    disableMode: "hard",
    serverIds: ["n8n"],
  });

  assert.equal(snapshot.metadata.disableMode, "hard");

  await runScheduled(harness);

  assert.deepEqual(
    harness.calls.map((call) => call.kind),
    ["toggles", "disableModes"],
    "toggles must be persisted before the hard mode so a crash between the two leaves a plain soft disable",
  );
  assert.deepEqual(harness.calls[0].draft, { n8n: false });
  assert.deepEqual(harness.calls[1].draft, { n8n: "hard" });
});

test("plain disable never touches disable modes", async () => {
  const harness = createHarness({ existingModes: { other: "hard" } });
  harness.coordinator.start({ kind: "disable", serverIds: ["n8n"] });

  await runScheduled(harness);

  assert.deepEqual(
    harness.calls.map((call) => call.kind),
    ["toggles"],
    "a soft disable must not create or clear disable-mode entries",
  );
});

test("enable with clearDisableMode clears the mode before enabling the toggle", async () => {
  const harness = createHarness({ existingModes: { n8n: "hard" } });
  const snapshot = harness.coordinator.start({
    kind: "enable",
    clearDisableMode: true,
    serverIds: ["n8n"],
  });

  assert.equal(snapshot.metadata.clearDisableMode, true);

  await runScheduled(harness);

  assert.deepEqual(
    harness.calls.map((call) => call.kind),
    ["disableModes", "toggles"],
    "the mode must be cleared before the toggle flips on so a crash between the two leaves a soft-disabled server",
  );
  assert.deepEqual(harness.calls[0].draft, {});
  assert.deepEqual(harness.calls[1].draft, { n8n: true });
});

test("enable without clearDisableMode fails preflight for hard-disabled servers", async () => {
  const hardDisabled = new Set(["n8n"]);
  const harness = createHarness({
    inspectServer: async (server, { kind, clearDisableMode }) => {
      if (
        kind === "enable" &&
        !clearDisableMode &&
        hardDisabled.has(server.serverId)
      ) {
        const error = new Error(
          `Integration was hard-disabled by the user: ${server.serverId}`,
        );
        error.code = HARD_DISABLED_ERROR_CODE;
        error.source = "validation";
        error.stage = "preflight";
        error.retryable = false;
        throw error;
      }
      return server;
    },
  });

  const snapshot = harness.coordinator.start({
    kind: "enable",
    serverIds: ["n8n"],
  });
  await runScheduled(harness);

  const completed = harness.manager.getMcpOperation(snapshot.operationId);
  const row = completed.rows.find((entry) => entry.serverId === "n8n");
  assert.equal(row.status, "failed");
  assert.equal(row.error.code, HARD_DISABLED_ERROR_CODE);
  assert.deepEqual(
    harness.calls.map((call) => call.kind),
    [],
    "no toggle or mode writes may happen when preflight refuses the enable",
  );
});

test("hard-disable refusal payload is firm and free of transport-error substrings", () => {
  const refusal = hardDisabledToggleRefusal("n8n");
  assert.equal(refusal.success, false);
  assert.equal(refusal.errorCode, HARD_DISABLED_ERROR_CODE);
  assert.equal(refusal.readiness_phase, "disabled");
  assert.match(refusal.error, /Control Plane/);

  for (const text of [refusal.error, refusal.message, HARD_DISABLED_ERROR_TEXT]) {
    const lowered = text.toLowerCase();
    for (const substring of TRANSPORT_ERROR_SUBSTRINGS) {
      assert.ok(
        !lowered.includes(substring),
        `refusal text must not contain transport substring "${substring}"`,
      );
    }
  }
});

test("toggle gate refuses enables, no-ops matching disables, and self-heals drift", () => {
  const blocked = evaluateHardDisableToggleGate({
    serverId: "n8n",
    enabled: true,
    isHardDisabled: true,
    currentToggle: false,
  });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.response.errorCode, HARD_DISABLED_ERROR_CODE);

  const noop = evaluateHardDisableToggleGate({
    serverId: "n8n",
    enabled: false,
    isHardDisabled: true,
    currentToggle: false,
  });
  assert.equal(noop.blocked, false);
  assert.equal(noop.response.success, true);
  assert.equal(noop.response.readiness_phase, "disabled");

  // Drift (toggle says enabled while the mode says hard) falls through so the
  // normal disable path re-persists toggles and stops the runtime.
  assert.equal(
    evaluateHardDisableToggleGate({
      serverId: "n8n",
      enabled: false,
      isHardDisabled: true,
      currentToggle: true,
    }),
    null,
  );

  assert.equal(
    evaluateHardDisableToggleGate({
      serverId: "n8n",
      enabled: true,
      isHardDisabled: false,
      currentToggle: false,
    }),
    null,
  );
});
