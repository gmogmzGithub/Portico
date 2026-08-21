const fs = require("fs");
const os = require("os");
const path = require("path");
const yaml = require("js-yaml");

function normalizePathForPolicy(value) {
  if (!value || typeof value !== "string") {
    return null;
  }
  return path.resolve(value);
}

function uniqueStrings(values) {
  return Array.from(
    new Set(
      (values || [])
        .map((value) => String(value || "").trim())
        .filter((value) => value.length > 0),
    ),
  ).sort();
}

// ---------------------------------------------------------------------------
// PORTICO-352: curated host MCP write roots.
//
// Host MCP servers run under an SRT/Seatbelt profile whose write policy is
// allow-only. It granted just the PORTICO cache and /tmp, so native stdio servers
// could read user folders but every write failed with EPERM -- which silently
// broke a reporter's Obsidian vault integration on 07262026-fbd7411e.
//
// The sandbox itself is intended (per engineering direction, host MCP write
// access is granted through a reviewed, PORTICO-owned allowlist -- never declared
// by server YAML, arguments, or runtime metadata). This is the first reviewed
// entry. Each root is validated at policy-build time and silently skipped if it
// fails, so a missing or unsafe path can never widen the sandbox or break
// startup for other servers.
// ---------------------------------------------------------------------------

// SRT/Seatbelt treats these as glob metacharacters; a path containing them
// could match more than the intended directory, so such roots are never granted.
const SRT_PATH_GLOB_METACHARACTERS = /[*?[\]]/u;

const HOST_MCP_CURATED_WRITE_ROOTS = Object.freeze([
  // Reported case: obsidian-mcp-rs / server-filesystem writing into the vault.
  Object.freeze({ id: "obsidian-vaults", segments: Object.freeze(["Obsidian-Vault"]) }),
  // Reported alongside it: upstream Slack MCP stores users_cache.json and
  // channels_cache_v2.json here. The sandbox blocks creating the directory too,
  // so it will not exist on an affected machine -- PORTICO creates the exact leaf
  // (0700) after validating its ancestors, otherwise the grant is inert and the
  // server stays stuck on "users cache is not ready yet".
  Object.freeze({
    id: "slack-mcp-cache",
    segments: Object.freeze(["Library", "Caches", "slack-mcp-server"]),
    createLeaf: true,
  }),
]);

function pathIsWithin(candidate, boundary) {
  if (candidate === boundary) {
    return true;
  }
  return candidate.startsWith(boundary.endsWith(path.sep) ? boundary : `${boundary}${path.sep}`);
}

// Compare paths only after symlink resolution. macOS resolves /var and /tmp to
// /private/*, and a home directory can itself be a symlink, so a raw string
// comparison against an unresolved boundary produces false mismatches.
function realpathOrSelf(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return value;
  }
}

// Resolve the curated roots that are safe to grant on this machine. A root is
// granted only when it already exists as a real directory that stays inside the
// user's home after symlink resolution and does not overlap a protected path.
function resolveCuratedHostMcpWriteRoots(options = {}) {
  const homeDir = normalizePathForPolicy(options.homeDir);
  if (!homeDir) {
    return [];
  }
  const resolvedHomeDir = realpathOrSelf(homeDir);
  const protectedRoots = (options.protectedRoots || [])
    .map((value) => normalizePathForPolicy(value))
    .filter(Boolean)
    .map((value) => realpathOrSelf(value));

  const granted = [];
  for (const entry of HOST_MCP_CURATED_WRITE_ROOTS) {
    const candidate = path.join(homeDir, ...entry.segments);
    if (SRT_PATH_GLOB_METACHARACTERS.test(candidate)) {
      continue;
    }
    let resolved;
    try {
      // realpath resolves symlinks: a vault symlinked outside home (or onto a
      // protected path) must not become a writable root.
      resolved = fs.realpathSync(candidate);
      if (!fs.statSync(resolved).isDirectory()) {
        continue;
      }
    } catch {
      if (!entry.createLeaf) {
        // Missing or unreadable: nothing to grant, and never a startup failure.
        continue;
      }
      // Create only the exact leaf, and only when its parent is already a real
      // directory safely inside home. Never create intermediate directories --
      // that could materialise a path an attacker pre-positioned a symlink for.
      const parent = realpathOrSelf(path.dirname(candidate));
      const parentIsSafe =
        pathIsWithin(parent, resolvedHomeDir) &&
        !protectedRoots.some(
          (protectedRoot) =>
            pathIsWithin(parent, protectedRoot) || pathIsWithin(protectedRoot, parent),
        );
      if (!parentIsSafe) {
        continue;
      }
      try {
        fs.mkdirSync(path.join(parent, path.basename(candidate)), { mode: 0o700 });
        resolved = fs.realpathSync(path.join(parent, path.basename(candidate)));
      } catch {
        // Racing creation or a permissions problem: leave it ungranted.
        continue;
      }
    }
    if (!pathIsWithin(resolved, resolvedHomeDir)) {
      continue;
    }
    // Reject if the root would contain, or sit inside, anything protected.
    const overlapsProtected = protectedRoots.some(
      (protectedRoot) =>
        pathIsWithin(resolved, protectedRoot) || pathIsWithin(protectedRoot, resolved),
    );
    if (overlapsProtected) {
      continue;
    }
    granted.push(resolved);
  }
  return granted;
}

