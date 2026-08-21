// AI Marketplace ↔ local skill link registry.
// State & Persistence layer. Sidecar JSON in userData; one entry per local skill
// that has a published marketplace copy. Used so that publishing an agent can
// reuse (update) an existing skill solution instead of creating duplicates.
//
// Shape (on disk):
//   {
//     "links": {
//       "<local_skill_name>": {
//         "solutionId": "<uuid>",
//         "publishedAt": 1717512345000,
//         "lastUpdatedAt": 1717512345000,
//         "hasLocalChanges": false
//       }
//     }
//   }
//
// hasLocalChanges is an event-driven "unpublished changes" marker: set by
// markLinkDirty when a skill file is saved locally, cleared by setLink (whose
// callers are publish success paths — local copy matches the marketplace).
// Links written before this field existed normalize to false, i.e. legacy
// skills are assumed clean until their next local save.

const crypto = require("node:crypto");
const { logMarketplaceDiag } = require("./marketplace-diagnostics");
const fsPromises = require("node:fs/promises");
const path = require("node:path");
const { createWriteLock } = require("./serial-write-lock");

const FILE_NAME = "ai-marketplace-skill-links.json";

function getLinksFilePath({ userDataPath } = {}) {
  // Lazy-require electron so the registry stays unit-testable in plain node when
  // an explicit userDataPath is supplied.
  const base = userDataPath || require("electron").app.getPath("userData");
  return path.join(base, FILE_NAME);
}

function emptyState() {
  return { links: {} };
}

function canonicalSkillName(localSkillName) {
  if (typeof localSkillName !== "string") return "";
  const parts = localSkillName
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
  return parts.at(-1) || "";
}

function normalizeState(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return emptyState();
  }
  const links =
    parsed.links && typeof parsed.links === "object" && !Array.isArray(parsed.links)
      ? parsed.links
      : {};
  const cleaned = {};
  for (const [key, value] of Object.entries(links)) {
    const canonicalKey = canonicalSkillName(key);
    if (!canonicalKey) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const solutionId =
      typeof value.solutionId === "string" ? value.solutionId.trim() : "";
    if (!solutionId) continue;
    cleaned[canonicalKey] = {
      solutionId,
      publishedAt:
        typeof value.publishedAt === "number" ? value.publishedAt : null,
      lastUpdatedAt:
        typeof value.lastUpdatedAt === "number"
          ? value.lastUpdatedAt
          : value.publishedAt || null,
      hasLocalChanges: value.hasLocalChanges === true,
    };
  }
  return { links: cleaned };
}

function validateStrictState(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Skill-link registry must be a JSON object");
  }
  if (!parsed.links || typeof parsed.links !== "object" || Array.isArray(parsed.links)) {
    throw new TypeError("Skill-link registry must contain a links object");
  }

  const canonicalKeys = new Map();
  for (const [rawKey, value] of Object.entries(parsed.links)) {
    const canonicalKey = canonicalSkillName(rawKey);
    if (
      !canonicalKey ||
      canonicalKey === "." ||
      canonicalKey === ".." ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value)
    ) {
      throw new TypeError("Skill-link registry contains an invalid link record");
    }
    const previousRawKey = canonicalKeys.get(canonicalKey);
    if (previousRawKey !== undefined) {
      throw new TypeError(
        `Skill-link registry contains ambiguous keys for ${canonicalKey}`,
      );
    }
    canonicalKeys.set(canonicalKey, rawKey);
    if (typeof value.solutionId !== "string" || !value.solutionId.trim()) {
      throw new TypeError(
        `Skill-link registry record ${rawKey} is missing solutionId`,
      );
    }
    for (const field of ["publishedAt", "lastUpdatedAt"]) {
      if (
        value[field] !== undefined &&
        value[field] !== null &&
        typeof value[field] !== "number"
      ) {
        throw new TypeError(
          `Skill-link registry record ${rawKey} has an invalid ${field}`,
        );
      }
    }
    if (
      value.hasLocalChanges !== undefined &&
      typeof value.hasLocalChanges !== "boolean"
    ) {
      throw new TypeError(
        `Skill-link registry record ${rawKey} has an invalid hasLocalChanges flag`,
      );
    }
  }
  return parsed;
}

async function readStateStrict(deps = {}) {
  const filePath = getLinksFilePath(deps);
  try {
    const stat = await fsPromises.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new TypeError("Skill-link registry must be a regular file");
    }
    const raw = await fsPromises.readFile(filePath, "utf8");
    return normalizeState(validateStrictState(JSON.parse(raw)));
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw error;
  }
}

async function readState(deps = {}) {
  const filePath = getLinksFilePath(deps);
  try {
    const raw = await fsPromises.readFile(filePath, "utf8");
    return normalizeState(JSON.parse(raw));
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    console.warn(
      `[ai-marketplace-skill-links] failed to read ${filePath}: ${error.message}`,
    );
    return emptyState();
  }
}

