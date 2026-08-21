const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  ensureBundledMarketplaceDefaults,
  mergeCachedManifestAdditions,
} = require("./marketplace-ootb");

async function withTempProject(fn) {
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "marketplace-ootb-adoption-"),
  );
  try {
    return await fn(projectRoot);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeSkill(projectRoot, baseDir, extraFiles = {}) {
  const skillDir = path.join(
    projectRoot,
    baseDir,
    "portico-ai-marketplace",
    "content-quality",
  );
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nmetadata:\n  version: 2.0.0\n---\n# Content Quality\n",
    "utf8",
  );
  for (const [relativePath, content] of Object.entries(extraFiles)) {
    const filePath = path.join(skillDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
  }
  return skillDir;
}

function ootbConfig() {
  return {
    version: "1.0",
    marketplaces: [
      {
        id: "portico-ai-marketplace",
        name: "portico-ai-marketplace",
        cachedManifest: {
          plugins: [
            {
              name: "ux-quality-beta",
              description: "Bundled UX quality skills",
              skills: [
                "./community/ux-quality-beta/skills/content-quality",
                "./community/ux-quality-beta/skills/ux-quality",
              ],
            },
          ],
        },
      },
    ],
    installedSkills: [
      {
        skillId: "content-quality",
        marketplaceId: "portico-ai-marketplace",
        skillPath: "./community/ux-quality-beta/skills/content-quality",
        skillSource: null,
        installedVersion: "2.0.0",
        localPath:
          "skills-marketplace/portico-ai-marketplace/content-quality",
        lastCheckedVersion: "2.0.0",
        hasUpdate: false,
        baseline: null,
      },
    ],
  };
}

function installedContentSkill(config) {
  return config.installedSkills.find(
    (entry) =>
      entry.marketplaceId === "portico-ai-marketplace" &&
      entry.skillId === "content-quality",
  );
}

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

test("cached manifest merge is additive and preserves live metadata", () => {
  const existing = {
    name: "live-cache",
    owner: { name: "Live Owner" },
    plugins: [
      {
        name: "ux-quality-beta",
        description: "Live description",
        skills: ["./community/ux-quality-beta/skills/content-quality"],
      },
      {
        name: "live-only",
        skills: ["./live-only/skill"],
      },
    ],
  };
  const ootb = {
    name: "bundled-cache",
    plugins: [
      {
        name: "ux-quality-beta",
        description: "Bundled description",
        skills: [
          "./community/ux-quality-beta/skills/content-quality",
          "./community/ux-quality-beta/skills/ux-quality",
        ],
      },
      {
        name: "bundled-only",
        skills: ["./bundled-only/skill"],
      },
    ],
  };

  const merged = mergeCachedManifestAdditions(existing, ootb);
  assert.equal(merged.name, "live-cache");
  assert.deepEqual(merged.owner, { name: "Live Owner" });
  assert.equal(merged.plugins[0].description, "Live description");
  assert.deepEqual(merged.plugins[0].skills, [
    "./community/ux-quality-beta/skills/content-quality",
    "./community/ux-quality-beta/skills/ux-quality",
  ]);
  assert.deepEqual(merged.plugins[1], existing.plugins[1]);
  assert.deepEqual(merged.plugins[2], ootb.plugins[1]);
  assert.equal(mergeCachedManifestAdditions(merged, ootb), merged);
});

test("absent bundled skill is seeded and recorded", async () => {
  await withTempProject(async (projectRoot) => {
    writeJson(path.join(projectRoot, "marketplaces-ootb.json"), ootbConfig());
    writeSkill(projectRoot, "skills-marketplace-ootb", {
      "references/rubric.md": "bundled",
    });

    const result = await ensureBundledMarketplaceDefaults(projectRoot);
    assert.equal(result.updated, true);
    assert.equal(result.restoredFromBundledDefaults, true);

    const liveConfig = readJson(path.join(projectRoot, "marketplaces.json"));
    assert.ok(installedContentSkill(liveConfig));
    assert.equal(
      fs.readFileSync(
        path.join(
          projectRoot,
          "skills-marketplace/portico-ai-marketplace/content-quality/references/rubric.md",
        ),
        "utf8",
      ),
      "bundled",
    );
  });
});

test("differing orphan directory is preserved without inventing an installed record", async () => {
  await withTempProject(async (projectRoot) => {
    writeJson(path.join(projectRoot, "marketplaces-ootb.json"), ootbConfig());
    writeSkill(projectRoot, "skills-marketplace-ootb", {
      "references/rubric.md": "bundled",
    });
    writeSkill(projectRoot, "skills-marketplace", {
      "references/rubric.md": "local orphan",
      "local-only.md": "preserve me",
    });

    await ensureBundledMarketplaceDefaults(projectRoot, {
      logger: { warn() {} },
    });

    assert.equal(
      fs.readFileSync(
        path.join(
          projectRoot,
          "skills-marketplace/portico-ai-marketplace/content-quality/references/rubric.md",
        ),
        "utf8",
      ),
      "local orphan",
    );
    assert.equal(
      fs.existsSync(
        path.join(
          projectRoot,
          "skills-marketplace/portico-ai-marketplace/content-quality/local-only.md",
        ),
      ),
      true,
    );
    const liveConfig = readJson(path.join(projectRoot, "marketplaces.json"));
    assert.equal(installedContentSkill(liveConfig), undefined);
  });
});

test("identical orphan directory converges by adopting the bundled record", async () => {
  await withTempProject(async (projectRoot) => {
    writeJson(path.join(projectRoot, "marketplaces-ootb.json"), ootbConfig());
    writeSkill(projectRoot, "skills-marketplace-ootb", {
      "references/rubric.md": "same",
    });
    writeSkill(projectRoot, "skills-marketplace", {
      "references/rubric.md": "same",
    });

    await ensureBundledMarketplaceDefaults(projectRoot);

    const liveConfig = readJson(path.join(projectRoot, "marketplaces.json"));
    const installed = installedContentSkill(liveConfig);
    assert.ok(installed);
    assert.equal(installed.installedVersion, "2.0.0");
  });
});

test("differing recorded skill preserves both files and the entire installed record", async () => {
  await withTempProject(async (projectRoot) => {
    const bundled = ootbConfig();
    writeJson(path.join(projectRoot, "marketplaces-ootb.json"), bundled);
    writeSkill(projectRoot, "skills-marketplace-ootb", {
      "references/rubric.md": "bundled",
    });
    const liveSkillDir = writeSkill(projectRoot, "skills-marketplace", {
      "references/rubric.md": "locally modified",
      "local-only.md": "preserve me",
    });
    const liveSkillMarkdown = fs.readFileSync(
      path.join(liveSkillDir, "SKILL.md"),
    );
    const existingRecord = {
      ...bundled.installedSkills[0],
      installedVersion: "1.5.0",
      lastCheckedVersion: "1.6.0",
      hasUpdate: true,
      hasConflict: true,
      isDirty: true,
      baseline: {
        generatedAt: "2026-01-01T00:00:00.000Z",
        version: "1.5.0",
        sourceRef: "main",
        files: [
          {
            path: "SKILL.md",
            sha256: sha256(liveSkillMarkdown),
          },
        ],
      },
      customRuntimeField: "keep",
    };
    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: bundled.marketplaces,
      installedSkills: [existingRecord],
    });

    await ensureBundledMarketplaceDefaults(projectRoot, {
      logger: { warn() {} },
    });

    const liveConfig = readJson(path.join(projectRoot, "marketplaces.json"));
    assert.deepEqual(installedContentSkill(liveConfig), existingRecord);
    assert.equal(
      fs.readFileSync(
        path.join(liveSkillDir, "references/rubric.md"),
        "utf8",
      ),
      "locally modified",
    );
  });
});

