const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  dialog,
  Menu,
  nativeTheme,
  webContents,
  session,
  powerMonitor,
  protocol,
  net,
  safeStorage,
} = require("electron");

// Chromium's hardware compositor cannot create a supported EGL context in
// the Linux arm64 development VM. Its WebContentsViews then retain stale
// frames and intercept input even after being hidden. Use Chromium's software
// compositor on this development-only architecture.
if (process.platform === "linux" && process.arch === "arm64") {
  app.disableHardwareAcceleration();
}

const path = require("path");
const os = require("os");
const fs = require("fs");
const fsPromises = require("fs").promises;
const { exec, execFileSync, spawn } = require("child_process");
const util = require("util");
const {
  installAppProtocol,
  registerAppScheme,
} = require("./app-protocol");

registerAppScheme(protocol);

// Import shared state - centralized mutable state for the main process
const state = require("./shared-state");
const {
  defaultMcpOperationManager,
} = require("./mcp-operation-manager");

// Import bootstrap module - initialization, paths, menu, theme
const bootstrap = require("./bootstrap");

// Import windows module - window creation and lifecycle
const windows = require("./windows");

// Import docker-mcp module - Docker operations, MCP management, health checks
const dockerMcp = require("./docker-mcp");
const {
  cleanupStartupAgentVms,
  createShellCommandRunner,
} = require("./agent-vm-startup-cleanup");
const { createEnhancedEnv } = require("./env-paths");
const { ensureMcpOrcGeneratorCommand } = require("./mcp-orc-cli");
const {
  enforcePackagedMacArchitectureMatch,
} = require("./mac-arch-guard");
const {
  enforceNotStaleGuidedSetupAppLaunch,
} = require("./stale-guided-setup-app-guard");
const appLocationGuard = require("./app-location-guard");
const stopGuard = require("./managed-runtime-stop-guard");
const orbstackAvailability = require("./orbstack-availability");
const { createRuntimeShellEnv } = require("./runtime-shell-env");
const {
  computeGuidedSetupResizeBounds,
} = require("./guided-setup-window-bounds");
const { deriveUpdateFailureMessage } = require("./update-failure-message");
const { openHttpExternalUrl } = require("./shell-open");
const { stopSetupAuthBroker } = require("./setup-auth");
const { getQuitProvenance, tagAppQuit } = require("./quit-provenance");
const { handleSystemResume } = require("./system-resume-recovery");
const {
  emitAppLaunched,
} = require("./host-mcp-bridge-adoption-telemetry");

// Import updates module - Cloudsmith update checking and execution
const updates = require("./updates");
const updatePreparation = require("./update-preparation");
const prerequisitesService = require("./prerequisites-service");
const {
  createPrerequisitesQuitDrain,
} = require("./prerequisites-quit-drain");
const {
  runDockerStorageMaintenance,
} = require("./docker-storage-maintenance");
const {
  POST_HEALTH_CLEANUP_SOURCE,
  POST_HEALTH_CLEANUP_STEP,
  appendUpdateHistory,
  findPendingPostHealthCleanup,
} = require("./update-apply-audit");
const { initKonamiLogger } = require("./konami-logger");
const { readHostModeFileSync } = require("./host-mode-state");
const {
  ensureMcpCreateDirs,
  tryEnsureMcpCreateDirs,
} = require("./mcp-create-dirs");
const {
  migrateAllLegacyOAuthRecords,
} = require("./oauth-token-storage");
const {
  migrateUserMcpCollisions,
} = require("./mcp-user-collision-migration");
const owuiDataIntegrityGuard = require("./owui-data-integrity-guard");
const agentAttributionReconciliation = require("./agent-attribution-reconciliation");
const userSkillReconciliation = require("./user-skill-reconciliation");

// Import API module - Express REST server
const api = require("./api");
const { createApiServer, startApiServer, API_PORT } = api;

// Import IPC module - IPC handler registration
const ipc = require("./ipc");
const {
  registerAllIpcHandlers,
  setHandlerDependencies,
  ensureBundledMarketplaceDefaultsAtStartup,
} = ipc;

// Check for --dev command line flag (enables Electron/frontend hot-reload).
const isFrontendDevMode = process.argv.includes("--dev");
if (isFrontendDevMode) {
  console.log(
    "[Main] FRONTEND DEV MODE ENABLED - Electron hot-reload active on port 3790",
  );
}

const MCP_CONFIG_STARTUP_TIMEOUT_MS = 180000;

// Run startup initialization from bootstrap
bootstrap.logStartupInfo();
bootstrap.loadBuildInfo();

// Get path constants from bootstrap
const { APP_ROOT } = bootstrap;

// Get utility functions from bootstrap
const { killProcessOnPort, clearWebviewCache, execPromise, getLogPaths } =
  bootstrap;

// Alias buildInfo to shared state for backward compatibility
const buildInfo = state.buildInfo;

// For streaming logs - use shared state

// Host MCPO process management - use shared state
let hostMcpoProcess = state.hostMcpo.process;
let hostMcpoPort = state.hostMcpo.port;
let hostMcpoLogs = state.hostMcpo.logs;

// Window references - now accessed via shared state (set by windows.js)
// Local aliases for backward compatibility during migration
const getMainWindow = () => state.windows.main;
const getChatWindow = () => state.windows.chat;
const getLoadingWindow = () => state.windows.loading;

// Configuration - use shared state
let configData = state.configData;

// Docker status - use shared state
let dockerStatus = state.dockerStatus;
let statusCheckInterval = state.statusCheckInterval;

// App state flags - use shared state
let isManagerMode = state.appState.isManagerMode;
let isInitializing = state.appState.isInitializing;

// Track dismissed OAuth flows - use shared state
const dismissedOAuthFlows = state.dismissedOAuthFlows;

// Theme icon functions - imported from bootstrap
const { getThemeIcon, updateAllWindowIcons } = bootstrap;

// Window functions - imported from windows.js
const {
  createGuidedSetupWindow,
  createLoadingWindow,
  createMainWindow,
  createChatWindow,
  openNewChatWindow,
  closeMainWindow,
  checkForUpdatesFromMenu,
  checkSetupWizardNeeded,
  isFirstRun,
  resetConfigData,
  sendToLoadingWindow,
  sendToMainWindow,
  sendToChatWindow,
  sendToAllWindows,
  setupThemeListener,
} = windows;

// Menu and channel functions - imported from bootstrap
const {
  getCurrentChannel,
  getCurrentChannelInfo,
  getCurrentChannelLabel,
  setReleaseChannel,
  createMenu,
} = bootstrap;

let lastNewChatShortcutAt = 0;
let lastNewChatWindowShortcutAt = 0;
let lastCloseWindowShortcutAt = 0;
let hasShownManagerMainWindow = false;

function isCmdOrCtrl(input) {
  return process.platform === "darwin" ? input.meta === true : input.control === true;
}

function isKeyDown(input, key) {
  if (!input || input.type !== "keyDown" || input.isAutoRepeat) {
    return false;
  }
  return input.key?.toLowerCase() === key;
}

function isLocalSearchShortcut(input) {
  return isKeyDown(input, "f") && !input.shift && !input.alt && isCmdOrCtrl(input);
}

function isFindNextShortcut(input) {
  return isKeyDown(input, "g") && !input.shift && !input.alt && isCmdOrCtrl(input);
}

function isFindPrevShortcut(input) {
  return isKeyDown(input, "g") && input.shift === true && !input.alt && isCmdOrCtrl(input);
}

function isGlobalSearchShortcut(input) {
  return isKeyDown(input, "f") && input.shift === true && !input.alt && isCmdOrCtrl(input);
}

function isZoomInShortcut(input) {
  if (!input || input.type !== "keyDown" || input.alt) return false;
  const key = input.key || "";
  return (key === "=" || key === "+") && !input.shift && isCmdOrCtrl(input);
}

function isZoomOutShortcut(input) {
  if (!input || input.type !== "keyDown" || input.alt) return false;
  const key = input.key || "";
  return key === "-" && !input.shift && isCmdOrCtrl(input);
}

function isZoomResetShortcut(input) {
  if (!input || input.type !== "keyDown" || input.alt) return false;
  const key = input.key || "";
  return key === "0" && !input.shift && isCmdOrCtrl(input);
}

function isNewChatShortcut(input) {
  return isKeyDown(input, "n") && !input.shift && !input.alt && isCmdOrCtrl(input);
}

function isNewChatWindowShortcut(input) {
  if (!input || input.type !== "keyDown" || input.isAutoRepeat) {
    return false;
  }

  const key = (input.key || "").toLowerCase();
  if (key !== "n") {
    return false;
  }

  return input.shift === true && !input.alt && isCmdOrCtrl(input);
}

function shouldHandleNewChatShortcut(contents) {
  if (!contents || contents.isDestroyed()) {
    return false;
  }

  const type = contents.getType();
  if (type === "remote") {
    return false;
  }

  const url = contents.getURL();
  if (url && url.startsWith("devtools://")) {
    return false;
  }

  return true;
}

function getShortcutOwnerWindow() {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (!focusedWindow || focusedWindow.isDestroyed()) {
    return null;
  }

  return windows.resolveLocalFindOwnerWindow(focusedWindow);
}

function isNewTabShortcut(input) {
  if (!input || input.type !== "keyDown" || input.isAutoRepeat) return false;
  const key = (input.key || "").toLowerCase();
  return key === "t" && !input.shift && !input.alt && isCmdOrCtrl(input);
}

function isTabSwitchByIndexShortcut(input) {
  if (!input || input.type !== "keyDown") return false;
  const key = input.key || "";
  return /^[1-9]$/.test(key) && !input.shift && !input.alt && isCmdOrCtrl(input);
}

function isNextTabShortcut(input) {
  if (!input || input.type !== "keyDown") return false;
  const key = input.key || "";
  // Cmd+Option+ArrowRight (browser-standard "next tab" on macOS).
  return key === "ArrowRight" && input.alt && !input.shift && isCmdOrCtrl(input);
}

function isPrevTabShortcut(input) {
  if (!input || input.type !== "keyDown") return false;
  const key = input.key || "";
  // Cmd+Option+ArrowLeft (browser-standard "previous tab" on macOS).
  return key === "ArrowLeft" && input.alt && !input.shift && isCmdOrCtrl(input);
}

function isCloseChatWindowShortcut(input) {
  if (!input || input.type !== "keyDown" || input.isAutoRepeat) {
    return false;
  }

  const key = (input.key || "").toLowerCase();
  if (key !== "w") {
    return false;
  }

  if (input.shift || input.alt) {
    return false;
  }

  if (process.platform === "darwin") {
    return input.meta === true;
  }

  return input.control === true;
}

function canCloseFocusedChatWindow() {
  const targetWindow = getShortcutOwnerWindow();
  if (!targetWindow || targetWindow.isDestroyed()) {
    return false;
  }

  if (
    state.windows.main &&
    !state.windows.main.isDestroyed() &&
    targetWindow.id === state.windows.main.id
  ) {
    return false;
  }

  for (const info of state.conversationWindows.values()) {
    if (info?.window && !info.window.isDestroyed() && info.window.id === targetWindow.id) {
      return true;
    }
  }

  return (
    state.windows.chat &&
    !state.windows.chat.isDestroyed() &&
    targetWindow.id === state.windows.chat.id
  );
}

function closeFocusedChatWindow() {
  if (!canCloseFocusedChatWindow()) {
    return;
  }

  const targetWindow = getShortcutOwnerWindow();
  if (targetWindow && !targetWindow.isDestroyed()) {
    targetWindow.close();
  }
}

function setupNewChatShortcutHandler() {
  app.on("web-contents-created", (_event, contents) => {
    if (!shouldHandleNewChatShortcut(contents)) {
      return;
    }

    contents.on("before-input-event", (event, input) => {
      if (isFindNextShortcut(input)) {
        event.preventDefault();
        const targetWin = getShortcutOwnerWindow();
        if (targetWin && !targetWin.isDestroyed()) {
          targetWin.webContents.send("find-in-page-next");
        }
        return;
      }

      if (isFindPrevShortcut(input)) {
        event.preventDefault();
        const targetWin = getShortcutOwnerWindow();
        if (targetWin && !targetWin.isDestroyed()) {
          targetWin.webContents.send("find-in-page-prev");
        }
        return;
      }

      if (isLocalSearchShortcut(input)) {
        event.preventDefault();
        const targetWin = getShortcutOwnerWindow();
        if (targetWin && !targetWin.isDestroyed()) {
          targetWin.webContents.send("find-in-page-open");
        }
        return;
      }

      if (isGlobalSearchShortcut(input)) {
        event.preventDefault();
        const targetWin = getShortcutOwnerWindow();
        if (targetWin && !targetWin.isDestroyed()) {
          const owuiViews = require("./owui-views");
          owuiViews.sendToActiveViewForWindow(targetWin.id, "trigger-search", {});
          const activeViewKey = owuiViews.getActiveViewKeyForWindow(targetWin.id);
          if (activeViewKey) {
            void owuiViews.focusView(activeViewKey).catch(() => {});
          }
        }
        return;
      }

      if (isZoomInShortcut(input) || isZoomOutShortcut(input) || isZoomResetShortcut(input)) {
        event.preventDefault();
        const targetWin = getShortcutOwnerWindow();
        if (targetWin && !targetWin.isDestroyed()) {
          const owuiViews = require("./owui-views");
          const direction = isZoomInShortcut(input) ? "in" : isZoomOutShortcut(input) ? "out" : "reset";
          owuiViews.sendToActiveViewForWindow(targetWin.id, "ui-scale-adjust", { direction });
        }
        return;
      }

      if (isNewChatWindowShortcut(input)) {
        const now = Date.now();
        if (now - lastNewChatWindowShortcutAt < 100) {
          return;
        }
        lastNewChatWindowShortcutAt = now;
        event.preventDefault();
        openNewChatWindow();
        return;
      }

      if (isNewTabShortcut(input)) {
        const now = Date.now();
        if (now - lastNewChatShortcutAt < 100) {
          return;
        }
        lastNewChatShortcutAt = now;
        event.preventDefault();

        const { BrowserWindow } = require("electron");
        const focusedWin = BrowserWindow.getFocusedWindow();
        const mainWin = state.windows?.main;
        if (mainWin && !mainWin.isDestroyed()) {
          mainWin.webContents.send("open-new-chat-tab");
          if (focusedWin && focusedWin !== mainWin) {
            mainWin.focus();
          }
        }
        return;
      }

      if (isNewChatShortcut(input)) {
        const now = Date.now();
        if (now - lastNewChatShortcutAt < 100) {
          return;
        }
        lastNewChatShortcutAt = now;
        event.preventDefault();

        const targetWin = getShortcutOwnerWindow();
        if (targetWin && !targetWin.isDestroyed()) {
          const owuiViews = require("./owui-views");
          owuiViews.sendToActiveViewForWindow(targetWin.id, "open-new-chat", {});
        }
        return;
      }

      if (isTabSwitchByIndexShortcut(input)) {
        event.preventDefault();
        const { BrowserWindow } = require("electron");
        const mainWin = state.windows?.main;
        if (mainWin && !mainWin.isDestroyed()) {
          const index = parseInt(input.key, 10) - 1;
          mainWin.webContents.send("switch-to-tab-index", index);
        }
        return;
      }

      if (isNextTabShortcut(input)) {
        event.preventDefault();
        const { BrowserWindow } = require("electron");
        const mainWin = state.windows?.main;
        if (mainWin && !mainWin.isDestroyed()) {
          mainWin.webContents.send("switch-tab-next");
        }
        return;
      }

      if (isPrevTabShortcut(input)) {
        event.preventDefault();
        const { BrowserWindow } = require("electron");
        const mainWin = state.windows?.main;
        if (mainWin && !mainWin.isDestroyed()) {
          mainWin.webContents.send("switch-tab-prev");
        }
        return;
      }

      if (!isCloseChatWindowShortcut(input)) {
        return;
      }

      // Only intercept the native Cmd+W close action when we actually have a
      // tab-aware destination for it (main shell with chat tabs, or a
      // detachable chat window). Other windows fall through to Electron's
      // native close behavior so utility/dialog windows still close on Cmd+W.
      const { BrowserWindow } = require("electron");
      const focusedWin = BrowserWindow.getFocusedWindow();
      const mainWin = state.windows?.main;

      if (focusedWin && mainWin && focusedWin.id === mainWin.id) {
        event.preventDefault();
        mainWin.webContents.send("close-active-tab");
        return;
      }

      const shouldCloseFocusedChatWindow = canCloseFocusedChatWindow();
      if (!shouldCloseFocusedChatWindow) {
        return;
      }

      const now = Date.now();
      if (now - lastCloseWindowShortcutAt < 100) {
        return;
      }
      lastCloseWindowShortcutAt = now;

      event.preventDefault();
      closeFocusedChatWindow();
    });
  });
}

let artifactRuntimeCleanupStarted = false;

const drainPrerequisitesBeforeQuit = createPrerequisitesQuitDrain({
  cancelPrerequisites: () => prerequisitesService.cancelPrerequisites(),
  continueQuit: () => {
    tagAppQuit("prerequisites recovery drained");
    app.quit();
  },
  onDrainError: (error) => {
    console.error(
      `[Quit] Prerequisites recovery closed with an error: ${error?.message || error}`,
    );
  },
});

