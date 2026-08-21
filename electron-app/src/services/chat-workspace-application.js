const fsPromises = require("fs").promises;
const os = require("os");
const path = require("path");

const { createEnhancedEnv } = require("./env-paths");
const {
  getChatWorkspaceSelection,
  refreshLinkedChatWorkspaceSnapshots,
  setChatWorkspaceSelection,
} = require("./chat-workspaces");
const {
  rebindChatAgentVms,
  validateWorkspaceBind,
} = require("./agent-vm-workspace-rebind");

function isInternalContainerWorkspacePath(hostPath) {
  const normalized = String(hostPath || "").replace(/\\/g, "/");
  return (
    normalized === "/app/mcpo-runtime-homes" ||
    normalized.startsWith("/app/mcpo-runtime-homes/")
  );
}

function expandHomeWorkspacePath(rawHostPath, options = {}) {
  const fieldName = options.fieldName || "Selected workspace folder";
  if (rawHostPath === "~" || rawHostPath.startsWith("~/")) {
    const homeDir = options.homeDir || os.homedir() || process.env.HOME;
    if (!homeDir) {
      throw new Error(`${fieldName} uses '~' but HOME is not set`);
    }
    return rawHostPath === "~"
      ? path.resolve(homeDir)
      : path.join(homeDir, rawHostPath.slice(2));
  }
  if (rawHostPath.startsWith("~")) {
    throw new Error(`${fieldName} uses unsupported '~user' expansion`);
  }
  return rawHostPath;
}

function normalizeAbsoluteWorkspacePath(hostPath, options = {}) {
  const rawHostPath = String(hostPath || "").trim();
  if (!rawHostPath) {
    throw new Error("hostPath is required");
  }
  const expandedHostPath = expandHomeWorkspacePath(rawHostPath, options);
  const fieldName = options.fieldName || "Selected workspace folder";
  if (
    isInternalContainerWorkspacePath(rawHostPath) ||
    isInternalContainerWorkspacePath(expandedHostPath)
  ) {
    throw new Error(`${fieldName} points to an internal container path`);
  }
  if (!path.isAbsolute(expandedHostPath)) {
    throw new Error("Selected workspace folder must be an absolute path");
  }
  return path.resolve(expandedHostPath);
}

async function validateChatWorkspaceHostPath(hostPath, options = {}) {
  const selectedPath = normalizeAbsoluteWorkspacePath(hostPath, options);
  const stat = options.stat || fsPromises.stat;
  const stats = await stat(selectedPath);
  if (!stats.isDirectory()) {
    throw new Error("Selected workspace path is not a folder");
  }

  await (options.validateWorkspaceBind || validateWorkspaceBind)(selectedPath, {
    env: options.env || createEnhancedEnv(),
  });
  return selectedPath;
}

async function applyChatWorkspaceSelection({
  projectRoot = "",
  chatId = "",
  hostPath = null,
  previousSelection = null,
  env = createEnhancedEnv(),
  getSelection = getChatWorkspaceSelection,
  setSelection = setChatWorkspaceSelection,
  rebind = rebindChatAgentVms,
  fanOut = fanOutRootWorkspaceChangeToLinkedChats,
} = {}) {
  const previous =
    previousSelection ||
    getSelection({
      projectRoot,
      chatId,
    });

  const nextSelection = await setSelection({
    projectRoot,
    chatId,
    hostPath,
  });

  try {
    const rebindResult = await rebind(chatId, nextSelection.hostPath, {
      env,
    });
    // Only after the root's own rebind succeeds (a rollback must never leave
    // linked children moved): follow the change out to chats that share this
    // chat's workspace via start_chat links.
    const fanOutResults = await fanOut({
      projectRoot,
      rootChatId: chatId,
      env,
      rebind,
      getSelection,
    });
    return {
      success: true,
      selection: nextSelection,
      rebind: rebindResult,
      fanOut: fanOutResults,
    };
  } catch (error) {
    await setSelection({
      projectRoot,
      chatId,
      hostPath: previous.isCustom ? previous.hostPath : null,
    });
    try {
      await rebind(chatId, previous.hostPath, {
        env: createEnhancedEnv(),
      });
    } catch (rollbackError) {
      console.error(
        "[Workspace] Failed to roll Agent VMs back to previous workspace:",
        rollbackError,
      );
    }
    throw error;
  }
}

async function validateAndApplyChatWorkspaceSelection({
  projectRoot = "",
  chatId = "",
  hostPath = "",
  previousSelection = null,
  env = createEnhancedEnv(),
  ...options
} = {}) {
  const selectedPath = await validateChatWorkspaceHostPath(hostPath, {
    ...options,
    env,
  });
  return applyChatWorkspaceSelection({
    projectRoot,
    chatId,
    hostPath: selectedPath,
    previousSelection,
    env,
    ...options,
  });
}

async function fanOutRootWorkspaceChangeToLinkedChats({
  projectRoot = "",
  rootChatId = "",
  env = createEnhancedEnv(),
  refreshSnapshots = refreshLinkedChatWorkspaceSnapshots,
  rebind = rebindChatAgentVms,
  getSelection = getChatWorkspaceSelection,
} = {}) {
  let refreshed = [];
  try {
    refreshed = await refreshSnapshots({ projectRoot, rootChatId, env });
  } catch (error) {
    console.error(
      "[Workspace] Failed to refresh linked chat workspace snapshots:",
      error,
    );
    return [];
  }

  const results = [];
  for (const child of refreshed) {
    const result = {
      chatId: child.chatId,
      hostPath: child.hostPath,
    };
    try {
      // Best-effort: a failed child VM rebind must never roll back the
      // root's change; the per-submit reconcile heals it on the child's
      // next manual prompt.
      await rebind(child.chatId, child.hostPath, { env });
    } catch (error) {
      result.rebindError = String(error?.message || error);
      console.error(
        `[Workspace] Failed to rebind Agent VMs for linked chat ${child.chatId}:`,
        error,
      );
    }
    try {
      result.selection = getSelection({ projectRoot, chatId: child.chatId });
    } catch (_error) {
      result.selection = null;
    }
    results.push(result);
  }
  return results;
}

module.exports = {
  applyChatWorkspaceSelection,
  expandHomeWorkspacePath,
  fanOutRootWorkspaceChangeToLinkedChats,
  isInternalContainerWorkspacePath,
  normalizeAbsoluteWorkspacePath,
  validateAndApplyChatWorkspaceSelection,
  validateChatWorkspaceHostPath,
};
