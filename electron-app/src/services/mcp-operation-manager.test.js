const test = require("node:test");
const assert = require("node:assert/strict");

const { McpOperationManager } = require("./mcp-operation-manager");

function createManager() {
  let now = 1_000;
  let nextId = 0;
  const lifecycle = [];
  const manager = new McpOperationManager({
    clock: () => ++now,
    idFactory: () => `operation-${++nextId}`,
    lifecycleUpdater: (serverId, phase, metadata) => {
      lifecycle.push({ serverId, phase, metadata });
    },
  });
  return { manager, lifecycle };
}

test("operation snapshots expose renderer-compatible aggregate and row fields", () => {
  const { manager } = createManager();
  const started = manager.startMcpOperation({
    action: "enable",
    servers: [
      { id: "gitlab-mcp", label: "GitLab" },
      { serverId: "slack", label: "Slack" },
    ],
  });

  assert.equal(started.operationId, "operation-1");
  assert.equal(started.schemaVersion, 1);
  assert.equal(started.kind, "enable");
  assert.equal(started.status, "running");
  assert.equal(started.targetEnabled, true);
  assert.equal(started.total, 2);
  assert.equal(started.completed, 0);
  assert.deepEqual(started.serverIds, ["gitlab-mcp", "slack"]);
  assert.deepEqual(started.requestedServerIds, started.serverIds);
  assert.equal(started.revision, started.sequence);
  assert.deepEqual(started.rows, started.servers);
  assert.equal(started.summary.total, 2);
  assert.equal(started.progressPercent, 0);
  assert.equal(started.servers[0].id, "gitlab-mcp");
  assert.equal(started.servers[0].phase, "queued");
  assert.equal(manager.getActiveMcpOperation().operationId, started.operationId);
});

test("server transitions are revision-owned and sequence-monotonic", () => {
  const { manager, lifecycle } = createManager();
  const started = manager.startMcpOperation({ serverIds: ["snowflake"] });

  const accepted = manager.updateServer(started.operationId, "snowflake", {
    status: "checking",
    phase: "checking",
    sequence: 2,
  });
  assert.equal(accepted.accepted, true);
  assert.equal(
    manager.updateServer(started.operationId, "snowflake", {
      status: "succeeded",
      phase: "tool_ready",
      sequence: 1,
    }).reason,
    "stale_sequence",
  );
  assert.equal(
    manager.updateServer(started.operationId, "snowflake", {
      desiredRevision: started.desiredRevision + 1,
      status: "succeeded",
    }).reason,
    "stale_revision",
  );
  assert.equal(lifecycle.at(-1).metadata.desiredRevision, started.desiredRevision);
  assert.equal(lifecycle.at(-1).metadata.transitionSequence, 2);
  assert.equal(lifecycle.at(-1).metadata.lifecycleSessionId, started.operationId);
  assert.equal(lifecycle.at(-1).metadata.source, "mcp-operation-manager");
  assert.match(lifecycle.at(-1).metadata.observedAt, /T/);
});

test("a second global operation fails with MCP_OPERATION_BUSY", () => {
  const { manager } = createManager();
  const first = manager.startMcpOperation({ serverIds: ["slack"] });
  assert.throws(
    () => manager.startMcpOperation({ serverIds: ["snowflake"] }),
    (error) => {
      assert.equal(error.code, "MCP_OPERATION_BUSY");
      assert.equal(error.activeOperation.operationId, first.operationId);
      return true;
    },
  );
  assert.equal(manager.getActiveMcpOperation().operationId, first.operationId);
});

test("external mutations share the global operation mutex", () => {
  const { manager } = createManager();
  const release = manager.acquireMutationLease({
    kind: "delete_user_mcp_server",
    source: "test",
  });

  assert.throws(
    () => manager.startMcpOperation({ serverIds: ["slack"] }),
    (error) => {
      assert.equal(error.code, "MCP_OPERATION_BUSY");
      assert.equal(error.activeMutation.kind, "delete_user_mcp_server");
      return true;
    },
  );
  assert.equal(release(), true);

  const started = manager.startMcpOperation({ serverIds: ["slack"] });
  assert.throws(
    () => manager.acquireMutationLease({ kind: "save_mcp_toggles" }),
    (error) => {
      assert.equal(error.code, "MCP_OPERATION_BUSY");
      assert.equal(error.activeOperation.operationId, started.operationId);
      return true;
    },
  );
});

