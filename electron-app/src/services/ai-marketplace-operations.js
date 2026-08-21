// ai-marketplace-operations.js — shared AI Marketplace operations used by BOTH
// the Electron IPC handlers (control-plane GUI) and the local HTTP API
// (agentic access via the Subagents/Skills MCP servers, which proxy here). This
// keeps a SINGLE source of truth for the API key, the viewer identity, install
// bookkeeping, and the publish flow, regardless of who invokes it.
//
// Every function throws a tagged Error (`.code`, optionally `.status`/`.body`)
// on failure; callers wrap the result in their transport-specific envelope.
const path = require("path");
const fsPromises = require("fs").promises;

const agentSkillUsageGuard = require("./agent-skill-usage-guard");
const aiMarketplaceAcl = require("./ai-marketplace-acl");
const aiMarketplaceClient = require("./ai-marketplace-client");
const aiMarketplaceGitBundle = require("./ai-marketplace-git-bundle");
const aiMarketplaceInstall = require("./ai-marketplace-install");
const {
  logMarketplaceDiag,
  safeErrorMeta,
} = require("./marketplace-diagnostics");
const { solutionFreshnessStamp } = require("./ai-marketplace-freshness");
const aiMarketplaceAgentLinks = require("./ai-marketplace-agent-links");
const aiMarketplaceSkillLinks = require("./ai-marketplace-skill-links");
const skillFrontmatter = require("./skill-frontmatter");
const marketplaceService = require("./marketplace-service");
const currentUser = require("./current-user");
const dockerMcp = require("./docker-mcp");
const bootstrap = require("./bootstrap");
const {
  DEFAULT_MANAGED_ROOT,
  resolveAiMarketplaceApiKey,
} = require("../config/runtime-secrets-config");

const SKILLS_SERVER_ID = "skills";
const SKILLS_PORT = 8766;
const TYPE_AGENT = "portico-agents";
const TYPE_SKILL = "skill";
const TYPE_SKILLS = "skills";
const AI_MARKETPLACE_SKILL_SOURCE_ID = "ai-marketplace";
let marketplaceInstallQueue = Promise.resolve();

function taggedError(message, code, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function remediationForCode(code) {
  switch (code) {
    case "installed_copy_read_only":
      return "If the current viewer authored the listing, convert the installed copy in place (reclaim_agent / reclaim_skill); otherwise create an editable user copy, then publish that copy.";
    case "not_owner":
      return "Use list_published_agents or list_published_skills and choose a solution owned by the current viewer.";
    case "solution_type_mismatch":
      return "Use a solution id whose Marketplace type matches this tool.";
    case "marketplace_relationship_mismatch":
      return "Refresh only the local artifact installed from this exact Marketplace solution.";
    case "marketplace_link_mismatch":
      return "Use the solution id already linked to this local artifact.";
    case "marketplace_relationship_unknown":
      return "Repair or remove the contradictory local Marketplace provenance before retrying.";
    case "solution_already_installed":
      return "Use the existing local artifact or delete its local copy before installing again.";
    case "solution_name_conflict":
      return "Choose a unique name. To update an owned listing, republish the linked editable local artifact with that listing's exact solution id.";
    case "solution_not_found":
      return "Discover or publish a current Marketplace solution before retrying.";
    case "local_artifact_required":
      return "Publish an existing editable local agent or user skill.";
    default:
      return null;
  }
}

function lifecycleError(message, code, extra = {}) {
  return taggedError(message, code, {
    remediation: extra.remediation || remediationForCode(code),
    ...extra,
  });
}

function normalizeSolutionReadError(error, solutionId) {
  if (
    Number(error?.status) !== 404 &&
    error?.code !== "not_found" &&
    error?.code !== "solution_not_found"
  ) {
    throw error;
  }
  throw lifecycleError(
    `AI Marketplace solution "${String(solutionId || "").trim()}" was not found.`,
    "solution_not_found",
    {
      status: 404,
      body: {
        solution_id: String(solutionId || "").trim(),
      },
    },
  );
}

// ---- environment glue (mirrors the ipc.js helpers, same underlying sources) --

function marketplaceSecretOptions() {
  return {
    env: process.env,
    managedRoot: process.env.PORTICO_MANAGED_ROOT || DEFAULT_MANAGED_ROOT,
    projectRoot: bootstrap.PROJECT_ROOT,
    resourcesPath: process.resourcesPath,
  };
}

async function readApiKeyOrNull() {
  try {
    return resolveAiMarketplaceApiKey(marketplaceSecretOptions());
  } catch (error) {
    console.warn("[Marketplace] resolveAiMarketplaceApiKey failed:", error.message);
    return "";
  }
}

async function requireApiKey() {
  const apiKey = await readApiKeyOrNull();
  if (!apiKey) {
    throw taggedError(
      "AI Marketplace API key is not set. Add it in the Agents tab before publishing.",
      "missing_api_key",
    );
  }
  return apiKey;
}

async function resolveViewerIdentityDetails({ requireAuthenticatedEmail = false } = {}) {
  try {
    const userResult = await currentUser.get();
    const user = userResult?.sessionSummary?.user || {};
    const email = typeof user.email === "string" ? user.email.trim() : "";
    // Okta full name ("Dionny Santiago") — a human label only, never an
    // identity: ownership matching stays on submitted_by/author.
    const displayName = typeof user.name === "string" ? user.name.trim() : "";
    if (
      requireAuthenticatedEmail &&
      (userResult?.authenticated !== true || !email || !email.includes("@"))
    ) {
      return { email: "", displayName: "" };
    }
    return { email, displayName };
  } catch (error) {
    console.warn("[Marketplace] Could not resolve viewer identity:", error.message);
    return { email: "", displayName: "" };
  }
}

async function resolveViewerIdentity(options = {}) {
  return (await resolveViewerIdentityDetails(options)).email;
}

function normalizeMarketplaceOwnerIdentity(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!normalized) return "";
  const at = normalized.indexOf("@");
  return at === -1 ? normalized : normalized.slice(0, at);
}

async function requireViewerIdentityWithDisplayName() {
  const { email, displayName } = await resolveViewerIdentityDetails({
    requireAuthenticatedEmail: true,
  });
  if (!email) {
    throw taggedError(
      "Could not resolve the current user identity for AI Marketplace publishing.",
      "missing_user_identity",
    );
  }
  return { submittedBy: email, displayName };
}

async function requireViewerIdentity() {
  return (await requireViewerIdentityWithDisplayName()).submittedBy;
}

function getSolutionResponseId(data) {
  return data?.id || data?.solution_id || data?.uuid || null;
}

function getMarketplacePublishStatus(data, fallbackId = null) {
  return {
    id: getSolutionResponseId(data) || fallbackId || null,
    status:
      data && typeof data === "object" && typeof data.status === "string" ? data.status : null,
    has_bundle:
      data && typeof data === "object" && "has_bundle" in data ? data.has_bundle : null,
  };
}

function assertMarketplaceWriteAccepted(data, fallbackId = null) {
  const publishStatus = getMarketplacePublishStatus(data, fallbackId);
  const normalizedStatus = String(publishStatus.status || "").trim().toLowerCase();
  if (normalizedStatus && normalizedStatus !== "active") {
    throw taggedError(
      `AI Marketplace write returned status "${publishStatus.status}".`,
      "marketplace_write_not_active",
      { body: { publishStatus, data } },
    );
  }
  return publishStatus;
}

function normalizedIdSet(value) {
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value
      .map((entry) => String(entry || "").trim())
      .filter(Boolean),
  );
}

function remoteUpdatedAtMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

// Freshness sweep for INSTALLED agents — the agent-side sibling of the
// installed-skill update check. Compares each installed link's stored
// remoteUpdatedAt baseline against the live listing's freshness stamp
// (updated_timestamp on the real backend — see ai-marketplace-freshness.js)
// and persists the verdict on the link (surfaced as has_update by the
// Subagents MCP list/get enrichment). Missing/unreadable listings keep their
// last verdict — a passive scan never erases update state.
async function checkInstalledAgentUpdates() {
  const state = await aiMarketplaceAgentLinks.readStateStrict();
  const installed = Object.entries(state.links || {}).filter(
    ([, link]) => link?.relationship === "installed" && link?.solutionId,
  );
  const updates = [];
  for (const [agentId, link] of installed) {
    let solution;
    try {
      solution = await getSolution(link.solutionId);
    } catch {
      continue;
    }
    const remote = solutionFreshnessStamp(solution);
    if (remote === undefined || remote === null || remote === "") continue;
    if (link.remoteUpdatedAt === undefined || link.remoteUpdatedAt === null) {
      // Legacy link without a baseline: backfill silently, report from the
      // next listing update onward (same policy as the skill sweep).
      await aiMarketplaceAgentLinks.setLinkRemoteUpdatedAt(agentId, remote);
      continue;
    }
    const remoteMs = remoteUpdatedAtMs(remote);
    const baselineMs = remoteUpdatedAtMs(link.remoteUpdatedAt);
    if (remoteMs === null || baselineMs === null) continue;
    const hasRemoteUpdate = remoteMs > baselineMs;
    await aiMarketplaceAgentLinks.markRemoteUpdate(agentId, hasRemoteUpdate);
    if (hasRemoteUpdate) {
      updates.push({
        agentId,
        solutionId: link.solutionId,
        remoteUpdatedAt: String(remote),
      });
    }
  }
  return { updates, hasUpdates: updates.length > 0 };
}

async function runAgentAttributionReconciliation() {
  const result = await dockerMcp.invokeMcpTool(
    aiMarketplaceInstall.SUBAGENTS_SERVER_ID,
    aiMarketplaceInstall.SUBAGENTS_TOOL_RECONCILE_ATTRIBUTION,
    {},
    aiMarketplaceInstall.SUBAGENTS_PORT,
  );
  if (!result?.success) {
    throw taggedError(
      result?.error || "Could not reconcile published agent attribution.",
      result?.code || "agent_attribution_failed",
    );
  }
  if (result?.data?.is_error === true) {
    throw taggedError(
      String(
        result.data.message ||
          result.data.content ||
          "Could not reconcile published agent attribution.",
      ),
      "agent_attribution_failed",
    );
  }
  if (!result?.data || typeof result.data !== "object" || Array.isArray(result.data)) {
    throw taggedError(
      "Agent attribution reconciliation returned an invalid response.",
      "agent_attribution_failed",
    );
  }
  return result.data;
}

async function reconcilePublishedAgentAttribution(
  localAgentId,
  { rejectSkipped = false, rejectMissingCreator = false, requireConfirmed = false } = {},
) {
  const id = typeof localAgentId === "string" ? localAgentId.trim() : "";
  if (!id) return null;
  const data = await runAgentAttributionReconciliation();
  const failures = Array.isArray(data.failures) ? data.failures : [];
  const targetFailure = failures.find((entry) => entry?.id === id);
  if (targetFailure) {
    throw taggedError(
      "Could not reconcile published agent attribution.",
      "agent_attribution_failed",
    );
  }
  const skipped = Array.isArray(data.skipped_linked_ids)
    ? data.skipped_linked_ids
    : [];
  const missingCreator = Array.isArray(data.missing_creator_linked_ids)
    ? data.missing_creator_linked_ids
    : [];
  if (rejectMissingCreator && missingCreator.includes(id)) {
    throw taggedError(
      "Could not establish authoritative creator attribution for the published agent.",
      "agent_attribution_failed",
    );
  }
  if (rejectSkipped && skipped.includes(id)) {
    throw taggedError(
      "Could not establish authoritative creator attribution for the published agent.",
      "agent_attribution_failed",
    );
  }
  if (requireConfirmed) {
    const repaired = normalizedIdSet(data.repaired_ids);
    const unchanged = normalizedIdSet(data.unchanged_ids);
    if (!repaired.has(id) && !unchanged.has(id)) {
      throw taggedError(
        "Agent attribution reconciliation did not confirm the agent's provenance.",
        "agent_attribution_failed",
      );
    }
  }
  return data;
}

async function reconcileUnpublishedAgentAttribution(localAgentIds, solutionId) {
  const targetIds = [...normalizedIdSet(localAgentIds)].sort();
  if (!targetIds.length) return null;

  try {
    const data = await runAgentAttributionReconciliation();
    const repairedIds = normalizedIdSet(data.repaired_ids);
    const unchangedIds = normalizedIdSet(data.unchanged_ids);
    const invalidSkippedIds = normalizedIdSet([
      ...(Array.isArray(data.skipped_base_ids) ? data.skipped_base_ids : []),
      ...(Array.isArray(data.skipped_system_ids) ? data.skipped_system_ids : []),
      ...(Array.isArray(data.skipped_linked_ids) ? data.skipped_linked_ids : []),
      ...(Array.isArray(data.missing_creator_linked_ids)
        ? data.missing_creator_linked_ids
        : []),
    ]);
    const failedIds = normalizedIdSet(
      Array.isArray(data.failures) ? data.failures.map((entry) => entry?.id) : [],
    );
    const unconfirmedIds = targetIds.filter(
      (agentId) =>
        failedIds.has(agentId) ||
        invalidSkippedIds.has(agentId) ||
        (!repairedIds.has(agentId) && !unchangedIds.has(agentId)),
    );
    if (unconfirmedIds.length) {
      throw taggedError(
        `Agent attribution reconciliation did not confirm cleanup for: ${unconfirmedIds.join(", ")}.`,
        "agent_attribution_failed",
      );
    }
    return data;
  } catch (error) {
    throw taggedError(
      `Marketplace solution "${solutionId}" was removed, but local published state cleanup failed for: ${targetIds.join(", ")}.`,
      "agent_attribution_failed",
      {
        body: {
          remote_deleted: true,
          solution_id: solutionId,
          local_agent_ids: targetIds,
          cause_code: error?.code || "agent_attribution_failed",
        },
      },
    );
  }
}

// ---- known-id fetchers (for install dependency resolution) ------------------

async function addDirNames(dir, prefix, known) {
  try {
    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      known.add(prefix ? `${prefix}/${entry.name}` : entry.name);
    }
  } catch {}
}

async function dirHasSkillMd(dirPath) {
  try {
    return (await fsPromises.stat(path.join(dirPath, "SKILL.md"))).isFile();
  } catch {
    return false;
  }
}

