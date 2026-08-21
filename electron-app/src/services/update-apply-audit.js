const fs = require("fs");
const path = require("path");

const APPLY_LOG_PREFIX = "update-apply-";
const APPLY_LOG_RETENTION = 10;
const UPDATE_HISTORY_FILE = "update-history.jsonl";
const UPDATE_HISTORY_RETENTION = 500;
const POST_HEALTH_CLEANUP_STEP = "post_health_cleanup";
const POST_HEALTH_CLEANUP_SOURCE = "docker-storage-maintenance";
const RELEASE_TAG_PATTERN = /^[0-9]{8}-[0-9a-f]+$/;
const AUTHORITATIVE_TRANSITION_SOURCES = new Set([
  "apply-prepared-update",
  "runtime-reconcile",
]);

function sanitizeFileComponent(value, fallback = "runtime-update") {
  const normalized = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return normalized || fallback;
}

function formatTimestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function listApplyLogs(healthStatusDir, fsImpl = fs) {
  try {
    return fsImpl
      .readdirSync(healthStatusDir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.startsWith(APPLY_LOG_PREFIX) &&
          entry.name.endsWith(".log"),
      )
      .map((entry) => ({
        name: entry.name,
        path: path.join(healthStatusDir, entry.name),
        mtimeMs: fsImpl.statSync(path.join(healthStatusDir, entry.name)).mtimeMs,
      }))
      .sort(
        (left, right) =>
          left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name),
      );
  } catch {
    return [];
  }
}

function pruneApplyLogs(
  healthStatusDir,
  options = {},
) {
  const fsImpl = options.fsImpl || fs;
  const retention = Number.isInteger(options.retention)
    ? Math.max(1, options.retention)
    : APPLY_LOG_RETENTION;
  const logs = listApplyLogs(healthStatusDir, fsImpl);

  for (const stale of logs.slice(0, Math.max(0, logs.length - retention))) {
    try {
      fsImpl.rmSync(stale.path, { force: true });
    } catch (error) {
      console.warn(
        `[Runtime Update] Could not prune stale apply audit ${stale.path}: ${error.message}`,
      );
    }
  }
}

