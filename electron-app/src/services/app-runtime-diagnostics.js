const fs = require("fs");
const os = require("os");
const path = require("path");

function defaultManagedRoot() {
  return path.join(os.homedir(), "portico", "portico-managed");
}

function normalizeForPathMatch(value) {
  return String(value || "").replace(/\\/g, "/");
}

function isStaleGuidedSetupAppPath(candidate) {
  const normalized = normalizeForPathMatch(candidate);
  return (
    normalized.includes("/portico-managed/guided-setup/") &&
    /\/guided-setup\/dist(?:-[^/]*)?\//.test(normalized) &&
    normalized.includes("/Portico.app")
  );
}

function safeCall(fn) {
  try {
    return fn();
  } catch (error) {
    return "";
  }
}

function readFileUtf8Safe(filePath, fsRef = fs) {
  try {
    return fsRef.readFileSync(filePath, "utf8");
  } catch (error) {
    return "";
  }
}

function parseJsonSafe(content) {
  try {
    return JSON.parse(content);
  } catch (_error) {
    return null;
  }
}

function summarizeBuildInfo(filePath, fsRef = fs) {
  const content = readFileUtf8Safe(filePath, fsRef).trim();
  if (!content) {
    return "missing";
  }

  const parsed = parseJsonSafe(content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "invalid";
  }

  return [
    `buildNumber=${parsed.buildNumber || "unknown"}`,
    `fullSha=${parsed.fullSha || "unknown"}`,
    `timestamp=${parsed.timestamp || "unknown"}`,
    `channel=${parsed.channel || "unknown"}`,
  ].join(" ");
}

function summarizeLastInstalledBuildState(filePath, fsRef = fs) {
  const content = readFileUtf8Safe(filePath, fsRef).trim();
  if (!content) {
    return "missing";
  }

  const parsed = parseJsonSafe(content);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return [
      `schemaVersion=${parsed.schemaVersion || "unknown"}`,
      `buildNumber=${parsed.buildNumber || "unknown"}`,
      `timestamp=${parsed.timestamp || "unknown"}`,
    ].join(" ");
  }

  if (Number.isFinite(Date.parse(content))) {
    return `legacyTimestamp=${content}`;
  }

  return "invalid";
}

function addStaleBuildInfoCandidate(findings, filePath, fsRef) {
  try {
    if (!fsRef.existsSync(filePath)) {
      return;
    }
    const content = readFileUtf8Safe(filePath, fsRef).trim();
    findings.push({
      path: filePath,
      content,
    });
  } catch (error) {
    // Best-effort diagnostics only.
  }
}

function collectStaleGuidedSetupAppBuildInfo({
  managedRoot = defaultManagedRoot(),
  fsRef = fs,
  pathRef = path,
} = {}) {
  const findings = [];
  const guidedSetupRoot = pathRef.join(managedRoot, "guided-setup");
  const distNames = ["dist", "dist-update", "dist-backup"];

  for (const distName of distNames) {
    const distRoot = pathRef.join(guidedSetupRoot, distName);
    addStaleBuildInfoCandidate(
      findings,
      pathRef.join(
        distRoot,
        "Portico.app",
        "Contents",
        "Resources",
        "build-info.json",
      ),
      fsRef,
    );

    let entries = [];
    try {
      entries = fsRef.readdirSync(distRoot, { withFileTypes: true });
    } catch (error) {
      continue;
    }

    for (const entry of entries) {
      if (entry && typeof entry.isDirectory === "function" && !entry.isDirectory()) {
        continue;
      }
      addStaleBuildInfoCandidate(
        findings,
        pathRef.join(
          distRoot,
          entry.name,
          "Portico.app",
          "Contents",
          "Resources",
          "build-info.json",
        ),
        fsRef,
      );
    }
  }

  findings.sort((left, right) => left.path.localeCompare(right.path));
  return findings;
}

