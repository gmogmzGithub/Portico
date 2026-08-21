const test = require("node:test");
const assert = require("node:assert/strict");

const { McpOperationManager } = require("./mcp-operation-manager");
const {
  DEFAULT_CONCURRENCY,
  DEFAULT_FAST_POLL_DURATION_MS,
  DEFAULT_OPERATION_WAIT_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_READINESS_TIMEOUT_MS,
  DEFAULT_SLOW_POLL_INTERVAL_MS,
  SLACK_OPERATION_WAIT_TIMEOUT_MS,
  SLACK_READINESS_TIMEOUT_MS,
  McpReadinessScheduler,
  operationWaitTimeoutMs,
  probeMcpServerReadiness,
  readinessTimeoutMsForServer,
} = require("./mcp-readiness-scheduler");

function managerForTest() {
  let nextId = 0;
  return new McpOperationManager({
    idFactory: () => `readiness-${++nextId}`,
    lifecycleUpdater: () => {},
  });
}

test("scheduler defaults are bounded and Slack gets its measured warm-up budget", () => {
  assert.equal(DEFAULT_CONCURRENCY, 6);
  assert.equal(DEFAULT_POLL_INTERVAL_MS, 1_000);
  assert.equal(DEFAULT_SLOW_POLL_INTERVAL_MS, 3_000);
  assert.equal(DEFAULT_FAST_POLL_DURATION_MS, 30_000);
  assert.equal(DEFAULT_READINESS_TIMEOUT_MS, 120_000);
  assert.equal(SLACK_READINESS_TIMEOUT_MS, 12 * 60_000);
  assert.equal(readinessTimeoutMsForServer("slack"), 12 * 60_000);
  assert.equal(readinessTimeoutMsForServer("snowflake"), 120_000);
  assert.equal(DEFAULT_OPERATION_WAIT_TIMEOUT_MS, 5 * 60_000);
  assert.equal(SLACK_OPERATION_WAIT_TIMEOUT_MS, 20 * 60_000);
  assert.equal(operationWaitTimeoutMs({ serverIds: ["slack"] }), 20 * 60_000);
  assert.equal(operationWaitTimeoutMs({ serverIds: ["snowflake"] }), 5 * 60_000);
});

test("pure readiness probe uses OpenAPI plus one non-invoking tool-route probe", async () => {
  const calls = [];
  const result = await probeMcpServerReadiness({
    serverId: "snowflake",
    deploymentType: "docker",
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      if (url.endsWith("/openapi.json")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ paths: { "/run_query": { post: {} } } }),
        };
      }
      if (url.includes("/servers/") && url.endsWith("/status")) {
        return { ok: false, status: 404 };
      }
      return {
        ok: true,
        status: 422,
      };
    },
  });

  assert.equal(calls[0].url, "http://127.0.0.1:8765/snowflake/openapi.json");
  assert.equal(calls[1].url, "http://127.0.0.1:8765/snowflake/run_query");
  assert.equal(calls[1].init.method, "POST");
  assert.equal(calls[1].init.body, "{");
  assert.equal(
    calls[2].url,
    "http://127.0.0.1:8765/servers/snowflake/status",
  );
  assert.equal(result.ready, true);
  assert.equal(result.healthy, true);
  assert.equal(result.readinessPhase, "tool_ready");
  assert.equal(result.probeStatus, 422);
});

test("provider warm-up status survives an OpenAPI 503 without becoming fatal", async () => {
  const result = await probeMcpServerReadiness({
    serverId: "slack",
    deploymentType: "docker",
    fetchImpl: async (url) => {
      if (url.endsWith("/openapi.json")) {
        return { ok: false, status: 503 };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          healthy: false,
          readiness_phase: "starting",
          provider_readiness: "starting",
        }),
      };
    },
  });

  assert.equal(result.ready, false);
  assert.equal(result.healthy, false);
  assert.equal(result.readinessPhase, "starting");
  assert.equal(result.providerReadiness, "starting");
  assert.equal(result.error, "http_503");
  const { isFatalStartupProbe, isStartupStallProbe } = require("./mcp-readiness-scheduler");
  assert.equal(isFatalStartupProbe(result), false);
  assert.equal(isStartupStallProbe(result), false);
});

