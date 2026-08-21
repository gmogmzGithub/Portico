const fs = require("fs");
const path = require("path");
const crypto = require("node:crypto");

// Disable modes are a sidecar to mcp_toggles.json: a flat map of
// serverId -> "hard" for integrations the user hard-disabled (PORTICO-410).
// Absence of an entry means the server is enabled or soft-disabled; the
// authoritative on/off state stays boolean in mcp_toggles.json so every
// existing toggle reader keeps working unchanged. Unlike the toggle store,
// readers must NEVER dead-end on a bad file — a missing/corrupt modes map
// degrades to "no hard disables" (today's soft behavior), so the loader is
// tolerant: invalid entries are dropped instead of invalidating the map.

const HARD_DISABLE_MODE = "hard";

function warnWithLogger(logger, message) {
  if (logger && typeof logger.warn === "function") {
    logger.warn(message);
    return;
  }
  console.warn(message);
}

function normalizeDisableModeValue(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === HARD_DISABLE_MODE ? HARD_DISABLE_MODE : null;
}

function sanitizeDisableModeMap(rawModes) {
  if (!rawModes || typeof rawModes !== "object" || Array.isArray(rawModes)) {
    throw new Error("Disable mode data must be a JSON object");
  }

  const cleaned = {};
  for (const [serverId, value] of Object.entries(rawModes)) {
    const normalized = normalizeDisableModeValue(value);
    if (normalized === null) continue;
    cleaned[serverId] = normalized;
  }
  return cleaned;
}