test("failed seed copy removes staging, skips only that entry, and converges on retry", async () => {
  await withTempProject(async (projectRoot) => {
    writeJson(path.join(projectRoot, "marketplaces-ootb.json"), ootbConfig());
    writeSkill(projectRoot, "skills-marketplace-ootb", {
      "references/rubric.md": "bundled",
    });

    const originalCp = fs.promises.cp;
    fs.promises.cp = async (_source, target) => {
      await fs.promises.mkdir(target, { recursive: true });
      await fs.promises.writeFile(path.join(target, "partial.md"), "partial");
      throw new Error("injected seed copy failure");
    };
    try {
      // Round 9: one throwing seed entry no longer aborts the config load —
      // the load resolves with that entry skipped (unapplied).
      const result = await ensureBundledMarketplaceDefaults(projectRoot, {
        logger: { warn() {} },
      });
      assert.ok(result?.config, "load degrades instead of rejecting");
      assert.equal(
        installedContentSkill(readJson(path.join(projectRoot, "marketplaces.json"))),
        undefined,
        "the failed seed's record was not adopted",
      );
    } finally {
      fs.promises.cp = originalCp;
    }

    const liveMarketplaceRoot = path.join(
      projectRoot,
      "skills-marketplace/portico-ai-marketplace",
    );
    assert.equal(
      fs.existsSync(path.join(liveMarketplaceRoot, "content-quality")),
      false,
    );
    assert.deepEqual(
      fs.existsSync(liveMarketplaceRoot)
        ? fs
            .readdirSync(liveMarketplaceRoot)
            .filter((name) => name.startsWith(".content-quality.ootb-seed-"))
        : [],
      [],
    );

    await ensureBundledMarketplaceDefaults(projectRoot);
    assert.ok(
      installedContentSkill(readJson(path.join(projectRoot, "marketplaces.json"))),
    );
  });
});

