const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  getFragmentPathForServerYaml,
} = require("./mcp-bulk-toggle-results");
const {
  isSensitiveRuntimeFileStubContent,
  isSensitiveRuntimeFilePersisted,
  runtimeFileSensitiveFlag,
} = require("../config/runtime-secrets-config");
const {
  getServerConfigStatusPath,
  loadServerConfigStatuses,
} = require("./runtime-file-status");

const DEFAULT_ENABLE_TOGGLE_FAST_FAIL_MS = 30000;
const DEFAULT_ENABLE_TOGGLE_POLL_INTERVAL_MS = 250;
const DEFAULT_ENABLE_TOGGLE_ACTIONABLE_PHASES = Object.freeze([
  "tool_ready",
  "checking_tokens",
  "needs_oauth",
  "waiting_callback",
]);
const SAVED_SECRET_UNAVAILABLE_ERROR_CODE = "SAVED_SECRET_UNAVAILABLE";
const SAVED_SECRET_UNAVAILABLE_ISSUE = "saved_secret_unavailable";
const SNOWFLAKE_SECRET_RECOVERY_PROMPT =
  "My Snowflake token is broken. Help me replace it with a fresh token.";
const { canonicalizeReadinessPhase } = require("./readiness-phase");

function sleepFor(ms, sleepImpl = null) {
  if (typeof sleepImpl === "function") {
    return sleepImpl(ms);
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeDelayMs(value, fallbackMs) {
  const parsed = Number.parseInt(String(value ?? fallbackMs), 10);
  if (!Number.isFinite(parsed)) {
    return fallbackMs;
  }
  return Math.max(0, parsed);
}

function normalizeReadinessPhase(readiness) {
  if (!readiness || typeof readiness !== "object") {
    return null;
  }
  return canonicalizeReadinessPhase(readiness);
}

function isActionableEnableReadiness(readiness, acceptablePhases = null) {
  if (!readiness || typeof readiness !== "object") {
    return false;
  }

  if (readiness.healthy === true) {
    return true;
  }

  const phases = Array.isArray(acceptablePhases) && acceptablePhases.length > 0
    ? acceptablePhases
    : DEFAULT_ENABLE_TOGGLE_ACTIONABLE_PHASES;
  const readinessPhase = normalizeReadinessPhase(readiness);
  return typeof readinessPhase === "string" && phases.includes(readinessPhase);
}

async function awaitEnableToggleFastFail(lifecyclePromise, options = {}) {
  if (!lifecyclePromise || typeof lifecyclePromise.then !== "function") {
    throw new TypeError("lifecyclePromise (Promise) is required");
  }

  const fastFailMs = normalizeDelayMs(
    options.fastFailMs,
    DEFAULT_ENABLE_TOGGLE_FAST_FAIL_MS,
  );

  return Promise.race([
    lifecyclePromise.then((result) => ({ settled: true, result })),
    sleepFor(fastFailMs, options.sleep).then(() => ({ settled: false })),
  ]);
}

async function resolveEnableToggleLifecycleResult(lifecyclePromise, options = {}) {
  if (!lifecyclePromise || typeof lifecyclePromise.then !== "function") {
    throw new TypeError("lifecyclePromise (Promise) is required");
  }
  if (typeof options.getReadiness !== "function") {
    throw new TypeError("getReadiness (function) is required");
  }

  const responseDeadlineMs = normalizeDelayMs(
    options.responseDeadlineMs ?? options.fastFailMs,
    DEFAULT_ENABLE_TOGGLE_FAST_FAIL_MS,
  );
  const pollIntervalMs = Math.max(
    1,
    normalizeDelayMs(
      options.pollIntervalMs,
      DEFAULT_ENABLE_TOGGLE_POLL_INTERVAL_MS,
    ),
  );
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const acceptablePhases =
    Array.isArray(options.acceptableReadinessPhases)
      && options.acceptableReadinessPhases.length > 0
      ? [...options.acceptableReadinessPhases]
      : [...DEFAULT_ENABLE_TOGGLE_ACTIONABLE_PHASES];

  let latestReadiness = options.initialReadiness || null;
  const startedAt = now();
  const trackedLifecyclePromise = Promise.resolve(lifecyclePromise).then(
    (result) => ({
      source: "lifecycle",
      lifecycleResult: result,
      lifecycleError: null,
    }),
    (error) => ({
      source: "lifecycle",
      lifecycleResult: {
        success: false,
        error: error?.message || String(error),
      },
      lifecycleError: error,
    }),
  );
  let settledLifecycleResult = null;
  let settledLifecycleError = null;

  while (true) {
    const elapsedMs = Math.max(0, now() - startedAt);
    if (isActionableEnableReadiness(latestReadiness, acceptablePhases)) {
      return {
        source: "readiness",
        lifecycleResult: settledLifecycleResult,
        lifecycleError: settledLifecycleError,
        readinessResult: latestReadiness,
        elapsedMs,
      };
    }

    if (elapsedMs >= responseDeadlineMs) {
      return {
        source: "deadline",
        lifecycleResult: settledLifecycleResult,
        lifecycleError: settledLifecycleError,
        readinessResult: latestReadiness,
        elapsedMs,
      };
    }

    const remainingMs = Math.max(1, responseDeadlineMs - elapsedMs);
    const raceResult = await Promise.race([
      ...(settledLifecycleResult == null && settledLifecycleError == null
        ? [trackedLifecyclePromise]
        : []),
      sleepFor(Math.min(pollIntervalMs, remainingMs), options.sleep).then(() => ({
        source: "poll",
      })),
    ]);

    if (raceResult.source === "lifecycle") {
      settledLifecycleResult = raceResult.lifecycleResult;
      settledLifecycleError = raceResult.lifecycleError;
      if (!raceResult.lifecycleResult?.success) {
        return {
          source: "lifecycle",
          lifecycleResult: raceResult.lifecycleResult,
          lifecycleError: raceResult.lifecycleError,
          readinessResult: latestReadiness,
          elapsedMs: Math.max(0, now() - startedAt),
        };
      }
      try {
        const readiness = await options.getReadiness();
        if (readiness && typeof readiness === "object") {
          latestReadiness = readiness;
        }
      } catch (_error) {
        // Keep polling until the response deadline expires. A successful
        // lifecycle result should still surface the freshest readiness we can
        // observe before replying.
      }
      continue;
    }

    try {
      const readiness = await options.getReadiness();
      if (readiness && typeof readiness === "object") {
        latestReadiness = readiness;
      }
    } catch (_error) {
      // Ignore transient readiness fetch failures and keep polling until either
      // the lifecycle settles or the response deadline expires.
    }
  }
}

function loadProjectEnvVars(projectRoot, options = {}) {
  const fsModule = options.fsModule || fs;
  const parseEnvFile = options.parseEnvFile;

  if (typeof parseEnvFile !== "function") {
    throw new TypeError("parseEnvFile (function) is required");
  }

  const envPath = path.join(projectRoot, ".env");
  if (!fsModule.existsSync(envPath)) {
    return {};
  }

  try {
    return parseEnvFile(fsModule.readFileSync(envPath, "utf8"));
  } catch (_error) {
    return {};
  }
}

function buildConfigPreflightIssue(serverId, error, options = {}) {
  return {
    errorCode: options.errorCode || "INVALID_RUNTIME_FILES",
    error,
    message:
      options.message || `Server ${serverId} has invalid runtime_files configuration.`,
    stage: options.stage || "config_generation",
    source: options.source || "config",
    ...(options.configPath ? { configPath: options.configPath } : {}),
  };
}

function expandRuntimeFileSource(projectRoot, rawSource, options = {}) {
  const source = String(rawSource || "").trim();
  if (!source) {
    throw new Error("runtime_files source is required");
  }

  if (source === "~" || source.startsWith("~/")) {
    const homeDir = options.homeDir || os.homedir() || process.env.HOME;
    if (!homeDir) {
      throw new Error(`runtime_files source '${source}' uses '~' but HOME is not set`);
    }
    return source === "~"
      ? path.resolve(homeDir)
      : path.join(homeDir, source.slice(2));
  }

  if (source.startsWith("~")) {
    throw new Error(
      `runtime_files source '${source}' uses unsupported '~user' expansion`,
    );
  }

  return path.isAbsolute(source)
    ? source
    : path.join(projectRoot, source);
}

function runtimeFileFilename(sourcePath, configuredFilename = null) {
  const filename =
    typeof configuredFilename === "string" && configuredFilename.trim()
      ? configuredFilename.trim()
      : path.basename(sourcePath);
  if (
    !filename ||
    filename === "." ||
    filename === ".." ||
    filename.includes("/") ||
    filename.includes("\\") ||
    path.basename(filename) !== filename
  ) {
    throw new Error(`runtime_files filename '${filename}' must be a simple filename`);
  }
  return filename;
}

function validateRuntimeFileTarget(target) {
  const normalizedTarget = String(target || "").trim();
  if (!normalizedTarget || !normalizedTarget.startsWith("/")) {
    throw new Error("runtime_files target must be an absolute container file path");
  }
  if (normalizedTarget.includes("\\") || normalizedTarget.includes(":")) {
    throw new Error("runtime_files target contains unsupported characters");
  }
  if (
    normalizedTarget
      .split("/")
      .some((segment) => segment === "..")
  ) {
    throw new Error("runtime_files target must not contain '..'");
  }
  const filename = path.posix.basename(normalizedTarget);
  if (
    normalizedTarget.endsWith("/") ||
    !filename ||
    filename === "." ||
    filename === ".."
  ) {
    throw new Error("runtime_files target must include a file name");
  }
  return normalizedTarget;
}

function runtimeFileTargetPath(sourcePath, runtimeFile) {
  const filename =
    typeof runtimeFile.filename === "string" ? runtimeFile.filename.trim() : "";
  const target =
    typeof runtimeFile.target === "string" ? runtimeFile.target.trim() : "";

  if (target) {
    if (filename) {
      throw new Error("runtime_files target cannot be combined with filename");
    }
    return validateRuntimeFileTarget(target);
  }

  return `/app/runtime/${runtimeFileFilename(sourcePath, filename)}`;
}

function runtimeFileMissingReason(missingSources) {
  if (missingSources.length === 1) {
    return `Missing runtime file: ${missingSources[0]}`;
  }
  return `Missing runtime files: ${missingSources.join(", ")}`;
}

function buildSavedSecretUnavailableIssue(serverId, options = {}) {
  const normalizedServerId = String(serverId || "").trim();
  const isSnowflake = normalizedServerId === "snowflake";
  const displayName = isSnowflake ? "Snowflake" : normalizedServerId || "MCP";
  const savedConfiguration = isSnowflake
    ? "saved Snowflake connection"
    : `saved ${displayName} configuration`;
  const message = `The ${savedConfiguration} is unavailable. Replace it securely before testing or enabling ${displayName}.`;

  return {
    errorCode: SAVED_SECRET_UNAVAILABLE_ERROR_CODE,
    configurationIssue: SAVED_SECRET_UNAVAILABLE_ISSUE,
    requiresConfiguration: true,
    requiresSecretReplacement: true,
    requiredAction: "replace_saved_secret",
    severity: "warning",
    error: message,
    message,
    stage: "config_preflight",
    source: "secure_storage",
    retryable: false,
    ...(isSnowflake
      ? {
          recoveryPrompt: SNOWFLAKE_SECRET_RECOVERY_PROMPT,
          recoveryLabel: "Replace Snowflake connection in chat",
        }
      : {}),
    ...(options.configPath ? { configPath: options.configPath } : {}),
  };
}

function isSavedSecretUnavailableIssue(issue) {
  return Boolean(
    issue &&
      (issue.errorCode === SAVED_SECRET_UNAVAILABLE_ERROR_CODE ||
        issue.configurationIssue === SAVED_SECRET_UNAVAILABLE_ISSUE),
  );
}

function isConfigurationRequiredPreflightIssue(issue) {
  return Boolean(
    issue &&
      (issue.errorCode === "NOT_CONFIGURED" ||
        issue.errorCode === "INVALID_USER_SERVER_CONFIG" ||
        isSavedSecretUnavailableIssue(issue)),
  );
}

function formatYamlParseFailure(yamlPath, error) {
  const reason = String(error?.reason || error?.message || "unknown parser error")
    .split("\n", 1)[0]
    .trim();
  const line = Number(error?.mark?.line);
  const column = Number(error?.mark?.column);
  const location =
    Number.isFinite(line) && Number.isFinite(column)
      ? ` at line ${line + 1} column ${column + 1}`
      : "";
  return `invalid YAML in ${yamlPath}: ${reason}${location}`;
}

function currentGeneratedYamlFailure(
  projectRoot,
  serverId,
  yamlPath,
  fsModule = fs,
) {
  try {
    const statusPath = getServerConfigStatusPath(projectRoot);
    const yamlModifiedAt = fsModule.statSync(yamlPath).mtimeMs;
    const statusModifiedAt = fsModule.statSync(statusPath).mtimeMs;
    if (statusModifiedAt < yamlModifiedAt) {
      return null;
    }

    const status = loadServerConfigStatuses(projectRoot, {
      fsModule,
      serverConfigStatusPath: statusPath,
    })[serverId];
    if (
      status?.errorCode !== "INVALID_USER_SERVER_CONFIG" ||
      !status.error ||
      !status.error.includes(yamlPath)
    ) {
      return null;
    }
    return status.error;
  } catch (_error) {
    return null;
  }
}

function detectRuntimeFilePreflightIssue(serverId, serverData, options = {}) {
  const runtimeFiles = serverData?.runtime_files;
  if (runtimeFiles == null) {
    return null;
  }
  if (!Array.isArray(runtimeFiles)) {
    return buildConfigPreflightIssue(serverId, "runtime_files must be a list", options);
  }

  const {
    projectRoot,
    fsModule = fs,
  } = options;
  const seenTargets = new Set();
  const missingSources = [];
  const unavailableSavedSecretSources = [];

  for (const entry of runtimeFiles) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return buildConfigPreflightIssue(
        serverId,
        "runtime_files entries must be mappings",
        options,
      );
    }
    const source = String(entry.source || "").trim();
    let sourcePath;
    let target;
    let sensitive;
    try {
      sourcePath = expandRuntimeFileSource(projectRoot, source, options);
      target = runtimeFileTargetPath(sourcePath, entry);
      sensitive = runtimeFileSensitiveFlag(entry);
    } catch (error) {
      return buildConfigPreflightIssue(serverId, error.message, options);
    }
    const sensitiveRuntimeFilePersisted = () =>
      sensitive &&
      (typeof options.isSensitiveRuntimeFilePersisted === "function"
        ? options.isSensitiveRuntimeFilePersisted({ serverId, target, source })
        : isSensitiveRuntimeFilePersisted({
            serverId,
            target,
            env: options.env || process.env,
            homeDir: options.homeDir,
          }));

    if (seenTargets.has(target)) {
      return buildConfigPreflightIssue(
        serverId,
        `duplicate runtime_files target '${target}'`,
        options,
      );
    }
    seenTargets.add(target);

    try {
      const canonicalPath =
        typeof fsModule.realpathSync === "function"
          ? fsModule.realpathSync(sourcePath)
          : sourcePath;
      const metadata = fsModule.statSync(canonicalPath);
      if (!metadata.isFile()) {
        return buildConfigPreflightIssue(
          serverId,
          `runtime_files source '${source}' must be a regular file`,
          options,
        );
      }
      if (
        sensitive &&
        typeof fsModule.readFileSync === "function" &&
        isSensitiveRuntimeFileStubContent(fsModule.readFileSync(canonicalPath))
      ) {
        if (sensitiveRuntimeFilePersisted()) {
          continue;
        }
        unavailableSavedSecretSources.push(source);
        continue;
      }
    } catch (error) {
      if (error?.code === "ENOENT") {
        if (sensitiveRuntimeFilePersisted()) {
          continue;
        }
        missingSources.push(source);
        continue;
      }
      return buildConfigPreflightIssue(
        serverId,
        `runtime_files source '${source}' metadata could not be read: ${error.message}`,
        options,
      );
    }
  }

  if (unavailableSavedSecretSources.length > 0) {
    return buildSavedSecretUnavailableIssue(serverId, options);
  }

  if (missingSources.length > 0) {
    const error = runtimeFileMissingReason(missingSources);
    return {
      errorCode: "NOT_CONFIGURED",
      error,
      message: `Server ${serverId} is not configured (${error}). Use Configure to create the required runtime file(s).`,
      stage: "config_generation",
      source: "config",
      ...(options.configPath ? { configPath: options.configPath } : {}),
    };
  }

  return null;
}

