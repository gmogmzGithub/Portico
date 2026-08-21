const fs = require("fs");
const path = require("path");

const COMPONENT_BRIDGE = "host_mcp_bridge";
const COMPONENT_HOST_MCPO = "host_mcpo";

function normalizePid(value) {
  const pid = Number.parseInt(String(value || "").trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function parseListeningProcessIds(stdout) {
  return [
    ...new Set(
      String(stdout || "")
        .split(/\r?\n/)
        .map(normalizePid)
        .filter(Boolean),
    ),
  ];
}

function safeCommandLabel(command) {
  const value = String(command || "").trim();
  if (!value) return "unknown";
  if (/\bmcp-orc\b.*\bbridge\b/i.test(value)) return "mcp-orc bridge";
  if (/mcp_config_host_sideload\.json/i.test(value)) return "host mcp-orc";
  if (/run-host-mcp-bridge\.sh/i.test(value)) return "Host MCP Bridge launcher";
  if (/run-host-mcp\.sh/i.test(value)) return "Host MCP runtime launcher";
  if (/\buvx\b.*\bmcpo\b/i.test(value)) return "host mcpo";

  const executable = value.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  return path.basename(executable?.[1] || executable?.[2] || executable?.[3] || "unknown");
}

function commandMatchesComponent(command, component) {
  const value = String(command || "");
  if (component === COMPONENT_BRIDGE) {
    return /\bmcp-orc\b.*\bbridge\b|run-host-mcp-bridge\.sh/i.test(value);
  }
  if (component === COMPONENT_HOST_MCPO) {
    return /mcp_config_host_sideload\.json|run-host-mcp\.sh|\buvx\b.*\bmcpo\b/i.test(
      value,
    );
  }
  return false;
}

async function inspectCallbackPortOwners(port, options = {}) {
  const exec = options.exec;
  if (typeof exec !== "function") {
    throw new Error("inspectCallbackPortOwners requires exec");
  }

  const pidResult = await exec(
    `lsof -nP -iTCP:${Number(port)} -sTCP:LISTEN -t 2>/dev/null || true`,
    options.execOptions || {},
  );
  const pids = parseListeningProcessIds(pidResult?.stdout);
  const owners = [];

  for (const pid of pids) {
    // PID comes from lsof and is normalized to an integer before interpolation.
    // eslint-disable-next-line no-await-in-loop
    const [pgidResult, commandResult] = await Promise.all([
      exec(`ps -p ${pid} -o pgid= 2>/dev/null || true`, options.execOptions || {}),
      exec(`ps -p ${pid} -o command= 2>/dev/null || true`, options.execOptions || {}),
    ]);
    owners.push({
      pid,
      pgid: normalizePid(pgidResult?.stdout),
      command: String(commandResult?.stdout || "").trim(),
    });
  }

  return owners;
}

function readManagedPidFile(filePath, options = {}) {
  const readFileSync = options.readFileSync || fs.readFileSync;
  try {
    return normalizePid(readFileSync(filePath, "utf8"));
  } catch (_error) {
    return null;
  }
}

function buildKnownProcessGroups(options = {}) {
  const projectRoot = String(options.projectRoot || "");
  const groups = {
    [COMPONENT_BRIDGE]: new Set(),
    [COMPONENT_HOST_MCPO]: new Set(),
  };

  const add = (component, value) => {
    const pid = normalizePid(value);
    if (pid) groups[component].add(pid);
  };

  add(COMPONENT_BRIDGE, options.bridgePid);
  add(COMPONENT_HOST_MCPO, options.hostMcpoPid);
  if (projectRoot) {
    add(
      COMPONENT_BRIDGE,
      readManagedPidFile(path.join(projectRoot, "MCP_BRIDGE.pid"), options),
    );
    add(
      COMPONENT_HOST_MCPO,
      readManagedPidFile(path.join(projectRoot, "MCPO_HOST.pid"), options),
    );
  }

  return groups;
}

function classifyCallbackPortOwners(owners, knownProcessGroups = {}) {
  return (owners || []).map((owner) => {
    let component = null;
    for (const candidate of [COMPONENT_BRIDGE, COMPONENT_HOST_MCPO]) {
      const known = knownProcessGroups[candidate] || new Set();
      if (
        (known.has(owner.pid) || (owner.pgid && known.has(owner.pgid))) &&
        commandMatchesComponent(owner.command, candidate)
      ) {
        component = candidate;
        break;
      }
    }

    return {
      ...owner,
      component,
      recoverable: component !== null,
      commandLabel: safeCommandLabel(owner.command),
    };
  });
}

function formatCallbackPortOwners(port, owners) {
  if (!owners || owners.length === 0) {
    return `port ${port} has an unidentified listener`;
  }
  return owners
    .map((owner) => {
      const pgid = owner.pgid ? ` pgid=${owner.pgid}` : "";
      const role = owner.component ? ` role=${owner.component}` : "";
      return `port ${port} pid=${owner.pid}${pgid}${role} command=${owner.commandLabel || safeCommandLabel(owner.command)}`;
    })
    .join("; ");
}

async function ensureReservedCallbackPortAvailable(options = {}) {
  const port = Number(options.port);
  if (typeof options.isPortAvailable !== "function") {
    throw new Error("ensureReservedCallbackPortAvailable requires isPortAvailable");
  }
  if (typeof options.inspectOwners !== "function") {
    throw new Error("ensureReservedCallbackPortAvailable requires inspectOwners");
  }
  if (typeof options.recoverComponent !== "function") {
    throw new Error("ensureReservedCallbackPortAvailable requires recoverComponent");
  }

  if (await options.isPortAvailable(port)) {
    return { success: true, recovered: false, owners: [] };
  }

  let owners = await options.inspectOwners(port);
  options.onConflict?.(owners);
  const ownerSummary = formatCallbackPortOwners(port, owners);
  if (owners.length === 0 || owners.some((owner) => !owner.recoverable)) {
    return {
      success: false,
      recovered: false,
      owners,
      error:
        `OAuth callback port ${port} is reserved for guided setup but is occupied by another process (${ownerSummary}). ` +
        "Portico did not stop the process. Close it and retry.",
    };
  }

  const components = [...new Set(owners.map((owner) => owner.component))];
  for (const component of components) {
    // eslint-disable-next-line no-await-in-loop
    const recovery = await options.recoverComponent(component);
    if (recovery?.success === false) {
      return {
        success: false,
        recovered: false,
        owners,
        error:
          recovery.error ||
          `Could not restart ${component} while releasing OAuth callback port ${port}`,
      };
    }
  }

  if (await options.isPortAvailable(port)) {
    return { success: true, recovered: true, owners };
  }

  owners = await options.inspectOwners(port);
  return {
    success: false,
    recovered: false,
    owners,
    error:
      `OAuth callback port ${port} remained occupied after restarting the app-owned runtime ` +
      `(${formatCallbackPortOwners(port, owners)}).`,
  };
}

module.exports = {
  COMPONENT_BRIDGE,
  COMPONENT_HOST_MCPO,
  buildKnownProcessGroups,
  classifyCallbackPortOwners,
  commandMatchesComponent,
  ensureReservedCallbackPortAvailable,
  formatCallbackPortOwners,
  inspectCallbackPortOwners,
  normalizePid,
  parseListeningProcessIds,
  readManagedPidFile,
  safeCommandLabel,
};
