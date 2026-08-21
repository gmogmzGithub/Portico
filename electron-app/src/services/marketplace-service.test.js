const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsPromises = fs.promises;
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
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

function createTextResponse(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain",
      ...headers,
    },
  });
}

function createBinaryResponse(buffer, status = 200, headers = {}) {
  return new Response(buffer, {
    status,
    headers: {
      "Content-Type": "application/octet-stream",
      ...headers,
    },
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

function createTarballBuffer(rootName, files) {
  const tempDir = createTempDir("marketplace-archive-test-");
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

function createBundledDefaultsStub() {
  return async function ensureBundledMarketplaceDefaults(projectRoot) {
    const configPath = path.join(projectRoot, "marketplaces.json");
    if (fs.existsSync(configPath)) {
      return {
        config: JSON.parse(fs.readFileSync(configPath, "utf8")),
      };
    }

    return {
      config: {
        version: "1.0",
        marketplaces: [],
        installedSkills: [],
      },
    };
  };
}

function loadMarketplaceService({
  ensureBundledMarketplaceDefaults = createBundledDefaultsStub(),
  readInstalledSkillVersion = marketplaceOotb.readInstalledSkillVersion,
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
      ensureBundledMarketplaceDefaults,
      readInstalledSkillVersion,
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
      } else {
        delete require.cache[marketplaceServicePath];
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

const GITHUB_TOKEN_ENV_VARS = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_ACCESS_TOKEN",
];

async function withGitHubTokenEnv(values, callback) {
  const previous = {};
  for (const name of GITHUB_TOKEN_ENV_VARS) {
    previous[name] = process.env[name];
    const next = values[name];
    if (next === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = next;
    }
  }
  try {
    return await callback();
  } finally {
    for (const name of GITHUB_TOKEN_ENV_VARS) {
      if (previous[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous[name];
      }
    }
  }
}

async function withGitHubToken(token, callback) {
  return withGitHubTokenEnv({ GITHUB_TOKEN: token }, callback);
}

async function withNoGitHubToken(callback) {
  return withGitHubTokenEnv({}, callback);
}

function createSkillMarkdown(version, title = "Skill Title") {
  return [
    "---",
    "metadata:",
    `  version: ${version}`,
    "---",
    "",
    `# ${title}`,
    "",
    "Skill body",
    "",
  ].join("\n");
}

function createSyncTestMarketplaceManifest(skillPaths = ["./skills/smart-slides-iql-metrics"]) {
  return {
    name: "zstevens-portico-skills",
    owner: { name: "Zach Stevens" },
    metadata: {
      description: "Zach's skills",
      version: "1.3.0",
    },
    plugins: [
      {
        name: "zstevens-skills",
        description: "Zach's skills",
        skills: skillPaths,
      },
    ],
  };
}

function createSyncTestConfig(installedSkills, manifest = createSyncTestMarketplaceManifest()) {
  return {
    version: "1.0",
    marketplaces: [
      {
        id: "zstevens-portico-skills",
        name: "zstevens-portico-skills",
        source: {
          type: "github",
          repo: "zstevens/portico-skills-marketplace",
          repoUrl: "https://github.com/zstevens/portico-skills-marketplace",
          ref: "main",
        },
        cachedManifest: manifest,
        marketplaceVersion: "1.3.0",
      },
    ],
    installedSkills,
  };
}

async function withMockSyncTestMarketplace(archiveBuffer, manifest, callback) {
  return await withMockFetch(async (url) => {
    if (
      url ===
      "https://api.github.com/repos/zstevens/portico-skills-marketplace/contents/.claude-plugin/marketplace.json?ref=main"
    ) {
      return createJsonResponse(createBase64JsonFilePayload(manifest));
    }
    if (
      url ===
      "https://codeload.github.com/zstevens/portico-skills-marketplace/tar.gz/main"
    ) {
      return createBinaryResponse(archiveBuffer);
    }
    return createJsonResponse({ message: "Not Found" }, 404);
  }, callback);
}

async function withMockZachGitLabMarketplace(skillId, markdown, manifest, callback) {
  return await withMockFetch(async (url) => {
    if (
      url ===
      "https://example.invalid/api/v4/projects/zstevens%2Fportico-skills-marketplace/repository/files/.claude-plugin%2Fmarketplace.json?ref=main"
    ) {
      return createJsonResponse(createBase64JsonFilePayload(manifest));
    }
    if (
      url ===
      `https://example.invalid/api/v4/projects/zstevens%2Fportico-skills-marketplace/repository/tree?ref=main&page=1&per_page=100&recursive=true&path=skills%2F${skillId}`
    ) {
      return createJsonResponse([
        {
          id: "skill-markdown",
          name: "SKILL.md",
          path: `skills/${skillId}/SKILL.md`,
          type: "blob",
          mode: "100644",
        },
      ]);
    }
    if (
      url ===
      `https://example.invalid/api/v4/projects/zstevens%2Fportico-skills-marketplace/repository/files/skills%2F${skillId}%2FSKILL.md?ref=main`
    ) {
      return createJsonResponse(createBase64TextFilePayload(markdown));
    }
    return createJsonResponse({ message: "Not Found" }, 404);
  }, callback);
}

test("normalizeMarketplaceSourceInput supports GitHub shorthand repos", () => {
  const { service, restore } = loadMarketplaceService();
  try {
    assert.deepEqual(service.normalizeMarketplaceSourceInput("anthropics/skills"), {
      type: "github",
      repo: "anthropics/skills",
      repoUrl: "https://github.com/anthropics/skills",
    });
  } finally {
    restore();
  }
});

test("normalizeMarketplaceSourceInput supports supported GitLab repo, tree, and blob URLs", () => {
  const { service, restore } = loadMarketplaceService();
  try {
    assert.deepEqual(
      service.normalizeMarketplaceSourceInput(
        "https://example.invalid/anthropics/skills.git",
      ),
      {
        type: "gitlab",
        host: "example.invalid",
        projectPath: "anthropics/skills",
        repoUrl: "https://example.invalid/anthropics/skills.git",
      },
    );

    assert.deepEqual(
      service.normalizeMarketplaceSourceInput(
        "https://example.invalid/anthropics/skills/-/tree/main",
      ),
      {
        type: "gitlab",
        host: "example.invalid",
        projectPath: "anthropics/skills",
        repoUrl: "https://example.invalid/anthropics/skills.git",
        ref: "main",
      },
    );

    assert.deepEqual(
      service.normalizeMarketplaceSourceInput(
        "https://example.invalid/anthropics/skills/-/blob/main/.claude-plugin/plugin.json?ref_type=heads",
        { allowSparseFileUrl: true },
      ),
      {
        type: "gitlab",
        host: "example.invalid",
        projectPath: "anthropics/skills",
        repoUrl: "https://example.invalid/anthropics/skills.git",
        ref: "main",
      },
    );

    assert.deepEqual(
      service.normalizeMarketplaceSourceInput(
        "git@example.invalid:anthropics/skills.git",
      ),
      {
        type: "gitlab",
        host: "example.invalid",
        projectPath: "anthropics/skills",
        repoUrl: "https://example.invalid/anthropics/skills.git",
      },
    );

    assert.deepEqual(
      service.normalizeMarketplaceSourceInput(
        "ssh://git@example.invalid/anthropics/skills.git",
      ),
      {
        type: "gitlab",
        host: "example.invalid",
        projectPath: "anthropics/skills",
        repoUrl: "https://example.invalid/anthropics/skills.git",
      },
    );
  } finally {
    restore();
  }
});

test("normalizeMarketplaceSourceInput rejects unsupported direct plugin.json URLs and unsupported GitLab hosts", () => {
  const { service, restore } = loadMarketplaceService();
  try {
    assert.throws(
      () =>
        service.normalizeMarketplaceSourceInput(
          "https://example.com/repo/.claude-plugin/plugin.json",
        ),
      /direct URLs must point to a .*marketplace\.json/i,
    );

    assert.throws(
      () =>
        service.normalizeMarketplaceSourceInput(
          "https://gitlab.example.com/group/repo",
        ),
      /direct URLs must point to a .*marketplace\.json|invalid marketplace source/i,
    );
  } finally {
    restore();
  }
});

test("normalizeMarketplaceSourceInput keeps direct marketplace.json URLs as URL sources", () => {
  const { service, restore } = loadMarketplaceService();
  try {
    assert.deepEqual(
      service.normalizeMarketplaceSourceInput(
        "https://example.com/skills/.claude-plugin/marketplace.json",
      ),
      {
        type: "url",
        url: "https://example.com/skills/.claude-plugin/marketplace.json",
      },
    );
  } finally {
    restore();
  }
});

test("synthesizeSparseManifest builds a canonical singleton marketplace manifest", () => {
  const { service, restore } = loadMarketplaceService();
  try {
    const manifest = service.synthesizeSparseManifest(
      {
        name: "trustkit",
        version: "0.1.0",
        description: "AI-powered skills for Trust & Safety work",
        author: {
          name: "Jesse Chen",
          email: "jessec@example.invalid",
        },
      },
      ["./.claude/skills/trustkit"],
    );

    assert.equal(manifest.name, "trustkit");
    assert.deepEqual(manifest.owner, {
      name: "Jesse Chen",
      email: "jessec@example.invalid",
    });
    assert.deepEqual(manifest.metadata, {
      description: "AI-powered skills for Trust & Safety work",
      version: "0.1.0",
    });
    assert.equal(manifest.plugins.length, 1);
    assert.deepEqual(manifest.plugins[0].skills, ["./.claude/skills/trustkit"]);
  } finally {
    restore();
  }
});

test("synthesizeSparseManifest rejects duplicate leaf skill ids", () => {
  const { service, restore } = loadMarketplaceService();
  try {
    assert.throws(
      () =>
        service.synthesizeSparseManifest(
          {
            name: "duplicate-skills",
          },
          ["./skills/pdf", "./.claude/skills/pdf"],
        ),
      /duplicate skill id "pdf"/i,
    );
  } finally {
    restore();
  }
});

test("normalizeMarketplacesConfig backfills sparse flags for legacy entries", () => {
  const { service, restore } = loadMarketplaceService();
  try {
    const config = service.normalizeMarketplacesConfig({
      version: "1.0",
      marketplaces: [
        {
          id: "anthropic-agent-skills",
          name: "anthropic-agent-skills",
          source: { type: "github", repo: "anthropics/skills" },
        },
      ],
      installedSkills: [
        {
          marketplaceId: "anthropic-agent-skills",
          skillId: "pdf",
          skillSource: { type: "github", repo: "anthropics/skills" },
        },
      ],
    });

    assert.equal(config.marketplaces[0].isSparse, false);
    assert.equal(config.marketplaces[0].manifestSource, "marketplace-json");
    assert.equal(
      config.marketplaces[0].source.repoUrl,
      "https://github.com/anthropics/skills",
    );
    assert.equal(
      config.installedSkills[0].skillSource.repoUrl,
      "https://github.com/anthropics/skills",
    );
  } finally {
    restore();
  }
});

test("loadMarketplaceDefinition reads a regular GitHub marketplace manifest", async () => {
  const { service, restore } = loadMarketplaceService();

  const manifest = {
    name: "anthropic-agent-skills",
    owner: {
      name: "Keith Lazuka",
      email: "klazuka@anthropic.com",
    },
    metadata: {
      description: "Anthropic example skills",
      version: "1.0.0",
    },
    plugins: [
      {
        name: "example-skills",
        description: "Examples",
        skills: ["./skills/pdf"],
      },
    ],
  };

  const observedUrls = [];

  try {
    await withMockFetch(async (url) => {
      observedUrls.push(url);
      if (
        url ===
        "https://raw.githubusercontent.com/anthropics/skills/main/.claude-plugin/marketplace.json"
      ) {
        return createTextResponse(JSON.stringify(manifest));
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, async () => {
      const result = await service.loadMarketplaceDefinition("anthropics/skills");

      assert.equal(result.isSparse, false);
      assert.equal(result.manifestSource, "marketplace-json");
      assert.equal(result.source.type, "github");
      assert.equal(result.source.repo, "anthropics/skills");
      assert.equal(result.source.ref, "main");
      assert.deepEqual(result.manifest, manifest);
      assert.deepEqual(observedUrls, [
        "https://raw.githubusercontent.com/anthropics/skills/main/.claude-plugin/marketplace.json",
      ]);
    });
  } finally {
    restore();
  }
});

test("loadMarketplaceDefinition falls back to the GitHub API after raw main and master miss", async () => {
  const { service, restore } = loadMarketplaceService();

  const manifest = {
    name: "custom-branch",
    metadata: { description: "Custom branch", version: "1.0.0" },
    plugins: [],
  };
  const observedUrls = [];

  try {
    await withMockFetch(async (url) => {
      observedUrls.push(url);
      if (url === "https://api.github.com/repos/acme/custom-branch") {
        return createJsonResponse({ default_branch: "stable" });
      }
      if (
        url ===
        "https://api.github.com/repos/acme/custom-branch/contents/.claude-plugin/marketplace.json?ref=stable"
      ) {
        return createJsonResponse(createBase64JsonFilePayload(manifest));
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, async () => {
      const result = await service.loadMarketplaceDefinition("acme/custom-branch");

      assert.equal(result.manifestSource, "marketplace-json");
      assert.equal(result.source.ref, "stable");
      assert.ok(
        observedUrls.includes(
          "https://raw.githubusercontent.com/acme/custom-branch/main/.claude-plugin/marketplace.json",
        ),
      );
      assert.ok(
        observedUrls.includes(
          "https://raw.githubusercontent.com/acme/custom-branch/master/.claude-plugin/marketplace.json",
        ),
      );
      assert.ok(observedUrls.includes("https://api.github.com/repos/acme/custom-branch"));
    });
  } finally {
    restore();
  }
});

test("loadMarketplaceDefinition sends GitHub Authorization header when GITHUB_TOKEN is set", async () => {
  const { service, restore } = loadMarketplaceService();

  const manifest = {
    name: "token-test",
    metadata: { description: "Token test", version: "1.0.0" },
    plugins: [],
  };

  const observedAuthorizations = [];

  try {
    await withGitHubToken("test-github-token", async () => {
      await withMockFetch(async (url, options) => {
        observedAuthorizations.push(options?.headers?.Authorization);
        if (url === "https://api.github.com/repos/anthropics/skills") {
          return createJsonResponse({ default_branch: "main" });
        }
        if (
          url ===
          "https://api.github.com/repos/anthropics/skills/contents/.claude-plugin/marketplace.json?ref=main"
        ) {
          return createJsonResponse(createBase64JsonFilePayload(manifest));
        }
        return createJsonResponse({ message: "Not Found" }, 404);
      }, async () => {
        await service.loadMarketplaceDefinition("anthropics/skills");
        assert.ok(
          observedAuthorizations.length > 0,
          "expected at least one GitHub request",
        );
        for (const authorization of observedAuthorizations) {
          assert.equal(authorization, "Bearer test-github-token");
        }
      });
    });
  } finally {
    restore();
  }
});

test("extractGitHubRepository sends Authorization header to codeload.github.com when GITHUB_TOKEN is set", async () => {
  const { service, restore } = loadMarketplaceService();

  const archiveBuffer = createTarballBuffer("codeload-token-test-main", {
    "skills/demo/SKILL.md": createSkillMarkdown("1.0.0", "Demo"),
  });

  const observedRequests = [];

  try {
    await withGitHubToken("test-github-token", async () => {
      await withMockFetch(async (url, options) => {
        observedRequests.push({ url, authorization: options?.headers?.Authorization });
        if (url === "https://api.github.com/repos/acme/codeload-token-test") {
          return createJsonResponse({ default_branch: "main" });
        }
        if (
          url ===
          "https://api.github.com/repos/acme/codeload-token-test/contents/.claude-plugin/marketplace.json?ref=main"
        ) {
          return createJsonResponse({ message: "Not Found" }, 404);
        }
        if (
          url ===
          "https://api.github.com/repos/acme/codeload-token-test/contents/.claude-plugin/plugin.json?ref=main"
        ) {
          return createJsonResponse({ message: "Not Found" }, 404);
        }
        if (url === "https://codeload.github.com/acme/codeload-token-test/tar.gz/main") {
          return createBinaryResponse(archiveBuffer);
        }
        return createJsonResponse({ message: "Not Found" }, 404);
      }, async () => {
        await service.loadMarketplaceDefinition("acme/codeload-token-test");
        const codeloadRequests = observedRequests.filter((req) =>
          req.url.startsWith("https://codeload.github.com/"),
        );
        assert.ok(
          codeloadRequests.length > 0,
          "expected at least one codeload.github.com request",
        );
        for (const req of codeloadRequests) {
          assert.equal(req.authorization, "Bearer test-github-token");
        }
      });
    });
  } finally {
    restore();
  }
});

test("loadMarketplaceDefinition omits GitHub Authorization header when no token env is set", async () => {
  const { service, restore } = loadMarketplaceService();

  const manifest = {
    name: "no-token",
    metadata: { description: "No token", version: "1.0.0" },
    plugins: [],
  };

  const observedAuthorizations = [];

  try {
    await withNoGitHubToken(async () => {
      await withMockFetch(async (url, options) => {
        observedAuthorizations.push(options?.headers?.Authorization);
        if (url === "https://api.github.com/repos/anthropics/skills") {
          return createJsonResponse({ default_branch: "main" });
        }
        if (
          url ===
          "https://api.github.com/repos/anthropics/skills/contents/.claude-plugin/marketplace.json?ref=main"
        ) {
          return createJsonResponse(createBase64JsonFilePayload(manifest));
        }
        return createJsonResponse({ message: "Not Found" }, 404);
      }, async () => {
        await service.loadMarketplaceDefinition("anthropics/skills");
        assert.ok(
          observedAuthorizations.length > 0,
          "expected at least one GitHub request",
        );
        for (const authorization of observedAuthorizations) {
          assert.equal(authorization, undefined);
        }
      });
    });
  } finally {
    restore();
  }
});

test("loadMarketplaceDefinition uses the raw manifest ref for GoogleChrome-style bundle archives", async () => {
  const { service, restore } = loadMarketplaceService();

  const manifest = {
    name: "googlechrome",
    owner: {
      name: "Google Chrome",
    },
    plugins: [
      {
        name: "modern-web-guidance",
        source: "./",
        description: "Keep your coding agent up to date with the latest web best practices",
        version: "0.0.170",
      },
    ],
  };
  const archiveBuffer = createTarballBuffer("modern-web-guidance-main", {
    ".claude-plugin/marketplace.json": JSON.stringify(manifest, null, 2),
    "skills/modern-web-guidance/SKILL.md": createSkillMarkdown(
      "0.0.170",
      "Modern Web Guidance",
    ),
  });
  const observedUrls = [];

  try {
    await withMockFetch(async (url) => {
      observedUrls.push(url);
      if (
        url ===
        "https://raw.githubusercontent.com/GoogleChrome/modern-web-guidance/main/.claude-plugin/marketplace.json"
      ) {
        return createTextResponse(JSON.stringify(manifest));
      }
      if (
        url ===
        "https://codeload.github.com/GoogleChrome/modern-web-guidance/tar.gz/main"
      ) {
        return createBinaryResponse(archiveBuffer);
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, async () => {
      const result = await service.loadMarketplaceDefinition(
        "GoogleChrome/modern-web-guidance",
      );

      assert.equal(result.source.ref, "main");
      assert.deepEqual(result.manifest.plugins[0].skills, [
        "./skills/modern-web-guidance",
      ]);
      assert.ok(
        observedUrls.includes(
          "https://codeload.github.com/GoogleChrome/modern-web-guidance/tar.gz/main",
        ),
      );
      assert.equal(
        observedUrls.some((url) => url.startsWith("https://api.github.com/")),
        false,
      );
    });
  } finally {
    restore();
  }
});

test("loadMarketplaceDefinition expands bundle-style GitHub marketplace plugins into leaf skills", async () => {
  const { service, restore } = loadMarketplaceService();

  const manifest = {
    name: "ejp-skills",
    owner: {
      name: "Employer Jobs Platform",
    },
    metadata: {
      description: "Claude Code skills for reactive streams",
      version: "1.0.0",
    },
    plugins: [
      {
        name: "ejp-skills",
        description: "Portico Job Sync API and Atleon reactive streams",
        source: "./",
      },
    ],
  };
  const archiveBuffer = createTarballBuffer("ejp-skills-main", {
    ".claude-plugin/marketplace.json": JSON.stringify(manifest, null, 2),
    "skills/atleon/SKILL.md": createSkillMarkdown("1.2.3", "Atleon"),
    "skills/vavr/SKILL.md": createSkillMarkdown("4.5.6", "Vavr"),
  });

  try {
    await withMockFetch(async (url) => {
      if (url === "https://api.github.com/repos/nickw/ejp-skills") {
        return createJsonResponse({ default_branch: "main" });
      }
      if (
        url ===
        "https://api.github.com/repos/nickw/ejp-skills/contents/.claude-plugin/marketplace.json?ref=main"
      ) {
        return createJsonResponse(createBase64JsonFilePayload(manifest));
      }
      if (url === "https://codeload.github.com/nickw/ejp-skills/tar.gz/main") {
        return createBinaryResponse(archiveBuffer);
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, async () => {
      const result = await service.loadMarketplaceDefinition({
        type: "github",
        repo: "nickw/ejp-skills",
      });

      assert.equal(result.isSparse, false);
      assert.deepEqual(result.manifest.plugins[0].skills, [
        "./skills/atleon",
        "./skills/vavr",
      ]);
    });
  } finally {
    restore();
  }
});

test("a bundle-style plugin with duplicate leaf ids degrades to unavailable instead of failing the marketplace", async () => {
  const { service, restore } = loadMarketplaceService();

  const manifest = {
    name: "duplicate-skill-marketplace",
    metadata: {
      description: "Duplicate ids",
      version: "1.0.0",
    },
    plugins: [
      {
        name: "duplicate-bundle",
        description: "Bad bundle",
        source: "./",
      },
      {
        name: "healthy",
        description: "Fine bundle",
        source: "./healthy",
      },
    ],
  };
  const archiveBuffer = createTarballBuffer("duplicate-skill-marketplace-main", {
    ".claude-plugin/marketplace.json": JSON.stringify(manifest, null, 2),
    "skills/foo/SKILL.md": createSkillMarkdown("1.0.0", "Foo"),
    "references/foo/SKILL.md": createSkillMarkdown("1.0.0", "Other Foo"),
    "healthy/skills/bar/SKILL.md": createSkillMarkdown("1.0.0", "Bar"),
  });

  try {
    await withMockFetch(async (url) => {
      if (url === "https://api.github.com/repos/acme/duplicate-skill-marketplace") {
        return createJsonResponse({ default_branch: "main" });
      }
      if (
        url ===
        "https://api.github.com/repos/acme/duplicate-skill-marketplace/contents/.claude-plugin/marketplace.json?ref=main"
      ) {
        return createJsonResponse(createBase64JsonFilePayload(manifest));
      }
      if (
        url ===
        "https://codeload.github.com/acme/duplicate-skill-marketplace/tar.gz/main"
      ) {
        return createBinaryResponse(archiveBuffer);
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, async () => {
      // Round 9: one broken plugin no longer aborts the marketplace load —
      // it is annotated unavailable and the healthy plugin still expands.
      const definition = await service.loadMarketplaceDefinition({
        type: "github",
        repo: "acme/duplicate-skill-marketplace",
      });
      const duplicate = definition.manifest.plugins.find(
        (plugin) => plugin.name === "duplicate-bundle",
      );
      assert.equal(duplicate.unavailable, true);
      assert.equal(duplicate.unavailableReason, "marketplace_duplicate_skill_id");
      const healthy = definition.manifest.plugins.find(
        (plugin) => plugin.name === "healthy",
      );
      assert.equal(healthy.unavailable, undefined);
      assert.deepEqual(healthy.skills, ["./healthy/skills/bar"]);

      // Catalog view: the degraded plugin's skill is listed but blocked.
      const skills = service.parseSkillsFromManifest(
        definition.manifest,
        "duplicate-skill-marketplace",
      );
      const blocked = skills.find((skill) => skill.id === "duplicate-bundle");
      assert.equal(blocked.available, false);
      assert.equal(blocked.unavailableReason, "marketplace_duplicate_skill_id");
      const healthySkill = skills.find((skill) => skill.id === "bar");
      assert.equal(healthySkill.available, true);
      assert.equal(healthySkill.pluginName, "healthy");
    });
  } finally {
    restore();
  }
});

test("loadMarketplaceDefinition surfaces a helpful error when GitHub rate limits the request", async () => {
  const { service, restore } = loadMarketplaceService();

  try {
    await withNoGitHubToken(async () => {
      await withMockFetch(async () => {
        return new Response(
          JSON.stringify({
            message:
              "API rate limit exceeded for 1.2.3.4. (But here's the good news: Authenticated requests get a higher rate limit.)",
            documentation_url: "https://docs.github.com/rest/overview/rate-limits",
          }),
          {
            status: 403,
            headers: {
              "Content-Type": "application/json",
              "X-RateLimit-Remaining": "0",
              "X-RateLimit-Reset": "1700000000",
            },
          },
        );
      }, async () => {
        await assert.rejects(
          service.loadMarketplaceDefinition("anthropics/skills"),
          (error) => {
            assert.equal(error.code, "github_rate_limited");
            assert.match(error.message, /GitHub API rate limit exceeded/);
            assert.match(error.message, /GITHUB_TOKEN/);
            assert.equal(error.status, 403);
            assert.equal(error.authenticated, false);
            assert.ok(error.resetAt);
            return true;
          },
        );
      });
    });
  } finally {
    restore();
  }
});

test("loadMarketplaceDefinition omits token hint in rate limit error when GITHUB_TOKEN is already set", async () => {
  const { service, restore } = loadMarketplaceService();

  try {
    await withGitHubToken("test-github-token", async () => {
      await withMockFetch(async () => {
        return new Response(
          JSON.stringify({
            message: "You have exceeded a secondary rate limit.",
            documentation_url: "https://docs.github.com/rest/overview/rate-limits",
          }),
          {
            status: 403,
            headers: {
              "Content-Type": "application/json",
              "X-RateLimit-Remaining": "0",
              "X-RateLimit-Reset": "1700000000",
            },
          },
        );
      }, async () => {
        await assert.rejects(
          service.loadMarketplaceDefinition("anthropics/skills"),
          (error) => {
            assert.equal(error.code, "github_rate_limited");
            assert.equal(error.authenticated, true);
            assert.doesNotMatch(error.message, /GITHUB_TOKEN/);
            return true;
          },
        );
      });
    });
  } finally {
    restore();
  }
});

test("loadMarketplaceDefinition surfaces rate limit errors from codeload.github.com tarball downloads", async () => {
  const { service, restore } = loadMarketplaceService();

  try {
    await withNoGitHubToken(async () => {
      await withMockFetch(async (url) => {
        if (url === "https://api.github.com/repos/acme/rate-limit-codeload") {
          return createJsonResponse({ default_branch: "main" });
        }
        if (
          url ===
          "https://api.github.com/repos/acme/rate-limit-codeload/contents/.claude-plugin/marketplace.json?ref=main"
        ) {
          return createJsonResponse({ message: "Not Found" }, 404);
        }
        if (
          url ===
          "https://api.github.com/repos/acme/rate-limit-codeload/contents/.claude-plugin/plugin.json?ref=main"
        ) {
          return createJsonResponse({ message: "Not Found" }, 404);
        }
        if (url === "https://codeload.github.com/acme/rate-limit-codeload/tar.gz/main") {
          return new Response(
            JSON.stringify({
              message: "API rate limit exceeded for 1.2.3.4.",
            }),
            {
              status: 403,
              headers: {
                "Content-Type": "application/json",
                "X-RateLimit-Remaining": "0",
                "X-RateLimit-Reset": "1700000000",
              },
            },
          );
        }
        return createJsonResponse({ message: "Not Found" }, 404);
      }, async () => {
        await assert.rejects(
          service.loadMarketplaceDefinition("acme/rate-limit-codeload"),
          (error) => {
            assert.equal(error.code, "github_rate_limited");
            assert.match(error.message, /GitHub API rate limit exceeded/);
            assert.match(error.message, /GITHUB_TOKEN/);
            assert.equal(error.status, 403);
            assert.ok(error.url.startsWith("https://codeload.github.com/"));
            return true;
          },
        );
      });
    });
  } finally {
    restore();
  }
});

test("loadMarketplaceDefinition synthesizes sparse GitHub marketplaces from plugin.json and discovered skills", async () => {
  const { service, restore } = loadMarketplaceService();

  const pluginJson = {
    name: "trustkit",
    version: "0.1.0",
    description: "AI-powered skills for Trust & Safety work",
    author: {
      name: "Jesse Chen",
      email: "jessec@example.invalid",
    },
  };
  const archiveBuffer = createTarballBuffer("trust-kit-main", {
    ".claude/skills/trustkit/SKILL.md": createSkillMarkdown("0.1.0", "TrustKit"),
    ".claude/skills/trustkit/case-context-builder.md": "# helper",
    "skills/pdf/SKILL.md": createSkillMarkdown("1.0.0", "PDF"),
  });

  try {
    await withMockFetch(async (url) => {
      if (url === "https://api.github.com/repos/anthropics/skills") {
        return createJsonResponse({ default_branch: "main" });
      }
      if (
        url ===
        "https://api.github.com/repos/anthropics/skills/contents/.claude-plugin/marketplace.json?ref=main"
      ) {
        return createJsonResponse({ message: "Not Found" }, 404);
      }
      if (
        url ===
        "https://api.github.com/repos/anthropics/skills/contents/.claude-plugin/plugin.json?ref=main"
      ) {
        return createJsonResponse(createBase64JsonFilePayload(pluginJson));
      }
      if (url === "https://codeload.github.com/anthropics/skills/tar.gz/main") {
        return createBinaryResponse(archiveBuffer);
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, async () => {
      const result = await service.loadMarketplaceDefinition({
        type: "github",
        repo: "anthropics/skills",
      });

      assert.equal(result.isSparse, true);
      assert.equal(result.manifestSource, "plugin-json");
      assert.equal(result.source.type, "github");
      assert.equal(result.source.ref, "main");
      assert.deepEqual(result.manifest.plugins[0].skills, [
        "./.claude/skills/trustkit",
        "./skills/pdf",
      ]);
      assert.equal(result.manifest.metadata.version, "0.1.0");
    });
  } finally {
    restore();
  }
});

test("loadMarketplaceDefinition synthesizes sparse GitHub marketplaces when repo only has sparse skills", async () => {
  const { service, restore } = loadMarketplaceService();

  const archiveBuffer = createTarballBuffer("data-plat-skills-main", {
    ".claude/skills/trino-query-writing/SKILL.md": createSkillMarkdown(
      "1.0.0",
      "Trino Query Writing",
    ),
    ".claude/skills/iql-query-writing/SKILL.md": createSkillMarkdown(
      "1.0.0",
      "IQL Query Writing",
    ),
  });

  try {
    await withMockFetch(async (url) => {
      if (url === "https://api.github.com/repos/data-plat-mcp/data-plat-skills") {
        return createJsonResponse({ default_branch: "main" });
      }
      if (
        url ===
        "https://api.github.com/repos/data-plat-mcp/data-plat-skills/contents/.claude-plugin/marketplace.json?ref=main"
      ) {
        return createJsonResponse({ message: "Not Found" }, 404);
      }
      if (
        url ===
        "https://api.github.com/repos/data-plat-mcp/data-plat-skills/contents/.claude-plugin/plugin.json?ref=main"
      ) {
        return createJsonResponse({ message: "Not Found" }, 404);
      }
      if (
        url === "https://codeload.github.com/data-plat-mcp/data-plat-skills/tar.gz/main"
      ) {
        return createBinaryResponse(archiveBuffer);
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, async () => {
      const result = await service.loadMarketplaceDefinition({
        type: "github",
        repo: "data-plat-mcp/data-plat-skills",
      });

      assert.equal(result.isSparse, true);
      assert.equal(result.manifestSource, "sparse-repo-fallback");
      assert.equal(result.source.type, "github");
      assert.equal(result.source.ref, "main");
      assert.equal(result.manifest.name, "data-plat-skills");
      assert.deepEqual(result.manifest.owner, { name: "data-plat-mcp" });
      assert.deepEqual(result.manifest.metadata, {
        description: "Skills from data-plat-mcp/data-plat-skills",
        version: "1.0.0",
      });
      assert.deepEqual(result.manifest.plugins[0].skills, [
        "./.claude/skills/iql-query-writing",
        "./.claude/skills/trino-query-writing",
      ]);
    });
  } finally {
    restore();
  }
});

test("loadMarketplaceDefinition reports when a GitHub repo has no manifests and no sparse skills", async () => {
  const { service, restore } = loadMarketplaceService();
  const archiveBuffer = createTarballBuffer("data-plat-skills-main", {
    "README.md": "# Empty repo",
  });

  try {
    await withMockFetch(async (url) => {
      if (url === "https://api.github.com/repos/data-plat-mcp/data-plat-skills") {
        return createJsonResponse({ default_branch: "main" });
      }
      if (
        url ===
        "https://api.github.com/repos/data-plat-mcp/data-plat-skills/contents/.claude-plugin/marketplace.json?ref=main"
      ) {
        return createJsonResponse({ message: "Not Found" }, 404);
      }
      if (
        url ===
        "https://api.github.com/repos/data-plat-mcp/data-plat-skills/contents/.claude-plugin/plugin.json?ref=main"
      ) {
        return createJsonResponse({ message: "Not Found" }, 404);
      }
      if (
        url === "https://codeload.github.com/data-plat-mcp/data-plat-skills/tar.gz/main"
      ) {
        return createBinaryResponse(archiveBuffer);
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, async () => {
      await assert.rejects(
        () =>
          service.loadMarketplaceDefinition({
            type: "github",
            repo: "data-plat-mcp/data-plat-skills",
          }),
        /Repository data-plat-mcp\/data-plat-skills has no marketplace\.json, no plugin\.json, and no \.claude\/skills\/\*\/SKILL\.md files\./,
      );
    });
  } finally {
    restore();
  }
});

test("normalizeMarketplaceSourceInput supports GitHub tree URLs", () => {
  const { service, restore } = loadMarketplaceService();
  try {
    assert.deepEqual(
      service.normalizeMarketplaceSourceInput(
        "https://github.com/anthropics/skills/tree/main",
      ),
      {
        type: "github",
        repo: "anthropics/skills",
        repoUrl: "https://github.com/anthropics/skills",
        ref: "main",
      },
    );
  } finally {
    restore();
  }
});

test("loadMarketplaceDefinition synthesizes sparse GitLab marketplaces from paginated repository tree data", async () => {
  const authCalls = [];
  const { service, restore } = loadMarketplaceService({
    gitlabMarketplaceAuthExports: {
      async getAuthorizedSession(options) {
        authCalls.push(options);
        return { accessToken: "gitlab-token" };
      },
    },
  });

  const pluginJson = {
    name: "trustkit",
    version: "0.1.0",
    description: "AI-powered skills for Trust & Safety work",
    author: {
      name: "Jesse Chen",
      email: "jessec@example.invalid",
    },
  };

  try {
    await withMockFetch(async (url, options) => {
      if (
        url ===
        "https://example.invalid/api/v4/projects/squall-mod%2Ftrust-kit"
      ) {
        assert.equal(options.headers.Authorization, "Bearer gitlab-token");
        return createJsonResponse({ default_branch: "main" });
      }
      if (
        url ===
        "https://example.invalid/api/v4/projects/squall-mod%2Ftrust-kit/repository/files/.claude-plugin%2Fmarketplace.json?ref=main"
      ) {
        return createJsonResponse({ message: "Not Found" }, 404);
      }
      if (
        url ===
        "https://example.invalid/api/v4/projects/squall-mod%2Ftrust-kit/repository/files/.claude-plugin%2Fplugin.json?ref=main"
      ) {
        return createJsonResponse(createBase64JsonFilePayload(pluginJson));
      }
      if (
        url ===
        "https://example.invalid/api/v4/projects/squall-mod%2Ftrust-kit/repository/tree?ref=main&page=1&per_page=100&recursive=true"
      ) {
        return createJsonResponse(
          [
            {
              id: "helper",
              name: "case-context-builder.md",
              path: ".claude/skills/trustkit/case-context-builder.md",
              type: "blob",
              mode: "100644",
            },
          ],
          200,
          { "x-next-page": "2" },
        );
      }
      if (
        url ===
        "https://example.invalid/api/v4/projects/squall-mod%2Ftrust-kit/repository/tree?ref=main&page=2&per_page=100&recursive=true"
      ) {
        assert.equal(options.headers.Authorization, "Bearer gitlab-token");
        return createJsonResponse([
          {
            id: "skill",
            name: "SKILL.md",
            path: ".claude/skills/trustkit/SKILL.md",
            type: "blob",
            mode: "100644",
          },
        ]);
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, async () => {
      const result = await service.loadMarketplaceDefinition(
        {
          type: "gitlab",
          host: "example.invalid",
          projectPath: "squall-mod/trust-kit",
        },
        { interactiveAuth: true },
      );

      assert.equal(result.isSparse, true);
      assert.equal(result.manifestSource, "plugin-json");
      assert.equal(result.source.type, "gitlab");
      assert.equal(result.source.ref, "main");
      assert.deepEqual(result.manifest.plugins[0].skills, [
        "./.claude/skills/trustkit",
      ]);
      assert.ok(authCalls.some((call) => call.interactive === true));
    });
  } finally {
    restore();
  }
});

test("loadMarketplaceDefinition synthesizes sparse GitLab marketplaces when repo only has sparse skills", async () => {
  const authCalls = [];
  const { service, restore } = loadMarketplaceService({
    gitlabMarketplaceAuthExports: {
      async getAuthorizedSession(options) {
        authCalls.push(options);
        return { accessToken: "gitlab-token" };
      },
    },
  });

  try {
    await withMockFetch(async (url, options) => {
      if (
        url ===
        "https://example.invalid/api/v4/projects/data-plat-mcp%2Fdata-plat-skills"
      ) {
        assert.equal(options.headers.Authorization, "Bearer gitlab-token");
        return createJsonResponse({ default_branch: "main" });
      }
      if (
        url ===
        "https://example.invalid/api/v4/projects/data-plat-mcp%2Fdata-plat-skills/repository/files/.claude-plugin%2Fmarketplace.json?ref=main"
      ) {
        return createJsonResponse({ message: "Not Found" }, 404);
      }
      if (
        url ===
        "https://example.invalid/api/v4/projects/data-plat-mcp%2Fdata-plat-skills/repository/files/.claude-plugin%2Fplugin.json?ref=main"
      ) {
        return createJsonResponse({ message: "Not Found" }, 404);
      }
      if (
        url ===
        "https://example.invalid/api/v4/projects/data-plat-mcp%2Fdata-plat-skills/repository/tree?ref=main&page=1&per_page=100&recursive=true"
      ) {
        assert.equal(options.headers.Authorization, "Bearer gitlab-token");
        return createJsonResponse([
          {
            id: "skill",
            name: "SKILL.md",
            path: ".claude/skills/trino-query-writing/SKILL.md",
            type: "blob",
            mode: "100644",
          },
          {
            id: "helper",
            name: "helper.md",
            path: ".claude/skills/trino-query-writing/helper.md",
            type: "blob",
            mode: "100644",
          },
        ]);
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, async () => {
      const result = await service.loadMarketplaceDefinition(
        {
          type: "gitlab",
          host: "example.invalid",
          projectPath: "data-plat-mcp/data-plat-skills",
        },
        { interactiveAuth: true },
      );

      assert.equal(result.isSparse, true);
      assert.equal(result.manifestSource, "sparse-repo-fallback");
      assert.equal(result.source.type, "gitlab");
      assert.equal(result.source.ref, "main");
      assert.equal(result.manifest.name, "data-plat-skills");
      assert.deepEqual(result.manifest.owner, { name: "data-plat-mcp" });
      assert.deepEqual(result.manifest.metadata, {
        description: "Skills from data-plat-mcp/data-plat-skills",
        version: "1.0.0",
      });
      assert.deepEqual(result.manifest.plugins[0].skills, [
        "./.claude/skills/trino-query-writing",
      ]);
      assert.ok(authCalls.some((call) => call.interactive === true));
    });
  } finally {
    restore();
  }
});

test("loadMarketplaceDefinition accepts GitLab tree URLs from legacy marketplace copy behavior", async () => {
  const authCalls = [];
  const { service, restore } = loadMarketplaceService({
    gitlabMarketplaceAuthExports: {
      async getAuthorizedSession(options) {
        authCalls.push(options);
        return { accessToken: "gitlab-token" };
      },
    },
  });

  const pluginJson = {
    name: "trustkit",
    version: "0.1.0",
    description: "AI-powered skills for Trust & Safety work",
    author: {
      name: "Jesse Chen",
      email: "jessec@example.invalid",
    },
  };

  try {
    await withMockFetch(async (url, options) => {
      if (
        url ===
        "https://example.invalid/api/v4/projects/nickw%2Fejp-skills/repository/files/.claude-plugin%2Fmarketplace.json?ref=main"
      ) {
        return createJsonResponse({ message: "Not Found" }, 404);
      }
      if (
        url ===
        "https://example.invalid/api/v4/projects/nickw%2Fejp-skills/repository/files/.claude-plugin%2Fplugin.json?ref=main"
      ) {
        assert.equal(options.headers.Authorization, "Bearer gitlab-token");
        return createJsonResponse(createBase64JsonFilePayload(pluginJson));
      }
      if (
        url ===
        "https://example.invalid/api/v4/projects/nickw%2Fejp-skills/repository/tree?ref=main&page=1&per_page=100&recursive=true"
      ) {
        return createJsonResponse([
          {
            id: "skill",
            name: "SKILL.md",
            path: "skills/atleon/SKILL.md",
            type: "blob",
            mode: "100644",
          },
        ]);
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, async () => {
      const result = await service.loadMarketplaceDefinition(
        "https://example.invalid/nickw/ejp-skills/-/tree/main",
        { interactiveAuth: true },
      );

      assert.equal(result.source.type, "gitlab");
      assert.equal(result.source.projectPath, "nickw/ejp-skills");
      assert.equal(result.source.ref, "main");
      assert.equal(result.isSparse, true);
      assert.deepEqual(result.manifest.plugins[0].skills, ["./skills/atleon"]);
      assert.ok(authCalls.some((call) => call.interactive === true));
    });
  } finally {
    restore();
  }
});

test("addMarketplace persists sparse metadata and source details into marketplaces.json", async () => {
  const projectRoot = createTempDir("marketplace-add-test-");
  const { service, restore } = loadMarketplaceService();
  const pluginJson = {
    name: "trustkit",
    version: "0.1.0",
    description: "AI-powered skills for Trust & Safety work",
    author: {
      name: "Jesse Chen",
      email: "jessec@example.invalid",
    },
  };
  const archiveBuffer = createTarballBuffer("trust-kit-main", {
    ".claude/skills/trustkit/SKILL.md": createSkillMarkdown("0.1.0", "TrustKit"),
  });

  try {
    await withMockFetch(async (url) => {
      if (url === "https://api.github.com/repos/anthropics/skills") {
        return createJsonResponse({ default_branch: "main" });
      }
      if (
        url ===
        "https://api.github.com/repos/anthropics/skills/contents/.claude-plugin/marketplace.json?ref=main"
      ) {
        return createJsonResponse({ message: "Not Found" }, 404);
      }
      if (
        url ===
        "https://api.github.com/repos/anthropics/skills/contents/.claude-plugin/plugin.json?ref=main"
      ) {
        return createJsonResponse(createBase64JsonFilePayload(pluginJson));
      }
      if (url === "https://codeload.github.com/anthropics/skills/tar.gz/main") {
        return createBinaryResponse(archiveBuffer);
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, async () => {
      const marketplace = await service.addMarketplace({
        projectRoot,
        sourceInput: "https://github.com/anthropics/skills",
      });

      assert.equal(marketplace.id, "trustkit");
      assert.equal(marketplace.isSparse, true);
      assert.equal(marketplace.manifestSource, "plugin-json");
      assert.equal(marketplace.source.type, "github");
      assert.equal(marketplace.source.ref, "main");

      const config = readJson(path.join(projectRoot, "marketplaces.json"));
      assert.equal(config.marketplaces.length, 1);
      assert.equal(config.marketplaces[0].isSparse, true);
      assert.equal(config.marketplaces[0].manifestSource, "plugin-json");
      assert.equal(config.marketplaces[0].source.repo, "anthropics/skills");
    });
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("removeMarketplace optionally deletes installed marketplace skills and their directories", async () => {
  const projectRoot = createTempDir("marketplace-remove-test-");
  const { service, restore } = loadMarketplaceService();
  const skillDir = path.join(
    projectRoot,
    "skills-marketplace",
    "trustkit",
    "trustkit",
  );

  try {
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), createSkillMarkdown("1.0.0"));

    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [
        {
          id: "trustkit",
          name: "trustkit",
          source: { type: "github", repo: "anthropics/skills" },
          isOfficial: false,
        },
      ],
      installedSkills: [
        {
          marketplaceId: "trustkit",
          skillId: "trustkit",
          installedVersion: "1.0.0",
          localPath: "skills-marketplace/trustkit/trustkit",
        },
      ],
    });

    const result = await service.removeMarketplace({
      projectRoot,
      marketplaceId: "trustkit",
      removeInstalledSkills: true,
    });

    assert.equal(result.marketplaceId, "trustkit");
    assert.equal(result.removedInstalledSkills, true);
    assert.equal(result.removedSkillsCount, 1);

    const config = readJson(path.join(projectRoot, "marketplaces.json"));
    assert.deepEqual(config.marketplaces, []);
    assert.deepEqual(config.installedSkills, []);
    assert.equal(fs.existsSync(skillDir), false);
    assert.equal(
      fs.existsSync(path.join(projectRoot, "skills-marketplace", "trustkit")),
      false,
    );
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("removeMarketplace rejects built-in (ootb) marketplaces and keeps them registered", async () => {
  const projectRoot = createTempDir("marketplace-remove-ootb-test-");
  const { service, restore } = loadMarketplaceService();

  try {
    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [
        {
          id: "knowledge-work-plugins",
          name: "knowledge-work-plugins",
          source: { type: "github", repo: "anthropics/knowledge-work-plugins" },
          isOfficial: false,
          ootb: true,
        },
        {
          id: "user-added",
          name: "user-added",
          source: { type: "github", repo: "someone/skills" },
          isOfficial: false,
        },
      ],
      installedSkills: [],
    });

    await assert.rejects(
      service.removeMarketplace({
        projectRoot,
        marketplaceId: "knowledge-work-plugins",
      }),
      (error) => {
        assert.equal(error.code, "immutable_marketplace");
        assert.match(error.message, /built-in marketplace cannot be removed/);
        return true;
      },
    );
    const config = readJson(path.join(projectRoot, "marketplaces.json"));
    assert.ok(
      config.marketplaces.some((entry) => entry.id === "knowledge-work-plugins"),
      "the built-in marketplace stays registered",
    );

    // A plain user-added marketplace still removes normally.
    const result = await service.removeMarketplace({
      projectRoot,
      marketplaceId: "user-added",
    });
    assert.equal(result.marketplaceId, "user-added");
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("removeMarketplace rejects removing the official marketplace", async () => {
  const projectRoot = createTempDir("marketplace-remove-official-test-");
  const { service, restore } = loadMarketplaceService();

  try {
    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [
        {
          id: "anthropic-agent-skills",
          name: "anthropic-agent-skills",
          source: { type: "github", repo: "anthropics/skills" },
          isOfficial: true,
        },
      ],
      installedSkills: [],
    });

    await assert.rejects(
      service.removeMarketplace({
        projectRoot,
        marketplaceId: "anthropic-agent-skills",
      }),
      (error) => {
        assert.equal(error.code, "immutable_marketplace");
        assert.match(error.message, /official Anthropic marketplace/);
        return true;
      },
    );
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("syncMarketplace promotes sparse repositories to regular marketplaces when marketplace.json appears later", async () => {
  const projectRoot = createTempDir("marketplace-sync-test-");
  const { service, restore } = loadMarketplaceService();

  const sparsePluginJson = {
    name: "trustkit",
    version: "0.1.0",
    description: "Sparse marketplace",
  };
  const sparseArchiveBuffer = createTarballBuffer("trust-kit-main", {
    ".claude/skills/trustkit/SKILL.md": createSkillMarkdown("0.1.0", "TrustKit"),
  });
  const regularManifest = {
    name: "trustkit",
    owner: { name: "TrustKit" },
    metadata: {
      description: "Regular marketplace",
      version: "1.0.0",
    },
    plugins: [
      {
        name: "trustkit",
        description: "Regular plugin",
        skills: ["./skills/trustkit"],
      },
    ],
  };
  let phase = "sparse";

  try {
    await withMockFetch(async (url) => {
      if (url === "https://api.github.com/repos/anthropics/skills") {
        return createJsonResponse({ default_branch: "main" });
      }

      if (
        url ===
        "https://api.github.com/repos/anthropics/skills/contents/.claude-plugin/marketplace.json?ref=main"
      ) {
        if (phase === "regular") {
          return createJsonResponse(createBase64JsonFilePayload(regularManifest));
        }
        return createJsonResponse({ message: "Not Found" }, 404);
      }

      if (
        url ===
        "https://api.github.com/repos/anthropics/skills/contents/.claude-plugin/plugin.json?ref=main"
      ) {
        return createJsonResponse(createBase64JsonFilePayload(sparsePluginJson));
      }

      if (url === "https://codeload.github.com/anthropics/skills/tar.gz/main") {
        return createBinaryResponse(sparseArchiveBuffer);
      }

      return createJsonResponse({ message: "Not Found" }, 404);
    }, async () => {
      await service.addMarketplace({
        projectRoot,
        sourceInput: "anthropics/skills",
      });

      phase = "regular";
      const result = await service.syncMarketplace({
        projectRoot,
        marketplaceId: "trustkit",
      });

      assert.equal(result.marketplace.isSparse, false);
      assert.equal(result.marketplace.manifestSource, "marketplace-json");
      assert.equal(result.marketplace.marketplaceVersion, "1.0.0");

      const config = readJson(path.join(projectRoot, "marketplaces.json"));
      assert.equal(config.marketplaces[0].isSparse, false);
      assert.equal(config.marketplaces[0].manifestSource, "marketplace-json");
      assert.equal(config.marketplaces[0].cachedManifest.metadata.description, "Regular marketplace");
    });
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("syncMarketplace installs same-version content changes and regenerates the baseline", async () => {
  const projectRoot = createTempDir("marketplace-sync-content-test-");
  const { service, restore } = loadMarketplaceService();
  const skillId = "smart-slides-iql-metrics";
  const localPath = `skills-marketplace/zstevens-portico-skills/zstevens-skills/${skillId}`;
  const installedDir = path.join(projectRoot, localPath);
  const oldMarkdown = [
    "---",
    `name: ${skillId}`,
    'version: "1.0"',
    "triggers:",
    '  - keywords: ["iql query", "data pull"]',
    "---",
    "",
    "# Smart Slides IQL Metrics",
    "",
  ].join("\n");
  const correctedMarkdown = [
    "---",
    `name: ${skillId}`,
    'version: "1.0"',
    "triggers:",
    "  - iql query",
    "  - data pull",
    "---",
    "",
    "# Smart Slides IQL Metrics",
    "",
  ].join("\n");
  const manifest = createSyncTestMarketplaceManifest();
  const logs = [];

  try {
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(path.join(installedDir, "SKILL.md"), oldMarkdown);
    const config = createSyncTestConfig(
      [
        {
          marketplaceId: "zstevens-portico-skills",
          skillId,
          pluginName: "zstevens-skills",
          skillPath: `./skills/${skillId}`,
          installedVersion: "1.0",
          lastCheckedVersion: "1.0",
          localPath,
          baseline: {
            version: "1.0",
            sourceRef: "main",
            files: [{ path: "SKILL.md", sha256: sha256(oldMarkdown) }],
          },
        },
      ],
      manifest,
    );
    config.marketplaces[0].source = {
      type: "gitlab",
      host: "example.invalid",
      projectPath: "zstevens/portico-skills-marketplace",
      repoUrl: "https://example.invalid/zstevens/portico-skills-marketplace.git",
      ref: "main",
    };
    writeJson(path.join(projectRoot, "marketplaces.json"), config);

    const result = await withMockZachGitLabMarketplace(
      skillId,
      correctedMarkdown,
      manifest,
      async () =>
        await service.syncMarketplace({
          projectRoot,
          marketplaceId: "zstevens-portico-skills",
          logger: {
            log(message) {
              logs.push(message);
            },
            warn(message) {
              logs.push(message);
            },
          },
        }),
    );

    assert.deepEqual(result.skillsUpdated, [
      {
        skillId,
        previousVersion: "1.0",
        newVersion: "1.0",
        updateKind: "content",
      },
    ]);
    assert.deepEqual(result.skillsConflicted, []);
    assert.deepEqual(result.skillSyncErrors, []);
    assert.equal(fs.readFileSync(path.join(installedDir, "SKILL.md"), "utf8"), correctedMarkdown);
    assert.deepEqual(
      fs.readdirSync(path.dirname(installedDir)).sort(),
      [skillId],
    );

    const savedConfig = readJson(path.join(projectRoot, "marketplaces.json"));
    const installed = savedConfig.installedSkills[0];
    assert.equal(installed.installedVersion, "1.0");
    assert.equal(installed.lastCheckedVersion, "1.0");
    assert.equal(installed.hasUpdate, false);
    assert.equal(Boolean(installed.hasConflict), false);
    assert.equal(installed.baseline.files[0].sha256, sha256(correctedMarkdown));
    assert.ok(logs.some((message) => message.includes("remote content update")));
    assert.ok(logs.every((message) => !message.includes("iql query")));
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("syncMarketplace leaves identical installed content untouched", async () => {
  const projectRoot = createTempDir("marketplace-sync-unchanged-test-");
  const { service, restore } = loadMarketplaceService();
  const skillId = "smart-slides-iql-metrics";
  const localPath = `skills-marketplace/zstevens-portico-skills/zstevens-skills/${skillId}`;
  const installedDir = path.join(projectRoot, localPath);
  const markdown = createSkillMarkdown("1.0.0", "Smart Slides IQL Metrics");
  const manifest = createSyncTestMarketplaceManifest();
  const archiveBuffer = createTarballBuffer("portico-skills-marketplace-main", {
    [`skills/${skillId}/SKILL.md`]: markdown,
  });

  try {
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(path.join(installedDir, "SKILL.md"), markdown);
    const originalInode = fs.statSync(installedDir).ino;
    writeJson(
      path.join(projectRoot, "marketplaces.json"),
      createSyncTestConfig([
        {
          marketplaceId: "zstevens-portico-skills",
          skillId,
          pluginName: "zstevens-skills",
          skillPath: `./skills/${skillId}`,
          installedVersion: "1.0.0",
          lastCheckedVersion: "1.0.0",
          localPath,
          baseline: {
            version: "1.0.0",
            sourceRef: "main",
            files: [{ path: "SKILL.md", sha256: sha256(markdown) }],
          },
        },
      ], manifest),
    );

    const result = await withMockSyncTestMarketplace(archiveBuffer, manifest, async () =>
      await service.syncMarketplace({
        projectRoot,
        marketplaceId: "zstevens-portico-skills",
      }),
    );

    assert.deepEqual(result.skillsUpdated, []);
    assert.deepEqual(result.skillsUpToDate, [
      { skillId, reason: "content_unchanged" },
    ]);
    assert.equal(fs.statSync(installedDir).ino, originalInode);
    assert.deepEqual(fs.readdirSync(path.dirname(installedDir)).sort(), [skillId]);
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("syncMarketplace preserves dirty installs when same-version remote content changes", async () => {
  const projectRoot = createTempDir("marketplace-sync-conflict-test-");
  const { service, restore } = loadMarketplaceService();
  const skillId = "smart-slides-iql-metrics";
  const localPath = `skills-marketplace/zstevens-portico-skills/zstevens-skills/${skillId}`;
  const installedDir = path.join(projectRoot, localPath);
  const baselineMarkdown = createSkillMarkdown("1.0.0", "Original");
  const locallyEditedMarkdown = `${baselineMarkdown}\nLocal notes\n`;
  const remoteMarkdown = createSkillMarkdown("1.0.0", "Corrected Remote");
  const manifest = createSyncTestMarketplaceManifest();
  const archiveBuffer = createTarballBuffer("portico-skills-marketplace-main", {
    [`skills/${skillId}/SKILL.md`]: remoteMarkdown,
  });

  try {
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(path.join(installedDir, "SKILL.md"), locallyEditedMarkdown);
    writeJson(
      path.join(projectRoot, "marketplaces.json"),
      createSyncTestConfig([
        {
          marketplaceId: "zstevens-portico-skills",
          skillId,
          pluginName: "zstevens-skills",
          skillPath: `./skills/${skillId}`,
          installedVersion: "1.0.0",
          lastCheckedVersion: "1.0.0",
          localPath,
          baseline: {
            version: "1.0.0",
            sourceRef: "main",
            files: [{ path: "SKILL.md", sha256: sha256(baselineMarkdown) }],
          },
        },
      ], manifest),
    );

    const result = await withMockSyncTestMarketplace(archiveBuffer, manifest, async () =>
      await service.syncMarketplace({
        projectRoot,
        marketplaceId: "zstevens-portico-skills",
      }),
    );

    assert.deepEqual(result.skillsUpdated, []);
    assert.deepEqual(result.skillsConflicted, [
      { skillId, remoteVersion: "1.0.0", updateKind: "content" },
    ]);
    assert.equal(
      fs.readFileSync(path.join(installedDir, "SKILL.md"), "utf8"),
      locallyEditedMarkdown,
    );
    assert.deepEqual(fs.readdirSync(path.dirname(installedDir)).sort(), [skillId]);

    const config = readJson(path.join(projectRoot, "marketplaces.json"));
    assert.equal(config.installedSkills[0].hasUpdate, true);
    const loaded = await service.loadMarketplacesConfig(projectRoot);
    assert.equal(loaded.installedSkills[0].isDirty, true);
    assert.equal(loaded.installedSkills[0].hasConflict, true);
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("syncMarketplace retains version updates and continues after another skill fails", async () => {
  const projectRoot = createTempDir("marketplace-sync-partial-test-");
  const { service, restore } = loadMarketplaceService();
  const missingSkillId = "missing-skill";
  const goodSkillId = "smart-slides-iql-metrics";
  const missingLocalPath = `skills-marketplace/zstevens-portico-skills/zstevens-skills/${missingSkillId}`;
  const goodLocalPath = `skills-marketplace/zstevens-portico-skills/zstevens-skills/${goodSkillId}`;
  const missingMarkdown = createSkillMarkdown("1.0.0", "Missing Skill");
  const oldGoodMarkdown = createSkillMarkdown("1.0.0", "Old Smart Slides");
  const newGoodMarkdown = createSkillMarkdown("2.0.0", "New Smart Slides");
  const manifest = createSyncTestMarketplaceManifest([
    `./skills/${missingSkillId}`,
    `./skills/${goodSkillId}`,
  ]);
  const archiveBuffer = createTarballBuffer("portico-skills-marketplace-main", {
    [`skills/${goodSkillId}/SKILL.md`]: newGoodMarkdown,
  });

  try {
    for (const [relativePath, markdown] of [
      [missingLocalPath, missingMarkdown],
      [goodLocalPath, oldGoodMarkdown],
    ]) {
      const directory = path.join(projectRoot, relativePath);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "SKILL.md"), markdown);
    }
    writeJson(
      path.join(projectRoot, "marketplaces.json"),
      createSyncTestConfig([
        {
          marketplaceId: "zstevens-portico-skills",
          skillId: missingSkillId,
          pluginName: "zstevens-skills",
          skillPath: `./skills/${missingSkillId}`,
          installedVersion: "1.0.0",
          localPath: missingLocalPath,
          baseline: {
            version: "1.0.0",
            files: [{ path: "SKILL.md", sha256: sha256(missingMarkdown) }],
          },
        },
        {
          marketplaceId: "zstevens-portico-skills",
          skillId: goodSkillId,
          pluginName: "zstevens-skills",
          skillPath: `./skills/${goodSkillId}`,
          installedVersion: "1.0.0",
          localPath: goodLocalPath,
          baseline: {
            version: "1.0.0",
            files: [{ path: "SKILL.md", sha256: sha256(oldGoodMarkdown) }],
          },
        },
      ], manifest),
    );

    const result = await withMockSyncTestMarketplace(archiveBuffer, manifest, async () =>
      await service.syncMarketplace({
        projectRoot,
        marketplaceId: "zstevens-portico-skills",
      }),
    );

    assert.equal(result.skillSyncErrors.length, 1);
    assert.equal(result.skillSyncErrors[0].skillId, missingSkillId);
    assert.match(result.skillSyncErrors[0].error, /Skill not found/i);
    assert.deepEqual(result.skillsUpdated, [
      {
        skillId: goodSkillId,
        previousVersion: "1.0.0",
        newVersion: "2.0.0",
        updateKind: "version",
      },
    ]);
    assert.equal(
      fs.readFileSync(path.join(projectRoot, missingLocalPath, "SKILL.md"), "utf8"),
      missingMarkdown,
    );
    assert.equal(
      fs.readFileSync(path.join(projectRoot, goodLocalPath, "SKILL.md"), "utf8"),
      newGoodMarkdown,
    );
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("syncMarketplace preserves explicit refs on external GitLab plugin sources", async () => {
  const projectRoot = createTempDir("marketplace-sync-ref-test-");
  const { service, restore } = loadMarketplaceService();
  const requestedUrls = [];
  const updatedManifest = {
    name: "portico-ai-marketplace",
    owner: { name: "Community" },
    metadata: {
      description: "Portico AI marketplace",
      version: "1.0.0",
    },
    plugins: [
      {
        name: "mlplat-skills",
        description: "MDP skills",
        source: {
          source: "git-subdir",
          url: "git@example.invalid:niffler/mdp-mcp-server.git",
          path: "plugin",
          ref: "master",
        },
      },
      {
        name: "herbie",
        description: "Retrieve and analyze engineer performance data using HERBIE.",
        source: "./community/herbie",
      },
    ],
  };

  try {
    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [
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
            metadata: { version: "1.0.0" },
            plugins: [
              {
                name: "old-skill",
                source: "./community/old-skill",
              },
            ],
          },
        },
      ],
      installedSkills: [],
    });

    await withMockFetch(async (url) => {
      requestedUrls.push(url);

      if (
        url ===
        "https://example.invalid/api/v4/projects/community%2Fportico-ai-marketplace/repository/files/.claude-plugin%2Fmarketplace.json?ref=main"
      ) {
        return createJsonResponse(createBase64JsonFilePayload(updatedManifest));
      }

      if (
        url ===
        "https://example.invalid/api/v4/projects/niffler%2Fmdp-mcp-server/repository/tree?ref=master&page=1&per_page=100&recursive=true"
      ) {
        return createJsonResponse([
          { type: "blob", path: "plugin/SKILL.md" },
        ]);
      }

      if (
        url ===
        "https://example.invalid/api/v4/projects/community%2Fportico-ai-marketplace/repository/tree?ref=main&page=1&per_page=100&recursive=true"
      ) {
        return createJsonResponse([
          { type: "blob", path: "community/herbie/skills/herbie/SKILL.md" },
        ]);
      }

      return createJsonResponse({ message: "Not Found" }, 404);
    }, async () => {
      const result = await service.syncMarketplace({
        projectRoot,
        marketplaceId: "portico-ai-marketplace",
      });

      assert.equal(
        requestedUrls.some(
          (url) =>
            url.includes("niffler%2Fmdp-mcp-server") &&
            url.includes("ref=main"),
        ),
        false,
      );
      assert.equal(
        requestedUrls.some(
          (url) =>
            url.includes("niffler%2Fmdp-mcp-server") &&
            url.includes("ref=master"),
        ),
        true,
      );
      assert.equal(
        result.marketplace.cachedManifest.plugins.some(
          (plugin) => plugin.name === "herbie",
        ),
        true,
      );

      const config = readJson(path.join(projectRoot, "marketplaces.json"));
      assert.equal(
        config.marketplaces[0].cachedManifest.plugins.some(
          (plugin) => plugin.name === "herbie",
        ),
        true,
      );
    });
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("getMarketplaceSkills marks installed marketplace skills from the saved config", async () => {
  const projectRoot = createTempDir("marketplace-skills-test-");
  const { service, restore } = loadMarketplaceService();

  try {
    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [
        {
          id: "anthropic-agent-skills",
          name: "anthropic-agent-skills",
          source: { type: "github", repo: "anthropics/skills" },
          cachedManifest: {
            name: "anthropic-agent-skills",
            metadata: {
              description: "Anthropic example skills",
              version: "1.0.0",
            },
            plugins: [
              {
                name: "docs",
                description: "Document skills",
                skills: ["./skills/pdf", "./skills/docx", "./skills/mcp_api-reader"],
              },
            ],
          },
        },
      ],
      installedSkills: [
        {
          marketplaceId: "anthropic-agent-skills",
          skillId: "pdf",
          installedVersion: "1.0.0",
          localPath: "skills-marketplace/anthropic-agent-skills/pdf",
          hasUpdate: true,
        },
      ],
    });

    const result = await service.getMarketplaceSkills({
      projectRoot,
      marketplaceId: "anthropic-agent-skills",
    });

    const pdf = result.skills.find((skill) => skill.id === "pdf");
    const docx = result.skills.find((skill) => skill.id === "docx");

    assert.equal(pdf.installed, true);
    assert.equal(pdf.installedVersion, "1.0.0");
    assert.equal(pdf.hasUpdate, true);
    assert.equal(docx.installed, false);

    // Listings carry both the legacy renderer field (split-on-"-" only) and
    // the tool-facing display_name with the full shared formatting rules.
    const reader = result.skills.find((skill) => skill.id === "mcp_api-reader");
    assert.equal(reader.displayName, "Mcp_api Reader");
    assert.equal(reader.display_name, "MCP API Reader");
    assert.equal(pdf.display_name, "Pdf");
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("getMarketplaceSkills persists a root-skill verdict once and skips repository inspection on repeat loads", async () => {
  const projectRoot = createTempDir("marketplace-rootskill-test-");
  const { service, restore } = loadMarketplaceService();
  const treeRequests = [];

  try {
    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [
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
            metadata: { version: "1.0.0" },
            plugins: [
              {
                name: "alma-dev",
                description: "Alma agent skills",
                source: "./community/sts-alma/alma-dev",
              },
            ],
          },
        },
      ],
      installedSkills: [],
    });

    await withMockFetch(async (url) => {
      if (url.includes("/repository/tree")) {
        treeRequests.push(url);
        return createJsonResponse([
          { type: "blob", path: "community/sts-alma/alma-dev/SKILL.md" },
        ]);
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, async () => {
      const first = await service.getMarketplaceSkills({
        projectRoot,
        marketplaceId: "portico-ai-marketplace",
      });
      assert.equal(treeRequests.length, 1);

      // The verdict is a marker, never a skills[] array: an array would
      // deepen the install identity from mp/leaf to mp/plugin/leaf.
      const alma = first.skills.find((skill) => skill.id === "alma-dev");
      assert.equal(alma.pluginName, null);
      const saved = readJson(path.join(projectRoot, "marketplaces.json"));
      const savedPlugin = saved.marketplaces[0].cachedManifest.plugins.find(
        (plugin) => plugin.name === "alma-dev",
      );
      assert.equal(savedPlugin.rootSkill, true);
      assert.equal("skills" in savedPlugin, false);

      const second = await service.getMarketplaceSkills({
        projectRoot,
        marketplaceId: "portico-ai-marketplace",
      });
      assert.equal(treeRequests.length, 1);
      const almaAgain = second.skills.find((skill) => skill.id === "alma-dev");
      assert.equal(almaAgain.pluginName, null);
      assert.equal(almaAgain.installed, false);
    });
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("getMarketplaceSkills degrades plugins with no discoverable skills instead of re-inspecting or offering dead installs", async () => {
  const projectRoot = createTempDir("marketplace-noskills-test-");
  const { service, restore } = loadMarketplaceService();
  const treeRequests = [];

  try {
    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [
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
            metadata: { version: "1.0.0" },
            plugins: [
              {
                name: "docs-only",
                description: "No SKILL.md anywhere",
                source: "./community/docs-only",
              },
            ],
          },
        },
      ],
      installedSkills: [],
    });

    await withMockFetch(async (url) => {
      if (url.includes("/repository/tree")) {
        treeRequests.push(url);
        return createJsonResponse([
          { type: "blob", path: "community/docs-only/README.md" },
        ]);
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, async () => {
      const first = await service.getMarketplaceSkills({
        projectRoot,
        marketplaceId: "portico-ai-marketplace",
      });
      assert.equal(treeRequests.length, 1);
      const saved = readJson(path.join(projectRoot, "marketplaces.json"));
      const savedPlugin = saved.marketplaces[0].cachedManifest.plugins.find(
        (plugin) => plugin.name === "docs-only",
      );
      // "Inspected, nothing there" persists as a degrade — an installable
      // card would produce a dead SKILL.md-less install.
      assert.equal(savedPlugin.unavailable, true);
      assert.equal(savedPlugin.unavailableReason, "marketplace_no_skills_found");
      assert.equal("skills" in savedPlugin, false);
      assert.equal("rootSkill" in savedPlugin, false);
      const docsOnly = first.skills.find((skill) => skill.id === "docs-only");
      assert.equal(docsOnly.available, false);

      await service.getMarketplaceSkills({
        projectRoot,
        marketplaceId: "portico-ai-marketplace",
      });
      assert.equal(treeRequests.length, 1);
    });
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("getMarketplaceSkills surfaces dirty and conflict state for locally edited marketplace installs", async () => {
  const projectRoot = createTempDir("marketplace-skills-dirty-test-");
  const { service, restore } = loadMarketplaceService();
  const installedDir = path.join(
    projectRoot,
    "skills-marketplace",
    "anthropic-agent-skills",
    "pdf",
  );
  const originalMarkdown = createSkillMarkdown("1.0.0", "PDF");

  try {
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(
      path.join(installedDir, "SKILL.md"),
      `${originalMarkdown}\nLocal edits\n`,
    );

    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [
        {
          id: "anthropic-agent-skills",
          name: "anthropic-agent-skills",
          source: { type: "github", repo: "anthropics/skills" },
          cachedManifest: {
            name: "anthropic-agent-skills",
            metadata: {
              description: "Anthropic example skills",
              version: "1.0.0",
            },
            plugins: [
              {
                name: "docs",
                description: "Document skills",
                skills: ["./skills/pdf"],
              },
            ],
          },
        },
      ],
      installedSkills: [
        {
          marketplaceId: "anthropic-agent-skills",
          skillId: "pdf",
          installedVersion: "1.0.0",
          localPath: "skills-marketplace/anthropic-agent-skills/pdf",
          hasUpdate: true,
          baseline: {
            version: "1.0.0",
            sourceRef: "main",
            files: [
              {
                path: "SKILL.md",
                sha256: sha256(originalMarkdown),
              },
            ],
          },
        },
      ],
    });

    const result = await service.getMarketplaceSkills({
      projectRoot,
      marketplaceId: "anthropic-agent-skills",
    });
    const loaded = await service.loadMarketplacesConfig(projectRoot);

    assert.equal(result.skills[0].isDirty, true);
    assert.equal(result.skills[0].hasConflict, true);
    assert.equal(loaded.installedSkills[0].isDirty, true);
    assert.equal(loaded.installedSkills[0].hasConflict, true);
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("getMarketplaceSkillsCached serves the catalog with real dirty state and no reconcile, network, or writes", async () => {
  const projectRoot = createTempDir("marketplace-cached-path-test-");
  const { service, restore } = loadMarketplaceService();
  const installedDir = path.join(projectRoot, "skills-marketplace", "mp", "solo");
  const originalMarkdown = createSkillMarkdown("1.0.0", "Solo");
  const fetchCalls = [];

  try {
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(
      path.join(installedDir, "SKILL.md"),
      `${originalMarkdown}\nLocal edits\n`,
    );

    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [
        {
          id: "mp",
          name: "mp",
          source: { type: "github", repo: "anthropics/skills" },
          cachedManifest: {
            name: "mp",
            metadata: { version: "1.0.0" },
            plugins: [
              { name: "docs", description: "Docs", skills: ["./skills/pdf"] },
              // No skills[] — the fast path must not inspect the repository.
              { name: "solo", description: "Root skill", source: "./solo" },
            ],
          },
        },
        {
          id: "no-manifest",
          name: "no-manifest",
          source: { type: "github", repo: "anthropics/skills" },
        },
      ],
      installedSkills: [
        {
          marketplaceId: "mp",
          skillId: "solo",
          installedVersion: "1.0.0",
          localPath: "skills-marketplace/mp/solo",
          baseline: {
            version: "1.0.0",
            sourceRef: "main",
            files: [{ path: "SKILL.md", sha256: sha256(originalMarkdown) }],
          },
        },
      ],
    });
    const configPath = path.join(projectRoot, "marketplaces.json");
    const configBefore = fs.readFileSync(configPath, "utf8");

    await withMockFetch(async (url) => {
      fetchCalls.push(url);
      return createJsonResponse({ message: "unexpected network" }, 500);
    }, async () => {
      const result = await service.getMarketplaceSkillsCached({
        projectRoot,
        marketplaceId: "mp",
      });

      const pdf = result.skills.find((skill) => skill.id === "pdf");
      const solo = result.skills.find((skill) => skill.id === "solo");
      assert.equal(pdf.installed, false);
      assert.equal(pdf.pluginName, "docs");
      assert.equal(solo.installed, true);
      assert.equal(solo.isDirty, true, "scoped hydration computed real dirty state");

      await assert.rejects(
        service.getMarketplaceSkillsCached({ projectRoot, marketplaceId: "missing" }),
        (error) => error.code === "marketplace_not_found",
      );
      await assert.rejects(
        service.getMarketplaceSkillsCached({ projectRoot, marketplaceId: "no-manifest" }),
        (error) => error.code === "manifest_not_cached",
      );
    });

    assert.equal(fetchCalls.length, 0, "the fast path never touches the network");
    assert.equal(
      fs.readFileSync(configPath, "utf8"),
      configBefore,
      "the fast path never rewrites marketplaces.json",
    );
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("loadMarketplacesConfig refreshes installed marketplace versions from duplicate-key SKILL frontmatter", async () => {
  const projectRoot = createTempDir("marketplace-version-refresh-test-");
  const { service, restore } = loadMarketplaceService();

  try {
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

    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [
        {
          id: "trust-kit",
          name: "Trust Kit",
          source: {
            type: "gitlab",
            host: "example.invalid",
            projectPath: "anthropics/skills",
            repoUrl: "https://example.invalid/anthropics/skills.git",
            ref: "main",
          },
        },
      ],
      installedSkills: [
        {
          marketplaceId: "trust-kit",
          skillId: "shared-trino",
          skillPath: "./.claude/skills/shared-trino",
          localPath: "skills-marketplace/trust-kit/shared-trino",
          installedAt: "2026-03-30T00:00:00.000Z",
          installedVersion: "1.0",
          lastCheckedVersion: "1.0",
          hasUpdate: false,
        },
      ],
    });

    const config = await service.loadMarketplacesConfig(projectRoot);

    assert.equal(config.installedSkills[0].installedVersion, "2.1");
    assert.equal(config.installedSkills[0].lastCheckedVersion, "2.1");

    const persisted = readJson(path.join(projectRoot, "marketplaces.json"));
    assert.equal(persisted.installedSkills[0].installedVersion, "2.1");
    assert.equal(persisted.installedSkills[0].lastCheckedVersion, "2.1");
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("getMarketplaceSkills migrates installed bundle directories and expands cached GitLab bundle manifests", async () => {
  const projectRoot = createTempDir("marketplace-bundle-migration-test-");
  const authCalls = [];
  const { service, restore } = loadMarketplaceService({
    gitlabMarketplaceAuthExports: {
      async getAuthorizedSession(options) {
        authCalls.push(options);
        return { accessToken: "gitlab-token" };
      },
    },
  });

  const legacyBundleDir = path.join(
    projectRoot,
    "skills-marketplace",
    "ejp-skills",
    "ejp-skills",
  );

  try {
    fs.mkdirSync(path.join(legacyBundleDir, "skills", "atleon"), { recursive: true });
    fs.mkdirSync(path.join(legacyBundleDir, "skills", "vavr"), { recursive: true });
    fs.writeFileSync(
      path.join(legacyBundleDir, "skills", "atleon", "SKILL.md"),
      createSkillMarkdown("1.2.3", "Atleon"),
    );
    fs.writeFileSync(
      path.join(legacyBundleDir, "skills", "vavr", "SKILL.md"),
      createSkillMarkdown("4.5.6", "Vavr"),
    );

    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [
        {
          id: "ejp-skills",
          name: "ejp-skills",
          source: {
            type: "gitlab",
            host: "example.invalid",
            projectPath: "nickw/ejp-skills",
            repoUrl: "https://example.invalid/nickw/ejp-skills.git",
            ref: "main",
          },
          cachedManifest: {
            name: "ejp-skills",
            metadata: {
              description: "Claude Code skills for reactive streams",
              version: "1.0.0",
            },
            plugins: [
              {
                name: "ejp-skills",
                description: "Portico Job Sync API and Atleon reactive streams",
                source: "./",
              },
            ],
          },
        },
      ],
      installedSkills: [
        {
          marketplaceId: "ejp-skills",
          skillId: "ejp-skills",
          skillPath: "./",
          installedAt: "2026-03-26T23:09:55.265Z",
          installedVersion: "1.0",
          localPath: "skills-marketplace/ejp-skills/ejp-skills",
          lastCheckedVersion: "1.0",
          hasUpdate: false,
        },
      ],
    });

    await withMockFetch(async (url, options) => {
      if (
        url ===
        "https://example.invalid/api/v4/projects/nickw%2Fejp-skills/repository/tree?ref=main&page=1&per_page=100&recursive=true"
      ) {
        assert.equal(options.headers.Authorization, "Bearer gitlab-token");
        return createJsonResponse([
          {
            id: "atleon-skill",
            name: "SKILL.md",
            path: "skills/atleon/SKILL.md",
            type: "blob",
            mode: "100644",
          },
          {
            id: "vavr-skill",
            name: "SKILL.md",
            path: "skills/vavr/SKILL.md",
            type: "blob",
            mode: "100644",
          },
        ]);
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, async () => {
      const result = await service.getMarketplaceSkills({
        projectRoot,
        marketplaceId: "ejp-skills",
        interactiveAuth: true,
      });

      assert.ok(authCalls.some((call) => call.interactive === true));
      assert.deepEqual(
        result.skills.map((skill) => skill.id).sort(),
        ["atleon", "vavr"],
      );
      assert.equal(
        result.skills.every((skill) => skill.installed === true),
        true,
      );
      assert.equal(
        result.skills.find((skill) => skill.id === "atleon").installedVersion,
        "1.2.3",
      );
      assert.equal(
        result.skills.find((skill) => skill.id === "vavr").installedVersion,
        "4.5.6",
      );

      const config = readJson(path.join(projectRoot, "marketplaces.json"));
      assert.deepEqual(
        config.marketplaces[0].cachedManifest.plugins[0].skills,
        ["./skills/atleon", "./skills/vavr"],
      );
      assert.deepEqual(
        config.installedSkills.map((skill) => skill.skillId).sort(),
        ["atleon", "vavr"],
      );
      assert.equal(fs.existsSync(legacyBundleDir), false);
      assert.equal(
        fs.existsSync(
          path.join(projectRoot, "skills-marketplace", "ejp-skills", "atleon", "SKILL.md"),
        ),
        true,
      );
      assert.equal(
        fs.existsSync(
          path.join(projectRoot, "skills-marketplace", "ejp-skills", "vavr", "SKILL.md"),
        ),
        true,
      );
    });
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("installMarketplaceSkill downloads GitLab skill files via repository tree and file APIs", async () => {
  const projectRoot = createTempDir("marketplace-install-test-");
  const authCalls = [];
  const { service, restore } = loadMarketplaceService({
    gitlabMarketplaceAuthExports: {
      async getAuthorizedSession(options) {
        authCalls.push(options);
        return { accessToken: "gitlab-token" };
      },
    },
  });

  try {
    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [
        {
          id: "trustkit",
          name: "trustkit",
          source: {
            type: "gitlab",
            host: "example.invalid",
            projectPath: "squall-mod/trust-kit",
            repoUrl: "https://example.invalid/squall-mod/trust-kit.git",
            ref: "main",
          },
          cachedManifest: {
            name: "trustkit",
            metadata: {
              description: "TrustKit",
              version: "0.1.0",
            },
            plugins: [
              {
                name: "trustkit",
                description: "Trust & Safety",
                skills: ["./.claude/skills/trustkit"],
              },
            ],
          },
        },
      ],
      installedSkills: [],
    });

    await withMockFetch(async (url, options) => {
      if (
        url ===
        "https://example.invalid/api/v4/projects/squall-mod%2Ftrust-kit/repository/tree?ref=main&page=1&per_page=100&recursive=true&path=.claude%2Fskills%2Ftrustkit"
      ) {
        assert.equal(options.headers.Authorization, "Bearer gitlab-token");
        return createJsonResponse([
          {
            id: "skill",
            name: "SKILL.md",
            path: ".claude/skills/trustkit/SKILL.md",
            type: "blob",
            mode: "100644",
          },
          {
            id: "helper",
            name: "case-context-builder.md",
            path: ".claude/skills/trustkit/case-context-builder.md",
            type: "blob",
            mode: "100644",
          },
        ]);
      }
      if (
        url ===
        "https://example.invalid/api/v4/projects/squall-mod%2Ftrust-kit/repository/files/.claude%2Fskills%2Ftrustkit%2FSKILL.md?ref=main"
      ) {
        return createJsonResponse(
          createBase64TextFilePayload(createSkillMarkdown("2.3.0", "TrustKit")),
        );
      }
      if (
        url ===
        "https://example.invalid/api/v4/projects/squall-mod%2Ftrust-kit/repository/files/.claude%2Fskills%2Ftrustkit%2Fcase-context-builder.md?ref=main"
      ) {
        return createJsonResponse(createBase64TextFilePayload("# helper"));
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, async () => {
      const result = await service.installMarketplaceSkill({
        projectRoot,
        marketplaceId: "trustkit",
        skillId: "trustkit",
        skillPath: "./.claude/skills/trustkit",
        skillSource: {
          type: "gitlab",
          host: "example.invalid",
          projectPath: "squall-mod/trust-kit",
        },
      });

      assert.equal(result.version, "2.3.0");
      assert.equal(result.display_name, "Trustkit");
      assert.ok(authCalls.some((call) => call.interactive === true));

      const installedDir = path.join(
        projectRoot,
        "skills-marketplace",
        "trustkit",
        "trustkit",
      );
      assert.match(
        fs.readFileSync(path.join(installedDir, "SKILL.md"), "utf8"),
        /version: 2\.3\.0/,
      );
      assert.match(
        fs.readFileSync(
          path.join(installedDir, "case-context-builder.md"),
          "utf8",
        ),
        /helper/,
      );

      const config = readJson(path.join(projectRoot, "marketplaces.json"));
      assert.deepEqual(config.installedSkills[0].skillSource, {
        type: "gitlab",
        host: "example.invalid",
        projectPath: "squall-mod/trust-kit",
        repoUrl: "https://example.invalid/squall-mod/trust-kit.git",
        ref: "main",
      });
    });
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("uninstallMarketplaceSkill removes the installed skill directory and config entry", async () => {
  const projectRoot = createTempDir("marketplace-uninstall-test-");
  const { service, restore } = loadMarketplaceService();
  const installedDir = path.join(
    projectRoot,
    "skills-marketplace",
    "trustkit",
    "trustkit",
  );

  try {
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(path.join(installedDir, "SKILL.md"), createSkillMarkdown("1.0.0"));

    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [
        {
          id: "trustkit",
          name: "trustkit",
          source: { type: "gitlab", host: "example.invalid", projectPath: "anthropics/skills" },
        },
      ],
      installedSkills: [
        {
          marketplaceId: "trustkit",
          skillId: "trustkit",
          installedVersion: "1.0.0",
          localPath: "skills-marketplace/trustkit/trustkit",
        },
      ],
    });

    const result = await service.uninstallMarketplaceSkill({
      projectRoot,
      marketplaceId: "trustkit",
      skillId: "trustkit",
    });

    assert.equal(result.marketplaceId, "trustkit");
    assert.equal(result.skillId, "trustkit");
    assert.equal(result.localPath, "skills-marketplace/trustkit/trustkit");

    const config = readJson(path.join(projectRoot, "marketplaces.json"));
    assert.deepEqual(config.installedSkills, []);
    assert.equal(fs.existsSync(installedDir), false);
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("detachMarketplaceSkillToUserSkill copies the installed skill into skills-user and removes the marketplace install", async () => {
  const projectRoot = createTempDir("marketplace-detach-test-");
  const { service, restore } = loadMarketplaceService();
  const installedDir = path.join(
    projectRoot,
    "skills-marketplace",
    "trustkit",
    "trustkit",
  );

  try {
    fs.mkdirSync(installedDir, { recursive: true });
    fs.mkdirSync(path.join(projectRoot, "skills-user", "trustkit"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(projectRoot, "skills-user", "trustkit", "SKILL.md"),
      createSkillMarkdown("0.5.0", "Existing User Skill"),
    );
    fs.writeFileSync(
      path.join(installedDir, "SKILL.md"),
      createSkillMarkdown("1.0.0", "TrustKit"),
    );
    fs.writeFileSync(path.join(installedDir, "helper.md"), "# helper");

    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [
        {
          id: "trustkit",
          name: "trustkit",
          source: {
            type: "gitlab",
            host: "example.invalid",
            projectPath: "anthropics/skills",
          },
        },
      ],
      installedSkills: [
        {
          marketplaceId: "trustkit",
          skillId: "trustkit",
          installedVersion: "1.0.0",
          localPath: "skills-marketplace/trustkit/trustkit",
          baseline: {
            version: "1.0.0",
            files: [
              {
                path: "SKILL.md",
                sha256: sha256(createSkillMarkdown("1.0.0", "TrustKit")),
              },
              {
                path: "helper.md",
                sha256: sha256("# helper"),
              },
            ],
          },
        },
      ],
    });

    const result = await service.detachMarketplaceSkillToUserSkill({
      projectRoot,
      marketplaceId: "trustkit",
      skillId: "trustkit",
      copyUserSkill: async ({ sourcePath, skillName }) => {
        const destinationPath = path.join(projectRoot, "skills-user", skillName);
        fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
        fs.cpSync(sourcePath, destinationPath, { recursive: true });
        return { destinationPath };
      },
    });

    assert.equal(result.skillName, "trustkit-detached");
    assert.equal(result.display_name, "Trustkit Detached");
    assert.equal(result.localPath, "skills-user/trustkit-detached");
    assert.equal(fs.existsSync(installedDir), false);
    assert.equal(
      fs.existsSync(path.join(projectRoot, "skills-user", "trustkit-detached", "SKILL.md")),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(projectRoot, "skills-user", "trustkit-detached", "helper.md")),
      true,
    );

    const config = readJson(path.join(projectRoot, "marketplaces.json"));
    assert.deepEqual(config.installedSkills, []);
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("detachMarketplaceSkillToUserSkill removes a fresh User copy when registry finalization fails", async () => {
  const projectRoot = createTempDir("marketplace-detach-rollback-test-");
  const { service, restore } = loadMarketplaceService();

  try {
    const installedDir = path.join(
      projectRoot,
      "skills-marketplace",
      "trustkit",
      "trustkit",
    );
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(
      path.join(installedDir, "SKILL.md"),
      createSkillMarkdown("1.0.0", "TrustKit"),
    );
    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [],
      installedSkills: [
        {
          marketplaceId: "trustkit",
          skillId: "trustkit",
          installedVersion: "1.0.0",
          localPath: "skills-marketplace/trustkit/trustkit",
        },
      ],
    });

    await assert.rejects(
      () =>
        service.detachMarketplaceSkillToUserSkill({
          projectRoot,
          marketplaceId: "trustkit",
          skillId: "trustkit",
          copyUserSkill: async ({ sourcePath, skillName }) => {
            const destinationPath = path.join(projectRoot, "skills-user", skillName);
            fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
            fs.cpSync(sourcePath, destinationPath, { recursive: true });
          },
          saveConfig: async () => {
            throw new Error("simulated registry failure");
          },
        }),
      /simulated registry failure/,
    );

    assert.equal(fs.existsSync(installedDir), true);
    assert.equal(
      fs.existsSync(path.join(projectRoot, "skills-user", "trustkit-detached")),
      false,
    );
    assert.equal(
      readJson(path.join(projectRoot, "marketplaces.json")).installedSkills.length,
      1,
    );
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

// Shared fixture for the OOTB-seeded removal guards: one seed-listed install
// (data-plat-skills/iql-query-writing, mirroring the shipped seeds), one
// user-added git-marketplace install, and one Solutions Marketplace install.
// The bundled seed manifest is the ONLY thing that marks a record as an OOTB
// default — the live registry carries no marker of its own.
function writeOotbGuardFixture(projectRoot) {
  const seededDir = path.join(
    projectRoot,
    "skills-marketplace",
    "data-plat-skills",
    "iql-query-writing",
  );
  const userAddedDir = path.join(projectRoot, "skills-marketplace", "trustkit", "trustkit");
  const solutionDir = path.join(
    projectRoot,
    "skills-marketplace",
    "ai-marketplace",
    "meeting-notes",
  );
  for (const skillDir of [seededDir, userAddedDir, solutionDir]) {
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), createSkillMarkdown("1.0"));
  }

  writeJson(path.join(projectRoot, "marketplaces-ootb.json"), {
    version: "1.0",
    marketplaces: [
      {
        id: "data-plat-skills",
        name: "data-plat-skills",
        source: { type: "gitlab", host: "example.invalid", projectPath: "data-plat/skills" },
        ootb: true,
      },
    ],
    installedSkills: [
      {
        marketplaceId: "data-plat-skills",
        skillId: "iql-query-writing",
        installedVersion: "1.0",
        localPath: "skills-marketplace/data-plat-skills/iql-query-writing",
      },
    ],
  });

  writeJson(path.join(projectRoot, "marketplaces.json"), {
    version: "1.0",
    marketplaces: [
      {
        id: "data-plat-skills",
        name: "data-plat-skills",
        source: { type: "gitlab", host: "example.invalid", projectPath: "data-plat/skills" },
        ootb: true,
      },
      {
        id: "trustkit",
        name: "trustkit",
        source: { type: "gitlab", host: "example.invalid", projectPath: "anthropics/skills" },
      },
    ],
    installedSkills: [
      {
        marketplaceId: "data-plat-skills",
        skillId: "iql-query-writing",
        installedVersion: "1.0",
        localPath: "skills-marketplace/data-plat-skills/iql-query-writing",
      },
      {
        marketplaceId: "trustkit",
        skillId: "trustkit",
        installedVersion: "1.0",
        localPath: "skills-marketplace/trustkit/trustkit",
      },
      {
        marketplaceId: "ai-marketplace",
        skillId: "meeting-notes",
        installedVersion: "1.0",
        localPath: "skills-marketplace/ai-marketplace/meeting-notes",
        skillSource: { type: "ai-marketplace-solution", solutionId: "sol-123" },
      },
    ],
  });

  return { seededDir, userAddedDir, solutionDir };
}

test("uninstallMarketplaceSkill fails closed on OOTB-seeded installs and still removes user-added and solutions installs", async () => {
  const projectRoot = createTempDir("marketplace-uninstall-ootb-guard-test-");
  const { service, restore } = loadMarketplaceService();

  try {
    const { seededDir, userAddedDir, solutionDir } = writeOotbGuardFixture(projectRoot);
    // Let the one-shot load-time migrations (version refresh etc.) settle the
    // registry first; the byte-untouched assertion below is about the
    // REJECTED operation, which must never write.
    await service.loadMarketplacesConfig(projectRoot);
    const registryBefore = fs.readFileSync(
      path.join(projectRoot, "marketplaces.json"),
      "utf8",
    );

    await assert.rejects(
      service.uninstallMarketplaceSkill({
        projectRoot,
        marketplaceId: "data-plat-skills",
        skillId: "iql-query-writing",
      }),
      (error) => {
        assert.equal(error.code, "ootb_skill_immutable");
        assert.match(error.message, /cannot be uninstalled/);
        assert.match(error.message, /copy_skill/);
        assert.match(String(error.remediation), /copy_skill/);
        return true;
      },
    );

    // Fails BEFORE any mutation: registry bytes and payload directory are untouched.
    assert.equal(
      fs.readFileSync(path.join(projectRoot, "marketplaces.json"), "utf8"),
      registryBefore,
    );
    assert.equal(fs.existsSync(path.join(seededDir, "SKILL.md")), true);

    // Non-seeded installs keep uninstalling: a user-added git marketplace…
    const userAddedResult = await service.uninstallMarketplaceSkill({
      projectRoot,
      marketplaceId: "trustkit",
      skillId: "trustkit",
    });
    assert.equal(userAddedResult.skillId, "trustkit");
    assert.equal(fs.existsSync(userAddedDir), false);

    // …and a Solutions Marketplace install.
    const solutionResult = await service.uninstallMarketplaceSkill({
      projectRoot,
      marketplaceId: "ai-marketplace",
      skillId: "meeting-notes",
    });
    assert.equal(solutionResult.skillId, "meeting-notes");
    assert.equal(fs.existsSync(solutionDir), false);

    const config = readJson(path.join(projectRoot, "marketplaces.json"));
    assert.deepEqual(
      config.installedSkills.map((entry) => `${entry.marketplaceId}/${entry.skillId}`),
      ["data-plat-skills/iql-query-writing"],
    );
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("detachMarketplaceSkillToUserSkill fails closed on OOTB-seeded installs without creating a user copy", async () => {
  const projectRoot = createTempDir("marketplace-detach-ootb-guard-test-");
  const { service, restore } = loadMarketplaceService();

  try {
    const { seededDir, userAddedDir, solutionDir } = writeOotbGuardFixture(projectRoot);
    // Same steady-state warm-up as the uninstall guard test: the rejected
    // detach must not write, but load-time migrations legitimately may.
    await service.loadMarketplacesConfig(projectRoot);
    const registryBefore = fs.readFileSync(
      path.join(projectRoot, "marketplaces.json"),
      "utf8",
    );
    const copyCalls = [];
    const copyUserSkill = async ({ sourcePath, skillName }) => {
      copyCalls.push(skillName);
      const destinationPath = path.join(projectRoot, "skills-user", skillName);
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.cpSync(sourcePath, destinationPath, { recursive: true });
      return { destinationPath };
    };

    await assert.rejects(
      service.detachMarketplaceSkillToUserSkill({
        projectRoot,
        marketplaceId: "data-plat-skills",
        skillId: "iql-query-writing",
        copyUserSkill,
      }),
      (error) => {
        assert.equal(error.code, "ootb_skill_immutable");
        assert.match(error.message, /cannot be converted to a user skill/);
        assert.match(error.message, /copy_skill/);
        assert.match(String(error.remediation), /copy_skill/);
        return true;
      },
    );

    // No user copy is created and nothing mutates: the silent-duplicate
    // hazard (user copy + resurrected marketplace copy) never materializes.
    assert.deepEqual(copyCalls, []);
    assert.equal(fs.existsSync(path.join(projectRoot, "skills-user")), false);
    assert.equal(
      fs.readFileSync(path.join(projectRoot, "marketplaces.json"), "utf8"),
      registryBefore,
    );
    assert.equal(fs.existsSync(path.join(seededDir, "SKILL.md")), true);

    // Non-seeded installs keep detaching: a user-added git marketplace…
    const userAddedResult = await service.detachMarketplaceSkillToUserSkill({
      projectRoot,
      marketplaceId: "trustkit",
      skillId: "trustkit",
      copyUserSkill,
    });
    assert.equal(userAddedResult.skillName, "trustkit");
    assert.equal(
      fs.existsSync(path.join(projectRoot, "skills-user", "trustkit", "SKILL.md")),
      true,
    );
    assert.equal(fs.existsSync(userAddedDir), false);

    // …and a Solutions Marketplace install.
    const solutionResult = await service.detachMarketplaceSkillToUserSkill({
      projectRoot,
      marketplaceId: "ai-marketplace",
      skillId: "meeting-notes",
      copyUserSkill,
    });
    assert.equal(solutionResult.skillName, "meeting-notes");
    assert.equal(
      fs.existsSync(path.join(projectRoot, "skills-user", "meeting-notes", "SKILL.md")),
      true,
    );
    assert.equal(fs.existsSync(solutionDir), false);

    const config = readJson(path.join(projectRoot, "marketplaces.json"));
    assert.deepEqual(
      config.installedSkills.map((entry) => `${entry.marketplaceId}/${entry.skillId}`),
      ["data-plat-skills/iql-query-writing"],
    );
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("checkSkillUpdates flags newer remote versions and clears stale hasUpdate flags", async () => {
  const projectRoot = createTempDir("marketplace-updates-test-");
  const { service, restore } = loadMarketplaceService();

  try {
    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [
        {
          id: "anthropic-agent-skills",
          name: "anthropic-agent-skills",
          source: {
            type: "github",
            repo: "anthropics/skills",
            repoUrl: "https://github.com/anthropics/skills",
            ref: "main",
          },
        },
      ],
      installedSkills: [
        {
          marketplaceId: "anthropic-agent-skills",
          skillId: "pdf",
          skillPath: "./skills/pdf",
          installedVersion: "1.0.0",
          localPath: "skills-marketplace/anthropic-agent-skills/pdf",
          hasUpdate: false,
        },
        {
          marketplaceId: "anthropic-agent-skills",
          skillId: "docx",
          skillPath: "./skills/docx",
          installedVersion: "2.0.0",
          localPath: "skills-marketplace/anthropic-agent-skills/docx",
          hasUpdate: true,
        },
      ],
    });

    await withMockFetch(async (url) => {
      if (url === "https://api.github.com/repos/anthropics/skills") {
        return createJsonResponse({ default_branch: "main" });
      }
      if (
        url ===
        "https://api.github.com/repos/anthropics/skills/contents/skills/pdf/SKILL.md?ref=main"
      ) {
        return createJsonResponse(
          createBase64TextFilePayload(createSkillMarkdown("2.0.0", "PDF")),
        );
      }
      if (
        url ===
        "https://api.github.com/repos/anthropics/skills/contents/skills/docx/SKILL.md?ref=main"
      ) {
        return createJsonResponse(
          createBase64TextFilePayload(createSkillMarkdown("2.0.0", "DOCX")),
        );
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, async () => {
      const result = await service.checkSkillUpdates({ projectRoot });

      assert.equal(result.hasUpdates, true);
      assert.deepEqual(result.updates, [
        {
          skillId: "pdf",
          marketplaceId: "anthropic-agent-skills",
          installedVersion: "1.0.0",
          remoteVersion: "2.0.0",
          // Single-record group: no head-sha probe ran, so no commit date.
          headCommittedAt: null,
        },
      ]);

      const config = readJson(path.join(projectRoot, "marketplaces.json"));
      const pdf = config.installedSkills.find((skill) => skill.skillId === "pdf");
      const docx = config.installedSkills.find((skill) => skill.skillId === "docx");
      assert.equal(pdf.hasUpdate, true);
      assert.equal(pdf.lastCheckedVersion, "2.0.0");
      assert.equal(docx.hasUpdate, false);
      assert.equal(docx.lastCheckedVersion, "2.0.0");
    });
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

// The live backend's field is updated_timestamp (updated_at is the legacy
// fixture-era name kept as a fallback — reading only the legacy name is the
// 2026-08-04 bug that silently disabled update detection). One listing here
// uses each name so BOTH paths stay pinned.
test("checkSkillUpdates compares solutions installs by listing updated_timestamp (legacy updated_at accepted) and backfills baselines", async () => {
  const projectRoot = createTempDir("marketplace-solutions-updates-test-");
  const { service, restore } = loadMarketplaceService();

  try {
    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [],
      installedSkills: [
        {
          marketplaceId: "ai-marketplace",
          skillId: "code-execution",
          skillPath: "./",
          installedVersion: "1.0",
          localPath: "skills-marketplace/ai-marketplace/code-execution",
          hasUpdate: false,
          remoteUpdatedAt: "2026-07-01T00:00:00Z",
          skillSource: { type: "ai-marketplace-solution", solutionId: "sol-code" },
        },
        {
          marketplaceId: "ai-marketplace",
          skillId: "company-knowledge",
          skillPath: "./",
          installedVersion: "1.0",
          localPath: "skills-marketplace/ai-marketplace/company-knowledge",
          hasUpdate: false,
          // No baseline: legacy install — backfilled silently, never flagged.
          skillSource: { type: "ai-marketplace-solution", solutionId: "sol-know" },
        },
      ],
    });

    const fetched = [];
    const result = await service.checkSkillUpdates({
      projectRoot,
      fetchSolution: async (solutionId) => {
        fetched.push(solutionId);
        return solutionId === "sol-code"
          ? { id: solutionId, updated_timestamp: "2026-07-28T01:00:00Z" }
          : { id: solutionId, updated_at: "2026-07-27T00:00:00Z" };
      },
    });

    assert.equal(result.hasUpdates, true);
    assert.deepEqual(result.updates, [
      {
        skillId: "code-execution",
        marketplaceId: "ai-marketplace",
        installedVersion: "1.0",
        remoteVersion: "2026-07-28T01:00:00Z",
      },
    ]);
    assert.deepEqual(fetched.sort(), ["sol-code", "sol-know"]);

    const config = readJson(path.join(projectRoot, "marketplaces.json"));
    const code = config.installedSkills.find((s) => s.skillId === "code-execution");
    const knowledge = config.installedSkills.find(
      (s) => s.skillId === "company-knowledge",
    );
    assert.equal(code.hasUpdate, true);
    assert.equal(knowledge.hasUpdate, false);
    assert.equal(knowledge.remoteUpdatedAt, "2026-07-27T00:00:00Z");
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

// ---- checkSkillUpdates sweep optimizations (batched search, sha short-circuit,
// bounded parallelism, conditional save) ------------------------------------

function gitlabFreshnessFixture({ shas = undefined, records, marketplaces }) {
  const config = {
    version: "1.0",
    marketplaces,
    installedSkills: records,
  };
  if (shas) config.skillFreshnessShas = shas;
  return config;
}

const TRUSTKIT_MARKETPLACE = {
  id: "trustkit",
  name: "trustkit",
  source: {
    type: "gitlab",
    host: "example.invalid",
    projectPath: "squall-mod/trust-kit",
    repoUrl: "https://example.invalid/squall-mod/trust-kit.git",
    ref: "main",
  },
};
const TRUSTKIT_GROUP_KEY = "gitlab:example.invalid/squall-mod/trust-kit@main";

function trustkitRecord(skillId, overrides = {}) {
  return {
    marketplaceId: "trustkit",
    skillId,
    skillPath: `./skills/${skillId}`,
    installedVersion: "1.0.0",
    localPath: `skills-marketplace/trustkit/${skillId}`,
    hasUpdate: false,
    ...overrides,
  };
}

test("checkSkillUpdates resolves solutions installs with one search and per-id fallback only for missing ids", async () => {
  const projectRoot = createTempDir("marketplace-solutions-batch-test-");
  const { service, restore } = loadMarketplaceService();

  try {
    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [],
      installedSkills: [
        {
          marketplaceId: "ai-marketplace",
          skillId: "alpha",
          skillPath: "./",
          installedVersion: "1.0",
          localPath: "skills-marketplace/ai-marketplace/alpha",
          hasUpdate: false,
          remoteUpdatedAt: "2026-07-01T00:00:00Z",
          skillSource: { type: "ai-marketplace-solution", solutionId: "sol-a" },
        },
        {
          marketplaceId: "ai-marketplace",
          skillId: "beta",
          skillPath: "./",
          installedVersion: "1.0",
          localPath: "skills-marketplace/ai-marketplace/beta",
          hasUpdate: true,
          remoteUpdatedAt: "2026-07-20T00:00:00Z",
          skillSource: { type: "ai-marketplace-solution", solutionId: "sol-b" },
        },
        {
          marketplaceId: "ai-marketplace",
          skillId: "gamma",
          skillPath: "./",
          installedVersion: "1.0",
          localPath: "skills-marketplace/ai-marketplace/gamma",
          hasUpdate: false,
          // No baseline: backfilled from the fallback read, never flagged.
          skillSource: { type: "ai-marketplace-solution", solutionId: "sol-c" },
        },
      ],
    });

    const searchCalls = [];
    const fallbackFetched = [];
    const result = await service.checkSkillUpdates({
      projectRoot,
      searchSolutions: async (params) => {
        searchCalls.push(params);
        return {
          results: [
            { id: "sol-a", updated_at: "2026-07-28T01:00:00Z" },
            { id: "sol-b", updated_at: "2026-07-20T00:00:00Z" },
            { id: "sol-unrelated", updated_at: "2026-07-29T00:00:00Z" },
          ],
        };
      },
      fetchSolution: async (solutionId) => {
        fallbackFetched.push(solutionId);
        return { id: solutionId, updated_at: "2026-07-27T00:00:00Z" };
      },
    });

    assert.equal(searchCalls.length, 1, "one batched search covers the fleet");
    assert.deepEqual(searchCalls[0].filters, { type: ["skills"] });
    assert.deepEqual(
      fallbackFetched,
      ["sol-c"],
      "per-id fallback runs only for ids the search page missed",
    );
    assert.deepEqual(result.updates, [
      {
        skillId: "alpha",
        marketplaceId: "ai-marketplace",
        installedVersion: "1.0",
        remoteVersion: "2026-07-28T01:00:00Z",
      },
    ]);

    const config = readJson(path.join(projectRoot, "marketplaces.json"));
    const bySkill = (id) => config.installedSkills.find((s) => s.skillId === id);
    assert.equal(bySkill("alpha").hasUpdate, true);
    assert.equal(bySkill("beta").hasUpdate, false, "stale flag clears");
    assert.equal(bySkill("gamma").hasUpdate, false);
    assert.equal(
      bySkill("gamma").remoteUpdatedAt,
      "2026-07-27T00:00:00Z",
      "missing baseline backfills from the fallback read",
    );
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("checkSkillUpdates skips every per-skill fetch and the config write when a repo's head sha is unchanged", async () => {
  const projectRoot = createTempDir("marketplace-sha-skip-test-");
  const { service, restore } = loadMarketplaceService({
    gitlabMarketplaceAuthExports: {
      async getAuthorizedSession() {
        return { accessToken: "gitlab-token" };
      },
    },
  });
  const configPath = path.join(projectRoot, "marketplaces.json");

  try {
    writeJson(
      configPath,
      gitlabFreshnessFixture({
        shas: { [TRUSTKIT_GROUP_KEY]: "sha-1" },
        marketplaces: [TRUSTKIT_MARKETPLACE],
        records: [
          trustkitRecord("alpha", { hasUpdate: true, lastCheckedVersion: "2.0.0" }),
          trustkitRecord("beta", { lastCheckedVersion: "1.0.0" }),
        ],
      }),
    );
    const fileBefore = fs.readFileSync(configPath, "utf8");
    const mtimeBefore = fs.statSync(configPath).mtimeMs;

    const fetchedUrls = [];
    await withMockFetch(async (url, options) => {
      fetchedUrls.push(url);
      if (
        url ===
        "https://example.invalid/api/v4/projects/squall-mod%2Ftrust-kit/repository/commits/main"
      ) {
        assert.equal(options.headers.Authorization, "Bearer gitlab-token");
        return createJsonResponse({ id: "sha-1" });
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, async () => {
      const result = await service.checkSkillUpdates({ projectRoot });
      assert.equal(result.hasUpdates, false);
    });

    assert.equal(
      fetchedUrls.filter((url) => url.includes("/repository/files/")).length,
      0,
      "an unchanged repo proves its SKILL.mds unchanged — zero file fetches",
    );
    assert.equal(fetchedUrls.length, 1, "exactly one head-sha probe");
    assert.equal(
      fs.readFileSync(configPath, "utf8"),
      fileBefore,
      "a no-op sweep never rewrites marketplaces.json",
    );
    assert.equal(fs.statSync(configPath).mtimeMs, mtimeBefore);
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("checkSkillUpdates refetches only moved repos, bounded to 4 concurrent fetches", async () => {
  const projectRoot = createTempDir("marketplace-sha-moved-test-");
  const { service, restore } = loadMarketplaceService({
    gitlabMarketplaceAuthExports: {
      async getAuthorizedSession() {
        return { accessToken: "gitlab-token" };
      },
    },
  });
  const STABLE_MARKETPLACE = {
    id: "stablekit",
    name: "stablekit",
    source: {
      type: "gitlab",
      host: "example.invalid",
      projectPath: "squall-mod/stable-kit",
      repoUrl: "https://example.invalid/squall-mod/stable-kit.git",
      ref: "main",
    },
  };
  const STABLE_GROUP_KEY = "gitlab:example.invalid/squall-mod/stable-kit@main";
  const movedSkillIds = ["a1", "a2", "a3", "a4", "a5", "a6"];

  try {
    writeJson(
      path.join(projectRoot, "marketplaces.json"),
      gitlabFreshnessFixture({
        shas: {
          [TRUSTKIT_GROUP_KEY]: "old-sha",
          [STABLE_GROUP_KEY]: "stable-sha",
        },
        marketplaces: [TRUSTKIT_MARKETPLACE, STABLE_MARKETPLACE],
        records: [
          ...movedSkillIds.map((id) => trustkitRecord(id)),
          {
            marketplaceId: "stablekit",
            skillId: "s1",
            skillPath: "./skills/s1",
            installedVersion: "1.0.0",
            localPath: "skills-marketplace/stablekit/s1",
            hasUpdate: false,
          },
          {
            marketplaceId: "stablekit",
            skillId: "s2",
            skillPath: "./skills/s2",
            installedVersion: "1.0.0",
            localPath: "skills-marketplace/stablekit/s2",
            hasUpdate: false,
          },
        ],
      }),
    );

    const fetchedFiles = [];
    let inFlight = 0;
    let maxInFlight = 0;
    await withMockFetch(async (url) => {
      if (url.includes("/squall-mod%2Ftrust-kit/repository/commits/main")) {
        return createJsonResponse({
          id: "new-sha",
          committed_date: "2026-08-01T00:00:00Z",
        });
      }
      if (url.includes("/squall-mod%2Fstable-kit/repository/commits/main")) {
        return createJsonResponse({ id: "stable-sha" });
      }
      if (url.includes("/repository/files/")) {
        fetchedFiles.push(url);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return createJsonResponse(
          createBase64TextFilePayload(createSkillMarkdown("2.0.0")),
        );
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, async () => {
      const result = await service.checkSkillUpdates({ projectRoot });
      assert.equal(result.updates.length, movedSkillIds.length);
      // Git update entries carry the moved repo's head-commit date (the
      // Updates tab renders "days behind" for git marketplaces from it).
      assert.ok(
        result.updates.every(
          (entry) => entry.headCommittedAt === "2026-08-01T00:00:00Z",
        ),
        "every trustkit entry carries the probed head-commit date",
      );
    });

    assert.equal(
      fetchedFiles.length,
      movedSkillIds.length,
      "only the moved repo's SKILL.mds are fetched",
    );
    assert.ok(
      fetchedFiles.every((url) => url.includes("squall-mod%2Ftrust-kit")),
      "the unchanged repo contributes zero file fetches",
    );
    assert.ok(maxInFlight <= 4, `fetch fan-out is bounded (saw ${maxInFlight})`);
    assert.ok(maxInFlight >= 2, "fetches actually run in parallel");

    const config = readJson(path.join(projectRoot, "marketplaces.json"));
    assert.equal(config.skillFreshnessShas[TRUSTKIT_GROUP_KEY], "new-sha");
    assert.equal(config.skillFreshnessShas[STABLE_GROUP_KEY], "stable-sha");
    assert.ok(
      config.installedSkills
        .filter((s) => s.marketplaceId === "trustkit")
        .every((s) => s.hasUpdate === true && s.lastCheckedVersion === "2.0.0"),
    );
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("checkSkillUpdates reports solutions updates before git updates in one mixed sweep", async () => {
  const projectRoot = createTempDir("marketplace-mixed-order-test-");
  const { service, restore } = loadMarketplaceService({
    gitlabMarketplaceAuthExports: {
      async getAuthorizedSession() {
        return { accessToken: "gitlab-token" };
      },
    },
  });

  try {
    writeJson(
      path.join(projectRoot, "marketplaces.json"),
      gitlabFreshnessFixture({
        marketplaces: [TRUSTKIT_MARKETPLACE],
        records: [
          // A single-record repo skips the sha probe and fetches directly.
          trustkitRecord("zulu"),
          {
            marketplaceId: "ai-marketplace",
            skillId: "alpha",
            skillPath: "./",
            installedVersion: "1.0",
            localPath: "skills-marketplace/ai-marketplace/alpha",
            hasUpdate: false,
            remoteUpdatedAt: "2026-07-01T00:00:00Z",
            skillSource: { type: "ai-marketplace-solution", solutionId: "sol-a" },
          },
        ],
      }),
    );

    await withMockFetch(async (url) => {
      if (url.includes("/repository/files/")) {
        return createJsonResponse(
          createBase64TextFilePayload(createSkillMarkdown("2.0.0")),
        );
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, async () => {
      const result = await service.checkSkillUpdates({
        projectRoot,
        searchSolutions: async () => ({
          results: [{ id: "sol-a", updated_at: "2026-07-28T01:00:00Z" }],
        }),
        fetchSolution: async (solutionId) => ({ id: solutionId }),
      });

      // Both legs found an update; the report keeps the historical
      // solutions-then-git order even though the legs now run concurrently.
      assert.deepEqual(result.updates, [
        {
          skillId: "alpha",
          marketplaceId: "ai-marketplace",
          installedVersion: "1.0",
          remoteVersion: "2026-07-28T01:00:00Z",
        },
        {
          skillId: "zulu",
          marketplaceId: "trustkit",
          installedVersion: "1.0.0",
          remoteVersion: "2.0.0",
          headCommittedAt: null,
        },
      ]);
    });
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("checkSkillUpdates keeps the persisted sha-baseline byte-stable when probes finish out of order", async () => {
  const projectRoot = createTempDir("marketplace-sha-order-test-");
  const { service, restore } = loadMarketplaceService({
    gitlabMarketplaceAuthExports: {
      async getAuthorizedSession() {
        return { accessToken: "gitlab-token" };
      },
    },
  });
  const STABLE_MARKETPLACE = {
    id: "stablekit",
    name: "stablekit",
    source: {
      type: "gitlab",
      host: "example.invalid",
      projectPath: "squall-mod/stable-kit",
      repoUrl: "https://example.invalid/squall-mod/stable-kit.git",
      ref: "main",
    },
  };
  const STABLE_GROUP_KEY = "gitlab:example.invalid/squall-mod/stable-kit@main";
  const configPath = path.join(projectRoot, "marketplaces.json");

  try {
    writeJson(
      configPath,
      gitlabFreshnessFixture({
        shas: {
          [TRUSTKIT_GROUP_KEY]: "sha-1",
          [STABLE_GROUP_KEY]: "stable-sha",
        },
        marketplaces: [TRUSTKIT_MARKETPLACE, STABLE_MARKETPLACE],
        records: [
          trustkitRecord("alpha"),
          trustkitRecord("beta"),
          {
            marketplaceId: "stablekit",
            skillId: "s1",
            skillPath: "./skills/s1",
            installedVersion: "1.0.0",
            localPath: "skills-marketplace/stablekit/s1",
            hasUpdate: false,
          },
          {
            marketplaceId: "stablekit",
            skillId: "s2",
            skillPath: "./skills/s2",
            installedVersion: "1.0.0",
            localPath: "skills-marketplace/stablekit/s2",
            hasUpdate: false,
          },
        ],
      }),
    );
    const fileBefore = fs.readFileSync(configPath, "utf8");
    const mtimeBefore = fs.statSync(configPath).mtimeMs;

    const probeUrls = [];
    await withMockFetch(async (url) => {
      if (url.includes("/squall-mod%2Ftrust-kit/repository/commits/main")) {
        probeUrls.push(url);
        // First group answers LAST: a completion-order nextShas would flip
        // the persisted key order and fake a config change.
        await new Promise((resolve) => setTimeout(resolve, 25));
        return createJsonResponse({ id: "sha-1" });
      }
      if (url.includes("/squall-mod%2Fstable-kit/repository/commits/main")) {
        probeUrls.push(url);
        return createJsonResponse({ id: "stable-sha" });
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, async () => {
      const result = await service.checkSkillUpdates({ projectRoot });
      assert.equal(result.hasUpdates, false);
    });

    assert.equal(probeUrls.length, 2, "exactly one probe per repo group");
    assert.equal(
      fs.readFileSync(configPath, "utf8"),
      fileBefore,
      "unchanged repos leave marketplaces.json byte-identical regardless of probe completion order",
    );
    assert.equal(fs.statSync(configPath).mtimeMs, mtimeBefore);
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("checkSkillUpdates runs the solutions and git legs concurrently", async () => {
  const projectRoot = createTempDir("marketplace-concurrent-legs-test-");
  const { service, restore } = loadMarketplaceService({
    gitlabMarketplaceAuthExports: {
      async getAuthorizedSession() {
        return { accessToken: "gitlab-token" };
      },
    },
  });

  try {
    writeJson(
      path.join(projectRoot, "marketplaces.json"),
      gitlabFreshnessFixture({
        shas: { [TRUSTKIT_GROUP_KEY]: "sha-1" },
        marketplaces: [TRUSTKIT_MARKETPLACE],
        records: [
          trustkitRecord("alpha"),
          trustkitRecord("beta"),
          {
            marketplaceId: "ai-marketplace",
            skillId: "gamma",
            skillPath: "./",
            installedVersion: "1.0",
            localPath: "skills-marketplace/ai-marketplace/gamma",
            hasUpdate: false,
            remoteUpdatedAt: "2026-07-01T00:00:00Z",
            skillSource: { type: "ai-marketplace-solution", solutionId: "sol-g" },
          },
        ],
      }),
    );

    // The solutions search resolves only after the git head-sha probe has
    // been SERVED. The old serial sweep (search fully awaited before any
    // probe) deadlocks here and falls into the empty timeout result, which
    // the update assertion below then rejects.
    const events = [];
    let resolveSearchGate;
    const searchGate = new Promise((resolve) => {
      resolveSearchGate = resolve;
    });
    let fallbackTimer;

    await withMockFetch(async (url) => {
      if (url.includes("/squall-mod%2Ftrust-kit/repository/commits/main")) {
        events.push("probe:served");
        resolveSearchGate({
          results: [{ id: "sol-g", updated_at: "2026-07-28T01:00:00Z" }],
        });
        return createJsonResponse({ id: "sha-1" });
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, async () => {
      const result = await service.checkSkillUpdates({
        projectRoot,
        searchSolutions: async () => {
          events.push("search:start");
          const payload = await Promise.race([
            searchGate,
            new Promise((resolve) => {
              fallbackTimer = setTimeout(() => resolve(null), 2000);
            }),
          ]);
          clearTimeout(fallbackTimer);
          events.push("search:resolved");
          return payload || { results: [] };
        },
        fetchSolution: async (solutionId) => ({ id: solutionId }),
      });

      assert.ok(
        events.indexOf("probe:served") < events.indexOf("search:resolved"),
        `git probe must be in flight while the search awaits (saw ${events.join(" → ")})`,
      );
      assert.deepEqual(result.updates, [
        {
          skillId: "gamma",
          marketplaceId: "ai-marketplace",
          installedVersion: "1.0",
          remoteVersion: "2026-07-28T01:00:00Z",
        },
      ]);
    });
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("checkSkillUpdates falls back to per-skill fetches when the sha probe fails, without stamping a baseline", async () => {
  const projectRoot = createTempDir("marketplace-sha-fail-test-");
  const { service, restore } = loadMarketplaceService({
    gitlabMarketplaceAuthExports: {
      async getAuthorizedSession() {
        return { accessToken: "gitlab-token" };
      },
    },
  });

  try {
    writeJson(
      path.join(projectRoot, "marketplaces.json"),
      gitlabFreshnessFixture({
        marketplaces: [TRUSTKIT_MARKETPLACE],
        records: [trustkitRecord("alpha"), trustkitRecord("beta")],
      }),
    );

    const fetchedFiles = [];
    await withMockFetch(async (url) => {
      if (url.includes("/repository/commits/")) {
        return createJsonResponse({ message: "boom" }, 500);
      }
      if (url.includes("/repository/files/")) {
        fetchedFiles.push(url);
        return createJsonResponse(
          createBase64TextFilePayload(createSkillMarkdown("3.0.0")),
        );
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, async () => {
      const result = await service.checkSkillUpdates({ projectRoot });
      assert.equal(result.updates.length, 2, "the repo still gets checked per skill");
    });

    assert.equal(fetchedFiles.length, 2);
    const config = readJson(path.join(projectRoot, "marketplaces.json"));
    assert.equal(
      config.skillFreshnessShas,
      undefined,
      "a failed probe never stamps a baseline — the next run retries",
    );
    assert.ok(
      config.installedSkills.every(
        (s) => s.hasUpdate === true && s.lastCheckedVersion === "3.0.0",
      ),
    );
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("checkSkillUpdates produces identical outcomes with and without the sha fast path", async () => {
  const { service, restore } = loadMarketplaceService();
  const fixture = {
    version: "1.0",
    marketplaces: [
      {
        id: "anthropic-agent-skills",
        name: "anthropic-agent-skills",
        source: {
          type: "github",
          repo: "anthropics/skills",
          repoUrl: "https://github.com/anthropics/skills",
          ref: "main",
        },
      },
    ],
    installedSkills: [
      {
        marketplaceId: "anthropic-agent-skills",
        skillId: "pdf",
        skillPath: "./skills/pdf",
        installedVersion: "1.0.0",
        localPath: "skills-marketplace/anthropic-agent-skills/pdf",
        hasUpdate: false,
      },
      {
        marketplaceId: "anthropic-agent-skills",
        skillId: "docx",
        skillPath: "./skills/docx",
        installedVersion: "2.0.0",
        localPath: "skills-marketplace/anthropic-agent-skills/docx",
        hasUpdate: true,
      },
    ],
  };
  const fileMocks = (url) => {
    if (url === "https://api.github.com/repos/anthropics/skills") {
      return createJsonResponse({ default_branch: "main" });
    }
    if (
      url ===
      "https://api.github.com/repos/anthropics/skills/contents/skills/pdf/SKILL.md?ref=main"
    ) {
      return createJsonResponse(
        createBase64TextFilePayload(createSkillMarkdown("2.0.0", "PDF")),
      );
    }
    if (
      url ===
      "https://api.github.com/repos/anthropics/skills/contents/skills/docx/SKILL.md?ref=main"
    ) {
      return createJsonResponse(
        createBase64TextFilePayload(createSkillMarkdown("2.0.0", "DOCX")),
      );
    }
    return createJsonResponse({ message: "Not Found" }, 404);
  };

  const runSweep = async (commitsResponder) => {
    const projectRoot = createTempDir("marketplace-sha-parity-test-");
    try {
      writeJson(path.join(projectRoot, "marketplaces.json"), fixture);
      const result = await withMockFetch(async (url) => {
        if (url === "https://api.github.com/repos/anthropics/skills/commits/main") {
          return commitsResponder();
        }
        return fileMocks(url);
      }, () => service.checkSkillUpdates({ projectRoot }));
      const config = readJson(path.join(projectRoot, "marketplaces.json"));
      return {
        updates: result.updates,
        records: config.installedSkills.map(
          ({ skillId, hasUpdate, lastCheckedVersion }) => ({
            skillId,
            hasUpdate,
            lastCheckedVersion,
          }),
        ),
        shas: config.skillFreshnessShas,
      };
    } finally {
      cleanupDir(projectRoot);
    }
  };

  try {
    // Probe unavailable (legacy behavior) vs probe live (grouped recompute).
    const legacy = await runSweep(() =>
      createJsonResponse({ message: "Not Found" }, 404),
    );
    const grouped = await runSweep(() => createJsonResponse({ sha: "fresh-sha" }));

    assert.deepEqual(grouped.updates, legacy.updates);
    assert.deepEqual(grouped.records, legacy.records);
    assert.equal(legacy.shas, undefined);
    assert.deepEqual(grouped.shas, {
      "github:anthropics/skills@main": "fresh-sha",
    });
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Content-based git update detection: changed-paths compare between the
// per-record contentHeadSha baseline and the probed head, with the legacy
// version compare surviving only as the fallback. Nobody bumps SKILL.md
// version fields in practice, so flags must come from real content drift.
// ---------------------------------------------------------------------------

const TRUSTKIT_API = "https://example.invalid/api/v4/projects/squall-mod%2Ftrust-kit";

function gitlabAuthStub() {
  return {
    gitlabMarketplaceAuthExports: {
      async getAuthorizedSession() {
        return { accessToken: "gitlab-token" };
      },
    },
  };
}

test("checkSkillUpdates flags only skills whose directories changed and advances untouched baselines", async () => {
  const projectRoot = createTempDir("marketplace-content-compare-test-");
  const { service, restore } = loadMarketplaceService(gitlabAuthStub());
  const configPath = path.join(projectRoot, "marketplaces.json");

  try {
    writeJson(
      configPath,
      gitlabFreshnessFixture({
        shas: { [TRUSTKIT_GROUP_KEY]: "old-sweep-sha" },
        marketplaces: [TRUSTKIT_MARKETPLACE],
        records: [
          trustkitRecord("alpha", { installedVersion: "1.0.0", contentHeadSha: "base-sha" }),
          trustkitRecord("beta", { installedVersion: "1.0.0", contentHeadSha: "base-sha" }),
        ],
      }),
    );

    const fetchedUrls = [];
    await withMockFetch(async (url) => {
      fetchedUrls.push(url);
      if (url === `${TRUSTKIT_API}/repository/commits/main`) {
        return createJsonResponse({ id: "head-sha", committed_date: "2026-08-01T00:00:00Z" });
      }
      if (
        url ===
        `${TRUSTKIT_API}/repository/compare?from=base-sha&to=head-sha&straight=true`
      ) {
        return createJsonResponse({
          compare_timeout: false,
          diffs: [{ old_path: "skills/alpha/SKILL.md", new_path: "skills/alpha/SKILL.md" }],
        });
      }
      if (url === `${TRUSTKIT_API}/repository/files/skills%2Falpha%2FSKILL.md?ref=main`) {
        return createJsonResponse(createBase64TextFilePayload(createSkillMarkdown("2.0.0")));
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, async () => {
      const result = await service.checkSkillUpdates({ projectRoot });
      assert.deepEqual(result.updates, [
        {
          skillId: "alpha",
          marketplaceId: "trustkit",
          installedVersion: "1.0.0",
          remoteVersion: "2.0.0",
          headCommittedAt: "2026-08-01T00:00:00Z",
        },
      ]);
    });

    assert.equal(
      fetchedUrls.filter((url) => url.includes("/repository/compare")).length,
      1,
      "one compare covers every record sharing the baseline",
    );
    assert.deepEqual(
      fetchedUrls.filter((url) => url.includes("/repository/files/")),
      [`${TRUSTKIT_API}/repository/files/skills%2Falpha%2FSKILL.md?ref=main`],
      "only the touched skill still needs its SKILL.md (display version)",
    );

    const config = readJson(configPath);
    const bySkill = (id) => config.installedSkills.find((s) => s.skillId === id);
    assert.equal(bySkill("alpha").hasUpdate, true);
    assert.equal(bySkill("alpha").lastCheckedVersion, "2.0.0");
    assert.equal(
      bySkill("alpha").contentHeadSha,
      "base-sha",
      "a touched record keeps its baseline until content is actually refreshed",
    );
    assert.equal(bySkill("beta").hasUpdate, false);
    assert.equal(
      bySkill("beta").contentHeadSha,
      "head-sha",
      "an untouched record's baseline advances to head (dir proven unchanged)",
    );
    assert.equal(config.skillFreshnessShas[TRUSTKIT_GROUP_KEY], "head-sha");
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("checkSkillUpdates content compare flags version-less edits, root skills, and renames (GitHub)", async () => {
  const projectRoot = createTempDir("marketplace-content-github-test-");
  const { service, restore } = loadMarketplaceService();

  try {
    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [
        {
          id: "anthropic-agent-skills",
          name: "anthropic-agent-skills",
          source: {
            type: "github",
            repo: "anthropics/skills",
            repoUrl: "https://github.com/anthropics/skills",
            ref: "main",
          },
        },
      ],
      installedSkills: [
        {
          marketplaceId: "anthropic-agent-skills",
          skillId: "rooty",
          skillPath: "./",
          installedVersion: "1.0.0",
          localPath: "skills-marketplace/anthropic-agent-skills/rooty",
          hasUpdate: false,
          contentHeadSha: "base-sha",
        },
        {
          marketplaceId: "anthropic-agent-skills",
          skillId: "xkit",
          skillPath: "./skills/x",
          installedVersion: "1.0.0",
          localPath: "skills-marketplace/anthropic-agent-skills/xkit",
          hasUpdate: false,
          contentHeadSha: "base-sha",
        },
      ],
    });

    await withMockFetch(async (url) => {
      if (url === "https://api.github.com/repos/anthropics/skills/commits/main") {
        return createJsonResponse({
          sha: "head-sha",
          commit: { committer: { date: "2026-08-02T00:00:00Z" } },
        });
      }
      if (
        url ===
        "https://api.github.com/repos/anthropics/skills/compare/base-sha...head-sha"
      ) {
        // The only touched paths: one outside every skill dir except the
        // repo-root skill, plus a RENAME whose old path was inside xkit.
        return createJsonResponse({
          status: "ahead",
          files: [
            {
              filename: "archive/moved.md",
              previous_filename: "skills/x/OLD.md",
              status: "renamed",
            },
          ],
        });
      }
      if (url.includes("/contents/") && url.includes("SKILL.md")) {
        return createJsonResponse(createBase64TextFilePayload(createSkillMarkdown("1.0.0")));
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, async () => {
      const result = await service.checkSkillUpdates({ projectRoot });
      assert.equal(result.updates.length, 2);
    });

    const config = readJson(path.join(projectRoot, "marketplaces.json"));
    const bySkill = (id) => config.installedSkills.find((s) => s.skillId === id);
    assert.equal(
      bySkill("rooty").hasUpdate,
      true,
      "a repo-root skill is touched by any change at all",
    );
    assert.equal(
      bySkill("xkit").hasUpdate,
      true,
      "a rename OUT of the skill dir still counts as touching it",
    );
    // Remote version equals installed version — the flag came from content,
    // which is the entire point of dropping the version-bump contract.
    assert.equal(bySkill("xkit").installedVersion, "1.0.0");
    assert.equal(bySkill("xkit").lastCheckedVersion, "1.0.0");
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("checkSkillUpdates clears stale flags with zero content fetches when the baseline equals head", async () => {
  const projectRoot = createTempDir("marketplace-content-current-test-");
  const { service, restore } = loadMarketplaceService(gitlabAuthStub());

  try {
    writeJson(
      path.join(projectRoot, "marketplaces.json"),
      gitlabFreshnessFixture({
        shas: { [TRUSTKIT_GROUP_KEY]: "old-sweep-sha" },
        marketplaces: [TRUSTKIT_MARKETPLACE],
        records: [
          trustkitRecord("alpha", { hasUpdate: true, contentHeadSha: "head-sha" }),
        ],
      }),
    );

    const fetchedUrls = [];
    await withMockFetch(async (url) => {
      fetchedUrls.push(url);
      if (url === `${TRUSTKIT_API}/repository/commits/main`) {
        return createJsonResponse({ id: "head-sha" });
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, async () => {
      const result = await service.checkSkillUpdates({ projectRoot });
      assert.equal(result.hasUpdates, false);
    });

    assert.equal(fetchedUrls.length, 1, "probe only — current records need no fetches");
    const config = readJson(path.join(projectRoot, "marketplaces.json"));
    assert.equal(config.installedSkills[0].hasUpdate, false, "stale flag cleared");
    assert.equal(config.installedSkills[0].contentHeadSha, "head-sha");
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("checkSkillUpdates falls back to the version compare when the compare cannot be trusted", async () => {
  const { service, restore } = loadMarketplaceService(gitlabAuthStub());

  const runSweep = async (compareResponder) => {
    const projectRoot = createTempDir("marketplace-content-fallback-test-");
    try {
      writeJson(
        path.join(projectRoot, "marketplaces.json"),
        gitlabFreshnessFixture({
          marketplaces: [TRUSTKIT_MARKETPLACE],
          records: [
            // alpha: SKILL.md fetch fails TRANSIENTLY (500) → the probe
            // cannot determine anything → the seeded flag is kept. (A 404
            // would be a definitive source-missing verdict — covered by the
            // dedicated sourceMissing tests below.)
            trustkitRecord("alpha", { hasUpdate: true, contentHeadSha: "base-sha" }),
            trustkitRecord("beta", { installedVersion: "1.0.0", contentHeadSha: "base-sha" }),
          ],
        }),
      );
      const fetchedFiles = [];
      await withMockFetch(async (url) => {
        if (url === `${TRUSTKIT_API}/repository/commits/main`) {
          return createJsonResponse({ id: "head-sha" });
        }
        if (url.includes("/repository/compare?")) {
          return compareResponder();
        }
        if (url.includes("/repository/files/")) {
          fetchedFiles.push(url);
          if (url.includes("alpha")) {
            return createJsonResponse({ message: "boom" }, 500);
          }
          return createJsonResponse(createBase64TextFilePayload(createSkillMarkdown("3.0.0")));
        }
        return createJsonResponse({ message: "Not Found" }, 404);
      }, () => service.checkSkillUpdates({ projectRoot }));

      const config = readJson(path.join(projectRoot, "marketplaces.json"));
      return {
        fetchedFiles,
        alpha: config.installedSkills.find((s) => s.skillId === "alpha"),
        beta: config.installedSkills.find((s) => s.skillId === "beta"),
      };
    } finally {
      cleanupDir(projectRoot);
    }
  };

  try {
    for (const responder of [
      () => createJsonResponse({ compare_timeout: true, diffs: [] }),
      () => createJsonResponse({ message: "boom" }, 500),
    ]) {
      const { fetchedFiles, alpha, beta } = await runSweep(responder);
      assert.equal(fetchedFiles.length, 2, "fallback fetches every record's SKILL.md");
      assert.equal(alpha.hasUpdate, true, "null remote version keeps last-synced flags");
      assert.equal(beta.hasUpdate, true, "legacy version compare flags the newer remote");
      assert.equal(beta.lastCheckedVersion, "3.0.0");
      assert.equal(alpha.contentHeadSha, "base-sha", "untrusted compare never advances");
      assert.equal(beta.contentHeadSha, "base-sha", "untrusted compare never advances");
    }
  } finally {
    restore();
  }
});

test("checkSkillUpdates classifies deleted-at-head skills as source-missing, not updates", async () => {
  const { service, restore } = loadMarketplaceService(gitlabAuthStub());
  const projectRoot = createTempDir("marketplace-source-missing-test-");

  const sweepWith = async ({ headSha, alphaFileResponder, removalCommitsResponder }) => {
    await withMockFetch(async (url) => {
      if (url === `${TRUSTKIT_API}/repository/commits/main`) {
        return createJsonResponse({
          id: headSha,
          committed_date: "2026-08-11T10:00:00Z",
        });
      }
      if (
        url.startsWith(`${TRUSTKIT_API}/repository/commits?`) &&
        url.includes("path=skills%2Falpha")
      ) {
        return removalCommitsResponder
          ? removalCommitsResponder()
          : createJsonResponse({ message: "Not Found" }, 404);
      }
      if (url.includes("/repository/compare?")) {
        // The old dir's files show up as touched (deletion) in every
        // base..head compare until the baseline advances — which it never
        // does for a missing source.
        return createJsonResponse({
          compare_timeout: false,
          diffs: [
            {
              old_path: "skills/alpha/SKILL.md",
              new_path: "skills/alpha/SKILL.md",
              deleted_file: true,
            },
          ],
        });
      }
      if (url.includes("/repository/files/")) {
        return alphaFileResponder();
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, () => service.checkSkillUpdates({ projectRoot }));
    return readJson(path.join(projectRoot, "marketplaces.json")).installedSkills.find(
      (record) => record.skillId === "alpha",
    );
  };

  try {
    writeJson(
      path.join(projectRoot, "marketplaces.json"),
      gitlabFreshnessFixture({
        marketplaces: [TRUSTKIT_MARKETPLACE],
        records: [
          trustkitRecord("alpha", {
            hasUpdate: true,
            updateHeadCommittedAt: "2026-08-10T00:00:00Z",
            contentHeadSha: "base-sha",
          }),
        ],
      }),
    );

    // 1) Definitive 404 at head: missing verdict — the stuck-row lie ends.
    // The removal commit (newest commit touching the dead path) dates the
    // desync moment the Updates tab renders as the row's drift.
    let alpha = await sweepWith({
      headSha: "head-sha",
      alphaFileResponder: () => createJsonResponse({ message: "Not Found" }, 404),
      removalCommitsResponder: () =>
        createJsonResponse([
          { id: "removal-sha", committed_date: "2026-08-11T09:30:00Z" },
        ]),
    });
    assert.equal(alpha.sourceMissing, true);
    assert.equal(alpha.sourceMissingSince, "2026-08-11T09:30:00Z");
    assert.equal(alpha.hasUpdate, false, "a deletion is not an update");
    assert.equal(alpha.updateHeadCommittedAt, undefined);
    assert.equal(alpha.contentHeadSha, "base-sha", "baseline never advances past a deletion");

    // 2) Head moves again, probe now fails transiently: the prior missing
    // verdict is kept — no evidence the source came back — and the stamp is
    // never overwritten while present (no removal-commit refetch either).
    alpha = await sweepWith({
      headSha: "head-sha-2",
      alphaFileResponder: () => createJsonResponse({ message: "boom" }, 500),
      removalCommitsResponder: () =>
        createJsonResponse([
          { id: "other-sha", committed_date: "2026-08-11T11:59:00Z" },
        ]),
    });
    assert.equal(alpha.sourceMissing, true);
    assert.equal(alpha.sourceMissingSince, "2026-08-11T09:30:00Z", "stamp-once");
    assert.equal(alpha.hasUpdate, false);

    // 3) The path reappears upstream: the verdict clears — stamp included —
    // and the touched dir flags as a real update again.
    alpha = await sweepWith({
      headSha: "head-sha-3",
      alphaFileResponder: () =>
        createJsonResponse(createBase64TextFilePayload(createSkillMarkdown("2.0.0"))),
    });
    assert.equal(alpha.sourceMissing, undefined);
    assert.equal(alpha.sourceMissingSince, undefined);
    assert.equal(alpha.hasUpdate, true);
    assert.equal(alpha.lastCheckedVersion, "2.0.0");
  } finally {
    cleanupDir(projectRoot);
    restore();
  }
});

test("checkSkillUpdates fallback compare also yields the missing verdict on a definitive 404", async () => {
  const { service, restore } = loadMarketplaceService(gitlabAuthStub());
  const projectRoot = createTempDir("marketplace-source-missing-fallback-test-");

  try {
    writeJson(
      path.join(projectRoot, "marketplaces.json"),
      gitlabFreshnessFixture({
        marketplaces: [TRUSTKIT_MARKETPLACE],
        records: [
          trustkitRecord("alpha", { hasUpdate: true, contentHeadSha: "base-sha" }),
        ],
      }),
    );

    await withMockFetch(async (url) => {
      if (url === `${TRUSTKIT_API}/repository/commits/main`) {
        return createJsonResponse({ id: "head-sha" });
      }
      if (url.includes("/repository/compare?")) {
        // Untrusted compare → the record takes the legacy fallback path.
        return createJsonResponse({ compare_timeout: true, diffs: [] });
      }
      if (url.includes("/repository/files/")) {
        return createJsonResponse({ message: "Not Found" }, 404);
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, () => service.checkSkillUpdates({ projectRoot }));

    const alpha = readJson(
      path.join(projectRoot, "marketplaces.json"),
    ).installedSkills.find((record) => record.skillId === "alpha");
    assert.equal(alpha.sourceMissing, true);
    assert.equal(alpha.hasUpdate, false);
  } finally {
    cleanupDir(projectRoot);
    restore();
  }
});

test("checkSkillUpdates removal stamp falls back to the head commit date when the path-commits lookup fails", async () => {
  const { service, restore } = loadMarketplaceService(gitlabAuthStub());
  const projectRoot = createTempDir("marketplace-removal-stamp-fallback-test-");

  try {
    writeJson(
      path.join(projectRoot, "marketplaces.json"),
      gitlabFreshnessFixture({
        marketplaces: [TRUSTKIT_MARKETPLACE],
        records: [trustkitRecord("alpha", { contentHeadSha: "base-sha" })],
      }),
    );

    await withMockFetch(async (url) => {
      if (url === `${TRUSTKIT_API}/repository/commits/main`) {
        return createJsonResponse({
          id: "head-sha",
          committed_date: "2026-08-11T10:00:00Z",
        });
      }
      if (url.includes("/repository/compare?")) {
        return createJsonResponse({
          compare_timeout: false,
          diffs: [{ old_path: "skills/alpha/SKILL.md", new_path: "skills/alpha/SKILL.md", deleted_file: true }],
        });
      }
      // path-commits lookup and SKILL.md probe both 404.
      return createJsonResponse({ message: "Not Found" }, 404);
    }, () => service.checkSkillUpdates({ projectRoot }));

    const alpha = readJson(
      path.join(projectRoot, "marketplaces.json"),
    ).installedSkills.find((record) => record.skillId === "alpha");
    assert.equal(alpha.sourceMissing, true);
    assert.equal(
      alpha.sourceMissingSince,
      "2026-08-11T10:00:00Z",
      "head date approximates the desync moment when the removal commit is unreachable",
    );
  } finally {
    cleanupDir(projectRoot);
    restore();
  }
});

test("checkSkillUpdates backfills a sync-flagged record's removal stamp even on a gated (unmoved) repo", async () => {
  const { service, restore } = loadMarketplaceService(gitlabAuthStub());
  const projectRoot = createTempDir("marketplace-removal-stamp-gated-test-");

  try {
    // Destructive sync flags missing records without any network — the
    // record arrives sourceMissing with no stamp, and the repo has not
    // moved since the last sweep (sha gate holds).
    writeJson(
      path.join(projectRoot, "marketplaces.json"),
      gitlabFreshnessFixture({
        shas: { [TRUSTKIT_GROUP_KEY]: "head-sha" },
        marketplaces: [TRUSTKIT_MARKETPLACE],
        records: [
          trustkitRecord("alpha", { sourceMissing: true, contentHeadSha: "base-sha" }),
        ],
      }),
    );

    const fetchedUrls = [];
    await withMockFetch(async (url) => {
      fetchedUrls.push(url);
      if (url === `${TRUSTKIT_API}/repository/commits/main`) {
        return createJsonResponse({
          id: "head-sha",
          committed_date: "2026-08-11T10:00:00Z",
        });
      }
      if (
        url.startsWith(`${TRUSTKIT_API}/repository/commits?`) &&
        url.includes("path=skills%2Falpha")
      ) {
        return createJsonResponse([
          { id: "removal-sha", committed_date: "2026-08-10T08:00:00Z" },
        ]);
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, () => service.checkSkillUpdates({ projectRoot }));

    const alpha = readJson(
      path.join(projectRoot, "marketplaces.json"),
    ).installedSkills.find((record) => record.skillId === "alpha");
    assert.equal(alpha.sourceMissing, true, "gate never flips a kept verdict");
    assert.equal(alpha.sourceMissingSince, "2026-08-10T08:00:00Z");
    assert.equal(
      fetchedUrls.some((url) => url.includes("/repository/compare?") || url.includes("/repository/files/")),
      false,
      "the sha gate still skipped compares and probes — only the stamp lookup ran",
    );
  } finally {
    cleanupDir(projectRoot);
    restore();
  }
});

test("checkSkillUpdates leaves an unstampable missing record byte-stable and backfills on a later sweep", async () => {
  const { service, restore } = loadMarketplaceService(gitlabAuthStub());
  const projectRoot = createTempDir("marketplace-removal-stamp-retry-test-");
  const configPath = path.join(projectRoot, "marketplaces.json");

  const sweepWith = (removalCommitsResponder) =>
    withMockFetch(async (url) => {
      if (url === `${TRUSTKIT_API}/repository/commits/main`) {
        // No committed_date: the head-date fallback is unavailable too.
        return createJsonResponse({ id: "head-sha" });
      }
      if (
        url.startsWith(`${TRUSTKIT_API}/repository/commits?`) &&
        url.includes("path=skills%2Falpha")
      ) {
        return removalCommitsResponder();
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, () => service.checkSkillUpdates({ projectRoot }));

  try {
    writeJson(
      configPath,
      gitlabFreshnessFixture({
        shas: { [TRUSTKIT_GROUP_KEY]: "head-sha" },
        marketplaces: [TRUSTKIT_MARKETPLACE],
        records: [
          trustkitRecord("alpha", { sourceMissing: true, contentHeadSha: "base-sha" }),
        ],
      }),
    );

    const before = fs.readFileSync(configPath, "utf8");
    await sweepWith(() => createJsonResponse({ message: "Not Found" }, 404));
    assert.equal(
      fs.readFileSync(configPath, "utf8"),
      before,
      "a failed stamp lookup writes nothing — no churn while unstampable",
    );

    await sweepWith(() =>
      createJsonResponse([{ id: "removal-sha", committed_date: "2026-08-09T00:00:00Z" }]),
    );
    const alpha = readJson(configPath).installedSkills.find(
      (record) => record.skillId === "alpha",
    );
    assert.equal(alpha.sourceMissingSince, "2026-08-09T00:00:00Z");
  } finally {
    cleanupDir(projectRoot);
    restore();
  }
});

test("checkSkillUpdates removal stamp uses the GitHub commits-by-path shape", async () => {
  const { service, restore } = loadMarketplaceService();
  const projectRoot = createTempDir("marketplace-removal-stamp-github-test-");

  try {
    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [
        {
          id: "anthropic-agent-skills",
          name: "anthropic-agent-skills",
          source: {
            type: "github",
            repo: "anthropics/skills",
            repoUrl: "https://github.com/anthropics/skills",
            ref: "main",
          },
        },
      ],
      installedSkills: [
        {
          marketplaceId: "anthropic-agent-skills",
          skillId: "pdf",
          skillPath: "./skills/pdf",
          installedVersion: "1.0.0",
          localPath: "skills-marketplace/anthropic-agent-skills/pdf",
          hasUpdate: false,
          contentHeadSha: "base-sha",
        },
      ],
    });

    await withMockFetch(async (url) => {
      if (url === "https://api.github.com/repos/anthropics/skills/commits/main") {
        return createJsonResponse({
          sha: "head-sha",
          commit: { committer: { date: "2026-08-02T00:00:00Z" } },
        });
      }
      if (
        url ===
        "https://api.github.com/repos/anthropics/skills/compare/base-sha...head-sha"
      ) {
        return createJsonResponse({
          status: "ahead",
          files: [{ filename: "skills/pdf/SKILL.md", status: "removed" }],
        });
      }
      if (
        url ===
        "https://api.github.com/repos/anthropics/skills/commits?sha=main&path=skills%2Fpdf&per_page=1"
      ) {
        return createJsonResponse([
          { sha: "removal-sha", commit: { committer: { date: "2026-08-01T12:00:00Z" } } },
        ]);
      }
      // SKILL.md probes (raw + contents API) 404 → definitive missing.
      return createJsonResponse({ message: "Not Found" }, 404);
    }, () => service.checkSkillUpdates({ projectRoot }));

    const pdf = readJson(
      path.join(projectRoot, "marketplaces.json"),
    ).installedSkills.find((record) => record.skillId === "pdf");
    assert.equal(pdf.sourceMissing, true);
    assert.equal(pdf.sourceMissingSince, "2026-08-01T12:00:00Z");
  } finally {
    cleanupDir(projectRoot);
    restore();
  }
});

test("checkSkillUpdates rejects diverged GitHub compares instead of advancing past a force-push", async () => {
  const projectRoot = createTempDir("marketplace-content-diverged-test-");
  const { service, restore } = loadMarketplaceService();

  try {
    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [
        {
          id: "anthropic-agent-skills",
          name: "anthropic-agent-skills",
          source: {
            type: "github",
            repo: "anthropics/skills",
            repoUrl: "https://github.com/anthropics/skills",
            ref: "main",
          },
        },
      ],
      installedSkills: [
        {
          marketplaceId: "anthropic-agent-skills",
          skillId: "xkit",
          skillPath: "./skills/x",
          installedVersion: "1.0",
          localPath: "skills-marketplace/anthropic-agent-skills/xkit",
          hasUpdate: false,
          contentHeadSha: "base-sha",
        },
      ],
    });

    await withMockFetch(async (url) => {
      if (url === "https://api.github.com/repos/anthropics/skills/commits/main") {
        return createJsonResponse({ sha: "head-sha" });
      }
      if (
        url ===
        "https://api.github.com/repos/anthropics/skills/compare/base-sha...head-sha"
      ) {
        // Diverged = merge-base diff, NOT base→head: trusting it could hide
        // changes a force-push removed and wrongly advance the baseline.
        return createJsonResponse({ status: "diverged", files: [] });
      }
      if (url.includes("/contents/") && url.includes("SKILL.md")) {
        return createJsonResponse(createBase64TextFilePayload(createSkillMarkdown("1.0")));
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, () => service.checkSkillUpdates({ projectRoot }));

    const record = readJson(path.join(projectRoot, "marketplaces.json")).installedSkills[0];
    assert.equal(record.hasUpdate, false, "fallback version compare ran");
    assert.equal(
      record.contentHeadSha,
      "base-sha",
      "a diverged compare must never advance the baseline",
    );
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("checkSkillUpdates backfills missing baselines from the record's content-write time", async () => {
  const projectRoot = createTempDir("marketplace-backfill-test-");
  const { service, restore } = loadMarketplaceService(gitlabAuthStub());
  const configPath = path.join(projectRoot, "marketplaces.json");

  try {
    writeJson(
      configPath,
      gitlabFreshnessFixture({
        marketplaces: [TRUSTKIT_MARKETPLACE],
        records: [
          trustkitRecord("alpha", {
            installedVersion: "1.0.0",
            installedAt: "2026-07-01T00:00:00.000Z",
          }),
          trustkitRecord("beta", {
            installedVersion: "1.0.0",
            installedAt: "2026-07-01T00:00:00.000Z",
          }),
        ],
      }),
    );

    const fetchedUrls = [];
    await withMockFetch(async (url) => {
      fetchedUrls.push(url);
      if (url === `${TRUSTKIT_API}/repository/commits/main`) {
        return createJsonResponse({ id: "head-sha", committed_date: "2026-08-01T00:00:00Z" });
      }
      if (
        url ===
        `${TRUSTKIT_API}/repository/commits?ref_name=main&until=2026-07-01T00%3A00%3A00Z&per_page=1`
      ) {
        return createJsonResponse([{ id: "old-sha" }]);
      }
      if (
        url === `${TRUSTKIT_API}/repository/compare?from=old-sha&to=head-sha&straight=true`
      ) {
        return createJsonResponse({
          compare_timeout: false,
          diffs: [{ old_path: "skills/alpha/notes.md", new_path: "skills/alpha/notes.md" }],
        });
      }
      if (url === `${TRUSTKIT_API}/repository/files/skills%2Falpha%2FSKILL.md?ref=main`) {
        return createJsonResponse(createBase64TextFilePayload(createSkillMarkdown("1.0.0")));
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, async () => {
      const result = await service.checkSkillUpdates({ projectRoot });
      assert.equal(result.updates.length, 1);
      assert.equal(result.updates[0].skillId, "alpha");
      assert.equal(result.updates[0].headCommittedAt, "2026-08-01T00:00:00Z");
    });

    assert.equal(
      fetchedUrls.filter((url) => url.includes("until=")).length,
      1,
      "records sharing an anchor share one historical-sha resolution",
    );

    const config = readJson(configPath);
    const bySkill = (id) => config.installedSkills.find((s) => s.skillId === id);
    assert.equal(bySkill("alpha").hasUpdate, true, "drift since the anchor is flagged");
    assert.equal(
      bySkill("alpha").contentHeadSha,
      "old-sha",
      "backfilled baseline persists on the touched record",
    );
    assert.equal(bySkill("beta").hasUpdate, false);
    assert.equal(bySkill("beta").contentHeadSha, "head-sha");
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("checkSkillUpdates backfill failure degrades to the version compare and stamps nothing", async () => {
  const { service, restore } = loadMarketplaceService(gitlabAuthStub());

  const runSweep = async (untilResponder) => {
    const projectRoot = createTempDir("marketplace-backfill-fail-test-");
    try {
      writeJson(
        path.join(projectRoot, "marketplaces.json"),
        gitlabFreshnessFixture({
          marketplaces: [TRUSTKIT_MARKETPLACE],
          records: [
            trustkitRecord("alpha", {
              installedVersion: "1.0.0",
              installedAt: "2026-07-01T00:00:00.000Z",
            }),
          ],
        }),
      );
      await withMockFetch(async (url) => {
        if (url === `${TRUSTKIT_API}/repository/commits/main`) {
          return createJsonResponse({ id: "head-sha" });
        }
        if (url.includes("until=")) {
          return untilResponder();
        }
        if (url.includes("/repository/files/")) {
          return createJsonResponse(createBase64TextFilePayload(createSkillMarkdown("2.0.0")));
        }
        return createJsonResponse({ message: "Not Found" }, 404);
      }, () => service.checkSkillUpdates({ projectRoot }));
      return readJson(path.join(projectRoot, "marketplaces.json")).installedSkills[0];
    } finally {
      cleanupDir(projectRoot);
    }
  };

  try {
    for (const responder of [
      () => createJsonResponse({ message: "boom" }, 500),
      () => createJsonResponse([]),
    ]) {
      const record = await runSweep(responder);
      assert.equal(record.hasUpdate, true, "legacy version compare still detects the bump");
      assert.equal(
        record.contentHeadSha,
        undefined,
        "no stamp without a resolved baseline — retried next sweep",
      );
    }
  } finally {
    restore();
  }
});

test("checkSkillUpdates gate bypass: unstamped-but-anchored records evaluate once, then gate again", async () => {
  const projectRoot = createTempDir("marketplace-gate-bypass-test-");
  const { service, restore } = loadMarketplaceService(gitlabAuthStub());
  const configPath = path.join(projectRoot, "marketplaces.json");

  try {
    writeJson(
      configPath,
      gitlabFreshnessFixture({
        // The sweep baseline already matches head — the OLD gate would skip
        // forever, hiding drift that predates it, so backfill must run once.
        shas: { [TRUSTKIT_GROUP_KEY]: "head-sha" },
        marketplaces: [TRUSTKIT_MARKETPLACE],
        records: [
          trustkitRecord("alpha", {
            installedVersion: "1.0.0",
            installedAt: "2026-07-01T00:00:00.000Z",
          }),
        ],
      }),
    );

    const firstUrls = [];
    await withMockFetch(async (url) => {
      firstUrls.push(url);
      if (url === `${TRUSTKIT_API}/repository/commits/main`) {
        return createJsonResponse({ id: "head-sha" });
      }
      if (url.includes("until=")) {
        return createJsonResponse([{ id: "old-sha" }]);
      }
      if (
        url === `${TRUSTKIT_API}/repository/compare?from=old-sha&to=head-sha&straight=true`
      ) {
        return createJsonResponse({ compare_timeout: false, diffs: [] });
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, () => service.checkSkillUpdates({ projectRoot }));

    assert.ok(
      firstUrls.some((url) => url.includes("until=")),
      "the matching gate did not starve the one-time backfill",
    );
    const stamped = readJson(configPath).installedSkills[0];
    assert.equal(stamped.contentHeadSha, "head-sha", "clean backfill advances to head");

    const secondUrls = [];
    await withMockFetch(async (url) => {
      secondUrls.push(url);
      if (url === `${TRUSTKIT_API}/repository/commits/main`) {
        return createJsonResponse({ id: "head-sha" });
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, () => service.checkSkillUpdates({ projectRoot }));

    assert.equal(secondUrls.length, 1, "fully-stamped group gates on the very next sweep");
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("checkSkillUpdates gate skip still holds for anchor-less records and stays byte-stable with stamps", async () => {
  const { service, restore } = loadMarketplaceService(gitlabAuthStub());

  const runGated = async (records) => {
    const projectRoot = createTempDir("marketplace-gate-stable-test-");
    const configPath = path.join(projectRoot, "marketplaces.json");
    try {
      writeJson(
        configPath,
        gitlabFreshnessFixture({
          shas: { [TRUSTKIT_GROUP_KEY]: "head-sha" },
          marketplaces: [TRUSTKIT_MARKETPLACE],
          records,
        }),
      );
      const fileBefore = fs.readFileSync(configPath, "utf8");
      const fetchedUrls = [];
      await withMockFetch(async (url) => {
        fetchedUrls.push(url);
        if (url === `${TRUSTKIT_API}/repository/commits/main`) {
          return createJsonResponse({ id: "head-sha" });
        }
        return createJsonResponse({ message: "Not Found" }, 404);
      }, () => service.checkSkillUpdates({ projectRoot }));
      return { fetchedUrls, unchanged: fs.readFileSync(configPath, "utf8") === fileBefore };
    } finally {
      cleanupDir(projectRoot);
    }
  };

  try {
    // Anchor-less legacy record (no updatedAt/installedAt): can never
    // backfill, so the gate's zero-work contract survives untouched.
    const legacy = await runGated([trustkitRecord("alpha", { lastCheckedVersion: "1.0.0" })]);
    assert.equal(legacy.fetchedUrls.length, 1, "probe only");
    assert.equal(legacy.unchanged, true, "no-op sweep never rewrites the config");

    // Fully-stamped steady state: same guarantee with the new field present.
    const stamped = await runGated([
      trustkitRecord("alpha", { lastCheckedVersion: "1.0.0", contentHeadSha: "head-sha" }),
    ]);
    assert.equal(stamped.fetchedUrls.length, 1, "probe only");
    assert.equal(stamped.unchanged, true, "stamped steady state stays byte-stable");
  } finally {
    restore();
  }
});

test("checkSkillUpdates persists the head date with the flag; degraded sweeps keep both; recovery clears", async () => {
  const projectRoot = createTempDir("marketplace-head-date-persist-test-");
  const { service, restore } = loadMarketplaceService(gitlabAuthStub());
  const configPath = path.join(projectRoot, "marketplaces.json");

  try {
    writeJson(
      configPath,
      gitlabFreshnessFixture({
        shas: { [TRUSTKIT_GROUP_KEY]: "old-sweep-sha" },
        marketplaces: [TRUSTKIT_MARKETPLACE],
        records: [trustkitRecord("alpha", { contentHeadSha: "base-sha" })],
      }),
    );

    // Sweep 1: healthy probes flag the touched skill AND persist the head
    // date on the record — the Updates tab's drift source of last resort.
    await withMockFetch(async (url) => {
      if (url === `${TRUSTKIT_API}/repository/commits/main`) {
        return createJsonResponse({ id: "head-sha", committed_date: "2026-08-02T00:00:00Z" });
      }
      if (url === `${TRUSTKIT_API}/repository/compare?from=base-sha&to=head-sha&straight=true`) {
        return createJsonResponse({
          compare_timeout: false,
          diffs: [{ old_path: "skills/alpha/SKILL.md", new_path: "skills/alpha/SKILL.md" }],
        });
      }
      if (url === `${TRUSTKIT_API}/repository/files/skills%2Falpha%2FSKILL.md?ref=main`) {
        return createJsonResponse(createBase64TextFilePayload(createSkillMarkdown("1.0.0")));
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, async () => {
      const result = await service.checkSkillUpdates({ projectRoot });
      assert.equal(result.updates[0].headCommittedAt, "2026-08-02T00:00:00Z");
    });
    let config = readJson(configPath);
    assert.equal(config.installedSkills[0].hasUpdate, true);
    assert.equal(config.installedSkills[0].updateHeadCommittedAt, "2026-08-02T00:00:00Z");
    const flaggedBytes = fs.readFileSync(configPath, "utf8");

    // Sweep 2: every probe fails (expired session, offline). The flag AND
    // its date survive untouched — and the config is not rewritten at all.
    await withMockFetch(async () => createJsonResponse({ message: "boom" }, 500), async () => {
      const result = await service.checkSkillUpdates({ projectRoot });
      assert.deepEqual(result.updates, [], "a degraded sweep supplies no live entries");
    });
    assert.equal(
      fs.readFileSync(configPath, "utf8"),
      flaggedBytes,
      "degraded sweeps leave the persisted flag + head date byte-identical",
    );

    // Sweep 3: probes recover and the compare proves the dir untouched at
    // the new head — flag clears and the stale drift date goes with it.
    await withMockFetch(async (url) => {
      if (url === `${TRUSTKIT_API}/repository/commits/main`) {
        return createJsonResponse({ id: "head-sha-2", committed_date: "2026-08-03T00:00:00Z" });
      }
      if (url === `${TRUSTKIT_API}/repository/compare?from=base-sha&to=head-sha-2&straight=true`) {
        return createJsonResponse({ compare_timeout: false, diffs: [] });
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, async () => {
      await service.checkSkillUpdates({ projectRoot });
    });
    config = readJson(configPath);
    assert.equal(config.installedSkills[0].hasUpdate, false);
    assert.equal(
      "updateHeadCommittedAt" in config.installedSkills[0],
      false,
      "clearing the flag deletes the drift date instead of stranding it",
    );
    assert.equal(config.installedSkills[0].contentHeadSha, "head-sha-2");
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("syncMarketplace stamps contentHeadSha on refreshed and up-to-date skills, never on conflicts", async () => {
  const { service, restore } = loadMarketplaceService(gitlabAuthStub());
  // The manifest must list the installed record's path — a path absent from
  // the fresh manifest is now mirror-classified as missing, not synced.
  const manifest = createSyncTestMarketplaceManifest(["./skills/alpha"]);
  const localMarkdown = createSkillMarkdown("1.0.0", "Alpha");
  const changedMarkdown = `${createSkillMarkdown("1.0.0", "Alpha")}\nUpdated body.\n`;

  const runSync = async ({ record, remoteMarkdown, probeResponder, localContent }) => {
    const projectRoot = createTempDir("marketplace-sync-stamp-test-");
    const configPath = path.join(projectRoot, "marketplaces.json");
    try {
      const installedDir = path.join(projectRoot, record.localPath);
      fs.mkdirSync(installedDir, { recursive: true });
      fs.writeFileSync(path.join(installedDir, "SKILL.md"), localContent);
      writeJson(configPath, {
        version: "1.0",
        marketplaces: [TRUSTKIT_MARKETPLACE],
        installedSkills: [record],
      });
      const result = await withMockFetch(async (url) => {
        if (
          url ===
          `${TRUSTKIT_API}/repository/files/.claude-plugin%2Fmarketplace.json?ref=main`
        ) {
          return createJsonResponse(createBase64JsonFilePayload(manifest));
        }
        if (url === `${TRUSTKIT_API}/repository/commits/main`) {
          return probeResponder();
        }
        if (
          url ===
          `${TRUSTKIT_API}/repository/tree?ref=main&page=1&per_page=100&recursive=true&path=skills%2Falpha`
        ) {
          return createJsonResponse([
            {
              id: "skill",
              name: "SKILL.md",
              path: "skills/alpha/SKILL.md",
              type: "blob",
              mode: "100644",
            },
          ]);
        }
        if (url === `${TRUSTKIT_API}/repository/files/skills%2Falpha%2FSKILL.md?ref=main`) {
          return createJsonResponse(createBase64TextFilePayload(remoteMarkdown));
        }
        return createJsonResponse({ message: "Not Found" }, 404);
      }, () =>
        service.syncMarketplace({ projectRoot, marketplaceId: "trustkit" }),
      );
      return { result, record: readJson(configPath).installedSkills[0] };
    } finally {
      cleanupDir(projectRoot);
    }
  };

  try {
    // Up-to-date leg: local content equals the head tree → stamp advances.
    const upToDate = await runSync({
      record: trustkitRecord("alpha", { installedVersion: "1.0.0" }),
      localContent: localMarkdown,
      remoteMarkdown: localMarkdown,
      probeResponder: () => createJsonResponse({ id: "sync-head-1" }),
    });
    assert.equal(upToDate.result.skillsUpToDate.length, 1);
    assert.equal(upToDate.record.contentHeadSha, "sync-head-1");

    // Refresh leg: content replaced from head → stamped.
    const refreshed = await runSync({
      record: trustkitRecord("alpha", { installedVersion: "1.0.0" }),
      localContent: localMarkdown,
      remoteMarkdown: changedMarkdown,
      probeResponder: () => createJsonResponse({ id: "sync-head-2" }),
    });
    assert.equal(refreshed.result.skillsUpdated.length, 1);
    assert.equal(refreshed.record.contentHeadSha, "sync-head-2");

    // Refresh with a failed probe: a stale stamp must not survive content
    // it no longer describes.
    const probeless = await runSync({
      record: trustkitRecord("alpha", {
        installedVersion: "1.0.0",
        contentHeadSha: "stale-sha",
      }),
      localContent: localMarkdown,
      remoteMarkdown: changedMarkdown,
      probeResponder: () => createJsonResponse({ message: "Not Found" }, 404),
    });
    assert.equal(probeless.result.skillsUpdated.length, 1);
    assert.equal(probeless.record.contentHeadSha, undefined, "stale stamp deleted");

    // Conflict leg: local managed content did not move — no stamp writes.
    // (The baseline entry must carry a well-formed sha256: load-time
    // normalization drops malformed entries, which would erase dirtiness.)
    const conflicted = await runSync({
      record: trustkitRecord("alpha", {
        installedVersion: "1.0.0",
        baseline: {
          installedVersion: "1.0.0",
          files: [{ path: "SKILL.md", sha256: "0".repeat(64) }],
        },
      }),
      localContent: localMarkdown,
      remoteMarkdown: changedMarkdown,
      probeResponder: () => createJsonResponse({ id: "sync-head-3" }),
    });
    assert.equal(conflicted.result.skillsConflicted.length, 1);
    assert.equal(
      conflicted.record.contentHeadSha,
      undefined,
      "conflicted (kept-local) records are never stamped",
    );
  } finally {
    restore();
  }
});

test("installMarketplaceSkill stamps the probed head sha on the new record", async () => {
  const projectRoot = createTempDir("marketplace-install-stamp-test-");
  const { service, restore } = loadMarketplaceService(gitlabAuthStub());

  try {
    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [TRUSTKIT_MARKETPLACE],
      installedSkills: [],
    });

    await withMockFetch(async (url) => {
      if (url === `${TRUSTKIT_API}/repository/commits/main`) {
        return createJsonResponse({ id: "install-head" });
      }
      if (
        url ===
        `${TRUSTKIT_API}/repository/tree?ref=main&page=1&per_page=100&recursive=true&path=skills%2Falpha`
      ) {
        return createJsonResponse([
          {
            id: "skill",
            name: "SKILL.md",
            path: "skills/alpha/SKILL.md",
            type: "blob",
            mode: "100644",
          },
        ]);
      }
      if (url === `${TRUSTKIT_API}/repository/files/skills%2Falpha%2FSKILL.md?ref=main`) {
        return createJsonResponse(createBase64TextFilePayload(createSkillMarkdown("1.2.0")));
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, async () => {
      await service.installMarketplaceSkill({
        projectRoot,
        marketplaceId: "trustkit",
        skillId: "alpha",
        skillPath: "./skills/alpha",
      });
    });

    const record = readJson(path.join(projectRoot, "marketplaces.json")).installedSkills[0];
    assert.equal(record.contentHeadSha, "install-head");
    assert.equal(record.installedVersion, "1.2.0");
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("updateMarketplaceSkill stamps the probed head and deletes stale stamps on probe failure", async () => {
  const { service, restore } = loadMarketplaceService(gitlabAuthStub());

  const runUpdate = async ({ record, probeResponder }) => {
    const projectRoot = createTempDir("marketplace-update-stamp-test-");
    try {
      const installedDir = path.join(projectRoot, record.localPath);
      fs.mkdirSync(installedDir, { recursive: true });
      fs.writeFileSync(path.join(installedDir, "SKILL.md"), createSkillMarkdown("1.0.0"));
      writeJson(path.join(projectRoot, "marketplaces.json"), {
        version: "1.0",
        marketplaces: [TRUSTKIT_MARKETPLACE],
        installedSkills: [record],
      });
      await withMockFetch(async (url) => {
        if (url === `${TRUSTKIT_API}/repository/commits/main`) {
          return probeResponder();
        }
        if (
          url ===
          `${TRUSTKIT_API}/repository/tree?ref=main&page=1&per_page=100&recursive=true&path=skills%2Falpha`
        ) {
          return createJsonResponse([
            {
              id: "skill",
              name: "SKILL.md",
              path: "skills/alpha/SKILL.md",
              type: "blob",
              mode: "100644",
            },
          ]);
        }
        if (url === `${TRUSTKIT_API}/repository/files/skills%2Falpha%2FSKILL.md?ref=main`) {
          return createJsonResponse(createBase64TextFilePayload(createSkillMarkdown("2.0.0")));
        }
        return createJsonResponse({ message: "Not Found" }, 404);
      }, () =>
        service.updateMarketplaceSkill({
          projectRoot,
          marketplaceId: "trustkit",
          skillId: "alpha",
        }),
      );
      return readJson(path.join(projectRoot, "marketplaces.json")).installedSkills[0];
    } finally {
      cleanupDir(projectRoot);
    }
  };

  try {
    const stamped = await runUpdate({
      record: trustkitRecord("alpha", {
        installedVersion: "1.0.0",
        hasUpdate: true,
        updateHeadCommittedAt: "2026-08-02T00:00:00Z",
      }),
      probeResponder: () => createJsonResponse({ id: "upd-head" }),
    });
    assert.equal(stamped.contentHeadSha, "upd-head");
    assert.equal(stamped.hasUpdate, false);
    assert.equal(
      "updateHeadCommittedAt" in stamped,
      false,
      "applying the update clears the persisted drift date with the flag",
    );

    const probeless = await runUpdate({
      record: trustkitRecord("alpha", {
        installedVersion: "1.0.0",
        hasUpdate: true,
        contentHeadSha: "stale-sha",
      }),
      probeResponder: () => createJsonResponse({ message: "Not Found" }, 404),
    });
    assert.equal(probeless.contentHeadSha, undefined, "stale stamp deleted on probe failure");
  } finally {
    restore();
  }
});

test("updateMarketplaceSkill refreshes GitLab skills via repository tree and file APIs", async () => {
  const projectRoot = createTempDir("marketplace-update-test-");
  const authCalls = [];
  const { service, restore } = loadMarketplaceService({
    gitlabMarketplaceAuthExports: {
      async getAuthorizedSession(options) {
        authCalls.push(options);
        return { accessToken: "gitlab-token" };
      },
    },
  });
  const installedDir = path.join(
    projectRoot,
    "skills-marketplace",
    "trustkit",
    "trustkit",
  );

  try {
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(path.join(installedDir, "SKILL.md"), createSkillMarkdown("2.0.0"));
    fs.writeFileSync(path.join(installedDir, "obsolete.txt"), "old");

    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [
        {
          id: "trustkit",
          name: "trustkit",
          source: {
            type: "gitlab",
            host: "example.invalid",
            projectPath: "squall-mod/trust-kit",
            repoUrl: "https://example.invalid/squall-mod/trust-kit.git",
            ref: "main",
          },
        },
      ],
      installedSkills: [
        {
          marketplaceId: "trustkit",
          skillId: "trustkit",
          skillPath: "./.claude/skills/trustkit",
          skillSource: {
            type: "gitlab",
            host: "example.invalid",
            projectPath: "squall-mod/trust-kit",
          },
          installedVersion: "2.0.0",
          lastCheckedVersion: "3.0.0",
          hasUpdate: true,
          localPath: "skills-marketplace/trustkit/trustkit",
        },
      ],
    });

    await withMockFetch(async (url, options) => {
      if (
        url ===
        "https://example.invalid/api/v4/projects/squall-mod%2Ftrust-kit/repository/tree?ref=main&page=1&per_page=100&recursive=true&path=.claude%2Fskills%2Ftrustkit"
      ) {
        assert.equal(options.headers.Authorization, "Bearer gitlab-token");
        return createJsonResponse([
          {
            id: "skill",
            name: "SKILL.md",
            path: ".claude/skills/trustkit/SKILL.md",
            type: "blob",
            mode: "100644",
          },
          {
            id: "helper",
            name: "case-context-builder.md",
            path: ".claude/skills/trustkit/case-context-builder.md",
            type: "blob",
            mode: "100644",
          },
        ]);
      }
      if (
        url ===
        "https://example.invalid/api/v4/projects/squall-mod%2Ftrust-kit/repository/files/.claude%2Fskills%2Ftrustkit%2FSKILL.md?ref=main"
      ) {
        return createJsonResponse(
          createBase64TextFilePayload(createSkillMarkdown("3.0.0", "TrustKit")),
        );
      }
      if (
        url ===
        "https://example.invalid/api/v4/projects/squall-mod%2Ftrust-kit/repository/files/.claude%2Fskills%2Ftrustkit%2Fcase-context-builder.md?ref=main"
      ) {
        return createJsonResponse(
          createBase64TextFilePayload("# replacement helper"),
        );
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, async () => {
      const result = await service.updateMarketplaceSkill({
        projectRoot,
        marketplaceId: "trustkit",
        skillId: "trustkit",
      });

      assert.equal(result.version, "3.0.0");
      assert.ok(authCalls.some((call) => call.interactive === true));
      assert.equal(fs.existsSync(path.join(installedDir, "obsolete.txt")), false);
      assert.match(
        fs.readFileSync(path.join(installedDir, "SKILL.md"), "utf8"),
        /version: 3\.0\.0/,
      );
      assert.match(
        fs.readFileSync(
          path.join(installedDir, "case-context-builder.md"),
          "utf8",
        ),
        /replacement helper/,
      );

      const config = readJson(path.join(projectRoot, "marketplaces.json"));
      assert.equal(config.installedSkills[0].installedVersion, "3.0.0");
      assert.equal(config.installedSkills[0].lastCheckedVersion, "3.0.0");
      assert.equal(config.installedSkills[0].hasUpdate, false);
      assert.equal(config.installedSkills[0].skillSource.ref, "main");
    });
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("updateMarketplaceSkill refuses dirty installs without force and syncs when force is enabled", async () => {
  const projectRoot = createTempDir("marketplace-force-update-test-");
  const authCalls = [];
  const { service, restore } = loadMarketplaceService({
    gitlabMarketplaceAuthExports: {
      async getAuthorizedSession(options) {
        authCalls.push(options);
        return { accessToken: "gitlab-token" };
      },
    },
  });
  const installedDir = path.join(
    projectRoot,
    "skills-marketplace",
    "trustkit",
    "trustkit",
  );
  const originalMarkdown = createSkillMarkdown("2.0.0", "TrustKit");

  try {
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(
      path.join(installedDir, "SKILL.md"),
      `${originalMarkdown}\nLocal edits\n`,
    );
    fs.writeFileSync(path.join(installedDir, "obsolete.txt"), "old");

    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [
        {
          id: "trustkit",
          name: "trustkit",
          source: {
            type: "gitlab",
            host: "example.invalid",
            projectPath: "squall-mod/trust-kit",
            repoUrl: "https://example.invalid/squall-mod/trust-kit.git",
            ref: "main",
          },
        },
      ],
      installedSkills: [
        {
          marketplaceId: "trustkit",
          skillId: "trustkit",
          skillPath: "./.claude/skills/trustkit",
          skillSource: {
            type: "gitlab",
            host: "example.invalid",
            projectPath: "squall-mod/trust-kit",
          },
          installedVersion: "2.0.0",
          lastCheckedVersion: "3.0.0",
          hasUpdate: true,
          localPath: "skills-marketplace/trustkit/trustkit",
          baseline: {
            version: "2.0.0",
            sourceRef: "main",
            files: [
              {
                path: "SKILL.md",
                sha256: sha256(originalMarkdown),
              },
              {
                path: "obsolete.txt",
                sha256: sha256("old"),
              },
            ],
          },
        },
      ],
    });

    await assert.rejects(
      service.updateMarketplaceSkill({
        projectRoot,
        marketplaceId: "trustkit",
        skillId: "trustkit",
      }),
      (error) => {
        assert.equal(error.code, "marketplace_skill_dirty");
        assert.match(error.message, /local changes/i);
        return true;
      },
    );

    await withMockFetch(async (url, options) => {
      if (
        url ===
        "https://example.invalid/api/v4/projects/squall-mod%2Ftrust-kit/repository/tree?ref=main&page=1&per_page=100&recursive=true&path=.claude%2Fskills%2Ftrustkit"
      ) {
        assert.equal(options.headers.Authorization, "Bearer gitlab-token");
        return createJsonResponse([
          {
            id: "skill",
            name: "SKILL.md",
            path: ".claude/skills/trustkit/SKILL.md",
            type: "blob",
            mode: "100644",
          },
        ]);
      }
      if (
        url ===
        "https://example.invalid/api/v4/projects/squall-mod%2Ftrust-kit/repository/files/.claude%2Fskills%2Ftrustkit%2FSKILL.md?ref=main"
      ) {
        return createJsonResponse(
          createBase64TextFilePayload(createSkillMarkdown("3.0.0", "TrustKit")),
        );
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, async () => {
      const result = await service.updateMarketplaceSkill({
        projectRoot,
        marketplaceId: "trustkit",
        skillId: "trustkit",
        forceDiscardLocalChanges: true,
      });

      assert.equal(result.version, "3.0.0");
      assert.ok(authCalls.some((call) => call.interactive === true));

      const config = readJson(path.join(projectRoot, "marketplaces.json"));
      assert.equal(config.installedSkills[0].installedVersion, "3.0.0");
      assert.equal(config.installedSkills[0].hasUpdate, false);
      assert.equal(config.installedSkills[0].baseline.version, "3.0.0");
      assert.equal(
        config.installedSkills[0].baseline.files[0].path,
        "SKILL.md",
      );

      const loaded = await service.loadMarketplacesConfig(projectRoot);
      assert.equal(loaded.installedSkills[0].isDirty, false);
      assert.equal(loaded.installedSkills[0].hasConflict, false);
    });
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("syncAllMarketplaces reports per-marketplace failures without aborting the rest", async () => {
  const projectRoot = createTempDir("marketplace-sync-all-test-");
  const { service, restore } = loadMarketplaceService();

  try {
    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [
        {
          id: "good",
          name: "good",
          source: { type: "github", repo: "org/good", repoUrl: "https://github.com/org/good" },
          marketplaceVersion: "1.0.0",
        },
        {
          id: "bad",
          name: "bad",
          source: { type: "github", repo: "org/bad", repoUrl: "https://github.com/org/bad" },
          marketplaceVersion: "1.0.0",
        },
      ],
      installedSkills: [],
    });

    await withMockFetch(async (url) => {
      if (
        url ===
        "https://raw.githubusercontent.com/org/good/main/.claude-plugin/marketplace.json"
      ) {
        return createTextResponse(
          JSON.stringify({
            name: "good",
            metadata: {
              description: "Good marketplace",
              version: "2.0.0",
            },
            plugins: [],
          }),
        );
      }
      if (
        url ===
        "https://raw.githubusercontent.com/org/bad/main/.claude-plugin/marketplace.json"
      ) {
        return createTextResponse("not-json", 200);
      }
      if (url === "https://api.github.com/repos/org/good") {
        return createJsonResponse({ default_branch: "main" });
      }
      if (
        url ===
        "https://api.github.com/repos/org/good/contents/.claude-plugin/marketplace.json?ref=main"
      ) {
        return createJsonResponse(
          createBase64JsonFilePayload({
            name: "good",
            metadata: {
              description: "Good marketplace",
              version: "2.0.0",
            },
            plugins: [],
          }),
        );
      }
      if (url === "https://api.github.com/repos/org/bad") {
        return createJsonResponse({ default_branch: "main" });
      }
      if (
        url ===
        "https://api.github.com/repos/org/bad/contents/.claude-plugin/marketplace.json?ref=main"
      ) {
        return createJsonResponse(createBase64TextFilePayload("not-json"));
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, async () => {
      const results = await service.syncAllMarketplaces({ projectRoot });

      assert.deepEqual(results, [
        {
          id: "good",
          success: true,
          hasUpdate: true,
          skillsUpdated: [],
          skillsConflicted: [],
          skillSyncErrors: [],
          skillsRemoved: [],
          skillsSourceMissing: [],
          pendingRemovals: [],
          agentInventoryUnavailable: false,
        },
        {
          id: "bad",
          success: false,
          error: results[1].error,
        },
      ]);
      assert.match(results[1].error, /Unexpected token|JSON/i);
    });
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("isSameRepositorySource matches by durable repo identity only", () => {
  const { service, restore } = loadMarketplaceService();
  try {
    const match = service.isSameRepositorySource;
    // GitHub: case-insensitive repo, ref-agnostic.
    assert.equal(
      match(
        { type: "github", repo: "anthropics/skills", ref: "main" },
        { type: "github", repo: "Anthropics/Skills", ref: "dev" },
      ),
      true,
    );
    assert.equal(
      match(
        { type: "github", repo: "anthropics/skills" },
        { type: "github", repo: "anthropics/other" },
      ),
      false,
    );
    // GitLab: host case-insensitive, projectPath case-sensitive.
    assert.equal(
      match(
        { type: "gitlab", host: "git.example.invalid", projectPath: "ai/skills" },
        { type: "gitlab", host: "example.invalid", projectPath: "ai/skills" },
      ),
      true,
    );
    assert.equal(
      match(
        { type: "gitlab", host: "example.invalid", projectPath: "ai/Skills" },
        { type: "gitlab", host: "example.invalid", projectPath: "ai/skills" },
      ),
      false,
    );
    // URL: exact normalized string; cross-type never matches.
    assert.equal(
      match(
        { type: "url", url: "https://example.com/marketplace.json" },
        { type: "url", url: "https://example.com/marketplace.json" },
      ),
      true,
    );
    assert.equal(
      match(
        { type: "github", repo: "anthropics/skills" },
        { type: "gitlab", host: "x", projectPath: "anthropics/skills" },
      ),
      false,
    );
  } finally {
    restore();
  }
});

test("addMarketplace persists the normalized object source verbatim for ref round-trips", async () => {
  const projectRoot = createTempDir("marketplace-verbatim-source-");
  const { service, restore } = loadMarketplaceService();
  try {
    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [],
      installedSkills: [],
    });
    await withMockFetch(async (url) => {
      if (url === "https://api.github.com/repos/anthropics/skills") {
        return createJsonResponse({ default_branch: "main" });
      }
      if (
        url ===
        "https://api.github.com/repos/anthropics/skills/contents/.claude-plugin/marketplace.json?ref=main"
      ) {
        return createJsonResponse(
          createBase64TextFilePayload(
            JSON.stringify({
              name: "acme-skills",
              owner: { name: "Acme" },
              metadata: { description: "Acme skills", version: "1.0.0" },
              plugins: [
                { name: "acme-skills", source: "./", skills: ["./skills/widget"] },
              ],
            }),
          ),
        );
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, async () => {
      const added = await service.addMarketplace({
        projectRoot,
        sourceInput: { type: "github", repo: "anthropics/skills", ref: "main" },
      });
      // The persisted source is the exact object shape an agent bundle's git
      // ref carries, so a cross-machine install can feed it straight back
      // into normalizeMarketplaceSourceInput.
      const config = readJson(path.join(projectRoot, "marketplaces.json"));
      const entry = config.marketplaces.find((m) => m.id === added.id);
      assert.equal(entry.source.type, "github");
      assert.equal(entry.source.repo, "anthropics/skills");
      assert.equal(entry.source.ref, "main");
      const roundTrip = service.normalizeMarketplaceSourceInput(entry.source);
      assert.equal(
        service.isSameRepositorySource(roundTrip, entry.source),
        true,
      );
    });
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

// ---------------------------------------------------------------------------
// Round 9: marketplace add-gate policy (allowlist) + grandfathering.
// ---------------------------------------------------------------------------

test("addMarketplace rejects non-allowlisted sources before any network request", async () => {
  const projectRoot = createTempDir("marketplace-policy-reject-");
  const { service, restore } = loadMarketplaceService();
  const fetchedUrls = [];
  try {
    await withMockFetch(async (url) => {
      fetchedUrls.push(url);
      return createJsonResponse({ message: "Not Found" }, 404);
    }, async () => {
      for (const sourceInput of [
        "zstevens/portico-skills-marketplace",
        "https://github.com/example/random-skills",
        "https://example.com/.claude-plugin/marketplace.json",
        { type: "github", repo: "example/random-skills" },
      ]) {
        await assert.rejects(
          service.addMarketplace({ projectRoot, sourceInput }),
          (error) => {
            assert.equal(error.code, "marketplace_source_not_allowed");
            assert.match(error.message, /code\.corp\.portico\.com/);
            assert.match(error.message, /anthropics\/skills/);
            assert.match(error.message, /anthropics\/knowledge-work-plugins/);
            return true;
          },
        );
      }
    });

    assert.deepEqual(fetchedUrls, [], "the policy gate fires before any fetch");
    assert.equal(
      fs.existsSync(path.join(projectRoot, "marketplaces.json")),
      false,
      "nothing was persisted for a rejected add",
    );
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("addMarketplace accepts the Anthropic knowledge-work-plugins repo through the gate", async () => {
  const projectRoot = createTempDir("marketplace-policy-accept-");
  const { service, restore } = loadMarketplaceService();
  const manifest = {
    name: "knowledge-work-plugins",
    owner: { name: "Anthropic" },
    metadata: { description: "Knowledge work plugins", version: "1.0.0" },
    plugins: [
      {
        name: "productivity",
        description: "Productivity skills",
        skills: ["./productivity/skills/planner"],
      },
    ],
  };
  try {
    await withMockFetch(async (url) => {
      if (
        url ===
        "https://raw.githubusercontent.com/Anthropics/Knowledge-Work-Plugins/main/.claude-plugin/marketplace.json"
      ) {
        return createTextResponse(JSON.stringify(manifest));
      }
      return createJsonResponse({ message: "Not Found" }, 404);
    }, async () => {
      // Mixed-case + .git suffix still normalizes into the allowlist.
      const marketplace = await service.addMarketplace({
        projectRoot,
        sourceInput: "https://github.com/Anthropics/Knowledge-Work-Plugins.git",
      });
      assert.equal(marketplace.id, "knowledge-work-plugins");
      assert.equal(marketplace.source.repo, "Anthropics/Knowledge-Work-Plugins");
    });
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("policy gate: a pre-existing non-allowlisted marketplace still syncs and installs (grandfathered)", async () => {
  const projectRoot = createTempDir("marketplace-grandfather-");
  const { service, restore } = loadMarketplaceService();
  const manifest = createSyncTestMarketplaceManifest();
  const archiveBuffer = createTarballBuffer("portico-skills-marketplace-main", {
    "skills/smart-slides-iql-metrics/SKILL.md": createSkillMarkdown("2.0"),
  });

  try {
    writeJson(
      path.join(projectRoot, "marketplaces.json"),
      createSyncTestConfig([], manifest),
    );

    await withMockSyncTestMarketplace(archiveBuffer, manifest, async () => {
      // The zstevens GitHub repo is NOT allowlisted, but it was already on
      // this machine: sync and install must keep working for personal use.
      const syncResult = await service.syncMarketplace({
        projectRoot,
        marketplaceId: "zstevens-portico-skills",
      });
      assert.equal(syncResult.marketplace.id, "zstevens-portico-skills");

      const installResult = await service.installMarketplaceSkill({
        projectRoot,
        marketplaceId: "zstevens-portico-skills",
        skillId: "smart-slides-iql-metrics",
        skillPath: "./skills/smart-slides-iql-metrics",
      });
      assert.equal(
        installResult.localPath,
        "skills-marketplace/zstevens-portico-skills/smart-slides-iql-metrics",
      );
      assert.equal(
        fs.existsSync(
          path.join(projectRoot, installResult.localPath, "SKILL.md"),
        ),
        true,
      );

      // But ADDING the same repo fresh is still rejected.
      await assert.rejects(
        service.addMarketplace({
          projectRoot,
          sourceInput: "zstevens/portico-skills-marketplace",
        }),
        (error) => error.code === "marketplace_source_not_allowed",
      );
    });
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

// ---------------------------------------------------------------------------
// Round 9: canonical plugin format — nested-SKILL.md prune, FQN identity,
// plugin-aware installs, external-plugin policy, conflict guards.
// ---------------------------------------------------------------------------

function createKwpFixtureManifest() {
  return {
    name: "kwp-fixture",
    owner: { name: "Anthropic" },
    metadata: { description: "Knowledge work fixture", version: "1.0.0" },
    plugins: [
      { name: "zoom-plugin", description: "Zoom tools", source: "./zoom-plugin" },
      {
        name: "plugin-a",
        description: "Plugin A",
        skills: ["./plugin-a/skills/android"],
      },
      {
        name: "plugin-b",
        description: "Plugin B",
        skills: ["./plugin-b/skills/android"],
      },
      {
        name: "external-plugin",
        description: "Third-party plugin",
        source: { source: "github", repo: "third-party/tools" },
      },
      { name: "single", description: "Single-skill plugin", source: "./single" },
    ],
  };
}

function createKwpFixtureArchive(manifest) {
  return createTarballBuffer("knowledge-work-plugins-main", {
    ".claude-plugin/marketplace.json": JSON.stringify(manifest, null, 2),
    "zoom-plugin/skills/contact-center/SKILL.md": createSkillMarkdown("1.0", "Contact Center"),
    "zoom-plugin/skills/contact-center/android/SKILL.md": createSkillMarkdown("1.0", "Nested Android Reference"),
    "zoom-plugin/skills/meeting-sdk/SKILL.md": createSkillMarkdown("1.0", "Meeting SDK"),
    "zoom-plugin/skills/meeting-sdk/android/SKILL.md": createSkillMarkdown("1.0", "Nested Android Reference"),
    "plugin-a/skills/android/SKILL.md": createSkillMarkdown("1.0", "Android A"),
    "plugin-b/skills/android/SKILL.md": createSkillMarkdown("2.0", "Android B"),
    "single/SKILL.md": createSkillMarkdown("1.0", "Single"),
  });
}

async function withMockKwpFixture(archiveBuffer, manifest, callback) {
  const requestedUrls = [];
  const result = await withMockFetch(async (url) => {
    requestedUrls.push(url);
    if (url === "https://api.github.com/repos/anthropics/knowledge-work-plugins") {
      return createJsonResponse({ default_branch: "main" });
    }
    if (
      url ===
      "https://api.github.com/repos/anthropics/knowledge-work-plugins/contents/.claude-plugin/marketplace.json?ref=main"
    ) {
      return createJsonResponse(createBase64JsonFilePayload(manifest));
    }
    if (
      url ===
      "https://codeload.github.com/anthropics/knowledge-work-plugins/tar.gz/main"
    ) {
      return createBinaryResponse(archiveBuffer);
    }
    return createJsonResponse({ message: "Not Found" }, 404);
  }, callback);
  return { result, requestedUrls };
}

function kwpFixtureConfigEntry(manifest) {
  return {
    id: "kwp-fixture",
    name: "kwp-fixture",
    source: {
      type: "github",
      repo: "anthropics/knowledge-work-plugins",
      ref: "main",
    },
    cachedManifest: manifest,
    marketplaceVersion: "1.0.0",
  };
}

test("kwp-shaped manifests load without duplicate-leaf errors: nested SKILL.md dirs are pruned, externals degrade, singles stay flat", async () => {
  const { service, restore } = loadMarketplaceService();
  const manifest = createKwpFixtureManifest();
  const archiveBuffer = createKwpFixtureArchive(manifest);

  try {
    const { requestedUrls } = await withMockKwpFixture(archiveBuffer, manifest, async () => {
      const definition = await service.loadMarketplaceDefinition({
        type: "github",
        repo: "anthropics/knowledge-work-plugins",
      });

      const zoom = definition.manifest.plugins.find((p) => p.name === "zoom-plugin");
      assert.deepEqual(zoom.skills, [
        "./zoom-plugin/skills/contact-center",
        "./zoom-plugin/skills/meeting-sdk",
      ]);
      assert.equal(zoom.unavailable, undefined);

      const external = definition.manifest.plugins.find(
        (p) => p.name === "external-plugin",
      );
      assert.equal(external.unavailable, true);
      assert.equal(external.unavailableReason, "source_not_allowed");

      const single = definition.manifest.plugins.find((p) => p.name === "single");
      assert.equal(single.skills, undefined, "root SKILL.md keeps it a single-skill plugin");

      const skills = service.parseSkillsFromManifest(definition.manifest, "kwp-fixture");
      const contactCenter = skills.find((s) => s.id === "contact-center");
      assert.equal(contactCenter.pluginName, "zoom-plugin");
      const androids = skills.filter((s) => s.id === "android");
      assert.deepEqual(
        androids.map((s) => s.pluginName).sort(),
        ["plugin-a", "plugin-b"],
        "duplicate leaf ids stay distinct through pluginName",
      );
      const singleSkill = skills.find((s) => s.id === "single");
      assert.equal(singleSkill.pluginName, null);
      const externalSkill = skills.find((s) => s.id === "external-plugin");
      assert.equal(externalSkill.available, false);
      assert.equal(externalSkill.unavailableReason, "source_not_allowed");
    });

    assert.equal(
      requestedUrls.some((url) => url.includes("third-party")),
      false,
      "disallowed external plugin sources are never fetched",
    );
  } finally {
    restore();
  }
});

test("plugin-aware install lands {mp}/{plugin}/{leaf}, keeps nested reference dirs, and duplicate leaves coexist", async () => {
  const projectRoot = createTempDir("marketplace-plugin-install-");
  const { service, restore } = loadMarketplaceService();
  const manifest = createKwpFixtureManifest();
  const archiveBuffer = createKwpFixtureArchive(manifest);

  try {
    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [kwpFixtureConfigEntry(manifest)],
      installedSkills: [],
    });

    await withMockKwpFixture(archiveBuffer, manifest, async () => {
      const contact = await service.installMarketplaceSkill({
        projectRoot,
        marketplaceId: "kwp-fixture",
        skillId: "contact-center",
        skillPath: "./zoom-plugin/skills/contact-center",
        pluginName: "zoom-plugin",
      });
      assert.equal(
        contact.localPath,
        "skills-marketplace/kwp-fixture/zoom-plugin/contact-center",
      );
      // The nested android SKILL.md is reference material INSIDE the one
      // installed skill, not a second install.
      assert.equal(
        fs.existsSync(
          path.join(projectRoot, contact.localPath, "android", "SKILL.md"),
        ),
        true,
      );

      const androidA = await service.installMarketplaceSkill({
        projectRoot,
        marketplaceId: "kwp-fixture",
        skillId: "android",
        skillPath: "./plugin-a/skills/android",
        pluginName: "plugin-a",
      });
      const androidB = await service.installMarketplaceSkill({
        projectRoot,
        marketplaceId: "kwp-fixture",
        skillId: "android",
        skillPath: "./plugin-b/skills/android",
        pluginName: "plugin-b",
      });
      assert.equal(androidA.localPath, "skills-marketplace/kwp-fixture/plugin-a/android");
      assert.equal(androidB.localPath, "skills-marketplace/kwp-fixture/plugin-b/android");

      const config = readJson(path.join(projectRoot, "marketplaces.json"));
      const androidRecords = config.installedSkills.filter((s) => s.skillId === "android");
      assert.deepEqual(
        androidRecords.map((s) => s.pluginName).sort(),
        ["plugin-a", "plugin-b"],
      );

      // Catalog reports installed state by the exact triple.
      const { skills } = await service.getMarketplaceSkills({
        projectRoot,
        marketplaceId: "kwp-fixture",
      });
      const androids = skills.filter((s) => s.id === "android");
      assert.equal(androids.every((s) => s.installed), true);
      const meetingSdk = skills.find((s) => s.id === "meeting-sdk");
      assert.equal(meetingSdk.installed, false);

      // Same triple again → already installed.
      await assert.rejects(
        service.installMarketplaceSkill({
          projectRoot,
          marketplaceId: "kwp-fixture",
          skillId: "android",
          skillPath: "./plugin-a/skills/android",
          pluginName: "plugin-a",
        }),
        (error) => error.code === "skill_already_installed",
      );

      // Bare-leaf uninstall of a duplicated leaf is ambiguous...
      await assert.rejects(
        service.uninstallMarketplaceSkill({
          projectRoot,
          marketplaceId: "kwp-fixture",
          skillId: "android",
        }),
        (error) => error.code === "marketplace_skill_ambiguous",
      );

      // ...while the plugin-qualified uninstall removes exactly one and
      // prunes the now-empty plugin directory.
      await service.uninstallMarketplaceSkill({
        projectRoot,
        marketplaceId: "kwp-fixture",
        skillId: "android",
        pluginName: "plugin-a",
      });
      assert.equal(
        fs.existsSync(path.join(projectRoot, "skills-marketplace/kwp-fixture/plugin-a")),
        false,
        "empty plugin dir pruned",
      );
      assert.equal(
        fs.existsSync(path.join(projectRoot, "skills-marketplace/kwp-fixture/plugin-b/android")),
        true,
        "the other plugin's android untouched",
      );

      // Bare-leaf uninstall now resolves uniquely to plugin-b's android.
      await service.uninstallMarketplaceSkill({
        projectRoot,
        marketplaceId: "kwp-fixture",
        skillId: "android",
      });
      const finalConfig = readJson(path.join(projectRoot, "marketplaces.json"));
      assert.equal(
        finalConfig.installedSkills.filter((s) => s.skillId === "android").length,
        0,
      );
    });
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("installMarketplaceSkill rejects unavailable plugins and disallowed external skill sources", async () => {
  const projectRoot = createTempDir("marketplace-external-install-");
  const { service, restore } = loadMarketplaceService();
  const manifest = createKwpFixtureManifest();
  manifest.plugins = manifest.plugins.map((plugin) =>
    plugin.name === "external-plugin"
      ? { ...plugin, unavailable: true, unavailableReason: "source_not_allowed" }
      : plugin,
  );

  try {
    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [kwpFixtureConfigEntry(manifest)],
      installedSkills: [],
    });

    await withMockFetch(async () => createJsonResponse({ message: "no network" }, 500), async () => {
      // Install into an unavailable plugin is rejected before any network.
      await assert.rejects(
        service.installMarketplaceSkill({
          projectRoot,
          marketplaceId: "kwp-fixture",
          skillId: "some-skill",
          skillPath: "./skills/some-skill",
          pluginName: "external-plugin",
        }),
        (error) => error.code === "marketplace_plugin_unavailable",
      );

      // An explicit cross-repo object source failing the allowlist is the
      // backstop even when the UI lies about plugin availability.
      await assert.rejects(
        service.installMarketplaceSkill({
          projectRoot,
          marketplaceId: "kwp-fixture",
          skillId: "tool",
          skillPath: "./tool",
          skillSource: { type: "github", repo: "third-party/tools" },
        }),
        (error) => error.code === "marketplace_source_not_allowed",
      );

      // Unsafe plugin directory segments never reach the filesystem.
      await assert.rejects(
        service.installMarketplaceSkill({
          projectRoot,
          marketplaceId: "kwp-fixture",
          skillId: "x",
          skillPath: "./x",
          pluginName: "../escape",
        }),
        (error) => error.code === "marketplace_plugin_invalid",
      );
    });
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("install destination conflict guards protect existing skills in both layouts", async () => {
  const projectRoot = createTempDir("marketplace-conflict-guard-");
  const { service, restore } = loadMarketplaceService();
  const manifest = createKwpFixtureManifest();

  try {
    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [kwpFixtureConfigEntry(manifest)],
      installedSkills: [
        {
          marketplaceId: "kwp-fixture",
          skillId: "zoom-plugin",
          installedVersion: "1.0",
          localPath: "skills-marketplace/kwp-fixture/zoom-plugin",
        },
        {
          marketplaceId: "kwp-fixture",
          skillId: "leaf",
          pluginName: "tools",
          installedVersion: "1.0",
          localPath: "skills-marketplace/kwp-fixture/tools/leaf",
        },
      ],
    });
    fs.mkdirSync(path.join(projectRoot, "skills-marketplace/kwp-fixture/zoom-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, "skills-marketplace/kwp-fixture/zoom-plugin/SKILL.md"),
      createSkillMarkdown("1.0"),
    );
    fs.mkdirSync(path.join(projectRoot, "skills-marketplace/kwp-fixture/tools/leaf"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, "skills-marketplace/kwp-fixture/tools/leaf/SKILL.md"),
      createSkillMarkdown("1.0"),
    );

    await withMockFetch(async () => createJsonResponse({ message: "no network" }, 500), async () => {
      // Plugin install whose plugin dir is an installed FLAT skill's dir.
      await assert.rejects(
        service.installMarketplaceSkill({
          projectRoot,
          marketplaceId: "kwp-fixture",
          skillId: "contact-center",
          skillPath: "./zoom-plugin/skills/contact-center",
          pluginName: "zoom-plugin",
        }),
        (error) => error.code === "marketplace_install_conflict",
      );

      // Flat install whose leaf dir is an existing plugin parent.
      await assert.rejects(
        service.installMarketplaceSkill({
          projectRoot,
          marketplaceId: "kwp-fixture",
          skillId: "tools",
          skillPath: "./tools",
        }),
        (error) => error.code === "marketplace_install_conflict",
      );
    });
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("a not-yet-migrated flat record reports its plugin-scoped catalog entry as installed", async () => {
  const projectRoot = createTempDir("marketplace-legacy-flat-");
  const { service, restore } = loadMarketplaceService();
  // Already-expanded cachedManifest (the persisted post-normalization form):
  // skills arrays only, so getMarketplaceSkills needs no inspection network.
  const manifest = {
    name: "kwp-fixture",
    owner: { name: "Anthropic" },
    metadata: { description: "Knowledge work fixture", version: "1.0.0" },
    plugins: [
      {
        name: "zoom-plugin",
        description: "Zoom tools",
        skills: [
          "./zoom-plugin/skills/contact-center",
          "./zoom-plugin/skills/meeting-sdk",
        ],
      },
    ],
  };

  try {
    const flatDir = path.join(projectRoot, "skills-marketplace/kwp-fixture/contact-center");
    fs.mkdirSync(flatDir, { recursive: true });
    fs.writeFileSync(path.join(flatDir, "SKILL.md"), createSkillMarkdown("1.0"));
    // Occupy the plugin destination with foreign content so the load-time
    // migration SKIPS this record — the legacy-flat fallback is exactly for
    // records the migration could not move.
    const occupiedDir = path.join(
      projectRoot,
      "skills-marketplace/kwp-fixture/zoom-plugin/contact-center",
    );
    fs.mkdirSync(occupiedDir, { recursive: true });
    fs.writeFileSync(path.join(occupiedDir, "unrelated.txt"), "occupied\n");
    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [kwpFixtureConfigEntry(manifest)],
      installedSkills: [
        {
          marketplaceId: "kwp-fixture",
          skillId: "contact-center",
          installedVersion: "1.0",
          localPath: "skills-marketplace/kwp-fixture/contact-center",
          skillPath: "./zoom-plugin/skills/contact-center",
        },
      ],
    });

    const { skills } = await service.getMarketplaceSkills({
      projectRoot,
      marketplaceId: "kwp-fixture",
    });
    const contactCenter = skills.find((s) => s.id === "contact-center");
    assert.equal(contactCenter.pluginName, "zoom-plugin");
    assert.equal(contactCenter.installed, true, "legacy-flat fallback matched");
    assert.equal(
      contactCenter.localPath,
      "skills-marketplace/kwp-fixture/contact-center",
    );
    // The record survived flat and functional; nothing was half-moved.
    assert.equal(fs.existsSync(path.join(flatDir, "SKILL.md")), true);
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("sparse manifests and unsafe plugin names always emit flat identities", () => {
  const { service, restore } = loadMarketplaceService();
  try {
    const sparse = service.synthesizeSparseManifest(
      { name: "sparse-repo", description: "Sparse", version: "1.0.0" },
      ["./skills/alpha", "./skills/beta"],
    );
    const sparseSkills = service.parseSkillsFromManifest(sparse, "sparse-repo", {
      sparse: true,
    });
    assert.deepEqual(
      sparseSkills.map((s) => [s.id, s.pluginName]),
      [
        ["alpha", null],
        ["beta", null],
      ],
    );

    const unsafeSkills = service.parseSkillsFromManifest(
      {
        name: "weird",
        plugins: [
          { name: "bad name!", description: "Unsafe", skills: ["./skills/x"] },
        ],
      },
      "weird",
    );
    assert.equal(unsafeSkills[0].pluginName, null, "unsafe plugin segment degrades to flat");
  } finally {
    restore();
  }
});

test("pruneNestedSkillPaths keeps only outermost SKILL.md directories", () => {
  const { service, restore } = loadMarketplaceService();
  try {
    assert.deepEqual(
      service.pruneNestedSkillPaths([
        "./skills/contact-center/android",
        "./skills/contact-center",
        "./skills/meeting-sdk",
        "./skills/meeting-sdk/linux/deep",
        "./other",
      ]),
      ["./other", "./skills/contact-center", "./skills/meeting-sdk"],
    );
    // A root skill swallows everything beneath it.
    assert.deepEqual(service.pruneNestedSkillPaths(["./", "./skills/a"]), ["./"]);
  } finally {
    restore();
  }
});

test("concurrent upsertInstalledSkillRecord calls keep every record (registry write lock)", async () => {
  const projectRoot = createTempDir("marketplace-upsert-race-test-");
  const { service, restore } = loadMarketplaceService();

  try {
    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [
        {
          id: "racekit",
          name: "racekit",
          source: {
            type: "gitlab",
            host: "example.invalid",
            projectPath: "anthropics/skills",
          },
        },
      ],
      installedSkills: [],
    });

    const skillIds = Array.from({ length: 8 }, (_, index) => `skill-${index}`);
    for (const skillId of skillIds) {
      const dir = path.join(projectRoot, "skills-marketplace", "racekit", skillId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), createSkillMarkdown("1.0.0"));
    }

    // The incident shape: N parallel installs finish their downloads together
    // and race the registry read-modify-write. Without serialization the last
    // writer wins and all other records vanish.
    await Promise.all(
      skillIds.map((skillId) =>
        service.upsertInstalledSkillRecord({
          projectRoot,
          marketplaceId: "racekit",
          skillId,
          localPath: `skills-marketplace/racekit/${skillId}`,
          installedVersion: "1.0.0",
        }),
      ),
    );

    const config = readJson(path.join(projectRoot, "marketplaces.json"));
    const recordedIds = config.installedSkills
      .map((entry) => entry.skillId)
      .sort();
    assert.deepEqual(recordedIds, [...skillIds].sort());
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("concurrent upsert and uninstall interleave keeps both effects", async () => {
  const projectRoot = createTempDir("marketplace-mixed-race-test-");
  const { service, restore } = loadMarketplaceService();

  try {
    const existingDir = path.join(
      projectRoot,
      "skills-marketplace",
      "racekit",
      "existing",
    );
    const incomingDir = path.join(
      projectRoot,
      "skills-marketplace",
      "racekit",
      "incoming",
    );
    fs.mkdirSync(existingDir, { recursive: true });
    fs.mkdirSync(incomingDir, { recursive: true });
    fs.writeFileSync(path.join(existingDir, "SKILL.md"), createSkillMarkdown("1.0.0"));
    fs.writeFileSync(path.join(incomingDir, "SKILL.md"), createSkillMarkdown("1.0.0"));

    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [
        {
          id: "racekit",
          name: "racekit",
          source: {
            type: "gitlab",
            host: "example.invalid",
            projectPath: "anthropics/skills",
          },
        },
      ],
      installedSkills: [
        {
          marketplaceId: "racekit",
          skillId: "existing",
          installedVersion: "1.0.0",
          localPath: "skills-marketplace/racekit/existing",
        },
      ],
    });

    await Promise.all([
      service.upsertInstalledSkillRecord({
        projectRoot,
        marketplaceId: "racekit",
        skillId: "incoming",
        localPath: "skills-marketplace/racekit/incoming",
        installedVersion: "1.0.0",
      }),
      service.uninstallMarketplaceSkill({
        projectRoot,
        marketplaceId: "racekit",
        skillId: "existing",
      }),
    ]);

    const config = readJson(path.join(projectRoot, "marketplaces.json"));
    assert.deepEqual(
      config.installedSkills.map((entry) => entry.skillId),
      ["incoming"],
    );
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("removeInstalledSkillRecords filters by identity (plugin wildcard) and by localPath", async () => {
  const projectRoot = createTempDir("marketplace-remove-records-test-");
  const { service, restore } = loadMarketplaceService();

  try {
    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [
        {
          id: "racekit",
          name: "racekit",
          source: {
            type: "gitlab",
            host: "example.invalid",
            projectPath: "anthropics/skills",
          },
        },
      ],
      installedSkills: [
        {
          marketplaceId: "racekit",
          skillId: "alpha",
          pluginName: "sales",
          installedVersion: "1.0.0",
          localPath: "skills-marketplace/racekit/sales/alpha",
        },
        {
          marketplaceId: "racekit",
          skillId: "alpha",
          pluginName: "legal",
          installedVersion: "1.0.0",
          localPath: "skills-marketplace/racekit/legal/alpha",
        },
        {
          marketplaceId: "racekit",
          skillId: "beta",
          installedVersion: "1.0.0",
          localPath: "skills-marketplace/racekit/beta",
        },
        {
          marketplaceId: "racekit",
          skillId: "gamma",
          installedVersion: "1.0.0",
          localPath: "skills-marketplace/racekit/gamma",
        },
      ],
    });

    // Identity without pluginName removes the pair across every plugin scope
    // (the semantics the ipc.js deleteSkill sites relied on).
    const identityResult = await service.removeInstalledSkillRecords(
      projectRoot,
      { identities: [{ marketplaceId: "racekit", skillId: "alpha" }] },
    );
    assert.equal(identityResult.removed, 2);

    const pathResult = await service.removeInstalledSkillRecords(projectRoot, {
      localPaths: ["skills-marketplace/racekit/beta"],
    });
    assert.equal(pathResult.removed, 1);

    // Scoped identity only touches its own plugin scope.
    const scopedNoMatch = await service.removeInstalledSkillRecords(
      projectRoot,
      {
        identities: [
          { marketplaceId: "racekit", skillId: "gamma", pluginName: "sales" },
        ],
      },
    );
    assert.equal(scopedNoMatch.removed, 0);

    const config = readJson(path.join(projectRoot, "marketplaces.json"));
    assert.deepEqual(
      config.installedSkills.map((entry) => entry.skillId),
      ["gamma"],
    );
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("runStartupMarketplaceIntegrityPass adopts orphans under the stubbed OOTB harness", async () => {
  const projectRoot = createTempDir("marketplace-integrity-harness-test-");
  const { service, restore } = loadMarketplaceService();

  try {
    writeJson(path.join(projectRoot, "marketplaces.json"), {
      version: "1.0",
      marketplaces: [
        {
          id: "racekit",
          name: "racekit",
          source: {
            type: "gitlab",
            host: "example.invalid",
            projectPath: "anthropics/skills",
          },
          isSparse: false,
          cachedManifest: {
            name: "racekit",
            plugins: [
              { name: "orphaned", description: "Orphaned", source: "./orphaned" },
            ],
          },
        },
      ],
      installedSkills: [],
    });
    const dir = path.join(projectRoot, "skills-marketplace", "racekit", "orphaned");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), createSkillMarkdown("1.0.0"));

    const result = await service.runStartupMarketplaceIntegrityPass(projectRoot, {
      logger: { log() {}, warn() {}, error() {} },
    });
    assert.equal(result.adopted.length, 1);

    const config = readJson(path.join(projectRoot, "marketplaces.json"));
    assert.equal(config.installedSkills.length, 1);
    assert.equal(config.installedSkills[0].skillId, "orphaned");
    assert.equal(config.installedSkills[0].localPath, "skills-marketplace/racekit/orphaned");
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

// ── Destructive sync: mirror truth for missing-upstream skills ───────────────

const MIRROR_MP_ID = "zstevens-portico-skills";
const MIRROR_PLUGIN = "zstevens-skills";

function mirrorRecord(skillId, overrides = {}) {
  return {
    marketplaceId: MIRROR_MP_ID,
    skillId,
    pluginName: MIRROR_PLUGIN,
    skillPath: `./skills/${skillId}`,
    installedVersion: "1.0.0",
    localPath: `skills-marketplace/${MIRROR_MP_ID}/${MIRROR_PLUGIN}/${skillId}`,
    ...overrides,
  };
}

function writeMirrorSkillDir(projectRoot, record, markdown) {
  const dir = path.join(projectRoot, record.localPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), markdown);
  return dir;
}

function mirrorAgentRef(id, name, relationship, leaves) {
  return { id, name, relationship, leaves: new Set(leaves) };
}

test("syncMarketplace mirror truth: unused missing skills removed silently (dirty included), in-use skills become pendingRemovals", async () => {
  const projectRoot = createTempDir("marketplace-mirror-sync-test-");
  const { service, restore } = loadMarketplaceService();
  const keptMarkdown = createSkillMarkdown("1.0.0", "Kept");
  const manifest = createSyncTestMarketplaceManifest(["./skills/kept-skill"]);
  const archiveBuffer = createTarballBuffer("portico-skills-marketplace-main", {
    "skills/kept-skill/SKILL.md": keptMarkdown,
  });

  try {
    const kept = mirrorRecord("kept-skill", {
      baseline: {
        version: "1.0.0",
        files: [{ path: "SKILL.md", sha256: sha256(keptMarkdown) }],
      },
      // Flagged missing by an earlier pass, alive again upstream now: the
      // successful sync must clear the verdict AND its removal stamp.
      sourceMissing: true,
      sourceMissingSince: "2026-08-01T00:00:00Z",
    });
    const goneUnused = mirrorRecord("gone-unused");
    // Locally edited AND unused: removed like everything else — the recorded
    // decision is NO auto-detach, ever.
    const goneDirty = mirrorRecord("gone-dirty", {
      baseline: {
        version: "1.0.0",
        files: [{ path: "SKILL.md", sha256: sha256("committed content") }],
      },
    });
    const goneEditable = mirrorRecord("gone-editable");
    const goneReadOnly = mirrorRecord("gone-readonly");

    writeMirrorSkillDir(projectRoot, kept, keptMarkdown);
    writeMirrorSkillDir(projectRoot, goneUnused, createSkillMarkdown("1.0.0", "Gone"));
    writeMirrorSkillDir(projectRoot, goneDirty, "---\nedited locally\n---\n");
    writeMirrorSkillDir(projectRoot, goneEditable, createSkillMarkdown("1.0.0", "Used"));
    writeMirrorSkillDir(projectRoot, goneReadOnly, createSkillMarkdown("1.0.0", "RO"));
    writeJson(
      path.join(projectRoot, "marketplaces.json"),
      createSyncTestConfig(
        [kept, goneUnused, goneDirty, goneEditable, goneReadOnly],
        manifest,
      ),
    );

    const result = await withMockSyncTestMarketplace(archiveBuffer, manifest, () =>
      service.syncMarketplace({
        projectRoot,
        marketplaceId: MIRROR_MP_ID,
        listAgentReferences: async () => [
          mirrorAgentRef("agent-edit", "Edit Agent", null, ["gone-editable"]),
          mirrorAgentRef("agent-ro", "RO Agent", "installed", ["gone-readonly"]),
          mirrorAgentRef("agent-idle", "Idle Agent", null, ["unrelated-skill"]),
        ],
      }),
    );

    // Silent removals: both unused records (dirty included), reported but
    // never surfaced as errors.
    assert.deepEqual(
      result.skillsRemoved.map((entry) => entry.skillId).sort(),
      ["gone-dirty", "gone-unused"],
    );
    assert.equal(result.skillSyncErrors.length, 0, "missing skills never churn as sync errors");
    assert.equal(result.agentInventoryUnavailable, false);

    // In-use records: pending consent, agents listed with read-only marking.
    assert.equal(result.pendingRemovals.length, 2);
    const editablePending = result.pendingRemovals.find((p) => p.skillId === "gone-editable");
    assert.deepEqual(editablePending.agents, [
      { id: "agent-edit", name: "Edit Agent", relationship: null, readOnly: false },
    ]);
    const readOnlyPending = result.pendingRemovals.find((p) => p.skillId === "gone-readonly");
    assert.deepEqual(readOnlyPending.agents, [
      { id: "agent-ro", name: "RO Agent", relationship: "installed", readOnly: true },
    ]);

    const config = readJson(path.join(projectRoot, "marketplaces.json"));
    const ids = config.installedSkills.map((entry) => entry.skillId).sort();
    assert.deepEqual(ids, ["gone-editable", "gone-readonly", "kept-skill"]);
    for (const skillId of ["gone-editable", "gone-readonly"]) {
      const record = config.installedSkills.find((entry) => entry.skillId === skillId);
      assert.equal(record.sourceMissing, true);
      assert.equal(
        record.sourceMissingSince,
        undefined,
        "sync is manifest-driven and never stamps a removal date — the sweep owns that",
      );
      assert.equal(record.hasUpdate, false);
      assert.equal(
        fs.existsSync(path.join(projectRoot, record.localPath)),
        true,
        "kept missing skills keep their payload",
      );
    }
    const keptRecord = config.installedSkills.find(
      (entry) => entry.skillId === "kept-skill",
    );
    assert.equal(keptRecord.sourceMissing, undefined, "alive path clears the verdict");
    assert.equal(keptRecord.sourceMissingSince, undefined, "…and its removal stamp");
    for (const skillId of ["gone-unused", "gone-dirty"]) {
      assert.equal(
        fs.existsSync(
          path.join(projectRoot, "skills-marketplace", MIRROR_MP_ID, MIRROR_PLUGIN, skillId),
        ),
        false,
        `${skillId} payload removed`,
      );
    }
    // The healthy skill synced normally.
    assert.equal(result.skillsUpToDate.length, 1);
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("syncMarketplace mirror truth fails closed without a verified agent inventory", async () => {
  const projectRoot = createTempDir("marketplace-mirror-failclosed-test-");
  const { service, restore } = loadMarketplaceService();
  const manifest = createSyncTestMarketplaceManifest(["./skills/kept-skill"]);
  const archiveBuffer = createTarballBuffer("portico-skills-marketplace-main", {
    "skills/kept-skill/SKILL.md": createSkillMarkdown("1.0.0", "Kept"),
  });

  const runSync = async (listAgentReferences) => {
    const goneUnused = mirrorRecord("gone-unused");
    writeMirrorSkillDir(projectRoot, goneUnused, createSkillMarkdown("1.0.0", "Gone"));
    writeJson(
      path.join(projectRoot, "marketplaces.json"),
      createSyncTestConfig([goneUnused], manifest),
    );
    return withMockSyncTestMarketplace(archiveBuffer, manifest, () =>
      service.syncMarketplace({
        projectRoot,
        marketplaceId: MIRROR_MP_ID,
        listAgentReferences,
      }),
    );
  };

  try {
    // No reader injected at all (legacy caller) and a throwing reader both
    // fail closed identically.
    for (const reader of [
      null,
      async () => {
        throw new Error("subagents down");
      },
    ]) {
      const result = await runSync(reader);
      assert.deepEqual(result.skillsRemoved, []);
      assert.deepEqual(result.pendingRemovals, []);
      assert.equal(result.agentInventoryUnavailable, true);
      assert.deepEqual(result.skillsSourceMissing, [
        { skillId: "gone-unused", pluginName: MIRROR_PLUGIN, agentsUnknown: true },
      ]);
      const config = readJson(path.join(projectRoot, "marketplaces.json"));
      assert.equal(config.installedSkills[0].sourceMissing, true);
      assert.equal(
        fs.existsSync(path.join(projectRoot, config.installedSkills[0].localPath)),
        true,
      );
    }
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("syncMarketplace mirror truth: OOTB-seeded missing skills are bundle-managed, never removed", async () => {
  const projectRoot = createTempDir("marketplace-mirror-seeded-test-");
  const { service, restore } = loadMarketplaceService();
  const manifest = createSyncTestMarketplaceManifest(["./skills/kept-skill"]);
  const archiveBuffer = createTarballBuffer("portico-skills-marketplace-main", {
    "skills/kept-skill/SKILL.md": createSkillMarkdown("1.0.0", "Kept"),
  });

  try {
    const seededGone = mirrorRecord("seeded-gone");
    const seededDir = writeMirrorSkillDir(
      projectRoot,
      seededGone,
      createSkillMarkdown("1.0.0", "Seeded"),
    );
    writeJson(
      path.join(projectRoot, "marketplaces.json"),
      createSyncTestConfig([seededGone], manifest),
    );
    // A distinct OOTB seed source listing the record makes it bundle-managed.
    writeJson(path.join(projectRoot, "marketplaces-ootb", "marketplaces.json"), {
      version: "1.0",
      marketplaces: [{ id: MIRROR_MP_ID, name: MIRROR_MP_ID, ootb: true }],
      installedSkills: [seededGone],
    });
    fs.mkdirSync(path.join(projectRoot, "marketplaces-ootb", "skills-marketplace"), {
      recursive: true,
    });

    const result = await withMockSyncTestMarketplace(archiveBuffer, manifest, () =>
      service.syncMarketplace({
        projectRoot,
        marketplaceId: MIRROR_MP_ID,
        listAgentReferences: async () => [],
      }),
    );

    assert.deepEqual(result.skillsRemoved, []);
    assert.deepEqual(result.pendingRemovals, []);
    assert.deepEqual(result.skillsSourceMissing, [
      { skillId: "seeded-gone", pluginName: MIRROR_PLUGIN, seeded: true },
    ]);
    assert.equal(fs.existsSync(seededDir), true);
    const config = readJson(path.join(projectRoot, "marketplaces.json"));
    const record = config.installedSkills.find((entry) => entry.skillId === "seeded-gone");
    assert.equal(record.sourceMissing, true);
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("syncMarketplace mirror truth: seeded missing skills IN USE get the consent flow (seeded pendingRemovals), quietly kept when usage is unverifiable", async () => {
  const projectRoot = createTempDir("marketplace-mirror-seeded-inuse-test-");
  const { service, restore } = loadMarketplaceService();
  const manifest = createSyncTestMarketplaceManifest(["./skills/kept-skill"]);
  const archiveBuffer = createTarballBuffer("portico-skills-marketplace-main", {
    "skills/kept-skill/SKILL.md": createSkillMarkdown("1.0.0", "Kept"),
  });

  try {
    const seededGone = mirrorRecord("seeded-gone");
    const seededDir = writeMirrorSkillDir(
      projectRoot,
      seededGone,
      createSkillMarkdown("1.0.0", "Seeded"),
    );
    writeJson(
      path.join(projectRoot, "marketplaces.json"),
      createSyncTestConfig([seededGone], manifest),
    );
    writeJson(path.join(projectRoot, "marketplaces-ootb", "marketplaces.json"), {
      version: "1.0",
      marketplaces: [{ id: MIRROR_MP_ID, name: MIRROR_MP_ID, ootb: true }],
      installedSkills: [seededGone],
    });
    fs.mkdirSync(path.join(projectRoot, "marketplaces-ootb", "skills-marketplace"), {
      recursive: true,
    });

    // In use by an editable agent: the user is owed the stop-or-unlink
    // decision even though the skill itself is bundle-managed.
    const result = await withMockSyncTestMarketplace(archiveBuffer, manifest, () =>
      service.syncMarketplace({
        projectRoot,
        marketplaceId: MIRROR_MP_ID,
        listAgentReferences: async () => [
          mirrorAgentRef("agent-edit", "Edit Agent", null, ["seeded-gone"]),
        ],
      }),
    );

    assert.deepEqual(result.skillsRemoved, []);
    assert.deepEqual(
      result.skillsSourceMissing,
      [],
      "a pending seeded skill is not double-reported as passively kept",
    );
    assert.deepEqual(JSON.parse(JSON.stringify(result.pendingRemovals)), [
      {
        skillId: "seeded-gone",
        pluginName: MIRROR_PLUGIN,
        seeded: true,
        leaf: "seeded-gone",
        agents: [
          { id: "agent-edit", name: "Edit Agent", relationship: null, readOnly: false },
        ],
      },
    ]);
    assert.equal(fs.existsSync(seededDir), true);
    let record = readJson(
      path.join(projectRoot, "marketplaces.json"),
    ).installedSkills.find((entry) => entry.skillId === "seeded-gone");
    assert.equal(record.sourceMissing, true);

    // Usage unverifiable (no inventory reader): fail closed, kept quietly —
    // the consent opportunity simply re-arises on the next sync.
    const failClosed = await withMockSyncTestMarketplace(archiveBuffer, manifest, () =>
      service.syncMarketplace({ projectRoot, marketplaceId: MIRROR_MP_ID }),
    );
    assert.deepEqual(failClosed.pendingRemovals, []);
    assert.deepEqual(failClosed.skillsSourceMissing, [
      { skillId: "seeded-gone", pluginName: MIRROR_PLUGIN, seeded: true },
    ]);
    assert.equal(failClosed.agentInventoryUnavailable, true);
    assert.equal(fs.existsSync(seededDir), true);
    record = readJson(
      path.join(projectRoot, "marketplaces.json"),
    ).installedSkills.find((entry) => entry.skillId === "seeded-gone");
    assert.equal(record.sourceMissing, true);
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("syncMarketplace mirror truth is repo-scoped: an external-source record is not masked by a same-path manifest entry", async () => {
  const projectRoot = createTempDir("marketplace-mirror-reposcope-test-");
  const { service, restore } = loadMarketplaceService();
  const manifest = createSyncTestMarketplaceManifest(["./skills/kept-skill"]);
  const archiveBuffer = createTarballBuffer("portico-skills-marketplace-main", {
    "skills/kept-skill/SKILL.md": createSkillMarkdown("1.0.0", "Kept"),
  });

  try {
    // Same PATH as the manifest's kept-skill entry, but pinned to another
    // repo entirely — its presence in this marketplace's manifest must not
    // mask that the external repo record has no manifest entry.
    const externalRecord = mirrorRecord("kept-skill", {
      pluginName: "external-plugin",
      localPath: `skills-marketplace/${MIRROR_MP_ID}/external-plugin/kept-skill`,
      skillSource: {
        type: "github",
        repo: "someone-else/other-repo",
        repoUrl: "https://github.com/someone-else/other-repo",
        ref: "main",
      },
    });
    writeMirrorSkillDir(projectRoot, externalRecord, createSkillMarkdown("1.0.0", "Ext"));
    writeJson(
      path.join(projectRoot, "marketplaces.json"),
      createSyncTestConfig([externalRecord], manifest),
    );

    const result = await withMockSyncTestMarketplace(archiveBuffer, manifest, () =>
      service.syncMarketplace({
        projectRoot,
        marketplaceId: MIRROR_MP_ID,
        listAgentReferences: async () => [],
      }),
    );

    assert.deepEqual(
      result.skillsRemoved.map((entry) => entry.skillId),
      ["kept-skill"],
    );
    assert.equal(result.skillSyncErrors.length, 0);
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

// ── applyMarketplaceSyncRemovals: the consented second phase ────────────────

function removalExecutorFixture(projectRoot, records) {
  for (const record of records) {
    writeMirrorSkillDir(projectRoot, record, createSkillMarkdown("1.0.0", record.skillId));
  }
  writeJson(
    path.join(projectRoot, "marketplaces.json"),
    createSyncTestConfig(records, createSyncTestMarketplaceManifest()),
  );
}

test("applyMarketplaceSyncRemovals unlinks editable agents across all reference shapes, flags read-only agents, removes targets", async () => {
  const projectRoot = createTempDir("marketplace-apply-removals-test-");
  const { service, restore } = loadMarketplaceService();

  try {
    const goneA = mirrorRecord("gone-a", { sourceMissing: true });
    const goneB = mirrorRecord("gone-b", { sourceMissing: true });
    removalExecutorFixture(projectRoot, [goneA, goneB]);

    const updates = [];
    const flags = [];
    const result = await service.applyMarketplaceSyncRemovals({
      projectRoot,
      marketplaceId: MIRROR_MP_ID,
      removals: [
        { skillId: "gone-a", pluginName: MIRROR_PLUGIN },
        { skillId: "gone-b", pluginName: MIRROR_PLUGIN },
      ],
      agentTools: {
        listAgents: async () => [
          {
            id: "agent-edit",
            name: "Edit Agent",
            relationship: null,
            readOnly: false,
            skillIds: [
              "gone-a",
              `${MIRROR_MP_ID}/gone-a`,
              `${MIRROR_MP_ID}/${MIRROR_PLUGIN}/gone-a`,
              "keep-me",
            ],
          },
          {
            id: "agent-ro",
            name: "RO Agent",
            relationship: "installed",
            readOnly: true,
            skillIds: ["gone-b", "keep-me"],
          },
        ],
        updateAgentSkillIds: async (agentId, skillIds) => {
          updates.push({ agentId, skillIds });
        },
        flagAgentsSkillsNotFound: async (entries) => {
          flags.push(...entries);
        },
      },
    });

    // Editable agent: every reference shape of gone-a removed, others kept.
    assert.deepEqual(updates, [{ agentId: "agent-edit", skillIds: ["keep-me"] }]);
    assert.deepEqual(result.agentsUpdated, [
      {
        id: "agent-edit",
        name: "Edit Agent",
        removed: ["gone-a", `${MIRROR_MP_ID}/gone-a`, `${MIRROR_MP_ID}/${MIRROR_PLUGIN}/gone-a`],
      },
    ]);
    // Read-only agent: never written, flagged instead.
    assert.deepEqual(flags, [
      { agentId: "agent-ro", agentName: "RO Agent", skills: ["gone-b"] },
    ]);
    assert.deepEqual(result.agentsFlagged, [{ id: "agent-ro", name: "RO Agent" }]);
    assert.deepEqual(result.agentsSkipped, []);

    // Both targets removed: records and payloads.
    assert.deepEqual(
      result.removed.map((entry) => entry.skillId).sort(),
      ["gone-a", "gone-b"],
    );
    const config = readJson(path.join(projectRoot, "marketplaces.json"));
    assert.equal(config.installedSkills.length, 0);
    assert.equal(
      fs.existsSync(path.join(projectRoot, "skills-marketplace", MIRROR_MP_ID)),
      false,
      "emptied parents pruned",
    );

    // Idempotent re-apply: everything reports not_installed, nothing throws.
    const rerun = await service.applyMarketplaceSyncRemovals({
      projectRoot,
      marketplaceId: MIRROR_MP_ID,
      removals: [{ skillId: "gone-a", pluginName: MIRROR_PLUGIN }],
      agentTools: { listAgents: async () => [] },
    });
    assert.deepEqual(rerun.removed, []);
    assert.deepEqual(rerun.skipped, [
      { skillId: "gone-a", pluginName: MIRROR_PLUGIN, reason: "not_installed" },
    ]);
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("applyMarketplaceSyncRemovals: a failed editable unlink keeps that skill installed", async () => {
  const projectRoot = createTempDir("marketplace-apply-unlinkfail-test-");
  const { service, restore } = loadMarketplaceService();

  try {
    const goneA = mirrorRecord("gone-a", { sourceMissing: true });
    const goneB = mirrorRecord("gone-b", { sourceMissing: true });
    removalExecutorFixture(projectRoot, [goneA, goneB]);

    const result = await service.applyMarketplaceSyncRemovals({
      projectRoot,
      marketplaceId: MIRROR_MP_ID,
      removals: [
        { skillId: "gone-a", pluginName: MIRROR_PLUGIN },
        { skillId: "gone-b", pluginName: MIRROR_PLUGIN },
      ],
      agentTools: {
        listAgents: async () => [
          {
            id: "agent-edit",
            name: "Edit Agent",
            relationship: null,
            readOnly: false,
            skillIds: ["gone-a"],
          },
        ],
        updateAgentSkillIds: async () => {
          const error = new Error("update rejected");
          error.code = "installed_copy_read_only";
          throw error;
        },
      },
    });

    assert.deepEqual(result.removed.map((entry) => entry.skillId), ["gone-b"]);
    assert.deepEqual(result.skipped, [
      { skillId: "gone-a", pluginName: MIRROR_PLUGIN, reason: "unlink_failed" },
    ]);
    assert.equal(result.agentsSkipped.length, 1);
    assert.equal(result.agentsSkipped[0].errorCode, "installed_copy_read_only");
    const config = readJson(path.join(projectRoot, "marketplaces.json"));
    assert.deepEqual(
      config.installedSkills.map((entry) => entry.skillId),
      ["gone-a"],
    );
    assert.equal(
      fs.existsSync(path.join(projectRoot, goneA.localPath)),
      true,
      "unlink-failed target keeps its payload",
    );
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("applyMarketplaceSyncRemovals re-verifies targets: not_missing, not_installed, and no-inventory refuse; seeded targets become keptSeeded", async () => {
  const projectRoot = createTempDir("marketplace-apply-guards-test-");
  const { service, restore } = loadMarketplaceService();

  try {
    const stillPresent = mirrorRecord("still-present");
    const seeded = mirrorRecord("seeded-gone", { sourceMissing: true });
    removalExecutorFixture(projectRoot, [stillPresent, seeded]);
    writeJson(path.join(projectRoot, "marketplaces-ootb", "marketplaces.json"), {
      version: "1.0",
      marketplaces: [{ id: MIRROR_MP_ID, name: MIRROR_MP_ID, ootb: true }],
      installedSkills: [seeded],
    });
    fs.mkdirSync(path.join(projectRoot, "marketplaces-ootb", "skills-marketplace"), {
      recursive: true,
    });

    const result = await service.applyMarketplaceSyncRemovals({
      projectRoot,
      marketplaceId: MIRROR_MP_ID,
      removals: [
        { skillId: "still-present", pluginName: MIRROR_PLUGIN },
        { skillId: "never-installed", pluginName: null },
        { skillId: "seeded-gone", pluginName: MIRROR_PLUGIN },
      ],
      agentTools: { listAgents: async () => [] },
    });
    assert.deepEqual(result.removed, []);
    assert.deepEqual(
      result.skipped.map((entry) => entry.reason).sort(),
      ["not_installed", "not_missing"],
    );
    // Seeded target: unlink-only outcome — record and payload stay in place.
    assert.deepEqual(result.keptSeeded, [
      { skillId: "seeded-gone", pluginName: MIRROR_PLUGIN },
    ]);
    const config = readJson(path.join(projectRoot, "marketplaces.json"));
    const record = config.installedSkills.find((entry) => entry.skillId === "seeded-gone");
    assert.equal(record.sourceMissing, true, "seeded record keeps its missing verdict");
    assert.equal(
      fs.existsSync(path.join(projectRoot, record.localPath)),
      true,
      "seeded payload never removed",
    );

    await assert.rejects(
      () =>
        service.applyMarketplaceSyncRemovals({
          projectRoot,
          marketplaceId: MIRROR_MP_ID,
          removals: [{ skillId: "seeded-gone", pluginName: MIRROR_PLUGIN }],
          agentTools: {},
        }),
      (error) => error.code === "agent_inventory_unavailable",
    );
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("applyMarketplaceSyncRemovals mixed batch: seeded target unlinks agents but stays; non-seeded is removed", async () => {
  const projectRoot = createTempDir("marketplace-apply-seeded-mix-test-");
  const { service, restore } = loadMarketplaceService();

  try {
    const seeded = mirrorRecord("seeded-gone", { sourceMissing: true });
    const plain = mirrorRecord("plain-gone", { sourceMissing: true });
    removalExecutorFixture(projectRoot, [seeded, plain]);
    writeJson(path.join(projectRoot, "marketplaces-ootb", "marketplaces.json"), {
      version: "1.0",
      marketplaces: [{ id: MIRROR_MP_ID, name: MIRROR_MP_ID, ootb: true }],
      installedSkills: [seeded],
    });
    fs.mkdirSync(path.join(projectRoot, "marketplaces-ootb", "skills-marketplace"), {
      recursive: true,
    });

    const updates = [];
    const flags = [];
    const result = await service.applyMarketplaceSyncRemovals({
      projectRoot,
      marketplaceId: MIRROR_MP_ID,
      removals: [
        { skillId: "seeded-gone", pluginName: MIRROR_PLUGIN },
        { skillId: "plain-gone", pluginName: MIRROR_PLUGIN },
      ],
      agentTools: {
        listAgents: async () => [
          {
            id: "agent-edit",
            name: "Edit Agent",
            relationship: null,
            readOnly: false,
            skillIds: ["seeded-gone", "plain-gone", "keep-me"],
          },
          {
            id: "agent-ro",
            name: "RO Agent",
            relationship: "installed",
            readOnly: true,
            skillIds: ["seeded-gone"],
          },
        ],
        updateAgentSkillIds: async (agentId, skillIds) => {
          updates.push({ agentId, skillIds });
        },
        flagAgentsSkillsNotFound: async (entries) => {
          flags.push(...entries);
        },
      },
    });

    // Both targets' references unlink from the editable agent in one write.
    assert.deepEqual(updates, [{ agentId: "agent-edit", skillIds: ["keep-me"] }]);
    // The read-only agent referencing the SEEDED skill is still flagged —
    // seeded changes only the skill outcome, never the agent handling.
    assert.deepEqual(flags, [
      { agentId: "agent-ro", agentName: "RO Agent", skills: ["seeded-gone"] },
    ]);

    assert.deepEqual(result.removed.map((entry) => entry.skillId), ["plain-gone"]);
    assert.deepEqual(result.keptSeeded, [
      { skillId: "seeded-gone", pluginName: MIRROR_PLUGIN },
    ]);
    const config = readJson(path.join(projectRoot, "marketplaces.json"));
    assert.deepEqual(
      config.installedSkills.map((entry) => entry.skillId),
      ["seeded-gone"],
      "non-seeded removed, seeded kept",
    );
    assert.equal(
      fs.existsSync(path.join(projectRoot, seeded.localPath)),
      true,
      "seeded payload intact",
    );
    assert.equal(
      fs.existsSync(path.join(projectRoot, plain.localPath)),
      false,
      "non-seeded payload removed",
    );
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

// ---- checkSkillUpdates coalescing (2026-08-14: concurrent surfaces queued
// behind the registry lock and each ran a FULL duplicate sweep — a 2.9s run
// immediately followed by an 18.8s duplicate during a marketplace blip) ----

function writeCoalesceFixture(projectRoot) {
  writeJson(path.join(projectRoot, "marketplaces.json"), {
    version: "1.0",
    marketplaces: [],
    installedSkills: [
      {
        marketplaceId: "ai-marketplace",
        skillId: "code-execution",
        skillPath: "./",
        installedVersion: "1.0",
        localPath: "skills-marketplace/ai-marketplace/code-execution",
        hasUpdate: false,
        remoteUpdatedAt: "2026-07-01T00:00:00Z",
        skillSource: { type: "ai-marketplace-solution", solutionId: "sol-code" },
      },
    ],
  });
}

test("concurrent headless sweeps share one run; a fresh result is reused within the window", async () => {
  const projectRoot = createTempDir("marketplace-coalesce-test-");
  const { service, restore } = loadMarketplaceService();
  try {
    writeCoalesceFixture(projectRoot);
    let sweeps = 0;
    const options = () => ({
      projectRoot,
      interactiveAuth: false,
      fetchSolution: async (solutionId) => {
        sweeps += 1;
        return { id: solutionId, updated_timestamp: "2026-07-01T00:00:00Z" };
      },
    });
    const [a, b] = await Promise.all([
      service.checkSkillUpdates(options()),
      service.checkSkillUpdates(options()),
    ]);
    assert.equal(sweeps, 1, "concurrent callers share one in-flight sweep");
    assert.equal(a, b, "both callers get the same result object");

    const c = await service.checkSkillUpdates(options());
    assert.equal(sweeps, 1, "a just-completed headless result is reused");
    assert.equal(c, a);
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});

test("the reuse window expires by clock and interactive sweeps never reuse results", async () => {
  const projectRoot = createTempDir("marketplace-coalesce-clock-test-");
  const { service, restore } = loadMarketplaceService();
  try {
    writeCoalesceFixture(projectRoot);
    let sweeps = 0;
    let now = 1_000_000;
    const options = (extra = {}) => ({
      projectRoot,
      interactiveAuth: false,
      nowMs: () => now,
      fetchSolution: async (solutionId) => {
        sweeps += 1;
        return { id: solutionId, updated_timestamp: "2026-07-01T00:00:00Z" };
      },
      ...extra,
    });
    await service.checkSkillUpdates(options());
    assert.equal(sweeps, 1);
    now += 15_001;
    await service.checkSkillUpdates(options());
    assert.equal(sweeps, 2, "past the window a fresh sweep runs");

    // Interactive calls bypass result reuse entirely (explicit user action).
    await service.checkSkillUpdates(options({ interactiveAuth: true }));
    await service.checkSkillUpdates(options({ interactiveAuth: true }));
    assert.equal(sweeps, 4, "interactive sweeps always run fresh");
  } finally {
    restore();
    cleanupDir(projectRoot);
  }
});
