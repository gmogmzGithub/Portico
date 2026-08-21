const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  ensureBundledMarketplaceDefaults,
  isOotbSeededInstall,
  mergeMarketplaceEntry,
  mergeInstalledSkillEntry,
  readInstalledSkillVersion,
  resolveMarketplaceStoragePaths,
} = require("./marketplace-ootb");

async function withTempProject(fn) {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "marketplace-ootb-test-"),
  );
  try {
    return await fn(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeSkill(projectRoot, baseDir, marketplaceId, skillId, extraFiles = {}) {
  const skillDir = path.join(projectRoot, baseDir, marketplaceId, skillId);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(
      skillDir,
      "SKILL.md",
    ),
    "---\nmetadata:\n  version: 2.3.4\n---\n# Skill\n",
    "utf8",
  );
  for (const [relativePath, content] of Object.entries(extraFiles)) {
    const targetPath = path.join(skillDir, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content, "utf8");
  }
  return skillDir;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

test("mergeMarketplaceEntry preserves user/runtime fields while refreshing ootb metadata", () => {
  const merged = mergeMarketplaceEntry(
    {
      id: "anthropic-agent-skills",
      name: "Old Name",
      enabled: false,
      addedAt: "2026-01-01T00:00:00.000Z",
      cachedManifest: { stale: true },
      marketplaceVersion: "1.2.3",
      lastSynced: "2026-02-01T00:00:00.000Z",
      customField: "preserve-me",
    },
    {
      id: "anthropic-agent-skills",
      name: "Anthropic Agent Skills",
      description: "Fresh description",
      source: { type: "github", repo: "anthropics/skills" },
      owner: { name: "Anthropic" },
      isOfficial: true,
      enabled: true,
    },
  );

  assert.equal(merged.name, "Anthropic Agent Skills");
  assert.equal(merged.enabled, false);
  assert.equal(merged.cachedManifest.stale, true);
  assert.equal(merged.customField, "preserve-me");
  assert.equal(merged.isOfficial, true);
});

test("mergeMarketplaceEntry stamps ootb:true from the seed onto a live entry that predates it", () => {
  const merged = mergeMarketplaceEntry(
    {
      id: "knowledge-work-plugins",
      name: "knowledge-work-plugins",
      enabled: true,
      lastSynced: "2026-07-01T00:00:00.000Z",
    },
    {
      id: "knowledge-work-plugins",
      name: "knowledge-work-plugins",
      source: { type: "github", repo: "anthropics/knowledge-work-plugins" },
      ootb: true,
    },
  );

  assert.equal(merged.ootb, true, "the built-in stamp propagates on merge");
  assert.equal(merged.lastSynced, "2026-07-01T00:00:00.000Z", "runtime fields stay");
});

test("mergeMarketplaceEntry keeps persisted root-skill verdicts when ootb assets lack the marker", () => {
  const merged = mergeMarketplaceEntry(
    {
      id: "portico-ai-marketplace",
      cachedManifest: {
        name: "portico-ai-marketplace",
        plugins: [
          { name: "alma-dev", source: "./community/sts-alma/alma-dev", rootSkill: true },
          { name: "docs", skills: ["./skills/pdf"] },
        ],
      },
    },
    {
      id: "portico-ai-marketplace",
      name: "portico-ai-marketplace",
      source: {
        type: "gitlab",
        host: "example.invalid",
        projectPath: "community/portico-ai-marketplace",
        ref: "main",
      },
      cachedManifest: {
        name: "portico-ai-marketplace",
        plugins: [
          { name: "alma-dev", source: "./community/sts-alma/alma-dev" },
          { name: "docs", skills: ["./skills/pdf", "./skills/docx"] },
        ],
      },
    },
  );

  const alma = merged.cachedManifest.plugins.find((plugin) => plugin.name === "alma-dev");
  assert.equal(alma.rootSkill, true);
  assert.equal("skills" in alma, false);
  // Sanity: the skills[]-on-both-sides merge path still appends new paths.
  const docs = merged.cachedManifest.plugins.find((plugin) => plugin.name === "docs");
  assert.deepEqual(docs.skills, ["./skills/pdf", "./skills/docx"]);
});

test("mergeInstalledSkillEntry preserves runtime fields while refreshing ootb metadata", () => {
  const merged = mergeInstalledSkillEntry(
    {
      marketplaceId: "anthropic-agent-skills",
      skillId: "pdf",
      installedAt: "2026-01-01T00:00:00.000Z",
      installedVersion: "1.0.0",
      lastCheckedVersion: "1.0.0",
      hasUpdate: true,
      localPath: "skills-marketplace/anthropic-agent-skills/pdf",
      customRuntimeField: "keep-me",
    },
    {
      marketplaceId: "anthropic-agent-skills",
      skillId: "pdf",
      skillPath: "./skills/pdf",
      skillSource: { type: "github", repo: "anthropics/skills" },
      localPath: "skills-marketplace/anthropic-agent-skills/pdf",
    },
    "2.3.4",
    "2026-03-12T00:00:00.000Z",
  );

  assert.equal(merged.installedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(merged.installedVersion, "2.3.4");
  // The live version changed (1.0.0 -> 2.3.4), so the freshness baseline
  // restarts: lastCheckedVersion follows the new version and hasUpdate resets.
  assert.equal(merged.lastCheckedVersion, "2.3.4");
  assert.equal(merged.hasUpdate, false);
  assert.equal(merged.localPath, "skills-marketplace/anthropic-agent-skills/pdf");
  assert.deepEqual(merged.skillSource, {
    type: "github",
    repo: "anthropics/skills",
  });
  assert.equal(merged.customRuntimeField, "keep-me");
});

test("readInstalledSkillVersion accepts duplicate frontmatter keys and top-level version", async () => {
  await withTempProject(async (projectRoot) => {
    const skillDir = path.join(
      projectRoot,
      "skills-marketplace",
      "trust-kit",
      "shared-trino",
    );
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: shared-trino",
        "description: Shared Trino skill",
        'version: "2.1"',
        'author: "first-author"',
        'author: "second-author"',
        "---",
        "# Shared Trino",
        "",
      ].join("\n"),
      "utf8",
    );

    assert.equal(await readInstalledSkillVersion(skillDir, "1.0"), "2.1");
  });
});

test("resolveMarketplaceStoragePaths uses checked-in source assets and preserves packaged precedence", async () => {
  await withTempProject(async (projectRoot) => {
    const checkedInConfigPath = path.join(
      projectRoot,
      "marketplaces-ootb",
      "marketplaces.json",
    );
    const checkedInSkillsDir = path.join(
      projectRoot,
      "marketplaces-ootb",
      "skills-marketplace",
    );
    writeJson(checkedInConfigPath, { marketplaces: [], installedSkills: [] });
    fs.mkdirSync(checkedInSkillsDir, { recursive: true });

    const sourcePaths = resolveMarketplaceStoragePaths(projectRoot);
    assert.equal(sourcePaths.ootbConfigPath, checkedInConfigPath);
    assert.equal(sourcePaths.ootbSkillsDir, checkedInSkillsDir);

    writeJson(path.join(projectRoot, "marketplaces-ootb.json"), {
      marketplaces: [],
      installedSkills: [],
    });
    fs.mkdirSync(path.join(projectRoot, "skills-marketplace-ootb"));

    const packagedPaths = resolveMarketplaceStoragePaths(projectRoot);
    assert.equal(
      packagedPaths.ootbConfigPath,
      path.join(projectRoot, "marketplaces-ootb.json"),
    );
    assert.equal(
      packagedPaths.ootbSkillsDir,
      path.join(projectRoot, "skills-marketplace-ootb"),
    );
  });
});

test("ensureBundledMarketplaceDefaults creates live state from checked-in source assets on first install", async () => {
  await withTempProject(async (projectRoot) => {
    writeJson(path.join(projectRoot, "marketplaces-ootb", "marketplaces.json"), {
      version: "1.0",
      marketplaces: [
        {
          id: "anthropic-agent-skills",
          name: "Anthropic Agent Skills",
          description: "Official skills",
          source: { type: "github", repo: "anthropics/skills" },
          owner: { name: "Anthropic" },
          enabled: true,
          isOfficial: true,
        },
      ],
      installedSkills: [
        {
          skillId: "pdf",
          marketplaceId: "anthropic-agent-skills",
          skillPath: "./skills/pdf",
          skillSource: null,
          localPath: "skills-marketplace/anthropic-agent-skills/pdf",
          installedVersion: "1.0",
        },
      ],
    });
    writeSkill(
      projectRoot,
      path.join("marketplaces-ootb", "skills-marketplace"),
      "anthropic-agent-skills",
      "pdf",
      { "notes.txt": "hello" },
    );

    const result = await ensureBundledMarketplaceDefaults(projectRoot);
    assert.equal(result.updated, true);

    const liveConfig = readJson(path.join(projectRoot, "marketplaces.json"));
    assert.equal(liveConfig.marketplaces.length, 1);
    assert.equal(liveConfig.installedSkills.length, 1);
    assert.equal(liveConfig.installedSkills[0].installedVersion, "2.3.4");
    assert.equal(
      fs.existsSync(
        path.join(
          projectRoot,
          "skills-marketplace",
          "anthropic-agent-skills",
          "pdf",
          "notes.txt",
        ),
      ),
      true,
    );
  });
});

test("ensureBundledMarketplaceDefaults preserves differing orphan skill directories", async () => {
  await withTempProject(async (projectRoot) => {
    writeJson(path.join(projectRoot, "marketplaces-ootb.json"), {
      version: "1.0",
      marketplaces: [
        {
          id: "anthropic-agent-skills",
          name: "Anthropic Agent Skills",
        },
      ],
      installedSkills: [
        {
          skillId: "pdf",
          marketplaceId: "anthropic-agent-skills",
          localPath: "skills-marketplace/anthropic-agent-skills/pdf",
        },
      ],
    });
    writeSkill(
      projectRoot,
      "skills-marketplace-ootb",
      "anthropic-agent-skills",
      "pdf",
      { "new-file.txt": "new" },
    );
    writeSkill(
      projectRoot,
      "skills-marketplace",
      "anthropic-agent-skills",
      "pdf",
      { "stale-file.txt": "stale" },
    );

    await ensureBundledMarketplaceDefaults(projectRoot);

    assert.equal(
      fs.existsSync(
        path.join(
          projectRoot,
          "skills-marketplace",
          "anthropic-agent-skills",
          "pdf",
          "stale-file.txt",
        ),
      ),
      true,
    );
    assert.equal(
      fs.existsSync(
        path.join(
          projectRoot,
          "skills-marketplace",
          "anthropic-agent-skills",
          "pdf",
          "new-file.txt",
        ),
      ),
      false,
    );
    const liveConfig = readJson(path.join(projectRoot, "marketplaces.json"));
    assert.equal(liveConfig.installedSkills.length, 0);
  });
});

test("ensureBundledMarketplaceDefaults upgrades from checked-in source assets without removing live-only entries", async () => {
  await withTempProject(async (projectRoot) => {
    writeJson(path.join(projectRoot, "marketplaces-ootb", "marketplaces.json"), {
      version: "1.0",
      marketplaces: [
        {
          id: "anthropic-agent-skills",
          name: "Anthropic Agent Skills",
          description: "Bundled",
          source: { type: "github", repo: "anthropics/skills" },
          owner: { name: "Anthropic" },
          isOfficial: true,
        },
      ],
      installedSkills: [
        {
          skillId: "pdf",
          marketplaceId: "anthropic-agent-skills",
          localPath: "skills-marketplace/anthropic-agent-skills/pdf",
        },
      ],
    });
    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [
        {
          id: "custom-marketplace",
          name: "Custom",
          source: { type: "url", url: "https://example.com/marketplace.json" },
        },
      ],
      installedSkills: [
        {
          skillId: "user-skill",
          marketplaceId: "custom-marketplace",
          localPath: "skills-marketplace/custom-marketplace/user-skill",
        },
      ],
    });
    writeSkill(
      projectRoot,
      path.join("marketplaces-ootb", "skills-marketplace"),
      "anthropic-agent-skills",
      "pdf",
    );
    writeSkill(
      projectRoot,
      "skills-marketplace",
      "custom-marketplace",
      "user-skill",
      { "custom.txt": "keep" },
    );

    await ensureBundledMarketplaceDefaults(projectRoot);

    const liveConfig = readJson(path.join(projectRoot, "marketplaces.json"));
    assert.equal(
      liveConfig.marketplaces.some((entry) => entry.id === "anthropic-agent-skills"),
      true,
    );
    assert.equal(
      liveConfig.marketplaces.some((entry) => entry.id === "custom-marketplace"),
      true,
    );
    assert.equal(
      liveConfig.installedSkills.some(
        (entry) =>
          entry.marketplaceId === "anthropic-agent-skills" &&
          entry.skillId === "pdf",
      ),
      true,
    );
    assert.equal(
      liveConfig.installedSkills.some(
        (entry) =>
          entry.marketplaceId === "custom-marketplace" &&
          entry.skillId === "user-skill",
      ),
      true,
    );
  });
});

