const fs = require("fs");
const fsPromises = fs.promises;
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");
const {
  DEFAULT_MARKETPLACE_CONFIG,
  ensureBundledMarketplaceDefaults,
  isOotbSeededInstall,
  listOotbSeededKeys,
  normalizeMarketplacesConfig: normalizeBaseMarketplacesConfig,
  readInstalledSkillVersion,
} = require("./marketplace-ootb");
const {
  formatSkillDisplayName,
  getSkillVersionFromFrontmatter,
  parseSkillMarkdownFrontmatter,
} = require("./skill-frontmatter");
const { solutionFreshnessStamp } = require("./ai-marketplace-freshness");
const {
  GITLAB_MARKETPLACE_AUTH_CONFIG,
} = require("../config/gitlab-marketplace-auth-config");
const {
  assertMarketplaceSourceAllowed,
  isAllowedMarketplaceSource,
} = require("./marketplace-allowlist");
const {
  logMarketplaceDiag,
  safeErrorMeta,
} = require("./marketplace-diagnostics");
const { createWriteLock } = require("./serial-write-lock");

const execFilePromise = promisify(execFile);
const NETWORK_TIMEOUT_MS = 30000;
// Best-effort probes (head-commit checks) fail fast: their failure just means
// "no short-circuit, do the full download", so waiting the full 30s only
// delays the fallback. Download legs keep NETWORK_TIMEOUT_MS.
const HEAD_PROBE_TIMEOUT_MS = 8000;
const MARKETPLACE_MANIFEST_PATH = ".atlas-plugin/marketplace.json";
const PLUGIN_METADATA_PATH = ".atlas-plugin/plugin.json";
const SPARSE_SKILL_ROOTS = ["skills", ".atlas/skills"];
const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_API_HOST = "api.github.com";
const GITHUB_REPO_HOST = "github.com";
const GITHUB_CODELOAD_HOST = "codeload.github.com";
const GITHUB_RAW_HOST = "raw.githubusercontent.com";
const AI_MARKETPLACE_SKILL_SOURCE_ID = "ai-marketplace";

