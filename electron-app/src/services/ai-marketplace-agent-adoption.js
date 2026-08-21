// Self-heal for LOST agent->marketplace links (State & Persistence layer).
//
// An installed marketplace agent whose sidecar link is gone (2026-08-08: an
// access flap made the deleted-agent prune hard-delete two links) has no
// INSTALLED badge and is invisible to the update sweep. The rust
// reconcile_agent_attribution heals OWUI meta FROM links — it cannot
// resurrect a lost link — so this module re-derives the link itself.
//
// Deliberately narrow: a candidate is a READ-ONLY agent owned by someone
// else with no link record, and it adopts ONLY when exactly one live agent
// listing matches on BOTH display name and author. A false relink is worse
// than staying unlinked, so ambiguity always skips (and logs why).
//
// Load-light discipline (agent-skill-usage-guard pattern): no top-level
// requires of Electron-bound modules; defaults lazy-require at call time,
// unit fixtures inject their own.

const MARKETPLACE_AGENTS_SOLUTION_TYPE = "portico-agents";
const SEARCH_PAGE_SIZE = 100;
const SEARCH_MAX_PAGES = 20;

function defaultListAgents() {
  return require("./marketplace-sync-agent-tools").listAgentsWithSkillIds();
}

function defaultSearchSolutions(params) {
  return require("./ai-marketplace-operations").search(params, {
    timeoutMs: 12_000,
  });
}

function defaultLinkStore() {
  return require("./ai-marketplace-agent-links");
}

function defaultReconcile() {
  return require("./agent-attribution-reconciliation").reconcileAgentAttribution();
}

async function defaultResolveViewerEmail() {
  const userResult = await require("./current-user").get();
  return userResult?.sessionSummary?.user?.email || "";
}

// Agents carry bare ldap ("zstevens") while listings carry full emails
// ("zstevens@example.invalid") — identity comparison is on the local-part.
function emailLocalPart(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  return raw.split("@")[0];
}

function normalizeListingName(value) {
  return String(value || "").trim().toLowerCase();
}

function listingAuthor(listing) {
  return (
    listing?.author ||
    listing?.submitted_by ||
    listing?.submittedBy ||
    listing?.created_by_email ||
    ""
  );
}

function listingIsDeleted(listing) {
  const status = String(
    listing?.status || listing?.publication_state || "",
  ).toLowerCase();
  return status === "deleted" || status === "unpublished";
}

// Full agent-listing sweep, same dual solutions/results envelope handling as
// agent-skill-usage-guard. Throws on unknown shapes — a silent [] here would
// read as "no listings" and skip every adoption forever.
async function fetchAgentListings(searchSolutions) {
  const listings = [];
  for (let page = 1; ; page += 1) {
    if (page > SEARCH_MAX_PAGES) {
      throw new Error(
        `more than ${SEARCH_MAX_PAGES * SEARCH_PAGE_SIZE} published agent listings`,
      );
    }
    const res = await searchSolutions({
      query: "",
      filters: { type: [MARKETPLACE_AGENTS_SOLUTION_TYPE] },
      page,
      pageSize: SEARCH_PAGE_SIZE,
    });
    const envelope =
      res?.data && typeof res.data === "object" && !Array.isArray(res.data)
        ? res.data
        : res;
    const results = Array.isArray(envelope?.solutions)
      ? envelope.solutions
      : Array.isArray(envelope?.results)
        ? envelope.results
        : null;
    if (!results) {
      throw new Error("unrecognized search response shape (no solutions/results)");
    }
    listings.push(...results);
    if (results.length < SEARCH_PAGE_SIZE) break;
  }
  return listings;
}

