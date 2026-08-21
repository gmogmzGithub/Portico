const path = require("node:path");

function normalizeErrorText(error) {
  if (!error) {
    return "";
  }
  if (typeof error === "string") {
    return error;
  }
  return String(error.message || error.error || error);
}

function normalizeServerId(serverId) {
  return String(serverId || "").trim();
}

function buildStartupFailureResult(serverId, error, options = {}) {
  const normalizedServerId = normalizeServerId(serverId);
  const errorText = normalizeErrorText(error) || "Startup failed";
  const startupFailure = {
    serverId: normalizedServerId,
    operation: options.operation || "enable",
    stage: options.stage || "startup",
    error: errorText,
    source: options.source || "runtime",
    timestamp: options.timestamp || new Date().toISOString(),
    ...(options.deploymentType ? { deploymentType: options.deploymentType } : {}),
    ...(options.containerName ? { containerName: options.containerName } : {}),
    ...(options.configPath ? { configPath: options.configPath } : {}),
    ...(options.errorCode ? { errorCode: options.errorCode } : {}),
  };

  return {
    serverId: normalizedServerId,
    success: false,
    error: errorText,
    errorCode: options.errorCode || null,
    stage: startupFailure.stage,
    source: startupFailure.source,
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.configPath ? { configPath: options.configPath } : {}),
    startupFailure,
  };
}

function extractServerIdFromPath(errorText, projectRoot) {
  const text = normalizeErrorText(errorText);
  if (!text) {
    return null;
  }

  const escapedRoot = projectRoot
    ? String(projectRoot).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    : "";
  const pathPrefix = escapedRoot
    ? `${escapedRoot}(?:/|\\\\)`
    : "";
  const configPathPattern = new RegExp(
    `(${pathPrefix}(?:mcp-configs|mcp-configs-user)(?:/|\\\\)([^\\s:'"]+)(?:/|\\\\)[^\\s:'"]+)`,
  );
  const match = text.match(configPathPattern);
  if (!match) {
    return null;
  }

  return {
    serverId: match[2],
    configPath: match[1],
  };
}

function extractServerIdFromInvalidFragment(errorText) {
  const text = normalizeErrorText(errorText);
  const match = text.match(/Invalid JSON in fragment for\s+([A-Za-z0-9_.-]+)/i);
  return match ? { serverId: match[1], configPath: null } : null;
}

function extractAttributedServerFailure(error, projectRoot) {
  const errorText = normalizeErrorText(error);
  if (!errorText) {
    return null;
  }

  const directMatch = extractServerIdFromInvalidFragment(errorText);
  const pathMatch = extractServerIdFromPath(errorText, projectRoot);
  const serverId = directMatch?.serverId || pathMatch?.serverId || null;
  if (!serverId) {
    return null;
  }

  return {
    serverId,
    error: errorText,
    configPath: pathMatch?.configPath || directMatch?.configPath || null,
  };
}

function ensureBulkResultsForRequested(serverIds, results = [], options = {}) {
  const requestedIds = Array.isArray(serverIds)
    ? serverIds.map(normalizeServerId).filter(Boolean)
    : [];
  const nextResults = Array.isArray(results) ? [...results] : [];
  const existing = new Set(
    nextResults
      .map((entry) => normalizeServerId(entry?.serverId))
      .filter(Boolean),
  );

  requestedIds.forEach((serverId) => {
    if (existing.has(serverId)) {
      return;
    }
    nextResults.push(
      buildStartupFailureResult(serverId, options.error || "Startup failed", {
        stage: options.stage || "startup",
        source: options.source || "runtime",
        operation: options.operation || "enable",
        errorCode: options.errorCode || null,
        deploymentType: options.deploymentType || null,
        mode: options.mode || null,
      }),
    );
    existing.add(serverId);
  });

  return nextResults;
}

function getFragmentPathForServerYaml(yamlPath, serverId) {
  if (!yamlPath || !serverId) {
    return null;
  }
  return path.join(path.dirname(yamlPath), `${serverId}.fragment`);
}

module.exports = {
  buildStartupFailureResult,
  ensureBulkResultsForRequested,
  extractAttributedServerFailure,
  extractServerIdFromPath,
  getFragmentPathForServerYaml,
  normalizeErrorText,
};
