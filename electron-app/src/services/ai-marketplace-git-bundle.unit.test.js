// Behavioral tests for the git-referenced bundle materializer: it turns a
// solution envelope's bundle_source_* fields into the exact {type, payload}
// shape hosted-content bundles use — allowlist-gated, ref-overriding, and
// symlink/size safe. The downloader is injected so no network runs.
const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const path = require("node:path");

const os = require("node:os");

const {
  extractBundleGitSource,
  materializeGitMarketplaceSkillBundle,
  materializeSkillBundleFromGitSource,
  shouldAttemptGitBundleFallback,
} = require("./ai-marketplace-git-bundle");

const SKILL_MD =
  '---\nname: indexed-jobs\ndescription: fixture ops skill\nversion: "1.0"\n---\n\n# indexed-jobs\n';

function envelope(overrides = {}) {
  return {
    id: "skill::indexed-jobs",
    name: "Indexed Jobs Ops Skill",
    bundle_source_git_url: "https://example.invalid/ai4i/ops-skills.git",
    bundle_source_ref: "release-branch",
    bundle_source_subpath: "skills/indexed-jobs",
    ...overrides,
  };
}

// Injected stand-in for marketplaceService.downloadSkillDirectory: records
// the resolved source/skillPath and stages the given files.
function fakeDownload(files) {
  const calls = [];
  return {
    calls,
    async download(source, skillPath, destinationPath) {
      calls.push({ source, skillPath });
      for (const [rel, content] of Object.entries(files)) {
        const target = path.join(destinationPath, ...rel.split("/"));
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, content);
      }
      return source;
    },
  };
}

test("shouldAttemptGitBundleFallback: backend 500s and no_bundle qualify; envelope 404s do not", () => {
  assert.equal(
    shouldAttemptGitBundleFallback({ status: 500, message: "Failed to get bundle" }),
    true,
  );
  assert.equal(shouldAttemptGitBundleFallback({ code: "no_bundle", status: 404 }), true);
  assert.equal(shouldAttemptGitBundleFallback({ status: 404, code: "not_found" }), false);
  assert.equal(shouldAttemptGitBundleFallback(null), false);
});

test("extractBundleGitSource reads and trims the envelope fields", () => {
  assert.deepEqual(extractBundleGitSource(envelope()), {
    gitUrl: "https://example.invalid/ai4i/ops-skills.git",
    ref: "release-branch",
    subpath: "skills/indexed-jobs",
  });
  assert.equal(extractBundleGitSource({ name: "no git fields" }), null);
  assert.equal(extractBundleGitSource(null), null);
});

test("materializes the hosted-bundle payload shape from a corp GitLab source with the envelope's ref", async () => {
  const { calls, download } = fakeDownload({
    "SKILL.md": SKILL_MD,
    "references/guide.md": "guide body",
    "scripts/run.sh": "#!/bin/sh\necho hi\n",
  });
  const bundle = await materializeSkillBundleFromGitSource(envelope(), {
    interactiveAuth: false,
    deps: { downloadSkillDirectory: download },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].source.type, "gitlab");
  assert.equal(calls[0].source.host, "example.invalid");
  assert.equal(
    calls[0].source.ref,
    "release-branch",
    "the envelope's ref overrides the URL default",
  );
  assert.equal(calls[0].skillPath, "skills/indexed-jobs");

  assert.equal(bundle.type, "skills");
  assert.equal(bundle.id, "skill::indexed-jobs");
  assert.equal(bundle.payload.name, "indexed-jobs", "name comes from SKILL.md frontmatter");
  assert.equal(bundle.payload.skill_md, SKILL_MD);
  assert.deepEqual(
    bundle.payload.references.map((f) => f.path),
    ["references/guide.md", "scripts/run.sh"],
  );
  const guide = bundle.payload.references.find((f) => f.path === "references/guide.md");
  assert.equal(Buffer.from(guide.content_b64, "base64").toString("utf8"), "guide body");
  assert.deepEqual(bundle.payload.scripts, []);
});

test("a bundle repository outside the approved marketplace sources fails closed before any fetch", async () => {
  const { calls, download } = fakeDownload({ "SKILL.md": SKILL_MD });
  await assert.rejects(
    materializeSkillBundleFromGitSource(
      envelope({ bundle_source_git_url: "https://github.com/evil-org/exfil.git" }),
      { deps: { downloadSkillDirectory: download } },
    ),
    (error) => error.code === "bundle_source_not_allowed",
  );
  assert.equal(calls.length, 0, "nothing was fetched");
});

