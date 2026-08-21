const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");

const {
  loadRawMcpTogglesFromPath,
  writeMcpTogglesAtomicToPath,
} = require("./mcp-toggle-store");
const {
  loadRawMcpDisableModesFromPath,
  writeMcpDisableModesAtomicToPath,
} = require("./mcp-disable-mode-store");
const {
  clearLegacyOAuthFiles,
  clearSecureOAuthRecord,
  loadOAuthRecord,
  persistOAuthRecord,
} = require("./oauth-token-storage");
const {
  loadBridgeAuthRegistry,
  revokeClientBridgeToken,
} = require("./host-mcp-bridge-auth");
const { clearStartupFailures } = require("./mcp-startup-failures");

const MIGRATION_SCHEMA_VERSION = 1;
const MIGRATION_MARKER_FILE = ".portico-user-collision-migration.json";
const RETIREMENT_MARKER_FILE = ".portico-user-collision-retirement.json";
const STAGE_PREFIX = ".portico-user-collision-stage-";
const RETIRED_PREFIX = ".portico-user-collision-retired-";
const SERVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function log(logger, level, message) {
  const sink =
    logger && typeof logger[level] === "function"
      ? logger[level].bind(logger)
      : logger && typeof logger.log === "function"
        ? logger.log.bind(logger)
        : null;
  if (sink) sink(message);
}

function assertSafeServerId(serverId, label = "server ID") {
  if (
    typeof serverId !== "string" ||
    !SERVER_ID_PATTERN.test(serverId) ||
    serverId.includes("..")
  ) {
    throw new Error(`Unsafe ${label}`);
  }
  return serverId;
}

