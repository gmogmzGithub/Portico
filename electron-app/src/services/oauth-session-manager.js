const {
  waitForFlowResultOrRequestDisconnect,
  withTrackedSetupFlow,
} = require("./oauth-flow-lifecycle");

function startOAuthSession(serverId, options = {}) {
  const {
    oauthFlowSessions,
    activeSetupFlows,
    forceAuth = false,
    runSession,
    withTrackedSetupFlowImpl = withTrackedSetupFlow,
    logger = console,
  } = options;

  if (!oauthFlowSessions || typeof oauthFlowSessions.set !== "function") {
    throw new Error("oauthFlowSessions map is required");
  }
  if (!activeSetupFlows || typeof activeSetupFlows.set !== "function") {
    throw new Error("activeSetupFlows map is required");
  }
  if (typeof runSession !== "function") {
    throw new Error("runSession callback is required");
  }

  const session = {
    serverId,
    flowType: "oauth",
    forceAuth: Boolean(forceAuth),
    startedAt: Date.now(),
    promise: null,
  };

  session.promise = Promise.resolve()
    .then(() =>
      withTrackedSetupFlowImpl(serverId, activeSetupFlows, "oauth", async () =>
        runSession(session),
      ),
    )
    .catch((error) => {
      logger.error?.(`[OAuth Session] Session crashed for ${serverId}:`, error);
      return {
        success: false,
        completed: false,
        server_id: serverId,
        error: error?.message || String(error),
      };
    })
    .finally(() => {
      if (oauthFlowSessions.get(serverId) === session) {
        oauthFlowSessions.delete(serverId);
      }
    });

  oauthFlowSessions.set(serverId, session);
  return session;
}

async function waitForOAuthSessionForRequest(session, options = {}) {
  const {
    requestLifecycle,
    waitForFlowResultOrRequestDisconnectImpl = waitForFlowResultOrRequestDisconnect,
    pollIntervalMs = 500,
  } = options;

  if (!session?.promise || typeof session.promise.then !== "function") {
    throw new Error("session.promise is required");
  }

  return waitForFlowResultOrRequestDisconnectImpl({
    flowPromise: session.promise,
    requestLifecycle,
    pollIntervalMs,
  });
}

module.exports = {
  startOAuthSession,
  waitForOAuthSessionForRequest,
};