test("an allowlisted GitHub bundle repository passes the gate", async () => {
  const { calls, download } = fakeDownload({ "SKILL.md": SKILL_MD });
  const bundle = await materializeSkillBundleFromGitSource(
    envelope({
      bundle_source_git_url: "https://github.com/anthropics/skills.git",
      bundle_source_subpath: "skills/algorithmic-art",
    }),
    { deps: { downloadSkillDirectory: download } },
  );
  assert.equal(calls[0].source.type, "github");
  assert.equal(calls[0].source.repo, "anthropics/skills");
  assert.equal(bundle.payload.skill_md, SKILL_MD);
});

test("a bundle source with no SKILL.md at the subpath fails with a dedicated code", async () => {
  const { download } = fakeDownload({ "notes.md": "no skill here" });
  await assert.rejects(
    materializeSkillBundleFromGitSource(envelope(), {
      deps: { downloadSkillDirectory: download },
    }),
    (error) => error.code === "git_bundle_missing_skill_md",
  );
});

test("oversized bundle files fail loudly instead of ballooning memory", async () => {
  const { download } = fakeDownload({
    "SKILL.md": SKILL_MD,
    "big.bin": Buffer.alloc(1024 * 1024 + 1),
  });
  await assert.rejects(
    materializeSkillBundleFromGitSource(envelope(), {
      deps: { downloadSkillDirectory: download },
    }),
    (error) => error.code === "git_bundle_file_too_large",
  );
});

test("symlinks staged by the download are skipped, never followed", async () => {
  const download = async (source, skillPath, destinationPath) => {
    await fsp.writeFile(path.join(destinationPath, "SKILL.md"), SKILL_MD);
    await fsp.writeFile(path.join(destinationPath, "real.md"), "real");
    await fsp.symlink("/etc/hosts", path.join(destinationPath, "link.md"));
    return source;
  };
  const bundle = await materializeSkillBundleFromGitSource(envelope(), {
    deps: { downloadSkillDirectory: download },
  });
  assert.deepEqual(
    bundle.payload.references.map((f) => f.path),
    ["real.md"],
    "only the real file travels",
  );
});

// ---------------------------------------------------------------------------
// materializeGitMarketplaceSkillBundle — the read-only details-page bundle:
// installed copies read from disk (zero network), uninstalled ones stage a
// download; the install-path allowlist backstop applies to previews too.
// ---------------------------------------------------------------------------

const GIT_MARKETPLACE = Object.freeze({
  id: "kwp",
  name: "Knowledge Work Plugins",
  source: { type: "github", repo: "anthropics/knowledge-work-plugins" },
});

function catalogRecord(overrides = {}) {
  return {
    id: "digest",
    name: "digest",
    displayName: "Digest",
    description: "Digest things",
    skillPath: "./enterprise-search/skills/digest",
    pluginName: "enterprise-search",
    installed: false,
    available: true,
    skillSource: null,
    ...overrides,
  };
}

function previewDeps({ skills, download, allow = () => true, sameRepo = () => true }) {
  return {
    getMarketplaceSkillsCached: async () => ({
      marketplace: GIT_MARKETPLACE,
      skills,
    }),
    resolveRemoteSkillSource: (skillSource, marketplaceSource) =>
      skillSource && typeof skillSource === "object"
        ? skillSource
        : marketplaceSource,
    isSameRepositorySource: sameRepo,
    isAllowedMarketplaceSource: allow,
    downloadSkillDirectory:
      download ||
      (async () => {
        throw new Error("download must not run for this case");
      }),
  };
}

test("installed marketplace skills preview straight from disk — payload built, zero downloads", async () => {
  const projectRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "git-mp-preview-"));
  try {
    const localPath = "skills-marketplace/kwp/enterprise-search/digest";
    const dir = path.join(projectRoot, localPath);
    await fsp.mkdir(path.join(dir, "references"), { recursive: true });
    await fsp.writeFile(path.join(dir, "SKILL.md"), SKILL_MD);
    await fsp.writeFile(path.join(dir, "references/guide.md"), "guide body");
    await fsp.writeFile(path.join(dir, "zz.txt"), "tail file");

    const result = await materializeGitMarketplaceSkillBundle({
      projectRoot,
      marketplaceId: "kwp",
      skillId: "digest",
      pluginName: "enterprise-search",
      deps: previewDeps({
        skills: [catalogRecord({ installed: true, localPath })],
      }),
    });

    assert.equal(result.installed, true);
    assert.equal(result.bundle.type, "skills");
    assert.equal(result.bundle.id, "digest");
    assert.equal(result.bundle.payload.skill_md, SKILL_MD);
    assert.deepEqual(
      result.bundle.payload.references.map((f) => f.path),
      ["references/guide.md", "zz.txt"],
      "sorted, SKILL.md excluded",
    );
    assert.equal(
      Buffer.from(result.bundle.payload.references[0].content_b64, "base64").toString(),
      "guide body",
    );
  } finally {
    await fsp.rm(projectRoot, { recursive: true, force: true });
  }
});

