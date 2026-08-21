const path = require("node:path");

const {
  DEFAULT_MANAGED_ROOT,
  upsertRuntimeSecret,
  stripLegacyPorticoLlmApiKeyFromRuntimeFiles,
} = require("../config/runtime-secrets-config");
const { runVaultLlmPreflight } = require("./vault-llm-key");

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function buildProvisioningError(message, code, details = null) {
  const error = new Error(message);
  error.code = code;
  if (details && typeof details === "object") {
    error.details = details;
  }
  return error;
}

async function provisionPorticoLlmApiKeyFromSetupAuth({
  setupAuthService,
  env = process.env,
  projectRoot = env.PROJECT_ROOT || process.cwd(),
  managedRoot = env.PORTICO_MANAGED_ROOT || DEFAULT_MANAGED_ROOT,
  resourcesPath = process.resourcesPath,
  logger = console,
  preflight = runVaultLlmPreflight,
  persistRuntimeSecret = upsertRuntimeSecret,
  stripLegacyRuntimeFiles = stripLegacyPorticoLlmApiKeyFromRuntimeFiles,
} = {}) {
  if (
    !setupAuthService ||
    typeof setupAuthService.getAuthorizedSession !== "function"
  ) {
    throw buildProvisioningError(
      "Setup auth service cannot supply an authorized session for Vault provisioning",
      "vault_setup_auth_unavailable",
    );
  }

  const session = await setupAuthService.getAuthorizedSession();
  const idToken = normalizeString(session?.idToken);
  if (!idToken) {
    throw buildProvisioningError(
      "Setup auth session does not include id_token needed for Vault JWT auth",
      "vault_missing_id_token",
    );
  }

  const preflightResult = await preflight({
    idToken,
    env,
  });
  logger.info?.(
    `[VaultLLM] Preflight health reachable=${Boolean(
      preflightResult?.health?.reachable,
    )} status=${preflightResult?.health?.statusCode || "unknown"} vaultAddr=${preflightResult?.vaultAddr || env.VAULT_ADDR || "https://vault.example.invalid"}`,
  );
  if (!preflightResult?.success || !preflightResult?.key) {
    throw buildProvisioningError(
      preflightResult?.error || "Vault preflight failed to produce PORTICO_LLM_API_KEY",
      preflightResult?.errorCode || "vault_preflight_failed",
      {
        health: preflightResult?.health || null,
        details: preflightResult?.details || null,
        vaultAddr: preflightResult?.vaultAddr || null,
      },
    );
  }

  const key = normalizeString(preflightResult.key);
  if (!key) {
    throw buildProvisioningError(
      "Vault returned an empty PORTICO_LLM_API_KEY value",
      "vault_key_empty",
    );
  }

  persistRuntimeSecret("PORTICO_LLM_API_KEY", key, {
    env,
    projectRoot: path.resolve(projectRoot),
    resourcesPath,
    managedRoot,
  });
  process.env.PORTICO_LLM_API_KEY = key;

  const strippedFiles = stripLegacyRuntimeFiles({
    env,
    managedRoot,
    projectRoot: path.resolve(projectRoot),
    resourcesPath,
  });

  return {
    success: true,
    keySource: "vault",
    vaultAddr: preflightResult.vaultAddr,
    role: preflightResult.role,
    secretPath: preflightResult.secretPath,
    secretField: preflightResult.secretField,
    strippedFiles,
  };
}

module.exports = {
  buildProvisioningError,
  provisionPorticoLlmApiKeyFromSetupAuth,
};
