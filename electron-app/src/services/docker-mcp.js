// docker-mcp.js - Docker operations, MCP management, and health checks
// Handles Docker status, MCPO lifecycle, health monitoring, and MCP initialization

const { app, BrowserWindow, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const fsPromises = require("fs").promises;
const os = require("os");
const { exec, execFile, spawn, execFileSync } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const crypto = require("crypto");
const yaml = require("js-yaml");

// Import shared state
const state = require("./shared-state");

// Import bootstrap for paths and utilities
const bootstrap = require("./bootstrap");
const { execPromise, getThemeIcon, sendInitLog, logToInitFile } = bootstrap;
const { scanOpenWebuiDbCorruption } = require("./db-repair");
const {
  consumeProcessOutputLines,
  shouldSuppressHostMcpoLogLine,
  classifyHostMcpoStderrLine,
  createSerialTaskQueue,
  markHostMcpoStarting,
  markHostMcpoReady,
  markHostMcpoStopped,
  isHostMcpoStartupPending,
  getHostMcpoStartupPhase,
  shouldTreatHostServerAsStarting,
  writeHostMcpSandboxFiles,
} = require("./host-mcpo-runtime");
const { buildAutoHealRestartGroups } = require("./auto-heal-planner");
const {
  splitPathEntries,
  mergePathEntries,
  prependPathEntry,
  createEnhancedEnv: createBaseEnhancedEnv,
} = require("./env-paths");
const {
  buildForceRemoveContainerCommand,
  buildUpContainerCommand,
  buildUpContainersCommand,
  waitForContainerRunning,
  waitForContainersRunning,
} = require("./docker-compose-command");
const { ensureMcpOrcGeneratorCommand } = require("./mcp-orc-cli");
const {
  getHealthCheckExecTimeoutMs,
  isFreshHealthResult,
  isHealthCheckExecTimeout,
} = require("./health-check-exec-policy");
const { runManagedProcess, signalProcessTree } = require("./managed-process");
// PORTICO-373: process-group termination lives in its own module so the invariant
// ("a timed-out command leaves nothing running") is testable with real
// processes -- this file requires electron and cannot load under `node --test`.
const {
  TREE_TERMINATION_GRACE_MS,
  TREE_EXIT_POLL_INTERVAL_MS,
  processTreeIsGone,
  terminateProcessTree,
  waitForTreeExit,
} = require("./process-tree-termination");
const {
  createSerialPoller,
  probeDockerStatus,
} = require("./docker-status-probe");
const {
  buildQueuedFullHealthRetryPlan,
} = require("./health-sync-queue-policy");
const {
  collectAppOwnedGatewayReportingRoots,
  collectRuntimeReportingCleanupRoots,
  dedupeReportingRoots,
  removeLegacyRequestPayloadsFromRoots,
  resolveRuntimeCostReportingHostDir,
} = require("./runtime-reporting-path");
const { createRuntimeShellEnv } = require("./runtime-shell-env");
const {
  writeProtectedRepositoryEnvAtomicSync,
} = require("./protected-operator-env");
const {
  discoverSensitiveRequiredEnvVarDescriptors,
  discoverSensitiveRuntimeFiles,
  resolveMcpSensitiveEnvSecrets,
  sensitiveRuntimeFileSecretName,
  oauthAccessTokenTokenEnvVar,
  staticSecretTokenEnvVar,
} = require("../config/runtime-secrets-config");
const {
  refreshMcpControlPlane,
  regenerateMcpInfrastructure,
} = require("./mcp-infra-regeneration");
const {
  buildAggregatorInvalidationScope,
} = require("./mcp-runtime-targets");
const {
  collectRestartedHostServerIds,
  ensureServersEnabledForRestart,
  restartHostMcpoWithFreshConfig,
} = require("./host-mcp-lifecycle");
const {
  preserveLaggingServerStates,
} = require("./health-status-preservation");
const {
  McpReadinessPublisher,
} = require("./mcp-readiness-publisher");
const {
  READINESS_PHASE_TOOL_READY,
  canonicalizeReadinessPhase,
} = require("./readiness-phase");
const {
  applyToggleMutationToPath,
  computeMcpToggleRevision,
  loadRawMcpTogglesFromPath,
  normalizeMcpToggleSourceAtPath,
  normalizeToggleValue,
  sanitizeToggleMap,
  writeMcpTogglesAtomicToPath,
} = require("./mcp-toggle-store");
const {
  HARD_DISABLE_MODE,
  applyDisableModeMutationToPath,
  loadRawMcpDisableModesFromPath,
  normalizeMcpDisableModeSourceAtPath,
  writeMcpDisableModesAtomicToPath,
} = require("./mcp-disable-mode-store");
const { safeWebContentsSend } = require("./webcontents-safe");
const {
  applyMainStackOAuthCallbackPortEnv,
} = require("./single-server-port-policy");
const {
  readKonamiUnlocked,
  syncKonamiManagedMirror,
  applyKonamiRuntimeEnv,
} = require("./konami-unlock");
const { readHostModeFile, readHostModeFileSync } = require("./host-mode-state");
const {
  clearStartupFailure,
  clearStartupFailures,
  discoverInstalledMcpServerIds,
  isInstalledMcpServerId,
  loadStartupFailures,
  normalizeStartupFailure,
  overlayStartupFailures,
  recordStartupFailure,
} = require("./mcp-startup-failures");
const {
  buildStartupFailureResult,
  ensureBulkResultsForRequested,
  extractAttributedServerFailure,
  normalizeErrorText,
} = require("./mcp-bulk-toggle-results");
const {
  getGeneratedMcpConfigStatusForServer,
  isRuntimeFileNotConfiguredStatus,
} = require("./runtime-file-status");
const {
  ensureBridgeAuthRegistry,
  ensureScopedBridgeToken,
} = require("./host-mcp-bridge-auth");
const {
  buildBridgeErrorTelemetry,
  emitBridgeLogRepoEvent,
  hashString,
} = require("./host-mcp-bridge-telemetry");
const {
  maybeEmitAppActiveDaily,
} = require("./host-mcp-bridge-adoption-telemetry");

const MAX_SINGLE_RESTART_ATTRIBUTION_RETRIES = 5;

/**
 * Get PROJECT_ROOT from bootstrap (lazy access)
 */
function getProjectRoot() {
  return bootstrap.PROJECT_ROOT;
}

/**
 * Get SCRIPTS_DIR from bootstrap (lazy access)
 */
function getScriptsDir() {
  return bootstrap.SCRIPTS_DIR;
}

function currentAppVersion() {
  try {
    return typeof app.getVersion === "function" ? app.getVersion() : "";
  } catch (_) {
    return "";
  }
}

function bridgeLifecycleTelemetryFields(extra = {}) {
  return {
    event_scope: "summary",
    request_source: "lifecycle",
    caller: "portico_lifecycle",
    app_version: currentAppVersion(),
    bridge_port: state.hostMcpBridge.port,
    ...extra,
  };
}

// ============================================================================
// YAML/ENV HELPERS
// ============================================================================

/**
 * Parse YAML content using js-yaml library
 * Supports all YAML features including nested objects (oauth, etc.)
 */
function parseYaml(content, options = {}) {
  try {
    return yaml.load(content) || {};
  } catch (err) {
    if (options.throwOnError === true) {
      throw err;
    }
    console.error("Error parsing YAML:", err);
    return {};
  }
}

const TOOL_NAME_SANITIZE_RE = /[^A-Za-z0-9_]+/g;
const AGENT_VM_DISABLED_TOOL_RENAMES = Object.freeze({
  vm_search_files: "vm_grep",
  vm_search_file_matches: "vm_grep_file",
});
const NODE_VERSION_REQUIRED_DEFAULT = "20.19.0";
const TOOLS_VERBOSE_LOGS = process.env.TOOLS_VERBOSE_LOGS === "true";
const TOOLS_CACHE_TTL_MS = Math.max(
  1000,
  Number.parseInt(process.env.TOOLS_CACHE_TTL_MS || "15000", 10) || 15000,
);
const HEALTH_CHECK_LOG_STDOUT =
  process.env.HEALTH_CHECK_LOG_STDOUT === "true";
const HEALTH_SYNC_SESSION_ID =
  process.env.HEALTH_SYNC_SESSION_ID ||
  `${Date.now()}-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
const HOST_MCP_BRIDGE_ELECTRON_OAUTH_BROKER_URL =
  process.env.HOST_MCP_BRIDGE_ELECTRON_OAUTH_BROKER_URL ||
  "http://127.0.0.1:9876/api/mcp/oauth/record";
const HOST_MCP_BRIDGE_ELECTRON_OAUTH_UPDATE_URL =
  process.env.HOST_MCP_BRIDGE_ELECTRON_OAUTH_UPDATE_URL ||
  "http://127.0.0.1:9876/api/mcp/oauth/record/update";
const HOST_MCP_BRIDGE_ELECTRON_OAUTH_INVALIDATE_URL =
  process.env.HOST_MCP_BRIDGE_ELECTRON_OAUTH_INVALIDATE_URL ||
  "http://127.0.0.1:9876/api/mcp/oauth/record/invalidate";
const HOST_MCP_BRIDGE_ELECTRON_STATIC_SECRET_BROKER_URL =
  process.env.HOST_MCP_BRIDGE_ELECTRON_STATIC_SECRET_BROKER_URL ||
  "http://127.0.0.1:9876/api/mcp/static-secret";
const portico_OAUTH_ACCESS_TOKEN_BROKER_DEFAULT_URL =
  "http://host.docker.internal:8891/secrets/oauth/access-token";
const HOST_MCP_BRIDGE_ELECTRON_BROKER_TOKEN =
  process.env.HOST_MCP_BRIDGE_ELECTRON_BROKER_TOKEN ||
  `portico_broker_${crypto.randomBytes(32).toString("base64url")}`;
process.env.HOST_MCP_BRIDGE_ELECTRON_BROKER_TOKEN =
  HOST_MCP_BRIDGE_ELECTRON_BROKER_TOKEN;
const serverToolsCache = new Map();
const HOST_MCPO_STARTUP_TIMEOUT_MS = Math.max(
  5000,
  Number.parseInt(process.env.HOST_MCPO_STARTUP_TIMEOUT_MS || "45000", 10) ||
    45000,
);
const HOST_MCP_BRIDGE_STARTUP_TIMEOUT_MS = Math.max(
  5000,
  Number.parseInt(process.env.HOST_MCP_BRIDGE_STARTUP_TIMEOUT_MS || "30000", 10) ||
    30000,
);
const HOST_MCP_BRIDGE_PORT_CLEAR_TIMEOUT_MS = Math.max(
  1000,
  Number.parseInt(process.env.HOST_MCP_BRIDGE_PORT_CLEAR_TIMEOUT_MS || "3000", 10) ||
    3000,
);
const HOST_MCP_BRIDGE_STOP_TIMEOUT_MS = Math.max(
  2000,
  Number.parseInt(process.env.HOST_MCP_BRIDGE_STOP_TIMEOUT_MS || "8000", 10) ||
    8000,
);
const HOST_MCP_BRIDGE_PREFERENCES_FILENAME =
  "host-mcp-bridge-preferences.json";
const HOST_MCP_BRIDGE_PREFERENCES_SCHEMA_VERSION = 1;
const LEGACY_STANDALONE_HOST_MCP_BRIDGE_AGENTS = [
  {
    label: "com.portico.portico-mcp-bridge.bridge",
    plistName: "com.portico.portico-mcp-bridge.bridge.plist",
  },
  {
    label: "com.portico.portico-mcp-bridge.serve",
    plistName: "com.portico.portico-mcp-bridge.serve.plist",
  },
];
const DOCKER_INFO_PROBE_TIMEOUT_MS = 10000;
const ORBSTACK_DOCKER_STARTUP_TIMEOUT_MS = 180000;
const ORBSTACK_DOCKER_POLL_INTERVAL_MS = 2000;
const ORBSTACK_DOCKER_PROGRESS_LOG_INTERVAL_MS = 10000;
const ORBSTACK_DOCKER_STARTUP_TIMEOUT_LABEL = `${ORBSTACK_DOCKER_STARTUP_TIMEOUT_MS / 60000} minutes`;
const ORBSTACK_RESTART_COMMAND_TIMEOUT_MS = 30000;
const ORBSTACK_SYSTEM_APP_PATH = "/Applications/OrbStack.app";
const ORBSTACK_USER_APP_PATH = path.join(os.homedir(), "Applications", "OrbStack.app");
const COST_REPORTING_HOST_DIR_ENV = "PORTICO_COST_REPORTING_HOST_DIR";
const APP_SUPPORT_HOST_DIR_ENV = "PORTICO_APP_SUPPORT_DIR";
const WORKSPACE_CFG_HOST_DIR_ENV = "PORTICO_WORKSPACE_CFG_DIR";
const LLM_GATEWAY_CONTAINER = "llm-gateway";
const LLM_GATEWAY_CONTAINER_ALIASES = [];

function normalizeDisabledToolName(serverId, toolName) {
  if (typeof toolName !== "string" || !toolName) {
    return null;
  }

  if (serverId === "agent-vm") {
    return AGENT_VM_DISABLED_TOOL_RENAMES[toolName] || toolName;
  }

  return toolName;
}

function normalizeDisabledTools(serverId, disabledTools) {
  if (!Array.isArray(disabledTools)) {
    return [];
  }

  const normalized = [];
  const seen = new Set();
  for (const toolName of disabledTools) {
    const canonical = normalizeDisabledToolName(serverId, toolName);
    if (!canonical || seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);
    normalized.push(canonical);
  }
  return normalized;
}
const enqueueHostMcpoOperation = createSerialTaskQueue();
const enqueueHostMcpBridgeOperation = createSerialTaskQueue();
let lastLoggedRuntimeCostReportingHostDir = "";
let rememberedLegacyGatewayReportingRoots = [];
let lastLoggedRuntimeAppSupportHostDir = "";
let lastLoggedRuntimeWorkspaceCfgHostDir = "";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function execFilePromise(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        ...options,
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function defaultHostMcpBridgePreferences() {
  return {
    schemaVersion: HOST_MCP_BRIDGE_PREFERENCES_SCHEMA_VERSION,
    enabled: true,
    updatedAt: null,
    source: null,
    reason: null,
  };
}

function resolveHostMcpBridgePreferencesPath(userDataPath) {
  const basePath = userDataPath || app.getPath("userData");
  return path.join(basePath, HOST_MCP_BRIDGE_PREFERENCES_FILENAME);
}

function normalizeHostMcpBridgePreferences(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      success: false,
      error: "Host MCP Bridge preferences must be a JSON object",
    };
  }

  const schemaVersion = Number.parseInt(raw.schemaVersion, 10);
  if (schemaVersion !== HOST_MCP_BRIDGE_PREFERENCES_SCHEMA_VERSION) {
    return {
      success: false,
      error: `unsupported Host MCP Bridge preferences schemaVersion: ${raw.schemaVersion ?? "missing"}`,
    };
  }

  return {
    success: true,
    data: {
      schemaVersion: HOST_MCP_BRIDGE_PREFERENCES_SCHEMA_VERSION,
      enabled: raw.enabled !== false,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
      source: typeof raw.source === "string" ? raw.source : null,
      reason: typeof raw.reason === "string" ? raw.reason : null,
    },
  };
}

function readHostMcpBridgePreferences(options = {}) {
  let preferencesPath;
  try {
    preferencesPath = resolveHostMcpBridgePreferencesPath(options.userDataPath);
  } catch (error) {
    return {
      success: false,
      exists: false,
      path: null,
      error: error.message,
      data: defaultHostMcpBridgePreferences(),
    };
  }

  if (!fs.existsSync(preferencesPath)) {
    return {
      success: true,
      exists: false,
      path: preferencesPath,
      data: defaultHostMcpBridgePreferences(),
      parseError: null,
    };
  }

  try {
    const normalized = normalizeHostMcpBridgePreferences(
      JSON.parse(fs.readFileSync(preferencesPath, "utf8")),
    );
    if (!normalized.success) {
      return {
        success: true,
        exists: true,
        path: preferencesPath,
        data: defaultHostMcpBridgePreferences(),
        parseError: normalized.error,
      };
    }

    return {
      success: true,
      exists: true,
      path: preferencesPath,
      data: normalized.data,
      parseError: null,
    };
  } catch (error) {
    return {
      success: true,
      exists: true,
      path: preferencesPath,
      data: defaultHostMcpBridgePreferences(),
      parseError: error.message,
    };
  }
}

function isHostMcpBridgeDesiredEnabled(options = {}) {
  return readHostMcpBridgePreferences(options).data.enabled !== false;
}

function setHostMcpBridgeDesiredEnabled(enabled, options = {}) {
  const preferencesPath = resolveHostMcpBridgePreferencesPath(options.userDataPath);
  const data = {
    schemaVersion: HOST_MCP_BRIDGE_PREFERENCES_SCHEMA_VERSION,
    enabled: Boolean(enabled),
    updatedAt: new Date().toISOString(),
    source: typeof options.source === "string" ? options.source : "portico",
    reason: typeof options.reason === "string" ? options.reason : "manual",
  };
  const tempPath = `${preferencesPath}.${process.pid}.${Date.now()}.tmp`;

  fs.mkdirSync(path.dirname(preferencesPath), { recursive: true });
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, preferencesPath);

  return {
    success: true,
    path: preferencesPath,
    data,
  };
}

function normalizePortNumber(port) {
  const portNumber = Number.parseInt(String(port), 10);
  return Number.isInteger(portNumber) && portNumber > 0 ? portNumber : null;
}

// lsof/ps port scans can take multiple seconds under system-wide fd pressure
// (e.g. Docker churn), so they must never run synchronously on the main
// thread and are bounded by this timeout.
const PORT_SCAN_TIMEOUT_MS = 5000;

async function listListeningPidsOnPort(port) {
  const portNumber = normalizePortNumber(port);
  if (!portNumber) {
    return [];
  }

  try {
    const { stdout } = await execFileAsync(
      "lsof",
      ["-nP", `-iTCP:${portNumber}`, "-sTCP:LISTEN", "-t"],
      { encoding: "utf8", timeout: PORT_SCAN_TIMEOUT_MS },
    );
    const output = stdout.trim();
    return output
      ? output
          .split(/\s+/)
          .map((pid) => Number.parseInt(pid, 10))
          .filter((pid) => Number.isInteger(pid) && pid > 0)
      : [];
  } catch (_) {
    return [];
  }
}

async function processGroupIdForPid(pid) {
  const pidNumber = Number.parseInt(String(pid), 10);
  if (!Number.isInteger(pidNumber) || pidNumber <= 0) {
    return null;
  }

  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-p", String(pidNumber), "-o", "pgid="],
      { encoding: "utf8", timeout: PORT_SCAN_TIMEOUT_MS },
    );
    const pgid = Number.parseInt(stdout.trim(), 10);
    return Number.isInteger(pgid) && pgid > 0 ? pgid : null;
  } catch (_) {
    return null;
  }
}

async function isPortListenerOwnedByProcessGroup(port, processGroupPid) {
  const expectedPgid = Number.parseInt(String(processGroupPid), 10);
  if (!Number.isInteger(expectedPgid) || expectedPgid <= 0) {
    return false;
  }

  for (const pid of await listListeningPidsOnPort(port)) {
    if ((await processGroupIdForPid(pid)) === expectedPgid) {
      return true;
    }
  }
  return false;
}

async function waitForPortListenersToClear(
  port,
  timeoutMs = HOST_MCP_BRIDGE_PORT_CLEAR_TIMEOUT_MS,
) {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  let listenerPids = await listListeningPidsOnPort(port);
  while (listenerPids.length > 0 && Date.now() < deadline) {
    await sleep(Math.min(200, Math.max(1, deadline - Date.now())));
    listenerPids = await listListeningPidsOnPort(port);
  }

  if (listenerPids.length === 0) {
    return true;
  }

  console.warn(
    `[PortCleanup] Port ${port} still has listener(s) after ${timeoutMs}ms: ${listenerPids.join(", ")}`,
  );
  return false;
}

function launchctlMissingServiceError(error) {
  const message = `${error?.message || ""}\n${error?.stderr || ""}\n${error?.stdout || ""}`;
  return (
    /Could not find specified service/i.test(message) ||
    /No such process/i.test(message) ||
    /service is not loaded/i.test(message) ||
    /Boot-out failed:\s*5/i.test(message) ||
    /Bootstrap failed:\s*5/i.test(message)
  );
}

async function stopLegacyStandaloneHostMcpBridgeLaunchAgents() {
  if (process.platform !== "darwin" || typeof process.getuid !== "function") {
    return { stopped: [], missing: [], errors: [] };
  }

  const domain = `gui/${process.getuid()}`;
  const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
  const stopped = [];
  const missing = [];
  const errors = [];

  for (const agent of LEGACY_STANDALONE_HOST_MCP_BRIDGE_AGENTS) {
    const plistPath = path.join(launchAgentsDir, agent.plistName);
    if (!fs.existsSync(plistPath)) {
      missing.push(agent.label);
      continue;
    }

    try {
      await execFilePromise("launchctl", ["disable", `${domain}/${agent.label}`]);
    } catch (error) {
      if (!launchctlMissingServiceError(error)) {
        errors.push(`${agent.label} disable failed: ${error.stderr || error.message}`);
      }
    }

    try {
      await execFilePromise("launchctl", ["bootout", domain, plistPath]);
      stopped.push(agent.label);
    } catch (error) {
      if (launchctlMissingServiceError(error)) {
        missing.push(agent.label);
      } else {
        errors.push(`${agent.label} bootout failed: ${error.stderr || error.message}`);
      }
    }
  }

  if (stopped.length > 0) {
    console.log(
      `[Host MCP Bridge] Stopped legacy standalone LaunchAgent(s): ${stopped.join(", ")}`,
    );
  }
  if (errors.length > 0) {
    console.warn(
      `[Host MCP Bridge] Legacy standalone LaunchAgent stop warnings: ${errors.join("; ")}`,
    );
  }

  return { stopped, missing, errors };
}

function canonicalizeContainerName(name) {
  if (name === LLM_GATEWAY_CONTAINER) {
    return LLM_GATEWAY_CONTAINER;
  }
  if (LLM_GATEWAY_CONTAINER_ALIASES.includes(name)) {
    return LLM_GATEWAY_CONTAINER;
  }
  return name;
}

function canonicalizeContainerStatusMap(status = {}) {
  const normalized = { ...status };

  if (normalized[LLM_GATEWAY_CONTAINER] == null) {
    for (const alias of LLM_GATEWAY_CONTAINER_ALIASES) {
      if (normalized[alias] != null) {
        normalized[LLM_GATEWAY_CONTAINER] = normalized[alias];
        break;
      }
    }
  }

  for (const alias of LLM_GATEWAY_CONTAINER_ALIASES) {
    delete normalized[alias];
  }

  return normalized;
}

function canonicalizeVersionInfo(versionInfo = {}) {
  const containers = canonicalizeContainerStatusMap(versionInfo.containers || {});
  return {
    ...versionInfo,
    containers,
  };
}

function summarizeOutputLines(output = "") {
  if (!output) return 0;
  return output.split(/\r?\n/).filter(Boolean).length;
}

function truncateOutput(output = "", maxLen = 2000) {
  if (!output || output.length <= maxLen) return output;
  return `${output.slice(0, maxLen)}\n...<truncated ${output.length - maxLen} chars>`;
}

function healthSyncLogDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function sanitizeHealthSyncRunnerValue(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeHealthSyncRunnerValue);
  }
  if (!value || typeof value !== "object") {
    return typeof value === "string" && value.length > 1000
      ? `${value.slice(0, 1000)}...<truncated>`
      : value;
  }

  const sanitized = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (
      [
        "request",
        "response",
        "payload",
        "raw_payload",
        "raw_response",
        "body",
        "messages",
        "content",
        "arguments",
        "tool_args",
        "tool_arguments",
        "stdout",
        "stderr",
      ].includes(normalized) ||
      normalized.includes("token") ||
      normalized.includes("secret") ||
      normalized.includes("password") ||
      normalized.includes("credential") ||
      normalized.includes("authorization") ||
      normalized.includes("api_key")
    ) {
      sanitized[key] = "[redacted]";
    } else {
      sanitized[key] = sanitizeHealthSyncRunnerValue(nestedValue);
    }
  }
  return sanitized;
}

function formatHealthSyncRunnerScalar(value) {
  if (value === null || value === undefined) {
    return "n/a";
  }
  if (Array.isArray(value)) {
    const rendered = value.slice(0, 8).map(formatHealthSyncRunnerScalar);
    if (value.length > rendered.length) {
      rendered.push(`+${value.length - rendered.length} more`);
    }
    return `[${rendered.join(", ")}]`;
  }
  if (typeof value === "object") {
    return "";
  }
  return String(value);
}

function formatHealthSyncRunnerDetails(event, details = {}) {
  const get = (key) => formatHealthSyncRunnerScalar(details[key]);
  switch (event) {
    case "health_sync_runner_start":
      return `mode=${get("mode")} reason=${get("reason")} timeout_ms=${get("timeout_budget_ms")}`;
    case "health_sync_runner_success":
      return `elapsed_ms=${get("elapsed_ms")} stdout_lines=${get("stdout_lines")} stderr_lines=${get("stderr_lines")}`;
    case "health_sync_runner_timeout":
    case "health_sync_runner_failure":
    case "health_sync_runner_stop_failed":
      return `elapsed_ms=${get("elapsed_ms")} timeout_ms=${get("timeout_budget_ms")} timed_out=${get("timed_out")} error=${get("error")}`;
    case "health_sync_runner_fallback_snapshot":
      return `fallback_snapshot=${get("used_fallback_snapshot")} health_status_exists=${get("health_status_exists")}`;
    case "health_sync_runner_queued_retry":
      return `next_mode=${get("next_mode")} retry_delay_ms=${get("retry_delay_ms")}`;
    default:
      return Object.entries(details)
        .map(([key, value]) => [key, formatHealthSyncRunnerScalar(value)])
        .filter(([, value]) => value !== "")
        .map(([key, value]) => `${key}=${value}`)
        .join(" ");
  }
}

function formatHealthSyncRunnerTextEntry(entry) {
  const summary = formatHealthSyncRunnerDetails(entry.event, entry.details || {});
  const prefix = `${entry.timestamp} | ${entry.mode || "n/a"} | ${entry.event} | run=${entry.run_id || "n/a"} | reason=${entry.reason || "n/a"} | timeout_ms=${entry.timeout_budget_ms ?? "n/a"}`;
  return summary ? `${prefix} | ${summary}` : prefix;
}

function removeLegacyJsonHealthSyncLines(logPath) {
  try {
    if (!fs.existsSync(logPath)) {
      return;
    }
    const contents = fs.readFileSync(logPath, "utf8");
    const lines = contents.split(/\r?\n/);
    if (!lines.some((line) => line.trimStart().startsWith("{"))) {
      return;
    }
    const retained = lines.filter(
      (line) => line.length > 0 && !line.trimStart().startsWith("{"),
    );
    fs.writeFileSync(logPath, retained.length ? `${retained.join("\n")}\n` : "");
  } catch (error) {
    console.warn(`[Health] Failed to remove legacy JSON health sync lines: ${error.message}`);
  }
}

function appendHealthSyncRunnerEvent(event, details = {}, env = null) {
  try {
    const appSupportDir =
      env?.[APP_SUPPORT_HOST_DIR_ENV] ||
      process.env[APP_SUPPORT_HOST_DIR_ENV] ||
      (app && typeof app.getPath === "function" ? app.getPath("userData") : "") ||
      path.join(getProjectRoot(), "open-webui-data", "app-support");
    const logDir = path.join(appSupportDir, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const entry = {
      timestamp: new Date().toISOString(),
      event,
      source: "electron-runner",
      run_id: details.run_id || "",
      reason: details.reason || "",
      mode: details.mode || "",
      timeout_budget_ms: details.timeout_budget_ms ?? null,
      details: sanitizeHealthSyncRunnerValue(details),
    };
    const date = healthSyncLogDate();
    const logPath = path.join(logDir, `health-sync-${date}.log`);
    removeLegacyJsonHealthSyncLines(logPath);
    fs.appendFileSync(
      logPath,
      `${formatHealthSyncRunnerTextEntry(entry)}\n`,
    );
  } catch (error) {
    console.warn(`[Health] Failed to append health sync runner event: ${error.message}`);
  }
}

function sanitizeToolName(name) {
  if (!name || typeof name !== "string") return "";
  const sanitized = name.trim().replace(TOOL_NAME_SANITIZE_RE, "_");
  return sanitized.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
}

function cloneToolsResult(result) {
  if (!result || typeof result !== "object") {
    return result;
  }

  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(result);
  }

  return JSON.parse(JSON.stringify(result));
}

async function getToolsConfigMtimeMs(toolsConfigPath) {
  try {
    const stats = await fsPromises.stat(toolsConfigPath);
    if (Number.isFinite(stats.mtimeMs)) {
      return Math.round(stats.mtimeMs);
    }
  } catch (error) {
    // Ignore missing file and fallback to zero mtime.
  }
  return 0;
}

function getCachedServerToolsResult(serverId, toolsConfigMtimeMs) {
  const cached = serverToolsCache.get(serverId);
  if (!cached) {
    return null;
  }

  const ageMs = Date.now() - cached.fetchedAt;
  if (ageMs > TOOLS_CACHE_TTL_MS) {
    serverToolsCache.delete(serverId);
    return null;
  }

  if (cached.toolsConfigMtimeMs !== toolsConfigMtimeMs) {
    serverToolsCache.delete(serverId);
    return null;
  }

  return cloneToolsResult(cached.result);
}

function cacheServerToolsResult(serverId, toolsConfigMtimeMs, result) {
  serverToolsCache.set(serverId, {
    fetchedAt: Date.now(),
    toolsConfigMtimeMs,
    result: cloneToolsResult(result),
  });
}

function invalidateServerToolsCache(serverId = null) {
  if (!serverId) {
    serverToolsCache.clear();
    return;
  }
  serverToolsCache.delete(serverId);
}


function runtimeReportingCleanupRoots() {
  const userDataPath =
    app && typeof app.getPath === "function" ? app.getPath("userData") : "";
  return collectRuntimeReportingCleanupRoots({
    env: process.env,
    isPackagedApp: app?.isPackaged === true,
    projectRoot: getProjectRoot(),
    userDataPath,
  });
}

async function cleanupLegacyRequestPayloadsFromKnownRoots() {
  const result = await removeLegacyRequestPayloadsFromRoots(
    runtimeReportingCleanupRoots(),
  );
  if (result.failures > 0) {
    console.warn(
      "[CostReporting] Legacy request payload cleanup could not remove one or more locations",
    );
  }
  return result;
}

async function cleanupLegacyRequestPayloadsFromGatewayMounts() {
  const discovery = await collectAppOwnedGatewayReportingRoots({
    execFileAsync: execFilePromise,
  });
  rememberedLegacyGatewayReportingRoots = dedupeReportingRoots([
    ...rememberedLegacyGatewayReportingRoots,
    ...discovery.roots,
  ]);
  const cleanup = await removeLegacyRequestPayloadsFromRoots(discovery.roots);
  const result = {
    attempted: cleanup.attempted,
    ensuredAbsent: cleanup.ensuredAbsent,
    failures: cleanup.failures + discovery.failures,
  };
  if (result.failures > 0) {
    console.warn(
      "[CostReporting] Legacy request payload cleanup could not inspect or clean one or more app-owned gateway mounts",
    );
  }
  return result;
}

async function cleanupLegacyRequestPayloadsFromKnownAndRememberedRoots() {
  const result = await removeLegacyRequestPayloadsFromRoots([
    ...runtimeReportingCleanupRoots(),
    ...rememberedLegacyGatewayReportingRoots,
  ]);
  if (result.failures > 0) {
    console.warn(
      "[CostReporting] Post-stop legacy request payload cleanup could not remove one or more locations",
    );
  }
  return result;
}

function ensureRuntimeCostReportingHostDir(env) {
  const userDataPath =
    app && typeof app.getPath === "function" ? app.getPath("userData") : "";
  const reportingHostDir = resolveRuntimeCostReportingHostDir({
    env,
    isPackagedApp: app.isPackaged === true,
    projectRoot: getProjectRoot(),
    userDataPath,
  });

  env[COST_REPORTING_HOST_DIR_ENV] = reportingHostDir;

  try {
    fs.mkdirSync(reportingHostDir, { recursive: true });
  } catch (error) {
    console.warn(
      `[CostReporting] Failed to ensure runtime reporting directory ${reportingHostDir}: ${error.message}`,
    );
  }

  if (reportingHostDir && reportingHostDir !== lastLoggedRuntimeCostReportingHostDir) {
    console.log(
      `[CostReporting] Runtime host reporting directory: ${reportingHostDir}`,
    );
    lastLoggedRuntimeCostReportingHostDir = reportingHostDir;
  }

  return env;
}

function ensureRuntimeAppSupportHostDir(env) {
  const configuredHostDir =
    typeof env[APP_SUPPORT_HOST_DIR_ENV] === "string"
      ? env[APP_SUPPORT_HOST_DIR_ENV].trim()
      : "";
  const userDataPath =
    app && typeof app.getPath === "function" ? app.getPath("userData") : "";
  const appSupportHostDir =
    configuredHostDir || userDataPath || path.join(getProjectRoot(), "open-webui-data", "app-support");

  env[APP_SUPPORT_HOST_DIR_ENV] = appSupportHostDir;

  try {
    fs.mkdirSync(appSupportHostDir, { recursive: true });
    // Pre-create the Slack sync-state dir so its bind mount never
    // materializes as a root-owned surprise directory. Host-editable by
    // design: operators/e2e tests edit the sync stamp here to time-travel
    // cache freshness.
    fs.mkdirSync(path.join(appSupportHostDir, "slack-mcp-state"), {
      recursive: true,
    });
  } catch (error) {
    console.warn(
      `[AppSupport] Failed to ensure runtime Application Support directory ${appSupportHostDir}: ${error.message}`,
    );
  }

  if (
    appSupportHostDir &&
    appSupportHostDir !== lastLoggedRuntimeAppSupportHostDir
  ) {
    console.log(
      `[AppSupport] Runtime host Application Support directory: ${appSupportHostDir}`,
    );
    lastLoggedRuntimeAppSupportHostDir = appSupportHostDir;
  }

  return env;
}

function ensureRuntimeWorkspaceCfgHostDir(env) {
  const configuredHostDir =
    typeof env[WORKSPACE_CFG_HOST_DIR_ENV] === "string"
      ? env[WORKSPACE_CFG_HOST_DIR_ENV].trim()
      : "";
  const userDataPath =
    app && typeof app.getPath === "function" ? app.getPath("userData") : "";
  const workspaceCfgHostDir =
    configuredHostDir ||
    (userDataPath ? path.join(userDataPath, "workspace-cfg") : "") ||
    path.join(getProjectRoot(), "open-webui-data", "workspace-cfg");

  env[WORKSPACE_CFG_HOST_DIR_ENV] = workspaceCfgHostDir;

  try {
    fs.mkdirSync(workspaceCfgHostDir, { recursive: true });
  } catch (error) {
    console.warn(
      `[WorkspaceCfg] Failed to ensure runtime workspace config directory ${workspaceCfgHostDir}: ${error.message}`,
    );
  }

  if (
    workspaceCfgHostDir &&
    workspaceCfgHostDir !== lastLoggedRuntimeWorkspaceCfgHostDir
  ) {
    console.log(
      `[WorkspaceCfg] Runtime host workspace config directory: ${workspaceCfgHostDir}`,
    );
    lastLoggedRuntimeWorkspaceCfgHostDir = workspaceCfgHostDir;
  }

  return env;
}

function ensureStaticSecretBridgeTokenEnv(env, { userDataPath, projectRoot } = {}) {
  if (!userDataPath || !projectRoot) {
    return env;
  }

  let registryPath;
  try {
    registryPath = ensureBridgeAuthRegistry({ userDataPath });
  } catch (error) {
    console.warn(
      `[Static Secret Broker] Failed to prepare bridge auth registry: ${error.message}`,
    );
    return env;
  }

  const descriptors = [];
  try {
    for (const descriptor of discoverSensitiveRequiredEnvVarDescriptors({
      projectRoot,
    })) {
      descriptors.push({
        serverId: descriptor.serverId,
        secretName: descriptor.secretName,
      });
    }
    for (const runtimeFile of discoverSensitiveRuntimeFiles({ projectRoot })) {
      descriptors.push({
        serverId: runtimeFile.serverId,
        secretName: sensitiveRuntimeFileSecretName(
          runtimeFile.serverId,
          runtimeFile.target,
        ),
      });
    }
  } catch (error) {
    console.warn(
      `[Static Secret Broker] Failed to discover scoped static secrets: ${error.message}`,
    );
    return env;
  }

  const seen = new Set();
  for (const descriptor of descriptors) {
    const scope = `static-secret:${descriptor.serverId}:${descriptor.secretName}`;
    if (seen.has(scope)) {
      continue;
    }
    seen.add(scope);
    try {
      const tokenInfo = ensureScopedBridgeToken({
        userDataPath,
        registryPath,
        clientId: `static-secret-${descriptor.serverId}-${descriptor.secretName}`,
        displayName: `Static secret ${descriptor.serverId}/${descriptor.secretName}`,
        scopes: [scope],
      });
      env[staticSecretTokenEnvVar(descriptor.serverId, descriptor.secretName)] =
        tokenInfo.token;
    } catch (error) {
      console.warn(
        `[Static Secret Broker] Failed to prepare scoped token for ${descriptor.serverId}/${descriptor.secretName}: ${error.message}`,
      );
    }
  }

  env.HOST_MCP_BRIDGE_AUTH_REGISTRY = registryPath;
  env.portico_STATIC_SECRET_BROKER_URL =
    env.portico_STATIC_SECRET_BROKER_URL ||
    "http://host.docker.internal:8891/secrets/static-secret";
  return env;
}

function configSupportsNativeOAuth(config) {
  if (!config || typeof config !== "object") {
    return false;
  }
  if (config.oauth && typeof config.oauth === "object") {
    return true;
  }
  const serverType = String(config.type || "")
    .trim()
    .toLowerCase()
    .replaceAll("_", "-");
  return (
    serverType === "streamable-http" ||
    serverType === "streamablehttp" ||
    serverType === "sse" ||
    (config.http_subprocess && typeof config.http_subprocess === "object")
  );
}

function discoverOAuthServerIdsFromGeneratedConfigs({ projectRoot } = {}) {
  if (!projectRoot) {
    return [];
  }
  const serverIds = new Set();
  const generatedConfigDir = path.join(projectRoot, "mcpo-configs-generated");
  let entries;
  try {
    entries = fs.readdirSync(generatedConfigDir, { withFileTypes: true });
  } catch (_) {
    entries = [];
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(
        fs.readFileSync(path.join(generatedConfigDir, entry.name), "utf8"),
      );
    } catch (_) {
      continue;
    }
    const servers =
      parsed && typeof parsed.mcpServers === "object" && parsed.mcpServers
        ? parsed.mcpServers
        : {};
    for (const [serverId, config] of Object.entries(servers)) {
      if (
        typeof serverId === "string" &&
        serverId.trim() &&
        configSupportsNativeOAuth(config)
      ) {
        serverIds.add(serverId.trim());
      }
    }
  }

  for (const configRootName of ["mcp-configs", "mcp-configs-user"]) {
    const configRoot = path.join(projectRoot, configRootName);
    let serverDirs;
    try {
      serverDirs = fs.readdirSync(configRoot, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const serverDir of serverDirs) {
      if (!serverDir.isDirectory()) {
        continue;
      }
      const yamlPath = path.join(
        configRoot,
        serverDir.name,
        `${serverDir.name}.yaml`,
      );
      let parsed;
      try {
        parsed = yaml.load(fs.readFileSync(yamlPath, "utf8")) || {};
      } catch (_) {
        continue;
      }
      const serverId =
        typeof parsed.id === "string" && parsed.id.trim()
          ? parsed.id.trim()
          : serverDir.name;
      if (
        parsed.oauth &&
        typeof parsed.oauth === "object" &&
        typeof serverId === "string" &&
        serverId.trim()
      ) {
        serverIds.add(serverId.trim());
      }

      const fragmentPath = path.join(
        configRoot,
        serverDir.name,
        `${serverDir.name}.fragment`,
      );
      try {
        const fragment = JSON.parse(fs.readFileSync(fragmentPath, "utf8"));
        if (configSupportsNativeOAuth(fragment)) {
          serverIds.add(serverId.trim());
        }
      } catch (_) {
        // Missing or malformed fragments are handled by the canonical config
        // generator; they cannot safely receive a scoped broker credential.
      }
    }
  }
  return Array.from(serverIds).sort();
}

function ensureOAuthAccessTokenBridgeTokenEnv(
  env,
  { userDataPath, projectRoot } = {},
) {
  if (!userDataPath || !projectRoot) {
    return env;
  }

  let registryPath;
  try {
    registryPath = ensureBridgeAuthRegistry({ userDataPath });
  } catch (error) {
    console.warn(
      `[OAuth Access Token Broker] Failed to prepare bridge auth registry: ${error.message}`,
    );
    return env;
  }

  let serverIds = [];
  try {
    serverIds = discoverOAuthServerIdsFromGeneratedConfigs({ projectRoot });
  } catch (error) {
    console.warn(
      `[OAuth Access Token Broker] Failed to discover OAuth server ids: ${error.message}`,
    );
    return env;
  }

  for (const serverId of serverIds) {
    const scope = `oauth:access-token:${serverId}`;
    try {
      const tokenInfo = ensureScopedBridgeToken({
        userDataPath,
        registryPath,
        clientId: `oauth-access-token-${serverId}`,
        displayName: `OAuth access-token broker ${serverId}`,
        scopes: [scope],
      });
      env[oauthAccessTokenTokenEnvVar(serverId)] = tokenInfo.token;
    } catch (error) {
      console.warn(
        `[OAuth Access Token Broker] Failed to prepare scoped token for ${serverId}: ${error.message}`,
      );
    }
  }

  if (serverIds.length > 0) {
    env.HOST_MCP_BRIDGE_AUTH_REGISTRY = registryPath;
    env.portico_OAUTH_ACCESS_TOKEN_BROKER_URL =
      env.portico_OAUTH_ACCESS_TOKEN_BROKER_URL ||
      portico_OAUTH_ACCESS_TOKEN_BROKER_DEFAULT_URL;
  }
  return env;
}

function ensureSchedulerBridgeStatusTokenEnv(env, { userDataPath } = {}) {
  if (!userDataPath) {
    return env;
  }

  let registryPath;
  try {
    registryPath = ensureBridgeAuthRegistry({ userDataPath });
  } catch (error) {
    console.warn(
      `[Scheduler Bridge Status] Failed to prepare bridge auth registry: ${error.message}`,
    );
    return env;
  }

  try {
    const tokenInfo = ensureScopedBridgeToken({
      userDataPath,
      registryPath,
      clientId: "scheduling-status",
      displayName: "Scheduling bridge status",
      scopes: ["bridge:status"],
    });
    env.HOST_MCP_BRIDGE_AUTH_REGISTRY = registryPath;
    env.portico_SCHEDULER_BRIDGE_STATUS_URL =
      env.portico_SCHEDULER_BRIDGE_STATUS_URL ||
      "http://host.docker.internal:8891/bridge/status";
    env.portico_SCHEDULER_BRIDGE_STATUS_TOKEN = tokenInfo.token;
  } catch (error) {
    console.warn(
      `[Scheduler Bridge Status] Failed to prepare scoped bridge status token: ${error.message}`,
    );
  }
  return env;
}

function sanitizeHostMcpBridgeEnv(env) {
  const cleaned = { ...env };
  delete cleaned.portico_SCHEDULER_BRIDGE_STATUS_URL;
  delete cleaned.portico_SCHEDULER_BRIDGE_STATUS_TOKEN;
  delete cleaned.portico_OAUTH_ACCESS_TOKEN_BROKER_URL;
  delete cleaned.portico_OAUTH_ACCESS_TOKEN_BROKER_TOKEN;
  delete cleaned.portico_OAUTH_ACCESS_TOKEN_SERVER_ID;
  for (const key of Object.keys(cleaned)) {
    if (key.startsWith("portico_OAUTH_ACCESS_TOKEN_TOKEN_")) {
      delete cleaned[key];
    }
  }
  return cleaned;
}

function createEnhancedEnv(overrides = {}) {
  const userDataPath = app?.isReady?.() ? app.getPath("userData") : "";
  const projectRoot = getProjectRoot();
  const konamiUnlocked = readKonamiUnlocked({ userDataPath });
  const runtimeEnv = createRuntimeShellEnv({
    baseEnv: process.env,
    overrides: {
      PROJECT_ROOT: projectRoot,
      ...overrides,
    },
    isPackagedApp: app.isPackaged === true,
    resourcesPath: process.resourcesPath,
  });

  syncKonamiManagedMirror({ userDataPath, projectRoot });

  const konamiEnv = applyKonamiRuntimeEnv(runtimeEnv, konamiUnlocked);
  const oauthBrokerEnv = ensureOAuthAccessTokenBridgeTokenEnv(konamiEnv, {
    userDataPath,
    projectRoot,
  });
  const staticSecretEnv = ensureStaticSecretBridgeTokenEnv(oauthBrokerEnv, {
    userDataPath,
    projectRoot,
  });
  const schedulerStatusEnv = ensureSchedulerBridgeStatusTokenEnv(staticSecretEnv, {
    userDataPath,
  });

  return ensureRuntimeWorkspaceCfgHostDir(
    ensureRuntimeAppSupportHostDir(
      ensureRuntimeCostReportingHostDir(
        schedulerStatusEnv,
      ),
    ),
  );
}

function stripPackageManagerCredentialEnv(env) {
  const cleaned = { ...env };
  for (const key of Object.keys(cleaned)) {
    if (
      key.startsWith("npm_config_") ||
      key.startsWith("NPM_CONFIG_") ||
      key.startsWith("YARN_NPM_") ||
      key.startsWith("COREPACK_NPM_") ||
      key.startsWith("BUN_CONFIG_") ||
      [
        "NODE_AUTH_TOKEN",
        "NPM_AUTH_TOKEN",
        "NPM_TOKEN",
        "YARN_NPM_AUTH_TOKEN",
        "YARN_NPM_AUTH_IDENT",
        "COREPACK_NPM_TOKEN",
        "COREPACK_NPM_USERNAME",
        "COREPACK_NPM_PASSWORD",
        "BUN_AUTH_TOKEN",
        "NVM_NODEJS_ORG_MIRROR",
      ].includes(key)
    ) {
      delete cleaned[key];
    }
  }
  return cleaned;
}

function isExecutableFile(filePath) {
  if (!filePath) return false;
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch (err) {
    return false;
  }
}

function resolveExecutable(binaryName, searchPath = process.env.PATH || "") {
  for (const pathEntry of splitPathEntries(searchPath)) {
    const candidate = path.join(pathEntry, binaryName);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return "";
}

function normalizeSemver(rawVersion = "") {
  const match = String(rawVersion).trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) {
    return null;
  }
  return [
    Number.parseInt(match[1] || "0", 10),
    Number.parseInt(match[2] || "0", 10),
    Number.parseInt(match[3] || "0", 10),
  ];
}

function compareSemver(leftRaw, rightRaw) {
  const left = normalizeSemver(leftRaw);
  const right = normalizeSemver(rightRaw);
  if (!left || !right) {
    return null;
  }
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return 1;
    if (left[index] < right[index]) return -1;
  }
  return 0;
}

function isNodeVersionCompatible(nodeVersion, requiredVersion) {
  const comparison = compareSemver(nodeVersion, requiredVersion);
  return comparison !== null && comparison >= 0;
}

function listNodeInstallBinDirs(baseDir) {
  try {
    return fs
      .readdirSync(baseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("node-"))
      .map((entry) => path.join(baseDir, entry.name, "bin"))
      .filter((candidate) => {
        try {
          return fs.statSync(candidate).isDirectory();
        } catch (_error) {
          return false;
        }
      })
      .sort((left, right) => {
        const leftVersion = path.basename(path.dirname(left)).replace(/^node-/, "");
        const rightVersion = path.basename(path.dirname(right)).replace(/^node-/, "");
        const comparison = compareSemver(rightVersion, leftVersion);
        return comparison === null ? right.localeCompare(left) : comparison;
      });
  } catch (_error) {
    return [];
  }
}

function listNvmNodeBinDirs(baseDir) {
  try {
    return fs
      .readdirSync(baseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(baseDir, entry.name, "bin"))
      .filter((candidate) => {
        try {
          return fs.statSync(candidate).isDirectory();
        } catch (_error) {
          return false;
        }
      })
      .sort((left, right) => {
        const leftVersion = path.basename(path.dirname(left));
        const rightVersion = path.basename(path.dirname(right));
        const comparison = compareSemver(rightVersion, leftVersion);
        return comparison === null ? right.localeCompare(left) : comparison;
      });
  } catch (_error) {
    return [];
  }
}

function getHostNodeRuntimeCandidateDirs() {
  const candidates = [];
  const configuredNodeBinDir = process.env.HOST_NODE_BIN_DIR || "";
  if (configuredNodeBinDir) {
    candidates.push(configuredNodeBinDir);
  }

  const homeDir = os.homedir();
  candidates.push(...splitPathEntries(process.env.PATH || ""));
  const nvmRoot =
    process.env.NVM_DIR || (homeDir ? path.join(homeDir, ".nvm") : "");
  if (nvmRoot) {
    candidates.push(
      ...listNvmNodeBinDirs(path.join(nvmRoot, "versions", "node")),
    );
  }
  const defaultInstallRoots = [
    homeDir ? path.join(homeDir, ".local", "lib", "nodejs") : "",
    "/usr/local/lib/nodejs",
  ].filter(Boolean);
  const installRoots = process.env.HOST_NODE_INSTALL_ROOTS
    ? splitPathEntries(process.env.HOST_NODE_INSTALL_ROOTS)
    : defaultInstallRoots;
  for (const installRoot of installRoots) {
    candidates.push(...listNodeInstallBinDirs(installRoot));
  }

  const seen = new Set();
  return candidates.filter((candidate) => {
    if (!candidate || seen.has(candidate)) {
      return false;
    }
    seen.add(candidate);
    return true;
  });
}

function resolveHostNodeRuntime() {
  const requiredVersion =
    process.env.NODE_VERSION_REQUIRED || NODE_VERSION_REQUIRED_DEFAULT;

  for (const nodeBinDir of getHostNodeRuntimeCandidateDirs()) {
    const nodePath = path.join(nodeBinDir, "node");
    if (!isExecutableFile(nodePath)) {
      continue;
    }

    let nodeVersion = "";
    try {
      nodeVersion = execFileSync(nodePath, ["--version"], {
        encoding: "utf8",
      }).trim();
    } catch (err) {
      console.warn(
        "[Host MCPO] Failed to read candidate node version:",
        err.message,
      );
      continue;
    }

    if (!isNodeVersionCompatible(nodeVersion, requiredVersion)) {
      continue;
    }

    return {
      requiredVersion,
      nodePath,
      nodeBinDir,
      nodeVersion,
    };
  }

  return {
    requiredVersion,
    nodePath: "",
    nodeBinDir: process.env.HOST_NODE_BIN_DIR || "",
    nodeVersion: "",
  };
}

/**
 * Check if server is configured
 */
function checkServerConfigured(serverData, envData) {
  if (
    !serverData.required_env_vars ||
    serverData.required_env_vars.length === 0
  ) {
    return true; // No configuration required
  }

  for (const varInfo of serverData.required_env_vars) {
    const varName = varInfo.name || varInfo;
    let rawValue = envData[varName];
    if (
      (!rawValue || String(rawValue).trim() === "") &&
      varInfo?.sensitive === true
    ) {
      const sensitiveSecrets = resolveMcpSensitiveEnvSecrets({
        env: process.env,
        projectRoot: getProjectRoot(),
        resourcesPath: process.resourcesPath,
        managedRoot: process.env.PORTICO_MANAGED_ROOT,
      });
      rawValue = sensitiveSecrets[varName] || process.env[varName] || "";
    }
    const value =
      typeof rawValue === "string" ? rawValue.trim().toLowerCase() : rawValue;

    // Check if value exists and is not a placeholder (case-insensitive)
    if (
      !value ||
      value.includes("your_") ||
      value.includes("your-") ||
      value === "placeholder" ||
      value === "example"
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Parse .env file into object
 */
function parseEnvFile(content) {
  const vars = {};
  const lines = content.split("\n");
  for (const line of lines) {
    if (line && !line.startsWith("#") && line.includes("=")) {
      const [key, ...valueParts] = line.split("=");
      if (key) {
        vars[key.trim()] = valueParts.join("=").trim();
      }
    }
  }
  return vars;
}

/**
 * Find YAML file for server ID
 */
function findServerYaml(serverId) {
  const PROJECT_ROOT = getProjectRoot();
  const systemDir = path.join(PROJECT_ROOT, "mcp-configs", serverId);
  const systemPath = path.join(systemDir, `${serverId}.yaml`);
  const userPath = path.join(
    PROJECT_ROOT,
    "mcp-configs-user",
    serverId,
    `${serverId}.yaml`,
  );

  if (fs.existsSync(systemDir)) {
    return fs.existsSync(systemPath) ? systemPath : null;
  }
  if (fs.existsSync(userPath)) return userPath;
  return null;
}

function loadProjectEnvVars() {
  const envPath = path.join(getProjectRoot(), ".env");
  if (!fs.existsSync(envPath)) {
    return {};
  }

  try {
    return parseEnvFile(fs.readFileSync(envPath, "utf8"));
  } catch (error) {
    console.warn(`[MCPO] Failed to parse .env for diagnostics: ${error.message}`);
    return {};
  }
}

function loadServerYamlData(serverId) {
  const yamlPath = findServerYaml(serverId);
  if (!yamlPath) {
    return null;
  }

  try {
    return parseYaml(fs.readFileSync(yamlPath, "utf8")) || {};
  } catch (error) {
    console.warn(
      `[MCPO] Failed to parse server YAML for ${serverId}: ${error.message}`,
    );
    return null;
  }
}

function buildMissingComposeDiagnostics(serverId) {
  const diagnostics = [];
  const serverData = loadServerYamlData(serverId);

  if (!serverData) {
    diagnostics.push(`Server "${serverId}" definition was not found on disk.`);
  } else if (!checkServerConfigured(serverData, loadProjectEnvVars())) {
    diagnostics.push(
      `Server "${serverId}" has missing or placeholder environment variables.`,
    );
  }

  try {
    const toggles = getMcpTogglesSync();
    if (toggles[serverId] === false) {
      diagnostics.push(`Server "${serverId}" is disabled in mcp_toggles.json.`);
    } else if (!(serverId in toggles)) {
      diagnostics.push(`Server "${serverId}" is not present in mcp_toggles.json.`);
    }
  } catch (error) {
    diagnostics.push(
      `Unable to read mcp_toggles.json while diagnosing "${serverId}": ${error.message}`,
    );
  }

  return diagnostics;
}

function getGeneratedConfigurationGap(serverId, projectRoot = getProjectRoot()) {
  const status = getGeneratedMcpConfigStatusForServer(projectRoot, serverId, {
    logger: console,
  });
  return isRuntimeFileNotConfiguredStatus(status) ? status : null;
}

function buildGeneratedConfigurationRequiredResult(serverId, status, options = {}) {
  const error = status?.error || "Server configuration is incomplete";
  return {
    serverId,
    success: true,
    requiresConfiguration: true,
    started: false,
    uiStatus: "not_configured",
    errorCode: status?.errorCode || "NOT_CONFIGURED",
    error,
    source: status?.source || "config",
    stage: status?.stage || "config_generation",
    message: error,
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.errorDetails ? { errorDetails: options.errorDetails } : {}),
  };
}

function hasOAuthConfig(serverData) {
  const oauthConfig = serverData?.oauth;
  if (!oauthConfig) return false;
  if (typeof oauthConfig === "boolean") return oauthConfig;
  if (typeof oauthConfig === "object") {
    return Object.keys(oauthConfig).length > 0;
  }
  return false;
}

function getMcpTogglesPath() {
  const PROJECT_ROOT = getProjectRoot();
  return path.join(PROJECT_ROOT, "mcp_toggles.json");
}

function getMcpToggleSnapshotPath() {
  return path.join(
    getProjectRoot(),
    "health-status",
    "mcp_toggles_snapshot.json",
  );
}

function loadRawMcpToggles(options = {}) {
  return loadRawMcpTogglesFromPath(getMcpTogglesPath(), options);
}

function ensureMcpToggleSourceReady(reason = "health-check") {
  return normalizeMcpToggleSourceAtPath(getMcpTogglesPath(), {
    reason,
    snapshotPath: getMcpToggleSnapshotPath(),
    logger: console,
  });
}

function isToggleSourceHealthCheckFailure(error) {
  const text = [
    error?.message,
    error?.stderr,
    error?.stdout,
  ]
    .filter(Boolean)
    .map(String)
    .join("\n");
  return /MCP toggle source (?:is|could not be normalized|is missing|is invalid)/i.test(text);
}

function writeMcpTogglesAtomic(rawToggles, options = {}) {
  return writeMcpTogglesAtomicToPath(getMcpTogglesPath(), rawToggles, {
    ...options,
    snapshotPath: getMcpToggleSnapshotPath(),
  });
}

let mcpToggleMutationQueue = Promise.resolve();

async function mutateMcpToggles(mutator, options = {}) {
  const {
    reason = "mutation",
    logger = null,
    recoverFromParseError = true,
  } = options;

  const executeMutation = async () => {
    return applyToggleMutationToPath(getMcpTogglesPath(), mutator, {
      reason,
      logger: logger || console,
      recoverFromParseError,
      writeToggles: (draft, writeOptions) =>
        writeMcpTogglesAtomic(draft, writeOptions),
    });
  };

  const nextRun = mcpToggleMutationQueue.then(executeMutation, executeMutation);
  mcpToggleMutationQueue = nextRun.then(
    () => undefined,
    () => undefined,
  );
  return nextRun;
}

async function setMcpToggles(rawToggles, options = {}) {
  const { reason = "set", logger = null } = options;
  const executeSet = async () => {
    const persisted = writeMcpTogglesAtomic(rawToggles || {}, { reason, logger });
    return {
      toggles: persisted.toggles,
      togglesPath: persisted.togglesPath,
      revision: persisted.revision,
      snapshotPath: persisted.snapshotPath,
    };
  };

  const nextRun = mcpToggleMutationQueue.then(executeSet, executeSet);
  mcpToggleMutationQueue = nextRun.then(
    () => undefined,
    () => undefined,
  );
  return nextRun;
}

function getMcpTogglesSync() {
  const rawToggleState = loadRawMcpToggles({ includeMeta: true });
  return rawToggleState.toggles;
}

function getMcpDisableModesPath() {
  return path.join(getProjectRoot(), "mcp_disable_modes.json");
}

function getMcpDisableModeSnapshotPath() {
  return path.join(
    getProjectRoot(),
    "health-status",
    "mcp_disable_modes_snapshot.json",
  );
}

function loadRawMcpDisableModes(options = {}) {
  return loadRawMcpDisableModesFromPath(getMcpDisableModesPath(), options);
}

function ensureMcpDisableModesSourceReady(reason = "health-check") {
  return normalizeMcpDisableModeSourceAtPath(getMcpDisableModesPath(), {
    reason,
    snapshotPath: getMcpDisableModeSnapshotPath(),
    logger: console,
  });
}

function writeMcpDisableModesAtomic(rawModes, options = {}) {
  return writeMcpDisableModesAtomicToPath(getMcpDisableModesPath(), rawModes, {
    ...options,
    snapshotPath: getMcpDisableModeSnapshotPath(),
  });
}

let mcpDisableModeMutationQueue = Promise.resolve();

async function mutateMcpDisableModes(mutator, options = {}) {
  const { reason = "mutation", logger = null } = options;

  const executeMutation = async () => {
    return applyDisableModeMutationToPath(getMcpDisableModesPath(), mutator, {
      reason,
      logger: logger || console,
      writeModes: (draft, writeOptions) =>
        writeMcpDisableModesAtomic(draft, writeOptions),
    });
  };

  const nextRun = mcpDisableModeMutationQueue.then(
    executeMutation,
    executeMutation,
  );
  mcpDisableModeMutationQueue = nextRun.then(
    () => undefined,
    () => undefined,
  );
  return nextRun;
}

function getMcpDisableModesSync() {
  const rawModeState = loadRawMcpDisableModes({ includeMeta: true });
  return rawModeState.modes;
}

function isServerHardDisabled(serverId) {
  if (!serverId || typeof serverId !== "string") return false;
  return getMcpDisableModesSync()[serverId] === HARD_DISABLE_MODE;
}

function discoverMcpServerMetadata() {
  const PROJECT_ROOT = getProjectRoot();
  const serverMetadata = new Map();
  const systemServerIds = new Set();

  const scanDirectory = (baseDir, userInstalled) => {
    if (!fs.existsSync(baseDir)) return;

    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

      const serverId = entry.name;
      if (!userInstalled) {
        systemServerIds.add(serverId);
      }
      // A bundled directory reserves the ID even when its YAML is incomplete.
      if (userInstalled && systemServerIds.has(serverId)) continue;

      const yamlPath = path.join(baseDir, serverId, `${serverId}.yaml`);
      if (!fs.existsSync(yamlPath)) continue;

      let yamlData = {};
      try {
        yamlData = parseYaml(fs.readFileSync(yamlPath, "utf8")) || {};
      } catch (error) {
        console.warn(
          `[MCP Toggles] Failed to parse YAML for ${serverId}: ${error.message}`,
        );
      }

      serverMetadata.set(serverId, {
        id: serverId,
        isCore: yamlData.is_core === true,
        hasOAuth: hasOAuthConfig(yamlData),
        userInstalled,
      });
    }
  };

  scanDirectory(path.join(PROJECT_ROOT, "mcp-configs"), false);
  scanDirectory(path.join(PROJECT_ROOT, "mcp-configs-user"), true);

  return serverMetadata;
}

function isKnownMcpServerId(serverId) {
  return isInstalledMcpServerId(getProjectRoot(), serverId, {
    logger: console,
  });
}

function isServerEnabledByPolicy(serverMeta, rawToggleValue) {
  if (serverMeta?.isCore) return true;
  if (rawToggleValue === false) return false;
  if (rawToggleValue === true) return true;

  return false;
}

function computeEffectiveMcpToggles(
  rawToggles = {},
  serverMetadata = discoverMcpServerMetadata(),
) {
  const effectiveToggles = { ...rawToggles };

  for (const [serverId, serverMeta] of serverMetadata.entries()) {
    const rawToggle = normalizeToggleValue(rawToggles[serverId]);
    effectiveToggles[serverId] = isServerEnabledByPolicy(serverMeta, rawToggle);
  }

  return effectiveToggles;
}

function normalizeAndPersistMcpToggles(options = {}) {
  const {
    persist = true,
    logger = null,
    reason = "normalization",
  } = options;

  const rawToggleState = loadRawMcpToggles({ includeMeta: true });
  const rawToggles = rawToggleState.toggles;
  const serverMetadata = discoverMcpServerMetadata();
  const toggles = computeEffectiveMcpToggles(rawToggles, serverMetadata);

  if (persist) {
    if (rawToggleState.parseError) {
      console.warn(
        `[MCP Toggles] Skipping normalization write due to parse error (${reason})`,
      );
      if (typeof logger === "function") {
        logger(
          `[MCP Toggles] Skipped normalization write due to parse error (${reason})`,
        );
      }
    } else {
      writeMcpTogglesAtomic(toggles, { reason, logger });
      if (typeof logger === "function") {
        logger(
          `[MCP Toggles] Normalized ${serverMetadata.size} servers (${reason})`,
        );
      }
    }
  }

  return {
    toggles,
    rawToggles,
    serverMetadata,
    togglesPath: rawToggleState.togglesPath,
    parseError: rawToggleState.parseError
      ? rawToggleState.parseError.message
      : null,
  };
}

function getToolRenameMapping(serverId) {
  const yamlPath = findServerYaml(serverId);
  if (!yamlPath) {
    return {
      displayByOriginal: {},
      displayByLower: {},
      originalBySanitized: {},
    };
  }
  try {
    const yamlContent = fs.readFileSync(yamlPath, "utf8");
    const serverData = parseYaml(yamlContent);
    const mapping = serverData?.tool_rename_mapping;
    if (mapping && typeof mapping === "object" && !Array.isArray(mapping)) {
      const displayByOriginal = {};
      const displayByLower = {};
      const originalBySanitized = {};
      for (const [key, value] of Object.entries(mapping)) {
        if (typeof key !== "string" || typeof value !== "string") continue;
        displayByOriginal[key] = value;
        const lowerKey = key.toLowerCase();
        if (!Object.prototype.hasOwnProperty.call(displayByLower, lowerKey)) {
          displayByLower[lowerKey] = value;
        }
        const sanitized = sanitizeToolName(value);
        if (
          sanitized &&
          !Object.prototype.hasOwnProperty.call(originalBySanitized, sanitized)
        ) {
          originalBySanitized[sanitized] = key;
        }
        const sanitizedLower = sanitized.toLowerCase();
        if (
          sanitizedLower &&
          !Object.prototype.hasOwnProperty.call(
            originalBySanitized,
            sanitizedLower,
          )
        ) {
          originalBySanitized[sanitizedLower] = key;
        }
      }
      return {
        displayByOriginal,
        displayByLower,
        originalBySanitized,
      };
    }
  } catch (err) {
    console.warn(`[Tools] Failed reading tool rename mapping for ${serverId}:`, err);
  }
  return {
    displayByOriginal: {},
    displayByLower: {},
    originalBySanitized: {},
  };
}

/**
 * Serialize env vars back to .env format
 */
function serializeEnvFile(envVars) {
  return (
    Object.entries(envVars)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n"
  );
}

// ============================================================================
// SOURCE FILE CHANGE DETECTION (Smart Dev Mode)
// ============================================================================

const STARTUP_HASH_FILE = ".startup-hash.json";

/**
 * Get all files in a directory recursively (for hashing)
 * @param {string} dir - Directory to scan
 * @param {string[]} extensions - File extensions to include (e.g., ['.yaml', '.py', '.svelte'])
 * @returns {string[]} Array of file paths
 */
function getFilesRecursively(dir, extensions = null) {
  const files = [];

  if (!fs.existsSync(dir)) {
    return files;
  }

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip node_modules, __pycache__, .git, etc.
        if (
          !["node_modules", "__pycache__", ".git", ".venv", "venv"].includes(
            entry.name,
          )
        ) {
          files.push(...getFilesRecursively(fullPath, extensions));
        }
      } else if (entry.isFile()) {
        if (!extensions || extensions.some((ext) => entry.name.endsWith(ext))) {
          files.push(fullPath);
        }
      }
    }
  } catch (err) {
    console.error(
      `[Smart Startup] Error scanning directory ${dir}:`,
      err.message,
    );
  }

  return files;
}

/**
 * Calculate a hash of source files to detect changes
 * Includes: src/patches/, mcp-configs/, mcp-configs-user/, .env, mcp_toggles.json
 * @returns {string} MD5 hash of all source file contents and mtimes
 */
function calculateSourceFilesHash() {
  const PROJECT_ROOT = getProjectRoot();
  const hash = crypto.createHash("md5");

  // Directories to monitor for changes
  const dirsToHash = [
    {
      path: path.join(PROJECT_ROOT, "src", "patches"),
      extensions: [".py", ".svelte", ".ts", ".js", ".css"],
    },
    {
      path: path.join(PROJECT_ROOT, "mcp-configs"),
      extensions: [".yaml", ".yml", ".json"],
    },
    {
      path: path.join(PROJECT_ROOT, "mcp-configs-user"),
      extensions: [".yaml", ".yml", ".json"],
    },
  ];

  // Individual files to monitor
  const filesToHash = [
    path.join(PROJECT_ROOT, ".env"),
    path.join(PROJECT_ROOT, "mcp_toggles.json"),
    path.join(PROJECT_ROOT, "docker-compose.yml"),
    path.join(PROJECT_ROOT, "docker-compose.override.yml"),
  ];

  let fileCount = 0;

  // Hash directory contents
  for (const dirInfo of dirsToHash) {
    const files = getFilesRecursively(dirInfo.path, dirInfo.extensions);
    for (const file of files.sort()) {
      // Sort for consistent ordering
      try {
        const stats = fs.statSync(file);
        const content = fs.readFileSync(file, "utf8");
        // Include path, mtime, and content in hash
        hash.update(`${file}:${stats.mtimeMs}:${content}`);
        fileCount++;
      } catch (err) {
        // File might have been deleted, include that fact in hash
        hash.update(`${file}:deleted`);
      }
    }
  }

  // Hash individual files
  for (const file of filesToHash) {
    try {
      if (fs.existsSync(file)) {
        const stats = fs.statSync(file);
        const content = fs.readFileSync(file, "utf8");
        hash.update(`${file}:${stats.mtimeMs}:${content}`);
        fileCount++;
      } else {
        hash.update(`${file}:missing`);
      }
    } catch (err) {
      hash.update(`${file}:error:${err.message}`);
    }
  }

  const finalHash = hash.digest("hex");
  console.log(
    `[Smart Startup] Calculated hash from ${fileCount} files: ${finalHash.substring(0, 12)}...`,
  );
  return finalHash;
}

/**
 * Check if source files have changed since last startup
 * @returns {{changed: boolean, reason: string|null}} Whether files changed and why
 */
function checkSourceFilesChanged() {
  const PROJECT_ROOT = getProjectRoot();
  const hashFilePath = path.join(PROJECT_ROOT, STARTUP_HASH_FILE);

  const currentHash = calculateSourceFilesHash();

  try {
    if (fs.existsSync(hashFilePath)) {
      const savedData = JSON.parse(fs.readFileSync(hashFilePath, "utf8"));
      const savedHash = savedData.lastHash;

      if (savedHash === currentHash) {
        console.log(
          "[Smart Startup] Source files unchanged since last startup",
        );
        return { changed: false, reason: null };
      } else {
        console.log("[Smart Startup] Source files have changed");
        console.log(
          `[Smart Startup]   Previous: ${savedHash.substring(0, 12)}...`,
        );
        console.log(
          `[Smart Startup]   Current:  ${currentHash.substring(0, 12)}...`,
        );
        return {
          changed: true,
          reason: "Source files modified since last startup",
        };
      }
    } else {
      console.log(
        "[Smart Startup] No previous hash found (first run or hash file deleted)",
      );
      return { changed: true, reason: "First startup or hash file missing" };
    }
  } catch (err) {
    console.error("[Smart Startup] Error reading hash file:", err.message);
    return { changed: true, reason: `Hash file error: ${err.message}` };
  }
}

/**
 * Save the current source files hash after successful startup
 */
function saveSourceFilesHash() {
  const PROJECT_ROOT = getProjectRoot();
  const hashFilePath = path.join(PROJECT_ROOT, STARTUP_HASH_FILE);

  const currentHash = calculateSourceFilesHash();
  const data = {
    lastHash: currentHash,
    lastStartup: new Date().toISOString(),
  };

  try {
    fs.writeFileSync(hashFilePath, JSON.stringify(data, null, 2));
    console.log(
      `[Smart Startup] Saved startup hash: ${currentHash.substring(0, 12)}...`,
    );
  } catch (err) {
    console.error("[Smart Startup] Failed to save hash file:", err.message);
  }
}

// ============================================================================
// STATUS MONITORING
// ============================================================================

const DOCKER_STATUS_POLL_INTERVAL_MS = Math.max(
  1000,
  Number.parseInt(process.env.DOCKER_STATUS_POLL_INTERVAL_MS || "5000", 10) ||
    5000,
);
const DOCKER_STATUS_TIMEOUT_MS = Math.max(
  1000,
  Number.parseInt(process.env.DOCKER_STATUS_TIMEOUT_MS || "10000", 10) ||
    10000,
);
let activeDockerStatusProbe = null;
let activeDockerStatusAbortController = null;

function cancelActiveDockerStatusProbe() {
  if (activeDockerStatusAbortController) {
    activeDockerStatusAbortController.abort();
  }
}

const dockerStatusPoller = createSerialPoller(
  () => checkDockerStatus(),
  {
    intervalMs: DOCKER_STATUS_POLL_INTERVAL_MS,
    cancelInFlight: cancelActiveDockerStatusProbe,
    onError: (error) => {
      console.warn("[DockerStatus] Poll failed:", error.message);
    },
  },
);

/**
 * Start Docker status monitoring
 */
function startStatusMonitoring() {
  if (!dockerStatusPoller.start()) {
    return;
  }
  // Preserve the shared-state truthy handle contract used by lifecycle code.
  state.statusCheckInterval = dockerStatusPoller;
}

/**
 * Stop Docker status monitoring
 */
function stopStatusMonitoring() {
  dockerStatusPoller.stop();
  state.statusCheckInterval = null;
}

/**
 * Check if HOST_MODE is enabled (async, cached).
 * The HOST_MODE file rarely changes, so we cache the result for 30 seconds
 * to avoid synchronous I/O on the main process event loop every 5s tick.
 * @returns {Promise<boolean>} true if HOST_MODE file contains boolean true text
 */
let _hostModeSupportedCache = { value: false, expiresAt: 0 };
const HOST_MODE_CACHE_TTL_MS = 30_000;

function invalidateHostModeCaches() {
  _hostModeSupportedCache = { value: false, expiresAt: 0 };
  _hostMcpConfiguredCache = { value: false, expiresAt: 0 };
  _lastHostMcpConfiguredState = undefined;
}

async function checkHostModeSupported(options = {}) {
  if (options.force !== true && Date.now() < _hostModeSupportedCache.expiresAt) {
    return _hostModeSupportedCache.value;
  }
  const PROJECT_ROOT = getProjectRoot();
  try {
    const hostModePath = path.join(PROJECT_ROOT, "HOST_MODE");
    const result = await readHostModeFile(hostModePath);
    _hostModeSupportedCache = { value: result, expiresAt: Date.now() + HOST_MODE_CACHE_TTL_MS };
    return result;
  } catch (err) {
    _hostModeSupportedCache = { value: false, expiresAt: Date.now() + HOST_MODE_CACHE_TTL_MS };
    return false;
  }
}

/**
 * Check if host MCP servers are configured (async, cached).
 * Cached for 30s to keep the 5-second status tick off the main-process event loop.
 * @returns {Promise<boolean>} true if mcp_config_host_sideload.json exists and has mcpServers
 */
let _lastHostMcpConfiguredState = undefined;
let _hostMcpConfiguredCache = { value: false, expiresAt: 0 };
const HOST_MCP_CONFIG_CACHE_TTL_MS = 30_000;

async function checkHostMcpServersConfigured(options = {}) {
  if (options.force !== true && Date.now() < _hostMcpConfiguredCache.expiresAt) {
    return _hostMcpConfiguredCache.value;
  }
  const PROJECT_ROOT = getProjectRoot();
  const configPath = path.join(PROJECT_ROOT, "mcp_config_host_sideload.json");

  try {
    await fsPromises.access(configPath);
  } catch {
    if (_lastHostMcpConfiguredState !== "no-file") {
      console.log("[Smart Startup] No host MCP config file found");
      _lastHostMcpConfiguredState = "no-file";
    }
    _hostMcpConfiguredCache = { value: false, expiresAt: Date.now() + HOST_MCP_CONFIG_CACHE_TTL_MS };
    return false;
  }

  try {
    const raw = await fsPromises.readFile(configPath, "utf8");
    const config = JSON.parse(raw);
    const hasServers =
      config.mcpServers && Object.keys(config.mcpServers).length > 0;
    if (_lastHostMcpConfiguredState !== hasServers) {
      console.log(`[Smart Startup] Host MCP servers configured: ${hasServers}`);
      _lastHostMcpConfiguredState = hasServers;
    }
    _hostMcpConfiguredCache = { value: hasServers, expiresAt: Date.now() + HOST_MCP_CONFIG_CACHE_TTL_MS };
    return hasServers;
  } catch (error) {
    if (_lastHostMcpConfiguredState !== "error") {
      console.log(
        `[Smart Startup] Failed to read host MCP config: ${error.message}`,
      );
      _lastHostMcpConfiguredState = "error";
    }
    _hostMcpConfiguredCache = { value: false, expiresAt: Date.now() + HOST_MCP_CONFIG_CACHE_TTL_MS };
    return false;
  }
}

/**
 * Smart startup check - determines if services need to be restarted
 * Checks:
 * 1. Container status (all critical containers must be running)
 * 2. Image version drift (Harbor-tagged containers must match build ID)
 * 3. Host MCP runtime health (if HOST_MODE enabled)
 *
 * @returns {Promise<{needsRestart: boolean, reasons: string[]}>}
 */
async function checkServicesNeedRestart() {
  const PROJECT_ROOT = getProjectRoot();
  const SCRIPTS_DIR = getScriptsDir();
  const reasons = [];

  console.log("[Smart Startup] Starting service health check...");

  // 1. Check container status and image versions
  try {
    console.log("[Smart Startup] Fetching container versions...");
    const { stdout } = await execPromise(
      `bash "${path.join(SCRIPTS_DIR, "docker-compose.sh")}" check-versions`,
      { cwd: PROJECT_ROOT },
    );
    const versionInfo = canonicalizeVersionInfo(JSON.parse(stdout));
    const expectedBuild = versionInfo.build;
    console.log(`[Smart Startup] Expected build: ${expectedBuild}`);
    console.log(
      `[Smart Startup] Container info: ${JSON.stringify(versionInfo.containers, null, 2)}`,
    );

    // Dev builds: Only restart if source files have changed
    if (expectedBuild === "dev-build") {
      console.log(
        "[Smart Startup] Dev build detected - checking for source file changes...",
      );
      const sourceCheck = checkSourceFilesChanged();
      if (sourceCheck.changed) {
        console.log(
          `[Smart Startup] Dev build needs restart: ${sourceCheck.reason}`,
        );
        reasons.push(`Dev build - ${sourceCheck.reason}`);
      } else {
        console.log(
          "[Smart Startup] Dev build - no source changes, skipping forced restart",
        );
      }
    }

    // Containers that must be running for chat to work
    const criticalContainers = [LLM_GATEWAY_CONTAINER, "mcpo", "portico-open-webui"];

    // Containers to EXCLUDE from version check (community images)
    const excludeFromVersionCheck = [
      "phoenix",
      "redis",
      "portico-redis",
      "portico-mongodb", // mongo:7 community image
    ];

    // Get ALL containers from the version info
    const allContainers = Object.keys(versionInfo.containers || {});
    console.log(
      `[Smart Startup] Found ${allContainers.length} containers: ${allContainers.join(", ")}`,
    );

    // Check critical containers are running
    for (const name of criticalContainers) {
      const container = versionInfo.containers[name];
      if (!container || container.status !== "running") {
        const status = container?.status || "missing";
        console.log(`[Smart Startup] ❌ Container ${name} is ${status}`);
        reasons.push(`Container ${name} is ${status}`);
      } else {
        console.log(`[Smart Startup] ✅ Container ${name} is running`);
      }
    }

    // Check version drift for ALL containers except excluded ones
    for (const name of allContainers) {
      // Skip excluded containers (community images)
      if (excludeFromVersionCheck.some((excluded) => name.includes(excluded))) {
        console.log(`[Smart Startup] ℹ️  Skipping ${name} (community image)`);
        continue;
      }

      const container = versionInfo.containers[name];
      if (!container || container.status !== "running" || !container.image) {
        continue; // Already handled above or not running
      }

      console.log(
        `[Smart Startup] Checking version for ${name}: ${container.image}`,
      );

      // For dev-build, containers must use :latest tag
      if (expectedBuild === "dev-build") {
        // Dev builds should use "latest" tagged images OR local images without tags
        const hasLatestTag = container.image.includes(":latest");
        const isLocalImage =
          !container.image.includes("harbor.") &&
          !container.image.includes(":");
        const isNginxAlpine = container.image === "nginx:alpine";

        if (hasLatestTag || isLocalImage || isNginxAlpine) {
          console.log(
            `[Smart Startup] ✅ Container ${name} OK for dev-build mode`,
          );
        } else {
          console.log(
            `[Smart Startup] ❌ Container ${name} not using latest tag (dev-build mode)`,
          );
          console.log(
            `[Smart Startup]    Expected: :latest tag or local image`,
          );
          console.log(`[Smart Startup]    Actual:   ${container.image}`);
          reasons.push(
            `Container ${name} not using latest tag (expected for dev-build)`,
          );
        }
      } else {
        // Production build - check for specific build number in Harbor images
        if (container.image.includes("harbor.example.invalid")) {
          if (!container.image.includes(expectedBuild)) {
            console.log(
              `[Smart Startup] ❌ Container ${name} has version drift`,
            );
            console.log(`[Smart Startup]    Expected: ${expectedBuild}`);
            console.log(`[Smart Startup]    Actual:   ${container.image}`);
            reasons.push(
              `Container ${name} has version drift (expected ${expectedBuild})`,
            );
          } else {
            console.log(`[Smart Startup] ✅ Container ${name} version matches`);
          }
        } else {
          // Check for the shared proxy image used by the MCPO control plane.
          const isKnownProxyImage = container.image === "nginx:alpine";
          if (isKnownProxyImage) {
            console.log(
              `[Smart Startup] ✅ Container ${name} using nginx proxy (OK)`,
            );
          } else {
            // Production build requires Harbor images - local images = version mismatch!
            console.log(
              `[Smart Startup] ❌ Container ${name} using local image instead of Harbor`,
            );
            console.log(
              `[Smart Startup]    Expected: harbor.example.invalid/...:${expectedBuild}`,
            );
            console.log(`[Smart Startup]    Actual:   ${container.image}`);
            reasons.push(
              `Container ${name} not using Harbor image (expected build ${expectedBuild})`,
            );
          }
        }
      }
    }
  } catch (error) {
    console.error(
      `[Smart Startup] Failed to check containers: ${error.message}`,
    );
    reasons.push(`Failed to check container status: ${error.message}`);
  }

  // 2. Check the host MCP runtime on port 8890
  console.log("[Smart Startup] Checking HOST_MODE support...");
  const hostModeSupported = await checkHostModeSupported();
  console.log(`[Smart Startup] HOST_MODE supported: ${hostModeSupported}`);

  if (hostModeSupported) {
    // Also check if host MCP servers are actually configured
    const hostServersConfigured = await checkHostMcpServersConfigured();

    if (hostServersConfigured) {
      console.log("[Smart Startup] Checking host MCP runtime on port 8890...");
      try {
        // Use native http module instead of fetch for Node.js compatibility
        const http = require("http");
        const response = await new Promise((resolve, reject) => {
          const req = http.get(
            "http://localhost:8890/",
            { timeout: 2000 },
            (res) => {
              let data = "";
              res.on("data", (chunk) => (data += chunk));
              res.on("end", () =>
                resolve({ status: res.statusCode, text: data }),
              );
            },
          );
          req.on("error", reject);
          req.on("timeout", () => {
            req.destroy();
            reject(new Error("Timeout"));
          });
        });
        console.log(
          `[Smart Startup] Host MCP runtime response: ${response.text.substring(0, 100)}`,
        );
        if (!response.text.includes('"detail":"Not Found"')) {
          console.log("[Smart Startup] ❌ Host MCP runtime response unexpected");
          reasons.push("Host MCP Runtime not responding correctly");
        } else {
          console.log("[Smart Startup] ✅ Host MCP runtime is healthy");
        }
      } catch (error) {
        console.log(
          `[Smart Startup] ❌ Host MCP runtime not responding: ${error.message}`,
        );
        reasons.push(`Host MCP Runtime not responding: ${error.message}`);
      }
    } else {
      console.log(
        "[Smart Startup] Skipping host MCP runtime check (no host MCP servers configured)",
      );
    }
  } else {
    console.log(
      "[Smart Startup] Skipping host MCP runtime check (HOST_MODE not enabled)",
    );
  }

  console.log(
    `[Smart Startup] Check complete. Needs restart: ${reasons.length > 0}`,
  );
  if (reasons.length > 0) {
    console.log(`[Smart Startup] Restart reasons: ${reasons.join(", ")}`);
  }

  return {
    needsRestart: reasons.length > 0,
    reasons,
  };
}

/**
 * Check Docker container status
 */
async function checkDockerStatus() {
  if (activeDockerStatusProbe) {
    return activeDockerStatusProbe;
  }

  const controller = new AbortController();
  activeDockerStatusAbortController = controller;
  const probe = checkDockerStatusOnce(controller.signal);
  activeDockerStatusProbe = probe;
  try {
    return await probe;
  } finally {
    if (activeDockerStatusProbe === probe) {
      activeDockerStatusProbe = null;
      activeDockerStatusAbortController = null;
    }
  }
}

async function checkDockerStatusOnce(signal) {
  const PROJECT_ROOT = getProjectRoot();

  try {
    const status = canonicalizeContainerStatusMap(
      await probeDockerStatus({
        cwd: PROJECT_ROOT,
        env: createBaseEnhancedEnv(),
        signal,
        timeoutMs: DOCKER_STATUS_TIMEOUT_MS,
      }),
    );

    // Check host MCPO status and whether it is expected to run.
    // Host MCPO should only be considered required when HOST_MODE is supported
    // and at least one host server is configured/enabled in sideload config.
    const hostModeSupported = await checkHostModeSupported();
    const hostServersConfigured = hostModeSupported && await checkHostMcpServersConfigured();
    const hostMcpoRunning =
      state.hostMcpo.process !== null && !state.hostMcpo.process.killed;
    const hostMcpoStarting = isHostMcpoStartupPending(state.hostMcpo);
    const hostMcpoPid = state.hostMcpo.process
      ? state.hostMcpo.process.pid
      : null;
    status["host-mcpo-supported"] = hostModeSupported;
    status["host-mcpo-configured"] = hostServersConfigured;
    status["host-mcpo-starting"] = hostMcpoStarting;
    status["host-mcpo-startup-phase"] = getHostMcpoStartupPhase(state.hostMcpo);
    if (hostMcpoRunning && hostMcpoStarting) {
      status["host-mcpo"] = "starting";
    } else if (hostMcpoRunning) {
      status["host-mcpo"] = "running";
    } else if (!hostModeSupported) {
      status["host-mcpo"] = "not_available";
    } else if (!hostServersConfigured) {
      status["host-mcpo"] = "not_configured";
    } else {
      status["host-mcpo"] = "not_running";
    }
    status["host-mcpo-pid"] = hostMcpoPid;

    const hostMcpBridgeProcessRunning =
      state.hostMcpBridge.process !== null && !state.hostMcpBridge.process.killed;
    // Listener PIDs only matter for identifying an untracked external
    // listener; skip the port scan while the bridge is a live tracked child.
    const hostMcpBridgeListenerPids = hostMcpBridgeProcessRunning
      ? []
      : await listListeningPidsOnPort(state.hostMcpBridge.port);
    const hostMcpBridgeHealthResponding = hostMcpBridgeProcessRunning
      ? false
      : await checkHostMcpBridgeHealth(500);
    const hostMcpBridgeRunning =
      hostMcpBridgeProcessRunning || hostMcpBridgeHealthResponding;
    const hostMcpBridgeStarting = isHostMcpoStartupPending(state.hostMcpBridge);
    const hostMcpBridgePid = hostMcpBridgeProcessRunning
      ? state.hostMcpBridge.process.pid
      : hostMcpBridgeListenerPids[0] || null;
    status["host-mcp-bridge-starting"] = hostMcpBridgeStarting;
    status["host-mcp-bridge-startup-phase"] = getHostMcpoStartupPhase(state.hostMcpBridge);
    if (hostMcpBridgeRunning && hostMcpBridgeStarting) {
      status["host-mcp-bridge"] = "starting";
    } else if (hostMcpBridgeRunning) {
      status["host-mcp-bridge"] = "running";
    } else {
      status["host-mcp-bridge"] = "not_running";
    }
    status["host-mcp-bridge-pid"] = hostMcpBridgePid;

    // Check if the shared control-plane services are running.
    const mainServices = [LLM_GATEWAY_CONTAINER, "mcpo", "portico-open-webui"];
    const allMainRunning =
      mainServices.filter((service) => status[service] === "running").length ===
      3;

    // Check health check status separately
    const healthCheckCompleted =
      status["open-webui-health-check"] === "stopped" ||
      status["open-webui-health-check"] === "exited";

    // Check chat-critical services separately from the one-shot health check.
    const criticalServices = [LLM_GATEWAY_CONTAINER, "mcpo", "portico-open-webui"];
    const criticalServicesRunning = criticalServices.every(
      (service) => status[service] === "running",
    );

    state.dockerStatus.running = criticalServicesRunning;
    state.dockerStatus.containers = status;
    state.dockerStatus.lastCheck = new Date();
    state.dockerStatus.healthCheckCompleted = healthCheckCompleted;
    state.dockerStatus.error = null;

    if (state.windows.main && !state.windows.main.isDestroyed()) {
      safeWebContentsSend(
        state.windows.main,
        "docker-status-update",
        state.dockerStatus,
        {
          tag: "docker-status-broadcast",
          meta: { target: "main" },
        },
      );
    }
    if (state.windows.chat && !state.windows.chat.isDestroyed()) {
      safeWebContentsSend(
        state.windows.chat,
        "docker-status-update",
        state.dockerStatus,
        {
          tag: "docker-status-broadcast",
          meta: { target: "chat" },
        },
      );
    }
  } catch (error) {
    if (error?.name === "AbortError" || error?.aborted === true) {
      console.log("[DockerStatus] Active status probe cancelled");
      return;
    }
    state.dockerStatus.running = false;
    state.dockerStatus.containers = {};
    state.dockerStatus.lastCheck = new Date();
    state.dockerStatus.error = error.message;

    if (state.windows.main && !state.windows.main.isDestroyed()) {
      safeWebContentsSend(
        state.windows.main,
        "docker-status-update",
        state.dockerStatus,
        {
          tag: "docker-status-broadcast",
          meta: { target: "main", source: "error-path" },
        },
      );
    }
  }
}

// ============================================================================
// HOST MCPO LIFECYCLE
// ============================================================================

/**
 * Kill any process listening on the specified port
 * @param {number} port - Port to clean up
 * @returns {Promise<boolean>} - True if any processes were killed
 */
async function killProcessOnPort(port) {
  try {
    // LISTEN-only: avoid returning client PIDs (which can include the Electron app itself)
    const pids = await listListeningPidsOnPort(port);
    if (pids.length > 0) {
      console.log(`Found processes on port ${port}: ${pids.join(", ")}`);
      for (const pidNum of pids) {
        try {
          // Never kill the current Electron process
          if (pidNum === process.pid) {
            console.warn(
              `[PortCleanup] Refusing to kill current process (pid=${pidNum}) for port ${port}`,
            );
            continue;
          }

          // For host MCPO (8890), only kill if it looks like MCPO
          let cmdline = "";
          try {
            const { stdout } = await execFileAsync(
              "ps",
              ["-p", String(pidNum), "-o", "command="],
              { encoding: "utf8", timeout: PORT_SCAN_TIMEOUT_MS },
            );
            cmdline = stdout.trim();
          } catch (e) {
            /* ignore */
          }

          if (port === 8890) {
            const isMcpo =
              /(uvx\s+mcpo\b|mcpo@|mcp_config_host_sideload\.json)/i.test(
                cmdline,
              );
            if (!isMcpo) {
              console.warn(
                `[PortCleanup] Port ${port} listener pid=${pidNum} does not look like MCPO; skipping kill. cmd="${cmdline}"`,
              );
              continue;
            }
          }

          console.log(
            `[PortCleanup] Killing pid=${pidNum} on port ${port} (SIGTERM). cmd="${cmdline}"`,
          );
          try {
            process.kill(pidNum, "SIGTERM");
          } catch (e) {
            /* ignore */
          }
          await new Promise((resolve) => setTimeout(resolve, 300));

          // If still alive, SIGKILL
          try {
            process.kill(pidNum, 0);
            console.log(
              `[PortCleanup] pid=${pidNum} still alive; sending SIGKILL`,
            );
            process.kill(pidNum, "SIGKILL");
          } catch (e) {
            /* already dead */
          }

          console.log(`[PortCleanup] Killed pid=${pidNum} on port ${port}`);
        } catch (e) {
          /* Already dead */
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      return true;
    }
    return false;
  } catch (e) {
    console.log(`Port ${port} cleanup failed:`, e.message);
    return false;
  }
}

/**
 * Start host MCPO process
 */
async function startHostMcpoUnlocked() {
  const PROJECT_ROOT = getProjectRoot();
  const configPath = path.join(PROJECT_ROOT, "mcp_config_host_sideload.json");

  // CRITICAL: Kill existing process FIRST, before config checks
  if (state.hostMcpo.process) {
    console.log("Stopping existing host MCPO process...");
    state.hostMcpo.process.kill();
    state.hostMcpo.process = null;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // Kill any existing host MCPO process using PID file (safer than port-based killing)
  const pidFile = path.join(PROJECT_ROOT, "MCPO_HOST.pid");
  try {
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
      if (pid && !isNaN(pid)) {
        console.log(
          `Found existing host MCPO PID file with PID ${pid}, checking if process exists...`,
        );
        try {
          // Check if process exists (kill with signal 0 doesn't kill, just checks)
          process.kill(pid, 0);
          // Process exists, kill it
          console.log(`Killing existing host MCPO process (PID ${pid})...`);
          process.kill(pid, "SIGTERM");
          await new Promise((resolve) => setTimeout(resolve, 500));
          // If still alive after SIGTERM, use SIGKILL
          try {
            process.kill(pid, 0);
            console.log(`Process ${pid} still running, sending SIGKILL...`);
            process.kill(pid, "SIGKILL");
            await new Promise((resolve) => setTimeout(resolve, 500));
          } catch (e) {
            // Process is gone, good
          }
        } catch (e) {
          // Process doesn't exist, just clean up the stale PID file
          console.log(`PID ${pid} not running (stale PID file)`);
        }
        // Remove the PID file
        fs.unlinkSync(pidFile);
      }
    } else {
      console.log("No existing host MCPO PID file found");
    }
  } catch (error) {
    console.log(`Error handling existing host MCPO process: ${error.message}`);
  }

  // Fallback: Kill any orphaned process on the host MCPO port
  await killProcessOnPort(state.hostMcpo.port);

  // Clear logs
  state.hostMcpo.logs = [];
  state.hostMcpo.stdoutBuffer = "";
  state.hostMcpo.stderrBuffer = "";

  // Check if host config exists and has servers
  if (!fs.existsSync(configPath)) {
    console.log(
      "No host MCP config found, skipping host MCPO startup (cleanup completed)",
    );
    markHostMcpoStopped(state.hostMcpo, { phase: "not_configured" });
    return { success: true, skipped: true };
  }

  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!config.mcpServers || Object.keys(config.mcpServers).length === 0) {
      console.log(
        "No host MCP servers configured, skipping host MCPO startup (cleanup completed)",
      );
      markHostMcpoStopped(state.hostMcpo, { phase: "not_configured" });
      return { success: true, skipped: true };
    }
  } catch (error) {
    console.error("Failed to read host MCP config:", error);
    markHostMcpoStopped(state.hostMcpo, { phase: "failed" });
    return { success: false, error: error.message };
  }

  // Start host MCPO
  console.log("Starting host MCPO on port", state.hostMcpo.port);
  const mcpoScript = path.join(
    PROJECT_ROOT,
    "src",
    "scripts",
    "run-host-mcp.sh",
  );

  const nodeRuntime = resolveHostNodeRuntime();
  const nodeVersionRequired = nodeRuntime.requiredVersion;
  const hostNodeBinDir =
    process.env.HOST_NODE_BIN_DIR || nodeRuntime.nodeBinDir || "";

  if (nodeRuntime.nodePath) {
    const versionLabel = nodeRuntime.nodeVersion || "unknown version";
    console.log(
      `[Host MCPO] Resolved node runtime ${versionLabel} at ${nodeRuntime.nodePath}`,
    );
  } else {
    console.warn(
      `[Host MCPO] Could not resolve node path from current PATH; run-host-mcp.sh will enforce >= v${nodeVersionRequired}`,
    );
  }

  const isPackagedAppRun = app.isPackaged === true;
  let hostMcpoEnv = applyMainStackOAuthCallbackPortEnv(
    createEnhancedEnv({
      NODE_VERSION_REQUIRED: nodeVersionRequired,
      HOST_NODE_BIN_DIR: hostNodeBinDir,
      HOST_MCP_IS_PACKAGED: isPackagedAppRun ? "1" : "0",
      PATH: process.env.PATH || "",
    }),
  );
  hostMcpoEnv = stripPackageManagerCredentialEnv(hostMcpoEnv);
  if (isPackagedAppRun && process.resourcesPath) {
    hostMcpoEnv.HOST_MCP_RESOURCES_ROOT = process.resourcesPath;
    console.log(
      `[Host MCPO] Using packaged resources root: ${process.resourcesPath}`,
    );
  } else {
    delete hostMcpoEnv.HOST_MCP_RESOURCES_ROOT;
  }

  try {
    Object.assign(
      hostMcpoEnv,
      writeHostMcpSandboxFiles({
        projectRoot: PROJECT_ROOT,
        configPath,
        resourcesPath: process.resourcesPath,
        isPackagedApp: isPackagedAppRun,
        env: hostMcpoEnv,
      }),
    );
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.error(`[Host MCPO] Failed to prepare sandbox: ${message}`);
    state.hostMcpo.logs.push(`[ERROR] Host MCP sandbox preparation failed: ${message}`);
    markHostMcpoStopped(state.hostMcpo, { phase: "failed" });
    return { success: false, error: `Host MCP sandbox preparation failed: ${message}` };
  }

  state.hostMcpo.process = spawn("bash", [mcpoScript], {
    cwd: PROJECT_ROOT,
    env: hostMcpoEnv,
    detached: true, // Create new process group so -pid kills all children
  });
  markHostMcpoStarting(state.hostMcpo, {
    timeoutMs: HOST_MCPO_STARTUP_TIMEOUT_MS,
  });

  state.hostMcpo.stdoutBuffer = "";
  state.hostMcpo.stderrBuffer = "";

  // Stream logs (non-blocking)
  state.hostMcpo.process.stdout.on("data", (data) => {
    const parsed = consumeProcessOutputLines(state.hostMcpo.stdoutBuffer, data);
    state.hostMcpo.stdoutBuffer = parsed.remainder;

    for (const logLine of parsed.lines) {
      if (shouldSuppressHostMcpoLogLine(logLine)) {
        continue;
      }

      console.log("[Host MCPO]", logLine);
      state.hostMcpo.logs.push(logLine);
      if (state.hostMcpo.logs.length > 1000) {
        state.hostMcpo.logs.shift();
      }

      if (state.windows.loading && !state.windows.loading.isDestroyed()) {
        safeWebContentsSend(
          state.windows.loading,
          "loading-log-append",
          {
            text: `${logLine}\n`,
            type: "info",
          },
          {
            tag: "host-mcpo-log-stream",
            meta: { source: "stdout" },
          },
        );
      }
    }
  });

  state.hostMcpo.process.stderr.on("data", (data) => {
    const parsed = consumeProcessOutputLines(state.hostMcpo.stderrBuffer, data);
    state.hostMcpo.stderrBuffer = parsed.remainder;

    for (const line of parsed.lines) {
      if (shouldSuppressHostMcpoLogLine(line)) {
        continue;
      }

      const severity = classifyHostMcpoStderrLine(line);
      if (severity === "error") {
        console.error("[Host MCPO Error]", line);
        state.hostMcpo.logs.push(`[ERROR] ${line}`);
      } else if (severity === "warning") {
        console.warn("[Host MCPO Warn]", line);
        state.hostMcpo.logs.push(`[WARN] ${line}`);
      } else {
        console.log("[Host MCPO]", line);
        state.hostMcpo.logs.push(line);
      }

      if (state.hostMcpo.logs.length > 1000) {
        state.hostMcpo.logs.shift();
      }
    }
  });

  state.hostMcpo.process.on("close", (code) => {
    const flushHostMcpoBuffer = (buffer, source) => {
      if (!buffer || buffer.trim().length === 0) {
        return;
      }

      const parsed = consumeProcessOutputLines("", `${buffer}\n`);
      for (const line of parsed.lines) {
        if (shouldSuppressHostMcpoLogLine(line)) {
          continue;
        }

        if (source === "stderr") {
          const severity = classifyHostMcpoStderrLine(line);
          if (severity === "error") {
            console.error("[Host MCPO Error]", line);
            state.hostMcpo.logs.push(`[ERROR] ${line}`);
          } else if (severity === "warning") {
            console.warn("[Host MCPO Warn]", line);
            state.hostMcpo.logs.push(`[WARN] ${line}`);
          } else {
            console.log("[Host MCPO]", line);
            state.hostMcpo.logs.push(line);
          }
        } else {
          console.log("[Host MCPO]", line);
          state.hostMcpo.logs.push(line);
        }
      }
    };

    flushHostMcpoBuffer(state.hostMcpo.stdoutBuffer, "stdout");
    flushHostMcpoBuffer(state.hostMcpo.stderrBuffer, "stderr");
    state.hostMcpo.stdoutBuffer = "";
    state.hostMcpo.stderrBuffer = "";

    console.log(`Host MCPO process exited with code ${code}`);
    state.hostMcpo.process = null;
    markHostMcpoStopped(state.hostMcpo, {
      phase: code === 0 ? "stopped" : "failed",
    });

    // Remove PID file on exit
    try {
      const pidFile = path.join(PROJECT_ROOT, "MCPO_HOST.pid");
      if (fs.existsSync(pidFile)) {
        fs.unlinkSync(pidFile);
      }
    } catch (error) {
      console.error("Failed to remove PID file:", error);
    }
  });

  // Write PID to file for tracking immediately
  if (state.hostMcpo.process && state.hostMcpo.process.pid) {
    try {
      const pidFile = path.join(PROJECT_ROOT, "MCPO_HOST.pid");
      fs.writeFileSync(pidFile, state.hostMcpo.process.pid.toString());
      console.log(`Host MCPO started with PID ${state.hostMcpo.process.pid}`);
    } catch (error) {
      console.error("Failed to write PID file:", error);
    }
  }

  // Start background health polling (non-blocking)
  // Store the promise in state so callers can optionally await it later
  state.hostMcpo.startupPromise = pollHostMcpoHealth(
    HOST_MCPO_STARTUP_TIMEOUT_MS,
  );

  // Return immediately - don't block on startup
  return {
    success: true,
    starting: true,
    pid: state.hostMcpo.process ? state.hostMcpo.process.pid : null,
  };
}

async function startHostMcpo() {
  return enqueueHostMcpoOperation(() => startHostMcpoUnlocked());
}

/**
 * Poll Host MCPO health endpoint until it responds
 * @param {number} timeoutMs - Maximum time to wait in milliseconds
 * @returns {Promise<{success: boolean, timeout?: boolean}>}
 */
async function pollHostMcpoHealth(timeoutMs = 15000) {
  const startTime = Date.now();
  const pollInterval = 1000; // Check every 1 second

  console.log(
    `[Host MCPO] Starting background health polling (timeout: ${timeoutMs}ms)`,
  );

  while (Date.now() - startTime < timeoutMs) {
    try {
      const http = require("http");
      const response = await new Promise((resolve, reject) => {
        const req = http.get(
          "http://localhost:8890/",
          { timeout: 2000 },
          (res) => {
            resolve({ status: res.statusCode });
          },
        );
        req.on("error", reject);
        req.on("timeout", () => {
          req.destroy();
          reject(new Error("Timeout"));
        });
      });

      // MCPO returns 404 for root path when healthy (no route defined)
      if (response.status === 404 || response.status === 200) {
        const elapsed = Date.now() - startTime;
        console.log(`[Host MCPO] Health check passed after ${elapsed}ms`);
        markHostMcpoReady(state.hostMcpo);
        return { success: true };
      }
    } catch (e) {
      // Not ready yet, continue polling
    }

    await new Promise((r) => setTimeout(r, pollInterval));
  }

  console.warn(`[Host MCPO] Health check timed out after ${timeoutMs}ms`);
  markHostMcpoStopped(state.hostMcpo, { phase: "timed_out" });
  return { success: false, timeout: true };
}

/**
 * Stop host MCPO process - kills entire process group and cleans up port
 */
async function stopHostMcpoUnlocked() {
  const PROJECT_ROOT = getProjectRoot();
  console.log("Stopping host MCPO process...");

  // Method 1: Kill the process group if we have a handle
  if (state.hostMcpo.process && state.hostMcpo.process.pid) {
    const pid = state.hostMcpo.process.pid;
    try {
      // Kill entire process group with negative PID (requires detached: true)
      process.kill(-pid, "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Force kill if still running
      try {
        process.kill(-pid, 0); // Check if alive
        console.log(`Process group ${pid} still running, sending SIGKILL...`);
        process.kill(-pid, "SIGKILL");
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (e) {
        /* Already dead, good */
      }
    } catch (e) {
      console.log(`Process group kill for ${pid}:`, e.message);
    }
    state.hostMcpo.process = null;
  }

  state.hostMcpo.stdoutBuffer = "";
  state.hostMcpo.stderrBuffer = "";
  markHostMcpoStopped(state.hostMcpo);

  // Method 2: Kill any process listening on port 8890 (fallback for orphaned processes)
  await killProcessOnPort(state.hostMcpo.port);

  // Method 3: Clean up PID file
  try {
    const pidFile = path.join(PROJECT_ROOT, "MCPO_HOST.pid");
    if (fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
      console.log("Removed MCPO_HOST.pid file");
    }
  } catch (e) {
    /* Ignore */
  }
}

async function stopHostMcpo() {
  return enqueueHostMcpoOperation(() => stopHostMcpoUnlocked());
}

function appendHostMcpBridgeLog(line, severity = "info") {
  if (!line || shouldSuppressHostMcpoLogLine(line)) {
    return;
  }

  if (severity === "error") {
    console.error("[Host MCP Bridge Error]", line);
    state.hostMcpBridge.logs.push(`[ERROR] ${line}`);
  } else if (severity === "warning") {
    console.warn("[Host MCP Bridge Warn]", line);
    state.hostMcpBridge.logs.push(`[WARN] ${line}`);
  } else {
    console.log("[Host MCP Bridge]", line);
    state.hostMcpBridge.logs.push(line);
  }

  if (state.hostMcpBridge.logs.length > 1000) {
    state.hostMcpBridge.logs.shift();
  }
}

function flushHostMcpBridgeBuffer(buffer, source) {
  if (!buffer || buffer.trim().length === 0) {
    return;
  }
  const parsed = consumeProcessOutputLines("", `${buffer}\n`);
  for (const line of parsed.lines) {
    if (source === "stderr") {
      appendHostMcpBridgeLog(line, classifyHostMcpoStderrLine(line));
    } else {
      appendHostMcpBridgeLog(line);
    }
  }
}

async function checkHostMcpBridgeHealth(timeoutMs = 2000, options = {}) {
  try {
    const http = require("http");
    const response = await new Promise((resolve, reject) => {
      const req = http.get(
        `http://127.0.0.1:${state.hostMcpBridge.port}/health`,
        { timeout: timeoutMs },
        (res) => {
          res.resume();
          resolve({ status: res.statusCode });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Timeout"));
      });
    });

    if (response.status !== 200) {
      return false;
    }

    if (options.validateElectronBroker !== false) {
      const bridgeStatus = await checkHostMcpBridgeBrokerStatus(timeoutMs);
      if (!bridgeStatus.ready) {
        if (bridgeStatus.reason) {
          console.warn(
            `[Host MCP Bridge] Health check failed broker status validation: ${bridgeStatus.reason}`,
          );
        }
        return false;
      }
    }

    if (options.expectedProcessGroupPid) {
      return await isPortListenerOwnedByProcessGroup(
        state.hostMcpBridge.port,
        options.expectedProcessGroupPid,
      );
    }

    return true;
  } catch (error) {
    return false;
  }
}

