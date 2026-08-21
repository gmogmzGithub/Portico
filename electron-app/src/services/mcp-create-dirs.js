const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const yaml = require("js-yaml");

const MCP_CONFIG_DIR_NAMES = Object.freeze(["mcp-configs", "mcp-configs-user"]);

function expandCreateDirPath(projectRoot, rawDir, options = {}) {
  const dir = String(rawDir || "").trim();
  if (!dir) {
    throw new Error("create_dirs entries must be non-empty strings");
  }

  if (dir === "~" || dir.startsWith("~/")) {
    const homeDir = options.homeDir || os.homedir() || process.env.HOME;
    if (!homeDir) {
      throw new Error(`create_dirs path '${dir}' uses '~' but HOME is not set`);
    }
    return dir === "~"
      ? path.resolve(homeDir)
      : path.resolve(homeDir, dir.slice(2));
  }

  if (dir.startsWith("~")) {
    throw new Error(`create_dirs path '${dir}' uses unsupported '~user' expansion`);
  }

  return path.isAbsolute(dir)
    ? path.resolve(dir)
    : path.resolve(projectRoot, dir);
}

function readServerYaml(yamlPath, options = {}) {
  const fsModule = options.fsModule || fs;
  const yamlModule = options.yamlModule || yaml;
  return yamlModule.load(fsModule.readFileSync(yamlPath, "utf8")) || {};
}

function discoverServerYamlPaths(projectRoot, options = {}) {
  const fsModule = options.fsModule || fs;
  const configDirNames = options.configDirNames || MCP_CONFIG_DIR_NAMES;
  const yamlPaths = [];

  for (const dirName of configDirNames) {
    const root = path.join(projectRoot, dirName);
    let entries;
    try {
      entries = fsModule.readdirSync(root, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== "ENOENT") {
        options.logger?.warn?.(
          `[MCP create_dirs] Failed to scan ${root}: ${error.message}`,
        );
      }
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const yamlPath = path.join(root, entry.name, `${entry.name}.yaml`);
      if (fsModule.existsSync(yamlPath)) {
        yamlPaths.push(yamlPath);
      }
    }
  }

  return yamlPaths;
}

function ensureMcpCreateDirs(projectRoot, options = {}) {
  if (!projectRoot || typeof projectRoot !== "string") {
    throw new TypeError("projectRoot (string) is required");
  }

  const fsModule = options.fsModule || fs;
  const logger = options.logger || console;
  const seenDirs = new Set();
  const result = {
    scannedServers: 0,
    ensuredDirs: [],
    skipped: [],
    errors: [],
  };

  for (const yamlPath of discoverServerYamlPaths(projectRoot, options)) {
    result.scannedServers += 1;
    let serverConfig;
    try {
      serverConfig = readServerYaml(yamlPath, options);
    } catch (error) {
      result.errors.push({ yamlPath, error: error.message });
      logger.warn?.(
        `[MCP create_dirs] Failed to parse ${yamlPath}: ${error.message}`,
      );
      continue;
    }

    if (serverConfig.create_dirs == null) {
      continue;
    }
    if (!Array.isArray(serverConfig.create_dirs)) {
      result.skipped.push({
        yamlPath,
        reason: "create_dirs must be a list",
      });
      logger.warn?.(
        `[MCP create_dirs] Ignoring ${yamlPath}: create_dirs must be a list`,
      );
      continue;
    }

    for (const entry of serverConfig.create_dirs) {
      if (typeof entry !== "string" || !entry.trim()) {
        result.skipped.push({
          yamlPath,
          entry,
          reason: "create_dirs entries must be non-empty strings",
        });
        logger.warn?.(
          `[MCP create_dirs] Ignoring invalid create_dirs entry in ${yamlPath}`,
        );
        continue;
      }

      let dirPath;
      try {
        dirPath = expandCreateDirPath(projectRoot, entry, options);
      } catch (error) {
        result.skipped.push({ yamlPath, entry, reason: error.message });
        logger.warn?.(`[MCP create_dirs] ${error.message}`);
        continue;
      }

      if (seenDirs.has(dirPath)) {
        continue;
      }
      seenDirs.add(dirPath);

      try {
        fsModule.mkdirSync(dirPath, { recursive: true });
        result.ensuredDirs.push(dirPath);
      } catch (error) {
        result.errors.push({ yamlPath, entry, dirPath, error: error.message });
        logger.warn?.(
          `[MCP create_dirs] Failed to create ${dirPath}: ${error.message}`,
        );
      }
    }
  }

  if (result.ensuredDirs.length > 0) {
    logger.log?.(
      `[MCP create_dirs] Ensured ${result.ensuredDirs.length} director${
        result.ensuredDirs.length === 1 ? "y" : "ies"
      }`,
    );
  }

  return result;
}

// Never-throw variant for service-initialization and generator-invocation
// paths: those flows must not abort on create_dirs problems. Failures are
// warn-logged and, when options.sendInitLog is provided, surfaced to the
// loading screen as a single warning line.
function tryEnsureMcpCreateDirs(projectRoot, options = {}) {
  const logger = options.logger || console;
  const sendInitLog = options.sendInitLog;
  let result;
  try {
    result = ensureMcpCreateDirs(projectRoot, options);
  } catch (error) {
    result = {
      scannedServers: 0,
      ensuredDirs: [],
      skipped: [],
      errors: [{ error: error.message }],
    };
    logger.warn?.(`[MCP create_dirs] Skipped: ${error.message}`);
  }

  if (result.errors.length > 0) {
    sendInitLog?.(
      `[WARN] MCP create_dirs: ${result.errors.length} director${
        result.errors.length === 1 ? "y" : "ies"
      } could not be prepared (see app log)\n`,
      "warning",
    );
  }

  return result;
}

module.exports = {
  MCP_CONFIG_DIR_NAMES,
  discoverServerYamlPaths,
  ensureMcpCreateDirs,
  expandCreateDirPath,
  tryEnsureMcpCreateDirs,
};