function atomicWriteJson(filePath, value, options = {}) {
  const mode = options.mode ?? 0o600;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode,
    });
    fs.renameSync(tempPath, filePath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

function readStrictJsonObject(filePath, label, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  const stats = fs.lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return parsed;
}

function loadCollisionState(projectRoot, logger) {
  const togglesPath = path.join(projectRoot, "mcp_toggles.json");
  const toggleMeta = loadRawMcpTogglesFromPath(togglesPath, {
    includeMeta: true,
    logger,
  });
  if (toggleMeta.parseError) {
    throw new Error("mcp_toggles.json is invalid; refusing collision migration");
  }

  const toolsPath = path.join(projectRoot, "mcp_tools_config.json");
  const tools = readStrictJsonObject(
    toolsPath,
    "mcp_tools_config.json",
    {},
  );

  const groupsPath = path.join(projectRoot, "mcp-container-groups.json");
  const groupsDocument = readStrictJsonObject(
    groupsPath,
    "mcp-container-groups.json",
    { groups: {} },
  );
  if (
    !groupsDocument.groups ||
    typeof groupsDocument.groups !== "object" ||
    Array.isArray(groupsDocument.groups)
  ) {
    throw new Error("mcp-container-groups.json groups must be an object");
  }
  for (const [groupName, serverIds] of Object.entries(groupsDocument.groups)) {
    if (
      !Array.isArray(serverIds) ||
      serverIds.some((serverId) => typeof serverId !== "string")
    ) {
      throw new Error(
        `mcp-container-groups.json group ${groupName} must be a string array`,
      );
    }
  }

  return {
    togglesPath,
    toggles: toggleMeta.toggles,
    toolsPath,
    tools,
    groupsPath,
    groupsDocument,
  };
}

function migrateDisableModeKey({ projectRoot, sourceId, targetId, logger }) {
  // Disable modes are fail-open sidecar state; never block the collision
  // migration on them. A hard-disabled user server keeps its hard disable
  // under its migrated ID.
  try {
    const modesPath = path.join(projectRoot, "mcp_disable_modes.json");
    const modeMeta = loadRawMcpDisableModesFromPath(modesPath, {
      includeMeta: true,
      logger,
    });
    if (!modeMeta.exists || modeMeta.modes[sourceId] === undefined) {
      return false;
    }
    const modes = { ...modeMeta.modes };
    if (modes[targetId] === undefined) {
      modes[targetId] = modes[sourceId];
    }
    delete modes[sourceId];
    writeMcpDisableModesAtomicToPath(modesPath, modes, {
      reason: "migrate-user-mcp-collision",
      logger,
      snapshotPath: path.join(
        projectRoot,
        "health-status",
        "mcp_disable_modes_snapshot.json",
      ),
    });
    return true;
  } catch (error) {
    log(
      logger,
      "warn",
      `[MCP Collision] Could not migrate disable mode for ${sourceId}: ${error.message}`,
    );
    return false;
  }
}

function shouldIgnoreFingerprintEntry(relativePath) {
  return (
    relativePath === MIGRATION_MARKER_FILE ||
    relativePath === RETIREMENT_MARKER_FILE
  );
}

function fingerprintTree(rootPath) {
  const hash = crypto.createHash("sha256");
  let totalBytes = 0;

  function walk(currentPath, relativePath) {
    const stats = fs.lstatSync(currentPath);
    if (stats.isSymbolicLink()) {
      throw new Error("MCP collision source contains a symbolic link");
    }
    if (stats.isDirectory()) {
      hash.update(`d\0${relativePath}\0${stats.mode & 0o777}\0`);
      const entries = fs.readdirSync(currentPath).sort();
      for (const entry of entries) {
        const childRelative = relativePath
          ? path.posix.join(relativePath, entry)
          : entry;
        if (shouldIgnoreFingerprintEntry(childRelative)) continue;
        walk(path.join(currentPath, entry), childRelative);
      }
      return;
    }
    if (!stats.isFile()) {
      throw new Error("MCP collision source contains a special file");
    }
    totalBytes += stats.size;
    if (totalBytes > 128 * 1024 * 1024) {
      throw new Error("MCP collision source is too large to migrate safely");
    }
    hash.update(`f\0${relativePath}\0${stats.mode & 0o777}\0${stats.size}\0`);
    hash.update(fs.readFileSync(currentPath));
  }

  walk(rootPath, "");
  return `sha256:${hash.digest("hex")}`;
}

function renameRootEntry(name, sourceId, targetId) {
  if (name === sourceId) return targetId;
  if (name.startsWith(`${sourceId}.`)) {
    return `${targetId}${name.slice(sourceId.length)}`;
  }
  return name;
}

function rewriteCanonicalYaml(buffer, targetId) {
  const text = buffer.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(buffer) || text.includes("\0")) {
    throw new Error("Canonical MCP YAML is not valid UTF-8 text");
  }
  const replacement = `id: "${targetId}"`;
  if (/^id\s*:[^\r\n]*(?:\r?\n|$)/m.test(text)) {
    return Buffer.from(
      text.replace(/^id\s*:[^\r\n]*/m, replacement),
      "utf8",
    );
  }
  const documentStart = text.match(/^(?:\uFEFF)?---[^\r\n]*(?:\r?\n|$)/);
  if (documentStart) {
    const newline = documentStart[0].includes("\r\n") ? "\r\n" : "\n";
    return Buffer.from(
      `${documentStart[0]}${replacement}${newline}${text.slice(documentStart[0].length)}`,
      "utf8",
    );
  }
  return Buffer.from(`${replacement}\n${text}`, "utf8");
}

function copyTransformedTree(sourceDir, stageDir, sourceId, targetId) {
  fs.mkdirSync(stageDir, { recursive: false, mode: 0o700 });

  function copyDirectory(currentSource, currentTarget, isRoot) {
    const sourceStats = fs.lstatSync(currentSource);
    fs.chmodSync(currentTarget, sourceStats.mode & 0o777);
    for (const entry of fs.readdirSync(currentSource).sort()) {
      if (
        isRoot &&
        (entry === RETIREMENT_MARKER_FILE || entry === MIGRATION_MARKER_FILE)
      ) {
        continue;
      }
      const sourcePath = path.join(currentSource, entry);
      const stats = fs.lstatSync(sourcePath);
      if (stats.isSymbolicLink()) {
        throw new Error("MCP collision source contains a symbolic link");
      }
      const targetName = isRoot
        ? renameRootEntry(entry, sourceId, targetId)
        : entry;
      const targetPath = path.join(currentTarget, targetName);
      if (stats.isDirectory()) {
        fs.mkdirSync(targetPath, { mode: stats.mode & 0o777 });
        copyDirectory(sourcePath, targetPath, false);
      } else if (stats.isFile()) {
        const isCanonicalYaml =
          isRoot && entry === `${sourceId}.yaml`;
        const content = fs.readFileSync(sourcePath);
        fs.writeFileSync(
          targetPath,
          isCanonicalYaml
            ? rewriteCanonicalYaml(content, targetId)
            : content,
          { mode: stats.mode & 0o777 },
        );
        fs.chmodSync(targetPath, stats.mode & 0o777);
      } else {
        throw new Error("MCP collision source contains a special file");
      }
    }
  }

  copyDirectory(sourceDir, stageDir, true);
}

