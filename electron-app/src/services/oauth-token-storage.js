const fs = require("fs");
const path = require("path");
const { execFileSync } = require("node:child_process");

const OAUTH_RECORDS_DIR_NAME = "mcp-oauth-records";
const OAUTH_RECORD_FILE_SUFFIX = ".json.enc";
const LEGACY_OAUTH_STORE_ROOTS = ["mcpo-oauth-tokens", "mcpo-core-oauth-tokens"];
const OAUTH_MIGRATION_STATUS_FILE = "mcp-oauth-migration-status.json";
const LEGACY_OAUTH_EXPORT_TIMEOUT_MS = 30_000;

function normalizeServerId(serverId) {
  const normalized = typeof serverId === "string" ? serverId.trim() : "";
  if (!normalized) {
    throw new TypeError("serverId is required");
  }
  if (
    normalized.includes("..") ||
    normalized.includes("/") ||
    normalized.includes("\\")
  ) {
    throw new Error(`Invalid serverId: ${serverId}`);
  }
  return normalized;
}

function resolveProjectRoot(projectRoot) {
  if (typeof projectRoot === "string" && projectRoot.trim()) {
    return projectRoot;
  }

  const bootstrap = require("./bootstrap");
  if (!bootstrap.PROJECT_ROOT) {
    throw new Error("Project root not initialized");
  }
  return bootstrap.PROJECT_ROOT;
}

function resolveUserDataPath(options = {}) {
  if (typeof options.userDataPath === "string" && options.userDataPath.trim()) {
    return options.userDataPath;
  }
  const electron = options.electron || require("electron");
  if (!electron?.app?.getPath) {
    throw new Error("Electron app userData path is unavailable");
  }
  return electron.app.getPath("userData");
}

function resolveSafeStorage(options = {}) {
  if (options.safeStorage) {
    return options.safeStorage;
  }
  const electron = options.electron || require("electron");
  return electron.safeStorage;
}

function ensureSecureStorageAvailable(options = {}) {
  const safeStorage = resolveSafeStorage(options);
  if (!safeStorage?.isEncryptionAvailable?.()) {
    throw new Error("Secure OAuth storage is unavailable");
  }
  if (
    typeof safeStorage.getSelectedStorageBackend === "function" &&
    safeStorage.getSelectedStorageBackend() === "basic_text"
  ) {
    throw new Error(
      "Secure OAuth storage is unavailable because Electron safeStorage is using basic_text",
    );
  }
  if (
    typeof safeStorage.encryptString !== "function" ||
    typeof safeStorage.decryptString !== "function"
  ) {
    throw new Error("Secure OAuth storage encryption APIs are unavailable");
  }
  return safeStorage;
}

function resolveLegacyOAuthTokenStorage(serverId, options = {}) {
  const normalizedServerId = normalizeServerId(serverId);
  const projectRoot = resolveProjectRoot(options.projectRoot);
  const roots = LEGACY_OAUTH_STORE_ROOTS.map((storageRootName) => {
    const serverDir = path.join(projectRoot, storageRootName, normalizedServerId);
    return {
      storageRootName,
      serverDir,
      tokensDir: path.join(serverDir, "tokens"),
    };
  });
  return {
    serverId: normalizedServerId,
    projectRoot,
    roots,
  };
}

function resolveOAuthTokenStorage(serverId, options = {}) {
  const normalizedServerId = normalizeServerId(serverId);
  const userDataPath = resolveUserDataPath(options);
  const recordsDir = path.join(userDataPath, OAUTH_RECORDS_DIR_NAME);
  return {
    serverId: normalizedServerId,
    userDataPath,
    recordsDir,
    recordFile: path.join(
      recordsDir,
      `${normalizedServerId}${OAUTH_RECORD_FILE_SUFFIX}`,
    ),
    storageScope: "electron_safe_storage",
    legacy: resolveLegacyOAuthTokenStorage(normalizedServerId, options),
  };
}

