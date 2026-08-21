const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { resolveRuntimeModes } = require("./docker-image-plan");
const { parseIdentityEnv } = require("./identity-env");

const SETUP_REQUIREMENT_FILENAME = "setup-requirement.json";
const SETUP_COMPLETION_FILENAME = "setup-completion.json";
const SETUP_REQUIREMENT_SCHEMA_VERSION = 1;
const SETUP_COMPLETION_SCHEMA_VERSION = 1;
const PLACEHOLDER_USER_NAMES = new Set(["Your Full Name"]);

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function uniquePaths(values) {
  return Array.from(
    new Set(
      values.filter((value) => isNonEmptyString(value)).map((value) => path.resolve(value)),
    ),
  );
}

function getSetupRequirementCandidatePaths({ resourcesPath = null, appRoot = null } = {}) {
  return uniquePaths([
    resourcesPath ? path.join(resourcesPath, SETUP_REQUIREMENT_FILENAME) : null,
    appRoot ? path.join(appRoot, SETUP_REQUIREMENT_FILENAME) : null,
  ]);
}

function getSetupCompletionPath(userDataPath) {
  return path.join(userDataPath, SETUP_COMPLETION_FILENAME);
}

function normalizeSetupRequirementData(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { success: false, error: "setup requirement must be a JSON object" };
  }

  const schemaVersion = Number.parseInt(raw.schemaVersion, 10);
  if (schemaVersion !== SETUP_REQUIREMENT_SCHEMA_VERSION) {
    return {
      success: false,
      error: `unsupported setup requirement schemaVersion: ${raw.schemaVersion ?? "missing"}`,
    };
  }

  if (!isNonEmptyString(raw.setupRequirementId)) {
    return { success: false, error: "setupRequirementId must be a non-empty string" };
  }

  return {
    success: true,
    data: {
      schemaVersion: SETUP_REQUIREMENT_SCHEMA_VERSION,
      setupRequirementId: raw.setupRequirementId.trim(),
    },
  };
}

function defaultCompletionRecord() {
  return {
    schemaVersion: SETUP_COMPLETION_SCHEMA_VERSION,
    completedRequirements: {},
    lastCompletedRequirementId: null,
  };
}

function normalizeCompletionRecord(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { success: false, error: "setup completion record must be a JSON object" };
  }

  const schemaVersion = Number.parseInt(raw.schemaVersion, 10);
  if (schemaVersion !== SETUP_COMPLETION_SCHEMA_VERSION) {
    return {
      success: false,
      error: `unsupported setup completion schemaVersion: ${raw.schemaVersion ?? "missing"}`,
    };
  }

  if (
    !raw.completedRequirements ||
    typeof raw.completedRequirements !== "object" ||
    Array.isArray(raw.completedRequirements)
  ) {
    return {
      success: false,
      error: "completedRequirements must be a JSON object",
    };
  }

  const completedRequirements = {};
  const sourceCompletedRequirements = raw.completedRequirements;

  for (const [requirementId, entry] of Object.entries(sourceCompletedRequirements)) {
    if (!isNonEmptyString(requirementId)) {
      return { success: false, error: "completed requirement id must be non-empty" };
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return {
        success: false,
        error: `completion entry for ${requirementId} must be a JSON object`,
      };
    }
    if (!isNonEmptyString(entry.completedAt)) {
      return {
        success: false,
        error: `completion entry for ${requirementId} is missing completedAt`,
      };
    }
    if (!isNonEmptyString(entry.buildNumber)) {
      return {
        success: false,
        error: `completion entry for ${requirementId} is missing buildNumber`,
      };
    }

    const completedAt = entry.completedAt.trim();
    const buildNumber = entry.buildNumber.trim();

    completedRequirements[requirementId.trim()] = {
      completedAt,
      buildNumber,
    };
  }

  if (
    raw.lastCompletedRequirementId != null &&
    !isNonEmptyString(raw.lastCompletedRequirementId)
  ) {
    return {
      success: false,
      error: "lastCompletedRequirementId must be null or a non-empty string",
    };
  }
  const lastCompletedRequirementId = isNonEmptyString(raw.lastCompletedRequirementId)
    ? raw.lastCompletedRequirementId.trim()
    : null;
  if (
    lastCompletedRequirementId &&
    !Object.hasOwn(completedRequirements, lastCompletedRequirementId)
  ) {
    return {
      success: false,
      error: "lastCompletedRequirementId does not reference a completed requirement",
    };
  }

  return {
    success: true,
    data: {
      schemaVersion: SETUP_COMPLETION_SCHEMA_VERSION,
      completedRequirements,
      lastCompletedRequirementId,
    },
  };
}

function readJsonFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  return JSON.parse(content);
}

function loadCurrentSetupRequirement({ resourcesPath = null, appRoot = null } = {}) {
  const candidatePaths = getSetupRequirementCandidatePaths({ resourcesPath, appRoot });
  let lastError = "setup requirement manifest not found";

  for (const candidatePath of candidatePaths) {
    if (!fs.existsSync(candidatePath)) {
      continue;
    }

    try {
      const normalized = normalizeSetupRequirementData(readJsonFile(candidatePath));
      if (normalized.success) {
        return {
          success: true,
          path: candidatePath,
          data: normalized.data,
        };
      }
      lastError = normalized.error;
    } catch (error) {
      lastError = error.message;
    }
  }

  return {
    success: false,
    path: candidatePaths[0] || null,
    error: lastError,
  };
}

function readSetupCompletionRecord({ userDataPath }) {
  const recordPath = getSetupCompletionPath(userDataPath);
  if (!fs.existsSync(recordPath)) {
    return {
      success: true,
      exists: false,
      path: recordPath,
      data: defaultCompletionRecord(),
    };
  }

  try {
    const normalized = normalizeCompletionRecord(readJsonFile(recordPath));
    if (!normalized.success) {
      return {
        success: false,
        exists: true,
        path: recordPath,
        error: normalized.error,
      };
    }

    return {
      success: true,
      exists: true,
      path: recordPath,
      data: normalized.data,
    };
  } catch (error) {
    return {
      success: false,
      exists: true,
      path: recordPath,
      error: error.message,
    };
  }
}

function writeSetupCompletionRecord({ userDataPath, data }) {
  const recordPath = getSetupCompletionPath(userDataPath);
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return recordPath;
}

function markSetupRequirementCompleted({
  userDataPath,
  setupRequirementId,
  buildNumber = "unknown",
}) {
  if (!isNonEmptyString(userDataPath)) {
    return { success: false, error: "userDataPath is required" };
  }
  if (!isNonEmptyString(setupRequirementId)) {
    return { success: false, error: "setupRequirementId is required" };
  }

  const existingRecordResult = readSetupCompletionRecord({ userDataPath });
  if (!existingRecordResult.success) {
    return {
      success: false,
      error: existingRecordResult.error,
      path: existingRecordResult.path,
    };
  }

  const record = existingRecordResult.data;
  const normalizedRequirementId = setupRequirementId.trim();
  record.completedRequirements[normalizedRequirementId] = {
    completedAt: new Date().toISOString(),
    buildNumber: isNonEmptyString(buildNumber) ? buildNumber.trim() : "unknown",
  };
  record.lastCompletedRequirementId = normalizedRequirementId;

  const recordPath = writeSetupCompletionRecord({ userDataPath, data: record });
  return {
    success: true,
    path: recordPath,
    data: record,
  };
}

function inspectEnvSetupState({ projectRoot }) {
  const envPath = isNonEmptyString(projectRoot)
    ? path.join(projectRoot, ".env")
    : null;
  const result = {
    envPath,
    exists: false,
    empty: true,
    porticoUserId: null,
    porticoUserName: null,
    hasConfiguredUserId: false,
    hasConfiguredUserName: false,
    isComplete: false,
    reason: "env-missing",
  };

  if (!isNonEmptyString(projectRoot)) {
    result.reason = "project-root-missing";
    return result;
  }

  if (!fs.existsSync(envPath)) {
    return result;
  }

  result.exists = true;
  const envContent = fs.readFileSync(envPath, "utf8");
  if (!envContent.trim()) {
    result.reason = "env-empty";
    return result;
  }

  result.empty = false;
  const identity = parseIdentityEnv(envContent);
  result.porticoUserId = identity.userId;
  result.porticoUserName = identity.userName;

  if (
    !isNonEmptyString(result.porticoUserId) ||
    !isNonEmptyString(result.porticoUserName)
  ) {
    result.reason = "env-user-missing";
    return result;
  }

  if (PLACEHOLDER_USER_NAMES.has(result.porticoUserName)) {
    result.reason = "env-user-placeholder";
    return result;
  }

  result.hasConfiguredUserId = true;
  result.hasConfiguredUserName = true;
  result.isComplete = true;
  result.reason = null;
  return result;
}