function defaultRuntimeSecretCacheDir(options = {}) {
  const env = options.env || process.env;
  if (env.PORTICO_RUNTIME_SECRET_CACHE_DIR) {
    return env.PORTICO_RUNTIME_SECRET_CACHE_DIR;
  }
  const homeDir = options.homeDir || os.homedir();
  if (process.platform === "darwin") {
    return path.join(homeDir, "Library", "Caches", "portico", "runtime-secrets");
  }
  return path.join(
    env.XDG_STATE_HOME || path.join(homeDir, ".local", "state"),
    "portico",
    "runtime-secrets",
  );
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readYamlConfig(filePath) {
  return yaml.load(fs.readFileSync(filePath, "utf8")) || {};
}

function findServerYaml(projectRoot, serverId) {
  const systemServerDir = path.join(projectRoot, "mcp-configs", serverId);
  const systemYaml = path.join(systemServerDir, `${serverId}.yaml`);
  if (fs.existsSync(systemServerDir)) {
    return fs.existsSync(systemYaml) ? systemYaml : null;
  }
  const userYaml = path.join(
    projectRoot,
    "mcp-configs-user",
    serverId,
    `${serverId}.yaml`,
  );
  if (fs.existsSync(userYaml)) {
    return userYaml;
  }

  for (const rootName of ["mcp-configs", "mcp-configs-user"]) {
    const root = path.join(projectRoot, rootName);
    if (!fs.existsSync(root)) {
      continue;
    }
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidate = path.join(root, entry.name, `${entry.name}.yaml`);
      if (!fs.existsSync(candidate)) {
        continue;
      }
      try {
        const config = readYamlConfig(candidate);
        if (String(config.id || entry.name) === serverId) {
          return candidate;
        }
      } catch {
        // Ignore malformed user YAML here; generator/health surfaces own the
        // user-facing diagnostics for invalid configs.
      }
    }
  }

  return null;
}

function collectHostServerIds(configPath) {
  if (!configPath || !fs.existsSync(configPath)) {
    return [];
  }
  const config = readJsonFile(configPath);
  const servers = config && typeof config === "object" ? config.mcpServers : null;
  if (!servers || typeof servers !== "object") {
    return [];
  }
  return Object.keys(servers).sort();
}

function collectAllowedDomainsForHostServers(projectRoot, serverIds) {
  const allowedDomains = [];
  for (const serverId of serverIds || []) {
    const yamlPath = findServerYaml(projectRoot, serverId);
    if (!yamlPath) {
      continue;
    }
    const config = readYamlConfig(yamlPath);
    if (Array.isArray(config.allowed_domains)) {
      allowedDomains.push(...config.allowed_domains);
    }
  }
  return uniqueStrings(allowedDomains);
}