test("operation completes only when every server is terminal", () => {
  const { manager } = createManager();
  const updates = [];
  const unsubscribe = manager.onMcpOperationUpdated((snapshot) => updates.push(snapshot));
  const started = manager.startMcpOperation({ serverIds: ["slack", "snowflake"] });

  manager.updateServer(started.operationId, "slack", {
    status: "succeeded",
    phase: "tool_ready",
    healthy: true,
  });
  assert.equal(manager.getActiveMcpOperation().completed, 1);
  assert.equal(manager.getActiveMcpOperation().progressPercent, 50);

  manager.updateServer(started.operationId, "snowflake", {
    status: "failed",
    phase: "failed",
    error: "cold start timeout",
  });
  const completed = manager.getMcpOperation(started.operationId);
  assert.equal(completed.status, "partial");
  assert.equal(completed.completed, 2);
  assert.equal(completed.succeeded, 1);
  assert.equal(completed.failed, 1);
  assert.equal(completed.progressPercent, 100);
  assert.equal(completed.summary.healthy, 1);
  assert.equal(completed.summary.disabled, 0);
  assert.equal(completed.summary.actionRequired, 0);
  assert.equal(completed.summary.percent, 100);
  assert.deepEqual(completed.servers[1].error, {
    code: "MCP_SERVER_OPERATION_FAILED",
    message: "cold start timeout",
    source: "runtime",
    stage: "unknown",
    retryable: true,
  });
  assert.equal(manager.getActiveMcpOperation(), null);
  assert.equal(updates.at(-1).status, "partial");

  unsubscribe();
});

test("deferred operations retain the global mutex until effects finalize", () => {
  const { manager } = createManager();
  const started = manager.startMcpOperation({
    serverIds: ["slack"],
    deferRelease: true,
  });
  manager.completeOperation(started.operationId);

  const terminal = manager.getMcpOperation(started.operationId);
  assert.equal(terminal.status, "succeeded");
  assert.equal(terminal.effectsFinalized, false);
  assert.equal(manager.getActiveMcpOperation().operationId, started.operationId);
  assert.throws(
    () => manager.startMcpOperation({ serverIds: ["snowflake"] }),
    { code: "MCP_OPERATION_BUSY" },
  );

  const finalized = manager.finalizeOperationEffects(started.operationId);
  assert.equal(finalized.effectsFinalized, true);
  assert.equal(manager.getActiveMcpOperation(), null);
});

test("clientRequestId is idempotent before the global busy check", () => {
  const { manager } = createManager();
  const first = manager.startMcpOperation({
    clientRequestId: "renderer-request-1",
    serverIds: ["slack"],
  });
  const duplicate = manager.startMcpOperation({
    clientRequestId: "renderer-request-1",
    serverIds: ["slack"],
  });

  assert.equal(duplicate.operationId, first.operationId);
  assert.equal(duplicate.clientRequestId, "renderer-request-1");
});

test("automatic timeout recovery coalesces for retention while manual restart stays available", () => {
  const { manager } = createManager();
  const automatic = manager.startMcpOperation({
    clientRequestId: "mcp-timeout-recovery:mcp-atlassian",
    kind: "restart",
    serverIds: ["mcp-atlassian"],
    metadata: {
      source: "mcp-orc",
      automaticRecovery: true,
      recoveryReason: "automatic_timeout_recovery",
    },
  });
  manager.completeOperation(automatic.operationId);

  const coalesced = manager.startMcpOperation({
    clientRequestId: "mcp-timeout-recovery:mcp-atlassian",
    kind: "restart",
    serverIds: ["mcp-atlassian"],
  });
  assert.equal(coalesced.operationId, automatic.operationId);
  assert.equal(coalesced.metadata.source, "mcp-orc");
  assert.equal(coalesced.metadata.automaticRecovery, true);

  const manual = manager.startMcpOperation({
    clientRequestId: "manual-restart:unique",
    kind: "restart",
    serverIds: ["mcp-atlassian"],
    metadata: { source: "renderer" },
  });
  assert.notEqual(manual.operationId, automatic.operationId);
  assert.equal(manual.metadata.source, "renderer");
});

test("queued operations record startedAt only when execution begins", () => {
  const { manager } = createManager();
  const queued = manager.startMcpOperation({
    serverIds: ["slack"],
    startImmediately: false,
  });
  assert.equal(queued.status, "queued");
  assert.equal(queued.phase, "queued");
  assert.equal(queued.startedAt, null);
  assert.equal(queued.rows[0].startedAt, null);

  const running = manager.markOperationRunning(queued.operationId);
  assert.equal(running.status, "running");
  assert.ok(Number.isFinite(running.startedAt));
  assert.ok(Number.isFinite(running.rows[0].startedAt));
});

