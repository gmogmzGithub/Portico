const fs = require("node:fs");
const fsPromises = fs.promises;
const path = require("node:path");
const crypto = require("node:crypto");
const {
  getSkillVersionFromFrontmatter,
  parseSkillMarkdownFrontmatter,
} = require("./skill-frontmatter");
const { logMarketplaceDiag, safeErrorMeta } = require("./marketplace-diagnostics");

// Seeded installs that diverged from the bundle get preserved on every config
// read; warn once per app run per skill instead of flooding the log.
const preservedSkillWarnsThisRun = new Set();

const DEFAULT_MARKETPLACE_CONFIG = {
  version: "1.0",
  marketplaces: [],
  installedSkills: [],
};

function normalizeMarketplacesConfig(config) {
  const normalized = { ...(config || {}) };
  normalized.version =
    typeof config?.version === "string"
      ? config.version
      : DEFAULT_MARKETPLACE_CONFIG.version;
  normalized.marketplaces = Array.isArray(config?.marketplaces)
    ? config.marketplaces
    : [];
  normalized.installedSkills = Array.isArray(config?.installedSkills)
    ? config.installedSkills
    : [];
  return normalized;
}

function resolveMarketplaceStoragePaths(projectRoot) {
  const liveConfigPath = path.join(projectRoot, "marketplaces.json");
  const bundledConfigPath = path.join(projectRoot, "marketplaces-ootb.json");
  const checkedInConfigPath = path.join(
    projectRoot,
    "marketplaces-ootb",
    "marketplaces.json",
  );
  const liveSkillsDir = path.join(projectRoot, "skills-marketplace");
  const bundledSkillsDir = path.join(projectRoot, "skills-marketplace-ootb");
  const checkedInSkillsDir = path.join(
    projectRoot,
    "marketplaces-ootb",
    "skills-marketplace",
  );

  return {
    liveConfigPath,
    bundledConfigPath,
    checkedInConfigPath,
    ootbConfigPath: fs.existsSync(bundledConfigPath)
      ? bundledConfigPath
      : fs.existsSync(checkedInConfigPath)
        ? checkedInConfigPath
        : liveConfigPath,
    liveSkillsDir,
    bundledSkillsDir,
    checkedInSkillsDir,
    ootbSkillsDir: fs.existsSync(bundledSkillsDir)
      ? bundledSkillsDir
      : fs.existsSync(checkedInSkillsDir)
        ? checkedInSkillsDir
        : liveSkillsDir,
  };
}

async function readJsonFileIfExists(filePath) {
  try {
    const content = await fsPromises.readFile(filePath, "utf8");
    return { success: true, data: JSON.parse(content) };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { success: false, missing: true, error };
    }
    return { success: false, missing: false, error };
  }
}

// Whether (marketplaceId, skillId) names one of the bundled OOTB installed-
// skill seeds. Uses the exact merge key of the seed re-merge below —
// (marketplaceId, leafSkillId), pluginName excluded — because that is the key
// the merge pass restores when the live record goes missing. Removal
// chokepoints (uninstall/detach) consult this to fail clearly up front:
// removing a seed-listed record was always self-defeating, since the next
// config load re-seeds the record and payload (and, after a detach, that
// restore silently duplicates the content as install + user copy). When no
// distinct bundled/checked-in seed source exists, ootbConfigPath falls back
// to the live config itself — removals are durable there, so nothing reports
// as seeded.
async function isOotbSeededInstall(projectRoot, { marketplaceId, skillId } = {}) {
  if (!marketplaceId || !skillId) {
    return false;
  }
  const keys = await listOotbSeededKeys(projectRoot);
  return keys.has(`${marketplaceId}/${skillId}`);
}

// Bulk form of the seed check for catalog/list assembly: one OOTB read per
// call instead of one per skill. Same merge key — `${marketplaceId}/${skillId}`,
// pluginName excluded. Empty set when no distinct seed source exists.
async function listOotbSeededKeys(projectRoot) {
  const paths = resolveMarketplaceStoragePaths(projectRoot);
  if (paths.ootbConfigPath === paths.liveConfigPath) {
    return new Set();
  }
  const ootbConfigResult = await readJsonFileIfExists(paths.ootbConfigPath);
  if (!ootbConfigResult.success || !ootbConfigResult.data) {
    return new Set();
  }
  const ootbConfig = normalizeMarketplacesConfig(ootbConfigResult.data);
  return new Set(
    ootbConfig.installedSkills
      .filter((entry) => entry?.marketplaceId && entry?.skillId)
      .map((entry) => `${entry.marketplaceId}/${entry.skillId}`),
  );
}