function resolveSandboxRuntimeCli(options = {}) {
  const resourcesPath = options.resourcesPath || process.resourcesPath;
  const isPackagedApp =
    options.isPackagedApp === undefined ? false : Boolean(options.isPackagedApp);

  const candidates = [];
  if (isPackagedApp && resourcesPath) {
    candidates.push(
      path.join(
        resourcesPath,
        "app.asar.unpacked",
        "node_modules",
        "@anthropic-ai",
        "sandbox-runtime",
        "dist",
        "cli.js",
      ),
    );
  }

  try {
    candidates.push(require.resolve("@anthropic-ai/sandbox-runtime/dist/cli.js"));
  } catch {
    try {
      const packageJsonPath = require.resolve(
        "@anthropic-ai/sandbox-runtime/package.json",
      );
      candidates.push(path.join(path.dirname(packageJsonPath), "dist", "cli.js"));
    } catch {
      // Handled below.
    }
  }

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "Host MCP sandbox runtime is missing: could not locate @anthropic-ai/sandbox-runtime/dist/cli.js",
  );
}

function resolveSandboxRuntimeRunner(options = {}) {
  const resourcesPath = options.resourcesPath || process.resourcesPath;
  const projectRoot = normalizePathForPolicy(options.projectRoot);
  const candidates = [];
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, "prereq-scripts", "srt-sandbox-runner.mjs"));
  }
  if (projectRoot) {
    candidates.push(path.join(projectRoot, "src", "scripts", "srt-sandbox-runner.mjs"));
  }

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error("Host MCP sandbox runner is missing: could not locate srt-sandbox-runner.mjs");
}

function escapeSeatbeltString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function seatbeltLiteral(pathValue) {
  return `(literal "${escapeSeatbeltString(pathValue)}")`;
}

function seatbeltSubpath(pathValue) {
  return `(subpath "${escapeSeatbeltString(pathValue)}")`;
}

function buildHostMcpSandboxSettings(options = {}) {
  const projectRoot = normalizePathForPolicy(options.projectRoot);
  if (!projectRoot) {
    throw new Error("projectRoot is required to build host MCP sandbox settings");
  }
  const homeDir = options.homeDir || os.homedir();
  const configPath = normalizePathForPolicy(options.configPath);
  const cacheDir = normalizePathForPolicy(
    options.cacheDir || defaultRuntimeSecretCacheDir(options),
  );
  const allowedDomains = uniqueStrings(options.allowedDomains || []);
  const hostBinaryRoots = uniqueStrings([
    path.join(projectRoot, "host-mcp-binaries"),
    options.resourcesPath ? path.join(options.resourcesPath, "host-mcp-binaries") : "",
  ]);
  const managedNodePackageStore = path.join(
    projectRoot,
    "open-webui-data",
    "managed-node-mcp-packages",
  );
  const managedNodePackageAcquisition = path.join(
    projectRoot,
    "open-webui-data",
    "managed-node-mcp-package-acquisition",
  );
  const oauthTokenDir = path.join(projectRoot, "mcpo-oauth-tokens");

  // PORTICO-352: paths a curated write root must never contain or sit inside.
  const protectedWriteBoundaries = uniqueStrings([
    projectRoot,
    path.join(homeDir, ".ssh"),
    path.join(homeDir, ".aws"),
    path.join(homeDir, ".config"),
    path.join(homeDir, ".npmrc"),
    path.join(homeDir, "Library", "Keychains"),
    managedNodePackageStore,
    managedNodePackageAcquisition,
    oauthTokenDir,
    cacheDir,
    ...hostBinaryRoots,
  ]);
  const curatedWriteRoots = resolveCuratedHostMcpWriteRoots({
    homeDir,
    protectedRoots: protectedWriteBoundaries,
  });

  return {
    network: {
      allowedDomains,
      deniedDomains: [],
      allowUnixSockets: [],
      allowLocalBinding: true,
    },
    filesystem: {
      denyRead: uniqueStrings([
        path.join(homeDir, ".ssh"),
        path.join(homeDir, ".aws"),
        path.join(homeDir, ".config"),
        path.join(homeDir, ".npmrc"),
        path.join(homeDir, "Library", "Keychains"),
        path.join(projectRoot, ".env"),
        path.join(projectRoot, ".env.runtime"),
        path.join(projectRoot, ".env.local"),
        path.join(projectRoot, ".npmrc"),
        managedNodePackageAcquisition,
        oauthTokenDir,
        cacheDir,
      ]),
      allowRead: uniqueStrings([
        configPath,
        path.join(projectRoot, "mcp_config_host_sideload.json"),
        managedNodePackageStore,
        ...hostBinaryRoots,
        "/bin",
        "/usr/bin",
        "/usr/lib",
        "/usr/local/bin",
        "/usr/local/lib",
        "/System/Library",
        "/Library/Frameworks",
        "/tmp",
      ]),
      allowWrite: uniqueStrings([
        path.join(homeDir, "Library", "Caches", "portico"),
        "/tmp",
        // PORTICO-352: reviewed curated roots (validated above); empty when absent.
        ...curatedWriteRoots,
      ]),
      denyWrite: uniqueStrings([
        path.join(homeDir, ".ssh"),
        path.join(homeDir, ".aws"),
        path.join(homeDir, ".config"),
        path.join(homeDir, "Library", "Keychains"),
        path.join(projectRoot, ".env"),
        path.join(projectRoot, ".env.runtime"),
        path.join(projectRoot, ".env.local"),
        path.join(projectRoot, ".npmrc"),
        managedNodePackageAcquisition,
        oauthTokenDir,
        cacheDir,
      ]),
    },
  };
}

