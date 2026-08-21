// owui-data-integrity-guard.js - fail-closed Open WebUI database size sentinel

const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_DB_RELATIVE_PATH = path.join("open-webui-data", "webui.db");
const DEFAULT_SENTINEL_RELATIVE_PATH = path.join(
  "health-status",
  "owui-db-sentinel.json",
);
const DEFAULT_REPAIR_BACKUP_RELATIVE_PATH = path.join(
  "open-webui-data",
  "repair-backups",
);
const DEFAULT_DB_SNAPSHOT_RELATIVE_PATH = path.join(
  "backup",
  "db-snapshots",
);
const DEFAULT_FULL_BACKUP_RELATIVE_PATH = "backup";
const MEANINGFUL_DB_SIZE_BYTES = 512 * 1024;
const CRITICAL_DB_SIZE_BYTES = 4 * 1024;
const WARNING_SHRINK_RATIO = 0.05;
const FULL_BACKUP_PATTERN = /^portico_full_backup_.*\.zip$/;
const OPEN_WEBUI_CONTAINER_CANDIDATES = ["portico-open-webui", "open-webui"];
const SQLITE_CANDIDATES = [
  "/usr/bin/sqlite3",
  "/opt/homebrew/opt/sqlite/bin/sqlite3",
  "/usr/local/opt/sqlite/bin/sqlite3",
];
const UNZIP_CANDIDATES = ["/usr/bin/unzip", "/opt/homebrew/bin/unzip"];

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function getProjectRoot(options = {}) {
  if (isNonEmptyString(options.projectRoot)) {
    return path.resolve(options.projectRoot.trim());
  }

  // All production call sites pass the initialized project root. Keep this
  // lazy fallback for diagnostics and manual use without making this module
  // load Electron's bootstrap module during plain Node unit tests.
  try {
    const bootstrap = require("./bootstrap");
    if (isNonEmptyString(bootstrap.PROJECT_ROOT)) {
      return path.resolve(bootstrap.PROJECT_ROOT);
    }
  } catch {
    // Fall back to the current directory below.
  }
  return process.cwd();
}

function getDbPath(options = {}) {
  return path.resolve(
    options.dbPath || path.join(getProjectRoot(options), DEFAULT_DB_RELATIVE_PATH),
  );
}

function getSentinelPath(options = {}) {
  return path.resolve(
    options.sentinelPath ||
      path.join(getProjectRoot(options), DEFAULT_SENTINEL_RELATIVE_PATH),
  );
}

