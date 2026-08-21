const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

const readServerDisplayName = (configPath, serverId) => {
  try {
    const metadata = yaml.load(fs.readFileSync(configPath, "utf8")) || {};
    return String(metadata.display_name || metadata.name || serverId).trim() || serverId;
  } catch {
    return serverId;
  }
};

async function listMcpServerCatalog(projectRoot, options = {}) {
  const readdir = options.readdir || fs.promises.readdir;
  const access = options.access || fs.promises.access;
  const resolveDisplayName = options.resolveDisplayName || readServerDisplayName;
  const catalog = [];
  const seenServerIds = new Set();
  const configDirectories = ["mcp-configs", "mcp-configs-user"];

  for (const directory of configDirectories) {
    const configRoot = path.join(projectRoot, directory);
    let entries;
    try {
      entries = await readdir(configRoot, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || seenServerIds.has(entry.name)) {
        continue;
      }

      const serverId = entry.name;
      // A bundled directory owns its namespace even if its files are incomplete.
      seenServerIds.add(serverId);
      const serverRoot = path.join(configRoot, serverId);
      const yamlPath = path.join(serverRoot, `${serverId}.yaml`);
      const fragmentPath = path.join(serverRoot, `${serverId}.fragment`);
      let configPath = null;

      try {
        await access(yamlPath);
        configPath = yamlPath;
      } catch {
        try {
          await access(fragmentPath);
          configPath = fragmentPath;
        } catch {
          continue;
        }
      }

      catalog.push({
        id: serverId,
        display_name: resolveDisplayName(configPath, serverId),
      });
    }
  }

  return catalog;
}

module.exports = {
  listMcpServerCatalog,
  readServerDisplayName,
};