async function checkHostMcpBridgeBrokerStatus(timeoutMs = 2000) {
  try {
    const http = require("http");
    const userDataPath = app?.isReady?.() ? app.getPath("userData") : "";
    if (!userDataPath) {
      return { ready: true };
    }

    const registryPath = ensureBridgeAuthRegistry({ userDataPath });
    const tokenInfo = ensureScopedBridgeToken({
      userDataPath,
      registryPath,
      clientId: "host-mcp-bridge-health",
      displayName: "Host MCP Bridge health",
      scopes: ["bridge:status"],
    });

    const response = await new Promise((resolve, reject) => {
      const req = http.get(
        `http://127.0.0.1:${state.hostMcpBridge.port}/bridge/status`,
        {
          timeout: timeoutMs,
          headers: {
            Authorization: `Bearer ${tokenInfo.token}`,
          },
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () => {
            resolve({ status: res.statusCode, body });
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Timeout"));
      });
    });

    let payload = null;
    try {
      payload = response.body ? JSON.parse(response.body) : null;
    } catch (_) {
      payload = null;
    }

    // Broker readiness intentionally ignores `bridgeEnabled`: that flag is the
    // optional external-client bridge preference, not the health of the
    // mandatory OAuth secret broker that MCP containers depend on (PORTICO-200).
    return {
      ready:
        response.status === 200 &&
        payload?.success === true &&
        payload?.bridgeReady === true &&
        payload?.brokerAuthReady === true,
      reason:
        payload?.errorCode ||
        payload?.reason ||
        (response.status === 200 ? "broker_status_not_ready" : `broker_status_http_${response.status}`),
    };
  } catch (error) {
    return { ready: false, reason: error.message || String(error) };
  }
}

async function startHostMcpBridgeUnlocked() {
  const startRequestId = crypto.randomUUID();
  const PROJECT_ROOT = getProjectRoot();
  const pidFile = path.join(PROJECT_ROOT, "MCP_BRIDGE.pid");

  const existingProcess = state.hostMcpBridge.process;
  const existingProcessAlive =
    existingProcess &&
    !existingProcess.killed &&
    existingProcess.exitCode === null &&
    existingProcess.signalCode === null;

  if (existingProcessAlive) {
    const existingPid = existingProcess.pid || null;
    if (
      await checkHostMcpBridgeHealth(2000, {
        expectedProcessGroupPid: existingPid,
      })
    ) {
      markHostMcpoReady(state.hostMcpBridge);
      console.log(
        `[Host MCP Bridge] Preserving healthy process${existingPid ? ` (PID ${existingPid})` : ""}`,
      );
      void emitBridgeLogRepoEvent("bridge_process_reused", bridgeLifecycleTelemetryFields({
        request_id: startRequestId,
        outcome: "success",
        already_running: true,
        pid_present: Boolean(existingPid),
      }));
      return {
        success: true,
        starting: false,
        alreadyRunning: true,
        pid: existingPid,
      };
    }

    if (isHostMcpoStartupPending(state.hostMcpBridge)) {
      console.log(
        `[Host MCP Bridge] Preserving process while startup health polling continues${existingPid ? ` (PID ${existingPid})` : ""}`,
      );
      void emitBridgeLogRepoEvent("bridge_process_reused", bridgeLifecycleTelemetryFields({
        request_id: startRequestId,
        outcome: "starting",
        already_running: true,
        pid_present: Boolean(existingPid),
      }));
      return {
        success: true,
        starting: true,
        alreadyRunning: true,
        pid: existingPid,
      };
    }

    console.warn(
      `[Host MCP Bridge] Existing process is unhealthy; replacing it${existingPid ? ` (PID ${existingPid})` : ""}`,
    );
    void emitBridgeLogRepoEvent("bridge_process_replaced", bridgeLifecycleTelemetryFields({
      request_id: startRequestId,
      outcome: "unhealthy",
      already_running: true,
      pid_present: Boolean(existingPid),
    }));
  }

  await stopHostMcpBridgeUnlocked({ reason: "startup_cleanup" });
  if (!(await waitForPortListenersToClear(state.hostMcpBridge.port))) {
    throw new Error(
      `Host MCP Bridge port ${state.hostMcpBridge.port} is still in use after cleanup`,
    );
  }

  state.hostMcpBridge.logs = [];
  state.hostMcpBridge.stdoutBuffer = "";
  state.hostMcpBridge.stderrBuffer = "";

  const bridgeScript = path.join(
    PROJECT_ROOT,
    "src",
    "scripts",
    "run-host-mcp-bridge.sh",
  );

  const isPackagedAppRun = app.isPackaged === true;
  const bridgeAuthRegistryPath = ensureBridgeAuthRegistry({
    userDataPath: app.getPath("userData"),
  });
  const telemetryIdentity = await require("./telemetry-identity")
    .getTelemetryIdentity()
    .catch(() => ({ ldap: "" }));
  const env = applyMainStackOAuthCallbackPortEnv(
    sanitizeHostMcpBridgeEnv(
      createEnhancedEnv({
        HOST_MCP_IS_PACKAGED: isPackagedAppRun ? "1" : "0",
        HOST_MCP_BRIDGE_HOST: "127.0.0.1",
        HOST_MCP_BRIDGE_PORT: String(state.hostMcpBridge.port),
        HOST_MCP_BRIDGE_MCP_PATH: "/mcp",
        HOST_MCP_BRIDGE_AUTH_REGISTRY: bridgeAuthRegistryPath,
        portico_LDAP: telemetryIdentity.ldap || "",
        portico_APP_VERSION: currentAppVersion(),
        portico_BUILD_CHANNEL:
          process.env.portico_RELEASE_CHANNEL ||
          process.env.RELEASE_CHANNEL ||
          process.env.UPDATE_CHANNEL ||
          "",
        portico_MACHINE_HASH: hashString(os.hostname()),
        HOST_MCP_BRIDGE_ELECTRON_OAUTH_BROKER_URL:
          HOST_MCP_BRIDGE_ELECTRON_OAUTH_BROKER_URL,
        HOST_MCP_BRIDGE_ELECTRON_OAUTH_UPDATE_URL:
          HOST_MCP_BRIDGE_ELECTRON_OAUTH_UPDATE_URL,
        HOST_MCP_BRIDGE_ELECTRON_OAUTH_INVALIDATE_URL:
          HOST_MCP_BRIDGE_ELECTRON_OAUTH_INVALIDATE_URL,
        HOST_MCP_BRIDGE_ELECTRON_STATIC_SECRET_BROKER_URL:
          HOST_MCP_BRIDGE_ELECTRON_STATIC_SECRET_BROKER_URL,
        HOST_MCP_BRIDGE_ELECTRON_BROKER_TOKEN:
          HOST_MCP_BRIDGE_ELECTRON_BROKER_TOKEN,
        PATH: process.env.PATH || "",
      }),
    ),
  );
  if (isPackagedAppRun && process.resourcesPath) {
    env.HOST_MCP_RESOURCES_ROOT = process.resourcesPath;
    console.log(
      `[Host MCP Bridge] Using packaged resources root: ${process.resourcesPath}`,
    );
  } else {
    delete env.HOST_MCP_RESOURCES_ROOT;
  }

  console.log("Starting Host MCP Bridge on port", state.hostMcpBridge.port);
  void emitBridgeLogRepoEvent("bridge_process_start_requested", bridgeLifecycleTelemetryFields({
    request_id: startRequestId,
    outcome: "requested",
  }));
  const bridgeProcess = spawn("bash", [bridgeScript], {
    cwd: PROJECT_ROOT,
    env,
    detached: true,
  });
  state.hostMcpBridge.process = bridgeProcess;
  markHostMcpoStarting(state.hostMcpBridge, {
    timeoutMs: HOST_MCP_BRIDGE_STARTUP_TIMEOUT_MS,
  });

  bridgeProcess.stdout.on("data", (data) => {
    const parsed = consumeProcessOutputLines(state.hostMcpBridge.stdoutBuffer, data);
    state.hostMcpBridge.stdoutBuffer = parsed.remainder;
    for (const line of parsed.lines) {
      appendHostMcpBridgeLog(line);
    }
  });

  bridgeProcess.stderr.on("data", (data) => {
    const parsed = consumeProcessOutputLines(state.hostMcpBridge.stderrBuffer, data);
    state.hostMcpBridge.stderrBuffer = parsed.remainder;
    for (const line of parsed.lines) {
      appendHostMcpBridgeLog(line, classifyHostMcpoStderrLine(line));
    }
  });

  bridgeProcess.on("close", (code) => {
    flushHostMcpBridgeBuffer(state.hostMcpBridge.stdoutBuffer, "stdout");
    flushHostMcpBridgeBuffer(state.hostMcpBridge.stderrBuffer, "stderr");
    state.hostMcpBridge.stdoutBuffer = "";
    state.hostMcpBridge.stderrBuffer = "";

    console.log(`Host MCP Bridge process exited with code ${code}`);
    void emitBridgeLogRepoEvent("bridge_process_exited", bridgeLifecycleTelemetryFields({
      request_id: startRequestId,
      outcome: code === 0 ? "success" : "failed",
      exit_code: Number.isFinite(code) ? code : -1,
    }));
    if (state.hostMcpBridge.process === bridgeProcess) {
      state.hostMcpBridge.process = null;
      markHostMcpoStopped(state.hostMcpBridge, {
        phase: code === 0 ? "stopped" : "failed",
      });
    }

    try {
      if (fs.existsSync(pidFile)) {
        fs.unlinkSync(pidFile);
      }
    } catch (error) {
      console.error("Failed to remove MCP_BRIDGE.pid:", error);
    }
  });

  if (bridgeProcess.pid) {
    try {
      fs.writeFileSync(pidFile, bridgeProcess.pid.toString());
      console.log(`Host MCP Bridge started with PID ${bridgeProcess.pid}`);
      void emitBridgeLogRepoEvent("bridge_process_started", bridgeLifecycleTelemetryFields({
        request_id: startRequestId,
        outcome: "success",
        pid_present: true,
      }));
    } catch (error) {
      console.error("Failed to write MCP_BRIDGE.pid:", error);
      void emitBridgeLogRepoEvent("bridge_process_started", bridgeLifecycleTelemetryFields({
        request_id: startRequestId,
        outcome: "partial",
        pid_present: true,
        ...buildBridgeErrorTelemetry(error, "pid_file_write_failed"),
      }));
    }
  }

  state.hostMcpBridge.startupPromise = pollHostMcpBridgeHealth(
    HOST_MCP_BRIDGE_STARTUP_TIMEOUT_MS,
    {
      expectedProcessGroupPid: bridgeProcess.pid || null,
    },
  );

  return {
    success: true,
    starting: true,
    pid: bridgeProcess.pid || null,
  };
}

async function pollHostMcpBridgeHealth(
  timeoutMs = HOST_MCP_BRIDGE_STARTUP_TIMEOUT_MS,
  options = {},
) {
  const probeRequestId = crypto.randomUUID();
  const startTime = Date.now();
  const pollInterval = 1000;

  console.log(
    `[Host MCP Bridge] Starting background health polling (timeout: ${timeoutMs}ms)`,
  );
  const expectedProcessGroupPid = Number.parseInt(
    String(options.expectedProcessGroupPid || ""),
    10,
  );

  while (Date.now() - startTime < timeoutMs) {
    if (
      Number.isInteger(expectedProcessGroupPid) &&
      expectedProcessGroupPid > 0 &&
      state.hostMcpBridge.process?.pid !== expectedProcessGroupPid
    ) {
      console.log(
        `[Host MCP Bridge] Health polling cancelled; process ${expectedProcessGroupPid} is no longer active`,
      );
      return { success: false, cancelled: true };
    }

    if (await checkHostMcpBridgeHealth(2000, options)) {
      const elapsed = Date.now() - startTime;
      console.log(`[Host MCP Bridge] Health check passed after ${elapsed}ms`);
      markHostMcpoReady(state.hostMcpBridge);
      void emitBridgeLogRepoEvent("bridge_health_probe", bridgeLifecycleTelemetryFields({
        request_id: probeRequestId,
        outcome: "success",
        bridge_ready: true,
        elapsed_ms: elapsed,
        timeout_ms: timeoutMs,
      }));
      return { success: true };
    }

    await sleep(pollInterval);
  }

  console.warn(`[Host MCP Bridge] Health check timed out after ${timeoutMs}ms`);
  markHostMcpoStopped(state.hostMcpBridge, { phase: "timed_out" });
  void emitBridgeLogRepoEvent("bridge_health_probe", bridgeLifecycleTelemetryFields({
    request_id: probeRequestId,
    outcome: "timeout",
    bridge_ready: false,
    elapsed_ms: timeoutMs,
    timeout_ms: timeoutMs,
    ...buildBridgeErrorTelemetry("Host MCP Bridge health check timed out", "bridge_health_timeout"),
  }));
  return { success: false, timeout: true };
}

async function startHostMcpBridge() {
  return enqueueHostMcpBridgeOperation(() => startHostMcpBridgeUnlocked());
}

// OAuth-capable containers vend and refresh host-encrypted records through this
// bridge. Starting a container before the health endpoint is ready creates a
// separate connection-refused failure mode, so every launch path shares this
// readiness gate.
async function ensureHostMcpBridgeReady({
  timeoutMs = HOST_MCP_BRIDGE_STARTUP_TIMEOUT_MS,
} = {}) {
  if (await checkHostMcpBridgeHealth()) {
    return { ready: true, alreadyRunning: true };
  }

  let startResult;
  try {
    startResult = await startHostMcpBridge();
  } catch (error) {
    void emitBridgeLogRepoEvent("bridge_process_start_failed", bridgeLifecycleTelemetryFields({
      outcome: "failed",
      timeout_ms: timeoutMs,
      ...buildBridgeErrorTelemetry(error),
    }));
    return {
      ready: false,
      error: `Could not start the OAuth broker (Host MCP Bridge): ${error.message}`,
    };
  }

  if (
    !startResult?.success &&
    !startResult?.starting &&
    !startResult?.alreadyRunning
  ) {
    return {
      ready: false,
      error:
        startResult?.error ||
        "Could not start the OAuth broker (Host MCP Bridge).",
    };
  }

  const deadline = Date.now() + Math.max(1, timeoutMs);
  const expectedProcessGroupPid = startResult?.pid || null;
  while (Date.now() < deadline) {
    const healthy = expectedProcessGroupPid
      ? await checkHostMcpBridgeHealth(500, { expectedProcessGroupPid })
      : await checkHostMcpBridgeHealth();
    if (healthy) {
      return { ready: true, alreadyRunning: Boolean(startResult?.alreadyRunning) };
    }

    const remainingMs = deadline - Date.now();
    await sleep(Math.min(500, Math.max(1, remainingMs)));
  }

  return {
    ready: false,
    error: `The OAuth broker (Host MCP Bridge on port ${state.hostMcpBridge.port}) did not become healthy within ${timeoutMs}ms. MCP containers were not started.`,
  };
}

async function stopHostMcpBridgeUnlocked(options = {}) {
  const stopRequestId = crypto.randomUUID();
  const PROJECT_ROOT = getProjectRoot();
  const pidFile = path.join(PROJECT_ROOT, "MCP_BRIDGE.pid");
  console.log("Stopping Host MCP Bridge process...");
  const legacyLaunchAgents =
    await stopLegacyStandaloneHostMcpBridgeLaunchAgents();
  const hadProcess =
    state.hostMcpBridge.process && state.hostMcpBridge.process.pid;
  void emitBridgeLogRepoEvent("bridge_process_stop_requested", bridgeLifecycleTelemetryFields({
    request_id: stopRequestId,
    outcome: "requested",
    pid_present: Boolean(hadProcess),
    stop_reason: options.reason || "manual",
    legacy_launch_agent_count: legacyLaunchAgents.stopped.length,
  }));

  if (state.hostMcpBridge.process && state.hostMcpBridge.process.pid) {
    const bridgeProcess = state.hostMcpBridge.process;
    const pid = bridgeProcess.pid;
    try {
      process.kill(-pid, "SIGTERM");
      await sleep(500);
      try {
        process.kill(-pid, 0);
        console.log(`Host MCP Bridge process group ${pid} still running, sending SIGKILL...`);
        process.kill(-pid, "SIGKILL");
        await sleep(500);
      } catch (e) {
        // Already dead.
      }
    } catch (e) {
      console.log(`Host MCP Bridge process group kill for ${pid}:`, e.message);
    }
    if (state.hostMcpBridge.process === bridgeProcess) {
      state.hostMcpBridge.process = null;
    }
  }

  state.hostMcpBridge.stdoutBuffer = "";
  state.hostMcpBridge.stderrBuffer = "";
  markHostMcpoStopped(state.hostMcpBridge);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await killProcessOnPort(state.hostMcpBridge.port);
    if (await waitForPortListenersToClear(state.hostMcpBridge.port, 1000)) {
      break;
    }
  }

  if (!(await waitForPortListenersToClear(
    state.hostMcpBridge.port,
    HOST_MCP_BRIDGE_STOP_TIMEOUT_MS,
  ))) {
    const listenerPids = await listListeningPidsOnPort(state.hostMcpBridge.port);
    const errorMessage =
      `Host MCP Bridge port ${state.hostMcpBridge.port} is still in use after stop` +
      (listenerPids.length > 0 ? ` (PID${listenerPids.length === 1 ? "" : "s"}: ${listenerPids.join(", ")})` : "");
    void emitBridgeLogRepoEvent("bridge_process_stop_failed", bridgeLifecycleTelemetryFields({
      request_id: stopRequestId,
      outcome: "failed",
      pid_present: Boolean(hadProcess),
      stop_reason: options.reason || "manual",
      legacy_launch_agent_count: legacyLaunchAgents.stopped.length,
      ...buildBridgeErrorTelemetry(errorMessage, "bridge_stop_port_still_in_use"),
    }));
    return {
      success: false,
      error: errorMessage,
      listenerPids,
      legacyLaunchAgents,
    };
  }

  try {
    if (fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
      console.log("Removed MCP_BRIDGE.pid file");
    }
  } catch (e) {
    // Ignore cleanup errors.
  }

  void emitBridgeLogRepoEvent("bridge_process_stopped", bridgeLifecycleTelemetryFields({
    request_id: stopRequestId,
    outcome: "success",
    pid_present: Boolean(hadProcess),
    stop_reason: options.reason || "manual",
    legacy_launch_agent_count: legacyLaunchAgents.stopped.length,
  }));
  return { success: true, legacyLaunchAgents };
}

