function toggleHealthReason(serverId, enabled) {
  return enabled
    ? `mcp-server-enabled:${serverId}`
    : `mcp-server-disabled:${serverId}`;
}

function bulkToggleHealthReason(enabled) {
  if (typeof enabled !== "boolean") {
    throw new TypeError("enabled (boolean) is required");
  }

  return enabled ? "mcp-servers-bulk-enabled" : "mcp-servers-bulk-disabled";
}

function scheduleHealthSync(reason, dependencies = {}) {
  if (!reason || typeof reason !== "string") {
    throw new TypeError("reason (string) is required");
  }

  const runHealthCheck =
    dependencies.runHealthCheckAndBroadcast || (async () => null);
  const queueFull = dependencies.queueFullHealthCheck || (() => undefined);
  const queueFullAfterToggle = dependencies.queueFullAfterToggle === true;
  const logger = dependencies.logger || console;

  // User-facing toggle flows already do targeted readiness polling for the
  // affected servers. Queueing an additional full health sync here can wedge
  // the UI behind a long-running background check while containers are still
  // recycling. Keep the immediate sync lightweight by default and reserve
  // queued full reconciliations for explicit opt-in call sites.
  if (queueFullAfterToggle) {
    try {
      queueFull(reason, { immediate: false });
    } catch (error) {
      logger.warn(
        `[IPC] Failed to queue full health sync for ${reason}: ${error.message}`,
      );
    }
  }

  Promise.resolve()
    .then(() =>
      runHealthCheck({
        mode: "light",
        reason,
        waitForLock: false,
      }),
    )
    .catch((error) => {
      logger.warn(`[IPC] Light health sync failed for ${reason}: ${error.message}`);
    });

  return { reason };
}

function schedulePostToggleHealthSync(serverId, enabled, dependencies = {}) {
  if (!serverId || typeof serverId !== "string") {
    throw new TypeError("serverId (string) is required");
  }
  if (typeof enabled !== "boolean") {
    throw new TypeError("enabled (boolean) is required");
  }

  return scheduleHealthSync(toggleHealthReason(serverId, enabled), dependencies);
}

function scheduleBulkToggleHealthSync(enabled, dependencies = {}) {
  return scheduleHealthSync(bulkToggleHealthReason(enabled), dependencies);
}

module.exports = {
  bulkToggleHealthReason,
  scheduleBulkToggleHealthSync,
  scheduleHealthSync,
  schedulePostToggleHealthSync,
  toggleHealthReason,
};