function buildNoKeychainSeatbeltProfile(options = {}) {
  const projectRoot = normalizePathForPolicy(options.projectRoot);
  if (!projectRoot) {
    throw new Error("projectRoot is required to build host MCP Seatbelt profile");
  }
  const homeDir = options.homeDir || os.homedir();
  const cacheDir = normalizePathForPolicy(
    options.cacheDir || defaultRuntimeSecretCacheDir(options),
  );
  const oauthTokenDir = path.join(projectRoot, "mcpo-oauth-tokens");
  const managedNodePackageAcquisition = path.join(
    projectRoot,
    "open-webui-data",
    "managed-node-mcp-package-acquisition",
  );
  const denyReadSubpaths = uniqueStrings([
    path.join(homeDir, ".ssh"),
    path.join(homeDir, ".aws"),
    path.join(homeDir, ".config"),
    path.join(homeDir, ".npmrc"),
    path.join(homeDir, "Library", "Keychains"),
    managedNodePackageAcquisition,
    oauthTokenDir,
    cacheDir,
  ]);
  const denyWriteSubpaths = denyReadSubpaths;
  const denyReadLiterals = uniqueStrings([
    path.join(homeDir, ".npmrc"),
    path.join(projectRoot, ".env"),
    path.join(projectRoot, ".env.runtime"),
    path.join(projectRoot, ".env.local"),
    path.join(projectRoot, ".npmrc"),
  ]);

  const lines = [
    '(deny mach-lookup (global-name "com.apple.SecurityServer"))',
    '(deny mach-lookup (global-name "com.apple.securityd.xpc"))',
    '(deny mach-lookup (global-name "com.apple.securityd"))',
    '(deny process-exec (literal "/usr/bin/security"))',
    '(deny process-exec (literal "/usr/local/bin/npm"))',
    '(deny process-exec (literal "/usr/local/bin/npx"))',
    '(deny process-exec (literal "/opt/homebrew/bin/npm"))',
    '(deny process-exec (literal "/opt/homebrew/bin/npx"))',
  ];
  for (const target of denyReadSubpaths) {
    lines.push(`(deny file-read* ${seatbeltSubpath(target)})`);
  }
  for (const target of denyReadLiterals) {
    lines.push(`(deny file-read* ${seatbeltLiteral(target)})`);
  }
  for (const target of denyWriteSubpaths) {
    lines.push(`(deny file-write* ${seatbeltSubpath(target)})`);
  }
  for (const target of denyReadLiterals) {
    lines.push(`(deny file-write* ${seatbeltLiteral(target)})`);
  }

  return `${lines.join("\n")}\n`;
}

function writePrivateFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, content, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function writeHostMcpSandboxFiles(options = {}) {
  const projectRoot = normalizePathForPolicy(options.projectRoot);
  const configPath = normalizePathForPolicy(options.configPath);
  if (!projectRoot || !configPath) {
    throw new Error("projectRoot and configPath are required for host MCP sandboxing");
  }
  const cacheDir = normalizePathForPolicy(
    options.cacheDir || defaultRuntimeSecretCacheDir(options),
  );
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(cacheDir, 0o700);

  const serverIds = collectHostServerIds(configPath);
  const allowedDomains = collectAllowedDomainsForHostServers(projectRoot, serverIds);
  const settings = buildHostMcpSandboxSettings({
    ...options,
    projectRoot,
    cacheDir,
    allowedDomains,
  });
  const srtSettingsPath = path.join(cacheDir, "srt-settings.json");
  const noKeychainProfilePath = path.join(cacheDir, "host-mcp-no-keychain.sb");
  writePrivateFile(srtSettingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  writePrivateFile(
    noKeychainProfilePath,
    buildNoKeychainSeatbeltProfile({ ...options, projectRoot, cacheDir }),
  );

  return {
    HOST_MCP_SRT_CLI_JS: resolveSandboxRuntimeCli(options),
    HOST_MCP_SRT_RUNNER_JS: resolveSandboxRuntimeRunner({ ...options, projectRoot }),
    HOST_MCP_SRT_SETTINGS_PATH: srtSettingsPath,
    HOST_MCP_NO_KEYCHAIN_PROFILE_PATH: noKeychainProfilePath,
    HOST_MCP_SANDBOX_ENABLED: "1",
  };
}

function createSerialTaskQueue() {
  let tail = Promise.resolve();

  return async function enqueue(task) {
    if (typeof task !== "function") {
      throw new TypeError("task must be a function");
    }

    const run = tail.catch(() => undefined).then(() => task());
    tail = run.catch(() => undefined);
    return run;
  };
}

function consumeProcessOutputLines(buffer, chunk) {
  const prefix = typeof buffer === "string" ? buffer : "";
  const suffix =
    chunk === undefined || chunk === null
      ? ""
      : Buffer.isBuffer(chunk)
        ? chunk.toString("utf8")
        : String(chunk);
  const combined = `${prefix}${suffix}`;

  if (!combined) {
    return { lines: [], remainder: "" };
  }

  const normalized = combined.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const parts = normalized.split("\n");
  const remainder = normalized.endsWith("\n") ? "" : parts.pop() || "";
  const lines = parts
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  return { lines, remainder };
}

function shouldSuppressHostMcpoLogLine(line) {
  const text = String(line || "").trim();
  return /^No handler registered for issue code [A-Za-z0-9_]+$/.test(text);
}

function classifyHostMcpoStderrLine(line) {
  const text = String(line || "").trim();
  if (!text) {
    return "info";
  }

  if (
    /\b(traceback|panic!|fatal|uncaught exception|unhandled rejection)\b/i.test(
      text,
    )
  ) {
    return "error";
  }

  if (
    /\b(failed to bind|address already in use|eaddrinuse|permission denied|incorrect or missing password)\b/i.test(
      text,
    )
  ) {
    return "error";
  }

  if (
    /^(npm error|npm ERR!)/i.test(text) ||
    /\[.*ERROR.*\]/.test(text) ||
    /^error:/i.test(text)
  ) {
    return "error";
  }

  if (/\bwarn(?:ing)?\b/i.test(text) || /\[.*WARN.*\]/.test(text)) {
    return "warning";
  }

  return "info";
}

const DEFAULT_HOST_MCPO_STARTUP_GRACE_MS = Math.max(
  5000,
  Number.parseInt(process.env.HOST_MCPO_STARTUP_GRACE_MS || "60000", 10) ||
    60000,
);

function ensureHostMcpoStartupState(hostMcpo) {
  if (!hostMcpo || typeof hostMcpo !== "object") {
    throw new TypeError("hostMcpo state object is required");
  }

  if (!hostMcpo.startup || typeof hostMcpo.startup !== "object") {
    hostMcpo.startup = {
      phase: "idle",
      startedAt: 0,
      deadlineAt: 0,
      lastReadyAt: 0,
      lastExitAt: 0,
    };
  }

  return hostMcpo.startup;
}

function markHostMcpoStarting(hostMcpo, options = {}) {
  const startup = ensureHostMcpoStartupState(hostMcpo);
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const timeoutMs = Math.max(
    5000,
    Number.parseInt(
      String(options.timeoutMs ?? DEFAULT_HOST_MCPO_STARTUP_GRACE_MS),
      10,
    ) || DEFAULT_HOST_MCPO_STARTUP_GRACE_MS,
  );

  startup.phase = "starting";
  startup.startedAt = now;
  startup.deadlineAt = now + timeoutMs;

  return startup;
}

function markHostMcpoReady(hostMcpo, options = {}) {
  const startup = ensureHostMcpoStartupState(hostMcpo);
  const now = Number.isFinite(options.now) ? options.now : Date.now();

  startup.phase = "ready";
  startup.lastReadyAt = now;
  startup.startedAt = 0;
  startup.deadlineAt = 0;

  return startup;
}

function markHostMcpoStopped(hostMcpo, options = {}) {
  const startup = ensureHostMcpoStartupState(hostMcpo);
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const phase =
    typeof options.phase === "string" && options.phase.trim()
      ? options.phase.trim()
      : "stopped";

  startup.phase = phase;
  startup.lastExitAt = now;
  startup.startedAt = 0;
  startup.deadlineAt = 0;

  return startup;
}

function isHostMcpoStartupPending(hostMcpo, options = {}) {
  const startup = ensureHostMcpoStartupState(hostMcpo);
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  return startup.phase === "starting" && startup.deadlineAt > now;
}

function getHostMcpoStartupPhase(hostMcpo, options = {}) {
  const startup = ensureHostMcpoStartupState(hostMcpo);
  const now = Number.isFinite(options.now) ? options.now : Date.now();

  if (startup.phase === "starting" && startup.deadlineAt > now) {
    return "starting";
  }

  if (startup.phase === "starting" && startup.deadlineAt > 0) {
    return "timed_out";
  }

  return startup.phase || "idle";
}

function shouldTreatHostServerAsStarting(serverInfo, hostMcpo, options = {}) {
  if (!serverInfo || typeof serverInfo !== "object") {
    return false;
  }
  if (serverInfo.deployment !== "host") {
    return false;
  }
  if (serverInfo.configured === false) {
    return false;
  }
  if (!isHostMcpoStartupPending(hostMcpo, options)) {
    return false;
  }

  const status = String(serverInfo.status || "").toLowerCase();
  const error = String(serverInfo.error || "").toLowerCase();

  if (status === "healthy" || status === "needs_oauth") {
    return false;
  }

  return (
    status === "failed" ||
    status === "checking" ||
    status === "unknown" ||
    error.includes("host mcp server is not running") ||
    error.includes("check host mcpo logs") ||
    error.includes("fetch failed") ||
    error.includes("failed to fetch") ||
    error.includes("networkerror")
  );
}

module.exports = {
  consumeProcessOutputLines,
  shouldSuppressHostMcpoLogLine,
  classifyHostMcpoStderrLine,
  createSerialTaskQueue,
  DEFAULT_HOST_MCPO_STARTUP_GRACE_MS,
  ensureHostMcpoStartupState,
  markHostMcpoStarting,
  markHostMcpoReady,
  markHostMcpoStopped,
  isHostMcpoStartupPending,
  getHostMcpoStartupPhase,
  shouldTreatHostServerAsStarting,
  defaultRuntimeSecretCacheDir,
  collectAllowedDomainsForHostServers,
  resolveCuratedHostMcpWriteRoots,
  buildHostMcpSandboxSettings,
  buildNoKeychainSeatbeltProfile,
  resolveSandboxRuntimeCli,
  resolveSandboxRuntimeRunner,
  writeHostMcpSandboxFiles,
};