async function stopHostMcpBridge(options = {}) {
  return enqueueHostMcpBridgeOperation(() => stopHostMcpBridgeUnlocked(options));
}

// ============================================================================
// HEALTH CHECK MONITORING
// ============================================================================

// Health check state
let healthCheckInterval = null;
let lastHealthStatus = null;
let targetedReadinessPublisher = null;
let targetedReadinessPublisherRoot = null;

function getTargetedReadinessPublisher() {
  const projectRoot = getProjectRoot();
  if (
    !targetedReadinessPublisher ||
    targetedReadinessPublisherRoot !== projectRoot
  ) {
    targetedReadinessPublisherRoot = projectRoot;
    targetedReadinessPublisher = new McpReadinessPublisher({
      getProjectRoot,
      getSequenceFloor: () =>
        Math.max(
          healthStatusSequence,
          Number(lastHealthStatus?.sync?.sequence) || 0,
        ),
      broadcast: async (healthData) => {
        broadcastHealthStatusUpdate(healthData, {
          mode: "targeted-readiness",
          reason: "mcp-operation-direct-probe",
        });
      },
    });
  }
  return targetedReadinessPublisher;
}

async function publishTargetedMcpReadiness(readiness, options = {}) {
  const firstEntry = Array.isArray(readiness) ? readiness[0] : readiness;
  return getTargetedReadinessPublisher().publish(readiness, {
    operationId: options.operationId || firstEntry?.operationId,
    reason: options.reason || "mcp-operation-direct-probe",
  });
}

