const path = require("path");
const { isInstalledMcpServerId } = require("./mcp-startup-failures");

const DEFAULT_LOG_LINES = 200;
const MAX_LOG_LINES = 1000;

function clampLogLines(lines) {
  const parsed = Number.parseInt(lines, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_LOG_LINES;
  }
  return Math.min(Math.max(parsed, 1), MAX_LOG_LINES);
}

function clampSinceSeconds(sinceSeconds) {
  const parsed = Number.parseInt(sinceSeconds, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.min(parsed, 24 * 60 * 60);
}

async function dockerLogsForContainer(containerName, lines, deps = {}) {
  const execPromise = deps.execPromise || require("./bootstrap").execPromise;
  const projectRoot = deps.projectRoot || require("./bootstrap").PROJECT_ROOT;
  const sinceFlag = deps.sinceSeconds ? ` --since ${deps.sinceSeconds}s` : "";
  // 2>&1 makes docker interleave the container's stdout and stderr in
  // record order. Capturing the streams separately and concatenating them
  // rendered two disjoint time-sorted chunks in the log viewer whenever a
  // container runs two processes that log to different streams (mcp-orc on
  // stderr, the MCP subprocess on stdout).
  const { stdout, stderr } = await execPromise(
    `docker logs ${containerName} --tail ${lines}${sinceFlag} 2>&1`,
    {
      cwd: projectRoot,
      timeout: 10000,
    },
  );
  return mergeProcessOutput(stdout, stderr);
}

function mergeProcessOutput(stdout, stderr) {
  return [stdout, stderr]
    .filter((value) => typeof value === "string" && value.length > 0)
    .join("");
}

function collectProcessFailureOutput(error) {
  return [error?.stdout, error?.stderr, error?.message]
    .filter((value) => typeof value === "string" && value.length > 0)
    .join("\n");
}

function isContainerNotCreatedFailure(output) {
  return /(?:error response from daemon:\s*)?no such container:/i.test(
    String(output || ""),
  );
}

function formatHostLogEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return "";
  }

  return entries
    .map((entry) => (entry === undefined || entry === null ? "" : String(entry)))
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.endsWith("\n") ? entry : `${entry}\n`))
    .join("");
}

