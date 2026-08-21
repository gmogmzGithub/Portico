// Startup integrity pass — orphan-dir adoption + ghost-record cleanup, run
// once per launch after the OOTB merge and legacy migrations. Contracts under
// test: manifest-validated adoption (exact record shape, disk content as
// baseline), flat adoption + hand-off to the existing plugin migration,
// skip-never-guess rules (staging dirs, solutions dirs, unconfigured
// marketplaces, missing/ambiguous manifest entries, unavailable plugins),
// ghost-drop on dir ENOENT only, repair-beats-ghost-drop ordering,
// idempotence (steady state writes and logs nothing), in-lock re-checks
// against racing mutators, offline operation, and content-free diagnostics.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const marketplaceService = require("./marketplace-service");

function createTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "integrity-pass-test-"));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

const SENTINEL = "SENTINEL-77aa-DO-NOT-LOG";

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

function writeSkillDir(projectRoot, relativeDir, { version, body, extraFiles = {} } = {}) {
  const dir = path.join(projectRoot, ...relativeDir.split("/"));
  fs.mkdirSync(path.join(dir, "references"), { recursive: true });
  const leaf = relativeDir.split("/").filter(Boolean).pop();
  fs.writeFileSync(path.join(dir, "SKILL.md"), skillMarkdown(leaf, { version, body }));
  fs.writeFileSync(path.join(dir, "references", "guide.md"), "reference body");
  for (const [rel, content] of Object.entries(extraFiles)) {
    const target = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return dir;
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function baselineKeySet(baseline) {
  return new Set((baseline?.files || []).map((file) => `${file.path}:${file.sha256}`));
}

function expectedKeySet(dir, relativePaths) {
  return new Set(
    relativePaths.map(
      (rel) => `${rel}:${sha256File(path.join(dir, ...rel.split("/")))}`,
    ),
  );
}

function kwpMarketplaceEntry(overrides = {}) {
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

function baseConfig({ marketplaces = [], installedSkills = [] } = {}) {
  return { version: "1.0", marketplaces, installedSkills };
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

function readConfigBytes(projectRoot) {
  return fs.readFileSync(path.join(projectRoot, "marketplaces.json"), "utf8");
}

const quietLogger = { log() {}, warn() {}, error() {} };

function captureConsole() {
  const captured = [];
  const originals = {};
  for (const level of ["log", "warn", "error", "info"]) {
    originals[level] = console[level];
    console[level] = (...args) => {
      captured.push(args.map((value) => String(value)).join(" "));
    };
  }
  return {
    captured,
    restore() {
      for (const [level, original] of Object.entries(originals)) {
        console[level] = original;
      }
    },
  };
}

async function waitFor(predicate, { timeoutMs = 4000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("waitFor timed out");
}

test("a plugin-layout orphan adopts with the exact install record shape and disk-derived baseline", async () => {
  const projectRoot = createTempRoot();
  try {
    writeConfig(projectRoot, baseConfig({ marketplaces: [kwpMarketplaceEntry()] }));
    const dir = writeSkillDir(projectRoot, "skills-marketplace/kwp/document-skills/pdf", {
      version: "1.2",
    });

    const result = await marketplaceService.runStartupMarketplaceIntegrityPass(
      projectRoot,
      { logger: quietLogger },
    );

    assert.equal(result.adopted.length, 1);
    assert.equal(result.removedGhostRecords, 0);
    const config = readConfig(projectRoot);
    assert.equal(config.installedSkills.length, 1);
    const record = config.installedSkills[0];
    assert.equal(record.marketplaceId, "kwp");
    assert.equal(record.skillId, "pdf");
    assert.equal(record.pluginName, "document-skills");
    assert.equal(record.localPath, "skills-marketplace/kwp/document-skills/pdf");
    assert.equal(record.skillPath, "./document-skills/skills/pdf");
    assert.equal(record.installedVersion, "1.2");
    assert.equal(record.lastCheckedVersion, "1.2");
    assert.equal(record.hasUpdate, false);
    assert.equal(record.skillSource, null);
    assert.ok(record.installedAt, "installedAt stamped");
    assert.deepEqual(
      baselineKeySet(record.baseline),
      expectedKeySet(dir, ["SKILL.md", "references/guide.md"]),
      "baseline is the sha256 of the live content",
    );
  } finally {
    cleanup(projectRoot);
  }
});

test("a flat legacy orphan of a plugin-scoped skill adopts flat, then the next load migrates it", async () => {
  const projectRoot = createTempRoot();
  try {
    writeConfig(projectRoot, baseConfig({ marketplaces: [kwpMarketplaceEntry()] }));
    writeSkillDir(projectRoot, "skills-marketplace/kwp/pdf", { version: "1.0" });

    const result = await marketplaceService.runStartupMarketplaceIntegrityPass(
      projectRoot,
      { logger: quietLogger },
    );
    assert.equal(result.adopted.length, 1);

    const adopted = readConfig(projectRoot).installedSkills[0];
    assert.equal(adopted.pluginName, null, "adopted as a FLAT record");
    assert.equal(adopted.localPath, "skills-marketplace/kwp/pdf");
    assert.equal(adopted.skillPath, "./document-skills/skills/pdf");

    // The existing plugin migration relocates it on the next config load —
    // the integrity pass itself never moves payloads.
    const config = await marketplaceService.loadMarketplacesConfig(projectRoot, {
      logger: quietLogger,
    });
    const migrated = config.installedSkills[0];
    assert.equal(migrated.pluginName, "document-skills");
    assert.equal(migrated.localPath, "skills-marketplace/kwp/document-skills/pdf");
    assert.ok(
      fs.existsSync(
        path.join(projectRoot, "skills-marketplace/kwp/document-skills/pdf/SKILL.md"),
      ),
    );
    assert.ok(!fs.existsSync(path.join(projectRoot, "skills-marketplace/kwp/pdf")));
  } finally {
    cleanup(projectRoot);
  }
});

test("a flat orphan of a genuinely flat entry adopts the manifest's object skillSource and skillPath", async () => {
  const projectRoot = createTempRoot();
  try {
    // Single-skill plugin with a same-repo OBJECT source (passes the
    // allowlist backstop via isSameRepositorySource).
    const objectSource = {
      type: "github",
      repo: "anthropics/knowledge-work-plugins",
      ref: "main",
      path: "./solo",
    };
    const entry = kwpMarketplaceEntry();
    entry.cachedManifest.plugins.push({
      name: "solo",
      description: "Solo skill",
      source: objectSource,
    });
    writeConfig(projectRoot, baseConfig({ marketplaces: [entry] }));
    writeSkillDir(projectRoot, "skills-marketplace/kwp/solo", { version: "2.0" });

    const result = await marketplaceService.runStartupMarketplaceIntegrityPass(
      projectRoot,
      { logger: quietLogger },
    );
    assert.equal(result.adopted.length, 1);
    const record = readConfig(projectRoot).installedSkills[0];
    assert.equal(record.skillId, "solo");
    assert.equal(record.pluginName, null);
    assert.equal(record.skillPath, "./solo");
    // Load-time normalization may enrich the source (e.g. repoUrl); the
    // manifest identity fields must survive verbatim.
    assert.equal(record.skillSource.type, objectSource.type);
    assert.equal(record.skillSource.repo, objectSource.repo);
    assert.equal(record.skillSource.ref, objectSource.ref);
    assert.equal(record.skillSource.path, objectSource.path);
  } finally {
    cleanup(projectRoot);
  }
});

test("skip rules leave the registry byte-identical and emit content-free reasons", async () => {
  const projectRoot = createTempRoot();
  const capture = captureConsole();
  try {
    const entry = kwpMarketplaceEntry();
    // Unavailable single-skill plugin.
    entry.cachedManifest.plugins.push({
      name: "unav",
      description: "External",
      source: "./unav",
      unavailable: true,
      unavailableReason: "plugin_unavailable",
    });
    // Two plugins deriving the same leaf id -> depth-2 ambiguity.
    entry.cachedManifest.plugins.push(
      { name: "alpha", description: "a", skills: ["./alpha/skills/dup"] },
      { name: "beta", description: "b", skills: ["./beta/skills/dup"] },
    );
    const noManifest = {
      id: "nomanifest",
      name: "nomanifest",
      source: { type: "github", repo: "anthropics/example", ref: "main" },
      isSparse: false,
    };
    writeConfig(projectRoot, baseConfig({ marketplaces: [entry, noManifest] }));

    // Candidates that must all be skipped:
    writeSkillDir(projectRoot, "skills-marketplace/kwp/unknown-skill", {});
    writeSkillDir(projectRoot, "skills-marketplace/kwp/unav", {});
    writeSkillDir(projectRoot, "skills-marketplace/kwp/dup", {});
    writeSkillDir(projectRoot, "skills-marketplace/nomanifest/anything", {});
    writeSkillDir(projectRoot, "skills-marketplace/removed-mp/x", {});
    writeSkillDir(projectRoot, "skills-marketplace/ai-marketplace/foo", {});
    fs.writeFileSync(
      path.join(projectRoot, "skills-marketplace/ai-marketplace/foo/foo.yaml"),
      "skill_name: foo\n",
    );
    fs.mkdirSync(path.join(projectRoot, "skills-marketplace/kwp/.pdf.sync-abc"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(projectRoot, "skills-marketplace/kwp/_scratch"), {
      recursive: true,
    });
    // Bundle relic: nested leaves, no root SKILL.md at any scanned depth.
    fs.mkdirSync(
      path.join(projectRoot, "skills-marketplace/kwp/legacy-bundle/skills/a"),
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(projectRoot, "skills-marketplace/kwp/legacy-bundle/skills/a/SKILL.md"),
      skillMarkdown("a"),
    );

    const before = readConfigBytes(projectRoot);
    const result = await marketplaceService.runStartupMarketplaceIntegrityPass(
      projectRoot,
      { logger: quietLogger },
    );

    assert.equal(result.adopted.length, 0);
    assert.equal(result.removedGhostRecords, 0);
    assert.equal(readConfigBytes(projectRoot), before, "registry bytes untouched");
    const reasons = new Set(result.skipped.map((skip) => skip.reason));
    for (const expected of [
      "solutions-dir",
      "unconfigured-marketplace",
      "no-manifest-entry",
      "unavailable",
      "ambiguous-manifest-entry",
      "no-cached-manifest",
      "unrecognized-layout",
    ]) {
      assert.ok(reasons.has(expected), `skip reason ${expected} recorded`);
    }
    const joined = capture.captured.join("\n");
    assert.match(joined, /adopt:skipped/);
    assert.ok(
      !joined.includes("[Marketplace] Integrity pass:"),
      "no summary line when nothing was repaired",
    );
  } finally {
    capture.restore();
    cleanup(projectRoot);
  }
});

test("ghost records drop on dir ENOENT only, for git and solutions records alike", async () => {
  const projectRoot = createTempRoot();
  const capture = captureConsole();
  try {
    const healthyDir = writeSkillDir(
      projectRoot,
      "skills-marketplace/kwp/document-skills/docx",
      { version: "1.0" },
    );
    writeConfig(
      projectRoot,
      baseConfig({
        marketplaces: [kwpMarketplaceEntry()],
        installedSkills: [
          {
            marketplaceId: "kwp",
            skillId: "docx",
            pluginName: "document-skills",
            skillPath: "./document-skills/skills/docx",
            installedVersion: "1.0",
            localPath: "skills-marketplace/kwp/document-skills/docx",
          },
          {
            marketplaceId: "kwp",
            skillId: "gone",
            pluginName: "document-skills",
            skillPath: "./document-skills/skills/gone",
            installedVersion: "1.0",
            localPath: "skills-marketplace/kwp/document-skills/gone",
          },
          {
            marketplaceId: "ai-marketplace",
            skillId: "sol-skill",
            skillPath: "./",
            installedVersion: "1.0",
            localPath: "skills-marketplace/ai-marketplace/sol-skill",
            skillSource: {
              type: "ai-marketplace-solution",
              solutionId: "11111111-2222-3333-4444-555555555555",
            },
          },
        ],
      }),
    );

    const result = await marketplaceService.runStartupMarketplaceIntegrityPass(
      projectRoot,
      { logger: console },
    );

    assert.equal(result.removedGhostRecords, 2);
    const config = readConfig(projectRoot);
    assert.deepEqual(
      config.installedSkills.map((record) => record.skillId),
      ["docx"],
      "only the healthy record survives",
    );
    assert.ok(fs.existsSync(healthyDir));
    assert.match(
      capture.captured.join("\n"),
      /Integrity pass: adopted 0 orphaned skill install\(s\), removed 2 ghost record\(s\)/,
    );
  } finally {
    capture.restore();
    cleanup(projectRoot);
  }
});

test("step-1 repair beats ghost-drop: plugin record with a live flat dir is repaired, not dropped", async () => {
  const projectRoot = createTempRoot();
  try {
    writeSkillDir(projectRoot, "skills-marketplace/kwp/pdf", { version: "1.0" });
    writeConfig(
      projectRoot,
      baseConfig({
        marketplaces: [kwpMarketplaceEntry()],
        installedSkills: [
          {
            marketplaceId: "kwp",
            skillId: "pdf",
            pluginName: "document-skills",
            skillPath: "./document-skills/skills/pdf",
            installedVersion: "1.0",
            localPath: "skills-marketplace/kwp/document-skills/pdf",
          },
        ],
      }),
    );

    const result = await marketplaceService.runStartupMarketplaceIntegrityPass(
      projectRoot,
      { logger: quietLogger },
    );

    assert.equal(result.removedGhostRecords, 0, "repaired record is not a ghost");
    assert.equal(result.adopted.length, 0);
    const config = readConfig(projectRoot);
    assert.equal(config.installedSkills.length, 1);
    assert.equal(config.installedSkills[0].pluginName, "document-skills");
    assert.ok(
      fs.existsSync(
        path.join(projectRoot, "skills-marketplace/kwp/document-skills/pdf/SKILL.md"),
      ),
      "flat dir moved into the plugin layout by the reconcile step",
    );
  } finally {
    cleanup(projectRoot);
  }
});

test("the pass is idempotent: the second run changes nothing and logs nothing", async () => {
  const projectRoot = createTempRoot();
  try {
    writeConfig(projectRoot, baseConfig({ marketplaces: [kwpMarketplaceEntry()] }));
    writeSkillDir(projectRoot, "skills-marketplace/kwp/document-skills/pdf", {
      version: "1.2",
    });

    const first = await marketplaceService.runStartupMarketplaceIntegrityPass(
      projectRoot,
      { logger: quietLogger },
    );
    assert.equal(first.adopted.length, 1);
    const bytesAfterFirst = readConfigBytes(projectRoot);

    const capture = captureConsole();
    try {
      const second = await marketplaceService.runStartupMarketplaceIntegrityPass(
        projectRoot,
        { logger: console },
      );
      assert.equal(second.adopted.length, 0);
      assert.equal(second.removedGhostRecords, 0);
      assert.equal(readConfigBytes(projectRoot), bytesAfterFirst);
      assert.ok(
        !capture.captured.join("\n").includes("[Marketplace] Integrity pass:"),
        "steady state emits no summary line",
      );
    } finally {
      capture.restore();
    }
  } finally {
    cleanup(projectRoot);
  }
});

test("in-lock re-checks: a dir deleted after the scan is not adopted", async () => {
  const projectRoot = createTempRoot();
  const capture = captureConsole();
  try {
    writeConfig(projectRoot, baseConfig({ marketplaces: [kwpMarketplaceEntry()] }));
    const dir = writeSkillDir(
      projectRoot,
      "skills-marketplace/kwp/document-skills/pdf",
      {},
    );

    // Pre-acquire the registry lock so the pass's mutation phase queues; the
    // "integrity plan" diagnostic marks the moment the scan has completed.
    let releaseGate;
    const gate = new Promise((resolve) => {
      releaseGate = resolve;
    });
    const lockHolder = marketplaceService.withRegistryWriteLock(() => gate);

    const passPromise = marketplaceService.runStartupMarketplaceIntegrityPass(
      projectRoot,
      { logger: console },
    );
    try {
      await waitFor(() =>
        capture.captured.some((line) =>
          line.includes("[Marketplace][integrity] plan"),
        ),
      );
      fs.rmSync(dir, { recursive: true, force: true });
    } finally {
      // Always release: a failed waitFor must not deadlock the registry lock.
      releaseGate();
    }
    await lockHolder;

    const result = await passPromise;
    assert.equal(result.adopted.length, 0, "vanished dir is re-checked in-lock");
    assert.deepEqual(readConfig(projectRoot).installedSkills, []);
  } finally {
    capture.restore();
    cleanup(projectRoot);
  }
});

test("in-lock re-checks: a record created after the scan blocks the adoption", async () => {
  const projectRoot = createTempRoot();
  const capture = captureConsole();
  try {
    writeConfig(projectRoot, baseConfig({ marketplaces: [kwpMarketplaceEntry()] }));
    writeSkillDir(projectRoot, "skills-marketplace/kwp/document-skills/pdf", {
      version: "9.9",
    });

    let releaseGate;
    const gate = new Promise((resolve) => {
      releaseGate = resolve;
    });
    const lockHolder = marketplaceService.withRegistryWriteLock(() => gate);

    const passPromise = marketplaceService.runStartupMarketplaceIntegrityPass(
      projectRoot,
      { logger: console },
    );
    try {
      await waitFor(() =>
        capture.captured.some((line) =>
          line.includes("[Marketplace][integrity] plan"),
        ),
      );
      // A racing install records the same localPath while the pass waits.
      // The distinctive skillPath is the marker: neither the load-time
      // version refresh nor a skipped adoption rewrites it (an adoption
      // would have stamped the manifest's "./document-skills/skills/pdf").
      const racedConfig = readConfig(projectRoot);
      racedConfig.installedSkills.push({
        marketplaceId: "kwp",
        skillId: "pdf",
        pluginName: "document-skills",
        skillPath: "./raced/marker",
        installedVersion: "1.0",
        localPath: "skills-marketplace/kwp/document-skills/pdf",
      });
      writeConfig(projectRoot, racedConfig);
    } finally {
      // Always release: a failed waitFor must not deadlock the registry lock.
      releaseGate();
    }
    await lockHolder;

    const result = await passPromise;
    assert.equal(result.adopted.length, 0, "occupied localPath is re-checked in-lock");
    const config = readConfig(projectRoot);
    assert.equal(config.installedSkills.length, 1);
    assert.equal(
      config.installedSkills[0].skillPath,
      "./raced/marker",
      "the racing record's own fields survive (adoption never overwrote them)",
    );
  } finally {
    capture.restore();
    cleanup(projectRoot);
  }
});

test("a concurrent unrelated upsert and the pass both land (lock serialization)", async () => {
  const projectRoot = createTempRoot();
  try {
    writeConfig(projectRoot, baseConfig({ marketplaces: [kwpMarketplaceEntry()] }));
    writeSkillDir(projectRoot, "skills-marketplace/kwp/document-skills/pdf", {});
    writeSkillDir(projectRoot, "skills-marketplace/kwp/document-skills/docx", {});

    await Promise.all([
      marketplaceService.runStartupMarketplaceIntegrityPass(projectRoot, {
        logger: quietLogger,
      }),
      marketplaceService.upsertInstalledSkillRecord({
        projectRoot,
        marketplaceId: "kwp",
        skillId: "docx",
        pluginName: "document-skills",
        skillPath: "./document-skills/skills/docx",
        localPath: "skills-marketplace/kwp/document-skills/docx",
        installedVersion: "1.0",
        logger: quietLogger,
      }),
    ]);

    const skillIds = readConfig(projectRoot)
      .installedSkills.map((record) => record.skillId)
      .sort();
    assert.deepEqual(skillIds, ["docx", "pdf"], "both effects persisted");
  } finally {
    cleanup(projectRoot);
  }
});

test("the pass is fully offline: a network attempt would throw and none happens", async () => {
  const projectRoot = createTempRoot();
  const previousFetch = global.fetch;
  global.fetch = () => {
    throw new Error("network use inside the integrity pass");
  };
  try {
    writeConfig(
      projectRoot,
      baseConfig({
        marketplaces: [kwpMarketplaceEntry()],
        installedSkills: [
          {
            marketplaceId: "kwp",
            skillId: "gone",
            pluginName: "document-skills",
            skillPath: "./document-skills/skills/gone",
            installedVersion: "1.0",
            localPath: "skills-marketplace/kwp/document-skills/gone",
          },
        ],
      }),
    );
    writeSkillDir(projectRoot, "skills-marketplace/kwp/document-skills/pdf", {});

    const result = await marketplaceService.runStartupMarketplaceIntegrityPass(
      projectRoot,
      { logger: quietLogger },
    );
    assert.equal(result.adopted.length, 1);
    assert.equal(result.removedGhostRecords, 1);
  } finally {
    global.fetch = previousFetch;
    cleanup(projectRoot);
  }
});

test("a differing OOTB seed orphan is adopted with the LIVE content as baseline", async () => {
  const projectRoot = createTempRoot();
  try {
    // Bundled defaults: seed record + seed payload for kwp/pdf.
    const ootbDir = path.join(projectRoot, "marketplaces-ootb");
    fs.mkdirSync(path.join(ootbDir, "skills-marketplace", "kwp", "pdf"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(ootbDir, "skills-marketplace", "kwp", "pdf", "SKILL.md"),
      skillMarkdown("pdf", { version: "1.0", body: "bundled body" }),
    );
    const flatEntry = kwpMarketplaceEntry({
      cachedManifest: {
        name: "kwp",
        plugins: [{ name: "pdf", description: "Pdf", source: "./pdf" }],
      },
    });
    fs.writeFileSync(
      path.join(ootbDir, "marketplaces.json"),
      JSON.stringify(
        baseConfig({
          marketplaces: [flatEntry],
          installedSkills: [
            {
              marketplaceId: "kwp",
              skillId: "pdf",
              skillPath: "./pdf",
              installedVersion: "1.0",
              localPath: "skills-marketplace/kwp/pdf",
            },
          ],
        }),
        null,
        2,
      ),
    );
    // Live: same marketplace configured, DIFFERING orphan payload with a
    // local-only extra file, and no record (the ootb-adoption:177 shape).
    writeConfig(projectRoot, baseConfig({ marketplaces: [flatEntry] }));
    const liveDir = writeSkillDir(projectRoot, "skills-marketplace/kwp/pdf", {
      version: "1.1",
      body: "locally edited body",
      extraFiles: { "notes.md": "local-only notes" },
    });

    const result = await marketplaceService.runStartupMarketplaceIntegrityPass(
      projectRoot,
      { logger: quietLogger },
    );

    assert.equal(result.adopted.length, 1);
    const record = readConfig(projectRoot).installedSkills.find(
      (entry) => entry.skillId === "pdf" && entry.marketplaceId === "kwp",
    );
    assert.ok(record, "record adopted for the differing seed orphan");
    assert.equal(record.installedVersion, "1.1", "live version, not the bundled one");
    assert.deepEqual(
      baselineKeySet(record.baseline),
      expectedKeySet(liveDir, ["SKILL.md", "references/guide.md", "notes.md"]),
      "baseline is the LIVE content, local-only file included",
    );
    assert.equal(
      fs.readFileSync(path.join(liveDir, "notes.md"), "utf8"),
      "local-only notes",
      "live payload untouched",
    );
  } finally {
    cleanup(projectRoot);
  }
});

test("integrity diagnostics never leak skill bodies or manifest descriptions (sentinel proof)", async () => {
  const projectRoot = createTempRoot();
  const capture = captureConsole();
  try {
    const entry = kwpMarketplaceEntry();
    entry.cachedManifest.plugins[0].description = SENTINEL;
    writeConfig(
      projectRoot,
      baseConfig({
        marketplaces: [entry],
        installedSkills: [
          {
            marketplaceId: "kwp",
            skillId: "gone",
            pluginName: "document-skills",
            skillPath: "./document-skills/skills/gone",
            installedVersion: "1.0",
            localPath: "skills-marketplace/kwp/document-skills/gone",
          },
        ],
      }),
    );
    writeSkillDir(projectRoot, "skills-marketplace/kwp/document-skills/pdf", {
      body: SENTINEL,
    });
    writeSkillDir(projectRoot, "skills-marketplace/kwp/unknown-orphan", {
      body: SENTINEL,
    });

    const result = await marketplaceService.runStartupMarketplaceIntegrityPass(
      projectRoot,
      { logger: console },
    );
    assert.equal(result.adopted.length, 1);
    assert.equal(result.removedGhostRecords, 1);

    const joined = capture.captured.join("\n");
    assert.ok(capture.captured.length > 0, "diagnostics were captured");
    assert.ok(!joined.includes(SENTINEL), "no content reached the logs");
  } finally {
    capture.restore();
    cleanup(projectRoot);
  }
});
