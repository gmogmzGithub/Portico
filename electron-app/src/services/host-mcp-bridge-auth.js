const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const BRIDGE_AUTH_DIR_NAME = "host-mcp-bridge";
const BRIDGE_TOKEN_DIR_NAME = "tokens";
const BRIDGE_REGISTRY_FILE_NAME = "auth-registry.json";
const TOKEN_PREFIX = "portico_mcp_";
const HASH_ALGORITHM = "sha256";
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const TOKEN_HASH_PATTERN = /^sha256:[0-9a-f]{32}:[0-9a-f]{64}$/;
const SALT_PATTERN = /^[0-9a-f]{32}$/;
const SCOPE_PATTERN = /^[\x21-\x7e]+$/;

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function assertUserDataPath(userDataPath) {
  if (!isNonEmptyString(userDataPath)) {
    throw new Error("userDataPath is required");
  }
}

function sanitizeClientId(clientId) {
  if (!isNonEmptyString(clientId)) {
    throw new Error("clientId is required");
  }
  const sanitized = clientId.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!sanitized) {
    throw new Error("clientId must contain at least one alphanumeric character");
  }
  return sanitized;
}

function canonicalClientId(clientId) {
  const trimmed = isNonEmptyString(clientId) ? clientId.trim() : "";
  const sanitized = sanitizeClientId(clientId);
  if (
    trimmed !== sanitized ||
    !/^[A-Za-z0-9_-]+$/.test(trimmed) ||
    !/[A-Za-z0-9]/.test(trimmed) ||
    trimmed.startsWith("-") ||
    trimmed.endsWith("-")
  ) {
    throw new Error("clientId must already use the canonical safe ASCII form");
  }
  return sanitized;
}

function getBridgeAuthDir(userDataPath) {
  assertUserDataPath(userDataPath);
  return path.join(userDataPath, BRIDGE_AUTH_DIR_NAME);
}

function getBridgeTokenDir(userDataPath) {
  return path.join(getBridgeAuthDir(userDataPath), BRIDGE_TOKEN_DIR_NAME);
}

function getBridgeTokenRegistryPath(userDataPath) {
  return path.join(getBridgeAuthDir(userDataPath), BRIDGE_REGISTRY_FILE_NAME);
}

function getBridgeClientTokenPath(userDataPath, clientId) {
  return path.join(getBridgeTokenDir(userDataPath), `${sanitizeClientId(clientId)}.token`);
}

function ensurePrivateDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    fs.chmodSync(dirPath, PRIVATE_DIR_MODE);
  } catch (_) {
    // chmod can fail on some non-POSIX filesystems; creation mode is still best effort.
  }
}

function writeFileAtomic(filePath, content, options = {}) {
  const mode = options.mode ?? PRIVATE_FILE_MODE;
  const backup = options.backup === true;
  ensurePrivateDir(path.dirname(filePath));

  if (backup && fs.existsSync(filePath)) {
    const backupPath = `${filePath}.bak.${Date.now()}`;
    fs.copyFileSync(filePath, backupPath);
    try {
      fs.chmodSync(backupPath, mode);
    } catch (_) {
      // Best effort only.
    }
  }

  const tmpPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, content, { encoding: "utf8", mode });
  try {
    fs.chmodSync(tmpPath, mode);
  } catch (_) {
    // Best effort only.
  }
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, mode);
  } catch (_) {
    // Best effort only.
  }
}

function nowIso() {
  return new Date().toISOString();
}

