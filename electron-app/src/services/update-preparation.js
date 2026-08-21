const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawn } = require("child_process");
const electron = require("electron");

const state = require("./shared-state");
const bootstrap = require("./bootstrap");
const prerequisitesService = require("./prerequisites-service");
const {
  ensureDockerRunning,
  restartOrbStackAndWaitForDocker,
} = require("./docker-mcp");
const { createEnhancedEnv } = require("./env-paths");
const { safeWebContentsSend } = require("./webcontents-safe");
const { resolveBuildChannel } = require("../utils/build-info");
const { checkPrepareDiskSpace } = require("./disk-space");
const orbstackAvailability = require("./orbstack-availability");
const updateDownloadFailure = require("./update-download-failure");
const {
  cleanupStaleReconcileStrands,
} = require("./reconcile-strand-cleanup");
const {
  runDockerStorageMaintenance,
} = require("./docker-storage-maintenance");
const {
  DISK_FULL_PATTERN,
  DISK_FULL_PREPARE_MESSAGE,
} = require("./update-failure-message");

const electronApp = electron && typeof electron === "object" ? electron.app : null;

const APP_SUPPORT_DIR = process.env.PORTICO_APP_SUPPORT_DIR || path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "portico",
);
const PREPARATION_ROOT = path.join(APP_SUPPORT_DIR, "update-prep");
const PREPARATION_STATE_PATH = path.join(PREPARATION_ROOT, "state.json");
const PREPARATION_LOG_DIR = path.join(APP_SUPPORT_DIR, "logs");

const STATUS_CHANNEL = "update-prep-status";
const LOG_CHANNEL = "update-prep-log";

const DOCKER_EVENT_MAP = {
  "prerequisites-docker-pull-start": "update-prep-docker-pull-start",
  "prerequisites-docker-pull": "update-prep-docker-pull",
  "prerequisites-docker-pull-progress": "update-prep-docker-pull-progress",
  "prerequisites-docker-pull-complete": "update-prep-docker-pull-complete",
};
const MAX_DOCKER_PREPARATION_ATTEMPTS = 2;
const DOCKER_SNAPSHOT_STORE_REPAIR_REQUIRED_CODE =
  "docker_snapshot_store_repair_required";
const SNAPSHOT_STORE_REPAIR_FAILURE_MESSAGE =
  "Docker's local image cache is damaged, and automatic image-only repair could not complete safely. Quit Portico, reopen it, and retry once; if the error continues, collect debug logs and contact support.";

const PHASE_BASE_PROGRESS = {
  idle: 0,
  backup: 0,
  download: 15,
  extract: 35,
  build: 55,
  docker: 70,
  ready: 100,
};

const PHASE_MAX_PROGRESS = {
  idle: 0,
  backup: 15,
  download: 35,
  extract: 55,
  build: 70,
  docker: 99,
  ready: 100,
};

let prepState = createDefaultPrepState();
let activeJob = null;
let preflightUpdateKey = null;
let initialized = false;

function createDefaultPrepState() {
  return {
    state: "idle",
    updateKey: null,
    phase: "idle",
    message: "",
    phasePercent: 0,
    phaseDetail: "",
    overallPercent: 0,
    error: null,
    logPath: null,
    startedAt: null,
    updatedAt: new Date().toISOString(),
    download: {
      totalBytes: 0,
      downloadedBytes: 0,
      percent: 0,
    },
    docker: {
      manifestCount: 0,
      sourceManifestPath: null,
      totalImages: 0,
      completed: 0,
      pulled: 0,
      failed: 0,
      failedImages: [],
      preparedAt: null,
      images: {},
    },
    prepared: null,
  };
}

function normalizeChecksumValue(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function normalizeNonEmptyPath(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function isPathContained(parentPath, candidatePath, { allowEqual = false } = {}) {
  const parent = normalizeNonEmptyPath(parentPath);
  const candidate = normalizeNonEmptyPath(candidatePath);
  if (!parent || !candidate) {
    return false;
  }

  const contains = (resolvedParent, resolvedCandidate) => {
    const relative = path.relative(resolvedParent, resolvedCandidate);
    if (!relative) {
      return allowEqual;
    }
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };

  const resolvedParent = path.resolve(parent);
  const resolvedCandidate = path.resolve(candidate);
  if (!contains(resolvedParent, resolvedCandidate)) {
    return false;
  }

  try {
    return contains(fs.realpathSync(resolvedParent), fs.realpathSync(resolvedCandidate));
  } catch (_error) {
    return false;
  }
}

function readJsonObject(filePath, description) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed;
  } catch (error) {
    throw new Error(`Failed to parse ${description}: ${error.message}`);
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, filePath);
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch (_error) {
      // Atomic rename normally consumes the temporary file.
    }
  }
}

function parseBooleanFlag(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return fallback;
}

function normalizeSelectedArch(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized === "darwin-arm64" || normalized === "darwin-x64"
    ? normalized
    : null;
}

function normalizeDockerImageSpec(image) {
  if (!image || typeof image !== "object" || Array.isArray(image)) {
    return null;
  }

  const name = normalizeNonEmptyPath(image.name);
  const tag = normalizeNonEmptyPath(image.tag);
  const label = normalizeNonEmptyPath(image.label) || name;

  if (!name || !tag) {
    return null;
  }

  return { name, tag, label };
}

function normalizeDockerImageList(images) {
  if (!Array.isArray(images)) {
    return [];
  }

  const normalized = [];
  for (const image of images) {
    const spec = normalizeDockerImageSpec(image);
    if (!spec) {
      return [];
    }
    normalized.push(spec);
  }
  return normalized;
}

function getChecksumIdentity(checksum) {
  if (!checksum || typeof checksum !== "object") {
    return null;
  }

  const priority = ["sha256", "sha512", "sha1", "md5"];
  for (const algorithm of priority) {
    const value = normalizeChecksumValue(checksum[algorithm]);
    if (value) {
      return { algorithm, value };
    }
  }
  return null;
}

function buildUpdateKey(updateInfo) {
  if (!updateInfo) {
    return null;
  }

  if (typeof updateInfo.updateKey === "string" && updateInfo.updateKey.trim()) {
    return updateInfo.updateKey.trim();
  }

  if (!updateInfo || !updateInfo.latestBuildNumber) {
    return null;
  }

  const channelKey = updateInfo.updateChannel || "unknown";
  const checksumIdentity = getChecksumIdentity(updateInfo.checksum);
  if (!checksumIdentity) {
    return null;
  }

  return `${updateInfo.latestBuildNumber}|${checksumIdentity.algorithm}:${checksumIdentity.value}|${channelKey}`;
}