function mergeCachedManifestAdditions(existingManifest, ootbManifest) {
  if (!existingManifest || typeof existingManifest !== "object") {
    return ootbManifest;
  }
  if (!ootbManifest || typeof ootbManifest !== "object") {
    return existingManifest;
  }

  const existingPlugins = Array.isArray(existingManifest.plugins)
    ? existingManifest.plugins
    : [];
  const ootbPlugins = Array.isArray(ootbManifest.plugins)
    ? ootbManifest.plugins
    : [];
  const mergedPlugins = [...existingPlugins];
  const pluginIndexes = new Map(
    mergedPlugins
      .map((plugin, index) => [plugin?.name, index])
      .filter(([name]) => typeof name === "string" && name),
  );

  for (const ootbPlugin of ootbPlugins) {
    if (!ootbPlugin?.name) continue;

    const existingIndex = pluginIndexes.get(ootbPlugin.name);
    if (existingIndex === undefined) {
      mergedPlugins.push(ootbPlugin);
      pluginIndexes.set(ootbPlugin.name, mergedPlugins.length - 1);
      continue;
    }

    const existingPlugin = mergedPlugins[existingIndex];
    if (
      !Array.isArray(existingPlugin?.skills) ||
      !Array.isArray(ootbPlugin.skills)
    ) {
      continue;
    }

    const mergedSkills = [...existingPlugin.skills];
    const existingSkills = new Set(mergedSkills);
    for (const skillPath of ootbPlugin.skills) {
      if (typeof skillPath !== "string" || existingSkills.has(skillPath)) {
        continue;
      }
      mergedSkills.push(skillPath);
      existingSkills.add(skillPath);
    }

    if (mergedSkills.length !== existingPlugin.skills.length) {
      mergedPlugins[existingIndex] = {
        ...existingPlugin,
        skills: mergedSkills,
      };
    }
  }

  if (
    mergedPlugins.length === existingPlugins.length &&
    mergedPlugins.every((plugin, index) => plugin === existingPlugins[index])
  ) {
    return existingManifest;
  }

  return {
    ...existingManifest,
    plugins: mergedPlugins,
  };
}

function mergeMarketplaceEntry(existing, ootb) {
  const merged = {
    ...(existing || {}),
    ...(ootb || {}),
  };

  for (const key of [
    "enabled",
    "addedAt",
    "marketplaceVersion",
    "lastSynced",
  ]) {
    if (existing && existing[key] !== undefined) {
      merged[key] = existing[key];
    }
  }

  if (existing?.cachedManifest !== undefined) {
    // Union gate: a live manifest synced MORE RECENTLY than the bundle
    // snapshot is fresher truth — unioning the bundle's plugins back in
    // would resurrect entries upstream deliberately dropped (the dead
    // ux-quality-beta plugin kept reappearing this way). Missing or
    // unparseable stamps keep today's union so brand-new OOTB plugins stay
    // visible to never-synced users. This only stops future re-poisoning; an
    // already-unioned stale plugin is scrubbed by the next sync's wholesale
    // manifest replace.
    const existingSyncedAt = Date.parse(existing?.lastSynced ?? "");
    const ootbSyncedAt = Date.parse(ootb?.lastSynced ?? "");
    const liveManifestIsNewer =
      Number.isFinite(existingSyncedAt) &&
      Number.isFinite(ootbSyncedAt) &&
      existingSyncedAt > ootbSyncedAt;
    merged.cachedManifest = liveManifestIsNewer
      ? existing.cachedManifest
      : mergeCachedManifestAdditions(
          existing.cachedManifest,
          ootb?.cachedManifest,
        );
  }

  return merged;
}

