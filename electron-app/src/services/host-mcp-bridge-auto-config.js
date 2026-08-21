const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, execFileSync } = require("child_process");
const { promisify } = require("util");
const {
  ensureClientBridgeToken,
  getBridgeAuthDir,
  getBridgeClientTokenPath,
  getBridgeTokenRegistryPath,
  revokeClientBridgeToken,
} = require("./host-mcp-bridge-auth");
const { createEnhancedEnv } = require("./env-paths");

const execFileAsync = promisify(execFile);

const BRIDGE_SERVER_NAME = "portico";
const DEFAULT_BRIDGE_URL = "http://127.0.0.1:8891/mcp";
const CONFIG_FILE_MODE = 0o600;
const CONFIG_DIR_MODE = 0o700;
const MAX_CONFIG_ERROR_LENGTH = 320;
const ELECTRON_APP_ROOT = path.resolve(__dirname, "..", "..");
const MCP_CLIENT_ASSET_DIR = path.join(ELECTRON_APP_ROOT, "assets", "mcp-clients");

const SUPPORTED_MCP_CLIENTS = Object.freeze([
  {
    id: "claude-code",
    displayName: "Claude Code",
    logo: "../assets/mcp-clients/claude.png",
  },
  {
    id: "claude-desktop",
    displayName: "Claude Desktop",
    logo: "../assets/mcp-clients/claude.png",
  },
  {
    id: "codex",
    displayName: "Codex",
    logo: "../assets/mcp-clients/codex.png",
  },
  {
    id: "cursor",
    displayName: "Cursor",
    logo: "../assets/mcp-clients/cursor.png",
  },
  {
    id: "amp",
    displayName: "Amp",
    logo: "../assets/mcp-clients/amp.png",
  },
]);

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: CONFIG_DIR_MODE });
  try {
    fs.chmodSync(dirPath, CONFIG_DIR_MODE);
  } catch (_) {
    // Best effort on non-POSIX filesystems.
  }
}

function quoteShellSingle(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function writeTextAtomicWithBackup(filePath, content, options = {}) {
  ensureDir(path.dirname(filePath));
  const backupPath = backupExistingFile(filePath, options);
  const tmpPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, content, { encoding: "utf8", mode: options.mode ?? CONFIG_FILE_MODE });
  try {
    fs.chmodSync(tmpPath, options.mode ?? CONFIG_FILE_MODE);
  } catch (_) {
    // Best effort.
  }
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, options.mode ?? CONFIG_FILE_MODE);
  } catch (_) {
    // Best effort.
  }
  return { filePath, backupPath };
}

function backupExistingFile(filePath, options = {}) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const backupBase = `${filePath}.bak.${Date.now()}`;
  let backupPath = backupBase;
  let suffix = 1;
  while (fs.existsSync(backupPath)) {
    backupPath = `${backupBase}.${suffix}`;
    suffix += 1;
  }
  fs.copyFileSync(filePath, backupPath);
  try {
    fs.chmodSync(backupPath, options.mode ?? CONFIG_FILE_MODE);
  } catch (_) {
    // Best effort.
  }
  return backupPath;
}

function restoreFileSnapshot(filePath, snapshot) {
  if (snapshot.existed) {
    return writeTextAtomicWithBackup(filePath, snapshot.content);
  }
  const backupPath = backupExistingFile(filePath);
  fs.rmSync(filePath, { force: true });
  return { filePath, backupPath };
}

function readJsonFile(filePath, fallback = {}) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  const raw = fs.readFileSync(filePath, "utf8");
  if (!raw.trim()) {
    return fallback;
  }
  return JSON.parse(raw);
}

function writeJsonFileAtomic(filePath, value) {
  return writeTextAtomicWithBackup(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function stripJsonComments(input) {
  let output = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        output += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }
    output += char;
  }
  return output.replace(/,\s*([}\]])/g, "$1");
}

function readJsoncFile(filePath, fallback = {}) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  const stripped = stripJsonComments(fs.readFileSync(filePath, "utf8"));
  if (!stripped.trim()) {
    return fallback;
  }
  return JSON.parse(stripped);
}

function defaultCommandExists(commandName, options = {}) {
  try {
    const platform = options.platform || process.platform;
    const env = createEnhancedEnv(options.env || process.env);
    const windowsRoot = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
    const tool = platform === "win32"
      ? path.join(windowsRoot, "System32", "where.exe")
      : "/usr/bin/which";
    const execFileSyncImpl = options.execFileSync || execFileSync;
    execFileSyncImpl(tool, [commandName], {
      env,
      stdio: "ignore",
    });
    return true;
  } catch (_) {
    return false;
  }
}

function defaultHomeDir() {
  return os.homedir();
}

function fileExists(filePath, options = {}) {
  const exists = options.fileExists || fs.existsSync;
  return exists(filePath);
}

function darwinAppExists(appName, homeDir, options) {
  return fileExists(path.join("/Applications", appName), options) ||
    fileExists(path.join(homeDir, "Applications", appName), options);
}

function windowsExecutableExists(env, candidates, options) {
  return candidates.some((candidate) => {
    const root = env[candidate.envName] || "";
    if (!root) return false;
    return fileExists(path.join(root, ...candidate.parts), options);
  });
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function requirePlainConfigObject(value, clientName) {
  if (!isPlainObject(value)) {
    throw new Error(`${clientName} config must contain a JSON object at the top level`);
  }
  return value;
}

function sanitizeConfigError(error, fallback = "Configuration failed") {
  let message = String(error?.message || error || fallback)
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  if (/"(?:headers|headersHelper|Authorization)"\s*:/i.test(message)) {
    message = message.replace(/\{.*\}/g, "[redacted configuration arguments]");
  }
  message = message
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\bportico_mcp_[A-Za-z0-9._~-]+\b/g, "[REDACTED_TOKEN]")
    .replace(/\s+/g, " ")
    .trim();
  if (!message) {
    message = fallback;
  }
  if (message.length > MAX_CONFIG_ERROR_LENGTH) {
    return `${message.slice(0, MAX_CONFIG_ERROR_LENGTH - 1)}…`;
  }
  return message;
}