function createMarketplaceError(message, code = "marketplace_error", extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function toPosixPath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function compactObject(object) {
  return Object.fromEntries(
    Object.entries(object || {}).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
}

function normalizeSkillPath(skillPath) {
  const normalized = toPosixPath(String(skillPath || "./").trim() || "./");
  if (normalized === "." || normalized === "") {
    return "./";
  }
  if (normalized.startsWith("./")) {
    return normalized;
  }
  if (normalized.startsWith("/")) {
    return `.${normalized}`;
  }
  return `./${normalized}`;
}

function trimRepoRelativePath(value) {
  return toPosixPath(String(value || ""))
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/g, "");
}

function joinSkillPath(baseSkillPath, relativeSkillPath = "") {
  const base = trimRepoRelativePath(normalizeSkillPath(baseSkillPath));
  const relative = trimRepoRelativePath(relativeSkillPath);
  return normalizeSkillPath([base, relative].filter(Boolean).join("/"));
}

// True when any repo-relative changed path falls inside the skill's
// directory. skillPath is the stored "./dir" form; "./" (repo-root skill)
// matches any change at all.
function skillDirTouched(changedPaths, skillPath) {
  const dir = trimRepoRelativePath(normalizeSkillPath(skillPath));
  if (dir === "") return changedPaths.size > 0;
  for (const changedPath of changedPaths) {
    if (changedPath === dir || changedPath.startsWith(`${dir}/`)) return true;
  }
  return false;
}

function deriveSkillId(skillPath) {
  const parts = normalizeSkillPath(skillPath)
    .replace(/^\.\//, "")
    .split("/")
    .filter(Boolean);
  return parts[parts.length - 1] || "skill";
}

function canonicalSkillId(value) {
  const parts = toPosixPath(String(value || ""))
    .trim()
    .split("/")
    .filter(Boolean);
  return parts.at(-1) || "";
}

function formatDisplayName(name) {
  return String(name || "")
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function arrayShallowEqual(left, right) {
  if (left === right) {
    return true;
  }
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

// Uniqueness key for installed records is the FULL identity triple: the same
// leaf id may exist in two different plugins of one marketplace.
function installedSkillKey(entry) {
  return `${entry?.marketplaceId || ""}\u0000${entry?.pluginName || ""}\u0000${entry?.skillId || ""}`;
}

// Plugin directory names are the only path segment that does not come from
// our own id sanitizers; anything unsafe degrades that plugin's skills to the
// flat layout instead of ever reaching the filesystem.
function safePluginSegment(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function normalizeInstalledPluginName(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function installedSkillLocalPath(marketplaceId, pluginName, skillId) {
  return pluginName
    ? `skills-marketplace/${marketplaceId}/${pluginName}/${skillId}`
    : `skills-marketplace/${marketplaceId}/${skillId}`;
}

// Locate an installed record by its identity triple. A null pluginName is the
// legacy form: it resolves when it matches exactly one record for that
// (marketplace, leaf) pair, preferring the flat record when both layouts
// coexist.
function findInstalledSkillRecordIndex(installedSkills, { marketplaceId, skillId, pluginName = null }) {
  const list = Array.isArray(installedSkills) ? installedSkills : [];
  const normalizedPlugin = normalizeInstalledPluginName(pluginName);
  if (normalizedPlugin) {
    return list.findIndex(
      (entry) =>
        entry?.marketplaceId === marketplaceId &&
        entry?.skillId === skillId &&
        normalizeInstalledPluginName(entry?.pluginName) === normalizedPlugin,
    );
  }

  const matches = [];
  list.forEach((entry, index) => {
    if (entry?.marketplaceId === marketplaceId && entry?.skillId === skillId) {
      matches.push({ entry, index });
    }
  });
  if (matches.length === 0) {
    return -1;
  }
  const flat = matches.find(({ entry }) => !normalizeInstalledPluginName(entry?.pluginName));
  if (flat) {
    return flat.index;
  }
  return matches.length === 1 ? matches[0].index : -2;
}

function getPluginSourcePath(plugin) {
  if (typeof plugin?.source === "string") {
    return normalizeSkillPath(plugin.source);
  }
  if (
    plugin?.source &&
    typeof plugin.source === "object" &&
    typeof plugin.source.path === "string"
  ) {
    return normalizeSkillPath(plugin.source.path);
  }
  return "./";
}

function normalizePluginSourcePath(plugin, normalizedSkillPath) {
  if (!plugin || typeof plugin !== "object") {
    return plugin;
  }

  if (typeof plugin.source === "string") {
    if (normalizeSkillPath(plugin.source) === normalizedSkillPath) {
      return plugin;
    }
    return {
      ...plugin,
      source: normalizedSkillPath,
    };
  }

  if (
    plugin.source &&
    typeof plugin.source === "object" &&
    typeof plugin.source.path === "string"
  ) {
    if (normalizeSkillPath(plugin.source.path) === normalizedSkillPath) {
      return plugin;
    }
    return {
      ...plugin,
      source: {
        ...plugin.source,
        path: normalizedSkillPath,
      },
    };
  }

  return plugin;
}

function validateUniqueSkillIds(skillPaths, { marketplaceName, pluginName, errorCode }) {
  const seenSkillIds = new Map();
  for (const skillPath of skillPaths) {
    const skillId = deriveSkillId(skillPath);
    const existingPath = seenSkillIds.get(skillId);
    if (existingPath && existingPath !== skillPath) {
      throw createMarketplaceError(
        `Marketplace "${marketplaceName}" plugin "${pluginName}" contains duplicate skill id "${skillId}" at ${existingPath} and ${skillPath}`,
        errorCode,
      );
    }
    seenSkillIds.set(skillId, skillPath);
  }
}

function getMarketplaceConfigPath(projectRoot) {
  return path.join(projectRoot, "marketplaces.json");
}

function normalizeStoredMarketplaceSource(source) {
  if (!source || typeof source !== "object") {
    return source || null;
  }

  try {
    return normalizeMarketplaceSourceInput(source, {
      allowDirectUrlSource: true,
      allowSparseFileUrl: true,
    });
  } catch {
    return source;
  }
}

function normalizeStoredMarketplaceEntry(entry) {
  const normalized = { ...(entry || {}) };
  normalized.source = normalizeStoredMarketplaceSource(entry?.source);
  normalized.isSparse = entry?.isSparse === true;
  normalized.manifestSource =
    entry?.manifestSource ||
    (normalized.isSparse ? "plugin-json" : "marketplace-json");
  return normalized;
}

function normalizeStoredManagedFileEntry(entry) {
  const relativePath = trimRepoRelativePath(entry?.path);
  const sha256 =
    typeof entry?.sha256 === "string" && entry.sha256.trim()
      ? entry.sha256.trim()
      : null;

  if (!relativePath || !sha256) {
    return null;
  }

  return {
    path: relativePath,
    sha256,
  };
}

function normalizeStoredBaseline(baseline) {
  if (!baseline || typeof baseline !== "object") {
    return null;
  }

  const files = Array.isArray(baseline.files)
    ? baseline.files
        .map(normalizeStoredManagedFileEntry)
        .filter(Boolean)
        .sort((left, right) => left.path.localeCompare(right.path))
    : [];

  return compactObject({
    generatedAt:
      typeof baseline.generatedAt === "string" && baseline.generatedAt.trim()
        ? baseline.generatedAt.trim()
        : undefined,
    version:
      typeof baseline.version === "string" && baseline.version.trim()
        ? baseline.version.trim()
        : undefined,
    sourceRef:
      typeof baseline.sourceRef === "string" && baseline.sourceRef.trim()
        ? baseline.sourceRef.trim()
        : undefined,
    files,
  });
}

function normalizeStoredInstalledSkill(entry) {
  const normalized = { ...(entry || {}) };
  normalized.skillSource = normalizeStoredMarketplaceSource(entry?.skillSource);
  normalized.baseline = normalizeStoredBaseline(entry?.baseline);
  normalized.pluginName = normalizeInstalledPluginName(entry?.pluginName);
  return normalized;
}

function normalizeMarketplacesConfig(config) {
  const normalized = normalizeBaseMarketplacesConfig(config);
  normalized.marketplaces = normalized.marketplaces.map(normalizeStoredMarketplaceEntry);
  normalized.installedSkills = normalized.installedSkills.map(normalizeStoredInstalledSkill);
  return normalized;
}

async function loadMarketplacesConfig(projectRoot, { logger = console } = {}) {
  const result = await reconcileMarketplaceState(projectRoot, { logger });
  const config = normalizeMarketplacesConfig(result?.config);
  await hydrateInstalledSkillStates(projectRoot, config, { logger });
  return config;
}

function stripTransientInstalledSkillState(entry) {
  const normalized = normalizeStoredInstalledSkill(entry);
  delete normalized.isDirty;
  delete normalized.hasConflict;
  return normalized;
}

function configForPersistence(config) {
  const normalized = normalizeMarketplacesConfig(config);
  normalized.installedSkills = normalized.installedSkills.map(
    stripTransientInstalledSkillState,
  );
  return normalized;
}

async function saveMarketplacesConfig(projectRoot, config) {
  const configPath = getMarketplaceConfigPath(projectRoot);
  await fsPromises.mkdir(path.dirname(configPath), { recursive: true });
  const persistedConfig = configForPersistence(config);
  // Stage + rename (same-directory) so a crash mid-write can never leave a
  // truncated marketplaces.json — load-time migrations made rewrites of this
  // file routine and much larger.
  const stagingPath = path.join(
    path.dirname(configPath),
    `.${path.basename(configPath)}.stage-${crypto.randomUUID()}`,
  );
  try {
    await fsPromises.writeFile(
      stagingPath,
      `${JSON.stringify(persistedConfig, null, 2)}\n`,
      "utf8",
    );
    await fsPromises.rename(stagingPath, configPath);
  } catch (error) {
    logMarketplaceDiag("registry", "save:failed", safeErrorMeta(error), "error");
    throw error;
  } finally {
    await fsPromises.rm(stagingPath, { force: true }).catch(() => {});
  }
}

// Serialize read-modify-write cycles for marketplaces.json. Concurrent
// mutations otherwise lose each other's updates: each loads the same base
// config and the last save wins (26 parallel chat installs once kept 1 of 26
// installedSkills records). Reads stay lock-free — saveMarketplacesConfig
// stages + renames, so a reader always sees a complete file. Discipline: a
// locked function must never call another locked function, and a locked body
// must never await withMarketplaceInstallLock (ai-marketplace-operations.js)
// — native installs hold that outer lock and enter this one, so the reverse
// order would deadlock. Known residual: the one-shot migration save inside
// loadMarketplacesConfig/reconcileMarketplaceState stays lock-free (wrapping
// it would deadlock every locked mutator that loads the config); it is
// idempotent and re-applies on the next load if a locked save overwrites it.
// Same pattern as ai-marketplace-skill-links.js (PORTICO-317).
const withRegistryWriteLock = createWriteLock();

async function pathHasRootSkill(skillDir) {
  try {
    const stat = await fsPromises.stat(path.join(skillDir, "SKILL.md"));
    return stat.isFile();
  } catch {
    return false;
  }
}

async function listRelativeFiles(rootDir, currentDir = rootDir, files = []) {
  let entries;
  try {
    entries = await fsPromises.readdir(currentDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return files;
    }
    throw error;
  }

  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (entry.name === ".DS_Store") {
      continue;
    }

    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await listRelativeFiles(rootDir, absolutePath, files);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    files.push(trimRepoRelativePath(path.relative(rootDir, absolutePath)));
  }

  return files;
}

async function snapshotSkillDirectory(skillDir) {
  const relativeFiles = await listRelativeFiles(skillDir);
  const snapshot = [];

  for (const relativePath of relativeFiles) {
    const absolutePath = path.join(skillDir, ...relativePath.split("/"));
    const content = await fsPromises.readFile(absolutePath);
    snapshot.push({
      path: relativePath,
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
    });
  }

  snapshot.sort((left, right) => left.path.localeCompare(right.path));
  return snapshot;
}

function snapshotsDiffer(leftFiles, rightFiles) {
  if (!Array.isArray(leftFiles) || !Array.isArray(rightFiles)) {
    return false;
  }
  if (leftFiles.length !== rightFiles.length) {
    return true;
  }

  const rightLookup = new Map(
    rightFiles
      .map(normalizeStoredManagedFileEntry)
      .filter(Boolean)
      .map((entry) => [entry.path, entry.sha256]),
  );

  for (const entry of leftFiles.map(normalizeStoredManagedFileEntry).filter(Boolean)) {
    if (rightLookup.get(entry.path) !== entry.sha256) {
      return true;
    }
  }

  return false;
}

async function buildInstalledSkillBaseline(skillDir, options = {}) {
  return compactObject({
    generatedAt: new Date().toISOString(),
    version:
      typeof options.installedVersion === "string" && options.installedVersion.trim()
        ? options.installedVersion.trim()
        : undefined,
    sourceRef:
      typeof options.sourceRef === "string" && options.sourceRef.trim()
        ? options.sourceRef.trim()
        : undefined,
    files: await snapshotSkillDirectory(skillDir),
  });
}

async function replaceSkillDirectoryFromStaging(destinationPath, stagingPath) {
  const parentDirectory = path.dirname(destinationPath);
  const backupPath = path.join(
    parentDirectory,
    `.${path.basename(destinationPath)}.sync-backup-${crypto.randomUUID()}`,
  );
  let originalMoved = false;
  let replacementMoved = false;
  let completed = false;

  await fsPromises.mkdir(parentDirectory, { recursive: true });

  try {
    try {
      await fsPromises.rename(destinationPath, backupPath);
      originalMoved = true;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    await fsPromises.rename(stagingPath, destinationPath);
    replacementMoved = true;
    completed = true;
  } catch (error) {
    if (replacementMoved) {
      await fsPromises.rm(destinationPath, { recursive: true, force: true }).catch(() => {});
    }

    if (originalMoved) {
      try {
        await fsPromises.rename(backupPath, destinationPath);
        originalMoved = false;
      } catch (rollbackError) {
        throw createMarketplaceError(
          `Failed to replace installed skill and restore its previous files: ${error.message}; rollback failed: ${rollbackError.message}`,
          "marketplace_skill_replace_failed",
          { backupPath },
        );
      }
    }

    throw error;
  } finally {
    await fsPromises.rm(stagingPath, { recursive: true, force: true }).catch(() => {});
    if (completed && originalMoved) {
      await fsPromises.rm(backupPath, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function upsertInstalledSkillRecord(options) {
  return withRegistryWriteLock(() => upsertInstalledSkillRecordUnlocked(options));
}

async function upsertInstalledSkillRecordUnlocked({
  projectRoot,
  logger = console,
  ...fields
}) {
  const config = await loadMarketplacesConfig(projectRoot, { logger });
  const { record, inserted } = await applyInstalledSkillUpsertToConfig(
    projectRoot,
    config,
    fields,
  );
  await saveMarketplacesConfig(projectRoot, config);
  logger.log?.(
    `[Marketplace] installed-skill record ${inserted ? "inserted" : "updated"}: ${record.marketplaceId}/${record.skillId}`,
  );
  return record;
}

// Record-construction core shared by the locked single upsert above and the
// startup integrity pass's bulk adoption: mutates config.installedSkills in
// place; callers own load/save/locking.
async function applyInstalledSkillUpsertToConfig(
  projectRoot,
  config,
  {
    marketplaceId,
    skillId,
    localPath,
    skillPath = "./",
    skillSource = null,
    pluginName = null,
    installedVersion = "",
    sourceRef = "",
    installedAt = new Date().toISOString(),
    remoteUpdatedAt = undefined,
    contentHeadSha = undefined,
  },
) {
  const normalizedLocalPath = trimRepoRelativePath(localPath);
  const normalizedPluginName = normalizeInstalledPluginName(pluginName);
  if (!marketplaceId || !skillId || !normalizedLocalPath) {
    throw createMarketplaceError(
      "Installed skill record is missing marketplace id, skill id, or local path",
      "installed_skill_invalid",
    );
  }

  const destinationPath = path.join(projectRoot, normalizedLocalPath);
  const resolvedInstalledVersion =
    typeof installedVersion === "string" && installedVersion.trim()
      ? installedVersion.trim()
      : await readInstalledSkillVersion(destinationPath, "1.0");
  const baseline = await buildInstalledSkillBaseline(destinationPath, {
    installedVersion: resolvedInstalledVersion,
    sourceRef,
  });

  // Identity is the exact triple: a plugin-scoped record never adopts (or
  // clobbers) a coexisting flat record for the same leaf id.
  const existingIndex = (config.installedSkills || []).findIndex(
    (entry) =>
      entry.marketplaceId === marketplaceId &&
      entry.skillId === skillId &&
      normalizeInstalledPluginName(entry.pluginName) === normalizedPluginName,
  );
  const existing = existingIndex >= 0 ? config.installedSkills[existingIndex] : null;
  const nextRecord = {
    ...(existing || {}),
    marketplaceId,
    skillId,
    pluginName: normalizedPluginName,
    skillPath: normalizeSkillPath(skillPath),
    skillSource,
    installedAt: existing?.installedAt || installedAt,
    installedVersion: resolvedInstalledVersion,
    localPath: normalizedLocalPath,
    lastCheckedVersion: resolvedInstalledVersion,
    hasUpdate: false,
    // Solutions installs: the listing's updated_at at (re)install time — the
    // update-available baseline, compared marketplace-clock to itself.
    remoteUpdatedAt:
      remoteUpdatedAt !== undefined && remoteUpdatedAt !== null
        ? remoteUpdatedAt
        : (existing?.remoteUpdatedAt ?? null),
    baseline,
    // Git installs: repo head sha the content was fetched at — the
    // content-drift baseline for the freshness sweep's changed-paths
    // compare. Absent param (e.g. adoption re-upserts) keeps any existing
    // stamp via the leading spread.
    ...(contentHeadSha ? { contentHeadSha } : {}),
  };
  // Fresh content was just written: a drift date persisted alongside an old
  // hasUpdate flag no longer applies (mirrors the hasUpdate: false above,
  // which the leading `...existing` spread would otherwise smuggle past).
  delete nextRecord.updateHeadCommittedAt;

  if (existingIndex >= 0) {
    config.installedSkills[existingIndex] = nextRecord;
  } else {
    config.installedSkills.push(nextRecord);
  }

  return { record: nextRecord, inserted: existingIndex < 0 };
}

// Locked bulk removal for callers that used to run their own unlocked
// load→filter→save (ipc.js deleteSkill, install rollback). Matches by exact
// identity triple and/or by the record's own localPath.
function removeInstalledSkillRecords(
  projectRoot,
  { identities = null, localPaths = null } = {},
  { logger = console } = {},
) {
  const identityKey = (marketplaceId, skillId, pluginName) =>
    `${marketplaceId}\u0000${skillId}\u0000${normalizeInstalledPluginName(pluginName) || ""}`;
  return withRegistryWriteLock(async () => {
    const config = await loadMarketplacesConfig(projectRoot, { logger });
    const identitySet = Array.isArray(identities)
      ? new Set(
          identities
            .filter((entry) => entry?.marketplaceId && entry?.skillId)
            .flatMap((entry) =>
              entry.pluginName === undefined
                ? // No pluginName given: match the pair across every plugin scope.
                  [`${entry.marketplaceId}\u0000${entry.skillId}\u0000*`]
                : [identityKey(entry.marketplaceId, entry.skillId, entry.pluginName)],
            ),
        )
      : null;
    const pathSet = Array.isArray(localPaths)
      ? new Set(localPaths.map((value) => trimRepoRelativePath(value)).filter(Boolean))
      : null;
    const before = config.installedSkills.length;
    config.installedSkills = config.installedSkills.filter((entry) => {
      if (identitySet) {
        if (
          identitySet.has(
            identityKey(entry.marketplaceId, entry.skillId, entry.pluginName),
          ) ||
          identitySet.has(`${entry.marketplaceId}\u0000${entry.skillId}\u0000*`)
        ) {
          return false;
        }
      }
      if (pathSet && pathSet.has(trimRepoRelativePath(entry.localPath || ""))) {
        return false;
      }
      return true;
    });
    const removed = before - config.installedSkills.length;
    if (removed > 0) {
      await saveMarketplacesConfig(projectRoot, config);
    }
    return { removed };
  });
}

async function getInstalledAiMarketplaceSkillSource({
  projectRoot,
  skillId,
  logger = console,
}) {
  const canonicalId = canonicalSkillId(skillId);
  if (!projectRoot || !canonicalId) return null;

  const config = await loadMarketplacesConfig(projectRoot, { logger });
  const installedSkill = (config.installedSkills || []).find(
    (entry) =>
      entry?.marketplaceId === AI_MARKETPLACE_SKILL_SOURCE_ID &&
      canonicalSkillId(entry?.skillId) === canonicalId,
  );
  const source = installedSkill?.skillSource;
  const solutionId =
    source?.type === "ai-marketplace-solution" &&
    typeof source?.solutionId === "string"
      ? source.solutionId.trim()
      : "";
  if (!solutionId) return null;

  return {
    marketplaceId: AI_MARKETPLACE_SKILL_SOURCE_ID,
    skillId: canonicalId,
    solutionId,
    solutionName:
      typeof source?.solutionName === "string" && source.solutionName.trim()
        ? source.solutionName.trim()
        : null,
    detailUrl:
      typeof source?.detailUrl === "string" && source.detailUrl.trim()
        ? source.detailUrl.trim()
        : null,
  };
}

async function computeInstalledSkillState(projectRoot, installed) {
  const baselineFiles = Array.isArray(installed?.baseline?.files)
    ? installed.baseline.files
    : [];
  const localPath =
    typeof installed?.localPath === "string" && installed.localPath.trim()
      ? installed.localPath.trim()
      : null;

  if (!localPath || baselineFiles.length === 0) {
    return {
      isDirty: false,
      hasConflict: false,
    };
  }

  const absoluteSkillDir = path.join(projectRoot, localPath);
  const actualFiles = await snapshotSkillDirectory(absoluteSkillDir);
  const isDirty = snapshotsDiffer(actualFiles, baselineFiles);

  return {
    isDirty,
    hasConflict: isDirty && Boolean(installed?.hasUpdate),
  };
}

async function hydrateInstalledSkillStates(
  projectRoot,
  config,
  { logger = console, marketplaceId = null } = {},
) {
  if (!Array.isArray(config?.installedSkills) || config.installedSkills.length === 0) {
    return;
  }

  for (const installed of config.installedSkills) {
    // Scoped hydration (details fast path) hashes only the one marketplace's
    // installs instead of every install on disk.
    if (marketplaceId && installed?.marketplaceId !== marketplaceId) {
      continue;
    }
    try {
      const state = await computeInstalledSkillState(projectRoot, installed);
      installed.isDirty = state.isDirty;
      installed.hasConflict = state.hasConflict;
    } catch (error) {
      logger.warn?.(
        `[Marketplace] Failed to compute install state for ${installed?.marketplaceId || "unknown"}/${installed?.skillId || "unknown"}: ${error.message}`,
      );
      installed.isDirty = false;
      installed.hasConflict = false;
    }
  }
}

async function removeDirectoryIfEmpty(directoryPath) {
  try {
    const entries = await fsPromises.readdir(directoryPath);
    if (entries.length === 0) {
      await fsPromises.rmdir(directoryPath);
    }
  } catch {
    // Ignore missing or non-empty directories.
  }
}

function sanitizeUserSkillDirectoryName(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/[\\/]/g, "-")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^\.+/, "")
    .replace(/^-+|-+$/g, "");
  return normalized || "skill";
}

// Find a free directory name under skills-user/: preferredName, then the
// fallback, then fallback+suffix, then fallback+suffix-2, -3, ...
async function resolveUniqueUserSkillDirectoryName(
  projectRoot,
  preferredName,
  fallbackName,
  suffix = "-detached",
) {
  const candidates = [];
  if (preferredName) {
    candidates.push(sanitizeUserSkillDirectoryName(preferredName));
  }

  const fallback = sanitizeUserSkillDirectoryName(fallbackName);
  candidates.push(fallback);
  candidates.push(`${fallback}${suffix}`);

  for (const candidate of candidates.filter(Boolean)) {
    const absolutePath = path.join(projectRoot, "skills-user", candidate);
    try {
      await fsPromises.access(absolutePath);
    } catch (error) {
      if (error.code === "ENOENT") {
        return candidate;
      }
      throw error;
    }
  }

  let counter = 2;
  while (true) {
    const candidate = `${fallback}${suffix}-${counter}`;
    const absolutePath = path.join(projectRoot, "skills-user", candidate);
    try {
      await fsPromises.access(absolutePath);
      counter += 1;
    } catch (error) {
      if (error.code === "ENOENT") {
        return candidate;
      }
      throw error;
    }
  }
}

async function resolveDetachedSkillTargetName(projectRoot, preferredName, fallbackName) {
  return resolveUniqueUserSkillDirectoryName(
    projectRoot,
    preferredName,
    fallbackName,
    "-detached",
  );
}

function incrementCount(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function decrementCount(map, key) {
  const nextValue = (map.get(key) || 0) - 1;
  if (nextValue > 0) {
    map.set(key, nextValue);
    return;
  }
  map.delete(key);
}

async function migrateInstalledBundleSkill(
  projectRoot,
  installed,
  { logger = console, isKeyOccupied = () => false } = {},
) {
  if (!installed?.localPath || !installed?.marketplaceId || !installed?.skillId) {
    return { changed: false, entries: [installed] };
  }

  const bundleDir = path.join(projectRoot, installed.localPath);
  if (await pathHasRootSkill(bundleDir)) {
    return { changed: false, entries: [installed] };
  }

  let nestedSkillPaths;
  try {
    nestedSkillPaths = (await discoverSkillPathsFromRepositorySubtree(bundleDir)).filter(
      (skillPath) => skillPath !== "./",
    );
  } catch (error) {
    logger.warn?.(
      `[Marketplace] Failed to inspect installed bundle ${installed.localPath}: ${error.message}`,
    );
    return { changed: false, entries: [installed] };
  }

  if (nestedSkillPaths.length === 0) {
    return { changed: false, entries: [installed] };
  }

  try {
    validateUniqueSkillIds(nestedSkillPaths, {
      marketplaceName: installed.marketplaceId,
      pluginName: installed.skillId,
      errorCode: "marketplace_duplicate_skill_id",
    });
  } catch (error) {
    logger.warn?.(
      `[Marketplace] Skipping bundle migration for ${installed.localPath}: ${error.message}`,
    );
    return { changed: false, entries: [installed] };
  }

  const migratedEntries = [];
  const createdDestinations = [];
  const plannedEntries = nestedSkillPaths.map((relativeSkillPath) => {
    const skillId = deriveSkillId(relativeSkillPath);
    return {
      ...installed,
      skillId,
      skillPath: joinSkillPath(installed.skillPath || "./", relativeSkillPath),
      localPath: `skills-marketplace/${installed.marketplaceId}/${skillId}`,
      _relativeSkillPath: relativeSkillPath,
    };
  });

  if (plannedEntries.some((entry) => isKeyOccupied(installedSkillKey(entry)))) {
    logger.warn?.(
      `[Marketplace] Skipping bundle migration for ${installed.localPath}: destination skill id already exists`,
    );
    return { changed: false, entries: [installed] };
  }

  try {
    for (const plannedEntry of plannedEntries) {
      const sourceDir = path.join(
        bundleDir,
        ...trimRepoRelativePath(plannedEntry._relativeSkillPath).split("/").filter(Boolean),
      );
      const destinationPath = path.join(projectRoot, plannedEntry.localPath);
      const destinationHasSkill = await pathHasRootSkill(destinationPath);

      if (!destinationHasSkill) {
        try {
          await fsPromises.access(destinationPath);
          throw createMarketplaceError(
            `Destination ${plannedEntry.localPath} already exists without a root SKILL.md`,
            "marketplace_install_conflict",
          );
        } catch (error) {
          if (error.code !== "ENOENT") {
            throw error;
          }
        }

        await fsPromises.mkdir(path.dirname(destinationPath), { recursive: true });
        await fsPromises.cp(sourceDir, destinationPath, { recursive: true });
        createdDestinations.push(destinationPath);
      }

      const installedVersion = await readInstalledSkillVersion(destinationPath, "1.0");
      migratedEntries.push({
        ...plannedEntry,
        installedVersion,
        lastCheckedVersion: installedVersion,
        hasUpdate: false,
      });
    }

    await fsPromises.rm(bundleDir, { recursive: true, force: true });
    return {
      changed: true,
      entries: migratedEntries.map(({ _relativeSkillPath, ...entry }) => entry),
    };
  } catch (error) {
    for (const destinationPath of createdDestinations.reverse()) {
      await fsPromises.rm(destinationPath, { recursive: true, force: true }).catch(() => {});
    }
    logger.warn?.(
      `[Marketplace] Failed to migrate installed bundle ${installed.localPath}: ${error.message}`,
    );
    return { changed: false, entries: [installed] };
  }
}

// Decide whether a flat installed record belongs to a plugin per its
// marketplace's cachedManifest, without touching the filesystem. Returns
// { pluginName } when it should migrate, or { skipReason } otherwise.
function planInstalledPluginMigration(installed, marketplacesById) {
  if (!installed?.localPath || !installed?.marketplaceId || !installed?.skillId) {
    return { skipReason: "invalid-record" };
  }
  if (normalizeInstalledPluginName(installed.pluginName)) {
    return { skipReason: "already-plugin" };
  }
  if (
    installed.marketplaceId === AI_MARKETPLACE_SKILL_SOURCE_ID ||
    installed?.skillSource?.type === "ai-marketplace-solution"
  ) {
    return { skipReason: "solutions" };
  }
  const marketplace = marketplacesById.get(installed.marketplaceId);
  if (!marketplace) {
    return { skipReason: "no-marketplace-entry" };
  }
  if (marketplace.isSparse === true) {
    return { skipReason: "sparse" };
  }

  const normalizedSkillPath = normalizeSkillPath(installed.skillPath || "./");
  const matches = [];
  for (const plugin of marketplace.cachedManifest?.plugins || []) {
    if (!plugin || !Array.isArray(plugin.skills)) {
      continue;
    }
    if (plugin.skills.some((skillPath) => normalizeSkillPath(skillPath) === normalizedSkillPath)) {
      matches.push(plugin);
    }
  }
  if (matches.length === 0) {
    return { skipReason: "no-plugin-match" };
  }
  if (matches.length > 1) {
    return { skipReason: "ambiguous-plugin-match" };
  }
  const pluginName =
    typeof matches[0].name === "string" ? matches[0].name.trim() : "";
  if (!pluginName || !safePluginSegment(pluginName)) {
    return { skipReason: "unsafe-plugin-name" };
  }
  return { pluginName };
}

// Nested-destination staging name: deterministic (no uuid) so a later load
// can find and finish an interrupted move, dot-prefixed so every scanner
// (IPC disk scan, adoption scan, Rust catalog, agent-VM env ids) ignores it,
// and distinct from the ".{name}.ootb-seed-" sweep prefix so nothing else
// deletes it. Shared by migrate AND repair: a crash in either is recovered
// by whichever runs first on the next load.
function nestedMoveStagingPath(sourceDir, skillId) {
  return path.join(path.dirname(sourceDir), `.${skillId}.plugin-migrate`);
}

function isPathInsideOrEqual(childPath, parentPath) {
  const relativePath = path.relative(parentPath, childPath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

// Move a root-skill directory to a destination that sits INSIDE it (a plugin
// named exactly like its skill leaf, e.g. <mp>/a11y -> <mp>/a11y/a11y).
// Copy-then-delete is impossible in this shape: fs.cp refuses with
// ERR_FS_CP_EINVAL, and a copy that DID land inside the source would be
// deleted along with it by the source cleanup. So this path moves via two
// atomic same-volume renames through the deterministic staging sibling —
// the staged payload is always complete (same inodes, never partial), and a
// crash between the renames is finished by this same function on the next
// config load. (Case-insensitive filesystems could route a distinct-case
// pair here; the end state matches the cp path's, so that is safe.)
// Statuses:
//   moved          — payload now at destinationDir ({resumed} after a crash)
//   completed      — a previous/concurrent run already finished; the record
//                    needs rewriting but the filesystem is already right
//   source-missing — no root skill at source, staging, or destination
//   failed         — {rollbackOk}: true = source restored untouched; false =
//                    payload parked in staging for the next load's recovery
async function moveNestedSkillDirectory(sourceDir, destinationDir, stagingDir) {
  const finishFromStaging = async () => {
    await fsPromises.mkdir(path.dirname(destinationDir), { recursive: true });
    await fsPromises.rename(stagingDir, destinationDir);
  };

  if (!(await pathHasRootSkill(sourceDir))) {
    // Recovery arms, reads first: resume a parked move, then adopt a
    // finished one.
    if (await pathHasRootSkill(stagingDir)) {
      try {
        await finishFromStaging();
        return { status: "moved", resumed: true };
      } catch (error) {
        if (await pathHasRootSkill(destinationDir)) {
          return { status: "completed" };
        }
        // Staging stays parked — the next load retries this same arm.
        return { status: "failed", rollbackOk: false, error };
      }
    }
    if (await pathHasRootSkill(destinationDir)) {
      return { status: "completed" };
    }
    return { status: "source-missing" };
  }

  // The authoritative payload is present, so any staging dir here is stale
  // (a crash followed by an external restore/reinstall) and its name must be
  // free for the rename. This is the ONLY payload deletion in this flow, and
  // it is gated on the source being a real root skill — a concurrent mover's
  // staging dir can be the SOLE copy and must never match this arm.
  await fsPromises.rm(stagingDir, { recursive: true, force: true });

  try {
    await fsPromises.rename(sourceDir, stagingDir);
  } catch (error) {
    if (!(await pathHasRootSkill(sourceDir))) {
      // Lost a race: another load renamed the source away between our check
      // and our rename. Converge on whatever state it reached.
      if (await pathHasRootSkill(destinationDir)) {
        return { status: "completed" };
      }
      if (await pathHasRootSkill(stagingDir)) {
        try {
          await finishFromStaging();
          return { status: "moved", resumed: true };
        } catch (raceError) {
          if (await pathHasRootSkill(destinationDir)) {
            return { status: "completed" };
          }
          return { status: "failed", rollbackOk: false, error: raceError };
        }
      }
    }
    return { status: "failed", rollbackOk: true, error };
  }

  if (!(await pathHasRootSkill(stagingDir))) {
    // TOCTOU gate: a concurrent run finished the whole move after our source
    // check, so the rename above grabbed the NEW PLUGIN PARENT (payload one
    // level down, no root SKILL.md). Never proceed with the wrong subtree —
    // put it back and converge.
    let rollbackOk = true;
    try {
      await fsPromises.rename(stagingDir, sourceDir);
    } catch {
      rollbackOk = false;
    }
    if (await pathHasRootSkill(destinationDir)) {
      return { status: "completed" };
    }
    return {
      status: "failed",
      rollbackOk,
      error: new Error("nested move: source changed underneath the rename"),
    };
  }

  try {
    // mkdir recreates the just-vacated source name as the plugin parent.
    await finishFromStaging();
    return { status: "moved" };
  } catch (error) {
    if (await pathHasRootSkill(destinationDir)) {
      // A concurrent finisher owns the destination. The staged payload stays
      // parked (invisible) rather than deleting bytes that may carry edits.
      return { status: "completed" };
    }
    // Reverse rollback: drop the parent only if empty (the helper never
    // removes content), then restore the source name — never renaming onto
    // a non-empty target (Windows would refuse).
    let rollbackOk = true;
    try {
      await removeDirectoryIfEmpty(path.dirname(destinationDir));
      await fsPromises.rename(stagingDir, sourceDir);
    } catch {
      rollbackOk = false; // staging stays parked — next load resumes
    }
    return { status: "failed", rollbackOk, error };
  }
}

// Move one flat install into its plugin directory. Mirrors
// migrateInstalledBundleSkill's failure contract exactly: every failure path
// returns { changed: false, entries: [installed] } so the record survives
// flat and functional; the occupied-key check happens BEFORE any filesystem
// write. Normal destinations move copy-then-delete with reverse rollback, so
// a crash can never leave a half-moved skill. NESTED destinations — a plugin
// named exactly like its skill leaf, so the destination sits inside the
// source — move via moveNestedSkillDirectory's two atomic renames with
// per-load crash recovery instead (fs.cp EINVALs on that shape, and a copy
// landing inside the source would be deleted with it).
async function migrateInstalledPluginSkill(
  projectRoot,
  installed,
  pluginName,
  { logger = console, isKeyOccupied = () => false } = {},
) {
  const fromLocalPath = trimRepoRelativePath(installed.localPath);
  const toLocalPath = installedSkillLocalPath(
    installed.marketplaceId,
    pluginName,
    installed.skillId,
  );
  const plannedEntry = {
    ...installed,
    pluginName,
    localPath: toLocalPath,
  };

  if (isKeyOccupied(installedSkillKey(plannedEntry))) {
    logMarketplaceDiag("migrate", "record:skipped", {
      marketplaceId: installed.marketplaceId,
      skillId: installed.skillId,
      reason: "occupied-key",
    });
    return { changed: false, entries: [installed] };
  }

  const sourceDir = path.join(projectRoot, ...fromLocalPath.split("/"));
  const destinationDir = path.join(projectRoot, ...toLocalPath.split("/"));

  if (isPathInsideOrEqual(destinationDir, sourceDir)) {
    // Plugin named exactly like its skill leaf (real case: a11y/a11y). No
    // destination-occupied check here: anything at the destination is the
    // source's own content, not a foreign occupant — foreign identity is the
    // occupied-key check above, and concurrent finishers converge via the
    // helper's "completed" probe. This branch runs BEFORE the source check
    // so the helper's crash recovery (staging-only payload) still fires.
    const move = await moveNestedSkillDirectory(
      sourceDir,
      destinationDir,
      nestedMoveStagingPath(sourceDir, installed.skillId),
    );
    if (move.status === "moved" || move.status === "completed") {
      // Bookkeeping only, never a gate: the integrity check already ran on
      // the staging dir before the destructive rename.
      const installedVersion = await readInstalledSkillVersion(
        destinationDir,
        installed.installedVersion || "1.0",
      );
      logMarketplaceDiag("migrate", "record:moved", {
        marketplaceId: installed.marketplaceId,
        pluginName,
        skillId: installed.skillId,
        fromLocalPath,
        toLocalPath,
        nested: true,
        ...(move.resumed ? { resumed: true } : {}),
        ...(move.status === "completed" ? { completed: true } : {}),
      });
      return {
        changed: true,
        entries: [{ ...plannedEntry, installedVersion }],
      };
    }
    if (move.status === "source-missing") {
      logMarketplaceDiag("migrate", "record:skipped", {
        marketplaceId: installed.marketplaceId,
        skillId: installed.skillId,
        reason: "source-missing",
      });
      return { changed: false, entries: [installed] };
    }
    logger.warn?.(
      `[Marketplace] Failed to migrate ${installed.marketplaceId}/${installed.skillId} into plugin layout: ${move.error?.message}`,
    );
    logMarketplaceDiag(
      "migrate",
      "record:failed",
      {
        marketplaceId: installed.marketplaceId,
        skillId: installed.skillId,
        rollbackOk: move.rollbackOk,
        nested: true,
        ...safeErrorMeta(move.error),
      },
      "error",
    );
    return { changed: false, entries: [installed], failed: true };
  }

  if (!(await pathHasRootSkill(sourceDir))) {
    logMarketplaceDiag("migrate", "record:skipped", {
      marketplaceId: installed.marketplaceId,
      skillId: installed.skillId,
      reason: "source-missing",
    });
    return { changed: false, entries: [installed] };
  }

  let destinationOccupied = false;
  try {
    await fsPromises.access(destinationDir);
    destinationOccupied = true;
  } catch {
    destinationOccupied = false;
  }
  if (destinationOccupied) {
    logger.warn?.(
      `[Marketplace] Skipping plugin migration for ${installed.marketplaceId}/${installed.skillId}: destination ${toLocalPath} already exists`,
    );
    logMarketplaceDiag("migrate", "record:skipped", {
      marketplaceId: installed.marketplaceId,
      skillId: installed.skillId,
      reason: "occupied",
    });
    return { changed: false, entries: [installed] };
  }

  const createdDestinations = [];
  try {
    await fsPromises.mkdir(path.dirname(destinationDir), { recursive: true });
    // Register the destination BEFORE copying: an interrupted copy must roll
    // back the partial directory, never leave a half-moved skill behind.
    createdDestinations.push(destinationDir);
    await fsPromises.cp(sourceDir, destinationDir, { recursive: true });
    // Read the version back from the copy before removing the original —
    // proof the new directory is complete and readable.
    const installedVersion = await readInstalledSkillVersion(
      destinationDir,
      installed.installedVersion || "1.0",
    );
    await fsPromises.rm(sourceDir, { recursive: true, force: true });
    await removeDirectoryIfEmpty(path.dirname(sourceDir));
    logMarketplaceDiag("migrate", "record:moved", {
      marketplaceId: installed.marketplaceId,
      pluginName,
      skillId: installed.skillId,
      fromLocalPath,
      toLocalPath,
    });
    return {
      changed: true,
      entries: [
        {
          ...plannedEntry,
          installedVersion,
        },
      ],
    };
  } catch (error) {
    let rollbackOk = true;
    for (const destinationPath of createdDestinations.reverse()) {
      try {
        await fsPromises.rm(destinationPath, { recursive: true, force: true });
      } catch {
        rollbackOk = false;
      }
    }
    logger.warn?.(
      `[Marketplace] Failed to migrate ${installed.marketplaceId}/${installed.skillId} into plugin layout: ${error.message}`,
    );
    logMarketplaceDiag(
      "migrate",
      "record:failed",
      {
        marketplaceId: installed.marketplaceId,
        skillId: installed.skillId,
        rollbackOk,
        ...safeErrorMeta(error),
      },
      "error",
    );
    return { changed: false, entries: [installed], failed: true };
  }
}

// Repair pass for records that are AHEAD of the disk: a plugin-scoped record
// whose directory is missing while the legacy flat directory still exists
// (an interrupted move, or registry records merged before the payload moved).
// Same copy-then-delete contract as the migration — except nested
// destinations, which share the migration's rename-through-staging path and
// its crash recovery. Returns changed only when the directory was actually
// moved into place.
async function repairPluginRecordDirectory(projectRoot, installed, { logger = console } = {}) {
  const pluginName = normalizeInstalledPluginName(installed?.pluginName);
  if (!pluginName || !installed?.localPath || !installed?.marketplaceId || !installed?.skillId) {
    return { changed: false };
  }
  const toLocalPath = trimRepoRelativePath(installed.localPath);
  const destinationDir = path.join(projectRoot, ...toLocalPath.split("/"));
  if (await pathHasRootSkill(destinationDir)) {
    return { changed: false };
  }
  const flatLocalPath = installedSkillLocalPath(
    installed.marketplaceId,
    null,
    installed.skillId,
  );
  const sourceDir = path.join(projectRoot, ...flatLocalPath.split("/"));

  if (isPathInsideOrEqual(destinationDir, sourceDir)) {
    // Nested shape (plugin named like its skill leaf): same rename-based
    // move + crash recovery as the migration path. Runs BEFORE the source
    // check so a staging-only payload (crash between renames) still heals.
    const move = await moveNestedSkillDirectory(
      sourceDir,
      destinationDir,
      nestedMoveStagingPath(sourceDir, installed.skillId),
    );
    if (move.status === "moved") {
      logMarketplaceDiag("migrate", "record:moved", {
        marketplaceId: installed.marketplaceId,
        pluginName,
        skillId: installed.skillId,
        fromLocalPath: flatLocalPath,
        toLocalPath,
        repair: true,
        nested: true,
        ...(move.resumed ? { resumed: true } : {}),
      });
      return { changed: true };
    }
    if (move.status === "failed") {
      logger.warn?.(
        `[Marketplace] Failed to repair plugin directory for ${installed.marketplaceId}/${installed.skillId}: ${move.error?.message}`,
      );
      logMarketplaceDiag(
        "migrate",
        "record:failed",
        {
          marketplaceId: installed.marketplaceId,
          skillId: installed.skillId,
          rollbackOk: move.rollbackOk,
          repair: true,
          nested: true,
          ...safeErrorMeta(move.error),
        },
        "error",
      );
    }
    // "completed" and "source-missing" match the existing silent no-ops: the
    // record is already plugin-scoped and either the disk is already right
    // or there is nothing to move.
    return { changed: false };
  }

  if (!(await pathHasRootSkill(sourceDir))) {
    return { changed: false };
  }

  let destinationOccupied = false;
  try {
    await fsPromises.access(destinationDir);
    destinationOccupied = true;
  } catch {
    destinationOccupied = false;
  }
  if (destinationOccupied) {
    logMarketplaceDiag("migrate", "record:skipped", {
      marketplaceId: installed.marketplaceId,
      skillId: installed.skillId,
      reason: "repair-destination-occupied",
    });
    return { changed: false };
  }

  const createdDestinations = [];
  try {
    await fsPromises.mkdir(path.dirname(destinationDir), { recursive: true });
    createdDestinations.push(destinationDir);
    await fsPromises.cp(sourceDir, destinationDir, { recursive: true });
    await readInstalledSkillVersion(destinationDir, installed.installedVersion || "1.0");
    await fsPromises.rm(sourceDir, { recursive: true, force: true });
    await removeDirectoryIfEmpty(path.dirname(sourceDir));
    logMarketplaceDiag("migrate", "record:moved", {
      marketplaceId: installed.marketplaceId,
      pluginName,
      skillId: installed.skillId,
      fromLocalPath: flatLocalPath,
      toLocalPath,
      repair: true,
    });
    return { changed: true };
  } catch (error) {
    let rollbackOk = true;
    for (const destinationPath of createdDestinations.reverse()) {
      try {
        await fsPromises.rm(destinationPath, { recursive: true, force: true });
      } catch {
        rollbackOk = false;
      }
    }
    logger.warn?.(
      `[Marketplace] Failed to repair plugin directory for ${installed.marketplaceId}/${installed.skillId}: ${error.message}`,
    );
    logMarketplaceDiag(
      "migrate",
      "record:failed",
      {
        marketplaceId: installed.marketplaceId,
        skillId: installed.skillId,
        rollbackOk,
        repair: true,
        ...safeErrorMeta(error),
      },
      "error",
    );
    return { changed: false };
  }
}

async function reconcileInstalledMarketplaceSkills(
  projectRoot,
  config,
  { logger = console } = {},
) {
  if (!Array.isArray(config?.installedSkills) || config.installedSkills.length === 0) {
    return { changed: false };
  }

  const marketplacesById = new Map(
    (config.marketplaces || [])
      .filter((entry) => entry?.id)
      .map((entry) => [entry.id, entry]),
  );

  // Log the migration pass only when at least one record is eligible — the
  // steady state stays quiet, but a support bundle can distinguish
  // "migration ran and moved 7" from "migration never ran".
  const migrationPlan = config.installedSkills.map((installed) =>
    planInstalledPluginMigration(installed, marketplacesById),
  );
  const eligibleCount = migrationPlan.filter((plan) => plan.pluginName).length;
  const migrateStartedAt = Date.now();
  const migrateCounters = { moved: 0, skipped: 0, failed: 0 };
  if (eligibleCount > 0) {
    const skippedByReason = {};
    for (const plan of migrationPlan) {
      if (plan.skipReason && plan.skipReason !== "already-plugin") {
        skippedByReason[plan.skipReason] = (skippedByReason[plan.skipReason] || 0) + 1;
      }
    }
    logMarketplaceDiag("migrate", "plan", {
      recordCount: config.installedSkills.length,
      eligibleCount,
      skippedByReason,
    });
  }

  const nextInstalledSkills = [];
  const occupiedKeys = new Map();
  for (const entry of config.installedSkills) {
    incrementCount(occupiedKeys, installedSkillKey(entry));
  }

  let changed = false;

  for (const [index, installed] of config.installedSkills.entries()) {
    const originalKey = installedSkillKey(installed);
    decrementCount(occupiedKeys, originalKey);

    let migration = await migrateInstalledBundleSkill(projectRoot, installed, {
      logger,
      isKeyOccupied: (key) => (occupiedKeys.get(key) || 0) > 0,
    });

    // Records already plugin-scoped may still need their DIRECTORY moved
    // (registry merged ahead of the payload move, or an interrupted move).
    if (!migration.changed && migrationPlan[index]?.skipReason === "already-plugin") {
      const repair = await repairPluginRecordDirectory(projectRoot, installed, { logger });
      if (repair.changed) {
        changed = true;
      }
    }

    // A flat record whose manifest places it inside a plugin moves to the
    // plugin layout (skills-marketplace/{mp}/{plugin}/{leaf}).
    if (!migration.changed && migrationPlan[index]?.pluginName) {
      migration = await migrateInstalledPluginSkill(
        projectRoot,
        installed,
        migrationPlan[index].pluginName,
        {
          logger,
          isKeyOccupied: (key) => (occupiedKeys.get(key) || 0) > 0,
        },
      );
      if (migration.changed) {
        migrateCounters.moved += 1;
      } else if (migration.failed) {
        migrateCounters.failed += 1;
      } else {
        migrateCounters.skipped += 1;
      }
    }

    if (!migration.changed) {
      incrementCount(occupiedKeys, originalKey);
      nextInstalledSkills.push(installed);
      continue;
    }

    for (const entry of migration.entries) {
      incrementCount(occupiedKeys, installedSkillKey(entry));
      nextInstalledSkills.push(entry);
    }
    changed = true;
  }

  if (eligibleCount > 0) {
    logMarketplaceDiag("migrate", "summary", {
      ...migrateCounters,
      durationMs: Date.now() - migrateStartedAt,
    });
  }

  if (changed) {
    config.installedSkills = nextInstalledSkills;
  }

  return { changed };
}

async function reconcileInstalledSkillVersions(
  projectRoot,
  config,
  { logger = console } = {},
) {
  if (!Array.isArray(config?.installedSkills) || config.installedSkills.length === 0) {
    return { changed: false };
  }

  let changed = false;

  // Each record's SKILL.md read is independent, and this runs on the startup
  // integrity pass — read them concurrently, then apply in order so logging
  // stays deterministic.
  const resolvedVersions = await mapWithConcurrency(
    config.installedSkills,
    8,
    (installed) =>
      installed?.localPath
        ? readInstalledSkillVersion(
            path.join(projectRoot, installed.localPath),
            installed.installedVersion || "1.0",
          )
        : null,
  );

  for (const [index, installed] of config.installedSkills.entries()) {
    if (!installed?.localPath) {
      continue;
    }

    const resolvedVersion = resolvedVersions[index];

    if (!resolvedVersion || resolvedVersion === installed.installedVersion) {
      continue;
    }

    const previousInstalledVersion = installed.installedVersion;
    installed.installedVersion = resolvedVersion;
    if (
      !installed.lastCheckedVersion ||
      installed.lastCheckedVersion === previousInstalledVersion
    ) {
      installed.lastCheckedVersion = resolvedVersion;
    }
    changed = true;
    logger.info?.(
      `[Marketplace] Refreshed installed version for ${installed.marketplaceId}/${installed.skillId} from ${previousInstalledVersion || "unknown"} to ${resolvedVersion}`,
    );
  }

  return { changed };
}

async function reconcileMarketplaceState(projectRoot, { logger = console } = {}) {
  const result = await ensureBundledMarketplaceDefaults(projectRoot, { logger });
  const config = normalizeMarketplacesConfig(result?.config);

  // Every reconcile step degrades independently: a thrown migration or
  // version refresh means "config as loaded, nothing migrated", never a
  // failed load (which would empty the whole Agent Skills Git tab).
  let migrationChanged = false;
  try {
    migrationChanged = (
      await reconcileInstalledMarketplaceSkills(projectRoot, config, { logger })
    ).changed;
  } catch (error) {
    logMarketplaceDiag(
      "registry",
      "reconcile:skipped",
      { step: "installed-skill-migration", ...safeErrorMeta(error) },
      "error",
    );
  }

  let versionRefreshChanged = false;
  try {
    versionRefreshChanged = (
      await reconcileInstalledSkillVersions(projectRoot, config, { logger })
    ).changed;
  } catch (error) {
    logMarketplaceDiag(
      "registry",
      "reconcile:skipped",
      { step: "version-refresh", ...safeErrorMeta(error) },
      "error",
    );
  }

  if (migrationChanged || versionRefreshChanged) {
    await saveMarketplacesConfig(projectRoot, config);
  }

  const updated = Boolean(result?.updated) || migrationChanged || versionRefreshChanged;
  // Registry loads are a hot path (every catalog scan) — log only the loads
  // that changed something, and flag rebuilds from bundled defaults.
  if (result?.restoredFromBundledDefaults) {
    logMarketplaceDiag("registry", "load:degraded", {
      marketplacesCount: (config.marketplaces || []).length,
      installedSkillsCount: (config.installedSkills || []).length,
      rebuiltFromBundledDefaults: true,
    });
  } else if (updated) {
    logMarketplaceDiag("registry", "load:ok", {
      marketplacesCount: (config.marketplaces || []).length,
      installedSkillsCount: (config.installedSkills || []).length,
      migrationChanged,
      versionRefreshChanged,
    });
  }

  return {
    config,
    restoredFromBundledDefaults: Boolean(result?.restoredFromBundledDefaults),
    updated,
  };
}

// ---------------------------------------------------------------------------
// Startup integrity pass — orphan adoption + ghost-record cleanup.
//
// Registry drift the write lock cannot prevent: install downloads into the
// final destination BEFORE its locked upsert (a crash between strands an
// orphan dir with no record), uninstall removes the dir BEFORE saving the
// registry (a crash between strands a ghost record), and pre-lock builds
// could lose records outright to the last-writer-wins race. This pass runs
// once per launch (ipc.js ensureBundledMarketplaceDefaultsAtStartup), AFTER
// reconcileMarketplaceState's OOTB merge + legacy migrations, and:
//   - ADOPTS unrecorded skill dirs that unambiguously match their
//     marketplace's cached manifest. The current disk content becomes the
//     baseline, so a crashed or user-edited payload reads dirty against the
//     next remote change instead of staying invisible. Depth-2 dirs adopt as
//     FLAT records even when the manifest maps them into a plugin — the
//     existing plugin migration relocates them on the next config load; the
//     pass itself never moves payloads.
//   - DROPS records whose directory no longer exists (dir ENOENT only — a
//     dir that merely lost its SKILL.md still has payload). A ghost record
//     otherwise blocks reinstall via skill_already_installed and shows
//     "Installed" for a skill the disk scan cannot see.
// This generalizes the OOTB merge's seed-orphan adoption to catalog skills.
// Never guesses: ambiguous or manifest-less candidates skip with a
// diagnostic. ai-marketplace (solutions) DIRS are skipped — solutionId lives
// only in the record and is not recoverable from disk; reinstalling the
// solution is the repair there. Solutions GHOST records ARE dropped
// (reinstall re-derives solutionId from the live listing).
// ---------------------------------------------------------------------------

async function scanAdoptableMarketplaceSkillDirs(projectRoot, config, { logger = console } = {}) {
  const candidates = [];
  const skips = [];
  const root = path.join(projectRoot, "skills-marketplace");
  let topLevel;
  try {
    topLevel = await fsPromises.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { candidates, skips };
    }
    throw error;
  }

  const marketplaceIds = new Set((config.marketplaces || []).map((entry) => entry.id));
  const recordedPaths = new Set(
    (config.installedSkills || [])
      .map((entry) => trimRepoRelativePath(entry?.localPath || ""))
      .filter(Boolean),
  );

  for (const entry of topLevel) {
    if (!entry.isDirectory()) continue;
    const marketplaceId = entry.name;
    // Dot/underscore prefixes cover every staging convention (.X.sync-*,
    // .X.ootb-seed-*, …) — same filter as the IPC disk scan and Rust catalog.
    if (marketplaceId.startsWith(".") || marketplaceId.startsWith("_")) continue;
    if (marketplaceId === AI_MARKETPLACE_SKILL_SOURCE_ID) {
      skips.push({ reason: "solutions-dir", marketplaceId });
      continue;
    }
    if (!marketplaceIds.has(marketplaceId)) {
      skips.push({ reason: "unconfigured-marketplace", marketplaceId });
      continue;
    }
    try {
      const marketplaceDir = path.join(root, marketplaceId);
      const children = await fsPromises.readdir(marketplaceDir, { withFileTypes: true });
      for (const child of children) {
        if (!child.isDirectory()) continue;
        const name = child.name;
        if (name.startsWith(".") || name.startsWith("_")) continue;
        const childDir = path.join(marketplaceDir, name);
        if (await pathHasRootSkill(childDir)) {
          const localPath = `skills-marketplace/${marketplaceId}/${name}`;
          if (!recordedPaths.has(localPath)) {
            candidates.push({ marketplaceId, pluginName: null, skillId: name, localPath });
          }
          continue;
        }
        // Potential plugin dir: leaves with a root SKILL.md one level down
        // (the plugin dir itself must NOT have one — grammar shared with the
        // IPC scan and skills_catalog.rs).
        let sawLeaf = false;
        const grandchildren = await fsPromises.readdir(childDir, { withFileTypes: true });
        for (const leaf of grandchildren) {
          if (!leaf.isDirectory()) continue;
          if (leaf.name.startsWith(".") || leaf.name.startsWith("_")) continue;
          if (!(await pathHasRootSkill(path.join(childDir, leaf.name)))) continue;
          sawLeaf = true;
          const localPath = `skills-marketplace/${marketplaceId}/${name}/${leaf.name}`;
          if (!recordedPaths.has(localPath)) {
            candidates.push({
              marketplaceId,
              pluginName: name,
              skillId: leaf.name,
              localPath,
            });
          }
        }
        if (!sawLeaf) {
          // Deep bundle relics and junk dirs: never misread, never touch.
          skips.push({ reason: "unrecognized-layout", marketplaceId, name });
        }
      }
    } catch (error) {
      skips.push({ reason: "scan-failed", marketplaceId });
      logMarketplaceDiag(
        "integrity",
        "scan:failed",
        { marketplaceId, ...safeErrorMeta(error) },
        "error",
      );
      logger.warn?.(
        `[Marketplace] Integrity scan failed for marketplace "${marketplaceId}": ${error?.message || error}`,
      );
    }
  }
  return { candidates, skips };
}

function matchOrphanCandidateToCatalog(candidate, marketplace, manifestEntries) {
  if (!marketplace?.cachedManifest) {
    return { skipReason: "no-cached-manifest" };
  }
  // Depth-2 dirs match by leaf id across ALL entries: a legacy flat orphan of
  // a plugin-scoped skill adopts as a flat record and the plugin migration
  // relocates it on the next load. Depth-3 dirs must match layout exactly.
  const matches = candidate.pluginName
    ? manifestEntries.filter(
        (entry) =>
          entry.pluginName === candidate.pluginName && entry.id === candidate.skillId,
      )
    : manifestEntries.filter((entry) => entry.id === candidate.skillId);
  if (matches.length === 0) {
    return { skipReason: "no-manifest-entry" };
  }
  if (matches.length > 1) {
    // Two entries can disagree on skillPath/skillSource — never guess.
    return { skipReason: "ambiguous-manifest-entry" };
  }
  const entry = matches[0];
  if (entry.available === false) {
    return { skipReason: "unavailable" };
  }
  if (entry.skillSource && typeof entry.skillSource === "object") {
    // Same allowlist backstop as installMarketplaceSkill: an external-source
    // plugin outside the approved repos never becomes a registered install.
    const remoteSource = resolveRemoteSkillSource(entry.skillSource, marketplace.source);
    if (
      !isSameRepositorySource(remoteSource, marketplace.source) &&
      !isAllowedMarketplaceSource(remoteSource)
    ) {
      return { skipReason: "source-not-allowed" };
    }
  }
  return { entry };
}

async function findGhostInstalledSkillRecords(projectRoot, config) {
  const records = config.installedSkills || [];
  // The stats are independent and this runs on the startup integrity pass, so
  // issue them concurrently. Each probe reports only whether the path is
  // missing; ghosts are then collected in record order.
  const missing = await mapWithConcurrency(records, 8, async (record) => {
    const localPath = trimRepoRelativePath(record?.localPath || "");
    if (!localPath) {
      return false;
    }
    try {
      await fsPromises.stat(path.join(projectRoot, localPath));
      return false;
    } catch (error) {
      // ENOENT only: any other stat error (permissions, transient IO) must
      // never read as "the install is gone".
      return error?.code === "ENOENT";
    }
  });

  const ghosts = [];
  for (const [index, record] of records.entries()) {
    const localPath = trimRepoRelativePath(record?.localPath || "");
    if (!localPath) {
      logMarketplaceDiag("integrity", "ghost:skipped", {
        reason: "invalid-record",
        marketplaceId: record?.marketplaceId,
        skillId: record?.skillId,
      });
      continue;
    }
    if (missing[index]) {
      ghosts.push({
        marketplaceId: record.marketplaceId,
        skillId: record.skillId,
        pluginName: normalizeInstalledPluginName(record.pluginName),
        localPath,
      });
    }
  }
  return ghosts;
}

async function runStartupMarketplaceIntegrityPass(projectRoot, { logger = console } = {}) {
  const startedAt = Date.now();
  const reconcile = await reconcileMarketplaceState(projectRoot, { logger });
  const result = { reconcile, adopted: [], removedGhostRecords: 0, skipped: [] };

  try {
    const config = reconcile.config;
    const marketplacesById = new Map(
      (config.marketplaces || []).map((entry) => [entry.id, entry]),
    );

    const { candidates, skips } = await scanAdoptableMarketplaceSkillDirs(
      projectRoot,
      config,
      { logger },
    );
    result.skipped.push(...skips);

    const entriesByMarketplace = new Map();
    const adoptable = [];
    for (const candidate of candidates) {
      const marketplace = marketplacesById.get(candidate.marketplaceId);
      if (!entriesByMarketplace.has(candidate.marketplaceId)) {
        entriesByMarketplace.set(
          candidate.marketplaceId,
          marketplace?.cachedManifest
            ? parseSkillsFromManifest(marketplace.cachedManifest, candidate.marketplaceId, {
                sparse: marketplace.isSparse === true,
                logger,
              })
            : [],
        );
      }
      const match = matchOrphanCandidateToCatalog(
        candidate,
        marketplace,
        entriesByMarketplace.get(candidate.marketplaceId),
      );
      if (match.skipReason) {
        result.skipped.push({
          reason: match.skipReason,
          marketplaceId: candidate.marketplaceId,
          name: candidate.skillId,
        });
        logMarketplaceDiag("integrity", "adopt:skipped", {
          marketplaceId: candidate.marketplaceId,
          name: candidate.skillId,
          reason: match.skipReason,
        });
        continue;
      }
      adoptable.push({ candidate, entry: match.entry });
    }

    const ghosts = await findGhostInstalledSkillRecords(projectRoot, config);

    if (!adoptable.length && !ghosts.length) {
      // Steady state: zero writes, zero log lines.
      return result;
    }

    logMarketplaceDiag("integrity", "plan", {
      adoptable: adoptable.length,
      ghosts: ghosts.length,
      skippedByReason: result.skipped.reduce((byReason, skip) => {
        byReason[skip.reason] = (byReason[skip.reason] || 0) + 1;
        return byReason;
      }, {}),
    });

    // ONE locked bulk mutation: one load, N in-memory upserts, one save —
    // per-candidate locked upserts would re-run the full reconcile + registry
    // hash per adoption. The in-lock re-checks close the scan-vs-mutate races
    // (all registry mutators serialize on this lock).
    await withRegistryWriteLock(async () => {
      const currentConfig = await loadMarketplacesConfig(projectRoot, { logger });
      let changed = false;

      for (const { candidate, entry } of adoptable) {
        try {
          const absoluteDir = path.join(projectRoot, candidate.localPath);
          if (!(await pathHasRootSkill(absoluteDir))) {
            continue; // dir vanished since the scan (racing uninstall/delete)
          }
          const occupied = (currentConfig.installedSkills || []).some(
            (record) =>
              (record.marketplaceId === candidate.marketplaceId &&
                record.skillId === candidate.skillId &&
                normalizeInstalledPluginName(record.pluginName) === candidate.pluginName) ||
              trimRepoRelativePath(record.localPath || "") === candidate.localPath,
          );
          if (occupied) {
            continue; // a racing install recorded it since the scan
          }
          await applyInstalledSkillUpsertToConfig(projectRoot, currentConfig, {
            marketplaceId: candidate.marketplaceId,
            skillId: candidate.skillId,
            pluginName: candidate.pluginName,
            localPath: candidate.localPath,
            skillPath: entry.skillPath,
            skillSource: entry.skillSource ?? null,
          });
          changed = true;
          result.adopted.push(candidate);
          logMarketplaceDiag("integrity", "adopt:ok", {
            marketplaceId: candidate.marketplaceId,
            pluginName: candidate.pluginName,
            skillId: candidate.skillId,
          });
        } catch (error) {
          result.skipped.push({
            reason: "adopt-failed",
            marketplaceId: candidate.marketplaceId,
            name: candidate.skillId,
          });
          logMarketplaceDiag(
            "integrity",
            "adopt:skipped",
            {
              marketplaceId: candidate.marketplaceId,
              name: candidate.skillId,
              reason: "adopt-failed",
              ...safeErrorMeta(error),
            },
            "error",
          );
        }
      }

      if (ghosts.length) {
        const stillGhostPaths = new Set();
        for (const ghost of ghosts) {
          try {
            await fsPromises.stat(path.join(projectRoot, ghost.localPath));
          } catch (error) {
            if (error?.code === "ENOENT") {
              stillGhostPaths.add(ghost.localPath);
            }
          }
        }
        if (stillGhostPaths.size) {
          const before = currentConfig.installedSkills.length;
          currentConfig.installedSkills = currentConfig.installedSkills.filter(
            (record) => {
              const localPath = trimRepoRelativePath(record?.localPath || "");
              if (!stillGhostPaths.has(localPath)) {
                return true;
              }
              logMarketplaceDiag("integrity", "ghost:removed", {
                marketplaceId: record.marketplaceId,
                skillId: record.skillId,
                pluginName: normalizeInstalledPluginName(record.pluginName),
              });
              return false;
            },
          );
          result.removedGhostRecords = before - currentConfig.installedSkills.length;
          if (result.removedGhostRecords > 0) {
            changed = true;
          }
        }
      }

      if (changed) {
        await saveMarketplacesConfig(projectRoot, currentConfig);
      }
    });
  } catch (error) {
    // A failed integrity phase never degrades startup below today's behavior
    // (the reconcile already ran and is returned untouched).
    logMarketplaceDiag("integrity", "phase:failed", safeErrorMeta(error), "error");
    logger.warn?.(
      `[Marketplace] Integrity pass degraded to reconcile-only: ${error?.message || error}`,
    );
    return result;
  }

  if (result.adopted.length + result.removedGhostRecords > 0) {
    logger.log?.(
      `[Marketplace] Integrity pass: adopted ${result.adopted.length} orphaned skill install(s), removed ${result.removedGhostRecords} ghost record(s)`,
    );
  }
  logMarketplaceDiag("integrity", "summary", {
    adopted: result.adopted.length,
    ghostsRemoved: result.removedGhostRecords,
    skipped: result.skipped.length,
    durationMs: Date.now() - startedAt,
  });
  return result;
}

function parseAuthor(author) {
  if (!author) {
    return { name: "Unknown" };
  }

  if (typeof author === "string") {
    return { name: author };
  }

  return compactObject({
    name: author.name || "Unknown",
    email: author.email,
  });
}

function synthesizeSparseRepoPluginMetadata(source) {
  if (source?.type === "github") {
    const [ownerName = "Unknown", repoName = "skills"] = String(source.repo || "").split("/");
    return {
      name: repoName,
      author: {
        name: ownerName,
      },
      description: `Skills from ${source.repo}`,
      version: "1.0.0",
    };
  }

  if (source?.type === "gitlab") {
    const segments = String(source.projectPath || "")
      .split("/")
      .filter(Boolean);
    const repoName = segments[segments.length - 1] || "skills";
    const ownerName = segments.slice(0, -1).join("/") || "Unknown";
    return {
      name: repoName,
      author: {
        name: ownerName,
      },
      description: `Skills from ${source.projectPath}`,
      version: "1.0.0",
    };
  }

  throw createMarketplaceError(
    `Cannot synthesize sparse plugin metadata for source type "${source?.type}"`,
    "unsupported_sparse_source",
  );
}

function synthesizeSparseManifest(pluginMetadata, discoveredSkillPaths) {
  const pluginName =
    typeof pluginMetadata?.name === "string" && pluginMetadata.name.trim()
      ? pluginMetadata.name.trim()
      : null;

  if (!pluginName) {
    throw createMarketplaceError(
      "Sparse marketplace plugin.json is missing a valid name",
      "sparse_plugin_missing_name",
    );
  }

  const uniqueSkillPaths = [...new Set(discoveredSkillPaths.map(normalizeSkillPath))].sort();
  if (uniqueSkillPaths.length === 0) {
    throw createMarketplaceError(
      `Sparse marketplace "${pluginName}" does not contain any skills with SKILL.md under skills/ or .atlas/skills/`,
      "sparse_marketplace_no_skills",
    );
  }

  const duplicateIds = new Map();
  for (const skillPath of uniqueSkillPaths) {
    const skillId = deriveSkillId(skillPath);
    if (duplicateIds.has(skillId)) {
      throw createMarketplaceError(
        `Sparse marketplace "${pluginName}" contains duplicate skill id "${skillId}" at ${duplicateIds.get(skillId)} and ${skillPath}`,
        "sparse_marketplace_duplicate_skill_id",
      );
    }
    duplicateIds.set(skillId, skillPath);
  }

  return {
    name: pluginName,
    owner: parseAuthor(pluginMetadata.author),
    metadata: {
      description: pluginMetadata.description || "No description",
      version: pluginMetadata.version || "1.0.0",
    },
    plugins: [
      {
        name: pluginName,
        description: pluginMetadata.description || "No description available",
        source: "./",
        strict: false,
        skills: uniqueSkillPaths,
      },
    ],
  };
}

async function loadSparseMarketplaceDefinitionFromSource(
  source,
  {
    interactiveAuth = false,
    pluginMetadata = null,
    repoLabel = "repository",
  } = {},
) {
  const discovered = await discoverSparseSkillPathsFromSource(source, {
    interactiveAuth,
  });

  if (discovered.skillPaths.length === 0) {
    throw createMarketplaceError(
      `Repository ${repoLabel} has no marketplace.json, no plugin.json, and no .atlas/skills/*/SKILL.md files.`,
      "marketplace_manifest_missing",
    );
  }

  const manifest = synthesizeSparseManifest(
    pluginMetadata || synthesizeSparseRepoPluginMetadata(source),
    discovered.skillPaths,
  );

  return {
    source: discovered.source,
    manifest,
    isSparse: true,
    manifestSource: pluginMetadata ? "plugin-json" : "sparse-repo-fallback",
  };
}

function countTotalSkills(manifest) {
  if (!manifest || !Array.isArray(manifest.plugins)) {
    return 0;
  }

  let count = 0;
  for (const plugin of manifest.plugins) {
    if (Array.isArray(plugin?.skills)) {
      count += plugin.skills.length;
    } else {
      count += 1;
    }
  }
  return count;
}

// Catalog identity grammar:
// - plugin skills (a plugin with a `skills` array in a regular manifest):
//   pluginName = plugin.name, installed under {mp}/{plugin}/{leaf} (depth 3).
// - sparse repos (the synthesized plugin is a packaging artifact),
//   single-skill plugins (no skills array: the plugin IS the skill), and
//   unsafe plugin directory names: pluginName = null, flat {mp}/{leaf}.
// Plugins annotated `unavailable` still list their skills so the UI can say
// why, but with available:false — install paths reject them.
function parseSkillsFromManifest(manifest, marketplaceId, { sparse = false, logger = console } = {}) {
  const skills = [];
  if (!manifest || !Array.isArray(manifest.plugins)) {
    return skills;
  }

  const seenLeafIds = new Map();

  for (const plugin of manifest.plugins) {
    const skillSource =
      plugin?.source && typeof plugin.source === "object" ? plugin.source : null;
    const available = plugin?.unavailable !== true;
    const unavailableReason = available
      ? null
      : plugin?.unavailableReason || "plugin_unavailable";

    if (Array.isArray(plugin?.skills)) {
      let pluginName = null;
      if (!sparse && typeof plugin?.name === "string" && plugin.name.trim()) {
        if (safePluginSegment(plugin.name.trim())) {
          pluginName = plugin.name.trim();
        } else {
          logMarketplaceDiag("plugin", "unsafe-segment", {
            marketplaceId,
            reason: "plugin_name_unsafe",
          });
          logger.warn?.(
            `[Marketplace] Plugin name in "${marketplaceId}" is not a safe directory segment; its skills degrade to the flat layout`,
          );
        }
      }

      for (const skillPath of plugin.skills) {
        const normalizedSkillPath = normalizeSkillPath(skillPath);
        const skillName = deriveSkillId(normalizedSkillPath);
        const previousContext = seenLeafIds.get(skillName);
        const leafContext = pluginName || "";
        if (previousContext !== undefined && previousContext !== leafContext) {
          logMarketplaceDiag("scan", "duplicate-leaf", {
            marketplaceId,
            leafId: skillName,
          });
        }
        seenLeafIds.set(skillName, leafContext);
        skills.push({
          id: skillName,
          name: skillName,
          // Legacy renderer contract keeps camelCase displayName (weaker
          // split-on-"-" rules); display_name is the tool-facing field with
          // the full shared formatting rules.
          displayName: formatDisplayName(skillName),
          display_name: formatSkillDisplayName(skillName),
          description: plugin.description || "No description available",
          pluginName,
          skillPath: normalizedSkillPath,
          skillSource,
          marketplaceId,
          available,
          unavailableReason,
        });
      }
      continue;
    }

    let normalizedSkillPath = "./";
    if (typeof plugin?.source === "string") {
      normalizedSkillPath = normalizeSkillPath(plugin.source);
    } else if (
      plugin?.source &&
      typeof plugin.source === "object" &&
      typeof plugin.source.path === "string"
    ) {
      normalizedSkillPath = normalizeSkillPath(plugin.source.path);
    }

    skills.push({
      id: plugin.name,
      name: plugin.name,
      displayName: formatDisplayName(plugin.name),
      display_name: formatSkillDisplayName(plugin.name),
      description: plugin.description || "No description available",
      pluginName: null,
      skillPath: normalizedSkillPath,
      skillSource,
      marketplaceId,
      available,
      unavailableReason,
    });
  }

  return skills;
}

function hasNewerVersion(installedVersion, remoteVersion) {
  if (!installedVersion || !remoteVersion) {
    return false;
  }

  const installed = String(installedVersion)
    .split(".")
    .map((value) => parseInt(value, 10) || 0);
  const remote = String(remoteVersion)
    .split(".")
    .map((value) => parseInt(value, 10) || 0);

  for (let index = 0; index < Math.max(installed.length, remote.length); index += 1) {
    const installedPart = installed[index] || 0;
    const remotePart = remote[index] || 0;
    if (remotePart > installedPart) {
      return true;
    }
    if (remotePart < installedPart) {
      return false;
    }
  }

  return false;
}

function getGitHubAccessToken() {
  const token =
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    process.env.GITHUB_ACCESS_TOKEN ||
    "";
  return typeof token === "string" ? token.trim() : "";
}

function githubRequestHeaders() {
  const token = getGitHubAccessToken();
  return compactObject({
    Accept: "application/vnd.github+json",
    "User-Agent": "Portico",
    Authorization: token ? `Bearer ${token}` : undefined,
  });
}

function githubRawRequestHeaders() {
  const token = getGitHubAccessToken();
  return compactObject({
    "User-Agent": "Portico",
    Authorization: token ? `Bearer ${token}` : undefined,
  });
}

function ensureGitLabHostAllowed(host) {
  const normalizedHost = String(host || "").trim().toLowerCase();
  if (!normalizedHost) {
    throw createMarketplaceError("Missing GitLab host", "gitlab_host_missing");
  }
  if (!GITLAB_MARKETPLACE_AUTH_CONFIG.allowedHosts.includes(normalizedHost)) {
    throw createMarketplaceError(
      `GitLab host "${normalizedHost}" is not enabled for marketplaces`,
      "gitlab_host_unsupported",
      { host: normalizedHost },
    );
  }
  return normalizedHost;
}

function buildGitLabBaseUrl(host) {
  const normalizedHost = ensureGitLabHostAllowed(host);
  const configuredHost = new URL(GITLAB_MARKETPLACE_AUTH_CONFIG.baseUrl).host;
  if (normalizedHost === configuredHost) {
    return GITLAB_MARKETPLACE_AUTH_CONFIG.baseUrl;
  }
  return `https://${normalizedHost}`;
}

function buildGitHubSource(repo, extra = {}) {
  const normalizedRepo = String(repo || "")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/, "");

  if (!/^[^/@:\s]+\/[^/@:\s]+$/.test(normalizedRepo)) {
    throw createMarketplaceError(
      `Invalid GitHub repository "${repo}"`,
      "invalid_github_repo",
    );
  }

  return compactObject({
    ...extra,
    type: "github",
    repo: normalizedRepo,
    repoUrl: `https://${GITHUB_REPO_HOST}/${normalizedRepo}`,
    ref:
      typeof extra.ref === "string" && extra.ref.trim() ? extra.ref.trim() : undefined,
  });
}

function buildGitLabSource({ host, projectPath, ref, ...extra }) {
  const normalizedHost = ensureGitLabHostAllowed(host);
  const normalizedProjectPath = String(projectPath || "")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/, "");

  if (!normalizedProjectPath || normalizedProjectPath.includes("//")) {
    throw createMarketplaceError(
      `Invalid GitLab project path "${projectPath}"`,
      "invalid_gitlab_project_path",
    );
  }

  const baseUrl = buildGitLabBaseUrl(normalizedHost);
  return compactObject({
    ...extra,
    type: "gitlab",
    host: normalizedHost,
    projectPath: normalizedProjectPath,
    repoUrl: `${baseUrl}/${normalizedProjectPath}.git`,
    ref: typeof ref === "string" && ref.trim() ? ref.trim() : undefined,
  });
}

function buildUrlSource(url, extra = {}) {
  const normalizedUrl = String(url || "").trim();
  if (!normalizedUrl) {
    throw createMarketplaceError("Missing marketplace URL", "invalid_marketplace_url");
  }
  return compactObject({
    ...extra,
    type: "url",
    url: normalizedUrl,
  });
}

function parseGitHubSourceFromUrl(parsedUrl) {
  const pathSegments = parsedUrl.pathname
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean);

  if (parsedUrl.hostname === GITHUB_REPO_HOST) {
    if (pathSegments.length < 2) {
      throw createMarketplaceError(
        `Invalid GitHub repository URL "${parsedUrl.toString()}"`,
        "invalid_github_repo_url",
      );
    }

    const [owner, repo, type, ref, ...filePathSegments] = pathSegments;
    if (type === "tree" && ref) {
      return buildGitHubSource(`${owner}/${repo}`, {
        ref: [ref, ...filePathSegments]
          .map((segment) => decodeURIComponent(segment))
          .join("/"),
      });
    }

    if ((type === "blob" || type === "raw") && ref) {
      const filePath = filePathSegments.join("/");
      if (
        filePath === MARKETPLACE_MANIFEST_PATH ||
        filePath === PLUGIN_METADATA_PATH
      ) {
        return buildGitHubSource(`${owner}/${repo}`, { ref });
      }
    }

    return buildGitHubSource(`${owner}/${repo}`);
  }

  if (parsedUrl.hostname === GITHUB_RAW_HOST) {
    if (pathSegments.length < 4) {
      throw createMarketplaceError(
        `Invalid GitHub raw URL "${parsedUrl.toString()}"`,
        "invalid_github_raw_url",
      );
    }

    const [owner, repo, ref, ...filePathSegments] = pathSegments;
    const filePath = filePathSegments.join("/");
    if (
      filePath === MARKETPLACE_MANIFEST_PATH ||
      filePath === PLUGIN_METADATA_PATH
    ) {
      return buildGitHubSource(`${owner}/${repo}`, { ref });
    }
  }

  return null;
}

function parseMarketplaceSourceFromGitRemote(remote) {
  const trimmed = String(remote || "").trim();
  if (!trimmed) {
    return null;
  }

  const sshUrlMatch = trimmed.match(
    /^ssh:\/\/(?:(?<user>[^@/]+)@)?(?<host>[^/]+)\/(?<projectPath>.+)$/i,
  );
  if (sshUrlMatch?.groups?.host && sshUrlMatch.groups.projectPath) {
    const host = sshUrlMatch.groups.host.toLowerCase();
    const projectPath = sshUrlMatch.groups.projectPath.replace(/\/+$/g, "");
    if (host === GITHUB_REPO_HOST) {
      return buildGitHubSource(projectPath);
    }
    if (GITLAB_MARKETPLACE_AUTH_CONFIG.allowedHosts.includes(host)) {
      return buildGitLabSource({ host, projectPath });
    }
    return null;
  }

  const scpStyleMatch = trimmed.match(
    /^(?:(?<user>[^@:\s]+)@)?(?<host>[^:/\s]+):(?<projectPath>.+)$/i,
  );
  if (scpStyleMatch?.groups?.host && scpStyleMatch.groups.projectPath) {
    const host = scpStyleMatch.groups.host.toLowerCase();
    const projectPath = scpStyleMatch.groups.projectPath.replace(/\/+$/g, "");
    if (host === GITHUB_REPO_HOST) {
      return buildGitHubSource(projectPath);
    }
    if (GITLAB_MARKETPLACE_AUTH_CONFIG.allowedHosts.includes(host)) {
      return buildGitLabSource({ host, projectPath });
    }
  }

  return null;
}

function parseGitLabSourceFromUrl(parsedUrl, { allowSparseFileUrl = false } = {}) {
  const normalizedHost = ensureGitLabHostAllowed(parsedUrl.host);
  const pathSegments = parsedUrl.pathname
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean);

  if (pathSegments.length < 2) {
    throw createMarketplaceError(
      `Invalid GitLab repository URL "${parsedUrl.toString()}"`,
      "invalid_gitlab_repo_url",
    );
  }

  const separatorIndex = pathSegments.indexOf("-");
  if (separatorIndex !== -1) {
    const projectPath = pathSegments.slice(0, separatorIndex).join("/");
    const routeType = pathSegments[separatorIndex + 1];
    const ref = pathSegments[separatorIndex + 2];
    const filePath = pathSegments.slice(separatorIndex + 3).join("/");
    if (routeType === "tree" && ref) {
      return buildGitLabSource({
        host: normalizedHost,
        projectPath,
        ref: pathSegments
          .slice(separatorIndex + 2)
          .map((segment) => decodeURIComponent(segment))
          .join("/"),
      });
    }

    const sparseFileAllowed = allowSparseFileUrl && filePath === PLUGIN_METADATA_PATH;
    if (
      (routeType === "blob" || routeType === "raw") &&
      ref &&
      (filePath === MARKETPLACE_MANIFEST_PATH || sparseFileAllowed)
    ) {
      return buildGitLabSource({
        host: normalizedHost,
        projectPath,
        ref: decodeURIComponent(ref),
      });
    }
  }

  const projectPath = pathSegments.join("/").replace(/\.git$/, "");
  return buildGitLabSource({
    host: normalizedHost,
    projectPath,
  });
}

function normalizeMarketplaceSourceInput(
  input,
  {
    allowDirectUrlSource = true,
    allowSparseFileUrl = false,
  } = {},
) {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) {
      throw createMarketplaceError("Marketplace source is required", "missing_marketplace_source");
    }

    const gitRemoteSource = parseMarketplaceSourceFromGitRemote(trimmed);
    if (gitRemoteSource) {
      return gitRemoteSource;
    }

    if (/^[^/@:\s]+\/[^/@:\s]+$/.test(trimmed)) {
      return buildGitHubSource(trimmed);
    }

    if (/^https?:\/\//i.test(trimmed)) {
      const parsedUrl = new URL(trimmed);
      if (
        parsedUrl.hostname === GITHUB_REPO_HOST ||
        parsedUrl.hostname === GITHUB_RAW_HOST
      ) {
        const gitHubSource = parseGitHubSourceFromUrl(parsedUrl);
        if (gitHubSource) {
          return gitHubSource;
        }
      }

      if (GITLAB_MARKETPLACE_AUTH_CONFIG.allowedHosts.includes(parsedUrl.host)) {
        const gitLabSource = parseGitLabSourceFromUrl(parsedUrl, {
          allowSparseFileUrl,
        });
        if (gitLabSource) {
          return gitLabSource;
        }
      }

      if (allowDirectUrlSource) {
        if (!/marketplace\.json(?:$|[?#])/i.test(parsedUrl.toString())) {
          throw createMarketplaceError(
            "Direct URLs must point to a .atlas-plugin/marketplace.json file",
            "invalid_marketplace_url",
          );
        }
        return buildUrlSource(parsedUrl.toString());
      }
    }

    throw createMarketplaceError(
      'Invalid marketplace source. Use a GitHub repo, a supported GitLab repo URL, or a direct marketplace.json URL.',
      "invalid_marketplace_source",
    );
  }

  if (!input || typeof input !== "object") {
    throw createMarketplaceError("Marketplace source is required", "missing_marketplace_source");
  }

  if (typeof input.repo === "string" && (!input.type || input.type === "github")) {
    return buildGitHubSource(input.repo, input);
  }

  if (input.type === "github") {
    return buildGitHubSource(input.repo, input);
  }

  if (input.type === "gitlab") {
    return buildGitLabSource({
      host: input.host,
      projectPath: input.projectPath,
      ref: input.ref,
      ...input,
    });
  }

  if (typeof input.url === "string" || input.type === "url") {
    const normalizedUrlSource = normalizeMarketplaceSourceInput(input.url, {
      allowDirectUrlSource,
      allowSparseFileUrl,
    });
    if (
      normalizedUrlSource.type !== "github" &&
      normalizedUrlSource.type !== "gitlab"
    ) {
      return normalizedUrlSource;
    }

    return compactObject({
      ...normalizedUrlSource,
      source:
        typeof input.source === "string" && input.source.trim()
          ? input.source.trim()
          : undefined,
      path:
        typeof input.path === "string" && input.path.trim()
          ? normalizeSkillPath(input.path)
          : undefined,
      ref:
        typeof input.ref === "string" && input.ref.trim()
          ? input.ref.trim()
          : normalizedUrlSource.ref,
    });
  }

  throw createMarketplaceError(
    "Unsupported marketplace source format",
    "invalid_marketplace_source",
  );
}

async function fetchText(url, { headers = {}, allowNotFound = false, errorMessage } = {}) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  });

  if (response.status === 404 && allowNotFound) {
    return null;
  }

  if (!response.ok) {
    throw createMarketplaceError(
      errorMessage || `Failed to fetch ${url}: HTTP ${response.status}`,
      "remote_fetch_failed",
      { status: response.status, url },
    );
  }

  return await response.text();
}

function isGitHubRateLimitCandidateUrl(url) {
  try {
    const { hostname } = new URL(url);
    const normalized = hostname.toLowerCase();
    return (
      normalized === GITHUB_API_HOST ||
      normalized === GITHUB_CODELOAD_HOST ||
      normalized === GITHUB_RAW_HOST
    );
  } catch (_) {
    return false;
  }
}

function detectGitHubRateLimit(url, response, data) {
  if (!isGitHubRateLimitCandidateUrl(url)) {
    return null;
  }
  if (response.status !== 403 && response.status !== 429) {
    return null;
  }

  const remaining = response.headers.get("x-ratelimit-remaining");
  const resetHeader = response.headers.get("x-ratelimit-reset");
  const retryAfter = response.headers.get("retry-after");
  const bodyMessage =
    (data && typeof data.message === "string" && data.message) ||
    (typeof data === "string" ? data : "") ||
    "";
  const mentionsRateLimit = /rate limit|abuse detection/i.test(bodyMessage);
  const isRateLimited =
    remaining === "0" || mentionsRateLimit || Boolean(retryAfter);
  if (!isRateLimited) {
    return null;
  }

  const resetEpochSeconds = Number(resetHeader);
  const resetDate =
    Number.isFinite(resetEpochSeconds) && resetEpochSeconds > 0
      ? new Date(resetEpochSeconds * 1000)
      : null;
  const hasToken = Boolean(
    process.env.GITHUB_TOKEN ||
      process.env.GH_TOKEN ||
      process.env.GITHUB_ACCESS_TOKEN,
  );

  const parts = ["GitHub API rate limit exceeded"];
  if (resetDate) {
    parts.push(`resets at ${resetDate.toLocaleString()}`);
  } else if (retryAfter) {
    parts.push(`retry after ${retryAfter}s`);
  }
  if (!hasToken) {
    parts.push(
      "set the GITHUB_TOKEN environment variable to raise the limit from 60 to 5,000 requests/hour",
    );
  }

  return {
    message: `${parts.join(" — ")}.`,
    resetAt: resetDate ? resetDate.toISOString() : null,
    retryAfter: retryAfter || null,
    authenticated: hasToken,
  };
}

function throwIfGitHubRateLimited(url, response, body) {
  const rateLimit = detectGitHubRateLimit(url, response, body);
  if (!rateLimit) {
    return;
  }
  throw createMarketplaceError(rateLimit.message, "github_rate_limited", {
    status: response.status,
    url,
    response: body,
    resetAt: rateLimit.resetAt,
    retryAfter: rateLimit.retryAfter,
    authenticated: rateLimit.authenticated,
  });
}

async function fetchJsonFromUrl(
  url,
  { headers = {}, allowNotFound = false, errorMessage, timeoutMs = NETWORK_TIMEOUT_MS } = {},
) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (response.status === 404 && allowNotFound) {
    return null;
  }

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throwIfGitHubRateLimited(url, response, data);

    throw createMarketplaceError(
      errorMessage || `Failed to fetch ${url}: HTTP ${response.status}`,
      "remote_fetch_failed",
      {
        status: response.status,
        url,
        response: data,
      },
    );
  }

  return data;
}

function encodeGitHubContentPath(filePath) {
  return toPosixPath(filePath)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function buildGitHubRawFileUrl(repo, ref, filePath) {
  return `https://${GITHUB_RAW_HOST}/${repo}/${encodeURIComponent(ref)}/${encodeGitHubContentPath(
    filePath,
  )}`;
}

async function fetchGitHubRepoMetadata(repo) {
  return await fetchJsonFromUrl(`${GITHUB_API_BASE_URL}/repos/${repo}`, {
    headers: githubRequestHeaders(),
    allowNotFound: true,
  });
}

async function resolveGitHubCandidateRefs(source) {
  const refs = [];
  if (source?.ref) {
    refs.push(source.ref);
  }

  const metadata = await fetchGitHubRepoMetadata(source.repo).catch(() => null);
  if (metadata?.default_branch) {
    refs.push(metadata.default_branch);
  }

  refs.push("main", "master");
  return [...new Set(refs.filter(Boolean))];
}

async function resolveGitHubRef(source) {
  if (source?.ref) {
    return source.ref;
  }

  const refs = await resolveGitHubCandidateRefs(source);
  return refs[0] || "main";
}

function resolveGitHubRawCandidateRefs(source) {
  const refs = [];
  if (source?.ref) {
    refs.push(source.ref);
  }
  refs.push("main", "master");
  return [...new Set(refs.filter(Boolean))];
}

async function fetchGitHubRawFileContent(source, filePath) {
  const candidateRefs = resolveGitHubRawCandidateRefs(source);

  for (const candidateRef of candidateRefs) {
    const url = buildGitHubRawFileUrl(source.repo, candidateRef, filePath);
    let response = null;
    try {
      response = await fetch(url, {
        headers: githubRawRequestHeaders(),
        signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
      });
    } catch (_) {
      continue;
    }

    if (!response.ok) {
      continue;
    }

    return {
      ref: candidateRef,
      content: await response.text(),
    };
  }

  return null;
}

async function fetchGitHubFileContent(source, filePath, { allowNotFound = false } = {}) {
  const rawFile = await fetchGitHubRawFileContent(source, filePath);
  if (rawFile) {
    return rawFile;
  }

  const candidateRefs = await resolveGitHubCandidateRefs(source);
  let lastError = null;

  for (const candidateRef of candidateRefs) {
    const url = `${GITHUB_API_BASE_URL}/repos/${source.repo}/contents/${encodeGitHubContentPath(
      filePath,
    )}?ref=${encodeURIComponent(candidateRef)}`;
    try {
      const data = await fetchJsonFromUrl(url, {
        headers: githubRequestHeaders(),
        allowNotFound: true,
        errorMessage: `Failed to fetch ${filePath} from GitHub repository ${source.repo}`,
      });

      if (!data) {
        continue;
      }

      const content =
        data.encoding === "base64" && typeof data.content === "string"
          ? Buffer.from(data.content.replace(/\s+/g, ""), "base64").toString("utf8")
          : null;

      if (content == null) {
        throw createMarketplaceError(
          `GitHub file ${filePath} in ${source.repo} was not returned as a file`,
          "github_invalid_file_payload",
        );
      }

      return {
        ref: candidateRef,
        content,
      };
    } catch (error) {
      lastError = error;
      if (error?.status !== 404) {
        throw error;
      }
    }
  }

  if (allowNotFound) {
    return null;
  }

  throw (
    lastError ||
    createMarketplaceError(
      `Failed to fetch ${filePath} from GitHub repository ${source.repo}`,
      "remote_fetch_failed",
    )
  );
}

async function getGitLabAuthSession(host, { interactiveAuth = false } = {}) {
  const gitlabAuth = require("./gitlab-marketplace-auth");
  return await gitlabAuth.getAuthorizedSession({
    host,
    interactive: interactiveAuth,
  });
}

function buildGitLabRequestHeaders(accessToken, accept = "application/json") {
  return compactObject({
    Accept: accept,
    Authorization: accessToken ? `Bearer ${accessToken}` : undefined,
  });
}

async function readGitLabErrorPayload(response) {
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/json")) {
    return await response.json().catch(() => null);
  }

  const text = await response.text().catch(() => "");
  return text ? text.slice(0, 500) : null;
}

async function fetchGitLabApiResponse(
  url,
  {
    accessToken,
    allowNotFound = false,
    errorMessage,
    accept = "application/json",
    timeoutMs = NETWORK_TIMEOUT_MS,
  } = {},
) {
  const response = await fetch(url, {
    headers: buildGitLabRequestHeaders(accessToken, accept),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (response.status === 404 && allowNotFound) {
    return null;
  }

  if (!response.ok) {
    const data = await readGitLabErrorPayload(response);
    throw createMarketplaceError(
      errorMessage || `GitLab request failed: HTTP ${response.status}`,
      response.status === 401 || response.status === 403
        ? "gitlab_auth_failed"
        : "remote_fetch_failed",
      {
        status: response.status,
        url,
        response: data,
      },
    );
  }

  return response;
}

async function fetchGitLabJson(
  url,
  host,
  {
    interactiveAuth = false,
    allowNotFound = false,
    errorMessage,
    accessToken,
    timeoutMs = NETWORK_TIMEOUT_MS,
  } = {},
) {
  const session =
    accessToken != null
      ? { accessToken }
      : await getGitLabAuthSession(host, { interactiveAuth });
  const response = await fetchGitLabApiResponse(url, {
    accessToken: session.accessToken,
    allowNotFound,
    errorMessage,
    accept: "application/json",
    timeoutMs,
  });

  if (!response) {
    return null;
  }

  const data = await response.json().catch(() => null);
  return data;
}

async function fetchGitLabProject(source, { interactiveAuth = false } = {}) {
  const projectPath = encodeURIComponent(source.projectPath);
  const baseUrl = buildGitLabBaseUrl(source.host);
  return await fetchGitLabJson(`${baseUrl}/api/v4/projects/${projectPath}`, source.host, {
    interactiveAuth,
    errorMessage: `Failed to read GitLab project metadata for ${source.projectPath}`,
  });
}

async function resolveGitLabSource(source, { interactiveAuth = false } = {}) {
  if (source.ref) {
    return buildGitLabSource(source);
  }

  const project = await fetchGitLabProject(source, { interactiveAuth });
  return buildGitLabSource({
    ...source,
    ref: project?.default_branch || "main",
  });
}

async function resolveGitLabAccess(
  source,
  { interactiveAuth = false, resolvedSource = null, accessToken = null } = {},
) {
  const nextResolvedSource =
    resolvedSource || (await resolveGitLabSource(source, { interactiveAuth }));
  const nextAccessToken =
    accessToken || (await getGitLabAuthSession(nextResolvedSource.host, { interactiveAuth })).accessToken;
  const baseUrl = buildGitLabBaseUrl(nextResolvedSource.host);
  const projectId = encodeURIComponent(nextResolvedSource.projectPath);

  return {
    resolvedSource: nextResolvedSource,
    accessToken: nextAccessToken,
    baseUrl,
    projectId,
  };
}

async function fetchGitLabFilePayload(
  source,
  filePath,
  {
    interactiveAuth = false,
    allowNotFound = false,
    resolvedSource = null,
    accessToken = null,
  } = {},
) {
  const access = await resolveGitLabAccess(source, {
    interactiveAuth,
    resolvedSource,
    accessToken,
  });
  const encodedFilePath = encodeURIComponent(toPosixPath(filePath));
  const data = await fetchGitLabJson(
    `${access.baseUrl}/api/v4/projects/${access.projectId}/repository/files/${encodedFilePath}?ref=${encodeURIComponent(
      access.resolvedSource.ref,
    )}`,
    access.resolvedSource.host,
    {
      interactiveAuth,
      allowNotFound,
      errorMessage: `Failed to fetch ${filePath} from GitLab repository ${access.resolvedSource.projectPath}`,
      accessToken: access.accessToken,
    },
  );

  if (!data) {
    return null;
  }

  const content =
    data.encoding === "base64" && typeof data.content === "string"
      ? Buffer.from(data.content.replace(/\s+/g, ""), "base64")
      : null;

  if (content == null) {
    throw createMarketplaceError(
      `GitLab file ${filePath} in ${access.resolvedSource.projectPath} was not returned as a file`,
      "gitlab_invalid_file_payload",
    );
  }

  return {
    source: access.resolvedSource,
    content,
  };
}

async function fetchGitLabFileContent(
  source,
  filePath,
  { interactiveAuth = false, allowNotFound = false } = {},
) {
  const payload = await fetchGitLabFilePayload(source, filePath, {
    interactiveAuth,
    allowNotFound,
  });

  if (!payload) {
    return null;
  }

  return {
    source: payload.source,
    content: payload.content.toString("utf8"),
  };
}

async function fetchGitLabTreeEntries(
  source,
  {
    interactiveAuth = false,
    treePath = "",
    recursive = false,
    allowNotFound = false,
    resolvedSource = null,
    accessToken = null,
  } = {},
) {
  const access = await resolveGitLabAccess(source, {
    interactiveAuth,
    resolvedSource,
    accessToken,
  });
  const relativeTreePath = trimRepoRelativePath(treePath);
  const entries = [];
  let nextPage = "1";

  while (nextPage) {
    const params = new URLSearchParams({
      ref: access.resolvedSource.ref,
      page: nextPage,
      per_page: "100",
    });
    if (recursive) {
      params.set("recursive", "true");
    }
    if (relativeTreePath) {
      params.set("path", relativeTreePath);
    }

    const response = await fetchGitLabApiResponse(
      `${access.baseUrl}/api/v4/projects/${access.projectId}/repository/tree?${params.toString()}`,
      {
        accessToken: access.accessToken,
        allowNotFound: allowNotFound && entries.length === 0,
        errorMessage: relativeTreePath
          ? `Failed to read GitLab repository tree for ${access.resolvedSource.projectPath}:${relativeTreePath}`
          : `Failed to read GitLab repository tree for ${access.resolvedSource.projectPath}`,
      },
    );

    if (!response) {
      return {
        source: access.resolvedSource,
        entries: [],
        accessToken: access.accessToken,
      };
    }

    const pageEntries = await response.json().catch(() => null);
    if (!Array.isArray(pageEntries)) {
      throw createMarketplaceError(
        `GitLab repository tree for ${access.resolvedSource.projectPath} returned an invalid payload`,
        "gitlab_invalid_tree_payload",
      );
    }

    entries.push(...pageEntries);
    nextPage = response.headers.get("x-next-page") || "";
  }

  return {
    source: access.resolvedSource,
    entries,
    accessToken: access.accessToken,
  };
}

async function downloadToFile(url, destinationPath, { headers = {}, errorMessage } = {}) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS * 2),
  });

  if (!response.ok) {
    if (isGitHubRateLimitCandidateUrl(url)) {
      const bodyText = await response.text().catch(() => "");
      let parsedBody = bodyText || null;
      if (bodyText) {
        try {
          parsedBody = JSON.parse(bodyText);
        } catch (_) {
          parsedBody = bodyText;
        }
      }
      throwIfGitHubRateLimited(url, response, parsedBody);
    }

    throw createMarketplaceError(
      errorMessage || `Failed to download ${url}: HTTP ${response.status}`,
      "archive_download_failed",
      {
        status: response.status,
        url,
      },
    );
  }

  const data = Buffer.from(await response.arrayBuffer());
  await fsPromises.writeFile(destinationPath, data);
}

