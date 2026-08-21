// Referential-integrity guards over agent→skill references.
//
// Chat agents reference skills in their OWUI model meta (subagent_skill_ids)
// as bare leaf names, mp/skill, or mp/plugin/skill. Deleting or uninstalling
// a referenced skill silently breaks those agents, and unpublishing a skill
// listing that PUBLISHED agents depend on breaks new installations of those
// agents. These guards run one-shot at the mutation chokepoints (no caching,
// no timers) and FAIL CLOSED when the agent inventory cannot be read —
// matching the round-9 validate-attachable gate and PORTICO-347's fail-closed
// publishing.
//
// Matching is deliberately leaf-canonical (conservative): agents reference
// skills across id shapes and the UI resolves leaf-first, so a same-named
// reference from any source blocks — the error names the agents so the user
// can resolve it.
//
// This module has NO top-level requires: every collaborator (MCP transport,
// link registries) is injectable, and defaults lazy-require the real modules
// at call time — callers with scoped dependency injection (operations, the
// unit fixtures) pass their own.

// Stable wire constants for the local subagents MCP deployment (same values
// as ai-marketplace-install.js, duplicated to keep this module load-light).
const SUBAGENTS_SERVER_ID = "subagents";
const SUBAGENTS_TOOL_LIST = "subagents_list_agents";
const SUBAGENTS_PORT = 8766;

function guardError(message, code, body) {
  const error = new Error(message);
  error.code = code;
  error.status = code === "agent_inventory_unavailable" ? 503 : 409;
  if (body !== undefined) error.body = body;
  return error;
}

function defaultInvokeMcpTool(...args) {
  return require("./docker-mcp").invokeMcpTool(...args);
}

function defaultSkillLinks() {
  return require("./ai-marketplace-skill-links");
}

function defaultAgentLinks() {
  return require("./ai-marketplace-agent-links");
}

// Same semantics as ai-marketplace-skill-links.canonicalSkillName — inlined
// so the guard stays require-free at load.
function leafName(value) {
  if (typeof value !== "string") return "";
  return (
    value
      .trim()
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean)
      .at(-1) || ""
  );
}

function inventoryUnavailable(detail) {
  return guardError(
    `Couldn't verify which agents use this skill — the agent services are unavailable${detail ? ` (${detail})` : ""}. Try again once services are running.`,
    "agent_inventory_unavailable",
  );
}

// ONE subagents_list_agents call per mutation attempt. Every agent entry
// carries id, name, skill_ids, and marketplace_relationship.
async function listAgentSkillReferences({
  invokeMcpTool = defaultInvokeMcpTool,
} = {}) {
  let res;
  try {
    res = await invokeMcpTool(
      SUBAGENTS_SERVER_ID,
      SUBAGENTS_TOOL_LIST,
      {},
      SUBAGENTS_PORT,
    );
  } catch (error) {
    throw inventoryUnavailable(error?.message);
  }
  if (res?.success === false) {
    throw inventoryUnavailable(res?.error);
  }
  const agents = Array.isArray(res?.data?.agents)
    ? res.data.agents
    : Array.isArray(res?.data)
      ? res.data
      : null;
  if (!agents) {
    throw inventoryUnavailable("invalid inventory response");
  }
  return agents
    .map((agent) => ({
      id: typeof agent?.id === "string" ? agent.id.trim() : "",
      name:
        typeof agent?.name === "string" && agent.name.trim()
          ? agent.name.trim()
          : String(agent?.id || ""),
      relationship:
        typeof agent?.marketplace_relationship === "string"
          ? agent.marketplace_relationship
          : null,
      leaves: new Set(
        (Array.isArray(agent?.skill_ids) ? agent.skill_ids : [])
          .map(leafName)
          .filter(Boolean),
      ),
    }))
    .filter((agent) => agent.id);
}

function describeAgents(agents) {
  return agents.map((agent) => `"${agent.name}"`).join(", ");
}

// Blocks skill deletion/uninstall while any agent references the leaf.
async function assertSkillDeletable({ leafName: rawLeaf, invokeMcpTool } = {}) {
  const leaf = leafName(rawLeaf);
  if (!leaf) return;
  const agents = await listAgentSkillReferences({ invokeMcpTool });
  const using = agents.filter((agent) => agent.leaves.has(leaf));
  if (!using.length) return;
  const plural = using.length !== 1;
  throw guardError(
    `Skill "${leaf}" is attached to agent${plural ? "s" : ""}: ${describeAgents(using)}. Remove it from ${plural ? "those agents" : "that agent"} first, then try again.`,
    "skill_in_use_by_agents",
    { skill_id: leaf, agents: using.map(({ id, name }) => ({ id, name })) },
  );
}

