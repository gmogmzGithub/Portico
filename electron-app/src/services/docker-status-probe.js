const { runManagedProcess } = require("./managed-process");

const DEFAULT_CORE_CONTAINERS = Object.freeze([
  ["llm-gateway", "llm-gateway"],
  ["mcpo", "mcpo"],
  ["portico-open-webui", "portico-open-webui"],
  ["open-webui-health-check", "open-webui-health-check"],
]);

function parseDockerPsJsonLines(output) {
  const containers = new Map();
  for (const line of String(output || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const row = JSON.parse(trimmed);
    const name = String(row.Names || "").trim();
    if (!name) continue;
    containers.set(name, String(row.State || "").trim().toLowerCase());
  }
  return containers;
}

function buildDockerStatusMap(containers, coreContainers = DEFAULT_CORE_CONTAINERS) {
  const status = {};

  for (const [logicalName, actualName] of coreContainers) {
    const state = containers.get(actualName);
    status[logicalName] = !state
      ? "not_found"
      : state === "running"
        ? "running"
        : "stopped";
  }

  for (const [name, state] of containers) {
    if (
      state === "running" &&
      name.startsWith("mcpo-") &&
      name !== "mcpo-core" &&
      name !== "mcpo"
    ) {
      status[name] = "running";
    }
  }

  return status;
}

async function probeDockerStatus(options = {}) {
  const {
    cwd,
    env,
    signal,
    timeoutMs = 10000,
    runProcess = runManagedProcess,
  } = options;
  const result = await runProcess(
    "docker",
    ["ps", "-a", "--format", "{{json .}}"],
    { cwd, env, signal, timeoutMs, maxBufferBytes: 2 * 1024 * 1024 },
  );
  return buildDockerStatusMap(parseDockerPsJsonLines(result.stdout));
}

function createSerialPoller(task, options = {}) {
  const intervalMs = Math.max(0, Number(options.intervalMs) || 0);
  const schedule = options.schedule || setTimeout;
  const cancelSchedule = options.cancelSchedule || clearTimeout;
  const onError = options.onError || (() => {});
  const cancelInFlight = options.cancelInFlight || (() => {});
  let active = false;
  let timer = null;
  let inFlight = null;

  const run = async () => {
    if (!active || inFlight) return;
    inFlight = Promise.resolve().then(task);
    try {
      await inFlight;
    } catch (error) {
      onError(error);
    } finally {
      inFlight = null;
      if (active) {
        timer = schedule(run, intervalMs);
      }
    }
  };

  return {
    start() {
      if (active) return false;
      active = true;
      void run();
      return true;
    },
    stop() {
      if (!active && !inFlight) return false;
      active = false;
      if (timer) {
        cancelSchedule(timer);
        timer = null;
      }
      if (inFlight) {
        cancelInFlight();
      }
      return true;
    },
    isRunning() {
      return active;
    },
    hasInFlightTask() {
      return Boolean(inFlight);
    },
  };
}

module.exports = {
  DEFAULT_CORE_CONTAINERS,
  buildDockerStatusMap,
  createSerialPoller,
  parseDockerPsJsonLines,
  probeDockerStatus,
};
