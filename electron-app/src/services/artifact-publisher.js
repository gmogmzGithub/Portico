const fs = require("fs");
const fsPromises = require("fs").promises;
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { promisify } = require("util");

const DEFAULT_PROTOTYPES_BASE_URL = "https://prototypes.example.invalid";
const ADD_AI_PROJECT_PATH = "/add-ai-project";
const ARTIFACT_SNAPSHOTS_DIR = "artifact-snapshots";
const CONTAINER_PROJECT_ROOT = "/app";
const SELECTED_VERSION_UNAVAILABLE_MESSAGE = "Selected artifact version files are unavailable.";
const MAX_UPLOAD_FILES = 50;
const MAX_REGULAR_FILE_BYTES = 20 * 1024 * 1024;
const MAX_ZIP_FILE_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_JSON_BODY_BYTES = 28 * 1024 * 1024;
const DEBUG_LOG_ENDPOINT = "http://127.0.0.1:7280/ingest/1f88542e-2f61-49f4-a195-00bff5cbbb91";
const DEBUG_SESSION_ID = "f9c431";
const DEBUG_RUN_ID = "publish-debug-initial";

const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "__pycache__",
  ".cache",
  ".next",
  ".vite",
  "coverage",
]);

const SKIPPED_FILES = new Set([".DS_Store"]);

const BINARY_EXTENSIONS = new Set([
  ".zip",
  ".rar",
  ".7z",
  ".tar",
  ".gz",
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".pdf",
  ".mp3",
  ".mp4",
  ".wav",
  ".avi",
  ".mov",
]);

const SOURCE_EXTENSIONS = new Set([
  ".html",
  ".htm",
  ".css",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".json",
  ".svg",
  ".txt",
  ".md",
  ".mjs",
  ".cjs",
]);

const execFileAsync = promisify(execFile);

function debugPublishLog(hypothesisId, location, message, data = {}) {
  fetch(DEBUG_LOG_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": DEBUG_SESSION_ID,
    },
    body: JSON.stringify({
      sessionId: DEBUG_SESSION_ID,
      runId: DEBUG_RUN_ID,
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
    }),
  }).catch(() => {});
}

function summarizeFiles(files) {
  const byEncoding = {};
  const byExtension = {};
  let totalContentBytes = 0;
  let hasIndexHtml = false;
  let hasPackageJson = false;
  let hasSrcDir = false;

  for (const file of files) {
    byEncoding[file.encoding] = (byEncoding[file.encoding] || 0) + 1;
    const extension = path.extname(file.name || "").toLowerCase() || "(none)";
    byExtension[extension] = (byExtension[extension] || 0) + 1;
    totalContentBytes += Buffer.byteLength(String(file.content || ""), "utf8");
    hasIndexHtml = hasIndexHtml || file.name === "index.html";
    hasPackageJson = hasPackageJson || file.name === "package.json";
    hasSrcDir = hasSrcDir || String(file.name || "").startsWith("src/");
  }

  return {
    fileCount: files.length,
    byEncoding,
    byExtension,
    totalContentBytes,
    hasIndexHtml,
    hasPackageJson,
    hasSrcDir,
  };
}

function summarizeRequestBody(pathName, body) {
  if (!body) {
    return { hasBody: false };
  }

  if (pathName === "/api/projects") {
    return {
      hasBody: true,
      projectNameLength: String(body.projectName || "").length,
      slugLength: String(body.slug || "").length,
      tagIds: Array.isArray(body.tags) ? body.tags.map((tag) => tag.id) : [],
      access: body.access,
      archived: body.archived,
      hidden: body.hidden,
      hasUserId: Boolean(body._userId),
    };
  }

  if (pathName.includes("/trigger-pipeline")) {
    return {
      hasBody: true,
      projectType: body.projectType,
      payloadBytes: Buffer.byteLength(JSON.stringify(body), "utf8"),
      files: summarizeFiles(Array.isArray(body.files) ? body.files : []),
      hasPastedContent: Boolean(body.pastedContent),
    };
  }

  return {
    hasBody: true,
    payloadBytes: Buffer.byteLength(JSON.stringify(body), "utf8"),
  };
}

