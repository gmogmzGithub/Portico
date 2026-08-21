const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsPromises = require("node:fs").promises;
const os = require("node:os");
const path = require("node:path");

const {
  resolveArtifactPreviewFile,
  resolveArtifactVersionPreviewFile,
} = require("./artifact-preview");

async function withTempProject(name, fn) {
  const projectRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), `${name}-`));
  try {
    await fn(projectRoot);
  } finally {
    await fsPromises.rm(projectRoot, { recursive: true, force: true });
  }
}

async function writeFile(filePath, contents) {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  await fsPromises.writeFile(filePath, contents);
}

async function writeSnapshotArtifact(projectRoot, { chatId, artifactId, files, versions = [] }) {
  await writeFile(
    path.join(projectRoot, "artifact-snapshots", artifactId, "metadata.json"),
    JSON.stringify({
      artifact_id: artifactId,
      chat_id: chatId,
      versions,
    }),
  );

  for (const [relativePath, contents] of Object.entries(files)) {
    await writeFile(
      path.join(projectRoot, "artifact-snapshots", "_workspaces", artifactId, relativePath),
      contents,
    );
  }
}

async function writeVersionPreviewFiles(projectRoot, { artifactId, version, files }) {
  for (const [relativePath, contents] of Object.entries(files)) {
    await writeFile(
      path.join(
        projectRoot,
        "artifact-snapshots",
        "_version_workspaces",
        artifactId,
        `v${version}`,
        relativePath,
      ),
      contents,
    );
  }
}

test("artifact preview resolves snapshot-backed canonical workspace index and assets", async () => {
  await withTempProject("artifact-preview-canonical", async (projectRoot) => {
    await writeSnapshotArtifact(projectRoot, {
      chatId: "chat-canonical",
      artifactId: "artifact-canonical",
      files: {
        "index.html": "<h1>canonical snapshot</h1>",
        "assets/app.css": "body { color: #123; }",
      },
    });

    const index = await resolveArtifactPreviewFile({
      projectRoot,
      chatId: "chat-canonical",
      artifactId: "artifact-canonical",
      requestedPath: "",
    });
    assert.equal(index.source, "snapshot");
    assert.equal(await fsPromises.readFile(index.filePath, "utf8"), "<h1>canonical snapshot</h1>");

    const asset = await resolveArtifactPreviewFile({
      projectRoot,
      chatId: "chat-canonical",
      artifactId: "artifact-canonical",
      requestedPath: "assets/app.css",
    });
    assert.equal(asset.source, "snapshot");
    assert.equal(await fsPromises.readFile(asset.filePath, "utf8"), "body { color: #123; }");
  });
});

test("artifact preview resolves snapshot-backed custom workspace without mutating the custom folder", async () => {
  await withTempProject("artifact-preview-custom", async (projectRoot) => {
    const customRoot = path.join(projectRoot, "chosen-chat-root");
    await fsPromises.mkdir(customRoot, { recursive: true });
    await writeFile(path.join(customRoot, "index.html"), "custom source");
    await writeFile(
      path.join(projectRoot, "open-webui-data", "workspace-cfg", "chat-workspaces.json"),
      JSON.stringify({
        chats: {
          "chat-custom": {
            source: "custom",
            host_path: customRoot,
          },
        },
      }),
    );
    await writeSnapshotArtifact(projectRoot, {
      chatId: "chat-custom",
      artifactId: "artifact-custom",
      files: {
        "index.html": "<h1>custom snapshot</h1>",
        "assets/app.js": "window.ready = true;",
      },
    });

    const index = await resolveArtifactPreviewFile({
      projectRoot,
      chatId: "chat-custom",
      artifactId: "artifact-custom",
      requestedPath: "",
    });
    const asset = await resolveArtifactPreviewFile({
      projectRoot,
      chatId: "chat-custom",
      artifactId: "artifact-custom",
      requestedPath: "assets/app.js",
    });

    assert.equal(index.source, "snapshot");
    assert.equal(asset.source, "snapshot");
    assert.equal(await fsPromises.readFile(index.filePath, "utf8"), "<h1>custom snapshot</h1>");
    assert.equal(await fsPromises.readFile(asset.filePath, "utf8"), "window.ready = true;");
    assert.equal(fs.existsSync(path.join(customRoot, "artifacts")), false);
  });
});

test("artifact preview falls back to legacy chat-workspace artifact layouts", async () => {
  await withTempProject("artifact-preview-legacy", async (projectRoot) => {
    const legacyRoot = path.join(
      projectRoot,
      "workspaces",
      "chat-legacy",
      "artifacts",
      "artifact-legacy",
    );
    await writeFile(path.join(legacyRoot, "index.html"), "<h1>legacy</h1>");
    await writeFile(path.join(legacyRoot, "assets/app.js"), "console.log('legacy');");

    const index = await resolveArtifactPreviewFile({
      projectRoot,
      chatId: "chat-legacy",
      artifactId: "artifact-legacy",
      requestedPath: "",
    });
    const asset = await resolveArtifactPreviewFile({
      projectRoot,
      chatId: "chat-legacy",
      artifactId: "artifact-legacy",
      requestedPath: "assets/app.js",
    });

    assert.equal(index.source, "legacy");
    assert.equal(asset.source, "legacy");
    assert.equal(await fsPromises.readFile(index.filePath, "utf8"), "<h1>legacy</h1>");
    assert.equal(await fsPromises.readFile(asset.filePath, "utf8"), "console.log('legacy');");
  });
});