test("config persistence failure leaves an identical orphan that restart adopts", async () => {
  await withTempProject(async (projectRoot) => {
    writeJson(path.join(projectRoot, "marketplaces-ootb.json"), ootbConfig());
    writeSkill(projectRoot, "skills-marketplace-ootb", {
      "references/rubric.md": "bundled",
    });
    fs.mkdirSync(path.join(projectRoot, "marketplaces.json"));

    await assert.rejects(
      ensureBundledMarketplaceDefaults(projectRoot),
      /EISDIR|directory/i,
    );
    assert.equal(
      fs.existsSync(
        path.join(
          projectRoot,
          "skills-marketplace/portico-ai-marketplace/content-quality/SKILL.md",
        ),
      ),
      true,
    );

    fs.rmSync(path.join(projectRoot, "marketplaces.json"), {
      recursive: true,
      force: true,
    });
    await ensureBundledMarketplaceDefaults(projectRoot);

    const liveConfig = readJson(path.join(projectRoot, "marketplaces.json"));
    assert.ok(installedContentSkill(liveConfig));
  });
});

// ---------------------------------------------------------------------------
// Round 9: plugin-layout seeds.
// ---------------------------------------------------------------------------

function pluginOotbConfig() {
  const config = ootbConfig();
  config.installedSkills[0] = {
    ...config.installedSkills[0],
    pluginName: "ux-quality-beta",
    localPath:
      "skills-marketplace/portico-ai-marketplace/ux-quality-beta/content-quality",
  };
  return config;
}

function writePluginSkill(projectRoot, baseDir, extraFiles = {}) {
  const skillDir = path.join(
    projectRoot,
    baseDir,
    "portico-ai-marketplace",
    "ux-quality-beta",
    "content-quality",
  );
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nmetadata:\n  version: 2.0.0\n---\n# Content Quality\n",
    "utf8",
  );
  for (const [relativePath, content] of Object.entries(extraFiles)) {
    const filePath = path.join(skillDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
  }
  return skillDir;
}

