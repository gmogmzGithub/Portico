const path = require("path");
const { buildUpContainerCommand } = require("./docker-compose-command");
const {
  buildMcpOrcGeneratorCommand,
  ensureMcpOrcGeneratorCommand,
} = require("./mcp-orc-cli");

const DEFAULT_CONTROL_PLANE_CONTAINER = "mcpo";
const DEFAULT_SUPERVISOR_SOCKET = "unix:///tmp/supervisor.sock";
const DEFAULT_CONTROL_PLANE_PROGRAMS = [
  "aggregator-regular",
  "aggregator-core",
];
const DEFAULT_CONTROL_PLANE_READY_TIMEOUT_MS = 15000;
const DEFAULT_CONTROL_PLANE_READY_POLL_INTERVAL_MS = 500;
const DEFAULT_CONTROL_PLANE_REQUEST_TIMEOUT_MS = 2000;
let pendingInfraRegeneration = null;
let pendingInfraRegenerationKey = null;
let pendingControlPlaneRefresh = Promise.resolve();

function getSleep(options = {}) {
  if (typeof options.sleep === "function") {
    return options.sleep;
  }

  return (delayMs) =>
    new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs)));
}

async function fetchWithTimeout(
  fetchImpl,
  url,
  requestOptions = {},
  timeoutMs = DEFAULT_CONTROL_PLANE_REQUEST_TIMEOUT_MS,
) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl (function) is required");
  }

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fetchImpl(url, requestOptions);
  }

  const controller = new AbortController();
  let timeoutHandle = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      const timeoutError = new Error(`request timeout after ${timeoutMs}ms`);
      timeoutError.name = "AbortError";
      reject(timeoutError);
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      fetchImpl(url, {
        ...requestOptions,
        signal: requestOptions.signal || controller.signal,
      }),
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function enqueueControlPlaneRefresh(task) {
  const refreshPromise = pendingControlPlaneRefresh
    .catch(() => undefined)
    .then(task);
  pendingControlPlaneRefresh = refreshPromise.then(
    () => undefined,
    () => undefined,
  );
  return refreshPromise;
}

function getControlPlanePrograms(options = {}) {
  if (Array.isArray(options.programs) && options.programs.length > 0) {
    return options.programs;
  }

  const includeRegular = options.includeRegular !== false;
  const includeCore = options.includeCore !== false;
  if (includeRegular && includeCore) {
    return [...DEFAULT_CONTROL_PLANE_PROGRAMS];
  }
  const programs = [];

  if (includeRegular) {
    programs.push("aggregator-regular");
  }
  if (includeCore) {
    programs.push("aggregator-core");
  }

  return programs;
}

function getMcpInfraRegenerationCommand(projectRoot, options = {}) {
  if (!projectRoot || typeof projectRoot !== "string") {
    throw new TypeError("projectRoot (string) is required");
  }

  return buildMcpOrcGeneratorCommand(
    projectRoot,
    "generate-docker-compose-override",
    {
      force: options.force === true,
      isPackagedApp: options.isPackagedApp,
      resourcesPath: options.resourcesPath,
      env: options.env,
    },
  );
}

function getMcpInfraRegenerationKey(projectRoot, options = {}) {
  return JSON.stringify({
    projectRoot,
    force: options.force === true,
    isPackagedApp:
      typeof options.isPackagedApp === "boolean"
        ? options.isPackagedApp
        : null,
    timeout: options.timeout ?? 60000,
  });
}

async function regenerateMcpInfrastructure(
  execAsync,
  projectRoot,
  env,
  options = {},
) {
  if (typeof execAsync !== "function") {
    throw new TypeError("execAsync (function) is required");
  }

  const regenerationKey = getMcpInfraRegenerationKey(projectRoot, options);
  if (
    pendingInfraRegeneration &&
    pendingInfraRegenerationKey === regenerationKey
  ) {
    return pendingInfraRegeneration;
  }

  const regenerationPromise = (async () => {
    const command = await ensureMcpOrcGeneratorCommand(
      projectRoot,
      "generate-docker-compose-override",
      {
        force: options.force === true,
        isPackagedApp: options.isPackagedApp,
        resourcesPath: options.resourcesPath,
        env,
        execAsync,
        bootstrapTimeoutMs: options.bootstrapTimeoutMs,
      },
    );

    return execAsync(command, {
      cwd: projectRoot,
      env,
      timeout: options.timeout ?? 60000,
    });
  })();

  pendingInfraRegeneration = regenerationPromise;
  pendingInfraRegenerationKey = regenerationKey;

  try {
    return await regenerationPromise;
  } finally {
    if (pendingInfraRegeneration === regenerationPromise) {
      pendingInfraRegeneration = null;
      pendingInfraRegenerationKey = null;
    }
  }
}