function mergeInstalledSkillEntry(existing, ootb, installedVersion, installedAt) {
  const merged = {
    ...(existing || {}),
    ...(ootb || {}),
  };

  merged.installedAt =
    existing?.installedAt || ootb?.installedAt || installedAt;
  merged.installedVersion = installedVersion;
  // Freshness fields survive the load-time seed re-merge: this runs on every
  // registry load, not just installs, and resetting hasUpdate here silently
  // erased update flags a real freshness check had persisted (2026-08-01
  // sharing-run ISSUE-6). Only an actual version change (live content
  // refreshed from the bundle) restarts the freshness baseline.
  const liveVersionChanged =
    Boolean(existing) && existing.installedVersion !== installedVersion;
  merged.lastCheckedVersion =
    !liveVersionChanged && existing?.lastCheckedVersion
      ? existing.lastCheckedVersion
      : installedVersion;
  merged.hasUpdate = liveVersionChanged ? false : Boolean(existing?.hasUpdate);
  // The record's source identity — localPath + pluginName + skillPath +
  // skillSource — travels as a UNIT and EXISTING wins: a legacy flat live
  // record must keep pointing at its real on-disk directory (the
  // plugin-layout migration moves it later), and an already-migrated or
  // marketplace-healed record must never be reverted by a seed re-merge.
  // Re-pointing one identity field without the others is what wedged the
  // 2026-08-11 ux-quality rename incident (seed skillPath overwrote healed
  // records on every load while localPath kept the old layout). Deliberate
  // bundle-driven identity changes happen ONLY through seedMigrations,
  // atomically, before this merge runs. Seeds for brand-new users (no live
  // record / no localPath) still adopt the bundled identity verbatim.
  if (existing?.localPath) {
    merged.localPath = existing.localPath;
    merged.pluginName = existing.pluginName ?? null;
    merged.skillPath = existing.skillPath || ootb?.skillPath || "./";
    merged.skillSource =
      existing.skillSource !== undefined
        ? existing.skillSource
        : ootb?.skillSource ?? null;
  } else {
    merged.localPath = ootb?.localPath || merged.localPath || null;
    merged.pluginName = ootb?.pluginName ?? merged.pluginName ?? null;
    merged.skillPath =
      ootb?.skillPath || existing?.skillPath || merged.skillPath || "./";
    merged.skillSource =
      ootb?.skillSource !== undefined
        ? ootb.skillSource
        : existing?.skillSource ?? null;
  }

  return merged;
}

