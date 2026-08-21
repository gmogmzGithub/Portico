const fs = require("node:fs");
const path = require("node:path");
const {
  getGeneratedMcpConfigStatusForServer,
  isRuntimeFileNotConfiguredStatus,
} = require("./runtime-file-status");

const STARTUP_FAILURES_FILENAME = "mcp_startup_failures.json";
const MANAGED_NODE_PACKAGE_PREPARATION_FILENAME =
  "managed_node_package_preparation.json";
const HOST_MANAGED_NODE_PACKAGE_PREPARATION_FILENAME =
  "managed_node_package_preparation-host.json";
const MCP_CONFIG_DIRS = Object.freeze(["mcp-configs", "mcp-configs-user"]);
const SUMMARY_KEYS = Object.freeze([
  "healthy",
  "starting",
  "checking",
  "failed",
  "needs_oauth",
  "not_configured",
  "disabled",
  "timeout",
  "not_running",
  "unknown",
]);

function getStartupFailuresPath(projectRoot) {
  if (!projectRoot || typeof projectRoot !== "string") {
    throw new TypeError("projectRoot (string) is required");
  }
  return path.join(projectRoot, "health-status", STARTUP_FAILURES_FILENAME);
}

function getManagedNodePackagePreparationStatusPath(projectRoot) {
  if (!projectRoot || typeof projectRoot !== "string") {
    throw new TypeError("projectRoot (string) is required");
  }
  return path.join(
    projectRoot,
    "health-status",
    MANAGED_NODE_PACKAGE_PREPARATION_FILENAME,
  );
}

function getHostManagedNodePackagePreparationStatusPath(projectRoot) {
  if (!projectRoot || typeof projectRoot !== "string") {
    throw new TypeError("projectRoot (string) is required");
  }
  return path.join(
    projectRoot,
    "health-status",
    HOST_MANAGED_NODE_PACKAGE_PREPARATION_FILENAME,
  );
}

