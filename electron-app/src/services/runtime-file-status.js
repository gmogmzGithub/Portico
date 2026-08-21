const fs = require("node:fs");
const path = require("node:path");

const RUNTIME_FILE_STATUS_RELATIVE_PATH = path.join(
  "mcpo-configs-generated",
  "runtime-file-status.json",
);
const SERVER_CONFIG_STATUS_RELATIVE_PATH = path.join(
  "mcpo-configs-generated",
  "server-config-status.json",
);

function getRuntimeFileStatusPath(projectRoot) {
  if (!projectRoot || typeof projectRoot !== "string") {
    throw new TypeError("projectRoot (string) is required");
  }
  return path.join(projectRoot, RUNTIME_FILE_STATUS_RELATIVE_PATH);
}

function getServerConfigStatusPath(projectRoot) {
  if (!projectRoot || typeof projectRoot !== "string") {
    throw new TypeError("projectRoot (string) is required");
  }
  return path.join(projectRoot, SERVER_CONFIG_STATUS_RELATIVE_PATH);
}

function normalizeRuntimeFileStatusEntry(serverId, entry) {
  if (!serverId || !entry || typeof entry !== "object") {
    return null;
  }
  const status = String(entry.status || "").trim().toLowerCase();
  const configured =
    typeof entry.configured === "boolean" ? entry.configured : null;
  const error = String(entry.error || entry.message || "").trim();
  const errorCode = String(entry.errorCode || entry.error_code || "").trim();
  const source = String(entry.source || "").trim();
  const stage = String(entry.stage || "").trim();
  return {
    serverId,
    configured,
    status,
    error: error || null,
    errorCode: errorCode || null,
    source: source || null,
    stage: stage || null,
  };
}

function loadGeneratedStatusesFromPath(statusPath, options = {}, label = "status") {
  const fsModule = options.fsModule || fs;
  if (!fsModule.existsSync(statusPath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(fsModule.readFileSync(statusPath, "utf8"));
    const source =
      parsed?.servers &&
      typeof parsed.servers === "object" &&
      !Array.isArray(parsed.servers)
        ? parsed.servers
        : {};
    const statuses = {};
    for (const [serverId, entry] of Object.entries(source)) {
      const normalized = normalizeRuntimeFileStatusEntry(serverId, entry);
      if (normalized) {
        statuses[serverId] = normalized;
      }
    }
    return statuses;
  } catch (error) {
    if (options.logger?.warn) {
      options.logger.warn(
        `[MCP Configuration] Could not read ${label} artifact: ${error.message}`,
      );
    }
    return {};
  }
}

function loadRuntimeFileStatuses(projectRoot, options = {}) {
  let statusPath;
  try {
    statusPath = options.statusPath || getRuntimeFileStatusPath(projectRoot);
  } catch (_error) {
    return {};
  }
  return loadGeneratedStatusesFromPath(statusPath, options, "runtime file status");
}

function loadServerConfigStatuses(projectRoot, options = {}) {
  let statusPath;
  try {
    statusPath =
      options.serverConfigStatusPath || getServerConfigStatusPath(projectRoot);
  } catch (_error) {
    return {};
  }
  return loadGeneratedStatusesFromPath(statusPath, options, "server config status");
}

function getRuntimeFileStatusForServer(projectRoot, serverId, options = {}) {
  const normalizedServerId = String(serverId || "").trim();
  if (!normalizedServerId) {
    return null;
  }
  return loadRuntimeFileStatuses(projectRoot, options)[normalizedServerId] || null;
}

function getGeneratedMcpConfigStatusForServer(
  projectRoot,
  serverId,
  options = {},
) {
  const normalizedServerId = String(serverId || "").trim();
  if (!normalizedServerId) {
    return null;
  }
  const serverConfigStatus =
    loadServerConfigStatuses(projectRoot, options)[normalizedServerId] || null;
  if (serverConfigStatus) {
    return serverConfigStatus;
  }
  const runtimeStatus =
    loadRuntimeFileStatuses(projectRoot, options)[normalizedServerId] || null;
  return runtimeStatus;
}

function isRuntimeFileNotConfiguredStatus(status) {
  if (!status || typeof status !== "object") {
    return false;
  }
  return status.configured === false || status.status === "not_configured";
}

module.exports = {
  RUNTIME_FILE_STATUS_RELATIVE_PATH,
  SERVER_CONFIG_STATUS_RELATIVE_PATH,
  getGeneratedMcpConfigStatusForServer,
  getRuntimeFileStatusForServer,
  getRuntimeFileStatusPath,
  getServerConfigStatusPath,
  isRuntimeFileNotConfiguredStatus,
  loadRuntimeFileStatuses,
  loadServerConfigStatuses,
};