async function extractTarball(tarballPath, destinationDir) {
  await execFilePromise("tar", ["-xzf", tarballPath, "-C", destinationDir], {
    timeout: 60000,
    maxBuffer: 20 * 1024 * 1024,
  });
}

async function extractRepositoryArchive({ archiveUrl, headers = {}, errorMessage }) {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "marketplace-"));
  const tarballPath = path.join(tempDir, "repo.tar.gz");
  await downloadToFile(archiveUrl, tarballPath, { headers, errorMessage });
  await extractTarball(tarballPath, tempDir);

  const entries = await fsPromises.readdir(tempDir, { withFileTypes: true });
  const rootEntry = entries.find(
    (entry) => entry.isDirectory() && !entry.name.startsWith("."),
  );
  if (!rootEntry) {
    throw createMarketplaceError(
      "Repository archive did not contain an extracted root directory",
      "archive_extract_failed",
    );
  }

  return {
    tempDir,
    rootDir: path.join(tempDir, rootEntry.name),
    async cleanup() {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    },
  };
}

async function extractGitHubRepository(source) {
  const resolvedRef = await resolveGitHubRef(source);
  const archive = await extractRepositoryArchive({
    archiveUrl: `https://codeload.github.com/${source.repo}/tar.gz/${encodeURIComponent(
      resolvedRef,
    )}`,
    headers: githubRequestHeaders(),
    errorMessage: `Failed to download GitHub archive for ${source.repo}`,
  });
  return {
    ...archive,
    source: buildGitHubSource(source.repo, {
      ...source,
      ref: resolvedRef,
    }),
  };
}