test("ensureBundledMarketplaceDefaults does not auto-remove live content when ootb payload stops shipping it", async () => {
  await withTempProject(async (projectRoot) => {
    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [
        {
          id: "anthropic-agent-skills",
          name: "Anthropic Agent Skills",
        },
      ],
      installedSkills: [
        {
          skillId: "pdf",
          marketplaceId: "anthropic-agent-skills",
          localPath: "skills-marketplace/anthropic-agent-skills/pdf",
        },
      ],
    });
    writeSkill(
      projectRoot,
      "skills-marketplace",
      "anthropic-agent-skills",
      "pdf",
      { "keep.txt": "keep" },
    );

    await ensureBundledMarketplaceDefaults(projectRoot);

    assert.equal(
      fs.existsSync(
        path.join(
          projectRoot,
          "skills-marketplace",
          "anthropic-agent-skills",
          "pdf",
          "keep.txt",
        ),
      ),
      true,
    );
    const liveConfig = readJson(path.join(projectRoot, "marketplaces.json"));
    assert.equal(liveConfig.installedSkills.length, 1);
  });
});

test("ensureBundledMarketplaceDefaults is idempotent when bundled skills are unchanged", async () => {
  await withTempProject(async (projectRoot) => {
    writeJson(path.join(projectRoot, "marketplaces-ootb.json"), {
      version: "1.0",
      marketplaces: [
        {
          id: "anthropic-agent-skills",
          name: "Anthropic Agent Skills",
        },
      ],
      installedSkills: [
        {
          skillId: "pdf",
          marketplaceId: "anthropic-agent-skills",
          localPath: "skills-marketplace/anthropic-agent-skills/pdf",
        },
      ],
    });
    writeSkill(
      projectRoot,
      "skills-marketplace-ootb",
      "anthropic-agent-skills",
      "pdf",
      { "notes.txt": "same" },
    );

    await ensureBundledMarketplaceDefaults(projectRoot);

    const copiedSkillPath = path.join(
      projectRoot,
      "skills-marketplace",
      "anthropic-agent-skills",
      "pdf",
      "notes.txt",
    );
    const originalStat = fs.statSync(copiedSkillPath);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const secondPass = await ensureBundledMarketplaceDefaults(projectRoot);
    const secondStat = fs.statSync(copiedSkillPath);

    assert.equal(secondPass.updated, false);
    assert.equal(secondStat.mtimeMs, originalStat.mtimeMs);
  });
});

