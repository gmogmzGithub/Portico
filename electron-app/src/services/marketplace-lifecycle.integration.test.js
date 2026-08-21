// Marketplace skill lifecycle — CROSS-MODULE integration journeys.
//
// Unlike the per-module unit suites (which stub their collaborators), these
// tests run the REAL modules together over real filesystem state in a temp
// PROJECT_ROOT: marketplace-ootb seeding + seedMigrations, marketplace-service
// load/sync/removal-executor, agent-skill-relink, agent-local-flags. Remotes
// are mocked at the HTTP seam (global fetch), agents at the injected
// agent-tools seam — everything in between is production code.
//
// Journey map (single-module edges live in the unit suites):
//   A. The 2026-08-11 ux-quality incident end-to-end: stale-bundle machine →
//      app update ships a healed bundle + seedMigrations → silent identity
//      migration at config load → one real sync updates content and clears
//      flags → a later regression to the OLD bundle cannot re-wedge it.
//   B. Leaf rename: bundle migration renames the record + payload, the relink
//      sweep rewrites editable agents (all three reference shapes), flags the
//      read-only agent, and retires the flag after the owner republishes.
//   C. Deletion lifecycle: sync mirrors truth (unused removed silently,
//      in-use → pendingRemovals), the consented executor unlinks + removes,
//      and a reappearing seed installs cleanly afterwards.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const marketplaceService = require("./marketplace-service");
const { runAgentSkillRelinkSweep } = require("./agent-skill-relink");
const agentFlags = require("./agent-local-flags");

// ── minimal HTTP/GitHub fixtures (marketplace-service.test.js idioms) ───────

function createJsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer,
  };
}

function createBinaryResponse(buffer, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: () => null },
    json: async () => {
      throw new Error("binary body");
    },
    text: async () => buffer.toString("latin1"),
    arrayBuffer: async () =>
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  };
}

function createBase64JsonFilePayload(content) {
  return {
    content: Buffer.from(JSON.stringify(content), "utf8").toString("base64"),
    encoding: "base64",
  };
}

async function withMockFetch(handler, callback) {
  const previousFetch = global.fetch;
  global.fetch = async (input, options = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    return await handler(url, options);
  };
  try {
    return await callback();
  } finally {
    global.fetch = previousFetch;
  }
}

function createTarballBuffer(rootName, files) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-archive-"));
  const rootDir = path.join(tempDir, rootName);
  fs.mkdirSync(rootDir, { recursive: true });
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(rootDir, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, contents, "utf8");
  }
  const tarballPath = path.join(tempDir, "repo.tar.gz");
  execFileSync("tar", ["-czf", tarballPath, "-C", tempDir, rootName]);
  const buffer = fs.readFileSync(tarballPath);
  fs.rmSync(tempDir, { recursive: true, force: true });
  return buffer;
}

const REPO = "community/lifecycle-fixture";
const MP_ID = "lifecycle-marketplace";

function marketplaceEntry(lastSynced) {
  return {
    id: MP_ID,
    name: MP_ID,
    source: {
      type: "github",
      repo: REPO,
      repoUrl: `https://github.com/${REPO}`,
      ref: "main",
    },
    marketplaceVersion: "1.0.0",
    lastSynced,
    ootb: true,
  };
}

function withMockRepo({ manifest, archiveFiles, headSha }, callback) {
  const archive = createTarballBuffer("lifecycle-fixture-main", archiveFiles);
  return withMockFetch(async (url) => {
    if (url === `https://api.github.com/repos/${REPO}/contents/.claude-plugin/marketplace.json?ref=main`) {
      return createJsonResponse(createBase64JsonFilePayload(manifest));
    }
    if (url === `https://codeload.github.com/${REPO}/tar.gz/main`) {
      return createBinaryResponse(archive);
    }
    if (url === `https://api.github.com/repos/${REPO}/commits/main`) {
      return createJsonResponse({
        sha: headSha,
        commit: { committer: { date: "2026-08-11T16:11:00Z" } },
      });
    }
    return createJsonResponse({ message: "Not Found" }, 404);
  }, callback);
}

function skillMd(version, body) {
  return `---\nmetadata:\n  version: ${version}\n---\n# Skill\n${body}\n`;
}

function writeTree(root, tree) {
  for (const [relativePath, contents] of Object.entries(tree)) {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, contents, "utf8");
  }
}

