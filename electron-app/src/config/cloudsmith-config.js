/**
 * Cloudsmith configuration.
 *
 * Runtime behavior:
 * - `CLOUDSMITH_API_KEY` authenticates package discovery requests.
 * - `CLOUDSMITH_ENTITLEMENT_TOKEN` authenticates raw package downloads.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  DEFAULT_MANAGED_ROOT,
  resolveCloudsmithApiKey,
  resolveCloudsmithEntitlementToken,
} = require("./runtime-secrets-config");

function detectIsPackagedApp() {
  try {
    // electron is only available inside the main-process runtime. In unit
    // tests or worker contexts it throws, which we treat as unpackaged.
    const { app } = require("electron");
    return Boolean(app && app.isPackaged);
  } catch (_error) {
    return false;
  }
}

const DEFAULTS = Object.freeze({
  CLOUDSMITH_OWNER: "portico",
  CLOUDSMITH_REPO: "portico",
  CLOUDSMITH_API_BASE: "https://api.cloudsmith.io/v1",
  CLOUDSMITH_DL_BASE: "https://dl.artifacts.example.invalid",
});

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseEnvFile(filePath) {
  const parsed = {};
  if (!filePath) {
    return parsed;
  }

  try {
    const content = fs.readFileSync(filePath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const match = trimmed.match(/^([A-Z_]+)="?([^"]*)"?$/);
      if (match) {
        parsed[match[1]] = match[2];
      }
    }
  } catch (_error) {
    return parsed;
  }
  return parsed;
}

function cloudsmithEnvFileCandidates() {
  const candidates = [
    path.resolve(__dirname, "..", "..", "..", "cloudsmith.env"),
    path.join(os.homedir(), "portico", "portico-managed", "cloudsmith.env"),
  ];
  if (process.resourcesPath) {
    candidates.unshift(path.join(process.resourcesPath, "cloudsmith.env"));
  }
  return candidates;
}

function findCloudsmithEnvFile() {
  return cloudsmithEnvFileCandidates().find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

const cloudsmithDefaults = parseEnvFile(findCloudsmithEnvFile());
const managedRoot = process.env.PORTICO_MANAGED_ROOT || DEFAULT_MANAGED_ROOT;
const projectRoot = path.resolve(__dirname, "..", "..", "..");
const isPackagedApp = detectIsPackagedApp();
const readToken = resolveCloudsmithEntitlementToken({
  env: process.env,
  projectRoot,
  resourcesPath: process.resourcesPath,
  managedRoot,
  isPackagedApp,
});
const runtimeCloudsmithApiKey = isPackagedApp
  ? resolveCloudsmithApiKey({
      env: process.env,
      resourcesPath: process.resourcesPath,
      managedRoot,
      isPackagedApp,
      platform: process.platform,
      throwOnPersistenceFailure: process.platform === "darwin",
    })
  : normalizeString(process.env.CLOUDSMITH_API_KEY) ||
    normalizeString(cloudsmithDefaults.CLOUDSMITH_API_KEY);

function resolveCloudsmithApiBase() {
  return (
    normalizeString(process.env.CLOUDSMITH_API_BASE) ||
    normalizeString(cloudsmithDefaults.CLOUDSMITH_API_BASE) ||
    DEFAULTS.CLOUDSMITH_API_BASE
  );
}

function deriveCloudsmithApiV2Base(v1Base) {
  const normalized = normalizeString(v1Base).replace(/\/+$/, "");
  if (/\/v1$/.test(normalized)) {
    return normalized.replace(/\/v1$/, "/v2");
  }
  return "https://api.cloudsmith.io/v2";
}

const cloudsmithApiBase = resolveCloudsmithApiBase();

module.exports = {
  CLOUDSMITH_OWNER:
    normalizeString(process.env.CLOUDSMITH_OWNER) ||
    normalizeString(cloudsmithDefaults.CLOUDSMITH_OWNER) ||
    DEFAULTS.CLOUDSMITH_OWNER,
  CLOUDSMITH_REPO:
    normalizeString(process.env.CLOUDSMITH_REPO) ||
    normalizeString(cloudsmithDefaults.CLOUDSMITH_REPO) ||
    DEFAULTS.CLOUDSMITH_REPO,
  CLOUDSMITH_API_BASE: cloudsmithApiBase,
  CLOUDSMITH_API_V2_BASE:
    normalizeString(process.env.CLOUDSMITH_API_V2_BASE) ||
    normalizeString(cloudsmithDefaults.CLOUDSMITH_API_V2_BASE) ||
    deriveCloudsmithApiV2Base(cloudsmithApiBase),
  CLOUDSMITH_DL_BASE:
    normalizeString(process.env.CLOUDSMITH_DL_BASE) ||
    normalizeString(cloudsmithDefaults.CLOUDSMITH_DL_BASE) ||
    DEFAULTS.CLOUDSMITH_DL_BASE,
  CLOUDSMITH_ENTITLEMENT_TOKEN: readToken,
  CLOUDSMITH_READ_TOKEN: runtimeCloudsmithApiKey,
  CLOUDSMITH_API_KEY: runtimeCloudsmithApiKey,
};