function canonicalizeDisableModeMap(rawModes) {
  const normalized = sanitizeDisableModeMap(rawModes || {});
  return Object.fromEntries(
    Object.entries(normalized).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}

function computeMcpDisableModeRevision(rawModes) {
  const canonical = canonicalizeDisableModeMap(rawModes);
  return `sha256:${crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")}`;
}

function buildMcpDisableModeSnapshot(rawModes, options = {}) {
  const modes = canonicalizeDisableModeMap(rawModes);
  return {
    schemaVersion: 1,
    revision: computeMcpDisableModeRevision(modes),
    capturedAt: options.capturedAt || new Date().toISOString(),
    modes,
  };
}

function writeMcpDisableModeSnapshotAtomicToPath(
  snapshotPath,
  rawModes,
  options = {},
) {
  if (!snapshotPath || typeof snapshotPath !== "string") {
    throw new TypeError("snapshotPath (string) is required");
  }
  const snapshot = buildMcpDisableModeSnapshot(rawModes, options);
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  const tempPath = `${snapshotPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  try {
    fs.renameSync(tempPath, snapshotPath);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch (_) {
      // Preserve the original snapshot write failure.
    }
    throw error;
  }
  return { snapshot, snapshotPath, revision: snapshot.revision };
}

function loadRawMcpDisableModesFromPath(modesPath, options = {}) {
  const { includeMeta = false, logger = console } = options;
  const meta = {
    modes: {},
    exists: false,
    contentHash: null,
    parseError: null,
    modesPath,
  };

  if (!fs.existsSync(modesPath)) {
    return includeMeta ? meta : {};
  }
  meta.exists = true;

  try {
    const rawContent = fs.readFileSync(modesPath, "utf8");
    meta.contentHash = `sha256:${crypto
      .createHash("sha256")
      .update(rawContent)
      .digest("hex")}`;
    const content = rawContent.trim();
    if (!content) {
      meta.modes = {};
      return includeMeta ? meta : meta.modes;
    }

    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError(
        "mcp_disable_modes.json must contain an object map of server ids to modes",
      );
    }
    meta.modes = sanitizeDisableModeMap(parsed);
    return includeMeta ? meta : meta.modes;
  } catch (error) {
    meta.parseError = error;
    logger.warn(
      `[MCP Disable Modes] Failed to parse mcp_disable_modes.json, treating as empty: ${error.message}`,
    );
    return includeMeta ? meta : {};
  }
}

function writeMcpDisableModesAtomicToPath(modesPath, rawModes, options = {}) {
  const { reason = "write", logger = null, snapshotPath = null } = options;
  const normalizedModes = sanitizeDisableModeMap(rawModes || {});
  const tempPath = `${modesPath}.${process.pid}.${Date.now()}.tmp`;

  if (fs.existsSync(modesPath)) {
    let existingStats;
    try {
      existingStats = fs.lstatSync(modesPath);
    } catch (error) {
      throw new Error(
        `Unable to inspect mcp_disable_modes.json before saving: ${error.message}`,
      );
    }

    if (existingStats.isDirectory()) {
      const backupPath = path.join(
        path.dirname(modesPath),
        `${path.basename(modesPath)}.dir-backup-${Date.now()}`,
      );
      try {
        fs.renameSync(modesPath, backupPath);
      } catch (error) {
        throw new Error(
          `mcp_disable_modes.json is a directory and could not be renamed aside: ${error.message}`,
        );
      }

      warnWithLogger(
        logger,
        `[MCP Disable Modes] Found directory at ${modesPath}; renamed it to ${backupPath} before persisting disable modes`,
      );
    }
  }

  fs.writeFileSync(
    tempPath,
    `${JSON.stringify(normalizedModes, null, 2)}\n`,
    "utf8",
  );

  try {
    fs.renameSync(tempPath, modesPath);
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch (unlinkError) {
      console.warn(
        `[MCP Disable Modes] Failed to clean up temp file ${tempPath}: ${unlinkError.message}`,
      );
    }
    throw error;
  }

  if (typeof logger === "function") {
    logger(
      `[MCP Disable Modes] Persisted ${Object.keys(normalizedModes).length} disable modes (${reason})`,
    );
  }

  const snapshotResult = snapshotPath
    ? writeMcpDisableModeSnapshotAtomicToPath(snapshotPath, normalizedModes)
    : null;

  return {
    modes: normalizedModes,
    modesPath,
    revision:
      snapshotResult?.revision || computeMcpDisableModeRevision(normalizedModes),
    snapshotPath: snapshotResult?.snapshotPath || null,
  };
}

function backupInvalidDisableModeFile(modesPath, options = {}) {
  const { logger = console, reason = "normalize" } = options;
  if (!fs.existsSync(modesPath)) {
    return null;
  }

  let stats;
  try {
    stats = fs.lstatSync(modesPath);
  } catch (error) {
    warnWithLogger(
      logger,
      `[MCP Disable Modes] Unable to inspect invalid mcp_disable_modes.json before ${reason}: ${error.message}`,
    );
    return null;
  }

  if (!stats.isFile() && !stats.isSymbolicLink()) {
    return null;
  }

  const backupPath = path.join(
    path.dirname(modesPath),
    `${path.basename(modesPath)}.invalid-backup-${Date.now()}`,
  );
  try {
    fs.copyFileSync(modesPath, backupPath);
    warnWithLogger(
      logger,
      `[MCP Disable Modes] Backed up invalid mcp_disable_modes.json to ${backupPath} before ${reason}`,
    );
    return backupPath;
  } catch (error) {
    warnWithLogger(
      logger,
      `[MCP Disable Modes] Failed to back up invalid mcp_disable_modes.json before ${reason}: ${error.message}`,
    );
    return null;
  }
}

function normalizeMcpDisableModeSourceAtPath(modesPath, options = {}) {
  if (!modesPath || typeof modesPath !== "string") {
    throw new TypeError("modesPath (string) is required");
  }

  const {
    logger = console,
    reason = "normalize",
    snapshotPath = null,
  } = options;

  const persist = (modes, extra = {}) => ({
    ...writeMcpDisableModesAtomicToPath(modesPath, modes, {
      reason,
      logger,
      snapshotPath,
    }),
    ...extra,
  });

  if (!fs.existsSync(modesPath)) {
    return persist({}, { repaired: true, repairReason: "missing" });
  }

  try {
    const stats = fs.lstatSync(modesPath);
    if (stats.isDirectory()) {
      warnWithLogger(
        logger,
        `[MCP Disable Modes] Directory found at mcp_disable_modes.json before ${reason}; replacing with empty mode map`,
      );
      return persist({}, { repaired: true, repairReason: "directory" });
    }

    const rawContent = fs.readFileSync(modesPath, "utf8");
    const parsed = JSON.parse(rawContent.trim() || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      const backupPath = backupInvalidDisableModeFile(modesPath, {
        logger,
        reason,
      });
      return persist({}, {
        repaired: true,
        repairReason: "non_object",
        backupPath,
      });
    }

    const normalized = {};
    const droppedKeys = [];
    let changed = false;
    for (const [serverId, value] of Object.entries(parsed)) {
      const nextValue = normalizeDisableModeValue(value);
      if (nextValue === null) {
        droppedKeys.push(serverId);
        changed = true;
        continue;
      }
      normalized[serverId] = nextValue;
      if (nextValue !== value) {
        changed = true;
      }
    }

    if (changed) {
      warnWithLogger(
        logger,
        `[MCP Disable Modes] Normalized mcp_disable_modes.json before ${reason}; dropped ${droppedKeys.length} invalid entr${droppedKeys.length === 1 ? "y" : "ies"}`,
      );
      return persist(normalized, {
        repaired: true,
        repairReason: "normalized",
        droppedKeys,
      });
    }

    const snapshotResult = snapshotPath
      ? writeMcpDisableModeSnapshotAtomicToPath(snapshotPath, normalized)
      : null;
    return {
      modes: normalized,
      modesPath,
      revision:
        snapshotResult?.revision || computeMcpDisableModeRevision(normalized),
      snapshotPath: snapshotResult?.snapshotPath || null,
      repaired: false,
      repairReason: null,
      droppedKeys,
    };
  } catch (error) {
    const backupPath = backupInvalidDisableModeFile(modesPath, {
      logger,
      reason,
    });
    warnWithLogger(
      logger,
      `[MCP Disable Modes] Replacing unreadable mcp_disable_modes.json before ${reason}: ${error.message}`,
    );
    return persist({}, {
      repaired: true,
      repairReason: "parse_error",
      backupPath,
    });
  }
}

async function applyDisableModeMutation(rawModeState, mutator, options = {}) {
  const { reason = "mutation", logger = console, writeModes } = options;

  if (!rawModeState || typeof rawModeState !== "object") {
    throw new TypeError("rawModeState (object) is required");
  }
  if (typeof mutator !== "function") {
    throw new TypeError("mutator (function) is required");
  }
  if (typeof writeModes !== "function") {
    throw new TypeError("writeModes (function) is required");
  }

  if (rawModeState.parseError) {
    logger.warn(
      `[MCP Disable Modes] Recovering from invalid mcp_disable_modes.json while applying ${reason}; treating existing mode state as empty`,
    );
  }

  const draft = { ...sanitizeDisableModeMap(rawModeState.modes || {}) };
  const mutationResult = await mutator(draft);
  const persisted = writeModes(draft, { reason, logger });
  return {
    modes: persisted.modes,
    modesPath: persisted.modesPath,
    revision:
      persisted.revision || computeMcpDisableModeRevision(persisted.modes),
    snapshotPath: persisted.snapshotPath || null,
    mutationResult,
    recoveredFromParseError: Boolean(rawModeState.parseError),
  };
}

async function applyDisableModeMutationToPath(modesPath, mutator, options = {}) {
  if (!modesPath || typeof modesPath !== "string") {
    throw new TypeError("modesPath (string) is required");
  }

  const logger = options.logger || console;
  const rawModeState = loadRawMcpDisableModesFromPath(modesPath, {
    includeMeta: true,
    logger,
  });

  return applyDisableModeMutation(rawModeState, mutator, {
    ...options,
    logger,
    writeModes:
      options.writeModes ||
      ((draft, writeOptions) =>
        writeMcpDisableModesAtomicToPath(modesPath, draft, writeOptions)),
  });
}

module.exports = {
  HARD_DISABLE_MODE,
  applyDisableModeMutation,
  applyDisableModeMutationToPath,
  buildMcpDisableModeSnapshot,
  canonicalizeDisableModeMap,
  computeMcpDisableModeRevision,
  loadRawMcpDisableModesFromPath,
  normalizeMcpDisableModeSourceAtPath,
  normalizeDisableModeValue,
  sanitizeDisableModeMap,
  writeMcpDisableModesAtomicToPath,
  writeMcpDisableModeSnapshotAtomicToPath,
};