// Blocks unpublishing a SKILL solution that is a dependency of a locally
// published agent. The app can only see this user's own published agents;
// backend-side enforcement across users is a marketplace-team follow-up.
async function assertSolutionUnpublishable({
  solutionId,
  solutionType = "",
  invokeMcpTool,
  registries = {},
  deps = {},
} = {}) {
  const id = String(solutionId || "").trim();
  if (!id) return;
  const type = String(solutionType || "").trim().toLowerCase();
  // Agent (and other non-skill) solutions are never guarded here. Unknown
  // types fall through: the reverse-lookup below is self-identifying — only
  // skill listings ever appear in the skill-links registry.
  if (type && type !== "skill" && type !== "skills") return;

  const skillLinks = registries.skillLinks || defaultSkillLinks();
  const agentLinks = registries.agentLinks || defaultAgentLinks();

  // Reverse-lookup FIRST: no locally-linked skill → nothing to check, zero
  // MCP calls. (Injected registry fakes without listLinks read as empty.)
  const links =
    typeof skillLinks.listLinks === "function"
      ? await skillLinks.listLinks(deps)
      : {};
  const linkedLeaves = new Set(
    Object.entries(links || {})
      .filter(([, link]) => link?.solutionId === id)
      .map(([name]) => leafName(name))
      .filter(Boolean),
  );
  if (!linkedLeaves.size) return;

  const publishedAgentIds = new Set();
  try {
    const agentLinkState =
      typeof agentLinks.readState === "function"
        ? await agentLinks.readState(deps)
        : null;
    for (const [agentId, link] of Object.entries(agentLinkState?.links || {})) {
      if (link?.relationship === "published") publishedAgentIds.add(agentId);
    }
  } catch {
    // The meta-mirror fallback below (marketplace_relationship) still applies.
  }

  const agents = await listAgentSkillReferences({ invokeMcpTool });
  const blocking = agents.filter(
    (agent) =>
      (publishedAgentIds.has(agent.id) ||
        agent.relationship === "published") &&
      [...linkedLeaves].some((leaf) => agent.leaves.has(leaf)),
  );
  if (!blocking.length) return;
  const plural = blocking.length !== 1;
  throw guardError(
    `Published agent${plural ? "s" : ""} ${describeAgents(blocking)} ${plural ? "use" : "uses"} this skill. Unpublishing it would break new installations of ${plural ? "those agents" : "that agent"} — unpublish or update ${plural ? "them" : "it"} first.`,
    "skill_dependency_of_published_agents",
    {
      solution_id: id,
      agents: blocking.map(({ id: agentId, name }) => ({ id: agentId, name })),
    },
  );
}

// ---- marketplace-wide published-agent dependency sweep ----------------------

const MARKETPLACE_AGENTS_SOLUTION_TYPE = "portico-agents";

function marketplaceCheckUnavailable(detail) {
  return guardError(
    `Couldn't verify whether published agents on the AI Marketplace use this skill${detail ? ` (${detail})` : ""}. Unpublish stays blocked until the check can run — try again shortly.`,
    "published_agent_check_unavailable",
  );
}

// Accepts a solution envelope's inline bundle, a fetched bundle, or a bare
// payload; returns the agent payload (nested `payload.agent` merged) or null
// when there is nothing to read.
function agentPayloadFromBundleish(bundleish) {
  if (!bundleish || typeof bundleish !== "object") return null;
  const bundle =
    bundleish.payload && typeof bundleish.payload === "object"
      ? bundleish
      : bundleish.bundle && typeof bundleish.bundle === "object"
        ? bundleish.bundle
        : null;
  const payload =
    bundle?.payload && typeof bundle.payload === "object" ? bundle.payload : null;
  if (!payload) return null;
  const nested =
    payload.agent && typeof payload.agent === "object" && !Array.isArray(payload.agent)
      ? payload.agent
      : null;
  return nested ? { ...payload, ...nested } : payload;
}

// Trimmed search envelopes can carry an EMPTY inline payload — treat a
// payload that says nothing about the agent as absent so the bundle fetch
// decides, never a silent pass.
function agentPayloadLooksTrimmed(payload) {
  return (
    !payload ||
    (!payload.base_model_id &&
      !Array.isArray(payload.skill_refs) &&
      !Array.isArray(payload.skill_ids))
  );
}

// The solution ids a payload's skill_refs point at (kind "solution" only —
// local-kind refs are not marketplace listings).
function solutionRefIds(refs) {
  const ids = [];
  for (const ref of Array.isArray(refs) ? refs : []) {
    if (!ref || typeof ref !== "object") continue;
    const kind =
      typeof ref.kind === "string" && ref.kind.trim() ? ref.kind.trim() : "solution";
    if (kind !== "solution") continue;
    const refId = String(ref.solution_id || "").trim();
    if (refId) ids.push(refId);
  }
  return ids;
}

