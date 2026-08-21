const fs = require("node:fs");
const path = require("node:path");

const GENERATED_OAUTH_CONFIG_UNAVAILABLE =
  "generated OAuth server config is unavailable";

function normalizeServerType(value) {
  if (typeof value !== "string") {
    return "";
  }
  const normalized = value.trim();
  if (normalized === "streamable_http" || normalized === "streamablehttp") {
    return "streamable-http";
  }
  return normalized;
}

function supportsChallengeDiscoveredOAuth(serverConfig) {
  if (!serverConfig || typeof serverConfig !== "object") {
    return false;
  }
  const serverType = normalizeServerType(serverConfig.type);
  return (
    serverType === "streamable-http" ||
    serverType === "sse" ||
    (Object.hasOwn(serverConfig, "http_subprocess") &&
      serverConfig.http_subprocess !== null)
  );
}

function prepareOAuthBrokerServerConfig(serverConfig) {
  if (!serverConfig || typeof serverConfig !== "object") {
    return null;
  }
  if (serverConfig.oauth) {
    return serverConfig;
  }
  if (!supportsChallengeDiscoveredOAuth(serverConfig)) {
    return null;
  }

  // Challenge-discovered OAuth intentionally has no explicit oauth block in
  // the persisted fragment. The Rust broker still needs an OAuth object so it
  // can use memory-only storage and rediscover metadata from the MCP URL.
  // Synthesize it only for the broker response; never rewrite user config.
  return {
    ...serverConfig,
    oauth: {},
  };
}

function loadGeneratedMcpServerConfig(serverId, projectRoot) {
  const candidates = [
    path.join(projectRoot, "mcpo-configs-generated", `${serverId}.json`),
    path.join(projectRoot, "mcpo-configs-generated", `core-${serverId}.json`),
    path.join(projectRoot, "mcpo-configs-generated", `single-${serverId}.json`),
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
    const servers = parsed?.mcpServers || {};
    const serverConfig = servers[serverId] || Object.values(servers)[0];
    const prepared = prepareOAuthBrokerServerConfig(serverConfig);
    if (prepared) {
      return prepared;
    }
  }
  throw new Error(GENERATED_OAUTH_CONFIG_UNAVAILABLE);
}

module.exports = {
  GENERATED_OAUTH_CONFIG_UNAVAILABLE,
  loadGeneratedMcpServerConfig,
  normalizeServerType,
  prepareOAuthBrokerServerConfig,
  supportsChallengeDiscoveredOAuth,
};