function claudeCodeCommandError(phase, error) {
  const errorCode = typeof error?.code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(error.code)
    ? error.code
    : "";
  const suffix = errorCode ? ` (${errorCode})` : "";
  const safeError = new Error(`Claude Code ${phase} failed${suffix}`);
  if (errorCode) {
    safeError.code = errorCode;
  }
  return safeError;
}

function logClientConfigFailure(action, clientId, error) {
  const errorCode = typeof error?.code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(error.code)
    ? error.code
    : null;
  const safeError = sanitizeConfigError(error);
  console.error("[Host MCP Bridge Config] client operation failed", JSON.stringify({
    action,
    clientId,
    errorCode,
    error: safeError,
  }));
  return safeError;
}

function objectHasBridgeServer(value) {
  return isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, BRIDGE_SERVER_NAME);
}

function resolveCodexConfigPath(homeDir) {
  return path.join(homeDir, ".codex", "config.toml");
}

function resolveCursorConfigPath(homeDir) {
  return path.join(homeDir, ".cursor", "mcp.json");
}

function resolveMcpClientConfigPath(clientId, options = {}) {
  const homeDir = options.homeDir || defaultHomeDir();
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  if (clientId === "claude-code") {
    return resolveClaudeCodeConfigPath(homeDir);
  }
  if (clientId === "claude-desktop") {
    return resolveClaudeDesktopConfigPath(homeDir, platform, env);
  }
  if (clientId === "codex") {
    return resolveCodexConfigPath(homeDir);
  }
  if (clientId === "cursor") {
    return resolveCursorConfigPath(homeDir);
  }
  if (clientId === "amp") {
    return resolveAmpSettingsPath(homeDir);
  }
  return null;
}

function readClientJsonConfig(configPath, clientName, fallback = {}) {
  try {
    return requirePlainConfigObject(readJsonFile(configPath, fallback), clientName);
  } catch (error) {
    throw new Error(`Failed to read ${clientName} config: ${error.message || String(error)}`);
  }
}

function readClientJsoncConfig(configPath, clientName, fallback = {}) {
  try {
    return requirePlainConfigObject(readJsoncFile(configPath, fallback), clientName);
  } catch (error) {
    throw new Error(`Failed to read ${clientName} config: ${error.message || String(error)}`);
  }
}

function inspectClaudeCodeConfig({
  homeDir,
  userDataPath,
  bridgeUrl = DEFAULT_BRIDGE_URL,
}) {
  const configPath = resolveClaudeCodeConfigPath(homeDir);
  if (!fs.existsSync(configPath)) {
    return {
      configured: false,
      configPath,
      exists: false,
      userConfigured: false,
      projectEntries: 0,
      repairNeeded: false,
      repairReasons: [],
    };
  }
  const parsedConfig = readClientJsonConfig(configPath, "Claude Code", {});
  const config = isPlainObject(parsedConfig) ? parsedConfig : {};
  const userEntryExists = objectHasBridgeServer(config.mcpServers);
  const userEntry = userEntryExists ? config.mcpServers[BRIDGE_SERVER_NAME] : null;
  const expectedHelperPath = isNonEmptyString(userDataPath)
    ? getClaudeCodeHeadersHelperPath(userDataPath)
    : null;
  const helperConfigured = expectedHelperPath
    ? userEntry?.headersHelper === quoteShellSingle(expectedHelperPath) && fs.existsSync(expectedHelperPath)
    : isNonEmptyString(userEntry?.headersHelper);
  const userConfigured = Boolean(
    isPlainObject(userEntry) &&
    userEntry.type === "http" &&
    userEntry.url === bridgeUrl &&
    helperConfigured,
  );
  const projects = isPlainObject(config.projects) ? config.projects : {};
  let projectEntries = 0;
  for (const projectConfig of Object.values(projects)) {
    if (objectHasBridgeServer(projectConfig?.mcpServers)) {
      projectEntries += 1;
    }
  }
  const repairReasons = [];
  if (userEntryExists && !isPlainObject(userEntry)) {
    repairReasons.push("invalid_user_entry");
  } else if (userEntryExists) {
    if (userEntry.type !== "http") repairReasons.push("invalid_transport");
    if (userEntry.url !== bridgeUrl) repairReasons.push("invalid_bridge_url");
    if (!helperConfigured) repairReasons.push("invalid_headers_helper");
  } else if (projectEntries > 0) {
    repairReasons.push("missing_user_entry");
  }
  if (projectEntries > 0) {
    repairReasons.push("project_scope_override");
  }
  const configured = userConfigured && projectEntries === 0;
  return {
    configured,
    configPath,
    exists: true,
    userConfigured,
    projectEntries,
    repairNeeded: !configured && (userEntryExists || projectEntries > 0),
    repairReasons,
  };
}

function inspectJsonMcpServerConfig({ configPath, clientName, mapKey = "mcpServers", jsonc = false }) {
  if (!fs.existsSync(configPath)) {
    return { configured: false, configPath, exists: false };
  }
  const parsedConfig = jsonc
    ? readClientJsoncConfig(configPath, clientName, {})
    : readClientJsonConfig(configPath, clientName, {});
  const config = isPlainObject(parsedConfig) ? parsedConfig : {};
  return {
    configured: objectHasBridgeServer(config[mapKey]),
    configPath,
    exists: true,
  };
}

function inspectCodexConfig({ homeDir }) {
  const configPath = resolveCodexConfigPath(homeDir);
  if (!fs.existsSync(configPath)) {
    return { configured: false, configPath, exists: false };
  }
  const content = fs.readFileSync(configPath, "utf8");
  return {
    configured: String(content).split(/\r?\n/).some(isCodexBridgeTomlHeader),
    configPath,
    exists: true,
  };
}

