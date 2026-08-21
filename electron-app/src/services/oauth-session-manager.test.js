const test = require("node:test");
const assert = require("node:assert/strict");

const {
  startOAuthSession,
  waitForOAuthSessionForRequest,
} = require("./oauth-session-manager");

function waitForMicrotask() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("startOAuthSession registers the shared session and cleans up after success", async () => {
  const oauthFlowSessions = new Map();
  const activeSetupFlows = new Map();
  let resolveSession;
  let observedSession = null;

  const session = startOAuthSession("data-plat-mcp", {
    oauthFlowSessions,
    activeSetupFlows,
    forceAuth: true,
    runSession(currentSession) {
      observedSession = currentSession;
      return new Promise((resolve) => {
        resolveSession = resolve;
      });
    },
  });

  assert.equal(oauthFlowSessions.get("data-plat-mcp"), session);

  await waitForMicrotask();

  assert.equal(observedSession, session);
  assert.equal(activeSetupFlows.get("data-plat-mcp"), "oauth");
  assert.equal(session.forceAuth, true);
  assert.equal(session.flowType, "oauth");

  resolveSession({ success: true, completed: true, server_id: "data-plat-mcp" });

  const result = await session.promise;
  assert.deepEqual(result, {
    success: true,
    completed: true,
    server_id: "data-plat-mcp",
  });
  assert.equal(activeSetupFlows.size, 0);
  assert.equal(oauthFlowSessions.size, 0);
});

test("startOAuthSession converts crashes into structured results and cleans up maps", async () => {
  const oauthFlowSessions = new Map();
  const activeSetupFlows = new Map();
  const loggedErrors = [];

  const session = startOAuthSession("data-plat-mcp", {
    oauthFlowSessions,
    activeSetupFlows,
    runSession() {
      throw new Error("oauth exploded");
    },
    logger: {
      error(...args) {
        loggedErrors.push(args.join(" "));
      },
    },
  });

  await waitForMicrotask();

  const result = await session.promise;
  assert.deepEqual(result, {
    success: false,
    completed: false,
    server_id: "data-plat-mcp",
    error: "oauth exploded",
  });
  assert.equal(activeSetupFlows.size, 0);
  assert.equal(oauthFlowSessions.size, 0);
  assert.equal(loggedErrors.length, 1);
  assert.match(loggedErrors[0], /Session crashed for data-plat-mcp/);
});

test("waitForOAuthSessionForRequest delegates the shared promise and request lifecycle", async () => {
  const session = {
    promise: Promise.resolve({ success: true, completed: true }),
  };
  const requestLifecycle = {
    isClientDisconnected() {
      return false;
    },
  };
  const invocations = [];

  const outcome = await waitForOAuthSessionForRequest(session, {
    requestLifecycle,
    pollIntervalMs: 123,
    waitForFlowResultOrRequestDisconnectImpl(options) {
      invocations.push(options);
      return Promise.resolve({ type: "result", result: { ok: true } });
    },
  });

  assert.deepEqual(outcome, { type: "result", result: { ok: true } });
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].flowPromise, session.promise);
  assert.equal(invocations[0].requestLifecycle, requestLifecycle);
  assert.equal(invocations[0].pollIntervalMs, 123);
});

test("multiple request waiters can share one OAuth session even if one disconnects", async () => {
  const oauthFlowSessions = new Map();
  const activeSetupFlows = new Map();
  let resolveSession;

  const session = startOAuthSession("data-plat-mcp", {
    oauthFlowSessions,
    activeSetupFlows,
    runSession() {
      return new Promise((resolve) => {
        resolveSession = resolve;
      });
    },
  });

  await waitForMicrotask();

  const firstWaiter = waitForOAuthSessionForRequest(session, {
    requestLifecycle: {
      isClientDisconnected() {
        return true;
      },
    },
    waitForFlowResultOrRequestDisconnectImpl() {
      return Promise.resolve({ type: "client_disconnected" });
    },
  });

  const secondWaiter = waitForOAuthSessionForRequest(session, {
    requestLifecycle: {
      isClientDisconnected() {
        return false;
      },
    },
    waitForFlowResultOrRequestDisconnectImpl({ flowPromise }) {
      return flowPromise.then((result) => ({ type: "result", result }));
    },
  });

  assert.deepEqual(await firstWaiter, { type: "client_disconnected" });

  resolveSession({ success: true, completed: true, server_id: "data-plat-mcp" });

  assert.deepEqual(await secondWaiter, {
    type: "result",
    result: { success: true, completed: true, server_id: "data-plat-mcp" },
  });
  assert.equal(activeSetupFlows.size, 0);
  assert.equal(oauthFlowSessions.size, 0);
});
