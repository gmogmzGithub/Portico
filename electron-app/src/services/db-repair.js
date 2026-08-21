// db-repair.js - Open WebUI SQLite corruption detection and guided repair helpers

const { BrowserWindow } = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const bootstrap = require("./bootstrap");
const state = require("./shared-state");
const { recordDbSentinel } = require("./owui-data-integrity-guard");

const DB_CORRUPTION_EVENT = "db-corruption-detected";
const OPEN_WEBUI_CONTAINER_CANDIDATES = ["portico-open-webui", "open-webui"];
const DEFAULT_DB_RELATIVE_PATH = path.join("open-webui-data", "webui.db");
const DEFAULT_REPAIR_BACKUP_DIR = path.join("open-webui-data", "repair-backups");
const DEFAULT_STATE_FILE = path.join(
  "health-status",
  "db_corruption_state.json",
);
const DEFAULT_LOG_LINES = 400;
const DETECTION_COOLDOWN_MS = Math.max(
  15_000,
  Number.parseInt(
    process.env.OWUI_DB_CORRUPTION_ALERT_COOLDOWN_MS || "300000",
    10,
  ) || 300000,
);
const MIN_SCAN_INTERVAL_MS = Math.max(
  5_000,
  Number.parseInt(
    process.env.OWUI_DB_CORRUPTION_SCAN_INTERVAL_MS || "60000",
    10,
  ) || 60000,
);

const CORRUPTION_PATTERNS = [
  /database disk image is malformed/i,
  /sqlite3\.databaseerror:\s*database disk image is malformed/i,
  /sqlalchemy\.exc\.databaseerror:\s*\(sqlite3\.databaseerror\)\s*database disk image is malformed/i,
  /database corruption detected/i,
  // PORTICO-201: persistent stale-handle / WAL disk I/O failures poison the
  // backend's SQLAlchemy pool while the container stays "running". Patterns
  // are deliberately qualified (never bare "disk I/O error") to avoid false
  // positives from prose in chat/tool content echoed into logs.
  /sqlite3\.operationalerror:\s*disk i\/o error/i,
  /\(sqlite3\.operationalerror\)\s*disk i\/o error/i,
];

const MATCH_PREVIEW_MAX_LENGTH = 200;

// SQLAlchemy renders failing statements and bound parameters after the error
// message ("... disk I/O error [SQL: SELECT ...] [parameters: (...)]").
// Strip that tail so user data never reaches the repair modal preview or the
// persisted detection state.
function redactMatchLine(line) {
  const sqlIndex = line.indexOf("[SQL");
  const truncated = sqlIndex >= 0 ? line.slice(0, sqlIndex).trimEnd() : line;
  return truncated.length > MATCH_PREVIEW_MAX_LENGTH
    ? `${truncated.slice(0, MATCH_PREVIEW_MAX_LENGTH)}…`
    : truncated;
}

let lastScanResult = null;
let scanInFlight = null;
let repairInFlight = null;
let sqliteBinaryPath = null;

const SQLITE_FALLBACK_CANDIDATES = [
  "/opt/homebrew/opt/sqlite/bin/sqlite3",
  "/usr/local/opt/sqlite/bin/sqlite3",
];

function getProjectRoot() {
  return bootstrap.PROJECT_ROOT || process.cwd();
}

function getStateFilePath() {
  return path.join(getProjectRoot(), DEFAULT_STATE_FILE);
}

function getDefaultDbPath() {
  return path.join(getProjectRoot(), DEFAULT_DB_RELATIVE_PATH);
}

function getBackupRootPath() {
  return path.join(getProjectRoot(), DEFAULT_REPAIR_BACKUP_DIR);
}

