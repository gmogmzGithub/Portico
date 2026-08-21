const DEFAULT_RESOLVER_CACHE_TIMEOUT_MS = 2500;

function collectNetworkSessions({
  defaultSession = null,
  browserWindows = [],
  webContentsEntries = [],
} = {}) {
  const sessions = new Set();
  const addSession = (candidate) => {
    if (candidate && typeof candidate.clearHostResolverCache === "function") {
      sessions.add(candidate);
    }
  };

  addSession(defaultSession);
  for (const windowRef of browserWindows) {
    if (!windowRef || windowRef.isDestroyed?.()) {
      continue;
    }
    addSession(windowRef.webContents?.session);
  }
  for (const contents of webContentsEntries) {
    if (!contents || contents.isDestroyed?.()) {
      continue;
    }
    addSession(contents.session);
  }

  return [...sessions];
}

async function waitForResolverCacheClears(sessions, timeoutMs, logger) {
  const clearPromise = Promise.allSettled(
    sessions.map((networkSession) =>
      Promise.resolve().then(() => networkSession.clearHostResolverCache()),
    ),
  );

  let timeoutId = null;
  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve({ timedOut: true, results: [] }), timeoutMs);
  });
  const settledPromise = clearPromise.then((results) => ({
    timedOut: false,
    results,
  }));
  const outcome = await Promise.race([settledPromise, timeoutPromise]);
  if (timeoutId) {
    clearTimeout(timeoutId);
  }

  if (outcome.timedOut) {
    logger.warn(
      `[Power] Resolver cache clearing exceeded ${timeoutMs}ms; continuing wake recovery`,
    );
    return outcome;
  }

  for (const result of outcome.results) {
    if (result.status === "rejected") {
      logger.warn(
        "[Power] Failed to clear an Electron session resolver cache:",
        result.reason?.message || result.reason,
      );
    }
  }
  return outcome;
}

async function handleSystemResume({
  defaultSession = null,
  browserWindows = [],
  webContentsEntries = [],
  resumePrerequisites = null,
  notifyRenderers = null,
  refreshHealth = null,
  resolverCacheTimeoutMs = DEFAULT_RESOLVER_CACHE_TIMEOUT_MS,
  now = () => Date.now(),
  logger = console,
} = {}) {
  const payload = {
    reason: "system-resume",
    resumedAt: new Date(now()).toISOString(),
  };

  try {
    resumePrerequisites?.(payload);
  } catch (error) {
    logger.warn(
      "[Power] Prerequisite resume handling failed:",
      error?.message || error,
    );
  }

  const sessions = collectNetworkSessions({
    defaultSession,
    browserWindows,
    webContentsEntries,
  });
  const cacheOutcome = await waitForResolverCacheClears(
    sessions,
    Math.max(1, Number(resolverCacheTimeoutMs) || DEFAULT_RESOLVER_CACHE_TIMEOUT_MS),
    logger,
  );

  try {
    notifyRenderers?.(payload);
  } catch (error) {
    logger.warn(
      "[Power] Failed to notify renderers after system resume:",
      error?.message || error,
    );
  }

  try {
    await refreshHealth?.(payload);
  } catch (error) {
    logger.warn(
      "[Power] Immediate post-resume health refresh failed:",
      error?.message || error,
    );
  }

  return {
    ...payload,
    clearedSessionCount: sessions.length,
    resolverCacheTimedOut: cacheOutcome.timedOut,
  };
}

module.exports = {
  DEFAULT_RESOLVER_CACHE_TIMEOUT_MS,
  collectNetworkSessions,
  handleSystemResume,
};
