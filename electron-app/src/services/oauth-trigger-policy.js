const fs = require("node:fs");
const READINESS_PHASE_CHECKING_TOKENS = "checking_tokens";
const READINESS_PHASE_NEEDS_OAUTH = "needs_oauth";
const READINESS_PHASE_WAITING_CALLBACK = "waiting_callback";
const { canonicalizeReadinessPhase } = require("./readiness-phase");
const {
  getFragmentPathForServerYaml: defaultGetFragmentPathForServerYaml,
} = require("./mcp-bulk-toggle-results");

const RUNTIME_OAUTH_PHASES = new Set([
  READINESS_PHASE_CHECKING_TOKENS,
  READINESS_PHASE_NEEDS_OAUTH,
  READINESS_PHASE_WAITING_CALLBACK,
]);

const RUNTIME_OAUTH_STATES = new Set([
  "active",
  "waiting_callback",
  "failed",
  "timeout",
]);

function getReadinessPhase(readinessStatus = {}) {
  if (!readinessStatus || typeof readinessStatus !== "object") {
    return null;
  }
  return canonicalizeReadinessPhase(readinessStatus);
}

function hasParsedOAuthConfig(serverData) {
  const oauthConfig = serverData?.oauth;
  if (!oauthConfig) {
    return false;
  }
  if (typeof oauthConfig === "boolean") {
    return oauthConfig;
  }
  if (typeof oauthConfig === "object") {
    return Object.keys(oauthConfig).length > 0;
  }
  return false;
}

function serverUsesOAuthConfig(serverId, dependencies = {}) {
  const {
    findServerYaml,
    readFileSync,
    existsSync = fs.existsSync,
    getFragmentPathForServerYaml = defaultGetFragmentPathForServerYaml,
    parseYaml,
    logger = console,
  } = dependencies;

  if (typeof findServerYaml !== "function") {
    return false;
  }

  try {
    const yamlPath = findServerYaml(serverId);
    if (!yamlPath) {
      return false;
    }

    const content = readFileSync(yamlPath, "utf8");
    const parsed = typeof parseYaml === "function" ? parseYaml(content) : null;
    if (hasParsedOAuthConfig(parsed) || /^oauth:/m.test(content)) {
      return true;
    }

    const fragmentPath = getFragmentPathForServerYaml(yamlPath, serverId);
    if (!fragmentPath || !existsSync(fragmentPath)) {
      return false;
    }
    const fragment = JSON.parse(readFileSync(fragmentPath, "utf8"));
    return hasParsedOAuthConfig(fragment);
  } catch (error) {
    logger?.warn?.(
      `[API] Could not inspect OAuth config for ${serverId}: ${error.message}`,
    );
    return false;
  }
}

function runtimeReadinessIndicatesOAuth(readinessStatus = {}) {
  const readinessPhase = getReadinessPhase(readinessStatus);
  const oauthState = String(
    readinessStatus.oauthState || readinessStatus.oauth_state || "",
  ).toLowerCase();
  const authorizationUrlAvailable = Boolean(
    readinessStatus.authorizationUrlAvailable ??
      readinessStatus.authorization_url_available,
  );

  return (
    RUNTIME_OAUTH_PHASES.has(readinessPhase) ||
    authorizationUrlAvailable ||
    RUNTIME_OAUTH_STATES.has(oauthState)
  );
}

function canTriggerOAuthFlow({
  hasStaticOAuthConfig = false,
  readinessStatus = null,
} = {}) {
  if (hasStaticOAuthConfig) {
    return true;
  }
  return runtimeReadinessIndicatesOAuth(readinessStatus || {});
}

function getOAuthTriggerDisposition({
  hasStaticOAuthConfig = false,
  readinessStatus = null,
  forceAuth = false,
  hasUsablePersistedOAuthTokens = null,
} = {}) {
  const readinessPhase = getReadinessPhase(readinessStatus || {});

  if (readinessPhase === "disabled") {
    return { type: "disabled", readinessPhase };
  }

  if (readinessPhase === "tool_ready" && !forceAuth) {
    // For static OAuth servers, avoid "already_authorized" when token files are
    // missing or empty. This prevents stale readiness snapshots from skipping a
    // required OAuth flow and later surfacing empty/malformed bearer failures.
    if (
      hasStaticOAuthConfig &&
      hasUsablePersistedOAuthTokens === false
    ) {
      return { type: "allowed", readinessPhase };
    }
    return { type: "already_authorized", readinessPhase };
  }

  if (
    canTriggerOAuthFlow({
      hasStaticOAuthConfig,
      readinessStatus,
    })
  ) {
    return { type: "allowed", readinessPhase };
  }

  return { type: "not_oauth", readinessPhase };
}

module.exports = {
  canTriggerOAuthFlow,
  getOAuthTriggerDisposition,
  getReadinessPhase,
  hasParsedOAuthConfig,
  runtimeReadinessIndicatesOAuth,
  serverUsesOAuthConfig,
};