function safeReadJson(filePath, fsRef = fs) {
  try {
    const raw = fsRef.readFileSync(filePath, "utf8");
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeSentinel(value) {
  if (!value || typeof value !== "object") return null;
  const sizeBytes = Number(value.sizeBytes);
  const mtimeMs = Number(value.mtimeMs);
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return null;
  if (!Number.isFinite(mtimeMs) || mtimeMs < 0) return null;
  return {
    sizeBytes,
    mtimeMs,
    recordedAt: isNonEmptyString(value.recordedAt) ? value.recordedAt : null,
    buildNumber: value.buildNumber ?? null,
  };
}

function statRegularFile(filePath, fsRef = fs) {
  try {
    const stat = fsRef.statSync(filePath);
    if (typeof stat.isFile === "function" && !stat.isFile()) return null;
    return stat;
  } catch {
    return null;
  }
}

function atomicWriteJson(filePath, value, fsRef = fs) {
  const dirPath = path.dirname(filePath);
  fsRef.mkdirSync(dirPath, { recursive: true });
  const tempPath = path.join(
    dirPath,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );

  try {
    fsRef.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fsRef.renameSync(tempPath, filePath);
  } finally {
    try {
      fsRef.rmSync(tempPath, { force: true });
    } catch {
      // Best effort cleanup after a failed write/rename.
    }
  }
}

function recordDbSentinel(options = {}) {
  const fsRef = options.fsRef || fs;
  const dbPath = getDbPath(options);
  const sentinelPath = getSentinelPath(options);
  const stat = statRegularFile(dbPath, fsRef);

  if (!stat) {
    return {
      success: false,
      skipped: true,
      reason: "db_missing",
      dbPath,
      sentinelPath,
    };
  }

  const existing = normalizeSentinel(safeReadJson(sentinelPath, fsRef));
  if (
    options.allowShrink !== true &&
    existing?.sizeBytes >= MEANINGFUL_DB_SIZE_BYTES &&
    (stat.size < CRITICAL_DB_SIZE_BYTES ||
      stat.size < existing.sizeBytes * WARNING_SHRINK_RATIO)
  ) {
    // An explicit "continue" choice must not erase the last known-good
    // baseline when Open WebUI subsequently creates a tiny replacement DB.
    return {
      success: false,
      skipped: true,
      reason: "preserved_meaningful_sentinel",
      dbPath,
      sentinelPath,
      sizeBytes: stat.size,
      previousSizeBytes: existing.sizeBytes,
    };
  }

  const now = typeof options.now === "function" ? options.now() : new Date();
  const recordedAt =
    now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const payload = {
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
    recordedAt,
    buildNumber: options.buildNumber ?? null,
  };

  try {
    atomicWriteJson(sentinelPath, payload, fsRef);
    return {
      success: true,
      skipped: false,
      dbPath,
      sentinelPath,
      sentinel: payload,
    };
  } catch (error) {
    return {
      success: false,
      skipped: false,
      reason: "sentinel_write_failed",
      error: error.message,
      dbPath,
      sentinelPath,
    };
  }
}

function makeCheckResult(overrides = {}) {
  const blocked = overrides.blocked === true;
  return {
    ok: !blocked,
    blocked,
    tripped: blocked,
    level: blocked ? "critical" : "ok",
    ...overrides,
  };
}

function checkDbSentinel(options = {}) {
  const fsRef = options.fsRef || fs;
  const dbPath = getDbPath(options);
  const sentinelPath = getSentinelPath(options);
  const sentinel = normalizeSentinel(safeReadJson(sentinelPath, fsRef));

  if (!sentinel) {
    return makeCheckResult({
      blocked: false,
      reason: "sentinel_absent",
      dbPath,
      sentinelPath,
      sentinel: null,
    });
  }

  if (sentinel.sizeBytes < MEANINGFUL_DB_SIZE_BYTES) {
    return makeCheckResult({
      blocked: false,
      reason: "sentinel_not_meaningful",
      dbPath,
      sentinelPath,
      sentinel,
    });
  }

  const currentStat = statRegularFile(dbPath, fsRef);
  if (!currentStat) {
    return makeCheckResult({
      blocked: true,
      level: "critical",
      reason: "db_missing",
      message: "Your chat database appears to be missing or damaged",
      dbPath,
      sentinelPath,
      sentinel,
      current: null,
    });
  }

  const current = {
    sizeBytes: currentStat.size,
    mtimeMs: currentStat.mtimeMs,
  };
  if (current.sizeBytes < CRITICAL_DB_SIZE_BYTES) {
    return makeCheckResult({
      blocked: true,
      level: "critical",
      reason: "db_missing_or_nearly_empty",
      message: "Your chat database appears to be missing or damaged",
      dbPath,
      sentinelPath,
      sentinel,
      current,
    });
  }

  const sizeRatio = current.sizeBytes / sentinel.sizeBytes;
  if (sizeRatio < WARNING_SHRINK_RATIO) {
    return makeCheckResult({
      blocked: true,
      level: "warning",
      reason: "db_size_dropped_below_five_percent",
      message: "Your chat database appears to be missing or damaged",
      dbPath,
      sentinelPath,
      sentinel,
      current: { ...current, sizeRatio },
    });
  }

  return makeCheckResult({
    blocked: false,
    reason: "db_size_ok",
    dbPath,
    sentinelPath,
    sentinel,
    current: { ...current, sizeRatio },
  });
}

function resolveSqliteBinary({
  fsRef = fs,
  execFileSyncRef = execFileSync,
  sqliteBinaryPath = null,
} = {}) {
  if (isNonEmptyString(sqliteBinaryPath)) return sqliteBinaryPath.trim();

  for (const candidate of SQLITE_CANDIDATES) {
    try {
      if (fsRef.existsSync(candidate)) return candidate;
    } catch {
      // Keep looking.
    }
  }

  try {
    const fromPath = String(
      execFileSyncRef("sh", ["-lc", "command -v sqlite3 || true"], {
        encoding: "utf8",
        timeout: 1000,
        maxBuffer: 64 * 1024,
      }) || "",
    ).trim();
    return fromPath || null;
  } catch {
    return null;
  }
}

function resolveUnzipBinary(fsRef = fs) {
  for (const candidate of UNZIP_CANDIDATES) {
    try {
      if (fsRef.existsSync(candidate)) return candidate;
    } catch {
      // Keep looking.
    }
  }
  return "unzip";
}

function stopOpenWebuiContainer(options = {}) {
  if (options.manageContainer === false) {
    return { managed: false, wasRunning: false, containerName: null };
  }

  const execFileSyncRef = options.execFileSyncRef || execFileSync;
  const dockerBinary = options.dockerBinaryPath || "docker";
  let names;
  try {
    names = String(
      execFileSyncRef(dockerBinary, ["ps", "--format", "{{.Names}}"], {
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 256 * 1024,
      }) || "",
    )
      .split(/\r?\n/)
      .map((name) => name.trim())
      .filter(Boolean);
  } catch {
    // Docker is optional in host mode, and may not be running yet during the
    // launch guard. A failed listing means there is no reachable data plane to
    // stop; it is not a reason to make an otherwise valid offline restore fail.
    return {
      managed: true,
      wasRunning: false,
      containerName: null,
      dockerUnavailable: true,
    };
  }

  const containerName =
    OPEN_WEBUI_CONTAINER_CANDIDATES.find((candidate) => names.includes(candidate)) ||
    names.find((name) => name.includes("open-webui")) ||
    null;
  if (!containerName) {
    return { managed: true, wasRunning: false, containerName: null };
  }

  execFileSyncRef(dockerBinary, ["stop", "-t", "30", containerName], {
    encoding: "utf8",
    timeout: 35_000,
    maxBuffer: 256 * 1024,
  });
  return { managed: true, wasRunning: true, containerName, dockerBinary };
}

function restartOpenWebuiContainer(containerState, options = {}) {
  if (!containerState?.wasRunning || !containerState.containerName) return;
  const execFileSyncRef = options.execFileSyncRef || execFileSync;
  execFileSyncRef(
    containerState.dockerBinary || options.dockerBinaryPath || "docker",
    ["start", containerState.containerName],
    {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 256 * 1024,
    },
  );
}

function toCandidate(sourceType, candidatePath, stat, extra = {}) {
  const memberSuffix = extra.memberPath ? `#${extra.memberPath}` : "";
  return {
    id: `${sourceType}:${candidatePath}${memberSuffix}`,
    sourceType,
    path: candidatePath,
    sizeBytes: Number.isFinite(extra.sizeBytes) ? extra.sizeBytes : stat.size,
    mtimeMs: stat.mtimeMs,
    ...extra,
  };
}

function collectRepairBackupCandidates(rootPath, fsRef = fs) {
  const candidates = [];

  function visit(dirPath, depth) {
    if (depth > 2) return;
    let entries;
    try {
      entries = fsRef.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.startsWith("webui.db.backup.")) {
        continue;
      }
      const stat = statRegularFile(entryPath, fsRef);
      if (stat) candidates.push(toCandidate("repair-backup", entryPath, stat));
    }
  }

  visit(rootPath, 0);
  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function collectDbSnapshotCandidates(rootPath, fsRef = fs) {
  let entries;
  try {
    entries = fsRef.readdirSync(rootPath, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter(
      (entry) => entry.isFile() && /^webui\.db\..+/.test(entry.name),
    )
    .map((entry) => {
      const entryPath = path.join(rootPath, entry.name);
      const stat = statRegularFile(entryPath, fsRef);
      return stat ? toCandidate("db-snapshot", entryPath, stat) : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function findZipDbMember(archivePath, options = {}) {
  const fsRef = options.fsRef || fs;
  const execFileSyncRef = options.execFileSyncRef || execFileSync;
  const unzipBinary = options.unzipBinaryPath || resolveUnzipBinary(fsRef);

  try {
    const listing = String(
      execFileSyncRef(unzipBinary, ["-Z1", archivePath], {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
      }) || "",
    );
    const memberPath = listing
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /(^|\/)open-webui-data\/webui\.db$/.test(line));
    if (!memberPath) return null;

    let sizeBytes = null;
    try {
      const detail = String(
        execFileSyncRef(unzipBinary, ["-l", archivePath, memberPath], {
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 256 * 1024,
        }) || "",
      );
      for (const line of detail.split(/\r?\n/)) {
        const match = line.match(/^\s*(\d+)\s+\S+\s+\S+\s+(.+)$/);
        if (match && match[2].trim() === memberPath) {
          sizeBytes = Number.parseInt(match[1], 10);
          break;
        }
      }
    } catch {
      // Archive size is used as a display fallback below.
    }

    return { memberPath, sizeBytes, unzipBinary };
  } catch {
    return null;
  }
}

function collectFullBackupCandidate(rootPath, options = {}) {
  const fsRef = options.fsRef || fs;
  let entries;
  try {
    entries = fsRef.readdirSync(rootPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const archives = entries
    .filter((entry) => entry.isFile() && FULL_BACKUP_PATTERN.test(entry.name))
    .map((entry) => {
      const archivePath = path.join(rootPath, entry.name);
      const stat = statRegularFile(archivePath, fsRef);
      return stat ? { archivePath, stat } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  for (const archive of archives) {
    const member = findZipDbMember(archive.archivePath, options);
    if (!member) continue;
    return [
      toCandidate("full-backup-zip", archive.archivePath, archive.stat, {
        archivePath: archive.archivePath,
        memberPath: member.memberPath,
        sizeBytes: Number.isFinite(member.sizeBytes)
          ? member.sizeBytes
          : archive.stat.size,
        unzipBinary: member.unzipBinary,
      }),
    ];
  }
  return [];
}

function findRestoreCandidates(options = {}) {
  const fsRef = options.fsRef || fs;
  const projectRoot = getProjectRoot(options);
  const repairRoot = path.join(
    projectRoot,
    DEFAULT_REPAIR_BACKUP_RELATIVE_PATH,
  );
  const snapshotRoot = path.join(
    projectRoot,
    DEFAULT_DB_SNAPSHOT_RELATIVE_PATH,
  );
  const fullBackupRoot = path.join(
    projectRoot,
    DEFAULT_FULL_BACKUP_RELATIVE_PATH,
  );

  return [
    ...collectRepairBackupCandidates(repairRoot, fsRef),
    ...collectDbSnapshotCandidates(snapshotRoot, fsRef),
    ...collectFullBackupCandidate(fullBackupRoot, {
      ...options,
      fsRef,
    }),
  ];
}

function checkSqliteIntegrity(dbPath, options = {}) {
  const execFileSyncRef = options.execFileSyncRef || execFileSync;
  const sqliteBinary = resolveSqliteBinary(options);
  if (!sqliteBinary) {
    return {
      ok: false,
      error: "sqlite3 is unavailable; the backup cannot be validated safely",
      sqliteBinary: null,
      output: [],
    };
  }

  try {
    const output = String(
      execFileSyncRef(
        sqliteBinary,
        ["-batch", "-noheader", dbPath, "PRAGMA quick_check;"],
        {
          encoding: "utf8",
          timeout: 120_000,
          maxBuffer: 2 * 1024 * 1024,
        },
      ) || "",
    )
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return {
      ok: output.length > 0 && output.every((line) => line.toLowerCase() === "ok"),
      sqliteBinary,
      output,
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      sqliteBinary,
      output: [],
    };
  }
}

function extractCandidateToPath(candidate, destinationPath, options = {}) {
  const fsRef = options.fsRef || fs;
  if (candidate.sourceType !== "full-backup-zip") {
    fsRef.copyFileSync(candidate.path, destinationPath);
    return;
  }

  const spawnSyncRef = options.spawnSyncRef || spawnSync;
  const unzipBinary =
    candidate.unzipBinary || options.unzipBinaryPath || resolveUnzipBinary(fsRef);
  let outputFd = null;
  try {
    outputFd = fsRef.openSync(destinationPath, "w", 0o600);
    const result = spawnSyncRef(
      unzipBinary,
      ["-p", candidate.archivePath, candidate.memberPath],
      {
        stdio: ["ignore", outputFd, "pipe"],
        timeout: 10 * 60_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const stderr = String(result.stderr || "").trim();
      throw new Error(
        `unzip exited ${result.status}${stderr ? `: ${stderr}` : ""}`,
      );
    }
  } finally {
    if (outputFd !== null) fsRef.closeSync(outputFd);
  }
}

function fsyncFile(filePath, fsRef = fs) {
  let fd = null;
  try {
    fd = fsRef.openSync(filePath, "r");
    fsRef.fsyncSync(fd);
  } finally {
    if (fd !== null) fsRef.closeSync(fd);
  }
}

function getTimestampSlug(nowValue) {
  const date = nowValue instanceof Date ? nowValue : new Date(nowValue);
  return date.toISOString().replace(/[:.]/g, "-");
}

function restoreOpenWebuiDbFromBackup(options = {}) {
  const fsRef = options.fsRef || fs;
  const projectRoot = getProjectRoot(options);
  const dbPath = getDbPath({ ...options, projectRoot });
  const candidates = findRestoreCandidates({ ...options, projectRoot, fsRef });
  const requestedId = options.candidateId || options.candidate?.id || null;
  const requestedPath = options.backupPath
    ? path.resolve(options.backupPath)
    : null;
  const candidate = requestedId
    ? candidates.find((item) => item.id === requestedId)
    : requestedPath
      ? candidates.find(
          (item) =>
            path.resolve(item.path) === requestedPath ||
            path.resolve(item.archivePath || item.path) === requestedPath,
        )
      : candidates[0];

  if (!candidate) {
    return {
      success: false,
      error: requestedId || requestedPath
        ? "The selected Open WebUI database backup is no longer available"
        : "No Open WebUI database backup was found",
      candidates,
    };
  }

  const dbDir = path.dirname(dbPath);
  fsRef.mkdirSync(dbDir, { recursive: true });
  const tempDir = fsRef.mkdtempSync(path.join(dbDir, ".owui-db-restore-"));
  const stagedDbPath = path.join(tempDir, "webui.db");
  const nowValue = typeof options.now === "function" ? options.now() : new Date();
  const timestamp = getTimestampSlug(nowValue);
  let currentDbBackupPath = null;
  let containerState = null;
  let restoreCommitted = false;
  let rollbackSafe = true;
  const quarantinedSidecars = [];
  const notes = [];

  try {
    extractCandidateToPath(candidate, stagedDbPath, { ...options, fsRef });
    const stagedStat = statRegularFile(stagedDbPath, fsRef);
    if (!stagedStat || stagedStat.size < CRITICAL_DB_SIZE_BYTES) {
      throw new Error("The selected database backup is empty or incomplete");
    }

    const integrity = checkSqliteIntegrity(stagedDbPath, {
      ...options,
      fsRef,
    });
    if (!integrity.ok) {
      const detail = integrity.error || integrity.output.join("; ") || "unknown error";
      throw new Error(`The selected database backup failed quick_check: ${detail}`);
    }

    containerState = stopOpenWebuiContainer(options);
    if (containerState.wasRunning) {
      notes.push(
        `Stopped container ${containerState.containerName} before database restore`,
      );
    }

    fsRef.chmodSync(stagedDbPath, 0o600);
    fsyncFile(stagedDbPath, fsRef);

    const currentStat = statRegularFile(dbPath, fsRef);
    const existingSidecars = [`${dbPath}-wal`, `${dbPath}-shm`].filter(
      (sidecarPath) => Boolean(statRegularFile(sidecarPath, fsRef)),
    );
    let restoreBackupDir = null;
    if (currentStat || existingSidecars.length > 0) {
      restoreBackupDir = path.join(
        projectRoot,
        DEFAULT_REPAIR_BACKUP_RELATIVE_PATH,
        timestamp,
      );
      fsRef.mkdirSync(restoreBackupDir, { recursive: true });
    }
    if (currentStat) {
      currentDbBackupPath = path.join(
        restoreBackupDir,
        `webui.db.pre-restore.${timestamp}`,
      );
      fsRef.copyFileSync(dbPath, currentDbBackupPath);
    }

    // Quarantine sidecars before replacing the database. A stale WAL can
    // replay pages from the damaged database over the restored file, so an
    // inability to move either sidecar is a fail-closed pre-commit error.
    for (const sidecarPath of existingSidecars) {
      const quarantinePath = path.join(
        restoreBackupDir,
        `${path.basename(sidecarPath)}.pre-restore.${timestamp}`,
      );
      fsRef.renameSync(sidecarPath, quarantinePath);
      quarantinedSidecars.push({ originalPath: sidecarPath, quarantinePath });
    }

    fsRef.renameSync(stagedDbPath, dbPath);
    restoreCommitted = true;

    // The rename above is the restore commit point. Sentinel/staging cleanup
    // after it is best effort, but sidecar safety was already guaranteed.
    let sentinelResult;
    try {
      sentinelResult = recordDbSentinel({
        ...options,
        fsRef,
        projectRoot,
        dbPath,
        now: () => nowValue,
        allowShrink: true,
      });
    } catch (error) {
      sentinelResult = {
        success: false,
        reason: "sentinel_write_failed",
        error: error.message,
      };
    }
    if (!sentinelResult.success) {
      notes.push(
        `Restored database, but could not record its integrity sentinel: ${sentinelResult.error || sentinelResult.reason || "unknown error"}`,
      );
    }

    return {
      success: true,
      dbPath,
      candidate,
      currentDbBackupPath,
      quarantinedSidecarPaths: quarantinedSidecars.map(
        (entry) => entry.quarantinePath,
      ),
      integrity,
      sentinel: sentinelResult,
      notes,
    };
  } catch (error) {
    if (!restoreCommitted) {
      for (const sidecar of [...quarantinedSidecars].reverse()) {
        try {
          fsRef.renameSync(sidecar.quarantinePath, sidecar.originalPath);
        } catch (rollbackError) {
          rollbackSafe = false;
          notes.push(
            `Could not roll back quarantined ${path.basename(sidecar.originalPath)}: ${rollbackError.message}`,
          );
        }
      }
    }
    return {
      success: false,
      error: error.message,
      dbPath,
      candidate,
      currentDbBackupPath,
      quarantinedSidecarPaths: quarantinedSidecars.map(
        (entry) => entry.quarantinePath,
      ),
      notes,
    };
  } finally {
    try {
      fsRef.rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      notes.push(`Could not remove restore staging directory: ${error.message}`);
    }
    if (
      options.restartContainerAfterRestore !== false &&
      containerState?.wasRunning &&
      (restoreCommitted || rollbackSafe)
    ) {
      try {
        restartOpenWebuiContainer(containerState, options);
        notes.push(
          `Restarted container ${containerState.containerName} after database restore`,
        );
      } catch (error) {
        notes.push(
          `Failed to restart container ${containerState.containerName}: ${error.message}`,
        );
      }
    } else if (containerState?.wasRunning && !restoreCommitted && !rollbackSafe) {
      notes.push(
        `Did not restart container ${containerState.containerName} because sidecar rollback was incomplete`,
      );
    }
  }
}

module.exports = {
  CRITICAL_DB_SIZE_BYTES,
  DEFAULT_DB_RELATIVE_PATH,
  DEFAULT_SENTINEL_RELATIVE_PATH,
  MEANINGFUL_DB_SIZE_BYTES,
  OPEN_WEBUI_CONTAINER_CANDIDATES,
  WARNING_SHRINK_RATIO,
  checkDbSentinel,
  checkSqliteIntegrity,
  findRestoreCandidates,
  getRestoreCandidates: findRestoreCandidates,
  recordDbSentinel,
  resolveSqliteBinary,
  restoreOpenWebuiDbFromBackup,
  stopOpenWebuiContainer,
};