test("cached OpenAPI cannot hide an OAuth-required tool response", async () => {
  const calls = [];
  const result = await probeMcpServerReadiness({
    serverId: "google-workspace",
    deploymentType: "docker",
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      if (url.endsWith("/openapi.json")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            paths: {
              "/cached_tool": { post: {} },
              "/metadata": { get: {} },
            },
          }),
        };
      }
      if (url.includes("/servers/") && url.endsWith("/status")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            healthy: false,
            readiness_phase: "needs_oauth",
          }),
        };
      }
      return { ok: false, status: 401 };
    },
  });

  assert.equal(calls[1].url, "http://127.0.0.1:8765/google-workspace/cached_tool");
  assert.equal(calls[1].init.method, "POST");
  assert.equal(result.healthy, false);
  assert.equal(result.ready, true);
  assert.equal(result.readinessPhase, "needs_oauth");
  assert.equal(result.probeStatus, 401);
});

test("scheduler reloads routes before probing and terminalizes mixed outcomes", async () => {
  const manager = managerForTest();
  const operation = manager.startMcpOperation({
    serverIds: ["ready", "oauth", "broken"],
    startImmediately: false,
  });
  const events = [];
  const publications = [];
  const scheduler = new McpReadinessScheduler({
    operationManager: manager,
    pollIntervalMs: 0,
    timeoutMs: 120_000,
    beforePolling: async () => events.push("routes_reloaded"),
    probe: async ({ serverId }) => {
      events.push(`probe:${serverId}`);
      if (serverId === "ready") {
        return { healthy: true, readinessPhase: "tool_ready" };
      }
      if (serverId === "oauth") {
        return { healthy: false, readinessPhase: "needs_oauth" };
      }
      return {
        healthy: false,
        readinessPhase: "failed",
        error: "runtime exited",
      };
    },
    onReadyBatch: async ({ serverIds }) =>
      events.push(`invalidate:${serverIds.join(",")}`),
    publishReadiness: async (readiness) => publications.push(readiness),
  });

  const completed = await scheduler.run(operation.operationId, [
    { serverId: "ready" },
    { serverId: "oauth" },
    { serverId: "broken" },
  ]);

  assert.equal(events[0], "routes_reloaded");
  assert.ok(events.indexOf("routes_reloaded") < events.indexOf("probe:ready"));
  assert.ok(events.includes("invalidate:ready"));
  assert.equal(completed.status, "partial");
  assert.equal(completed.completed, 3);
  assert.equal(publications.length, 3);
  assert.equal(publications[0].operationId, operation.operationId);
  assert.equal(
    completed.servers.find((row) => row.id === "oauth").status,
    "attention_required",
  );
});

test("scheduler marks still-pending servers timed_out", async () => {
  const manager = managerForTest();
  const operation = manager.startMcpOperation({
    serverIds: ["slow"],
    startImmediately: false,
  });
  let now = 0;
  const scheduler = new McpReadinessScheduler({
    operationManager: manager,
    timeoutMs: 120_000,
    pollIntervalMs: 1_000,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    probe: async () => ({
      healthy: false,
      readinessPhase: "starting",
      error: "not_discovered",
    }),
  });

  const completed = await scheduler.run(operation.operationId, [
    { serverId: "slow" },
  ]);
  assert.equal(completed.status, "failed");
  assert.equal(completed.timedOut, 1);
  assert.match(completed.servers[0].error.message, /120000ms/);
});

test("mixed operations timeout each target independently while Slack keeps warming", async () => {
  const manager = managerForTest();
  const operation = manager.startMcpOperation({
    serverIds: ["regular", "slack"],
    startImmediately: false,
  });
  let now = 0;
  const probeCalls = [];
  const invalidations = [];
  let classifierCalls = 0;
  const scheduler = new McpReadinessScheduler({
    operationManager: manager,
    pollIntervalMs: 1_000,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    probe: async ({ serverId }) => {
      probeCalls.push({ serverId, now });
      if (serverId === "slack" && now >= 5_000) {
        return {
          healthy: true,
          readinessPhase: "tool_ready",
          providerReadiness: "ready",
        };
      }
      return {
        healthy: false,
        readinessPhase: "starting",
        providerReadiness: serverId === "slack" ? "starting" : null,
        error: "http_503",
      };
    },
    classifyStartupFailure: async () => {
      classifierCalls += 1;
      return "crash_loop";
    },
    onReadyBatch: async ({ serverIds }) => invalidations.push(serverIds),
  });

  const completed = await scheduler.run(operation.operationId, [
    { serverId: "regular", readinessTimeoutMs: 3_000 },
    { serverId: "slack", readinessTimeoutMs: 7_000 },
  ]);

  const regular = completed.servers.find((row) => row.id === "regular");
  const slack = completed.servers.find((row) => row.id === "slack");
  assert.equal(regular.status, "timed_out");
  assert.match(regular.error.message, /3000ms/);
  assert.equal(slack.status, "succeeded");
  assert.equal(classifierCalls, 0);
  assert.deepEqual(invalidations, [["slack"]]);
  assert.equal(
    probeCalls.some((entry) => entry.serverId === "regular" && entry.now > 3_000),
    false,
  );
});

