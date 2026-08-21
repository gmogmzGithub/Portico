// Round 9: plugin-layout migration of installed marketplace skills — runs on
// every config load inside reconcileInstalledMarketplaceSkills. Contracts
// under test: eligibility (manifest-mapped, non-sparse, non-solutions, flat),
// copy-then-delete moves that survive interruption, per-record degradation
// (a failed record stays flat and functional), idempotence, the atomic
// marketplaces.json save, and content-free diagnostics (sentinel proof).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsPromises = fs.promises;
const os = require("node:os");
const path = require("node:path");

const marketplaceService = require("./marketplace-service");

function createTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "plugin-migration-test-"));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

const SENTINEL = "SENTINEL-9f31-DO-NOT-LOG";

function skillMarkdown(name, { version = "1.0", body = "Body" } = {}) {
  return [
    "---",
    `name: ${name}`,
    `description: ${name} description`,
    `version: "${version}"`,
    "---",
    "",
    `# ${name}`,
    "",
    body,
    "",
  ].join("\n");
}

function writeFlatSkill(projectRoot, marketplaceId, skillId, options = {}) {
  const dir = path.join(projectRoot, "skills-marketplace", marketplaceId, skillId);
  fs.mkdirSync(path.join(dir, "references"), { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), skillMarkdown(skillId, options));
  fs.writeFileSync(
    path.join(dir, "references", "guide.md"),
    options.referenceBody || "reference body",
  );
  return dir;
}

function baseConfig({ marketplaces, installedSkills }) {
  return { version: "1.0", marketplaces, installedSkills };
}

function pluginMarketplaceEntry(overrides = {}) {
  return {
    id: "kwp",
    name: "kwp",
    source: { type: "github", repo: "anthropics/knowledge-work-plugins", ref: "main" },
    isSparse: false,
    cachedManifest: {
      name: "kwp",
      plugins: [
        {
          name: "document-skills",
          description: "Documents",
          skills: ["./document-skills/skills/pdf", "./document-skills/skills/docx"],
        },
      ],
    },
    ...overrides,
  };
}

function flatRecord(skillId, overrides = {}) {
  return {
    marketplaceId: "kwp",
    skillId,
    skillPath: `./document-skills/skills/${skillId}`,
    installedVersion: "1.0",
    lastCheckedVersion: "1.0",
    hasUpdate: false,
    installedAt: "2026-01-01T00:00:00.000Z",
    localPath: `skills-marketplace/kwp/${skillId}`,
    ...overrides,
  };
}