function inspectMcpClientConfig(clientId, options = {}) {
  const homeDir = options.homeDir || defaultHomeDir();
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  if (clientId === "claude-code") {
    return inspectClaudeCodeConfig({
      homeDir,
      userDataPath: options.userDataPath,
      bridgeUrl: options.bridgeUrl || DEFAULT_BRIDGE_URL,
    });
  }
  if (clientId === "claude-desktop") {
    return inspectJsonMcpServerConfig({
      configPath: resolveClaudeDesktopConfigPath(homeDir, platform, env),
      clientName: "Claude Desktop",
    });
  }
  if (clientId === "codex") {
    return inspectCodexConfig({ homeDir });
  }
  if (clientId === "cursor") {
    return inspectJsonMcpServerConfig({
      configPath: resolveCursorConfigPath(homeDir),
      clientName: "Cursor",
    });
  }
  if (clientId === "amp") {
    const configPath = resolveAmpSettingsPath(homeDir);
    return inspectJsonMcpServerConfig({
      configPath,
      clientName: "Amp",
      mapKey: "amp.mcpServers",
      jsonc: configPath.endsWith(".jsonc"),
    });
  }
  return { configured: false, configPath: null, exists: false };
}

function detectMcpClients(options = {}) {
  const homeDir = options.homeDir || defaultHomeDir();
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const commandExists = options.commandExists || ((commandName) => defaultCommandExists(commandName, options));

  const claudeCodeDetected =
    commandExists("claude") || fileExists(path.join(homeDir, ".claude.json"), options);
  const codexAppDetected =
    (platform === "darwin" && darwinAppExists("Codex.app", homeDir, options)) ||
    (platform === "win32" && windowsExecutableExists(env, [
      { envName: "LOCALAPPDATA", parts: ["Programs", "Codex", "Codex.exe"] },
      { envName: "LOCALAPPDATA", parts: ["Codex", "Codex.exe"] },
      { envName: "PROGRAMFILES", parts: ["Codex", "Codex.exe"] },
      { envName: "PROGRAMFILES", parts: ["OpenAI", "Codex", "Codex.exe"] },
    ], options));
  const codexDetected =
    commandExists("codex") ||
    fileExists(path.join(homeDir, ".codex", "config.toml"), options) ||
    codexAppDetected;
  const cursorDetected =
    commandExists("cursor") ||
    fileExists(path.join(homeDir, ".cursor", "mcp.json"), options) ||
    (platform === "darwin" && darwinAppExists("Cursor.app", homeDir, options));
  const ampDetected =
    commandExists("amp") ||
    fileExists(path.join(homeDir, ".config", "amp", "settings.json"), options) ||
    fileExists(path.join(homeDir, ".config", "amp", "settings.jsonc"), options);
  const claudeDesktopDetected =
    (platform === "darwin" && darwinAppExists("Claude.app", homeDir, options)) ||
    (platform === "win32" && windowsExecutableExists(env, [
      { envName: "LOCALAPPDATA", parts: ["AnthropicClaude", "Claude.exe"] },
      { envName: "LOCALAPPDATA", parts: ["Programs", "Claude", "Claude.exe"] },
      { envName: "PROGRAMFILES", parts: ["Claude", "Claude.exe"] },
    ], options));

  const detected = new Map([
    ["claude-code", claudeCodeDetected],
    ["claude-desktop", claudeDesktopDetected],
    ["codex", codexDetected],
    ["cursor", cursorDetected],
    ["amp", ampDetected],
  ]);
  return SUPPORTED_MCP_CLIENTS.map((client, index) => {
    const isDetected = detected.get(client.id) === true;
    let configInfo = { configured: false, configPath: resolveMcpClientConfigPath(client.id, { homeDir, platform, env }) };
    try {
      configInfo = inspectMcpClientConfig(client.id, {
        homeDir,
        platform,
        env,
        userDataPath: options.userDataPath,
        bridgeUrl: options.bridgeUrl || DEFAULT_BRIDGE_URL,
      });
    } catch (error) {
      configInfo = {
        ...configInfo,
        configured: false,
        error: sanitizeConfigError(error),
      };
    }
    const configured = configInfo.configured === true;
    const repairNeeded = configInfo.repairNeeded === true;
    const selectable = isDetected || configured;
    return {
      ...client,
      sortIndex: index,
      detected: isDetected,
      configured,
      configPath: configInfo.configPath || null,
      configError: configInfo.error || null,
      repairNeeded,
      repairReasons: Array.isArray(configInfo.repairReasons) ? configInfo.repairReasons : [],
      selectable,
      blocked: false,
      status: configured
        ? "configured"
        : configInfo.error
          ? "config_error"
          : repairNeeded
            ? "needs_repair"
            : isDetected
              ? "detected"
              : "not_detected",
      statusText: configured
        ? "Configured"
        : configInfo.error
          ? "Config unreadable"
          : repairNeeded
            ? "Needs repair"
            : isDetected
              ? "Detected"
              : "Not detected",
    };
  }).sort((left, right) => {
    if (left.configured !== right.configured) {
      return left.configured ? -1 : 1;
    }
    if (left.detected !== right.detected) {
      return left.detected ? -1 : 1;
    }
    return left.sortIndex - right.sortIndex;
  }).map(({ sortIndex, ...client }) => client);
}

function getClaudeCodeHeadersHelperPath(userDataPath, clientId = "claude-code") {
  return path.join(getBridgeAuthDir(userDataPath), `${clientId}-headers-helper.sh`);
}

function writeClaudeCodeHeadersHelper({ userDataPath, tokenPath, clientId = "claude-code" }) {
  const helperPath = getClaudeCodeHeadersHelperPath(userDataPath, clientId);
  const script = [
    "#!/bin/sh",
    "set -eu",
    `default_token_file=${quoteShellSingle(tokenPath)}`,
    'token_file="${portico_MCP_BRIDGE_TOKEN_FILE:-$default_token_file}"',
    'token="$(tr -d "\\r\\n" < "$token_file" 2>/dev/null || true)"',
    'case "$token" in',
    '  ""|*[!A-Za-z0-9._~-]*) exit 1 ;;',
    "esac",
    'printf \'{"Authorization":"Bearer %s"}\\n\' "$token"',
    "",
  ].join("\n");
  writeTextAtomicWithBackup(helperPath, script, { mode: 0o700 });
  return helperPath;
}

function isClaudeCodeMissingServerError(error) {
  const text = [
    error?.message,
    error?.stderr,
    error?.stdout,
  ].filter(Boolean).join("\n").toLowerCase();
  return /\b(not found|does not exist|no mcp server|no (?:user|local|project)-scoped mcp server found|not configured)\b/.test(text);
}