test("ensureBundledMarketplaceDefaults does not resurrect a removed non-seeded install", async () => {
  await withTempProject(async (projectRoot) => {
    writeJson(path.join(projectRoot, "marketplaces-ootb.json"), {
      version: "1.0",
      marketplaces: [
        {
          id: "anthropic-agent-skills",
          name: "Anthropic Agent Skills",
        },
      ],
      installedSkills: [
        {
          skillId: "pdf",
          marketplaceId: "anthropic-agent-skills",
          localPath: "skills-marketplace/anthropic-agent-skills/pdf",
        },
      ],
    });
    writeSkill(projectRoot, "skills-marketplace-ootb", "anthropic-agent-skills", "pdf");

    // Live registry after a legitimate uninstall of a NON-seeded install:
    // the user-added marketplace stays registered, but its install record and
    // payload directory are gone. Only the seeded record remains (identical
    // bytes to the bundle, via the same writeSkill fixture).
    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [
        {
          id: "anthropic-agent-skills",
          name: "Anthropic Agent Skills",
        },
        {
          id: "user-added",
          name: "user-added",
        },
      ],
      installedSkills: [
        {
          skillId: "pdf",
          marketplaceId: "anthropic-agent-skills",
          localPath: "skills-marketplace/anthropic-agent-skills/pdf",
        },
      ],
    });
    writeSkill(projectRoot, "skills-marketplace", "anthropic-agent-skills", "pdf");

    await ensureBundledMarketplaceDefaults(projectRoot);

    // The seed merge only ever restores seed-listed records: the removed
    // non-seeded install stays removed, on disk and in the registry.
    const liveConfig = readJson(path.join(projectRoot, "marketplaces.json"));
    assert.deepEqual(
      liveConfig.installedSkills.map(
        (entry) => `${entry.marketplaceId}/${entry.skillId}`,
      ),
      ["anthropic-agent-skills/pdf"],
    );
    assert.equal(
      fs.existsSync(path.join(projectRoot, "skills-marketplace", "user-added")),
      false,
    );
  });
});

