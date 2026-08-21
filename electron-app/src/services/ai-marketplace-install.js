// AI Marketplace install/publish handler map.
// Type-keyed so adding new types (e.g. mcp-servers) later is additive.
// Spans the Agent Skills, MCP Orchestration, and IPC/Communication layers.

const fsPromises = require("node:fs/promises");
const path = require("node:path");
const { canonicalSkillName } = require("./ai-marketplace-skill-links");
const {
  formatSkillDisplayName,
  parseSkillMarkdownFrontmatter,
} = require("./skill-frontmatter");
const agentLinks = require("./ai-marketplace-agent-links");
const { solutionFreshnessStamp } = require("./ai-marketplace-freshness");
const {
  logMarketplaceDiag,
  safeErrorMeta,
} = require("./marketplace-diagnostics");
const {
  removeInstalledSkillRecords,
  upsertInstalledSkillRecord,
} = require("./marketplace-service");

const TYPE_PORTICO_AGENTS = "portico-agents";
const TYPE_SKILL = "skill";
const TYPE_SKILLS = "skills";
const TYPE_MCP_SERVERS = "mcp-servers";
const USER_MCP_CONFIG_ROOT = "mcp-configs-user";
const REDACTED_SECRET = "[REDACTED]";
const AI_MARKETPLACE_SKILL_SOURCE_ID = "ai-marketplace";

const SUBAGENTS_SERVER_ID = "subagents";
const SUBAGENTS_PORT = 8766;
const SUBAGENTS_TOOL_CREATE = "subagents_create_agent";
const SUBAGENTS_TOOL_LIST = "subagents_list_agents";
const SUBAGENTS_TOOL_GET = "subagents_get_agent";
const SUBAGENTS_TOOL_UPDATE = "subagents_update_agent";
const SUBAGENTS_TOOL_DELETE = "subagents_delete_agent";
const SUBAGENTS_TOOL_RECONCILE_ATTRIBUTION =
  "subagents_reconcile_agent_attribution";

// Marketplace MCP-server installs (direct "mcp-servers" solutions and the
// agent-install tool_server_refs auto-install) are gated OFF until the
// mcp-servers pipeline is tested end-to-end (MISC-32). Publishing is not
// gated. Set portico_ENABLE_MCP_SERVER_INSTALLS=1 to re-enable for testing.
function marketplaceMcpServerInstallsEnabled() {
  return process.env.portico_ENABLE_MCP_SERVER_INSTALLS === "1";
}

function sanitizeId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asArrayOfStrings(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim()) out.push(entry.trim());
  }
  return out;
}