test("fresh machine: a plugin-layout seed lands the plugin directory and record", async () => {
  await withTempProject(async (projectRoot) => {
    writeJson(path.join(projectRoot, "marketplaces-ootb.json"), pluginOotbConfig());
    writePluginSkill(projectRoot, "skills-marketplace-ootb", {
      "references/rubric.md": "bundled",
    });

    await ensureBundledMarketplaceDefaults(projectRoot);

    const liveConfig = readJson(path.join(projectRoot, "marketplaces.json"));
    const record = installedContentSkill(liveConfig);
    assert.equal(record.pluginName, "ux-quality-beta");
    assert.equal(
      record.localPath,
      "skills-marketplace/portico-ai-marketplace/ux-quality-beta/content-quality",
    );
    assert.equal(
      fs.existsSync(
        path.join(
          projectRoot,
          "skills-marketplace/portico-ai-marketplace/ux-quality-beta/content-quality/SKILL.md",
        ),
      ),
      true,
      "payload seeded at the plugin path",
    );
    assert.equal(
      fs.existsSync(
        path.join(projectRoot, "skills-marketplace/portico-ai-marketplace/content-quality"),
      ),
      false,
      "no flat directory on a fresh machine",
    );
  });
});

test("legacy flat live record survives the plugin seed merge (existing-wins) and migrates exactly once", async () => {
  await withTempProject(async (projectRoot) => {
    // New (plugin-layout) seed, but the machine already has the flat record
    // and flat directory from before round 9 — with identical content.
    writeJson(path.join(projectRoot, "marketplaces-ootb.json"), pluginOotbConfig());
    writePluginSkill(projectRoot, "skills-marketplace-ootb", {
      "references/rubric.md": "same",
    });
    writeSkill(projectRoot, "skills-marketplace", {
      "references/rubric.md": "same",
    });
    const liveConfig = ootbConfig();
    // Give the live marketplace entry what the migration needs.
    liveConfig.marketplaces[0].source = {
      type: "gitlab",
      host: "example.invalid",
      projectPath: "community/portico-ai-marketplace",
      ref: "main",
    };
    writeJson(path.join(projectRoot, "marketplaces.json"), liveConfig);

    // Seed merge: EXISTING wins for localPath/pluginName — the record keeps
    // pointing at its real flat directory.
    await ensureBundledMarketplaceDefaults(projectRoot);
    const merged = installedContentSkill(
      readJson(path.join(projectRoot, "marketplaces.json")),
    );
    assert.equal(merged.pluginName ?? null, null);
    assert.equal(
      merged.localPath,
      "skills-marketplace/portico-ai-marketplace/content-quality",
    );

    // The full service load then migrates the record into the plugin layout.
    const marketplaceService = require("./marketplace-service");
    await marketplaceService.loadMarketplacesConfig(projectRoot, {
      logger: { warn() {}, log() {}, info() {} },
    });
    const migrated = installedContentSkill(
      readJson(path.join(projectRoot, "marketplaces.json")),
    );
    assert.equal(migrated.pluginName, "ux-quality-beta");
    assert.equal(
      migrated.localPath,
      "skills-marketplace/portico-ai-marketplace/ux-quality-beta/content-quality",
    );
    assert.equal(
      fs.existsSync(
        path.join(projectRoot, "skills-marketplace/portico-ai-marketplace/content-quality"),
      ),
      false,
      "flat directory moved, not duplicated",
    );

    // Relaunch (second full load): stable — no churn between the seeder and
    // the migration (the OOTB rewrite and migration MUST land together).
    const before = fs.readFileSync(path.join(projectRoot, "marketplaces.json"), "utf8");
    await marketplaceService.loadMarketplacesConfig(projectRoot, {
      logger: { warn() {}, log() {}, info() {} },
    });
    const after = fs.readFileSync(path.join(projectRoot, "marketplaces.json"), "utf8");
    assert.equal(after, before, "no launch-after-launch churn");
    assert.equal(
      fs.existsSync(
        path.join(projectRoot, "skills-marketplace/portico-ai-marketplace/content-quality"),
      ),
      false,
      "the seeder does not re-create the flat directory",
    );
  });
});