test("completed operation snapshots expire after fifteen minutes", () => {
  let now = 1_000;
  const manager = new McpOperationManager({
    clock: () => now,
    idFactory: () => "retained-operation",
    lifecycleUpdater: () => {},
  });
  const started = manager.startMcpOperation({ serverIds: ["slack"] });
  manager.completeOperation(started.operationId);
  now += 15 * 60 * 1000 + 1;

  assert.equal(manager.getMcpOperation(started.operationId), null);
});

test("operation getters return defensive copies", () => {
  const { manager } = createManager();
  const started = manager.startMcpOperation({ serverIds: ["slack"] });
  started.servers[0].status = "corrupt";

  assert.equal(manager.getMcpOperation(started.operationId).servers[0].status, "queued");
});

test("timed out readiness is terminal and maps to failed or partial", () => {
  const { manager } = createManager();
  const started = manager.startMcpOperation({ serverIds: ["slow", "ready"] });
  manager.updateServer(started.operationId, "ready", {
    status: "succeeded",
    phase: "tool_ready",
    healthy: true,
  });
  manager.updateServer(started.operationId, "slow", {
    status: "timed_out",
    phase: "timeout",
    error: "Readiness timed out after 120000ms",
  });

  const completed = manager.getMcpOperation(started.operationId);
  assert.equal(completed.status, "partial");
  assert.equal(completed.servers.find((row) => row.id === "slow").terminal, true);
  assert.equal(
    manager.updateServer(started.operationId, "slow", {
      status: "succeeded",
      phase: "tool_ready",
    }).reason,
    "terminal_row",
  );
});

// --- Stale external-mutation lease eviction (PORTICO-339 follow-up) ---------------
// docker-start/docker-restart park a long-lived lease on appState. If a bring-up
// ends without reaching start-initialization the lease used to be orphaned for
// the life of the process, wedging every later MCP mutation. Releasing at the
// real handoff boundaries is the fix; this eviction is the self-heal backstop.

function createAgingManager({ maxAgeMs = 30 * 60 * 1000 } = {}) {
  let now = 1_000;
  let nextId = 0;
  const warnings = [];
  const manager = new McpOperationManager({
    clock: () => now,
    idFactory: () => `operation-${++nextId}`,
    externalMutationMaxAgeMs: maxAgeMs,
    auditLogger: {
      warn: (message) => warnings.push(message),
      info: () => {},
      log: () => {},
      error: () => {},
    },
  });
  return { manager, warnings, advance: (ms) => { now += ms; } };
}

test("a stale external mutation lease is evicted when a new acquire contends", () => {
  const { manager, warnings, advance } = createAgingManager();
  manager.acquireMutationLease({ kind: "docker_restart", source: "control_plane" });

  advance(31 * 60 * 1000);

  const release = manager.acquireMutationLease({
    kind: "write_env_file",
    source: "guided_setup",
  });
  assert.equal(typeof release, "function");
  assert.equal(manager.getActiveMutation().kind, "write_env_file");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Evicted stale mutation lease/);
  assert.match(warnings[0], /kind=docker_restart/);
  assert.match(warnings[0], /source=control_plane/);
});

test("a fresh external mutation lease is never evicted", () => {
  const { manager, warnings, advance } = createAgingManager();
  manager.acquireMutationLease({ kind: "docker_start", source: "control_plane" });

  advance(29 * 60 * 1000);

  assert.throws(
    () => manager.acquireMutationLease({ kind: "write_env_file" }),
    (error) => {
      assert.equal(error.code, "MCP_OPERATION_BUSY");
      return true;
    },
  );
  assert.equal(warnings.length, 0);
  assert.equal(manager.getActiveMutation().kind, "docker_start");
});

test("eviction never fires against an in-flight operation", () => {
  const { manager, warnings, advance } = createAgingManager();
  manager.startMcpOperation({ serverIds: ["slack"] });

  advance(90 * 60 * 1000);

  assert.throws(
    () => manager.acquireMutationLease({ kind: "write_env_file" }),
    (error) => {
      assert.equal(error.code, "MCP_OPERATION_BUSY");
      return true;
    },
  );
  assert.equal(warnings.length, 0);
});

