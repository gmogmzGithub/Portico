const fs = require("fs");
const path = require("path");

const { createEnhancedEnv } = require("./env-paths");
const { runManagedProcess } = require("./managed-process");

const CLEANUP_TIMEOUT_MS = 120000;
const DOCKER_PROBE_TIMEOUT_MS = 15000;
const RELEASE_TAG_PATTERN = /^[0-9]{8}-[0-9a-f]+$/;

let maintenanceQueue = Promise.resolve();

function resolveMaintenanceScript(scriptName, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const projectRoot = options.projectRoot;
  const resourcesPath = options.resourcesPath;
  const candidates = [];

  // Packaged callers pass resourcesPath so the maintenance implementation is
  // version-locked to the running app, rather than a stale managed-runtime
  // copy left by the prior release. Source callers fall back to projectRoot.
  if (resourcesPath) {
    candidates.push(
      path.join(resourcesPath, "prereq-scripts", scriptName),
      path.join(resourcesPath, "app.asar.unpacked", "prereq-scripts", scriptName),
      path.join(resourcesPath, "app.asar.unpacked", "src", "scripts", scriptName),
    );
  }
  if (projectRoot) {
    candidates.push(path.join(projectRoot, "src", "scripts", scriptName));
  }

  return candidates.find((candidate) => fsImpl.existsSync(candidate)) || null;
}

function emitCapturedOutput(output, type, onLog) {
  if (typeof onLog !== "function" || !output) return;
  for (const line of String(output).split(/\r?\n/)) {
    if (line.trim()) onLog(line, type);
  }
}

async function runMaintenanceCommand(options) {
  const runProcess = options.runProcess || runManagedProcess;
  try {
    const result = await runProcess("bash", [options.scriptPath, ...options.args], {
      cwd: options.projectRoot,
      env: createEnhancedEnv({
        PORTICO_MANAGED_DIR: options.projectRoot,
      }),
      timeoutMs: options.timeoutMs,
      maxBufferBytes: options.maxBufferBytes ?? 10 * 1024 * 1024,
    });
    emitCapturedOutput(result.stdout, "info", options.onLog);
    emitCapturedOutput(result.stderr, "warning", options.onLog);
    return { success: true, code: 0 };
  } catch (error) {
    emitCapturedOutput(error.stdout, "info", options.onLog);
    emitCapturedOutput(error.stderr, "warning", options.onLog);
    return {
      success: false,
      code: Number.isInteger(error.code) ? error.code : null,
      timedOut: error.timedOut === true,
      error: error.message,
    };
  }
}

async function probeDocker(options) {
  const runProcess = options.runProcess || runManagedProcess;
  try {
    await runProcess("docker", ["info"], {
      env: createEnhancedEnv(),
      timeoutMs: DOCKER_PROBE_TIMEOUT_MS,
      maxBufferBytes: 1024 * 1024,
    });
    return { success: true };
  } catch (error) {
    options.onLog?.(
      `Docker did not become ready after storage maintenance: ${error.message}`,
      "warning",
    );
    return { success: false, error: error.message };
  }
}

async function runDockerStorageMaintenanceUnserialized(options = {}) {
  const projectRoot = options.projectRoot;
  const onLog = options.onLog;
  const result = {
    migration: null,
    dockerReady: null,
    cleanup: null,
  };

  if (!projectRoot) {
    return {
      ...result,
      success: false,
      error: "projectRoot is required for Docker storage maintenance",
    };
  }

  const hasExpectedCurrent = options.expectedCurrentTag !== undefined;
  const hasExpectedPrevious = options.expectedPreviousTag !== undefined;
  const includeCleanup = options.includeCleanup !== false;
  if (hasExpectedCurrent !== hasExpectedPrevious) {
    return {
      ...result,
      success: false,
      error: "expectedCurrentTag and expectedPreviousTag must be supplied together",
    };
  }
  if (
    hasExpectedCurrent &&
    (!RELEASE_TAG_PATTERN.test(options.expectedCurrentTag) ||
      !RELEASE_TAG_PATTERN.test(options.expectedPreviousTag) ||
      options.expectedCurrentTag === options.expectedPreviousTag)
  ) {
    return {
      ...result,
      success: false,
      error: "expected cleanup tags must be distinct release-format tags",
    };
  }
  if (includeCleanup && !hasExpectedCurrent) {
    return {
      ...result,
      success: false,
      error: "automated cleanup requires an exact current and previous release tag",
    };
  }

  if (options.includeMigration !== false) {
    const migrationScript = resolveMaintenanceScript(
      "migrate-buildkit-gc-policy.sh",
      options,
    );
    if (!migrationScript) {
      result.migration = {
        success: false,
        error: "migrate-buildkit-gc-policy.sh was not found",
      };
      onLog?.(result.migration.error, "warning");
    } else {
      onLog?.("Checking the one-time BuildKit cache policy migration...", "info");
      // The migration owns config rollback and its Docker restart timeout. Do
      // not externally kill it while it may be restoring the engine config.
      result.migration = await runMaintenanceCommand({
        ...options,
        projectRoot,
        scriptPath: migrationScript,
        args: [],
        timeoutMs: 0,
        maxBufferBytes: Number.POSITIVE_INFINITY,
        onLog,
      });
      if (!result.migration.success) {
        onLog?.(
          `BuildKit cache policy migration did not complete: ${result.migration.error}`,
          "warning",
        );
      }
    }
  }

  result.dockerReady = await probeDocker(options);
  if (!result.dockerReady.success) {
    return {
      ...result,
      success: false,
      error: result.dockerReady.error,
    };
  }

  if (includeCleanup) {
    const cleanupScript = resolveMaintenanceScript("portico-docker-cleanup.sh", options);
    if (!cleanupScript) {
      result.cleanup = {
        success: false,
        error: "portico-docker-cleanup.sh was not found",
      };
      onLog?.(result.cleanup.error, "warning");
    } else {
      onLog?.("Reclaiming superseded Portico image tags...", "info");
      const cleanupArgs = ["--apply"];
      if (hasExpectedCurrent) {
        cleanupArgs.push(
          "--expected-current-tag",
          options.expectedCurrentTag,
          "--expected-previous-tag",
          options.expectedPreviousTag,
        );
      }
      result.cleanup = await runMaintenanceCommand({
        ...options,
        projectRoot,
        scriptPath: cleanupScript,
        args: cleanupArgs,
        timeoutMs: options.cleanupTimeoutMs || CLEANUP_TIMEOUT_MS,
        onLog,
      });
      if (!result.cleanup.success) {
        result.cleanup.failClosed = result.cleanup.code === 3 || result.cleanup.code === 125;
        onLog?.(
          result.cleanup.failClosed
            ? "Docker image cleanup skipped because its safety inventory was incomplete."
            : `Docker image cleanup did not complete: ${result.cleanup.error}`,
          "warning",
        );
      }
    }
  }

  return {
    ...result,
    success:
      result.dockerReady.success &&
      (!includeCleanup || result.cleanup?.success === true),
  };
}

function runDockerStorageMaintenance(options = {}) {
  const run = maintenanceQueue.then(
    () => runDockerStorageMaintenanceUnserialized(options),
    () => runDockerStorageMaintenanceUnserialized(options),
  );
  maintenanceQueue = run.catch(() => undefined);
  return run;
}

module.exports = {
  CLEANUP_TIMEOUT_MS,
  resolveMaintenanceScript,
  runDockerStorageMaintenance,
  _test: {
    runDockerStorageMaintenanceUnserialized,
  },
};
