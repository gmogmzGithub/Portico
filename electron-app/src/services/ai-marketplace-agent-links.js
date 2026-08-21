// AI Marketplace ↔ local agent link registry.
// State & Persistence layer. Sidecar JSON in userData; one entry per local agent
// that has a published or installed marketplace relationship.
//
// Shape (on disk):
//   {
//     "schemaVersion": 2,
//     "links": {
//       "<local_agent_id>": {
//         "solutionId": "<uuid>",
//         "relationship": "published" | "installed" | "unknown",
//         "authorIdentity": "<publisher identity>" | null,
//         "attributionPending": false,
//         "publishedAt": 1717512345000,
//         "lastUpdatedAt": 1717512345000,
//         "hasLocalChanges": false,
//         "remoteUpdatedAt": "2026-07-28T01:46:35Z" | 1717512345000 | null
//       }
//     }
//   }
//
// hasLocalChanges is an event-driven "unpublished changes" marker: set by
// markLinkDirty when the local agent is edited without syncing, cleared by
// relationship setters (whose callers are publish/install success — both mean
// the local copy matches the marketplace). Links written before this field
// existed normalize to false, i.e. legacy agents are assumed clean until
// their next local save.
//
// remoteUpdatedAt is the listing's updated_at as last observed (install time
// or the session freshness check) — the update-available baseline. Preserved
// verbatim (string or epoch) so comparisons use the marketplace's own clock,
// never the local one. Legacy links normalize to null and get backfilled
// without flagging.

const { app } = require("electron");
const { logMarketplaceDiag } = require("./marketplace-diagnostics");
const crypto = require("node:crypto");
const fsPromises = require("node:fs/promises");
const path = require("node:path");
const { createWriteLock } = require("./serial-write-lock");

const FILE_NAME = "ai-marketplace-agent-links.json";
const SCHEMA_VERSION = 2;
const RELATIONSHIPS = new Set(["published", "installed", "unknown"]);

function getLinksFilePath({ userDataPath } = {}) {
  const base = userDataPath || app.getPath("userData");
  return path.join(base, FILE_NAME);
}

function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, links: {} };
}

function normalizeRelationship(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return RELATIONSHIPS.has(normalized) ? normalized : "unknown";
}

function normalizeAuthorIdentity(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function normalizeRemoteUpdatedAt(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
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
    if (typeof key !== "string" || !key.trim()) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const solutionId =
      typeof value.solutionId === "string" ? value.solutionId.trim() : "";
    if (!solutionId) continue;
    cleaned[key] = {
      solutionId,
      relationship: normalizeRelationship(value.relationship),
      authorIdentity: normalizeAuthorIdentity(value.authorIdentity),
      attributionPending: value.attributionPending === true,
      publishedAt:
        typeof value.publishedAt === "number" ? value.publishedAt : null,
      lastUpdatedAt:
        typeof value.lastUpdatedAt === "number"
          ? value.lastUpdatedAt
          : value.publishedAt || null,
      hasLocalChanges: value.hasLocalChanges === true,
      remoteUpdatedAt: normalizeRemoteUpdatedAt(value.remoteUpdatedAt),
      // Persisted freshness verdict from the last agent update-check sweep:
      // the linked listing's updated_at moved past the stored baseline.
      // Cleared whenever the local copy re-syncs (setLink / a refresh that
      // advances remoteUpdatedAt).
      hasRemoteUpdate: value.hasRemoteUpdate === true,
      // Soft-miss flags (2026-08-08 incident: an access flap made the agent
      // inventory omit two read-only installed agents for one read, and the
      // prune hard-deleted their links). A missing sighting FLAGS the link;
      // only a confirmed absence across spaced sightings deletes it, and a
      // reappearance heals the flag. Absent on healthy links.
      missingSince:
        typeof value.missingSince === "string" && value.missingSince
          ? value.missingSince
          : null,
      lastMissAt:
        typeof value.lastMissAt === "string" && value.lastMissAt
          ? value.lastMissAt
          : null,
      missCount: Number.isInteger(value.missCount) && value.missCount > 0 ? value.missCount : 0,
    };
  }
  return { schemaVersion: SCHEMA_VERSION, links: cleaned };
}

