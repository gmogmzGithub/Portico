const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const {
  DEFAULT_PROTOTYPES_BASE_URL,
  getConfiguredPrototypesBaseUrl,
  inferProjectType,
  packageArtifactAssets,
  publishArtifactToPrototypes,
  resolveArtifactPublishSource,
  resolveSnapshotArchivePath,
} = require("./artifact-publisher");

const execFileAsync = promisify(execFile);

async function writeFiles(rootPath, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(rootPath, relativePath);
    await fsPromises.mkdir(path.dirname(fullPath), { recursive: true });
    await fsPromises.writeFile(fullPath, content, "utf8");
  }
}

async function createSnapshotArchive(projectRoot, artifactId, version, files) {
  const sourceDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "portico-artifact-snapshot-src-"));
  const archivePath = path.join(projectRoot, "artifact-snapshots", artifactId, `v${version}.tar.gz`);
  try {
    await writeFiles(sourceDir, files);
    await fsPromises.mkdir(path.dirname(archivePath), { recursive: true });
    await execFileAsync("tar", ["-czf", archivePath, "-C", sourceDir, "."]);
    return archivePath;
  } finally {
    await fsPromises.rm(sourceDir, { recursive: true, force: true });
  }
}

async function writeArtifactMetadata(projectRoot, artifactId, metadata) {
  const metadataPath = path.join(projectRoot, "artifact-snapshots", artifactId, "metadata.json");
  await fsPromises.mkdir(path.dirname(metadataPath), { recursive: true });
  await fsPromises.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

test("artifact publisher targets production Prototypes", () => {
  assert.equal(getConfiguredPrototypesBaseUrl(), DEFAULT_PROTOTYPES_BASE_URL);
});

test("artifact publisher packages static HTML artifacts as text file uploads", async () => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "portico-artifact-html-"));
  try {
    await fsPromises.writeFile(path.join(tempDir, "index.html"), "<h1>Hello</h1>", "utf8");
    await fsPromises.writeFile(path.join(tempDir, "app.js"), "console.log('hi');", "utf8");
    await fsPromises.mkdir(path.join(tempDir, "node_modules"));
    await fsPromises.writeFile(path.join(tempDir, "node_modules", "ignored.js"), "ignored", "utf8");

    const result = await packageArtifactAssets(tempDir);

    assert.equal(result.projectType, "html");
    assert.deepEqual(
      result.files.map((file) => file.name),
      ["app.js", "index.html"],
    );
    assert.equal(result.files[0].encoding, "text");
  } finally {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});

test("artifact publisher infers TypeScript project uploads from source files", () => {
  assert.equal(
    inferProjectType([
      { name: "package.json" },
      { name: "src/App.tsx" },
      { name: "src/main.ts" },
    ]),
    "typescript",
  );
});

test("artifact publisher publishes the selected saved artifact version", async () => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "portico-artifact-root-"));
  const previousFetch = global.fetch;
  try {
    const artifactId = "artifact-1";
    await createSnapshotArchive(tempDir, artifactId, 1, {
      "index.html": "<h1>Version 1</h1>",
    });
    await createSnapshotArchive(tempDir, artifactId, 2, {
      "index.html": "<h1>Version 2</h1>",
      "src/App.tsx": "export default function App() { return <h1>v2</h1>; }",
    });
    await writeArtifactMetadata(tempDir, artifactId, {
      artifact_id: artifactId,
      chat_id: "chat-1",
      current_version: 2,
      versions: [
        {
          version: 1,
          snapshot_path: `/app/artifact-snapshots/${artifactId}/v1.tar.gz`,
        },
        {
          version: 2,
          snapshot_path: `/app/artifact-snapshots/${artifactId}/v2.tar.gz`,
        },
      ],
    });

    const prototypeRequests = [];
    global.fetch = async (requestUrl, options = {}) => {
      const url = String(requestUrl);
      if (url.startsWith("http://127.0.0.1:7280/")) {
        return { ok: true, status: 204, text: async () => "" };
      }

      const parsedBody = options.body ? JSON.parse(options.body) : null;
      prototypeRequests.push({ url, method: options.method || "GET", body: parsedBody });
      if (url.endsWith("/api/gitlab/availability")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ available: true }),
        };
      }
      if (url.endsWith("/api/projects")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ project: { _id: "project-1", slug: "project-1" } }),
        };
      }
      if (url.includes("/trigger-pipeline")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ branch: "main" }),
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const result = await publishArtifactToPrototypes({
      artifactId,
      chatId: "chat-1",
      name: "Snapshot Publish",
      version: 2,
      projectRoot: tempDir,
      electronSession: {
        cookies: {
          get: async () => [
            { name: "koa.sess", value: "session" },
            { name: "ldapUsername", value: "publisher" },
          ],
        },
      },
    });

    const uploadRequest = prototypeRequests.find((request) =>
      request.url.includes("/trigger-pipeline"),
    );
    assert.equal(result.success, true);
    assert.equal(result.projectType, "typescript");
    assert.ok(uploadRequest, "publish should upload files to Prototypes");
    assert.deepEqual(
      uploadRequest.body.files.map((file) => file.name).sort(),
      ["index.html", "src/App.tsx"],
    );
    assert.equal(
      uploadRequest.body.files.find((file) => file.name === "index.html").content,
      "<h1>Version 2</h1>",
    );
    assert.equal(
      fs.existsSync(path.join(tempDir, "workspaces", "chat-1", "artifacts", artifactId)),
      false,
      "publishing saved snapshots should not require the legacy visible artifact root",
    );
  } finally {
    global.fetch = previousFetch;
    if (fs.existsSync(tempDir)) {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    }
  }
});