test("isOotbSeededInstall answers from the bundled seed manifest only", async () => {
  await withTempProject(async (projectRoot) => {
    writeJson(path.join(projectRoot, "marketplaces-ootb.json"), {
      version: "1.0",
      marketplaces: [
        {
          id: "anthropic-agent-skills",
          name: "Anthropic Agent Skills",
        },
      ],
      installedSkills: [
        {
          skillId: "pdf",
          marketplaceId: "anthropic-agent-skills",
          localPath: "skills-marketplace/anthropic-agent-skills/document-skills/pdf",
          pluginName: "document-skills",
        },
      ],
    });
    // Live-registry contents never make a record seeded.
    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [],
      installedSkills: [
        {
          skillId: "pdf",
          marketplaceId: "anthropic-agent-skills",
          localPath: "skills-marketplace/anthropic-agent-skills/document-skills/pdf",
        },
        {
          skillId: "my-skill",
          marketplaceId: "user-added",
          localPath: "skills-marketplace/user-added/my-skill",
        },
      ],
    });

    assert.equal(
      await isOotbSeededInstall(projectRoot, {
        marketplaceId: "anthropic-agent-skills",
        skillId: "pdf",
      }),
      true,
    );
    assert.equal(
      await isOotbSeededInstall(projectRoot, {
        marketplaceId: "user-added",
        skillId: "my-skill",
      }),
      false,
    );
    assert.equal(
      await isOotbSeededInstall(projectRoot, {
        marketplaceId: "anthropic-agent-skills",
        skillId: "docx",
      }),
      false,
    );
    assert.equal(await isOotbSeededInstall(projectRoot, {}), false);
  });
});

test("isOotbSeededInstall reports nothing seeded without a distinct bundled seed source", async () => {
  await withTempProject(async (projectRoot) => {
    // ootbConfigPath falls back to the live registry here, so removals are
    // durable (nothing can resurrect them) and no record may present as
    // immutable.
    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [],
      installedSkills: [
        {
          skillId: "pdf",
          marketplaceId: "anthropic-agent-skills",
          localPath: "skills-marketplace/anthropic-agent-skills/pdf",
        },
      ],
    });

    assert.equal(
      await isOotbSeededInstall(projectRoot, {
        marketplaceId: "anthropic-agent-skills",
        skillId: "pdf",
      }),
      false,
    );
  });
});

test("mergeInstalledSkillEntry preserves freshness flags when the live version is unchanged", () => {
  // 2026-08-01 sharing-run ISSUE-6 regression: the seed re-merge runs on
  // EVERY registry load; it must not erase a persisted update flag when
  // nothing about the live install actually changed.
  const merged = mergeInstalledSkillEntry(
    {
      marketplaceId: "anthropic-agent-skills",
      skillId: "pdf",
      installedAt: "2026-01-01T00:00:00.000Z",
      installedVersion: "1.0.0",
      lastCheckedVersion: "1.4.0",
      hasUpdate: true,
      localPath: "skills-marketplace/anthropic-agent-skills/pdf",
    },
    {
      marketplaceId: "anthropic-agent-skills",
      skillId: "pdf",
      skillPath: "./skills/pdf",
      skillSource: { type: "github", repo: "anthropics/skills" },
      localPath: "skills-marketplace/anthropic-agent-skills/pdf",
    },
    "1.0.0",
    "2026-03-12T00:00:00.000Z",
  );

  assert.equal(merged.installedVersion, "1.0.0");
  assert.equal(merged.lastCheckedVersion, "1.4.0");
  assert.equal(merged.hasUpdate, true);
});

// --- seedMigrations: bundle-declared identity moves --------------------------

