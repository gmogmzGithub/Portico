// Git-marketplace sync performance behaviors: the skip-unchanged short-circuit
// (probed head sha === record stamp + clean + baselined ⇒ zero downloads), the
// two-phase parallel skill loop (deterministic ordered apply, cap 4), parallel
// per-file downloads (cap 4, first-by-index failure), github archive-once,
// fast-fail head probes, per-group auth reuse, and the sync duration diag.
// Lives in its own file: marketplace-service.test.js is another session's
// active file. Harness patterns copied from there (require-cache injection +
// global-fetch mock).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const marketplaceServicePath = require.resolve("./marketplace-service");
const marketplaceOotbPath = require.resolve("./marketplace-ootb");
const gitlabMarketplaceAuthPath = require.resolve("./gitlab-marketplace-auth");
const marketplaceOotb = require("./marketplace-ootb");

function createJsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function createBinaryResponse(buffer, status = 200, headers = {}) {
  return new Response(buffer, {
    status,
    headers: { "Content-Type": "application/octet-stream", ...headers },
  });
}

function createBase64JsonFilePayload(content) {
  return {
    encoding: "base64",
    content: Buffer.from(JSON.stringify(content), "utf8").toString("base64"),
  };
}

function createBase64TextFilePayload(content) {
  return {
    encoding: "base64",
    content: Buffer.from(content, "utf8").toString("base64"),
  };
}

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupDir(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function createBundledDefaultsStub() {
  return async function ensureBundledMarketplaceDefaults(projectRoot) {
    const configPath = path.join(projectRoot, "marketplaces.json");
    if (fs.existsSync(configPath)) {
      return { config: JSON.parse(fs.readFileSync(configPath, "utf8")) };
    }
    return { config: { version: "1.0", marketplaces: [], installedSkills: [] } };
  };
}

function loadMarketplaceService({
  gitlabMarketplaceAuthExports = {
    getAuthorizedSession: async () => ({ accessToken: "gitlab-token" }),
  },
} = {}) {
  const previousMarketplaceService = require.cache[marketplaceServicePath];
  const previousMarketplaceOotb = require.cache[marketplaceOotbPath];
  const previousGitlabMarketplaceAuth = require.cache[gitlabMarketplaceAuthPath];

  require.cache[marketplaceOotbPath] = {
    id: marketplaceOotbPath,
    filename: marketplaceOotbPath,
    loaded: true,
    exports: {
      ...marketplaceOotb,
      ensureBundledMarketplaceDefaults: createBundledDefaultsStub(),
    },
  };
  require.cache[gitlabMarketplaceAuthPath] = {
    id: gitlabMarketplaceAuthPath,
    filename: gitlabMarketplaceAuthPath,
    loaded: true,
    exports: gitlabMarketplaceAuthExports,
  };
  delete require.cache[marketplaceServicePath];
  const service = require("./marketplace-service");

  return {
    service,
    restore() {
      delete require.cache[marketplaceServicePath];
      if (previousMarketplaceService) {
        require.cache[marketplaceServicePath] = previousMarketplaceService;
      }
      if (previousMarketplaceOotb) {
        require.cache[marketplaceOotbPath] = previousMarketplaceOotb;
      } else {
        delete require.cache[marketplaceOotbPath];
      }
      if (previousGitlabMarketplaceAuth) {
        require.cache[gitlabMarketplaceAuthPath] = previousGitlabMarketplaceAuth;
      } else {
        delete require.cache[gitlabMarketplaceAuthPath];
      }
    },
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

// ---- gitlab fixture marketplace -----------------------------------------------

const GL_HOST = "https://example.invalid";
const GL_PROJECT = "perf%2Fskills-marketplace";
const OLD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEAD_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function skillMarkdown(version, body = "Body") {
  return ["---", "metadata:", `  version: ${version}`, "---", "", "# Skill", "", body, ""].join(
    "\n",
  );
}

function glManifest(skillIds) {
  return {
    name: "perfmp",
    owner: { name: "Perf" },
    metadata: { description: "perf fixture", version: "1.0.0" },
    plugins: [
      {
        name: "perf-skills",
        description: "perf skills",
        skills: skillIds.map((skillId) => `./skills/${skillId}`),
      },
    ],
  };
}

function glConfig(installedSkills, skillIds) {
  return {
    version: "1.0",
    marketplaces: [
      {
        id: "perfmp",
        name: "perfmp",
        source: {
          type: "gitlab",
          host: "example.invalid",
          projectPath: "perf/skills-marketplace",
          repoUrl: "https://example.invalid/perf/skills-marketplace.git",
          ref: "main",
        },
        cachedManifest: glManifest(skillIds),
        marketplaceVersion: "1.0.0",
      },
    ],
    installedSkills,
  };
}

function glRecord(projectRoot, skillId, { markdown, stamp, baseline = true, extraFiles = {} } = {}) {
  const localPath = `skills-marketplace/perfmp/perf-skills/${skillId}`;
  const dir = path.join(projectRoot, localPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), markdown);
  const baselineFiles = [{ path: "SKILL.md", sha256: sha256(markdown) }];
  for (const [rel, contents] of Object.entries(extraFiles)) {
    const abs = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
    baselineFiles.push({ path: rel, sha256: sha256(contents) });
  }
  baselineFiles.sort((a, b) => a.path.localeCompare(b.path));
  return {
    marketplaceId: "perfmp",
    skillId,
    pluginName: "perf-skills",
    skillPath: `./skills/${skillId}`,
    installedVersion: "1.0.0",
    lastCheckedVersion: "1.0.0",
    localPath,
    ...(stamp ? { contentHeadSha: stamp } : {}),
    ...(baseline
      ? { baseline: { version: "1.0.0", sourceRef: "main", files: baselineFiles } }
      : {}),
  };
}

// URL-dispatching mock for the whole gitlab sync surface with call recording.
// remoteSkills: { [skillId]: { files: { [relPath]: contents } } }
function createGitLabSyncMock({
  skillIds,
  remoteSkills,
  headSha = HEAD_SHA,
  commitsStatus = 200,
  failFilePaths = new Set(),
  responseDelayMsFor = null,
}) {
  const calls = { manifest: 0, commits: 0, tree: [], files: [], other: [] };
  const inFlight = { tree: 0, files: 0 };
  const peaks = { tree: 0, files: 0 };

  async function trackConcurrency(kind, work) {
    inFlight[kind] += 1;
    peaks[kind] = Math.max(peaks[kind], inFlight[kind]);
    // Yield so overlapping requests are actually observed concurrently.
    await new Promise((resolve) => setImmediate(resolve));
    try {
      return await work();
    } finally {
      inFlight[kind] -= 1;
    }
  }

  const handler = async (url) => {
    if (url.includes(`/projects/${GL_PROJECT}/repository/files/.atlas-plugin%2Fmarketplace.json`)) {
      calls.manifest += 1;
      return createJsonResponse(createBase64JsonFilePayload(glManifest(skillIds)));
    }
    if (url.includes(`/projects/${GL_PROJECT}/repository/commits/`)) {
      calls.commits += 1;
      if (commitsStatus !== 200) {
        return createJsonResponse({ message: "boom" }, commitsStatus);
      }
      return createJsonResponse({ id: headSha, committed_date: "2026-08-13T00:00:00Z" });
    }
    if (url.includes(`/projects/${GL_PROJECT}/repository/tree`)) {
      const treePath = decodeURIComponent(
        new URL(url).searchParams.get("path") || "",
      );
      const skillId = treePath.replace(/^skills\//, "");
      calls.tree.push(skillId);
      return trackConcurrency("tree", async () => {
        if (responseDelayMsFor) {
          await new Promise((resolve) => setTimeout(resolve, responseDelayMsFor(skillId)));
        }
        const remote = remoteSkills[skillId];
        if (!remote) return createJsonResponse([]);
        return createJsonResponse(
          Object.keys(remote.files).map((rel) => ({
            id: `${skillId}-${rel}`,
            name: rel.split("/").pop(),
            path: `skills/${skillId}/${rel}`,
            type: "blob",
            mode: "100644",
          })),
        );
      });
    }
    if (url.includes(`/projects/${GL_PROJECT}/repository/files/skills%2F`)) {
      const encodedPath = url.split("/repository/files/")[1].split("?")[0];
      const filePath = decodeURIComponent(encodedPath);
      calls.files.push(filePath);
      return trackConcurrency("files", async () => {
        const [, skillId, ...rest] = filePath.split("/");
        const rel = rest.join("/");
        if (responseDelayMsFor) {
          await new Promise((resolve) => setTimeout(resolve, responseDelayMsFor(skillId)));
        }
        if (failFilePaths.has(filePath)) {
          return createJsonResponse({ message: "boom" }, 500);
        }
        const contents = remoteSkills[skillId]?.files?.[rel];
        if (contents === undefined) return createJsonResponse({ message: "nf" }, 404);
        return createJsonResponse(createBase64TextFilePayload(contents));
      });
    }
    calls.other.push(url);
    return createJsonResponse({ message: "Not Found" }, 404);
  };

  return { handler, calls, peaks };
}

async function captureSyncDiag(callback) {
  const captured = [];
  const original = console.log;
  console.log = (...args) => {
    captured.push(args);
  };
  try {
    await callback();
  } finally {
    console.log = original;
  }
  const line = captured.find((args) => String(args[0] || "").startsWith("[Marketplace][sync] ok"));
  if (!line) return null;
  return JSON.parse(line[1]);
}

const QUIET = { log() {}, warn() {}, info() {} };

// ---- tests ---------------------------------------------------------------------

test("steady state: sha-match + clean + baselined skips every download (with diag)", async () => {
  const projectRoot = createTempDir("sync-perf-skip-");
  const { service, restore } = loadMarketplaceService();
  try {
    const skillIds = ["skill-01", "skill-02", "skill-03"];
    const markdown = skillMarkdown("1.2.0");
    const records = skillIds.map((skillId) =>
      glRecord(projectRoot, skillId, { markdown, stamp: HEAD_SHA }),
    );
    writeJson(path.join(projectRoot, "marketplaces.json"), glConfig(records, skillIds));
    const mock = createGitLabSyncMock({ skillIds, remoteSkills: {} });

    let result;
    const diag = await captureSyncDiag(async () => {
      result = await withMockFetch(mock.handler, () =>
        service.syncMarketplace({ projectRoot, marketplaceId: "perfmp", logger: QUIET }),
      );
    });

    assert.deepEqual(mock.calls.tree, [], "no skill tree fetches");
    assert.deepEqual(mock.calls.files, [], "no skill file fetches");
    assert.equal(mock.calls.commits, 1, "one head probe for the group");
    assert.deepEqual(
      result.skillsUpToDate,
      skillIds.map((skillId) => ({ skillId, reason: "content_unchanged" })),
      "record-order current results",
    );
    assert.deepEqual(result.skillsUpdated, []);
    assert.deepEqual(result.skillSyncErrors, []);
    const saved = readJson(path.join(projectRoot, "marketplaces.json"));
    for (const installed of saved.installedSkills) {
      assert.equal(installed.contentHeadSha, HEAD_SHA);
      assert.equal(installed.lastCheckedVersion, "1.2.0", "version read from the local copy");
      assert.equal(installed.hasUpdate, false);
    }
    assert.ok(diag, "sync emitted a duration diag");
    assert.equal(diag.marketplaceId, "perfmp");
    assert.equal(diag.skillCount, 3);
    assert.equal(diag.skipped, 3);
    assert.equal(diag.downloaded, 0);
    assert.equal(diag.failed, 0);
    for (const key of ["durationMs", "manifestMs", "headProbeMs", "skillsMs"]) {
      assert.equal(typeof diag[key], "number", `${key} present`);
    }
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("a dirty record still downloads and conflicts; clean siblings skip", async () => {
  const projectRoot = createTempDir("sync-perf-dirty-");
  const { service, restore } = loadMarketplaceService();
  try {
    const skillIds = ["skill-01", "skill-02", "skill-03"];
    const markdown = skillMarkdown("1.2.0");
    const records = skillIds.map((skillId) =>
      glRecord(projectRoot, skillId, { markdown, stamp: HEAD_SHA }),
    );
    // Dirty skill-02 on disk; its remote content also moved past the baseline.
    fs.appendFileSync(
      path.join(projectRoot, records[1].localPath, "SKILL.md"),
      "\nlocal edit\n",
    );
    writeJson(path.join(projectRoot, "marketplaces.json"), glConfig(records, skillIds));
    const mock = createGitLabSyncMock({
      skillIds,
      remoteSkills: {
        "skill-02": { files: { "SKILL.md": skillMarkdown("1.2.0", "Remote moved") } },
      },
    });

    const result = await withMockFetch(mock.handler, () =>
      service.syncMarketplace({ projectRoot, marketplaceId: "perfmp", logger: QUIET }),
    );

    assert.deepEqual(mock.calls.tree, ["skill-02"], "only the dirty record downloaded");
    assert.deepEqual(
      result.skillsConflicted.map((entry) => entry.skillId),
      ["skill-02"],
    );
    assert.deepEqual(
      result.skillsUpToDate.map((entry) => entry.skillId),
      ["skill-01", "skill-03"],
    );
    const dirtyContent = fs.readFileSync(
      path.join(projectRoot, records[1].localPath, "SKILL.md"),
      "utf8",
    );
    assert.match(dirtyContent, /local edit/, "local edits preserved on conflict");
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("legacy unstamped and baseline-less records take the full download path", async () => {
  const projectRoot = createTempDir("sync-perf-legacy-");
  const { service, restore } = loadMarketplaceService();
  try {
    const skillIds = ["skill-01", "skill-02"];
    const markdown = skillMarkdown("1.2.0");
    const records = [
      // No contentHeadSha stamp.
      glRecord(projectRoot, "skill-01", { markdown }),
      // Stamped but no baseline (vacuously-clean trap).
      glRecord(projectRoot, "skill-02", { markdown, stamp: HEAD_SHA, baseline: false }),
    ];
    writeJson(path.join(projectRoot, "marketplaces.json"), glConfig(records, skillIds));
    const mock = createGitLabSyncMock({
      skillIds,
      remoteSkills: {
        "skill-01": { files: { "SKILL.md": markdown } },
        "skill-02": { files: { "SKILL.md": markdown } },
      },
    });

    const result = await withMockFetch(mock.handler, () =>
      service.syncMarketplace({ projectRoot, marketplaceId: "perfmp", logger: QUIET }),
    );

    assert.deepEqual(mock.calls.tree.sort(), ["skill-01", "skill-02"], "both downloaded");
    assert.equal(result.skillsUpToDate.length, 2);
    const saved = readJson(path.join(projectRoot, "marketplaces.json"));
    const byId = new Map(saved.installedSkills.map((entry) => [entry.skillId, entry]));
    assert.equal(byId.get("skill-01").contentHeadSha, HEAD_SHA, "legacy record stamped");
    assert.ok(
      Array.isArray(byId.get("skill-02").baseline?.files) &&
        byId.get("skill-02").baseline.files.length > 0,
      "baseline backfilled",
    );
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("probe failure disables the short-circuit and preserves existing stamps", async () => {
  const projectRoot = createTempDir("sync-perf-probe-fail-");
  const { service, restore } = loadMarketplaceService();
  try {
    const skillIds = ["skill-01", "skill-02"];
    const markdown = skillMarkdown("1.2.0");
    const records = skillIds.map((skillId) =>
      glRecord(projectRoot, skillId, { markdown, stamp: OLD_SHA }),
    );
    writeJson(path.join(projectRoot, "marketplaces.json"), glConfig(records, skillIds));
    const mock = createGitLabSyncMock({
      skillIds,
      commitsStatus: 500,
      remoteSkills: {
        "skill-01": { files: { "SKILL.md": markdown } },
        "skill-02": { files: { "SKILL.md": markdown } },
      },
    });

    const result = await withMockFetch(mock.handler, () =>
      service.syncMarketplace({ projectRoot, marketplaceId: "perfmp", logger: QUIET }),
    );

    assert.deepEqual(mock.calls.tree.sort(), ["skill-01", "skill-02"], "no skips");
    assert.equal(result.skillsUpToDate.length, 2);
    const saved = readJson(path.join(projectRoot, "marketplaces.json"));
    for (const installed of saved.installedSkills) {
      assert.equal(installed.contentHeadSha, OLD_SHA, "existing stamp preserved");
    }
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("parallel loop applies deterministically in record order under a cap of 4", async () => {
  const projectRoot = createTempDir("sync-perf-parallel-");
  const { service, restore } = loadMarketplaceService();
  try {
    const skillIds = ["skill-01", "skill-02", "skill-03", "skill-04", "skill-05", "skill-06", "skill-07", "skill-08"];
    const markdown = skillMarkdown("1.2.0");
    const remoteMarkdown = skillMarkdown("1.3.0", "Remote moved");
    const records = skillIds.map((skillId) =>
      glRecord(projectRoot, skillId, { markdown, stamp: OLD_SHA }),
    );
    writeJson(path.join(projectRoot, "marketplaces.json"), glConfig(records, skillIds));
    const remoteSkills = Object.fromEntries(
      skillIds.map((skillId) => [skillId, { files: { "SKILL.md": remoteMarkdown } }]),
    );
    // Later-indexed skills respond FASTER so completion order reverses.
    const mock = createGitLabSyncMock({
      skillIds,
      remoteSkills,
      responseDelayMsFor: (skillId) => {
        const index = skillIds.indexOf(skillId);
        return index >= 0 ? (skillIds.length - index) * 3 : 0;
      },
    });

    const result = await withMockFetch(mock.handler, () =>
      service.syncMarketplace({ projectRoot, marketplaceId: "perfmp", logger: QUIET }),
    );

    assert.deepEqual(
      result.skillsUpdated.map((entry) => entry.skillId),
      skillIds,
      "updates reported in record order regardless of completion order",
    );
    assert.ok(mock.peaks.tree <= 4, `skill-level concurrency capped (peak ${mock.peaks.tree})`);
    assert.ok(mock.peaks.tree >= 2, "skills actually overlapped");
    const saved = readJson(path.join(projectRoot, "marketplaces.json"));
    assert.deepEqual(
      saved.installedSkills.map((entry) => entry.skillId),
      skillIds,
      "record order stable",
    );
    for (const installed of saved.installedSkills) {
      assert.equal(installed.contentHeadSha, HEAD_SHA);
      assert.equal(installed.installedVersion, "1.3.0");
    }
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("per-file downloads run capped and a failure surfaces the first-by-index error", async () => {
  const projectRoot = createTempDir("sync-perf-files-");
  const { service, restore } = loadMarketplaceService();
  try {
    const skillIds = ["skill-01", "skill-02"];
    const markdown = skillMarkdown("1.2.0");
    const records = skillIds.map((skillId) =>
      glRecord(projectRoot, skillId, { markdown, stamp: OLD_SHA }),
    );
    writeJson(path.join(projectRoot, "marketplaces.json"), glConfig(records, skillIds));
    const manyFiles = {};
    for (let i = 0; i < 12; i += 1) {
      manyFiles[`references/file-${String(i).padStart(2, "0")}.md`] = `content ${i}`;
    }
    const mock = createGitLabSyncMock({
      skillIds,
      remoteSkills: {
        "skill-01": { files: { "SKILL.md": skillMarkdown("1.3.0"), ...manyFiles } },
        "skill-02": { files: { "SKILL.md": skillMarkdown("1.3.0") } },
      },
      // skill-02's only file fails; skill-01 is unaffected.
      failFilePaths: new Set(["skills/skill-02/SKILL.md"]),
    });

    const result = await withMockFetch(mock.handler, () =>
      service.syncMarketplace({ projectRoot, marketplaceId: "perfmp", logger: QUIET }),
    );

    // The per-file cap is PER SKILL (4); with skill-02's single file possibly
    // in flight alongside, the global ceiling here is 5. The strict
    // single-skill cap is pinned in the next test.
    assert.ok(mock.peaks.files <= 5, `file concurrency bounded (peak ${mock.peaks.files})`);
    assert.deepEqual(
      result.skillsUpdated.map((entry) => entry.skillId),
      ["skill-01"],
    );
    for (let i = 0; i < 12; i += 1) {
      assert.ok(
        fs.existsSync(
          path.join(
            projectRoot,
            "skills-marketplace/perfmp/perf-skills/skill-01/references",
            `file-${String(i).padStart(2, "0")}.md`,
          ),
        ),
        `file ${i} written`,
      );
    }
    assert.equal(result.skillSyncErrors.length, 1);
    assert.equal(result.skillSyncErrors[0].skillId, "skill-02");
    assert.match(
      result.skillSyncErrors[0].error,
      /skills\/skill-02\/SKILL\.md/,
      "error names the failing file",
    );
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("first-by-index file failure is deterministic within one skill", async () => {
  const projectRoot = createTempDir("sync-perf-file-order-");
  const { service, restore } = loadMarketplaceService();
  try {
    const skillIds = ["skill-01"];
    const markdown = skillMarkdown("1.2.0");
    const records = [glRecord(projectRoot, "skill-01", { markdown, stamp: OLD_SHA })];
    writeJson(path.join(projectRoot, "marketplaces.json"), glConfig(records, skillIds));
    const files = { "SKILL.md": skillMarkdown("1.3.0") };
    for (let i = 0; i < 8; i += 1) {
      files[`references/file-${String(i).padStart(2, "0")}.md`] = `content ${i}`;
    }
    const mock = createGitLabSyncMock({
      skillIds,
      remoteSkills: { "skill-01": { files } },
      failFilePaths: new Set([
        "skills/skill-01/references/file-02.md",
        "skills/skill-01/references/file-06.md",
      ]),
    });

    const result = await withMockFetch(mock.handler, () =>
      service.syncMarketplace({ projectRoot, marketplaceId: "perfmp", logger: QUIET }),
    );

    assert.ok(
      mock.peaks.files <= 4,
      `single-skill file concurrency capped at 4 (peak ${mock.peaks.files})`,
    );
    assert.equal(result.skillSyncErrors.length, 1);
    assert.match(
      result.skillSyncErrors[0].error,
      /file-02\.md/,
      "the earliest failing entry wins, matching the old serial loop",
    );
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("head probes fail fast at 8s while other legs keep the 30s budget", async () => {
  const projectRoot = createTempDir("sync-perf-timeouts-");
  const { service, restore } = loadMarketplaceService();
  const timeoutCalls = [];
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  AbortSignal.timeout = (ms) => {
    timeoutCalls.push(ms);
    return originalTimeout(ms);
  };
  try {
    const skillIds = ["skill-01"];
    const markdown = skillMarkdown("1.2.0");
    const records = [glRecord(projectRoot, "skill-01", { markdown, stamp: HEAD_SHA })];
    writeJson(path.join(projectRoot, "marketplaces.json"), glConfig(records, skillIds));
    const mock = createGitLabSyncMock({ skillIds, remoteSkills: {} });

    await withMockFetch(mock.handler, () =>
      service.syncMarketplace({ projectRoot, marketplaceId: "perfmp", logger: QUIET }),
    );

    assert.equal(
      timeoutCalls.filter((ms) => ms === 8000).length,
      1,
      "exactly the head probe fast-fails",
    );
    assert.ok(
      timeoutCalls.filter((ms) => ms === 30000).length >= 1,
      "manifest leg keeps the default budget",
    );
  } finally {
    AbortSignal.timeout = originalTimeout;
    restore();
    cleanupDir(projectRoot);
  }
});

test("gitlab auth session resolves per repo group, not per request", async () => {
  const projectRoot = createTempDir("sync-perf-auth-");
  let sessionReads = 0;
  const { service, restore } = loadMarketplaceService({
    gitlabMarketplaceAuthExports: {
      getAuthorizedSession: async () => {
        sessionReads += 1;
        return { accessToken: "gitlab-token" };
      },
    },
  });
  try {
    const skillIds = ["skill-01", "skill-02", "skill-03"];
    const markdown = skillMarkdown("1.2.0");
    const remoteMarkdown = skillMarkdown("1.3.0", "Remote moved");
    const records = skillIds.map((skillId) =>
      glRecord(projectRoot, skillId, { markdown, stamp: OLD_SHA }),
    );
    writeJson(path.join(projectRoot, "marketplaces.json"), glConfig(records, skillIds));
    const remoteSkills = Object.fromEntries(
      skillIds.map((skillId) => [
        skillId,
        {
          files: {
            "SKILL.md": remoteMarkdown,
            "references/a.md": "a",
            "references/b.md": "b",
          },
        },
      ]),
    );
    const mock = createGitLabSyncMock({ skillIds, remoteSkills });

    await withMockFetch(mock.handler, () =>
      service.syncMarketplace({ projectRoot, marketplaceId: "perfmp", logger: QUIET }),
    );

    assert.ok(mock.calls.files.length >= 9, "many file requests went out");
    assert.ok(
      sessionReads <= 4,
      `session resolved O(groups), not O(requests) (saw ${sessionReads})`,
    );
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

// ---- github archive-once --------------------------------------------------------

function createTarballBuffer(rootName, files) {
  const tempDir = createTempDir("sync-perf-archive-");
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
  cleanupDir(tempDir);
  return buffer;
}

test("github sync downloads one tarball per repo, and zero when nothing changed", async () => {
  const projectRoot = createTempDir("sync-perf-github-");
  const { service, restore } = loadMarketplaceService();
  try {
    const skillIds = ["gh-01", "gh-02", "gh-03"];
    const markdown = skillMarkdown("1.2.0");
    const remoteMarkdown = skillMarkdown("1.3.0", "Remote moved");
    const manifest = {
      name: "ghperf",
      owner: { name: "Perf" },
      metadata: { description: "gh perf", version: "1.0.0" },
      plugins: [
        {
          name: "gh-skills",
          description: "gh skills",
          skills: skillIds.map((skillId) => `./skills/${skillId}`),
        },
      ],
    };
    const installedSkills = skillIds.map((skillId) => {
      const localPath = `skills-marketplace/ghperf/gh-skills/${skillId}`;
      const dir = path.join(projectRoot, localPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), markdown);
      return {
        marketplaceId: "ghperf",
        skillId,
        pluginName: "gh-skills",
        skillPath: `./skills/${skillId}`,
        installedVersion: "1.0.0",
        lastCheckedVersion: "1.0.0",
        localPath,
        contentHeadSha: OLD_SHA,
        baseline: {
          version: "1.0.0",
          sourceRef: "main",
          files: [{ path: "SKILL.md", sha256: sha256(markdown) }],
        },
      };
    });
    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [
        {
          id: "ghperf",
          name: "ghperf",
          source: {
            type: "github",
            repo: "perf/gh-skills-marketplace",
            repoUrl: "https://github.com/perf/gh-skills-marketplace",
            ref: "main",
          },
          cachedManifest: manifest,
          marketplaceVersion: "1.0.0",
        },
      ],
      installedSkills,
    });
    const archiveBuffer = createTarballBuffer(
      "gh-skills-marketplace-main",
      Object.fromEntries(
        skillIds.map((skillId) => [`skills/${skillId}/SKILL.md`, remoteMarkdown]),
      ),
    );

    let tarballFetches = 0;
    const handler = async (url) => {
      if (url.includes("api.github.com/repos/perf/gh-skills-marketplace/contents/.atlas-plugin")) {
        return createJsonResponse(createBase64JsonFilePayload(manifest));
      }
      if (url.includes("api.github.com/repos/perf/gh-skills-marketplace/commits/")) {
        return createJsonResponse({
          sha: HEAD_SHA,
          commit: { committer: { date: "2026-08-13T00:00:00Z" } },
        });
      }
      if (url.includes("codeload.github.com/perf/gh-skills-marketplace/tar.gz/")) {
        tarballFetches += 1;
        return createBinaryResponse(archiveBuffer);
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    };

    // Head moved: all three skills refresh from ONE shared tarball.
    const first = await withMockFetch(handler, () =>
      service.syncMarketplace({ projectRoot, marketplaceId: "ghperf", logger: QUIET }),
    );
    assert.equal(first.skillsUpdated.length, 3);
    assert.equal(tarballFetches, 1, "one tarball for the whole loop");

    // Steady state: stamps now match the head — zero tarballs.
    tarballFetches = 0;
    const second = await withMockFetch(handler, () =>
      service.syncMarketplace({ projectRoot, marketplaceId: "ghperf", logger: QUIET }),
    );
    assert.equal(second.skillsUpToDate.length, 3);
    assert.equal(tarballFetches, 0, "nothing re-downloaded when nothing changed");
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

// ---------------------------------------------------------------------------
// Normalized-manifest cache: unchanged manifest BYTES reuse the previous
// inspection verdicts (the 9.3s manifestMs leg); any byte change or a failed
// inspection re-normalizes. Hits are deep clones — callers can never mutate
// the cached verdicts.
// ---------------------------------------------------------------------------

test("normalizeManifestCached: same bytes normalize once, changed bytes re-normalize", async () => {
  const { service, restore } = loadMarketplaceService();
  let normalizeRuns = 0;
  const normalize = async () => {
    normalizeRuns += 1;
    return { manifest: { name: "mp", plugins: [{ id: "p1" }] } };
  };

  const first = await service.normalizeManifestCached("gitlab:g/mp:main:true", "BYTES-A", normalize);
  const second = await service.normalizeManifestCached("gitlab:g/mp:main:true", "BYTES-A", normalize);
  assert.equal(normalizeRuns, 1, "unchanged bytes reuse the inspection");
  assert.deepEqual(second, first);
  // Deep-clone isolation: a caller mutating its copy must not poison the cache.
  second.manifest.plugins.push({ id: "injected" });
  const third = await service.normalizeManifestCached("gitlab:g/mp:main:true", "BYTES-A", normalize);
  assert.equal(third.manifest.plugins.length, 1);

  await service.normalizeManifestCached("gitlab:g/mp:main:true", "BYTES-B", normalize);
  assert.equal(normalizeRuns, 2, "changed bytes re-inspect");
  // Distinct marketplaces never share entries even with identical bytes.
  await service.normalizeManifestCached("gitlab:other/mp:main:true", "BYTES-B", normalize);
  assert.equal(normalizeRuns, 3);
  restore();
});

test("normalizeManifestCached: a failed inspection is not cached", async () => {
  const { service, restore } = loadMarketplaceService();
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) throw new Error("inspection blew up");
    return { manifest: { name: "mp" } };
  };
  await assert.rejects(
    () => service.normalizeManifestCached("gitlab:g/f:main:true", "BYTES", flaky),
    /inspection blew up/,
  );
  const recovered = await service.normalizeManifestCached("gitlab:g/f:main:true", "BYTES", flaky);
  assert.equal(recovered.manifest.name, "mp");
  assert.equal(calls, 2, "the failure was retried, then the success cached");
  await service.normalizeManifestCached("gitlab:g/f:main:true", "BYTES", flaky);
  assert.equal(calls, 2);
  restore();
});