test("uninstalled skills stage a download and clean the staging directory afterwards", async () => {
  const downloadCalls = [];
  let stagedPath = null;
  const download = async (source, skillPath, destinationPath) => {
    downloadCalls.push({ source, skillPath });
    stagedPath = destinationPath;
    await fsp.writeFile(path.join(destinationPath, "SKILL.md"), SKILL_MD);
    await fsp.writeFile(path.join(destinationPath, "ref.md"), "ref body");
    return source;
  };

  const result = await materializeGitMarketplaceSkillBundle({
    projectRoot: "/nonexistent-not-used",
    marketplaceId: "kwp",
    skillId: "digest",
    pluginName: "enterprise-search",
    deps: previewDeps({ skills: [catalogRecord()], download }),
  });

  assert.equal(result.installed, false);
  assert.deepEqual(downloadCalls, [
    {
      source: GIT_MARKETPLACE.source,
      skillPath: "./enterprise-search/skills/digest",
    },
  ]);
  assert.deepEqual(
    result.bundle.payload.references.map((f) => f.path),
    ["ref.md"],
  );
  await assert.rejects(
    fsp.access(stagedPath),
    "staging directory removed after materialization",
  );
});

test("an object skillSource pointing at a foreign repo must pass the allowlist — previews share the install policy", async () => {
  await assert.rejects(
    materializeGitMarketplaceSkillBundle({
      projectRoot: "/unused",
      marketplaceId: "kwp",
      skillId: "digest",
      pluginName: "enterprise-search",
      deps: previewDeps({
        skills: [
          catalogRecord({
            skillSource: { source: "github", repo: "third-party/rogue" },
          }),
        ],
        sameRepo: () => false,
        allow: () => false,
      }),
    }),
    (error) => error.code === "marketplace_source_not_allowed",
  );
});

test("unknown skill / wrong plugin identity / external record all fail closed with coded errors", async () => {
  const deps = previewDeps({
    skills: [catalogRecord(), catalogRecord({ id: "ext", available: false, pluginName: null })],
  });
  await assert.rejects(
    materializeGitMarketplaceSkillBundle({
      projectRoot: "/unused",
      marketplaceId: "kwp",
      skillId: "missing",
      deps,
    }),
    (error) => error.code === "skill_not_found",
  );
  // Same leaf id but no pluginName — identity is the (id, pluginName) pair.
  await assert.rejects(
    materializeGitMarketplaceSkillBundle({
      projectRoot: "/unused",
      marketplaceId: "kwp",
      skillId: "digest",
      pluginName: null,
      deps,
    }),
    (error) => error.code === "skill_not_found",
  );
  await assert.rejects(
    materializeGitMarketplaceSkillBundle({
      projectRoot: "/unused",
      marketplaceId: "kwp",
      skillId: "ext",
      pluginName: null,
      deps,
    }),
    (error) => error.code === "marketplace_source_not_allowed",
  );
});

test("an installed copy whose directory lost SKILL.md fails with the coded missing-skill-md error", async () => {
  const projectRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "git-mp-preview-"));
  try {
    const localPath = "skills-marketplace/kwp/enterprise-search/digest";
    await fsp.mkdir(path.join(projectRoot, localPath), { recursive: true });
    await assert.rejects(
      materializeGitMarketplaceSkillBundle({
        projectRoot,
        marketplaceId: "kwp",
        skillId: "digest",
        pluginName: "enterprise-search",
        deps: previewDeps({
          skills: [catalogRecord({ installed: true, localPath })],
        }),
      }),
      (error) => error.code === "git_bundle_missing_skill_md",
    );
  } finally {
    await fsp.rm(projectRoot, { recursive: true, force: true });
  }
});