function writeSkillAt(projectRoot, relativeSegments, extraFiles = {}) {
  const skillDir = path.join(projectRoot, ...relativeSegments);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nmetadata:\n  version: 2.3.4\n---\n# Skill\n",
    "utf8",
  );
  for (const [relativePath, content] of Object.entries(extraFiles)) {
    const targetPath = path.join(skillDir, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content, "utf8");
  }
  return skillDir;
}

const RENAME_MP = "test-marketplace";

function renameFixtureBundle(projectRoot, { migrations } = {}) {
  writeJson(path.join(projectRoot, "marketplaces-ootb", "marketplaces.json"), {
    version: "1.0",
    marketplaces: [
      {
        id: RENAME_MP,
        name: "Test Marketplace",
        lastSynced: "2026-08-11T00:00:00.000Z",
        ootb: true,
      },
    ],
    installedSkills: [
      {
        marketplaceId: RENAME_MP,
        skillId: "a11y",
        pluginName: "ux",
        skillPath: "./community/ux/skills/a11y",
        skillSource: null,
        localPath: `skills-marketplace/${RENAME_MP}/ux/a11y`,
        installedVersion: "2.3.4",
      },
    ],
    seedMigrations:
      migrations !== undefined
        ? migrations
        : [
            {
              from: { marketplaceId: RENAME_MP, pluginName: "ux-beta", skillId: "a11y" },
              to: { marketplaceId: RENAME_MP, pluginName: "ux", skillId: "a11y" },
            },
          ],
  });
  writeSkillAt(
    projectRoot,
    ["marketplaces-ootb", "skills-marketplace", RENAME_MP, "ux", "a11y"],
    { "notes.txt": "bundled-content" },
  );
}

function renameFixtureLiveRecord(overrides = {}) {
  return {
    marketplaceId: RENAME_MP,
    skillId: "a11y",
    pluginName: "ux-beta",
    skillPath: "./community/ux-beta/skills/a11y",
    skillSource: null,
    localPath: `skills-marketplace/${RENAME_MP}/ux-beta/a11y`,
    installedAt: "2026-07-24T00:00:00.000Z",
    installedVersion: "2.3.4",
    lastCheckedVersion: "2.3.4",
    hasUpdate: true,
    updateHeadCommittedAt: "2026-08-11T10:00:00.000Z",
    contentHeadSha: "abc123",
    baseline: {
      generatedAt: "2026-07-24T00:00:00.000Z",
      version: "2.3.4",
      files: [{ path: "SKILL.md", sha256: "deadbeef" }],
    },
    ...overrides,
  };
}

function renameFixtureLive(projectRoot, { record = renameFixtureLiveRecord() } = {}) {
  writeJson(path.join(projectRoot, "marketplaces.json"), {
    version: "1.0",
    marketplaces: [
      {
        id: RENAME_MP,
        name: "Test Marketplace",
        lastSynced: "2026-08-01T00:00:00.000Z",
      },
    ],
    installedSkills: [record],
  });
  writeSkillAt(
    projectRoot,
    ["skills-marketplace", RENAME_MP, "ux-beta", "a11y"],
    { "notes.txt": "live-content" },
  );
}

test("seedMigrations relocates a plugin-renamed seed record and payload", async () => {
  await withTempProject(async (projectRoot) => {
    renameFixtureBundle(projectRoot);
    renameFixtureLive(projectRoot);

    const warns = [];
    const result = await ensureBundledMarketplaceDefaults(projectRoot, {
      logger: { warn: (message) => warns.push(String(message)) },
    });
    assert.equal(result.updated, true);

    const liveConfig = readJson(path.join(projectRoot, "marketplaces.json"));
    assert.equal(liveConfig.installedSkills.length, 1);
    const record = liveConfig.installedSkills[0];
    assert.equal(record.pluginName, "ux");
    assert.equal(record.skillId, "a11y");
    assert.equal(record.skillPath, "./community/ux/skills/a11y");
    assert.equal(record.localPath, `skills-marketplace/${RENAME_MP}/ux/a11y`);
    // Freshness/provenance fields survive the identity move untouched.
    assert.equal(record.hasUpdate, true);
    assert.equal(record.updateHeadCommittedAt, "2026-08-11T10:00:00.000Z");
    assert.equal(record.contentHeadSha, "abc123");
    assert.equal(record.installedAt, "2026-07-24T00:00:00.000Z");
    assert.deepEqual(record.baseline.files, [
      { path: "SKILL.md", sha256: "deadbeef" },
    ]);

    // Payload moved: live bytes (not bundled bytes) at the new location,
    // old dir and its emptied plugin parent gone.
    const newDir = path.join(projectRoot, "skills-marketplace", RENAME_MP, "ux", "a11y");
    assert.equal(fs.readFileSync(path.join(newDir, "notes.txt"), "utf8"), "live-content");
    assert.equal(
      fs.existsSync(path.join(projectRoot, "skills-marketplace", RENAME_MP, "ux-beta")),
      false,
    );
    // The differing bundled payload was preserved-away, not copied over.
    assert.equal(
      warns.some((line) => line.includes(`Preserving existing skill ${RENAME_MP}/a11y`)),
      true,
    );
  });
});

