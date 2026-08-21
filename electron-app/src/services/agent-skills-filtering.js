// Pure Agent Skills filter helpers shared by the renderer and Node unit tests.
// Keep ownership separate from descriptive author metadata: created_by_email
// is the app-owned attribution field, while author is display content.

function canonicalSkillName(localSkillName) {
  const parts = String(localSkillName || "")
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
  return parts.at(-1) || "";
}

function normalizeOwnerIdentity(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";
  const at = normalized.indexOf("@");
  return at === -1 ? normalized : normalized.slice(0, at).trim();
}

function skillOwnedByViewer(skill, viewerIdentity) {
  const owner = normalizeOwnerIdentity(skill?.created_by_email || "");
  const viewer = normalizeOwnerIdentity(viewerIdentity);
  return Boolean(owner && viewer) && owner === viewer;
}

function marketplaceSolutionIdForSkill(skill, marketplaceLinks = {}) {
  if (skill?.source === "marketplace") {
    return String(skill?.marketplace_solution_id || "").trim();
  }
  const canonicalName = canonicalSkillName(skill?.name);
  return String(marketplaceLinks?.[canonicalName]?.solutionId || "").trim();
}

function skillHasPublishedLink(
  skill,
  marketplaceLinks = {},
  publishedSolutionIds = new Set(),
) {
  const solutionId = marketplaceSolutionIdForSkill(skill, marketplaceLinks);
  return Boolean(
    solutionId &&
      publishedSolutionIds instanceof Set &&
      publishedSolutionIds.has(solutionId),
  );
}

function skillMatchesFilter(
  skill,
  filter = "all",
  {
    viewerIdentity = "",
    marketplaceLinks = {},
    publishedSolutionIds = new Set(),
  } = {},
) {
  switch (filter) {
    case "user":
      return skill?.source === "user";
    case "published":
      return skillHasPublishedLink(
        skill,
        marketplaceLinks,
        publishedSolutionIds,
      );
    case "marketplace":
      return skill?.source === "marketplace";
    default:
      return true;
  }
}

function filterSkillsForMode(skills, filter, options = {}) {
  return (Array.isArray(skills) ? skills : []).filter((skill) =>
    skillMatchesFilter(skill, filter, options),
  );
}

module.exports = {
  canonicalSkillName,
  filterSkillsForMode,
  marketplaceSolutionIdForSkill,
  normalizeOwnerIdentity,
  skillHasPublishedLink,
  skillMatchesFilter,
  skillOwnedByViewer,
};