function resolveClaudeCodeConfigPath(homeDir) {
  return path.join(homeDir, ".claude.json");
}

function repairClaudeCodeProjectScopedConfig({ homeDir }) {
  const configPath = resolveClaudeCodeConfigPath(homeDir);
  if (!fs.existsSync(configPath)) {
    return {
      success: true,
      configPath,
      backupPath: null,
      removedProjectEntries: 0,
    };
  }

  let parsedConfig;
  try {
    parsedConfig = readClientJsonConfig(configPath, "Claude Code", {});
  } catch (error) {
    throw error;
  }

  const config = parsedConfig;
  const projects = config.projects && typeof config.projects === "object" && !Array.isArray(config.projects)
    ? config.projects
    : {};
  let removedProjectEntries = 0;

  for (const projectConfig of Object.values(projects)) {
    if (!projectConfig || typeof projectConfig !== "object" || Array.isArray(projectConfig)) {
      continue;
    }
    const mcpServers = projectConfig.mcpServers;
    if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(mcpServers, BRIDGE_SERVER_NAME)) {
      delete mcpServers[BRIDGE_SERVER_NAME];
      removedProjectEntries += 1;
    }
  }

  if (removedProjectEntries === 0) {
    return {
      success: true,
      configPath,
      backupPath: null,
      removedProjectEntries,
    };
  }

  const writeResult = writeJsonFileAtomic(configPath, config);
  return {
    success: true,
    configPath: writeResult.filePath,
    backupPath: writeResult.backupPath,
    removedProjectEntries,
  };
}

async function writeClaudeCodeConfig({
  userDataPath,
  homeDir,
  bridgeUrl,
  tokenPath,
  env = process.env,
  execFileImpl = execFileAsync,
}) {
  const configPath = resolveClaudeCodeConfigPath(homeDir);
  const snapshot = {
    existed: fs.existsSync(configPath),
    content: fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "",
  };
  const parsedConfig = readClientJsonConfig(configPath, "Claude Code", {});
  let backupPath = null;
  if (snapshot.existed && !snapshot.content.trim()) {
    backupPath = writeJsonFileAtomic(configPath, parsedConfig).backupPath;
  } else if (snapshot.existed) {
    backupPath = backupExistingFile(configPath);
  }

  let helperPath;
  let phase = "helper setup";
  try {
    helperPath = writeClaudeCodeHeadersHelper({ userDataPath, tokenPath });
    const commandOptions = {
      cwd: homeDir,
      env: createEnhancedEnv(env),
      timeout: 15000,
      windowsHide: true,
    };
    const serverConfig = {
      type: "http",
      url: bridgeUrl,
      headersHelper: quoteShellSingle(helperPath),
    };
    phase = "remove";
    try {
      await execFileImpl("claude", [
        "mcp",
        "remove",
        "--scope",
        "user",
        BRIDGE_SERVER_NAME,
      ], commandOptions);
    } catch (error) {
      if (!isClaudeCodeMissingServerError(error)) {
        throw claudeCodeCommandError(phase, error);
      }
    }
    phase = "add-json";
    try {
      await execFileImpl("claude", [
        "mcp",
        "add-json",
        "--scope",
        "user",
        BRIDGE_SERVER_NAME,
        JSON.stringify(serverConfig),
      ], commandOptions);
    } catch (error) {
      throw claudeCodeCommandError(phase, error);
    }
    phase = "project configuration repair";
    const repairResult = repairClaudeCodeProjectScopedConfig({ homeDir });
    phase = "configuration verification";
    const verification = inspectClaudeCodeConfig({ homeDir, userDataPath, bridgeUrl });
    if (!verification.configured) {
      const reason = verification.repairReasons[0] || "configuration_drift";
      throw new Error(`Claude Code configuration verification failed (${reason})`);
    }
    return {
      success: true,
      configPath: repairResult.configPath,
      backupPath: backupPath || repairResult.backupPath,
      helperPath,
    };
  } catch (error) {
    try {
      restoreFileSnapshot(configPath, snapshot);
    } catch (restoreError) {
      const restoreCode = typeof restoreError?.code === "string" ? ` (${restoreError.code})` : "";
      throw new Error(`${sanitizeConfigError(error)}; original Claude Code config could not be restored${restoreCode}`);
    }
    throw error;
  }
}