function persistApplyAudit(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const projectRoot = options.projectRoot;
  if (!projectRoot) {
    return { success: false, error: "projectRoot is required" };
  }

  const startedAt = options.startedAt instanceof Date
    ? options.startedAt
    : new Date(options.startedAt || Date.now());
  const finishedAt = options.finishedAt instanceof Date
    ? options.finishedAt
    : new Date(options.finishedAt || Date.now());
  const updateKey = sanitizeFileComponent(options.updateKey);
  const healthStatusDir = path.join(projectRoot, "health-status");
  const auditPath = path.join(
    healthStatusDir,
    `${APPLY_LOG_PREFIX}${updateKey}-${formatTimestampForFile(startedAt)}.log`,
  );
  const result = options.result || {};
  const combinedOutput = String(options.combinedOutput || "");
  const command = Array.isArray(options.command)
    ? options.command.map((part) => String(part)).join(" ")
    : String(options.command || "");
  const body = [
    "Portico managed runtime apply audit",
    `Started: ${startedAt.toISOString()}`,
    `Finished: ${finishedAt.toISOString()}`,
    `Update Key: ${options.updateKey || "runtime-update"}`,
    `Command: ${command}`,
    `Result: ${result.success ? "ok" : "fail"}`,
    `Exit Code: ${result.code ?? "unknown"}`,
    result.error ? `Error: ${result.error}` : null,
    "",
    "--- combined stdout/stderr ---",
    combinedOutput,
  ]
    .filter((line) => line !== null)
    .join("\n");

  try {
    fsImpl.mkdirSync(healthStatusDir, { recursive: true });
    fsImpl.writeFileSync(auditPath, body.endsWith("\n") ? body : `${body}\n`, "utf8");
    pruneApplyLogs(healthStatusDir, {
      fsImpl,
      retention: options.retention,
    });
    return { success: true, path: auditPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function getFreeDiskKb(projectRoot, fsImpl = fs) {
  if (typeof fsImpl.statfsSync !== "function") return 0;

  try {
    const stats = fsImpl.statfsSync(projectRoot);
    const availableBlocks = stats.bavail ?? stats.bfree;
    const blockSize = stats.bsize;
    const availableBytes = Number(availableBlocks) * Number(blockSize);
    return Number.isFinite(availableBytes)
      ? Math.max(0, Math.floor(availableBytes / 1024))
      : 0;
  } catch {
    return 0;
  }
}

function appendUpdateHistory(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const projectRoot = options.projectRoot;
  if (!projectRoot) {
    return { success: false, error: "projectRoot is required" };
  }

  const healthStatusDir = path.join(projectRoot, "health-status");
  const historyPath = path.join(healthStatusDir, UPDATE_HISTORY_FILE);
  const tempPath = `${historyPath}.tmp.${process.pid}.${Date.now()}`;
  const retention = Number.isInteger(options.retention)
    ? Math.max(1, options.retention)
    : UPDATE_HISTORY_RETENTION;
  const timestamp = options.timestamp instanceof Date
    ? options.timestamp
    : new Date(options.timestamp || Date.now());
  const result = typeof options.result === "string"
    ? options.result
    : options.result?.success
      ? "ok"
      : "fail";
  const suppliedFreeDiskKb = Number(options.freeDiskKb);
  const freeDiskKb = Number.isFinite(suppliedFreeDiskKb)
    ? Math.max(0, Math.floor(suppliedFreeDiskKb))
    : getFreeDiskKb(projectRoot, fsImpl);
  const entry = {
    ts: timestamp.toISOString(),
    from: String(options.from || "unknown"),
    to: String(options.to || "unknown"),
    step: String(options.step || "unknown"),
    result,
    freeDiskKb,
  };
  if (options.source) {
    entry.source = String(options.source);
  }
  if (options.transitionId) {
    entry.transitionId = String(options.transitionId);
  }

  try {
    fsImpl.mkdirSync(healthStatusDir, { recursive: true });
    let existingLines = [];
    try {
      existingLines = fsImpl
        .readFileSync(historyPath, "utf8")
        .split(/\r?\n/)
        .filter((line) => line.length > 0);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const retainedLines = existingLines.slice(-(retention - 1));
    retainedLines.push(JSON.stringify(entry));
    fsImpl.writeFileSync(tempPath, `${retainedLines.join("\n")}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fsImpl.renameSync(tempPath, historyPath);
    return { success: true, path: historyPath, entry };
  } catch (error) {
    try {
      fsImpl.rmSync(tempPath, { force: true });
    } catch {
      // Best-effort staging cleanup; the original write error is authoritative.
    }
    return { success: false, error: error.message };
  }
}

function readManagedBuildNumber(projectRoot, fsImpl = fs) {
  try {
    const buildInfo = JSON.parse(
      fsImpl.readFileSync(
        path.join(projectRoot, "electron-app", "build-info.json"),
        "utf8",
      ),
    );
    return typeof buildInfo?.buildNumber === "string"
      ? buildInfo.buildNumber.trim()
      : "";
  } catch {
    return "";
  }
}

function findPendingPostHealthCleanup(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const projectRoot = options.projectRoot;
  const currentBuild = String(options.currentBuild || "").trim();
  if (!projectRoot || !currentBuild || currentBuild === "dev-build") {
    return { pending: false, reason: "invalid-current-build" };
  }

  const managedBuild = readManagedBuildNumber(projectRoot, fsImpl);
  if (!managedBuild || managedBuild !== currentBuild) {
    return { pending: false, reason: "managed-build-mismatch" };
  }

  const historyPath = path.join(
    projectRoot,
    "health-status",
    UPDATE_HISTORY_FILE,
  );
  let lines;
  try {
    lines = fsImpl
      .readFileSync(historyPath, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim());
  } catch (error) {
    return {
      pending: false,
      reason: error?.code === "ENOENT" ? "history-missing" : "history-unreadable",
    };
  }

  const entries = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return { pending: false, reason: "history-malformed" };
      }
      entries.push(entry);
    } catch {
      return { pending: false, reason: "history-malformed" };
    }
  }

  let transitionIndex = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.step === "complete" && entry.result === "ok") {
      transitionIndex = index;
      break;
    }
  }
  if (transitionIndex < 0) {
    return { pending: false, reason: "completed-transition-missing" };
  }

  const transition = entries[transitionIndex];
  if (!AUTHORITATIVE_TRANSITION_SOURCES.has(transition.source)) {
    return { pending: false, reason: "transition-not-authoritative" };
  }
  if (
    !transition.transitionId ||
    transition.transitionId === "unknown" ||
    !transition.from ||
    transition.from === "unknown" ||
    !transition.to ||
    transition.to === "unknown" ||
    !RELEASE_TAG_PATTERN.test(transition.from) ||
    !RELEASE_TAG_PATTERN.test(transition.to) ||
    transition.from === transition.to ||
    transition.to !== currentBuild
  ) {
    return { pending: false, reason: "transition-mismatch" };
  }

  const completed = entries.slice(transitionIndex + 1).some(
    (entry) =>
      entry.source === POST_HEALTH_CLEANUP_SOURCE &&
      entry.step === POST_HEALTH_CLEANUP_STEP &&
      entry.result === "ok" &&
      entry.transitionId === transition.transitionId &&
      entry.from === transition.from &&
      entry.to === transition.to,
  );
  if (completed) {
    return { pending: false, reason: "cleanup-complete" };
  }

  return {
    pending: true,
    historyPath,
    transition: {
      from: transition.from,
      to: transition.to,
      source: transition.source,
      transitionId: transition.transitionId,
    },
  };
}

module.exports = {
  APPLY_LOG_RETENTION,
  POST_HEALTH_CLEANUP_SOURCE,
  POST_HEALTH_CLEANUP_STEP,
  UPDATE_HISTORY_RETENTION,
  appendUpdateHistory,
  findPendingPostHealthCleanup,
  persistApplyAudit,
  pruneApplyLogs,
  sanitizeFileComponent,
};
