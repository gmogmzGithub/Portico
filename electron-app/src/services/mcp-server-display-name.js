const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

const SAFE_SERVER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function resolveMcpServerDisplayName(projectRoot, serverId, options = {}) {
  const normalizedServerId = String(serverId || "").trim();
  if (!normalizedServerId || !SAFE_SERVER_ID_PATTERN.test(normalizedServerId)) {
    return normalizedServerId;
  }

  const existsSync = options.existsSync || fs.existsSync;
  const readFileSync = options.readFileSync || fs.readFileSync;
  const parseYaml = options.parseYaml || yaml.load;
  const logger = options.logger || console;
  const systemDirectory = path.join(
    projectRoot,
    "mcp-configs",
    normalizedServerId,
  );
  const systemYaml = path.join(
    systemDirectory,
    `${normalizedServerId}.yaml`,
  );
  const userYaml = path.join(
    projectRoot,
    "mcp-configs-user",
    normalizedServerId,
    `${normalizedServerId}.yaml`,
  );
  const yamlPath = existsSync(systemDirectory)
    ? (existsSync(systemYaml) ? systemYaml : null)
    : (existsSync(userYaml) ? userYaml : null);

  if (!yamlPath) {
    return normalizedServerId;
  }

  try {
    const metadata = parseYaml(readFileSync(yamlPath, "utf8")) || {};
    return String(
      metadata.display_name || metadata.name || normalizedServerId,
    ).trim() || normalizedServerId;
  } catch (error) {
    logger.warn?.(
      `[MCP] Could not resolve display name for ${normalizedServerId}: ${error.message}`,
    );
    return normalizedServerId;
  }
}

module.exports = {
  resolveMcpServerDisplayName,
};
