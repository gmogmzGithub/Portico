const {
  SYSTEM_PATH_FALLBACK,
  buildEnhancedPath,
} = require("./env-paths");
const {
  buildRuntimeSecretEnv,
  discoverSensitiveRequiredEnvVars,
} = require("../config/runtime-secrets-config");

function isTruthyFlag(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

function applyPackagedRuntimeEnv(
  env,
  { isPackagedApp = false, resourcesPath = process.resourcesPath } = {},
) {
  const nextEnv = { ...env };

  nextEnv.HOST_MCP_IS_PACKAGED = isPackagedApp ? "1" : "0";
  if (isPackagedApp && typeof resourcesPath === "string" && resourcesPath) {
    nextEnv.HOST_MCP_RESOURCES_ROOT = resourcesPath;
  } else {
    delete nextEnv.HOST_MCP_RESOURCES_ROOT;
  }

  return nextEnv;
}

function createRuntimeShellEnv({
  baseEnv = process.env,
  overrides = {},
  isPackagedApp = false,
  resourcesPath = process.resourcesPath,
  includeColor = true,
  term = "xterm-256color",
} = {}) {
  const runtimeSecrets = buildRuntimeSecretEnv({
    env: {
      ...baseEnv,
      ...overrides,
    },
    projectRoot:
      overrides.PROJECT_ROOT ||
      baseEnv.PROJECT_ROOT ||
      overrides.HOST_PROJECT_ROOT ||
      baseEnv.HOST_PROJECT_ROOT ||
      process.cwd(),
    resourcesPath,
    managedRoot:
      overrides.PORTICO_MANAGED_ROOT ||
      baseEnv.PORTICO_MANAGED_ROOT ||
      undefined,
    isPackagedApp,
  });
  const env = {
    ...baseEnv,
    ...runtimeSecrets,
    ...overrides,
  };

  // CLOUDSMITH_API_KEY is the privileged upload/release key. Packaged DMG
  // builds must never forward it to child processes regardless of env; the
  // opt-in flag only applies outside packaged builds (local dev + CI tooling).
  if (isPackagedApp || !isTruthyFlag(env.PORTICO_ALLOW_RUNTIME_CLOUDSMITH_API_KEY)) {
    delete env.CLOUDSMITH_API_KEY;
  }

  // Slack now uses a public PKCE client ID in its fragment. Do not forward
  // stale confidential-client credentials from the launcher environment into
  // compose/startup child processes.
  delete env.SLACK_OAUTH_CLIENT_ID;
  delete env.SLACK_OAUTH_CLIENT_SECRET;
  delete env.SLACK_OAUTH_CLIENT_ID_FILE;
  delete env.SLACK_OAUTH_CLIENT_SECRET_FILE;

  const projectRoot =
    overrides.PROJECT_ROOT ||
    baseEnv.PROJECT_ROOT ||
    overrides.HOST_PROJECT_ROOT ||
    baseEnv.HOST_PROJECT_ROOT ||
    process.cwd();
  for (const key of discoverSensitiveRequiredEnvVars({ projectRoot })) {
    delete env[key];
  }

  env.PATH = buildEnhancedPath(env.PATH || baseEnv.PATH || "");
  if (includeColor && env.FORCE_COLOR == null) {
    env.FORCE_COLOR = "1";
  }
  if (term && env.TERM == null) {
    env.TERM = term;
  }

  return applyPackagedRuntimeEnv(env, {
    isPackagedApp,
    resourcesPath,
  });
}

module.exports = {
  SYSTEM_PATH_FALLBACK,
  buildEnhancedPath,
  applyPackagedRuntimeEnv,
  createRuntimeShellEnv,
};