function tomlEscape(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

function isCodexBridgeTomlHeader(line) {
  return /^\s*\[mcp_servers\.portico\]\s*(?:#.*)?$/.test(line);
}

function isCodexBridgeTomlTableHeader(line) {
  return /^\s*\[mcp_servers\.portico(?:\.[^\]]+)?\]\s*(?:#.*)?$/.test(line);
}

function isTomlTableHeader(line) {
  return /^\s*\[{1,2}[^\]]+\]{1,2}\s*(?:#.*)?$/.test(line);
}

function trimTrailingBlankLines(lines) {
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
}

function pushBlankSeparator(lines) {
  if (lines.length > 0 && lines[lines.length - 1].trim() !== "") {
    lines.push("");
  }
}

function upsertCodexMcpServerToml(content, token, bridgeUrl) {
  const sectionHeader = `[mcp_servers.${BRIDGE_SERVER_NAME}]`;
  const replacementLines = [
    sectionHeader,
    `url = "${tomlEscape(bridgeUrl)}"`,
    `http_headers = { Authorization = "Bearer ${tomlEscape(token)}" }`,
  ];
  const output = [];
  const lines = String(content || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let insertedReplacement = false;
  let foundExistingSection = false;

  const appendReplacement = () => {
    trimTrailingBlankLines(output);
    pushBlankSeparator(output);
    output.push(...replacementLines);
  };

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (isCodexBridgeTomlTableHeader(line)) {
      foundExistingSection = true;
      if (!insertedReplacement) {
        appendReplacement();
        insertedReplacement = true;
      }
      index += 1;
      while (index < lines.length && !isTomlTableHeader(lines[index])) {
        index += 1;
      }
      pushBlankSeparator(output);
      continue;
    }
    output.push(line);
    index += 1;
  }

  if (!foundExistingSection) {
    appendReplacement();
  }
  trimTrailingBlankLines(output);
  return output.join("\n");
}

function removeCodexMcpServerToml(content) {
  const output = [];
  const lines = String(content || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let removed = false;

  for (let index = 0; index < lines.length;) {
    if (isCodexBridgeTomlTableHeader(lines[index])) {
      removed = true;
      index += 1;
      while (index < lines.length && !isTomlTableHeader(lines[index])) {
        index += 1;
      }
      continue;
    }
    output.push(lines[index]);
    index += 1;
  }

  trimTrailingBlankLines(output);
  return {
    removed,
    content: output.join("\n"),
  };
}

function writeCodexConfig({ homeDir, bridgeUrl, token }) {
  const configPath = path.join(homeDir, ".codex", "config.toml");
  const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  const next = upsertCodexMcpServerToml(existing, token, bridgeUrl);
  return {
    success: true,
    ...writeTextAtomicWithBackup(configPath, next.endsWith("\n") ? next : `${next}\n`),
  };
}

function removeCodexConfig({ homeDir }) {
  const configPath = resolveCodexConfigPath(homeDir);
  if (!fs.existsSync(configPath)) {
    return { success: true, configPath, backupPath: null, removed: false };
  }
  const existing = fs.readFileSync(configPath, "utf8");
  const next = removeCodexMcpServerToml(existing);
  if (!next.removed) {
    return { success: true, configPath, backupPath: null, removed: false };
  }
  const writeResult = writeTextAtomicWithBackup(
    configPath,
    next.content ? `${next.content}\n` : "",
  );
  return {
    success: true,
    configPath: writeResult.filePath,
    backupPath: writeResult.backupPath,
    removed: true,
  };
}

function writeCursorConfig({ homeDir, bridgeUrl, token }) {
  const configPath = resolveCursorConfigPath(homeDir);
  const config = readClientJsonConfig(configPath, "Cursor", {});
  config.mcpServers = isPlainObject(config.mcpServers)
    ? config.mcpServers
    : {};
  config.mcpServers[BRIDGE_SERVER_NAME] = {
    type: "http",
    url: bridgeUrl,
    headers: {
      Authorization: `Bearer ${token}`,
    },
  };
  return {
    success: true,
    ...writeJsonFileAtomic(configPath, config),
  };
}

function removeJsonBridgeConfig({ configPath, clientName, mapKey = "mcpServers", jsonc = false }) {
  if (!fs.existsSync(configPath)) {
    return { success: true, configPath, backupPath: null, removed: false };
  }
  const parsedConfig = jsonc
    ? readClientJsoncConfig(configPath, clientName, {})
    : readClientJsonConfig(configPath, clientName, {});
  const config = isPlainObject(parsedConfig) ? parsedConfig : {};
  const mcpServers = isPlainObject(config[mapKey]) ? config[mapKey] : null;
  if (!mcpServers || !Object.prototype.hasOwnProperty.call(mcpServers, BRIDGE_SERVER_NAME)) {
    return { success: true, configPath, backupPath: null, removed: false };
  }
  delete mcpServers[BRIDGE_SERVER_NAME];
  const writeResult = writeJsonFileAtomic(configPath, config);
  return {
    success: true,
    configPath: writeResult.filePath,
    backupPath: writeResult.backupPath,
    removed: true,
  };
}

function removeCursorConfig({ homeDir }) {
  return removeJsonBridgeConfig({
    configPath: resolveCursorConfigPath(homeDir),
    clientName: "Cursor",
  });
}

function resolveAmpSettingsPath(homeDir) {
  const jsonPath = path.join(homeDir, ".config", "amp", "settings.json");
  const jsoncPath = path.join(homeDir, ".config", "amp", "settings.jsonc");
  if (fs.existsSync(jsonPath)) {
    return jsonPath;
  }
  if (fs.existsSync(jsoncPath)) {
    return jsoncPath;
  }
  return jsonPath;
}

function writeAmpConfig({ homeDir, bridgeUrl, token }) {
  const configPath = resolveAmpSettingsPath(homeDir);
  const config = configPath.endsWith(".jsonc")
    ? readClientJsoncConfig(configPath, "Amp", {})
    : readClientJsonConfig(configPath, "Amp", {});
  config["amp.mcpServers"] = isPlainObject(config["amp.mcpServers"])
    ? config["amp.mcpServers"]
    : {};
  config["amp.mcpServers"][BRIDGE_SERVER_NAME] = {
    type: "http",
    url: bridgeUrl,
    headers: {
      Authorization: `Bearer ${token}`,
    },
  };
  return {
    success: true,
    ...writeJsonFileAtomic(configPath, config),
  };
}

function removeAmpConfig({ homeDir }) {
  const configPath = resolveAmpSettingsPath(homeDir);
  return removeJsonBridgeConfig({
    configPath,
    clientName: "Amp",
    mapKey: "amp.mcpServers",
    jsonc: configPath.endsWith(".jsonc"),
  });
}

function getClaudeDesktopLocalProxyDir(userDataPath) {
  return path.join(getBridgeAuthDir(userDataPath), "claude-desktop-local-proxy");
}

function getClaudeDesktopProxyPath(userDataPath) {
  return path.join(getClaudeDesktopLocalProxyDir(userDataPath), "index.js");
}

function getClaudeDesktopLauncherPath(userDataPath, platform = process.platform) {
  return path.join(
    getClaudeDesktopLocalProxyDir(userDataPath),
    platform === "win32" ? "launcher.cmd" : "launcher.sh",
  );
}

function resolveClaudeDesktopConfigPath(homeDir, platform = process.platform, env = process.env) {
  if (platform === "win32") {
    const appData = env.APPDATA || path.join(homeDir, "AppData", "Roaming");
    return path.join(appData, "Claude", "claude_desktop_config.json");
  }
  return path.join(homeDir, "Library", "Application Support", "Claude", "claude_desktop_config.json");
}

function buildClaudeDesktopProxySource() {
  return String.raw`#!/usr/bin/env node
const http = require("http");
const https = require("https");
const fs = require("fs");

const bridgeUrl = process.env.portico_MCP_BRIDGE_URL || "http://127.0.0.1:8891/mcp";
const tokenFile = process.env.portico_MCP_BRIDGE_TOKEN_FILE || "";
let nextBridgeId = 1;
let bridgeSessionId = "";
let initPromise = null;

function readToken() {
  const token = fs.readFileSync(tokenFile, "utf8").trim();
  if (!token) {
    throw new Error("PORTICO MCP bridge token file is empty");
  }
  return token;
}

function requestJsonRpc(payload) {
  const url = new URL(bridgeUrl);
  const body = JSON.stringify(payload);
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json,text/event-stream",
    "Authorization": "Bearer " + readToken(),
    "Content-Length": Buffer.byteLength(body),
  };
  if (bridgeSessionId) {
    headers["Mcp-Session-Id"] = bridgeSessionId;
  }
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request({
      method: "POST",
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      headers,
    }, (res) => {
      if (res.headers["mcp-session-id"]) {
        bridgeSessionId = String(res.headers["mcp-session-id"]);
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error("PORTICO bridge returned HTTP " + res.statusCode + ": " + text));
          return;
        }
        try {
          resolve(parseBridgeResponse(text, res.headers["content-type"] || ""));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function parseBridgeResponse(text, contentType) {
  if (contentType.includes("text/event-stream")) {
    const events = [];
    let dataLines = [];
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      } else if (!line.trim() && dataLines.length > 0) {
        events.push(dataLines.join("\n"));
        dataLines = [];
      }
    }
    if (dataLines.length > 0) {
      events.push(dataLines.join("\n"));
    }
    const jsonEvent = events.find((event) => event && event !== "[DONE]");
    if (!jsonEvent) {
      return null;
    }
    return JSON.parse(jsonEvent);
  }
  if (!text.trim()) {
    return null;
  }
  return JSON.parse(text);
}

async function ensureBridgeInitialized() {
  if (!initPromise) {
    initPromise = (async () => {
      await requestJsonRpc({
        jsonrpc: "2.0",
        id: nextBridgeId++,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "portico-claude-desktop-proxy", version: "0.1.0" },
        },
      });
      await requestJsonRpc({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      });
    })();
  }
  return initPromise;
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

async function handle(request) {
  if (request.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: request.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "portico", version: "0.1.0" },
      },
    });
    return;
  }
  if (request.method === "notifications/initialized") {
    return;
  }
  if (request.method === "tools/list" || request.method === "tools/call") {
    await ensureBridgeInitialized();
    const bridgeResult = await requestJsonRpc({
      jsonrpc: "2.0",
      id: nextBridgeId++,
      method: request.method,
      params: request.params || {},
    });
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: bridgeResult && Object.prototype.hasOwnProperty.call(bridgeResult, "result")
        ? bridgeResult.result
        : bridgeResult,
    });
    return;
  }
  if (Object.prototype.hasOwnProperty.call(request, "id")) {
    send({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: "Unsupported method: " + request.method },
    });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) {
      continue;
    }
    let request;
    try {
      request = JSON.parse(line);
    } catch (error) {
      continue;
    }
    handle(request).catch((error) => {
      if (Object.prototype.hasOwnProperty.call(request, "id")) {
        send({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32000, message: error.message || String(error) },
        });
      }
    });
  }
});
`;
}

function buildClaudeDesktopShellLauncherSource() {
  return [
    "#!/bin/sh",
    "set -eu",
    'SCRIPT_DIR="$(CDPATH= cd "$(dirname "$0")" && pwd)"',
    'PROXY="$SCRIPT_DIR/index.js"',
    "try_node() {",
    '  if [ -n "$1" ] && [ -x "$1" ]; then',
    '    exec "$1" "$PROXY"',
    "  fi",
    "}",
    'try_node "${portico_NODE_BINARY:-}"',
    'if [ -n "${HOST_NODE_BIN_DIR:-}" ]; then',
    '  try_node "$HOST_NODE_BIN_DIR/node"',
    "fi",
    'PATH_NODE="$(command -v node 2>/dev/null || true)"',
    'try_node "$PATH_NODE"',
    'try_node "/opt/homebrew/bin/node"',
    'try_node "/usr/local/bin/node"',
    'try_node "/usr/bin/node"',
    'echo "Portico Claude Desktop proxy could not find a Node.js runtime. Set portico_NODE_BINARY or HOST_NODE_BIN_DIR." >&2',
    "exit 127",
    "",
  ].join("\n");
}

function buildClaudeDesktopCmdLauncherSource() {
  return [
    "@echo off",
    "setlocal",
    'set "SCRIPT_DIR=%~dp0"',
    'set "PROXY=%SCRIPT_DIR%index.js"',
    "if defined portico_NODE_BINARY (",
    '  if exist "%portico_NODE_BINARY%" (',
    '    "%portico_NODE_BINARY%" "%PROXY%"',
    "    exit /b %ERRORLEVEL%",
    "  )",
    ")",
    "if defined HOST_NODE_BIN_DIR (",
    '  if exist "%HOST_NODE_BIN_DIR%\\node.exe" (',
    '    "%HOST_NODE_BIN_DIR%\\node.exe" "%PROXY%"',
    "    exit /b %ERRORLEVEL%",
    "  )",
    ")",
    "where node >nul 2>nul",
    "if %ERRORLEVEL% EQU 0 (",
    '  node "%PROXY%"',
    "  exit /b %ERRORLEVEL%",
    ")",
    "echo Portico Claude Desktop proxy could not find a Node.js runtime. Set portico_NODE_BINARY or HOST_NODE_BIN_DIR. 1>&2",
    "exit /b 127",
    "",
  ].join("\r\n");
}

function writeClaudeDesktopProxyFiles({ userDataPath, platform = process.platform } = {}) {
  if (!isNonEmptyString(userDataPath)) {
    throw new Error("userDataPath is required");
  }
  const proxyDir = getClaudeDesktopLocalProxyDir(userDataPath);
  const proxyPath = getClaudeDesktopProxyPath(userDataPath);
  const launcherPath = getClaudeDesktopLauncherPath(userDataPath, platform);
  ensureDir(proxyDir);
  writeTextAtomicWithBackup(
    proxyPath,
    buildClaudeDesktopProxySource(),
    { mode: 0o700 },
  );
  writeTextAtomicWithBackup(
    launcherPath,
    platform === "win32" ? buildClaudeDesktopCmdLauncherSource() : buildClaudeDesktopShellLauncherSource(),
    { mode: 0o700 },
  );
  return { proxyDir, proxyPath, launcherPath };
}

function writeClaudeDesktopConfig({
  userDataPath,
  homeDir,
  bridgeUrl,
  tokenPath,
  platform = process.platform,
  env = process.env,
}) {
  if (!isNonEmptyString(homeDir)) {
    throw new Error("homeDir is required");
  }
  if (!isNonEmptyString(tokenPath)) {
    throw new Error("tokenPath is required");
  }
  const configPath = resolveClaudeDesktopConfigPath(homeDir, platform, env);
  let parsedConfig;
  try {
    parsedConfig = readClientJsonConfig(configPath, "Claude Desktop", {});
  } catch (error) {
    throw error;
  }
  const config = parsedConfig;
  const proxyFiles = writeClaudeDesktopProxyFiles({
    userDataPath,
    platform,
  });
  config.mcpServers = config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers)
    ? config.mcpServers
    : {};
  config.mcpServers[BRIDGE_SERVER_NAME] = platform === "win32"
    ? {
        command: "cmd",
        args: ["/c", proxyFiles.launcherPath],
        env: {
          portico_MCP_BRIDGE_URL: bridgeUrl || DEFAULT_BRIDGE_URL,
          portico_MCP_BRIDGE_TOKEN_FILE: tokenPath,
        },
      }
    : {
        command: "/bin/sh",
        args: [proxyFiles.launcherPath],
        env: {
          portico_MCP_BRIDGE_URL: bridgeUrl || DEFAULT_BRIDGE_URL,
          portico_MCP_BRIDGE_TOKEN_FILE: tokenPath,
        },
      };
  const writeResult = writeJsonFileAtomic(configPath, config);
  return {
    success: true,
    configPath: writeResult.filePath,
    backupPath: writeResult.backupPath,
    restartRequired: true,
    launcherPath: proxyFiles.launcherPath,
    proxyPath: proxyFiles.proxyPath,
  };
}

function removeClaudeDesktopConfig({
  homeDir,
  platform = process.platform,
  env = process.env,
}) {
  return removeJsonBridgeConfig({
    configPath: resolveClaudeDesktopConfigPath(homeDir, platform, env),
    clientName: "Claude Desktop",
  });
}

function removeClaudeCodeConfig({ homeDir }) {
  const configPath = resolveClaudeCodeConfigPath(homeDir);
  if (!fs.existsSync(configPath)) {
    return {
      success: true,
      configPath,
      backupPath: null,
      removed: false,
      removedUserEntry: false,
      removedProjectEntries: 0,
    };
  }

  const parsedConfig = readClientJsonConfig(configPath, "Claude Code", {});
  const config = isPlainObject(parsedConfig) ? parsedConfig : {};
  let removedUserEntry = false;
  let removedProjectEntries = 0;

  if (objectHasBridgeServer(config.mcpServers)) {
    delete config.mcpServers[BRIDGE_SERVER_NAME];
    removedUserEntry = true;
  }

  const projects = isPlainObject(config.projects) ? config.projects : {};
  for (const projectConfig of Object.values(projects)) {
    if (!isPlainObject(projectConfig)) {
      continue;
    }
    if (objectHasBridgeServer(projectConfig.mcpServers)) {
      delete projectConfig.mcpServers[BRIDGE_SERVER_NAME];
      removedProjectEntries += 1;
    }
  }

  if (!removedUserEntry && removedProjectEntries === 0) {
    return {
      success: true,
      configPath,
      backupPath: null,
      removed: false,
      removedUserEntry,
      removedProjectEntries,
    };
  }

  const writeResult = writeJsonFileAtomic(configPath, config);
  return {
    success: true,
    configPath: writeResult.filePath,
    backupPath: writeResult.backupPath,
    removed: true,
    removedUserEntry,
    removedProjectEntries,
  };
}

function cleanupClientBridgeFiles({ userDataPath, clientId, platform = process.platform } = {}) {
  if (!isNonEmptyString(userDataPath)) {
    return [];
  }
  const removedPaths = [];
  if (clientId === "claude-code") {
    const helperPath = getClaudeCodeHeadersHelperPath(userDataPath, clientId);
    fs.rmSync(helperPath, { force: true });
    removedPaths.push(helperPath);
  } else if (clientId === "claude-desktop") {
    const proxyDir = getClaudeDesktopLocalProxyDir(userDataPath, platform);
    fs.rmSync(proxyDir, { recursive: true, force: true });
    removedPaths.push(proxyDir);
  }
  return removedPaths;
}

function removeBridgeConfigForClient(clientId, options = {}) {
  const homeDir = options.homeDir || defaultHomeDir();
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  if (clientId === "claude-code") {
    return removeClaudeCodeConfig({ homeDir });
  }
  if (clientId === "claude-desktop") {
    return removeClaudeDesktopConfig({ homeDir, platform, env });
  }
  if (clientId === "codex") {
    return removeCodexConfig({ homeDir });
  }
  if (clientId === "cursor") {
    return removeCursorConfig({ homeDir });
  }
  if (clientId === "amp") {
    return removeAmpConfig({ homeDir });
  }
  throw new Error("Unsupported MCP client");
}

function redactedResult(clientId, displayName, result) {
  return {
    clientId,
    displayName,
    success: result.success === true,
    configPath: result.configPath || result.filePath || null,
    backupPath: result.backupPath || null,
    helperPath: result.helperPath || null,
    removed: result.removed === true,
    revoked: result.revoked === true,
    restartRequired: result.restartRequired === true,
    error: result.error ? sanitizeConfigError(result.error) : null,
  };
}

async function configureMcpClients(options = {}) {
  const userDataPath = options.userDataPath;
  const homeDir = options.homeDir || defaultHomeDir();
  const bridgeUrl = options.bridgeUrl || DEFAULT_BRIDGE_URL;
  const selectedClientIds = Array.isArray(options.clientIds) ? options.clientIds : [];
  const selected = new Set(selectedClientIds);
  const clientsById = new Map(SUPPORTED_MCP_CLIENTS.map((client) => [client.id, client]));
  const results = [];

  for (const clientId of selected) {
    const client = clientsById.get(clientId);
    if (!client) {
      results.push({
        clientId,
        displayName: clientId,
        success: false,
        error: "Unsupported MCP client",
      });
      continue;
    }

    try {
      const tokenInfo = ensureClientBridgeToken({
        userDataPath,
        clientId,
        displayName: client.displayName,
      });
      let result;
      if (clientId === "claude-code") {
        result = await writeClaudeCodeConfig({
          userDataPath,
          homeDir,
          bridgeUrl,
          tokenPath: tokenInfo.tokenPath,
          env: options.env || process.env,
          execFileImpl: options.execFileImpl || execFileAsync,
        });
      } else if (clientId === "claude-desktop") {
        result = writeClaudeDesktopConfig({
          userDataPath,
          homeDir,
          bridgeUrl,
          tokenPath: tokenInfo.tokenPath,
          platform: options.platform || process.platform,
          env: options.env || process.env,
        });
      } else if (clientId === "codex") {
        result = writeCodexConfig({ homeDir, bridgeUrl, token: tokenInfo.token });
      } else if (clientId === "cursor") {
        result = writeCursorConfig({ homeDir, bridgeUrl, token: tokenInfo.token });
      } else if (clientId === "amp") {
        result = writeAmpConfig({ homeDir, bridgeUrl, token: tokenInfo.token });
      }
      const redacted = redactedResult(
        clientId,
        client.displayName,
        result || { success: false, error: "No writer was available" },
      );
      if (!redacted.success) {
        redacted.error = logClientConfigFailure("configure", clientId, redacted.error);
      }
      results.push(redacted);
    } catch (error) {
      const safeError = logClientConfigFailure("configure", clientId, error);
      results.push(redactedResult(clientId, client.displayName, {
        success: false,
        error: safeError,
      }));
    }
  }

  return {
    success: results.every((result) => result.success),
    bridgeUrl,
    registryPath: getBridgeTokenRegistryPath(userDataPath),
    results,
  };
}

async function removeMcpClientConfigs(options = {}) {
  const userDataPath = options.userDataPath;
  const homeDir = options.homeDir || defaultHomeDir();
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const selectedClientIds = Array.isArray(options.clientIds) ? options.clientIds : [];
  const selected = new Set(selectedClientIds);
  const clientsById = new Map(SUPPORTED_MCP_CLIENTS.map((client) => [client.id, client]));
  const results = [];

  for (const clientId of selected) {
    const client = clientsById.get(clientId);
    if (!client) {
      results.push({
        clientId,
        displayName: clientId,
        success: false,
        error: "Unsupported MCP client",
      });
      continue;
    }

    try {
      const result = removeBridgeConfigForClient(clientId, { homeDir, platform, env });
      const revokeResult = revokeClientBridgeToken({ userDataPath, clientId });
      cleanupClientBridgeFiles({ userDataPath, clientId, platform });
      results.push(redactedResult(clientId, client.displayName, {
        ...result,
        revoked: revokeResult.revoked === true,
      }));
    } catch (error) {
      const safeError = logClientConfigFailure("remove", clientId, error);
      results.push(redactedResult(clientId, client.displayName, {
        success: false,
        configPath: resolveMcpClientConfigPath(clientId, { homeDir, platform, env }),
        error: safeError,
      }));
    }
  }

  return {
    success: results.every((result) => result.success),
    registryPath: getBridgeTokenRegistryPath(userDataPath),
    results,
  };
}

function revealMcpClientConfig(options = {}) {
  const clientId = options.clientId;
  const client = SUPPORTED_MCP_CLIENTS.find((candidate) => candidate.id === clientId);
  if (!client) {
    return { success: false, error: "Unsupported MCP client" };
  }
  const configPath = resolveMcpClientConfigPath(clientId, options);
  if (!configPath || !fs.existsSync(configPath)) {
    return {
      success: false,
      clientId,
      displayName: client.displayName,
      configPath,
      error: "Configuration file does not exist",
    };
  }
  const shellApi = options.shell;
  if (!shellApi || typeof shellApi.showItemInFolder !== "function") {
    throw new TypeError("shell.showItemInFolder is required");
  }
  shellApi.showItemInFolder(configPath);
  return {
    success: true,
    clientId,
    displayName: client.displayName,
    configPath,
  };
}

module.exports = {
  BRIDGE_SERVER_NAME,
  DEFAULT_BRIDGE_URL,
  MCP_CLIENT_ASSET_DIR,
  MAX_CONFIG_ERROR_LENGTH,
  SUPPORTED_MCP_CLIENTS,
  detectMcpClients,
  configureMcpClients,
  removeMcpClientConfigs,
  revealMcpClientConfig,
  sanitizeConfigError,
  inspectMcpClientConfig,
  repairClaudeCodeProjectScopedConfig,
  resolveClaudeCodeConfigPath,
  resolveMcpClientConfigPath,
  resolveCodexConfigPath,
  resolveCursorConfigPath,
  writeClaudeCodeHeadersHelper,
  writeClaudeCodeConfig,
  writeClaudeDesktopConfig,
  writeClaudeDesktopProxyFiles,
  writeCodexConfig,
  writeCursorConfig,
  writeAmpConfig,
  buildClaudeDesktopShellLauncherSource,
  buildClaudeDesktopCmdLauncherSource,
  buildClaudeDesktopProxySource,
  stripJsonComments,
  upsertCodexMcpServerToml,
  removeCodexMcpServerToml,
  getBridgeClientTokenPath,
  removeClaudeCodeConfig,
  removeClaudeDesktopConfig,
  removeCodexConfig,
  removeCursorConfig,
  removeAmpConfig,
  getClaudeDesktopLocalProxyDir,
  getClaudeDesktopProxyPath,
  getClaudeDesktopLauncherPath,
  resolveClaudeDesktopConfigPath,
  resolveAmpSettingsPath,
};