function inspectRuntimeInstallationState({ projectRoot }) {
  const result = {
    projectRoot,
    isComplete: false,
    llmGatewayMode: "bifrost",
    missingPaths: [],
    reason: "runtime-missing",
  };

  if (!isNonEmptyString(projectRoot)) {
    result.reason = "project-root-missing";
    return result;
  }

  const { llmGatewayMode } = resolveRuntimeModes(projectRoot, process.env);
  result.llmGatewayMode = llmGatewayMode || "bifrost";

  const requiredPaths = [
    path.join(projectRoot, "docker-compose.yml"),
    path.join(projectRoot, "docker-compose.advanced.yml"),
    path.join(projectRoot, "cloudsmith.env"),
    path.join(projectRoot, "electron-app", "build-info.json"),
    path.join(projectRoot, "src", "scripts", "docker-compose.sh"),
  ];

  result.missingPaths = requiredPaths.filter((requiredPath) => !fs.existsSync(requiredPath));
  if (result.missingPaths.length > 0) {
    result.reason = "runtime-file-missing";
    return result;
  }

  result.isComplete = true;
  result.reason = null;
  return result;
}

function readManagedRuntimeBuildNumber({ projectRoot }) {
  if (!isNonEmptyString(projectRoot)) {
    return "unknown";
  }

  try {
    const buildInfoPath = path.join(projectRoot, "electron-app", "build-info.json");
    const buildInfo = readJsonFile(buildInfoPath);
    return isNonEmptyString(buildInfo?.buildNumber)
      ? buildInfo.buildNumber.trim()
      : "unknown";
  } catch (_error) {
    return "unknown";
  }
}

