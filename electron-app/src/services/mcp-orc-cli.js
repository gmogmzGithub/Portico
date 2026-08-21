const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { exec: execCallback } = require("node:child_process");
const { promisify } = require("node:util");

const { tryEnsureMcpCreateDirs } = require("./mcp-create-dirs");

const DEFAULT_MCP_ORC_BOOTSTRAP_TIMEOUT_MS = 15 * 60 * 1000;

function escapeShellArg(value) {
  return `"${String(value).replace(/(["\\$`])/g, "\\$1")}"`;
}

function hostMcpCurrentTargetTriple({
  platform = process.platform,
  arch = process.arch,
} = {}) {
  switch (`${platform}:${arch}`) {
    case "darwin:arm64":
      return "aarch64-apple-darwin";
    case "darwin:x64":
      return "x86_64-apple-darwin";
    case "linux:x64":
      return "x86_64-unknown-linux-gnu";
    case "linux:arm64":
      return "aarch64-unknown-linux-gnu";
    default:
      return `${platform}-${arch}`;
  }
}

function hostMcpPlatformTag({
  platform = process.platform,
  arch = process.arch,
} = {}) {
  return `${platform}-${arch}`;
}

function normalizeBundlePathForComparison(filePath) {
  return typeof filePath === "string" ? filePath.replace(/\\/g, "/") : "";
}

function isElectronDistributionBundlePath(filePath) {
  const normalizedPath = normalizeBundlePathForComparison(filePath);
  return normalizedPath.includes(
    "/node_modules/electron/dist/Electron.app/Contents/",
  );
}

function isDevElectronDistributionRun({
  resourcesPath = process.resourcesPath,
  execPath = process.execPath,
} = {}) {
  return (
    isElectronDistributionBundlePath(resourcesPath) ||
    isElectronDistributionBundlePath(execPath)
  );
}

function isPackagedMacAppRun({
  platform = process.platform,
  resourcesPath = process.resourcesPath,
  execPath = process.execPath,
  defaultApp = process.defaultApp,
  isPackagedApp,
} = {}) {
  if (platform !== "darwin") {
    return false;
  }

  if (typeof isPackagedApp === "boolean") {
    return isPackagedApp;
  }

  if (defaultApp === true) {
    return false;
  }

  if (isDevElectronDistributionRun({ resourcesPath, execPath })) {
    return false;
  }

  const normalizedResourcesPath = typeof resourcesPath === "string" ? resourcesPath : "";
  const normalizedExecPath = typeof execPath === "string" ? execPath : "";
  return (
    normalizedResourcesPath.includes(".app/Contents/Resources") ||
    normalizedExecPath.includes(".app/Contents/MacOS")
  );
}

function hostMcpBinaryCacheDir({
  env = process.env,
  homedir = os.homedir(),
  platform = process.platform,
} = {}) {
  if (env.HOST_MCP_BIN_ROOT) {
    return env.HOST_MCP_BIN_ROOT;
  }

  if (platform === "darwin") {
    return path.join(homedir, "Library", "Application Support", "portico", "bin");
  }

  return path.join(
    env.XDG_DATA_HOME || path.join(homedir, ".local", "share"),
    "portico",
    "bin",
  );
}

function isExecutableFile(filePath) {
  if (!filePath || typeof filePath !== "string") {
    return false;
  }
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch (_error) {
    return false;
  }
}

function isTrackedRustSourceFile(filePath) {
  return (
    filePath.endsWith(".rs") ||
    filePath.endsWith(`${path.sep}Cargo.toml`) ||
    filePath.endsWith(`${path.sep}Cargo.lock`)
  );
}

function directoryContainsNewerRustSource(rootDir, binaryMtimeMs) {
  const pending = [rootDir];

  while (pending.length > 0) {
    const currentDir = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (_error) {
      return true;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }

      if (!entry.isFile() || !isTrackedRustSourceFile(entryPath)) {
        continue;
      }

      try {
        if (fs.statSync(entryPath).mtimeMs > binaryMtimeMs) {
          return true;
        }
      } catch (_error) {
        return true;
      }
    }
  }

  return false;
}

function isBinaryCurrent(projectRoot, binaryPath) {
  if (!isExecutableFile(binaryPath)) {
    return false;
  }

  const rustRoot = path.join(projectRoot, "src", "mcp-orc-rust");
  let binaryStat;
  try {
    binaryStat = fs.statSync(binaryPath);
  } catch (_error) {
    return false;
  }

  try {
    if (!fs.statSync(rustRoot).isDirectory()) {
      return false;
    }
  } catch (_error) {
    return false;
  }

  return !directoryContainsNewerRustSource(rustRoot, binaryStat.mtimeMs);
}