function normalizePrototypesBaseUrl(value) {
  const raw = String(value || DEFAULT_PROTOTYPES_BASE_URL).trim() || DEFAULT_PROTOTYPES_BASE_URL;
  const parsed = new URL(raw);

  if (parsed.pathname === ADD_AI_PROJECT_PATH) {
    parsed.pathname = "/";
  }

  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function getConfiguredPrototypesBaseUrl() {
  return DEFAULT_PROTOTYPES_BASE_URL;
}

function formatSlug(value, fallback = "portico-artifact") {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  return slug || fallback;
}

function shouldSkipDirectory(name) {
  return SKIPPED_DIRECTORIES.has(name) || name.startsWith(".");
}

function shouldSkipFile(name) {
  return SKIPPED_FILES.has(name) || name.startsWith(".");
}

function isBinaryArtifactFile(filePath) {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isPathWithinRoot(targetPath, rootPath) {
  const resolvedTarget = path.resolve(String(targetPath || ""));
  const resolvedRoot = path.resolve(String(rootPath || ""));
  const relative = path.relative(resolvedRoot, resolvedTarget);
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function inferProjectType(files) {
  const names = files.map((file) => file.name.replace(/\\/g, "/"));
  const hasTypeScript = names.some((name) => /\.(tsx?|jsx)$/i.test(name));
  if (hasTypeScript) {
    return "typescript";
  }

  const hasPackageJson = names.includes("package.json");
  const hasSourceTree = names.some((name) => name.startsWith("src/"));
  const hasJavaScriptApp = names.some((name) => /\.(mjs|cjs|js)$/i.test(name));
  if (hasPackageJson && (hasSourceTree || hasJavaScriptApp)) {
    return "typescript";
  }

  return "html";
}

async function collectArtifactFileEntries(rootPath) {
  const rootResolved = path.resolve(rootPath);
  const entries = [];
  let totalBytes = 0;

  async function visit(directory) {
    const dirEntries = await fsPromises.readdir(directory, { withFileTypes: true });

    for (const dirent of dirEntries) {
      if (dirent.isSymbolicLink()) {
        continue;
      }

      const fullPath = path.join(directory, dirent.name);
      const relativePath = path.relative(rootResolved, fullPath).split(path.sep).join("/");

      if (dirent.isDirectory()) {
        if (!shouldSkipDirectory(dirent.name)) {
          await visit(fullPath);
        }
        continue;
      }

      if (!dirent.isFile() || shouldSkipFile(dirent.name)) {
        continue;
      }

      const extension = path.extname(dirent.name).toLowerCase();
      if (!SOURCE_EXTENSIONS.has(extension) && !BINARY_EXTENSIONS.has(extension)) {
        continue;
      }

      const stat = await fsPromises.stat(fullPath);
      const fileLimit = extension === ".zip" ? MAX_ZIP_FILE_BYTES : MAX_REGULAR_FILE_BYTES;
      if (stat.size > fileLimit) {
        throw new Error(`Artifact file is too large to publish: ${relativePath}`);
      }

      totalBytes += stat.size;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new Error("Artifact files exceed the Prototypes upload size limit.");
      }

      entries.push({ fullPath, relativePath, size: stat.size });
      if (entries.length > MAX_UPLOAD_FILES) {
        throw new Error(`Artifact has more than ${MAX_UPLOAD_FILES} publishable files.`);
      }
    }
  }

  await visit(rootResolved);
  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return entries;
}

async function packageArtifactAssets(rootPath) {
  const entries = await collectArtifactFileEntries(rootPath);
  if (entries.length === 0) {
    throw new Error("No publishable artifact files were found.");
  }

  const files = [];
  for (const entry of entries) {
    const buffer = await fsPromises.readFile(entry.fullPath);
    const binary = isBinaryArtifactFile(entry.relativePath);
    files.push({
      name: entry.relativePath,
      content: binary ? buffer.toString("base64") : buffer.toString("utf8"),
      encoding: binary ? "base64" : "text",
    });
  }

  const projectType = inferProjectType(files);
  const requestBytes = Buffer.byteLength(JSON.stringify({ projectType, files }), "utf8");
  if (requestBytes > MAX_JSON_BODY_BYTES) {
    throw new Error("Artifact upload payload is too large for the Prototypes publish API.");
  }

  // #region agent log
  debugPublishLog("C", "artifact-publisher.js:packageArtifactAssets", "Packaged artifact upload payload", {
    projectType,
    requestBytes,
    maxJsonBodyBytes: MAX_JSON_BODY_BYTES,
    files: summarizeFiles(files),
  });
  // #endregion

  return { files, projectType };
}

function validateArtifactPublishRequest(projectRoot, chatId, artifactId, version) {
  if (!projectRoot) {
    throw new Error("Project root is not initialized.");
  }
  if (!chatId || !artifactId) {
    throw new Error("Artifact id and chat id are required to publish.");
  }
  const parsedVersion = Number(version);
  if (!Number.isInteger(parsedVersion) || parsedVersion <= 0) {
    throw new Error("Artifact version is required to publish.");
  }
  return parsedVersion;
}

function artifactSnapshotsRoot(projectRoot) {
  return path.resolve(projectRoot, ARTIFACT_SNAPSHOTS_DIR);
}

function artifactMetadataPath(projectRoot, artifactId) {
  const snapshotsRoot = artifactSnapshotsRoot(projectRoot);
  const metadataPath = path.resolve(snapshotsRoot, artifactId, "metadata.json");
  if (!isPathWithinRoot(metadataPath, snapshotsRoot)) {
    throw new Error("Invalid artifact path.");
  }
  return metadataPath;
}

async function readArtifactMetadataFromDisk(projectRoot, artifactId) {
  const metadataPath = artifactMetadataPath(projectRoot, artifactId);
  if (!fs.existsSync(metadataPath)) {
    return null;
  }
  const raw = await fsPromises.readFile(metadataPath, "utf8");
  return JSON.parse(raw);
}

async function fetchArtifactMetadataFromMcpo({ chatId, artifactId, fetchImpl = fetch, timeoutMs = 2500 } = {}) {
  if (typeof fetchImpl !== "function") {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(
      "http://localhost:8766/artifacts/artifacts_list_artifacts",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, include_all_versions: true }),
        signal: controller.signal,
      },
    );
    if (!response.ok || typeof response.json !== "function") {
      return null;
    }
    const result = await response.json();
    return (Array.isArray(result.artifacts) ? result.artifacts : []).find(
      (artifact) => artifact?.artifact_id === artifactId,
    ) || null;
  } catch (_error) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function validateArtifactMetadata(metadata, chatId, artifactId) {
  if (!metadata || typeof metadata !== "object") {
    return;
  }
  if (metadata.artifact_id && metadata.artifact_id !== artifactId) {
    throw new Error("Invalid artifact metadata.");
  }
  if (metadata.chat_id !== chatId) {
    throw new Error("Artifact does not belong to this chat.");
  }
}