async function composeLogsForService(composeService, lines, deps = {}) {
  const execPromise = deps.execPromise || require("./bootstrap").execPromise;
  const projectRoot = deps.projectRoot || require("./bootstrap").PROJECT_ROOT;
  const scriptsDir =
    deps.scriptsDir ||
    require("./bootstrap").SCRIPTS_DIR ||
    path.join(projectRoot, "src", "scripts");
  const dockerComposeScript = path.join(scriptsDir, "docker-compose.sh");
  const { stdout, stderr } = await execPromise(
    `bash "${dockerComposeScript}" logs ${composeService} ${lines} 2>&1`,
    {
      cwd: projectRoot,
      timeout: 15000,
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  return mergeProcessOutput(stdout, stderr);
}

async function getMcpServerLogs(serverId, options = {}) {
  const lines = clampLogLines(options.lines);
  const deps = {
    sinceSeconds: clampSinceSeconds(options.sinceSeconds),
    execPromise: options.execPromise || require("./bootstrap").execPromise,
    projectRoot: options.projectRoot || require("./bootstrap").PROJECT_ROOT,
    scriptsDir: options.scriptsDir || null,
    getConfiguredMcpoRuntimeTarget:
      options.getConfiguredMcpoRuntimeTarget ||
      ((targetServerId) =>
        require("./docker-mcp").getConfiguredMcpoRuntimeTarget(targetServerId)),
    isHostDeployedServer:
      options.isHostDeployedServer ||
      ((targetServerId) => require("./docker-mcp").isHostDeployedServer(targetServerId)),
    getMcpoServerContainerCandidates:
      options.getMcpoServerContainerCandidates ||
      ((targetServerId) =>
        require("./docker-mcp").getMcpoServerContainerCandidates?.(targetServerId) || []),
    isInstalledMcpServerId:
      options.isInstalledMcpServerId ||
      ((projectRoot, targetServerId) =>
        isInstalledMcpServerId(projectRoot, targetServerId, { logger: console })),
    hostLogs: options.hostLogs || require("./shared-state").hostMcpo?.logs || [],
  };

  if (!deps.isInstalledMcpServerId(deps.projectRoot, serverId)) {
    return {
      success: false,
      code: "server_not_found",
      server_id: serverId,
      logs: "",
      log_source: null,
      container_name: null,
      error: "MCP server not found.",
      lines,
    };
  }

  const isHostDeployed = await Promise.resolve(deps.isHostDeployedServer(serverId));
  const runtimeTarget = deps.getConfiguredMcpoRuntimeTarget(serverId);
  const candidates = [];

  // When the caller is in the single-server/wizard context (interactive setup,
  // OAuth handshake, config "test server"), the container actually doing the
  // work is `mcpo-single-<serverId>`, NOT the steady-state managed container.
  // Try it first so failure diagnostics reflect the wizard container instead of
  // a stale/coincidental managed container. The managed container remains a
  // fallback below in case the wizard stack has already been torn down.
  if (options.preferSingleServer) {
    candidates.push({
      containerName: `mcpo-single-${serverId}`,
      logSource: "single_server_container",
    });
  }

  if (runtimeTarget?.containerName) {
    candidates.push({
      containerName: runtimeTarget.containerName,
      logSource: "managed_container",
    });
  }

  const containerCandidates =
    typeof deps.getMcpoServerContainerCandidates === "function"
      ? deps.getMcpoServerContainerCandidates(serverId)
      : [];

  for (const containerName of containerCandidates) {
    candidates.push({
      containerName,
      logSource:
        containerName === `mcpo-single-${serverId}`
          ? "single_server_container"
          : "managed_container",
    });
  }

  if (containerCandidates.length === 0 && !isHostDeployed) {
    candidates.push({
      containerName: `mcpo-single-${serverId}`,
      logSource: "single_server_container",
    });
  }

  const dedupedCandidates = [];
  const seenContainerNames = new Set();
  for (const candidate of candidates) {
    if (!candidate.containerName || seenContainerNames.has(candidate.containerName)) {
      continue;
    }
    seenContainerNames.add(candidate.containerName);
    dedupedCandidates.push(candidate);
  }

  let lastError = null;
  let lastCandidate = null;
  const failureOutputs = [];

  for (const candidate of dedupedCandidates) {
    lastCandidate = candidate;
    try {
      const logs = await dockerLogsForContainer(candidate.containerName, lines, deps);
      return {
        success: true,
        server_id: serverId,
        logs,
        log_source: candidate.logSource,
        container_name: candidate.containerName,
        lines,
      };
    } catch (error) {
      lastError = error;
      failureOutputs.push(collectProcessFailureOutput(error));
    }
  }

  if (runtimeTarget?.composeService) {
    lastCandidate = {
      containerName: runtimeTarget.containerName || null,
      logSource:
        runtimeTarget.containerName === `mcpo-single-${serverId}`
          ? "single_server_container"
          : "managed_container",
    };
    try {
      const logs = await composeLogsForService(runtimeTarget.composeService, lines, deps);
      return {
        success: true,
        server_id: serverId,
        logs,
        log_source: lastCandidate.logSource,
        container_name: lastCandidate.containerName,
        lines,
      };
    } catch (error) {
      lastError = error;
      failureOutputs.push(collectProcessFailureOutput(error));
    }
  }

  if (isHostDeployed) {
    return {
      success: true,
      server_id: serverId,
      logs: formatHostLogEntries(deps.hostLogs.slice(-lines)),
      log_source: "host_mcpo",
      container_name: null,
      lines,
    };
  }

  const allFailureText = failureOutputs.filter(Boolean).join("\n");
  if (isContainerNotCreatedFailure(allFailureText)) {
    return {
      success: false,
      code: "container_not_created",
      server_id: serverId,
      logs: allFailureText,
      log_source: lastCandidate?.logSource || null,
      container_name: lastCandidate?.containerName || null,
      error:
        "The container was not created. Review the earlier startup failure for the primary cause.",
      lines,
    };
  }

  const fallbackLogs = mergeProcessOutput(lastError?.stdout, lastError?.stderr);
  if (fallbackLogs) {
    return {
      success: true,
      server_id: serverId,
      logs: fallbackLogs,
      log_source: lastCandidate?.logSource || null,
      container_name: lastCandidate?.containerName || null,
      warning: lastError?.message || null,
      lines,
    };
  }

  return {
    success: false,
    server_id: serverId,
    logs: "",
    log_source: lastCandidate?.logSource || null,
    container_name: lastCandidate?.containerName || null,
    error: lastError?.message || `No log source found for ${serverId}`,
    lines,
  };
}

module.exports = {
  clampLogLines,
  clampSinceSeconds,
  collectProcessFailureOutput,
  formatHostLogEntries,
  getMcpServerLogs,
  isContainerNotCreatedFailure,
};
