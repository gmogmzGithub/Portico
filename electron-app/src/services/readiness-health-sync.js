const SUMMARY_KEYS = [
  "healthy",
  "needs_oauth",
  "timeout",
  "failed",
  "not_running",
  "not_configured",
  "starting",
  "disabled",
];

function buildHealthSummary(servers = {}) {
  const summary = { total: 0 };
  for (const key of SUMMARY_KEYS) {
    summary[key] = 0;
  }

  for (const server of Object.values(servers || {})) {
    if (!server || typeof server !== "object") {
      continue;
    }

    summary.total += 1;
    const status = server.status || "failed";
    if (status === "checking") {
      summary.starting += 1;
    } else if (Object.hasOwn(summary, status)) {
      summary[status] += 1;
    } else {
      summary.failed += 1;
    }
  }

  return summary;
}

function shouldReconcileHealthStatusFromReadiness(status = {}, options = {}) {
  const deploymentType = status.deploymentType || status.deployment_type;
  if (!deploymentType || (deploymentType === "host" && options.allowHost !== true)) {
    return false;
  }

  const toolReadyPhase = options.toolReadyPhase || "tool_ready";
  const readinessPhase =
    status.readinessPhase || status.readiness_phase || null;
  const terminalPhase = new Set([
    toolReadyPhase,
    "needs_oauth",
    "waiting_callback",
    "failed",
    "startup_failed",
    "timeout",
    "not_configured",
  ]);

  return Boolean(status.healthy) || terminalPhase.has(readinessPhase);
}

function healthPatchFromReadiness(status = {}, options = {}) {
  const readinessPhase =
    status.readinessPhase || status.readiness_phase || null;
  const oauthState = status.oauthState || status.oauth_state || null;
  const host = options.host ?? null;
  const port = options.port ?? null;

  if (Boolean(status.healthy) || readinessPhase === (options.toolReadyPhase || "tool_ready")) {
    return {
      status: "healthy",
      error: null,
      running: true,
      host,
      port,
      oauth_state: oauthState,
      configured: true,
    };
  }

  if (readinessPhase === "needs_oauth" || readinessPhase === "waiting_callback") {
    return {
      status: "needs_oauth",
      error: "Server configured but waiting for OAuth authorization",
      running: false,
      host: null,
      port: null,
      oauth_state: oauthState,
      configured: true,
    };
  }

  if (readinessPhase === "timeout") {
    return {
      status: "timeout",
      error: status.error || "OAuth authorization timeout",
      running: false,
      host: null,
      port: null,
      oauth_state: oauthState,
    };
  }

  if (readinessPhase === "failed" || readinessPhase === "startup_failed") {
    return {
      status: "failed",
      error: status.error || "Server failed to start - check logs for errors",
      running: false,
      host: null,
      port: null,
      oauth_state: oauthState,
    };
  }

  if (readinessPhase === "not_configured") {
    return {
      status: "not_configured",
      error: status.error || "Server configuration is incomplete",
      running: false,
      host: null,
      port: null,
      oauth_state: oauthState,
      configured: false,
    };
  }

  return null;
}

function reconcileHealthStatusFromReadiness(
  serverId,
  status = {},
  options = {},
) {
  if (!shouldReconcileHealthStatusFromReadiness(status, options)) {
    return null;
  }

  const healthData = options.healthData;
  if (!healthData || typeof healthData !== "object") {
    throw new TypeError("healthData (object) is required");
  }

  const patch = healthPatchFromReadiness(status, options);
  if (!patch) {
    return null;
  }

  if (!healthData.servers || typeof healthData.servers !== "object") {
    healthData.servers = {};
  }

  const existing = healthData.servers[serverId] || {};
  healthData.servers[serverId] = {
    ...existing,
    ...patch,
  };
  healthData.summary = buildHealthSummary(healthData.servers);
  return healthData;
}

module.exports = {
  buildHealthSummary,
  shouldReconcileHealthStatusFromReadiness,
  reconcileHealthStatusFromReadiness,
};