function normalizeText(value, fallback = null) {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function normalizeStartupFailure(failure = {}) {
  const serverId = normalizeText(failure.serverId || failure.server_id);
  if (!serverId) {
    throw new TypeError("startup failure serverId is required");
  }

  const error = normalizeText(
    failure.error || failure.message || failure.errorMessage,
    "Startup failed",
  );
  const timestamp = normalizeText(failure.timestamp, new Date().toISOString());
  const deploymentType = normalizeText(
    failure.deploymentType || failure.deployment_type || failure.deployment,
  );
  const containerName = normalizeText(
    failure.containerName || failure.container_name,
  );
  const configPath = normalizeText(failure.configPath || failure.config_path);

  return {
    serverId,
    operation: normalizeText(failure.operation, "enable"),
    stage: normalizeText(failure.stage, "startup"),
    error,
    source: normalizeText(failure.source, "runtime"),
    timestamp,
    ...(deploymentType ? { deploymentType } : {}),
    ...(containerName ? { containerName } : {}),
    ...(configPath ? { configPath } : {}),
    ...(failure.errorCode ? { errorCode: failure.errorCode } : {}),
  };
}

function parseStartupFailures(raw) {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const source =
    raw.failures && typeof raw.failures === "object" && !Array.isArray(raw.failures)
      ? raw.failures
      : raw;
  const failures = {};
  for (const [serverId, failure] of Object.entries(source)) {
    if (!failure || typeof failure !== "object") {
      continue;
    }
    try {
      failures[serverId] = normalizeStartupFailure({
        ...failure,
        serverId: failure.serverId || serverId,
      });
    } catch {
      // Ignore malformed persisted entries. A bad failure cache should not
      // block health rendering.
    }
  }
  return failures;
}

function loadStartupFailures(projectRoot, options = {}) {
  const fsModule = options.fsModule || fs;
  const failurePath =
    options.failurePath || getStartupFailuresPath(projectRoot);

  try {
    if (!fsModule.existsSync(failurePath)) {
      return {};
    }
    return parseStartupFailures(
      JSON.parse(fsModule.readFileSync(failurePath, "utf8")),
    );
  } catch (error) {
    if (options.logger?.warn) {
      options.logger.warn(
        `[MCP Startup Failure] Could not read ${failurePath}: ${error.message}`,
      );
    }
    return {};
  }
}

function loadManagedNodePackagePreparationFailures(projectRoot, options = {}) {
  const fsModule = options.fsModule || fs;
  const statusPaths = options.managedNodePreparationStatusPath
    ? [options.managedNodePreparationStatusPath]
    : [
        getManagedNodePackagePreparationStatusPath(projectRoot),
        getHostManagedNodePackagePreparationStatusPath(projectRoot),
      ];
  const failures = {};

  for (const statusPath of statusPaths) {
    try {
      if (!fsModule.existsSync(statusPath)) {
        continue;
      }
      const raw = JSON.parse(fsModule.readFileSync(statusPath, "utf8"));
      const source =
        raw &&
        typeof raw === "object" &&
        raw.failures &&
        typeof raw.failures === "object"
          ? raw.failures
          : {};
      for (const [serverId, failure] of Object.entries(source)) {
        if (!failure || typeof failure !== "object") {
          continue;
        }
        const packageSpec = normalizeText(
          failure.packageSpec || failure.package_spec,
        );
        const baseError = normalizeText(
          failure.error || failure.message,
          "Managed Node MCP package preparation failed",
        );
        const error = packageSpec
          ? `Managed Node MCP package preparation failed for ${serverId} (${packageSpec}): ${baseError}`
          : `Managed Node MCP package preparation failed for ${serverId}: ${baseError}`;
        try {
          failures[serverId] = normalizeStartupFailure({
            serverId,
            operation: "enable",
            stage: "package_preparation",
            source: "managed_node",
            deploymentType:
              failure.deploymentType ||
              failure.deployment_type ||
              raw.deployment_type ||
              "docker",
            error,
            timestamp: failure.timestamp || raw.updatedAt || raw.updated_at,
            errorCode: "MANAGED_NODE_PACKAGE_PREPARATION_FAILED",
          });
        } catch {
          // Ignore malformed entries. Package-prep status must never break
          // health rendering.
        }
      }
    } catch (error) {
      if (options.logger?.warn) {
        options.logger.warn(
          `[MCP Startup Failure] Could not read managed Node preparation status ${statusPath}: ${error.message}`,
        );
      }
    }
  }
  return failures;
}

function writeStartupFailures(projectRoot, failures, options = {}) {
  const fsModule = options.fsModule || fs;
  const failurePath =
    options.failurePath || getStartupFailuresPath(projectRoot);
  const normalized = parseStartupFailures(failures || {});

  fsModule.mkdirSync(path.dirname(failurePath), { recursive: true });
  fsModule.writeFileSync(
    failurePath,
    JSON.stringify(
      {
        version: 1,
        updatedAt: new Date().toISOString(),
        failures: normalized,
      },
      null,
      2,
    ),
    "utf8",
  );
  return normalized;
}

function normalizeKnownServerIds(knownServerIds) {
  if (!knownServerIds) {
    return null;
  }
  const ids = Array.isArray(knownServerIds)
    ? knownServerIds
    : knownServerIds instanceof Set
      ? [...knownServerIds]
      : Object.keys(knownServerIds);
  return new Set(
    ids
      .map((serverId) => normalizeText(serverId))
      .filter(Boolean),
  );
}

function discoverInstalledMcpServerIds(projectRoot, options = {}) {
  const fsModule = options.fsModule || fs;
  const ids = new Set();

  if (!projectRoot || typeof projectRoot !== "string") {
    return ids;
  }

  for (const configDirName of MCP_CONFIG_DIRS) {
    const configDir = path.join(projectRoot, configDirName);
    let entries = [];
    try {
      entries = fsModule.readdirSync(configDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }
      const serverId = entry.name;
      const serverDir = path.join(configDir, serverId);
      const yamlPath = path.join(serverDir, `${serverId}.yaml`);
      const fragmentPath = path.join(serverDir, `${serverId}.fragment`);
      try {
        if (
          fsModule.existsSync(yamlPath) ||
          fsModule.existsSync(fragmentPath)
        ) {
          ids.add(serverId);
        }
      } catch {
        // Keep catalog discovery best-effort. Failure to stat one server should
        // not prevent pruning other known-deleted startup failures.
      }
    }
  }

  return ids;
}

function getKnownServerIds(projectRoot, options = {}) {
  const injected = normalizeKnownServerIds(options.knownServerIds);
  if (injected) {
    return injected;
  }
  if (options.discoverKnownServerIds === false) {
    return null;
  }
  return discoverInstalledMcpServerIds(projectRoot, options);
}

function isInstalledMcpServerId(projectRoot, serverId, options = {}) {
  const normalizedServerId = normalizeText(serverId);
  if (!normalizedServerId) {
    return false;
  }
  const knownServerIds = getKnownServerIds(projectRoot, options);
  if (!knownServerIds) {
    return false;
  }
  return knownServerIds.has(normalizedServerId);
}

function pruneStartupFailures(projectRoot, serverIds, options = {}) {
  const ids = Array.isArray(serverIds) ? serverIds : [serverIds];
  const normalizedIds = ids
    .map((serverId) => normalizeText(serverId))
    .filter(Boolean);
  if (normalizedIds.length === 0) {
    return false;
  }

  const failures = loadStartupFailures(projectRoot, options);
  let changed = false;
  for (const serverId of normalizedIds) {
    if (Object.prototype.hasOwnProperty.call(failures, serverId)) {
      delete failures[serverId];
      changed = true;
    }
  }

  if (changed) {
    writeStartupFailures(projectRoot, failures, options);
  }
  return changed;
}

function recordStartupFailure(projectRoot, failure, options = {}) {
  const normalized = normalizeStartupFailure(failure);
  const failures = loadStartupFailures(projectRoot, options);
  failures[normalized.serverId] = normalized;
  writeStartupFailures(projectRoot, failures, options);
  return normalized;
}

function clearStartupFailure(projectRoot, serverId, options = {}) {
  const normalizedServerId = normalizeText(serverId);
  if (!normalizedServerId) {
    return false;
  }
  const failures = loadStartupFailures(projectRoot, options);
  if (!Object.prototype.hasOwnProperty.call(failures, normalizedServerId)) {
    return false;
  }
  delete failures[normalizedServerId];
  writeStartupFailures(projectRoot, failures, options);
  return true;
}

function clearStartupFailures(projectRoot, serverIds, options = {}) {
  const ids = Array.isArray(serverIds) ? serverIds : [serverIds];
  const failures = loadStartupFailures(projectRoot, options);
  let changed = false;
  ids.forEach((serverId) => {
    const normalizedServerId = normalizeText(serverId);
    if (
      normalizedServerId &&
      Object.prototype.hasOwnProperty.call(failures, normalizedServerId)
    ) {
      delete failures[normalizedServerId];
      changed = true;
    }
  });
  if (changed) {
    writeStartupFailures(projectRoot, failures, options);
  }
  return changed;
}

function buildHealthSummary(servers = {}) {
  const summary = { total: 0 };
  SUMMARY_KEYS.forEach((key) => {
    summary[key] = 0;
  });

  for (const serverInfo of Object.values(servers)) {
    if (!serverInfo || typeof serverInfo !== "object") {
      continue;
    }
    summary.total += 1;
    const status = String(serverInfo.status || "unknown").toLowerCase();
    if (Object.prototype.hasOwnProperty.call(summary, status)) {
      summary[status] += 1;
    } else {
      summary.unknown += 1;
    }
  }

  return summary;
}

function isExplicitlyDisabledHealth(serverInfo) {
  if (!serverInfo || typeof serverInfo !== "object") {
    return false;
  }
  return (
    serverInfo.disabled_by_user === true ||
    String(serverInfo.status || "").toLowerCase() === "disabled"
  );
}

function isHealthyServerInfo(serverInfo) {
  if (!serverInfo || typeof serverInfo !== "object") {
    return false;
  }
  const status = String(serverInfo.status || "").toLowerCase();
  return (
    serverInfo.healthy === true ||
    serverInfo.running === true ||
    status === "healthy" ||
    status === "running"
  );
}

function getGeneratedNotConfiguredStartupFailurePruneStatus(
  projectRoot,
  serverId,
  failure,
  options = {},
) {
  if (!failure || typeof failure !== "object") {
    return null;
  }
  const generatedStatus = getGeneratedMcpConfigStatusForServer(
    projectRoot,
    serverId,
    { logger: options.logger },
  );
  return isRuntimeFileNotConfiguredStatus(generatedStatus)
    ? generatedStatus
    : null;
}

function overlayStartupFailures(healthStatus, projectRoot, options = {}) {
  if (!healthStatus || typeof healthStatus !== "object") {
    return healthStatus;
  }
  const persistedFailures =
    options.failures && typeof options.failures === "object"
      ? parseStartupFailures(options.failures)
      : loadStartupFailures(projectRoot, options);
  const managedNodeFailures =
    options.managedNodePreparationFailures &&
    typeof options.managedNodePreparationFailures === "object"
      ? parseStartupFailures(options.managedNodePreparationFailures)
      : loadManagedNodePackagePreparationFailures(projectRoot, options);
  const failures = {
    ...persistedFailures,
    ...managedNodeFailures,
  };

  if (Object.keys(failures).length === 0) {
    return healthStatus;
  }

  const knownServerIds = getKnownServerIds(projectRoot, options);
  const filteredFailures = {};
  const prunedServerIds = [];
  const runtimeFilePrunedStatuses = {};
  for (const [serverId, failure] of Object.entries(failures)) {
    if (knownServerIds && !knownServerIds.has(serverId)) {
      prunedServerIds.push(serverId);
      continue;
    }
    if (
      failure.errorCode === "MANAGED_NODE_PACKAGE_PREPARATION_FAILED" &&
      isHealthyServerInfo(healthStatus.servers?.[serverId])
    ) {
      continue;
    }
    const runtimeFileStatus = getGeneratedNotConfiguredStartupFailurePruneStatus(
      projectRoot,
      serverId,
      failure,
      options,
    );
    if (runtimeFileStatus) {
      prunedServerIds.push(serverId);
      runtimeFilePrunedStatuses[serverId] = runtimeFileStatus;
      continue;
    }
    filteredFailures[serverId] = failure;
  }

  if (
    prunedServerIds.length > 0 &&
    options.pruneUnknown !== false &&
    !options.failures
  ) {
    pruneStartupFailures(projectRoot, prunedServerIds, options);
    if (options.logger?.warn) {
      options.logger.warn(
        `[MCP Startup Failure] Pruned stale failure(s): ${prunedServerIds.join(", ")}`,
      );
    }
  }

  if (Object.keys(filteredFailures).length === 0) {
    const servers = {
      ...(healthStatus.servers || {}),
    };
    for (const [serverId, runtimeFileStatus] of Object.entries(
      runtimeFilePrunedStatuses,
    )) {
      const existing = servers[serverId] || {};
      servers[serverId] = {
        ...existing,
        status: "not_configured",
        healthy: false,
        running: false,
        host: null,
        port: null,
        configured: false,
        error: runtimeFileStatus.error || "Missing runtime file",
        error_code: runtimeFileStatus.errorCode || null,
        configuration_source: runtimeFileStatus.source || null,
        configuration_stage: runtimeFileStatus.stage || null,
        disabled_by_user: false,
        disabled_reason: null,
      };
      delete servers[serverId].startup_failure;
      delete servers[serverId].startup_failure_source;
      delete servers[serverId].startup_failure_stage;
      delete servers[serverId].startup_failure_timestamp;
      delete servers[serverId].container_name;
      delete servers[serverId].config_path;
    }
    return {
      ...healthStatus,
      servers,
      startup_failures: {},
      summary: {
        ...(healthStatus.summary || {}),
        ...buildHealthSummary(servers),
      },
    };
  }

  const nextHealthStatus = {
    ...healthStatus,
    servers: {
      ...(healthStatus.servers || {}),
    },
    startup_failures: filteredFailures,
  };

  for (const [serverId, runtimeFileStatus] of Object.entries(
    runtimeFilePrunedStatuses,
  )) {
    const existing = nextHealthStatus.servers[serverId] || {};
    nextHealthStatus.servers[serverId] = {
      ...existing,
      status: "not_configured",
      healthy: false,
      running: false,
      host: null,
      port: null,
      configured: false,
      error: runtimeFileStatus.error || "Missing runtime file",
      error_code: runtimeFileStatus.errorCode || null,
      configuration_source: runtimeFileStatus.source || null,
      configuration_stage: runtimeFileStatus.stage || null,
      disabled_by_user: false,
      disabled_reason: null,
    };
    delete nextHealthStatus.servers[serverId].startup_failure;
    delete nextHealthStatus.servers[serverId].startup_failure_source;
    delete nextHealthStatus.servers[serverId].startup_failure_stage;
    delete nextHealthStatus.servers[serverId].startup_failure_timestamp;
    delete nextHealthStatus.servers[serverId].container_name;
    delete nextHealthStatus.servers[serverId].config_path;
  }

  for (const [serverId, failure] of Object.entries(filteredFailures)) {
    const existing = nextHealthStatus.servers[serverId] || {};
    nextHealthStatus.servers[serverId] = {
      ...existing,
      status: failure.stage === "timeout" ? "timeout" : "failed",
      healthy: false,
      running: false,
      host: null,
      port: null,
      configured: true,
      error: failure.error,
      disabled_by_user: false,
      disabled_reason: null,
      deployment:
        failure.deploymentType || existing.deployment || existing.deploymentType,
      startup_failure: failure,
      startup_failure_source: failure.source,
      startup_failure_stage: failure.stage,
      startup_failure_timestamp: failure.timestamp,
      ...(failure.containerName ? { container_name: failure.containerName } : {}),
      ...(failure.configPath ? { config_path: failure.configPath } : {}),
    };
  }

  nextHealthStatus.summary = {
    ...(healthStatus.summary || {}),
    ...buildHealthSummary(nextHealthStatus.servers),
  };
  return nextHealthStatus;
}

module.exports = {
  MANAGED_NODE_PACKAGE_PREPARATION_FILENAME,
  STARTUP_FAILURES_FILENAME,
  buildHealthSummary,
  clearStartupFailure,
  clearStartupFailures,
  discoverInstalledMcpServerIds,
  getManagedNodePackagePreparationStatusPath,
  getStartupFailuresPath,
  isInstalledMcpServerId,
  isExplicitlyDisabledHealth,
  loadManagedNodePackagePreparationFailures,
  loadStartupFailures,
  normalizeStartupFailure,
  overlayStartupFailures,
  pruneStartupFailures,
  recordStartupFailure,
  writeStartupFailures,
};
