const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const operationService = require("./mcp-operation-service");
const {
  SLACK_OPERATION_WAIT_TIMEOUT_MS,
} = require("./mcp-readiness-scheduler");

function createHarness(initialSnapshot = null) {
  const events = new EventEmitter();
  const snapshots = new Map();
  if (initialSnapshot) {
    snapshots.set(initialSnapshot.operationId, initialSnapshot);
  }
  const manager = {
    getActiveMcpOperation() {
      return [...snapshots.values()].find((snapshot) =>
        ["queued", "running"].includes(snapshot.status),
      ) || null;
    },
    getMcpOperation(operationId) {
      return snapshots.get(operationId) || null;
    },
    onMcpOperationUpdated(listener) {
      events.on("updated", listener);
      return () => events.off("updated", listener);
    },
  };
  const coordinator = {
    operationManager: manager,
    start(request) {
      const snapshot = {
        operationId: request.operationId || "operation-1",
        status: "running",
        rows: (request.serverIds || []).map((serverId) => ({
          serverId,
          status: "running",
          phase: "preflight",
          terminal: false,
        })),
      };
      snapshots.set(snapshot.operationId, snapshot);
      return snapshot;
    },
  };
  return {
    coordinator,
    emit(snapshot) {
      snapshots.set(snapshot.operationId, snapshot);
      events.emit("updated", snapshot);
    },
    listenerCount() {
      return events.listenerCount("updated");
    },
  };
}

test("registered coordinator is the single operation execution authority", () => {
  const first = createHarness();
  const second = createHarness();
  const unregister = operationService.registerMcpOperationCoordinator(
    first.coordinator,
  );
  try {
    const started = operationService.startMcpOperation({
      kind: "enable",
      serverIds: ["snowflake"],
    });
    assert.equal(started.operationId, "operation-1");
    assert.equal(
      operationService.getActiveMcpOperation().operationId,
      "operation-1",
    );
    assert.throws(
      () => operationService.registerMcpOperationCoordinator(second.coordinator),
      { code: "MCP_OPERATION_COORDINATOR_ALREADY_REGISTERED" },
    );
  } finally {
    unregister();
  }
});

test("start-and-wait projects terminal snapshots into legacy result fields", async () => {
  const harness = createHarness();
  const unregister = operationService.registerMcpOperationCoordinator(
    harness.coordinator,
  );
  try {
    const pending = operationService.startAndWaitForMcpOperation({
      kind: "enable",
      serverIds: ["google_workspace"],
    });
    assert.equal(harness.listenerCount(), 1);
    harness.emit({
      operationId: "operation-1",
      status: "attention_required",
      rows: [
        {
          serverId: "google_workspace",
          status: "attention_required",
          phase: "needs_oauth",
          outcome: "needs_oauth",
          requiredAction: "authenticate",
          terminal: true,
          healthy: false,
        },
      ],
    });
    const result = await pending;
    assert.equal(result.success, true);
    assert.equal(result.operationId, "operation-1");
    assert.deepEqual(result.errors, []);
    assert.equal(result.results[0].requiresAuthentication, true);
    assert.equal(result.results[0].readiness_phase, "needs_oauth");
    assert.equal(harness.listenerCount(), 0);
  } finally {
    unregister();
  }
});

test("initial snapshots preserve legacy fields while acknowledging asynchronously", () => {
  const result = operationService.buildLegacyMcpOperationResult({
    operationId: "operation-accepted",
    status: "queued",
    rows: [
      {
        serverId: "snowflake",
        status: "queued",
        phase: "queued",
        terminal: false,
        healthy: false,
      },
    ],
  });
  assert.equal(result.success, true);
  assert.equal(result.operationId, "operation-accepted");
  assert.deepEqual(result.errors, []);
  assert.equal(result.results[0].success, true);
  assert.equal(result.results[0].pending, true);
  assert.equal(result.results[0].readiness_phase, "starting");
});

test("configuration-required compatibility results preserve generated diagnostics", () => {
  const result = operationService.buildLegacyMcpOperationResult({
    operationId: "operation-not-configured",
    status: "attention_required",
    rows: [
      {
        serverId: "broken-user-mcp",
        status: "attention_required",
        phase: "not_configured",
        outcome: "not_configured",
        requiredAction: "configure",
        terminal: true,
        healthy: false,
        configurationErrorCode: "INVALID_USER_SERVER_CONFIG",
        configurationMessage: "invalid YAML in broken-user-mcp.yaml",
      },
    ],
  });

  assert.equal(result.success, true);
  assert.equal(result.results[0].requiresConfiguration, true);
  assert.equal(
    result.results[0].errorCode,
    "INVALID_USER_SERVER_CONFIG",
  );
  assert.equal(
    result.results[0].error,
    "invalid YAML in broken-user-mcp.yaml",
  );
});

test("compatibility waits do not resolve before deferred effects finalize", async () => {
  const harness = createHarness({
    operationId: "operation-effects",
    status: "running",
    effectsFinalized: false,
    rows: [],
  });
  const unregister = operationService.registerMcpOperationCoordinator(
    harness.coordinator,
  );
  try {
    let resolved = false;
    const pending = operationService
      .waitForMcpOperation("operation-effects", { timeoutMs: 1_000 })
      .then((snapshot) => {
        resolved = true;
        return snapshot;
      });
    harness.emit({
      operationId: "operation-effects",
      status: "succeeded",
      effectsFinalized: false,
      rows: [],
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(resolved, false);

    harness.emit({
      operationId: "operation-effects",
      status: "succeeded",
      effectsFinalized: true,
      rows: [],
    });
    assert.equal((await pending).effectsFinalized, true);
    assert.equal(harness.listenerCount(), 0);
  } finally {
    unregister();
  }
});

test("Slack compatibility wait includes warm-up plus bounded operation overhead", async () => {
  const harness = createHarness({
    operationId: "operation-slack-warmup",
    status: "running",
    createdAt: Date.now() - 60_000,
    rows: [{ serverId: "slack", status: "running", terminal: false }],
  });
  const unregister = operationService.registerMcpOperationCoordinator(
    harness.coordinator,
  );
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  let scheduledDelay = null;
  global.setTimeout = (_callback, delay) => {
    scheduledDelay = delay;
    return {};
  };
  global.clearTimeout = () => {};
  try {
    const pending = operationService.waitForMcpOperation(
      "operation-slack-warmup",
    );
    assert.equal(scheduledDelay, SLACK_OPERATION_WAIT_TIMEOUT_MS);
    harness.emit({
      operationId: "operation-slack-warmup",
      status: "succeeded",
      effectsFinalized: true,
      rows: [{ serverId: "slack", status: "succeeded", terminal: true }],
    });
    assert.equal((await pending).status, "succeeded");
    assert.equal(harness.listenerCount(), 0);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    unregister();
  }
});

test("wait timeout unsubscribes without changing operation state", async () => {
  const harness = createHarness({
    operationId: "operation-timeout",
    status: "running",
    rows: [],
  });
  const unregister = operationService.registerMcpOperationCoordinator(
    harness.coordinator,
  );
  try {
    await assert.rejects(
      operationService.waitForMcpOperation("operation-timeout", {
        timeoutMs: 5,
      }),
      { code: "MCP_OPERATION_WAIT_TIMEOUT" },
    );
    assert.equal(harness.listenerCount(), 0);
    assert.equal(
      operationService.getMcpOperation("operation-timeout").status,
      "running",
    );
  } finally {
    unregister();
  }
});