test("seedMigrations rewrites leaf renames and re-pairs the record with its seed", async () => {
  await withTempProject(async (projectRoot) => {
    writeJson(path.join(projectRoot, "marketplaces-ootb", "marketplaces.json"), {
      version: "1.0",
      marketplaces: [{ id: RENAME_MP, name: "Test Marketplace" }],
      installedSkills: [
        {
          marketplaceId: RENAME_MP,
          skillId: "a11y-quality",
          pluginName: "ux",
          skillPath: "./community/ux/skills/a11y-quality",
          skillSource: null,
          localPath: `skills-marketplace/${RENAME_MP}/ux/a11y-quality`,
          installedVersion: "2.3.4",
        },
      ],
      seedMigrations: [
        {
          from: { marketplaceId: RENAME_MP, pluginName: "ux-beta", skillId: "a11y" },
          to: { marketplaceId: RENAME_MP, pluginName: "ux", skillId: "a11y-quality" },
        },
      ],
    });
    writeSkillAt(
      projectRoot,
      ["marketplaces-ootb", "skills-marketplace", RENAME_MP, "ux", "a11y-quality"],
      { "notes.txt": "bundled-content" },
    );
    renameFixtureLive(projectRoot);

    await ensureBundledMarketplaceDefaults(projectRoot);

    const liveConfig = readJson(path.join(projectRoot, "marketplaces.json"));
    assert.equal(liveConfig.installedSkills.length, 1);
    const record = liveConfig.installedSkills[0];
    assert.equal(record.skillId, "a11y-quality");
    assert.equal(record.pluginName, "ux");
    assert.equal(record.localPath, `skills-marketplace/${RENAME_MP}/ux/a11y-quality`);
    assert.equal(
      fs.readFileSync(
        path.join(projectRoot, "skills-marketplace", RENAME_MP, "ux", "a11y-quality", "notes.txt"),
        "utf8",
      ),
      "live-content",
    );
  });
});

test("seedMigrations never runs backwards: healed records survive a stale bundle", async () => {
  await withTempProject(async (projectRoot) => {
    // Stale bundle: seeds still at the OLD identity, no migrations (an old
    // build). The live record has already been healed to the new identity.
    writeJson(path.join(projectRoot, "marketplaces-ootb", "marketplaces.json"), {
      version: "1.0",
      marketplaces: [
        { id: RENAME_MP, name: "Test Marketplace", lastSynced: "2026-07-21T00:00:00.000Z" },
      ],
      installedSkills: [
        {
          marketplaceId: RENAME_MP,
          skillId: "a11y",
          pluginName: "ux-beta",
          skillPath: "./community/ux-beta/skills/a11y",
          skillSource: null,
          localPath: `skills-marketplace/${RENAME_MP}/ux-beta/a11y`,
          installedVersion: "2.3.4",
        },
      ],
    });
    writeSkillAt(
      projectRoot,
      ["marketplaces-ootb", "skills-marketplace", RENAME_MP, "ux-beta", "a11y"],
      { "notes.txt": "stale-bundled-content" },
    );

    const healedRecord = renameFixtureLiveRecord({
      pluginName: "ux",
      skillPath: "./community/ux/skills/a11y",
      localPath: `skills-marketplace/${RENAME_MP}/ux/a11y`,
      hasUpdate: false,
    });
    delete healedRecord.updateHeadCommittedAt;
    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [
        { id: RENAME_MP, name: "Test Marketplace", lastSynced: "2026-08-12T00:00:00.000Z" },
      ],
      installedSkills: [healedRecord],
    });
    writeSkillAt(projectRoot, ["skills-marketplace", RENAME_MP, "ux", "a11y"], {
      "notes.txt": "healed-live-content",
    });

    await ensureBundledMarketplaceDefaults(projectRoot);

    const liveConfig = readJson(path.join(projectRoot, "marketplaces.json"));
    assert.equal(liveConfig.installedSkills.length, 1);
    const record = liveConfig.installedSkills[0];
    // The 2026-08-11 incident regression pin: the stale seed must not drag
    // any identity field (especially skillPath) back to the old layout.
    assert.equal(record.pluginName, "ux");
    assert.equal(record.skillPath, "./community/ux/skills/a11y");
    assert.equal(record.localPath, `skills-marketplace/${RENAME_MP}/ux/a11y`);
    assert.equal(
      fs.readFileSync(
        path.join(projectRoot, "skills-marketplace", RENAME_MP, "ux", "a11y", "notes.txt"),
        "utf8",
      ),
      "healed-live-content",
    );
  });
});

test("seedMigrations skips dead targets and leaves the record untouched", async () => {
  await withTempProject(async (projectRoot) => {
    renameFixtureBundle(projectRoot, {
      migrations: [
        {
          from: { marketplaceId: RENAME_MP, pluginName: "ux-beta", skillId: "a11y" },
          to: { marketplaceId: RENAME_MP, pluginName: "ux", skillId: "not-a-seed" },
        },
      ],
    });
    renameFixtureLive(projectRoot);

    await ensureBundledMarketplaceDefaults(projectRoot);

    const liveConfig = readJson(path.join(projectRoot, "marketplaces.json"));
    const record = liveConfig.installedSkills.find((entry) => entry.skillId === "a11y");
    assert.equal(record.pluginName, "ux-beta");
    assert.equal(record.skillPath, "./community/ux-beta/skills/a11y");
    assert.equal(
      fs.existsSync(
        path.join(projectRoot, "skills-marketplace", RENAME_MP, "ux-beta", "a11y", "notes.txt"),
      ),
      true,
    );
  });
});

