const path = require("path");

const LEGACY_GATEWAY_INSPECT_TIMEOUT_MS = 5000;
const APP_COMPOSE_PROJECT_LABEL = "com.docker.compose.project";
const APP_COMPOSE_SERVICE_LABEL = "com.docker.compose.service";
const APP_COMPOSE_PROJECT = "portico";
const GATEWAY_COMPOSE_SERVICE = "llm-gateway";
const GATEWAY_REPORTING_DESTINATION = "/app/reporting";

function dedupeReportingRoots(candidates) {
  const seen = new Set();
  const roots = [];
  for (const candidate of candidates || []) {
    const normalized = String(candidate || "").trim();
    if (!normalized) continue;
    const key = path.resolve(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(normalized);
  }
  return roots;
}

function resolveRuntimeCostReportingHostDir({
  env = process.env,
  isPackagedApp = false,
  projectRoot = "",
  userDataPath = "",
} = {}) {
  const configuredRoot = String(env?.PORTICO_COST_REPORTING_HOST_DIR || "").trim();
  if (configuredRoot) {
    return configuredRoot;
  }

  if (isPackagedApp) {
    const normalizedUserDataPath = String(userDataPath || "").trim();
    if (normalizedUserDataPath) {
      return path.join(normalizedUserDataPath, "reporting");
    }
  }

  const normalizedProjectRoot = String(projectRoot || "").trim() || process.cwd();
  return path.join(normalizedProjectRoot, "open-webui-data", "reporting");
}

function collectRuntimeReportingCleanupRoots({
  env = process.env,
  isPackagedApp = false,
  projectRoot = "",
  userDataPath = "",
} = {}) {
  const candidates = [
    resolveRuntimeCostReportingHostDir({
      env,
      isPackagedApp,
      projectRoot,
      userDataPath,
    }),
  ];
  const normalizedUserDataPath = String(userDataPath || "").trim();
  if (normalizedUserDataPath) {
    candidates.push(path.join(normalizedUserDataPath, "reporting"));
  }
  const normalizedProjectRoot = String(projectRoot || "").trim();
  if (normalizedProjectRoot) {
    candidates.push(
      path.join(normalizedProjectRoot, "open-webui-data", "reporting"),
    );
  }
  return dedupeReportingRoots(candidates);
}

async function removeLegacyRequestPayloadsFromRoots(
  reportingRoots,
  { fsPromises = require("fs").promises } = {},
) {
  let ensuredAbsent = 0;
  let failures = 0;
  const roots = dedupeReportingRoots(reportingRoots);

  for (const root of roots) {
    try {
      await fsPromises.rm(path.join(root, "payloads"), {
        recursive: true,
        force: true,
      });
      ensuredAbsent += 1;
    } catch {
      failures += 1;
    }
  }

  return { attempted: roots.length, ensuredAbsent, failures };
}

function extractAppOwnedGatewayReportingBinds(inspection) {
  const labels = inspection?.Config?.Labels || {};
  if (
    labels[APP_COMPOSE_PROJECT_LABEL] !== APP_COMPOSE_PROJECT ||
    labels[APP_COMPOSE_SERVICE_LABEL] !== GATEWAY_COMPOSE_SERVICE
  ) {
    return [];
  }

  return dedupeReportingRoots(
    (Array.isArray(inspection?.Mounts) ? inspection.Mounts : [])
      .filter(
        (candidate) =>
          candidate?.Type === "bind" &&
          candidate?.Destination === GATEWAY_REPORTING_DESTINATION &&
          typeof candidate?.Source === "string" &&
          candidate.Source.trim(),
      )
      .map((candidate) => candidate.Source.trim()),
  );
}

async function collectAppOwnedGatewayReportingRoots({
  execFileAsync,
  timeoutMs = LEGACY_GATEWAY_INSPECT_TIMEOUT_MS,
} = {}) {
  if (typeof execFileAsync !== "function") {
    return { roots: [], failures: 1 };
  }

  let containerIds;
  try {
    const { stdout } = await execFileAsync(
      "docker",
      [
        "ps",
        "-a",
        "-q",
        "--filter",
        `label=${APP_COMPOSE_PROJECT_LABEL}=${APP_COMPOSE_PROJECT}`,
        "--filter",
        `label=${APP_COMPOSE_SERVICE_LABEL}=${GATEWAY_COMPOSE_SERVICE}`,
      ],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
    );
    containerIds = [...new Set(String(stdout || "").split(/\s+/).filter(Boolean))];
  } catch {
    return { roots: [], failures: 1 };
  }

  if (containerIds.length === 0) {
    return { roots: [], failures: 0 };
  }

  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["inspect", "--type", "container", ...containerIds],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
    );
    const inspections = JSON.parse(stdout);
    if (!Array.isArray(inspections)) {
      return { roots: [], failures: 1 };
    }
    return {
      roots: dedupeReportingRoots(
        inspections.flatMap(extractAppOwnedGatewayReportingBinds),
      ),
      failures: 0,
    };
  } catch {
    return { roots: [], failures: 1 };
  }
}

module.exports = {
  LEGACY_GATEWAY_INSPECT_TIMEOUT_MS,
  collectAppOwnedGatewayReportingRoots,
  collectRuntimeReportingCleanupRoots,
  dedupeReportingRoots,
  extractAppOwnedGatewayReportingBinds,
  removeLegacyRequestPayloadsFromRoots,
  resolveRuntimeCostReportingHostDir,
};
