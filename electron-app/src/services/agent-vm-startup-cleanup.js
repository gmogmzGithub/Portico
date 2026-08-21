const path = require("path");

const AGENT_VM_CONTAINER_PREFIX = "agent-vm-";
const ARTIFACT_CONTAINER_PREFIX = "agent-vm-artifact-";
const REDIS_CONTAINER_NAME = "portico-redis";
const REDIS_VM_INFO_PREFIX = "agent_vm_info:";
const REDIS_VM_FILE_READS_PREFIX = "agent_vm_file_reads:";
const REDIS_CHAT_VM_PREFIX = "agent_vm:";
const KEEP_CONTAINER_STATES = new Set([
  "created",
  "restarting",
  "running",
  "paused",
]);
const DEFAULT_COMMAND_TIMEOUT_MS = 5000;
const DEFAULT_WORKSPACE_ROOT = "workspaces";

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function trimTrailingNewlines(value) {
  return String(value).replace(/\r/g, "").replace(/\n+$/, "");
}

function splitLines(value) {
  return trimTrailingNewlines(value)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function deriveVmIdFromContainerName(containerName) {
  if (typeof containerName !== "string") {
    return null;
  }
  const trimmed = containerName.trim().replace(/^\/+/, "");
  if (trimmed.startsWith(ARTIFACT_CONTAINER_PREFIX)) {
    return null;
  }
  if (!trimmed.startsWith(AGENT_VM_CONTAINER_PREFIX)) {
    return null;
  }
  return trimmed.slice(AGENT_VM_CONTAINER_PREFIX.length) || null;
}

function parseVmMetadata(raw) {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  return JSON.parse(trimmed);
}

function isVmExpired(vmInfo, nowSeconds) {
  const lastActivity = Number(vmInfo?.last_activity);
  const timeoutHours = Number(vmInfo?.timeout_hours);
  if (!Number.isFinite(lastActivity) || !Number.isFinite(timeoutHours)) {
    return false;
  }
  return nowSeconds - lastActivity > timeoutHours * 3600;
}

function getRecoveryWorkspacePath(workspaceRoot, chatId, vmId) {
  if (
    typeof workspaceRoot !== "string" ||
    !workspaceRoot ||
    typeof chatId !== "string" ||
    !chatId ||
    typeof vmId !== "string" ||
    !vmId
  ) {
    return null;
  }
  return path.join(workspaceRoot, chatId, "agents", vmId);
}

function formatRemovalReason(reason, status) {
  if (reason === "missing_metadata") {
    return "missing Redis metadata";
  }
  if (reason === "invalid_metadata") {
    return "invalid Redis metadata";
  }
  if (reason === "expired") {
    return "expired inactivity timeout";
  }
  if (reason === "container_state") {
    return `container state '${status || "unknown"}'`;
  }
  return reason || "unknown reason";
}

function createShellCommandRunner(execCommand, options = {}) {
  if (typeof execCommand !== "function") {
    throw new TypeError("execCommand (function) is required");
  }

  const projectRoot = options.projectRoot;
  const env = options.env;
  const defaultTimeoutMs = Number.isFinite(options.defaultTimeoutMs)
    ? options.defaultTimeoutMs
    : DEFAULT_COMMAND_TIMEOUT_MS;

  return async (command, commandOptions = {}) => {
    const result = await execCommand(command, {
      cwd: commandOptions.cwd || projectRoot,
      env: commandOptions.env || env,
      timeout:
        Number.isFinite(commandOptions.timeoutMs) &&
        commandOptions.timeoutMs > 0
          ? commandOptions.timeoutMs
          : defaultTimeoutMs,
      maxBuffer: commandOptions.maxBuffer || 1024 * 1024,
    });

    if (result && typeof result === "object" && "stdout" in result) {
      return result.stdout || "";
    }
    return typeof result === "string" ? result : "";
  };
}

async function redisGetValue(runCommand, redisContainerName, key) {
  const output = trimTrailingNewlines(
    await runCommand(
      `docker exec ${shellEscape(redisContainerName)} redis-cli --raw GET ${shellEscape(key)}`,
    ),
  );
  return output || null;
}

async function redisDeleteKey(runCommand, redisContainerName, key) {
  await runCommand(
    `docker exec ${shellEscape(redisContainerName)} redis-cli DEL ${shellEscape(key)}`,
  );
}

async function redisPersistKey(runCommand, redisContainerName, key) {
  await runCommand(
    `docker exec ${shellEscape(redisContainerName)} redis-cli PERSIST ${shellEscape(key)}`,
  );
}

async function redisScanKeys(runCommand, redisContainerName, pattern) {
  const output = await runCommand(
    `docker exec ${shellEscape(redisContainerName)} redis-cli --raw --scan --pattern ${shellEscape(pattern)}`,
    { maxBuffer: 4 * 1024 * 1024 },
  );
  return splitLines(output);
}

async function clearChatVmMappings(runCommand, redisContainerName, vmId, chatId) {
  const deletedKeys = [];
  const candidateKeys = [];

  if (typeof chatId === "string" && chatId.trim()) {
    candidateKeys.push(`${REDIS_CHAT_VM_PREFIX}${chatId.trim()}`);
  } else {
    const scannedKeys = await redisScanKeys(
      runCommand,
      redisContainerName,
      `${REDIS_CHAT_VM_PREFIX}*`,
    );
    candidateKeys.push(...scannedKeys);
  }

  const uniqueKeys = [...new Set(candidateKeys)];
  for (const key of uniqueKeys) {
    const value = await redisGetValue(runCommand, redisContainerName, key);
    if (value === vmId) {
      await redisDeleteKey(runCommand, redisContainerName, key);
      deletedKeys.push(key);
    }
  }

  return deletedKeys;
}

async function cleanupStartupAgentVms(options = {}) {
  const runCommand = options.runCommand;
  if (typeof runCommand !== "function") {
    throw new TypeError("runCommand (function) is required");
  }

  const redisContainerName =
    options.redisContainerName || REDIS_CONTAINER_NAME;
  const workspaceRoot =
    options.workspaceRoot || DEFAULT_WORKSPACE_ROOT;
  const nowSeconds = Number.isFinite(options.nowSeconds)
    ? options.nowSeconds
    : Date.now() / 1000;

  const report = {
    inspectedCount: 0,
    removedCount: 0,
    keptCount: 0,
    removed: [],
    kept: [],
    warnings: [],
  };

  let containerNames = [];
  try {
    const output = await runCommand(
      'docker ps -a --filter "name=agent-vm-" --format "{{.Names}}"',
    );
    containerNames = splitLines(output).filter(
      (name) => !name.replace(/^\/+/, "").startsWith(ARTIFACT_CONTAINER_PREFIX),
    );
  } catch (error) {
    report.warnings.push(
      `Agent VM cleanup skipped: failed to list containers (${error.message})`,
    );
    return report;
  }

  for (const containerName of containerNames) {
    const vmId = deriveVmIdFromContainerName(containerName);
    if (!vmId) {
      report.warnings.push(
        `Agent VM cleanup skipped unrecognized container name '${containerName}'`,
      );
      continue;
    }

    report.inspectedCount += 1;

    let status;
    try {
      status = trimTrailingNewlines(
        await runCommand(
          `docker inspect --format '{{.State.Status}}' ${shellEscape(containerName)}`,
        ),
      ).toLowerCase();
    } catch (error) {
      report.kept.push({ vmId, containerName, status: "unknown", reason: "inspect_failed" });
      report.keptCount += 1;
      report.warnings.push(
        `Preserved Agent VM ${vmId}: failed to inspect container state (${error.message})`,
      );
      continue;
    }

    let metadataRaw;
    try {
      metadataRaw = await redisGetValue(
        runCommand,
        redisContainerName,
        `${REDIS_VM_INFO_PREFIX}${vmId}`,
      );
    } catch (error) {
      report.kept.push({ vmId, containerName, status, reason: "metadata_lookup_failed" });
      report.keptCount += 1;
      report.warnings.push(
        `Preserved Agent VM ${vmId}: failed to read Redis metadata (${error.message})`,
      );
      continue;
    }

    let vmInfo = null;
    let reason = null;
    if (!metadataRaw) {
      reason = "missing_metadata";
    } else {
      try {
        vmInfo = parseVmMetadata(metadataRaw);
      } catch (_error) {
        reason = "invalid_metadata";
      }
    }

    if (!reason && !KEEP_CONTAINER_STATES.has(status)) {
      reason = "container_state";
    }
    if (!reason && isVmExpired(vmInfo, nowSeconds)) {
      reason = "expired";
    }

    if (!reason) {
      try {
        await redisPersistKey(
          runCommand,
          redisContainerName,
          `${REDIS_VM_INFO_PREFIX}${vmId}`,
        );
        if (typeof vmInfo?.chat_id === "string" && vmInfo.chat_id.trim()) {
          const mappingKey = `${REDIS_CHAT_VM_PREFIX}${vmInfo.chat_id.trim()}`;
          if (
            (await redisGetValue(runCommand, redisContainerName, mappingKey)) ===
            vmId
          ) {
            await redisPersistKey(runCommand, redisContainerName, mappingKey);
          }
        }
      } catch (error) {
        report.warnings.push(
          `Preserved Agent VM ${vmId}, but failed to persist its Redis state (${error.message})`,
        );
      }
      report.kept.push({
        vmId,
        containerName,
        status,
        recoveryPath: getRecoveryWorkspacePath(
          workspaceRoot,
          vmInfo?.chat_id,
          vmId,
        ),
      });
      report.keptCount += 1;
      continue;
    }

    let deletedMappings = [];
    try {
      await runCommand(`docker rm -f ${shellEscape(containerName)}`);
      await redisDeleteKey(
        runCommand,
        redisContainerName,
        `${REDIS_VM_INFO_PREFIX}${vmId}`,
      );
      await redisDeleteKey(
        runCommand,
        redisContainerName,
        `${REDIS_VM_FILE_READS_PREFIX}${vmId}`,
      );
      deletedMappings = await clearChatVmMappings(
        runCommand,
        redisContainerName,
        vmId,
        vmInfo?.chat_id,
      );
    } catch (error) {
      report.warnings.push(
        `Failed to remove stale Agent VM ${vmId}: ${error.message}`,
      );
      report.kept.push({
        vmId,
        containerName,
        status,
        reason: "removal_failed",
        recoveryPath: getRecoveryWorkspacePath(
          workspaceRoot,
          vmInfo?.chat_id,
          vmId,
        ),
      });
      report.keptCount += 1;
      continue;
    }

    const mappedChatId = deletedMappings
      .find((key) => key.startsWith(REDIS_CHAT_VM_PREFIX))
      ?.slice(REDIS_CHAT_VM_PREFIX.length);
    const recoveryPath = getRecoveryWorkspacePath(
      workspaceRoot,
      vmInfo?.chat_id || mappedChatId,
      vmId,
    );

    // Preserve host workspace files intentionally so expired VMs remain recoverable.
    report.removed.push({
      vmId,
      containerName,
      status,
      reason,
      reasonText: formatRemovalReason(reason, status),
      deletedMappings,
      recoveryPath,
      workspacePreserved: true,
    });
    report.removedCount += 1;
  }

  return report;
}

module.exports = {
  AGENT_VM_CONTAINER_PREFIX,
  KEEP_CONTAINER_STATES,
  REDIS_CONTAINER_NAME,
  cleanupStartupAgentVms,
  createShellCommandRunner,
  deriveVmIdFromContainerName,
  formatRemovalReason,
  getRecoveryWorkspacePath,
  isVmExpired,
  parseVmMetadata,
};