function selectedMetadataVersion(metadata, version) {
  const versions = Array.isArray(metadata?.versions) ? metadata.versions : [];
  const selected = versions.find((item) => Number(item?.version) === version);
  if (!selected?.snapshot_path) {
    throw new Error(SELECTED_VERSION_UNAVAILABLE_MESSAGE);
  }
  return selected;
}

function resolveSnapshotArchivePath(projectRoot, snapshotPath) {
  const rawSnapshotPath = String(snapshotPath || "").trim();
  if (!rawSnapshotPath) {
    throw new Error(SELECTED_VERSION_UNAVAILABLE_MESSAGE);
  }

  const snapshotsRoot = artifactSnapshotsRoot(projectRoot);
  const rawPosixPath = rawSnapshotPath.replace(/\\/g, "/");
  const containerRoots = Array.from(
    new Set([
      path.posix.join(
        String(process.env.CONTAINER_PROJECT_ROOT || CONTAINER_PROJECT_ROOT).replace(/\\/g, "/"),
        ARTIFACT_SNAPSHOTS_DIR,
      ),
      path.posix.join(CONTAINER_PROJECT_ROOT, ARTIFACT_SNAPSHOTS_DIR),
    ]),
  );

  for (const containerRoot of containerRoots) {
    if (rawPosixPath === containerRoot || rawPosixPath.startsWith(`${containerRoot}/`)) {
      const relativePath = path.posix.relative(containerRoot, rawPosixPath);
      const hostPath = path.resolve(snapshotsRoot, ...relativePath.split("/").filter(Boolean));
      if (!isPathWithinRoot(hostPath, snapshotsRoot)) {
        throw new Error("Invalid artifact path.");
      }
      return hostPath;
    }
  }

  const archivePath = path.isAbsolute(rawSnapshotPath)
    ? path.resolve(rawSnapshotPath)
    : path.resolve(projectRoot, rawSnapshotPath);
  if (!isPathWithinRoot(archivePath, snapshotsRoot)) {
    throw new Error("Invalid artifact path.");
  }
  return archivePath;
}