function readMigrationMarker(targetDir) {
  const markerPath = path.join(targetDir, MIGRATION_MARKER_FILE);
  if (!fs.existsSync(markerPath)) return null;
  const marker = readStrictJsonObject(
    markerPath,
    "MCP collision migration marker",
    null,
  );
  if (
    marker.schemaVersion !== MIGRATION_SCHEMA_VERSION ||
    typeof marker.sourceId !== "string" ||
    typeof marker.systemId !== "string" ||
    typeof marker.targetId !== "string" ||
    typeof marker.sourceFingerprint !== "string" ||
    typeof marker.targetFingerprint !== "string" ||
    typeof marker.sourceEnabled !== "boolean" ||
    (marker.completed !== undefined && typeof marker.completed !== "boolean")
  ) {
    throw new Error("MCP collision migration marker is invalid");
  }
  return { ...marker, completed: marker.completed === true };
}

function markMigrationCompleted(targetDir) {
  const marker = readMigrationMarker(targetDir);
  if (!marker) {
    throw new Error("MCP collision target marker is missing");
  }
  if (marker.completed) return marker;
  const completedMarker = {
    ...marker,
    completed: true,
    completedAt: new Date().toISOString(),
  };
  atomicWriteJson(
    path.join(targetDir, MIGRATION_MARKER_FILE),
    completedMarker,
    { mode: 0o600 },
  );
  return completedMarker;
}

function collectReservedIds(projectRoot, userDataPath, state) {
  const reserved = new Set([
    ...Object.keys(state.toggles),
    ...Object.keys(state.tools),
  ]);
  for (const serverIds of Object.values(state.groupsDocument.groups)) {
    serverIds.forEach((serverId) => reserved.add(serverId));
  }
  for (const rootName of ["mcp-configs", "mcp-configs-user"]) {
    const root = path.join(projectRoot, rootName);
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        reserved.add(entry.name);
      }
    }
  }
  const recordsDir = path.join(userDataPath, "mcp-oauth-records");
  if (fs.existsSync(recordsDir)) {
    for (const name of fs.readdirSync(recordsDir)) {
      if (name.endsWith(".json.enc")) {
        reserved.add(name.slice(0, -".json.enc".length));
      }
    }
  }
  return new Set([...reserved].map((serverId) => serverId.toLowerCase()));
}

function selectTargetId({
  projectRoot,
  userDataPath,
  sourceId,
  systemId,
  sourceFingerprint,
  state,
}) {
  const userRoot = path.join(projectRoot, "mcp-configs-user");
  const reserved = collectReservedIds(projectRoot, userDataPath, state);
  for (let suffix = 1; suffix < 10_000; suffix += 1) {
    const targetId =
      suffix === 1 ? `${systemId}-user` : `${systemId}-user-${suffix}`;
    assertSafeServerId(targetId, "migration target ID");
    const targetDir = path.join(userRoot, targetId);
    if (fs.existsSync(targetDir)) {
      let marker = null;
      try {
        marker = readMigrationMarker(targetDir);
      } catch (_) {
        // A malformed marker makes this an occupied foreign target. Preserve it
        // and allocate the next suffix instead of blocking startup forever.
        continue;
      }
      let targetFingerprintMatches = false;
      if (marker && !marker.completed) {
        try {
          targetFingerprintMatches =
            fingerprintTree(targetDir) === marker.targetFingerprint;
        } catch (_) {
          // Preserve an edited or malformed target as occupied state.
        }
      }
      if (
        marker &&
        marker.sourceId === sourceId &&
        marker.systemId === systemId &&
        marker.targetId === targetId &&
        !marker.completed &&
        marker.sourceFingerprint === sourceFingerprint &&
        targetFingerprintMatches &&
        (state.toggles[targetId] === undefined ||
          state.toggles[targetId] === marker.sourceEnabled)
      ) {
        return { targetId, targetDir, marker, resumed: true };
      }
      // Completed migrations, edited copies, and mismatched source snapshots
      // are all valid occupied targets; a new collision receives a new suffix.
      continue;
    }
    if (!reserved.has(targetId.toLowerCase())) {
      return { targetId, targetDir, marker: null, resumed: false };
    }
  }
  throw new Error(`Unable to allocate a unique user MCP ID for ${sourceId}`);
}