test("the release closure of an evicted lease cannot clobber a newer lease", () => {
  const { manager, advance } = createAgingManager();
  const orphanedRelease = manager.acquireMutationLease({ kind: "docker_start" });

  advance(31 * 60 * 1000);
  manager.acquireMutationLease({ kind: "write_env_file", source: "guided_setup" });

  assert.equal(orphanedRelease(), false);
  assert.equal(manager.getActiveMutation().kind, "write_env_file");
});

test("renewMutationLease re-stamps the lease without changing its id", () => {
  const { manager, advance } = createAgingManager();
  const release = manager.acquireMutationLease({
    kind: "docker_start",
    source: "control_plane",
  });
  const originalId = manager.getActiveMutation().mutationId;

  advance(25 * 60 * 1000);
  assert.equal(
    manager.renewMutationLease({ kind: "runtime_initialization", source: "loading" }),
    true,
  );
  assert.equal(manager.getActiveMutation().mutationId, originalId);

  // Renewal resets the clock, so what would have been a 50-minute-old lease is
  // only 25 minutes old and must survive.
  advance(25 * 60 * 1000);
  assert.throws(
    () => manager.acquireMutationLease({ kind: "write_env_file" }),
    (error) => error.code === "MCP_OPERATION_BUSY",
  );

  // The original closure still matches the renewed lease.
  assert.equal(release(), true);
  assert.equal(manager.getActiveMutation(), null);
});

test("renewMutationLease is a no-op when no lease is held", () => {
  const { manager } = createAgingManager();
  assert.equal(manager.renewMutationLease({ kind: "runtime_initialization" }), false);
});

test("the busy error describes the holder instead of leaking a raw mutation id", () => {
  const { manager, advance } = createAgingManager();
  manager.acquireMutationLease({ kind: "docker_restart", source: "control_plane" });
  const heldId = manager.getActiveMutation().mutationId;

  advance(4 * 60 * 1000);

  assert.throws(
    () => manager.acquireMutationLease({ kind: "write_env_file" }),
    (error) => {
      assert.equal(error.code, "MCP_OPERATION_BUSY");
      assert.match(error.message, /docker_restart/);
      assert.match(error.message, /started by control_plane/);
      assert.match(error.message, /4m ago/);
      assert.match(error.message, /restart Portico/);
      assert.doesNotMatch(error.message, new RegExp(heldId));
      // Structured detail is still available to callers that want it.
      assert.equal(error.activeMutation.kind, "docker_restart");
      return true;
    },
  );
});

// --- whenMutationIdle (PORTICO-339 follow-up) ------------------------------------
// Event-driven idle notification so guided-setup finalize can absorb the tail
// of a single-server teardown instead of failing MCP_OPERATION_BUSY.

test("whenMutationIdle resolves immediately when the lock is free", async () => {
  const { manager } = createManager();
  assert.equal(await manager.whenMutationIdle(), true);
});

test("whenMutationIdle resolves when an external lease releases", async () => {
  const { manager } = createManager();
  const release = manager.acquireMutationLease({ kind: "stop_single_mcp_server" });

  let settled = false;
  const waiter = manager.whenMutationIdle().then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false, "must not settle while the lease is held");

  release();
  await waiter;
  assert.equal(settled, true);
  // And the lock is genuinely acquirable again.
  const next = manager.acquireMutationLease({ kind: "write_env_file" });
  assert.equal(typeof next, "function");
  next();
});

test("whenMutationIdle resolves when an operation completes", async () => {
  const { manager } = createManager();
  const started = manager.startMcpOperation({ serverIds: ["slack"] });

  let settled = false;
  const waiter = manager.whenMutationIdle().then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);

  manager.updateServer(started.operationId, "slack", {
    status: "succeeded",
    phase: "tool_ready",
  });
  await waiter;
  assert.equal(settled, true);
});

test("whenMutationIdle resolves when an operation is cancelled", async () => {
  const { manager } = createManager();
  const started = manager.startMcpOperation({ serverIds: ["slack"] });

  const waiter = manager.whenMutationIdle();
  manager.cancelOperation(started.operationId, { reason: "test" });
  assert.equal(await waiter, true);
});

test("whenMutationIdle supports multiple concurrent waiters", async () => {
  const { manager } = createManager();
  const release = manager.acquireMutationLease({ kind: "stop_single_mcp_server" });

  const waiters = [
    manager.whenMutationIdle(),
    manager.whenMutationIdle(),
    manager.whenMutationIdle(),
  ];
  release();
  assert.deepEqual(await Promise.all(waiters), [true, true, true]);
});