function beginTargetedMcpOperationPublication(operationId) {
  return getTargetedReadinessPublisher().beginOperation(operationId);
}

function endTargetedMcpOperationPublication(operationId) {
  return getTargetedReadinessPublisher().endOperation(operationId);
}

function resetTargetedMcpOperationPublication() {
  return getTargetedReadinessPublisher().resetInterruptedOperationMarker();
}
let healthStatusSequence = 0;
let rapidCheckInProgress = false;
let rapidCheckTimeoutId = null;
let lastFullHealthSyncAttemptAt = 0;
let lastFullHealthSyncSuccessAt = 0;
let activeFullHealthSyncStartedAt = 0;
let activeFullHealthSyncRunId = "";
let activeFullHealthSyncMode = null;
let activeFullHealthSyncReason = null;
let startupCoreGateAttempted = false;
let startupCoreGateSucceeded = false;
let lastHealthCheckFailureCode = null;

const LIGHT_HEALTH_CHECK_INTERVAL_MS = 60000;
const FULL_HEALTH_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const STARTUP_CORE_HEALTH_TIMEOUT_MS = Math.max(
  5000,
  Number.parseInt(process.env.STARTUP_CORE_TIMEOUT_MS || "120000", 10) || 120000,
);
const STARTUP_FULL_HEALTH_CHECKS = Math.max(
  0,
  Number.parseInt(process.env.STARTUP_FULL_HEALTH_CHECKS || "3", 10) || 0,
);
let startupFullHealthChecksRemaining = STARTUP_FULL_HEALTH_CHECKS;
const STARTUP_HEALTH_PRIME_ENABLED =
  process.env.STARTUP_HEALTH_PRIME_ENABLED !== "false";
const HEALTH_CHECK_FAILURE_FOLLOWUP_DELAY_MS = Math.max(
  1000,
  Number.parseInt(
    process.env.HEALTH_CHECK_FAILURE_FOLLOWUP_DELAY_MS || "5000",
    10,
  ) || 5000,
);
const RAPID_HEALTH_LOCK_BUSY_BACKOFF_MS = Math.max(
  5000,
  Number.parseInt(process.env.RAPID_HEALTH_LOCK_BUSY_BACKOFF_MS || "10000", 10) ||
    10000,
);
const RAPID_HEALTH_STARTING_RECHECK_MS = Math.max(
  5000,
  Number.parseInt(process.env.RAPID_HEALTH_STARTING_RECHECK_MS || "5000", 10) ||
    5000,
);
const DB_CORRUPTION_SCAN_LOG_FLUSH_DELAY_MS = Math.max(
  0,
  Number.parseInt(
    process.env.DB_CORRUPTION_SCAN_LOG_FLUSH_DELAY_MS || "500",
    10,
  ) || 500,
);
const ON_DEMAND_FULL_HEALTH_DEBOUNCE_MS = Math.max(
  0,
  Number.parseInt(process.env.ON_DEMAND_FULL_HEALTH_DEBOUNCE_MS || "5000", 10) ||
    5000,
);
const ON_DEMAND_FULL_HEALTH_MIN_INTERVAL_MS = Math.max(
  1000,
  Number.parseInt(
    process.env.ON_DEMAND_FULL_HEALTH_MIN_INTERVAL_MS || "45000",
    10,
  ) || 45000,
);
const ON_DEMAND_FULL_HEALTH_RETRY_DELAY_MS = Math.max(
  1000,
  Number.parseInt(
    process.env.ON_DEMAND_FULL_HEALTH_RETRY_DELAY_MS || "15000",
    10,
  ) || 15000,
);
const ON_DEMAND_FULL_HEALTH_MAX_RETRIES = Math.max(
  0,
  Number.parseInt(
    process.env.ON_DEMAND_FULL_HEALTH_MAX_RETRIES || "1",
    10,
  ) || 1,
);
const HEALTH_SYNC_LAG_WARNING_MS = Math.max(
  10000,
  Number.parseInt(process.env.HEALTH_SYNC_LAG_WARNING_MS || "120000", 10) ||
    120000,
);
const HEALTH_SYNC_OVERDUE_WARNING_MS = Math.max(
  FULL_HEALTH_SYNC_INTERVAL_MS + 30000,
  Number.parseInt(
    process.env.HEALTH_SYNC_OVERDUE_WARNING_MS ||
      String(FULL_HEALTH_SYNC_INTERVAL_MS + 30000),
    10,
  ) ||
    FULL_HEALTH_SYNC_INTERVAL_MS + 30000,
);
const AUTO_HEAL_MAX_RETRIES_PER_SERVER = Math.max(
  0,
  Number.parseInt(process.env.AUTO_HEAL_MAX_RETRIES_PER_SERVER || "1", 10) || 0,
);
const AUTO_HEAL_COOLDOWN_MS = Math.max(
  1000,
  Number.parseInt(process.env.AUTO_HEAL_COOLDOWN_MS || "45000", 10) || 45000,
);
const AUTO_HEAL_FAILURE_STATUSES = new Set(["failed", "timeout", "not_running"]);
const AUTO_HEAL_OAUTH_STATES = new Set([
  "active",
  "waiting_callback",
  "pending",
  "checking",
  "timeout",
  "failed",
]);
const RAPID_HEALTH_TERMINAL_STATUSES = new Set([
  "disabled",
  "not_configured",
  "not configured",
  "needs_oauth",
  "needs auth",
]);

// Health check mutex to prevent race conditions between periodic and single-server checks
let healthCheckLocked = false;
let healthCheckWaiters = [];
let onDemandFullHealthTimer = null;
let onDemandFullHealthInFlight = false;
let onDemandFullHealthReasons = new Set();
let firstOnDemandFullHealthQueuedAt = 0;
let lastOnDemandFullHealthSuccessAt = 0;
let onDemandFullHealthRetryCount = 0;
const autoHealAttemptsByServer = new Map();
const autoHealLastAttemptAtByServer = new Map();
const autoHealInProgressServers = new Set();

function toIsoTimestamp(timestampMs) {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
    return null;
  }
  return new Date(timestampMs).toISOString();
}

function buildHealthSyncDiagnostics() {
  const now = Date.now();
  const pendingReasons = Array.from(onDemandFullHealthReasons);
  const pendingQueued = pendingReasons.length > 0;
  const activeFullSyncInFlight = activeFullHealthSyncStartedAt > 0;
  const activeFullSyncAgeMs = activeFullSyncInFlight
    ? Math.max(0, now - activeFullHealthSyncStartedAt)
    : null;
  const lastFullSyncAttemptAgeMs = lastFullHealthSyncAttemptAt
    ? Math.max(0, now - lastFullHealthSyncAttemptAt)
    : null;
  const lastFullSyncSuccessAgeMs = lastFullHealthSyncSuccessAt
    ? Math.max(0, now - lastFullHealthSyncSuccessAt)
    : null;
  const pendingQueuedAgeMs =
    pendingQueued && firstOnDemandFullHealthQueuedAt > 0
      ? Math.max(0, now - firstOnDemandFullHealthQueuedAt)
      : null;

  const warnings = [];
  if (
    pendingQueued &&
    pendingQueuedAgeMs !== null &&
    pendingQueuedAgeMs > HEALTH_SYNC_LAG_WARNING_MS
  ) {
    warnings.push({
      code: "pending_full_sync_lag",
      message: "Queued full health sync is delayed",
      age_ms: pendingQueuedAgeMs,
      reason_count: pendingReasons.length,
    });
  }

  if (
    lastFullSyncSuccessAgeMs !== null &&
    lastFullSyncSuccessAgeMs > HEALTH_SYNC_OVERDUE_WARNING_MS
  ) {
    warnings.push({
      code: "full_sync_overdue",
      message: "No successful full health sync within expected interval",
      age_ms: lastFullSyncSuccessAgeMs,
      expected_interval_ms: FULL_HEALTH_SYNC_INTERVAL_MS,
    });
  } else if (
    lastFullHealthSyncSuccessAt === 0 &&
    lastFullSyncAttemptAgeMs !== null &&
    lastFullSyncAttemptAgeMs > HEALTH_SYNC_LAG_WARNING_MS
  ) {
    warnings.push({
      code: "full_sync_never_succeeded",
      message: "Full health sync has been attempted but has not succeeded yet",
      age_ms: lastFullSyncAttemptAgeMs,
    });
  }

  return {
    full_sync_interval_ms: FULL_HEALTH_SYNC_INTERVAL_MS,
    last_health_status_sequence: healthStatusSequence,
    last_full_sync_attempt_at: toIsoTimestamp(lastFullHealthSyncAttemptAt),
    last_full_sync_success_at: toIsoTimestamp(lastFullHealthSyncSuccessAt),
    last_full_sync_attempt_age_ms: lastFullSyncAttemptAgeMs,
    last_full_sync_success_age_ms: lastFullSyncSuccessAgeMs,
    pending_full_sync: {
      queued: pendingQueued,
      in_flight: onDemandFullHealthInFlight || activeFullSyncInFlight,
      reason_count: pendingReasons.length,
      reasons: pendingReasons.slice(0, 8),
      retry_count: onDemandFullHealthRetryCount,
      queued_at: toIsoTimestamp(firstOnDemandFullHealthQueuedAt),
      queued_age_ms: pendingQueuedAgeMs,
    },
    active_full_sync: {
      in_flight: activeFullSyncInFlight,
      run_id: activeFullHealthSyncRunId || null,
      mode: activeFullHealthSyncMode,
      reason: activeFullHealthSyncReason,
      started_at: toIsoTimestamp(activeFullHealthSyncStartedAt),
      age_ms: activeFullSyncAgeMs,
    },
    warnings,
  };
}

function toSequenceNumber(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
}

function trackHealthStatusSequence(value) {
  const sequence = toSequenceNumber(value);
  if (sequence === null) return null;
  if (sequence > healthStatusSequence) {
    healthStatusSequence = sequence;
  }
  return sequence;
}

function nextHealthStatusSequence() {
  healthStatusSequence += 1;
  return healthStatusSequence;
}

function annotateHealthSyncDiagnostics(healthStatus, context = {}) {
  if (!healthStatus || typeof healthStatus !== "object") {
    return healthStatus;
  }

  const contextSequence = trackHealthStatusSequence(Number(context.sequence));
  const existingSequence = trackHealthStatusSequence(
    Number(healthStatus?.sync?.sequence),
  );
  const syncSequence =
    contextSequence ??
    (context.bumpSequence === true ? nextHealthStatusSequence() : existingSequence ?? healthStatusSequence);

  const sync = {
    ...buildHealthSyncDiagnostics(),
    sequence: syncSequence,
    last_health_check_mode: context.mode || null,
    last_health_check_reason: context.reason || null,
  };
  healthStatus.sync = sync;

  if (
    !healthStatus.warnings ||
    typeof healthStatus.warnings !== "object" ||
    Array.isArray(healthStatus.warnings)
  ) {
    healthStatus.warnings = {};
  }
  healthStatus.warnings.sync = sync.warnings;
  preserveLaggingServerStates(healthStatus, lastHealthStatus, {
    recomputeSummary: recomputeHealthSummaryFromServers,
  });
  applyHostMcpoStartupHealthOverrides(healthStatus);
  return healthStatus;
}

function recomputeHealthSummaryFromServers(healthStatus) {
  if (!healthStatus || typeof healthStatus !== "object") {
    return;
  }

  const servers = healthStatus.servers || {};
  const summary = {
    total: 0,
    healthy: 0,
    starting: 0,
    checking: 0,
    failed: 0,
    needs_oauth: 0,
    not_configured: 0,
    disabled: 0,
    timeout: 0,
    unknown: 0,
  };

  for (const serverInfo of Object.values(servers)) {
    if (!serverInfo || typeof serverInfo !== "object") {
      continue;
    }

    summary.total += 1;
    const status = String(serverInfo.status || "unknown").toLowerCase();
    if (Object.prototype.hasOwnProperty.call(summary, status)) {
      summary[status] += 1;
    } else {
      summary.unknown += 1;
    }
  }

  healthStatus.summary = {
    ...(healthStatus.summary || {}),
    ...summary,
  };
}

function applyHostMcpoStartupHealthOverrides(healthStatus) {
  if (!healthStatus || typeof healthStatus !== "object") {
    return;
  }
  if (!isHostMcpoStartupPending(state.hostMcpo)) {
    return;
  }
  if (!healthStatus.servers || typeof healthStatus.servers !== "object") {
    return;
  }

  let changed = false;
  for (const serverInfo of Object.values(healthStatus.servers)) {
    if (!shouldTreatHostServerAsStarting(serverInfo, state.hostMcpo)) {
      continue;
    }

    serverInfo.status = "starting";
    serverInfo.error = "Host MCP runtime is starting";
    serverInfo.running = false;
    if (!serverInfo.readiness_phase) {
      serverInfo.readiness_phase = "starting";
    }
    serverInfo.host_runtime_starting = true;
    changed = true;
  }

  if (changed) {
    recomputeHealthSummaryFromServers(healthStatus);
  }
}

async function readAnnotatedHealthStatusFile(healthStatusFile, context = {}) {
  try {
    await fsPromises.access(healthStatusFile);
  } catch {
    return null;
  }

  try {
    const raw = await fsPromises.readFile(healthStatusFile, "utf8");
    const rawData = JSON.parse(raw);
    const observedToggleRevision =
      rawData.toggle_revision ||
      rawData.sync_diagnostics?.toggle_revision ||
      null;
    const rawToggleState = loadRawMcpToggles({ includeMeta: true });
    if (!rawToggleState.exists || rawToggleState.parseError) {
      const rejection = {
        code: rawToggleState.exists
          ? "TOGGLE_SOURCE_INVALID"
          : "TOGGLE_SOURCE_MISSING",
        expectedToggleRevision: null,
        observedToggleRevision,
      };
      if (typeof context.onToggleRevisionRejected === "function") {
        context.onToggleRevisionRejected(rejection);
      }
      console.warn(
        `[Health] Rejecting health snapshot because mcp_toggles.json is ${rawToggleState.exists ? "invalid" : "missing"}`,
      );
      return null;
    }
    const expectedToggleRevision = computeMcpToggleRevision(
      rawToggleState.toggles,
    );
    if (
      (context.requireToggleRevision === true && !observedToggleRevision) ||
      (observedToggleRevision && observedToggleRevision !== expectedToggleRevision)
    ) {
      if (typeof context.onToggleRevisionRejected === "function") {
        context.onToggleRevisionRejected({
          code: observedToggleRevision
            ? "TOGGLE_REVISION_MISMATCH"
            : "TOGGLE_REVISION_MISSING",
          expectedToggleRevision,
          observedToggleRevision,
        });
      }
      console.warn(
        `[Health] Rejecting incoherent health snapshot (toggle revision expected=${expectedToggleRevision}, observed=${observedToggleRevision || "missing"})`,
      );
      return null;
    }
    const data = overlayStartupFailures(
      annotateHealthSyncDiagnostics(rawData, context),
      getProjectRoot(),
      { logger: console },
    );
    lastHealthStatus = data;
    return data;
  } catch (error) {
    console.warn(
      `[Health] Could not read health status file ${healthStatusFile}: ${error.message}`,
    );
    return null;
  }
}

