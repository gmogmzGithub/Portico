const test = require("node:test");
const assert = require("node:assert/strict");

const {
  canonicalSkillName,
  filterSkillsForMode,
  normalizeOwnerIdentity,
  skillHasPublishedLink,
  skillOwnedByViewer,
} = require("./agent-skills-filtering");

test("skill ownership normalizes full emails, bare usernames, and case", () => {
  const skill = { created_by_email: "  DSANTIAGO@example.invalid " };

  assert.equal(normalizeOwnerIdentity(" DSANTIAGO@example.invalid "), "dsantiago");
  assert.equal(normalizeOwnerIdentity("DSANTIAGO"), "dsantiago");
  assert.equal(skillOwnedByViewer(skill, "dsantiago"), true);
  assert.equal(skillOwnedByViewer(skill, "DSANTIAGO@example.invalid"), true);
  assert.equal(skillOwnedByViewer(skill, "someoneelse"), false);
  assert.equal(skillOwnedByViewer({ author: "DSANTIAGO" }, "dsantiago"), false);
});

test("Agent Skills modes classify ownership, publishing, and installation as overlapping facets", () => {
  const corePublished = {
    name: "catalog/core-published",
    source: "system",
    author: "Dionny Santiago",
  };
  const ownedCore = {
    name: "owned-core",
    source: "system",
    created_by_email: "dsantiago@example.invalid",
  };
  const localUser = {
    name: "local-user",
    source: "user",
    created_by_email: "",
  };
  const ownedPublishedUser = {
    name: "owned-published-user",
    source: "user",
    created_by_email: "DSANTIAGO",
  };
  const ownedInstalled = {
    name: "owned-installed",
    source: "marketplace",
    created_by_email: "dsantiago@example.invalid",
    marketplace_solution_id: "sol-owned-installed",
  };
  const foreignInstalled = {
    name: "foreign-installed",
    source: "marketplace",
    created_by_email: "someoneelse@example.invalid",
    marketplace_solution_id: "sol-foreign-installed",
  };
  const descriptiveOwnerOnly = {
    name: "descriptive-owner-only",
    source: "system",
    author: "DSANTIAGO",
  };
  const skills = [
    corePublished,
    ownedCore,
    localUser,
    ownedPublishedUser,
    ownedInstalled,
    foreignInstalled,
    descriptiveOwnerOnly,
  ];
  const marketplaceLinks = {
    "core-published": { solutionId: "sol-core" },
    "owned-published-user": { solutionId: "sol-user" },
    // A same-named registry entry never owns an installed copy. Installed
    // publication state is resolved from its exact marketplace_solution_id.
    "owned-installed": { solutionId: "wrong-same-name-solution" },
  };
  const publishedSolutionIds = new Set([
    "sol-core",
    "sol-user",
    "sol-owned-installed",
  ]);
  const options = {
    viewerIdentity: "DSANTIAGO@example.invalid",
    marketplaceLinks,
    publishedSolutionIds,
  };
  const names = (items) => items.map((skill) => skill.name);

  assert.equal(canonicalSkillName(corePublished.name), "core-published");
  assert.equal(
    skillHasPublishedLink(
      corePublished,
      marketplaceLinks,
      publishedSolutionIds,
    ),
    true,
  );
  assert.deepEqual(names(filterSkillsForMode(skills, "all", options)), names(skills));
  assert.deepEqual(names(filterSkillsForMode(skills, "user", options)), [
    "local-user",
    "owned-published-user",
  ]);
  assert.deepEqual(names(filterSkillsForMode(skills, "published", options)), [
    "catalog/core-published",
    "owned-published-user",
    "owned-installed",
  ]);
  assert.deepEqual(names(filterSkillsForMode(skills, "marketplace", options)), [
    "owned-installed",
    "foreign-installed",
  ]);

  // User is a local editable-source facet; remote publication ownership still
  // comes exclusively from the authoritative solution-id set.
  assert.deepEqual(
    names(
      filterSkillsForMode(skills, "user", {
        viewerIdentity: "",
        marketplaceLinks,
        publishedSolutionIds,
      }),
    ),
    ["local-user", "owned-published-user"],
  );
  assert.deepEqual(
    names(
      filterSkillsForMode(skills, "published", {
        viewerIdentity: "dsantiago",
        marketplaceLinks,
        publishedSolutionIds: new Set(),
      }),
    ),
    [],
  );
});
