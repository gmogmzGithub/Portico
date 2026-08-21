// Local-only agent warning flags.
// State & Persistence layer. Sidecar JSON in userData; per-agent warning
// entries that surface problems the local client can SEE but must not FIX by
// writing someone else's artifact — today exactly one type:
//
//   SKILLS_NOT_FOUND — a read-only installed agent references skills that no
//   longer exist locally (removed by the destructive marketplace sync after
//   the source vanished upstream, or renamed upstream). The agent's owner
//   resolves it by republishing; this flag is the local breadcrumb until the
//   corrected copy syncs down.
//
// Shape (on disk):
//   {
//     "schemaVersion": 1,
//     "flags": {
//       "<agentId>": [
//         { "type": "SKILLS_NOT_FOUND", "skills": ["<reference>", ...],
//           "firstSeen": 1717512345000, "lastSeen": 1717512345000 }
//       ]
//     }
//   }
//
// Contract (recorded design decisions):
//   - DERIVED, RECOMPUTABLE state: set by the sync-removal executor and the
//     relink sweep; cleared by reconcileAgentFlags whenever the condition
//     stops holding (agent gone, reference gone, skill present again).
//   - NEVER published anywhere, and NEVER an input to stale/dirty/
//     unpublished-changes/freshness logic — display + support surfaces only.
//   - The type registry is extensible; unknown types round-trip untouched so
//     a downgrade never destroys a newer build's flags.

const crypto = require("node:crypto");
const fsPromises = require("node:fs/promises");
const path = require("node:path");
const { logMarketplaceDiag } = require("./marketplace-diagnostics");
const { createWriteLock } = require("./serial-write-lock");

const FILE_NAME = "agent-local-flags.json";
const SCHEMA_VERSION = 1;
const FLAG_SKILLS_NOT_FOUND = "SKILLS_NOT_FOUND";

function getFlagsFilePath({ userDataPath } = {}) {
  // Lazy-require electron so the store stays unit-testable in plain node
  // when an explicit userDataPath is supplied.
  const base = userDataPath || require("electron").app.getPath("userData");
  return path.join(base, FILE_NAME);
}

function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, flags: {} };
}

function normalizeFlagEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const type = typeof value.type === "string" ? value.type.trim() : "";
  if (!type) return null;
  const entry = {
    type,
    skills: Array.isArray(value.skills)
      ? [...new Set(value.skills.filter((id) => typeof id === "string" && id.trim()))]
      : [],
    firstSeen: typeof value.firstSeen === "number" ? value.firstSeen : null,
    lastSeen: typeof value.lastSeen === "number" ? value.lastSeen : null,
  };
  if (type === FLAG_SKILLS_NOT_FOUND && !entry.skills.length) return null;
  return entry;
}

function normalizeState(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return emptyState();
  }
  const flags =
    parsed.flags && typeof parsed.flags === "object" && !Array.isArray(parsed.flags)
      ? parsed.flags
      : {};
  const cleaned = {};
  for (const [agentId, entries] of Object.entries(flags)) {
    const id = typeof agentId === "string" ? agentId.trim() : "";
    if (!id || !Array.isArray(entries)) continue;
    const normalized = entries.map(normalizeFlagEntry).filter(Boolean);
    if (normalized.length) cleaned[id] = normalized;
  }
  return { schemaVersion: SCHEMA_VERSION, flags: cleaned };
}

async function readState(deps = {}) {
  const filePath = getFlagsFilePath(deps);
  try {
    const raw = await fsPromises.readFile(filePath, "utf8");
    return normalizeState(JSON.parse(raw));
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    // Corrupt sidecar degrades to empty — warnings are derived state and the
    // next sweep/sync recomputes them.
    console.warn(`[agent-local-flags] failed to read ${filePath}: ${error.message}`);
    return emptyState();
  }
}

// Serialize read-modify-write cycles (same discipline as the link registries:
// interleaved mutations corrupt the temp file or lose each other's updates).
const withWriteLock = createWriteLock();

async function writeState(state, deps = {}) {
  const filePath = getFlagsFilePath(deps);
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsPromises.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fsPromises.rename(tmp, filePath);
}

async function listFlags(deps = {}) {
  const state = await readState(deps);
  return state.flags;
}

async function getAgentFlags(agentId, deps = {}) {
  const id = typeof agentId === "string" ? agentId.trim() : "";
  if (!id) return [];
  const state = await readState(deps);
  return state.flags[id] || [];
}