function sanitizeUpdateKey(updateKey) {
  return String(updateKey || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function getStageDir(updateKey) {
  return path.join(PREPARATION_ROOT, sanitizeUpdateKey(updateKey));
}

function ensurePreparationRoot() {
  if (!fs.existsSync(PREPARATION_ROOT)) {
    fs.mkdirSync(PREPARATION_ROOT, { recursive: true });
  }
}

function ensurePreparationLogDir() {
  if (!fs.existsSync(PREPARATION_LOG_DIR)) {
    fs.mkdirSync(PREPARATION_LOG_DIR, { recursive: true });
  }
}

function getPreparationLogPath(date = new Date()) {
  const dateStr = date.toISOString().split("T")[0];
  return path.join(PREPARATION_LOG_DIR, `update-prep-${dateStr}.log`);
}

function redactDownloadUrl(downloadUrl) {
  const normalized = normalizeNonEmptyPath(downloadUrl);
  if (!normalized) {
    return "unknown";
  }
  try {
    const parsed = new URL(normalized);
    return `${parsed.protocol}//${parsed.host}/[redacted]`;
  } catch (_error) {
    return "[redacted configured URL]";
  }
}

function withNoAsar(operation) {
  const previousNoAsar = process.noAsar;
  process.noAsar = true;
  try {
    return operation();
  } finally {
    process.noAsar = previousNoAsar;
  }
}

function removePathRecursive(targetPath) {
  return withNoAsar(() => fs.rmSync(targetPath, { recursive: true, force: true }));
}

function cloneStatus() {
  return JSON.parse(JSON.stringify(prepState));
}

function appendPreparationLogLine(text, type = "info", timestamp = new Date().toISOString()) {
  const normalizedText = typeof text === "string" ? text : String(text ?? "");
  const logPath = normalizeNonEmptyPath(prepState.logPath) || getPreparationLogPath();
  prepState.logPath = logPath;

  try {
    ensurePreparationLogDir();
    fs.appendFileSync(
      logPath,
      `[${timestamp}] [${String(type || "info").toUpperCase()}] ${normalizedText}\n`,
      "utf8",
    );
  } catch (error) {
    console.error("[Update Prep] Failed to append prep log:", error.message);
  }
}

function logPreparationSessionHeader(updateKey, updateInfo, stageDir) {
  appendPreparationLogLine("========================================");
  appendPreparationLogLine("Portico Update Preparation");
  appendPreparationLogLine(`Started: ${new Date().toISOString()}`);
  appendPreparationLogLine(`Update Key: ${updateKey || "unknown"}`);
  appendPreparationLogLine(`Filename: ${updateInfo?.filename || "unknown"}`);
  appendPreparationLogLine(`Channel: ${updateInfo?.updateChannel || "unknown"}`);
  appendPreparationLogLine(`Download URL: ${redactDownloadUrl(updateInfo?.downloadUrl)}`);
  appendPreparationLogLine(`Stage Dir: ${stageDir || "unknown"}`);
  appendPreparationLogLine(`Log File: ${prepState.logPath || "unknown"}`);
  appendPreparationLogLine("========================================");
  appendPreparationLogLine("");
}

function formatByteCount(bytes) {
  const numericBytes = Number(bytes);
  if (!Number.isFinite(numericBytes) || numericBytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = numericBytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 100 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function buildDownloadDetail(downloadState = prepState.download) {
  const totalBytes = Number(downloadState?.totalBytes) || 0;
  const downloadedBytes = Number(downloadState?.downloadedBytes) || 0;

  if (totalBytes > 0 && downloadedBytes > 0) {
    return `${formatByteCount(downloadedBytes)} / ${formatByteCount(totalBytes)} downloaded`;
  }
  if (totalBytes > 0) {
    return `${formatByteCount(totalBytes)} total payload size`;
  }
  if (downloadedBytes > 0) {
    return `${formatByteCount(downloadedBytes)} downloaded`;
  }
  return "Starting payload download...";
}

function updateDownloadProgress(progress = {}) {
  const totalBytes = Math.max(
    0,
    Number.isFinite(Number(progress.totalBytes))
      ? Number(progress.totalBytes)
      : Number(prepState.download.totalBytes || 0),
  );
  const downloadedBytes = Math.max(
    0,
    Number.isFinite(Number(progress.downloadedBytes))
      ? Number(progress.downloadedBytes)
      : Number(prepState.download.downloadedBytes || 0),
  );
  let percent = Number.isFinite(Number(progress.percent))
    ? Number(progress.percent)
    : Number(prepState.download.percent || 0);

  if ((!Number.isFinite(percent) || percent <= 0) && totalBytes > 0 && downloadedBytes > 0) {
    percent = Math.round((downloadedBytes / totalBytes) * 100);
  }

  const boundedPercent = Math.max(0, Math.min(100, Number(percent) || 0));
  prepState.download.totalBytes = totalBytes;
  prepState.download.downloadedBytes = downloadedBytes;
  prepState.download.percent = boundedPercent;
  setPhaseProgress(
    "download",
    boundedPercent,
    "Downloading update payload...",
    buildDownloadDetail(prepState.download),
  );
}

function emitToUpdateWindows(channel, data) {
  const targets = [
    { window: state.windows.main, target: "main" },
    { window: state.windows.loading, target: "loading" },
  ];

  for (const { window, target } of targets) {
    if (!window || window.isDestroyed()) {
      continue;
    }

    safeWebContentsSend(window, channel, data, {
      tag: "update-prep",
      meta: { channel, target },
    });
  }
}

function persistState() {
  try {
    ensurePreparationRoot();
    writeJsonAtomic(PREPARATION_STATE_PATH, prepState);
  } catch (error) {
    console.error("[Update Prep] Failed to persist state:", error.message);
  }
}

function emitStatus() {
  prepState.updatedAt = new Date().toISOString();
  persistState();
  emitToUpdateWindows(STATUS_CHANNEL, cloneStatus());
}

function emitLog(text, type = "info") {
  appendPreparationLogLine(text, type);
  emitToUpdateWindows(LOG_CHANNEL, {
    text,
    type,
    timestamp: new Date().toISOString(),
  });
}

function loadPersistedState() {
  if (!fs.existsSync(PREPARATION_STATE_PATH)) {
    return;
  }

  try {
    const raw = fs.readFileSync(PREPARATION_STATE_PATH, "utf8");
    if (!raw.trim()) {
      return;
    }
    const parsed = JSON.parse(raw);
    prepState = {
      ...createDefaultPrepState(),
      ...parsed,
      download: {
        ...createDefaultPrepState().download,
        ...(parsed.download || {}),
      },
      docker: {
        ...createDefaultPrepState().docker,
        ...(parsed.docker || {}),
      },
    };
  } catch (error) {
    console.error("[Update Prep] Failed to load persisted state:", error.message);
    prepState = createDefaultPrepState();
  }
}

function clearStateForFailure(errorMessage) {
  const stagedPrepared = arePreparedArtifactsValid(prepState.prepared)
    ? {
        ...prepState.prepared,
        artifactsReady: true,
        dockerReady: false,
        ready: false,
      }
    : null;
  prepState = {
    ...prepState,
    state: "failed",
    message: "Update preparation failed",
    phaseDetail: stagedPrepared
      ? "Application/runtime artifacts remain staged for recovery"
      : prepState.phaseDetail,
    error: errorMessage || "Unknown error",
    prepared: stagedPrepared,
  };
}

function setPreflightState(updateKey) {
  const carriedPrepared =
    prepState.prepared?.updateKey === updateKey &&
    arePreparedArtifactsValid(prepState.prepared)
      ? {
          ...prepState.prepared,
          artifactsReady: true,
          dockerReady: false,
          ready: false,
        }
      : null;
  const now = new Date().toISOString();
  prepState = {
    ...createDefaultPrepState(),
    state: "preparing",
    updateKey,
    phase: "preflight",
    message: "Checking update prerequisites...",
    phaseDetail: "Checking update prerequisites...",
    logPath: getPreparationLogPath(),
    startedAt: now,
    updatedAt: now,
    prepared: carriedPrepared,
  };
}

function setPreparingState(updateKey) {
  prepState = {
    ...createDefaultPrepState(),
    state: "preparing",
    updateKey,
    phase: "backup",
    message: "Creating backup snapshot...",
    phasePercent: 1,
    phaseDetail: "Creating backup snapshot...",
    overallPercent: 1,
    logPath: getPreparationLogPath(),
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function setPhaseProgress(phase, percentWithinPhase, message, detail = null) {
  const boundedPercent = Math.max(0, Math.min(100, Number(percentWithinPhase) || 0));
  const base = PHASE_BASE_PROGRESS[phase] || 0;
  const max = PHASE_MAX_PROGRESS[phase] || base;
  const overall = Math.max(
    base,
    Math.min(max, Math.round(base + ((max - base) * boundedPercent) / 100)),
  );

  prepState.phase = phase;
  prepState.message = message || prepState.message;
  prepState.phasePercent = boundedPercent;
  prepState.phaseDetail = detail || message || prepState.phaseDetail;
  prepState.overallPercent = overall;
  emitStatus();
}

function loadReleaseManifest(releaseManifestPath) {
  const normalizedPath = normalizeNonEmptyPath(releaseManifestPath);
  if (!normalizedPath || !fs.existsSync(normalizedPath)) {
    throw new Error(
      `Prepared payload is missing release-manifest.json: ${releaseManifestPath || "unknown"}`,
    );
  }

  let parsed;
  try {
    const raw = fs.readFileSync(normalizedPath, "utf8");
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse release-manifest.json: ${error.message}`);
  }

  const schemaVersion = Number(parsed?.schemaVersion);
  if (!Number.isFinite(schemaVersion) || schemaVersion < 2) {
    throw new Error(
      "Release payload manifest is missing staged-update Docker metadata. Regenerate the payload before preparing this update.",
    );
  }

  const dockerImages = normalizeDockerImageList(parsed?.dockerImages);
  if (dockerImages.length === 0) {
    throw new Error(
      "Release payload manifest is missing a valid dockerImages list. Regenerate the payload before preparing this update.",
    );
  }

  return {
    ...parsed,
    schemaVersion,
    dockerImages,
  };
}

function mergePreparedArtifactsWithReleaseManifest(prepared, releaseManifest) {
  const stageDir = normalizeNonEmptyPath(prepared?.stageDir);
  const sourceDir =
    normalizeNonEmptyPath(prepared?.sourceDir) ||
    (stageDir ? path.join(stageDir, "payload") : null);
  const selectedArch = normalizeSelectedArch(
    prepared?.selectedArch || prepared?.nativeArch,
  );

  if (!stageDir || !sourceDir) {
    throw new Error("Prepared update metadata is missing stage/source paths.");
  }
  if (!selectedArch) {
    throw new Error("Prepared update metadata is missing the selected macOS architecture.");
  }

  const expectedAppRel = normalizeNonEmptyPath(
    releaseManifest?.appBundles?.[selectedArch],
  );
  const expectedDmgRel = normalizeNonEmptyPath(releaseManifest?.dmgs?.[selectedArch]);

  if (!expectedAppRel || !expectedDmgRel) {
    throw new Error(
      `Release payload manifest is missing app or DMG entries for ${selectedArch}.`,
    );
  }

  const expectedAppBundle = path.join(sourceDir, expectedAppRel);
  const expectedDmg = path.join(sourceDir, expectedDmgRel);
  const selectedAppBundle =
    normalizeNonEmptyPath(prepared?.selectedAppBundle) || expectedAppBundle;
  const selectedDmg =
    normalizeNonEmptyPath(prepared?.selectedDmg) || expectedDmg;

  if (path.resolve(selectedAppBundle) !== path.resolve(expectedAppBundle)) {
    throw new Error(
      `Prepared app bundle does not match the ${selectedArch} payload artifact.`,
    );
  }
  if (path.resolve(selectedDmg) !== path.resolve(expectedDmg)) {
    throw new Error(`Prepared DMG does not match the ${selectedArch} payload artifact.`);
  }

  return {
    ...prepared,
    sourceDir,
    selectedArch,
    selectedAppBundle,
    selectedDmg,
    releaseManifestPath: normalizeNonEmptyPath(prepared?.releaseManifestPath),
    releaseManifestSchemaVersion: releaseManifest.schemaVersion,
    releaseBuildNumber: normalizeNonEmptyPath(releaseManifest.buildNumber),
    dockerImages: releaseManifest.dockerImages,
  };
}

function persistPreparedManifest(prepared) {
  const manifestPath = normalizeNonEmptyPath(prepared?.manifestPath);
  if (!manifestPath) {
    return;
  }

  let existing = {};
  if (fs.existsSync(manifestPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (error) {
      existing = {};
    }
  }

  const persisted = {
    ...existing,
    ...prepared,
    dockerImages: normalizeDockerImageList(prepared?.dockerImages),
  };

  writeJsonAtomic(manifestPath, persisted);
}

function pathsMatch(left, right) {
  const normalizedLeft = normalizeNonEmptyPath(left);
  const normalizedRight = normalizeNonEmptyPath(right);
  return Boolean(
    normalizedLeft &&
      normalizedRight &&
      path.resolve(normalizedLeft) === path.resolve(normalizedRight),
  );
}

function validatePreparedManifestConsistency(manifest, prepared) {
  const pathKeys = [
    "stageDir",
    "sourceDir",
    "managedRootDir",
    "selectedAppBundle",
    "selectedDmg",
    "buildInfoPath",
    "manifestPath",
    "releaseManifestPath",
  ];
  for (const key of pathKeys) {
    if (!pathsMatch(manifest?.[key], prepared?.[key])) {
      throw new Error(`Prepared manifest ${key} does not match persisted state.`);
    }
  }

  const stringKeys = [
    "updateKey",
    "selectedArch",
    "checksumAlgorithm",
    "checksumValue",
  ];
  for (const key of stringKeys) {
    const manifestValue = normalizeNonEmptyPath(manifest?.[key]);
    const preparedValue = normalizeNonEmptyPath(prepared?.[key]);
    if (!manifestValue || !preparedValue || manifestValue !== preparedValue) {
      throw new Error(`Prepared manifest ${key} does not match persisted state.`);
    }
  }
}

function validatePreparedArtifactsForInstall(prepared, options = {}) {
  // PORTICO-318: the full backup archive is a PRE-APPLY rollback safety net. Once
  // the apply has already succeeded and we are only swapping the app bundle at
  // the restart handoff, the archive is irrelevant (and may have been consumed
  // or pruned). Callers on the post-apply restart path pass
  // requireBackupArtifact:false so a missing backup can never dead-end a
  // restart for an update that already applied. Pre-apply callers keep the
  // default (true) so the rollback safety net is still enforced before apply.
  const requireBackupArtifact = options.requireBackupArtifact !== false;
  if (!prepared || typeof prepared !== "object") {
    return {
      success: false,
      error: "Prepared update metadata is incomplete.",
    };
  }

  if (
    !prepared.stageDir ||
    !prepared.managedRootDir ||
    !prepared.selectedAppBundle ||
    !prepared.selectedDmg ||
    !prepared.buildInfoPath ||
    !prepared.manifestPath ||
    !prepared.releaseManifestPath
  ) {
    return {
      success: false,
      error: "Prepared update metadata is incomplete.",
    };
  }

  const sourceDir = prepared.sourceDir || path.join(prepared.stageDir, "payload");
  const backupRequired = parseBooleanFlag(prepared.backupRequired, false);
  const fullBackupPath = normalizeNonEmptyPath(prepared.fullBackupPath);
  const updateKey = normalizeNonEmptyPath(prepared.updateKey);
  const checksumAlgorithm = normalizeNonEmptyPath(prepared.checksumAlgorithm)?.toLowerCase();
  const checksumValue = normalizeChecksumValue(prepared.checksumValue);

  if (!updateKey || !checksumAlgorithm || !checksumValue) {
    return {
      success: false,
      error: "Prepared update checksum metadata is incomplete.",
    };
  }
  if (!["sha256", "sha512", "sha1", "md5"].includes(checksumAlgorithm)) {
    return {
      success: false,
      error: "Prepared update checksum algorithm is invalid.",
    };
  }

  if (
    requireBackupArtifact &&
    backupRequired &&
    (!fullBackupPath || !fs.existsSync(fullBackupPath))
  ) {
    return {
      success: false,
      error: "Prepared update backup archive is missing.",
    };
  }

  try {
    const stageDir = path.resolve(prepared.stageDir);
    const manifestPath = path.resolve(prepared.manifestPath);
    if (!fs.statSync(stageDir).isDirectory()) {
      throw new Error("Prepared update stage path is not a directory.");
    }
    if (!isPathContained(stageDir, sourceDir)) {
      throw new Error("Prepared update source path escapes the staging directory.");
    }
    if (!isPathContained(stageDir, manifestPath)) {
      throw new Error("Prepared manifest path escapes the staging directory.");
    }

    const persistedManifest = readJsonObject(manifestPath, "prepared manifest.json");
    const releaseManifest = loadReleaseManifest(prepared.releaseManifestPath);
    const normalizedPrepared = mergePreparedArtifactsWithReleaseManifest(
      {
        ...prepared,
        stageDir,
        sourceDir,
        manifestPath,
        updateKey,
        checksumAlgorithm,
        checksumValue,
        backupRequired,
        fullBackupPath,
      },
      releaseManifest,
    );

    validatePreparedManifestConsistency(persistedManifest, normalizedPrepared);

    const expectedManagedRoot = path.resolve(
      normalizedPrepared.sourceDir,
      normalizeNonEmptyPath(releaseManifest.managedRootDir) || "managed-root",
    );
    if (!pathsMatch(expectedManagedRoot, normalizedPrepared.managedRootDir)) {
      throw new Error(
        "Prepared managed runtime path does not match release-manifest.json.",
      );
    }

    const containedPaths = [
      [normalizedPrepared.sourceDir, normalizedPrepared.releaseManifestPath, "release manifest"],
      [normalizedPrepared.sourceDir, normalizedPrepared.managedRootDir, "managed runtime"],
      [normalizedPrepared.sourceDir, normalizedPrepared.selectedAppBundle, "app bundle"],
      [normalizedPrepared.sourceDir, normalizedPrepared.selectedDmg, "DMG"],
      [normalizedPrepared.managedRootDir, normalizedPrepared.buildInfoPath, "build-info.json"],
    ];
    for (const [parentPath, candidatePath, label] of containedPaths) {
      if (!isPathContained(parentPath, candidatePath)) {
        throw new Error(`Prepared ${label} path escapes its trusted staging root.`);
      }
    }
    if (requireBackupArtifact && fullBackupPath && !isPathContained(stageDir, fullBackupPath)) {
      throw new Error("Prepared backup path escapes the staging directory.");
    }

    if (
      !fs.statSync(normalizedPrepared.sourceDir).isDirectory() ||
      !fs.statSync(normalizedPrepared.managedRootDir).isDirectory() ||
      !fs.statSync(normalizedPrepared.selectedAppBundle).isDirectory() ||
      !fs.statSync(normalizedPrepared.selectedDmg).isFile() ||
      fs.statSync(normalizedPrepared.selectedDmg).size <= 0 ||
      !fs.statSync(normalizedPrepared.buildInfoPath).isFile() ||
      !fs.statSync(normalizedPrepared.releaseManifestPath).isFile()
    ) {
      throw new Error("Prepared update artifacts are missing or invalid.");
    }
    if (
      requireBackupArtifact &&
      fullBackupPath &&
      (!fs.statSync(fullBackupPath).isFile() || fs.statSync(fullBackupPath).size <= 0)
    ) {
      throw new Error("Prepared update backup archive is missing or empty.");
    }

    const buildInfo = readJsonObject(
      normalizedPrepared.buildInfoPath,
      "prepared build-info.json",
    );
    const buildNumber = normalizeNonEmptyPath(buildInfo.buildNumber);
    const manifestBuildNumber = normalizeNonEmptyPath(releaseManifest.buildNumber);
    const buildChannel = resolveBuildChannel(buildInfo);
    const manifestChannel = normalizeNonEmptyPath(releaseManifest.channelPackageName);
    if (!buildNumber || buildNumber !== manifestBuildNumber) {
      throw new Error(
        "Prepared build-info.json does not match the release manifest build number.",
      );
    }
    if (!manifestChannel || buildChannel !== manifestChannel) {
      throw new Error(
        "Prepared build-info.json does not match the release manifest channel.",
      );
    }
    const expectedUpdateKey = `${buildNumber}|${checksumAlgorithm}:${checksumValue}|${manifestChannel}`;
    if (updateKey !== expectedUpdateKey) {
      throw new Error(
        "Prepared update key does not match its build, checksum, and channel metadata.",
      );
    }

    return {
      success: true,
      prepared: {
        ...normalizedPrepared,
        buildNumber,
        channel: manifestChannel,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
}

function getPreparedInfoForUpdate(updateInfo) {
  const updateKey = buildUpdateKey(updateInfo);
  if (!updateKey) {
    return null;
  }
  if (prepState.state !== "ready" || prepState.updateKey !== updateKey) {
    return null;
  }
  const validation = validatePreparedArtifactsForInstall(prepState.prepared);
  if (!validation.success) {
    return null;
  }
  const normalizedPrepared = validation.prepared;
  const managedRootDir = normalizeNonEmptyPath(normalizedPrepared.managedRootDir);
  const fullBackupPath = normalizeNonEmptyPath(normalizedPrepared.fullBackupPath);
  const backupRequired = parseBooleanFlag(normalizedPrepared.backupRequired, false);

  return {
    ...normalizedPrepared,
    managedRootDir,
    backupRequired,
    fullBackupPath,
    prepLogPath: prepState.logPath,
    fullBackupName: normalizedPrepared.fullBackupName ||
      (fullBackupPath ? path.basename(fullBackupPath) : null),
    ready: true,
  };
}

function arePreparedArtifactsValid(prepared) {
  return validatePreparedArtifactsForInstall(prepared).success;
}

function discoverRecoverablePreparedArtifacts() {
  ensurePreparationRoot();
  const candidates = [];

  for (const entry of fs.readdirSync(PREPARATION_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const stageDir = path.join(PREPARATION_ROOT, entry.name);
    const manifestPath = path.join(stageDir, "manifest.json");
    if (!fs.existsSync(manifestPath) || !isPathContained(PREPARATION_ROOT, stageDir)) {
      continue;
    }

    try {
      const manifest = readJsonObject(manifestPath, "staged manifest.json");
      if (!pathsMatch(manifest.stageDir, stageDir)) {
        continue;
      }
      const validation = validatePreparedArtifactsForInstall({
        ...manifest,
        stageDir,
        manifestPath,
      });
      if (!validation.success) {
        continue;
      }
      const preparedAtMs = Date.parse(validation.prepared.preparedAt || "");
      const modifiedAtMs = fs.statSync(manifestPath).mtimeMs;
      candidates.push({
        prepared: validation.prepared,
        sortTime: Number.isFinite(preparedAtMs) ? preparedAtMs : modifiedAtMs,
      });
    } catch (error) {
      console.warn(
        `[Update Prep] Ignoring invalid staged recovery candidate ${manifestPath}: ${error.message}`,
      );
    }
  }

  candidates.sort((left, right) => right.sortTime - left.sortTime);
  return candidates[0]?.prepared || null;
}

function cleanupStaleStageDirs(retainUpdateKey = null) {
  ensurePreparationRoot();
  const retainDirName = retainUpdateKey ? sanitizeUpdateKey(retainUpdateKey) : null;

  for (const entry of fs.readdirSync(PREPARATION_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (retainDirName && entry.name === retainDirName) continue;

    const target = path.join(PREPARATION_ROOT, entry.name);
    try {
      removePathRecursive(target);
    } catch (error) {
      console.warn("[Update Prep] Failed to remove stale stage dir:", target, error.message);
    }
  }
}

function cancelActiveScript(job) {
  if (!job || !job.child || job.child.killed) {
    return;
  }
  try {
    job.child.kill("SIGTERM");
    setTimeout(() => {
      if (job.child && !job.child.killed) {
        try {
          job.child.kill("SIGKILL");
        } catch (error) {
          // noop
        }
      }
    }, 2000);
  } catch (error) {
    console.warn("[Update Prep] Failed to kill active script:", error.message);
  }
}

function cancelPreparation(reason = "cancelled", options = {}) {
  if (!activeJob) {
    return { success: true, status: cloneStatus() };
  }

  const interruptedPhase = prepState.phase || "unknown";
  const interruptedUpdateKey = prepState.updateKey || activeJob.updateKey || "unknown";
  const quitProvenance = normalizeNonEmptyPath(options.quitProvenance) || "not-app-quit";
  activeJob.cancelled = true;
  cancelActiveScript(activeJob);
  let prerequisitesDrain = null;
  if (typeof prerequisitesService.cancelPrerequisites === "function") {
    prerequisitesDrain = prerequisitesService.cancelPrerequisites();
  }

  const stagedPrepared = arePreparedArtifactsValid(prepState.prepared)
    ? {
        ...prepState.prepared,
        artifactsReady: true,
        dockerReady: false,
        ready: false,
      }
    : null;
  prepState.state = stagedPrepared ? "interrupted" : "idle";
  prepState.message = `Preparation ${reason}`;
  prepState.phaseDetail = stagedPrepared
    ? "Application/runtime artifacts remain staged for recovery"
    : `Preparation ${reason}`;
  prepState.error = null;
  prepState.prepared = stagedPrepared;
  emitStatus();
  emitLog(
    `Background update preparation ${reason}; phase=${interruptedPhase}; updateKey=${interruptedUpdateKey}; quitProvenance=${quitProvenance}.`,
    "warning",
  );

  activeJob = null;
  const result = { success: true, status: cloneStatus() };
  if (prerequisitesDrain && typeof prerequisitesDrain.then === "function") {
    return Promise.resolve(prerequisitesDrain).then(() => result);
  }
  return result;
}

function clearPreparation(reason = "cleared") {
  ensureInitialized();

  const stageDirs = new Set();
  const activeStageDir = normalizeNonEmptyPath(activeJob?.stageDir);
  const preparedStageDir = normalizeNonEmptyPath(prepState.prepared?.stageDir);
  if (activeStageDir) stageDirs.add(activeStageDir);
  if (preparedStageDir) stageDirs.add(preparedStageDir);

  if (activeJob) {
    cancelPreparation(reason);
  }

  for (const stageDir of stageDirs) {
    if (!isPathContained(PREPARATION_ROOT, stageDir)) {
      console.warn(
        `[Update Prep] Refusing to clear stage directory outside preparation root: ${stageDir}`,
      );
      continue;
    }
    try {
      removePathRecursive(stageDir);
    } catch (error) {
      console.warn(`[Update Prep] Failed to clear stage directory ${stageDir}:`, error.message);
    }
  }

  prepState = createDefaultPrepState();
  prepState.message = `Preparation ${reason}`;
  emitStatus();
  return { success: true, status: cloneStatus() };
}

function normalizeMappedDockerPayload(payload) {
  return payload && typeof payload === "object" ? payload : {};
}

function formatDockerImageSpec(image) {
  if (!image || typeof image !== "object") {
    return "unknown";
  }
  const name = normalizeNonEmptyPath(image.name);
  const tag = normalizeNonEmptyPath(image.tag) || "latest";
  return name ? `${name}:${tag}` : "unknown";
}

function handleMappedDockerEvent(channel, payload, job) {
  if (!job || job !== activeJob || job.cancelled) {
    return;
  }

  const mappedChannel = DOCKER_EVENT_MAP[channel];
  if (!mappedChannel) {
    return;
  }

  const data = normalizeMappedDockerPayload(payload);
  emitToUpdateWindows(mappedChannel, data);

  if (channel === "prerequisites-docker-pull-start") {
    prepState.docker.totalImages = Number(data.totalImages) || 0;
    prepState.docker.manifestCount = prepState.docker.totalImages;
    prepState.docker.failedImages = [];
    prepState.docker.images = {};
    const declaredImages = Array.isArray(data.images) ? data.images : [];
    for (const image of declaredImages) {
      if (!image || !image.name) continue;
      const key = `${image.name}:${image.tag || "latest"}`;
      prepState.docker.images[key] = {
        image: key,
        label: image.label || image.name,
        status: "waiting",
        percent: 0,
        eta: null,
      };
    }
    setPhaseProgress(
      "docker",
      1,
      "Pulling Docker images...",
      `${declaredImages.length || prepState.docker.totalImages || 0} images queued`,
    );
    emitLog(
      `Docker preparation starting for ${declaredImages.length || prepState.docker.totalImages || 0} manifest images.`,
      "info",
    );
    return;
  }

  if (channel === "prerequisites-docker-pull") {
    const imageKey = data.image || data.label || `image-${Date.now()}`;
    const previousStatus = prepState.docker.images[imageKey]?.status || null;
    prepState.docker.images[imageKey] = {
      ...(prepState.docker.images[imageKey] || {}),
      image: imageKey,
      label: data.label || prepState.docker.images[imageKey]?.label || imageKey,
      status: data.status || prepState.docker.images[imageKey]?.status || "waiting",
      percent: Number.isFinite(data.percent) ? data.percent : prepState.docker.images[imageKey]?.percent || 0,
      eta: data.eta || null,
      layerCount: Number.isFinite(data.layerCount) ? data.layerCount : prepState.docker.images[imageKey]?.layerCount || null,
      attempt: data.attempt || null,
      maxAttempts: data.maxAttempts || null,
      error: data.error || null,
    };

    const nextStatus = prepState.docker.images[imageKey].status;
    if (nextStatus && nextStatus !== previousStatus) {
      if (nextStatus === "starting") {
        emitLog(`Pulling Docker image: ${imageKey}`, "info");
      } else if (nextStatus === "retrying") {
        const attempt = data.attempt || "?";
        const maxAttempts = data.maxAttempts || "?";
        emitLog(`Retrying Docker image pull: ${imageKey} (${attempt}/${maxAttempts})`, "warning");
      } else if (nextStatus === "complete") {
        emitLog(`Prepared Docker image: ${imageKey}`, "success");
      } else if (nextStatus === "failed") {
        if (!prepState.docker.failedImages.includes(imageKey)) {
          prepState.docker.failedImages.push(imageKey);
        }
        emitLog(
          data.error
            ? `Failed Docker image pull: ${imageKey} (${data.error})`
            : `Failed Docker image pull: ${imageKey}`,
          "error",
        );
      } else if (nextStatus === "deferred") {
        emitLog(`Docker image deferred for local build fallback: ${imageKey}`, "warning");
      }
    }

    emitStatus();
    return;
  }

  if (channel === "prerequisites-docker-pull-progress") {
    prepState.docker.completed = Number(data.completed) || 0;
    prepState.docker.pulled = Number(data.pulled) || 0;
    prepState.docker.failed = Number(data.failed) || 0;
    const total = Number(data.total) || prepState.docker.totalImages || 1;
    prepState.docker.totalImages = total;

    const dockerPercent = Math.round((prepState.docker.completed / total) * 100);
    setPhaseProgress(
      "docker",
      dockerPercent,
      "Pulling Docker images...",
      `${prepState.docker.completed}/${total} images prepared`,
    );
    return;
  }

  if (channel === "prerequisites-docker-pull-complete") {
    const success = data.success === true && !data.cancelled;
    prepState.docker.failedImages = Array.isArray(data.failed) ? data.failed.slice() : [];
    prepState.docker.preparedAt = new Date().toISOString();
    setPhaseProgress(
      "docker",
      100,
      success ? "Docker images prepared" : "Docker image preparation failed",
      success
        ? `${Array.isArray(data.pulled) ? data.pulled.length : prepState.docker.pulled}/${prepState.docker.totalImages || 0} images prepared`
        : `${Array.isArray(data.failed) ? data.failed.length : prepState.docker.failed} images failed`,
    );
    emitLog(
      success
        ? `Docker image preparation complete. Pulled: ${Array.isArray(data.pulled) ? data.pulled.length : prepState.docker.pulled}, Failed: 0.`
        : `Docker image preparation finished with failures. Pulled: ${Array.isArray(data.pulled) ? data.pulled.length : prepState.docker.pulled}, Failed: ${Array.isArray(data.failed) ? data.failed.length : prepState.docker.failed}.`,
      success ? "success" : "warning",
    );
  }
}

function createDockerBridge(job) {
  return {
    isDestroyed: () => false,
    webContents: {
      send: (channel, payload) => handleMappedDockerEvent(channel, payload, job),
    },
  };
}

function handlePreparationBuildSignal(stage, percent, message) {
  emitToUpdateWindows("update-prep-build-progress", {
    stage,
    percent,
    message,
    timestamp: new Date().toISOString(),
  });
}

function resolvePrepareScriptFailureMessage(job, code) {
  // PORTICO-215: a disk-full signature anywhere in the script output is the
  // actionable root cause; it wins over raw script error markers.
  if (job?.diskFullDetected) {
    return DISK_FULL_PREPARE_MESSAGE;
  }
  const scriptError = normalizeNonEmptyPath(job?.scriptError);
  if (scriptError) {
    // PORTICO-323 (#4): a payload download refused by an HTTP layer reaches here as
    // raw downloader text naming a transport exit code, not the real cause.
    // Replace it with plain-language guidance and next steps.
    return (
      updateDownloadFailure.actionableDownloadFailureMessage(scriptError) ||
      scriptError
    );
  }
  return `prepare script failed with exit code ${code}`;
}

// PORTICO-215: translate ENOSPC failures raised from JS (stage-dir setup,
// manifest writes, ...) into the actionable prepare disk-full message.
function translatePreparationError(error) {
  const message = error?.message || String(error || "Unknown error");
  if (error?.code === "ENOSPC" || DISK_FULL_PATTERN.test(message)) {
    return DISK_FULL_PREPARE_MESSAGE;
  }
  if (
    ["docker_pull_failed", DOCKER_SNAPSHOT_STORE_REPAIR_REQUIRED_CODE].includes(
      error?.code,
    ) &&
    hasMissingOverlayfsSnapshotParentFailure(error.dockerPullResult)
  ) {
    return error.dockerPullResult?.snapshotStoreRepairError ||
      SNAPSHOT_STORE_REPAIR_FAILURE_MESSAGE;
  }
  // PORTICO-323: a fresh install with no Docker engine fails prep here with
  // "Automatic Docker recovery failed: OrbStack is not installed." Surface an
  // actionable message pointing at installing OrbStack instead of the raw error.
  if (orbstackAvailability.errorIndicatesOrbStackMissing(error)) {
    return orbstackAvailability.ORBSTACK_MISSING_UPDATE_MESSAGE;
  }
  // PORTICO-323 (#4): same treatment for a download refused by an HTTP layer, for
  // the failures that surface as a JS error rather than a script marker.
  const downloadMessage =
    updateDownloadFailure.actionableDownloadFailureMessage(error);
  if (downloadMessage) {
    return downloadMessage;
  }
  return message;
}

function handlePrepareScriptLine(line, job, source = "stdout") {
  if (!line) return;

  // PORTICO-215: the backup zip / unzip / payload copy phases report ENOSPC as
  // plain stderr without an [UPDATE_PREP:ERROR:] marker.
  if (job && !job.diskFullDetected && DISK_FULL_PATTERN.test(line)) {
    job.diskFullDetected = true;
  }

  if (line.startsWith("[UPDATE_PREP:DOWNLOAD:TOTAL_BYTES:")) {
    const totalBytes = Number(
      line.replace("[UPDATE_PREP:DOWNLOAD:TOTAL_BYTES:", "").replace("]", "").trim(),
    );
    updateDownloadProgress({ totalBytes });
    return;
  }
  if (line.startsWith("[UPDATE_PREP:DOWNLOAD:BYTES:")) {
    const downloadedBytes = Number(
      line.replace("[UPDATE_PREP:DOWNLOAD:BYTES:", "").replace("]", "").trim(),
    );
    updateDownloadProgress({ downloadedBytes });
    return;
  }
  if (line.startsWith("[UPDATE_PREP:DOWNLOAD:PERCENT:")) {
    const percent = Number(
      line.replace("[UPDATE_PREP:DOWNLOAD:PERCENT:", "").replace("]", "").trim(),
    );
    updateDownloadProgress({ percent });
    return;
  }

  // Marker lines from prepare-update script.
  if (line.includes("[UPDATE_PREP:STEP:BACKUP:START]")) {
    setPhaseProgress("backup", 5, "Creating backup snapshot...");
    emitLog("Creating backup snapshot...", "info");
    return;
  }
  if (line.includes("[UPDATE_PREP:STEP:BACKUP:COMPLETE]")) {
    setPhaseProgress("backup", 100, "Backup snapshot prepared");
    emitLog("Backup snapshot prepared.", "success");
    return;
  }
  if (line.includes("[UPDATE_PREP:STEP:DOWNLOAD:START]")) {
    prepState.download = {
      totalBytes: 0,
      downloadedBytes: 0,
      percent: 0,
    };
    setPhaseProgress("download", 5, "Downloading update payload...");
    emitLog("Downloading update payload...", "info");
    return;
  }
  if (line.includes("[UPDATE_PREP:STEP:DOWNLOAD:COMPLETE]")) {
    updateDownloadProgress({
      downloadedBytes:
        Number(prepState.download.downloadedBytes) || Number(prepState.download.totalBytes) || 0,
      percent: 100,
    });
    setPhaseProgress(
      "download",
      100,
      "Update payload downloaded",
      buildDownloadDetail(prepState.download),
    );
    emitLog("Update payload downloaded.", "success");
    return;
  }
  if (line.includes("[UPDATE_PREP:STEP:VERIFY:START]")) {
    setPhaseProgress("download", 100, "Verifying update payload checksum...");
    emitLog("Verifying update payload checksum...", "info");
    return;
  }
  if (line.includes("[UPDATE_PREP:STEP:VERIFY:COMPLETE]")) {
    setPhaseProgress("download", 100, "Update payload verified");
    emitLog("Update payload checksum verified.", "success");
    return;
  }
  if (line.includes("[UPDATE_PREP:STEP:EXTRACT:START]")) {
    setPhaseProgress("extract", 5, "Extracting update payload...");
    emitLog("Extracting update payload...", "info");
    return;
  }
  if (line.includes("[UPDATE_PREP:STEP:EXTRACT:COMPLETE]")) {
    setPhaseProgress("extract", 100, "Update payload extracted");
    emitLog("Update payload extracted.", "success");
    return;
  }
  if (line.includes("[UPDATE_PREP:STEP:BUILD:START]")) {
    setPhaseProgress("build", 5, "Staging macOS application artifacts...");
    handlePreparationBuildSignal("start", 5, "Staging application bundle");
    emitLog("Staging macOS application artifacts...", "info");
    return;
  }
  if (line.includes("[UPDATE_PREP:STEP:BUILD:COMPLETE]")) {
    setPhaseProgress("build", 98, "Application artifacts staged");
    handlePreparationBuildSignal("complete", 100, "Application artifacts ready");
    emitLog("Application artifacts staged.", "success");
    return;
  }
  if (line.startsWith("[UPDATE_PREP:MANIFEST:")) {
    job.manifestPath = line.replace("[UPDATE_PREP:MANIFEST:", "").replace("]", "").trim();
    return;
  }
  if (line.startsWith("[UPDATE_PREP:RELEASE_MANIFEST:")) {
    job.releaseManifestPath = line.replace("[UPDATE_PREP:RELEASE_MANIFEST:", "").replace("]", "").trim();
    return;
  }
  if (line.startsWith("[UPDATE_PREP:BUILD_INFO:")) {
    job.buildInfoPath = line.replace("[UPDATE_PREP:BUILD_INFO:", "").replace("]", "").trim();
    return;
  }
  if (line.startsWith("[UPDATE_PREP:MANAGED_ROOT_DIR:")) {
    job.managedRootDir = line.replace("[UPDATE_PREP:MANAGED_ROOT_DIR:", "").replace("]", "").trim();
    return;
  }
  if (line.startsWith("[UPDATE_PREP:SELECTED_ARCH:")) {
    job.selectedArch = line.replace("[UPDATE_PREP:SELECTED_ARCH:", "").replace("]", "").trim();
    return;
  }
  if (line.startsWith("[UPDATE_PREP:APP_BUNDLE:")) {
    job.selectedAppBundle = line.replace("[UPDATE_PREP:APP_BUNDLE:", "").replace("]", "").trim();
    return;
  }
  if (line.startsWith("[UPDATE_PREP:DMG:")) {
    job.selectedDmg = line.replace("[UPDATE_PREP:DMG:", "").replace("]", "").trim();
    return;
  }
  if (line.startsWith("[UPDATE_PREP:INSTALL_MODE:")) {
    job.installMode = line.replace("[UPDATE_PREP:INSTALL_MODE:", "").replace("]", "").trim();
    return;
  }
  if (line.startsWith("[UPDATE_PREP:CHECKSUM_VERIFIED:")) {
    const checksumPayload = line
      .replace("[UPDATE_PREP:CHECKSUM_VERIFIED:", "")
      .replace("]", "")
      .trim();
    const [algorithm, value] = checksumPayload.split(":");
    if (algorithm && value) {
      job.checksumAlgorithm = algorithm;
      job.checksumValue = value;
    }
    return;
  }
  if (line.startsWith("[UPDATE_PREP:BACKUP_REQUIRED:")) {
    const backupRequiredValue = line
      .replace("[UPDATE_PREP:BACKUP_REQUIRED:", "")
      .replace("]", "")
      .trim();
    job.backupRequired = parseBooleanFlag(backupRequiredValue, false);
    return;
  }
  if (line.startsWith("[UPDATE_PREP:BACKUP_FILE:")) {
    job.fullBackupPath = line
      .replace("[UPDATE_PREP:BACKUP_FILE:", "")
      .replace("]", "")
      .trim();
    if (!job.fullBackupName && job.fullBackupPath) {
      job.fullBackupName = path.basename(job.fullBackupPath);
    }
    return;
  }
  if (line.startsWith("[UPDATE_PREP:ERROR:")) {
    job.scriptError = normalizeNonEmptyPath(
      line.replace("[UPDATE_PREP:ERROR:", "").replace("]", "").trim(),
    );
    return;
  }

  if (line.includes("Selecting macOS app bundle")) {
    setPhaseProgress("build", 35, "Selecting native macOS app bundle...");
    handlePreparationBuildSignal("select-app", 35, "Selecting native app bundle");
  } else if (line.includes("Staging managed runtime tree")) {
    setPhaseProgress("build", 55, "Staging managed runtime tree...");
    handlePreparationBuildSignal("stage-runtime", 55, "Staging managed runtime tree");
  } else if (line.includes("Staging application bundle")) {
    setPhaseProgress("build", 75, "Staging application bundle...");
    handlePreparationBuildSignal("stage-app", 75, "Staging application bundle");
  } else if (line.includes("Prepared payload manifest written")) {
    setPhaseProgress("build", 95, "Finalizing prepared update...");
    handlePreparationBuildSignal("finalize", 95, "Finalizing prepared update");
  }

  emitLog(line, source === "stderr" ? "error" : "info");
}

function parseManifestFallback(stageDir, job, updateKey) {
  const sourceDir = job.sourceDir || path.join(stageDir, "payload");
  const managedRootDir = job.managedRootDir || path.join(sourceDir, "managed-root");
  const buildInfoPath = job.buildInfoPath || path.join(managedRootDir, "electron-app", "build-info.json");
  const manifestPath = job.manifestPath || path.join(stageDir, "manifest.json");
  const checksumIdentity = getChecksumIdentity(job.updateInfo?.checksum);
  const fullBackupPath = normalizeNonEmptyPath(job.fullBackupPath);
  const lastModified = typeof job.updateInfo?.lastModified === "string"
    ? job.updateInfo.lastModified
    : "unknown";

  return {
    updateKey,
    stageDir,
    sourceDir,
    managedRootDir,
    backupRequired: parseBooleanFlag(job.backupRequired, false),
    fullBackupPath,
    fullBackupName: job.fullBackupName || (fullBackupPath ? path.basename(fullBackupPath) : null),
    releaseManifestPath: job.releaseManifestPath || path.join(sourceDir, "release-manifest.json"),
    selectedArch: normalizeSelectedArch(job.selectedArch),
    selectedAppBundle: normalizeNonEmptyPath(job.selectedAppBundle),
    selectedDmg: normalizeNonEmptyPath(job.selectedDmg),
    dockerImages: normalizeDockerImageList(job.dockerImages),
    buildInfoPath,
    manifestPath,
    installMode: job.installMode || "applications",
    checksumAlgorithm: job.checksumAlgorithm || checksumIdentity?.algorithm || null,
    checksumValue: job.checksumValue || checksumIdentity?.value || null,
    lastModified,
    preparedAt: new Date().toISOString(),
  };
}

function loadPreparedArtifacts(stageDir, job, updateKey) {
  const fallback = parseManifestFallback(stageDir, job, updateKey);
  if (!fs.existsSync(fallback.manifestPath)) {
    return fallback;
  }

  try {
    const raw = fs.readFileSync(fallback.manifestPath, "utf8");
    const parsed = JSON.parse(raw);
    const fullBackupPath = normalizeNonEmptyPath(
      parsed.fullBackupPath || fallback.fullBackupPath,
    );
    const backupRequired = parseBooleanFlag(
      parsed.backupRequired,
      fallback.backupRequired,
    );
    return {
      ...fallback,
      ...parsed,
      updateKey,
      sourceDir: parsed.sourceDir || fallback.sourceDir,
      managedRootDir: parsed.managedRootDir || fallback.managedRootDir,
      backupRequired,
      fullBackupPath,
      fullBackupName: parsed.fullBackupName ||
        fallback.fullBackupName ||
        (fullBackupPath ? path.basename(fullBackupPath) : null),
      selectedArch: normalizeSelectedArch(parsed.selectedArch || fallback.selectedArch),
      selectedAppBundle: parsed.selectedAppBundle || fallback.selectedAppBundle,
      selectedDmg: parsed.selectedDmg || fallback.selectedDmg,
      dockerImages: normalizeDockerImageList(parsed.dockerImages || fallback.dockerImages),
      installMode: parsed.installMode || fallback.installMode,
    };
  } catch (error) {
    console.warn("[Update Prep] Failed to parse manifest, using fallback:", error.message);
    return fallback;
  }
}

function createPreparationError(message, code, extras = {}) {
  const error = new Error(message);
  error.code = code;
  return Object.assign(error, extras);
}

function isDockerRuntimeFailureKind(failureKind) {
  return [
    "daemon_unavailable",
    "process_error",
    "timeout_inactivity",
    "timeout_total",
    "terminated",
  ].includes(failureKind);
}

function isDockerRuntimeOnlyPullFailureResult(result) {
  if (!result || result.cancelled) {
    return false;
  }

  const failureDetails = Array.isArray(result.failureDetails)
    ? result.failureDetails.filter(Boolean)
    : [];
  if (failureDetails.length === 0) {
    return false;
  }

  return failureDetails.every((detail) => isDockerRuntimeFailureKind(detail.failureKind));
}

function hasMissingOverlayfsSnapshotParentFailure(result) {
  const failureDetails = Array.isArray(result?.failureDetails)
    ? result.failureDetails.filter(Boolean)
    : [];
  return Boolean(result?.snapshotStoreRepair) || failureDetails.some(
    (detail) => detail.failureKind === "overlayfs_snapshot_parent_missing",
  );
}

function isDockerRecoveryEligibleError(error) {
  if (!error || typeof error !== "object") {
    return false;
  }

  if (error.code === "docker_not_ready") {
    return true;
  }

  if (error.code === "docker_pull_failed") {
    return error.dockerRecoveryEligible === true;
  }

  return false;
}

function formatDockerFailureImages(result) {
  if (Array.isArray(result?.failed) && result.failed.length > 0) {
    return result.failed.join(", ");
  }
  return "unknown";
}

async function runDockerPreparationAttempt(job, normalizedPlannedImages) {
  setPhaseProgress("docker", 1, "Ensuring Docker is running...");
  emitLog("Checking Docker status...", "info");

  const dockerReady = await ensureDockerRunning({
    promptUser: false,
    onLog: (message, type) => emitLog(message, type),
    onStatus: (message) => setPhaseProgress("docker", 1, message, message),
  });
  if (!dockerReady) {
    throw createPreparationError(
      "Docker is not running. Please start OrbStack and retry the update.",
      "docker_not_ready",
      { dockerRecoveryEligible: true },
    );
  }

  setPhaseProgress("docker", 5, "Pulling Docker images...");
  emitLog("Pulling Docker images for upcoming update...", "info");

  prepState.docker.manifestCount = normalizedPlannedImages.length;
  prepState.docker.sourceManifestPath = normalizeNonEmptyPath(job.releaseManifestPath);
  prepState.docker.failedImages = [];
  prepState.docker.preparedAt = null;
  emitStatus();

  emitLog(
    `Using Docker image manifest: ${prepState.docker.sourceManifestPath || "unknown"}`,
    "info",
  );
  emitLog(
    `Release manifest declares ${normalizedPlannedImages.length} Docker images for background preparation.`,
    "info",
  );
  for (const image of normalizedPlannedImages) {
    const display = formatDockerImageSpec(image);
    emitLog(
      image.label && image.label !== display
        ? `  - ${display} (${image.label})`
        : `  - ${display}`,
      "info",
    );
  }

  const result = await prerequisitesService.pullDockerImagesWithProgress({
    targetWindow: createDockerBridge(job),
    images: normalizedPlannedImages,
    maxRetries: 1,
    concurrency: 2,
  });

  if (job.cancelled) {
    throw createPreparationError(
      "Update preparation cancelled",
      "update_preparation_cancelled",
    );
  }
  if (!result || result.success !== true) {
    const snapshotStoreRepairRequired =
      hasMissingOverlayfsSnapshotParentFailure(result);
    throw createPreparationError(
      `Failed to pull Docker images: ${formatDockerFailureImages(result)}`,
      snapshotStoreRepairRequired
        ? DOCKER_SNAPSHOT_STORE_REPAIR_REQUIRED_CODE
        : "docker_pull_failed",
      {
        dockerPullResult: result,
        dockerRecoveryEligible: isDockerRuntimeOnlyPullFailureResult(result),
      },
    );
  }
}

async function runDockerPreparation(job, plannedImages) {
  const normalizedPlannedImages = normalizeDockerImageList(plannedImages);
  if (normalizedPlannedImages.length === 0) {
    throw createPreparationError(
      "Release payload manifest did not provide a valid Docker image list for update preparation.",
      "invalid_docker_manifest",
    );
  }

  emitLog(
    `Using Docker image manifest: ${normalizeNonEmptyPath(job.releaseManifestPath) || "unknown"}`,
    "info",
  );
  emitLog(
    `Release manifest declares ${normalizedPlannedImages.length} Docker images for background preparation.`,
    "info",
  );
  for (const image of normalizedPlannedImages) {
    const display = formatDockerImageSpec(image);
    emitLog(
      image.label && image.label !== display
        ? `  - ${display} (${image.label})`
        : `  - ${display}`,
      "info",
    );
  }

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_DOCKER_PREPARATION_ATTEMPTS; attempt += 1) {
    if (typeof prerequisitesService.resetPrerequisitesCancellation === "function") {
      prerequisitesService.resetPrerequisitesCancellation();
    }

    if (attempt > 1) {
      const retryMessage = `Retrying Docker image preparation... (${attempt}/${MAX_DOCKER_PREPARATION_ATTEMPTS})`;
      emitLog(retryMessage, "warning");
      setPhaseProgress("docker", 5, "Retrying Docker image preparation...", retryMessage);
    }

    try {
      await runDockerPreparationAttempt(job, normalizedPlannedImages);
      return;
    } catch (error) {
      lastError = error;

      if (job.cancelled || error?.code === "update_preparation_cancelled") {
        throw new Error("Update preparation cancelled");
      }

      if (
        attempt >= MAX_DOCKER_PREPARATION_ATTEMPTS ||
        !isDockerRecoveryEligibleError(error)
      ) {
        throw error;
      }

      emitLog("Docker stalled; restarting OrbStack...", "warning");
      setPhaseProgress(
        "docker",
        2,
        "Restarting OrbStack...",
        "Docker stalled; attempting automatic recovery",
      );

      const recovery = await restartOrbStackAndWaitForDocker({
        onLog: (message, type) => emitLog(message, type),
        onStatus: (message) => setPhaseProgress("docker", 2, message, message),
      });
      if (!recovery?.success) {
        throw createPreparationError(
          `Automatic Docker recovery failed: ${recovery?.error || "Unknown error"}`,
          "docker_recovery_failed",
          { cause: error },
        );
      }

      emitLog("Docker recovered after OrbStack restart.", "success");
    }
  }

  throw lastError || new Error("Docker image preparation failed");
}

async function runPreflightDockerStorageMaintenance() {
  emitLog(
    "Checking Docker storage before the update free-space preflight...",
    "info",
  );
  const dockerReady = await ensureDockerRunning({
    promptUser: false,
    onLog: (message, type) => emitLog(message, type),
  });
  if (!dockerReady) {
    emitLog(
      "Docker is not ready; skipping storage maintenance and continuing to the update free-space preflight.",
      "warning",
    );
    return { success: false, skipped: true, reason: "docker-not-ready" };
  }

  const result = await runDockerStorageMaintenance({
    projectRoot: bootstrap.PROJECT_ROOT,
    resourcesPath: process.resourcesPath,
    includeMigration: true,
    // Preflight has no completed from -> to transition or post-update health
    // proof. Destructive cleanup is reserved for the exact post-health path.
    includeCleanup: false,
    onLog: (message, type) => emitLog(message, type),
  });
  if (!result.success) {
    emitLog(
      "Docker storage maintenance was incomplete; the normal update free-space preflight will decide whether preparation can continue.",
      "warning",
    );
  }
  return result;
}

function resolvePrepareScriptPath(options = {}) {
  const isPackaged = options.isPackaged ?? Boolean(electronApp?.isPackaged);
  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  const projectRoot = options.projectRoot ?? bootstrap.PROJECT_ROOT;

  if (isPackaged) {
    if (!resourcesPath) {
      throw new Error("Packaged update preparation resource path is unavailable");
    }
    const bundledScriptPath = path.join(
      resourcesPath,
      "prereq-scripts",
      "prepare-update-cloudsmith.sh",
    );
    if (!fs.existsSync(bundledScriptPath)) {
      throw new Error(`Packaged prepare script not found: ${bundledScriptPath}`);
    }
    return bundledScriptPath;
  }

  const developmentScriptPath = path.join(
    projectRoot,
    "electron-app",
    "src",
    "scripts",
    "prepare-update-cloudsmith.sh",
  );
  if (!fs.existsSync(developmentScriptPath)) {
    throw new Error(`Development prepare script not found: ${developmentScriptPath}`);
  }
  return developmentScriptPath;
}

function runPrepareScript(job, updateInfo, stageDir, updateKey) {
  return new Promise((resolve, reject) => {
    const projectRoot = bootstrap.PROJECT_ROOT;
    const scriptPath = resolvePrepareScriptPath({ projectRoot });
    const resolvedFullSha =
      updateInfo.latestFullSha || updateInfo.fullSha || updateInfo.latestBuildNumber;
    const updateChannel = updateInfo.updateChannel || "portico";
    const checksumIdentity = getChecksumIdentity(updateInfo.checksum);
    const lastModified = typeof updateInfo.lastModified === "string"
      ? updateInfo.lastModified
      : "";
    const fileSize = Number.isFinite(Number(updateInfo.fileSize))
      ? String(Math.max(0, Number(updateInfo.fileSize)))
      : "";

    if (!checksumIdentity) {
      return reject(
        new Error(
          "Update payload checksum metadata is missing. Refusing preparation to avoid stale snapshots.",
        ),
      );
    }

    const child = spawn(
      "bash",
      [
        scriptPath,
        stageDir,
        projectRoot,
        updateInfo.downloadUrl,
        updateInfo.filename,
        resolvedFullSha,
        updateKey,
        updateChannel,
        checksumIdentity.algorithm,
        checksumIdentity.value,
        lastModified,
        fileSize,
      ],
      {
        cwd: projectRoot,
        env: createEnhancedEnv({ FORCE_COLOR: "0" }),
      },
    );

    job.child = child;
    job.stdoutLineBuffer = "";
    job.stderrLineBuffer = "";

    const onChunk = (chunk, source = "stdout") => {
      if (job.cancelled) return;
      const bufferKey = source === "stderr" ? "stderrLineBuffer" : "stdoutLineBuffer";
      job[bufferKey] += chunk.toString();
      const lines = job[bufferKey].split("\n");
      job[bufferKey] = lines.pop() || "";

      for (const line of lines) {
        handlePrepareScriptLine(line.trim(), job, source);
      }
    };

    child.stdout.on("data", (chunk) => onChunk(chunk, "stdout"));
    child.stderr.on("data", (chunk) => onChunk(chunk, "stderr"));

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (job.cancelled) {
        return reject(new Error("Update preparation cancelled"));
      }

      if (job.stdoutLineBuffer && job.stdoutLineBuffer.trim()) {
        handlePrepareScriptLine(job.stdoutLineBuffer.trim(), job, "stdout");
      }
      if (job.stderrLineBuffer && job.stderrLineBuffer.trim()) {
        handlePrepareScriptLine(job.stderrLineBuffer.trim(), job, "stderr");
      }

      if (code !== 0) {
        return reject(new Error(resolvePrepareScriptFailureMessage(job, code)));
      }
      resolve();
    });
  });
}

async function startPreparation(updateInfo, options = {}) {
  if (!updateInfo || !updateInfo.downloadUrl || !updateInfo.filename) {
    return { success: false, error: "Missing required update information" };
  }

  // PORTICO-215: never let a disk-full setup failure reject the IPC promise
  // with a generic error; surface it through the failed prep state instead.
  const failPreparationStart = (message) => {
    clearStateForFailure(message);
    emitStatus();
    emitLog(`Update preparation failed: ${message}`, "error");
    return { success: false, error: message, status: cloneStatus() };
  };

  try {
    ensureInitialized();
    ensurePreparationRoot();
  } catch (error) {
    return failPreparationStart(translatePreparationError(error));
  }
  const forcePreparation = options && options.force === true;

  const checksumIdentity = getChecksumIdentity(updateInfo.checksum);
  if (!checksumIdentity) {
    return {
      success: false,
      error:
        "Update payload checksum metadata is missing. Refusing preparation to prevent stale installs.",
    };
  }

  const updateKey = buildUpdateKey(updateInfo);
  if (!updateKey) {
    return { success: false, error: "Unable to build update preparation key" };
  }

  if (activeJob && activeJob.updateKey === updateKey) {
    return { success: true, status: cloneStatus(), alreadyRunning: true };
  }

  if (!forcePreparation) {
    const alreadyPrepared = getPreparedInfoForUpdate(updateInfo);
    if (alreadyPrepared) {
      prepState.state = "ready";
      prepState.phase = "ready";
      prepState.message = "Update is already prepared";
      prepState.phasePercent = 100;
      prepState.phaseDetail = "Prepared update is ready to install";
      prepState.overallPercent = 100;
      prepState.error = null;
      prepState.prepared = alreadyPrepared;
      emitStatus();
      return { success: true, status: cloneStatus(), alreadyPrepared: true };
    }
  }

  if (activeJob) {
    cancelPreparation("superseded");
  }

  if (preflightUpdateKey) {
    const inProgressKey = preflightUpdateKey;
    return {
      success: true,
      status: cloneStatus(),
      alreadyRunning: true,
      preflightBusy: inProgressKey !== updateKey,
      activeUpdateKey: inProgressKey,
    };
  }

  preflightUpdateKey = updateKey;
  let stageDir;
  let job;
  try {
    setPreflightState(updateKey);
    emitStatus();
    emitLog("Checking update prerequisites...", "info");

    // Reclaim staging directories left by historical killed reconciles before
    // measuring headroom. This is a one-shot startup/update transition, not a
    // timer, and the strict basename check cannot reach unrelated TMPDIR data.
    const strandSweep = await cleanupStaleReconcileStrands();
    if (strandSweep.removed.length > 0) {
      appendPreparationLogLine(
        `Removed ${strandSweep.removed.length} stale managed-runtime reconcile strand(s) before disk preflight`,
        "info",
      );
    }
    if (strandSweep.failed.length > 0) {
      appendPreparationLogLine(
        `Could not remove ${strandSweep.failed.length} stale managed-runtime reconcile strand(s) before disk preflight`,
        "warning",
      );
    }

    // Run the one-time BuildKit policy migration before the existing PORTICO-215
    // preflight. It is best-effort and never bypasses or replaces the disk check.
    // Image deletion requires the exact post-update transition and health proof.
    try {
      await runPreflightDockerStorageMaintenance();
    } catch (error) {
      appendPreparationLogLine(
        `Docker storage maintenance failed before disk preflight: ${error.message}`,
        "warning",
      );
    }

    // PORTICO-215: free-disk-space preflight before any stage-dir mutation.
    // Free-space measurement fails open (skipped); the requirement estimate
    // degrades conservatively-small, so this can only block a genuinely
    // near-full disk — with exact, actionable numbers.
    try {
      const diskCheck = await checkPrepareDiskSpace({
        preparationRoot: PREPARATION_ROOT,
        fileSize: updateInfo.fileSize,
        managedDir: bootstrap.PROJECT_ROOT,
      });
      if (diskCheck && diskCheck.ok === false) {
        return failPreparationStart(diskCheck.message);
      }
      if (diskCheck && diskCheck.skipped) {
        appendPreparationLogLine(
          "Skipping free disk space check (free-space measurement unavailable on this system)",
          "info",
        );
      }
    } catch (error) {
      console.error("[Update Prep] Disk space preflight error:", error.message);
    }

    try {
      cleanupStaleStageDirs(updateKey);
      stageDir = getStageDir(updateKey);
      removePathRecursive(stageDir);
      fs.mkdirSync(stageDir, { recursive: true });
    } catch (error) {
      return failPreparationStart(translatePreparationError(error));
    }

    setPreparingState(updateKey);
    logPreparationSessionHeader(updateKey, updateInfo, stageDir);
    emitStatus();
    emitLog("Preparing update in the background...", "info");

    job = {
      id: Date.now(),
      updateKey,
      cancelled: false,
      child: null,
      stdoutLineBuffer: "",
      stderrLineBuffer: "",
      scriptError: null,
      stageDir,
      manifestPath: null,
      releaseManifestPath: null,
      managedRootDir: null,
      selectedArch: null,
      selectedAppBundle: null,
      selectedDmg: null,
      installMode: null,
      buildInfoPath: null,
      dockerImages: [],
      backupRequired: false,
      fullBackupPath: null,
      fullBackupName: null,
      updateInfo,
      checksumAlgorithm: checksumIdentity.algorithm,
      checksumValue: checksumIdentity.value,
    };
    activeJob = job;
  } finally {
    if (preflightUpdateKey === updateKey) {
      preflightUpdateKey = null;
    }
  }

  try {
    await runPrepareScript(job, updateInfo, stageDir, updateKey);

    const preparedArtifacts = loadPreparedArtifacts(stageDir, job, updateKey);
    const releaseManifest = loadReleaseManifest(preparedArtifacts.releaseManifestPath);
    const mergedPrepared = mergePreparedArtifactsWithReleaseManifest(
      preparedArtifacts,
      releaseManifest,
    );
    const stagedValidation = validatePreparedArtifactsForInstall(mergedPrepared);
    if (!stagedValidation.success) {
      throw new Error(stagedValidation.error || "Prepared artifacts failed validation");
    }
    const prepared = {
      ...stagedValidation.prepared,
      prepLogPath: prepState.logPath,
      artifactsReady: true,
      dockerReady: false,
      ready: false,
    };
    persistPreparedManifest(prepared);
    prepState.prepared = prepared;
    emitStatus();
    emitLog(
      "Application and managed-runtime artifacts validated and persisted for recovery.",
      "success",
    );
    job.releaseManifestPath = prepared.releaseManifestPath;
    job.selectedArch = prepared.selectedArch;
    job.selectedAppBundle = prepared.selectedAppBundle;
    job.selectedDmg = prepared.selectedDmg;
    job.buildInfoPath = prepared.buildInfoPath;
    job.dockerImages = prepared.dockerImages;

    if (!arePreparedArtifactsValid(prepared)) {
      throw new Error("Prepared artifacts missing after build");
    }

    await runDockerPreparation(job, prepared.dockerImages);

    prepState.state = "ready";
    prepState.phase = "ready";
    prepState.message = "Update prepared and ready to install";
    prepState.phasePercent = 100;
    prepState.phaseDetail = "Background update preparation complete";
    prepState.overallPercent = 100;
    prepState.error = null;
    prepState.prepared = {
      ...prepared,
      prepLogPath: prepState.logPath,
      artifactsReady: true,
      dockerReady: true,
      ready: true,
    };
    persistPreparedManifest(prepState.prepared);
    emitStatus();
    emitLog("Update preparation completed.", "success");

    return { success: true, status: cloneStatus(), prepared: prepState.prepared };
  } catch (error) {
    if (job.cancelled) {
      return { success: false, cancelled: true, error: "Update preparation cancelled" };
    }
    // PORTICO-215: surface disk-full failures with their actionable message.
    const failureMessage = translatePreparationError(error);
    clearStateForFailure(failureMessage);
    emitStatus();
    emitLog(`Update preparation failed: ${failureMessage}`, "error");
    return { success: false, error: failureMessage, status: cloneStatus() };
  } finally {
    if (activeJob && activeJob.id === job.id) {
      activeJob = null;
    }
    if (typeof prerequisitesService.resetPrerequisitesCancellation === "function") {
      prerequisitesService.resetPrerequisitesCancellation();
    }
  }
}

function ensureInitialized() {
  if (initialized) {
    return;
  }
  initialize();
}

function initialize() {
  if (initialized) {
    return;
  }

  ensurePreparationRoot();
  loadPersistedState();

  let recoveredFromStagedManifest = false;
  if (!prepState.prepared || !arePreparedArtifactsValid(prepState.prepared)) {
    const discoveredPrepared = discoverRecoverablePreparedArtifacts();
    if (discoveredPrepared) {
      prepState.prepared = discoveredPrepared;
      prepState.updateKey = discoveredPrepared.updateKey;
      prepState.phase = "docker";
      prepState.logPath = normalizeNonEmptyPath(prepState.logPath) || getPreparationLogPath();
      recoveredFromStagedManifest = true;
    }
  }

  if (prepState.state === "preparing" || recoveredFromStagedManifest) {
    if (prepState.prepared && arePreparedArtifactsValid(prepState.prepared)) {
      const interruptedPhase = prepState.phase || "unknown";
      prepState.state = "interrupted";
      prepState.message = "Update preparation was interrupted";
      prepState.phaseDetail = "Application/runtime artifacts remain staged for recovery";
      prepState.prepared = {
        ...prepState.prepared,
        artifactsReady: true,
        dockerReady: false,
        ready: false,
      };
      appendPreparationLogLine(
        `${recoveredFromStagedManifest ? "Discovered validated staged artifacts left by an earlier app" : "Recovered interrupted preparation state after restart"}; phase=${interruptedPhase}; updateKey=${prepState.updateKey || "unknown"}; quitProvenance=user/OS/external.`,
        "warning",
      );
      persistState();
    } else {
      prepState = createDefaultPrepState();
      persistState();
    }
  } else if (prepState.prepared && !arePreparedArtifactsValid(prepState.prepared)) {
    prepState = createDefaultPrepState();
    persistState();
  } else if (prepState.prepared && prepState.state === "ready") {
    cleanupStaleStageDirs(prepState.updateKey);
  }

  initialized = true;
}

function getPreparationStatus() {
  ensureInitialized();
  return cloneStatus();
}

function getActivePreparationLogPath() {
  ensureInitialized();
  return normalizeNonEmptyPath(prepState.logPath) || getPreparationLogPath();
}

function attachPreparedArtifacts(updateInfo) {
  const prepared = getPreparedInfoForUpdate(updateInfo);
  if (!prepared) {
    return updateInfo;
  }
  return {
    ...updateInfo,
    prepared,
  };
}

function consumePreparedArtifacts(updateKey = null) {
  ensureInitialized();
  const prepared = prepState.prepared;
  if (!prepared || (updateKey && prepared.updateKey !== updateKey)) {
    return { success: false, consumed: false, reason: "prepared-state-mismatch" };
  }
  const validation = validatePreparedArtifactsForInstall(prepared);
  if (!validation.success) {
    return {
      success: false,
      consumed: false,
      reason: "prepared-validation-failed",
      error: validation.error,
    };
  }

  try {
    removePathRecursive(validation.prepared.stageDir);
  } catch (error) {
    return {
      success: false,
      consumed: false,
      reason: "stage-cleanup-failed",
      error: error.message,
    };
  }
  prepState = createDefaultPrepState();
  persistState();
  return { success: true, consumed: true };
}

module.exports = {
  buildUpdateKey,
  initialize,
  startPreparation,
  cancelPreparation,
  clearPreparation,
  getPreparationStatus,
  getActivePreparationLogPath,
  getPreparedInfoForUpdate,
  attachPreparedArtifacts,
  consumePreparedArtifacts,
  validatePreparedArtifactsForInstall,
  _test: {
    createDefaultPrepState,
    arePreparedArtifactsValid,
    getPreparationStatus,
    isDockerRuntimeOnlyPullFailureResult,
    isDockerRecoveryEligibleError,
    loadReleaseManifest,
    loadPreparedArtifacts,
    mergePreparedArtifactsWithReleaseManifest,
    parseManifestFallback,
    getPreparationLogPath,
    redactDownloadUrl,
    runDockerPreparation,
    runPreflightDockerStorageMaintenance,
    setPreparingState,
    handlePrepareScriptLine,
    resolvePrepareScriptFailureMessage,
    resolvePrepareScriptPath,
    translatePreparationError,
    validatePreparedArtifactsForInstall,
    consumePreparedArtifacts,
    isPathContained,
    discoverRecoverablePreparedArtifacts,
  },
};
