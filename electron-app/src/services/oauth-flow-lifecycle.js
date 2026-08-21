const flowCompletionResolvers = new Map();

// Note: this module intentionally does NOT enforce a "stale" no-callback
// fast-fail. The product UX choice is that legitimately slow authorizations
// (consent-screen review, slow Wi-Fi, 2FA codes) should NOT be killed by a
// renderer/main-process timer. The escape hatches are user-driven:
// the wizard's "Stuck? Retry" button, the modal close (X), the outer
// request `timeoutMs` budget, and the upfront 4xx auth-URL probe in
// oauth-wizard-modal.js for the contractor + data-plat-mcp denial case.

function withTrackedSetupFlow(serverId, activeSetupFlows, flowType, fn) {
  activeSetupFlows.set(serverId, flowType);

  let resolveCompletion;
  const completionPromise = new Promise(r => { resolveCompletion = r; });
  flowCompletionResolvers.set(serverId, { promise: completionPromise, resolve: resolveCompletion });

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      activeSetupFlows.delete(serverId);
      const entry = flowCompletionResolvers.get(serverId);
      if (entry) {
        entry.resolve();
        flowCompletionResolvers.delete(serverId);
      }
    });
}

/**
 * Wait for a same-server flow to finish before starting the next step.
 * When toggle -> authorize happens quickly (e.g. LLM gets "Server disconnected"
 * mid-toggle and immediately calls authorize), the toggle's flow lock is still
 * held. Instead of rejecting, wait for it to release.
 *
 * Returns null if cleared, or the conflicting entry string if a DIFFERENT
 * server's flow is blocking (caller should reject with FLOW_IN_PROGRESS).
 */
async function waitForSameServerFlow(serverId, activeSetupFlows, { maxWaitMs = 30000 } = {}) {
  if (!activeSetupFlows.has(serverId)) return null;

  const completionEntry = flowCompletionResolvers.get(serverId);
  if (!completionEntry) return null;

  const timeout = new Promise(resolve => setTimeout(() => resolve('timeout'), maxWaitMs));
  const result = await Promise.race([completionEntry.promise.then(() => 'done'), timeout]);

  if (result === 'timeout' && activeSetupFlows.has(serverId)) {
    const entry = activeSetupFlows.get(serverId);
    return `${serverId}(${entry})`;
  }
  return null;
}

