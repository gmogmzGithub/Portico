const fsPromises = require("fs").promises;
const path = require("path");

const { buildForceRemoveContainerCommand } = require("./docker-compose-command");

async function pathExists(targetPath, deps = {}) {
  const fsApi = deps.fsPromises || fsPromises;
  try {
    await fsApi.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function countFilesRecursive(targetPath, deps = {}) {
  const fsApi = deps.fsPromises || fsPromises;
  const stat = await fsApi.stat(targetPath);
  if (!stat.isDirectory()) {
    return 1;
  }

  let fileCount = 0;
  const entries = await fsApi.readdir(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      fileCount += await countFilesRecursive(entryPath, { fsPromises: fsApi });
    } else {
      fileCount += 1;
    }
  }
  return fileCount;
}

function defaultLogger() {
  return console;
}

async function deleteUserMcpServer(serverId, options = {}) {
  if (!serverId || typeof serverId !== "string") {
    throw new TypeError("serverId (string) is required");
  }

  const logger = options.logger || defaultLogger();
  const projectRoot =
    options.projectRoot || require("./bootstrap").PROJECT_ROOT;
  const deps = {
    fsPromises: options.fsPromises || fsPromises,
    mutateToggles: options.mutateToggles,
    isCoreServer: options.isCoreServer,
    isHostDeployedServer: options.isHostDeployedServer,
    getConfiguredMcpoRuntimeTarget: options.getConfiguredMcpoRuntimeTarget,
    getMcpoServerContainerCandidates: options.getMcpoServerContainerCandidates,
    executeWithStreaming: options.executeWithStreaming,
    regenerateMcpInfrastructure: options.regenerateMcpInfrastructure,
    refreshMcpControlPlane: options.refreshMcpControlPlane,
    restartHostMcpoWithFreshConfig: options.restartHostMcpoWithFreshConfig,
    stopHostMcpo: options.stopHostMcpo,
    startHostMcpo: options.startHostMcpo,
    queueFullHealthCheck: options.queueFullHealthCheck,
    execAsync: options.execAsync,
    clearRuntimeState: options.clearRuntimeState,
    env: options.env || process.env,
    isPackagedApp:
      Object.prototype.hasOwnProperty.call(options, "isPackagedApp")
        ? options.isPackagedApp
        : require("electron").app.isPackaged,
    broadcastToggleState:
      options.broadcastToggleState ||
      (() => undefined),
  };

  const dockerMcp = () => require("./docker-mcp");
  const infra = () => require("./mcp-infra-regeneration");
  const hostLifecycle = () => require("./host-mcp-lifecycle");
  const startupFailures = () => require("./mcp-startup-failures");

  const isCoreServer =
    deps.isCoreServer || ((...args) => dockerMcp().isCoreServer(...args));
  if (isCoreServer(serverId)) {
    return {
      success: false,
      server_id: serverId,
      error: `System-delivered MCP server '${serverId}' is immutable and cannot be deleted.`,
      errorCode: "IMMUTABLE_SYSTEM_SERVER",
      files_deleted_count: 0,
      toggle_removed: false,
    };
  }

  const userServerDir = path.join(projectRoot, "mcp-configs-user", serverId);
  const existed = await pathExists(userServerDir, deps);
  const filesDeletedCount = existed
    ? await countFilesRecursive(userServerDir, deps)
    : 0;

  const isHostDeployedServer =
    deps.isHostDeployedServer ||
    ((...args) => dockerMcp().isHostDeployedServer(...args));
  const isHostDeployed = await Promise.resolve(
    isHostDeployedServer(serverId),
  );
  const containerCandidates = isHostDeployed
    ? []
    : Array.from(
        new Set(
          [
            (
              deps.getConfiguredMcpoRuntimeTarget ||
              ((...args) => dockerMcp().getConfiguredMcpoRuntimeTarget(...args))
            )(serverId)?.containerName,
            ...((deps.getMcpoServerContainerCandidates ||
              ((...args) => dockerMcp().getMcpoServerContainerCandidates(...args)))(
              serverId,
            ) || []),
          ].filter((value) => typeof value === "string" && value.trim()),
        ),
      );

  if (existed) {
    await deps.fsPromises.rm(userServerDir, { recursive: true, force: true });
  }

  try {
    startupFailures().clearStartupFailure(projectRoot, serverId, { logger });
  } catch (error) {
    logger.warn?.(
      `[MCP Delete] Could not clear startup failure for ${serverId}: ${error.message}`,
    );
  }

  try {
    if (typeof deps.clearRuntimeState === "function") {
      deps.clearRuntimeState(serverId);
    } else {
      dockerMcp().clearMcpRuntimeStateForServer?.(serverId);
    }
  } catch (error) {
    logger.warn?.(
      `[MCP Delete] Could not clear runtime state for ${serverId}: ${error.message}`,
    );
  }

  let toggleRemoved = false;
  const mutateToggles =
    deps.mutateToggles || ((...args) => dockerMcp().mutateMcpToggles(...args));
  await mutateToggles(
    (toggles) => {
      if (Object.prototype.hasOwnProperty.call(toggles, serverId)) {
        delete toggles[serverId];
        toggleRemoved = true;
      }
    },
    {
      reason: `delete-mcp-server:${serverId}`,
      logger,
    },
  );

  try {
    const mutateDisableModes =
      deps.mutateDisableModes ||
      ((...args) => dockerMcp().mutateMcpDisableModes(...args));
    await mutateDisableModes(
      (modes) => {
        if (Object.prototype.hasOwnProperty.call(modes, serverId)) {
          delete modes[serverId];
        }
      },
      {
        reason: `delete-mcp-server:${serverId}`,
        logger,
      },
    );
  } catch (error) {
    logger.warn?.(
      `[MCP Delete] Could not clear disable mode for ${serverId}: ${error.message}`,
    );
  }

  const warnings = [];

  try {
    if (isHostDeployed) {
      const restartHostMcpoWithFreshConfig =
        deps.restartHostMcpoWithFreshConfig ||
        ((...args) => hostLifecycle().restartHostMcpoWithFreshConfig(...args));
      const regenerateMcpInfrastructure =
        deps.regenerateMcpInfrastructure ||
        ((...args) => infra().regenerateMcpInfrastructure(...args));
      const stopHostMcpo =
        deps.stopHostMcpo || ((...args) => dockerMcp().stopHostMcpo(...args));
      const startHostMcpo =
        deps.startHostMcpo || ((...args) => dockerMcp().startHostMcpo(...args));
      const execAsync = deps.execAsync || require("./bootstrap").execPromise;
      await restartHostMcpoWithFreshConfig({
        execAsync,
        projectRoot,
        env: deps.env,
        regenerateMcpInfrastructure,
        stopHostMcpo,
        startHostMcpo,
        logger,
        regenerationOptions: {
          force: true,
          isPackagedApp: deps.isPackagedApp,
          timeout: 30000,
        },
      });
    } else {
      const executeWithStreaming =
        deps.executeWithStreaming ||
        ((...args) => dockerMcp().executeWithStreaming(...args));
      const regenerateMcpInfrastructure =
        deps.regenerateMcpInfrastructure ||
        ((...args) => infra().regenerateMcpInfrastructure(...args));
      const refreshMcpControlPlane =
        deps.refreshMcpControlPlane ||
        ((...args) => infra().refreshMcpControlPlane(...args));
      const execAsync = deps.execAsync || require("./bootstrap").execPromise;
      for (const containerName of containerCandidates) {
        try {
          await executeWithStreaming(
            buildForceRemoveContainerCommand(containerName),
            [],
            10000,
          );
        } catch (error) {
          warnings.push(
            `Container remove notice for ${containerName}: ${error.message}`,
          );
        }
      }

      try {
        await regenerateMcpInfrastructure(
          execAsync,
          projectRoot,
          deps.env,
          {
            force: true,
            isPackagedApp: deps.isPackagedApp,
            timeout: 30000,
          },
        );
      } catch (error) {
        warnings.push(`Config regeneration notice: ${error.message}`);
      }

      try {
        await refreshMcpControlPlane(
          execAsync,
          projectRoot,
          deps.env,
          {
            controlPlaneContainer: "mcpo",
            serverId: serverId,
            includeRegular: true,
            includeCore: false,
            serverRouteWait: "skip",
            logger,
          },
        );
      } catch (error) {
        warnings.push(`Control-plane refresh notice: ${error.message}`);
      }
    }
  } catch (error) {
    return {
      success: false,
      server_id: serverId,
      files_deleted_count: filesDeletedCount,
      toggle_removed: toggleRemoved,
      error: error.message,
      warnings,
    };
  }

  try {
    deps.broadcastToggleState({ server_id: serverId, enabled: false });
  } catch (error) {
    warnings.push(`Toggle broadcast notice: ${error.message}`);
  }

  try {
    (deps.queueFullHealthCheck ||
      ((...args) => dockerMcp().queueFullHealthCheck(...args)))(
      `mcp-server-deleted:${serverId}`,
      {
        immediate: true,
      },
    );
  } catch (error) {
    warnings.push(`Health sync notice: ${error.message}`);
  }

  return {
    success: true,
    server_id: serverId,
    files_deleted_count: filesDeletedCount,
    toggle_removed: toggleRemoved,
    message: existed
      ? `User-installed MCP server '${serverId}' deleted`
      : `User-installed MCP server '${serverId}' was already absent`,
    warnings,
  };
}

module.exports = {
  countFilesRecursive,
  deleteUserMcpServer,
};
