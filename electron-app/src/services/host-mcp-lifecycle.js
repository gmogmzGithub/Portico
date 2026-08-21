function normalizeServerIds(serverIds) {
  return Array.from(
    new Set(
      (Array.isArray(serverIds) ? serverIds : [])
        .filter((serverId) => typeof serverId === "string" && serverId.trim())
        .map((serverId) => serverId.trim()),
    ),
  );
}

async function ensureServersEnabledForRestart(serverIds, options = {}) {
  const mutateToggles = options.mutateToggles;
  const hasCustomIsCoreServer = Object.prototype.hasOwnProperty.call(
    options,
    "isCoreServer",
  );
  const isCoreServer = hasCustomIsCoreServer
    ? options.isCoreServer
    : () => false;
  const logger = options.logger || console;
  const reasonPrefix = options.reasonPrefix || "ensure-enabled-for-restart";

  if (typeof mutateToggles !== "function") {
    throw new TypeError("mutateToggles (function) is required");
  }
  if (typeof isCoreServer !== "function") {
    throw new TypeError("isCoreServer (function) is required");
  }

  const normalizedIds = normalizeServerIds(serverIds);
  const mutableServerIds = normalizedIds.filter(
    (serverId) => !isCoreServer(serverId),
  );
  if (mutableServerIds.length === 0) {
    return {
      changedServerIds: [],
      skippedServerIds: normalizedIds,
    };
  }

  let changedServerIds = [];
  await mutateToggles(
    (toggles) => {
      changedServerIds = [];
      for (const serverId of mutableServerIds) {
        if (toggles[serverId] !== true) {
          toggles[serverId] = true;
          changedServerIds.push(serverId);
        }
      }
    },
    {
      reason: `${reasonPrefix}:${mutableServerIds.join(",")}`,
    },
  );

  if (changedServerIds.length > 0) {
    logger.log(
      `[MCP] Enabled ${changedServerIds.join(", ")} in mcp_toggles.json before restart`,
    );
  }

  return {
    changedServerIds,
    skippedServerIds: normalizedIds.filter((serverId) =>
      isCoreServer(serverId),
    ),
  };
}

async function restartHostMcpoWithFreshConfig(options = {}) {
  const execAsync = options.execAsync;
  const projectRoot = options.projectRoot;
  const env = options.env;
  const regenerateMcpInfrastructure = options.regenerateMcpInfrastructure;
  const stopHostMcpo = options.stopHostMcpo;
  const startHostMcpo = options.startHostMcpo;
  const logger = options.logger || console;
  const regenerationOptions = options.regenerationOptions || {};
  const skipRegeneration = options.skipRegeneration === true;

  if (typeof execAsync !== "function") {
    throw new TypeError("execAsync (function) is required");
  }
  if (!projectRoot || typeof projectRoot !== "string") {
    throw new TypeError("projectRoot (string) is required");
  }
  if (!env || typeof env !== "object") {
    throw new TypeError("env (object) is required");
  }
  if (typeof regenerateMcpInfrastructure !== "function") {
    throw new TypeError("regenerateMcpInfrastructure (function) is required");
  }
  if (typeof stopHostMcpo !== "function") {
    throw new TypeError("stopHostMcpo (function) is required");
  }
  if (typeof startHostMcpo !== "function") {
    throw new TypeError("startHostMcpo (function) is required");
  }

  if (!skipRegeneration) {
    logger.log("[MCP] Regenerating MCP infrastructure for host-mcpo restart...");
    await regenerateMcpInfrastructure(
      execAsync,
      projectRoot,
      env,
      regenerationOptions,
    );
  }
  logger.log("[MCP] Restarting host-mcpo with refreshed config...");
  await stopHostMcpo();
  await startHostMcpo();
}

function collectRestartedHostServerIds(healthStatus, options = {}) {
  const hasCustomPredicate = Object.prototype.hasOwnProperty.call(
    options,
    "isServerEffectivelyEnabled",
  );
  const isServerEffectivelyEnabled = hasCustomPredicate
    ? options.isServerEffectivelyEnabled
    : () => true;

  if (typeof isServerEffectivelyEnabled !== "function") {
    throw new TypeError("isServerEffectivelyEnabled (function) is required");
  }

  const entries = Object.entries(healthStatus?.servers || {});
  return entries
    .filter(([, serverInfo]) => serverInfo?.deployment === "host")
    .map(([serverId]) => serverId)
    .filter((serverId) => isServerEffectivelyEnabled(serverId));
}

module.exports = {
  collectRestartedHostServerIds,
  ensureServersEnabledForRestart,
  restartHostMcpoWithFreshConfig,
};