async function scanSkillDirectories(baseDir, repoRoot, collected) {
  let entries = [];
  try {
    entries = await fsPromises.readdir(baseDir, { withFileTypes: true });
  } catch {
    return;
  }

  let hasSkillFile = false;
  for (const entry of entries) {
    if (entry.isFile() && entry.name === "SKILL.md") {
      hasSkillFile = true;
    }
  }

  if (hasSkillFile) {
    const relativePath = toPosixPath(path.relative(repoRoot, baseDir));
    collected.add(normalizeSkillPath(relativePath));
    // Atlas Code's rule: the OUTERMOST SKILL.md wins. Anything below a skill
    // directory is that skill's reference material, never another skill
    // (zoom-plugin ships platform subtrees whose own SKILL.md files would
    // otherwise register as duplicate leaf ids).
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    await scanSkillDirectories(path.join(baseDir, entry.name), repoRoot, collected);
  }
}

// Post-pass twin of scanSkillDirectories' outermost-wins rule for discovery
// modes that see a flat file listing (GitLab tree entries) instead of walking
// directories: drop any skill path nested under another discovered skill path.
function pruneNestedSkillPaths(skillPaths) {
  const sorted = [...new Set((skillPaths || []).map(normalizeSkillPath))].sort();
  const kept = [];
  for (const skillPath of sorted) {
    const relative = trimRepoRelativePath(skillPath);
    const nested = kept.some((keptPath) => {
      const keptRelative = trimRepoRelativePath(keptPath);
      if (keptRelative === relative) {
        return false;
      }
      return keptRelative === "" || relative.startsWith(`${keptRelative}/`);
    });
    if (!nested) {
      kept.push(skillPath);
    }
  }
  return kept;
}

async function discoverSkillPathsFromRepositorySubtree(rootDir, subtreePath = "./") {
  const discovered = new Set();
  const relativeRoot = trimRepoRelativePath(subtreePath);
  const absoluteRoot = relativeRoot
    ? path.join(rootDir, ...relativeRoot.split("/"))
    : rootDir;
  await scanSkillDirectories(absoluteRoot, rootDir, discovered);
  return [...discovered].sort();
}

function discoverSkillPathsFromTreeEntries(entries, subtreePath = "./") {
  const relativeRoot = trimRepoRelativePath(subtreePath);
  const discovered = new Set();

  for (const entry of entries) {
    if (entry?.type !== "blob") {
      continue;
    }

    const normalizedEntryPath = trimRepoRelativePath(entry.path);
    if (
      normalizedEntryPath !== "SKILL.md" &&
      !normalizedEntryPath.endsWith("/SKILL.md")
    ) {
      continue;
    }

    const skillDir = trimRepoRelativePath(path.posix.dirname(normalizedEntryPath));
    if (
      relativeRoot &&
      skillDir !== relativeRoot &&
      !skillDir.startsWith(`${relativeRoot}/`)
    ) {
      continue;
    }

    discovered.add(normalizeSkillPath(skillDir));
  }

  // Callers apply pruneNestedSkillPaths (outermost SKILL.md wins); returning
  // the raw set keeps the before/after prune diagnostics honest.
  return [...discovered].sort();
}

async function createRepositorySkillInspector(source, options = {}) {
  let extracted = null;

  if (source.type === "github") {
    extracted = await extractGitHubRepository(source);
    return {
      async discoverSkillPaths(subtreePath) {
        return await discoverSkillPathsFromRepositorySubtree(
          extracted.rootDir,
          subtreePath,
        );
      },
      async cleanup() {
        await extracted.cleanup().catch(() => {});
      },
    };
  }

  if (source.type === "gitlab") {
    const tree = await fetchGitLabTreeEntries(source, {
      interactiveAuth: options.interactiveAuth === true,
      recursive: true,
    });
    return {
      async discoverSkillPaths(subtreePath) {
        return discoverSkillPathsFromTreeEntries(tree.entries, subtreePath);
      },
      async cleanup() {},
    };
  }

  throw createMarketplaceError(
    `Bundle skill discovery is not supported for source type "${source.type}"`,
    "unsupported_marketplace_source",
  );
}