function stopArtifactRuntimeContainersBeforeQuit() {
  if (artifactRuntimeCleanupStarted) {
    return;
  }
  artifactRuntimeCleanupStarted = true;
  try {
    const env = createEnhancedEnv(process.env);
    const output = execFileSync(
      "docker",
      [
        "ps",
        "-a",
        "--filter",
        "name=agent-vm-artifact-",
        "--format",
        "{{.ID}}\t{{.Names}}",
      ],
      { encoding: "utf8", env, timeout: 5000 },
    );
    const containerIds = output
      .split("\n")
      .map((line) => line.trim().split(/\s+/, 2))
      .filter(([, name]) =>
        name?.replace(/^\//, "").startsWith("agent-vm-artifact-"),
      )
      .map(([containerId]) => containerId)
      .filter(Boolean);
    if (containerIds.length > 0) {
      execFileSync("docker", ["rm", "-f", ...containerIds], {
        env,
        timeout: 10000,
        stdio: "ignore",
      });
      console.log(`[Artifacts] Stopped ${containerIds.length} runtime container(s) before quit`);
    }
  } catch (error) {
    console.warn(`[Artifacts] Failed to stop runtime containers before quit: ${error.message}`);
  }
}

app.on("before-quit", (event) => {
  if (drainPrerequisitesBeforeQuit(event)) {
    return;
  }
  const quitProvenance = getQuitProvenance();
  console.log(
    `[Quit] before-quit provenance=${quitProvenance.reason} appOwned=${quitProvenance.appOwned}`,
  );
  stopArtifactRuntimeContainersBeforeQuit();
  clearMandatoryUpdateReprompt();
  updatePreparation.cancelPreparation("interrupted", {
    quitProvenance: quitProvenance.reason,
  });
  const activeMcpOperation =
    defaultMcpOperationManager.getActiveMcpOperation();
  if (activeMcpOperation) {
    defaultMcpOperationManager.cancelOperation(activeMcpOperation.operationId, {
      error: "Application exited before the operation completed",
    });
  }
  const sentinelResult = owuiDataIntegrityGuard.recordDbSentinel({
    projectRoot: bootstrap.PROJECT_ROOT,
    buildNumber: state.buildInfo?.buildNumber || null,
  });
  if (!sentinelResult.success && !sentinelResult.skipped) {
    console.warn(
      `[OWUI DB Integrity] Failed to record sentinel before quit: ${sentinelResult.error || sentinelResult.reason}`,
    );
  }
  stopHostMcpBridge?.().catch((err) =>
    console.error("Failed to stop Host MCP Bridge before quit:", err),
  );
  stopSetupAuthBroker().catch((err) =>
    console.error("Failed to stop setup auth broker before quit:", err),
  );
});

// Docker/MCP functions - imported from docker-mcp.js
const {
  // YAML/Env helpers
  parseYaml,
  parseEnvFile,
  serializeEnvFile,
  findServerYaml,
  checkServerConfigured,
  // Status monitoring
  startStatusMonitoring,
  stopStatusMonitoring,
  checkDockerStatus,
  checkServicesNeedRestart,
  // Smart startup (source file change detection)
  saveSourceFilesHash,
  // Host MCPO
  startHostMcpo,
  stopHostMcpo,
  ensureHostMcpBridgeReady,
  stopHostMcpBridge,
  isHostMcpBridgeDesiredEnabled,
  checkHostMcpServersConfigured,
  // Health checks
  runStartupCoreHealthGate,
  runHealthCheckAndBroadcast,
  startContinuousHealthChecks,
  stopContinuousHealthChecks,
  getLastHealthStatus,
  // Docker helpers
  ensureVolumeFilesExist,
  cleanupLegacyRequestPayloadsFromKnownRoots,
  cleanupLegacyRequestPayloadsFromGatewayMounts,
  cleanupLegacyRequestPayloadsFromKnownAndRememberedRoots,
  ensureDockerRunning,
  restartOrbStackAndWaitForDocker,
  probeDockerDaemon,
  executeWithStreaming,
  ORBSTACK_DOCKER_STARTUP_TIMEOUT_LABEL,
  // Config helpers
  applyPresetEnvVars,
  // MCP initialization
  runMcpInitialization,
  setResetConfigData,
} = dockerMcp;

// Status monitoring, host MCPO, Host MCP Bridge, and checkDockerStatus imported from docker-mcp.js

// Update functions - imported from updates.js
const {
  getUpdateChannel,
  isNewerVersion,
  checkForUpdates,
  findSpecificBuild,
  buildUpdateGraceKey,
  canOfferOneTimeUpdateGrace,
  consumeOneTimeUpdateGrace,
  clearUpdateGraceState,
  runUpdateWrapper,
  executeUpdate,
  restartAfterUpdate,
  showUpdateDialog,
  performMigrationIfNeeded,
} = updates;

// Migration function (performMigrationIfNeeded) is now imported from updates.js

const suppressedMandatoryPromptKeys = new Set();
const suppressedMandatoryPromptBuilds = new Set();
let activeMandatoryPromptToken = null;
let mandatoryPromptInFlight = false;
let updateExecutionInFlight = false;
let activeUpdateExecutionToken = null;
let pendingMainWindowStartUpdateToken = null;
let preparedAppInstallerToken = null;
const scheduledPreparedAppInstallerFallbacks = new Set();

function resolveUpdateKey(updateInfo) {
  if (!updateInfo || typeof updateInfo !== "object") return null;
  if (typeof updateInfo.updateKey === "string" && updateInfo.updateKey.trim()) {
    return updateInfo.updateKey.trim();
  }
  return buildUpdateGraceKey(updateInfo, getCurrentChannelInfo().packageName);
}

function resolveBuildNumber(updateInfo) {
  if (!updateInfo || typeof updateInfo.latestBuildNumber !== "string") return null;
  const buildNumber = updateInfo.latestBuildNumber.trim();
  return buildNumber || null;
}

function resolveUpdateToken(updateInfo) {
  const updateKey = resolveUpdateKey(updateInfo);
  if (updateKey) return `key:${updateKey}`;
  const buildNumber = resolveBuildNumber(updateInfo);
  if (buildNumber) return `build:${buildNumber}`;
  return null;
}

function suppressMandatoryPromptsForUpdate(updateInfo) {
  const updateKey = resolveUpdateKey(updateInfo);
  if (updateKey) {
    suppressedMandatoryPromptKeys.add(updateKey);
  }
  const buildNumber = resolveBuildNumber(updateInfo);
  if (buildNumber) {
    suppressedMandatoryPromptBuilds.add(buildNumber);
  }
}

function isMandatoryPromptSuppressed(updateInfo) {
  const updateKey = resolveUpdateKey(updateInfo);
  if (updateKey && suppressedMandatoryPromptKeys.has(updateKey)) {
    return {
      suppressed: true,
      reason: "key",
      updateKey,
      buildNumber: resolveBuildNumber(updateInfo),
    };
  }

  const buildNumber = resolveBuildNumber(updateInfo);
  if (buildNumber && suppressedMandatoryPromptBuilds.has(buildNumber)) {
    return {
      suppressed: true,
      reason: "build",
      updateKey,
      buildNumber,
    };
  }

  return {
    suppressed: false,
    reason: null,
    updateKey,
    buildNumber,
  };
}

function tryDispatchMainWindowStartUpdate(updateInfo, source = "unknown") {
  const updateToken = resolveUpdateToken(updateInfo) || "unknown-update";
  if (pendingMainWindowStartUpdateToken === updateToken) {
    console.log(
      `[Update] Duplicate start-update dispatch ignored (${source}) token=${updateToken}`,
    );
    return { started: false, deduped: true, token: updateToken };
  }
  if (updateExecutionInFlight && activeUpdateExecutionToken === updateToken) {
    console.log(
      `[Update] start-update dispatch ignored (${source}); install already running token=${updateToken}`,
    );
    return {
      started: false,
      deduped: true,
      inProgress: true,
      token: updateToken,
    };
  }

  pendingMainWindowStartUpdateToken = updateToken;
  sendToMainWindow("start-update", updateInfo);
  setTimeout(() => {
    if (
      pendingMainWindowStartUpdateToken === updateToken &&
      activeUpdateExecutionToken !== updateToken
    ) {
      pendingMainWindowStartUpdateToken = null;
    }
  }, 15000);

  return { started: true, deduped: false, token: updateToken };
}

async function beginMenuUpdateWorkflow(updateInfo, options = {}) {
  if (!updateInfo || !updateInfo.latestBuildNumber) {
    return {
      success: false,
      error: "Missing update metadata for menu workflow",
    };
  }

  const trigger = options.trigger || "menu";
  const postPreparationAction = options.postPreparationAction || "prompt";
  const forcePreparation = options.forcePreparation === true;
  const canUseLoadingWindow = postPreparationAction === "auto-install";
  const targetWindow =
    state.windows.main && !state.windows.main.isDestroyed()
      ? { kind: "main", ref: state.windows.main }
      : canUseLoadingWindow &&
          state.windows.loading &&
          !state.windows.loading.isDestroyed()
        ? { kind: "loading", ref: state.windows.loading }
        : null;

  if (!targetWindow) {
    return {
      success: false,
      error: "Main window is not available",
    };
  }

  if (postPreparationAction === "auto-install") {
    suppressMandatoryPromptsForUpdate(updateInfo);
  }
  const payload = {
    trigger,
    postPreparationAction,
    forcePreparation,
    requestedAt: new Date().toISOString(),
    updateInfo: {
      ...updateInfo,
      updateAvailable: true,
    },
  };

  if (targetWindow.ref.isMinimized()) {
    targetWindow.ref.restore();
  }
  targetWindow.ref.show();
  targetWindow.ref.focus();

  if (targetWindow.kind === "loading") {
    sendToLoadingWindow("menu-update-requested", payload);
  } else {
    sendToMainWindow("menu-update-requested", payload);
  }
  return { success: true };
}

// Dev-only: expose a LOOPBACK CDP endpoint so verification tooling can
// ATTACH to the user's running instance (Playwright connectOverCDP on
// http://127.0.0.1:9223) for screenshots/driving. Spawning a second app
// instance for e2e is forbidden — fresh instances refresh-rotate stored
// OAuth tokens and abrupt closes orphan them, forcing the user to re-auth
// every integration. Opt out with portico_DEV_CDP=0. Must run before ready.
if (!app.isPackaged && process.env.portico_DEV_CDP !== "0") {
  app.commandLine.appendSwitch("remote-debugging-port", "9223");
}

app
  .whenReady()
  .then(async () => {
    try {
      await cleanupLegacyRequestPayloadsFromKnownRoots();
    } catch {
      console.warn(
        "[CostReporting] Early legacy request payload cleanup could not complete",
      );
    }

    // Dev launches (electron . / npm start) serve renderer/dist bundles that
    // esbuild produces from ESM sources (agent-skills etc.). Rebuild them
    // here — one-shot, dev-only, ~tens of ms — so a stale bundle can never
    // ship a dev session's edits sideways. Packaged builds bundle during
    // prepare:packaged-build; esbuild is a devDependency, hence the guard.
    if (!app.isPackaged) {
      try {
        await require("../../scripts/bundle-renderer").bundleRendererScripts();
        console.log("[Bundles] Renderer bundles rebuilt for dev launch");
      } catch (error) {
        console.warn(
          "[Bundles] Dev renderer bundle rebuild failed; serving existing dist:",
          error?.message || error,
        );
      }
    }

    installAppProtocol({
      protocol,
      net,
      appRoot: APP_ROOT,
    });
    console.log("[AppProtocol] Registered app://bundle renderer resources");

    if (
      enforcePackagedMacArchitectureMatch({
        appRef: app,
        dialogRef: dialog,
      }).blocked
    ) {
      return;
    }

    if (
      enforceNotStaleGuidedSetupAppLaunch({
        appRef: app,
        dialogRef: dialog,
      }).blocked
    ) {
      return;
    }

    // PORTICO-105/PORTICO-399: relocate into a blessed Applications folder BEFORE any
    // heavy startup (Docker / prerequisites), so we never boot the stack from a
    // read-only/translocated/DMG location that can't self-update. PORTICO-399 made
    // this terminal: a non-blessed launch either relocates + relaunches or the
    // guard exits the process. It never continues into startup from there.
    let appLocationGuardResult;
    try {
      appLocationGuardResult = await appLocationGuard.runAppLocationGuard({
        app,
        dialog,
      });
    } catch (error) {
      // The guard itself failing is not evidence of a bad location, and hard
      // exiting on an internal bug would brick every launch. Continue.
      console.warn(
        "[LocationGuard] guard threw; continuing startup:",
        error.message,
      );
      appLocationGuardResult = { skipped: "error" };
    }
    if (appLocationGuardResult.relaunching || appLocationGuardResult.blocked) {
      // Either moving into Applications and relaunching from there, or blocked
      // and already exiting -- stop before any heavy startup work either way.
      return;
    }

    void emitAppLaunched({
      appRef: app,
      readPreferences: dockerMcp.readHostMcpBridgePreferences,
    });

    // PORTICO-443: start before the heavy startup work so the first region reading is
    // a genuine baseline rather than a post-warmup number.
    try {
      addressSpaceMonitor = createAddressSpaceMonitor({
        readRegionSummary: createVmmapRegionReader({
          runProcess: runManagedProcessForTelemetry,
        }),
        onError: (error) => {
          console.warn("[AddressSpace] sample failed:", error?.message || error);
        },
      });
      addressSpaceMonitor.start();
      state.addressSpaceMonitor = addressSpaceMonitor;
    } catch (error) {
      // Telemetry must never be able to stop the app from starting.
      console.warn("[AddressSpace] telemetry unavailable:", error?.message || error);
    }

    updatePreparation.initialize();

    // Perform migration normalization if needed (guided-setup -> electron-app)
    await performMigrationIfNeeded();

    bootstrap.ensureUpdateChannelSeededFromBuildInfo();
    createMenu();
    setupNewChatShortcutHandler();

    // Start initialization logging FIRST so all logs get captured
    startInitLogging();

    ensureBundledMarketplaceDefaultsAtStartup().catch((error) => {
      console.warn(
        "[Marketplace] Failed to reconcile bundled marketplace defaults on startup:",
        error.message,
      );
    });

    // Initialize OAuth logger for unified OAuth logging across all layers
    try {
      const { initOAuthLogger } = require("./oauth-logger");
      initOAuthLogger();
      console.log("[OAuth] OAuth logger initialized");
    } catch (error) {
      console.warn("[OAuth] Failed to initialize OAuth logger:", error.message);
    }

    try {
      initKonamiLogger();
      console.log("[Konami] Konami logger initialized");
    } catch (error) {
      console.warn("[Konami] Failed to initialize Konami logger:", error.message);
    }

    // Initialize prerequisites logger for guided setup flow logging
    try {
      const { initPrereqLogger } = require("./prereq-logger");
      initPrereqLogger();
      console.log("[Prereq] Prerequisites logger initialized");
    } catch (error) {
      console.warn("[Prereq] Failed to initialize prerequisites logger:", error.message);
    }

    // Clear webview cache to prevent using stale Open WebUI artifacts
    await clearWebviewCache();

    // Listen for theme changes and update window icons (from windows.js)
    setupThemeListener();

    // Handle sleep/wake transitions by clearing stale resolver state across
    // every Electron session. The renderer probes later and reloads in place
    // only when the visible chat is actually unhealthy.
    powerMonitor.on("resume", () => {
      console.log("[Power] System resumed from sleep; recovering app network and chat state");
      const browserWindows = BrowserWindow.getAllWindows();
      const webContentsEntries = webContents.getAllWebContents();
      const resumeRecovery = handleSystemResume({
        defaultSession: session.defaultSession,
        browserWindows,
        webContentsEntries,
        resumePrerequisites: () => {
          if (typeof prerequisitesService.handleSystemResume === "function") {
            prerequisitesService.handleSystemResume();
          }
        },
        notifyRenderers: (payload) => {
          sendToAllWindows("system-resumed", payload);
        },
        refreshHealth: () =>
          runHealthCheckAndBroadcast({
            mode: "light",
            reason: "system-resume",
            waitForLock: false,
          }),
        logger: console,
      });
      void resumeRecovery.catch((error) => {
        console.error("[Power] System resume recovery failed:", error);
      });
    });

    // Wire up windows.js dependencies (functions defined later in this file)
    windows.setDependencies({
      checkForUpdates,
      findSpecificBuild,
      beginMenuUpdateWorkflow,
      startStatusMonitoring,
      stopStatusMonitoring,
      startContinuousHealthChecks,
      stopContinuousHealthChecks,
      stopHostMcpo,
      stopHostMcpBridge,
    });

    // Start Express REST API server for MCP infrastructure management
    // API setup and routes are defined in api.js
    let apiServerStarted = false;
    try {
      const apiApp = createApiServer();
      await startApiServer(apiApp);
      apiServerStarted = true;
      console.log("[API] Server confirmed ready, proceeding to create windows");
    } catch (apiError) {
      console.error(
        "[API] ❌ CRITICAL: API server failed to start:",
        apiError.message,
      );
      console.error("[API] Stack:", apiError.stack);
      // Log to init file so we can see the error later
      sendInitLog(
        `[API] ❌ CRITICAL: API server failed to start: ${apiError.message}\n`,
        "error",
      );
      // Continue with app startup - windows can still work, API calls will fail gracefully
    }

    // Always show loading screen on startup for manager mode
    if (isManagerMode) {
      createLoadingWindow();
      // Now send the success/failure log to BOTH the loading window AND init log file
      setTimeout(() => {
        if (apiServerStarted) {
          sendInitLog(
            `[API] ✅ REST API server READY on http://127.0.0.1:${API_PORT}\n`,
            "success",
          );
        } else {
          sendInitLog(
            `[API] ⚠️ REST API server NOT RUNNING - some features may not work\n`,
            "warning",
          );
        }
      }, 100);
    } else {
      // Config wizard mode
      createMainWindow();
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        if (isManagerMode) {
          if (hasShownManagerMainWindow && !isInitializing) {
            createMainWindow();
          } else {
            createLoadingWindow();
          }
        } else {
          createMainWindow();
        }
      }
    });
  })
  .catch((err) => {
    console.error("[MAIN] Critical startup error:", err);
    // Try to log to file if sendInitLog is available
    try {
      sendInitLog(
        `[MAIN] ❌ Critical startup error: ${err.message}\n`,
        "error",
      );
    } catch (logErr) {
      // sendInitLog may not be available yet
      console.error("[MAIN] Could not log to init file:", logErr);
    }
  });

app.on("window-all-closed", () => {
  stopStatusMonitoring();
  stopHostMcpo().catch((err) =>
    console.error("Failed to stop host MCPO:", err),
  ); // Async cleanup
  if (process.platform !== "darwin") {
    tagAppQuit("all-windows-closed");
    app.quit();
  }
  // For config wizard mode, exit with appropriate code
  if (!isManagerMode) {
    if (configurationSaved) {
      console.log("Configuration was saved successfully");
      process.exit(0);
    } else {
      console.log("Configuration was not saved");
      process.exit(1);
    }
  }
});

// IPC Handlers

// Initialize PROJECT_ROOT using bootstrap module
bootstrap.initializeProjectRoot();
const PROJECT_ROOT = bootstrap.PROJECT_ROOT;
const SCRIPTS_DIR = bootstrap.SCRIPTS_DIR;
ensureMcpCreateDirs(PROJECT_ROOT, { logger: console });
const DOCKER_DEV_MODE_MARKER = path.join(PROJECT_ROOT, ".dev-mode");

function createMcpRuntimeEnv(overrides = {}) {
  return createRuntimeShellEnv({
    baseEnv: process.env,
    overrides: {
      PROJECT_ROOT,
      ...overrides,
    },
    isPackagedApp: app.isPackaged === true,
    resourcesPath: process.resourcesPath,
  });
}

function startPreparedAppInstaller({ source = "unknown" } = {}) {
  const prepStatus = updatePreparation.getPreparationStatus();
  const prepared = prepStatus?.prepared || null;
  // PORTICO-318: this runs at the restart handoff, AFTER the managed-runtime apply
  // has already succeeded. Do not re-require the pre-apply backup archive -- it
  // is a rollback safety net that is irrelevant to (and may have been consumed
  // before) the app-bundle swap. Requiring it here is what stranded users on a
  // silent "Restarting application..." spinner when the archive was gone.
  const preparedValidation = updatePreparation.validatePreparedArtifactsForInstall(
    prepared,
    { requireBackupArtifact: false },
  );
  if (!preparedValidation?.success) {
    return {
      success: false,
      error:
        preparedValidation?.error ||
        "Prepared app bundle is missing. Re-run update preparation.",
    };
  }

  const validatedPrepared = preparedValidation.prepared;
  const stagedAppBundle = validatedPrepared.selectedAppBundle;
  const installedBuildNumber = validatedPrepared.releaseBuildNumber;
  const installedTimestamp = validatedPrepared.lastModified;
  const updateToken = validatedPrepared.updateKey || "unknown-prepared-update";
  const helperScript = path.join(
    PROJECT_ROOT,
    "electron-app",
    "src",
    "scripts",
    "install-staged-app.sh",
  );

  if (preparedAppInstallerToken === updateToken) {
    console.log(
      `[Update] Prepared app installer already started (${source}) token=${updateToken}`,
    );
    return {
      success: true,
      duplicate: true,
      stagedAppBundle,
    };
  }

  if (!stagedAppBundle || !fs.existsSync(stagedAppBundle)) {
    return {
      success: false,
      error: "Prepared app bundle is missing. Re-run update preparation.",
    };
  }

  if (!fs.existsSync(helperScript)) {
    return {
      success: false,
      error: `App installer helper not found: ${helperScript}`,
    };
  }

  // PORTICO-105: install the new bundle in place at the current blessed location
  // (/Applications or ~/Applications), not a hardcoded /Applications. If we're
  // somehow not blessed here, DON'T guess a target (that could create a second,
  // divergent /Applications copy). PORTICO-399 makes this unreachable for packaged
  // macOS builds -- the launch guard exits rather than run from a non-blessed
  // location -- so it survives purely as a never-install-over-a-guess net.
  const currentLocation = appLocationGuard.classifyAppLocation({ app });
  if (!currentLocation.blessed || !currentLocation.bundlePath) {
    return {
      success: false,
      needsRelocate: true,
      error:
        "Portico must be in your Applications folder to finish updating. " +
        "Quit the app, move it into Applications, then reopen it and re-run the update.",
    };
  }
  const installTargetBundle = currentLocation.bundlePath;

  console.log(`[Update] Starting prepared app installer (${source})`);
  console.log("Current app bundle:", currentLocation.bundlePath);
  console.log("Staged app bundle:", stagedAppBundle);
  console.log("Target app bundle:", installTargetBundle);

  const helper = spawn(
    "bash",
    [
      helperScript,
      String(process.pid),
      stagedAppBundle,
      installTargetBundle,
      installedBuildNumber || "",
      installedTimestamp || "",
    ],
    {
      detached: true,
      stdio: "ignore",
      env: createEnhancedEnv(),
    },
  );
  helper.unref();
  preparedAppInstallerToken = updateToken;

  setTimeout(() => {
    tagAppQuit("prepared-update-restart");
    app.quit();
  }, 250);

  return {
    success: true,
    stagedAppBundle,
    targetAppBundle: installTargetBundle,
  };
}