async function waitForFlowResultOrRequestDisconnect(options) {
  const {
    flowPromise,
    requestLifecycle,
    pollIntervalMs = 250,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;

  if (!flowPromise || typeof flowPromise.then !== "function") {
    throw new Error("flowPromise is required");
  }

  if (!requestLifecycle || typeof requestLifecycle.isClientDisconnected !== "function") {
    return { type: "result", result: await flowPromise };
  }

  let settled = false;
  const wrappedFlowPromise = Promise.resolve(flowPromise).then((result) => {
    settled = true;
    return { type: "result", result };
  });

  while (!settled) {
    const outcome = await Promise.race([
      wrappedFlowPromise,
      sleep(pollIntervalMs).then(() => null),
    ]);
    if (outcome) {
      return outcome;
    }
    if (requestLifecycle.isClientDisconnected()) {
      return { type: "client_disconnected" };
    }
  }

  return wrappedFlowPromise;
}

function consumeDismissedOAuthFlow(serverId, dismissedOAuthFlows) {
  if (!dismissedOAuthFlows.has(serverId)) {
    return false;
  }

  dismissedOAuthFlows.delete(serverId);
  return true;
}

function buildOAuthDismissedResponse(serverId) {
  return {
    success: false,
    completed: false,
    dismissed: true,
    error: "User dismissed OAuth authorization",
    message: "OAuth authorization was dismissed by the user.",
    server_id: serverId,
  };
}

function broadcastOAuthFlowCompleted(browserWindows, payload) {
  let focusedOne = false;
  for (const window of browserWindows) {
    if (!window || typeof window.isDestroyed !== "function") {
      continue;
    }

    if (window.isDestroyed()) {
      continue;
    }

    window.webContents?.send("oauth-flow-completed", payload);

    if (!focusedOne && window.getTitle && !window.getTitle().startsWith('tooltip')) {
      window.show();
      window.focus();
      focusedOne = true;
    }
  }

  if (process.platform === "darwin") {
    try {
      require("electron").app.dock.bounce("informational");
    } catch (_) {}
  }
}

function createOAuthRequestLifecycle(req, res, options = {}) {
  const logger = options.logger || console;
  const serverId = options.serverId || "unknown";
  let clientDisconnected = false;
  let responseFinished = false;

  const markDisconnected = () => {
    if (clientDisconnected) {
      return;
    }

    clientDisconnected = true;
    logger.warn?.(`[API] OAuth flow client disconnected for ${serverId}`);
  };

  const onAborted = () => {
    markDisconnected();
  };
  const onClose = () => {
    if (!responseFinished && !res?.writableEnded) {
      markDisconnected();
    }
  };
  const onFinish = () => {
    responseFinished = true;
  };

  req?.on?.("aborted", onAborted);
  res?.on?.("close", onClose);
  res?.on?.("finish", onFinish);

  return {
    isClientDisconnected() {
      return clientDisconnected;
    },
    canRespond() {
      return (
        !clientDisconnected &&
        !responseFinished &&
        !res?.destroyed &&
        !res?.headersSent &&
        !res?.writableEnded
      );
    },
    detach() {
      req?.off?.("aborted", onAborted);
      res?.off?.("close", onClose);
      res?.off?.("finish", onFinish);
    },
  };
}

async function waitForOAuthFlowOutcome(options) {
  const {
    serverId,
    oauthStatusUrl,
    skipAggregatorPoll = false,
    dismissedOAuthFlows,
    completedOAuthFlows,
    requestLifecycle,
    fetchImpl = fetch,
    timeoutMs = 600000,
    pollIntervalMs = 2000,
    fetchTimeoutMs = 5000,
    logger = console,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    createAbortController = () => new AbortController(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = options;

  const startTime = now();

  while (now() - startTime < timeoutMs) {
    if (requestLifecycle?.isClientDisconnected()) {
      return { type: "client_disconnected" };
    }

    if (consumeDismissedOAuthFlow(serverId, dismissedOAuthFlows)) {
      return { type: "dismissed" };
    }

    if (completedOAuthFlows?.has(serverId)) {
      completedOAuthFlows.delete(serverId);
      logger.log?.(`[API] OAuth wizard signalled completion for ${serverId} (via IPC)`);
      return { type: "completed", completed: { server_name: serverId, source: "wizard_ipc" } };
    }

    await sleep(pollIntervalMs);

    if (requestLifecycle?.isClientDisconnected()) {
      return { type: "client_disconnected" };
    }

    if (consumeDismissedOAuthFlow(serverId, dismissedOAuthFlows)) {
      return { type: "dismissed" };
    }

    if (completedOAuthFlows?.has(serverId)) {
      completedOAuthFlows.delete(serverId);
      logger.log?.(`[API] OAuth wizard signalled completion for ${serverId} (via IPC)`);
      return { type: "completed", completed: { server_name: serverId, source: "wizard_ipc" } };
    }

    if (skipAggregatorPoll) {
      continue;
    }

    let fetchTimeout;

    try {
      const controller = createAbortController();
      fetchTimeout = setTimer(() => controller.abort(), fetchTimeoutMs);

      const response = await fetchImpl(oauthStatusUrl, {
        signal: controller.signal,
      });
      clearTimer(fetchTimeout);
      fetchTimeout = null;

      if (!response.ok) {
        logger.warn?.(
          `[API] OAuth status endpoint returned ${response.status} for ${serverId}`,
        );
        continue;
      }

      const status = await response.json();

      if (requestLifecycle?.isClientDisconnected()) {
        return { type: "client_disconnected" };
      }

      if (consumeDismissedOAuthFlow(serverId, dismissedOAuthFlows)) {
        return { type: "dismissed" };
      }

      const completed = status.completed?.find(
        (entry) => entry.server_name === serverId,
      );
      if (completed) {
        return { type: "completed", completed };
      }

      const failed = status.failed?.find((entry) => entry.server_name === serverId);
      if (failed) {
        return { type: "failed", failed };
      }

      const timedOut = status.timeout?.find(
        (entry) => entry.server_name === serverId,
      );
      if (timedOut) {
        return { type: "timeout", source: "server_status" };
      }
    } catch (error) {
      if (fetchTimeout != null) {
        clearTimer(fetchTimeout);
        fetchTimeout = null;
      }

      if (error?.name === "AbortError") {
        logger.warn?.(`[API] OAuth status fetch timeout (${fetchTimeoutMs}ms) for ${serverId}`);
      } else {
        logger.error?.("[API] OAuth status check error:", error);
      }
    }
  }

  return { type: "timeout", source: "request_timeout" };
}

module.exports = {
  buildOAuthDismissedResponse,
  broadcastOAuthFlowCompleted,
  consumeDismissedOAuthFlow,
  createOAuthRequestLifecycle,
  waitForFlowResultOrRequestDisconnect,
  waitForOAuthFlowOutcome,
  waitForSameServerFlow,
  withTrackedSetupFlow,
};