async function normalizeMarketplaceManifest(manifest, marketplaceSource, options = {}) {
  if (!manifest || !Array.isArray(manifest.plugins)) {
    return { manifest, changed: false };
  }

  let changed = false;
  const normalizedPlugins = [];
  const inspectorCache = new Map();

  async function getInspector(remoteSource) {
    const cacheKey = JSON.stringify(remoteSource);
    let inspectorPromise = inspectorCache.get(cacheKey);
    if (!inspectorPromise) {
      inspectorPromise = createRepositorySkillInspector(remoteSource, options);
      inspectorCache.set(cacheKey, inspectorPromise);
    }
    return await inspectorPromise;
  }

  function degradePlugin(plugin, unavailableReason, error = null) {
    if (
      plugin?.unavailable === true &&
      plugin?.unavailableReason === unavailableReason
    ) {
      normalizedPlugins.push(plugin);
      return;
    }
    logMarketplaceDiag(
      "plugin",
      "normalize:degraded",
      compactObject({
        marketplaceName: manifest.name || "marketplace",
        pluginName: plugin?.name,
        reason: unavailableReason,
        ...(error ? safeErrorMeta(error) : {}),
      }),
      "warn",
    );
    normalizedPlugins.push({
      ...plugin,
      unavailable: true,
      unavailableReason,
    });
    changed = true;
  }

  // Cross-repo plugin sources must independently pass the marketplace
  // allowlist; same-repo object sources inherit their marketplace's standing
  // (grandfathered marketplaces keep working). Returns null when the plugin
  // was degraded and needs no further processing.
  function resolvePluginRemoteSource(plugin) {
    const objectSource =
      plugin.source && typeof plugin.source === "object" ? plugin.source : null;
    let remoteSource;
    try {
      remoteSource = resolveRemoteSkillSource(objectSource, marketplaceSource);
    } catch (error) {
      logMarketplaceDiag(
        "plugin",
        "resolve:failed",
        {
          marketplaceName: manifest.name || "marketplace",
          ...safeErrorMeta(error),
        },
        "warn",
      );
      degradePlugin(plugin, "plugin_source_invalid", error);
      return null;
    }
    if (
      objectSource &&
      !isSameRepositorySource(remoteSource, marketplaceSource) &&
      !isAllowedMarketplaceSource(remoteSource)
    ) {
      logMarketplaceDiag("policy", "plugin-source:rejected", {
        marketplaceName: manifest.name || "marketplace",
        sourceType: remoteSource?.type || "unknown",
      });
      degradePlugin(plugin, "source_not_allowed");
      return null;
    }
    return remoteSource;
  }

  try {
    for (const plugin of manifest.plugins) {
      if (!plugin || typeof plugin !== "object") {
        normalizedPlugins.push(plugin);
        continue;
      }

      // One bad plugin never fails its marketplace: any throw below degrades
      // this plugin to unavailable and the loop continues.
      try {
        if (Array.isArray(plugin.skills)) {
          if (
            plugin.source &&
            typeof plugin.source === "object" &&
            marketplaceSource &&
            marketplaceSource.type !== "url" &&
            resolvePluginRemoteSource(plugin) === null
          ) {
            continue;
          }
          const normalizedSkills = [...new Set(plugin.skills.map(normalizeSkillPath))].sort();
          if (!arrayShallowEqual(normalizedSkills, plugin.skills)) {
            changed = true;
            normalizedPlugins.push({
              ...plugin,
              skills: normalizedSkills,
            });
            continue;
          }
          normalizedPlugins.push(plugin);
          continue;
        }

        const normalizedSkillPath = getPluginSourcePath(plugin);
        const normalizedPlugin = normalizePluginSourcePath(plugin, normalizedSkillPath);
        if (normalizedPlugin !== plugin) {
          changed = true;
        }

        if (!marketplaceSource || marketplaceSource.type === "url") {
          normalizedPlugins.push(normalizedPlugin);
          continue;
        }

        // Already-degraded plugins are not re-inspected (no network to dead
        // or disallowed sources); a real sync rebuilds the manifest from the
        // remote and lets them recover.
        if (normalizedPlugin.unavailable === true) {
          normalizedPlugins.push(normalizedPlugin);
          continue;
        }

        const remoteSource = resolvePluginRemoteSource(normalizedPlugin);
        if (remoteSource === null) {
          continue;
        }
        // A persisted root-skill verdict means this plugin was already
        // inspected and the plugin path IS the skill; skipping the inspector
        // here is what keeps steady-state config loads network-free.
        if (normalizedPlugin.rootSkill === true) {
          normalizedPlugins.push(normalizedPlugin);
          continue;
        }
        const inspector = await getInspector(remoteSource);
        const rawSkillPaths = await inspector.discoverSkillPaths(normalizedSkillPath);
        const discoveredSkillPaths = pruneNestedSkillPaths(rawSkillPaths);
        if (discoveredSkillPaths.length !== rawSkillPaths.length) {
          logMarketplaceDiag("scan", "skills:discovered", {
            marketplaceName: manifest.name || "marketplace",
            beforePruneCount: rawSkillPaths.length,
            afterPruneCount: discoveredSkillPaths.length,
            prunedPaths: rawSkillPaths.filter(
              (skillPath) => !discoveredSkillPaths.includes(skillPath),
            ),
          });
        }
        const hasRootSkill = discoveredSkillPaths.includes(normalizedSkillPath);

        if (!hasRootSkill && discoveredSkillPaths.length > 0) {
          validateUniqueSkillIds(discoveredSkillPaths, {
            marketplaceName: manifest.name || "marketplace",
            pluginName: normalizedPlugin.name || normalizedSkillPath,
            errorCode: "marketplace_duplicate_skill_id",
          });
          normalizedPlugins.push({
            ...normalizedPlugin,
            skills: discoveredSkillPaths,
          });
          changed = true;
          continue;
        }

        if (hasRootSkill) {
          // Persist the verdict so the repository is not re-inspected on
          // every load. A skills[] array would change the install FQN from
          // mp/leaf to mp/plugin/leaf and orphan existing installs, so a
          // separate marker carries "inspected — the plugin itself is the
          // skill" instead.
          normalizedPlugins.push({ ...normalizedPlugin, rootSkill: true });
          changed = true;
          continue;
        }

        // Inspected and found NO skill anywhere under the plugin path:
        // offering it as installable would produce a dead SKILL.md-less
        // install, so degrade it (persisted; sync rebuilds the manifest and
        // lets it recover when skills appear upstream).
        degradePlugin(normalizedPlugin, "marketplace_no_skills_found");
        changed = true;
      } catch (error) {
        degradePlugin(plugin, error?.code || "plugin_normalize_failed", error);
      }
    }
  } finally {
    for (const inspectorPromise of inspectorCache.values()) {
      const inspector = await inspectorPromise.catch(() => null);
      if (inspector?.cleanup) {
        await inspector.cleanup().catch(() => {});
      }
    }
  }

  if (!changed) {
    return { manifest, changed: false };
  }

  return {
    manifest: {
      ...manifest,
      plugins: normalizedPlugins,
    },
    changed: true,
  };
}

async function discoverSparseSkillPathsFromRepository(rootDir) {
  const discovered = new Set();
  for (const relativeRoot of SPARSE_SKILL_ROOTS) {
    const absoluteRoot = path.join(rootDir, ...relativeRoot.split("/"));
    await scanSkillDirectories(absoluteRoot, rootDir, discovered);
  }
  return [...discovered].sort();
}

async function discoverSparseSkillPathsFromSource(source, options = {}) {
  let extracted;
  try {
    if (source.type === "github") {
      extracted = await extractGitHubRepository(source);
    } else if (source.type === "gitlab") {
      const tree = await fetchGitLabTreeEntries(source, {
        interactiveAuth: options.interactiveAuth === true,
        recursive: true,
      });
      const discovered = new Set();
      for (const entry of tree.entries) {
        if (entry?.type !== "blob") {
          continue;
        }

        const normalizedEntryPath = trimRepoRelativePath(entry.path);
        if (
          normalizedEntryPath !== "SKILL.md" &&
          !normalizedEntryPath.endsWith("/SKILL.md")
        ) {
          continue;
        }

        const skillDir = trimRepoRelativePath(path.posix.dirname(normalizedEntryPath));
        if (
          !SPARSE_SKILL_ROOTS.some(
            (root) => skillDir === root || skillDir.startsWith(`${root}/`),
          )
        ) {
          continue;
        }

        discovered.add(normalizeSkillPath(skillDir));
      }

      return {
        source: tree.source,
        skillPaths: pruneNestedSkillPaths([...discovered]),
      };
    } else {
      throw createMarketplaceError(
        `Sparse marketplace discovery is not supported for source type "${source.type}"`,
        "unsupported_sparse_source",
      );
    }

    const skillPaths = await discoverSparseSkillPathsFromRepository(extracted.rootDir);
    return {
      source: extracted.source,
      skillPaths,
    };
  } finally {
    if (extracted?.cleanup) {
      await extracted.cleanup().catch(() => {});
    }
  }
}