function schedulePreparedAppInstallerFallback(updateInfo, readyForRestart, code) {
  if (code !== 0 || readyForRestart !== true || updateInfo?.prepared?.ready !== true) {
    return;
  }

  const fallbackToken =
    updateInfo.prepared.updateKey ||
    resolveUpdateToken(updateInfo) ||
    "unknown-prepared-update";
  if (scheduledPreparedAppInstallerFallbacks.has(fallbackToken)) {
    return;
  }
  scheduledPreparedAppInstallerFallbacks.add(fallbackToken);

  setTimeout(() => {
    if (preparedAppInstallerToken === fallbackToken) {
      return;
    }

    const currentBuildNumber = state.buildInfo?.buildNumber || null;
    const targetBuildNumber =
      updateInfo.prepared.releaseBuildNumber ||
      updateInfo.latestBuildNumber ||
      null;
    if (targetBuildNumber && currentBuildNumber === targetBuildNumber) {
      return;
    }

    console.warn(
      `[Update] Renderer did not request prepared app restart; starting fallback installer token=${fallbackToken}`,
    );
    const result = startPreparedAppInstaller({
      source: "main-process-fallback",
    });
    if (!result?.success) {
      console.error(
        "[Update] Prepared app installer fallback failed:",
        result?.error || "unknown error",
      );
      // PORTICO-318: never leave the user on a silent "Restarting application..."
      // spinner. The update already applied to the managed runtime; only the
      // app-bundle swap could not be completed automatically. Surface an
      // actionable message over the existing update-complete channel (one-shot,
      // no new timers) so the renderer can replace the spinner with guidance.
      const restartFailureMessage =
        "The update installed but the app could not restart automatically. " +
        "Please quit Portico and reopen it to finish updating.";
      for (const win of [state.windows.loading, state.windows.main]) {
        if (win && !win.isDestroyed()) {
          win.webContents.send("update-complete", {
            success: false,
            readyForRestart: true,
            restartFailed: true,
            error: restartFailureMessage,
          });
        }
      }
    }
  }, 5000);
}

function isDockerDevModeEnabled() {
  return fs.existsSync(DOCKER_DEV_MODE_MARKER);
}

function resolveLlmGatewayMode() {
  return "bifrost";
}

function getLlmGatewayContainerName() {
  return "llm-gateway";
}

// Get config path functions from bootstrap
const { getConfigPath, saveProjectRoot, loadSavedProjectRoot } = bootstrap;
const WEBUI_URL = "http://localhost:3789";

// Track if configuration was saved
let configurationSaved = false;

// Set dependencies for IPC handlers that need window creation functions
setHandlerDependencies({
  createMainWindow,
  createChatWindow,
  createLoadingWindow,
  createGuidedSetupWindow,
  stopStatusMonitoring,
  isFirstRun,
});

// Register common IPC handlers from ipc.js
// (config, utility, OAuth, health, update check, MCP server, Docker, Host MCPO, Window, Process, Debug handlers)
registerAllIpcHandlers();

// The following handlers are now registered via ipc.js:
// - Config handlers: get-project-root, reset-project-root, load-env, check-host-mode, update-env-var, save-config
// - Toggle handlers: load-mcp-toggles, save-mcp-toggles
// - Utility handlers: open-url, open-external, get-username, get-build-info, get-log-paths, copy-to-clipboard, clear-webview-cache
// - OAuth handlers: get-oauth-status, get-oauth-current, get-oauth-pending, get-server-metadata, poll-oauth-completion
// - Health handlers: rerun-health-check, get-health-status, start-health-monitoring, stop-health-monitoring, get-last-health-status
// - Update handlers: check-for-updates
// - MCP server handlers: load-mcp-servers, add-mcp-server, remove-mcp-server

// Health check handlers, update check handler now registered via ipc.js
// (rerun-health-check, get-health-status, start-health-monitoring, stop-health-monitoring, get-last-health-status, check-for-updates)

