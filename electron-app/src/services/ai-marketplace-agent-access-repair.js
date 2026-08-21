// Repair local OWUI model visibility for marketplace-installed agents.
// State & Persistence layer: one-shot, user-action-triggered repair only.

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const agentLinks = require("./ai-marketplace-agent-links");

const execFilePromise = promisify(execFile);
const DEFAULT_DB_RELATIVE_PATH = path.join("open-webui-data", "webui.db");
const SQLITE_FALLBACK_CANDIDATES = [
  "/opt/homebrew/bin/sqlite3",
  "/usr/local/bin/sqlite3",
  "/opt/homebrew/opt/sqlite/bin/sqlite3",
  "/usr/local/opt/sqlite/bin/sqlite3",
];

function getBootstrap() {
  try {
    return require("./bootstrap");
  } catch {
    return {};
  }
}

function projectRoot(deps = {}) {
  const bootstrap = getBootstrap();
  return deps.projectRoot || bootstrap.PROJECT_ROOT || process.cwd();
}

function defaultDbPath(deps = {}) {
  return deps.dbPath || path.join(projectRoot(deps), DEFAULT_DB_RELATIVE_PATH);
}

function quoteSqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function normalizeLinkedAgentIds(links) {
  return Object.keys(links || {})
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .sort();
}

function summarizeAccessControl(value) {
  if (value === null || value === undefined || value === "") {
    return "empty";
  }
  try {
    const parsed = JSON.parse(String(value));
    const readUsers = Array.isArray(parsed?.read?.user_ids)
      ? parsed.read.user_ids.length
      : 0;
    const readGroups = Array.isArray(parsed?.read?.group_ids)
      ? parsed.read.group_ids.length
      : 0;
    const writeUsers = Array.isArray(parsed?.write?.user_ids)
      ? parsed.write.user_ids.length
      : 0;
    const writeGroups = Array.isArray(parsed?.write?.group_ids)
      ? parsed.write.group_ids.length
      : 0;
    return `read:u${readUsers}:g${readGroups};write:u${writeUsers}:g${writeGroups}`;
  } catch {
    return "non_json";
  }
}

async function resolveSqliteBinary(deps = {}) {
  if (deps.sqliteBinaryPath) return deps.sqliteBinaryPath;
  if (typeof deps.resolveSqliteBinary === "function") {
    return await deps.resolveSqliteBinary();
  }

  try {
    const { stdout } = await execFilePromise("sh", ["-lc", "command -v sqlite3"], {
      cwd: projectRoot(deps),
    });
    const fromPath = String(stdout || "").trim();
    if (fromPath) return fromPath;
  } catch {
    // Fall through to common Homebrew locations.
  }

  for (const candidate of SQLITE_FALLBACK_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("sqlite3 is not available for local agent access repair");
}

async function runSqliteJson(dbPath, sql, deps = {}) {
  if (typeof deps.runSqliteJson === "function") {
    return await deps.runSqliteJson(dbPath, sql);
  }
  const sqlite = await resolveSqliteBinary(deps);
  const { stdout } = await execFilePromise(sqlite, ["-json", dbPath, sql], {
    cwd: projectRoot(deps),
    maxBuffer: 10 * 1024 * 1024,
  });
  const raw = String(stdout || "").trim();
  return raw ? JSON.parse(raw) : [];
}

async function runSqlite(dbPath, sql, deps = {}) {
  if (typeof deps.runSqlite === "function") {
    return await deps.runSqlite(dbPath, sql);
  }
  const sqlite = await resolveSqliteBinary(deps);
  await execFilePromise(sqlite, [dbPath, sql], {
    cwd: projectRoot(deps),
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function repairMarketplaceLinkedAgentAccess(deps = {}) {
  const logger = deps.logger || console;
  const links =
    typeof deps.listLinks === "function"
      ? await deps.listLinks()
      : await agentLinks.listLinks(deps);
  const linkedAgentIds = normalizeLinkedAgentIds(links);
  const reason = deps.reason || "unspecified";
  logger.log?.("[AI Marketplace][agent-access-repair] start", {
    reason,
    linkedAgentCount: linkedAgentIds.length,
    linkedAgentIds,
  });

  if (!linkedAgentIds.length) {
    return { checked: 0, repaired: 0, repairedAgentIds: [], staleAgentIds: [] };
  }

  const dbPath = defaultDbPath(deps);
  if (!fs.existsSync(dbPath)) {
    logger.warn?.("[AI Marketplace][agent-access-repair] skipped missing DB", {
      reason,
      linkedAgentCount: linkedAgentIds.length,
    });
    return {
      checked: linkedAgentIds.length,
      repaired: 0,
      repairedAgentIds: [],
      staleAgentIds: [],
      skipped: "db_missing",
    };
  }

  const idList = linkedAgentIds.map(quoteSqlString).join(", ");
  const rows = await runSqliteJson(
    dbPath,
    `SELECT id, access_control FROM model WHERE id IN (${idList}) AND access_control IS NOT NULL AND TRIM(access_control) != '';`,
    deps,
  );
  const staleAgentIds = (Array.isArray(rows) ? rows : [])
    .map((row) => String(row?.id || "").trim())
    .filter(Boolean)
    .sort();

  logger.log?.("[AI Marketplace][agent-access-repair] inspected", {
    reason,
    checked: linkedAgentIds.length,
    staleAgentIds,
    accessControlSummaries: Object.fromEntries(
      (Array.isArray(rows) ? rows : []).map((row) => [
        String(row?.id || ""),
        summarizeAccessControl(row?.access_control),
      ]),
    ),
  });

  if (!staleAgentIds.length) {
    return { checked: linkedAgentIds.length, repaired: 0, repairedAgentIds: [], staleAgentIds };
  }

  await runSqlite(
    dbPath,
    `UPDATE model SET access_control = NULL WHERE id IN (${staleAgentIds.map(quoteSqlString).join(", ")});`,
    deps,
  );

  logger.log?.("[AI Marketplace][agent-access-repair] repaired", {
    reason,
    repaired: staleAgentIds.length,
    repairedAgentIds: staleAgentIds,
  });

  return {
    checked: linkedAgentIds.length,
    repaired: staleAgentIds.length,
    repairedAgentIds: staleAgentIds,
    staleAgentIds,
  };
}

module.exports = {
  DEFAULT_DB_RELATIVE_PATH,
  normalizeLinkedAgentIds,
  quoteSqlString,
  repairMarketplaceLinkedAgentAccess,
  summarizeAccessControl,
};