function resolvePathExecutable(commandName, {
  env = process.env,
} = {}) {
  const searchPath = env.PATH || "";
  for (const segment of searchPath.split(path.delimiter)) {
    if (!segment) {
      continue;
    }
    const candidate = path.join(segment, commandName);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

function getMcpOrcBinaryCandidates(projectRoot, {
  resourcesPath = process.resourcesPath,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  homedir = os.homedir(),
  execPath = process.execPath,
  defaultApp = process.defaultApp,
  isPackagedApp,
} = {}) {
  const targetTriple = hostMcpCurrentTargetTriple({ platform, arch });
  const platformTag = hostMcpPlatformTag({ platform, arch });
  const cacheDir = hostMcpBinaryCacheDir({ env, homedir, platform });
  const packagedMacAppRun = isPackagedMacAppRun({
    platform,
    resourcesPath,
    execPath,
    defaultApp,
    isPackagedApp,
  });
  const allowBundledResourcesCandidate =
    Boolean(resourcesPath) &&
    (packagedMacAppRun || !isDevElectronDistributionRun({ resourcesPath, execPath }));
  const bundledBinary = allowBundledResourcesCandidate
    ? path.join(resourcesPath, "host-mcp-binaries", targetTriple, "mcp-orc")
    : null;

  if (packagedMacAppRun) {
    return [bundledBinary].filter(Boolean);
  }

  return [
    path.join(projectRoot, "src", "mcp-orc-rust", "target", "debug", "mcp-orc"),
    path.join(projectRoot, "src", "mcp-orc-rust", "target", "release", "mcp-orc"),
    path.join(projectRoot, "host-mcp-binaries", targetTriple, "mcp-orc"),
    path.join(cacheDir, `mcp-orc-${platformTag}`),
    path.join(cacheDir, "mcp-orc"),
    bundledBinary,
  ].filter(Boolean);
}

const resolvedBinaryCache = new Map();

function getResolutionCacheKey(projectRoot, {
  resourcesPath = process.resourcesPath,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  homedir = os.homedir(),
  execPath = process.execPath,
  defaultApp = process.defaultApp,
  isPackagedApp,
} = {}) {
  return JSON.stringify({
    projectRoot,
    resourcesPath: resourcesPath || "",
    hostMcpBinRoot: env.HOST_MCP_BIN_ROOT || "",
    path: env.PATH || "",
    platform,
    arch,
    homedir,
    execPath: execPath || "",
    defaultApp: defaultApp === true,
    isPackagedApp:
      typeof isPackagedApp === "boolean" ? isPackagedApp : null,
  });
}

function resolveMcpOrcBinary(projectRoot, options = {}) {
  if (!projectRoot || typeof projectRoot !== "string") {
    throw new TypeError("projectRoot (string) is required");
  }

  const cacheKey = getResolutionCacheKey(projectRoot, options);
  const cachedBinary = resolvedBinaryCache.get(cacheKey);
  const packagedMacAppRun = isPackagedMacAppRun(options);
  if (cachedBinary) {
    if (packagedMacAppRun) {
      if (isExecutableFile(cachedBinary)) {
        return cachedBinary;
      }
    } else if (isBinaryCurrent(projectRoot, cachedBinary)) {
      return cachedBinary;
    }
  }

  if (packagedMacAppRun) {
    const bundledCandidate = getMcpOrcBinaryCandidates(projectRoot, options)[0];
    if (isExecutableFile(bundledCandidate)) {
      resolvedBinaryCache.set(cacheKey, bundledCandidate);
      return bundledCandidate;
    }

    throw new Error(
      `Packaged macOS app requires bundled signed mcp-orc at ${bundledCandidate}`,
    );
  }

  for (const candidate of getMcpOrcBinaryCandidates(projectRoot, options)) {
    if (isBinaryCurrent(projectRoot, candidate)) {
      resolvedBinaryCache.set(cacheKey, candidate);
      return candidate;
    }
  }

  const pathCandidate = resolvePathExecutable("mcp-orc", options);
  if (pathCandidate && isBinaryCurrent(projectRoot, pathCandidate)) {
    resolvedBinaryCache.set(cacheKey, pathCandidate);
    return pathCandidate;
  }

  throw new Error(
    `No current mcp-orc binary found for ${projectRoot}. Build one with: bash src/scripts/build-host-mcp-binaries.sh --host-only`,
  );
}

function shouldAttemptMcpOrcBootstrap(options = {}) {
  if (options.isPackagedApp === true) {
    return false;
  }

  return !isPackagedMacAppRun(options);
}

function getMcpOrcBootstrapScript(projectRoot) {
  return path.join(projectRoot, "src", "scripts", "build-host-mcp-binaries.sh");
}

function isMissingCurrentMcpOrcBinaryError(error) {
  return (
    error instanceof Error &&
    /No current mcp-orc binary found/.test(error.message || "")
  );
}

function normalizeCommandOutput(output) {
  return typeof output === "string" ? output.trim() : "";
}

function buildBootstrapFailureError(scriptPath, error) {
  const stderr = normalizeCommandOutput(error?.stderr);
  const stdout = normalizeCommandOutput(error?.stdout);
  const message = normalizeCommandOutput(error?.message) || "unknown error";
  const detail = stderr || stdout || message;
  return new Error(
    `Failed to bootstrap current-host mcp-orc binary via bash ${scriptPath} --host-only: ${detail}`,
  );
}

async function bootstrapMcpOrcBinary(projectRoot, options = {}) {
  const scriptPath = getMcpOrcBootstrapScript(projectRoot);
  if (!fs.existsSync(scriptPath)) {
    throw new Error(
      `Cannot bootstrap current-host mcp-orc binary because the build script is missing: ${scriptPath}`,
    );
  }

  const execAsync = options.execAsync || promisify(execCallback);
  try {
    await execAsync(`bash ${escapeShellArg(scriptPath)} --host-only`, {
      cwd: projectRoot,
      env: options.env || process.env,
      timeout:
        options.bootstrapTimeoutMs || DEFAULT_MCP_ORC_BOOTSTRAP_TIMEOUT_MS,
    });
  } catch (error) {
    throw buildBootstrapFailureError(scriptPath, error);
  }
}

async function ensureMcpOrcBinary(projectRoot, options = {}) {
  try {
    return resolveMcpOrcBinary(projectRoot, options);
  } catch (error) {
    if (
      !isMissingCurrentMcpOrcBinaryError(error) ||
      !shouldAttemptMcpOrcBootstrap(options)
    ) {
      throw error;
    }

    await bootstrapMcpOrcBinary(projectRoot, options);
    return resolveMcpOrcBinary(projectRoot, options);
  }
}

function buildMcpOrcGeneratorInvocation(projectRoot, subcommand, options = {}) {
  if (!subcommand || typeof subcommand !== "string") {
    throw new TypeError("subcommand (string) is required");
  }

  const args = [subcommand];
  if (options.force === true) {
    args.push("--force");
  }
  args.push("--project-root", projectRoot);

  return {
    command: resolveMcpOrcBinary(projectRoot, options),
    args,
  };
}

async function ensureMcpOrcGeneratorInvocation(
  projectRoot,
  subcommand,
  options = {},
) {
  if (!subcommand || typeof subcommand !== "string") {
    throw new TypeError("subcommand (string) is required");
  }

  // Host create_dirs (mcp-configs*/<id>/<id>.yaml `create_dirs:`) are a
  // generator-run prerequisite like the mcp-orc binary this function
  // bootstraps: the generated topology mounts runtime_files living in those
  // directories. Re-ensure them before every generator invocation so
  // restart/toggle/tool-save flows recreate directories deleted mid-session.
  tryEnsureMcpCreateDirs(projectRoot, { logger: console });

  const args = [subcommand];
  if (options.force === true) {
    args.push("--force");
  }
  args.push("--project-root", projectRoot);

  return {
    command: await ensureMcpOrcBinary(projectRoot, options),
    args,
  };
}

function buildMcpOrcGeneratorCommand(projectRoot, subcommand, options = {}) {
  const invocation = buildMcpOrcGeneratorInvocation(projectRoot, subcommand, options);
  return [
    escapeShellArg(invocation.command),
    ...invocation.args.map((arg) => escapeShellArg(arg)),
  ].join(" ");
}

async function ensureMcpOrcGeneratorCommand(
  projectRoot,
  subcommand,
  options = {},
) {
  const invocation = await ensureMcpOrcGeneratorInvocation(
    projectRoot,
    subcommand,
    options,
  );
  return [
    escapeShellArg(invocation.command),
    ...invocation.args.map((arg) => escapeShellArg(arg)),
  ].join(" ");
}

module.exports = {
  buildMcpOrcGeneratorCommand,
  buildMcpOrcGeneratorInvocation,
  ensureMcpOrcBinary,
  ensureMcpOrcGeneratorCommand,
  ensureMcpOrcGeneratorInvocation,
  getMcpOrcBinaryCandidates,
  hostMcpBinaryCacheDir,
  hostMcpCurrentTargetTriple,
  isPackagedMacAppRun,
  resolveMcpOrcBinary,
};