ipcMain.handle("start-update-preparation", async (event, updateInfo, options = {}) => {
  try {
    const result = await updatePreparation.startPreparation(updateInfo, options);
    if (result?.success === false) {
      console.warn(
        "[Update Prep] Start request rejected:",
        result.error || "Unknown error",
        `(build=${updateInfo?.latestBuildNumber || "unknown"})`,
      );
    }
    return result;
  } catch (error) {
    console.error("[Update Prep] Failed to start:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("get-update-preparation-status", async () => {
  try {
    return {
      success: true,
      status: updatePreparation.getPreparationStatus(),
    };
  } catch (error) {
    console.error("[Update Prep] Failed to get status:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("cancel-update-preparation", async () => {
  try {
    return updatePreparation.cancelPreparation("cancelled");
  } catch (error) {
    console.error("[Update Prep] Failed to cancel:", error);
    return { success: false, error: error.message };
  }
});

// Run update process
ipcMain.handle("run-update", async (event, updateInfo = null) => {
  try {
    console.log("Update requested, starting update process...");

    let wrapperScript;
    let scriptArgs = [PROJECT_ROOT];

    // We need the update info from the check
    if (!updateInfo || !updateInfo.downloadUrl || !updateInfo.filename) {
      // If we don't have update info, get it now
      console.log("Update info not provided, checking for updates...");
      const latestUpdateInfo = await checkForUpdates();
      if (!latestUpdateInfo.updateAvailable) {
        return { success: false, error: "No update available" };
      }
      updateInfo = latestUpdateInfo;
    }

    // Use update wrapper script
    const scriptsDir = path.join(
      PROJECT_ROOT,
      "electron-app",
      "src",
      "scripts",
    );
    wrapperScript = path.join(scriptsDir, "update-wrapper-cloudsmith.sh");

    // Add download-specific arguments
    const resolvedFullSha =
      updateInfo.latestFullSha ||
      updateInfo.fullSha ||
      updateInfo.latestBuildNumber;
    scriptArgs.push(
      updateInfo.downloadUrl,
      updateInfo.filename,
      resolvedFullSha,
    );

    // Ensure the script exists
    if (!fs.existsSync(wrapperScript)) {
      console.error("Update wrapper script not found at:", wrapperScript);
      return {
        success: false,
        error: `Update wrapper script not found: ${wrapperScript}`,
      };
    }

    // Clear any existing update log
    const logFile = path.join(PROJECT_ROOT, "electron-app", "update.log");
    if (fs.existsSync(logFile)) {
      fs.unlinkSync(logFile);
    }

    // Get the loading window to show initial message
    if (state.windows.loading && !state.windows.loading.isDestroyed()) {
      const updateSource = "Cloudsmith repository";
      state.windows.loading.webContents.send("loading-log-append", {
        text: `✅ Update process started (${updateSource}). The application will restart automatically.\n`,
        type: "success",
      });
      state.windows.loading.webContents.send("loading-log-append", {
        text: "📋 Update logs will appear below:\n",
        type: "info",
      });
      state.windows.loading.webContents.send("loading-log-append", {
        text: "________________________________\n\n",
        type: "info",
      });

      // Start monitoring the log file
      let lastSize = 0;
      const logMonitor = setInterval(() => {
        if (fs.existsSync(logFile)) {
          const stats = fs.statSync(logFile);
          if (stats.size > lastSize) {
            const stream = fs.createReadStream(logFile, {
              start: lastSize,
              end: stats.size,
            });
            stream.on("data", (chunk) => {
              const text = chunk.toString();
              const cleanText = text.replace(/\x1b\[[0-9;]*m/g, "");
              if (
                state.windows.loading &&
                !state.windows.loading.isDestroyed()
              ) {
                state.windows.loading.webContents.send("loading-log-append", {
                  text: cleanText,
                  type: "info",
                });
              }
            });
            lastSize = stats.size;
          }
        }
      }, 500); // Check every 500ms

      // Stop monitoring after 30 seconds (should be enough time)
      setTimeout(() => {
        clearInterval(logMonitor);
      }, 30000);
    }

    // Run the wrapper script which will properly detach the update
    console.log(
      "Running update script:",
      wrapperScript,
      "with args:",
      scriptArgs,
    );
    const child = spawn("bash", [wrapperScript, ...scriptArgs], {
      detached: true,
      stdio: "ignore",
    });

    child.unref();
    console.log("Update wrapper started with PID:", child.pid);

    // Give the wrapper a moment to start
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Return success first
    const result = {
      success: true,
      message: "Update process started using cloudsmith method",
      updateSource: "cloudsmith",
    };

    // Schedule a graceful exit after 2 seconds (give wrapper time to fork)
    setTimeout(() => {
      console.log("Gracefully exiting for update...");
      tagAppQuit("legacy-cloudsmith-update");
      app.quit();
    }, 2000);

    return result;
  } catch (error) {
    console.error("Failed to start update process:", error);
    return { success: false, error: error.message };
  }
});

// Handlers moved to ipc.js:
// - add-mcp-server, remove-mcp-server
// - toggle-maximize, is-first-run
// - docker-start, docker-stop, docker-restart, docker-status, docker-logs
// - host-mcpo-status, host-mcpo-restart, host-mcpo-logs, stop-host-mcpo
// - open-chat, launch-electron-app, launch-electron-app-from-init
// - docker-stop-with-logs

// Execute update script with streaming output
ipcMain.handle("execute-update", async (event, updateInfo) => {
  console.log("=== EXECUTE UPDATE START ===");
  console.log("Executing update with info:", updateInfo);
  console.log("Current working directory:", process.cwd());
  console.log("PROJECT_ROOT:", PROJECT_ROOT);

  // Use the managed directory for scripts
  const managedDir = path.join(os.homedir(), "portico", "portico-managed");
  console.log("Managed directory:", managedDir);
  console.log("Managed directory exists:", fs.existsSync(managedDir));

  const forceLegacyUpdate = updateInfo?.skipPreparedUpdate === true;
  let preparedInfo = updateInfo?.prepared;
  let updateScript;
  let scriptArgs;

  if (!forceLegacyUpdate) {
    if (!preparedInfo || preparedInfo.ready !== true) {
      const message =
        "Update is not ready to apply yet. Wait for preparation to complete.";
      console.error("[Update] Refusing non-prepared update execution:", updateInfo);
      return { success: false, error: message };
    }

    let preparedSourceDir = preparedInfo.sourceDir ||
      (preparedInfo.stageDir ? path.join(preparedInfo.stageDir, "payload") : null);
    let preparedManagedRootDir = preparedInfo.managedRootDir ||
      (preparedSourceDir ? path.join(preparedSourceDir, "managed-root") : null);
    let preparedFullBackupPath =
      typeof preparedInfo.fullBackupPath === "string" &&
      preparedInfo.fullBackupPath.trim()
        ? preparedInfo.fullBackupPath.trim()
        : null;
    let backupRequired = preparedInfo.backupRequired === true;
    if (
      !preparedSourceDir ||
      !preparedManagedRootDir ||
      !preparedInfo.selectedAppBundle ||
      !preparedInfo.selectedDmg ||
      !preparedInfo.buildInfoPath ||
      !preparedInfo.updateKey ||
      (backupRequired && !preparedFullBackupPath)
    ) {
      const message = "Prepared update metadata is incomplete.";
      console.error("[Update] Missing prepared metadata:", preparedInfo);
      return { success: false, error: message };
    }

    const preparedValidation = updatePreparation.validatePreparedArtifactsForInstall(
      preparedInfo,
    );
    if (!preparedValidation?.success) {
      console.error("[Update] Prepared artifact validation failed:", preparedValidation?.error);
      return {
        success: false,
        error:
          preparedValidation?.error || "Prepared update metadata is incomplete.",
      };
    }

    preparedInfo = preparedValidation.prepared;
    preparedSourceDir = preparedInfo.sourceDir;
    preparedManagedRootDir = preparedInfo.managedRootDir;
    preparedFullBackupPath = preparedInfo.fullBackupPath || preparedFullBackupPath;
    backupRequired = preparedInfo.backupRequired === true;

    const expectedCurrentKey = buildUpdateGraceKey(
      updateInfo,
      updateInfo?.updateChannel || getUpdateChannel(),
    );
    if (expectedCurrentKey && preparedInfo.updateKey !== expectedCurrentKey) {
      console.warn(
        `[Update] Prepared update key mismatch before apply (prepared=${preparedInfo.updateKey}, expected=${expectedCurrentKey})`,
      );
      updatePreparation.startPreparation(updateInfo).catch((error) => {
        console.error("[Update] Failed to refresh preparation for requested update:", error.message);
      });
      return {
        success: false,
        stalePrepared: true,
        nextUpdateInfo: updateInfo,
        error: "Prepared update is stale. Refreshing preparation now; wait for it to complete.",
      };
    }

    let latestUpdateInfo = null;
    try {
      latestUpdateInfo = await checkForUpdates();
    } catch (error) {
      console.error("[Update] Revalidation update check failed:", error.message);
      return {
        success: false,
        error: `Unable to revalidate latest update before install: ${error.message}`,
      };
    }

    if (latestUpdateInfo?.error && latestUpdateInfo.updateAvailable !== true) {
      console.error(
        "[Update] Revalidation check returned error:",
        latestUpdateInfo.error,
      );
      return {
        success: false,
        error: `Unable to revalidate latest update before install: ${latestUpdateInfo.error}`,
      };
    }

    if (latestUpdateInfo?.updateAvailable) {
      const latestKey = buildUpdateGraceKey(
        latestUpdateInfo,
        latestUpdateInfo?.updateChannel || getUpdateChannel(),
      );
      if (latestKey && preparedInfo.updateKey !== latestKey) {
        console.warn(
          `[Update] Rejecting stale prepared update (prepared=${preparedInfo.updateKey}, latest=${latestKey})`,
        );
        updatePreparation.startPreparation(latestUpdateInfo).catch((error) => {
          console.error("[Update] Failed to start preparation for newer payload:", error.message);
        });
        return {
          success: false,
          stalePrepared: true,
          nextUpdateInfo: latestUpdateInfo,
          error:
            "A newer update payload is available. Preparing the latest snapshot now; install will be enabled when ready.",
        };
      }
    }

    // PORTICO-105: only install in place from a blessed location (/Applications or
    // ~/Applications). PORTICO-399: unreachable for packaged macOS builds (the
    // launch guard exits rather than run from a non-blessed location), kept as a
    // safety net so we never install over an unexpected target.
    const applyLocation = appLocationGuard.classifyAppLocation({ app });
    if (!applyLocation.blessed) {
      console.warn("[Update] Non-blessed location at apply time; refusing in-place install:", {
        currentBundle: applyLocation.bundlePath,
        stagedDmg: preparedInfo.selectedDmg,
      });
      return {
        success: false,
        manualInstallRequired: true,
        needsRelocate: true,
        dmgPath: preparedInfo.selectedDmg,
        error:
          "Portico needs to be in your Applications folder to update. " +
          "Quit the app, move it into Applications, then reopen it and re-run " +
          "the update.",
      };
    }

    const stagedApplyScript = path.join(
      preparedManagedRootDir,
      "electron-app",
      "src",
      "scripts",
      "apply-prepared-update.sh",
    );
    const projectApplyScript = path.join(
      PROJECT_ROOT,
      "electron-app",
      "src",
      "scripts",
      "apply-prepared-update.sh",
    );
    updateScript = fs.existsSync(stagedApplyScript)
      ? stagedApplyScript
      : projectApplyScript;
    scriptArgs = [
      managedDir,
      preparedManagedRootDir,
      preparedInfo.selectedAppBundle,
      preparedInfo.selectedDmg,
      preparedInfo.buildInfoPath,
      preparedFullBackupPath || "none",
      preparedInfo.updateKey || "unknown",
    ];
    console.log("[Update] Using prepared update apply script:", updateScript);
  } else {
    updateScript = path.join(
      PROJECT_ROOT,
      "electron-app",
      "src",
      "scripts",
      "update-in-app-cloudsmith.sh",
    );
    const resolvedFullSha =
      updateInfo.fullSha ||
      updateInfo.latestFullSha ||
      updateInfo.latestBuildNumber;
    if (
      !updateInfo ||
      !updateInfo.downloadUrl ||
      !updateInfo.filename ||
      !resolvedFullSha
    ) {
      console.error("Missing required update info:", updateInfo);
      return { success: false, error: "Missing required update info" };
    }

    scriptArgs = [
      managedDir,
      updateInfo.downloadUrl,
      updateInfo.filename,
      resolvedFullSha,
    ];
    console.log("[Update] Using Cloudsmith in-app update script");
  }

  const updateExecutionToken = resolveUpdateToken(updateInfo) || "unknown-update";
  if (updateExecutionInFlight) {
    if (activeUpdateExecutionToken === updateExecutionToken) {
      if (pendingMainWindowStartUpdateToken === updateExecutionToken) {
        pendingMainWindowStartUpdateToken = null;
      }
      console.log(
        `[Update] Duplicate execute-update request ignored for token=${updateExecutionToken}`,
      );
      return {
        success: true,
        duplicate: true,
        inProgress: true,
        message: "Update installation is already in progress.",
      };
    }
    return {
      success: false,
      inProgress: true,
      error: "Another update installation is already in progress.",
    };
  }
  updateExecutionInFlight = true;
  activeUpdateExecutionToken = updateExecutionToken;
  if (pendingMainWindowStartUpdateToken === updateExecutionToken) {
    pendingMainWindowStartUpdateToken = null;
  }

  if (!fs.existsSync(updateScript)) {
    updateExecutionInFlight = false;
    activeUpdateExecutionToken = null;
    return {
      success: false,
      error: `Update script not found: ${updateScript}`,
    };
  }

  console.log(
    "[Update] Stopping the managed runtime before update reconciliation...",
  );
  const stopScriptPath = path.join(SCRIPTS_DIR, "docker-compose.sh");
  const stopScriptExists = fs.existsSync(stopScriptPath);
  const stopManagedRuntime = () =>
    stopGuard.stopManagedRuntimeForUpdate({
      stopScriptPath,
      scriptExists: stopScriptExists,
      executeWithStreaming,
      timeoutMs: STOP_PHASE_TIMEOUT_MS,
    });

  let runtimeStopResult = await stopManagedRuntime();

  // PORTICO-373: this guard is why an engine wedge dead-ended updates rather than
  // corrupting them — refusing to apply was right. What was missing is that the
  // wedge is repairable: update-preparation.js already restarts the engine when a
  // pull stalls, but a stall at THIS stop had no recovery, so users who got past
  // the image pull were told the update failed and left to find Terminal.
  if (!runtimeStopResult.success) {
    const engineRecovery = await recoverWedgedEngineAfterFailedStop({
      stopResult: runtimeStopResult,
      probeDockerDaemon,
      restartEngine: restartOrbStackAndWaitForDocker,
      projectRoot: PROJECT_ROOT,
      onLog: (message, type = "info") =>
        console.log(`[Update] ${type === "warning" ? "⚠️  " : ""}${message}`),
    });

    if (engineRecovery.recovered) {
      console.log(
        "[Update] Container engine restarted; retrying the managed runtime stop...",
      );
      runtimeStopResult = await stopManagedRuntime();
    }

    if (!runtimeStopResult.success) {
      updateExecutionInFlight = false;
      activeUpdateExecutionToken = null;
      const stopError =
        runtimeStopResult?.error || "docker-compose stop exited unsuccessfully";
      console.error(
        "[Update] Refusing to apply while the managed runtime may still be live:",
        stopError,
      );
      return {
        success: false,
        error: engineRecovery.wedged && !engineRecovery.recovered
          ? "The update was cancelled because the container engine stopped responding and could not be restarted automatically. Quit Portico, run `orbctl restart -a` in Terminal, then reopen and retry the update."
          : `The update was cancelled because Portico services could not be stopped safely: ${stopError}`,
      };
    }
  }
  console.log(
    `[Update] Managed runtime stop resolved (${runtimeStopResult.reason || "stopped"}); update reconciliation has exclusive access.`,
  );

  return new Promise((resolve) => {
    const finishExecution = (result) => {
      if (activeUpdateExecutionToken === updateExecutionToken) {
        updateExecutionInFlight = false;
        activeUpdateExecutionToken = null;
      }
      resolve(result);
    };

    const updateSource = updateInfo.updateSource || "cloudsmith";

    console.log("Update script path:", updateScript);
    console.log("Update script exists:", fs.existsSync(updateScript));
    console.log("Script arguments:", scriptArgs);
    console.log("Executing from directory:", PROJECT_ROOT);
    // Setup comprehensive logging for the entire update process
    const logDir = path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "portico",
      "logs",
    );
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const dateStr = new Date().toISOString().split("T")[0];
    const updateLogFile = path.join(logDir, `update-${dateStr}.log`);

    // Create write stream for logging
    const logStream = fs.createWriteStream(updateLogFile, { flags: "a" });
    // PORTICO-215: without an 'error' listener, an async ENOSPC write failure on
    // this stream becomes an uncaughtException and a generic error dialog.
    // The update failure UX (deriveUpdateFailureMessage) owns user messaging;
    // here we only keep the process healthy.
    logStream.on("error", (error) => {
      console.error("[Update] update log stream error:", error?.message);
    });

    // Log header
    const logHeader = [
      "========================================",
      "Portico Update Process",
      `Started: ${new Date().toISOString()}`,
      `Update Source: ${updateSource}`,
      `Script: ${updateScript}`,
      `Arguments: ${scriptArgs.join(" ")}`,
      `Log File: ${updateLogFile}`,
      "========================================",
      "",
    ].join("\n");

    logStream.write(logHeader);
    if (updateInfo?.prepared?.ready) {
      const preparedDockerCount = Array.isArray(updateInfo.prepared.dockerImages)
        ? updateInfo.prepared.dockerImages.length
        : 0;
      const prepSummary = [
        "Prepared Update Summary",
        `Preparation Log: ${updateInfo.prepared.prepLogPath || updatePreparation.getActivePreparationLogPath()}`,
        `Manifest Docker Images: ${preparedDockerCount}`,
        "Apply phase does not pull Docker images; Docker preparation happens before prompt/install.",
        "",
      ].join("\n");
      logStream.write(prepSummary);
    }
    console.log("📝 Update logs will be saved to:", updateLogFile);

    // Ensure Docker, OrbStack, and packaged runtime tools are in PATH.
    const enhancedEnv = createRuntimeShellEnv({
      baseEnv: process.env,
      overrides: {
        FORCE_COLOR: "1",
        TERM: "xterm-256color",
      },
      isPackagedApp: app.isPackaged === true,
      resourcesPath: process.resourcesPath,
    });

    // Execute update script
    console.log("Spawning bash process...");
    let child = null;
    try {
      child = spawn("bash", [updateScript, ...scriptArgs], {
        cwd: PROJECT_ROOT,
        env: enhancedEnv,
      });
    } catch (spawnError) {
      logStream.write(`[SPAWN ERROR] ${spawnError.message}\n`);
      logStream.end();
      finishExecution({
        success: false,
        error: spawnError.message,
        logFile: updateLogFile,
      });
      return;
    }

    console.log("Update process started with PID:", child.pid);

    let output = "";
    let errorOutput = "";
    let readyForRestart = false;

    child.stdout.on("data", (data) => {
      const text = data.toString();
      output += text;

      // Write to log file
      logStream.write(text);

      // Log key lines to console for debugging
      const lines = text.split("\n");
      lines.forEach((line) => {
        if (
          line.includes("Step") ||
          line.includes("PWD") ||
          line.includes("directory") ||
          line.includes("Script")
        ) {
          console.log("[UPDATE OUTPUT]", line.trim());
        }
      });

      // Check for restart signal
      if (text.includes("READY_FOR_RESTART")) {
        console.log("READY_FOR_RESTART signal received");
        readyForRestart = true;
      }

      // Send output to loading window and main window (for in-app modal)
      if (state.windows.loading && !state.windows.loading.isDestroyed()) {
        state.windows.loading.webContents.send("update-output", {
          data: text,
          type: "stdout",
        });
      }
      if (state.windows.main && !state.windows.main.isDestroyed()) {
        state.windows.main.webContents.send("update-output", {
          data: text,
          type: "stdout",
        });
      }
    });

    child.stderr.on("data", (data) => {
      const text = data.toString();
      errorOutput += text;

      // Write to log file (stderr)
      logStream.write(`[STDERR] ${text}`);

      console.log("[UPDATE ERROR]", text.trim());
      if (state.windows.loading && !state.windows.loading.isDestroyed()) {
        state.windows.loading.webContents.send("update-output", {
          data: text,
          type: "stderr",
        });
      }
      if (state.windows.main && !state.windows.main.isDestroyed()) {
        state.windows.main.webContents.send("update-output", {
          data: text,
          type: "stderr",
        });
      }
    });

    child.on("close", (code) => {
      console.log("=== UPDATE SCRIPT COMPLETED ===");
      console.log("Update script exited with code:", code);
      console.log("Ready for restart:", readyForRestart);
      const failureMessage =
        code === 0
          ? ""
          : deriveUpdateFailureMessage({
              output,
              errorOutput,
              code,
            });

      // Log footer
      const logFooter = [
        "",
        "========================================",
        "Update Script Completed",
        `Finished: ${new Date().toISOString()}`,
        `Exit Code: ${code}`,
        `Ready for Restart: ${readyForRestart}`,
        `Log File: ${updateLogFile}`,
        "========================================",
        "",
      ].join("\n");

      logStream.write(logFooter);
      logStream.end();

      console.log("📝 Complete update log saved to:", updateLogFile);

      // Persist the installed timestamp so restart does not re-trigger the same update
      if (
        forceLegacyUpdate &&
        code === 0 &&
        updateInfo?.latestBuildNumber &&
        updateInfo?.lastModified
      ) {
        const { saveLastInstalledBuildState } = require("./updates");
        saveLastInstalledBuildState(
          updateInfo.latestBuildNumber,
          updateInfo.lastModified,
        );
        console.log(
          "[Update] Saved installed build state:",
          updateInfo.latestBuildNumber,
          updateInfo.lastModified,
        );
      }

      if (state.windows.loading && !state.windows.loading.isDestroyed()) {
        state.windows.loading.webContents.send("update-complete", {
          success: code === 0,
          code,
          error: code === 0 ? undefined : failureMessage,
          readyForRestart,
        });
      }
      if (state.windows.main && !state.windows.main.isDestroyed()) {
        state.windows.main.webContents.send("update-complete", {
          success: code === 0,
          code,
          error: code === 0 ? undefined : failureMessage,
          readyForRestart,
        });
      }
      schedulePreparedAppInstallerFallback(updateInfo, readyForRestart, code);

      finishExecution({
        success: code === 0,
        output,
        error: code === 0 ? errorOutput : failureMessage,
        errorOutput,
        code,
        readyForRestart,
        logFile: updateLogFile,
      });
    });

    child.on("error", (err) => {
      console.error("Update script error:", err);

      // Log error and close stream
      const errorLog = [
        "",
        "========================================",
        "Update Script Error",
        `Error: ${err.message}`,
        `Timestamp: ${new Date().toISOString()}`,
        `Log File: ${updateLogFile}`,
        "========================================",
        "",
      ].join("\n");

      logStream.write(errorLog);
      logStream.end();

      console.log("📝 Update error log saved to:", updateLogFile);

      if (state.windows.loading && !state.windows.loading.isDestroyed()) {
        state.windows.loading.webContents.send("update-complete", {
          success: false,
          error: err.message,
        });
      }
      if (state.windows.main && !state.windows.main.isDestroyed()) {
        state.windows.main.webContents.send("update-complete", {
          success: false,
          error: err.message,
        });
      }
      finishExecution({
        success: false,
        error: err.message,
        logFile: updateLogFile,
      });
    });
  });
});

let mandatoryUpdateRepromptTimer = null;
let mandatoryUpdateRepromptKey = null;

function clearMandatoryUpdateReprompt() {
  if (mandatoryUpdateRepromptTimer) {
    clearTimeout(mandatoryUpdateRepromptTimer);
    mandatoryUpdateRepromptTimer = null;
  }
  mandatoryUpdateRepromptKey = null;
}

function scheduleMandatoryUpdateReprompt(updateInfo, currentChannel, deferUntilMs) {
  const updateKey = buildUpdateGraceKey(updateInfo, currentChannel);
  if (!updateKey || !Number.isFinite(deferUntilMs)) return;

  clearMandatoryUpdateReprompt();
  mandatoryUpdateRepromptKey = updateKey;

  const delayMs = Math.max(0, deferUntilMs - Date.now());
  console.log(
    `[Mandatory Update] Scheduling exact re-prompt in ${delayMs}ms (key=${updateKey})`,
  );

  mandatoryUpdateRepromptTimer = setTimeout(async () => {
    const expectedKey = mandatoryUpdateRepromptKey;
    clearMandatoryUpdateReprompt();

    try {
      const latestUpdateInfo = await checkForUpdates();
      if (!latestUpdateInfo.updateAvailable) {
        console.log("[Mandatory Update] Re-prompt skipped: update no longer available");
        return;
      }

      const latestChannel = getCurrentChannelInfo().packageName;
      const latestKey = buildUpdateGraceKey(latestUpdateInfo, latestChannel);
      if (!latestKey || latestKey !== expectedKey) {
        console.log(
          `[Mandatory Update] Re-prompt skipped: update key changed (${expectedKey} -> ${latestKey})`,
        );
        return;
      }

      if (!state.windows.main || state.windows.main.isDestroyed()) {
        console.log("[Mandatory Update] Re-prompt skipped: main window unavailable");
        return;
      }

      console.log("[Mandatory Update] Grace expired, showing mandatory prompt");
      await showMainWindowMandatoryUpdateDialog(latestUpdateInfo, {
        allowGraceDismiss: false,
      });
    } catch (error) {
      console.error("[Mandatory Update] Failed timed re-prompt:", error.message);
    }
  }, delayMs);
}

async function showMainWindowMandatoryUpdateDialog(updateInfo, options = {}) {
  const hydratedUpdateInfo = updatePreparation.attachPreparedArtifacts(updateInfo);
  if (!hydratedUpdateInfo?.prepared || hydratedUpdateInfo.prepared.ready !== true) {
    return {
      success: false,
      error: "Update preparation is still running. Please wait.",
    };
  }

  updateInfo = hydratedUpdateInfo;
  const suppressionState = isMandatoryPromptSuppressed(updateInfo);
  if (
    suppressionState.suppressed &&
    options.allowSuppressedAutoInstall !== false
  ) {
    console.log(
      `[Mandatory Update] Prompt suppressed for manual auto-install (${suppressionState.reason}) key=${suppressionState.updateKey || "n/a"} build=${suppressionState.buildNumber || "n/a"}`,
    );
    return {
      success: false,
      suppressed: true,
      reason: "manual-auto-install",
    };
  }
  const promptToken = resolveUpdateToken(updateInfo);
  if (
    promptToken &&
    mandatoryPromptInFlight &&
    activeMandatoryPromptToken === promptToken
  ) {
    console.log(
      `[Mandatory Update] Duplicate prompt request ignored for token=${promptToken}`,
    );
    return {
      success: true,
      deduped: true,
      duplicate: true,
    };
  }
  if (promptToken) {
    mandatoryPromptInFlight = true;
    activeMandatoryPromptToken = promptToken;
  }
  const allowGraceDismiss = options.allowGraceDismiss !== false;
  const currentChannel = getCurrentChannelInfo().packageName;
  const currentBuild = updateInfo.currentBuildNumber || "unknown";
  const latestBuild = updateInfo.latestBuildNumber || "unknown";
  const channelLabel =
    updateInfo.updateChannelLabel ||
    getCurrentChannelLabel() ||
    updateInfo.updateChannel ||
    currentChannel ||
    "Unknown";

  let parentWindow = null;
  if (options.parentWindow === "loading") {
    parentWindow = state.windows.loading;
  } else if (options.parentWindow === "main") {
    parentWindow = state.windows.main;
  } else {
    parentWindow = state.windows.main || state.windows.loading;
  }

  if (!parentWindow || parentWindow.isDestroyed()) {
    return {
      success: false,
      error: "No available window for update prompt",
    };
  }

  const canDismissForGrace =
    !updateInfo.forceUpdate &&
    allowGraceDismiss &&
    canOfferOneTimeUpdateGrace(updateInfo, currentChannel);
  const buttons = canDismissForGrace
    ? ["Dismiss for 5 minutes", "Update Now", "Quit"]
    : ["Update Now", "Quit"];
  const updateNowIndex = canDismissForGrace ? 1 : 0;
  const quitIndex = canDismissForGrace ? 2 : 1;

  try {
    const result = await dialog.showMessageBox(parentWindow, {
      type: "warning",
      title: "Update Required",
      message: `A required update is available: ${latestBuild}`,
      detail: `Release channel: ${channelLabel}\n\nCurrent version: ${currentBuild}\nNew version: ${latestBuild}\n\nThis update is required to continue using the application.\n\nPlease update now or quit.`,
      buttons,
      defaultId: updateNowIndex,
      cancelId: quitIndex,
      icon: getThemeIcon(),
    });

    if (canDismissForGrace && result.response === 0) {
      const graceResult = consumeOneTimeUpdateGrace(updateInfo, currentChannel);
      if (!graceResult.consumed) {
        console.warn(
          `[Mandatory Update] Grace dismissal unavailable (${graceResult.reason || "unknown"})`,
        );
        return showMainWindowMandatoryUpdateDialog(updateInfo, {
          allowGraceDismiss: false,
          parentWindow: options.parentWindow,
        });
      }

      console.log(
        `[Mandatory Update] User dismissed update for 5 minutes (until ${new Date(
          graceResult.deferUntilMs,
        ).toISOString()})`,
      );
      scheduleMandatoryUpdateReprompt(
        updateInfo,
        currentChannel,
        graceResult.deferUntilMs,
      );

      return {
        success: true,
        accepted: false,
        deferred: true,
        deferUntilMs: graceResult.deferUntilMs,
      };
    }

    if (result.response === updateNowIndex) {
      console.log(
        "[Mandatory Update] User accepted update, starting update process...",
      );
      clearMandatoryUpdateReprompt();
      clearUpdateGraceState();

      // Suppress all future mandatory prompts for this update to prevent
      // duplicate dialogs from racing with the in-flight install.
      suppressMandatoryPromptsForUpdate(updateInfo);

      if (options.parentWindow === "loading") {
        // Launch-gate flow — use loading window as before.
        if (state.windows.loading && !state.windows.loading.isDestroyed()) {
          sendToLoadingWindow("start-update", updateInfo);
        } else {
          createLoadingWindow(true, updateInfo);
        }
      } else {
        // Main window flow — show blocking modal in the main window instead.
        const dispatchResult = tryDispatchMainWindowStartUpdate(
          updateInfo,
          "mandatory-dialog",
        );
        if (!dispatchResult.started) {
          return {
            success: true,
            accepted: true,
            deduped: true,
            inProgress: dispatchResult.inProgress === true,
          };
        }
      }

      return { success: true, accepted: true };
    }

    // User chose to quit - stop all services first, then quit
    // Guard: if an update execution is already in-flight (e.g. a duplicate
    // mandatory dialog was auto-dismissed while the real install is running),
    // do NOT quit — that would kill the running update mid-apply and leave the
    // managed runtime tree or staged application bundle in a partial state.
    if (updateExecutionInFlight) {
      console.log(
        "[Mandatory Update] Ignoring quit request — update execution is in progress" +
          ` (token=${activeUpdateExecutionToken})`,
      );
      return { success: true, accepted: false, blockedByInFlight: true };
    }

    console.log("[Mandatory Update] User chose to quit instead of updating");
    console.log("[Mandatory Update] Stopping all services...");
    clearMandatoryUpdateReprompt();

    // Send UI feedback before stopping services.
    let sentStoppingSignal = false;
    if (state.windows.main && !state.windows.main.isDestroyed()) {
      state.windows.main.webContents.send("stopping-services");
      sentStoppingSignal = true;
    }
    if (state.windows.loading && !state.windows.loading.isDestroyed()) {
      state.windows.loading.webContents.send("stopping-services");
      sentStoppingSignal = true;
    }
    if (sentStoppingSignal) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    try {
      // Stop monitoring and health checks
      stopStatusMonitoring();
      stopContinuousHealthChecks();
      await stopHostMcpo(); // Async with proper cleanup

      // Stop Docker containers
      const PROJECT_ROOT = bootstrap.PROJECT_ROOT;
      const SCRIPTS_DIR = bootstrap.SCRIPTS_DIR;
      console.log("[Mandatory Update] Stopping Docker containers...");
      await execPromise(
        `bash "${path.join(SCRIPTS_DIR, "docker-compose.sh")}" stop`,
        { cwd: PROJECT_ROOT },
      );
      console.log("[Mandatory Update] Docker containers stopped");
    } catch (stopError) {
      console.error(
        "[Mandatory Update] Error stopping services:",
        stopError.message,
      );
      // Continue with quit even if stopping fails
    }

    console.log("[Mandatory Update] All services stopped, quitting app");
    tagAppQuit("mandatory-update-declined");
    app.quit();
    return { success: true, accepted: false, quit: true };
  } finally {
    if (promptToken && activeMandatoryPromptToken === promptToken) {
      mandatoryPromptInFlight = false;
      activeMandatoryPromptToken = null;
    }
  }
}

ipcMain.handle("start-update-from-main-window", async (event, updateInfo) => {
  try {
    let resolvedUpdateInfo = updateInfo;
    if (!resolvedUpdateInfo || !resolvedUpdateInfo.latestBuildNumber) {
      const latestUpdateInfo = await checkForUpdates();
      if (!latestUpdateInfo.updateAvailable) {
        return { success: false, error: "No update available" };
      }
      resolvedUpdateInfo = latestUpdateInfo;
    }

    resolvedUpdateInfo = updatePreparation.attachPreparedArtifacts(
      resolvedUpdateInfo,
    );
    if (
      !resolvedUpdateInfo?.prepared ||
      resolvedUpdateInfo.prepared.ready !== true
    ) {
      return {
        success: false,
        error: "Update preparation is still in progress.",
      };
    }

    if (!state.windows.main || state.windows.main.isDestroyed()) {
      return {
        success: false,
        error: "Main window is not available.",
      };
    }

    clearMandatoryUpdateReprompt();
    clearUpdateGraceState();

    suppressMandatoryPromptsForUpdate(resolvedUpdateInfo);

    const dispatchResult = tryDispatchMainWindowStartUpdate(
      resolvedUpdateInfo,
      "start-update-from-main-window",
    );
    return {
      success: true,
      started: dispatchResult.started === true,
      deduped: dispatchResult.deduped === true,
      inProgress: dispatchResult.inProgress === true,
    };
  } catch (error) {
    console.error("Failed to start update directly from main window:", error);
    return { success: false, error: error.message };
  }
});

// Show update dialog from main window (when user clicks update button or update is detected)
// This dialog is MANDATORY - user must update or quit
ipcMain.handle("show-update-dialog", async (event, updateInfo) => {
  try {
    let resolvedUpdateInfo = updateInfo;
    if (!resolvedUpdateInfo || !resolvedUpdateInfo.latestBuildNumber) {
      const latestUpdateInfo = await checkForUpdates();
      if (!latestUpdateInfo.updateAvailable) {
        return { success: false, error: "No update available" };
      }
      resolvedUpdateInfo = latestUpdateInfo;
    }

    resolvedUpdateInfo = updatePreparation.attachPreparedArtifacts(
      resolvedUpdateInfo,
    );
    if (
      !resolvedUpdateInfo?.prepared ||
      resolvedUpdateInfo.prepared.ready !== true
    ) {
      return {
        success: false,
        error: "Update preparation is still in progress.",
      };
    }

    const suppressionState = isMandatoryPromptSuppressed(resolvedUpdateInfo);
    if (suppressionState.suppressed) {
      console.log(
        `[Mandatory Update] Skipping show-update-dialog for suppressed manual auto-install (${suppressionState.reason}) key=${suppressionState.updateKey || "n/a"} build=${suppressionState.buildNumber || "n/a"}`,
      );
      return {
        success: false,
        suppressed: true,
        reason: "manual-auto-install",
      };
    }

    console.log(
      "Showing MANDATORY update dialog from main window with info:",
      resolvedUpdateInfo,
    );

    return await showMainWindowMandatoryUpdateDialog(resolvedUpdateInfo, {
      allowGraceDismiss: true,
      parentWindow: "main",
    });
  } catch (error) {
    console.error("Failed to show update dialog:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("show-launch-update-dialog", async (event, updateInfo) => {
  // Startup loading flow now auto-installs required updates once preparation is ready.
  // Keep this handler for compatibility with older renderer builds.
  console.log(
    "Showing launch-gated mandatory update dialog with info:",
    updateInfo,
  );

  try {
    let resolvedUpdateInfo = updateInfo;
    if (!resolvedUpdateInfo || !resolvedUpdateInfo.latestBuildNumber) {
      const latestUpdateInfo = await checkForUpdates();
      if (!latestUpdateInfo.updateAvailable) {
        return { success: false, error: "No update available" };
      }
      resolvedUpdateInfo = latestUpdateInfo;
    }

    resolvedUpdateInfo = updatePreparation.attachPreparedArtifacts(
      resolvedUpdateInfo,
    );
    if (
      !resolvedUpdateInfo?.prepared ||
      resolvedUpdateInfo.prepared.ready !== true
    ) {
      return {
        success: false,
        error: "Update preparation is still in progress.",
      };
    }

    return await showMainWindowMandatoryUpdateDialog(resolvedUpdateInfo, {
      allowGraceDismiss: false,
      parentWindow: "loading",
    });
  } catch (error) {
    console.error("Failed to show launch update dialog:", error);
    return { success: false, error: error.message };
  }
});

// Handle app restart after update
ipcMain.handle("restart-after-update", async () => {
  console.log("=== RESTART AFTER UPDATE ===");
  console.log("Restarting app after update...");
  console.log("Current working directory:", process.cwd());

  try {
    return startPreparedAppInstaller({ source: "renderer-ipc" });
  } catch (error) {
    console.error("=== RESTART FAILED ===");
    console.error("Failed to restart after update:", error);
    console.error("Error stack:", error.stack);
    return { success: false, error: error.message };
  }
});

// PORTICO-399: get-app-location-status / offer-app-relocation removed with the
// in-app relocation banner -- the launch guard blocks a non-blessed launch, so a
// running app is always somewhere it can update from.

// show-config, open-manager, oauth-flow-dismissed handlers moved to ipc.js

// Setup webview link handler
ipcMain.on("setup-webview-link-handler", (event, webviewId) => {
  console.log("=== RECEIVED WEBVIEW LINK HANDLER REQUEST ===");
  console.log("Setting up webview link handler for ID:", webviewId);
  console.log("Event sender ID:", event.sender.id);

  try {
    const webviewContents = webContents.fromId(webviewId);
    console.log("Found webview contents:", !!webviewContents);

    if (webviewContents) {
      // Route conversation links to the main window when available
      const mainWindowContents =
        state.windows.main && !state.windows.main.isDestroyed()
          ? state.windows.main.webContents
          : event.sender;

      // Set up the window open handler for the webview
      webviewContents.setWindowOpenHandler(
        ({ url, frameName, features, disposition, referrer, postBody }) => {
          console.log(
            "=== WEBVIEW (ID: " + webviewId + ") WANTS TO OPEN WINDOW ===",
          );
          console.log("URL:", url);
          console.log("Disposition:", disposition);

          // Check if this is a conversation detail link (e.g., http://localhost:3789/c/[uuid])
          const conversationPattern =
            /^http:\/\/localhost:3789\/c\/([a-f0-9-]+)$/;
          const match = url.match(conversationPattern);

          if (match) {
            const conversationId = match[1];
            console.log("Conversation detail link detected:", conversationId);
            console.log(
              "Sending to renderer (webContents ID: " +
                mainWindowContents.id +
                ") to create new tab",
            );

            // Send IPC message to main window renderer to create a new conversation tab
            try {
              mainWindowContents.send(
                "open-conversation-tab",
                url,
                conversationId,
              );
              console.log("IPC message sent successfully");
            } catch (err) {
              console.error("Failed to send IPC message:", err);
            }

            // Deny the default window opening
            return { action: "deny" };
          }

          const protocol = new URL(url).protocol;

          // Open external links in default browser
          if (["https:", "http:"].includes(protocol)) {
            console.log("Opening in external browser:", url);
            void openHttpExternalUrl(shell, url).catch(() => {});
          }

          // Deny opening new window
          return { action: "deny" };
        },
      );

      // Also add will-navigate handler
      webviewContents.on("will-navigate", (event, url) => {
        console.log("=== WEBVIEW WILL NAVIGATE ===");
        console.log("URL:", url);

        // Allow Open WebUI (port 3789) and workspace file downloads (port 9876)
        const allowedPrefixes = [
          "http://localhost:3789",
          "http://localhost:9876/workspace/",
          "http://127.0.0.1:9876/workspace/",
        ];

        const isAllowed = allowedPrefixes.some((prefix) =>
          url.startsWith(prefix),
        );

        if (!isAllowed) {
          console.log("Preventing navigation, opening externally instead");
          event.preventDefault();
          void openHttpExternalUrl(shell, url).catch(() => {});
        }
      });

      console.log("Window open handler and navigation handler set for webview");
    } else {
      console.error("Could not find webview with ID:", webviewId);
    }
  } catch (error) {
    console.error("Error setting up webview link handler:", error);
  }
});

// ensureVolumeFilesExist, ensureDockerRunning, executeWithStreaming imported from docker-mcp.js

// Initialization logging functions - imported from bootstrap
const {
  startInitLogging,
  logToInitFile,
  stopInitLogging,
  sendInitLog,
  cleanupOldInitLogs,
} = bootstrap;

// runMcpInitialization is imported from docker-mcp.js
// Wire up the resetConfigData dependency when docker-mcp is ready
setResetConfigData(resetConfigData);

// Note: runMcpInitialization function moved to docker-mcp.js
// The function is available via the destructured import above

// ============================================================================
// LOADING SCREEN / INITIALIZATION IPC HANDLERS
// ============================================================================

// Startup failure classification (stale-container recovery command, port
// conflicts, readiness timeouts, packaged-runtime integrity, ...) lives in
// startup-failure-classifier.js so it stays unit-testable (PORTICO-236).
const {
  buildLoadingErrorPayload,
  classifyContainerStartupFailure,
  describeFailedStopPhase,
} = require("./startup-failure-classifier");

// PORTICO-373: automatic container-engine repair when a teardown times out, so a
// wedged engine does not send the user to Terminal.
// PORTICO-443: numeric address-space telemetry. The main process died of mapping
// exhaustion, not RSS, and nothing in the bundle could have shown it.
const {
  createAddressSpaceMonitor,
  createVmmapRegionReader,
} = require("./address-space-telemetry");
const { runManagedProcess: runManagedProcessForTelemetry } = require("./managed-process");
let addressSpaceMonitor = null;

const {
  recoverWedgedEngineAfterFailedStop,
  runTeardownWithEngineRecovery,
} = require("./engine-wedge-recovery");

// Budget for `docker-compose.sh stop`. It runs two `docker compose down` passes
// plus cleanup, so this is generous rather than tight; exceeding it is treated as
// evidence of an unresponsive engine, not as a slow-but-working teardown.
const STOP_PHASE_TIMEOUT_MS = 60000;
// After the timeout fires, how long to wait for the terminated process group to
// actually be gone before giving up on confirming it (PORTICO-373).
const STOP_PHASE_TREE_EXIT_CONFIRM_MS = 10000;

async function runPostReleaseDockerStorageCleanup(expectedTransition) {
  if (!app.isPackaged) {
    return { success: true, skipped: true, reason: "not-packaged" };
  }

  // Re-read immediately before claiming the transition. This prevents a
  // newer completed update from being authorized by an older health proof.
  const pending = findPendingPostHealthCleanup({
    projectRoot: PROJECT_ROOT,
    currentBuild: buildInfo.buildNumber,
  });
  if (!pending.pending) {
    return { success: true, skipped: true, reason: pending.reason };
  }

  const transition = pending.transition;
  if (
    !expectedTransition ||
    transition.from !== expectedTransition.from ||
    transition.to !== expectedTransition.to ||
    transition.source !== expectedTransition.source ||
    transition.transitionId !== expectedTransition.transitionId
  ) {
    sendInitLog(
      "⚠️  Post-release Docker cleanup skipped because the completed update transition changed after its health proof\n",
      "warning",
    );
    return { success: false, skipped: true, reason: "transition-changed" };
  }

  const historyFields = {
    projectRoot: PROJECT_ROOT,
    from: transition.from,
    to: transition.to,
    source: POST_HEALTH_CLEANUP_SOURCE,
    transitionId: transition.transitionId,
  };
  const claim = appendUpdateHistory({
    ...historyFields,
    step: "post_health_cleanup_claim",
    result: "pending",
  });
  if (!claim.success) {
    sendInitLog(
      `⚠️  Post-release Docker cleanup skipped because its transition claim could not be recorded: ${claim.error}\n`,
      "warning",
    );
    return { success: false, skipped: true, reason: "claim-write-failed" };
  }

  sendInitLog(
    `\n🧹 Reclaiming superseded Docker image tags after verified update ${transition.from} → ${transition.to}...\n`,
    "info",
  );
  const maintenance = await runDockerStorageMaintenance({
    projectRoot: PROJECT_ROOT,
    resourcesPath: process.resourcesPath,
    includeMigration: false,
    includeCleanup: true,
    expectedCurrentTag: transition.to,
    expectedPreviousTag: transition.from,
    onLog: (message, type) => sendInitLog(`${message}\n`, type),
  });
  const recorded = appendUpdateHistory({
    ...historyFields,
    step: POST_HEALTH_CLEANUP_STEP,
    result: maintenance.success ? "ok" : "fail",
  });
  if (!recorded.success) {
    sendInitLog(
      `⚠️  Post-release cleanup result could not be recorded and will be retried safely: ${recorded.error}\n`,
      "warning",
    );
    return {
      ...maintenance,
      success: false,
      cleanupSucceeded: maintenance.success,
      receiptRecorded: false,
      error: recorded.error,
    };
  }

  if (maintenance.success) {
    sendInitLog("✅ Post-release Docker image cleanup completed\n", "success");
  } else {
    sendInitLog(
      "⚠️  Post-release Docker image cleanup was skipped or incomplete; startup will continue and cleanup will retry after a future fresh health pass\n",
      "warning",
    );
  }
  return maintenance;
}

// Loading screen handlers
// releasePendingMcpRuntimeMutation now lives in shared-state, so the IPC
// handlers and the window lifecycle in windows.js can release the same lease.
// Call it as state.releasePendingMcpRuntimeMutation(reason).

function ensurePendingMcpRuntimeMutation(kind, source) {
  if (typeof state.appState.mcpRuntimeMutationRelease === "function") {
    // Adopt the lease docker-start/docker-restart already took for this
    // bring-up. Re-stamp it so a long cold init cannot age past the staleness
    // eviction window while it is legitimately still held.
    defaultMcpOperationManager.renewMutationLease({ kind, source });
    return false;
  }
  state.appState.mcpRuntimeMutationRelease =
    defaultMcpOperationManager.acquireMutationLease({ kind, source });
  return true;
}

function formatIntegrityGuardSize(sizeBytes) {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return "unknown size";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = sizeBytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function formatIntegrityGuardCandidate(candidate) {
  if (!candidate) return "none found";
  const timestamp = Number.isFinite(candidate.mtimeMs)
    ? new Date(candidate.mtimeMs).toLocaleString()
    : "unknown date";
  return `${timestamp}, ${formatIntegrityGuardSize(candidate.sizeBytes)}`;
}

async function enforceOpenWebuiDbIntegrityBeforeDocker() {
  // A previous app crash can leave Open WebUI running even though this launch
  // has not reached its normal Docker startup phase. Stop the data plane before
  // inspecting the database so it cannot create, migrate, or replay WAL pages
  // while the fail-closed sentinel decision is being made.
  let containerState;
  try {
    containerState = owuiDataIntegrityGuard.stopOpenWebuiContainer();
  } catch (error) {
    const message =
      "Could not stop Open WebUI before checking your chat database";
    const loadingWindow = state.windows.loading;
    if (loadingWindow && !loadingWindow.isDestroyed()) {
      loadingWindow.webContents.send("loading-error", message);
    }
    sendInitLog(`\n❌ ${message}: ${error.message}\n`, "error");
    return false;
  }
  if (containerState.wasRunning) {
    sendInitLog(
      `⏹️  Stopped ${containerState.containerName} before database safety check\n`,
      "info",
    );
  }

  // TEST HOOK (PORTICO_TEST_KEEP_SERVICES): the fast path never re-runs Docker
  // startup, so bring back the container this guard stopped for the
  // fail-closed check — otherwise container readiness would stall. Must run
  // on EVERY continue path (clean check, explicit continue, restore), not
  // just the clean one.
  const restartGuardStoppedContainerForTestHook = async () => {
    if (
      process.env.PORTICO_TEST_KEEP_SERVICES !== "1" ||
      !containerState.wasRunning ||
      !containerState.containerName
    ) {
      return;
    }
    try {
      const dockerBinary = containerState.dockerBinary || "docker";
      await execPromise(
        `"${dockerBinary}" start ${containerState.containerName}`,
      );
      sendInitLog(
        `🧪 Test hook: restarted ${containerState.containerName} after database safety check\n`,
        "info",
      );
    } catch (error) {
      sendInitLog(
        `⚠️  Test hook: failed to restart ${containerState.containerName}: ${error.message}\n`,
        "warning",
      );
    }
  };

  const integrity = owuiDataIntegrityGuard.checkDbSentinel({
    projectRoot: PROJECT_ROOT,
  });
  if (!integrity.blocked) {
    await restartGuardStoppedContainerForTestHook();
    return true;
  }

  const message = "Your chat database appears to be missing or damaged";
  const loadingWindow = state.windows.loading;
  if (loadingWindow && !loadingWindow.isDestroyed()) {
    loadingWindow.webContents.send("loading-error", message);
  }
  sendInitLog(`\n❌ ${message}\n`, "error");

  const candidates = owuiDataIntegrityGuard.findRestoreCandidates({
    projectRoot: PROJECT_ROOT,
  });
  let candidateIndex = 0;
  const recordedSize = formatIntegrityGuardSize(integrity.sentinel?.sizeBytes);
  const currentSize = integrity.current
    ? formatIntegrityGuardSize(integrity.current.sizeBytes)
    : "missing";

  while (true) {
    const candidate = candidates[candidateIndex] || null;
    const candidateDescription = formatIntegrityGuardCandidate(candidate);
    const buttons = candidate
      ? [
          `Restore from backup (${candidateDescription})`,
          "Continue with empty database",
          "Quit",
        ]
      : ["Continue with empty database", "Quit"];
    const continueIndex = candidate ? 1 : 0;
    const quitIndex = candidate ? 2 : 1;
    const promptOptions = {
      type: integrity.level === "warning" ? "warning" : "error",
      title: "Chat Database Safety Check",
      message,
      detail:
        `Portico previously recorded a ${recordedSize} chat database, but the current database is ${currentSize}. ` +
        (candidate
          ? `The preferred backup is from ${candidateDescription}. Choose whether to restore it, explicitly continue with an empty database, or quit without changing your data.`
          : "No usable backup was found automatically. You can explicitly continue with an empty database or quit without changing your data."),
      buttons,
      defaultId: candidate ? 0 : quitIndex,
      cancelId: quitIndex,
      icon: getThemeIcon(),
    };
    const promptResult =
      loadingWindow && !loadingWindow.isDestroyed()
        ? await dialog.showMessageBox(loadingWindow, promptOptions)
        : await dialog.showMessageBox(promptOptions);

    if (promptResult.response === quitIndex) {
      sendInitLog(
        "Database safety check: user quit without modifying the database.\n",
        "warning",
      );
      tagAppQuit("owui-db-integrity-guard");
      app.quit();
      return false;
    }

    if (promptResult.response === continueIndex) {
      sendInitLog(
        "⚠️  Database safety check: user explicitly continued with the current database.\n",
        "warning",
      );
      await restartGuardStoppedContainerForTestHook();
      return true;
    }

    const restoreResult = owuiDataIntegrityGuard.restoreOpenWebuiDbFromBackup({
      projectRoot: PROJECT_ROOT,
      candidateId: candidate.id,
      buildNumber: buildInfo.buildNumber || null,
      restartContainerAfterRestore: false,
    });
    if (restoreResult.success) {
      sendInitLog(
        `✅ Restored Open WebUI database from ${candidate.path}\n`,
        "success",
      );
      if (loadingWindow && !loadingWindow.isDestroyed()) {
        loadingWindow.webContents.send(
          "loading-status",
          "Chat database restored. Continuing initialization...",
        );
      }
      await restartGuardStoppedContainerForTestHook();
      return true;
    }

    sendInitLog(
      `❌ Database restore failed: ${restoreResult.error || "unknown error"}\n`,
      "error",
    );
    candidateIndex += 1;
    const nextCandidate = candidates[candidateIndex] || null;
    const restoreErrorOptions = {
      type: "error",
      title: "Database Restore Failed",
      message: "The chat database backup could not be restored",
      detail:
        `${restoreResult.error || "The selected backup could not be validated or copied safely."}` +
        (nextCandidate
          ? `\n\nThe next available backup is from ${formatIntegrityGuardCandidate(nextCandidate)}.`
          : "\n\nNo additional database backup was found automatically."),
      buttons: ["Back"],
      defaultId: 0,
      cancelId: 0,
      icon: getThemeIcon(),
    };
    if (loadingWindow && !loadingWindow.isDestroyed()) {
      await dialog.showMessageBox(loadingWindow, restoreErrorOptions);
    } else {
      await dialog.showMessageBox(restoreErrorOptions);
    }
  }
}

ipcMain.on("start-initialization", async (event) => {
  console.log("Received start-initialization event");

  let acquiredRuntimeMutation = false;
  try {
    acquiredRuntimeMutation = ensurePendingMcpRuntimeMutation(
      "runtime_initialization",
      "loading",
    );
  } catch (error) {
    console.error("[Main] Runtime initialization blocked by MCP mutation:", error.message);
    if (state.windows.loading && !state.windows.loading.isDestroyed()) {
      state.windows.loading.webContents.send("loading-error", error.message);
    }
    return;
  }

  // Start logging to file
  startInitLogging();

  if (isInitializing) {
    console.log("Already initializing, skipping...");
    if (acquiredRuntimeMutation) {
      state.releasePendingMcpRuntimeMutation("start-initialization-duplicate");
    }
    return;
  }
  isInitializing = true;

  try {
    console.log("Starting initialization process...");

    if (state.windows.loading && !state.windows.loading.isDestroyed()) {
      sendInitLog("🚀 Starting Portico initialization...\n", "info");
      state.windows.loading.webContents.send("loading-progress", 5);

      // CRITICAL: Ensure volume mount files exist before Docker operations
      ensureVolumeFilesExist();
      await cleanupLegacyRequestPayloadsFromKnownRoots();

      // Re-ensure MCP create_dirs host directories on every init pass: the
      // module-load call runs once per OS process, but Restart Services and
      // DB-repair restarts reuse the process (the user may have deleted e.g.
      // ~/.snowflake/ mid-session). Idempotent mkdir -p; never throws.
      tryEnsureMcpCreateDirs(PROJECT_ROOT, { logger: console, sendInitLog });

      // Ensure the mutable managed runtime tree matches the running packaged app
      // before any Docker startup. This is the manual DMG recovery path when the
      // user replaces /Applications/Portico.app without applying the
      // managed runtime payload for the same build.
      state.windows.loading.webContents.send(
        "loading-status",
        "Checking installed runtime build...",
      );
      sendInitLog(
        "🧭 Checking bundled app build against the installed managed runtime...\n",
        "info",
      );

      const isLocalDevBuild = buildInfo.buildNumber === "dev-build";
      const runtimeBuildMatch = prerequisitesService.doesInstalledBuildMatchBundledBuild(
        PROJECT_ROOT,
      );
      if (app.isPackaged && !isLocalDevBuild && !runtimeBuildMatch.matches) {
        const bundledBuildNumber =
          runtimeBuildMatch?.bundledBuild?.data?.buildNumber ||
          buildInfo.buildNumber ||
          "unknown";
        const installedBuildNumber =
          runtimeBuildMatch?.installedBuild?.data?.buildNumber || "missing";
        sendInitLog(
          `[Runtime Update] bundled-build-mismatch detected (bundled=${bundledBuildNumber}, installed=${installedBuildNumber})\n`,
          "warning",
        );
        state.windows.loading.webContents.send(
          "loading-status",
          "Updating the managed runtime to match this app build...",
        );
      }

      const runtimeUpdateResult =
        await prerequisitesService.updateInstalledRuntimeToBundledBuild({
          projectRoot: PROJECT_ROOT,
          targetWindow: state.windows.loading,
        });

      if (!runtimeUpdateResult.success) {
        const runtimeUpdateError =
          runtimeUpdateResult.error ||
          "Managed runtime update failed before Docker startup.";
        sendInitLog(
          `❌ Managed runtime update failed: ${runtimeUpdateError}\n`,
          "error",
        );
        // PORTICO-323: when the failure is that OrbStack isn't installed, the
        // generic "check your network and retry" banner is misleading and
        // dead-ends the user. Point them at installing OrbStack instead.
        state.windows.loading.webContents.send(
          "loading-error",
          orbstackAvailability.actionableUpdateFailureMessage(
            runtimeUpdateError,
            "Portico could not update the managed runtime to match this app build. Check your network connection and retry.",
          ),
        );
        stopInitLogging();
        return;
      }

      if (runtimeUpdateResult.updated) {
        sendInitLog(
          `✅ Managed runtime updated using ${runtimeUpdateResult.source} for build ${runtimeUpdateResult.bundledBuildNumber || buildInfo.buildNumber}\n`,
          "success",
        );
      } else if (runtimeUpdateResult.source === "local-dev-build") {
        sendInitLog(
          "ℹ️ Managed runtime update is not required for packaged local dev-build startup\n",
          "info",
        );
      } else if (runtimeUpdateResult.source === "not-packaged") {
        sendInitLog(
          "ℹ️ Managed runtime update is not required for unpackaged development startup\n",
          "info",
        );
      } else {
        sendInitLog(
          `✅ Installed runtime already matches bundled build ${runtimeUpdateResult.bundledBuildNumber || buildInfo.buildNumber}\n`,
          "success",
        );
      }
      state.windows.loading.webContents.send("loading-progress", 6);

      // The launch-gate update has finished, but Docker has not been probed or
      // started yet. Halt here if a previously meaningful chat DB disappeared
      // or shrank catastrophically so Open WebUI cannot migrate an empty file.
      if (!(await enforceOpenWebuiDbIntegrityBeforeDocker())) {
        stopInitLogging();
        return;
      }

      // Complete the one-way legacy OAuth upgrade before any MCP runtime can
      // vend credentials. A physical legacy record intentionally replaces any
      // pre-existing secure record, then is deleted only after encrypted
      // persistence has been verified by the storage helper.
      try {
        const oauthMigration = migrateAllLegacyOAuthRecords({
          projectRoot: PROJECT_ROOT,
        });
        if (oauthMigration.imported > 0) {
          sendInitLog(
            `🔐 Migrated ${oauthMigration.imported} legacy OAuth record(s) into secure storage\n`,
            "success",
          );
        }
        if (oauthMigration.requiresReauth > 0) {
          sendInitLog(
            `⚠️  ${oauthMigration.requiresReauth} legacy OAuth record(s) could not be migrated and require authentication\n`,
            "warning",
          );
        }
      } catch (error) {
        console.warn(
          `[OAuth Migration] Startup migration failed before MCP launch: ${error.message}`,
        );
        sendInitLog(
          "⚠️  Legacy OAuth migration could not complete; affected integrations will require authentication\n",
          "warning",
        );
      }

      // Reconcile user-installed integrations whose IDs are now reserved by
      // bundled servers before any config consumer or container can observe
      // the ambiguous namespace.
      try {
        const collisionMigration = migrateUserMcpCollisions({
          projectRoot: PROJECT_ROOT,
          userDataPath: app.getPath("userData"),
          safeStorage,
          logger: console,
        });
        if (collisionMigration.migrated > 0) {
          sendInitLog(
            `✅ Preserved ${collisionMigration.migrated} custom integration(s) under unique IDs\n`,
            "success",
          );
        }
      } catch (error) {
        console.error(
          `[MCP Collision] Startup migration failed before MCP launch: ${error.message}`,
        );
        sendInitLog(
          "❌ A custom integration conflicts with a newly bundled integration and could not be preserved safely\n",
          "error",
        );
        state.windows.loading.webContents.send(
          "loading-error",
          "Portico could not safely preserve a custom integration that now conflicts with a bundled integration. MCP services were not started. Retry initialization; if the error continues, collect debug logs and contact support.",
        );
        stopInitLogging();
        return;
      }

      // Check and start Docker if needed
      state.windows.loading.webContents.send(
        "loading-status",
        "Checking Docker status...",
      );
      sendInitLog("🐳 Checking Docker status...\n", "info");

      const dockerReady = await ensureDockerRunning();
      if (!dockerReady) {
        sendInitLog(
          `❌ Docker could not be started automatically. If OrbStack is installed, it did not become ready within ${ORBSTACK_DOCKER_STARTUP_TIMEOUT_LABEL}.\n`,
          "error",
        );
        sendInitLog(
          "Open OrbStack and wait for Docker to finish starting, then click Retry Initialization.\n",
          "info",
        );
        state.windows.loading.webContents.send(
          "loading-error",
          `Docker is required but did not become ready automatically. Open OrbStack and retry after waiting up to ${ORBSTACK_DOCKER_STARTUP_TIMEOUT_LABEL}.`,
        );
        stopInitLogging();
        return;
      }

      await cleanupLegacyRequestPayloadsFromGatewayMounts();
      sendInitLog("✅ Docker is ready\n", "success");
      state.windows.loading.webContents.send("loading-progress", 8);

      if (app.isPackaged && runtimeUpdateResult.updated) {
        const updatedBuildNumber =
          runtimeUpdateResult.bundledBuildNumber || buildInfo.buildNumber;
        state.windows.loading.webContents.send(
          "loading-status",
          "Preparing Docker images for the updated build...",
        );
        sendInitLog(
          `🐳 Preparing exact-build Docker images for ${updatedBuildNumber}...\n`,
          "info",
        );

        try {
          prerequisitesService.resetPrerequisitesCancellation();
          const updatedBuildImages = prerequisitesService.getDockerImagesToPull({
            tag: updatedBuildNumber,
          });
          const dockerPullResult =
            await prerequisitesService.pullDockerImagesWithProgress({
              targetWindow: state.windows.loading,
              images: updatedBuildImages,
              maxRetries: 1,
              concurrency: 2,
              allowOrbStackRestartRecovery: true,
            });

          if (!dockerPullResult.success) {
            const dockerPullFailure =
              prerequisitesService.buildPackagedDockerRecoveryFailure(
                dockerPullResult,
                { imageSpecs: updatedBuildImages },
              );
            sendInitLog(`❌ ${dockerPullFailure.error}\n`, "error");
            state.windows.loading.webContents.send(
              "loading-error",
              buildLoadingErrorPayload(
                dockerPullFailure.error,
                dockerPullFailure.recovery,
              ),
            );
            stopInitLogging();
            return;
          }

          sendInitLog(
            `✅ Docker images are ready for build ${updatedBuildNumber}\n`,
            "success",
          );
        } catch (error) {
          const imagePreparationError =
            error?.message || "Docker image preparation failed";
          sendInitLog(
            `❌ Docker image preparation failed: ${imagePreparationError}\n`,
            "error",
          );
          state.windows.loading.webContents.send(
            "loading-error",
            "Portico could not prepare the Docker images for the updated build. Check Docker and your network connection, then retry initialization.",
          );
          stopInitLogging();
          return;
        }
      }

      // ========================================================================
      // CLEANUP: Remove stale duplicate core service containers from prior tests
      // These can survive normal compose restarts if they were launched as
      // one-off containers with the same compose service labels.
      // ========================================================================
      sendInitLog(
        "🧹 Cleaning up stale duplicate core service containers...\n",
        "info",
      );

      try {
        const llmGatewayContainerName = getLlmGatewayContainerName();
        const cleanupResult = await executeWithStreaming(
          '(\n'
            + `docker ps -a --filter "label=com.docker.compose.project=portico" --filter "label=com.docker.compose.service=llm-gateway" --format "{{.Names}}" | grep -vx ${llmGatewayContainerName} || true\n`
            + ') | sed "/^$/d" | sort -u | xargs -r docker rm -f',
          [],
          30000,
          { bufferUICheck: true },
        );

        if (cleanupResult.success) {
          const output = cleanupResult.output?.trim() || "";
          if (output) {
            const containerCount = output
              .split("\n")
              .filter((line) => line.trim()).length;
            sendInitLog(
              `✅ Removed ${containerCount} stale duplicate core container(s)\n`,
              "success",
            );
          } else {
            sendInitLog(
              "✅ No stale duplicate core service containers found\n",
              "success",
            );
          }
        } else {
          sendInitLog(
            "⚠️  Duplicate core service cleanup completed with warnings\n",
            "warning",
          );
        }
      } catch (error) {
        sendInitLog(
          `⚠️  Duplicate core service cleanup error: ${error.message}\n`,
          "warning",
        );
      }

      // ========================================================================
      // CLEANUP: Remove stale single-server OAuth stacks from guided setup
      // (Silent - no visual step, just logs)
      // ========================================================================
      sendInitLog(
        "🧹 Cleaning up any stale single-server OAuth stacks...\n",
        "info",
      );

      try {
        const cleanupResult = await executeWithStreaming(
          '(docker ps -a --filter "name=mcpo-single-" -q; docker ps -a --filter "label=com.docker.compose.project=portico-single" -q) | sort -u | xargs -r docker rm -f; docker network rm portico-single_single-server 2>/dev/null || true',
          [],
          30000, // 30 second timeout
          { bufferUICheck: true },
        );

        if (cleanupResult.success) {
          const output = cleanupResult.output?.trim() || "";
          if (output) {
            const containerCount = output
              .split("\n")
              .filter((line) => line.trim()).length;
            sendInitLog(
              `✅ Removed ${containerCount} single-server container(s)\n`,
              "success",
            );
          } else {
            sendInitLog("✅ No single-server containers found\n", "success");
          }
        } else {
          sendInitLog(
            "⚠️  Single-server cleanup completed with warnings\n",
            "warning",
          );
        }
      } catch (error) {
        // Non-fatal error - log and continue
        sendInitLog(
          `⚠️  Single-server cleanup error: ${error.message}\n`,
          "warning",
        );
      }

      state.windows.loading.webContents.send("loading-progress", 10);

      // ========================================================================
      // CHECK FOR FORCE RESTART (user clicked Restart Services from Control Plane)
      // ========================================================================
      const forceRestart = state.appState.forceRestart;
      state.appState.forceRestart = false; // Reset the flag immediately

      let checkResult;
      let checkDuration = 0;
      let dockerStartResult = null;

      if (forceRestart) {
        // ======================================================================
        // FORCE RESTART PATH - User explicitly requested restart, skip smart check
        // ======================================================================
        console.log(
          "[Init] 🔄 Force restart requested - skipping smart startup check",
        );
        sendInitLog(
          "🔄 Force restart requested - restarting all services...\n",
          "info",
        );
        state.windows.loading.webContents.send("loading-step", "verify");
        state.windows.loading.webContents.send(
          "loading-status",
          "Force restart requested...",
        );
        state.windows.loading.webContents.send(
          "loading-step-complete",
          "verify",
        );
        // Simulate a checkResult that requires restart
        checkResult = {
          needsRestart: true,
          reasons: ["User requested restart"],
        };
      } else if (process.env.PORTICO_TEST_KEEP_SERVICES === "1") {
        // ======================================================================
        // TEST HOOK (Docker Orchestration layer): keep the running Docker stack
        // across app relaunches. Opt-in via PORTICO_TEST_KEEP_SERVICES=1 for
        // automated-test/dev cycles only — routes into the existing fast path
        // (config check is cached; containers start only if config changed).
        // Assumes the stack is already up and healthy; a cold machine should
        // launch without the flag first.
        // ======================================================================
        console.log(
          "[Init] [TEST] PORTICO_TEST_KEEP_SERVICES=1 - keeping running services (test hook)",
        );
        sendInitLog(
          "🧪 Test hook: keeping running Docker services across relaunch...\n",
          "info",
        );
        state.windows.loading.webContents.send("loading-step", "verify");
        state.windows.loading.webContents.send(
          "loading-status",
          "Reusing running services (test hook)...",
        );
        checkResult = {
          needsRestart: false,
          reasons: [],
        };
      } else {
        // ======================================================================
        // SMART STARTUP CHECK - TEMPORARILY DISABLED
        // The checkServicesNeedRestart() function is kept in docker-mcp.js but
        // bypassed here due to bugs causing more trouble than it's worth.
        // TODO: Re-enable smart startup once the bugs are fixed.
        // ======================================================================
        console.log(
          "[Init] Smart startup check DISABLED - always performing full restart",
        );
        state.windows.loading.webContents.send("loading-step", "verify");
        state.windows.loading.webContents.send(
          "loading-status",
          "Preparing services...",
        );
        sendInitLog(
          "ℹ️  Smart startup disabled - performing full restart...\n",
          "info",
        );
        state.windows.loading.webContents.send(
          "loading-step-complete",
          "verify",
        );
        checkResult = {
          needsRestart: true,
          reasons: ["Smart startup temporarily disabled"],
        };
        checkDuration = 0;
      }

      // Check HOST_MODE support before making fast/full path decision
      // (needed for both paths, calculated once here)
      let hostModeSupported = false;
      try {
        const hostModePath = path.join(PROJECT_ROOT, "HOST_MODE");
        hostModeSupported = readHostModeFileSync(hostModePath);
      } catch (err) {
        // HOST_MODE file not found, assume not supported
        hostModeSupported = false;
      }

      const hostServersConfigured = async () =>
        hostModeSupported && await checkHostMcpServersConfigured();

      const ensureHostMcpBridgeReadyForStartup = async () => {
        // The Host MCP Bridge daemon is also the mandatory OAuth secret broker
        // for all containerized MCP servers, so it must be running regardless
        // of the optional external-client bridge preference (PORTICO-200). The
        // preference only governs external MCP client integration.
        if (!isHostMcpBridgeDesiredEnabled()) {
          sendInitLog(
            "\n🔌 External-client Host MCP Bridge feature is disabled; keeping the OAuth broker available for MCP authentication...\n",
            "info",
          );
        }

        sendInitLog("\n🔗 Waiting for Host MCP Bridge readiness...\n", "info");
        const bridgeResult = await ensureHostMcpBridgeReady();
        if (bridgeResult.ready) {
          sendInitLog("✅ Host MCP Bridge is healthy\n", "success");
          return true;
        }

        const message =
          bridgeResult.error ||
          "The OAuth broker (Host MCP Bridge) did not become healthy.";
        sendInitLog(`❌ ${message}\n`, "error");
        state.windows.loading.webContents.send("loading-step-failed", "start");
        state.windows.loading.webContents.send(
          "loading-error",
          buildLoadingErrorPayload(message),
        );
        return false;
      };

      if (!checkResult.needsRestart) {
        // ======================================================================
        // FAST PATH - Services are healthy, skip restart
        // ======================================================================
        console.log("[Init] ✅ Fast startup path - skipping service restart");
        sendInitLog("✅ All services healthy and up-to-date!\n", "success");
        sendInitLog("⏭️  Skipping service restart (fast startup)\n", "info");
        sendInitLog(`   Check completed in ${checkDuration}ms\n`, "info");
        state.windows.loading.webContents.send(
          "loading-step-complete",
          "verify",
        );
        state.windows.loading.webContents.send("loading-step-skipped", "stop");

        // Always run MCP config generation (script has its own caching)
        // This ensures newly enabled servers are configured even in fast path.
        // EXCEPTION: under the PORTICO_TEST_KEEP_SERVICES test hook the contract is
        // "Electron-only changes" — the running containers and their config
        // must be left completely untouched, so skip regeneration entirely
        // (regenerating here can detect drift and trigger a container start).
        const keepServicesTestHook =
          process.env.PORTICO_TEST_KEEP_SERVICES === "1";
        state.windows.loading.webContents.send("loading-step", "mcp-config");
        state.windows.loading.webContents.send(
          "loading-status",
          keepServicesTestHook
            ? "Reusing MCP configuration (test hook)..."
            : "Checking MCP server configuration...",
        );

        let configChanged = false;
        if (keepServicesTestHook) {
          sendInitLog(
            "🧪 Test hook: skipping MCP config regeneration and container updates\n",
            "info",
          );
        } else {
          sendInitLog("📋 Checking MCP server configuration...\n", "info");
          try {
            const mcpConfigCommand = await ensureMcpOrcGeneratorCommand(
              PROJECT_ROOT,
              "generate-docker-compose-override",
              {
                isPackagedApp: app.isPackaged,
                resourcesPath: process.resourcesPath,
                env: createMcpRuntimeEnv(),
              },
            );
            const mcpConfigResult = await executeWithStreaming(
              mcpConfigCommand,
              [],
              MCP_CONFIG_STARTUP_TIMEOUT_MS,
            );
            // Check if config was regenerated (vs cache hit)
            // Cache hit outputs: "MCP config unchanged, skipping regeneration (cached)"
            if (
              mcpConfigResult.output &&
              !mcpConfigResult.output.includes("unchanged")
            ) {
              configChanged = true;
              sendInitLog(
                "✅ MCP config regenerated (changes detected)\n",
                "success",
              );
            } else {
              sendInitLog("✅ MCP config unchanged (cached)\n", "success");
            }
          } catch (error) {
            sendInitLog(`⚠️ MCP config check: ${error.message}\n`, "warning");
          }
        }
        state.windows.loading.webContents.send(
          "loading-step-complete",
          "mcp-config",
        );

        if (!(await ensureHostMcpBridgeReadyForStartup())) {
          stopInitLogging();
          return;
        }

        // If config changed, we may need to start new Docker containers
        if (configChanged) {
          sendInitLog(
            "🐳 Config changed - ensuring Docker containers are current...\n",
            "info",
          );
          state.windows.loading.webContents.send("loading-step", "start");
          state.windows.loading.webContents.send(
            "loading-status",
            "Starting new Docker containers...",
          );
          try {
            const dockerArgs = isDockerDevModeEnabled()
              ? ["start", "advanced", "--dev"]
              : ["start", "advanced"];
            const dockerComposeCommand = `bash "${path.join(SCRIPTS_DIR, "docker-compose.sh")}"`;
            await executeWithStreaming(
              dockerComposeCommand,
              dockerArgs,
              300000, // 5 minute timeout
            );
            sendInitLog("✅ Docker containers verified\n", "success");
          } catch (error) {
            sendInitLog(`⚠️ Docker update: ${error.message}\n`, "warning");
          }
          state.windows.loading.webContents.send(
            "loading-step-complete",
            "start",
          );
        } else {
          state.windows.loading.webContents.send(
            "loading-step-skipped",
            "start",
          );
        }

        // Restart the host MCP runtime only when HOST mode is supported and at least
        // one host-backed MCP server is actually configured for this app instance.
        if (await hostServersConfigured()) {
          state.windows.loading.webContents.send("loading-step", "host-mcpo");
          state.windows.loading.webContents.send(
            "loading-status",
            "Restarting host MCP servers...",
          );
          console.log(
            "[Init] 🔄 Always restarting host MCP runtime (cannot verify process ownership)",
          );
          sendInitLog(
            "🔄 Restarting host MCP proxy (ensuring current app control)...\n",
            "info",
          );

          try {
            await stopHostMcpo();
            const hostMcpoResult = await startHostMcpo();
            if (hostMcpoResult.skipped) {
              sendInitLog(
                "ℹ️  No host MCP servers configured, skipping\n",
                "info",
              );
            } else if (hostMcpoResult.success) {
              sendInitLog(
                "✅ Host MCP proxy started successfully\n",
                "success",
              );
            } else {
              sendInitLog(
                `⚠️  Warning: Host MCP proxy failed to start: ${hostMcpoResult.error}\n`,
                "warning",
              );
            }
            state.windows.loading.webContents.send(
              "loading-step-complete",
              "host-mcpo",
            );
          } catch (error) {
            sendInitLog(
              `⚠️  Warning: Host MCP proxy error: ${error.message}\n`,
              "warning",
            );
            state.windows.loading.webContents.send(
              "loading-step-complete",
              "host-mcpo",
            );
          }
        } else if (!hostModeSupported) {
          state.windows.loading.webContents.send(
            "loading-step-skipped",
            "host-mcpo",
          );
        } else {
          sendInitLog(
            "ℹ️  No host MCP servers configured, skipping host MCP startup\n",
            "info",
          );
          state.windows.loading.webContents.send(
            "loading-step-skipped",
            "host-mcpo",
          );
        }

        state.windows.loading.webContents.send("loading-progress", 60);
      } else {
        // ======================================================================
        // FULL RESTART PATH - Services need restart
        // ======================================================================
        console.log("[Init] ⚠️  Full restart path - services need restart");
        sendInitLog("⚠️  Services need restart:\n", "warning");
        checkResult.reasons.forEach((reason) => {
          console.log(`[Init] Restart reason: ${reason}`);
          sendInitLog(`   • ${reason}\n`, "warning");
        });
        state.windows.loading.webContents.send(
          "loading-step-complete",
          "verify",
        );
        state.windows.loading.webContents.send("loading-step", "stop");

        // =====================================================================
        // STOP SERVICES FIRST
        // docker-compose.sh stop tears down containers and then deletes the
        // runtime-secret cache dir. Do not prepare generated config/runtime
        // secrets concurrently with that cleanup.
        // =====================================================================
        state.windows.loading.webContents.send(
          "loading-status",
          "Stopping existing services...",
        );
        sendInitLog("🛑 Stopping existing services...\n", "info");

        // PORTICO-373: the teardown must be finished -- not merely disowned -- before
        // anything below runs. `docker-compose.sh stop` ends by deleting the
        // runtime-secret cache dir, and the containers started later in this same
        // pass bind-mount files from it (see the comment above and
        // cleanup_runtime_secret_tmpdir in docker-compose.sh). A timeout that
        // resolves while the stop is still alive puts that deletion in a race with
        // the recreation, so the timeout waits for the process group to be gone.
        const runFullRestartStop = async () => {
          try {
            const result = await executeWithStreaming(
              `bash "${path.join(SCRIPTS_DIR, "docker-compose.sh")}"`,
              ["stop"],
              STOP_PHASE_TIMEOUT_MS,
              {
                isolateProcessGroup: true,
                confirmTreeExitMs: STOP_PHASE_TREE_EXIT_CONFIRM_MS,
              },
            );
            return {
              success: result.success,
              error: result.error,
              timedOut: result.timedOut === true,
              treeExited: result.treeExited,
            };
          } catch (err) {
            return { success: false, error: err.message, timedOut: false };
          }
        };

        // A stop timeout on this app has one dominant cause: the container engine
        // has stopped answering. Both PORTICO-373 reporters recovered by restarting it
        // from Terminal, so do that for them rather than sending them there.
        const teardown = await runTeardownWithEngineRecovery({
          runStop: runFullRestartStop,
          recoverEngine: (failedStop) => {
            sendInitLog(
              `⚠️  Services did not stop cleanly: ${failedStop.error || "unknown"}\n`,
              "warning",
            );
            return recoverWedgedEngineAfterFailedStop({
              stopResult: failedStop,
              probeDockerDaemon,
              restartEngine: restartOrbStackAndWaitForDocker,
              projectRoot: PROJECT_ROOT,
              onLog: (message, type = "info") => sendInitLog(`${message}\n`, type),
              onStatus: (message) => {
                if (state.windows.loading && !state.windows.loading.isDestroyed()) {
                  state.windows.loading.webContents.send("loading-status", message);
                }
              },
            });
          },
          onRetry: () => {
            sendInitLog("🛑 Retrying service shutdown...\n", "info");
            state.windows.loading.webContents.send(
              "loading-status",
              "Stopping existing services...",
            );
          },
        });

        // Fail closed. Continuing past an unfinished teardown is what turned a
        // recoverable engine hiccup into a stalled restart with no diagnosis, and
        // it is what puts the runtime-secret cleanup in a race with the config
        // generation immediately below.
        if (!teardown.ok) {
          const failure = describeFailedStopPhase(
            teardown.stopResult,
            teardown.engineRecovery,
          );
          sendInitLog(failure.logMessage, "error");
          state.windows.loading.webContents.send("loading-step-failed", "stop");
          state.windows.loading.webContents.send(
            "loading-error",
            buildLoadingErrorPayload(failure.uiMessage, failure.recovery),
          );
          // Best-effort even on the failure path: this only removes our own
          // leftover request payloads and never touches container state.
          await cleanupLegacyRequestPayloadsFromKnownAndRememberedRoots();
          stopInitLogging();
          return;
        }

        sendInitLog("✅ Services stopped successfully\n", "success");
        state.windows.loading.webContents.send("loading-step-complete", "stop");
        await cleanupLegacyRequestPayloadsFromKnownAndRememberedRoots();

        state.windows.loading.webContents.send("loading-step", "mcp-config");
        state.windows.loading.webContents.send(
          "loading-status",
          "Applying presets & generating MCP config...",
        );
        sendInitLog("\n🧭 Applying presets & generating MCP config...\n", "info");

        const configResult = await (async () => {
          // Apply preset environment variables
          try {
            const { systemCount, mcpCount } =
              await applyPresetEnvVars(sendInitLog);
            console.log(
              `[Init] Applied ${systemCount} system + ${mcpCount} MCP presets`,
            );
          } catch (error) {
            console.error("[Init] Preset error:", error);
          }

          // Generate MCP config
          try {
            const mcpConfigCommand = await ensureMcpOrcGeneratorCommand(
              PROJECT_ROOT,
              "generate-docker-compose-override",
              {
                isPackagedApp: app.isPackaged,
                resourcesPath: process.resourcesPath,
                env: createMcpRuntimeEnv(),
              },
            );
            const mcpConfigResult = await executeWithStreaming(
              mcpConfigCommand,
              [],
              MCP_CONFIG_STARTUP_TIMEOUT_MS,
            );
            return {
              success: mcpConfigResult.success,
              error: mcpConfigResult.error,
            };
          } catch (error) {
            return { success: false, error: error.message };
          }
        })();

        if (configResult.success) {
          sendInitLog("✅ MCP servers configured successfully\n", "success");
        } else {
          sendInitLog(
            `⚠️  MCP config completed with warnings: ${configResult.error || "unknown"}\n`,
            "warning",
          );
        }
        state.windows.loading.webContents.send(
          "loading-step-complete",
          "mcp-config",
        );

        if (!(await ensureHostMcpBridgeReadyForStartup())) {
          stopInitLogging();
          return;
        }

        state.windows.loading.webContents.send("loading-progress", 35);

        if (!hostModeSupported) {
          state.windows.loading.webContents.send(
            "loading-status",
            "Skipping host MCP servers (HOST mode not supported)...",
          );
          sendInitLog(
            "\n⏭️  Skipping host MCP proxy (HOST mode not supported)\n",
            "warning",
          );
          state.windows.loading.webContents.send(
            "loading-step-skipped",
            "host-mcpo",
          );
        } else if (!(await hostServersConfigured())) {
          state.windows.loading.webContents.send(
            "loading-status",
            "Skipping host MCP servers (no host integrations enabled)...",
          );
          sendInitLog(
            "\nℹ️  No host MCP servers configured, skipping host MCP proxy\n",
            "info",
          );
          state.windows.loading.webContents.send(
            "loading-step-skipped",
            "host-mcpo",
          );
        } else {
          state.windows.loading.webContents.send("loading-step", "host-mcpo");
          state.windows.loading.webContents.send(
            "loading-status",
            "Starting host MCP servers (background)...",
          );
          sendInitLog(
            "\n🖥️  Starting host MCP proxy (non-blocking)...\n",
            "info",
          );

          try {
            const hostMcpoResult = await startHostMcpo();
            if (hostMcpoResult.skipped) {
              sendInitLog(
                "ℹ️  No host MCP servers configured, skipping\n",
                "info",
              );
            } else if (hostMcpoResult.success || hostMcpoResult.starting) {
              // Non-blocking: process started, health check runs in background
              sendInitLog(
                "✅ Host MCP proxy starting (health check in background)\n",
                "success",
              );
            } else {
              sendInitLog(
                `⚠️  Warning: Host MCP proxy failed to start: ${hostMcpoResult.error}\n`,
                "warning",
              );
            }
            state.windows.loading.webContents.send(
              "loading-step-complete",
              "host-mcpo",
            );
          } catch (error) {
            sendInitLog(
              `⚠️  Warning: Host MCP proxy error: ${error.message}\n`,
              "warning",
            );
            state.windows.loading.webContents.send(
              "loading-step-complete",
              "host-mcpo",
            );
          }
        }

        state.windows.loading.webContents.send("loading-progress", 45);
        state.windows.loading.webContents.send("loading-step", "start");

        // Start services
        const devModeStatus = isDockerDevModeEnabled()
          ? " (Open WebUI dev mode - hot-reload enabled)"
          : "";
        state.windows.loading.webContents.send(
          "loading-status",
          `Starting Docker services${devModeStatus}...`,
        );
        sendInitLog(
          `\n🐳 Starting Docker services${devModeStatus}...\n`,
          "info",
        );

        // Only pass --dev to docker-compose.sh when install_v2.sh explicitly enabled
        // Open WebUI dev mode and wrote the .dev-mode marker.
        const dockerArgs = isDockerDevModeEnabled()
          ? ["start", "advanced", "--dev"]
          : ["start", "advanced"];
        const dockerComposeCommand = `bash "${path.join(SCRIPTS_DIR, "docker-compose.sh")}"`;

        // Package preparation and exact-image pulls are part of Docker startup.
        // Let that preflight finish before the separate container readiness budget
        // starts so slow downloads cannot hide the owning startup failure.
        sendInitLog("Waiting for Docker startup preflight to complete...\n", "info");
        try {
          dockerStartResult = await executeWithStreaming(
            dockerComposeCommand,
            dockerArgs,
            600000, // 10 minute timeout for Docker image pulls
          );
        } catch (error) {
          dockerStartResult = {
            success: false,
            error: error.message,
            output: "",
          };
        }

        if (!dockerStartResult.success) {
          console.error("[Init] Docker services failed to start properly");
          const startupFailure = classifyContainerStartupFailure(
            null,
            null,
            dockerStartResult,
          );
          if (startupFailure.logMessage) {
            sendInitLog(startupFailure.logMessage, "warning");
          }
          state.windows.loading.webContents.send("loading-step-failed", "start");
          state.windows.loading.webContents.send(
            "loading-error",
            buildLoadingErrorPayload(startupFailure.uiMessage, startupFailure.recovery),
          );
          stopInitLogging();
          return;
        }

        console.log("[Init] Docker services started successfully");
        state.windows.loading.webContents.send(
          "loading-step-complete",
          "start",
        );
        sendInitLog(
          "Docker startup preflight completed; proceeding to container readiness\n",
          "info",
        );
        state.windows.loading.webContents.send("loading-progress", 60);
      }

      // ========================================================================
      // CONTAINER CHECK - Verify core containers are running
      // Startup-core sync runs here before app entry; full sync continues after main window opens
      // ========================================================================
      state.windows.loading.webContents.send("loading-step", "health");

      // Run simplified container readiness check
      state.windows.loading.webContents.send(
        "loading-status",
        "Waiting for containers to start...",
      );
      sendInitLog("\n🔍 Checking container readiness (simplified)...\n", "info");
      sendInitLog(
        "Note: Startup core sync runs during loading, then full sync continues after main window opens\n",
        "info",
      );

      let containersReady = false;
      let containerReadinessResult = null;
      let containerReadinessError = null;
      try {
        containerReadinessResult = await executeWithStreaming(
          `bash "${path.join(SCRIPTS_DIR, "check-containers-ready.sh")}"`,
          [],
          540000,
          {
            bufferUICheck: true,
          },
        );

        if (containerReadinessResult?.success) {
          sendInitLog("✅ All core containers are running!\n", "success");
          containersReady = true;
        } else {
          sendInitLog(
            "❌ Some containers failed to start.\n",
            "error",
          );
          sendInitLog(
            "Please check Docker logs for more details.\n",
            "error",
          );
        }
      } catch (err) {
        containerReadinessError = err;
        sendInitLog(`❌ Container check error: ${err.message}\n`, "error");
        sendInitLog("Please check the logs for more details.\n", "error");
      }

      if (!containersReady) {
        const startupFailure = classifyContainerStartupFailure(
          containerReadinessResult,
          containerReadinessError,
          dockerStartResult,
        );
        if (startupFailure.logMessage) {
          sendInitLog(startupFailure.logMessage, "warning");
        }

        state.windows.loading.webContents.send("loading-step-failed", "health");
        state.windows.loading.webContents.send(
          "loading-error",
          buildLoadingErrorPayload(startupFailure.uiMessage, startupFailure.recovery),
        );
        // Stop here on container check failure
        stopInitLogging();
        return;
      }

      await cleanupLegacyRequestPayloadsFromKnownAndRememberedRoots();

      sendInitLog(
        "\n🧹 Reconciling Agent VM containers against Redis metadata...\n",
        "info",
      );
      try {
        const startupAgentVmCleanup = await cleanupStartupAgentVms({
          runCommand: createShellCommandRunner(execPromise, {
            projectRoot: PROJECT_ROOT,
            defaultTimeoutMs: 5000,
          }),
          workspaceRoot: path.join(PROJECT_ROOT, "workspaces"),
        });
        if (startupAgentVmCleanup.removedCount > 0) {
          sendInitLog(
            `✅ Removed ${startupAgentVmCleanup.removedCount} orphaned or expired Agent VM container(s)\n`,
            "success",
          );
          startupAgentVmCleanup.removed.forEach((item) => {
            const recoverySuffix = item.recoveryPath
              ? ` Recovery files preserved at ${path.relative(PROJECT_ROOT, item.recoveryPath)}.`
              : "";
            sendInitLog(
              `   • ${item.vmId}: removed for ${item.reasonText}.${recoverySuffix}\n`,
              "info",
            );
          });
        } else if (startupAgentVmCleanup.warnings.length === 0) {
          sendInitLog(
            "✅ No expired or orphaned Agent VM containers required cleanup\n",
            "success",
          );
        }
        if (startupAgentVmCleanup.keptCount > 0) {
          sendInitLog(
            `ℹ️  Preserved ${startupAgentVmCleanup.keptCount} active Agent VM container(s)\n`,
            "info",
          );
        }
        startupAgentVmCleanup.warnings.forEach((warning) => {
          sendInitLog(`⚠️  ${warning}\n`, "warning");
        });
      } catch (error) {
        sendInitLog(
          `⚠️  Agent VM metadata cleanup error: ${error.message}\n`,
          "warning",
        );
      }

      // Run startup-core health sync as a startup gate (bounded timeout + fail-open).
      // This ensures first-load UX essentials are ready (core MCP + model/settings sync)
      // while allowing non-core work to continue asynchronously in follow-up full syncs.
      sendInitLog(
        "\n🔄 Running startup core sync (core MCP, models, OWUI settings)...\n",
        "info",
      );
      state.windows.loading.webContents.send(
        "loading-status",
        "Running startup sync...",
      );

      const pendingPostReleaseCleanup = app.isPackaged
        ? findPendingPostHealthCleanup({
            projectRoot: PROJECT_ROOT,
            currentBuild: buildInfo.buildNumber,
          })
        : { pending: false };
      const startupCoreSyncResult = await runStartupCoreHealthGate({
        reason: "loading-gate",
        requireFreshResult: pendingPostReleaseCleanup.pending,
        retryToggleSourceRepair: !pendingPostReleaseCleanup.pending,
      });
      if (startupCoreSyncResult?.success) {
        sendInitLog("✅ Startup core sync completed\n", "success");
        try {
          const attribution =
            await agentAttributionReconciliation.reconcileAgentAttribution({
              invokeMcpTool: dockerMcp.invokeMcpTool,
            });
          const repairedIds = Array.isArray(attribution?.repaired_ids)
            ? attribution.repaired_ids
            : [];
          if (repairedIds.length) {
            sendInitLog(
              `✅ Repaired agent attribution for: ${repairedIds.join(", ")}\n`,
              "success",
            );
          } else {
            sendInitLog("✅ Agent attribution is current\n", "success");
          }
        } catch (error) {
          sendInitLog(
            `⚠️  Agent attribution reconciliation deferred (${error?.code || "temporarily unavailable"})\n`,
            "warning",
          );
        }
        try {
          const skillAttribution = await userSkillReconciliation.reconcileUserSkills({
            projectRoot: PROJECT_ROOT,
          });
          const repairedSkillIds = Array.isArray(skillAttribution?.repaired_ids)
            ? skillAttribution.repaired_ids
            : [];
          if (repairedSkillIds.length) {
            sendInitLog(
              `✅ Repaired User skill attribution for: ${repairedSkillIds.join(", ")}\n`,
              "success",
            );
          } else {
            sendInitLog("✅ User skill attribution is current\n", "success");
          }
        } catch (error) {
          const repairedSkillIds = Array.isArray(error?.result?.repaired_ids)
            ? error.result.repaired_ids
            : [];
          if (repairedSkillIds.length) {
            sendInitLog(
              `✅ Repaired User skill attribution for: ${repairedSkillIds.join(", ")}\n`,
              "success",
            );
          }
          sendInitLog(
            `⚠️  User skill attribution reconciliation deferred (${error?.code || "temporarily unavailable"})\n`,
            "warning",
          );
        }
        if (pendingPostReleaseCleanup.pending) {
          await runPostReleaseDockerStorageCleanup(
            pendingPostReleaseCleanup.transition,
          );
        }
      } else if (startupCoreSyncResult?.timedOut) {
        sendInitLog(
          `⚠️  Startup core sync timed out after ${Math.ceil((startupCoreSyncResult.timeoutMs || 0) / 1000)}s. Opening app and continuing full sync in background.\n`,
          "warning",
        );
      } else {
        sendInitLog(
          `⚠️  Startup core sync failed (${startupCoreSyncResult?.error || "unknown error"}). Opening app and retrying with full sync in background.\n`,
          "warning",
        );
      }

      state.windows.loading.webContents.send("loading-step-complete", "health");
      state.windows.loading.webContents.send("loading-progress", 80);

      // Load configuration (no visual indicator, but still executes)
      // Reset config data
      resetConfigData();

      // Load environment
      const envPath = path.join(PROJECT_ROOT, ".env");

      try {
        if (fs.existsSync(envPath)) {
          const envContent = await fsPromises.readFile(envPath, "utf8");
          const lines = envContent.split("\n");
          for (const line of lines) {
            if (line && !line.startsWith("#") && line.includes("=")) {
              const [key, ...valueParts] = line.split("=");
              const value = valueParts.join("=").trim();
              configData.env[key.trim()] = value;
            }
          }
          sendInitLog("✅ Configuration loaded\n", "success");
        } else {
          sendInitLog("ℹ️  No .env file yet (created by presets)\n", "info");
        }
      } catch (err) {
        sendInitLog(`❌ Failed to load config: ${err.message}\n`, "error");
      }

      state.windows.loading.webContents.send("loading-progress", 95);
      state.windows.loading.webContents.send("loading-step", "ready");

      // Save source files hash for smart startup on next run
      saveSourceFilesHash();

      const sentinelResult = owuiDataIntegrityGuard.recordDbSentinel({
        projectRoot: PROJECT_ROOT,
        buildNumber: buildInfo.buildNumber || null,
      });
      if (!sentinelResult.success && !sentinelResult.skipped) {
        sendInitLog(
          `⚠️  Could not record Open WebUI database integrity sentinel: ${sentinelResult.error || sentinelResult.reason}\n`,
          "warning",
        );
      }

      // Send loading-complete to let frontend open main window
      // OAuth is no longer handled during loading - it will be handled by periodic health check
      sendInitLog(
        "\n✅ Initialization complete - opening control plane...\n",
        "success",
      );
      sendInitLog(
        "Note: Full health checks will continue in background after the control plane opens\n",
        "info",
      );
      state.windows.loading.webContents.send("loading-complete");

      // The frontend's onLoadingComplete handler will call showMainWindow() immediately
    }
  } catch (error) {
    console.error("Initialization error:", error);
    if (state.windows.loading && !state.windows.loading.isDestroyed()) {
      state.windows.loading.webContents.send("loading-log", {
        text: `❌ Critical Error: ${error.message}\n`,
        type: "error",
      });
      state.windows.loading.webContents.send("loading-log", {
        text: "\n⚠️  Initialization failed. You can continue to the manager to troubleshoot.\n",
        type: "warning",
      });
      // Send error event to show recovery options
      state.windows.loading.webContents.send("loading-error", error.message);
      stopInitLogging();
    }
  } finally {
    isInitializing = false;
    state.releasePendingMcpRuntimeMutation("start-initialization-finally");
  }
});

// Handler for retry initialization - restarts OrbStack first
ipcMain.on("start-initialization-with-retry", async (event) => {
  console.log(
    "Received start-initialization-with-retry event - will restart OrbStack first",
  );

  let acquiredRetryMutation = false;
  try {
    acquiredRetryMutation = ensurePendingMcpRuntimeMutation(
      "runtime_initialization_retry",
      "loading",
    );
  } catch (error) {
    console.error("[Main] Runtime retry blocked by MCP mutation:", error.message);
    if (state.windows.loading && !state.windows.loading.isDestroyed()) {
      state.windows.loading.webContents.send("loading-error", error.message);
    }
    return;
  }

  // Start logging to file
  startInitLogging();

  if (isInitializing) {
    console.log("Already initializing, skipping...");
    if (acquiredRetryMutation) {
      state.releasePendingMcpRuntimeMutation("retry-initialization-duplicate");
    }
    return;
  }
  isInitializing = true;

  try {
    console.log("Restarting OrbStack before retry...");

    if (state.windows.loading && !state.windows.loading.isDestroyed()) {
      sendInitLog("🔄 Restarting OrbStack to ensure clean state...\n", "info");
      state.windows.loading.webContents.send(
        "loading-status",
        "Restarting OrbStack...",
      );
      state.windows.loading.webContents.send("loading-progress", 5);
    }

    // Check if we're on macOS and restart OrbStack before retrying initialization
    if (process.platform === "darwin") {
      try {
        const recovery = await restartOrbStackAndWaitForDocker({
          projectRoot: PROJECT_ROOT,
          onLog: (message, type = "info") =>
            sendInitLog(`${message}\n`, type),
          onStatus: (message) => {
            if (state.windows.loading && !state.windows.loading.isDestroyed()) {
              state.windows.loading.webContents.send("loading-status", message);
            }
          },
        });

        if (!recovery?.success) {
          throw new Error(
            recovery?.error ||
              `Docker did not become ready within ${ORBSTACK_DOCKER_STARTUP_TIMEOUT_LABEL}`,
          );
        }
        sendInitLog("✅ OrbStack restarted successfully\n", "success");
      } catch (error) {
        console.error("Failed to restart OrbStack:", error);
        sendInitLog(
          `⚠️  Failed to restart OrbStack: ${error.message}\n`,
          "warning",
        );
        sendInitLog("Proceeding with initialization anyway...\n", "info");
      }
    }

    // Now proceed with normal initialization
    isInitializing = false; // Reset flag so the normal handler can run

    // Trigger the normal initialization process
    event.sender.send("trigger-normal-init");

    // Small delay to ensure the UI updates
    setTimeout(() => {
      ipcMain.emit("start-initialization", event);
    }, 100);
  } catch (error) {
    console.error("[Main] Retry initialization error:", error);
    isInitializing = false;

    if (state.windows.loading && !state.windows.loading.isDestroyed()) {
      state.windows.loading.webContents.send("loading-log", {
        text: `❌ Failed to restart OrbStack: ${error.message}\n`,
        type: "error",
      });
      state.windows.loading.webContents.send("loading-error", error.message);
      stopInitLogging();
    }
    state.releasePendingMcpRuntimeMutation("retry-initialization-error");
  }
});

ipcMain.on("show-main-window", (event, options = {}) => {
  console.log("[Main] show-main-window called", options);

  // Stop init logging since we're truly done
  stopInitLogging();
  hasShownManagerMainWindow = true;

  if (!state.windows.main || state.windows.main.isDestroyed()) {
    createMainWindow();
    startStatusMonitoring();
  }

  // If a specific tab was requested, send message after window is ready
  if (options && options.tab) {
    const mainWindow = state.windows.main;
    if (mainWindow && !mainWindow.isDestroyed()) {
      // Use dom-ready + delay to ensure renderer JS listeners are set up
      const sendTabSwitch = () => {
        // Add delay to ensure renderer listeners are registered
        setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            console.log("[Main] Sending switch-to-tab:", options.tab);
            mainWindow.webContents.send("switch-to-tab", options.tab);
          }
        }, 500);
      };

      if (mainWindow.webContents.isLoading()) {
        // Wait for page to finish loading
        mainWindow.webContents.once("did-finish-load", sendTabSwitch);
      } else {
        // Page already loaded, send with delay for listener setup
        sendTabSwitch();
      }
    }
  }

  if (state.windows.loading && !state.windows.loading.isDestroyed()) {
    setTimeout(() => {
      // Double-check before closing
      if (state.windows.loading && !state.windows.loading.isDestroyed()) {
        state.windows.loading.close();
      }
    }, 500);
  }
});

// Guided setup handlers
ipcMain.on("electron-app-complete", () => {
  console.log("Guided setup completed, transitioning to main app");

  // Close guided setup window
  if (state.windows.guidedSetup && !state.windows.guidedSetup.isDestroyed()) {
    state.windows.guidedSetup.close();
  }

  // Create loading window and start initialization
  setTimeout(() => {
    createLoadingWindow();
  }, 500);
});

const guidedSetupWindowAnimationState = {
  token: 0,
  timer: null,
  targetKey: null,
};

function getGuidedSetupBoundsKey(bounds) {
  return [bounds.x, bounds.y, bounds.width, bounds.height].join(":");
}

function animateGuidedSetupWindow(targetBounds, logPrefix) {
  if (!state.windows.guidedSetup || state.windows.guidedSetup.isDestroyed()) {
    console.log(`[Main] Cannot ${logPrefix} - window is null or destroyed`);
    return;
  }

  const normalizedTargetBounds = {
    x: Math.round(targetBounds.x),
    y: Math.round(targetBounds.y),
    width: Math.round(targetBounds.width),
    height: Math.round(targetBounds.height),
  };
  const targetKey = getGuidedSetupBoundsKey(normalizedTargetBounds);
  const startBounds = state.windows.guidedSetup.getBounds();
  const startKey = getGuidedSetupBoundsKey(startBounds);

  if (startKey === targetKey) {
    console.log(`[Main] Skipping ${logPrefix} - guided setup window already matches target bounds`);
    guidedSetupWindowAnimationState.targetKey = null;
    if (guidedSetupWindowAnimationState.timer) {
      clearTimeout(guidedSetupWindowAnimationState.timer);
      guidedSetupWindowAnimationState.timer = null;
    }
    return;
  }

  if (
    guidedSetupWindowAnimationState.targetKey === targetKey &&
    guidedSetupWindowAnimationState.timer
  ) {
    console.log(`[Main] Skipping ${logPrefix} - guided setup window is already animating to the requested bounds`);
    return;
  }

  if (guidedSetupWindowAnimationState.timer) {
    clearTimeout(guidedSetupWindowAnimationState.timer);
    guidedSetupWindowAnimationState.timer = null;
  }

  const animationToken = guidedSetupWindowAnimationState.token + 1;
  guidedSetupWindowAnimationState.token = animationToken;
  guidedSetupWindowAnimationState.targetKey = targetKey;

  console.log(`[Main] ${logPrefix} from`, startBounds, "to", normalizedTargetBounds);

  if (!state.windows.guidedSetup.isVisible()) {
    state.windows.guidedSetup.show();
  }

  const duration = 300;
  const steps = 20;
  const stepDuration = duration / steps;
  let currentStep = 0;

  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

  const animateStep = () => {
    if (guidedSetupWindowAnimationState.token !== animationToken) {
      return;
    }
    if (!state.windows.guidedSetup || state.windows.guidedSetup.isDestroyed()) {
      return;
    }

    currentStep++;
    const progress = easeOutCubic(currentStep / steps);

    const currentX = Math.round(startBounds.x + (normalizedTargetBounds.x - startBounds.x) * progress);
    const currentY = Math.round(startBounds.y + (normalizedTargetBounds.y - startBounds.y) * progress);
    const currentWidth = Math.round(startBounds.width + (normalizedTargetBounds.width - startBounds.width) * progress);
    const currentHeight = Math.round(startBounds.height + (normalizedTargetBounds.height - startBounds.height) * progress);

    state.windows.guidedSetup.setBounds({
      x: currentX,
      y: currentY,
      width: currentWidth,
      height: currentHeight,
    });

    if (currentStep < steps) {
      guidedSetupWindowAnimationState.timer = setTimeout(animateStep, stepDuration);
    } else {
      guidedSetupWindowAnimationState.timer = null;
      guidedSetupWindowAnimationState.targetKey = null;
      console.log(`[Main] ${logPrefix} animation complete`);
      state.windows.guidedSetup.focus();
    }
  };

  animateStep();
}

// Smoothly resize guided setup window when starting setup
ipcMain.on("maximize-electron-app", (event, options = {}) => {
  console.log("[Main] Received maximize-electron-app event (smooth resize)");

  if (state.windows.guidedSetup && !state.windows.guidedSetup.isDestroyed()) {
    if (!state.appState.guidedSetupInitialBounds) {
      state.appState.guidedSetupInitialBounds = {
        ...state.windows.guidedSetup.getBounds(),
      };
    }

    // Target size: wide enough for side-by-side guided setup content without
    // making the window comically tall after the welcome screen.
    const requestedWidth = Number(options?.targetWidth);
    const requestedHeight = Number(options?.targetHeight);
    const targetWidth = Number.isFinite(requestedWidth) && requestedWidth > 0 ? requestedWidth : 1180;
    const targetHeight = Number.isFinite(requestedHeight) && requestedHeight > 0 ? requestedHeight : 820;

    const currentBounds = state.windows.guidedSetup.getBounds();
    const display = require("electron").screen.getDisplayMatching(currentBounds);
    const targetBounds = computeGuidedSetupResizeBounds(
      currentBounds,
      { width: targetWidth, height: targetHeight },
      display.workArea,
    );

    animateGuidedSetupWindow(
      targetBounds,
      "maximize guided setup window",
    );
  } else {
    console.log("[Main] Cannot resize - window is null or destroyed");
  }
});

ipcMain.on("restore-guided-setup-window", async () => {
  console.log("[Main] Received restore-guided-setup-window event");

  if (!state.windows.guidedSetup || state.windows.guidedSetup.isDestroyed()) {
    console.log("[Main] Cannot restore - window is null or destroyed");
    return;
  }

  const initialBounds = state.appState.guidedSetupInitialBounds;
  if (!initialBounds) {
    console.log("[Main] No captured initial bounds, skipping restore");
    return;
  }

  // Keep the intentional shrink effect, but don't shrink back to the original 800x600.
  // We allow a smaller target than before, then trim extra bottom whitespace based on
  // success-screen layout metrics without reintroducing scroll.
  const minimumRestoreWidth = 1024;
  const minimumRestoreHeight = 740;

  const { screen } = require("electron");
  const currentBounds = state.windows.guidedSetup.getBounds();
  const display = screen.getDisplayMatching(currentBounds);
  const { width: workAreaWidth, height: workAreaHeight } = display.workArea;

  const targetWidth = Math.min(Math.max(initialBounds.width, minimumRestoreWidth), workAreaWidth);
  const baseTargetHeight = Math.min(Math.max(initialBounds.height, minimumRestoreHeight), workAreaHeight);

  let targetHeight = baseTargetHeight;

  try {
    // Let the success stage render before reading measurements.
    await new Promise((resolve) => setTimeout(resolve, 40));

    if (!state.windows.guidedSetup || state.windows.guidedSetup.isDestroyed()) {
      console.log("[Main] Guided setup window closed before success layout measurement");
      return;
    }

    const metrics = await state.windows.guidedSetup.webContents.executeJavaScript(
      `(() => {
        const activeSuccess = document.querySelector('#stage-success.active');
        if (!activeSuccess) return null;

        const icon = activeSuccess.querySelector('.success-icon');
        const buttonGroup = activeSuccess.querySelector('.button-group');
        const scrollArea = document.querySelector('.content-scroll-area');
        if (!icon || !buttonGroup || !scrollArea) return null;

        const iconRect = icon.getBoundingClientRect();
        const buttonRect = buttonGroup.getBoundingClientRect();

        return {
          topSpace: Math.round(iconRect.top),
          bottomSpace: Math.round(window.innerHeight - buttonRect.bottom),
          scrollSlack: Math.round(scrollArea.clientHeight - scrollArea.scrollHeight)
        };
      })();`,
      true,
    );

    if (metrics && Number.isFinite(metrics.topSpace) && Number.isFinite(metrics.bottomSpace)) {
      const desiredReduction = Math.max(0, metrics.bottomSpace - metrics.topSpace);
      const scrollSlack = Number.isFinite(metrics.scrollSlack) ? metrics.scrollSlack : 0;
      // Keep a larger buffer so image/layout late updates don't introduce a scrollbar.
      const safeReduction = Math.max(0, scrollSlack - 40);
      const maxAutoReduction = 48;
      const heightReduction = Math.min(desiredReduction, safeReduction, maxAutoReduction);
      targetHeight = Math.max(minimumRestoreHeight, baseTargetHeight - heightReduction);

      console.log("[Main] Success spacing metrics:", {
        topSpace: metrics.topSpace,
        bottomSpace: metrics.bottomSpace,
        scrollSlack,
        desiredReduction,
        safeReduction,
        heightReduction,
      });
    }
  } catch (error) {
    console.warn("[Main] Failed to measure success screen spacing, using base restore height:", error.message);
  }

  const targetBounds = computeGuidedSetupResizeBounds(
    currentBounds,
    { width: targetWidth, height: targetHeight },
    display.workArea,
  );

  animateGuidedSetupWindow(
    targetBounds,
    "restore guided setup window",
  );
});

// Load URL in guided setup webview
ipcMain.on("load-url-in-webview", (event, url) => {
  console.log("[Main] Received request to load URL in webview:", url);
  if (state.windows.guidedSetup && !state.windows.guidedSetup.isDestroyed()) {
    // Send the URL to the renderer to load in webview
    state.windows.guidedSetup.webContents.send("load-webview-url", url);
  }
});

// Handle webview setup in guided setup window
ipcMain.on("electron-app-webview-ready", (event) => {
  console.log("[Main] Guided setup webview is ready");
  // Enable webview debugging if needed
  if (state.windows.guidedSetup) {
    state.windows.guidedSetup.webContents.on(
      "did-attach-webview",
      (event, webContents) => {
        console.log("[Main] Webview attached in guided setup");
        // Allow the webview to load external URLs
        webContents.setWindowOpenHandler(({ url }) => {
          void openHttpExternalUrl(shell, url).catch(() => {});
          return { action: "deny" };
        });
      },
    );
  }
});

// save-init-logs, save-control-panel-logs, collect-debug-info handlers moved to ipc.js