// Record SKILLS_NOT_FOUND flags for a batch of agents. Merging is additive
// per agent: an existing flag unions the skill references and refreshes
// lastSeen; a new one stamps firstSeen.
async function setSkillsNotFoundFlags(entries, deps = {}) {
  const targets = (Array.isArray(entries) ? entries : [])
    .map((entry) => ({
      agentId: typeof entry?.agentId === "string" ? entry.agentId.trim() : "",
      skills: Array.isArray(entry?.skills)
        ? entry.skills.filter((id) => typeof id === "string" && id.trim())
        : [],
    }))
    .filter((entry) => entry.agentId && entry.skills.length);
  if (!targets.length) return listFlags(deps);

  return withWriteLock(async () => {
    const state = await readState(deps);
    const now = Date.now();
    for (const target of targets) {
      const agentFlags = state.flags[target.agentId] || [];
      const existing = agentFlags.find((flag) => flag.type === FLAG_SKILLS_NOT_FOUND);
      if (existing) {
        existing.skills = [...new Set([...existing.skills, ...target.skills])];
        existing.lastSeen = now;
      } else {
        agentFlags.push({
          type: FLAG_SKILLS_NOT_FOUND,
          skills: [...new Set(target.skills)],
          firstSeen: now,
          lastSeen: now,
        });
      }
      state.flags[target.agentId] = agentFlags;
      logMarketplaceDiag("flags", "skills-not-found:set", {
        agentId: target.agentId,
        skillCount: target.skills.length,
      });
    }
    await writeState(state, deps);
    return state.flags;
  });
}

// Recompute SKILLS_NOT_FOUND flags against live truth: drop flags for agents
// that no longer exist, references the agent no longer carries, and skills
// that are present locally again. `agents` is [{id, skillIds:[]}];
// `skillLeafExists(leaf) -> boolean` answers from the local skill catalog.
async function reconcileSkillsNotFoundFlags({ agents, skillLeafExists }, deps = {}) {
  if (!Array.isArray(agents) || typeof skillLeafExists !== "function") {
    return listFlags(deps);
  }
  const leafOf = (value) =>
    String(value || "")
      .trim()
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean)
      .at(-1) || "";
  const agentsById = new Map(
    agents
      .filter((agent) => typeof agent?.id === "string" && agent.id.trim())
      .map((agent) => [
        agent.id.trim(),
        new Set(
          (Array.isArray(agent.skillIds) ? agent.skillIds : [])
            .map(leafOf)
            .filter(Boolean),
        ),
      ]),
  );

  return withWriteLock(async () => {
    const state = await readState(deps);
    let changed = false;
    for (const [agentId, flags] of Object.entries(state.flags)) {
      const referencedLeaves = agentsById.get(agentId);
      const nextFlags = [];
      for (const flag of flags) {
        if (flag.type !== FLAG_SKILLS_NOT_FOUND) {
          nextFlags.push(flag); // unknown/other types are not ours to prune
          continue;
        }
        if (!referencedLeaves) {
          changed = true; // agent gone → flag gone
          continue;
        }
        const stillBroken = flag.skills.filter((id) => {
          const leaf = leafOf(id);
          return leaf && referencedLeaves.has(leaf) && !skillLeafExists(leaf);
        });
        if (stillBroken.length === flag.skills.length) {
          nextFlags.push(flag);
        } else if (stillBroken.length) {
          nextFlags.push({ ...flag, skills: stillBroken });
          changed = true;
        } else {
          changed = true; // fully resolved
        }
      }
      if (nextFlags.length) {
        state.flags[agentId] = nextFlags;
      } else {
        delete state.flags[agentId];
      }
    }
    if (changed) {
      await writeState(state, deps);
      logMarketplaceDiag("flags", "reconciled", {
        agentCount: Object.keys(state.flags).length,
      });
    }
    return state.flags;
  });
}

async function clearAgentFlags(agentId, deps = {}) {
  const id = typeof agentId === "string" ? agentId.trim() : "";
  if (!id) return listFlags(deps);
  return withWriteLock(async () => {
    const state = await readState(deps);
    if (state.flags[id]) {
      delete state.flags[id];
      await writeState(state, deps);
    }
    return state.flags;
  });
}

module.exports = {
  FLAG_SKILLS_NOT_FOUND,
  listFlags,
  getAgentFlags,
  setSkillsNotFoundFlags,
  reconcileSkillsNotFoundFlags,
  clearAgentFlags,
};
