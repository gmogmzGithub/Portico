// Chat UI layer: provenance badges for the composer metrics "Active skills"
// panel. The chip set/order must mirror the control plane's provenance table
// (electron-app agents.js agentViewSkillRowChipsHtml): marketplace installs
// show their where-from chips only (GIT off Solutions Marketplace, then the
// marketplace name — every active skill is installed, so INSTALLED is
// dropped here), user skills lead with USER (+PUBLISHED when linked), system
// skills are CORE, and unenriched skills render unbadged. Row labels prefix
// the plugin ("A11y → Skill") when the install ships inside one.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { build } = require("../electron-app/node_modules/esbuild");

const REPO_ROOT = path.resolve(__dirname, "..");

let tempDir;
let badges;

const bundleModule = async (entryPath, outFile) => {
  await build({
    entryPoints: [path.join(REPO_ROOT, entryPath)],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: ["node20"],
    logLevel: "silent",
    outfile: outFile,
    alias: {
      "$lib": path.join(REPO_ROOT, "src/patches/frontend/src/lib"),
    },
  });

  return require(outFile);
};

before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "active-skill-badges-tests-"));
  badges = await bundleModule(
    "src/patches/frontend/src/lib/utils/activeSkillBadges.ts",
    path.join(tempDir, "activeSkillBadges.cjs"),
  );
});

after(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

const kinds = (skill) => badges.activeSkillBadges(skill).map((b) => b.kind);
const labels = (skill) => badges.activeSkillBadges(skill).map((b) => b.label);

test("system skills badge as CORE", () => {
  assert.deepEqual(
    badges.activeSkillBadges({ name: "code-execution", display_name: "Code Execution", source: "system" }),
    [{ kind: "core", label: "Core" }],
  );
});

test("user skills badge as USER, plus PUBLISHED when linked to a listing", () => {
  assert.deepEqual(kinds({ name: "my-skill", display_name: "My Skill", source: "user" }), ["user"]);
  assert.deepEqual(
    kinds({
      name: "architecture-diagrams",
      display_name: "Architecture Diagrams",
      source: "user",
      marketplace_relationship: "published",
    }),
    ["user", "published"],
  );
});

test("Solutions Marketplace installs badge the marketplace name only — no INSTALLED, no GIT", () => {
  const skill = {
    name: "ai-marketplace/chief-of-staff",
    display_name: "Chief Of Staff",
    source: "marketplace",
    marketplace_relationship: "installed",
    marketplace_id: "ai-marketplace",
  };
  assert.deepEqual(kinds(skill), ["marketplace-name"]);
  assert.deepEqual(labels(skill), ["Solutions Marketplace"]);
});

test("git-marketplace installs badge GIT + repo id — no INSTALLED", () => {
  const skill = {
    name: "anthropic-agent-skills/document-skills/docx",
    display_name: "Docx",
    source: "marketplace",
    marketplace_relationship: "installed",
    marketplace_id: "anthropic-agent-skills",
  };
  assert.deepEqual(kinds(skill), ["git", "marketplace-name"]);
  assert.deepEqual(labels(skill), ["Git", "anthropic-agent-skills"]);
});

test("marketplace installs without a resolved marketplace id render unbadged", () => {
  assert.deepEqual(
    kinds({ name: "mystery", display_name: "Mystery", source: "marketplace", marketplace_id: null }),
    [],
  );
});

test("unenriched skills render unbadged", () => {
  assert.deepEqual(kinds({ name: "some-skill", display_name: "Some Skill" }), []);
  assert.deepEqual(kinds({ name: "x", display_name: "X", source: null }), []);
});

test("source rank mirrors the control-plane skill-table grouping", () => {
  const rank = badges.activeSkillSourceRank;
  const system = { name: "code-execution", display_name: "Code Execution", source: "system" };
  const user = { name: "arch", display_name: "Arch", source: "user" };
  const solutions = {
    name: "ai-marketplace/chief-of-staff",
    display_name: "Chief Of Staff",
    source: "marketplace",
    marketplace_id: "ai-marketplace",
  };
  const git = {
    name: "data-plat-skills/iql-query-writing",
    display_name: "IQL Query Writing",
    source: "marketplace",
    marketplace_id: "data-plat-skills",
  };
  const unenriched = { name: "mystery", display_name: "Mystery" };

  // Core/system → user → Solutions installs → git installs → unenriched.
  assert.ok(rank(system) < rank(user));
  assert.ok(rank(user) < rank(solutions));
  assert.ok(rank(solutions) < rank(git));
  assert.ok(rank(git) < rank(unenriched));

  // The full comparator (rank, then label) reproduces the control-plane order.
  const rows = [git, unenriched, user, solutions, system];
  const sorted = rows
    .map((s) => ({ s, label: badges.activeSkillRowLabel(s) }))
    .sort((a, b) => rank(a.s) - rank(b.s) || a.label.localeCompare(b.label))
    .map((r) => r.label);
  assert.deepEqual(sorted, [
    "Code Execution",
    "Arch",
    "Chief Of Staff",
    "IQL Query Writing",
    "Mystery",
  ]);
});

test("row label is the friendly leaf name; namespaced fallbacks drop the path prefix", () => {
  // Enriched: backend sends the frontmatter leaf display name.
  assert.equal(
    badges.activeSkillRowLabel({
      name: "portico-ai-marketplace/a11y/a11y",
      display_name: "A11Y",
      source: "marketplace",
    }),
    "A11Y",
  );
  // Unenriched fallback: title-cased full path collapses to its leaf.
  assert.equal(
    badges.activeSkillRowLabel({
      name: "anthropic-agent-skills/document-skills/docx",
      display_name: "Anthropic Agent Skills/Document Skills/Docx",
    }),
    "Docx",
  );
  assert.equal(
    badges.activeSkillRowLabel({ name: "iql-query-writing", display_name: "Iql Query Writing" }),
    "IQL Query Writing",
  );
});

test("plugin installs read as Plugin → Skill in the row label", () => {
  assert.equal(
    badges.activeSkillRowLabel({
      name: "portico-ai-marketplace/a11y/fixing-jira-a11y-in-bulk",
      display_name: "Fixing Jira A11y In Bulk",
      source: "marketplace",
      marketplace_id: "portico-ai-marketplace",
      plugin_name: "a11y",
    }),
    "A11y → Fixing Jira A11y In Bulk",
  );
  // No plugin → plain leaf label, no arrow.
  assert.equal(
    badges.activeSkillRowLabel({
      name: "ai-marketplace/chief-of-staff",
      display_name: "Chief Of Staff",
      source: "marketplace",
      marketplace_id: "ai-marketplace",
      plugin_name: null,
    }),
    "Chief Of Staff",
  );
});
