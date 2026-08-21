// Agent skill-reference relink sweep for bundle-declared seed migrations.
//
// When the OOTB bundle declares a seed migration whose LEAF id changed (a
// skill rename — plugin-folder moves keep the leaf and never break agent
// references, because every resolver in this system is leaf-canonical), the
// records and payload dirs migrate at config load, but agents still carry the
// old reference strings in subagent_skill_ids. This sweep rewrites those
// references — for EDITABLE agents only. Read-only installed agent copies are
// NEVER written (ownership boundary: their publisher republishes the fix);
// they get a local SKILLS_NOT_FOUND flag instead.
//
// STATELESS + IDEMPOTENT: needs are recomputed from live agent data against
// the bundle's alias map on every run; a second run over healed agents
// no-ops. No timers — callers piggyback it on existing cycles (the start of
// destructive sync flows, one opportunistic post-startup run).
//
// Same load-light discipline as agent-skill-usage-guard: no top-level
// requires of heavy/Electron-bound modules; every collaborator is injectable
// with lazy-required defaults.

function defaultLoadMigrations(projectRoot) {
  return require("./marketplace-ootb").loadOotbSeedMigrations(projectRoot);
}

function defaultAgentTools() {
  const { buildSyncAgentTools } = require("./marketplace-sync-agent-tools");
  return buildSyncAgentTools();
}

function defaultAgentFlags() {
  return require("./agent-local-flags");
}

