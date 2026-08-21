const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const {
  isStaleGuidedSetupAppPath,
} = require("./app-runtime-diagnostics");

const DEFAULT_CANONICAL_APP_PATH = "/Applications/Portico.app";

function defaultCanonicalAppPaths(homedir = os.homedir()) {
  return [
    DEFAULT_CANONICAL_APP_PATH,
    path.join(homedir, "Applications", "Portico.app"),
  ];
}

function normalizeCanonicalAppPaths({
  canonicalAppPath,
  canonicalAppPaths,
  homedir,
} = {}) {
  if (Array.isArray(canonicalAppPaths) && canonicalAppPaths.length > 0) {
    return canonicalAppPaths.filter(Boolean);
  }
  if (canonicalAppPath) {
    return [canonicalAppPath];
  }
  return defaultCanonicalAppPaths(homedir);
}

function safeCall(fn) {
  try {
    return fn();
  } catch (error) {
    return "";
  }
}

function getLaunchPathCandidates({ appRef = null, processRef = process } = {}) {
  const candidates = [
    appRef && typeof appRef.getAppPath === "function"
      ? safeCall(() => appRef.getAppPath())
      : "",
    appRef && typeof appRef.getPath === "function"
      ? safeCall(() => appRef.getPath("exe"))
      : "",
    processRef.execPath || "",
    processRef.resourcesPath || "",
  ].filter(Boolean);

  return [...new Set(candidates)];
}

function getStaleGuidedSetupLaunchState({
  appRef = null,
  processRef = process,
  platform = process.platform,
  fsRef = fs,
  canonicalAppPath = null,
  canonicalAppPaths = null,
  homedir = os.homedir(),
} = {}) {
  const isPackagedApp = Boolean(appRef && appRef.isPackaged === true);
  const candidates = getLaunchPathCandidates({ appRef, processRef });
  const staleCandidates = candidates.filter(isStaleGuidedSetupAppPath);
  const resolvedCanonicalAppPaths = normalizeCanonicalAppPaths({
    canonicalAppPath,
    canonicalAppPaths,
    homedir,
  });
  const blocked =
    platform === "darwin" && isPackagedApp && staleCandidates.length > 0;
  const existingCanonicalAppPath = blocked
    ? resolvedCanonicalAppPaths.find((candidate) => {
        try {
          return Boolean(candidate) && fsRef.existsSync(candidate);
        } catch {
          return false;
        }
      }) || null
    : null;
  const canonicalExists = Boolean(existingCanonicalAppPath);

  return {
    blocked,
    canonicalAppPath: existingCanonicalAppPath || resolvedCanonicalAppPaths[0] || "",
    canonicalAppPaths: resolvedCanonicalAppPaths,
    canonicalExists,
    candidates,
    isPackagedApp,
    platform,
    staleCandidates,
  };
}

function launchCanonicalApplication({
  canonicalAppPath = DEFAULT_CANONICAL_APP_PATH,
  spawnRef = spawn,
} = {}) {
  const child = spawnRef("open", ["-n", canonicalAppPath], {
    detached: true,
    stdio: "ignore",
  });
  if (child && typeof child.unref === "function") {
    child.unref();
  }
}

function showStaleLaunchDialog({
  dialogRef,
  title,
  message,
  logger = console,
}) {
  try {
    if (dialogRef && typeof dialogRef.showErrorBox === "function") {
      dialogRef.showErrorBox(title, message);
    }
  } catch (error) {
    const logError =
      logger && typeof logger.error === "function" ? logger.error.bind(logger) : console.error;
    logError(`[Startup][StaleGuidedSetupGuard] Failed to show dialog: ${error.message}`);
  }
}

function enforceNotStaleGuidedSetupAppLaunch({
  appRef,
  dialogRef,
  logger = console,
  spawnRef = spawn,
  ...options
} = {}) {
  const result = getStaleGuidedSetupLaunchState({
    appRef,
    ...options,
  });
  const log = logger && typeof logger.log === "function" ? logger.log.bind(logger) : console.log;
  const logError =
    logger && typeof logger.error === "function" ? logger.error.bind(logger) : log;

  log(
    `[Startup][StaleGuidedSetupGuard] packaged=${result.isPackagedApp} staleLaunch=${result.blocked} candidates=${result.staleCandidates.length}`,
  );

  if (!result.blocked) {
    return result;
  }

  logError(
    `[Startup][StaleGuidedSetupGuard] Blocking launch from stale guided-setup app: ${result.staleCandidates.join(", ")}`,
  );

  let relaunchedCanonical = false;
  if (result.canonicalExists) {
    try {
      launchCanonicalApplication({
        canonicalAppPath: result.canonicalAppPath,
        spawnRef,
      });
      relaunchedCanonical = true;
      showStaleLaunchDialog({
        dialogRef,
        logger,
        title: "Old App Copy Detected",
        message:
          "This copy of Portico was launched from an old guided setup folder.\n\n" +
          `Opening the current app from ${result.canonicalAppPath} instead.`,
      });
    } catch (error) {
      logError(
        `[Startup][StaleGuidedSetupGuard] Failed to open canonical app: ${error.message}`,
      );
      showStaleLaunchDialog({
        dialogRef,
        logger,
        title: "Old App Copy Detected",
        message:
          "This copy of Portico was launched from an old guided setup folder, " +
          `and the current app could not be opened from ${result.canonicalAppPath}.\n\n` +
          "Quit this copy and open Portico from Applications.",
      });
    }
  } else {
    showStaleLaunchDialog({
      dialogRef,
      logger,
      title: "Old App Copy Detected",
      message:
        "This copy of Portico was launched from an old guided setup folder.\n\n" +
        "Quit this copy and open Portico from Applications.",
    });
  }

  if (appRef && typeof appRef.exit === "function") {
    appRef.exit(relaunchedCanonical ? 0 : 1);
  }

  return {
    ...result,
    relaunchedCanonical,
  };
}

module.exports = {
  DEFAULT_CANONICAL_APP_PATH,
  enforceNotStaleGuidedSetupAppLaunch,
  getLaunchPathCandidates,
  getStaleGuidedSetupLaunchState,
  launchCanonicalApplication,
};