function buildRuntimeDiagnosticsText({
  appRef = null,
  processRef = process,
  projectRoot = "",
  managedRoot = defaultManagedRoot(),
  homeDir = os.homedir(),
  fsRef = fs,
  pathRef = path,
  // PORTICO-443: numeric address-space telemetry, appended below. Injected so this
  // module stays pure and so a bundle can be built with no monitor running.
  addressSpaceSnapshot = null,
  formatAddressSpace = null,
} = {}) {
  const appPath = appRef && typeof appRef.getAppPath === "function"
    ? safeCall(() => appRef.getAppPath())
    : "";
  const appExecutable = appRef && typeof appRef.getPath === "function"
    ? safeCall(() => appRef.getPath("exe"))
    : "";
  const processExecPath = processRef.execPath || "";
  const resourcesPath = processRef.resourcesPath || "";
  const cwd = typeof processRef.cwd === "function" ? safeCall(() => processRef.cwd()) : "";
  const candidates = [appPath, appExecutable, processExecPath, resourcesPath].filter(Boolean);
  const staleCandidates = candidates.filter(isStaleGuidedSetupAppPath);
  const staleBuildInfo = collectStaleGuidedSetupAppBuildInfo({
    managedRoot,
    fsRef,
    pathRef,
  });
  const appBuildInfoPath = resourcesPath
    ? pathRef.join(resourcesPath, "build-info.json")
    : "";
  const managedBuildInfoPath = pathRef.join(managedRoot, "electron-app", "build-info.json");
  const updateChannelPath = pathRef.join(managedRoot, "UPDATE_CHANNEL");
  const lastInstalledPath = pathRef.join(
    homeDir,
    "Library",
    "Application Support",
    "portico",
    "LAST_INSTALLED_BUILD",
  );

  const lines = [
    "=== Runtime Paths ===",
    `projectRoot: ${projectRoot || ""}`,
    `managedRoot: ${managedRoot || ""}`,
    `app.getAppPath(): ${appPath}`,
    `app.getPath(\"exe\"): ${appExecutable}`,
    `process.execPath: ${processExecPath}`,
    `process.resourcesPath: ${resourcesPath}`,
    `process.cwd(): ${cwd}`,
    "",
    "=== Stale Guided Setup Launch Detection ===",
    `staleLaunchDetected: ${staleCandidates.length > 0 ? "true" : "false"}`,
  ];

  for (const candidate of staleCandidates) {
    lines.push(`staleLaunchCandidate: ${candidate}`);
  }

  lines.push("", "=== Stale Guided Setup App Build Info ===");
  if (staleBuildInfo.length === 0) {
    lines.push("No stale guided-setup app build-info files found.");
  } else {
    for (const item of staleBuildInfo) {
      lines.push(`--- ${item.path} ---`);
      lines.push(item.content || "(empty)");
    }
  }

  lines.push(
    "",
    "=== Installed Build State ===",
    `appBuildInfoPath: ${appBuildInfoPath}`,
    `appBuildInfo: ${appBuildInfoPath ? summarizeBuildInfo(appBuildInfoPath, fsRef) : "missing"}`,
    `managedBuildInfoPath: ${managedBuildInfoPath}`,
    `managedBuildInfo: ${summarizeBuildInfo(managedBuildInfoPath, fsRef)}`,
    `updateChannelPath: ${updateChannelPath}`,
    `updateChannel: ${readFileUtf8Safe(updateChannelPath, fsRef).trim() || "missing"}`,
    `lastInstalledBuildPath: ${lastInstalledPath}`,
    `lastInstalledBuild: ${summarizeLastInstalledBuildState(lastInstalledPath, fsRef)}`,
  );

  // PORTICO-443: the address-space block goes last so the build-state section a
  // reader already knows keeps its position. Absent monitor => absent block,
  // rather than a misleading empty table.
  if (addressSpaceSnapshot && typeof formatAddressSpace === "function") {
    const rendered = safeCall(() => formatAddressSpace(addressSpaceSnapshot));
    if (rendered) {
      lines.push("", rendered);
    }
  }

  return `${lines.join("\n")}\n`;
}

module.exports = {
  buildRuntimeDiagnosticsText,
  collectStaleGuidedSetupAppBuildInfo,
  defaultManagedRoot,
  isStaleGuidedSetupAppPath,
  normalizeForPathMatch,
  summarizeBuildInfo,
  summarizeLastInstalledBuildState,
};
