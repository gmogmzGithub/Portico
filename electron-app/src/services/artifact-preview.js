const fsPromises = require("fs").promises;
const path = require("path");

const {
  resolveChatWorkspaceEntryPath,
} = require("./chat-workspaces");

const ARTIFACT_SNAPSHOTS_DIR = "artifact-snapshots";
const ARTIFACT_WORKSPACES_DIR = "_workspaces";
const ARTIFACT_VERSION_WORKSPACES_DIR = "_version_workspaces";

function createPreviewError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function isPathWithinRoot(targetPath, rootPath) {
  const resolvedTarget = path.resolve(String(targetPath || ""));
  const resolvedRoot = path.resolve(String(rootPath || ""));
  const relative = path.relative(resolvedRoot, resolvedTarget);
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizePreviewPath(requestedPath = "") {
  return String(requestedPath || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function isSafeArtifactId(artifactId = "") {
  const normalized = String(artifactId || "").trim();
  return (
    normalized.length > 0 &&
    normalized !== "." &&
    normalized !== ".." &&
    !normalized.includes("/") &&
    !normalized.includes("\\")
  );
}

function normalizePreviewVersion(version = "") {
  const normalized = String(version || "").trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw createPreviewError(403, "Invalid artifact version");
  }
  return Number(normalized);
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fsPromises.readFile(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function pathExists(filePath) {
  try {
    await fsPromises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function assertSnapshotMetadataBelongsToChat(metadata, chatId, artifactId) {
  if (
    !metadata ||
    metadata.chat_id !== chatId ||
    metadata.artifact_id !== artifactId
  ) {
    throw createPreviewError(403, "Artifact does not belong to chat");
  }
}

function assertSnapshotMetadataHasVersion(metadata, version) {
  const hasVersion = Array.isArray(metadata?.versions) &&
    metadata.versions.some((item) => Number(item?.version) === version);
  if (!hasVersion) {
    throw createPreviewError(404, "Artifact version preview not found");
  }
}

async function assertOptionalLegacyMetadataBelongsToChat(artifactRoot, chatId, artifactId) {
  const metadata = await readJsonIfExists(path.join(artifactRoot, "metadata.json"));
  if (!metadata) {
    return;
  }
  if (
    (metadata.chat_id && metadata.chat_id !== chatId) ||
    (metadata.artifact_id && metadata.artifact_id !== artifactId)
  ) {
    throw createPreviewError(403, "Artifact does not belong to chat");
  }
}

async function resolveSnapshotArtifactPreviewRoot({
  projectRoot = "",
  chatId = "",
  artifactId = "",
} = {}) {
  const snapshotsRoot = path.resolve(projectRoot, ARTIFACT_SNAPSHOTS_DIR);
  const workspacesRoot = path.join(snapshotsRoot, ARTIFACT_WORKSPACES_DIR);
  const metadataPath = path.resolve(snapshotsRoot, artifactId, "metadata.json");
  const artifactRoot = path.resolve(workspacesRoot, artifactId);

  if (
    !isPathWithinRoot(metadataPath, snapshotsRoot) ||
    !isPathWithinRoot(artifactRoot, workspacesRoot)
  ) {
    throw createPreviewError(403, "Invalid artifact path");
  }

  const metadata = await readJsonIfExists(metadataPath);
  if (!metadata) {
    return null;
  }
  assertSnapshotMetadataBelongsToChat(metadata, chatId, artifactId);

  if (!(await pathExists(artifactRoot))) {
    return null;
  }

  return {
    artifactRoot,
    source: "snapshot",
  };
}

async function resolveSnapshotArtifactVersionPreviewRoot({
  projectRoot = "",
  chatId = "",
  artifactId = "",
  version = "",
} = {}) {
  const versionNumber = normalizePreviewVersion(version);
  const snapshotsRoot = path.resolve(projectRoot, ARTIFACT_SNAPSHOTS_DIR);
  const workspacesRoot = path.join(snapshotsRoot, ARTIFACT_VERSION_WORKSPACES_DIR);
  const metadataPath = path.resolve(snapshotsRoot, artifactId, "metadata.json");
  const artifactVersionsRoot = path.resolve(workspacesRoot, artifactId);
  const artifactRoot = path.resolve(artifactVersionsRoot, `v${versionNumber}`);

  if (
    !isPathWithinRoot(metadataPath, snapshotsRoot) ||
    !isPathWithinRoot(artifactVersionsRoot, workspacesRoot) ||
    !isPathWithinRoot(artifactRoot, artifactVersionsRoot)
  ) {
    throw createPreviewError(403, "Invalid artifact path");
  }

  const metadata = await readJsonIfExists(metadataPath);
  if (!metadata) {
    throw createPreviewError(404, "Artifact preview not found");
  }
  assertSnapshotMetadataBelongsToChat(metadata, chatId, artifactId);
  assertSnapshotMetadataHasVersion(metadata, versionNumber);

  if (!(await pathExists(artifactRoot))) {
    throw createPreviewError(404, "Artifact version preview not found");
  }

  return {
    artifactRoot,
    source: "version-snapshot",
    version: versionNumber,
  };
}

async function resolveLegacyArtifactPreviewRoot({
  projectRoot = "",
  chatId = "",
  artifactId = "",
  env = process.env,
  workspaceResolver = resolveChatWorkspaceEntryPath,
} = {}) {
  let artifactRoot;
  let artifactsRoot;
  try {
    artifactRoot = workspaceResolver({
      projectRoot,
      chatId,
      env,
      relativePath: path.join("artifacts", artifactId),
    }).targetPath;
    artifactsRoot = workspaceResolver({
      projectRoot,
      chatId,
      env,
      relativePath: "artifacts",
    }).targetPath;
  } catch (_error) {
    throw createPreviewError(403, "Invalid artifact path");
  }

  if (!isPathWithinRoot(artifactRoot, artifactsRoot)) {
    throw createPreviewError(403, "Invalid artifact path");
  }
  if (!(await pathExists(artifactRoot))) {
    return null;
  }

  await assertOptionalLegacyMetadataBelongsToChat(artifactRoot, chatId, artifactId);

  return {
    artifactRoot,
    source: "legacy",
  };
}

async function resolveArtifactPreviewRoot(options = {}) {
  const chatId = String(options.chatId || "").trim();
  const artifactId = String(options.artifactId || "").trim();

  if (!chatId || !artifactId) {
    throw createPreviewError(400, "chatId and artifactId are required");
  }
  if (!isSafeArtifactId(artifactId)) {
    throw createPreviewError(403, "Invalid artifact path");
  }

  const snapshotRoot = await resolveSnapshotArtifactPreviewRoot({
    projectRoot: options.projectRoot,
    chatId,
    artifactId,
  });
  if (snapshotRoot) {
    return snapshotRoot;
  }

  const legacyRoot = await resolveLegacyArtifactPreviewRoot({
    projectRoot: options.projectRoot,
    chatId,
    artifactId,
    env: options.env,
    workspaceResolver: options.workspaceResolver,
  });
  if (legacyRoot) {
    return legacyRoot;
  }

  throw createPreviewError(404, "Artifact preview not found");
}

async function resolveArtifactPreviewFile(options = {}) {
  const root = await resolveArtifactPreviewRoot(options);
  return resolvePreviewFileFromRoot(root, options.requestedPath);
}

async function resolveArtifactVersionPreviewFile(options = {}) {
  const chatId = String(options.chatId || "").trim();
  const artifactId = String(options.artifactId || "").trim();

  if (!chatId || !artifactId) {
    throw createPreviewError(400, "chatId and artifactId are required");
  }
  if (!isSafeArtifactId(artifactId)) {
    throw createPreviewError(403, "Invalid artifact path");
  }

  const root = await resolveSnapshotArtifactVersionPreviewRoot({
    projectRoot: options.projectRoot,
    chatId,
    artifactId,
    version: options.version,
  });
  return resolvePreviewFileFromRoot(root, options.requestedPath);
}

async function resolvePreviewFileFromRoot(root, requestedPath = "") {
  const normalizedPath = normalizePreviewPath(requestedPath);
  let resolvedPath = normalizedPath
    ? path.resolve(root.artifactRoot, normalizedPath)
    : path.join(root.artifactRoot, "index.html");

  if (!isPathWithinRoot(resolvedPath, root.artifactRoot)) {
    throw createPreviewError(403, "Invalid preview path");
  }

  try {
    const stats = await fsPromises.stat(resolvedPath);
    if (stats.isDirectory()) {
      resolvedPath = path.join(resolvedPath, "index.html");
    }
  } catch {
    if (normalizedPath && path.extname(normalizedPath)) {
      throw createPreviewError(404, "Preview asset not found");
    }
    resolvedPath = path.join(root.artifactRoot, "index.html");
  }

  if (!isPathWithinRoot(resolvedPath, root.artifactRoot)) {
    throw createPreviewError(403, "Invalid preview path");
  }

  let finalStats;
  try {
    finalStats = await fsPromises.stat(resolvedPath);
  } catch {
    throw createPreviewError(404, "Preview file not found");
  }

  if (finalStats.isDirectory()) {
    throw createPreviewError(404, "Preview file not found");
  }

  return {
    ...root,
    filePath: resolvedPath,
  };
}

module.exports = {
  ARTIFACT_SNAPSHOTS_DIR,
  ARTIFACT_VERSION_WORKSPACES_DIR,
  ARTIFACT_WORKSPACES_DIR,
  isPathWithinRoot,
  resolveArtifactPreviewFile,
  resolveArtifactPreviewRoot,
  resolveArtifactVersionPreviewFile,
};
