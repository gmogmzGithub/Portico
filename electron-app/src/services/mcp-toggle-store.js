const fs = require("fs");
const path = require("path");
const crypto = require("node:crypto");

function warnWithLogger(logger, message) {
  if (logger && typeof logger.warn === "function") {
    logger.warn(message);
    return;
  }
  console.warn(message);
}

function normalizeToggleValue(value) {
  if (value === true || value === false) {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return null;
}

function sanitizeToggleMap(rawToggles) {
  if (!rawToggles || typeof rawToggles !== "object" || Array.isArray(rawToggles)) {
    throw new Error("Toggle data must be a JSON object");
  }

  const cleaned = {};
  for (const [serverId, value] of Object.entries(rawToggles)) {
    const normalized = normalizeToggleValue(value);
    if (normalized === null) continue;
    cleaned[serverId] = normalized;
  }
  return cleaned;
}

function canonicalizeToggleMap(rawToggles) {
  const normalized = sanitizeToggleMap(rawToggles || {});
  return Object.fromEntries(
    Object.entries(normalized).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}

function computeMcpToggleRevision(rawToggles) {
  const canonical = canonicalizeToggleMap(rawToggles);
  return `sha256:${crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")}`;
}

function buildMcpToggleSnapshot(rawToggles, options = {}) {
  const toggles = canonicalizeToggleMap(rawToggles);
  return {
    schemaVersion: 1,
    revision: computeMcpToggleRevision(toggles),
    capturedAt: options.capturedAt || new Date().toISOString(),
    toggles,
  };
}

function writeMcpToggleSnapshotAtomicToPath(
  snapshotPath,
  rawToggles,
  options = {},
) {
  if (!snapshotPath || typeof snapshotPath !== "string") {
    throw new TypeError("snapshotPath (string) is required");
  }
  const snapshot = buildMcpToggleSnapshot(rawToggles, options);
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

function loadRawMcpTogglesFromPath(togglesPath, options = {}) {
  const { includeMeta = false, logger = console } = options;
  const meta = {
    toggles: {},
    exists: false,
    contentHash: null,
    parseError: null,
    togglesPath,
  };

  if (!fs.existsSync(togglesPath)) {
    return includeMeta ? meta : {};
  }
  meta.exists = true;

  try {
    const rawContent = fs.readFileSync(togglesPath, "utf8");
    meta.contentHash = `sha256:${crypto
      .createHash("sha256")
      .update(rawContent)
      .digest("hex")}`;
    const content = rawContent.trim();
    if (!content) {
      // PORTICO-364: a blank / whitespace-only file is an unambiguous "no toggles
      // set" state — commonly a 0-byte file left by an interrupted non-atomic
      // create during first-run/guided-setup — not corruption. Treat it as an
      // empty map (parseError stays null) so reads AND mutations recover and the
      // next write replaces it, instead of dead-ending every enable. Mirrors
      // normalizeMcpToggleSourceAtPath, which already heals blank to {}.
      meta.toggles = {};
      return includeMeta ? meta : meta.toggles;
    }

    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("mcp_toggles.json must contain a boolean object map");
    }
    if (Object.values(parsed).some((value) => typeof value !== "boolean")) {
      throw new TypeError("mcp_toggles.json values must be booleans");
    }
    meta.toggles = sanitizeToggleMap(parsed);
    return includeMeta ? meta : meta.toggles;
  } catch (error) {
    meta.parseError = error;
    logger.warn(
      `[MCP Toggles] Failed to parse mcp_toggles.json, treating as empty: ${error.message}`,
    );
    return includeMeta ? meta : {};
  }
}

function writeMcpTogglesAtomicToPath(togglesPath, rawToggles, options = {}) {
  const { reason = "write", logger = null, snapshotPath = null } = options;
  const normalizedToggles = sanitizeToggleMap(rawToggles || {});
  const tempPath = `${togglesPath}.${process.pid}.${Date.now()}.tmp`;

  if (fs.existsSync(togglesPath)) {
    let existingStats;
    try {
      existingStats = fs.lstatSync(togglesPath);
    } catch (error) {
      throw new Error(
        `Unable to inspect mcp_toggles.json before saving: ${error.message}`,
      );
    }

    if (existingStats.isDirectory()) {
      const backupPath = path.join(
        path.dirname(togglesPath),
        `${path.basename(togglesPath)}.dir-backup-${Date.now()}`,
      );
      try {
        fs.renameSync(togglesPath, backupPath);
      } catch (error) {
        throw new Error(
          `mcp_toggles.json is a directory and could not be renamed aside: ${error.message}`,
        );
      }

      warnWithLogger(
        logger,
        `[MCP Toggles] Found directory at ${togglesPath}; renamed it to ${backupPath} before persisting toggle state`,
      );
    }
  }

  fs.writeFileSync(
    tempPath,
    `${JSON.stringify(normalizedToggles, null, 2)}\n`,
    "utf8",
  );

  try {
    fs.renameSync(tempPath, togglesPath);
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch (unlinkError) {
      console.warn(
        `[MCP Toggles] Failed to clean up temp file ${tempPath}: ${unlinkError.message}`,
      );
    }
    throw error;
  }

  if (typeof logger === "function") {
    logger(
      `[MCP Toggles] Persisted ${Object.keys(normalizedToggles).length} toggles (${reason})`,
    );
  }

  const snapshotResult = snapshotPath
    ? writeMcpToggleSnapshotAtomicToPath(snapshotPath, normalizedToggles)
    : null;

  return {
    toggles: normalizedToggles,
    togglesPath,
    revision:
      snapshotResult?.revision || computeMcpToggleRevision(normalizedToggles),
    snapshotPath: snapshotResult?.snapshotPath || null,
  };
}

function backupInvalidToggleFile(togglesPath, options = {}) {
  const { logger = console, reason = "normalize" } = options;
  if (!fs.existsSync(togglesPath)) {
    return null;
  }

  let stats;
  try {
    stats = fs.lstatSync(togglesPath);
  } catch (error) {
    warnWithLogger(
      logger,
      `[MCP Toggles] Unable to inspect invalid mcp_toggles.json before ${reason}: ${error.message}`,
    );
    return null;
  }

  if (!stats.isFile() && !stats.isSymbolicLink()) {
    return null;
  }

  const backupPath = path.join(
    path.dirname(togglesPath),
    `${path.basename(togglesPath)}.invalid-backup-${Date.now()}`,
  );
  try {
    fs.copyFileSync(togglesPath, backupPath);
    warnWithLogger(
      logger,
      `[MCP Toggles] Backed up invalid mcp_toggles.json to ${backupPath} before ${reason}`,
    );
    return backupPath;
  } catch (error) {
    warnWithLogger(
      logger,
      `[MCP Toggles] Failed to back up invalid mcp_toggles.json before ${reason}: ${error.message}`,
    );
    return null;
  }
}

function normalizeMcpToggleSourceAtPath(togglesPath, options = {}) {
  if (!togglesPath || typeof togglesPath !== "string") {
    throw new TypeError("togglesPath (string) is required");
  }

  const {
    logger = console,
    reason = "normalize",
    snapshotPath = null,
  } = options;

  const persist = (toggles, extra = {}) => ({
    ...writeMcpTogglesAtomicToPath(togglesPath, toggles, {
      reason,
      logger,
      snapshotPath,
    }),
    ...extra,
  });

  if (!fs.existsSync(togglesPath)) {
    warnWithLogger(
      logger,
      `[MCP Toggles] Missing mcp_toggles.json before ${reason}; creating empty toggle map`,
    );
    return persist({}, { repaired: true, repairReason: "missing" });
  }

  try {
    const stats = fs.lstatSync(togglesPath);
    if (stats.isDirectory()) {
      warnWithLogger(
        logger,
        `[MCP Toggles] Directory found at mcp_toggles.json before ${reason}; replacing with empty toggle map`,
      );
      return persist({}, { repaired: true, repairReason: "directory" });
    }

    const rawContent = fs.readFileSync(togglesPath, "utf8");
    const parsed = JSON.parse(rawContent.trim() || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      const backupPath = backupInvalidToggleFile(togglesPath, { logger, reason });
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
      const nextValue = normalizeToggleValue(value);
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
        `[MCP Toggles] Normalized mcp_toggles.json before ${reason}; dropped ${droppedKeys.length} invalid entr${droppedKeys.length === 1 ? "y" : "ies"}`,
      );
      return persist(normalized, {
        repaired: true,
        repairReason: "normalized",
        droppedKeys,
      });
    }

    const snapshotResult = snapshotPath
      ? writeMcpToggleSnapshotAtomicToPath(snapshotPath, normalized)
      : null;
    return {
      toggles: normalized,
      togglesPath,
      revision:
        snapshotResult?.revision || computeMcpToggleRevision(normalized),
      snapshotPath: snapshotResult?.snapshotPath || null,
      repaired: false,
      repairReason: null,
      droppedKeys,
    };
  } catch (error) {
    const backupPath = backupInvalidToggleFile(togglesPath, { logger, reason });
    warnWithLogger(
      logger,
      `[MCP Toggles] Replacing unreadable mcp_toggles.json before ${reason}: ${error.message}`,
    );
    return persist({}, {
      repaired: true,
      repairReason: "parse_error",
      backupPath,
    });
  }
}

async function applyToggleMutation(rawToggleState, mutator, options = {}) {
  const {
    reason = "mutation",
    logger = console,
    recoverFromParseError = true,
    writeToggles,
  } = options;

  if (!rawToggleState || typeof rawToggleState !== "object") {
    throw new TypeError("rawToggleState (object) is required");
  }
  if (typeof mutator !== "function") {
    throw new TypeError("mutator (function) is required");
  }
  if (typeof writeToggles !== "function") {
    throw new TypeError("writeToggles (function) is required");
  }

  if (rawToggleState.parseError) {
    if (!recoverFromParseError) {
      const error = new Error(
        `Cannot apply ${reason}: mcp_toggles.json is invalid`,
      );
      error.code = "MCP_TOGGLES_PARSE_ERROR";
      error.cause = rawToggleState.parseError;
      throw error;
    }
    logger.warn(
      `[MCP Toggles] Recovering from invalid mcp_toggles.json while applying ${reason}; treating existing toggle state as empty`,
    );
  }

  const draft = { ...sanitizeToggleMap(rawToggleState.toggles || {}) };
  const mutationResult = await mutator(draft);
  const persisted = writeToggles(draft, { reason, logger });
  return {
    toggles: persisted.toggles,
    togglesPath: persisted.togglesPath,
    revision:
      persisted.revision || computeMcpToggleRevision(persisted.toggles),
    snapshotPath: persisted.snapshotPath || null,
    mutationResult,
    recoveredFromParseError: Boolean(rawToggleState.parseError),
  };
}

async function applyToggleMutationToPath(togglesPath, mutator, options = {}) {
  if (!togglesPath || typeof togglesPath !== "string") {
    throw new TypeError("togglesPath (string) is required");
  }

  const logger = options.logger || console;
  const rawToggleState = loadRawMcpTogglesFromPath(togglesPath, {
    includeMeta: true,
    logger,
  });

  return applyToggleMutation(rawToggleState, mutator, {
    ...options,
    logger,
    writeToggles:
      options.writeToggles ||
      ((draft, writeOptions) =>
        writeMcpTogglesAtomicToPath(togglesPath, draft, writeOptions)),
  });
}

module.exports = {
  applyToggleMutation,
  applyToggleMutationToPath,
  buildMcpToggleSnapshot,
  canonicalizeToggleMap,
  computeMcpToggleRevision,
  loadRawMcpTogglesFromPath,
  normalizeMcpToggleSourceAtPath,
  normalizeToggleValue,
  sanitizeToggleMap,
  writeMcpTogglesAtomicToPath,
  writeMcpToggleSnapshotAtomicToPath,
};