function compactObject(object) {
  return Object.fromEntries(
    Object.entries(object || {}).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
}

function normalizeAllowedEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function asAllowedEmails(value) {
  const out = [];
  const seen = new Set();
  for (const entry of asArrayOfStrings(value)) {
    const normalized = normalizeAllowedEmail(entry);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

// Skill references link an agent's skill_ids to their installable origin so
// the installer can provision dependent skills automatically. Entries are a
// discriminated union on `kind`:
//   { skill_id, kind?: "solution", solution_id }            — Solutions listing
//   { skill_id, kind: "git-marketplace", solution_id: null,
//     marketplace: { name, source: {type: github|gitlab|url, ...registry keys} },
//     skill_path, skill_source? }                            — git origin ref
// Legacy entries (no kind) normalize to "solution". Unknown kinds and
// malformed entries are dropped (tolerant), never a parse failure. Old app
// versions strip git refs (no solution_id) and fail that dependency at
// reconcile unless the skill is already present locally — accepted beta
// limitation of the reference-only dependency policy.
function asSkillRefs(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const skillId =
      typeof entry.skill_id === "string" ? entry.skill_id.trim() : "";
    if (!skillId) continue;
    const kind =
      typeof entry.kind === "string" && entry.kind.trim()
        ? entry.kind.trim()
        : "solution";
    // Optional authored display name (additive, older bundles omit it): the
    // only way non-owner machines can render "GTM Brief QA" instead of a
    // title-cased slug. This gate covers BOTH bundle build and install reads.
    const displayName =
      typeof entry.display_name === "string" &&
      entry.display_name.trim() &&
      entry.display_name.trim() !== skillId
        ? entry.display_name.trim()
        : null;
    if (kind === "solution") {
      const solutionId =
        typeof entry.solution_id === "string" ? entry.solution_id.trim() : "";
      if (!solutionId) continue;
      out.push({
        skill_id: skillId,
        kind,
        solution_id: solutionId,
        ...(displayName ? { display_name: displayName } : {}),
      });
      continue;
    }
    if (kind === "git-marketplace") {
      const source = entry.marketplace?.source;
      const sourceType = typeof source?.type === "string" ? source.type : "";
      if (!source || !["github", "gitlab", "url"].includes(sourceType)) {
        continue;
      }
      out.push({
        skill_id: skillId,
        kind,
        solution_id: null,
        ...(displayName ? { display_name: displayName } : {}),
        marketplace: {
          name:
            typeof entry.marketplace?.name === "string"
              ? entry.marketplace.name.trim()
              : "",
          source: { ...source },
        },
        skill_path:
          typeof entry.skill_path === "string" ? entry.skill_path.trim() : "",
        skill_source:
          entry.skill_source && typeof entry.skill_source === "object"
            ? { ...entry.skill_source }
            : null,
        plugin_name:
          typeof entry.plugin_name === "string" && entry.plugin_name.trim()
            ? entry.plugin_name.trim()
            : null,
      });
    }
  }
  return out;
}

// MCP server references link an agent's tool_server_ids to marketplace MCP
// server bundles, mirroring skill_refs for deterministic dependency installs.
function asToolServerRefs(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const toolServerId =
      typeof entry.tool_server_id === "string"
        ? entry.tool_server_id.trim()
        : "";
    const solutionId =
      typeof entry.solution_id === "string" ? entry.solution_id.trim() : "";
    if (!toolServerId || !solutionId) continue;
    out.push({ tool_server_id: toolServerId, solution_id: solutionId });
  }
  return out;
}

function normalizeToolServerId(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  return trimmed.startsWith("server:") ? trimmed : `server:${trimmed}`;
}

function pickKnownIds(candidates, knownSet) {
  if (!Array.isArray(candidates)) return { resolved: [], unresolved: [] };
  const resolved = [];
  const unresolved = [];
  for (const id of candidates) {
    if (typeof id !== "string" || !id.trim()) continue;
    if (!knownSet || knownSet.has(id)) {
      resolved.push(id);
    } else {
      unresolved.push(id);
    }
  }
  return { resolved, unresolved };
}

function normalizeExistingAgentId(value) {
  const trimmed = String(value || "").trim();
  return trimmed || "";
}

function marketplaceInstalledSkillId(skillId) {
  const slug = sanitizeId(canonicalSkillName(skillId) || skillId);
  return slug ? `ai-marketplace/${slug}` : "";
}

function uniqueMarketplaceAgentId(baseId, knownAgentIds) {
  const normalizedBase = sanitizeId(baseId) || "marketplace-agent";
  if (!(knownAgentIds instanceof Set)) {
    return normalizedBase;
  }
  if (!knownAgentIds.has(normalizedBase)) {
    return normalizedBase;
  }
  const suffixBase = `${normalizedBase}-marketplace`;
  let candidate = suffixBase;
  for (let counter = 2; knownAgentIds.has(candidate); counter += 1) {
    candidate = `${suffixBase}-${counter}`;
  }
  return candidate;
}

function buildAgentInstallError(message, code, body = null) {
  const error = new Error(message);
  error.code = code;
  if (body && typeof body === "object") {
    error.body = body;
  }
  return error;
}

async function cleanupInstalledArtifacts(entries, deps = {}) {
  const projectRoot = deps.projectRoot;
  if (!projectRoot || !Array.isArray(entries) || !entries.length) {
    return [];
  }

  const projectRootAbs = path.resolve(projectRoot);
  const removedInstalledSkills = [];
  const cleanup = [];
  for (const entry of entries) {
    const installedPath = String(entry?.installedPath || "").trim();
    if (!installedPath) continue;
    const targetPath = path.resolve(projectRoot, installedPath);
    if (
      targetPath === projectRootAbs ||
      !targetPath.startsWith(`${projectRootAbs}${path.sep}`)
    ) {
      cleanup.push({
        installedPath,
        cleaned: false,
        error: "Refused to remove path outside the project root.",
      });
      continue;
    }

    try {
      await fsPromises.rm(targetPath, { recursive: true, force: true });
      const relativeLocalPath = path
        .relative(projectRootAbs, targetPath)
        .split(path.sep)
        .filter(Boolean)
        .join("/");
      // Any removed directory under skills-marketplace (flat depth-2 or
      // plugin depth-3) must also drop its registry record; match by the
      // record's own localPath rather than re-deriving ids from segments.
      if (relativeLocalPath.startsWith("skills-marketplace/")) {
        removedInstalledSkills.push(relativeLocalPath);
      }
      cleanup.push({ installedPath, cleaned: true });
    } catch (error) {
      cleanup.push({
        installedPath,
        cleaned: false,
        error: error?.message || String(error),
      });
    }
  }

  if (removedInstalledSkills.length) {
    try {
      await removeInstalledSkillRecords(projectRoot, {
        localPaths: removedInstalledSkills,
      });
    } catch (error) {
      cleanup.push({
        installedPath: "marketplaces.json",
        cleaned: false,
        error: error?.message || String(error),
      });
    }
  }

  if (cleanup.length) {
    logMarketplaceDiag(
      "install",
      "rollback:artifacts",
      { outcomes: cleanup.map((entry) => ({
          installedPath: entry.installedPath,
          cleaned: entry.cleaned === true,
          errorMessage: entry.error || null,
        })) },
      "error",
    );
  }
  return cleanup;
}

// Progress emissions are UI-only: they must never be able to abort or
// reorder install work, so every callback invocation is swallowed on error.
function reportInstallProgress(onProgress, event) {
  if (typeof onProgress !== "function") return;
  try {
    onProgress(event);
  } catch (error) {
    console.warn(
      "[Marketplace] install progress callback failed:",
      error?.message || error,
    );
  }
}

// A failed install undoes its own work; tell the UI which per-skill rows
// were rolled back so their "Done" marks don't outlive the files. Bounded:
// one emission per newly-installed dependency, failure path only.
function reportRolledBackSkills(onProgress, rollbackEntries, cleanupOutcomes) {
  const cleanedByPath = new Map(
    (Array.isArray(cleanupOutcomes) ? cleanupOutcomes : []).map((entry) => [
      String(entry?.installedPath || "").trim(),
      entry?.cleaned === true,
    ]),
  );
  for (const entry of Array.isArray(rollbackEntries) ? rollbackEntries : []) {
    const skillId = String(entry?.skill_id || "").trim();
    if (!skillId) continue;
    reportInstallProgress(onProgress, {
      phase: "skill:rolled-back",
      skillId,
      cleaned:
        cleanedByPath.get(String(entry?.installedPath || "").trim()) === true,
    });
  }
}

async function reconcileAgentSkillDependencies({ payload, deps = {}, knownSkills }) {
  const fetchSolutionBundle =
    typeof deps.fetchSolutionBundle === "function" ? deps.fetchSolutionBundle : null;
  const fetchSolution =
    typeof deps.fetchSolution === "function" ? deps.fetchSolution : null;
  const onProgress = deps.onProgress;
  const skillIds = asArrayOfStrings(payload.skill_ids);
  const skillRefs = asSkillRefs(payload.skill_refs);
  const refsBySkillId = new Map();
  for (const ref of skillRefs) {
    if (!refsBySkillId.has(ref.skill_id)) {
      refsBySkillId.set(ref.skill_id, ref);
    }
  }

  const skillRemap = new Map();
  const installedSkills = [];
  const rollbackSkills = [];
  const failedSkills = [];
  const refreshedSkills = [];
  const skippedSkillRefreshes = [];
  // Agent-Update dependency refreshes reported by the injected installers.
  const recordRefreshOutcome = (ref, installed) => {
    if (installed?.refreshed === true) {
      refreshedSkills.push({
        skill_id: ref.skill_id,
        solution_id: ref.solution_id ?? null,
        installed_id: installed?.localSkillId || null,
      });
      reportInstallProgress(onProgress, {
        phase: "skill:refreshed",
        skillId: ref.skill_id,
      });
    } else if (installed?.refreshSkipped) {
      skippedSkillRefreshes.push({
        skill_id: ref.skill_id,
        solution_id: ref.solution_id ?? null,
        reason: installed.refreshSkipped,
      });
      reportInstallProgress(onProgress, {
        phase: "skill:refresh-skipped",
        skillId: ref.skill_id,
        reason: installed.refreshSkipped,
      });
    }
  };
  // Per-skill lifecycle for live install UIs. skillId is the VERBATIM
  // payload id (legacy bundles may carry qualified ids like
  // "ai-marketplace/foo") so row keys match without canonicalization.
  const reportSkillDone = (skillId) =>
    reportInstallProgress(onProgress, { phase: "skill:done", skillId });
  const reportSkillError = (skillId) =>
    reportInstallProgress(onProgress, { phase: "skill:error", skillId });
  // One diagnostic line per dependency with the branch the reconcile took —
  // the answer to "why did this skill install/reuse/fail" in production.
  const logSkillDecision = (skillId, branch, extra = {}) =>
    logMarketplaceDiag(
      "install",
      "reconcile:skill",
      { skillId, branch, ...extra },
      branch.endsWith("failed") ? "warn" : "info",
    );

  // Shared bookkeeping for a successfully provisioned dependency, regardless
  // of origin (Solutions listing or git marketplace): remap the agent's skill
  // id to the local canonical id and register rollback for fresh installs.
  const recordInstalledDependency = (ref, installed) => {
    const canonicalId = String(
      installed?.localSkillId ||
        (installed?.id ? `ai-marketplace/${installed.id}` : ""),
    ).trim();
    if (!canonicalId) {
      throw buildAgentInstallError(
        "Dependent skill install returned no local skill id.",
        "skill_id_missing",
      );
    }
    skillRemap.set(ref.skill_id, canonicalId);
    if (knownSkills) knownSkills.add(canonicalId);
    if (installed?.newlyInstalled !== false) {
      const installedEntry = {
        skill_id: ref.skill_id,
        solution_id: ref.solution_id ?? null,
        installed_id: canonicalId,
        installedPath: installed.installedPath,
      };
      installedSkills.push(installedEntry);
      if (installed?.rollbackOnParentFailure !== false) {
        rollbackSkills.push(installedEntry);
      }
    }
  };

  for (const skillId of skillIds) {
    reportInstallProgress(onProgress, { phase: "skill:start", skillId });
    const ref = refsBySkillId.get(skillId);
    if (!ref) {
      if (knownSkills && knownSkills.has(skillId)) {
        logSkillDecision(skillId, "reuse-local");
        reportSkillDone(skillId);
        continue;
      }

      const installedMarketplaceId = marketplaceInstalledSkillId(skillId);
      if (installedMarketplaceId && knownSkills && knownSkills.has(installedMarketplaceId)) {
        skillRemap.set(skillId, installedMarketplaceId);
        logSkillDecision(skillId, "slug-remap", { localSkillId: installedMarketplaceId });
        reportSkillDone(skillId);
        continue;
      }

      failedSkills.push({
        skill_id: skillId,
        solution_id: null,
        error: `Required skill "${skillId}" is missing a marketplace solution reference.`,
      });
      logSkillDecision(skillId, "no-ref-failed");
      reportSkillError(skillId);
      continue;
    }

    if (ref.kind === "git-marketplace") {
      // A local skill with the same canonical name wins (identical to the
      // ref-less fallback above): catalog precedence would shadow a fresh
      // marketplace install anyway.
      if (knownSkills && knownSkills.has(ref.skill_id)) {
        skillRemap.set(ref.skill_id, ref.skill_id);
        logSkillDecision(skillId, "git-local-win");
        reportSkillDone(skillId);
        continue;
      }
      const installGitSkillDependency =
        typeof deps.installGitSkillDependency === "function"
          ? deps.installGitSkillDependency
          : null;
      if (!installGitSkillDependency) {
        failedSkills.push({
          skill_id: ref.skill_id,
          solution_id: null,
          error:
            "No git-marketplace dependency installer is available for dependent skills.",
        });
        logSkillDecision(skillId, "git-failed", { errorCode: "no_git_installer" });
        reportSkillError(skillId);
        continue;
      }
      try {
        const installed = await installGitSkillDependency({ ref });
        recordInstalledDependency(ref, installed);
        recordRefreshOutcome(ref, installed);
        logSkillDecision(skillId, "git-installed", {
          localSkillId: installed?.localSkillId || null,
          newlyInstalled: installed?.newlyInstalled !== false,
          marketplaceName: ref.marketplace?.name || "",
        });
        reportSkillDone(skillId);
      } catch (error) {
        failedSkills.push({
          skill_id: ref.skill_id,
          solution_id: null,
          error: error?.message || String(error),
        });
        logSkillDecision(skillId, "git-failed", safeErrorMeta(error));
        reportSkillError(skillId);
      }
      continue;
    }

    const installSkillDependency =
      typeof deps.installSkillDependency === "function"
        ? deps.installSkillDependency
        : null;
    if (!installSkillDependency && !fetchSolutionBundle) {
      failedSkills.push({
        skill_id: ref.skill_id,
        solution_id: ref.solution_id,
        error: "No marketplace bundle fetcher is available for dependent skills.",
      });
      logSkillDecision(skillId, "solution-failed", {
        solutionId: ref.solution_id,
        errorCode: "no_bundle_fetcher",
      });
      reportSkillError(skillId);
      continue;
    }

    try {
      let installed;
      if (installSkillDependency) {
        installed = await installSkillDependency({
          expectedSkillId: ref.skill_id,
          solutionId: ref.solution_id,
        });
      } else {
        const skillBundle = await fetchSolutionBundle(ref.solution_id);
        const solution =
          fetchSolution ? await fetchSolution(ref.solution_id).catch(() => null) : null;
        installed = await installSkill({
          bundle: skillBundle,
          deps: {
            ...deps,
            solutionId: ref.solution_id,
            solution,
          },
        });
      }
      recordInstalledDependency(ref, installed);
      recordRefreshOutcome(ref, installed);
      logSkillDecision(
        skillId,
        installed?.newlyInstalled === false ? "solution-reused" : "solution-installed",
        { solutionId: ref.solution_id, localSkillId: installed?.localSkillId || null },
      );
      reportSkillDone(skillId);
    } catch (error) {
      failedSkills.push({
        skill_id: ref.skill_id,
        solution_id: ref.solution_id,
        error: error?.message || String(error),
      });
      logSkillDecision(skillId, "solution-failed", {
        solutionId: ref.solution_id,
        ...safeErrorMeta(error),
      });
      reportSkillError(skillId);
    }
  }

  const remappedSkillIds = skillIds.map((id) => skillRemap.get(id) || id);
  const skillSplit = pickKnownIds(remappedSkillIds, knownSkills);
  logMarketplaceDiag(
    "install",
    "reconcile:summary",
    {
      skillCount: skillIds.length,
      installedCount: installedSkills.length,
      failedSkillIds: failedSkills.map((entry) => entry.skill_id),
      unresolvedSkillIds: skillSplit.unresolved,
    },
    failedSkills.length || skillSplit.unresolved.length ? "error" : "info",
  );

  if (failedSkills.length || skillSplit.unresolved.length) {
    const rollback = await cleanupInstalledArtifacts(rollbackSkills, deps);
    reportRolledBackSkills(onProgress, rollbackSkills, rollback);
    throw buildAgentInstallError(
      "Agent install failed because one or more required dependent skills could not be installed.",
      "agent_dependency_install_failed",
      {
        failedSkills,
        unresolvedSkillIds: skillSplit.unresolved,
        rollback,
      },
    );
  }

  return {
    installedSkills,
    rollbackSkills,
    skillSplit,
    refreshedSkills,
    skippedSkillRefreshes,
  };
}

function buildAgentMutationArgs({
  payload,
  skillIds,
  toolServerIds,
  existingAgentId = "",
  createAgentId = "",
}) {
  const args = {
    name: payload.name,
    base_model_id: payload.base_model_id || "",
    system_prompt: payload.system_prompt,
    description: payload.description || "",
    skill_ids: skillIds,
    tool_server_ids: toolServerIds,
  };
  if (payload.reasoning_effort) {
    args.reasoning_effort = payload.reasoning_effort;
  }
  if (existingAgentId) {
    args.model_id = existingAgentId;
  } else if (createAgentId) {
    args.model_id = createAgentId;
  }
  return args;
}

function getAgentMutationFailureMessage(result, fallbackMessage) {
  return (
    (result?.data && (result.data.error || result.data.detail)) ||
    result?.statusText ||
    fallbackMessage
  );
}

async function mutateInstalledAgent({
  payload,
  invokeMcpTool,
  skillIds,
  toolServerIds,
  existingAgentId = "",
  createAgentId = "",
  beforeCreate = null,
}) {
  const createArgs = buildAgentMutationArgs({
    payload,
    skillIds,
    toolServerIds,
    createAgentId,
  });

  if (existingAgentId) {
    const updateArgs = buildAgentMutationArgs({
      payload,
      skillIds,
      toolServerIds,
      existingAgentId,
    });
    // Sanctioned refresh of an installed copy: the Subagents server verifies
    // this payload against the linked listing's bundle before opening its
    // read-only guard.
    updateArgs.marketplace_refresh = true;
    const updateResult = await invokeMcpTool(
      SUBAGENTS_SERVER_ID,
      SUBAGENTS_TOOL_UPDATE,
      updateArgs,
      SUBAGENTS_PORT,
    );
    // invokeMcpTool's success is transport-level only; tool-domain failures
    // arrive as HTTP 200 with {success:false}/{is_error} envelopes. Treating
    // those as data once returned an error envelope INSIDE `created` and let
    // the install flow stamp a fresh remoteUpdatedAt over a refresh that
    // never happened (2026-08-01 sharing-run ISSUE-9).
    const updateData = updateResult?.data;
    const updateDomainFailure =
      updateData &&
      typeof updateData === "object" &&
      (updateData.success === false || updateData.is_error === true);
    if (updateResult?.success && !updateDomainFailure) {
      return {
        created: updateData || {},
        mutation: "updated",
      };
    }

    const updateMessage = getAgentMutationFailureMessage(
      updateResult,
      "Failed to update agent via Subagents MCP",
    );
    if (!/\bnot found\b/i.test(updateMessage)) {
      throw buildAgentInstallError(
        `Agent update failed: ${updateMessage}`,
        "agent_update_failed",
      );
    }
  }

  if (typeof beforeCreate === "function") {
    await beforeCreate(createArgs.model_id);
  }

  const createResult = await invokeMcpTool(
    SUBAGENTS_SERVER_ID,
    SUBAGENTS_TOOL_CREATE,
    createArgs,
    SUBAGENTS_PORT,
  );
  if (!createResult?.success) {
    const message = getAgentMutationFailureMessage(
      createResult,
      "Failed to create agent via Subagents MCP",
    );
    throw buildAgentInstallError(
      `Agent install failed: ${message}`,
      "agent_install_failed",
    );
  }

  return {
    created: createResult.data || {},
    mutation: "created",
  };
}

function resolveAgentLinkDeps(deps = {}) {
  return deps.agentLinkDeps && typeof deps.agentLinkDeps === "object"
    ? deps.agentLinkDeps
    : {};
}

async function preflightAgentLinkRegistry(deps = {}) {
  if (typeof deps.readAgentLinksStrict === "function") {
    return (await deps.readAgentLinksStrict()) || { links: {} };
  }
  // Tests that inject the complete link lifecycle do not need Electron's
  // on-disk registry. Production never injects setInstalledAgentLink.
  if (typeof deps.setInstalledAgentLink === "function") return { links: {} };
  return await agentLinks.readStateStrict(resolveAgentLinkDeps(deps));
}

async function setInstalledAgentLink(
  localAgentId,
  solutionId,
  authorIdentity,
  attributionPending,
  deps = {},
) {
  if (typeof deps.setInstalledAgentLink === "function") {
    return await deps.setInstalledAgentLink({
      localAgentId,
      solutionId,
      authorIdentity,
      attributionPending,
    });
  }
  return await agentLinks.setInstalledLink(localAgentId, solutionId, authorIdentity, {
    ...resolveAgentLinkDeps(deps),
    attributionPending,
  });
}

async function clearInstalledAgentLink(localAgentId, deps = {}) {
  if (typeof deps.clearAgentLink === "function") {
    return await deps.clearAgentLink(localAgentId);
  }
  return await agentLinks.clearLink(localAgentId, resolveAgentLinkDeps(deps));
}

async function finalizeInstalledAgentAttribution(
  localAgentId,
  invokeMcpTool,
  deps = {},
  requirePendingFinalization = false,
) {
  const result =
    typeof deps.reconcileAgentAttribution === "function"
      ? await deps.reconcileAgentAttribution(localAgentId)
      : await invokeMcpTool(
          SUBAGENTS_SERVER_ID,
          SUBAGENTS_TOOL_RECONCILE_ATTRIBUTION,
          {},
          SUBAGENTS_PORT,
        );
  if (!result?.success) {
    throw buildAgentInstallError(
      getAgentMutationFailureMessage(
        result,
        "Failed to reconcile installed agent attribution",
      ),
      "agent_attribution_failed",
    );
  }
  const failures = Array.isArray(result?.data?.failures) ? result.data.failures : [];
  const failed = failures.find((entry) => entry?.id === localAgentId);
  if (failed) {
    throw buildAgentInstallError(
      `Failed to reconcile installed agent attribution: ${failed.error || "unknown error"}`,
      "agent_attribution_failed",
    );
  }
  if (requirePendingFinalization) {
    const finalizedPendingIds = Array.isArray(
      result?.data?.finalized_pending_ids,
    )
      ? result.data.finalized_pending_ids
      : [];
    if (!finalizedPendingIds.includes(localAgentId)) {
      throw buildAgentInstallError(
        "Installed agent attribution reconciliation did not confirm the pending model.",
        "agent_attribution_not_finalized",
      );
    }
  }
  if (typeof deps.finalizeAgentAttribution === "function") {
    await deps.finalizeAgentAttribution(localAgentId);
  } else {
    await agentLinks.finalizeAttribution(localAgentId, resolveAgentLinkDeps(deps));
  }
  return result.data || {};
}

async function rollbackFreshAgent(
  localAgentId,
  invokeMcpTool,
  deps = {},
  linkAgentId = localAgentId,
) {
  const outcomes = [];
  try {
    // confirm:true — delete_agent fail-closes without it. This rollback only
    // removes the agent this very install flow just created, on behalf of the
    // user-initiated install that failed.
    const deleted = await invokeMcpTool(
      SUBAGENTS_SERVER_ID,
      SUBAGENTS_TOOL_DELETE,
      { model_id: localAgentId, confirm: true },
      SUBAGENTS_PORT,
    );
    outcomes.push({ kind: "agent", id: localAgentId, cleaned: deleted?.success === true });
  } catch (error) {
    outcomes.push({ kind: "agent", id: localAgentId, cleaned: false, error: error.message });
  }
  try {
    const cleared = await clearInstalledAgentLink(linkAgentId, deps);
    outcomes.push({ kind: "agent-link", id: linkAgentId, cleaned: cleared !== false });
  } catch (error) {
    outcomes.push({ kind: "agent-link", id: linkAgentId, cleaned: false, error: error.message });
  }
  return outcomes;
}

// =============================================================================
// AGENTS
// =============================================================================

async function installAgent({ bundle, deps = {} }) {
  const payload = asObject(bundle?.payload);
  const missing = [];
  if (!payload.name) missing.push("payload.name");
  if (!payload.base_model_id) missing.push("payload.base_model_id");
  if (!payload.system_prompt) missing.push("payload.system_prompt");
  if (missing.length) {
    throw new Error(
      `Agent bundle is missing required fields: ${missing.join(", ")}.`,
    );
  }

  const invokeMcpTool = deps.invokeMcpTool || requireInvokeMcpTool();
  // Stored verbatim (no domain guessing) - the solution envelope's
  // submitted_by may be a full email or a bare handle depending on how the
  // publisher's identity was captured; ownership comparisons normalize both
  // sides at read time instead (see normalizeMarketplaceOwnerIdentity).
  const createdByEmail =
    typeof deps.solution?.submitted_by === "string"
      ? deps.solution.submitted_by.trim()
      : "";
  if (!createdByEmail) {
    throw buildAgentInstallError(
      "This AI Marketplace agent cannot be installed because its publisher identity is missing.",
      "missing_marketplace_author",
    );
  }
  const solutionId = typeof deps.solutionId === "string" ? deps.solutionId.trim() : "";
  if (!solutionId) {
    throw buildAgentInstallError(
      "This AI Marketplace agent cannot be installed because its solution id is missing.",
      "missing_marketplace_solution_id",
    );
  }
  const linkRegistry = await preflightAgentLinkRegistry(deps);
  const existingAgentId = normalizeExistingAgentId(deps.existingAgentId);
  if (!existingAgentId && !(deps.knownAgentIds instanceof Set)) {
    throw buildAgentInstallError(
      "This AI Marketplace agent cannot be installed because the local agent inventory is unavailable.",
      "agent_inventory_unavailable",
    );
  }
  const knownAgentIds =
    deps.knownAgentIds instanceof Set ? new Set(deps.knownAgentIds) : null;
  if (!existingAgentId && knownAgentIds) {
    for (const linkedAgentId of Object.keys(asObject(linkRegistry?.links))) {
      if (linkedAgentId.trim()) knownAgentIds.add(linkedAgentId);
    }
  }
  const createAgentId = existingAgentId || uniqueMarketplaceAgentId(payload.name, knownAgentIds);
  const knownServers =
    deps.knownToolServerIds instanceof Set
      ? new Set(deps.knownToolServerIds)
      : null;

  // Work against a private copy so we can fold in skills we install on demand
  // without mutating the caller's set.
  const knownSkills =
    deps.knownSkillIds instanceof Set ? new Set(deps.knownSkillIds) : null;

  const skillState = await reconcileAgentSkillDependencies({
    payload,
    deps,
    knownSkills,
  });
  const installedSkills = skillState.installedSkills;
  // All dependent-skill work settled; everything left (tool servers, the
  // agent record itself) is the "installing the agent" phase for live UIs.
  reportInstallProgress(deps.onProgress, { phase: "agent:start" });

  const installedToolServers = [];
  const failedToolServers = [];
  const skippedToolServers = [];
  const toolServerRefs = asToolServerRefs(payload.tool_server_refs);
  if (toolServerRefs.length) {
    const installsEnabled = marketplaceMcpServerInstallsEnabled();
    for (const ref of toolServerRefs) {
      const canonicalId = normalizeToolServerId(ref.tool_server_id);
      if (!canonicalId || (knownServers && knownServers.has(canonicalId))) {
        continue;
      }
      if (!installsEnabled) {
        skippedToolServers.push({
          tool_server_id: ref.tool_server_id,
          solution_id: ref.solution_id,
          reason: "mcp_server_installs_disabled",
        });
        continue;
      }
      if (typeof deps.fetchSolutionBundle !== "function") continue;
      try {
        const serverBundle = await deps.fetchSolutionBundle(ref.solution_id);
        const installed = await installMcpServer({ bundle: serverBundle, deps });
        const installedId = normalizeToolServerId(installed.id);
        if (knownServers) knownServers.add(installedId);
        installedToolServers.push({
          tool_server_id: ref.tool_server_id,
          solution_id: ref.solution_id,
          installed_id: installedId,
          installedPath: installed.installedPath,
        });
      } catch (error) {
        failedToolServers.push({
          tool_server_id: ref.tool_server_id,
          solution_id: ref.solution_id,
          error: error?.message || String(error),
        });
      }
    }
    if (skippedToolServers.length) {
      logMarketplaceDiag("install", "tool-server:installs-disabled", {
        solutionId,
        skipped: skippedToolServers.length,
      });
    }
  }

  const serverSplit = pickKnownIds(
    asArrayOfStrings(payload.tool_server_ids).map(normalizeToolServerId),
    knownServers,
  );
  let mutationResult;
  let pendingLinkAgentId = "";
  let freshAgentCreatedId = "";
  let resolvedAgentId = "";
  try {
    mutationResult = await mutateInstalledAgent({
      payload,
      invokeMcpTool,
      skillIds: skillState.skillSplit.resolved,
      toolServerIds: serverSplit.resolved,
      existingAgentId,
      createAgentId,
      beforeCreate: async (localAgentId) => {
        if (!localAgentId) {
          throw buildAgentInstallError(
            "Marketplace agent creation did not reserve a stable local id.",
            "agent_id_missing",
          );
        }
        await setInstalledAgentLink(
          localAgentId,
          solutionId,
          createdByEmail,
          true,
          deps,
        );
        pendingLinkAgentId = localAgentId;
        logMarketplaceDiag("install", "agent:link-reserved", {
          agentId: localAgentId,
          solutionId,
          attributionPending: true,
        });
      },
    });
    resolvedAgentId = String(
      mutationResult?.created?.id || existingAgentId || pendingLinkAgentId,
    ).trim();
    if (mutationResult.mutation === "created") {
      freshAgentCreatedId = resolvedAgentId;
    }
    if (!resolvedAgentId) {
      throw buildAgentInstallError(
        "Marketplace agent mutation returned no local agent id.",
        "agent_id_missing",
      );
    }
    if (
      mutationResult.mutation === "created" &&
      pendingLinkAgentId &&
      resolvedAgentId !== pendingLinkAgentId
    ) {
      throw buildAgentInstallError(
        "Marketplace agent creation did not honor the reserved local id.",
        "agent_id_mismatch",
      );
    }
    logMarketplaceDiag("install", "agent:mutation", {
      agentId: resolvedAgentId,
      solutionId,
      mutation: mutationResult.mutation,
    });
    if (mutationResult.mutation === "updated") {
      await setInstalledAgentLink(
        resolvedAgentId,
        solutionId,
        createdByEmail,
        false,
        deps,
      );
    }
    await finalizeInstalledAgentAttribution(
      resolvedAgentId,
      invokeMcpTool,
      deps,
      mutationResult.mutation === "created",
    );
    logMarketplaceDiag("install", "agent:attribution-finalized", {
      agentId: resolvedAgentId,
      mutation: mutationResult.mutation,
    });
  } catch (error) {
    const rollback = await cleanupInstalledArtifacts(
      [...skillState.rollbackSkills, ...installedToolServers],
      deps,
    );
    reportRolledBackSkills(deps.onProgress, skillState.rollbackSkills, rollback);
    if (pendingLinkAgentId) {
      if (freshAgentCreatedId) {
        rollback.push(
          ...(await rollbackFreshAgent(
            freshAgentCreatedId,
            invokeMcpTool,
            deps,
            pendingLinkAgentId,
          )),
        );
      } else {
        try {
          const cleared = await clearInstalledAgentLink(pendingLinkAgentId, deps);
          rollback.push({
            kind: "agent-link",
            id: pendingLinkAgentId,
            cleaned: cleared !== false,
          });
        } catch (linkError) {
          rollback.push({
            kind: "agent-link",
            id: pendingLinkAgentId,
            cleaned: false,
            error: linkError.message,
          });
        }
      }
    }
    logMarketplaceDiag(
      "install",
      "agent:rolled-back",
      {
        agentId: resolvedAgentId || pendingLinkAgentId || "",
        solutionId,
        rollbackCount: rollback.length,
        ...safeErrorMeta(error),
      },
      "error",
    );
    throw buildAgentInstallError(error.message, error.code || "agent_install_failed", {
      rollback,
      failedToolServers,
      skippedToolServers,
      ...((error && error.body) || {}),
    });
  }

  return {
    type: TYPE_PORTICO_AGENTS,
    // The create/update MCP response is captured before the installed link is
    // finalized, so returning it verbatim can falsely describe the new local
    // copy as editable/local. Installation only succeeds after attribution
    // reconciliation and link finalization above, making this authoritative
    // installed snapshot safe to return to bridge callers immediately.
    created: {
      ...(mutationResult.created || {}),
      id: resolvedAgentId,
      name: payload.name,
      description: payload.description || "",
      base_model_id: payload.base_model_id,
      reasoning_effort: payload.reasoning_effort || null,
      skill_ids: skillState.skillSplit.resolved,
      tool_server_ids: serverSplit.resolved,
      creation_source: "marketplace",
      created_by_email: createdByEmail,
      marketplace_relationship: "installed",
      marketplace_solution_id: solutionId,
      is_read_only: true,
    },
    mutation: mutationResult.mutation,
    installedSkills,
    installedToolServers,
    refreshedSkills: skillState.refreshedSkills || [],
    skippedSkillRefreshes: skillState.skippedSkillRefreshes || [],
    failedSkills: [],
    failedToolServers,
    skippedToolServers,
    unresolved: {
      skill_ids: skillState.skillSplit.unresolved,
      tool_server_ids: serverSplit.unresolved,
    },
  };
}

async function publishAgentBundle({ agent }) {
  const payload = {
    name: agent?.name || "",
    description: agent?.description || "",
    base_model_id: agent?.base_model_id || "",
    system_prompt: agent?.system_prompt || agent?.system || "",
    reasoning_effort: agent?.reasoning_effort || null,
    allowed_emails: asAllowedEmails(agent?.allowed_emails),
    skill_ids: asArrayOfStrings(agent?.skill_ids),
    skill_refs: asSkillRefs(agent?.skill_refs),
    tool_server_ids: asArrayOfStrings(agent?.tool_server_ids),
    tool_server_refs: asToolServerRefs(agent?.tool_server_refs),
    profile_image_url: agent?.profile_image_url || null,
  };
  return { type: TYPE_PORTICO_AGENTS, payload };
}

// =============================================================================
// SKILLS
// =============================================================================

function getMarketplaceSkillRoot({ projectRoot }) {
  return path.join(projectRoot, "skills-marketplace", "ai-marketplace");
}

async function writeBase64File(targetPath, contentB64) {
  const buf = Buffer.from(String(contentB64 || ""), "base64");
  await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
  await fsPromises.writeFile(targetPath, buf);
}

function buildSkillInstallError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isMissingPathError(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

function assertSafeSkillId(id) {
  if (
    !id ||
    id === "." ||
    id === ".." ||
    id.includes("/") ||
    id.includes("\\") ||
    path.basename(id) !== id
  ) {
    throw buildSkillInstallError(
      "Skill install target is not a safe local path.",
      "skill_install_path_invalid",
    );
  }
}

function resolveSafeSkillTarget(skillDir, relPath) {
  const raw = String(relPath || "").trim();
  const segments = raw.split("/");
  if (
    !raw ||
    raw.includes("\\") ||
    path.isAbsolute(raw) ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw buildSkillInstallError(
      "Skill bundle contains an unsafe file path.",
      "skill_install_path_invalid",
    );
  }
  const root = path.resolve(skillDir);
  const target = path.resolve(root, ...segments);
  if (!target.startsWith(`${root}${path.sep}`)) {
    throw buildSkillInstallError(
      "Skill bundle contains an unsafe file path.",
      "skill_install_path_invalid",
    );
  }
  return target;
}

async function assertNoSymlinkComponents(projectRoot, targetPath) {
  const root = path.resolve(projectRoot);
  const target = path.resolve(targetPath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw buildSkillInstallError(
      "Skill install target is outside the local project.",
      "skill_install_path_invalid",
    );
  }
  const segments = path.relative(root, target).split(path.sep).filter(Boolean);
  let cursor = root;
  for (let index = 0; index < segments.length; index += 1) {
    cursor = path.join(cursor, segments[index]);
    let stat;
    try {
      stat = await fsPromises.lstat(cursor);
    } catch (error) {
      if (isMissingPathError(error)) return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw buildSkillInstallError(
        "Skill install target contains a symbolic link.",
        "skill_install_symlink",
      );
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw buildSkillInstallError(
        "Skill install target contains a non-directory path component.",
        "skill_install_path_invalid",
      );
    }
  }
}

async function assertNoSymlinksInTree(rootDir) {
  let entries;
  try {
    entries = await fsPromises.readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isSymbolicLink()) {
      throw buildSkillInstallError(
        "Skill install target contains a symbolic link.",
        "skill_install_symlink",
      );
    }
    if (entry.isDirectory()) {
      await assertNoSymlinksInTree(entryPath);
    }
  }
}

async function writeSafeSkillFile(projectRoot, targetPath, content, encoding = undefined) {
  await assertNoSymlinkComponents(projectRoot, path.dirname(targetPath));
  await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
  await assertNoSymlinkComponents(projectRoot, targetPath);
  await fsPromises.writeFile(targetPath, content, encoding);
}

// Tolerantly locate the SKILL.md content within a skill bundle. Marketplace
// solutions are published by several tools, so the markdown may live under a
// few different field names or inside a bundled file entry.
function extractSkillMarkdown(payload, bundle) {
  const candidates = [
    payload.skill_md,
    payload.skillMd,
    payload.skill_markdown,
    payload.markdown,
    payload.content,
    payload.skill,
    bundle?.skill_md,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  // Fall back to a bundled file named SKILL.md (base64 or plain text).
  const fileGroups = [payload.files, payload.references, payload.scripts];
  for (const group of fileGroups) {
    if (!Array.isArray(group)) continue;
    for (const file of group) {
      if (!file || typeof file !== "object") continue;
      const baseName = String(file.path || file.name || "")
        .split("/")
        .pop()
        .toLowerCase();
      if (baseName !== "skill.md") continue;
      if (typeof file.content === "string" && file.content.trim()) {
        return file.content;
      }
      if (typeof file.content_b64 === "string" && file.content_b64.trim()) {
        return Buffer.from(file.content_b64, "base64").toString("utf8");
      }
    }
  }

  return null;
}

async function installSkill({ bundle, deps = {} }) {
  let payload = asObject(bundle?.payload);
  // Some solutions serialize the payload as a JSON string.
  if (!Object.keys(payload).length && typeof bundle?.payload === "string") {
    try {
      payload = asObject(JSON.parse(bundle.payload));
    } catch {
      payload = {};
    }
  }
  const projectRoot = deps.projectRoot;
  if (!projectRoot) {
    throw new Error("installSkill: deps.projectRoot is required");
  }

  const skillMd = extractSkillMarkdown(payload, bundle);
  if (!skillMd) {
    throw new Error(
      "Skill bundle is missing skill content (expected payload.skill_md or a bundled SKILL.md file).",
    );
  }

  const id = sanitizeId(
    canonicalSkillName(payload.name) || canonicalSkillName(bundle?.id) || "",
  );
  if (!id) {
    throw new Error("Skill bundle has no usable name or id.");
  }
  assertSafeSkillId(id);

  const skillRoot = path.resolve(getMarketplaceSkillRoot({ projectRoot }));
  const skillDir = path.resolve(skillRoot, id);
  if (path.dirname(skillDir) !== skillRoot) {
    throw buildSkillInstallError(
      "Skill install target is not a strict marketplace child.",
      "skill_install_path_invalid",
    );
  }

  const plannedFiles = [
    { relPath: "SKILL.md", content: skillMd, encoding: "utf8" },
    {
      relPath: `${id}.yaml`,
      content: buildFallbackSkillMetadataYaml(payload, id, {
        // Prefer the read layer's enriched title (payload.display_name wins
        // inside the builder); solution.name is the kebab id and only a
        // last-resort fallback.
        solutionDisplayName: firstNonEmptyString(
          deps.solution?.display_name,
          deps.solution?.name,
        ),
        // Preserve the listing author so the installed copy keeps its real
        // provenance (otherwise get-skills falls back to the generic
        // "Portico AI Marketplace" owner for ai-marketplace copies).
        solutionAuthor: firstNonEmptyString(
          deps.solution?.submitted_by,
          deps.solution?.submittedBy,
          deps.solution?.author,
          typeof deps.solution?.owner === "string" ? deps.solution.owner : "",
        ),
      }),
      encoding: "utf8",
    },
  ];
  for (const entry of [
    ...(Array.isArray(payload.references) ? payload.references : []),
    ...(Array.isArray(payload.scripts) ? payload.scripts : []),
  ]) {
    if (!entry || typeof entry !== "object") continue;
    const relPath = String(entry.path || "").trim();
    if (!relPath) continue;
    const target = resolveSafeSkillTarget(skillDir, relPath);
    if (target === path.join(skillDir, "SKILL.md")) continue;
    plannedFiles.push({
      relPath,
      content: Buffer.from(String(entry.content_b64 || ""), "base64"),
    });
  }

  const targets = new Set();
  for (const file of plannedFiles) {
    const target = resolveSafeSkillTarget(skillDir, file.relPath);
    if (targets.has(target)) {
      throw buildSkillInstallError(
        "Skill bundle contains duplicate file paths.",
        "skill_install_path_invalid",
      );
    }
    targets.add(target);
    file.target = target;
  }

  await assertNoSymlinkComponents(projectRoot, skillDir);
  await assertNoSymlinksInTree(skillDir);
  for (const file of plannedFiles) {
    await assertNoSymlinkComponents(projectRoot, file.target);
  }
  await fsPromises.mkdir(skillDir, { recursive: true });
  await assertNoSymlinkComponents(projectRoot, skillDir);

  for (const file of plannedFiles) {
    await writeSafeSkillFile(
      projectRoot,
      file.target,
      file.content,
      file.encoding,
    );
  }

  await upsertInstalledSkillRecord({
    projectRoot,
    marketplaceId: AI_MARKETPLACE_SKILL_SOURCE_ID,
    skillId: id,
    localPath: path.relative(projectRoot, skillDir),
    skillPath: "./",
    remoteUpdatedAt: solutionFreshnessStamp(deps.solution),
    skillSource: compactObject({
      type: "ai-marketplace-solution",
      solutionId:
        typeof deps.solutionId === "string" && deps.solutionId.trim()
          ? deps.solutionId.trim()
          : undefined,
      solutionName: firstNonEmptyString(deps.solution?.name, payload.name, bundle?.id),
      detailUrl: firstNonEmptyString(deps.solution?.detail_url),
    }),
  });

  const installedDisplayName =
    [payload.display_name, deps.solution?.display_name]
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .find((value) => value && value !== id) ||
    formatSkillDisplayName(id);

  return {
    type: TYPE_SKILLS,
    id,
    display_name: installedDisplayName,
    installedPath: path.relative(projectRoot, skillDir),
    gitUrl: payload?.source?.git_url || null,
  };
}

async function publishSkillBundle({ skill, projectRoot }) {
  if (!skill) throw new Error("publishSkillBundle: skill is required");
  if (!projectRoot) throw new Error("publishSkillBundle: projectRoot is required");

  const skillDir = skill.path
    ? path.resolve(projectRoot, skill.path)
    : null;
  if (!skillDir) {
    throw new Error(
      "Skill object is missing path. Cannot read SKILL.md for publish.",
    );
  }

  const skillMdPath = path.join(skillDir, "SKILL.md");
  const skillMd = await fsPromises.readFile(skillMdPath, "utf8");

  const references = await collectDirAsBase64(
    path.join(skillDir, "references"),
  );
  const scripts = await collectDirAsBase64(path.join(skillDir, "scripts"));

  const kebabName =
    canonicalSkillName(skill.name) || canonicalSkillName(path.basename(skillDir));
  // Persist a human title in the bundle payload so installs on other
  // machines write pretty sidecars and readers need no derivation. Authored
  // frontmatter wins unless it merely restates the kebab id.
  const frontmatter = parseSkillMarkdownFrontmatter(skillMd) || {};
  const explicitDisplayName = [
    frontmatter.display_name,
    frontmatter.metadata && typeof frontmatter.metadata === "object"
      ? frontmatter.metadata.display_name
      : "",
    skill.display_name,
  ]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find((value) => value && value !== kebabName);

  const payload = {
    name: kebabName,
    display_name: explicitDisplayName || formatSkillDisplayName(kebabName),
    skill_md: skillMd,
    references,
    scripts,
    required_mcp_servers: asArrayOfStrings(skill.required_mcp_servers),
    source: skill.git_url
      ? { git_url: skill.git_url, ref: skill.git_ref || "main", subpath: skill.git_subpath || "" }
      : undefined,
  };

  return { type: TYPE_SKILLS, payload };
}

async function collectDirAsBase64(absDir, { maxFileBytes = 1_048_576 } = {}) {
  const out = [];
  let entries;
  try {
    entries = await fsPromises.readdir(absDir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
    const childPath = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectDirAsBase64(childPath, { maxFileBytes });
      const rootName = path.basename(absDir);
      for (const item of nested) {
        out.push({
          ...item,
          path: `${rootName}/${item.path}`,
        });
      }
      continue;
    }
    const stat = await fsPromises.stat(childPath);
    if (stat.size > maxFileBytes) continue;
    const buf = await fsPromises.readFile(childPath);
    const relPath = `${path.basename(absDir)}/${entry.name}`;
    out.push({
      path: relPath,
      content_b64: buf.toString("base64"),
    });
  }
  return out;
}

// =============================================================================
// MCP SERVERS
// =============================================================================

function getUserMcpServerRoot({ projectRoot }) {
  return path.join(projectRoot, USER_MCP_CONFIG_ROOT);
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return "";
}

function sanitizeRelativePath(relPath) {
  const value = String(relPath || "").trim().replaceAll("\\", "/");
  if (!value || value.includes("..") || path.isAbsolute(value)) {
    return "";
  }
  return value.replace(/^\/+/, "");
}

function isSecretKey(key) {
  const normalized = String(key || "").toLowerCase();
  if (
    /(?:endpoint|url|uri|scope|method|name|env|file|path|host|port|provider)/.test(
      normalized,
    )
  ) {
    return false;
  }
  return /(?:api[_-]?key|token|secret|password|passwd|authorization|credential|bearer)/.test(
    normalized,
  );
}

function redactSecretAssignments(value) {
  return String(value)
    .replace(
      /\b((?:api[_-]?key|token|secret|password|passwd|authorization|credential|bearer)\s*[:=]\s*)(["']?)([^\s"',}]+)/gi,
      `$1$2${REDACTED_SECRET}`,
    )
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, `$1${REDACTED_SECRET}`);
}

function redactSecrets(value, key = "") {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry));
  }
  if (value && typeof value === "object") {
    const redacted = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      redacted[entryKey] = redactSecrets(entryValue, entryKey);
    }
    return redacted;
  }
  if (isSecretKey(key)) {
    return REDACTED_SECRET;
  }
  if (typeof value === "string") {
    return redactSecretAssignments(value);
  }
  return value;
}