function writeConfig(projectRoot, config) {
  fs.writeFileSync(
    path.join(projectRoot, "marketplaces.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  );
}

function readConfig(projectRoot) {
  return JSON.parse(
    fs.readFileSync(path.join(projectRoot, "marketplaces.json"), "utf8"),
  );
}

test("a flat manifest-mapped record migrates into the plugin layout exactly once (idempotent)", async () => {
  const projectRoot = createTempRoot();
  try {
    writeFlatSkill(projectRoot, "kwp", "pdf");
    writeConfig(
      projectRoot,
      baseConfig({
        marketplaces: [pluginMarketplaceEntry()],
        installedSkills: [flatRecord("pdf")],
      }),
    );

    await marketplaceService.loadMarketplacesConfig(projectRoot, {
      logger: { warn() {}, log() {}, info() {} },
    });

    const migrated = readConfig(projectRoot).installedSkills[0];
    assert.equal(migrated.pluginName, "document-skills");
    assert.equal(migrated.localPath, "skills-marketplace/kwp/document-skills/pdf");
    const newDir = path.join(projectRoot, migrated.localPath);
    assert.equal(fs.existsSync(path.join(newDir, "SKILL.md")), true);
    assert.equal(fs.existsSync(path.join(newDir, "references", "guide.md")), true);
    assert.equal(
      fs.existsSync(path.join(projectRoot, "skills-marketplace/kwp/pdf")),
      false,
      "old flat dir removed after the copy completed",
    );

    // Second load: no-op (same config bytes, same layout).
    const before = fs.readFileSync(path.join(projectRoot, "marketplaces.json"), "utf8");
    await marketplaceService.loadMarketplacesConfig(projectRoot, {
      logger: { warn() {}, log() {}, info() {} },
    });
    const after = fs.readFileSync(path.join(projectRoot, "marketplaces.json"), "utf8");
    assert.equal(after, before, "second run is a no-op");
  } finally {
    cleanup(projectRoot);
  }
});

test("a dirty skill migrates intact and stays dirty (dir-relative baseline carries over)", async () => {
  const projectRoot = createTempRoot();
  try {
    const dir = writeFlatSkill(projectRoot, "kwp", "pdf");
    // Baseline captures the pristine content; then dirty the local copy.
    const crypto = require("node:crypto");
    const pristine = fs.readFileSync(path.join(dir, "SKILL.md"));
    const reference = fs.readFileSync(path.join(dir, "references", "guide.md"));
    const baseline = {
      version: "1.0",
      files: [
        { path: "SKILL.md", sha256: crypto.createHash("sha256").update(pristine).digest("hex") },
        { path: "references/guide.md", sha256: crypto.createHash("sha256").update(reference).digest("hex") },
      ],
    };
    fs.appendFileSync(path.join(dir, "SKILL.md"), "\nlocal edit\n");
    writeConfig(
      projectRoot,
      baseConfig({
        marketplaces: [pluginMarketplaceEntry()],
        installedSkills: [flatRecord("pdf", { baseline })],
      }),
    );

    const config = await marketplaceService.loadMarketplacesConfig(projectRoot, {
      logger: { warn() {}, log() {}, info() {} },
    });
    const migrated = config.installedSkills[0];
    assert.equal(migrated.pluginName, "document-skills");
    assert.equal(migrated.isDirty, true, "dirtiness carried across the move");
    const movedContent = fs.readFileSync(
      path.join(projectRoot, migrated.localPath, "SKILL.md"),
      "utf8",
    );
    assert.match(movedContent, /local edit/, "the local edit moved with the skill");
  } finally {
    cleanup(projectRoot);
  }
});

test("sparse and solutions records never migrate; occupied destinations skip and stay functional", async () => {
  const projectRoot = createTempRoot();
  try {
    writeFlatSkill(projectRoot, "sparse-mp", "alpha");
    writeFlatSkill(projectRoot, "ai-marketplace", "notes");
    writeFlatSkill(projectRoot, "kwp", "pdf");
    // Occupy pdf's destination with foreign content.
    const occupied = path.join(
      projectRoot,
      "skills-marketplace/kwp/document-skills/pdf",
    );
    fs.mkdirSync(occupied, { recursive: true });
    fs.writeFileSync(path.join(occupied, "unrelated.txt"), "occupied");

    writeConfig(
      projectRoot,
      baseConfig({
        marketplaces: [
          pluginMarketplaceEntry(),
          {
            id: "sparse-mp",
            name: "sparse-mp",
            source: { type: "github", repo: "anthropics/skills", ref: "main" },
            isSparse: true,
            cachedManifest: {
              name: "sparse-mp",
              plugins: [
                { name: "sparse-mp", skills: ["./skills/alpha"] },
              ],
            },
          },
        ],
        installedSkills: [
          {
            marketplaceId: "sparse-mp",
            skillId: "alpha",
            skillPath: "./skills/alpha",
            installedVersion: "1.0",
            localPath: "skills-marketplace/sparse-mp/alpha",
          },
          {
            marketplaceId: "ai-marketplace",
            skillId: "notes",
            skillPath: "./",
            installedVersion: "1.0",
            localPath: "skills-marketplace/ai-marketplace/notes",
            skillSource: { type: "ai-marketplace-solution", solutionId: "sol-1" },
          },
          flatRecord("pdf"),
        ],
      }),
    );

    const config = await marketplaceService.loadMarketplacesConfig(projectRoot, {
      logger: { warn() {}, log() {}, info() {} },
    });

    const byId = new Map(config.installedSkills.map((r) => [`${r.marketplaceId}/${r.skillId}`, r]));
    assert.equal(byId.get("sparse-mp/alpha").pluginName ?? null, null);
    assert.equal(byId.get("sparse-mp/alpha").localPath, "skills-marketplace/sparse-mp/alpha");
    assert.equal(byId.get("ai-marketplace/notes").pluginName ?? null, null);
    // Occupied destination: record stays flat AND functional; foreign content untouched.
    const pdf = byId.get("kwp/pdf");
    assert.equal(pdf.pluginName ?? null, null);
    assert.equal(pdf.localPath, "skills-marketplace/kwp/pdf");
    assert.equal(
      fs.existsSync(path.join(projectRoot, "skills-marketplace/kwp/pdf/SKILL.md")),
      true,
    );
    assert.equal(fs.readFileSync(path.join(occupied, "unrelated.txt"), "utf8"), "occupied");
  } finally {
    cleanup(projectRoot);
  }
});

test("a failing move degrades to flat-and-functional with no half-moved directory, and the config still loads", async () => {
  const projectRoot = createTempRoot();
  try {
    writeFlatSkill(projectRoot, "kwp", "pdf");
    writeFlatSkill(projectRoot, "kwp", "docx");
    writeConfig(
      projectRoot,
      baseConfig({
        marketplaces: [pluginMarketplaceEntry()],
        installedSkills: [flatRecord("pdf"), flatRecord("docx")],
      }),
    );

    // Fail the copy for pdf only; docx migrates normally.
    const originalCp = fsPromises.cp;
    fsPromises.cp = async (source, destination, options) => {
      if (String(source).endsWith(`${path.sep}pdf`)) {
        await fsPromises.mkdir(destination, { recursive: true });
        await fsPromises.writeFile(path.join(destination, "partial.md"), "partial");
        throw new Error("injected migration copy failure");
      }
      return originalCp(source, destination, options);
    };
    let config;
    try {
      config = await marketplaceService.loadMarketplacesConfig(projectRoot, {
        logger: { warn() {}, log() {}, info() {} },
      });
    } finally {
      fsPromises.cp = originalCp;
    }

    const byId = new Map(config.installedSkills.map((r) => [r.skillId, r]));
    // pdf: flat and functional, half-copy rolled back.
    assert.equal(byId.get("pdf").pluginName ?? null, null);
    assert.equal(
      fs.existsSync(path.join(projectRoot, "skills-marketplace/kwp/pdf/SKILL.md")),
      true,
      "source untouched on failure",
    );
    assert.equal(
      fs.existsSync(path.join(projectRoot, "skills-marketplace/kwp/document-skills/pdf")),
      false,
      "half-moved destination rolled back",
    );
    // docx migrated fine in the same pass.
    assert.equal(byId.get("docx").pluginName, "document-skills");
    assert.equal(
      fs.existsSync(
        path.join(projectRoot, "skills-marketplace/kwp/document-skills/docx/SKILL.md"),
      ),
      true,
    );

    // The failed record self-heals on the next (unbroken) load.
    const healed = await marketplaceService.loadMarketplacesConfig(projectRoot, {
      logger: { warn() {}, log() {}, info() {} },
    });
    const healedPdf = healed.installedSkills.find((r) => r.skillId === "pdf");
    assert.equal(healedPdf.pluginName, "document-skills");
  } finally {
    cleanup(projectRoot);
  }
});

test("saveMarketplacesConfig stages + renames: a failed rename leaves the previous config intact", async () => {
  const projectRoot = createTempRoot();
  try {
    const original = baseConfig({ marketplaces: [], installedSkills: [] });
    writeConfig(projectRoot, original);
    const before = fs.readFileSync(path.join(projectRoot, "marketplaces.json"), "utf8");

    const originalRename = fsPromises.rename;
    fsPromises.rename = async () => {
      throw new Error("injected rename failure");
    };
    try {
      await assert.rejects(
        marketplaceService.saveMarketplacesConfig(projectRoot, {
          version: "1.0",
          marketplaces: [{ id: "new" }],
          installedSkills: [],
        }),
        /injected rename failure/,
      );
    } finally {
      fsPromises.rename = originalRename;
    }

    assert.equal(
      fs.readFileSync(path.join(projectRoot, "marketplaces.json"), "utf8"),
      before,
      "previous config bytes intact",
    );
    const leftovers = fs
      .readdirSync(projectRoot)
      .filter((name) => name.includes(".stage-"));
    assert.deepEqual(leftovers, [], "staging file cleaned up");
  } finally {
    cleanup(projectRoot);
  }
});

test("corrupt marketplaces.json still loads by rebuilding from bundled defaults", async () => {
  const projectRoot = createTempRoot();
  try {
    // Bundled defaults present + corrupt live config → rebuild, not a crash.
    fs.writeFileSync(
      path.join(projectRoot, "marketplaces-ootb.json"),
      JSON.stringify(baseConfig({ marketplaces: [pluginMarketplaceEntry()], installedSkills: [] })),
    );
    fs.writeFileSync(path.join(projectRoot, "marketplaces.json"), "{ not json !!!");

    const config = await marketplaceService.loadMarketplacesConfig(projectRoot, {
      logger: { warn() {}, log() {}, info() {} },
    });
    assert.equal(config.marketplaces.length, 1);
    assert.equal(config.marketplaces[0].id, "kwp");
    // The rebuilt config was persisted and parses.
    assert.equal(readConfig(projectRoot).marketplaces[0].id, "kwp");
  } finally {
    cleanup(projectRoot);
  }
});

test("migration and scan diagnostics never leak skill bodies or descriptions (sentinel proof)", async () => {
  const projectRoot = createTempRoot();
  const captured = [];
  const originals = {};
  for (const level of ["log", "warn", "error", "info"]) {
    originals[level] = console[level];
    console[level] = (...args) => {
      captured.push(args.map((value) => String(value)).join(" "));
    };
  }
  try {
    writeFlatSkill(projectRoot, "kwp", "pdf", {
      body: SENTINEL,
      referenceBody: SENTINEL,
    });
    // Also plant the sentinel in manifest descriptions.
    const entry = pluginMarketplaceEntry();
    entry.cachedManifest.plugins[0].description = SENTINEL;
    writeConfig(
      projectRoot,
      baseConfig({ marketplaces: [entry], installedSkills: [flatRecord("pdf")] }),
    );

    // Migration pass (uses the default console logger + diagnostics).
    const config = await marketplaceService.loadMarketplacesConfig(projectRoot);
    assert.equal(config.installedSkills[0].pluginName, "document-skills");
    // Catalog pass over the migrated layout.
    marketplaceService.parseSkillsFromManifest(entry.cachedManifest, "kwp");

    const joined = captured.join("\n");
    assert.ok(captured.length > 0, "diagnostics were captured");
    assert.ok(
      !joined.includes(SENTINEL),
      "no skill body, reference content, or description reached the logs",
    );
  } finally {
    for (const [level, original] of Object.entries(originals)) {
      console[level] = original;
    }
    cleanup(projectRoot);
  }
});

test("records ahead of the disk self-heal: plugin-scoped record + flat directory moves into place", async () => {
  const projectRoot = createTempRoot();
  try {
    // The registry already says plugin-layout (e.g. merged from new OOTB
    // seeds by an older app) but the payload still sits at the flat path.
    writeFlatSkill(projectRoot, "kwp", "pdf");
    writeConfig(
      projectRoot,
      baseConfig({
        marketplaces: [pluginMarketplaceEntry()],
        installedSkills: [
          flatRecord("pdf", {
            pluginName: "document-skills",
            localPath: "skills-marketplace/kwp/document-skills/pdf",
          }),
        ],
      }),
    );

    const config = await marketplaceService.loadMarketplacesConfig(projectRoot, {
      logger: { warn() {}, log() {}, info() {} },
    });
    const record = config.installedSkills[0];
    assert.equal(record.pluginName, "document-skills");
    assert.equal(
      fs.existsSync(
        path.join(projectRoot, "skills-marketplace/kwp/document-skills/pdf/SKILL.md"),
      ),
      true,
      "flat payload moved to the record's plugin path",
    );
    assert.equal(
      fs.existsSync(path.join(projectRoot, "skills-marketplace/kwp/pdf")),
      false,
      "flat dir removed after the repair",
    );
    // Hydration works against the repaired path (record functional).
    assert.equal(record.isDirty, false);

    // Second load: stable.
    const before = fs.readFileSync(path.join(projectRoot, "marketplaces.json"), "utf8");
    await marketplaceService.loadMarketplacesConfig(projectRoot, {
      logger: { warn() {}, log() {}, info() {} },
    });
    assert.equal(
      fs.readFileSync(path.join(projectRoot, "marketplaces.json"), "utf8"),
      before,
    );
  } finally {
    cleanup(projectRoot);
  }
});

// --- nested destinations: plugin named exactly like its skill leaf ------------
// Real incident (Zach, debug_logs_1786555911): the "a11y" plugin contains a
// skill named "a11y", so the migration destination sits INSIDE the flat
// source; fs.cp refused with ERR_FS_CP_EINVAL on every load forever. These
// cover the rename-through-staging move and its crash recovery, all through
// the public loadMarketplacesConfig API.

function nestedMarketplaceEntry(overrides = {}) {
  return {
    id: "amp",
    name: "amp",
    source: { type: "github", repo: "example/amp", ref: "main" },
    isSparse: false,
    cachedManifest: {
      name: "amp",
      plugins: [
        {
          name: "a11y",
          description: "Accessibility",
          skills: ["./community/a11y/skills/a11y"],
        },
      ],
    },
    ...overrides,
  };
}

function nestedFlatRecord(overrides = {}) {
  return {
    marketplaceId: "amp",
    skillId: "a11y",
    skillPath: "./community/a11y/skills/a11y",
    installedVersion: "1.0",
    lastCheckedVersion: "1.0",
    hasUpdate: false,
    installedAt: "2026-01-01T00:00:00.000Z",
    localPath: "skills-marketplace/amp/a11y",
    ...overrides,
  };
}

// Like writeFlatSkill but at an arbitrary relative path — fabricates staging
// dirs and completed destinations for the crash-window tests.
function writeSkillDirAt(projectRoot, relPath, name, options = {}) {
  const dir = path.join(projectRoot, ...relPath.split("/"));
  fs.mkdirSync(path.join(dir, "references"), { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), skillMarkdown(name, options));
  fs.writeFileSync(
    path.join(dir, "references", "guide.md"),
    options.referenceBody || "reference body",
  );
  return dir;
}

test("nested destination migrates via renames and stays put (idempotent)", async () => {
  const projectRoot = createTempRoot();
  try {
    writeFlatSkill(projectRoot, "amp", "a11y");
    writeConfig(
      projectRoot,
      baseConfig({
        marketplaces: [nestedMarketplaceEntry()],
        installedSkills: [nestedFlatRecord()],
      }),
    );

    await marketplaceService.loadMarketplacesConfig(projectRoot, {
      logger: { warn() {}, log() {}, info() {} },
    });

    const migrated = readConfig(projectRoot).installedSkills[0];
    assert.equal(migrated.pluginName, "a11y");
    assert.equal(migrated.localPath, "skills-marketplace/amp/a11y/a11y");
    const dest = path.join(projectRoot, "skills-marketplace/amp/a11y/a11y");
    assert.equal(fs.existsSync(path.join(dest, "SKILL.md")), true);
    assert.equal(fs.existsSync(path.join(dest, "references", "guide.md")), true);
    // The vacated flat name is now the plugin parent holding only the leaf.
    assert.deepEqual(
      fs.readdirSync(path.join(projectRoot, "skills-marketplace/amp/a11y")).sort(),
      ["a11y"],
    );
    // No staging leftovers.
    assert.deepEqual(
      fs
        .readdirSync(path.join(projectRoot, "skills-marketplace/amp"))
        .filter((name) => name.startsWith(".")),
      [],
    );

    const before = fs.readFileSync(path.join(projectRoot, "marketplaces.json"), "utf8");
    await marketplaceService.loadMarketplacesConfig(projectRoot, {
      logger: { warn() {}, log() {}, info() {} },
    });
    assert.equal(
      fs.readFileSync(path.join(projectRoot, "marketplaces.json"), "utf8"),
      before,
      "second run is a no-op",
    );
  } finally {
    cleanup(projectRoot);
  }
});

test("crash between the renames self-heals: staging-only payload resumes to the destination", async () => {
  const projectRoot = createTempRoot();
  try {
    // Mid-move state: flat record, flat dir already renamed away, payload
    // parked at the deterministic staging path.
    writeSkillDirAt(projectRoot, "skills-marketplace/amp/.a11y.plugin-migrate", "a11y");
    writeConfig(
      projectRoot,
      baseConfig({
        marketplaces: [nestedMarketplaceEntry()],
        installedSkills: [nestedFlatRecord()],
      }),
    );

    await marketplaceService.loadMarketplacesConfig(projectRoot, {
      logger: { warn() {}, log() {}, info() {} },
    });

    const migrated = readConfig(projectRoot).installedSkills[0];
    assert.equal(migrated.pluginName, "a11y");
    assert.equal(migrated.localPath, "skills-marketplace/amp/a11y/a11y");
    assert.equal(
      fs.existsSync(
        path.join(projectRoot, "skills-marketplace/amp/a11y/a11y/SKILL.md"),
      ),
      true,
      "parked payload finished its move",
    );
    assert.equal(
      fs.existsSync(
        path.join(projectRoot, "skills-marketplace/amp/.a11y.plugin-migrate"),
      ),
      false,
      "staging dir consumed",
    );
  } finally {
    cleanup(projectRoot);
  }
});

test("crash after the final rename self-heals: the record adopts the completed destination", async () => {
  const projectRoot = createTempRoot();
  try {
    // Post-move, pre-save state: payload complete at the destination, flat
    // record never rewritten, no flat dir, no staging.
    writeSkillDirAt(projectRoot, "skills-marketplace/amp/a11y/a11y", "a11y");
    writeConfig(
      projectRoot,
      baseConfig({
        marketplaces: [nestedMarketplaceEntry()],
        installedSkills: [nestedFlatRecord()],
      }),
    );

    await marketplaceService.loadMarketplacesConfig(projectRoot, {
      logger: { warn() {}, log() {}, info() {} },
    });

    const config = readConfig(projectRoot);
    assert.equal(config.installedSkills.length, 1, "no duplicate record minted");
    assert.equal(config.installedSkills[0].pluginName, "a11y");
    assert.equal(
      config.installedSkills[0].localPath,
      "skills-marketplace/amp/a11y/a11y",
    );
    assert.equal(
      fs.existsSync(
        path.join(projectRoot, "skills-marketplace/amp/a11y/a11y/SKILL.md"),
      ),
      true,
    );
  } finally {
    cleanup(projectRoot);
  }
});

test("a stale staging dir is discarded when the flat source is authoritative", async () => {
  const projectRoot = createTempRoot();
  try {
    writeFlatSkill(projectRoot, "amp", "a11y", { body: "fresh" });
    writeSkillDirAt(
      projectRoot,
      "skills-marketplace/amp/.a11y.plugin-migrate",
      "a11y",
      { body: "stale" },
    );
    writeConfig(
      projectRoot,
      baseConfig({
        marketplaces: [nestedMarketplaceEntry()],
        installedSkills: [nestedFlatRecord()],
      }),
    );

    await marketplaceService.loadMarketplacesConfig(projectRoot, {
      logger: { warn() {}, log() {}, info() {} },
    });

    const moved = fs.readFileSync(
      path.join(projectRoot, "skills-marketplace/amp/a11y/a11y/SKILL.md"),
      "utf8",
    );
    assert.match(moved, /fresh/, "the authoritative source won");
    assert.equal(
      fs.existsSync(
        path.join(projectRoot, "skills-marketplace/amp/.a11y.plugin-migrate"),
      ),
      false,
      "stale staging removed",
    );
  } finally {
    cleanup(projectRoot);
  }
});

test("nested repair: plugin-scoped record + flat payload moves into place", async () => {
  const projectRoot = createTempRoot();
  try {
    writeFlatSkill(projectRoot, "amp", "a11y");
    writeConfig(
      projectRoot,
      baseConfig({
        marketplaces: [nestedMarketplaceEntry()],
        installedSkills: [
          nestedFlatRecord({
            pluginName: "a11y",
            localPath: "skills-marketplace/amp/a11y/a11y",
          }),
        ],
      }),
    );

    await marketplaceService.loadMarketplacesConfig(projectRoot, {
      logger: { warn() {}, log() {}, info() {} },
    });

    assert.equal(
      fs.existsSync(
        path.join(projectRoot, "skills-marketplace/amp/a11y/a11y/SKILL.md"),
      ),
      true,
      "flat payload repaired into the record's nested path",
    );

    const before = fs.readFileSync(path.join(projectRoot, "marketplaces.json"), "utf8");
    await marketplaceService.loadMarketplacesConfig(projectRoot, {
      logger: { warn() {}, log() {}, info() {} },
    });
    assert.equal(
      fs.readFileSync(path.join(projectRoot, "marketplaces.json"), "utf8"),
      before,
      "second run is a no-op",
    );
  } finally {
    cleanup(projectRoot);
  }
});

test("nested repair resumes a parked staging payload", async () => {
  const projectRoot = createTempRoot();
  try {
    writeSkillDirAt(projectRoot, "skills-marketplace/amp/.a11y.plugin-migrate", "a11y");
    writeConfig(
      projectRoot,
      baseConfig({
        marketplaces: [nestedMarketplaceEntry()],
        installedSkills: [
          nestedFlatRecord({
            pluginName: "a11y",
            localPath: "skills-marketplace/amp/a11y/a11y",
          }),
        ],
      }),
    );

    await marketplaceService.loadMarketplacesConfig(projectRoot, {
      logger: { warn() {}, log() {}, info() {} },
    });

    assert.equal(
      fs.existsSync(
        path.join(projectRoot, "skills-marketplace/amp/a11y/a11y/SKILL.md"),
      ),
      true,
      "repair finished the interrupted move",
    );
    assert.equal(
      fs.existsSync(
        path.join(projectRoot, "skills-marketplace/amp/.a11y.plugin-migrate"),
      ),
      false,
    );
  } finally {
    cleanup(projectRoot);
  }
});

test("a failed second rename rolls back to flat-and-functional, then heals next load", async () => {
  const projectRoot = createTempRoot();
  try {
    writeFlatSkill(projectRoot, "amp", "a11y");
    writeConfig(
      projectRoot,
      baseConfig({
        marketplaces: [nestedMarketplaceEntry()],
        installedSkills: [nestedFlatRecord()],
      }),
    );

    // Fail ONLY the staging->destination rename; rename 1 (into staging) and
    // the config save's stage rename pass through untouched.
    const originalRename = fsPromises.rename;
    fsPromises.rename = async (source, destination) => {
      if (String(destination).endsWith(path.join("a11y", "a11y"))) {
        throw new Error("injected nested rename failure");
      }
      return originalRename(source, destination);
    };
    let config;
    try {
      config = await marketplaceService.loadMarketplacesConfig(projectRoot, {
        logger: { warn() {}, log() {}, info() {} },
      });
    } finally {
      fsPromises.rename = originalRename;
    }

    // Flat and functional: source restored, nothing half-moved, no staging.
    assert.equal(config.installedSkills[0].pluginName ?? null, null);
    assert.equal(
      config.installedSkills[0].localPath,
      "skills-marketplace/amp/a11y",
    );
    assert.equal(
      fs.existsSync(path.join(projectRoot, "skills-marketplace/amp/a11y/SKILL.md")),
      true,
      "source restored on rollback",
    );
    assert.equal(
      fs.existsSync(path.join(projectRoot, "skills-marketplace/amp/a11y/a11y")),
      false,
      "no half-moved destination",
    );
    assert.equal(
      fs.existsSync(
        path.join(projectRoot, "skills-marketplace/amp/.a11y.plugin-migrate"),
      ),
      false,
      "staging renamed back, not leaked",
    );

    // Unpatched second load migrates fully.
    const healed = await marketplaceService.loadMarketplacesConfig(projectRoot, {
      logger: { warn() {}, log() {}, info() {} },
    });
    assert.equal(healed.installedSkills[0].pluginName, "a11y");
    assert.equal(
      fs.existsSync(
        path.join(projectRoot, "skills-marketplace/amp/a11y/a11y/SKILL.md"),
      ),
      true,
    );
  } finally {
    cleanup(projectRoot);
  }
});

test("a failed first rename leaves the source untouched and heals next load", async () => {
  const projectRoot = createTempRoot();
  try {
    writeFlatSkill(projectRoot, "amp", "a11y");
    writeConfig(
      projectRoot,
      baseConfig({
        marketplaces: [nestedMarketplaceEntry()],
        installedSkills: [nestedFlatRecord()],
      }),
    );

    const originalRename = fsPromises.rename;
    fsPromises.rename = async (source, destination) => {
      if (String(destination).includes(".plugin-migrate")) {
        throw new Error("injected staging rename failure");
      }
      return originalRename(source, destination);
    };
    let config;
    try {
      config = await marketplaceService.loadMarketplacesConfig(projectRoot, {
        logger: { warn() {}, log() {}, info() {} },
      });
    } finally {
      fsPromises.rename = originalRename;
    }

    assert.equal(config.installedSkills[0].pluginName ?? null, null);
    assert.equal(
      fs.existsSync(path.join(projectRoot, "skills-marketplace/amp/a11y/SKILL.md")),
      true,
      "source untouched",
    );

    const healed = await marketplaceService.loadMarketplacesConfig(projectRoot, {
      logger: { warn() {}, log() {}, info() {} },
    });
    assert.equal(healed.installedSkills[0].pluginName, "a11y");
  } finally {
    cleanup(projectRoot);
  }
});

test("nested migration honors the occupied-key check with zero filesystem writes", async () => {
  const projectRoot = createTempRoot();
  try {
    // A plugin-scoped record already owns the (amp, a11y, a11y) identity and
    // its payload; the flat record must skip BEFORE touching the disk.
    writeFlatSkill(projectRoot, "amp", "a11y", { body: "flat-copy" });
    writeSkillDirAt(projectRoot, "skills-marketplace/amp/a11y/a11y", "a11y", {
      body: "plugin-copy",
    });
    writeConfig(
      projectRoot,
      baseConfig({
        marketplaces: [nestedMarketplaceEntry()],
        installedSkills: [
          nestedFlatRecord(),
          nestedFlatRecord({
            pluginName: "a11y",
            localPath: "skills-marketplace/amp/a11y/a11y",
          }),
        ],
      }),
    );

    const config = await marketplaceService.loadMarketplacesConfig(projectRoot, {
      logger: { warn() {}, log() {}, info() {} },
    });

    const flat = config.installedSkills.find((r) => !r.pluginName);
    assert.ok(flat, "flat record survived, unmigrated");
    assert.equal(flat.localPath, "skills-marketplace/amp/a11y");
    const flatContent = fs.readFileSync(
      path.join(projectRoot, "skills-marketplace/amp/a11y/SKILL.md"),
      "utf8",
    );
    assert.match(flatContent, /flat-copy/, "flat payload untouched");
    const pluginContent = fs.readFileSync(
      path.join(projectRoot, "skills-marketplace/amp/a11y/a11y/SKILL.md"),
      "utf8",
    );
    assert.match(pluginContent, /plugin-copy/, "plugin payload untouched");
    assert.equal(
      fs.existsSync(
        path.join(projectRoot, "skills-marketplace/amp/.a11y.plugin-migrate"),
      ),
      false,
      "no staging dir created for the skipped record",
    );
  } finally {
    cleanup(projectRoot);
  }
});
