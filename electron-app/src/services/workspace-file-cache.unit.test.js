const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Writable } = require("node:stream");
const express = require("express");

const {
  applyWorkspaceFileResponseHeaders,
  createWorkspaceFileRequestHandler,
} = require("./workspace-file-serving");

const apiSource = fs.readFileSync(path.join(__dirname, "api.js"), "utf8");

test("api registers the shared workspace file route", () => {
  assert.match(
    apiSource,
    /registerWorkspaceFileRoute\(apiApp, \{ projectRoot: bootstrap\.PROJECT_ROOT \}\)/,
  );
});

function responseFor(filePath, { inline = false, fetchDest = "" } = {}) {
  const headers = new Map();
  const response = Object.create(express.response);
  response.setHeader = (name, value) => headers.set(String(name).toLowerCase(), value);
  response.getHeader = (name) => headers.get(String(name).toLowerCase());
  const request = {
    query: inline ? { inline: "1" } : {},
    get: (name) =>
      String(name).toLowerCase() === "sec-fetch-dest" ? fetchDest : undefined,
  };

  applyWorkspaceFileResponseHeaders(request, response, {
    filePath,
    fileSize: 123,
  });
  return Object.fromEntries(headers);
}

test("workspace response headers serve allowlisted images inline while preserving downloads", () => {
  const directSvg = responseFor("/workspace/diagram.svg");
  assert.match(directSvg["content-type"], /^image\/svg\+xml/);
  assert.match(directSvg["content-disposition"], /^attachment;/);
  assert.equal(directSvg["cache-control"], "no-store");
  assert.equal(directSvg["x-content-type-options"], "nosniff");
  assert.equal(directSvg["content-security-policy"], undefined);
  assert.equal(directSvg["content-length"], 123);

  const inlineSvg = responseFor("/workspace/diagram.svg", { inline: true });
  assert.match(inlineSvg["content-disposition"], /^inline;/);
  assert.match(inlineSvg["content-security-policy"], /default-src 'none'/);
  assert.match(inlineSvg["content-security-policy"], /script-src 'none'/);
  assert.match(inlineSvg["content-security-policy"], /img-src data:/);
  assert.match(inlineSvg["content-security-policy"], /sandbox/);

  const legacyImageRequest = responseFor("/workspace/legacy.svg", {
    fetchDest: "image",
  });
  assert.match(legacyImageRequest["content-disposition"], /^inline;/);

  const inlinePng = responseFor("/workspace/pixel.png", { inline: true });
  assert.match(inlinePng["content-type"], /^image\/png/);
  assert.match(inlinePng["content-disposition"], /^inline;/);
  assert.equal(inlinePng["content-security-policy"], undefined);

  const nonImage = responseFor("/workspace/notes.txt", { inline: true });
  assert.match(nonImage["content-type"], /^text\/plain/);
  assert.match(nonImage["content-disposition"], /^attachment;/);
});

test("workspace route continues rejecting path traversal", async () => {
  const handler = createWorkspaceFileRequestHandler({
    projectRoot: "/tmp/workspace-route-test",
    logger: { error() {}, log() {}, warn() {} },
  });
  let statusCode = 200;
  let body;
  const response = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(value) {
      body = value;
      return value;
    },
  };

  await handler(
    { params: { chatId: "chat-1", filePath: ["..", "secret.txt"] } },
    response,
  );

  assert.equal(statusCode, 403);
  assert.deepEqual(body, { error: "Invalid path" });
});

function createStreamingResponse() {
  const chunks = [];
  const headers = new Map();
  const response = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  response.statusCode = 200;
  response.jsonBody = undefined;
  response.status = function status(code) {
    this.statusCode = code;
    return this;
  };
  response.json = function json(value) {
    this.jsonBody = value;
    return value;
  };
  response.type = function type(value) {
    headers.set("content-type", String(value));
    return this;
  };
  response.setHeader = (name, value) =>
    headers.set(String(name).toLowerCase(), value);
  response.getHeader = (name) => headers.get(String(name).toLowerCase());
  response.body = () => Buffer.concat(chunks).toString("utf8");
  return response;
}