function redactMcpFragment(fragment) {
  const raw = firstNonEmptyString(fragment, "{}");
  try {
    return `${JSON.stringify(redactSecrets(JSON.parse(raw)), null, 2)}\n`;
  } catch {
    return redactSecretAssignments(raw);
  }
}

function yamlString(value) {
  return JSON.stringify(String(value || ""));
}

function buildFallbackSkillMetadataYaml(payload, folderId, options = {}) {
  const name = firstNonEmptyString(
    payload.display_name,
    options.solutionDisplayName,
    payload.name,
    folderId,
  );
  const description = firstNonEmptyString(payload.description);
  // The sibling yaml's `owner:` key is what parseSkillDirectoryMetadata maps
  // to the catalog's author (an explicit SKILL.md frontmatter author still
  // wins). Normalize emails to the bare handle so cards read "adamu", not
  // "adamu@example.invalid".
  const owner = firstNonEmptyString(options.solutionAuthor)
    .split("@")[0]
    .trim();
  const lines = [`skill_name: ${yamlString(folderId)}`];
  if (description) {
    lines.push(`description: ${yamlString(description)}`);
  }
  if (name) {
    lines.push(`display_name: ${yamlString(name)}`);
  }
  if (owner) {
    lines.push(`owner: ${yamlString(owner)}`);
  }
  return `${lines.join("\n")}\n`;
}