test("seedMigrations skips when another record already holds the target identity", async () => {
  await withTempProject(async (projectRoot) => {
    renameFixtureBundle(projectRoot);
    const oldRecord = renameFixtureLiveRecord();
    const occupyingRecord = renameFixtureLiveRecord({
      pluginName: "ux",
      skillPath: "./community/ux/skills/a11y",
      localPath: `skills-marketplace/${RENAME_MP}/ux/a11y`,
      hasUpdate: false,
    });
    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [{ id: RENAME_MP, name: "Test Marketplace" }],
      installedSkills: [oldRecord, occupyingRecord],
    });
    writeSkillAt(projectRoot, ["skills-marketplace", RENAME_MP, "ux-beta", "a11y"], {
      "notes.txt": "old-content",
    });
    writeSkillAt(projectRoot, ["skills-marketplace", RENAME_MP, "ux", "a11y"], {
      "notes.txt": "occupying-content",
    });

    await ensureBundledMarketplaceDefaults(projectRoot);

    const liveConfig = readJson(path.join(projectRoot, "marketplaces.json"));
    assert.equal(liveConfig.installedSkills.length, 2);
    const untouched = liveConfig.installedSkills.find(
      (entry) => entry.pluginName === "ux-beta",
    );
    assert.equal(untouched.skillPath, "./community/ux-beta/skills/a11y");
    assert.equal(
      fs.readFileSync(
        path.join(projectRoot, "skills-marketplace", RENAME_MP, "ux", "a11y", "notes.txt"),
        "utf8",
      ),
      "occupying-content",
    );
  });
});

test("seedMigrations skips when the target directory is occupied by an orphan", async () => {
  await withTempProject(async (projectRoot) => {
    renameFixtureBundle(projectRoot);
    renameFixtureLive(projectRoot);
    writeSkillAt(projectRoot, ["skills-marketplace", RENAME_MP, "ux", "a11y"], {
      "notes.txt": "orphan-content",
    });

    await ensureBundledMarketplaceDefaults(projectRoot);

    const liveConfig = readJson(path.join(projectRoot, "marketplaces.json"));
    const record = liveConfig.installedSkills.find((entry) => entry.skillId === "a11y");
    assert.equal(record.pluginName, "ux-beta");
    assert.equal(
      fs.readFileSync(
        path.join(projectRoot, "skills-marketplace", RENAME_MP, "ux-beta", "a11y", "notes.txt"),
        "utf8",
      ),
      "live-content",
    );
    assert.equal(
      fs.readFileSync(
        path.join(projectRoot, "skills-marketplace", RENAME_MP, "ux", "a11y", "notes.txt"),
        "utf8",
      ),
      "orphan-content",
    );
  });
});

test("seedMigrations rewrites the record when the payload dir is already gone", async () => {
  await withTempProject(async (projectRoot) => {
    renameFixtureBundle(projectRoot);
    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [{ id: RENAME_MP, name: "Test Marketplace" }],
      installedSkills: [renameFixtureLiveRecord()],
    });
    // No live payload dir at all.

    await ensureBundledMarketplaceDefaults(projectRoot);

    const liveConfig = readJson(path.join(projectRoot, "marketplaces.json"));
    const record = liveConfig.installedSkills[0];
    assert.equal(record.pluginName, "ux");
    assert.equal(record.localPath, `skills-marketplace/${RENAME_MP}/ux/a11y`);
    // Seed loop restored the bundled payload at the NEW location.
    assert.equal(
      fs.readFileSync(
        path.join(projectRoot, "skills-marketplace", RENAME_MP, "ux", "a11y", "notes.txt"),
        "utf8",
      ),
      "bundled-content",
    );
  });
});

test("seedMigrations flat alias map heals a multi-build jump in one hop", async () => {
  await withTempProject(async (projectRoot) => {
    renameFixtureBundle(projectRoot, {
      migrations: [
        {
          from: { marketplaceId: RENAME_MP, pluginName: "ux-alpha", skillId: "a11y" },
          to: { marketplaceId: RENAME_MP, pluginName: "ux", skillId: "a11y" },
        },
        {
          from: { marketplaceId: RENAME_MP, pluginName: "ux-beta", skillId: "a11y" },
          to: { marketplaceId: RENAME_MP, pluginName: "ux", skillId: "a11y" },
        },
      ],
    });
    const ancientRecord = renameFixtureLiveRecord({
      pluginName: "ux-alpha",
      skillPath: "./community/ux-alpha/skills/a11y",
      localPath: `skills-marketplace/${RENAME_MP}/ux-alpha/a11y`,
    });
    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [{ id: RENAME_MP, name: "Test Marketplace" }],
      installedSkills: [ancientRecord],
    });
    writeSkillAt(projectRoot, ["skills-marketplace", RENAME_MP, "ux-alpha", "a11y"], {
      "notes.txt": "ancient-live-content",
    });

    await ensureBundledMarketplaceDefaults(projectRoot);

    const liveConfig = readJson(path.join(projectRoot, "marketplaces.json"));
    const record = liveConfig.installedSkills[0];
    assert.equal(record.pluginName, "ux");
    assert.equal(record.localPath, `skills-marketplace/${RENAME_MP}/ux/a11y`);
    assert.equal(
      fs.readFileSync(
        path.join(projectRoot, "skills-marketplace", RENAME_MP, "ux", "a11y", "notes.txt"),
        "utf8",
      ),
      "ancient-live-content",
    );
  });
});

