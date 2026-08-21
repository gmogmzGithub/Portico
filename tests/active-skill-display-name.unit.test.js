const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { build } = require("../electron-app/node_modules/esbuild");

const REPO_ROOT = path.resolve(__dirname, "..");
const ACTIVE_CAPABILITIES_PATH = path.join(
  REPO_ROOT,
  "src/patches/frontend/src/lib/components/chat/ActiveCapabilities.svelte",
);

let tempDir;
let displayNameUtils;

const bundleModule = async (entryPath, outFile) => {
  await build({
    entryPoints: [path.join(REPO_ROOT, entryPath)],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: ["node20"],
    logLevel: "silent",
    outfile: outFile,
  });

  return require(outFile);
};

before(async () => {
  tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "active-skill-display-name-tests-"),
  );
  displayNameUtils = await bundleModule(
    "src/patches/frontend/src/lib/utils/activeSkillDisplayName.ts",
    path.join(tempDir, "activeSkillDisplayName.cjs"),
  );
});

after(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("active skill formatter preserves LM Studio acronym casing", () => {
  assert.equal(
    displayNameUtils.formatActiveSkillDisplayName("lm-studio-setup"),
    "LM Studio Setup",
  );
  assert.equal(
    displayNameUtils.formatActiveSkillDisplayName("Lm Studio Setup"),
    "LM Studio Setup",
  );
});

test("active skill formatter title-cases slash-delimited marketplace skill ids", () => {
  assert.equal(
    displayNameUtils.formatActiveSkillDisplayName(
      "data-plat-skills/trino-query-writing",
    ),
    "Data Plat Skills/Trino Query Writing",
  );
});

test("active skill formatter repairs partially formatted slash-delimited labels", () => {
  assert.equal(
    displayNameUtils.formatActiveSkillDisplayName(
      "Data Plat Skills/trino Query writing",
    ),
    "Data Plat Skills/Trino Query Writing",
  );
});

test("active skill formatter keeps slash-delimited acronyms readable", () => {
  assert.equal(
    displayNameUtils.formatActiveSkillDisplayName(
      "data-plat-skills/iql-query-writing",
    ),
    "Data Plat Skills/IQL Query Writing",
  );
  assert.equal(
    displayNameUtils.formatActiveSkillDisplayName(
      "data-plat-skills/mcp-server-management",
    ),
    "Data Plat Skills/MCP Server Management",
  );
});

test("splitActiveSkillDisplayName splits on the last slash with skill-name priority", () => {
  const { splitActiveSkillDisplayName } = displayNameUtils;

  // No slash → marketplace null.
  assert.deepEqual(splitActiveSkillDisplayName({ name: "lm-studio-setup" }), {
    marketplace: null,
    skillName: "LM Studio Setup",
  });

  // Single-slash marketplace id.
  assert.deepEqual(
    splitActiveSkillDisplayName({ name: "data-plat-skills/trino-query-writing" }),
    { marketplace: "Data Plat Skills", skillName: "Trino Query Writing" },
  );

  // Pre-formatted display_name with a slash splits identically.
  assert.deepEqual(
    splitActiveSkillDisplayName({
      name: "data-plat-skills/trino-query-writing",
      display_name: "Data Plat Skills/Trino Query Writing",
    }),
    { marketplace: "Data Plat Skills", skillName: "Trino Query Writing" },
  );

  // Multiple slashes: split on the LAST; interior slash stays in marketplace.
  assert.deepEqual(
    splitActiveSkillDisplayName({ display_name: "Acme/Data Tools/Query Writer" }),
    { marketplace: "Acme/Data Tools", skillName: "Query Writer" },
  );

  // Acronym-bearing skill halves keep their casing.
  assert.deepEqual(
    splitActiveSkillDisplayName({ name: "data-plat-skills/iql-query-writing" }),
    { marketplace: "Data Plat Skills", skillName: "IQL Query Writing" },
  );
});

test("splitActiveSkillDisplayName collapses degenerate labels to skill-name only", () => {
  const { splitActiveSkillDisplayName } = displayNameUtils;

  // Leading/trailing slashes are stripped by the formatter before splitting.
  assert.deepEqual(splitActiveSkillDisplayName({ display_name: "/Solo Skill" }), {
    marketplace: null,
    skillName: "Solo Skill",
  });
  assert.deepEqual(splitActiveSkillDisplayName({ display_name: "Acme/" }), {
    marketplace: null,
    skillName: "Acme",
  });

  // Whitespace around segments is trimmed.
  assert.deepEqual(
    splitActiveSkillDisplayName({ display_name: "  Acme Marketplace / Query Writer  " }),
    { marketplace: "Acme Marketplace", skillName: "Query Writer" },
  );

  // Empty skill object stays renderable.
  assert.deepEqual(splitActiveSkillDisplayName({}), {
    marketplace: null,
    skillName: "",
  });
});

test("active capabilities tooltip uses the shared active skill display formatter", async () => {
  const source = await fs.readFile(ACTIVE_CAPABILITIES_PATH, "utf8");

  assert.match(source, /resolveActiveSkillDisplayName/);
  assert.match(source, /display_label: resolveActiveSkillDisplayName\(skill\)/);
});
