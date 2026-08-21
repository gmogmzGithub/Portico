const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");

const {
  MEANINGFUL_DB_SIZE_BYTES,
  checkDbSentinel,
  findRestoreCandidates,
  recordDbSentinel,
  resolveSqliteBinary,
  restoreOpenWebuiDbFromBackup,
  stopOpenWebuiContainer,
} = require("./owui-data-integrity-guard");

// The canonical runner uses --test-force-exit. Keep one real event-loop handle
// for this file so it cannot force-exit between synchronous sqlite/zip tests.
const forcedExitKeepAlive = setInterval(() => {}, 1000);
after(() => clearInterval(forcedExitKeepAlive));

function makeProjectRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owui-integrity-guard-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeSizedFile(filePath, sizeBytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.alloc(sizeBytes, 0x41));
}

function writeSentinel(projectRoot, sizeBytes = MEANINGFUL_DB_SIZE_BYTES) {
  const sentinelPath = path.join(
    projectRoot,
    "health-status",
    "owui-db-sentinel.json",
  );
  fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
  fs.writeFileSync(
    sentinelPath,
    JSON.stringify({
      sizeBytes,
      mtimeMs: 1_700_000_000_000,
      recordedAt: "2026-07-08T12:00:00.000Z",
      buildNumber: "123",
    }),
  );
  return sentinelPath;
}

test("stopOpenWebuiContainer stops an already-running Open WebUI container", () => {
  const calls = [];
  const result = stopOpenWebuiContainer({
    execFileSyncRef(binary, args) {
      calls.push([binary, ...args]);
      if (args[0] === "ps") return "unrelated\nportico-open-webui\n";
      if (args[0] === "stop") return "portico-open-webui\n";
      throw new Error(`Unexpected call: ${binary} ${args.join(" ")}`);
    },
  });

  assert.deepEqual(result, {
    managed: true,
    wasRunning: true,
    containerName: "portico-open-webui",
    dockerBinary: "docker",
  });
  assert.deepEqual(calls, [
    ["docker", "ps", "--format", "{{.Names}}"],
    ["docker", "stop", "-t", "30", "portico-open-webui"],
  ]);
});

function setMtime(filePath, mtimeMs) {
  const date = new Date(mtimeMs);
  fs.utimesSync(filePath, date, date);
}

test("checkDbSentinel treats a missing sentinel as a fresh install", (t) => {
  const projectRoot = makeProjectRoot(t);

  const result = checkDbSentinel({ projectRoot });

  assert.equal(result.ok, true);
  assert.equal(result.blocked, false);
  assert.equal(result.reason, "sentinel_absent");
});

test("checkDbSentinel blocks a missing database after a meaningful baseline", (t) => {
  const projectRoot = makeProjectRoot(t);
  writeSentinel(projectRoot);

  const result = checkDbSentinel({ projectRoot });

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.level, "critical");
  assert.equal(result.reason, "db_missing");
});

test("checkDbSentinel blocks a zero-length database", (t) => {
  const projectRoot = makeProjectRoot(t);
  writeSentinel(projectRoot);
  writeSizedFile(path.join(projectRoot, "open-webui-data", "webui.db"), 0);

  const result = checkDbSentinel({ projectRoot });

  assert.equal(result.blocked, true);
  assert.equal(result.level, "critical");
  assert.equal(result.reason, "db_missing_or_nearly_empty");
});

test("checkDbSentinel allows a small but real database above the shrink threshold", (t) => {
  const projectRoot = makeProjectRoot(t);
  writeSentinel(projectRoot, MEANINGFUL_DB_SIZE_BYTES);
  writeSizedFile(
    path.join(projectRoot, "open-webui-data", "webui.db"),
    32 * 1024,
  );

  const result = checkDbSentinel({ projectRoot });

  assert.equal(result.blocked, false);
  assert.equal(result.reason, "db_size_ok");
});

test("checkDbSentinel raises a warning-level block below five percent", (t) => {
  const projectRoot = makeProjectRoot(t);
  writeSentinel(projectRoot, 1024 * 1024);
  writeSizedFile(
    path.join(projectRoot, "open-webui-data", "webui.db"),
    48 * 1024,
  );

  const result = checkDbSentinel({ projectRoot });

  assert.equal(result.blocked, true);
  assert.equal(result.level, "warning");
  assert.equal(result.reason, "db_size_dropped_below_five_percent");
});