function writeStateDocument(filePath, document) {
  atomicWriteJson(filePath, document, { mode: 0o600 });
}

function migrateObjectKey(document, sourceId, targetId, label) {
  const hasSource = Object.prototype.hasOwnProperty.call(document, sourceId);
  const hasTarget = Object.prototype.hasOwnProperty.call(document, targetId);
  if (!hasSource) return false;
  if (hasTarget && !isDeepStrictEqual(document[sourceId], document[targetId])) {
    throw new Error(`${label} has conflicting state for ${targetId}`);
  }
  if (!hasTarget) document[targetId] = document[sourceId];
  delete document[sourceId];
  return true;
}

function migrateGroups(groupsDocument, sourceId, targetId) {
  let changed = false;
  for (const [groupName, serverIds] of Object.entries(groupsDocument.groups)) {
    const next = [];
    for (const serverId of serverIds) {
      const replacement = serverId === sourceId ? targetId : serverId;
      if (!next.includes(replacement)) next.push(replacement);
    }
    if (!isDeepStrictEqual(serverIds, next)) {
      groupsDocument.groups[groupName] = next;
      changed = true;
    }
  }
  return changed;
}

function migrateOAuthRecord({
  projectRoot,
  userDataPath,
  safeStorage,
  sourceId,
  targetId,
}) {
  const oauthOptions = { projectRoot, userDataPath, safeStorage };
  const sourceRecord = loadOAuthRecord(sourceId, oauthOptions);
  const targetRecord = loadOAuthRecord(targetId, oauthOptions);
  if (!sourceRecord) {
    return { copied: false, oauthOptions };
  }
  if (targetRecord && !isDeepStrictEqual(sourceRecord, targetRecord)) {
    throw new Error(`OAuth state conflicts at collision target ${targetId}`);
  }
  if (!targetRecord) {
    persistOAuthRecord(targetId, sourceRecord, oauthOptions);
  }
  const verified = loadOAuthRecord(targetId, oauthOptions);
  if (!isDeepStrictEqual(sourceRecord, verified)) {
    throw new Error(`OAuth state verification failed for ${targetId}`);
  }
  return { copied: true, oauthOptions };
}

function matchingBridgeClientIds(userDataPath, sourceId) {
  const registry = loadBridgeAuthRegistry({ userDataPath });
  const exact = `oauth-access-token-${sourceId}`;
  const staticPrefix = `static-secret-${sourceId}-`;
  return registry.tokens
    .map((entry) => entry.clientId)
    .filter(
      (clientId) =>
        clientId === exact || clientId.startsWith(staticPrefix),
    );
}

function invokePhase(options, phase, details) {
  if (typeof options.onPhase === "function") {
    options.onPhase(phase, details);
  }
}

function cleanupOwnedArtifacts(projectRoot, logger) {
  const userRoot = path.join(projectRoot, "mcp-configs-user");
  if (!fs.existsSync(userRoot)) return;
  for (const entry of fs.readdirSync(userRoot, { withFileTypes: true })) {
    const artifactPath = path.join(userRoot, entry.name);
    if (entry.name.startsWith(STAGE_PREFIX)) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        fs.rmSync(artifactPath, { recursive: true, force: true });
      }
      continue;
    }
    if (!entry.name.startsWith(RETIRED_PREFIX) || !entry.isDirectory()) {
      continue;
    }
    try {
      const retirement = readStrictJsonObject(
        path.join(artifactPath, RETIREMENT_MARKER_FILE),
        "MCP collision retirement marker",
        null,
      );
      assertSafeServerId(retirement?.sourceId, "retired source ID");
      assertSafeServerId(retirement?.targetId, "retired target ID");
      const targetDir = path.join(userRoot, retirement.targetId);
      const targetMarker = readMigrationMarker(targetDir);
      if (
        targetMarker?.sourceId === retirement.sourceId &&
        targetMarker?.targetId === retirement.targetId &&
        (targetMarker.completed ||
          fingerprintTree(targetDir) === targetMarker.targetFingerprint)
      ) {
        if (!targetMarker.completed) {
          markMigrationCompleted(targetDir);
        }
        fs.rmSync(artifactPath, { recursive: true, force: true });
      }
    } catch (error) {
      log(
        logger,
        "warn",
        `[MCP Collision] Preserving an unverified retired directory: ${error.message}`,
      );
    }
  }
}