test("custom workspaces fall back to canonical skill assets only", async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-file-serving-"));
  const projectRoot = path.join(tmpRoot, "project");
  const customWorkspace = path.join(tmpRoot, "custom-workspace");
  const cfgDir = path.join(tmpRoot, "workspace-cfg");
  const canonicalWorkspace = path.join(projectRoot, "workspaces", "custom-chat");

  fs.mkdirSync(path.join(canonicalWorkspace, "skill-assets", "snowflake-setup"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(projectRoot, "workspaces", "canonical-chat"), {
    recursive: true,
  });
  fs.mkdirSync(customWorkspace, { recursive: true });
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(
    path.join(canonicalWorkspace, "skill-assets", "snowflake-setup", "step-1.png"),
    "canonical-asset-bytes",
  );
  fs.writeFileSync(path.join(canonicalWorkspace, "report.md"), "canonical-report");
  fs.writeFileSync(
    path.join(projectRoot, "workspaces", "canonical-chat", "notes.txt"),
    "canonical-chat-bytes",
  );
  fs.writeFileSync(
    path.join(cfgDir, "chat-workspaces.json"),
    JSON.stringify({
      chats: {
        "custom-chat": { source: "custom", host_path: customWorkspace },
      },
    }),
  );

  const previousCfgDir = process.env.PORTICO_WORKSPACE_CFG_DIR;
  process.env.PORTICO_WORKSPACE_CFG_DIR = cfgDir;
  t.after(() => {
    if (previousCfgDir === undefined) {
      delete process.env.PORTICO_WORKSPACE_CFG_DIR;
    } else {
      process.env.PORTICO_WORKSPACE_CFG_DIR = previousCfgDir;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  const handler = createWorkspaceFileRequestHandler({
    projectRoot,
    logger: { error() {}, log() {}, warn() {} },
  });
  const serve = async (chatId, filePath) => {
    const response = createStreamingResponse();
    const finished = new Promise((resolve) => response.on("finish", resolve));
    await handler(
      { params: { chatId, filePath }, query: {}, get: () => undefined },
      response,
    );
    if (response.statusCode === 200 && response.jsonBody === undefined) {
      await finished;
    }
    return response;
  };

  // Custom workspace + skill asset only in the canonical dir => canonical bytes.
  const fallback = await serve("custom-chat", [
    "skill-assets",
    "snowflake-setup",
    "step-1.png",
  ]);
  assert.equal(fallback.statusCode, 200);
  assert.equal(fallback.body(), "canonical-asset-bytes");

  // A copy in the custom workspace wins over the canonical fallback.
  fs.mkdirSync(path.join(customWorkspace, "skill-assets", "snowflake-setup"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(customWorkspace, "skill-assets", "snowflake-setup", "step-1.png"),
    "custom-asset-bytes",
  );
  const customWins = await serve("custom-chat", [
    "skill-assets",
    "snowflake-setup",
    "step-1.png",
  ]);
  assert.equal(customWins.statusCode, 200);
  assert.equal(customWins.body(), "custom-asset-bytes");

  // Non-skill-assets paths missing from the custom workspace never fall back.
  const noFallback = await serve("custom-chat", ["report.md"]);
  assert.equal(noFallback.statusCode, 404);
  assert.deepEqual(noFallback.jsonBody, { error: "File not found" });

  // Traversal attempts under skill-assets are still rejected.
  const traversal = await serve("custom-chat", [
    "skill-assets",
    "..",
    "..",
    "secret.txt",
  ]);
  assert.equal(traversal.statusCode, 403);
  assert.deepEqual(traversal.jsonBody, { error: "Invalid path" });

  // Paths that escape the skill-assets/ prefix inside the workspace do not
  // gain a canonical fallback (canonical report.md exists but must not serve).
  const escapesPrefix = await serve("custom-chat", [
    "skill-assets",
    "..",
    "report.md",
  ]);
  assert.equal(escapesPrefix.statusCode, 404);
  assert.deepEqual(escapesPrefix.jsonBody, { error: "File not found" });

  // Canonical-workspace chats behave exactly as before.
  const canonicalChat = await serve("canonical-chat", ["notes.txt"]);
  assert.equal(canonicalChat.statusCode, 200);
  assert.equal(canonicalChat.body(), "canonical-chat-bytes");
});

test("artifact preview route delegates to snapshot-aware preview resolver", () => {
  const routeStart = apiSource.indexOf("// GET /artifact-preview");
  const routeEnd = apiSource.indexOf("// ============================================================================\n  // ARTIFACT PANEL ENDPOINTS", routeStart);

  assert.notEqual(routeStart, -1, "expected artifact preview route in api.js");
  assert.notEqual(routeEnd, -1, "expected artifact panel section after artifact preview route");

  const routeSource = apiSource.slice(routeStart, routeEnd);

  assert.match(
    apiSource,
    /resolveArtifactPreviewFile,[\s\S]*resolveArtifactVersionPreviewFile,[\s\S]*\}\s*=\s*require\("\.\/artifact-preview"\)/,
    "api.js should import the snapshot-aware artifact preview resolver",
  );
  assert.match(
    routeSource,
    /\/artifact-preview\/:chatId\/:artifactId\/versions\/:version[\s\S]*await resolveArtifactVersionPreviewFile\(\{[\s\S]*version,[\s\S]*requestedPath,[\s\S]*\}\)/,
    "artifact preview routes should resolve immutable version preview files before the generic fallback route",
  );
  assert.match(
    routeSource,
    /await resolveArtifactPreviewFile\(\{[\s\S]*projectRoot:\s*bootstrap\.PROJECT_ROOT,[\s\S]*chatId,[\s\S]*artifactId,[\s\S]*requestedPath,[\s\S]*\}\)/,
    "artifact preview route should resolve snapshot and legacy roots through the shared resolver",
  );
  assert.doesNotMatch(
    routeSource,
    /relativePath:\s*path\.join\('artifacts', artifactId\)/,
    "artifact preview route should not be hard-wired to legacy chatWorkspace/artifacts paths",
  );
  assert.match(routeSource, /res\.sendFile\(previewFile\.filePath/);
});