function listLegacyOAuthStorageFiles(serverId, options = {}) {
  const storage = resolveLegacyOAuthTokenStorage(serverId, options);
  const roots = storage.roots.map((root) => {
    if (!fs.existsSync(root.tokensDir)) {
      return {
        ...root,
        exists: false,
        files: [],
        tokenFiles: [],
        clientFiles: [],
      };
    }

    const files = fs
      .readdirSync(root.tokensDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
    return {
      ...root,
      exists: true,
      files,
      tokenFiles: files.filter((name) => name.endsWith("_tokens.json")),
      clientFiles: files.filter((name) => name.endsWith("_client.json")),
    };
  });

  return {
    ...storage,
    roots,
    exists: roots.some((root) => root.exists),
    tokenFiles: roots.flatMap((root) =>
      root.tokenFiles.map((name) => path.join(root.tokensDir, name)),
    ),
    clientFiles: roots.flatMap((root) =>
      root.clientFiles.map((name) => path.join(root.tokensDir, name)),
    ),
  };
}

function removeEmptyDirectory(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) {
    return false;
  }
  try {
    fs.rmdirSync(dirPath);
    return true;
  } catch (_error) {
    return false;
  }
}

function pruneEmptyLegacyOAuthRoot(root) {
  let removed = 0;
  for (const dirPath of [
    root.tokensDir,
    root.serverDir,
    path.dirname(root.serverDir),
  ]) {
    if (removeEmptyDirectory(dirPath)) {
      removed += 1;
    }
  }
  return removed;
}

function pruneEmptyLegacyOAuthRoots(roots) {
  return roots.reduce(
    (removed, root) => removed + pruneEmptyLegacyOAuthRoot(root),
    0,
  );
}

function resolveMigrationStatusFile(options = {}) {
  return path.join(resolveUserDataPath(options), OAUTH_MIGRATION_STATUS_FILE);
}

function readMigrationStatus(options = {}) {
  const statusFile = resolveMigrationStatusFile(options);
  try {
    if (!fs.existsSync(statusFile)) {
      return { version: 1, servers: {} };
    }
    const parsed = JSON.parse(fs.readFileSync(statusFile, "utf8"));
    return {
      version: 1,
      servers:
        parsed && typeof parsed.servers === "object" && parsed.servers
          ? parsed.servers
          : {},
    };
  } catch (_error) {
    return { version: 1, servers: {} };
  }
}