// Last-resort recovery source: the OWUI repair flow keeps COLD database
// backups (webui.db.backup.*) whose model rows may still carry
// subagent_marketplace_solution_id for agents whose live meta was scrubbed
// (pre-2026-08-14 reconcile behavior). Reading a cold copy is outside the
// live-webui.db host-access rule; the query runs in-container. Best-effort:
// any failure returns {} and the sweep moves on.
async function defaultReadBackupSolutionIds(modelIds) {
  if (!Array.isArray(modelIds) || !modelIds.length) return {};
  const { execFile } = require("node:child_process");
  const { promisify } = require("node:util");
  const script = [
    "import glob, json, sqlite3, sys",
    "ids = [a for a in sys.argv[1:] if a]",
    "dirs = sorted(glob.glob('/app/backend/data/repair-backups/*'))",
    "out = {}",
    "if dirs and ids:",
    "    files = sorted(glob.glob(dirs[-1] + '/webui.db.backup.*')) or sorted(glob.glob(dirs[-1] + '/webui.db.pre-repair-live.*'))",
    "    if files:",
    "        con = sqlite3.connect('file:' + files[-1] + '?mode=ro', uri=True)",
    "        marks = ','.join('?' for _ in ids)",
    "        for mid, meta in con.execute('SELECT id, meta FROM model WHERE id IN (%s)' % marks, ids):",
    "            try:",
    "                sid = (json.loads(meta or '{}') or {}).get('subagent_marketplace_solution_id')",
    "            except Exception:",
    "                sid = None",
    "            if isinstance(sid, str) and sid.strip():",
    "                out[mid] = sid.strip()",
    "print(json.dumps(out))",
  ].join("\n");
  const { stdout } = await promisify(execFile)(
    "docker",
    ["exec", "portico-open-webui", "python3", "-c", script, ...modelIds],
    { timeout: 10_000 },
  );
  const parsed = JSON.parse(String(stdout || "{}").trim() || "{}");
  return parsed && typeof parsed === "object" ? parsed : {};
}