function readRegistry(projectRoot) {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, "marketplaces.json"), "utf8"));
}

function withTempProject(fn) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-int-"));
  return Promise.resolve(fn(projectRoot)).finally(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });
}

function withFlagStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-flags-"));
  const deps = { userDataPath: dir };
  const bound = {
    setSkillsNotFoundFlags: (entries) => agentFlags.setSkillsNotFoundFlags(entries, deps),
    reconcileSkillsNotFoundFlags: (input) =>
      agentFlags.reconcileSkillsNotFoundFlags(input, deps),
    listFlags: () => agentFlags.listFlags(deps),
  };
  return Promise.resolve(fn(bound)).finally(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Journey A — the ux-quality incident, end-to-end.
// ─────────────────────────────────────────────────────────────────────────────

test("journey A: stale-bundle machine heals silently on bundle update, syncs clean, and never regresses", async () => {
  await withTempProject(async (projectRoot) => {
    const oldContent = skillMd("0.2.0", "old body");
    const newContent = skillMd("1.0.0", "audited body");

    // Machine state before the app update: record + payload + bundle all at
    // the OLD identity, sweep flag stuck on (the incident's steady state).
    writeTree(projectRoot, {
      [`skills-marketplace/${MP_ID}/ux-beta/a11y/SKILL.md`]: oldContent,
      [`marketplaces-ootb/skills-marketplace/${MP_ID}/ux-beta/a11y/SKILL.md`]: oldContent,
    });
    const oldRecord = {
      marketplaceId: MP_ID,
      skillId: "a11y",
      pluginName: "ux-beta",
      skillPath: "./community/ux-beta/skills/a11y",
      skillSource: null,
      installedAt: "2026-07-24T00:00:00.000Z",
      installedVersion: "0.2.0",
      localPath: `skills-marketplace/${MP_ID}/ux-beta/a11y`,
      hasUpdate: true,
      updateHeadCommittedAt: "2026-08-11T10:00:00.000Z",
      contentHeadSha: "pre-rename-sha",
    };
    const oldBundle = {
      version: "1.0",
      marketplaces: [marketplaceEntry("2026-07-21T00:00:00.000Z")],
      installedSkills: [oldRecord],
    };
    fs.mkdirSync(path.join(projectRoot, "marketplaces-ootb"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, "marketplaces-ootb", "marketplaces.json"),
      JSON.stringify(oldBundle, null, 2),
    );
    fs.writeFileSync(
      path.join(projectRoot, "marketplaces.json"),
      JSON.stringify(
        {
          version: "1.0",
          marketplaces: [marketplaceEntry("2026-08-01T00:00:00.000Z")],
          installedSkills: [oldRecord],
        },
        null,
        2,
      ),
    );

    // "App update": the operator re-mirrored post-rename — seeds at the new
    // identity + the seedMigrations alias the mirror script generated.
    const newSeed = {
      marketplaceId: MP_ID,
      skillId: "a11y",
      pluginName: "ux",
      skillPath: "./community/ux/skills/a11y",
      skillSource: null,
      installedVersion: "1.0.0",
      localPath: `skills-marketplace/${MP_ID}/ux/a11y`,
    };
    const newBundle = {
      version: "1.0",
      marketplaces: [marketplaceEntry("2026-08-12T00:00:00.000Z")],
      installedSkills: [newSeed],
      seedMigrations: [
        {
          from: { marketplaceId: MP_ID, pluginName: "ux-beta", skillId: "a11y" },
          to: { marketplaceId: MP_ID, pluginName: "ux", skillId: "a11y" },
        },
      ],
    };
    fs.rmSync(path.join(projectRoot, "marketplaces-ootb"), { recursive: true, force: true });
    writeTree(projectRoot, {
      [`marketplaces-ootb/skills-marketplace/${MP_ID}/ux/a11y/SKILL.md`]: newContent,
    });
    fs.writeFileSync(
      path.join(projectRoot, "marketplaces-ootb", "marketplaces.json"),
      JSON.stringify(newBundle, null, 2),
    );

    // First config load after the update: SILENT identity heal.
    const config = await marketplaceService.loadMarketplacesConfig(projectRoot);
    const migrated = config.installedSkills.find((entry) => entry.skillId === "a11y");
    assert.equal(migrated.pluginName, "ux");
    assert.equal(migrated.skillPath, "./community/ux/skills/a11y");
    assert.equal(migrated.localPath, `skills-marketplace/${MP_ID}/ux/a11y`);
    assert.equal(migrated.hasUpdate, true, "content reconciliation stays with sync");
    assert.equal(
      fs.readFileSync(
        path.join(projectRoot, "skills-marketplace", MP_ID, "ux", "a11y", "SKILL.md"),
        "utf8",
      ),
      oldContent,
      "live bytes moved, not replaced by the bundle",
    );
    assert.equal(
      fs.existsSync(path.join(projectRoot, "skills-marketplace", MP_ID, "ux-beta")),
      false,
      "old plugin dir pruned — the mirror is clean",
    );

    // One real sync now pulls the post-rename content and clears the flag.
    const manifest = {
      name: MP_ID,
      owner: { name: "Community" },
      metadata: { version: "1.0.0" },
      plugins: [
        {
          name: "ux",
          description: "UX quality",
          skills: ["./community/ux/skills/a11y"],
        },
      ],
    };
    const syncResult = await withMockRepo(
      {
        manifest,
        archiveFiles: { "community/ux/skills/a11y/SKILL.md": newContent },
        headSha: "post-rename-sha",
      },
      () =>
        marketplaceService.syncMarketplace({
          projectRoot,
          marketplaceId: MP_ID,
          listAgentReferences: async () => [],
        }),
    );
    assert.equal(syncResult.skillSyncErrors.length, 0);
    assert.equal(syncResult.pendingRemovals.length, 0);
    assert.equal(syncResult.skillsUpdated.length, 1);

    const healed = readRegistry(projectRoot).installedSkills.find(
      (entry) => entry.skillId === "a11y",
    );
    assert.equal(healed.hasUpdate, false);
    assert.equal(healed.updateHeadCommittedAt, undefined);
    assert.equal(healed.installedVersion, "1.0.0");

    // Regression guard: even if the OLD bundle came back (downgrade), the
    // healed identity survives — no migration runs backwards, no field-level
    // merge drags skillPath back.
    fs.writeFileSync(
      path.join(projectRoot, "marketplaces-ootb", "marketplaces.json"),
      JSON.stringify(oldBundle, null, 2),
    );
    writeTree(projectRoot, {
      [`marketplaces-ootb/skills-marketplace/${MP_ID}/ux-beta/a11y/SKILL.md`]: oldContent,
    });
    const downgraded = await marketplaceService.loadMarketplacesConfig(projectRoot);
    const survivor = downgraded.installedSkills.find((entry) => entry.skillId === "a11y");
    assert.equal(survivor.pluginName, "ux");
    assert.equal(survivor.skillPath, "./community/ux/skills/a11y");
    assert.equal(
      fs.readFileSync(
        path.join(projectRoot, "skills-marketplace", MP_ID, "ux", "a11y", "SKILL.md"),
        "utf8",
      ),
      newContent,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Journey B — leaf rename: record + payload + agent references + flags.
// ─────────────────────────────────────────────────────────────────────────────

test("journey B: a leaf rename migrates the record and relinks agents; the read-only flag retires after the owner republishes", async () => {
  await withTempProject(async (projectRoot) => {
    await withFlagStore(async (flags) => {
      writeTree(projectRoot, {
        [`skills-marketplace/${MP_ID}/ux/a11y/SKILL.md`]: skillMd("1.0.0", "body"),
        [`marketplaces-ootb/skills-marketplace/${MP_ID}/ux/a11y-quality/SKILL.md`]:
          skillMd("1.0.0", "body"),
      });
      fs.writeFileSync(
        path.join(projectRoot, "marketplaces.json"),
        JSON.stringify(
          {
            version: "1.0",
            marketplaces: [marketplaceEntry("2026-08-01T00:00:00.000Z")],
            installedSkills: [
              {
                marketplaceId: MP_ID,
                skillId: "a11y",
                pluginName: "ux",
                skillPath: "./community/ux/skills/a11y",
                skillSource: null,
                installedVersion: "1.0.0",
                localPath: `skills-marketplace/${MP_ID}/ux/a11y`,
              },
            ],
          },
          null,
          2,
        ),
      );
      const bundle = {
        version: "1.0",
        marketplaces: [marketplaceEntry("2026-08-12T00:00:00.000Z")],
        installedSkills: [
          {
            marketplaceId: MP_ID,
            skillId: "a11y-quality",
            pluginName: "ux",
            skillPath: "./community/ux/skills/a11y-quality",
            skillSource: null,
            installedVersion: "1.0.0",
            localPath: `skills-marketplace/${MP_ID}/ux/a11y-quality`,
          },
        ],
        seedMigrations: [
          {
            from: { marketplaceId: MP_ID, pluginName: "ux", skillId: "a11y" },
            to: { marketplaceId: MP_ID, pluginName: "ux", skillId: "a11y-quality" },
          },
        ],
      };
      fs.writeFileSync(
        path.join(projectRoot, "marketplaces-ootb", "marketplaces.json"),
        JSON.stringify(bundle, null, 2),
      );

      const config = await marketplaceService.loadMarketplacesConfig(projectRoot);
      const migrated = config.installedSkills.find(
        (entry) => entry.skillId === "a11y-quality",
      );
      assert.ok(migrated, "record renamed to the new leaf");
      assert.equal(
        fs.existsSync(path.join(projectRoot, "skills-marketplace", MP_ID, "ux", "a11y")),
        false,
      );

      // Relink sweep over live agents: editable rewritten in all shapes,
      // read-only flagged.
      const agentState = {
        editable: ["a11y", `${MP_ID}/a11y`, `${MP_ID}/ux/a11y`, "other-skill"],
        readOnly: ["a11y"],
      };
      const updates = [];
      const tools = {
        listAgents: async () => [
          {
            id: "agent-edit",
            name: "Edit Agent",
            relationship: null,
            readOnly: false,
            skillIds: agentState.editable,
          },
          {
            id: "agent-ro",
            name: "RO Agent",
            relationship: "installed",
            readOnly: true,
            skillIds: agentState.readOnly,
          },
        ],
        updateAgentSkillIds: async (agentId, skillIds) => {
          updates.push({ agentId, skillIds });
          agentState.editable = skillIds;
        },
      };
      const sweep = await runAgentSkillRelinkSweep({
        projectRoot,
        agentTools: tools,
        agentFlags: flags,
      });
      assert.equal(sweep.refsRewritten, 3);
      assert.deepEqual(updates, [
        {
          agentId: "agent-edit",
          skillIds: [
            "a11y-quality",
            `${MP_ID}/a11y-quality`,
            `${MP_ID}/ux/a11y-quality`,
            "other-skill",
          ],
        },
      ]);
      assert.deepEqual(sweep.agentsFlagged, [{ id: "agent-ro", name: "RO Agent" }]);
      assert.deepEqual((await flags.listFlags())["agent-ro"][0].skills, ["a11y"]);

      // "Owner republishes": the installed copy now references the new leaf.
      agentState.readOnly = ["a11y-quality"];
      const secondSweep = await runAgentSkillRelinkSweep({
        projectRoot,
        agentTools: tools,
        agentFlags: flags,
      });
      assert.deepEqual(secondSweep.agentsUpdated, [], "idempotent for healed agents");
      assert.deepEqual(await flags.listFlags(), {}, "flag retired");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Journey C — deletion lifecycle: sync mirror → consent executor → reappear.
// ─────────────────────────────────────────────────────────────────────────────

test("journey C: sync mirrors deletions, the consented executor unlinks and removes, and a reappearing seed installs cleanly", async () => {
  await withTempProject(async (projectRoot) => {
    const keptContent = skillMd("1.0.0", "kept");
    writeTree(projectRoot, {
      [`skills-marketplace/${MP_ID}/tools/kept/SKILL.md`]: keptContent,
      [`skills-marketplace/${MP_ID}/tools/gone-unused/SKILL.md`]: skillMd("1.0.0", "u"),
      [`skills-marketplace/${MP_ID}/tools/gone-used/SKILL.md`]: skillMd("1.0.0", "x"),
    });
    const record = (skillId, extra = {}) => ({
      marketplaceId: MP_ID,
      skillId,
      pluginName: "tools",
      skillPath: `./skills/${skillId}`,
      skillSource: null,
      installedVersion: "1.0.0",
      localPath: `skills-marketplace/${MP_ID}/tools/${skillId}`,
      ...extra,
    });
    fs.writeFileSync(
      path.join(projectRoot, "marketplaces.json"),
      JSON.stringify(
        {
          version: "1.0",
          marketplaces: [marketplaceEntry("2026-08-01T00:00:00.000Z")],
          installedSkills: [
            record("kept", {
              baseline: {
                version: "1.0.0",
                files: [],
              },
            }),
            record("gone-unused"),
            record("gone-used"),
          ],
        },
        null,
        2,
      ),
    );
    // No OOTB bundle in this journey: user-installed skills only.

    const manifest = {
      name: MP_ID,
      owner: { name: "Community" },
      metadata: { version: "1.0.0" },
      plugins: [{ name: "tools", description: "tools", skills: ["./skills/kept"] }],
    };
    const repo = {
      manifest,
      archiveFiles: { "skills/kept/SKILL.md": keptContent },
      headSha: "head-1",
    };

    const syncResult = await withMockRepo(repo, () =>
      marketplaceService.syncMarketplace({
        projectRoot,
        marketplaceId: MP_ID,
        listAgentReferences: async () => [
          {
            id: "agent-edit",
            name: "Edit Agent",
            relationship: null,
            leaves: new Set(["gone-used"]),
          },
        ],
      }),
    );
    assert.deepEqual(
      syncResult.skillsRemoved.map((entry) => entry.skillId),
      ["gone-unused"],
    );
    assert.equal(syncResult.pendingRemovals.length, 1);
    assert.equal(syncResult.pendingRemovals[0].skillId, "gone-used");
    assert.equal(syncResult.skillSyncErrors.length, 0);

    // Consent: the executor unlinks the editable agent and removes the skill.
    const updates = [];
    const applied = await marketplaceService.applyMarketplaceSyncRemovals({
      projectRoot,
      marketplaceId: MP_ID,
      removals: [{ skillId: "gone-used", pluginName: "tools" }],
      agentTools: {
        listAgents: async () => [
          {
            id: "agent-edit",
            name: "Edit Agent",
            relationship: null,
            readOnly: false,
            skillIds: ["gone-used", "other"],
          },
        ],
        updateAgentSkillIds: async (agentId, skillIds) => {
          updates.push({ agentId, skillIds });
        },
      },
    });
    assert.deepEqual(applied.removed.map((entry) => entry.skillId), ["gone-used"]);
    assert.deepEqual(updates, [{ agentId: "agent-edit", skillIds: ["other"] }]);

    const registry = readRegistry(projectRoot);
    assert.deepEqual(
      registry.installedSkills.map((entry) => entry.skillId),
      ["kept"],
    );
    assert.equal(
      fs.existsSync(path.join(projectRoot, "skills-marketplace", MP_ID, "tools", "gone-used")),
      false,
    );

    // A later sync finds nothing pending — the mirror converged.
    const resync = await withMockRepo(repo, () =>
      marketplaceService.syncMarketplace({
        projectRoot,
        marketplaceId: MP_ID,
        listAgentReferences: async () => [],
      }),
    );
    assert.equal(resync.pendingRemovals.length, 0);
    assert.deepEqual(resync.skillsRemoved, []);

    // Reappearance: a bundle later ships gone-used again → it seeds cleanly
    // as a fresh install (no tombstones, no memory needed).
    writeTree(projectRoot, {
      [`marketplaces-ootb/skills-marketplace/${MP_ID}/tools/gone-used/SKILL.md`]:
        skillMd("2.0.0", "reborn"),
    });
    fs.writeFileSync(
      path.join(projectRoot, "marketplaces-ootb", "marketplaces.json"),
      JSON.stringify(
        {
          version: "1.0",
          marketplaces: [marketplaceEntry("2026-08-13T00:00:00.000Z")],
          installedSkills: [record("gone-used", { installedVersion: "2.0.0" })],
        },
        null,
        2,
      ),
    );
    const reborn = await marketplaceService.loadMarketplacesConfig(projectRoot);
    const rebornRecord = reborn.installedSkills.find(
      (entry) => entry.skillId === "gone-used",
    );
    assert.ok(rebornRecord, "seed re-installed");
    assert.equal(rebornRecord.installedVersion, "2.0.0");
    assert.equal(
      fs.readFileSync(
        path.join(projectRoot, "skills-marketplace", MP_ID, "tools", "gone-used", "SKILL.md"),
        "utf8",
      ),
      skillMd("2.0.0", "reborn"),
    );
  });
});
