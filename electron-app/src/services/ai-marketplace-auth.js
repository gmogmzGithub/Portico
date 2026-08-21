// AI Marketplace API key storage delegates to the shared runtime-secret stack.
// Spans the State & Persistence layer and preserves the existing module surface.

const {
  DEFAULT_MANAGED_ROOT,
  deleteRuntimeSecret,
  resolveAiMarketplaceApiKey,
  upsertRuntimeSecret,
} = require("../config/runtime-secrets-config");

const DEFAULT_KEYCHAIN_SERVICE = "portico";
const DEFAULT_KEYCHAIN_ACCOUNT = "AI_MARKETPLACE_API_KEY";

function isSupportedPlatform(platform = process.platform) {
  return platform === "darwin";
}

function normalize(value) {
  return typeof value === "string" ? value.trim() : "";
}

function getKeychainCoordinates() {
  return {
    service: DEFAULT_KEYCHAIN_SERVICE,
    account: DEFAULT_KEYCHAIN_ACCOUNT,
  };
}

function clearCache() {}

function buildRuntimeSecretOptions({
  env = process.env,
  projectRoot = null,
  resourcesPath = process.resourcesPath,
  managedRoot = env.PORTICO_MANAGED_ROOT || DEFAULT_MANAGED_ROOT,
} = {}) {
  return {
    env,
    projectRoot,
    resourcesPath,
    managedRoot,
  };
}

function readApiKeySync(options = {}) {
  if (!isSupportedPlatform(options.platform)) {
    return "";
  }

  return normalize(resolveAiMarketplaceApiKey(buildRuntimeSecretOptions(options)));
}

async function readApiKey(options = {}) {
  return readApiKeySync(options);
}

async function setApiKey(value, options = {}) {
  if (!isSupportedPlatform(options.platform)) {
    throw new Error("macOS Keychain is only available on Darwin hosts");
  }

  const normalized = normalize(value);
  if (!normalized) {
    throw new Error("AI Marketplace API key must be a non-empty string");
  }

  return upsertRuntimeSecret(
    "AI_MARKETPLACE_API_KEY",
    normalized,
    buildRuntimeSecretOptions(options),
  );
}

async function deleteApiKey(options = {}) {
  if (!isSupportedPlatform(options.platform)) {
    return false;
  }

  return deleteRuntimeSecret(
    "AI_MARKETPLACE_API_KEY",
    buildRuntimeSecretOptions(options),
  );
}

async function hasApiKey(options = {}) {
  const value = await readApiKey(options);
  return Boolean(value);
}

module.exports = {
  DEFAULT_KEYCHAIN_ACCOUNT,
  DEFAULT_KEYCHAIN_SERVICE,
  clearCache,
  deleteApiKey,
  getKeychainCoordinates,
  hasApiKey,
  isSupportedPlatform,
  readApiKey,
  readApiKeySync,
  setApiKey,
};