async function defaultLoadInstalledSkills(projectRoot) {
  // The raw live registry is enough here: the sweep only needs current leaf
  // ownership, and every config-load path has already applied migrations by
  // the time anything can invoke a sweep.
  const fsPromises = require("node:fs/promises");
  const path = require("node:path");
  try {
    const raw = await fsPromises.readFile(
      path.join(projectRoot, "marketplaces.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.installedSkills) ? parsed.installedSkills : [];
  } catch {
    return [];
  }
}

function leafOf(value) {
  return (
    String(value || "")
      .trim()
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean)
      .at(-1) || ""
  );
}

function identitySegments(endpoint) {
  return [endpoint?.marketplaceId, endpoint?.pluginName, endpoint?.skillId].filter(
    Boolean,
  );
}

// Reference-form match against a migration's FROM identity. The three agent
// reference shapes are: bare leaf, "mp/skill", "mp/plugin/skill".
function referenceMatchesFrom(reference, from) {
  const parts = String(reference || "")
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
  if (parts.length === 1) {
    return parts[0] === from.skillId;
  }
  if (parts.length === 2) {
    return parts[0] === from.marketplaceId && parts[1] === from.skillId;
  }
  if (parts.length === 3) {
    return (
      parts[0] === from.marketplaceId &&
      Boolean(from.pluginName) &&
      parts[1] === from.pluginName &&
      parts[2] === from.skillId
    );
  }
  return false;
}

// Rewrite preserving the reference's shape.
function rewriteReference(reference, to) {
  const parts = String(reference || "")
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
  if (parts.length === 1) {
    return to.skillId;
  }
  if (parts.length === 2) {
    return `${to.marketplaceId}/${to.skillId}`;
  }
  return identitySegments(to).join("/");
}

async function runAgentSkillRelinkSweep({
  projectRoot,
  migrations = null,
  agentTools = null,
  agentFlags = null,
  loadInstalledSkills = defaultLoadInstalledSkills,
  logger = console,
} = {}) {
  const summary = {
    agentsUpdated: [],
    agentsFlagged: [],
    refsRewritten: 0,
    skipped: [],
    flagsReconciled: false,
  };

  let aliasList = migrations;
  if (!Array.isArray(aliasList)) {
    aliasList = await defaultLoadMigrations(projectRoot);
  }
  // Only leaf renames can break references (leaf-canonical resolution);
  // plugin-only moves are inert here.
  const leafRenames = aliasList.filter(
    (entry) => entry?.from?.skillId && entry?.to?.skillId && entry.from.skillId !== entry.to.skillId,
  );

  const tools = agentTools || defaultAgentTools();
  let agents;
  try {
    agents = await tools.listAgents();
  } catch (error) {
    // No inventory → nothing to do this cycle; the next piggybacked run
    // retries. Never an error path — the sweep is opportunistic repair.
    logger.warn?.(
      `[AgentRelink] Sweep skipped — agent inventory unavailable: ${error?.message || error}`,
    );
    return summary;
  }
  if (!Array.isArray(agents)) {
    return summary;
  }

  const installedSkills = await loadInstalledSkills(projectRoot);
  const currentLeaves = new Set(
    installedSkills
      .map((record) => leafOf(record?.skillId))
      .filter(Boolean),
  );

  // A rename is applicable when the OLD leaf no longer names any installed
  // skill (another skill still owning it means a bare-leaf reference resolves
  // there today — rewriting would hijack it) and the NEW leaf exists locally.
  const applicableRenames = [];
  for (const entry of leafRenames) {
    if (currentLeaves.has(entry.from.skillId)) {
      summary.skipped.push({
        from: entry.from.skillId,
        to: entry.to.skillId,
        reason: "old_leaf_still_installed",
      });
      continue;
    }
    if (!currentLeaves.has(entry.to.skillId)) {
      summary.skipped.push({
        from: entry.from.skillId,
        to: entry.to.skillId,
        reason: "target_leaf_missing",
      });
      continue;
    }
    applicableRenames.push(entry);
  }

  const flagEntries = [];
  for (const agent of agents) {
    const skillIds = Array.isArray(agent?.skillIds) ? agent.skillIds : [];
    if (!skillIds.length) continue;

    const rewrites = new Map(); // old reference -> new reference
    for (const reference of skillIds) {
      for (const entry of applicableRenames) {
        if (referenceMatchesFrom(reference, entry.from)) {
          rewrites.set(reference, rewriteReference(reference, entry.to));
          break;
        }
      }
    }
    if (!rewrites.size) continue;

    const readOnly = agent?.readOnly === true || agent?.relationship === "installed";
    if (readOnly) {
      flagEntries.push({
        agentId: agent.id,
        agentName: agent.name || agent.id,
        skills: [...rewrites.keys()],
      });
      continue;
    }

    const nextIds = [];
    const seen = new Set();
    for (const reference of skillIds) {
      const next = rewrites.get(reference) ?? reference;
      if (seen.has(next)) continue; // agent already carried the new form
      seen.add(next);
      nextIds.push(next);
    }
    try {
      await tools.updateAgentSkillIds(agent.id, nextIds);
      summary.agentsUpdated.push({
        id: agent.id,
        name: agent.name || agent.id,
        rewritten: [...rewrites.entries()].map(([from, to]) => ({ from, to })),
      });
      summary.refsRewritten += rewrites.size;
    } catch (error) {
      summary.skipped.push({
        agentId: agent.id,
        reason: "agent_update_failed",
        error: error?.message || String(error),
      });
    }
  }

  const flags = agentFlags || defaultAgentFlags();
  if (flagEntries.length) {
    try {
      await flags.setSkillsNotFoundFlags(flagEntries);
      summary.agentsFlagged = flagEntries.map(({ agentId, agentName }) => ({
        id: agentId,
        name: agentName,
      }));
    } catch (error) {
      logger.warn?.(
        `[AgentRelink] Could not record SKILLS_NOT_FOUND flags: ${error?.message || error}`,
      );
    }
  }

  // Reconcile pass: clears flags whose condition stopped holding (agent
  // corrected upstream and re-synced, reference dropped, skill present
  // again). Runs even with an empty alias map — that is what retires stale
  // flags after an owner republishes.
  try {
    await flags.reconcileSkillsNotFoundFlags({
      agents: agents.map((agent) => ({ id: agent.id, skillIds: agent.skillIds })),
      skillLeafExists: (leaf) => currentLeaves.has(leaf),
    });
    summary.flagsReconciled = true;
  } catch (error) {
    logger.warn?.(
      `[AgentRelink] Flag reconcile failed: ${error?.message || error}`,
    );
  }

  if (summary.agentsUpdated.length || summary.agentsFlagged.length) {
    logger.log?.(
      `[AgentRelink] Sweep rewrote ${summary.refsRewritten} reference(s) across ${summary.agentsUpdated.length} agent(s); flagged ${summary.agentsFlagged.length} read-only agent(s)`,
    );
  }
  return summary;
}

module.exports = {
  runAgentSkillRelinkSweep,
};
