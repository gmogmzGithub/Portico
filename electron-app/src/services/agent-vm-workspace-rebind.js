const { exec } = require("child_process");
const path = require("path");

const { HARBOR_IMAGE_BASE } = require("./docker-image-plan");
const state = require("./shared-state");

const AGENT_VM_CONTAINER_PREFIX = "agent-vm-";
const REDIS_CONTAINER_NAME = "portico-redis";
const REDIS_VM_INFO_PREFIX = "agent_vm_info:";
const ACTIVE_STATES = new Set(["created", "restarting", "running", "paused"]);
const VM_MEMORY_LIMIT_BYTES = 1073741824;
const VM_CPU_PERIOD = 100000;
const VM_CPU_QUOTA = 200000;
const DEFAULT_COMMAND_TIMEOUT_MS = 15000;

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function trim(value) {
  return String(value || "").replace(/\r/g, "").replace(/\n+$/, "");
}

function splitLines(value) {
  return trim(value)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function runCommand(command, options = {}) {
  return new Promise((resolve, reject) => {
    exec(
      command,
      {
        cwd: options.cwd,
        env: options.env || process.env,
        timeout: options.timeoutMs || DEFAULT_COMMAND_TIMEOUT_MS,
        maxBuffer: options.maxBuffer || 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve(stdout || "");
      },
    );
  });
}

function commandRunner(options = {}) {
  return options.runCommand || runCommand;
}

function agentVmImage(env = process.env, buildInfo = state.buildInfo) {
  const configuredImage = String(env?.CORE_MCP_AGENT_VM_IMAGE || "").trim();
  if (configuredImage) {
    return configuredImage;
  }

  const buildNumber = String(buildInfo?.buildNumber || "").trim();
  if (buildNumber && buildNumber !== "dev-build") {
    return `${HARBOR_IMAGE_BASE}/agent-vm:${buildNumber}`;
  }

  return "agent-vm:latest";
}

function agentVmNetwork(env = process.env) {
  return env.CORE_MCP_AGENT_VM_NETWORK || "portico-agent-vm-network";
}

async function redisGet(key, options = {}) {
  const output = await commandRunner(options)(
    `docker exec ${shellEscape(options.redisContainerName || REDIS_CONTAINER_NAME)} redis-cli --raw GET ${shellEscape(key)}`,
    options,
  );
  return trim(output) || null;
}

async function redisSet(key, value, options = {}) {
  await commandRunner(options)(
    `docker exec ${shellEscape(options.redisContainerName || REDIS_CONTAINER_NAME)} redis-cli SET ${shellEscape(key)} ${shellEscape(value)}`,
    options,
  );
}

async function redisScan(pattern, options = {}) {
  const output = await commandRunner(options)(
    `docker exec ${shellEscape(options.redisContainerName || REDIS_CONTAINER_NAME)} redis-cli --raw --scan --pattern ${shellEscape(pattern)}`,
    { ...options, maxBuffer: 4 * 1024 * 1024 },
  );
  return splitLines(output);
}

async function listActiveChatVms(chatId, options = {}) {
  const keys = await redisScan(`${REDIS_VM_INFO_PREFIX}*`, options);
  const vms = [];
  for (const key of keys) {
    const raw = await redisGet(key, options);
    if (!raw) {
      continue;
    }
    let vmInfo;
    try {
      vmInfo = JSON.parse(raw);
    } catch (_error) {
      continue;
    }
    if (vmInfo?.chat_id !== chatId || !vmInfo?.vm_id || !vmInfo?.container_id) {
      continue;
    }
    const containerName = `${AGENT_VM_CONTAINER_PREFIX}${vmInfo.vm_id}`;
    let state = "";
    try {
      state = trim(
        await commandRunner(options)(
          `docker inspect --format '{{.State.Status}}' ${shellEscape(containerName)}`,
          options,
        ),
      ).toLowerCase();
    } catch (_error) {
      continue;
    }
    if (ACTIVE_STATES.has(state)) {
      vms.push({ ...vmInfo, status: state });
    }
  }
  return vms;
}

async function validateWorkspaceBind(workspacePath, options = {}) {
  await commandRunner(options)(
    [
      "docker run --rm --network none",
      `--volume ${shellEscape(`${workspacePath}:/work:rw`)}`,
      "--entrypoint sh",
      shellEscape(agentVmImage(options.env, options.buildInfo)),
      "-lc",
      shellEscape("test -d /work && test -w /work"),
    ].join(" "),
    { ...options, timeoutMs: 30000 },
  );
}

async function createAgentVmContainer(vmId, workspacePath, options = {}) {
  const name = options.name || `${AGENT_VM_CONTAINER_PREFIX}${vmId}`;
  const output = await commandRunner(options)(
    [
      "docker create",
      `--name ${shellEscape(name)}`,
      `--network ${shellEscape(agentVmNetwork(options.env))}`,
      `--memory ${VM_MEMORY_LIMIT_BYTES}`,
      `--cpu-period ${VM_CPU_PERIOD}`,
      `--cpu-quota ${VM_CPU_QUOTA}`,
      "--workdir /work",
      `--volume ${shellEscape(`${workspacePath}:/work:rw`)}`,
      shellEscape(agentVmImage(options.env, options.buildInfo)),
      "sh -lc",
      shellEscape("rm -rf /workspace 2>/dev/null || true; ln -s /work /workspace 2>/dev/null || true; tail -f /dev/null"),
    ].join(" "),
    options,
  );
  await commandRunner(options)(`docker start ${shellEscape(name)}`, options);
  const containerId = trim(output);
  return containerId || name;
}

async function rebindVm(vmInfo, workspacePath, options = {}) {
  const vmId = vmInfo.vm_id;
  const stableName = `${AGENT_VM_CONTAINER_PREFIX}${vmId}`;
  const tempName = `${AGENT_VM_CONTAINER_PREFIX}rebind-${vmId}-${Date.now()}`;
  const previousSource = vmInfo.work_bind_source;

  try {
    await createAgentVmContainer(vmId, workspacePath, { ...options, name: tempName });
    await commandRunner(options)(`docker rm -f ${shellEscape(stableName)}`, options);
    await commandRunner(options)(`docker rename ${shellEscape(tempName)} ${shellEscape(stableName)}`, options);
    const containerId = trim(
      await commandRunner(options)(
        `docker inspect --format '{{.Id}}' ${shellEscape(stableName)}`,
        options,
      ),
    );
    const updated = {
      ...vmInfo,
      container_id: containerId,
      status: "running",
      last_activity: Date.now() / 1000,
      work_bind_source: workspacePath,
      work_bind_source_verified: true,
    };
    await redisSet(
      `${REDIS_VM_INFO_PREFIX}${vmId}`,
      JSON.stringify(updated),
      options,
    );
    return { vmId, success: true, previousSource, containerId };
  } catch (error) {
    await commandRunner(options)(`docker rm -f ${shellEscape(tempName)}`, options).catch(() => {});
    throw error;
  }
}

async function rebindChatAgentVms(chatId, workspacePath, options = {}) {
  const vms = await listActiveChatVms(chatId, options);
  const rebound = [];
  for (const vm of vms) {
    rebound.push(await rebindVm(vm, workspacePath, options));
  }
  return {
    success: true,
    chatId,
    reboundCount: rebound.length,
    rebound,
  };
}

function normalizeWorkspacePath(workspacePath) {
  const raw = String(workspacePath || "").trim();
  return raw ? path.resolve(raw) : "";
}

function vmNeedsWorkspaceRebind(vmInfo, workspacePath) {
  const currentSource = normalizeWorkspacePath(vmInfo?.work_bind_source);
  const targetSource = normalizeWorkspacePath(workspacePath);
  return (
    !targetSource ||
    !currentSource ||
    currentSource !== targetSource ||
    vmInfo?.work_bind_source_verified !== true
  );
}

async function reconcileChatAgentVmWorkspaceBinds(chatId, workspacePath, options = {}) {
  const targetWorkspacePath = normalizeWorkspacePath(workspacePath);
  if (!targetWorkspacePath) {
    throw new Error("workspacePath is required");
  }

  const vms = await listActiveChatVms(chatId, options);
  const staleVms = vms.filter((vm) => vmNeedsWorkspaceRebind(vm, targetWorkspacePath));
  if (staleVms.length === 0) {
    return {
      success: true,
      chatId,
      checkedCount: vms.length,
      reboundCount: 0,
      rebound: [],
    };
  }

  if (options.validateWorkspace !== false) {
    await validateWorkspaceBind(targetWorkspacePath, options);
  }

  const rebound = [];
  for (const vm of staleVms) {
    rebound.push(await rebindVm(vm, targetWorkspacePath, options));
  }
  return {
    success: true,
    chatId,
    checkedCount: vms.length,
    reboundCount: rebound.length,
    rebound,
  };
}

module.exports = {
  AGENT_VM_CONTAINER_PREFIX,
  REDIS_CONTAINER_NAME,
  agentVmImage,
  createAgentVmContainer,
  listActiveChatVms,
  reconcileChatAgentVmWorkspaceBinds,
  rebindChatAgentVms,
  runCommand,
  validateWorkspaceBind,
  vmNeedsWorkspaceRebind,
};