async function fetchKnownSkillIds() {
  const known = new Set();
  const root = bootstrap.PROJECT_ROOT;
  await addDirNames(path.join(root, "skills"), null, known);
  await addDirNames(path.join(root, "skills-user"), null, known);
  const marketplaceRoot = path.join(root, "skills-marketplace");
  // SKILL.md-aware walk: a marketplace entry dir is either a flat skill
  // ({mp}/{skill}/SKILL.md) or a plugin holding depth-3 skills
  // ({mp}/{plugin}/{skill}/SKILL.md). Plugin skills also register their
  // legacy 2-segment alias when it is unambiguous, so agents saved before
  // the plugin layout still resolve their dependencies.
  const legacyAliases = new Map(); // alias -> count of plugin skills claiming it
  try {
    const marketplaceDirs = await fsPromises.readdir(marketplaceRoot, { withFileTypes: true });
    for (const mp of marketplaceDirs) {
      if (!mp.isDirectory() || mp.name.startsWith(".")) continue;
      const mpPath = path.join(marketplaceRoot, mp.name);
      let entries = [];
      try {
        entries = await fsPromises.readdir(mpPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const entryPath = path.join(mpPath, entry.name);
        if (await dirHasSkillMd(entryPath)) {
          known.add(`${mp.name}/${entry.name}`);
          continue;
        }
        let leafEntries = [];
        try {
          leafEntries = await fsPromises.readdir(entryPath, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const leaf of leafEntries) {
          if (!leaf.isDirectory() || leaf.name.startsWith(".")) continue;
          if (!(await dirHasSkillMd(path.join(entryPath, leaf.name)))) continue;
          known.add(`${mp.name}/${entry.name}/${leaf.name}`);
          const alias = `${mp.name}/${leaf.name}`;
          legacyAliases.set(alias, (legacyAliases.get(alias) || 0) + 1);
        }
      }
    }
  } catch {}
  for (const [alias, count] of legacyAliases) {
    if (count === 1 && !known.has(alias)) {
      known.add(alias);
    }
  }
  return known;
}

async function fetchKnownToolServerIds() {
  const known = new Set();
  const root = bootstrap.PROJECT_ROOT;
  for (const dir of [path.join(root, "mcp-configs"), path.join(root, "mcp-configs-user")]) {
    try {
      const entries = await fsPromises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        known.add(`server:${entry.name}`);
      }
    } catch {}
  }
  return known;
}

async function fetchKnownAgentIds() {
  const known = new Set();
  const res = await dockerMcp.invokeMcpTool(
    aiMarketplaceInstall.SUBAGENTS_SERVER_ID,
    aiMarketplaceInstall.SUBAGENTS_TOOL_LIST,
    {},
    aiMarketplaceInstall.SUBAGENTS_PORT,
  );
  if (res?.success === false) {
    throw taggedError(
      res.error || "Could not load the local agent inventory.",
      "agent_inventory_unavailable",
    );
  }
  const agents = Array.isArray(res?.data?.agents)
    ? res.data.agents
    : Array.isArray(res?.data)
      ? res.data
      : null;
  if (!agents) {
    throw taggedError(
      "The local agent inventory response was invalid.",
      "agent_inventory_unavailable",
    );
  }
  for (const agent of agents) {
    const id = typeof agent?.id === "string" ? agent.id.trim() : "";
    if (id) known.add(id);
  }
  return known;
}

// ---- MCP helpers ------------------------------------------------------------

function unwrapMcpData(res) {
  if (res && typeof res === "object" && "data" in res) return res.data;
  return res;
}

// mcp-orc reports tool-level failures as HTTP 200 with an
// `{is_error: true, message}` envelope, so `success` alone is not enough:
// treating that envelope as data is how a mis-parameterized publish once
// surfaced as "empty system prompt" instead of the server's real error.
function unwrapMcpToolResult(toolName, res) {
  if (res && res.success === false) {
    throw taggedError(
      res.error || res.data?.message || `${toolName} failed`,
      res.code || "mcp_tool_failed",
    );
  }
  const data = unwrapMcpData(res);
  if (data && typeof data === "object" && data.is_error === true) {
    throw taggedError(
      String(data.message || data.content || `${toolName} failed`),
      "mcp_tool_failed",
    );
  }
  return data;
}

async function invokeSubagentsTool(toolName, args = {}) {
  const res = await dockerMcp.invokeMcpTool(
    aiMarketplaceInstall.SUBAGENTS_SERVER_ID,
    toolName,
    args,
    aiMarketplaceInstall.SUBAGENTS_PORT,
  );
  return unwrapMcpToolResult(toolName, res);
}

async function invokeSkillsTool(toolName, args = {}) {
  const res = await dockerMcp.invokeMcpTool(SKILLS_SERVER_ID, toolName, args, SKILLS_PORT);
  return unwrapMcpToolResult(toolName, res);
}

// ---- reads ------------------------------------------------------------------

// The marketplace's search filter does EXACT type matching, and solutions are
// stored with type "skills" (plural) / "portico-agents" — but callers
// (notably the skills MCP) historically query "skill" (singular), which
// matches nothing. Normalize the known aliases at this choke point.
function normalizeMarketplaceSolutionType(value) {
  const type = typeof value === "string" ? value.trim() : "";
  if (!type) return value;
  const lowered = type.toLowerCase();
  if (lowered === "skill" || lowered === "skills") return "skills";
  if (lowered === "agent" || lowered === "agents" || lowered === TYPE_AGENT) {
    return TYPE_AGENT;
  }
  return type;
}

function normalizeSearchParams(params) {
  const input = params && typeof params === "object" ? params : {};
  const filters = input.filters && typeof input.filters === "object" ? input.filters : null;
  if (!filters || filters.type === undefined || filters.type === null) return input;
  const type = Array.isArray(filters.type)
    ? filters.type.map((t) => normalizeMarketplaceSolutionType(t))
    : normalizeMarketplaceSolutionType(filters.type);
  return { ...input, filters: { ...filters, type } };
}

// The marketplace embeds each listing's full audit trail in version_history:
// previous_values carry complete SUPERSEDED payloads (agent skill lists,
// skill_refs, bundle content) that are indistinguishable from current data at
// a glance. Nothing in the app consumes them, they bloat every read (a single
// agent envelope can carry ~10KB of history), and models reading the agentic
// surfaces reliably mistake historical payloads for current state (chat
// c6f2570f: two models in one conversation reported a superseded skill_ref as
// a live dependency). Strip at the semantic read layer; the empty array is
// the backend's own trimmed form.
function stripSolutionVersionHistory(solution) {
  if (
    solution &&
    typeof solution === "object" &&
    "version_history" in solution
  ) {
    solution.version_history = [];
  }
  return solution;
}

function stripSearchPayloadVersionHistory(payload) {
  for (const list of [
    Array.isArray(payload) ? payload : null,
    payload?.solutions,
    payload?.results,
  ]) {
    if (Array.isArray(list)) list.forEach(stripSolutionVersionHistory);
  }
  return payload;
}

// Skill solutions are named with the kebab id, and legacy listings carry no
// title at all — models and pickers need a human display_name. Enrich every
// skill-type solution (and bundle) at the same semantic read layer that
// strips version_history: an explicit payload display_name wins unless it
// merely restates the kebab name, else derive from the leaf. Agent and
// mcp-server solutions are untouched (their name IS the display name).
function ensureSkillSolutionDisplayName(solution) {
  if (!solution || typeof solution !== "object") return solution;
  const type = String(solution.type || "").trim().toLowerCase();
  if (type !== "skill" && type !== "skills") return solution;
  const kebab = String(
    solution.name || solution.payload?.name || solution.id || "",
  ).trim();
  const leaf = aiMarketplaceSkillLinks.canonicalSkillName(kebab) || kebab;
  const explicit = [
    solution.display_name,
    solution.payload?.display_name,
    solution.bundle?.payload?.display_name,
  ]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find((value) => value && value !== kebab && value !== leaf);
  solution.display_name =
    explicit || skillFrontmatter.formatSkillDisplayName(leaf);
  return solution;
}

function ensureSearchPayloadSkillDisplayNames(payload) {
  for (const list of [
    Array.isArray(payload) ? payload : null,
    payload?.solutions,
    payload?.results,
  ]) {
    if (Array.isArray(list)) list.forEach(ensureSkillSolutionDisplayName);
  }
  return payload;
}

async function search(params = {}, opts = {}) {
  const viewerEmail = await resolveViewerIdentity();
  const payload = await aiMarketplaceClient.search(normalizeSearchParams(params || {}), {
    viewerEmail,
    ...opts,
  });
  return ensureSearchPayloadSkillDisplayNames(
    stripSearchPayloadVersionHistory(payload),
  );
}

// Marketplace-wide published-agent dependency check for a SKILL solution,
// bound to this module's client access. Skill-type ids only (others no-op);
// throws skill_dependency_of_published_agents with the blocking agents, or
// published_agent_check_unavailable when the sweep cannot complete
// (fail-closed). Shared by deletePublishedSolution and the agentic unpublish
// route's pre-confirmation fast-fail.
async function assertSolutionUnpublishableOnMarketplace(solutionId, solutionType) {
  await agentSkillUsageGuard.assertSolutionUnpublishableOnMarketplace({
    solutionId,
    solutionType,
    searchSolutions: (params) => search(params),
    getSolutionBundle: (bundleSolutionId) => getBundle(bundleSolutionId),
  });
}

function solutionTypeMatches(actualType, expectedType) {
  if (!expectedType) return true;
  return (
    normalizeMarketplaceSolutionType(actualType) ===
    normalizeMarketplaceSolutionType(expectedType)
  );
}

function assertSolutionType(solution, expectedType) {
  if (!expectedType) return solution;
  if (!solutionTypeMatches(solution?.type, expectedType)) {
    throw lifecycleError(
      `Marketplace solution type "${solution?.type || "unknown"}" does not match expected type "${normalizeMarketplaceSolutionType(expectedType)}".`,
      "solution_type_mismatch",
      {
        body: {
          solution_id: solution?.id || null,
          actual_type: solution?.type || null,
          expected_type: normalizeMarketplaceSolutionType(expectedType),
        },
      },
    );
  }
  return solution;
}

async function getSolution(id, { expectedType } = {}) {
  const viewerEmail = await resolveViewerIdentity();
  let solution;
  try {
    solution = await aiMarketplaceClient.getSolution(id, { viewerEmail });
  } catch (error) {
    normalizeSolutionReadError(error, id);
  }
  return ensureSkillSolutionDisplayName(
    assertSolutionType(stripSolutionVersionHistory(solution), expectedType),
  );
}

async function getBundle(id, { expectedType, interactiveAuth = false } = {}) {
  const viewerEmail = await resolveViewerIdentity();
  let bundle;
  try {
    bundle = await aiMarketplaceClient.getSolutionBundle(id, { viewerEmail });
  } catch (error) {
    // Git-referenced listings (bundle_source_git_url in the envelope, no
    // inline bundle) currently 500 on the backend's /bundle route; when the
    // envelope names an allowlisted repository, materialize the bundle
    // client-side instead of surfacing the server error. Envelope 404s keep
    // failing first (PORTICO-272 availability gate).
    if (!aiMarketplaceGitBundle.shouldAttemptGitBundleFallback(error)) {
      normalizeSolutionReadError(error, id);
    }
    const envelope = await aiMarketplaceClient
      .getSolution(id, { viewerEmail })
      .catch(() => null);
    if (!aiMarketplaceGitBundle.extractBundleGitSource(envelope)) {
      normalizeSolutionReadError(error, id);
    }
    try {
      bundle = await aiMarketplaceGitBundle.materializeSkillBundleFromGitSource(
        envelope,
        { interactiveAuth },
      );
    } catch (fallbackError) {
      throw lifecycleError(
        `The Marketplace could not serve this listing's bundle and the app could not fetch it from ${envelope.bundle_source_git_url}: ${fallbackError.message}`,
        "bundle_fallback_failed",
        {
          remediation:
            "Verify you can reach the listing's source repository (VPN + GitLab sign-in), then retry.",
          cause: fallbackError,
          body: {
            solution_id: id,
            bundle_source_git_url: envelope.bundle_source_git_url,
          },
        },
      );
    }
  }
  return ensureSkillSolutionDisplayName(assertSolutionType(bundle, expectedType));
}

// List solutions published by the current viewer, optionally filtered by type.
// Always searches per-type: an unfiltered marketplace search returns the whole
// index (thousands of entries) and the viewer's solutions never make the first
// page, so the ownership filter below would see nothing.
const LISTABLE_SOLUTION_TYPES = ["skills", TYPE_AGENT];

async function listPublished({ type, includeAgentDependencies = false } = {}) {
  const viewerEmail = await resolveViewerIdentity();
  const types = type ? [normalizeMarketplaceSolutionType(type)] : LISTABLE_SOLUTION_TYPES;
  const pages = await Promise.all(
    types.map((t) =>
      aiMarketplaceClient.search(
        { query: "", filters: { type: [t] }, pageSize: 100 },
        // Read-only POST: safe to retry through transient 5xx/timeouts at
        // the full GET-grade attempt budget.
        { viewerEmail, retryable: true, retryAttempts: 3 },
      ),
    ),
  );
  const solutions = pages.flatMap((data) =>
    Array.isArray(data?.solutions)
      ? data.solutions
      : Array.isArray(data?.results)
        ? data.results
        : Array.isArray(data)
          ? data
          : [],
  );
  const viewerOwnerIdentity = normalizeMarketplaceOwnerIdentity(viewerEmail);
  const mine = viewerOwnerIdentity
    ? solutions.filter(
        (s) => normalizeMarketplaceOwnerIdentity(s?.submitted_by) === viewerOwnerIdentity,
      )
    : solutions;
  mine.forEach(stripSolutionVersionHistory);
  mine.forEach(ensureSkillSolutionDisplayName);
  // Opt-in dependency annotation for the agentic surface: chat answers about
  // unpublishability must reflect the same published-agent constraint the
  // unpublish action enforces. Costs a marketplace-wide agent sweep, so the
  // hot renderer paths never ask for it.
  const isSkillTypeSolution = (s) => {
    const t = String(s?.type || "").trim().toLowerCase();
    return t === "skill" || t === "skills";
  };
  if (includeAgentDependencies && mine.some(isSkillTypeSolution)) {
    try {
      const referencedBy = await agentSkillUsageGuard.collectPublishedAgentSolutionRefs({
        searchSolutions: (params) => search(params),
        getSolutionBundle: (solutionId) => getBundle(solutionId),
      });
      for (const sol of mine) {
        if (!isSkillTypeSolution(sol)) continue;
        sol.used_by_published_agents =
          referencedBy.get(String(sol?.id || "").trim()) || [];
      }
    } catch (error) {
      // The listing stays informational; flag the gap instead of failing the
      // whole list. The unpublish ACTION still fails closed on its own sweep.
      for (const sol of mine) {
        if (!isSkillTypeSolution(sol)) continue;
        sol.agent_dependency_check_unavailable = true;
      }
    }
  }
  return { solutions: mine, viewer_email: viewerEmail };
}

function normalizeMarketplaceSolutionName(value) {
  const name = typeof value === "string" ? value : "";
  return name
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function marketplaceSolutionsFromSearch(data) {
  return Array.isArray(data?.solutions)
    ? data.solutions
    : Array.isArray(data?.results)
      ? data.results
      : Array.isArray(data)
        ? data
        : [];
}

async function assertMarketplaceSolutionNameAvailable(name, type) {
  const normalizedName = normalizeMarketplaceSolutionName(name);
  const normalizedType = normalizeMarketplaceSolutionType(type);
  if (!normalizedName || !normalizedType) return;
  const viewerEmail = await resolveViewerIdentity();
  const result = await aiMarketplaceClient.search(
    {
      query: String(name).trim(),
      filters: { type: [normalizedType] },
      pageSize: 100,
    },
    // Read-only POST: safe to retry through transient 5xx/timeouts at the
    // full GET-grade attempt budget.
    { viewerEmail, retryable: true, retryAttempts: 3 },
  );
  const collisions = marketplaceSolutionsFromSearch(result).filter(
    (solution) =>
      solutionTypeMatches(solution?.type, normalizedType) &&
      normalizeMarketplaceSolutionName(solution?.name) === normalizedName,
  );
  if (!collisions.length) return;
  throw lifecycleError(
    `An AI Marketplace ${normalizedType === TYPE_AGENT ? "agent" : "skill"} named "${String(name).trim()}" already exists.`,
    "solution_name_conflict",
    {
      body: {
        name: String(name).trim(),
        type: normalizedType,
        matching_solution_ids: collisions
          .map((solution) => String(solution?.id || "").trim())
          .filter(Boolean),
      },
    },
  );
}

// Search/get tools are discovery-only. Ownership-sensitive writes must prove
// the target appears in listPublished for the current viewer and has the exact
// entity type before a confirmation dialog or remote mutation is attempted.
async function getOwnedSolutionForWrite(id, { expectedType } = {}) {
  const solutionId = normalizeSolutionId(id);
  const expected = expectedType
    ? normalizeMarketplaceSolutionType(expectedType)
    : null;
  const solution = await getSolution(solutionId, { expectedType: expected });
  if (String(solution?.status || "").trim().toLowerCase() === "deleted") {
    throw lifecycleError(
      "This AI Marketplace solution is already absent.",
      "solution_not_found",
      {
        body: {
          solution_id: solutionId,
          expected_type: expected,
        },
      },
    );
  }
  const published = await listPublished({ type: expected || solution?.type });
  const owned = (published.solutions || []).find(
    (candidate) => String(candidate?.id || "").trim() === solutionId,
  );
  if (!owned) {
    throw lifecycleError(
      "The current viewer does not own this AI Marketplace solution.",
      "not_owner",
      {
        body: {
          solution_id: solutionId,
          expected_type: expected,
        },
      },
    );
  }
  assertSolutionType(owned, expected || solution?.type);
  return solution;
}

// ---- install ----------------------------------------------------------------

function normalizeSolutionId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) {
    throw taggedError("Marketplace solution id is required.", "invalid_argument");
  }
  return id;
}