function resolveLegacyArtifactRoot(projectRoot, chatId, artifactId) {
  const workspacesRoot = path.resolve(projectRoot, "workspaces");
  const chatWorkspaceRoot = path.resolve(workspacesRoot, chatId);
  if (!isPathWithinRoot(chatWorkspaceRoot, workspacesRoot)) {
    throw new Error("Invalid artifact path.");
  }
  const artifactsRoot = path.resolve(chatWorkspaceRoot, "artifacts");
  const artifactRoot = path.resolve(artifactsRoot, artifactId);
  if (!isPathWithinRoot(artifactRoot, artifactsRoot)) {
    throw new Error("Invalid artifact path.");
  }
  return fs.existsSync(artifactRoot) ? artifactRoot : null;
}

async function extractSnapshotArchive(archivePath, artifactId, version) {
  if (!fs.existsSync(archivePath)) {
    throw new Error(SELECTED_VERSION_UNAVAILABLE_MESSAGE);
  }

  const tempRoot = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), `portico-artifact-publish-${artifactId}-v${version}-`),
  );
  try {
    await execFileAsync("tar", ["-xzf", archivePath, "-C", tempRoot]);
  } catch (error) {
    await fsPromises.rm(tempRoot, { recursive: true, force: true });
    const details = error?.message ? ` ${error.message}` : "";
    throw new Error(`${SELECTED_VERSION_UNAVAILABLE_MESSAGE}${details}`);
  }
  return tempRoot;
}

async function resolveArtifactPublishSource({
  projectRoot,
  chatId,
  artifactId,
  version,
  fetchArtifactMetadata = fetchArtifactMetadataFromMcpo,
} = {}) {
  const selectedVersion = validateArtifactPublishRequest(projectRoot, chatId, artifactId, version);
  const diskMetadata = await readArtifactMetadataFromDisk(projectRoot, artifactId);
  const metadata =
    diskMetadata ||
    (typeof fetchArtifactMetadata === "function"
      ? await fetchArtifactMetadata({ chatId, artifactId })
      : null);

  if (metadata) {
    validateArtifactMetadata(metadata, chatId, artifactId);
    const selected = selectedMetadataVersion(metadata, selectedVersion);
    const archivePath = resolveSnapshotArchivePath(projectRoot, selected.snapshot_path);
    const tempRoot = await extractSnapshotArchive(archivePath, artifactId, selectedVersion);
    return {
      rootPath: tempRoot,
      source: "snapshot",
      selectedVersion,
      cleanup: () => fsPromises.rm(tempRoot, { recursive: true, force: true }),
    };
  }

  const legacyRoot = resolveLegacyArtifactRoot(projectRoot, chatId, artifactId);
  if (legacyRoot) {
    return {
      rootPath: legacyRoot,
      source: "legacy",
      selectedVersion,
      cleanup: async () => {},
    };
  }

  throw new Error(SELECTED_VERSION_UNAVAILABLE_MESSAGE);
}

async function getCookieHeader(electronSession, baseUrl) {
  const cookies = await electronSession.cookies.get({ url: baseUrl });
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

async function getSessionUsername(electronSession, baseUrl) {
  const cookies = await electronSession.cookies.get({ url: baseUrl });
  const ldapCookie = cookies.find((cookie) => cookie.name === "ldapUsername");
  return ldapCookie?.value ? decodeURIComponent(ldapCookie.value) : null;
}

async function hasPrototypeSession(electronSession, baseUrl) {
  const cookies = await electronSession.cookies.get({ url: baseUrl });
  return cookies.some((cookie) => cookie.name === "koa.sess");
}

function getElectronSession(parentWindow) {
  const electron = require("electron");
  return parentWindow?.webContents?.session || electron.session.defaultSession;
}

async function openAuthWindow({ baseUrl, electronSession, parentWindow, timeoutMs = 5 * 60 * 1000 }) {
  const { BrowserWindow } = require("electron");
  const authUrl = new URL(ADD_AI_PROJECT_PATH, baseUrl).toString();

  return new Promise((resolve, reject) => {
    const authWindow = new BrowserWindow({
      width: 1100,
      height: 900,
      title: "Sign in to Prototypes",
      parent: parentWindow && !parentWindow.isDestroyed() ? parentWindow : undefined,
      modal: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        session: electronSession,
      },
    });

    let settled = false;
    let interval = null;
    let timeout = null;

    const cleanup = () => {
      if (interval) clearInterval(interval);
      if (timeout) clearTimeout(timeout);
      authWindow.removeAllListeners("closed");
      authWindow.webContents.removeAllListeners("did-finish-load");
      authWindow.webContents.removeAllListeners("did-navigate");
    };

    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!authWindow.isDestroyed()) {
        authWindow.close();
      }
      if (error) {
        reject(error);
      } else {
        resolve(true);
      }
    };

    const checkSession = async () => {
      try {
        if (await hasPrototypeSession(electronSession, baseUrl)) {
          finish();
        }
      } catch (error) {
        finish(error);
      }
    };

    authWindow.on("closed", () => {
      finish(new Error("Prototypes authentication window was closed before sign-in completed."));
    });
    authWindow.webContents.on("did-finish-load", () => {
      void checkSession();
    });
    authWindow.webContents.on("did-navigate", () => {
      void checkSession();
    });

    interval = setInterval(() => {
      void checkSession();
    }, 1000);
    timeout = setTimeout(() => {
      finish(new Error("Timed out waiting for Prototypes authentication."));
    }, timeoutMs);

    authWindow.loadURL(authUrl).catch(finish);
  });
}

