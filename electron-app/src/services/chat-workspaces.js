const fs = require("fs");
const os = require("os");
const path = require("path");

const WORKSPACE_URL_SEGMENT_EXTRA_ESCAPE_RE = /[!'()*]/g;
const CHAT_WORKSPACES_SETTINGS_FILE = "chat-workspaces.json";
const WORKSPACE_CFG_DIR_NAME = "workspace-cfg";

function isPathWithinRoot(targetPath, rootPath) {
  const resolvedRoot = path.resolve(String(rootPath || ""));
  const resolvedTarget = path.resolve(String(targetPath || ""));

  return (
    resolvedTarget === resolvedRoot ||
    resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)
  );
}

function resolveWorkspaceCfgDir({ projectRoot = "", env = process.env } = {}) {
  const configured = String(env.PORTICO_WORKSPACE_CFG_DIR || "").trim();
  if (configured) {
    return path.resolve(configured);
  }

  try {
    const { app } = require("electron");
    if (app && typeof app.getPath === "function") {
      const userDataPath = app.getPath("userData");
      if (userDataPath) {
        return path.resolve(path.join(userDataPath, WORKSPACE_CFG_DIR_NAME));
      }
    }
  } catch (_error) {
    // Non-Electron tests and scripts fall back to the repo-local workspace-cfg dir.
  }

  const normalizedProjectRoot = String(projectRoot || "").trim();
  if (!normalizedProjectRoot) {
    throw new Error("projectRoot is required");
  }

  return path.resolve(
    path.join(normalizedProjectRoot, "open-webui-data", WORKSPACE_CFG_DIR_NAME),
  );
}

function resolveAppSupportDir({ projectRoot = "", env = process.env } = {}) {
  const configured = String(env.PORTICO_APP_SUPPORT_DIR || "").trim();
  if (configured) {
    return path.resolve(configured);
  }

  try {
    const { app } = require("electron");
    if (app && typeof app.getPath === "function") {
      const userDataPath = app.getPath("userData");
      if (userDataPath) {
        return path.resolve(userDataPath);
      }
    }
  } catch (_error) {
    // Non-Electron tests and scripts fall back to the repo-local app-support dir.
  }

  const normalizedProjectRoot = String(projectRoot || "").trim();
  if (!normalizedProjectRoot) {
    throw new Error("projectRoot is required");
  }

  return path.resolve(
    path.join(normalizedProjectRoot, "open-webui-data", "app-support"),
  );
}

function resolveLegacyProjectAppSupportDir(projectRoot = "") {
  const normalizedProjectRoot = String(projectRoot || "").trim();
  if (!normalizedProjectRoot) {
    return "";
  }
  return path.resolve(
    path.join(normalizedProjectRoot, "open-webui-data", "app-support"),
  );
}

function resolveChatWorkspaceSettingsPath(options = {}) {
  return path.join(resolveWorkspaceCfgDir(options), CHAT_WORKSPACES_SETTINGS_FILE);
}

function resolveLegacyChatWorkspaceSettingsPaths({
  projectRoot = "",
  env = process.env,
} = {}) {
  const paths = [];
  const legacyDirs = [];
  try {
    legacyDirs.push(resolveAppSupportDir({ projectRoot, env }));
  } catch (_error) {
    // No legacy app-support path is available in non-Electron callers without a project root.
  }
  legacyDirs.push(resolveLegacyProjectAppSupportDir(projectRoot));

  for (const legacyDir of legacyDirs) {
    if (!legacyDir) {
      continue;
    }
    const legacyPath = path.join(legacyDir, CHAT_WORKSPACES_SETTINGS_FILE);
    if (!paths.includes(legacyPath)) {
      paths.push(legacyPath);
    }
  }
  return paths;
}

function readChatWorkspaceSettings({
  projectRoot = "",
  env = process.env,
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync,
  mkdirSync = fs.mkdirSync,
  writeFileSync = fs.writeFileSync,
} = {}) {
  const settingsPath = resolveChatWorkspaceSettingsPath({ projectRoot, env });
  let pathToRead = settingsPath;
  if (!existsSync(settingsPath)) {
    pathToRead = "";
    for (const legacySettingsPath of resolveLegacyChatWorkspaceSettingsPaths({
      projectRoot,
      env,
    })) {
      if (legacySettingsPath !== settingsPath && existsSync(legacySettingsPath)) {
        pathToRead = legacySettingsPath;
        break;
      }
    }
    if (!pathToRead) {
      return { chats: {} };
    }
  }

  try {
    const parsed = JSON.parse(readFileSync(pathToRead, "utf8"));
    if (!parsed || typeof parsed !== "object" || typeof parsed.chats !== "object") {
      return { chats: {} };
    }
    if (pathToRead !== settingsPath) {
      try {
        mkdirSync(path.dirname(settingsPath), { recursive: true });
        writeFileSync(settingsPath, `${JSON.stringify(parsed, null, 2)}\n`);
      } catch (_error) {
        // Best-effort migration; callers can still use the legacy settings payload.
      }
    }
    return parsed;
  } catch (_error) {
    return { chats: {} };
  }
}