function getMcpControlPlaneRefreshCommand(options = {}) {
  const controlPlaneContainer =
    options.controlPlaneContainer || DEFAULT_CONTROL_PLANE_CONTAINER;
  const supervisorSocket =
    options.supervisorSocket || DEFAULT_SUPERVISOR_SOCKET;
  const programs = getControlPlanePrograms(options);

  if (
    !controlPlaneContainer ||
    typeof controlPlaneContainer !== "string"
  ) {
    throw new TypeError("controlPlaneContainer (string) is required");
  }

  if (!supervisorSocket || typeof supervisorSocket !== "string") {
    throw new TypeError("supervisorSocket (string) is required");
  }

  const normalizedPrograms = programs
    .filter((program) => typeof program === "string" && program.trim())
    .map((program) => program.trim());

  if (normalizedPrograms.length === 0) {
    throw new TypeError("programs (string[]) must include at least one entry");
  }

  return `docker exec ${controlPlaneContainer} supervisorctl -s ${supervisorSocket} restart ${normalizedPrograms.join(" ")}`;
}

function getMcpControlPlaneNginxReloadCommand(options = {}) {
  const controlPlaneContainer =
    options.controlPlaneContainer || DEFAULT_CONTROL_PLANE_CONTAINER;

  if (
    !controlPlaneContainer ||
    typeof controlPlaneContainer !== "string"
  ) {
    throw new TypeError("controlPlaneContainer (string) is required");
  }

  return `docker exec ${controlPlaneContainer} nginx -s reload`;
}

function getMcpControlPlaneNginxTestCommand(options = {}) {
  const controlPlaneContainer =
    options.controlPlaneContainer || DEFAULT_CONTROL_PLANE_CONTAINER;

  if (!controlPlaneContainer || typeof controlPlaneContainer !== "string") {
    throw new TypeError("controlPlaneContainer (string) is required");
  }

  return `docker exec ${controlPlaneContainer} nginx -t`;
}

function getControlPlaneWaitTargets(options = {}) {
  const includeRegular = options.includeRegular !== false;
  const includeCore = options.includeCore !== false;
  const targets = [];
  const serverId =
    typeof options.serverId === "string" && options.serverId.trim()
      ? encodeURIComponent(options.serverId.trim())
      : null;

  if (includeRegular) {
    targets.push("http://127.0.0.1:8765/openapi.json");
  }
  if (includeCore) {
    targets.push("http://127.0.0.1:8766/openapi.json");
  }

  const shouldWaitForServerRoute =
    options.serverRouteWait !== "skip";

  // A healthy root aggregator does not guarantee that a freshly regenerated
  // per-server nginx route is active yet. When a single tier is being
  // refreshed for a known server, verify that concrete route as well.
  if (shouldWaitForServerRoute && serverId && includeRegular !== includeCore) {
    const port = includeRegular ? 8765 : 8766;
    targets.push(`http://127.0.0.1:${port}/${serverId}/openapi.json`);
  }

  return targets;
}