// One pass over link-less foreign-owned read-only agents, three arms in
// order of trustworthiness:
//   1. meta-first — OWUI meta still names the solution id: restore exactly.
//   2. listing match — exactly one live listing matches name + author.
//   3. repair-backup harvest — a cold OWUI backup names the solution id.
// Returns a summary; never throws for per-agent problems (each becomes a
// skipped entry). The listing sweep runs only when arm-2 candidates exist.
// `completed` distinguishes a genuine pass (latch the once-per-launch
// trigger) from an environment-unavailable skip (retry on a later cycle).
async function runAgentLinkAdoptionSweep({
  listAgents = defaultListAgents,
  searchSolutions = defaultSearchSolutions,
  links = defaultLinkStore(),
  reconcile = defaultReconcile,
  resolveViewerEmail = defaultResolveViewerEmail,
  readBackupSolutionIds = defaultReadBackupSolutionIds,
  logger = console,
} = {}) {
  const summary = { completed: false, candidates: 0, adopted: [], skipped: [] };

  let viewerLocal = "";
  try {
    viewerLocal = emailLocalPart(await resolveViewerEmail());
  } catch (error) {
    logger.warn?.(
      `[Marketplace][links] adoption sweep skipped — viewer identity unavailable: ${error?.message || error}`,
    );
    return summary;
  }
  if (!viewerLocal) return summary;

  let agents;
  try {
    agents = await listAgents();
  } catch (error) {
    // Opportunistic repair: no inventory means nothing to do this cycle.
    logger.warn?.(
      `[Marketplace][links] adoption sweep skipped — agent inventory unavailable: ${error?.message || error}`,
    );
    return summary;
  }
  if (!Array.isArray(agents)) return summary;
  if (!agents.length) {
    // An empty inventory is treated as a transient read everywhere else in
    // this codebase (2026-08-04 prune incident) — don't latch on it.
    return summary;
  }

  const linkMap = await links.listLinks();
  const candidates = agents.filter((agent) => {
    if (!agent?.id || linkMap[agent.id]) return false;
    if (agent.readOnly !== true) return false;
    const ownerLocal = emailLocalPart(agent.createdByEmail);
    return Boolean(ownerLocal) && ownerLocal !== viewerLocal;
  });
  summary.candidates = candidates.length;
  if (!candidates.length) {
    summary.completed = true;
    return summary;
  }

  const adoptLink = async (agent, solutionId, via, listing = null) => {
    try {
      const authorIdentity = String(
        (listing && listingAuthor(listing)) || agent.createdByEmail,
      ).trim();
      await links.setInstalledLink(agent.id, String(solutionId), authorIdentity, {});
      if (listing) {
        const stamp = require("./ai-marketplace-freshness").solutionFreshnessStamp(listing);
        if (stamp !== undefined && stamp !== null && stamp !== "") {
          await links.setLinkRemoteUpdatedAt(agent.id, stamp);
        }
      }
      summary.adopted.push({ agentId: agent.id, solutionId: String(solutionId), via });
      logger.log?.("[Marketplace][links] agent:adopted", {
        agentId: agent.id,
        solutionId: String(solutionId),
        via,
      });
      return true;
    } catch (error) {
      summary.skipped.push({ agentId: agent.id, reason: "link_write_failed" });
      logger.warn?.("[Marketplace][links] agent:adoption-failed", {
        agentId: agent.id,
        error: error?.message || String(error),
      });
      return false;
    }
  };

  // Arm 1 — meta-first: OWUI meta still names the exact listing. No search,
  // no ambiguity; works even when the listing itself was later deleted (the
  // link is installation provenance, not listing liveness).
  const needListingMatch = [];
  for (const agent of candidates) {
    if (agent.marketplaceSolutionId) {
      await adoptLink(agent, agent.marketplaceSolutionId, "meta");
    } else {
      needListingMatch.push(agent);
    }
  }

  // Arm 2 — unambiguous live-listing match (name + author local-part).
  const unmatched = [];
  if (needListingMatch.length) {
    let listings;
    try {
      listings = (await fetchAgentListings(searchSolutions)).filter(
        (listing) => listing?.id && !listingIsDeleted(listing),
      );
    } catch (error) {
      logger.warn?.(
        `[Marketplace][links] adoption sweep incomplete — listing sweep failed: ${error?.message || error}`,
      );
      // Meta adoptions above still count; retry the rest on a later cycle.
      if (summary.adopted.length) await settleReconcile(reconcile, logger);
      return summary;
    }

    const byName = new Map();
    for (const listing of listings) {
      const key = normalizeListingName(listing.display_name || listing.name);
      if (!key) continue;
      const bucket = byName.get(key) || [];
      bucket.push(listing);
      byName.set(key, bucket);
    }

    for (const agent of needListingMatch) {
      const nameKey = normalizeListingName(agent.name);
      const ownerLocal = emailLocalPart(agent.createdByEmail);
      const matches = (byName.get(nameKey) || []).filter(
        (listing) => emailLocalPart(listingAuthor(listing)) === ownerLocal,
      );
      if (matches.length === 1) {
        await adoptLink(agent, matches[0].id, "listing-match", matches[0]);
      } else {
        unmatched.push({
          agent,
          reason: matches.length
            ? "multiple_matching_listings"
            : "no_unambiguous_listing",
        });
      }
    }
  }

  // Arm 3 — repair-backup harvest: a cold OWUI backup may still carry the
  // scrubbed solution id (pre-preservation reconcile behavior). Best-effort.
  if (unmatched.length) {
    let backupIds = {};
    try {
      backupIds = await readBackupSolutionIds(unmatched.map(({ agent }) => agent.id));
    } catch (error) {
      logger.warn?.(
        `[Marketplace][links] repair-backup harvest unavailable: ${error?.message || error}`,
      );
    }
    for (const { agent, reason } of unmatched) {
      const recovered = backupIds?.[agent.id];
      if (typeof recovered === "string" && recovered.trim()) {
        await adoptLink(agent, recovered.trim(), "repair-backup");
        continue;
      }
      summary.skipped.push({ agentId: agent.id, reason });
      logger.log?.("[Marketplace][links] agent:adoption-skipped", {
        agentId: agent.id,
        reason,
      });
    }
  }

  summary.completed = true;
  if (summary.adopted.length) {
    await settleReconcile(reconcile, logger);
  }
  return summary;
}

// Rust adopts OWUI meta FROM the restored links (its existing arm); a
// failure here self-corrects on the next reconcile cycle.
async function settleReconcile(reconcile, logger) {
  try {
    await reconcile();
  } catch (error) {
    logger.warn?.(
      `[Marketplace][links] post-adoption attribution reconcile deferred: ${error?.message || error}`,
    );
  }
}

module.exports = {
  MARKETPLACE_AGENTS_SOLUTION_TYPE,
  runAgentLinkAdoptionSweep,
};
