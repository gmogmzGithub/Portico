const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const CONFIG_PATH = path.join(REPO_ROOT, "marketplaces-ootb", "marketplaces.json");
const SKILLS_ROOT = path.join(
  REPO_ROOT,
  "marketplaces-ootb",
  "skills-marketplace",
  "anthropic-agent-skills",
);

function listRegularFiles(root, relative = "") {
  const directory = path.join(root, relative);
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, "en"))
    .flatMap((entry) => {
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const entryPath = path.join(root, entryRelative);
      const stat = fs.lstatSync(entryPath);
      assert.equal(stat.isSymbolicLink(), false, `bundled skill must not contain a symlink: ${entryRelative}`);
      if (stat.isDirectory()) return listRegularFiles(root, entryRelative);
      assert.equal(stat.isFile(), true, `bundled skill must contain regular files only: ${entryRelative}`);
      return [entryRelative];
    });
}

test("the checked-in marketplace seed uses a public provider-neutral source", () => {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  assert.deepEqual(config.marketplaces.map((entry) => entry.id), ["anthropic-agent-skills"]);
  assert.equal(config.installedSkills?.length ?? 0, 0);

  const marketplace = config.marketplaces[0];
  assert.deepEqual(marketplace.source, {
    type: "github",
    repo: "anthropics/skills",
    repoUrl: "https://github.com/anthropics/skills",
    ref: "main",
  });
  assert.equal(marketplace.ootb, true);
  assert.equal(marketplace.isOfficial, false);
});

test("the public marketplace seed contains regular, readable skill files", () => {
  const files = listRegularFiles(SKILLS_ROOT);
  assert.ok(files.length > 0, "public marketplace payload is present");

  const skillFiles = files.filter((relativePath) => relativePath.endsWith("/SKILL.md"));
  assert.ok(skillFiles.length >= 5, "public marketplace includes example skills");
  for (const relativePath of skillFiles) {
    const body = fs.readFileSync(path.join(SKILLS_ROOT, relativePath), "utf8");
    assert.match(body, /^---\n/, `${relativePath} has frontmatter`);
  }
});

test("the public seed does not carry organization-owned marketplace identities", () => {
  const configText = fs.readFileSync(CONFIG_PATH, "utf8");
  assert.doesNotMatch(configText, /(^|[^A-Za-z])(private|internal)([^A-Za-z]|$)/i);
  assert.doesNotMatch(configText, /community|enterprise-ai-chat/i);
});