// Serialize read-modify-write cycles for the registry. Two mutations that
// interleave would otherwise (a) collide on the temp file and corrupt it and
// (b) lose each other's updates (both read the same base state, last writer
// wins). Reads stay lock-free: writeState renames atomically, so a reader
// always sees a complete file. See PORTICO-317.
const withWriteLock = createWriteLock();

async function writeState(state, deps = {}) {
  const filePath = getLinksFilePath(deps);
  const dir = path.dirname(filePath);
  await fsPromises.mkdir(dir, { recursive: true });
  // Unique temp name per write: process.pid alone is shared by every write in
  // this single-process app, so concurrent writers would clobber one shared
  // temp file and produce corrupt JSON (PORTICO-317).
  const tmp = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsPromises.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fsPromises.rename(tmp, filePath);
}

async function listLinks(deps = {}) {
  const state = await readState(deps);
  return state.links;
}

async function getLink(localSkillName, deps = {}) {
  const canonicalKey = canonicalSkillName(localSkillName);
  if (!canonicalKey) return null;
  const state = await readState(deps);
  return state.links[canonicalKey] || null;
}

async function setLink(localSkillName, solutionId, deps = {}) {
  const canonicalKey = canonicalSkillName(localSkillName);
  if (!canonicalKey) {
    throw new Error("setLink: localSkillName is required");
  }
  if (typeof solutionId !== "string" || !solutionId.trim()) {
    throw new Error("setLink: solutionId is required");
  }
  return withWriteLock(async () => {
    const state = await readState(deps);
    const now = Date.now();
    const existing = state.links[canonicalKey];
    state.links[canonicalKey] = {
      solutionId: solutionId.trim(),
      publishedAt: existing?.publishedAt || now,
      lastUpdatedAt: now,
      // Publish success means local == marketplace.
      hasLocalChanges: false,
    };
    await writeState(state, deps);
    logMarketplaceDiag("links", "skill:set", {
      skillId: canonicalKey,
      solutionId: solutionId.trim(),
      relink: Boolean(existing),
    });
    return state.links[canonicalKey];
  });
}

// Mark a linked skill as locally edited since its last publish. No-op (null)
// when the skill has no marketplace link.
async function markLinkDirty(localSkillName, deps = {}) {
  const canonicalKey = canonicalSkillName(localSkillName);
  if (!canonicalKey) return null;
  return withWriteLock(async () => {
    const state = await readState(deps);
    const existing = state.links[canonicalKey];
    if (!existing) return null;
    if (existing.hasLocalChanges === true) return existing;
    existing.hasLocalChanges = true;
    await writeState(state, deps);
    logMarketplaceDiag("links", "skill:marked-dirty", {
      skillId: canonicalKey,
      solutionId: existing.solutionId,
    });
    return existing;
  });
}

async function clearLink(localSkillName, deps = {}) {
  const canonicalKey = canonicalSkillName(localSkillName);
  if (!canonicalKey) return false;
  return withWriteLock(async () => {
    const state = await readState(deps);
    if (!state.links[canonicalKey]) return false;
    delete state.links[canonicalKey];
    await writeState(state, deps);
    logMarketplaceDiag("links", "skill:cleared", { skillId: canonicalKey });
    return true;
  });
}

// Bulk form of clearLink for removal sweeps: one read-modify-write for the
// whole batch instead of one serialized registry rewrite per skill.
async function clearLinks(localSkillNames, deps = {}) {
  const keys = (Array.isArray(localSkillNames) ? localSkillNames : [])
    .map((name) => canonicalSkillName(name))
    .filter(Boolean);
  if (!keys.length) return [];
  return withWriteLock(async () => {
    const state = await readState(deps);
    const cleared = [...new Set(keys)].filter((key) => state.links[key]);
    if (!cleared.length) return [];
    for (const key of cleared) delete state.links[key];
    await writeState(state, deps);
    logMarketplaceDiag("links", "skill:cleared-bulk", { skillIds: cleared });
    return cleared;
  });
}

// Unpublish flows only know the marketplace solution id — drop every local
// link that points at it so the "Published" badge cannot go stale.
async function clearLinksBySolutionId(solutionId, deps = {}) {
  const target = typeof solutionId === "string" ? solutionId.trim() : "";
  if (!target) return [];
  return withWriteLock(async () => {
    const state = await readState(deps);
    const cleared = Object.keys(state.links).filter(
      (key) => state.links[key]?.solutionId === target,
    );
    if (!cleared.length) return [];
    for (const key of cleared) delete state.links[key];
    await writeState(state, deps);
    logMarketplaceDiag("links", "skill:cleared-by-solution", {
      solutionId: target,
      skillIds: cleared,
    });
    return cleared;
  });
}

module.exports = {
  FILE_NAME,
  canonicalSkillName,
  clearLink,
  clearLinks,
  clearLinksBySolutionId,
  emptyState,
  getLink,
  getLinksFilePath,
  listLinks,
  markLinkDirty,
  normalizeState,
  readState,
  readStateStrict,
  setLink,
  validateStrictState,
  writeState,
};