function generateBridgeToken() {
  return `${TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
}

function generateSalt() {
  return crypto.randomBytes(16).toString("hex");
}

function normalizeScopes(scopes) {
  if (!Array.isArray(scopes)) {
    return [];
  }
  return [
    ...new Set(
      scopes
        .filter((scope) => isNonEmptyString(scope))
        .map((scope) => String(scope).trim()),
    ),
  ].sort();
}

function normalizeRequestedScopes(scopes) {
  if (
    !Array.isArray(scopes) ||
    scopes.some(
      (scope) =>
        typeof scope !== "string" ||
        !SCOPE_PATTERN.test(scope) ||
        scope.trim() !== scope,
    )
  ) {
    throw new Error("scopes must be printable-ASCII nonempty strings");
  }
  return normalizeScopes(scopes);
}

function scopesMatch(left, right) {
  return JSON.stringify(normalizeScopes(left)) === JSON.stringify(normalizeScopes(right));
}

function hashBridgeToken(token, salt = generateSalt()) {
  if (!isNonEmptyString(token)) {
    throw new Error("token is required");
  }
  if (!SALT_PATTERN.test(String(salt || ""))) {
    throw new Error("salt must be 32 lowercase hexadecimal characters");
  }
  const digest = crypto
    .createHash(HASH_ALGORITHM)
    .update(String(salt), "utf8")
    .update(":")
    .update(String(token), "utf8")
    .digest("hex");
  return `${HASH_ALGORITHM}:${salt}:${digest}`;
}

function timingSafeEqualString(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyBridgeTokenHash(token, tokenHash) {
  if (!isNonEmptyString(token) || !TOKEN_HASH_PATTERN.test(String(tokenHash || ""))) {
    return false;
  }
  const parts = tokenHash.split(":");
  if (parts.length !== 3 || parts[0] !== HASH_ALGORITHM || !parts[1] || !parts[2]) {
    return false;
  }
  return timingSafeEqualString(hashBridgeToken(token, parts[1]), tokenHash);
}


function validateBridgeAuthRegistryRaw(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("registry must be a JSON object");
  }
  if (raw.version !== 1) {
    throw new Error("registry version must be 1");
  }
  if (!Array.isArray(raw.tokens)) {
    throw new Error("registry tokens must be an array");
  }

  const clientIds = new Set();
  const foldedClientIds = new Set();
  for (const entry of raw.tokens) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("registry token entries must be objects");
    }
    const clientId = canonicalClientId(entry.clientId);
    const foldedClientId = clientId.toLowerCase();
    if (clientIds.has(clientId) || foldedClientIds.has(foldedClientId)) {
      throw new Error("registry client IDs must be unique on a case-insensitive filesystem");
    }
    clientIds.add(clientId);
    foldedClientIds.add(foldedClientId);

    if (typeof entry.revoked !== "boolean") {
      throw new Error("registry token revoked must be a boolean");
    }
    if (!TOKEN_HASH_PATTERN.test(String(entry.tokenHash || ""))) {
      throw new Error("registry token hash is malformed");
    }
    if (Object.prototype.hasOwnProperty.call(entry, "scopes")) {
      if (!Array.isArray(entry.scopes)) {
        throw new Error("registry token scopes must be an array");
      }
      if (
        entry.scopes.some(
          (scope) =>
            typeof scope !== "string" ||
            !SCOPE_PATTERN.test(scope) ||
            scope.trim() !== scope,
        ) ||
        JSON.stringify(entry.scopes) !== JSON.stringify(normalizeScopes(entry.scopes))
      ) {
        throw new Error("registry token scopes must be canonical nonempty strings");
      }
    }
  }
}

function resolveStoredClientId(registry, requestedClientId) {
  const exact = registry.tokens.find((entry) => entry.clientId === requestedClientId);
  if (exact) {
    return exact.clientId;
  }
  const folded = requestedClientId.toLowerCase();
  const matches = registry.tokens.filter(
    (entry) => entry.clientId.toLowerCase() === folded,
  );
  if (matches.length > 1) {
    throw new Error("registry contains ambiguous case-folded client IDs");
  }
  return matches[0]?.clientId || requestedClientId;
}

function logBridgeAuthEvent(logger, level, { event, clientId, reason, changed }) {
  try {
    const sink = logger && typeof logger[level] === "function"
      ? logger[level]
      : logger && typeof logger.log === "function"
        ? logger.log
        : null;
    if (!sink) {
      return;
    }
    sink.call(
      logger,
      "[Host MCP Bridge Auth] event=" + event +
        " clientId=" + clientId +
        " reason=" + reason +
        " changed=" + (changed === true),
    );
  } catch (_) {
    // Authentication must never depend on the log sink.
  }
}

function normalizeRegistry(raw) {
  const tokens = Array.isArray(raw?.tokens) ? raw.tokens : [];
  return {
    version: 1,
    updatedAt: isNonEmptyString(raw?.updatedAt) ? raw.updatedAt : nowIso(),
    tokens: tokens
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => {
        const clientId = sanitizeClientId(entry.clientId || entry.client_id || "unknown");
        return {
          clientId,
          displayName: isNonEmptyString(entry.displayName || entry.display_name)
            ? String(entry.displayName || entry.display_name).trim()
            : clientId,
          tokenHash: String(entry.tokenHash || entry.token_hash || ""),
          tokenFile: isNonEmptyString(entry.tokenFile || entry.token_file)
            ? String(entry.tokenFile || entry.token_file)
            : "",
          scopes: normalizeScopes(entry.scopes),
          createdAt: isNonEmptyString(entry.createdAt || entry.created_at)
            ? String(entry.createdAt || entry.created_at)
            : nowIso(),
          updatedAt: isNonEmptyString(entry.updatedAt || entry.updated_at)
            ? String(entry.updatedAt || entry.updated_at)
            : nowIso(),
          revoked: entry.revoked === true,
        };
      }),
  };
}

function loadBridgeAuthRegistry({ userDataPath, registryPath } = {}) {
  const resolvedPath = registryPath || getBridgeTokenRegistryPath(userDataPath);
  if (!fs.existsSync(resolvedPath)) {
    return normalizeRegistry({ tokens: [] });
  }
  try {
    const raw = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
    validateBridgeAuthRegistryRaw(raw);
    return normalizeRegistry(raw);
  } catch (error) {
    throw new Error(`Failed to read Host MCP Bridge auth registry: ${error.message}`);
  }
}

function saveBridgeAuthRegistry({ userDataPath, registryPath, registry, backup = true } = {}) {
  const resolvedPath = registryPath || getBridgeTokenRegistryPath(userDataPath);
  const normalized = normalizeRegistry({
    ...registry,
    updatedAt: nowIso(),
  });
  validateBridgeAuthRegistryRaw(normalized);
  writeFileAtomic(resolvedPath, `${JSON.stringify(normalized, null, 2)}\n`, {
    mode: PRIVATE_FILE_MODE,
    backup,
  });
  return { registry: normalized, registryPath: resolvedPath };
}

function ensureBridgeAuthRegistry({ userDataPath, registryPath } = {}) {
  const resolvedPath = registryPath || getBridgeTokenRegistryPath(userDataPath);
  ensurePrivateDir(path.dirname(resolvedPath));
  ensurePrivateDir(path.join(path.dirname(resolvedPath), BRIDGE_TOKEN_DIR_NAME));
  if (!fs.existsSync(resolvedPath)) {
    saveBridgeAuthRegistry({
      registryPath: resolvedPath,
      registry: normalizeRegistry({ tokens: [] }),
      backup: false,
    });
  }
  return resolvedPath;
}

function readTokenFile(tokenPath) {
  try {
    return fs.readFileSync(tokenPath, "utf8").trim();
  } catch (_) {
    return "";
  }
}

function writeTokenFile(tokenPath, token) {
  writeFileAtomic(tokenPath, `${token}\n`, { mode: PRIVATE_FILE_MODE, backup: false });
}

function ensureClientBridgeToken(options = {}) {
  const {
    userDataPath,
    clientId,
    displayName,
    registryPath,
    scopes = [],
    logger = console,
  } = options;
  assertUserDataPath(userDataPath);
  if (Object.prototype.hasOwnProperty.call(options, "tokenPath")) {
    throw new Error("tokenPath overrides are not supported");
  }
  const requestedClientId = sanitizeClientId(clientId);
  const resolvedRegistryPath = registryPath || getBridgeTokenRegistryPath(userDataPath);
  const normalizedScopes = normalizeRequestedScopes(scopes);
  ensureBridgeAuthRegistry({ userDataPath, registryPath: resolvedRegistryPath });

  const registry = loadBridgeAuthRegistry({ registryPath: resolvedRegistryPath });
  const normalizedClientId = resolveStoredClientId(registry, requestedClientId);
  const resolvedTokenPath = getBridgeClientTokenPath(userDataPath, normalizedClientId);
  const existing = registry.tokens.find(
    (entry) => entry.clientId === normalizedClientId && entry.revoked !== true,
  );
  const existingToken = readTokenFile(resolvedTokenPath);

  if (existing) {
    const refusalReason = !existingToken
      ? "token_file_unavailable"
      : !verifyBridgeTokenHash(existingToken, existing.tokenHash)
        ? "hash_mismatch"
        : null;
    if (refusalReason) {
      logBridgeAuthEvent(logger, "warn", {
        event: "ensure_failed",
        clientId: normalizedClientId,
        reason: refusalReason,
        changed: false,
      });
      throw new Error(
        `Active Host MCP Bridge token ${normalizedClientId} cannot be replaced implicitly; revoke it before reconfiguration`,
      );
    }

    if (!scopesMatch(existing.scopes, normalizedScopes)) {
      const updatedEntry = {
        ...existing,
        tokenFile: resolvedTokenPath,
        scopes: normalizedScopes,
        updatedAt: nowIso(),
      };
      const nextTokens = registry.tokens.map((entry) =>
        entry.clientId === normalizedClientId ? updatedEntry : entry,
      );
      try {
        saveBridgeAuthRegistry({
          registryPath: resolvedRegistryPath,
          registry: {
            ...registry,
            tokens: nextTokens,
          },
        });
      } catch (error) {
        logBridgeAuthEvent(logger, "warn", {
          event: "scope_update_failed",
          clientId: normalizedClientId,
          reason: "registry_write_failed",
          changed: false,
        });
        throw error;
      }
      logBridgeAuthEvent(logger, "info", {
        event: "scope_update",
        clientId: normalizedClientId,
        reason: "scope_changed",
        changed: true,
      });
    }

    return {
      clientId: normalizedClientId,
      displayName: existing.displayName,
      token: existingToken,
      tokenPath: resolvedTokenPath,
      registryPath: resolvedRegistryPath,
      scopes: normalizedScopes,
      created: false,
    };
  }

  const hadRevokedEntry = registry.tokens.some(
    (entry) => entry.clientId === normalizedClientId && entry.revoked === true,
  );
  const token = generateBridgeToken();
  const timestamp = nowIso();
  const entry = {
    clientId: normalizedClientId,
    displayName: isNonEmptyString(displayName) ? displayName.trim() : normalizedClientId,
    tokenHash: hashBridgeToken(token),
    tokenFile: resolvedTokenPath,
    scopes: normalizedScopes,
    createdAt: timestamp,
    updatedAt: timestamp,
    revoked: false,
  };
  const nextTokens = registry.tokens.filter(
    (candidate) => candidate.clientId !== normalizedClientId,
  );
  nextTokens.push(entry);
  nextTokens.sort((left, right) => left.clientId.localeCompare(right.clientId));

  let previousTokenBytes = null;
  if (fs.existsSync(resolvedTokenPath)) {
    previousTokenBytes = fs.readFileSync(resolvedTokenPath);
  }
  writeTokenFile(resolvedTokenPath, token);
  try {
    saveBridgeAuthRegistry({
      registryPath: resolvedRegistryPath,
      registry: {
        ...registry,
        tokens: nextTokens,
      },
    });
  } catch (error) {
    let rollbackSucceeded = true;
    try {
      if (previousTokenBytes === null) {
        fs.rmSync(resolvedTokenPath, { force: true });
      } else {
        writeFileAtomic(resolvedTokenPath, previousTokenBytes, {
          mode: PRIVATE_FILE_MODE,
          backup: false,
        });
      }
    } catch (_) {
      rollbackSucceeded = false;
    }
    logBridgeAuthEvent(logger, "warn", {
      event: "mint_failed",
      clientId: normalizedClientId,
      reason: rollbackSucceeded ? "registry_write_failed" : "rollback_failed",
      changed: !rollbackSucceeded,
    });
    throw error;
  }
  logBridgeAuthEvent(logger, "info", {
    event: "mint",
    clientId: normalizedClientId,
    reason: hadRevokedEntry ? "revoked" : "fresh",
    changed: true,
  });

  return {
    clientId: normalizedClientId,
    displayName: entry.displayName,
    token,
    tokenPath: resolvedTokenPath,
    registryPath: resolvedRegistryPath,
    scopes: normalizedScopes,
    created: true,
  };
}

function ensureScopedBridgeToken(options = {}) {
  return ensureClientBridgeToken(options);
}

function revokeClientBridgeToken(options = {}) {
  const {
    userDataPath,
    clientId,
    registryPath,
    logger = console,
  } = options;
  const requestedClientId = sanitizeClientId(clientId);
  const resolvedRegistryPath = registryPath || getBridgeTokenRegistryPath(userDataPath);
  const registry = loadBridgeAuthRegistry({ registryPath: resolvedRegistryPath });
  const normalizedClientId = resolveStoredClientId(registry, requestedClientId);
  let changed = false;
  for (const entry of registry.tokens) {
    if (entry.clientId === normalizedClientId && entry.revoked !== true) {
      entry.revoked = true;
      entry.updatedAt = nowIso();
      changed = true;
    }
  }
  const tokenPath = getBridgeClientTokenPath(userDataPath, normalizedClientId);
  if (changed) {
    try {
      saveBridgeAuthRegistry({ registryPath: resolvedRegistryPath, registry });
    } catch (error) {
      logBridgeAuthEvent(logger, "warn", {
        event: "revoke_failed",
        clientId: normalizedClientId,
        reason: "registry_write_failed",
        changed: false,
      });
      throw error;
    }
  }
  try {
    fs.rmSync(tokenPath, { force: true });
  } catch (_) {
    logBridgeAuthEvent(logger, "warn", {
      event: "revoke_cleanup_failed",
      clientId: normalizedClientId,
      reason: "token_file_delete_failed",
      changed,
    });
  }
  logBridgeAuthEvent(logger, "info", {
    event: "revoke",
    clientId: normalizedClientId,
    reason: changed ? "explicit" : "already_inactive",
    changed,
  });
  return { success: true, revoked: changed };
}

function getBridgeAuthRedactedStatus({ userDataPath, registryPath } = {}) {
  const resolvedRegistryPath = registryPath || getBridgeTokenRegistryPath(userDataPath);
  const registry = loadBridgeAuthRegistry({ registryPath: resolvedRegistryPath });
  return {
    success: true,
    registryPath: resolvedRegistryPath,
    clients: registry.tokens.map((entry) => ({
      clientId: entry.clientId,
      displayName: entry.displayName,
      configured: entry.revoked !== true && Boolean(entry.tokenHash),
      revoked: entry.revoked === true,
      tokenFileExists: Boolean(entry.tokenFile && fs.existsSync(entry.tokenFile)),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    })),
  };
}

module.exports = {
  BRIDGE_AUTH_DIR_NAME,
  BRIDGE_REGISTRY_FILE_NAME,
  BRIDGE_TOKEN_DIR_NAME,
  generateBridgeToken,
  hashBridgeToken,
  verifyBridgeTokenHash,
  getBridgeAuthDir,
  getBridgeTokenDir,
  getBridgeTokenRegistryPath,
  getBridgeClientTokenPath,
  ensureBridgeAuthRegistry,
  ensureClientBridgeToken,
  ensureScopedBridgeToken,
  loadBridgeAuthRegistry,
  saveBridgeAuthRegistry,
  revokeClientBridgeToken,
  getBridgeAuthRedactedStatus,
  sanitizeClientId,
  writeFileAtomic,
};