test("advancing warmup progress extends the readiness budget past its wall-clock", async () => {
  const manager = managerForTest();
  const operation = manager.startMcpOperation({
    serverIds: ["slack"],
    startImmediately: false,
  });
  let now = 0;
  const scheduler = new McpReadinessScheduler({
    operationManager: manager,
    pollIntervalMs: 1_000,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    // Rate-limited directory build: items advance every poll, ready only
    // at 20s — far beyond the 5s budget. Progress must keep it alive.
    probe: async () => {
      if (now >= 20_000) {
        return {
          healthy: true,
          readinessPhase: "tool_ready",
          providerReadiness: "ready",
        };
      }
      return {
        healthy: false,
        readinessPhase: "starting",
        providerReadiness: "starting",
        provider_warmup: {
          phase: "users",
          elapsed_seconds: Math.floor(now / 1000),
          items_fetched: 1000 * (1 + Math.floor(now / 1000)),
        },
        error: "http_503",
      };
    },
  });

  const completed = await scheduler.run(operation.operationId, [
    { serverId: "slack", readinessTimeoutMs: 5_000 },
  ]);
  const slack = completed.servers.find((row) => row.id === "slack");
  assert.equal(
    slack.status,
    "succeeded",
    "a provider whose item counts keep advancing must never be declared timed out",
  );
});

test("frozen warmup progress still times out with an honest stall message", async () => {
  const manager = managerForTest();
  const operation = manager.startMcpOperation({
    serverIds: ["slack"],
    startImmediately: false,
  });
  let now = 0;
  const scheduler = new McpReadinessScheduler({
    operationManager: manager,
    pollIntervalMs: 1_000,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    // Stalled build: same items_fetched forever.
    probe: async () => ({
      healthy: false,
      readinessPhase: "starting",
      providerReadiness: "starting",
      provider_warmup: {
        phase: "users",
        elapsed_seconds: Math.floor(now / 1000),
        items_fetched: 23000,
      },
      error: "http_503",
    }),
  });

  const completed = await scheduler.run(operation.operationId, [
    { serverId: "slack", readinessTimeoutMs: 5_000 },
  ]);
  const slack = completed.servers.find((row) => row.id === "slack");
  assert.equal(slack.status, "timed_out");
  assert.match(
    slack.error.message,
    /No sync progress .* stalled at 23,000 users/,
    "timeout copy must state the stall position, not 'may have failed to start'",
  );
});

test("terminal operation state is emitted only after readiness publication", async () => {
  const manager = managerForTest();
  const operation = manager.startMcpOperation({
    serverIds: ["ready"],
    startImmediately: false,
  });
  let releasePublication;
  const publicationBlocked = new Promise((resolve) => {
    releasePublication = resolve;
  });
  let publicationStarted = false;
  const scheduler = new McpReadinessScheduler({
    operationManager: manager,
    probe: async () => ({ healthy: true, readinessPhase: "tool_ready" }),
    publishReadiness: async () => {
      publicationStarted = true;
      await publicationBlocked;
    },
  });

  const running = scheduler.run(operation.operationId, [{ serverId: "ready" }]);
  while (!publicationStarted) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(manager.getMcpOperation(operation.operationId).rows[0].terminal, false);

  releasePublication();
  const completed = await running;
  assert.equal(completed.rows[0].terminal, true);
  assert.equal(completed.rows[0].outcome, "tool_ready");
});

test("fatal probe helpers classify dead upstreams and humanize verdicts", () => {
  const {
    isFatalStartupProbe,
    humanizeStartupFailureDetail,
  } = require("./mcp-readiness-scheduler");

  assert.equal(isFatalStartupProbe({ error: "http_503" }), true);
  assert.equal(isFatalStartupProbe({ error: "http_503", toolsCount: 2 }), false);
  assert.equal(isFatalStartupProbe({ error: "tool_probe_http_500", toolsCount: 2 }), true);
  assert.equal(isFatalStartupProbe({ error: "http_404" }), false);
  assert.equal(isFatalStartupProbe({ error: "not_discovered" }), false);
  for (const providerReadiness of ["starting", "unsupported", "probe_failed"]) {
    assert.equal(
      isFatalStartupProbe({ error: "http_503", providerReadiness }),
      false,
    );
  }
  assert.equal(isFatalStartupProbe({}), false);

  const authDetail = humanizeStartupFailureDetail("auth", "http_503");
  assert.match(authDetail, /HTTP 503/);
  assert.match(authDetail, /credential/);
  assert.doesNotMatch(authDetail, /http_503/);
  assert.match(humanizeStartupFailureDetail("config", "http_500"), /configuration/);
  assert.match(humanizeStartupFailureDetail("crash_loop", null), /crash-looping/);
});