test("recordDbSentinel writes the database size, mtime, time, and build", (t) => {
  const projectRoot = makeProjectRoot(t);
  const dbPath = path.join(projectRoot, "open-webui-data", "webui.db");
  writeSizedFile(dbPath, 640 * 1024);
  setMtime(dbPath, 1_750_000_000_000);

  const result = recordDbSentinel({
    projectRoot,
    buildNumber: "456",
    now: () => new Date("2026-07-10T10:11:12.000Z"),
  });

  assert.equal(result.success, true);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(result.sentinelPath, "utf8")),
    {
      sizeBytes: 640 * 1024,
      mtimeMs: fs.statSync(dbPath).mtimeMs,
      recordedAt: "2026-07-10T10:11:12.000Z",
      buildNumber: "456",
    },
  );
});

test("recordDbSentinel preserves an armed baseline after an explicit empty-db continuation", (t) => {
  const projectRoot = makeProjectRoot(t);
  const sentinelPath = writeSentinel(projectRoot, 2 * 1024 * 1024);
  const originalSentinel = fs.readFileSync(sentinelPath, "utf8");
  writeSizedFile(path.join(projectRoot, "open-webui-data", "webui.db"), 1024);

  const result = recordDbSentinel({ projectRoot, buildNumber: "new" });

  assert.equal(result.success, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "preserved_meaningful_sentinel");
  assert.equal(fs.readFileSync(sentinelPath, "utf8"), originalSentinel);
});

test("restore candidates prefer repair backups, then snapshots, then the newest full backup zip", (t) => {
  const projectRoot = makeProjectRoot(t);
  const repairRoot = path.join(
    projectRoot,
    "open-webui-data",
    "repair-backups",
    "repair-run",
  );
  const snapshotRoot = path.join(projectRoot, "backup", "db-snapshots");
  const fullBackupRoot = path.join(projectRoot, "backup");
  const repairOld = path.join(repairRoot, "webui.db.backup.old");
  const repairNew = path.join(repairRoot, "webui.db.backup.new");
  const snapshotOld = path.join(snapshotRoot, "webui.db.100");
  const snapshotNew = path.join(snapshotRoot, "webui.db.200");
  const unrelatedSnapshotFile = path.join(snapshotRoot, "notes.txt");
  const olderZip = path.join(
    fullBackupRoot,
    "portico_full_backup_100.zip",
  );
  const newerZip = path.join(
    fullBackupRoot,
    "portico_full_backup_200.zip",
  );

  for (const filePath of [
    repairOld,
    repairNew,
    snapshotOld,
    snapshotNew,
    unrelatedSnapshotFile,
    olderZip,
    newerZip,
  ]) {
    writeSizedFile(filePath, 8 * 1024);
  }
  setMtime(repairOld, 1000);
  setMtime(repairNew, 2000);
  setMtime(snapshotOld, 3000);
  setMtime(snapshotNew, 4000);
  setMtime(olderZip, 5000);
  setMtime(newerZip, 6000);

  const execFileSyncRef = (_binary, args) => {
    const archivePath = args[1];
    if (args[0] === "-Z1") {
      if (archivePath === newerZip) {
        return "managed/open-webui-data/webui.db\n";
      }
      return "managed/config.json\n";
    }
    if (args[0] === "-l") {
      return "  123456  2026-07-08 12:34  managed/open-webui-data/webui.db\n";
    }
    throw new Error(`Unexpected unzip invocation: ${args.join(" ")}`);
  };

  const candidates = findRestoreCandidates({
    projectRoot,
    execFileSyncRef,
  });

  assert.deepEqual(
    candidates.map((candidate) => candidate.sourceType),
    [
      "repair-backup",
      "repair-backup",
      "db-snapshot",
      "db-snapshot",
      "full-backup-zip",
    ],
  );
  assert.deepEqual(
    candidates.slice(0, 4).map((candidate) => candidate.path),
    [repairNew, repairOld, snapshotNew, snapshotOld],
  );
  assert.equal(candidates[4].archivePath, newerZip);
  assert.equal(candidates[4].sizeBytes, 123456);
});