test("seedMigrations is idempotent across repeated loads", async () => {
  await withTempProject(async (projectRoot) => {
    renameFixtureBundle(projectRoot);
    renameFixtureLive(projectRoot);

    await ensureBundledMarketplaceDefaults(projectRoot);
    const firstBytes = fs.readFileSync(path.join(projectRoot, "marketplaces.json"), "utf8");
    const second = await ensureBundledMarketplaceDefaults(projectRoot);
    const secondBytes = fs.readFileSync(path.join(projectRoot, "marketplaces.json"), "utf8");

    assert.equal(secondBytes, firstBytes);
    assert.equal(second.config.installedSkills.length, 1);
    assert.equal(second.config.installedSkills[0].pluginName, "ux");
  });
});

test("mergeInstalledSkillEntry keeps the live identity unit when the record has a localPath", () => {
  const merged = mergeInstalledSkillEntry(
    {
      marketplaceId: "mp",
      skillId: "a11y",
      pluginName: "ux",
      skillPath: "./community/ux/skills/a11y",
      skillSource: null,
      localPath: "skills-marketplace/mp/ux/a11y",
      installedVersion: "1.0.0",
    },
    {
      marketplaceId: "mp",
      skillId: "a11y",
      pluginName: "ux-beta",
      skillPath: "./community/ux-beta/skills/a11y",
      skillSource: { type: "gitlab", projectPath: "x/y" },
      localPath: "skills-marketplace/mp/ux-beta/a11y",
    },
    "1.0.0",
    "2026-08-12T00:00:00.000Z",
  );

  assert.equal(merged.pluginName, "ux");
  assert.equal(merged.skillPath, "./community/ux/skills/a11y");
  assert.equal(merged.skillSource, null);
  assert.equal(merged.localPath, "skills-marketplace/mp/ux/a11y");
});

test("mergeInstalledSkillEntry adopts bundled identity for brand-new seeds", () => {
  const merged = mergeInstalledSkillEntry(
    null,
    {
      marketplaceId: "mp",
      skillId: "a11y",
      pluginName: "ux",
      skillPath: "./community/ux/skills/a11y",
      skillSource: null,
      localPath: "skills-marketplace/mp/ux/a11y",
    },
    "1.0.0",
    "2026-08-12T00:00:00.000Z",
  );

  assert.equal(merged.pluginName, "ux");
  assert.equal(merged.skillPath, "./community/ux/skills/a11y");
  assert.equal(merged.localPath, "skills-marketplace/mp/ux/a11y");
});

test("mergeMarketplaceEntry skips the manifest union when the live entry synced more recently", () => {
  const existing = {
    id: "mp",
    lastSynced: "2026-08-11T20:00:00.000Z",
    cachedManifest: {
      name: "mp",
      plugins: [{ name: "ux", source: "./community/ux", skills: ["./community/ux/skills/a11y"] }],
    },
  };
  const ootb = {
    id: "mp",
    ootb: true,
    lastSynced: "2026-07-21T00:00:00.000Z",
    cachedManifest: {
      name: "mp",
      plugins: [
        { name: "ux-beta", source: "./community/ux-beta", skills: ["./community/ux-beta/skills/a11y"] },
      ],
    },
  };

  const merged = mergeMarketplaceEntry(existing, ootb);
  assert.deepEqual(
    merged.cachedManifest.plugins.map((plugin) => plugin.name),
    ["ux"],
  );
});

test("mergeMarketplaceEntry still unions when the bundle is newer or stamps are missing", () => {
  const livePlugins = [{ name: "ux", source: "./community/ux", skills: [] }];
  const bundlePlugins = [{ name: "brand-new", source: "./community/brand-new", skills: [] }];

  const bundleNewer = mergeMarketplaceEntry(
    { id: "mp", lastSynced: "2026-07-01T00:00:00.000Z", cachedManifest: { plugins: livePlugins } },
    { id: "mp", lastSynced: "2026-08-01T00:00:00.000Z", cachedManifest: { plugins: bundlePlugins } },
  );
  assert.deepEqual(
    bundleNewer.cachedManifest.plugins.map((plugin) => plugin.name),
    ["ux", "brand-new"],
  );

  const missingStamps = mergeMarketplaceEntry(
    { id: "mp", cachedManifest: { plugins: livePlugins } },
    { id: "mp", cachedManifest: { plugins: bundlePlugins } },
  );
  assert.deepEqual(
    missingStamps.cachedManifest.plugins.map((plugin) => plugin.name),
    ["ux", "brand-new"],
  );
});

test("the preserved-skill warning logs once per app run per install", async () => {
  await withTempProject(async (projectRoot) => {
    renameFixtureBundle(projectRoot);
    renameFixtureLive(projectRoot);

    const warns = [];
    const logger = { warn: (message) => warns.push(String(message)) };
    await ensureBundledMarketplaceDefaults(projectRoot, { logger });
    const firstRun = warns.filter((line) =>
      line.includes("Preserving existing skill"),
    ).length;
    assert.equal(firstRun, 1, "the divergence is reported");

    // Config reads re-run the seeder constantly; the same divergence must
    // not re-log every few seconds.
    await ensureBundledMarketplaceDefaults(projectRoot, { logger });
    await ensureBundledMarketplaceDefaults(projectRoot, { logger });
    const total = warns.filter((line) =>
      line.includes("Preserving existing skill"),
    ).length;
    assert.equal(total, 1, "subsequent runs stay quiet");
  });
});