test("sustained http_503 streak with an auth verdict terminalizes startup_failed early", async () => {
  const manager = managerForTest();
  const operation = manager.startMcpOperation({
    serverIds: ["snowflake"],
    startImmediately: false,
  });
  let now = 0;
  let probeCount = 0;
  const classifierCalls = [];
  const publications = [];
  const scheduler = new McpReadinessScheduler({
    operationManager: manager,
    timeoutMs: 120_000,
    pollIntervalMs: 1_000,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    probe: async () => {
      probeCount += 1;
      return { healthy: false, readinessPhase: "starting", error: "http_503" };
    },
    classifyStartupFailure: async (context) => {
      classifierCalls.push(context);
      return "auth";
    },
    publishReadiness: async (readiness) => publications.push(readiness),
  });

  const completed = await scheduler.run(operation.operationId, [
    { serverId: "snowflake", deploymentType: "docker" },
  ]);

  // Streak (>=8) is reached long before the 20s elapsed floor; the classifier
  // fires on the first probe at/after 20s and polling stops immediately.
  assert.equal(probeCount, 21);
  assert.equal(classifierCalls.length, 1);
  assert.deepEqual(classifierCalls[0], {
    serverId: "snowflake",
    deploymentType: "docker",
    error: "http_503",
  });
  const failedPublication = publications.find(
    (entry) => entry.readinessPhase === "startup_failed",
  );
  assert.ok(failedPublication);
  assert.equal(failedPublication.startupFailureKind, "auth");
  assert.match(failedPublication.error, /credential/);
  const row = completed.servers[0];
  assert.equal(row.status, "failed");
  assert.equal(row.phase, "startup_failed");
  assert.match(row.error.message, /HTTP 503/);
  assert.match(row.error.message, /credential/);
});

test("ambiguous logs keep polling to timeout and classify only once", async () => {
  const manager = managerForTest();
  const operation = manager.startMcpOperation({
    serverIds: ["mystery"],
    startImmediately: false,
  });
  let now = 0;
  let probeCount = 0;
  let classifierCalls = 0;
  const scheduler = new McpReadinessScheduler({
    operationManager: manager,
    timeoutMs: 120_000,
    pollIntervalMs: 1_000,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    probe: async () => {
      probeCount += 1;
      return { healthy: false, readinessPhase: "starting", error: "http_503" };
    },
    classifyStartupFailure: async () => {
      classifierCalls += 1;
      return null;
    },
  });

  const completed = await scheduler.run(operation.operationId, [
    { serverId: "mystery" },
  ]);
  assert.equal(classifierCalls, 1);
  assert.ok(probeCount > 21);
  assert.equal(completed.timedOut, 1);
  assert.match(completed.servers[0].error.message, /120000ms/);
});

test("without a classifier the fatal streak changes nothing", async () => {
  const manager = managerForTest();
  const operation = manager.startMcpOperation({
    serverIds: ["legacy"],
    startImmediately: false,
  });
  let now = 0;
  const publications = [];
  const scheduler = new McpReadinessScheduler({
    operationManager: manager,
    timeoutMs: 120_000,
    pollIntervalMs: 1_000,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    probe: async () => ({
      healthy: false,
      readinessPhase: "starting",
      error: "http_503",
    }),
    publishReadiness: async (readiness) => publications.push(readiness),
  });

  const completed = await scheduler.run(operation.operationId, [
    { serverId: "legacy" },
  ]);
  assert.equal(completed.timedOut, 1);
  assert.ok(
    publications.every((entry) => entry.readinessPhase !== "startup_failed"),
  );
});