function readHealthStatusSnapshotSync(projectRoot) {
  const healthStatusFile = path.join(
    projectRoot,
    "health-status",
    "health_status.json",
  );
  try {
    return JSON.parse(fs.readFileSync(healthStatusFile, "utf8"));
  } catch {
    return null;
  }
}

function cloneHealthStatusSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }
  try {
    return JSON.parse(JSON.stringify(snapshot));
  } catch {
    return null;
  }
}

function resolveStartupFailureForPublish(projectRoot, failureOrServerId) {
  if (typeof failureOrServerId === "string") {
    return loadStartupFailures(projectRoot, {
      logger: console,
    })[failureOrServerId] || null;
  }
  return normalizeStartupFailure(failureOrServerId || {});
}

function publishStartupFailureState(failureOrServerId, context = {}) {
  const projectRoot = getProjectRoot();
  if (!projectRoot) {
    return null;
  }

  let failure;
  try {
    failure = resolveStartupFailureForPublish(projectRoot, failureOrServerId);
  } catch (error) {
    console.warn(
      `[MCP Startup Failure] Could not publish failure state: ${error.message}`,
    );
    return null;
  }
  if (!failure) {
    return null;
  }

  const phase = failure.stage === "timeout" ? "timeout" : "failed";
  state.updateServerPhase(failure.serverId, phase, {
    healthy: false,
    deploymentType: failure.deploymentType || null,
    error: failure.error,
  });

  const reason = context.reason || `startup-failure:${failure.serverId}`;
  const baseStatus =
    cloneHealthStatusSnapshot(lastHealthStatus) ||
    readHealthStatusSnapshotSync(projectRoot) ||
    { servers: {}, summary: {} };
  const annotated = annotateHealthSyncDiagnostics(baseStatus, {
    mode: "startup-failure",
    reason,
    bumpSequence: true,
  });
  const overlaid = overlayStartupFailures(annotated, projectRoot, {
    logger: console,
  });
  const broadcasted = broadcastHealthStatusUpdate(overlaid, {
    mode: "startup-failure",
    reason,
  });
  if (broadcasted) {
    lastHealthStatus = broadcasted;
  }
  return broadcasted;
}

function recordAndPublishStartupFailure(projectRoot, failure, options = {}) {
  const recorded = recordStartupFailure(projectRoot, failure, options);
  publishStartupFailureState(recorded, {
    reason: options.reason || `startup-failure:${recorded.serverId}`,
  });
  return recorded;
}

function isRapidHealthTerminalServer(serverInfo) {
  if (!serverInfo || typeof serverInfo !== "object") return false;
  if (serverInfo.configured === false || serverInfo.disabled_by_user === true) {
    return true;
  }

  const status = String(serverInfo.status || "").toLowerCase();
  const oauthState = String(serverInfo.oauth_state || "").toLowerCase();
  const readinessPhase = String(
    serverInfo.readiness_phase || serverInfo.readinessPhase || "",
  ).toLowerCase();

  return (
    RAPID_HEALTH_TERMINAL_STATUSES.has(status) ||
    RAPID_HEALTH_TERMINAL_STATUSES.has(oauthState) ||
    RAPID_HEALTH_TERMINAL_STATUSES.has(readinessPhase)
  );
}

function getRapidHealthStartingCount(data) {
  if (!data || typeof data !== "object") return 0;
  if (data.servers && typeof data.servers === "object") {
    return Object.values(data.servers).filter((serverInfo) => {
      if (!serverInfo || typeof serverInfo !== "object") return false;
      if (isRapidHealthTerminalServer(serverInfo)) return false;
      return String(serverInfo.status || "").toLowerCase() === "starting";
    }).length;
  }
  return Number(data.summary?.starting) || 0;
}

function broadcastHealthStatusUpdate(data, context = {}) {
  if (!data || typeof data !== "object") {
    if (typeof context.callback === "function") {
      context.callback(null);
    }
    return null;
  }

  const projectRoot = getProjectRoot();
  const knownServerIds = discoverInstalledMcpServerIds(projectRoot, {
    logger: console,
  });
  data = overlayStartupFailures(data, projectRoot, {
    knownServerIds,
    logger: console,
  });
  trackHealthStatusSequence(Number(data?.sync?.sequence));
  lastHealthStatus = cloneHealthStatusSnapshot(data) || data;

  if (data.servers && typeof data.servers === "object") {
    for (const [serverId, serverInfo] of Object.entries(data.servers)) {
      if (!serverInfo || typeof serverInfo !== "object") continue;
      if (knownServerIds.size > 0 && !knownServerIds.has(serverId)) continue;
      const healthy =
        serverInfo.healthy === true || serverInfo.status === "healthy";
      const phase = canonicalizeReadinessPhase({
        healthy,
        readiness_phase: serverInfo.readiness_phase,
        readinessPhase: serverInfo.readinessPhase,
        status: serverInfo.status,
      });
      state.updateServerPhase(serverId, phase, {
        healthy,
        deploymentType: serverInfo.deployment || null,
        toolsCount: serverInfo.tools_count ?? 0,
        error: serverInfo.error || null,
      });
    }
  }

  BrowserWindow.getAllWindows().forEach((window) => {
    if (!window.isDestroyed()) {
      safeWebContentsSend(window, "health-status-update", data, {
        tag: "health-status-broadcast",
        meta: {
          source: "runHealthCheckAndBroadcast",
          targetWindowId: window.id,
        },
      });
    }
  });

  const startingCount = getRapidHealthStartingCount(data);
  console.log(
    `[Health] Status updated: ${data.summary?.healthy ?? 0}/${data.summary?.total ?? 0} healthy, ${startingCount} starting (sequence=${data?.sync?.sequence ?? "n/a"})`,
  );

  if (typeof context.callback === "function") {
    context.callback(data);
  }

  if (startingCount > 0 && !rapidCheckInProgress) {
    console.log(
      `[Health] ${startingCount} server(s) starting, initiating rapid checks`,
    );
    runRapidHealthChecks();
  }

  if (
    context.allowAutoHeal !== false &&
    context.mode !== "targeted-readiness"
  ) {
    scheduleAutoHealFromHealthStatus(data, {
      reason: context.reason,
      mode: context.mode,
    });
  }
  return data;
}

function getHealthSyncState() {
  return buildHealthSyncDiagnostics();
}

function readHealthStatusMarker(healthStatusFile) {
  try {
    const status = fs.statSync(healthStatusFile);
    return {
      ino: status.ino,
      mtimeMs: status.mtimeMs,
      size: status.size,
    };
  } catch {
    return null;
  }
}

function verifyFreshHealthRun(
  healthStatusFile,
  healthData,
  healthSyncRunId,
  mode,
  runnerStartedAt,
  priorStatusMarker,
) {
  try {
    const runIdFile = path.join(path.dirname(healthStatusFile), "health_sync_run_id");
    const recordedRunId = fs.readFileSync(runIdFile, "utf8").trim();
    const statusMarker = readHealthStatusMarker(healthStatusFile);
    return isFreshHealthResult({
      expectedRunId: healthSyncRunId,
      expectedMode: mode,
      recordedRunId,
      runnerStartedAt,
      priorStatusMarker,
      statusMarker,
      healthData,
    });
  } catch {
    return false;
  }
}

function clearMcpRuntimeStateForServer(serverId) {
  if (!serverId || typeof serverId !== "string") {
    return false;
  }
  invalidateServerToolsCache(serverId);
  autoHealAttemptsByServer.delete(serverId);
  autoHealLastAttemptAtByServer.delete(serverId);
  autoHealInProgressServers.delete(serverId);
  state.serverLifecycle?.delete?.(serverId);

  if (lastHealthStatus?.servers?.[serverId]) {
    delete lastHealthStatus.servers[serverId];
    recomputeHealthSummaryFromServers(lastHealthStatus);
  }

  return true;
}

/**
 * Try to acquire the health check lock without waiting (synchronous)
 * @returns {boolean} - True if lock acquired, false if busy
 */
function tryAcquireHealthCheckLock() {
  if (!healthCheckLocked) {
    healthCheckLocked = true;
    console.log("[Health] Lock acquired");
    return true;
  }
  console.log("[Health] Lock busy, skipping");
  return false;
}

/**
 * Acquire the health check lock, waiting if necessary (async)
 * @returns {Promise<boolean>} - Resolves to true when lock is acquired
 */
async function acquireHealthCheckLock() {
  if (!healthCheckLocked) {
    healthCheckLocked = true;
    console.log("[Health] Lock acquired");
    return true;
  }

  // Wait for unlock
  console.log("[Health] Lock busy, waiting...");
  return new Promise((resolve) => {
    healthCheckWaiters.push(resolve);
  });
}

/**
 * Release the health check lock
 */
function releaseHealthCheckLock() {
  if (healthCheckWaiters.length > 0) {
    // Pass lock to next waiter
    const next = healthCheckWaiters.shift();
    console.log("[Health] Lock passed to next waiter");
    next(true);
  } else {
    healthCheckLocked = false;
    console.log("[Health] Lock released");
  }
}

function getMcpoPortForDeployment(deploymentType = "docker") {
  switch (deploymentType) {
    case "host":
      return 8890;
    case "core":
      return 8766;
    default:
      return 8765;
  }
}

function extractCallableToolNamesFromOpenApi(openApiSpec) {
  return Object.keys(openApiSpec?.paths || {})
    .map((pathKey) => pathKey.split("/").filter((part) => part)[0] || "")
    .filter((toolName) => {
      const lowerName = toolName.toLowerCase();
      return (
        toolName &&
        lowerName !== "openapi.json" &&
        lowerName !== "docs" &&
        !lowerName.includes("oauth")
      );
    });
}

/**
 * Lightweight single-server health check
 * Verifies the server exposes callable tool routes and updates health_status.json.
 * This is stricter than a plain OpenAPI 200 check because the OpenAPI route can
 * recover before the actual tool routes stop returning 502s.
 * Uses mutex to prevent race conditions with periodic health checks
 * @param {string} serverId - The server ID to check
 * @param {string} deploymentType - 'docker', 'host', or 'core'
 * @returns {Promise<{success: boolean, healthy: boolean, toolsCount?: number, totalPaths?: number, error?: string}>}
 */
async function checkSingleServerHealth(serverId, deploymentType = "docker") {
  const port = getMcpoPortForDeployment(deploymentType);

  console.log(
    `[Health] Single-server check for ${serverId} on port ${port}...`,
  );

  try {
    if (
      deploymentType === "host" &&
      isHostMcpoStartupPending(state.hostMcpo)
    ) {
      return {
        success: true,
        healthy: false,
        starting: true,
        error: "Host MCP runtime is still starting",
      };
    }

    const openApiUrl = `http://localhost:${port}/${serverId}/openapi.json`;
    const response = await fetch(openApiUrl, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const openApiSpec = await response.json();
    const totalPaths = Object.keys(openApiSpec?.paths || {}).length;
    const callableToolNames = extractCallableToolNamesFromOpenApi(openApiSpec);
    if (callableToolNames.length === 0) {
      throw new Error("OpenAPI is reachable but no callable tool paths are exposed yet");
    }

    const probeToolName = callableToolNames[0];
    const probeUrl = `http://localhost:${port}/${serverId}/${probeToolName}`;
    const probeResponse = await fetch(probeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: "{",
      signal: AbortSignal.timeout(5000),
    });

    if (probeResponse.status === 404) {
      throw new Error(
        `Tool route probe for ${probeToolName} returned HTTP 404`,
      );
    }

    if (probeResponse.status >= 500) {
      throw new Error(
        `Tool route probe for ${probeToolName} returned HTTP ${probeResponse.status}`,
      );
    }

    console.log(
      `[Health] Server ${serverId} is healthy (POST tool probe ${probeResponse.status} via ${probeToolName})`,
    );

    try {
      const nextHealthData = await publishTargetedMcpReadiness({
        serverId,
        deploymentType,
        phase: READINESS_PHASE_TOOL_READY,
        readinessPhase: READINESS_PHASE_TOOL_READY,
        healthy: true,
        toolsCount: callableToolNames.length,
        error: null,
        source: "single-server-direct-probe",
      });

      console.log(
        `[Health] Updated and broadcast health status for ${serverId} (sequence=${nextHealthData?.sync?.sequence ?? "n/a"})`,
      );

      return {
        success: true,
        healthy: true,
        readiness_phase: READINESS_PHASE_TOOL_READY,
        toolsCount: callableToolNames.length,
        totalPaths,
        toolName: probeToolName,
        probeStatus: probeResponse.status,
      };
    } catch (updateError) {
      console.error(
        `[Health] Could not update health_status.json: ${updateError.message}`,
      );
      return { success: false, healthy: false, error: updateError.message };
    }
  } catch (error) {
    console.log(
      `[Health] Server ${serverId} not healthy yet: ${error.message}`,
    );
    return { success: true, healthy: false, error: error.message };
  }
}

/**
 * Run health check and broadcast results to all windows
 * Uses the periodic health-check mutex; targeted probes publish through the
 * separate cross-process atomic readiness publisher.
 * @param {Function} callback - Optional callback to receive health status data
 */
async function runHealthCheckAndBroadcast(optionsOrCallback = null) {
  const PROJECT_ROOT = getProjectRoot();
  let callback = null;
  let options = {};

  if (typeof optionsOrCallback === "function") {
    callback = optionsOrCallback;
  } else if (optionsOrCallback && typeof optionsOrCallback === "object") {
    options = optionsOrCallback;
    if (typeof options.callback === "function") {
      callback = options.callback;
    }
  }

  void maybeEmitAppActiveDaily({
    appRef: app,
    readPreferences: readHostMcpBridgePreferences,
  });

  const requestedMode = options.mode || "auto";
  const reason = options.reason || "scheduled";
  const now = Date.now();
  const fullDue =
    !lastFullHealthSyncAttemptAt ||
    now - lastFullHealthSyncAttemptAt >= FULL_HEALTH_SYNC_INTERVAL_MS;
  const forceFullForStartup =
    requestedMode === "auto" && startupFullHealthChecksRemaining > 0;

  let mode = requestedMode;
  if (requestedMode === "auto") {
    mode = forceFullForStartup ? "full" : fullDue ? "full" : "light";
    const elapsedMs = lastFullHealthSyncAttemptAt
      ? now - lastFullHealthSyncAttemptAt
      : null;
    const successElapsedMs = lastFullHealthSyncSuccessAt
      ? now - lastFullHealthSyncSuccessAt
      : null;
    console.log(
      `[Health] Auto mode decision: lastFullAttempt=${lastFullHealthSyncAttemptAt || "never"}, lastFullSuccess=${lastFullHealthSyncSuccessAt || "never"}, elapsedMs=${elapsedMs ?? "n/a"}, successElapsedMs=${successElapsedMs ?? "n/a"}, due=${fullDue}, forceFull=${forceFullForStartup}, reason=${reason}`,
    );
  } else if (
    requestedMode !== "full" &&
    requestedMode !== "light" &&
    requestedMode !== "startup-core"
  ) {
    console.warn(
      `[Health] Unknown mode '${requestedMode}', falling back to auto`,
    );
    mode = fullDue ? "full" : "light";
  }

  const waitForLock = options.waitForLock === true;

  // Acquire lock (optionally wait instead of skipping)
  if (waitForLock) {
    await acquireHealthCheckLock();
  } else if (!tryAcquireHealthCheckLock()) {
    console.log(
      `[Health] Skipping ${mode} health check (${reason}) - another check in progress`,
    );
    if (callback) callback(null);
    return null;
  }

  let fullSyncSucceeded = false;
  let healthData = null;
  let scheduleFailureFollowup = false;
  let scheduleToggleRevisionFollowup = false;
  let activeHealthSyncRunId = "";
  let activeHealthSyncTimeoutMs = null;
  let activeHealthSyncRunnerEnv = null;
  let freshResultVerified = options.requireFreshResult !== true;

  try {
    console.log(`[Health] Running ${mode} health check (${reason})...`);

    const healthStatusFile = path.join(
      PROJECT_ROOT,
      "health-status",
      "health_status.json",
    );
    const healthCheckScript = path.join(
      PROJECT_ROOT,
      "src",
      "scripts",
      "run-health-check.sh",
    );

    // Verify script exists
    if (!fs.existsSync(healthCheckScript)) {
      console.error(
        "[Health] Health check script not found:",
        healthCheckScript,
      );
      if (callback) callback(null);
      return null;
    }

    if (mode === "full") {
      lastFullHealthSyncAttemptAt = Date.now();
      if (forceFullForStartup) {
        startupFullHealthChecksRemaining = Math.max(
          0,
          startupFullHealthChecksRemaining - 1,
        );
        console.log(
          `[Health] Startup full health check forced (${startupFullHealthChecksRemaining} remaining)`,
        );
      }
    }

    const healthCheckExecTimeoutMs = getHealthCheckExecTimeoutMs(mode);
    const healthSyncRunId = `${Date.now()}-${process.pid}-${crypto
      .randomBytes(4)
      .toString("hex")}`;
    const runnerStartedAt = Date.now();
    const priorStatusMarker = readHealthStatusMarker(healthStatusFile);

    // Run health check with ENHANCED PATH
    const enhancedEnv = createEnhancedEnv({
      HEALTH_SYNC_SESSION_ID,
      HEALTH_SYNC_RUN_ID: healthSyncRunId,
      HEALTH_SYNC_REASON: reason,
      HEALTH_SYNC_TIMEOUT_BUDGET_MS: String(healthCheckExecTimeoutMs),
    });
    activeHealthSyncRunId = healthSyncRunId;
    activeHealthSyncTimeoutMs = healthCheckExecTimeoutMs;
    activeHealthSyncRunnerEnv = enhancedEnv;
    if (mode === "full" || mode === "startup-core") {
      activeFullHealthSyncStartedAt = runnerStartedAt;
      activeFullHealthSyncRunId = healthSyncRunId;
      activeFullHealthSyncMode = mode;
      activeFullHealthSyncReason = reason;
    }

    appendHealthSyncRunnerEvent(
      "health_sync_runner_start",
      {
        run_id: healthSyncRunId,
        mode,
        reason,
        timeout_budget_ms: healthCheckExecTimeoutMs,
      },
      enhancedEnv,
    );

    try {
      try {
        const modeRepair = ensureMcpDisableModesSourceReady(
          `health-check:${mode}:${reason}`,
        );
        if (modeRepair?.repaired) {
          console.warn(
            `[Health] Repaired mcp_disable_modes.json before ${mode} health check (${reason}): ${modeRepair.repairReason}`,
          );
        }
      } catch (modeError) {
        // Disable modes are fail-open; never let their repair block health checks.
        console.warn(
          `[Health] Could not normalize mcp_disable_modes.json before ${mode} health check: ${modeError.message}`,
        );
      }
      const toggleRepair = ensureMcpToggleSourceReady(`health-check:${mode}:${reason}`);
      if (toggleRepair?.repaired) {
        console.warn(
          `[Health] Repaired mcp_toggles.json before ${mode} health check (${reason}): ${toggleRepair.repairReason}`,
        );
        appendHealthSyncRunnerEvent(
          "health_sync_runner_toggle_source_repaired",
          {
            run_id: healthSyncRunId,
            mode,
            reason,
            repair_reason: toggleRepair.repairReason,
            backup_path: toggleRepair.backupPath || null,
            toggle_count: Object.keys(toggleRepair.toggles || {}).length,
          },
          enhancedEnv,
        );
      }
      lastHealthCheckFailureCode = null;
      const healthCheckRunnerEnv = {
        ...enhancedEnv,
        HEALTH_SYNC_TOGGLE_SNAPSHOT_READY: "1",
      };
      const { stdout, stderr } = await runManagedProcess(
        "bash",
        [healthCheckScript, "--mode", mode],
        {
          env: healthCheckRunnerEnv,
          timeoutMs: healthCheckExecTimeoutMs,
          maxBufferBytes: 10 * 1024 * 1024,
        },
      );
      const stdoutLines = summarizeOutputLines(stdout);
      const stderrLines = summarizeOutputLines(stderr);
      if (HEALTH_CHECK_LOG_STDOUT) {
        if (stdout) {
          console.log("[Health] Health check output:\n" + stdout.trim());
        }
        if (stderr) {
          console.warn("[Health] Health check stderr:\n" + stderr.trim());
        }
      } else if (stdoutLines > 0 || stderrLines > 0) {
        console.log(
          `[Health] Health check script emitted ${stdoutLines} stdout line(s), ${stderrLines} stderr line(s) (suppressed; set HEALTH_CHECK_LOG_STDOUT=true to print full output)`,
        );
      }
      if (mode === "full") {
        fullSyncSucceeded = true;
      }
      appendHealthSyncRunnerEvent(
        "health_sync_runner_success",
        {
          run_id: healthSyncRunId,
          mode,
          reason,
          timeout_budget_ms: healthCheckExecTimeoutMs,
          elapsed_ms: Date.now() - runnerStartedAt,
          stdout_lines: stdoutLines,
          stderr_lines: stderrLines,
        },
        enhancedEnv,
      );

      if (DB_CORRUPTION_SCAN_LOG_FLUSH_DELAY_MS > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, DB_CORRUPTION_SCAN_LOG_FLUSH_DELAY_MS),
        );
      }

      await scanOpenWebuiDbCorruption({
        reason: `post-health-check:${reason}`,
        forceScan: true,
        forceBroadcast: false,
      });
      if (
        (mode === "full" || mode === "startup-core") &&
        reason !== "loading-gate"
      ) {
        // A failed startup repair remains retryable without a persistent
        // one-time marker. Only successful core-capable health runs schedule it.
        require("./agent-attribution-reconciliation").scheduleAgentAttributionReconciliation({
          invokeMcpTool,
          delayMs: 0,
        });
        require("./user-skill-reconciliation").scheduleUserSkillReconciliation({
          projectRoot: PROJECT_ROOT,
          delayMs: 0,
        });
      }
    } catch (execError) {
      if (isHealthCheckExecTimeout(execError)) {
        console.warn(
          `[Health] ${mode} health check exceeded ${healthCheckExecTimeoutMs}ms; stopping health-check container`,
        );
        appendHealthSyncRunnerEvent(
          "health_sync_runner_timeout",
          {
            run_id: healthSyncRunId,
            mode,
            reason,
            timeout_budget_ms: healthCheckExecTimeoutMs,
            elapsed_ms: Date.now() - runnerStartedAt,
            error: execError.message,
          },
          enhancedEnv,
        );
        try {
          await runManagedProcess("docker", ["stop", "open-webui-health-check"], {
            env: enhancedEnv,
            timeoutMs: 10000,
            maxBufferBytes: 1024 * 1024,
          });
        } catch (stopError) {
          console.warn(
            `[Health] Could not stop timed-out health-check container cleanly: ${stopError.message}`,
          );
          appendHealthSyncRunnerEvent(
            "health_sync_runner_stop_failed",
            {
              run_id: healthSyncRunId,
              mode,
              reason,
              timeout_budget_ms: healthCheckExecTimeoutMs,
              elapsed_ms: Date.now() - runnerStartedAt,
              error: stopError.message,
            },
            enhancedEnv,
          );
        }
      }
      appendHealthSyncRunnerEvent(
        "health_sync_runner_failure",
        {
          run_id: healthSyncRunId,
          mode,
          reason,
          timeout_budget_ms: healthCheckExecTimeoutMs,
          elapsed_ms: Date.now() - runnerStartedAt,
          timed_out: isHealthCheckExecTimeout(execError),
          error: execError.message,
        },
        enhancedEnv,
      );
      lastHealthCheckFailureCode = isToggleSourceHealthCheckFailure(execError)
        ? "TOGGLE_SOURCE_INVALID"
        : "HEALTH_CHECK_RUNNER_FAILED";
      console.error(
        "[Health] Background health check failed:",
        execError.message,
      );
      if (execError.stderr) {
        console.error("[Health] stderr:", truncateOutput(execError.stderr));
      }
      if (mode !== "light" && !String(reason).startsWith("followup-after-")) {
        scheduleFailureFollowup = true;
      }
      void scanOpenWebuiDbCorruption({
        reason: `post-health-check-failure:${reason}`,
        forceScan: true,
        forceBroadcast: false,
      }).catch((scanError) => {
        console.warn(
          `[Health] DB corruption scan failed after health-check error (${reason}): ${scanError.message}`,
        );
      });
      const fallbackData = await readAnnotatedHealthStatusFile(healthStatusFile, {
        mode,
        reason,
        bumpSequence: true,
        requireToggleRevision: true,
        onToggleRevisionRejected: () => {
          scheduleToggleRevisionFollowup = !String(reason).startsWith(
            "toggle-revision-retry:",
          );
        },
      });
      if (fallbackData) {
        console.warn(
          `[Health] Using latest health_status.json snapshot after ${mode} health check failure (${reason})`,
        );
        appendHealthSyncRunnerEvent(
          "health_sync_runner_fallback_snapshot",
          {
            run_id: healthSyncRunId,
            mode,
            reason,
            timeout_budget_ms: healthCheckExecTimeoutMs,
            elapsed_ms: Date.now() - runnerStartedAt,
            health_status_sequence: fallbackData?.sync?.sequence ?? null,
          },
          enhancedEnv,
        );
        healthData = broadcastHealthStatusUpdate(fallbackData, {
          mode,
          reason,
          callback,
        });
        return options.requireFreshResult === true ? null : healthData;
      }
      if (callback) callback(null);
      return null;
    }

    console.log("[Health] Health check completed, reading status...");

    // Read updated status
    const data = await readAnnotatedHealthStatusFile(healthStatusFile, {
      mode,
      reason,
      bumpSequence: true,
      requireToggleRevision: true,
      onToggleRevisionRejected: () => {
        scheduleToggleRevisionFollowup = !String(reason).startsWith(
          "toggle-revision-retry:",
        );
      },
    });
    if (data) {
      if (options.requireFreshResult === true) {
        freshResultVerified = verifyFreshHealthRun(
          healthStatusFile,
          data,
          healthSyncRunId,
          mode,
          runnerStartedAt,
          priorStatusMarker,
        );
        if (!freshResultVerified) {
          console.warn(
            `[Health] Rejecting ${mode} result as cleanup proof because the status file was not produced by run ${healthSyncRunId}`,
          );
        }
      }
      healthData = data;
      if (mode === "full" && fullSyncSucceeded) {
        lastFullHealthSyncSuccessAt = Date.now();
        const currentSequence =
          toSequenceNumber(Number(data?.sync?.sequence)) ?? healthStatusSequence;
        trackHealthStatusSequence(currentSequence);
        data.sync = {
          ...buildHealthSyncDiagnostics(),
          sequence: currentSequence,
          last_health_check_mode: mode,
          last_health_check_reason: reason,
        };
        if (data.warnings && typeof data.warnings === "object") {
          data.warnings.sync = data.sync.warnings;
        }
      }
      healthData = broadcastHealthStatusUpdate(data, { mode, reason, callback });
    } else {
      console.warn(
        "[Health] Health status file not found after check completed",
      );
      if (callback) callback(null);
    }
  } catch (error) {
    console.error("[Health] Health check execution error:", error);
    if (callback) callback(null);
  } finally {
    if (activeFullHealthSyncRunId === activeHealthSyncRunId) {
      activeFullHealthSyncStartedAt = 0;
      activeFullHealthSyncRunId = "";
      activeFullHealthSyncMode = null;
      activeFullHealthSyncReason = null;
    }
    // Always release lock
    releaseHealthCheckLock();

    if (scheduleFailureFollowup) {
      appendHealthSyncRunnerEvent(
        "health_sync_runner_queued_retry",
        {
          run_id: activeHealthSyncRunId,
          mode,
          reason,
          timeout_budget_ms: activeHealthSyncTimeoutMs,
          next_mode: "light",
          next_reason: `followup-after-${reason}`,
          delay_ms: HEALTH_CHECK_FAILURE_FOLLOWUP_DELAY_MS,
        },
        activeHealthSyncRunnerEnv,
      );
      setTimeout(() => {
        runHealthCheckAndBroadcast({
          mode: "light",
          reason: `followup-after-${reason}`,
          waitForLock: false,
        });
      }, HEALTH_CHECK_FAILURE_FOLLOWUP_DELAY_MS);
    }
    if (scheduleToggleRevisionFollowup) {
      const retryReason = `toggle-revision-retry:${reason}`;
      appendHealthSyncRunnerEvent(
        "health_sync_runner_toggle_revision_retry",
        {
          run_id: activeHealthSyncRunId,
          mode,
          reason,
          next_mode: "light",
          next_reason: retryReason,
          delay_ms: 1000,
        },
        activeHealthSyncRunnerEnv,
      );
      setTimeout(() => {
        runHealthCheckAndBroadcast({
          mode: "light",
          reason: retryReason,
          waitForLock: false,
        });
      }, 1000);
    }
  }

  return options.requireFreshResult === true && !freshResultVerified
    ? null
    : healthData;
}

async function runStartupCoreHealthGate(options = {}) {
  const timeoutCandidate = Number.parseInt(options.timeoutMs, 10);
  const timeoutMs =
    Number.isFinite(timeoutCandidate) && timeoutCandidate > 0
      ? Math.max(5000, timeoutCandidate)
      : STARTUP_CORE_HEALTH_TIMEOUT_MS;
  const reason = options.reason || "startup-core-gate";

  startupCoreGateAttempted = true;
  startupCoreGateSucceeded = false;

  console.log(
    `[Health] Running startup-core gate (timeout=${timeoutMs}ms, reason=${reason})`,
  );

  let timeoutHandle = null;
  const timeoutPromise = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  let queueFullSyncAfterStartupCore = false;
  const startupCoreRun = runHealthCheckAndBroadcast({
    mode: "startup-core",
    reason,
    waitForLock: true,
    requireFreshResult: options.requireFreshResult === true,
  })
    .then((data) => ({ timedOut: false, data }))
    .finally(() => {
      if (queueFullSyncAfterStartupCore) {
        console.log(
          "[Health] Startup-core runner finished after timeout; queueing debounced full sync",
        );
        queueFullHealthCheck(`startup-core-timeout:${reason}`, {
          immediate: false,
        });
      }
    });

  try {
    const result = await Promise.race([startupCoreRun, timeoutPromise]);

    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }

    if (result.timedOut) {
      console.warn(
        `[Health] Startup-core gate timed out after ${timeoutMs}ms; continuing startup and waiting for the active health run before queueing full sync`,
      );
      queueFullSyncAfterStartupCore = true;
      return {
        success: false,
        timedOut: true,
        timeoutMs,
      };
    }

    if (!result.data) {
      console.warn(
        "[Health] Startup-core gate returned no data; evaluating repair before fallback full sync",
      );
      if (
        lastHealthCheckFailureCode === "TOGGLE_SOURCE_INVALID" &&
        options.retryToggleSourceRepair !== false
      ) {
        console.warn(
          "[Health] Startup-core failed because mcp_toggles.json was invalid; repairing and retrying startup-core once",
        );
        try {
          try {
            ensureMcpDisableModesSourceReady(`startup-core-retry:${reason}`);
          } catch (modeError) {
            console.warn(
              `[Health] Could not normalize mcp_disable_modes.json during startup-core retry: ${modeError.message}`,
            );
          }
          ensureMcpToggleSourceReady(`startup-core-retry:${reason}`);
          const retryData = await runHealthCheckAndBroadcast({
            mode: "startup-core",
            reason: `${reason}:toggle-source-retry`,
            waitForLock: true,
            requireFreshResult: options.requireFreshResult === true,
          });
          if (retryData) {
            startupCoreGateSucceeded = true;
            console.log("[Health] Startup-core gate completed successfully after toggle-source repair");
            return {
              success: true,
              timedOut: false,
              timeoutMs,
              data: retryData,
              repairedToggleSource: true,
            };
          }
        } catch (repairError) {
          console.warn(
            `[Health] Startup-core toggle-source repair retry failed: ${repairError.message}`,
          );
        }
      }
      queueFullHealthCheck(`startup-core-failed:${reason}`, {
        immediate: false,
      });
      return {
        success: false,
        timedOut: false,
        timeoutMs,
        error: "startup-core check returned no data",
      };
    }

    startupCoreGateSucceeded = true;
    console.log("[Health] Startup-core gate completed successfully");
    return {
      success: true,
      timedOut: false,
      timeoutMs,
      data: result.data,
    };
  } catch (error) {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    console.error("[Health] Startup-core gate failed:", error);
    queueFullHealthCheck(`startup-core-error:${reason}`, { immediate: false });
    return {
      success: false,
      timedOut: false,
      timeoutMs,
      error: error.message,
    };
  }
}

function scheduleOnDemandFullHealth(delayMs) {
  const normalizedDelay = Math.max(0, Number(delayMs) || 0);
  if (onDemandFullHealthTimer) {
    return;
  }

  onDemandFullHealthTimer = setTimeout(() => {
    onDemandFullHealthTimer = null;
    void flushOnDemandFullHealth();
  }, normalizedDelay);
}