// Sweeps EVERY published agent listing on the Solutions Marketplace — other
// authors' agents included — and maps each referenced skill solution id to
// the agents that reference it. Semi-expensive by design (a paginated
// agent-listing sweep plus bundle fetches for trimmed envelopes), so callers
// run it only for explicit unpublish checks or dependency-annotated listings.
// FAIL-CLOSED: any incomplete read throws published_agent_check_unavailable.
async function collectPublishedAgentSolutionRefs({
  searchSolutions,
  getSolutionBundle,
  pageSize = 100,
  maxPages = 20,
  bundleBatchSize = 4,
} = {}) {
  if (typeof searchSolutions !== "function") {
    throw marketplaceCheckUnavailable("no marketplace client");
  }

  const agents = [];
  try {
    for (let page = 1; ; page += 1) {
      if (page > maxPages) {
        throw new Error(`more than ${maxPages * pageSize} published agents`);
      }
      const res = await searchSolutions({
        query: "",
        filters: { type: [MARKETPLACE_AGENTS_SOLUTION_TYPE] },
        page,
        pageSize,
      });
      // Search deployments answer with either `solutions` or `results`
      // (optionally under `data`) — the same dual shape every reader in
      // ai-marketplace-operations.js accepts. A response with NEITHER key is
      // an unknown contract: treating it as "no published agents" would turn
      // this fail-closed sweep into a silent pass, so it throws instead.
      const pageEnvelope =
        res?.data && typeof res.data === "object" && !Array.isArray(res.data)
          ? res.data
          : res;
      const results = Array.isArray(pageEnvelope?.solutions)
        ? pageEnvelope.solutions
        : Array.isArray(pageEnvelope?.results)
          ? pageEnvelope.results
          : null;
      if (!results) {
        throw new Error("unrecognized search response shape (no solutions/results)");
      }
      agents.push(...results);
      if (results.length < pageSize) break;
    }
  } catch (error) {
    throw marketplaceCheckUnavailable(error?.message || String(error));
  }

  const referencedBy = new Map();
  const record = (sol, refIds) => {
    const agentId = String(sol?.id || "");
    for (const refId of refIds) {
      const list = referencedBy.get(refId) || [];
      if (list.some((entry) => entry.id === agentId)) continue;
      list.push({
        id: agentId,
        name: String(sol?.name || sol?.id || ""),
        submitted_by: String(sol?.submitted_by || sol?.submittedBy || ""),
      });
      referencedBy.set(refId, list);
    }
  };

  const trimmed = [];
  for (const sol of agents) {
    const payload =
      agentPayloadFromBundleish(sol?.bundle) || agentPayloadFromBundleish(sol);
    if (agentPayloadLooksTrimmed(payload)) {
      trimmed.push(sol);
      continue;
    }
    record(sol, solutionRefIds(payload.skill_refs));
  }
  // Trimmed envelopes: fetch bundles in small batches. A failed fetch means
  // the sweep is incomplete — fail closed rather than guess.
  for (let start = 0; start < trimmed.length; start += bundleBatchSize) {
    if (typeof getSolutionBundle !== "function") {
      throw marketplaceCheckUnavailable("no bundle reader");
    }
    const batch = trimmed.slice(start, start + bundleBatchSize);
    const settled = await Promise.allSettled(
      batch.map((sol) => getSolutionBundle(String(sol?.id || ""))),
    );
    for (const [index, outcome] of settled.entries()) {
      if (outcome.status !== "fulfilled") {
        throw marketplaceCheckUnavailable(
          outcome.reason?.message || String(outcome.reason),
        );
      }
      const payload = agentPayloadFromBundleish(outcome.value);
      if (payload) record(batch[index], solutionRefIds(payload.skill_refs));
    }
  }

  return referencedBy;
}

// Blocks unpublishing a SKILL solution that ANY published agent listing on
// the Solutions Marketplace references, which the local guard above cannot
// see. Runs the full sweep; callers invoke it only at explicit unpublish
// time. FAIL-CLOSED: when the sweep cannot complete, unpublish stays blocked.
async function assertSolutionUnpublishableOnMarketplace({
  solutionId,
  solutionType = "",
  searchSolutions,
  getSolutionBundle,
  pageSize = 100,
  maxPages = 20,
  bundleBatchSize = 4,
} = {}) {
  const id = String(solutionId || "").trim();
  if (!id) return;
  const type = String(solutionType || "").trim().toLowerCase();
  // Only skill listings pay for the sweep; agent unpublishes skip it.
  if (type !== "skill" && type !== "skills") return;

  const referencedBy = await collectPublishedAgentSolutionRefs({
    searchSolutions,
    getSolutionBundle,
    pageSize,
    maxPages,
    bundleBatchSize,
  });

  const blocking = referencedBy.get(id) || [];
  if (!blocking.length) return;
  const names = blocking
    .map((agent) => `"${agent.name || agent.id || "unknown"}"`)
    .join(", ");
  const plural = blocking.length !== 1;
  throw guardError(
    `Published agent${plural ? "s" : ""} on the AI Marketplace ${plural ? "use" : "uses"} this skill's listing: ${names}. Unpublish ${plural ? "those agents" : "that agent"} first, then unpublish this skill.`,
    "skill_dependency_of_published_agents",
    {
      solution_id: id,
      agents: blocking,
    },
  );
}

module.exports = {
  assertSkillDeletable,
  assertSolutionUnpublishable,
  assertSolutionUnpublishableOnMarketplace,
  collectPublishedAgentSolutionRefs,
  listAgentSkillReferences,
};