test("a throwing classifier degrades to timeout instead of failing the run", async () => {
  const manager = managerForTest();
  const operation = manager.startMcpOperation({
    serverIds: ["flaky"],
    startImmediately: false,
  });
  let now = 0;
  const scheduler = new McpReadinessScheduler({
    operationManager: manager,
    timeoutMs: 120_000,
    pollIntervalMs: 1_000,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    probe: async () => ({
      healthy: false,
      readinessPhase: "starting",
      error: "http_503",
    }),
    classifyStartupFailure: async () => {
      throw new Error("docker exec failed");
    },
  });

  const completed = await scheduler.run(operation.operationId, [
    { serverId: "flaky" },
  ]);
  assert.equal(completed.timedOut, 1);
});

test("a recovering server resets the fatal streak", async () => {
  const manager = managerForTest();
  const operation = manager.startMcpOperation({
    serverIds: ["recovers"],
    startImmediately: false,
  });
  let now = 0;
  let probeCount = 0;
  let classifierCalls = 0;
  const scheduler = new McpReadinessScheduler({
    operationManager: manager,
    timeoutMs: 120_000,
    pollIntervalMs: 1_000,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    probe: async () => {
      probeCount += 1;
      // A non-fatal probe every 5th round keeps breaking the streak; the
      // server then comes up healthy.
      if (probeCount === 40) {
        return { healthy: true, readinessPhase: "tool_ready" };
      }
      return probeCount % 5 === 0
        ? { healthy: false, readinessPhase: "starting", error: "not_discovered" }
        : { healthy: false, readinessPhase: "starting", error: "http_503" };
    },
    classifyStartupFailure: async () => {
      classifierCalls += 1;
      return "auth";
    },
  });

  const completed = await scheduler.run(operation.operationId, [
    { serverId: "recovers" },
  ]);
  assert.equal(classifierCalls, 0);
  assert.equal(completed.servers[0].status, "succeeded");
});

test("stall probes include timeouts but pure timeouts stay exempt", () => {
  const { isStartupStallProbe } = require("./mcp-readiness-scheduler");
  assert.equal(isStartupStallProbe({ error: "http_503" }), true);
  assert.equal(isStartupStallProbe({ error: "request_timeout" }), true);
  assert.equal(
    isStartupStallProbe({ error: "request_timeout", toolsCount: 3 }),
    false,
  );
  assert.equal(isStartupStallProbe({ error: "not_discovered" }), false);
  for (const providerReadiness of ["starting", "unsupported", "probe_failed"]) {
    assert.equal(
      isStartupStallProbe({ error: "request_timeout", providerReadiness }),
      false,
    );
  }
});

test("alternating http_503 and request_timeout probes still terminalize", async () => {
  const manager = managerForTest();
  const operation = manager.startMcpOperation({
    serverIds: ["crashloop"],
    startImmediately: false,
  });
  let now = 0;
  let probeCount = 0;
  const classifierCalls = [];
  const scheduler = new McpReadinessScheduler({
    operationManager: manager,
    timeoutMs: 120_000,
    pollIntervalMs: 1_000,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    // A lazily-respawning crash loop: most probes time out mid-respawn, every
    // third one lands after the child died and gets the hard 503.
    probe: async () => {
      probeCount += 1;
      return {
        healthy: false,
        readinessPhase: "starting",
        error: probeCount % 3 === 0 ? "http_503" : "request_timeout",
      };
    },
    classifyStartupFailure: async (context) => {
      classifierCalls.push(context);
      return "auth";
    },
  });

  const completed = await scheduler.run(operation.operationId, [
    { serverId: "crashloop" },
  ]);
  assert.equal(classifierCalls.length, 1);
  // The classifier receives the last hard 5xx, not the timeout that happened
  // to be the triggering probe.
  assert.equal(classifierCalls[0].error, "http_503");
  const row = completed.servers[0];
  assert.equal(row.phase, "startup_failed");
  assert.match(row.error.message, /HTTP 503/);
  assert.ok(probeCount < 40);
});

test("pure request timeouts never trigger the failure classifier", async () => {
  const manager = managerForTest();
  const operation = manager.startMcpOperation({
    serverIds: ["slow-starter"],
    startImmediately: false,
  });
  let now = 0;
  let classifierCalls = 0;
  const scheduler = new McpReadinessScheduler({
    operationManager: manager,
    timeoutMs: 120_000,
    pollIntervalMs: 1_000,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    probe: async () => ({
      healthy: false,
      readinessPhase: "starting",
      error: "request_timeout",
    }),
    classifyStartupFailure: async () => {
      classifierCalls += 1;
      return "crash_loop";
    },
  });

  const completed = await scheduler.run(operation.operationId, [
    { serverId: "slow-starter" },
  ]);
  assert.equal(classifierCalls, 0);
  assert.equal(completed.timedOut, 1);
});