test("restoreOpenWebuiDbFromBackup validates and atomically restores the preferred backup", (t) => {
  const sqliteBinary = resolveSqliteBinary();
  if (!sqliteBinary) {
    t.skip("sqlite3 is unavailable");
    return;
  }

  const projectRoot = makeProjectRoot(t);
  const dbPath = path.join(projectRoot, "open-webui-data", "webui.db");
  const backupPath = path.join(
    projectRoot,
    "open-webui-data",
    "repair-backups",
    "known-good",
    "webui.db.backup.known-good",
  );
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  execFileSync(sqliteBinary, [
    backupPath,
    "CREATE TABLE chat (id TEXT PRIMARY KEY, payload BLOB); " +
      "INSERT INTO chat VALUES ('restored-chat', zeroblob(700000));",
  ]);
  writeSizedFile(dbPath, 0);
  writeSizedFile(`${dbPath}-wal`, 1024);
  writeSizedFile(`${dbPath}-shm`, 1024);
  // A validated, explicitly selected restore is allowed to replace a much
  // larger stale baseline; normal initialization/quit recording is not.
  writeSentinel(projectRoot, 100 * 1024 * 1024);
  const dockerCalls = [];
  const execFileSyncRef = (binary, args, options) => {
    if (binary === "docker") {
      dockerCalls.push(args);
      if (args[0] === "ps") return "portico-open-webui\n";
      if (args[0] === "stop") return "portico-open-webui\n";
      throw new Error(`Unexpected Docker call: ${args.join(" ")}`);
    }
    return execFileSync(binary, args, options);
  };
  const result = restoreOpenWebuiDbFromBackup({
    projectRoot,
    sqliteBinaryPath: sqliteBinary,
    execFileSyncRef,
    restartContainerAfterRestore: false,
    buildNumber: "789",
    now: () => new Date("2026-07-10T12:00:00.000Z"),
  });

  assert.equal(result.success, true, result.error);
  assert.equal(result.candidate.path, backupPath);
  assert.equal(result.integrity.ok, true);
  assert.deepEqual(dockerCalls, [
    ["ps", "--format", "{{.Names}}"],
    ["stop", "-t", "30", "portico-open-webui"],
  ]);
  assert.ok(result.currentDbBackupPath);
  assert.equal(fs.statSync(result.currentDbBackupPath).size, 0);
  assert.equal(fs.existsSync(`${dbPath}-wal`), false);
  assert.equal(fs.existsSync(`${dbPath}-shm`), false);
  assert.equal(result.quarantinedSidecarPaths.length, 2);
  assert.equal(
    result.quarantinedSidecarPaths.every((sidecarPath) =>
      fs.existsSync(sidecarPath),
    ),
    true,
  );
  assert.equal(
    execFileSync(sqliteBinary, [
      "-batch",
      "-noheader",
      dbPath,
      "SELECT id FROM chat;",
    ], { encoding: "utf8" }).trim(),
    "restored-chat",
  );
  assert.equal(checkDbSentinel({ projectRoot }).blocked, false);
});