async function loadMarketplaceDefinitionFromUrl(source) {
  if (!/marketplace\.json(?:$|[?#])/i.test(source.url)) {
    throw createMarketplaceError(
      "Direct marketplace URLs must point to a marketplace.json file",
      "invalid_marketplace_url",
    );
  }

  const manifest = await fetchJsonFromUrl(source.url, {
    errorMessage: `Failed to fetch marketplace manifest from ${source.url}`,
  });

  if (!manifest || !manifest.name) {
    throw createMarketplaceError(
      "Invalid marketplace manifest: missing name",
      "invalid_marketplace_manifest",
    );
  }

  const normalizedManifest = await normalizeMarketplaceManifest(
    manifest,
    buildUrlSource(source.url),
  );

  return {
    source: buildUrlSource(source.url),
    manifest: normalizedManifest.manifest,
    isSparse: false,
    manifestSource: "marketplace-json",
  };
}

// Normalized-manifest cache for the repo-hosted marketplace.json paths.
// Plugin inspection dominates sync time (manifestMs ≈ 9.3s for a 128-plugin
// catalog) and derives from the manifest plus the trees it references:
// unchanged manifest BYTES reuse the previous inspection verdicts (per app
// run). Staleness bound, documented on purpose: a catalog listing of an
// UNINSTALLED plugin can lag a tree move that does not touch marketplace.json
// — installed skills are unaffected (the sync's per-skill sha gate governs
// them) and any manifest byte change or app restart re-inspects. Hits return
// a deep clone so callers can never mutate the cached verdicts.
const normalizedManifestCache = new Map(); // cacheKey -> { hash, promise }

function normalizeManifestCached(cacheKey, rawContent, normalize) {
  const hash = crypto
    .createHash("sha256")
    .update(String(rawContent || ""))
    .digest("hex");
  const cached = normalizedManifestCache.get(cacheKey);
  if (!cached || cached.hash !== hash) {
    const promise = normalize().catch((error) => {
      // A failed inspection must not poison the cache.
      if (normalizedManifestCache.get(cacheKey)?.promise === promise) {
        normalizedManifestCache.delete(cacheKey);
      }
      throw error;
    });
    normalizedManifestCache.set(cacheKey, { hash, promise });
  }
  return normalizedManifestCache
    .get(cacheKey)
    .promise.then((value) => JSON.parse(JSON.stringify(value)));
}

async function loadGitHubMarketplaceDefinition(source, options = {}) {
  const normalizedSource = buildGitHubSource(source.repo, source);
  const manifestFile = await fetchGitHubFileContent(normalizedSource, MARKETPLACE_MANIFEST_PATH, {
    allowNotFound: true,
  });

  if (manifestFile) {
    const manifest = JSON.parse(manifestFile.content);
    if (!manifest?.name) {
      throw createMarketplaceError(
        "Invalid marketplace manifest: missing name",
        "invalid_marketplace_manifest",
      );
    }

    const resolvedSource = buildGitHubSource(normalizedSource.repo, {
      ...normalizedSource,
      ref: manifestFile.ref,
    });
    const normalizedManifest = await normalizeManifestCached(
      `github:${normalizedSource.repo}:${manifestFile.ref || ""}:${options?.interactiveAuth !== false}`,
      manifestFile.content,
      () => normalizeMarketplaceManifest(manifest, resolvedSource, options),
    );

    return {
      source: resolvedSource,
      manifest: normalizedManifest.manifest,
      isSparse: false,
      manifestSource: "marketplace-json",
    };
  }

  const pluginFile = await fetchGitHubFileContent(normalizedSource, PLUGIN_METADATA_PATH, {
    allowNotFound: true,
  });
  if (!pluginFile) {
    return await loadSparseMarketplaceDefinitionFromSource(normalizedSource, {
      repoLabel: normalizedSource.repo,
    });
  }

  return await loadSparseMarketplaceDefinitionFromSource(
    buildGitHubSource(normalizedSource.repo, {
      ...normalizedSource,
      ref: pluginFile.ref,
    }),
    {
      pluginMetadata: JSON.parse(pluginFile.content),
      repoLabel: normalizedSource.repo,
    },
  );
}

async function loadGitLabMarketplaceDefinition(source, { interactiveAuth = true } = {}) {
  const normalizedSource = buildGitLabSource(source);
  const manifestFile = await fetchGitLabFileContent(normalizedSource, MARKETPLACE_MANIFEST_PATH, {
    interactiveAuth,
    allowNotFound: true,
  });

  if (manifestFile) {
    const manifest = JSON.parse(manifestFile.content);
    if (!manifest?.name) {
      throw createMarketplaceError(
        "Invalid marketplace manifest: missing name",
        "invalid_marketplace_manifest",
      );
    }

    const normalizedManifest = await normalizeManifestCached(
      `gitlab:${normalizedSource.projectPath}:${normalizedSource.ref || ""}:${interactiveAuth !== false}`,
      manifestFile.content,
      () => normalizeMarketplaceManifest(manifest, manifestFile.source, { interactiveAuth }),
    );

    return {
      source: manifestFile.source,
      manifest: normalizedManifest.manifest,
      isSparse: false,
      manifestSource: "marketplace-json",
    };
  }

  const pluginFile = await fetchGitLabFileContent(normalizedSource, PLUGIN_METADATA_PATH, {
    interactiveAuth,
    allowNotFound: true,
  });

  if (!pluginFile) {
    return await loadSparseMarketplaceDefinitionFromSource(normalizedSource, {
      interactiveAuth,
      repoLabel: normalizedSource.projectPath,
    });
  }

  return await loadSparseMarketplaceDefinitionFromSource(pluginFile.source, {
    interactiveAuth,
    pluginMetadata: JSON.parse(pluginFile.content),
    repoLabel: normalizedSource.projectPath,
  });
}

async function loadMarketplaceDefinition(source, options = {}) {
  const normalizedSource = normalizeMarketplaceSourceInput(source, {
    allowDirectUrlSource: true,
    allowSparseFileUrl: true,
  });

  if (normalizedSource.type === "github") {
    return await loadGitHubMarketplaceDefinition(normalizedSource, options);
  }

  if (normalizedSource.type === "gitlab") {
    return await loadGitLabMarketplaceDefinition(normalizedSource, options);
  }

  if (normalizedSource.type === "url") {
    return await loadMarketplaceDefinitionFromUrl(normalizedSource);
  }

  throw createMarketplaceError(
    `Unsupported marketplace source type "${normalizedSource.type}"`,
    "unsupported_marketplace_source",
  );
}

function resolveRemoteSkillSource(skillSource, marketplaceSource) {
  if (skillSource && typeof skillSource === "object") {
    const normalized = normalizeMarketplaceSourceInput(skillSource, {
      allowDirectUrlSource: false,
      allowSparseFileUrl: true,
    });
    if (
      !normalized.ref &&
      marketplaceSource?.ref &&
      isSameRepositorySource(normalized, marketplaceSource)
    ) {
      return compactObject({
        ...normalized,
        ref: marketplaceSource.ref,
      });
    }
    return normalized;
  }

  return normalizeMarketplaceSourceInput(marketplaceSource, {
    allowDirectUrlSource: true,
    allowSparseFileUrl: true,
  });
}

// Durable marketplace identity is the repository the source points at — the
// registry id (manifest.name) is only a local key. Ref/branch deliberately
// does NOT participate: the same repo at another branch is the same
// marketplace. Exported for agent-install dependency resolution.
function isSameRepositorySource(left, right) {
  if (!left || !right || left.type !== right.type) {
    return false;
  }

  if (left.type === "github") {
    // GitHub owner/repo lookups are case-insensitive.
    const leftRepo = String(left.repo || "").toLowerCase();
    const rightRepo = String(right.repo || "").toLowerCase();
    return Boolean(leftRepo && rightRepo && leftRepo === rightRepo);
  }

  if (left.type === "gitlab") {
    // Hosts are case-insensitive DNS; GitLab project paths are case-sensitive.
    const leftHost = String(left.host || "").toLowerCase();
    const rightHost = String(right.host || "").toLowerCase();
    return Boolean(
      leftHost &&
        rightHost &&
        left.projectPath &&
        right.projectPath &&
        leftHost === rightHost &&
        left.projectPath === right.projectPath,
    );
  }

  if (left.type === "url") {
    const leftUrl = String(left.url || "").trim();
    const rightUrl = String(right.url || "").trim();
    return Boolean(leftUrl && rightUrl && leftUrl === rightUrl);
  }

  return false;
}

async function downloadSkillDirectory(source, skillPath, destinationPath, options = {}) {
  const normalizedSkillPath = normalizeSkillPath(skillPath);
  let extracted;
  // Callers downloading many skills from the same github repo (the sync loop)
  // pass extractedRepoCache to share ONE tarball per repo per pass; cached
  // extractions are cleaned up by the cache owner, not per call.
  let ownsExtraction = true;

  try {
    if (source.type === "github") {
      const repoCache = options.extractedRepoCache;
      const repoCacheKey = repoCache ? remoteSkillSourceGroupKey(source) : null;
      if (repoCache && repoCacheKey) {
        if (!repoCache.has(repoCacheKey)) {
          // Cache the PROMISE before the first await so concurrent callers
          // share the same in-flight extraction (the inspectorCache pattern).
          repoCache.set(repoCacheKey, extractGitHubRepository(source));
        }
        extracted = await repoCache.get(repoCacheKey);
        ownsExtraction = false;
      } else {
        extracted = await extractGitHubRepository(source);
      }
    } else if (source.type === "gitlab") {
      const relativeSkillPath = trimRepoRelativePath(normalizedSkillPath);
      const tree = await fetchGitLabTreeEntries(source, {
        interactiveAuth: options.interactiveAuth === true,
        treePath: relativeSkillPath,
        recursive: true,
        allowNotFound: true,
        // Optional pre-resolved access (sync passes one per repo group) —
        // avoids a session-file read+decrypt per call.
        resolvedSource: options.resolvedSource ?? null,
        accessToken: options.accessToken ?? null,
      });
      const blobEntries = tree.entries.filter((entry) => entry?.type === "blob");
      if (blobEntries.length === 0) {
        throw createMarketplaceError(
          `Skill not found at path: ${normalizedSkillPath}`,
          "skill_path_not_found",
        );
      }

      await fsPromises.rm(destinationPath, { recursive: true, force: true });
      await fsPromises.mkdir(destinationPath, { recursive: true });

      // Files land at distinct destination paths, so a small parallel window
      // is safe; envelope results (never throw) so one failure surfaces the
      // FIRST-by-index error exactly like the serial loop did.
      const fileResults = await mapWithConcurrency(blobEntries, 4, async (entry) => {
        try {
          const payload = await fetchGitLabFilePayload(tree.source, entry.path, {
            interactiveAuth: options.interactiveAuth === true,
            resolvedSource: tree.source,
            accessToken: tree.accessToken,
          });
          const repoRelativePath = trimRepoRelativePath(entry.path);
          const destinationRelativePath = relativeSkillPath
            ? path.posix.relative(relativeSkillPath, repoRelativePath)
            : repoRelativePath;
          const destinationFilePath = path.join(
            destinationPath,
            ...destinationRelativePath.split("/").filter(Boolean),
          );

          await fsPromises.mkdir(path.dirname(destinationFilePath), { recursive: true });
          await fsPromises.writeFile(destinationFilePath, payload.content);

          const mode = parseInt(String(entry.mode || ""), 8);
          if (Number.isInteger(mode)) {
            await fsPromises.chmod(destinationFilePath, mode & 0o777).catch(() => {});
          }
          return { ok: true };
        } catch (error) {
          return { ok: false, error };
        }
      });
      const firstFailure = fileResults.find((result) => !result || result.ok !== true);
      if (firstFailure) {
        throw (
          firstFailure.error ||
          createMarketplaceError(
            `Failed to download skill files for ${normalizedSkillPath}`,
            "remote_fetch_failed",
          )
        );
      }

      return tree.source;
    } else {
      throw createMarketplaceError(
        "Unsupported skill source. Only GitHub and configured GitLab repositories are supported for marketplace installs.",
        "unsupported_skill_source",
      );
    }

    const sourcePath = path.join(
      extracted.rootDir,
      ...normalizedSkillPath.replace(/^\.\//, "").split("/").filter(Boolean),
    );

    try {
      await fsPromises.access(sourcePath);
    } catch {
      throw createMarketplaceError(
        `Skill not found at path: ${normalizedSkillPath}`,
        "skill_path_not_found",
      );
    }

    await fsPromises.rm(destinationPath, { recursive: true, force: true });
    await fsPromises.mkdir(path.dirname(destinationPath), { recursive: true });
    await fsPromises.cp(sourcePath, destinationPath, { recursive: true });
    return extracted.source;
  } finally {
    if (ownsExtraction && extracted?.cleanup) {
      await extracted.cleanup().catch(() => {});
    }
  }
}

function extractVersionFromSkillMd(content, fallbackVersion = "1.0") {
  try {
    const frontmatter = parseSkillMarkdownFrontmatter(content);
    return getSkillVersionFromFrontmatter(frontmatter, fallbackVersion);
  } catch {
    return fallbackVersion;
  }
}

// A record whose recorded repo path no longer exists at head: that is NOT an
// update. The flag is honest display state (the Updates tab renders "No
// longer published upstream" instead of "Updates available") and an input to
// the destructive sync, which owns resolution. It clears whenever the path
// is seen alive again (sweep probe success, successful sync fetch).
function markInstalledSourceMissing(installed) {
  installed.sourceMissing = true;
  installed.hasUpdate = false;
  installed.hasConflict = false;
  delete installed.updateHeadCommittedAt;
}

// Probe a skill's SKILL.md at its recorded repo path. The three outcomes are
// deliberately distinct: `present:true` (file fetched — version may still be
// null), `present:false` (a DEFINITIVE 404 — the skill no longer exists at
// this path at head), and `present:null` (unknown: offline, auth, or an
// unprobeable source type). The sweep classifies "source missing upstream"
// only from the definitive outcome.
async function probeRemoteSkillVersion(source, skillPath, options = {}) {
  const normalizedSkillPath = normalizeSkillPath(skillPath)
    .replace(/^\.\//, "")
    .replace(/\/+$/g, "");
  const skillMdPath = normalizedSkillPath ? `${normalizedSkillPath}/SKILL.md` : "SKILL.md";

  try {
    if (source.type === "github") {
      const file = await fetchGitHubFileContent(source, skillMdPath, {
        allowNotFound: true,
      });
      return file
        ? { present: true, version: extractVersionFromSkillMd(file.content) }
        : { present: false, version: null };
    }

    if (source.type === "gitlab") {
      const file = await fetchGitLabFileContent(source, skillMdPath, {
        interactiveAuth: options.interactiveAuth === true,
        allowNotFound: true,
      });
      return file
        ? { present: true, version: extractVersionFromSkillMd(file.content) }
        : { present: false, version: null };
    }

    return { present: null, version: null };
  } catch (error) {
    return { present: null, version: null };
  }
}

async function fetchRemoteSkillVersion(source, skillPath, options = {}) {
  const probe = await probeRemoteSkillVersion(source, skillPath, options);
  return probe.version;
}

function createMarketplaceEntry(definition, existing = {}) {
  const manifest = definition.manifest;
  return {
    ...existing,
    id: existing.id || manifest.name,
    name: manifest.name,
    description: manifest.metadata?.description || existing.description || "No description",
    source: definition.source,
    owner: manifest.owner || existing.owner || { name: "Unknown" },
    addedAt: existing.addedAt || new Date().toISOString(),
    enabled: existing.enabled !== false,
    isOfficial: existing.isOfficial === true,
    cachedManifest: manifest,
    marketplaceVersion: manifest.metadata?.version || "1.0.0",
    lastSynced: new Date().toISOString(),
    isSparse: definition.isSparse,
    manifestSource: definition.manifestSource,
  };
}

function addMarketplace(options) {
  return withRegistryWriteLock(() => addMarketplaceUnlocked(options));
}

async function addMarketplaceUnlocked({ projectRoot, sourceInput, interactiveAuth = true, logger = console }) {
  // Policy gate BEFORE any network: adding a marketplace is restricted to the
  // allowlist. This single enforcement point covers the UI modal, the
  // add_marketplace MCP tool, POST /api/marketplaces, and the agent-install
  // auto-add. Existing registry entries are grandfathered — sync/update paths
  // never pass through here.
  const requestedSource = normalizeMarketplaceSourceInput(sourceInput, {
    allowDirectUrlSource: true,
    allowSparseFileUrl: true,
  });
  try {
    assertMarketplaceSourceAllowed(requestedSource);
  } catch (error) {
    logMarketplaceDiag(
      "policy",
      "add:rejected",
      {
        sourceType: requestedSource?.type || "unknown",
        repo: requestedSource?.repo,
        host: requestedSource?.host,
        reason: error?.code || "marketplace_source_not_allowed",
        ...safeErrorMeta(error),
      },
      "error",
    );
    throw error;
  }
  logMarketplaceDiag("policy", "add:allowed", {
    sourceType: requestedSource.type,
    repo: requestedSource.repo,
    host: requestedSource.host,
    projectPath: requestedSource.projectPath,
  });

  const definition = await loadMarketplaceDefinition(requestedSource, { interactiveAuth });
  const config = await loadMarketplacesConfig(projectRoot, { logger });

  if (config.marketplaces.some((marketplace) => marketplace.id === definition.manifest.name)) {
    throw createMarketplaceError(
      `Marketplace "${definition.manifest.name}" is already configured`,
      "duplicate_marketplace",
    );
  }

  const newMarketplace = createMarketplaceEntry(definition);
  config.marketplaces.push(newMarketplace);
  await saveMarketplacesConfig(projectRoot, config);
  logger.log?.(
    `[Marketplace] marketplace added: ${newMarketplace.id} (source ${newMarketplace.source?.type || "unknown"})`,
  );
  return newMarketplace;
}

function removeMarketplace(options) {
  return withRegistryWriteLock(() => removeMarketplaceUnlocked(options));
}

async function removeMarketplaceUnlocked({
  projectRoot,
  marketplaceId,
  removeInstalledSkills = false,
  logger = console,
}) {
  const config = await loadMarketplacesConfig(projectRoot, { logger });
  const marketplace = config.marketplaces.find((entry) => entry.id === marketplaceId);
  if (!marketplace) {
    throw createMarketplaceError(
      `Marketplace "${marketplaceId}" not found`,
      "marketplace_not_found",
    );
  }

  if (marketplace.isOfficial) {
    throw createMarketplaceError(
      "Cannot remove the official Anthropic marketplace",
      "immutable_marketplace",
    );
  }

  // Out-of-the-box marketplaces (seeded from marketplaces-ootb and stamped
  // ootb:true on merge) are permanent: removal was already self-defeating —
  // the seeder re-adds them on the next config load — so fail it clearly at
  // the single chokepoint shared by the UI, IPC, HTTP API, and MCP tool.
  if (marketplace.ootb === true) {
    throw createMarketplaceError(
      "This built-in marketplace cannot be removed",
      "immutable_marketplace",
    );
  }

  config.marketplaces = config.marketplaces.filter((entry) => entry.id !== marketplaceId);

  let removedSkillsCount = 0;
  if (removeInstalledSkills) {
    const skillsToRemove = config.installedSkills.filter(
      (entry) => entry.marketplaceId === marketplaceId,
    );
    removedSkillsCount = skillsToRemove.length;
    for (const skill of skillsToRemove) {
      try {
        const skillPath = path.join(projectRoot, skill.localPath);
        await fsPromises.rm(skillPath, { recursive: true, force: true });
      } catch (error) {
        logger.log?.(
          `[Marketplace] Could not remove skill directory: ${error.message}`,
        );
      }
    }

    config.installedSkills = config.installedSkills.filter(
      (entry) => entry.marketplaceId !== marketplaceId,
    );

    const marketplaceDir = path.join(projectRoot, "skills-marketplace", marketplaceId);
    try {
      await fsPromises.rm(marketplaceDir, { recursive: true, force: true });
    } catch {
      // Directory may not exist.
    }
  }

  await saveMarketplacesConfig(projectRoot, config);
  return {
    marketplaceId,
    removedInstalledSkills: removeInstalledSkills,
    removedSkillsCount,
  };
}

// ── Mirror truth: missing-upstream detection ────────────────────────────────

// Records of a marketplace whose recorded (repo, path) no longer exists in
// its manifest. Comparisons are repo-scoped so a same-path entry in another
// plugin repo can never mask a record's absence (or vice versa). Degraded
// (unavailable) manifest entries still count as PRESENT — removal decisions
// are never made on flaky normalize evidence, only on a path that is truly
// gone from the manifest.
function collectMissingInstalledSkills(config, marketplace, marketplaceId, { logger = console } = {}) {
  const catalogEntries = parseSkillsFromManifest(
    marketplace.cachedManifest,
    marketplaceId,
    { sparse: marketplace.isSparse === true, logger },
  );
  const presentKeys = new Set();
  for (const entry of catalogEntries) {
    let repoKey = null;
    try {
      repoKey = remoteSkillSourceGroupKey(
        resolveRemoteSkillSource(entry.skillSource, marketplace.source),
      );
    } catch {
      continue;
    }
    presentKeys.add(
      `${repoKey ?? ""} ${trimRepoRelativePath(normalizeSkillPath(entry.skillPath))}`,
    );
  }

  const missing = [];
  for (const installed of config.installedSkills) {
    if (installed?.marketplaceId !== marketplaceId) continue;
    let repoKey = null;
    try {
      repoKey = remoteSkillSourceGroupKey(
        resolveRemoteSkillSource(installed.skillSource, marketplace.source),
      );
    } catch {
      continue; // malformed record: the sync loop's own try/catch reports it
    }
    const pathKey = `${repoKey ?? ""} ${trimRepoRelativePath(normalizeSkillPath(installed.skillPath))}`;
    if (!presentKeys.has(pathKey)) {
      missing.push(installed);
    }
  }
  return missing;
}

// In-place removal used by the destructive sync and the removal executor:
// payload dir, registry record, emptied parents. The publish-link sidecar is
// cleared by the IPC/HTTP layer (it is Electron-bound; this module is not).
async function removeInstalledSkillFromConfig(projectRoot, config, installed, { logger = console } = {}) {
  const skillDirPath = path.join(projectRoot, installed.localPath);
  await fsPromises.rm(skillDirPath, { recursive: true, force: true });
  config.installedSkills = config.installedSkills.filter((entry) => entry !== installed);
  await pruneEmptyInstallParents(projectRoot, installed.localPath);
  logger.log?.(
    `[Marketplace] Removed skill no longer published upstream: ${installed.marketplaceId}/${installed.skillId}`,
  );
}

// Whole-body lock: the download loop is long, but syncing outside the lock
// used to save a config loaded BEFORE the loop, clobbering any install/
// uninstall committed meanwhile (a second lost-update path).
function syncMarketplace(options) {
  return withRegistryWriteLock(() => syncMarketplaceUnlocked(options));
}

async function syncMarketplaceUnlocked({
  projectRoot,
  marketplaceId,
  interactiveAuth = true,
  logger = console,
  // Injected agent-inventory reader (agent-skill-usage-guard
  // listAgentSkillReferences shape). ABSENT or throwing → FAIL CLOSED: no
  // removal happens without a verified usage read; missing records are only
  // marked sourceMissing and reported.
  listAgentReferences = null,
}) {
  const syncStartedAt = Date.now();
  const config = await loadMarketplacesConfig(projectRoot, { logger });
  const marketplace = config.marketplaces.find((entry) => entry.id === marketplaceId);
  if (!marketplace) {
    throw createMarketplaceError(
      `Marketplace "${marketplaceId}" not found`,
      "marketplace_not_found",
    );
  }

  // Step 1: Sync marketplace metadata (existing behavior)
  const previousVersion = marketplace.marketplaceVersion;
  const manifestStartedAt = Date.now();
  const definition = await loadMarketplaceDefinition(marketplace.source, { interactiveAuth });
  const manifestMs = Date.now() - manifestStartedAt;
  const updatedMarketplace = createMarketplaceEntry(definition, marketplace);

  Object.assign(marketplace, updatedMarketplace, {
    id: marketplace.id,
  });

  // Step 1.5 — mirror truth against the FRESH manifest (the fetch above
  // throws before this point, so a stale cached manifest can never drive a
  // removal decision). Records whose recorded path no longer exists:
  //   unused                → removed here, silently (destructive by design);
  //                           except OOTB-seeded, which are bundle-managed
  //                           (the additive seeder re-adds absent seeds, so
  //                           removal can't stick) — kept as the passive row
  //   used by any agent     → pendingRemovals for the caller's consent flow;
  //                           seeded entries carry seeded:true = Proceed is
  //                           unlink-only (the skill stays until the next
  //                           bundle resolves it)
  //   usage unverifiable    → FAIL CLOSED, nothing removed
  // Every kept missing record carries the persisted sourceMissing marker so
  // sweeps and the Updates tab stay honest between syncs.
  const missingRecords = collectMissingInstalledSkills(config, marketplace, marketplaceId, { logger });
  const skippedMissing = new Set(missingRecords);
  const skillsRemoved = [];
  const skillsSourceMissing = [];
  const pendingRemovals = [];
  let agentInventoryUnavailable = false;
  if (missingRecords.length) {
    let references = null;
    if (typeof listAgentReferences === "function") {
      try {
        references = await listAgentReferences();
      } catch (error) {
        logger.warn?.(
          `[Marketplace] Sync could not verify agent usage; keeping missing skills: ${error?.message || error}`,
        );
        references = null;
      }
    }
    if (!Array.isArray(references)) {
      references = null;
      agentInventoryUnavailable = true;
    }

    // One OOTB read for the whole sweep instead of one per missing record.
    const seededKeys = await listOotbSeededKeys(projectRoot);

    for (const installed of missingRecords) {
      const reportBase = {
        skillId: installed.skillId,
        pluginName: installed.pluginName ?? null,
      };
      const seeded = seededKeys.has(`${installed.marketplaceId}/${installed.skillId}`);
      if (references === null) {
        markInstalledSourceMissing(installed);
        skillsSourceMissing.push(
          seeded ? { ...reportBase, seeded: true } : { ...reportBase, agentsUnknown: true },
        );
        continue;
      }
      const leaf = deriveSkillId(installed.skillId);
      const usedBy = references.filter((agent) => agent.leaves?.has?.(leaf));
      if (!usedBy.length) {
        // Seeded records are bundle-managed: removal can't stick (the
        // additive seeder re-adds any absent seed at every config load), so
        // an unused one just stays as the honest passive row.
        if (seeded) {
          markInstalledSourceMissing(installed);
          skillsSourceMissing.push({ ...reportBase, seeded: true });
          continue;
        }
        await removeInstalledSkillFromConfig(projectRoot, config, installed, { logger });
        skillsRemoved.push({ ...reportBase, localPath: installed.localPath });
        continue;
      }
      // In use: the user is owed the stop-or-unlink decision either way.
      // seeded:true tells the modal/executor that Proceed is unlink-only —
      // the skill itself stays until the next bundle resolves it.
      markInstalledSourceMissing(installed);
      pendingRemovals.push({
        ...reportBase,
        ...(seeded ? { seeded: true } : {}),
        leaf,
        agents: usedBy.map(({ id, name, relationship }) => ({
          id,
          name,
          relationship: relationship ?? null,
          readOnly: relationship === "installed",
        })),
      });
    }
    logMarketplaceDiag("sync", "missing:classified", {
      marketplaceId,
      missingCount: missingRecords.length,
      removedCount: skillsRemoved.length,
      pendingCount: pendingRemovals.length,
      pendingSeededCount: pendingRemovals.filter((entry) => entry.seeded === true).length,
      seededOrUnknownCount: skillsSourceMissing.length,
      agentInventoryUnavailable,
    });
  }

  // Step 2: Sync installed skills from this marketplace
  const installedFromThisMarketplace = config.installedSkills.filter(
    (entry) => entry.marketplaceId === marketplaceId && !skippedMissing.has(entry),
  );

  // Head probe once per distinct repo+ref BEFORE any download, so a stamped
  // contentHeadSha can only ever LAG the content it describes (worst case:
  // one spurious flag next sweep, cleared by the next sync), never lead it.
  // Probe failure → no stamp, never blocks the sync. NEVER write
  // skillFreshnessShas here — a group can span two marketplaces and syncing
  // one must not gate-skip the other's sweep.
  const headProbeStartedAt = Date.now();
  const syncHeadShaByGroup = new Map();
  const gitlabAccessByGroup = new Map();
  {
    const probeSources = new Map();
    for (const installed of installedFromThisMarketplace) {
      try {
        const source = resolveRemoteSkillSource(installed.skillSource, marketplace.source);
        const key = remoteSkillSourceGroupKey(source);
        if (key && !probeSources.has(key)) probeSources.set(key, source);
      } catch (_) {
        /* malformed record: the sync loop's own try/catch reports it */
      }
    }
    const probeList = [...probeSources.entries()];
    // One resolved gitlab access per repo group, shared by the probe and by
    // every download below — drops the per-call session-file read+decrypt.
    // Best-effort: a failed resolve just means those calls resolve their own
    // access exactly as before.
    await mapWithConcurrency(probeList, 4, async ([key, source]) => {
      if (source?.type !== "gitlab") return null;
      try {
        gitlabAccessByGroup.set(key, await resolveGitLabAccess(source, { interactiveAuth }));
      } catch (_) {
        /* fall back to per-call resolution */
      }
      return null;
    });
    const shas = await mapWithConcurrency(probeList, 4, ([key, source]) =>
      fetchRemoteHeadCommitSha(source, {
        interactiveAuth,
        // Best-effort leg: fail fast instead of stalling the sync 30s —
        // a missed probe just disables the skip short-circuit below.
        timeoutMs: HEAD_PROBE_TIMEOUT_MS,
        resolvedSource: gitlabAccessByGroup.get(key)?.resolvedSource ?? null,
        accessToken: gitlabAccessByGroup.get(key)?.accessToken ?? null,
      }),
    );
    probeList.forEach(([key], index) => {
      if (shas[index]) syncHeadShaByGroup.set(key, shas[index]);
    });
  }
  const headProbeMs = Date.now() - headProbeStartedAt;

  const skillSyncResults = { updated: [], conflicted: [], upToDate: [], errors: [] };
  const skillsStartedAt = Date.now();
  let skippedByHeadSha = 0;
  // One shared tarball per github repo across the whole loop (sync-owned;
  // downloadSkillDirectory skips cleanup for cached extractions).
  const extractedRepoCache = new Map();

  // Phase 1 — fetch+stage, parallel (cap 4). NO record mutations, result
  // pushes, or log lines here; bodies return outcome envelopes and never
  // throw (mapWithConcurrency nulls a thrown worker).
  const skillOutcomes = await mapWithConcurrency(
    installedFromThisMarketplace,
    4,
    async (installed) => {
      let state = null;
      let stagingPath = null;
      try {
        state = await computeInstalledSkillState(projectRoot, installed);

        const remoteSource = resolveRemoteSkillSource(installed.skillSource, marketplace.source);
        const syncGroupKey = remoteSkillSourceGroupKey(remoteSource);
        const syncHeadSha = syncGroupKey
          ? syncHeadShaByGroup.get(syncGroupKey) || null
          : null;
        const destinationPath = path.join(projectRoot, installed.localPath);
        const baselineFiles = Array.isArray(installed?.baseline?.files)
          ? installed.baseline.files
          : [];

        // Skip-unchanged short-circuit: the probed group head matching the
        // record's stamp PROVES the remote tree is the one this record last
        // fetched, and the compare below is remote-vs-BASELINE — so a clean,
        // baselined record would land in the "current" branch bit-for-bit.
        // Guards route everything else to the full download: dirty records
        // (need remoteVersion for lastCheckedVersion + conflict handling),
        // baseline-less records (need the baseline backfill; their isDirty
        // is vacuously false), legacy unstamped records, failed probes, and
        // stale sourceMissing flags (the download is what heals them).
        if (
          syncHeadSha &&
          installed.contentHeadSha === syncHeadSha &&
          !state.isDirty &&
          baselineFiles.length > 0 &&
          installed.sourceMissing !== true
        ) {
          // Clean + sha-match ⇒ local bytes === remote bytes, so the local
          // copy reproduces remoteVersion exactly.
          const remoteVersion = await readInstalledSkillVersion(destinationPath, "1.0");
          return { kind: "skipped_current", state, syncHeadSha, remoteVersion };
        }

        stagingPath = path.join(
          path.dirname(destinationPath),
          `.${path.basename(destinationPath)}.sync-${crypto.randomUUID()}`,
        );
        const syncGroupAccess = syncGroupKey
          ? gitlabAccessByGroup.get(syncGroupKey) || null
          : null;
        const persistedSource = await downloadSkillDirectory(
          remoteSource,
          installed.skillPath,
          stagingPath,
          {
            interactiveAuth,
            resolvedSource: syncGroupAccess?.resolvedSource ?? null,
            accessToken: syncGroupAccess?.accessToken ?? null,
            extractedRepoCache,
          },
        );
        const remoteVersion = await readInstalledSkillVersion(stagingPath, "1.0");
        const remoteFiles = await snapshotSkillDirectory(stagingPath);
        const comparisonFiles = baselineFiles.length > 0
          ? baselineFiles
          : await snapshotSkillDirectory(destinationPath);
        return {
          kind: "fetched",
          state,
          stagingPath,
          persistedSource,
          remoteVersion,
          syncHeadSha,
          contentChanged: snapshotsDiffer(remoteFiles, comparisonFiles),
          baselineWasEmpty: baselineFiles.length === 0,
        };
      } catch (error) {
        if (stagingPath) {
          await fsPromises.rm(stagingPath, { recursive: true, force: true }).catch(() => {});
        }
        return { kind: "failed", state, error };
      }
    },
  );
  // The shared github extractions live only for the fetch phase.
  for (const extractionPromise of extractedRepoCache.values()) {
    const extraction = await extractionPromise.catch(() => null);
    await extraction?.cleanup?.().catch(() => {});
  }

  // Phase 2 — ordered apply, serial in input order: all record mutations,
  // result pushes, and log lines happen here, so results, logs, and the
  // config bytes are deterministic regardless of fetch completion order.
  try {
    for (let index = 0; index < installedFromThisMarketplace.length; index += 1) {
      const installed = installedFromThisMarketplace[index];
      const outcome =
        skillOutcomes[index] ||
        ({ kind: "failed", state: null, error: new Error("sync outcome missing") });
      try {
        if (outcome.state) installed.isDirty = outcome.state.isDirty;

        if (outcome.kind === "failed") {
          throw outcome.error;
        }

        if (outcome.kind === "skipped_current") {
          installed.hasUpdate = false;
          installed.hasConflict = false;
          delete installed.updateHeadCommittedAt;
          installed.lastCheckedVersion = outcome.remoteVersion;
          // Re-stamp is a no-op (the gate required equality) but keeps this
          // branch field-for-field parallel to the fetched "current" branch.
          installed.contentHeadSha = outcome.syncHeadSha;
          skillSyncResults.upToDate.push({
            skillId: installed.skillId,
            reason: "content_unchanged",
          });
          skippedByHeadSha += 1;
          continue;
        }

        const {
          stagingPath,
          persistedSource,
          remoteVersion,
          syncHeadSha,
          contentChanged,
          baselineWasEmpty,
        } = outcome;
        const destinationPath = path.join(projectRoot, installed.localPath);
        const versionChanged = hasNewerVersion(installed.installedVersion, remoteVersion);
        const updateKind = versionChanged ? "version" : "content";

        if (!contentChanged) {
          installed.hasUpdate = false;
          installed.hasConflict = false;
          delete installed.updateHeadCommittedAt;
          delete installed.sourceMissing; // fetch succeeded — path is alive
          delete installed.sourceMissingSince;
          installed.lastCheckedVersion = remoteVersion;
          // Content proven identical to the head tree we just fetched:
          // advancing the drift baseline is sound. Probe failure keeps any
          // existing stamp (content unchanged, old stamp still valid).
          if (syncHeadSha) installed.contentHeadSha = syncHeadSha;
          if (baselineWasEmpty) {
            installed.baseline = await buildInstalledSkillBaseline(destinationPath, {
              installedVersion: installed.installedVersion,
              sourceRef: persistedSource?.ref,
            });
          }
          skillSyncResults.upToDate.push({
            skillId: installed.skillId,
            reason: "content_unchanged",
          });
          continue;
        }

        if (installed.isDirty) {
          installed.hasUpdate = true;
          installed.hasConflict = true;
          delete installed.sourceMissing; // fetch succeeded — path is alive
          delete installed.sourceMissingSince;
          installed.lastCheckedVersion = remoteVersion;
          skillSyncResults.conflicted.push({
            skillId: installed.skillId,
            remoteVersion,
            updateKind,
          });
          logger.warn?.(
            `[Marketplace] Preserved local changes for ${marketplaceId}/${installed.skillId}; remote ${updateKind} update requires conflict resolution`,
          );
          continue;
        }

        const baseline = await buildInstalledSkillBaseline(stagingPath, {
          installedVersion: remoteVersion,
          sourceRef: persistedSource?.ref,
        });
        await replaceSkillDirectoryFromStaging(destinationPath, stagingPath);
        outcome.stagingPath = null;

        const previousSkillVersion = installed.installedVersion;
        installed.installedVersion = remoteVersion;
        installed.lastCheckedVersion = remoteVersion;
        installed.hasUpdate = false;
        installed.isDirty = false;
        installed.hasConflict = false;
        delete installed.updateHeadCommittedAt;
        delete installed.sourceMissing; // fetch succeeded — path is alive
        delete installed.sourceMissingSince;
        installed.baseline = baseline;
        // Content was just replaced: stamp the fetched head, or DELETE a stale
        // stamp when the probe failed — a leftover sha would misdescribe the
        // new content (backfill re-derives one from the fresh updatedAt).
        if (syncHeadSha) {
          installed.contentHeadSha = syncHeadSha;
        } else {
          delete installed.contentHeadSha;
        }
        installed.updatedAt = new Date().toISOString();
        if (installed.skillSource && typeof installed.skillSource === "object") {
          installed.skillSource = persistedSource;
        }
        skillSyncResults.updated.push({
          skillId: installed.skillId,
          previousVersion: previousSkillVersion,
          newVersion: remoteVersion,
          updateKind,
        });
        logger.log?.(
          `[Marketplace] Refreshed ${marketplaceId}/${installed.skillId} from remote ${updateKind} update (${previousSkillVersion || "unknown"} -> ${remoteVersion})`,
        );
      } catch (error) {
        logger.warn?.(
          `[Marketplace] Failed to sync skill ${marketplaceId}/${installed.skillId}: ${error.message}`,
        );
        skillSyncResults.errors.push({
          skillId: installed.skillId,
          pluginName: installed.pluginName ?? null,
          error: error.message,
          errorCode: error.code || null,
        });
      }
    }
  } finally {
    // Any staging dir not consumed by replaceSkillDirectoryFromStaging (or
    // already removed by a phase-1 failure) is swept here.
    for (const outcome of skillOutcomes) {
      if (outcome?.stagingPath) {
        await fsPromises.rm(outcome.stagingPath, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
  const skillsMs = Date.now() - skillsStartedAt;

  await saveMarketplacesConfig(projectRoot, config);
  logMarketplaceDiag("sync", "ok", {
    marketplaceId,
    durationMs: Date.now() - syncStartedAt,
    manifestMs,
    headProbeMs,
    skillsMs,
    skillCount: installedFromThisMarketplace.length,
    skipped: skippedByHeadSha,
    downloaded: skillSyncResults.updated.length,
    conflicted: skillSyncResults.conflicted.length,
    current: skillSyncResults.upToDate.length,
    failed: skillSyncResults.errors.length,
  });
  return {
    marketplace,
    hasUpdate: hasNewerVersion(previousVersion, marketplace.marketplaceVersion),
    skillsUpdated: skillSyncResults.updated,
    skillsConflicted: skillSyncResults.conflicted,
    skillsUpToDate: skillSyncResults.upToDate,
    skillSyncErrors: skillSyncResults.errors,
    skillsRemoved,
    skillsSourceMissing,
    pendingRemovals,
    agentInventoryUnavailable,
  };
}

async function syncAllMarketplaces({
  projectRoot,
  interactiveAuth = true,
  logger = console,
  listAgentReferences = null,
}) {
  const config = await loadMarketplacesConfig(projectRoot, { logger });
  const results = [];

  for (const marketplace of config.marketplaces) {
    try {
      const result = await syncMarketplace({
        projectRoot,
        marketplaceId: marketplace.id,
        interactiveAuth,
        logger,
        listAgentReferences,
      });
      results.push({
        id: marketplace.id,
        success: true,
        hasUpdate: result.hasUpdate,
        skillsUpdated: result.skillsUpdated,
        skillsConflicted: result.skillsConflicted,
        skillSyncErrors: result.skillSyncErrors,
        skillsRemoved: result.skillsRemoved,
        skillsSourceMissing: result.skillsSourceMissing,
        pendingRemovals: result.pendingRemovals,
        agentInventoryUnavailable: result.agentInventoryUnavailable,
      });
    } catch (error) {
      results.push({
        id: marketplace.id,
        success: false,
        error: error.message,
      });
    }
  }

  return results;
}

// ── Consented removal executor (second phase of the destructive sync) ──────
//
// Applies the removals a sync reported as pendingRemovals after the user
// consented: unlink the skills from EDITABLE agents (read-only installed
// agent copies are never written — they get a local SKILLS_NOT_FOUND flag
// instead; their owner republishes the fix), then remove records + payload
// dirs. OOTB-seeded targets are unlink-only: the record and payload stay
// (the additive seeder re-adds absent seeds, so removal can't stick; the
// next bundle resolves the skill itself) and they report via keptSeeded.
// Targets are re-verified against the live registry (still installed, still
// sourceMissing) so a stale consent can never remove a skill that came back.
function applyMarketplaceSyncRemovals(options) {
  return withRegistryWriteLock(() => applyMarketplaceSyncRemovalsUnlocked(options));
}

async function applyMarketplaceSyncRemovalsUnlocked({
  projectRoot,
  marketplaceId,
  removals = [],
  logger = console,
  // Injected agent transport (Electron-bound; this module stays free of it):
  //   listAgents(): [{id, name, relationship, readOnly, skillIds:[]}]
  //   updateAgentSkillIds(agentId, skillIds)
  //   flagAgentsSkillsNotFound([{agentId, agentName, skills:[]}]) (optional)
  agentTools = {},
}) {
  if (typeof agentTools.listAgents !== "function") {
    throw createMarketplaceError(
      "Couldn't verify which agents use these skills — the agent services are unavailable. Try again once services are running.",
      "agent_inventory_unavailable",
    );
  }
  const config = await loadMarketplacesConfig(projectRoot, { logger });
  if (!config.marketplaces.some((entry) => entry.id === marketplaceId)) {
    throw createMarketplaceError(
      `Marketplace "${marketplaceId}" not found`,
      "marketplace_not_found",
    );
  }

  const results = {
    removed: [],
    keptSeeded: [],
    skipped: [],
    agentsUpdated: [],
    agentsFlagged: [],
    agentsSkipped: [],
  };

  // One OOTB read for the whole removal batch instead of one per target.
  const seededKeys = await listOotbSeededKeys(projectRoot);
  const targets = [];
  for (const removal of Array.isArray(removals) ? removals : []) {
    const skillId = typeof removal?.skillId === "string" ? removal.skillId : null;
    const pluginName = removal?.pluginName ?? null;
    const reportBase = { skillId, pluginName };
    if (!skillId) {
      results.skipped.push({ ...reportBase, reason: "invalid_target" });
      continue;
    }
    const installed = config.installedSkills.find(
      (entry) =>
        entry?.marketplaceId === marketplaceId &&
        entry?.skillId === skillId &&
        (entry?.pluginName ?? null) === pluginName,
    );
    if (!installed) {
      results.skipped.push({ ...reportBase, reason: "not_installed" });
      continue;
    }
    if (installed.sourceMissing !== true) {
      results.skipped.push({ ...reportBase, reason: "not_missing" });
      continue;
    }
    targets.push({
      installed,
      seeded: seededKeys.has(`${marketplaceId}/${skillId}`),
    });
  }

  if (!targets.length) {
    return results;
  }

  let agents;
  try {
    agents = await agentTools.listAgents();
  } catch (error) {
    throw createMarketplaceError(
      `Couldn't verify which agents use these skills — ${error?.message || "the agent services are unavailable"}. Try again once services are running.`,
      "agent_inventory_unavailable",
    );
  }
  if (!Array.isArray(agents)) {
    throw createMarketplaceError(
      "Couldn't verify which agents use these skills — invalid agent inventory. Try again once services are running.",
      "agent_inventory_unavailable",
    );
  }

  const targetLeaves = new Set(
    targets.map((target) => deriveSkillId(target.installed.skillId)),
  );
  // Matching is leaf-canonical across all three reference shapes (bare leaf,
  // mp/skill, mp/plugin/skill) — the same conservative rule as every other
  // agent-reference guard in this codebase.
  const referenceMatches = (id) => targetLeaves.has(deriveSkillId(id));

  // Unlink editable agents FIRST: removing the skill before its references
  // would leave locally-owned agents dangling — the exact breakage the
  // consent modal promises to prevent. A failed unlink poisons every leaf
  // that agent references: those targets stay installed (skipped) and the
  // next sync re-reports them.
  const unlinkFailedLeaves = new Set();
  const flagEntries = [];
  for (const agent of agents) {
    const skillIds = Array.isArray(agent?.skillIds) ? agent.skillIds : [];
    const matching = skillIds.filter(referenceMatches);
    if (!matching.length) continue;
    const readOnly = agent?.readOnly === true || agent?.relationship === "installed";
    if (readOnly) {
      flagEntries.push({
        agentId: agent.id,
        agentName: agent.name || agent.id,
        skills: matching,
      });
      continue;
    }
    if (typeof agentTools.updateAgentSkillIds !== "function") {
      for (const id of matching) unlinkFailedLeaves.add(deriveSkillId(id));
      results.agentsSkipped.push({
        id: agent.id,
        name: agent.name || agent.id,
        error: "agent update transport unavailable",
        errorCode: "agent_update_unavailable",
      });
      continue;
    }
    try {
      await agentTools.updateAgentSkillIds(
        agent.id,
        skillIds.filter((id) => !referenceMatches(id)),
      );
      results.agentsUpdated.push({
        id: agent.id,
        name: agent.name || agent.id,
        removed: matching,
      });
    } catch (error) {
      for (const id of matching) unlinkFailedLeaves.add(deriveSkillId(id));
      results.agentsSkipped.push({
        id: agent.id,
        name: agent.name || agent.id,
        error: error?.message || String(error),
        errorCode: error?.code ?? null,
      });
    }
  }

  if (flagEntries.length) {
    if (typeof agentTools.flagAgentsSkillsNotFound === "function") {
      try {
        await agentTools.flagAgentsSkillsNotFound(flagEntries);
        results.agentsFlagged = flagEntries.map(({ agentId, agentName }) => ({
          id: agentId,
          name: agentName,
        }));
      } catch (error) {
        logger.warn?.(
          `[Marketplace] Could not record SKILLS_NOT_FOUND flags: ${error?.message || error}`,
        );
      }
    } else {
      logger.warn?.(
        "[Marketplace] No flag transport wired; read-only agents keep unflagged dangling references",
      );
    }
  }

  let removedAny = false;
  for (const { installed, seeded } of targets) {
    const leaf = deriveSkillId(installed.skillId);
    if (unlinkFailedLeaves.has(leaf)) {
      results.skipped.push({
        skillId: installed.skillId,
        pluginName: installed.pluginName ?? null,
        reason: "unlink_failed",
      });
      continue;
    }
    if (seeded) {
      // Unlink-only: the record and payload stay (bundle-managed; removal
      // would be undone by the seeder), still sourceMissing until the next
      // bundle resolves it.
      results.keptSeeded.push({
        skillId: installed.skillId,
        pluginName: installed.pluginName ?? null,
      });
      continue;
    }
    await removeInstalledSkillFromConfig(projectRoot, config, installed, { logger });
    results.removed.push({
      skillId: installed.skillId,
      pluginName: installed.pluginName ?? null,
      localPath: installed.localPath,
    });
    removedAny = true;
  }
  if (removedAny) {
    await saveMarketplacesConfig(projectRoot, config);
  }
  logMarketplaceDiag("sync", "removals:applied", {
    marketplaceId,
    removedCount: results.removed.length,
    keptSeededCount: results.keptSeeded.length,
    skippedCount: results.skipped.length,
    agentsUpdatedCount: results.agentsUpdated.length,
    agentsFlaggedCount: results.agentsFlagged.length,
    agentsSkippedCount: results.agentsSkipped.length,
  });
  return results;
}

async function ensureMarketplaceManifestLoaded(config, marketplace, { interactiveAuth = true } = {}) {
  if (marketplace.cachedManifest) {
    const normalizedManifest = await normalizeMarketplaceManifest(
      marketplace.cachedManifest,
      marketplace.source,
      { interactiveAuth },
    );
    if (normalizedManifest.changed) {
      marketplace.cachedManifest = normalizedManifest.manifest;
    }
    return marketplace.cachedManifest;
  }

  const definition = await loadMarketplaceDefinition(marketplace.source, { interactiveAuth });
  Object.assign(marketplace, createMarketplaceEntry(definition, marketplace), {
    id: marketplace.id,
  });
  return marketplace.cachedManifest;
}

async function getMarketplaceSkills({ projectRoot, marketplaceId, interactiveAuth = true, logger = console }) {
  const startedAt = Date.now();
  const config = await loadMarketplacesConfig(projectRoot, { logger });
  const marketplace = config.marketplaces.find((entry) => entry.id === marketplaceId);
  if (!marketplace) {
    throw createMarketplaceError(
      `Marketplace "${marketplaceId}" not found`,
      "marketplace_not_found",
    );
  }

  const previousManifest = marketplace.cachedManifest;
  await ensureMarketplaceManifestLoaded(config, marketplace, { interactiveAuth });
  if (!previousManifest || previousManifest !== marketplace.cachedManifest) {
    // Two-phase manifest persist: the network refresh above ran lock-free
    // (this is a hot read path), so re-load under the registry lock and graft
    // the refreshed entry onto the CURRENT config instead of saving this
    // possibly-stale snapshot over concurrent install/uninstall commits.
    const refreshedEntry = marketplace;
    await withRegistryWriteLock(async () => {
      const currentConfig = await loadMarketplacesConfig(projectRoot, { logger });
      const target = currentConfig.marketplaces.find(
        (entry) => entry.id === marketplaceId,
      );
      if (!target) {
        return;
      }
      Object.assign(target, refreshedEntry, { id: target.id });
      await saveMarketplacesConfig(projectRoot, currentConfig);
    });
  }

  const skills = parseSkillsFromManifest(marketplace.cachedManifest, marketplaceId, {
    sparse: marketplace.isSparse === true,
    logger,
  });
  applyInstalledSkillOverlay(config, marketplaceId, skills, await listOotbSeededKeys(projectRoot));

  logMarketplaceDiag("catalog", "get-skills:ok", {
    marketplaceId,
    skillCount: skills.length,
    durationMs: Date.now() - startedAt,
    cached: false,
  });

  return {
    marketplace,
    skills,
  };
}

function applyInstalledSkillOverlay(config, marketplaceId, skills, seededKeys = null) {
  for (const skill of skills) {
    // Exact triple first; a not-yet-migrated flat record still reports its
    // plugin-scoped catalog entry as installed (legacy-flat fallback).
    const installed =
      config.installedSkills.find(
        (entry) =>
          entry.marketplaceId === marketplaceId &&
          entry.skillId === skill.id &&
          normalizeInstalledPluginName(entry.pluginName) === (skill.pluginName || null),
      ) ||
      config.installedSkills.find(
        (entry) =>
          entry.marketplaceId === marketplaceId &&
          entry.skillId === skill.id &&
          !normalizeInstalledPluginName(entry.pluginName),
      );
    if (!installed) {
      skill.installed = false;
      continue;
    }

    skill.installed = true;
    // Built-in bundle seeds refuse uninstall/detach at the service chokepoint;
    // surfaces need this to stop offering actions that can never succeed.
    skill.seeded = Boolean(seededKeys?.has(`${marketplaceId}/${skill.id}`));
    skill.installedVersion = installed.installedVersion;
    skill.hasUpdate = installed.hasUpdate || false;
    skill.isDirty = installed.isDirty || false;
    skill.hasConflict = installed.hasConflict || false;
    skill.localPath = installed.localPath;
  }
}

// Fast read-only catalog for the details page's first paint: parses the
// already-cached manifest and overlays install state. No reconcile pass (OOTB
// merge, migrations), no manifest normalization (and therefore no network),
// no writes; dirty/conflict hashing is scoped to this one marketplace. The
// authoritative getMarketplaceSkills refresh follows it on the open path.
async function getMarketplaceSkillsCached({ projectRoot, marketplaceId, logger = console }) {
  const startedAt = Date.now();
  let rawConfig;
  try {
    rawConfig = JSON.parse(
      await fsPromises.readFile(getMarketplaceConfigPath(projectRoot), "utf8"),
    );
  } catch (error) {
    throw createMarketplaceError(
      `Marketplace config unavailable: ${error.message}`,
      "marketplace_config_unavailable",
    );
  }

  const config = normalizeMarketplacesConfig(rawConfig);
  const marketplace = config.marketplaces.find((entry) => entry.id === marketplaceId);
  if (!marketplace) {
    throw createMarketplaceError(
      `Marketplace "${marketplaceId}" not found`,
      "marketplace_not_found",
    );
  }
  if (!marketplace.cachedManifest) {
    throw createMarketplaceError(
      `Marketplace "${marketplaceId}" has no cached manifest`,
      "manifest_not_cached",
    );
  }

  await hydrateInstalledSkillStates(projectRoot, config, { logger, marketplaceId });
  const skills = parseSkillsFromManifest(marketplace.cachedManifest, marketplaceId, {
    sparse: marketplace.isSparse === true,
    logger,
  });
  applyInstalledSkillOverlay(config, marketplaceId, skills, await listOotbSeededKeys(projectRoot));

  logMarketplaceDiag("catalog", "get-skills:ok", {
    marketplaceId,
    skillCount: skills.length,
    durationMs: Date.now() - startedAt,
    cached: true,
  });

  return {
    marketplace,
    skills,
  };
}

// Remove now-empty parent directories after a skill directory disappears:
// the plugin directory (depth-3 installs) and then the marketplace
// directory — never the skills-marketplace root itself.
async function pruneEmptyInstallParents(projectRoot, localPath) {
  const parts = trimRepoRelativePath(localPath).split("/").filter(Boolean);
  // parts: ["skills-marketplace", mp, (plugin,) leaf]
  for (let depth = parts.length - 1; depth >= 2; depth -= 1) {
    await removeDirectoryIfEmpty(path.join(projectRoot, ...parts.slice(0, depth)));
  }
}

function requireInstalledSkillRecord(config, { marketplaceId, skillId, pluginName = null }) {
  const index = findInstalledSkillRecordIndex(config.installedSkills, {
    marketplaceId,
    skillId,
    pluginName,
  });
  if (index === -2) {
    throw createMarketplaceError(
      `Skill "${skillId}" is installed from more than one plugin in "${marketplaceId}"; specify plugin_name`,
      "marketplace_skill_ambiguous",
    );
  }
  if (index < 0) {
    throw createMarketplaceError(
      `Skill "${skillId}" is not installed`,
      "skill_not_installed",
    );
  }
  return { index, record: config.installedSkills[index] };
}

// Out-of-the-box installed skills (the bundled seeds ensureBundledMarketplaceDefaults
// merges in from marketplaces-ootb) are permanent, mirroring the ootb
// marketplace posture in removeMarketplaceUnlocked: removal was already
// self-defeating — the seed re-merge restores the record and payload on the
// next config load (and a detach's restore leaves a silent duplicate: the new
// user copy PLUS the resurrected marketplace copy) — so fail it clearly at
// the single service chokepoint shared by the UI, IPC, HTTP API, and MCP
// tools, BEFORE any mutation. Only seed-listed records are guarded;
// user-added installs (git marketplaces or Solutions Marketplace) remove
// exactly as before.
async function assertInstalledSkillNotOotbSeeded(projectRoot, installedSkill, operation) {
  const seeded = await isOotbSeededInstall(projectRoot, {
    marketplaceId: installedSkill?.marketplaceId,
    skillId: installedSkill?.skillId,
  });
  if (!seeded) {
    return;
  }
  const detach = operation === "detach";
  throw createMarketplaceError(
    detach
      ? `Skill "${installedSkill.skillId}" is a built-in default that ships with the app and cannot be converted to a user skill — the bundled seeds restore the marketplace copy on the next load, which would leave a duplicate. Use copy_skill to create an editable user copy alongside it.`
      : `Skill "${installedSkill.skillId}" is a built-in default that ships with the app and cannot be uninstalled — the bundled seeds restore it on the next load. Use copy_skill to create an editable user copy instead.`,
    "ootb_skill_immutable",
    {
      remediation: detach
        ? "Built-in default skills cannot be detached. Use copy_skill to create a customizable user copy alongside the built-in install."
        : "Built-in default skills cannot be removed. Use copy_skill to create a customizable user copy.",
    },
  );
}

async function installMarketplaceSkill({
  projectRoot,
  marketplaceId,
  skillId,
  skillPath,
  skillSource,
  pluginName = null,
  interactiveAuth = true,
  logger = console,
}) {
  const config = await loadMarketplacesConfig(projectRoot, { logger });
  const marketplace = config.marketplaces.find((entry) => entry.id === marketplaceId);
  if (!marketplace) {
    throw createMarketplaceError(
      `Marketplace "${marketplaceId}" not found`,
      "marketplace_not_found",
    );
  }

  const normalizedPluginName = normalizeInstalledPluginName(pluginName);
  if (normalizedPluginName && !safePluginSegment(normalizedPluginName)) {
    throw createMarketplaceError(
      `Plugin name "${normalizedPluginName}" is not a safe directory segment`,
      "marketplace_plugin_invalid",
    );
  }

  // A plugin the manifest marked unavailable (external/disallowed source or a
  // failed normalization) is browsable but never installable.
  const manifestPlugin = normalizedPluginName
    ? (marketplace.cachedManifest?.plugins || []).find(
        (plugin) => plugin?.name === normalizedPluginName,
      )
    : null;
  if (manifestPlugin?.unavailable === true) {
    throw createMarketplaceError(
      `Plugin "${normalizedPluginName}" in marketplace "${marketplaceId}" is not installable (${manifestPlugin.unavailableReason || "unavailable"})`,
      "marketplace_plugin_unavailable",
    );
  }

  if (
    config.installedSkills.some(
      (entry) =>
        entry.marketplaceId === marketplaceId &&
        entry.skillId === skillId &&
        normalizeInstalledPluginName(entry.pluginName) === normalizedPluginName,
    )
  ) {
    throw createMarketplaceError(
      `Skill "${skillId}" is already installed`,
      "skill_already_installed",
    );
  }

  const localPath = installedSkillLocalPath(marketplaceId, normalizedPluginName, skillId);

  // Destination-conflict guards: downloadSkillDirectory rm -rf's its
  // destination, so the leaf directory of this install must never be (or
  // contain) another installed skill's directory.
  //  - plugin install: {mp}/{plugin} must not be an installed skill's dir
  //    (a flat skill named like the plugin);
  //  - flat install: {mp}/{leaf} must not be a plugin parent that already
  //    contains installed skills.
  const conflictingRecord = config.installedSkills.find((entry) => {
    const entryLocalPath = trimRepoRelativePath(entry?.localPath || "");
    if (!entryLocalPath) {
      return false;
    }
    if (normalizedPluginName) {
      const pluginDir = `skills-marketplace/${marketplaceId}/${normalizedPluginName}`;
      return entryLocalPath === pluginDir || entryLocalPath === localPath;
    }
    return (
      entryLocalPath === localPath || entryLocalPath.startsWith(`${localPath}/`)
    );
  });
  if (conflictingRecord) {
    throw createMarketplaceError(
      `Install destination "${localPath}" conflicts with the installed skill at "${conflictingRecord.localPath}"`,
      "marketplace_install_conflict",
    );
  }

  const destinationPath = path.join(projectRoot, localPath);
  const normalizedSkillPath = normalizeSkillPath(skillPath);
  const remoteSource = resolveRemoteSkillSource(skillSource, marketplace.source);

  // Policy backstop: an explicit object skillSource pointing at a DIFFERENT
  // repository than the marketplace's own must independently pass the
  // allowlist (external plugins render but never install). Same-repo sources
  // inherit the marketplace's grandfathered standing.
  if (
    skillSource &&
    typeof skillSource === "object" &&
    !isSameRepositorySource(remoteSource, marketplace.source) &&
    !isAllowedMarketplaceSource(remoteSource)
  ) {
    logMarketplaceDiag(
      "policy",
      "install:blocked",
      {
        marketplaceId,
        skillId,
        sourceType: remoteSource?.type || "unknown",
        reason: "marketplace_source_not_allowed",
      },
      "error",
    );
    throw createMarketplaceError(
      `Skill "${skillId}" comes from a repository outside the approved marketplace sources and cannot be installed`,
      "marketplace_source_not_allowed",
    );
  }

  // Probe the head BEFORE downloading (stamp may lag content, never lead
  // it); must stay after the policy backstop so blocked installs fetch
  // nothing at all.
  const contentHeadSha = remoteSkillSourceGroupKey(remoteSource)
    ? await fetchRemoteHeadCommitSha(remoteSource, { interactiveAuth })
    : null;

  const persistedSource = await downloadSkillDirectory(
    remoteSource,
    normalizedSkillPath,
    destinationPath,
    { interactiveAuth },
  );

  const installed = await upsertInstalledSkillRecord({
    projectRoot,
    marketplaceId,
    skillId,
    skillPath: normalizedSkillPath,
    skillSource:
      skillSource && typeof skillSource === "object" ? persistedSource : skillSource || null,
    pluginName: normalizedPluginName,
    localPath,
    sourceRef: persistedSource?.ref,
    contentHeadSha: contentHeadSha || undefined,
    logger,
  });
  logger.log?.(
    `[Marketplace] skill installed: ${marketplaceId}/${normalizedPluginName ? `${normalizedPluginName}/` : ""}${skillId} (version ${installed.installedVersion || "unknown"})`,
  );
  return {
    localPath,
    version: installed.installedVersion,
    pluginName: normalizedPluginName,
    display_name: formatSkillDisplayName(
      String(skillId || "").split("/").filter(Boolean).pop() || skillId,
    ),
  };
}

function uninstallMarketplaceSkill(options) {
  return withRegistryWriteLock(() => uninstallMarketplaceSkillUnlocked(options));
}

async function uninstallMarketplaceSkillUnlocked({
  projectRoot,
  marketplaceId,
  skillId,
  pluginName = null,
  logger = console,
}) {
  const config = await loadMarketplacesConfig(projectRoot, { logger });
  const { index, record: installedSkill } = requireInstalledSkillRecord(config, {
    marketplaceId,
    skillId,
    pluginName,
  });
  await assertInstalledSkillNotOotbSeeded(projectRoot, installedSkill, "uninstall");

  try {
    const skillPath = path.join(projectRoot, installedSkill.localPath);
    await fsPromises.rm(skillPath, { recursive: true, force: true });
  } catch (error) {
    logger.log?.(`[Marketplace] Could not remove skill directory: ${error.message}`);
  }

  config.installedSkills = config.installedSkills.filter(
    (entry, entryIndex) => entryIndex !== index,
  );

  await saveMarketplacesConfig(projectRoot, config);
  await pruneEmptyInstallParents(projectRoot, installedSkill.localPath);
  return {
    marketplaceId,
    skillId,
    pluginName: normalizeInstalledPluginName(installedSkill.pluginName),
    localPath: installedSkill.localPath,
  };
}

function detachMarketplaceSkillToUserSkill(options) {
  return withRegistryWriteLock(() => detachMarketplaceSkillToUserSkillUnlocked(options));
}

async function detachMarketplaceSkillToUserSkillUnlocked({
  projectRoot,
  marketplaceId,
  skillId,
  targetSkillName,
  pluginName = null,
  logger = console,
  copyUserSkill = require("./user-skill-service").copySkillToUser,
  saveConfig = saveMarketplacesConfig,
}) {
  const config = await loadMarketplacesConfig(projectRoot, { logger });
  const { index: installedIndex, record: installedSkill } = requireInstalledSkillRecord(
    config,
    { marketplaceId, skillId, pluginName },
  );
  await assertInstalledSkillNotOotbSeeded(projectRoot, installedSkill, "detach");

  const sourcePath = path.join(projectRoot, installedSkill.localPath);
  const destinationName = await resolveDetachedSkillTargetName(
    projectRoot,
    targetSkillName,
    skillId,
  );
  const destinationRelativePath = path.posix.join("skills-user", destinationName);
  const destinationPath = path.join(projectRoot, destinationRelativePath);

  const copied = await copyUserSkill({
    projectRoot,
    sourcePath,
    skillName: destinationName,
  });

  config.installedSkills = config.installedSkills.filter(
    (entry, entryIndex) => entryIndex !== installedIndex,
  );
  try {
    await saveConfig(projectRoot, config);
  } catch (error) {
    // The source and registry are still authoritative. Remove the new User
    // copy so a failed detachment cannot leave a partially adopted skill.
    await fsPromises.rm(destinationPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  await fsPromises.rm(sourcePath, { recursive: true, force: true }).catch((error) => {
    logger.warn?.(
      `[Marketplace] Could not remove detached marketplace skill directory ${installedSkill.localPath}: ${error.message}`,
    );
  });
  await pruneEmptyInstallParents(projectRoot, installedSkill.localPath);

  return {
    marketplaceId,
    skillId,
    skillName: destinationName,
    display_name:
      copied?.displayName || formatSkillDisplayName(destinationName),
    localPath: destinationRelativePath,
    previousLocalPath: installedSkill.localPath,
  };
}

// Marketplace timestamps may be ISO strings or epochs (seconds or ms);
// compare on the marketplace's own clock, never the local one.
function remoteTimestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function remoteTimestampIsNewer(remote, baseline) {
  const remoteMs = remoteTimestampMs(remote);
  const baselineMs = remoteTimestampMs(baseline);
  return remoteMs !== null && baselineMs !== null && remoteMs > baselineMs;
}

// Bounded worker pool for the freshness sweep's network fan-outs: workers
// share an index and collect results positionally; a worker's failure records
// null for that item instead of sinking the whole batch.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length).fill(null);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await fn(items[index], index);
      } catch (_) {
        results[index] = null;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// Freshness baselines are keyed by the RESOLVED repo+ref a record actually
// fetches from (per-record skillSource refs can diverge from the marketplace
// entry's), so two marketplaces pointing at the same repo@ref share one probe
// and divergent records form their own groups.
function remoteSkillSourceGroupKey(source) {
  if (!source || typeof source !== "object") {
    return null;
  }
  if (source.type === "github" && source.repo) {
    return `github:${String(source.repo).toLowerCase()}@${source.ref || ""}`;
  }
  if (source.type === "gitlab" && source.host && source.projectPath) {
    return `gitlab:${String(source.host).toLowerCase()}/${source.projectPath}@${source.ref || ""}`;
  }
  return null;
}

// Latest commit sha of the repo+ref a group of installed skills fetches from.
// Best-effort: any failure (offline, headless run without git auth, rate
// limit, unknown ref) returns null and the caller falls back to per-skill
// fetches — the sha shortcut can only ever skip work it has PROVEN
// unnecessary (same commit sha ⇒ identical remote SKILL.md bytes).
async function fetchRemoteHeadCommitSha(source, options = {}) {
  const head = await fetchRemoteHeadCommit(source, options);
  return head?.sha || null;
}

// Head commit sha + commit date. The probes' JSON already carries the date —
// the Updates tab renders "days behind" for a moved git marketplace from it,
// so discarding it would force a second round-trip. Optional timeoutMs lets
// best-effort callers fail fast; optional resolvedSource/accessToken reuse a
// caller's already-resolved gitlab access.
async function fetchRemoteHeadCommit(
  source,
  {
    interactiveAuth = false,
    timeoutMs = NETWORK_TIMEOUT_MS,
    resolvedSource = null,
    accessToken = null,
  } = {},
) {
  try {
    if (source.type === "gitlab") {
      const access = await resolveGitLabAccess(source, {
        interactiveAuth,
        resolvedSource,
        accessToken,
      });
      const data = await fetchGitLabJson(
        `${access.baseUrl}/api/v4/projects/${access.projectId}/repository/commits/${encodeURIComponent(
          access.resolvedSource.ref,
        )}`,
        access.resolvedSource.host,
        {
          interactiveAuth,
          allowNotFound: true,
          accessToken: access.accessToken,
          timeoutMs,
        },
      );
      const sha = typeof data?.id === "string" ? data.id.trim() : "";
      if (!sha) return null;
      const committedAt =
        typeof data?.committed_date === "string" ? data.committed_date : null;
      return { sha, committedAt };
    }
    if (source.type === "github") {
      const ref = source.ref || (await resolveGitHubRef(source));
      const data = await fetchJsonFromUrl(
        `${GITHUB_API_BASE_URL}/repos/${source.repo}/commits/${encodeURIComponent(ref)}`,
        { headers: githubRequestHeaders(), allowNotFound: true, timeoutMs },
      );
      const sha = typeof data?.sha === "string" ? data.sha.trim() : "";
      if (!sha) return null;
      const committedAt =
        typeof data?.commit?.committer?.date === "string"
          ? data.commit.committer.date
          : typeof data?.commit?.author?.date === "string"
            ? data.commit.author.date
            : null;
      return { sha, committedAt };
    }
    return null;
  } catch (_) {
    return null;
  }
}

// Forge compare caps: GitHub's compare response includes at most 300 changed
// files with NO truncation flag (>= cap ⇒ possibly incomplete); GitLab has no
// documented file-count flag, so guard conservatively.
const GITHUB_COMPARE_MAX_FILES = 300;
const GITLAB_COMPARE_MAX_DIFFS = 1000;

// Repo-relative paths changed between two commits — the content-drift signal
// for installed git skills (nobody bumps SKILL.md version fields in practice,
// so version compares miss real edits). Returns a Set of paths, or null when
// the comparison cannot be trusted (unknown shas, truncation, force-push,
// rate limit, offline) — callers fall back to the per-skill version compare.
// Always called with two SHAs, never branch names: the probed head pins the
// classification even if the branch advances mid-sweep.
async function fetchRemoteChangedPaths(source, baseSha, headSha, { interactiveAuth = false } = {}) {
  try {
    if (source.type === "github") {
      const data = await fetchJsonFromUrl(
        `${GITHUB_API_BASE_URL}/repos/${source.repo}/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(headSha)}`,
        { headers: githubRequestHeaders(), allowNotFound: true },
      );
      if (!data) return null;
      if (data.status === "identical") return new Set();
      // GitHub's three-dot compare diffs from the MERGE BASE: it equals the
      // true base→head diff only when base is an ancestor ("ahead").
      // "behind"/"diverged" (force-push, rollback) would under-report and
      // wrongly advance baselines — reject them.
      if (data.status !== "ahead") return null;
      if (!Array.isArray(data.files)) return null;
      if (data.files.length >= GITHUB_COMPARE_MAX_FILES) return null;
      const paths = new Set();
      for (const file of data.files) {
        if (file?.filename) paths.add(trimRepoRelativePath(file.filename));
        if (file?.previous_filename) paths.add(trimRepoRelativePath(file.previous_filename));
      }
      return paths;
    }
    if (source.type === "gitlab") {
      const access = await resolveGitLabAccess(source, { interactiveAuth });
      // straight=true = direct from..to diff. The default merge-base mode
      // under-reports force-pushes/rollbacks and would wrongly advance
      // baselines past unexamined commits.
      const data = await fetchGitLabJson(
        `${access.baseUrl}/api/v4/projects/${access.projectId}/repository/compare?from=${encodeURIComponent(baseSha)}&to=${encodeURIComponent(headSha)}&straight=true`,
        access.resolvedSource.host,
        { interactiveAuth, allowNotFound: true, accessToken: access.accessToken },
      );
      if (!data || !Array.isArray(data.diffs)) return null;
      if (data.compare_timeout === true) return null;
      if (data.diffs.length >= GITLAB_COMPARE_MAX_DIFFS) return null;
      const paths = new Set();
      for (const diff of data.diffs) {
        if (diff?.new_path) paths.add(trimRepoRelativePath(diff.new_path));
        if (diff?.old_path) paths.add(trimRepoRelativePath(diff.old_path));
      }
      return paths;
    }
    return null;
  } catch (_) {
    return null;
  }
}

// Newest commit sha at-or-before an anchor timestamp on the source's ref —
// the one-time "precise backfill" that gives pre-feature installs a content
// baseline matching when their content was actually written. Failure → null
// (caller keeps the legacy version compare and retries next sweep).
async function resolveHistoricalHeadSha(source, anchorIso, { interactiveAuth = false } = {}) {
  const anchorMs = remoteTimestampMs(anchorIso);
  if (anchorMs === null) return null;
  // until= filters committer dates; GitHub documents seconds-precision
  // YYYY-MM-DDTHH:MM:SSZ, so strip milliseconds.
  const until = new Date(anchorMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  try {
    if (source.type === "github") {
      const ref = source.ref || (await resolveGitHubRef(source));
      const data = await fetchJsonFromUrl(
        `${GITHUB_API_BASE_URL}/repos/${source.repo}/commits?sha=${encodeURIComponent(ref)}&until=${encodeURIComponent(until)}&per_page=1`,
        { headers: githubRequestHeaders(), allowNotFound: true },
      );
      const sha =
        Array.isArray(data) && typeof data[0]?.sha === "string" ? data[0].sha.trim() : "";
      return sha || null;
    }
    if (source.type === "gitlab") {
      const access = await resolveGitLabAccess(source, { interactiveAuth });
      const data = await fetchGitLabJson(
        `${access.baseUrl}/api/v4/projects/${access.projectId}/repository/commits?ref_name=${encodeURIComponent(access.resolvedSource.ref)}&until=${encodeURIComponent(until)}&per_page=1`,
        access.resolvedSource.host,
        { interactiveAuth, allowNotFound: true, accessToken: access.accessToken },
      );
      const sha =
        Array.isArray(data) && typeof data[0]?.id === "string" ? data[0].id.trim() : "";
      return sha || null;
    }
    return null;
  } catch (_) {
    return null;
  }
}

// Committed date of the newest commit touching the skill's directory — for a
// path deleted at head, that commit IS the deletion/rename, i.e. the moment
// the installed copy desynced from upstream (the Updates tab's drift anchor
// for "No longer published" rows). Failure/unknown source → null; the caller
// falls back to the group's head date or leaves the record unstamped.
async function fetchRemovalCommitDate(source, skillPath, { interactiveAuth = false } = {}) {
  const path = trimRepoRelativePath(normalizeSkillPath(skillPath));
  if (!path) return null;
  try {
    if (source?.type === "github" && source.repo) {
      const ref = source.ref || (await resolveGitHubRef(source));
      const data = await fetchJsonFromUrl(
        `${GITHUB_API_BASE_URL}/repos/${source.repo}/commits?sha=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}&per_page=1`,
        { headers: githubRequestHeaders(), allowNotFound: true },
      );
      const commit = Array.isArray(data) ? data[0] : null;
      const date = commit?.commit?.committer?.date || commit?.commit?.author?.date || "";
      return typeof date === "string" && date.trim() ? date.trim() : null;
    }
    if (source?.type === "gitlab") {
      const access = await resolveGitLabAccess(source, { interactiveAuth });
      const data = await fetchGitLabJson(
        `${access.baseUrl}/api/v4/projects/${access.projectId}/repository/commits?ref_name=${encodeURIComponent(access.resolvedSource.ref)}&path=${encodeURIComponent(path)}&per_page=1`,
        access.resolvedSource.host,
        { interactiveAuth, allowNotFound: true, accessToken: access.accessToken },
      );
      const date =
        Array.isArray(data) && typeof data[0]?.committed_date === "string"
          ? data[0].committed_date.trim()
          : "";
      return date || null;
    }
    return null;
  } catch (_) {
    return null;
  }
}

// Whole-body lock: the sweep's save at the end used to rewrite the config
// from a snapshot taken before its network probes, erasing concurrent
// installs. Probes are bounded by their own request timeouts; installs that
// queue behind a sweep wait, they don't lose data. (Two-phase probe-then-
// relock is a possible refinement if sweep latency ever matters here.)
//
// Coalescing: concurrent surfaces (Updates tab, Agents freshness snapshot,
// chat bridge) used to queue behind the lock and each run a FULL sweep
// back-to-back — 2026-08-14 logs show a 2.9s sweep immediately followed by
// an 18.8s duplicate during a marketplace availability blip, each pulling a
// ~29MB fleet search. Callers with the same shape now share the in-flight
// run, and a just-completed result is reused briefly. Timestamp compare
// only — no timers (ATLAS.md perf rule).
const SWEEP_REUSE_MS = 15_000;
const sweepCoalesce = new Map();

function checkSkillUpdates(options = {}) {
  const headless = options?.interactiveAuth === false;
  const key = `${String(options?.projectRoot || "")}|${headless ? "headless" : "interactive"}`;
  const nowMs = typeof options?.nowMs === "function" ? options.nowMs : Date.now;
  const cached = sweepCoalesce.get(key);
  if (cached?.promise) return cached.promise;
  // Result reuse is HEADLESS-only: passive render paths coalesce, while an
  // explicit "Check updates" click always runs a fresh sweep.
  if (headless && cached && cached.result !== undefined && nowMs() - cached.at < SWEEP_REUSE_MS) {
    return Promise.resolve(cached.result);
  }
  const promise = withRegistryWriteLock(() => checkSkillUpdatesUnlocked(options)).then(
    (result) => {
      sweepCoalesce.set(key, { at: nowMs(), result, promise: null });
      return result;
    },
    (error) => {
      // Failed sweeps are never reused; the next caller runs fresh.
      sweepCoalesce.delete(key);
      throw error;
    },
  );
  sweepCoalesce.set(key, { at: nowMs(), result: undefined, promise });
  return promise;
}

function resetSweepCoalesceForTests() {
  sweepCoalesce.clear();
}

async function checkSkillUpdatesUnlocked({
  projectRoot,
  interactiveAuth = true,
  fetchSolution = null,
  searchSolutions = null,
  logger = console,
}) {
  const startedAt = Date.now();
  const config = await loadMarketplacesConfig(projectRoot, { logger });
  // Persisted-projection snapshot: the sweep only rewrites marketplaces.json
  // when the projection actually changed (transient isDirty/hasConflict are
  // stripped by configForPersistence, so hydrate noise can't fake dirtiness).
  const persistedBefore = JSON.stringify(configForPersistence(config));
  const updates = [];
  const stats = {
    solutionsChecked: 0,
    solutionsSearchUsed: false,
    gitReposChecked: 0,
    gitSkillsFetched: 0,
    shaShortCircuits: 0,
    contentCompares: 0,
    baselineBackfills: 0,
    removalStampsFetched: 0,
  };

  // Solutions-marketplace installs have no git marketplace entry; their
  // freshness signal is the listing's updated_at vs the stored baseline.
  // Records without a baseline (pre-feature installs) get it backfilled
  // silently and start reporting from the next listing update onward.
  const solutionsRecords =
    typeof fetchSolution === "function" || typeof searchSolutions === "function"
      ? config.installedSkills.filter(
          (entry) =>
            entry?.skillSource?.type === "ai-marketplace-solution" &&
            entry?.skillSource?.solutionId,
        )
      : [];
  stats.solutionsChecked = solutionsRecords.length;
  // Resolve every installed listing up front — ONE type-filtered search
  // covers the fleet; only ids the search page missed fall back to per-id
  // reads. Legacy callers without searchSolutions keep the per-id loop.
  const solutionsById = new Map();
  const runSolutionsLeg = async () => {
    if (solutionsRecords.length && typeof searchSolutions === "function") {
      try {
        const payload = await searchSolutions({
          query: "",
          filters: { type: ["skills"] },
          page: 1,
          pageSize: 100,
        });
        const results = Array.isArray(payload?.results)
          ? payload.results
          : Array.isArray(payload?.data?.results)
            ? payload.data.results
            : [];
        stats.solutionsSearchUsed = true;
        for (const solution of results) {
          const id = String(
            solution?.id || solution?.solution_id || solution?.uuid || "",
          ).trim();
          if (id && !solutionsById.has(id)) solutionsById.set(id, solution);
        }
      } catch (error) {
        logger.warn?.(
          "[Marketplace] solutions freshness search failed:",
          error?.message || error,
        );
      }
    }
    if (solutionsRecords.length && typeof fetchSolution === "function") {
      const missingIds = [
        ...new Set(solutionsRecords.map((entry) => entry.skillSource.solutionId)),
      ].filter((id) => !solutionsById.has(id));
      if (typeof searchSolutions === "function") {
        const fetched = await mapWithConcurrency(missingIds, 4, (id) =>
          fetchSolution(id),
        );
        missingIds.forEach((id, index) => {
          if (fetched[index]) solutionsById.set(id, fetched[index]);
        });
      } else {
        // Legacy path: sequential per-id reads, failures logged per record.
        for (const id of missingIds) {
          try {
            const solution = await fetchSolution(id);
            if (solution) solutionsById.set(id, solution);
          } catch (error) {
            logger.warn?.(
              `[Marketplace] solutions freshness check failed for ${id}:`,
              error?.message || error,
            );
          }
        }
      }
    }
  };

  // Git-marketplace records, grouped by the resolved repo+ref they fetch
  // from: one head-sha probe per repo proves it unchanged (same sha ⇒ same
  // tree) and skips everything; repos that moved get ONE changed-paths
  // compare per stored content baseline, flagging exactly the skills whose
  // directories were touched — no SKILL.md version-bump contract required.
  // This leg runs CONCURRENTLY with the solutions leg
  // (disjoint record sets, both throw-free), all inside the one registry
  // lock. Flags are applied in a single ordered pass below so outcomes and
  // updates[] ordering match the old sequential loop exactly.
  const gitRecords = [];
  for (const installed of config.installedSkills) {
    const marketplace = config.marketplaces.find(
      (entry) => entry.id === installed.marketplaceId,
    );
    if (!marketplace) {
      continue;
    }
    const remoteSource = resolveRemoteSkillSource(
      installed.skillSource,
      marketplace.source,
    );
    gitRecords.push({
      installed,
      remoteSource,
      groupKey: remoteSkillSourceGroupKey(remoteSource),
    });
  }

  const groups = new Map();
  for (const entry of gitRecords) {
    if (!entry.groupKey) continue; // non-git sources: handled per-record below
    if (!groups.has(entry.groupKey)) groups.set(entry.groupKey, []);
    groups.get(entry.groupKey).push(entry);
  }

  const previousShas =
    config.skillFreshnessShas && typeof config.skillFreshnessShas === "object"
      ? config.skillFreshnessShas
      : {};
  const nextShas = {};
  const remoteVersions = new Map();
  // Parallel probe outcomes ({present, version}) — `present:false` is the
  // definitive "skill gone at head" signal behind sourceMissing verdicts.
  const remoteProbes = new Map();
  // Per-record sweep verdicts (installed -> {kind, stampBackfill?, advanceTo?})
  // filled by the git leg, applied in the single ordered pass below.
  const decisions = new Map();
  // Head-commit dates per probed repo group — the Updates tab's drift for a
  // git marketplace reads from here via updates[].headCommittedAt.
  const headDatesByGroup = new Map();
  // Removal-commit dates (installed -> ISO) for records missing upstream and
  // not yet carrying a persisted sourceMissingSince stamp.
  const removalDatesByRecord = new Map();

  const runGitLeg = async () => {
    // Phase A: probe EVERY group's head sha through the shared bounded pool.
    // Single-record repos used to skip the probe and pay a SKILL.md fetch
    // every sweep instead — probing them costs the same call and buys the
    // gate plus a drift date.
    const groupList = [...groups.entries()];
    const heads = await mapWithConcurrency(groupList, 4, ([, entries]) =>
      fetchRemoteHeadCommit(entries[0].remoteSource, { interactiveAuth }),
    );
    // Ordered decision pass: stats and nextShas are written in group-Map
    // order regardless of probe completion order — nextShas key order flows
    // into the persisted-projection compare and marketplaces.json bytes, so
    // completion-order writes would fake a config change on every sweep.
    const headByGroup = new Map();
    const entriesToEvaluate = [];
    groupList.forEach(([key, entries], index) => {
      stats.gitReposChecked += 1;
      const sha = heads[index]?.sha || null;
      if (heads[index]?.committedAt) {
        headDatesByGroup.set(key, heads[index].committedAt);
      }
      if (sha) headByGroup.set(key, sha);
      // One-time migration bypass: a gate skip is only allowed when no
      // record still needs its content-baseline backfill (unstamped but
      // anchored) — otherwise drift that predates the sweep baseline would
      // stay hidden until the repo's next commit. Bypassed groups come out
      // fully stamped, so the gate applies again from the very next sweep.
      const needsBackfill = entries.some(
        (entry) =>
          !entry.installed.contentHeadSha &&
          (entry.installed.updatedAt || entry.installed.installedAt),
      );
      if (sha && previousShas[key] === sha && !needsBackfill) {
        stats.shaShortCircuits += 1;
        nextShas[key] = sha;
        return; // proven unchanged — zero fetches, flags untouched
      }
      entriesToEvaluate.push(...entries);
      if (sha) {
        nextShas[key] = sha;
      } else if (previousShas[key]) {
        // Probe failed after a recompute: keeping the old baseline is safe (a
        // skip only ever happens when a LIVE sha matches it) and lets an
        // unmoved repo short-circuit again once probes recover.
        nextShas[key] = previousShas[key];
      }
    });

    // Phase B0: one-time precise backfill for pre-feature records. Anchor =
    // the record's own content-write time (updatedAt || installedAt) —
    // NEVER marketplace.lastSynced, which advances on every sync regardless
    // of per-record refresh and could resolve a baseline past a real
    // conflict, silently clearing a true hasUpdate.
    const baselineByInstalled = new Map();
    {
      const jobsByKey = new Map();
      for (const entry of entriesToEvaluate) {
        const installed = entry.installed;
        if (installed.contentHeadSha) continue;
        if (!headByGroup.get(entry.groupKey)) continue;
        const anchor = installed.updatedAt || installed.installedAt;
        if (!anchor) continue;
        const jobKey = `${entry.groupKey} ${anchor}`;
        if (!jobsByKey.has(jobKey)) {
          jobsByKey.set(jobKey, { source: entry.remoteSource, anchor, entries: [] });
        }
        jobsByKey.get(jobKey).entries.push(entry);
      }
      const jobs = [...jobsByKey.values()];
      stats.baselineBackfills += jobs.length;
      const resolved = await mapWithConcurrency(jobs, 4, (job) =>
        resolveHistoricalHeadSha(job.source, job.anchor, { interactiveAuth }),
      );
      jobs.forEach((job, index) => {
        if (!resolved[index]) return;
        for (const entry of job.entries) {
          baselineByInstalled.set(entry.installed, resolved[index]);
        }
      });
    }

    // Phase B1: ONE changed-paths compare per distinct (repo, baseline)
    // pair — content-based detection with no per-skill fetches. null =
    // untrusted comparison → that pair's records take the legacy per-skill
    // version compare instead.
    const changedPathsByPair = new Map();
    {
      const pairs = new Map();
      for (const entry of entriesToEvaluate) {
        const head = headByGroup.get(entry.groupKey);
        const base =
          baselineByInstalled.get(entry.installed) || entry.installed.contentHeadSha;
        if (!head || !base || base === head) continue;
        const pairKey = `${entry.groupKey} ${base}`;
        if (!pairs.has(pairKey)) {
          pairs.set(pairKey, { source: entry.remoteSource, base, head });
        }
      }
      const pairList = [...pairs.entries()];
      stats.contentCompares += pairList.length;
      const results = await mapWithConcurrency(pairList, 4, ([, pair]) =>
        fetchRemoteChangedPaths(pair.source, pair.base, pair.head, { interactiveAuth }),
      );
      pairList.forEach(([pairKey], index) => {
        changedPathsByPair.set(pairKey, results[index]);
      });
    }

    // Phase B2: classify. Only touched rows (display version) and fallback
    // rows (legacy compare) still need a remote SKILL.md.
    const versionFetchEntries = [];
    for (const entry of entriesToEvaluate) {
      const installed = entry.installed;
      const head = headByGroup.get(entry.groupKey) || null;
      const stampBackfill = baselineByInstalled.get(installed) || null;
      const base = stampBackfill || installed.contentHeadSha || null;
      if (!head || !base) {
        decisions.set(installed, { kind: "fallback", stampBackfill });
        versionFetchEntries.push(entry);
        continue;
      }
      if (base === head) {
        decisions.set(installed, { kind: "current", stampBackfill });
        continue;
      }
      const changed = changedPathsByPair.get(`${entry.groupKey} ${base}`);
      if (!changed) {
        decisions.set(installed, { kind: "fallback", stampBackfill });
        versionFetchEntries.push(entry);
        continue;
      }
      if (skillDirTouched(changed, installed.skillPath)) {
        decisions.set(installed, { kind: "touched", stampBackfill });
        versionFetchEntries.push(entry);
      } else {
        decisions.set(installed, { kind: "untouched", stampBackfill, advanceTo: head });
      }
    }

    // Phase B3: ONE flat pool across every version-needing record keeps the
    // global SKILL.md-fetch fan-out at 4 (per-group inner pools would stack).
    // The same single fetch now also reports presence: a definitive 404 at
    // head is the "no longer published upstream" signal, not an update.
    stats.gitSkillsFetched += versionFetchEntries.length;
    const probes = await mapWithConcurrency(versionFetchEntries, 4, (entry) =>
      probeRemoteSkillVersion(entry.remoteSource, entry.installed.skillPath, {
        interactiveAuth,
      }),
    );
    versionFetchEntries.forEach((entry, index) => {
      remoteProbes.set(entry.installed, probes[index]);
      remoteVersions.set(entry.installed, probes[index]?.version ?? null);
    });

    // Non-git sources keep the old per-record call (url/sparse types return
    // null without any network inside probeRemoteSkillVersion).
    for (const entry of gitRecords) {
      if (entry.groupKey) continue;
      const probe = await probeRemoteSkillVersion(
        entry.remoteSource,
        entry.installed.skillPath,
        { interactiveAuth },
      );
      remoteProbes.set(entry.installed, probe);
      remoteVersions.set(entry.installed, probe?.version ?? null);
    }

    // Phase B4: removal stamps. A record proven gone this sweep — or flagged
    // missing earlier without a date (destructive sync is manifest-driven and
    // adds no network; a prior stamp fetch may have failed) — gets the
    // upstream removal commit's date, the desync moment the Updates tab
    // renders as the missing row's drift. Deliberately independent of the
    // sha-gate skip so already-flagged records backfill on an unmoved repo.
    // The persisted stamp keeps steady-state sweeps at zero extra calls.
    const removalStampEntries = gitRecords.filter((entry) => {
      if (entry.installed.sourceMissingSince) return false;
      if (remoteProbes.get(entry.installed)?.present === false) return true;
      return entry.installed.sourceMissing === true;
    });
    stats.removalStampsFetched += removalStampEntries.length;
    const removalDates = await mapWithConcurrency(removalStampEntries, 4, (entry) =>
      fetchRemovalCommitDate(entry.remoteSource, entry.installed.skillPath, {
        interactiveAuth,
      }),
    );
    removalStampEntries.forEach((entry, index) => {
      const stamp = removalDates[index] || headDatesByGroup.get(entry.groupKey) || null;
      if (stamp) removalDatesByRecord.set(entry.installed, stamp);
    });
  };

  // The legs touch disjoint state (solutionsById vs remoteVersions/nextShas)
  // and neither can reject, so running them concurrently changes wall-clock
  // only: steady-state cost is max(search, slowest probe) instead of their
  // serial sum. Flag application stays sequential below, in the original
  // solutions-then-git order.
  await Promise.all([runSolutionsLeg(), runGitLeg()]);

  for (const installed of solutionsRecords) {
    const solution = solutionsById.get(installed.skillSource.solutionId);
    if (!solution) continue; // unresolved listing: keep flags (old catch-continue)
    const remote = solutionFreshnessStamp(solution);
    if (remote === undefined || remote === null || remote === "") continue;
    if (
      installed.remoteUpdatedAt === undefined ||
      installed.remoteUpdatedAt === null
    ) {
      installed.remoteUpdatedAt = remote;
      continue;
    }
    if (remoteTimestampIsNewer(remote, installed.remoteUpdatedAt)) {
      installed.hasUpdate = true;
      installed.hasConflict = Boolean(installed.isDirty);
      updates.push({
        skillId: installed.skillId,
        marketplaceId: installed.marketplaceId,
        installedVersion: installed.installedVersion,
        remoteVersion: String(remote),
      });
    } else {
      installed.hasUpdate = false;
      installed.hasConflict = false;
    }
  }

  for (const entry of gitRecords) {
    const installed = entry.installed;
    // Records that arrived flagged but undated (sync-flagged, or a prior
    // sweep whose stamp fetch failed) backfill here regardless of which
    // verdict branch — or gate skip — applies below.
    if (
      installed.sourceMissing === true &&
      !installed.sourceMissingSince &&
      removalDatesByRecord.has(installed)
    ) {
      installed.sourceMissingSince = removalDatesByRecord.get(installed);
    }
    const decision = decisions.get(installed);
    if (decision) {
      // Backfill stamps persist even when the compare later failed — the
      // resolved sha is real provenance and the next sweep starts from it.
      if (decision.stampBackfill) installed.contentHeadSha = decision.stampBackfill;
      if (decision.kind === "current" || decision.kind === "untouched") {
        installed.hasUpdate = false;
        installed.hasConflict = false;
        delete installed.updateHeadCommittedAt;
        if (decision.kind === "untouched") {
          // Dir proven unchanged base→head: advancing the baseline is sound
          // and keeps future compares small.
          installed.contentHeadSha = decision.advanceTo;
        }
        continue;
      }
      if (decision.kind === "touched") {
        const probe = remoteProbes.get(installed) || { present: null, version: null };
        if (probe.present === false) {
          // The dir was "touched" because it was DELETED at head: that is
          // not an update — flagging it produced a permanently stuck
          // "Updates available" row that sync could never resolve. Mark the
          // source missing instead; the destructive sync owns resolution.
          markInstalledSourceMissing(installed);
          if (!installed.sourceMissingSince && removalDatesByRecord.has(installed)) {
            installed.sourceMissingSince = removalDatesByRecord.get(installed);
          }
          continue;
        }
        if (probe.present === true) {
          delete installed.sourceMissing;
          delete installed.sourceMissingSince;
        } else if (installed.sourceMissing) {
          // Probe outcome unknown (offline / auth): no evidence the source
          // came back — keep the prior missing verdict rather than flip to
          // a fake update.
          continue;
        }
        const remoteVersion = probe.version || null;
        const headCommittedAt = headDatesByGroup.get(entry.groupKey) || null;
        installed.hasUpdate = true;
        installed.hasConflict = Boolean(installed.isDirty);
        if (remoteVersion) installed.lastCheckedVersion = remoteVersion;
        // Persist the head date alongside the flag: later sweeps can fail
        // their probes (expired GitLab session, offline) yet must still be
        // able to show real drift for a row whose flag survives on disk.
        // Never downgrade a known date to null.
        if (headCommittedAt) installed.updateHeadCommittedAt = headCommittedAt;
        updates.push({
          skillId: installed.skillId,
          marketplaceId: installed.marketplaceId,
          installedVersion: installed.installedVersion,
          // null when the touched skill's SKILL.md fetch failed — display
          // only; the flag itself came from the changed-paths compare.
          remoteVersion,
          headCommittedAt,
        });
        continue;
      }
      // kind === "fallback": legacy per-skill version compare below.
    }
    if (!remoteProbes.has(installed)) continue; // short-circuited repo
    const fallbackProbe = remoteProbes.get(installed) || { present: null, version: null };
    if (fallbackProbe.present === false) {
      // Definitive 404 at the recorded path — same missing verdict as the
      // touched branch (legacy compare would otherwise keep stale flags
      // alive forever for a deleted skill).
      markInstalledSourceMissing(installed);
      if (!installed.sourceMissingSince && removalDatesByRecord.has(installed)) {
        installed.sourceMissingSince = removalDatesByRecord.get(installed);
      }
      continue;
    }
    if (fallbackProbe.present === true) {
      delete installed.sourceMissing;
      delete installed.sourceMissingSince;
    }
    const remoteVersion = fallbackProbe.version;

    if (!remoteVersion) {
      // The remote version could not be determined (offline, headless run
      // without git auth, or no version in the remote SKILL.md). Keep the
      // last-synced flags instead of wiping them — a passive freshness scan
      // must never erase update state a real sync previously found.
      continue;
    }

    if (hasNewerVersion(installed.installedVersion, remoteVersion)) {
      const headCommittedAt = headDatesByGroup.get(entry.groupKey) || null;
      installed.hasUpdate = true;
      installed.lastCheckedVersion = remoteVersion;
      installed.hasConflict = Boolean(installed.isDirty);
      if (headCommittedAt) installed.updateHeadCommittedAt = headCommittedAt;
      updates.push({
        skillId: installed.skillId,
        marketplaceId: installed.marketplaceId,
        installedVersion: installed.installedVersion,
        remoteVersion,
        // Best-effort head-commit date of the moved repo (null when the sha
        // probe didn't run for this group) — display-only.
        headCommittedAt,
      });
    } else {
      installed.hasUpdate = false;
      installed.hasConflict = false;
      installed.lastCheckedVersion = remoteVersion;
      delete installed.updateHeadCommittedAt;
    }
  }

  // Stale keys (groups that no longer exist) fall away because nextShas is
  // rebuilt from live groups each sweep.
  if (Object.keys(nextShas).length) {
    config.skillFreshnessShas = nextShas;
  } else {
    delete config.skillFreshnessShas;
  }

  const persistedAfter = JSON.stringify(configForPersistence(config));
  const saved = persistedAfter !== persistedBefore;
  if (saved) {
    await saveMarketplacesConfig(projectRoot, config);
  }
  logger.log?.(
    `[Marketplace] update check: ${config.installedSkills.length} installed, updates for [${updates
      .map((entry) => `${entry.marketplaceId}/${entry.skillId}`)
      .join(", ")}]`,
  );
  logMarketplaceDiag("update-check", "ok", {
    durationMs: Date.now() - startedAt,
    installedCount: config.installedSkills.length,
    solutionsChecked: stats.solutionsChecked,
    solutionsSearchUsed: stats.solutionsSearchUsed,
    gitReposChecked: stats.gitReposChecked,
    gitSkillsFetched: stats.gitSkillsFetched,
    shaShortCircuits: stats.shaShortCircuits,
    contentCompares: stats.contentCompares,
    baselineBackfills: stats.baselineBackfills,
    removalStampsFetched: stats.removalStampsFetched,
    updatesFound: updates.length,
    saved,
  });
  return {
    updates,
    hasUpdates: updates.length > 0,
  };
}

function updateMarketplaceSkill(options) {
  return withRegistryWriteLock(() => updateMarketplaceSkillUnlocked(options));
}

async function updateMarketplaceSkillUnlocked({
  projectRoot,
  marketplaceId,
  skillId,
  pluginName = null,
  forceDiscardLocalChanges = false,
  interactiveAuth = true,
  logger = console,
}) {
  const config = await loadMarketplacesConfig(projectRoot, { logger });
  const { record: installedSkill } = requireInstalledSkillRecord(config, {
    marketplaceId,
    skillId,
    pluginName,
  });

  if (installedSkill.isDirty && !forceDiscardLocalChanges) {
    throw createMarketplaceError(
      `Skill "${skillId}" has local changes. Discard local changes or detach it to a user skill before syncing marketplace updates.`,
      "marketplace_skill_dirty",
      {
        marketplaceId,
        skillId,
      },
    );
  }

  const marketplace = config.marketplaces.find((entry) => entry.id === marketplaceId);
  if (!marketplace) {
    throw createMarketplaceError(
      `Marketplace "${marketplaceId}" not found`,
      "marketplace_not_found",
    );
  }

  const destinationPath = path.join(projectRoot, installedSkill.localPath);
  const remoteSource = resolveRemoteSkillSource(
    installedSkill.skillSource,
    marketplace.source,
  );
  // Probe before download: the stamp may lag the fetched content, never
  // lead it (a commit in the window causes at most one spurious flag).
  const headSha = remoteSkillSourceGroupKey(remoteSource)
    ? await fetchRemoteHeadCommitSha(remoteSource, { interactiveAuth })
    : null;
  const persistedSource = await downloadSkillDirectory(
    remoteSource,
    installedSkill.skillPath,
    destinationPath,
    { interactiveAuth },
  );

  const newVersion = await readInstalledSkillVersion(destinationPath, "1.0");
  const baseline = await buildInstalledSkillBaseline(destinationPath, {
    installedVersion: newVersion,
    sourceRef: persistedSource?.ref,
  });
  installedSkill.installedVersion = newVersion;
  installedSkill.lastCheckedVersion = newVersion;
  installedSkill.hasUpdate = false;
  installedSkill.isDirty = false;
  installedSkill.hasConflict = false;
  delete installedSkill.updateHeadCommittedAt;
  installedSkill.baseline = baseline;
  // Content replaced: stamp the fetched head, or delete a stale stamp when
  // the probe failed (same rule as the sync refresh leg).
  if (headSha) {
    installedSkill.contentHeadSha = headSha;
  } else {
    delete installedSkill.contentHeadSha;
  }
  installedSkill.updatedAt = new Date().toISOString();
  if (installedSkill.skillSource && typeof installedSkill.skillSource === "object") {
    installedSkill.skillSource = persistedSource;
  }

  await saveMarketplacesConfig(projectRoot, config);
  return { version: newVersion };
}

module.exports = {
  // Freshness/dirtiness primitives (exported for the agent-update
  // dependency-refresh decision in ai-marketplace-operations).
  remoteTimestampIsNewer,
  computeInstalledSkillState,
  resolveRemoteSkillSource,
  DEFAULT_MARKETPLACE_CONFIG,
  MARKETPLACE_MANIFEST_PATH,
  PLUGIN_METADATA_PATH,
  addMarketplace,
  checkSkillUpdates,
  resetSweepCoalesceForTests,
  countTotalSkills,
  createMarketplaceError,
  downloadSkillDirectory,
  normalizeManifestCached,
  fetchRemoteSkillVersion,
  getMarketplaceSkills,
  getMarketplaceSkillsCached,
  getInstalledAiMarketplaceSkillSource,
  hasNewerVersion,
  installMarketplaceSkill,
  loadMarketplaceDefinition,
  isSameRepositorySource,
  loadMarketplacesConfig,
  normalizeMarketplaceSourceInput,
  normalizeMarketplacesConfig,
  parseSkillsFromManifest,
  pruneNestedSkillPaths,
  reconcileMarketplaceState,
  runStartupMarketplaceIntegrityPass,
  removeMarketplace,
  saveMarketplacesConfig,
  syncAllMarketplaces,
  syncMarketplace,
  applyMarketplaceSyncRemovals,
  synthesizeSparseManifest,
  uninstallMarketplaceSkill,
  detachMarketplaceSkillToUserSkill,
  resolveUniqueUserSkillDirectoryName,
  sanitizeUserSkillDirectoryName,
  upsertInstalledSkillRecord,
  removeInstalledSkillRecords,
  updateMarketplaceSkill,
  withRegistryWriteLock,
};