async function flushOnDemandFullHealth() {
  if (onDemandFullHealthInFlight) {
    scheduleOnDemandFullHealth(ON_DEMAND_FULL_HEALTH_DEBOUNCE_MS);
    return;
  }

  if (onDemandFullHealthReasons.size === 0) {
    return;
  }

  const now = Date.now();
  if (lastOnDemandFullHealthSuccessAt > 0) {
    const elapsedSinceSuccess = now - lastOnDemandFullHealthSuccessAt;
    if (elapsedSinceSuccess < ON_DEMAND_FULL_HEALTH_MIN_INTERVAL_MS) {
      const remaining = ON_DEMAND_FULL_HEALTH_MIN_INTERVAL_MS - elapsedSinceSuccess;
      console.log(
        `[Health] Delaying queued full health check for ${Math.ceil(remaining / 1000)}s to avoid excessive load`,
      );
      scheduleOnDemandFullHealth(remaining);
      return;
    }
  }

  const reasons = Array.from(onDemandFullHealthReasons);
  const queuedAtSnapshot = firstOnDemandFullHealthQueuedAt || Date.now();
  onDemandFullHealthReasons.clear();
  firstOnDemandFullHealthQueuedAt = 0;
  const reasonSummary = reasons.slice(0, 6).join(",");
  const reason =
    reasonSummary.length > 0
      ? `on-demand:${reasonSummary}`
      : "on-demand:unspecified";

  onDemandFullHealthInFlight = true;
  try {
    const result = await runHealthCheckAndBroadcast({
      mode: "full",
      reason,
      waitForLock: true,
    });

    if (result) {
      lastOnDemandFullHealthSuccessAt = Date.now();
      onDemandFullHealthRetryCount = 0;
    } else {
      const retryPlan = buildQueuedFullHealthRetryPlan({
        retryCount: onDemandFullHealthRetryCount,
      });
      if (retryPlan.shouldRetry) {
        console.warn(
          `[Health] Queued full health check returned no data (${reason}); scheduling retry ${retryPlan.retryCount}/${ON_DEMAND_FULL_HEALTH_MAX_RETRIES}`,
        );
        firstOnDemandFullHealthQueuedAt = queuedAtSnapshot;
        onDemandFullHealthRetryCount = retryPlan.retryCount;
        retryPlan.nextReasons.forEach((nextReason) =>
          onDemandFullHealthReasons.add(nextReason),
        );
      } else {
        console.warn(
          `[Health] Queued full health check returned no data (${reason}); dropping further retries after ${onDemandFullHealthRetryCount}/${ON_DEMAND_FULL_HEALTH_MAX_RETRIES} attempts`,
        );
        onDemandFullHealthRetryCount = 0;
        setTimeout(() => {
          void runHealthCheckAndBroadcast({
            mode: "light",
            reason: `followup-after-${reason}`,
            waitForLock: false,
          });
        }, 1000);
      }
    }
  } catch (error) {
    const retryPlan = buildQueuedFullHealthRetryPlan({
      retryCount: onDemandFullHealthRetryCount,
    });
    console.error(
      `[Health] Queued full health check failed (${reason}):`,
      error,
    );
    if (retryPlan.shouldRetry) {
      firstOnDemandFullHealthQueuedAt = queuedAtSnapshot;
      onDemandFullHealthRetryCount = retryPlan.retryCount;
      retryPlan.nextReasons.forEach((nextReason) =>
        onDemandFullHealthReasons.add(nextReason),
      );
    } else {
      console.warn(
        `[Health] Dropping queued full health retries after ${onDemandFullHealthRetryCount}/${ON_DEMAND_FULL_HEALTH_MAX_RETRIES} attempts`,
      );
      onDemandFullHealthRetryCount = 0;
      setTimeout(() => {
        void runHealthCheckAndBroadcast({
          mode: "light",
          reason: `followup-after-${reason}`,
          waitForLock: false,
        });
      }, 1000);
    }
  } finally {
    onDemandFullHealthInFlight = false;
    if (onDemandFullHealthReasons.size > 0) {
      scheduleOnDemandFullHealth(ON_DEMAND_FULL_HEALTH_RETRY_DELAY_MS);
    }
  }
}

function queueFullHealthCheck(reason = "manual", options = {}) {
  if (onDemandFullHealthReasons.size === 0) {
    firstOnDemandFullHealthQueuedAt = Date.now();
  }
  onDemandFullHealthReasons.add(String(reason || "manual"));
  if (String(reason || "manual") !== "retry-on-demand") {
    onDemandFullHealthRetryCount = 0;
  }

  if (options.immediate === true) {
    if (onDemandFullHealthTimer) {
      clearTimeout(onDemandFullHealthTimer);
      onDemandFullHealthTimer = null;
    }
    appendHealthSyncRunnerEvent("health_sync_runner_queued_retry", {
      mode: "full",
      reason: String(reason || "manual"),
      next_mode: "full",
      immediate: true,
      queued_reason_count: onDemandFullHealthReasons.size,
    });
    void flushOnDemandFullHealth();
    return;
  }

  appendHealthSyncRunnerEvent("health_sync_runner_queued_retry", {
    mode: "full",
    reason: String(reason || "manual"),
    next_mode: "full",
    delay_ms: ON_DEMAND_FULL_HEALTH_DEBOUNCE_MS,
    queued_reason_count: onDemandFullHealthReasons.size,
  });
  scheduleOnDemandFullHealth(ON_DEMAND_FULL_HEALTH_DEBOUNCE_MS);
}

function isEligibleForAutoHeal(serverId, serverInfo) {
  if (!serverId || !serverInfo) return false;
  if (!AUTO_HEAL_FAILURE_STATUSES.has(serverInfo.status)) return false;
  if (serverInfo.disabled_by_user === true) return false;
  if (serverInfo.configured === false) return false;

  const oauthState = String(serverInfo.oauth_state || "").toLowerCase();
  if (oauthState && AUTO_HEAL_OAUTH_STATES.has(oauthState)) return false;

  return true;
}

function scheduleAutoHealFromHealthStatus(healthStatus, context = {}) {
  if (AUTO_HEAL_MAX_RETRIES_PER_SERVER <= 0) return;
  if (!healthStatus?.servers) return;

  const knownServerIds = discoverInstalledMcpServerIds(getProjectRoot(), {
    logger: console,
  });
  const entries = Object.entries(healthStatus.servers);
  const candidates = [];
  for (const [serverId, serverInfo] of entries) {
    if (knownServerIds.size > 0 && !knownServerIds.has(serverId)) continue;
    if (!isEligibleForAutoHeal(serverId, serverInfo)) continue;
    if (
      serverInfo?.deployment === "host" &&
      isHostMcpoStartupPending(state.hostMcpo)
    ) {
      continue;
    }

    const attempts = autoHealAttemptsByServer.get(serverId) || 0;
    if (attempts >= AUTO_HEAL_MAX_RETRIES_PER_SERVER) continue;

    const now = Date.now();
    const lastAttemptAt = autoHealLastAttemptAtByServer.get(serverId) || 0;
    if (now - lastAttemptAt < AUTO_HEAL_COOLDOWN_MS) continue;
    if (autoHealInProgressServers.has(serverId)) continue;

    const nextAttempt = attempts + 1;
    candidates.push({ serverId, serverInfo, nextAttempt, attemptedAt: now });
  }

  const restartGroups = buildAutoHealRestartGroups(candidates);
  for (const group of restartGroups) {
    for (const candidate of group.candidates) {
      autoHealAttemptsByServer.set(candidate.serverId, candidate.nextAttempt);
      autoHealLastAttemptAtByServer.set(
        candidate.serverId,
        candidate.attemptedAt,
      );
      autoHealInProgressServers.add(candidate.serverId);
    }

    setTimeout(async () => {
      try {
        if (group.kind === "host") {
          console.log(
            `[AutoHeal] Restarting host-mcpo for ${group.serverIds.length} host server(s): ${group.serverIds.join(", ")} (reason=${context.reason || "scheduled"})`,
          );
          await stopHostMcpo();
          const restartResult = await startHostMcpo();
          if (!restartResult?.success) {
            console.error(
              `[AutoHeal] Restart failed for host servers ${group.serverIds.join(", ")}: ${restartResult?.error || "unknown error"}`,
            );
          } else {
            console.log(
              `[AutoHeal] Restart succeeded for host servers: ${group.serverIds.join(", ")}`,
            );
          }
        } else {
          const candidate = group.candidates[0];
          console.log(
            `[AutoHeal] Restarting ${candidate.serverId} (attempt ${candidate.nextAttempt}/${AUTO_HEAL_MAX_RETRIES_PER_SERVER}, status=${candidate.serverInfo.status}, reason=${context.reason || "scheduled"})`,
          );

          const restartResult = await restartMcpoServer(candidate.serverId);
          if (!restartResult?.success) {
            console.error(
              `[AutoHeal] Restart failed for ${candidate.serverId}: ${restartResult?.error || "unknown error"}`,
            );
          } else {
            console.log(
              `[AutoHeal] Restart succeeded for ${candidate.serverId}`,
            );
          }
        }

        await runHealthCheckAndBroadcast({
          mode: "light",
          reason:
            group.kind === "host"
              ? `auto-heal:host:${group.serverIds.join(",")}`
              : `auto-heal:${group.serverIds[0]}`,
          waitForLock: true,
        });
      } catch (error) {
        if (group.kind === "host") {
          console.error(
            `[AutoHeal] Error while healing host servers ${group.serverIds.join(", ")}:`,
            error,
          );
        } else {
          console.error(
            `[AutoHeal] Error while healing ${group.serverIds[0]}:`,
            error,
          );
        }
      } finally {
        for (const candidate of group.candidates) {
          autoHealInProgressServers.delete(candidate.serverId);
        }
      }
    }, 0);
  }
}

/**
 * Run rapid consecutive health checks while servers are starting
 * This provides faster feedback during server initialization
 */
function runRapidHealthChecks() {
  if (rapidCheckInProgress) {
    console.log("[Health] Rapid checks already in progress");
    return;
  }

  rapidCheckInProgress = true;

  // Pause the 60-second interval during rapid checking
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
    console.log("[Health] Paused 60-second interval for rapid checking");
  }

  const checkAndContinue = () => {
    console.log("[Health] Running rapid health check...");

    runHealthCheckAndBroadcast({ mode: "light", reason: "rapid", callback: (data) => {
      if (!data || !data.summary) {
        console.log(
          `[Health] Rapid check returned no health data (lock busy or transient failure), backing off for ${Math.ceil(RAPID_HEALTH_LOCK_BUSY_BACKOFF_MS / 1000)} seconds`,
        );
        rapidCheckTimeoutId = setTimeout(
          checkAndContinue,
          RAPID_HEALTH_LOCK_BUSY_BACKOFF_MS,
        );
        return;
      }

      // Check if any servers are still starting
      const startingCount = getRapidHealthStartingCount(data);

      if (startingCount > 0) {
        console.log(
          `[Health] ${startingCount} server(s) still starting, will re-check in ${Math.ceil(RAPID_HEALTH_STARTING_RECHECK_MS / 1000)} seconds`,
        );
        rapidCheckTimeoutId = setTimeout(
          checkAndContinue,
          RAPID_HEALTH_STARTING_RECHECK_MS,
        );
      } else {
        console.log("[Health] No servers starting, resuming normal interval");
        rapidCheckInProgress = false;
        rapidCheckTimeoutId = null;
        startContinuousHealthChecks(); // Resume normal 60-second interval
      }
    }});
  };

  // Start rapid checking
  checkAndContinue();
}

/**
 * Stop rapid health checks (used for cleanup)
 */
function stopRapidHealthChecks() {
  if (rapidCheckTimeoutId) {
    clearTimeout(rapidCheckTimeoutId);
    rapidCheckTimeoutId = null;
  }
  rapidCheckInProgress = false;
  console.log("[Health] Stopped rapid health checks");
}

/**
 * Start continuous health checks
 */
function startContinuousHealthChecks() {
  if (healthCheckInterval) {
    console.log("[Health] Health monitoring already running");
    return;
  }

  console.log(
    `[Health] Starting continuous health checks (every ${LIGHT_HEALTH_CHECK_INTERVAL_MS}ms, full sync every ${FULL_HEALTH_SYNC_INTERVAL_MS}ms)`,
  );

  // Prime startup state with startup-core once (if not already done during loading),
  // then force immediate startup auto check (which will run full for initial cycles).
  (async () => {
    if (STARTUP_HEALTH_PRIME_ENABLED && !startupCoreGateAttempted) {
      startupCoreGateAttempted = true;
      const startupPrime = await runHealthCheckAndBroadcast({
        mode: "startup-core",
        reason: "startup-prime",
        waitForLock: true,
      });
      startupCoreGateSucceeded = !!startupPrime;
    } else if (startupCoreGateAttempted) {
      console.log(
        `[Health] Startup prime already attempted during loading (success=${startupCoreGateSucceeded}), skipping duplicate startup-core prime`,
      );
    }

    await runHealthCheckAndBroadcast({
      mode: "auto",
      reason: "startup",
      waitForLock: true,
    });
  })();

  // Then set up interval for subsequent checks
  healthCheckInterval = setInterval(() => {
    runHealthCheckAndBroadcast({ mode: "auto", reason: "scheduled" });
  }, LIGHT_HEALTH_CHECK_INTERVAL_MS);

  console.log("[Health] Health monitoring interval set up successfully");
}

/**
 * Stop continuous health checks
 */
function stopContinuousHealthChecks() {
  // Also stop rapid checks if in progress
  stopRapidHealthChecks();

  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
    console.log("[Health] Stopped continuous health checks");
  }
}

/**
 * Get last health status
 */
function getLastHealthStatus() {
  if (!lastHealthStatus) return null;
  return annotateHealthSyncDiagnostics(lastHealthStatus);
}

// ============================================================================
// DOCKER HELPERS
// ============================================================================

/**
 * Ensure required volume files exist
 */
function ensureVolumeFilesExist() {
  const PROJECT_ROOT = getProjectRoot();
  console.log("Ensuring required volume mount files exist...");

  const requiredFiles = [
    ".env",
    "HOST_MODE",
    "mcp_toggles.json",
    "mcp_config.json",
    "mcp_config_advanced.json",
    "mcp_config_core.json",
    "mcp_config_host_sideload.json",
    "mcp_tools_config.json",
    "marketplaces.json",
  ];

  requiredFiles.forEach((file) => {
    const filePath = path.join(PROJECT_ROOT, file);
    try {
      // Self-healing: Check if path exists as directory
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        if (stats.isDirectory()) {
          console.warn(
            `Found directory instead of file: ${file} - removing...`,
          );
          fs.rmSync(filePath, { recursive: true, force: true });
          console.log(`Removed directory: ${file}`);
        }
      }

      // Create file if it doesn't exist
      if (!fs.existsSync(filePath)) {
        if (file === "HOST_MODE") {
          fs.writeFileSync(filePath, "FALSE\n", "utf8");
        } else if (file.endsWith(".json")) {
          fs.writeFileSync(filePath, "{}\n", "utf8");
        } else {
          fs.closeSync(fs.openSync(filePath, "a"));
        }
        console.log(`Created missing file: ${file}`);
      }
    } catch (error) {
      console.error(`Failed to process ${file}:`, error.message);
    }
  });
}

/**
 * Poll docker info until Docker becomes ready or the timeout expires.
 */
async function waitForDockerReady({
  projectRoot = getProjectRoot(),
  timeoutMs = ORBSTACK_DOCKER_STARTUP_TIMEOUT_MS,
  intervalMs = ORBSTACK_DOCKER_POLL_INTERVAL_MS,
  progressIntervalMs = ORBSTACK_DOCKER_PROGRESS_LOG_INTERVAL_MS,
  onProgress = null,
} = {}) {
  const deadlineMs = Date.now() + timeoutMs;
  let nextProgressMs = progressIntervalMs;

  while (true) {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      return false;
    }

    const probe = await probeDockerDaemon({
      projectRoot,
      timeoutMs: Math.min(DOCKER_INFO_PROBE_TIMEOUT_MS, remainingMs),
    });
    if (probe.ready) {
      return true;
    }

    const elapsedMs = timeoutMs - Math.max(0, deadlineMs - Date.now());
    while (
      typeof onProgress === "function" &&
      nextProgressMs < timeoutMs &&
      elapsedMs >= nextProgressMs
    ) {
      onProgress({
        elapsedMs: nextProgressMs,
        elapsedSeconds: Math.floor(nextProgressMs / 1000),
        timeoutMs,
        error: probe.error,
        probe,
      });
      nextProgressMs += progressIntervalMs;
    }

    const sleepMs = Math.min(intervalMs, Math.max(0, deadlineMs - Date.now()));
    if (sleepMs > 0) {
      await sleep(sleepMs);
    }
  }
}

function summarizeDockerCommandError(error) {
  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
  if (stderr) {
    return stderr.replace(/\s+/g, " ");
  }

  const stdout = typeof error?.stdout === "string" ? error.stdout.trim() : "";
  if (stdout) {
    return stdout.replace(/\s+/g, " ");
  }

  if (typeof error?.message === "string" && error.message.trim()) {
    return error.message.trim();
  }

  return "Unknown error";
}

function isDockerCommandTimedOut(error) {
  if (!error || typeof error !== "object") {
    return false;
  }

  return (
    error.killed === true ||
    /timed out|ETIMEDOUT/i.test(String(error.message || "")) ||
    error.code === "ETIMEDOUT"
  );
}

async function probeDockerDaemon({
  projectRoot = getProjectRoot(),
  timeoutMs = DOCKER_INFO_PROBE_TIMEOUT_MS,
} = {}) {
  const boundedTimeoutMs = Math.max(1000, Number(timeoutMs) || DOCKER_INFO_PROBE_TIMEOUT_MS);

  try {
    await execPromise("docker info", {
      cwd: projectRoot,
      timeout: boundedTimeoutMs,
    });
    return {
      ready: true,
      timedOut: false,
      error: null,
      message: "",
    };
  } catch (error) {
    const timedOut = isDockerCommandTimedOut(error);
    return {
      ready: false,
      timedOut,
      error,
      message: timedOut
        ? `docker info timed out after ${Math.max(1, Math.round(boundedTimeoutMs / 1000))}s`
        : summarizeDockerCommandError(error),
    };
  }
}

function emitOrbStackRestartLog(onLog, message, type = "info") {
  if (typeof onLog === "function") {
    onLog(message, type);
  }
}

function emitOrbStackRestartStatus(onStatus, message, meta = {}) {
  if (typeof onStatus === "function") {
    onStatus(message, meta);
  }
}

function resolveOrbStackAppPath() {
  if (fs.existsSync(ORBSTACK_SYSTEM_APP_PATH)) {
    return ORBSTACK_SYSTEM_APP_PATH;
  }
  if (fs.existsSync(ORBSTACK_USER_APP_PATH)) {
    return ORBSTACK_USER_APP_PATH;
  }
  return null;
}

async function openOrbStackHidden(appPath, { cwd, timeout } = {}) {
  if (!appPath) {
    throw new Error("OrbStack is not installed.");
  }
  await execFilePromise("/usr/bin/open", ["-g", "-j", appPath], {
    cwd,
    timeout,
  });
}

async function restartOrbStackAndWaitForDocker({
  projectRoot = getProjectRoot(),
  onLog = null,
  onStatus = null,
} = {}) {
  if (process.platform !== "darwin") {
    return {
      success: false,
      error: "OrbStack restart is only supported on macOS.",
      method: null,
    };
  }

  const orbStackAppPath = resolveOrbStackAppPath();
  if (!orbStackAppPath) {
    return {
      success: false,
      error: "OrbStack is not installed.",
      method: null,
    };
  }

  let method = "orbctl";
  emitOrbStackRestartStatus(onStatus, "Restarting OrbStack...", {
    phase: "restart-orbstack",
    step: "restart",
  });

  try {
    emitOrbStackRestartLog(onLog, "Stopping OrbStack...", "info");
    await execPromise("orbctl stop", {
      cwd: projectRoot,
      timeout: ORBSTACK_RESTART_COMMAND_TIMEOUT_MS,
    });
    await sleep(3000);
    emitOrbStackRestartLog(onLog, "Starting OrbStack...", "info");
    await execPromise("orbctl start", {
      cwd: projectRoot,
      timeout: ORBSTACK_RESTART_COMMAND_TIMEOUT_MS,
    });
  } catch (error) {
    method = "app";
    emitOrbStackRestartLog(
      onLog,
      `OrbStack CLI restart unavailable; falling back to app restart (${summarizeDockerCommandError(error)})`,
      "warning",
    );

    try {
      await execPromise(`osascript -e 'quit app "OrbStack"'`, {
        cwd: projectRoot,
        timeout: ORBSTACK_RESTART_COMMAND_TIMEOUT_MS,
      });
    } catch (quitError) {
      emitOrbStackRestartLog(
        onLog,
        `OrbStack app quit returned before a clean shutdown (${summarizeDockerCommandError(quitError)})`,
        "warning",
      );
    }

    await sleep(3000);
    emitOrbStackRestartLog(onLog, "Starting OrbStack...", "info");
    await openOrbStackHidden(orbStackAppPath, {
      cwd: projectRoot,
      timeout: ORBSTACK_RESTART_COMMAND_TIMEOUT_MS,
    });
  }

  emitOrbStackRestartLog(onLog, "Waiting for OrbStack to be ready...", "info");
  emitOrbStackRestartStatus(onStatus, "Waiting for OrbStack to initialize Docker...", {
    phase: "restart-orbstack",
    step: "wait-docker",
  });

  const dockerReady = await waitForDockerReady({
    projectRoot,
    onProgress: ({ elapsedSeconds }) => {
      emitOrbStackRestartLog(
        onLog,
        `Still waiting for Docker to initialize... (${elapsedSeconds}s)`,
        "info",
      );
    },
  });

  if (!dockerReady) {
    return {
      success: false,
      error: `Docker did not become ready within ${ORBSTACK_DOCKER_STARTUP_TIMEOUT_LABEL}`,
      method,
    };
  }

  return {
    success: true,
    error: null,
    method,
  };
}

/**
 * Check and start OrbStack if needed
 */
async function ensureDockerRunning(options = {}) {
  const PROJECT_ROOT = getProjectRoot();
  const { promptUser = true, onLog = null, onStatus = null } = options;

  const probe = await probeDockerDaemon({ projectRoot: PROJECT_ROOT });
  if (probe.ready) {
    console.log("Docker is already running");
    return true;
  }

  console.log("Docker is not running, checking for Docker runtime...");

  if (state.windows.loading && !state.windows.loading.isDestroyed()) {
    safeWebContentsSend(
      state.windows.loading,
      "loading-status",
      "Docker not running, preparing to start...",
      {
        tag: "docker-startup-status",
        meta: { phase: "ensure-docker-running", step: "prepare-start" },
      },
    );
    sendInitLog("Docker is not running\n", "warning");
  }
  emitOrbStackRestartStatus(onStatus, "Docker not running, preparing to start...", {
    phase: "ensure-docker-running",
    step: "prepare-start",
    probe,
  });
  emitOrbStackRestartLog(onLog, "Docker is not running", "warning");

  const orbStackAppPath = resolveOrbStackAppPath();
  if (orbStackAppPath) {
    try {
      if (promptUser) {
        await dialog.showMessageBox(
          state.windows.loading || null,
          {
            type: "warning",
            title: "Docker Not Running",
            message: "Docker is not running and needs to be started",
            detail:
              'We will start OrbStack to provide Docker services.\n\nIMPORTANT: If OrbStack or Docker prompts you to update, please click "Later" or "Skip".',
            buttons: ["OK"],
            defaultId: 0,
            icon: getThemeIcon(),
            noLink: true,
          },
        );
      }

      sendInitLog("Starting OrbStack...\n", "info");
      emitOrbStackRestartLog(onLog, "Starting OrbStack...", "info");
      await openOrbStackHidden(orbStackAppPath, {
        cwd: PROJECT_ROOT,
        timeout: ORBSTACK_RESTART_COMMAND_TIMEOUT_MS,
      });
      console.log("Started OrbStack, waiting for Docker to be ready...");

      if (state.windows.loading && !state.windows.loading.isDestroyed()) {
        safeWebContentsSend(
          state.windows.loading,
          "loading-status",
          "Waiting for OrbStack to initialize Docker...",
          {
            tag: "docker-startup-status",
            meta: { phase: "ensure-docker-running", step: "wait-orbstack" },
          },
        );
      }
      emitOrbStackRestartStatus(onStatus, "Waiting for OrbStack to initialize Docker...", {
        phase: "ensure-docker-running",
        step: "wait-orbstack",
      });

      const dockerReady = await waitForDockerReady({
        projectRoot: PROJECT_ROOT,
        onProgress: ({ elapsedSeconds }) => {
          const message = `Still waiting for Docker to initialize... (${elapsedSeconds}s)`;
          sendInitLog(`${message}\n`, "info");
          emitOrbStackRestartLog(onLog, message, "info");
        },
      });
      if (dockerReady) {
        console.log("Docker is now ready!");
        sendInitLog(
          "OrbStack started successfully, Docker is ready!\n",
          "success",
        );
        emitOrbStackRestartLog(
          onLog,
          "OrbStack started successfully, Docker is ready!",
          "success",
        );
        return true;
      }

      sendInitLog(
        `OrbStack failed to start Docker within ${ORBSTACK_DOCKER_STARTUP_TIMEOUT_LABEL}\n`,
        "error",
      );
      emitOrbStackRestartLog(
        onLog,
        `OrbStack failed to start Docker within ${ORBSTACK_DOCKER_STARTUP_TIMEOUT_LABEL}`,
        "error",
      );
      return false;
    } catch (err) {
      console.error("Failed to start OrbStack:", err);
      sendInitLog(`Failed to start OrbStack: ${err.message}\n`, "error");
      emitOrbStackRestartLog(
        onLog,
        `Failed to start OrbStack: ${summarizeDockerCommandError(err)}`,
        "error",
      );
      return false;
    }
  }

  console.error("OrbStack is not installed");
  sendInitLog("OrbStack is not installed\n", "error");
  sendInitLog(
    "Please install OrbStack from https://orbstack.dev\n",
    "info",
  );
  emitOrbStackRestartLog(onLog, "OrbStack is not installed", "error");

  if (promptUser) {
    await dialog.showMessageBox(state.windows.loading || null, {
      type: "error",
      title: "OrbStack Not Found",
      message: "OrbStack is required but not installed",
      detail:
        "Please install OrbStack from https://orbstack.dev and restart this application.",
      buttons: ["OK"],
      defaultId: 0,
      icon: getThemeIcon(),
      noLink: true,
    });
  }

  return false;
}

/**
 * Execute command with streaming logs
 * @param {string} command - Command to execute
 * @param {string[]} args - Command arguments
 * @param {number} timeout - Timeout in milliseconds
 * @param {Object} options - Additional options
 * @param {boolean} options.bufferUICheck - If true, buffer Phase 2 (UI check) output
 *   and show only summary on success, or full output on failure
 * @param {boolean} options.isolateProcessGroup - PORTICO-373: spawn the child in its own
 *   process group and terminate the GROUP on timeout/abort. Off by default, so the
 *   dozen callers that never needed it keep byte-identical behaviour: a detached
 *   child is not killed with the parent and does not receive parent-group signals,
 *   which is a real behaviour change and should only apply where it earns its risk.
 *   Opt in when the command spawns work of its own that must not outlive the
 *   timeout -- `docker-compose.sh stop` runs `docker compose down` as a grandchild,
 *   and killing only the `bash -c` leader left that running.
 * @param {number} options.confirmTreeExitMs - PORTICO-373: when > 0, a timeout/abort does
 *   not settle until the child's process group is provably gone (or this window
 *   expires). Requires isolateProcessGroup; without it there is no group to confirm.
 *   Callers whose next step must not run concurrently with the dying command opt in.
 */
function executeWithStreaming(command, args = [], timeout = 60000, options = {}) {
  const PROJECT_ROOT = getProjectRoot();
  const {
    bufferUICheck = false,
    signal = null,
    isolateProcessGroup = false,
    confirmTreeExitMs = 0,
  } = options;
  // Asking to confirm group exit implies wanting a group: otherwise the option
  // would be a silent no-op, which is a worse API than one flag too few.
  const groupIsolated =
    (isolateProcessGroup || confirmTreeExitMs > 0) &&
    process.platform !== "win32";

  return new Promise((resolve, reject) => {
    // Ensure Docker is in PATH
    const enhancedEnv = createEnhancedEnv({
      FORCE_COLOR: "1",
      TERM: "xterm-256color",
    });

    // PORTICO-373: `detached` puts the child in its own process group so termination
    // can reach the whole tree. Without it the only killable thing is the `bash
    // -c` leader, and the command that actually matters -- e.g. `docker compose
    // down` -- is a grandchild that survives, keeps mutating container state, and
    // is reparented to init while we report "Command timed out" as though the
    // command were over.
    //
    // Deliberately opt-in rather than the default. Detaching changes two things
    // for every caller -- the child no longer dies with the parent, and no longer
    // sees signals aimed at the parent's group -- so it is applied only where a
    // surviving grandchild is a known hazard.
    const child = spawn("bash", ["-c", `${command} ${args.join(" ")}`], {
      cwd: PROJECT_ROOT,
      env: enhancedEnv,
      ...(groupIsolated ? { detached: true } : {}),
    });

    let output = "";
    let errorOutput = "";
    let timeoutId = null;
    let pendingDots = "";
    let waitingForHealthy = false;
    let settled = false;
    // Deliberately NOT cleared when the promise settles or the leader closes:
    // the escalation to SIGKILL is a backstop for descendants that outlive the
    // leader, and cancelling it on close is exactly how a "terminated" command
    // keeps running. A no-op ESRCH is the harmless case.
    let forceKillId = null;

    // Phase 2 (UI check) buffering state - for intelligent error hiding
    let uiCheckBuffer = [];       // Buffer for UI check output
    let inUICheckPhase = false;   // Track which phase we're in
    let lastAttemptNum = 0;       // Track retry attempts for summary message

    const cleanupAbortListener = () => {
      if (signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", handleAbort);
      }
    };

    const resolveOnce = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      cleanupAbortListener();
      resolve(result);
    };

    const rejectOnce = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      cleanupAbortListener();
      reject(error);
    };

    // Terminate the whole group, escalating to SIGKILL, so a command that ignores
    // SIGTERM cannot outlive the timeout that claims to have ended it.
    const terminateTree = () => {
      if (!groupIsolated) {
        // Non-isolated callers keep the pre-PORTICO-373 behaviour verbatim. Signalling
        // a negated pid here would aim at a process group we never created.
        child.kill("SIGTERM");
        return;
      }
      if (!forceKillId) {
        forceKillId = terminateProcessTree(child, {
          signalTree: signalProcessTree,
          graceMs: TREE_TERMINATION_GRACE_MS,
        });
      }
    };

    // Settle now, or (opt-in) once the group is provably gone. The polling form
    // exists for callers whose very next action must not race the dying command.
    const settleAfterTermination = (result) => {
      if (!groupIsolated) {
        resolveOnce(result);
        return;
      }
      if (confirmTreeExitMs <= 0) {
        resolveOnce({ ...result, treeExited: processTreeIsGone(child.pid) });
        return;
      }

      waitForTreeExit(child.pid, {
        timeoutMs: confirmTreeExitMs,
        pollIntervalMs: TREE_EXIT_POLL_INTERVAL_MS,
      }).then((gone) => {
        resolveOnce({ ...result, treeExited: gone });
      });
    };

    function handleAbort() {
      terminateTree();
      settleAfterTermination({
        success: false,
        output,
        error: "Command aborted",
        code: -2,
        aborted: true,
      });
    }

    if (signal && typeof signal.addEventListener === "function") {
      if (signal.aborted) {
        handleAbort();
      } else {
        signal.addEventListener("abort", handleAbort, { once: true });
      }
    }

    if (timeout > 0) {
      timeoutId = setTimeout(() => {
        terminateTree();
        settleAfterTermination({
          success: false,
          output,
          error: "Command timed out",
          code: -1,
          timedOut: true,
        });
      }, timeout);
    }

    child.stdout.on("data", (data) => {
      const text = data.toString();
      output += text;

      // Always log to file (for debugging - unchanged)
      logToInitFile(text, "info");

      if (state.windows.loading && !state.windows.loading.isDestroyed()) {
        // Phase 2 (UI check) buffering logic - hide transient errors on success
        if (bufferUICheck) {
          // Detect transition to UI check phase
          if (text.includes("Checking Open WebUI UI Readiness")) {
            inUICheckPhase = true;
          }

          if (inUICheckPhase) {
            // Buffer this output instead of displaying immediately
            uiCheckBuffer.push({ text, type: "info" });

            // Track attempt count for summary message
            const attemptMatch = text.match(/Attempt (\d+)\/20/);
            if (attemptMatch) {
              lastAttemptNum = parseInt(attemptMatch[1]);
            }
            return;  // Skip sending to loading screen until we know the outcome
          }
        }

        // Phase 1 and non-buffered mode: display immediately (existing logic)
        if (text.includes("Waiting for services to become healthy...")) {
          waitingForHealthy = true;
          safeWebContentsSend(
            state.windows.loading,
            "loading-log",
            {
              text: text.replace("\n", " "),
              type: "info",
            },
            {
              tag: "init-stream-log",
              meta: { phase: "stdout", mode: "healthy-waiting" },
            },
          );
        } else if (waitingForHealthy && text.trim() === ".") {
          pendingDots += ".";
          safeWebContentsSend(
            state.windows.loading,
            "loading-log-append",
            {
              text: ".",
              type: "info",
            },
            {
              tag: "init-stream-log",
              meta: { phase: "stdout", mode: "healthy-waiting-dot" },
            },
          );
        } else if (waitingForHealthy && text.trim() === "") {
          if (pendingDots) {
            safeWebContentsSend(
              state.windows.loading,
              "loading-log",
              {
                text: "\n",
                type: "info",
              },
              {
                tag: "init-stream-log",
                meta: { phase: "stdout", mode: "healthy-waiting-newline" },
              },
            );
            waitingForHealthy = false;
            pendingDots = "";
          }
        } else {
          if (waitingForHealthy && pendingDots) {
            waitingForHealthy = false;
            pendingDots = "";
          }
          safeWebContentsSend(
            state.windows.loading,
            "loading-log",
            {
              text: text,
              type: "info",
            },
            {
              tag: "init-stream-log",
              meta: { phase: "stdout", mode: "default" },
            },
          );
        }
      }
    });

    child.stderr.on("data", (data) => {
      const text = data.toString();
      errorOutput += text;

      const isError =
        text.toLowerCase().includes("error") ||
        text.toLowerCase().includes("failed");

      // Always log to file (for debugging - unchanged)
      logToInitFile(text, isError ? "error" : "info");

      if (state.windows.loading && !state.windows.loading.isDestroyed()) {
        // Buffer stderr in Phase 2 (UI check) too
        if (bufferUICheck && inUICheckPhase) {
          uiCheckBuffer.push({ text, type: isError ? "error" : "info" });
          return;  // Skip sending to loading screen until we know the outcome
        }

        // Phase 1 and non-buffered mode: display immediately (unchanged)
        safeWebContentsSend(
          state.windows.loading,
          "loading-log",
          {
            text: text,
            type: isError ? "error" : "info",
          },
          {
            tag: "init-stream-log",
            meta: { phase: "stderr", isError },
          },
        );
      }
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }

      // Handle buffered UI check output - intelligent error hiding
      if (bufferUICheck && uiCheckBuffer.length > 0) {
        if (state.windows.loading && !state.windows.loading.isDestroyed()) {
          if (code === 0) {
            // SUCCESS: Show clean summary only (hide transient errors)
            const summaryMsg = lastAttemptNum > 1
              ? `\n✅ Open WebUI UI is ready (after ${lastAttemptNum} attempts)\n`
              : `\n✅ Open WebUI UI is ready\n`;
            safeWebContentsSend(
              state.windows.loading,
              "loading-log",
              {
                text: summaryMsg,
                type: "success",
              },
              {
                tag: "ui-readiness-summary",
                meta: { success: true, attempts: lastAttemptNum || 1 },
              },
            );
          } else {
            // FAILURE: Flush ALL buffered output for debugging
            uiCheckBuffer.forEach(entry => {
              safeWebContentsSend(
                state.windows.loading,
                "loading-log",
                entry,
                {
                  tag: "ui-readiness-buffer-flush",
                  meta: { success: false },
                },
              );
            });
          }
        }
      }

      if (code === 0) {
        resolveOnce({ success: true, output, error: errorOutput });
      } else {
        resolveOnce({ success: false, output, error: errorOutput, code });
      }
    });

    child.on("error", (err) => {
      rejectOnce(err);
    });
  });
}

// ============================================================================
// CONFIG HELPERS
// ============================================================================

/**
 * Apply preset environment variables (system-level + MCP-specific)
 */