async function writeChatWorkspaceSettings({
  projectRoot = "",
  env = process.env,
  settings,
  mkdir = fs.promises.mkdir,
  writeFile = fs.promises.writeFile,
} = {}) {
  const settingsPath = resolveChatWorkspaceSettingsPath({ projectRoot, env });
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settings || { chats: {} }, null, 2)}\n`);
  return settingsPath;
}

function collapseHomePath(hostPath, homeDir = os.homedir()) {
  const resolvedPath = path.resolve(String(hostPath || ""));
  const resolvedHome = path.resolve(String(homeDir || ""));
  if (!resolvedHome || resolvedHome === path.sep) {
    return resolvedPath;
  }
  if (resolvedPath === resolvedHome) {
    return "~";
  }
  if (resolvedPath.startsWith(`${resolvedHome}${path.sep}`)) {
    return `~/${path.relative(resolvedHome, resolvedPath).replace(/\\/g, "/")}`;
  }
  return resolvedPath;
}

function resolveCanonicalChatWorkspacePath({ projectRoot = "", chatId = "" } = {}) {
  const normalizedProjectRoot = String(projectRoot || "").trim();
  if (!normalizedProjectRoot) {
    throw new Error("projectRoot is required");
  }

  const normalizedChatId = String(chatId || "").trim();
  if (!normalizedChatId) {
    throw new Error("chatId is required");
  }

  const workspacesDir = path.resolve(path.join(normalizedProjectRoot, "workspaces"));
  const chatWorkspace = path.resolve(path.join(workspacesDir, normalizedChatId));
  if (!isPathWithinRoot(chatWorkspace, workspacesDir)) {
    throw new Error("Invalid path - outside workspaces directory");
  }

  return {
    workspacesDir,
    chatWorkspace,
    canonicalChatWorkspace: chatWorkspace,
  };
}

function resolveIsUserSelectedCustomWorkspace({
  projectRoot = "",
  settings = { chats: {} },
  entry = null,
  chatWorkspace = "",
} = {}) {
  const customPath = String(entry?.host_path || "").trim();
  if (entry?.source !== "custom" || !customPath || !path.isAbsolute(customPath)) {
    return false;
  }

  const inheritedWorkspace = Boolean(
    entry?.inherited_workspace || entry?.inherited_from_chat_id || entry?.root_parent_chat_id,
  );
  if (!inheritedWorkspace) {
    return true;
  }

  const rootParentChatId = String(entry?.root_parent_chat_id || "").trim();
  if (!rootParentChatId) {
    return false;
  }

  const resolvedWorkspace = path.resolve(String(chatWorkspace || customPath));
  const rootEntry = settings.chats?.[rootParentChatId];
  const rootCustomPath = String(rootEntry?.host_path || "").trim();
  if (
    rootEntry?.source === "custom" &&
    rootCustomPath &&
    path.isAbsolute(rootCustomPath) &&
    path.resolve(rootCustomPath) === resolvedWorkspace
  ) {
    return true;
  }

  try {
    const rootCanonical = resolveCanonicalChatWorkspacePath({
      projectRoot,
      chatId: rootParentChatId,
    });
    return path.resolve(rootCanonical.chatWorkspace) !== resolvedWorkspace;
  } catch (_error) {
    // Ambiguous or malformed inherited metadata must not expose an internal path.
    return false;
  }
}

function resolveChatWorkspacePath({
  projectRoot = "",
  chatId = "",
  env = process.env,
  homeDir = os.homedir(),
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync,
  mkdirSync = fs.mkdirSync,
  writeFileSync = fs.writeFileSync,
} = {}) {
  const canonical = resolveCanonicalChatWorkspacePath({ projectRoot, chatId });
  const settings = readChatWorkspaceSettings({
    projectRoot,
    env,
    existsSync,
    readFileSync,
    mkdirSync,
    writeFileSync,
  });
  const entry = settings.chats?.[String(chatId || "").trim()];
  const inheritedWorkspace = Boolean(
    entry?.inherited_workspace || entry?.inherited_from_chat_id || entry?.root_parent_chat_id
  );
  const inheritedFromChatId = String(entry?.inherited_from_chat_id || "").trim();
  const rootParentChatId = String(entry?.root_parent_chat_id || "").trim();
  const linkedWorkspace = Boolean(entry?.linked_workspace);
  const customPath = String(entry?.host_path || "").trim();
  if (entry?.source === "custom" && customPath && path.isAbsolute(customPath)) {
    let chatWorkspace = path.resolve(customPath);
    if (linkedWorkspace) {
      // Workspace-linked chats (started by another chat) follow the ROOT
      // chat's CURRENT binding at read time; the entry's own host_path is
      // only a fallback snapshot for anomalies.
      const linkedRootWorkspace = resolveLinkedRootWorkspacePath({
        projectRoot,
        settings,
        chatId,
        rootParentChatId,
      });
      if (linkedRootWorkspace) {
        chatWorkspace = linkedRootWorkspace;
      }
    }
    return {
      ...canonical,
      chatWorkspace,
      source: "custom",
      isCustom: true,
      isUserSelectedCustom: resolveIsUserSelectedCustomWorkspace({
        projectRoot,
        settings,
        entry,
        chatWorkspace,
      }),
      displayPath: collapseHomePath(chatWorkspace, homeDir),
      inheritedWorkspace,
      inheritedFromChatId,
      rootParentChatId,
      linkedWorkspace,
    };
  }

  return {
    ...canonical,
    source: "canonical",
    isCustom: false,
    isUserSelectedCustom: false,
    displayPath: "",
    inheritedWorkspace: false,
    inheritedFromChatId: "",
    rootParentChatId: "",
    linkedWorkspace: false,
  };
}

function resolveLinkedRootWorkspacePath({
  projectRoot = "",
  settings = { chats: {} },
  chatId = "",
  rootParentChatId = "",
} = {}) {
  const root = String(rootParentChatId || "").trim();
  const self = String(chatId || "").trim();
  if (
    !root ||
    root === self ||
    root.includes("/") ||
    root.includes("\\") ||
    root.includes("\0") ||
    root.startsWith(".")
  ) {
    return null;
  }
  const rootEntry = settings.chats?.[root];
  if (rootEntry?.linked_workspace) {
    // One hop only: a linked root is an anomaly — keep the snapshot.
    return null;
  }
  const rootCustomPath = String(rootEntry?.host_path || "").trim();
  if (rootEntry?.source === "custom" && rootCustomPath && path.isAbsolute(rootCustomPath)) {
    return path.resolve(rootCustomPath);
  }
  try {
    return resolveCanonicalChatWorkspacePath({ projectRoot, chatId: root }).chatWorkspace;
  } catch (_error) {
    return null;
  }
}

function getChatWorkspaceSelection(options = {}) {
  const workspace = resolveChatWorkspacePath(options);
  return {
    chatId: String(options.chatId || "").trim(),
    source: workspace.source,
    isCustom: workspace.isCustom,
    isUserSelectedCustom: workspace.isUserSelectedCustom,
    hostPath: workspace.chatWorkspace,
    canonicalPath: workspace.canonicalChatWorkspace,
    displayPath: workspace.displayPath,
    inheritedWorkspace: workspace.inheritedWorkspace,
    inheritedFromChatId: workspace.inheritedFromChatId,
    rootParentChatId: workspace.rootParentChatId,
    linkedWorkspace: workspace.linkedWorkspace,
  };
}

async function setChatWorkspaceSelection({
  projectRoot = "",
  chatId = "",
  hostPath = null,
  env = process.env,
  now = () => new Date(),
  ...io
} = {}) {
  resolveCanonicalChatWorkspacePath({ projectRoot, chatId });
  const normalizedChatId = String(chatId || "").trim();
  const settings = readChatWorkspaceSettings({ projectRoot, env, ...io });
  const chats = { ...(settings.chats || {}) };

  if (hostPath === null || hostPath === undefined || String(hostPath).trim() === "") {
    delete chats[normalizedChatId];
  } else {
    const rawHostPath = String(hostPath).trim();
    if (!path.isAbsolute(rawHostPath)) {
      throw new Error("Selected workspace folder must be an absolute path");
    }
    const resolvedHostPath = path.resolve(rawHostPath);
    chats[normalizedChatId] = {
      source: "custom",
      host_path: resolvedHostPath,
      selected_at: now().toISOString(),
    };
  }

  await writeChatWorkspaceSettings({
    projectRoot,
    env,
    settings: { ...settings, chats },
    ...io,
  });

  return getChatWorkspaceSelection({
    projectRoot,
    chatId,
    env,
    existsSync: io.existsSync,
    readFileSync: io.readFileSync,
    homeDir: io.homeDir,
  });
}

async function moveChatWorkspaceSelection({
  projectRoot = "",
  fromChatId = "",
  toChatId = "",
  env = process.env,
  now = () => new Date(),
  ...io
} = {}) {
  const normalizedFromChatId = String(fromChatId || "").trim();
  const normalizedToChatId = String(toChatId || "").trim();

  if (
    !normalizedFromChatId ||
    !normalizedToChatId ||
    normalizedFromChatId === normalizedToChatId
  ) {
    return {
      moved: false,
      fromChatId: normalizedFromChatId,
      toChatId: normalizedToChatId,
    };
  }

  resolveCanonicalChatWorkspacePath({
    projectRoot,
    chatId: normalizedFromChatId,
  });
  resolveCanonicalChatWorkspacePath({
    projectRoot,
    chatId: normalizedToChatId,
  });

  const settings = readChatWorkspaceSettings({ projectRoot, env, ...io });
  const sourceEntry = settings.chats?.[normalizedFromChatId];
  const sourceHostPath = String(sourceEntry?.host_path || "").trim();
  if (sourceEntry?.source !== "custom" || !path.isAbsolute(sourceHostPath)) {
    return {
      moved: false,
      fromChatId: normalizedFromChatId,
      toChatId: normalizedToChatId,
      selection: getChatWorkspaceSelection({
        projectRoot,
        chatId: normalizedToChatId,
        env,
        existsSync: io.existsSync,
        readFileSync: io.readFileSync,
        homeDir: io.homeDir,
      }),
    };
  }

  const chats = { ...(settings.chats || {}) };
  chats[normalizedToChatId] = {
    source: "custom",
    host_path: path.resolve(sourceHostPath),
    selected_at:
      typeof sourceEntry.selected_at === "string" && sourceEntry.selected_at.trim()
        ? sourceEntry.selected_at
        : now().toISOString(),
  };
  delete chats[normalizedFromChatId];

  await writeChatWorkspaceSettings({
    projectRoot,
    env,
    settings: { ...settings, chats },
    ...io,
  });

  return {
    moved: true,
    fromChatId: normalizedFromChatId,
    toChatId: normalizedToChatId,
    selection: getChatWorkspaceSelection({
      projectRoot,
      chatId: normalizedToChatId,
      env,
      existsSync: io.existsSync,
      readFileSync: io.readFileSync,
      homeDir: io.homeDir,
    }),
  };
}

function resolveChatWorkspaceEntryPath({
  projectRoot = "",
  chatId = "",
  relativePath = "",
  ...options
} = {}) {
  const workspace = resolveChatWorkspacePath({ projectRoot, chatId, ...options });
  const targetPath = path.resolve(
    path.join(workspace.chatWorkspace, String(relativePath || "")),
  );

  if (!isPathWithinRoot(targetPath, workspace.chatWorkspace)) {
    throw new Error("Invalid path - outside chat workspace");
  }

  return {
    ...workspace,
    targetPath,
  };
}

const SKILL_ASSETS_DIR_NAME = "skill-assets";

// skills_get_skill_assets (Rust skills server) always materializes skill assets
// in the CANONICAL workspace dir (<project>/workspaces/<chatId>/skill-assets/...)
// and hands out /workspace/<chatId>/skill-assets/... URLs. Chats bound to a
// custom workspace never receive a copy in that custom folder, so file-serving
// callers may fall back to the canonical copy when the custom-resolved entry is
// missing. This wrapper keeps resolveChatWorkspaceEntryPath semantics untouched
// (same traversal 403s) and only EXPOSES the canonical candidate path; callers
// decide to use it after the primary path fails to stat.
function resolveChatWorkspaceEntryPathWithSkillAssetFallback({
  projectRoot = "",
  chatId = "",
  relativePath = "",
  ...options
} = {}) {
  const resolved = resolveChatWorkspaceEntryPath({
    projectRoot,
    chatId,
    relativePath,
    ...options,
  });

  const normalizedRelativePath = String(relativePath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  if (
    !resolved.isCustom ||
    !normalizedRelativePath.startsWith(`${SKILL_ASSETS_DIR_NAME}/`)
  ) {
    return { ...resolved, skillAssetFallbackPath: null };
  }

  const canonicalSkillAssetsRoot = path.resolve(
    path.join(resolved.canonicalChatWorkspace, SKILL_ASSETS_DIR_NAME),
  );
  const skillAssetFallbackPath = path.resolve(
    path.join(resolved.canonicalChatWorkspace, normalizedRelativePath),
  );
  if (!isPathWithinRoot(skillAssetFallbackPath, canonicalSkillAssetsRoot)) {
    // e.g. "skill-assets/../report.md" — legitimate inside the selected
    // workspace, but never eligible for the canonical skill-assets fallback.
    return { ...resolved, skillAssetFallbackPath: null };
  }

  return {
    ...resolved,
    skillAssetFallbackPath,
  };
}

function encodeWorkspaceUrlSegment(value = "") {
  return encodeURIComponent(String(value || "").trim()).replace(
    WORKSPACE_URL_SEGMENT_EXTRA_ESCAPE_RE,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function buildWorkspaceFileUrl({
  host = "localhost",
  port = 9876,
  chatId = "",
  filePath = "",
} = {}) {
  const normalizedChatId = String(chatId || "").trim();
  if (!normalizedChatId) {
    throw new Error("chatId is required");
  }

  const normalizedFilePath = String(filePath || "").trim();
  if (!normalizedFilePath) {
    throw new Error("filePath is required");
  }

  const encodedFilePath = normalizedFilePath
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeWorkspaceUrlSegment(segment))
    .join("/");

  return `http://${host}:${port}/workspace/${encodeWorkspaceUrlSegment(normalizedChatId)}/${encodedFilePath}`;
}