function runHostPrerequisiteProbe(spawnSyncRef, command, args) {
  const result = spawnSyncRef(command, args, {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  const stdout = typeof result?.stdout === "string" ? result.stdout.trim() : "";
  const stderr = typeof result?.stderr === "string" ? result.stderr.trim() : "";

  return {
    success: !result?.error && result?.status === 0,
    status: Number.isInteger(result?.status) ? result.status : null,
    stdout,
    stderr,
    output: stdout || stderr || result?.error?.message || "",
  };
}

function inspectAppleDeveloperToolsState({
  platform = process.platform,
  spawnSyncRef = spawnSync,
} = {}) {
  const result = {
    required: platform === "darwin",
    isComplete: platform !== "darwin",
    selectedDeveloperDir: null,
    staplerPath: null,
    reason: platform === "darwin" ? "command-line-tools-unavailable" : null,
    reasonMessage: null,
    probeStatus: null,
  };

  if (!result.required) {
    return result;
  }

  const selectionProbe = runHostPrerequisiteProbe(
    spawnSyncRef,
    "/usr/bin/xcode-select",
    ["-p"],
  );
  result.probeStatus = selectionProbe.status;
  if (!selectionProbe.success || !isNonEmptyString(selectionProbe.stdout)) {
    result.reasonMessage =
      "Apple Command Line Tools are missing or incomplete. Finish Apple's Command Line Tools installation, then retry setup.";
    return result;
  }

  result.selectedDeveloperDir = selectionProbe.stdout;
  const staplerProbe = runHostPrerequisiteProbe(
    spawnSyncRef,
    "/usr/bin/xcrun",
    ["--find", "stapler"],
  );
  result.probeStatus = staplerProbe.status;
  if (!staplerProbe.success || !isNonEmptyString(staplerProbe.stdout)) {
    result.reasonMessage =
      `The selected Apple developer tools at ${result.selectedDeveloperDir} cannot run stapler. Repair or reinstall Command Line Tools, then retry setup.`;
    return result;
  }

  result.isComplete = true;
  result.staplerPath = staplerProbe.stdout;
  result.reason = null;
  result.reasonMessage = null;
  return result;
}

function inspectOrbStackInstallationState({
  platform = process.platform,
  homeDir = os.homedir(),
  appPaths = null,
} = {}) {
  const result = {
    required: platform === "darwin",
    isComplete: platform !== "darwin",
    appPath: null,
    orbctlPath: null,
    reason: platform === "darwin" ? "orbstack-unavailable" : null,
    reasonMessage: null,
  };

  if (!result.required) {
    return result;
  }

  const candidates = Array.isArray(appPaths) && appPaths.length > 0
    ? appPaths
    : [
      "/Applications/OrbStack.app",
      path.join(homeDir, "Applications", "OrbStack.app"),
    ];

  for (const appPath of candidates) {
    const orbctlPath = path.join(appPath, "Contents", "MacOS", "bin", "orbctl");
    try {
      fs.accessSync(orbctlPath, fs.constants.X_OK);
      result.isComplete = true;
      result.appPath = appPath;
      result.orbctlPath = orbctlPath;
      result.reason = null;
      return result;
    } catch (_error) {
      // Try the next supported installation location.
    }
  }

  result.reasonMessage =
    "OrbStack is missing or incomplete. Return to guided setup and finish the OrbStack installation.";
  return result;
}

function inspectRequiredHostPrerequisites(options = {}) {
  const developerTools = inspectAppleDeveloperToolsState(options);
  const orbStack = inspectOrbStackInstallationState(options);
  const failed = [developerTools, orbStack].find((entry) => !entry.isComplete) || null;

  return {
    isComplete: !failed,
    reason: failed?.reason || null,
    reasonMessage: failed?.reasonMessage || null,
    developerTools,
    orbStack,
  };
}

function validateSetupCompletionPrerequisites({ projectRoot, ...options }) {
  const hostPrerequisites = inspectRequiredHostPrerequisites(options);
  const env = inspectEnvSetupState({ projectRoot });
  const runtime = inspectRuntimeInstallationState({ projectRoot });

  if (!hostPrerequisites.isComplete) {
    return {
      success: false,
      reason: hostPrerequisites.reason,
      error: hostPrerequisites.reasonMessage,
      hostPrerequisites,
      env,
      runtime,
    };
  }
  if (!env.isComplete) {
    return {
      success: false,
      reason: env.reason,
      error: `Managed runtime configuration is incomplete: ${env.reason}`,
      hostPrerequisites,
      env,
      runtime,
    };
  }
  if (!runtime.isComplete) {
    return {
      success: false,
      reason: runtime.reason,
      error: `Managed runtime installation is incomplete: ${runtime.missingPaths.join(", ")}`,
      hostPrerequisites,
      env,
      runtime,
    };
  }

  return {
    success: true,
    reason: null,
    error: null,
    hostPrerequisites,
    env,
    runtime,
  };
}

function evaluateSetupRequirementStatus({
  projectRoot,
  userDataPath,
  resourcesPath = null,
  appRoot = null,
  platform = process.platform,
  spawnSyncRef = spawnSync,
  homeDir = os.homedir(),
  orbStackAppPaths = null,
}) {
  const requirement = loadCurrentSetupRequirement({ resourcesPath, appRoot });
  const completion = isNonEmptyString(userDataPath)
    ? readSetupCompletionRecord({ userDataPath })
    : { success: false, exists: false, path: null, error: "userDataPath is required" };
  const env = inspectEnvSetupState({ projectRoot });
  const runtime = inspectRuntimeInstallationState({ projectRoot });
  const hostPrerequisites = inspectRequiredHostPrerequisites({
    platform,
    spawnSyncRef,
    homeDir,
    appPaths: orbStackAppPaths,
  });

  if (!requirement.success) {
    return {
      needsSetup: true,
      reason: "setup-requirement-missing",
      reasonMessage: requirement.error,
      requirement,
      completion,
      env,
      runtime,
      hostPrerequisites,
    };
  }

  if (!completion.success) {
    return {
      needsSetup: true,
      reason: "setup-completion-invalid",
      reasonMessage: completion.error,
      requirement,
      completion,
      env,
      runtime,
      hostPrerequisites,
    };
  }

  if (
    !isNonEmptyString(projectRoot) ||
    !fs.existsSync(projectRoot) ||
    !fs.statSync(projectRoot).isDirectory()
  ) {
    return {
      needsSetup: true,
      reason: "project-root-missing",
      reasonMessage: "managed project root is missing or invalid",
      requirement,
      completion,
      env,
      runtime,
      hostPrerequisites,
      setupRequirementId: requirement.data.setupRequirementId,
    };
  }

  const setupRequirementId = requirement.data.setupRequirementId;
  let effectiveCompletion = completion;
  let completedEntry = effectiveCompletion.data.completedRequirements[setupRequirementId] || null;
  let backfilledCompletion = false;

  if (!completedEntry && !hostPrerequisites.isComplete) {
    return {
      needsSetup: true,
      reason: hostPrerequisites.reason,
      reasonMessage: hostPrerequisites.reasonMessage,
      requirement,
      completion: effectiveCompletion,
      env,
      runtime,
      hostPrerequisites,
      setupRequirementId,
    };
  }

  if (
    !completedEntry &&
    effectiveCompletion.exists === false &&
    env.isComplete &&
    runtime.isComplete &&
    hostPrerequisites.isComplete
  ) {
    const backfill = markSetupRequirementCompleted({
      userDataPath,
      setupRequirementId,
      buildNumber: readManagedRuntimeBuildNumber({ projectRoot }),
    });
    if (!backfill.success) {
      return {
        needsSetup: true,
        reason: "setup-completion-invalid",
        reasonMessage: backfill.error || "failed to backfill setup completion",
        requirement,
        completion: {
          ...effectiveCompletion,
          error: backfill.error,
        },
        env,
        runtime,
        hostPrerequisites,
        setupRequirementId,
      };
    }

    effectiveCompletion = {
      success: true,
      exists: true,
      path: backfill.path,
      data: backfill.data,
    };
    completedEntry = effectiveCompletion.data.completedRequirements[setupRequirementId] || null;
    backfilledCompletion = true;
  }

  if (!completedEntry) {
    return {
      needsSetup: true,
      reason: "setup-not-completed",
      reasonMessage: `setup requirement ${setupRequirementId} has not been completed`,
      requirement,
      completion: effectiveCompletion,
      env,
      runtime,
      hostPrerequisites,
      setupRequirementId,
    };
  }

  if (!hostPrerequisites.isComplete) {
    return {
      needsSetup: true,
      reason: hostPrerequisites.reason,
      reasonMessage: hostPrerequisites.reasonMessage,
      requirement,
      completion: effectiveCompletion,
      env,
      runtime,
      hostPrerequisites,
      setupRequirementId,
    };
  }

  if (!env.isComplete) {
    return {
      needsSetup: true,
      reason: env.reason,
      reasonMessage: `managed runtime configuration is incomplete: ${env.reason}`,
      requirement,
      completion: effectiveCompletion,
      env,
      runtime,
      hostPrerequisites,
      setupRequirementId,
    };
  }

  if (!runtime.isComplete) {
    return {
      needsSetup: true,
      reason: runtime.reason,
      reasonMessage: `managed runtime installation is incomplete: ${runtime.missingPaths.join(", ")}`,
      requirement,
      completion: effectiveCompletion,
      env,
      runtime,
      hostPrerequisites,
      setupRequirementId,
    };
  }

  return {
    needsSetup: false,
    reason: null,
    reasonMessage: null,
    requirement,
    completion: effectiveCompletion,
    env,
    runtime,
    hostPrerequisites,
    setupRequirementId,
    backfilledCompletion,
  };
}

module.exports = {
  SETUP_REQUIREMENT_FILENAME,
  SETUP_COMPLETION_FILENAME,
  SETUP_REQUIREMENT_SCHEMA_VERSION,
  SETUP_COMPLETION_SCHEMA_VERSION,
  getSetupRequirementCandidatePaths,
  getSetupCompletionPath,
  loadCurrentSetupRequirement,
  readSetupCompletionRecord,
  markSetupRequirementCompleted,
  inspectEnvSetupState,
  inspectRuntimeInstallationState,
  readManagedRuntimeBuildNumber,
  inspectAppleDeveloperToolsState,
  inspectOrbStackInstallationState,
  inspectRequiredHostPrerequisites,
  validateSetupCompletionPrerequisites,
  evaluateSetupRequirementStatus,
};
