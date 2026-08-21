const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildSiblingYamlTriggers,
  formatSkillDisplayName,
  getSkillVersionFromFrontmatter,
  parseSkillDirectoryMetadata,
  parseSkillMarkdownFrontmatter,
} = require("./skill-frontmatter");

test("parseSkillMarkdownFrontmatter accepts duplicate keys with last-one-wins semantics", () => {
  const frontmatter = parseSkillMarkdownFrontmatter([
    "---",
    "name: shared-trino",
    "description: Shared Trino skill",
    'author: "first-author"',
    'author: "second-author"',
    "---",
    "# Shared Trino",
    "",
  ].join("\n"));

  assert.equal(frontmatter.author, "second-author");
});

test("getSkillVersionFromFrontmatter prefers metadata.version and falls back to top-level version", () => {
  assert.equal(
    getSkillVersionFromFrontmatter({ metadata: { version: "3.0.0" }, version: "2.1.0" }, "1.0"),
    "3.0.0",
  );
  assert.equal(
    getSkillVersionFromFrontmatter({ version: "2.1.0" }, "1.0"),
    "2.1.0",
  );
  assert.equal(getSkillVersionFromFrontmatter(null, "1.0"), "1.0");
});

test("buildSiblingYamlTriggers preserves topic/domain order and dedupes repeated values", () => {
  assert.deepEqual(
    buildSiblingYamlTriggers({
      domain: "data-platform",
      topic: "trino",
    }),
    ["trino", "data-platform"],
  );
  assert.deepEqual(
    buildSiblingYamlTriggers({
      domain: "trino",
      topic: "trino",
    }),
    ["trino"],
  );
});

test("formatSkillDisplayName preserves common acronyms", () => {
  assert.equal(formatSkillDisplayName("lm-studio-setup"), "LM Studio Setup");
  assert.equal(formatSkillDisplayName("mcp api tool"), "MCP API Tool");
  // 2026-08-03 incident additions — lockstep with skill-card-renderer.js and
  // rust skills_catalog.rs.
  assert.equal(formatSkillDisplayName("gtm-brief-qa"), "GTM Brief QA");
  assert.equal(formatSkillDisplayName("gtm-icp-lookup"), "GTM ICP Lookup");
});

test("parseSkillDirectoryMetadata keeps inline frontmatter unchanged", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-frontmatter-inline-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const skillDir = path.join(root, "pdf");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      "name: pdf",
      "display_name: PDF Parser",
      "description: Parse PDFs",
      'author: "frontend-team"',
      "priority: high",
      "---",
      "# PDF",
      "",
    ].join("\n"),
  );

  const metadata = await parseSkillDirectoryMetadata(skillDir);

  assert.deepEqual(metadata, {
    name: "pdf",
    display_name: "PDF Parser",
    description: "Parse PDFs",
    author: "frontend-team",
    priority: "high",
  });
});

test("parseSkillDirectoryMetadata merges sibling YAML display metadata into inline frontmatter when missing", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-frontmatter-inline-merged-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const skillDir = path.join(root, "n8nkit");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      "name: n8nkit",
      "description: Inline description should win",
      "---",
      "# n8nkit",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(skillDir, "n8nkit.yaml"),
    [
      'skill_name: "n8nkit"',
      'display_name: "n8nkit Runtime Surface"',
      'description: "Sibling description should only backfill"',
      'owner: "solutions-marketplace"',
      "",
    ].join("\n"),
  );

  const metadata = await parseSkillDirectoryMetadata(skillDir);

  assert.deepEqual(metadata, {
    name: "n8nkit",
    display_name: "n8nkit Runtime Surface",
    description: "Inline description should win",
    author: "solutions-marketplace",
  });
});

test("parseSkillDirectoryMetadata loads sparse sibling YAML metadata with top-level fields", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-frontmatter-sparse-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const skillDir = path.join(root, "trino-query-writing");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Trino Query Writing\n");
  fs.writeFileSync(
    path.join(skillDir, "trino-query-writing.yaml"),
    [
      "skill_name: trino-query-writing",
      "domain: data-platform",
      "topic: trino",
      "description: Reference for writing Trino queries against Datalake",
      "owner: data-platform",
      "",
    ].join("\n"),
  );

  const metadata = await parseSkillDirectoryMetadata(skillDir);

  assert.deepEqual(metadata, {
    name: "trino-query-writing",
    description: "Reference for writing Trino queries against Datalake",
    author: "data-platform",
    priority: "medium",
    triggers: ["trino", "data-platform"],
  });
  assert.equal(metadata.metadata, undefined);
  assert.equal(
    String(metadata.name)
      .split(/[-_/]/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" "),
    "Trino Query Writing",
  );
});

test("parseSkillDirectoryMetadata maps display_name from a sidecar-only skill", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-frontmatter-sidecar-title-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const skillDir = path.join(root, "epic-voice-booster");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "Raw body without frontmatter\n");
  fs.writeFileSync(
    path.join(skillDir, "epic-voice-booster.yaml"),
    [
      'skill_name: "epic-voice-booster"',
      'description: "Elevates ordinary text"',
      'display_name: "Epic Voice Booster"',
      "",
    ].join("\n"),
  );

  const metadata = await parseSkillDirectoryMetadata(skillDir);
  assert.equal(metadata.display_name, "Epic Voice Booster");
  assert.equal(metadata.name, "epic-voice-booster");
});

test("parseSkillDirectoryMetadata rejects sibling YAML missing skill_name", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-frontmatter-missing-name-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const skillDir = path.join(root, "trino-query-writing");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Trino Query Writing\n");
  fs.writeFileSync(
    path.join(skillDir, "trino-query-writing.yaml"),
    [
      "domain: data-platform",
      "topic: trino",
      "description: Missing skill_name should reject this skill",
      "",
    ].join("\n"),
  );

  assert.equal(await parseSkillDirectoryMetadata(skillDir), null);
});

test("parseSkillDirectoryMetadata rejects sibling YAML missing description", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-frontmatter-missing-description-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const skillDir = path.join(root, "trino-query-writing");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Trino Query Writing\n");
  fs.writeFileSync(
    path.join(skillDir, "trino-query-writing.yaml"),
    [
      "skill_name: trino-query-writing",
      "domain: data-platform",
      "topic: trino",
      "",
    ].join("\n"),
  );

  assert.equal(await parseSkillDirectoryMetadata(skillDir), null);
});

test("parseSkillDirectoryMetadata synthesizes metadata for plain installed skills", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-frontmatter-plain-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const skillDir = path.join(root, "plain-skill");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "# Plain Skill\nUse this imported marketplace skill when needed.\n",
  );

  assert.deepEqual(await parseSkillDirectoryMetadata(skillDir), {
    name: "plain-skill",
    display_name: "Plain Skill",
    description: "Use this imported marketplace skill when needed.",
    priority: "medium",
    triggers: [],
  });
});
