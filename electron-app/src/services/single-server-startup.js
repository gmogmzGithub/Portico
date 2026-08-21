const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validatePort(name, value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} (positive integer) is required`);
  }
}

async function probeHttpListener(
  url,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  } = {},
) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl (function) is required");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timeout.unref === "function") {
    timeout.unref();
  }

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    });
    return {
      ok: true,
      url,
      status: Number.isFinite(response?.status) ? response.status : null,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      url,
      status: null,
      error: error?.message || String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function probeSingleServerHostListener(hostPort, options = {}) {
  const probes = [];

  const probe = await probeHttpListener(
    `http://localhost:${hostPort}/oauth/status`,
    options,
  );
  probes.push(probe);
  if (probe.ok && probe.status >= 200 && probe.status < 300) {
    return {
      ok: true,
      url: probe.url,
      status: probe.status,
      error: null,
      probes,
    };
  }

  const lastProbe = probes[probes.length - 1] || null;
  return {
    ok: false,
    url: lastProbe?.url || `http://localhost:${hostPort}/oauth/status`,
    status: lastProbe?.status ?? null,
    error:
      lastProbe?.error ||
      (lastProbe?.ok
        ? `backend returned HTTP ${lastProbe.status ?? "unknown"}`
        : "listener probe failed"),
    probes,
  };
}

function normalizeRestartCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function containerFailureReason(state, initialRestartCount = null) {
  if (!state || state.found === false) {
    return null;
  }

  const status = String(state.status || "").toLowerCase();
  if (status === "exited" || status === "dead") {
    return `container ${status} before backend readiness`;
  }
  if (status === "restarting" || state.restarting === true) {
    return "container restarted before backend readiness";
  }

  const restartCount = normalizeRestartCount(state.restartCount);
  if (restartCount > 0) {
    if (initialRestartCount === null || initialRestartCount === 0) {
      return `container restart count is ${restartCount} before backend readiness`;
    }
  }
  if (initialRestartCount !== null && restartCount > initialRestartCount) {
    return `container restart count increased from ${initialRestartCount} to ${restartCount}`;
  }

  return null;
}

async function collectContainerLogs(getContainerLogs, serverId) {
  if (typeof getContainerLogs !== "function" || !serverId) {
    return null;
  }
  try {
    return await getContainerLogs(serverId);
  } catch (error) {
    return `Failed to collect container logs: ${error?.message || error}`;
  }
}

function formatProbeSummary(result = {}) {
  const probes = Array.isArray(result?.probes) ? result.probes : [];
  if (probes.length === 0) {
    return result?.error || "no probe results";
  }

  return probes
    .map((probe) => {
      const detail = probe.ok
        ? `HTTP ${probe.status ?? "unknown"}`
        : probe.error || "unreachable";
      return `${probe.url}: ${detail}`;
    })
    .join(" | ");
}

async function waitForSingleServerListeners({
  serverId,
  hostPort,
  callbackPort,
  fetchImpl = globalThis.fetch,
  inspectContainerState,
  getContainerLogs,
  sleepImpl = sleep,
  now = Date.now,
  timeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
} = {}) {
  validatePort("hostPort", hostPort);
  validatePort("callbackPort", callbackPort);

  if (typeof sleepImpl !== "function") {
    throw new TypeError("sleepImpl (function) is required");
  }
  if (typeof now !== "function") {
    throw new TypeError("now (function) is required");
  }

  const startMs = now();
  let hostListener = null;
  let callbackListener = null;
  let containerState = null;
  let initialRestartCount = null;

  while (now() - startMs < timeoutMs) {
    hostListener = await probeSingleServerHostListener(hostPort, {
      fetchImpl,
      timeoutMs: probeTimeoutMs,
    });
    const callbackProbe = await probeHttpListener(
      `http://localhost:${callbackPort}/`,
      {
        fetchImpl,
        timeoutMs: probeTimeoutMs,
      },
    );
    callbackListener = {
      ...callbackProbe,
      probes: [callbackProbe],
    };

    if (hostListener.ok && callbackListener.ok) {
      return {
        ready: true,
        hostListener,
        callbackListener,
        containerState,
      };
    }

    if (typeof inspectContainerState === "function" && serverId) {
      try {
        containerState = await inspectContainerState(serverId);
        if (containerState && containerState.found !== false) {
          const failureReason = containerFailureReason(
            containerState,
            initialRestartCount,
          );
          if (failureReason) {
            const containerLogs = await collectContainerLogs(
              getContainerLogs,
              serverId,
            );
            return {
              ready: false,
              error: `Single-server backend failed before readiness: ${failureReason}`,
              hostListener,
              callbackListener,
              containerState,
              containerLogs,
            };
          }
          if (initialRestartCount === null) {
            initialRestartCount = normalizeRestartCount(
              containerState.restartCount,
            );
          }
        }
      } catch (error) {
        containerState = {
          found: false,
          error: error?.message || String(error),
        };
      }
    }

    await sleepImpl(pollIntervalMs);
  }

  const containerLogs = await collectContainerLogs(getContainerLogs, serverId);

  return {
    ready: false,
    error:
      `Timed out waiting for single-server listeners. ` +
      `host=${formatProbeSummary(hostListener)}; ` +
      `callback=${formatProbeSummary(callbackListener)}`,
    hostListener,
    callbackListener,
    containerState,
    containerLogs,
  };
}

module.exports = {
  containerFailureReason,
  probeHttpListener,
  probeSingleServerHostListener,
  waitForSingleServerListeners,
};
