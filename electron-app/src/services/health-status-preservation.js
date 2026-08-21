const PRESERVABLE_LAGGING_STATUSES = new Set([
  "healthy",
  "needs_oauth",
  "timeout",
  "failed",
  "not_running",
  "not_configured",
  "disabled",
]);
const TRANSIENT_LAGGING_STATUSES = new Set(["starting", "checking"]);
const {
  defaultReadinessPhaseForStatus,
} = require("./readiness-phase");

function normalizeStatus(status) {
  return String(status || "").trim().toLowerCase();
}

function preserveLaggingServerStates(
  healthStatus,
  previousHealthStatus,
  options = {},
) {
  if (!healthStatus || typeof healthStatus !== "object") {
    return healthStatus;
  }
  if (!healthStatus.servers || typeof healthStatus.servers !== "object") {
    return healthStatus;
  }

  const laggingIds = healthStatus.sync_diagnostics?.lagging_server_ids;
  if (
    healthStatus.sync_diagnostics &&
    typeof healthStatus.sync_diagnostics === "object"
  ) {
    healthStatus.sync_diagnostics.preserved_server_ids = [];
    healthStatus.sync_diagnostics.preserved_servers = 0;
  }
  if (!Array.isArray(laggingIds) || laggingIds.length === 0) {
    return healthStatus;
  }

  const preservedIds = [];
  for (const serverId of laggingIds) {
    const nextServer = healthStatus.servers?.[serverId];
    const previousServer = previousHealthStatus?.servers?.[serverId];
    if (!nextServer || !previousServer) {
      continue;
    }

    const nextStatus = normalizeStatus(nextServer.status);
    const previousStatus = normalizeStatus(previousServer.status);
    if (
      !TRANSIENT_LAGGING_STATUSES.has(nextStatus) ||
      !PRESERVABLE_LAGGING_STATUSES.has(previousStatus)
    ) {
      continue;
    }

    healthStatus.servers[serverId] = {
      ...nextServer,
      status: previousServer.status,
      error: previousServer.error ?? null,
      running: previousServer.running ?? previousStatus === "healthy",
      host: previousServer.host ?? null,
      port: previousServer.port ?? null,
      oauth_state: previousServer.oauth_state ?? null,
      readiness_phase:
        previousServer.readiness_phase ||
        defaultReadinessPhaseForStatus(previousServer.status),
      healthy: previousServer.healthy ?? previousStatus === "healthy",
      authorization_url_available:
        previousServer.authorization_url_available ??
        nextServer.authorization_url_available ??
        null,
    };
    preservedIds.push(serverId);
  }

  if (
    healthStatus.sync_diagnostics &&
    typeof healthStatus.sync_diagnostics === "object"
  ) {
    healthStatus.sync_diagnostics.preserved_server_ids = preservedIds;
    healthStatus.sync_diagnostics.preserved_servers = preservedIds.length;
  }

  if (
    preservedIds.length > 0 &&
    typeof options.recomputeSummary === "function"
  ) {
    options.recomputeSummary(healthStatus);
  }

  return healthStatus;
}

module.exports = {
  preserveLaggingServerStates,
};
