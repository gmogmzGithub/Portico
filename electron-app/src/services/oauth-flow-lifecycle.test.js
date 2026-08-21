const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  createOAuthRequestLifecycle,
  waitForFlowResultOrRequestDisconnect,
  waitForOAuthFlowOutcome,
  withTrackedSetupFlow,
} = require("./oauth-flow-lifecycle");

test("withTrackedSetupFlow releases the active flow after success", async () => {
  const activeSetupFlows = new Map();

  const result = await withTrackedSetupFlow(
    "glean",
    activeSetupFlows,
    "oauth",
    async () => "ok",
  );

  assert.equal(result, "ok");
  assert.equal(activeSetupFlows.size, 0);
});

test("withTrackedSetupFlow releases the active flow after failure", async () => {
  const activeSetupFlows = new Map();

  await assert.rejects(
    () =>
      withTrackedSetupFlow("glean", activeSetupFlows, "oauth", async () => {
        throw new Error("boom");
      }),
    /boom/,
  );

  assert.equal(activeSetupFlows.size, 0);
});

test("waitForOAuthFlowOutcome returns dismissed immediately and consumes the flag", async () => {
  const dismissedOAuthFlows = new Set(["glean"]);

  const outcome = await waitForOAuthFlowOutcome({
    serverId: "glean",
    oauthStatusUrl: "http://localhost/oauth/status",
    dismissedOAuthFlows,
    requestLifecycle: { isClientDisconnected: () => false },
    fetchImpl: async () => {
      assert.fail("dismissed flows should not fetch oauth status");
    },
    sleep: async () => {},
    now: () => 0,
    timeoutMs: 1000,
  });

  assert.deepEqual(outcome, { type: "dismissed" });
  assert.equal(dismissedOAuthFlows.has("glean"), false);
});

test("waitForOAuthFlowOutcome stops polling when the client disconnects", async () => {
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.writableEnded = false;
  res.headersSent = false;
  res.destroyed = false;

  const warnings = [];
  const lifecycle = createOAuthRequestLifecycle(req, res, {
    serverId: "glean",
    logger: {
      warn(message) {
        warnings.push(message);
      },
    },
  });

  const outcome = await waitForOAuthFlowOutcome({
    serverId: "glean",
    oauthStatusUrl: "http://localhost/oauth/status",
    dismissedOAuthFlows: new Set(),
    requestLifecycle: lifecycle,
    fetchImpl: async () => {
      assert.fail("disconnected requests should not fetch oauth status");
    },
    sleep: async () => {
      res.emit("close");
    },
    now: (() => {
      let current = 0;
      return () => {
        current += 1;
        return current;
      };
    })(),
    timeoutMs: 1000,
  });

  lifecycle.detach();

  assert.deepEqual(outcome, { type: "client_disconnected" });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /OAuth flow client disconnected for glean/);
});

test("waitForFlowResultOrRequestDisconnect resolves with the shared flow result", async () => {
  const result = await waitForFlowResultOrRequestDisconnect({
    flowPromise: Promise.resolve({ success: true, completed: true }),
    requestLifecycle: { isClientDisconnected: () => false },
    sleep: async () => {},
  });

  assert.deepEqual(result, {
    type: "result",
    result: { success: true, completed: true },
  });
});

test("waitForFlowResultOrRequestDisconnect returns client_disconnected when the waiter drops", async () => {
  let disconnected = false;

  const resultPromise = waitForFlowResultOrRequestDisconnect({
    flowPromise: new Promise(() => {}),
    requestLifecycle: { isClientDisconnected: () => disconnected },
    pollIntervalMs: 1,
    sleep: async () => {
      disconnected = true;
    },
  });

  const result = await resultPromise;
  assert.deepEqual(result, { type: "client_disconnected" });
});

// Note: the H-18 stale-callback fast-fail tests were intentionally removed
// when we reverted the 30s/15-poll auto-fail. The product UX choice is that
// legitimately slow authorizations (consent-screen review, slow Wi-Fi, 2FA)
// must not be killed by a renderer/main timer. Escape hatches are user-driven:
// the wizard's "Stuck? Retry" button, modal close (X), the outer 10-min
// request timeoutMs, and the contractor + data-plat-mcp 4xx auth-URL probe
// in oauth-wizard-modal.js for the only "definitely failing" signal we trust.

test("waitForFlowResultOrRequestDisconnect keeps the shared flow alive for other waiters", async () => {
  let disconnectFirstWaiter = false;
  let resolveFlow;
  const flowPromise = new Promise((resolve) => {
    resolveFlow = resolve;
  });

  const firstWaiter = waitForFlowResultOrRequestDisconnect({
    flowPromise,
    requestLifecycle: {
      isClientDisconnected() {
        return disconnectFirstWaiter;
      },
    },
    pollIntervalMs: 1,
    sleep: async () => {
      disconnectFirstWaiter = true;
    },
  });

  const secondWaiter = waitForFlowResultOrRequestDisconnect({
    flowPromise,
    requestLifecycle: {
      isClientDisconnected() {
        return false;
      },
    },
    pollIntervalMs: 1,
    sleep: async () => {},
  });

  assert.deepEqual(await firstWaiter, { type: "client_disconnected" });

  resolveFlow({ success: true, completed: true, server_id: "data-plat-mcp" });

  assert.deepEqual(await secondWaiter, {
    type: "result",
    result: { success: true, completed: true, server_id: "data-plat-mcp" },
  });
});
