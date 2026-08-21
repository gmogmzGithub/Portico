const { execFileSync } = require("node:child_process");

function macArchitectureLabel(arch) {
  if (arch === "arm64") {
    return "Apple Silicon";
  }
  if (arch === "x64") {
    return "Intel";
  }
  return arch || "Unknown";
}

function detectMacHardwareArchitecture({
  platform = process.platform,
  processArch = process.arch,
  runningUnderARM64Translation = false,
  execFileSyncRef = execFileSync,
} = {}) {
  if (platform !== "darwin") {
    return processArch;
  }

  if (runningUnderARM64Translation === true) {
    return "arm64";
  }

  try {
    const arm64Support = String(
      execFileSyncRef("sysctl", ["-in", "hw.optional.arm64"], {
        encoding: "utf8",
      }) || "",
    ).trim();

    if (arm64Support === "1") {
      return "arm64";
    }
    if (arm64Support === "0") {
      return "x64";
    }
  } catch (_error) {
    // Fall back to the running build architecture when macOS host detection fails.
  }

  return processArch;
}

function buildMacArchitectureMismatchDialogContent({
  buildArch,
  hardwareArch,
}) {
  const buildLabel = macArchitectureLabel(buildArch);
  const hardwareLabel = macArchitectureLabel(hardwareArch);

  return {
    title: "Wrong Build Installed",
    message:
      `This Mac uses ${hardwareLabel}, but this copy of Portico is the ${buildLabel} build.\n\n` +
      `Download the ${hardwareLabel} build and open that instead.`,
  };
}

function getPackagedMacArchitectureMismatch({
  appRef,
  platform = process.platform,
  processArch = process.arch,
  runningUnderARM64Translation =
    Boolean(appRef && appRef.runningUnderARM64Translation === true),
  execFileSyncRef = execFileSync,
} = {}) {
  const isPackagedApp = Boolean(appRef && appRef.isPackaged === true);

  if (platform !== "darwin" || isPackagedApp !== true) {
    return {
      blocked: false,
      mismatch: false,
      isPackagedApp,
      buildArch: processArch,
      hardwareArch: processArch,
      runningUnderARM64Translation,
    };
  }

  const hardwareArch = detectMacHardwareArchitecture({
    platform,
    processArch,
    runningUnderARM64Translation,
    execFileSyncRef,
  });
  const mismatch =
    processArch !== hardwareArch &&
    (processArch === "x64" || processArch === "arm64") &&
    (hardwareArch === "x64" || hardwareArch === "arm64");

  return {
    blocked: mismatch,
    mismatch,
    isPackagedApp,
    buildArch: processArch,
    hardwareArch,
    runningUnderARM64Translation,
  };
}

function enforcePackagedMacArchitectureMatch({
  appRef,
  dialogRef,
  execFileSyncRef = execFileSync,
  logger = console,
  platform = process.platform,
  processArch = process.arch,
} = {}) {
  const log = typeof logger.log === "function" ? logger.log.bind(logger) : console.log;
  const logError =
    typeof logger.error === "function" ? logger.error.bind(logger) : log;

  const result = getPackagedMacArchitectureMismatch({
    appRef,
    platform,
    processArch,
    execFileSyncRef,
  });

  log(
    `[Startup][MacArchGuard] packaged=${result.isPackagedApp} buildArch=${result.buildArch} hardwareArch=${result.hardwareArch} translated=${result.runningUnderARM64Translation}`,
  );

  if (!result.blocked) {
    return result;
  }

  const dialogContent = buildMacArchitectureMismatchDialogContent({
    buildArch: result.buildArch,
    hardwareArch: result.hardwareArch,
  });

  logError(
    `[Startup][MacArchGuard] Blocking launch due to macOS architecture mismatch: build=${result.buildArch} hardware=${result.hardwareArch}`,
  );

  try {
    if (dialogRef && typeof dialogRef.showErrorBox === "function") {
      dialogRef.showErrorBox(dialogContent.title, dialogContent.message);
    }
  } catch (error) {
    logError(
      `[Startup][MacArchGuard] Failed to show architecture mismatch dialog: ${error.message}`,
    );
  }

  if (appRef && typeof appRef.exit === "function") {
    appRef.exit(1);
  }

  return {
    ...result,
    ...dialogContent,
  };
}

module.exports = {
  buildMacArchitectureMismatchDialogContent,
  detectMacHardwareArchitecture,
  enforcePackagedMacArchitectureMatch,
  getPackagedMacArchitectureMismatch,
  macArchitectureLabel,
};
