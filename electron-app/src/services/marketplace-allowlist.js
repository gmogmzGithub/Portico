// Marketplace trust policy — the single source of truth for which git
// marketplace sources may be ADDED to this machine and which skill provenance
// qualifies for agent attachment/publishing.
//
// Scope discipline: this module gates the spread of new marketplaces (add
// paths) and the spread of skills through shared agents (attach/publish
// paths). It is deliberately NOT consulted on sync/update/uninstall of
// marketplaces that already exist in the registry — grandfathered
// marketplaces keep working for personal use.
//
// Dependency-light on purpose (config only): requireable from
// marketplace-service, ipc, and renderer-facing routes without cycle risk.

"use strict";

const {
  GITLAB_MARKETPLACE_AUTH_CONFIG,
} = require("../config/gitlab-marketplace-auth-config");

// The only GitHub repositories that may be added as skill marketplaces.
// Comparison is case-insensitive (GitHub owner/repo lookups are too).
const ALLOWED_GITHUB_REPOS = Object.freeze([
  "anthropics/skills",
  "anthropics/knowledge-work-plugins",
]);

const ALLOWED_GITHUB_REPO_SET = new Set(
  ALLOWED_GITHUB_REPOS.map((repo) => repo.toLowerCase()),
);

// Solutions-marketplace installs are first-party and always qualify.
const AI_MARKETPLACE_ID = "ai-marketplace";

function allowedGitLabHosts() {
  return (GITLAB_MARKETPLACE_AUTH_CONFIG.allowedHosts || []).map((host) =>
    String(host || "").toLowerCase(),
  );
}

function describeAllowedMarketplaceSources() {
  const hosts = allowedGitLabHosts().join(", ");
  return `internal Portico GitLab repositories (${hosts}) and Anthropic's ${ALLOWED_GITHUB_REPOS.join(" and ")} GitHub repositories`;
}

function describeMarketplaceSource(source) {
  if (!source || typeof source !== "object") {
    return "unknown source";
  }
  if (source.type === "github") {
    return `github.com/${source.repo || "unknown"}`;
  }
  if (source.type === "gitlab") {
    return `${source.host || "gitlab"}/${source.projectPath || "unknown"}`;
  }
  if (source.type === "url") {
    return String(source.url || "direct URL");
  }
  return `${source.type || "unknown"} source`;
}

/**
 * Policy predicate over a NORMALIZED marketplace source object
 * ({type: "github"|"gitlab"|"url", ...}). Anything unrecognized is not
 * allowed — fail closed.
 */
function isAllowedMarketplaceSource(source) {
  if (!source || typeof source !== "object") {
    return false;
  }

  if (source.type === "gitlab") {
    const host = String(source.host || "").toLowerCase();
    return Boolean(host) && allowedGitLabHosts().includes(host);
  }

  if (source.type === "github") {
    const repo = String(source.repo || "").toLowerCase();
    return ALLOWED_GITHUB_REPO_SET.has(repo);
  }

  // Direct marketplace.json URLs carry no durable repository identity, so
  // they can never be vetted. GitHub/corp-GitLab URLs already normalize to
  // typed sources before reaching this predicate.
  return false;
}

/**
 * Throws a coded `marketplace_source_not_allowed` error with remediation
 * copy when the source fails the allowlist.
 */
function assertMarketplaceSourceAllowed(source) {
  if (isAllowedMarketplaceSource(source)) {
    return source;
  }

  const error = new Error(
    `Marketplace source ${describeMarketplaceSource(source)} is not an approved source. New skill marketplaces can only be added from ${describeAllowedMarketplaceSources()}.`,
  );
  error.code = "marketplace_source_not_allowed";
  error.sourceType = source?.type || "unknown";
  throw error;
}

/**
 * Whether a skill's provenance qualifies it for agent attachment (and
 * therefore agent publishing). `source` is the catalog source
 * ("system"|"user"|"marketplace"); `registryEntry` is the marketplaces.json
 * entry for `marketplaceId` when the skill is marketplace-installed.
 */
function skillProvenanceQualifies({
  source,
  marketplaceId = null,
  registryEntry = null,
} = {}) {
  if (source === "system" || source === "user") {
    return true;
  }

  if (marketplaceId === AI_MARKETPLACE_ID) {
    return true;
  }

  return isAllowedMarketplaceSource(registryEntry?.source);
}

/**
 * Validate a set of agent skill ids against the provenance policy using a
 * loaded marketplaces config. Pure function — no filesystem, no network.
 *
 * Resolution per id: bare ids are system/user/unknown-local (allowed — an
 * unknown id is inert without a ref); marketplace ids resolve exact-FQN
 * ({mp}/{plugin}/{leaf} or {mp}/{leaf}) against installed records first,
 * then unique-leaf ({mp}/<any plugin>/{leaf}); the matched record's
 * marketplace entry runs through the allowlist. Ids that resolve to a
 * non-qualifying marketplace are rejected with a reason.
 */
function validateAttachableSkillIds(config, skillIds) {
  const marketplacesById = new Map(
    (config?.marketplaces || [])
      .filter((entry) => entry?.id)
      .map((entry) => [entry.id, entry]),
  );
  const installedSkills = Array.isArray(config?.installedSkills)
    ? config.installedSkills
    : [];

  const allowed = [];
  const rejected = [];

  for (const rawId of Array.isArray(skillIds) ? skillIds : []) {
    const id = String(rawId || "").trim();
    if (!id) continue;
    const segments = id.replace(/\\/g, "/").split("/").filter(Boolean);

    if (segments.length < 2) {
      // Bare leaf: system/user skill, or an unknown local id — inert.
      allowed.push(id);
      continue;
    }

    const marketplaceId = segments[0];
    if (marketplaceId === AI_MARKETPLACE_ID) {
      allowed.push(id);
      continue;
    }

    const leaf = segments[segments.length - 1];
    const pluginName = segments.length >= 3 ? segments[1] : null;
    let record =
      installedSkills.find(
        (entry) =>
          entry?.marketplaceId === marketplaceId &&
          entry?.skillId === leaf &&
          (entry?.pluginName || null) === pluginName,
      ) || null;
    if (!record) {
      const leafMatches = installedSkills.filter(
        (entry) => entry?.marketplaceId === marketplaceId && entry?.skillId === leaf,
      );
      if (leafMatches.length === 1) {
        record = leafMatches[0];
      }
    }

    const registryEntry = marketplacesById.get(marketplaceId) || null;
    if (!record && !registryEntry) {
      // Unknown local id: nothing on this machine backs it — inert.
      allowed.push(id);
      continue;
    }

    if (
      skillProvenanceQualifies({
        source: "marketplace",
        marketplaceId,
        registryEntry,
      })
    ) {
      allowed.push(id);
      continue;
    }

    rejected.push({
      id,
      reason: "marketplace_source_not_allowed",
      marketplaceId,
      marketplaceName: registryEntry?.name || marketplaceId,
    });
  }

  return { allowed, rejected };
}

module.exports = {
  ALLOWED_GITHUB_REPOS,
  describeAllowedMarketplaceSources,
  isAllowedMarketplaceSource,
  assertMarketplaceSourceAllowed,
  skillProvenanceQualifies,
  validateAttachableSkillIds,
};
