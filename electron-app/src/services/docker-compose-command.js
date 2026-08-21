const os = require("os");

function buildUpContainerCommand(scriptPath, serviceName, options = {}) {
  if (!scriptPath || typeof scriptPath !== "string") {
    throw new TypeError("scriptPath (string) is required");
  }
  if (!serviceName || typeof serviceName !== "string") {
    throw new TypeError("serviceName (string) is required");
  }

  const noDeps = Boolean(options.noDeps);
  return `bash "${scriptPath}" up-container ${serviceName}${noDeps ? " --no-deps" : ""}`;
}

function buildUpContainersCommand(scriptPath, serviceNames, options = {}) {
  if (!scriptPath || typeof scriptPath !== "string") {
    throw new TypeError("scriptPath (string) is required");
  }
  if (!Array.isArray(serviceNames) || serviceNames.length === 0) {
    throw new TypeError("serviceNames (string[]) is required");
  }

  const normalizedServiceNames = serviceNames.filter(
    (serviceName) => typeof serviceName === "string" && serviceName.trim(),
  );
  if (normalizedServiceNames.length === 0) {
    throw new TypeError("serviceNames (string[]) is required");
  }

  const noDeps = Boolean(options.noDeps);
  return `bash "${scriptPath}" up-containers ${normalizedServiceNames.join(" ")}${noDeps ? " --no-deps" : ""}`;
}

function buildForceRemoveContainerCommand(containerName) {
  if (!containerName || typeof containerName !== "string") {
    throw new TypeError("containerName (string) is required");
  }

  return `docker rm -f ${containerName} >/dev/null 2>&1 || true`;
}

function buildListComposeVolumeCommand(projectName, volumeKey) {
  if (!projectName || typeof projectName !== "string") {
    throw new TypeError("projectName (string) is required");
  }
  if (!volumeKey || typeof volumeKey !== "string") {
    throw new TypeError("volumeKey (string) is required");
  }

  return `docker volume ls -q --filter label=com.docker.compose.project=${projectName} --filter label=com.docker.compose.volume=${volumeKey}`;
}

function buildRemoveVolumeCommand(volumeName) {
  if (!volumeName || typeof volumeName !== "string") {
    throw new TypeError("volumeName (string) is required");
  }

  // No `|| true`: the caller distinguishes success from failure to decide
  // whether the clear-contents fallback is needed.
  return `docker volume rm ${volumeName} >/dev/null 2>&1`;
}

function buildClearVolumeContentsCommand(volumeName, imageName) {
  if (!volumeName || typeof volumeName !== "string") {
    throw new TypeError("volumeName (string) is required");
  }
  if (!imageName || typeof imageName !== "string") {
    throw new TypeError("imageName (string) is required");
  }

  // Fallback when the volume itself cannot be removed (e.g. another
  // container still references it). The image must already exist locally
  // on customer machines - never a public registry pull.
  return `docker run --rm --entrypoint /bin/sh -v ${volumeName}:/purge ${imageName} -c 'find /purge -mindepth 1 -delete'`;
}

function collectErrorText(error) {
  return [error?.message, error?.stdout, error?.stderr]
    .filter((value) => typeof value === "string" && value.trim())
    .join("\n");
}

function sanitizeProbeText(value) {
  let sanitized = String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  const homeDir = os.homedir();
  if (homeDir) {
    sanitized = sanitized.split(homeDir).join("~");
  }
  return sanitized;
}