test("artifact publisher rejects mismatched artifact chat metadata", async () => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "portico-artifact-chat-mismatch-"));
  try {
    const artifactId = "artifact-1";
    await writeArtifactMetadata(tempDir, artifactId, {
      artifact_id: artifactId,
      chat_id: "other-chat",
      versions: [{ version: 1, snapshot_path: `/app/artifact-snapshots/${artifactId}/v1.tar.gz` }],
    });

    await assert.rejects(
      () =>
        resolveArtifactPublishSource({
          projectRoot: tempDir,
          chatId: "chat-1",
          artifactId,
          version: 1,
          fetchArtifactMetadata: null,
        }),
      /does not belong/,
    );
  } finally {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});

test("artifact publisher reports unavailable selected versions when the snapshot archive is missing", async () => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "portico-artifact-missing-snapshot-"));
  try {
    const artifactId = "artifact-1";
    await writeArtifactMetadata(tempDir, artifactId, {
      artifact_id: artifactId,
      chat_id: "chat-1",
      versions: [{ version: 2, snapshot_path: `/app/artifact-snapshots/${artifactId}/v2.tar.gz` }],
    });

    await assert.rejects(
      () =>
        resolveArtifactPublishSource({
          projectRoot: tempDir,
          chatId: "chat-1",
          artifactId,
          version: 2,
          fetchArtifactMetadata: null,
        }),
      /Selected artifact version files are unavailable/,
    );
  } finally {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});

test("artifact publisher translates container snapshot paths to host snapshot paths", async () => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "portico-artifact-path-"));
  try {
    assert.equal(
      resolveSnapshotArchivePath(tempDir, "/app/artifact-snapshots/artifact-1/v2.tar.gz"),
      path.join(tempDir, "artifact-snapshots", "artifact-1", "v2.tar.gz"),
    );
  } finally {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});

test("artifact publisher can resolve metadata from MCPO artifact listings", async () => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "portico-artifact-mcpo-"));
  try {
    const artifactId = "artifact-1";
    await createSnapshotArchive(tempDir, artifactId, 1, {
      "index.html": "<h1>MCPO metadata</h1>",
    });

    const source = await resolveArtifactPublishSource({
      projectRoot: tempDir,
      chatId: "chat-1",
      artifactId,
      version: 1,
      fetchArtifactMetadata: async () => ({
        artifact_id: artifactId,
        chat_id: "chat-1",
        versions: [{ version: 1, snapshot_path: `/app/artifact-snapshots/${artifactId}/v1.tar.gz` }],
      }),
    });
    try {
      const packaged = await packageArtifactAssets(source.rootPath);
      assert.equal(packaged.files.find((file) => file.name === "index.html").content, "<h1>MCPO metadata</h1>");
    } finally {
      await source.cleanup();
    }
  } finally {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});

test("artifact publisher preserves the legacy visible artifact root fallback", async () => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "portico-artifact-legacy-"));
  try {
    const artifactRoot = path.join(tempDir, "workspaces", "chat-1", "artifacts", "artifact-1");
    await writeFiles(artifactRoot, { "index.html": "<h1>Legacy</h1>" });

    const source = await resolveArtifactPublishSource({
      projectRoot: tempDir,
      chatId: "chat-1",
      artifactId: "artifact-1",
      version: 1,
      fetchArtifactMetadata: async () => null,
    });
    const packaged = await packageArtifactAssets(source.rootPath);

    assert.equal(source.source, "legacy");
    assert.equal(source.rootPath, artifactRoot);
    assert.equal(packaged.files.find((file) => file.name === "index.html").content, "<h1>Legacy</h1>");
    await assert.rejects(
      () =>
        resolveArtifactPublishSource({
          projectRoot: tempDir,
          chatId: "..",
          artifactId: "artifact-1",
          version: 1,
          fetchArtifactMetadata: async () => null,
        }),
      /Invalid artifact path/,
    );
  } finally {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});