async function waitForControlPlaneReady(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return { success: true, targets: [] };
  }

  const targets = getControlPlaneWaitTargets(options);
  if (targets.length === 0) {
    return { success: true, targets: [] };
  }

  const timeoutMs =
    options.readinessTimeoutMs ?? DEFAULT_CONTROL_PLANE_READY_TIMEOUT_MS;
  const pollIntervalMs =
    options.pollIntervalMs ?? DEFAULT_CONTROL_PLANE_READY_POLL_INTERVAL_MS;
  const requestTimeoutMs =
    options.readinessRequestTimeoutMs ??
    options.fetchTimeoutMs ??
    DEFAULT_CONTROL_PLANE_REQUEST_TIMEOUT_MS;
  const sleep = getSleep(options);
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(targets);

  while (pending.size > 0) {
    await Promise.all(
      [...pending].map(async (target) => {
        try {
          const response = await fetchWithTimeout(
            fetchImpl,
            target,
            {
              method: "GET",
              cache: "no-store",
            },
            requestTimeoutMs,
          );
          if (response?.ok) {
            pending.delete(target);
          }
        } catch (_error) {
          // Keep polling until timeout. The caller decides whether readiness is fatal.
        }
      }),
    );

    if (pending.size === 0) {
      return { success: true, targets };
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Control-plane readiness timeout waiting for ${Array.from(pending).join(", ")}`,
      );
    }

    await sleep(pollIntervalMs);
  }

  return { success: true, targets };
}

async function refreshMcpControlPlane(
  execAsync,
  projectRoot,
  env,
  options = {},
) {
  if (typeof execAsync !== "function") {
    throw new TypeError("execAsync (function) is required");
  }

  return enqueueControlPlaneRefresh(async () => {
    const controlPlaneContainer =
      options.controlPlaneContainer || DEFAULT_CONTROL_PLANE_CONTAINER;
    const scriptPath =
      options.dockerComposeScriptPath ||
      path.join(projectRoot, "src/scripts/docker-compose.sh");
    const logger = options.logger || console;
    const invalidateReason =
      options.invalidateReason || options.reason || "control-plane-refresh";
    const waitTargets = getControlPlaneWaitTargets(options);
    const shouldReloadNginx = waitTargets.length > 0;
    let invalidationResult = { success: true, results: [] };

    try {
      if (options.skipCacheInvalidation !== true) {
        invalidationResult = await invalidateMcpAggregatorCaches({
          fetchImpl: options.fetchImpl,
          logger,
          reason: invalidateReason,
          serverId: options.serverId || null,
          serverIds: options.serverIds || [],
          includeRegular: options.includeRegular !== false,
          includeCore: options.includeCore !== false,
          invalidationTimeoutMs: options.invalidationTimeoutMs,
          fetchTimeoutMs: options.fetchTimeoutMs,
        });
        if (!invalidationResult.success) {
          logger.warn(
            `[MCP] Aggregator cache invalidation failed for ${controlPlaneContainer}; continuing with control-plane refresh.`,
          );
        }
      }

      if (shouldReloadNginx) {
        const maxNginxRetries = options.nginxReloadRetries ?? 3;
        const nginxRetryDelayMs = options.nginxRetryDelayMs ?? 2000;
        const sleep = getSleep(options);
        let configValid = false;

        for (let attempt = 1; attempt <= maxNginxRetries; attempt++) {
          try {
            await execAsync(getMcpControlPlaneNginxTestCommand(options), {
              cwd: projectRoot,
              env,
              timeout: 10000,
            });
            configValid = true;
            break;
          } catch (testErr) {
            logger.warn(
              `[MCP] nginx config test failed (attempt ${attempt}/${maxNginxRetries}): ${testErr.message}`,
            );
            if (attempt < maxNginxRetries) {
              await sleep(nginxRetryDelayMs);
            }
          }
        }

        if (configValid) {
          await execAsync(getMcpControlPlaneNginxReloadCommand(options), {
            cwd: projectRoot,
            env,
            timeout: options.timeout ?? 30000,
          });
        } else {
          throw new Error("nginx config test failed after all retries");
        }
      }

      await waitForControlPlaneReady(options);
      return {
        success: true,
        mode: shouldReloadNginx ? "nginx-reload" : "cache-invalidation",
        cacheInvalidation: invalidationResult,
      };
    } catch (error) {
      logger.warn(
        `[MCP] Control-plane cache refresh failed for ${controlPlaneContainer}: ${error.message}. Falling back to process refresh.`,
      );
      try {
        const programs = getControlPlanePrograms(options);
        if (programs.length > 0) {
          await execAsync(getMcpControlPlaneRefreshCommand(options), {
            cwd: projectRoot,
            env,
            timeout: options.timeout ?? 30000,
          });
        }

        await waitForControlPlaneReady(options);
        return {
          success: true,
          mode: "process-refresh",
          cacheInvalidation: invalidationResult,
        };
      } catch (refreshError) {
        logger.warn(
          `[MCP] Control-plane program refresh failed for ${controlPlaneContainer}: ${refreshError.message}. Falling back to container recreate.`,
        );
        await execAsync(
          buildUpContainerCommand(scriptPath, controlPlaneContainer, {
            noDeps: true,
          }),
          {
            cwd: projectRoot,
            env,
            timeout: options.fallbackTimeout ?? 60000,
          },
        );
        await waitForControlPlaneReady(options);
        return {
          success: true,
          mode: "container-recreate",
          cacheInvalidation: invalidationResult,
        };
      }
    }
  });
}

async function invalidateMcpAggregatorCaches(options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    logger = console,
    reason = "manual",
    serverId = null,
    serverIds = [],
    includeRegular = true,
    includeCore = true,
    invalidationTimeoutMs,
    fetchTimeoutMs,
  } = options;

  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl (function) is required");
  }

  const normalizedServerIds = [...new Set(
    [
      ...(Array.isArray(serverIds) ? serverIds : []),
      ...(serverId ? [serverId] : []),
    ]
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  )];
  const payload = JSON.stringify({
    reason,
    server_id:
      normalizedServerIds.length === 1 ? normalizedServerIds[0] : serverId,
    server_ids: normalizedServerIds,
  });

  const targets = [];
  if (includeRegular) {
    targets.push("http://127.0.0.1:8765/internal/cache/invalidate");
  }
  if (includeCore) {
    targets.push("http://127.0.0.1:8766/internal/cache/invalidate");
  }

  const requestTimeoutMs =
    invalidationTimeoutMs ??
    fetchTimeoutMs ??
    DEFAULT_CONTROL_PLANE_REQUEST_TIMEOUT_MS;
  const results = await Promise.all(
    targets.map(async (url) => {
      try {
        const response = await fetchWithTimeout(
          fetchImpl,
          url,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: payload,
          },
          requestTimeoutMs,
        );

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        return { url, success: true };
      } catch (error) {
        logger.warn(
          `[MCP] Aggregator cache invalidation failed for ${url}: ${error.message}`,
        );
        return { url, success: false, error: error.message };
      }
    }),
  );

  return {
    success: results.every((result) => result.success),
    results,
  };
}

module.exports = {
  getControlPlanePrograms,
  getMcpControlPlaneNginxReloadCommand,
  getMcpControlPlaneRefreshCommand,
  getControlPlaneWaitTargets,
  getMcpInfraRegenerationCommand,
  invalidateMcpAggregatorCaches,
  refreshMcpControlPlane,
  getMcpControlPlaneNginxTestCommand,
  regenerateMcpInfrastructure,
  waitForControlPlaneReady,
};
