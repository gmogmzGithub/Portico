// Marketplace trust policy (round 9): the allowlist predicate over normalized
// sources and the skill-provenance qualifier that gates agent attachment.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ALLOWED_GITHUB_REPOS,
  isAllowedMarketplaceSource,
  assertMarketplaceSourceAllowed,
  skillProvenanceQualifies,
  describeAllowedMarketplaceSources,
} = require("./marketplace-allowlist");
const {
  normalizeMarketplaceSourceInput,
} = require("./marketplace-service");

test("every corp GitLab and Anthropic input form normalizes into the allowlist", () => {
  const allowedInputs = [
    // Corp GitLab: SSH scp-style, ssh:// URL, HTTPS repo/tree/blob URLs.
    "git@example.invalid:community/portico-ai-marketplace.git",
    "ssh://git@example.invalid/community/portico-ai-marketplace.git",
    "https://example.invalid/community/portico-ai-marketplace",
    "https://example.invalid/community/portico-ai-marketplace/-/tree/main",
    // Anthropic repos: shorthand, HTTPS, SSH, .git suffix, mixed case.
    "anthropics/skills",
    "anthropics/knowledge-work-plugins",
    "https://github.com/anthropics/skills",
    "https://github.com/Anthropics/Knowledge-Work-Plugins.git",
    "git@github.com:anthropics/skills.git",
  ];

  for (const input of allowedInputs) {
    const source = normalizeMarketplaceSourceInput(input, {
      allowDirectUrlSource: true,
      allowSparseFileUrl: true,
    });
    assert.equal(
      isAllowedMarketplaceSource(source),
      true,
      `expected allowed: ${input}`,
    );
    assert.equal(assertMarketplaceSourceAllowed(source), source);
  }
});

test("other GitHub repos, direct URLs, and malformed sources are rejected fail-closed", () => {
  const rejectedInputs = [
    "zstevens/portico-skills-marketplace",
    "https://github.com/example/random-skills",
    "git@github.com:example/random-skills.git",
    "https://example.com/.atlas-plugin/marketplace.json",
  ];

  for (const input of rejectedInputs) {
    const source = normalizeMarketplaceSourceInput(input, {
      allowDirectUrlSource: true,
      allowSparseFileUrl: true,
    });
    assert.equal(
      isAllowedMarketplaceSource(source),
      false,
      `expected rejected: ${input}`,
    );
    assert.throws(
      () => assertMarketplaceSourceAllowed(source),
      (error) => {
        assert.equal(error.code, "marketplace_source_not_allowed");
        assert.match(error.message, /example\.invalid/);
        for (const repo of ALLOWED_GITHUB_REPOS) {
          assert.ok(error.message.includes(repo), `message names ${repo}`);
        }
        return true;
      },
    );
  }

  // Non-source garbage never qualifies.
  assert.equal(isAllowedMarketplaceSource(null), false);
  assert.equal(isAllowedMarketplaceSource("anthropics/skills"), false);
  assert.equal(isAllowedMarketplaceSource({ type: "mystery" }), false);
  assert.equal(isAllowedMarketplaceSource({ type: "gitlab", host: "" }), false);
  assert.equal(
    isAllowedMarketplaceSource({ type: "gitlab", host: "gitlab.com" }),
    false,
  );
});

test("skillProvenanceQualifies: system/user/solutions always, git only via the allowlist", () => {
  assert.equal(skillProvenanceQualifies({ source: "system" }), true);
  assert.equal(skillProvenanceQualifies({ source: "user" }), true);
  assert.equal(
    skillProvenanceQualifies({
      source: "marketplace",
      marketplaceId: "ai-marketplace",
    }),
    true,
  );
  assert.equal(
    skillProvenanceQualifies({
      source: "marketplace",
      marketplaceId: "anthropic-agent-skills",
      registryEntry: {
        source: { type: "github", repo: "Anthropics/Skills" },
      },
    }),
    true,
  );
  assert.equal(
    skillProvenanceQualifies({
      source: "marketplace",
      marketplaceId: "corp-skills",
      registryEntry: {
        source: {
          type: "gitlab",
          host: "example.invalid",
          projectPath: "community/skills",
        },
      },
    }),
    true,
  );
  // Non-qualifying: unlisted github repo, url source, or no registry entry.
  assert.equal(
    skillProvenanceQualifies({
      source: "marketplace",
      marketplaceId: "zstevens-portico-skills",
      registryEntry: {
        source: { type: "github", repo: "zstevens/portico-skills-marketplace" },
      },
    }),
    false,
  );
  assert.equal(
    skillProvenanceQualifies({
      source: "marketplace",
      marketplaceId: "url-market",
      registryEntry: { source: { type: "url", url: "https://x/marketplace.json" } },
    }),
    false,
  );
  assert.equal(
    skillProvenanceQualifies({
      source: "marketplace",
      marketplaceId: "ghost-marketplace",
      registryEntry: null,
    }),
    false,
  );
});

test("the remediation copy names every allowed source", () => {
  const copy = describeAllowedMarketplaceSources();
  assert.match(copy, /example\.invalid/);
  for (const repo of ALLOWED_GITHUB_REPOS) {
    assert.ok(copy.includes(repo));
  }
});

test("validateAttachableSkillIds resolves exact-FQN, unique-leaf, and inert unknowns against the registry", () => {
  const { validateAttachableSkillIds } = require("./marketplace-allowlist");
  const config = {
    marketplaces: [
      {
        id: "kwp",
        name: "Knowledge Work Plugins",
        source: { type: "github", repo: "anthropics/knowledge-work-plugins" },
      },
      {
        id: "shady",
        name: "Shady Skills",
        source: { type: "github", repo: "attacker/skills" },
      },
    ],
    installedSkills: [
      { marketplaceId: "kwp", skillId: "pdf", pluginName: "document-skills" },
      { marketplaceId: "shady", skillId: "exfil", pluginName: null },
      { marketplaceId: "shady", skillId: "android", pluginName: "plugin-a" },
      { marketplaceId: "shady", skillId: "android", pluginName: "plugin-b" },
    ],
  };

  const result = validateAttachableSkillIds(config, [
    "web-search", // bare id → system/user/unknown-local → allowed
    "ai-marketplace/notes", // Solutions install → allowed
    "kwp/document-skills/pdf", // exact FQN on an allowlisted marketplace
    "kwp/pdf", // legacy unique-leaf on an allowlisted marketplace
    "shady/exfil", // grandfathered install, unapproved source → rejected
    "shady/plugin-a/android", // exact FQN, unapproved → rejected
    "ghost-marketplace/skill", // nothing local backs it → inert, allowed
  ]);

  assert.deepEqual(result.allowed, [
    "web-search",
    "ai-marketplace/notes",
    "kwp/document-skills/pdf",
    "kwp/pdf",
    "ghost-marketplace/skill",
  ]);
  assert.deepEqual(
    result.rejected.map((entry) => [entry.id, entry.reason, entry.marketplaceName]),
    [
      ["shady/exfil", "marketplace_source_not_allowed", "Shady Skills"],
      ["shady/plugin-a/android", "marketplace_source_not_allowed", "Shady Skills"],
    ],
  );

  // A marketplace entry with no matching record still rejects by registry
  // provenance (the id names a non-qualifying marketplace).
  const registryOnly = validateAttachableSkillIds(config, ["shady/unknown-leaf"]);
  assert.equal(registryOnly.rejected.length, 1);
});
