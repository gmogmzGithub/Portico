const test = require("node:test");
const assert = require("node:assert/strict");

const {
  bulkToggleHealthReason,
  scheduleBulkToggleHealthSync,
  schedulePostToggleHealthSync,
  toggleHealthReason,
} = require("./toggle-health-sync");

test("toggleHealthReason encodes enable and disable reasons", () => {
  assert.equal(
    toggleHealthReason("gitlab-mcp", true),
    "mcp-server-enabled:gitlab-mcp",
  );
  assert.equal(
    toggleHealthReason("gitlab-mcp", false),
    "mcp-server-disabled:gitlab-mcp",
  );
});

test("schedulePostToggleHealthSync runs light sync asynchronously without queueing a full sync by default", async () => {
  const events = [];
  let resolveHealth;

  const result = schedulePostToggleHealthSync("gitlab-mcp", true, {
    queueFullHealthCheck: (reason, options) => {
      events.push(["queue", reason, options]);
    },
    runHealthCheckAndBroadcast: async (options) => {
      events.push(["light", options]);
      await new Promise((resolve) => {
        resolveHealth = resolve;
      });
    },
    logger: {
      warn: (message) => events.push(["warn", message]),
    },
  });

  assert.deepEqual(result, {
    reason: "mcp-server-enabled:gitlab-mcp",
  });
  assert.deepEqual(events, []);

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [
    [
      "light",
      {
        mode: "light",
        reason: "mcp-server-enabled:gitlab-mcp",
        waitForLock: false,
      },
    ],
  ]);

  resolveHealth();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    events.filter(([kind]) => kind === "warn").length,
    0,
  );
});

test("schedulePostToggleHealthSync can opt in to queueing a full sync", async () => {
  const events = [];

  schedulePostToggleHealthSync("gitlab-mcp", true, {
    queueFullAfterToggle: true,
    queueFullHealthCheck: (reason, options) => {
      events.push(["queue", reason, options]);
    },
    runHealthCheckAndBroadcast: async (options) => {
      events.push(["light", options]);
    },
    logger: {
      warn: (message) => events.push(["warn", message]),
    },
  });

  assert.deepEqual(events, [
    ["queue", "mcp-server-enabled:gitlab-mcp", { immediate: false }],
  ]);

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [
    ["queue", "mcp-server-enabled:gitlab-mcp", { immediate: false }],
    [
      "light",
      {
        mode: "light",
        reason: "mcp-server-enabled:gitlab-mcp",
        waitForLock: false,
      },
    ],
  ]);
});

test("schedulePostToggleHealthSync swallows background sync failures", async () => {
  const warnings = [];

  schedulePostToggleHealthSync("gitlab-mcp", false, {
    queueFullHealthCheck: () => undefined,
    runHealthCheckAndBroadcast: async () => {
      throw new Error("lock busy");
    },
    logger: {
      warn: (message) => warnings.push(message),
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(warnings.length, 1);
  assert.match(
    warnings[0],
    /Light health sync failed for mcp-server-disabled:gitlab-mcp: lock busy/,
  );
});

test("bulkToggleHealthReason encodes enable and disable reasons", () => {
  assert.equal(bulkToggleHealthReason(true), "mcp-servers-bulk-enabled");
  assert.equal(bulkToggleHealthReason(false), "mcp-servers-bulk-disabled");
});

test("scheduleBulkToggleHealthSync queues async bulk refresh", async () => {
  const events = [];

  scheduleBulkToggleHealthSync(false, {
    queueFullHealthCheck: (reason, options) => {
      events.push(["queue", reason, options]);
    },
    runHealthCheckAndBroadcast: async (options) => {
      events.push(["light", options]);
    },
    logger: {
      warn: (message) => events.push(["warn", message]),
    },
  });

  assert.deepEqual(events, []);

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [
    [
      "light",
      {
        mode: "light",
        reason: "mcp-servers-bulk-disabled",
        waitForLock: false,
      },
    ],
  ]);
});

test("schedulePostToggleHealthSync validates inputs", () => {
  assert.throws(
    () => schedulePostToggleHealthSync("", true),
    /serverId \(string\) is required/,
  );
  assert.throws(
    () => schedulePostToggleHealthSync("gitlab-mcp", "yes"),
    /enabled \(boolean\) is required/,
  );
  assert.throws(() => bulkToggleHealthReason("yes"), /enabled \(boolean\) is required/);
});