function validateStrictState(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Agent-link registry must be a JSON object");
  }
  if (
    parsed.schemaVersion !== undefined &&
    parsed.schemaVersion !== SCHEMA_VERSION
  ) {
    throw new TypeError(
      `Unsupported agent-link registry schemaVersion: ${parsed.schemaVersion}`,
    );
  }
  if (!parsed.links || typeof parsed.links !== "object" || Array.isArray(parsed.links)) {
    throw new TypeError("Agent-link registry must contain a links object");
  }
  for (const [agentId, value] of Object.entries(parsed.links)) {
    if (!agentId.trim() || !value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("Agent-link registry contains an invalid link record");
    }
    if (typeof value.solutionId !== "string" || !value.solutionId.trim()) {
      throw new TypeError(`Agent-link registry record ${agentId} is missing solutionId`);
    }
    if (
      value.relationship !== undefined &&
      !RELATIONSHIPS.has(String(value.relationship).trim().toLowerCase())
    ) {
      throw new TypeError(
        `Agent-link registry record ${agentId} has an invalid relationship`,
      );
    }
    if (
      value.authorIdentity !== undefined &&
      value.authorIdentity !== null &&
      typeof value.authorIdentity !== "string"
    ) {
      throw new TypeError(
        `Agent-link registry record ${agentId} has an invalid authorIdentity`,
      );
    }
    if (
      value.attributionPending !== undefined &&
      typeof value.attributionPending !== "boolean"
    ) {
      throw new TypeError(
        `Agent-link registry record ${agentId} has an invalid attributionPending flag`,
      );
    }
    for (const missField of ["missingSince", "lastMissAt"]) {
      if (
        value[missField] !== undefined &&
        value[missField] !== null &&
        typeof value[missField] !== "string"
      ) {
        throw new TypeError(
          `Agent-link registry record ${agentId} has an invalid ${missField}`,
        );
      }
    }
    if (
      value.missCount !== undefined &&
      !(Number.isInteger(value.missCount) && value.missCount >= 0)
    ) {
      throw new TypeError(
        `Agent-link registry record ${agentId} has an invalid missCount`,
      );
    }
    const relationship = normalizeRelationship(value.relationship);
    if (
      relationship !== "unknown" &&
      !normalizeAuthorIdentity(value.authorIdentity)
    ) {
      throw new TypeError(
        `Agent-link registry record ${agentId} is missing authorIdentity`,
      );
    }
    if (value.attributionPending === true && relationship !== "installed") {
      throw new TypeError(
        `Agent-link registry record ${agentId} has pending attribution outside an install`,
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
      throw new TypeError("Agent-link registry must be a regular file");
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
    return await readStateStrict(deps);
  } catch (error) {
    console.warn(
      `[ai-marketplace-agent-links] failed to read ${filePath}: ${error.message}`,
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

// Rolling history for the registry (2026-08-14 Smart Slides incident: a
// wrongly-deleted link was only recoverable because an unrelated OWUI repair
// backup happened to exist). Every overwrite keeps the previous content as
// .bak, plus one dated snapshot per day, pruned to the newest
// SNAPSHOT_RETAIN_COUNT. Piggybacked on writes — no timers.
const SNAPSHOT_RETAIN_COUNT = 7;

async function keepRegistryHistory(filePath) {
  let previous;
  try {
    previous = await fsPromises.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  await fsPromises.writeFile(`${filePath}.bak`, previous, "utf8");
  const day = new Date().toISOString().slice(0, 10);
  const snapshotPath = `${filePath}.${day}.json`;
  try {
    await fsPromises.access(snapshotPath);
  } catch {
    await fsPromises.writeFile(snapshotPath, previous, "utf8");
    const dir = path.dirname(filePath);
    const base = `${path.basename(filePath)}.`;
    const snapshots = (await fsPromises.readdir(dir))
      .filter((name) => name.startsWith(base) && /\.\d{4}-\d{2}-\d{2}\.json$/.test(name))
      .sort();
    for (const stale of snapshots.slice(0, Math.max(0, snapshots.length - SNAPSHOT_RETAIN_COUNT))) {
      await fsPromises.rm(path.join(dir, stale), { force: true });
    }
  }
}

async function writeState(state, deps = {}) {
  const filePath = getLinksFilePath(deps);
  const dir = path.dirname(filePath);
  await fsPromises.mkdir(dir, { recursive: true });
  try {
    await keepRegistryHistory(filePath);
  } catch (error) {
    // History is best-effort; the write itself must never be blocked by it.
    console.warn(
      `[ai-marketplace-agent-links] registry history skipped: ${error.message}`,
    );
  }
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

async function getLink(localAgentId, deps = {}) {
  if (typeof localAgentId !== "string" || !localAgentId.trim()) return null;
  const state = await readState(deps);
  return state.links[localAgentId] || null;
}

async function setLink(localAgentId, solutionId, deps = {}) {
  if (typeof localAgentId !== "string" || !localAgentId.trim()) {
    throw new Error("setLink: localAgentId is required");
  }
  if (typeof solutionId !== "string" || !solutionId.trim()) {
    throw new Error("setLink: solutionId is required");
  }
  return withWriteLock(async () => {
    const state = await readStateStrict(deps);
    const now = Date.now();
    const existing = state.links[localAgentId];
    state.links[localAgentId] = {
      solutionId: solutionId.trim(),
      relationship: existing?.relationship || "unknown",
      authorIdentity: existing?.authorIdentity || null,
      attributionPending: existing?.attributionPending === true,
      publishedAt: existing?.publishedAt || now,
      lastUpdatedAt: now,
      // Publish/install success means local == marketplace.
      hasLocalChanges: false,
      remoteUpdatedAt: normalizeRemoteUpdatedAt(existing?.remoteUpdatedAt),
      hasRemoteUpdate: false,
    };
    await writeState(state, deps);
    logMarketplaceDiag("links", "agent:set", {
      agentId: localAgentId,
      solutionId: solutionId.trim(),
      relationship: state.links[localAgentId].relationship,
    });
    return state.links[localAgentId];
  });
}

async function setPublishedLink(localAgentId, solutionId, authorIdentity, deps = {}) {
  const link = await setRelationshipLink(
    localAgentId,
    solutionId,
    "published",
    authorIdentity,
    false,
    deps,
  );
  return link;
}

async function setInstalledLink(
  localAgentId,
  solutionId,
  authorIdentity,
  { attributionPending = false, ...deps } = {},
) {
  return await setRelationshipLink(
    localAgentId,
    solutionId,
    "installed",
    authorIdentity,
    attributionPending === true,
    deps,
  );
}

async function setRelationshipLink(
  localAgentId,
  solutionId,
  relationship,
  authorIdentity,
  attributionPending,
  deps = {},
) {
  if (typeof localAgentId !== "string" || !localAgentId.trim()) {
    throw new Error("setRelationshipLink: localAgentId is required");
  }
  if (typeof solutionId !== "string" || !solutionId.trim()) {
    throw new Error("setRelationshipLink: solutionId is required");
  }
  const normalizedAuthor = normalizeAuthorIdentity(authorIdentity);
  if (!normalizedAuthor) {
    throw new Error("setRelationshipLink: authorIdentity is required");
  }
  return withWriteLock(async () => {
    const state = await readStateStrict(deps);
    const now = Date.now();
    const existing = state.links[localAgentId];
    state.links[localAgentId] = {
      solutionId: solutionId.trim(),
      relationship: normalizeRelationship(relationship),
      authorIdentity:
        relationship === "installed" &&
        existing?.relationship === "installed" &&
        existing?.authorIdentity
          ? existing.authorIdentity
          : normalizedAuthor,
      attributionPending: attributionPending === true,
      publishedAt: existing?.publishedAt || now,
      lastUpdatedAt: now,
      hasLocalChanges: false,
      remoteUpdatedAt: normalizeRemoteUpdatedAt(existing?.remoteUpdatedAt),
    };
    await writeState(state, deps);
    logMarketplaceDiag("links", "agent:set-relationship", {
      agentId: localAgentId,
      solutionId: solutionId.trim(),
      relationship: state.links[localAgentId].relationship,
      attributionPending: attributionPending === true,
      previousRelationship: existing?.relationship || null,
    });
    return state.links[localAgentId];
  });
}

// Record the listing's updated_at as last observed (install success or the
// session freshness check). Deliberately does NOT touch lastUpdatedAt or the
// dirty flag: this is an observation about the REMOTE copy, not a local
// mutation. No-ops for unlinked agents.
async function setLinkRemoteUpdatedAt(localAgentId, remoteUpdatedAt, deps = {}) {
  if (typeof localAgentId !== "string" || !localAgentId.trim()) return null;
  return withWriteLock(async () => {
    const state = await readStateStrict(deps);
    const existing = state.links[localAgentId];
    if (!existing) return null;
    const normalized = normalizeRemoteUpdatedAt(remoteUpdatedAt);
    if (existing.remoteUpdatedAt === normalized) return existing;
    existing.remoteUpdatedAt = normalized;
    existing.hasRemoteUpdate = false;
    await writeState(state, deps);
    logMarketplaceDiag("links", "agent:remote-updated-at", {
      agentId: localAgentId,
      remoteUpdatedAt: normalized === null ? null : String(normalized),
    });
    return existing;
  });
}

// Persist the update-check verdict for an installed link. No-op (null) for
// unlinked agents; writes only on an actual verdict change.
async function markRemoteUpdate(localAgentId, hasRemoteUpdate, deps = {}) {
  if (typeof localAgentId !== "string" || !localAgentId.trim()) return null;
  return withWriteLock(async () => {
    const state = await readStateStrict(deps);
    const existing = state.links[localAgentId];
    if (!existing) return null;
    const next = hasRemoteUpdate === true;
    if (existing.hasRemoteUpdate === next) return existing;
    existing.hasRemoteUpdate = next;
    await writeState(state, deps);
    logMarketplaceDiag("links", "agent:remote-update-flag", {
      agentId: localAgentId,
      hasRemoteUpdate: next,
    });
    return existing;
  });
}

async function finalizeAttribution(localAgentId, deps = {}) {
  if (typeof localAgentId !== "string" || !localAgentId.trim()) return null;
  return withWriteLock(async () => {
    const state = await readStateStrict(deps);
    const existing = state.links[localAgentId];
    if (!existing) return null;
    if (existing.attributionPending !== true) return existing;
    existing.attributionPending = false;
    existing.lastUpdatedAt = Date.now();
    await writeState(state, deps);
    logMarketplaceDiag("links", "agent:attribution-finalized", {
      agentId: localAgentId,
      solutionId: existing.solutionId,
    });
    return existing;
  });
}

async function clearLinksBySolutionId(solutionId, deps = {}) {
  return await clearLinksBySolutionIdAndRelationship(solutionId, null, deps);
}

async function clearPublishedLinksBySolutionId(solutionId, deps = {}) {
  return await clearLinksBySolutionIdAndRelationship(solutionId, "published", deps);
}

async function clearLinksBySolutionIdAndRelationship(
  solutionId,
  relationship,
  deps = {},
) {
  const normalized = typeof solutionId === "string" ? solutionId.trim() : "";
  if (!normalized) return [];
  return withWriteLock(async () => {
    const state = await readStateStrict(deps);
    const removed = [];
    for (const [agentId, link] of Object.entries(state.links)) {
      if (link.solutionId !== normalized) continue;
      if (relationship && link.relationship !== relationship) continue;
      delete state.links[agentId];
      removed.push(agentId);
    }
    if (removed.length) {
      await writeState(state, deps);
      logMarketplaceDiag("links", "agent:cleared-by-solution", {
        solutionId: normalized,
        relationship: relationship || "any",
        agentIds: removed.slice().sort(),
      });
    }
    return removed.sort();
  });
}

// ---------------------------------------------------------------------------
// Sightings: soft-miss pruning policy (flag -> confirm -> delete, heal on
// reappearance). The renderer reports which linked agents the inventory did
// and did not contain; ALL policy and persistence live here so the
// confirmation window survives app restarts and the rules are unit-testable.
// A stale link is harmless; a deleted one blinds the update sweep and erases
// provenance — so deletion requires MISSING_CONFIRM_COUNT spaced sightings.
// ---------------------------------------------------------------------------
const MISSING_CONFIRM_COUNT = 2;
const MISSING_CONFIRM_SPACING_MS = 6 * 60 * 60 * 1000; // two flap windows apart

async function applyLinkSightings({ presentIds = [], absentIds = [] } = {}, deps = {}) {
  const now = typeof deps.nowMs === "number" ? deps.nowMs : Date.now();
  const present = new Set(
    (Array.isArray(presentIds) ? presentIds : []).filter(
      (id) => typeof id === "string" && id.trim(),
    ),
  );
  const absent = new Set(
    (Array.isArray(absentIds) ? absentIds : []).filter(
      (id) => typeof id === "string" && id.trim(),
    ),
  );
  return withWriteLock(async () => {
    const state = await readStateStrict(deps);
    const healed = [];
    const flagged = [];
    const deleted = [];
    // Fail-safe twin of the renderer's empty-list guard: a report where every
    // linked agent is absent and none are present smells like a broken read,
    // not a user deleting everything at once.
    if (absent.size && !present.size) {
      return { healed, flagged, deleted, skipped: true };
    }
    let changed = false;
    for (const [agentId, link] of Object.entries(state.links)) {
      if (present.has(agentId)) {
        if (link.missingSince || link.lastMissAt || link.missCount) {
          link.missingSince = null;
          link.lastMissAt = null;
          link.missCount = 0;
          healed.push(agentId);
          changed = true;
        }
        continue;
      }
      if (!absent.has(agentId)) continue;
      if (!link.missingSince) {
        link.missingSince = new Date(now).toISOString();
        link.lastMissAt = link.missingSince;
        link.missCount = 1;
        flagged.push(agentId);
        changed = true;
        continue;
      }
      const lastMissMs = Date.parse(link.lastMissAt || link.missingSince);
      if (!Number.isFinite(lastMissMs) || now - lastMissMs < MISSING_CONFIRM_SPACING_MS) {
        // Repeat miss inside the same flap window: no write amplification.
        continue;
      }
      link.missCount = (link.missCount || 1) + 1;
      link.lastMissAt = new Date(now).toISOString();
      changed = true;
      if (link.missCount >= MISSING_CONFIRM_COUNT) {
        delete state.links[agentId];
        deleted.push(agentId);
      } else {
        flagged.push(agentId);
      }
    }
    if (changed) {
      await writeState(state, deps);
      if (healed.length) {
        logMarketplaceDiag("links", "agent:missing-healed", { agentIds: healed.sort() });
      }
      if (flagged.length) {
        logMarketplaceDiag("links", "agent:missing-flagged", { agentIds: flagged.sort() });
      }
      if (deleted.length) {
        logMarketplaceDiag("links", "agent:cleared", {
          agentIds: deleted.sort(),
          reason: "confirmed-missing",
        });
      }
    }
    return { healed: healed.sort(), flagged: flagged.sort(), deleted: deleted.sort() };
  });
}

// Mark a linked agent as locally edited since its last publish. No-op (null)
// when the agent has no marketplace link.
async function markLinkDirty(localAgentId, deps = {}) {
  if (typeof localAgentId !== "string" || !localAgentId.trim()) return null;
  return withWriteLock(async () => {
    const state = await readStateStrict(deps);
    const existing = state.links[localAgentId];
    if (!existing) return null;
    if (existing.hasLocalChanges === true) return existing;
    existing.hasLocalChanges = true;
    await writeState(state, deps);
    logMarketplaceDiag("links", "agent:marked-dirty", {
      agentId: localAgentId,
      solutionId: existing.solutionId,
    });
    return existing;
  });
}

async function clearLink(localAgentId, deps = {}) {
  if (typeof localAgentId !== "string" || !localAgentId.trim()) return false;
  return withWriteLock(async () => {
    const state = await readStateStrict(deps);
    if (!state.links[localAgentId]) return false;
    delete state.links[localAgentId];
    await writeState(state, deps);
    logMarketplaceDiag("links", "agent:cleared", { agentId: localAgentId });
    return true;
  });
}

module.exports = {
  FILE_NAME,
  SCHEMA_VERSION,
  MISSING_CONFIRM_COUNT,
  MISSING_CONFIRM_SPACING_MS,
  applyLinkSightings,
  clearLink,
  clearLinksBySolutionId,
  clearPublishedLinksBySolutionId,
  emptyState,
  finalizeAttribution,
  getLink,
  getLinksFilePath,
  listLinks,
  markLinkDirty,
  normalizeAuthorIdentity,
  normalizeRelationship,
  normalizeState,
  validateStrictState,
  readState,
  readStateStrict,
  setLink,
  setInstalledLink,
  setPublishedLink,
  setLinkRemoteUpdatedAt,
  markRemoteUpdate,
  writeState,
};