async function ensureAuthenticatedSession({ baseUrl, electronSession, parentWindow, force = false }) {
  const cookies = await electronSession.cookies.get({ url: baseUrl });
  const hasSession = cookies.some((cookie) => cookie.name === "koa.sess");
  // #region agent log
  debugPublishLog("A,D", "artifact-publisher.js:ensureAuthenticatedSession", "Checked Prototypes auth session", {
    baseUrl,
    isLocalhost: new URL(baseUrl).hostname === "localhost",
    hasSession,
    cookieNames: cookies.map((cookie) => cookie.name).sort(),
    force,
  });
  // #endregion
  if (!force && hasSession) {
    return true;
  }
  return openAuthWindow({ baseUrl, electronSession, parentWindow });
}

async function fetchPrototypeJson({ baseUrl, electronSession, pathName, method = "GET", body }) {
  const cookies = await electronSession.cookies.get({ url: baseUrl });
  const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  const requestUrl = new URL(pathName, baseUrl).toString();
  // #region agent log
  debugPublishLog("A,B,C,D,E", "artifact-publisher.js:fetchPrototypeJson:request", "Sending Prototypes API request", {
    baseUrl,
    requestUrl,
    method,
    pathName,
    isLocalhost: new URL(baseUrl).hostname === "localhost",
    hasCookieHeader: Boolean(cookieHeader),
    cookieCount: cookies.length,
    hasSessionCookie: cookies.some((cookie) => cookie.name === "koa.sess"),
    body: summarizeRequestBody(pathName, body),
  });
  // #endregion
  const response = await fetch(new URL(pathName, baseUrl).toString(), {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  // #region agent log
  debugPublishLog("B,E", "artifact-publisher.js:fetchPrototypeJson:response", "Received Prototypes API response", {
    baseUrl,
    requestUrl,
    method,
    pathName,
    status: response.status,
    ok: response.ok,
    errorCode: parsed?.code || null,
    errorMessage: parsed?.error || parsed?.message || null,
  });
  // #endregion

  if (!response.ok) {
    const message = parsed?.error || parsed?.message || text || response.statusText;
    let friendlyMessage = `Prototypes API returned ${response.status}: ${message}`;
    if (response.status === 401) {
      friendlyMessage = "Prototypes authentication is required. Sign in with Golf Cart and try again.";
    } else if (response.status === 403) {
      friendlyMessage = "Prototypes denied the publish request. Check your account permissions.";
    } else if (response.status === 404) {
      friendlyMessage =
        "Prototypes publish routes were not reachable. Check VPN/corporate network access and the configured Prototypes URL.";
    } else if (response.status === 503) {
      friendlyMessage = `Prototypes publishing is unavailable: ${message}`;
    }
    const error = new Error(friendlyMessage);
    error.status = response.status;
    error.body = parsed || text;
    throw error;
  }

  return parsed || {};
}

async function verifyGitLabAvailability(baseUrl, electronSession) {
  const result = await fetchPrototypeJson({
    baseUrl,
    electronSession,
    pathName: "/api/gitlab/availability",
  });
  if (result.available === false) {
    throw new Error("Prototypes GitLab publishing is currently unavailable.");
  }
}

async function publishArtifactToPrototypes({
  artifactId,
  chatId,
  name,
  version,
  projectRoot,
  parentWindow = null,
  electronSession = null,
  username = null,
}) {
  const baseUrl = getConfiguredPrototypesBaseUrl();
  const sessionToUse = electronSession || getElectronSession(parentWindow);
  const publishSource = await resolveArtifactPublishSource({
    projectRoot,
    chatId,
    artifactId,
    version,
  });
  // #region agent log
  debugPublishLog("A", "artifact-publisher.js:publishArtifactToPrototypes:start", "Starting artifact publish", {
    baseUrl,
    isLocalhost: new URL(baseUrl).hostname === "localhost",
    artifactIdSuffix: String(artifactId || "").slice(-8),
    hasChatId: Boolean(chatId),
    version: publishSource.selectedVersion,
    publishSource: publishSource.source,
    artifactRootExists: fs.existsSync(publishSource.rootPath),
  });
  // #endregion
  let packaged;
  try {
    packaged = await packageArtifactAssets(publishSource.rootPath);
  } finally {
    await publishSource.cleanup();
  }
  const { files, projectType } = packaged;

  await ensureAuthenticatedSession({ baseUrl, electronSession: sessionToUse, parentWindow });
  await verifyGitLabAvailability(baseUrl, sessionToUse);

  const sessionUsername = await getSessionUsername(sessionToUse, baseUrl);
  const projectName = name || "PORTICO Artifact";
  const slug = formatSlug(projectName, `portico-artifact-${String(artifactId).slice(0, 8)}`);
  const userId = sessionUsername || username || os.userInfo().username;

  const createResult = await fetchPrototypeJson({
    baseUrl,
    electronSession: sessionToUse,
    pathName: "/api/projects",
    method: "POST",
    body: {
      projectName,
      slug,
      projectDescription: `AI Generated ${projectType === "typescript" ? "TypeScript" : "HTML"} Project`,
      tags: [
        { id: "sandbox:source:ai", name: "AI Generated" },
        {
          id: `sandbox:type:${projectType}`,
          name: `Type: ${projectType === "typescript" ? "TypeScript" : "HTML"}`,
        },
      ],
      access: "private",
      archived: false,
      hidden: false,
      _userId: userId,
    },
  });

  const project = createResult.project;
  const projectId = project?._id || project?.id;
  if (!projectId) {
    throw new Error("Prototypes did not return a project id.");
  }

  // #region agent log
  debugPublishLog("B", "artifact-publisher.js:publishArtifactToPrototypes:projectCreated", "Created Prototypes project before upload", {
    baseUrl,
    projectId,
    projectType,
    projectUrl: `${baseUrl}/projects/${projectId}`,
    fileCount: files.length,
  });
  // #endregion

  const projectSlug = project.slug || slug || projectId;
  const projectUrl = `${baseUrl}/projects/${projectId}`;
  const prototypeUrl = project.link || `${baseUrl}/sandbox/apps/${projectSlug}/`;
  let uploadResult;

  try {
    uploadResult = await fetchPrototypeJson({
      baseUrl,
      electronSession: sessionToUse,
      pathName: `/api/gitlab/projects/${encodeURIComponent(projectId)}/trigger-pipeline`,
      method: "POST",
      body: {
        projectType,
        files,
      },
    });
  } catch (error) {
    // #region agent log
    debugPublishLog("B,C,E", "artifact-publisher.js:publishArtifactToPrototypes:uploadFailed", "Upload failed after project creation", {
      baseUrl,
      projectId,
      projectType,
      fileCount: files.length,
      status: error.status || null,
      bodyCode: error.body?.code || null,
      bodyError: error.body?.error || null,
    });
    // #endregion
    error.message = `Created Prototypes project ${projectId}, but file upload failed: ${error.message}`;
    error.projectId = projectId;
    error.projectUrl = projectUrl;
    error.prototypeUrl = prototypeUrl;
    throw error;
  }

  return {
    success: true,
    baseUrl,
    projectId,
    projectType,
    fileCount: files.length,
    projectUrl,
    prototypeUrl,
    branch: uploadResult.branch,
    upload: uploadResult,
  };
}

module.exports = {
  DEFAULT_PROTOTYPES_BASE_URL,
  getConfiguredPrototypesBaseUrl,
  inferProjectType,
  normalizePrototypesBaseUrl,
  packageArtifactAssets,
  publishArtifactToPrototypes,
  resolveArtifactPublishSource,
  resolveSnapshotArchivePath,
  _test: {
    formatSlug,
    isPathWithinRoot,
    resolveLegacyArtifactRoot,
    shouldSkipDirectory,
    shouldSkipFile,
  },
};