function buildFallbackMcpServerYaml(payload, folderId) {
  const name = firstNonEmptyString(payload.name, payload.display_name, folderId);
  const description = firstNonEmptyString(payload.description);
  const lines = [
    `name: ${yamlString(name)}`,
    `id: ${yamlString(folderId)}`,
    `display_name: ${yamlString(name)}`,
    'deployment_type: "docker"',
    "user_installed: true",
  ];
  if (description) {
    lines.push(`description: ${yamlString(description)}`);
  }
  return `${lines.join("\n")}\n`;
}

async function readTextFileOrNull(filePath) {
  try {
    return await fsPromises.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function installMcpServer({ bundle, deps = {} }) {
  if (!marketplaceMcpServerInstallsEnabled()) {
    const error = new Error(
      "Installing MCP servers from the AI Marketplace is disabled until the mcp-servers pipeline is fully tested.",
    );
    error.code = "mcp_server_installs_disabled";
    throw error;
  }
  const payload = asObject(bundle?.payload);
  const projectRoot = deps.projectRoot;
  if (!projectRoot) {
    throw new Error("installMcpServer: deps.projectRoot is required");
  }

  const yaml = firstNonEmptyString(
    payload.yaml,
    payload.yaml_content,
    payload.server_yaml,
  );
  const fragment = firstNonEmptyString(
    payload.fragment,
    payload.fragment_json,
    payload.server_fragment,
  );
  const folderId = sanitizeId(
    firstNonEmptyString(
      payload.folder_id,
      payload.id,
      payload.server_id,
      payload.name,
      bundle?.id,
    ),
  );

  if (!folderId) {
    throw new Error("MCP server bundle has no usable id or name.");
  }

  const serverRoot = getUserMcpServerRoot({ projectRoot });
  const serverDir = path.join(serverRoot, folderId);
  await fsPromises.mkdir(serverDir, { recursive: true });

  await fsPromises.writeFile(
    path.join(serverDir, `${folderId}.yaml`),
    yaml || buildFallbackMcpServerYaml(payload, folderId),
    "utf8",
  );
  await fsPromises.writeFile(
    path.join(serverDir, `${folderId}.fragment`),
    fragment || "{}",
    "utf8",
  );

  const setupMarkdown = firstNonEmptyString(
    payload.setup_markdown,
    payload.readme_md,
    payload.markdown,
  );
  if (setupMarkdown) {
    await fsPromises.writeFile(
      path.join(serverDir, `${folderId}.md`),
      setupMarkdown,
      "utf8",
    );
  }

  const iconPngBase64 = firstNonEmptyString(
    payload.icon_png_b64,
    payload.icon_b64,
    payload.icon_base64,
  );
  if (iconPngBase64) {
    await fsPromises.writeFile(
      path.join(serverDir, `${folderId}.png`),
      Buffer.from(iconPngBase64, "base64"),
    );
  }

  const extraFiles = Array.isArray(payload.files) ? payload.files : [];
  for (const entry of extraFiles) {
    if (!entry || typeof entry !== "object") continue;
    const relPath = sanitizeRelativePath(entry.path);
    if (!relPath) continue;
    await writeBase64File(path.join(serverDir, relPath), entry.content_b64);
  }

  return {
    type: TYPE_MCP_SERVERS,
    id: folderId,
    installedPath: path.relative(projectRoot, serverDir),
  };
}

async function publishMcpServerBundle({ server, projectRoot }) {
  if (!server) throw new Error("publishMcpServerBundle: server is required");
  if (!projectRoot) {
    throw new Error("publishMcpServerBundle: projectRoot is required");
  }

  const serverDir = server.path || server.server_path
    ? path.resolve(projectRoot, server.path || server.server_path)
    : null;
  if (!serverDir) {
    throw new Error(
      "Server object is missing path. Cannot read MCP server files for publish.",
    );
  }

  const folderId = path.basename(serverDir);
  const fragment = await readTextFileOrNull(
    path.join(serverDir, `${folderId}.fragment`),
  );

  const payload = {
    id: firstNonEmptyString(server.id, folderId),
    folder_id: folderId,
    name: firstNonEmptyString(server.name, server.display_name, folderId),
    description: firstNonEmptyString(server.description),
    fragment: redactMcpFragment(fragment),
  };

  return { type: TYPE_MCP_SERVERS, payload };
}

// =============================================================================
// HANDLER MAPS
// =============================================================================

const installHandlers = {
  [TYPE_PORTICO_AGENTS]: installAgent,
  [TYPE_SKILL]: installSkill,
  [TYPE_SKILLS]: installSkill,
  [TYPE_MCP_SERVERS]: installMcpServer,
};

const publishBuilders = {
  [TYPE_PORTICO_AGENTS]: publishAgentBundle,
  [TYPE_SKILL]: publishSkillBundle,
  [TYPE_SKILLS]: publishSkillBundle,
  [TYPE_MCP_SERVERS]: publishMcpServerBundle,
};

async function install({ bundle, deps = {} }) {
  const type = bundle?.type;
  const handler = installHandlers[type];
  if (!handler) {
    const error = new Error(
      `No install handler registered for solution type "${type}".`,
    );
    error.code = "type_unknown";
    throw error;
  }
  return await handler({ bundle, deps });
}

async function buildPublishBundle({ type, ...args }) {
  const builder = publishBuilders[type];
  if (!builder) {
    const error = new Error(
      `No publish builder registered for solution type "${type}".`,
    );
    error.code = "type_unknown";
    throw error;
  }
  return await builder(args);
}

function requireInvokeMcpTool() {
  const { invokeMcpTool } = require("./docker-mcp");
  return invokeMcpTool;
}

module.exports = {
  SUBAGENTS_PORT,
  SUBAGENTS_SERVER_ID,
  SUBAGENTS_TOOL_CREATE,
  SUBAGENTS_TOOL_DELETE,
  SUBAGENTS_TOOL_GET,
  SUBAGENTS_TOOL_LIST,
  SUBAGENTS_TOOL_RECONCILE_ATTRIBUTION,
  SUBAGENTS_TOOL_UPDATE,
  TYPE_PORTICO_AGENTS,
  TYPE_MCP_SERVERS,
  TYPE_SKILL,
  TYPE_SKILLS,
  buildPublishBundle,
  install,
  installHandlers,
  publishBuilders,
  sanitizeId,
};