async function ensureChatWorkspaceDirectories({
  projectRoot = "",
  chatId = "",
  mkdir = fs.promises.mkdir,
} = {}) {
  const workspace = resolveChatWorkspacePath({ projectRoot, chatId });
  // Generated dirs are safe to create on demand — the chat's own canonical
  // dir, or (for workspace-linked chats) the root chat's generated dir,
  // which also lives under the workspaces root.
  if (
    !workspace.isCustom ||
    isPathWithinRoot(workspace.chatWorkspace, workspace.workspacesDir)
  ) {
    await mkdir(workspace.chatWorkspace, { recursive: true });
  }
  return workspace;
}

async function refreshLinkedChatWorkspaceSnapshots({
  projectRoot = "",
  rootChatId = "",
  env = process.env,
  now = () => new Date(),
  ...io
} = {}) {
  const normalizedRootChatId = String(rootChatId || "").trim();
  if (!normalizedRootChatId) {
    return [];
  }
  const settings = readChatWorkspaceSettings({ projectRoot, env, ...io });
  const chats = { ...(settings.chats || {}) };
  const linkedChildIds = Object.keys(chats).filter((chatId) => {
    const entry = chats[chatId];
    return (
      Boolean(entry?.linked_workspace) &&
      String(entry?.root_parent_chat_id || "").trim() === normalizedRootChatId &&
      chatId !== normalizedRootChatId
    );
  });
  if (linkedChildIds.length === 0) {
    return [];
  }

  const rootEntry = chats[normalizedRootChatId];
  const rootCustomPath = String(rootEntry?.host_path || "").trim();
  let resolvedRootPath;
  if (
    rootEntry?.source === "custom" &&
    rootCustomPath &&
    path.isAbsolute(rootCustomPath) &&
    !rootEntry?.linked_workspace
  ) {
    resolvedRootPath = path.resolve(rootCustomPath);
  } else {
    resolvedRootPath = resolveCanonicalChatWorkspacePath({
      projectRoot,
      chatId: normalizedRootChatId,
    }).chatWorkspace;
  }

  const refreshed = [];
  for (const childChatId of linkedChildIds) {
    chats[childChatId] = {
      ...chats[childChatId],
      host_path: resolvedRootPath,
      selected_at: now().toISOString(),
    };
    refreshed.push({ chatId: childChatId, hostPath: resolvedRootPath });
  }
  await writeChatWorkspaceSettings({
    projectRoot,
    env,
    settings: { ...settings, chats },
    ...io,
  });
  return refreshed;
}

module.exports = {
  CHAT_WORKSPACES_SETTINGS_FILE,
  buildWorkspaceFileUrl,
  collapseHomePath,
  encodeWorkspaceUrlSegment,
  ensureChatWorkspaceDirectories,
  getChatWorkspaceSelection,
  isPathWithinRoot,
  moveChatWorkspaceSelection,
  readChatWorkspaceSettings,
  refreshLinkedChatWorkspaceSnapshots,
  resolveAppSupportDir,
  resolveCanonicalChatWorkspacePath,
  resolveChatWorkspaceEntryPath,
  resolveChatWorkspaceEntryPathWithSkillAssetFallback,
  resolveChatWorkspacePath,
  resolveChatWorkspaceSettingsPath,
  resolveLegacyChatWorkspaceSettingsPaths,
  resolveLegacyProjectAppSupportDir,
  resolveWorkspaceCfgDir,
  setChatWorkspaceSelection,
};