function withMarketplaceInstallLock(action) {
  const run = marketplaceInstallQueue.then(action, action);
  marketplaceInstallQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function isMissingLocalPath(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

function localProvenanceError(cause, code = "local_provenance_unavailable") {
  if (cause?.code === "local_provenance_unavailable" || cause?.code === "local_provenance_invalid") {
    return cause;
  }
  return taggedError(
    "Could not safely verify local AI Marketplace provenance.",
    code,
    {
      body: {
        cause_code:
          typeof cause?.code === "string" && cause.code.trim()
            ? cause.code.trim()
            : "provenance_read_failed",
      },
    },
  );
}

function invalidLocalProvenance() {
  return localProvenanceError(
    { code: "invalid_local_provenance" },
    "local_provenance_invalid",
  );
}

async function readInstalledSkillRecordsStrict(projectRoot) {
  const configPath = path.join(projectRoot, "marketplaces.json");
  try {
    const stat = await fsPromises.lstat(configPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw invalidLocalProvenance();
    }
    const parsed = JSON.parse(await fsPromises.readFile(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw invalidLocalProvenance();
    }
    if (parsed.installedSkills === undefined) return [];
    if (!Array.isArray(parsed.installedSkills)) {
      throw invalidLocalProvenance();
    }
    return parsed.installedSkills;
  } catch (error) {
    if (isMissingLocalPath(error)) return [];
    throw localProvenanceError(error);
  }
}

async function inspectRegularSkillFile(projectRoot, filePath, localSkillId) {
  const root = path.resolve(projectRoot);
  const target = path.resolve(filePath);
  if (!target.startsWith(`${root}${path.sep}`)) {
    throw invalidLocalProvenance();
  }
  const segments = path.relative(root, target).split(path.sep).filter(Boolean);
  let cursor = root;
  for (let index = 0; index < segments.length; index += 1) {
    cursor = path.join(cursor, segments[index]);
    let stat;
    try {
      stat = await fsPromises.lstat(cursor);
    } catch (error) {
      if (isMissingLocalPath(error)) return null;
      throw localProvenanceError(error);
    }
    if (stat.isSymbolicLink()) {
      throw invalidLocalProvenance();
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      return null;
    }
    if (index === segments.length - 1 && !stat.isFile()) {
      return null;
    }
  }
  return {
    absolutePath: target,
    installedPath: path.relative(root, path.dirname(target)),
    localSkillId,
  };
}

async function listMarketplaceSkillSourcesStrict(projectRoot) {
  const marketplaceRoot = path.join(projectRoot, "skills-marketplace");
  let stat;
  try {
    stat = await fsPromises.lstat(marketplaceRoot);
  } catch (error) {
    if (isMissingLocalPath(error)) return [];
    throw localProvenanceError(error);
  }
  if (stat.isSymbolicLink()) throw invalidLocalProvenance();
  if (!stat.isDirectory()) return [];
  let entries;
  try {
    entries = await fsPromises.readdir(marketplaceRoot, { withFileTypes: true });
  } catch (error) {
    throw localProvenanceError(error);
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw invalidLocalProvenance();
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function findPublishedSkillMatches(projectRoot, skillLinks, solutionId) {
  const matches = [];
  const sources = await listMarketplaceSkillSourcesStrict(projectRoot);
  for (const [canonicalKey, link] of Object.entries(skillLinks || {})) {
    if (link?.solutionId !== solutionId) continue;
    const directCandidates = [
      {
        path: path.join(projectRoot, "skills", canonicalKey, "SKILL.md"),
        localSkillId: canonicalKey,
      },
      {
        path: path.join(projectRoot, "skills-user", canonicalKey, "SKILL.md"),
        localSkillId: canonicalKey,
      },
    ];
    for (const candidate of directCandidates) {
      const match = await inspectRegularSkillFile(
        projectRoot,
        candidate.path,
        candidate.localSkillId,
      );
      if (match) matches.push({ ...match, kind: "published" });
    }
    for (const source of sources) {
      const match = await inspectRegularSkillFile(
        projectRoot,
        path.join(
          projectRoot,
          "skills-marketplace",
          source,
          canonicalKey,
          "SKILL.md",
        ),
        `${source}/${canonicalKey}`,
      );
      if (match) matches.push({ ...match, kind: "published" });
    }
  }
  return matches;
}

function normalizedInstalledSkillId(record) {
  const canonical = aiMarketplaceSkillLinks.canonicalSkillName(record?.skillId);
  const id = aiMarketplaceInstall.sanitizeId(canonical);
  if (!id || id === "." || id === "..") throw invalidLocalProvenance();
  return id;
}

async function findInstalledSkillMatches(projectRoot, records, solutionId) {
  const matches = [];
  for (const record of records) {
    if (
      !record ||
      typeof record !== "object" ||
      record.marketplaceId !== AI_MARKETPLACE_SKILL_SOURCE_ID ||
      record.skillSource?.type !== "ai-marketplace-solution" ||
      String(record.skillSource?.solutionId || "").trim() !== solutionId
    ) {
      continue;
    }
    const skillId = normalizedInstalledSkillId(record);
    const localPath = typeof record.localPath === "string" ? record.localPath.trim() : "";
    if (!localPath || path.isAbsolute(localPath) || localPath.includes("\\")) {
      throw invalidLocalProvenance();
    }
    const skillDir = path.resolve(projectRoot, localPath);
    const root = path.resolve(projectRoot);
    if (!skillDir.startsWith(`${root}${path.sep}`)) {
      throw invalidLocalProvenance();
    }
    const match = await inspectRegularSkillFile(
      projectRoot,
      path.join(skillDir, "SKILL.md"),
      `${AI_MARKETPLACE_SKILL_SOURCE_ID}/${skillId}`,
    );
    if (!match) continue;
    matches.push({
      ...match,
      kind: "installed",
      record,
      skillId,
      expectedLocalPath: path.join(
        "skills-marketplace",
        AI_MARKETPLACE_SKILL_SOURCE_ID,
        skillId,
      ),
    });
  }
  return matches;
}

function skillBundlePayload(bundle) {
  if (bundle?.payload && typeof bundle.payload === "object" && !Array.isArray(bundle.payload)) {
    return bundle.payload;
  }
  if (typeof bundle?.payload === "string") {
    try {
      const parsed = JSON.parse(bundle.payload);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {}
  }
  return {};
}

function marketplaceSkillIdFromBundle(bundle) {
  const payload = skillBundlePayload(bundle);
  const id = aiMarketplaceInstall.sanitizeId(
    aiMarketplaceSkillLinks.canonicalSkillName(payload.name) ||
      aiMarketplaceSkillLinks.canonicalSkillName(bundle?.id) ||
      "",
  );
  if (!id || id === "." || id === "..") {
    throw taggedError(
      "Marketplace skill bundle has no safe local id.",
      "skill_install_path_invalid",
    );
  }
  return id;
}

async function inspectMarketplaceSkillDestination(projectRoot, skillId) {
  return await inspectRegularSkillFile(
    projectRoot,
    path.join(
      projectRoot,
      "skills-marketplace",
      AI_MARKETPLACE_SKILL_SOURCE_ID,
      skillId,
      "SKILL.md",
    ),
    `${AI_MARKETPLACE_SKILL_SOURCE_ID}/${skillId}`,
  );
}

async function inspectSkillProvenance(projectRoot, solutionId) {
  let linkState;
  try {
    linkState = await aiMarketplaceSkillLinks.readStateStrict();
  } catch (error) {
    throw localProvenanceError(error);
  }
  const records = await readInstalledSkillRecordsStrict(projectRoot);
  const [published, installed] = await Promise.all([
    findPublishedSkillMatches(projectRoot, linkState.links, solutionId),
    findInstalledSkillMatches(projectRoot, records, solutionId),
  ]);
  return { published, installed };
}

function alreadyInstalledError(solutionId, matches) {
  return lifecycleError(
    "This AI Marketplace solution already exists locally.",
    "solution_already_installed",
    {
      body: {
        solution_id: solutionId,
        existing: matches.map((match) => ({
          id: match.localAgentId || match.localSkillId,
          kind: match.kind || match.relationship || "local",
        })),
      },
    },
  );
}

async function assertAgentInstallAllowed({ solutionId, existingAgentId, knownAgentIds }) {
  let state;
  try {
    state = await aiMarketplaceAgentLinks.readStateStrict();
  } catch (error) {
    throw localProvenanceError(error);
  }
  const sameSolution = Object.entries(state.links || {})
    .filter(([, link]) => link?.solutionId === solutionId)
    .map(([localAgentId, link]) => ({
      kind: link.relationship || "unknown",
      localAgentId,
      relationship: link.relationship || "unknown",
    }));
  const extant = sameSolution.filter((match) => knownAgentIds.has(match.localAgentId));
  if (!existingAgentId) {
    if (extant.length) throw alreadyInstalledError(solutionId, extant);
    return;
  }
  const exact = sameSolution.find((match) => match.localAgentId === existingAgentId);
  if (!exact) {
    throw lifecycleError(
      "The requested local agent is not linked to this AI Marketplace solution.",
      "marketplace_link_mismatch",
    );
  }
  if (!knownAgentIds.has(existingAgentId) || exact.relationship !== "installed") {
    throw lifecycleError(
      "Only the matching installed local agent may be refreshed from this Marketplace solution.",
      "marketplace_relationship_mismatch",
      {
        body: {
          solution_id: solutionId,
          local_agent_id: existingAgentId,
          relationship: exact.relationship,
        },
      },
    );
  }
  const otherExtant = extant.filter((match) => match.localAgentId !== existingAgentId);
  if (otherExtant.length) {
    throw alreadyInstalledError(solutionId, otherExtant);
  }
}

function uniqueReusableSkillMatch(provenance, solutionId) {
  if (provenance.installed.length > 1) {
    throw alreadyInstalledError(solutionId, provenance.installed);
  }
  if (provenance.published.length > 1) {
    throw alreadyInstalledError(solutionId, provenance.published);
  }
  const installed = provenance.installed[0] || null;
  const published = provenance.published[0] || null;
  if (installed && published && installed.absolutePath !== published.absolutePath) {
    throw alreadyInstalledError(solutionId, [installed, published]);
  }
  return installed || published;
}

async function assertTopLevelSkillInstallAllowed({
  bundle,
  projectRoot,
  refreshInstalledSkillId,
  solutionId,
}) {
  const provenance = await inspectSkillProvenance(projectRoot, solutionId);
  const bundleId = marketplaceSkillIdFromBundle(bundle);
  const destination = await inspectMarketplaceSkillDestination(projectRoot, bundleId);
  const matches = [...provenance.published, ...provenance.installed];
  const destinationIsProven =
    !destination || matches.some((match) => match.absolutePath === destination.absolutePath);
  if (!refreshInstalledSkillId) {
    if (matches.length) throw alreadyInstalledError(solutionId, matches);
    if (!destinationIsProven) {
      throw taggedError(
        "A different local skill already occupies this marketplace install target.",
        "skill_install_target_conflict",
      );
    }
    // Name-collision guard against skills OUTSIDE the ai-marketplace install
    // root: a user or system skill with the same leaf name would coexist with
    // the installed copy under one display name and one ambiguous leaf id.
    // Fail closed with the rename/replace remediations instead (the sanctioned
    // take-over path is replace_user_skill_with_marketplace_install).
    for (const [source, dir] of [
      ["user", "skills-user"],
      ["system", "skills"],
    ]) {
      const collision = await inspectRegularSkillFile(
        projectRoot,
        path.join(projectRoot, dir, bundleId, "SKILL.md"),
        bundleId,
      );
      if (collision) {
        throw lifecycleError(
          `A local ${source} skill named "${bundleId}" already exists; installing this Marketplace solution would create a duplicate skill name locally.`,
          "skill_name_conflict_local",
          {
            body: { solution_id: solutionId, skill_id: bundleId, conflicting_source: source },
            remediation:
              source === "user"
                ? `Rename the local skill with rename_skill (skill_name "${bundleId}", new_skill_name of your choice; if it is published, unpublish_skill first) and retry the install, or — to deliberately replace it with the Marketplace version — delete_skill "${bundleId}" first, then install.`
                : "Choose a different listing; system skill names are reserved.",
          },
        );
      }
    }
    return;
  }

  const reusable = uniqueReusableSkillMatch(provenance, solutionId);
  if (!reusable || reusable.kind !== "installed") {
    throw lifecycleError(
      "The requested installed skill refresh target was not found.",
      "marketplace_relationship_mismatch",
    );
  }
  const requestedId = aiMarketplaceInstall.sanitizeId(
    aiMarketplaceSkillLinks.canonicalSkillName(refreshInstalledSkillId),
  );
  const actualLocalPath = path.normalize(reusable.record.localPath);
  const expectedLocalPath = path.normalize(reusable.expectedLocalPath);
  const hasSeparatePublishedOriginal = provenance.published.some(
    (match) => match.absolutePath !== reusable.absolutePath,
  );
  if (
    requestedId !== reusable.skillId ||
    bundleId !== reusable.skillId ||
    actualLocalPath !== expectedLocalPath ||
    hasSeparatePublishedOriginal
  ) {
    throw lifecycleError(
      "The marketplace skill refresh target does not match local provenance.",
      "marketplace_relationship_mismatch",
    );
  }
}

// Human title for a local skill directory: an authored (inline or sidecar)
// display_name wins unless it merely restates the kebab id — the same guard
// the Rust catalog applies, because installed-copy sidecars carry
// display_name = the kebab solution name. Best-effort: an unreadable
// directory still yields a derived title.
async function localSkillDisplayName(skillDirPath, canonicalName) {
  try {
    const metadata =
      await skillFrontmatter.parseSkillDirectoryMetadata(skillDirPath);
    const explicit = String(metadata?.display_name || "").trim();
    if (explicit && explicit !== canonicalName) return explicit;
  } catch {
    // fall through to derivation
  }
  return skillFrontmatter.formatSkillDisplayName(canonicalName);
}

async function getSkillProvenanceSnapshot() {
  let linkState;
  try {
    linkState = await aiMarketplaceSkillLinks.readStateStrict();
  } catch (error) {
    throw localProvenanceError(error);
  }
  const installedSkills = await readInstalledSkillRecordsStrict(
    bootstrap.PROJECT_ROOT,
  );
  return {
    skill_links: linkState.links || {},
    installed_skills: installedSkills.map((entry) => ({
      marketplace_id:
        typeof entry?.marketplaceId === "string" ? entry.marketplaceId : null,
      skill_id: typeof entry?.skillId === "string" ? entry.skillId : null,
      local_path: typeof entry?.localPath === "string" ? entry.localPath : null,
      marketplace_solution_id:
        entry?.skillSource?.type === "ai-marketplace-solution" &&
        typeof entry?.skillSource?.solutionId === "string"
          ? entry.skillSource.solutionId
          : null,
      source_type:
        typeof entry?.skillSource?.type === "string"
          ? entry.skillSource.type
          : null,
      // Freshness as of the last sweep/sync (persisted flag — no network
      // here); lets list_skills badge "update available" without a probe.
      has_update: entry?.hasUpdate === true,
      installed_version:
        typeof entry?.installedVersion === "string"
          ? entry.installedVersion
          : null,
    })),
  };
}

async function deleteLocalSkill(skillId) {
  const requested = String(skillId || "").trim().replace(/\\/g, "/");
  const parts = requested.split("/").filter(Boolean);
  if (
    !requested ||
    parts.length > 2 ||
    parts.some((part) => part === "." || part === "..")
  ) {
    throw lifecycleError("A valid skill id is required.", "invalid_argument");
  }
  const canonicalName = aiMarketplaceSkillLinks.canonicalSkillName(requested);
  // Referential integrity: a skill still attached to agents cannot be
  // deleted. This funnel is the agentic delete_skill tool's target
  // (/api/ai-marketplace/delete-local-skill); fail closed on inventory
  // outages like the rest of the guard's callers. Inject this module's own
  // collaborators so scoped test DI applies to the guard too.
  await agentSkillUsageGuard.assertSkillDeletable({
    leafName: canonicalName,
    invokeMcpTool: (...args) => dockerMcp.invokeMcpTool(...args),
  });
  if (parts.length === 1) {
    const systemPath = path.join(bootstrap.PROJECT_ROOT, "skills", canonicalName);
    try {
      const stat = await fsPromises.lstat(systemPath);
      if (stat.isDirectory()) {
        throw lifecycleError(
          "System skills cannot be deleted.",
          "system_skill_read_only",
        );
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const userPath = path.join(
      bootstrap.PROJECT_ROOT,
      "skills-user",
      canonicalName,
    );
    try {
      const stat = await fsPromises.lstat(userPath);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw lifecycleError(
          "Could not safely verify the local user skill directory.",
          "local_provenance_invalid",
        );
      }
      const displayName = await localSkillDisplayName(userPath, canonicalName);
      await fsPromises.rm(userPath, { recursive: true, force: true });
      await aiMarketplaceSkillLinks.clearLink(canonicalName);
      return {
        success: true,
        skill_id: canonicalName,
        display_name: displayName,
        source: "user",
        marketplace_relationship: null,
        remote_solution_deleted: false,
      };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const snapshot = await getSkillProvenanceSnapshot();
  const installed = snapshot.installed_skills.find((entry) => {
    if (parts.length === 2) {
      return (
        entry.marketplace_id === parts[0] &&
        entry.skill_id === parts[1]
      );
    }
    return entry.skill_id === canonicalName;
  });
  if (!installed?.marketplace_id || !installed?.skill_id) {
    throw lifecycleError(
      `Skill "${requested}" was not found locally.`,
      "skill_not_found",
    );
  }
  const installedDisplayName = await localSkillDisplayName(
    installed.local_path
      ? path.resolve(bootstrap.PROJECT_ROOT, installed.local_path)
      : path.join(
          bootstrap.PROJECT_ROOT,
          "skills-marketplace",
          installed.marketplace_id,
          installed.skill_id,
        ),
    aiMarketplaceSkillLinks.canonicalSkillName(installed.skill_id),
  );
  await marketplaceService.uninstallMarketplaceSkill({
    projectRoot: bootstrap.PROJECT_ROOT,
    marketplaceId: installed.marketplace_id,
    skillId: installed.skill_id,
    logger: console,
  });
  await aiMarketplaceSkillLinks.clearLink(canonicalName);
  return {
    success: true,
    skill_id: `${installed.marketplace_id}/${installed.skill_id}`,
    display_name: installedDisplayName,
    source: "marketplace",
    marketplace_relationship: "installed",
    marketplace_solution_id: installed.marketplace_solution_id,
    remote_solution_deleted: false,
  };
}

async function clearDeletedAgentLink(agentId) {
  const id = String(agentId || "").trim();
  if (!id) {
    throw lifecycleError("agent_id is required", "invalid_argument");
  }
  const removed = await aiMarketplaceAgentLinks.clearLink(id);
  return {
    success: true,
    local_agent_id: id,
    link_removed: removed,
    remote_solution_deleted: false,
  };
}

function isSkillSolutionType(type) {
  return type === TYPE_SKILL || type === TYPE_SKILLS;
}

async function installGuardedSkillDependency({
  expectedSkillId,
  parentSolutionId,
  solutionId,
  viewerEmail,
  refreshDependencies = false,
}) {
  const id = normalizeSolutionId(solutionId);
  if (id === parentSolutionId) {
    throw taggedError(
      "Marketplace solution contains a cyclic skill dependency.",
      "skill_dependency_cycle",
    );
  }
  const bundle = await aiMarketplaceClient.getSolutionBundle(id, { viewerEmail });
  if (!isSkillSolutionType(bundle?.type)) {
    throw taggedError(
      "Marketplace skill reference does not resolve to a skill bundle.",
      "skill_dependency_type_mismatch",
    );
  }
  const bundleId = marketplaceSkillIdFromBundle(bundle);
  const expectedId = aiMarketplaceInstall.sanitizeId(
    aiMarketplaceSkillLinks.canonicalSkillName(expectedSkillId),
  );
  if (!expectedId || expectedId === "." || expectedId === ".." || expectedId !== bundleId) {
    throw taggedError(
      "Marketplace skill reference does not match its bundle.",
      "skill_dependency_id_mismatch",
    );
  }
  const solution = await aiMarketplaceClient.getSolution(id, { viewerEmail });
  const provenance = await inspectSkillProvenance(bootstrap.PROJECT_ROOT, id);
  const reusable = uniqueReusableSkillMatch(provenance, id);
  const destination = await inspectMarketplaceSkillDestination(
    bootstrap.PROJECT_ROOT,
    bundleId,
  );
  if (reusable) {
    // Agent Update: refresh a stale installed copy in place — but only when
    // it is PROVABLY safe. Never the viewer's own published copy (kind
    // "published"), never on an upstream rename (identity/path guard),
    // never without a clean sha256 baseline (fail closed), and a refresh
    // error degrades to plain reuse (a network blip must not fail a
    // locally usable dependency).
    let refreshed = false;
    let refreshSkipped = null;
    if (refreshDependencies && reusable.kind === "installed") {
      const record = reusable.record || {};
      const identityHolds =
        reusable.skillId === bundleId &&
        typeof record.localPath === "string" &&
        typeof reusable.expectedLocalPath === "string" &&
        path.normalize(record.localPath) ===
          path.normalize(reusable.expectedLocalPath);
      const stale = marketplaceService.remoteTimestampIsNewer(
        solutionFreshnessStamp(solution),
        record.remoteUpdatedAt ?? null,
      );
      if (identityHolds && stale) {
        try {
          const hasBaseline =
            Array.isArray(record?.baseline?.files) &&
            record.baseline.files.length > 0;
          const state = hasBaseline
            ? await marketplaceService.computeInstalledSkillState(
                bootstrap.PROJECT_ROOT,
                record,
              )
            : { isDirty: true };
          if (!hasBaseline) {
            refreshSkipped = "no-baseline";
          } else if (state.isDirty) {
            refreshSkipped = "dirty";
          } else {
            await aiMarketplaceInstall.install({
              bundle,
              deps: {
                projectRoot: bootstrap.PROJECT_ROOT,
                solutionId: id,
                solution,
              },
            });
            refreshed = true;
          }
        } catch (error) {
          refreshSkipped = "refresh-failed";
          logMarketplaceDiag(
            "install",
            "guarded-dep:refresh-failed",
            { solutionId: id, ...safeErrorMeta(error) },
            "warn",
          );
        }
      }
    }
    logMarketplaceDiag("install", "guarded-dep:outcome", {
      solutionId: id,
      outcome: refreshed ? "refreshed" : "reused",
      refreshSkipped: refreshSkipped || undefined,
      localSkillId: reusable.localSkillId,
    });
    return {
      id: bundleId,
      localSkillId: reusable.localSkillId,
      installedPath: reusable.installedPath,
      newlyInstalled: false,
      rollbackOnParentFailure: false,
      refreshed,
      refreshSkipped,
    };
  }
  if (destination) {
    throw taggedError(
      "A different local skill already occupies this marketplace install target.",
      "skill_install_target_conflict",
    );
  }
  const installed = await aiMarketplaceInstall.install({
    bundle,
    deps: {
      projectRoot: bootstrap.PROJECT_ROOT,
      solutionId: id,
      solution,
    },
  });
  logMarketplaceDiag("install", "guarded-dep:outcome", {
    solutionId: id,
    outcome: "fresh-install",
    localSkillId: `${AI_MARKETPLACE_SKILL_SOURCE_ID}/${installed.id}`,
  });
  return {
    ...installed,
    localSkillId: `${AI_MARKETPLACE_SKILL_SOURCE_ID}/${installed.id}`,
    newlyInstalled: true,
    // The top-level install holds the global lock until parent success or
    // rollback, so a fresh dependency cannot be adopted concurrently.
    rollbackOnParentFailure: true,
  };
}

// Resolves a fully-qualified git-marketplace skill ref on THIS machine:
// match the marketplace by durable repository identity, auto-add it when
// absent (policy: automatic — the install result enumerates additions), then
// reuse or install the skill. Never rebinds an existing marketplace id to a
// different source (spoof guard).
async function installGitMarketplaceSkillDependency({
  ref,
  interactiveAuth = false,
  addedMarketplaces = [],
  refreshDependencies = false,
}) {
  const projectRoot = bootstrap.PROJECT_ROOT;
  const wanted = marketplaceService.normalizeMarketplaceSourceInput(
    ref.marketplace.source,
  );
  let config = await marketplaceService.loadMarketplacesConfig(projectRoot, {
    logger: console,
  });
  let marketplace = (config.marketplaces || []).find((entry) =>
    marketplaceService.isSameRepositorySource(entry.source, wanted),
  );
  if (
    marketplace &&
    wanted.ref &&
    marketplace.source?.ref &&
    marketplace.source.ref !== wanted.ref
  ) {
    console.warn(
      `[Marketplace] agent dependency "${ref.skill_id}" pins ref "${wanted.ref}" but local marketplace "${marketplace.id}" tracks "${marketplace.source.ref}"; reusing the local marketplace.`,
    );
  }
  if (!marketplace) {
    try {
      marketplace = await marketplaceService.addMarketplace({
        projectRoot,
        sourceInput: ref.marketplace.source,
        interactiveAuth,
        logger: console,
      });
      logMarketplaceDiag("install", "git-dep:marketplace-added", {
        skillId: ref.skill_id,
        marketplaceId: marketplace.id,
        sourceType: ref.marketplace.source?.type || "",
      });
      addedMarketplaces.push({
        id: marketplace.id,
        name: marketplace.name || marketplace.id,
      });
      config = await marketplaceService.loadMarketplacesConfig(projectRoot, {
        logger: console,
      });
    } catch (error) {
      logMarketplaceDiag(
        "install",
        "git-dep:marketplace-add-failed",
        { skillId: ref.skill_id, ...safeErrorMeta(error) },
        "error",
      );
      if (error?.code === "duplicate_marketplace") {
        // Same manifest-derived id, different source: never rebind.
        throw taggedError(
          `A different local marketplace already uses the id this agent's skill "${ref.skill_id}" resolves to; remove or rename it, then reinstall the agent.`,
          "marketplace_identity_conflict",
        );
      }
      throw error; // includes gitlab_auth_required from headless GitLab sources
    }
  }
  const skillId = aiMarketplaceSkillLinks.canonicalSkillName(ref.skill_id);
  const refSkillId = String(ref.skill_id || "").trim().replace(/\\/g, "/");
  const normalizeRefPath = (value) =>
    String(value || "")
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/\/+$/g, "");
  const recordFqn = (entry) =>
    entry?.pluginName
      ? `${marketplace.id}/${entry.pluginName}/${entry.skillId}`
      : `${marketplace.id}/${entry.skillId}`;
  // Match the installed record by ref.skill_path first (survives renames and
  // layout migrations), then the fully-qualified id, then the unique leaf.
  const marketplaceRecords = (config.installedSkills || []).filter(
    (entry) => entry.marketplaceId === marketplace.id,
  );
  const refSkillPath = ref.skill_path ? normalizeRefPath(ref.skill_path) : "";
  let existing =
    (refSkillPath &&
      marketplaceRecords.find(
        (entry) => normalizeRefPath(entry.skillPath) === refSkillPath,
      )) ||
    marketplaceRecords.find((entry) => recordFqn(entry) === refSkillId) ||
    null;
  if (!existing) {
    const leafMatches = marketplaceRecords.filter(
      (entry) =>
        aiMarketplaceSkillLinks.canonicalSkillName(entry.skillId) === skillId,
    );
    if (leafMatches.length === 1) {
      existing = leafMatches[0];
    }
  }
  if (existing) {
    // Agent Update: pull the newer remote version in place when the local
    // copy is provably clean. updateMarketplaceSkill has no "already
    // current" signal, so staleness is decided here first; its dirty gate
    // fails closed, and any other refresh error degrades to plain reuse
    // (offline must not fail a locally usable dependency).
    let refreshed = false;
    let refreshSkipped = null;
    if (refreshDependencies) {
      try {
        const remoteSource = marketplaceService.resolveRemoteSkillSource(
          existing.skillSource,
          marketplace.source,
        );
        const remoteVersion = await marketplaceService.fetchRemoteSkillVersion(
          remoteSource,
          existing.skillPath,
        );
        if (
          remoteVersion &&
          marketplaceService.hasNewerVersion(existing.installedVersion, remoteVersion)
        ) {
          await marketplaceService.updateMarketplaceSkill({
            projectRoot,
            marketplaceId: marketplace.id,
            skillId: existing.skillId,
            pluginName: existing.pluginName || null,
            interactiveAuth,
            logger: console,
          });
          refreshed = true;
        }
      } catch (error) {
        refreshSkipped =
          error?.code === "marketplace_skill_dirty" ? "dirty" : "refresh-failed";
        logMarketplaceDiag(
          "install",
          "git-dep:refresh-skipped",
          { skillId, marketplaceId: marketplace.id, reason: refreshSkipped, ...safeErrorMeta(error) },
          "warn",
        );
      }
    }
    logMarketplaceDiag("install", "git-dep:outcome", {
      skillId,
      marketplaceId: marketplace.id,
      outcome: refreshed ? "refreshed" : "reused-installed",
      refreshSkipped: refreshSkipped || undefined,
    });
    return {
      id: skillId,
      localSkillId: recordFqn(existing),
      installedPath: existing.localPath,
      newlyInstalled: false,
      rollbackOnParentFailure: false,
      refreshed,
      refreshSkipped,
    };
  }
  let skillPath = ref.skill_path || null;
  let pluginName =
    typeof ref.plugin_name === "string" && ref.plugin_name.trim()
      ? ref.plugin_name.trim()
      : null;
  if (!skillPath || !pluginName) {
    // Resolve the catalog entry to fill the missing pieces: skill_path first
    // (rename/migration safe), then FQN, then unique leaf. A catalog error
    // with a usable skill_path degrades to a flat install (legacy behavior).
    try {
      const { skills } = await marketplaceService.getMarketplaceSkills({
        projectRoot,
        marketplaceId: marketplace.id,
        interactiveAuth,
        logger: console,
      });
      const catalogFqn = (entry) =>
        entry.pluginName
          ? `${marketplace.id}/${entry.pluginName}/${entry.id}`
          : `${marketplace.id}/${entry.id}`;
      const leafMatches = (skills || []).filter((entry) => entry.id === skillId);
      const found =
        (refSkillPath &&
          (skills || []).find(
            (entry) => normalizeRefPath(entry.skillPath) === refSkillPath,
          )) ||
        (skills || []).find((entry) => catalogFqn(entry) === refSkillId) ||
        (leafMatches.length === 1 ? leafMatches[0] : null);
      if (found) {
        skillPath = skillPath || found.skillPath;
        if (!pluginName) {
          pluginName = found.pluginName || null;
        }
      } else if (!skillPath) {
        throw taggedError(
          `Skill "${skillId}" was not found in marketplace "${marketplace.id}".`,
          "skill_not_in_marketplace",
        );
      }
    } catch (error) {
      if (!skillPath) {
        throw error;
      }
      logMarketplaceDiag(
        "install",
        "git-dep:catalog-lookup-skipped",
        { skillId, marketplaceId: marketplace.id, ...safeErrorMeta(error) },
        "warn",
      );
    }
  }
  const installed = await marketplaceService.installMarketplaceSkill({
    projectRoot,
    marketplaceId: marketplace.id,
    skillId,
    skillPath,
    skillSource: ref.skill_source || null,
    pluginName,
    interactiveAuth,
    logger: console,
  });
  const localSkillId = pluginName
    ? `${marketplace.id}/${pluginName}/${skillId}`
    : `${marketplace.id}/${skillId}`;
  logMarketplaceDiag("install", "git-dep:outcome", {
    skillId,
    marketplaceId: marketplace.id,
    pluginName: pluginName || undefined,
    outcome: "installed",
  });
  return {
    id: skillId,
    localSkillId,
    installedPath: installed.localPath,
    newlyInstalled: true,
    rollbackOnParentFailure: true,
  };
}

async function install(id, options = {}) {
  const solutionId = normalizeSolutionId(id);
  return await withMarketplaceInstallLock(async () => {
    const viewerEmail = await resolveViewerIdentity();
    // Keep the availability gate first: unavailable solutions must fail before
    // inventory, provenance, or local mutation (PORTICO-272).
    const bundle = await getBundle(solutionId, {
      interactiveAuth: options?.interactiveAuth === true,
    });
    const solution = await getSolution(solutionId);
    const expectedType =
      typeof options?.expectedType === "string" && options.expectedType.trim()
        ? normalizeMarketplaceSolutionType(options.expectedType)
        : null;
    assertSolutionType(bundle, expectedType);
    assertSolutionType(solution, expectedType || bundle?.type);
    if (!solutionTypeMatches(solution?.type, bundle?.type)) {
      throw lifecycleError(
        "Marketplace solution metadata and bundle types do not agree.",
        "solution_type_mismatch",
        {
          body: {
            solution_id: solutionId,
            solution_type: solution?.type || null,
            bundle_type: bundle?.type || null,
          },
        },
      );
    }
    const [knownAgentIds, knownSkillIds, knownToolServerIds] = await Promise.all([
      fetchKnownAgentIds(),
      fetchKnownSkillIds(),
      fetchKnownToolServerIds(),
    ]);
    const existingAgentId =
      typeof options?.existingAgentId === "string"
        ? options.existingAgentId.trim()
        : "";
    const refreshInstalledSkillId =
      typeof options?.refreshInstalledSkillId === "string"
        ? options.refreshInstalledSkillId.trim()
        : "";

    if (bundle?.type === TYPE_AGENT) {
      await assertAgentInstallAllowed({
        solutionId,
        existingAgentId,
        knownAgentIds,
      });
    } else if (isSkillSolutionType(bundle?.type)) {
      await assertTopLevelSkillInstallAllowed({
        bundle,
        projectRoot: bootstrap.PROJECT_ROOT,
        refreshInstalledSkillId,
        solutionId,
      });
    } else {
      throw lifecycleError(
        `Marketplace solution type "${bundle?.type || "unknown"}" is not installable by the Agents or Skills tools.`,
        "solution_type_mismatch",
      );
    }

    const addedMarketplaces = [];
    const interactiveAuth = options?.interactiveAuth === true;
    // Agent Update (existingAgentId set) also refreshes stale, provably
    // clean installed dependent skills; fresh installs never do.
    const refreshDependencies = Boolean(existingAgentId);
    // FULL rollback on failure: marketplaces auto-added by THIS install are
    // removed with the skills (addedMarketplaces only ever records this run's
    // additions — pre-existing marketplaces never enter the list). A removal
    // error must not mask the install error; that marketplace reports "kept".
    const rollbackAddedMarketplaces = async () => {
      const outcomes = [];
      for (const added of addedMarketplaces) {
        try {
          await marketplaceService.removeMarketplace({
            projectRoot: bootstrap.PROJECT_ROOT,
            marketplaceId: added.id,
          });
          outcomes.push({ id: added.id, name: added.name || "", outcome: "removed" });
        } catch (removeError) {
          logMarketplaceDiag(
            "install",
            "rollback:marketplace-remove-failed",
            { marketplaceId: added.id, ...safeErrorMeta(removeError) },
            "warn",
          );
          outcomes.push({ id: added.id, name: added.name || "", outcome: "kept" });
        }
      }
      if (outcomes.length) {
        logMarketplaceDiag(
          "install",
          "rollback:marketplaces",
          { outcomes },
          "error",
        );
      }
      return outcomes;
    };
    let result;
    try {
      result = await aiMarketplaceInstall.install({
        bundle,
        deps: {
          invokeMcpTool: dockerMcp.invokeMcpTool,
          projectRoot: bootstrap.PROJECT_ROOT,
          knownAgentIds,
          knownSkillIds,
          knownToolServerIds,
          existingAgentId,
          solutionId,
          solution,
          // Live per-dependency progress for install UIs; emissions are
          // guarded downstream and the headless HTTP route passes nothing.
          onProgress:
            typeof options?.onProgress === "function" ? options.onProgress : null,
          installSkillDependency: (request) =>
            installGuardedSkillDependency({
              ...request,
              parentSolutionId: solutionId,
              viewerEmail,
              refreshDependencies,
            }),
          installGitSkillDependency: (request) =>
            installGitMarketplaceSkillDependency({
              ...request,
              interactiveAuth,
              addedMarketplaces,
              refreshDependencies,
            }),
          fetchSolutionBundle: (sid) =>
            aiMarketplaceClient.getSolutionBundle(sid, { viewerEmail }),
          fetchSolution: (sid) =>
            aiMarketplaceClient.getSolution(sid, { viewerEmail }),
        },
      });
    } catch (error) {
      if (addedMarketplaces.length) {
        const outcomes = await rollbackAddedMarketplaces();
        error.body = {
          ...(error && typeof error.body === "object" ? error.body : {}),
          addedMarketplaces: outcomes,
        };
      }
      throw error;
    }
    if (addedMarketplaces.length && result && typeof result === "object") {
      result.addedMarketplaces = addedMarketplaces;
    }
    // Record the listing's freshness baseline on the (re)installed agent's
    // link so update-available checks compare the marketplace's clock to
    // itself, never to the local clock. Best-effort: baseline loss only means
    // the next session check re-backfills silently.
    if (bundle?.type === TYPE_AGENT) {
      const linkedAgentId = String(
        result?.created?.id || existingAgentId || "",
      ).trim();
      const remoteUpdatedAt = solutionFreshnessStamp(solution);
      if (linkedAgentId && remoteUpdatedAt !== null && remoteUpdatedAt !== undefined) {
        try {
          await aiMarketplaceAgentLinks.setLinkRemoteUpdatedAt(
            linkedAgentId,
            remoteUpdatedAt,
          );
          logMarketplaceDiag("install", "baseline:stamped", {
            agentId: linkedAgentId,
            remoteUpdatedAt: String(remoteUpdatedAt),
          });
        } catch (error) {
          console.warn(
            "[Marketplace] could not record the listing freshness baseline:",
            error?.message || error,
          );
        }
      }
    }
    return result;
  });
}

// ---- writes (low-level) -----------------------------------------------------

// The marketplace validator requires `author` on every solution write. The
// control-plane renderer supplies it explicitly; agentic (main-process)
// callers have no renderer `whoami`, so default it from the authenticated
// viewer identity's owner form — the same value ownership matching uses.
// author_display_name is a cosmetic extra field (Okta full name) the read
// surfaces prefer over the ldap; the backend has no display-name concept of
// its own and simply round-trips it. Never used for ownership matching.
function withMarketplaceWriteIdentity(input, submittedBy, authorDisplayName = "") {
  const providedAuthor = typeof input?.author === "string" ? input.author.trim() : "";
  const author =
    providedAuthor || normalizeMarketplaceOwnerIdentity(submittedBy) || submittedBy;
  const providedDisplayName =
    typeof input?.author_display_name === "string" ? input.author_display_name.trim() : "";
  const displayName =
    providedDisplayName ||
    (typeof authorDisplayName === "string" ? authorDisplayName.trim() : "");
  return {
    ...(input || {}),
    author,
    submitted_by: submittedBy,
    ...(displayName ? { author_display_name: displayName } : {}),
  };
}

// Same listing link the control-plane publish path sends (agents.js).
function marketplaceDetailUrlForType(type) {
  return `https://solutions.sandbox.example.invalid/?type=${encodeURIComponent(type || "")}`;
}

// Publish a prepared solution (type + payload) with a single create — the
// backend persists the bundle on POST (MISC-34; the response strips the blob
// but reports has_bundle). PUT is reserved for true updates. Returns
// { data, publishStatus }.
async function publishSolution(
  solutionInput,
  {
    localAgentId = "",
    localSkillId = "",
    provenanceChecked = false,
    aclAudience,
  } = {},
) {
  const normalizedType = normalizeMarketplaceSolutionType(solutionInput?.type);
  if (!provenanceChecked && normalizedType === TYPE_AGENT) {
    if (!localAgentId) {
      throw lifecycleError(
        "Publishing an agent requires an editable local agent id.",
        "local_artifact_required",
      );
    }
    await getAgentForPublish(localAgentId);
  } else if (!provenanceChecked && isSkillSolutionType(normalizedType)) {
    if (!localSkillId) {
      throw lifecycleError(
        "Publishing a skill requires an editable local user skill id.",
        "local_artifact_required",
      );
    }
    await getSkillForPublish(localSkillId);
  }
  await assertMarketplaceSolutionNameAvailable(solutionInput?.name, normalizedType);
  if (localAgentId) {
    // Repair a legacy unlinked null creator before the new published link makes
    // that model ineligible for the general local backfill policy.
    await reconcilePublishedAgentAttribution(localAgentId, {
      rejectMissingCreator: true,
    });
  }
  const apiKey = await requireApiKey();
  const { submittedBy, displayName } = await requireViewerIdentityWithDisplayName();
  let effectiveInput = solutionInput;
  if (effectiveInput && effectiveInput.allowed_emails === undefined) {
    // Creates pin visibility explicitly: dependent skills inherit the
    // publishing agent's audience (ai-marketplace-acl.js); no audience means
    // public, which is also the backend default for an omitted field.
    const { allowedEmails } = aiMarketplaceAcl.computeEffectiveAllowedEmails({
      currentAllowedEmails: null,
      audiences: [Array.isArray(aclAudience) ? aclAudience : null],
    });
    effectiveInput = { ...effectiveInput, allowed_emails: allowedEmails };
  }
  const data = await aiMarketplaceClient.createSolution(
    withMarketplaceWriteIdentity(effectiveInput, submittedBy, displayName),
    { apiKey },
  );
  const newSolutionId = getSolutionResponseId(data);
  const publishStatus = assertMarketplaceWriteAccepted(data, newSolutionId);
  // Fail closed if the backend ever regresses to the old allocate-then-PUT
  // contract: a bundle publish whose create reports has_bundle:false would
  // otherwise produce a listing that installs into no_bundle. Absent/null
  // has_bundle passes — older backends and fixtures omit the field.
  if (solutionInput?.bundle && publishStatus.has_bundle === false) {
    throw taggedError(
      "AI Marketplace create did not persist the solution bundle.",
      "marketplace_create_dropped_bundle",
      { body: { publishStatus } },
    );
  }
  const resolvedSolutionId = publishStatus.id || newSolutionId;
  if (localAgentId && resolvedSolutionId) {
    await aiMarketplaceAgentLinks.setPublishedLink(
      localAgentId,
      resolvedSolutionId,
      submittedBy,
    );
    await reconcilePublishedAgentAttribution(localAgentId, {
      rejectSkipped: true,
    });
  }
  logMarketplaceDiag("publish", "solution:published", {
    solutionId: resolvedSolutionId,
    localAgentId: localAgentId || "",
    status: publishStatus?.status || "",
  });
  return { data, publishStatus };
}

async function updatePublishedSolution(
  id,
  patch,
  {
    localAgentId = "",
    localSkillId = "",
    provenanceChecked = false,
    aclAudience,
  } = {},
) {
  if (!id) throw taggedError("updatePublishedSolution: id is required", "invalid_argument");
  const requestedType = normalizeMarketplaceSolutionType(patch?.type);
  const ownedSolution = await getOwnedSolutionForWrite(id, {
    expectedType: requestedType || undefined,
  });
  const solutionType = normalizeMarketplaceSolutionType(ownedSolution?.type);
  if (!provenanceChecked && solutionType === TYPE_AGENT) {
    if (!localAgentId) {
      throw lifecycleError(
        "Republishing an agent requires its editable local agent id.",
        "local_artifact_required",
      );
    }
    // ownedSolution dedupes the assert pipeline's second GET + search pair —
    // this function already proved ownership of the exact same id above.
    await getAgentForPublish(localAgentId, {
      existingSolutionId: id,
      ownedSolution,
    });
  } else if (!provenanceChecked && isSkillSolutionType(solutionType)) {
    if (!localSkillId) {
      throw lifecycleError(
        "Republishing a skill requires its editable local user skill id.",
        "local_artifact_required",
      );
    }
    await getSkillForPublish(localSkillId, {
      existingSolutionId: id,
      ownedSolution,
    });
  } else if (!provenanceChecked) {
    throw lifecycleError(
      `Marketplace solution type "${ownedSolution?.type || "unknown"}" cannot be republished by the Agents or Skills tools.`,
      "solution_type_mismatch",
    );
  }
  if (localAgentId) {
    await reconcilePublishedAgentAttribution(localAgentId, {
      rejectMissingCreator: true,
    });
  }
  const apiKey = await requireApiKey();
  const { submittedBy, displayName } = await requireViewerIdentityWithDisplayName();
  let effectivePatch = patch;
  if (effectivePatch && effectivePatch.allowed_emails === undefined) {
    // PUTs pin allowed_emails explicitly. The backend preserves an omitted
    // field today, but dependent-skill updates must widen the listing to the
    // publishing agent's audience (widening-only union, public absorbs — see
    // ai-marketplace-acl.js), and implicit preservation is fragile against
    // bulk/upsert semantics. A patch that carries the field (the agent's own
    // listing update) passes through verbatim.
    const { allowedEmails } = aiMarketplaceAcl.computeEffectiveAllowedEmails({
      currentAllowedEmails: Array.isArray(ownedSolution?.allowed_emails)
        ? ownedSolution.allowed_emails
        : [],
      audiences: [Array.isArray(aclAudience) ? aclAudience : null],
    });
    effectivePatch = { ...effectivePatch, allowed_emails: allowedEmails };
  }
  // Full-replace PUT carrying the whole bundle: idempotent (safe to retry
  // after an ambiguous timeout) and slow under marketplace indexing load, so
  // it gets a longer per-attempt budget than the 30s read default.
  const data = await aiMarketplaceClient.updateSolution(
    id,
    withMarketplaceWriteIdentity(effectivePatch, submittedBy, displayName),
    { apiKey, retryable: true, timeoutMs: 60_000 },
  );
  const publishStatus = assertMarketplaceWriteAccepted(data, id);
  if (localAgentId) {
    await aiMarketplaceAgentLinks.setPublishedLink(localAgentId, id, submittedBy);
    await reconcilePublishedAgentAttribution(localAgentId, {
      rejectSkipped: true,
    });
  }
  logMarketplaceDiag("publish", "solution:updated", {
    solutionId: id,
    localAgentId: localAgentId || "",
    status: publishStatus?.status || "",
  });
  return { data, publishStatus };
}

// One-shot owner-scoped preflight for the publish modal: liveness + ACL drift
// for the dependent skill listings a publish will reference or update. This is
// the SAME per-listing GET the submit-time liveness wave used to make, moved
// to modal-open — callers reuse its result instead of probing twice. Read-only.
async function preflightDependentSkillListings({
  solutionIds = [],
  aclAudience = null,
} = {}) {
  const ids = [
    ...new Set(
      (Array.isArray(solutionIds) ? solutionIds : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  ];
  const audience = Array.isArray(aclAudience) ? aclAudience : null;
  const listings = await Promise.all(
    ids.map(async (solutionId) => {
      try {
        const solution = await getSolution(solutionId);
        const status = String(solution?.status || "").trim().toLowerCase();
        if (!solution || status === "deleted") {
          return { solution_id: solutionId, state: "deleted" };
        }
        const currentAllowedEmails = Array.isArray(solution.allowed_emails)
          ? solution.allowed_emails
          : [];
        const { allowedEmails, changed } =
          aiMarketplaceAcl.computeEffectiveAllowedEmails({
            currentAllowedEmails,
            audiences: [audience],
          });
        return {
          solution_id: solutionId,
          state: "alive",
          allowed_emails: currentAllowedEmails,
          submitted_by: String(solution.submitted_by || solution.author || ""),
          display_name: String(solution.display_name || ""),
          acl_sync: { allowed_emails: allowedEmails, changed },
        };
      } catch (error) {
        const code = String(error?.code || "").trim();
        const positivelyGone =
          code === "not_found" ||
          code === "solution_not_found" ||
          error?.status === 404;
        return {
          solution_id: solutionId,
          state: positivelyGone ? "deleted" : "unknown",
        };
      }
    }),
  );
  logMarketplaceDiag("publish", "preflight:listings", {
    requested: ids.length,
    aliveCount: listings.filter((entry) => entry.state === "alive").length,
    deletedIds: listings
      .filter((entry) => entry.state === "deleted")
      .map((entry) => entry.solution_id),
    unknownIds: listings
      .filter((entry) => entry.state === "unknown")
      .map((entry) => entry.solution_id),
    aclDriftIds: listings
      .filter((entry) => entry.acl_sync?.changed)
      .map((entry) => entry.solution_id),
  });
  return { listings };
}

// Viewer-scoped visibility probe for the install modal: which of these pinned
// listings can THIS viewer actually fetch? The backend deliberately conflates
// hidden and deleted (404 either way), so "unavailable" is the strongest
// truthful state; callers word their copy accordingly. Read-only, one-shot.
async function probeInstallRefVisibility({ solutionIds = [] } = {}) {
  const ids = [
    ...new Set(
      (Array.isArray(solutionIds) ? solutionIds : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  ];
  const listings = await Promise.all(
    ids.map(async (solutionId) => {
      try {
        const solution = await getSolution(solutionId);
        const status = String(solution?.status || "").trim().toLowerCase();
        if (!solution || status === "deleted") {
          return { solution_id: solutionId, state: "unavailable" };
        }
        return {
          solution_id: solutionId,
          state: "visible",
          submitted_by: String(solution.submitted_by || solution.author || ""),
          display_name: String(solution.display_name || ""),
        };
      } catch (error) {
        const code = String(error?.code || "").trim();
        const positivelyGone =
          code === "not_found" ||
          code === "solution_not_found" ||
          error?.status === 404;
        return {
          solution_id: solutionId,
          state: positivelyGone ? "unavailable" : "unknown",
        };
      }
    }),
  );
  logMarketplaceDiag("install", "probe:visibility", {
    requested: ids.length,
    unavailableIds: listings
      .filter((entry) => entry.state === "unavailable")
      .map((entry) => entry.solution_id),
    unknownIds: listings
      .filter((entry) => entry.state === "unknown")
      .map((entry) => entry.solution_id),
  });
  return { listings };
}

// Visibility-only write for dependent skills whose content is already up to
// date ("reference" plans): widen the listing's allowed_emails to the
// publishing agent's audience without re-uploading the bundle. No-op when the
// union changes nothing. Ownership-gated like every write.
async function syncSolutionAclForAudience(
  solutionId,
  { aclAudience = null, localSkillId = "" } = {},
) {
  const id = normalizeSolutionId(solutionId);
  const ownedSolution = await getOwnedSolutionForWrite(id);
  const { allowedEmails, changed } =
    aiMarketplaceAcl.computeEffectiveAllowedEmails({
      currentAllowedEmails: Array.isArray(ownedSolution?.allowed_emails)
        ? ownedSolution.allowed_emails
        : [],
      audiences: [Array.isArray(aclAudience) ? aclAudience : null],
    });
  if (!changed) {
    return { changed: false, allowed_emails: allowedEmails, solution_id: id };
  }
  const apiKey = await requireApiKey();
  const submittedBy = await requireViewerIdentity();
  // Minimal-patch contract verified against the live backend (2026-08-03):
  // {allowed_emails, submitted_by, author} PUTs cleanly and every other field
  // — including the bundle — is preserved server-side.
  const data = await aiMarketplaceClient.updateSolution(
    id,
    withMarketplaceWriteIdentity({ allowed_emails: allowedEmails }, submittedBy),
    // Idempotent ACL pin: retrying after a timeout re-sends the same set.
    { apiKey, retryable: true },
  );
  assertMarketplaceWriteAccepted(data, id);
  logMarketplaceDiag("publish", "acl:synced", {
    solutionId: id,
    localSkillId: localSkillId || "",
    allowed_emails: allowedEmails,
  });
  return { changed: true, allowed_emails: allowedEmails, solution_id: id };
}

async function deletePublishedSolution(
  id,
  { expectedType = "", ownershipChecked = false, ownedSolutionType = "" } = {},
) {
  if (!id) throw taggedError("deletePublishedSolution: id is required", "invalid_argument");
  let solutionType = ownedSolutionType;
  if (!ownershipChecked) {
    const owned = await getOwnedSolutionForWrite(id, {
      expectedType: expectedType || undefined,
    });
    solutionType = solutionType || owned?.type || "";
  }
  // Validate the app-owned registry before the remote delete so corruption
  // cannot leave an unpublish half-applied with stale local provenance.
  await aiMarketplaceAgentLinks.readStateStrict();
  // Referential integrity: a skill listing that locally-published agents
  // depend on cannot be unpublished — new installations of those agents
  // would break. Runs before the remote delete; covers the renderer IPC,
  // the HTTP unpublish route, and both agentic unpublish tools. This
  // module's own collaborators are injected so scoped test DI applies.
  await agentSkillUsageGuard.assertSolutionUnpublishable({
    solutionId: id,
    solutionType: solutionType || expectedType,
    invokeMcpTool: (...args) => dockerMcp.invokeMcpTool(...args),
    registries: {
      skillLinks: aiMarketplaceSkillLinks,
      agentLinks: aiMarketplaceAgentLinks,
    },
  });
  // Marketplace-wide twin: ANY author's published agent referencing this
  // skill listing blocks the unpublish (the local guard only sees the
  // viewer's own agents). Skill listings only; runs exactly once per
  // explicit unpublish; fail-closed when the sweep cannot complete.
  await assertSolutionUnpublishableOnMarketplace(id, solutionType || expectedType);
  const apiKey = await requireApiKey();
  const submittedBy = await requireViewerIdentity();
  const data = await aiMarketplaceClient.deleteSolution(id, { apiKey, submittedBy });
  const clearedAgentIds = await aiMarketplaceAgentLinks.clearPublishedLinksBySolutionId(id);
  // Skills keep their own link registry (drives the control-plane "Published"
  // badge) — clear it too so a chat-side unpublish cannot strand a stale badge.
  let clearedSkillLinks = [];
  try {
    clearedSkillLinks = await aiMarketplaceSkillLinks.clearLinksBySolutionId(id);
  } catch (error) {
    console.warn("[Marketplace] Could not clear skill links for", id, error.message);
  }
  // The model metadata is the renderer's fallback source when no sidecar link
  // exists. Reconcile only after the published links are gone so the Rust
  // service removes relationship/solution metadata instead of restoring it.
  await reconcileUnpublishedAgentAttribution(clearedAgentIds, id);
  logMarketplaceDiag("publish", "solution:deleted", {
    solutionId: id,
    clearedAgentIds,
  });
  return { data, clearedAgentIds, clearedSkillLinks };
}

// ---- high-level: reclaim an installed copy of the viewer's own listing ------

// Convert a self-authored installed Marketplace copy into the author-side
// editable copy: flip its link installed→published (same solution), then run
// attribution reconciliation so the Rust service normalizes the model metas
// (creation_source "local", relationship "published"). Everything is
// re-validated here — renderer gating is advisory. Crash-safe: the link flip
// is the only durable mutation before reconcile, and a crash in between
// self-heals at the next startup reconciliation (published-linked +
// self-authored + source "marketplace" normalizes to local). No
// access_control repair is needed: reclaim never writes access_control, and
// the existing load-my-agents repair already covers all linked agents.
async function reclaimInstalledAgent(agentId) {
  const id = String(agentId || "").trim();
  if (!id) throw taggedError("agent_id is required", "invalid_argument");

  let linkState;
  try {
    linkState = await aiMarketplaceAgentLinks.readStateStrict();
  } catch (error) {
    throw localProvenanceError(error);
  }
  const link = linkState.links?.[id] || null;
  if (!link || normalizedRelationship(link.relationship) !== "installed") {
    throw lifecycleError(
      `Agent "${id}" is not an installed Marketplace copy.`,
      "marketplace_relationship_mismatch",
      {
        remediation:
          "Only an installed Marketplace copy of a listing you authored can be converted to an editable copy.",
        body: { local_agent_id: id, relationship: link?.relationship || null },
      },
    );
  }
  if (link.attributionPending === true) {
    throw lifecycleError(
      `Agent "${id}" has not finished install attribution.`,
      "marketplace_relationship_unknown",
      { body: { local_agent_id: id } },
    );
  }
  const solutionId = String(link.solutionId || "").trim();

  const agent = await invokeSubagentsTool("subagents_get_agent", { model_id: id });
  if (!agent || typeof agent !== "object") {
    throw taggedError(`Agent "${id}" was not found.`, "agent_not_found");
  }
  const viewerEmail = await assertCurrentViewerOwnsLocalArtifact(
    agent?.created_by_email,
    "agent",
    id,
  );

  await getOwnedSolutionForWrite(solutionId, { expectedType: TYPE_AGENT });

  const updatedLink = await aiMarketplaceAgentLinks.setPublishedLink(
    id,
    solutionId,
    viewerEmail,
  );

  await reconcilePublishedAgentAttribution(id, {
    rejectSkipped: true,
    rejectMissingCreator: true,
    requireConfirmed: true,
  });

  logMarketplaceDiag("reclaim", "agent:reclaimed", {
    agentId: id,
    solutionId,
  });
  return { local_agent_id: id, solution_id: solutionId, link: updatedLink };
}

// Convert a Solutions-Marketplace-installed skill copy the viewer authored
// into the editable user skill behind its listing: verify listing ownership
// server-side, detach the installed copy into skills-user (which resets the
// creator to the viewer and strips marketplace provenance, with rollback on
// failure), then link the detached user skill to the same solution so its
// Published state survives the move. The detached directory name may be
// suffixed on collision; the returned local_skill_id is authoritative.
async function reclaimInstalledSkill(skillId) {
  const requested = typeof skillId === "string" ? skillId.trim() : "";
  const bareSkillId = aiMarketplaceSkillLinks.canonicalSkillName(requested);
  if (!bareSkillId) {
    throw taggedError("skill_id is required", "invalid_argument");
  }
  let records;
  try {
    records = await readInstalledSkillRecordsStrict(bootstrap.PROJECT_ROOT);
  } catch (error) {
    throw localProvenanceError(error);
  }
  const record = records.find(
    (entry) =>
      entry?.marketplaceId === AI_MARKETPLACE_SKILL_SOURCE_ID &&
      aiMarketplaceSkillLinks.canonicalSkillName(entry?.skillId) === bareSkillId &&
      entry?.skillSource?.type === "ai-marketplace-solution" &&
      typeof entry?.skillSource?.solutionId === "string" &&
      entry.skillSource.solutionId.trim(),
  );
  if (!record) {
    throw lifecycleError(
      `Skill "${requested}" is not an installed Solutions Marketplace copy.`,
      "marketplace_relationship_mismatch",
      {
        remediation:
          "Only an installed Solutions Marketplace copy of a listing you authored can be converted to an editable skill.",
        body: { local_skill_id: requested },
      },
    );
  }
  const solutionId = record.skillSource.solutionId.trim();
  await getOwnedSolutionForWrite(solutionId, { expectedType: TYPE_SKILLS });
  const detached = await marketplaceService.detachMarketplaceSkillToUserSkill({
    projectRoot: bootstrap.PROJECT_ROOT,
    marketplaceId: AI_MARKETPLACE_SKILL_SOURCE_ID,
    skillId: record.skillId,
  });
  const finalName = String(detached?.skillName || bareSkillId).trim();
  // Link continuity: the detached user skill IS the listing's editable copy.
  await aiMarketplaceSkillLinks.setLink(finalName, solutionId);
  logMarketplaceDiag("reclaim", "skill:reclaimed", {
    skillId: bareSkillId,
    finalName,
    solutionId,
  });
  return {
    local_skill_id: finalName,
    display_name: await localSkillDisplayName(
      path.join(bootstrap.PROJECT_ROOT, "skills-user", finalName),
      finalName,
    ),
    solution_id: solutionId,
    previous_local_path: detached?.previousLocalPath || null,
  };
}

// ---- high-level: publish a local agent / skill ------------------------------

// Resolve a local skill id to its on-disk directory (relative to projectRoot).
async function resolveSkillDir(skillId) {
  const root = bootstrap.PROJECT_ROOT;
  const clean = String(skillId || "").trim();
  if (!clean) return null;
  const candidates = [
    path.join("skills", clean),
    path.join("skills-user", clean),
    // marketplace ids are "<marketplace>/<skill>"
    path.join("skills-marketplace", clean),
  ];
  for (const rel of candidates) {
    try {
      const stat = await fsPromises.stat(path.join(root, rel, "SKILL.md"));
      if (stat.isFile()) return rel;
    } catch {}
  }
  return null;
}

function normalizedRelationship(value) {
  const relationship = String(value || "").trim().toLowerCase();
  return ["published", "installed", "unknown"].includes(relationship)
    ? relationship
    : "";
}

async function assertCurrentViewerOwnsLocalArtifact(createdByEmail, kind, id) {
  const viewerEmail = await requireViewerIdentity();
  const viewer = normalizeMarketplaceOwnerIdentity(viewerEmail);
  const creator = normalizeMarketplaceOwnerIdentity(createdByEmail);
  if (!creator) {
    throw lifecycleError(
      `Could not establish authoritative creator attribution/provenance for ${kind} "${id}".`,
      "marketplace_relationship_unknown",
    );
  }
  if (creator !== viewer) {
    throw lifecycleError(
      `The current viewer does not own local ${kind} "${id}".`,
      "not_owner",
      { body: { local_id: id, created_by_email: createdByEmail || null } },
    );
  }
  return viewerEmail;
}

async function assertAgentPublishable(
  agent,
  agentId,
  existingSolutionId = "",
  { ownedSolution: prefetchedSolution = null } = {},
) {
  const source = String(agent?.creation_source || "").trim().toLowerCase();
  const relationship = normalizedRelationship(agent?.marketplace_relationship);
  const linkedSolutionId = String(agent?.marketplace_solution_id || "").trim();
  const explicitlyReadOnly = agent?.is_read_only === true;

  if (
    explicitlyReadOnly ||
    source === "marketplace" ||
    relationship === "installed"
  ) {
    throw lifecycleError(
      "Installed Marketplace agents are read only and cannot be published or republished.",
      "installed_copy_read_only",
      { body: { local_agent_id: agentId, relationship: relationship || null } },
    );
  }
  if (source === "system" || !String(agent?.base_model_id || "").trim()) {
    throw lifecycleError(
      "System and base models cannot be published as editable user agents.",
      "local_artifact_required",
    );
  }
  if (source !== "local") {
    throw lifecycleError(
      `Agent "${agentId}" has unknown or contradictory local provenance.`,
      "marketplace_relationship_unknown",
      { body: { local_agent_id: agentId, creation_source: source || null } },
    );
  }
  if (relationship === "unknown" || (relationship && relationship !== "published")) {
    throw lifecycleError(
      `Agent "${agentId}" has unknown or contradictory Marketplace provenance.`,
      "marketplace_relationship_unknown",
      { body: { local_agent_id: agentId, relationship: relationship || null } },
    );
  }
  if (
    (relationship === "published" && !linkedSolutionId) ||
    (!relationship && linkedSolutionId)
  ) {
    throw lifecycleError(
      `Agent "${agentId}" has contradictory Marketplace link state.`,
      "marketplace_relationship_unknown",
      { body: { local_agent_id: agentId, relationship, linked_solution_id: linkedSolutionId } },
    );
  }
  await assertCurrentViewerOwnsLocalArtifact(
    agent?.created_by_email,
    "agent",
    agentId,
  );

  const targetId = String(existingSolutionId || "").trim();
  if (!targetId && linkedSolutionId) {
    throw lifecycleError(
      "This agent is already linked to a published Marketplace solution; republish using that solution id.",
      "marketplace_link_mismatch",
      { body: { local_agent_id: agentId, linked_solution_id: linkedSolutionId } },
    );
  }
  if (targetId) {
    if (linkedSolutionId && linkedSolutionId !== targetId) {
      throw lifecycleError(
        "The requested Marketplace solution does not match this agent's published link.",
        "marketplace_link_mismatch",
        {
          body: {
            local_agent_id: agentId,
            linked_solution_id: linkedSolutionId,
            requested_solution_id: targetId,
          },
        },
      );
    }
    // Dedupe: updatePublishedSolution already proved ownership of this exact
    // id — reuse its fetch instead of re-running the GET + search pair. Any
    // id/type mismatch falls back to the full fetch (PORTICO-316 guards intact).
    const ownedSolution =
      prefetchedSolution &&
      String(prefetchedSolution?.id || "").trim() === targetId &&
      solutionTypeMatches(prefetchedSolution?.type, TYPE_AGENT)
        ? prefetchedSolution
        : await getOwnedSolutionForWrite(targetId, {
            expectedType: TYPE_AGENT,
          });
    // Ownership + type alone are not enough: an existing_solution_id is only
    // honored to republish the *same* local artifact already linked to it.
    // Without this, an unlinked agent that supplies another owned solution's id
    // would overwrite that solution's remote bundle/listing while its true
    // local artifact keeps a now-stale link (PORTICO-316). Reject even when the
    // viewer owns the target.
    if (!linkedSolutionId) {
      throw lifecycleError(
        "This agent is not linked to the requested Marketplace solution. Publish it as a new solution (omit existing_solution_id), or republish the local artifact already linked to that solution. If that linked artifact is an installed copy of your own listing, convert it in place with reclaim_agent first, then republish it.",
        "marketplace_link_mismatch",
        {
          body: {
            local_agent_id: agentId,
            linked_solution_id: null,
            requested_solution_id: targetId,
          },
        },
      );
    }
    // Rename-aware republish: an agent renamed since its last publish would
    // change the listing's name — enforce the fresh-publish uniqueness check
    // (the own listing still carries the old name, so it never self-matches).
    const localAgentName = String(agent?.name || agentId).trim();
    if (
      normalizeMarketplaceSolutionName(ownedSolution?.name) !==
      normalizeMarketplaceSolutionName(localAgentName)
    ) {
      await assertMarketplaceSolutionNameAvailable(localAgentName, TYPE_AGENT);
    }
  }
}

async function assertSkillPublishable(
  skill,
  skillId,
  existingSolutionId = "",
  link = null,
  { ownedSolution: prefetchedSolution = null } = {},
) {
  if (skill?.source === "marketplace") {
    throw lifecycleError(
      "Installed Marketplace skills are read only and cannot be published or republished.",
      "installed_copy_read_only",
      { body: { local_skill_id: skillId } },
    );
  }
  if (skill?.source !== "user") {
    throw lifecycleError(
      "Only editable user skills can be published.",
      "local_artifact_required",
      { body: { local_skill_id: skillId, source: skill?.source || null } },
    );
  }
  await assertCurrentViewerOwnsLocalArtifact(
    skill?.created_by_email,
    "skill",
    skillId,
  );
  const linkedSolutionId = String(link?.solutionId || "").trim();
  const targetId = String(existingSolutionId || "").trim();
  if (!targetId && linkedSolutionId) {
    throw lifecycleError(
      "This skill is already linked to a published Marketplace solution; republish using that solution id.",
      "marketplace_link_mismatch",
      { body: { local_skill_id: skillId, linked_solution_id: linkedSolutionId } },
    );
  }
  if (targetId) {
    if (linkedSolutionId && linkedSolutionId !== targetId) {
      throw lifecycleError(
        "The requested Marketplace solution does not match this skill's published link.",
        "marketplace_link_mismatch",
        {
          body: {
            local_skill_id: skillId,
            linked_solution_id: linkedSolutionId,
            requested_solution_id: targetId,
          },
        },
      );
    }
    // Dedupe: updatePublishedSolution already proved ownership of this exact
    // id — reuse its fetch instead of re-running the GET + search pair. Any
    // id/type mismatch falls back to the full fetch (PORTICO-316 guards intact).
    const ownedSolution =
      prefetchedSolution &&
      String(prefetchedSolution?.id || "").trim() === targetId &&
      solutionTypeMatches(prefetchedSolution?.type, TYPE_SKILLS)
        ? prefetchedSolution
        : await getOwnedSolutionForWrite(targetId, {
            expectedType: TYPE_SKILLS,
          });
    // Ownership + type alone are not enough: an existing_solution_id is only
    // honored to republish the *same* local artifact already linked to it.
    // Without this, an unlinked skill that supplies another owned solution's id
    // would overwrite that solution's remote bundle/listing while its true
    // local artifact keeps a now-stale link (PORTICO-316). Reject even when the
    // viewer owns the target.
    if (!linkedSolutionId) {
      throw lifecycleError(
        "This skill is not linked to the requested Marketplace solution. Publish it as a new solution (omit existing_solution_id), or republish the local artifact already linked to that solution. If that linked artifact is an installed copy of your own listing, convert it in place with reclaim_skill first, then republish it.",
        "marketplace_link_mismatch",
        {
          body: {
            local_skill_id: skillId,
            linked_solution_id: null,
            requested_solution_id: targetId,
          },
        },
      );
    }
    // Rename-aware republish (rename_skill moves the link, keeping the old
    // listing name): when this republish would CHANGE the listing's name,
    // enforce the same marketplace-wide uniqueness a fresh publish gets —
    // otherwise renaming onto an existing listing name mints duplicates.
    // The own listing still carries the old name, so it never self-matches.
    if (
      normalizeMarketplaceSolutionName(ownedSolution?.name) !==
      normalizeMarketplaceSolutionName(skillId)
    ) {
      await assertMarketplaceSolutionNameAvailable(skillId, TYPE_SKILLS);
    }
  }
}

// Fetch a local agent + its system prompt over the Subagents MCP. Both tools
// take `model_id` (NOT `agent_id` — the renderer's fetchAgentWithSystemPrompt
// is the reference caller), and `subagents_get_agent` never returns the
// prompt, so the dedicated prompt tool is always consulted. Fetch failures
// propagate with the server's real message; `empty_system_prompt` is reserved
// for a prompt that is genuinely empty.
async function getAgentForPublish(
  agentId,
  { existingSolutionId = "", ownedSolution = null } = {},
) {
  const id = String(agentId || "").trim();
  if (!id) throw taggedError("agent_id is required", "invalid_argument");
  const agent = await invokeSubagentsTool("subagents_get_agent", { model_id: id });
  if (!agent || typeof agent !== "object") {
    throw taggedError(`Agent "${id}" not found.`, "agent_not_found");
  }
  let systemPrompt =
    typeof agent.system_prompt === "string" ? agent.system_prompt : "";
  if (!systemPrompt.trim()) {
    const prompt = await invokeSubagentsTool("subagents_get_agent_system_prompt", {
      model_id: id,
    });
    systemPrompt =
      typeof prompt?.system_prompt === "string"
        ? prompt.system_prompt
        : typeof prompt === "string"
          ? prompt
          : "";
  }
  if (!systemPrompt.trim()) {
    throw taggedError(
      "Could not load this agent's system prompt; cannot publish an empty bundle.",
      "empty_system_prompt",
    );
  }
  // Dirty-republish is the common agentic path and the ops layer already
  // knows the linked listing — adopt it instead of failing and asking the
  // model to transcribe a UUID it was never given reliably (the 873f39ba
  // mistranscription incident). Explicit ids still win and still go through
  // the full link-match/ownership asserts below.
  let resolvedSolutionId = String(existingSolutionId || "").trim();
  const linkedSolutionId = String(agent?.marketplace_solution_id || "").trim();
  if (
    !resolvedSolutionId &&
    linkedSolutionId &&
    normalizedRelationship(agent?.marketplace_relationship) === "published"
  ) {
    resolvedSolutionId = linkedSolutionId;
  }
  await assertAgentPublishable(agent, id, resolvedSolutionId, { ownedSolution });
  if (!resolvedSolutionId) {
    await assertMarketplaceSolutionNameAvailable(agent?.name || id, TYPE_AGENT);
  }
  return { agent, systemPrompt, resolvedExistingSolutionId: resolvedSolutionId };
}

// Resolve a local skill's display metadata for the publish-confirmation modal
// (the same fields the control-plane skill card renders). Mirrors
// getAgentForPublish: called BEFORE the confirm modal so bad ids surface as
// real errors and the modal shows the real card.
async function getSkillForPublish(
  skillId,
  { existingSolutionId = "", ownedSolution = null } = {},
) {
  const id = String(skillId || "").trim();
  if (!id) throw taggedError("skill_id is required", "invalid_argument");
  const rel = await resolveSkillDir(id);
  if (!rel) throw taggedError(`Skill "${id}" not found on disk.`, "skill_not_found");
  const source = rel.startsWith("skills-user")
    ? "user"
    : rel.startsWith("skills-marketplace")
      ? "marketplace"
      : "system";
  const skillName = id.includes("/") ? id.split("/").pop() : id;
  let meta = {};
  try {
    // skills_read_skill takes skill_name and nests the frontmatter under
    // `metadata` (there is no skills_get_skill tool).
    const res = await invokeSkillsTool("skills_read_skill", { skill_name: skillName });
    meta = res && typeof res === "object" && res.metadata && typeof res.metadata === "object"
      ? res.metadata
      : {};
  } catch {}
  // Same default logo the control-plane cards use (get-skills IPC), so the
  // modal card is pixel-consistent with the Agent Skills tab.
  let logo = null;
  try {
    const logoBuffer = await fsPromises.readFile(
      path.join(bootstrap.PROJECT_ROOT, "electron-app", "assets", "icon_raw.png"),
    );
    logo = `data:image/png;base64,${logoBuffer.toString("base64")}`;
  } catch {}
  const skill = {
      name: skillName,
      // Authored display name for the approvals card ("GTM Brief QA", not a
      // title-cased slug); omitted when it merely restates the kebab id.
      ...(typeof meta.display_name === "string" &&
      meta.display_name.trim() &&
      meta.display_name.trim() !== skillName
        ? { display_name: meta.display_name.trim() }
        : {}),
      description: typeof meta.description === "string" ? meta.description : "",
      source,
      version: typeof meta.version === "string" ? meta.version : "1.0",
      author: typeof meta.author === "string" ? meta.author : "",
      created_by_email:
        typeof meta.created_by_email === "string" ? meta.created_by_email : null,
      required_mcp_servers: Array.isArray(meta.required_mcp_servers)
        ? meta.required_mcp_servers
        : [],
      logo,
  };
  let linkState;
  try {
    linkState = await aiMarketplaceSkillLinks.readStateStrict();
  } catch (error) {
    throw localProvenanceError(error);
  }
  const link = linkState.links?.[aiMarketplaceSkillLinks.canonicalSkillName(skillName)] || null;
  // Same UUID-adoption contract as getAgentForPublish: a published skill's
  // link already names the republish target, so an omitted
  // existing_solution_id adopts it rather than bouncing the caller.
  let resolvedSolutionId = String(existingSolutionId || "").trim();
  const linkedSolutionId = String(link?.solutionId || "").trim();
  if (!resolvedSolutionId && linkedSolutionId) {
    resolvedSolutionId = linkedSolutionId;
  }
  await assertSkillPublishable(skill, skillName, resolvedSolutionId, link, {
    ownedSolution,
  });
  if (!resolvedSolutionId) {
    await assertMarketplaceSolutionNameAvailable(skillName, TYPE_SKILLS);
  }
  return { skill, link, resolvedExistingSolutionId: resolvedSolutionId };
}

// Degraded-path guard: agent publishes normally run through the app's
// consolidated publish modal, which publishes dependent USER skills first and
// embeds skill_refs into the agent bundle. This main-side path cannot build
// skill_refs, so publishing an agent with ANY non-system skill here would
// silently strip its dependency wiring (the bug where a chat-approved publish
// skipped the user's unpublished skill). Fail closed instead; system-only /
// skill-free agents publish fine (their refs are legitimately empty).
// Unresolvable skill ids also fail closed — they can't be proven system, and
// the app-side resolver blocks them too.
async function assertAgentSkillsPublishableFromMain(agent, agentId) {
  const skillIds = Array.isArray(agent?.skill_ids) ? agent.skill_ids : [];
  const blocked = [];
  for (const rawId of skillIds) {
    const skillId = String(rawId || "").trim();
    if (!skillId) continue;
    const rel = await resolveSkillDir(skillId);
    const isSystem =
      Boolean(rel) &&
      !rel.startsWith("skills-user") &&
      !rel.startsWith("skills-marketplace");
    if (!isSystem) blocked.push(skillId);
  }
  if (!blocked.length) return;
  throw taggedError(
    `Agent "${agentId}" depends on skills that must be published from the app (${blocked.join(", ")}). ` +
      "Approve the publish in the app's publish dialog, or use the Agents tab — the app publishes dependent skills first and embeds their marketplace references.",
    "dependent_skills_require_app_publish",
    {
      remediation:
        "Approve the publish in the app window, or publish from the Agents tab, which publishes dependent skills first.",
    },
  );
}

// Publish an existing LOCAL agent (by id) to the AI Marketplace. Fetches the
// agent + system prompt over the Subagents MCP (or reuses `prefetched` from a
// prior getAgentForPublish, e.g. the publish-confirmation modal), builds the
// publish bundle, and publishes. `allowedEmails` sets visibility (empty =
// discoverable per API rules).
async function buildAndPublishAgent({
  agentId,
  allowedEmails,
  existingSolutionId,
  prefetched,
} = {}) {
  const id = String(agentId || "").trim();
  if (!id) throw taggedError("agent_id is required", "invalid_argument");
  const { agent, systemPrompt } =
    prefetched &&
    prefetched.agent &&
    typeof prefetched.agent === "object" &&
    typeof prefetched.systemPrompt === "string" &&
    prefetched.systemPrompt.trim()
      ? prefetched
      : await getAgentForPublish(id, { existingSolutionId });
  await assertAgentPublishable(agent, id, existingSolutionId);
  await assertAgentSkillsPublishableFromMain(agent, id);
  const bundle = await aiMarketplaceInstall.buildPublishBundle({
    type: TYPE_AGENT,
    agent: {
      name: agent.name || id,
      description: agent.description || "",
      base_model_id: agent.base_model_id || "",
      system_prompt: systemPrompt,
      reasoning_effort: agent.reasoning_effort || null,
      // An absent audience publishes public deliberately (this main-process
      // path only carries system skills — assertAgentSkillsPublishableFromMain
      // blocks user skills — so no dependent listings ride on it).
      allowed_emails: Array.isArray(allowedEmails)
        ? allowedEmails
        : Array.isArray(agent.allowed_emails)
          ? agent.allowed_emails
          : [],
      skill_ids: agent.skill_ids,
      tool_server_ids: agent.tool_server_ids,
      profile_image_url: agent.profile_image_url || null,
    },
  });
  const solutionInput = {
    ...bundle.payload,
    // The validator requires a non-empty description; description-less agents
    // fall back to the name like the control-plane path.
    description: bundle.payload.description || bundle.payload.name,
    type: bundle.type,
    detail_url: marketplaceDetailUrlForType(bundle.type),
    bundle,
  };
  if (existingSolutionId) {
    return updatePublishedSolution(existingSolutionId, solutionInput, {
      localAgentId: id,
      provenanceChecked: true,
    });
  }
  return publishSolution(solutionInput, {
    localAgentId: id,
    provenanceChecked: true,
  });
}

// Publish an existing LOCAL skill (by id) to the AI Marketplace.
async function buildAndPublishSkill({ skillId, existingSolutionId } = {}) {
  const id = String(skillId || "").trim();
  if (!id) throw taggedError("skill_id is required", "invalid_argument");
  await getSkillForPublish(id, { existingSolutionId });
  const rel = await resolveSkillDir(id);
  if (!rel) throw taggedError(`Skill "${id}" not found on disk.`, "skill_not_found");
  const skillName = id.includes("/") ? id.split("/").pop() : id;
  // Read required_mcp_servers (and a description) from the skills MCP metadata
  // when available. skills_read_skill nests frontmatter under `metadata`.
  let requiredMcpServers = [];
  let skillDescription = "";
  try {
    const res = await invokeSkillsTool("skills_read_skill", { skill_name: skillName });
    const skill =
      res && typeof res === "object" && res.metadata && typeof res.metadata === "object"
        ? res.metadata
        : {};
    requiredMcpServers = Array.isArray(skill.required_mcp_servers)
      ? skill.required_mcp_servers
      : [];
    skillDescription =
      typeof skill.description === "string" ? skill.description.trim() : "";
  } catch {}
  const bundle = await aiMarketplaceInstall.buildPublishBundle({
    type: TYPE_SKILL,
    skill: {
      name: skillName,
      path: rel,
      required_mcp_servers: requiredMcpServers,
    },
    projectRoot: bootstrap.PROJECT_ROOT,
  });
  const solutionInput = {
    ...bundle.payload,
    // The validator requires a non-empty description; the bundle payload does
    // not carry one, so synthesize it the way the control-plane path does.
    description:
      bundle.payload.description ||
      skillDescription ||
      `Agent Skill "${skillName}" published via Portico.`,
    type: bundle.type,
    detail_url: marketplaceDetailUrlForType(bundle.type),
    bundle,
  };
  // Standalone skill (re)publish carries no agent audience: aclAudience null
  // preserves the listing's accumulated allowed_emails exactly (the update
  // path pins the current list; the create path defaults public).
  const result = existingSolutionId
    ? await updatePublishedSolution(existingSolutionId, solutionInput, {
        localSkillId: skillName,
        provenanceChecked: true,
        aclAudience: null,
      })
    : await publishSolution(solutionInput, {
        localSkillId: skillName,
        provenanceChecked: true,
        aclAudience: null,
      });
  // Record the publish in the local skill-links registry — it drives the
  // control-plane "Published" badge, which GUI publishes already maintain.
  const resolvedSolutionId =
    result?.publishStatus?.id || existingSolutionId || getSolutionResponseId(result?.data);
  if (resolvedSolutionId) {
    try {
      await aiMarketplaceSkillLinks.setLink(skillName, resolvedSolutionId);
    } catch (error) {
      console.warn(
        "[Marketplace] Published skill but could not record its local link:",
        error.message,
      );
    }
  }
  // Identity keys ride alongside the legacy {data, publishStatus} shape so
  // the chat route can hand models a flat solution id instead of making
  // them dig it out of the raw marketplace echo.
  return {
    ...result,
    skill_id: skillName,
    solution_id: resolvedSolutionId || null,
    action: existingSolutionId ? "updated" : "created",
  };
}

module.exports = {
  // reads
  search,
  getSolution,
  getBundle,
  listPublished,
  getOwnedSolutionForWrite,
  getSkillProvenanceSnapshot,
  checkInstalledAgentUpdates,
  // install
  install,
  deleteLocalSkill,
  clearDeletedAgentLink,
  // writes
  publishSolution,
  updatePublishedSolution,
  preflightDependentSkillListings,
  probeInstallRefVisibility,
  syncSolutionAclForAudience,
  deletePublishedSolution,
  assertSolutionUnpublishableOnMarketplace,
  reclaimInstalledAgent,
  reclaimInstalledSkill,
  installGitMarketplaceSkillDependency,
  getAgentForPublish,
  getSkillForPublish,
  buildAndPublishAgent,
  buildAndPublishSkill,
  // helpers (exported for tests / reuse)
  readApiKeyOrNull,
  resolveViewerIdentity,
  getSolutionResponseId,
  assertMarketplaceWriteAccepted,
  assertSolutionType,
  solutionTypeMatches,
  assertMarketplaceSolutionNameAvailable,
  normalizeMarketplaceSolutionName,
  resolveSkillDir,
};
