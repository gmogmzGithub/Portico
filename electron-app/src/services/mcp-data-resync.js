// Purge a managed MCP server's persisted data volume so its next start
// rebuilds state from the source system. Today only Slack qualifies: its
// container mounts the compose volume `slack-mcp-cache` (declared in
// docker-compose.yml, mounted by the mcp-orc generator) holding the
// identity-scoped users/channels directory caches. The caller follows a
// successful purge with the standard restart operation, which recreates
// the container and (compose recreates missing named volumes) starts a
// clean directory sync.
//
// Deliberately one-shot: no timers, no polling, no broadcasts.

const {
  buildClearVolumeContentsCommand,
  buildForceRemoveContainerCommand,
  buildListComposeVolumeCommand,
  buildRemoveVolumeCommand,
} = require("./docker-compose-command");

const COMPOSE_PROJECT_NAME = "portico";
const VOLUME_CLEAR_IMAGE = "portico-mcp-orc-rust:latest";

const RESYNCABLE_SERVER_DATA = Object.freeze({
  slack: Object.freeze({
    volumeKey: "slack-mcp-cache",
    projectName: COMPOSE_PROJECT_NAME,
    dataDescription: "Slack user and channel directory cache",
    // Host-side small-state dir (sync stamps + warmup sidecar) under the
    // app-support mount. Re-sync means "pretend first boot", so stamps go
    // too - a fresh stamp beside an empty volume would be incoherent.
    hostStateSubdir: "slack-mcp-state",
  }),
});

function resyncableServerData(serverId) {
  return RESYNCABLE_SERVER_DATA[serverId] || null;
}

async function resolveVolumeName({ execAsync, projectName, volumeKey }) {
  try {
    const { stdout } = await execAsync(
      buildListComposeVolumeCommand(projectName, volumeKey),
    );
    const resolved = String(stdout || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (resolved.length > 0) {
      return resolved[0];
    }
  } catch {
    // Fall through to the conventional compose name below.
  }
  return `${projectName}_${volumeKey}`;
}

async function purgeServerDataVolume(serverId, dependencies = {}) {
  const {
    execAsync,
    operationManager,
    getRuntimeTarget,
    appSupportHostDir = null,
    logger = console,
  } = dependencies;
  if (typeof execAsync !== "function") {
    throw new TypeError("execAsync (function) is required");
  }
  if (!operationManager || typeof operationManager.acquireMutationLease !== "function") {
    throw new TypeError("operationManager with acquireMutationLease is required");
  }
  if (typeof getRuntimeTarget !== "function") {
    throw new TypeError("getRuntimeTarget (function) is required");
  }

  const capability = resyncableServerData(serverId);
  if (!capability) {
    const error = new Error(
      `Server '${serverId}' has no resyncable data volume`,
    );
    error.code = "MCP_RESYNC_UNSUPPORTED";
    throw error;
  }

  // Throws MCP_OPERATION_BUSY when an operation or external mutation is
  // active - the caller surfaces the standard busy payload.
  const release = operationManager.acquireMutationLease({
    kind: "resync_server_data",
    source: "control_plane",
  });

  try {
    const runtimeTarget = getRuntimeTarget(serverId) || {};
    const containerName = runtimeTarget.containerName || `mcpo-${serverId}`;

    logger.log(
      `[MCP Resync] Purging ${capability.dataDescription} (container ${containerName}, volume key ${capability.volumeKey})`,
    );

    // The container is the volume's only reference (generator gates the
    // mount to this server), so remove it first.
    await execAsync(buildForceRemoveContainerCommand(containerName));

    const volumeName = await resolveVolumeName({
      execAsync,
      projectName: capability.projectName,
      volumeKey: capability.volumeKey,
    });

    let volumeRemoved = false;
    let clearedInPlace = false;
    try {
      await execAsync(buildRemoveVolumeCommand(volumeName));
      volumeRemoved = true;
    } catch {
      // A racing reference can block removal; retry once after re-removing
      // the container, then fall back to emptying the volume in place.
      await execAsync(buildForceRemoveContainerCommand(containerName));
      try {
        await execAsync(buildRemoveVolumeCommand(volumeName));
        volumeRemoved = true;
      } catch {
        await execAsync(
          buildClearVolumeContentsCommand(volumeName, VOLUME_CLEAR_IMAGE),
        );
        clearedInPlace = true;
      }
    }

    logger.log(
      `[MCP Resync] Volume ${volumeName} ${volumeRemoved ? "removed" : "cleared in place"}; restart will trigger a clean re-sync`,
    );

    // Purge host-side sync stamps/sidecars too: re-sync means "pretend
    // first boot". These are plain host files under the app-support mount.
    let stateFilesRemoved = 0;
    if (capability.hostStateSubdir && appSupportHostDir) {
      const fs = require("fs");
      const path = require("path");
      const stateDir = path.join(appSupportHostDir, capability.hostStateSubdir);
      try {
        for (const entry of fs.readdirSync(stateDir)) {
          if (/(_sync_state|_warmup_history)\.json$/.test(entry)) {
            fs.rmSync(path.join(stateDir, entry), { force: true });
            stateFilesRemoved += 1;
          }
        }
        logger.log(
          `[MCP Resync] Removed ${stateFilesRemoved} sync-state file(s) from ${stateDir}`,
        );
      } catch (error) {
        if (error.code !== "ENOENT") {
          logger.log(
            `[MCP Resync] Could not purge sync-state dir ${stateDir}: ${error.message}`,
          );
        }
      }
    }

    return {
      success: true,
      serverId,
      containerName,
      volumeName,
      volumeRemoved,
      clearedInPlace,
      stateFilesRemoved,
    };
  } finally {
    release();
  }
}

module.exports = {
  purgeServerDataVolume,
  resyncableServerData,
};