test("restoreOpenWebuiDbFromBackup fails closed and rolls back when a sidecar cannot be quarantined", (t) => {
  const sqliteBinary = resolveSqliteBinary();
  if (!sqliteBinary) {
    t.skip("sqlite3 is unavailable");
    return;
  }

  const projectRoot = makeProjectRoot(t);
  const dbPath = path.join(projectRoot, "open-webui-data", "webui.db");
  const backupPath = path.join(
    projectRoot,
    "open-webui-data",
    "repair-backups",
    "known-good",
    "webui.db.backup.known-good",
  );
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  execFileSync(sqliteBinary, [
    backupPath,
    "CREATE TABLE chat (id TEXT PRIMARY KEY, payload BLOB); " +
      "INSERT INTO chat VALUES ('safe-backup', zeroblob(700000));",
  ]);
  writeSizedFile(dbPath, 8 * 1024);
  writeSizedFile(`${dbPath}-wal`, 1024);
  writeSizedFile(`${dbPath}-shm`, 1024);
  const originalDb = fs.readFileSync(dbPath);
  const fsRef = new Proxy(fs, {
    get(target, property) {
      if (property === "renameSync") {
        return (sourcePath, destinationPath) => {
          if (sourcePath === `${dbPath}-shm`) {
            throw new Error("simulated sidecar quarantine failure");
          }
          return fs.renameSync(sourcePath, destinationPath);
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const result = restoreOpenWebuiDbFromBackup({
    projectRoot,
    sqliteBinaryPath: sqliteBinary,
    fsRef,
    manageContainer: false,
  });

  assert.equal(result.success, false);
  assert.match(result.error, /simulated sidecar quarantine failure/);
  assert.deepEqual(fs.readFileSync(dbPath), originalDb);
  assert.equal(fs.existsSync(`${dbPath}-wal`), true);
  assert.equal(fs.existsSync(`${dbPath}-shm`), true);
});

test("restoreOpenWebuiDbFromBackup does not restart after an incomplete sidecar rollback", (t) => {
  const sqliteBinary = resolveSqliteBinary();
  if (!sqliteBinary) {
    t.skip("sqlite3 is unavailable");
    return;
  }

  const projectRoot = makeProjectRoot(t);
  const dbPath = path.join(projectRoot, "open-webui-data", "webui.db");
  const backupPath = path.join(
    projectRoot,
    "open-webui-data",
    "repair-backups",
    "known-good",
    "webui.db.backup.known-good",
  );
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  execFileSync(sqliteBinary, [
    backupPath,
    "CREATE TABLE chat (id TEXT PRIMARY KEY, payload BLOB); " +
      "INSERT INTO chat VALUES ('safe-backup', zeroblob(700000));",
  ]);
  writeSizedFile(dbPath, 8 * 1024);
  writeSizedFile(`${dbPath}-wal`, 1024);
  writeSizedFile(`${dbPath}-shm`, 1024);
  const originalDb = fs.readFileSync(dbPath);
  const fsRef = new Proxy(fs, {
    get(target, property) {
      if (property === "renameSync") {
        return (sourcePath, destinationPath) => {
          if (sourcePath === `${dbPath}-shm`) {
            throw new Error("simulated sidecar quarantine failure");
          }
          if (
            destinationPath === `${dbPath}-wal` &&
            sourcePath.includes("webui.db-wal.pre-restore")
          ) {
            throw new Error("simulated sidecar rollback failure");
          }
          return fs.renameSync(sourcePath, destinationPath);
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const dockerCalls = [];
  const execFileSyncRef = (binary, args, options) => {
    if (binary === "docker") {
      dockerCalls.push(args);
      if (args[0] === "ps") return "portico-open-webui\n";
      if (args[0] === "stop") return "portico-open-webui\n";
      if (args[0] === "start") return "portico-open-webui\n";
      throw new Error(`Unexpected Docker call: ${args.join(" ")}`);
    }
    return execFileSync(binary, args, options);
  };

  const result = restoreOpenWebuiDbFromBackup({
    projectRoot,
    sqliteBinaryPath: sqliteBinary,
    fsRef,
    execFileSyncRef,
  });

  assert.equal(result.success, false);
  assert.match(result.error, /simulated sidecar quarantine failure/);
  assert.deepEqual(fs.readFileSync(dbPath), originalDb);
  assert.equal(fs.existsSync(`${dbPath}-wal`), false);
  assert.equal(fs.existsSync(`${dbPath}-shm`), true);
  assert.equal(
    result.quarantinedSidecarPaths.some((sidecarPath) =>
      fs.existsSync(sidecarPath),
    ),
    true,
  );
  assert.deepEqual(dockerCalls, [
    ["ps", "--format", "{{.Names}}"],
    ["stop", "-t", "30", "portico-open-webui"],
  ]);
  assert.match(
    result.notes.join("\n"),
    /Did not restart container portico-open-webui because sidecar rollback was incomplete/,
  );
});

test("restoreOpenWebuiDbFromBackup extracts the database member from a legacy full backup", (t) => {
  const sqliteBinary = resolveSqliteBinary();
  const zipBinary = ["/usr/bin/zip", "/opt/homebrew/bin/zip"].find((candidate) =>
    fs.existsSync(candidate),
  );
  const unzipBinary = ["/usr/bin/unzip", "/opt/homebrew/bin/unzip"].find(
    (candidate) => fs.existsSync(candidate),
  );
  if (!sqliteBinary || !zipBinary || !unzipBinary) {
    t.skip("sqlite3, zip, or unzip is unavailable");
    return;
  }

  const projectRoot = makeProjectRoot(t);
  const sourceRoot = path.join(projectRoot, "zip-source");
  const archivedDbPath = path.join(
    sourceRoot,
    "managed",
    "open-webui-data",
    "webui.db",
  );
  fs.mkdirSync(path.dirname(archivedDbPath), { recursive: true });
  execFileSync(sqliteBinary, [
    archivedDbPath,
    "CREATE TABLE chat (id TEXT PRIMARY KEY); " +
      "INSERT INTO chat VALUES ('from-full-backup');",
  ]);
  const backupDir = path.join(projectRoot, "backup");
  const archivePath = path.join(
    backupDir,
    "portico_full_backup_123.zip",
  );
  fs.mkdirSync(backupDir, { recursive: true });
  execFileSync(zipBinary, ["-q", "-r", archivePath, "managed"], {
    cwd: sourceRoot,
  });
  const dbPath = path.join(projectRoot, "open-webui-data", "webui.db");
  writeSizedFile(dbPath, 0);
  writeSentinel(projectRoot);

  const result = restoreOpenWebuiDbFromBackup({
    projectRoot,
    sqliteBinaryPath: sqliteBinary,
    unzipBinaryPath: unzipBinary,
    manageContainer: false,
  });

  assert.equal(result.success, true, result.error);
  assert.equal(result.candidate.sourceType, "full-backup-zip");
  assert.equal(result.candidate.archivePath, archivePath);
  assert.equal(
    execFileSync(
      sqliteBinary,
      ["-batch", "-noheader", dbPath, "SELECT id FROM chat;"],
      { encoding: "utf8" },
    ).trim(),
    "from-full-backup",
  );
});

test("startup and repair wiring record and enforce the sentinel at safe transitions", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  const ipcSource = fs.readFileSync(path.join(__dirname, "ipc.js"), "utf8");
  const preloadSource = fs.readFileSync(path.join(__dirname, "preload.js"), "utf8");
  const repairSource = fs.readFileSync(
    path.join(__dirname, "db-repair.js"),
    "utf8",
  );
  const launchGateIndex = mainSource.indexOf(
    "await prerequisitesService.updateInstalledRuntimeToBundledBuild({",
  );
  const sentinelCheckIndex = mainSource.indexOf(
    "await enforceOpenWebuiDbIntegrityBeforeDocker()",
  );
  const dockerIndex = mainSource.indexOf(
    "const dockerReady = await ensureDockerRunning()",
  );
  const guardFunctionIndex = mainSource.indexOf(
    "async function enforceOpenWebuiDbIntegrityBeforeDocker()",
  );
  const stopBeforeCheckIndex = mainSource.indexOf(
    "owuiDataIntegrityGuard.stopOpenWebuiContainer()",
    guardFunctionIndex,
  );
  const checkAfterStopIndex = mainSource.indexOf(
    "owuiDataIntegrityGuard.checkDbSentinel({",
    guardFunctionIndex,
  );

  assert.ok(launchGateIndex >= 0);
  assert.ok(sentinelCheckIndex > launchGateIndex);
  assert.ok(dockerIndex > sentinelCheckIndex);
  assert.ok(stopBeforeCheckIndex > guardFunctionIndex);
  assert.ok(checkAfterStopIndex > stopBeforeCheckIndex);
  assert.match(mainSource, /app\.on\("before-quit",[\s\S]*recordDbSentinel\(/);
  assert.match(
    mainSource,
    /recordDbSentinel\([\s\S]*?state\.windows\.loading\.webContents\.send\("loading-complete"\)/,
  );
  assert.match(ipcSource, /"restore-open-webui-db-from-backup"/);
  assert.match(preloadSource, /restoreOpenWebuiDbFromBackup/);
  assert.ok(
    repairSource.match(/recordSuccessfulRepairSentinel\(parts\.dbPath, notes\)/g)
      ?.length >= 2,
  );
});