function writeMigrationStatus(serverId, status, options = {}) {
  const statusFile = resolveMigrationStatusFile(options);
  const current = readMigrationStatus(options);
  const sanitized = {
    state: status.state || "unknown",
    reason: status.reason || null,
    errorClass: status.errorClass || null,
    sourceRoot: status.sourceRoot || null,
    legacyTokenFiles: Number(status.legacyTokenFiles || 0),
    legacyClientFiles: Number(status.legacyClientFiles || 0),
    removedLegacyFiles: Number(status.removedLegacyFiles || 0),
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(statusFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    statusFile,
    JSON.stringify(
      {
        version: 1,
        servers: {
          ...current.servers,
          [serverId]: sanitized,
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return { statusFile, status: sanitized };
}

function classifyMigrationError(error) {
  const message = String(error?.message || "");
  if (/basic_text|Secure OAuth storage|safeStorage/i.test(message)) {
    return "secure_storage_unavailable";
  }
  if (/No current mcp-orc binary|mcp-orc binary/i.test(message)) {
    return "mcp_orc_unavailable";
  }
  if (/legacy encrypted OAuth token file/i.test(message)) {
    return "legacy_oauth_encrypted_store_unsupported";
  }
  if (/invalid oauth token/i.test(message)) {
    return "legacy_oauth_import_invalid";
  }
  return "legacy_oauth_import_failed";
}

function defaultExportLegacyOAuthRecord(serverId, root, options = {}) {
  const projectRoot = resolveProjectRoot(options.projectRoot);
  const { resolveMcpOrcBinary } = require("./mcp-orc-cli");
  const command = options.mcpOrcBinary || resolveMcpOrcBinary(projectRoot, options);
  const stdout = execFileSync(
    command,
    [
      "export-legacy-oauth-record",
      "--server-id",
      serverId,
      "--storage-dir",
      root.tokensDir,
    ],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        ...(options.env || {}),
      },
      encoding: "utf8",
      timeout: options.legacyExportTimeoutMs || LEGACY_OAUTH_EXPORT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return JSON.parse(stdout);
}

function normalizeImportedOAuthRecord(serverId, exported) {
  if (!exported || typeof exported !== "object") {
    throw new Error("legacy OAuth export returned no record");
  }
  if (exported.server_id && exported.server_id !== serverId) {
    throw new Error("legacy OAuth export server_id mismatch");
  }
  const token = exported.token && typeof exported.token === "object"
    ? { ...exported.token }
    : {};
  const clientInfo = exported.client_info && typeof exported.client_info === "object"
    ? { ...exported.client_info }
    : {};
  if (typeof token.access_token !== "string" || !token.access_token.trim()) {
    throw new Error("legacy OAuth export missing access token");
  }
  if (typeof clientInfo.client_id !== "string" || !clientInfo.client_id.trim()) {
    throw new Error("legacy OAuth export missing client metadata");
  }
  return {
    token,
    client_info: clientInfo,
  };
}

function removeLegacyRootFiles(root) {
  let removed = 0;
  for (const fileName of [...root.tokenFiles, ...root.clientFiles]) {
    const filePath = path.join(root.tokensDir, fileName);
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
      removed += 1;
    }
  }
  return removed;
}

function removeLegacyRootFilesAndPrune(root) {
  const removed = removeLegacyRootFiles(root);
  pruneEmptyLegacyOAuthRoot(root);
  return removed;
}

function encryptRecord(record, safeStorage) {
  return safeStorage.encryptString(JSON.stringify(record));
}

function decryptRecord(buffer, safeStorage) {
  return JSON.parse(safeStorage.decryptString(buffer));
}

function buildStoredRecord(serverId, oauthRecord) {
  if (!oauthRecord || typeof oauthRecord !== "object") {
    throw new TypeError("OAuth record must be an object");
  }
  return {
    server_id: normalizeServerId(serverId),
    updated_at: new Date().toISOString(),
    oauth: oauthRecord,
  };
}

function persistOAuthRecord(serverId, oauthRecord, options = {}) {
  const storage = resolveOAuthTokenStorage(serverId, options);
  const safeStorage = ensureSecureStorageAvailable(options);
  const storedRecord = buildStoredRecord(storage.serverId, oauthRecord);
  fs.mkdirSync(storage.recordsDir, { recursive: true, mode: 0o700 });
  const encrypted = encryptRecord(storedRecord, safeStorage);
  const temporaryRecordFile = path.join(
    storage.recordsDir,
    `.${storage.serverId}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(temporaryRecordFile, encrypted, { mode: 0o600 });
    fs.renameSync(temporaryRecordFile, storage.recordFile);
  } finally {
    if (fs.existsSync(temporaryRecordFile)) {
      fs.rmSync(temporaryRecordFile, { force: true });
    }
  }
  writeMigrationStatus(
    storage.serverId,
    {
      state: "skipped",
      reason: "secure_record_present",
    },
    options,
  );
  return {
    success: true,
    serverId: storage.serverId,
    recordFile: storage.recordFile,
    storageScope: storage.storageScope,
  };
}

function loadOAuthRecord(serverId, options = {}) {
  const storage = resolveOAuthTokenStorage(serverId, options);
  if (!fs.existsSync(storage.recordFile)) {
    return null;
  }
  const safeStorage = ensureSecureStorageAvailable(options);
  const storedRecord = decryptRecord(fs.readFileSync(storage.recordFile), safeStorage);
  if (storedRecord?.server_id !== storage.serverId) {
    throw new Error("OAuth record server_id mismatch");
  }
  if (!storedRecord.oauth || typeof storedRecord.oauth !== "object") {
    throw new Error("OAuth record payload is invalid");
  }
  return storedRecord.oauth;
}

function checkPersistedOAuthTokens(serverId, options = {}) {
  const storage = resolveOAuthTokenStorage(serverId, options);
  const migrationStatus = readMigrationStatus(options).servers[storage.serverId];
  const legacy = listLegacyOAuthStorageFiles(storage.serverId, options);
  if (legacy.tokenFiles.length > 0 || legacy.clientFiles.length > 0) {
    if (
      migrationStatus?.state === "blocked" ||
      migrationStatus?.state === "requires_reauth"
    ) {
      return {
        exists: false,
        reason: "legacy_oauth_store_requires_reauth",
        errorClass: migrationStatus.errorClass || "legacy_oauth_import_failed",
        serverId: storage.serverId,
        legacyTokenFiles: legacy.tokenFiles.length,
        legacyClientFiles: legacy.clientFiles.length,
        storageScope: storage.storageScope,
      };
    }
    return {
      exists: false,
      reason: "legacy_oauth_store_requires_migration",
      serverId: storage.serverId,
      legacyTokenFiles: legacy.tokenFiles.length,
      legacyClientFiles: legacy.clientFiles.length,
      storageScope: storage.storageScope,
    };
  }
  if (
    migrationStatus?.state === "requires_reauth" &&
    migrationStatus?.reason === "secure_oauth_record_requires_reauth"
  ) {
    return {
      exists: false,
      reason: "secure_oauth_record_requires_reauth",
      errorClass: migrationStatus.errorClass || "secure_oauth_record_invalid",
      serverId: storage.serverId,
      recordFile: storage.recordFile,
      storageScope: storage.storageScope,
    };
  }
  if (fs.existsSync(storage.recordFile)) {
    try {
      loadOAuthRecord(storage.serverId, options);
      return {
        exists: true,
        serverId: storage.serverId,
        recordFile: storage.recordFile,
        storageScope: storage.storageScope,
      };
    } catch (error) {
      return {
        exists: false,
        reason: "secure_oauth_record_unreadable",
        error: error.message,
        serverId: storage.serverId,
        recordFile: storage.recordFile,
        storageScope: storage.storageScope,
      };
    }
  }

  return {
    exists: false,
    reason: "secure_record_missing",
    serverId: storage.serverId,
    recordFile: storage.recordFile,
    storageScope: storage.storageScope,
  };
}

function migrateLegacyOAuthRecord(serverId, options = {}) {
  const storage = resolveOAuthTokenStorage(serverId, options);
  const legacy = listLegacyOAuthStorageFiles(storage.serverId, options);
  const previousStatus = readMigrationStatus(options).servers[storage.serverId];

  const candidateRoots = legacy.roots.filter(
    (root) => root.tokenFiles.length > 0 && root.clientFiles.length > 0,
  );
  const hasLegacyFiles =
    legacy.tokenFiles.length > 0 || legacy.clientFiles.length > 0;

  // Physical legacy credentials are authoritative during the one-way upgrade.
  // Import them before consulting an existing secure record so a stale secure
  // record cannot hide the credential that worked in the previous app build.
  if (candidateRoots.length > 0) {
    const exportLegacyOAuthRecord =
      options.exportLegacyOAuthRecord || defaultExportLegacyOAuthRecord;
    const failures = [];
    for (const root of candidateRoots) {
      try {
        const exported = exportLegacyOAuthRecord(storage.serverId, root, options);
        const oauthRecord = normalizeImportedOAuthRecord(storage.serverId, exported);
        persistOAuthRecord(storage.serverId, oauthRecord, options);
        const verified = loadOAuthRecord(storage.serverId, options);
        normalizeImportedOAuthRecord(storage.serverId, {
          server_id: storage.serverId,
          ...verified,
        });
        const removedLegacyFiles =
          options.removeLegacyFiles === false
            ? 0
            : legacy.roots.reduce(
                (removed, candidate) =>
                  removed + removeLegacyRootFilesAndPrune(candidate),
                0,
              );
        if (options.removeLegacyFiles !== false) {
          pruneEmptyLegacyOAuthRoots(legacy.roots);
        }
        const result = {
          success: true,
          imported: true,
          state: "imported",
          serverId: storage.serverId,
          sourceRoot: root.storageRootName,
          legacyTokenFiles: legacy.tokenFiles.length,
          legacyClientFiles: legacy.clientFiles.length,
          removedLegacyFiles,
          storageScope: storage.storageScope,
        };
        writeMigrationStatus(storage.serverId, result, options);
        return result;
      } catch (error) {
        failures.push({
          sourceRoot: root.storageRootName,
          errorClass: classifyMigrationError(error),
        });
      }
    }

    const result = {
      success: false,
      imported: false,
      state: "requires_reauth",
      reason: "legacy_oauth_store_requires_reauth",
      errorClass: failures[0]?.errorClass || "legacy_oauth_import_failed",
      failures,
      serverId: storage.serverId,
      legacyTokenFiles: legacy.tokenFiles.length,
      legacyClientFiles: legacy.clientFiles.length,
      storageScope: storage.storageScope,
    };
    writeMigrationStatus(storage.serverId, result, options);
    return result;
  }

  if (hasLegacyFiles) {
    if (fs.existsSync(storage.recordFile)) {
      try {
        loadOAuthRecord(storage.serverId, options);
        const removedLegacyFiles =
          options.removeLegacyFiles === false
            ? 0
            : legacy.roots.reduce(
                (removed, root) => removed + removeLegacyRootFilesAndPrune(root),
                0,
              );
        const result = {
          success: true,
          imported: false,
          state: "skipped",
          reason: "secure_record_present",
          serverId: storage.serverId,
          legacyTokenFiles: legacy.tokenFiles.length,
          legacyClientFiles: legacy.clientFiles.length,
          removedLegacyFiles,
          storageScope: storage.storageScope,
        };
        writeMigrationStatus(storage.serverId, result, options);
        return result;
      } catch (_error) {
        // Fall through to requiring re-authentication: incomplete legacy files
        // cannot repair an unreadable secure record.
      }
    }

    const result = {
      success: false,
      imported: false,
      state: "requires_reauth",
      reason: "legacy_oauth_store_requires_reauth",
      errorClass: "legacy_oauth_import_incomplete",
      serverId: storage.serverId,
      legacyTokenFiles: legacy.tokenFiles.length,
      legacyClientFiles: legacy.clientFiles.length,
      storageScope: storage.storageScope,
    };
    writeMigrationStatus(storage.serverId, result, options);
    return result;
  }

  if (
    previousStatus?.state === "requires_reauth" &&
    previousStatus?.reason === "secure_oauth_record_requires_reauth"
  ) {
    return {
      success: false,
      imported: false,
      state: "requires_reauth",
      reason: "secure_oauth_record_requires_reauth",
      errorClass: previousStatus.errorClass || "secure_oauth_record_invalid",
      serverId: storage.serverId,
      legacyTokenFiles: 0,
      legacyClientFiles: 0,
      storageScope: storage.storageScope,
    };
  }

  if (fs.existsSync(storage.recordFile)) {
    try {
      loadOAuthRecord(storage.serverId, options);
      const result = {
        success: true,
        imported: false,
        state: "skipped",
        reason: "secure_record_present",
        serverId: storage.serverId,
        storageScope: storage.storageScope,
      };
      writeMigrationStatus(storage.serverId, result, options);
      return result;
    } catch (error) {
      const result = {
        success: false,
        imported: false,
        state: "requires_reauth",
        reason: "secure_oauth_record_requires_reauth",
        errorClass: classifyMigrationError(error),
        serverId: storage.serverId,
        storageScope: storage.storageScope,
      };
      writeMigrationStatus(storage.serverId, result, options);
      return result;
    }
  }

  pruneEmptyLegacyOAuthRoots(legacy.roots);
  const result = {
    success: false,
    imported: false,
    state: "skipped",
    reason: "legacy_store_missing",
    serverId: storage.serverId,
    storageScope: storage.storageScope,
    legacyTokenFiles: 0,
    legacyClientFiles: 0,
  };
  writeMigrationStatus(storage.serverId, result, options);
  return result;
}

function discoverLegacyOAuthServerIds(options = {}) {
  const projectRoot = resolveProjectRoot(options.projectRoot);
  const serverIds = new Set();
  for (const storageRootName of LEGACY_OAUTH_STORE_ROOTS) {
    const storageRoot = path.join(projectRoot, storageRootName);
    let entries = [];
    try {
      entries = fs.readdirSync(storageRoot, { withFileTypes: true });
    } catch (_error) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      try {
        serverIds.add(normalizeServerId(entry.name));
      } catch (_error) {
        // Ignore malformed entries instead of reflecting them into secure state.
      }
    }
  }
  return Array.from(serverIds).sort();
}

function migrateAllLegacyOAuthRecords(options = {}) {
  const results = discoverLegacyOAuthServerIds(options).map((serverId) =>
    migrateLegacyOAuthRecord(serverId, options),
  );
  return {
    success: results.every((result) => result.success),
    imported: results.filter((result) => result.imported).length,
    requiresReauth: results.filter(
      (result) => result.state === "requires_reauth",
    ).length,
    results,
  };
}

function clearSecureOAuthRecord(serverId, options = {}) {
  const storage = resolveOAuthTokenStorage(serverId, options);
  let clearedCount = 0;

  if (fs.existsSync(storage.recordFile)) {
    fs.rmSync(storage.recordFile, { force: true });
    clearedCount += 1;
  }

  return {
    success: true,
    cleared: clearedCount > 0,
    clearedCount,
    tokenFiles: [],
    clientFiles: [],
    recordFile: storage.recordFile,
    storageScope: storage.storageScope,
    clearMode: "secure_oauth_record",
  };
}

function invalidateSecureOAuthRecord(serverId, options = {}) {
  const storage = resolveOAuthTokenStorage(serverId, options);
  const cleared = clearSecureOAuthRecord(storage.serverId, options);
  const reason =
    typeof options.reason === "string" && options.reason.trim()
      ? options.reason.trim()
      : "secure_oauth_record_requires_reauth";
  const errorClass =
    typeof options.errorClass === "string" && options.errorClass.trim()
      ? options.errorClass.trim()
      : "secure_oauth_record_invalid";
  const migrationStatus = writeMigrationStatus(
    storage.serverId,
    {
      state: "requires_reauth",
      reason,
      errorClass,
    },
    options,
  );
  return {
    ...cleared,
    state: "requires_reauth",
    reason,
    errorClass,
    statusFile: migrationStatus.statusFile,
  };
}

function clearLegacyOAuthFiles(serverId, options = {}) {
  const storage = resolveOAuthTokenStorage(serverId, options);
  const legacy = listLegacyOAuthStorageFiles(storage.serverId, options);
  let clearedCount = 0;

  for (const filePath of [...legacy.tokenFiles, ...legacy.clientFiles]) {
    fs.rmSync(filePath, { force: true });
    clearedCount += 1;
  }
  pruneEmptyLegacyOAuthRoots(legacy.roots);

  return {
    success: true,
    cleared: clearedCount > 0,
    clearedCount,
    tokenFiles: legacy.tokenFiles.map((filePath) => path.basename(filePath)),
    clientFiles: legacy.clientFiles.map((filePath) => path.basename(filePath)),
    storageScope: storage.storageScope,
    clearMode: "legacy_oauth_files",
  };
}

function clearPersistedOAuthTokens(serverId, options = {}) {
  const secure = clearSecureOAuthRecord(serverId, options);
  const legacy = clearLegacyOAuthFiles(serverId, options);
  return {
    success: true,
    cleared: secure.cleared || legacy.cleared,
    clearedCount: secure.clearedCount + legacy.clearedCount,
    tokenFiles: legacy.tokenFiles,
    clientFiles: legacy.clientFiles,
    recordFile: secure.recordFile,
    storageScope: secure.storageScope,
    clearMode: "oauth_state",
  };
}

module.exports = {
  OAUTH_RECORDS_DIR_NAME,
  OAUTH_MIGRATION_STATUS_FILE,
  resolveOAuthTokenStorage,
  resolveLegacyOAuthTokenStorage,
  listLegacyOAuthStorageFiles,
  readMigrationStatus,
  persistOAuthRecord,
  loadOAuthRecord,
  migrateLegacyOAuthRecord,
  migrateAllLegacyOAuthRecords,
  discoverLegacyOAuthServerIds,
  checkPersistedOAuthTokens,
  clearSecureOAuthRecord,
  invalidateSecureOAuthRecord,
  clearLegacyOAuthFiles,
  clearPersistedOAuthTokens,
  ensureSecureStorageAvailable,
};