function parseComposeMajorVersion(output) {
  const match = String(output || "").match(/\bversion\s+v?(\d+)(?:[.\s]|$)/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function isComposeV2OrNewer(output) {
  const major = parseComposeMajorVersion(output);
  return Number.isInteger(major) && major >= 2;
}

function isDockerComposeUnavailableOutput(output) {
  const text = String(output || "");
  return [
    /DOCKER_COMPOSE_UNAVAILABLE/i,
    /unknown shorthand flag:\s*['"]?[fp]['"]?\s+in\s+-[fp]/i,
    /docker:\s+unknown command:\s+docker compose/i,
    /docker:\s+['"]?compose['"]?\s+is not a docker command/i,
    /Usage:\s+docker\s+\[OPTIONS\]\s+COMMAND/i,
  ].some((pattern) => pattern.test(text));
}

function parseDockerComposeDiagnostics(output) {
  const text = String(output || "");
  const readMarker = (name) => {
    const match = text.match(new RegExp(`^${name}=(.*)$`, "im"));
    return match ? sanitizeProbeText(match[1]) : "";
  };

  return {
    selectedFrontend: readMarker("DOCKER_COMPOSE_FRONTEND") || "unavailable",
    probeDiagnostics: {
      dockerPlugin: readMarker("DOCKER_COMPOSE_PLUGIN_PROBE"),
      standaloneV2: readMarker("DOCKER_COMPOSE_STANDALONE_PROBE"),
    },
  };
}

function classifyDockerComposeFailure(error) {
  const details = collectErrorText(error);
  if (!isDockerComposeUnavailableOutput(details)) {
    return null;
  }

  const diagnostics = parseDockerComposeDiagnostics(details);
  const message =
    "Docker is running, but no usable Docker Compose v2 frontend is available.";
  return {
    code: "docker_compose_unavailable",
    message,
    error: message,
    details,
    selectedFrontend: diagnostics.selectedFrontend,
    probeDiagnostics: diagnostics.probeDiagnostics,
  };
}

async function runComposeProbe(execAsync, command) {
  try {
    const { stdout, stderr } = await execAsync(command);
    const output = sanitizeProbeText([stdout, stderr].filter(Boolean).join("\n"));
    return {
      available: isComposeV2OrNewer(output),
      output,
    };
  } catch (error) {
    return {
      available: false,
      output: sanitizeProbeText(collectErrorText(error)),
    };
  }
}

async function probeDockerComposeFrontend(execAsync) {
  if (typeof execAsync !== "function") {
    throw new TypeError("execAsync (function) is required");
  }

  const dockerPlugin = await runComposeProbe(execAsync, "docker compose version");
  if (dockerPlugin.available) {
    return {
      available: true,
      selectedFrontend: "docker-plugin",
      probeDiagnostics: {
        dockerPlugin: dockerPlugin.output,
        standaloneV2: "",
      },
    };
  }

  const standaloneV2 = await runComposeProbe(execAsync, "docker-compose version");
  return {
    available: standaloneV2.available,
    selectedFrontend: standaloneV2.available ? "standalone-v2" : "unavailable",
    probeDiagnostics: {
      dockerPlugin: dockerPlugin.output,
      standaloneV2: standaloneV2.output,
    },
  };
}

async function waitForDockerComposeFrontendReady(execAsync, options = {}) {
  const parsedAttempts = Number.parseInt(String(options.attempts ?? 30), 10);
  const parsedDelayMs = Number.parseInt(String(options.delayMs ?? 1000), 10);
  const attempts = Math.max(
    1,
    Number.isFinite(parsedAttempts) ? parsedAttempts : 30,
  );
  const delayMs = Math.max(
    0,
    Number.isFinite(parsedDelayMs) ? parsedDelayMs : 1000,
  );

  let lastProbe = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    lastProbe = await probeDockerComposeFrontend(execAsync);
    if (lastProbe.available) {
      return lastProbe;
    }
    if (attempt + 1 < attempts && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return lastProbe;
}

async function waitForContainerRunning(execAsync, containerName, options = {}) {
  if (typeof execAsync !== "function") {
    throw new TypeError("execAsync (function) is required");
  }
  if (!containerName || typeof containerName !== "string") {
    throw new TypeError("containerName (string) is required");
  }

  const attempts = Math.max(
    1,
    Number.parseInt(String(options.attempts ?? 20), 10) || 20,
  );
  const delayMs = Math.max(
    0,
    Number.parseInt(String(options.delayMs ?? 500), 10) || 500,
  );

  let lastStatus = "unknown";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { stdout } = await execAsync(
      `docker inspect --format '{{.State.Status}}' ${containerName} 2>/dev/null || echo "not_found"`,
    );
    lastStatus = String(stdout || "").trim() || "unknown";
    if (lastStatus === "running") {
      return { running: true, lastStatus };
    }
    if (attempt + 1 < attempts && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return { running: false, lastStatus };
}

async function waitForContainersRunning(execAsync, containerNames, options = {}) {
  if (typeof execAsync !== "function") {
    throw new TypeError("execAsync (function) is required");
  }
  if (!Array.isArray(containerNames) || containerNames.length === 0) {
    throw new TypeError("containerNames (string[]) is required");
  }

  const normalizedContainerNames = containerNames.filter(
    (containerName) => typeof containerName === "string" && containerName.trim(),
  );
  if (normalizedContainerNames.length === 0) {
    throw new TypeError("containerNames (string[]) is required");
  }

  return Promise.all(
    normalizedContainerNames.map(async (containerName) => ({
      containerName,
      ...(await waitForContainerRunning(execAsync, containerName, options)),
    })),
  );
}

module.exports = {
  buildClearVolumeContentsCommand,
  buildForceRemoveContainerCommand,
  buildListComposeVolumeCommand,
  buildRemoveVolumeCommand,
  buildUpContainerCommand,
  buildUpContainersCommand,
  classifyDockerComposeFailure,
  collectErrorText,
  isComposeV2OrNewer,
  isDockerComposeUnavailableOutput,
  parseComposeMajorVersion,
  parseDockerComposeDiagnostics,
  probeDockerComposeFrontend,
  sanitizeProbeText,
  waitForContainerRunning,
  waitForContainersRunning,
  waitForDockerComposeFrontendReady,
};