// An installed record's directory relative to a skills-marketplace root:
// its own localPath minus the leading "skills-marketplace/" segment, falling
// back to the legacy flat {mp}/{skill} shape.
function installedSkillDirSegments(entry) {
  const localPath = String(entry?.localPath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  const segments = localPath.split("/").filter(Boolean);
  if (segments[0] === "skills-marketplace" && segments.length >= 3) {
    return segments.slice(1);
  }
  return [entry?.marketplaceId, entry?.skillId].filter(Boolean);
}

// --- seedMigrations: bundle-declared identity moves -------------------------
//
// The OOTB bundle may carry `seedMigrations`: a flat alias map of historical
// seed identities to their current identity, generated by the mirror script
// under operator review. Identity rewrites happen ONLY through these declared
// entries — never from a bare bundle-vs-record mismatch. A bare-mismatch rule
// would run backwards on machines whose live state is FRESHER than a stale
// bundle (record already at the renamed path, bundle still at the old one)
// and re-wedge exactly the records it was built to heal.

function normalizeIdentityPart(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function seedIdentityKey(marketplaceId, pluginName, skillId) {
  return [
    normalizeIdentityPart(marketplaceId) ?? "",
    normalizeIdentityPart(pluginName) ?? "",
    normalizeIdentityPart(skillId) ?? "",
  ].join(" ");
}

function normalizeSeedSkillPath(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  return value.trim().replace(/^\.\//, "").replace(/\/+$/, "");
}

function normalizeSeedMigrationEndpoint(raw, { allowSkillPath = false } = {}) {
  const marketplaceId = normalizeIdentityPart(raw?.marketplaceId);
  const skillId = normalizeIdentityPart(raw?.skillId);
  if (!marketplaceId || !skillId) {
    return null;
  }
  const endpoint = {
    marketplaceId,
    pluginName: normalizeIdentityPart(raw?.pluginName),
    skillId,
  };
  if (allowSkillPath) {
    // Optional discriminator for same-triple moves (plugin name unchanged,
    // repo path relocated): the migration then applies only to records still
    // pinned to the old path.
    endpoint.skillPath = normalizeSeedSkillPath(raw?.skillPath);
  }
  return endpoint;
}

// Tolerant parse: invalid entries are dropped, degenerate entries (from ===
// to with no skillPath discriminator) are dropped, later duplicates of the
// same `from` are dropped. A broken migrations list must degrade to "fewer
// heals", never to a failed load.
function normalizeSeedMigrations(rawList) {
  if (!Array.isArray(rawList)) {
    return [];
  }
  const migrations = [];
  const seenFromKeys = new Set();
  for (const raw of rawList) {
    const from = normalizeSeedMigrationEndpoint(raw?.from, { allowSkillPath: true });
    const to = normalizeSeedMigrationEndpoint(raw?.to);
    if (!from || !to) {
      continue;
    }
    const fromTripleKey = seedIdentityKey(from.marketplaceId, from.pluginName, from.skillId);
    const toTripleKey = seedIdentityKey(to.marketplaceId, to.pluginName, to.skillId);
    if (fromTripleKey === toTripleKey && !from.skillPath) {
      continue;
    }
    const fromKey = `${fromTripleKey} ${from.skillPath ?? ""}`;
    if (seenFromKeys.has(fromKey)) {
      continue;
    }
    seenFromKeys.add(fromKey);
    migrations.push({ from, to });
  }
  return migrations;
}

// Read the bundle's declared migrations for out-of-module consumers (the
// agent skill-relink sweep). Live-config fallback sources never declare
// migrations, mirroring how isOotbSeededInstall reports nothing seeded there.
async function loadOotbSeedMigrations(projectRoot) {
  const paths = resolveMarketplaceStoragePaths(projectRoot);
  if (paths.ootbConfigPath === paths.liveConfigPath) {
    return [];
  }
  const ootbConfigResult = await readJsonFileIfExists(paths.ootbConfigPath);
  if (!ootbConfigResult.success || !ootbConfigResult.data) {
    return [];
  }
  return normalizeSeedMigrations(ootbConfigResult.data.seedMigrations);
}

// Segments of a seed's payload dir below skills-marketplace/, from its own
// canonical localPath with a defensive plugin-aware fallback.
function seedDirSegments(seed) {
  const segments = installedSkillDirSegments(seed);
  if (segments.length >= 2) {
    return segments;
  }
  return [seed?.marketplaceId, seed?.pluginName, seed?.skillId].filter(Boolean);
}

async function removeDirIfEmpty(dirPath) {
  try {
    await fsPromises.rmdir(dirPath);
    return true;
  } catch {
    return false;
  }
}

// After a payload move, fold up now-empty parents (plugin dir, then
// marketplace dir) without ever touching the skills-marketplace root.
async function pruneEmptySeedParents(liveSkillsDir, movedDirPath) {
  const root = path.resolve(liveSkillsDir);
  let current = path.dirname(path.resolve(movedDirPath));
  while (current.startsWith(root) && current !== root) {
    if (!(await removeDirIfEmpty(current))) {
      return;
    }
    current = path.dirname(current);
  }
}

// Move a seed payload dir copy-then-delete. Returns true when the target now
// holds the payload and the source is gone (or was already gone). Never
// deletes the source before the copy is verified byte-identical.
async function moveSeedPayloadDir(sourceDir, targetDir, liveSkillsDir) {
  const copied = await seedDirectoryAtomically(sourceDir, targetDir);
  if (!copied && !fs.existsSync(targetDir)) {
    return false;
  }
  if (copied) {
    const verified = await pathsMatchContents(sourceDir, targetDir);
    if (!verified) {
      // We created the copy and it does not match — undo it and report
      // failure so the record is left untouched for a clean retry.
      await fsPromises.rm(targetDir, { recursive: true, force: true }).catch(() => {});
      return false;
    }
  }
  await fsPromises.rm(sourceDir, { recursive: true, force: true });
  await pruneEmptySeedParents(liveSkillsDir, sourceDir);
  return true;
}

// Apply the bundle's declared seed identity migrations to the live records.
// Mutates `records` in place (index-replacement) and returns whether anything
// changed. Every guard skips with a diag instead of guessing — the next load
// retries cleanly from whatever state this one reached.
async function applySeedIdentityMigrations({
  records,
  seeds,
  migrations,
  liveSkillsDir,
}) {
  if (!migrations.length || !records.length) {
    return false;
  }

  const migrationsByFromTriple = new Map();
  for (const migration of migrations) {
    const tripleKey = seedIdentityKey(
      migration.from.marketplaceId,
      migration.from.pluginName,
      migration.from.skillId,
    );
    if (!migrationsByFromTriple.has(tripleKey)) {
      migrationsByFromTriple.set(tripleKey, []);
    }
    migrationsByFromTriple.get(tripleKey).push(migration);
  }
  const seedsByKey = new Map();
  for (const seed of seeds) {
    if (seed?.marketplaceId && seed?.skillId) {
      seedsByKey.set(`${seed.marketplaceId}/${seed.skillId}`, seed);
    }
  }

  let changed = false;
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record?.marketplaceId || !record?.skillId) {
      continue;
    }
    const candidates = migrationsByFromTriple.get(
      seedIdentityKey(record.marketplaceId, record.pluginName, record.skillId),
    );
    const migration = (candidates || []).find(
      (candidate) =>
        !candidate.from.skillPath ||
        candidate.from.skillPath === normalizeSeedSkillPath(record.skillPath),
    );
    if (!migration) {
      continue;
    }

    const diagBase = {
      marketplaceId: record.marketplaceId,
      skillId: record.skillId,
      fromPluginName: record.pluginName ?? null,
      toMarketplaceId: migration.to.marketplaceId,
      toSkillId: migration.to.skillId,
      toPluginName: migration.to.pluginName ?? null,
    };

    // The migration target must be a CURRENT seed with a matching identity —
    // a dead or drifted target means the bundle and its alias map disagree,
    // and guessing which side is right is exactly what this system refuses
    // to do.
    const targetSeed = seedsByKey.get(
      `${migration.to.marketplaceId}/${migration.to.skillId}`,
    );
    if (!targetSeed) {
      logMarketplaceDiag("ootb", "seed:identity-migrate-skipped", {
        ...diagBase,
        reason: "target_not_seeded",
      });
      continue;
    }
    if (
      (normalizeIdentityPart(targetSeed.pluginName) ?? null) !==
      (migration.to.pluginName ?? null)
    ) {
      logMarketplaceDiag("ootb", "seed:identity-migrate-skipped", {
        ...diagBase,
        reason: "target_plugin_mismatch",
      });
      continue;
    }
    const targetOccupied = records.some(
      (other, otherIndex) =>
        otherIndex !== index &&
        other?.marketplaceId === migration.to.marketplaceId &&
        other?.skillId === migration.to.skillId,
    );
    if (targetOccupied) {
      logMarketplaceDiag("ootb", "seed:identity-migrate-skipped", {
        ...diagBase,
        reason: "target_record_occupied",
      });
      continue;
    }

    const sourceDir = path.join(
      liveSkillsDir,
      ...installedSkillDirSegments(record),
    );
    const targetDir = path.join(liveSkillsDir, ...seedDirSegments(targetSeed));

    try {
      if (fs.existsSync(sourceDir) && path.resolve(sourceDir) !== path.resolve(targetDir)) {
        if (fs.existsSync(targetDir)) {
          logMarketplaceDiag("ootb", "seed:identity-migrate-skipped", {
            ...diagBase,
            reason: "target_dir_occupied",
          });
          continue;
        }
        const moved = await moveSeedPayloadDir(sourceDir, targetDir, liveSkillsDir);
        if (!moved) {
          logMarketplaceDiag("ootb", "seed:identity-migrate-skipped", {
            ...diagBase,
            reason: "payload_move_failed",
          });
          continue;
        }
      }
      // Source dir absent: nothing to move. Either a previous partial run
      // already relocated the payload, or the payload is simply gone — the
      // seed loop below re-copies the bundled payload at the new location.
    } catch (error) {
      logMarketplaceDiag("ootb", "seed:identity-migrate-skipped", {
        ...diagBase,
        reason: "payload_move_error",
        ...safeErrorMeta(error),
      });
      continue;
    }

    // Identity fields come from the seed as a unit; everything else —
    // baseline, contentHeadSha, hasUpdate, versions, timestamps — is
    // preserved so content reconciliation stays with the sync/update flows.
    const migrated = {
      ...record,
      marketplaceId: targetSeed.marketplaceId,
      skillId: targetSeed.skillId,
      pluginName: normalizeIdentityPart(targetSeed.pluginName),
      skillPath: targetSeed.skillPath || record.skillPath || "./",
      skillSource:
        targetSeed.skillSource !== undefined
          ? targetSeed.skillSource
          : (record.skillSource ?? null),
      localPath:
        targetSeed.localPath ||
        ["skills-marketplace", ...seedDirSegments(targetSeed)].join("/"),
    };
    if (JSON.stringify(migrated) === JSON.stringify(record)) {
      continue; // already at the target identity — keep loads byte-stable
    }
    records[index] = migrated;
    changed = true;
    logMarketplaceDiag("ootb", "seed:identity-migrated", diagBase);
  }

  return changed;
}

async function readInstalledSkillVersion(skillDirPath, fallbackVersion = "1.0") {
  try {
    const skillMdPath = path.join(skillDirPath, "SKILL.md");
    const content = await fsPromises.readFile(skillMdPath, "utf8");
    const frontmatter = parseSkillMarkdownFrontmatter(content);
    return getSkillVersionFromFrontmatter(frontmatter, fallbackVersion);
  } catch {
    return fallbackVersion;
  }
}

async function pathsMatchContents(sourcePath, targetPath) {
  let sourceStat;
  let targetStat;

  try {
    [sourceStat, targetStat] = await Promise.all([
      fsPromises.lstat(sourcePath),
      fsPromises.lstat(targetPath),
    ]);
  } catch (error) {
    return false;
  }

  if (sourceStat.isDirectory() !== targetStat.isDirectory()) {
    return false;
  }

  if (sourceStat.isSymbolicLink() !== targetStat.isSymbolicLink()) {
    return false;
  }

  if (sourceStat.isDirectory()) {
    const [sourceEntries, targetEntries] = await Promise.all([
      fsPromises.readdir(sourcePath, { withFileTypes: true }),
      fsPromises.readdir(targetPath, { withFileTypes: true }),
    ]);

    if (sourceEntries.length !== targetEntries.length) {
      return false;
    }

    const sourceByName = new Map(sourceEntries.map((entry) => [entry.name, entry]));
    const targetByName = new Map(targetEntries.map((entry) => [entry.name, entry]));

    for (const [entryName, sourceEntry] of sourceByName.entries()) {
      const targetEntry = targetByName.get(entryName);
      if (!targetEntry) {
        return false;
      }
      if (
        sourceEntry.isDirectory() !== targetEntry.isDirectory() ||
        sourceEntry.isFile() !== targetEntry.isFile() ||
        sourceEntry.isSymbolicLink() !== targetEntry.isSymbolicLink()
      ) {
        return false;
      }

      const entryMatches = await pathsMatchContents(
        path.join(sourcePath, entryName),
        path.join(targetPath, entryName),
      );
      if (!entryMatches) {
        return false;
      }
    }

    return true;
  }

  if (sourceStat.isSymbolicLink()) {
    const [sourceLink, targetLink] = await Promise.all([
      fsPromises.readlink(sourcePath),
      fsPromises.readlink(targetPath),
    ]);
    return sourceLink === targetLink;
  }

  if (!sourceStat.isFile() || !targetStat.isFile()) {
    return false;
  }

  if (sourceStat.size !== targetStat.size) {
    return false;
  }

  const [sourceContent, targetContent] = await Promise.all([
    fsPromises.readFile(sourcePath),
    fsPromises.readFile(targetPath),
  ]);
  return sourceContent.equals(targetContent);
}

async function seedDirectoryAtomically(sourceDir, targetDir) {
  if (path.resolve(sourceDir) === path.resolve(targetDir)) {
    return false;
  }
  if (fs.existsSync(targetDir)) {
    return false;
  }

  const targetParent = path.dirname(targetDir);
  const targetName = path.basename(targetDir);
  const stagingPrefix = `.${targetName}.ootb-seed-`;
  await fsPromises.mkdir(targetParent, { recursive: true });

  for (const entry of await fsPromises.readdir(targetParent, {
    withFileTypes: true,
  })) {
    if (entry.name.startsWith(stagingPrefix)) {
      await fsPromises.rm(path.join(targetParent, entry.name), {
        recursive: true,
        force: true,
      });
    }
  }

  const stagingDir = path.join(
    targetParent,
    `${stagingPrefix}${crypto.randomUUID()}`,
  );
  try {
    await fsPromises.cp(sourceDir, stagingDir, { recursive: true });
    try {
      await fsPromises.rename(stagingDir, targetDir);
      return true;
    } catch (error) {
      if (
        fs.existsSync(targetDir) &&
        ["EEXIST", "ENOTEMPTY"].includes(error.code)
      ) {
        return false;
      }
      throw error;
    }
  } finally {
    await fsPromises.rm(stagingDir, { recursive: true, force: true });
  }
}

async function ensureBundledMarketplaceDefaults(
  projectRoot,
  {
    logger = console,
    now = () => new Date().toISOString(),
  } = {},
) {
  const paths = resolveMarketplaceStoragePaths(projectRoot);
  const ootbConfigResult = await readJsonFileIfExists(paths.ootbConfigPath);
  const liveConfigResult = await readJsonFileIfExists(paths.liveConfigPath);

  const ootbConfig =
    ootbConfigResult.success && ootbConfigResult.data
      ? normalizeMarketplacesConfig(ootbConfigResult.data)
      : null;

  let liveConfig = null;
  let liveConfigWasInvalid = false;
  if (liveConfigResult.success && liveConfigResult.data) {
    liveConfig = normalizeMarketplacesConfig(liveConfigResult.data);
  } else if (!liveConfigResult.missing) {
    liveConfigWasInvalid = true;
    logger.warn?.(
      `[Marketplace] Failed to read marketplaces.json; rebuilding from bundled defaults: ${liveConfigResult.error.message}`,
    );
  }

  if (!ootbConfig && !liveConfig) {
    const emptyConfig = normalizeMarketplacesConfig(DEFAULT_MARKETPLACE_CONFIG);
    await fsPromises.mkdir(path.dirname(paths.liveConfigPath), {
      recursive: true,
    });
    await fsPromises.writeFile(
      paths.liveConfigPath,
      `${JSON.stringify(emptyConfig, null, 2)}\n`,
      "utf8",
    );
    return {
      updated: true,
      restoredFromBundledDefaults: false,
      paths,
      config: emptyConfig,
    };
  }

  if (!ootbConfig) {
    return {
      updated: false,
      restoredFromBundledDefaults: false,
      paths,
      config: liveConfig,
    };
  }

  const baseConfig =
    liveConfig || normalizeMarketplacesConfig(DEFAULT_MARKETPLACE_CONFIG);
  const mergedMarketplaces = [...baseConfig.marketplaces];
  const marketplacesById = new Map(
    mergedMarketplaces
      .filter((entry) => entry?.id)
      .map((entry, index) => [entry.id, { entry, index }]),
  );
  let updated = !liveConfig || liveConfigWasInvalid;
  let restoredFromBundledDefaults = !liveConfig || liveConfigWasInvalid;

  for (const ootbMarketplace of ootbConfig.marketplaces) {
    if (!ootbMarketplace?.id) continue;

    const existing = marketplacesById.get(ootbMarketplace.id);
    if (existing) {
      const merged = mergeMarketplaceEntry(existing.entry, ootbMarketplace);
      if (
        JSON.stringify(merged) !== JSON.stringify(existing.entry)
      ) {
        mergedMarketplaces[existing.index] = merged;
        updated = true;
      }
    } else {
      mergedMarketplaces.push(ootbMarketplace);
      marketplacesById.set(ootbMarketplace.id, {
        entry: ootbMarketplace,
        index: mergedMarketplaces.length - 1,
      });
      updated = true;
      restoredFromBundledDefaults = true;
    }
  }

  const mergedInstalledSkills = [...baseConfig.installedSkills];

  // Declared identity migrations run BEFORE the seed merge below: they may
  // change record keys (plugin renames, leaf renames), and the merge must see
  // records at their migrated identities so seeds pair with them instead of
  // re-adding duplicates at the new key.
  try {
    const migrated = await applySeedIdentityMigrations({
      records: mergedInstalledSkills,
      seeds: ootbConfig.installedSkills,
      migrations: normalizeSeedMigrations(ootbConfig.seedMigrations),
      liveSkillsDir: paths.liveSkillsDir,
    });
    if (migrated) {
      updated = true;
    }
  } catch (error) {
    logger.warn?.(
      `[Marketplace] Seed identity migration pass failed; continuing without it: ${error.message}`,
    );
  }

  const installedSkillsByKey = new Map(
    mergedInstalledSkills
      .filter((entry) => entry?.marketplaceId && entry?.skillId)
      .map((entry, index) => [
        `${entry.marketplaceId}/${entry.skillId}`,
        { entry, index },
      ]),
  );

  for (const ootbInstalledSkill of ootbConfig.installedSkills) {
    // Per-entry isolation: one broken seed (unreadable payload, filesystem
    // error) must never abort the whole config load — every marketplace IPC
    // would fail and the Agent Skills Git tab would empty.
    try {
      if (!ootbInstalledSkill?.marketplaceId || !ootbInstalledSkill?.skillId) {
        continue;
      }

      // The merge key stays (marketplaceId, leafSkillId) so legacy flat live
      // records still match plugin-layout seeds.
      const skillKey = `${ootbInstalledSkill.marketplaceId}/${ootbInstalledSkill.skillId}`;
      const existing = installedSkillsByKey.get(skillKey);

      // Directories derive from each side's OWN localPath: the bundled
      // payload lives at the seed's (possibly plugin-layout) path, while a
      // legacy live record keeps its flat directory until the migration
      // moves it.
      const bundledSkillDir = path.join(
        paths.ootbSkillsDir,
        ...installedSkillDirSegments(ootbInstalledSkill),
      );
      const liveSkillDir = path.join(
        paths.liveSkillsDir,
        ...installedSkillDirSegments(existing?.entry || ootbInstalledSkill),
      );

      const bundledSkillExists = fs.existsSync(bundledSkillDir);
      const liveSkillExists = fs.existsSync(liveSkillDir);

      if (bundledSkillExists && liveSkillExists) {
        const contentsMatch = await pathsMatchContents(
          bundledSkillDir,
          liveSkillDir,
        );
        if (!contentsMatch) {
          // The seeder re-checks on every config read; one line per app run
          // per install is enough (this used to log 11 lines every few
          // seconds on machines with diverged seeded installs). Keyed by the
          // live directory so distinct projects (tests) stay independent.
          if (!preservedSkillWarnsThisRun.has(liveSkillDir)) {
            preservedSkillWarnsThisRun.add(liveSkillDir);
            logger.warn?.(
              `[Marketplace] Preserving existing skill ${skillKey}; bundled defaults never replace differing live content`,
            );
          }
          continue;
        }
      } else if (bundledSkillExists) {
        const copied = await seedDirectoryAtomically(
          bundledSkillDir,
          liveSkillDir,
        );
        updated = updated || copied;
        restoredFromBundledDefaults = restoredFromBundledDefaults || copied;
      }

      if (!fs.existsSync(liveSkillDir)) {
        continue;
      }

      const installedVersion = await readInstalledSkillVersion(
        liveSkillDir,
        ootbInstalledSkill.installedVersion || "1.0",
      );
      const merged = mergeInstalledSkillEntry(
        existing?.entry || null,
        ootbInstalledSkill,
        installedVersion,
        now(),
      );

      if (existing) {
        if (JSON.stringify(merged) !== JSON.stringify(existing.entry)) {
          mergedInstalledSkills[existing.index] = merged;
          installedSkillsByKey.set(skillKey, {
            entry: merged,
            index: existing.index,
          });
          updated = true;
        }
      } else {
        mergedInstalledSkills.push(merged);
        installedSkillsByKey.set(skillKey, {
          entry: merged,
          index: mergedInstalledSkills.length - 1,
        });
        updated = true;
        restoredFromBundledDefaults = true;
      }
    } catch (error) {
      logger.warn?.(
        `[Marketplace] Skipping bundled seed for ${ootbInstalledSkill?.marketplaceId || "unknown"}/${ootbInstalledSkill?.skillId || "unknown"}: ${error.message}`,
      );
    }
  }

  const mergedConfig = normalizeMarketplacesConfig({
    ...baseConfig,
    version: ootbConfig.version || baseConfig.version,
    marketplaces: mergedMarketplaces,
    installedSkills: mergedInstalledSkills,
  });

  if (
    updated ||
    JSON.stringify(mergedConfig) !== JSON.stringify(liveConfig)
  ) {
    await fsPromises.mkdir(path.dirname(paths.liveConfigPath), {
      recursive: true,
    });
    await fsPromises.writeFile(
      paths.liveConfigPath,
      `${JSON.stringify(mergedConfig, null, 2)}\n`,
      "utf8",
    );
    updated = true;
  }

  return {
    updated,
    restoredFromBundledDefaults,
    paths,
    config: mergedConfig,
  };
}

module.exports = {
  DEFAULT_MARKETPLACE_CONFIG,
  normalizeMarketplacesConfig,
  resolveMarketplaceStoragePaths,
  mergeCachedManifestAdditions,
  mergeMarketplaceEntry,
  mergeInstalledSkillEntry,
  isOotbSeededInstall,
  listOotbSeededKeys,
  readInstalledSkillVersion,
  ensureBundledMarketplaceDefaults,
  normalizeSeedMigrations,
  loadOotbSeedMigrations,
};
