const HEALTH_CHECK_EXEC_TIMEOUTS_MS = {
  light: 30000,
  full: 180000,
  "startup-core": 120000,
};

function normalizeHealthCheckMode(mode) {
  const normalized = String(mode || "").trim().toLowerCase();
  if (normalized === "full" || normalized === "light" || normalized === "startup-core") {
    return normalized;
  }
  return "light";
}

function getHealthCheckExecTimeoutMs(mode) {
  const normalizedMode = normalizeHealthCheckMode(mode);
  return HEALTH_CHECK_EXEC_TIMEOUTS_MS[normalizedMode];
}

function isHealthCheckExecTimeout(error) {
  if (!error || typeof error !== "object") {
    return false;
  }

  if (error.timedOut === true) {
    return true;
  }

  if (error.killed === true) {
    return true;
  }

  if (typeof error.signal === "string" && error.signal.length > 0) {
    return true;
  }

  return /timed? out/i.test(String(error.message || ""));
}

function isFreshHealthResult(options = {}) {
  const expectedRunId = String(options.expectedRunId || "");
  const expectedMode = String(options.expectedMode || "");
  const diagnostics = options.healthData?.sync_diagnostics;
  const servers = options.healthData?.servers;
  const configuredCoreServerIds = diagnostics?.configured_core_server_ids;
  const statusMarker = options.statusMarker;
  const priorStatusMarker = options.priorStatusMarker;
  if (
    !expectedRunId ||
    !expectedMode ||
    !statusMarker ||
    !Array.isArray(configuredCoreServerIds) ||
    configuredCoreServerIds.length === 0
  ) {
    return false;
  }

  const statusChanged =
    !priorStatusMarker ||
    statusMarker.ino !== priorStatusMarker.ino ||
    statusMarker.mtimeMs > priorStatusMarker.mtimeMs ||
    statusMarker.size !== priorStatusMarker.size;

  return (
    options.recordedRunId === expectedRunId &&
    diagnostics?.health_sync_run_id === expectedRunId &&
    diagnostics?.health_check_mode === expectedMode &&
    configuredCoreServerIds.every(
      (serverId) =>
        servers?.[serverId]?.is_core === true &&
        servers?.[serverId]?.status === "healthy",
    ) &&
    statusChanged &&
    Number.isFinite(statusMarker.mtimeMs) &&
    statusMarker.mtimeMs + 1000 >= options.runnerStartedAt
  );
}

module.exports = {
  getHealthCheckExecTimeoutMs,
  isFreshHealthResult,
  isHealthCheckExecTimeout,
  normalizeHealthCheckMode,
};