function detectToggleEnablePreflightIssue(serverId, options = {}) {
  const {
    projectRoot,
    findServerYaml,
    parseYaml,
    parseEnvFile,
    checkServerConfigured,
    fsModule = fs,
  } = options;

  if (!projectRoot || typeof projectRoot !== "string") {
    throw new TypeError("projectRoot (string) is required");
  }
  if (typeof findServerYaml !== "function") {
    throw new TypeError("findServerYaml (function) is required");
  }
  if (typeof parseYaml !== "function") {
    throw new TypeError("parseYaml (function) is required");
  }
  if (typeof parseEnvFile !== "function") {
    throw new TypeError("parseEnvFile (function) is required");
  }
  if (typeof checkServerConfigured !== "function") {
    throw new TypeError("checkServerConfigured (function) is required");
  }

  const yamlPath = findServerYaml(serverId);
  if (!yamlPath) {
    return {
      errorCode: "SERVICE_NOT_FOUND",
      error: `Server definition not found for ${serverId}`,
      message: `Server ${serverId} could not be found on disk.`,
    };
  }

  let serverData;
  try {
    serverData =
      parseYaml(fsModule.readFileSync(yamlPath, "utf8"), {
        throwOnError: true,
      }) || {};
  } catch (error) {
    const isUserServer = yamlPath
      .split(path.sep)
      .includes("mcp-configs-user");
    const message =
      currentGeneratedYamlFailure(
        projectRoot,
        serverId,
        yamlPath,
        fsModule,
      ) || formatYamlParseFailure(yamlPath, error);
    return {
      errorCode: isUserServer
        ? "INVALID_USER_SERVER_CONFIG"
        : "INVALID_SERVER_CONFIG",
      configurationIssue: "invalid_server_config",
      requiresConfiguration: isUserServer,
      requiredAction: isUserServer ? "configure" : null,
      severity: "error",
      error: message,
      message,
      stage: "config_generation",
      source: "config",
      retryable: false,
      configPath: yamlPath,
    };
  }

  const fragmentPath = getFragmentPathForServerYaml(yamlPath, serverId);
  if (fragmentPath && fsModule.existsSync(fragmentPath)) {
    try {
      JSON.parse(fsModule.readFileSync(fragmentPath, "utf8"));
    } catch (error) {
      return {
        errorCode: "INVALID_FRAGMENT_JSON",
        error: `Invalid JSON in fragment for ${serverId}: ${error.message}`,
        message: `Server ${serverId} has invalid JSON in ${fragmentPath}.`,
        stage: "config_generation",
        source: "config",
        configPath: fragmentPath,
      };
    }
  }

  const runtimeFileIssue = detectRuntimeFilePreflightIssue(serverId, serverData, {
    projectRoot,
    fsModule,
    homeDir: options.homeDir,
    env: options.env,
    isSensitiveRuntimeFilePersisted:
      options.isSensitiveRuntimeFilePersisted,
    configPath: yamlPath,
  });
  if (runtimeFileIssue) {
    return runtimeFileIssue;
  }

  const envData = loadProjectEnvVars(projectRoot, {
    fsModule,
    parseEnvFile,
  });
  if (!checkServerConfigured(serverData, envData)) {
    return {
      errorCode: "NOT_CONFIGURED",
      error: `Server ${serverId} is missing required environment variables`,
      message: `Server ${serverId} is not configured (missing required environment variables). Use trigger_guided_setup to open the configuration form.`,
    };
  }

  return null;
}

function buildStartingToggleReadiness(enabled) {
  return {
    healthy: false,
    readinessPhase: enabled ? "starting" : "disabled",
  };
}

module.exports = {
  DEFAULT_ENABLE_TOGGLE_FAST_FAIL_MS,
  DEFAULT_ENABLE_TOGGLE_POLL_INTERVAL_MS,
  awaitEnableToggleFastFail,
  resolveEnableToggleLifecycleResult,
  buildStartingToggleReadiness,
  buildSavedSecretUnavailableIssue,
  detectRuntimeFilePreflightIssue,
  detectToggleEnablePreflightIssue,
  isConfigurationRequiredPreflightIssue,
  isSavedSecretUnavailableIssue,
  isActionableEnableReadiness,
  SAVED_SECRET_UNAVAILABLE_ERROR_CODE,
  SAVED_SECRET_UNAVAILABLE_ISSUE,
  SNOWFLAKE_SECRET_RECOVERY_PROMPT,
};