async function applyPresetEnvVars(logger = console.log) {
  const PROJECT_ROOT = getProjectRoot();

  const log = (msg) => {
    console.log(msg);
    if (typeof logger === "function" && logger !== console.log) {
      logger(msg + "\n", "info");
    }
  };

  log("[Presets] Applying environment variable presets...");

  const envPath = path.join(PROJECT_ROOT, ".env");

  // 1. Read current .env (or start with empty object)
  let envVars = {};
  let existingEnvContent = "";
  if (fs.existsSync(envPath)) {
    existingEnvContent = fs.readFileSync(envPath, "utf8");
    envVars = parseEnvFile(existingEnvContent);
  }

  // 2. Apply SYSTEM presets (ONLY if variable doesn't exist - self-healing)
  const systemPresetsPath = path.join(PROJECT_ROOT, "system-env-presets.yaml");
  let systemCount = 0;

  if (fs.existsSync(systemPresetsPath)) {
    const systemPresetsContent = fs.readFileSync(systemPresetsPath, "utf8");
    const systemPresets = parseYaml(systemPresetsContent);

    for (const [key, value] of Object.entries(systemPresets)) {
      if (typeof value !== "string") continue;

      // Only set if key doesn't exist (preserves user edits)
      if (!envVars[key]) {
        envVars[key] = value;
        systemCount++;
        log(`[Presets] Set system preset: ${key}=${value}`);
      }
    }
  }

  // 3. Determine enabled MCP servers using canonical toggle policy
  const { toggles, serverMetadata } = normalizeAndPersistMcpToggles({
    persist: true,
    reason: "applyPresetEnvVars",
  });
  const enabledServers = [];
  for (const [serverId, metadata] of serverMetadata.entries()) {
    if (metadata.isCore || toggles[serverId] === true) {
      enabledServers.push(serverId);
    }
  }

  // 4. Apply MCP presets (ALWAYS overwrite - force correct values)
  let mcpCount = 0;

  for (const serverId of enabledServers) {
    const yamlPath = findServerYaml(serverId);
    if (!yamlPath) continue;

    const yamlContent = fs.readFileSync(yamlPath, "utf8");
    const serverData = parseYaml(yamlContent);
    const presetVars = serverData.preset_env_vars || [];

    for (const preset of presetVars) {
      if (preset.name && preset.value) {
        envVars[preset.name] = preset.value;
        mcpCount++;
      }
    }
  }

  // 5. Write updated .env
  writeProtectedRepositoryEnvAtomicSync(envPath, serializeEnvFile(envVars));

  log(`[Presets] Applied ${systemCount} system + ${mcpCount} MCP presets`);
  return { systemCount, mcpCount };
}

// ============================================================================
// MCP INITIALIZATION
// ============================================================================

/**
 * Dependency injection for resetConfigData (from windows.js)
 */
let resetConfigDataFn = null;

function setResetConfigData(fn) {
  resetConfigDataFn = fn;
}

/**
 * Reusable MCP initialization function
 */
async function runMcpInitialization(options = {}) {
  const PROJECT_ROOT = getProjectRoot();
  const SCRIPTS_DIR = getScriptsDir();
  const { skipDockerCheck = false, logCollector = null } = options;
  const logs = [];
  const errors = [];

  const log = (text, type = "info") => {
    logs.push({ text, type, timestamp: new Date().toISOString() });
    if (logCollector) {
      logCollector(text, type);
    }
    console.log(`[MCP Init] [${type}] ${text}`);
  };

  try {
    log("Starting MCP infrastructure initialization...", "info");

    // Check and start Docker if needed
    if (!skipDockerCheck) {
      log("Checking Docker status...", "info");
      const dockerReady = await ensureDockerRunning();
      if (!dockerReady) {
        const errMsg =
          `Docker could not be started automatically. If OrbStack is installed, it did not become ready within ${ORBSTACK_DOCKER_STARTUP_TIMEOUT_LABEL}.`;
        log(errMsg, "error");
        errors.push(errMsg);
        return { success: false, logs, errors, healthCheckPassed: false };
      }
      log("Docker is ready", "success");
    }

    // Stop per-server MCP runtime containers while preserving the shared control plane.
    log("Stopping MCP server containers (preserving the MCP control plane)...", "info");
    try {
      const enhancedEnv = createEnhancedEnv();

      const { promisify } = require("util");
      const execAsync = promisify(exec);
      await execAsync(
        'docker ps --format "{{.Names}}" --filter "name=mcpo-" | grep -v "^mcpo$" | grep -v "^mcpo-core$" | grep -v "^mcpo-openapi-aggregator$" | grep -v "^mcpo-core-openapi-aggregator$" | xargs -r docker stop || true',
        { cwd: PROJECT_ROOT, env: enhancedEnv },
      );
      log(
        "Per-server MCP runtime containers stopped (MCP control plane still running)",
        "success",
      );
    } catch (err) {
      log(`MCP runtime stop failed: ${err.message}`, "warning");
    }

    // Apply preset environment variables
    log("Applying preset environment variables...", "info");
    if (state.windows.loading && !state.windows.loading.isDestroyed()) {
      safeWebContentsSend(
        state.windows.loading,
        "loading-log",
        {
          text: "Applying system and MCP preset environment variables...\n",
          type: "info",
        },
        {
          tag: "preset-apply-log",
          meta: { phase: "apply-presets" },
        },
      );
    }

    try {
      const { systemCount, mcpCount } = await applyPresetEnvVars();
      log(`Applied ${systemCount} system + ${mcpCount} MCP presets`, "success");
    } catch (error) {
      log(`Warning: Preset application failed: ${error.message}`, "warning");
    }

    // Configure MCP servers
    log("Configuring MCP servers...", "info");
    try {
      const mcpConfigCommand = await ensureMcpOrcGeneratorCommand(
        PROJECT_ROOT,
        "generate-docker-compose-override",
        {
          isPackagedApp: app.isPackaged,
          resourcesPath: process.resourcesPath,
          env: enhancedEnv,
        },
      );
      const mcpConfigResult = await executeWithStreaming(
        mcpConfigCommand,
        [],
      );
      if (mcpConfigResult.success) {
        log("MCP servers configured successfully", "success");
      } else {
        log(
          `Warning: MCP configuration failed: ${mcpConfigResult.error}`,
          "warning",
        );
      }
    } catch (error) {
      log(`Warning: MCP configuration failed: ${error.message}`, "warning");
    }

    // Check if HOST_MODE is supported
    let hostModeSupported = false;
    try {
      const hostModePath = path.join(PROJECT_ROOT, "HOST_MODE");
      hostModeSupported = readHostModeFileSync(hostModePath);
    } catch (err) {
      hostModeSupported = false;
    }

    if (!hostModeSupported) {
      log("Skipping host MCP proxy (HOST mode not supported)", "warning");
    } else {
      log("Starting host MCP proxy...", "info");
      try {
        const hostMcpoResult = await startHostMcpo();
        if (hostMcpoResult.skipped) {
          log("No host MCP servers configured, skipping", "info");
        } else if (hostMcpoResult.success) {
          log("Host MCP proxy started successfully", "success");
        } else {
          log(
            `Warning: Host MCP proxy failed to start: ${hostMcpoResult.error}`,
            "warning",
          );
        }
      } catch (error) {
        log(`Warning: Host MCP proxy error: ${error.message}`, "warning");
      }
    }

    // Start per-server MCP runtime containers using docker compose with override file
    log("Starting MCP services (per-server containers)...", "info");
    try {
      const enhancedEnv = createEnhancedEnv();

      const { promisify } = require("util");
      const execAsync = promisify(exec);
      // Use docker-compose.sh to ensure Harbor images are used when available
      await execAsync(
        `bash "${path.join(SCRIPTS_DIR, "docker-compose.sh")}" up-container mcpo`,
        { cwd: PROJECT_ROOT, env: enhancedEnv },
      );
      log("Per-server MCP runtime containers started successfully", "success");
    } catch (err) {
      const errMsg = `Failed to start MCP runtime: ${err.message}`;
      log(errMsg, "error");
      errors.push(errMsg);
      return { success: false, logs, errors, healthCheckPassed: false };
    }

    // Run health check
    log("Running health checks (control plane + MCP runtime)...", "info");
    let healthCheckPassed = false;
    try {
      const enhancedEnv = createEnhancedEnv();

      const { promisify } = require("util");
      const execAsync = promisify(exec);
      await execAsync("docker restart open-webui-health-check", {
        cwd: PROJECT_ROOT,
        env: enhancedEnv,
      });

      const healthResult = await executeWithStreaming(
        `bash "${path.join(SCRIPTS_DIR, "health-check.sh")}"`,
        [],
        120000,
      );
      if (healthResult.success) {
        log("All services are healthy!", "success");
        healthCheckPassed = true;
      } else {
        log(
          "Health check failed! MCP servers may not be properly configured.",
          "error",
        );
        errors.push("Health check failed");
      }
    } catch (err) {
      log(`Health check error: ${err.message}`, "error");
      errors.push(`Health check error: ${err.message}`);
    }

    if (!healthCheckPassed) {
      return { success: false, logs, errors, healthCheckPassed: false };
    }

    // Load configuration
    if (resetConfigDataFn) {
      resetConfigDataFn();
    }

    const envPath = path.join(PROJECT_ROOT, ".env");
    try {
      if (fs.existsSync(envPath)) {
        const envContent = await fsPromises.readFile(envPath, "utf8");
        const lines = envContent.split("\n");
        for (const line of lines) {
          if (line && !line.startsWith("#") && line.includes("=")) {
            const [key, ...valueParts] = line.split("=");
            const value = valueParts.join("=").trim();
            state.configData.env[key.trim()] = value;
          }
        }
        log("Configuration loaded", "success");
      }
    } catch (err) {
      log(`Failed to load config: ${err.message}`, "error");
    }

    log("MCP infrastructure initialization complete!", "success");
    return { success: true, logs, errors, healthCheckPassed: true };
  } catch (error) {
    const errMsg = `Critical Error: ${error.message}`;
    log(errMsg, "error");
    errors.push(errMsg);
    return { success: false, logs, errors, healthCheckPassed: false };
  }
}

// ============================================================================
// PER-SERVER MCPO LIFECYCLE
// ============================================================================

/**
 * Check if a server is deployed as host (runs outside Docker)
 * @param {string} serverId - The MCP server ID
 * @returns {Promise<boolean>} - True if server has deployment_type: "host"
 */
async function isHostDeployedServer(serverId) {
  const PROJECT_ROOT = getProjectRoot();

  const configPaths = [
    path.join(PROJECT_ROOT, "mcp-configs", serverId, `${serverId}.yaml`),
    path.join(PROJECT_ROOT, "mcp-configs-user", serverId, `${serverId}.yaml`),
  ];

  for (const yamlPath of configPaths) {
    if (fs.existsSync(yamlPath)) {
      try {
        const content = fs.readFileSync(yamlPath, "utf-8");
        return (
          content.includes('deployment_type: "host"') ||
          content.includes("deployment_type: 'host'") ||
          content.includes("deployment_type: host")
        );
      } catch (err) {
        console.error(
          `[MCPO] Error reading YAML for ${serverId}:`,
          err.message,
        );
        return false;
      }
    }
  }
  return false;
}

/**
 * Check if a server is a core server (is_core: true in YAML config)
 * Core metadata still exists, but route reloads now flow through the shared
 * MCPO control-plane container.
 * @param {string} serverId - The MCP server ID
 * @returns {boolean} - True if server is a core server
 */
function isCoreServer(serverId) {
  const PROJECT_ROOT = getProjectRoot();

  const configPaths = [
    path.join(PROJECT_ROOT, "mcp-configs", serverId, `${serverId}.yaml`),
    path.join(PROJECT_ROOT, "mcp-configs-user", serverId, `${serverId}.yaml`),
  ];

  for (const yamlPath of configPaths) {
    if (fs.existsSync(yamlPath)) {
      try {
        const content = fs.readFileSync(yamlPath, "utf-8");
        return (
          content.includes("is_core: true") ||
          content.includes('is_core: "true"') ||
          content.includes("is_core: 'true'")
        );
      } catch (err) {
        console.error(
          `[MCPO] Error reading YAML for ${serverId}:`,
          err.message,
        );
        // Fall through to health_status.json fallback
      }
    }
  }

  // Fallback: check health_status.json for deployment type.
  // This handles cases where the YAML file can't be found (e.g., path
  // resolution differences in managed Electron app installations).
  try {
    const healthPath = path.join(PROJECT_ROOT, "health-status", "health_status.json");
    if (fs.existsSync(healthPath)) {
      const healthData = JSON.parse(fs.readFileSync(healthPath, "utf-8"));
      if (healthData?.servers?.[serverId]?.deployment === "core") {
        console.log(
          `[MCPO] isCoreServer(${serverId}): YAML not found, but health_status.json says core`,
        );
        return true;
      }
    }
  } catch (_healthErr) {
    // Ignore - fall through to default
  }

  return false;
}

const MCPO_SERVER_ROUTING_CACHE = {
  filePath: null,
  mtimeMs: null,
  routes: {},
};

function getMcpoServerRoutingFilePath() {
  return path.join(getProjectRoot(), "mcpo-configs-generated", "server-routing.json");
}

function getGeneratedMcpoServerRoutingMap() {
  const routingFile = getMcpoServerRoutingFilePath();

  try {
    const stat = fs.statSync(routingFile);
    if (
      MCPO_SERVER_ROUTING_CACHE.filePath === routingFile &&
      MCPO_SERVER_ROUTING_CACHE.mtimeMs === stat.mtimeMs
    ) {
      return MCPO_SERVER_ROUTING_CACHE.routes;
    }

    const parsed = JSON.parse(fs.readFileSync(routingFile, "utf-8"));
    const routes =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};

    MCPO_SERVER_ROUTING_CACHE.filePath = routingFile;
    MCPO_SERVER_ROUTING_CACHE.mtimeMs = stat.mtimeMs;
    MCPO_SERVER_ROUTING_CACHE.routes = routes;
    return routes;
  } catch (_error) {
    MCPO_SERVER_ROUTING_CACHE.filePath = routingFile;
    MCPO_SERVER_ROUTING_CACHE.mtimeMs = null;
    MCPO_SERVER_ROUTING_CACHE.routes = {};
    return {};
  }
}

function getConfiguredMcpoRuntimeTarget(serverId) {
  const routes = getGeneratedMcpoServerRoutingMap();
  const route = routes[serverId];

  if (route && typeof route === "object") {
    return {
      serverId,
      composeService:
        route.compose_service || route.container_name || `mcpo-${serverId}`,
      containerName:
        route.container_name || route.compose_service || `mcpo-${serverId}`,
      networkHost:
        route.network_host || route.container_name || route.compose_service,
      port: Number(route.port) || 8000,
      deploymentScope:
        route.deployment_scope || (isCoreServer(serverId) ? "core" : "docker"),
      groupId: route.group_id || null,
      grouped: Boolean(route.grouped || route.group_id),
    };
  }

  const isCore = isCoreServer(serverId);
  const containerName = isCore ? `mcpo-core-${serverId}` : `mcpo-${serverId}`;
  const networkPrefix = isCore ? "mcpo-core" : "mcpo";

  return {
    serverId,
    composeService: containerName,
    containerName,
    networkHost: `${networkPrefix}-${serverId.replace(/_/g, "-")}`,
    port: 8000,
    deploymentScope: isCore ? "core" : "docker",
    groupId: null,
    grouped: false,
  };
}

const MCPO_CONTROL_PLANE_CONTAINER = "mcpo";
const MCPO_CONTROL_PLANE_CONTAINER_ALIASES = new Set([
  "mcpo",
  "mcpo-core",
  "mcpo-openapi-aggregator",
  "mcpo-core-openapi-aggregator",
]);

function getMcpoServerContainerCandidates(serverId) {
  const target = getConfiguredMcpoRuntimeTarget(serverId);
  const standardContainer = `mcpo-${serverId}`;
  const coreContainer = `mcpo-core-${serverId}`;

  return Array.from(
    new Set(
      isCoreServer(serverId)
        ? [target.containerName, coreContainer, standardContainer]
        : [target.containerName, standardContainer, coreContainer],
    ),
  );
}

function isPerServerMcpoContainer(containerName) {
  return (
    typeof containerName === "string" &&
    containerName.startsWith("mcpo-") &&
    !MCPO_CONTROL_PLANE_CONTAINER_ALIASES.has(containerName)
  );
}

function getServerIdFromMcpoContainerName(containerName) {
  const routes = getGeneratedMcpoServerRoutingMap();
  const matches = Object.entries(routes)
    .filter(([, route]) => route?.container_name === containerName)
    .map(([serverId]) => serverId);

  if (matches.length === 1) {
    return matches[0];
  }

  if (containerName.startsWith("mcpo-core-")) {
    return containerName.replace(/^mcpo-core-/, "");
  }

  return containerName.replace(/^mcpo-/, "");
}

async function resolveConfiguredMcpoServerContainerName(
  serverId,
  execAsync,
  projectRoot,
  env,
  configuredComposeServices,
) {
  if (configuredComposeServices !== undefined) {
    return resolveConfiguredMcpoServerContainerNameFromServices(
      serverId,
      configuredComposeServices,
    );
  }

  try {
    const services = await getConfiguredComposeServices(
      execAsync,
      projectRoot,
      env,
    );
    return resolveConfiguredMcpoServerContainerNameFromServices(
      serverId,
      services,
    );
  } catch (_error) {
    return resolveConfiguredMcpoServerContainerNameFromServices(serverId, null);
  }
}

function resolveConfiguredMcpoServerContainerNameFromServices(
  serverId,
  configuredComposeServices,
) {
  const target = getConfiguredMcpoRuntimeTarget(serverId);
  const candidates = Array.from(
    new Set([target.composeService, ...getMcpoServerContainerCandidates(serverId)]),
  );
  if (!(configuredComposeServices instanceof Set)) {
    return candidates[0];
  }
  return (
    candidates.find((name) => configuredComposeServices.has(name)) ||
    candidates[0]
  );
}

async function getConfiguredComposeServices(execAsync, projectRoot, env) {
  const { stdout } = await execAsync(
    `bash "${path.join(getScriptsDir(), "docker-compose.sh")}" config --services`,
    { cwd: projectRoot, env },
  );

  return new Set(
    stdout
      .trim()
      .split("\n")
      .map((service) => service.trim())
      .filter(Boolean),
  );
}

function buildConfigGenerationError(error, projectRoot) {
  const errorText = normalizeErrorText(error) || "Config generation failed";
  const attribution = extractAttributedServerFailure(errorText, projectRoot);
  const configError = new Error(errorText);
  configError.stage = "config_generation";
  configError.source = "config";
  configError.errorCode = "CONFIG_GENERATION_FAILED";
  if (attribution?.serverId) {
    configError.attributedServerId = attribution.serverId;
  }
  if (attribution?.configPath) {
    configError.configPath = attribution.configPath;
  }
  return configError;
}

async function regenerateMcpInfrastructureForSingleRestart(
  requestedServerId,
  execAsync,
  projectRoot,
  env,
  options = {},
) {
  const excludedServerIds = [];
  const excluded = new Set();
  const regenerationOptions = options.regenerationOptions || {};
  const maxRetries = Number.isInteger(options.maxRetries)
    ? options.maxRetries
    : MAX_SINGLE_RESTART_ATTRIBUTION_RETRIES;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      await regenerateMcpInfrastructure(
        execAsync,
        projectRoot,
        env,
        regenerationOptions,
      );
      return { excludedServerIds };
    } catch (error) {
      const configError = buildConfigGenerationError(error, projectRoot);
      const attributedServerId = configError.attributedServerId || null;

      if (
        !attributedServerId ||
        attributedServerId === requestedServerId ||
        excluded.has(attributedServerId) ||
        excluded.size >= maxRetries ||
        isCoreServer(attributedServerId)
      ) {
        throw configError;
      }

      recordAndPublishStartupFailure(
        projectRoot,
        {
          serverId: attributedServerId,
          operation: "restart",
          stage: "config_generation",
          error: configError.message,
          source: "config",
          deploymentType: "docker",
          ...(configError.configPath ? { configPath: configError.configPath } : {}),
          errorCode: "CONFIG_GENERATION_FAILED",
        },
        {
          logger: console,
          reason: `restart-config-failure-attributed:${attributedServerId}`,
        },
      );

      await mutateMcpToggles(
        (toggles) => {
          toggles[attributedServerId] = false;
        },
        {
          reason: `restartMcpoServer:config-failure-exclude:${attributedServerId}`,
        },
      );
      excluded.add(attributedServerId);
      excludedServerIds.push(attributedServerId);
      console.warn(
        `[MCPO] Config generation failed because of ${attributedServerId}; excluded it and retrying ${requestedServerId}`,
      );
    }
  }

  throw new Error("Config generation failed after retrying attributed failures");
}

/**
 * Restart a specific MCPO server container (or host-mcpo process for host-deployed servers)
 * @param {string} serverId - The MCP server ID (e.g., 'glean', 'slack', 'chrome-devtools')
 * @returns {Promise<{success: boolean, mode?: string, error?: string}>}
 */
async function restartMcpoServer(serverId) {
  const PROJECT_ROOT = getProjectRoot();
  const SCRIPTS_DIR = getScriptsDir();
  let activeDeploymentType = "docker";
  let activeContainerName = null;

  console.log(`[MCPO] Restarting server: ${serverId}`);
  invalidateServerToolsCache(serverId);
  invalidateHostModeCaches();

  if (!isKnownMcpServerId(serverId)) {
    const error = `MCP server "${serverId}" is not installed.`;
    console.warn(`[MCPO] ${error}`);
    return {
      success: false,
      serverId,
      error,
      errorCode: "MCP_SERVER_NOT_FOUND",
    };
  }

  try {
    const enhancedEnv = createEnhancedEnv();

    const { promisify } = require("util");
    const execAsync = promisify(exec);

    // Check if this is a host-deployed server
    const isHost = await isHostDeployedServer(serverId);

    if (isHost) {
      activeDeploymentType = "host";
      console.log(
        `[MCPO] Server ${serverId} is host-deployed, restarting host-mcpo process...`,
      );

      await ensureServersEnabledForRestart([serverId], {
        mutateToggles: mutateMcpToggles,
        isCoreServer,
        logger: console,
        reasonPrefix: "restartMcpoServer",
      });
      await restartHostMcpoWithFreshConfig({
        execAsync,
        projectRoot: PROJECT_ROOT,
        env: enhancedEnv,
        regenerateMcpInfrastructure,
        stopHostMcpo,
        startHostMcpo,
        logger: console,
        regenerationOptions: { isPackagedApp: app.isPackaged },
      });
      invalidateHostModeCaches();

      console.log(
        `[MCPO] Host-deployed server ${serverId} restarted via host-mcpo`,
      );
      clearStartupFailure(PROJECT_ROOT, serverId, { logger: console });
      return { success: true, mode: "host" };
    }

    // Docker-based restart
    const isCore = isCoreServer(serverId);
    const runtimeTarget = getConfiguredMcpoRuntimeTarget(serverId);
    let containerName = await resolveConfiguredMcpoServerContainerName(
      serverId,
      execAsync,
      PROJECT_ROOT,
      enhancedEnv,
    );
    activeContainerName = containerName;
    console.log(
      `[MCPO] Server ${serverId} is Docker-deployed (container: ${containerName})`,
    );

    // If a user explicitly requested a restart for a non-core Docker server,
    // ensure it is enabled so config generation includes it.
    if (!isCore) {
      try {
        await ensureServersEnabledForRestart([serverId], {
          mutateToggles: mutateMcpToggles,
          isCoreServer,
          logger: console,
          reasonPrefix: "restartMcpoServer",
        });
      } catch (toggleErr) {
        console.warn(
          `[MCPO] Warning: Could not update mcp_toggles.json for ${serverId}: ${toggleErr.message}`,
        );
      }
    }

    // Force-remove the existing container to avoid Docker's default 10-second
    // stop grace period during interactive toggles.
    console.log(`[MCPO] Force-removing ${containerName}...`);
    await execAsync(buildForceRemoveContainerCommand(containerName), {
      cwd: PROJECT_ROOT,
      env: enhancedEnv,
    });

    // Force-regenerate configs so docker-compose.override.yml is up-to-date
    console.log(`[MCPO] Force-regenerating configs...`);
    await regenerateMcpInfrastructureForSingleRestart(
      serverId,
      execAsync,
      PROJECT_ROOT,
      enhancedEnv,
      {
        regenerationOptions: {
          force: true,
          isPackagedApp: app.isPackaged,
        },
      },
    );
    invalidateHostModeCaches();

    // Pre-flight: verify the service actually exists in the generated docker-compose
    console.log(`[MCPO] Checking if service ${containerName} exists in docker-compose...`);
    try {
      const { stdout: servicesOutput } = await execAsync(
        `bash "${path.join(SCRIPTS_DIR, "docker-compose.sh")}" config --services`,
        { cwd: PROJECT_ROOT, env: enhancedEnv },
      );
      const services = servicesOutput.trim().split("\n").map(s => s.trim());
      if (!services.includes(containerName)) {
        const alternateContainer = [
          runtimeTarget.composeService,
          ...getMcpoServerContainerCandidates(serverId),
        ].find((name) => services.includes(name));
        if (alternateContainer) {
          containerName = alternateContainer;
          activeContainerName = containerName;
        }
      }
      if (!services.includes(containerName)) {
        console.error(
          `[MCPO] Service ${containerName} not found in docker-compose. Available: ${services.join(", ")}`,
        );
        const diagnostics = buildMissingComposeDiagnostics(serverId);
        const generatedConfigurationStatus = getGeneratedConfigurationGap(
          serverId,
          PROJECT_ROOT,
        );
        if (generatedConfigurationStatus) {
          clearStartupFailure(PROJECT_ROOT, serverId, { logger: console });
          return buildGeneratedConfigurationRequiredResult(
            serverId,
            generatedConfigurationStatus,
            {
              mode: "docker",
              errorDetails:
                diagnostics.length > 0
                  ? diagnostics.join(" ")
                  : generatedConfigurationStatus.error,
            },
          );
        }
        const errorText = `Docker Compose service "${containerName}" not found after config regeneration.`;
        const failure = recordAndPublishStartupFailure(
          PROJECT_ROOT,
          {
            serverId,
            operation: "restart",
            stage: "config_generation",
            error: errorText,
            source: "config",
            deploymentType: "docker",
            containerName,
            errorCode: "SERVICE_NOT_FOUND",
          },
          {
            logger: console,
            reason: `restart-config-failure:${serverId}`,
          },
        );
        return {
          success: false,
          errorCode: "SERVICE_NOT_FOUND",
          error: errorText,
          errorDetails: diagnostics.length > 0
            ? diagnostics.join(" ")
            : "The service was not generated. Check server configuration and toggle state.",
          startupFailure: failure,
        };
      }
    } catch (checkErr) {
      console.warn(
        `[MCPO] Could not verify service existence (proceeding anyway): ${checkErr.message}`,
      );
    }

    // Start the specific container using docker-compose.sh (ensures Harbor images are used when available)
    console.log(`[MCPO] Starting ${containerName}...`);
    await execAsync(
      buildUpContainerCommand(
        path.join(SCRIPTS_DIR, "docker-compose.sh"),
        containerName,
        { noDeps: true },
      ),
      { cwd: PROJECT_ROOT, env: enhancedEnv },
    );

    const containerState = await waitForContainerRunning(
      (command) => execAsync(command, { cwd: PROJECT_ROOT, env: enhancedEnv }),
      containerName,
      { attempts: 20, delayMs: 500 },
    );
    if (!containerState.running) {
      throw new Error(
        `Container did not reach running state (status: ${containerState.lastStatus || "unknown"})`,
      );
    }

    // Refresh the shared MCPO control plane so regenerated per-server routes
    // are active in both nginx and the OpenAPI aggregators.
    const controlPlaneContainer = MCPO_CONTROL_PLANE_CONTAINER;
    console.log(
      `[MCPO] Refreshing ${controlPlaneContainer} control-plane programs to apply route for ${serverId}...`,
    );
    try {
      await refreshMcpControlPlane(execAsync, PROJECT_ROOT, enhancedEnv, {
        controlPlaneContainer,
        serverId,
        includeRegular: runtimeTarget.deploymentScope !== "core",
        includeCore: runtimeTarget.deploymentScope === "core",
        serverRouteWait: "skip",
        logger: console,
      });
      console.log(
        `[MCPO] ${controlPlaneContainer} control-plane refresh completed successfully`,
      );
    } catch (refreshErr) {
      console.warn(
        `[MCPO] Warning: Failed to refresh ${controlPlaneContainer} control-plane: ${refreshErr.message}`,
      );
    }

    console.log(`[MCPO] Server ${serverId} restarted successfully`);
    clearStartupFailure(PROJECT_ROOT, serverId, { logger: console });
    return { success: true, mode: "docker" };
  } catch (error) {
    console.error(`[MCPO] Failed to restart ${serverId}:`, error);
    const errorText = normalizeErrorText(error) || error.message;
    const attributedFailure =
      error?.attributedServerId || error?.configPath
        ? {
            serverId: error.attributedServerId || null,
            configPath: error.configPath || null,
          }
        : extractAttributedServerFailure(errorText, PROJECT_ROOT);
    const isConfigGenerationFailure =
      error?.stage === "config_generation" ||
      /generate|config|compose|fragment/i.test(errorText);
    const failure = recordAndPublishStartupFailure(
      PROJECT_ROOT,
      {
        serverId,
        operation: "restart",
        stage: isConfigGenerationFailure
          ? "config_generation"
          : "runtime_start",
        error: errorText,
        source: isConfigGenerationFailure
          ? "config"
          : activeDeploymentType === "host"
            ? "host"
            : "container",
        deploymentType: activeDeploymentType,
        ...(!isConfigGenerationFailure && activeContainerName
          ? { containerName: activeContainerName }
          : {}),
        ...(isConfigGenerationFailure && attributedFailure?.configPath
          ? { configPath: attributedFailure.configPath }
          : {}),
        ...(isConfigGenerationFailure
          ? { errorCode: error?.errorCode || "CONFIG_GENERATION_FAILED" }
          : {}),
      },
      {
        logger: console,
        reason: `restart-failure:${serverId}`,
      },
    );
    return { success: false, error: failure.error, startupFailure: failure };
  }
}

/**
 * Restart multiple specific MCPO servers
 * @param {string[]} serverIds - Array of MCP server IDs to restart
 * @returns {Promise<{success: boolean, results: Array, errors: string[]}>}
 */