function retireSourceDirectory({
  sourceDir,
  userRoot,
  sourceId,
  targetId,
  targetDir,
}) {
  const marker = readMigrationMarker(targetDir);
  if (
    !marker ||
    marker.sourceId !== sourceId ||
    marker.targetId !== targetId ||
    fingerprintTree(targetDir) !== marker.targetFingerprint
  ) {
    throw new Error("Refusing to retire MCP collision source without a verified target");
  }
  atomicWriteJson(
    path.join(sourceDir, RETIREMENT_MARKER_FILE),
    {
      schemaVersion: MIGRATION_SCHEMA_VERSION,
      sourceId,
      targetId,
    },
    { mode: 0o600 },
  );
  const retiredDir = path.join(
    userRoot,
    `${RETIRED_PREFIX}${crypto.randomUUID()}`,
  );
  fs.renameSync(sourceDir, retiredDir);
  return retiredDir;
}

function migrateOneCollision({
  projectRoot,
  userDataPath,
  safeStorage,
  sourceId,
  systemId,
  logger,
  options,
}) {
  assertSafeServerId(sourceId, "collision source ID");
  assertSafeServerId(systemId, "bundled system ID");
  const userRoot = path.join(projectRoot, "mcp-configs-user");
  const sourceDir = path.join(userRoot, sourceId);
  const sourceFingerprint = fingerprintTree(sourceDir);
  let state = loadCollisionState(projectRoot, logger);
  const selected = selectTargetId({
    projectRoot,
    userDataPath,
    sourceId,
    systemId,
    sourceFingerprint,
    state,
  });

  let marker = selected.marker;
  if (!selected.resumed) {
    const sourceEnabled = state.toggles[sourceId] === true;
    const stageDir = path.join(
      userRoot,
      `${STAGE_PREFIX}${crypto.randomUUID()}`,
    );
    try {
      copyTransformedTree(
        sourceDir,
        stageDir,
        sourceId,
        selected.targetId,
      );
      const targetFingerprint = fingerprintTree(stageDir);
      marker = {
        schemaVersion: MIGRATION_SCHEMA_VERSION,
        sourceId,
        systemId,
        targetId: selected.targetId,
        sourceFingerprint,
        targetFingerprint,
        sourceEnabled,
        completed: false,
      };
      atomicWriteJson(
        path.join(stageDir, MIGRATION_MARKER_FILE),
        marker,
        { mode: 0o600 },
      );
      fs.renameSync(stageDir, selected.targetDir);
    } finally {
      fs.rmSync(stageDir, { recursive: true, force: true });
    }
  }

  invokePhase(options, "after_target_created", {
    sourceId,
    targetId: selected.targetId,
  });

  state = loadCollisionState(projectRoot, logger);
  const toolsChanged = migrateObjectKey(
    state.tools,
    sourceId,
    selected.targetId,
    "mcp_tools_config.json",
  );
  if (toolsChanged) writeStateDocument(state.toolsPath, state.tools);

  const groupsChanged = migrateGroups(
    state.groupsDocument,
    sourceId,
    selected.targetId,
  );
  if (groupsChanged) {
    writeStateDocument(state.groupsPath, state.groupsDocument);
  }

  const oauth = migrateOAuthRecord({
    projectRoot,
    userDataPath,
    safeStorage,
    sourceId,
    targetId: selected.targetId,
  });
  const bridgeClientIds = matchingBridgeClientIds(userDataPath, sourceId);

  invokePhase(options, "before_toggle_commit", {
    sourceId,
    targetId: selected.targetId,
  });

  state = loadCollisionState(projectRoot, logger);
  const existingTargetToggle = state.toggles[selected.targetId];
  if (
    existingTargetToggle !== undefined &&
    existingTargetToggle !== marker.sourceEnabled
  ) {
    throw new Error(
      `mcp_toggles.json has conflicting state for ${selected.targetId}`,
    );
  }
  state.toggles[selected.targetId] = marker.sourceEnabled;
  state.toggles[sourceId] = false;
  state.toggles[systemId] = false;
  writeMcpTogglesAtomicToPath(state.togglesPath, state.toggles, {
    reason: "migrate-user-mcp-collision",
    logger,
    snapshotPath: path.join(
      projectRoot,
      "health-status",
      "mcp_toggles_snapshot.json",
    ),
  });

  migrateDisableModeKey({
    projectRoot,
    sourceId,
    targetId: selected.targetId,
    logger,
  });

  invokePhase(options, "after_toggle_commit", {
    sourceId,
    targetId: selected.targetId,
  });

  if (oauth.copied) {
    clearSecureOAuthRecord(sourceId, oauth.oauthOptions);
  }
  clearLegacyOAuthFiles(sourceId, oauth.oauthOptions);
  for (const clientId of bridgeClientIds) {
    revokeClientBridgeToken({ userDataPath, clientId, logger });
  }
  clearStartupFailures(projectRoot, [sourceId, selected.targetId], {
    logger,
  });

  const retiredDir = retireSourceDirectory({
    sourceDir,
    userRoot,
    sourceId,
    targetId: selected.targetId,
    targetDir: selected.targetDir,
  });
  markMigrationCompleted(selected.targetDir);

  invokePhase(options, "after_source_retired", {
    sourceId,
    targetId: selected.targetId,
  });
  fs.rmSync(retiredDir, { recursive: true, force: true });

  log(
    logger,
    "info",
    `[MCP Collision] Migrated user integration ${sourceId} to ${selected.targetId}`,
  );
  return {
    sourceId,
    systemId,
    targetId: selected.targetId,
    sourceEnabled: marker.sourceEnabled,
    resumed: selected.resumed,
  };
}