test("artifact version preview resolves independent snapshot-backed version assets", async () => {
  await withTempProject("artifact-preview-versioned", async (projectRoot) => {
    await writeSnapshotArtifact(projectRoot, {
      chatId: "chat-flappy",
      artifactId: "artifact-flappy",
      files: {
        "index.html": "<script src=\"game.js\"></script>",
      },
      versions: [
        { version: 1, snapshot_path: "v1.tar.gz" },
        { version: 2, snapshot_path: "v2.tar.gz" },
      ],
    });
    await writeVersionPreviewFiles(projectRoot, {
      artifactId: "artifact-flappy",
      version: 1,
      files: {
        "index.html": "<script src=\"game.js\"></script>",
        "game.js": "function flap() { return 'silent'; }",
      },
    });
    await writeVersionPreviewFiles(projectRoot, {
      artifactId: "artifact-flappy",
      version: 2,
      files: {
        "index.html": "<script src=\"game.js\"></script>",
        "game.js": "const audio = new AudioContext(); audio.createOscillator();",
      },
    });

    const v1Game = await resolveArtifactVersionPreviewFile({
      projectRoot,
      chatId: "chat-flappy",
      artifactId: "artifact-flappy",
      version: "1",
      requestedPath: "game.js",
    });
    const v2Game = await resolveArtifactVersionPreviewFile({
      projectRoot,
      chatId: "chat-flappy",
      artifactId: "artifact-flappy",
      version: "2",
      requestedPath: "game.js",
    });

    assert.equal(v1Game.source, "version-snapshot");
    assert.equal(v1Game.version, 1);
    assert.equal(v2Game.source, "version-snapshot");
    assert.equal(v2Game.version, 2);
    assert.equal((await fsPromises.readFile(v1Game.filePath, "utf8")).includes("AudioContext"), false);
    assert.equal((await fsPromises.readFile(v2Game.filePath, "utf8")).includes("AudioContext"), true);
  });
});

test("artifact preview rejects mismatched snapshot chat ownership", async () => {
  await withTempProject("artifact-preview-mismatch", async (projectRoot) => {
    await writeSnapshotArtifact(projectRoot, {
      chatId: "chat-owner",
      artifactId: "artifact-owned",
      files: {
        "index.html": "<h1>owned</h1>",
      },
    });

    await assert.rejects(
      () => resolveArtifactPreviewFile({
        projectRoot,
        chatId: "chat-other",
        artifactId: "artifact-owned",
        requestedPath: "",
      }),
      (error) => error.statusCode === 403 && /does not belong/.test(error.message),
    );
  });
});

test("artifact preview rejects artifact id and requested path traversal", async () => {
  await withTempProject("artifact-preview-traversal", async (projectRoot) => {
    await writeSnapshotArtifact(projectRoot, {
      chatId: "chat-safe",
      artifactId: "artifact-safe",
      files: {
        "index.html": "<h1>safe</h1>",
      },
    });
    await writeFile(path.join(projectRoot, "secret.txt"), "secret");

    await assert.rejects(
      () => resolveArtifactPreviewFile({
        projectRoot,
        chatId: "chat-safe",
        artifactId: "../artifact-safe",
        requestedPath: "",
      }),
      (error) => error.statusCode === 403 && /Invalid artifact path/.test(error.message),
    );
    await assert.rejects(
      () => resolveArtifactPreviewFile({
        projectRoot,
        chatId: "chat-safe",
        artifactId: "artifact-safe",
        requestedPath: "../secret.txt",
      }),
      (error) => error.statusCode === 403 && /Invalid preview path/.test(error.message),
    );
  });
});

test("artifact version preview rejects mismatches, missing versions, and traversal", async () => {
  await withTempProject("artifact-preview-version-negative", async (projectRoot) => {
    await writeSnapshotArtifact(projectRoot, {
      chatId: "chat-owner",
      artifactId: "artifact-owned",
      files: {
        "index.html": "<h1>current</h1>",
      },
      versions: [{ version: 1, snapshot_path: "v1.tar.gz" }],
    });
    await writeVersionPreviewFiles(projectRoot, {
      artifactId: "artifact-owned",
      version: 1,
      files: {
        "index.html": "<h1>v1</h1>",
      },
    });
    await writeFile(path.join(projectRoot, "secret.txt"), "secret");

    await assert.rejects(
      () => resolveArtifactVersionPreviewFile({
        projectRoot,
        chatId: "chat-other",
        artifactId: "artifact-owned",
        version: "1",
        requestedPath: "",
      }),
      (error) => error.statusCode === 403 && /does not belong/.test(error.message),
    );
    await assert.rejects(
      () => resolveArtifactVersionPreviewFile({
        projectRoot,
        chatId: "chat-owner",
        artifactId: "artifact-owned",
        version: "2",
        requestedPath: "",
      }),
      (error) => error.statusCode === 404 && /version preview/.test(error.message),
    );
    await assert.rejects(
      () => resolveArtifactVersionPreviewFile({
        projectRoot,
        chatId: "chat-owner",
        artifactId: "../artifact-owned",
        version: "1",
        requestedPath: "",
      }),
      (error) => error.statusCode === 403 && /Invalid artifact path/.test(error.message),
    );
    await assert.rejects(
      () => resolveArtifactVersionPreviewFile({
        projectRoot,
        chatId: "chat-owner",
        artifactId: "artifact-owned",
        version: "../1",
        requestedPath: "",
      }),
      (error) => error.statusCode === 403 && /Invalid artifact version/.test(error.message),
    );
    await assert.rejects(
      () => resolveArtifactVersionPreviewFile({
        projectRoot,
        chatId: "chat-owner",
        artifactId: "artifact-owned",
        version: "1",
        requestedPath: "../secret.txt",
      }),
      (error) => error.statusCode === 403 && /Invalid preview path/.test(error.message),
    );
  });
});