function recordSuccessfulRepairSentinel(dbPath, notes) {
  const result = recordDbSentinel({
    projectRoot: getProjectRoot(),
    dbPath,
    buildNumber: state.buildInfo?.buildNumber || null,
    allowShrink: true,
  });
  if (!result.success) {
    notes.push(
      `Database repair succeeded, but the integrity sentinel was not recorded (${result.error || result.reason || "unknown error"})`,
    );
  }
  return result;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function safeReadJson(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function updateStoredState(patch) {
  const filePath = getStateFilePath();
  const current = safeReadJson(filePath, {});
  const merged = { ...current, ...patch };
  writeJson(filePath, merged);
  return merged;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function nowIso() {
  return new Date().toISOString();
}

function getTimestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function getPreferredWindow() {
  const windows = [state.windows.main, state.windows.loading];
  for (const candidate of windows) {
    if (candidate && !candidate.isDestroyed()) {
      return candidate;
    }
  }
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) || null;
}

function buildCorruptionSummary(logText) {
  const lines = String(logText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const matches = [];
  for (const line of lines) {
    for (const pattern of CORRUPTION_PATTERNS) {
      if (pattern.test(line)) {
        matches.push(redactMatchLine(line));
        break;
      }
    }
  }

  const detected = matches.length > 0;
  const signatureSource = detected ? matches.slice(0, 20).join("\n") : "";
  const signature = detected
    ? crypto.createHash("sha256").update(signatureSource).digest("hex").slice(0, 16)
    : null;

  return {
    detected,
    signature,
    matches: Array.from(new Set(matches)).slice(0, 20),
  };
}

async function resolveOpenWebuiContainerName() {
  try {
    const { stdout } = await bootstrap.execPromise(
      'docker ps -a --format "{{.Names}}"',
      { cwd: getProjectRoot() },
    );
    const names = String(stdout || "")
      .split(/\r?\n/)
      .map((name) => name.trim())
      .filter(Boolean);

    for (const candidate of OPEN_WEBUI_CONTAINER_CANDIDATES) {
      if (names.includes(candidate)) return candidate;
    }

    const fallback = names.find((name) => name.includes("open-webui"));
    return fallback || OPEN_WEBUI_CONTAINER_CANDIDATES[0];
  } catch {
    return OPEN_WEBUI_CONTAINER_CANDIDATES[0];
  }
}

async function getOpenWebuiLogs(lines = DEFAULT_LOG_LINES) {
  const containerName = await resolveOpenWebuiContainerName();
  const safeLines = Math.max(50, Math.min(2000, Number(lines) || DEFAULT_LOG_LINES));

  try {
    const { stdout, stderr } = await bootstrap.execPromise(
      `docker logs ${shellQuote(containerName)} --tail ${safeLines}`,
      { cwd: getProjectRoot() },
    );
    return {
      success: true,
      containerName,
      logs: `${stdout || ""}${stderr || ""}`,
    };
  } catch (error) {
    return {
      success: false,
      containerName,
      error: error.message,
      logs: `${error.stdout || ""}${error.stderr || ""}`,
    };
  }
}

async function isContainerRunning(containerName) {
  try {
    const { stdout } = await bootstrap.execPromise(
      `docker inspect --format "{{.State.Running}}" ${shellQuote(containerName)}`,
      { cwd: getProjectRoot() },
    );
    return String(stdout || "").trim() === "true";
  } catch {
    return false;
  }
}

async function stopContainer(containerName) {
  await bootstrap.execPromise(`docker stop ${shellQuote(containerName)}`, {
    cwd: getProjectRoot(),
  });
}

async function startContainer(containerName) {
  await bootstrap.execPromise(`docker start ${shellQuote(containerName)}`, {
    cwd: getProjectRoot(),
  });
}

function dbPathParts(dbPath) {
  const resolved = path.resolve(dbPath);
  return {
    dbPath: resolved,
    dbDir: path.dirname(resolved),
    walPath: `${resolved}-wal`,
    shmPath: `${resolved}-shm`,
  };
}

async function ensureSqliteCli() {
  if (sqliteBinaryPath && fs.existsSync(sqliteBinaryPath)) {
    return { binaryPath: sqliteBinaryPath, installedNow: false };
  }

  try {
    const { stdout } = await bootstrap.execPromise("command -v sqlite3", {
      cwd: getProjectRoot(),
    });
    const fromPath = String(stdout || "").trim();
    if (fromPath) {
      sqliteBinaryPath = fromPath;
      return { binaryPath: sqliteBinaryPath, installedNow: false };
    }
  } catch {
    // Continue to Homebrew fallback.
  }

  try {
    await bootstrap.execPromise("command -v brew", {
      cwd: getProjectRoot(),
    });
  } catch {
    throw new Error(
      "sqlite3 is not installed and Homebrew was not found. Please install sqlite3 and retry.",
    );
  }

  try {
    await bootstrap.execPromise("brew install sqlite", {
      cwd: getProjectRoot(),
    });
  } catch (error) {
    throw new Error(
      `sqlite3 is not installed and automatic installation failed (${error.message}). Please run 'brew install sqlite' and retry.`,
    );
  }

  try {
    const { stdout } = await bootstrap.execPromise("command -v sqlite3", {
      cwd: getProjectRoot(),
    });
    const fromPath = String(stdout || "").trim();
    if (fromPath) {
      sqliteBinaryPath = fromPath;
      return { binaryPath: sqliteBinaryPath, installedNow: true };
    }
  } catch {
    // Continue to explicit location lookup.
  }

  try {
    const { stdout } = await bootstrap.execPromise("brew --prefix sqlite", {
      cwd: getProjectRoot(),
    });
    const prefix = String(stdout || "").trim();
    const candidate = prefix ? path.join(prefix, "bin", "sqlite3") : null;
    if (candidate && fs.existsSync(candidate)) {
      sqliteBinaryPath = candidate;
      return { binaryPath: sqliteBinaryPath, installedNow: true };
    }
  } catch {
    // Continue to fallback path probes.
  }

  for (const candidate of SQLITE_FALLBACK_CANDIDATES) {
    if (fs.existsSync(candidate)) {
      sqliteBinaryPath = candidate;
      return { binaryPath: sqliteBinaryPath, installedNow: true };
    }
  }

  throw new Error(
    "sqlite3 installation completed but binary could not be resolved. Please run 'brew link sqlite' or add sqlite3 to PATH and retry.",
  );
}

async function runSqlite(dbPath, sql) {
  const sqliteState = await ensureSqliteCli();
  const command = `${shellQuote(sqliteState.binaryPath)} ${shellQuote(dbPath)} ${shellQuote(sql)}`;
  const { stdout } = await bootstrap.execPromise(command, {
    cwd: getProjectRoot(),
  });
  return String(stdout || "").trim();
}

async function checkIntegrity(dbPath, pragma = "integrity_check") {
  const output = await runSqlite(dbPath, `PRAGMA ${pragma};`);
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const ok = lines.length > 0 && lines.every((line) => line.toLowerCase() === "ok");
  return { ok, output: lines };
}

async function sanitizeInvalidChatRows(dbPath) {
  try {
    const hasChatTable = await runSqlite(
      dbPath,
      "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='chat';",
    );
    if (Number.parseInt(hasChatTable, 10) <= 0) {
      return { fixedRows: 0, skipped: true, reason: "chat_table_missing" };
    }

    const invalidChatCountRaw = await runSqlite(
      dbPath,
      "SELECT COUNT(*) FROM chat WHERE chat IS NULL OR json_valid(chat)=0;",
    );
    const invalidChatCount = Number.parseInt(invalidChatCountRaw, 10) || 0;
    const invalidMetaCountRaw = await runSqlite(
      dbPath,
      "SELECT COUNT(*) FROM chat WHERE meta IS NULL OR meta='' OR json_valid(meta)=0;",
    );
    const invalidMetaCount = Number.parseInt(invalidMetaCountRaw, 10) || 0;
    if (invalidChatCount <= 0 && invalidMetaCount <= 0) {
      return { fixedRows: 0, fixedMetaRows: 0, skipped: false };
    }

    const sql = `
BEGIN TRANSACTION;
CREATE TABLE IF NOT EXISTS _chat_corrupt_backup (
  id TEXT PRIMARY KEY,
  title TEXT,
  raw_chat TEXT,
  captured_at INTEGER
);
CREATE TABLE IF NOT EXISTS _chat_corrupt_meta_backup (
  id TEXT PRIMARY KEY,
  title TEXT,
  raw_meta TEXT,
  captured_at INTEGER
);
INSERT OR REPLACE INTO _chat_corrupt_backup (id, title, raw_chat, captured_at)
SELECT id, title, chat, strftime('%s','now')
FROM chat
WHERE chat IS NULL OR json_valid(chat)=0;
INSERT OR REPLACE INTO _chat_corrupt_meta_backup (id, title, raw_meta, captured_at)
SELECT id, title, meta, strftime('%s','now')
FROM chat
WHERE meta IS NULL OR meta='' OR json_valid(meta)=0;
UPDATE chat
SET chat=json_object(
  'id', id,
  'title', COALESCE(NULLIF(title, ''), 'Recovered Chat'),
  'models', json_array(),
  'params', json_object(),
  'history', json_object('messages', json_object(), 'currentId', NULL),
  'messages', json_array(),
  'tags', json_array(),
  'timestamp', strftime('%s','now'),
  'recovered_from_corruption', 1
)
WHERE chat IS NULL OR json_valid(chat)=0;
UPDATE chat
SET meta='{}'
WHERE meta IS NULL OR meta='' OR json_valid(meta)=0;
COMMIT;
`;

    await runSqlite(dbPath, sql);
    return { fixedRows: invalidChatCount, fixedMetaRows: invalidMetaCount, skipped: false };
  } catch (error) {
    return {
      fixedRows: 0,
      fixedMetaRows: 0,
      skipped: true,
      reason: "sanitize_failed",
      error: error.message,
    };
  }
}

function shouldBroadcastDetection(signature, forceBroadcast) {
  if (forceBroadcast) return true;
  if (!signature) return false;

  const stateData = safeReadJson(getStateFilePath(), {});
  const lastAlert = stateData.lastAlert || {};
  const nowMs = Date.now();

  if (lastAlert.signature !== signature) return true;
  if (!lastAlert.alertedAtMs) return true;

  return nowMs - lastAlert.alertedAtMs >= DETECTION_COOLDOWN_MS;
}

function emitCorruptionDetected(payload) {
  const targetWindow = getPreferredWindow();
  if (!targetWindow) return;
  targetWindow.webContents.send(DB_CORRUPTION_EVENT, payload);
}

async function scanOpenWebuiDbCorruption(options = {}) {
  const reason = options.reason || "manual";
  const forceScan = options.forceScan === true;
  const forceBroadcast = options.forceBroadcast === true;
  const lines = options.lines || DEFAULT_LOG_LINES;
  const nowMs = Date.now();

  if (!forceScan && scanInFlight) {
    return scanInFlight;
  }

  if (
    !forceScan &&
    lastScanResult &&
    nowMs - lastScanResult.scannedAtMs < MIN_SCAN_INTERVAL_MS
  ) {
    return lastScanResult;
  }

  scanInFlight = (async () => {
    const logResult = await getOpenWebuiLogs(lines);
    const summary = buildCorruptionSummary(logResult.logs);
    const scannedAt = nowIso();

    const result = {
      success: logResult.success,
      detected: summary.detected,
      signature: summary.signature,
      matches: summary.matches,
      reason,
      scannedAt,
      scannedAtMs: nowMs,
      containerName: logResult.containerName,
      error: logResult.error || null,
    };

    const statePatch = {
      lastScanAt: scannedAt,
      lastScanReason: reason,
      lastScanDetected: summary.detected,
    };

    if (summary.detected) {
      statePatch.lastDetection = {
        signature: summary.signature,
        matches: summary.matches,
        detectedAt: scannedAt,
        reason,
      };

      if (shouldBroadcastDetection(summary.signature, forceBroadcast)) {
        emitCorruptionDetected({
          detected: true,
          signature: summary.signature,
          matches: summary.matches,
          reason,
          detectedAt: scannedAt,
          message:
            "Open WebUI database appears corrupted. A backup-first repair can be run from the app.",
        });
        statePatch.lastAlert = {
          signature: summary.signature,
          alertedAt: scannedAt,
          alertedAtMs: nowMs,
        };
      }
    }

    updateStoredState(statePatch);
    lastScanResult = result;
    return result;
  })();

  try {
    return await scanInFlight;
  } finally {
    scanInFlight = null;
  }
}

async function repairOpenWebuiDb(options = {}) {
  if (repairInFlight) {
    return repairInFlight;
  }

  repairInFlight = (async () => {
    const startedAt = nowIso();
    const dbPath = path.resolve(options.dbPath || getDefaultDbPath());
    const manageContainer = options.manageContainer !== false;
    const restartContainerAfterRepair =
      options.restartContainerAfterRepair !== false;
    const parts = dbPathParts(dbPath);
    const timestamp = getTimestampSlug();
    const backupRoot = getBackupRootPath();
    const backupDir = path.join(backupRoot, timestamp);
    const backup = {};
    const notes = [];
    let sqliteState = { binaryPath: null, installedNow: false };

    if (!fs.existsSync(parts.dbPath)) {
      return {
        success: false,
        error: `Open WebUI database not found at ${parts.dbPath}`,
      };
    }

    sqliteState = await ensureSqliteCli();
    if (sqliteState.installedNow) {
      notes.push(
        `sqlite3 was missing and was installed automatically via Homebrew (${sqliteState.binaryPath})`,
      );
    }

    const sqliteExecPath = shellQuote(sqliteState.binaryPath);

    let containerName = null;
    let wasRunning = false;
    if (manageContainer) {
      containerName = await resolveOpenWebuiContainerName();
      wasRunning = await isContainerRunning(containerName);
      if (wasRunning) {
        await stopContainer(containerName);
        notes.push(`Stopped container ${containerName} before repair`);
      }
    }

    try {
      ensureDir(backupDir);

      backup.db = path.join(backupDir, `webui.db.backup.${timestamp}`);
      fs.copyFileSync(parts.dbPath, backup.db);

      if (fs.existsSync(parts.walPath)) {
        backup.wal = path.join(backupDir, `webui.db-wal.backup.${timestamp}`);
        fs.copyFileSync(parts.walPath, backup.wal);
      }
      if (fs.existsSync(parts.shmPath)) {
        backup.shm = path.join(backupDir, `webui.db-shm.backup.${timestamp}`);
        fs.copyFileSync(parts.shmPath, backup.shm);
      }

      const preIntegrity = await checkIntegrity(parts.dbPath, "quick_check").catch(
        (error) => ({
          ok: false,
          output: [error.message],
        }),
      );

      // PORTICO-201: when the on-disk database passes quick_check the failure was
      // a stale handle / poisoned pool inside the container, not corruption.
      // Skip the .recover rewrite entirely: the stop → backup → restart cycle
      // already performed by this flow is the correct (and sufficient) cure,
      // and rewriting a healthy database would only add risk.
      const forceRewrite = options.forceRewrite === true;
      if (preIntegrity.ok && !forceRewrite) {
        notes.push(
          "quick_check passed; skipped database rewrite (restart-only repair)",
        );
        recordSuccessfulRepairSentinel(parts.dbPath, notes);
        const completedAt = nowIso();
        const result = {
          success: true,
          startedAt,
          completedAt,
          dbPath: parts.dbPath,
          backup,
          repairMode: "integrity-ok-restart-only",
          preIntegrity,
          postIntegrity: preIntegrity,
          sanitized: { fixedRows: 0, fixedMetaRows: 0, skipped: true, reason: "integrity_ok" },
          sqliteBinaryPath: sqliteState.binaryPath,
          sqliteAutoInstalled: sqliteState.installedNow,
          notes,
        };

        updateStoredState({
          lastRepair: {
            ...result,
            containerName,
            manageContainer,
            restartContainerAfterRepair,
          },
        });

        return result;
      }

      const recoverSqlPath = path.join(backupDir, `recover.${timestamp}.sql`);
      const recoveredDbPath = path.join(parts.dbDir, `webui.recovered.${timestamp}.db`);
      const importSource = {
        mode: "recover",
      };

      if (fs.existsSync(recoveredDbPath)) {
        fs.unlinkSync(recoveredDbPath);
      }

      try {
        await bootstrap.execPromise(
          `${sqliteExecPath} ${shellQuote(parts.dbPath)} ".recover" > ${shellQuote(recoverSqlPath)}`,
          { cwd: getProjectRoot() },
        );
      } catch (recoverError) {
        importSource.mode = "dump";
        importSource.recoverError = recoverError.message;
        await bootstrap.execPromise(
          `${sqliteExecPath} ${shellQuote(parts.dbPath)} ".dump" > ${shellQuote(recoverSqlPath)}`,
          { cwd: getProjectRoot() },
        );
      }

      await bootstrap.execPromise(
        `${sqliteExecPath} ${shellQuote(recoveredDbPath)} < ${shellQuote(recoverSqlPath)}`,
        { cwd: getProjectRoot() },
      );

      const sanitizeResult = await sanitizeInvalidChatRows(recoveredDbPath);
      const postIntegrity = await checkIntegrity(recoveredDbPath);

      if (!postIntegrity.ok) {
        throw new Error(
          `Recovered database failed integrity check: ${postIntegrity.output.join("; ")}`,
        );
      }

      const replacedOriginalPath = path.join(
        backupDir,
        `webui.db.pre-repair-live.${timestamp}`,
      );
      fs.renameSync(parts.dbPath, replacedOriginalPath);
      fs.renameSync(recoveredDbPath, parts.dbPath);
      backup.preSwapLiveDb = replacedOriginalPath;

      if (fs.existsSync(parts.walPath)) {
        fs.rmSync(parts.walPath, { force: true });
      }
      if (fs.existsSync(parts.shmPath)) {
        fs.rmSync(parts.shmPath, { force: true });
      }

      recordSuccessfulRepairSentinel(parts.dbPath, notes);

      const completedAt = nowIso();
      const result = {
        success: true,
        startedAt,
        completedAt,
        dbPath: parts.dbPath,
        backup,
        repairMode: importSource.mode,
        preIntegrity,
        postIntegrity,
        sanitized: sanitizeResult,
        sqliteBinaryPath: sqliteState.binaryPath,
        sqliteAutoInstalled: sqliteState.installedNow,
        notes,
      };

      updateStoredState({
        lastRepair: {
          ...result,
          containerName,
          manageContainer,
          restartContainerAfterRepair,
        },
      });

      return result;
    } catch (error) {
      return {
        success: false,
        error: error.message,
        backup,
        notes,
      };
    } finally {
      if (
        manageContainer &&
        restartContainerAfterRepair &&
        wasRunning &&
        containerName
      ) {
        try {
          await startContainer(containerName);
          notes.push(`Restarted container ${containerName} after repair`);
        } catch (restartError) {
          notes.push(
            `Failed to restart container ${containerName}: ${restartError.message}`,
          );
        }
      }
    }
  })();

  try {
    return await repairInFlight;
  } finally {
    repairInFlight = null;
  }
}

function findLatestBackupDb(stateFileData, dbPath) {
  if (stateFileData?.lastRepair?.backup?.db) {
    return stateFileData.lastRepair.backup.db;
  }

  const backupRoot = getBackupRootPath();
  if (!fs.existsSync(backupRoot)) return null;

  const entries = fs
    .readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(backupRoot, entry.name))
    .sort((a, b) => {
      const aTime = fs.statSync(a).mtimeMs;
      const bTime = fs.statSync(b).mtimeMs;
      return bTime - aTime;
    });

  for (const dir of entries) {
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith("webui.db.backup."));
    if (files.length > 0) {
      return path.join(dir, files[0]);
    }
  }

  const fallback = `${dbPath}.backup`;
  return fs.existsSync(fallback) ? fallback : null;
}

async function rollbackOpenWebuiDbRepair(options = {}) {
  const dbPath = path.resolve(options.dbPath || getDefaultDbPath());
  const manageContainer = options.manageContainer !== false;
  const parts = dbPathParts(dbPath);
  const stateFileData = safeReadJson(getStateFilePath(), {});
  const backupDbPath = path.resolve(
    options.backupDbPath || findLatestBackupDb(stateFileData, parts.dbPath) || "",
  );

  if (!backupDbPath || !fs.existsSync(backupDbPath)) {
    return {
      success: false,
      error:
        "No backup database was found for rollback. Provide backupDbPath explicitly.",
    };
  }

  let containerName = null;
  let wasRunning = false;
  if (manageContainer) {
    containerName = await resolveOpenWebuiContainerName();
    wasRunning = await isContainerRunning(containerName);
  }
  const rollbackTimestamp = getTimestampSlug();
  const rollbackBackupPath = `${parts.dbPath}.rollback-current.${rollbackTimestamp}`;

  if (manageContainer && wasRunning && containerName) {
    await stopContainer(containerName);
  }

  try {
    if (fs.existsSync(parts.dbPath)) {
      fs.copyFileSync(parts.dbPath, rollbackBackupPath);
    }
    fs.copyFileSync(backupDbPath, parts.dbPath);
    if (fs.existsSync(parts.walPath)) {
      fs.rmSync(parts.walPath, { force: true });
    }
    if (fs.existsSync(parts.shmPath)) {
      fs.rmSync(parts.shmPath, { force: true });
    }

    const postIntegrity = await checkIntegrity(parts.dbPath, "quick_check").catch(
      (error) => ({
        ok: false,
        output: [error.message],
      }),
    );

    updateStoredState({
      lastRollback: {
        rolledBackAt: nowIso(),
        dbPath: parts.dbPath,
        sourceBackup: backupDbPath,
        rollbackBackupPath,
        postIntegrity,
      },
    });

    return {
      success: true,
      dbPath: parts.dbPath,
      sourceBackup: backupDbPath,
      rollbackBackupPath,
      postIntegrity,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      sourceBackup: backupDbPath,
      rollbackBackupPath,
    };
  } finally {
    if (manageContainer && wasRunning && containerName) {
      try {
        await startContainer(containerName);
      } catch {
        // No-op: caller receives rollback result; restart failure is visible in logs.
      }
    }
  }
}

module.exports = {
  DB_CORRUPTION_EVENT,
  buildCorruptionSummary,
  scanOpenWebuiDbCorruption,
  repairOpenWebuiDb,
  rollbackOpenWebuiDbRepair,
  sanitizeInvalidChatRows,
};