async function restartMcpoServers(serverIds, options = {}) {
  const PROJECT_ROOT = getProjectRoot();
  const SCRIPTS_DIR = getScriptsDir();
  const requestedServerIds = Array.isArray(serverIds) ? [...serverIds] : [];
  const knownServerIds = discoverInstalledMcpServerIds(PROJECT_ROOT, {
    logger: console,
  });
  const activeServerIds = requestedServerIds.filter((serverId) =>
    knownServerIds.has(serverId),
  );
  const results = [];
  const errors = [];

  const recordBulkStartupFailure = (serverId, error, options = {}) => {
    const result = buildStartupFailureResult(serverId, error, {
      operation: options.operation || "enable",
      stage: options.stage || "runtime_start",
      source: options.source || "container",
      deploymentType: options.deploymentType || options.mode || null,
      containerName: options.containerName || null,
      configPath: options.configPath || null,
      errorCode: options.errorCode || null,
      mode: options.mode || null,
    });
    recordAndPublishStartupFailure(PROJECT_ROOT, result.startupFailure, {
      logger: console,
      reason: `bulk-restart-failure:${serverId}`,
    });
    return result;
  };

  for (const serverId of requestedServerIds) {
    if (knownServerIds.has(serverId)) continue;
    const error = `MCP server "${serverId}" is not installed.`;
    results.push({
      serverId,
      success: false,
      error,
      errorCode: "MCP_SERVER_NOT_FOUND",
    });
    errors.push(`${serverId}: ${error}`);
    console.warn(`[MCPO] Skipping ${serverId}: ${error}`);
  }

  console.log(
    `[MCPO] Restarting ${activeServerIds.length} server(s): ${activeServerIds.join(", ")}`,
  );
  activeServerIds.forEach((serverId) => invalidateServerToolsCache(serverId));
  invalidateHostModeCaches();

  if (activeServerIds.length === 0) {
    return { success: errors.length === 0, results, errors };
  }

  try {
    const enhancedEnv = createEnhancedEnv();

    const { promisify } = require("util");
    const execAsync = promisify(exec);

    const reportPhase = async (phase, metadata = {}) => {
      if (typeof options.onPhase === "function") {
        await options.onPhase(phase, metadata);
      }
    };

    // First, regenerate configs once for all servers
    if (options.skipRegeneration !== true) {
      console.log(`[MCPO] Regenerating configs for all servers...`);
      await reportPhase("regenerating_config", { serverIds: activeServerIds });
      await regenerateMcpInfrastructure(
        execAsync,
        PROJECT_ROOT,
        enhancedEnv,
        { isPackagedApp: app.isPackaged },
      );
      invalidateHostModeCaches();
    } else {
      console.log(`[MCPO] Using configuration already regenerated by operation preflight`);
    }
    await reportPhase("resolving_runtime_targets", {
      serverIds: activeServerIds,
    });

    // Separate host and Docker servers
    const hostServers = [];
    const dockerServers = [];

    for (const serverId of activeServerIds) {
      const isHost = await isHostDeployedServer(serverId);
      if (isHost) {
        hostServers.push(serverId);
      } else {
        dockerServers.push(serverId);
      }
    }

    // Handle host servers (restart host-mcpo once for all)
    if (hostServers.length > 0) {
      await reportPhase("restarting_host", { serverIds: hostServers });
      console.log(
        `[MCPO] Restarting host-mcpo for ${hostServers.length} host server(s): ${hostServers.join(", ")}`,
      );
      try {
        if (options.skipEnsureEnabled !== true) {
          await ensureServersEnabledForRestart(hostServers, {
            mutateToggles: mutateMcpToggles,
            isCoreServer,
            logger: console,
            reasonPrefix: "restartMcpoServers",
          });
        }
        await restartHostMcpoWithFreshConfig({
          execAsync,
          projectRoot: PROJECT_ROOT,
          env: enhancedEnv,
          regenerateMcpInfrastructure,
          stopHostMcpo,
          startHostMcpo,
          logger: console,
          regenerationOptions: { isPackagedApp: app.isPackaged },
          skipRegeneration: true,
        });
        invalidateHostModeCaches();
        hostServers.forEach((serverId) => {
          clearStartupFailure(PROJECT_ROOT, serverId, { logger: console });
          results.push({ serverId, success: true, mode: "host" });
        });
        console.log(`[MCPO] Host-mcpo restarted successfully`);
      } catch (err) {
        hostServers.forEach((serverId) => {
          results.push(
            recordBulkStartupFailure(serverId, err, {
              mode: "host",
              source: "host",
              stage: "runtime_start",
            }),
          );
          errors.push(`${serverId}: ${err.message}`);
        });
        console.error(`[MCPO] Failed to restart host-mcpo:`, err.message);
      }
    }

    let configuredComposeServices =
      options.configuredComposeServices instanceof Set
        ? options.configuredComposeServices
        : null;
    try {
      if (!configuredComposeServices) {
        configuredComposeServices = await getConfiguredComposeServices(
          execAsync,
          PROJECT_ROOT,
          enhancedEnv,
        );
      }
    } catch (serviceErr) {
      const error = `Could not enumerate Docker Compose services after config regeneration: ${serviceErr.message}`;
      dockerServers.forEach((serverId) => {
        results.push(
          recordBulkStartupFailure(serverId, error, {
            mode: "docker",
            source: "config",
            stage: "config_generation",
            errorCode: "COMPOSE_DISCOVERY_FAILED",
          }),
        );
        errors.push(`${serverId}: ${error}`);
      });
      console.error(`[MCPO] ${error}`);
    }

    const dockerContainerTargets = new Map();
    for (const serverId of configuredComposeServices ? dockerServers : []) {
      const runtimeTarget = getConfiguredMcpoRuntimeTarget(serverId);
      const composeService = resolveConfiguredMcpoServerContainerNameFromServices(
        serverId,
        configuredComposeServices,
      );
      if (
        configuredComposeServices &&
        !configuredComposeServices.has(composeService)
      ) {
        const diagnostics = buildMissingComposeDiagnostics(serverId);
        const generatedConfigurationStatus = getGeneratedConfigurationGap(
          serverId,
          PROJECT_ROOT,
        );
        if (generatedConfigurationStatus) {
          clearStartupFailure(PROJECT_ROOT, serverId, { logger: console });
          results.push(
            buildGeneratedConfigurationRequiredResult(
              serverId,
              generatedConfigurationStatus,
              {
                mode: "docker",
                errorDetails:
                  diagnostics.length > 0
                    ? diagnostics.join(" ")
                    : generatedConfigurationStatus.error,
              },
            ),
          );
          console.warn(
            `[MCPO] Skipping ${serverId}: compose service ${composeService} was omitted because configuration is incomplete`,
          );
          continue;
        }
        const result = recordBulkStartupFailure(
          serverId,
          `Docker Compose service "${composeService}" not found after config regeneration.`,
          {
            mode: "docker",
            source: "config",
            stage: "config_generation",
            containerName: runtimeTarget.containerName,
            errorCode: "SERVICE_NOT_FOUND",
          },
        );
        result.errorDetails =
          diagnostics.length > 0
            ? diagnostics.join(" ")
            : "The service was not generated. Check server configuration and toggle state.";
        results.push(result);
        errors.push(
          `${serverId}: Docker Compose service "${composeService}" not found after config regeneration.`,
        );
        console.error(
          `[MCPO] Skipping ${serverId}: compose service ${composeService} was not generated`,
        );
        continue;
      }
      const containerName = runtimeTarget.containerName;
      const key = `${composeService}:::${containerName}`;
      if (!dockerContainerTargets.has(key)) {
        dockerContainerTargets.set(key, {
          composeService,
          containerName,
          deploymentScope: runtimeTarget.deploymentScope || "docker",
          serverIds: [],
        });
      }
      dockerContainerTargets.get(key).serverIds.push(serverId);
    }

    if (dockerContainerTargets.size > 0) {
      await reportPhase("restarting_docker", { serverIds: dockerServers });
      const targets = Array.from(dockerContainerTargets.values());
      const composeServices = targets.map((target) => target.composeService);
      const containerNames = targets.map((target) => target.containerName);
      console.log(
        `[MCPO] Restarting ${targets.length} Docker runtime container(s) for ${dockerServers.length} server(s) using a single batched compose up`,
      );

      await Promise.all(
        containerNames.map((containerName) =>
          execAsync(buildForceRemoveContainerCommand(containerName), {
            cwd: PROJECT_ROOT,
            env: enhancedEnv,
          }),
        ),
      );

      try {
        await execAsync(
          buildUpContainersCommand(
            path.join(SCRIPTS_DIR, "docker-compose.sh"),
            composeServices,
            { noDeps: true },
          ),
          { cwd: PROJECT_ROOT, env: enhancedEnv },
        );
      } catch (err) {
        targets.forEach(({ serverIds, containerName }) => {
          serverIds.forEach((serverId) => {
            results.push(
              recordBulkStartupFailure(serverId, err, {
                mode: "docker",
                source: "container",
                stage: "runtime_start",
                containerName,
              }),
            );
            errors.push(`${serverId}: ${err.message}`);
          });
          console.error(
            `[MCPO] Failed to restart ${containerName}:`,
            err.message,
          );
        });
      }

      const pendingTargets = targets.filter(
        ({ serverIds }) =>
          !serverIds.every((serverId) =>
            results.some((entry) => entry.serverId === serverId),
          ),
      );
      const containerStates = new Map(
        pendingTargets.length === 0
          ? []
          : (
              await waitForContainersRunning(
                (command) => execAsync(command, { cwd: PROJECT_ROOT, env: enhancedEnv }),
                pendingTargets.map((target) => target.containerName),
                { attempts: 20, delayMs: 500 },
              )
            ).map((state) => [state.containerName, state]),
      );

      for (const target of targets) {
        const { containerName, serverIds } = target;
        if (serverIds.every((serverId) => results.some((entry) => entry.serverId === serverId))) {
          continue;
        }

        try {
          const containerState = containerStates.get(containerName);
          if (!containerState) {
            throw new Error("container readiness result missing");
          }

          if (!containerState.running) {
            throw new Error(
              `Container did not reach running state (status: ${containerState.lastStatus || "unknown"})`,
            );
          }

          serverIds.forEach((serverId) => {
            clearStartupFailure(PROJECT_ROOT, serverId, { logger: console });
            results.push({ serverId, success: true, mode: "docker" });
          });
          console.log(`[MCPO] Container ${containerName} restarted successfully`);
        } catch (err) {
          serverIds.forEach((serverId) => {
            results.push(
              recordBulkStartupFailure(serverId, err, {
                mode: "docker",
                source: "container",
                stage: "runtime_start",
                containerName,
              }),
            );
            errors.push(`${serverId}: ${err.message}`);
          });
          console.error(
            `[MCPO] Failed to restart ${containerName}:`,
            err.message,
          );
        }
      }
    }

    // Refresh the shared MCPO control plane once to pick up all updated routes.
    if (dockerContainerTargets.size > 0) {
      await reportPhase("reloading_routes", { serverIds: dockerServers });
      const refreshScope = buildAggregatorInvalidationScope(
        Array.from(dockerContainerTargets.values()),
      );
      console.log(
        `[MCPO] Refreshing ${MCPO_CONTROL_PLANE_CONTAINER} control-plane programs for ${dockerServers.length} Docker server(s)...`,
      );
      try {
        await refreshMcpControlPlane(execAsync, PROJECT_ROOT, enhancedEnv, {
          controlPlaneContainer: MCPO_CONTROL_PLANE_CONTAINER,
          serverId: dockerServers.length === 1 ? dockerServers[0] : null,
          ...refreshScope,
          serverRouteWait: "skip",
          skipCacheInvalidation:
            options.skipPreReadinessInvalidation === true,
          logger: console,
        });
        console.log(
          `[MCPO] ${MCPO_CONTROL_PLANE_CONTAINER} control-plane refresh completed successfully`,
        );
      } catch (refreshErr) {
        console.warn(
          `[MCPO] Warning: Failed to refresh ${MCPO_CONTROL_PLANE_CONTAINER} control-plane: ${refreshErr.message}`,
        );
      }
    }

    console.log(
      `[MCPO] Completed restarting ${activeServerIds.length} server(s): ${results.filter((r) => r.success).length} succeeded, ${errors.length} failed`,
    );
    return { success: errors.length === 0, results, errors };
  } catch (error) {
    console.error(`[MCPO] Failed to restart servers:`, error);
    const errorText = normalizeErrorText(error) || error.message;
    const attributedFailure = extractAttributedServerFailure(
      errorText,
      PROJECT_ROOT,
    );
    let nextResults = results;
    if (attributedFailure?.serverId) {
      nextResults = ensureBulkResultsForRequested(
        [attributedFailure.serverId],
        nextResults,
        {
          error: errorText,
          stage: "config_generation",
          source: "config",
          operation: "enable",
          errorCode: "CONFIG_GENERATION_FAILED",
        },
      ).map((entry) => {
        if (entry.serverId !== attributedFailure.serverId) {
          return entry;
        }
        const result = {
          ...entry,
          configPath: attributedFailure.configPath || entry.configPath,
          startupFailure: {
            ...entry.startupFailure,
            configPath:
              attributedFailure.configPath ||
              entry.startupFailure?.configPath,
          },
        };
        recordAndPublishStartupFailure(PROJECT_ROOT, result.startupFailure, {
          logger: console,
          reason: `bulk-restart-config-failure:${result.serverId}`,
        });
        return result;
      });
    } else {
      nextResults = ensureBulkResultsForRequested(
        requestedServerIds,
        nextResults,
        {
          error: errorText,
          stage: "config_generation",
          source: "config",
          operation: "enable",
          errorCode: "CONFIG_GENERATION_FAILED",
        },
      );
      nextResults.forEach((entry) => {
        if (entry?.success === false && entry.startupFailure) {
          recordAndPublishStartupFailure(PROJECT_ROOT, entry.startupFailure, {
            logger: console,
            reason: `bulk-restart-config-failure:${entry.serverId}`,
          });
        }
      });
    }
    return {
      success: false,
      results: nextResults,
      errors: [...errors, errorText],
      error: errorText,
      attributedServerId: attributedFailure?.serverId || null,
    };
  }
}

/**
 * Get status of a specific MCPO server container
 * @param {string} serverId - The MCP server ID
 * @returns {Promise<{status: string, running: boolean}>}
 */
async function getMcpoServerStatus(serverId) {
  try {
    const { promisify } = require("util");
    const execAsync = promisify(exec);
    const runtimeTarget = getConfiguredMcpoRuntimeTarget(serverId);
    const { stdout } = await execAsync(
      `docker inspect --format '{{.State.Status}}' ${runtimeTarget.containerName} 2>/dev/null || echo "not_found"`,
    );
    const status = stdout.trim();

    if (status !== "not_found") {
      return {
        status,
        running: status === "running",
        containerName: runtimeTarget.containerName,
      };
    }

    return {
      status: "not_found",
      running: false,
    };
  } catch (error) {
    return {
      status: "not_found",
      running: false,
    };
  }
}

/**
 * List all per-server MCPO containers
 * @returns {Promise<{serverId: string, containerName: string, status: string}[]>}
 */
async function listMcpoServers() {
  try {
    const { promisify } = require("util");
    const execAsync = promisify(exec);
    const routes = getGeneratedMcpoServerRoutingMap();
    const routeEntries = Object.entries(routes);

    if (routeEntries.length > 0) {
      const containerStatusCache = new Map();
      const servers = [];

      for (const [serverId, route] of routeEntries) {
        const containerName = route?.container_name;
        if (!containerName || !isPerServerMcpoContainer(containerName)) {
          continue;
        }

        if (!containerStatusCache.has(containerName)) {
          const { stdout } = await execAsync(
            `docker inspect --format '{{.State.Status}}' ${containerName} 2>/dev/null || echo "not_found"`,
          );
          containerStatusCache.set(containerName, (stdout || "").trim());
        }

        const status = containerStatusCache.get(containerName);
        servers.push({
          serverId,
          containerName,
          status: status === "running" ? "running" : "stopped",
        });
      }

      return servers;
    }

    const { stdout } = await execAsync(
      `docker ps -a --filter "name=mcpo-" --format "{{.Names}}:{{.Status}}" || true`,
    );

    const fallbackServers = [];
    const lines = stdout
      .trim()
      .split("\n")
      .filter((line) => line);

    for (const line of lines) {
      const [containerName, ...statusParts] = line.split(":");
      if (!isPerServerMcpoContainer(containerName)) {
        continue;
      }
      const status = statusParts.join(":");
      const serverId = getServerIdFromMcpoContainerName(containerName);
      if (!serverId || serverId.includes(",")) {
        continue;
      }

      fallbackServers.push({
        serverId,
        containerName,
        status: status.toLowerCase().includes("up") ? "running" : "stopped",
      });
    }

    return fallbackServers;
  } catch (error) {
    console.error("[MCPO] Failed to list servers:", error);
    return [];
  }
}

/**
 * Restart all MCP server containers (excludes shared control-plane containers)
 * Used by the Control Plane "Restart Servers" button
 * @returns {Promise<{success: boolean, restarted: string[], errors: string[]}>}
 */
async function restartAllMcpoServers() {
  const PROJECT_ROOT = getProjectRoot();
  const SCRIPTS_DIR = getScriptsDir();
  const restarted = [];
  const errors = [];

  console.log("[MCPO] Restarting all MCP server containers...");
  invalidateServerToolsCache();
  invalidateHostModeCaches();

  try {
    const enhancedEnv = createEnhancedEnv();

    const { promisify } = require("util");
    const execAsync = promisify(exec);

    // First, regenerate configs
    console.log("[MCPO] Regenerating configs...");
    await regenerateMcpInfrastructure(
      execAsync,
      PROJECT_ROOT,
      enhancedEnv,
      { isPackagedApp: app.isPackaged },
    );
    invalidateHostModeCaches();

    const routes = getGeneratedMcpoServerRoutingMap();
    const containerTargets = new Map();

    for (const [serverId, route] of Object.entries(routes)) {
      const containerName = route?.container_name;
      const composeService = route?.compose_service || containerName;
      if (!containerName || !composeService || !isPerServerMcpoContainer(containerName)) {
        continue;
      }

      if (!containerTargets.has(containerName)) {
        containerTargets.set(containerName, {
          containerName,
          composeService,
          deploymentScope:
            route?.deployment_scope ||
            (containerName === "mcpo-group-core" ? "core" : "docker"),
          serverIds: [],
        });
      }
      containerTargets.get(containerName).serverIds.push(serverId);
    }

    let containers = Array.from(containerTargets.values());
    if (containers.length === 0) {
      const { stdout } = await execAsync(
        'docker ps --format "{{.Names}}" --filter "name=mcpo-" || true',
        { cwd: PROJECT_ROOT, env: enhancedEnv },
      ).catch(() => ({ stdout: "" }));

      containers = stdout
        .trim()
        .split("\n")
        .map((name) => name.trim())
        .filter((name) => isPerServerMcpoContainer(name))
        .map((containerName) => ({
          containerName,
          composeService: containerName,
          deploymentScope:
            containerName === "mcpo-group-core" ? "core" : "docker",
          serverIds: [getServerIdFromMcpoContainerName(containerName)].filter(Boolean),
        }))
        .filter((target) => target.serverIds.length > 0);
    }
    console.log(
      `[MCPO] Found ${containers.length} MCP server container(s) to restart`,
    );

    try {
      const composeServices = containers.map((target) => target.composeService);
      await Promise.all(
        containers.map(({ containerName }) =>
          execAsync(buildForceRemoveContainerCommand(containerName), {
            cwd: PROJECT_ROOT,
            env: enhancedEnv,
          }),
        ),
      );
      await execAsync(
        buildUpContainersCommand(
          path.join(SCRIPTS_DIR, "docker-compose.sh"),
          composeServices,
          { noDeps: true },
        ),
        { cwd: PROJECT_ROOT, env: enhancedEnv },
      );
    } catch (err) {
      containers.forEach(({ serverIds, containerName }) => {
        serverIds.forEach((serverId) => errors.push(`${serverId}: ${err.message}`));
        console.error(
          `[MCPO] Failed to restart ${containerName}:`,
          err.message,
        );
      });
    }

    for (const target of containers) {
      const { containerName, serverIds } = target;
      if (serverIds.every((serverId) => errors.some((entry) => entry.startsWith(`${serverId}:`)))) {
        continue;
      }
      const containerState = await waitForContainerRunning(
        (command) => execAsync(command, { cwd: PROJECT_ROOT, env: enhancedEnv }),
        containerName,
        { attempts: 20, delayMs: 500 },
      );
      if (!containerState.running) {
        const errorMessage = `Container did not reach running state (status: ${containerState.lastStatus || "unknown"})`;
        serverIds.forEach((serverId) => errors.push(`${serverId}: ${errorMessage}`));
        console.error(`[MCPO] Failed to restart ${containerName}:`, errorMessage);
        continue;
      }
      restarted.push(...serverIds);
      console.log(`[MCPO] ${containerName} restarted`);
    }

    if (containers.length > 0) {
      try {
        const refreshScope = buildAggregatorInvalidationScope(containers);
        console.log(
          `[MCPO] Refreshing ${MCPO_CONTROL_PLANE_CONTAINER} control-plane after restarting ${containers.length} Docker server(s)...`,
        );
        await refreshMcpControlPlane(execAsync, PROJECT_ROOT, enhancedEnv, {
          controlPlaneContainer: MCPO_CONTROL_PLANE_CONTAINER,
          serverId:
            containers.length === 1 && containers[0]?.serverIds?.length === 1
              ? containers[0].serverIds[0]
              : null,
          ...refreshScope,
          logger: console,
        });
        console.log(
          `[MCPO] ${MCPO_CONTROL_PLANE_CONTAINER} control-plane refresh completed successfully`,
        );
      } catch (refreshErr) {
        console.warn(
          `[MCPO] Warning: Failed to refresh ${MCPO_CONTROL_PLANE_CONTAINER} control-plane: ${refreshErr.message}`,
        );
      }
    }

    // Also restart host-mcpo if HOST_MODE is enabled and process is running
    if ((await checkHostModeSupported()) && state.hostMcpo?.process) {
      console.log("[MCPO] Restarting host-mcpo process...");
      try {
        await restartHostMcpoWithFreshConfig({
          execAsync,
          projectRoot: PROJECT_ROOT,
          env: enhancedEnv,
          regenerateMcpInfrastructure,
          stopHostMcpo,
          startHostMcpo,
          logger: console,
          regenerationOptions: { isPackagedApp: app.isPackaged },
          skipRegeneration: true,
        });
        invalidateHostModeCaches();
        // Push actual host-deployed server IDs (not "host-mcpo" which is the process name)
        // Read health status to find which servers are host-deployed
        const healthStatusPath = path.join(
          PROJECT_ROOT,
          "health-status",
          "health_status.json",
        );
        try {
          if (fs.existsSync(healthStatusPath)) {
            const healthContent = await fsPromises.readFile(
              healthStatusPath,
              "utf8",
            );
            const healthStatus = JSON.parse(healthContent);
            const restartedHostServers = collectRestartedHostServerIds(
              healthStatus,
              {
                isServerEffectivelyEnabled: (serverId) =>
                  isServerEffectivelyEnabled(serverId, module.exports),
              },
            );
            for (const serverId of restartedHostServers) {
              restarted.push(serverId);
              console.log(`[MCPO] host-mcpo restarted (serves ${serverId})`);
            }
          }
        } catch (healthErr) {
          console.warn(
            `[MCPO] Could not determine host-deployed servers: ${healthErr.message}`,
          );
        }
      } catch (err) {
        errors.push(`host-mcpo: ${err.message}`);
        console.error("[MCPO] Failed to restart host-mcpo:", err.message);
      }
    }

    console.log(
      `[MCPO] Completed restarting all MCP servers: ${restarted.length} restarted, ${errors.length} failed`,
    );
    return { success: errors.length === 0, restarted, errors };
  } catch (error) {
    console.error("[MCPO] Failed to restart all servers:", error);
    return { success: false, restarted, errors: [...errors, error.message] };
  }
}

// ============================================================================
// TOOL CONFIGURATION
// ============================================================================

/**
 * Get the tools list for a specific MCP server from its OpenAPI endpoint
 * @param {string} serverId - The server ID (e.g., 'time', 'slack')
 * @returns {Promise<{success: boolean, tools?: Array, totalCount?: number, enabledCount?: number, error?: string}>}
 */
async function getServerTools(serverId, options = {}) {
  const PROJECT_ROOT = getProjectRoot();
  const toolsConfigPath = path.join(PROJECT_ROOT, "mcp_tools_config.json");
  const healthStatusPath = path.join(
    PROJECT_ROOT,
    "health-status",
    "health_status.json",
  );
  const forceRefresh = options.forceRefresh === true;
  const deploymentTypeOverride =
    typeof options.deploymentType === "string" && options.deploymentType.trim()
      ? options.deploymentType.trim().toLowerCase()
      : null;
  const toolsConfigMtimeMs = await getToolsConfigMtimeMs(toolsConfigPath);

  if (!forceRefresh) {
    const cachedResult = getCachedServerToolsResult(
      serverId,
      toolsConfigMtimeMs,
    );
    if (cachedResult) {
      if (TOOLS_VERBOSE_LOGS) {
        console.log(`[Tools] Using cached OpenAPI tools for ${serverId}`);
      }
      return cachedResult;
    }
  }

  try {
    // Determine the correct port based on deployment type from health status
    let port = 8765; // Default for docker deployment
    if (deploymentTypeOverride === "core") {
      port = 8766;
    } else if (deploymentTypeOverride === "host") {
      port = 8890;
    } else {
      try {
        await fsPromises.access(healthStatusPath);
        const healthContent = await fsPromises.readFile(
          healthStatusPath,
          "utf8",
        );
        const healthStatus = JSON.parse(healthContent);
        const serverHealth = healthStatus.servers?.[serverId];
        if (serverHealth?.deployment === "core") {
          port = 8766;
        } else if (serverHealth?.deployment === "host") {
          port = 8890;
        }
      } catch (healthError) {
        if (healthError.code !== "ENOENT") {
          console.warn(
            `[Tools] Could not read health status, using default port: ${healthError.message}`,
          );
        }
      }
    }

    // Fetch OpenAPI spec from the server
    const openApiUrl = `http://localhost:${port}/${serverId}/openapi.json`;
    if (TOOLS_VERBOSE_LOGS) {
      console.log(`[Tools] Fetching OpenAPI from ${openApiUrl}`);
    }

    const toolsFetchController = new AbortController();
    const toolsFetchTimer = setTimeout(() => toolsFetchController.abort(), 5000);
    let response;
    try {
      response = await fetch(openApiUrl, { signal: toolsFetchController.signal });
    } finally {
      clearTimeout(toolsFetchTimer);
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const openApiSpec = await response.json();
    const renameData = getToolRenameMapping(serverId);
    const {
      displayByOriginal,
      displayByLower,
      originalBySanitized,
    } = renameData;

    // Helper function to resolve $ref references in OpenAPI schema
    const resolveRef = (schema, components) => {
      if (!schema) return null;
      if (schema.$ref) {
        // Handle $ref like "#/components/schemas/GetCurrentTimeInput"
        const refPath = schema.$ref.replace("#/", "").split("/");
        let resolved = { components };
        for (const part of refPath) {
          resolved = resolved?.[part];
        }
        return resolved || schema;
      }
      return schema;
    };

    // Extract tools from paths (each path is a tool endpoint)
    const tools = [];
    if (openApiSpec.paths) {
      for (const [pathKey, pathDef] of Object.entries(openApiSpec.paths)) {
        // Extract tool name from path (e.g., "/time_get_current_time" -> "get_current_time")
        // The path includes the server prefix, so we need to extract just the tool name
        const pathParts = pathKey.split("/").filter((p) => p);
        if (pathParts.length === 0) continue;

        const fullToolName = pathParts[0];
        // Remove server prefix (e.g., "time_get_current_time" -> "get_current_time")
        // Note: MCPO normalizes server IDs by replacing hyphens with underscores in tool prefixes
        // (e.g., "mcp-atlassian" becomes "mcp_atlassian_" prefix), so we must normalize too
        const normalizedServerId = serverId.replace(/-/g, "_");
        const toolName = fullToolName.replace(
          new RegExp(`^${normalizedServerId}_`),
          "",
        );

        const postDef = pathDef.post || pathDef.get;

        // Extract input schema from requestBody if available
        let inputSchema = null;
        if (postDef?.requestBody?.content?.["application/json"]?.schema) {
          const rawSchema =
            postDef.requestBody.content["application/json"].schema;
          inputSchema = resolveRef(rawSchema, openApiSpec.components);
        }

        const openApiOriginalName = postDef?.["x-mcp-original-tool-name"];
        const openApiDisplayName = postDef?.["x-mcp-display-name"];
        const originalName =
          typeof openApiOriginalName === "string" && openApiOriginalName
            ? openApiOriginalName
            : originalBySanitized[toolName] ||
              originalBySanitized[toolName.toLowerCase()] ||
              toolName;
        const displayName =
          typeof openApiDisplayName === "string" && openApiDisplayName
            ? openApiDisplayName
            : displayByOriginal[originalName] ||
              displayByLower[originalName.toLowerCase()] ||
              null;
        tools.push({
          name: toolName,
          fullName: fullToolName,
          displayName,
          originalName,
          description: postDef?.description || postDef?.summary || "",
          enabled: true, // Will be updated based on config
          inputSchema: inputSchema, // Include input schema for testing pane
        });
      }
    }

    // Read disabled tools from config
    let disabledTools = [];
    try {
      if (fs.existsSync(toolsConfigPath)) {
        const configContent = await fsPromises.readFile(
          toolsConfigPath,
          "utf8",
        );
        const toolsConfig = JSON.parse(configContent);
        disabledTools = normalizeDisabledTools(
          serverId,
          toolsConfig[serverId]?.disabled_tools || [],
        );
      }
    } catch (configError) {
      console.warn(
        `[Tools] Could not read tools config: ${configError.message}`,
      );
    }

    // Add disabled tools back to the list (they won't be in OpenAPI since MCPO filters them out)
    // We need to include them so users can re-enable them
    // Note: Use normalized serverId (hyphens → underscores) to match MCPO's tool prefix format
    const normalizedServerIdForDisabled = serverId.replace(/-/g, "_");
    const existingOriginalNames = new Set(
      tools.map((t) => t.originalName || t.name),
    );
    for (const disabledToolName of disabledTools) {
      if (!existingOriginalNames.has(disabledToolName)) {
        const displayName =
          displayByOriginal[disabledToolName] ||
          displayByLower[disabledToolName.toLowerCase()] ||
          null;
        const renamedName = displayName
          ? sanitizeToolName(displayName)
          : disabledToolName;
        const safeRenamedName = renamedName || disabledToolName;
        tools.push({
          name: safeRenamedName,
          fullName: `${normalizedServerIdForDisabled}_${safeRenamedName}`,
          displayName,
          originalName: disabledToolName,
          description: "(Currently disabled)",
          enabled: false,
        });
      }
    }

    // Mark tools as enabled/disabled based on config
    for (const tool of tools) {
      const originalName = tool.originalName || tool.name;
      tool.enabled = !disabledTools.includes(originalName);
    }

    // Sort tools alphabetically by name for consistent display
    tools.sort((a, b) => a.name.localeCompare(b.name));

    const enabledCount = tools.filter((t) => t.enabled).length;
    const totalCount = tools.length;

    // Determine if this is a core server (tools cannot be disabled)
    const isCoreServer = port === 8766;

    console.log(
      `[Tools] ${serverId}: ${enabledCount}/${totalCount} tools enabled (port ${port}, core: ${isCoreServer})`,
    );

    const result = {
      success: true,
      tools,
      totalCount,
      enabledCount,
      disabledTools,
      port, // Return the port so frontend can use it for tool invocation
      isCoreServer, // Core servers cannot have tools disabled
    };
    cacheServerToolsResult(serverId, toolsConfigMtimeMs, result);
    return cloneToolsResult(result);
  } catch (error) {
    console.error(`[Tools] Failed to get tools for ${serverId}:`, error);
    return { success: false, error: error.message };
  }
}

/**
 * Save disabled tools configuration for a server and restart it
 * @param {string} serverId - The server ID (e.g., 'time', 'slack')
 * @param {string[]} disabledTools - Array of tool names to disable
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function saveServerTools(serverId, disabledTools) {
  const PROJECT_ROOT = getProjectRoot();
  const SCRIPTS_DIR = getScriptsDir();
  const toolsConfigPath = path.join(PROJECT_ROOT, "mcp_tools_config.json");

  try {
    // Read existing config
    let toolsConfig = {};
    try {
      if (fs.existsSync(toolsConfigPath)) {
        const configContent = await fsPromises.readFile(
          toolsConfigPath,
          "utf8",
        );
        toolsConfig = JSON.parse(configContent);
      }
    } catch (readError) {
      console.warn(
        `[Tools] Could not read existing config, starting fresh: ${readError.message}`,
      );
    }

    const normalizedDisabledTools = normalizeDisabledTools(
      serverId,
      disabledTools || [],
    );

    // Update config for this server
    toolsConfig[serverId] = {
      disabled_tools: normalizedDisabledTools,
    };

    // Write updated config
    await fsPromises.writeFile(
      toolsConfigPath,
      JSON.stringify(toolsConfig, null, 2),
      "utf8",
    );
    invalidateServerToolsCache(serverId);
    console.log(
      `[Tools] Saved tools config for ${serverId}: ${normalizedDisabledTools.length} tools disabled`,
    );

    // Regenerate the per-server config (which will pick up disabled_tools)
    const generationEnv = createEnhancedEnv();
    const { promisify } = require("util");
    const execAsync = promisify(exec);
    const generateCommand = await ensureMcpOrcGeneratorCommand(
      PROJECT_ROOT,
      "generate-docker-compose-override",
      {
        isPackagedApp: app.isPackaged,
        resourcesPath: process.resourcesPath,
        env: generationEnv,
        execAsync,
      },
    );
    console.log(`[Tools] Regenerating configs via ${generateCommand}`);

    await execAsync(generateCommand, {
      cwd: PROJECT_ROOT,
      env: generationEnv,
    });

    // Restart just this server
    console.log(`[Tools] Restarting container for ${serverId}...`);
    const restartResult = await restartMcpoServer(serverId);

    if (!restartResult.success) {
      return {
        success: false,
        error: `Config saved but restart failed: ${restartResult.error}`,
      };
    }

    return { success: true };
  } catch (error) {
    console.error(`[Tools] Failed to save tools for ${serverId}:`, error);
    return { success: false, error: error.message };
  }
}

/**
 * Invoke an MCP tool via MCPO endpoint for testing purposes
 * @param {string} serverId - The server ID (e.g., 'time', 'mcp-assistant')
 * @param {string} toolName - The full tool name from OpenAPI (e.g., 'time_get_current_time', 'mcp_assistant_list_mcp_servers')
 * @param {object} inputs - Input parameters for the tool
 * @param {number} [mcpoPort] - Optional MCPO port (if known from getServerTools)
 * @returns {Promise<{success: boolean, status?: number, data?: any, error?: string}>}
 */
async function invokeMcpTool(serverId, toolName, inputs, mcpoPort) {
  const PROJECT_ROOT = getProjectRoot();
  const healthStatusPath = path.join(
    PROJECT_ROOT,
    "health-status",
    "health_status.json",
  );

  try {
    // Use provided port or detect from health status
    let port = mcpoPort || 8765;

    if (!mcpoPort) {
      // Fallback: try to determine port from health status
      try {
        if (fs.existsSync(healthStatusPath)) {
          const healthContent = await fsPromises.readFile(
            healthStatusPath,
            "utf8",
          );
          const healthStatus = JSON.parse(healthContent);
          const serverHealth = healthStatus.servers?.[serverId];
          if (serverHealth?.deployment === "core") {
            port = 8766;
          } else if (serverHealth?.deployment === "host") {
            port = 8890;
          }
        }
      } catch (healthError) {
        console.warn(
          `[Tools] Could not read health status, using default port: ${healthError.message}`,
        );
      }
    }

    // URL format: /{serverId}/{fullToolName}
    // nginx routes /{serverId}/* to the appropriate mcpo-{serverId} container
    // toolName should be the full tool name from OpenAPI (e.g., "mcp_assistant_list_mcp_servers")
    const url = `http://localhost:${port}/${serverId}/${toolName}`;

    console.log(`[Tools] Invoking tool: ${url}`);
    // Shape only, never values: tool args can carry agent system prompts and
    // skill contents, and the console is captured into log files that ship
    // in bug reports.
    console.log(
      `[Tools] Input summary:`,
      JSON.stringify(
        require("./marketplace-diagnostics").summarizeToolInputs(inputs),
      ),
    );

    const startTime = Date.now();
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(inputs || {}),
    });

    const elapsed = Date.now() - startTime;
    let data;
    const contentType = response.headers.get("content-type");

    if (contentType && contentType.includes("application/json")) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    console.log(`[Tools] Response (${elapsed}ms): ${response.status}`);

    return {
      success: response.ok,
      status: response.status,
      statusText: response.statusText,
      data,
      elapsed,
    };
  } catch (error) {
    console.error(`[Tools] Failed to invoke ${serverId}/${toolName}:`, error);
    return {
      success: false,
      error: error.message,
    };
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // YAML/Env helpers
  parseYaml,
  parseEnvFile,
  serializeEnvFile,
  createEnhancedEnv,
  discoverOAuthServerIdsFromGeneratedConfigs,
  configSupportsNativeOAuth,
  ensureOAuthAccessTokenBridgeTokenEnv,
  findServerYaml,
  checkServerConfigured,

  // Status monitoring
  startStatusMonitoring,
  stopStatusMonitoring,
  checkDockerStatus,
  checkServicesNeedRestart,

  // Smart startup (source file change detection)
  checkSourceFilesChanged,
  saveSourceFilesHash,

  // Host MCPO
  startHostMcpo,
  stopHostMcpo,
  startHostMcpBridge,
  ensureHostMcpBridgeReady,
  stopHostMcpBridge,
  readHostMcpBridgePreferences,
  isHostMcpBridgeDesiredEnabled,
  setHostMcpBridgeDesiredEnabled,
  checkHostMcpServersConfigured,
  checkHostModeSupported,
  invalidateHostModeCaches,
  resolveHostNodeRuntime,

  // Health checks
  checkSingleServerHealth,
  beginTargetedMcpOperationPublication,
  endTargetedMcpOperationPublication,
  publishTargetedMcpReadiness,
  resetTargetedMcpOperationPublication,
  runHealthCheckAndBroadcast,
  runStartupCoreHealthGate,
  queueFullHealthCheck,
  startContinuousHealthChecks,
  stopContinuousHealthChecks,
  getLastHealthStatus,
  getHealthSyncState,
  clearMcpRuntimeStateForServer,
  clearStartupFailure,
  clearStartupFailures,
  overlayStartupFailures,
  publishStartupFailureState,
  recordStartupFailure,

  // Docker helpers
  ensureVolumeFilesExist,
  cleanupLegacyRequestPayloadsFromKnownRoots,
  cleanupLegacyRequestPayloadsFromGatewayMounts,
  cleanupLegacyRequestPayloadsFromKnownAndRememberedRoots,
  ensureDockerRunning,
  waitForDockerReady,
  restartOrbStackAndWaitForDocker,
  // PORTICO-373: bounded daemon probe, exported so teardown paths can tell a wedged
  // engine (accepts calls, never answers) apart from any other stop failure.
  probeDockerDaemon,
  executeWithStreaming,

  // Docker startup constants
  ORBSTACK_DOCKER_STARTUP_TIMEOUT_LABEL,

  // Config helpers
  applyPresetEnvVars,
  normalizeAndPersistMcpToggles,
  computeEffectiveMcpToggles,
  getMcpTogglesSync,
  loadRawMcpToggles,
  mutateMcpToggles,
  setMcpToggles,
  writeMcpTogglesAtomic,
  getMcpDisableModesPath,
  getMcpDisableModeSnapshotPath,
  loadRawMcpDisableModes,
  ensureMcpDisableModesSourceReady,
  writeMcpDisableModesAtomic,
  mutateMcpDisableModes,
  getMcpDisableModesSync,
  isServerHardDisabled,

  // MCP initialization
  runMcpInitialization,
  setResetConfigData,

  // Per-server MCPO lifecycle
  isKnownMcpServerId,
  isHostDeployedServer,
  isCoreServer,
  getConfiguredMcpoRuntimeTarget,
  getMcpoServerContainerCandidates,
  resolveConfiguredMcpoServerContainerName,
  resolveConfiguredMcpoServerContainerNameFromServices,
  getConfiguredComposeServices,
  restartMcpoServer,
  restartMcpoServers,
  restartAllMcpoServers,
  getMcpoServerStatus,
  listMcpoServers,

  // Tool configuration
  getServerTools,
  saveServerTools,
  invokeMcpTool,
};