function discoverCollisions(projectRoot) {
  const systemRoot = path.join(projectRoot, "mcp-configs");
  const userRoot = path.join(projectRoot, "mcp-configs-user");
  if (!fs.existsSync(systemRoot) || !fs.existsSync(userRoot)) return [];

  const systemIds = new Map();
  for (const entry of fs.readdirSync(systemRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      assertSafeServerId(entry.name, "bundled system ID");
      const foldedId = entry.name.toLowerCase();
      if (systemIds.has(foldedId) && systemIds.get(foldedId) !== entry.name) {
        throw new Error("Bundled MCP IDs must be case-insensitively unique");
      }
      systemIds.set(foldedId, entry.name);
    }
  }

  const collisions = [];
  for (const entry of fs.readdirSync(userRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const systemId = systemIds.get(entry.name.toLowerCase());
    if (systemId) {
      collisions.push({ sourceId: entry.name, systemId });
    }
  }
  return collisions.sort((left, right) =>
    left.sourceId.localeCompare(right.sourceId),
  );
}

function migrateUserMcpCollisions(options = {}) {
  const projectRoot =
    typeof options.projectRoot === "string" ? options.projectRoot : "";
  const userDataPath =
    typeof options.userDataPath === "string" ? options.userDataPath : "";
  if (!path.isAbsolute(projectRoot) || !path.isAbsolute(userDataPath)) {
    throw new TypeError("projectRoot and userDataPath must be absolute paths");
  }

  const logger = options.logger || console;
  cleanupOwnedArtifacts(projectRoot, logger);
  const collisions = discoverCollisions(projectRoot);
  const migrations = [];
  for (const collision of collisions) {
    try {
      migrations.push(
        migrateOneCollision({
          projectRoot,
          userDataPath,
          safeStorage: options.safeStorage,
          sourceId: collision.sourceId,
          systemId: collision.systemId,
          logger,
          options,
        }),
      );
    } catch (error) {
      throw new Error(
        `Failed to preserve user MCP integration ${collision.sourceId}: ${error.message}`,
        { cause: error },
      );
    }
  }
  return { migrated: migrations.length, migrations };
}

module.exports = {
  MIGRATION_MARKER_FILE,
  RETIREMENT_MARKER_FILE,
  discoverCollisions,
  fingerprintTree,
  migrateUserMcpCollisions,
  rewriteCanonicalYaml,
};
